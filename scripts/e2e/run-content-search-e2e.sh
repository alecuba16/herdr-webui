#!/usr/bin/env bash
# End-to-end acceptance run for backend-built content-search chunks.
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session, so a
# user's running instance is never touched) and verifies that the real
# backend returns pre-merged line chunks with highlight markup, and that the
# served renderer consumes them. Like run-git-e2e.sh this needs no browser:
# the acceptance script boots the served JS in a node vm and proxies fetch to
# the real server.
#
# Usage:
#   scripts/e2e/run-content-search-e2e.sh [--keep]
#
# Environment overrides:
#   E2E_PORT     server port (default 8897)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8897}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-content-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() {
  printf 'content-e2e-%s-%s' "$$" "$(date +%s)"
}

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.4
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  [[ $KEEP -eq 1 ]] && { echo "--keep set: leaving $WORK running"; return; }
  stop_pid "${SERVER_PID:-}"
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo with overlapping matches"
REPO="$WORK/content-accept-repo"
mkdir -p "$REPO/src"
cat > "$REPO/README.md" <<'EOF'
# readme
EOF
# Line 3 and line 5 both match. With context_lines=2 their windows are
# lines 1-5 and 3-7, overlapping, so the backend must merge them into one
# continuous chunk spanning lines 1-7.
cat > "$REPO/src/chunks.rs" <<'EOF'
one
two
e2eneedle here
four
<b>html e2eneedle</b>
six
seven
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

# The server needs localhost auth bypass enabled for the acceptance probes.
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "$(session_id)" --backend-mode builtin &
SERVER_PID=$!

wait_for() {
  local desc="$1" url="$2"
  for i in $(seq 1 50); do
    if curl -sf -k "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}
wait_for "server" "https://127.0.0.1:$PORT/" || exit 1

echo "==> running content-search acceptance checks"
E2E_ORIGIN="https://127.0.0.1:$PORT" E2E_REPO="$REPO" node "$ROOT/scripts/e2e/content-search-acceptance.mjs"
status=$?

if [[ $status -eq 0 ]]; then
  echo "==> content-search acceptance: PASSED"
else
  echo "==> content-search acceptance: FAILED" >&2
fi
exit $status