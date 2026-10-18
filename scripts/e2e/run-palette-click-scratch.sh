#!/usr/bin/env bash
# Scratch runner for the palette-click probe. Own ports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8914}"
CDP="${CDP_PORT:-9232}"

source "$ROOT/scripts/e2e/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-pclick-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "pclick-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!
wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME="$(chrome_bin)"
"$CHROME" --headless=new --remote-debugging-port="$CDP" --no-first-run \
  --no-default-browser-check --user-data-dir="$WORK/chrome-profile" \
  --window-size=1440,900 \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
wait_for "chrome CDP" "http://127.0.0.1:$CDP/json/version" || exit 1

APP_URL="http://127.0.0.1:$PORT/" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  node "$ROOT/scripts/e2e/palette-click-scratch.mjs" "$WORK/pclick_result.json"
exit $?