#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把多个子智能体输出的寄存器描述 JSON 合并成 web/mcu/<MODEL>.info.json.

模板（web/mcu/<MODEL>.json）是地址/位偏移的唯一事实来源；本脚本按 key 回填
addr/offset/shift/width，丢弃模板里不存在的 key，去重并统计覆盖率。

用法:
  python3 tools/merge_reginfo.py --model LKS32MC07x \
      --template web/mcu/LKS32MC07x.json \
      --inputs .work/reginfo/groups/*/out.json \
      --out web/mcu/LKS32MC07x.info.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import time
from typing import Any, Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_template(path: str) -> Dict[str, Dict[str, Any]]:
    data = json.load(open(path, encoding="utf-8"))
    keys: Dict[str, Dict[str, Any]] = {}
    for p in data.get("peripherals") or []:
        pn = str(p.get("name") or "")
        base = int(p.get("base") or 0)
        for r in p.get("regs") or []:
            rn = str(r.get("name") or "")
            rk = pn + "." + rn
            keys[rk] = {
                "key": rk, "kind": "reg", "periph": pn, "reg": rn,
                "addr": int(r.get("addr") or 0),
                "offset": int(r.get("addr") or 0) - base,
                "size": int(r.get("size") or 4),
            }
            for b in r.get("bits") or []:
                bn = str(b.get("name") or "")
                bk = rk + "." + bn
                keys[bk] = {
                    "key": bk, "kind": "bit", "periph": pn, "reg": rn, "bit": bn,
                    "addr": int(r.get("addr") or 0),
                    "offset": int(r.get("addr") or 0) - base,
                    "size": int(r.get("size") or 4),
                    "shift": int(b.get("shift") or 0),
                    "width": int(b.get("width") or 1),
                }
    return keys


def _clean_text(v: Any, one_line: bool = False, limit: int = 2000) -> str:
    s = str(v or "").strip()
    if one_line:
        s = re.sub(r"\s+", " ", s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    return s[:limit]


def _norm_map(v: Any) -> Dict[str, str]:
    if not isinstance(v, dict):
        return {}
    out = {}
    for a, b in v.items():
        k = str(a).strip()
        val = _clean_text(b, one_line=True, limit=200)
        if k and val:
            out[k] = val
    return out


RESERVED = re.compile(r"^(保留|未使用|reserved|res\.?|--|—|-)$", re.I)


def merge_entry(entry: Dict[str, Any], tmpl: Dict[str, Any]) -> Dict[str, Any] | None:
    static = _clean_text(entry.get("static"), one_line=True, limit=120)
    full = _clean_text(entry.get("full"), limit=2000)
    states = _norm_map(entry.get("states"))
    values = _norm_map(entry.get("values"))
    if not static and not full:
        return None
    if not states and not values and RESERVED.match(static or "") and not full.strip("。 ."):
        return None
    out = dict(tmpl)
    out.update({
        "static": static,
        "full": full,
        "access": _clean_text(entry.get("access"), one_line=True, limit=16).upper(),
        "reset": _clean_text(entry.get("reset"), one_line=True, limit=40),
        "page": int(entry.get("page") or 0),
    })
    # width 1 只留 states；多 bit 只留 values
    if out.get("kind") == "bit":
        if int(out.get("width") or 1) == 1:
            out["states"] = states or None
            out["values"] = None
        else:
            out["states"] = None
            out["values"] = values or None
    else:
        out["states"] = None
        out["values"] = values or None
    for k in ("access", "reset"):
        if not out.get(k):
            out.pop(k, None)
    if not out.get("page"):
        out.pop("page", None)
    if out.get("states") is None:
        out.pop("states", None)
    if out.get("values") is None:
        out.pop("values", None)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Merge register-info JSON chunks")
    ap.add_argument("--model", default="LKS32MC07x")
    ap.add_argument("--template", default=os.path.join(ROOT, "web", "mcu", "LKS32MC07x.json"))
    ap.add_argument("--inputs", nargs="+", required=True)
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "mcu", "LKS32MC07x.info.json"))
    ap.add_argument("--source", default="LKS32MC07x User Manual v1.69")
    ap.add_argument("--keep-reserved", action="store_true")
    ap.add_argument("--mirror", action="append", default=[],
                    help="同构外设镜像，如 TIMER0:TIMER1,TIMER2,TIMER3")
    args = ap.parse_args(argv)

    tmpl = load_template(args.template)
    entries: Dict[str, Dict[str, Any]] = {}
    invalid: List[Tuple[str, str]] = []
    dup = 0
    files = []
    for pattern in args.inputs:
        files.extend(sorted(glob.glob(pattern)))
    for path in files:
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception as exc:
            print("WARN 跳过无法解析的 %s: %s" % (path, exc))
            continue
        for raw in data.get("entries") or []:
            if not isinstance(raw, dict):
                continue
            key = str(raw.get("key") or "").strip()
            if key not in tmpl:
                invalid.append((path, key))
                continue
            item = merge_entry(raw, tmpl[key])
            if item is None:
                continue
            old = entries.get(key)
            if old is not None:
                dup += 1
                # 优先保留 full 更长的版本，静态字段补空
                if len(item.get("full", "")) > len(old.get("full", "")):
                    for k in ("static", "full", "access", "reset", "page", "states", "values"):
                        if item.get(k):
                            old[k] = item[k]
                else:
                    for k in ("static", "access", "reset", "page", "states", "values"):
                        if not old.get(k) and item.get(k):
                            old[k] = item[k]
                entries[key] = old
            else:
                entries[key] = item

    # 同构外设镜像：TIMER1/2/3 复用 TIMER0 的描述（地址/位偏移仍来自各自模板）
    for spec in args.mirror:
        src, _, dsts = spec.partition(":")
        src = src.strip()
        for dst in [x.strip() for x in dsts.split(",") if x.strip()]:
            for key, t in tmpl.items():
                if not key.startswith(dst + "."):
                    continue
                if key in entries:
                    continue
                skey = src + key[len(dst):]
                se = entries.get(skey)
                if not se:
                    continue
                item = dict(t)
                for k in ("static", "full", "access", "reset", "page", "states", "values"):
                    if se.get(k):
                        item[k] = se[k]
                entries[key] = item

    nreg = sum(1 for e in entries.values() if e.get("kind") == "reg")
    nbit = len(entries) - nreg
    out = {
        "schema": 1,
        "model": args.model,
        "source": args.source,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "counts": {"registers": nreg, "bits": nbit},
        "entries": sorted(entries.values(), key=lambda e: (e.get("periph", ""), e.get("addr", 0), e.get("key", ""))),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, args.out)

    total_reg = sum(1 for k in tmpl if tmpl[k]["kind"] == "reg")
    total_bit = len(tmpl) - total_reg
    per: Dict[str, List[int]] = {}
    for key, t in tmpl.items():
        c = per.setdefault(t["periph"], [0, 0, 0, 0])
        c[1 if t["kind"] == "reg" else 3] += 1
        if key in entries:
            c[0 if t["kind"] == "reg" else 2] += 1
    print("inputs: %d 个文件" % len(files))
    for pn, c in sorted(per.items()):
        print("  %-8s reg %3d/%-3d bit %4d/%-4d" % (pn, c[0], c[1], c[2], c[3]))
    print("总计: reg %d/%d, bit %d/%d, 条目 %d, 重复 %d, 非法 key %d"
          % (nreg, total_reg, nbit, total_bit, len(entries), dup, len(invalid)))
    for path, key in invalid[:10]:
        print("  非法 key: %s -> %s" % (key or "(空)", os.path.basename(path)))
    print("写出: %s" % os.path.abspath(args.out))
    return 0 if entries else 1


if __name__ == "__main__":
    raise SystemExit(main())
