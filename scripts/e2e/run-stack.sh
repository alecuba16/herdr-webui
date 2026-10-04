#!/usr/bin/env bash
# Manual keep-stack for visual/width checks against a fixed port pair.
# Usage: scratch scripts/run-stack.sh <port> <cdp_port> <workdir>
#
# Boots with an ISOLATED HOME (its own empty .jcode store) so the
# lens-switch scripts can seed synthetic jcode sessions without ever
# touching the user's real ~/.jcode. The seeded working_dir must be the
# PHYSICAL path of the scratch repo: on macOS /tmp is a symlink to
# /private/tmp and the pane->session resolution string-compares the
# lsof-resolved live cwd (always physical) against the seeded
# working_dir, so a logical path silently never matches.
set -euo pipefail
PORT="${1:-8798}"
CDP="${2:-9228}"
WORK="${3:?workdir required}"
mkdir -p "$WORK/home/.jcode/sessions" "$WORK/xdg" "$WORK/scratch"
echo "# scratch" > "$WORK/scratch/README.md"
SCRATCH_REAL="$(cd "$WORK/scratch" && pwd -P)"
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/xdg" nohup "$(cd "$(dirname "$0")/../.." && pwd)/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --backend-mode builtin --https off >/dev/null 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$WORK/server.pid"

CHROME_BIN="${CHROME_BIN:-$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell}"
"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank >/dev/null 2>&1 &
CHROME_PID=$!
echo "$CHROME_PID" > "$WORK/chrome.pid"

for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.2
done
for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && break
  sleep 0.2
done
echo "stack ready: server=$PORT cdp=$CDP work=$WORK"
echo "  isolated jcode store: $WORK/home/.jcode/sessions (LENS_SWITCH_STORE)"
echo "  physical scratch cwd: $SCRATCH_REAL (ACCEPT_ROOT)"
# Stay alive while the children run, but survive SIGTERM propagation
# from a parent task runner by detaching the children into their own
# process group (nohup) so a killed parent does not kill the stack.
trap 'echo "stack stopping"' TERM INT
wait