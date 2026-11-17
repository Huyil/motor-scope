#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""断开时的 socket 收尾：不要把 WinError 10038 当成源故障。"""
import os
import socket
import sys
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import ocd  # noqa: E402
import scope_server  # noqa: E402


class FakeSocket:
    def __init__(self, error=None):
        self.error = error
        self.sent = []
        self.closed = False

    def sendall(self, data):
        if self.error:
            raise self.error

    def recv(self, n):
        if self.error:
            raise self.error
        return b""

    def settimeout(self, t):
        pass

    def close(self):
        self.closed = True


class TclClientCloseTest(unittest.TestCase):
    def test_command_after_close_is_clean(self):
        c = ocd.TclClient()
        c.close()
        with self.assertRaises(ocd.OcdError) as cm:
            c.command("x")
        self.assertIn("断开", str(cm.exception))

    def test_send_on_closed_socket_is_clean(self):
        c = ocd.TclClient()
        c._sock = FakeSocket(OSError(10038, "not a socket"))
        with self.assertRaises(ocd.OcdError) as cm:
            c.command("x")
        self.assertIn("断开", str(cm.exception))
        self.assertNotIn("10038", str(cm.exception))

    def test_recv_reset_is_clean(self):
        c = ocd.TclClient()
        c._sock = FakeSocket(OSError(10054, "connection reset"))
        with self.assertRaises(ocd.OcdError) as cm:
            c.command("x")
        self.assertIn("断开", str(cm.exception))

    def test_other_oserror_keeps_detail(self):
        c = ocd.TclClient()
        c._sock = FakeSocket(OSError(10060, "timeout"))
        with self.assertRaises(ocd.OcdError) as cm:
            c.command("x")
        self.assertIn("TCL 通信失败", str(cm.exception))

    def test_close_swallows_bad_socket(self):
        c = ocd.TclClient()
        c._sock = FakeSocket(OSError(10038, "not a socket"))
        c.close()  # 不应抛
        self.assertFalse(c.connected)


class SourceCloseTest(unittest.TestCase):
    def test_openocd_close_marks_closed(self):
        stopped = []
        proc = SimpleNamespace(stop=lambda: stopped.append(1))
        src = scope_server.OpenOcdSource(proc, SimpleNamespace(connected=True))
        src.riscv = False
        src.close()
        self.assertTrue(src.closed)
        self.assertEqual(stopped, [1])

    def test_attached_close_marks_closed(self):
        closed = []
        client = SimpleNamespace(close=lambda: closed.append(1))
        src = scope_server.AttachedSource(client, "127.0.0.1", 6666)
        src.close()
        self.assertTrue(src.closed)
        self.assertEqual(closed, [1])


class AggregateDisconnectTest(unittest.TestCase):
    def _inst(self):
        inst = scope_server.SourceInstance("s1", "S1")
        inst.connected = True
        inst.error = ""
        return inst

    def test_closed_backend_error_not_reported(self):
        inst = self._inst()
        inst.last_values = {"x": 123}

        class Backend(scope_server.Source):
            closed = False

            def read(self, signals):
                raise OSError(10038, "not a socket")

        backend = Backend()
        backend.closed = True
        inst.backend = backend
        agg = scope_server.AggregateSource(SimpleNamespace(
            sources={"s1": inst},
            app=SimpleNamespace(sampler=SimpleNamespace(epoch=0.0)),
        ))
        out = agg._read_one(inst, [SimpleNamespace(key="x")])
        self.assertEqual(out, [123])
        self.assertEqual(inst.error, "")

    def test_live_backend_error_still_reported(self):
        inst = self._inst()
        inst.last_values = {"x": 123}

        class Backend(scope_server.Source):
            def read(self, signals):
                raise OSError(10060, "timeout")

        inst.backend = Backend()
        agg = scope_server.AggregateSource(SimpleNamespace(
            sources={"s1": inst},
            app=SimpleNamespace(sampler=SimpleNamespace(epoch=0.0)),
        ))
        out = agg._read_one(inst, [SimpleNamespace(key="x")])
        self.assertEqual(out, [123])
        self.assertIn("10060", inst.error)

    def test_disconnect_clears_old_error(self):
        inst = self._inst()
        inst.error = "old error"
        inst.backend = SimpleNamespace(close=lambda: None, closed=True)
        app = SimpleNamespace(source=None, add_log=lambda line: None)
        mgr = scope_server.SourceManager.__new__(scope_server.SourceManager)
        mgr.app = app
        scope_server.SourceManager._disconnect_instance(mgr, inst)
        self.assertEqual(inst.error, "")
        self.assertFalse(inst.connected)


if __name__ == "__main__":
    unittest.main()
