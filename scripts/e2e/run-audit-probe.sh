#!/usr/bin/env bash
# Boots the isolated stack and runs audit-probe.mjs: empirical verification
# of the perf/UX audit's top claims against the real served app (real
# server binary + chrome-headless-shell + real bundle over CDP). Own port,
# own XDG_CONFIG_HOME, own session id, own scratch repo: never touches the
# user's running instance. Usage: run-audit-probe.sh [--keep]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8957}"
CDP="${CDP_PORT:-9527}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-audit-probe.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1
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
  [[ $KEEP -eq 1 ]] && { echo "--keep: leaving $WORK"; return; }
  [[ -n "$CHROME_PID" ]] && kill -9 "$CHROME_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

CHROME="$(chrome_bin)"

# Fail fast if the fixture port is already taken: the probe's outage step
# SIGKILLs whatever listens on $PORT, so a pre-existing squatter would be
# an unrelated victim.
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "port $PORT busy; pick another via E2E_PORT" >&2
  exit 1
fi

# Fixture repo: git-init so workspace open works, few files so panel
# creation stays quick.
REPO="$WORK/probe-repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" -c user.email=probe@local -c user.name=probe commit -q --allow-empty -m init
echo "probe" > "$REPO/README.md"

mkdir -p "$WORK/xdg/herdr-webui"
printf '{ "localhost_no_auth": true }' > "$WORK/xdg/herdr-webui/webui-settings.json"

XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --https off \
  --bind "127.0.0.1:$PORT" \
  --session "audit-probe-$$" \
  --backend-mode builtin &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$PORT/" >/dev/null || { echo "server never ready" >&2; exit 1; }

"$CHROME" --headless=new --remote-debugging-port="$CDP" \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/chrome-profile" \
  "http://127.0.0.1:$PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$CDP/json" >/dev/null 2>&1 && break
  sleep 0.2
done

export APP_URL="http://127.0.0.1:$PORT/"
export CDP_HTTP="http://127.0.0.1:$CDP"
export REPO
export PROBE_OUT="${PROBE_OUT:-$HOME/.jcode/scratch/herdr-perf-ux-audit/probe/audit_probe_result.json}"

node "$ROOT/scripts/e2e/audit-probe.mjs"