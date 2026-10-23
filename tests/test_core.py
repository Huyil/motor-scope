#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope 核心逻辑单测: 区域合并 / 位域解码 / 有符号 / 串口解析."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import ocd
from scope_server import Signal


class PlanRegionsTest(unittest.TestCase):
    def test_default_signals_merge_into_one_block(self):
        spans = [(0x2000033E, 2), (0x20000352, 2), (0x20000354, 2), (0x2000036E, 2)]
        regions = ocd.plan_regions(spans)
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0].addr, 0x2000033C)
        self.assertEqual(regions[0].words, 13)

    def test_far_addresses_split(self):
        regions = ocd.plan_regions([(0x20000004, 4), (0x20000352, 2)])
        self.assertEqual(len(regions), 2)

    def test_decode_word(self):
        region = ocd.Region(0x2000033C, 13, 0x20000370)
        words = [0] * 13
        # 0x350 低半字 = stopThreshold 0x32, 0x352 高半字 = current 1234
        words[5] = (1234 << 16) | 0x0032
        self.assertEqual(ocd.decode_word(words[5], 0x20000350, region, 2), 0x32)
        self.assertEqual(ocd.decode_word(words[5], 0x20000352, region, 2), 1234)

    def test_parse_int_list(self):
        self.assertEqual(ocd._parse_int_list("1 2 0x10\n", 3), [1, 2, 16])
        self.assertEqual(ocd._parse_int_list("{0 0x32 0xdc}", 3), [0, 50, 220])
        with self.assertRaises(ocd.OcdError):
            ocd._parse_int_list("1 2", 3)


class SignalTest(unittest.TestCase):
    def test_bitfield(self):
        s = Signal({"id": "ADC.CR.BGREN", "name": "ADC.CR.BGREN",
                    "addr": 0x40000000, "size": 4, "bit": [1, 1]})
        self.assertEqual(s.decode(0x00000002), 1)
        self.assertEqual(s.decode(0x00000000), 0)

    def test_multibit(self):
        s = Signal({"id": "ADC.SAMPLE.SQRCH2", "name": "ADC.SAMPLE.SQRCH2",
                    "addr": 0x40000028, "size": 4, "bit": [8, 4]})
        self.assertEqual(s.decode(0xABC), 0xA)

    def test_signed(self):
        s = Signal({"id": "sys.BATLevel", "name": "sys.BATLevel",
                    "addr": 0x20000024, "size": 1, "signed": True})
        self.assertEqual(s.decode(0xFF), -1)
        self.assertEqual(s.decode(0x7F), 127)

    def test_axis_and_unit(self):
        vol = Signal({"id": "motor.Scfg.vol", "name": "motor.Scfg.vol",
                      "addr": 0, "size": 2})
        cur = Signal({"id": "motor.over.current", "name": "motor.over.current",
                      "addr": 0, "size": 2})
        self.assertEqual(vol.axis, "right")
        self.assertEqual(vol.unit, "duty")
        self.assertEqual(cur.axis, "left")
        self.assertEqual(cur.unit, "counts")


if __name__ == "__main__":
    unittest.main(verbosity=2)
