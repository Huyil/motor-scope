#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""波形分组 HTTP 层（App 方法 + config.json 落盘 + SSE 事件）单测。"""
import json
import os
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import scope_server  # noqa: E402
import wave_groups as wg  # noqa: E402


class FakeHub:
    def __init__(self):
        self.events = []

    def publish(self, msg):
        self.events.append(msg)


def make_root():
    root = tempfile.mkdtemp(prefix="ms-wave-")
    pdir = os.path.join(root, "T1")
    os.makedirs(pdir)
    with open(os.path.join(pdir, "profile.json"), "w", encoding="utf-8") as f:
        json.dump({"id": "T1", "name": "T1"}, f)
    cfg = {
        "wave": {"seq": 1, "groups": [
            {"id": "default", "name": "默认分组", "visible": True, "auto": True},
        ]},
        "rows": [
            {"id": "a", "name": "a", "plot": True, "table": False,
             "groupId": "default", "color": "#22d3ee"},
            {"id": "b", "name": "b", "plot": True, "table": True,
             "groupId": "default", "color": "#f59e0b"},
        ],
    }
    with open(os.path.join(pdir, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"saved_at": "2026-01-01 00:00:00", "config": cfg}, f)
    return root


class FakeApp(scope_server.App):
    """只填分组 API 需要的字段，跳过 App.__init__ 的采样/OpenOCD 初始化。"""

    def __init__(self, root):
        self.profile = {"id": "T1"}
        self.profiles_root = root
        self.hub = FakeHub()
        self.wave_groups_lock = threading.Lock()


def make_app(root):
    return FakeApp(root)


class WaveGroupsApiTest(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.app = make_app(self.root)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def read_cfg(self):
        with open(os.path.join(self.root, "T1", "config.json"), encoding="utf-8") as f:
            return json.load(f)["config"]

    def test_get_payload(self):
        res = scope_server.App.wave_groups_payload(self.app)
        self.assertTrue(res["ok"])
        self.assertEqual(res["profile"], "T1")
        self.assertEqual(res["groups"][0]["id"], "default")
        self.assertEqual(res["count"], 2)

    def test_create_persists_and_publishes(self):
        res = scope_server.App.wave_group_create(
            self.app, {"name": "电流", "signals": ["a"]})
        self.assertTrue(res["ok"])
        gid = res["group"]["id"]
        self.assertEqual(res["colors"]["a"], wg.signal_color("a"))
        saved = self.read_cfg()
        self.assertEqual(saved["rows"][0]["groupId"], gid)
        event = self.app.hub.events[-1]
        self.assertEqual(event["type"], "wave_groups")
        self.assertEqual(event["profile"], "T1")
        self.assertEqual(event["rows"]["a"], gid)

    def test_rename(self):
        made = scope_server.App.wave_group_create(self.app, {"name": "旧"})
        gid = made["group"]["id"]
        res = scope_server.App.wave_group_rename(
            self.app, {"id": gid, "name": "新"})
        self.assertEqual(res["group"]["name"], "新")
        self.assertEqual(self.read_cfg()["wave"]["groups"][1]["name"], "新")

    def test_add_default_selected(self):
        made = scope_server.App.wave_group_create(self.app, {"name": "组"})
        gid = made["group"]["id"]
        res = scope_server.App.wave_group_add(self.app, {"id": gid})
        self.assertEqual(set(res["added"]), {"a", "b"})
        self.assertEqual(res["group"]["count"], 2)

    def test_add_manual_color(self):
        made = scope_server.App.wave_group_create(self.app, {"name": "组"})
        gid = made["group"]["id"]
        res = scope_server.App.wave_group_add(
            self.app, {"id": gid, "signals": [{"id": "a", "color": "#ff8800"}]})
        self.assertEqual(res["colors"]["a"], "#ff8800")
        self.assertEqual(self.read_cfg()["rows"][0]["color"], "#ff8800")

    def test_delete(self):
        made = scope_server.App.wave_group_create(self.app, {"name": "组"})
        gid = made["group"]["id"]
        res = scope_server.App.wave_group_delete(self.app, {"id": gid})
        self.assertEqual(res["deleted"], gid)
        self.assertEqual(len(self.read_cfg()["wave"]["groups"]), 1)

    def test_unknown_signal_raises_value_error(self):
        made = scope_server.App.wave_group_create(self.app, {"name": "组"})
        gid = made["group"]["id"]
        with self.assertRaises(ValueError):
            scope_server.App.wave_group_add(
                self.app, {"id": gid, "signals": ["nope"]})

    def test_no_profile_raises(self):
        self.app.profile = {}
        with self.assertRaises(RuntimeError):
            scope_server.App.wave_groups_payload(self.app)


if __name__ == "__main__":
    unittest.main()
