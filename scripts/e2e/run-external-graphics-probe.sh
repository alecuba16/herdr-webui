#!/usr/bin/env bash
# Live probe: verify herdr 0.9.0 ClientShell endpoint graphics delivery on an
# ISOLATED daemon, using the WebUI's own protocol.rs types over the real wire.
#
# Proves (external-backend image support, docs/terminal-image-support.md):
#   1. `EndpointControl{endpoint.hello.v1}` with known cell metrics is
#      accepted as the first client message and answered with
#      `endpoint.welcome.v1` carrying the four v1 codecs.
#   2. A pane emitting Kitty graphics (the same f=32 RGBA transmit + placement
#      herdr's own headless tests use) is captured by the daemon's Ghostty
#      core and delivered to the endpoint client as a PaneSurface frame with a
#      non-empty graphics scene (1 asset + 1 placement) the WebUI types decode.
#   3. Negative control: a second connection reporting NO cell metrics
#      (cell 0x0) receives surfaces with NO graphics scene — herdr 0.9.0 gates
#      the scene on cell_size.is_known(), not on the hello's direct_graphics
#      flag (that flag only arms the GraphicsFile upload path).
#
# Isolation: scratch XDG_CONFIG_HOME + scratch HERDR_SESSION under a scratch
# work dir. Never touches the user's real herdr session or sockets. All
# spawned processes are killed and the scratch dir removed on exit.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# sun_path is 104 bytes; keep the socket path short by using a shallow
# mktemp dir under /tmp instead of the deep jcode scratch tree.
WORK="$(mktemp -d /tmp/herdr-extprobe.XXXXXX)"
SESSION="extprobe-$$_$(date +%s)"
DAEMON_PID=""

cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

export XDG_CONFIG_HOME="$WORK/xdg"
mkdir -p "$XDG_CONFIG_HOME"
export HERDR_SESSION="$SESSION"

SESSION_DIR="$XDG_CONFIG_HOME/herdr/sessions/$SESSION"
mkdir -p "$SESSION_DIR"

echo "==> isolated herdr daemon: session=$SESSION work=$WORK"
herdr server >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

for _ in $(seq 1 50); do
  [[ -S "$SESSION_DIR/herdr-client.sock" ]] && break
  sleep 0.2
done
[[ -S "$SESSION_DIR/herdr-client.sock" ]] || {
  echo "FAIL: client socket never appeared"
  tail -20 "$WORK/daemon.log" || true
  exit 1
}
echo "daemon up (pid $DAEMON_PID, sockets in $SESSION_DIR)"

HERDR_WEBUI_EXTERNAL_PROBE="$SESSION_DIR" cargo test --lib -- \
  protocol::external_probe_tests::external_endpoint_graphics_probe --nocapture

echo "PROBE PASS"