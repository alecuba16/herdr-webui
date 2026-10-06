#!/usr/bin/env bash
# Live keyboard-guard audit run for BOTH layouts (mobile + desktop).
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME and --session, a user's
# running instance is never touched), a throwaway git repo with staged
# changes (the commit modal needs them), and its OWN headless Chrome on a
# private CDP port. Then runs the mobile and the desktop CDP audit scripts
# against the real served app and tears everything down.
#
# Unlike run-git-e2e.sh this needs a browser for CDP, so it also launches
# chrome-headless-shell (or Google Chrome) itself. It never touches a CDP
# port that is already in use.
#
# Usage:
#   scripts/e2e/run-keyboard-guards-e2e.sh [--keep]   # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT    server port   (default 8897)
#   CDP_PORT    chrome port   (default 9224)
#   CHROME_BIN  browser path  (default: first of
#                              ~/.agents/chrome-headless-shell/.../chrome-headless-shell,
#                              /Applications/Google Chrome.app/...)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8897}"
CDP="${CDP_PORT:-9224}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q .; }

# A leftover instance from a previous --keep run would answer the health
# check and the run would silently test the stale build. Fail fast instead.
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-guards-e2e.XXXXXX")"
SERVER_PID="" CHROME_PID=""

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
  stop_pid "$CHROME_PID"
  stop_pid "$SERVER_PID"
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo with staged changes"
REPO="$WORK/guards-repo"
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
# STAGED change: the desktop commit modal (title + body) only mounts when
# hasStagedChanges(view) is true, and the audit live-checks those inputs.
echo "// staged" >> "$REPO/src/app.js"
git -C "$REPO" add src/app.js

mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "guards-e2e-$$" --backend-mode builtin &
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
  about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
if ! wait_for "chrome cdp" "http://127.0.0.1:$CDP/json"; then
  echo "--- chrome stderr ---" >&2
  cat "$WORK/chrome.log" >&2 || true
  exit 1
fi

export E2E_ORIGIN="https://127.0.0.1:$PORT"
export CDP_PORT="$CDP"
export E2E_REPO="$REPO"
export NODE_TLS_REJECT_UNAUTHORIZED=0

status=0
echo "==> mobile keyboard-guards audit"
node "$ROOT/scripts/e2e/keyboard-guards-audit-mobile.mjs" || status=1

echo "==> desktop keyboard-guards audit"
node "$ROOT/scripts/e2e/keyboard-guards-audit-desktop.mjs" || status=1

if [[ $status -eq 0 ]]; then
  echo "==> keyboard-guards audit: PASSED (mobile + desktop)"
else
  echo "==> keyboard-guards audit: FAILED" >&2
fi
exit $status