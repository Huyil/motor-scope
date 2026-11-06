# CH32V203 Flash 编程（寄存器级）

> 目标：不依赖 OpenOCD 的闭源 flash 驱动，直接通过 Tcl RPC 操作 FPEC，
> 为后续 CW32 / CH32 各系列补算法表打基础。

## 1. 硬件事实

- Flash 主区：`0x08000000`（同时别名到 `0x00000000`）
- 页：256 B；标准擦除扇区：4 KB
- 标准编程：**每次 2 字节（半字），必须偶地址**
- 编程期间 `BSY=1`，结束 `BSY=0`、`EOP=1`；错误看 `WRPRTERR`
- 复位后 FPEC 锁定：`FLASH_CTLR.LOCK=1`，需向 `FLASH_KEYR` 依次写
  `0x45670123`、`0xCDEF89AB` 解锁

寄存器（基址 `0x40022000`）：

| 寄存器 | 偏移 | 用途 |
|---|---|---|
| KEYR | 0x04 | 写 KEY1/KEY2 解锁 |
| STATR | 0x0C | BSY(bit0) / WRPRTERR(bit4) / EOP(bit5) |
| CTLR | 0x10 | PG(0) / PER(1) / MER(2) / STRT(6) / LOCK(7) |
| ADDR | 0x14 | 擦除页地址 |

## 2. 关键约束：为什么需要 halt

RISC-V 调试模块（WCH-Link/SDI）没有可用的 system bus access：

```
target.memory.read_while_running32 = 0
sysbus=skipped (unsupported size)
running 时 read_memory -> failed to read memory
```

因此读 RAM 和写 Flash 都必须 `halt`。ARM Cortex-M 的 AHB-AP 可以运行中读，
RISC-V 这边没有等价物。

Flash 编程还要求“CPU 执行一次半字 store”。调试器的 `write_memory` 默认走
abstract 访问，未必等价于 CPU store；`flash.py` 里先执行：

```tcl
riscv set_mem_access progbuf
```

让 `write_memory <flash> 16 <halfword>` 通过 progbuf 中的指令完成，满足 FPEC
的触发条件。

## 3. 实现

`flash.py`：

- `FlashSpec`：型号参数（基址/容量/页/扇区/寄存器/位定义）
- `FlashDriver`：
  - `unlock()` / `lock()` / `wait_ready()` / `clear_eop()`
  - `erase_sector(addr)`：PER + ADDR + STRT，等 BSY/EOP
  - `program(addr, data)`：PG=1，逐半字 `write_memory ... 16`
  - `verify()` / `read()`
  - `program_image(addr, data)`：擦除覆盖扇区 → 编程 → 校验 → 恢复运行
- `parse_ihex()` / `load_elf()`：HEX、ELF/PT_LOAD
- 地址别名：`0x00000000` 自动映射到 `0x08000000`

`flash_tool.py`：

```bat
:: 只打印计划，不写片
runtime\python\python.exe flash_tool.py --file build\DR1152_Project_CH32.hex --dry-run

:: 实际烧录（会擦除）
runtime\python\python.exe flash_tool.py --file build\DR1152_Project_CH32.hex --tcl 127.0.0.1:6666
```

## 4. 验证状态

- 30 个单测全过（含 Flash 时序模拟：解锁、擦除、编程、校验、别名、HEX）
- 实机只做了**非破坏性**验证：
  - `CTLR` 复位 `0x8080`（LOCK=1）
  - 执行解锁序列后 `0x8000`（LOCK=0）
  - 重新加锁回到 `0x8080`
- 未做整片/扇区写入测试：当前 16 个扇区全部非空，没有找到可安全擦写的空白扇区。
  首次实烧建议用已知固件（如 `build\DR1152_Project_CH32.hex`）并确认可接受擦除。

## 5. H7-TOOL 的参考

`<H7-TOOL 上位机目录>/EMMC/H7-TOOL/Programmer/Device/WCH/CH32V203/CH32V20x.lua`：

- Flash 基址 `0x08000000`、页 256、扇区 4096、UID `0x1FFFF7E8`
- `CH32_PROGBUF = 0`：该型号用内存模式，而不是 progbuf 模式
- 具体编程依赖其固件里的 `Algo_CODE` 算法文件，Lua 只给参数与寄存器定义

## 6. 后续

- 把 `FlashSpec` 扩展到 CW32L0 系列（CW32 已有 `cw32l01x-flm.cfg` 的 TCL 实现可参考）
- 在 MotorScope UI 增加“烧录”入口（选择 HEX/ELF、进度、校验）
- 注意：烧录会清空采样/录制，需先断开信号源或暂停
