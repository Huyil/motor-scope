#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立 Flash 烧录工具（CH32V203 寄存器级标准编程）.

用法:
    python flash_tool.py --file build/DR1152_Project_CH32.hex --dry-run
    python flash_tool.py --file build/DR1152_Project_CH32.hex --tcl 127.0.0.1:6666
    python flash_tool.py --file fw.elf --tcl 127.0.0.1:6666 --no-erase --no-verify

注意: 实际烧录会擦除目标 Flash，先确认固件和调试器。
"""
from __future__ import annotations

import argparse
import sys

import flash
import ocd


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="CH32V203 Flash programmer")
    ap.add_argument("--file", required=True, help=".hex / .elf / .bin")
    ap.add_argument("--tcl", default="127.0.0.1:6666", help="OpenOCD tcl_port")
    ap.add_argument("--address", type=lambda x: int(x, 0), default=None,
                    help="覆盖起始地址（.bin 时使用）")
    ap.add_argument("--no-erase", action="store_true")
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--no-reset", action="store_true", help="烧完不复位运行")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    segments = flash.load_file(args.file)
    if args.address is not None:
        segments = [(args.address, b"".join(d for _, d in segments))]
    for base, data in segments:
        base = flash._spec_canonical(flash.CH32V203, base)
        print("段: 0x%08x .. 0x%08x  (%d B)" % (base, base + len(data), len(data)))
        sectors = sorted({(base + i) & ~(flash.CH32V203.sector_size - 1)
                          for i in range(0, len(data), flash.CH32V203.sector_size)})
        print("  擦除扇区: " + ", ".join("0x%08x" % s for s in sectors))
    if args.dry_run:
        return 0

    host, _, port = args.tcl.partition(":")
    client = ocd.TclClient(host or "127.0.0.1", int(port or 6666), timeout=5.0)
    client.connect()
    client.install_reader()
    driver = flash.FlashDriver(client, flash.CH32V203, log=print)
    try:
        for base, data in segments:
            driver.program_image(base, data,
                                 erase=not args.no_erase,
                                 verify=not args.no_verify)
        if not args.no_reset:
            # WCH RISC-V 的 reset run 之后仍可能是 halted，补一次 resume
            try:
                client.command("reset run")
            except Exception:
                pass
            try:
                client.command("resume")
            except Exception:
                pass
        print("完成。")
        return 0
    finally:
        driver.resume()
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
