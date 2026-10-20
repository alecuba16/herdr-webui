#!/usr/bin/env bash
# Boots an isolated herdr-webui + headless chrome over a fixture repo with
# a large tree, then runs expand-scroll-repro.mjs to measure what happens
# to the scroll position and the clicked dir row when a folder expands.
# Same isolation contract as run-keyboard-guards-e2e.sh: own XDG_CONFIG_HOME,
# --session, temp workdir, nothing touches a user instance.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8901}"
CDP="${CDP_PORT:-9225}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/expand-repro.XXXXXX")"
KEEP="${KEEP:-0}"
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
  echo "chrome-headless-shell not found" >&2
  return 1
}

cleanup() {
  if [[ $KEEP -eq 1 ]]; then echo "--keep: leaving $WORK"; return; fi
  [[ -n "$CHROME_PID" ]] && kill -9 "$CHROME_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

CHROME="$(chrome_bin)"

# fixture: 40 dirs x 20 files => a tree long enough to scroll hard
REPO="$WORK/huge-repo"
mkdir -p "$REPO"
for d in $(seq 1 40); do
  mkdir -p "$REPO/dir-$d/nested"
  for f in $(seq 1 20); do
    echo "file $f" > "$REPO/dir-$d/file-$f.txt"
  done
done
echo "# huge" > "$REPO/README.md"

mkdir -p "$WORK/xdg/herdr-webui"
cat > "$WORK/xdg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true }
EOF

echo "==> server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "expand-repro-$$" --backend-mode builtin &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf -k "https://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "==> chrome on CDP $CDP"
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
export E2E_OUT="$WORK/expand-repro-result.json"
export NODE_TLS_REJECT_UNAUTHORIZED=0

echo "==> running repro"
node "$ROOT/scripts/e2e/expand-scroll-repro.mjs" && echo "REPRO: PASSED (no jump)" || echo "REPRO: FAILED (jump observed)"
cp "$WORK/expand-repro-result.json" "$ROOT/.expand-repro-result.json" 2>/dev/null || true
cat "$ROOT/.expand-repro-result.json" 2>/dev/null || true