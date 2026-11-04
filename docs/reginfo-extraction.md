# LKS32MC07x 寄存器信息抽取（手册 v1.69）

> 目标：给 MotorScope 的寄存器行提供 **静态简述 / 动态状态 / 完整描述**，
> 与寄存器模板（`web/mcu/LKS32MC07x.json`）分开存放、分开导入。

## 1. 产物

| 文件 | 作用 |
|---|---|
| `web/mcu/LKS32MC07x.json` | **模板**：30 外设 / 410 寄存器 / 1542 位域（SVD 生成，地址/位偏移唯一来源） |
| `web/mcu/LKS32MC07x.info.json` | **描述**：1916 条（401 寄存器 + 1515 位域），752 KB |
| `tools/merge_reginfo.py` | 把子智能体输出的分片合并、校验、回填模板地址、镜像同构外设 |

两者独立导入：换模板不会覆盖描述，换描述也不会动地址/位偏移。
描述文件是**扁平 entries 数组**（每条 `key` 唯一），前端加载后建 Map；
1916 条、752 KB 用 JSON 足够，不需要数据库（没有深嵌套，线性扫描也很快）。

## 2. 数据形状

```json
{
  "schema": 1,
  "model": "LKS32MC07x",
  "source": "LKS32MC07x User Manual v1.69",
  "entries": [
    {
      "key": "FLASH.READY.READY",
      "kind": "bit",
      "periph": "FLASH", "reg": "READY", "bit": "READY",
      "addr": 131096, "offset": 24, "size": 4,
      "shift": 0, "width": 1,
      "static": "FLASH 忙/闲状态",
      "full": "READY[0]：1 表示 FLASH 处于 Idle 状态，0 表示 FLASH 处于 Busy 状态。只读。",
      "states": {"0": "FLASH 处于 Busy 状态", "1": "FLASH 处于 Idle 状态"},
      "values": null,
      "access": "RO", "reset": "0", "page": 99
    }
  ]
}
```

- `key`：`PERIPH.REG` 或 `PERIPH.REG.BIT`，与模板完全一致。
- `static`：行内一行的静态简述（手册原意，≤ 120 字）。
- `states`：1 bit 字段的 0/1 含义（读按钮后显示当前值）。
- `values`：多 bit 字段的“值 → 含义”（如 ADC 通道选择、UART 校验）。
- `full`：展开栏里的完整描述（位含义、枚举、注意事项）。
- 数值字段没有 `states/values` 时只显示 `static`（例如 IO 电平）。

## 3. 抽取流程（子智能体）

手册 424 页，按外设章节切成 11 组：

| 组 | 页 | 外设 |
|---|---|---|
| `sys_afe` | 52–86 | SYS（AFE/时钟/复位） |
| `flash` | 87–106 | FLASH |
| `spi_i2c_cmp_hall` | 107–150 | SPI0 / I2C0 / CMP / HALL0 |
| `adc` | 151–182 | ADC0 / ADC1 |
| `timer_qep` | 183–237 | TIMER0–3 / QEP0–1 |
| `mcpwm` | 238–284 | MCPWM0 |
| `gpio_exti` | 285–303 | GPIO0–3 / EXTI |
| `crc_uart_dma` | 304–336 | CRC0 / UART0–1 / DMA0 |
| `dsp` | 337–367 | DSP0 |
| `iwdg_pmu_sif_cl0` | 368–395 | IWDG / AON / SIF0 / CL0 |
| `can` | 396–420 | CAN0 |

每组目录含：

- `manual.txt`：该组页文本（`===== PAGE n =====` 标记）；
- `registers.json`：该组 SVD 模板子集（键名/地址/位偏移）；
- `PROMPT.md`：任务书；
- `out.json` + `report.md`：子智能体输出的**两份文字**（JSON + 报告）。

用 **GLM-5.3-Flash**（`zai-coding-cn`）执行。子智能体并发上限 8，所以按 ≤4 个一批；
`sys_flash` 组太大时拆成 `sys_afe` + `flash`。

## 4. 合并 / 校验

```bash
python3 tools/merge_reginfo.py \
  --inputs '.work/reginfo/groups/*/out.json' \
  --out web/mcu/LKS32MC07x.info.json \
  --mirror TIMER0:TIMER1,TIMER2,TIMER3 \
  --mirror QEP0:QEP1 --mirror ADC0:ADC1 \
  --mirror GPIO0:GPIO1,GPIO2,GPIO3 --mirror UART0:UART1
```

合并器：

- 按 `key` 回填模板的 `addr/offset/shift/width/size/periph/reg/bit`；
- 丢弃模板里不存在的 key；
- 1 bit 字段只保留 `states`，多 bit 只保留 `values`；
- 去重；同构外设镜像（TIMER1–3 ← TIMER0，GPIO1–3 ← GPIO0 等）；
- 统计每个外设的覆盖率；缺的条目保持空，不编造。

## 5. 覆盖与已知缺口

最终：**401/410 寄存器、1515/1542 位域、1916 条**。

缺的 9 个 SYS 寄存器：`AFE_ADC / AFE_REG8 / AFE_REG9 / AFE_REGA / AFE_REGB / AFE_REGC / TRIM / MBIST / TEST`
（手册没有逐位描述，保持空）；`EXTI` 2 个位、`MCPWM0` 4 个位同理。

## 6. 导入

- 设置 → 符号与芯片 → **导入寄存器表**（模板，SVD/JSON）；
- 设置 → 符号与芯片 → **导入寄存器信息**（描述，JSON）。

前者更新 `catalog.peripherals`，后者只写 `web/mcu/<型号>.info.json`；
前端在选中型号时单独加载描述，`GET /api/reginfo?model=` 也可读。

## 7. 局限

- 自动抽取 + 抽样核对，不是逐条人工校对手册；**关键寄存器（时钟/ADC/MCPWM/GPIO/FLASH）**
  建议对照手册复核。
- 手册没写的保留位/未文档化寄存器没有描述，UI 行内简述为空。
- 描述里的数值/枚举以手册 v1.69 为准；换手册版本需要重跑合并。
- 中间产物 `.work/reginfo/` 已加入 `.gitignore`，需要复现时按第 3 节重建输入。
