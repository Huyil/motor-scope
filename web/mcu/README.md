# MCU 外设寄存器表（web/mcu）

给网页端（`scope_server.py` / `web/app.js`）用的**静态外设寄存器目录**：每个型号一个 JSON，
由 `tools/build_mcu_tables.py` 从本机头文件、AXF 调试信息与厂商 SVD 生成，可重复重建。

HTTP 读取（`scope_server` 静态目录就是 `web/`）：

| URL | 内容 |
|---|---|
| `GET /mcu/index.json` | 型号索引、识别信息、各型号计数 |
| `GET /mcu/CW32L010.json` | CW32L010 外设寄存器表 |
| `GET /mcu/CW32L011.json` | CW32L011 |
| `GET /mcu/CW32L012.json` | CW32L012 |
| `GET /mcu/CH32V203C8T6.json` | CH32V203C8T6（LQFP48） |
| `GET /mcu/CH32V203K8T6.json` | CH32V203K8T6（LQFP32） |
| `GET /mcu/LKS32MC07x.json` | LKS32MC07x（Linko Cortex-M0） |
| `GET /mcu/LKS32MC07x.info.json` | LKS32MC07x 寄存器描述（手册 v1.69 抽取，独立导入） |

后端 `scope_server.load_mcu_index()` 读同一个 `index.json`，`/api/chip/probe` 用其中的
`identify` 与 `flash_kb` 做型号识别；`web/app.js` 的 `peripheralList()` 按
`peripherals[].regs[].bits[]` 的结构使用型号文件。

## 1. 文件与规模

| 型号 | 文件 | 大小 | 外设 | 寄存器 | 位域 | 封装 |
|---|---|---:|---:|---:|---:|---|
| CW32L010 | `CW32L010.json` | 75,186 B (73.4 KiB) | 24 | 254 | 1410 | — |
| CW32L011 | `CW32L011.json` | 105,562 B (103.1 KiB) | 27 | 304 | 2109 | — |
| CW32L012 | `CW32L012.json` | 188,810 B (184.4 KiB) | 50 | 562 | 3680 | — |
| CH32V203C8T6 | `CH32V203C8T6.json` | 315,302 B (307.9 KiB) | 51 | 1090 | 5764 | LQFP48 |
| CH32V203K8T6 | `CH32V203K8T6.json` | 315,302 B (307.9 KiB) | 51 | 1090 | 5764 | LQFP32 |
| LKS32MC07x | `LKS32MC07x.json` | 96,934 B (94.7 KiB) | 30 | 410 | 1542 | — |
| LKS32MC07x 描述 | `LKS32MC07x.info.json` | ~752 KiB | — | 401 | 1515 | 手册 v1.69 |
| 索引 | `index.json` | 5,142 B | — | — | — | — |
| **合计** | | **~1.1 MB** | **233** | **3710** | **20269** | |

CH32 两个型号是同一 die、同一份寄存器表，两个文件只有顶层 `id` 不同（`peripherals`
数组逐字节相同）；封装/引脚信息只写在 `index.json` 的 `package` 字段里。

## 2. JSON 格式

所有文件都是 UTF-8、无注释、无 `NaN`；**所有地址/基址/位偏移都是十进制整数**，
只有 `index.json` 的 `identify` 地址为了可读性用 `0x` 字符串。

### 2.1 `index.json`

```json
{
  "schema": 1,
  "generated_at": "2026-10-29 16:05:00",
  "models": [
    {
      "id": "CW32L011",
      "aliases": ["CW32L011K8T6"],
      "vendor": "CW",
      "core": "cortex-m0plus",
      "flash_kb": 64,
      "ram_kb": 6,
      "package": null,
      "file": "CW32L011.json",
      "identify": {
        "kind": "cw32-signature",
        "type_addr": "0x001007E0",
        "type_len": 16,
        "type_ascii": true,
        "expected_type": "CW32L011",
        "pin_count_addr": "0x001007D5",
        "flash_kb_addr": "0x001007D8",
        "ram_kb_addr": "0x001007D6",
        "uid_addr": "0x001007B0",
        "uid_len": 10,
        "exact": true
      },
      "peripheral_count": 27,
      "register_count": 304,
      "bitfield_count": 2109
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `schema` | 固定 `1` |
| `generated_at` | 生成时刻（本机时间，`YYYY-MM-DD HH:MM:SS`），每次重建都会变 |
| `id` | 型号 ID，和 `file` 去掉 `.json` 一致 |
| `aliases` | 可接受的别名（完整订货型号），用于型号比对 |
| `vendor` / `core` | `CW`/`cortex-m0plus`，`WCH`/`riscv32`（CH32V203 为青稞 V4B，SVD 层归为 riscv32） |
| `flash_kb` / `ram_kb` | 标称容量，KB（见 §3.4 的取值依据） |
| `package` | 封装；CW32 侧本机无权威封装信息，写 `null` |
| `identify` | 芯片识别依据，见 §3.5 |
| `*_count` | 该型号 JSON 里实际展开后的数量（脚本已断言与文件内容一致） |

### 2.2 `<MODEL>.json`

```json
{
  "id": "CW32L011",
  "peripherals": [
    {
      "name": "ADC",
      "base": 1073741824,
      "type": "ADC_TypeDef",
      "regs": [
        {
          "name": "CR",
          "addr": 1073741824,
          "size": 4,
          "signed": false,
          "type": "uint32_t",
          "bits": [{ "name": "EN", "shift": 0, "width": 1 }]
        }
      ]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `peripherals[].name` | 外设名（CW32 用头文件 `CW_XXX` 后缀；CH32 用 SVD `<name>`） |
| `peripherals[].base` | 外设基址，十进制整数 |
| `peripherals[].type` | CW32：C 结构体 typedef（如 `ADC_TypeDef`）；CH32：SVD `<groupName>`（如 `GPIO`），SVD 没有 C typedef |
| `regs[].addr` | 寄存器绝对地址（基址 + 偏移），十进制整数 |
| `regs[].size` | 字节数：1/2/4/8 |
| `regs[].signed` | 是否有符号（CW32 来自 DWARF，CH32 恒 `false`） |
| `regs[].type` | C 类型名（`uint8_t`/`uint16_t`/`uint32_t`…）；CH32 由 SVD `<size>` 推导 |
| `regs[].bits[]` | 位域：`name` + `shift`（LSB 位置）+ `width`（位数） |

约束（脚本每次生成都会校验，失败直接退出）：

* 同一外设内 `name` 唯一、`regs[].addr` 不重复；
* `shift >= 0`、`width > 0`、`shift + width <= size * 8`，越界位域丢弃并告警；
* 所有数值都是 JSON number（整数），没有字符串地址。

## 3. 数据来源

### 3.1 源文件

| 型号 | 头文件 | AXF（DWARF） | 交叉核对 |
|---|---|---|---|
| CW32L010 | `<你的工程>/Libraries/inc/cw32l010.h` | `<你的工程>/MDK/Objects/bldc.axf` | `CW32L010_DFP/1.0.2/SVD/CW32L010.svd` |
| CW32L011 | `<导入目录>/cw32l011.h` | `<导入目录>/DR2159.axf` | `CW32L011_DFP/1.0.0/SVD/CW32L011.svd` |
| CW32L012 | `<你的工程>/Libraries/inc/cw32l012.h` | `<你的工程>/build/Project/flash_Programming.axf` | `CW32L012_DFP/1.0.2/SVD/CW32L012.svd` |
| CH32V203C8T6 / K8T6 | — | — | `<WCH SDK>/RISC-V/CH32V203/NoneOS/CH32V203xx.svd`（随 MounRiver Studio 的 WCH SDK 提供） |
| LKS32MC07x | — | — | `<MDK_Pack>/Linko/LKS07x/<版本>/SVD/LKS32MC07x.svd`（Linko LKS07x 芯片包） |

CW32 侧的解析**没有另写一套**：脚本 `import gen_signals`，直接复用仓库里已经跑通的
`_parse_header()`、`_collect_typedefs()`、`_collect_peripherals()`（结构体/位域展开），
再按本目录的 schema 做去重、越界校验与排序。因此头文件里 `CW_ADC ((ADC_TypeDef*)ADC_BASE)`
这类宏和 AXF 里的 typedef 布局是唯一事实来源。

CH32/LKS 侧直接解析 CMSIS-SVD：`peripheral/baseAddress`、`register/addressOffset/size/access`、
`fields/bitOffset|bitRange/bitWidth`，并展开：

* `derivedFrom`（GPIOB–E ← GPIOA，TIM3–5 ← TIM2，TIM8–10 ← TIM1，I2C2 ← I2C1，
  SPI3 ← SPI2，USART2/3、UART4–8 ← USART1），共继承 222 个寄存器实例；
* `<dim>/<dimIncrement>/<dimIndex>` 数组寄存器；
* `<cluster>` 嵌套（本 SVD 实际未使用，但解析器支持；cluster 内寄存器名加
  `CLUSTER_` 前缀）；
* SVD 1.x 的旧式 `<bitRange>[msb:lsb]</bitRange>`（本 SVD 有 343 个字段用它，
  主要是 USBHS），否则这些位域会被整批丢掉。

这份 SVD 实际没有用到 `<dim>`/`<cluster>`，但解析器仍实现了这两条路径，并用一份
合成 SVD 做过回归：cluster 带 `dim=2` × 寄存器 `dim=4`、`dimIndex` 为 `0-2` 和
`A,B` 两种写法，展开后的地址/命名均符合预期（cluster 内寄存器名带 `CLU0_` 前缀）。

### 3.2 CH32 的 ESIG（电子签名）

依据 `CH32FV2x_V3xRM` V2.5 第 31 章《电子签名（ESIG）》§31.2（手册页 527，
PDF p.530–531），本机文件 `/mnt/c/Users/Administrator/Downloads/CH32FV2x_V3xRM.PDF`：

| 寄存器 | 地址 | 内容 |
|---|---|---|
| `R16_ESIG_FLACAP` | `0x1FFFF7E0` | `F_SIZE[15:0]`，单位 KB（如 `0x0080` = 128KB） |
| `R32_ESIG_UNIID1` | `0x1FFFF7E8` | 96-bit UID 第 1 个字 |
| `R32_ESIG_UNIID2` | `0x1FFFF7EC` | UID 第 2 个字 |
| `R32_ESIG_UNIID3` | `0x1FFFF7F0` | UID 第 3 个字 |

**ESIG 里没有芯片型号字符串，也没有封装/引脚数信息。** CH32V203C8T6 与 K8T6 同 die、
同为 64KB Flash，读 ESIG 只能得到 `flash_kb=64` 和 UID，无法区分两者。因此：

* 两个型号的 `identify.exact` 都是 `false`；
* `identify.family` 统一为 `CH32V203`，`note` 写明“只能识别到系列”；
* `identify.source` 记录手册章节，便于追溯；
* 服务端 `probe_chip()` 按 `flash_kb` 命中两个候选，`exact=false`、`candidates`
  同时给出 C8T6/K8T6，不会伪造“已区分”。

### 3.3 CW32 的签名区

CW32L01x 的工厂信息区（只读）在 `0x001007xx`：

| 地址 | 内容 |
|---|---|
| `0x001007B0` | 芯片 UID（本表按 10 字节记） |
| `0x001007D5` | 引脚数 |
| `0x001007D6` | RAM 尺寸（KB） |
| `0x001007D8` | Flash 尺寸（KB） |
| `0x001007E0` | 型号 ASCII 字符串（16 字节，`\0` 结尾） |

依据：本任务给定的 CW32L011 识别参数，以及
`<DR2159 工程>/doc/工具链-编译烧录调试.md` §2.4 对 CW32L012 系统信息区的同址说明。
CW32L010 使用同一家族布局；CW32L012 的 `note` 已注明“未逐型号上机验证”。
`probe_chip()` 对 CW32 的流程是：先读 `0xE000ED00` 确认 `CPUID=0x410CC601`（M0+），
再读 `0x001007E0` 的 16 字节 ASCII，因此 `identify.type_*` 与后端实现一致。

### 3.4 Flash / RAM 容量

| 型号 | Flash | RAM | 依据 |
|---|---:|---:|---|
| CW32L010 | 64 KB | 4 KB | Keil DFP `CW32L010_DFP/1.0.2` 的 `IRAM1 size=0x1000`、`IROM1 size=0x10000` |
| CW32L011 | 64 KB | 6 KB | 数据手册“64KB Flash / 6KB SRAM”；DR2159 链接脚本 `RW_IRAM1 = 0x20000000 + 0x1800`（6KB） |
| CW32L012 | 64 KB | 8 KB | `CW32L012_DFP/1.0.2` 的 `IRAM1 size=0x2000`；`DR2159/doc` OTA 设计文档“64KB Flash, 8KB RAM” |
| CH32V203C8T6/K8T6 | 64 KB | 20 KB | 型号命名 C8/K8 = 64KB Flash；CH32V203 系列 20KB SRAM |

注：CW32L011 的 DFP `IRAM1` 默认值写的是 `0x1000`（4KB），但手册与 DR2159 实际链接
都是 6KB，这里取 6KB。索引里的 `ram_kb` 只是标称值，真正容量以 `0x001007D6` 的
运行时读数为准。

### 3.5 `identify` 字段

| 字段 | 适用 | 说明 |
|---|---|---|
| `kind` | 全部 | `cw32-signature` / `ch32-esig` / `lks-afe` |
| `type_addr`/`type_len`/`type_ascii`/`expected_type` | CW32 | 型号串地址、长度、是否 ASCII、期望值 |
| `pin_count_addr`/`flash_kb_addr`/`ram_kb_addr` | CW32 | 签名区各字段地址 |
| `uid_addr`/`uid_len` | 全部 | UID 地址与字节数 |
| `family` | CH32 / LKS | 只能识别到的系列 |
| `info_addr` / `series_*` / `version_*` | LKS | `SYS_AFE_INFO` 地址与 Series/Version 位段 |
| `flash_size_addr` / `flash_code_*` / `flash_kb_table` | LKS | `FLASH_SIZE` 的容量编码与 KB 表 |
| `flash_kb` | CH32 | ESIG `F_SIZE` 的期望值（KB） |
| `exact` | 全部 | 该型号是否能被唯一确定（CH32 两型号为 `false`） |
| `note`/`source` | 可选 | 局限说明与手册出处 |

### 3.6 寄存器描述（`.info.json`）

模板之外的**第二份 JSON**，只放描述，不参与地址/位偏移：

```json
{"key":"FLASH.READY.READY","kind":"bit","periph":"FLASH","reg":"READY","bit":"READY",
 "addr":131096,"offset":24,"size":4,"shift":0,"width":1,
 "static":"FLASH 忙/闲状态",
 "states":{"0":"FLASH 处于 Busy 状态","1":"FLASH 处于 Idle 状态"},
 "values":null,
 "full":"READY[0]：1 表示 FLASH 处于 Idle 状态...","access":"RO","reset":"0","page":99}
```

- 扁平 `entries` 数组，key 与模板一致；前端加载成 Map；
- 1 bit 用 `states`，多 bit 枚举用 `values`，纯数值只留 `static`；
- 独立导入：`POST /api/reginfo/import`，只写 `web/mcu/<型号>.info.json`；
- 抽取/合并流程见 [docs/reginfo-extraction.md](../docs/reginfo-extraction.md)。

## 4. 抽样核对

生成结果与头文件/SVD 原始定义逐项比对（地址十进制，括号内为十六进制）：

| # | 型号 | 核对点 | 原始依据 | 生成值 |
|---|---|---|---|---|
| 1 | CW32L011 | `ADC` 基址 / `ADC.CR` | 头文件 `#define ADC_BASE 0x40000000UL`；`ADC_TypeDef` 首成员 `CR` 偏移 0 | `base=1073741824 (0x40000000)`，`CR.addr=1073741824`，`size=4`，`EN[0:1]` ✅ |
| 2 | CW32L010 | `GPIOA.DIR` | 头文件 `GPIOA_BASE 0x48000000UL`；`GPIO_TypeDef` 的 `DIR_f` 只有 `PIN0..PIN8` 9 位 | `addr=1207959552 (0x48000000)`，9 个位域 ✅ |
| 3 | CW32L012 | `ADC1.CR` / `ADC1.START` | 头文件 `ADC1_BASE 0x40000000UL`；`ADC_TypeDef` 中 `START` 在 `+0x04`（与 L011 的 `+0x08` 不同） | `CR=1073741824`，`START=1073741828 (0x40000004)` ✅ |
| 4 | CH32V203 | `GPIOA.CFGLR` | SVD `GPIOA baseAddress=0x40010800`，`CFGLR addressOffset=0`；`MODE0` bitOffset 0、bitWidth 2，`CNF7` bitOffset 30 | `addr=1073809408 (0x40010800)`，16 个位域，`MODE0=(0,2)`、`CNF7=(30,2)` ✅ |
| 5 | CH32V203 | `USART1.STATR` | SVD `USART1 baseAddress=0x40013800`，`STATR offset=0`；`RXNE` bit5、`TC` bit6 | `addr=1073821696 (0x40013800)`，`RXNE=(5,1)`、`TC=(6,1)` ✅ |
| 6 | CH32V203 | ESIG Flash 容量 | 手册 §31.2 `R16_ESIG_FLACAP @0x1FFFF7E0` 低 16 位 = KB | `identify.flash_kb_addr=0x1FFFF7E0`，`flash_kb=64` ✅ |
| 7 | LKS32MC07x | `SYS.AFE_INFO` | 手册 v1.69 §5.2.2：`0x4000_0004`，Series[7:4]=7，Version[3:0] | `info_addr=0x40000004`，`expected_series=7` ✅ |
| 8 | LKS32MC07x | Flash 容量 | 手册 §7.3.9：`0x0002_001C` 的 FLASH_SIZE[7:6]（0/1/2/3→32/64/128/128KB） | 上机读 `0x79`：Series=7、Version=9、FLASH_SIZE=3 → 128KB ✅ |

补充：CW32 三型还用本机 Keil DFP 的 `CW32L010/011/012.svd` 做了独立交叉核对，
抽查的 `ADC.CR`、`GPIOA.DIR`、`SYSCTRL.CR0/CR1/CR2` 地址与位宽全部一致
（例如 L010 SVD 的 `ADC.CR=0x40000000`、`START=0x40000008`；L012 SVD 的
`ADC1.START=0x40000004`）。SVD 只用于核对，**不作为 CW32 表的生成输入**。

回归校验命令：

```bash
python3 -m json.tool web/mcu/index.json > /dev/null && echo OK
for f in web/mcu/*.json; do python3 -m json.tool "$f" > /dev/null || echo "BAD $f"; done
```

另外用假数据源（不接硬件）跑过 `scope_server.probe_chip()` 验证索引可用：

* CW32L011：`CPUID=0x410CC601` + `0x001007E0` 的 `CW32L011` 串 → `detected=CW32L011`、
  `exact=true`、`match=true`；
* CH32V203C8T6：`flash_kb=64` → `detected=CH32V203`、`exact=false`、
  `candidates=[CH32V203C8T6, CH32V203K8T6]`、`match=true`（按系列匹配），
  不会谎报已区分 C8/K8。

## 5. 重建

脚本依赖 `pyelftools`（只读 CW32 AXF 时需要）。WSL 的 `python3` 没装该包，请用工程自带的
Windows 运行时（Python 3.13 + pyelftools）：

```bat
cd /d D:\Code\motor-scope
chcp 65001 >nul
runtime\python\python.exe tools\build_mcu_tables.py
```

WSL 下等价写法：

```bash
cd <工程目录>
cmd.exe /c 'cd /d D:\Code\motor-scope && runtime\python\python.exe tools\build_mcu_tables.py'
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--out DIR` | 输出目录，默认 `web/mcu` |
| `--only ID[,ID]` | 只重建指定型号的 `<ID>.json`；**不会更新 `index.json`**（避免索引只剩部分型号） |

只重建 CH32 / LKS（不需要 pyelftools，可直接用 WSL `python3`）：

```bash
python3 tools/build_mcu_tables.py --only CH32V203C8T6,CH32V203K8T6
python3 tools/build_mcu_tables.py --only LKS32MC07x
```

脚本顶部的 `CW32_MODELS` / `CH32_SVD` / `LKS_SVD` 是源文件绝对路径；换机器或换 SDK 时改这里。
运行时会打印每个型号的 `peripherals/regs/bits/bytes`，并对以下情况告警：

* AXF 候选里没有外设 typedef（自动换下一个候选）；
* 同地址寄存器合并、越界位域丢弃、空外设跳过。

重建后 `index.json` 的 `generated_at` 会更新；其余内容在源文件不变时是确定的
（JSON 键顺序固定、数组按 `(base, addr, name)` 排序）。

## 6. 已知问题与局限

1. **CH32 C8T6 / K8T6 无法区分**：同 die、同 64KB Flash，ESIG 只有 Flash 容量和
   96-bit UID，没有型号/封装字段。两个 JSON 的寄存器表相同，`identify.exact=false`，
   `package` 只在索引里区分（LQFP48 / LQFP32）。任何“读到封装”的说法都是编造。
2. **CH32 SVD 是系列超集**：`CH32V203xx.svd` 里包含 `ETHERNET_MAC/MMC/PTP/DMA`、
   `USBHS`、`USB_OTG_FS`、`CAN1` 等块。CH32V203 的具体型号未必都实现这些外设，
   SVD 也没有按封装裁剪引脚。本表按 SVD 原样收录，前端如要按型号过滤需另做白名单。
   `PFIC`（`0xE000E000`）和 `DBG`（`0xE000D000`）是内核私有区，也按 SVD 收录。
3. **同地址多视图只保留一份**：SVD 里 `TIM1.CHCTLR1_Output` / `CHCTLR1_Input`
   （`+0x18`）、`ADC1.RDATAR_DR` / `ACT_DCG`（`+0x4C`）是同一地址的互斥视图，
   脚本合并成一个寄存器（保留位域更多的视图，再并入不重叠的位域），共合并 18 处；
   CW32 侧同理：`CCMR1CAP`/`CCMR1CMP`、`I2C MCR2`/`SCR2` 等，L010/L011/L012 分别
   合并 5/7/13 处。因此这些寄存器的位域名只代表其中一种视图。
4. **CW32 位域来自 DWARF，不是头文件文本解析**：`RESERVED*` 成员被跳过；寄存器数组
   最多展开 64 项、结构体数组最多 2 项（`gen_signals` 的 `array_limit` /
   `struct_array_limit`），超大数组会被截断。
5. **CW32 没有访问属性**：DWARF 不携带只读/只写信息，`signed` 也只对基础类型有意义；
   CH32 的 `access` 字段同样未写入（schema 没有该字段）。前端不要把 `signed=false`
   理解为“可写”。
6. **CW32L012 的 AXF 选择**：`MDK/output/Project.axf` 有 DWARF 但**不含任何外设
   `*_TypeDef`**（0 个 typedef / 0 个外设），直接用会得到空表。脚本按 `axf` 候选列表
   逐个试，选第一个能展开出外设的；实际用了
   `build/Project/flash_Programming.axf`（28 个外设 typedef）。若该文件也不含
   typedef，脚本会告警并保留最后候选，此时应改用其它带调试信息的 AXF。
7. **CW32L011 头文件与厂商 SVD 的小差异**：头文件只有 `I2C`（`0x40005800`），
   DFP SVD 列出 `I2C1`/`I2C2`（28 个外设）；`IRMOD` 的寄存器偏移也差 8 字节。
   本表以任务指定的头文件为准（27 个外设），差异仅记录于此。
8. **位域越界**：本次生成 CW32/CH32 均为 0 个越界位域被丢弃；脚本仍会在源文件变化时
   告警并在 stderr 打印数量，重建时请留意。
9. **CH32 寄存器命名是 WCH 风格**（`CTLR1`、`STATR`、`CHCTLR1`），不是 STM32 的
   `CR1`/`SR`/`CCMR1`；跨厂脚本不要按名字硬套。
10. **`generated_at` 每次重建都变**，做二进制比对时请忽略该字段；其余字段稳定。
11. **LKS 只能识别到系列**：`SYS_AFE_INFO.Series=7` 是 07x 系列，不是具体料号；
    `LKS32MC07x` 的 `identify.exact=false`，`aliases` 里放了 `LKS32MC071CBT8` 等常见订货名。
12. **LKS SVD 的 `AFE_INFO`/`FLASH_SIZE` 字段没有 bitOffset**（只有文字位段），
    寄存器表里这两个寄存器可能只有寄存器级、没有位域；芯片识别直接按手册的位段解码，
    不依赖 SVD 的 field 展开。
