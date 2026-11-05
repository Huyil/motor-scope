#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务端分块压缩录制缓存：块格式 / 压缩 / overview/window / 清理语义."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from record_cache import (  # noqa: E402
    CACHE_VERSION, MAGIC, RecordCache, block_header, read_block,
)

SIGS_2 = [
    {"id": "a", "name": "a", "unit": "V", "scale": 1.0, "offset": 0.0},
    {"id": "b", "name": "b", "unit": "A", "scale": 2.0, "offset": 1.0},
]
SIGS_1 = [{"id": "a", "name": "a", "unit": "", "scale": 1.0, "offset": 0.0}]


def _session_dirs(root):
    return sorted(d for d in os.listdir(root)
                  if d.startswith("session-") and os.path.isdir(os.path.join(root, d)))


def _meta(root, name):
    with open(os.path.join(root, name, "meta.json"), "r", encoding="utf-8") as f:
        return json.load(f)


class RecordCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ms-cache-test-")
        self.cache = RecordCache(self.tmp, limit_bytes=32 * 1024 * 1024,
                                 block_points=50, enabled=True, flush_seconds=0.1)

    def tearDown(self):
        try:
            self.cache.close()
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _append(self, n, t0=1000.0, dt=10.0, channels=2):
        for i in range(n):
            vals = [i % 100 for _ in range(channels)]
            vals[0] = i
            self.cache.append(t0 + i * dt, vals)
        self.assertTrue(self.cache.flush(2.0))

    def test_block_roundtrip_compression_and_overview(self):
        self.cache.configure(SIGS_2)
        self._append(120)
        info = self.cache.info()
        self.assertTrue(info["enabled"])
        self.assertEqual(info["count"], 120)
        self.assertGreaterEqual(info["blocks"], 3)
        self.assertEqual(info["start"], 1000.0)
        self.assertEqual(info["end"], 2190.0)
        self.assertFalse(info["saved"])
        self.assertFalse(info["clearable"])

        sdir = _session_dirs(self.tmp)[0]
        files = sorted(f for f in os.listdir(os.path.join(self.tmp, sdir))
                       if f.endswith(".bin"))
        self.assertGreaterEqual(len(files), 3)
        path = os.path.join(self.tmp, sdir, files[0])
        hdr = block_header(path)
        self.assertEqual(hdr["magic"], MAGIC)
        self.assertEqual(hdr["version"], CACHE_VERSION)
        self.assertEqual(hdr["channels"], 2)
        # 文件本身必须是 zlib 压缩流，且明显小于未压缩矩阵
        with open(path, "rb") as f:
            comp = f.read()
        raw = zlib.decompress(comp)
        self.assertEqual(hdr["raw_size"], len(raw))
        self.assertLess(len(comp), len(raw))
        rows = read_block(path)
        self.assertEqual(len(rows), hdr["count"])
        self.assertEqual(rows[0][1], [0, 0])
        for i in range(1, len(rows)):
            self.assertAlmostEqual(rows[i][0] - rows[i - 1][0], 10.0, places=3)

        ov = self.cache.overview(max_points=3)
        self.assertTrue(ov["ok"])
        self.assertFalse(ov["empty"])
        self.assertEqual(ov["count"], 120)
        self.assertEqual(len(ov["buckets"]), 3)
        self.assertEqual(len(ov["signals"]), 2)
        first = ov["buckets"][0]
        self.assertEqual(len(first["min"]), 2)
        self.assertEqual(len(first["max"]), 2)
        self.assertLessEqual(first["min"][0], first["max"][0])

        win = self.cache.window(1100.0, 1200.0, 1000)
        self.assertEqual(win["count"], 11)
        self.assertEqual(win["returned"], 11)
        self.assertFalse(win["decimated"])
        self.assertEqual(win["samples"][0][0], 1100.0)
        self.assertEqual(win["samples"][0][1][0], 10)
        self.assertEqual(win["samples"][-1][0], 1200.0)

    def test_window_decimation(self):
        self.cache.configure(SIGS_1)
        self._append(300, channels=1)
        win = self.cache.window(1000.0, 3990.0, 50)
        self.assertEqual(win["count"], 300)
        self.assertTrue(win["decimated"])
        self.assertGreater(win["stride"], 1)
        self.assertLessEqual(win["returned"], 60)
        self.assertEqual(win["samples"][0][0], 1000.0)

    def test_signal_change_rotates_session(self):
        self.cache.configure(SIGS_2)
        self._append(60)
        first = self.cache.info()["session"]
        self.cache.configure(SIGS_1)
        self._append(30, t0=5000.0, channels=1)
        info = self.cache.info()
        self.assertNotEqual(info["session"], first)
        self.assertEqual([s["id"] for s in info["signals"]], ["a"])
        self.assertEqual(info["count"], 30)
        # 旧会话已结束且未保存 → clearable
        paths = _session_dirs(self.tmp)
        metas = [_meta(self.tmp, p) for p in paths]
        old = [m for m in metas if m["id"] == first][0]
        self.assertTrue(old["clearable"])
        self.assertFalse(old["active"])

    def test_unsaved_finish_clearable_and_startup_cleanup(self):
        self.cache.configure(SIGS_2)
        self._append(60)
        self.cache.finish()
        info = self.cache.info()
        self.assertFalse(info["active"])
        self.assertTrue(info["clearable"])
        self.assertFalse(info["saved"])
        self.cache.close()
        # 重开：clearable 会话启动时清理
        self.cache = RecordCache(self.tmp, block_points=50, enabled=True)
        info = self.cache.info()
        self.assertIsNone(info["session"])
        self.assertEqual(info["total_bytes"], 0)
        self.assertEqual(_session_dirs(self.tmp), [])

    def test_saved_survives_restart(self):
        self.cache.configure(SIGS_2)
        self._append(60)
        res = self.cache.save_current()
        self.assertTrue(res["ok"])
        self.assertTrue(res["saved"])
        self.assertFalse(res["clearable"])
        self.cache.finish()
        saved_bytes = self.cache.info()["total_bytes"]
        self.assertGreater(saved_bytes, 0)
        self.cache.close()
        self.cache = RecordCache(self.tmp, block_points=50, enabled=True)
        info = self.cache.info()
        # 旧历史列表尚未实现：current 仍为空，但 saved 会话保留并计入容量
        self.assertIsNone(info["session"])
        self.assertEqual(info["sessions"], 1)
        self.assertGreater(info["total_bytes"], 0)
        paths = _session_dirs(self.tmp)
        self.assertEqual(len(paths), 1)
        self.assertTrue(_meta(self.tmp, paths[0])["saved"])

    def test_limit_evicts_clearable_then_saved(self):
        self.cache.configure(SIGS_1)
        # A: saved
        self._append(100, t0=1000.0, channels=1)
        self.cache.finish()
        self.cache.save_current()
        # B: clearable
        self._append(100, t0=3000.0, channels=1)
        self.cache.finish()
        b_id = self.cache.info()["session"]
        # C: active；把上限压到只允许约一个块
        self.cache.limit_bytes = 500
        self._append(100, t0=5000.0, channels=1)
        self.assertTrue(self.cache.flush(2.0))
        info = self.cache.info()
        self.assertLessEqual(info["total_bytes"], 500)
        self.assertEqual(info["sessions"], 1, "clearable + saved 应优先被清理")
        self.assertIsNotNone(info["session"])
        self.assertNotEqual(info["session"], b_id)
        self.assertLessEqual(info["total_bytes"], 500)
        # 继续写：活动会话只保留最新块，且块文件序号不冲突
        first_blocks = set(f for f in os.listdir(
            os.path.join(self.tmp, info["session"])) if f.endswith(".bin"))
        self._append(100, t0=7000.0, channels=1)
        info2 = self.cache.info()
        self.assertLessEqual(info2["total_bytes"], 500)
        self.assertIsNotNone(info2["session"])
        for fname in os.listdir(os.path.join(self.tmp, info2["session"])):
            if fname.endswith(".bin"):
                self.assertTrue(read_block(os.path.join(self.tmp, info2["session"], fname)))
        # 被删的 clearable 会话目录不应再存在
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, b_id)))

    def test_startup_repairs_missing_block(self):
        self.cache.configure(SIGS_2)
        self._append(120)
        self.cache.save_current()
        self.cache.finish()
        self.cache.close()
        path = _session_dirs(self.tmp)[0]
        blocks = sorted(f for f in os.listdir(os.path.join(self.tmp, path))
                        if f.endswith(".bin"))
        self.assertGreaterEqual(len(blocks), 2)
        os.remove(os.path.join(self.tmp, path, blocks[0]))
        self.cache = RecordCache(self.tmp, block_points=50, enabled=True)
        info = self.cache.info()
        self.assertIsNotNone(info)  # 不抛异常即可
        meta = _meta(self.tmp, path)
        self.assertEqual(len(meta["blocks"]), len(blocks) - 1)
        for b in meta["blocks"]:
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, path, b["file"])))

    def test_time_bounded_block_at_low_rate(self):
        # 低采样率下块不会等满 2000 点；最多积压 max_block_seconds 就落盘
        self.cache.close()
        self.cache = RecordCache(self.tmp, limit_bytes=32 * 1024 * 1024,
                                 block_points=1000, enabled=True,
                                 flush_seconds=5.0, max_block_seconds=1.0)
        self.cache.configure(SIGS_1)
        self.cache.append(1000.0, [1])
        time.sleep(1.05)
        self.cache.append(2000.0, [2])
        for _ in range(30):
            if self.cache.info()["blocks"] >= 1:
                break
            time.sleep(0.05)
        info = self.cache.info()
        self.assertGreaterEqual(info["blocks"], 1)
        self.assertEqual(info["count"], 2)
        win = self.cache.window(0, 3000, 100)
        self.assertEqual([r[1][0] for r in win["samples"]], [1, 2])

    def test_save_is_local_flag_only(self):
        self.cache.configure(SIGS_2)
        self._append(60)
        self.assertFalse(self.cache.info()["saved"])
        res = self.cache.save_current()
        self.assertTrue(res["saved"])
        self.assertFalse(res["clearable"])
        # 保存后再追加数据仍是同一会话
        sid = self.cache.info()["session"]
        self._append(60, t0=5000.0)
        self.assertEqual(self.cache.info()["session"], sid)
        self.assertTrue(self.cache.info()["saved"])


if __name__ == "__main__":
    unittest.main()
