#!/usr/bin/env python3
"""Run a command on a real PTY and capture everything the child writes.

macOS `script -q file` flushes the transcript file only on clean exit, which
makes captured byte checks racy when the harness kills the server. This
wrapper reads the PTY master until EOF and writes bytes incrementally.

Usage: pty_capture.py <outfile> <cmd> [args...]
"""
import os
import pty
import select
import sys
import signal


def main() -> int:
    outfile, cmd, *args = sys.argv[1:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(cmd, [cmd, *args])
        os._exit(127)
    with open(outfile, "wb") as out:
        while True:
            try:
                r, _, _ = select.select([master], [], [], 0.5)
            except InterruptedError:
                continue
            if master in r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                out.write(data)
                out.flush()
            elif os.waitpid(pid, os.WNOHANG)[0] != 0:
                # Drain any remaining output then stop.
                while True:
                    r, _, _ = select.select([master], [], [], 0.2)
                    if master not in r:
                        break
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    out.write(data)
                break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())