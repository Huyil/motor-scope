#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""枚举主机上当前连接的调试探针（每个物理设备一条），供前端切换。

关键设计（针对「同款多调试器」场景）：
  * 目标是列出**设备实例**而不是接口类型。两个同款 CMSIS-DAP 靠 USB 序列号
    （adapter serial）区分，不是靠 interface cfg 文件名。
  * Windows（本项目实际部署环境）用 WMI/CIM 的 Win32_PnPEntity 枚举，
    **不需要 pyusb / libusb / WinUSB 驱动**——H7-TOOL 是 HID、WCH-Link 是 WDM
    私有驱动，本来就不该用 libusb 打开。
  * Linux/WSL 用 pyusb 或 sysfs 兜底（WSL2 默认无 USB 直通，会明确说明）。
  * 复合 USB 设备会为每个接口产生 MI_xx 子项；只取不带 &MI_ 的「根设备」，
    它的实例后缀就是真实序列号。
  * 纯枚举，不打开、不 claim 任何接口——绝不抢占正在被 Keil/OpenOCD 占用的探针。

每项含 vid/pid/serial/name/backend/iface/arch/desc/status/instance 等。
`iface` 是建议的 OpenOCD interface cfg（相对 scripts）；`serial` 可直接作为
POST /api/connect 的 serial 参数，后端会追加 -c "adapter serial <serial>"。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# 已知调试探针：vid/pid 为小写十六进制。
#   serial_from = 'instance' 表示用 WMI 根设备实例后缀当序列号（Windows）
#   iface       = 建议的 OpenOCD interface cfg（'' 表示用项目默认/机型 profile）
#   arch        = cw32(ARM) / riscv / any
# ---------------------------------------------------------------------------
KNOWN: List[Dict[str, str]] = [
    # H7-TOOL（安富莱）——本项目 ARM 链路默认探针，CMSIS-DAP v1(HID) + v2(WinUSB)
    # H7-TOOL 的 v2(WinUSB) 接口在 openocd 0.12 + libusb 上报
    # "could not claim interface"，实测只有 v1(HID) 可用 —— 故用 v1 cfg。
    {"vid": "c251", "pid": "f00a", "name": "H7-TOOL CMSIS-DAP",
     "vendor": "Anfulai", "backend": "cmsis-dap", "iface": "cmsis-dap-v1.cfg",
     "transport": "HID", "arch": "cw32"},
    # WCH-Link / WCH-LinkE（沁恒）
    {"vid": "1a86", "pid": "8012", "name": "WCH-Link (CMSIS-DAP)",
     "vendor": "WCH", "backend": "cmsis-dap", "iface": "cmsis-dap.cfg",
     "transport": "WinUSB", "arch": "cw32"},
    {"vid": "1a86", "pid": "8010", "name": "WCH-Link (RV / SDI)",
     "vendor": "WCH", "backend": "wlinke", "iface": "",
     "transport": "WDM", "arch": "riscv"},
    {"vid": "1a86", "pid": "8011", "name": "WCH-Link (IAP)",
     "vendor": "WCH", "backend": "", "iface": "",
     "transport": "WDM", "arch": "riscv"},
    # 通用 CMSIS-DAP / DAPLink
    {"vid": "0d28", "pid": "0204", "name": "DAPLink (CMSIS-DAP)",
     "vendor": "ARM", "backend": "cmsis-dap", "iface": "cmsis-dap.cfg",
     "transport": "HID", "arch": "cw32"},
    {"vid": "0d28", "pid": "0205", "name": "DAPLink (CMSIS-DAP)",
     "vendor": "ARM", "backend": "cmsis-dap", "iface": "cmsis-dap.cfg",
     "transport": "HID", "arch": "cw32"},
    {"vid": "1fc9", "pid": "0090", "name": "LPC-Link II (CMSIS-DAP)",
     "vendor": "NXP", "backend": "cmsis-dap", "iface": "cmsis-dap.cfg",
     "transport": "HID", "arch": "cw32"},
    {"vid": "0483", "pid": "5740", "name": "STM32 CMSIS-DAP",
     "vendor": "STMicroelectronics", "backend": "cmsis-dap", "iface": "cmsis-dap.cfg",
     "transport": "HID", "arch": "cw32"},
    # ST-Link
    {"vid": "0483", "pid": "3748", "name": "ST-Link/V2",
     "vendor": "STMicroelectronics", "backend": "stlink", "iface": "stlink.cfg",
     "transport": "USB", "arch": "cw32"},
    {"vid": "0483", "pid": "374b", "name": "ST-Link/V2.1",
     "vendor": "STMicroelectronics", "backend": "stlink", "iface": "stlink.cfg",
     "transport": "USB", "arch": "cw32"},
    {"vid": "0483", "pid": "3752", "name": "ST-Link/V2.1",
     "vendor": "STMicroelectronics", "backend": "stlink", "iface": "stlink.cfg",
     "transport": "USB", "arch": "cw32"},
    {"vid": "0483", "pid": "374e", "name": "ST-Link/V3",
     "vendor": "STMicroelectronics", "backend": "stlink", "iface": "stlink.cfg",
     "transport": "USB", "arch": "cw32"},
    # J-Link
    {"vid": "1366", "pid": "0101", "name": "SEGGER J-Link",
     "vendor": "SEGGER", "backend": "jlink", "iface": "jlink.cfg",
     "transport": "USB", "arch": "any"},
    {"vid": "1366", "pid": "0105", "name": "SEGGER J-Link",
     "vendor": "SEGGER", "backend": "jlink", "iface": "jlink.cfg",
     "transport": "USB", "arch": "any"},
    {"vid": "1366", "pid": "1015", "name": "SEGGER J-Link",
     "vendor": "SEGGER", "backend": "jlink", "iface": "jlink.cfg",
     "transport": "USB", "arch": "any"},
    # FTDI
    {"vid": "0403", "pid": "6010", "name": "FT2232 (JTAG/SWD)",
     "vendor": "FTDI", "backend": "ftdi", "iface": "",
     "transport": "USB", "arch": "any"},
    {"vid": "0403", "pid": "6014", "name": "FT232H (JTAG/SWD)",
     "vendor": "FTDI", "backend": "ftdi", "iface": "",
     "transport": "USB", "arch": "any"},
]

_BY_VIDPID = {(k["vid"], k["pid"]): k for k in KNOWN}

# 字符串兜底：PID 不固定的复合设备，按产品描述识别
# (正则, 名称, backend, transport, arch, iface)
_NAME_HINTS = [
    (re.compile(r"h7[-_ ]?tool", re.I), "H7-TOOL CMSIS-DAP", "cmsis-dap", "HID/WinUSB", "cw32", "cmsis-dap.cfg"),
    (re.compile(r"wch[-_ ]?link|wch cmsis", re.I), "WCH-Link (CMSIS-DAP)", "cmsis-dap", "WinUSB", "cw32", "cmsis-dap.cfg"),
    (re.compile(r"cmsis[-_ ]?dap", re.I), "CMSIS-DAP 调试器", "cmsis-dap", "HID", "any", "cmsis-dap.cfg"),
    (re.compile(r"daplink", re.I), "DAPLink", "cmsis-dap", "HID", "cw32", "cmsis-dap.cfg"),
    (re.compile(r"st[-_ ]?link", re.I), "ST-Link", "stlink", "USB", "cw32", "stlink.cfg"),
    (re.compile(r"j[-_ ]?link", re.I), "J-Link", "jlink", "USB", "any", "jlink.cfg"),
]

_PS_SCRIPT = r'''
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = @()
Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\VID_*' } | ForEach-Object {
  $id = [string]$_.PNPDeviceID
  $m = [regex]::Match($id, 'VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})\\?([^\\]*)')
  if ($m.Success) {
    $out += [ordered]@{
      instance = $id
      vid = $m.Groups[1].Value.ToLower()
      pid = $m.Groups[2].Value.ToLower()
      suffix = $m.Groups[3].Value
      desc = [string]$_.Name
      status = [string]$_.Status
    }
  }
}
$out | ConvertTo-Json -Depth 4 -Compress
'''


def _hex(v: Optional[int], width: int = 4) -> str:
    try:
        return ("%0*x" % (width, int(v))) if v is not None else ""
    except (TypeError, ValueError):
        return ""


def _lookup(vid: str, pid: str, desc: str) -> Optional[Dict[str, str]]:
    hit = _BY_VIDPID.get((vid, pid))
    if hit:
        return dict(hit)
    for rx, name, backend, transport, arch, iface in _NAME_HINTS:
        if rx.search(desc or ""):
            return {"vid": vid, "pid": pid, "name": name, "vendor": "",
                    "backend": backend, "transport": transport, "arch": arch,
                    "iface": iface}
    return None


def _run_powershell(script: str, timeout: float = 15.0) -> Optional[List[Dict[str, Any]]]:
    """在 Windows 侧执行 PowerShell 并返回 JSON 列表；不可用返回 None。
    Windows 原生和 WSL（能调 powershell.exe）都走这条。"""
    try:
        # 用 -Command 传脚本，避免临时文件；编码用 UTF8
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-Command", script],
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        data = json.loads(proc.stdout.strip())
    except (ValueError, TypeError):
        return None
    if isinstance(data, dict):
        data = [data]
    return data if isinstance(data, list) else None


def _via_wmi() -> Optional[List[Dict[str, Any]]]:
    """Windows WMI 枚举，聚合出每个物理设备的根实例。"""
    rows = _run_powershell(_PS_SCRIPT)
    if rows is None:
        return None
    out: List[Dict[str, Any]] = []
    for row in rows:
        try:
            instance = str(row.get("instance") or "")
            suffix = str(row.get("suffix") or "")
            # 复合设备的 MI_xx 是子接口，跳过；根设备才带真实序列号
            if "&MI_" in suffix.upper():
                continue
            vid, pid = str(row.get("vid") or ""), str(row.get("pid") or "")
            if not vid or not pid:
                continue
            out.append({
                "vid": vid, "pid": pid,
                "serial": suffix,           # 根实例后缀 = USB 序列号
                "desc": str(row.get("desc") or ""),
                "status": str(row.get("status") or ""),
                "instance": instance,
                "bus": None, "address": None,
                "product": str(row.get("desc") or ""),
                "manufacturer": "",
            })
        except Exception:
            continue
    return out


def _via_pyusb() -> Optional[List[Dict[str, Any]]]:
    """Linux/其他平台：pyusb 兜底。"""
    try:
        import usb.core  # type: ignore
        import usb.util  # noqa: F401  # type: ignore
    except Exception:
        return None
    out: List[Dict[str, Any]] = []
    try:
        devs = usb.core.find(find_all=True)
        if devs is None:
            return out
        for d in devs:
            try:
                vid, pid = _hex(d.idVendor), _hex(d.idProduct)
                product = manufacturer = serial = ""
                try:
                    if d.iProduct:
                        product = usb.util.get_string(d, d.iProduct)
                    if d.iManufacturer:
                        manufacturer = usb.util.get_string(d, d.iManufacturer)
                    if getattr(d, "iSerialNumber", 0):
                        serial = usb.util.get_string(d, d.iSerialNumber)
                except Exception:
                    pass
                out.append({
                    "vid": vid, "pid": pid, "serial": str(serial or ""),
                    "product": str(product or ""), "manufacturer": str(manufacturer or ""),
                    "desc": str(product or ""), "status": "",
                    "instance": "", "bus": getattr(d, "bus", None),
                    "address": getattr(d, "address", None),
                })
            except Exception:
                continue
    except Exception:
        return None
    return out


def _sysfs_str(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _via_sysfs() -> Optional[List[Dict[str, Any]]]:
    root = "/sys/bus/usb/devices"
    if not os.path.isdir(root):
        return None
    out: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return None
    for name in names:
        if ":" in name:
            continue
        base = os.path.join(root, name)
        vid = _sysfs_str(os.path.join(base, "idVendor")).lower()
        pid = _sysfs_str(os.path.join(base, "idProduct")).lower()
        if not vid or not pid:
            continue
        out.append({
            "vid": vid, "pid": pid,
            "serial": _sysfs_str(os.path.join(base, "serial")),
            "product": _sysfs_str(os.path.join(base, "product")),
            "manufacturer": _sysfs_str(os.path.join(base, "manufacturer")),
            "desc": _sysfs_str(os.path.join(base, "product")), "status": "",
            "instance": "", "bus": _sysfs_str(os.path.join(base, "busnum")) or None,
            "address": _sysfs_str(os.path.join(base, "devnum")) or None,
        })
    return out


def _powershell_available() -> bool:
    """Windows 原生、或 WSL 里能调到 powershell.exe（用于 WMI 枚举真实设备）。"""
    if sys.platform in ("win32", "cygwin"):
        return True
    import shutil
    return shutil.which("powershell.exe") is not None


def _enumerate_raw() -> Tuple[List[Dict[str, Any]], str]:
    """返回 (原始设备列表, 实际枚举方式)。Windows/WSL 优先 WMI。"""
    # WMI 在 Windows 上最可靠且不依赖任何驱动；WSL 里若可调用 powershell.exe
    # 也能列出主机 USB（比 WSL 内 pyusb 看不到设备更真实）
    if _powershell_available():
        devs = _via_wmi()
        if devs is not None:
            return devs, "wmi"
    devs = _via_pyusb()
    if devs is not None:
        return devs, "pyusb"
    devs = _via_sysfs()
    if devs is not None:
        return devs, "sysfs"
    return [], "unavailable"


def enumerate_devices(include_all: bool = False) -> Dict[str, Any]:
    """枚举当前连接的调试探针（每个物理设备一条）。

    返回：{ok, available, method, count, supported: [...], others?: [...],
           error?, platform}
    supported 每项含 vid/pid/serial/name/backend/iface/... ，serial 可直接
    作为 POST /api/connect 的 serial 参数。
    """
    raw, method = _enumerate_raw()
    available = method != "unavailable"
    result: Dict[str, Any] = {
        "ok": True, "available": available, "method": method,
        "platform": sys.platform, "count": 0, "supported": [],
    }
    if not available:
        result["error"] = (
            "无法枚举 USB 设备：Windows 需 PowerShell/WMI（本环境不可用）；"
            "Linux/WSL 需 pyusb 或 /sys/bus/usb/devices（WSL2 默认不透传 USB，"
            "请用 usbipd 挂载或在 Windows 侧运行服务）"
        )
        return result

    supported: List[Dict[str, Any]] = []
    others: List[Dict[str, Any]] = []
    for idx, d in enumerate(raw):
        vid, pid = d.get("vid", ""), d.get("pid", "")
        desc = d.get("desc", "") or d.get("product", "")
        info = _lookup(vid, pid, desc)
        base = dict(d)
        base["key"] = "%s:%s:%s@%s" % (vid, pid, d.get("serial", ""), idx)
        if info:
            merged = dict(base)
            merged.update(info)
            merged["supported"] = True
            supported.append(merged)
        else:
            base["supported"] = False
            others.append(base)

    result["supported"] = supported
    result["count"] = len(supported)
    if include_all:
        result["others"] = others
        result["total"] = len(raw)
    return result


__all__ = ["enumerate_devices", "KNOWN"]
