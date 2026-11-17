#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""POST/GET /api/scan/id 的核心逻辑单测（不启动 HTTP 服务）。"""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest import mock

from scope_server import App, SimSource

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ScanChipIdTest(unittest.TestCase):
    def setUp(self) -> None:
        args = SimpleNamespace(
            project=PROJECT_ROOT,
            axf=os.path.join(PROJECT_ROOT, "MDK", "Objects", "DR2159.axf"),
            header="", signals=os.path.join(PROJECT_ROOT, "signals.json"),
            openocd="", iface="", target="", verbose=False, rate=100.0,
            record_cache_dir=None, no_record_cache=True,
            record_cache_limit_mb=1, record_cache_block_points=100,
        )
        self.app = App(args)
        self.app.source = None

    def tearDown(self) -> None:
        try:
            self.app.source = None
        except Exception:
            pass

    def test_not_connected_without_autoconnect(self) -> None:
        res = self.app.scan_chip_id({}, auto_connect=False)
        self.assertFalse(res["ok"])
        self.assertFalse(res["connected"])
        self.assertIn("hint", res)

    def test_sim_source_returns_ok_without_chip(self) -> None:
        self.app.source = SimSource()
        res = self.app.scan_chip_id({}, auto_connect=False)
        self.assertTrue(res["ok"])
        self.assertTrue(res["connected"])
        self.assertFalse(res["autoconnect"])
        self.assertIsNone(res["chip"])       # 仿真源没有芯片 ID

    def test_autoconnect_failure_is_reported(self) -> None:
        with mock.patch.object(self.app, "connect",
                               side_effect=RuntimeError("no debugger")):
            res = self.app.scan_chip_id({}, auto_connect=True)
        self.assertFalse(res["ok"])
        self.assertFalse(res["connected"])
        self.assertTrue(res["autoconnect"])
        self.assertIn("no debugger", res["error"])

    def _fake_connect(self, payload):
        self.app.source = SimSource()
        return {"ok": True, "source": self.app.source.info()}

    def test_autoconnect_scans_then_disconnects(self) -> None:
        with mock.patch.object(self.app, "connect", side_effect=self._fake_connect):
            res = self.app.scan_chip_id({"mode": "sim"}, auto_connect=True)
        self.assertTrue(res["ok"])
        self.assertTrue(res["autoconnect"])
        self.assertFalse(res["connected"])   # 默认扫描后断开
        self.assertIsNone(self.app.source)

    def test_autoconnect_keep_connected(self) -> None:
        with mock.patch.object(self.app, "connect", side_effect=self._fake_connect):
            res = self.app.scan_chip_id(
                {"mode": "sim", "keep_connected": True}, auto_connect=True)
        self.assertTrue(res["ok"])
        self.assertTrue(res["connected"])
        self.assertTrue(res["kept_connected"])
        self.assertIsNotNone(self.app.source)


if __name__ == "__main__":
    unittest.main()
