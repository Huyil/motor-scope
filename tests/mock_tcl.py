#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal OpenOCD TCL-RPC mock for MotorScope tests.

Speaks just enough: commands terminated by 0x1a, reply terminated by 0x1a.
Supports the ms_read proc + read_memory used by ocd.py.
"""
import re
import socket
import sys
import threading
import time

DELIM = b"\x1a"


class Mem:
    def __init__(self):
        self.mem = {}
        for i in range(0, 0x1000):
            self.mem[i] = 0
        self.mem[0xE000ED00] = 0x410CC601
        self.t = 0.0
        self.lock = threading.Lock()

    def write32(self, addr, value):
        for i in range(4):
            self.mem[addr + i] = (value >> (8 * i)) & 0xFF

    def read32(self, addr):
        return sum(self.mem.get(addr + i, 0) << (8 * i) for i in range(4))

    def update(self):
        self.t += 0.05
        # motor.over.current @ 0x20000352, thresholdLast @ 0x20000354
        cur = int(800 + 300 * __import__("math").sin(self.t * 1.5))
        thr = 1188
        self.write32(0x20000350, 0x00000351)  # dummy
        self.mem[0x20000352] = cur & 0xFF
        self.mem[0x20000353] = (cur >> 8) & 0xFF
        self.mem[0x20000354] = thr & 0xFF
        self.mem[0x20000355] = (thr >> 8) & 0xFF


def handle(conn, mem):
    buf = b""
    with mem.lock:
        mem.update()
    while True:
        try:
            chunk = conn.recv(65536)
        except OSError:
            return
        if not chunk:
            return
        buf += chunk
        while DELIM in buf:
            cmd, _, buf = buf.partition(DELIM)
            text = cmd.decode("utf-8", "replace")
            out = dispatch(text, mem)
            try:
                conn.sendall(out.encode("utf-8", "replace") + DELIM)
            except OSError:
                return


def dispatch(text, mem):
    text = text.strip()
    if text.startswith("proc ms_read"):
        return ""
    m = re.match(r"ms_read\s+\{(.*)\}\s*$", text, re.S)
    if m:
        values = []
        for am, nm in re.findall(r"\{0x([0-9a-fA-F]+)\s+(\d+)\}", m.group(1)):
            addr = int(am, 16)
            count = int(nm)
            with mem.lock:
                mem.update()
                for i in range(count):
                    values.append(mem.read32(addr + i * 4))
        return " ".join(str(v) for v in values)
    m = re.match(r"read_memory\s+0x([0-9a-fA-F]+)\s+32\s+(\d+)", text)
    if m:
        addr, count = int(m.group(1), 16), int(m.group(2))
        with mem.lock:
            return " ".join(str(mem.read32(addr + i * 4)) for i in range(count))
    if text.startswith("version"):
        return "mock-openocd 0.1"
    return ""


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 6767
    mem = Mem()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(5)
    print("mock TCL on 127.0.0.1:%d" % port, flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn, mem), daemon=True).start()


if __name__ == "__main__":
    main()
