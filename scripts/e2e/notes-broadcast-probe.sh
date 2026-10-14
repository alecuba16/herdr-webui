#!/usr/bin/env bash
# Live broadcast-contract probe: the notes_changed frame must carry the
# same server-owned contract as GET (newest-first notes, display_title,
# the language table) and fan out to two concurrent subscribers. Same
# isolation conventions as notes-auth-probe.sh: isolated XDG dir, pinned
# credentials, localhost_no_auth off, --https off, port 8899.
set -euo pipefail

PORT=8899
BASE="http://127.0.0.1:${PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

WORK_DIR="$(mktemp -d)"
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

XDG_DIR="${WORK_DIR}/config"
mkdir -p "${XDG_DIR}/herdr-webui"

# Credentials on, localhost bypass off, plain http: the probe must see
# the real require_auth path (same pinning rationale as notes-auth-probe).
cat > "${XDG_DIR}/herdr-webui/webui-settings.json" <<'JSON'
{ "user": "probe-user", "password": "probe-pass", "localhost_no_auth": false }
JSON

echo "==> building herdr-webui (debug)"
(cd "${ROOT}" && cargo build --target-dir target --quiet)

echo "==> starting isolated server on http://127.0.0.1:${PORT}"
XDG_CONFIG_HOME="${XDG_DIR}" "${ROOT}/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:${PORT}" --session "notes-broadcast-probe-$$" \
  --backend-mode builtin > "${WORK_DIR}/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -s -o /dev/null "${BASE}/"; then break; fi
  sleep 0.2
done

COOKIE_FILE="${WORK_DIR}/cookies.txt"
LOGIN_CODE="$(curl -s -c "${COOKIE_FILE}" -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"username":"probe-user","password":"probe-pass"}' "${BASE}/api/login")"
if [[ "${LOGIN_CODE}" != "200" ]]; then
  echo "FAIL login -> ${LOGIN_CODE}"
  exit 1
fi
SESSION="$(grep herdr_web_session "${COOKIE_FILE}" | awk '{print $NF}')"
if [[ -z "${SESSION}" ]]; then
  echo "FAIL no session cookie after login"
  exit 1
fi

node "${SCRIPT_DIR}/notes-broadcast-contract.mjs" \
  "ws://127.0.0.1:${PORT}/ws/events" "${SESSION}" "${BASE}"