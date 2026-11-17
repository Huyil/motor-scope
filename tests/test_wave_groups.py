#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""波形分组 API 的纯逻辑单测（不依赖 HTTP / 真实工程）。"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import wave_groups as wg  # noqa: E402


def cfg_with(rows=None, groups=None, seq=1):
    return {
        "wave": {
            "seq": seq,
            "groups": groups if groups is not None else [
                {"id": "default", "name": "默认分组", "visible": True, "auto": True},
            ],
        },
        "rows": rows if rows is not None else [
            {"id": "a", "name": "a", "plot": True, "table": False,
             "groupId": "default", "color": "#22d3ee"},
            {"id": "b", "name": "b", "plot": True, "table": True,
             "groupId": "default", "color": "#f59e0b"},
            {"id": "c", "name": "c", "plot": False, "table": True,
             "groupId": "default", "color": "#a78bfa"},
        ],
    }


class ColorTest(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(wg.signal_color("motor.over.current"),
                         wg.signal_color("motor.over.current"))

    def test_distinct_names_differ(self):
        names = ["speed", "current", "voltage", "temperature", "fault"]
        colors = {wg.signal_color(n) for n in names}
        self.assertGreaterEqual(len(colors), 4)

    def test_format(self):
        for name in ("", "a", "motor.Scfg.vol", "中文变量"):
            self.assertRegex(wg.signal_color(name), r"^#[0-9a-f]{6}$")

    def test_normalize_color(self):
        self.assertEqual(wg.normalize_color("22d3ee"), "#22d3ee")
        self.assertEqual(wg.normalize_color("#ABC"), "#abc")
        for bad in ("", "#12", "#gggggg", "red"):
            with self.assertRaises(ValueError):
                wg.normalize_color(bad)


class NormalizeTest(unittest.TestCase):
    def test_default_group_created_and_first(self):
        cfg = {"wave": {"groups": [{"id": "wg2", "name": "分组 2"}]}, "rows": []}
        out = wg.snapshot(cfg)
        self.assertEqual(out["groups"][0]["id"], "default")
        self.assertEqual(cfg["wave"]["groups"][0]["id"], "default")
        self.assertEqual(out["groups"][1]["id"], "wg2")

    def test_unknown_group_falls_back_to_default(self):
        cfg = cfg_with(rows=[{"id": "a", "name": "a", "plot": True, "groupId": "nope"}])
        wg.normalize(cfg)
        self.assertEqual(cfg["rows"][0]["groupId"], "default")

    def test_seq_covers_existing_ids(self):
        cfg = cfg_with(groups=[
            {"id": "default", "name": "默认分组"},
            {"id": "wg7", "name": "七"},
        ], seq=1)
        out = wg.create(cfg, {"name": "新"})
        self.assertEqual(out["group"]["id"], "wg8")

    def test_duplicate_group_id_dropped(self):
        cfg = cfg_with(groups=[
            {"id": "default", "name": "默认分组"},
            {"id": "wg2", "name": "一"},
            {"id": "wg2", "name": "二"},
        ])
        out = wg.snapshot(cfg)
        self.assertEqual([g["id"] for g in out["groups"]], ["default", "wg2"])
        self.assertEqual(out["groups"][1]["name"], "一")


class CreateTest(unittest.TestCase):
    def test_create_empty(self):
        cfg = cfg_with()
        out = wg.create(cfg, {"name": "电流环"})
        self.assertEqual(out["group"]["name"], "电流环")
        self.assertEqual(out["group"]["id"], "wg2")
        self.assertEqual(out["added"], [])
        self.assertEqual(len(out["groups"]), 2)

    def test_create_default_name(self):
        cfg = cfg_with()
        out = wg.create(cfg, {})
        self.assertEqual(out["group"]["name"], "分组 2")

    def test_create_with_signals_and_hash_colors(self):
        cfg = cfg_with()
        out = wg.create(cfg, {"name": "电流", "signals": ["a", "b"]})
        self.assertEqual(out["added"], ["a", "b"])
        self.assertEqual(out["colors"]["a"], wg.signal_color("a"))
        self.assertEqual(out["colors"]["b"], wg.signal_color("b"))
        for row in cfg["rows"]:
            if row["id"] in ("a", "b"):
                self.assertEqual(row["groupId"], out["group"]["id"])

    def test_create_with_manual_colors(self):
        cfg = cfg_with()
        out = wg.create(cfg, {
            "name": "电流",
            "signals": [{"id": "a", "color": "#ff8800"}, "b"],
            "colors": {"b": "00ff00"},
        })
        self.assertEqual(out["colors"]["a"], "#ff8800")
        self.assertEqual(out["colors"]["b"], "#00ff00")

    def test_default_color_applied_to_signals_without_color(self):
        cfg = cfg_with()
        out = wg.create(cfg, {"name": "电流", "signals": ["a", "b"],
                              "color": "#ff8800"})
        self.assertEqual(out["colors"]["a"], "#ff8800")
        self.assertEqual(out["colors"]["b"], "#ff8800")

    def test_duplicate_name_rejected(self):
        cfg = cfg_with()
        with self.assertRaises(ValueError):
            wg.create(cfg, {"name": "默认分组"})
        wg.create(cfg, {"name": "电流"})
        with self.assertRaises(ValueError):
            wg.create(cfg, {"name": "电流"})

    def test_invalid_color_rejected_before_mutation(self):
        cfg = cfg_with()
        before = [r["groupId"] for r in cfg["rows"]]
        with self.assertRaises(ValueError):
            wg.create(cfg, {"name": "x", "signals": [{"id": "a", "color": "red"}]})
        self.assertEqual([r["groupId"] for r in cfg["rows"]], before)


class RenameTest(unittest.TestCase):
    def test_rename(self):
        cfg = cfg_with(groups=[
            {"id": "default", "name": "默认分组"},
            {"id": "wg2", "name": "旧名"},
        ])
        out = wg.rename(cfg, {"id": "wg2", "name": "新名"})
        self.assertEqual(out["group"]["name"], "新名")
        self.assertEqual(cfg["wave"]["groups"][1]["name"], "新名")

    def test_rename_default_allowed(self):
        cfg = cfg_with()
        out = wg.rename(cfg, {"id": "default", "name": "全部"})
        self.assertEqual(out["group"]["name"], "全部")

    def test_rename_empty_rejected(self):
        cfg = cfg_with()
        with self.assertRaises(ValueError):
            wg.rename(cfg, {"id": "default", "name": "  "})

    def test_rename_duplicate_rejected(self):
        cfg = cfg_with(groups=[
            {"id": "default", "name": "默认分组"},
            {"id": "wg2", "name": "甲"},
            {"id": "wg3", "name": "乙"},
        ])
        with self.assertRaises(ValueError):
            wg.rename(cfg, {"id": "wg2", "name": "乙"})

    def test_rename_unknown(self):
        with self.assertRaises(ValueError):
            wg.rename(cfg_with(), {"id": "nope", "name": "x"})


class AddTest(unittest.TestCase):
    def test_add_all_selected_waveforms(self):
        cfg = cfg_with()
        # 先建一个空分组，再把默认组里的已选波形加进去
        made = wg.create(cfg, {"name": "波形"})
        gid = made["group"]["id"]
        out = wg.add(cfg, {"id": gid})
        self.assertEqual(set(out["added"]), {"a", "b"})   # c 是 table-only
        self.assertEqual(out["group"]["count"], 2)

    def test_add_explicit_promotes_table_row(self):
        cfg = cfg_with()
        made = wg.create(cfg, {"name": "波形"})
        gid = made["group"]["id"]
        out = wg.add(cfg, {"id": gid, "signals": ["c"]})
        self.assertEqual(out["added"], ["c"])
        row = next(r for r in cfg["rows"] if r["id"] == "c")
        self.assertTrue(row["plot"])
        self.assertEqual(row["groupId"], gid)

    def test_add_by_name(self):
        cfg = cfg_with()
        made = wg.create(cfg, {"name": "波形"})
        out = wg.add(cfg, {"id": made["group"]["id"], "signals": ["b"]})
        self.assertEqual(out["added"], ["b"])

    def test_unknown_signal_skipped(self):
        cfg = cfg_with()
        made = wg.create(cfg, {"name": "波形"})
        out = wg.add(cfg, {"id": made["group"]["id"], "signals": ["a", "nope"]})
        self.assertEqual(out["added"], ["a"])
        self.assertEqual(out["skipped"][0]["id"], "nope")

    def test_all_unknown_raises(self):
        cfg = cfg_with()
        made = wg.create(cfg, {"name": "波形"})
        with self.assertRaises(ValueError):
            wg.add(cfg, {"id": made["group"]["id"], "signals": ["nope"]})

    def test_recolor_false_keeps_existing(self):
        cfg = cfg_with()
        made = wg.create(cfg, {"name": "波形"})
        out = wg.add(cfg, {"id": made["group"]["id"], "signals": ["a"], "recolor": False})
        self.assertEqual(out["colors"]["a"], "#22d3ee")

    def test_recolor_true_overwrites(self):
        cfg = cfg_with()
        made = wg.create(cfg, {"name": "波形"})
        out = wg.add(cfg, {"id": made["group"]["id"], "signals": ["a"]})
        self.assertEqual(out["colors"]["a"], wg.signal_color("a"))

    def test_add_nothing_raises(self):
        cfg = cfg_with(rows=[{"id": "a", "name": "a", "plot": False, "table": False}])
        made = wg.create(cfg, {"name": "波形"})
        with self.assertRaises(ValueError):
            wg.add(cfg, {"id": made["group"]["id"]})


class DeleteTest(unittest.TestCase):
    def test_delete_moves_rows_to_default(self):
        cfg = cfg_with(groups=[
            {"id": "default", "name": "默认分组"},
            {"id": "wg2", "name": "临时"},
        ], rows=[{"id": "a", "name": "a", "plot": True, "groupId": "wg2"}])
        out = wg.delete(cfg, {"id": "wg2"})
        self.assertEqual(out["deleted"], "wg2")
        self.assertEqual(cfg["rows"][0]["groupId"], "default")
        self.assertEqual([g["id"] for g in cfg["wave"]["groups"]], ["default"])

    def test_delete_default_rejected(self):
        with self.assertRaises(ValueError):
            wg.delete(cfg_with(), {"id": "default"})

    def test_delete_unknown(self):
        with self.assertRaises(ValueError):
            wg.delete(cfg_with(), {"id": "nope"})


if __name__ == "__main__":
    unittest.main()
