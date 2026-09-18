#!/usr/bin/env bash
# End-to-end external-backend graphics acceptance (p6).
#
# Boots an ISOLATED herdr daemon and an isolated herdr-webui pinned to it
# (own XDG_CONFIG_HOME, scratch HERDR_SESSION, scratch ports), drives the
# real UI in headless Chrome over CDP, and asserts the graphics bridge
# renders a Kitty image on the canvas overlay (desktop + mobile viewports).
#
# Never touches the user's real herdr session or sockets. All spawned
# processes are killed and the scratch dir removed on exit.
#
# Usage:
#   scripts/e2e/run-external-graphics-e2e.sh [--keep]   # --keep: keep workdir
#
# Environment overrides:
#   E2E_PORT     webui port     (default 8899)
#   CDP_PORT     Chrome CDP     (default 9222)
#   CHROME_BIN   Chrome path   (auto-detected)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9222}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# sun_path is 104 bytes; keep the socket path short with a shallow mktemp.
WORK="$(mktemp -d /tmp/herdr-extgfx.XXXXXX)"
SESSION="extgfx-$$_$(date +%s)"
DAEMON_PID=""
SERVER_PID=""
CHROME_PID=""

cleanup() {
  stop_pid "${CHROME_PID:-}"
  stop_pid "${SERVER_PID:-}"
  stop_pid "${DAEMON_PID:-}"
  if [[ $KEEP -eq 1 ]]; then
    echo "--keep set: leaving $WORK for debugging"
    return
  fi
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
}
trap cleanup EXIT

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

wait_for() {
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 60); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

command -v herdr >/dev/null 2>&1 || {
  echo "herdr 0.9.0+ not found on PATH; this e2e requires the external daemon" >&2
  exit 2
}

export XDG_CONFIG_HOME="$WORK/xdg"
mkdir -p "$XDG_CONFIG_HOME"
export HERDR_SESSION="$SESSION"

SESSION_DIR="$XDG_CONFIG_HOME/herdr/sessions/$SESSION"
mkdir -p "$SESSION_DIR"

echo "==> workdir: $WORK"
echo "==> isolated herdr daemon: session=$SESSION"
herdr server >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 50); do
  [[ -S "$SESSION_DIR/herdr-client.sock" ]] && break
  sleep 0.2
done
[[ -S "$SESSION_DIR/herdr-client.sock" ]] || {
  echo "FAIL: daemon client socket never appeared" >&2
  tail -20 "$WORK/daemon.log" || true
  exit 1
}
echo "daemon up (pid $DAEMON_PID)"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> starting isolated webui on https://127.0.0.1:$PORT (external-herdr)"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "$SESSION" \
  --backend-mode external-herdr >"$WORK/webui.log" 2>&1 &
SERVER_PID=$!
wait_for "webui" "https://127.0.0.1:$PORT/" -k || exit 1

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
[[ -x "$CHROME_BIN" ]] || { echo "no Chrome/Chromium found; set CHROME_BIN" >&2; exit 2; }

"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" "" || exit 1

echo "==> running external graphics acceptance checks"
REPO="$WORK/ext-repo"
mkdir -p "$REPO/src"
printf 'print("ext graphics fixture")\n' > "$REPO/src/demo.py"

E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" ACCEPT_REPO="$REPO" \
  node "$ROOT/scripts/e2e/external-graphics-acceptance.mjs"

echo "EXTERNAL GRAPHICS E2E ACCEPTANCE PASSED"