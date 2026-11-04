#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机型工程（profile）存储.

一个 profile = 一套「符号表 + 芯片/寄存器 + 连接参数 + 前端配置」:

    profiles/
      index.json            机型列表与当前激活项
      <ID>/profile.json     机型元数据（AXF/SVD/目标 CFG/RAM 范围/默认信号）
      <ID>/signals.json     该机型的符号目录（gen_signals 生成）
      <ID>/config.json      前端工程配置快照（自动/手动保存）

设计要点:
  * 机型目录自带 signals.json，切换机型不依赖浏览器 localStorage；
  * config.json 只存前端快照，服务器不解释内容；
  * 全部路径可以是 Windows 风格，在 WSL/Linux 下自动映射到 /mnt/<drive>/...。
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "profiles")
SCHEMA = 1

# 默认机型。source 里的路径按当前开发机填写，换取其它机器时改这里或改
# profiles/<ID>/profile.json（运行时以文件为准，不会覆盖已有配置）。
DEFAULT_PROFILES: List[Dict[str, Any]] = [
    {
        "id": "DR2159",
        "name": "DR2159",
        "mcu": "CW32L011",
        "arch": "cw32",
        "core": "cortex-m0plus",
        "note": "电机电流 / 堵转阈值台（CW32L011）",
        "ram": [0x20000000, 0x20001800],
        "target": "",
        "interface": "",
        "source": {
            "axf": r"D:\Code\DR2159\DR2159_Project\MDK\Objects\DR2159.axf",
            "header": r"D:\Code\DR2159\DR2159_Project\Libraries\inc\cw32l011.h",
            "map": r"D:\Code\DR2159\DR2159_Project\MDK\Objects\DR2159.map",
            "svd": "",
        },
        "defaults": [],
        "stall": {},
    },
    {
        "id": "DR1152",
        "name": "DR1152",
        "mcu": "CW32L012",
        "arch": "cw32",
        "core": "cortex-m0plus",
        "note": "电池 / UV 灯项目（CW32L012）",
        "ram": [0x20000000, 0x20002000],
        "target": "",
        "interface": "",
        "source": {
            "axf": r"D:\Code\DR1152\DR1152_Project\MDK\Objects\DR1152.axf",
            "header": r"D:\Code\DR1152\DR1152_Project\Libraries\inc\cw32l012.h",
            "map": r"D:\Code\DR1152\DR1152_Project\MDK\Objects\DR1152.map",
            "svd": "",
        },
        "defaults": ["g_dbgBatMv", "g_dbgBatLv", "uv.power", "s_duty", "uv.remainSec"],
        "stall": {},
    },
    {
        "id": "DR1152_CH",
        "name": "DR1152_CH",
        "mcu": "CH32V203C8T6",
        "arch": "riscv",
        "core": "riscv32",
        "note": "电池 / UV 灯项目（CH32V203，RISC-V）",
        "ram": [0x20000000, 0x20005000],
        "target": "",
        "interface": "",
        "source": {
            "axf": r"D:\Code\DR1152\DR1152_Project_CH32\build\DR1152_Project_CH32.elf",
            "header": "",
            "map": r"D:\Code\DR1152\DR1152_Project_CH32\build\DR1152_Project_CH32.map",
            "svd": (r"C:\MounRiver\MounRiver_Studio3\resources\app\resources\win32"
                    r"\components\WCH\SDK\default\RISC-V\CH32V203\NoneOS\CH32V203xx.svd"),
        },
        "defaults": ["bat.mv", "bat.level", "uv.power", "s_duty", "uv.remainSec"],
        "stall": {},
    },
    {
        "id": "LKS32-FOC",
        "name": "LKS32-FOC",
        "mcu": "LKS32MC07x",
        "arch": "cw32",
        "core": "cortex-m0",
        "note": "LKS32MC07x 无感 FOC（Linko）",
        "ram": [0x20000000, 0x20003000],
        "target": "profiles/targets/lks32mc07x.cfg",
        "interface": "",
        # LKS 的默认信号分布在 0x20000020..0x200004f8, 合并成一次读
        "scan": {"max_gap": 2048, "max_words": 512},
        "source": {
            "axf": r"D:\Code\lll\lks07x_Project.axf",
            "header": "",
            "map": "",
            "svd": r"C:\Keil_v5\ARM\Packs\Linko\LKS07x\1.2.0\SVD\LKS32MC07x.svd",
        },
        "defaults": [
            "limitpowerhandle.ibus_fir",
            "limitpowerhandle.ibus_range",
            "speed",
            "power_cmd",
            "gS_DcBusVolM[0].nUdc",
            "sS_MACtrProc[0].m_nQCurrentSet",
        ],
        "stall": {
            "current": "limitpowerhandle.ibus_fir",
            "threshold": "limitpowerhandle.ibus_range",
        },
    },
]


# --------------------------------------------------------------------------
# 路径 / 读写
# --------------------------------------------------------------------------
def host_path(path: str) -> str:
    """Windows 绝对路径 -> 当前宿主可读路径（与 tools/build_mcu_tables.py 一致）。"""
    if not path:
        return ""
    if os.name == "nt":
        return path
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", str(path))
    if m:
        return "/mnt/%s/%s" % (m.group(1).lower(), m.group(2).replace("\\", "/"))
    return str(path)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _profile_dir(pid: str, root: str = ROOT) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.\-\u4e00-\u9fa5]+", "_", str(pid or ""))[:64]
    return os.path.join(root, safe)


def signals_path(pid: str, root: str = ROOT) -> str:
    return os.path.join(_profile_dir(pid, root), "signals.json")


def config_path(pid: str, root: str = ROOT) -> str:
    return os.path.join(_profile_dir(pid, root), "config.json")


def _read_json(path: str, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path: str, data: Any, indent: Optional[int] = None) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent,
                  separators=None if indent else (",", ":"))
        f.write("\n")
    os.replace(tmp, path)
    return os.path.getsize(path)


# --------------------------------------------------------------------------
# index / 机型元数据
# --------------------------------------------------------------------------
def load_index(root: str = ROOT) -> Dict[str, Any]:
    data = _read_json(os.path.join(root, "index.json"), None)
    if not isinstance(data, dict):
        return {"schema": SCHEMA, "active": "", "items": []}
    items = [str(x) for x in (data.get("items") or []) if str(x or "").strip()]
    return {"schema": int(data.get("schema") or SCHEMA),
            "active": str(data.get("active") or ""), "items": items}


def save_index(index: Dict[str, Any], root: str = ROOT) -> None:
    _write_json(os.path.join(root, "index.json"), {
        "schema": SCHEMA,
        "active": str(index.get("active") or ""),
        "items": [str(x) for x in index.get("items") or []],
    }, indent=2)


def read_profile(pid: str, root: str = ROOT) -> Optional[Dict[str, Any]]:
    path = os.path.join(_profile_dir(pid, root), "profile.json")
    data = _read_json(path, None)
    if not isinstance(data, dict):
        return None
    data.setdefault("id", pid)
    data.setdefault("name", data["id"])
    src = data.get("source")
    data["source"] = src if isinstance(src, dict) else {}
    return data


def write_profile(meta: Dict[str, Any], root: str = ROOT) -> Dict[str, Any]:
    pid = str(meta.get("id") or "").strip()
    if not pid:
        raise ValueError("profile.id 不能为空")
    meta = dict(meta)
    meta["updated_at"] = _now()
    _write_json(os.path.join(_profile_dir(pid, root), "profile.json"), meta, indent=2)
    return meta


def list_profiles(root: str = ROOT) -> List[Dict[str, Any]]:
    index = load_index(root)
    out: List[Dict[str, Any]] = []
    for pid in index["items"]:
        meta = read_profile(pid, root)
        if meta is not None:
            out.append(meta)
    return out


def get_active(root: str = ROOT) -> str:
    index = load_index(root)
    if index["active"] and index["active"] in index["items"]:
        return index["active"]
    return index["items"][0] if index["items"] else ""


def set_active(pid: str, root: str = ROOT) -> None:
    index = load_index(root)
    if pid not in index["items"]:
        index["items"].append(pid)
    index["active"] = pid
    save_index(index, root)


def summary(meta: Dict[str, Any], root: str = ROOT) -> Dict[str, Any]:
    """给前端/状态接口的机型摘要（含符号表是否可用）。"""
    pid = str(meta.get("id") or "")
    cat_path = signals_path(pid, root)
    counts = meta.get("counts") or {}
    available = os.path.isfile(cat_path)
    src = meta.get("source") or {}
    axf = host_path(str(src.get("axf") or ""))
    return {
        "id": pid,
        "name": str(meta.get("name") or pid),
        "mcu": str(meta.get("mcu") or ""),
        "arch": str(meta.get("arch") or "cw32"),
        "core": str(meta.get("core") or ""),
        "note": str(meta.get("note") or ""),
        "ram": meta.get("ram") or [],
        "target": str(meta.get("target") or ""),
        "interface": str(meta.get("interface") or ""),
        "source_axf": axf,
        "source_axf_exists": bool(axf and os.path.isfile(axf)),
        "source_header": host_path(str(src.get("header") or "")),
        "source_svd": host_path(str(src.get("svd") or "")),
        "available": available,
        "variables": int(counts.get("variables") or 0),
        "peripherals": int(counts.get("peripherals") or 0),
        "updated_at": str(meta.get("updated_at") or ""),
        "generated_at": str(counts.get("generated_at") or ""),
    }


# --------------------------------------------------------------------------
# 初始化 / 生成 / 配置
# --------------------------------------------------------------------------
def ensure(root: str = ROOT, active: str = "") -> Dict[str, Any]:
    """确保 index.json 与四个默认机型目录存在（只写元数据，不生成符号）。"""
    os.makedirs(root, exist_ok=True)
    index = load_index(root)
    changed = False
    for spec in DEFAULT_PROFILES:
        pid = spec["id"]
        if pid not in index["items"]:
            index["items"].append(pid)
            changed = True
        path = os.path.join(_profile_dir(pid, root), "profile.json")
        if not os.path.isfile(path):
            meta = dict(spec)
            meta["created_at"] = _now()
            meta["updated_at"] = meta["created_at"]
            meta["counts"] = {}
            _write_json(path, meta, indent=2)
    if active and active not in index["items"]:
        index["items"].append(active)
        changed = True
    if active:
        index["active"] = active
        changed = True
    if changed or not index.get("active"):
        if not index.get("active") and index["items"]:
            index["active"] = index["items"][0]
        save_index(index, root)
    return index


def build_catalog(meta: Dict[str, Any]) -> Dict[str, Any]:
    """按 profile.source 生成符号目录（需要 pyelftools；SVD 型号不需要头文件）。"""
    import gen_signals  # 延迟导入：未装 pyelftools 时仍可读已有 signals.json

    src = meta.get("source") or {}
    axf = host_path(str(src.get("axf") or ""))
    header = host_path(str(src.get("header") or ""))
    svd = host_path(str(src.get("svd") or ""))
    map_path = host_path(str(src.get("map") or ""))
    if not axf or not os.path.isfile(axf):
        raise RuntimeError("找不到 AXF/ELF: %s（请改 profile.json 的 source.axf）" % (axf or "?"))
    ram = meta.get("ram") or None
    if isinstance(ram, list) and len(ram) == 2:
        ram = (int(ram[0]), int(ram[1]))
    else:
        ram = None
    data = gen_signals.build(
        axf,
        header if header and os.path.isfile(header) else "",
        map_path if map_path and os.path.isfile(map_path) else None,
        svd=svd if svd and os.path.isfile(svd) else None,
        mcu=str(meta.get("mcu") or ""),
        ram=ram,
        defaults=list(meta.get("defaults") or []),
        stall=dict(meta.get("stall") or {}),
    )
    data.setdefault("meta", {})["profile"] = str(meta.get("id") or "")
    return data


def save_catalog(pid: str, data: Dict[str, Any], root: str = ROOT) -> None:
    _write_json(signals_path(pid, root), data)


def load_catalog(pid: str, root: str = ROOT) -> Optional[Dict[str, Any]]:
    data = _read_json(signals_path(pid, root), None)
    return data if isinstance(data, dict) else None


def apply_counts(meta: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    """把生成/导入结果写回 profile 元数据（数量、时间、来源文件名）。"""
    meta = dict(meta)
    meta["counts"] = {
        "variables": len(data.get("variables") or []),
        "peripherals": len(data.get("peripherals") or []),
        "generated_at": str((data.get("meta") or {}).get("generated_at") or ""),
    }
    return meta


def read_config(pid: str, root: str = ROOT) -> Dict[str, Any]:
    data = _read_json(config_path(pid, root), None)
    return data if isinstance(data, dict) else {}


def save_config(pid: str, config: Dict[str, Any], root: str = ROOT) -> Dict[str, Any]:
    payload = {"saved_at": _now(), "config": config if isinstance(config, dict) else {}}
    _write_json(config_path(pid, root), payload, indent=2)
    return payload


def rebuild(pid: str, root: str = ROOT) -> Dict[str, Any]:
    """重建某个机型的 signals.json；返回更新后的元数据与计数。"""
    meta = read_profile(pid, root)
    if meta is None:
        raise RuntimeError("未知机型: %s" % pid)
    data = build_catalog(meta)
    save_catalog(pid, data, root)
    meta = apply_counts(meta, data)
    meta = write_profile(meta, root)
    return {"profile": meta, "catalog": data,
            "counts": dict(meta.get("counts") or {})}
