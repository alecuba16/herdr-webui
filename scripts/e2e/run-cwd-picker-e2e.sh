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
#   CHROME_BIN   browser path (default: first of
#                              ~/.agents/chrome-headless-shell/.../chrome-headless-shell,
#                              /Applications/Google Chrome.app/...)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8897}"
CDP="${CDP_PORT:-9224}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

CHROME="$(chrome_bin)"
fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-cwd-e2e.XXXXXX")"
CHROME_PROFILE="$WORK/chrome-profile"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

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

wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

echo "==> starting headless Chrome (Chrome for Testing) on CDP $CDP"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
if ! wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version"; then
  echo "--- chrome stderr ---" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
fi

echo "==> running cwd-picker acceptance checks"
status=0
CDP_HTTP="http://127.0.0.1:$CDP" APP_URL="http://127.0.0.1:$PORT/" \
  REPO_A="$REPO_A" REPO_B="$REPO_B" PLAIN_DIR="$PLAIN" \
  node "$ROOT/scripts/e2e/cwd-picker-acceptance.mjs" || status=$?

if [[ $status -eq 0 ]]; then
  echo "==> cwd-picker acceptance: PASSED"
else
  echo "==> cwd-picker acceptance: FAILED (exit $status)" >&2
fi
exit $status