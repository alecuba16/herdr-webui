"""Live pty visual check of the overlay depth effect.

Runs the real binary against the real 8787 session in a pty, drives it
with pyte (true screen model) and asserts on the rendered cells: dimmed
backdrop, shadow band, accent border.

Read-only against the live session: the TUI only opens overlays and
closes them, no mutations are sent.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

import pyte

BIN = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else "target/debug/herdr-webui-tui"
COLS, ROWS = 110, 30


def launch():
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["HERDR_WEBUI_TUI_API"] = "http://127.0.0.1:8787"
        os.environ["TERM"] = "xterm-256color"
        os.execv(BIN, [BIN])
        os._exit(1)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return pid, fd


def read_all(fd, stream, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        stream.feed(chunk.decode("utf-8", "replace"))
    return True


def send(fd, data):
    os.write(fd, data)
    time.sleep(0.5)


def dump(screen, y):
    return screen.display[y] if y < len(screen.display) else ""


def fg_at(screen, x, y):
    c = screen.buffer[y][x]
    rgb = c.fg and str(c.fg)
    return f"fg={rgb} bg={c.bg} char={c.data!r}"


def main():
    pid, fd = launch()
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream()
    stream.attach(screen)
    alive = read_all(fd, stream, timeout=4.0)
    failures = []

    def check(name, cond, detail=""):
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {name}" + (f"  {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    try:
        # Baseline: capture footer color before overlay (undimmed).
        base_footer_fg = screen.buffer[ROWS - 1][5].fg
        print(f"baseline footer fg at (5,{ROWS-1}): {base_footer_fg}")

        # 1. Open help overlay.
        send(fd, b"?")
        read_all(fd, stream, 2.0)
        help_top = next((y for y in range(ROWS) if "Herdr WebUI TUI" in dump(screen, y)), None)
        check("help overlay rendered", help_top is not None)
        # The title sits inside the top border: locate the overlay's own
        # border row by its title text, not by the first corner glyph
        # (sidebar panels share the row when the overlay is full-height).
        border_row = next((y for y in range(ROWS) if "Help · ? closes" in dump(screen, y)), None)
        check("help border row found", border_row is not None)
        x0 = dump(screen, border_row).index("Help · ? closes") - 1
        x_right = x0 + dump(screen, border_row)[x0:].index("┐")
        # Border color = accent rgb(137,180,250) -> pyte "89b4fa".
        border_fg = screen.buffer[border_row][x0].fg
        check("border uses accent color", "89b4fa" in str(border_fg),
              f"got {border_fg} at x={x0}")

        # Backdrop dimming: footer text should now differ from baseline.
        dim_footer_fg = screen.buffer[ROWS - 1][5].fg
        check("backdrop dims the underlying screen", str(dim_footer_fg) != str(base_footer_fg),
              f"base={base_footer_fg} dim={dim_footer_fg}")

        # Shadow band: one cell right of the overlay's right corner.
        y_mid = border_row + 3
        shadow_cell = screen.buffer[y_mid][x_right + 1]
        check("shadow band painted right of border",
              shadow_cell.data == " " and str(shadow_cell.bg) not in ("default", "None"),
              f"cell: {shadow_cell.data!r} bg={shadow_cell.bg}")

        # Close.
        send(fd, b"?")
        read_all(fd, stream, 2.0)
        restored_fg = screen.buffer[ROWS - 1][5].fg
        check("backdrop restored on close", str(restored_fg) == str(base_footer_fg),
              f"base={base_footer_fg} after={restored_fg}")

        # 2. Settings overlay: prefix s (Ctrl+B then s).
        send(fd, b"\x02s")
        read_all(fd, stream, 2.0)
        set_border = next((y for y in range(ROWS) if "Settings · Esc closes" in dump(screen, y)), None)
        check("settings overlay rendered", set_border is not None)
        if set_border is not None:
            x0s = dump(screen, set_border).index("┌")
            check("settings border found", x0s is not None)
            sb = screen.buffer[set_border][x0s].fg
            check("settings border accent", "89b4fa" in str(sb), f"got {sb}")
            # shadow band right of the settings box
            x_rights = dump(screen, set_border).index("┐")
            sc = screen.buffer[set_border + 3][x_rights + 1]
            check("settings right shadow band",
                  sc.data == " " and str(sc.bg) not in ("default", "None"),
                  f"char={sc.data!r} bg={sc.bg}")
        send(fd, b"\x1b")
        read_all(fd, stream, 2.0)

        # 3. Quit confirm overlay: q from Navigate on Terminal screen.
        send(fd, b"q")
        read_all(fd, stream, 2.0)
        q_top = next((y for y in range(ROWS) if "Quit herdr-webui-tui?" in dump(screen, y)), None)
        check("quit confirm rendered", q_top is not None)
        send(fd, b"n")
        read_all(fd, stream, 2.0)
        check("quit confirm dismissed with n", all("Quit herdr-webui-tui?" not in dump(screen, y) for y in range(ROWS)))
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.3)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(fd)
        except OSError:
            pass

    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        print("\n=== screen dump (help step) ===")
        for y in range(ROWS):
            print(dump(screen, y))
        sys.exit(1)
    print("ALL VISUAL CHECKS PASSED")


if __name__ == "__main__":
    main()