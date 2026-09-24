#!/usr/bin/env bash
# Repro runner for the terminal resize hang: boots an isolated herdr-webui,
# fills the terminal with real scrollback, then continuously resizes the
# browser window for several seconds while measuring main-thread stalls.
#
# Usage:
#   scripts/e2e/run-resize-hang-repro.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9222}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-resize-hang-repro.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() {
  printf 'resize-hang-repro-%s-%s' "$$" "$(date +%s)"
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

echo "==> creating fixture repo"
REPO="$WORK/accept-repo"
mkdir -p "$REPO/src"
cat > "$REPO/README.md" <<'EOF'
# readme
EOF
cat > "$REPO/src/demo.py" <<'EOF'
print('hello')
EOF
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
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
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

echo "==> running resize hang repro"
ACCEPT_REPO="$REPO" E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/resize-hang-repro.mjs"