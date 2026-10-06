#!/usr/bin/env python3
"""Send input bytes to a pane over the terminal socket (protocol 22).

bincode::config::standard() = little-endian + VARINT for integer lengths.
Handshake: TerminalHello -> Welcome -> AttachTerminal -> Input.

Usage: send_pane_input.py <client-socket> <terminal-id> <TEXT:...|HEX:...>
"""
import socket
import struct
import sys


def varint(n: int) -> bytes:
    # bincode 2 varint: LEB128-ish, groups of 7 bits, little-endian order,
    # continuation bit 0x80. Encodes the raw integer (zigzag NOT applied).
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def frame(body: bytes) -> bytes:
    return varint(len(body)) if False else struct.pack("<I", len(body)) + body


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("socket closed")
        buf += chunk
    return buf


def read_msg(sock):
    (length,) = struct.unpack("<I", recv_exact(sock, 4))
    return recv_exact(sock, length)


def main():
    sock_path, terminal_id = sys.argv[1], sys.argv[2]
    data_arg = sys.argv[3]
    if data_arg.startswith("TEXT:"):
        payload = data_arg[5:].encode()
    elif data_arg.startswith("HEX:"):
        payload = bytes.fromhex(data_arg[4:])
    else:
        payload = data_arg.encode()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect(sock_path)

    # TerminalHello: variant u32 varint, version u32 varint, cols u16 varint,
    # rows u16 varint, cell_width_px u32 varint, cell_height_px u32 varint,
    # pixel_mouse bool (1 byte)
    hello = (
        varint(0) + varint(22) + varint(100) + varint(30)
        + varint(0) + varint(0) + b"\x00"
    )
    sock.sendall(frame(hello))
    welcome = read_msg(sock)
    print("welcome frame:", len(welcome), "bytes")

    # AttachTerminal: variant 5, terminal_id String (u64 varint len + bytes),
    # takeover bool
    tid = terminal_id.encode()
    attach = varint(5) + varint(len(tid)) + tid + b"\x00"
    sock.sendall(frame(attach))
    resp = read_msg(sock)  # Terminal frame with full history
    print("attach resp:", len(resp), "bytes")

    # Input: variant 1, data Vec<u8> (u64 varint len + bytes)
    body = varint(1) + varint(len(payload)) + payload
    sock.sendall(frame(body))
    print(f"sent {len(payload)} bytes to {terminal_id}")
    sock.close()


if __name__ == "__main__":
    main()