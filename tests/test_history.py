#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""history_before / history_after 的游标、gap、long-poll 行为."""
import os
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from scope_server import Hub, Sampler, Signal  # noqa: E402


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.s = Sampler(Hub())
        self.s.set_signals(
            [Signal({"id": "x", "name": "x", "addr": 0x20000000, "size": 2})], 100)
        for i in range(10):
            with self.s._cond:
                self.s.history.append([float(i * 10), [i]])
                self.s.last_t = float(i * 10)
                self.s._cond.notify_all()

    def tearDown(self):
        self.s.stop()

    def test_same_config_keeps_generation(self):
        g = self.s.generation
        self.s.set_signals(list(self.s.signals), 100)
        self.assertEqual(self.s.generation, g)
        self.assertEqual(len(self.s.history), 10)

    def test_before_default(self):
        r = self.s.history_before(None, 3)
        self.assertEqual([x[1][0] for x in r["samples"]], [7, 8, 9])
        self.assertEqual(r["cursor"], 90.0)
        self.assertEqual(r["generation"], 1)
        self.assertEqual(len(r["signals"]), 1)
        self.assertFalse(r["gap"])

    def test_before_cursor(self):
        r = self.s.history_before(55, 2)
        self.assertEqual([x[1][0] for x in r["samples"]], [4, 5])
        self.assertEqual(r["cursor"], 50.0)

    def test_before_older_than_ring(self):
        r = self.s.history_before(-1, 2)
        self.assertTrue(r["gap"])
        self.assertEqual(r["samples"], [])

    def test_after_available(self):
        r = self.s.history_after(85, 2, 0)
        self.assertEqual([x[1][0] for x in r["samples"]], [9])
        self.assertFalse(r["timeout"])
        self.assertFalse(r["gap"])

    def test_after_gap(self):
        r = self.s.history_after(-100, 2, 0)
        self.assertTrue(r["gap"])
        self.assertEqual([x[1][0] for x in r["samples"]], [0, 1])

    def test_after_timeout(self):
        t0 = time.monotonic()
        r = self.s.history_after(95, 2, 0.15)
        elapsed = time.monotonic() - t0
        self.assertTrue(r["timeout"])
        self.assertEqual(r["samples"], [])
        self.assertGreaterEqual(elapsed, 0.10)

    def test_generation_change_breaks_wait(self):
        out = {}

        def waiter():
            out["r"] = self.s.history_after(95, 2, 3.0)

        th = threading.Thread(target=waiter, daemon=True)
        th.start()
        time.sleep(0.1)
        self.s.set_signals(
            [Signal({"id": "y", "name": "y", "addr": 0x20000004, "size": 2})], 100)
        th.join(1.0)
        self.assertFalse(th.is_alive())
        self.assertTrue(out["r"]["reset"])
        self.assertTrue(out["r"]["gap"])
        self.assertEqual(out["r"]["samples"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
