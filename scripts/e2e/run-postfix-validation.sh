#!/usr/bin/env bash
# Post-fix validation runner: boots the FULLY ISOLATED scratch stack and runs
# resize-hang-probe-postfix-validation.mjs against it.
#
# Stack (all scratch, never touching the user's real 8787 instance):
#   - herdr daemon: /opt/homebrew/bin/herdr server, session resize-hang-test,
#     scratch XDG (short paths: sun_path budget < 100 bytes)
#   - herdr-webui: this worktree's target/debug/herdr-webui on 127.0.0.1:8895,
#     scratch XDG, webui-settings.json with backend_mode external-herdr
#   - headless Chrome: CDP 9223, fresh profile
#
# The daemon is SIGTERMed by the probe mid-drag BY EXACT PID (DAEMON_PID env);
# the runner only kills pids it spawned. All spawned processes are stopped and
# the scratch dir removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/herdr-postfix.XXXXXX)"
PORT="${E2E_PORT:-8895}"
CDP="${CDP_PORT:-9223}"
SESSION="resize-hang-test"
DAEMON_PID=""
SERVER_PID=""
CHROME_PID=""
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
  if [[ $KEEP -eq 1 ]]; then
    echo "--keep set: leaving $WORK (daemon=$DAEMON_PID server=$SERVER_PID chrome=$CHROME_PID)"
    return
  fi
  stop_pid "$CHROME_PID"
  stop_pid "$DAEMON_PID"
  stop_pid "$SERVER_PID"
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
  echo "cleanup done: scratch processes stopped, $WORK removed"
}
trap cleanup EXIT

wait_for() {
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 60); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

echo "==> workdir: $WORK"
mkdir -p "$WORK/xdg/herdr/sessions/$SESSION" "$WORK/xdg/herdr-webui"

# The webui must default to the external herdr daemon for this session.
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<EOF
{
  "bind": "127.0.0.1:$PORT",
  "backend_mode": "external-herdr"
}
EOF

echo "==> building herdr-webui (debug, assets embedded)"
(cd "$ROOT" && cargo build --quiet)

echo "==> starting scratch herdr daemon (session $SESSION)"
XDG_CONFIG_HOME="$WORK/xdg" HERDR_SESSION="$SESSION" \
  /opt/homebrew/bin/herdr server >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

SESSION_DIR="$WORK/xdg/herdr/sessions/$SESSION"
for _ in $(seq 1 60); do
  [[ -S "$SESSION_DIR/herdr-client.sock" ]] && break
  sleep 0.25
done
[[ -S "$SESSION_DIR/herdr-client.sock" ]] || {
  echo "FAIL: daemon client socket never appeared" >&2
  tail -20 "$WORK/daemon.log" >&2 || true
  exit 1
}
echo "daemon up (pid $DAEMON_PID)"

echo "==> creating a workspace over the daemon socket API"
mkdir -p "$WORK/repo"
XDG_CONFIG_HOME="$WORK/xdg" HERDR_SESSION="$SESSION" \
  /opt/homebrew/bin/herdr workspace create --cwd "$WORK/repo" --label "postfix" --no-focus \
  >"$WORK/workspace-create.log" 2>&1 || {
    echo "WARN: workspace create failed:" >&2
    tail -20 "$WORK/workspace-create.log" >&2 || true
  }

echo "==> starting scratch herdr-webui on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" >"$WORK/webui.log" 2>&1 &
SERVER_PID=$!
wait_for "webui" "https://127.0.0.1:$PORT/" -k || { tail -20 "$WORK/webui.log" >&2; exit 1; }
echo "webui up (pid $SERVER_PID)"

echo "==> launching headless Chrome (CDP $CDP)"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME_BIN" ]] || { echo "Chrome not found at $CHROME_BIN; set CHROME_BIN" >&2; exit 2; }
"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank >/dev/null 2>&1 &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" "" || exit 1

echo "==> running post-fix validation probe"
E2E_BASE_URL="https://127.0.0.1:$PORT/" SESSION="$SESSION" CDP_PORT="$CDP" \
  DAEMON_PID="$DAEMON_PID" SERVER_PID="$SERVER_PID" \
  KILL_AFTER="${KILL_AFTER:-5}" DRAG_SECONDS="${DRAG_SECONDS:-14}" \
  node "$ROOT/scripts/e2e/resize-hang-probe-postfix-validation.mjs"