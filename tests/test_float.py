#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IEEE754 float32 支持：Signal 解码 / CSV / 缓存 roundtrip."""
from __future__ import annotations

import csv
import io
import struct
import unittest

from record_cache import RecordCache
from scope_server import Recorder, Signal


def fbits(v: float) -> int:
    return struct.unpack("<I", struct.pack("<f", v))[0]


class SignalFloatTest(unittest.TestCase):
    def test_decode_float32(self) -> None:
        sig = Signal({"id": "rpm", "name": "rpm", "addr": 0x20000000,
                      "size": 4, "type": "float"})
        self.assertTrue(sig.is_float)
        self.assertAlmostEqual(sig.decode(fbits(1.5)), 1.5, places=6)
        self.assertAlmostEqual(sig.decode(fbits(-12.25)), -12.25, places=6)
        self.assertEqual(sig.to_dict().get("float"), True)

    def test_float_flag_from_catalog(self) -> None:
        sig = Signal({"id": "x", "name": "x", "addr": 0, "size": 4, "float": True})
        self.assertTrue(sig.is_float)
        self.assertTrue(sig.to_dict().get("float"))

    def test_nan_inf_become_none(self) -> None:
        sig = Signal({"id": "x", "name": "x", "addr": 0, "size": 4, "float": True})
        self.assertIsNone(sig.decode(fbits(float("nan"))))
        self.assertIsNone(sig.decode(fbits(float("inf"))))

    def test_int_signal_unchanged(self) -> None:
        sig = Signal({"id": "x", "name": "x", "addr": 0, "size": 2, "signed": True})
        self.assertFalse(sig.is_float)
        self.assertEqual(sig.decode(0xFFFF), -1)


class _FloatSource:
    def read_word(self, addr: int) -> int:
        return fbits(42.5)


class ReadValueFloatTest(unittest.TestCase):
    def test_read_value_float_payload(self) -> None:
        from scope_server import App
        app = object.__new__(App)
        app.source = _FloatSource()
        res = App.read_value(app, {"addr": 0x20000000, "size": 4, "float": True})
        self.assertTrue(res["ok"])
        self.assertAlmostEqual(res["value"], 42.5, places=6)
        self.assertTrue(res.get("float"))
        res2 = App.read_value(app, {"addr": 0x20000000, "size": 4, "type": "float"})
        self.assertAlmostEqual(res2["value"], 42.5, places=6)


class RecorderFloatCsvTest(unittest.TestCase):
    def test_float_csv_and_none(self) -> None:
        r = Recorder()
        sig = Signal({"id": "rpm", "name": "rpm", "addr": 0,
                      "size": 4, "type": "float"})
        r.start([sig])
        r.append(0.0, [1.5])
        r.append(10.0, [None])
        r.append(20.0, [-12.25])
        rows = list(csv.reader(io.StringIO(r.csv().lstrip("\ufeff"))))
        self.assertEqual(rows[0], ["t_ms", "rpm"])
        self.assertEqual(rows[1][1], "1.5")
        self.assertEqual(rows[2][1], "")
        self.assertEqual(rows[3][1], "-12.25")


class RecordCacheFloatTest(unittest.TestCase):
    def test_roundtrip_float_and_nan(self) -> None:
        import tempfile
        import shutil
        tmp = tempfile.mkdtemp(prefix="ms-float-cache-")
        cache = RecordCache(tmp, enabled=True, block_points=8,
                            limit_bytes=8 * 1024 * 1024, flush_seconds=0.1)
        try:
            cache.configure([{"id": "rpm", "name": "rpm", "unit": "",
                              "scale": 1.0, "offset": 0.0, "float": True}])
            for i in range(20):
                cache.append(1000.0 + i * 10.0,
                             [None if i == 5 else 1.5 + i * 0.25])
            self.assertTrue(cache.flush(2.0))
            win = cache.window(1000.0, 2000.0, 1000)
            vals = [row[1][0] for row in win["samples"]]
            self.assertAlmostEqual(vals[0], 1.5, places=6)
            self.assertIsNone(vals[5])
            self.assertAlmostEqual(vals[1], 1.75, places=6)
            ov = cache.overview(100)
            mins = [b["min"][0] for b in ov["buckets"] if b["min"][0] is not None]
            maxs = [b["max"][0] for b in ov["buckets"] if b["max"][0] is not None]
            self.assertTrue(mins and maxs)
            # 不能是 IEEE754 的 int bits（1.5 bits = 1069547520）
            self.assertLess(max(maxs), 1000.0)
            self.assertGreaterEqual(max(maxs), 1.5)
        finally:
            cache.close()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
