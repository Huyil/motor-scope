#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope —— 基于 OpenOCD 的电机电流 / 堵转阈值波形观察台.

架构:
    浏览器 UI  <--HTTP/SSE-->  scope_server.py  <--Tcl RPC (tcl_port)-->  openocd.exe
                                      |
                                      +-- 读 AXF/DWARF 得到变量/寄存器地址 (gen_signals.py)

设计要点:
  * 采样用 OpenOCD 的 Tcl read_memory, 不 halt 内核, 电机可以边跑边看;
  * 一次 TCP 命令读多个连续区域 (plan_regions), 目标 50~200 Hz;
  * 前端只收原始整数, 缩放/单位在前端改, 不用重采样;
  * 没有硬件时可切 "仿真" 源, UI 全功能可演示.

用法:
    python scope_server.py --auto --open
    python scope_server.py --sim --open
    python scope_server.py --attach 127.0.0.1:6666 --open
"""
from __future__ import annotations

import argparse
import atexit
import io
import json
import math
import os
import queue
import random
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, unquote, urlparse

import api_docs
import profiles
import usb_devices
from record_cache import RecordCache

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_DEFAULT = os.path.abspath(os.path.join(HERE, "..", ".."))
WEB_DIR = os.path.join(HERE, "web")
SIGNALS_JSON = os.path.join(HERE, "signals.json")
PROFILES_DIR = os.path.join(HERE, "profiles")
VERSION = "0.1.0"

_AXIS_RIGHT = re.compile(
    r"(vol|speed|level|state|power|conts|tick|duty|ccr|arr|batlevel|direction|overlevel)",
    re.I,
)


def default_axis(name: str) -> str:
    """电流/阈值/ADC 走左轴; 电压/转速/档位/状态等上下文走右轴."""
    return "right" if _AXIS_RIGHT.search(name or "") else "left"


def default_unit(name: str) -> str:
    n = name or ""
    if re.search(r"(threshold|current|adc\.RES|offset)", n, re.I):
        return "counts"
    if re.search(r"(vol|ccr|duty)", n, re.I):
        return "duty"
    if re.search(r"speed", n, re.I):
        return "cnt"
    if re.search(r"(tick|msTick)", n, re.I):
        return "ms"
    return ""


MCU_DIR = os.path.join(WEB_DIR, "mcu")
MCU_INDEX = os.path.join(MCU_DIR, "index.json")
CW32_SIGNATURE_ADDR = 0x001007E0   # 16 字节 ASCII 型号
CW32_SIGNATURE_LEN = 16
CH32_ESIG_FLASH_ADDR = 0x1FFFF7E0  # 低 16 位 = Flash KB
CH32_ESIG_UID_ADDR = 0x1FFFF7E8    # 96-bit UID
CORTEX_M0_CPUID = 0x410CC200       # Cortex-M0
CORTEX_M0PLUS_CPUID = 0x410CC601   # Cortex-M0+
ARM_CPUID = (CORTEX_M0_CPUID, CORTEX_M0PLUS_CPUID)
LKS_AFE_INFO_ADDR = 0x40000004     # SYS_AFE_INFO: Series[7:4] / Version[3:0]
LKS_SERIES = 7                     # 0x7 = LKS32MC07x


def load_mcu_index() -> Dict[str, Any]:
    """读 web/mcu/index.json（网页端同一份数据）；缺失/损坏时返回空表。"""
    try:
        with open(MCU_INDEX, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("models"), list):
            return data
    except Exception:
        pass
    return {"schema": 0, "models": []}


def find_mcu_template(mcu: str) -> str:
    """按型号/系列匹配内置寄存器模板；CH32V203 可命中 C8T6/K8T6。"""
    up = str(mcu or "").strip().upper()
    if not up:
        return ""
    for m in load_mcu_index().get("models") or []:
        mid = str(m.get("id") or "")
        fam = str((m.get("identify") or {}).get("family") or "")
        mu = mid.upper()
        if mu == up or (fam and fam.upper() == up) or mu.startswith(up) or up.startswith(mu):
            return mid
    return ""


def _svd_peripherals(path: str) -> List[Dict[str, Any]]:
    """复用 tools/build_mcu_tables.py 的 SVD 解析（derivedFrom/dim/cluster）。"""
    import importlib.util
    tool = os.path.join(HERE, "tools", "build_mcu_tables.py")
    spec = importlib.util.spec_from_file_location("build_mcu_tables", tool)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.build_ch32(path)


def _read_bytes(source: Any, addr: int, length: int) -> bytes:
    buf = bytearray()
    for off in range(0, length, 4):
        word = int(source.read_word(addr + off)) & 0xFFFFFFFF
        buf += word.to_bytes(4, "little")
    return bytes(buf[:length])


def _decode_lks_flash(code: int, ident: Dict[str, Any]) -> int:
    table = ident.get("flash_kb_table") or [32, 64, 128, 128]
    try:
        return int(table[code & 0x3])
    except Exception:
        return 0


def probe_chip(source: Any, index: Dict[str, Any],
               expected: str = "") -> Optional[Dict[str, Any]]:
    """按芯片 ID 区识别型号，并与符号表/固件里的型号比对。

    同一颗 ARM Cortex-M 上要区分两家:
      * CW32L0x: CPUID 0x410CC601/0x410CC200，型号在 0x001007E0 起 16 字节 ASCII；
      * LKS32MC07x: SYS_AFE_INFO @0x4000_0004，Series[7:4]=7，Version[3:0]；
        Flash 容量在 FLASH_SIZE @0x0002_001C 的 [7:6]（0/1/2/3 -> 32/64/128/128KB）。
    非 ARM（CH32V203 RISC-V）: 无 Cortex-M CPUID; Flash 容量在 0x1FFFF7E0（KB），
              UID 在 0x1FFFF7E8。C8/K8 同 die，只能识别到系列。
    """
    if source is None or getattr(source, "kind", "none") == "sim":
        return None
    expected = str(expected or "").strip()
    models = index.get("models") or []
    out: Dict[str, Any] = {
        "detected": "", "vendor": "", "family": "", "exact": False,
        "candidates": [], "expected": expected, "match": None,
        "warning": "", "evidence": {},
    }

    cpuid = None
    try:
        cpuid = int(source.read_word(0xE000ED00)) & 0xFFFFFFFF
        out["evidence"]["cpuid"] = cpuid
    except Exception as exc:
        out["evidence"]["cpuid_error"] = str(exc)

    if cpuid in ARM_CPUID:
        # --- 先试 CW32 签名区: 读失败/不是 "CW32" 就落到 LKS ---
        cw32_type = ""
        try:
            raw = _read_bytes(source, CW32_SIGNATURE_ADDR, CW32_SIGNATURE_LEN)
            text = raw.split(b"\x00", 1)[0].decode("ascii", "replace").strip()
            # LKS 的同地址可能是随机数据: 只保留可打印字符, 避免把乱码写进 evidence
            text = "".join(ch for ch in text if 32 <= ord(ch) < 127)
            out["evidence"]["cw32_type"] = text
            if text.upper().startswith("CW32"):
                cw32_type = text
        except Exception as exc:
            out["evidence"]["cw32_error"] = str(exc)

        if cw32_type:
            out["detected"] = cw32_type
            out["vendor"] = "CW"
            out["family"] = "CW32L0"
            out["exact"] = True
            up = cw32_type.upper()
            cands = []
            for m in models:
                ident = m.get("identify") or {}
                if ident.get("kind") != "cw32-signature":
                    continue
                names = [str(m.get("id") or "").upper()]
                names += [str(a).upper() for a in (m.get("aliases") or [])]
                names += [str(ident.get("expected_type") or "").upper()]
                # 签名区可能带封装/温度后缀 (CW32L011K8U6), 按型号前缀归属
                if any(n and (up == n or up.startswith(n) or n.startswith(up)) for n in names):
                    cands.append(str(m.get("id")))
            out["candidates"] = cands or [cw32_type]
        else:
            # --- Linko LKS32MC07x ---
            for m in models:
                ident = m.get("identify") or {}
                if ident.get("kind") != "lks-afe":
                    continue
                addr = int(str(ident.get("info_addr") or "0x40000004"), 0)
                try:
                    info = int(source.read_word(addr)) & 0xFFFFFFFF
                except Exception as exc:
                    out["evidence"]["lks_error"] = str(exc)
                    break
                series = (info >> int(ident.get("series_shift", 4))) & int(
                    ident.get("series_mask", 0xF))
                version = (info >> int(ident.get("version_shift", 0))) & int(
                    ident.get("version_mask", 0xF))
                out["evidence"]["lks_afe_info"] = info
                out["evidence"]["lks_series"] = series
                out["evidence"]["lks_version"] = version
                if series != int(ident.get("expected_series", LKS_SERIES)):
                    break
                fam = str(ident.get("family") or m.get("id") or "LKS32MC07x")
                out["detected"] = fam
                out["vendor"] = str(m.get("vendor") or "Linko")
                out["family"] = fam
                out["exact"] = False
                out["candidates"] = [
                    str(x.get("id")) for x in models
                    if (x.get("identify") or {}).get("kind") == "lks-afe"
                    and str((x.get("identify") or {}).get("family") or x.get("id")) == fam
                ]
                flash_addr = str(ident.get("flash_size_addr") or "")
                if flash_addr:
                    try:
                        reg = int(source.read_word(int(flash_addr, 0))) & 0xFFFFFFFF
                        code = (reg >> int(ident.get("flash_code_shift", 6))) & int(
                            ident.get("flash_code_mask", 0x3))
                        out["evidence"]["flash_size_code"] = code
                        kb = _decode_lks_flash(code, ident)
                        if kb:
                            out["evidence"]["flash_kb"] = kb
                    except Exception as exc:
                        out["evidence"]["flash_size_error"] = str(exc)
                break
    else:
        # --- CH32V203 (RISC-V ESIG) ---
        try:
            flash_kb = int(source.read_word(CH32_ESIG_FLASH_ADDR)) & 0xFFFF
            out["evidence"]["flash_kb"] = flash_kb
            cands = [m for m in models
                     if (m.get("identify") or {}).get("kind") == "ch32-esig"
                     and int(m.get("flash_kb") or 0) == flash_kb]
            if cands:
                ident = cands[0].get("identify") or {}
                out["vendor"] = str(cands[0].get("vendor") or "WCH")
                out["family"] = str(ident.get("family") or "CH32V203")
                out["detected"] = out["family"]
                out["candidates"] = [str(m.get("id")) for m in cands]
                out["exact"] = len(cands) == 1
            try:
                out["evidence"]["uid"] = _read_bytes(source, CH32_ESIG_UID_ADDR, 12).hex()
            except Exception:
                pass
        except Exception as exc:
            out["evidence"]["ch32_error"] = str(exc)

    if out["detected"] and expected:
        names = set()
        for m in models:
            mid = str(m.get("id") or "")
            if out["candidates"] and mid not in out["candidates"]:
                continue
            names.add(mid.upper())
            names.update(str(a).upper() for a in (m.get("aliases") or []))
        match = expected.upper() in names or expected.upper() == out["detected"].upper()
        if not match and out["family"]:
            match = expected.upper().startswith(out["family"].upper()) or \
                out["family"].upper().startswith(expected.upper())
        out["match"] = bool(match)
        if not match:
            out["warning"] = "芯片型号不一致：检测到 %s，符号表/固件为 %s" % (
                out["detected"], expected)
    return out


PALETTE = [
    "#22d3ee", "#f59e0b", "#a78bfa", "#34d399", "#f472b6",
    "#60a5fa", "#fb7185", "#facc15", "#2dd4bf", "#c084fc",
    "#fb923c", "#4ade80",
]

import ocd  # noqa: E402  (同目录)


# --------------------------------------------------------------------------
# 数据模型
# --------------------------------------------------------------------------
class Signal:
    __slots__ = ("id", "name", "addr", "size", "signed", "shift", "width",
                 "scale", "offset", "unit", "color", "step", "visible", "axis")

    def __init__(self, data: Dict[str, Any]):
        self.id = str(data.get("id") or data.get("name") or "")
        self.name = str(data.get("name") or self.id)
        self.addr = int(data.get("addr") or 0)
        self.size = int(data.get("size") or 4)
        self.signed = bool(data.get("signed"))
        bit = data.get("bit") or data.get("bits")
        if isinstance(bit, (list, tuple)) and len(bit) >= 2:
            self.shift = int(bit[0])
            self.width = int(bit[1])
        else:
            self.shift = int(data.get("shift") or 0)
            self.width = int(data.get("width") or 0)
        self.scale = float(data.get("scale") or 1.0)
        self.offset = float(data.get("offset") or 0.0)
        if data.get("unit") is not None:
            self.unit = str(data.get("unit") or "")
        else:
            self.unit = default_unit(self.name)
        self.color = str(data.get("color") or "")
        self.step = bool(data.get("step"))
        self.visible = data.get("visible", True) is not False
        self.axis = str(data.get("axis") or default_axis(self.name))

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "id": self.id, "name": self.name, "addr": self.addr,
            "size": self.size, "signed": self.signed,
            "scale": self.scale, "offset": self.offset,
            "unit": self.unit, "color": self.color,
            "step": self.step, "visible": self.visible,
        }
        if self.width:
            d["bit"] = [self.shift, self.width]
        d["axis"] = self.axis
        return d

    def mask(self) -> int:
        bits = self.width or (self.size * 8)
        return (1 << bits) - 1

    def decode(self, raw: int) -> int:
        if self.width:
            v = (raw >> self.shift) & self.mask()
        else:
            v = raw & self.mask()
            if self.signed:
                sign = 1 << (self.size * 8 - 1)
                if v & sign:
                    v -= sign << 1
        return v

    def span(self) -> Tuple[int, int]:
        if self.width:
            # 位域所在存储单元按字段大小读
            return (self.addr, self.size)
        return (self.addr, self.size)


class Source:
    kind = "none"

    def read(self, signals: Sequence[Signal]) -> List[int]:
        raise NotImplementedError

    def read_word(self, addr: int) -> int:
        """读 addr 所在对齐 32bit 字 (写入回读/位域 RMW 用)."""
        return 0

    def write(self, addr: int, size: int, value: int) -> None:
        raise RuntimeError("当前信号源不支持写入")

    def close(self) -> None:
        pass

    def info(self) -> Dict[str, Any]:
        return {"kind": self.kind, "connected": False}


class OpenOcdSource(Source):
    kind = "openocd"

    def __init__(self, proc: ocd.OcdProcess, client: ocd.TclClient):
        self.proc = proc
        self.client = client
        self.regions: List[ocd.Region] = []
        self._region_key: Any = None
        self._starts: List[int] = []
        self.cpuid: Optional[int] = None
        self.riscv = False
        self.try_nohalt = False
        # 区域合并参数: 机型 profile.scan 可覆盖 (地址跨度大时减少往返次数)
        self.max_gap = 64
        self.max_words = 64
        # 调试器代价模型 (ms): 每多一块读区 / 每多读一个字的边际开销.
        # None = 首次采样前自动标定一次 (不同探针差一个量级, 不能写死).
        self.region_cost: Optional[float] = None
        self.word_cost: Optional[float] = None
        self.calibrated = False

    def _calibrate(self, signals: Sequence[Signal]) -> None:
        """测一次当前探针的固定往返开销和每字开销 (只读, 不 halt Cortex-M)."""
        self.calibrated = True
        addr = int(signals[0].span()[0]) & ~0x3
        if self.riscv:
            # halt 读: 停核/恢复的代价在 _read 之外, 这里只给块内边际值一个保守估计
            self.region_cost, self.word_cost = 0.4, 0.25
            return

        def timeit(words: int) -> float:
            best = float("inf")
            for _ in range(3):
                t0 = time.perf_counter()
                self.client.read_regions([(addr, words)])
                best = min(best, (time.perf_counter() - t0) * 1000.0)
            return best

        try:
            one = timeit(1)
            many = timeit(64)
            if many > one:
                self.word_cost = max(0.002, (many - one) / 63.0)
            else:
                self.word_cost = 0.03
            self.region_cost = max(0.1, one - self.word_cost)
        except Exception as exc:
            self.region_cost, self.word_cost = 2.0, 0.03
            try:
                self.proc._append_log("代价标定失败, 用保守默认值: %s" % exc)
            except Exception:
                pass

    def _prepare(self, signals: Sequence[Signal]) -> None:
        key = tuple((s.addr, s.span()[1]) for s in signals)
        if key == self._region_key:
            return
        if not self.calibrated:
            self._calibrate(signals)
        self.regions = ocd.plan_regions([s.span() for s in signals],
                                        max_words=self.max_words,
                                        max_gap=self.max_gap,
                                        region_cost=self.region_cost,
                                        word_cost=self.word_cost)
        words = sum(r.words for r in self.regions)
        cost = ocd.plan_cost(self.regions, self.region_cost, self.word_cost)
        try:
            self.proc._append_log("采样区域: %d 块 / %d 字 (gap<=%d, 标定 %.2f ms/块 + %.3f ms/字%s)" % (
                len(self.regions), words, self.max_gap,
                self.region_cost or 0.0, self.word_cost or 0.0,
                ", 预计 %.1f ms/轮 ≈ %.0f Hz" % (cost, 1000.0 / cost) if cost else ""))
        except Exception:
            pass
        self._starts = []
        total = 0
        for r in self.regions:
            self._starts.append(total)
            total += r.words
        self._region_key = key

    def plan_stats(self) -> Dict[str, Any]:
        words = sum(r.words for r in self.regions)
        cost = ocd.plan_cost(self.regions, self.region_cost, self.word_cost)
        return {
            "regions": len(self.regions),
            "words": words,
            "region_cost_ms": self.region_cost,
            "word_cost_ms": self.word_cost,
            "estimate_ms": cost,
            "estimate_hz": (1000.0 / cost) if cost else None,
        }

    def read(self, signals: Sequence[Signal]) -> List[int]:
        if not signals:
            return []
        self._prepare(signals)
        regions = [(r.addr, r.words) for r in self.regions]
        if self.riscv:
            words = None
            if self.try_nohalt:
                # 先尝试运行中读（SBA / 硬件采样）；WCH-Link 当前不支持则回退 halt
                try:
                    words = self.client.read_regions(regions)
                except Exception:
                    self.try_nohalt = False
            if words is None:
                words = self.client.read_regions_halt(regions)
        else:
            words = self.client.read_regions(regions)
        out: List[int] = []
        for s in signals:
            region = None
            idx = 0
            addr, size = s.span()
            # 线性找区域, 信号数一般 < 32
            for i, r in enumerate(self.regions):
                if r.addr <= addr < r.end:
                    region = r
                    idx = self._starts[i] + (addr - r.addr) // 4
                    break
            if region is None:
                out.append(0)
                continue
            word = words[idx] if idx < len(words) else 0
            raw = ocd.decode_word(word, addr, region, size)
            out.append(s.decode(raw))
        return out

    def read_word(self, addr: int) -> int:
        addr = int(addr) & ~0x3
        if self.riscv:
            if self.try_nohalt:
                try:
                    return self.client.read_regions([(addr, 1)])[0]
                except Exception:
                    self.try_nohalt = False
            return self.client.read_regions_halt([(addr, 1)])[0]
        return self.client.read_words(addr, 1)[0]

    def write(self, addr: int, size: int, value: int) -> None:
        if self.riscv:
            try:
                self.client.command("halt")
                self.client.write_mem(int(addr), int(size), int(value))
            finally:
                try:
                    self.client.command("resume")
                except Exception:
                    pass
            return
        self.client.write_mem(int(addr), int(size), int(value))

    def close(self) -> None:
        # RISC-V 调试读会 halt，关闭前务必让目标继续跑
        if self.riscv:
            try:
                self.client.command("resume")
            except Exception:
                pass
        self.proc.stop()

    def info(self) -> Dict[str, Any]:
        p = self.proc
        return {
            "kind": "openocd",
            "connected": bool(self.client.connected),
            "port": p.port,
            "pid": p.pid,
            "running": p.running,
            "exe": p.paths.exe,
            "iface": p.paths.iface,
            "target": p.paths.target,
            "serial": p.serial,
            "cpuid": self.cpuid,
            "plan": self.plan_stats(),
        }


class AttachedSource(Source):
    kind = "attach"

    def __init__(self, client: ocd.TclClient, host: str, port: int):
        self.client = client
        self.host = host
        self.port = port
        self.cpuid: Optional[int] = None
        self._inner = OpenOcdSource.__new__(OpenOcdSource)
        self._inner.client = client
        self._inner.regions = []
        self._inner._region_key = None
        self._inner._starts = []
        self._inner.riscv = False
        self._inner.try_nohalt = False
        self._inner.max_gap = 64
        self._inner.max_words = 64
        self._inner.region_cost = None
        self._inner.word_cost = None
        self._inner.calibrated = False

    def read(self, signals: Sequence[Signal]) -> List[int]:
        return OpenOcdSource.read(self._inner, signals)

    def plan_stats(self) -> Dict[str, Any]:
        return OpenOcdSource.plan_stats(self._inner)

    def read_word(self, addr: int) -> int:
        return self.client.read_words(int(addr) & ~0x3, 1)[0]

    def write(self, addr: int, size: int, value: int) -> None:
        self.client.write_mem(int(addr), int(size), int(value))

    def close(self) -> None:
        self.client.close()

    def info(self) -> Dict[str, Any]:
        return {"kind": "attach", "connected": self.client.connected,
                "host": self.host, "port": self.port, "cpuid": self.cpuid,
                "plan": self.plan_stats()}


def sim_test_wave(name: str, t: float, rand: random.Random) -> float:
    """仿真源的显式测试波形（不依赖信号目录，可按 name 注入）.

    ``sim.sawtooth`` / ``sim.triangle`` / ``sim.square`` / ``sim.noise`` /
    ``sim.spikes`` / ``sim.ripple``；也接受 ``sim.xxx.1`` 之类后缀。
    """
    n = str(name or "").lower()
    ph = lambda p: (t / p) % 1.0
    if n.startswith("sim.sawtooth"):
        return 1000.0 + 500.0 * (2.0 * ph(1.6) - 1.0)
    if n.startswith("sim.triangle"):
        p = ph(1.6)
        return 1000.0 + 500.0 * (1.0 - 4.0 * abs(p - 0.5))
    if n.startswith("sim.square"):
        return 1500.0 if ph(1.2) < 0.5 else 500.0
    if n.startswith("sim.noise"):
        return 1000.0 + 120.0 * rand.gauss(0.0, 1.0) + 80.0 * math.sin(t * 0.35)
    if n.startswith("sim.spikes"):
        spike = 900.0 if (t % 1.7) < 0.05 else 0.0
        return 1000.0 + spike + 25.0 * rand.gauss(0.0, 1.0)
    if n.startswith("sim.ripple"):
        return (1000.0 + 220.0 * math.sin(t * 2.0 * math.pi * 3.1)
                + 45.0 * math.sin(t * 2.0 * math.pi * 31.0)
                + 25.0 * rand.gauss(0.0, 1.0))
    return 1000.0 + 300.0 * math.sin(t * 2.0 * math.pi / 2.5)


class SimSource(Source):
    kind = "sim"

    def __init__(self):
        self.start = time.monotonic()
        self.rand = random.Random(2159)
        self.over_ticks = 0
        self.mem: Dict[int, int] = {}

    def read_word(self, addr: int) -> int:
        base = int(addr) & ~0x3
        return sum(self.mem.get(base + i, 0) << (8 * i) for i in range(4))

    def write(self, addr: int, size: int, value: int) -> None:
        mask = (1 << (int(size) * 8)) - 1
        value = int(value) & mask
        for i in range(int(size)):
            self.mem[int(addr) + i] = (value >> (8 * i)) & 0xFF

    def read(self, signals: Sequence[Signal]) -> List[int]:
        t = time.monotonic() - self.start
        # 30 秒一个循环: 升速 -> 加负载(跨阈值) -> 卸载 -> 巡航 -> 降速.
        # 首尾都在 level=1, 所以 20s 窗口里不会看到循环接缝的跳变.
        cycle = 30.0
        phase = t % cycle
        if phase < 5.0:
            lvl = 1.0 + 34.0 * (phase / 5.0)
        elif phase < 22.0:
            lvl = 35.0
        elif phase < 26.0:
            lvl = 35.0 - 34.0 * ((phase - 22.0) / 4.0)
        else:
            lvl = 1.0
        base = 55.0 + lvl * 24.0
        if 5.0 <= phase < 8.0:
            load = 520.0 * (phase - 5.0) / 3.0
        elif 8.0 <= phase < 10.0:
            load = 520.0
        elif 10.0 <= phase < 14.0:
            load = 520.0 * (1.0 - (phase - 10.0) / 4.0)
        else:
            load = 0.0
        ripple = 18.0 * math.sin(t * 9.0) + self.rand.uniform(-6, 6)
        current = max(0.0, base + load + ripple)
        threshold = 547.0 + (lvl / 35.0) * 846.0
        over = current >= threshold
        if over:
            self.over_ticks += 1
        else:
            self.over_ticks = max(0, self.over_ticks - 2)
        vol = 300.0 + lvl * 30.0
        state = 4 if over else 3
        values: List[int] = []
        for s in signals:
            name = s.name
            v: float
            if name.endswith("motor.over.current") or name == "motor.over.current":
                v = current
            elif name == "adc.RES[0]":
                v = current + 20.0 * math.sin(t * 37.0)
            elif name in ("motor.over.thresholdLast", "motor.over.threshold"):
                v = threshold
            elif name in ("motor.over.offsetThreshold",):
                v = max(0.0, (current - threshold + 200.0) * 0.3)
            elif name in ("motor.over.offset",):
                v = 270.0
            elif name in ("motor.over.totalOverTick",):
                v = self.over_ticks
            elif name == "motor.Scfg.vol":
                v = vol
            elif name == "motor.Scfg.speed":
                v = 1050.0
            elif name in ("motor.speedlevel",):
                v = lvl
            elif name == "motor.state":
                v = state
            elif name == "motor.power":
                v = 1
            elif name == "adc.conts":
                v = int(t * 40) % 10
            elif name == "sys.state":
                v = 1
            elif name.startswith("sim."):
                # 测试波形：锯齿/三角/方波/噪声/尖峰/纹波（API 注入 signal 即可用）
                v = sim_test_wave(name, t, self.rand)
            else:
                # 未建模的信号给一个缓慢的正弦, 便于区分
                h = sum(ord(c) for c in name) or 1
                v = 128 + 60 * math.sin(t * 0.7 + (h % 97) * 0.13)
            # 被 /api/write 写过的地址, 用写入值覆盖仿真值
            if any((s.addr + i) in self.mem for i in range(int(s.size or 1))):
                raw = sum(self.mem.get(s.addr + i, 0) << (8 * i) for i in range(int(s.size or 1)))
                if s.width:
                    v = (raw >> s.shift) & ((1 << s.width) - 1)
                else:
                    v = raw
                    if s.signed:
                        sign = 1 << (s.size * 8 - 1)
                        if v & sign:
                            v -= sign << 1
            values.append(self._fit(s, int(round(v))))
        return values

    @staticmethod
    def _fit(s: Signal, v: int) -> int:
        bits = s.width or (s.size * 8)
        if bits < 32:
            v &= (1 << bits) - 1
        else:
            v &= 0xFFFFFFFF
        return v

    def info(self) -> Dict[str, Any]:
        return {"kind": "sim", "connected": True}


# --------------------------------------------------------------------------
# Hub / 录制 / 采样线程
# --------------------------------------------------------------------------
class Hub:
    def __init__(self):
        self._subs: List[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=256)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            try:
                self._subs.remove(q)
            except ValueError:
                pass

    def count(self) -> int:
        with self._lock:
            return len(self._subs)

    def publish(self, msg: Dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass


class Recorder:
    """环形录制：连接后自动开始；队列满后最旧样本被丢弃，起始时间随之前移。"""

    def __init__(self, limit: int = 300000):
        self.limit = limit
        self.active = False
        self.started = 0.0
        self.data: Deque[Tuple[float, List[int]]] = deque(maxlen=limit)
        self.signals: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def start(self, signals: Sequence[Signal]) -> None:
        with self._lock:
            self.active = True
            self.started = time.time()
            self.data.clear()
            self.signals = [s.to_dict() for s in signals]

    def set_signals(self, signals: Sequence[Signal]) -> None:
        """配置变化时同步录制列；列集合变了就重新开始（旧数据列数对不上）。"""
        new = [s.to_dict() for s in signals]
        with self._lock:
            old_ids = [str(x.get("id")) for x in self.signals]
            new_ids = [str(x.get("id")) for x in new]
            if old_ids != new_ids:
                self.data.clear()
                self.started = time.time()
            self.signals = new

    def stop(self) -> None:
        with self._lock:
            self.active = False

    def reset(self) -> None:
        with self._lock:
            self.data.clear()
            self.started = time.time()

    def append(self, t_ms: float, values: List[int]) -> None:
        if not self.active:
            return
        with self._lock:
            self.data.append((t_ms, list(values)))

    def info(self) -> Dict[str, Any]:
        with self._lock:
            n = len(self.data)
            first = self.data[0][0] if n else None
            last = self.data[-1][0] if n else None
            span = ((last - first) / 1000.0) if n > 1 else 0.0
            now = time.time()
            if n:
                start_wall = now - span
            else:
                start_wall = self.started if self.active and self.started else 0.0
            return {
                "active": self.active,
                "count": n,
                "seconds": round(span, 2),
                "start_wall": round(start_wall, 3) if start_wall else 0,
                "oldest_t": first,
                "latest_t": last,
                "limit": self.limit,
                "signals": [{"id": x.get("id"), "name": x.get("name"), "unit": x.get("unit")}
                            for x in self.signals],
            }

    def csv(self, only_ids: Optional[Sequence[str]] = None) -> str:
        with self._lock:
            signals = [Signal(s) for s in self.signals] or []
            rows = list(self.data)
        keep = None
        if only_ids:
            want = set(str(x) for x in only_ids)
            keep = [i for i, s in enumerate(signals) if s.id in want]
            if keep:
                signals = [signals[i] for i in keep]
        out = io.StringIO()
        header = ["t_ms"] + ["%s%s" % (s.name, (" [%s]" % s.unit) if s.unit else "") for s in signals]
        out.write(",".join(_csv_cell(h) for h in header) + "\n")
        for t, vals in rows:
            cells = ["%.1f" % t]
            idx = keep if keep is not None else list(range(len(signals)))
            for j, i in enumerate(idx):
                sig = signals[j]
                raw = vals[i] if i < len(vals) else 0
                val = raw * sig.scale + sig.offset
                cells.append(("%.4f" % val).rstrip("0").rstrip(".") if sig.scale != 1 or sig.offset else str(raw))
            out.write(",".join(cells) + "\n")
        return out.getvalue()


def _csv_cell(v: Any) -> str:
    s = str(v)
    if any(c in s for c in ",\"\n\r"):
        return '"' + s.replace('"', '""') + '"'
    return s


def parse_multipart(body: bytes, content_type: str) -> Dict[str, Tuple[str, bytes]]:
    """极简 multipart/form-data 解析 (只用于 AXF/头文件导入)."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return {}
    boundary = ("--" + m.group(1)).encode()
    out: Dict[str, Tuple[str, bytes]] = {}
    for raw in body.split(boundary):
        raw = raw.lstrip(b"\r\n")
        if not raw or raw.startswith(b"--"):
            continue
        if b"\r\n\r\n" not in raw:
            continue
        head, data = raw.split(b"\r\n\r\n", 1)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        text = head.decode("utf-8", "replace")
        name_m = re.search(r'name="([^"]+)"', text)
        if not name_m:
            continue
        file_m = re.search(r'filename="([^"]*)"', text)
        out[name_m.group(1)] = (file_m.group(1) if file_m else "", data)
    return out


class Sampler(threading.Thread):
    def __init__(self, hub: Hub, cache=None):
        super().__init__(name="motor-scope-sampler", daemon=True)
        self.hub = hub
        self.recorder = Recorder()
        self.cache = cache          # 旁路录制缓存；None = 不启用
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.source: Optional[Source] = None
        self.signals: List[Signal] = []
        self.rate = 100.0
        self.epoch = time.monotonic()
        self.samples = 0
        self.rate_actual = 0.0
        self.busy_ms = 0.0      # 一轮采样(读内存+入队+推送)的平滑耗时
        self.duty = 0.0         # 占用率 = busy_ms / 目标周期; >1 表示读不过来
        self.last_t = 0.0
        self.error = ""
        self.generation = 0
        self._rate_t0 = time.monotonic()
        self._rate_n = 0
        self.history: Deque[List[Any]] = deque(maxlen=40000)
        self._sig_key: Any = None

    # ---- 配置 ----
    def set_source(self, source: Optional[Source]) -> None:
        with self._cond:
            self.source = source
            self.generation += 1
            self.error = ""
            self._cond.notify_all()
        self._wake.set()

    def set_rate(self, rate: float) -> None:
        with self._cond:
            self.rate = float(rate)
            self.generation += 1
            self._cond.notify_all()

    def set_signals(self, signals: Sequence[Signal], rate: float) -> None:
        key = tuple((s.addr, s.size, s.shift, s.width) for s in signals)
        with self._cond:
            changed = key != self._sig_key
            if changed:
                # 通道构成变了, 旧样本的列对不上, 丢掉
                self.history.clear()
                self._sig_key = key
            self.signals = list(signals)
            self.rate = max(1.0, min(500.0, float(rate or 100)))
            # 只有列构成变了才让 Agent 的 cursor 作废; 页面重连重复下发同一套
            # 配置时不能把 generation 推高, 否则 long-poll 会被误判为 reset.
            if changed:
                self.generation += 1
            self.error = ""
            self._cond.notify_all()
        # 缓存列约定变化时开新会话；不阻塞采样线程
        if self.cache is not None:
            try:
                self.cache.configure([s.to_dict() for s in self.signals])
            except Exception:
                pass
        self._wake.set()

    def snapshot(self) -> Tuple[Optional[Source], List[Signal], float, int]:
        with self._lock:
            return self.source, list(self.signals), self.rate, self.generation

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._cond:
            self._cond.notify_all()

    # ---- 主循环 ----
    def run(self) -> None:
        next_t = time.monotonic()
        while not self._stop.is_set():
            source, signals, rate, gen = self.snapshot()
            if source is None or not signals:
                with self._lock:
                    self.error = ""
                self._wake.wait(0.25)
                self._wake.clear()
                next_t = time.monotonic()
                continue
            t0 = time.monotonic()
            try:
                values = source.read(signals)
                if gen != self.generation:
                    continue
                t_ms = (t0 - self.epoch) * 1000.0
                self.samples += 1
                self._rate_n += 1
                self.last_t = t_ms
                self.recorder.append(t_ms, values)
                if self.cache is not None:
                    self.cache.append(t_ms, values)
                row = [round(t_ms, 1), values]
                with self._cond:
                    self.history.append(row)
                    self.error = ""
                    self._cond.notify_all()
                self.hub.publish({"type": "s", "b": [row]})
                if t0 - self._rate_t0 >= 1.0:
                    self.rate_actual = self._rate_n / (t0 - self._rate_t0)
                    self._rate_t0 = t0
                    self._rate_n = 0
            except Exception as exc:
                with self._lock:
                    self.error = str(exc)
                time.sleep(0.4)
                continue
            elapsed = time.monotonic() - t0
            period = 1.0 / rate if rate > 0 else 0.0
            # 占用率 = 一轮“读内存 + 入队/推送”耗时占目标周期的比例.
            # >100% 说明读一轮已经超过设定周期: 实际速率由探针决定, 不是设定值.
            with self._lock:
                self.busy_ms = (elapsed * 1000.0 if not self.busy_ms
                                else self.busy_ms * 0.8 + elapsed * 1000.0 * 0.2)
                self.duty = (self.busy_ms / (period * 1000.0)) if period > 0 else 0.0
            next_t = max(next_t + period, t0 + 0.002) if next_t else t0 + period
            if next_t <= time.monotonic():
                # 读一轮已经超过周期: 从当下重新排, 不追赶 (读不动就降速, 不堆积)
                next_t = time.monotonic()
            elif self._pace(next_t):
                next_t = time.monotonic()

    def _pace(self, deadline: float) -> bool:
        """睡到 deadline; 返回是否在 deadline 之前被配置变更唤醒.

        Windows 上 Event.wait(timeout) 走系统定时器: 进程没调
        timeBeginPeriod(1) 时最小 15.6ms, 调了也有 ~1ms 的过冲. 所以
        先按“deadline 前 1.5ms”等, 最后这点用自旋补齐; 否则 250/300 Hz
        这种目标会被定时器粒度直接吃掉 (0.5ms 的 sleep 变成 1.5ms).
        自旋最多 ~1.5ms/轮, 100Hz 时约 5% 一个核.
        """
        while True:
            if self._wake.is_set():
                self._wake.clear()
                return True
            remain = deadline - time.monotonic()
            if remain <= 0:
                return False
            if remain > 0.0025:
                self._wake.wait(min(remain - 0.0015, 1.0))
                self._wake.clear()
            else:
                while time.monotonic() < deadline:
                    pass
                return False

    def history_snapshot(self, seconds: float = 60.0) -> List[List[Any]]:
        with self._lock:
            if not self.history:
                return []
            cutoff = self.last_t - max(1.0, min(180.0, seconds)) * 1000.0
            return [row for row in self.history if row[0] >= cutoff]

    def _signals_meta(self) -> List[Dict[str, Any]]:
        return [s.to_dict() for s in self.signals]

    def history_before(self, before: Optional[float] = None, limit: int = 1000) -> Dict[str, Any]:
        """读 before 之前的最近 limit 点; before 缺省=最新, 立即返回."""
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 1000
        limit = max(1, min(40000, limit))
        with self._lock:
            rows = list(self.history)
            signals = self._signals_meta()
            generation = self.generation
            if not rows:
                return {"signals": signals, "samples": [], "cursor": before,
                        "oldest": None, "latest": None, "gap": False,
                        "reset": False, "generation": generation, "count": 0}
            oldest, latest = rows[0][0], rows[-1][0]
            if before is None:
                before = latest
            try:
                before = float(before)
            except (TypeError, ValueError):
                before = latest
            gap = before < oldest
            end = 0
            while end < len(rows) and rows[end][0] <= before:
                end += 1
            start = max(0, end - limit)
            selected = rows[start:end]
            cursor = selected[-1][0] if selected else before
            return {"signals": signals, "samples": selected, "cursor": cursor,
                    "oldest": oldest, "latest": latest, "gap": gap,
                    "reset": False, "generation": generation, "count": len(selected)}

    def history_after(self, after: Optional[float] = None, limit: int = 1000,
                      timeout: float = 20.0) -> Dict[str, Any]:
        """long-poll: 返回 after 之后的样本; 没有就等, 最多 timeout 秒."""
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 1000
        limit = max(1, min(40000, limit))
        try:
            timeout = float(timeout)
        except (TypeError, ValueError):
            timeout = 20.0
        timeout = max(0.0, min(60.0, timeout))
        deadline = time.monotonic() + timeout
        with self._cond:
            start_gen = self.generation
            if after is None:
                after = self.history[-1][0] if self.history else -1.0
            else:
                try:
                    after = float(after)
                except (TypeError, ValueError):
                    after = -1.0
            while True:
                rows = list(self.history)
                signals = self._signals_meta()
                generation = self.generation
                oldest = rows[0][0] if rows else None
                latest = rows[-1][0] if rows else None
                if generation != start_gen:
                    # 配置/信号源变了, 旧 cursor 作废
                    return {"signals": signals, "samples": [], "cursor": after,
                            "oldest": oldest, "latest": latest, "gap": True,
                            "reset": True, "timeout": False,
                            "generation": generation, "count": 0}
                if rows:
                    gap = after < oldest
                    start = 0
                    if not gap:
                        while start < len(rows) and rows[start][0] <= after:
                            start += 1
                    if start < len(rows):
                        selected = rows[start:start + limit]
                        return {"signals": signals, "samples": selected,
                                "cursor": selected[-1][0], "oldest": oldest,
                                "latest": latest, "gap": gap, "reset": False,
                                "timeout": False, "generation": generation,
                                "count": len(selected)}
                if self._stop.is_set():
                    return {"signals": signals, "samples": [], "cursor": after,
                            "oldest": oldest, "latest": latest, "gap": False,
                            "reset": False, "timeout": False, "stopped": True,
                            "generation": generation, "count": 0}
                remain = deadline - time.monotonic()
                if remain <= 0:
                    return {"signals": signals, "samples": [], "cursor": after,
                            "oldest": oldest, "latest": latest, "gap": False,
                            "reset": False, "timeout": True,
                            "generation": generation, "count": 0}
                self._cond.wait(min(remain, 1.0))

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "rate": self.rate,
                "rate_actual": round(self.rate_actual, 1),
                "busy_ms": round(self.busy_ms, 2),
                "duty": round(self.duty, 3),
                "samples": self.samples,
                "last_t": round(self.last_t, 1),
                "error": self.error,
                "signals": len(self.signals),
                "generation": self.generation,
                "history": len(self.history),
                "oldest_t": self.history[0][0] if self.history else None,
                "latest_t": self.history[-1][0] if self.history else None,
            }


# --------------------------------------------------------------------------
# 应用
# --------------------------------------------------------------------------
def _safe_num(v, default=0.0):
    try:
        x = float(v)
        return x if math.isfinite(x) else default
    except (TypeError, ValueError):
        return default


def _clean_view_layout(layout):
    """限制 /api/view 上报的布局大小，避免异常客户端把 presence 撑爆。"""
    if not isinstance(layout, dict):
        return {}
    groups = []
    for g in (layout.get("groups") or [])[:32]:
        if not isinstance(g, dict):
            continue
        groups.append({
            "id": str(g.get("id") or "")[:64],
            "name": str(g.get("name") or "")[:48],
            "auto": bool(g.get("auto")),
            "visible": g.get("visible") is not False,
        })
    raw_rows = layout.get("rows") if isinstance(layout.get("rows"), dict) else {}
    rows = {}
    for k, v in list(raw_rows.items())[:300]:
        rows[str(k)] = str(v)[:64]
    raw_axes = layout.get("axes") if isinstance(layout.get("axes"), dict) else {}
    axes = {}
    for k, v in list(raw_axes.items())[:300]:
        axes[str(k)] = "right" if str(v) == "right" else "left"
    table = [str(x) for x in (layout.get("table") or [])][:300]
    plot = [str(x) for x in (layout.get("plot") or [])][:300]
    raw_write = layout.get("write") if isinstance(layout.get("write"), list) else []
    write = []
    for m in raw_write[:16]:
        if not isinstance(m, dict):
            continue
        write.append({
            "id": str(m.get("id") or "")[:32],
            "rowId": str(m.get("rowId") or "")[:128],
            "mode": "switch" if m.get("mode") == "switch" else "slider",
            "width": _safe_num(m.get("width")),
            "widthTouched": bool(m.get("widthTouched")),
            "min": _safe_num(m.get("min")),
            "max": _safe_num(m.get("max")),
            "step": max(1.0, _safe_num(m.get("step"), 1.0)),
            "onValue": _safe_num(m.get("onValue"), 1.0),
            "offValue": _safe_num(m.get("offValue")),
            "lockValue": _safe_num(m.get("lockValue")),
            "locked": False,
            "expanded": bool(m.get("expanded")),
            "layout": "block" if m.get("layout") == "block" else "bar",
            "addr": int(_safe_num(m.get("addr"))),
            "size": int(_safe_num(m.get("size"))),
            "signed": bool(m.get("signed")),
            "name": str(m.get("name") or "")[:96],
        })
    return {"groups": groups, "rows": rows, "table": table, "plot": plot,
            "axes": axes, "write": write}


class App:
    def __init__(self, args):
        self.args = args
        self.project = os.path.abspath(args.project or PROJECT_DEFAULT)
        self.axf = os.path.abspath(args.axf or os.path.join(self.project, "MDK", "Objects", "DR2159.axf"))
        self.header = os.path.abspath(args.header or os.path.join(self.project, "Libraries", "inc", "cw32l011.h"))
        self.signals_path = os.path.abspath(args.signals or SIGNALS_JSON)
        self.import_dir = os.path.join(HERE, "imports")
        # 分享链接：imports/ 已 gitignore，持久化到 imports/shares.json
        self.shares_path = os.path.join(self.import_dir, "shares.json")
        self.shares_lock = threading.Lock()
        self.shares = self._load_shares()
        # API 侧“表/波/写”开关（浏览器轮询/SSE 应用；服务端不直接改采样列）
        self.signal_flags: Dict[str, Dict[str, Any]] = {}
        self.signal_flags_lock = threading.Lock()
        # 机型工程: 一个机型 = 一套符号表 + 芯片/连接参数 + 前端配置
        self.profiles_root = PROFILES_DIR
        self.profile: Optional[Dict[str, Any]] = None
        self.profile_error = ""
        self.mcu = ""
        self.hub = Hub()
        self.sampler = Sampler(self.hub)
        self.source: Optional[Source] = None
        self.catalog: Dict[str, Any] = {}
        self.catalog_error = ""
        self.catalog_lock = threading.Lock()
        self.status_lock = threading.Lock()
        # 每个 SSE 客户端上报“本端正在显示”的 id；只用于删除提示/在线状态，不影响采样
        self.presence: Dict[str, Dict[str, Any]] = {}
        self.presence_lock = threading.Lock()
        self.running = True
        self.error = ""
        self.started = time.time()
        self.openocd_override = args.openocd
        self.iface_override = args.iface
        self.target_override = args.target
        self.last_connect_error = ""
        self.chip: Optional[Dict[str, Any]] = None
        self.arch = "cw32"
        self.log: Deque[str] = deque(maxlen=300)
        # 服务端分块压缩录制缓存（旁路；实时链路/Recorder/CSV 不受影响）
        cache_dir = getattr(args, "record_cache_dir", None)
        cache_enabled = bool(cache_dir) and not bool(getattr(args, "no_record_cache", False))
        try:
            limit_mb = int(getattr(args, "record_cache_limit_mb", 4096) or 4096)
        except (TypeError, ValueError):
            limit_mb = 4096
        try:
            block_points = int(getattr(args, "record_cache_block_points", 2000) or 2000)
        except (TypeError, ValueError):
            block_points = 2000
        self.record_cache = RecordCache(
            cache_dir, limit_bytes=max(1, limit_mb) * 1024 * 1024,
            block_points=block_points, enabled=cache_enabled, logger=self.add_log)
        self.sampler.cache = self.record_cache
        self._init_profile(args)
        self._auto_thread: Optional[threading.Thread] = None
        self.load_catalog(auto_regen=True)
        # 先装一套默认信号: 这样服务器一起来就开始采样, 页面刷新/后开浏览器
        # 都能直接看到历史, 而不是从空白开始.
        try:
            cfg = self.default_config()
            self.sampler.set_signals([Signal(x) for x in cfg["signals"]], cfg["rate"])
        except Exception as exc:
            self.add_log("默认信号初始化失败: %s" % exc)

    # ---- 机型工程 ----
    # ---- 分享链接：保存一份前端快照，GET 时原样返回 ----
    def _load_shares(self) -> Dict[str, Any]:
        try:
            with open(self.shares_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save_shares_locked(self) -> None:
        try:
            os.makedirs(self.import_dir, exist_ok=True)
            tmp = self.shares_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.shares, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, self.shares_path)
        except Exception as exc:
            self.add_log("保存分享失败: %s" % exc)

    def create_share(self, snapshot: Dict[str, Any]) -> str:
        if not isinstance(snapshot, dict):
            raise RuntimeError("分享内容无效")
        data = dict(snapshot)
        data["v"] = int(data.get("v") or 1)
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if len(raw.encode("utf-8")) > 1024 * 1024:
            raise RuntimeError("分享内容太大（>1MB）")
        now = time.time()
        with self.shares_lock:
            for sid, rec in list(self.shares.items()):
                if not isinstance(rec, dict) or now - float(rec.get("created") or 0) > 30 * 86400:
                    self.shares.pop(sid, None)
            sid = secrets.token_urlsafe(6)
            while sid in self.shares:
                sid = secrets.token_urlsafe(6)
            self.shares[sid] = {"created": now, "data": data}
            if len(self.shares) > 200:
                keep = sorted(self.shares.items(),
                              key=lambda kv: float((kv[1] or {}).get("created") or 0))[-200:]
                self.shares = dict(keep)
            self._save_shares_locked()
            return sid

    def get_share(self, sid: str) -> Optional[Dict[str, Any]]:
        sid = str(sid or "").strip()
        if not sid:
            return None
        with self.shares_lock:
            rec = self.shares.get(sid)
            if not isinstance(rec, dict):
                return None
            if time.time() - float(rec.get("created") or 0) > 30 * 86400:
                self.shares.pop(sid, None)
                self._save_shares_locked()
                return None
            data = rec.get("data")
            return dict(data) if isinstance(data, dict) else None

    # ---- presence: 每端本地的表/波显示集合（删除提示用） ----
    def presence_add(self):
        with self.presence_lock:
            used = {p.get("no") for p in self.presence.values()}
            no = 1
            while no in used:
                no += 1
            cid = "c%d" % no
            self.presence[cid] = {"id": cid, "no": no, "visible": [], "layout": {}, "label": "", "last": time.monotonic()}
            return cid, no

    def presence_remove(self, cid: str) -> None:
        with self.presence_lock:
            self.presence.pop(cid, None)

    def presence_update(self, cid: str, visible, layout=None, label=None) -> bool:
        with self.presence_lock:
            p = self.presence.get(cid)
            if not p:
                return False
            new = [str(x) for x in (visible or [])][:256]
            new_layout = _clean_view_layout(layout)
            new_label = str(label or "")[:32]
            changed = (new != p.get("visible") or new_layout != p.get("layout")
                       or (new_label and new_label != p.get("label")))
            p["visible"] = new
            p["layout"] = new_layout
            if new_label:
                p["label"] = new_label
            p["last"] = time.monotonic()
            return changed

    def presence_payload(self):
        now = time.monotonic()
        with self.presence_lock:
            for cid, p in list(self.presence.items()):
                if now - p.get("last", 0) > 15:
                    del self.presence[cid]
            return [
                {"id": p["id"], "no": p["no"],
                 "label": p.get("label") or "",
                 "visible": list(p.get("visible") or []),
                 "layout": p.get("layout") or {}}
                for p in sorted(self.presence.values(), key=lambda x: x["no"])
            ]

    def _apply_profile_meta(self, meta: Dict[str, Any]) -> None:
        self.profile = dict(meta or {})
        src = (meta or {}).get("source") or {}
        axf = profiles.host_path(str(src.get("axf") or ""))
        if axf:
            self.axf = axf
        self.header = profiles.host_path(str(src.get("header") or ""))
        self.arch = "riscv" if str((meta or {}).get("arch") or "").lower() == "riscv" else "cw32"
        self.mcu = str((meta or {}).get("mcu") or "")

    def _init_profile(self, args) -> None:
        try:
            profiles.ensure(self.profiles_root)
            pid = profiles.get_active(self.profiles_root)
            if not pid:
                return
            meta = profiles.read_profile(pid, self.profiles_root)
            if meta is None:
                return
            self._apply_profile_meta(meta)
            if getattr(args, "signals", ""):
                # 兼容旧用法: --signals 显式指定符号表时不动它
                self.add_log("使用 --signals 指定的符号表（机型连接参数仍生效）")
                return
            self.signals_path = profiles.signals_path(pid, self.profiles_root)
        except Exception as exc:
            self.profile_error = str(exc)

    def profile_summary(self) -> Dict[str, Any]:
        meta = self.profile or {}
        if not meta:
            return {}
        out = profiles.summary(meta, self.profiles_root)
        out["active"] = True
        return out

    def profiles_payload(self) -> Dict[str, Any]:
        index = profiles.load_index(self.profiles_root)
        items = [profiles.summary(m, self.profiles_root)
                 for m in profiles.list_profiles(self.profiles_root)]
        active = str((self.profile or {}).get("id") or index.get("active") or "")
        for it in items:
            it["active"] = it["id"] == active
        return {"schema": index.get("schema", 1), "active": active, "items": items,
                "error": self.profile_error}

    def switch_profile(self, pid: str) -> Dict[str, Any]:
        pid = str(pid or "").strip()
        meta = profiles.read_profile(pid, self.profiles_root)
        if meta is None:
            raise RuntimeError("未知机型: %s" % (pid or "?"))
        data = profiles.load_catalog(pid, self.profiles_root)
        if data is None:
            data = profiles.build_catalog(meta)
            profiles.save_catalog(pid, data, self.profiles_root)
            meta = profiles.apply_counts(meta, data)
            meta = profiles.write_profile(meta, self.profiles_root)
        was_connected = self.source is not None
        # 地址整体变了, 不能拿旧连接继续采; 断开并由前端决定是否重连
        self.disconnect()
        self.chip = None
        self.catalog_error = ""
        self._apply_profile_meta(meta)
        self.signals_path = profiles.signals_path(pid, self.profiles_root)
        with self.catalog_lock:
            self.catalog = data
        try:
            self.sampler.set_signals([], self.sampler.rate)
        except Exception:
            pass
        profiles.set_active(pid, self.profiles_root)
        saved = profiles.read_config(pid, self.profiles_root)
        self.add_log("切换机型: %s（%d 变量 / %d 外设）"
                     % (pid, len(data.get("variables") or []),
                        len(data.get("peripherals") or [])))
        return {
            "ok": True,
            "profile": profiles.summary(meta, self.profiles_root),
            "profiles": self.profiles_payload(),
            "catalog": data,
            "config": saved.get("config") if isinstance(saved.get("config"), dict) else {},
            "config_saved_at": str(saved.get("saved_at") or ""),
            "was_connected": was_connected,
        }

    def save_profile_config(self, payload: Dict[str, Any],
                            manual: bool = False) -> Dict[str, Any]:
        meta = self.profile or {}
        pid = str(meta.get("id") or "")
        if not pid:
            raise RuntimeError("当前没有激活的机型")
        cfg = payload.get("config")
        if not isinstance(cfg, dict):
            cfg = {k: v for k, v in payload.items() if k not in ("config",)}
        saved = profiles.save_config(pid, cfg, self.profiles_root)
        if manual:
            self.add_log("已保存工程配置: %s（%s）" % (pid, saved.get("saved_at")))
        return {"ok": True, "profile": pid, "saved_at": saved.get("saved_at"),
                "bytes": len(json.dumps(cfg, ensure_ascii=False))}

    def build_profile(self, pid: str) -> Dict[str, Any]:
        pid = str(pid or (self.profile or {}).get("id") or "").strip()
        if not pid:
            raise RuntimeError("未指定机型")
        res = profiles.rebuild(pid, self.profiles_root)
        if pid == str((self.profile or {}).get("id") or ""):
            self._apply_profile_meta(res["profile"])
            with self.catalog_lock:
                self.catalog = res["catalog"]
            try:
                self.sampler.set_signals([], self.sampler.rate)
            except Exception:
                pass
        self.add_log("已重建机型符号: %s（%d 变量 / %d 外设）"
                     % (pid, res["counts"].get("variables", 0),
                        res["counts"].get("peripherals", 0)))
        return {"ok": True, "profile": profiles.summary(res["profile"], self.profiles_root),
                "profiles": self.profiles_payload(),
                "catalog": res["catalog"] if pid == (self.profile or {}).get("id") else None,
                "counts": res["counts"]}

    # ---- 日志 ----
    def add_log(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        self.log.append(line)
        if self.args.verbose:
            print("[scope] " + line, flush=True)

    # ---- 目录 ----
    def _apply_annotations(self, data: Dict[str, Any]) -> int:
        """把 <ID>/annotations.json（或 signals.json 同级 annotations.json）合并进目录。

        desc 是人工/源码注释，不属于 gen_signals 生成物；单独文件保证
        “导入 AXF / 从 AXF 重新生成”不会把它覆盖。
        """
        try:
            if self.profile:
                pid = str(self.profile.get("id") or "")
                if pid:
                    return profiles.apply_annotations(
                        data, profiles.load_annotations(pid, self.profiles_root))
            ann_path = os.path.join(os.path.dirname(self.signals_path), "annotations.json")
            if os.path.isfile(ann_path):
                with open(ann_path, "r", encoding="utf-8") as f:
                    ann = json.load(f)
                return profiles.apply_annotations(data, ann if isinstance(ann, dict) else {})
        except Exception as exc:
            self.add_log("合并变量注释失败: %s" % exc)
        return 0

    def _demo_catalog_path(self) -> str:
        """仿真演示符号表路径（profiles/demo/<机型>.signals.json）。

        没有任何真实符号表时用它兜底，让新用户连仿真就能看到曲线。
        地址是假的，不能用于实机。"""
        pid = str((self.profile or {}).get("id") or "")
        if not pid:
            return ""
        path = os.path.join(self.profiles_root, "demo", "%s.signals.json" % pid)
        return path if os.path.isfile(path) else ""

    def load_catalog(self, auto_regen: bool = True) -> None:
        with self.catalog_lock:
            data = None
            try:
                if os.path.isfile(self.signals_path):
                    with open(self.signals_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
            except Exception as exc:
                self.catalog_error = "读取 signals.json 失败: %s" % exc
            # 只有在 signals.json 完全缺失时才自动生成。不能因为 AXF 比 JSON 新
            # 就在启动时静默重建：板子里跑的可能是旧固件，地址会整体错位。
            # 固件更新后用“导入 AXF”或“从当前 AXF 重新生成”显式操作。
            need = data is None
            if need and auto_regen and os.path.isfile(self.axf):
                try:
                    data = self.regenerate_catalog()
                except Exception as exc:
                    self.catalog_error = "自动生成信号表失败: %s" % exc
                    self.add_log(self.catalog_error)
            if data is None:
                # 该机型还没有真实符号表（新 clone / 没导入过 AXF）。
                # 回退到 profiles/demo/ 的仿真演示表，保证连仿真就能看到曲线；
                # 日志里明确标注，避免被误当成真实固件符号。
                demo = self._demo_catalog_path()
                if demo:
                    try:
                        with open(demo, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        self.add_log("未找到机型符号表，已使用仿真演示符号表: %s"
                                     % os.path.basename(demo))
                    except Exception as exc:
                        self.add_log("读取演示符号表失败: %s" % exc)
            if data is None:
                data = {"meta": {}, "variables": [], "peripherals": [],
                        "defaults": [], "stall": {}}
            self._apply_annotations(data)
            self.catalog = data
            self.add_log("信号表: %d 个变量 / %d 个外设 (%s)"
                         % (len(data.get("variables", [])), len(data.get("peripherals", [])),
                            data.get("meta", {}).get("generated_at", "?")))

    def regenerate_catalog(self) -> Dict[str, Any]:
        try:
            import gen_signals  # 同目录, 依赖 pyelftools
        except Exception as exc:
            raise RuntimeError("需要 pyelftools 才能从 AXF 生成信号表: %s" % exc)
        if self.profile:
            # 机型工程: 头文件 / SVD / RAM 范围 / 默认信号都从 profile.json 来
            data = profiles.build_catalog(self.profile)
            self.profile = profiles.apply_counts(self.profile, data)
            profiles.write_profile(self.profile, self.profiles_root)
        else:
            header = self.header if os.path.isfile(self.header) else ""
            map_path = os.path.join(os.path.dirname(self.axf), "DR2159.map")
            data = gen_signals.build(self.axf, header,
                                     map_path if os.path.isfile(map_path) else None)
        self._apply_annotations(data)
        os.makedirs(os.path.dirname(self.signals_path) or ".", exist_ok=True)
        tmp = self.signals_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, self.signals_path)
        self.add_log("已从 AXF 重建信号表 (%s)" % data.get("meta", {}).get("generated_at"))
        return data

    def import_catalog(self, axf_bytes: bytes, axf_name: str,
                       header_bytes: Optional[bytes] = None,
                       header_name: str = "",
                       import_mode: str = "header") -> Dict[str, Any]:
        """导入一个 AXF/ELF（可选 cw32l011.h），重建 signals.json.

        不依赖项目目录: 文件会存到 tools/motor_scope/imports/ 后再解析。
        """
        if not axf_bytes:
            raise RuntimeError("AXF 文件为空")
        if not axf_bytes.startswith(b"\x7fELF"):
            raise RuntimeError("不是 ELF/AXF 文件（缺少 \x7fELF 头）")
        if len(axf_bytes) > 32 * 1024 * 1024:
            raise RuntimeError("AXF 太大（>32MB）")
        try:
            import gen_signals
        except Exception as exc:
            raise RuntimeError("需要 pyelftools 才能解析 AXF: %s" % exc)
        os.makedirs(self.import_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S") + "_%d" % (time.time_ns() % 1000000)

        def safe(name: str, default: str) -> str:
            base = os.path.basename(name or default)
            base = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)[:96]
            return base or default

        axf_path = os.path.join(self.import_dir, stamp + "_" + safe(axf_name, "import.axf"))
        with open(axf_path, "wb") as f:
            f.write(axf_bytes)
        header_path = self.header if os.path.isfile(self.header) else ""
        if header_bytes:
            header_path = os.path.join(self.import_dir, stamp + "_" + safe(header_name, "cw32l011.h"))
            with open(header_path, "wb") as f:
                f.write(header_bytes)
        map_path = os.path.join(os.path.dirname(axf_path), "DR2159.map")
        prof = self.profile or {}
        psrc = prof.get("source") or {}
        svd = profiles.host_path(str(psrc.get("svd") or ""))
        ram = prof.get("ram") or None
        if isinstance(ram, list) and len(ram) == 2:
            ram = (int(ram[0]), int(ram[1]))
        else:
            ram = None
        data = gen_signals.build(
            axf_path, header_path,
            map_path if os.path.isfile(map_path) else None,
            svd=svd if svd and os.path.isfile(svd) else None,
            mcu=str(prof.get("mcu") or ""), ram=ram,
            defaults=list(prof.get("defaults") or []),
            stall=dict(prof.get("stall") or {}),
        )
        self._apply_annotations(data)
        if self.profile:
            meta = dict(self.profile)
            src = dict(psrc)
            src["axf"] = axf_path
            if header_bytes:
                src["header"] = header_path
            meta["source"] = src
            meta = profiles.apply_counts(meta, data)
            self.profile = profiles.write_profile(meta, self.profiles_root)
        os.makedirs(os.path.dirname(self.signals_path) or ".", exist_ok=True)
        tmp = self.signals_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, self.signals_path)
        with self.catalog_lock:
            self.catalog = data
            self.axf = axf_path
            if header_path:
                self.header = header_path
        warning = ""
        template_used = ""
        if not data.get("peripherals"):
            mcu = str((data.get("meta") or {}).get("mcu") or "")
            if import_mode == "vars":
                self.add_log("仅导入变量（%s），外设寄存器沿用当前模板" % (mcu or "未知型号"))
            else:
                template_used = find_mcu_template(mcu)
                if template_used:
                    self.add_log("AXF 未带可用头文件，外设寄存器使用内置模板: %s" % template_used)
                else:
                    warning = "未解析到外设寄存器，请重新导入 SVD"
                    self.add_log(warning)
        self.add_log("已导入 AXF: %s (%d 变量 / %d 外设)"
                     % (safe(axf_name, "axf"), len(data.get("variables", [])),
                        len(data.get("peripherals", []))))
        return {"ok": True, "catalog": data,
                "counts": {"variables": len(data.get("variables", [])),
                           "peripherals": len(data.get("peripherals", []))},
                "header_used": os.path.basename(header_path) if header_path else "",
                "template_used": template_used,
                "mode": import_mode,
                "warning": warning}

    def import_register_table(self, data: bytes, name: str) -> Dict[str, Any]:
        """只更新外设寄存器表：支持 .svd / .h / .json，不动变量与地址。"""
        ext = os.path.splitext(name or "")[1].lower()
        if not data:
            raise RuntimeError("寄存器表文件为空")
        if len(data) > 32 * 1024 * 1024:
            raise RuntimeError("寄存器表文件超过 32MB")
        periphs: List[Dict[str, Any]] = []
        source = ext.lstrip(".")
        if ext == ".svd":
            os.makedirs(self.import_dir, exist_ok=True)
            stamp = time.strftime("%Y%m%d_%H%M%S") + "_%d" % (time.time_ns() % 1000000)
            safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", os.path.basename(name or "table.svd"))[:96] or "table.svd"
            path = os.path.join(self.import_dir, stamp + "_" + safe)
            with open(path, "wb") as f:
                f.write(data)
            periphs = _svd_peripherals(path)
            source = "svd"
        elif ext == ".json":
            try:
                obj = json.loads(data.decode("utf-8"))
            except Exception as exc:
                raise RuntimeError("JSON 解析失败: %s" % exc)
            periphs = obj.get("peripherals") if isinstance(obj, dict) else obj
            if not isinstance(periphs, list):
                raise RuntimeError("JSON 里没有 peripherals 数组")
            source = "json"
        else:
            raise RuntimeError("寄存器表只支持 .svd / .json（CW32 已内置模板，不需要头文件）")

        if not periphs:
            raise RuntimeError("未解析到外设寄存器，请重新导入 SVD")
        with self.catalog_lock:
            self.catalog["peripherals"] = periphs
            meta = self.catalog.setdefault("meta", {})
            meta["peripheral_count"] = len(periphs)
            meta["register_table"] = os.path.basename(name or "")
            meta["register_source"] = source
            tmp = self.signals_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.catalog, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, self.signals_path)
        if self.profile:
            try:
                meta = profiles.apply_counts(dict(self.profile), self.catalog)
                self.profile = profiles.write_profile(meta, self.profiles_root)
            except Exception:
                pass
        self.add_log("寄存器表已导入: %s (%d 外设, 来源 %s)" % (
            os.path.basename(name or ""), len(periphs), source))
        return {"ok": True, "catalog": self.catalog,
                "counts": {"peripherals": len(periphs),
                           "variables": len(self.catalog.get("variables") or [])},
                "source": source}

    def reset_recording(self) -> Dict[str, Any]:
        self.sampler.recorder.reset()
        self.add_log("录制已手动重置")
        return {"ok": True, "record": self.sampler.recorder.info()}

    def default_config(self) -> Dict[str, Any]:
        variables = {v["name"]: v for v in self.catalog.get("variables", [])}
        defaults = list(self.catalog.get("defaults") or [])
        if not defaults:
            defaults = [v["name"] for v in self.catalog.get("variables", [])[:4]]
        signals = []
        for i, name in enumerate(defaults[:8]):
            v = variables.get(name)
            if not v:
                continue
            d = dict(v)
            d.update({
                "id": name, "color": PALETTE[i % len(PALETTE)],
                "scale": 1.0, "offset": 0.0,
                "unit": default_unit(name),
                "step": any(k in name for k in ("threshold", "state", "level", "conts")),
                "visible": True,
                "axis": default_axis(name),
            })
            signals.append(d)
        return {"signals": signals, "rate": self.args.rate}

    # ---- 状态 ----
    def lan_payload(self) -> Dict[str, Any]:
        ips = getattr(self, "lan_ips", None)
        if ips is None:
            ips = lan_ipv4_addresses()
        return {
            "ips": [str(ip) for ip in (ips or [])],
            "port": int(getattr(self, "lan_port", 0) or 0),
        }

    def signal_flags_snapshot(self) -> Dict[str, Dict[str, Any]]:
        with self.signal_flags_lock:
            return {str(k): dict(v) for k, v in self.signal_flags.items()}

    def _find_signal(self, sid: str) -> Optional[Signal]:
        sid = str(sid or "")
        if not sid:
            return None
        try:
            for s in list(self.sampler.signals):
                if str(s.id) == sid:
                    return s
        except Exception:
            pass
        for item in self.catalog.get("variables", []) or []:
            if str(item.get("id") or item.get("name") or "") == sid:
                try:
                    return Signal(item)
                except Exception:
                    return None
        return None

    def config_payload(self) -> Dict[str, Any]:
        """只读配置：与 POST /api/config 的 signals/rate 同形，附带信号开关。"""
        with self.sampler._lock:
            sigs = [s.to_dict() for s in self.sampler.signals]
            rate = self.sampler.rate
            generation = self.sampler.generation
        return {
            "ok": True,
            "signals": sigs,
            "rate": rate,
            "generation": generation,
            "signal_flags": self.signal_flags_snapshot(),
        }

    def set_signal_flags(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """更新 API 侧表/波/写/颜色；read=true 只做一次读取，不落开关。

        请求：{"id":"x","table":true,"plot":false,"write":false,"color":"#22d3ee",
               "read":true,"clear":false}
        或批量：{"flags":{"id1":{"table":true}, "id2":{"clear":true}}}
        color 接受 #RGB / #RRGGBB（可省略 #）；read 只读一次，不落开关。
        """
        raw_batch = payload.get("flags") if isinstance(payload.get("flags"), dict) else None
        specs: Dict[str, Dict[str, Any]] = {}
        if raw_batch is not None:
            for sid, spec in raw_batch.items():
                if isinstance(spec, dict):
                    specs[str(sid)] = dict(spec)
        else:
            sid = str(payload.get("id") or "")
            if not sid:
                return {"ok": False, "error": "缺少 id"}
            specs[sid] = {
                "table": payload.get("table"), "plot": payload.get("plot"),
                "write": payload.get("write"), "color": payload.get("color"),
                "read": payload.get("read"), "clear": payload.get("clear"),
            }
        updated = []
        read_result = None
        with self.signal_flags_lock:
            current = {k: dict(v) for k, v in self.signal_flags.items()}
            for sid, spec in specs.items():
                if spec.get("clear"):
                    current.pop(sid, None)
                    updated.append(sid)
                    continue
                sig = self._find_signal(sid)
                if sig is None:
                    return {"ok": False, "error": "未知信号 id: %s" % sid}
                entry = current.get(sid, {})
                touched = False
                color = None
                if "color" in spec and spec.get("color") is not None:
                    raw_color = str(spec.get("color")).strip()
                    if raw_color and not raw_color.startswith("#"):
                        raw_color = "#" + raw_color
                    if not re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})", raw_color):
                        return {"ok": False, "error": "颜色格式应为 #RGB 或 #RRGGBB"}
                    entry["color"] = raw_color
                    color = raw_color
                    touched = True
                for key in ("table", "plot", "write"):
                    if key in spec and spec.get(key) is not None:
                        entry[key] = bool(spec[key])
                        touched = True
                if touched:
                    current[sid] = entry
                    updated.append(sid)
                if color:
                    # 已采样的 Signal 立即同步颜色（/api/config 与 status 立刻可见）
                    try:
                        with self.sampler._lock:
                            for active in self.sampler.signals:
                                if str(active.id) == sid:
                                    active.color = color
                    except Exception:
                        pass
                    for item in self.catalog.get("variables", []) or []:
                        if str(item.get("id") or item.get("name") or "") == sid:
                            item["color"] = color
                if spec.get("read"):
                    try:
                        bit = [sig.shift, sig.width] if sig.width else None
                        read_result = self.read_value({
                            "addr": sig.addr, "size": sig.size,
                            "signed": bool(sig.signed), "bit": bit,
                        })
                        read_result = dict(read_result)
                        read_result["id"] = sid
                    except Exception as exc:
                        read_result = {"ok": False, "id": sid, "error": str(exc)}
            self.signal_flags = current
            flags = {k: dict(v) for k, v in current.items()}
        try:
            self.hub.publish({"type": "flags", "flags": flags})
        except Exception:
            pass
        out: Dict[str, Any] = {"ok": True, "updated": updated, "flags": flags}
        if read_result is not None:
            out["read"] = read_result
        return out

    def status_payload(self) -> Dict[str, Any]:
        src = self.source
        info = src.info() if src else {"kind": "none", "connected": False}
        meta = self.catalog.get("meta", {})
        return {
            "version": VERSION,
            "source": info,
            "arch": self.arch,
            "mcu": self.mcu,
            "chip": self.chip,
            "profile": self.profile_summary(),
            "profiles": self.profiles_payload(),
            "sampler": self.sampler.status(),
            "record": self.sampler.recorder.info(),
            "catalog": {
                "meta": meta,
                "counts": {"variables": len(self.catalog.get("variables", [])),
                           "peripherals": len(self.catalog.get("peripherals", []))},
                "error": self.catalog_error,
                "axf": self.axf,
                "axf_exists": os.path.isfile(self.axf),
                "signals_json": self.signals_path,
            },
            "config": {"signals": [s.to_dict() for s in self.sampler.signals],
                       "rate": self.sampler.rate,
                       "signal_flags": self.signal_flags_snapshot()},
            "signal_flags": self.signal_flags_snapshot(),
            "lan": self.lan_payload(),
            "error": self.error,
            "connect_error": self.last_connect_error,
            "openocd_found": self._openocd_info(),
            "uptime": round(time.time() - self.started, 1),
        }

    def _openocd_info(self) -> Dict[str, Any]:
        paths = ocd.find_openocd(self.project, self.openocd_override)
        if paths is None:
            return {"found": False}
        return {"found": True, "exe": paths.exe, "iface": paths.iface,
                "target": paths.target, "scripts": paths.scripts}

    def log_tail(self, n: int = 120) -> List[str]:
        out = list(self.log)[-n:]
        if self.source is not None and getattr(self.source, "proc", None) is not None:
            out += self.source.proc.log_tail(80)
        return out

    # ---- 芯片识别 ----
    def _probe_chip(self, src: Optional[Source] = None) -> Optional[Dict[str, Any]]:
        src = src if src is not None else self.source
        if src is None:
            self.chip = None
            return None
        expected = str((self.catalog.get("meta") or {}).get("mcu") or "")
        try:
            info = probe_chip(src, load_mcu_index(), expected)
        except Exception as exc:
            info = {"detected": "", "expected": expected, "match": None,
                    "warning": "", "error": str(exc), "evidence": {}}
        self.chip = info
        if info:
            if info.get("warning"):
                self.add_log(info["warning"])
            elif info.get("detected"):
                suffix = "" if info.get("exact") else "（仅识别到系列）"
                self.add_log("芯片识别: %s%s" % (info["detected"], suffix))
        return info

    def probe_chip_now(self) -> Dict[str, Any]:
        if self.source is None:
            return {"ok": False, "error": "未连接"}
        info = self._probe_chip()
        return {"ok": True, "chip": info}

    # ---- 连接 ----
    def disconnect(self) -> None:
        src, self.source = self.source, None
        self.chip = None
        self.sampler.set_source(None)
        self.sampler.recorder.stop()
        if self.record_cache is not None:
            try:
                self.record_cache.finish()
            except Exception as exc:
                self.add_log("结束录制缓存会话失败: %s" % exc)
        if src is not None:
            try:
                src.close()
            except Exception as exc:
                self.add_log("关闭源失败: %s" % exc)
            self.add_log("已断开")

    def _begin_recording(self) -> None:
        try:
            self.sampler.recorder.start(self.sampler.signals)
            self.add_log("自动录制已开始 (%d 路)" % len(self.sampler.signals))
        except Exception as exc:
            self.add_log("自动录制启动失败: %s" % exc)

    def connect(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        mode = str(payload.get("mode") or "openocd").lower()
        self.error = ""
        self.last_connect_error = ""
        # 先停掉旧源: H7-TOOL 只有一个, 新旧 openocd 不能同时占着
        self.disconnect()
        if mode == "sim":
            src: Source = SimSource()
            self.source = src
            self.chip = None
            self.sampler.set_source(src)
            self.add_log("已切换到仿真信号源")
            self._begin_recording()
            return {"ok": True, "source": src.info(), "chip": None}

        if mode == "attach":
            host = str(payload.get("host") or "127.0.0.1")
            port = int(payload.get("port") or 6666)
            client = ocd.TclClient(host, port, timeout=4.0)
            try:
                client.connect()
                client.install_reader()
                try:
                    cpuid = client.read_words(0xE000ED00, 1)[0]
                except Exception:
                    cpuid = None
            except Exception as exc:
                client.close()
                self.last_connect_error = str(exc)
                raise
            src = AttachedSource(client, host, port)
            src.cpuid = cpuid  # type: ignore[attr-defined]
            self.source = src
            self.sampler.set_source(src)
            self.add_log("已连上外部 TCL %s:%d, CPUID=%s" % (
                host, port, "0x%08x" % cpuid if cpuid is not None else "?"))
            self._probe_chip(src)
            self._begin_recording()
            return {"ok": True, "source": src.info(), "chip": self.chip}

        # 本地拉起 openocd
        prof = self.profile or {}
        arch = str(payload.get("arch") or prof.get("arch") or "cw32").lower()
        self.arch = "riscv" if arch in ("riscv", "ch32", "ch32v203", "rv32") else "cw32"
        exe = payload.get("openocd") or self.openocd_override
        iface = payload.get("iface") or self.iface_override or prof.get("interface") or ""
        target = payload.get("target") or self.target_override or prof.get("target") or ""
        # 目录名无关解析：绝对路径直接用；相对路径按工程根；再不行在 tools/*/target/ 搜同名
        target = profiles.resolve_target(str(target), HERE)
        if self.arch == "riscv":
            paths = ocd.find_wch_openocd(self.project, exe)
            if paths is None:
                msg = ("找不到 WCH RISC-V OpenOCD：请把独立仓库 openocd-wch-fast 放到工程 "
                       "tools/ 下（需 bin/openocd.exe + bin/wch-riscv.cfg），"
                       "或在信号源面板填「OpenOCD 根目录」自定义路径")
                self.last_connect_error = msg
                raise RuntimeError(msg)
            if iface:
                paths = ocd.OcdPaths(paths.exe, paths.scripts, iface, paths.target)
        else:
            paths = ocd.find_openocd(self.project, exe)
            if paths is None:
                msg = ("找不到可用的 OpenOCD：请把发行版放到工程 tools/openocd/ 下"
                       "（需 bin/openocd.exe + share/openocd/scripts/interface/cmsis-dap-v1.cfg "
                       "+ share/openocd/scripts/target/cw32l01x-flm.cfg），"
                       "或在信号源面板填「OpenOCD 根目录」自定义路径")
                self.last_connect_error = msg
                raise RuntimeError(msg)
        if iface:
            # 前端给的多是裸 cfg 名（cmsis-dap.cfg）；-f 需要可解析的路径。
            # 相对于 OpenOCD 的 scripts/interface 目录解析，避免 -f 找不到文件。
            if os.path.isabs(iface):
                iface_path = iface
            else:
                cand = os.path.join(paths.scripts, "interface", iface)
                iface_path = cand if os.path.isfile(cand) else iface
            paths = ocd.OcdPaths(paths.exe, paths.scripts, iface_path, target or paths.target)
        if target:
            paths = ocd.OcdPaths(paths.exe, paths.scripts, paths.iface, target)
        if not os.path.isfile(paths.exe):
            msg = "OpenOCD 不存在: %s" % paths.exe
            self.last_connect_error = msg
            raise RuntimeError(msg)
        port = int(payload.get("tcl_port") or 0)
        # 用户在前端选了具体调试器 -> serial 精确指定用哪一个（同款多设备）。
        # RISC-V 走 WCH OpenOCD(wlinke+SDI)，不认 adapter serial，忽略。
        serial = str(payload.get("serial") or "").strip() if self.arch != "riscv" else ""
        proc = ocd.OcdProcess(paths, port=port, verbose=self.args.verbose,
                              serial=serial)
        try:
            client = proc.start(timeout=float(payload.get("timeout") or 15.0),
                                require_cpuid=(self.arch != "riscv"))
        except Exception as exc:
            proc.stop()
            self.last_connect_error = str(exc)
            raise
        src = OpenOcdSource(proc, client)
        src.riscv = (self.arch == "riscv")
        scan = prof.get("scan") if isinstance(prof.get("scan"), dict) else {}
        try:
            if scan.get("max_gap"):
                src.max_gap = max(0, int(scan["max_gap"]))
            if scan.get("max_words"):
                src.max_words = max(1, int(scan["max_words"]))
            # 代价模型也可在 profile.scan 写死 (两项都给才跳过自动标定)
            if scan.get("region_cost") is not None and scan.get("word_cost") is not None:
                src.region_cost = max(0.01, float(scan["region_cost"]))
                src.word_cost = max(0.0001, float(scan["word_cost"]))
                src.calibrated = True
        except Exception:
            pass
        if src.riscv:
            client.install_halt_reader()
            try:
                client.command("riscv set_prefer_sba on")
            except Exception:
                pass
            src.try_nohalt = True
            if self.sampler.rate > 50:
                self.sampler.set_rate(50)
                self.add_log("RISC-V 读取需要 halt，采样率上限 50 Hz")
        try:
            if src.riscv:
                src.cpuid = client.read_regions_halt([(0xE000ED00, 1)])[0]
            else:
                src.cpuid = client.read_words(0xE000ED00, 1)[0]
        except Exception:
            src.cpuid = None
        self.source = src
        self.sampler.set_source(src)
        self.add_log("OpenOCD 已连接 (pid=%s, tcl_port=%d)" % (proc.pid, proc.port))
        self._probe_chip(src)
        self._begin_recording()
        if src.riscv:
            try:
                client.command("resume")
            except Exception:
                pass
        return {"ok": True, "source": src.info(), "chip": self.chip}

    def auto_connect(self) -> None:
        try:
            self.connect({"mode": "openocd", "timeout": 15})
        except Exception as exc:
            self.add_log("自动连接失败: %s" % exc)

    # ---- 配置 ----
    def apply_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raw = payload.get("signals")
        if not isinstance(raw, list):
            raw = []
        signals: List[Signal] = []
        seen = set()
        for item in raw:
            try:
                s = Signal(item)
            except Exception:
                continue
            if not s.id:
                continue
            key = (s.id, s.addr, s.width, s.shift)
            if key in seen:
                continue
            seen.add(key)
            signals.append(s)
        rate = float(payload.get("rate") or 100)
        if getattr(self.source, "riscv", False) and rate > 50:
            self.add_log("RISC-V 读取需要 halt，采样率限制为 50 Hz")
            rate = 50.0
        self.sampler.set_signals(signals, rate)
        if self.sampler.recorder.active:
            self.sampler.recorder.set_signals(signals)
        self.add_log("采样配置: %d 路, %.0f Hz" % (len(signals), rate))
        return {"ok": True, "signals": [s.to_dict() for s in signals], "rate": rate}

    def read_value(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """一次性读取任意地址/位域（“读”按钮用），不加入采样。"""
        src = self.source
        if src is None:
            raise RuntimeError("未连接，不能读取")
        try:
            addr = int(payload.get("addr"))
            size = int(payload.get("size") or 4)
        except (TypeError, ValueError):
            raise RuntimeError("addr/size 无效")
        if size not in (1, 2, 4):
            raise RuntimeError("只支持 1/2/4 字节读取")
        signed = bool(payload.get("signed"))
        bit = payload.get("bit")
        span_addr = addr & ~0x3
        try:
            word = int(src.read_word(span_addr)) & 0xFFFFFFFF
        except Exception as exc:
            raise RuntimeError("读取 0x%08x 失败: %s" % (span_addr, exc))
        if isinstance(bit, (list, tuple)) and len(bit) >= 2:
            shift, width = int(bit[0]), int(bit[1])
            if width <= 0 or shift < 0 or shift + width > 32:
                raise RuntimeError("位域范围无效")
            value = (word >> shift) & ((1 << width) - 1)
            if signed and width < 32 and (value & (1 << (width - 1))):
                value -= 1 << width
        else:
            off = (addr & 0x3) * 8
            width = size * 8
            value = (word >> off) & ((1 << width) - 1)
            if signed and width < 32 and (value & (1 << (width - 1))):
                value -= 1 << width
        return {"ok": True, "addr": addr, "size": size, "value": value, "word": word}

    def reset_target(self) -> Dict[str, Any]:
        """SWD 复位：ARM 用 AIRCR.SYSRESETREQ，RISC-V 用 OpenOCD reset。

        不 halt 常驻：复位后目标从复位向量重新运行；采样线程会自动恢复读取。
        """
        src = self.source
        if src is None:
            raise RuntimeError("未连接，不能复位")
        client = getattr(src, "client", None)
        if client is None:
            raise RuntimeError("当前信号源不支持复位（仿真源没有调试器）")
        if getattr(src, "riscv", False) or str(getattr(self, "arch", "")) == "riscv":
            try:
                client.command("reset run", timeout=10.0)
                self.add_log("已复位目标 (RISC-V reset run)")
                return {"ok": True, "method": "reset run"}
            except Exception as exc:
                try:
                    client.command("reset halt", timeout=5.0)
                    client.command("resume", timeout=5.0)
                    self.add_log("已复位目标 (RISC-V reset halt + resume)")
                    return {"ok": True, "method": "reset halt + resume",
                            "warning": str(exc)}
                except Exception as exc2:
                    raise RuntimeError("RISC-V 复位失败: %s / %s" % (exc, exc2))
        # Cortex-M: 直接写 AIRCR.SYSRESETREQ，不依赖 srst 是否接线
        err = ""
        try:
            client.write_mem(0xE000ED0C, 4, 0x05FA0004)
            time.sleep(0.15)
            self.add_log("已复位目标 (AIRCR SYSRESETREQ)")
            return {"ok": True, "method": "SYSRESETREQ"}
        except Exception as exc:
            err = str(exc)
        try:
            client.command("reset run", timeout=10.0)
            self.add_log("已复位目标 (OpenOCD reset run)")
            return {"ok": True, "method": "reset run", "warning": err}
        except Exception as exc:
            # mww 可能因为目标立刻复位而返回错误；能重新读 CPUID 就认为已复位
            time.sleep(0.25)
            try:
                client.read_words(0xE000ED00, 1)
                self.add_log("已复位目标 (SYSRESETREQ, 写回读报错但目标已响应)")
                return {"ok": True, "method": "SYSRESETREQ", "warning": err}
            except Exception:
                raise RuntimeError("复位失败: %s / %s" % (err, exc))

    def _mcu_info_path(self, model: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(model or ""))[:64]
        return os.path.join(WEB_DIR, "mcu", (safe or "unknown") + ".info.json")

    def load_reginfo(self, model: str = "") -> Dict[str, Any]:
        model = str(model or self.mcu or (self.catalog.get("meta") or {}).get("mcu") or "")
        path = self._mcu_info_path(model)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return {"schema": 1, "model": model, "entries": []}
        if not isinstance(data, dict):
            return {"schema": 1, "model": model, "entries": []}
        data.setdefault("model", model)
        if not isinstance(data.get("entries"), list):
            data["entries"] = []
        return data

    def import_reginfo(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """独立导入寄存器描述（与寄存器模板互不影响）。"""
        model = str(payload.get("model") or self.mcu or
                    (self.catalog.get("meta") or {}).get("mcu") or "").strip()
        if not model:
            raise RuntimeError("未指定型号，无法保存寄存器信息")
        raw = payload.get("entries")
        if not isinstance(raw, list) or not raw:
            raise RuntimeError("缺少 entries 数组（或为空）")
        keep = ("key", "kind", "periph", "reg", "bit", "addr", "offset",
                "shift", "width", "page", "access", "reset", "static", "full",
                "states", "values")
        entries: List[Dict[str, Any]] = []
        seen = set()
        for item in raw:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key") or "").strip()
            if not key or key in seen:
                continue
            seen.add(key)
            out: Dict[str, Any] = {}
            for k in keep:
                if k not in item:
                    continue
                v = item[k]
                if k in ("addr", "offset", "shift", "width", "page"):
                    try:
                        v = int(v)
                    except (TypeError, ValueError):
                        continue
                elif k in ("static", "full", "access", "reset", "kind",
                           "periph", "reg", "bit", "key"):
                    v = str(v or "")
                elif k in ("states", "values"):
                    if not isinstance(v, dict):
                        continue
                    v = {str(a): str(b)[:200] for a, b in v.items()}
                out[k] = v
            if not out.get("kind"):
                out["kind"] = "bit" if out.get("bit") else "reg"
            if out.get("static"):
                out["static"] = out["static"][:200]
            if out.get("full"):
                out["full"] = out["full"][:2000]
            entries.append(out)
        if not entries:
            raise RuntimeError("没有有效的 entries")
        data = {
            "schema": 1,
            "model": model,
            "source": str(payload.get("source") or "LKS32MC07x User Manual"),
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "entries": entries,
        }
        path = self._mcu_info_path(model)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
        nreg = sum(1 for e in entries if e.get("kind") != "bit")
        # 和当前型号模板做一次 key 对账，方便发现导错型号/旧版本
        unmatched = 0
        try:
            tpl_path = os.path.join(WEB_DIR, "mcu",
                                    re.sub(r"[^A-Za-z0-9_.-]+", "_", model)[:64] + ".json")
            with open(tpl_path, "r", encoding="utf-8") as f:
                tpl = json.load(f)
            keys = set()
            for p in tpl.get("peripherals") or []:
                pn = str(p.get("name") or "")
                for r in p.get("regs") or []:
                    rk = pn + "." + str(r.get("name") or "")
                    keys.add(rk)
                    for b in r.get("bits") or []:
                        keys.add(rk + "." + str(b.get("name") or ""))
            unmatched = sum(1 for e in entries if e.get("key") not in keys)
        except Exception:
            pass
        self.add_log("寄存器信息已导入: %s (%d 条, %d 寄存器描述, %d 条与模板不匹配)" % (
            model, len(entries), nreg, unmatched))
        return {"ok": True, "model": model, "counts": {
            "entries": len(entries), "registers": nreg,
            "bits": len(entries) - nreg, "unmatched": unmatched}, "path": path}

    def write_value(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        src = self.source
        if src is None:
            raise RuntimeError("未连接，不能写入")
        try:
            addr = int(payload.get("addr"))
            size = int(payload.get("size") or 2)
            value = int(payload.get("value"))
        except (TypeError, ValueError):
            raise RuntimeError("addr/size/value 无效")
        if size not in (1, 2, 4):
            raise RuntimeError("只支持 1/2/4 字节写入")
        if addr % size != 0:
            raise RuntimeError("地址未按写入宽度对齐")
        bit = payload.get("bit")
        is_bitfield = isinstance(bit, (list, tuple)) and len(bit) >= 2
        if is_bitfield:
            shift, width = int(bit[0]), int(bit[1])
            if width <= 0 or width > 32 or shift < 0 or shift + width > 32:
                raise RuntimeError("位域范围无效")
            span_addr, span_size = addr & ~0x3, 4
        else:
            span_addr, span_size = addr, size
        span_end = span_addr + span_size
        if not ((0x20000000 <= span_addr and span_end <= 0x20002000) or
                (0x40000000 <= span_addr and span_end <= 0x50000000)):
            raise RuntimeError("只允许写 RAM / 外设寄存器（0x2000_0000 或 0x4000_0000）")
        if is_bitfield:
            value &= (1 << width) - 1
            word_addr = span_addr
            base = src.read_word(word_addr)
            mask = ((1 << width) - 1) << shift
            base = (base & ~mask) | ((value & ((1 << width) - 1)) << shift)
            src.write(word_addr, 4, base)
            readback = src.read_word(word_addr)
            actual = (readback >> shift) & ((1 << width) - 1)
        else:
            mask = (1 << (size * 8)) - 1
            value &= mask
            src.write(addr, size, value)
            readback = src.read_word(addr)
            actual = (readback >> ((addr & 0x3) * 8)) & mask
        verified = int(actual) == int(value)
        self.add_log("写入 0x%08x = 0x%x (回读 0x%x%s)"
                     % (addr, value, actual, "" if verified else ", 不一致"))
        return {"ok": True, "addr": addr, "size": size, "value": value,
                "readback": actual, "verified": verified}

    def record(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        active = bool(payload.get("active"))
        if active:
            self.sampler.recorder.start(self.sampler.signals)
            self.add_log("开始录制")
        else:
            self.sampler.recorder.stop()
            self.add_log("停止录制")
        return {"ok": True, "record": self.sampler.recorder.info()}

    def shutdown(self) -> None:
        self.running = False
        self.sampler.stop()
        try:
            self.disconnect()
        except Exception:
            pass
        if self.record_cache is not None:
            try:
                self.record_cache.close()
            except Exception:
                pass


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "MotorScope/" + VERSION
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        if getattr(self.app, "args", None) and self.app.args.verbose:
            sys.stderr.write("[http] " + (fmt % args) + "\n")

    # ---- helpers ----
    def _json(self, obj: Any, status: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data: bytes, ctype: str, status: int = 200,
               extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b"{}"
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}

    def _import_catalog(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._json({"ok": False, "error": "需要 multipart/form-data"}, 400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 32 * 1024 * 1024:
            return self._json({"ok": False, "error": "文件为空或超过 32MB"}, 400)
        body = self.rfile.read(length)
        files = parse_multipart(body, ctype)
        axf = files.get("axf")
        if not axf or not axf[1]:
            return self._json({"ok": False, "error": "缺少 axf 文件"}, 400)
        header = files.get("header")
        mode = files.get("expect")
        mode = mode[1].decode("utf-8", "replace") if mode and mode[1] else "header"
        if mode not in ("vars", "header"):
            mode = "header"
        try:
            res = self.app.import_catalog(
                axf[1], axf[0],
                header[1] if header and header[1] else None,
                header[0] if header else "",
                import_mode=mode,
            )
            return self._json(res)
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)

    def _import_registers(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._json({"ok": False, "error": "需要 multipart/form-data"}, 400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 32 * 1024 * 1024:
            return self._json({"ok": False, "error": "文件为空或超过 32MB"}, 400)
        files = parse_multipart(self.rfile.read(length), ctype)
        table = files.get("table")
        if not table or not table[1]:
            return self._json({"ok": False, "error": "缺少寄存器表文件"}, 400)
        try:
            return self._json(self.app.import_register_table(table[1], table[0] or "table"))
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)

    # ---- routes ----
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/status":
                return self._json(self.app.status_payload())
            if path == "/api/usb-devices":
                # 枚举当前连接的 USB 设备，标注 MotorScope 支持的调试探针。
                # 纯枚举，不打开/占用任何设备；?all=1 附带返回未识别的设备。
                qs = parse_qs(urlparse(self.path).query)
                include_all = (qs.get("all") or [""])[0].lower() in ("1", "true", "yes")
                try:
                    return self._json(usb_devices.enumerate_devices(include_all=include_all))
                except Exception as exc:  # 枚举失败也不能让整个接口 500 掉 UI
                    return self._json({"ok": False, "available": False,
                                       "count": 0, "supported": [],
                                       "error": str(exc)})
            if path == "/api/catalog":
                return self._json(self.app.catalog)
            if path == "/api/profiles":
                return self._json(self.app.profiles_payload())
            if path == "/api/reginfo":
                qs = parse_qs(urlparse(self.path).query)
                model = (qs.get("model") or [""])[0]
                return self._json(self.app.load_reginfo(model))
            if path == "/api/config":
                return self._json(self.app.config_payload())
            if path == "/api/docs":
                # 每次请求重新读取 API.md，改文档不需要重启；?format=md 返回原文。
                qs = parse_qs(urlparse(self.path).query)
                fmt = (qs.get("format") or [""])[0].lower()
                try:
                    markdown_text = api_docs.read_doc()
                except OSError as exc:
                    return self._json(
                        {"ok": False, "error": "无法读取 API.md: %s" % exc}, 500)
                if fmt == "md":
                    return self._bytes(markdown_text.encode("utf-8"),
                                       "text/markdown; charset=utf-8")
                page = api_docs.render_page(markdown_text, version=VERSION)
                return self._bytes(page.encode("utf-8"),
                                   "text/html; charset=utf-8",
                                   extra={"X-Content-Type-Options": "nosniff"})
            if path == "/api/signal-flags":
                return self._json({"ok": True,
                                   "flags": self.app.signal_flags_snapshot()})
            if path == "/api/history/next":
                qs = parse_qs(urlparse(self.path).query)
                after = None
                if qs.get("after"):
                    try:
                        after = float(qs["after"][0])
                    except ValueError:
                        after = None
                try:
                    limit = int((qs.get("limit") or ["1000"])[0])
                except ValueError:
                    limit = 1000
                try:
                    timeout = float((qs.get("timeout") or ["20"])[0])
                except ValueError:
                    timeout = 20.0
                return self._json(self.app.sampler.history_after(after, limit, timeout))
            if path == "/api/history":
                qs = parse_qs(urlparse(self.path).query)
                if "before" in qs or "limit" in qs:
                    before = None
                    if qs.get("before"):
                        try:
                            before = float(qs["before"][0])
                        except ValueError:
                            before = None
                    try:
                        limit = int((qs.get("limit") or ["1000"])[0])
                    except ValueError:
                        limit = 1000
                    return self._json(self.app.sampler.history_before(before, limit))
                try:
                    seconds = float((qs.get("seconds") or ["60"])[0])
                except ValueError:
                    seconds = 60.0
                samples = self.app.sampler.history_snapshot(seconds)
                return self._json({
                    "samples": samples,
                    "last_t": self.app.sampler.last_t,
                    "generation": self.app.sampler.generation,
                    "signals": self.app.sampler._signals_meta(),
                    "oldest": samples[0][0] if samples else None,
                    "latest": samples[-1][0] if samples else None,
                })
            if path == "/api/record-cache":
                return self._json(self.app.record_cache.info())
            if path == "/api/record-cache/overview":
                qs = parse_qs(urlparse(self.path).query)
                try:
                    max_points = int((qs.get("max_points") or ["2000"])[0])
                except (TypeError, ValueError):
                    max_points = 2000
                return self._json(self.app.record_cache.overview(max_points))
            if path == "/api/record-cache/window":
                qs = parse_qs(urlparse(self.path).query)
                def _num(name):
                    try:
                        return float((qs.get(name) or [""])[0])
                    except (TypeError, ValueError):
                        return None
                try:
                    max_points = int((qs.get("max_points") or ["20000"])[0])
                except (TypeError, ValueError):
                    max_points = 20000
                return self._json(self.app.record_cache.window(
                    _num("start"), _num("end"), max_points))
            if path == "/api/log":
                return self._json({"log": self.app.log_tail(200)})
            if path == "/api/record.csv":
                qs = parse_qs(urlparse(self.path).query)
                only = [x for x in (qs.get("ids") or [""])[0].split(",") if x]
                csv_text = self.app.sampler.recorder.csv(only or None)
                return self._bytes(csv_text.encode("utf-8-sig"), "text/csv; charset=utf-8",
                                   extra={"Content-Disposition": 'attachment; filename="motorscope.csv"'})
            if path == "/api/stream":
                return self._stream()
            if path.startswith("/api/share/"):
                sid = path[len("/api/share/"):].strip("/")
                data = self.app.get_share(sid)
                if data is None:
                    return self._json({"ok": False, "error": "分享不存在或已过期"}, 404)
                out = {"ok": True}
                out.update(data)
                return self._json(out)
            if path.startswith("/api/"):
                return self._json({"ok": False, "error": "unknown api"}, 404)
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            traceback.print_exc()
            try:
                return self._json({"ok": False, "error": str(exc)}, 500)
            except Exception:
                return

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        payload = {} if path in ("/api/catalog/import", "/api/catalog/registers") else self._read_json()
        try:
            if path == "/api/catalog/import":
                return self._import_catalog()
            if path == "/api/catalog/registers":
                return self._import_registers()
            if path == "/api/record/reset":
                return self._json(self.app.reset_recording())
            if path == "/api/connect":
                return self._json(self.app.connect(payload))
            if path == "/api/disconnect":
                self.app.disconnect()
                return self._json({"ok": True, "status": self.app.status_payload()})
            if path == "/api/share":
                try:
                    sid = self.app.create_share(payload)
                    return self._json({"ok": True, "id": sid})
                except Exception as exc:
                    return self._json({"ok": False, "error": str(exc)}, 400)
            if path == "/api/view":
                cid = str(payload.get("clientId") or "")
                if not cid:
                    return self._json({"ok": False, "error": "no clientId"}, 400)
                before = self.app.presence_payload()
                changed = self.app.presence_update(cid, payload.get("visible") or [], payload.get("layout") or {}, payload.get("label") or "")
                after = self.app.presence_payload()
                if changed or after != before:
                    self.app.hub.publish({"type": "presence", "presence": after})
                return self._json({"ok": True})
            if path == "/api/signal-flags":
                res = self.app.set_signal_flags(payload)
                return self._json(res, 200 if res.get("ok") else 400)
            if path == "/api/config":
                res = self.app.apply_config(payload)
                sigs = res.get("signals") or []
                roles = {}
                for x in payload.get("signals") or []:
                    if isinstance(x, dict):
                        roles[str(x.get("id") or "")] = str(x.get("role") or "signal")
                for s in sigs:
                    s["role"] = roles.get(str(s.get("id") or ""), "signal")
                self.app.hub.publish({"type": "config",
                                      "config": {"signals": sigs,
                                                 "rate": res.get("rate"),
                                                 "signal_flags": self.app.signal_flags_snapshot()}})
                return self._json(res)
            if path == "/api/profiles/switch":
                return self._json(self.app.switch_profile(payload.get("id")))
            if path == "/api/profiles/config":
                return self._json(self.app.save_profile_config(
                    payload, manual=bool(payload.get("manual"))))
            if path == "/api/profiles/build":
                return self._json(self.app.build_profile(payload.get("id")))
            if path == "/api/chip/probe":
                return self._json(self.app.probe_chip_now())
            if path == "/api/read":
                return self._json(self.app.read_value(payload))
            if path == "/api/reset":
                return self._json(self.app.reset_target())
            if path == "/api/reginfo/import":
                return self._json(self.app.import_reginfo(payload))
            if path == "/api/write":
                return self._json(self.app.write_value(payload))
            if path == "/api/record":
                return self._json(self.app.record(payload))
            if path == "/api/record-cache/save":
                res = self.app.record_cache.save_current()
                return self._json(res, 200 if res.get("ok") else 400)
            if path == "/api/catalog/reload":
                try:
                    with self.app.catalog_lock:
                        data = self.app.regenerate_catalog()
                        self.app.catalog = data
                    return self._json({"ok": True, "catalog": self.app.catalog})
                except Exception as exc:
                    return self._json({"ok": False, "error": str(exc)}, 500)
            if path == "/api/probe":
                # 只做一次握手/读 CPUID, 不切换源
                client = ocd.TclClient(str(payload.get("host") or "127.0.0.1"),
                                       int(payload.get("port") or 6666), timeout=3.0)
                try:
                    client.connect()
                    client.install_reader()
                    cpuid = client.read_words(0xE000ED00, 1)[0]
                finally:
                    client.close()
                return self._json({"ok": True, "cpuid": cpuid})
            return self._json({"ok": False, "error": "unknown api"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            self.app.last_connect_error = str(exc)
            return self._json({"ok": False, "error": str(exc)}, 500)

    # ---- SSE ----
    def _stream(self) -> None:
        app = self.app
        q = app.hub.subscribe()
        cid, cno = app.presence_add()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 1000\n\n")
            self._sse_send({"type": "hello",
                            "status": app.status_payload(),
                            "clients": app.hub.count(),
                            "clientId": cid,
                            "clientNo": cno,
                            "presence": app.presence_payload(),
                            "config": {"signals": [s.to_dict() for s in app.sampler.signals],
                                       "rate": app.sampler.rate,
                                       "signal_flags": app.signal_flags_snapshot()}})
            self.wfile.flush()
            app.hub.publish({"type": "presence", "presence": app.presence_payload()})
            last_status = time.monotonic()
            last_ping = time.monotonic()
            while app.running:
                try:
                    first = q.get(timeout=1.0)
                except queue.Empty:
                    now = time.monotonic()
                    if now - last_status >= 1.0:
                        self._sse_send({"type": "status", "status": app.status_payload()})
                        last_status = now
                    if now - last_ping >= 15.0:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = now
                    continue
                batch = [first]
                deadline = time.monotonic() + 0.045
                while len(batch) < 400:
                    remain = deadline - time.monotonic()
                    if remain <= 0:
                        break
                    try:
                        batch.append(q.get(timeout=remain))
                    except queue.Empty:
                        break
                samples: List[Any] = []
                others: List[Dict[str, Any]] = []
                for item in batch:
                    if item.get("type") == "s":
                        samples.extend(item.get("b") or [])
                    else:
                        others.append(item)
                for item in others:
                    self._sse_send(item)
                if samples:
                    self._sse_send({"type": "s", "b": samples})
                now = time.monotonic()
                if now - last_status >= 1.0:
                    self._sse_send({"type": "status", "status": app.status_payload()})
                    last_status = now
                if now - last_ping >= 15.0:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = now
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            app.hub.unsubscribe(q)
            app.presence_remove(cid)
            app.hub.publish({"type": "presence", "presence": app.presence_payload()})

    def _sse_send(self, obj: Dict[str, Any]) -> None:
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.wfile.write(b"data: " + data + b"\n\n")
        self.wfile.flush()

    # ---- static ----
    def _static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        rel = unquote(path.lstrip("/"))
        full = os.path.abspath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.abspath(WEB_DIR) + os.sep):
            return self._json({"ok": False, "error": "forbidden"}, 403)
        if not os.path.isfile(full):
            return self._json({"ok": False, "error": "not found"}, 404)
        ctype = _mime(full)
        with open(full, "rb") as f:
            data = f.read()
        self._bytes(data, ctype)


def _mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
    }.get(ext, "application/octet-stream")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------
def parse_args(argv: Optional[Sequence[str]] = None):
    ap = argparse.ArgumentParser(description="MotorScope - OpenOCD motor current scope")
    ap.add_argument("--port", type=int, default=8765, help="HTTP 端口 (默认 8765)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="本地 HTTP 绑定地址（默认 127.0.0.1；0.0.0.0 会同时把本地端口开到局域网）")
    ap.add_argument("--lan-port", type=int, default=0,
                    help="可选：额外的局域网固定出口端口（默认 0=关闭；80 需要管理员/portproxy）")
    ap.add_argument("--project", default="", help="DR2159_Project 目录")
    ap.add_argument("--axf", default="", help="AXF 路径")
    ap.add_argument("--header", default="", help="cw32l011.h 路径")
    ap.add_argument("--signals", default="", help="signals.json 路径")
    ap.add_argument("--openocd", default="", help="OpenOCD 根目录")
    ap.add_argument("--iface", default="", help="接口 cfg")
    ap.add_argument("--target", default="", help="目标 cfg")
    ap.add_argument("--attach", default="", help="附加到已有 tcl_port, 如 127.0.0.1:6666")
    ap.add_argument("--auto", action="store_true", help="启动后自动连接 OpenOCD")
    ap.add_argument("--sim", action="store_true", help="启动后直接进入仿真模式")
    ap.add_argument("--open", action="store_true", help="启动后打开浏览器")
    ap.add_argument("--rate", type=float, default=100.0, help="默认采样率 Hz")
    ap.add_argument("--record-cache-dir", default=os.path.join(HERE, ".record-cache"),
                    help="服务端分块压缩录制缓存目录（默认 ./.record-cache）")
    ap.add_argument("--record-cache-limit-mb", type=int, default=4096,
                    help="缓存总容量上限 MB（默认 4096；超限循环覆盖）")
    ap.add_argument("--record-cache-block-points", type=int, default=2000,
                    help="单个数据块最大点数（默认 2000）")
    ap.add_argument("--no-record-cache", action="store_true", help="关闭服务端录制缓存")
    ap.add_argument("--verbose", action="store_true", help="打印 OpenOCD / HTTP 日志")
    return ap.parse_args(argv)


def _lan_rank(ip: str) -> Tuple[int, str]:
    """局域网地址排序：默认路由/常见家用网段优先，虚拟网卡（172.x）靠后."""
    if ip.startswith("192.168."):
        return (0, ip)
    if ip.startswith("10."):
        return (1, ip)
    if ip.startswith("172."):
        try:
            second = int(ip.split(".")[1])
        except (ValueError, IndexError):
            second = 0
        if 16 <= second <= 31:
            return (2, ip)
    return (3, ip)


def lan_ipv4_addresses() -> List[str]:
    """本机可用的 IPv4 地址（默认路由优先，其次 192.168/10/172.16-31）."""
    ips = set()
    default_ip = ""
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET, socket.SOCK_STREAM):
            ip = str(info[4][0])
            if ip.startswith("127.") or ip.startswith("169.254.") or ip == "0.0.0.0":
                continue
            ips.add(ip)
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))   # 只查路由，不真正发包
            default_ip = str(s.getsockname()[0])
            if default_ip and not default_ip.startswith("127.") and default_ip != "0.0.0.0":
                ips.add(default_ip)
        finally:
            s.close()
    except OSError:
        pass
    ordered = sorted(ips, key=_lan_rank)
    if default_ip and default_ip in ordered:
        ordered.remove(default_ip)
        ordered.insert(0, default_ip)
    return ordered


def setup_windows_portproxy(lan_port: int, local_port: int) -> Tuple[bool, str]:
    """把 0.0.0.0:<lan_port> 转发到 127.0.0.1:<local_port>（需管理员）.

    只更新已存在的 v4tov4 规则；不新增，避免和别的 80 服务冲突。
    """
    if os.name != "nt":
        return False, "仅 Windows 支持 portproxy"
    netsh = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                         "System32", "netsh.exe")
    if not os.path.isfile(netsh):
        netsh = "netsh"
    cmd = [netsh, "interface", "portproxy", "set", "v4tov4",
           "listenport=%d" % lan_port, "listenaddress=0.0.0.0",
           "connectport=%d" % local_port, "connectaddress=127.0.0.1"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except Exception as exc:
        return False, str(exc)
    if p.returncode == 0:
        return True, ""
    msg = ((p.stdout or "") + (p.stderr or "")).strip()
    return False, (msg[:300] or "netsh 返回 %d" % p.returncode)


_WIN_TIMER_RES = False


def set_windows_timer_resolution(on: bool = True) -> bool:
    """把 Windows 定时器精度提到 1ms.

    采样线程靠 Event.wait 定时, 而 Windows 上它的粒度默认是 15.6ms:
    任何小于 15.6ms 的等待都会变成 15.6ms. 不调这个, 100 Hz 目标实际只能
    到 ~60 Hz, 250/300 Hz 更不可能; 调完之后 1ms 级等待是 ~1.5-2ms.
    """
    global _WIN_TIMER_RES
    if os.name != "nt" or _WIN_TIMER_RES == on:
        return _WIN_TIMER_RES
    try:
        import ctypes
        winmm = ctypes.WinDLL("winmm")
        fn = winmm.timeBeginPeriod if on else winmm.timeEndPeriod
        if fn(1) == 0:
            _WIN_TIMER_RES = on
    except Exception:
        pass
    return _WIN_TIMER_RES


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        # Windows 真控制台让 Python 走 Unicode API (PEP 528), 不要强改;
        # 管道/日志 (isatty=False) 用 UTF-8, 便于重定向和本仓库的测试抓取.
        if os.name != "nt" or not sys.stdout.isatty():
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if os.name != "nt" or not sys.stderr.isatty():
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    args = parse_args(argv)
    set_windows_timer_resolution(True)
    app = App(args)

    server = None
    port = args.port
    for attempt in range(12):
        try:
            server = Server((args.host, port), Handler)
            break
        except OSError as exc:
            if attempt == 11:
                print("无法监听 %s:%d: %s" % (args.host, port, exc))
                return 1
            port += 1
    server.app = app  # type: ignore[attr-defined]
    lan_port = int(getattr(args, "lan_port", 0) or 0)
    lan_server = None
    lan_proxy = False
    lan_active_port = port
    lan_error = ""
    lan_attempt = bool(lan_port) and lan_port != port
    if lan_attempt:
        try:
            lan_server = Server(("0.0.0.0", lan_port), Handler)
            lan_server.app = app  # type: ignore[attr-defined]
            lan_active_port = lan_port
        except OSError as exc:
            lan_error = str(exc)
            # 80 常被 Windows iphlpsvc 的 portproxy 占着；改规则指向本地端口
            ok, msg = setup_windows_portproxy(lan_port, port)
            if ok:
                lan_proxy = True
                lan_error = ""
                lan_active_port = lan_port
            else:
                lan_error = "%s；portproxy: %s" % (exc, msg)
                lan_active_port = port

    lan_visible = bool(lan_server or lan_proxy or
                       (args.host in ("0.0.0.0", "", "::") and lan_port in (0, port)))
    url = "http://%s:%d/" % (args.host if args.host != "0.0.0.0" else "127.0.0.1", port)
    lan = lan_ipv4_addresses()
    # 即使局域网共享关闭，也把本机 LAN IP 报给前端，分享链接优先用 192.*；
    # 分享链接是否可达取决于是否打开共享（主开关/--host 0.0.0.0）。
    app.lan_ips = list(lan)
    app.lan_port = int(lan_active_port) if lan_visible else 0
    print("MotorScope %s" % VERSION)
    print("  UI   : %s" % url)
    if lan_visible:
        for i, ip in enumerate(lan):
            print("  %s: http://%s:%d/" % ("LAN " if i == 0 else "LAN+", ip, lan_active_port))
        if lan_server is not None:
            print("  INFO : 局域网固定出口 :%d（本地端口变化不影响）" % lan_active_port)
        elif lan_proxy:
            print("  INFO : 局域网 :%d 由 Windows portproxy 转发到 127.0.0.1:%d"
                  % (lan_active_port, port))
        print("  WARN : 局域网可读/写目标内存、复位；无鉴权，仅限可信网络")
        app.add_log("局域网端口 %d（本地 %d，无鉴权）" % (lan_active_port, port))
    elif lan_error:
        print("  WARN : 局域网 %d 端口不可用（%s），本地仍可用"
              % (lan_port, lan_error))
        print("         管理员可执行: netsh interface portproxy set v4tov4 "
              "listenport=%d listenaddress=0.0.0.0 connectport=%d "
              "connectaddress=127.0.0.1" % (lan_port, port))
    else:
        print("  LAN  : 关闭（--lan-port 0 或 --host 127.0.0.1）")
    print("  AXF  : %s" % app.axf)
    print("  JSON : %s" % app.signals_path)
    if app.record_cache.enabled:
        print("  CACHE: %s（上限 %d MB，块 %d 点）" % (
            app.record_cache.root, app.record_cache.limit_bytes // (1024 * 1024),
            app.record_cache.block_points))
    else:
        print("  CACHE: 关闭（%s）" % (app.record_cache.error or "--no-record-cache"))
    oc = app._openocd_info()
    print("  OCD  : %s" % (oc.get("exe") or "not found"))
    print("  Ctrl+C 退出")

    def _atexit():
        try:
            app.shutdown()
        except Exception:
            pass
        try:
            set_windows_timer_resolution(False)
        except Exception:
            pass
    atexit.register(_atexit)
    app.sampler.start()

    if lan_server is not None:
        threading.Thread(target=lan_server.serve_forever,
                         kwargs={"poll_interval": 0.25},
                         name="motor-scope-lan", daemon=True).start()

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    if args.sim:
        try:
            app.connect({"mode": "sim"})
        except Exception as exc:
            app.add_log("仿真启动失败: %s" % exc)
    elif args.attach:
        try:
            host, _, p = args.attach.partition(":")
            app.connect({"mode": "attach", "host": host or "127.0.0.1",
                         "port": int(p or 6666)})
        except Exception as exc:
            app.add_log("附加失败: %s" % exc)
    elif args.auto:
        threading.Thread(target=app.auto_connect, name="auto-connect", daemon=True).start()

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\n退出...")
    finally:
        app.shutdown()
        if lan_server is not None:
            try:
                lan_server.shutdown()
                lan_server.server_close()
            except Exception:
                pass
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
