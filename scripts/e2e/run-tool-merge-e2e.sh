#!/usr/bin/env bash
# Real-browser acceptance for the consecutive same-name tool merge
# (merge_consecutive_tool_blocks): bash x2, a text interlude, then bash
# again in one assistant turn. The driver asserts one merged head with
# the x2 badge, one brief-only tail row, per-tail expansion, and poll
# stability. Server + Chrome are isolated; a user's running instance is
# never touched.
#
# Usage:
#   scripts/e2e/run-tool-merge-e2e.sh [--keep]     # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome DevTools port (default 9224)
#   CHROME_BIN   Chrome for Testing binary (default: first found in the
#                usual per-OS locations)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9224}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-tool-merge-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

SESSION_ID="session_toolmerge_e2e_000000000000_0000000000000000"

# Fake jcode: keeps the pane resolvable and stamps its pid into the
# fixture session (same contract as run-chat-colors-e2e.sh).
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

cat > "$WORK/repo/README.md" <<'EOF'
# readme
EOF

# Fixture transcript: one assistant turn carrying bash, bash, text,
# bash. The merge must render ONE head with x2 for the first run, a
# separate head for the post-text bash, and the tail row brief-only.
python3 - "$WORK/home/.jcode/sessions/$SESSION_ID.json" "$WORK/repo" <<'EOF'
import json, sys
path, cwd = sys.argv[1], sys.argv[2]
session_id = path.rsplit("/", 1)[-1][:-len(".json")]
messages = [
    {"id": "m1", "role": "user", "content": [{"type": "text", "text": "run the checks"}]},
    {"id": "m2", "role": "assistant", "content": [
        {"type": "tool_use", "id": "call_bash_1", "name": "bash", "input": {"command": "cargo build"}},
        {"type": "tool_use", "id": "call_bash_2", "name": "bash", "input": {"command": "rg missing-symbol src/"}},
        {"type": "text", "text": "Build passes. The grep comes back empty."},
        {"type": "tool_use", "id": "call_bash_3", "name": "bash", "input": {"command": "cargo test"}},
    ]},
    {"id": "m3", "role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_bash_1", "content": "Compiling herdr-webui\nFinished dev profile"},
        {"type": "tool_result", "tool_use_id": "call_bash_2", "content": "rg: no matches found", "is_error": True},
        {"type": "tool_result", "tool_use_id": "call_bash_3", "content": "test result: ok"},
    ]},
    {"id": "m4", "role": "assistant", "content": [
        {"type": "text", "text": "All checks done."},
    ]},
]
snapshot = {
    "id": session_id,
    "title": "tool merge e2e",
    "created_at": 1,
    "updated_at": 2,
    "messages": messages,
    "compaction": None,
    "model": "m",
    "working_dir": cwd,
    "short_name": "toolmerge",
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
  --https off --bind "127.0.0.1:$PORT" --session "tool-merge-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!

wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME="$(chrome_bin)"
echo "==> starting headless Chrome on CDP $CDP"
CHROME_PROFILE="$WORK/chrome-profile"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  --window-size=1440,900 \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version" || {
  echo "chrome boot failed; stderr:" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
}

echo "==> running tool merge acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$WORK/repo" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/tool-merge-acceptance.mjs" "$WORK/tool_merge_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> tool merge acceptance: PASSED"
else
  echo "==> tool merge acceptance: FAILED" >&2
  [[ -f "$WORK/tool_merge_result.json" ]] && cat "$WORK/tool_merge_result.json" >&2
fi
exit $status