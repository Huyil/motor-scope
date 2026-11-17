#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""screenshot_data / screenshot_info 的时间窗与信号选择单测。"""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace

import screenshot
from scope_server import App, Signal

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ScreenshotDataTest(unittest.TestCase):
    def setUp(self) -> None:
        args = SimpleNamespace(
            project=PROJECT_ROOT,
            axf=os.path.join(PROJECT_ROOT, "MDK", "Objects", "DR2159.axf"),
            header="", signals=os.path.join(PROJECT_ROOT, "signals.json"),
            openocd="", iface="", target="", verbose=False, rate=100.0,
            record_cache_dir=None, no_record_cache=True,
            record_cache_limit_mb=1, record_cache_block_points=100,
        )
        self.app = App(args)
        self.app.source = None
        self.sig_a = Signal({"id": "a", "name": "a", "addr": 0x20000000,
                             "size": 2, "scale": 2.0, "offset": 1.0,
                             "unit": "V", "color": "#22d3ee"})
        self.sig_b = Signal({"id": "b", "name": "b", "addr": 0x20000002,
                             "size": 1, "step": True})
        self.app.sampler.set_signals([self.sig_a, self.sig_b], 100.0)
        with self.app.sampler._lock:
            for i in range(100):
                self.app.sampler.history.append([i * 10.0, [i, 1 if (i // 10) % 2 else 0]])
            self.app.sampler.last_t = 990.0

    def tearDown(self) -> None:
        try:
            self.app.source = None
        except Exception:
            pass

    def test_all_time_and_info(self) -> None:
        info = self.app.screenshot_info()
        self.assertTrue(info["available"])
        self.assertEqual(info["source"], "history")
        self.assertEqual(info["sample_count"], 100)
        self.assertEqual(info["oldest"], 0.0)
        self.assertEqual(info["latest"], 990.0)
        self.assertEqual([s["id"] for s in info["signals"]], ["a", "b"])
        self.assertEqual(info["defaults"]["theme"], "dark")
        self.assertEqual(info["render"]["style"], "web-panes")
        self.assertEqual(info["render"]["time_axes"], ["bottom-abs", "left-rel-0"])

        data = self.app.screenshot_data(all_time=True)
        self.assertEqual(data["source"], "history")
        self.assertEqual(data["sample_count"], 100)
        self.assertEqual(data["start"], 0.0)
        self.assertEqual(data["end"], 990.0)
        self.assertEqual(len(data["signals"]), 2)
        self.assertEqual(data["samples"][10][1][0], 10)
        shot = screenshot.render(data["signals"], data["samples"], width=800)
        self.assertEqual(shot["sample_count"], 100)

    def test_seconds_window(self) -> None:
        data = self.app.screenshot_data(seconds=0.5)
        self.assertGreaterEqual(data["start"], 490.0)
        self.assertEqual(data["end"], 990.0)
        self.assertLessEqual(data["sample_count"], 51)

    def test_explicit_range_and_clamp(self) -> None:
        data = self.app.screenshot_data(start=100.0, end=250.0)
        self.assertEqual(data["start"], 100.0)
        self.assertEqual(data["end"], 250.0)
        self.assertFalse(data["clamped"])
        data2 = self.app.screenshot_data(start=-100.0, end=50.0)
        self.assertTrue(data2["clamped"])
        self.assertEqual(data2["start"], 0.0)
        with self.assertRaises(RuntimeError):
            self.app.screenshot_data(start=5000.0, end=6000.0)

    def test_signal_selection(self) -> None:
        data = self.app.screenshot_data(all_time=True, signal_ids=["b"])
        self.assertEqual(len(data["signals"]), 1)
        self.assertEqual(data["signals"][0]["id"], "b")
        self.assertTrue(all(len(row[1]) == 1 for row in data["samples"]))
        self.assertEqual(data["samples"][0][1][0], 0)

    def test_missing_signal_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            self.app.screenshot_data(all_time=True, signal_ids=["nope"])

    def test_max_channels_truncates(self) -> None:
        data = self.app.screenshot_data(all_time=True, max_channels=1)
        self.assertEqual(len(data["signals"]), 1)
        self.assertTrue(data["truncated"])

    def test_wall_clock_start(self) -> None:
        start = self.app.wall_start_ms()
        self.assertIsNotNone(start)
        self.assertGreater(start, 1_600_000_000_000)


if __name__ == "__main__":
    unittest.main()
