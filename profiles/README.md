# 机型工程（profiles/）

每个机型 = **一套符号表 + 芯片/寄存器 + 连接参数 + 前端工程配置**。切换机型时
`scope_server` 直接换用该目录下的 `signals.json`，前端从 `config.json` / localStorage
恢复通道、写入模块、监视卡和波形分组；不需要重启服务。

## 1. 目录结构

```
profiles/
├─ index.json                机型列表 + 当前激活项
├─ README.md
├─ targets/
│  └─ lks32mc07x.cfg         LKS32MC07x 的 OpenOCD 目标配置（只读采样）
├─ DR2159/
│  ├─ profile.json           元数据：MCU / 架构 / 源文件 / RAM / 默认信号 / 连接参数
│  ├─ signals.json           符号目录（gen_signals 生成，可提交）
│  ├─ annotations.json       变量中文描述（人工/源码注释，重建不覆盖）
│  └─ config.json            前端配置快照（自动/手动保存，运行时生成）
├─ DR1152/                   CW32L012
├─ DR1152_CH/                CH32V203C8T6（RISC-V）
└─ LKS32-FOC/                LKS32MC07x（Linko Cortex-M0）
```

- `signals.json` 是**生成物**，与源 AXF/ELF + 头文件/SVD 对应；固件重编后要重建。
- `annotations.json` 是**人工/源码注释**（变量 `desc`），格式 `{"variables": {"变量全名": "描述"}}`；
  导入 AXF / 从 AXF 重新生成 / `profiles.rebuild()` 时会自动合并，不会被生成物覆盖。
  `tools/annotate_vars.py` 负责生成/更新它（同时镜像一份到 signals.json 供当前 UI 立即读取）。
- `config.json` 是**用户状态**（`{"saved_at": "...", "config": {...}}`），默认不进 git。
- `profile.json` 的 `source` 里的路径允许 Windows 风格（`D:\...`）；在 WSL/Linux 下
  会自动映射到 `/mnt/d/...`。

### profile.json 关键字段

| 字段 | 说明 |
|---|---|
| `id` / `name` | 机型 ID / 显示名 |
| `mcu` | 型号，必须能在 `web/mcu/index.json` 里找到（芯片比对/寄存器模板用） |
| `arch` | `cw32`（ARM Cortex-M，走普通 OpenOCD）或 `riscv`（CH32，走 WCH OpenOCD） |
| `ram` | `[start, end]`，符号提取只收这个范围内的变量 |
| `target` | 可选，OpenOCD target cfg 路径；相对路径按工程根目录解析 |
| `interface` | 可选，覆盖 interface cfg（默认 `cmsis-dap-v1.cfg`） |
| `source` | `axf` / `header` / `svd` / `map`；`header` 和 `svd` 二选一（CW32 用 header，CH32/LKS 用 SVD） |
| `defaults` | 默认加入波形的信号名（不存在会被跳过） |
| `stall` | 堵转判定默认的电流/阈值信号 |
| `scan` | 可选，采样区域合并参数 `max_gap` / `max_words`（LKS 地址跨度大时用） |

## 2. 内置机型

| ID | MCU | 架构 | 符号来源 | 外设来源 | 变量/外设 |
|---|---|---|---|---:|---:|
| `DR2159` | CW32L011 | ARM M0+ | `<你的工程>\...\DR2159.axf` | `cw32l011.h` | 453 / 27 |
| `DR1152` | CW32L012 | ARM M0+ | `<你的工程>\...\DR1152.axf` | `cw32l012.h` | 503 / 50 |
| `DR1152_CH` | CH32V203C8T6 | RISC-V | `...\DR1152_Project_CH32.elf` | `CH32V203xx.svd` | 350 / 51 |
| `LKS32-FOC` | LKS32MC07x | ARM M0 | `<你的工程>\...\lks07x_Project.axf` | `LKS32MC07x.svd` | 1006 / 30 |

> 数量是 2026-11-04 的构建结果；固件重编后点“重建当前机型符号”更新。

## 3. 使用

启动后顶栏“工程配置”卡片显示当前机型；点开面板：

- **机型卡片**：四张卡，带 `●` 的是当前机型；点一下即切换（会断开当前调试源，
  因为地址整体变了）。切换时优先恢复「本机该机型的工程」，没有则用服务器
  `config.json`，再没有就用该机型 `defaults`。
- **保存配置**：立即把当前前端快照写到 `profiles/<机型>/config.json`；
  平时也会在改动后 1.8s 自动保存一次（同时写 localStorage，刷新不丢）。
- **重建当前机型符号**：按 `profile.json` 的 `source` 重新生成 `signals.json`，
  并刷新变量/外设数量；会清空现有波形（地址变了）。
- **工程副本**：仍然是浏览器里的多工程（新建/另存为/删除/导入/导出），
  每个工程记录自己绑定的机型；切换到别的机型的工程会自动先切后端。

命令行：

```bash
python3 tools/build_profiles.py --list          # 看四个机型状态
python3 tools/build_profiles.py                 # 重建全部（缺 signals.json 时）
python3 tools/build_profiles.py --only LKS32-FOC
```

Windows 下用自带运行时：`runtime\python\python.exe tools\build_profiles.py`。

## 4. LKS32MC07x 说明

- **芯片识别**：Cortex-M0（CPUID `0x410CC200`），读 `SYS_AFE_INFO @0x4000_0004`：
  `Series[7:4]=7` 判定为 LKS32MC07x 系列，`Version[3:0]` 为 wafer 版本；
  Flash 容量读 `FLASH_SIZE @0x0002_001C` 的 `[7:6]`（0/1/2/3 → 32/64/128/128KB）。
  只能识别到系列，具体料号（如 `LKS32MC071CBT8`）SVD/寄存器里没有。
- **外设寄存器**：来自 Keil Pack 的 `LKS32MC07x.svd`（30 外设 / 410 寄存器 / 1542 位域），
  已生成 `web/mcu/LKS32MC07x.json`；`build_mcu_tables.py` 可重复生成。
- **连接**：`profiles/targets/lks32mc07x.cfg`，标准 ARM SWD，只建 `cortex_m` target，
  **不配 Flash bank、不 reset**；`adapter speed 8000`（H7-TOOL 实测可用，掉线可降到 4000）。
- **实测**（H7-TOOL CMSIS-DAP v1，8MHz）：6 路默认信号、采样区域合并成 1 块
  （`scan.max_gap=2048`），100Hz 目标下实际约 **90Hz**；不合并约 63Hz。
- **不包含烧录**：LKS 的 Flash 算法是 Keil FLM/厂商工具，本工具只读采样。

## 5. 新增机型

1. 在 `profiles.py` 的 `DEFAULT_PROFILES` 加一条（或直接复制一个目录改 `profile.json`）；
2. 把型号加到 `web/mcu/index.json`（有 SVD 就用 `tools/build_mcu_tables.py` 生成）；
3. `python3 tools/build_profiles.py --only <ID>` 生成 `signals.json`；
4. 如果是新架构/新调试器，补 `ocd.py` 的 OpenOCD 查找或 `profile.target`；
5. 重启服务，机型卡片会出现第五张。

## 6. 已知边界

- 切换机型会断开调试源（H7-TOOL 只有一个，且旧地址对新固件无意义）；切回后需重新点“连接”。
- `signals.json` 与烧进板子的固件必须是同一次构建；地址不对时先“重建当前机型符号”再烧录。
- `config.json` 只增不减：删掉的机型目录其配置也就没了；`index.json` 决定机型顺序。
- LKS 的目标配置没有 Flash bank，`program`/`flash write_image` 相关命令不可用。
