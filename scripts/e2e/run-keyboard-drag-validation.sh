#!/usr/bin/env bash
# Validation runner for the keyboard + modal-drag work: boots an isolated
# herdr-webui (own XDG_CONFIG_HOME and --session; a user's running
# instance is never touched) and its OWN headless Chrome on a private CDP
# port, then runs keyboard-drag-validation.mjs against the real served
# app and tears everything down.
#
# Usage:
#   scripts/e2e/run-keyboard-drag-validation.sh [--keep]
#
# Environment overrides:
#   E2E_PORT    server port   (default 8898)
#   CDP_PORT    chrome port   (default 9225)
#   CHROME_BIN  browser path  (same lookup as run-keyboard-guards-e2e.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8898}"
CDP="${CDP_PORT:-9225}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q .; }
for p in "$PORT" "$CDP"; do
  if port_in_use "$p"; then
    echo "ERROR: port $p is already in use; kill the leftover e2e instance first." >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2 || true
    exit 1
  fi
done

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
CHROME="$(chrome_bin)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-kbd-drag-e2e.XXXXXX")"
SERVER_PID="" CHROME_PID="" PROBE_PID=""

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.4
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ $KEEP -eq 1 ]]; then echo "--keep set: leaving $WORK running"; return; fi
  stop_pid "$PROBE_PID"
  stop_pid "$CHROME_PID"
  stop_pid "$SERVER_PID"
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
on_signal() {
  echo "run-keyboard-drag-validation.sh: interrupted, tearing down" >&2
  exit 130
}
trap on_signal INT TERM

echo "==> workdir: $WORK"
echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

# A real git repo as the default folder: the search panel's file/content
# sections and the git surface need a repository to render rows.
REPO="$WORK/validation-repo"
mkdir -p "$REPO/src"
printf '# readme\n' > "$REPO/README.md"
printf 'console.log("hello");\n' > "$REPO/src/app.js"
git -C "$REPO" init -q -b main
git -C "$REPO" add README.md src/app.js
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init
printf '// staged\n' >> "$REPO/src/app.js"
git -C "$REPO" add src/app.js

mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<EOF
{ "localhost_no_auth": true, "default_folder": "$REPO" }
EOF

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "kbd-drag-e2e-$$" --backend-mode builtin &
SERVER_PID=$!

wait_for() {
  local desc="$1" url="$2"
  for _ in $(seq 1 50); do
    if curl -sf -k "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}
wait_for "server" "https://127.0.0.1:$PORT/" || exit 1

echo "==> starting headless chrome on CDP port $CDP"
"$CHROME" --headless=new --remote-debugging-port="$CDP" \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/chrome-profile" --ignore-certificate-errors \
  --window-size=1400,900 \
  about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
if ! wait_for "chrome cdp" "http://127.0.0.1:$CDP/json"; then
  echo "--- chrome stderr ---" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
fi

export APP_URL="https://127.0.0.1:$PORT/"
export CDP_HTTP="http://127.0.0.1:$CDP"
export E2E_REPO="$REPO"
export NODE_TLS_REJECT_UNAUTHORIZED=0

echo "==> keyboard + drag validation probe"
node "$ROOT/scripts/e2e/keyboard-drag-validation.mjs" "$WORK/validation_result.json" &
PROBE_PID=$!
status=0
wait "$PROBE_PID" 2>/dev/null || status=1

if [[ $status -eq 0 ]]; then
  echo "==> keyboard + drag validation: PASSED"
else
  echo "==> keyboard + drag validation: FAILED" >&2
fi
exit $status
