#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope 核心逻辑单测: 区域合并 / 位域解码 / 有符号 / 串口解析."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import ocd
from scope_server import App, Signal, SimSource

from types import SimpleNamespace

PROJECT_ROOT = os.path.dirname(HERE)


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


class _NoWriteSource(SimSource):
    """模拟固件/寄存器不接受写入: 写入被丢弃，回读与请求值不一致."""

    def write(self, addr, size, value):
        pass


class WriteValueTest(unittest.TestCase):
    """POST /api/write 的核心路径: 范围/对齐校验、读回、位域 RMW、仿真覆盖."""

    def setUp(self):
        args = SimpleNamespace(
            project=PROJECT_ROOT,
            axf=os.path.join(PROJECT_ROOT, "MDK", "Objects", "DR2159.axf"),
            header="",
            signals=os.path.join(PROJECT_ROOT, "signals.json"),
            openocd="", iface="", target="", verbose=False, rate=100.0,
        )
        self.app = App(args)
        self.src = SimSource()
        self.app.source = self.src

    def tearDown(self):
        self.app.source = None

    def test_not_connected(self):
        self.app.source = None
        with self.assertRaises(RuntimeError):
            self.app.write_value({"addr": 0x20000352, "size": 2, "value": 1})

    def test_rejects_bad_size_and_alignment(self):
        with self.assertRaises(RuntimeError):
            self.app.write_value({"addr": 0x20000352, "size": 3, "value": 1})
        with self.assertRaises(RuntimeError):
            self.app.write_value({"addr": 0x20000353, "size": 2, "value": 1})

    def test_rejects_illegal_address(self):
        with self.assertRaises(RuntimeError):
            self.app.write_value({"addr": 0x30000000, "size": 2, "value": 1})
        with self.assertRaises(RuntimeError):
            self.app.write_value({"addr": 0x18000000, "size": 2, "value": 1})
        # 跨越 RAM 末尾 0x2000_2000，不能只校验起始地址
        with self.assertRaises(RuntimeError):
            self.app.write_value({"addr": 0x20001FFF, "size": 2, "value": 1})

    def test_u16_write_and_readback(self):
        r = self.app.write_value({"addr": 0x20000352, "size": 2, "value": 1500})
        self.assertTrue(r["verified"])
        self.assertEqual(r["readback"], 1500)
        sig = Signal({"id": "motor.over.threshold", "name": "motor.over.threshold",
                      "addr": 0x20000352, "size": 2})
        self.assertEqual(self.src.read([sig])[0], 1500)

    def test_byte_write_readback(self):
        r = self.app.write_value({"addr": 0x20000353, "size": 1, "value": 0xAB})
        self.assertTrue(r["verified"])
        self.assertEqual(r["readback"], 0xAB)
        self.assertEqual(self.src.read_word(0x20000350) >> 24 & 0xFF, 0xAB)

    def test_bitfield_rmw_preserves_neighbors(self):
        self.src.write(0x40000000, 4, 0xFFFF00FF)
        r = self.app.write_value({"addr": 0x40000000, "size": 4, "value": 0xA,
                                  "bit": [8, 4]})
        self.assertTrue(r["verified"])
        self.assertEqual(r["readback"], 0xA)
        self.assertEqual(self.src.read_word(0x40000000), 0xFFFF0AFF)

    def test_readback_mismatch_is_reported(self):
        self.app.source = _NoWriteSource()
        r = self.app.write_value({"addr": 0x20000352, "size": 2, "value": 1500})
        self.assertFalse(r["verified"])
        self.assertEqual(r["readback"], 0)

    def test_value_masked_to_width(self):
        r = self.app.write_value({"addr": 0x20000352, "size": 2, "value": 0x1FFFF})
        self.assertEqual(r["value"], 0xFFFF)
        self.assertTrue(r["verified"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
