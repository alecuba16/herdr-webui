#!/usr/bin/env bash
# One-off live check: spawn a builtin pane through the real served app and
# print the PTY's image-hint env (TERM_PROGRAM / KITTY_WINDOW_ID / TERM).
# Uses an isolated server + headless Chrome; cleans everything up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8894}"
CDP="${CDP_PORT:-9339}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-envcheck.XXXXXX")"
cleanup() {
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  sleep 1
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# Poison the server env the way a real iTerm launch would, to prove the
# scrub works in production conditions.
export TERM_PROGRAM="iTerm.app"
export KITTY_WINDOW_ID="999"

XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "envcheck-$$" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 50); do curl -sfk "https://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.2; done

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --window-size=1600,1000 --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/profile" about:blank >/dev/null 2>&1 &
CHROME_PID=$!
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$CDP/json/version" >/dev/null && break; sleep 0.2; done

E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" node "$ROOT/scripts/e2e/term_env_check.mjs"