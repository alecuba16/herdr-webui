#!/usr/bin/env bash
# End-to-end acceptance run for the temporary Files/Git overlays.
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session, so a
# user's running instance is never touched) and drives the served overlay
# bundles against the real backend and throwaway fixture folders: both
# overlays open at once (coexistence), the real directory picker module
# changes folder, picker close keeps the folder, closing one overlay leaves
# the sibling mounted, and no workspace/session API is ever called.
#
# Usage:
#   scripts/e2e/run-temp-overlays-e2e.sh [--keep]     # --keep skips teardown for debugging
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  echo "ERROR: port $PORT is already in use; kill the leftover e2e instance first." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-temp-overlays-e2e.XXXXXX")"

session_id() {
  printf 'temp-overlays-e2e-%s-%s' "$$" "$(date +%s)"
}

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.3
  done
  kill -9 "$pid" 2>/dev/null || true
}

SESSION="$(session_id)"
SERVER_PID=""

cleanup() {
  stop_pid "$SERVER_PID"
  if [[ "$KEEP" == 1 ]]; then
    echo "kept work dir: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# Fixture folders: a plain dir for Files, a real git repo for Git.
FILES_DIR="$WORK/files-fixture"
GIT_DIR="$WORK/git-fixture"
mkdir -p "$FILES_DIR/subdir" "$GIT_DIR"
printf 'fixture\n' > "$FILES_DIR/notes.txt"
git -C "$GIT_DIR" init -q
git -C "$GIT_DIR" -c user.email=e2e@local -c user.name=e2e commit -q --allow-empty -m "fixture"

# Isolated config so the user's real instance and settings stay untouched.
mkdir -p "$WORK/xdg/herdr-webui" "$WORK/home"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" << 'EOF'
{
  "bind": "127.0.0.1:8899",
  "tls_mode": "self-signed",
  "user": null,
  "password": null,
  "localhost_no_auth": true,
  "session_expiration_minutes": 0,
  "no_sleep_auto_cooldown_seconds": 60,
  "backend_mode": "builtin",
  "builtin_shell": null,
  "default_folder": "/tmp",
  "builtin_backend_enabled": true,
  "external_herdr_backend_enabled": false,
  "jcode_detection_variant": "alecuba16",
  "log_level": "none",
  "lsp": { "enabled": false, "servers": {} }
}
EOF

cd "$ROOT"
cargo build -q

XDG_CONFIG_HOME="$WORK/xdg" HOME="$WORK/home" ./target/debug/herdr-webui \
  --bind "127.0.0.1:$PORT" --session "$SESSION" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -sk -o /dev/null "https://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  sleep 0.2
done
if ! curl -sk -o /dev/null "https://127.0.0.1:$PORT/"; then
  echo "ERROR: server did not come up; log follows" >&2
  cat "$WORK/server.log" >&2
  exit 1
fi

# Loopback login (localhost_no_auth) mints the session cookie the vm fetches use.
COOKIE_HEADER=$(curl -sk -i -X POST "https://127.0.0.1:$PORT/api/login" \
  -H "Content-Type: application/json" -d '{"username":"e2e","password":"e2e"}' \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="set-cookie" {print $2}' | head -1)

echo "running temp-overlays-acceptance.mjs"
E2E_ORIGIN="https://127.0.0.1:$PORT" \
E2E_FILES_DIR="$FILES_DIR" \
E2E_GIT_DIR="$GIT_DIR" \
E2E_COOKIE="$COOKIE_HEADER" \
  node scripts/e2e/temp-overlays-acceptance.mjs

echo "PASS - temp overlays e2e"