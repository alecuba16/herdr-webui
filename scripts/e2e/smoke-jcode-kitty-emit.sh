#!/usr/bin/env bash
# Smoke test: run a real jcode debug server on an isolated runtime dir and
# invoke the real read tool on a PNG, capturing the server stdout. Verifies
# jcode picks the Kitty emitter from TERM_PROGRAM=ghostty and emits the
# chunked a=T,f=100 form. Never touches the user's real jcode/herdr state.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-jcodeimg.XXXXXX")"
SRV_PID=""
cleanup() {
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null || true
  sleep 1
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

export JCODE_RUNTIME_DIR="$WORK/runtime"
mkdir -p "$JCODE_RUNTIME_DIR"
# Mode: "emit" (default) proves jcode picks the Kitty emitter under the
# pane env; "noemit" is the negative control - without the TERM_PROGRAM
# hint the read tool must NOT write image escapes.
MODE="${SMOKE_MODE:-emit}"
export TERM_PROGRAM="$([[ "$MODE" == "emit" ]] && echo "ghostty" || echo "")"
export TERM="xterm-256color"
unset KITTY_WINDOW_ID || true

PNG="$WORK/test.png"
python3 - "$PNG" <<'PY'
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

# Run the real server in the foreground on a real PTY (pty_capture.py) so
# display_image's is_terminal() check passes and its stdout is captured -
# the same relationship a webui pane has to the server process.
python3 "$ROOT/scripts/e2e/pty_capture.py" "$WORK/server-out.raw" \
  env JCODE_DEBUG_CONTROL=1 /Users/alejandro.blanco/.local/bin/jcode serve --socket "$JCODE_RUNTIME_DIR/jcode.sock" &
SRV_PID=$!

# Wait for the debug socket (sibling of the main socket).
for i in $(seq 1 100); do
  [[ -S "$JCODE_RUNTIME_DIR/jcode-debug.sock" ]] && break
  sleep 0.2
done
[[ -S "$JCODE_RUNTIME_DIR/jcode-debug.sock" ]] || { echo "FAIL: debug socket never appeared"; tail -5 "$WORK/server-out.raw" 2>/dev/null || true; exit 1; }
echo "debug server up (pid $SRV_PID)"

# Create a session in the scratch dir, then run the real read tool.
/Users/alejandro.blanco/.local/bin/jcode debug create_session:"$WORK" || { echo "FAIL: create_session"; exit 1; }
/Users/alejandro.blanco/.local/bin/jcode debug "tool:read {\"file_path\": \"$PNG\"}" >"$WORK/read-out.json" 2>&1 || echo "(read tool rc=$?)"
echo "--- read tool output (first 300 chars) ---"
head -c 300 "$WORK/read-out.json"; echo

# Give the server a moment to flush, then inspect captured stdout bytes.
sleep 1
kill "$SRV_PID" 2>/dev/null || true
disown "$SRV_PID" 2>/dev/null || true
sleep 1
if grep -q $'\x1b_Ga=T,f=100' "$WORK/server-out.raw"; then
  if [[ "$MODE" == "noemit" ]]; then
    echo "KITTY EMIT found but mode=noemit expects none"
    echo "SMOKE: FAIL"
    exit 1
  fi
  echo "KITTY EMIT: found ESC_G a=T,f=100 chunk in server stdout"
  # Show the transmit header with the ESC byte rendered visibly.
  grep -ao $'\x1b_Ga=T[^;]*' "$WORK/server-out.raw" | head -1 | cat -v || true
  echo "SMOKE: PASS"
else
  if [[ "$MODE" == "noemit" ]]; then
    echo "KITTY EMIT correctly absent without TERM_PROGRAM hint"
    echo "SMOKE: PASS"
    exit 0
  fi
  echo "KITTY EMIT: NOT FOUND in server stdout"
  echo "--- raw stdout bytes (od, first 600) ---"
  od -c "$WORK/server-out.raw" 2>/dev/null | head -20 || echo "(no raw file)"
  echo "--- raw file size ---"
  wc -c "$WORK/server-out.raw" 2>/dev/null || true
  echo "--- capture tail (cat -v) ---"
  tail -c 300 "$WORK/server-out.raw" 2>/dev/null | cat -v || true
  echo "SMOKE: FAIL"
  exit 1
fi