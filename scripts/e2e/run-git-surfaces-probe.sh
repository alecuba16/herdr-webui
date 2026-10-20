#!/usr/bin/env bash
# Boots the isolated stack with a git-history-heavy fixture and runs
# git-surfaces-probe.mjs (V25 git log, V26 git side tree), the same boot
# contract as run-expand-jump.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8971}"
CDP="${CDP_PORT:-9311}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/git-surfaces.XXXXXX")"
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

# Fixture: one repo with 120 commits (log page size is 80, so the log
# overflows the viewport and virtualization matters) plus a dirty tree
# with many staged/unstaged files so the changes side tree has sections
# with enough rows to overflow the side column.
REPO="$WORK/git-surfaces-repo"
mkdir -p "$REPO/src"
for i in $(seq 1 40); do
  echo "module $i" > "$REPO/src/mod-$i.js"
done
git -C "$REPO" init -q -b main
git -C "$REPO" add src
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init
for i in $(seq 1 120); do
  echo "// commit $i" >> "$REPO/src/mod-$(( (i % 40) + 1 )).js"
  git -C "$REPO" add src
  git -C "$REPO" -c user.name="author-$((i % 7))" -c user.email="a$i@local" commit -qm "commit $i"
done
# Dirty state for the side tree: 30 unstaged edits, 30 staged edits.
for i in $(seq 1 30); do
  echo "// unstaged $i" >> "$REPO/src/mod-$i.js"
  echo "// staged $i" >> "$REPO/src/mod-$((i + 5)).js"
done
git -C "$REPO" add src/mod-2*.js src/mod-3*.js 2>/dev/null || true

mkdir -p "$WORK/xdg/herdr-webui"
printf '{ "localhost_no_auth": true }' > "$WORK/xdg/herdr-webui/webui-settings.json"

XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "git-surfaces-$$" --backend-mode builtin &
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

node "$ROOT/scripts/e2e/git-surfaces-probe.mjs"
