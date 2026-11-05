#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope 服务端分块压缩录制缓存（旁路存储）。

设计要点
--------
- 与现有实时链路完全解耦：采样线程只做一次非阻塞 ``append()``，真正的压缩/落盘
  在独立 writer 线程里完成；``/api/history``、SSE、``Recorder``/CSV 语义不变。
- 每个“录制会话”一个目录 ``session-<时间>-<随机>/``，会话内数据按块写盘：
  ``blk-000001.bin``（zlib 压缩的二进制块）。块在满 ``block_points``（默认 2000）
  或最长 5 秒时落盘（低速率下也不会无限积压）。元数据 ``meta.json`` 保存信号列、
  块索引（含每通道 min/max）、总量、saved/clearable 状态。
- 块格式（压缩前）::

      header: magic(4s)="MSMC", version(H), channels(H), seq(I),
              start_ms(d), count(I), reserved(I)   # struct "<4sHHIdII"
      ts:     int32 offset_ms * (count-1)          # 相对 start_ms 的毫秒偏移
      data:   int32 values[count * channels]       # 行优先

  整个 header+payload 用 stdlib zlib 压缩后落盘，临时文件 + os.replace 原子替换。
- 总容量默认 4 GB（可配）。超限清理顺序：
    1. 已结束且未保存（clearable）的会话，按创建时间从旧到新；
    2. 已保存（saved）的已结束会话，按创建时间从旧到新（即“最旧 saved 循环覆盖”）；
    3. 仍超限时，裁掉当前活动会话最旧的块（保留最新 1 块，绝不删正在写入的块）。
  当前活动会话不会被整体删除；若单块就超过上限，则允许短暂超限并记录 error。
- 正常退出/断开时未保存会话标记 ``clearable=true``；启动时直接清理 clearable
  会话（旧历史浏览尚未实现）。已保存会话保留，供下次容量压力时按上面的顺序覆盖。
- 本模块只暴露“当前会话”（active 或最近结束的那个）。旧会话列表/打开旧历史
  留待后续实现；saved 会话仍留在磁盘上并计入总容量。
"""
from __future__ import annotations

import json
import os
import queue
import secrets
import shutil
import struct
import threading
import time
import zlib
from typing import Any, Dict, List, Optional, Sequence, Tuple

MAGIC = b"MSMC"
CACHE_VERSION = 1
BLOCK_HEADER = struct.Struct("<4sHHIdII")
# magic, version, channels, block seq, start_ms, count, reserved
DEFAULT_LIMIT_BYTES = 4096 * 1024 * 1024
DEFAULT_BLOCK_POINTS = 2000
DEFAULT_FLUSH_SECONDS = 5.0       # 采样停止/低速率时，半块最长等待时间
DEFAULT_MAX_BLOCK_SECONDS = 5.0   # 连续采样时，半块最长积压时间
QUEUE_MAX = 20000
META_NAME = "meta.json"


def _atomic_json(path: str, data: Dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _clamp_int32(v: Any) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return 0
    if n > 2147483647:
        return 2147483647
    if n < -2147483648:
        return -2147483648
    return n


def _signal_meta(sig: Any) -> Dict[str, Any]:
    """把 Signal 对象或 dict 归一化成缓存信号元数据。"""
    get = sig.get if isinstance(sig, dict) else (lambda k, d=None: getattr(sig, k, d))
    sid = str(get("id") or get("name") or "")
    out = {
        "id": sid,
        "name": str(get("name") or sid),
        "unit": str(get("unit") or ""),
    }
    for key, default in (("scale", 1.0), ("offset", 0.0)):
        try:
            out[key] = float(get(key)) if get(key) is not None else default
        except (TypeError, ValueError):
            out[key] = default
    # 这些字段只影响显示，不影响原始数据解释
    for key in ("color", "axis"):
        val = get(key)
        if val not in (None, ""):
            out[key] = str(val)
    return out


def _sig_key(signals: Sequence[Dict[str, Any]]) -> Tuple[Any, ...]:
    """信号列指纹：顺序、缩放/偏移或单位变化都必须换会话，避免旧块解释错位。"""
    return tuple((s.get("id"), s.get("scale"), s.get("offset"), s.get("unit"))
                 for s in signals)


def read_block(path: str) -> List[List[Any]]:
    """读取/解压一个块，返回 ``[[t_ms, [v...]], ...]``。供测试与内部使用。"""
    with open(path, "rb") as f:
        raw = zlib.decompress(f.read())
    if len(raw) < BLOCK_HEADER.size:
        raise ValueError("block too short")
    magic, version, channels, _seq, start_ms, count, _reserved = \
        BLOCK_HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise ValueError("bad block magic")
    if version != CACHE_VERSION:
        raise ValueError("unsupported block version %s" % version)
    if channels <= 0 or count < 0:
        raise ValueError("bad block header")
    off = BLOCK_HEADER.size
    n_delta = max(0, count - 1)
    offsets: Tuple[int, ...] = ()
    if n_delta:
        need = n_delta * 4
        if len(raw) < off + need:
            raise ValueError("truncated timestamp block")
        offsets = struct.unpack_from("<%di" % n_delta, raw, off)
        off += need
    n_val = count * channels
    need = n_val * 4
    if len(raw) < off + need:
        raise ValueError("truncated sample block")
    vals = struct.unpack_from("<%di" % n_val, raw, off) if n_val else ()
    rows: List[List[Any]] = []
    for i in range(count):
        t = float(start_ms) + (float(offsets[i - 1]) if i else 0.0)
        base = i * channels
        rows.append([t, list(vals[base:base + channels])])
    return rows


def block_header(path: str) -> Dict[str, Any]:
    """只解压并返回块头信息（测试/诊断用）。"""
    with open(path, "rb") as f:
        raw = zlib.decompress(f.read())
    magic, version, channels, seq, start_ms, count, reserved = \
        BLOCK_HEADER.unpack_from(raw, 0)
    return {
        "magic": magic, "version": version, "channels": channels, "seq": seq,
        "start_ms": start_ms, "count": count, "reserved": reserved,
        "raw_size": len(raw),
    }


class RecordCache:
    """分块压缩缓存管理器。线程安全；``append()`` 永不阻塞采样线程。"""

    def __init__(self, root: Optional[str], limit_bytes: int = DEFAULT_LIMIT_BYTES,
                 block_points: int = DEFAULT_BLOCK_POINTS, enabled: bool = True,
                 logger=None, flush_seconds: float = DEFAULT_FLUSH_SECONDS,
                 max_block_seconds: float = DEFAULT_MAX_BLOCK_SECONDS):
        self.root = os.path.abspath(os.path.expanduser(root)) if root else ""
        self.limit_bytes = max(1024 * 1024, int(limit_bytes or DEFAULT_LIMIT_BYTES))
        self.block_points = max(10, min(50000, int(block_points or DEFAULT_BLOCK_POINTS)))
        self.flush_seconds = max(0.05, float(flush_seconds or DEFAULT_FLUSH_SECONDS))
        self.max_block_seconds = max(1.0, float(max_block_seconds or DEFAULT_MAX_BLOCK_SECONDS))
        self.logger = logger or (lambda _msg: None)
        self.enabled = bool(enabled and self.root)
        self.error = ""
        self._lock = threading.RLock()
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._current_id: Optional[str] = None
        self._total_bytes = 0
        self._desired_signals: List[Dict[str, Any]] = []
        self._desired_key: Tuple[Any, ...] = ()
        self._active_signals: List[Dict[str, Any]] = []
        self._active_key: Tuple[Any, ...] = ()
        self._pending: List[List[Any]] = []
        self._pending_signals: List[Dict[str, Any]] = []
        self._pending_key: Tuple[Any, ...] = ()
        self._last_flush = time.monotonic()
        self._pending_since = 0.0
        self._dropped = 0
        self._closed = False
        self._queue: "queue.Queue[Tuple[Any, ...]]" = queue.Queue(maxsize=QUEUE_MAX)
        self._thread: Optional[threading.Thread] = None
        if not self.enabled:
            self.error = "disabled"
            return
        try:
            os.makedirs(self.root, exist_ok=True)
            self._load_and_cleanup()
            self._thread = threading.Thread(target=self._writer_loop,
                                            name="motor-scope-record-cache",
                                            daemon=True)
            self._thread.start()
        except Exception as exc:
            self.enabled = False
            self.error = str(exc)
            self.logger("录制缓存初始化失败: %s" % exc)

    # ------------------------------------------------------------ 生命周期 / 配置
    def configure(self, signals: Sequence[Any]) -> None:
        """采样通道配置变化时调用；下一次写入会先结束旧会话再开新会话。"""
        if not self.enabled:
            return
        meta: List[Dict[str, Any]] = []
        for sig in signals or []:
            item = _signal_meta(sig)
            if item.get("id"):
                meta.append(item)
        key = _sig_key(meta)
        with self._lock:
            self._desired_signals = meta
            self._desired_key = key
            rotate = bool(self._current_id and self._active_key and key != self._active_key)
        # 让 writer 尽快结束旧会话，而不是等下一批样本；不阻塞调用方。
        if rotate:
            try:
                self._queue.put_nowait(("rotate", None))
            except queue.Full:
                pass

    def append(self, t_ms: float, values: Sequence[Any]) -> None:
        """采样线程调用：仅入队，不做文件 IO，不阻塞实时采样。"""
        if not self.enabled or self._closed:
            return
        try:
            vals = [_clamp_int32(v) for v in values]
            self._queue.put_nowait(("s", float(t_ms), vals))
        except queue.Full:
            self._dropped += 1
        except Exception:
            self._dropped += 1

    def flush(self, timeout: float = 1.0) -> bool:
        """请求 writer 把当前未满块落盘（供 API/测试使用）。"""
        if not self.enabled or not self._thread or self._closed:
            return False
        ev = threading.Event()
        try:
            self._queue.put(("flush", ev), timeout=max(0.05, timeout))
        except queue.Full:
            return False
        return ev.wait(max(0.05, timeout))

    def finish(self, wait: bool = True, timeout: float = 5.0) -> bool:
        """结束当前会话：flush 尾部，未保存则标记 clearable。可重复调用。"""
        if not self.enabled or not self._thread or self._closed:
            return False
        ev = threading.Event()
        try:
            self._queue.put(("finish", ev), timeout=timeout)
        except queue.Full:
            return False
        return ev.wait(timeout) if wait else True

    def close(self) -> None:
        if self._closed:
            return
        self.finish(wait=True)
        self._closed = True
        if not self.enabled or not self._thread:
            return
        try:
            self._queue.put(("stop", None), timeout=2.0)
        except queue.Full:
            pass
        self._thread.join(timeout=3.0)

    def wait_idle(self, timeout: float = 3.0) -> bool:
        """测试辅助：等待队列/待写块清空。"""
        return self.flush(timeout)

    # ------------------------------------------------------------ writer
    def _writer_loop(self) -> None:
        while not self._closed:
            try:
                item = self._queue.get(timeout=0.2)
            except queue.Empty:
                with self._lock:
                    if self._pending and (time.monotonic() - self._last_flush) >= self.flush_seconds:
                        self._safe_flush_locked()
                continue
            kind = item[0]
            if kind == "stop":
                break
            if kind == "flush":
                with self._lock:
                    self._safe_flush_locked()
                item[1].set()
                continue
            if kind == "finish":
                with self._lock:
                    self._safe_flush_locked()
                    self._finish_current_locked(clearable_if_unsaved=True)
                item[1].set()
                continue
            if kind == "rotate":
                with self._lock:
                    self._safe_flush_locked()
                    self._finish_current_locked(clearable_if_unsaved=True)
                continue
            if kind == "s":
                _kind, t_ms, vals = item
                with self._lock:
                    try:
                        self._accept_sample_locked(t_ms, vals)
                    except Exception as exc:
                        self.error = "写缓存失败: %s" % exc
                        self.logger(self.error)
                        self._pending = []
                continue
        # 退出：落盘并结束会话
        with self._lock:
            self._safe_flush_locked()
            self._finish_current_locked(clearable_if_unsaved=True)

    def _accept_sample_locked(self, t_ms: float, vals: List[int]) -> None:
        # 配置变了：先把旧会话尾部写完，再结束旧会话；新会话在下一块开始时创建。
        if self._desired_key != self._active_key:
            self._safe_flush_locked()
            self._finish_current_locked(clearable_if_unsaved=True)
        if not self._current_id or not self._session_by_id(self._current_id).get("active"):
            self._start_session_locked(self._desired_signals, self._desired_key)
        sess = self._session_by_id(self._current_id)
        if not sess or not sess.get("active"):
            return
        if len(vals) != len(sess.get("signals") or []):
            self._dropped += 1
            return
        if not self._pending:
            self._pending_since = time.monotonic()
        self._pending.append([float(t_ms), vals])
        if (len(self._pending) >= self.block_points or
                (time.monotonic() - self._pending_since) >= self.max_block_seconds):
            self._safe_flush_locked()

    def _safe_flush_locked(self) -> None:
        try:
            self._flush_pending_locked()
        except Exception as exc:
            self.error = "写缓存块失败: %s" % exc
            self.logger(self.error)
            self._pending = []

    # ------------------------------------------------------------ sessions
    def _session_by_id(self, sid: Optional[str]) -> Optional[Dict[str, Any]]:
        return self._sessions.get(sid) if sid else None

    def _new_session_meta(self, signals: Sequence[Dict[str, Any]],
                          key: Tuple[Any, ...]) -> Dict[str, Any]:
        now = time.time()
        sid = "session-%s-%s" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)),
                                 secrets.token_hex(3))
        path = os.path.join(self.root, sid)
        return {
            "version": CACHE_VERSION,
            "id": sid,
            "created": now,
            "updated": now,
            "ended_wall": None,
            "active": True,
            "saved": False,
            "clearable": False,
            "block_points": self.block_points,
            "limit_bytes": self.limit_bytes,
            "signals": list(signals),
            "sig_key": list(key),
            "blocks": [],
            "count": 0,
            "start": None,
            "end": None,
            "bytes": 0,
            "dir": path,
        }

    def _start_session_locked(self, signals: Sequence[Dict[str, Any]],
                              key: Tuple[Any, ...]) -> None:
        if not signals:
            return
        meta = self._new_session_meta(signals, key)
        try:
            os.makedirs(meta["dir"], exist_ok=True)
            _atomic_json(os.path.join(meta["dir"], META_NAME),
                         self._public_meta(meta))
        except Exception as exc:
            self.error = "创建缓存会话失败: %s" % exc
            self.logger(self.error)
            return
        self._sessions[meta["id"]] = meta
        self._current_id = meta["id"]
        self._active_signals = list(signals)
        self._active_key = key
        self._pending_signals = list(signals)
        self._pending_key = key

    def _finish_current_locked(self, clearable_if_unsaved: bool = True) -> None:
        sess = self._session_by_id(self._current_id)
        self._active_signals = []
        self._active_key = ()
        if not sess or not sess.get("active"):
            return
        sess["active"] = False
        sess["ended_wall"] = time.time()
        sess["updated"] = time.time()
        if not sess.get("saved"):
            sess["clearable"] = bool(clearable_if_unsaved)
        else:
            sess["clearable"] = False
        # 空会话（未写出任何块）没有保留价值
        if not sess.get("blocks"):
            self._delete_session_locked(sess["id"])
            return
        self._write_meta_locked(sess)
        if not sess.get("clearable") and not sess.get("saved"):
            # 不该发生，保底
            sess["clearable"] = True
            self._write_meta_locked(sess)

    def _write_meta_locked(self, sess: Dict[str, Any]) -> None:
        sess["updated"] = time.time()
        try:
            _atomic_json(os.path.join(sess["dir"], META_NAME), self._public_meta(sess))
        except Exception as exc:
            self.error = "写 meta 失败: %s" % exc
            self.logger(self.error)

    @staticmethod
    def _public_meta(sess: Dict[str, Any]) -> Dict[str, Any]:
        """去掉内存路径字段，落盘只保留可迁移的信息。"""
        out = dict(sess)
        out.pop("dir", None)
        return out

    # ------------------------------------------------------------ blocks
    def _flush_pending_locked(self) -> None:
        if not self._pending:
            return
        sess = self._session_by_id(self._current_id)
        if not sess or not sess.get("active"):
            # 没有活动会话（例如刚被结束）：丢掉孤立 pending，避免无限增长
            self._pending = []
            return
        if self._pending_key != self._active_key:
            self._pending = []
            return
        rows = self._pending
        self._pending = []
        self._pending_since = 0.0
        if not rows:
            return
        channels = len(sess.get("signals") or [])
        if channels <= 0:
            return
        seq = max([int(b.get("seq") or 0) for b in (sess.get("blocks") or [])] or [0]) + 1
        name = "blk-%06d.bin" % seq
        path = os.path.join(sess["dir"], name)
        start_ms = float(rows[0][0])
        end_ms = float(rows[-1][0])
        count = len(rows)
        offsets = []
        for t, _vals in rows[1:]:
            off = int(round(float(t) - start_ms))
            if off < 0:
                off = 0
            if offsets and off < offsets[-1]:
                off = offsets[-1]
            offsets.append(off)
        flat: List[int] = []
        mins = [None] * channels
        maxs = [None] * channels
        for _t, vals in rows:
            vals = vals[:channels]
            if len(vals) < channels:
                vals = list(vals) + [0] * (channels - len(vals))
            for i, v in enumerate(vals):
                iv = _clamp_int32(v)
                flat.append(iv)
                if mins[i] is None or iv < mins[i]:
                    mins[i] = iv
                if maxs[i] is None or iv > maxs[i]:
                    maxs[i] = iv
        payload = BLOCK_HEADER.pack(MAGIC, CACHE_VERSION, channels, seq,
                                    start_ms, count, 0)
        if offsets:
            payload += struct.pack("<%di" % len(offsets), *offsets)
        if flat:
            payload += struct.pack("<%di" % len(flat), *flat)
        comp = zlib.compress(payload, 6)
        tmp = path + ".tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(comp)
            os.replace(tmp, path)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        block = {
            "seq": seq,
            "file": name,
            "start": start_ms,
            "end": end_ms,
            "count": count,
            "size": len(comp),
            "raw_size": len(payload),
            "mins": mins,
            "maxs": maxs,
        }
        sess.setdefault("blocks", []).append(block)
        sess["count"] = int(sess.get("count") or 0) + count
        sess["start"] = sess["blocks"][0]["start"] if sess["blocks"] else None
        sess["end"] = end_ms
        sess["bytes"] = int(sess.get("bytes") or 0) + len(comp)
        self._total_bytes += len(comp)
        self._write_meta_locked(sess)
        self._last_flush = time.monotonic()
        self._enforce_limit_locked()

    # ------------------------------------------------------------ capacity
    def _delete_block_locked(self, sess: Dict[str, Any], block: Dict[str, Any]) -> None:
        try:
            os.remove(os.path.join(sess["dir"], block.get("file") or ""))
        except OSError:
            pass
        size = int(block.get("size") or 0)
        sess["bytes"] = max(0, int(sess.get("bytes") or 0) - size)
        self._total_bytes = max(0, self._total_bytes - size)

    def _delete_session_locked(self, sid: str) -> None:
        sess = self._sessions.pop(sid, None)
        if not sess:
            return
        self._total_bytes = max(0, self._total_bytes - int(sess.get("bytes") or 0))
        try:
            shutil.rmtree(sess.get("dir") or "", ignore_errors=True)
        except Exception:
            pass
        if self._current_id == sid:
            self._current_id = None

    def _enforce_limit_locked(self) -> None:
        if self.limit_bytes <= 0 or self._total_bytes <= self.limit_bytes:
            if self.error.startswith("缓存超过上限"):
                self.error = ""
            return
        # 1) clearable 会话（旧 → 新）
        finished = [s for s in self._sessions.values()
                    if not s.get("active") and s.get("clearable")]
        for sess in sorted(finished, key=lambda x: x.get("created") or 0):
            if self._total_bytes <= self.limit_bytes:
                return
            self._delete_session_locked(sess["id"])
            self.logger("缓存超限，清理未保存会话 %s" % sess["id"])
        # 2) 最旧 saved 会话循环覆盖
        saved = [s for s in self._sessions.values()
                 if not s.get("active") and s.get("saved")]
        for sess in sorted(saved, key=lambda x: x.get("created") or 0):
            if self._total_bytes <= self.limit_bytes:
                return
            self._delete_session_locked(sess["id"])
            self.logger("缓存超限，覆盖最旧已保存会话 %s" % sess["id"])
        # 3) 当前活动会话：只裁最旧的块，保留最新一块（正在写/刚写的块不删）
        sess = self._session_by_id(self._current_id)
        if sess:
            while self._total_bytes > self.limit_bytes and len(sess.get("blocks") or []) > 1:
                block = sess["blocks"].pop(0)
                self._delete_block_locked(sess, block)
                sess["count"] = max(0, int(sess.get("count") or 0) - int(block.get("count") or 0))
                sess["start"] = sess["blocks"][0]["start"] if sess["blocks"] else None
                sess["end"] = sess["blocks"][-1]["end"] if sess["blocks"] else None
                self._write_meta_locked(sess)
                self.logger("缓存超限，裁掉当前会话最旧块 %s/%s"
                            % (sess["id"], block.get("file")))
        if self._total_bytes > self.limit_bytes:
            self.error = ("缓存超过上限 %d 字节，当前会话仅保留最新块；"
                          "请保存/清理缓存或调大 --record-cache-limit-mb" % self.limit_bytes)
            self.logger(self.error)

    # ------------------------------------------------------------ 启动扫描/修复
    def _load_and_cleanup(self) -> None:
        now = time.time()
        for name in sorted(os.listdir(self.root)):
            path = os.path.join(self.root, name)
            if not os.path.isdir(path) or not name.startswith("session-"):
                continue
            meta_path = os.path.join(path, META_NAME)
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                if not isinstance(meta, dict):
                    raise ValueError("bad meta")
            except Exception:
                shutil.rmtree(path, ignore_errors=True)
                continue
            meta["dir"] = path
            if not meta.get("id"):
                meta["id"] = name
            meta.setdefault("blocks", [])
            meta.setdefault("signals", [])
            meta.setdefault("saved", False)
            meta.setdefault("clearable", False)
            # 索引修复：丢掉文件缺失的块，删除没有索引的孤儿块
            valid = []
            referenced = set()
            for block in meta["blocks"]:
                if not isinstance(block, dict):
                    continue
                fname = str(block.get("file") or "")
                if not fname or not os.path.isfile(os.path.join(path, fname)):
                    continue
                valid.append(block)
                referenced.add(fname)
            for fname in os.listdir(path):
                if fname.startswith("blk-") and fname not in referenced:
                    try:
                        os.remove(os.path.join(path, fname))
                    except OSError:
                        pass
                elif fname.endswith(".tmp"):
                    try:
                        os.remove(os.path.join(path, fname))
                    except OSError:
                        pass
            try:
                valid.sort(key=lambda b: int(b.get("seq") or 0))
            except (TypeError, ValueError):
                valid.sort(key=lambda b: str(b.get("file") or ""))
            meta["blocks"] = valid
            meta["bytes"] = sum(int(b.get("size") or 0) for b in valid)
            meta["count"] = sum(int(b.get("count") or 0) for b in valid)
            meta["start"] = valid[0]["start"] if valid else None
            meta["end"] = valid[-1]["end"] if valid else None
            # 上次进程异常退出：active 会话按“未保存 → clearable”处理
            if meta.get("active"):
                meta["active"] = False
                meta["ended_wall"] = meta.get("ended_wall") or now
                if not meta.get("saved"):
                    meta["clearable"] = True
            # 启动时优先清理 clearable（旧历史打开尚未实现）
            if meta.get("clearable") and not meta.get("saved"):
                shutil.rmtree(path, ignore_errors=True)
                continue
            if not valid and not meta.get("saved"):
                shutil.rmtree(path, ignore_errors=True)
                continue
            self._sessions[meta["id"]] = meta
            self._total_bytes += int(meta.get("bytes") or 0)
            try:
                _atomic_json(meta_path, self._public_meta(meta))
            except Exception:
                pass
        self._current_id = None
        self._enforce_limit_locked()

    # ------------------------------------------------------------ 查询/API
    def info(self) -> Dict[str, Any]:
        with self._lock:
            sess = self._session_by_id(self._current_id)
            out = {
                "ok": True,
                "enabled": bool(self.enabled),
                "session": sess.get("id") if sess else None,
                "active": bool(sess.get("active")) if sess else False,
                "saved": bool(sess.get("saved")) if sess else False,
                "clearable": bool(sess.get("clearable")) if sess else False,
                "count": int(sess.get("count") or 0) if sess else 0,
                "start": sess.get("start") if sess else None,
                "end": sess.get("end") if sess else None,
                "signals": list(sess.get("signals") or []) if sess else [],
                "blocks": len(sess.get("blocks") or []) if sess else 0,
                "session_bytes": int(sess.get("bytes") or 0) if sess else 0,
                "total_bytes": int(self._total_bytes),
                "limit_bytes": int(self.limit_bytes),
                "block_points": int(self.block_points),
                "created": sess.get("created") if sess else None,
                "error": self.error,
                "dropped": int(self._dropped),
                "sessions": len(self._sessions),
            }
            return out

    def _overview_meta(self) -> Dict[str, Any]:
        sess = self._session_by_id(self._current_id)
        return sess or {}

    def overview(self, max_points: int = 2000) -> Dict[str, Any]:
        # 让刚采到的尾巴也能出现在当前会话 overview 里（最多等 1 s）
        self.flush(timeout=1.0)
        try:
            max_points = max(1, min(20000, int(max_points)))
        except (TypeError, ValueError):
            max_points = 2000
        with self._lock:
            sess = self._overview_meta()
            if not sess or not sess.get("blocks"):
                out = self.info()
                out.update({"ok": True, "empty": True, "max_points": max_points,
                            "buckets": []})
                return out
            blocks = list(sess.get("blocks") or [])
            n = len(blocks)
            buckets_n = min(max_points, n)
            buckets: List[Dict[str, Any]] = []
            for i in range(buckets_n):
                lo = i * n // buckets_n
                hi = (i + 1) * n // buckets_n
                part = blocks[lo:hi]
                if not part:
                    continue
                ch = len(sess.get("signals") or [])
                mins = [None] * ch
                maxs = [None] * ch
                count = 0
                for b in part:
                    count += int(b.get("count") or 0)
                    for j in range(min(ch, len(b.get("mins") or []))):
                        v = b["mins"][j]
                        if v is not None and (mins[j] is None or v < mins[j]):
                            mins[j] = v
                    for j in range(min(ch, len(b.get("maxs") or []))):
                        v = b["maxs"][j]
                        if v is not None and (maxs[j] is None or v > maxs[j]):
                            maxs[j] = v
                buckets.append({
                    "start": part[0]["start"], "end": part[-1]["end"],
                    "count": count, "min": mins, "max": maxs,
                })
            return {
                "ok": True, "empty": False,
                "session": sess.get("id"),
                "active": bool(sess.get("active")),
                "saved": bool(sess.get("saved")),
                "start": sess.get("start"), "end": sess.get("end"),
                "count": int(sess.get("count") or 0),
                "signals": list(sess.get("signals") or []),
                "blocks": n, "max_points": max_points,
                "session_bytes": int(sess.get("bytes") or 0),
                "total_bytes": int(self._total_bytes),
                "limit_bytes": int(self.limit_bytes),
                "buckets": buckets,
                "error": self.error,
            }

    def window(self, start: Optional[float] = None, end: Optional[float] = None,
               max_points: int = 20000) -> Dict[str, Any]:
        try:
            max_points = max(1, min(60000, int(max_points)))
        except (TypeError, ValueError):
            max_points = 20000
        with self._lock:
            sess = self._overview_meta()
            if not sess or not sess.get("blocks"):
                return {"ok": True, "enabled": self.enabled, "empty": True,
                        "session": None, "signals": [], "samples": [],
                        "start": None, "end": None, "count": 0,
                        "returned": 0, "decimated": False}
            try:
                start = float(start) if start is not None else float(sess.get("start") or 0)
                end = float(end) if end is not None else float(sess.get("end") or 0)
            except (TypeError, ValueError):
                start = float(sess.get("start") or 0)
                end = float(sess.get("end") or 0)
            if end < start:
                start, end = end, start
            samples: List[List[Any]] = []
            for block in sess.get("blocks") or []:
                if float(block.get("end") or 0) < start:
                    continue
                if float(block.get("start") or 0) > end:
                    break
                path = os.path.join(sess["dir"], str(block.get("file") or ""))
                try:
                    rows = read_block(path)
                except Exception as exc:
                    self.error = "读块失败 %s: %s" % (block.get("file"), exc)
                    continue
                for row in rows:
                    if start <= row[0] <= end:
                        samples.append(row)
            total = len(samples)
            decimated = False
            stride = 1
            if total > max_points:
                stride = max(1, (total + max_points - 1) // max_points)
                last_sample = samples[-1]
                samples = samples[::stride]
                if samples and samples[-1] is not last_sample and samples[-1][0] != last_sample[0]:
                    samples.append(last_sample)
                decimated = True
            return {
                "ok": True, "enabled": self.enabled, "empty": False,
                "session": sess.get("id"),
                "active": bool(sess.get("active")),
                "saved": bool(sess.get("saved")),
                "signals": list(sess.get("signals") or []),
                "samples": samples,
                "start": start, "end": end,
                "count": total, "returned": len(samples),
                "decimated": decimated, "stride": stride,
                "session_bytes": int(sess.get("bytes") or 0),
                "total_bytes": int(self._total_bytes),
                "limit_bytes": int(self.limit_bytes),
                "error": self.error,
            }

    def save_current(self) -> Dict[str, Any]:
        with self._lock:
            sess = self._session_by_id(self._current_id)
            if not sess:
                return {"ok": False, "error": "没有可保存的缓存会话"}
            sess["saved"] = True
            sess["saved_at"] = time.time()
            sess["clearable"] = False
            self._write_meta_locked(sess)
            out = self.info()
            out["ok"] = True
            self.logger("缓存会话已保存（本地标记）: %s" % sess.get("id"))
            return out
