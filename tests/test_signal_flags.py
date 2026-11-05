#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""API 侧 表/波/写 开关 + 一次性读（不进入采样）."""
import os
import sys
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from scope_server import App, SimSource  # noqa: E402

PROJECT_ROOT = os.path.dirname(HERE)


class SignalFlagsTest(unittest.TestCase):
    def setUp(self):
        args = SimpleNamespace(
            project=PROJECT_ROOT,
            axf=os.path.join(PROJECT_ROOT, "MDK", "Objects", "DR2159.axf"),
            header="", signals=os.path.join(PROJECT_ROOT, "signals.json"),
            openocd="", iface="", target="", verbose=False, rate=100.0,
        )
        self.app = App(args)
        self.app.source = SimSource()
        self.ids = [s.id for s in self.app.sampler.signals]
        self.assertTrue(self.ids)

    def tearDown(self):
        self.app.source = None

    def test_update_and_clear_flags(self):
        sid = self.ids[0]
        res = self.app.set_signal_flags(
            {"id": sid, "table": False, "plot": False, "write": False})
        self.assertTrue(res["ok"])
        self.assertEqual(res["flags"][sid],
                         {"table": False, "plot": False, "write": False})
        cfg = self.app.config_payload()
        self.assertTrue(cfg["ok"])
        self.assertIn(sid, cfg["signal_flags"])
        self.assertEqual(len(cfg["signals"]), len(self.ids))
        res = self.app.set_signal_flags({"id": sid, "clear": True})
        self.assertNotIn(sid, res["flags"])

    def test_read_is_one_shot_and_not_a_flag(self):
        sid = self.ids[0]
        res = self.app.set_signal_flags({"id": sid, "read": True})
        self.assertTrue(res["ok"])
        self.assertIn("read", res)
        self.assertTrue(res["read"]["ok"])
        self.assertNotIn(sid, res["flags"])  # read 不是持久开关
        # 采样通道没有被 read 改变
        self.assertEqual(len(self.app.sampler.signals), len(self.ids))

    def test_unknown_signal_rejected(self):
        res = self.app.set_signal_flags({"id": "no.such.signal", "plot": True})
        self.assertFalse(res["ok"])
        self.assertIn("未知信号", res["error"])


if __name__ == "__main__":
    unittest.main()
