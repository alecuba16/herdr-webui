#!/usr/bin/env bash
# Real-browser acceptance for the draggable Chat|Terminal switch in BOTH
# layouts (mobile + desktop). The pill drags anywhere over its surface,
# the position persists per layout (mobile: localStorage key, desktop:
# options.lensSwitchPos), taps still toggle the view, and the mobile
# switch row is gone (the terminal owns the full screen height, the
# pill floats over it).
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME with localhost_no_auth,
# own HOME so the jcode sessions store holds only the fixture session, own
# session, own port; the user's running instance is never touched) plus
# headless Chrome for Testing on CDP, then drives the real served bundles
# through real CDP input events (mouse down/move/up): the drag path is the
# one users hit, listeners included.
#
# Usage:
#   scripts/e2e/run-switch-drag-e2e.sh [--keep]   # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8894)
#   CDP_PORT     Chrome DevTools port (default 9230)
#   CHROME_BIN   Chrome for Testing binary (default: first found in the
#                usual per-OS locations)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8894}"
CDP="${CDP_PORT:-9230}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-switch-drag-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

SESSION_ID="session_switchdrag_e2e_000000000000_000000000000"

# Fake jcode: argv[0] stem reads "jcode" to the agent detector, and it
# stays alive forever. Its first act is stamping its own pid into the
# fixture session's snapshot: resolution step 1 needs the session's
# last_pid to be a process inside the pane's tree (the pane spawns this
# script, so the pid is a direct child) with the same cwd, and a static
# fixture cannot know the pid in advance. The store index sweep re-reads
# changed files (generation = mtime+size), so the next poll resolves.
FAKE_JCODE="$WORK/bin/jcode"
SESSION_JSON="$WORK/home/.jcode/sessions/$SESSION_ID.json"
STAMP_PID="$WORK/bin/stamp_pid.py"
mkdir -p "$WORK/bin" "$WORK/home/.jcode/sessions" "$WORK/repo"
cat > "$STAMP_PID" <<'EOF'
import json, sys
pid, path = int(sys.argv[1]), sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
    data["last_pid"] = pid
    with open(path, "w") as f:
        json.dump(data, f)
except Exception:
    pass
EOF
cat > "$FAKE_JCODE" <<EOF
#!/bin/bash
echo \$\$ > "$WORK/bin/jcode.pid"
python3 "$STAMP_PID" \$\$ "$SESSION_JSON"
while true; do sleep 5; done
EOF
chmod +x "$FAKE_JCODE"

# Fixture session: one short exchange is enough; the switch only needs a
# resolvable conversation to mount.
python3 - "$WORK/home/.jcode/sessions/$SESSION_ID.json" "$WORK/repo" <<'EOF'
import json, sys
path, cwd = sys.argv[1], sys.argv[2]
session_id = path.rsplit("/", 1)[-1][:-len(".json")]
messages = [
    {"id": "m1", "role": "user", "content": [{"type": "text", "text": "switch drag e2e"}]},
    {"id": "m2", "role": "assistant", "content": [{"type": "text", "text": "ready"}]},
]
snapshot = {
    "id": session_id,
    "title": "switch drag e2e",
    "created_at": 1,
    "updated_at": 2,
    "messages": messages,
    "compaction": None,
    "model": "m",
    "working_dir": cwd,
    "short_name": "swdrag",
    "status": "Active",
    "last_pid": 0,
    "last_active_at": 2,
    "saved": True,
}
with open(path, "w") as f:
    json.dump(snapshot, f)
EOF

echo "==> starting isolated server on http://127.0.0.1:$PORT"
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<EOF
{ "localhost_no_auth": true, "builtin_shell": "$FAKE_JCODE" }
EOF
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/xdg" \
  "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "switch-drag-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!

wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME="$(chrome_bin)"
echo "==> starting headless Chrome on CDP $CDP"
CHROME_PROFILE="$WORK/chrome-profile"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  --window-size=1280,900 \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version" || {
  echo "chrome boot failed; stderr:" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
}

echo "==> running switch drag acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$WORK/repo" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/switch-drag-acceptance.mjs" "$WORK/switch_drag_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> switch drag acceptance: PASSED"
else
  echo "==> switch drag acceptance: FAILED" >&2
  [[ -f "$WORK/switch_drag_result.json" ]] && cat "$WORK/switch_drag_result.json" >&2
fi
exit $status
