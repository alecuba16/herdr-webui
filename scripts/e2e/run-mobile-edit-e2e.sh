#!/usr/bin/env bash
# End-to-end acceptance run for mobile file editing (IDE review B1).
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session) with a
# scratch workspace, then drives the mobile edit/save flow in headless Chrome:
# open file, edit, save, verify on disk, conflict path, discard guard.
#
# Usage:
#   scripts/e2e/run-mobile-edit-e2e.sh [--keep]
#
# Environment overrides:
#   E2E_PORT     server port (default 8898)
#   CDP_PORT     Chrome remote debugging port (default 9223)
#   CHROME_BIN   path to Chrome/Chromium if not auto-detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8898}"
CDP="${CDP_PORT:-9223}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-mobile-edit-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() {
  printf 'mobile-edit-e2e-%s-%s' "$$" "$(date +%s)"
}

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
(cd "$ROOT" && cargo build --target-dir target --quiet)

REPO="$WORK/repo"
mkdir -p "$REPO"
printf 'original content\n' > "$REPO/edit-target.txt"
# A real git repo so the mobile Git screen can stage/unstage/discard/switch.
if command -v git >/dev/null 2>&1; then
  git -C "$REPO" init -q 2>/dev/null || true
  git -C "$REPO" -c user.email=e2e@herdr -c user.name="herdr e2e" add edit-target.txt 2>/dev/null || true
  git -C "$REPO" -c user.email=e2e@herdr -c user.name="herdr e2e" commit -qm "initial" 2>/dev/null || true
  git -C "$REPO" checkout -q -b feature/e2e 2>/dev/null || true
  git -C "$REPO" checkout -q main 2>/dev/null || git -C "$REPO" checkout -q master 2>/dev/null || true
  printf 'unstaged line\n' >> "$REPO/edit-target.txt"
fi

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "$(session_id)" &
SERVER_PID=$!

wait_for() {
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 50); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}
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

"$CHROME_BIN" --headless=new --window-size=400,900 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" "" || exit 1

echo "==> running mobile edit acceptance checks"
set +e
E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" E2E_REPO="$REPO" \
  node "$ROOT/scripts/e2e/mobile-edit-acceptance.mjs"
STATUS=$?
set -e

# Headless Chrome sometimes ignores SIGTERM; take it down before the cleanup trap.
kill -TERM "$CHROME_PID" 2>/dev/null || true
sleep 0.5
kill -9 "$CHROME_PID" 2>/dev/null || true

exit "$STATUS"