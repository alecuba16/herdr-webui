#!/usr/bin/env bash
# Ghostty core (wterm 0.5.0) acceptance run.
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME + --session; a running
# user instance is never touched), forces terminalCore=ghostty in the
# browser via localStorage, and drives the real UI in headless Chrome over
# CDP: the terminal must attach with the Ghostty core, render rows, show
# the shell prompt, and expose the 0.5.0 graphics layer container.
#
# Usage: scripts/e2e/run-ghostty-core-e2e.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8893}"
CDP="${CDP_PORT:-9337}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-ghostty-core-e2e.XXXXXX")"
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

wait_for() {
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 50); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

echo "==> workdir: $WORK"
echo "==> creating fixture repo"
REPO="$WORK/accept-repo"
mkdir -p "$REPO"
cat > "$REPO/demo.py" <<'EOF'
print('hello')
EOF
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "ghostty-core-e2e-$$-$(date +%s)" &
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

echo "==> running ghostty core acceptance checks"
ACCEPT_REPO="$REPO" E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/ghostty-core-acceptance.mjs"