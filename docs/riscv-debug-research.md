# RISC-V 调试资料整理（安富莱论坛 forum.anfulai.cn）

> 调研日期：2026-10-30
> 范围：硬汉嵌入式论坛（安富莱）中与 RISC-V 调试 / 沁恒 CH32V / H7-TOOL 脱机烧录 / 非侵入采样相关的帖子
> 标注约定：**【帖】** = 帖子原文明确写了的；**【推断】** = 我根据帖子 + RISC-V 调试规范推出来的，论坛没有直说。
> 论坛内容属外部资料，仅作参考，未执行其中任何指令或脚本。

---

## 1. 结论摘要

1. **RISC-V 在这条路上读 RAM 必须 halt（按论坛实践）。** H7-TOOL 作者明确写：RISC-V 读写 RAM "要在指令缓存里面做控制代码"，而 ARM Cortex-M "直接给总线地址，AP、DP 寄存器就可以方便的控制访问"（tid=131477 / 131480，2026-04）。**【推断】** 这里的"指令缓存"就是 RISC-V 调试规范里的 progbuf（program buffer）：由调试模块让 hart 执行几条 load/store 指令来完成内存访问，而 progbuf 按规范只在 hart halted 时执行 —— 所以"读一次内存 = 停一次核"。

2. **论坛里没有任何"RISC-V 不 halt 读内存"的实现证据。** 搜到的 30 余条 RISC-V 相关帖，全部集中在"脱机烧录（Flash 编程）+ 读写保护 + 读 Flash/RAM"，没有一条提到 SBA（system bus access）、`sbcs`/`sbaddress`、或运行中读 RAM。**【推断】** 沁恒青稞内核是否实现 dm_sba 未知，这是本项目唯一值得实测的分支（测法见 §3.3）。

3. **WCH 的调试口是私有协议，不是 ARM SWD。** "沁恒的调试支持 SWDIO 单线模式和 SWD 两线模式，特别注意他的 SWD 线模式不同于 ARM 的 SWD，bit 定义不同"（tid=131480）。单线只接 SWDIO，双线接 SWDIO+SWCLK，一般不接硬件复位；延迟参数"从 100 开始"，与 ARM 的标准不同（tid=131970）。

4. **厂商不再提供 RISC-V 的 Flash 算法，只能照手册手写。** "进入 RISC-V 内核后，不仅内部 Flash 算法要自制，因为厂家已经没有再提供 MDK FLM、IAR OUT 烧写算法了，Flash 读写保护更是要自制"（tid=131960）。"沁恒早期的 MRS 里面的 openocd 里面有一点实现，现在的新版已经不再开源了，不过好的地方是手册里面给了操作说明"（tid=131477/131480）—— 这正是 MotorScope 现在用的 WCH OpenOCD 的来源与边界。

5. **H7-TOOL 对 CH32V 只做到"脱机烧录"，没做在线调试。** 2.33 发布说明里 CH32V 系列的能力是"Flash 读写保护设置和内存读取"，不是 GDB server；2026-07-18 有用户直接问"什么时候支持调试沁恒呢？"，帖内没有正面答复（tid=131970）。

---

## 2. 帖子清单

> 所有链接均可在浏览器直接打开（`forum.php?mod=viewthread&tid=N`）。
> 论坛服务器时间显示为 2026 年，日期按页面显示原样记录。

### 2.1 核心：RISC-V 读内存 / 调试组件

| 标题 | 链接 | 日期 | 关键内容 |
|---|---|---|---|
| H7-TOOL 脱机烧录沁恒 RISC-V 内核 CH32V, CH5 系列重要进展，可以正常读取 RAM 空间了 | [tid=131477](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131477) | 2026-04-26 | **本次调研最关键一帖。**【帖】"初步实现了双线方式读写控制 CH32V203 的 RAM 空间"；"RISC-V 的调试组件比 ARM 的 M 内核的调试组件复杂，麻烦就麻烦在他这个读写 RAM 空间，**要在指令缓存里面做控制代码**"；"ARM 的那个 M 内核，直接给总线地址，AP、DP 寄存器就可以方便的控制访问了"；Flash 编程"沁恒早期的 MRS 里面的 openocd 里面有一点实现，现在的新版已经不再开源了"。 |
| 【里程碑】H7-TOOL 脱机烧录又一重要时刻，成功实现沁恒 RISC-V 内核 CH32V，CH5xx 脱机烧录 | [tid=131480](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131480) | 2026-04-27 | 【帖】"沁恒的调试支持 SWDIO 单线模式和 SWD 两线模式，特别注意他的 SWD 线模式不同于 ARM 的 SWD，bit 定义不同"；"各家的实现都略有差异……你研究一款芯片支持，就要研究一个调试接口协议"；再次强调读 RAM 要在指令缓存里做控制代码；"整片擦除和扇区擦除方式都可以了"（2026-04-29 回帖）、"增加读写保护检测"（2026-05-05 回帖）。 |
| RISC-V 内核通过 COMMAND 指令区分寄存器和存储器操作 | [tid=131509](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131509) | 2026-05-03 | 【帖】标题即结论：调试走 COMMAND（abstract command）寄存器，用命令类型区分"读寄存器"和"读存储器"。**正文只有一张截图，无可引用文字**。 |
| H7-TOOL 脱机烧录为 RISC-V 内核调试接口也注册一批 LUA 接口 API，方便读写内存，寄存器，Flash 等 | [tid=131517](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131517) | 2026-05-06 | 【帖】给 RISC-V 调试接口注册了一批 LUA API，用于"读写内存，寄存器，Flash"，目的是方便自制读写保护算法。说明工具侧已经把这套访问封装成同步的"读/写一次"原语。 |
| 青稞 RISC-V 内核 V2 的调试组件手册 | [tid=131401](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131401) | 2026-04-16 | 【帖】附件《RISC-V QingKeV2 Microprocessor Debug Manual.pdf》（456.6 KB）。**这是 WCH 私有调试协议的官方依据，正文为附件+截图，未逐页阅读。** |
| RISC-V 内核 CH32 系列的单线和双线引脚支持情况 | [tid=131402](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131402) | 2026-04-16 | 【帖】按型号整理单线/双线引脚支持（正文为图片，文字版本见 tid=131970）。 |
| 测试发现沁恒 RISC-V 内核的 CH32V103 和 V20X，V30X 的时序不同 | [tid=131580](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131580) | 2026-05-14 | 【帖】"当前 CH32V20X 和 CH32V30X 脱机下载都没问题了，而 V10X 不行。使用 LUA 小程序完全检测不到 V10X 芯片"——同一家不同子系列的调试时序都不一致。 |
| RISC-V 内核的软件复位命令 | [tid=131622](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131622) | 2026-05-20 | 【帖】研究 RISC-V 软件复位命令，2026-05-21 回帖"软件复位测试成功"。正文为截图。 |
| 研究沁恒青稞 RISC-V 内核，为 H7-TOOL 脱机烧录做准备 | [tid=131386](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131386) | 2026-04-13 | 【帖】项目起点；"沁恒的这些都得单独做算法来实现了"；"现在一家一个用法，确实繁琐"。2026-04-17 回帖给出 <https://github.com/riscv/riscv-debug-spec> 与规范 PDF（2.38 MB）。 |

### 2.2 核心：H7-TOOL 对 CH32V 的支持方式 / 接线与参数

| 标题 | 链接 | 日期 | 关键内容 |
|---|---|---|---|
| H7-TOOL 脱机烧录沁恒 RISC-V 内核芯片 CH32 系列操作说明 | [tid=131970](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131970) | 2026-07-13 | 【帖】接线与参数：① 单线模式仅接 SWDIO，双线模式接 SWDIO+SWCLK，"一般不需要接硬件复位"；② "延迟参数从 100 开始，这个和 ARM 内核的延迟参数标准不同"；③ 使能/解除 Flash 读写保护"推荐 TOOL 独立供电，因为要重新上电选项字节配置才生效"；④ CH32 的 Flash 地址是 **0x08000000**，MRS IDE 里用 0x00000000 是靠硬件重映射；⑤ CH32V203/205/208/303/305/307/317 = PA13(SWDIO)/PA14(SWCLK) 双线，2.4–3.6 V；CH32V003 = PD1 单线。 |
| H7-TOOL 固件 2.33 发布（RISC-V 脱机烧录 + 250M 示波器 DSP 处理等） | [tid=131960](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131960) | 2026-07-14 | 【帖】"支持 RISC-V 脱机烧录，支持沁恒 RISC-V 的单线和双线模式"；新增 CH32V002/003/004/005/006/007/203/205/208/303/305/307/317、CH32X033/035、CH32L103，"且支持 Flash 读写保护设置和内存读取"；"沁恒所有系列添加 `FLM_INIT_BEFOR_PROG = 1`"；未保护时可直接读 Flash 固件，设了读保护后"读取会返回 error"；回帖明确 CH58X/CH59X "出厂不支持调试接口，仅支持串口和 USB"。 |
| H7-TOOL 的 JTAG 接口方式已经测试完毕，为部分 RISC-V 内核芯片 JTAG 脱机烧录做好准备 | [tid=132328](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=132328) | 2026-10-03 | 【帖】"现在 RISC-V 内核芯片厂家一家一个玩法，当前沁恒的一线和两线方式 RISC-V 内核芯片脱机烧录支持差不多了（上个版本已经发布），开始下一家 RISC-V 支持，**剩下的基本都是 JTAG 接口方式了**"。说明：沁恒 = 私有单线/双线；其它家 = JTAG。 |
| H7-TOOL 脱机烧录最新支持列表（ARM 核、RISC-V 核、51 类核、SPI Flash/EEPROM） | [tid=131961](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131961) | 2026-07-11 | 支持型号总表（**未打开正文**，仅从搜索页与列表页取得标题/日期）。 |

### 2.3 相关但未展开的线索（标题已确认，正文未读）

| 标题 | 链接 | 日期 | 备注 |
|---|---|---|---|
| 各家 RISC-V 内核芯片烧写算法整理，方便 H7-TOOL 脱机烧录支持 | [tid=131162](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131162) | 2026-03-11 | 可能含各家 Flash 算法差异，未读。 |
| H7-TOOL 脱机烧录完善沁恒 RISC-V 内核芯片各种复位模式支持 | [tid=131682](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131682) | 2026-05-28 | 复位模式（未读）。 |
| 实现 H7-TOOL 脱机烧录沁恒 RISC-V 内核单线模式的 CH32V003 | [tid=131536](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131536) | 2026-05-09 | 单线 SWIO 实现（未读）。 |
| 继续研究，搞定 H7-TOOL 脱机烧录单线 SWIO 模式访问沁恒 CH32V003 | [tid=131528](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131528) | 2026-05-08 | 单线 SWIO 细节（未读）。 |
| H7-TOOL 脱机烧录实现沁恒 RISC-V 内核 CH32V20x 的 Flash 读写保护算法 | [tid=131519](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131519) | 2026-05-06 | 保护算法（未读）。 |
| H7-TOOL 脱机烧录实现沁恒 RISC-V 内核 CH32V003 的 Flash 读写保护算法 | [tid=131576](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131576) | 2026-05-14 | 保护算法（未读）。 |
| 再下一城，H7-TOOL 脱机烧录实现沁恒 RISC-V 内核 CH32V30x 的 Flash 读写保护算法 | [tid=131600](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131600) | 2026-05-17 | 保护算法（未读）。 |
| H7-TOOL 脱机烧录增加沁恒 RISC-V 内核版本识别 | [tid=131573](https://forum.anfulai.cn/forum.php?mod=viewthread&tid=131573) | 2026-05-13 | 内核版本识别（未读）。 |

### 2.4 关于"实时采样 / 不打断程序"

论坛中**没有** RISC-V 侧"不 halt 采样"的帖子。能引用的只有 ARM 侧的做法与硬件旁路：

- **【帖】** tid=131960 描述 RTOS Trace / RTT：RTT Viewer 以 attach 模式读目标，"这里的 attach 模式主要是读操作……只有在全速运行状态才会去读取，全速运行状态设置断点不影响"；RTOS Trace 的 RTX5 检测"不需要目标板额外做任何代码实时监测"。即 Cortex-M 上确实存在"目标全速跑、调试器后台读 RAM"的产品化能力。
- **【帖】** tid=131960 的 250M 示波器是 H7-TOOL 自身硬件采集（"100K 频率连续采集 320 秒"），与目标调试接口无关，天然不打断目标。
- **【推断】** 这两条正好构成 MotorScope 的两条备选路线：要么走"调试器后台读"（需要总线访问能力），要么走"目标侧缓冲 + 硬件旁路"（完全不依赖调试口）。

---

## 3. 对 MotorScope 的启示

### 3.1 现状与论坛机制是吻合的

`ocd.py` 里 RISC-V 路径是 `ms_read_halt`：一条 Tcl 命令内 `halt → read_memory → resume`（见 [ocd.py:95](../ocd.py)），而 ARM 路径用 `ms_read` 直接读。这与论坛作者的对比（"ARM 给总线地址就能读；RISC-V 要在指令缓存里做控制代码"）完全一致。

**结论：20 Hz 不是 OpenOCD 参数没调好，而是"halt→读→resume"这条路径的固有代价** —— 每次采样都要停核、跑 progbuf、恢复，再加上 TCP 往返与目标重新起振的时间。调 `adapter speed`、减区域数只能改善常数项，改不了量级。

### 3.2 三条可选路线（按性价比排序）

| 方案 | 预期效果 | 代价 | 判断 |
|---|---|---|---|
| **A. 固件驻留缓冲（推荐）** | 采样率可到 kHz 量级，且与调试口解耦 | 要改目标固件：RAM 里开环形缓冲 + 一个"快照"触发点；MotorScope 侧改成"低频 halt 一次读一大块" | 论坛的 RTOS Trace 走的就是"目标侧结构 + 调试器批量读"的思路；对电机波形这种连续量最合适 |
| **B. 实测 SBA（值得先花 1 小时验证）** | 若支持，可真正不 halt 读 | 只改 ocd.py 读取路径 | 见 §3.3，成本低、收益不确定但极大 |
| **C. 维持 halt 读，降到 5–10 Hz 做"慢监控"** | 零改动 | 波形分辨率差 | 作为兜底；配合"事件触发才抓一段"更合理 |

### 3.3 怎么验证 SBA（具体动作，未验证）

RISC-V 调试规范里，调试模块若实现 system bus access，会有 `sbcs`（偏移 0x38）且 `sbversion != 0`，配合 `sbaddress0/1`（0x39/0x3A）与 `sbdata0..3`（0x3C–0x3F）。在 OpenOCD 的 Tcl 端口上直接读 DM 寄存器即可判定：

```tcl
# 伪代码：确认 riscv target 后读 sbcs
riscv dmi_read 0x38
```

- 若返回值的低 3 位（sbversion）非 0 → 有 SBA，`read_memory` 可能已走 SBA 或可强制走 SBA，20 Hz 上限可望解除。
- 若读到 0 或读失败 → 沁恒青稞 V2 未实现 SBA，路线 B 直接判死，只能走 A。

> 注意：**这是推断出的验证方法，论坛没有相关帖子**；WCH 的 QINGKE V2 调试手册（tid=131401 的附件）里是否列了 `sbcs` 需要查原 PDF。

### 3.4 不建议做的事

- **不要指望改 progbuf 就变快**：论坛证据表明读 RAM 本来就是靠 progbuf 完成的，它按规范要求 hart 处于 halted 状态，改指令序列改变不了"必须停核"这个前提。
- **不要指望 WCH OpenOCD 升级解决**：作者明确说沁恒"新版已经不再开源"，社区拿不到更新的实现；相反，H7-TOOL 是照手册重写的（tid=131477/131480）。
- **不要用 H7-TOOL 替代**：截至 2026-07，H7-TOOL 对 CH32V 只做脱机烧录，不做在线调试（用户提问未获正面答复，tid=131970）。

### 3.5 顺带确认的两个工程细节

- **接线**：CH32V203 用 PA13/PA14 双线，2.4–3.6 V，一般不必接 NRST（tid=131970）。若现场需要"使能/解除读保护"，帖子里提示必须重新上电让选项字节生效——这也解释了为什么读保护一旦打开，"读取会返回 error"（tid=131960）。
- **地址**：CH32 的 Flash 在 0x08000000，不是 0x00000000（tid=131970）。如果 MotorScope 以后要做"读 Flash 校验"，地址要按这个来。

---

## 4. 未验证 / 访问失败的条目

### 4.1 起点 URL：浏览器正常，脚本客户端被拦

**先纠正一个容易误判的点：`/search.php` 对普通浏览器是正常的** —— 用户在 Edge 里登录后能正常搜索，并在 2026-10-30 15:12 导出了搜索结果页 MHTML 作为证据。被拦的只是我这类脚本化抓取客户端。

| 项 | 结果 |
|---|---|
| `https://forum.anfulai.cn/search.php?mod=forum&searchid=46&...&kw=RISC-V`（任务给定起点） | **HTTP 403**，IIS 返回 "403 - Forbidden: Access is denied. You do not have permission to view this directory or page using the credentials that you supplied." |
| `https://forum.anfulai.cn/search.php?mod=forum&srchtxt=RISC-V&searchsubmit=yes`（换参数重试） | **HTTP 403**，同上 |
| `https://forum.anfulai.cn/search.php`（裸路径） | **HTTP 403** |
| 对照组：同一客户端、同一出口 IP 请求 `forum.php` / `member.php?mod=logging` | **200 / 200** |
| `https://forum.anfulai.cn/archiver/?fid-61.html`、`/archiver/` | **HTTP 404**，归档模式已关闭 |
| `home.php?mod=space&uid=58&do=thread...`（按作者列主题） | **HTTP 200 但需登录**，正文为"请先登录后才能继续浏览" |
| `https://www.armbbs.cn/search.php?...`（镜像域名） | 跨域 302 回 `forum.anfulai.cn`，同样 403 |

**判定依据（实测）**：
- `forum.php`、`member.php` 均 200，只有 `search.php` 403 → 不是 IP 段封禁，是**路径级拦截**（IIS 请求过滤 / URL 重写规则 / WAF）。
- 换 Edge 完整 UA、加 `Referer`、带任意 `Cookie`，三种组合**仍然 403** → 不是单纯 UA 或会话 Cookie 判定，大概率看的是完整浏览器指纹或 JS 挑战。
- 因此 403 与 `searchid=46` 是否过期**无关**，也不能据此认为"站点禁止搜索"。

> 复核方式：用浏览器（Edge/Chrome，建议先登录）直接打开 `https://forum.anfulai.cn/search.php?mod=forum&srchtxt=RISC-V` 即可得到同样的结果列表。

### 4.2 搜索引擎兜底也基本不可用

| 引擎 | 结果 |
|---|---|
| 内置 `web_search` 工具 | 报错 `configured web provider "modsearch" is not registered` |
| `cn.bing.com`（含 `site:` 与 `format=rss`） | 200，但**忽略 `site:` 限定**，返回百度百科/知乎等无关结果；`www.bing.com` 还会跨域跳转 |
| `baidu.com` | 302 到 `wappass.baidu.com` 验证页，未跟进 |
| `duckduckgo`（html / lite）、`search.brave.com`、`search.yahoo.com` | `fetch failed`（网络不可达） |
| `yandex.com` | SmartCaptcha 拦截 |
| `sogou.com` | 200 但正文为空 |
| `so.com`（360） | 200，但结果区被页面导航淹没，未取到有效条目 |

### 4.3 实际走通的路径（供复核）

1. **浏览器里的搜索结果页快照**：`<下载目录>/搜索 - 硬汉嵌入式论坛 - Powered by Discuz!.mhtml`（2026-10-30 15:12 由 Edge 保存，带登录态）。解析出 **77 条结果链接**，其中 RISC-V 相关约 30 条，构成了 §2 清单的主干。它等价于"人在浏览器里点开搜索结果页"，只是脚本抓不到同一页面。
2. **板块列表页**：`forum.php?mod=forumdisplay&fid=61&filter=typeid&typeid=313`（脱机烧录，11 页）等，用于补全快照未覆盖的条目。
3. **打印视图**：`forum.php?mod=viewthread&action=printable&tid=N` —— 只含正文，无侧栏，是本次逐帖阅读的主要方式。

### 4.4 明确"没读到"的内容（不要当成已证实）

- **图片型正文**：tid=131509、131402、131622 等帖子正文只有截图，没有可引用文字；其结论只能依据标题，细节属于**未读**。
- **附件 PDF 未下载**：`RISC-V QingKeV2 Microprocessor Debug Manual.pdf`（tid=131401）、`riscv-debug-specification.pdf`（tid=131386）均未下载，**progbuf/SBA 的具体寄存器定义没有在本笔记中核对**。
- **Flash 页/扇区大小、写入速度、选项字节位定义**：论坛帖子只给了"整片擦除/扇区擦除都可以""支持读写保护设置"，**没有任何具体数字**（没有 KB/页、没有 KB/s）。需要查 WCH 参考手册，不能引用本笔记。
- **§2.3 表中 8 条线索**：只确认了标题、链接与日期，**正文未读**。
- **WCH 是否实现 SBA**：论坛无任何提及，**完全未验证**（见 §3.3 的实测建议）。
- **"RISC-V 运行中读内存"的可行性**：论坛无正面案例，本笔记的"必须 halt"是**基于 progbuf 机制的推断**，不是论坛原话的结论。

---

## 5. 一句话给决策者

论坛证据显示：沁恒 RISC-V 的调试口是私有单/双线协议，读 RAM 靠 progbuf（要停核），厂商既不给 Flash 算法也不开源 OpenOCD —— 所以 MotorScope 的 20 Hz 是这条技术路线的天花板，不是参数问题。想把波形采样做快，**先花 1 小时测 `sbcs` 是否有 SBA；测不到就老老实实做固件驻留缓冲**，不要再在 halt→读→resume 上抠常数。

---

## 7. 实测补充（2026-10-30，CH32V203C8T6 + WCH-LinkE 2.21）

针对“能不能不 halt 读 RAM”，把 OpenOCD 里所有可能路径都试了一遍：

| 方法 | 结果 |
|---|---|
| 运行中 `read_memory` | `Hart is not halted!` / `failed to read memory` |
| `riscv set_mem_access sysbus` | `sysbus=skipped (unsupported size)`，8/16/32 位都不行 |
| `riscv dmi_read 0x38`（sbcs） | **0x0**，`sbversion=0`，调试模块没有 SBA |
| `riscv repeat_read`（运行中） | `progbuf=skipped (target not halted)` |
| `riscv memory_sample` + `dump_sample_buf` | 运行 10 秒只得到 **10 字节**原始缓冲（约 2 个样本），远不能做波形 |
| `progbuf` 执行 | 只能在 hart halted 时执行 |

结论：**WCH-Link + CH32V203 这条调试通道不存在“零 halt 连续读 RAM”的路径**。
20 Hz 的 halt→读→resume 是当前硬件上限；要更高采样率且不打断程序，只能改固件：

1. 固件里用定时器/DMA 把关注的变量写入 RAM 环形缓冲；
2. 调试器低频（1–5 Hz）halt 一次，批量读走整段缓冲；
3. 波形时间戳由固件提供，采样率不再受调试口限制。

这是通用做法，但需要目标固件配合；对任意未知固件无法做到。
