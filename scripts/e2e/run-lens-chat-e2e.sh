#!/usr/bin/env bash
# End-to-end acceptance run for the structured chat lens (jcode
# transcript mode, phase 2).
#
# Boots an isolated herdr-webui with its OWN HOME (empty jcode store),
# creates a workspace, flips the pane to a jcode-labeled shell, reads
# the pane's real shell pid off the screen, then seeds a synthetic
# jcode session whose last_pid IS that shell pid — so resolution is
# deterministic (step 1: process-tree unique hit).
#
# Then drives the phase-2 contract in a real browser:
#   - switch visible on the jcode pane (design 6 gate)
#   - structured turns render from the seeded conversation
#   - thinking row + tool row shapes match the wire format
#   - in-place poll sync keeps expansion state across renders
#   - refusal shape (resolvable:false) keeps the switch visible and
#     shows the refusal copy
#   - zero socket churn across all of it
#
# Usage:
#   scripts/e2e/run-lens-chat-e2e.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8797}"
CDP="${CDP_PORT:-9227}"
# Scratch pinned to /tmp (see run-lens-e2e.sh for the detection trap),
# then resolved to its PHYSICAL path: on macOS /tmp is a symlink to
# /private/tmp, and the pane->session resolution string-compares the
# lsof-resolved live cwd (always physical) against the seeded
# working_dir. A logical /tmp seed path silently fails to match.
WORK="$(cd "$(mktemp -d "${HERDR_E2E_TMPDIR:-/tmp}/herdr-lens-chat-e2e.XXXXXX")" && pwd -P)"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

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
  [[ $KEEP -eq 1 ]] && { echo "--keep set: leaving $WORK running"; return; }
  stop_pid "${CHROME_PID:-}"
  stop_pid "${SERVER_PID:-}"
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
}
trap cleanup EXIT

echo "==> workdir: $WORK"
echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --quiet)

wait_for() {
  local desc="$1" url="$2"
  for i in $(seq 1 50); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

# Isolated HOME: the seeded jcode store lives under $WORK/home/.jcode.
mkdir -p "$WORK/home/.jcode/sessions" "$WORK/scratch-repo"

echo "==> starting isolated server on http://127.0.0.1:$PORT (own HOME)"
HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --backend-mode builtin --https off &
SERVER_PID=$!
wait_for "server" "http://127.0.0.1:$PORT/" || exit 1

CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  for c in \
    "$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    [[ -x "$c" ]] && CHROME_BIN="$c" && break
  done
fi
[[ -x "$CHROME_BIN" ]] || { echo "no Chrome/chrome-headless-shell found; set CHROME_BIN"; exit 2; }

echo "==> launching headless Chrome (CDP port $CDP)"
"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" || exit 1

echo "==> running structured chat lens acceptance checks"
E2E_BASE_URL="http://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  LENS_CHAT_STORE="$WORK/home/.jcode/sessions" \
  LENS_CHAT_REPO="$WORK/scratch-repo" \
  node "$ROOT/scripts/e2e/lens-chat-acceptance.mjs"
RC=$?

echo "==> acceptance exit: $RC"
exit $RC