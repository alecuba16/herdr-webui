#!/usr/bin/env bash
# Real-browser acceptance for the chat mode segment colorization
# (thinking magenta, tool names cyan, running amber, errors danger).
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME with localhost_no_auth,
# own HOME so the jcode sessions store is only the fixture session, own
# session, own port; the user's running instance is never touched) plus
# headless Chrome for Testing on CDP, then drives the real served bundle:
# a fake jcode process keeps the pane resolvable while the fixture session
# carries thinking, tool, running, and error parts. The driver asserts the
# computed colors of the rendered rows (both themes) and saves a screenshot.
#
# Usage:
#   scripts/e2e/run-chat-colors-e2e.sh [--keep]     # --keep skips teardown
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-chat-colors-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

SESSION_ID="session_chatcolors_e2e_000000000000_0000000000000000"

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

# Fixture session: the messages cover every colored segment kind. The
# fake jcode stamps the real pid into last_pid once it spawns (step 1
# evidence); here it starts at 0 so an unspawned pane cannot resolve.
mkdir -p "$WORK/home/.jcode/sessions"
python3 - "$WORK/home/.jcode/sessions/$SESSION_ID.json" "$WORK/repo" <<'EOF'
import json, sys
path, cwd = sys.argv[1], sys.argv[2]
session_id = path.rsplit("/", 1)[-1][:-len(".json")]
messages = [
    {"id": "m1", "role": "user", "content": [{"type": "text", "text": "run the build and check the search bug"}]},
    {"id": "m2", "role": "assistant", "content": [
        {"type": "reasoning", "text": "The search bug is in the filter merge. Reproduce first, then read the diff."},
        {"type": "tool_use", "id": "call_bash_ok", "name": "bash", "input": {"command": "cargo build"}},
        {"type": "text", "text": "Build passes. Reproducing the search failure now."},
    ]},
    {"id": "m3", "role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_bash_ok", "content": "Compiling herdr-webui\nFinished dev profile"},
    ]},
    {"id": "m4", "role": "assistant", "content": [
        {"type": "tool_use", "id": "call_bash_bad", "name": "bash", "input": {"command": "rg missing-symbol src/"}},
        {"type": "tool_use", "id": "call_read_pending", "name": "read", "input": {"path": "src/search.rs"}},
        {"type": "text", "text": "Reading the search implementation while the grep runs."},
    ]},
    {"id": "m5", "role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_bash_bad", "content": "rg: no matches found", "is_error": True},
    ]},
    {"id": "m6", "role": "assistant", "content": [
        {"type": "text", "text": "The filter merge drops the query when the scope is empty. Fix incoming."},
    ]},
]
snapshot = {
    "id": session_id,
    "title": "chat colors e2e",
    "created_at": 1,
    "updated_at": 2,
    "messages": messages,
    "compaction": None,
    "model": "m",
    "working_dir": cwd,
    "short_name": "chatcolors",
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
  --https off --bind "127.0.0.1:$PORT" --session "chat-colors-e2e-$$-$(date +%s)" --backend-mode builtin &
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

echo "==> running chat colors acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$WORK/repo" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/chat-colors-acceptance.mjs" "$WORK/chat_colors_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> chat colors acceptance: PASSED"
else
  echo "==> chat colors acceptance: FAILED" >&2
  [[ -f "$WORK/chat_colors_result.json" ]] && cat "$WORK/chat_colors_result.json" >&2
fi
exit $status
