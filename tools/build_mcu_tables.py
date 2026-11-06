#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 web/mcu/ 下的 MCU 外设寄存器表 (index.json + 每型号一个 JSON).

CW32 侧: 复用仓库根目录 gen_signals.py 的已验证逻辑
    _parse_header()          -> #define XXX_BASE / CW_XXX ((TYPE *)BASE)
    _collect_typedefs()      -> AXF/DWARF 里的 typedef 布局
    _collect_peripherals()   -> 结构体/位域展开成寄存器表
CH32 侧: 直接解析 WCH 的 CMSIS-SVD (含 derivedFrom / dim / cluster)。

依赖:
    pyelftools (只读 CW32 AXF 时需要)。WSL 的 python3 没有该包, 请用工程自带
    Windows 运行时（在工程根目录执行）:
        cd /d <工程目录>
        runtime\\python\\python.exe tools\\build_mcu_tables.py

用法:
    python tools/build_mcu_tables.py                # 全部型号
    python tools/build_mcu_tables.py --only CH32V203C8T6
    python tools/build_mcu_tables.py --out web/mcu  # 默认就是 web/mcu
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(ROOT, "web", "mcu")

# --------------------------------------------------------------------------
# 数据源：**全部由用户提供**，脚本内不预设任何厂商/本机路径。
#
#   --svd-ch32 <file>   CH32 的 CMSIS-SVD
#   --svd-lks  <file>   LKS 的 CMSIS-SVD
#   --cw32-src <dir>    CW32 工程根目录（内含 Libraries/inc 与 MDK/Objects）
#
# 也可用环境变量（便于 CI）：MOTORSCOPE_SVD_CH32 / MOTORSCOPE_SVD_LKS /
# MOTORSCOPE_CW32_SRC。两者都没有时，对应型号跳过（已有 web/mcu/*.json 不受影响）。
# --------------------------------------------------------------------------
def _env(*names: str) -> str:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return ""


# 运行时由 main() 按命令行/环境变量填充
CH32_SVD = _env("MOTORSCOPE_SVD_CH32")
LKS_SVD = _env("MOTORSCOPE_SVD_LKS")
_CW32_SRC = _env("MOTORSCOPE_CW32_SRC")

CW32_MODELS: List[Dict[str, Any]] = [
    {
        "id": "CW32L010",
        "aliases": ["CW32L010F8"],
        "vendor": "CW",
        "core": "cortex-m0plus",
        "flash_kb": 64,
        "ram_kb": 4,
        "package": None,
        "header": os.path.join(_CW32_SRC, "Libraries", "inc", "cw32l010.h") if _CW32_SRC else "",
        "axf": [os.path.join(_CW32_SRC, "MDK", "Objects", "bldc.axf")] if _CW32_SRC else [],
        "identify": {
            "kind": "cw32-signature",
            "type_addr": "0x001007E0",
            "type_len": 16,
            "type_ascii": True,
            "expected_type": "CW32L010",
            "pin_count_addr": "0x001007D5",
            "flash_kb_addr": "0x001007D8",
            "ram_kb_addr": "0x001007D6",
            "uid_addr": "0x001007B0",
            "uid_len": 10,
            "exact": True,
            "note": "签名区地址沿用 CW32L01x 系统信息区布局; 型号串需上机读 0x001007E0 确认",
        },
    },
    {
        "id": "CW32L011",
        "aliases": ["CW32L011K8T6"],
        "vendor": "CW",
        "core": "cortex-m0plus",
        "flash_kb": 64,
        "ram_kb": 6,
        "package": None,
        "header": os.path.join(_CW32_SRC, "Libraries", "inc", "cw32l011.h") if _CW32_SRC else "",
        "axf": [os.path.join(_CW32_SRC, "MDK", "Objects", "DR2159.axf")] if _CW32_SRC else [],
        "identify": {
            "kind": "cw32-signature",
            "type_addr": "0x001007E0",
            "type_len": 16,
            "type_ascii": True,
            "expected_type": "CW32L011",
            "pin_count_addr": "0x001007D5",
            "flash_kb_addr": "0x001007D8",
            "ram_kb_addr": "0x001007D6",
            "uid_addr": "0x001007B0",
            "uid_len": 10,
            "exact": True,
        },
    },
    {
        "id": "CW32L012",
        "aliases": ["CW32L012C8"],
        "vendor": "CW",
        "core": "cortex-m0plus",
        "flash_kb": 64,
        "ram_kb": 8,
        "package": None,
        "header": os.path.join(_CW32_SRC, "Libraries", "inc", "cw32l012.h") if _CW32_SRC else "",
        # MDK/output/Project.axf 只有 0 个外设 typedef, 因此优先用 build/ 里的固件
        "axf": ([
            os.path.join(_CW32_SRC, "build", "Project", "flash_Programming.axf"),
            os.path.join(_CW32_SRC, "MDK", "output", "Project.axf"),
        ] if _CW32_SRC else []),
        "identify": {
            "kind": "cw32-signature",
            "type_addr": "0x001007E0",
            "type_len": 16,
            "type_ascii": True,
            "expected_type": "CW32L012",
            "pin_count_addr": "0x001007D5",
            "flash_kb_addr": "0x001007D8",
            "ram_kb_addr": "0x001007D6",
            "uid_addr": "0x001007B0",
            "uid_len": 10,
            "exact": True,
            "note": "签名区地址按 CW32L01x 系统信息区布局 (DR2159 工具链文档 §2.4); 未逐型号上机验证",
        },
    },
]

CH32_MODELS: List[Dict[str, Any]] = [
    {"id": "CH32V203C8T6", "package": "LQFP48", "pins": 48},
    {"id": "CH32V203K8T6", "package": "LQFP32", "pins": 32},
]

CH32_IDENTIFY = {
    "kind": "ch32-esig",
    "family": "CH32V203",
    "flash_kb_addr": "0x1FFFF7E0",
    "flash_kb": 64,
    "uid_addr": "0x1FFFF7E8",
    "uid_len": 12,
    "exact": False,
    "note": "ESIG 只有 Flash 容量 (R16_ESIG_FLACAP.F_SIZE) 与 96-bit UID, "
            "没有型号字符串/封装/引脚数; C8T6 与 K8T6 同 die 同为 64KB, ESIG 无法区分",
    "source": "CH32FV2x_V3xRM V2.5 §31.2, p.527 (PDF p.530-531)",
}

# LKS32MC07x: 只有厂商 SVD (无 C 头文件), 直接按 SVD 展开

LKS_MODELS: List[Dict[str, Any]] = [
    {"id": "LKS32MC07x", "package": None, "pins": None},
]

LKS_IDENTIFY = {
    "kind": "lks-afe",
    "family": "LKS32MC07x",
    # SYS_AFE_INFO @0x4000_0004: Series[7:4] / Version[3:0]
    "info_addr": "0x40000004",
    "series_shift": 4,
    "series_mask": 15,
    "expected_series": 7,
    "version_shift": 0,
    "version_mask": 15,
    # FLASH_SIZE @0x0002_001C: FLASH_SIZE[7:6] -> 0=32K 1=64K 2=128K 3=128K
    "flash_size_addr": "0x0002001C",
    "flash_code_shift": 6,
    "flash_code_mask": 3,
    "flash_kb_table": [32, 64, 128, 128],
    "uid_addr": "",
    "uid_len": 0,
    "exact": False,
    "note": "AFE_INFO.Series=7 只能识别到 07x 系列, 区分不了具体料号; "
            "Flash 容量由 FLASH_SIZE[7:6] 解码 (0/1/2/3 -> 32/64/128/128KB)",
    "source": "LKS32MC07x User Manual v1.69 §5.2.2 (p.15) / §7.3.9 (p.55)",
}

WARNINGS: List[str] = []


def _utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    sys.stderr.write("WARN: %s\n" % msg)


# --------------------------------------------------------------------------
# 路径 / 小工具
# --------------------------------------------------------------------------
def host_path(p: str) -> str:
    """Windows 绝对路径 -> 当前宿主可读路径."""
    if os.name == "nt":
        return p
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m:
        return "/mnt/%s/%s" % (m.group(1).lower(), m.group(2).replace("\\", "/"))
    return p


def _num(text: Optional[str], default: int = 0) -> int:
    """SVD 数字: 0x20 / 0X20 / 8 / 16 都见过."""
    if text is None:
        return default
    t = text.strip()
    if not t:
        return default
    try:
        return int(t, 0)
    except ValueError:
        try:
            return int(t, 16)
        except ValueError:
            return default


def ctype_for(size: int, signed: bool) -> str:
    bits = max(8, size * 8)
    if bits not in (8, 16, 32, 64):
        bits = 32
    return ("int%d_t" if signed else "uint%d_t") % bits


def _is_c_ident(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_]\w*", s or ""))


def _merge_bits(primary: List[Dict[str, Any]],
                secondary: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """同地址多视图 (union / 互斥视图) 合并位域: 按 (shift,width) 去重, 先到先得."""
    out = list(primary)
    seen = {(b["shift"], b["width"]) for b in out}
    for b in secondary:
        key = (b["shift"], b["width"])
        if key in seen:
            continue
        seen.add(key)
        out.append(b)
    out.sort(key=lambda b: (b["shift"], b["width"], b["name"]))
    return out


# --------------------------------------------------------------------------
# CW32: 直接复用 gen_signals
# --------------------------------------------------------------------------
def _import_gen_signals():
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    try:
        import gen_signals  # noqa: WPS433 (延迟导入: CH32-only 时不需要 pyelftools)
    except SystemExit:
        raise RuntimeError("需要 pyelftools: 请用 runtime\\python\\python.exe 运行") from None
    return gen_signals


def _cw32_stats(axf: str, header: str) -> Tuple[int, int]:
    """返回 (typedef 数, 外设数) 用于挑选 AXF."""
    G = _import_gen_signals()
    from elftools.elf.elffile import ELFFile

    with open(axf, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            return 0, 0
        dwarf = elf.get_dwarf_info()
        types = G._collect_typedefs(dwarf)
        periph = G._collect_peripherals(header, types)
    return len(types), len(periph)


def build_cw32(spec: Dict[str, Any]) -> Dict[str, Any]:
    G = _import_gen_signals()
    from elftools.elf.elffile import ELFFile

    header = host_path(spec["header"])
    if not os.path.isfile(header):
        raise FileNotFoundError("找不到头文件: %s" % header)

    chosen, used_fallback = None, False
    reasons = []
    for cand in spec["axf"]:
        axf = host_path(cand)
        if not os.path.isfile(axf):
            reasons.append("%s: 文件不存在" % cand)
            continue
        ntypes, nper = _cw32_stats(axf, header)
        reasons.append("%s: typedef=%d peripheral=%d" % (os.path.basename(axf), ntypes, nper))
        if ntypes > 0 and nper > 0:
            chosen = axf
            break
        if chosen is None:
            chosen = axf
            used_fallback = True
    if chosen is None:
        raise FileNotFoundError("没有可用的 AXF: %s" % "; ".join(reasons))
    if used_fallback:
        warn("%s: 所有候选 AXF 都没有外设 typedef (%s)" % (spec["id"], "; ".join(reasons)))
    elif len(spec["axf"]) > 1:
        print("  %s: 使用 AXF %s" % (spec["id"], os.path.basename(chosen)))

    with open(chosen, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            raise RuntimeError("AXF 没有 DWARF: %s" % chosen)
        dwarf = elf.get_dwarf_info()
        types = G._collect_typedefs(dwarf)
        raw = G._collect_peripherals(header, types)

    peripherals = sanitize_cw32(raw, spec["id"])
    return {"id": spec["id"], "peripherals": peripherals}


def sanitize_cw32(raw: List[Dict[str, Any]], model: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen_p = set()
    dropped_bits = 0
    dropped_regs = 0
    for p in raw:
        name = (p.get("name") or "").strip()
        if not name or name in seen_p:
            if name:
                warn("%s: 重复外设 %s 已丢弃" % (model, name))
            continue
        base = int(p["base"])

        regs_by_addr: Dict[int, Dict[str, Any]] = {}
        for r in p.get("regs") or []:
            addr = int(r["addr"])
            size = int(r.get("size") or 4)
            if size not in (1, 2, 4, 8):
                size = 4
            bits = []
            for b in r.get("bits") or []:
                sh, wd = int(b["shift"]), int(b["width"])
                if wd <= 0 or sh < 0 or sh + wd > size * 8:
                    dropped_bits += 1
                    continue
                bits.append({"name": str(b["name"]), "shift": sh, "width": wd})
            bits.sort(key=lambda b: (b["shift"], b["width"], b["name"]))
            # 同一位域重复 (union 展开) 去重
            uniq, seen_b = [], set()
            for b in bits:
                k = (b["name"], b["shift"], b["width"])
                if k in seen_b:
                    continue
                seen_b.add(k)
                uniq.append(b)

            rtype = r.get("type") or ""
            if not _is_c_ident(rtype) or rtype in ("bit", "unknown", "?"):
                rtype = ctype_for(size, bool(r.get("signed")))

            entry = {
                "name": (r.get("name") or "").strip() or ("REG_0x%X" % addr),
                "addr": addr,
                "size": size,
                "signed": bool(r.get("signed")),
                "type": rtype,
                "bits": uniq,
            }
            old = regs_by_addr.get(addr)
            if old is not None:
                # 同地址多视图: 保留位域更多的那个, 再合并另一个里不重叠的位域
                dropped_regs += 1
                if len(entry["bits"]) > len(old["bits"]):
                    entry["bits"] = _merge_bits(entry["bits"], old["bits"])
                    regs_by_addr[addr] = entry
                else:
                    old["bits"] = _merge_bits(old["bits"], entry["bits"])
                continue
            regs_by_addr[addr] = entry

        regs = sorted(regs_by_addr.values(), key=lambda r: (r["addr"], r["name"]))
        if not regs:
            warn("%s: 外设 %s 没有寄存器, 已丢弃" % (model, name))
            continue
        seen_p.add(name)
        out.append({"name": name, "base": base, "type": p.get("type") or "", "regs": regs})

    out.sort(key=lambda p: (p["base"], p["name"]))
    if dropped_bits:
        warn("%s: 丢弃越界位域 %d 个" % (model, dropped_bits))
    if dropped_regs:
        warn("%s: 合并重复地址寄存器 %d 个" % (model, dropped_regs))
    return out


# --------------------------------------------------------------------------
# CH32: CMSIS-SVD
# --------------------------------------------------------------------------
def _dim_indices(text: Optional[str], count: int) -> List[Any]:
    if not text:
        return list(range(count))
    t = text.strip()
    if "," in t:
        items = [x.strip() for x in t.split(",") if x.strip()]
        if all(re.fullmatch(r"\d+", x) for x in items):
            return [int(x) for x in items][:count]
        return items[:count]
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", t)
    if m:
        return list(range(int(m.group(1)), int(m.group(2)) + 1))[:count]
    return list(range(count))


def _dim_name(name: str, idx: Any) -> str:
    if "%s" in name:
        return name.replace("%s", str(idx))
    if "%d" in name:
        return name.replace("%d", str(idx))
    return "%s%d" % (name, idx)


def _svd_reg_nodes(per: ET.Element, per_map: Dict[str, ET.Element],
                   stack: Tuple[str, ...] = ()) -> Optional[ET.Element]:
    regs = per.find("registers")
    if regs is not None:
        return regs
    der = per.get("derivedFrom")
    if der and der in per_map and der not in stack:
        return _svd_reg_nodes(per_map[der], per_map, stack + (per.findtext("name") or "",))
    return None


def _svd_default_size(per: ET.Element, per_map: Dict[str, ET.Element],
                      stack: Tuple[str, ...] = ()) -> int:
    s = per.findtext("size")
    if s:
        return _num(s, 32)
    der = per.get("derivedFrom")
    if der and der in per_map and der not in stack:
        return _svd_default_size(per_map[der], per_map, stack + (per.findtext("name") or "",))
    return 32


def _walk_svd_regs(node: ET.Element, base_off: int, size_default: int,
                   prefix: str, out: List[Dict[str, Any]],
                   stats: Dict[str, int]) -> None:
    """展开 <registers>/<cluster>/<register>, 处理 dim 与多层 cluster."""
    for child in list(node):
        if child.tag not in ("register", "cluster"):
            continue
        name = (child.findtext("name") or "").strip()
        off = _num(child.findtext("addressOffset"), 0)
        dim = _num(child.findtext("dim"), 0)
        inc = _num(child.findtext("dimIncrement"), 0) or (4 if dim else 0)
        size = _num(child.findtext("size"), size_default)
        idxs = _dim_indices(child.findtext("dimIndex"), dim) if dim > 0 else [None]

        if child.tag == "cluster":
            for i, idx in enumerate(idxs):
                cname = _dim_name(name, idx) if idx is not None else name
                _walk_svd_regs(child, base_off + off + i * inc, size, cname + "_", out, stats)
            continue

        for i, idx in enumerate(idxs):
            rname = _dim_name(name, idx) if idx is not None else name
            addr = base_off + off + i * inc
            bits: List[Dict[str, Any]] = []
            for f in child.findall("./fields/field"):
                fname = (f.findtext("name") or "").strip()
                if not fname:
                    continue
                bo = f.findtext("bitOffset")
                bw = f.findtext("bitWidth")
                if bo is None:
                    br = f.findtext("bitRange")
                    m_br = re.match(r"\[\s*(\d+)\s*:\s*(\d+)\s*\]", br.strip()) if br else None
                    if m_br:
                        msb, lsb = int(m_br.group(1)), int(m_br.group(2))
                        if msb < lsb:
                            stats["bad_fields"] += 1
                            continue
                        shift, width = lsb, msb - lsb + 1
                    else:
                        lsb = _num(f.findtext("lsb"), -1)
                        msb = _num(f.findtext("msb"), -1)
                        if lsb < 0 or msb < lsb:
                            stats["bad_fields"] += 1
                            continue
                        shift, width = lsb, msb - lsb + 1
                else:
                    shift, width = _num(bo, -1), _num(bw, 0)
                if width <= 0 or shift < 0 or shift + width > size:
                    stats["bad_fields"] += 1
                    continue
                bits.append({"name": fname, "shift": shift, "width": width})
            bits.sort(key=lambda b: (b["shift"], b["width"], b["name"]))
            out.append({
                "name": prefix + rname,
                "addr": addr,
                "size": max(1, size // 8) if size % 8 == 0 else max(1, (size + 7) // 8),
                "signed": False,
                "type": ctype_for(max(1, size // 8), False),
                "bits": bits,
            })
            stats["regs"] += 1


def build_ch32(svd_path: str) -> List[Dict[str, Any]]:
    root = ET.parse(svd_path).getroot()
    dev_size = _num(root.findtext("size"), 32)
    per_nodes = root.findall("./peripherals/peripheral")
    per_map = {(p.findtext("name") or "").strip(): p for p in per_nodes}

    stats = {"regs": 0, "bad_fields": 0}
    out: List[Dict[str, Any]] = []
    seen = set()
    for per in per_nodes:
        name = (per.findtext("name") or "").strip()
        if not name or name in seen:
            continue
        regs_node = _svd_reg_nodes(per, per_map)
        if regs_node is None:
            warn("CH32: 外设 %s 无寄存器且 derivedFrom 无法解析，已跳过" % name)
            continue
        base = _num(per.findtext("baseAddress"), 0)
        if not base:
            warn("CH32: 外设 %s baseAddress=0，已跳过" % name)
            continue
        size_default = _svd_default_size(per, per_map)
        regs: List[Dict[str, Any]] = []
        _walk_svd_regs(regs_node, base, size_default, "", regs, stats)

        by_addr: Dict[int, Dict[str, Any]] = {}
        for r in regs:
            old = by_addr.get(r["addr"])
            if old is None:
                by_addr[r["addr"]] = r
            else:
                # SVD 里同 offset 的互斥视图 (TIM1 CHCTLR1 Output/Input, ADC RDATAR_DR/ACT_DCG)
                stats["dup_regs"] = stats.get("dup_regs", 0) + 1
                if len(r["bits"]) > len(old["bits"]):
                    r["bits"] = _merge_bits(r["bits"], old["bits"])
                    by_addr[r["addr"]] = r
                else:
                    old["bits"] = _merge_bits(old["bits"], r["bits"])
        rlist = sorted(by_addr.values(), key=lambda r: (r["addr"], r["name"]))
        if not rlist:
            warn("CH32: 外设 %s 展开后无寄存器，已跳过" % name)
            continue
        seen.add(name)
        out.append({
            "name": name,
            "base": base,
            "type": (per.findtext("groupName") or "").strip(),
            "regs": rlist,
        })

    if stats["bad_fields"]:
        warn("CH32: 丢弃越界/非法位域 %d 个" % stats["bad_fields"])
    if stats.get("dup_regs"):
        warn("CH32: 合并同地址寄存器 %d 个" % stats["dup_regs"])
    out.sort(key=lambda p: (p["base"], p["name"]))
    return out


# --------------------------------------------------------------------------
# 校验 / 统计 / 落地
# --------------------------------------------------------------------------
def validate(model: str, data: Dict[str, Any]) -> Tuple[int, int, int]:
    assert data["id"] == model
    periphs = data["peripherals"]
    assert isinstance(periphs, list)
    seen_p, seen_addr = set(), set()
    nreg = nbit = 0
    for p in periphs:
        assert isinstance(p["base"], int) and not isinstance(p["base"], bool)
        assert p["name"] not in seen_p, "%s: 重复外设 %s" % (model, p["name"])
        seen_p.add(p["name"])
        assert p["name"] == p["name"].strip()
        addrs = set()
        for r in p["regs"]:
            assert isinstance(r["addr"], int) and r["addr"] >= 0
            assert r["addr"] not in addrs, "%s/%s: 寄存器地址重复 0x%X" % (
                model, p["name"], r["addr"])
            addrs.add(r["addr"])
            assert r["size"] in (1, 2, 4, 8)
            assert isinstance(r["signed"], bool)
            nreg += 1
            for b in r["bits"]:
                assert 0 <= b["shift"] and b["width"] > 0
                assert b["shift"] + b["width"] <= r["size"] * 8, (
                    "%s/%s.%s: 位域越界" % (model, p["name"], r["name"]))
                nbit += 1
    return len(periphs), nreg, nbit


def write_json(path: str, data: Any, indent: Optional[int] = None) -> int:
    text = json.dumps(data, ensure_ascii=False,
                      indent=indent,
                      separators=(",", ":") if indent is None else None)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.write("\n")
    return os.path.getsize(path)


def main(argv: Optional[List[str]] = None) -> int:
    _utf8_stdio()
    ap = argparse.ArgumentParser(description="Build web/mcu MCU register tables")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出目录 (默认 web/mcu)")
    ap.add_argument("--only", default="", help="只生成指定型号, 逗号分隔")
    ap.add_argument("--svd-ch32", default="", help="CH32 的 CMSIS-SVD 文件路径（用户提供）")
    ap.add_argument("--svd-lks", default="", help="LKS 的 CMSIS-SVD 文件路径（用户提供）")
    ap.add_argument("--cw32-src", default="", help="CW32 工程根目录（含 Libraries/inc 与 MDK/Objects）")
    args = ap.parse_args(argv)

    # 命令行优先于环境变量
    global CH32_SVD, LKS_SVD, _CW32_SRC
    if args.svd_ch32:
        CH32_SVD = args.svd_ch32
    if args.svd_lks:
        LKS_SVD = args.svd_lks
    if args.cw32_src:
        _CW32_SRC = args.cw32_src

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    only = {x.strip() for x in args.only.split(",") if x.strip()}

    index = {
        "schema": 1,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "models": [],
    }
    results: List[Tuple[str, int, int, int, int]] = []

    def want(mid: str) -> bool:
        return not only or mid in only

    cw32_specs = [m for m in CW32_MODELS if want(m["id"])]
    if cw32_specs and not _CW32_SRC:
        print("[CW32] 跳过：未提供工程目录（用 --cw32-src 或 MOTORSCOPE_CW32_SRC 指定）")
        cw32_specs = []
    for spec in cw32_specs:
        mid = spec["id"]
        print("[CW32] %s" % mid)
        data = build_cw32(spec)
        np_, nr, nb = validate(mid, data)
        fname = "%s.json" % mid
        size = write_json(os.path.join(out_dir, fname), data)
        index["models"].append({
            "id": mid,
            "aliases": spec["aliases"],
            "vendor": spec["vendor"],
            "core": spec["core"],
            "flash_kb": spec["flash_kb"],
            "ram_kb": spec["ram_kb"],
            "package": spec["package"],
            "file": fname,
            "identify": spec["identify"],
            "peripheral_count": np_,
            "register_count": nr,
            "bitfield_count": nb,
        })
        results.append((mid, np_, nr, nb, size))
        print("  peripherals=%d regs=%d bits=%d bytes=%d" % (np_, nr, nb, size))

    ch32_ids = [m for m in CH32_MODELS if want(m["id"])]
    if ch32_ids:
        svd = host_path(CH32_SVD)
        if not svd or not os.path.isfile(svd):
            print("[CH32] 跳过：未提供 SVD（用 --svd-ch32 或 MOTORSCOPE_SVD_CH32 指定）")
            ch32_ids = []
    if ch32_ids:
        print("[CH32] %s" % os.path.basename(svd))
        periphs = build_ch32(svd)
        for m in ch32_ids:
            mid = m["id"]
            data = {"id": mid, "peripherals": periphs}
            np_, nr, nb = validate(mid, data)
            fname = "%s.json" % mid
            size = write_json(os.path.join(out_dir, fname), data)
            ident = dict(CH32_IDENTIFY)
            index["models"].append({
                "id": mid,
                "aliases": [],
                "vendor": "WCH",
                "core": "riscv32",
                "flash_kb": 64,
                "ram_kb": 20,
                "package": m["package"],
                "file": fname,
                "identify": ident,
                "peripheral_count": np_,
                "register_count": nr,
                "bitfield_count": nb,
            })
            results.append((mid, np_, nr, nb, size))
            print("  %s: peripherals=%d regs=%d bits=%d bytes=%d" % (mid, np_, nr, nb, size))

    lks_ids = [m for m in LKS_MODELS if want(m["id"])]
    if lks_ids:
        svd = host_path(LKS_SVD)
        if not svd or not os.path.isfile(svd):
            print("[LKS] 跳过：未提供 SVD（用 --svd-lks 或 MOTORSCOPE_SVD_LKS 指定）")
            lks_ids = []
    if lks_ids:
        print("[LKS] %s" % os.path.basename(svd))
        periphs = build_ch32(svd)
        for m in lks_ids:
            mid = m["id"]
            data = {"id": mid, "peripherals": periphs}
            np_, nr, nb = validate(mid, data)
            fname = "%s.json" % mid
            size = write_json(os.path.join(out_dir, fname), data)
            index["models"].append({
                "id": mid,
                "aliases": ["LKS32MC071CBT8", "LKS32MC071", "LKS32MC07x"],
                "vendor": "Linko",
                "core": "cortex-m0",
                "flash_kb": 128,
                "ram_kb": 12,
                "package": m["package"],
                "file": fname,
                "identify": dict(LKS_IDENTIFY),
                "peripheral_count": np_,
                "register_count": nr,
                "bitfield_count": nb,
            })
            results.append((mid, np_, nr, nb, size))
            print("  %s: peripherals=%d regs=%d bits=%d bytes=%d" % (mid, np_, nr, nb, size))

    order = {m["id"]: i for i, m in enumerate(
        [{"id": s["id"]} for s in CW32_MODELS] + [{"id": m["id"]} for m in CH32_MODELS]
        + [{"id": m["id"]} for m in LKS_MODELS])}
    index["models"].sort(key=lambda m: order.get(m["id"], 999))

    if only:
        # 部分生成只覆盖对应型号文件, 不动 index.json (避免索引里只剩部分型号)
        print("[index] --only 模式, 未更新 %s" % os.path.join(out_dir, "index.json"))
    else:
        isize = write_json(os.path.join(out_dir, "index.json"), index, indent=2)
        print("[index] %s (%d bytes)" % (os.path.join(out_dir, "index.json"), isize))

    total_regs = sum(r[2] for r in results)
    total_bits = sum(r[3] for r in results)
    print("\n总计: %d 型号, %d 外设, %d 寄存器, %d 位域"
          % (len(results), sum(r[1] for r in results), total_regs, total_bits))
    if WARNINGS:
        print("警告 %d 条 (见 stderr)" % len(WARNINGS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
