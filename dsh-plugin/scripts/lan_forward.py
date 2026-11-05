#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-lan-forward.py — 独立的 TCP 转发器.

DSH 侧栏插件在需要局域网共享时启动本脚本：
    0.0.0.0:<port>  ->  127.0.0.1:<target-port>

它只转发 HTTP/SSE 字节流，不碰 scope_server.py 进程/采样器；
开/关共享只需要启动/停止本进程，不会重启 MotorScope。
首次在 Windows 上监听 0.0.0.0 时，Windows 防火墙会询问是否允许 python.exe。

--port 0 时由系统选空闲端口，实际端口写入 --ready-file，供插件显示 IP:端口。
"""
from __future__ import annotations

import argparse
import os
import socket
import socketserver
import threading


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        for sock in (src, dst):
            try:
                sock.close()
            except OSError:
                pass


class _Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        try:
            upstream = socket.create_connection(
                (self.server.target_host, self.server.target_port), timeout=5.0)
        except OSError:
            return
        thread = threading.Thread(target=_pipe, args=(upstream, self.request), daemon=True)
        thread.start()
        _pipe(self.request, upstream)


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description="MotorScope LAN TCP forwarder")
    ap.add_argument("--listen", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--target-host", default="127.0.0.1")
    ap.add_argument("--target-port", type=int, required=True)
    ap.add_argument("--ready-file", default="")
    args = ap.parse_args()

    server = _Server((args.listen, args.port), _Handler)
    server.target_host = args.target_host
    server.target_port = args.target_port
    actual_port = int(server.server_address[1])

    if args.ready_file:
        try:
            with open(args.ready_file, "w", encoding="utf-8") as fh:
                fh.write(str(actual_port))
        except OSError:
            pass

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if args.ready_file:
            try:
                os.unlink(args.ready_file)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
