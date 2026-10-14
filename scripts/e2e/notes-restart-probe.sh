#!/usr/bin/env bash
# Live restart-persistence probe for the notes sidecar. Boots an isolated
# herdr-webui, creates a note through the real API, kills the server, boots
# a fresh server process on the same XDG dir, and asserts the note is
# served from the notes.json sidecar. This exercises the "survives server
# restarts" doc claim end to end; the unit tests cover load_notes/save_notes
# and the e2e covers client reloads, but neither restarts the process.
#
# Usage:
#   scripts/e2e/notes-restart-probe.sh
#
# Environment overrides:
#   PROBE_PORT   server port (default 8899)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PROBE_PORT:-8899}"

if command -v lsof >/dev/null 2>&1; then
  if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT busy, abort" >&2
    exit 1
  fi
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-notes-restart-probe.XXXXXX")"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

start_server() {
  mkdir -p "$WORK/xdg/herdr-webui"
  cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF
  XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
    --https off --bind "127.0.0.1:$PORT" --session "notes-restart-probe-$$" \
    --backend-mode builtin &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then return 0; fi
    sleep 0.2
  done
  echo "server did not come up" >&2
  return 1
}

failures=0

echo "==> boot 1: create a note through the real API"
start_server
create_body="$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"title":"restart survivor","content":"still here after reboot","language":"markdown"}' \
  "http://127.0.0.1:$PORT/api/notes")"
note_id="$(printf '%s' "$create_body" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
if [[ -z "$note_id" ]]; then
  echo "FAIL create returned no id: $create_body"
  exit 1
fi
echo "ok   created note $note_id"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
sleep 0.5

echo "==> boot 2: fresh process, same XDG dir"
start_server
list_body="$(curl -s "http://127.0.0.1:$PORT/api/notes")"
if printf '%s' "$list_body" | grep -q '"restart survivor"'; then
  echo "ok   note survived the server restart"
else
  echo "FAIL note missing after restart: $list_body"
  failures=$((failures + 1))
fi
content_body="$(curl -s "http://127.0.0.1:$PORT/api/notes")"
if printf '%s' "$content_body" | grep -q 'still here after reboot'; then
  echo "ok   content survived the server restart"
else
  echo "FAIL content missing after restart"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo "==> notes restart probe: FAILED ($failures)"
  exit 1
fi
echo "==> notes restart probe: PASSED (sidecar survives a process restart)"
