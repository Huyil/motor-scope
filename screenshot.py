#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯标准库波形截图（给智能体/脚本看的 PNG）.

渲染方式对齐网页 <canvas> 波形区：深色面板、每个通道一个 pane（各自 y 轴）、
主信号面积填充 + 描边、横向/纵向主次标尺网格、pane 标题条与统计值。

时间轴有两条：
  * 底部：原来的绝对时间轴（T+…）；
  * 左侧：新增的 0 起相对时间轴，顶部为 0、向下递增。

不依赖 Pillow / matplotlib：自带 8x13 位图字体、zlib PNG 编码和简单的 2D 绘制。
"""
from __future__ import annotations

import math
import struct
import time
import zlib
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# 8x13 位图字体（ASCII 32..126）。由 DejaVuSansMono 11px 栅格化后嵌入，
# 保证 Windows 自带 runtime（无 Pillow）也能画字。
# ---------------------------------------------------------------------------
FONT_W = 8
FONT_H = 13
_FONT_HEX = (
    "0000000000000000000000000000001010101010100010000000000028282800000000000000000000142c7e2828fc50"
    "500000000000103c5050381c1478101000000060906418205c161c000000000038606060d68ccc7c0000000000101010"
    "000000000000000000181010302020301010080000002030101010101010302000000000105438385410000000000000"
    "0000001010fc101000000000000000000000000010302000000000000000003800000000000000000000000000001010"
    "00000000000c081810102020404000000000386c444454446c380000000000701010101010107c0000000000784c0c08"
    "1830607c0000000000384c0c380c044c7800000000001818284848fc08080000000000784040780c0c0c780000000000"
    "386040784c444c3800000000007c0c0818101030200000000000384c4c384c444c380000000000784c444c7c04087800"
    "00000000000010100000101000000000000000101000001030200000000000000c38c0380c000000000000000000fc00"
    "fc000000000000000000c0380c38c0000000000000780c08181010003000000000003864c49ca4a49c40603c00000030"
    "382868487c44c40000000000784c4c784c4444780000000000386440404040643800000000007048444444444c780000"
    "0000007c40407c4040407c00000000007c40407c404040400000000000386440c0cc44643800000000004444447c4444"
    "444400000000007c1010101010107c0000000000380808080808087000000000004448507050484c4400000000004040"
    "40404040407c0000000000ccececf4d4c4c4c4000000000044646454545c4c4c0000000000384c444444444c38000000"
    "0000784c444c784040400000000000384c444444444c380800000000784c4c4c7848444400000000003840407018044c"
    "780000000000fc1010101010101000000000004444444444444c380000000000c4444c48282838300000000000868694"
    "f47c6c6c4c00000000004468383038284cc40000000000c44c28301010101000000000007c0c08101020407c00000000"
    "383030303030303030380000000040402020101018080c00000030101010101010101030000000003028440000000000"
    "000000000000000000000000000000fe0020100000000000000000000000000000780c7c444c7c00000000404040786c"
    "44446c78000000000000003c604040603c000000000c0c0c3c4c4c4c4c3c0000000000000038447c40403c000000001c"
    "10107c1010101010000000000000003c4c4c4c4c3c0c780000404040786c444444440000000010000070101010107c00"
    "000000100000701010101010107000004040404c58707848440000000070303030303030301c00000000000000fcd4d4"
    "d4d4d400000000000000786c4444444400000000000000384c44444c3800000000000000786c44446c78404000000000"
    "003c4c44444c3c040400000000003c302020202000000000000000384070180c78000000000020207c202020301c0000"
    "0000000000444444444c3c00000000000000444c68283830000000000000008684d4746c68000000000000004c283030"
    "684400000000000000444c68283010306000000000007c081020207c000000001c10101060301010101c000000101010"
    "10101010101010100000601010101c10101030600000000000000000741c0000000000"
)
FONT = bytes.fromhex(_FONT_HEX)

# ---------------------------------------------------------------------------
# 主题 / 调色板（dark 与网页 CSS 变量对齐）
# ---------------------------------------------------------------------------
THEMES: Dict[str, Dict[str, Tuple[int, int, int]]] = {
    "dark": {
        "bg": (6, 10, 18),             # --bg #060a12
        "bg_top": (11, 18, 34),
        "panel_top": (14, 24, 42),      # rgba(14,24,42,.42) 叠加后的观感
        "panel_bottom": (8, 13, 24),
        "grid": (120, 150, 190),
        "text": (219, 231, 245),        # --text
        "muted": (127, 147, 173),       # --muted
        "muted2": (92, 112, 137),
        "axis": (120, 150, 190),
        "border": (27, 42, 68),         # --line
        "title": (248, 250, 252),
        "chip": (6, 11, 21),
        "zero": (190, 214, 240),
    },
    "light": {
        "bg": (243, 247, 252),
        "bg_top": (255, 255, 255),
        "panel_top": (255, 255, 255),
        "panel_bottom": (238, 244, 251),
        "grid": (120, 150, 190),
        "text": (30, 41, 59),
        "muted": (100, 116, 139),
        "muted2": (130, 145, 165),
        "axis": (148, 163, 184),
        "border": (203, 213, 225),
        "title": (15, 23, 42),
        "chip": (255, 255, 255),
        "zero": (100, 130, 165),
    },
}

PALETTE: List[Tuple[int, int, int]] = [
    (34, 211, 238), (245, 158, 11), (167, 139, 250), (52, 211, 153),
    (244, 114, 182), (96, 165, 250), (251, 113, 133), (250, 204, 21),
    (45, 212, 191), (192, 132, 252), (251, 146, 60), (74, 222, 128),
]

# 版面常量
MARGIN = 14
HEADER_H = 96
LEFT_TIME_W = 58          # 页面最左侧「0 起相对时间轴」占宽
Y_AXIS_W = 72             # pane 的 y 轴刻度占宽
RIGHT_AXIS_W = 66         # 存在 right 轴信号时预留
PANE_GAP = 8
BOTTOM_H = 49             # 底部绝对时间轴 + 页脚
X_MAJOR = 10              # 纵向主标尺格数
X_MINOR = 5               # 每个主格再分 5 个小格
Y_MINOR = 4               # 每个 y 主刻度再分 4 个小格


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _clamp(v: int, lo: int, hi: int) -> int:
    return lo if v < lo else hi if v > hi else v


def _mix(fg: Tuple[int, int, int], bg: Tuple[int, int, int], a: float) -> Tuple[int, int, int]:
    """把 fg 以 alpha=a 叠加到 bg 上。"""
    if a >= 0.999:
        return fg
    if a <= 0.001:
        return bg
    return (
        int(fg[0] * a + bg[0] * (1.0 - a) + 0.5),
        int(fg[1] * a + bg[1] * (1.0 - a) + 0.5),
        int(fg[2] * a + bg[2] * (1.0 - a) + 0.5),
    )


def _lerp(c0: Tuple[int, int, int], c1: Tuple[int, int, int], t: float) -> Tuple[int, int, int]:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return (
        int(c0[0] + (c1[0] - c0[0]) * t + 0.5),
        int(c0[1] + (c1[1] - c0[1]) * t + 0.5),
        int(c0[2] + (c1[2] - c0[2]) * t + 0.5),
    )


def _ascii(text: Any, limit: int = 0) -> str:
    s = "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in str(text or ""))
    if limit and len(s) > limit:
        s = s[:max(0, limit - 3)] + "..."
    return s


def _text_w(text: Any, scale: int = 1) -> int:
    return len(str(text or "")) * FONT_W * max(1, scale)


def _fmt_num(v: Optional[float]) -> str:
    if v is None or not math.isfinite(float(v)):
        return "--"
    v = float(v)
    a = abs(v)
    if a == 0.0:
        return "0"
    if a >= 1e9:
        s = "%.2fG" % (v / 1e9)
    elif a >= 1e6:
        s = "%.2fM" % (v / 1e6)
    elif a >= 1e4:
        s = "%.1fk" % (v / 1e3)
    elif a >= 1e3:
        s = "%.0f" % v
    elif a >= 100:
        s = "%.1f" % v
    elif a >= 10:
        s = "%.2f" % v
    elif a >= 1:
        s = "%.3f" % v
    elif a >= 0.01:
        s = "%.4f" % v
    elif a >= 1e-6:
        s = "%.6f" % v
    else:
        s = "%.2e" % v
    if "e" not in s and "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def _fmt_stat(v: Optional[float], span: Optional[float]) -> str:
    """统计值按量程决定小数位：小纹波也要能区分 min/max/avg。"""
    if v is None or not math.isfinite(float(v)):
        return "--"
    v = float(v)
    if span and math.isfinite(float(span)) and float(span) > 0:
        digits = int(math.ceil(-math.log10(float(span)))) + 2
        digits = max(0, min(9, digits))
        s = ("{0:,.%df}" % digits).format(v)
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s or "0"
    return _fmt_num(v)


def _fmt_axis(v: float) -> str:
    """网页 fmtAxis 的 Python 版：轴刻度用紧凑写法。"""
    if v is None or not math.isfinite(float(v)):
        return ""
    v = float(v)
    a = abs(v)
    if a >= 1e6:
        s = "%.1fM" % (v / 1e6)
    elif a >= 1e4:
        s = "%.1fk" % (v / 1e3)
    elif a >= 1000:
        s = "{:,.0f}".format(v)
    elif a >= 100:
        s = "%.0f" % v
    elif a >= 10:
        s = "%.1f" % v
    elif a >= 1:
        s = "%.2f" % v
    else:
        s = "%.3f" % v
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def _fmt_axis_prec(v: float, step: float) -> str:
    """按刻度间距决定小数位，避免 0 / 0.001 / 0.001 这种重复刻度。"""
    if step and 0.0 < abs(step) < 1e-4:
        # 极小的量程用科学计数法，避免 0.000012 这类标签顶到左侧时间轴
        if abs(v) < 1e-12:
            return "0"
        return "%.1e" % float(v)
    if step and 0.0 < abs(step) < 1.0:
        digits = int(math.ceil(-math.log10(abs(step)))) + 1
        digits = max(1, min(6, digits))
        s = ("{0:,.%df}" % digits).format(float(v))
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s or "0"
    return _fmt_axis(v)


def _fmt_t(ms: float, total_ms: float = 0.0) -> str:
    """按整个时间窗的长度选择统一格式，避免同一张图里 s / mm:ss 混用。"""
    s = float(ms) / 1000.0
    total_s = float(total_ms) / 1000.0
    if total_s >= 3600:
        h = int(s // 3600)
        m = int((s % 3600) // 60)
        return "T+%d:%02d:%05.2f" % (h, m, s % 60)
    if total_s >= 60:
        return "T+%d:%05.2f" % (int(s // 60), s % 60)
    return "T+%.3fs" % s


def _fmt_rel(ms: float, total_ms: float) -> str:
    """左侧纵向时间轴：0 起相对时间（顶部为 0）。"""
    if abs(ms) < 1e-9:
        return "0"
    s = float(ms) / 1000.0
    total_s = float(total_ms) / 1000.0
    if total_s >= 3600:
        return "%d:%02d:%02d" % (int(s // 3600), int((s % 3600) // 60), int(s % 60))
    if total_s >= 60:
        return "%d:%02d" % (int(s // 60), int(s % 60))
    if total_s >= 10:
        return "%.1fs" % s
    return "%.2fs" % s


def _fmt_wall(ms: Optional[float]) -> str:
    if ms is None or not math.isfinite(float(ms)):
        return ""
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(ms) / 1000.0))
    except Exception:
        return ""


def _parse_color(value: Any, fallback: Tuple[int, int, int]) -> Tuple[int, int, int]:
    s = str(value or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) == 6:
        try:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            pass
    return fallback


# ---------------------------------------------------------------------------
# 画布 / PNG
# ---------------------------------------------------------------------------
class Canvas:
    def __init__(self, width: int, height: int, bg: Tuple[int, int, int]) -> None:
        self.w = width
        self.h = height
        self.stride = width * 3
        self.buf = bytearray(bg) * (width * height)

    def px(self, x: int, y: int, color: Tuple[int, int, int], alpha: float = 1.0) -> None:
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        idx = (y * self.w + x) * 3
        if alpha >= 0.999:
            self.buf[idx:idx + 3] = bytes(color)
        elif alpha > 0.001:
            a = alpha
            self.buf[idx] = int(color[0] * a + self.buf[idx] * (1.0 - a) + 0.5)
            self.buf[idx + 1] = int(color[1] * a + self.buf[idx + 1] * (1.0 - a) + 0.5)
            self.buf[idx + 2] = int(color[2] * a + self.buf[idx + 2] * (1.0 - a) + 0.5)

    def hline(self, x0: int, x1: int, y: int, color: Tuple[int, int, int],
              t: int = 1, alpha: float = 1.0) -> None:
        if x0 > x1:
            x0, x1 = x1, x0
        x0, x1 = max(0, x0), min(self.w - 1, x1)
        if x0 > x1:
            return
        if alpha >= 0.999:
            row = bytes(color) * (x1 - x0 + 1)
            for yy in range(y, y + max(1, t)):
                if 0 <= yy < self.h:
                    start = yy * self.stride + x0 * 3
                    self.buf[start:start + len(row)] = row
            return
        for yy in range(y, y + max(1, t)):
            if 0 <= yy < self.h:
                for xx in range(x0, x1 + 1):
                    self.px(xx, yy, color, alpha)

    def vline(self, x: int, y0: int, y1: int, color: Tuple[int, int, int],
              t: int = 1, alpha: float = 1.0) -> None:
        if y0 > y1:
            y0, y1 = y1, y0
        y0, y1 = max(0, y0), min(self.h - 1, y1)
        if y0 > y1:
            return
        if alpha >= 0.999:
            col = bytes(color)
            for yy in range(y0, y1 + 1):
                start = yy * self.stride + x * 3
                for xx in range(x, x + max(1, t)):
                    if 0 <= xx < self.w:
                        s = yy * self.stride + xx * 3
                        self.buf[s:s + 3] = col
            return
        for yy in range(y0, y1 + 1):
            for xx in range(x, x + max(1, t)):
                self.px(xx, yy, color, alpha)

    def rect(self, x0: int, y0: int, x1: int, y1: int,
             color: Tuple[int, int, int], fill: bool = False, t: int = 1,
             alpha: float = 1.0) -> None:
        if x0 > x1:
            x0, x1 = x1, x0
        if y0 > y1:
            y0, y1 = y1, y0
        if fill:
            for yy in range(y0, y1 + 1):
                self.hline(x0, x1, yy, color, 1, alpha)
            return
        self.hline(x0, x1, y0, color, t, alpha)
        self.hline(x0, x1, y1, color, t, alpha)
        self.vline(x0, y0, y1, color, t, alpha)
        self.vline(x1, y0, y1, color, t, alpha)

    def line(self, x0: int, y0: int, x1: int, y1: int,
             color: Tuple[int, int, int], t: int = 2, alpha: float = 1.0) -> None:
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx - dy
        half = max(0, t // 2)
        while True:
            if t <= 1:
                self.px(x0, y0, color, alpha)
            else:
                self.rect(x0 - half, y0 - half, x0 + half, y0 + half,
                          color, fill=True, alpha=alpha)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x0 += sx
            if e2 < dx:
                err += dx
                y0 += sy

    def text(self, x: int, y: int, text: Any, color: Tuple[int, int, int],
             scale: int = 1, max_chars: int = 0, alpha: float = 1.0) -> int:
        s = _ascii(text)
        if max_chars and len(s) > max_chars:
            s = s[:max(0, max_chars - 3)] + "..."
        cx = x
        for ch in s:
            idx = ord(ch) - 32
            if 0 <= idx < 95:
                base = idx * FONT_H
                for gy in range(FONT_H):
                    bits = FONT[base + gy]
                    if not bits:
                        continue
                    for gx in range(FONT_W):
                        if bits & (1 << (FONT_W - 1 - gx)):
                            px = cx + gx * scale
                            py = y + gy * scale
                            if scale == 1:
                                self.px(px, py, color, alpha)
                            else:
                                self.rect(px, py, px + scale - 1, py + scale - 1,
                                          color, fill=True, alpha=alpha)
            cx += FONT_W * scale
        return cx

    def vgradient(self, x0: int, y0: int, x1: int, y1: int,
                  top: Tuple[int, int, int], bottom: Tuple[int, int, int]) -> None:
        span = max(1, y1 - y0)
        for yy in range(y0, y1 + 1):
            self.hline(x0, x1, yy, _lerp(top, bottom, (yy - y0) / span))


def _png_bytes(canvas: Canvas) -> bytes:
    raw = bytearray()
    stride = canvas.stride
    for y in range(canvas.h):
        raw.append(0)  # filter: none
        raw.extend(canvas.buf[y * stride:(y + 1) * stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", canvas.w, canvas.h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# 波形构建 / 绘制
# ---------------------------------------------------------------------------
def _trace_points(series: Sequence[Tuple[float, float]], xmap, ymap,
                  pw: int, step: bool) -> List[Tuple[int, int]]:
    """与网页 tracePoints 一致：点数不多时逐点；密集时按像素列取 min/max 包络。"""
    n = len(series)
    if n <= max(2, pw) * 2:
        return [(xmap(t), ymap(v)) for t, v in series]

    cols = pw + 1
    x_first = xmap(series[0][0])
    if step:
        last: List[Optional[float]] = [None] * cols
        for t, v in series:
            last[_clamp(xmap(t) - x_first, 0, pw)] = v
        return [(x_first + col, ymap(v))
                for col, v in enumerate(last) if v is not None]

    bmin: List[Optional[float]] = [None] * cols
    bmax: List[Optional[float]] = [None] * cols
    bmin_t: List[Optional[float]] = [None] * cols
    bmax_t: List[Optional[float]] = [None] * cols
    x0 = x_first
    for t, v in series:
        col = _clamp(xmap(t) - x0, 0, pw)
        if bmin[col] is None or v < bmin[col]:  # type: ignore[operator]
            bmin[col] = v
            bmin_t[col] = t
        if bmax[col] is None or v > bmax[col]:  # type: ignore[operator]
            bmax[col] = v
            bmax_t[col] = t
    pts: List[Tuple[int, int]] = []
    for col in range(cols):
        mn, mx = bmin[col], bmax[col]
        if mn is None or mx is None:
            continue
        x = x0 + col
        if (bmin_t[col] or 0.0) <= (bmax_t[col] or 0.0):
            pts.append((x, ymap(mn)))
            pts.append((x, ymap(mx)))
        else:
            pts.append((x, ymap(mx)))
            pts.append((x, ymap(mn)))
    return pts


def _trace_top(series: Sequence[Tuple[float, float]], xmap, ymap, pw: int,
               step: bool, pts: Sequence[Tuple[int, int]], bottom: int,
               dense: bool) -> List[int]:
    """填充用的每列顶边（屏幕 y）；无数据列给 bottom+1。"""
    cols = pw + 1
    top = [bottom + 1] * cols
    x0 = xmap(series[0][0]) if series else 0
    if dense:
        for t, v in series:
            col = _clamp(xmap(t) - x0, 0, pw)
            y = ymap(v)
            if step:
                top[col] = y
            elif top[col] > bottom or y < top[col]:
                top[col] = y
        # 空缺列向前补，避免填充带出现梳齿
        prev = bottom + 1
        for col in range(cols):
            if top[col] > bottom:
                top[col] = prev
            else:
                prev = top[col]
        return top

    if not pts:
        return top
    prev = pts[0]
    xa = _clamp(prev[0] - x0, 0, pw)
    for xx in range(0, xa + 1):
        top[xx] = prev[1]
    for cur in pts[1:]:
        xa = _clamp(prev[0] - x0, 0, pw)
        xb = _clamp(cur[0] - x0, 0, pw)
        ya, yb = prev[1], cur[1]
        if xb <= xa:
            if ya < top[xa]:
                top[xa] = ya
            if yb < top[xa]:
                top[xa] = yb
        elif step:
            for xx in range(xa, xb):
                if ya < top[xx]:
                    top[xx] = ya
            if yb < top[xb]:
                top[xb] = yb
        else:
            for xx in range(xa, xb + 1):
                yy = int(round(ya + (yb - ya) * ((xx - xa) / (xb - xa))))
                if yy < top[xx]:
                    top[xx] = yy
        prev = cur
    xa = _clamp(prev[0] - x0, 0, pw)
    for xx in range(xa, pw + 1):
        top[xx] = prev[1]
    return top


def _draw_trace(c: Canvas, pts: Sequence[Tuple[int, int]], color: Tuple[int, int, int],
                step: bool, thickness: int = 2, alpha: float = 1.0) -> None:
    if not pts:
        return
    if step:
        prev = pts[0]
        for cur in pts[1:]:
            c.hline(prev[0], cur[0], prev[1], color, thickness, alpha)
            c.vline(cur[0], prev[1], cur[1], color, thickness, alpha)
            prev = cur
        return
    prev = pts[0]
    for cur in pts[1:]:
        c.line(prev[0], prev[1], cur[0], cur[1], color, thickness, alpha)
        prev = cur


def _fill_under(c: Canvas, x0: int, top: Sequence[int], pane_top: int, pane_h: int,
                color: Tuple[int, int, int], bg_top: Tuple[int, int, int],
                bg_bottom: Tuple[int, int, int], alpha: float = 0.14) -> None:
    """网页 fillOn 的面积渐变：pane 顶部 14% → 底部 0。"""
    cols = len(top)
    for yy in range(pane_top, pane_top + pane_h + 1):
        ratio = (yy - pane_top) / max(1, pane_h)
        a = alpha * (1.0 - ratio)
        if a < 0.004:
            continue
        col = _mix(color, _lerp(bg_top, bg_bottom, ratio), a)
        xx = 0
        while xx < cols:
            if top[xx] <= yy:
                start = xx
                while xx < cols and top[xx] <= yy:
                    xx += 1
                c.hline(x0 + start, x0 + xx - 1, yy, col)
            else:
                xx += 1


def _dashed_hline(c: Canvas, x0: int, x1: int, y: int,
                  color: Tuple[int, int, int], alpha: float = 1.0,
                  dash: int = 5, gap: int = 4) -> None:
    x = x0
    while x <= x1:
        c.hline(x, min(x1, x + dash - 1), y, color, 1, alpha)
        x += dash + gap


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def render(signals: Sequence[Dict[str, Any]], samples: Sequence[Sequence[Any]], *,
           width: int = 1200, height: Optional[int] = None,
           theme: str = "dark", title: str = "",
           profile: str = "", mcu: str = "",
           wall_start_ms: Optional[float] = None,
           max_channels: int = 12,
           sample_rate: Optional[float] = None,
           generated_at: str = "") -> Dict[str, Any]:
    """渲染多通道波形截图（网页 canvas 风格），返回 {png, width, height, ...}。"""
    if not samples:
        raise ValueError("没有样本可绘制")
    if not signals:
        raise ValueError("没有可绘制的信号")

    n = min(len(signals), max(1, int(max_channels)))
    signals = list(signals[:n])
    rows: List[Sequence[Any]] = []
    for row in samples:
        rows.append([row[0], list(row[1][:n])])
    t0 = float(rows[0][0])
    t1 = float(rows[-1][0])
    if t1 <= t0:
        t1 = t0 + 1.0
    width = _clamp(int(width or 1200), 480, 2400)
    theme = theme if theme in THEMES else "dark"
    th = THEMES[theme]

    # 每通道统计 / y 轴范围 / 颜色
    stats: List[Dict[str, Any]] = []
    series_all: List[List[Tuple[float, float]]] = []
    for j, sig in enumerate(signals):
        scale = float(sig.get("scale") or 1.0)
        offset = float(sig.get("offset") or 0.0)
        vals: List[float] = []
        series: List[Tuple[float, float]] = []
        for row in rows:
            if j >= len(row[1]):
                continue
            raw = row[1][j]
            if raw is None:
                continue
            v = float(raw) * scale + offset
            if math.isfinite(v):
                vals.append(v)
                series.append((float(row[0]), v))
        series_all.append(series)
        if vals:
            vmin, vmax = min(vals), max(vals)
            avg = sum(vals) / len(vals)
        else:
            vmin, vmax, avg = 0.0, 1.0, None
        lo, hi = vmin, vmax
        if hi - lo < 1e-12:
            pad = max(abs(hi) * 0.05, 1.0)
            lo, hi = lo - pad, hi + pad
        else:
            pad = (hi - lo) * 0.08
            lo, hi = lo - pad, hi + pad
            if vmin >= 0.0 and lo < 0.0:
                lo = 0.0
        stats.append({
            "index": j,
            "id": str(sig.get("id") or sig.get("name") or ""),
            "name": str(sig.get("name") or sig.get("id") or ""),
            "unit": str(sig.get("unit") or ""),
            "scale": scale, "offset": offset,
            "step": bool(sig.get("step")),
            "axis": "right" if str(sig.get("axis") or "") == "right" else "left",
            "color": str(sig.get("color") or ""),
            "min": vmin if vals else None,
            "max": vmax if vals else None,
            "avg": avg,
            "count": len(vals),
            "empty": not vals,
            "_lo": lo, "_hi": hi,
        })

    # 版面
    n_ch = len(stats)
    if height:
        total_h = _clamp(int(height), 300, 4000)
        avail = total_h - HEADER_H - BOTTOM_H - PANE_GAP * max(0, n_ch - 1)
        pane_h = max(44, avail // max(1, n_ch))
    else:
        pane_h = 92 if n_ch <= 6 else 84
    if height:
        total_h = max(total_h, HEADER_H + BOTTOM_H + n_ch * pane_h + PANE_GAP * max(0, n_ch - 1))
    else:
        total_h = HEADER_H + BOTTOM_H + n_ch * pane_h + PANE_GAP * max(0, n_ch - 1)

    any_right = any(st["axis"] == "right" for st in stats)
    right_w = RIGHT_AXIS_W if any_right else 0
    x0 = MARGIN + LEFT_TIME_W + Y_AXIS_W
    x1 = width - MARGIN - right_w
    pw = max(20, x1 - x0)
    y0 = HEADER_H
    last_bottom = y0 + n_ch * pane_h + PANE_GAP * max(0, n_ch - 1)
    axis_y = last_bottom + 8
    total_h = max(total_h, axis_y + 21 + 20)
    last_bottom = min(last_bottom, total_h - BOTTOM_H)

    c = Canvas(width, total_h, th["bg"])
    c.vgradient(0, 0, width - 1, total_h - 1, th["bg_top"], th["bg"])

    # ---- 顶部信息 ----
    max_title = max(8, (width - MARGIN * 2) // (FONT_W * 2))
    c.text(MARGIN, 12, _ascii(title or "MotorScope waveform", max_title),
           th["title"], 2)
    hz = (" | ~%.0f Hz" % float(sample_rate)) if sample_rate else ""
    max_line = max(16, (width - MARGIN * 2) // FONT_W)
    line1 = _ascii("profile: %s | mcu: %s | channels: %d | samples: %d%s" % (
        profile or "-", mcu or "-", n_ch, len(rows), hz), max_line)
    c.text(MARGIN, 48, line1, th["text"], 1)
    dur = (t1 - t0) / 1000.0
    line2 = _ascii(
        "range: %s .. %s (%.3fs) | time axes: bottom T+ (abs) + left 0..%.3fs (rel)"
        " | grid %dx%d | %dx%d" % (
            _fmt_t(t0, t1 - t0), _fmt_t(t1, t1 - t0), dur, dur,
            X_MAJOR, X_MINOR, width, total_h), max_line)
    c.text(MARGIN, 64, line2, th["muted"], 1)
    if wall_start_ms is not None:
        line3 = "wall: %s .. %s" % (_fmt_wall(wall_start_ms + t0),
                                     _fmt_wall(wall_start_ms + t1))
        c.text(MARGIN, 80, _ascii(line3, max_line), th["muted2"], 1)
    c.hline(MARGIN, width - MARGIN, HEADER_H - 8, th["border"], 1, alpha=0.9)

    accent = (34, 211, 238)
    c.hline(MARGIN, width - MARGIN, HEADER_H - 7, accent, 1, alpha=0.10)

    # ---- pane 背景 ----
    panel_mid = _lerp(th["panel_top"], th["panel_bottom"], 0.5)
    pane_tops: List[int] = []
    for i, st in enumerate(stats):
        top = y0 + i * (pane_h + PANE_GAP)
        pane_tops.append(top)
        c.vgradient(x0, top, x0 + pw, top + pane_h, th["panel_top"], th["panel_bottom"])

    # ---- 纵向标尺（主/次网格 + 顶部/底部刻度）----
    grid_major_a = 0.085 if theme == "dark" else 0.10
    grid_minor_a = 0.040 if theme == "dark" else 0.055
    x_total = X_MAJOR * X_MINOR
    for i in range(1, x_total):
        x = x0 + int(round(pw * i / x_total))
        a = grid_major_a if i % X_MINOR == 0 else grid_minor_a
        for top in pane_tops:
            c.vline(x, top + 1, top + pane_h - 1, th["grid"], 1, alpha=a)
    for i in range(0, x_total + 1):
        x = x0 + int(round(pw * i / x_total))
        length = 4 if i % X_MINOR == 0 else 2
        c.vline(x, y0 - length, y0 - 1, th["axis"], 1, alpha=0.45)
        c.vline(x, axis_y, axis_y + length - 1, th["axis"], 1, alpha=0.55)

    # ---- 每个 pane：横向标尺、面积、波形、标题、y 轴 ----
    span = max(1e-9, t1 - t0)
    stat_color = _mix(th["muted"], panel_mid, 0.88)
    label_color = _mix(th["muted"], panel_mid, 0.90)
    tick_color = _mix(th["axis"], panel_mid, 0.55)

    for i, st in enumerate(stats):
        top = pane_tops[i]
        bottom = top + pane_h
        sig = signals[i]
        color = _parse_color(sig.get("color"), PALETTE[i % len(PALETTE)])
        series = series_all[i]
        lo, hi = float(st["_lo"]), float(st["_hi"])

        def xmap(t: float, _x0=x0, _pw=pw, _t0=t0, _span=span) -> int:
            return _x0 + _clamp(int(round((t - _t0) / _span * _pw)), 0, _pw)

        def ymap(v: float, _top=top, _ph=pane_h, _lo=lo, _hi=hi) -> int:
            y = _top + _ph - int(round((v - _lo) / (_hi - _lo if _hi > _lo else 1.0) * _ph))
            return _clamp(y, _top, _top + _ph)

        # 横向标尺：主刻度 + 4 个次刻度
        ticks = _clamp(int(round(pane_h / 24.0)), 2, 6)
        for ti in range(ticks + 1):
            ratio = ti / ticks
            yy = bottom - int(round(ratio * pane_h))
            c.hline(x0, x0 + pw, yy, th["grid"], 1, alpha=grid_major_a)
            for sub in range(1, Y_MINOR):
                ysub = bottom - int(round((ratio + sub / (ticks * Y_MINOR)) * pane_h))
                if ysub > top:
                    c.hline(x0 + 1, x0 + pw - 1, ysub, th["grid"], 1,
                            alpha=grid_minor_a * 0.85)
        for ti in range(ticks * Y_MINOR + 1):
            yy = bottom - int(round((ti / (ticks * Y_MINOR)) * pane_h))
            major = ti % Y_MINOR == 0
            length = 4 if major else 2
            c.hline(x0 - length, x0 - 1, yy, tick_color, 1)
            c.hline(x0 + pw + 1, x0 + pw + length, yy, tick_color, 1)

        # 0 参考线（跨越 0 时）
        if lo < 0.0 < hi:
            zero_y = ymap(0.0)
            _dashed_hline(c, x0 + 1, x0 + pw - 1, zero_y,
                          th["zero"], alpha=0.30, dash=3, gap=4)

        if not st["empty"]:
            pts = _trace_points(series, xmap, ymap, pw, bool(st["step"]))
            dense = len(series) > max(2, pw) * 2
            fill_top = _trace_top(series, xmap, ymap, pw, bool(st["step"]),
                                  pts, bottom, dense)
            if pts:
                _fill_under(c, x0, fill_top, top, pane_h, color,
                            th["panel_top"], th["panel_bottom"], 0.15)
                if not dense:
                    glow = _mix(color, panel_mid, 0.13)
                    _draw_trace(c, pts, glow, bool(st["step"]), 5)
                _draw_trace(c, pts, color, bool(st["step"]), 2)

        # pane 边框（左 + 下，与网页一致）
        c.hline(x0, x0 + pw, bottom, th["border"], 1, alpha=0.9)
        c.vline(x0, top, bottom, th["border"], 1, alpha=0.9)

        # y 轴刻度文字
        ystep = (hi - lo) / max(1, ticks)
        for ti in range(ticks + 1):
            ratio = ti / ticks
            v = lo + (hi - lo) * ratio
            label = _fmt_axis_prec(v, ystep)
            if not label:
                continue
            yy = bottom - int(round(ratio * pane_h)) - 6
            yy = _clamp(yy, top, bottom - FONT_H)
            if st["axis"] == "right":
                c.text(x0 + pw + 8, yy, label, label_color, 1)
            else:
                c.text(x0 - 8 - _text_w(label), yy, label, label_color, 1)

        # pane 标题条（信号色）+ 统计
        name = st["name"] or st["id"] or ("ch%d" % i)
        subtitle = name + ((" [" + st["unit"] + "]") if st["unit"] else "")
        stat_span = ((st["max"] - st["min"])
                     if st["min"] is not None and st["max"] is not None else None)
        stats_text = "min %s  max %s  avg %s" % (
            _fmt_stat(st["min"], stat_span), _fmt_stat(st["max"], stat_span),
            _fmt_stat(st["avg"], stat_span))
        chip_bg = _mix(th["chip"], th["panel_top"], 0.72)
        chip_w = min(pw - 8, max(48, _text_w(subtitle) + 12))
        c.rect(x0 + 4, top + 3, x0 + 4 + chip_w, top + 17, chip_bg, fill=True)
        max_chars = max(4, (chip_w - 8) // FONT_W)
        c.text(x0 + 8, top + 5, subtitle, color, 1, max_chars=max_chars)
        stats_x = x0 + pw - 4 - _text_w(stats_text)
        if stats_x > x0 + 8 + chip_w + 8:
            c.rect(stats_x - 5, top + 3, stats_x + _text_w(stats_text) + 2, top + 17,
                   chip_bg, fill=True)
            c.text(stats_x, top + 5, stats_text, stat_color, 1, max_chars=48)
        if i < n_ch - 1:
            c.hline(MARGIN, width - MARGIN, bottom + PANE_GAP // 2,
                    th["grid"], 1, alpha=0.05)

    # ---- 左侧：0 起相对时间轴（从顶部 0 向下递增）----
    lx = MARGIN + LEFT_TIME_W - 6
    c.vline(lx, y0, last_bottom, th["axis"], 1, alpha=0.75)
    for i in range(0, X_MAJOR * X_MINOR + 1):
        ratio = i / (X_MAJOR * X_MINOR)
        yy = y0 + int(round(ratio * (last_bottom - y0)))
        major = i % X_MINOR == 0
        length = 5 if major else 2
        c.hline(lx - length, lx - 1, yy, th["axis"], 1, alpha=0.65)
        if major:
            label = _fmt_rel(ratio * (t1 - t0), t1 - t0)
            lcolor = th["text"] if i == 0 else _mix(th["muted"], th["bg"], 0.92)
            c.text(lx - 8 - _text_w(label), yy - 6, label, lcolor, 1)

    # ---- 底部：原来的绝对时间轴（T+）----
    c.hline(x0, x0 + pw, axis_y, th["axis"], 1, alpha=0.75)
    for i in range(0, X_MAJOR * X_MINOR + 1):
        x = x0 + int(round(pw * i / (X_MAJOR * X_MINOR)))
        length = 5 if i % X_MINOR == 0 else 2
        c.vline(x, axis_y, axis_y + length - 1, th["axis"], 1, alpha=0.7)
    labels: List[str] = []
    for i in range(0, X_MAJOR + 1):
        ratio = i / X_MAJOR
        t = t0 + (t1 - t0) * ratio
        labels.append(_fmt_t(t, t1 - t0))
    max_lw = max(_text_w(x) for x in labels) if labels else 0
    slot = pw / X_MAJOR
    lstep = max(1, int(math.ceil((max_lw + 14) / max(1.0, slot))))
    for i, label in enumerate(labels):
        if i % lstep:
            continue
        x = x0 + int(round(pw * i / X_MAJOR))
        tw = _text_w(label)
        lx2 = _clamp(x - tw // 2, 2, width - tw - 2)
        c.text(lx2, axis_y + 8, label, _mix(th["muted"], th["bg"], 0.92), 1)

    # ---- 页脚 ----
    foot = "MotorScope /api/screenshot | %s | generated %s" % (
        "web-style panes", generated_at or time.strftime("%Y-%m-%d %H:%M:%S"))
    c.text(MARGIN, total_h - 17, _ascii(foot, max(20, (width - MARGIN * 2) // FONT_W)),
           th["muted2"], 1)

    png = _png_bytes(c)
    out_stats = []
    for st in stats:
        st2 = {k: v for k, v in st.items() if not k.startswith("_")}
        out_stats.append(st2)
    return {
        "png": png,
        "width": width,
        "height": total_h,
        "theme": theme,
        "layout": "web-panes",
        "sample_count": len(rows),
        "channels": n_ch,
        "range": {
            "start_ms": t0,
            "end_ms": t1,
            "duration_ms": t1 - t0,
            "start_wall_ms": (wall_start_ms + t0) if wall_start_ms is not None else None,
            "end_wall_ms": (wall_start_ms + t1) if wall_start_ms is not None else None,
        },
        "axes": {
            "bottom": {"kind": "absolute", "start_ms": t0, "end_ms": t1},
            "left": {"kind": "relative", "start_ms": 0.0, "end_ms": t1 - t0},
            "x_major": X_MAJOR,
            "x_minor": X_MINOR,
            "y_ticks_per_pane": _clamp(int(round(pane_h / 24.0)), 2, 6),
            "y_minor": Y_MINOR,
        },
        "signals": out_stats,
        "profile": profile,
        "mcu": mcu,
        "generated_at": generated_at or time.strftime("%Y-%m-%d %H:%M:%S"),
    }
