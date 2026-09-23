#!/usr/bin/env bash
# End-to-end acceptance run for the desktop file explorer edit-mode rework.
#
# Boots an isolated herdr-webui (its own XDG_CONFIG_HOME and --session, so a
# user's running instance is never touched), drives the real UI in headless
# Chrome over CDP, then tears everything down.
#
# Usage:
#   scripts/e2e/run-e2e.sh [--keep]     # --keep skips teardown for debugging
#
# Environment overrides:
#   E2E_PORT     server port (default 8899)
#   CDP_PORT     Chrome remote debugging port (default 9222)
#   CHROME_BIN   path to Chrome/Chromium if not auto-detected
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
CDP="${CDP_PORT:-9222}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

session_id() {
  # Unique per run so two concurrent runs never share server state.
  printf 'e2e-%s-%s' "$$" "$(date +%s)"
}

stop_pid() {
  # The server ignores SIGTERM while in its bind-retry sleep; escalate to KILL.
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
  # Chrome's crash-updater can hold profile files briefly; retry the removal.
  for i in 1 2 3 4 5; do
    rm -rf "$WORK" 2>/dev/null && break
    sleep 1
  done
}
trap cleanup EXIT

echo "==> workdir: $WORK"

echo "==> building herdr-webui (debug)"
(cd "$ROOT" && cargo build --target-dir target --quiet)

echo "==> creating fixture repo with src/demo.py"
REPO="$WORK/accept-repo"
mkdir -p "$REPO/src"
cat > "$REPO/README.md" <<'EOF'
# readme
EOF
cat > "$REPO/src/demo.py" <<'EOF'
print('hello')
EOF
# Oversized text file (2 MB) for the A4 partial-preview acceptance checks.
node -e "require('fs').writeFileSync(process.argv[1], 'partial line\n'.repeat(262144))" "$REPO/src/big.log"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@local commit -qm init

# Stale external-session fixture: a known session row whose socket file is
# gone (backend crashed / kill -9). The session-ux acceptance checks verify
# that closing it succeeds instead of returning a 502 ENOENT error.
mkdir -p "$WORK/xdg/herdr/sessions/stale-probe"

# Dead-listener external-session fixture: a session whose socket file still
# exists but nobody accepts on it (backend crashed without unlinking its
# socket, e.g. kill -9). Closing it surfaces ECONNREFUSED ("Connection
# refused", macOS os error 61), not ENOENT, and must also close cleanly.
# Short name so the socket path stays under the 104-byte AF_UNIX limit even
# with long TMPDIRs.
mkdir -p "$WORK/xdg/herdr/sessions/dead-listener"
python3 - "$WORK/xdg/herdr/sessions/dead-listener/herdr.sock" <<'PYEOF'
import socket, sys
path = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.close()  # file remains, no listener -> connect gets ECONNREFUSED
print(f"dead-listener fixture socket at {path}")
PYEOF

# Second dead-listener fixture: the session-ux acceptance closes the first
# one via the row Close button (server close deletes the socket file and
# directory), and the follow-up check needs a fresh dead listener to close
# through the CURRENT-session button (closeCurrentSession). Still short for
# the sun_path limit.
mkdir -p "$WORK/xdg/herdr/sessions/dead-listener-2"
python3 - "$WORK/xdg/herdr/sessions/dead-listener-2/herdr.sock" <<'PYEOF'
import socket, sys
path = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.close()
print(f"dead-listener-2 fixture socket at {path}")
PYEOF

# Third dead-listener fixture: consumed by the MOBILE sessions-screen close
# check (the desktop current-session check closes dead-listener-2 and the
# server deletes its directory).
mkdir -p "$WORK/xdg/herdr/sessions/dead-listener-3"
python3 - "$WORK/xdg/herdr/sessions/dead-listener-3/herdr.sock" <<'PYEOF'
import socket, sys
path = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.close()
print(f"dead-listener-3 fixture socket at {path}")
PYEOF

# Fourth dead-listener fixture: consumed by the MOBILE row-close catch check.
# Unlike dead-listener-3 (real server close, success path), this row is closed
# with the close fetch stubbed to the legacy 400 error shape, pinning the
# client-side catch tolerance (old/proxied servers). The stub never reaches
# the server, so the row stays listed; that is realistic and asserted.
mkdir -p "$WORK/xdg/herdr/sessions/dead-listener-4"
python3 - "$WORK/xdg/herdr/sessions/dead-listener-4/herdr.sock" <<'PYEOF'
import socket, sys
path = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.close()
print(f"dead-listener-4 fixture socket at {path}")
PYEOF

wait_for() {
  # wait_for <desc> <url> [-k]
  local desc="$1" url="$2" kflag="$3"
  for i in $(seq 1 50); do
    if curl -sf $kflag "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

echo "==> starting isolated server on https://127.0.0.1:$PORT"
XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "$(session_id)" &
SERVER_PID=$!

wait_for "server" "https://127.0.0.1:$PORT/" -k || exit 1

echo "==> launching headless Chrome (CDP port $CDP)"
CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    [[ -x "$c" ]] && CHROME_BIN="$c" && break
  done
fi
[[ -x "$CHROME_BIN" ]] || { echo "no Chrome/Chromium found; set CHROME_BIN"; exit 2; }

"$CHROME_BIN" --headless=new --window-size=1600,1000 \
  --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/chrome-profile" about:blank &
CHROME_PID=$!
wait_for "headless Chrome CDP" "http://127.0.0.1:$CDP/json/version" "" || exit 1

echo "==> running acceptance checks"
ACCEPT_REPO="$REPO" E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/acceptance.mjs"

echo "==> running session UX acceptance checks"
E2E_BASE_URL="https://127.0.0.1:$PORT/" CDP_PORT="$CDP" \
  node "$ROOT/scripts/e2e/session-ux-acceptance.mjs"