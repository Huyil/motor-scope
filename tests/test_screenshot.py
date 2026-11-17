#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""screenshot.py 纯 Python PNG 渲染单测（不启动 HTTP 服务）。"""
from __future__ import annotations

import struct
import unittest

import screenshot


def png_size(data: bytes):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError("not a PNG")
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def signals(n=2):
    out = []
    for i in range(n):
        out.append({
            "id": "sig%d" % i, "name": "channel_%d" % i,
            "scale": 1.0, "offset": 0.0, "unit": "V",
            "step": i == 1, "color": "#22d3ee" if i == 0 else "#f59e0b",
        })
    return out


class ScreenshotRenderTest(unittest.TestCase):
    def test_png_dimensions_and_stats(self):
        samples = [[i * 10.0, [i * 0.5, 1 if (i // 2) % 2 else 0]] for i in range(100)]
        shot = screenshot.render(signals(), samples, width=800,
                                 title="unit test", profile="P", mcu="M",
                                 sample_rate=100.0)
        self.assertEqual(shot["width"], 800)
        self.assertGreater(shot["height"], 200)
        self.assertEqual(png_size(shot["png"]), (800, shot["height"]))
        self.assertEqual(shot["sample_count"], 100)
        self.assertEqual(shot["channels"], 2)
        self.assertEqual(shot["signals"][0]["min"], 0.0)
        self.assertEqual(shot["signals"][0]["max"], 49.5)
        self.assertEqual(shot["signals"][1]["min"], 0.0)
        self.assertEqual(shot["signals"][1]["max"], 1.0)
        self.assertIn("range", shot)
        self.assertEqual(shot["range"]["start_ms"], 0.0)
        self.assertEqual(shot["range"]["end_ms"], 990.0)

    def test_empty_samples_raises(self):
        with self.assertRaises(ValueError):
            screenshot.render(signals(), [])

    def test_empty_signals_raises(self):
        with self.assertRaises(ValueError):
            screenshot.render([], [[0.0, []]])

    def test_all_equal_values_do_not_divide_by_zero(self):
        samples = [[i * 10.0, [5.0, 5.0]] for i in range(50)]
        shot = screenshot.render(signals(), samples, width=640)
        self.assertEqual(png_size(shot["png"])[0], 640)
        self.assertEqual(shot["signals"][0]["min"], 5.0)
        self.assertEqual(shot["signals"][0]["max"], 5.0)

    def test_dense_bucket_path(self):
        samples = []
        for i in range(6000):
            samples.append([i * 2.0, [i % 100, 1 if (i // 500) % 2 else 0]])
        shot = screenshot.render(signals(), samples, width=800)
        self.assertEqual(shot["sample_count"], 6000)
        self.assertEqual(png_size(shot["png"])[0], 800)

    def test_channel_limit_and_theme(self):
        samples = [[0.0, [1, 2, 3]], [10.0, [2, 3, 4]]]
        shot = screenshot.render(signals(3), samples, width=600,
                                 max_channels=2, theme="dark")
        self.assertEqual(shot["channels"], 2)
        self.assertEqual(shot["theme"], "dark")
        self.assertEqual(len(shot["signals"]), 2)

    def test_default_is_web_dark_with_dual_time_axes(self):
        samples = [[i * 10.0, [i * 0.5, 1 if (i // 2) % 2 else 0]]
                   for i in range(100)]
        shot = screenshot.render(signals(), samples, width=900)
        self.assertEqual(shot["theme"], "dark")
        self.assertEqual(shot["layout"], "web-panes")
        self.assertEqual(shot["axes"]["bottom"]["kind"], "absolute")
        self.assertEqual(shot["axes"]["left"]["kind"], "relative")
        self.assertEqual(shot["axes"]["left"]["start_ms"], 0.0)
        self.assertEqual(shot["axes"]["left"]["end_ms"], 990.0)
        self.assertGreaterEqual(shot["axes"]["x_major"], 5)
        self.assertGreaterEqual(shot["axes"]["x_minor"], 2)
        self.assertGreaterEqual(shot["axes"]["y_minor"], 2)

    def test_small_axis_steps_have_distinct_labels(self):
        labels = [screenshot._fmt_axis_prec(v, 0.00027)
                  for v in (0.0, 0.00027, 0.00054, 0.00081)]
        self.assertEqual(len(set(labels)), 4)
        self.assertEqual(screenshot._fmt_num(2400), "2400")
        self.assertEqual(screenshot._fmt_num(0.0), "0")

    def test_height_option(self):
        samples = [[i * 10.0, [i * 0.5, i % 2]] for i in range(100)]
        shot = screenshot.render(signals(), samples, width=800, height=700)
        self.assertEqual(shot["width"], 800)
        self.assertEqual(shot["height"], 700)
        self.assertEqual(png_size(shot["png"]), (800, 700))


if __name__ == "__main__":
    unittest.main()
