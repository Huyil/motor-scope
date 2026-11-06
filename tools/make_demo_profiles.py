#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 profiles/demo/ 下的「仿真演示符号表」。

背景：仓库不跟踪 profiles/ 各机型的 signals.json（那是用户在自己机器上
从固件 AXF 生成的私有数据）。但新用户 clone 后如果直接进仿真模式，
左栏会是空的——没有任何信号可加波。

本脚本生成一份**仅用于仿真演示**的符号表：变量名取 SimSource 认识的名字
（见 scope_server.py 的 SimSource.read），地址是仿真内存里的假地址，
不指向任何真实外设。真实固件仍须用 AXF 重建信号表。

用法：
    python tools/make_demo_profiles.py
"""
from __future__ import annotations

import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEMO_DIR = os.path.join(ROOT, "profiles", "demo")

# 仿真源认识的信号：name -> (size, signed, unit, axis, 说明)
SIM_SIGNALS = [
    ("motor.over.current", 4, True, "A", "right", "相电流（仿真：随负载波动）"),
    ("motor.over.thresholdLast", 4, False, "A", "right", "堵转阈值（仿真：随转速档位变化）"),
    ("adc.RES[0]", 4, False, "counts", "left", "ADC 采样原始值（含高频纹波）"),
    ("motor.Scfg.vol", 4, False, "V", "right", "母线电压估算"),
    ("motor.Scfg.speed", 4, False, "rpm", "right", "转速设定"),
    ("motor.speedlevel", 4, False, "", "right", "转速档位 1..35"),
    ("motor.state", 2, False, "", "right", "状态机状态（3 巡航 / 4 过载）"),
    ("motor.over.offsetThreshold", 4, False, "", "right", "过载阈值偏移"),
    ("motor.over.offset", 4, False, "", "right", "过载偏移基线"),
    ("motor.over.totalOverTick", 4, False, "tick", "right", "累计过载 tick"),
    ("motor.power", 2, False, "", "right", "运行/停机标志"),
    ("adc.conts", 2, False, "", "right", "ADC 采样计数（滚动）"),
    ("sys.state", 2, False, "", "right", "系统状态"),
]

# 仿真测试波形族（SimSource 对 "sim." 前缀走 sim_test_wave）
SIM_WAVES = [
    ("sim.sawtooth", "锯齿波"),
    ("sim.triangle", "三角波"),
    ("sim.square", "方波"),
    ("sim.noise", "噪声"),
    ("sim.spike", "尖峰"),
    ("sim.ripple", "纹波"),
]

PROFILES = [
    ("DR2159", "CW32L011", 0x20000000),
    ("DR1152", "CW32L012", 0x20000000),
    ("DR1152_CH", "CH32V203C8T6", 0x20000000),
    ("LKS32-FOC", "LKS32MC07x", 0x20000000),
]


def build_one(mcu: str, base: int) -> dict:
    variables = []
    for i, (name, size, signed, unit, axis, desc) in enumerate(SIM_SIGNALS):
        # 假地址：仿真模式下地址只用于标识，不会真的去读硬件
        addr = base + 0x100 + i * 4
        variables.append({
            "name": name,
            "addr": addr,
            "size": size,
            "signed": signed,
            "type": "int32_t" if size == 4 else "int16_t",
            "bit": None,
            "group": name.split(".")[0],
            "desc": desc,
            "unit": unit,
            "axis": axis,
        })
    for i, (name, desc) in enumerate(SIM_WAVES):
        addr = base + 0x400 + i * 4
        variables.append({
            "name": name,
            "addr": addr,
            "size": 4,
            "signed": True,
            "type": "int32_t",
            "bit": None,
            "group": "sim",
            "desc": desc + "（仿真测试波形）",
            "unit": "",
            "axis": "right",
        })
    return {
        "meta": {
            "generated_at": "demo",
            "axf": "",
            "mcu": mcu,
            "ram": [base, base + 0x3000],
            "variable_count": len(variables),
            "peripheral_count": 0,
            "profile": "demo",
            "note": "仿真演示用假符号表：地址不指向真实外设，"
                    "实机前必须用固件 AXF 重建（接口 /api/catalog/import 或"
                    "「重建当前机型符号」）。",
        },
        "variables": variables,
        "peripherals": [],
        "defaults": [
            "motor.over.current",
            "motor.over.thresholdLast",
            "adc.RES[0]",
            "motor.Scfg.speed",
        ],
        "stall": {
            "current": "motor.over.current",
            "threshold": "motor.over.thresholdLast",
        },
    }


def main() -> None:
    os.makedirs(DEMO_DIR, exist_ok=True)
    # 每个机型一份文件名，便于按 profile id 取用
    for pid, mcu, base in PROFILES:
        data = build_one(mcu, base)
        path = os.path.join(DEMO_DIR, "%s.signals.json" % pid)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print("生成 %s (%d 变量)" % (os.path.relpath(path, ROOT),
                                    len(data["variables"])))
    # 一份说明
    readme = os.path.join(DEMO_DIR, "README.md")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(
            "# 仿真演示符号表\n\n"
            "这里的 `*.signals.json` 只用于**仿真模式演示**：\n\n"
            "- 变量名取 `SimSource` 能识别的名字（`motor.over.current` 等），"
            "所以连仿真后能立刻加波看到曲线；\n"
            "- 地址是假地址，**不指向任何真实外设**；\n"
            "- `profiles/<机型>/signals.json` 缺失时，服务端会自动回退到这里，"
            "并在日志里提示「演示符号表」。\n\n"
            "**实机使用前必须重建**：导入真实固件的 AXF"
            "（UI「导入 AXF」或 `POST /api/catalog/import`），"
            "或用「重建当前机型符号」按钮。\n\n"
            "重新生成：`python tools/make_demo_profiles.py`\n"
        )
    print("生成 %s" % os.path.relpath(readme, ROOT))


if __name__ == "__main__":
    main()
