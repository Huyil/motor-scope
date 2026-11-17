#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GET /api/profiles/config 的只读读取单测。"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import scope_server  # noqa: E402


class ProfileConfigApiTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ms-pcfg-")
        pdir = os.path.join(self.root, "T1")
        os.makedirs(pdir)
        with open(os.path.join(pdir, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "T1", "name": "T1"}, f)
        self.cfg = {"machine": "T1", "rows": [{"id": "a", "name": "a", "plot": True}]}
        with open(os.path.join(pdir, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"saved_at": "2026-11-16 23:00:00", "config": self.cfg}, f)
        self.app = SimpleNamespace(profile={"id": "T1"}, profiles_root=self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_reads_active_profile_config(self):
        out = scope_server.App.profile_config_payload(self.app)
        self.assertTrue(out["ok"])
        self.assertEqual(out["profile"], "T1")
        self.assertEqual(out["saved_at"], "2026-11-16 23:00:00")
        self.assertEqual(out["config"], self.cfg)

    def test_reads_explicit_profile(self):
        out = scope_server.App.profile_config_payload(self.app, "T1")
        self.assertEqual(out["config"]["machine"], "T1")

    def test_unknown_profile_raises(self):
        with self.assertRaises(RuntimeError):
            scope_server.App.profile_config_payload(self.app, "NOPE")


if __name__ == "__main__":
    unittest.main()
