#!/usr/bin/env bash
# Manual probe for the composer submit route refusal bodies.
# Starts an isolated builtin server on 127.0.0.1:8799, curls the submit
# route, prints the raw JSON bodies, stops the server.
set -u
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-submit-probe.XXXXXX")"
XDG_CONFIG_HOME="$WORK/xdg" "$PWD/target/debug/herdr-webui" \
  --bind "127.0.0.1:8799" --backend-mode builtin --https off >/dev/null 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:8799/" >/dev/null 2>&1 && break
  sleep 0.2
done
echo "--- unknown pane:"
curl -s -w "\nHTTP:%{http_code}" -X POST "http://127.0.0.1:8799/api/panes/nope/submit" \
  -H "content-type: application/json" -d '{"text":"hello"}'
echo
echo "--- whitespace-only:"
curl -s -w "\nHTTP:%{http_code}" -X POST "http://127.0.0.1:8799/api/panes/nope/submit" \
  -H "content-type: application/json" -d '{"text":"   "}'
echo
kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
rm -rf "$WORK"