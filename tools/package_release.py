#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包 MotorScope 发行版（方案 B：包含预编译 OpenOCD 二进制）。

许可证分层（重要）：
  * 本项目自有代码          → MIT（LICENSE）
  * tools/openocd/          → GPL-2.0-or-later（整包含 COPYING + LICENSES/）
  * tools/openocd-wch-fast/ → GPL-2.0-or-later（包内含 COPYING）
  * tools/riscv-openocd-wch/→ GPL-2.0-or-later 源码（满足 GPL 源码义务）
  * web/mcu/*.json          → 结构化寄存器数据；LKS32MC07x.info.json 含厂商
                              手册摘录，版权归 Linko，见 THIRD-PARTY-NOTICES.md

打包时会做合规自检：缺 COPYING / 缺 THIRD-PARTY-NOTICES.md 直接失败。

用法：
    python tools/package_release.py                 # 自动读版本号
    python tools/package_release.py --version 1.2.3
    python tools/package_release.py --no-binaries   # 只打自有代码（方案 A）
    python tools/package_release.py --out dist
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 必须进包的自有文件/目录
# 注意：不含根目录 signals.json —— 那是作者本机用某个 ELF 生成的运行时产物，
# 属于「本机项目数据」，会泄漏用户工程信息，发行包一律不带。
CORE = [
    "scope_server.py", "ocd.py", "profiles.py", "gen_signals.py",
    "record_cache.py", "api_docs.py", "usb_devices.py", "flash.py",
    "flash_tool.py", "requirements.txt",
    "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "API.md",
    "start_scope.bat", "start_scope_sim.bat", "regen_signals.bat",
    "web", "docs", "tools",
    "profiles/demo", "profiles/README.md", "profiles/targets",
    "dsh-plugin",
]

# 二进制组件（方案 B 才包含）
BINARIES = [
    ("tools/openocd", "标准 OpenOCD 0.12.0-rc2 (GPL-2.0-or-later)"),
    ("tools/openocd-wch-fast", "RISC-V WCH 定制版 (GPL-2.0-or-later)"),
]

# submodule 内容（cfg 存档 + RISC-V 源码；后者满足 GPL 源码义务）
SUBMODULES = [
    "tools/openocd-cfg",
    "tools/riscv-openocd-wch",
]

# 一律排除
EXCLUDE_DIRS = {
    ".git", "__pycache__", ".record-cache", ".work", "imports",
    "runtime", "dist", ".vscode", ".idea",
}
EXCLUDE_EXT = {".pyc", ".pyo", ".log", ".tmp", ".bak"}
EXCLUDE_NAMES = {
    "config.json",          # profiles/*/config.json 用户快照
    "index.json",           # profiles/index.json 运行时状态
}
# profiles/<机型>/ 下的用户私有数据（只保留 demo/ 和 targets/）
PROFILE_PRIVATE = {"signals.json", "profile.json", "annotations.json", "config.json"}

# 「本机项目数据」特征：作者开发机上的绝对路径 / 厂商工具链安装路径。
# 发行包若含这些，会泄漏私有工程结构/路径，且对新用户无意义。
# 注意：raw string 里单反斜杠写一个，双反斜杠写两个
LOCAL_PATH_PATTERNS = [
    re.compile(r"[A-Za-z]:\\{1,2}Code\\{1,2}"),           # 盘符 Code 目录
    re.compile(r"[A-Za-z]:/{1,2}Code/"),                   # D:/Code/
    re.compile(r"/mnt/[a-z]/Code/"),                       # WSL 挂载路径
    re.compile(r"[A-Za-z]:\\{1,2}(Keil_v5|MounRiver)"),    # 作者本机工具链
    re.compile(r"[A-Za-z]:/{1,2}(Keil_v5|MounRiver)"),
    # 通用盘符绝对路径（排除 \Windows\ 这类系统目录误报）
    re.compile(r"[A-Za-z]:\\{1,2}(?!Windows\\|Program Files)[A-Za-z0-9_.-]+\\"),
]
# 扫描时只看文本类文件
SCAN_EXT = {".py", ".js", ".json", ".md", ".bat", ".cfg", ".html", ".css", ".txt", ".yml"}
# 这些文件允许保留路径说明（文档里的「工具装在哪/路径怎么写」教学示例）。
# 注意：只放行「通用占位写法」，不放行任何作者本机真实安装路径。
PATH_SCAN_ALLOW = {
    "README.md", "API.md", "THIRD-PARTY-NOTICES.md",
    "profiles/README.md", "web/mcu/README.md", "dsh-plugin/README.md",
    # 扫描器自身必须包含这些模式定义，不算泄漏
    "tools/package_release.py",
}


def read_version(explicit: str = "") -> str:
    if explicit:
        return explicit.strip()
    try:
        src = open(os.path.join(ROOT, "scope_server.py"), encoding="utf-8").read()
        m = re.search(r'^VERSION\s*=\s*"([^"]+)"', src, re.M)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "0.0.0"


def compliance_check(include_binaries: bool) -> list[str]:
    """打包前自检，返回问题列表（空 = 通过）。"""
    problems = []
    if not os.path.isfile(os.path.join(ROOT, "LICENSE")):
        problems.append("缺少 LICENSE")
    notices = os.path.join(ROOT, "THIRD-PARTY-NOTICES.md")
    if not os.path.isfile(notices):
        problems.append("缺少 THIRD-PARTY-NOTICES.md")
    else:
        txt = open(notices, encoding="utf-8").read()
        if "LKS32MC07x" not in txt or "Linko" not in txt:
            problems.append("THIRD-PARTY-NOTICES.md 未声明 LKS32 手册摘录的版权归属")
    if include_binaries:
        for d in ("tools/openocd", "tools/openocd-wch-fast"):
            p = os.path.join(ROOT, d)
            if not os.path.isdir(p):
                problems.append("缺少二进制目录: %s" % d)
                continue
            if not os.path.isfile(os.path.join(p, "COPYING")):
                problems.append("%s 缺少 COPYING（GPL 要求）" % d)
        # 源码义务：RISC-V 定制版源码须随包
        if not os.path.isdir(os.path.join(ROOT, "tools/riscv-openocd-wch")):
            problems.append("缺少 tools/riscv-openocd-wch（GPL 源码义务）")
    return problems


def scan_local_paths(items: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """扫描待打包文件里是否残留「作者本机项目路径」。

    命中说明发行包会泄漏私有工程结构（例如开发机上的 Code 目录），
    且对新用户毫无意义。返回 [(包内路径, 命中的样例)]。
    """
    found: list[tuple[str, str]] = []
    for abs_path, rel in items:
        if os.path.splitext(rel)[1].lower() not in SCAN_EXT:
            continue
        if rel in PATH_SCAN_ALLOW:
            continue
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for rx in LOCAL_PATH_PATTERNS:
            m = rx.search(text)
            if m:
                # 取所在行做样例
                line = text[:m.start()].count("\n")
                snippet = text.splitlines()[line][:100] if text.splitlines() else m.group(0)
                found.append((rel, snippet.strip()))
                break
    return found


def _should_skip(rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    if any(p in EXCLUDE_DIRS for p in parts):
        return True
    name = parts[-1]
    if name in EXCLUDE_NAMES:
        return True
    if os.path.splitext(name)[1].lower() in EXCLUDE_EXT:
        return True
    # profiles/<机型>/signals.json 等私有数据不打包
    if len(parts) >= 3 and parts[0] == "profiles" and parts[1] != "demo" \
            and name in PROFILE_PRIVATE:
        return True
    return False


def collect(include_binaries: bool, include_sources: bool = True) -> list[tuple[str, str]]:
    """返回 [(绝对路径, 包内相对路径)]。"""
    items: list[tuple[str, str]] = []
    roots = list(CORE)
    if include_binaries:
        roots += [d for d, _ in BINARIES]
    if include_sources:
        roots += SUBMODULES

    seen = set()
    for rel_root in roots:
        abs_root = os.path.join(ROOT, rel_root)
        if not os.path.exists(abs_root):
            continue
        if os.path.isfile(abs_root):
            if not _should_skip(rel_root):
                items.append((abs_root, rel_root))
            continue
        for dp, dns, fns in os.walk(abs_root):
            dns[:] = [d for d in dns if d not in EXCLUDE_DIRS]
            for fn in fns:
                ap = os.path.join(dp, fn)
                rp = os.path.relpath(ap, ROOT).replace("\\", "/")
                if rp in seen or _should_skip(rp):
                    continue
                seen.add(rp)
                items.append((ap, rp))
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description="打包 MotorScope 发行版")
    ap.add_argument("--version", default="", help="版本号（默认读 scope_server.VERSION）")
    ap.add_argument("--out", default="dist", help="输出目录")
    ap.add_argument("--no-binaries", action="store_true",
                    help="不打包 OpenOCD 二进制（方案 A，纯 MIT 主体）")
    ap.add_argument("--no-sources", action="store_true",
                    help="不打包 submodule 源码（不建议：会缺失 GPL 源码义务）")
    ap.add_argument("--skip-check", action="store_true", help="跳过合规自检（不推荐）")
    args = ap.parse_args()

    ver = read_version(args.version)
    include_binaries = not args.no_binaries
    include_sources = not args.no_sources

    print("MotorScope 打包  version=%s  binaries=%s  sources=%s"
          % (ver, include_binaries, include_sources))

    if not args.skip_check:
        problems = compliance_check(include_binaries)
        if problems:
            print("\n[合规自检失败]")
            for p in problems:
                print("  ✗ " + p)
            print("\n修复后再打包，或用 --skip-check 跳过（不推荐）。")
            return 1
        print("  合规自检通过")

    items = collect(include_binaries, include_sources)
    if not items:
        print("没有可打包的文件")
        return 1

    # 本机项目路径扫描：发行包不应含作者私有工程路径
    if not args.skip_check:
        leaks = scan_local_paths(items)
        if leaks:
            print("\n[本机项目路径泄漏] 下列文件含作者本机路径，不应进发行包：")
            for rel, sample in leaks:
                print("  ✗ %s\n      %s" % (rel, sample))
            print("\n请把这些路径改为空值/相对路径，或加进 PATH_SCAN_ALLOW"
                  "（仅限文档示例），或用 --skip-check 跳过。")
            return 1
        print("  本机路径检查通过")

    out_dir = os.path.join(ROOT, args.out)
    os.makedirs(out_dir, exist_ok=True)
    name = "motor-scope-v%s%s.zip" % (ver, "" if include_binaries else "-src")
    zip_path = os.path.join(out_dir, name)

    total = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for ap_, rp in sorted(items, key=lambda x: x[1]):
            try:
                z.write(ap_, "motor-scope/" + rp)
                total += os.path.getsize(ap_)
            except OSError as exc:
                print("  跳过 %s: %s" % (rp, exc))

    size = os.path.getsize(zip_path)
    print("\n生成: %s" % os.path.relpath(zip_path, ROOT))
    print("  文件数: %d" % len(items))
    print("  原始大小: %.1f MB" % (total / 1048576))
    print("  压缩后: %.1f MB" % (size / 1048576))

    if include_binaries:
        print("\n发布提醒（GPL 合规）:")
        print("  * 本包含 GPL-2.0-or-later 组件，需随包提供对应源码或书面要约")
        print("    - 标准 OpenOCD: https://github.com/openocd-org/openocd "
              "@ 0.12.0-rc2 (7a1adfbec)")
        print("    - RISC-V 定制版源码已随包: tools/riscv-openocd-wch/")
        print("  * Release notes 中请注明上述源码地址与许可证")
    return 0


if __name__ == "__main__":
    sys.exit(main())
