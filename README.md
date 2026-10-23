# MotorScope · DR2159

> 用 OpenOCD **活体**读 CW32L011 的 RAM / 外设寄存器，在浏览器里画时间轴波形，
> 专门用来观察 **电机电流 vs 堵转阈值**。不 halt、不写内存、不碰电机输出。

![总览](docs/overview.png)

实机连接（电机未启动时 `current=0`；`thresholdLast=50`、`vol=1050`）：

![实机](docs/real-hardware.png)

---

## 1. 它是怎么工作的

```
浏览器 UI  ──HTTP / SSE──▶  scope_server.py  ──Tcl RPC(tcl_port)──▶  openocd.exe
                                   │                                      │
                                   │  AXF/DWARF + map + cw32l011.h        │ SWD
                                   ▼                                      ▼
                              signals.json                          H7-TOOL → CW32L011
```

- 服务器启动一个 `openocd.exe`，只开 `tcl_port`（telnet/gdb 都关掉），
  用 Tcl 的 `read_memory` 原语读目标内存。
- 每轮采样把所有信号归并成 **尽量少的连续块**，一条 Tcl 命令一次读完；
  不调用 `halt`，电机可以边跑边看。
- 浏览器只收原始整数，缩放/单位/左右轴都在前端改，改标定不用重采样。
- 没有硬件时切到“仿真”源，UI、堵转判定、录制、CSV 全部可以演示。

---

## 2. 快速开始

### 2.1 有硬件

前提：

1. 目标板得电（SWD 不给板子供电）；
2. H7-TOOL 接 SWD：`PA13=SWDIO`、`PA14=SWCLK`，排线方向正确；
3. **没有别的调试器占着 H7-TOOL**（Keil 下载/调试、另一个 openocd 都要先退出）。

然后：

```bat
tools\motor_scope\start_scope.bat
```

它会：

1. 自动找 `tools\openocd`（本工程外层 `D:\Code\DR2159\tools\openocd`，
   没有就退回 `D:\Code\CW32L012_FLASH_Programming\tools\openocd`）；
2. 选一个空闲端口起 `openocd.exe`，`tcl_port` + 关 telnet/gdb；
3. 读 `CPUID=0x410CC601` 握手；
4. 打开 `http://127.0.0.1:8765/`（被占用会自动 +1，看控制台输出的 URL）。

启动参数可以覆写，例如：

```bat
start_scope.bat --port 8790 --rate 50
```

### 2.2 没硬件 / 只想看 UI

```bat
tools\motor_scope\start_scope_sim.bat
```

或者在连接卡片上点 **“先看仿真”**。仿真是一个 30 秒循环：
升速 → 加负载跨阈值 → 卸载 → 巡航 → 降速，首尾连续，不会在窗口里跳变。

### 2.3 已经有 openocd 在跑

如果手工起的 openocd 已经开了 `tcl_port 6666`：

```bat
python scope_server.py --attach 127.0.0.1:6666 --open
```

---

## 3. 界面

![连接](docs/connect.png)

- **左栏 · 变量**：从 AXF 的 DWARF 里抽出来的 RAM 变量/结构体字段/位域，
  按 `motor`、`adc`、`sys` 等对象分组；搜索支持名字/地址。
- **左栏 · 外设**：`ADC`、`ATIM`、`GTIM1/2`、`GPIOA/B/C`、`SYSCTRL`……
  寄存器按 `TypeDef` 展开；点 `+` 看位域（`ADC.CR.EN` 这种），
  可以单独把某一位加进波形。
- **左栏 · 自定义**：直接填 `0x20000344` + 长度 + 有无符号，读任意地址。
- **中栏**：时间轴波形。默认 **左轴 = 电流/阈值/ADC（counts）**，
  **右轴 = 电压/转速/档位等上下文**；图例里带 `R` 的是右轴。
- **顶部**：连接、暂停/继续、清空、录制、CSV、截图、设置。
- **底部**：样本数、实际速率、延迟、录制状态、OpenOCD 日志。

![设置](docs/settings.png)

设置里可以：

- 切换信号源（OpenOCD / 附加 TCL / 仿真）、填 OpenOCD 根目录或已有 TCL 端口；
- 改采样率（20/50/100/150/200 Hz）；
- 指定“电流信号”和“阈值信号”，开/关堵转判定、触发时自动暂停；
- 给每路信号填 `缩放 / 偏移 / 单位 / 左轴L或右轴R`；
- 从 AXF 重新生成符号表、下载后端录制 CSV。

---

## 4. 信号目录

### 4.1 来源

`signals.json` 由 `gen_signals.py` 生成：

- **固件变量**：`MDK/Objects/DR2159.axf` 的 DWARF（变量、结构体、数组、位域）；
- **外设寄存器**：同一份 DWARF 里的 `*_TypeDef`，地址来自
  `Libraries/inc/cw32l011.h` 的 `CW_xxx` 宏；
- **参考**：`MDK/Objects/DR2159.map` 只用于元信息。

当前生成结果：**441 个变量叶子 / 27 个外设**。

固件重新编译后地址会变：

- 服务器启动时若发现 `DR2159.axf` 比 `signals.json` 新，会自动重建；
- 也可以点界面上的 **“刷新”** 或设置里的 **“从 AXF 重新生成”**；
- 或直接跑：

```bat
tools\motor_scope\regen_signals.bat
```

> 需要 `pyelftools`（`pip install pyelftools`）。运行时本身只用 Python 标准库。
> **地址和烧录进板子的固件必须是同一次 build**；对不上时数值会“看起来像”，
> 对不上时先看设置页底部的 `AXF 时间`，重新生成并重新烧录。

### 4.2 本工程最常用的信号

| 信号 | 类型 | 说明 |
| --- | --- | --- |
| `motor.over.current` | u16 | **固件堵转判决用的电流**；50ms 电机任务里从 `adc.RES[0]` 抄过来 |
| `motor.over.thresholdLast` | u16 | **实际判决门限**（`motor_getOver()` 算出来的 `stopThreshold`） |
| `motor.over.threshold` | u16 | 当前档位表里的基础阈值 |
| `motor.over.stopThreshold` | u16 | 恢复门限 |
| `motor.over.offsetThreshold` | u16 | 超阈值时间越长，门限往下压的偏移 |
| `motor.over.offsetHighLoad` | u16 | 持续大电流时往下压的偏移 |
| `motor.over.totalOverTick` | u16 | 固件自己的“超阈值 tick”计数 |
| `motor.over.msTick` | u32 | 自适应 offset 的 tick 基准 |
| `adc.RES[0]` | u16 | ADC 中断里原始电流通道值（比 50ms 任务快，但有环形缓冲索引） |
| `adc.conts` | u8 | `adc.RES[]` 当前写指针（0..9） |
| `motor.Scfg.vol` | u16 | 调压目标（`VM_PWM`，右轴 duty） |
| `motor.Scfg.speed` / `lastspeed` | u16 | PWM 比较值 |
| `motor.speedlevel` | u8 | 档位 1..35 |
| `motor.state` | enum | `0 STOP`、`1 TURN`、`2 RUNUP`、`3 RUNNING`、`4 OVER`、`5 SLEEP0`、`6 SLEEP`、`7 BREAK`、`8 WAITCHANGE` |

> `adc.RES[]` 是环形缓冲，`adc.RES[0]` 不一定是“最新”样本；固件自己也是读
> `adc.RES[0]` 算电流，所以要和固件判决对齐时以 `motor.over.current` 为准。

### 4.3 外设寄存器 / 位域

DWARF 里带了完整寄存器布局，例如：

- `ADC.CR`、`ADC.RESULT0`、`ADC.ISR`、`ADC.SQRCFR`
- `ADC.CR.EN`、`ADC.CR.BGREN`、`ADC.SAMPLE.SQRCH0`
- `GPIOA.IDR`、`GPIOB.ODR`
- `ATIM.CCR1/CCR2/CCR4`、`ATIM.CNT`、`ATIM.ARR`
- `SYSCTRL.*`、`FLASH.*`

注意：**有些寄存器读操作本身有副作用**（读清零/读后更新），
这类地址不要高频扫；外设寄存器是“顺带看看”，主用途还是 RAM 变量。

### 4.4 重新生成后 UI 怎么对齐

- 设置页顶部会显示当前 `AXF` 的生成时间；
- “从 AXF 重新生成”会按 `id`（信号名）重新解析地址，已选信号不丢；
- 如果固件改动导致某个变量被删，UI 会跳过它；
- 重新生成会丢掉当前波形缓冲（地址变了，旧样本不能混用）。

---

## 5. 堵转阈值怎么看

### 5.1 固件实际逻辑

`code/motor/app_motor.c`：

```c
motor.over.current = adc.RES[0];

stopThreshold = motor.over.threshold
              - mode * 10
              - motor.over.offsetThreshold
              - motor.over.offsetHighLoad;

motor.over.thresholdLast = stopThreshold;
if (current >= stopThreshold) { ... 进入 MOTOR_OVER ... }
```

- `mode` 随 `overlevel`（0/1/2）变化；
- `offsetThreshold` 随“连续超阈值时间”增大；
- `offsetHighLoad` 随“持续大电流”增大；
- 最终固件在 50ms 任务里比较 `current >= stopThreshold`。

### 5.2 UI 的红带 / 计数

- 默认电流 = `motor.over.current`，阈值 = `motor.over.thresholdLast`；
- 每个采样点比较 `current >= threshold`；
- 连续超过阈值画红带；**600ms 内的抖动会合并成一次**（否则电流在门限附近
  抖一下就会变成很多个 0.1s 的假事件）；
- 右上角显示触发次数、当前/上次持续时间、余量；
- 勾选“触发时自动暂停”会把画面冻结在触发点。

> 这是**观察用的近似**：固件在 50ms 任务里判，UI 按采样到的瞬时值判；
> 采样率 100Hz 时两者很接近，但不是固件保护逻辑的替代品。
> 要确认固件到底有没有判，叠加 `motor.state`（4=OVER）和
> `motor.over.totalOverTick`。

### 5.3 电流 counts → 安培

默认显示原始 ADC counts。若知道采样电阻 `Rshunt` 和放大倍数 `Gain`：

```
I(A) = counts × (Vref / 4095) / (Rshunt × Gain)
```

在“信号标定”里填：

```
缩放 = 3.3 / 4095 / (Rshunt × Gain)
偏移 = 0
单位 = A
```

例：`Rshunt=0.01Ω`、`Gain=20` → `缩放≈0.00403 A/count`。
**先用万用表/钳流表对一次**，不要拿理论值当标定。

---

## 6. 采样链路与性能

- 一轮采样 = 把所有选中信号的地址按 `(addr, size)` 排序，合并成
  “地址间隔 ≤ 64 字节、总长 ≤ 256 字节”的连续块；一条 Tcl 命令里对每块
  调 `read_memory`，返回所有 32bit 字，再按字节/位域解码。
- 本机实测（4MHz SWD、4 路信号、合并成 13 words 一块）：
  **目标 100Hz，实际约 94Hz**；三块分开读约 6ms/轮，合并后约 2ms/轮。
- 选中的信号越多、地址越散，实际速率越低；界面底部会显示实际值。
- 200Hz 选项在信号少、地址集中时才有意义；读不动就降到 50/100Hz。
- 采样率是“尽力而为”：读一轮超过周期时会自动降速，不会堆积。

**看不到 20kHz PWM 纹波**。这个链路是 SWD + Tcl，不是 RTT/DMA/逻辑分析仪；
要看高频细节，用 `adc.RES[0]` 也只能看到采样率以内的包络。

---

## 7. 命令行 / 测试

```bash
python scope_server.py --auto --open          # 自动连 openocd 并开浏览器
python scope_server.py --sim --open           # 仿真
python scope_server.py --attach 127.0.0.1:6666 --open
python scope_server.py --port 8790 --rate 50
python scope_server.py --openocd D:\Code\DR2159\tools\openocd
python gen_signals.py                          # 重建 signals.json
python -m unittest tests.test_core tests.test_history -v   # 区域/位域/历史游标单测
```

Agent / 脚本读取用的 HTTP API（`/api/history` 读之前、`/api/history/next` long-poll 读之后）见 **[API.md](API.md)**。

没有硬件也可以验证 Tcl 客户端：

```bash
python tests/mock_tcl.py 6767
python scope_server.py --attach 127.0.0.1:6767 --open
```

---

## 8. 文件

```
tools/motor_scope/
├─ scope_server.py      HTTP/SSE 服务、采样线程、仿真源、录制
├─ ocd.py               OpenOCD Tcl-RPC 客户端、进程管理、区域规划
├─ gen_signals.py       AXF/DWARF + cw32l011.h → signals.json
├─ signals.json         生成的信号目录（当前 441 变量 / 27 外设）
├─ start_scope.bat      一键启动（自动连 OpenOCD）
├─ start_scope_sim.bat  一键仿真
├─ regen_signals.bat    重新生成符号
├─ requirements.txt     pyelftools（仅重建符号时需要）
├─ API.md              Agent/脚本用的 HTTP API（history/next/status/catalog）
├─ web/                 index.html / style.css / app.js（原生 canvas，无前端依赖）
├─ tests/               mock_tcl.py + test_core.py
└─ docs/                截图
```

---

## 9. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `Error connecting DP: cannot read IDR` | 目标板没电、SWD 排线方向错、或 H7-TOOL 被 Keil/别的 openocd 占用 |
| `CMSIS-DAP command mismatch` | 上一个 `openocd.exe` 没退，还占着 H7-TOOL；任务管理器结束它。本工具用 Windows Job Object 兜底，正常退出/被强杀都会带走子进程 |
| 连接超时 / 找不到 OpenOCD | 设置里填 OpenOCD 根目录；需要 `bin/openocd.exe` + `share/openocd/scripts/interface/cmsis-dap-v1.cfg` + `.../target/cw32l01x-flm.cfg` |
| 数值全 0 / 明显不对 | 板子里的固件和 `DR2159.axf` 不是同一次 build；重新生成符号并烧录。看设置页底部 AXF 时间 |
| 实际速率远低于目标 | 信号太多/地址太散；减少信号、降低频率，或把相邻变量一起选 |
| 浏览器打开是空白/端口跳了 | 看控制台 URL；8765 被占用会自动 +1 |
| 读某个寄存器后系统异常 | 该寄存器可能是读清零/读后触发；不要高频扫，先查用户手册 |
| 暂停后画面不动 | 正常；数据仍在后台缓存，点继续会追上 |
| 想连已有 openocd | “附加 TCL”，填 `127.0.0.1:6666` |

---

## 10. 只读声明与限制

- 工具**只调用 `read_memory`**：不写内存、不 halt、不 reset、不发电机命令。
- 但“读”不等于绝对无副作用：个别 SFR 是读清零/读后更新，需按芯片手册判断。
- 同一时刻只能有一个 OpenOCD 占用 H7-TOOL；烧录时不要开这个工具。
- 采样率受 SWD/Tcl 限制，不能替代示波器/逻辑分析仪看 PWM 级细节。
- 地址来自 AXF；固件版本必须匹配。换 build 后先重新生成符号并烧录。
- 仿真源只用于 UI 演示，数值不是真实电机模型。

---

_OpenOCD 使用工程自带的 `tools/openocd`（源出 `CW32L012_FLASH_Programming`），
调试器 H7-TOOL（CMSIS-DAP）。_
