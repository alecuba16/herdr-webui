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

# A leftover instance from a previous --keep run would answer the health
# check and the run would silently test the stale build. Fail fast instead.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  echo "ERROR: port $PORT is already in use; kill the leftover e2e instance first." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi
if lsof -nP -iTCP:"$CDP" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  echo "ERROR: CDP port $CDP is already in use; kill the leftover Chrome first." >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-log-hover-e2e.XXXXXX")"
SERVER_PID=""
CHROME_PID=""

chrome_bin() {
  if [[ -n "${CHROME_BIN:-}" ]]; then
    if [[ ! -x "$CHROME_BIN" ]]; then
      echo "ERROR: CHROME_BIN='$CHROME_BIN' is not executable." >&2
      return 1
    fi
    echo "$CHROME_BIN"; return 0
  fi
  local shell="$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  if [[ -x "$shell" ]]; then echo "$shell"; return 0; fi
  local app="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$app" ]]; then echo "$app"; return 0; fi
  echo "ERROR: no chrome-headless-shell or Google Chrome found; set CHROME_BIN." >&2
  return 1
}

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
  [[ $KEEP -eq 1 ]] && { echo "--keep set: leaving $WORK running (server ${SERVER_PID:-none}, chrome ${CHROME_PID:-none})"; return; }
  stop_pid "${CHROME_PID}"
  stop_pid "${SERVER_PID}"
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# An EXIT trap alone does not fire on SIGTERM/SIGINT: `timeout` or Ctrl+C
# would leave the server and Chrome behind. Route these signals to the
# EXIT trap (same as run-keyboard-guards-e2e.sh).
on_signal() {
  echo "interrupted; tearing down" >&2
  exit 130
}
trap on_signal INT TERM

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

wait_for() {
  local desc="$1" url="$2"
  for i in $(seq 1 50); do
    if curl -sf -k "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}
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