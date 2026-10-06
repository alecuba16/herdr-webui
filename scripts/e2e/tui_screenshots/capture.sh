#!/usr/bin/env bash
# capture.sh <name> - screenshot the big iTerm2 window (CGWindowID env override)
set -euo pipefail
NAME="${1:?usage: capture.sh <name>}"
OUT="$HOME/Downloads/screenshots/$NAME.png"
WINID="${HERDR_TUI_WINID:-}"
if [ -z "$WINID" ]; then
  WINID=$(swift /tmp/getwin.swift 2>/dev/null | awk -F'|' '$3 ~ /1084/ {print $1; exit}')
fi
if [ -z "$WINID" ]; then echo "no window id"; exit 1; fi
screencapture -x -l "$WINID" -o "$OUT"
echo "captured $OUT"
