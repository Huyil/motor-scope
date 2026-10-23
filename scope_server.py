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
import socket
import sys
import threading
import time
import traceback
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_DEFAULT = os.path.abspath(os.path.join(HERE, "..", ".."))
WEB_DIR = os.path.join(HERE, "web")
SIGNALS_JSON = os.path.join(HERE, "signals.json")
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

    def _prepare(self, signals: Sequence[Signal]) -> None:
        key = tuple((s.addr, s.span()[1]) for s in signals)
        if key == self._region_key:
            return
        self.regions = ocd.plan_regions([s.span() for s in signals])
        self._starts = []
        total = 0
        for r in self.regions:
            self._starts.append(total)
            total += r.words
        self._region_key = key

    def read(self, signals: Sequence[Signal]) -> List[int]:
        if not signals:
            return []
        self._prepare(signals)
        words = self.client.read_regions([(r.addr, r.words) for r in self.regions])
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

    def close(self) -> None:
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
            "cpuid": self.cpuid,
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

    def read(self, signals: Sequence[Signal]) -> List[int]:
        return OpenOcdSource.read(self._inner, signals)

    def close(self) -> None:
        self.client.close()

    def info(self) -> Dict[str, Any]:
        return {"kind": "attach", "connected": self.client.connected,
                "host": self.host, "port": self.port, "cpuid": self.cpuid}


class SimSource(Source):
    kind = "sim"

    def __init__(self):
        self.start = time.monotonic()
        self.rand = random.Random(2159)
        self.over_ticks = 0

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
            else:
                # 未建模的信号给一个缓慢的正弦, 便于区分
                h = sum(ord(c) for c in name) or 1
                v = 128 + 60 * math.sin(t * 0.7 + (h % 97) * 0.13)
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

    def stop(self) -> None:
        with self._lock:
            self.active = False

    def append(self, t_ms: float, values: List[int]) -> None:
        if not self.active:
            return
        with self._lock:
            self.data.append((t_ms, list(values)))

    def info(self) -> Dict[str, Any]:
        with self._lock:
            n = len(self.data)
            return {"active": self.active, "count": n,
                    "seconds": (time.time() - self.started) if self.active and self.started else 0.0}

    def csv(self) -> str:
        with self._lock:
            signals = [Signal(s) for s in self.signals] or []
            rows = list(self.data)
        out = io.StringIO()
        header = ["t_ms"] + ["%s%s" % (s.name, (" [%s]" % s.unit) if s.unit else "") for s in signals]
        out.write(",".join(_csv_cell(h) for h in header) + "\n")
        for t, vals in rows:
            cells = ["%.1f" % t]
            for i, s in enumerate(signals):
                raw = vals[i] if i < len(vals) else 0
                val = raw * s.scale + s.offset
                cells.append(("%.4f" % val).rstrip("0").rstrip(".") if s.scale != 1 or s.offset else str(raw))
            out.write(",".join(cells) + "\n")
        return out.getvalue()


def _csv_cell(v: Any) -> str:
    s = str(v)
    if any(c in s for c in ",\"\n\r"):
        return '"' + s.replace('"', '""') + '"'
    return s


class Sampler(threading.Thread):
    def __init__(self, hub: Hub):
        super().__init__(name="motor-scope-sampler", daemon=True)
        self.hub = hub
        self.recorder = Recorder()
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

    def set_signals(self, signals: Sequence[Signal], rate: float) -> None:
        key = tuple((s.addr, s.size, s.shift, s.width) for s in signals)
        with self._cond:
            if key != self._sig_key:
                # 通道构成变了, 旧样本的列对不上, 丢掉
                self.history.clear()
                self._sig_key = key
            self.signals = list(signals)
            self.rate = max(1.0, min(500.0, float(rate or 100)))
            self.generation += 1
            self.error = ""
            self._cond.notify_all()
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
            next_t = max(next_t + period, t0 + 0.002) if next_t else t0 + period
            sleep = next_t - time.monotonic()
            if sleep > 0:
                self._wake.wait(min(sleep, 1.0))
                self._wake.clear()
            else:
                next_t = time.monotonic()

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
class App:
    def __init__(self, args):
        self.args = args
        self.project = os.path.abspath(args.project or PROJECT_DEFAULT)
        self.axf = os.path.abspath(args.axf or os.path.join(self.project, "MDK", "Objects", "DR2159.axf"))
        self.header = os.path.abspath(args.header or os.path.join(self.project, "Libraries", "inc", "cw32l011.h"))
        self.signals_path = os.path.abspath(args.signals or SIGNALS_JSON)
        self.hub = Hub()
        self.sampler = Sampler(self.hub)
        self.source: Optional[Source] = None
        self.catalog: Dict[str, Any] = {}
        self.catalog_error = ""
        self.catalog_lock = threading.Lock()
        self.status_lock = threading.Lock()
        self.running = True
        self.error = ""
        self.started = time.time()
        self.openocd_override = args.openocd
        self.iface_override = args.iface
        self.target_override = args.target
        self.last_connect_error = ""
        self.log: Deque[str] = deque(maxlen=300)
        self._auto_thread: Optional[threading.Thread] = None
        self.load_catalog(auto_regen=True)
        # 先装一套默认信号: 这样服务器一起来就开始采样, 页面刷新/后开浏览器
        # 都能直接看到历史, 而不是从空白开始.
        try:
            cfg = self.default_config()
            self.sampler.set_signals([Signal(x) for x in cfg["signals"]], cfg["rate"])
        except Exception as exc:
            self.add_log("默认信号初始化失败: %s" % exc)

    # ---- 日志 ----
    def add_log(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        self.log.append(line)
        if self.args.verbose:
            print("[scope] " + line, flush=True)

    # ---- 目录 ----
    def load_catalog(self, auto_regen: bool = True) -> None:
        with self.catalog_lock:
            data = None
            try:
                if os.path.isfile(self.signals_path):
                    with open(self.signals_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
            except Exception as exc:
                self.catalog_error = "读取 signals.json 失败: %s" % exc
            need = False
            if data is None:
                need = True
            elif os.path.isfile(self.axf):
                try:
                    if os.path.getmtime(self.axf) > float(data.get("meta", {}).get("axf_mtime", 0)) + 0.5:
                        need = True
                except Exception:
                    need = True
            if need and auto_regen and os.path.isfile(self.axf):
                try:
                    data = self.regenerate_catalog()
                except Exception as exc:
                    self.catalog_error = "自动生成信号表失败: %s" % exc
                    self.add_log(self.catalog_error)
            if data is None:
                data = {"meta": {}, "variables": [], "peripherals": [],
                        "defaults": [], "stall": {}}
            self.catalog = data
            self.add_log("信号表: %d 个变量 / %d 个外设 (%s)"
                         % (len(data.get("variables", [])), len(data.get("peripherals", [])),
                            data.get("meta", {}).get("generated_at", "?")))

    def regenerate_catalog(self) -> Dict[str, Any]:
        try:
            import gen_signals  # 同目录, 依赖 pyelftools
        except Exception as exc:
            raise RuntimeError("需要 pyelftools 才能从 AXF 生成信号表: %s" % exc)
        data = gen_signals.build(self.axf, self.header,
                                 os.path.join(os.path.dirname(self.axf), "DR2159.map"))
        tmp = self.signals_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, self.signals_path)
        self.add_log("已从 AXF 重建信号表 (%s)" % data.get("meta", {}).get("generated_at"))
        return data

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
    def status_payload(self) -> Dict[str, Any]:
        src = self.source
        info = src.info() if src else {"kind": "none", "connected": False}
        meta = self.catalog.get("meta", {})
        return {
            "version": VERSION,
            "source": info,
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
                       "rate": self.sampler.rate},
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

    # ---- 连接 ----
    def disconnect(self) -> None:
        src, self.source = self.source, None
        self.sampler.set_source(None)
        if src is not None:
            try:
                src.close()
            except Exception as exc:
                self.add_log("关闭源失败: %s" % exc)
            self.add_log("已断开")

    def connect(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        mode = str(payload.get("mode") or "openocd").lower()
        self.error = ""
        self.last_connect_error = ""
        # 先停掉旧源: H7-TOOL 只有一个, 新旧 openocd 不能同时占着
        self.disconnect()
        if mode == "sim":
            src: Source = SimSource()
            self.source = src
            self.sampler.set_source(src)
            self.add_log("已切换到仿真信号源")
            return {"ok": True, "source": src.info()}

        if mode == "attach":
            host = str(payload.get("host") or "127.0.0.1")
            port = int(payload.get("port") or 6666)
            client = ocd.TclClient(host, port, timeout=4.0)
            try:
                client.connect()
                client.install_reader()
                cpuid = client.read_words(0xE000ED00, 1)[0]
            except Exception as exc:
                client.close()
                self.last_connect_error = str(exc)
                raise
            src = AttachedSource(client, host, port)
            src.cpuid = cpuid  # type: ignore[attr-defined]
            self.source = src
            self.sampler.set_source(src)
            self.add_log("已连上外部 TCL %s:%d, CPUID=0x%08x" % (host, port, cpuid))
            return {"ok": True, "source": src.info()}

        # 本地拉起 openocd
        exe = payload.get("openocd") or self.openocd_override
        iface = payload.get("iface") or self.iface_override
        target = payload.get("target") or self.target_override
        paths = ocd.find_openocd(self.project, exe)
        if paths is None:
            msg = "找不到可用的 OpenOCD (需要 bin/openocd.exe + interface/cmsis-dap-v1.cfg + target/cw32l01x-flm.cfg)"
            self.last_connect_error = msg
            raise RuntimeError(msg)
        if iface:
            paths = ocd.OcdPaths(paths.exe, paths.scripts, iface, target or paths.target)
        if target:
            paths = ocd.OcdPaths(paths.exe, paths.scripts, paths.iface, target)
        if not os.path.isfile(paths.exe):
            msg = "OpenOCD 不存在: %s" % paths.exe
            self.last_connect_error = msg
            raise RuntimeError(msg)
        port = int(payload.get("tcl_port") or 0)
        proc = ocd.OcdProcess(paths, port=port, verbose=self.args.verbose)
        try:
            client = proc.start(timeout=float(payload.get("timeout") or 15.0))
        except Exception as exc:
            proc.stop()
            self.last_connect_error = str(exc)
            raise
        src = OpenOcdSource(proc, client)
        try:
            src.cpuid = client.read_words(0xE000ED00, 1)[0]
        except Exception:
            src.cpuid = None
        self.source = src
        self.sampler.set_source(src)
        self.add_log("OpenOCD 已连接 (pid=%s, tcl_port=%d)" % (proc.pid, proc.port))
        return {"ok": True, "source": src.info()}

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
        self.sampler.set_signals(signals, rate)
        self.add_log("采样配置: %d 路, %.0f Hz" % (len(signals), rate))
        return {"ok": True, "signals": [s.to_dict() for s in signals], "rate": rate}

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
            if path == "/api/catalog":
                return self._json(self.app.catalog)
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
            if path == "/api/log":
                return self._json({"log": self.app.log_tail(200)})
            if path == "/api/record.csv":
                csv_text = self.app.sampler.recorder.csv()
                return self._bytes(csv_text.encode("utf-8-sig"), "text/csv; charset=utf-8",
                                   extra={"Content-Disposition": 'attachment; filename="motorscope.csv"'})
            if path == "/api/stream":
                return self._stream()
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
        payload = self._read_json()
        try:
            if path == "/api/connect":
                return self._json(self.app.connect(payload))
            if path == "/api/disconnect":
                self.app.disconnect()
                return self._json({"ok": True, "status": self.app.status_payload()})
            if path == "/api/config":
                return self._json(self.app.apply_config(payload))
            if path == "/api/record":
                return self._json(self.app.record(payload))
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
                            "config": {"signals": [s.to_dict() for s in app.sampler.signals],
                                       "rate": app.sampler.rate}})
            self.wfile.flush()
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
                for item in batch:
                    if item.get("type") == "s":
                        samples.extend(item.get("b") or [])
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
    ap.add_argument("--host", default="127.0.0.1", help="HTTP 绑定地址")
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
    ap.add_argument("--verbose", action="store_true", help="打印 OpenOCD / HTTP 日志")
    return ap.parse_args(argv)


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
    url = "http://%s:%d/" % (args.host if args.host != "0.0.0.0" else "127.0.0.1", port)
    print("MotorScope %s" % VERSION)
    print("  UI   : %s" % url)
    print("  AXF  : %s" % app.axf)
    print("  JSON : %s" % app.signals_path)
    oc = app._openocd_info()
    print("  OCD  : %s" % (oc.get("exe") or "not found"))
    print("  Ctrl+C 退出")

    def _atexit():
        try:
            app.shutdown()
        except Exception:
            pass
    atexit.register(_atexit)
    app.sampler.start()

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
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
