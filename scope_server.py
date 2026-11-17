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
    python scope_server.py --sim-connect --open
    python scope_server.py --attach 127.0.0.1:6666 --open
"""
from __future__ import annotations

import argparse
import atexit
import base64
import copy
import io
import json
import math
import os
import queue
import random
import re
import secrets
import socket
import struct
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
import screenshot
import usb_devices
import wave_groups
from record_cache import RecordCache

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_DEFAULT = os.path.abspath(os.path.join(HERE, "..", ".."))
WORKSPACE_PATH = os.path.join(HERE, "runtime", "workspace.json")
WEB_DIR = os.path.join(HERE, "web")
SIGNALS_JSON = os.path.join(HERE, "signals.json")
PROFILES_DIR = os.path.join(HERE, "profiles")
VERSION = "1.0.0"

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


def _svd_device_name(path: str) -> str:
    """只读 SVD 顶层的 <name>（不依赖 pyelftools），用于导入时比对型号。"""
    try:
        import xml.etree.ElementTree as ET
        root = ET.parse(path).getroot()
        return str(root.findtext("name") or "").strip()
    except Exception:
        return ""


def auto_target_cfg(mcu: str) -> str:
    """按型号在 tools/*/target 下找同名 cfg（如 n32g003.cfg），返回工程内相对路径.

    新机型没有手写 target 时，至少能自动用上用户放进 cfg 仓库的型号配置；
    找不到就返回空，仍走 ocd.py 的默认 target。
    """
    name = re.sub(r"[^A-Za-z0-9_.-]+", "", str(mcu or "")).strip().lower()
    if len(name) < 4:
        return ""
    tools_dir = os.path.join(HERE, "tools")
    try:
        entries = sorted(os.listdir(tools_dir))
    except OSError:
        return ""
    exact: List[str] = []
    prefix: List[str] = []
    for entry in entries:
        sub = os.path.join(tools_dir, entry)
        if not os.path.isdir(sub):
            continue
        for folder in (os.path.join(sub, "target"), sub):
            try:
                files = sorted(os.listdir(folder))
            except OSError:
                continue
            for fn in files:
                if not fn.lower().endswith(".cfg"):
                    continue
                stem = fn[:-4].lower()
                path = os.path.join(folder, fn)
                if stem == name:
                    exact.append(path)
                elif len(stem) >= 4 and name.startswith(stem):
                    prefix.append(path)
    picked = (exact or prefix)
    if not picked:
        return ""
    return os.path.relpath(picked[0], HERE).replace("\\", "/")


# ---------------------------------------------------------------------------
# CMSIS-DAP 探针兜底：后端（v2 WinUSB / v1 HID）与 adapter serial 大小写
# ---------------------------------------------------------------------------
def _cmsis_dap_iface_alternates(iface_path: str) -> List[str]:
    """同一颗探针的另一种后端 cfg：cmsis-dap.cfg(v2/auto) <-> cmsis-dap-v1.cfg(HID)。

    不同 DAPLink 固件的 HID v1 实现差别很大：H7-TOOL 只有 v1 稳，Air32 这类
    则只有 v2(WinUSB) 能应答 CMSIS-DAP 命令。不能全局写死某一种，失败时换另一种。
    """
    base = os.path.basename(str(iface_path or ""))
    if base not in ("cmsis-dap.cfg", "cmsis-dap-v1.cfg"):
        return []
    alt_name = "cmsis-dap-v1.cfg" if base == "cmsis-dap.cfg" else "cmsis-dap.cfg"
    alt = os.path.join(os.path.dirname(str(iface_path)), alt_name)
    return [alt] if os.path.isfile(alt) else []


def _serial_case_variants(serial: str) -> List[str]:
    """adapter serial 匹配是大小写敏感的；Windows PNP 实例后缀会被大写，
    而部分 DAPLink 固件上报的 USB 序列号是小写（Air32 CMSIS-DAP 就是）。
    依次试原样 / 全小写 / 全大写；H7-TOOL 的序列号本身含大写 B，原样即可命中。
    """
    serial = str(serial or "").strip()
    if not serial:
        return [""]
    out = [serial]
    for cand in (serial.lower(), serial.upper()):
        if cand not in out:
            out.append(cand)
    return out


def _is_adapter_retryable(exc: BaseException) -> bool:
    """只有「探针没打开 / 协议不通」才换后端或序列号重试。

    目标没供电、SWD 接错（cannot read IDR / DP）属于接线问题，换后端没用，
    直接报错，避免把 15s 超时重复三遍。
    """
    text = str(exc).lower()
    keys = (
        "unable to find a matching cmsis-dap",
        "cmd_info failed",
        "could not claim interface",
        "libusb_error",
        "no cmsis-dap device",
    )
    return any(k in text for k in keys)


def resolve_source_path(raw: str) -> str:
    """把 API 传入的 AXF/SVD 路径规范成宿主可读绝对路径（支持 Windows/WSL 映射）。"""
    p = profiles.host_path(str(raw or "").strip())
    if not p:
        return ""
    if not os.path.isabs(p):
        p = os.path.abspath(os.path.join(HERE, p))
    return p


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
                 "scale", "offset", "unit", "color", "step", "visible", "axis",
                 "is_float", "source", "key")

    def __init__(self, data: Dict[str, Any]):
        raw_id = str(data.get("id") or data.get("name") or "")
        source = str(data.get("source") or "")
        if "::" in raw_id:
            head, tail = raw_id.split("::", 1)
            if head and tail:
                source = source or head
                raw_id = tail
        self.id = raw_id
        self.source = source or "default"
        self.key = str(data.get("key") or (self.source + "::" + self.id))
        if "::" not in self.key:
            self.key = self.source + "::" + self.key
        if not self.source:
            self.source = self.key.split("::", 1)[0] or "default"
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
        # 旧 signals.json 没有 float 标记时按 type 兜底（目前只支持 float32）
        ftype = str(data.get("type") or "").strip().lower()
        self.is_float = bool(not self.width and (
            data.get("float") or data.get("is_float") or
            (self.size == 4 and ftype in ("float", "float32", "_float"))
        ))
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
            "source": self.source, "key": self.key,
        }
        if self.width:
            d["bit"] = [self.shift, self.width]
        if self.is_float:
            d["float"] = True
        d["axis"] = self.axis
        return d

    def mask(self) -> int:
        bits = self.width or (self.size * 8)
        return (1 << bits) - 1

    def decode(self, raw: int) -> Any:
        if self.width:
            v = (raw >> self.shift) & self.mask()
        else:
            v = raw & self.mask()
            if self.is_float and self.size == 4:
                fv = struct.unpack("<f", struct.pack("<I", v & 0xFFFFFFFF))[0]
                # NaN/Inf 不能进 JSON（浏览器 JSON.parse 不接受 NaN），用 null 表示
                return fv if math.isfinite(fv) else None
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
    closed = False          # close() 置 True；采样线程据此忽略断开时的收尾异常

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
        # 先标记关闭，采样线程在途的 read() 收到 socket 关闭错误时不再上报告警
        self.closed = True
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
        self.closed = True
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
            old_ids = [(str(x.get("id")), bool(x.get("float"))) for x in self.signals]
            new_ids = [(str(x.get("id")), bool(x.get("float"))) for x in new]
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
        keep: Optional[List[int]] = None
        if only_ids:
            want = set(str(x) for x in only_ids)
            matched = [i for i, s in enumerate(signals) if s.id in want]
            if matched:
                keep = matched
                signals = [signals[i] for i in matched]
            # 没有任何 id 命中（例如前端保存的 recordSel 已过期）时保留全部列，
            # 避免出现“表头有变量、数据行却只有 t_ms”的坏 CSV。
        out = io.StringIO()
        header = ["t_ms"] + ["%s%s" % (s.name, (" [%s]" % s.unit) if s.unit else "") for s in signals]
        out.write(",".join(_csv_cell(h) for h in header) + "\n")
        for t, vals in rows:
            cells = ["%.1f" % t]
            idx = keep if keep is not None else list(range(len(signals)))
            for j, i in enumerate(idx):
                sig = signals[j]
                raw = vals[i] if i < len(vals) else 0
                if raw is None:
                    cells.append("")
                    continue
                try:
                    val = float(raw) * sig.scale + sig.offset
                except (TypeError, ValueError):
                    cells.append("")
                    continue
                if not math.isfinite(val):
                    cells.append("")
                else:
                    cells.append(("%.4f" % val).rstrip("0").rstrip(".")
                                 if sig.scale != 1 or sig.offset else str(raw))
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
        key = tuple((s.key, s.addr, s.size, s.shift, s.width, s.is_float) for s in signals)
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
                if getattr(source, "closed", False):
                    # 断开/切换源时在途 read 的 socket 关闭错误：正常收尾，不报警
                    with self._lock:
                        if self.source is source:
                            self.error = ""
                    time.sleep(0.05)
                    continue
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

    def history_window(self, start: Optional[float] = None,
                       end: Optional[float] = None) -> Dict[str, Any]:
        """取 [start, end] 内的历史样本（单位同 /api/history 的 t_ms）。"""
        with self._lock:
            rows = list(self.history)
            signals = self._signals_meta()
            generation = self.generation
        if not rows:
            return {"signals": signals, "samples": [], "oldest": None,
                    "latest": None, "start": start, "end": end,
                    "generation": generation, "count": 0, "source": "history"}
        oldest, latest = float(rows[0][0]), float(rows[-1][0])
        t0 = oldest if start is None else float(start)
        t1 = latest if end is None else float(end)
        if t1 < t0:
            t0, t1 = t1, t0
        selected = [row for row in rows if t0 <= float(row[0]) <= t1]
        return {
            "signals": signals,
            "samples": selected,
            "oldest": oldest,
            "latest": latest,
            "start": (float(selected[0][0]) if selected else t0),
            "end": (float(selected[-1][0]) if selected else t1),
            "requested_start": t0,
            "requested_end": t1,
            "generation": generation,
            "count": len(selected),
            "source": "history",
        }

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
                        "reset": False, "generation": generation, "count": 0,
                        "run_id": self.epoch}
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
                    "reset": False, "generation": generation, "count": len(selected),
                    "run_id": self.epoch}

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
        run_id = self.epoch
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
                            "generation": generation, "count": 0,
                            "run_id": run_id}
                if rows:
                    # 服务重启后 t_ms 从头开始；旧 cursor 若在“未来”，
                    # 直接判定 reset，避免客户端 long-poll 一直等不到数据。
                    if after > latest + 5000.0:
                        return {"signals": signals, "samples": [], "cursor": latest,
                                "oldest": oldest, "latest": latest, "gap": True,
                                "reset": True, "timeout": False,
                                "generation": generation, "count": 0,
                                "run_id": run_id}
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
                                "count": len(selected), "run_id": run_id}
                if self._stop.is_set():
                    return {"signals": signals, "samples": [], "cursor": after,
                            "oldest": oldest, "latest": latest, "gap": False,
                            "reset": False, "timeout": False, "stopped": True,
                            "generation": generation, "count": 0,
                            "run_id": run_id}
                remain = deadline - time.monotonic()
                if remain <= 0:
                    return {"signals": signals, "samples": [], "cursor": after,
                            "oldest": oldest, "latest": latest, "gap": False,
                            "reset": False, "timeout": True,
                            "generation": generation, "count": 0,
                            "run_id": run_id}
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
                "run_id": self.epoch,
                "history": len(self.history),
                "oldest_t": self.history[0][0] if self.history else None,
                "latest_t": self.history[-1][0] if self.history else None,
            }



# --------------------------------------------------------------------------
# 多输入源：SourceInstance / AggregateSource / SourceManager
# --------------------------------------------------------------------------
SOURCE_KINDS = ("openocd", "attach", "sim", "stream")


def _source_slug(text: str, fallback: str = "source") -> str:
    s = re.sub(r"[^a-z0-9_-]+", "-", str(text or "").strip().lower()).strip("-")
    return (s or fallback)[:24]


def _source_color(index: int) -> str:
    return PALETTE[int(index) % len(PALETTE)]


class SourceInstance:
    """一个输入源实例 = profile/catalog + 连接 + 选中信号 + 状态。"""

    def __init__(self, sid: str, label: str, kind: str = "openocd",
                 profile_id: str = "", rate: float = 100.0,
                 connection: Optional[Dict[str, Any]] = None,
                 color: str = "") -> None:
        self.id = str(sid)
        self.label = str(label or sid)
        self.kind = kind if kind in SOURCE_KINDS else "openocd"
        self.profile_id = str(profile_id or "")
        self.rate = max(0.1, min(300.0, float(rate or 100.0)))
        self.connection = dict(connection or {})
        self.color = color or ""
        self.profile: Dict[str, Any] = {}
        self.catalog: Dict[str, Any] = {}
        self.arch = "cw32"
        self.mcu = ""
        self.chip: Optional[Dict[str, Any]] = None
        self.backend: Optional[Source] = None
        self.signals: List[Signal] = []
        self.error = ""
        self.connected = False
        self.started_at_ms: Optional[float] = None
        self.last_t: Optional[float] = None
        self.rate_actual = 0.0
        self.busy_ms = 0.0
        self.duty = 0.0
        self.next_due = 0.0
        self.last_values: Dict[str, Any] = {}
        self._rate_t0 = time.monotonic()
        self._rate_n = 0
        self.lock = threading.RLock()

    def to_workspace(self) -> Dict[str, Any]:
        sigs = []
        for s in self.signals:
            d = s.to_dict()
            # 只存本地信号定义，source/key 由加载时重新生成
            d.pop("source", None)
            d.pop("key", None)
            sigs.append(d)
        return {
            "id": self.id, "label": self.label, "kind": self.kind,
            "profile": self.profile_id, "rate": self.rate,
            "color": self.color, "connection": dict(self.connection),
            "started_at_ms": self.started_at_ms, "signals": sigs,
        }

    def status(self) -> Dict[str, Any]:
        catalog = self.catalog or {}
        return {
            "id": self.id, "label": self.label, "kind": self.kind,
            "profile": self.profile_id,
            "profile_name": str((self.profile or {}).get("name") or self.profile_id or ""),
            "arch": self.arch, "mcu": self.mcu,
            "chip": self.chip,
            "connected": bool(self.connected and self.backend is not None),
            "rate": round(float(self.rate or 0), 1),
            "rate_actual": round(float(self.rate_actual or 0), 1),
            "busy_ms": round(float(self.busy_ms or 0), 2),
            "duty": round(float(self.duty or 0), 3),
            "error": self.error,
            "last_t": (round(self.last_t, 1) if self.last_t is not None else None),
            "started_at_ms": self.started_at_ms,
            "signals": len(self.signals),
            "catalog": {
                "variables": len(catalog.get("variables") or []),
                "peripherals": len(catalog.get("peripherals") or []),
            },
            "color": self.color,
            "connection": dict(self.connection),
        }


class AggregateSource(Source):
    """Sampler 眼中的“一个源”，内部按 source 分派给多个后端。"""

    def __init__(self, manager: "SourceManager") -> None:
        self.manager = manager

    def info(self) -> Dict[str, Any]:
        return {
            "kind": "multi",
            "connected": any(s.connected and s.backend is not None
                             for s in self.manager.sources.values()),
            "sources": [s.status() for s in self.manager.sources.values()],
        }

    def _read_one(self, inst: SourceInstance, signals: Sequence[Signal]) -> List[Any]:
        with inst.lock:
            if inst.backend is None or not inst.connected:
                return [inst.last_values.get(s.key) for s in signals]
            now = time.monotonic()
            if now < inst.next_due:
                return [inst.last_values.get(s.key) for s in signals]
            t0 = time.monotonic()
            backend = inst.backend
            try:
                values = backend.read(list(signals))
                if len(values) != len(signals):
                    raise RuntimeError("source %s read returned %d/%d" % (
                        inst.id, len(values), len(signals)))
                inst.error = ""
                for sig, val in zip(signals, values):
                    inst.last_values[sig.key] = val
                inst._rate_n += 1
                inst.last_t = (t0 - self.manager.app.sampler.epoch) * 1000.0
                if inst.started_at_ms is None:
                    inst.started_at_ms = inst.last_t
                if t0 - inst._rate_t0 >= 1.0:
                    inst.rate_actual = inst._rate_n / (t0 - inst._rate_t0)
                    inst._rate_t0 = t0
                    inst._rate_n = 0
            except Exception as exc:
                # 断开/切换源时，在途 read 拿到的是 socket 已关闭（WinError 10038）
                # 或后端已被替换；这是收尾，不是故障，不写 inst.error。
                if (backend is not inst.backend or not inst.connected
                        or getattr(backend, "closed", False)):
                    return [inst.last_values.get(s.key) for s in signals]
                inst.error = str(exc)
                # 出错后稍微退避，避免把整条融合循环拖死；保留上次值
                inst.next_due = now + 0.4
                return [inst.last_values.get(s.key) for s in signals]
            elapsed = time.monotonic() - t0
            period = 1.0 / max(0.1, inst.rate)
            inst.busy_ms = (elapsed * 1000.0 if not inst.busy_ms
                            else inst.busy_ms * 0.8 + elapsed * 1000.0 * 0.2)
            inst.duty = (inst.busy_ms / (period * 1000.0)) if period > 0 else 0.0
            inst.next_due = now + period
            return [inst.last_values.get(s.key) for s in signals]

    def read(self, signals: Sequence[Signal]) -> List[Any]:
        groups: Dict[str, List[Signal]] = {}
        for sig in signals:
            groups.setdefault(sig.source or "default", []).append(sig)
        out: Dict[str, Any] = {}
        for sid, sigs in groups.items():
            inst = self.manager.sources.get(sid)
            if inst is None:
                for sig in sigs:
                    out[sig.key] = None
                continue
            vals = self._read_one(inst, sigs)
            for sig, val in zip(sigs, vals):
                out[sig.key] = val
        return [out.get(sig.key) for sig in signals]

    def read_word(self, source_id: str, addr: int) -> int:
        inst = self.manager.sources.get(source_id)
        if inst is None or inst.backend is None:
            raise RuntimeError("源未连接: %s" % source_id)
        return inst.backend.read_word(addr)

    def write(self, source_id: str, addr: int, size: int, value: int) -> None:
        inst = self.manager.sources.get(source_id)
        if inst is None or inst.backend is None:
            raise RuntimeError("源未连接: %s" % source_id)
        inst.backend.write(addr, size, value)

    def close(self) -> None:
        for inst in list(self.manager.sources.values()):
            self.manager.disconnect_source(inst.id, quiet=True)


class SourceManager:
    """多源注册、连接、配置与 workspace 持久化。"""

    def __init__(self, app: "App") -> None:
        self.app = app
        self.lock = threading.RLock()
        self.sources: Dict[str, SourceInstance] = {}
        self.primary_id = ""
        self.fusion_rate = max(1.0, min(300.0, float(app.args.rate or 100.0)))
        self.aggregate = AggregateSource(self)
        self.workspace_path = WORKSPACE_PATH
        self._loaded = False

    # ---- 初始化 / 迁移 ----
    def initialize(self) -> None:
        try:
            if not self._load_workspace():
                self._migrate_legacy()
            if not self.primary_id or self.primary_id not in self.sources:
                self.primary_id = next(iter(self.sources), "")
            self._sync_app_primary()
            self._apply_signals(self._flat_signals(), self._fusion_rate(),
                                persist=False)
            self._save_workspace()
            self._loaded = True
            self.app.add_log("多源工作区: %d 个输入源（%s）" % (
                len(self.sources), ", ".join(self.sources.keys())))
        except Exception as exc:
            self.app.add_log("初始化多源工作区失败，回退单源: %s" % exc)
            if not self.sources:
                self._migrate_legacy()
            self._loaded = True

    def _migrate_legacy(self) -> None:
        app = self.app
        meta = dict(app.profile or {})
        catalog = app.catalog or {}
        pid = str(meta.get("id") or "")
        try:
            saved = app.saved_sampler_config() or app.default_config()
        except Exception:
            saved = app.default_config()
        raw = []
        for _item in (saved.get("signals") or []):
            if isinstance(_item, Signal):
                raw.append(_item.to_dict())
            elif isinstance(_item, dict):
                raw.append(_item)
        rate = float(saved.get("rate") or app.sampler.rate or app.args.rate or 100.0)
        label = str(meta.get("name") or pid or "默认输入源")
        inst = SourceInstance("default", label, "openocd", pid, rate,
                              color=_source_color(0))
        inst.profile = meta
        inst.catalog = catalog
        inst.arch = "riscv" if str(meta.get("arch") or "").lower() == "riscv" else "cw32"
        inst.mcu = str(meta.get("mcu") or "")
        inst.signals = self._signals_with_source(raw, inst)
        self.sources[inst.id] = inst
        self.primary_id = inst.id

    def _load_workspace(self) -> bool:
        path = self.workspace_path
        if not os.path.isfile(path):
            return False
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
        except Exception:
            return False
        if not isinstance(data, dict) or not isinstance(data.get("sources"), list):
            return False
        loaded: Dict[str, SourceInstance] = {}
        for i, raw in enumerate(data.get("sources") or []):
            if not isinstance(raw, dict):
                continue
            sid = str(raw.get("id") or "")
            if not sid or sid in loaded:
                continue
            kind = str(raw.get("kind") or "openocd").lower()
            inst = SourceInstance(
                sid, str(raw.get("label") or sid), kind,
                str(raw.get("profile") or ""),
                float(raw.get("rate") or 100.0),
                raw.get("connection") if isinstance(raw.get("connection"), dict) else {},
                str(raw.get("color") or _source_color(i)),
            )
            inst.started_at_ms = (float(raw["started_at_ms"])
                                  if raw.get("started_at_ms") is not None else None)
            self._load_profile_for(inst)
            inst.signals = self._signals_with_source(
                raw.get("signals") if isinstance(raw.get("signals"), list) else [],
                inst)
            loaded[sid] = inst
        if not loaded:
            return False
        self.sources = loaded
        self.primary_id = str(data.get("primary") or next(iter(loaded), ""))
        try:
            self.fusion_rate = max(1.0, min(300.0, float(
                data.get("fusion_rate") or self.fusion_rate)))
        except (TypeError, ValueError):
            pass
        return True

    def _load_profile_for(self, inst: SourceInstance) -> None:
        app = self.app
        meta: Optional[Dict[str, Any]] = None
        if inst.profile_id:
            try:
                meta = profiles.read_profile(inst.profile_id, app.profiles_root)
            except Exception:
                meta = None
        if meta is None and inst.profile_id and str((app.profile or {}).get("id") or "") == inst.profile_id:
            meta = dict(app.profile or {})
        if meta is not None:
            inst.profile = dict(meta)
            inst.arch = "riscv" if str(meta.get("arch") or "").lower() == "riscv" else "cw32"
            inst.mcu = str(meta.get("mcu") or "")
            try:
                cat = profiles.load_catalog(inst.profile_id, app.profiles_root)
                if cat is None:
                    cat = profiles.build_catalog(meta, app.profiles_root)
                    profiles.save_catalog(inst.profile_id, cat, app.profiles_root)
                inst.catalog = cat or {}
            except Exception as exc:
                inst.error = "加载符号表失败: %s" % exc
                inst.catalog = {}
        elif inst.profile_id == "" and inst.kind in ("sim", "attach", "stream"):
            # 没有 profile 的源允许为空 catalog，由 signals 或动态通道补充
            inst.catalog = inst.catalog or {}
        else:
            inst.error = "找不到机型: %s" % (inst.profile_id or "?")

    def _signals_with_source(self, items: Sequence[Any], inst: SourceInstance) -> List[Signal]:
        variables = {
            str(v.get("name") or v.get("id") or ""): v
            for v in (inst.catalog.get("variables") or [])
            if v.get("name") or v.get("id")
        }
        out: List[Signal] = []
        seen = set()
        for item in items or []:
            if not isinstance(item, dict):
                continue
            local_id = str(item.get("id") or item.get("name") or "")
            if not local_id:
                continue
            base = variables.get(local_id)
            merged = dict(base or {})
            merged.update(item)
            merged["id"] = local_id
            merged["source"] = inst.id
            merged["key"] = inst.id + "::" + local_id
            try:
                sig = Signal(merged)
            except Exception:
                continue
            if sig.key in seen:
                continue
            seen.add(sig.key)
            out.append(sig)
        return out

    def _default_signals(self, inst: SourceInstance) -> List[Signal]:
        cat = inst.catalog or {}
        variables = {str(v.get("name") or v.get("id") or ""): v
                     for v in (cat.get("variables") or [])}
        defaults = list(cat.get("defaults") or [])
        if not defaults:
            defaults = [str(v.get("name") or v.get("id") or "")
                        for v in (cat.get("variables") or [])[:4]]
        items = []
        for i, name in enumerate(defaults[:8]):
            var = variables.get(name)
            if not var:
                continue
            d = dict(var)
            d["id"] = name
            d["color"] = d.get("color") or _source_color(i)
            items.append(d)
        return self._signals_with_source(items, inst)

    # ---- 查询 ----
    def get(self, source_id: str) -> Optional[SourceInstance]:
        return self.sources.get(str(source_id or ""))

    def primary(self) -> Optional[SourceInstance]:
        return self.sources.get(self.primary_id) or next(iter(self.sources.values()), None)

    def _flat_signals(self) -> List[Signal]:
        out: List[Signal] = []
        seen = set()
        for inst in self.sources.values():
            for sig in inst.signals:
                if sig.key in seen:
                    continue
                seen.add(sig.key)
                out.append(sig)
        return out

    def _fusion_rate(self) -> float:
        rates = [float(s.rate) for s in self.sources.values() if s.signals]
        if rates:
            self.fusion_rate = max(1.0, min(300.0, max(rates)))
        return self.fusion_rate

    def find_signal(self, identifier: str, source: str = "") -> Optional[Signal]:
        ident = str(identifier or "")
        if not ident:
            return None
        src = str(source or "")
        if src:
            return next((s for s in self.sources.get(src, SourceInstance("", "")).signals
                         if s.key == ident or s.id == ident), None)
        for inst in self.sources.values():
            for sig in inst.signals:
                if sig.key == ident:
                    return sig
        for inst in self.sources.values():
            for sig in inst.signals:
                if sig.id == ident:
                    return sig
        return None

    # ---- 应用信号 / 配置 ----
    def _apply_signals(self, signals: Sequence[Signal], fusion_rate: float,
                       persist: bool = True) -> None:
        self.fusion_rate = max(1.0, min(300.0, float(fusion_rate or 100.0)))
        self.app.sampler.set_signals(list(signals), self.fusion_rate)
        any_connected = any(s.connected and s.backend is not None
                            for s in self.sources.values())
        if any_connected:
            self.app.sampler.set_source(self.aggregate)
        if persist:
            self._save_workspace()
            self._save_legacy_primary()

    def _save_legacy_primary(self) -> None:
        inst = self.primary()
        if not inst:
            return
        try:
            self.app.profile = dict(inst.profile or self.app.profile or {})
            sigs = [Signal({**s.to_dict(), "source": "", "key": ""})
                    for s in inst.signals]
            self.app.save_sampler_config(sigs, self.fusion_rate)
        except Exception:
            pass

    def _save_workspace(self) -> None:
        # 单源用户仍由 profiles/<id>/sampler.json 恢复，不必生成 workspace；
        # 只有多源或已有 workspace 时才落盘，避免普通单源使用/测试写入 runtime。
        if len(self.sources) <= 1 and not os.path.isfile(self.workspace_path):
            return
        payload = {
            "schema": 2,
            "primary": self.primary_id,
            "fusion_rate": self.fusion_rate,
            "saved_at": time.time(),
            "sources": [inst.to_workspace() for inst in self.sources.values()],
        }
        try:
            os.makedirs(os.path.dirname(self.workspace_path), exist_ok=True)
            tmp = self.workspace_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                f.write("\n")
            os.replace(tmp, self.workspace_path)
        except Exception as exc:
            self.app.add_log("保存多源工作区失败: %s" % exc)

    def _sync_app_primary(self) -> None:
        inst = self.primary()
        if not inst:
            return
        self.app.profile = dict(inst.profile or {})
        self.app.catalog = inst.catalog or {}
        self.app.arch = inst.arch
        self.app.mcu = inst.mcu
        self.app.chip = inst.chip
        self.app.source = inst.backend if inst.connected else None
        src = (inst.profile or {}).get("source") or {}
        axf = profiles.host_path(str(src.get("axf") or ""))
        if axf:
            self.app.axf = axf
        self.app.header = profiles.host_path(str(src.get("header") or ""))

    def apply_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raw = payload.get("signals")
        if not isinstance(raw, list):
            raw = []
        source_cfg = payload.get("sources")
        if isinstance(source_cfg, list):
            for item in source_cfg:
                if not isinstance(item, dict):
                    continue
                sid = str(item.get("id") or "")
                if not sid or sid not in self.sources:
                    continue
                try:
                    self.sources[sid].rate = max(0.1, min(300.0, float(item.get("rate"))))
                except (TypeError, ValueError):
                    pass
        grouped: Dict[str, List[Signal]] = {sid: [] for sid in self.sources}
        flat: List[Signal] = []
        seen = set()
        for item in raw:
            if not isinstance(item, dict):
                continue
            sid = str(item.get("source") or "")
            local_id = str(item.get("id") or item.get("name") or "")
            key_raw = str(item.get("key") or "")
            if not sid and "::" in key_raw:
                sid = key_raw.split("::", 1)[0]
            if not sid:
                sid = self.primary_id or next(iter(self.sources), "")
            if sid not in self.sources:
                raise RuntimeError("未知输入源: %s" % sid)
            if not local_id and "::" in key_raw:
                local_id = key_raw.split("::", 1)[1]
            if not local_id:
                continue
            key = key_raw or (sid + "::" + local_id)
            if key in seen:
                continue
            seen.add(key)
            merged = dict(item)
            merged["id"] = local_id
            merged["source"] = sid
            merged["key"] = key
            try:
                sig = Signal(merged)
            except Exception:
                continue
            grouped[sid].append(sig)
            flat.append(sig)
        for sid, sigs in grouped.items():
            self.sources[sid].signals = sigs
        fusion = payload.get("fusion_rate") or payload.get("rate") or self._fusion_rate()
        fusion = max(1.0, min(300.0, float(fusion)))
        sig_key = (
            tuple((s.key, s.addr, s.size, s.signed, s.width, s.shift,
                   s.is_float, s.scale, s.offset, s.unit, s.color, s.step, s.axis)
                  for s in flat),
            tuple((sid, round(float(inst.rate), 3)) for sid, inst in self.sources.items()),
            round(fusion, 3),
        )
        if sig_key == getattr(self, "_last_apply_sig", None):
            return {
                "ok": True, "unchanged": True,
                "signals": [s.to_dict() for s in flat],
                "sources": [s.status() for s in self.sources.values()],
                "fusion_rate": self.fusion_rate,
            }
        self._last_apply_sig = sig_key
        self._apply_signals(flat, fusion, persist=True)
        return {
            "ok": True,
            "signals": [s.to_dict() for s in flat],
            "sources": [s.status() for s in self.sources.values()],
            "fusion_rate": self.fusion_rate,
        }

    # ---- 源 CRUD ----
    def add_source(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        label = str(payload.get("label") or payload.get("name") or "").strip()
        kind = str(payload.get("kind") or "openocd").lower()
        if kind not in SOURCE_KINDS:
            raise RuntimeError("不支持的信源类型: %s" % kind)
        base = _source_slug(payload.get("id") or label or kind, kind)
        sid = base
        n = 2
        while sid in self.sources:
            sid = "%s-%d" % (base, n)
            n += 1
        inst = SourceInstance(
            sid, label or sid, kind,
            str(payload.get("profile") or payload.get("profile_id") or ""),
            float(payload.get("rate") or self.app.args.rate or 100.0),
            payload.get("connection") if isinstance(payload.get("connection"), dict) else {},
            str(payload.get("color") or _source_color(len(self.sources))),
        )
        self._load_profile_for(inst)
        custom = payload.get("signals")
        if isinstance(custom, list) and custom:
            inst.signals = self._signals_with_source(custom, inst)
            if not inst.catalog.get("variables"):
                vars_ = []
                for item in inst.signals:
                    d = item.to_dict()
                    d.pop("source", None)
                    d.pop("key", None)
                    vars_.append(d)
                inst.catalog = {"variables": vars_, "peripherals": [],
                                "defaults": [v.get("id") for v in vars_],
                                "meta": {"mcu": "", "profile": sid}}
        elif not inst.signals:
            if kind == "sim" and not inst.catalog.get("variables"):
                p = self.primary()
                if p is not None:
                    inst.catalog = p.catalog
                    inst.arch = p.arch
                    inst.mcu = p.mcu
            inst.signals = self._default_signals(inst)
        if not inst.color:
            inst.color = _source_color(len(self.sources))
        self.sources[sid] = inst
        if not self.primary_id:
            self.primary_id = sid
        self._save_workspace()
        self.app.add_log("新增输入源: %s（%s）" % (inst.label, sid))
        return {"ok": True, "source": inst.status(),
                "sources": [s.status() for s in self.sources.values()],
                "workspace": self._workspace_summary()}

    def update_source(self, source_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        inst = self.sources.get(str(source_id or ""))
        if inst is None:
            raise RuntimeError("未知输入源: %s" % source_id)
        if payload.get("label") is not None:
            inst.label = str(payload.get("label") or inst.label)
        if payload.get("rate") is not None:
            inst.rate = max(0.1, min(300.0, float(payload["rate"])))
        if isinstance(payload.get("connection"), dict):
            inst.connection.update(payload["connection"])
        if payload.get("color"):
            inst.color = str(payload["color"])
        self._save_workspace()
        return {"ok": True, "source": inst.status(),
                "sources": [s.status() for s in self.sources.values()]}

    def remove_source(self, source_id: str) -> Dict[str, Any]:
        sid = str(source_id or "")
        inst = self.sources.get(sid)
        if inst is None:
            raise RuntimeError("未知输入源: %s" % sid)
        self.disconnect_source(sid, quiet=True)
        del self.sources[sid]
        if self.primary_id == sid:
            self.primary_id = next(iter(self.sources), "")
        self._apply_signals(self._flat_signals(), self._fusion_rate(), persist=True)
        self._sync_app_primary()
        self.app.add_log("移除输入源: %s（%s）" % (inst.label, sid))
        return {"ok": True, "sources": [s.status() for s in self.sources.values()]}

    def switch_profile(self, source_id: str, profile_id: str) -> Dict[str, Any]:
        inst = self.sources.get(str(source_id or ""))
        if inst is None:
            raise RuntimeError("未知输入源: %s" % source_id)
        meta = profiles.read_profile(str(profile_id or ""), self.app.profiles_root)
        if meta is None:
            raise RuntimeError("未知机型: %s" % (profile_id or "?"))
        self.disconnect_source(inst.id, quiet=True)
        inst.profile_id = str(profile_id)
        inst.profile = dict(meta)
        inst.arch = "riscv" if str(meta.get("arch") or "").lower() == "riscv" else "cw32"
        inst.mcu = str(meta.get("mcu") or "")
        try:
            cat = profiles.load_catalog(inst.profile_id, self.app.profiles_root)
            if cat is None:
                cat = profiles.build_catalog(meta, self.app.profiles_root)
                profiles.save_catalog(inst.profile_id, cat, self.app.profiles_root)
            inst.catalog = cat or {}
        except Exception as exc:
            inst.catalog = {}
            inst.error = "加载符号表失败: %s" % exc
        inst.signals = self._default_signals(inst)
        if inst.id == self.primary_id:
            self._sync_app_primary()
        self._apply_signals(self._flat_signals(), self._fusion_rate(), persist=True)
        return {"ok": True, "source": inst.status(),
                "sources": [s.status() for s in self.sources.values()]}

    # ---- 连接 ----
    def _disconnect_instance(self, inst: SourceInstance) -> None:
        src, inst.backend = inst.backend, None
        inst.connected = False
        inst.error = ""
        inst.next_due = 0.0
        if src is not None:
            try:
                src.close()
            except Exception as exc:
                self.app.add_log("关闭源 %s 失败: %s" % (inst.id, exc))
        # close() 期间在途 read 可能把 socket 关闭错误写进 error；断开后清掉，
        # 避免源卡片一直显示“错误: [WinError 10038]...”
        inst.error = ""
        if self.app.source is not None and self.app.source is src:
            self.app.source = None

    def connect_source(self, source_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        inst = self.sources.get(str(source_id or ""))
        if inst is None:
            raise RuntimeError("未知输入源: %s" % source_id)
        payload = dict(payload or {})
        mode = str(payload.get("mode") or inst.kind or "openocd").lower()
        # 记住每个源自己的 OpenOCD 配置覆盖，下次连接/重启后仍生效
        if mode == "openocd":
            for key in ("openocd", "iface", "target", "serial", "tcl_port"):
                if key in payload:
                    inst.connection[key] = payload.get(key) or ""
        elif mode == "attach":
            for key in ("host", "port"):
                if key in payload:
                    inst.connection[key] = payload.get(key)
        # 多个源不能同时占用同一颗 CMSIS-DAP：第二个 OpenOCD 会抢失败并报
        # WinError 10054/10038，看起来像“调试器掉线”。提前给明确提示。
        if mode == "openocd":
            arch = str(payload.get("arch") or (inst.profile or {}).get("arch")
                       or inst.arch or "").lower()
            serial = str(inst.connection.get("serial") or "").strip()
            if serial and arch not in ("riscv", "ch32", "ch32v203", "rv32"):
                for other in self.sources.values():
                    if (other.id == inst.id or not other.connected
                            or other.kind != "openocd"):
                        continue
                    used = str((other.connection or {}).get("serial") or "").strip()
                    if used and used.lower() == serial.lower():
                        raise RuntimeError(
                            "调试器 %s 已被输入源「%s」占用；同一颗探针不能同时开两个 "
                            "OpenOCD。请给该源换一个 serial，或先断开「%s」。"
                            % (serial, other.label, other.label))
        self._disconnect_instance(inst)
        inst.error = ""
        self.app.last_connect_error = ""
        if mode == "sim":
            src: Source = SimSource()
            inst.chip = None
        elif mode == "attach":
            conn = dict(inst.connection)
            conn.update(payload)
            host = str(conn.get("host") or "127.0.0.1")
            port = int(conn.get("port") or 6666)
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
                inst.error = str(exc)
                self.app.last_connect_error = str(exc)
                raise
            src = AttachedSource(client, host, port)
            src.cpuid = cpuid  # type: ignore[attr-defined]
            inst.chip = self._probe_source_chip(inst, src)
        else:
            src = self._connect_openocd(inst, payload)
            inst.chip = self._probe_source_chip(inst, src)
        inst.backend = src
        inst.connected = True
        inst.kind = mode
        inst.started_at_ms = None
        if inst.id == self.primary_id:
            self.app.source = src
        self.app.sampler.set_source(self.aggregate)
        self.app.sampler.set_signals(self._flat_signals(), self._fusion_rate())
        if not self.app.sampler.recorder.active:
            self.app._begin_recording()
        self.app.add_log("已连接输入源: %s（%s %s）" % (
            inst.label, inst.id, "仿真" if mode == "sim" else mode))
        self._save_workspace()
        return {"ok": True, "source": inst.status(), "chip": inst.chip,
                "sources": [s.status() for s in self.sources.values()]}

    def _probe_source_chip(self, inst: SourceInstance, src: Source) -> Optional[Dict[str, Any]]:
        expected = str(((inst.catalog or {}).get("meta") or {}).get("mcu") or inst.mcu or "")
        try:
            return probe_chip(src, load_mcu_index(), expected)
        except Exception as exc:
            self.app.add_log("源 %s 芯片识别失败: %s" % (inst.id, exc))
            return {"detected": "", "expected": expected, "match": None,
                    "warning": "", "error": str(exc), "evidence": {}}

    def _connect_openocd(self, inst: SourceInstance, payload: Dict[str, Any]) -> Source:
        prof = dict(inst.profile or self.app.profile or {})
        arch = str(payload.get("arch") or prof.get("arch") or inst.arch or "cw32").lower()
        inst.arch = "riscv" if arch in ("riscv", "ch32", "ch32v203", "rv32") else "cw32"
        conn = dict(inst.connection)
        conn.update(payload)
        exe = conn.get("openocd") or self.app.openocd_override
        iface = conn.get("iface") or self.app.iface_override or prof.get("interface") or ""
        target = conn.get("target") or self.app.target_override or prof.get("target") or ""
        if not target:
            target = auto_target_cfg(str(prof.get("mcu") or inst.mcu or ""))
        target = profiles.resolve_target(str(target), HERE)
        if inst.arch == "riscv":
            paths = ocd.find_wch_openocd(self.app.project, exe)
            if paths is None:
                raise RuntimeError("找不到 WCH RISC-V OpenOCD（需要 tools/openocd-wch-fast）")
            if iface:
                paths = ocd.OcdPaths(paths.exe, paths.scripts, iface, paths.target)
        else:
            paths = ocd.find_openocd(self.app.project, exe)
            if paths is None:
                raise RuntimeError("找不到可用的 OpenOCD（请把发行版放到 tools/openocd/）")
        if iface:
            if os.path.isabs(iface):
                iface_path = iface
            else:
                cand = os.path.join(paths.scripts, "interface", iface)
                iface_path = cand if os.path.isfile(cand) else iface
            paths = ocd.OcdPaths(paths.exe, paths.scripts, iface_path, target or paths.target)
        if target:
            paths = ocd.OcdPaths(paths.exe, paths.scripts, paths.iface, target)
        if not os.path.isfile(paths.exe):
            raise RuntimeError("OpenOCD 不存在: %s" % paths.exe)
        port = int(conn.get("tcl_port") or 0)
        serial = str(conn.get("serial") or "").strip() if inst.arch != "riscv" else ""
        timeout_s = float(conn.get("timeout") or 15.0)
        # 同一颗探针可能只有 v2(WinUSB) 或只有 v1(HID) 能用（H7-TOOL vs Air32），
        # serial 还可能因 Windows PNP 大写而匹配不上固件里的小写序列号。
        # 逐个候选试；只有「探针没打开/协议不通」才继续，接线/目标错误直接抛。
        ifaces = [paths.iface] + _cmsis_dap_iface_alternates(paths.iface)
        serials = _serial_case_variants(serial)
        proc = None
        client = None
        last_exc: Optional[BaseException] = None
        for iface_idx, cand_iface in enumerate(ifaces):
            for serial_idx, cand_serial in enumerate(serials):
                cand_paths = ocd.OcdPaths(paths.exe, paths.scripts, cand_iface,
                                          paths.target or "")
                cand = ocd.OcdProcess(cand_paths, port=port,
                                      verbose=self.app.args.verbose,
                                      serial=cand_serial)
                try:
                    cand_client = cand.start(timeout=timeout_s,
                                             require_cpuid=(inst.arch != "riscv"))
                except Exception as exc:
                    cand.stop()
                    last_exc = exc
                    if not _is_adapter_retryable(exc):
                        raise
                    continue
                proc, client = cand, cand_client
                if iface_idx or serial_idx:
                    self.app.add_log(
                        "CMSIS-DAP 已自动切换：%s · S/N %s"
                        % (os.path.basename(cand_iface), cand_serial or "(未指定)"))
                break
            if proc is not None:
                break
        if proc is None or client is None:
            raise last_exc or RuntimeError("无法启动 OpenOCD")
        src = OpenOcdSource(proc, client)
        src.riscv = (inst.arch == "riscv")
        scan = prof.get("scan") if isinstance(prof.get("scan"), dict) else {}
        try:
            if scan.get("max_gap"):
                src.max_gap = max(0, int(scan["max_gap"]))
            if scan.get("max_words"):
                src.max_words = max(1, int(scan["max_words"]))
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
            if inst.rate > 50:
                inst.rate = 50.0
                self.app.add_log("RISC-V 源 %s 采样率已限制为 50 Hz" % inst.id)
        try:
            if src.riscv:
                src.cpuid = client.read_regions_halt([(0xE000ED00, 1)])[0]
            else:
                src.cpuid = client.read_words(0xE000ED00, 1)[0]
        except Exception:
            src.cpuid = None
        if src.riscv:
            try:
                client.command("resume")
            except Exception:
                pass
        return src

    def disconnect_source(self, source_id: str, quiet: bool = False) -> Dict[str, Any]:
        inst = self.sources.get(str(source_id or ""))
        if inst is None:
            if quiet:
                return {"ok": False}
            raise RuntimeError("未知输入源: %s" % source_id)
        self._disconnect_instance(inst)
        if inst.id == self.primary_id:
            self.app.source = None
        any_connected = any(s.connected and s.backend is not None
                            for s in self.sources.values())
        if not any_connected:
            self.app.sampler.set_source(None)
            try:
                self.app.sampler.recorder.stop()
            except Exception:
                pass
            if self.app.record_cache is not None:
                try:
                    self.app.record_cache.finish()
                except Exception:
                    pass
        if not quiet:
            self.app.add_log("已断开输入源: %s（%s）" % (inst.label, inst.id))
        self._save_workspace()
        return {"ok": True, "source": inst.status(),
                "sources": [s.status() for s in self.sources.values()]}

    def disconnect_all(self) -> Dict[str, Any]:
        for inst in list(self.sources.values()):
            self._disconnect_instance(inst)
        self.app.source = None
        self.app.sampler.set_source(None)
        try:
            self.app.sampler.recorder.stop()
        except Exception:
            pass
        if self.app.record_cache is not None:
            try:
                self.app.record_cache.finish()
            except Exception:
                pass
        self._save_workspace()
        return {"ok": True, "sources": [s.status() for s in self.sources.values()]}

    # ---- 状态 ----
    def _workspace_summary(self) -> Dict[str, Any]:
        return {
            "schema": 2, "primary": self.primary_id,
            "fusion_rate": self.fusion_rate,
            "sources": [s.status() for s in self.sources.values()],
        }

    def status(self) -> Dict[str, Any]:
        return {
            "ok": True,
            "primary": self.primary_id,
            "fusion_rate": self.fusion_rate,
            "sources": [s.status() for s in self.sources.values()],
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
        # 波形分组 API 的 config.json 读-改-写串行化
        self.wave_groups_lock = threading.Lock()
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
        # 多源工作区：不存在时自动从当前机型 + sampler.json 迁移。
        self.manager = SourceManager(self)
        self.manager.initialize()

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

    def profile_config_payload(self, pid: str = "") -> Dict[str, Any]:
        """GET /api/profiles/config?id=<ID>：只读某机型已保存的 config.json。"""
        pid = str(pid or (self.profile or {}).get("id") or "").strip()
        if not pid:
            raise RuntimeError("未指定机型")
        meta = profiles.read_profile(pid, self.profiles_root)
        if meta is None:
            raise RuntimeError("未知机型: %s" % pid)
        saved = profiles.read_config(pid, self.profiles_root)
        cfg = saved.get("config") if isinstance(saved.get("config"), dict) else {}
        return {"ok": True, "profile": pid, "config": cfg,
                "saved_at": str(saved.get("saved_at") or "")}

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
        manager = getattr(self, "manager", None)
        was_connected = False
        if manager is not None:
            inst = manager.primary()
            if inst is None:
                raise RuntimeError("没有可切换的输入源")
            was_connected = inst.connected
            res = manager.switch_profile(inst.id, pid)
            self.catalog = inst.catalog
            self.profile = inst.profile
            self.arch = inst.arch
            self.mcu = inst.mcu
            self.signals_path = profiles.signals_path(pid, self.profiles_root)
            self.chip = inst.chip
        else:
            was_connected = self.source is not None
            self.disconnect()
            self.chip = None
            self.catalog_error = ""
            self._apply_profile_meta(meta)
            self.signals_path = profiles.signals_path(pid, self.profiles_root)
            with self.catalog_lock:
                self.catalog = data
            self.restore_sampler_for_profile()
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
            self.restore_sampler_for_profile()
        self.add_log("已重建机型符号: %s（%d 变量 / %d 外设）"
                     % (pid, res["counts"].get("variables", 0),
                        res["counts"].get("peripherals", 0)))
        return {"ok": True, "profile": profiles.summary(res["profile"], self.profiles_root),
                "profiles": self.profiles_payload(),
                "catalog": res["catalog"] if pid == (self.profile or {}).get("id") else None,
                "counts": res["counts"]}

    def create_profile(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """复制当前（或指定）机型，作为「新建机型」的快捷入口。"""
        name = str(payload.get("name") or "").strip()
        if not name:
            raise RuntimeError("请填写新机型名称")
        base = str(payload.get("base") or (self.profile or {}).get("id") or "").strip()
        if base and profiles.read_profile(base, self.profiles_root) is None:
            raise RuntimeError("源机型不存在: %s" % base)
        meta = profiles.create_profile(name, self.profiles_root, base=base)
        pid = str(meta.get("id") or "")
        try:
            res = self.switch_profile(pid)
        except Exception:
            try:
                profiles.delete_profile(pid, self.profiles_root)
            except Exception:
                pass
            raise
        res.update({"ok": True, "created": True})
        cat = res.get("catalog") or {}
        res["counts"] = {
            "variables": len(cat.get("variables") or []),
            "peripherals": len(cat.get("peripherals") or []),
        }
        self.add_log("已新建机型（复制 %s）: %s" % (base or "—", pid))
        return res

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

    # ---- 导入 / 机型 ----
    def _write_catalog_file(self, data: Dict[str, Any]) -> None:
        os.makedirs(os.path.dirname(self.signals_path) or ".", exist_ok=True)
        tmp = self.signals_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, self.signals_path)

    def _save_import_file(self, data: bytes, name: str, default: str) -> str:
        """把上传文件落到 imports/（不改原工程目录），返回宿主可读路径。"""
        os.makedirs(self.import_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S") + "_%d" % (time.time_ns() % 1000000)
        base = os.path.basename(name or default)
        base = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)[:96]
        path = os.path.join(self.import_dir, stamp + "_" + (base or default))
        with open(path, "wb") as f:
            f.write(data)
        return path

    def _parse_register_table(self, data: bytes,
                              name: str) -> Tuple[List[Dict[str, Any]], str, str]:
        """解析 .svd / .json 寄存器表，返回 (外设, 来源, 保存路径)."""
        if not data:
            raise RuntimeError("寄存器表文件为空")
        if len(data) > 32 * 1024 * 1024:
            raise RuntimeError("寄存器表文件超过 32MB")
        ext = os.path.splitext(name or "")[1].lower()
        if ext == ".svd":
            path = self._save_import_file(data, name, "table.svd")
            periphs = _svd_peripherals(path)
            source = "svd"
        elif ext == ".json":
            try:
                obj = json.loads(data.decode("utf-8-sig"))
            except Exception as exc:
                raise RuntimeError("JSON 解析失败: %s" % exc)
            periphs = obj.get("peripherals") if isinstance(obj, dict) else obj
            if not isinstance(periphs, list):
                raise RuntimeError("JSON 里没有 peripherals 数组")
            path = self._save_import_file(data, name, "table.json")
            source = "json"
        else:
            raise RuntimeError("寄存器表只支持 .svd / .json")
        if not periphs:
            raise RuntimeError("未解析到外设寄存器，请重新导入 SVD")
        return periphs, source, path

    def _apply_template_peripherals(self, data: Dict[str, Any],
                                    meta: Dict[str, Any]) -> str:
        """AXF/SVD 都没带外设时，按型号补一份内置寄存器模板。"""
        mid = find_mcu_template(str(meta.get("mcu") or ""))
        if not mid:
            return ""
        path = os.path.join(MCU_DIR, mid + ".json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                tpl = json.load(f)
        except Exception:
            return ""
        periphs = tpl.get("peripherals") if isinstance(tpl, dict) else None
        if not isinstance(periphs, list) or not periphs:
            return ""
        data["peripherals"] = periphs
        m = data.setdefault("meta", {})
        m["peripheral_count"] = len(periphs)
        m["register_table"] = mid
        m["register_source"] = "template"
        return mid

    def _catalog_warning(self, data: Dict[str, Any]) -> str:
        if data.get("peripherals"):
            return ""
        return "未解析到外设寄存器；请一起导入 SVD，或稍后单独导入寄存器表"

    def import_catalog(self, axf_bytes: Optional[bytes], axf_name: str,
                       header_bytes: Optional[bytes] = None,
                       header_name: str = "",
                       import_mode: str = "header",
                       table_bytes: Optional[bytes] = None,
                       table_name: str = "",
                       target: str = "update",
                       profile_name: str = "",
                       mcu: str = "",
                       activate: bool = True) -> Dict[str, Any]:
        """导入 AXF/ELF（可选头文件）与寄存器表，可新建机型或更新当前机型.

        target="new"    用上传的 AXF + SVD 建一个新机型并切换过去；
        target="update" 写回当前机型：AXF 重建变量，SVD/JSON 替换寄存器表，
                        并把来源写进 profile.source，重启/重建后仍然生效。
        只传寄存器表（不传 AXF）时只替换当前机型的寄存器表。
        """
        target = "new" if str(target or "").strip().lower() == "new" else "update"
        if target == "new" and not axf_bytes:
            raise RuntimeError("新建机型需要 AXF/ELF（变量与地址来源）")
        if not axf_bytes and not table_bytes:
            raise RuntimeError("请选择 AXF/ELF 或寄存器表")
        gen_signals = None
        if axf_bytes:
            if len(axf_bytes) > 32 * 1024 * 1024:
                raise RuntimeError("AXF 太大（>32MB）")
            if not axf_bytes.startswith(b"\x7fELF"):
                raise RuntimeError("不是 ELF/AXF 文件（缺少 \x7fELF 头）")
            try:
                import gen_signals  # noqa: F811  (延迟导入，只有解析 AXF 才需要)
            except Exception as exc:
                raise RuntimeError("需要 pyelftools 才能解析 AXF: %s" % exc)
        axf_path = self._save_import_file(axf_bytes, axf_name, "import.axf") if axf_bytes else ""
        header_path = self._save_import_file(header_bytes, header_name, "import.h") if header_bytes else ""
        periphs: Optional[List[Dict[str, Any]]] = None
        table_source = ""
        table_path = ""
        if table_bytes:
            periphs, table_source, table_path = self._parse_register_table(table_bytes, table_name)

        # ---------------------------------------------------------------- 新建机型
        if target == "new":
            info = gen_signals.inspect_elf(axf_path)  # type: ignore[union-attr]
            svd_path = table_path if table_source == "svd" else ""
            svd_meta = gen_signals.svd_info(svd_path) if svd_path else {}  # type: ignore[union-attr]
            mcu_name = str(mcu or "").strip() or str(svd_meta.get("name") or "").strip()
            if not mcu_name and header_path:
                mcu_name = gen_signals.infer_mcu(  # type: ignore[union-attr]
                    str(info.get("machine") or ""), header_path)
            raw_name = (os.path.splitext(os.path.basename(table_name or axf_name or ""))[0])
            raw_name = re.sub(r"^\d{8}_\d{6}(?:_\d+)?_", "", raw_name).strip()
            name = str(profile_name or "").strip() or mcu_name or raw_name or "机型"
            src = {
                "axf": axf_path,
                "header": header_path,
                "svd": svd_path,
                "map": "",
                "table": table_path if table_source == "json" else "",
            }
            seed = {
                "name": name,
                "mcu": mcu_name or name,
                "arch": str(info.get("arch") or "cw32"),
                "core": str(info.get("core") or ""),
                "ram": info.get("ram") or [],
                "target": auto_target_cfg(mcu_name or name),
                "source": src,
                "defaults": [],
                "stall": {},
                "note": "从 %s 导入" % os.path.basename(table_name or axf_name or "AXF"),
            }
            meta = profiles.create_profile(name, self.profiles_root, meta=seed)
            pid = str(meta.get("id") or "")
            try:
                data = profiles.build_catalog(meta, self.profiles_root)
                if not data.get("peripherals"):
                    self._apply_template_peripherals(data, meta)
                profiles.save_catalog(pid, data, self.profiles_root)
                meta = profiles.apply_counts(meta, data)
                meta = profiles.write_profile(meta, self.profiles_root)
            except Exception:
                # 导入失败不要把半成品机型留在列表里
                try:
                    profiles.delete_profile(pid, self.profiles_root)
                except Exception:
                    pass
                raise
            warning = self._catalog_warning(data)
            if activate:
                try:
                    res = self.switch_profile(pid)
                except Exception:
                    try:
                        profiles.delete_profile(pid, self.profiles_root)
                    except Exception:
                        pass
                    raise
            else:
                res = {
                    "ok": True,
                    "profile": profiles.summary(meta, self.profiles_root),
                    "profiles": self.profiles_payload(),
                    "catalog": data,
                    "config": {},
                    "config_saved_at": "",
                    "was_connected": False,
                }
            res.update({
                "ok": True,
                "created": True,
                "counts": {
                    "variables": len(data.get("variables") or []),
                    "peripherals": len(data.get("peripherals") or []),
                },
                "profile": profiles.summary(meta, self.profiles_root),
                "profiles": self.profiles_payload(),
                "warning": warning,
                "source": {k: os.path.basename(str(v or "")) for k, v in src.items() if v},
            })
            self.add_log("已新建机型: %s（%d 变量 / %d 外设）" % (
                pid, len(data.get("variables") or []),
                len(data.get("peripherals") or [])))
            return res

        # ---------------------------------------------------------------- 更新当前机型
        prof = dict(self.profile or {})
        if not prof:
            raise RuntimeError("当前没有激活的机型；请选择『新建机型』")
        pid = str(prof.get("id") or "")
        src = dict(prof.get("source") or {})
        base_mcu = str(prof.get("mcu") or "")
        info = gen_signals.inspect_elf(axf_path) if (axf_path and gen_signals) else {}
        new_mcu = _svd_device_name(table_path) if table_source == "svd" else ""

        if header_path:
            src["header"] = header_path
            src["svd"] = ""
            src["table"] = ""
        if table_bytes:
            if table_source == "svd":
                src["svd"] = table_path
                src["header"] = ""
                src["table"] = ""
            else:
                src["table"] = table_path
                src["header"] = ""
                src["svd"] = ""
        if axf_path:
            src["axf"] = axf_path
        prof["source"] = src

        # 换芯片时清掉旧机型的默认信号/堵转判定，避免指向不存在的变量。
        # 只有同时导入 AXF 时才动型号：只换寄存器表不应改变当前固件的变量/型号。
        if axf_path and info:
            if new_mcu and new_mcu.upper() != base_mcu.upper():
                prof["mcu"] = new_mcu
                prof["defaults"] = []
                prof["stall"] = {}
            arch = str(info.get("arch") or "")
            if arch:
                prof["arch"] = arch
                if info.get("core"):
                    prof["core"] = str(info.get("core") or "")
            if info.get("ram"):
                prof["ram"] = info["ram"]

        # 只导入寄存器表：不动变量/地址，只替换外设并记住来源
        if not axf_path:
            with self.catalog_lock:
                self.catalog["peripherals"] = periphs or []
                cm = self.catalog.setdefault("meta", {})
                cm["peripheral_count"] = len(periphs or [])
                cm["register_table"] = os.path.basename(table_name or "")
                cm["register_source"] = table_source
                self._write_catalog_file(self.catalog)
            prof = profiles.apply_counts(prof, self.catalog)
            prof = profiles.write_profile(prof, self.profiles_root)
            self.profile = prof
            self._apply_profile_meta(prof)
            warning = ""
            if new_mcu and base_mcu and new_mcu.upper() != base_mcu.upper():
                warning = ("SVD 型号 %s 与当前机型 %s 不一致；已只替换寄存器表，"
                           "变量仍来自当前 AXF。若要换芯片，请用『新建机型』。"
                           % (new_mcu, base_mcu))
                self.add_log(warning)
            self.add_log("寄存器表已导入: %s (%d 外设, 来源 %s)" % (
                os.path.basename(table_name or ""), len(periphs or []), table_source))
            return {
                "ok": True,
                "created": False,
                "catalog": self.catalog,
                "counts": {
                    "peripherals": len(self.catalog.get("peripherals") or []),
                    "variables": len(self.catalog.get("variables") or []),
                },
                "profile": profiles.summary(prof, self.profiles_root),
                "profiles": self.profiles_payload(),
                "source": table_source,
                "warning": warning,
                "mode": import_mode,
            }

        # AXF 重建变量；新 SVD/头文件/JSON 表都已写进 profile.source
        data = profiles.build_catalog(prof, self.profiles_root)
        if not data.get("peripherals"):
            tpl = self._apply_template_peripherals(data, prof)
            old = self.catalog.get("peripherals") or []
            if not tpl and old:
                data["peripherals"] = list(old)
                cm = data.setdefault("meta", {})
                cm["peripheral_count"] = len(old)
                oldm = self.catalog.get("meta") or {}
                if oldm.get("register_table"):
                    cm["register_table"] = oldm["register_table"]
                    cm["register_source"] = oldm.get("register_source", "")
        self._apply_annotations(data)
        profiles.save_catalog(pid, data, self.profiles_root)
        prof = profiles.apply_counts(prof, data)
        prof = profiles.write_profile(prof, self.profiles_root)
        self.profile = prof
        self._apply_profile_meta(prof)
        self.signals_path = profiles.signals_path(pid, self.profiles_root)
        with self.catalog_lock:
            self.catalog = data
        profiles.set_active(pid, self.profiles_root)
        warning = self._catalog_warning(data)
        if warning:
            self.add_log(warning)
        self.add_log("已导入 AXF: %s (%d 变量 / %d 外设)" % (
            os.path.basename(axf_name or "axf"),
            len(data.get("variables") or []),
            len(data.get("peripherals") or [])))
        return {
            "ok": True,
            "created": False,
            "catalog": data,
            "counts": {
                "variables": len(data.get("variables") or []),
                "peripherals": len(data.get("peripherals") or []),
            },
            "profile": profiles.summary(prof, self.profiles_root),
            "profiles": self.profiles_payload(),
            "header_used": os.path.basename(header_path) if header_path else "",
            "template_used": "",
            "mode": import_mode,
            "warning": warning,
        }

    def import_register_table(self, data: bytes, name: str) -> Dict[str, Any]:
        """兼容旧接口：只更新外设寄存器表，并把来源写回 profile。"""
        periphs, source, path = self._parse_register_table(data, name)
        with self.catalog_lock:
            self.catalog["peripherals"] = periphs
            meta = self.catalog.setdefault("meta", {})
            meta["peripheral_count"] = len(periphs)
            meta["register_table"] = os.path.basename(name or "")
            meta["register_source"] = source
            self._write_catalog_file(self.catalog)
        if self.profile:
            try:
                prof = dict(self.profile)
                src = dict(prof.get("source") or {})
                if source == "svd":
                    src["svd"] = path
                    src["header"] = ""
                    src["table"] = ""
                else:
                    src["table"] = path
                    src["header"] = ""
                    src["svd"] = ""
                prof["source"] = src
                prof = profiles.apply_counts(prof, self.catalog)
                self.profile = profiles.write_profile(prof, self.profiles_root)
                self._apply_profile_meta(self.profile)
            except Exception:
                pass
        self.add_log("寄存器表已导入: %s (%d 外设, 来源 %s)" % (
            os.path.basename(name or ""), len(periphs), source))
        return {"ok": True, "catalog": self.catalog,
                "counts": {"peripherals": len(periphs),
                           "variables": len(self.catalog.get("variables") or [])},
                "profile": self.profile_summary(),
                "profiles": self.profiles_payload(),
                "source": source}

    def catalog_source_info(self, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """查询当前/指定机型的源文件路径与存在性（更新 AXF 前先看这里）。"""
        payload = payload or {}
        pid = str(payload.get("profile") or (self.profile or {}).get("id") or "").strip()
        meta = profiles.read_profile(pid, self.profiles_root) if pid else None
        if meta is None:
            raise RuntimeError("未知机型: %s" % (pid or "?"))
        src = meta.get("source") or {}
        source: Dict[str, str] = {}
        exists: Dict[str, bool] = {}
        for key in ("axf", "header", "svd", "table", "map"):
            raw = str(src.get(key) or "")
            path = resolve_source_path(raw) if raw else ""
            source[key] = path
            exists[key] = bool(path and os.path.isfile(path))
        return {
            "ok": True,
            "profile": profiles.summary(meta, self.profiles_root),
            "source": source,
            "exists": exists,
            "counts": dict(meta.get("counts") or {}),
            "updated_at": str(meta.get("updated_at") or ""),
        }

    def update_catalog_source(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """按本机文件路径更新机型的 AXF/SVD/头文件并立即重建符号表。

        与 ``POST /api/catalog/import``（multipart 上传）互补：这个接口只收路径，
        适合构建脚本直接指向刚编译出来的 AXF，不把文件再复制一份到 imports/。
        """
        payload = dict(payload or {})
        pid = str(payload.get("profile") or (self.profile or {}).get("id") or "").strip()
        if not pid:
            raise RuntimeError("当前没有激活机型，请用 profile 指定")
        old_meta = profiles.read_profile(pid, self.profiles_root)
        if old_meta is None:
            raise RuntimeError("未知机型: %s" % pid)
        old_signal_ids = [str(s.id) for s in list(self.sampler.signals)]
        meta = dict(old_meta)
        src = dict(meta.get("source") or {})
        changed: Dict[str, str] = {}
        for key in ("axf", "header", "svd", "table", "map"):
            if key not in payload:
                continue
            raw = str(payload.get(key) or "").strip()
            if not raw:
                continue
            path = resolve_source_path(raw)
            if not os.path.isfile(path):
                raise RuntimeError("%s 文件不存在: %s" % (key, path))
            src[key] = path
            changed[key] = path
        if not changed:
            raise RuntimeError("请提供要更新的文件路径：axf / svd / header / table / map")
        # 寄存器表来源互斥：新来源覆盖旧来源
        if "svd" in changed:
            src["header"] = ""
            src["table"] = ""
        elif "header" in changed:
            src["svd"] = ""
            src["table"] = ""
        elif "table" in changed:
            src["svd"] = ""
            src["header"] = ""
        meta["source"] = src

        # 可选显式字段
        for key in ("mcu", "arch", "core", "note", "interface"):
            if key in payload and payload[key] not in (None, ""):
                meta[key] = payload[key]
        if payload.get("target_cfg"):
            meta["target"] = str(payload["target_cfg"])
        ram = payload.get("ram")
        if isinstance(ram, str):
            parts = re.split(r"[,\s]+", ram.strip())
            if len(parts) == 2:
                try:
                    ram = [int(parts[0], 0), int(parts[1], 0)]
                except ValueError:
                    ram = None
        if isinstance(ram, (list, tuple)) and len(ram) == 2:
            meta["ram"] = [int(ram[0]), int(ram[1])]

        # AXF 变了：自动跟随实际 RAM 段/架构，避免新固件变量被旧范围截掉
        if "axf" in changed:
            try:
                import gen_signals
                info = gen_signals.inspect_elf(changed["axf"])
                if "ram" not in payload and info.get("ram"):
                    meta["ram"] = info["ram"]
                if "arch" not in payload and info.get("arch"):
                    meta["arch"] = info["arch"]
                if "core" not in payload and info.get("core"):
                    meta["core"] = info["core"]
            except Exception as exc:
                self.add_log("读取 AXF 架构/RAM 失败（继续用旧值）: %s" % exc)

        # SVD 变了且没显式指定 mcu：按 SVD 顶层 <name> 更新型号
        if "svd" in changed and "mcu" not in payload:
            name = _svd_device_name(changed["svd"])
            old_mcu = str(meta.get("mcu") or "")
            if name and name.upper() != old_mcu.upper():
                meta["mcu"] = name
                meta["defaults"] = []
                meta["stall"] = {}

        meta = profiles.write_profile(meta, self.profiles_root)
        is_active = pid == str((self.profile or {}).get("id") or "")
        try:
            if is_active:
                res = self.build_profile(pid)
            else:
                res = profiles.rebuild(pid, self.profiles_root)
        except Exception:
            # 重建失败（坏 AXF/SVD）时回滚 profile.json，避免机型指向不可用文件
            try:
                profiles.write_profile(old_meta, self.profiles_root)
            except Exception:
                pass
            raise

        summary = (res["profile"] if is_active
                   else profiles.summary(res["profile"], self.profiles_root))
        profiles_payload = self.profiles_payload()
        restored_ids: List[str] = []
        if is_active and old_signal_ids:
            # 按 id 把原来的采样通道映射到新符号表；API-only 场景下更新完还能直接截图
            restored: List[Signal] = []
            for sid in old_signal_ids:
                sig = self._find_signal(sid)
                if sig is not None:
                    restored.append(sig)
            if restored:
                try:
                    self.sampler.set_signals(restored, self.sampler.rate)
                    self.save_sampler_config(self.sampler.signals, self.sampler.rate)
                    restored_ids = [str(s.id) for s in restored]
                except Exception as exc:
                    self.add_log("更新后恢复采样通道失败: %s" % exc)
        if is_active and res.get("catalog"):
            try:
                self.hub.publish({"type": "catalog", "catalog": res["catalog"],
                                  "profile": summary, "profiles": profiles_payload})
            except Exception:
                pass
        self.add_log("已更新机型源文件: %s（%d 变量 / %d 外设）" % (
            pid, res["counts"].get("variables", 0), res["counts"].get("peripherals", 0)))
        src_info = self.catalog_source_info({"profile": pid})
        return {
            "ok": True,
            "created": False,
            "profile": summary,
            "profiles": profiles_payload,
            "catalog": res.get("catalog"),
            "counts": res["counts"],
            "changed": dict(changed),
            "restored_signals": restored_ids,
            "source": src_info["source"],
            "exists": src_info["exists"],
        }

    # ---- 截图（给智能体/脚本看的 PNG） ----
    def wall_start_ms(self) -> Optional[float]:
        """t_ms 对应的墙钟起点（毫秒 epoch）；用于截图里的绝对时间。"""
        try:
            return time.time() * 1000.0 - (time.monotonic() - self.sampler.epoch) * 1000.0
        except Exception:
            return None

    def _screenshot_available(self) -> Dict[str, Any]:
        """优先用录制缓存（能覆盖整段会话），否则退到内存 history。"""
        cache_ok = bool(self.record_cache is not None and getattr(self.record_cache, "enabled", False))
        if cache_ok:
            try:
                self.record_cache.flush(timeout=0.8)
            except Exception:
                pass
            try:
                info = self.record_cache.info()
            except Exception:
                info = {}
            if (info.get("enabled") and info.get("count")
                    and info.get("signals") and info.get("start") is not None
                    and info.get("end") is not None):
                return {"source": "cache", "oldest": float(info["start"]),
                        "latest": float(info["end"]), "count": int(info["count"]),
                        "signals": list(info.get("signals") or [])}
        hist = self.sampler.history_window(None, None)
        rows = hist.get("samples") or []
        if rows:
            return {"source": "history", "oldest": float(rows[0][0]),
                    "latest": float(rows[-1][0]), "count": len(rows),
                    "signals": list(hist.get("signals") or [])}
        return {"source": "none", "oldest": None, "latest": None,
                "count": 0, "signals": list(hist.get("signals") or [])}

    def screenshot_data(self, start: Optional[float] = None,
                        end: Optional[float] = None,
                        seconds: Optional[float] = None,
                        all_time: bool = False,
                        signal_ids: Optional[List[str]] = None,
                        max_channels: int = 12,
                        max_points: int = 20000) -> Dict[str, Any]:
        """按时间窗/信号选择取出截图所需样本（t_ms 语义与 /api/history 一致）。"""
        avail = self._screenshot_available()
        if avail["oldest"] is None or avail["latest"] is None:
            raise RuntimeError("还没有采样数据；先连接并开始采样")
        earliest, latest = float(avail["oldest"]), float(avail["latest"])
        if all_time or (start is None and end is None and seconds is None):
            t0, t1 = earliest, latest
        elif seconds is not None:
            t1 = latest
            t0 = max(earliest, latest - max(0.001, float(seconds)) * 1000.0)
        else:
            t0 = earliest if start is None else float(start)
            t1 = latest if end is None else float(end)
            if t1 < t0:
                t0, t1 = t1, t0
        clamped = (t0 < earliest or t1 > latest)
        t0 = max(t0, earliest)
        t1 = min(t1, latest)
        if t1 <= t0:
            raise RuntimeError("时间范围无数据；可用范围 %.3f..%.3f ms" % (earliest, latest))

        max_points = max(1000, min(60000, int(max_points or 20000)))
        samples: List[List[Any]] = []
        signals: List[Dict[str, Any]] = list(avail.get("signals") or [])
        source = str(avail.get("source") or "history")
        if source == "cache" and self.record_cache is not None:
            try:
                win = self.record_cache.window(t0, t1, max_points)
            except Exception as exc:
                self.add_log("读录制缓存窗口失败: %s" % exc)
                win = {}
            if win.get("samples"):
                samples = list(win["samples"])
                signals = list(win.get("signals") or signals)
                source = "cache"
        if not samples:
            hist = self.sampler.history_window(t0, t1)
            samples = list(hist.get("samples") or [])
            signals = list(hist.get("signals") or signals)
            source = "history" if samples else source
        if not samples:
            raise RuntimeError("该时间范围没有样本；可用范围 %.3f..%.3f ms" % (earliest, latest))

        all_sigs = list(signals)
        ids = [str(s.get("id") or s.get("name") or "") for s in all_sigs]
        missing: List[str] = []
        if signal_ids:
            wanted = [str(x).strip() for x in signal_ids if str(x).strip()]
            idxs: List[int] = []
            for w in wanted:
                if w in ids:
                    idxs.append(ids.index(w))
                else:
                    missing.append(w)
            if not idxs:
                raise RuntimeError("指定的信号都不在采样列中；可用: %s" % ", ".join(ids[:24]))
        else:
            n = max(1, min(24, int(max_channels or 12)))
            idxs = list(range(min(len(all_sigs), n)))
        sel_signals = [all_sigs[i] for i in idxs]
        sel_samples: List[List[Any]] = []
        for row in samples:
            vals = row[1] if len(row) > 1 else []
            if not isinstance(vals, (list, tuple)):
                continue
            sel_samples.append([row[0], [vals[i] if i < len(vals) else None for i in idxs]])
        if not sel_samples:
            raise RuntimeError("该时间范围没有样本")
        return {
            "signals": sel_signals,
            "samples": sel_samples,
            "start": float(sel_samples[0][0]),
            "end": float(sel_samples[-1][0]),
            "oldest": earliest,
            "latest": latest,
            "source": source,
            "sample_count": len(sel_samples),
            "available_signals": ids,
            "missing_signals": missing,
            "truncated": bool(not signal_ids and len(all_sigs) > len(idxs)),
            "clamped": bool(clamped),
            "requested": {"start": start, "end": end, "seconds": seconds},
            "max_points": max_points,
        }

    def screenshot_info(self) -> Dict[str, Any]:
        avail = self._screenshot_available()
        oldest, latest = avail.get("oldest"), avail.get("latest")
        sigs = []
        for s in avail.get("signals") or []:
            sigs.append({
                "id": str(s.get("id") or s.get("name") or ""),
                "name": str(s.get("name") or s.get("id") or ""),
                "unit": str(s.get("unit") or ""),
                "scale": float(s.get("scale") or 1.0),
                "offset": float(s.get("offset") or 0.0),
                "step": bool(s.get("step")),
                "color": str(s.get("color") or ""),
                "axis": str(s.get("axis") or ""),
            })
        return {
            "ok": True,
            "available": bool(sigs and oldest is not None),
            "source": avail.get("source"),
            "oldest": oldest,
            "latest": latest,
            "duration_ms": (float(latest) - float(oldest))
                           if (oldest is not None and latest is not None) else None,
            "sample_count": int(avail.get("count") or 0),
            "sample_rate": float(self.sampler.rate or 0.0),
            "signals": sigs,
            "profile": self.profile_summary(),
            "defaults": {"width": 1200, "theme": "dark", "max_channels": 12},
            "render": {
                "style": "web-panes",
                "time_axes": ["bottom-abs", "left-rel-0"],
                "grid": {"x_major": 10, "x_minor": 5, "y_minor": 4},
            },
            "examples": [
                "/api/screenshot?all=1",
                "/api/screenshot?seconds=10",
                "/api/screenshot?start=1000&end=5000&signals=motor.over.current",
                "/api/screenshot?format=json&all=1",
            ],
        }

    def reset_recording(self) -> Dict[str, Any]:
        self.sampler.recorder.reset()
        self.add_log("录制已手动重置")
        return {"ok": True, "record": self.sampler.recorder.info()}

    def _sampler_state_path(self, pid: str) -> str:
        return os.path.join(os.path.dirname(profiles.config_path(pid, self.profiles_root)),
                            "sampler.json")

    def save_sampler_config(self, signals: Sequence[Signal], rate: float) -> None:
        """把服务端当前采样集落盘，重启/无浏览器时继续按同一组通道采样。

        浏览器只是控制器；真正决定“记录哪些通道”的是这里保存的 sampler.json。
        """
        pid = str((self.profile or {}).get("id") or "")
        if not pid:
            return
        path = self._sampler_state_path(pid)
        payload = {
            "saved_at": time.time(),
            "rate": float(rate or 0),
            "signals": [s.to_dict() for s in signals],
        }
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
                f.write("\n")
            os.replace(tmp, path)
        except Exception as exc:
            self.add_log("保存采样集失败: %s" % exc)

    def _signals_from_saved(self, items: Sequence[Any]) -> List[Signal]:
        """把保存的 signal dict 还原成 Signal；变量按当前符号表 id 重新取地址。

        固件重编译后地址会变，但 id 不变；寄存器/位域直接用保存的地址。
        """
        variables = {
            str(v.get("name") or v.get("id") or ""): v
            for v in self.catalog.get("variables", []) or []
            if v.get("name") or v.get("id")
        }
        out: List[Signal] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            try:
                sig = Signal(item)
            except Exception:
                continue
            if not sig.id:
                continue
            cur = variables.get(sig.id)
            if cur:
                merged = dict(cur)
                merged.update({
                    "id": sig.id, "name": sig.name,
                    "scale": sig.scale, "offset": sig.offset,
                    "unit": sig.unit, "color": sig.color,
                    "step": sig.step, "axis": sig.axis,
                })
                try:
                    sig = Signal(merged)
                except Exception:
                    pass
            out.append(sig)
        return out

    def saved_sampler_config(self) -> Optional[Dict[str, Any]]:
        """读取服务端采样集：sampler.json 优先，其次浏览器保存的 config.rows。"""
        pid = str((self.profile or {}).get("id") or "")
        if not pid:
            return None
        path = self._sampler_state_path(pid)
        had_sampler = os.path.isfile(path)
        sampler_rate = float(self.args.rate or 100.0)
        if had_sampler:
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    data = json.load(f)
            except Exception:
                data = None
            if isinstance(data, dict) and isinstance(data.get("signals"), list):
                sampler_rate = float(data.get("rate") or sampler_rate)
                sigs = self._signals_from_saved(data.get("signals") or [])
                if sigs:
                    return {"signals": sigs, "rate": sampler_rate}
                # 空 sampler.json 不直接吞掉：继续看浏览器保存的 config.rows，
                # 避免一次空保存把已有通道全部“吃掉”；两者都空则保留空。
        # 兼容：浏览器把“表/波/支撑”行写在 profiles/<id>/config.json
        try:
            saved = profiles.read_config(pid, self.profiles_root)
        except Exception:
            saved = {}
        cfg = saved.get("config") if isinstance(saved, dict) else None
        if not isinstance(cfg, dict):
            cfg = {}
        rows = cfg.get("rows") or []
        if not isinstance(rows, list) or not rows:
            return {"signals": [], "rate": sampler_rate} if had_sampler else None
        source_ids = set()
        for v in cfg.get("virtuals") or []:
            for sid in (v.get("sourceIds") or []) if isinstance(v, dict) else []:
                source_ids.add(str(sid))
        picked = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            sid = str(row.get("id") or row.get("name") or "")
            if not sid or not int(row.get("addr") or 0):
                continue
            if not (row.get("table") or row.get("plot") or row.get("support") or
                    str(row.get("configRole") or "") == "support" or sid in source_ids):
                continue
            picked.append(row)
        if not picked:
            return {"signals": [], "rate": sampler_rate} if had_sampler else None
        return {
            "signals": self._signals_from_saved(picked),
            "rate": float(cfg.get("rate") or sampler_rate),
        }

    def restore_sampler_for_profile(self) -> None:
        """按当前机型恢复 primary 源的采样集，不覆盖其它源。"""
        manager = getattr(self, "manager", None)
        if manager is not None:
            try:
                inst = manager.primary()
                if inst is None:
                    return
                inst.profile = dict(self.profile or {})
                inst.catalog = self.catalog or {}
                inst.arch = self.arch
                inst.mcu = self.mcu
                cfg = self.saved_sampler_config() or self.default_config()
                raw = [x.to_dict() if isinstance(x, Signal) else x
                       for x in (cfg.get("signals") or [])]
                inst.signals = manager._signals_with_source(raw, inst)
                manager._apply_signals(manager._flat_signals(),
                                       manager._fusion_rate(), persist=True)
                manager._sync_app_primary()
                return
            except Exception as exc:
                self.add_log("恢复 primary 采样集失败: %s" % exc)
                return
        try:
            cfg = self.saved_sampler_config() or self.default_config()
            sigs = cfg["signals"]
            if sigs and not isinstance(sigs[0], Signal):
                sigs = [Signal(x) for x in sigs]
            self.sampler.set_signals(sigs, cfg["rate"])
            self.save_sampler_config(self.sampler.signals, self.sampler.rate)
        except Exception as exc:
            self.add_log("恢复采样集失败: %s" % exc)

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
        manager = getattr(self, "manager", None)
        if manager is not None:
            sig = manager.find_signal(sid)
            if sig is not None:
                return sig
        try:
            for s in list(self.sampler.signals):
                if str(s.key) == sid or str(s.id) == sid:
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
        """只读配置：扁平 signals + 每源状态，兼容旧 signals/rate。"""
        with self.sampler._lock:
            sigs = [s.to_dict() for s in self.sampler.signals]
            rate = self.sampler.rate
            generation = self.sampler.generation
        manager = getattr(self, "manager", None)
        return {
            "ok": True,
            "signals": sigs,
            "rate": rate,
            "generation": generation,
            "signal_flags": self.signal_flags_snapshot(),
            "fusion_rate": rate,
            "primary": manager.primary_id if manager else "",
            "sources": ([s.status() for s in manager.sources.values()]
                        if manager else []),
        }

    # ---- 波形分组（API） -------------------------------------------
    def _wave_groups_state(self) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
        pid = str((self.profile or {}).get("id") or "")
        if not pid:
            raise RuntimeError("当前没有激活的机型")
        saved = profiles.read_config(pid, self.profiles_root)
        cfg = saved.get("config") if isinstance(saved.get("config"), dict) else {}
        return pid, copy.deepcopy(cfg), saved

    def wave_groups_payload(self) -> Dict[str, Any]:
        """GET /api/wave/groups：分组 + 已选择波形（plot/table 行）。"""
        with self.wave_groups_lock:
            pid, cfg, saved = self._wave_groups_state()
            out = wave_groups.snapshot(cfg)
            out.update({"ok": True, "profile": pid,
                        "saved_at": str(saved.get("saved_at") or "")})
            return out

    def _wave_groups_apply(self, action, payload: Dict[str, Any]) -> Dict[str, Any]:
        """读 config -> 改分组 -> 存回 config.json -> SSE 通知所有页面。"""
        with self.wave_groups_lock:
            pid, cfg, _saved = self._wave_groups_state()
            result = action(cfg, payload if isinstance(payload, dict) else {})
            saved = profiles.save_config(pid, cfg, self.profiles_root)
            rows: Dict[str, str] = {}
            colors: Dict[str, str] = {}
            for row in cfg.get("rows") or []:
                if not isinstance(row, dict):
                    continue
                rid = str(row.get("id") or "")
                if not rid:
                    continue
                rows[rid] = str(row.get("groupId") or wave_groups.DEFAULT_ID)
                if row.get("color"):
                    colors[rid] = str(row["color"])
            self.hub.publish({
                "type": "wave_groups",
                "profile": pid,
                "groups": result.get("groups") or [],
                "rows": rows,
                "colors": colors,
                "saved_at": saved.get("saved_at"),
            })
            result.update({"ok": True, "profile": pid,
                           "saved_at": saved.get("saved_at")})
            return result

    def wave_group_create(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._wave_groups_apply(wave_groups.create, payload)

    def wave_group_rename(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._wave_groups_apply(wave_groups.rename, payload)

    def wave_group_add(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._wave_groups_apply(wave_groups.add, payload)

    def wave_group_delete(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._wave_groups_apply(wave_groups.delete, payload)

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
                            "source": sig.source,
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

    def annotate_probes(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """给 USB 探针列表补上 used_by/in_use：哪颗探针正被哪个输入源占用。"""
        if not isinstance(data, dict):
            return data
        manager = getattr(self, "manager", None)
        if manager is None:
            return data
        by_serial: Dict[str, List[str]] = {}
        for src in manager.sources.values():
            if not src.connected or src.kind != "openocd":
                continue
            serial = str((src.connection or {}).get("serial") or "").strip().lower()
            if serial:
                by_serial.setdefault(serial, []).append(str(src.id))
        for bucket in ("supported", "others"):
            for item in data.get(bucket) or []:
                if not isinstance(item, dict):
                    continue
                users = by_serial.get(str(item.get("serial") or "").strip().lower(), [])
                item["used_by"] = list(users)
                item["in_use"] = bool(users)
        return data

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
                       "signal_flags": self.signal_flags_snapshot(),
                       "primary": (self.manager.primary_id if getattr(self, "manager", None) else ""),
                       "sources": ([s.status() for s in self.manager.sources.values()]
                                   if getattr(self, "manager", None) else [])},
            "sources": ([s.status() for s in self.manager.sources.values()]
                        if getattr(self, "manager", None) else []),
            "primary": (self.manager.primary_id if getattr(self, "manager", None) else ""),
            "fusion_rate": self.sampler.rate,
            # t_ms 是相对 sampler.epoch 的毫秒；加这个可还原墙钟时间
            "wall_start_ms": self.wall_start_ms(),
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

    def openocd_configs(self, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """列出可选 interface/target cfg，供前端按源选择 OpenOCD 配置。"""
        payload = dict(payload or {})
        root = str(payload.get("openocd") or payload.get("root") or "").strip()
        arch = str(payload.get("arch") or self.arch or "cw32").lower()
        paths = None
        if arch in ("riscv", "ch32", "ch32v203", "rv32"):
            paths = ocd.find_wch_openocd(self.project, root or self.openocd_override)
        if paths is None:
            paths = ocd.find_openocd(self.project, root or self.openocd_override)
        if paths is None:
            return {"ok": False, "error": "找不到 OpenOCD；请填写 OpenOCD 根目录",
                    "roots": [], "interfaces": [], "targets": []}

        def list_cfg(folder: str) -> List[Dict[str, str]]:
            out: List[Dict[str, str]] = []
            if folder and os.path.isdir(folder):
                for name in sorted(os.listdir(folder)):
                    if not name.lower().endswith(".cfg"):
                        continue
                    out.append({"name": name, "path": os.path.abspath(os.path.join(folder, name))})
            return out

        scripts = paths.scripts or ""
        iface_dirs = [os.path.join(scripts, "interface"),
                      os.path.join(scripts, "interfaces")]
        target_dirs = [os.path.join(scripts, "target")]
        for base in (self.project, os.path.dirname(self.project), HERE):
            iface_dirs.append(os.path.join(base, "tools", "openocd-cfg", "interface"))
            iface_dirs.append(os.path.join(base, "tools", "openocd-cfg", "interfaces"))
            target_dirs.append(os.path.join(base, "tools", "openocd-cfg", "target"))
            target_dirs.append(os.path.join(base, "profiles", "targets"))
        interfaces: List[Dict[str, str]] = []
        seen_i = set()
        for folder in iface_dirs:
            for item in list_cfg(folder):
                key = os.path.basename(item["path"]).lower()
                if key in seen_i:
                    continue
                seen_i.add(key)
                interfaces.append(item)
        targets: List[Dict[str, str]] = []
        seen_t = set()
        for folder in target_dirs:
            for item in list_cfg(folder):
                key = os.path.basename(item["path"]).lower()
                if key in seen_t:
                    continue
                seen_t.add(key)
                targets.append(item)
        # 默认/当前配置也要出现在列表里（可能是 bin/*.cfg）
        for path, bucket, seen in ((paths.iface, interfaces, seen_i),
                                   (paths.target, targets, seen_t)):
            if path and os.path.isfile(path):
                name = os.path.basename(path)
                if name.lower() not in seen:
                    bucket.insert(0, {"name": name, "path": os.path.abspath(path)})
                    seen.add(name.lower())
        return {
            "ok": True, "exe": paths.exe, "scripts": scripts,
            "default_iface": os.path.abspath(paths.iface) if paths.iface else "",
            "default_target": os.path.abspath(paths.target) if paths.target else "",
            "interfaces": interfaces, "targets": targets,
        }

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

    def scan_chip_id(self, payload: Optional[Dict[str, Any]] = None,
                     auto_connect: bool = False) -> Dict[str, Any]:
        """扫描目标芯片 ID（识别型号），可选自动连接/扫描后断开。

        * 已连接：直接读 CPUID/签名区，返回 chip 详情，不改变连接状态；
        * 未连接且 auto_connect=true：用 payload 里的连接参数（或当前机型）
          临时连接 → 扫描 → 默认断开；``keep_connected=true`` 可保留连接。
        """
        payload = dict(payload or {})
        was_connected = self.source is not None
        auto = False
        auto_sid = ""
        if not was_connected and auto_connect:
            keys = ("mode", "iface", "serial", "openocd", "arch", "target",
                    "host", "port", "tcl_port", "timeout")
            conn_payload = {k: payload[k] for k in keys if k in payload}
            conn_payload.setdefault("mode", "openocd")
            try:
                _conn_res = self.connect(conn_payload)
                auto_sid = str(((_conn_res or {}).get("source") or {}).get("id") or "")
            except Exception as exc:
                return {
                    "ok": False, "connected": False, "autoconnect": True,
                    "error": "自动连接失败: %s" % exc,
                    "profile": self.profile_summary(),
                }
            auto = True
            if self.source is None:
                return {
                    "ok": False, "connected": False, "autoconnect": True,
                    "error": "自动连接后信号源仍不可用",
                    "profile": self.profile_summary(),
                }
        if self.source is None:
            return {
                "ok": False, "connected": False, "autoconnect": auto,
                "error": "未连接",
                "hint": "先 POST /api/control/connect；或 POST /api/scan/id 带 connect:true 自动连接",
                "profile": self.profile_summary(),
            }
        chip = None
        error = ""
        try:
            chip = self._probe_chip()
        except Exception as exc:
            error = str(exc)
        finally:
            if auto and not bool(payload.get("keep_connected")):
                if auto_sid and getattr(self, "manager", None) is not None:
                    self.manager.disconnect_source(auto_sid, quiet=True)
                else:
                    self.disconnect()
        if error:
            return {
                "ok": False, "connected": self.source is not None,
                "autoconnect": auto, "error": error,
                "profile": self.profile_summary(),
            }
        return {
            "ok": True,
            "connected": self.source is not None,
            "autoconnect": auto,
            "kept_connected": bool(auto and self.source is not None),
            "was_connected": was_connected,
            "chip": chip,
            "profile": self.profile_summary(),
        }

    # ---- 连接 ----
    def disconnect(self) -> None:
        if getattr(self, "manager", None) is not None:
            self.manager.disconnect_all()
            return
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
        payload = dict(payload or {})
        manager = getattr(self, "manager", None)
        if manager is None:
            raise RuntimeError("多源管理器未初始化")
        sid = str(payload.get("source") or payload.get("id") or manager.primary_id or "")
        if not sid:
            raise RuntimeError("没有可连接的输入源")
        return manager.connect_source(sid, payload)

    def auto_connect(self) -> None:
        try:
            self.connect({"mode": "openocd", "timeout": 15})
        except Exception as exc:
            self.add_log("自动连接失败: %s" % exc)

    # ---- 配置 ----
    def apply_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        manager = getattr(self, "manager", None)
        if manager is None:
            raise RuntimeError("多源管理器未初始化")
        res = manager.apply_config(payload)
        if res.get("unchanged"):
            return res
        if self.sampler.recorder.active:
            try:
                self.sampler.recorder.set_signals(self.sampler.signals)
            except Exception:
                pass
        self.add_log("采样配置: %d 路, %.0f Hz（%d 源）" % (
            len(res.get("signals") or []), res.get("fusion_rate") or 0,
            len(res.get("sources") or [])))
        return res

    def read_value(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """一次性读取任意地址/位域（“读”按钮用），不加入采样。"""
        sid = str(payload.get("source") or "")
        src = None
        manager = getattr(self, "manager", None)
        if sid and manager is not None:
            inst = manager.get(sid)
            if inst is not None and inst.backend is not None:
                src = inst.backend
            elif sid == manager.primary_id and self.source is not None:
                src = self.source
        else:
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
        is_float = bool(payload.get("float")) or (
            str(payload.get("type") or "").strip().lower() in ("float", "float32", "_float"))
        if is_float:
            if size != 4:
                raise RuntimeError("浮点读取只支持 4 字节 float32")
            if isinstance(bit, (list, tuple)) and len(bit) >= 2:
                raise RuntimeError("浮点变量不支持位域读取")
            if addr % 4:
                raise RuntimeError("浮点变量地址必须 4 字节对齐")
            try:
                word = int(src.read_word(addr)) & 0xFFFFFFFF
            except Exception as exc:
                raise RuntimeError("读取 0x%08x 失败: %s" % (addr, exc))
            value = struct.unpack("<f", struct.pack("<I", word))[0]
            if not math.isfinite(value):
                value = None
            return {"ok": True, "addr": addr, "size": size, "value": value,
                    "word": word, "float": True}
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
        sid = str(payload.get("source") or "")
        src = None
        manager = getattr(self, "manager", None)
        if sid and manager is not None:
            inst = manager.get(sid)
            if inst is not None and inst.backend is not None:
                src = inst.backend
            elif sid == manager.primary_id and self.source is not None:
                src = self.source
        else:
            src = self.source
        if src is None:
            raise RuntimeError("未连接，不能写入")
        if payload.get("float") or (
                str(payload.get("type") or "").strip().lower() in ("float", "float32", "_float")):
            raise RuntimeError("浮点变量暂不支持写入（只支持显示/导出，避免按整数位写坏 float32）")
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

    def _screenshot(self) -> None:
        qs = parse_qs(urlparse(self.path).query)

        def one(name: str, default: str = "") -> str:
            vals = qs.get(name) or []
            return vals[0] if vals else default

        def num(name: str) -> Optional[float]:
            try:
                return float(one(name))
            except (TypeError, ValueError):
                return None

        def intq(name: str, default: int) -> int:
            try:
                return int(float(one(name, str(default))))
            except (TypeError, ValueError):
                return default

        def flag(name: str, default: bool = False) -> bool:
            val = one(name, "").lower()
            if val in ("1", "true", "yes", "on"):
                return True
            if val in ("0", "false", "no", "off"):
                return False
            return default

        signal_ids: List[str] = []
        for key in ("signals", "sig"):
            for raw in qs.get(key) or []:
                signal_ids += [x.strip() for x in raw.split(",") if x.strip()]
        width = intq("width", 1200)
        height = intq("height", 0) or None
        max_channels = max(1, min(24, intq("max", 12)))
        max_points = intq("max_points", 20000)
        theme = one("theme", "dark").lower()
        title = one("title", "")[:80]
        fmt = one("format", "png").lower()
        try:
            data = self.app.screenshot_data(
                start=num("start"), end=num("end"), seconds=num("seconds"),
                all_time=flag("all", False),
                signal_ids=signal_ids or None,
                max_channels=max_channels, max_points=max_points,
            )
        except Exception as exc:
            payload: Dict[str, Any] = {"ok": False, "error": str(exc)}
            try:
                payload["info"] = self.app.screenshot_info()
            except Exception:
                pass
            return self._json(payload, 400)
        prof = self.app.profile_summary() or {}
        try:
            shot = screenshot.render(
                data["signals"], data["samples"],
                width=width, height=height, theme=theme, title=title,
                profile=str(prof.get("id") or ""), mcu=str(prof.get("mcu") or ""),
                wall_start_ms=self.app.wall_start_ms(),
                max_channels=len(data["signals"]),
                sample_rate=float(self.app.sampler.rate or 0.0),
                generated_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            )
        except Exception as exc:
            return self._json({"ok": False, "error": "渲染失败: %s" % exc}, 500)

        meta: Dict[str, Any] = {k: v for k, v in shot.items() if k != "png"}
        meta.update({
            "ok": True,
            "source": data["source"],
            "requested": data["requested"],
            "available": {"oldest": data["oldest"], "latest": data["latest"]},
            "available_signals": data["available_signals"],
            "missing_signals": data["missing_signals"],
            "truncated": data["truncated"],
            "clamped": data["clamped"],
        })
        if fmt in ("json", "meta"):
            meta["mime"] = "image/png"
            meta["image_base64"] = base64.b64encode(shot["png"]).decode("ascii")
            return self._json(meta)

        sigs = ",".join(str(s.get("id") or "") for s in data["signals"])
        sigs = sigs.encode("ascii", "replace").decode("ascii")
        extra = {
            "Content-Disposition": 'inline; filename="motorscope-%s.png"'
                                   % time.strftime("%Y%m%d-%H%M%S"),
            "X-MotorScope-Source": str(data["source"]),
            "X-MotorScope-Samples": str(shot["sample_count"]),
            "X-MotorScope-Start-Ms": "%.3f" % shot["range"]["start_ms"],
            "X-MotorScope-End-Ms": "%.3f" % shot["range"]["end_ms"],
            "X-MotorScope-Signals": sigs[:1000],
        }
        return self._bytes(shot["png"], "image/png", extra=extra)

    def _screenshot_info(self) -> None:
        return self._json(self.app.screenshot_info())

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

        def field(name: str, default: str = "") -> str:
            item = files.get(name)
            if not item or not item[1]:
                return default
            return item[1].decode("utf-8", "replace").strip()

        axf = files.get("axf")
        table = files.get("table") or files.get("svd")
        header = files.get("header")
        if not (axf and axf[1]) and not (table and table[1]):
            return self._json({"ok": False, "error": "请选择 AXF/ELF 或寄存器表"}, 400)
        target = field("target", "update").lower()
        if target not in ("new", "update"):
            target = "update"
        mode = field("expect", "header")
        if mode not in ("vars", "header"):
            mode = "header"
        try:
            res = self.app.import_catalog(
                axf[1] if axf and axf[1] else None,
                axf[0] if axf else "",
                header[1] if header and header[1] else None,
                header[0] if header else "",
                import_mode=mode,
                table_bytes=table[1] if table and table[1] else None,
                table_name=table[0] if table else "",
                target=target,
                profile_name=field("name"),
                mcu=field("mcu"),
            )
            return self._json(res)
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)

    def _import_source(self) -> None:
        """新建一个输入源：AXF (+SVD/JSON) 非激活导入 profile，再绑定成源。"""
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._json({"ok": False, "error": "需要 multipart/form-data"}, 400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 64 * 1024 * 1024:
            return self._json({"ok": False, "error": "文件为空或超过 64MB"}, 400)
        files = parse_multipart(self.rfile.read(length), ctype)

        def field(name: str, default: str = "") -> str:
            item = files.get(name)
            if not item or not item[1]:
                return default
            return item[1].decode("utf-8", "replace").strip()

        axf = files.get("axf")
        table = files.get("table") or files.get("svd")
        if not axf or not axf[1]:
            return self._json({"ok": False, "error": "新增信号源需要 AXF/ELF"}, 400)
        name = field("name")[:64]
        mcu = field("mcu")[:64]
        kind = field("kind", "openocd").lower()
        if kind not in SOURCE_KINDS:
            kind = "openocd"
        try:
            rate = max(0.1, min(300.0, float(field("rate", "100") or 100)))
        except (TypeError, ValueError):
            rate = 100.0
        try:
            res = self.app.import_catalog(
                axf[1], axf[0],
                table_bytes=table[1] if table and table[1] else None,
                table_name=table[0] if table else "",
                target="new",
                profile_name=name,
                mcu=mcu,
                activate=False,
            )
            prof = res.get("profile") or {}
            pid = str(prof.get("id") or "")
            if not pid:
                raise RuntimeError("导入 profile 失败")
            conn = {}
            if kind == "attach":
                conn = {"host": field("host", "127.0.0.1") or "127.0.0.1",
                        "port": int(field("port", "6666") or 6666)}
            elif kind == "openocd":
                for key in ("serial", "openocd", "target", "iface", "tcl_port"):
                    val = field(key)
                    if val:
                        conn[key] = val
                conn["arch"] = str(prof.get("arch") or "cw32")
            added = self.app.manager.add_source({
                "label": name or str(prof.get("name") or pid),
                "kind": kind, "profile": pid, "rate": rate, "connection": conn,
            })
            out = dict(res)
            out.update({
                "ok": True,
                "source": added.get("source"),
                "sources": added.get("sources"),
            })
            return self._json(out)
        except Exception as exc:
            return self._json({"ok": False, "error": "新增信号源失败: %s" % exc}, 500)

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
            if path == "/api/openocd/configs":
                qs = parse_qs(urlparse(self.path).query)
                return self._json(self.app.openocd_configs({
                    "openocd": (qs.get("root") or [""])[0],
                    "arch": (qs.get("arch") or [""])[0],
                }))
            if path == "/api/sources":
                manager = getattr(self.app, "manager", None)
                return self._json(manager.status() if manager else {"ok": False, "sources": []})
            if path.startswith("/api/sources/"):
                parts = path.strip("/").split("/")
                if len(parts) >= 3:
                    inst = self.app.manager.get(parts[2]) if getattr(self.app, "manager", None) else None
                    if inst is None:
                        return self._json({"ok": False, "error": "未知输入源"}, 404)
                    if len(parts) == 4 and parts[3] == "catalog":
                        return self._json(inst.catalog or {})
                    if len(parts) == 3:
                        return self._json({"ok": True, "source": inst.status()})
            if path in ("/api/screenshot/info", "/api/shot/info"):
                return self._screenshot_info()
            if path in ("/api/screenshot", "/api/screenshot.png", "/api/shot"):
                return self._screenshot()
            if path in ("/api/usb-devices", "/api/scan/debuggers"):
                # 枚举当前连接的 USB 设备，标注 MotorScope 支持的调试探针。
                # 纯枚举，不打开/占用任何设备；?all=1 附带返回未识别的设备。
                qs = parse_qs(urlparse(self.path).query)
                include_all = (qs.get("all") or [""])[0].lower() in ("1", "true", "yes")
                try:
                    return self._json(self.app.annotate_probes(
                        usb_devices.enumerate_devices(include_all=include_all)))
                except Exception as exc:  # 枚举失败也不能让整个接口 500 掉 UI
                    return self._json({"ok": False, "available": False,
                                       "count": 0, "supported": [],
                                       "error": str(exc)})
            if path in ("/api/hid-devices", "/api/scan/hid"):
                # HID 列表：H7-TOOL/CMSIS-DAP v1 等 HID 调试接口也在这里。
                try:
                    return self._json(usb_devices.enumerate_hid())
                except Exception as exc:
                    return self._json({"ok": False, "available": False,
                                       "count": 0, "devices": [],
                                       "error": str(exc)})
            if path == "/api/scan/id":
                # 只读扫描：已连接时读芯片 ID；未连接返回 ok:false，不自动连接。
                return self._json(self.app.scan_chip_id({}, auto_connect=False))
            if path == "/api/catalog":
                qs = parse_qs(urlparse(self.path).query)
                sid = (qs.get("source") or [""])[0]
                if sid:
                    inst = self.app.manager.get(sid) if getattr(self.app, "manager", None) else None
                    if inst is None:
                        return self._json({"ok": False, "error": "未知输入源"}, 404)
                    return self._json(inst.catalog or {})
                return self._json(self.app.catalog)
            if path == "/api/catalog/source":
                # 查询机型源文件路径/存在性；?profile=<ID> 可查非当前机型
                qs = parse_qs(urlparse(self.path).query)
                return self._json(self.app.catalog_source_info({
                    "profile": (qs.get("profile") or [""])[0],
                }))
            if path == "/api/profiles":
                return self._json(self.app.profiles_payload())
            if path == "/api/profiles/config":
                qs = parse_qs(urlparse(self.path).query)
                try:
                    return self._json(self.app.profile_config_payload(
                        (qs.get("id") or [""])[0]))
                except (RuntimeError, ValueError) as exc:
                    return self._json({"ok": False, "error": str(exc)}, 400)
            if path == "/api/reginfo":
                qs = parse_qs(urlparse(self.path).query)
                model = (qs.get("model") or [""])[0]
                return self._json(self.app.load_reginfo(model))
            if path == "/api/config":
                return self._json(self.app.config_payload())
            if path == "/api/wave/groups":
                # 波形分组：分组列表 + 当前已选择波形（plot/table）及其 groupId/颜色。
                try:
                    return self._json(self.app.wave_groups_payload())
                except (RuntimeError, ValueError) as exc:
                    return self._json({"ok": False, "error": str(exc)}, 400)
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
                    "run_id": self.app.sampler.epoch,
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

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/sources/"):
                parts = path.strip("/").split("/")
                if len(parts) == 3:
                    return self._json(self.app.manager.remove_source(parts[2]))
            return self._json({"ok": False, "error": "unknown api"}, 404)
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        payload = {} if path in ("/api/catalog/import", "/api/catalog/registers",
                                 "/api/sources/import") else self._read_json()
        try:
            if path == "/api/catalog/import":
                return self._import_catalog()
            if path == "/api/catalog/registers":
                return self._import_registers()
            if path == "/api/record/reset":
                return self._json(self.app.reset_recording())
            if path == "/api/sources/import":
                return self._import_source()
            if path == "/api/sources":
                return self._json(self.app.manager.add_source(payload))
            if path.startswith("/api/sources/"):
                parts = path.strip("/").split("/")
                if len(parts) >= 3:
                    sid = parts[2]
                    action = parts[3] if len(parts) >= 4 else ""
                    if not action:
                        return self._json(self.app.manager.update_source(sid, payload))
                    if action == "connect":
                        return self._json(self.app.manager.connect_source(sid, payload))
                    if action == "disconnect":
                        return self._json(self.app.manager.disconnect_source(sid))
                    if action == "config":
                        payload = dict(payload or {})
                        payload.setdefault("sources", [{"id": sid, "rate": payload.get("rate")}])
                        payload["signals"] = payload.get("signals") or []
                        for item in payload["signals"]:
                            if isinstance(item, dict):
                                item.setdefault("source", sid)
                        return self._json(self.app.apply_config(payload))
                    if action == "profile":
                        return self._json(self.app.manager.switch_profile(
                            sid, payload.get("profile") or payload.get("id") or ""))
                    return self._json({"ok": False, "error": "unknown source action"}, 404)
            if path in ("/api/connect", "/api/control/connect"):
                return self._json(self.app.connect(payload))
            if path in ("/api/disconnect", "/api/control/disconnect"):
                self.app.disconnect()
                return self._json({"ok": True, "status": self.app.status_payload()})
            if path == "/api/scan/id":
                # POST 是动作：默认允许临时连接后再扫描（扫描完默认断开）。
                return self._json(self.app.scan_chip_id(
                    payload, auto_connect=bool(payload.get("connect", True))))
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
            if path.startswith("/api/wave/groups"):
                handlers = {
                    "/api/wave/groups": self.app.wave_group_create,
                    "/api/wave/groups/create": self.app.wave_group_create,
                    "/api/wave/groups/rename": self.app.wave_group_rename,
                    "/api/wave/groups/add": self.app.wave_group_add,
                    "/api/wave/groups/delete": self.app.wave_group_delete,
                }
                fn = handlers.get(path)
                if fn is None:
                    return self._json({"ok": False, "error": "unknown wave group action"}, 404)
                try:
                    return self._json(fn(payload))
                except (RuntimeError, ValueError) as exc:
                    return self._json({"ok": False, "error": str(exc)}, 400)
            if path == "/api/config":
                res = self.app.apply_config(payload)
                if res.get("unchanged"):
                    return self._json(res)
                sigs = res.get("signals") or []
                roles = {}
                for x in payload.get("signals") or []:
                    if isinstance(x, dict):
                        roles[str(x.get("key") or x.get("id") or "")] = str(x.get("role") or "signal")
                for s in sigs:
                    s["role"] = roles.get(str(s.get("key") or s.get("id") or ""), "signal")
                self.app.hub.publish({"type": "config",
                                      "config": {"signals": sigs,
                                                 "rate": res.get("fusion_rate") or res.get("rate"),
                                                 "sources": res.get("sources") or [],
                                                 "signal_flags": self.app.signal_flags_snapshot()}})
                return self._json(res)
            if path == "/api/profiles/switch":
                return self._json(self.app.switch_profile(payload.get("id")))
            if path == "/api/profiles/create":
                return self._json(self.app.create_profile(payload))
            if path == "/api/profiles/config":
                return self._json(self.app.save_profile_config(
                    payload, manual=bool(payload.get("manual"))))
            if path == "/api/profiles/build":
                return self._json(self.app.build_profile(payload.get("id")))
            if path == "/api/chip/probe":
                return self._json(self.app.probe_chip_now())
            if path == "/api/read":
                return self._json(self.app.read_value(payload))
            if path in ("/api/reset", "/api/control/reset"):
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
            if path in ("/api/catalog/axf", "/api/catalog/source/update"):
                # 按本机路径更新 AXF/SVD/头文件并立即重建符号表（不复制文件）
                return self._json(self.app.update_catalog_source(payload))
            if path == "/api/catalog/reload":
                if any(payload.get(k) for k in ("axf", "svd", "header", "table", "map")):
                    # 兼容：带源文件路径时等价于 /api/catalog/axf
                    return self._json(self.app.update_catalog_source(payload))
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
    ap.add_argument("--sim", action="store_true",
                    help="启用仿真能力；默认仍保持未连接（不自动开始采样）")
    ap.add_argument("--sim-connect", action="store_true",
                    help="启动后自动连接仿真源（演示用；普通启动不要加）")
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
        # 有 --sim 也不自动连接：启动即“未连接/未采样”，避免每次开页面
        # 都先跑一个仿真源。需要演示自动跑时显式加 --sim-connect。
        app.add_log("仿真模式：启动不自动连接，请在网页点仿真源的“连接”")
    if args.sim_connect:
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
