#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成/重建 profiles/<ID>/signals.json 机型符号表.

用法:
    python3 tools/build_profiles.py                # 全部机型（缺目录时先建默认配置）
    python3 tools/build_profiles.py --only LKS32-FOC
    python3 tools/build_profiles.py --list         # 只看机型状态

需要 pyelftools；CW32 机型需要对应头文件，CH32/LKS 需要 SVD。
源文件路径写在 profiles/<ID>/profile.json 的 source 里，换机器时改那里。
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import profiles  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build MotorScope machine profiles")
    ap.add_argument("--only", default="", help="只重建指定机型, 逗号分隔")
    ap.add_argument("--list", action="store_true", help="只列出机型状态, 不生成")
    args = ap.parse_args(argv)

    profiles.ensure()
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    items = profiles.list_profiles()
    failed = 0
    for meta in items:
        pid = str(meta.get("id"))
        if only and pid not in only:
            continue
        if args.list:
            s = profiles.summary(meta)
            print("%-12s %-14s vars=%-4d periph=%-3d axf=%s %s" % (
                s["id"], s["mcu"], s["variables"], s["peripherals"],
                "ok" if s["source_axf_exists"] else "MISSING",
                "" if s["available"] else "(未生成)"))
            continue
        try:
            res = profiles.rebuild(pid)
            c = res["counts"]
            print("%-12s vars=%d periph=%d -> %s" % (
                pid, c.get("variables", 0), c.get("peripherals", 0),
                profiles.signals_path(pid)))
        except Exception as exc:
            failed += 1
            sys.stderr.write("[%s] 失败: %s\n" % (pid, exc))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
