#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope 依赖准备脚本：clone 后运行一次即可「开箱即用」。

主仓**不含**任何 OpenOCD 二进制（GPL / 体积考虑），只含 submodule 指针与查找逻辑。
本脚本负责补齐运行时依赖：

  1. 提示初始化 git submodule（cfg 存档 + WCH 源码），可自动执行
  2. RISC-V：从 github.com/Huyil/riscv-openocd-wch 的 Release 下载预编译包，
     解压到 tools/openocd-wch-fast/
  3. ARM：检查 tools/openocd/ 是否已有一份完整 OpenOCD 0.12.0 安装；
     没有则给出获取方式（不自动下载，避免分发 GPL 二进制）

用法：
    python tools/fetch_openocd.py              # 准备全部
    python tools/fetch_openocd.py --check     # 只检查，不下载
    python tools/fetch_openocd.py --riscv-only
    python tools/fetch_openocd.py --init-submodules

下载失败（GitHub 直连不稳）时，可手动下载 zip 放到 tools/ 下再重跑，
或设置环境变量 MOTORSCOPE_RISCV_ZIP 指向本地 zip。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

RELEASE_API = "https://api.github.com/repos/Huyil/riscv-openocd-wch/releases/latest"
RELEASE_FALLBACK = (
    "https://github.com/Huyil/riscv-openocd-wch/releases/download/"
    "v0.11.0.dev-fastread/openocd-wch-fast-v0.11.0.dev-fastread.zip"
)
RISCV_DST = os.path.join(ROOT, "tools", "openocd-wch-fast")
ARM_DST = os.path.join(ROOT, "tools", "openocd")


def _ok(msg: str) -> None:
    print("  [OK] " + msg)


def _warn(msg: str) -> None:
    print("  [!!] " + msg)


def _info(msg: str) -> None:
    print("  " + msg)


def _fetch_json(url: str, timeout: float = 20.0):
    import json
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "motor-scope-bootstrap"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def latest_release_asset() -> str:
    """取最新 Release 里名字含 openocd-wch-fast 的 zip 下载链接。"""
    try:
        data = _fetch_json(RELEASE_API)
        for a in data.get("assets") or []:
            if a.get("name", "").endswith(".zip") and "openocd" in a["name"]:
                return a["browser_download_url"]
    except Exception as exc:
        _warn("查询 Release API 失败（%s），改用固定版本链接" % exc)
    return RELEASE_FALLBACK


def _download(url: str, dest: str, timeout: float = 300.0) -> bool:
    print("  下载: %s" % url)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "motor-scope-bootstrap"})
        with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    sys.stdout.write("\r  %d/%d KB (%.0f%%)" %
                                     (done // 1024, total // 1024, done * 100.0 / total))
                    sys.stdout.flush()
            print()
        return True
    except Exception as exc:
        _warn("下载失败: %s" % exc)
        return False


def prepare_riscv(check_only: bool = False) -> bool:
    print("\n[RISC-V] 预编译 WCH OpenOCD (wlinke + SDI 块读快路)")
    exe = os.path.join(RISCV_DST, "bin", "openocd.exe")
    exe_linux = os.path.join(RISCV_DST, "bin", "openocd")
    if os.path.isfile(exe) or os.path.isfile(exe_linux):
        _ok("已存在: %s" % (exe if os.path.isfile(exe) else exe_linux))
        return True
    if check_only:
        _warn("缺少 tools/openocd-wch-fast/bin/openocd[.exe]")
        return False

    local_zip = os.environ.get("MOTORSCOPE_RISCV_ZIP") or ""
    zip_path = os.path.join(ROOT, "tools", "_openocd-wch-fast.zip")
    if local_zip and os.path.isfile(local_zip):
        zip_path = local_zip
    elif not os.path.isfile(zip_path):
        if not _download(latest_release_asset(), zip_path):
            _info("可手动下载后设置 MOTORSCOPE_RISCV_ZIP=<zip 路径> 再重跑")
            return False
    else:
        _info("复用已下载的 %s" % zip_path)

    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            # 包内可能有一层顶层目录，规范化到 RISCV_DST
            z.extractall(os.path.join(ROOT, "tools", "_riscv_extract"))
    except Exception as exc:
        _warn("解压失败: %s" % exc)
        return False

    extract_root = os.path.join(ROOT, "tools", "_riscv_extract")
    # 找到含 bin/openocd.exe 的那一层
    src = extract_root
    for dp, _dns, fns in os.walk(extract_root):
        if "openocd.exe" in fns or "openocd" in fns:
            if os.path.basename(dp) == "bin":
                src = os.path.dirname(dp)
                break
    os.makedirs(RISCV_DST, exist_ok=True)
    for item in os.listdir(src):
        s = os.path.join(src, item)
        d = os.path.join(RISCV_DST, item)
        if os.path.isdir(s):
            shutil.copytree(s, d, dirs_exist_ok=True)
        else:
            shutil.copy2(s, d)
    shutil.rmtree(extract_root, ignore_errors=True)

    if os.path.isfile(os.path.join(RISCV_DST, "bin", "openocd.exe")) or \
       os.path.isfile(os.path.join(RISCV_DST, "bin", "openocd")):
        _ok("RISC-V 二进制就绪: %s" % RISCV_DST)
        return True
    _warn("解压后未找到 bin/openocd，请检查 zip 内容")
    return False


def prepare_arm(check_only: bool = False) -> bool:
    print("\n[ARM] 标准 OpenOCD 0.12.0-rc2（CMSIS-DAP / SWD）")
    exe = os.path.join(ARM_DST, "bin", "openocd.exe")
    exe_linux = os.path.join(ARM_DST, "bin", "openocd")
    scripts = os.path.join(ARM_DST, "share", "openocd", "scripts")
    if (os.path.isfile(exe) or os.path.isfile(exe_linux)) and os.path.isdir(scripts):
        _ok("已存在完整安装: %s" % ARM_DST)
        return True
    _warn("缺少 tools/openocd/ 完整安装" if not check_only else "缺少 tools/openocd/")
    _info("主仓不分发 OpenOCD 二进制。请任取其一：")
    _info("  1) 从 https://github.com/openocd-org/openocd 获取 0.12.0 发行版，")
    _info("     放到 tools/openocd/（需 bin/openocd.exe + share/openocd/scripts/）")
    _info("  2) 用已有的安装，在信号源面板填「OpenOCD 根目录」或 --openocd 指定")
    return False


def init_submodules(do_it: bool) -> bool:
    print("\n[submodule] cfg 存档 + WCH 源码")
    gm = os.path.join(ROOT, ".gitmodules")
    if not os.path.isfile(gm):
        _info("无 .gitmodules，跳过")
        return True
    missing = []
    for path in ("tools/openocd-cfg", "tools/riscv-openocd-wch"):
        p = os.path.join(ROOT, path)
        if not os.path.isdir(p) or not os.listdir(p):
            missing.append(path)
    if not missing:
        _ok("两个 submodule 均已就绪")
        return True
    _warn("未初始化的 submodule: %s" % ", ".join(missing))
    if do_it:
        try:
            subprocess.check_call(["git", "submodule", "update", "--init", "--recursive"],
                                  cwd=ROOT, timeout=600)
            _ok("submodule 初始化完成")
            return True
        except Exception as exc:
            _warn("自动初始化失败: %s" % exc)
    _info("手动执行: git submodule update --init --recursive")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="准备 MotorScope 的 OpenOCD 运行时依赖")
    ap.add_argument("--check", action="store_true", help="只检查，不下载")
    ap.add_argument("--riscv-only", action="store_true", help="只处理 RISC-V 二进制")
    ap.add_argument("--init-submodules", action="store_true", help="自动执行 git submodule update --init")
    args = ap.parse_args()

    print("MotorScope 依赖准备  (工程: %s)" % ROOT)
    init_submodules(args.init_submodules and not args.check)
    r = True
    if not args.riscv_only:
        r = prepare_arm(args.check) and r
    r = prepare_riscv(args.check) and r

    print("\n结果: " + ("全部就绪" if r else "仍有缺失（见上方 [!!] 提示）"))
    if not args.check:
        _info("cfg 由 tools/openocd-cfg submodule 提供，ocd.py 会在缺 bin/wch-riscv.cfg 时自动取用")
    return 0 if r else 1


if __name__ == "__main__":
    sys.exit(main())
