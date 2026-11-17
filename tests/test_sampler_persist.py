#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务端采样集持久化：sampler.json 优先、config.rows 兜底、变量地址重映射."""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace

import profiles
from scope_server import App, Hub, Sampler, Signal


class SamplerPersistTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="ms-sampler-persist-")
        self.app = object.__new__(App)
        self.app.profiles_root = self.tmp
        self.app.profile = {"id": "T"}
        self.app.args = SimpleNamespace(rate=100)
        self.app.catalog = {"variables": [
            {"name": "rpm", "addr": 0x20000000, "size": 4, "type": "uint32_t"},
        ]}
        self.app.sampler = Sampler(Hub())
        self.app.add_log = lambda msg: None

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_load_and_remap_variable_address(self) -> None:
        self.app.save_sampler_config(
            [Signal({"id": "rpm", "name": "rpm", "addr": 0x20000000,
                     "size": 4, "type": "uint32_t"})], 20)
        loaded = self.app.saved_sampler_config()
        self.assertEqual(len(loaded["signals"]), 1)
        self.assertEqual(loaded["rate"], 20)
        self.assertEqual(loaded["signals"][0].addr, 0x20000000)

        # 重新编译后变量地址变了，但 id 不变：应按当前符号表重映射
        self.app.catalog["variables"][0]["addr"] = 0x20000010
        loaded = self.app.saved_sampler_config()
        self.assertEqual(loaded["signals"][0].addr, 0x20000010)

    def test_restore_writes_sampler_json(self) -> None:
        self.app.restore_sampler_for_profile()
        path = self.app._sampler_state_path("T")
        self.assertTrue(os.path.isfile(path))
        loaded = self.app.saved_sampler_config()
        self.assertEqual([s.id for s in loaded["signals"]], ["rpm"])

    def test_history_after_future_cursor_resets(self) -> None:
        sampler = self.app.sampler
        sampler.set_signals([Signal({"id": "rpm", "addr": 0x20000000,
                                     "size": 4, "type": "uint32_t"})], 100)
        with sampler._cond:
            sampler.history.clear()
            sampler.history.extend([[1000.0, [7]], [1010.0, [8]]])
            sampler.last_t = 1010.0
            sampler._cond.notify_all()
        res = sampler.history_after(999999.0, limit=100, timeout=0)
        self.assertTrue(res.get("reset"))
        self.assertTrue(res.get("gap"))
        self.assertEqual(res.get("cursor"), 1010.0)
        self.assertEqual(res.get("run_id"), sampler.epoch)

    def test_fallback_to_config_rows(self) -> None:
        profiles.save_config("T", {
            "rate": 50,
            "rows": [
                {"id": "rpm", "name": "rpm", "addr": 0x20000000,
                 "table": True, "plot": False, "support": False},
                {"id": "not_sampled", "name": "not_sampled", "addr": 0x20000004,
                 "table": False, "plot": False, "support": False},
            ],
        }, self.tmp)
        loaded = self.app.saved_sampler_config()
        self.assertEqual([s.id for s in loaded["signals"]], ["rpm"])
        self.assertEqual(loaded["rate"], 50)


if __name__ == "__main__":
    unittest.main()
