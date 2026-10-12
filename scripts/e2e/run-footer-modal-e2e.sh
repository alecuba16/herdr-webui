#!/usr/bin/env bash
# Real-DOM acceptance for the merged footer Settings modal: single merged
# footer button, section rail with accent current, Help & Shortcuts first
# section, prefix-? deep link, search hiding help, Escape close, and the
# narrow-window chip rail with 44px targets. Boots an isolated
# herdr-webui (own XDG_CONFIG_HOME with localhost_no_auth, own session,
# own port 8896; the user's running instance on 8787 is never touched)
# plus chrome-headless on CDP 9224, then drives the real served bundle.
#
# Usage:
#   scripts/e2e/run-footer-modal-e2e.sh [--keep]     # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8896)
#   CDP_PORT     Chrome DevTools port (default 9224)
#   CHROME_BIN   Chrome binary (default: chrome-headless-shell lookup)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8896}"
CDP="${CDP_PORT:-9224}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-footer-modal-e2e.XXXXXX")"
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
  --https off --bind "127.0.0.1:$PORT" --session "footer-e2e-$$-$(date +%s)" --backend-mode builtin &
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

echo "==> running footer modal acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/footer-modal-acceptance.mjs" "$WORK/footer_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> footer modal acceptance: PASSED"
else
  echo "==> footer modal acceptance: FAILED" >&2
  [[ -f "$WORK/footer_result.json" ]] && cat "$WORK/footer_result.json" >&2
fi
exit $status