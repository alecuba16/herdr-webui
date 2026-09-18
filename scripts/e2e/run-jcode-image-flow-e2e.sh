#!/usr/bin/env bash
# Step-5 E2E runner: real jcode read-tool PNG through a real webui pane.
# Boots an isolated herdr-webui server + headless Chrome (desktop viewport),
# generates a test PNG, and runs the acceptance for BOTH terminal cores
# (ghostty renders the Kitty image, wterm substitutes the placeholder).
# The jcode debug server runs on an isolated JCODE_RUNTIME_DIR; the user's
# real jcode/herdr state is never touched. Cleans everything up on exit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8895}"
CDP="${CDP_PORT:-9340}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-jcodeflow.XXXXXX")"
CHROME_PID=""
SERVER_PID=""
cleanup() {
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  # The pane shell runs the jcode server as a child; killing the webui
  # server kills the pane PTY, which SIGHUPs the shell and its children.
  sleep 2
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

RUNTIME_DIR="$WORK/jcode-runtime"
mkdir -p "$RUNTIME_DIR"
# Small valid PNG (8x8 solid red) - generated locally, no dependencies.
python3 - "$WORK/test.png" <<'PY'
import struct, zlib, sys
def chunk(t, d):
    c = struct.pack('>I', len(d)) + t + d
    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
w = h = 8
ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
raw = b''.join(b'\x00' + bytes([255, 0, 0] * w) for _ in range(h))
png = b'\x89PNG\r\n\x1a\n' + ihdr + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
PY

XDG_CONFIG_HOME="$WORK/xdg" "$ROOT/target/debug/herdr-webui" \
  --bind "127.0.0.1:$PORT" --session "jcodeflow-$$" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 50); do curl -sfk "https://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.2; done

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --window-size=1600,1000 --remote-debugging-port="$CDP" --remote-allow-origins='*' \
  --user-data-dir="$WORK/profile" about:blank >/dev/null 2>&1 &
CHROME_PID=$!
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$CDP/json/version" >/dev/null && break; sleep 0.2; done

RC=0
for CORE in ghostty wterm; do
  # Per-core runtime dir: the pane runs `jcode serve` in the foreground,
  # which only dies with the pane; a second run on the same socket would
  # talk to the first run's still-live server (stale pane, wrong core).
  CORE_RUNTIME="$RUNTIME_DIR/$CORE"
  mkdir -p "$CORE_RUNTIME"
  echo "==> jcode image-flow acceptance on $CORE core"
  TERMINAL_CORE="$CORE" \
    E2E_BASE_URL="https://127.0.0.1:$PORT/" \
    CDP_PORT="$CDP" \
    JCODE_IMG_E2E_RUNTIME_DIR="$CORE_RUNTIME" \
    PNG_PATH="$WORK/test.png" \
    node "$ROOT/scripts/e2e/jcode-image-flow-acceptance.mjs" || RC=1
done
exit $RC