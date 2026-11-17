#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""导入链路集成测试：新建机型 / 更新寄存器表 / 复制机型。

需要仓库 imports/ 里有真实的 AXF + SVD（用户私有数据，通常被 gitignore）；
没有时整组跳过，不影响常规单测。
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace

import profiles
import scope_server
from scope_server import App, Signal

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
AXF = os.path.join(PROJECT_ROOT, "imports", "20261110_110620_570200_LA24020.axf")
SVD = os.path.join(PROJECT_ROOT, "imports", "20261110_110624_432000_N32G003.svd")

HAVE_FIXTURES = os.path.isfile(AXF) and os.path.isfile(SVD)


@unittest.skipUnless(HAVE_FIXTURES, "imports/ 里没有 N32G003 AXF/SVD 测试素材")
class ImportFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="msimport-")
        args = SimpleNamespace(
            project=PROJECT_ROOT, axf="", header="",
            signals=os.path.join(self.root, "signals.json"),
            openocd="", iface="", target="", verbose=False, rate=100.0,
            record_cache_dir=None, no_record_cache=True,
            record_cache_limit_mb=1, record_cache_block_points=100,
        )
        self.app = App(args)
        # 把运行期状态全部切到临时目录，避免写真实 profiles/
        self.app.profiles_root = os.path.join(self.root, "profiles")
        profiles.ensure(root=self.app.profiles_root)
        self.app.profile = None
        self.app.catalog = {}
        self.app.signals_path = os.path.join(self.root, "signals.json")
        self.app.import_dir = os.path.join(self.root, "imports")
        with open(AXF, "rb") as f:
            self.axf = f.read()
        with open(SVD, "rb") as f:
            self.svd = f.read()

    def tearDown(self) -> None:
        try:
            self.app.source = None
        except Exception:
            pass
        shutil.rmtree(self.root, ignore_errors=True)

    def _profile(self, pid: str):
        return profiles.read_profile(pid, self.app.profiles_root)

    def test_new_then_update_and_copy(self) -> None:
        res = self.app.import_catalog(
            self.axf, "LA24020.axf",
            table_bytes=self.svd, table_name="N32G003.svd",
            target="new", profile_name="N32G003",
        )
        self.assertTrue(res.get("created"))
        self.assertEqual(res["counts"]["variables"], 293)
        self.assertEqual(res["counts"]["peripherals"], 19)
        # 如果固件里有 float 变量，生成器必须带 float 标记（fixture 不一定有）
        for v in res["catalog"]["variables"]:
            if str(v.get("type") or "").strip().lower() == "float":
                self.assertTrue(v.get("float"), "float 变量必须带 float 标记")
        self.assertEqual(profiles.load_index(self.app.profiles_root)["active"], "N32G003")
        meta = self._profile("N32G003")
        self.assertTrue(os.path.isfile(profiles.signals_path("N32G003", self.app.profiles_root)))
        self.assertEqual(meta["mcu"], "N32G003")
        self.assertTrue(meta["source"]["svd"].endswith("_N32G003.svd"))
        self.assertFalse(meta["source"]["header"])

        # 只导入 SVD：只替换寄存器表，并把来源写回 profile
        res2 = self.app.import_catalog(
            None, "", table_bytes=self.svd, table_name="N32G003.svd", target="update")
        self.assertFalse(res2.get("created"))
        self.assertEqual(res2["counts"]["peripherals"], 19)
        meta2 = self._profile("N32G003")
        self.assertTrue(meta2["source"]["svd"].endswith("_N32G003.svd"))
        self.assertEqual(res2["catalog"]["meta"]["register_source"], "svd")

        # 只导入 AXF：变量重建，但寄存器表沿用已保存的 SVD
        res3 = self.app.import_catalog(self.axf, "LA24020.axf", target="update")
        self.assertEqual(res3["counts"]["variables"], 293)
        self.assertEqual(res3["counts"]["peripherals"], 19)

        # 复制当前机型：符号表/元数据一起复制
        res4 = self.app.create_profile({"name": "N32G003 copy"})
        self.assertTrue(res4.get("created"))
        self.assertEqual(res4["counts"]["variables"], 293)
        self.assertEqual(profiles.load_index(self.app.profiles_root)["active"], "N32G003_copy")
        self.assertTrue(os.path.isfile(
            profiles.signals_path("N32G003_copy", self.app.profiles_root)))

    def test_update_axf_by_local_path(self) -> None:
        # 先建一个 N32G003 机型（导入会复制到临时 imports/）
        self.app.import_catalog(
            self.axf, "LA24020.axf",
            table_bytes=self.svd, table_name="N32G003.svd",
            target="new", profile_name="N32G003",
        )
        # 先用新符号表里真实存在的变量配置采样通道，更新 AXF 后应能按 id 恢复
        var = self.app.catalog["variables"][0]
        sig = Signal({"id": var["name"], "name": var["name"],
                      "addr": var["addr"], "size": var.get("size", 2)})
        self.app.sampler.set_signals([sig], 100.0)

        # 再用本机路径把 AXF 指回原始工程文件并重建
        res = self.app.update_catalog_source({"axf": AXF})
        self.assertTrue(res["ok"])
        self.assertIn("axf", res["changed"])
        self.assertEqual(res["profile"]["id"], "N32G003")
        self.assertEqual(res["profile"]["source_axf"], AXF)
        self.assertTrue(res["profile"]["source_axf_exists"])
        self.assertEqual(res["counts"]["variables"], 293)
        self.assertEqual(res["counts"]["peripherals"], 19)
        self.assertIn(var["name"], res["restored_signals"])
        meta = profiles.read_profile("N32G003", self.app.profiles_root)
        self.assertEqual(meta["source"]["axf"], AXF)
        self.assertEqual(meta["counts"]["variables"], 293)
        info = self.app.catalog_source_info({"profile": "N32G003"})
        self.assertTrue(info["exists"]["axf"])
        self.assertTrue(info["exists"]["svd"])

        # 路径不存在：必须报错且不改 profile
        with self.assertRaises(RuntimeError):
            self.app.update_catalog_source({"axf": os.path.join(self.root, "nope.axf")})
        self.assertEqual(
            profiles.read_profile("N32G003", self.app.profiles_root)["source"]["axf"],
            AXF)

    def test_update_svd_by_local_path(self) -> None:
        self.app.import_catalog(
            self.axf, "LA24020.axf",
            table_bytes=self.svd, table_name="N32G003.svd",
            target="new", profile_name="N32G003",
        )
        res = self.app.update_catalog_source({"svd": SVD})
        self.assertTrue(res["ok"])
        self.assertEqual(res["counts"]["peripherals"], 19)
        meta = profiles.read_profile("N32G003", self.app.profiles_root)
        self.assertEqual(meta["source"]["svd"], SVD)
        self.assertEqual(meta["source"]["header"], "")


if __name__ == "__main__":
    unittest.main()
