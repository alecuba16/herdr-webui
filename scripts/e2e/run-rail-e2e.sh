#!/usr/bin/env bash
# Real-DOM acceptance for the maximize rail (n1) and git tab labels
# (n2/n3). Boots an isolated herdr-webui (own XDG_CONFIG_HOME with
# localhost_no_auth, own session, own port 8897; the user's running
# instance on 8787 is never touched) plus chrome-headless on CDP 9225,
# then drives the real served bundle: split, maximize, rail render with
# live controls, own-tab click keeping the flat view, rail tab click
# restoring the split, and the git drawer's pane tab labeled
# gitchanges.
#
# Usage:
#   scripts/e2e/run-rail-e2e.sh [--keep]     # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8897)
#   CDP_PORT     Chrome DevTools port (default 9225)
#   CHROME_BIN   Chrome binary (default: chrome-headless-shell lookup)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8897}"
CDP="${CDP_PORT:-9225}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-rail-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo"
REPO="$WORK/rail-repo"
mkdir -p "$REPO/src"
cat > "$REPO/README.md" <<'EOF'
# readme
EOF
cat > "$REPO/src/app.js" <<'EOF'
console.log("hello");
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add README.md src/app.js
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

echo "==> starting isolated server on http://127.0.0.1:$PORT"
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "rail-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!

wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME="$(chrome_bin)"
echo "==> starting headless Chrome on CDP $CDP"
CHROME_PROFILE="$WORK/chrome-profile"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  --window-size=1440,900 \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version" || {
  echo "chrome boot failed; stderr:" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
}

echo "==> running rail acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$REPO" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/rail-acceptance.mjs" "$WORK/rail_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> rail acceptance: PASSED"
else
  echo "==> rail acceptance: FAILED" >&2
  [[ -f "$WORK/rail_result.json" ]] && cat "$WORK/rail_result.json" >&2
fi
exit $status