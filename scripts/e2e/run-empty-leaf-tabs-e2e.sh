#!/usr/bin/env bash
# Live acceptance for the empty-leaf card vs file/Git pane tabs.
#
# Boots an isolated herdr-webui (own XDG_CONFIG_HOME, --session, and port; a
# user's running instance is never touched), a throwaway git repo, and its
# OWN headless Chrome on a private CDP port. Runs the empty-leaf-tabs probe
# against the real served app, then tears everything down.
#
# Usage:
#   scripts/e2e/run-empty-leaf-tabs-e2e.sh [--keep]   # --keep skips teardown
#
# Environment overrides:
#   E2E_PORT    server port   (default 8791)
#   CDP_PORT    chrome port   (default 9791)
#   CHROME_BIN  browser path  (default: first of
#                              ~/.agents/chrome-headless-shell/.../chrome-headless-shell,
#                              /Applications/Google Chrome.app/...)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8791}"
CDP="${CDP_PORT:-9791}"
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-empty-leaf-e2e.XXXXXX")"
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
  echo "run-empty-leaf-tabs-e2e.sh: interrupted, tearing down" >&2
  exit 130
}
trap on_signal INT TERM

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo"
REPO="$WORK/empty-leaf-repo"
mkdir -p "$REPO"
cat > "$REPO/README.md" <<'EOF'
# probe readme
EOF
git -C "$REPO" init -q -b main
git -C "$REPO" add README.md
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "empty-leaf-e2e-$$" --backend-mode builtin &
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

echo "==> opening the app in the headless browser"
# The probe attaches to a page target that already shows the app; the
# headless chrome starts on about:blank, so navigate it first via CDP.
node -e '
const http = require("http");
const url = process.argv[1];
http.get(url + "/json", (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const targets = JSON.parse(data);
    const page = targets.find((t) => t.type === "page");
    if (!page) { console.error("no page target"); process.exit(1); }
    const WebSocket = globalThis.WebSocket;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: process.argv[2] } }));
      setTimeout(() => process.exit(0), 1500);
    };
    ws.onerror = () => { console.error("ws error"); process.exit(1); };
  });
});
' "http://127.0.0.1:$CDP" "https://127.0.0.1:$PORT/"

status=0
echo "==> empty-leaf tabs acceptance probe"
export CDP_HTTP="http://127.0.0.1:$CDP"
export APP_URL="https://127.0.0.1:$PORT/"
export REPO
export NODE_TLS_REJECT_UNAUTHORIZED=0
node "$ROOT/scripts/e2e/empty-leaf-tabs-acceptance.mjs" "$WORK/empty_leaf_tabs_result.json" &
PROBE_PID=$!
if ! wait "$PROBE_PID" 2>/dev/null; then status=1; fi
PROBE_PID=""

cat "$WORK/empty_leaf_tabs_result.json" 2>/dev/null || true

if [[ $status -eq 0 ]]; then
  echo "==> empty-leaf tabs e2e: PASSED"
else
  echo "==> empty-leaf tabs e2e: FAILED" >&2
fi
exit $status