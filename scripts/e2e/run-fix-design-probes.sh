#!/usr/bin/env bash
# Boots the isolated stack and runs fix-design-probes.mjs (V15-V17: baseline
# re-measure, 3.1 CSS injection, 3.2 row-anchored restore wrapper).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8941}"
CDP="${CDP_PORT:-9281}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/expand-fixdesign.XXXXXX")"
KEEP="${KEEP:-0}"
SERVER_PID=""
CHROME_PID=""

chrome_bin() {
  if [[ -n "${CHROME_BIN:-}" ]]; then
    [[ -x "$CHROME_BIN" ]] || { echo "CHROME_BIN not executable" >&2; return 1; }
    echo "$CHROME_BIN"; return 0
  fi
  local shell="$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  [[ -x "$shell" ]] && { echo "$shell"; return 0; }
  echo "chrome-headless-shell not found" >&2; return 1
}

cleanup() {
  if [[ $KEEP -eq 1 ]]; then echo "--keep: leaving $WORK"; return; fi
  [[ -n "$CHROME_PID" ]] && kill -9 "$CHROME_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

CHROME="$(chrome_bin)"

REPO="$WORK/huge-repo"
mkdir -p "$REPO"
for d in $(seq 1 200); do
  mkdir -p "$REPO/dir-$d/nested"
  for f in $(seq 1 20); do
    echo "file $f" > "$REPO/dir-$d/file-$f.txt"
  done
done
echo "# huge" > "$REPO/README.md"

mkdir -p "$WORK/xdg/herdr-webui"
printf '{ "localhost_no_auth": true }' > "$WORK/xdg/herdr-webui/webui-settings.json"

XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "expand-fixdesign-$$" --backend-mode builtin &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf -k "https://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.2
done

"$CHROME" --headless=new --remote-debugging-port="$CDP" \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/chrome-profile" --ignore-certificate-errors \
  about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$CDP/json" >/dev/null 2>&1 && break
  sleep 0.2
done

export E2E_ORIGIN="https://127.0.0.1:$PORT"
export CDP_PORT="$CDP"
export E2E_REPO="$REPO"
export NODE_TLS_REJECT_UNAUTHORIZED=0

node "$ROOT/scripts/e2e/fix-design-probes.mjs"
