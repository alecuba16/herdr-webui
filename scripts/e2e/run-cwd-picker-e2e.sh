#!/usr/bin/env bash
# Real-DOM acceptance run for the Git path-title folder picker.
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME + --session, localhost
# auth bypass) and a self-contained headless Chrome (Chrome for Testing) via
# CDP, then drives the served app with real clicks: path title button ->
# directory picker -> other repo -> return button. Never touches the user's
# running instance or their browser profile.
#
# Usage:
#   scripts/e2e/run-cwd-picker-e2e.sh [--keep]     # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8897)
#   CDP_PORT     headless Chrome CDP port (default 9224)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8897}"
CDP="${CDP_PORT:-9224}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

CHROME="$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell"
[[ -x "$CHROME" ]] || { echo "ERROR: Chrome for Testing not found at $CHROME (see cdp-chrome skill)" >&2; exit 1; }

for p in "$PORT" "$CDP"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | grep -q .; then
    echo "ERROR: port $p is already in use; kill the leftover e2e process first." >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2 || true
    exit 1
  fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-cwd-e2e.XXXXXX")"
CHROME_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/herdr-cwd-e2e-chrome.XXXXXX")"
SERVER_PID=""
CHROME_PID=""

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
  if [[ $KEEP -eq 1 ]]; then echo "--keep set: leaving server ($PORT), Chrome ($CDP) and $WORK running"; return; fi
  stop_pid "$CHROME_PID"
  stop_pid "$SERVER_PID"
  rm -rf "$WORK" "$CHROME_PROFILE" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repos (A: workspace, B: picker target, PLAIN: non-repo)"
REPO_A="$WORK/repo-a"
REPO_B="$WORK/repo-b"
PLAIN="$WORK/plain-dir"
for repo in "$REPO_A" "$REPO_B"; do
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  echo "# $repo" > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" -c user.name=e2e -c user.email=e2e@local commit -qm init
done
mkdir -p "$PLAIN"
echo "not a repo" > "$PLAIN/note.txt"

# Localhost auth bypass so headless Chrome can reach the isolated server.
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> starting isolated server on http://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "cwd-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!

wait_for() {
  local desc="$1" url="$2"
  for i in $(seq 1 50); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}
wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

echo "==> starting headless Chrome (Chrome for Testing) on CDP $CDP"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  "http://127.0.0.1:$PORT/" &
CHROME_PID=$!
wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version" || exit 1

echo "==> running cwd-picker acceptance checks"
CDP_HTTP="http://127.0.0.1:$CDP" APP_URL="http://127.0.0.1:$PORT/" \
  REPO_A="$REPO_A" REPO_B="$REPO_B" PLAIN_DIR="$PLAIN" \
  node "$ROOT/scripts/e2e/cwd-picker-acceptance.mjs"
status=$?

if [[ $status -eq 0 ]]; then
  echo "==> cwd-picker acceptance: PASSED"
else
  echo "==> cwd-picker acceptance: FAILED (exit $status)"
fi
exit $status