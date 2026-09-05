#!/usr/bin/env bash
# LSP end-user acceptance run: boots an isolated herdr-webui (its own
# XDG_CONFIG_HOME and --session), launches headless Chrome over CDP, and
# drives the real UI through the full language-server user path:
# enable setting -> open broken.json from the tree -> diagnostics badge +
# list -> fix content -> diagnostics clear -> valid file clean.
#
# Uses the real language servers installed on this machine (the JSON one
# from Zed's languages dir or npm globals).
#
# Usage:
#   scripts/e2e/run-lsp-e2e.sh [--keep]     # --keep skips teardown for debugging
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome remote debugging port (default 9222)
#   CHROME_BIN   path to Chrome/Chromium if not auto-detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9222}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-lsp-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() { printf 'lsp-e2e-%s-%s' "$$" "$(date +%s)"; }

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.4
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  [[ $KEEP -eq 1 ]] && { echo "--keep set: leaving $WORK running"; return; }
  stop_pid "${CHROME_PID:-}"
  stop_pid "${SERVER_PID:-}"
  # Orphan language servers must not outlive the run. Poll a few seconds:
  # the backend tears them down on SIGTERM, but give Node a moment to exit.
  # `|| true` because pgrep exits 1 on no match, which under `set -e -o
  # pipefail` would abort cleanup before the workdir removal.
  local orphans=1
  for i in $(seq 1 20); do
    orphans=$(pgrep -f "vscode-json-language-server --stdio" | wc -l | tr -d ' ') || true
    [[ "$orphans" == "0" ]] && break
    sleep 0.5
  done
  if [[ "$orphans" != "0" ]]; then
    echo "WARNING: $orphans orphan language server process(es) still running after teardown"
    ORPHAN_EXIT=1
  fi
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
  return 0
}
trap cleanup EXIT

ORPHAN_EXIT=0
echo "==> workdir: $WORK"

echo "==> building herdr-webui (release)"
(cd "$ROOT" && cargo build --release --target-dir target --quiet)

echo "==> creating fixture repo with src/broken.json and src/good.json"
REPO="$WORK/lsp-accept-repo"
mkdir -p "$REPO/src"
printf '{\n  "name": "lsp-ui-accept",\n  "scripts":\n}\n' > "$REPO/src/broken.json"
printf '{\n  "name": "lsp-ui-accept",\n  "version": "1.0.0"\n}\n' > "$REPO/src/good.json"
printf '# lsp acceptance\n' > "$REPO/README.md"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

wait_for() {
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 50); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/release/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "$(session_id)" &
SERVER_PID=$!

wait_for "server" "https://127.0.0.1:$PORT/" -k || exit 1

echo "==> launching headless Chrome (CDP port $CDP)"
CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    [[ -x "$c" ]] && CHROME_BIN="$c" && break
  done
fi
[[ -x "$CHROME_BIN" ]] || { echo "no Chrome/Chromium found; set CHROME_BIN"; exit 2; }

"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" "" || exit 1

echo "==> running LSP acceptance checks"
ACCEPT_REPO="$REPO" E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/lsp-acceptance.mjs"
ACCEPT_EXIT=$?

echo "==> stopping stack and checking for orphan language servers"
# Teardown runs here (not only via the EXIT trap) so the orphan check sees
# genuine orphans: while the backend is still alive its language servers are
# legitimate children, not orphans.
cleanup

if [[ "$ORPHAN_EXIT" == "0" ]]; then
  echo "PASS  no orphan language server processes after UI session"
else
  echo "FAIL  orphan language server process(es) remain after teardown"
fi

FINAL_EXIT=$(( ACCEPT_EXIT + ORPHAN_EXIT ))
echo "==> LSP E2E done (exit $FINAL_EXIT)"
exit $FINAL_EXIT