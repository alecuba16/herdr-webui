#!/usr/bin/env bash
# End-to-end acceptance run for the Git explorer rework.
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session, so a
# user's running instance is never touched) and drives the served git-ui
# bundle against the real backend and a throwaway git repo. Unlike
# run-e2e.sh this needs no browser: the acceptance script boots the served
# JS in a node vm and proxies fetch to the real server, so it runs anywhere
# node and cargo do (including CI-style environments).
#
# Usage:
#   scripts/e2e/run-git-e2e.sh [--keep]     # --keep skips teardown for debugging
#
# Environment overrides:
#   E2E_PORT     server port (default 8898)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8898}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-git-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() {
  printf 'git-e2e-%s-%s' "$$" "$(date +%s)"
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

echo "==> creating fixture repo with a dirty working tree"
REPO="$WORK/git-accept-repo"
mkdir -p "$REPO/src" "$REPO/scratchdir"
cat > "$REPO/README.md" <<'EOF'
# readme
EOF
cat > "$REPO/src/app.js" <<'EOF'
console.log("hello");
EOF
cat > "$REPO/scratchdir/alpha.txt" <<'EOF'
alpha
EOF
cat > "$REPO/scratchdir/beta.txt" <<'EOF'
beta
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add README.md src/app.js
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init
# Dirty state: staged edit, unstaged edit, untracked dir.
echo "// staged" >> "$REPO/src/app.js"
git -C "$REPO" add src/app.js
echo "// unstaged" >> "$REPO/src/app.js"

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

echo "==> running git-ui acceptance checks"
E2E_ORIGIN="https://127.0.0.1:$PORT" E2E_REPO="$REPO" node "$ROOT/scripts/e2e/git-acceptance.mjs"
status=$?

if [[ $status -eq 0 ]]; then
  echo "==> git-ui acceptance: PASSED"
else
  echo "==> git-ui acceptance: FAILED" >&2
fi
exit $status