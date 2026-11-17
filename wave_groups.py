#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""波形分组（wave groups）的纯逻辑：分组增删改、把已选波形加入分组、按变量名生成颜色。

只操作前端保存的 config 字典（``profiles/<ID>/config.json`` 的 ``config`` 部分），
不读写文件、不依赖 HTTP，方便单测。

config 里的相关结构::

    {
      "wave": {"seq": 6, "groups": [
          {"id": "default", "name": "默认分组", "visible": true, "auto": true},
          {"id": "wg2", "name": "电流环", "visible": true, "auto": false}
      ]},
      "rows": [
          {"id": "motor.over.current", "name": "motor.over.current",
           "plot": true, "table": false, "groupId": "wg2", "color": "#22d3ee"}
      ]
    }

约定：
  * ``default`` 分组永远存在且排第一，不能删除；没有 groupId 的行归 default；
  * 只有 ``plot: true`` 的行算「已选择波形」；显式点名加入的行会被提升为 plot；
  * 颜色默认按变量名 hash 生成（同名永远同色），显式传入的 color 优先。
"""
from __future__ import annotations

import colorsys
import hashlib
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

DEFAULT_ID = "default"
DEFAULT_NAME = "默认分组"
MAX_NAME = 32
MAX_GROUPS = 64
MAX_SIGNALS = 256

_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_WG_ID_RE = re.compile(r"^wg(\d+)$")


# --------------------------------------------------------------------------
# 颜色
# --------------------------------------------------------------------------
def signal_color(name: str) -> str:
    """按变量名生成稳定颜色（SHA-1 -> 色相，固定饱和度/亮度区间）。

    同一变量名在任何机器、任何次运行都得到同一个 #rrggbb；不同变量名
    大概率色相不同。用于 API 添加波形时的默认上色。
    """
    text = str(name or "")
    digest = hashlib.sha1(text.encode("utf-8")).digest()
    hue = ((digest[0] << 8) | digest[1]) % 360
    sat = 0.62 + (digest[2] % 11) / 100.0
    light = 0.52 + (digest[3] % 9) / 100.0
    r, g, b = colorsys.hls_to_rgb(hue / 360.0, light, sat)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def normalize_color(raw: Any) -> str:
    """校验并规范化 #RGB/#RRGGBB（允许省略 #）；非法抛 ValueError。"""
    text = str(raw or "").strip()
    if not text:
        raise ValueError("颜色不能为空")
    if not text.startswith("#"):
        text = "#" + text
    if not _HEX_RE.fullmatch(text):
        raise ValueError("颜色格式应为 #RGB 或 #RRGGBB: %s" % raw)
    return text.lower()


# --------------------------------------------------------------------------
# config 归一化
# --------------------------------------------------------------------------
def _cfg(cfg: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(cfg, dict):
        raise ValueError("config 必须是对象")
    return cfg


def _clean_name(raw: Any, default: str = "") -> str:
    text = _CTRL_RE.sub("", str(raw or "")).strip()
    if not text:
        text = str(default or "").strip()
    return text[:MAX_NAME]


def _groups(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """取出/修正 wave.groups；保证 default 存在且第一。会原地修改 cfg。"""
    wave = cfg.get("wave")
    if not isinstance(wave, dict):
        wave = {}
        cfg["wave"] = wave
    raw = wave.get("groups")
    if not isinstance(raw, list):
        raw = []
    cleaned: List[Dict[str, Any]] = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("id") or "").strip()
        if not gid or gid in seen or len(cleaned) >= MAX_GROUPS:
            continue
        seen.add(gid)
        cleaned.append({
            "id": gid,
            "name": _clean_name(item.get("name"),
                                DEFAULT_NAME if gid == DEFAULT_ID else gid),
            "visible": item.get("visible") is not False,
            "auto": bool(item.get("auto")),
        })
    default = next((g for g in cleaned if g["id"] == DEFAULT_ID), None)
    if default is None:
        default = {"id": DEFAULT_ID, "name": DEFAULT_NAME, "visible": True, "auto": True}
        cleaned.insert(0, default)
    else:
        cleaned.remove(default)
        cleaned.insert(0, default)
        if not default.get("name"):
            default["name"] = DEFAULT_NAME
        default["auto"] = True
    wave["groups"] = cleaned
    # seq 至少覆盖已有 wgN，避免新建时撞 id
    seq = 1
    try:
        seq = max(1, int(wave.get("seq") or 1))
    except (TypeError, ValueError):
        seq = 1
    for g in cleaned:
        m = _WG_ID_RE.match(g["id"])
        if m:
            seq = max(seq, int(m.group(1)))
    wave["seq"] = seq
    return cleaned


def _rows(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = cfg.get("rows")
    if not isinstance(rows, list):
        rows = []
        cfg["rows"] = rows
    out: List[Dict[str, Any]] = []
    for item in rows:
        if isinstance(item, dict) and str(item.get("id") or "").strip():
            out.append(item)
    return out


def normalize(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """原地归一化分组/行归属；返回 cfg，方便链式调用。"""
    cfg = _cfg(cfg)
    groups = _groups(cfg)
    ids = {g["id"] for g in groups}
    for row in _rows(cfg):
        gid = str(row.get("groupId") or "").strip()
        row["groupId"] = gid if gid in ids else DEFAULT_ID
    return cfg


# --------------------------------------------------------------------------
# 查询
# --------------------------------------------------------------------------
def snapshot(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """返回分组 + 已选择波形（plot/table 行）的只读快照。"""
    normalize(cfg)
    groups = _groups(cfg)
    rows = _rows(cfg)
    counts = {g["id"]: 0 for g in groups}
    selected: List[Dict[str, Any]] = []
    for row in rows:
        gid = row.get("groupId") or DEFAULT_ID
        if not (row.get("plot") or row.get("table")):
            continue
        if gid in counts:
            counts[gid] += 1
        selected.append({
            "id": str(row.get("id")),
            "name": str(row.get("name") or row.get("id")),
            "plot": bool(row.get("plot")),
            "table": bool(row.get("table")),
            "groupId": gid,
            "color": str(row.get("color") or ""),
        })
    return {
        "groups": [dict(g, count=counts.get(g["id"], 0)) for g in groups],
        "selected": selected,
        "count": len(selected),
        "waveforms": sum(1 for r in selected if r["plot"]),
        "default": DEFAULT_ID,
    }


# --------------------------------------------------------------------------
# 分组操作
# --------------------------------------------------------------------------
def _find_group(groups: List[Dict[str, Any]], gid: str) -> Dict[str, Any]:
    gid = str(gid or "").strip()
    if not gid:
        raise ValueError("缺少分组 id")
    for g in groups:
        if g["id"] == gid:
            return g
    raise ValueError("未知分组: %s" % gid)


def _unique_name(groups: List[Dict[str, Any]], name: str, exclude: str = "") -> None:
    low = name.casefold()
    for g in groups:
        if g["id"] != exclude and str(g.get("name") or "").casefold() == low:
            raise ValueError("分组名已存在: %s" % name)


def _next_id(cfg: Dict[str, Any], groups: List[Dict[str, Any]]) -> Tuple[str, int]:
    wave = cfg.setdefault("wave", {})
    try:
        seq = int(wave.get("seq") or 0) + 1
    except (TypeError, ValueError):
        seq = 1
    used = {g["id"] for g in groups}
    while ("wg%d" % seq) in used:
        seq += 1
    wave["seq"] = seq
    return "wg%d" % seq, seq


def _parse_specs(raw: Any, colors: Any = None,
                 default_color: Any = None) -> List[Dict[str, str]]:
    """把 signals 参数解析成 [{"id": ..., "color": ...}]，去重保序。"""
    specs: List[Dict[str, str]] = []
    if isinstance(raw, dict):
        items: Iterable[Any] = [{"id": k, "color": v} for k, v in raw.items()]
    elif isinstance(raw, list):
        items = raw
    elif isinstance(raw, str):
        items = [raw]
    elif raw is None:
        items = []
    else:
        raise ValueError("signals 必须是数组或 {信号: 颜色} 对象")
    color_map = colors if isinstance(colors, dict) else {}
    seen = set()
    for item in items:
        if len(specs) >= MAX_SIGNALS:
            break
        if isinstance(item, str):
            sid, color = item.strip(), ""
        elif isinstance(item, dict):
            sid = str(item.get("id") or item.get("name") or item.get("signal") or "").strip()
            color = item.get("color")
        else:
            continue
        if not sid or sid in seen:
            continue
        seen.add(sid)
        if color is None or str(color).strip() == "":
            color = color_map.get(sid)
        if (color is None or str(color).strip() == "") and default_color:
            color = default_color
        spec = {"id": sid}
        if color is not None and str(color).strip():
            spec["color"] = normalize_color(color)
        specs.append(spec)
    return specs


def _assign(cfg: Dict[str, Any], gid: str, specs: List[Dict[str, str]],
            recolor: bool = True) -> Dict[str, Any]:
    rows = _rows(cfg)
    by_id = {str(r.get("id")): r for r in rows}
    by_name: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        name = str(r.get("name") or "")
        if name and name not in by_name:
            by_name[name] = r
    group = _find_group(_groups(cfg), gid)
    if group.get("visible") is False:
        group["visible"] = True
    added: List[str] = []
    skipped: List[Dict[str, str]] = []
    colors: Dict[str, str] = {}
    seen = set()
    for spec in specs:
        sid = spec["id"]
        row = by_id.get(sid) or by_name.get(sid)
        if row is None:
            skipped.append({"id": sid, "reason": "尚未选择该波形（不在当前 config.rows 中）"})
            continue
        rid = str(row.get("id"))
        if rid in seen:
            continue
        seen.add(rid)
        explicit = spec.get("color")
        if explicit:
            row["color"] = explicit
        elif recolor or not row.get("color"):
            row["color"] = signal_color(str(row.get("name") or rid))
        row["groupId"] = gid
        row["plot"] = True
        added.append(rid)
        colors[rid] = str(row.get("color") or "")
    return {"added": added, "skipped": skipped, "colors": colors}


def _finish(cfg: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    out = snapshot(cfg)
    extra = dict(extra or {})
    group = extra.get("group")
    if isinstance(group, dict):
        for item in out["groups"]:
            if item["id"] == group.get("id"):
                extra["group"] = item
                break
    out.update(extra)
    return out


def create(cfg: Dict[str, Any], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """新建分组；可选把 signals 一并加入。"""
    payload = payload if isinstance(payload, dict) else {}
    normalize(cfg)
    groups = _groups(cfg)
    if len(groups) >= MAX_GROUPS:
        raise ValueError("分组数量已达上限 %d" % MAX_GROUPS)
    gid, seq = _next_id(cfg, groups)
    name = _clean_name(payload.get("name"), "分组 %d" % seq)
    # 未命名时避免重名：分组 N / 分组 N-2 ...
    if not str(payload.get("name") or "").strip():
        base = name
        n = 2
        while any(g["name"].casefold() == name.casefold() for g in groups):
            name = "%s-%d" % (base, n)
            n += 1
    _unique_name(groups, name)
    group = {"id": gid, "name": name, "visible": True, "auto": False}
    groups.append(group)
    result: Dict[str, Any] = {"group": dict(group), "added": [], "skipped": [], "colors": {}}
    raw = payload.get("signals")
    if raw not in (None, "", [], {}):
        specs = _parse_specs(raw, payload.get("colors"), payload.get("color"))
        if specs:
            result.update(_assign(cfg, gid, specs,
                                  recolor=payload.get("recolor", True) is not False))
    return _finish(cfg, result)


def rename(cfg: Dict[str, Any], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """重命名分组。payload: {"id": "wg2", "name": "电流环"}"""
    payload = payload if isinstance(payload, dict) else {}
    normalize(cfg)
    groups = _groups(cfg)
    group = _find_group(groups, payload.get("id") or payload.get("group"))
    name = _clean_name(payload.get("name"))
    if not name:
        raise ValueError("分组名不能为空")
    _unique_name(groups, name, exclude=group["id"])
    group["name"] = name
    return _finish(cfg, {"group": dict(group)})


def add(cfg: Dict[str, Any], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """把波形加入分组。

    payload::

        {"id": "wg2"}                       # 默认加入所有已选择波形
        {"id": "wg2", "signals": ["a", "b"]}
        {"id": "wg2", "signals": [{"id": "a", "color": "#ff8800"}]}
        {"id": "wg2", "signals": ["a"], "colors": {"a": "#ff8800"}}
        {"id": "wg2", "recolor": false}     # 保留已有颜色
    """
    payload = payload if isinstance(payload, dict) else {}
    normalize(cfg)
    group = _find_group(_groups(cfg), payload.get("id") or payload.get("group"))
    raw = payload.get("signals")
    if raw is None:
        specs = [{"id": str(r.get("id"))} for r in _rows(cfg)
                 if r.get("plot") and str(r.get("groupId") or DEFAULT_ID) != group["id"]]
        if not specs:
            raise ValueError("当前没有可加入的已选择波形")
    else:
        specs = _parse_specs(raw, payload.get("colors"), payload.get("color"))
        if not specs:
            raise ValueError("signals 不能为空")
    result = _assign(cfg, group["id"], specs,
                     recolor=payload.get("recolor", True) is not False)
    if not result["added"]:
        reasons = "; ".join("%s: %s" % (x["id"], x["reason"]) for x in result["skipped"][:3])
        raise ValueError("没有波形加入分组" + ("（%s）" % reasons if reasons else ""))
    result["group"] = dict(group)
    return _finish(cfg, result)


def delete(cfg: Dict[str, Any], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """删除分组，组内波形回到默认分组；默认分组不可删。"""
    payload = payload if isinstance(payload, dict) else {}
    normalize(cfg)
    groups = _groups(cfg)
    group = _find_group(groups, payload.get("id") or payload.get("group"))
    if group["id"] == DEFAULT_ID:
        raise ValueError("默认分组不能删除")
    gid = group["id"]
    for row in _rows(cfg):
        if str(row.get("groupId") or "") == gid:
            row["groupId"] = DEFAULT_ID
    groups.remove(group)
    return _finish(cfg, {"deleted": gid})


__all__ = [
    "DEFAULT_ID", "DEFAULT_NAME", "signal_color", "normalize_color",
    "normalize", "snapshot", "create", "rename", "add", "delete",
]
