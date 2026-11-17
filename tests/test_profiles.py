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

    def test_create_profile_from_copy(self) -> None:
        profiles.ensure(root=self.root)
        data = {"variables": [{"name": "g_a", "addr": 0x20000000}],
                "peripherals": [{"name": "GPIOA", "base": 0x40000000, "regs": []}],
                "meta": {"generated_at": "2026-11-10 09:00:00", "mcu": "CW32L011"}}
        profiles.save_catalog("DR2159", data, self.root)
        meta = profiles.apply_counts(profiles.read_profile("DR2159", self.root), data)
        profiles.write_profile(meta, self.root)
        profiles.save_config("DR2159", {"rate": 50, "rows": [{"id": "g_a"}]}, self.root)

        copied = profiles.create_profile("N32G003 副本", self.root, base="DR2159")
        self.assertIn(copied["id"], profiles.load_index(self.root)["items"])
        self.assertEqual(copied["mcu"], "CW32L011")
        self.assertEqual(copied["counts"]["variables"], 1)
        self.assertTrue(os.path.isfile(profiles.signals_path(copied["id"], self.root)))
        self.assertIsNotNone(profiles.load_catalog(copied["id"], self.root))
        self.assertEqual(profiles.read_config(copied["id"], self.root)["config"]["rate"], 50)

        # 同名再建一次：ID 必须唯一
        again = profiles.create_profile("N32G003 副本", self.root, base="DR2159")
        self.assertNotEqual(again["id"], copied["id"])
        self.assertEqual(len(profiles.load_index(self.root)["items"]), 6)

    def test_delete_profile_keeps_index_consistent(self) -> None:
        profiles.ensure(root=self.root)
        meta = profiles.create_profile("临时机型", self.root, base="DR2159")
        pid = meta["id"]
        profiles.set_active(pid, self.root)
        profiles.delete_profile(pid, self.root)
        index = profiles.load_index(self.root)
        self.assertNotIn(pid, index["items"])
        self.assertNotEqual(index["active"], pid)
        self.assertFalse(os.path.isdir(os.path.join(self.root, pid)))

    def test_svd_device_name(self) -> None:
        from scope_server import _svd_device_name
        svd = ('<?xml version="1.0"?><device><vendor>Nationstech</vendor>'
               '<name>N32G003</name><cpu><name>CM0</name></cpu>'
               '<peripherals/></device>')
        path = os.path.join(self.root, "tiny.svd")
        with open(path, "w", encoding="utf-8") as f:
            f.write(svd)
        self.assertEqual(_svd_device_name(path), "N32G003")
        self.assertEqual(_svd_device_name(os.path.join(self.root, "none.svd")), "")

    def test_svd_info_reads_device_name_not_cpu(self) -> None:
        import gen_signals
        svd = ('<?xml version="1.0"?><device><vendor>Nationstech</vendor>'
               '<name>N32G003</name><cpu><name>CM0</name></cpu>'
               '<peripherals/></device>')
        path = os.path.join(self.root, "tiny.svd")
        with open(path, "w", encoding="utf-8") as f:
            f.write(svd)
        info = gen_signals.svd_info(path)
        self.assertEqual(info["name"], "N32G003")
        self.assertEqual(info["vendor"], "Nationstech")
        self.assertEqual(info["cpu"], "CM0")


if __name__ == "__main__":
    unittest.main()
