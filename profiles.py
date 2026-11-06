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

# 默认机型模板。**只含机型元数据**（MCU/架构/RAM/默认信号/连接参数），
# source 里的路径一律留空——那是使用者自己工程的位置，不应硬编码在发行版里。
# 用户首次使用时通过 UI「导入 AXF」或填写路径来绑定自己的固件；
# 已有 profiles/<ID>/profile.json 时以文件为准，本模板不会覆盖。
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
            "axf": "",
            "header": "",
            "map": "",
            "svd": "",
        },
        "defaults": ["motor.over.current", "motor.over.thresholdLast",
                     "adc.RES[0]", "motor.Scfg.vol"],
        "stall": {"current": "motor.over.current",
                  "threshold": "motor.over.thresholdLast"},
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
            "axf": "",
            "header": "",
            "map": "",
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
            "axf": "",
            "header": "",
            "map": "",
            "svd": "",
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
        # 相对路径按工程根解析；实际使用前由 resolve_target() 在
        # tools/*/target/ 下自动查找（cfg 仓库目录名可任意）。
        "target": "tools/openocd-cfg/target/lks32mc07x.cfg",
        "interface": "",
        # LKS 的默认信号分布在 0x20000020..0x200004f8, 合并成一次读
        "scan": {"max_gap": 2048, "max_words": 512},
        "source": {
            "axf": "",
            "header": "",
            "map": "",
            "svd": "",
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


def resolve_target(target: str, project_root: str = "") -> str:
    """把机型 profile 里的 `target` 解析成可用的 cfg 路径。

    目标配置可能来自：
      1. 绝对路径 / 已是可读文件 -> 直接用
      2. 工程内相对路径（如 tools/openocd-cfg/target/lks32mc07x.cfg）-> 按工程根解析
      3. 兜底：在 tools/*/target/ 下按文件名搜索 —— cfg 仓库的**目录名不固定**，
         只要用户把 submodule 放在 tools/ 下（名字随意）就能找到

    找不到时原样返回，由调用方报告亲路径错误。
    """
    raw = str(target or "").strip()
    if not raw:
        return ""
    root = os.path.abspath(project_root or ROOT)
    p = host_path(raw)
    if os.path.isabs(p):
        return p if os.path.isfile(p) else p
    cand = os.path.abspath(os.path.join(root, p))
    if os.path.isfile(cand):
        return cand
    # 3) 目录名无关：tools/*/target/<basename>
    name = os.path.basename(raw.replace("\\", "/"))
    if name:
        tools_dir = os.path.join(root, "tools")
        try:
            for entry in sorted(os.listdir(tools_dir)):
                sub = os.path.join(tools_dir, entry)
                if not os.path.isdir(sub):
                    continue
                for rel in ("target", "", "scripts/target"):
                    probe = os.path.join(sub, rel, name) if rel else os.path.join(sub, name)
                    if os.path.isfile(probe):
                        return probe
        except OSError:
            pass
    return cand


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _profile_dir(pid: str, root: str = ROOT) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.\-\u4e00-\u9fa5]+", "_", str(pid or ""))[:64]
    return os.path.join(root, safe)


def signals_path(pid: str, root: str = ROOT) -> str:
    return os.path.join(_profile_dir(pid, root), "signals.json")


def annotations_path(pid: str, root: str = ROOT) -> str:
    """手工/源码注释文件；不属于生成物，重建 signals.json 时不会被覆盖。"""
    return os.path.join(_profile_dir(pid, root), "annotations.json")


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


def load_annotations(pid: str, root: str = ROOT) -> Dict[str, Any]:
    """读取 <ID>/annotations.json；格式 {"variables": {"name": "desc", ...}}。"""
    data = _read_json(annotations_path(pid, root), None)
    return data if isinstance(data, dict) else {}


def apply_annotations(data: Dict[str, Any], annotations: Dict[str, Any]) -> int:
    """把 annotations.variables 合并进 catalog.variables[].desc；返回命中数。

    生成器只产出地址/类型，desc 属于人工/源码注释，单独存文件，避免
    “导入 AXF / 从 AXF 重新生成”时被覆盖。
    """
    if not isinstance(data, dict) or not isinstance(annotations, dict):
        return 0
    table = annotations.get("variables")
    if not isinstance(table, dict) or not table:
        return 0
    hit = 0
    for v in data.get("variables") or []:
        if not isinstance(v, dict):
            continue
        name = str(v.get("name") or "")
        desc = table.get(name)
        if desc is None:
            continue
        desc = str(desc).strip()
        if not desc:
            continue
        if v.get("desc") != desc:
            v["desc"] = desc
        hit += 1
    return hit


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


def build_catalog(meta: Dict[str, Any], root: str = ROOT) -> Dict[str, Any]:
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
    pid = str(meta.get("id") or "")
    if pid:
        apply_annotations(data, load_annotations(pid, root))
    return data


def save_catalog(pid: str, data: Dict[str, Any], root: str = ROOT) -> None:
    # 写回 signals.json 时再合并一次，保证任何调用方都不会丢掉 desc
    try:
        apply_annotations(data, load_annotations(pid, root))
    except Exception:
        pass
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
    data = build_catalog(meta, root)
    save_catalog(pid, data, root)
    meta = apply_counts(meta, data)
    meta = write_profile(meta, root)
    return {"profile": meta, "catalog": data,
            "counts": dict(meta.get("counts") or {})}
