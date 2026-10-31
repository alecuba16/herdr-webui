#!/usr/bin/env bash
# Real-browser acceptance for the filter-results tree keyboard navigation:
# Up/Down select, Left/Right collapse/expand, Enter activates, Tab moves
# between sections instead of walking tree rows.
#
# Boots an isolated herdr-webui + headless Chrome (never the user's running
# instance or profile), runs filter-tree-keyboard-acceptance.mjs, tears down.
# Same contract as run-keyboard-guards-e2e.sh.
#
# Usage: scripts/e2e/run-filter-tree-keyboard-e2e.sh [--keep]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9226}"
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
    [[ -x "$CHROME_BIN" ]] || { echo "ERROR: CHROME_BIN not executable" >&2; exit 1; }
    echo "$CHROME_BIN"; return 0
  fi
  local shell="$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  [[ -x "$shell" ]] && { echo "$shell"; return 0; }
  local app="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  [[ -x "$app" ]] && { echo "$app"; return 0; }
  echo "ERROR: no chrome-headless-shell or Google Chrome found; set CHROME_BIN." >&2
  exit 1
}
CHROME="$(chrome_bin)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-filter-tree-e2e.XXXXXX")"
SERVER_PID="" CHROME_PID="" AUDIT_PID=""

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
  stop_pid "$AUDIT_PID"
  stop_pid "$CHROME_PID"
  stop_pid "$SERVER_PID"
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
trap 'echo "run-filter-tree-keyboard-e2e.sh: interrupted" >&2; exit 130' INT TERM

echo "==> workdir: $WORK"
echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

REPO="$WORK/keyboard-repo"
mkdir -p "$REPO/src/ui/components" "$REPO/src/core"
cat > "$REPO/README.md" <<'EOF'
# readme
EOF
cat > "$REPO/src/ui/app.js" <<'EOF'
console.log("app");
EOF
cat > "$REPO/src/ui/components/button.js" <<'EOF'
console.log("button");
EOF
cat > "$REPO/src/core/engine.js" <<'EOF'
console.log("engine");
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add README.md src
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "filter-tree-e2e-$$" --backend-mode builtin &
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
export E2E_OUT="$WORK/filter-tree-keyboard-acceptance.json"

echo "==> filter-tree keyboard acceptance"
node "$ROOT/scripts/e2e/filter-tree-keyboard-acceptance.mjs" &
AUDIT_PID=$!
wait "$AUDIT_PID"

echo "==> filter-tree keyboard acceptance: PASSED"