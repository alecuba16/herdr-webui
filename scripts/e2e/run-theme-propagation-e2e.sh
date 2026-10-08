#!/usr/bin/env bash
# End-to-end acceptance run for theme propagation to open terminals.
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session, so a
# user's running instance is never touched) plus its own headless Chrome on a
# private CDP port, then drives the served app in a real browser: flips
# prefers-color-scheme through Emulation.setEmulatedMedia (the OS theme path)
# and clicks the real theme toggle, asserting the main terminal and an open
# temporary terminal repaint (real wterm renderer, inline --term-bg changes).
#
# Usage:
#   scripts/e2e/run-theme-propagation-e2e.sh [--keep]   # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT    server port   (default 8899)
#   CDP_PORT    chrome port   (default 9225)
#   CHROME_BIN  browser path  (default: first of
#                              ~/.agents/chrome-headless-shell/.../chrome-headless-shell,
#                              /Applications/Google Chrome.app/...)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9225}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q .; }

# A leftover instance from a previous --keep run would answer the health
# check and the run would silently test the stale build. Fail fast instead.
for p in "$PORT" "$CDP"; do
  if port_in_use "$p"; then
    echo "ERROR: port $p is already in use; kill the leftover e2e instance first." >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2 || true
    exit 1
  fi
done

chrome_bin() {
  if [[ -n "${CHROME_BIN:-}" ]]; then
    if [[ ! -x "$CHROME_BIN" ]]; then
      echo "ERROR: CHROME_BIN='$CHROME_BIN' is not executable." >&2
      return 1
    fi
    echo "$CHROME_BIN"; return 0
  fi
  local shell="$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  if [[ -x "$shell" ]]; then echo "$shell"; return 0; fi
  local app="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$app" ]]; then echo "$app"; return 0; fi
  echo "ERROR: no chrome-headless-shell or Google Chrome found; set CHROME_BIN." >&2
  return 1
}
CHROME="$(chrome_bin)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-theme-e2e.XXXXXX")"
SERVER_PID="" CHROME_PID="" DRIVER_PID=""

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.4
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ $KEEP -eq 1 ]]; then echo "--keep set: leaving $WORK, server $PORT, chrome $CDP running"; return; fi
  stop_pid "$DRIVER_PID"
  stop_pid "$CHROME_PID"
  stop_pid "$SERVER_PID"
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# An EXIT trap alone does not fire on SIGTERM/SIGINT: `timeout` or Ctrl+C
# would leave the server and chrome behind. Route these signals to the EXIT
# trap.
on_signal() {
  echo "run-theme-propagation-e2e.sh: interrupted, tearing down" >&2
  exit 130
}
trap on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --quiet)

mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> starting isolated server on http://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off \
  --bind "127.0.0.1:$PORT" \
  --session "theme-e2e-$$-$(date +%s)" \
  --backend-mode builtin &
SERVER_PID=$!

wait_for() {
  local desc="$1" url="$2"
  for _ in $(seq 1 50); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}
wait_for "server" "http://127.0.0.1:$PORT/" || { cat "$WORK/server.log" >&2 || true; exit 1; }

echo "==> starting headless chrome on CDP port $CDP"
"$CHROME" --headless=new --remote-debugging-port="$CDP" \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/chrome-profile" \
  about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
if ! wait_for "chrome cdp" "http://127.0.0.1:$CDP/json"; then
  echo "--- chrome stderr ---" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
fi

echo "==> running theme-propagation-acceptance.mjs"
export E2E_ORIGIN="http://127.0.0.1:$PORT"
export CDP_PORT="$CDP"
DRIVER_PID=""
node "$ROOT/scripts/e2e/theme-propagation-acceptance.mjs" &
DRIVER_PID=$!
if ! wait "$DRIVER_PID"; then
  echo "FAIL - theme propagation e2e" >&2
  exit 1
fi

echo "PASS - theme propagation e2e"