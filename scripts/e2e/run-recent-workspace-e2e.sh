#!/usr/bin/env bash
# End-to-end acceptance run for the recent-workspace direct panel open and
# per-workspace shell mode persistence (branch fix_recent).
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME, so a user's running
# instance is never touched), launches headless Chrome via CDP, then drives the
# real UI end to end:
#   open workspace -> switch to Git mode -> close -> reopen from the real
#   search palette Recent section -> verify direct workspace+tab+pane landing
#   and restored Git mode.
#
# Usage:
#   scripts/e2e/run-recent-workspace-e2e.sh [--keep]   # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8791)
#   CDP_PORT     Chrome remote debugging port (default 9223)
#   CHROME_BIN   path to Chrome/chrome-headless-shell if not auto-detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8791}"
CDP="${CDP_PORT:-9223}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-recent-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

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
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
}
trap cleanup EXIT

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --quiet)

echo "==> creating fixture repo"
REPO="$WORK/accept-repo"
mkdir -p "$REPO"
echo "# readme" > "$REPO/README.md"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

wait_for() {
  local desc="$1" url="$2"
  for i in $(seq 1 50); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

echo "==> starting isolated server on http://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --backend-mode builtin --https off &
SERVER_PID=$!
wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  for c in \
    "$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    [[ -x "$c" ]] && CHROME_BIN="$c" && break
  done
fi
[[ -x "$CHROME_BIN" ]] || { echo "no Chrome/chrome-headless-shell found; set CHROME_BIN"; exit 2; }

echo "==> launching headless Chrome (CDP port $CDP)"
"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" || exit 1

echo "==> running acceptance checks"
ACCEPT_REPO="$REPO" E2E_BASE_URL="http://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/recent-workspace-acceptance.mjs"