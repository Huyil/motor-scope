#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Recorder CSV 导出单测：全列、子集、过期 id 回退。"""
from __future__ import annotations

import csv
import io
import unittest

from scope_server import Recorder, Signal


def make_recorder(n=4):
    r = Recorder()
    sigs = []
    for i in range(n):
        sigs.append(Signal({
            "id": "sig%d" % i, "name": "sig%d" % i,
            "addr": 0x20000000 + i * 4, "size": 4,
            "scale": 1.0, "offset": 0.0,
        }))
    r.start(sigs)
    for k in range(3):
        r.append(k * 100.0, [k * 10 + i for i in range(n)])
    return r


def rows_of(text):
    return list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))


class RecorderCsvTest(unittest.TestCase):
    def test_all_columns(self):
        rows = rows_of(make_recorder().csv())
        self.assertEqual(len(rows), 4)          # header + 3
        self.assertEqual(rows[0], ["t_ms", "sig0", "sig1", "sig2", "sig3"])
        self.assertEqual(len(rows[1]), 5)
        self.assertEqual(rows[1][1:], ["0", "1", "2", "3"])

    def test_selected_subset(self):
        rows = rows_of(make_recorder().csv(["sig1", "sig3"]))
        self.assertEqual(rows[0], ["t_ms", "sig1", "sig3"])
        self.assertEqual(len(rows[1]), 3)
        self.assertEqual(rows[1][1:], ["1", "3"])

    def test_unknown_ids_fall_back_to_all_columns(self):
        # 过期 recordSel（旧固件信号 id）不能产生“只有 t_ms”的坏 CSV
        text = make_recorder().csv(["old.signal.that.does.not.exist"])
        rows = rows_of(text)
        self.assertEqual(rows[0], ["t_ms", "sig0", "sig1", "sig2", "sig3"])
        for row in rows[1:]:
            self.assertEqual(len(row), 5)
            self.assertNotEqual(row[1:], [""])

    def test_partial_unknown_ids_keep_valid_columns(self):
        rows = rows_of(make_recorder().csv(["nope", "sig2"]))
        self.assertEqual(rows[0], ["t_ms", "sig2"])
        self.assertEqual(rows[1][1], "2")


if __name__ == "__main__":
    unittest.main()
