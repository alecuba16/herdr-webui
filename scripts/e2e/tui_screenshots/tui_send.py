#!/usr/bin/env python3
"""Send keystrokes to the herdr TUI in iTerm2 tab 4 via `write text`.

Non-printable bytes are built with the AppleScript `ASCII character`
command so they reach the TUI unchanged.

Usage: tui_send.py <spec> [<spec> ...]
  ctrl+b etc, enter esc up down left right home end pgup pgdn tab btab bs
  del f1..f12, or plain text
"""
import subprocess
import sys

ESC = 27
CSI = chr(27) + "["
SEQ = {
    "enter": "\r",
    "esc": chr(27),
    "up": CSI + "A",
    "down": CSI + "B",
    "right": CSI + "C",
    "left": CSI + "D",
    "home": CSI + "H",
    "end": CSI + "F",
    "pgup": CSI + "5~",
    "pgdn": CSI + "6~",
    "del": CSI + "3~",
    "btab": CSI + "Z",
    "tab": "\t",
    "bs": chr(127),
}


def spec_to_text(spec: str) -> str:
    if spec.startswith("ctrl+"):
        ch = spec[5:].lower()
        if len(ch) != 1 or not ch.isalpha():
            raise SystemExit(f"bad ctrl combo: {spec}")
        return chr(ord(ch) - 96)
    if spec.startswith("f") and spec[1:].isdigit():
        n = int(spec[1:])
        return CSI + (f"{n + 11}~" if n < 10 else f"{20 + n}~")
    if spec in SEQ:
        return SEQ[spec]
    return spec


def apple_expr(s: str) -> str:
    """AppleScript string expression: literals for printables,
    (ASCII character N) for control bytes, concatenated with &."""
    parts = []
    lit = []
    for ch in s:
        code = ord(ch)
        printable = 32 <= code < 127 and ch not in ("\\", '"') or ch in ("\t", "\r") and False
        if printable:
            lit.append(ch)
        else:
            if lit:
                parts.append(apple_quote("".join(lit)))
                lit = []
            parts.append(f"(ASCII character {code})")
    if lit:
        parts.append(apple_quote("".join(lit)))
    return " & ".join(parts) if parts else '""'


def apple_quote(text: str) -> str:
    out = []
    for ch in text:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        else:
            out.append(ch)
    return f'"{" ".join(out)}"' if False else '"' + "".join(out) + '"'


def send(text: str):
    expr = apple_expr(text)
    script = (
        'tell application "iTerm2"\n'
        "  tell front window\n"
        "    tell (current session of tab 4)\n"
        f"      write text {expr} newline NO\n"
        "    end tell\n"
        "  end tell\n"
        "end tell"
    )
    subprocess.run(["osascript", "-e", script], check=True)


def main():
    for spec in sys.argv[1:]:
        send(spec_to_text(spec))


if __name__ == "__main__":
    main()
