#!/usr/bin/env bash
# Real-DOM acceptance for the mobile Scroll speed setting + chat-lens
# focus parity (scroll_speed branch). Own isolated server (8899) and own
# chrome-headless (CDP 9229). Forces the mobile layout, seeds a fixture
# repo as a workspace, then drives the real mobile bundle:
#
#   ss1  Settings > Terminal renders the Scroll speed row (default 3, 1-20)
#   ss2  slider input persists scrollLines through the debounced commit
#   ss3  reload restores the slider from storage
#   ss4  wheel row-step on the terminal scrolls scrollLines rows
#   ss5  lens surface present (paste guard contract)
#   ss6  lens focusTypingSurface lands on the composer textarea
#
# Usage:
#   scripts/e2e/run-scroll-speed-mobile-e2e.sh [--keep]
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome DevTools port (default 9229)
#   CHROME_BIN   Chrome binary (default: chrome-headless-shell lookup)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9229}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-ss-mobile-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo"
REPO="$WORK/ss-mobile-repo"
mkdir -p "$REPO"
cat > "$REPO/README.md" <<'EOF'
# scroll speed fixture
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add README.md
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

echo "==> starting isolated server on http://127.0.0.1:$PORT"
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "ss-mob-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!

wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME="$(chrome_bin)"
echo "==> starting headless Chrome on CDP $CDP"
CHROME_PROFILE="$WORK/chrome-profile"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$CHROME_PROFILE" \
  --window-size=390,844 \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version" || {
  echo "chrome boot failed; stderr:" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
}

echo "==> running scroll speed mobile acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$REPO" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/scroll-speed-mobile-acceptance.mjs" "$WORK/ss_mobile_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> scroll speed mobile acceptance: PASSED"
else
  echo "==> scroll speed mobile acceptance: FAILED" >&2
  [[ -f "$WORK/ss_mobile_result.json" ]] && cat "$WORK/ss_mobile_result.json" >&2
fi

# The runner lib's cleanup honors the KEEP variable directly (trap on
# EXIT reads it); --keep just leaves it set. No extra handling needed.

exit $status
