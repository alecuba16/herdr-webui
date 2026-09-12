#!/usr/bin/env bash
# End-to-end acceptance run for the Git drawer CONTENT in a real browser.
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session, so a
# running user instance is never touched) and drives the actually served app
# in headless Chrome over CDP against a fixture git repo with a dirty
# worktree, a feature branch, and a multi-commit log. Verifies the drawer's
# rendered DOM: changes tree rows with real diff counts, the diff view for a
# modified file, the log graph table, the branch list popover, and the
# return to the terminal.
#
# Usage:
#   scripts/e2e/run-git-drawer-e2e.sh [--keep]     # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome remote debugging port (default 9222)
#   CHROME_BIN   path to Chrome/Chromium if not auto-detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9222}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-git-drawer-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() {
  # Unique per run so two concurrent runs never share server state.
  printf 'git-drawer-e2e-%s-%s' "$$" "$(date +%s)"
}

stop_pid() {
  # The server ignores SIGTERM while in its bind-retry sleep; escalate to KILL.
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
  stop_pid "${CHROME_PID:-}"
  stop_pid "${SERVER_PID:-}"
  # Chrome's crash-updater can hold profile files briefly; retry the removal.
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
}
trap cleanup EXIT

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo"
REPO="$WORK/accept-repo"
mkdir -p "$REPO/src"
cat > "$REPO/README.md" <<'EOF'
# readme
base line one
base line two
EOF
cat > "$REPO/src/demo.py" <<'EOF'
print('hello')
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm "init"
# A second commit on main so the log graph has rows to render.
cat >> "$REPO/README.md" <<'EOF'
base line three
EOF
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm "feat: first change"
# A feature branch with its own commit (switching is covered by the no-browser
# git e2e; here it just needs to exist for the branch list).
git -C "$REPO" checkout -q -b feature/drawer
echo "branch work" > "$REPO/feature.txt"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm "chore: branch commit"
git -C "$REPO" checkout -q main
# Dirty the worktree: an edited README (a diff with real +/- counts and a
# recognizable new line) plus the untracked dir for the changes tree.
cat >> "$REPO/README.md" <<'EOF'
e2e drawer acceptance line
EOF
mkdir -p "$REPO/scratchdir"
: > "$REPO/scratchdir/placeholder.txt"

wait_for() {
  # wait_for <desc> <url> [-k]
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 50); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "$(session_id)" &
SERVER_PID=$!

wait_for "server" "https://127.0.0.1:$PORT/" -k || exit 1

echo "==> launching headless Chrome (CDP port $CDP)"
CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    [[ -x "$c" ]] && CHROME_BIN="$c" && break
  done
fi
[[ -x "$CHROME_BIN" ]] || { echo "no Chrome/Chromium found; set CHROME_BIN"; exit 2; }

"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" "" || exit 1

echo "==> running git drawer content acceptance checks"
ACCEPT_REPO="$REPO" E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/git-drawer-content-acceptance.mjs"