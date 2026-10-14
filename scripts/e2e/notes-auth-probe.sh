#!/usr/bin/env bash
# Live auth probe for the notes routes. Boots an isolated herdr-webui
# with auth enabled (no localhost_no_auth) on port 8899 and asserts
# every notes method+route combo returns 401 without a session cookie.
# The route tests cover GET /api/notes; this probe covers all five
# combinations against the real binary over a real socket.
#
# Usage:
#   scripts/e2e/notes-auth-probe.sh
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-notes-auth-probe.XXXXXX")"
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

echo "==> starting isolated server with auth required on http://127.0.0.1:$PORT"
mkdir -p "$WORK/xdg/herdr-webui"
# Credentials on, localhost bypass off. The loopback default ships with
# localhost_no_auth true, and validation rejects a local bind with no
# credentials unless the bypass is enabled, so the settings file must pin
# both for this probe to exercise require_auth.
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "user": "probe-user", "password": "probe-pass", "localhost_no_auth": false }
EOF
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "notes-auth-probe-$$" \
  --backend-mode builtin &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 0.2
done

failures=0
probe() {
  local method="$1" path="$2" expect="$3"
  shift 3
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$@" "http://127.0.0.1:$PORT$path")"
  if [[ "$code" != "$expect" ]]; then
    echo "FAIL $method $path -> $code (want $expect)"
    failures=$((failures + 1))
  else
    echo "ok   $method $path -> $code"
  fi
}

# POST/PUT carry the real request shape (JSON content-type + body) so they
# reach the handler's auth check instead of being rejected by the Json
# extractor first. That extractor-order behavior is app-wide, not notes-specific.
probe GET /api/notes 401
probe POST /api/notes 401 -H 'Content-Type: application/json' -d '{"title":"p"}'
probe PUT /api/notes/probe-id 401 -H 'Content-Type: application/json' -d '{"content":"p"}'
probe DELETE /api/notes/probe-id 401
probe POST /api/notes/clear 401

# Positive control: log in with the probe credentials, then confirm the
# notes routes serve the authenticated session (proves the 401s come from
# require_auth, not route mismatch).
echo "==> positive control: login + authenticated notes access"
COOKIE_JAR="$WORK/cookies.txt"
login_code="$(curl -s -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"username":"probe-user","password":"probe-pass"}' "http://127.0.0.1:$PORT/api/login")"
if [[ "$login_code" != "200" ]]; then
  echo "FAIL login -> $login_code (want 200)"
  failures=$((failures + 1))
else
  echo "ok   login -> 200"
fi
auth_list="$(curl -s -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/notes")"
if [[ "$auth_list" != "200" ]]; then
  echo "FAIL GET /api/notes with session -> $auth_list (want 200)"
  failures=$((failures + 1))
else
  echo "ok   GET /api/notes with session -> 200"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "==> notes auth probe: FAILED ($failures)"
  exit 1
fi
echo "==> notes auth probe: PASSED (5/5 routes reject unauthenticated, session accepted)"
