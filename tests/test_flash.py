# -*- coding: utf-8 -*-
"""FlashDriver 时序单测（模拟 CH32V203 的 FPEC 寄存器行为，不接硬件）。"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import flash
from flash import FlashDriver, CH32V203


class FakeTarget:
    def __init__(self):
        self.regs = {
            CH32V203.ctlr: 1 << CH32V203.bit_lock,
            CH32V203.statr: 0,
            CH32V203.addr: 0,
        }
        self.flash = bytearray([0xFF]) * CH32V203.size
        self.keys = []
        self.halted = False
        self.pg_writes = 0

    def command(self, text):
        parts = text.split()
        if not parts:
            return ""
        if parts[0] == "halt":
            self.halted = True
            return ""
        if parts[0] == "resume":
            self.halted = False
            return ""
        if parts[0] == "mww":
            addr = int(parts[1], 0)
            val = int(parts[2], 0)
            self._write32(addr, val)
            return ""
        if parts[0] == "write_memory":
            addr = int(parts[1], 0)
            width = int(parts[2], 0)
            val = int(parts[3], 0)
            assert width == 16
            assert self.halted
            off = addr - CH32V203.base
            self.flash[off:off + 2] = val.to_bytes(2, "little")
            self.pg_writes += 1
            self.regs[CH32V203.statr] |= 1 << CH32V203.bit_eop
            return ""
        if parts[:2] == ["riscv", "set_mem_access"]:
            return ""
        raise AssertionError("unexpected command: " + text)

    def _write32(self, addr, val):
        if addr == CH32V203.keyr:
            self.keys.append(val)
            if len(self.keys) >= 2 and self.keys[-2:] == [CH32V203.key1, CH32V203.key2]:
                self.regs[CH32V203.ctlr] &= ~(1 << CH32V203.bit_lock)
            return
        if addr == CH32V203.statr:
            if val & (1 << CH32V203.bit_eop):
                self.regs[CH32V203.statr] &= ~(1 << CH32V203.bit_eop)
            return
        if addr == CH32V203.addr:
            self.regs[CH32V203.addr] = val
            return
        if addr == CH32V203.ctlr:
            old = self.regs[CH32V203.ctlr]
            self.regs[CH32V203.ctlr] = val
            if val & (1 << CH32V203.bit_strt):
                if val & (1 << CH32V203.bit_per):
                    a = self.regs[CH32V203.addr]
                    off = (a & ~(CH32V203.sector_size - 1)) - CH32V203.base
                    self.flash[off:off + CH32V203.sector_size] = bytes([0xFF]) * CH32V203.sector_size
                    self.regs[CH32V203.statr] |= 1 << CH32V203.bit_eop
                self.regs[CH32V203.ctlr] = val & ~(1 << CH32V203.bit_strt)
            return
        raise AssertionError("unexpected write 0x%x" % addr)

    def read_words(self, addr, count):
        out = []
        for i in range(count):
            a = addr + i * 4
            if a in self.regs:
                out.append(self.regs[a])
            else:
                off = a - CH32V203.base
                out.append(int.from_bytes(self.flash[off:off + 4], "little"))
        return out

    def read_regions(self, regions):
        out = []
        for addr, words in regions:
            out.extend(self.read_words(addr, words))
        return out


class FlashDriverTest(unittest.TestCase):
    def setUp(self):
        self.t = FakeTarget()
        self.d = FlashDriver(self.t, CH32V203)

    def test_unlock_and_lock(self):
        self.d.halt()
        self.d.unlock()
        self.assertFalse(self.t.regs[CH32V203.ctlr] & (1 << CH32V203.bit_lock))
        self.d.lock()
        self.assertTrue(self.t.regs[CH32V203.ctlr] & (1 << CH32V203.bit_lock))

    def test_erase_sector(self):
        self.t.flash[0:8] = b"\x11" * 8
        self.d.halt()
        self.d.unlock()
        self.d.erase_sector(CH32V203.base)
        self.assertEqual(self.t.flash[0:8], b"\xff" * 8)
        self.assertFalse(self.t.regs[CH32V203.statr] & (1 << CH32V203.bit_eop))

    def test_program_and_verify(self):
        data = bytes(range(0, 32))
        self.d.program_image(CH32V203.base, data)
        self.assertEqual(bytes(self.t.flash[0:len(data)]), data)
        self.assertTrue(self.t.halted is False)
        self.assertTrue(self.t.regs[CH32V203.ctlr] & (1 << CH32V203.bit_lock))

    def test_verify_detects_mismatch(self):
        self.d.program_image(CH32V203.base, b"\x01\x02")
        ok, bad = self.d.verify(CH32V203.base, b"\x01\x03")
        self.assertFalse(ok)
        self.assertEqual(bad, CH32V203.base + 1)

    def test_alias_zero_base(self):
        self.d.program_image(0x00000000, b"\x11\x22")
        self.assertEqual(bytes(self.t.flash[0:2]), b"\x11\x22")
        ok, bad = self.d.verify(0x00000000, b"\x11\x22")
        self.assertTrue(ok)

    def test_ihex(self):
        text = "\n".join([
            ":020000040800F2",
            ":0400000001020304F2",
            ":00000001FF",
        ])
        base, data = flash.parse_ihex(text)
        self.assertEqual(base, 0x08000000)
        self.assertEqual(data, b"\x01\x02\x03\x04")


if __name__ == "__main__":
    unittest.main()
