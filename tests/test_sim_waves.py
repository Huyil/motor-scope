#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""仿真源测试波形：锯齿/三角/方波/噪声/尖峰/纹波."""
import random
import sys
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from scope_server import sim_test_wave  # noqa: E402


class SimWavesTest(unittest.TestCase):
    def setUp(self):
        self.rand = random.Random(1)

    def test_sawtooth_range_and_reset(self):
        vals = [sim_test_wave("sim.sawtooth", t / 10.0, self.rand) for t in range(0, 33)]
        self.assertGreaterEqual(min(vals), 499)
        self.assertLessEqual(max(vals), 1501)
        self.assertAlmostEqual(vals[0], 500.0, places=3)
        # 1.6s 周期，在 t=1.6 处回到底部附近
        self.assertGreater(sim_test_wave("sim.sawtooth", 1.59, self.rand), 1440)
        self.assertLess(sim_test_wave("sim.sawtooth", 1.60, self.rand), 560)

    def test_triangle_shape(self):
        self.assertAlmostEqual(sim_test_wave("sim.triangle", 0.0, self.rand), 500.0, places=3)
        self.assertAlmostEqual(sim_test_wave("sim.triangle", 0.8, self.rand), 1500.0, places=3)
        self.assertAlmostEqual(sim_test_wave("sim.triangle", 1.6, self.rand), 500.0, places=3)
        self.assertAlmostEqual(sim_test_wave("sim.triangle.1", 0.4, self.rand), 1000.0, places=3)

    def test_square_levels(self):
        self.assertEqual(sim_test_wave("sim.square", 0.1, self.rand), 1500.0)
        self.assertEqual(sim_test_wave("sim.square", 0.8, self.rand), 500.0)
        self.assertEqual(sim_test_wave("sim.square", 1.3, self.rand), 1500.0)

    def test_noise_varies_and_stays_bounded(self):
        vals = [sim_test_wave("sim.noise", t / 20.0, self.rand) for t in range(0, 200)]
        self.assertGreater(max(vals) - min(vals), 100)
        self.assertTrue(all(400 < v < 1600 for v in vals))

    def test_spikes_and_ripple(self):
        spikes = [sim_test_wave("sim.spikes", t / 100.0, self.rand) for t in range(0, 200)]
        self.assertGreater(max(spikes), 1700)
        ripple = [sim_test_wave("sim.ripple", t / 100.0, self.rand) for t in range(0, 200)]
        self.assertGreater(max(ripple) - min(ripple), 300)


if __name__ == "__main__":
    unittest.main()
