#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""profiles.py 单元测试：机型目录、配置快照、激活项与统计。"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

import profiles


class TestProfiles(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="msprof-")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_ensure_creates_default_machines(self) -> None:
        profiles.ensure(root=self.root)
        index = profiles.load_index(self.root)
        self.assertEqual(index["items"],
                         ["DR2159", "DR1152", "DR1152_CH", "LKS32-FOC"])
        self.assertEqual(index["active"], "DR2159")
        for pid in index["items"]:
            meta = profiles.read_profile(pid, self.root)
            self.assertIsNotNone(meta)
            self.assertEqual(meta["id"], pid)
            self.assertTrue(os.path.isfile(
                os.path.join(self.root, pid, "profile.json")))

    def test_active_and_summary(self) -> None:
        profiles.ensure(root=self.root)
        profiles.set_active("LKS32-FOC", self.root)
        self.assertEqual(profiles.get_active(self.root), "LKS32-FOC")
        meta = profiles.read_profile("LKS32-FOC", self.root)
        summary = profiles.summary(meta, self.root)
        self.assertEqual(summary["mcu"], "LKS32MC07x")
        # 临时目录里没有生成 signals.json
        self.assertFalse(summary["available"])
        self.assertEqual(summary["variables"], 0)

    def test_config_roundtrip(self) -> None:
        profiles.ensure(root=self.root)
        cfg = {"machine": "DR1152", "rate": 50, "rows": [{"id": "s_duty"}]}
        saved = profiles.save_config("DR1152", cfg, self.root)
        self.assertIn("saved_at", saved)
        back = profiles.read_config("DR1152", self.root)
        self.assertEqual(back["config"], cfg)
        self.assertEqual(back["saved_at"], saved["saved_at"])
        self.assertTrue(os.path.isfile(profiles.config_path("DR1152", self.root)))

    def test_apply_counts(self) -> None:
        profiles.ensure(root=self.root)
        meta = profiles.read_profile("DR2159", self.root)
        data = {"variables": [1, 2, 3], "peripherals": [1],
                "meta": {"generated_at": "2026-11-04 09:00:00"}}
        meta = profiles.apply_counts(meta, data)
        self.assertEqual(meta["counts"]["variables"], 3)
        self.assertEqual(meta["counts"]["peripherals"], 1)
        self.assertEqual(meta["counts"]["generated_at"], "2026-11-04 09:00:00")

    def test_unknown_profile(self) -> None:
        profiles.ensure(root=self.root)
        self.assertIsNone(profiles.read_profile("NOPE", self.root))
        self.assertEqual(profiles.load_catalog("NOPE", self.root), None)

    def test_ensure_is_idempotent(self) -> None:
        profiles.ensure(root=self.root)
        with open(os.path.join(self.root, "index.json"), encoding="utf-8") as f:
            first = json.load(f)
        profiles.ensure(root=self.root)
        with open(os.path.join(self.root, "index.json"), encoding="utf-8") as f:
            second = json.load(f)
        self.assertEqual(first["items"], second["items"])


if __name__ == "__main__":
    unittest.main()
