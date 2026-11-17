#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多输入源：Signal key、SourceManager 配置与状态单测（不启动 HTTP/采样线程）。"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace

import scope_server

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class MultiSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="motorscope-src-")
        self.old_ws = scope_server.WORKSPACE_PATH
        scope_server.WORKSPACE_PATH = os.path.join(self.tmp, "workspace.json")
        args = SimpleNamespace(
            project=PROJECT_ROOT,
            axf=os.path.join(PROJECT_ROOT, "MDK", "Objects", "DR2159.axf"),
            header="", signals=os.path.join(PROJECT_ROOT, "signals.json"),
            openocd="", iface="", target="", verbose=False, rate=100.0,
            record_cache_dir=None, no_record_cache=True,
            record_cache_limit_mb=1, record_cache_block_points=100,
        )
        self.app = scope_server.App(args)
        self.app.source = None
        # 测试不能改真实 profiles/<id>/sampler.json
        self.app.save_sampler_config = lambda *a, **k: None
        self.app.manager._save_legacy_primary = lambda: None

    def tearDown(self) -> None:
        scope_server.WORKSPACE_PATH = self.old_ws
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_migrates_one_source(self) -> None:
        self.assertEqual(len(self.app.manager.sources), 1)
        inst = self.app.manager.primary()
        self.assertIsNotNone(inst)
        self.assertTrue(inst.signals)
        self.assertTrue(all(s.key.startswith(inst.id + "::") for s in inst.signals))
        self.assertEqual(self.app.sampler.signals[0].source, inst.id)

    def test_two_sources_config_and_status(self) -> None:
        res = self.app.manager.add_source({
            "label": "辅助源", "kind": "sim", "profile": "N32G003", "rate": 50,
        })
        self.assertTrue(res["ok"])
        sid = res["source"]["id"]
        self.assertNotEqual(sid, self.app.manager.primary_id)
        signals = [
            {"id": "motor.over.current", "source": "default",
             "addr": 0x20000352, "size": 2, "unit": "counts"},
            {"id": "lcd.page", "source": sid,
             "addr": 0x20000000, "size": 4, "unit": ""},
        ]
        out = self.app.apply_config({
            "fusion_rate": 200,
            "sources": [{"id": "default", "rate": 200}, {"id": sid, "rate": 50}],
            "signals": signals,
        })
        self.assertTrue(out["ok"])
        self.assertEqual(len(self.app.sampler.signals), 2)
        self.assertEqual([s.key for s in self.app.sampler.signals],
                         ["default::motor.over.current", sid + "::lcd.page"])
        self.assertEqual([s.source for s in self.app.sampler.signals], ["default", sid])
        status = self.app.status_payload()
        self.assertEqual(len(status["sources"]), 2)
        self.assertEqual(status["fusion_rate"], 200.0)
        self.assertEqual(self.app.config_payload()["sources"][1]["id"], sid)
        # 同一份配置重复下发必须命中 unchanged，避免 config 回显循环
        again = self.app.apply_config({
            "fusion_rate": 200,
            "sources": [{"id": "default", "rate": 200}, {"id": sid, "rate": 50}],
            "signals": signals,
        })
        self.assertTrue(again.get("unchanged"))

    def test_legacy_config_goes_to_primary(self) -> None:
        out = self.app.apply_config({
            "rate": 100,
            "signals": [{"id": "legacy.sig", "addr": 0x20000010, "size": 4}],
        })
        self.assertTrue(out["ok"])
        self.assertEqual(len(self.app.sampler.signals), 1)
        self.assertEqual(self.app.sampler.signals[0].source, "default")
        self.assertEqual(self.app.sampler.signals[0].key, "default::legacy.sig")

    def test_signal_key_roundtrip(self) -> None:
        sig = scope_server.Signal({"id": "motor.rpm", "source": "mcu1",
                                   "addr": 0x20000000, "size": 4})
        self.assertEqual(sig.key, "mcu1::motor.rpm")
        d = sig.to_dict()
        again = scope_server.Signal(d)
        self.assertEqual(again.key, sig.key)
        self.assertEqual(again.source, "mcu1")
        self.assertEqual(again.id, "motor.rpm")


if __name__ == "__main__":
    unittest.main()
