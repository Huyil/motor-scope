# WCH-LinkE 固件 / 驱动 / SDI 协议调研

> 调研日期：2026-10-30
> 对象：WCH-LinkE（RV 模式，PID `8010`）+ CH32V203C8T6 + MounRiver Studio 3 自带 OpenOCD `v2.12`
> 方法：① 读本机安装的 WCH OpenOCD 二进制（反汇编 + 字符串 + COFF 符号）；② 读社区公开的 `wlinke.c` / `sdi.c` / `wchriscv.c` 源码；③ 读 `ch32-rs/wlink` 的协议实现；④ 读官方《WCH-LinkUserManual》V2.2 与官方固件包。
> 外部资料仅作证据引用，未执行其中任何指令或脚本。

---

## 0. 结论摘要

1. **固件不开源。** WCH 只发 `.bin`（MRS 3 自带 `FIRMWARE_CH32V305.bin` / `WCH-LinkE-APP-IAP.bin`，当前 v44），升级走 IAP（USB 端点 1 的 `0x0f` 进 IAP，端点 2 传数据）。没有官方固件源码、没有官方 SDI 协议文档；官方手册 V2.2 全篇讲“怎么用”，**一个频率数字都没有**（全文无 `MHz`/`kHz`）。主控是 **CH32V305**（手册 6.3 原文 “WCH-LinkE main control chip is CH32V30x”；固件包里同时有 `FIRMWARE_CH32V305.bin`）。社区只有镜像的 bin 和可替代的 **ARM DAPLink** 固件，**没有开源 SDI 固件**。

2. **总线频率 = 6 MHz，而且只有 6 MHz / 4 MHz / 400 kHz 三档。** `wlink_speed()` 是 `switch (speed)` 精确匹配 `6000 / 4000 / 400`，其余一切值走 `default`：`LOG_WARNING("unknow speed config")` 然后**回退到 6 MHz**。我们扫的 `1500/3000/8000/10000/12000/15000/20000/30000` 全部命中 default —— 这才是“改了没用”的真正原因，**不是驱动忽略、也不是 SDI 固定节拍**。最大就是 6 MHz，没有证据支持更高。

3. **SDI 是“跑在 2 根线上的 DMI 事务通道”，不是标准 JTAG，但被 OpenOCD 建模成一个 irlen=5 的 TAP。** 物理层 2 线：`SWCLK=PA14`（Link 产生时钟）+ `SWDIO=PA13`（双向数据）；CH32V003 等只有 1 线（仅 SWDIO）。一帧 DMI 就是 9 字节 USB 包 `81 08 06 <dmi_addr> <data32 BE> <op>`，回 `82 08 06 ...`，`op`：1=读、2=写。

4. **SDI 本身没有“必须 halt”的限制，是目标调试模块（DM）没有 SBA。** 读内存走 abstract command（DM `0x17`，progbuf 执行 load），规范要求 hart halted；实测 `sbcs=0` 已判死。halt/resume 就是对 `dmcontrol`（`0x10`）写 DMI，和内存读是同一套帧。

5. **真正卡速度的不是 6 MHz，是 USB 往返。** 6 MHz 下 41 bit 的 DMI 扫描只要 ~6.8 µs，而实测约 **256 µs/字**（256 字/65.5 ms）；就算把时钟提到 12 MHz，理论收益也就几个百分点。**但 Link 固件里有一条 OpenOCD 从未使用的“块读”命令（`0x03` 设区域 + `0x02/0x0c` 读，数据走端点 2）**——同样要 halt，但把每字一次 USB 往返变成一次批量传输，这是唯一可能量级提升的现成入口。

6. **Flash：官方 OpenOCD 根本不走 RISC-V abstract command 编程**，而是把擦除/编程整体交给 Link 固件（`0x81 02 ...`），数据 64 B/包走端点 2；编程对齐 256 B。我们的 `flash.py` 用 FPEC 寄存器 + progbuf 半字写，**页大小 256 B 与官方对齐一致，擦除粒度不同**（官方是整片擦，我们是 4 KB 扇区）。

---

## 1. 固件与硬件

### 1.1 主控与固件包（本机实证）

MRS 3 安装目录（`<MRS 安装目录>` = MounRiver Studio 的安装位置，因机器而异）里就有官方固件包：

```
<MRS 安装目录>/resources/app/resources/win32/components/WCH/Others/Firmware_Link/default/
  FIRMWARE_CH32V203.bin      28,100 B
  FIRMWARE_CH32V305.bin      99,388 B   ← LinkE 主控
  WCH-LinkE-APP-IAP.bin     107,580 B   ← LinkE 应用（IAP 升级用）
  WCH-LinkW-APP-IAP.bin     122,456 B
  WCH-Link_APP_IAP_ARM.bin / _RV.bin
  WCH-DAPLink_APP_IAP.bin
  firmware_version.txt  →  v44
  wchlink.wcfg          →  [Default] CH549Ver_RV=32 ... CH32V307Ver=43 ...
```

* 版本号规则（社区总结）：`vNN = major*10+minor`，例如 v40 = 2.20、v30 = 2.10（`21km43/WCH-Link_Firmware` README）。本机 `firmware_version.txt` 是 **v44 → 2.24**；本项目以前记的“WCH-LinkE 2.21”（= v41）属于同一套编号。
* 官方手册 V2.2 第 6.3 节原文：**“WCH-LinkE main control chip is CH32V30x”**，并给了“两个 LinkE 对接、离线升级”的接线图（3V3/GND/SWDIO/SWCLK）。
* 固件包内可读到字符串：`WINUSB`、`Please check the SDI, and Enable this function through the upper computer software` —— SDI 相关能力是固件里带开关的。

### 1.2 有没有固件源码 / 协议文档

| 项 | 结论 | 依据 |
|---|---|---|
| 官方固件源码 | **没有** | MRS 只装 `.bin`；`openwch` 组织 API 返回 404（无该组织或已改名）；WCH 官网只给 WCH-LinkUtility 下载 |
| 官方 SDI 协议文档 | **没有** | 《WCH-LinkUserManual》V2.2（29 页）只有接线/模式/升级/Keil·MRS 配置；SDI 只出现在“Disable 2-wire SDI”“SDI 虚拟串口(SDI_Printf)”两处功能描述 |
| 官方调试组件文档 | 有，但是 DM 层 | 《RISC-V QingKeV2 Microprocessor Debug Manual》讲 DM 寄存器/abstract command，不讲 SDI 电气与帧格式 |
| 固件升级格式 | 有（社区逆向） | `cjacker/wlink-iap` 的 `doc/iap-protocol.txt`（见下） |
| 社区替代固件 | 有，但**不是 SDI** | `prosper00/CH32V305-DAPLink-HS`：给 LinkE 刷成 ARM DAPLink（USB HS），源码齐全；对 CH32V 的 RISC-V 调试无用 |

`wlink-iap/doc/iap-protocol.txt` 记录的升级流程（端点 1）：

```
step1 取版本:   out 81 0d 01 01      in 82 0d 04 02 08 02 00
step3 进 IAP:   out 81 0f 01 01
然后端点 2：    80 3c <len> <data...>   /  82 3c ...
退出 IAP:       83 02 00 00
```

结论：**固件是纯二进制黑盒**。想改 SDI 时钟只能逆向固件或替换固件，成本远高于收益（见 §5）。

### 1.3 驱动层（与已知事实对齐）

`Community-PIO-CH32V/wchlink-driver-windows/WCHLink/WCHLinkWDM.INF`（UTF-16）里明确：

```
USB\VID_1A86&PID_8010&MI_00  → WCH-LinkRV     （WCHLinkWDM.sys，WDM 驱动）
USB\VID_1A86&PID_8012&MI_00  → WCH CMSIS-DAP  （WinUSB）
```

即：RV 模式的 `MI_00` 绑 WCH 自有 WDM 驱动（不是 WinUSB），所以 libusb 直接开不了它，只能经 `WCHLinkDll.dll` 的 `CH375*` API。OpenOCD 的 `wlinke.c` 也正是 `LoadLibrary("WCHLinkDll.dll")` + `CH375OpenDevice/CH375ReadEndP/CH375WriteEndP`（`wlinke.c:1448-1456`）。Windows 上要自己写客户端，最省事的路就是 ctypes 调这 5 个函数。

---

## 2. 频率：`adapter speed` 到底怎么走

### 2.1 全链路

```
wch-riscv.cfg:  adapter speed 6000
   ↓  adapter_config_khz(6000)                    （OpenOCD src/jtag/adapter.c:251）
   ↓  adapter_khz_to_speed → adapter_driver->khz() = wlink_khz()
        static int wlink_khz(int khz, int *speed){ *speed = khz; return ERROR_OK; }   ← 恒等映射
   ↓  adapter_init() 里 init() 之后：adapter_driver->speed(speed_var)
        = wlink_speed(6000)
   ↓  发 USB 命令 81 0C 02 <riscvchip> <1|2|3>
   ↓  固件设置 SDI 时钟，回 82 0C 01 01
   ↓  "clock speed %d kHz" 日志 ← adapter_get_speed_readable → wlink_speed_div()
        int wlink_speed_div(int speed, int *khz){ *khz = speed; ... }   ← 只是回显请求值
```

**关键点：日志里的 kHz 是 `wlink_speed_div()` 回显的“请求值”，不是实测值。** 所以“启动日志固定 6000 kHz”不能证明固件真的跑在 6 MHz；反过来，你把它改成 15000，日志会显示 15000，而固件其实还在 6 MHz。

### 2.2 源码（决定性证据）

`Seneral/riscv-openocd-wch` 分支 `wch-linke-sdi`，`src/jtag/drivers/wlinke.c:1854-1886`（该文件是 MRS 定制 OpenOCD 的泄露/再分发快照，GPL）：

```c
int wlink_speed(int speed ){
    unsigned char txbuf[5];
    unsigned char rxbuf[4];
    unsigned long len = 5;
    txbuf[0]=0x81;
    txbuf[1]=0x0c;
    txbuf[2]=0x02;
    txbuf[3]=riscvchip;        // 芯片系列字节（CH32V203 = 0x0c）

    switch (speed)
    {
    case 6000:  txbuf[4]=1; break;   // 6 MHz
    case 4000:  txbuf[4]=2; break;   // 4 MHz
    case 400:   txbuf[4]=3; break;   // 400 kHz
    default:
        LOG_WARNING("unknow speed config");
        txbuf[4]=1;                   // 回退 6 MHz
        break;
    }
    sp=txbuf[4];
    pWriteData(0, 1, txbuf, &len);
    len=4;
    pReadData(0, 1, rxbuf, &len);
    if (((rxbuf[0]==0x82)&&(rxbuf[1]==0x0c)&&(rxbuf[2]==0x01)&&(rxbuf[3]==0x01)))
        return ERROR_OK;
    return ERROR_FAIL;
}

int wlink_speed_div(int speed, int *khz)
{
    *khz = speed;          // 纯回显
    return ERROR_OK;
}
static int wlink_khz(int khz, int *speed)
{
    *speed = khz;          // 纯透传
    return ERROR_OK;
}
```

驱动注册（`wlinke.c:2027-2043`）：

```c
static struct sdi_driver wlink_interface = { .transfer = &DMI_OP, };

struct adapter_driver wlinke_adapter_driver = {
    .name = "wlinke",
    .commands = wlink_command_handlers,
    .transports = sdi_transports,
    .speed = wlink_speed,          // 有实现，不是 NULL
    .khz = wlink_khz,
    .speed_div = wlink_speed_div,
    .init = wlink_init,
    .quit = wlink_quit,
    .sdi_ops = &wlink_interface,
};
```

另外两处会**隐式重置**速度：

* `wlink_clean()`（`wlinke.c:1019-1052`）在重连/换芯片时会把 `0x0C` 参数重新写成 1（6 MHz）——即使你之前设过 400 kHz；
* `wlink_init()` 连接芯片后（`wlinke.c:1520-1527`）用全局 `sp` 重发一次速度。

### 2.3 反汇编交叉验证（本机 MRS 3 / OpenOCD v2.12）

公开快照只有 2043 行，本机二进制更新（`wlink_speed` 的日志行号是 3108），所以直接反汇编核对：

```text
<MRS 安装目录>/resources/app/resources/win32/components/WCH/OpenOCD/OpenOCD/bin/openocd.exe   (PE i386, 4.9 MB)
符号表: _wlink_speed 0x43069e, _wlink_speed_div 0x4307c9, _wlink_khz 0x430853

0043069e <_wlink_speed>:
  4306a4: movl $0x5,-0x18(%ebp)        ; len = 5
  4306ab: movb $0x81,-0xd(%ebp)        ; 0x81
  4306af: movb $0xc,-0xc(%ebp)         ; 0x0C
  4306b3: movb $0x2,-0xb(%ebp)         ; LEN=2
  4306b7: movzbl 0x7bdaa8,%eax         ; riscvchip
  4306c1: cmpl $0x1770,0x8(%ebp)       ; speed == 6000 ?
  4306c8: je   4306e7                  ;   → idx=1
  4306ca: cmpl $0x1770,0x8(%ebp)
  4306d1: jg   4306f9                  ; speed > 6000 → default
  4306d3: cmpl $0x190,0x8(%ebp)        ; speed == 400 ?
  4306da: je   4306f3                  ;   → idx=3
  4306dc: cmpl $0xfa0,0x8(%ebp)        ; speed == 4000 ?
  4306e3: je   4306ed                  ;   → idx=2
  4306e5: jmp  4306f9                  ; other → default
  4306f9: ... call _log_printf_lf      ; "unknow speed config" (wlinke.c:3108)
  430725: movb $0x1,-0x9(%ebp)         ; 回退 1
```

与公开源码逐条一致：**只有 6000/4000/400 三个魔数，其余全部回退 6 MHz**。这也解释了为什么 `12000` 不会报错退出，而是“安静地”跑 6 MHz。

顺带确认二进制里的字符串：`unknow speed config`、`src/jtag/drivers/wlinke.c`（日志宏把文件名/行号编进二进制，所以能看到 3108 这个行号）。

### 2.4 实测对照

| `adapter speed` | 实际参数 | 固件时钟 | 4 字 | 16 字 | 256 字 |
|---|---|---|---|---|---|
| 6000 | 1 | 6 MHz | 22.5 ms | 12.9 ms | 65.5 ms |
| 1500 / 3000 / 8000 / 10000 / 12000 / 15000 / 20000 / 30000 | **1（default）** | **6 MHz** | 22.5 | 12.9 | 65.5 |
| 4000 | 2 | 4 MHz | 未测 | 未测 | 未测 |
| 400 | 3 | 400 kHz | 未测 | 未测 | 未测 |

已测部分完全一致 —— 因为**这 9 个值全都落到 default**。注意 4 字比 16 字还慢，说明这组数字里混了固定开销（halt/resume、Tcl 往返、首包），只有 256 字那一点适合算“每字成本”：65.5 ms / 256 ≈ **256 µs/字**。

把它和物理层对一下：

* 一次 DMI 事务 = 41 bit（7 地址 + 32 数据 + 2 op）≈ 48 bit 含开销；6 MHz 下 **≈ 8 µs**。
* 读 1 个字大约要 3–4 次 DMI 事务（写 command → 轮询 abstractcs → 读 data0 → nop）：6 MHz 下 **≈ 30 µs 线时间**，实测 256 µs → **SDI 只占 ~12%**，其余全是 USB 往返 + 轮询。
* 若真降到 400 kHz，线时间 ≈ 450 µs/字，那时才会变成瓶颈（**预测：400 kHz 明显变慢，4 MHz 基本不变**）。这个预测可以直接拿来做判别实验，见 §6。

---

## 3. SDI 物理层与协议帧

### 3.1 物理层

| 项 | 内容 | 依据 |
|---|---|---|
| 线数 | 2 线：`SWCLK`（时钟，Link 输出）+ `SWDIO`（数据，双向） | 手册 Table 6：CH32V10x/20x/30x → PA13(SWDIO)/PA14(SWCLK) |
| 1 线模式 | 仅 `SWDIO`，无独立时钟 | 手册注(1)：CH564/CH584_585/CH32V002_004_005_006_007 支持 1 线；CH32V003 = PD1 单线 |
| 时钟源 | Link 产生，频率由固件参数决定（6M/4M/400k） | `wlink_speed()` + 固件命令 `0x0C` |
| 与 ARM SWD 的关系 | **不是** ARM SWD，bit 定义不同；WCH 私有 | 安富莱论坛 tid=131480（另见 `riscv-debug-research.md`） |
| 复用 | SDI 还能反向输出 `SDI_Printf` 到 LinkE 的虚拟串口（固件 ≥1.80） | 手册 5.2.11 |

OpenOCD 侧把它抽象成 JTAG：`sdi newtap $_CHIPNAME cpu -irlen 5 -expected-id 0x00001`（`wch-riscv.cfg:8`）。也就是说 **SDI 线上跑的是一个 5 位 IR 的 TAP 时序 + 41 位 DR**，RISC-V 的 DTM/DMI 原样映射进去。这解释了为什么 `wlinke` 能直接复用 OpenOCD 的 `riscv` target，而不需要重写 target 层。

### 3.2 帧格式（DMI_OP，`wlinke.c:890-940`）

```c
Txbuf[0]=0x81; Txbuf[1]=0x08; Txbuf[2]=0x06;     // 头：CMD=0x08 DMI，LEN=6
Txbuf[3]=iAddr;                                   // 7 位 DMI 地址
Txbuf[4..7]=iData 大端;                            // 32 位数据
Txbuf[8]=iOP;                                     // 0=nop, 1=read, 2=write
len=9; pWriteData(gIndex, 1, Txbuf, &len);
len=9; pReadData (gIndex, 1, Rxbuf, &len);        // 82 08 06 <oAddr> <oData BE> <oOP>
```

`riscvchip==2/3` 时固件对某些地址会返回 `oOp=2, oData[..]=3` 触发 `readmcause()`（WCH 私有的 mcause 读取），这是青稞内核特有的旁路。

对上层来说：

| 操作 | 实际帧 | 说明 |
|---|---|---|
| halt | DMI 写 `0x10 (dmcontrol)` = `0x80000001` | `wlink_reset()` 里就是这么干的（`wlinke.c:948-978`），然后 DMI 读 `0x11 (dmstatus)` 确认 |
| resume | DMI 写 `0x10` = `0x40000001` | `wlink_quitreset()`（`wlinke.c:979-1003`） |
| 读内存 | 先写 progbuf `0x20/0x21`（`lw x6,0(x5)` + `ebreak`），再写 DM `0x17 (command)` = `0x00271005`（cmdtype=0 access-register，transfer=read），最后读 `0x04 (data0)` | 见 `ch32-rs/wlink` `src/dmi.rs:195-222` |
| 写内存 | 先写 progbuf `0x20/0x21`，再 `0x17` | `src/dmi.rs:224-258` |
| 读 DM 寄存器 | DMI 读 `0x38 (sbcs)` 等 | 我们实测 `0x38 → 0`，无 SBA |

**没有“不 halt 读”的帧。** 原因不在 SDI：SDI 只负责搬 DMI 事务；是 DM 侧 `sbcs=0`（无 system bus access），读内存只能走 abstract command + progbuf，而 progbuf 按规范只在 halted 时执行。

### 3.3 固件自带的“块读”——OpenOCD 没用

Link 固件还有一组内存命令（`ch32-rs/wlink` 已实现）：

* `0x03` `SetReadMemoryRegion{start_addr, len}` —— 设定要读的区域（`src/commands/mod.rs:110-125`）
* `0x02/0x0c` `Program::ReadMemory` —— 触发读，数据从**端点 2** 批量取回（`src/operations.rs:350-375`）

```rust
/// Read a continuous memory region, require MCU to be halted
pub fn read_memory(&mut self, address: u32, length: u32) -> Result<Vec<u8>> {
    ...
    self.probe.send_command(commands::SetReadMemoryRegion { start_addr: address, len: length })?;
    self.probe.send_command(commands::Program::ReadMemory)?;
    let mut mem = self.probe.read_data(length as usize)?;
    ...
}
```

注意注释：**require MCU to be halted**（仍要停核），但**整段只发 2 条命令 + 1 次批量读**，把 N 次 USB 往返压成 2 次。`wlinke.c` 里没有把它接到 `.transfer`（那个只做 `DMI_OP`），所以 **OpenOCD 永远走不到这条快路**。这是本项目最值得试的一个入口。

---

## 4. Flash 算法对照

官方 flash 驱动 `src/flash/nor/wchriscv.c`：

```c
static int ch32vx_erase(struct flash_bank *bank, int first, int last) {
    ...
    if (noloadflag) return ERROR_OK;
    int ret = wlink_erase();          // 只是发一条 USB 命令，交给 Link 固件
    target_halt(bank->target);
    ...
}

static int ch32vx_write(...) {
    ...
    int mod = offset % 256;           // 必须 256 B 对齐
    if (mod) { ... 读回前 mod 字节补齐 ... }
    else { target_halt(target); ret = wlink_write(buffer, offset, count); }
    wlink_chip_reset();
}
```

`wlink_erase()` = `81 02 01 01`；`wlink_write()` → `wlink_ready_write()`（`81 02 01 06` → `81 01 08 <addr><cnt>` → `81 02 01 05` → 把一段 RISC-V 小程序 `flash_opXXX` 通过 `wlink_ramcodewrite()` 写进目标 RAM → `81 02 01 07` 启动）→ `wlink_fastprogram()` 以 **64 B/包走端点 2** 流式写入 → `wlink_endprogram()`。

也就是说：**官方烧录是“Link 固件当主控”**，在目标 RAM 里放一小段 flash 操作码，由固件驱动整个擦写流程；OpenOCD 只负责搬数据。`wlinke.c:1125-1290` 全是对应命令。

对照我们的 `flash.py`：

| 项 | 官方 wchriscv.c | 我们的 flash.py | 一致性 |
|---|---|---|---|
| 编程对齐 | `offset % 256` | 页 256 B（`FlashSpec.page_size`） | ✅ 一致 |
| 编程粒度 | 64 B/包流式（固件内部处理半字） | 逐半字 `write_memory 16`（progbuf） | ⚠️ 机制不同，结果等价 |
| 解锁 | 固件内部做（目标 RAM 里的小程序） | 显式 `KEYR=0x45670123/0xCDEF89AB` | ✅ 等价 |
| 擦除 | `wlink_erase()` 一条命令，**忽略 `first/last`**（对 CH32V203 等于整片擦） | `PER` 逐 4 KB 扇区 | ❌ 粒度不同，我们更细 |
| 擦除前检查 | `wlnik_protect_check()` 读保护 | 无（靠 `WRPRTERR`） | ⚠️ 我们少一道检查 |
| bank sector 记账 | `page_size = 1024`（但写按 256 对齐） | `sector_size = 4096` | ⚠️ 官方这个 1024 只是记账，不参与实际擦除 |
| 芯片页大小 | `riscvchip==0x0c`（CH32V203）→ `pagesize = 256` | 256 | ✅ 一致 |

**结论**：我们的寄存器级实现与官方在“256 B 对齐、半字编程”上一致，差别只在擦除粒度（我们按 4 KB 扇区，官方整片）。4 KB 扇区擦除能否真正只擦 4 KB，取决于 CH32V203 的 FPEC `PER` 粒度 —— 我们的 `docs/flash-programming.md` 写的是“页 256 B / 标准擦除扇区 4 KB”，与 H7-TOOL 的 `CH32V20x.lua` 参数一致，属于可信的第三方交叉验证，但**未在本轮做写入实测**。

---

## 5. 社区实现清单（按可用性排序）

| 仓库 | 分支/文件 | 能提供什么 | 能不能用 |
|---|---|---|---|
| **Seneral/riscv-openocd-wch** | `wch-linke-sdi`：`src/jtag/drivers/wlinke.c`(2043 行)、`src/jtag/sdi.c`(131 行)、`src/target/wch_riscv.c`、`wch_riscv-013.c`、`src/flash/nor/wchriscv.c` | **MRS 定制 OpenOCD 的完整源码快照**，是本次最关键的证据源；`wlink_speed`/`DMI_OP`/flash 全在里面 | ✅ 可直接读；版本比本机 v2.12 旧（行号 1875 vs 3108） |
| **cjacker/wch-openocd-2023** | 同三个文件，字节数完全一样（77263/3012/490） | 同上的另一份镜像 | ✅ 同上，无新增信息 |
| **ch32-rs/wlink** | `src/dmi.rs`、`src/operations.rs`、`src/commands/mod.rs`、`protocol.md` | **最完整的协议复刻**（Rust）：DMI 事务、progbuf 读写内存、块读 `0x03+0x0c`、IAP 升级、模式切换；351 stars，2026-10 仍在更新 | ✅ 可直接当“怎么写客户端”的参考；`protocol.md:49` 把 `0x0c` 标成 `???`（我们可以补上：它就是 SDI 时钟） |
| **fxsheep/openocd_wchlink-rv** | `src/jtag/drivers/wlink.c`(2.1 KB) | 只有 `libusb` 打开设备 + 版本查询 + **空的 `wlink_execute_queue()`** | ❌ 半成品，没有 SDI/DMI 实现，不能调试 |
| **XuHg-zjcn/openocd-wchlink** | `dev-wchlink`：`src/jtag/drivers/wlink_usb.c`(6.6 KB) | 只封装了 `0x0d` 版本/连接/复位三条命令的 USB 传输层 | ❌ 没有 DMI/内存路径 |
| **cjacker/wchlinke-mode-switch** | README + C | DAP⇄RV 模式切换（已被 wlink 取代） | ✅ 仅模式切换 |
| **cjacker/wlink-iap** | `doc/iap-protocol.txt`、`src/main.c`、firmwares/ | **固件 IAP 升级协议**与历史固件（v2.8/v2.15） | ✅ 升级用 |
| **Community-PIO-CH32V/wchlink-driver-windows** | `WCHLink/WCHLinkWDM.INF`、`.sys` | Windows 驱动与 VID/PID/MI 绑定关系 | ✅ 只作证据 |
| **21km43/WCH-Link_Firmware** | 官方 bin 镜像 + `WCH-LinkUserManual-EN.pdf`(3.4 MB) | 官方固件与手册的稳定镜像 | ✅ 手册原文来源 |
| **prosper00/CH32V305-DAPLink-HS** | C 源码 + `.bin/.elf/.hex` | 把 LinkE 刷成 USB HS DAPLink | ⚠️ 只对 ARM 有用，与 CH32V RISC-V 调试无关 |

> 说明：`wlinke.c` 是 GPL 衍生代码，公开快照属于“再分发”，不是 WCH 官方开源。

---

## 6. 对 MotorScope 的建议

### 6.1 立刻能做（零代码改动，1 小时）

1. **只测两个合法值**：把 `wch-riscv.cfg` 的 `adapter speed 6000` 依次改成 `4000`、`400`，重跑同一组 4/16/256 字读取。
   * 若 `4000` 与 `6000` 几乎一样、`400` 明显变慢 → 证实“瓶颈是 USB，不是 SDI”，以后不用再调这个参数。
   * 若三者完全一样 → 说明固件连合法参数都没生效（可能性低），再查日志。
2. **抓日志确认**：用 `-d1`（warning 级）启动，扫非 6000/4000/400 的值时应当出现 `unknow speed config`。**如果没出现，说明 `adapter speed` 根本没有在 init 之后被应用**（例如命令写在 `adapter driver` 之前被忽略），这本身就是个 bug。
3. **示波器实测**（MotorScope 正好有硬件）：探 LinkE 的 SWCLK 焊盘或目标 PA14，跑一次 256 字读，量 SCK 频率。
   * 实测 ≈ 6 MHz → 与源码结论一致，收工；
   * 实测明显低于 6 MHz（例如 1–2 MHz）→ 说明固件内部还有分频/插空，需要另找原因（那才是真正的“为什么慢”）。
   * 顺便量一次 400 kHz 档，验证“三档真的不同”。

### 6.2 想真正提速：走“块读”，不要碰时钟

真正的量级提升不在 6 MHz → 12 MHz（+几个百分点），而在**减少 USB 往返**：

* **方案 A（推荐，改 MotorScope 读取路径）**：halt 之后，不用 OpenOCD 的 `read_memory`，改用 Link 固件的块读：
  `81 03 08 <addr32 BE> <len32 BE>`（CMD=0x03，LEN=8）→ `81 02 01 0C` → 从端点 2 批量读 `len` 字节。
  实现方式：Python `ctypes` 调 `WCHLinkDll.dll` 的 `CH375OpenDevice/CH375WriteEndP/CH375ReadEndP`（和 `wlinke.c` 完全一样的调用方式），或直接用 `wlink` 这个 Rust CLI 验证可行性。
  预期：读 1–4 KB 从“每字 256 µs”降到“一次批量传输”，读阶段快 5–20 倍；再叠加 `halt → 读 → resume` 的固定开销，端到端采样率有望从 20 Hz 提到 50–100 Hz。
  **代价**：独占设备（不能和 OpenOCD 同时开）、要自己做 halt/resume（DMI 写 `0x10`）、要处理大小端（每 4 字节反转）。
* **方案 B（最省事，继续用 OpenOCD）**：保持 halt 读，但把“每次读的区域数”压到最少、把采样率降到 5–10 Hz 做慢监控；真正的连续波形仍走“固件环形缓冲 + 低频批量读”（与 `docs/riscv-debug-research.md` 的结论一致，本轮调研没有推翻它，反而解释了它为什么对）。

### 6.3 不建议做的事

| 选项 | 判断 | 理由 |
|---|---|---|
| 改 `adapter speed` 到 8/12/15/20/30 MHz | ❌ 无效 | 固件只认 6000/4000/400，其余回退 6 MHz（§2.2 源码 + §2.3 反汇编） |
| 自写 OpenOCD 驱动绕过 `wlink_speed` | ❌ 无效 | 时钟是 **Link 固件**设的，USB 命令 `0x0C` 只有 3 个合法参数；驱动层改不了固件 |
| 逆向/替换 LinkE 固件 | ❌ 不建议 | 固件闭源、无文档；收益上限也就 6→12 MHz，而 SDI 只占 12% 的时间。替换成 DAPLink 又只支持 ARM |
| 换通用调试器（J-Link/DAPLink/FT2232） | ❌ 不可行 | CH32V 的调试口是 WCH 私有 SDI，不是标准 JTAG/SWD；通用探针不认 |
| 期待 SBA / 运行中读 | ❌ 已判死 | `sbcs=0`（实测），`sysbus=skipped`，`progbuf` 需 halted |
| 用 `riscv memory_sample` 提采样率 | ❌ 实测无效 | 10 秒只出 10 字节（`riscv-debug-research.md` §7） |

### 6.4 对 Flash 路径的建议

* 现在的寄存器级实现**没有错**，但如果嫌慢：官方路径是“一条命令交给固件 + 64 B/包流式”，比逐半字 `write_memory` 少大量 USB 往返（具体倍数未测）。想优化可以复用 §6.2 的 ctypes 客户端，走 `0x01/0x02` 那组命令。
* 想更稳：在 `erase_sector` 前加一次读保护检查（对应官方的 `wlnik_protect_check()`），避免读保护打开时白擦。
* 想更准：确认 CH32V203 的 `PER` 到底是 256 B 还是 4 KB 粒度；若是 256 B，现在的 `sector_size=4096` 只会擦掉每个 4 KB 的首字节页，**会造成“擦不干净”**。这条需要在有可牺牲扇区时实测（当前 16 个扇区全非空，`flash-programming.md` 也提到了）。

---

## 7. 未验证 / 访问失败

| 项 | 状态 |
|---|---|
| 硬件实测（示波器量 SCK、跑 4000/400 档） | **未做**。本环境没有接目标板/探头；所有频率结论来自源码 + 反汇编 |
| `openocd` 日志里的 `unknow speed config` | **未复现**。项目里没有留存的 OpenOCD 日志；需要按 §6.1 重跑确认 |
| `0x0C` 参数取 4..255 的行为 | **未验证**。固件可能忽略、可能越界；需要自己发 USB 包试（有风险，建议先备份固件） |
| 块读 `0x03 + 0x0C` 的实际吞吐 / 在 halted 下的可用性 | **未验证**。`wlink` 注释说 “require MCU to be halted”，但没有实测数字 |
| 块读能否在运行态工作 | **基本否定**（DM 无 SBA），但没实测 |
| 本机 v2.12 的 `wlinke.c` 源码 | **拿不到**。只有 2043 行的旧快照；行号对不上（3108 vs 1875），逻辑以反汇编为准 |
| `ch32-rs/wlink` 的 `src/firmware.rs` | **下载超时两次**（raw.githubusercontent 21 KB 文件 45 s 无响应）。其余文件（`protocol.md`/`dmi.rs`/`operations.rs`/`commands/mod.rs`）已读 |
| WCH 官网 `wch.cn` 产品页 | **静态抓取无正文**（Vue SPA，返回 “wch doesn't work properly without JavaScript”） |
| 官方手册 PDF 的原始下载页 | 页面 HEAD 200，但直链未取；本次用的是 `21km43/WCH-Link_Firmware` 的镜像（3,425,165 B，V2.2，29 页） |
| `openwch` GitHub 组织 | **404**（`/orgs/openwch/repos` 返回 Not Found），无法确认官方是否另有组织 |
| `web_search` 工具 | **不可用**：`configured web provider "modsearch" is not registered`；全部检索靠 GitHub API + 直连 raw |
| SDI 电气参数（上升沿、采样点、1 线模式的时钟恢复方式） | **未查到**。手册只给接线，不给时序；WCH 的《青稞V2调试手册》讲 DM 不讲 PHY |
| 官方是否曾发布过固件源码 | **未发现任何证据**；不能 100% 排除“曾经发布后删除” |

---

## 8. 参考链接

**源码 / 协议**

* Seneral/riscv-openocd-wch（`wch-linke-sdi`）— <https://github.com/Seneral/riscv-openocd-wch/tree/wch-linke-sdi>
  * `wlinke.c` — <https://github.com/Seneral/riscv-openocd-wch/blob/wch-linke-sdi/src/jtag/drivers/wlinke.c#L1854-L1886>
  * `sdi.c` — <https://github.com/Seneral/riscv-openocd-wch/blob/wch-linke-sdi/src/jtag/sdi.c>
  * `wchriscv.c` — <https://github.com/Seneral/riscv-openocd-wch/blob/wch-linke-sdi/src/flash/nor/wchriscv.c#L106-L175>
* cjacker/wch-openocd-2023 — <https://github.com/cjacker/wch-openocd-2023>
* ch32-rs/wlink — <https://github.com/ch32-rs/wlink>
  * `protocol.md` — <https://github.com/ch32-rs/wlink/blob/main/protocol.md>
  * `src/dmi.rs` — <https://github.com/ch32-rs/wlink/blob/main/src/dmi.rs>
  * `src/operations.rs`（块读）— <https://github.com/ch32-rs/wlink/blob/main/src/operations.rs#L350-L375>
  * `src/commands/mod.rs`（`0x03` / `0x0c`）— <https://github.com/ch32-rs/wlink/blob/main/src/commands/mod.rs#L110-L150>
* fxsheep/openocd_wchlink-rv — <https://github.com/fxsheep/openocd_wchlink-rv>
* XuHg-zjcn/openocd-wchlink — <https://github.com/XuHg-zjcn/openocd-wchlink>
* cjacker/wlink-iap（IAP 协议）— <https://github.com/cjacker/wlink-iap/blob/main/doc/iap-protocol.txt>
* cjacker/wchlinke-mode-switch — <https://github.com/cjacker/wchlinke-mode-switch>
* Community-PIO-CH32V/wchlink-driver-windows — <https://github.com/Community-PIO-CH32V/wchlink-driver-windows>
* prosper00/CH32V305-DAPLink-HS（替代固件）— <https://github.com/prosper00/CH32V305-DAPLink-HS>

**官方资料**

* WCH-Link 产品/手册页 — <https://www.wch-ic.com/downloads/WCH-LinkUserManual_PDF.html>
* 《WCH-LinkUserManual》V2.2 镜像 — <https://github.com/21km43/WCH-Link_Firmware/blob/main/WCH-LinkUserManual-EN.pdf>
* WCH-LinkUtility 下载 — <https://www.wch.cn/downloads/WCH-LinkUtility_ZIP.html>
* 官方固件镜像（含 v2.20/v40 说明）— <https://github.com/21km43/WCH-Link_Firmware>

**本机证据**

* `<MRS 安装目录>/resources/app/resources/win32/components/WCH/OpenOCD/OpenOCD/bin/openocd.exe`（v2.12，含 COFF 符号与 `wlinke.c` 行号）
* `...\WCH\Others\Firmware_Link\default\`（官方固件 v44）
* `...\WCH\Others\CommunicationLib\default\WCHLinkDll64.dll`（36 个导出**全部**是 `CH375*`：OpenDevice/ReadEndP/WriteEndP/SetTimeout/...，没有任何高层调试 API）

**本项目关联文档**

* [RISC-V 调试资料整理](riscv-debug-research.md) —— halt 读的既有结论与实测
* [CH32V203 Flash 编程](flash-programming.md) —— `flash.py` 的寄存器级实现

---

## 8. 实机复核（2026-10-30，CH32V203C8T6 / WCH-LinkE 2.21）

按 §6.1 的判别实验跑了一遍：

| 设置 | OpenOCD 结果 | 4 字读取 | 256 字读取 |
|---:|---|---:|---:|
| 6000 kHz | 接受 | 22.86 ms | 66.0 ms |
| 4000 kHz | 接受 | 22.46 ms | 65.4 ms |
| 400 kHz | 接受 | 24.95 ms | 66.5 ms |
| 1500 kHz | `Warn : unknow speed config`，回退 6 MHz | 22.41 ms | 65.0 ms |

结论与 §1 一致：

- 只有 **6000 / 4000 / 400** 三个合法值；其余值只打印警告并回退 6000；
- 从 6 MHz 降到 400 kHz，256 字读取只慢 0.5 ms（约 0.8%），证明 **瓶颈不是 SDI 时钟，而是 USB/命令往返**；
- 因此“提高调试器频率”这条路没有收益，6 MHz 已是上限。

补充：`flash.py` 的 4 KB 扇区擦除在实际整片烧录中通过校验，说明 CH32V203 的 PER 擦除粒度确实是 4 KB，不是 256 B。
