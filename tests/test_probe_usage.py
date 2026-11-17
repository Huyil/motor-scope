#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多调试器占用：同一 serial 冲突提示 + USB 列表里的 used_by/in_use。"""
import os
import sys
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import scope_server  # noqa: E402


def source(sid, serial="", connected=True, label=""):
    inst = scope_server.SourceInstance(sid, label or sid)
    inst.connected = connected
    inst.kind = "openocd"
    inst.arch = "cw32"
    inst.profile = {"arch": "cw32"}
    inst.connection = {"serial": serial} if serial else {}
    return inst


class SerialConflictTest(unittest.TestCase):
    def _mgr(self, other):
        mgr = scope_server.SourceManager.__new__(scope_server.SourceManager)
        mgr.sources = {other.id: other}
        mgr.app = SimpleNamespace(source=None, add_log=lambda line: None,
                                  last_connect_error="")
        return mgr

    def test_same_serial_connected_is_rejected(self):
        other = source("s1", "ABC123")
        target = source("s2", "abc123", connected=False)
        mgr = self._mgr(other)
        mgr.sources[target.id] = target
        with self.assertRaises(RuntimeError) as cm:
            scope_server.SourceManager.connect_source(
                mgr, "s2", {"mode": "openocd"})
        self.assertIn("已被输入源", str(cm.exception))
        self.assertIn("s1", str(cm.exception))

    def test_disconnected_other_does_not_block(self):
        other = source("s1", "ABC123", connected=False)
        target = source("s2", "abc123", connected=False)
        mgr = self._mgr(other)
        mgr.sources[target.id] = target
        # 不应该在占用检查处抛；后续连接会因找不到 OpenOCD 之类失败，这里只验证
        # 不是“被占用”错误。
        with self.assertRaises(Exception) as cm:
            scope_server.SourceManager.connect_source(mgr, "s2", {"mode": "openocd"})
        self.assertNotIn("已被输入源", str(cm.exception))


class ProbeAnnotationTest(unittest.TestCase):
    def test_used_by_marks_matching_serial_case_insensitive(self):
        src = source("s1", "ABC123")
        data = {
            "supported": [
                {"serial": "abc123", "name": "H7"},
                {"serial": "other", "name": "WCH"},
            ]
        }
        app = SimpleNamespace(manager=SimpleNamespace(sources={"s1": src}))
        out = scope_server.App.annotate_probes(app, data)
        self.assertTrue(out["supported"][0]["in_use"])
        self.assertEqual(out["supported"][0]["used_by"], ["s1"])
        self.assertFalse(out["supported"][1]["in_use"])
        self.assertEqual(out["supported"][1]["used_by"], [])

    def test_no_manager_is_passthrough(self):
        data = {"supported": [{"serial": "x"}]}
        app = SimpleNamespace(manager=None)
        out = scope_server.App.annotate_probes(app, data)
        self.assertNotIn("in_use", out["supported"][0])


if __name__ == "__main__":
    unittest.main()
