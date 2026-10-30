# -*- coding: utf-8 -*-
"""CH32V203 / RISC-V Flash 编程（寄存器级标准编程）.

设计:
  * 目标必须 halt；所有寄存器用 mww，Flash 半字用 write_memory（progbuf
    内存访问时是 CPU store，满足 FPEC "CPU 写半字" 的要求）。
  * 每个系列一个 FlashSpec；CH32V203 先实现，CW32/其它后续补表。
  * 不依赖 OpenOCD 的 flash 驱动，直接走 Tcl RPC。
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


@dataclass(frozen=True)
class FlashSpec:
    name: str
    base: int
    size: int
    page_size: int
    sector_size: int
    keyr: int
    statr: int
    ctlr: int
    addr: int
    key1: int = 0x45670123
    key2: int = 0xCDEF89AB
    bit_pg: int = 0
    bit_per: int = 1
    bit_mer: int = 2
    bit_eop: int = 5
    bit_strt: int = 6
    bit_lock: int = 7
    bit_bsy: int = 0
    bit_wrprt: int = 4
    erased: int = 0xFF
    program_width: int = 2
    alias_base: int = 0x00000000


CH32V203 = FlashSpec(
    name="CH32V203",
    base=0x08000000,
    size=64 * 1024,
    page_size=256,
    sector_size=4096,
    keyr=0x40022004,
    statr=0x4002200C,
    ctlr=0x40022010,
    addr=0x40022014,
)


class FlashError(RuntimeError):
    pass


def _spec_canonical(spec: "FlashSpec", address: int) -> int:
    if spec.base <= address < spec.base + spec.size:
        return address
    if spec.alias_base <= address < spec.alias_base + spec.size:
        return address + (spec.base - spec.alias_base)
    return address


class FlashDriver:
    def __init__(self, client: Any, spec: FlashSpec = CH32V203,
                 log: Optional[Callable[[str], None]] = None):
        self.c = client
        self.spec = spec
        self.log = log or (lambda _s: None)
        self._halted = False

    # ---- 基础 ----
    def _cmd(self, text: str) -> str:
        return self.c.command(text)

    def _read32(self, addr: int) -> int:
        return int(self.c.read_words(int(addr) & ~0x3, 1)[0])

    def _write32(self, addr: int, value: int) -> None:
        self._cmd("mww 0x%08x 0x%x" % (int(addr), int(value) & 0xFFFFFFFF))

    def halt(self) -> None:
        try:
            self._cmd("halt")
        except Exception:
            pass
        self._halted = True

    def resume(self) -> None:
        if not self._halted:
            return
        try:
            self._cmd("resume")
        except Exception:
            pass
        self._halted = False

    def use_progbuf(self) -> None:
        """让 write_memory 走 progbuf（CPU 指令），Flash 编程需要 CPU store。"""
        try:
            self._cmd("riscv set_mem_access progbuf")
        except Exception:
            pass

    # ---- Flash 控制器 ----
    def wait_ready(self, timeout: float = 5.0) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            st = self._read32(self.spec.statr)
            if not (st & (1 << self.spec.bit_bsy)):
                if st & (1 << self.spec.bit_wrprt):
                    raise FlashError("Flash 写保护错误 (STATR=0x%08x)" % st)
                return st
            time.sleep(0.001)
        raise FlashError("Flash 忙等待超时")

    def clear_eop(self) -> None:
        self._write32(self.spec.statr, 1 << self.spec.bit_eop)

    def unlock(self) -> None:
        ctl = self._read32(self.spec.ctlr)
        if not (ctl & (1 << self.spec.bit_lock)):
            return
        self._write32(self.spec.keyr, self.spec.key1)
        self._write32(self.spec.keyr, self.spec.key2)
        ctl = self._read32(self.spec.ctlr)
        if ctl & (1 << self.spec.bit_lock):
            raise FlashError("Flash 解锁失败 (CTLR=0x%08x)" % ctl)

    def lock(self) -> None:
        ctl = self._read32(self.spec.ctlr)
        self._write32(self.spec.ctlr, ctl | (1 << self.spec.bit_lock))

    def erase_sector(self, address: int) -> None:
        a = int(address) & ~(self.spec.sector_size - 1)
        self.wait_ready()
        ctl = self._read32(self.spec.ctlr)
        self._write32(self.spec.ctlr, ctl | (1 << self.spec.bit_per))
        self._write32(self.spec.addr, a)
        self._write32(self.spec.ctlr,
                      self._read32(self.spec.ctlr) | (1 << self.spec.bit_strt))
        self.wait_ready(timeout=10.0)
        self.clear_eop()
        self._write32(self.spec.ctlr,
                      self._read32(self.spec.ctlr) & ~(1 << self.spec.bit_per))

    def program_halfword(self, address: int, value: int) -> None:
        if address & 1:
            raise FlashError("Flash 编程地址必须偶地址: 0x%x" % address)
        self._cmd("write_memory 0x%08x 16 0x%04x" % (address, int(value) & 0xFFFF))
        self.wait_ready()
        self.clear_eop()

    def program(self, address: int, data: bytes) -> None:
        if len(data) % 2:
            data = data + bytes([self.spec.erased])
        self.wait_ready()
        ctl = self._read32(self.spec.ctlr)
        self._write32(self.spec.ctlr, ctl | (1 << self.spec.bit_pg))
        try:
            for i in range(0, len(data), 2):
                self.program_halfword(address + i,
                                      data[i] | (data[i + 1] << 8))
        finally:
            self._write32(self.spec.ctlr,
                          self._read32(self.spec.ctlr) & ~(1 << self.spec.bit_pg))

    def read(self, address: int, count: int) -> bytes:
        words = self.c.read_regions([(int(address) & ~0x3, (count + 3) // 4)])
        raw = b"".join(int(w).to_bytes(4, "little") for w in words)
        return raw[:count]

    def verify(self, address: int, data: bytes) -> Tuple[bool, Optional[int]]:
        address = _spec_canonical(self.spec, address)
        got = self.read(address, len(data))
        for i, (a, b) in enumerate(zip(got, data)):
            if a != b:
                return False, address + i
        return True, None

    def program_image(self, address: int, data: bytes, erase: bool = True,
                      verify: bool = True) -> Dict[str, Any]:
        spec = self.spec
        address = _spec_canonical(spec, address)
        if address < spec.base or address + len(data) > spec.base + spec.size:
            raise FlashError("地址超出 Flash 范围: 0x%x + %d" % (address, len(data)))
        start = address & ~(spec.sector_size - 1)
        end = (address + len(data) + spec.sector_size - 1) & ~(spec.sector_size - 1)
        self.halt()
        self.use_progbuf()
        try:
            self.unlock()
            if erase:
                for a in range(start, end, spec.sector_size):
                    self.log("擦除 0x%08x" % a)
                    self.erase_sector(a)
            self.log("编程 0x%08x .. 0x%08x (%d B)" % (address, address + len(data), len(data)))
            self.program(address, data)
            ok, bad = (True, None)
            if verify:
                ok, bad = self.verify(address, data)
                if not ok:
                    raise FlashError("校验失败 @0x%08x" % bad)
            return {"ok": True, "bytes": len(data), "start": address,
                    "erase": erase, "verified": bool(verify and ok)}
        finally:
            try:
                self.lock()
            finally:
                self.resume()


# ---------------------------------------------------------------- 文件格式
def parse_ihex(text: str) -> Tuple[int, bytes]:
    """Intel HEX -> (起始地址, 连续数据)；空洞填 0xFF。"""
    mem: Dict[int, int] = {}
    upper = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] != ":":
            continue
        try:
            n = int(line[1:3], 16)
            addr = int(line[3:7], 16)
            typ = int(line[7:9], 16)
            payload = bytes.fromhex(line[9:9 + n * 2])
        except ValueError:
            continue
        if typ == 0x00:
            for i, b in enumerate(payload):
                mem[upper + addr + i] = b
        elif typ == 0x04 and len(payload) >= 2:
            upper = int.from_bytes(payload[:2], "big") << 16
        elif typ == 0x01:
            break
    if not mem:
        raise FlashError("HEX 里没有数据")
    lo, hi = min(mem), max(mem)
    buf = bytearray([0xFF]) * (hi - lo + 1)
    for a, b in mem.items():
        buf[a - lo] = b
    return lo, bytes(buf)


def load_elf(path: str) -> List[Tuple[int, bytes]]:
    from elftools.elf.elffile import ELFFile
    out: List[Tuple[int, bytes]] = []
    with open(path, "rb") as f:
        elf = ELFFile(f)
        for seg in elf.iter_segments():
            if seg.header.p_type != "PT_LOAD":
                continue
            data = seg.data()
            if data:
                out.append((int(seg.header.p_paddr), data))
    return out


def load_file(path: str) -> List[Tuple[int, bytes]]:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".hex", ".ihx"):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return [parse_ihex(f.read())]
    if ext in (".elf", ".axf"):
        return load_elf(path)
    with open(path, "rb") as f:
        return [(CH32V203.base, f.read())]
