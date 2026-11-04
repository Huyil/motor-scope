#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""芯片识别单元测试：CW32 签名区 / LKS32MC07x AFE_INFO / CH32 ESIG。

用假 Source 只返回值，不连硬件。
"""
from __future__ import annotations

import json
import os
import unittest

import scope_server as S

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "..", "web", "mcu", "index.json")


class FakeSource:
    kind = "openocd"

    def __init__(self, words=None, default=0):
        self.words = dict(words or {})
        self.default = default

    def read_word(self, addr: int) -> int:
        return int(self.words.get(int(addr), self.default))


def _signature(text: str) -> dict:
    raw = text.encode("ascii").ljust(16, b"\x00")
    out = {}
    for i in range(0, 16, 4):
        out[0x001007E0 + i] = int.from_bytes(raw[i:i + 4], "little")
    return out


class TestChipProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(INDEX, encoding="utf-8") as f:
            cls.index = json.load(f)

    def test_lks_afe_info(self) -> None:
        words = _signature("")            # 同地址不是 CW32 串
        words[0xE000ED00] = 0x410CC200    # Cortex-M0
        words[0x40000004] = (7 << 4) | 9  # Series=7, Version=9
        words[0x0002001C] = 2 << 6        # FLASH_SIZE[7:6]=2 -> 128KB
        chip = S.probe_chip(FakeSource(words), self.index, "LKS32MC07x")
        self.assertEqual(chip["detected"], "LKS32MC07x")
        self.assertEqual(chip["vendor"], "Linko")
        self.assertEqual(chip["family"], "LKS32MC07x")
        self.assertFalse(chip["exact"])
        self.assertTrue(chip["match"])
        self.assertEqual(chip["evidence"]["lks_series"], 7)
        self.assertEqual(chip["evidence"]["lks_version"], 9)
        self.assertEqual(chip["evidence"]["flash_kb"], 128)

    def test_lks_mismatch_warns(self) -> None:
        words = _signature("")
        words[0xE000ED00] = 0x410CC200
        words[0x40000004] = (7 << 4) | 4
        chip = S.probe_chip(FakeSource(words), self.index, "CW32L011")
        self.assertFalse(chip["match"])
        self.assertIn("不一致", chip["warning"])

    def test_cw32_signature_with_package_suffix(self) -> None:
        words = _signature("CW32L011K8U6")
        words[0xE000ED00] = 0x410CC601
        chip = S.probe_chip(FakeSource(words), self.index, "CW32L011")
        self.assertEqual(chip["detected"], "CW32L011K8U6")
        self.assertEqual(chip["family"], "CW32L0")
        self.assertTrue(chip["exact"])
        self.assertEqual(chip["candidates"], ["CW32L011"])
        self.assertTrue(chip["match"])

    def test_ch32_esig_family(self) -> None:
        words = {0xE000ED00: 0, 0x1FFFF7E0: 64,
                 0x1FFFF7E8: 1, 0x1FFFF7EC: 2, 0x1FFFF7F0: 3}
        chip = S.probe_chip(FakeSource(words), self.index, "CH32V203C8T6")
        self.assertEqual(chip["detected"], "CH32V203")
        self.assertEqual(chip["candidates"], ["CH32V203C8T6", "CH32V203K8T6"])
        self.assertFalse(chip["exact"])
        self.assertTrue(chip["match"])

    def test_non_arm_no_false_positive(self) -> None:
        words = {0xE000ED00: 0x12345678, 0x1FFFF7E0: 0}
        chip = S.probe_chip(FakeSource(words), self.index, "")
        self.assertFalse(chip["detected"])
        self.assertIsNone(chip["match"])


if __name__ == "__main__":
    unittest.main()
