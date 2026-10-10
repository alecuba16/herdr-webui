#!/usr/bin/env bash
# Real-DOM acceptance for the MOBILE client side of the terminal-decoupling
# feature (update_windows batch). Own isolated server (8899) and own
# chrome-headless (CDP 9227) so the mobile run never inherits desktop
# workspaces from a shared server. Forces the mobile layout, then drives
# the real mobile bundle with real clicks only:
#
#   tm1  the Worktrees screen's recents Open button posts open_terminal
#        from the real option store (default off)
#   tm2  opening lands on the zero-tab workspace terminal screen
#        (No terminal selected)
#   tm3  the settings Workspaces section renders the Open terminal with
#        workspace checkbox, unchecked by default
#   tm4  New panel in the Panels sheet mints a live panel
#   tm5  Close current panel (custom confirm sheet, real Confirm click)
#        returns to No terminal selected while the workspace stays alive
#
# Usage:
#   scripts/e2e/run-terminal-decouple-mobile-e2e.sh [--keep]
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome DevTools port (default 9227)
#   CHROME_BIN   Chrome binary (default: chrome-headless-shell lookup)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9227}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-td-mobile-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo"
REPO="$WORK/td-mobile-repo"
mkdir -p "$REPO"
cat > "$REPO/README.md" <<'EOF'
# mobile fixture
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
  --https off --bind "127.0.0.1:$PORT" --session "td-mob-e2e-$$-$(date +%s)" --backend-mode builtin &
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

echo "==> running mobile terminal-decouple acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$REPO" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/terminal-decouple-mobile-acceptance.mjs" "$WORK/td_mobile_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> mobile terminal-decouple acceptance: PASSED"
else
  echo "==> mobile terminal-decouple acceptance: FAILED" >&2
  [[ -f "$WORK/td_mobile_result.json" ]] && cat "$WORK/td_mobile_result.json" >&2
fi
exit $status