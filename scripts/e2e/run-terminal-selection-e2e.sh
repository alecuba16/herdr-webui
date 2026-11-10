#!/usr/bin/env bash
# Real-browser acceptance for the terminal text-selection fix (drag select
# in a pane whose program enabled SGR mouse tracking, e.g. the jcode TUI).
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME with localhost_no_auth,
# own session, own port 8899; the user's running instance on 8787 is never
# touched) plus headless Chrome on CDP 9226, then drives the real served
# bundle through terminal-selection-acceptance.mjs:
#
#   S1: drag across terminal rows with reporting off must select text.
#   S2: reporting on (live setter) must restore wterm interception: no
#       native selection from the same drag.
#   S3: wheel with tracking on still forwards SGR bytes to the program.
#
# Usage:
#   scripts/e2e/run-terminal-selection-e2e.sh [--keep]    # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome DevTools port (default 9226)
#   CHROME_BIN   Chrome binary (default: chrome-headless-shell lookup)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9226}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-selection-probe.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo"
REPO="$WORK/selection-repo"
mkdir -p "$REPO"
cat > "$REPO/README.md" <<'EOF'
# selection probe
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
  --https off --bind "127.0.0.1:$PORT" --session "selection-probe-$$-$(date +%s)" --backend-mode builtin &
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

echo "==> running terminal selection acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$REPO" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/terminal-selection-acceptance.mjs" "$WORK/selection_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> terminal selection acceptance: PASSED"
else
  echo "==> terminal selection acceptance: FAILED" >&2
  [[ -f "$WORK/selection_result.json" ]] && cat "$WORK/selection_result.json" >&2
fi

if [[ $KEEP -eq 1 ]]; then
  echo "==> --keep: server ($SERVER_PID) and Chrome ($CHROME_PID) stay up; workdir $WORK"
  trap - EXIT
fi
exit $status
