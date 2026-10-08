#!/usr/bin/env bash
# Real-DOM acceptance for the reworked Git-log hover card.
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME with localhost_no_auth,
# own session, own port; the user's running instance is never touched) plus
# headless Chrome for Testing on CDP, then drives the real served bundle:
# labeled hover rows (Commit id / Tags / Author / Date), per-field copy
# commands, per-tag copy, copy toast, and the accent-2 selected-row
# background.
#
# Usage:
#   scripts/e2e/run-log-hover-e2e.sh [--keep]     # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome DevTools port (default 9224)
#   CHROME_BIN   Chrome for Testing binary (default: first found in the
#                usual per-OS locations)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9224}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# Shared runner boilerplate: chrome lookup, teardown, polling, port guard.
# shellcheck source=scripts/e2e/e2e-runner-lib.sh
source "$(dirname "$0")/e2e-runner-lib.sh"

fail_if_port_busy "$PORT" server || exit 1
fail_if_port_busy "$CDP" "CDP" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-log-hover-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""
trap runner_cleanup EXIT
trap runner_on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo with tags"
REPO="$WORK/log-hover-repo"
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
# Tagged HEAD so the hover card's Tags row has real chips to copy, plus a
# second tag so "one copy per tag" is observable.
git -C "$REPO" tag v1.0.0
git -C "$REPO" tag release-candidate
# A second, untagged commit so the tagless card shape is also exercised.
echo "// more" >> "$REPO/src/app.js"
git -C "$REPO" add src/app.js
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm "second commit"

echo "==> starting isolated server on http://127.0.0.1:$PORT"
mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off --bind "127.0.0.1:$PORT" --session "log-hover-e2e-$$-$(date +%s)" --backend-mode builtin &
SERVER_PID=$!

wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME="$(chrome_bin)"
echo "==> starting headless Chrome on CDP $CDP"
CHROME_PROFILE="$WORK/chrome-profile"
# --window-size gives the shell a real 1440x900 surface: the driver dispatches
# trusted mouse input at viewport coordinates (the log rows sit far right of
# the drawer), and input coordinates clamp to the actual surface, so a larger
# Emulation override alone is not enough.
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

echo "==> running log-hover acceptance checks"
set +e
APP_URL="http://127.0.0.1:$PORT/" REPO="$REPO" \
  CDP_HTTP="http://127.0.0.1:$CDP" \
  JCODE_SCRATCH_DIR="$WORK" \
  node "$ROOT/scripts/e2e/log-hover-acceptance.mjs" "$WORK/log_hover_result.json"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "==> log-hover acceptance: PASSED"
else
  echo "==> log-hover acceptance: FAILED" >&2
  [[ -f "$WORK/log_hover_result.json" ]] && cat "$WORK/log_hover_result.json" >&2
fi
exit $status