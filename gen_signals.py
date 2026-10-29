#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope 信号目录生成器.

从 Keil 的 AXF (DWARF 调试信息) 里提取:
  * RAM 里的固件全局变量 / 结构体字段 / 数组元素 / 位域
  * 外设寄存器 (CW32L011 的 *TypeDef, 含位域), 地址来自 cw32l011.h 的 CW_xxx 宏

输出 signals.json, 供 scope_server.py / 前端使用。固件重新编译后地址会变,
需要重新生成 (启动时若 AXF 比 signals.json 新, 服务器会自动尝试重建)。

依赖: pyelftools  (pip install pyelftools)

用法:
  python gen_signals.py --axf ../../MDK/Objects/DR2159.axf \
      --header ../../Libraries/inc/cw32l011.h --out signals.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from elftools.elf.elffile import ELFFile
    from elftools.dwarf.dwarf_expr import DWARFExprParser
except Exception as exc:  # pragma: no cover
    sys.stderr.write("需要 pyelftools: pip install pyelftools\n(%s)\n" % exc)
    raise SystemExit(2)

RAM_MIN = 0x20000000
RAM_MAX = 0x20002000          # CW32L011 6KB / CW32L012 8KB, 取上限
PERIPH_MIN = 0x40000000
PERIPH_MAX = 0x50000000
ARRAY_ELEMENTS = 16           # RAM 数组最多展开多少个元素
STRUCT_ARRAY_ELEMENTS = 4      # 结构体数组最多展开多少个元素

# DWARF encodings
DW_ATE_boolean = 0x02
DW_ATE_float = 0x04
DW_ATE_signed = 0x05
DW_ATE_signed_char = 0x06
DW_ATE_unsigned = 0x07
DW_ATE_unsigned_char = 0x08


def _name(die) -> str:
    if die is None:
        return ""
    val = die.attributes.get("DW_AT_name")
    if val is None:
        return ""
    raw = val.value
    if isinstance(raw, bytes):
        return raw.decode("utf-8", "replace")
    return str(raw)


def _attr(die, key: str, default=None):
    if die is None:
        return default
    val = die.attributes.get(key)
    return default if val is None else val.value


def _deref(die, cu):
    """穿过 typedef / volatile / const, 返回真正的类型 DIE."""
    depth = 0
    while die is not None and die.tag in (
        "DW_TAG_typedef", "DW_TAG_volatile_type", "DW_TAG_const_type",
        "DW_TAG_restrict_type", "DW_TAG_type_unit",
    ) and depth < 12:
        if "DW_AT_type" not in die.attributes:
            return None
        die = die.get_DIE_from_attribute("DW_AT_type")
        depth += 1
    return die


def _type_label(die, cu) -> Tuple[str, int, bool, str]:
    """返回 (kind, size, signed, 显示用类型名). kind: int/float/struct/union/array/pointer/enum/unknown"""
    typedef_name = ""
    probe = die
    guard = 0
    while probe is not None and probe.tag in (
        "DW_TAG_typedef", "DW_TAG_volatile_type", "DW_TAG_const_type",
    ) and guard < 8:
        if probe.tag == "DW_TAG_typedef" and not typedef_name:
            typedef_name = _name(probe)
        if "DW_AT_type" not in probe.attributes:
            break
        probe = probe.get_DIE_from_attribute("DW_AT_type")
        guard += 1
    resolved = _deref(die, cu)
    if resolved is None:
        return ("unknown", 4, False, typedef_name or "?")
    tag = resolved.tag
    size = _attr(resolved, "DW_AT_byte_size")
    if tag == "DW_TAG_base_type":
        enc = _attr(resolved, "DW_AT_encoding", 0)
        label = typedef_name or _name(resolved) or "u32"
        if enc == DW_ATE_float:
            kind = "float"
        else:
            kind = "int"
        signed = enc not in (DW_ATE_unsigned, DW_ATE_unsigned_char,
                             DW_ATE_boolean, DW_ATE_float)
        return (kind, int(size or 4), signed, label)
    if tag == "DW_TAG_enumeration_type":
        return ("enum", int(size or 4), True, typedef_name or _name(resolved) or "enum")
    if tag == "DW_TAG_pointer_type":
        return ("pointer", int(size or 4), False, typedef_name or "void *")
    if tag == "DW_TAG_structure_type":
        return ("struct", int(size or 0), False, typedef_name or _name(resolved) or "struct")
    if tag == "DW_TAG_union_type":
        return ("union", int(size or 0), False, typedef_name or _name(resolved) or "union")
    if tag == "DW_TAG_array_type":
        elem = resolved.get_DIE_from_attribute("DW_AT_type")
        ek, es, esg, el = _type_label(elem, cu)
        n = _array_count(resolved)
        return ("array", int(size or (es * n)), False, "%s[%d]" % (el, n))
    return ("unknown", int(size or 4), False, typedef_name or tag)


def _array_count(die) -> int:
    for child in die.iter_children():
        if child.tag == "DW_TAG_subrange_type":
            cnt = _attr(child, "DW_AT_count")
            if cnt is not None:
                return int(cnt)
            ub = _attr(child, "DW_AT_upper_bound")
            if ub is not None:
                return int(ub) + 1
    return 0


def _member_offset(member, cu) -> int:
    val = member.attributes.get("DW_AT_data_member_location")
    if val is None:
        return 0
    raw = val.value
    if isinstance(raw, int):
        return raw
    data = bytes(raw) if isinstance(raw, (list, tuple)) else raw
    try:
        for op in DWARFExprParser(cu.structs).parse_expr(data):
            if op.op_name in ("DW_OP_plus_uconst", "DW_OP_constu", "DW_OP_const1u",
                              "DW_OP_const2u", "DW_OP_const4u"):
                if op.args:
                    return int(op.args[0])
    except Exception:
        pass
    return 0


def _bit_field(member, size: int) -> Optional[List[int]]:
    width = _attr(member, "DW_AT_bit_size")
    if width is None:
        return None
    width = int(width)
    data_bit = _attr(member, "DW_AT_data_bit_offset")
    if data_bit is not None:
        shift = int(data_bit)
    else:
        offset = _attr(member, "DW_AT_bit_offset")
        if offset is None:
            return None
        # ARM 是 little-endian, DWARF2/3 的 bit_offset 从存储单元 MSB 起算
        shift = size * 8 - int(offset) - width
    if shift < 0 or width <= 0:
        return None
    return [shift, width]


def _walk_members(struct_die, cu, base: int, prefix: str, depth: int,
                  out: List[Dict[str, Any]], array_limit: int = ARRAY_ELEMENTS,
                  struct_array_limit: int = STRUCT_ARRAY_ELEMENTS) -> None:
    if struct_die is None or depth > 8:
        return
    for member in struct_die.iter_children():
        if member.tag != "DW_TAG_member":
            continue
        mname = _name(member)
        if mname.upper().startswith("RESERVED"):
            continue
        if "DW_AT_type" not in member.attributes:
            continue
        off = _member_offset(member, cu)
        t = member.get_DIE_from_attribute("DW_AT_type")
        kind, size, signed, label = _type_label(t, cu)
        display = (prefix + mname) if mname else prefix.rstrip(".")
        if kind in ("struct", "union"):
            sub = _deref(t, cu)
            if mname:
                next_prefix = display + "."
            else:
                next_prefix = prefix if (not prefix or prefix.endswith(".")) else prefix + "."
            _walk_members(sub, cu, base + off, next_prefix, depth + 1, out,
                          array_limit, struct_array_limit)
        elif kind == "array":
            sub = _deref(t, cu)
            elem = sub.get_DIE_from_attribute("DW_AT_type")
            ek, es, esg, el = _type_label(elem, cu)
            n = _array_count(sub)
            if ek in ("struct", "union"):
                elem_die = _deref(elem, cu)
                for i in range(min(n, struct_array_limit)):
                    _walk_members(elem_die, cu, base + off + i * (es or 1),
                                  "%s[%d]." % (display, i), depth + 1, out,
                                  array_limit, struct_array_limit)
            else:
                for i in range(min(n, array_limit)):
                    out.append({
                        "name": "%s[%d]" % (display, i),
                        "addr": base + off + i * (es or 1),
                        "size": int(es or 1),
                        "signed": bool(esg),
                        "type": el,
                        "bit": None,
                    })
        else:
            bit = _bit_field(member, int(size or 4))
            out.append({
                "name": display,
                "addr": base + off,
                "size": int(size or 4),
                "signed": bool(signed),
                "type": label,
                "bit": bit,
            })


def _location_addr(die) -> Optional[int]:
    loc = die.attributes.get("DW_AT_location")
    if loc is None:
        return None
    raw = loc.value
    if isinstance(raw, list):
        raw = bytes(raw)
    if not isinstance(raw, bytes) or len(raw) < 5:
        return None
    if raw[0] != 0x03:  # DW_OP_addr
        return None
    return int.from_bytes(raw[1:5], "little")


def _collect_typedefs(dwarf) -> Dict[str, Tuple[Any, Any]]:
    types: Dict[str, Tuple[Any, Any]] = {}
    for cu in dwarf.iter_CUs():
        for die in cu.get_top_DIE().iter_children():
            if die.tag != "DW_TAG_typedef":
                continue
            nm = _name(die)
            if not nm:
                continue
            old = types.get(nm)
            if old is None:
                types[nm] = (die, cu)
            else:
                # 优先选真正带成员的版本
                resolved = _deref(die, cu)
                if resolved is not None and resolved.tag in ("DW_TAG_structure_type", "DW_TAG_union_type"):
                    if any(c.tag == "DW_TAG_member" for c in resolved.iter_children()):
                        types[nm] = (die, cu)
    return types


def _collect_variables(dwarf, ram_min: int = RAM_MIN,
                       ram_max: int = RAM_MAX) -> List[Dict[str, Any]]:
    seen = set()
    rows: List[Dict[str, Any]] = []
    for cu in dwarf.iter_CUs():
        for die in cu.get_top_DIE().iter_children():
            if die.tag != "DW_TAG_variable":
                continue
            nm = _name(die)
            if not nm or "DW_AT_declaration" in die.attributes:
                continue
            if "DW_AT_type" not in die.attributes:
                continue
            addr = _location_addr(die)
            if addr is None or not (ram_min <= addr < ram_max):
                continue
            t = die.get_DIE_from_attribute("DW_AT_type")
            kind, size, signed, label = _type_label(t, cu)
            local: List[Dict[str, Any]] = []
            if kind in ("struct", "union"):
                _walk_members(_deref(t, cu), cu, addr, nm + ".", 0, local)
            elif kind == "array":
                # 顶层数组: 展开少量元素
                sub = _deref(t, cu)
                elem = sub.get_DIE_from_attribute("DW_AT_type")
                ek, es, esg, el = _type_label(elem, cu)
                n = _array_count(sub)
                if ek in ("struct", "union"):
                    for i in range(min(n, STRUCT_ARRAY_ELEMENTS)):
                        _walk_members(_deref(elem, cu), cu, addr + i * (es or 1),
                                      "%s[%d]." % (nm, i), 0, local)
                else:
                    for i in range(min(n, ARRAY_ELEMENTS)):
                        local.append({"name": "%s[%d]" % (nm, i),
                                      "addr": addr + i * (es or 1),
                                      "size": int(es or 1), "signed": bool(esg),
                                      "type": el, "bit": None})
            else:
                local.append({"name": nm, "addr": addr, "size": int(size or 4),
                              "signed": bool(signed), "type": label, "bit": None})
            for row in local:
                key = (row["name"], row["addr"])
                if key in seen:
                    continue
                seen.add(key)
                row["group"] = nm
                rows.append(row)
    rows.sort(key=lambda r: (r["addr"], r["name"]))
    return rows


BASE_RE = re.compile(r"#define\s+([A-Za-z_]\w*)\s+\(?\s*(0x[0-9A-Fa-f]+|\d+)[uUlL]*\s*\)?")
CW_RE = re.compile(
    r"#define\s+CW_([A-Za-z_]\w*)\s+\(\(\s*([A-Za-z_]\w*)\s*\*\s*\)\s*([A-Za-z_]\w*)\s*\)"
)


def _parse_header(path: str) -> Tuple[Dict[str, int], List[Tuple[str, str, int]]]:
    defines: Dict[str, int] = {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    for m in BASE_RE.finditer(text):
        key, val = m.group(1), m.group(2)
        try:
            defines[key] = int(val, 0)
        except ValueError:
            pass
    periph: List[Tuple[str, str, int]] = []
    for m in CW_RE.finditer(text):
        suffix, typ, base_name = m.group(1), m.group(2), m.group(3)
        base = defines.get(base_name)
        if base is None:
            continue
        periph.append((suffix, typ, base))
    return defines, periph


def _collect_peripherals(header: str, types: Dict[str, Tuple[Any, Any]]) -> List[Dict[str, Any]]:
    _, macros = _parse_header(header)
    out: List[Dict[str, Any]] = []
    seen = set()
    for suffix, typ, base in macros:
        key = (suffix, base)
        if key in seen:
            continue
        seen.add(key)
        entry = types.get(typ)
        if entry is None:
            continue
        die, cu = entry
        struct = _deref(die, cu)
        if struct is None:
            continue
        flat: List[Dict[str, Any]] = []
        _walk_members(struct, cu, base, "", 0, flat, array_limit=64,
                      struct_array_limit=2)
        regs: Dict[str, Dict[str, Any]] = {}
        bits_by_reg: Dict[str, List[Dict[str, Any]]] = {}
        for row in flat:
            name = row["name"]
            if not name or name.endswith(".") or ".RESERVED" in name:
                continue
            if not (PERIPH_MIN <= row["addr"] < PERIPH_MAX):
                continue
            if row["bit"] is not None:
                parent = name.rsplit(".", 1)[0] if "." in name else ""
                if not parent:
                    continue
                reg = parent[:-2] if parent.endswith("_f") else parent
                if not reg:
                    continue
                bits_by_reg.setdefault(reg, []).append({
                    "name": name.rsplit(".", 1)[-1],
                    "shift": int(row["bit"][0]),
                    "width": int(row["bit"][1]),
                })
                if reg not in regs:
                    regs[reg] = {"name": reg, "addr": row["addr"],
                                 "size": 4, "signed": False, "type": "bit",
                                 "bits": []}
            else:
                if "." in name or name.endswith("_f"):
                    continue
                regs[name] = {"name": name, "addr": row["addr"],
                              "size": int(row["size"] or 4),
                              "signed": bool(row["signed"]),
                              "type": row["type"], "bits": []}
        for reg, bits in bits_by_reg.items():
            if reg in regs:
                # 去重 + 排序
                uniq = {}
                for b in bits:
                    uniq[(b["shift"], b["width"], b["name"])] = b
                regs[reg]["bits"] = sorted(uniq.values(),
                                           key=lambda b: (b["shift"], b["name"]))
        reg_list = sorted(regs.values(), key=lambda r: (r["addr"], r["name"]))
        if not reg_list:
            continue
        out.append({"name": suffix, "base": base, "type": typ, "regs": reg_list})
    out.sort(key=lambda p: (p["base"], p["name"]))
    return out


def _infer_mcu(machine: str, header: str) -> str:
    """从 ELF 架构 + 头文件名推断型号，供前端与芯片识别比对。"""
    if "RISCV" in (machine or "").upper():
        return "CH32V203"
    m = re.search(r"cw32l(\d{3})", os.path.basename(header or "").lower())
    if m:
        return "CW32L" + m.group(1)
    return "CW32L011"


def build(axf: str, header: str, map_path: Optional[str] = None) -> Dict[str, Any]:
    with open(axf, "rb") as f:
        elf = ELFFile(f)
        machine = str(elf.header.get("e_machine", ""))
        if "RISCV" in machine.upper():
            ram_min, ram_max = 0x20000000, 0x20005000   # CH32V203: 20KB
        else:
            ram_min, ram_max = RAM_MIN, RAM_MAX
        if not elf.has_dwarf_info():
            raise RuntimeError("AXF 里没有 DWARF 信息: %s" % axf)
        dwarf = elf.get_dwarf_info()
        types = _collect_typedefs(dwarf)
        variables = _collect_variables(dwarf, ram_min, ram_max)
        peripherals = _collect_peripherals(header, types) if os.path.isfile(header) else []

    def find(fragment: str) -> Optional[str]:
        for v in variables:
            if v["name"] == fragment:
                return fragment
        return None

    defaults = [n for n in (
        "motor.over.current",
        "motor.over.thresholdLast",
        "adc.RES[0]",
        "motor.Scfg.vol",
    ) if find(n)]
    stall_current = find("motor.over.current") or (variables[0]["name"] if variables else "")
    stall_threshold = find("motor.over.thresholdLast") or find("motor.over.threshold") or ""

    meta = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "axf": os.path.basename(axf),
        "axf_mtime": int(os.path.getmtime(axf)),
        "axf_size": os.path.getsize(axf),
        "header": os.path.basename(header),
        "map": os.path.basename(map_path) if map_path else "",
        "mcu": _infer_mcu(machine, header),
        "ram": [ram_min, ram_max],
        "variable_count": len(variables),
        "peripheral_count": len(peripherals),
    }
    return {
        "meta": meta,
        "variables": variables,
        "peripherals": peripherals,
        "defaults": defaults,
        "stall": {"current": stall_current, "threshold": stall_threshold},
    }


def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    proj = os.path.abspath(os.path.join(here, "..", ".."))
    ap = argparse.ArgumentParser(description="Generate MotorScope signal catalog")
    ap.add_argument("--axf", default=os.path.join(proj, "MDK", "Objects", "DR2159.axf"))
    ap.add_argument("--header", default=os.path.join(proj, "Libraries", "inc", "cw32l011.h"))
    ap.add_argument("--map", default=os.path.join(proj, "MDK", "Objects", "DR2159.map"))
    ap.add_argument("--out", default=os.path.join(here, "signals.json"))
    args = ap.parse_args(argv)
    if not os.path.isfile(args.axf):
        sys.stderr.write("找不到 AXF: %s\n" % args.axf)
        return 1
    data = build(args.axf, args.header, args.map)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %s" % args.out)
    print("  variables: %d, peripherals: %d, defaults: %s"
          % (len(data["variables"]), len(data["peripherals"]), ", ".join(data["defaults"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
