#!/usr/bin/env bash
# Live-browser probe for the shortcut-chord surfaces (audit gap 1/3):
# boots an isolated herdr-webui plus headless Chrome, opens the search
# palette, and asserts the rendered action rows and the sidebar toggle
# tooltip carry the live configured chord (Ctrl+B then B / S) instead of
# the old fake "g s" hints. Also drives a prefix-run toggle to confirm the
# hint toast fires with the same chord.
#
# Mirrors run-search-ux-e2e.sh boot/teardown; own ports so it can run
# next to the other e2e suites. Never touches a user's running instance.
#
# Usage:
#   scripts/e2e/run-chord-hints-e2e.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8911}"
CDP="${CDP_PORT:-9229}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-chord-hints-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> starting isolated server on http://127.0.0.1:$PORT"
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "chord-hints-e2e-$$-$(date +%s)" --backend-mode builtin &
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

echo "==> running chord-hints acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/chord-hints-acceptance.mjs" "$WORK/chord_hints_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> chord-hints probe: PASSED"
else
  echo "==> chord-hints probe: FAILED (exit $status)" >&2
fi
exit $status