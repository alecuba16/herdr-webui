#!/usr/bin/env python3
"""Control-socket client for the TUI screenshots backend session.

Usage: control_client.py <socket> <method> [json-params]
"""
import json
import socket
import sys


def request(sock_path: str, method: str, params: dict):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(15)
    s.connect(sock_path)
    payload = json.dumps({"id": "shots", "method": method, "params": params})
    s.sendall(payload.encode() + b"\n")
    buf = b""
    while True:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            break
        if not chunk:
            break
        buf += chunk
        try:
            return json.loads(buf)
        except json.JSONDecodeError:
            continue
    if buf:
        return json.loads(buf)
    raise RuntimeError("no response from control socket")


def main():
    sock, method = sys.argv[1], sys.argv[2]
    params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    out = request(sock, method, params)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()