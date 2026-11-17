# MotorScope HTTP API（给 Agent / 脚本用）

服务默认只监听 Windows 本机 `http://127.0.0.1:8765`；需要局域网访问时在 DSH 面板
打开“局域网共享”（或启动加 `--host 0.0.0.0`），启动日志会打印实际 URL。
**无鉴权**，同一网络内能访问到端口的设备都能调用写/复位接口；只在本机使用时
保持默认的 `127.0.0.1` 监听。页面本身就是这套 API 的客户端；Agent 可以直接读，
不需要解析 HTML。

## 建议事项（Agent / 脚本先读）

> 这是一套**共享单调试器、无鉴权、有副作用**的实时接口。先按本节顺序做，能避开大部分坑：
> `GET /api/status` 看连接 → `GET /api/config` 看当前采样列 → 读历史/单点读值；
> 写值前先单点读确认地址；用完调试器后 `POST /api/control/disconnect` 释放探针。

| 想做什么 | 推荐接口 | 关键点 |
| --- | --- | --- |
| 看是否连上、当前机型、采样率 | `GET /api/status` | `source.connected`、`profile.id`、`sampler.rate`、`uptime` |
| 看当前采样了哪些信号 | `GET /api/config` | `signals[]` 顺序就是 `/api/history` 的列顺序 |
| 单点读一个变量/寄存器 | `POST /api/read` | 不加入采样；先查 `/api/catalog` 拿地址 |
| 连续看/回溯数值 | `/api/history`、`/api/history/next` | 最后一行是最新值；物理量 = `raw * scale + offset` |
| 写一个值/位域 | `POST /api/write` | **真实改内存**；看返回的 `verified` |
| 导出波形图片 | `GET /api/screenshot` | 指定时间窗/全部时间；`format=json` 带精确统计 |
| 给已选波形分组/命名 | `GET/POST /api/wave/groups*` | 新建/重命名/加入分组；颜色默认按变量名 hash，可显式覆盖 |
| 不采样了 / 要用 Keil | `POST /api/control/disconnect` | 释放 H7-TOOL/OpenOCD；内存历史仍可读 |

### 怎么读值

1. 先 `GET /api/status` 确认 `source.connected`、`profile.id`、`sampler.rate`；
2. `GET /api/config` 拿当前采样通道；第 i 个通道对应 `/api/history` 每行的第 i 个值；
3. 连续值用 `GET /api/history?limit=1`（最新一点）或
   `GET /api/history?limit=200`（最近 200 点）；最后一行就是当前值；
4. 单点读任意地址（不进入采样、不想要连续曲线时）用 `POST /api/read`：

```bash
curl -s -X POST http://127.0.0.1:8765/api/read \
  -H 'Content-Type: application/json' \
  -d '{"addr":536871762,"size":2,"signed":false}'

# 位域：bit=[shift,width]
curl -s -X POST http://127.0.0.1:8765/api/read \
  -H 'Content-Type: application/json' \
  -d '{"addr":1073741824,"size":4,"bit":[8,4]}'
```

- `/api/read` 返回 `value`（已按位域/有符号解码）和 `word`（所在 32 位字）；
- 变量/寄存器的地址、类型、位域从 `GET /api/catalog` 的 `variables` / `peripherals` 取；
- 物理量 = `value * scale + offset`（`scale/offset/unit` 在 `/api/config.signals[]`）；
- **读清零/读后触发**类寄存器不要高频读；不确定时优先读 RAM 变量，或先降频/单点读。

### 怎么写值

- `POST /api/write` 会**立即真实写入**目标 RAM 或外设寄存器，没有撤销、没有二次确认；
- API **不检查页面上的“允许写入”解锁**——那个开关只约束浏览器 UI，Agent 必须自己负责；
- 先 `POST /api/read` 确认地址和当前值；不确定的寄存器不要写，尤其是读清零/触发类；
- 写之前确认电机/执行机构处于安全状态，尽量暂停或降速后再改控制参数；
- 位域写用 `bit:[shift,width]`，服务端做读-改-写，保留同字其它位；
- `size` 只支持 1/2/4 且地址按宽度对齐；服务端只允许 RAM
  `0x2000_0000..0x2000_2000` 和 SFR `0x4000_0000..0x5000_0000`，超出直接拒绝；
- 返回 `verified:false` 表示写已发出但回读不一致（固件在改/寄存器只读），**不要当成功**。

```bash
curl -s -X POST http://127.0.0.1:8765/api/write \
  -H 'Content-Type: application/json' \
  -d '{"addr":536871762,"size":2,"value":1500}'

# 位域：只改 32 位字里的 [8,4]，其余位保留
curl -s -X POST http://127.0.0.1:8765/api/write \
  -H 'Content-Type: application/json' \
  -d '{"addr":1073741824,"size":4,"value":10,"bit":[8,4]}'
```

### 怎么读历史

- **最近 N 点**：`GET /api/history?limit=500`（默认 1000，最大 40000）；
- **某时间点之前**：`GET /api/history?before=<t_ms>&limit=500`；
- **兼容旧调用**：`GET /api/history?seconds=60`（最多 180 秒）；
- **持续增量**：`GET /api/history/next?after=<cursor>&timeout=20&limit=1000`；
  返回的 `cursor` 作为下一次的 `after`，没数据时最多挂起 `timeout` 秒（不是错误）；
- `generation` 变化说明采样配置/信号源变了，旧 `cursor` 作废，要重新读 `/api/config`；
- `run_id` 是本次服务进程的标识；**服务重启后 `run_id` 变化，`t_ms` 从 0 重新开始**。
  `run_id` 变了或 `/api/history/next` 返回 `reset:true`，丢掉旧 cursor 重新读；
- `gap:true` 表示请求的时间早于环形缓冲里最老的点（数据已被挤掉）；
- `t_ms` 是相对服务器启动的毫秒，不是 wall clock；`/api/status` 的 `wall_start_ms + t_ms`
  可还原墙钟毫秒，也可直接用 `/api/screenshot?format=json` 里的 `start_wall_ms/end_wall_ms`；
- 内存 history 最多 40000 点；更长的整段会话用
  `GET /api/record-cache/overview` / `GET /api/record-cache/window?start=&end=`；
- 改采样通道（`POST /api/config` 的 `signals` 变化）会清空历史并让 `generation` +1，
  需要重新开始读；多客户端共享同一套配置，改之前先确认没有别人在用。

```bash
# 最新值（最后一行）
curl -s "http://127.0.0.1:8765/api/history?limit=1"

# 增量 long-poll
curl -s "http://127.0.0.1:8765/api/history/next?after=1441480.1&timeout=20&limit=1000"
```

### 什么时候应该断开调试器

- **要用 Keil / MounRiver / 厂商下载工具烧录或调试前**：OpenOCD 会占着
  H7-TOOL / WCH-Link，先 `POST /api/control/disconnect`，否则对方会报“设备被占用”；
- 换调试器、换目标板、重新给目标上电、换接线之前；
- 长时间不再采样时，释放探针给别的工具/别的项目；
- 连接异常、目标卡死、OpenOCD 报错时：断开 → 重新连接，比在原连接上反复重试可靠；
- **切换机型会自动断开**（地址整体变了），切完需要重新连接；
- `POST /api/reset` 只复位目标，不会断开连接；
- `POST /api/scan/id` 在不带 `keep_connected:true` 时，会自动连接→扫描→断开；
- 断开后内存里的 history/信号表仍然可读，`/api/screenshot` 也还能截已有历史；
  但 `/api/read`、`/api/write`、`/api/reset` 和新的采样都需要先重新连接。

```bash
curl -s -X POST http://127.0.0.1:8765/api/control/disconnect
```

### 怎么导出波形图片

- 先 `GET /api/screenshot/info` 看可用时间范围和当前采样通道；
- 全时段：`GET /api/screenshot?all=1`
- 最近 10 秒：`GET /api/screenshot?seconds=10`
- 指定时间窗：`GET /api/screenshot?start=<t_ms>&end=<t_ms>`
- 选通道：`signals=id1,id2`；`width=1600`、`theme=dark`、`title=...` 可选；
- 返回标准 PNG，每个通道一行小图，带通道名、单位、min/max/avg、时间轴，
  适合直接给多模态模型看或贴进报告；
- 需要精确数值时用 `format=json`，返回 base64 PNG + 每通道 `min/max/avg/count`、
  `range.start_ms/end_ms/start_wall_ms/end_wall_ms`；
- 没有数据时接口会返回 400 和可用范围；先连接并确认 `/api/config.signals` 非空；
- 需要原始 CSV 时：先 `POST /api/record {"active":true}` 开始录制，再
  `GET /api/record.csv?ids=id1,id2`。

```bash
curl -s -o wave.png "http://127.0.0.1:8765/api/screenshot?seconds=10"

curl -s -o all.png  "http://127.0.0.1:8765/api/screenshot?all=1&width=1600&theme=dark"

curl -s "http://127.0.0.1:8765/api/screenshot?format=json&start=12000&end=20000"
```

### 其他通用建议

- 先读后写：任何写/复位前，先用 `/api/status`、`/api/config`、`/api/read` 确认状态；
- 接口错误统一看 `ok` 字段；`ok:false` 时读 `error`，不要只看 HTTP 状态；
- `/api/history/next` 是 long-poll，不要忙轮询；`timeout` 内没数据是正常超时；
- 多客户端共享同一个调试器和采样配置，改通道/写值前先确认没有别的页面/Agent 在用；
- 更新 AXF 后用 `GET /api/catalog/source` 确认路径，必要时重新连接并重新下发
  `/api/config`；旧历史可能对应旧固件地址，不要混用。

## 1. 数据模型

`GET /api/status` 返回的 `config.signals` 是**当前采样通道的顺序表**：

```json
{
  "id": "motor.over.current",
  "name": "motor.over.current",
  "addr": 536871762,
  "size": 2,
  "signed": false,
  "float": false,
  "scale": 1.0,
  "offset": 0.0,
  "unit": "counts",
  "axis": "left",
  "bit": [0, 1]
}
```

> `float: true` 表示 IEEE754 **float32** 变量（DWARF `type=float`，`size=4`）：
> `/api/history`、SSE、CSV 返回的已经是解码后的浮点数，不是 32 位 bit pattern；
> `scale/offset` 仍会继续应用。NaN/Inf 统一返回 `null`（避免 `JSON.parse` 失败）。
> 8 字节 `double` 目前不保证支持。

`/api/history` 和 `/api/history/next` 的样本是：

```json
[[t_ms, [v0, v1, ...]], ...]
```

- 第 i 个值对应 `config.signals[i]`；
- `v` 已经是位域/有符号解码后的原始值；
- 实际物理量 = `v * scale + offset`；
- `t_ms` 是相对服务器启动的毫秒，不是 wall clock；可用 `/api/status` 的 `uptime` 反推；
- `generation` 是配置代数：改通道/换信号源会 +1，旧游标作废。

### 1.1 仿真测试波形（`--sim` / `--sim-connect`）

> 普通启动（含 `--sim`）保持**未连接/未采样**；演示自动跑请用 `--sim-connect`。
> `start_scope_sim.bat` 已自动带 `--sim-connect`。

为了测试非正弦渲染（锯齿/三角/方波/噪声/尖峰/纹波），`--sim` 下可以直接 POST
`/api/config` 加入 name 以 `sim.` 开头的信号（地址任取不重复即可）：

| name | 波形 |
| --- | --- |
| `sim.sawtooth` | 1.6s 锯齿 |
| `sim.triangle` | 1.6s 三角 |
| `sim.square` | 1.2s 方波（建议 step=true） |
| `sim.noise` | 高斯噪声 + 慢漂移 |
| `sim.spikes` | 基线 + 1.7s 周期尖峰 |
| `sim.ripple` | 3.1Hz + 31Hz 纹波 + 噪声 |

例如在现有 config 后追加
`{"id":"sim.sawtooth","name":"sim.sawtooth","addr":536879104,"size":4,"table":true,"plot":true}`，
再 POST 回去；SimSource 按 name 生成。用于验证均线/振幅带在非正弦波形上的渲染。

## 2. 读之前（默认，立即返回）

```http
GET /api/history?limit=1000
GET /api/history?before=1441480.1&limit=1000
GET /api/history?seconds=60          # 兼容旧调用
```

- 不传 `before`：从最新点往前取 `limit` 个，**不等待**；
- `before`：取 `t <= before` 的最近 `limit` 个；
- `limit` 默认 1000，最大 40000；
- 同时传 `before`/`limit` 时走新逻辑；只传 `seconds` 时走旧逻辑；`before` 与 `seconds` 同时存在时以 `before` 为准。

```json
{
  "signals": [ { "id": "motor.over.current", "scale": 1.0, "offset": 0.0, "unit": "counts" } ],
  "samples": [[1441480.1, [0, 220, 7, 0]]],
  "cursor": 1441480.1,
  "oldest": 1439000.0,
  "latest": 1441480.1,
  "gap": false,
  "reset": false,
  "generation": 3,
  "run_id": 123456.789,
  "count": 1
}
```

- `gap: true`：`before` 比环形缓冲里最老的点还老，之前的数据已经丢了；
- `cursor` 建议作为下一次 `after`；
- `run_id` 与上次不同（服务重启）时，`cursor` 必须重置。

## 3. 读之后（long-poll）

```http
GET /api/history/next?after=1441480.1&timeout=20&limit=1000
```

- 有 `t > after` 的样本就立刻返回；
- 没有就挂起最多 `timeout` 秒（默认 20，最大 60），新样本一到立刻醒；
- 超时返回 200 + `"timeout": true` + 空 `samples`，不是错误；
- `after` 比 `oldest` 还老：返回当前保留的最老一段 + `"gap": true`；
- `after` 省略：有历史时等价于“等最新点之后的下一个”；没有历史时等第一个样本；
- 配置代数变了：返回 `"reset": true` + `"gap": true`，Agent 应重新读 `signals` 并重置游标。

## 4. 状态 / 目录 / 日志

| 接口 | 用途 |
| --- | --- |
| `GET /api/status` | 连接状态、实际采样率、`generation`/`run_id`、`history` 点数、`oldest_t`/`latest_t`、`config.signals`、`wall_start_ms`、`lan.ips/port`（分享链接优先用 192.*） |
| `GET /api/config` | 只读当前共享采样配置：`signals`（与 history 列同序）、`rate`、`generation`、`signal_flags`。**没有空表语义**；之前误用的 GET 现在是合法只读接口 |
| `GET /api/docs` | 人类可读的 API 文档页（HTML，实时渲染自本文件；`?format=md` 返回 Markdown 原文） |
| `GET /api/signal-flags` | API 侧表/波/写/颜色覆盖：`{"ok":true,"flags":{id:{table,plot,write}}}` |
| `GET /api/wave/groups` | 波形分组 + 当前已选择波形（`plot/table`、`groupId`、颜色）；分组数据来自该机型 `config.json` |
| `POST /api/wave/groups` | 新建分组（可带 `signals` 一并加入）；`/create` 为别名。另见 `/rename`、`/add`、`/delete`，详见 §5.6 |
| `GET /api/catalog` | 当前机型的变量/外设，地址/类型/位域/默认堵转信号；变量可带 `desc`（由 `profiles/<ID>/annotations.json` 合并） |
| `GET /api/catalog/source` | 当前/指定机型的源文件路径与存在性：`source.{axf,header,svd,table,map}` + `exists.*`；`?profile=<ID>` 查非当前机型。更新 AXF 前先用它确认路径 |
| `GET /api/reginfo?model=<ID>` | 该型号的寄存器描述（entries 数组；没有就返回空） |
| `GET /api/profiles` | 机型列表：`id/name/mcu/arch/available/variables/peripherals/source_axf` + `active` |
| `GET /api/profiles/config` | 只读某机型已保存的 `config.json`：`?id=<ID>`（缺省当前机型），返回 `profile/config/saved_at`。刷新页面时前端用它对齐本地存档，避免浏览器旧缓存覆盖机型配置 |
| `GET /api/log` | 服务 + OpenOCD 尾部日志 |
| `GET /api/usb-devices` | 枚举当前连接的 USB 设备，返回 `supported`（**每个调试探针实例一条**，含 `vid/pid/serial/name/backend/iface/arch/status`，以及 `in_use`/`used_by`：正被哪个输入源占用）；`?all=1` 附带 `others`/`total`。Windows 走 WMI（无需 pyusb/驱动），Linux 走 pyusb/sysfs。同款多设备用 `serial` 区分，可直接作为 `POST /api/connect` 或 `POST /api/sources` 的 `serial`。纯枚举不占用设备；不可用时返回 `ok:true, available:false, error`，不会 500 |
| `GET /api/scan/debuggers` | `GET /api/usb-devices` 的别名，面向自动化/Agent；`?all=1` 同样返回全部 USB 设备 |
| `GET /api/scan/hid` | 枚举 HID 设备（HIDClass / 键鼠 / 厂商自定义 HID，含 H7-TOOL 的 HID 接口）：`vid/pid/serial/name/status/instance/hid_class/is_collection/composite`；命中已知调试器时带 `known=true/debugger/backend/iface/arch/transport`。别名 `GET /api/hid-devices` |
| `GET /api/scan/id` | 只读扫描当前已连接目标的芯片 ID（等同 `POST /api/chip/probe` 的读操作）；未连接返回 `ok:false, connected:false, error:"未连接"`，**不会自动连接** |
| `GET /api/screenshot/info` | 截图前先看这里：当前可用时间范围 `oldest/latest/duration_ms`、采样率、可绘制的 `signals[]`、渲染风格 `render`（`web-panes` 双时间轴/网格密度）、示例 URL |
| `GET /api/screenshot` | 生成波形 PNG（给智能体/脚本看），渲染风格与网页波形区一致（深色 pane、面积填充、每通道独立 y 轴）。`all=1` 全部时间；`seconds=10` 最近 10 秒；`start=`/`end=` 指定 `t_ms` 时间窗；`signals=id1,id2` 选通道；`width/height/theme/title`；`format=json` 返回 base64 PNG + 每通道 min/max/avg。别名 `GET /api/screenshot.png` |
| `GET /api/sources` | 多输入源列表：每源 `id/label/kind/profile/arch/mcu/connected/rate/rate_actual/error/signals` + `primary/fusion_rate` |
| `GET /api/openocd/configs` | 列出可选 OpenOCD 配置：`?root=<根目录>&arch=cw32|riscv`，返回 `interfaces[]/targets[]`（name+绝对 path）、默认 interface/target、exe/scripts |
| `POST /api/sources` | 新建输入源：`{"label":"主控","kind":"openocd|attach|sim","profile":"DR2159","rate":200,"connection":{"serial":"...","iface":"cmsis-dap-v1.cfg"}}`；`connection.serial` 决定用哪颗探针。同一 serial 已被在连的源占用时，再连会返回明确错误（不会让两个 OpenOCD 抢同一颗探针） |
| `POST /api/sources/import` | multipart：`axf`（必填）+ `table`（SVD/JSON 可选）+ `name/mcu/kind/rate/serial/host/port`；**不切换当前机型**，直接新建 profile 并绑定为新源 |
| `POST /api/sources/<id>/connect` | 连接指定源；body 同旧 `/api/connect`（mode/arch/target/iface/serial/host/port） |
| `POST /api/sources/<id>/disconnect` | 断开指定源；其它源继续采样 |
| `DELETE /api/sources/<id>` | 移除源并从融合列中删掉它的信号 |
| `GET /api/record.csv` | 后端录制 CSV（需要先 POST `/api/record` 开启）；`?ids=a,b` 选列，未命中任何列时回退为全部录制列，不会只导出 `t_ms` |
| `GET /api/share/<id>` | 取回分享快照；30 天/最多 200 条，持久化在 `imports/shares.json` |
| `GET /api/stream` | SSE：`hello`（含 `clients`、`clientId/clientNo`、`presence`、当前共享 config）/ `status` / `s` / `config`（共享配置广播）/ `presence`（各端本地显示集合广播）；浏览器实时用 |

## 5. 控制接口（只读 Agent 不要调）

| 接口 | 说明 |
| --- | --- |
| `POST /api/share` | 保存当前前端快照（信号集 + 分组布局 + 时间窗口/图表开关），返回 `{"ok":true,"id":"..."}`；链接 `#share=<id>` |
| `POST /api/view` | `{"clientId":"c1","label":"dsh","visible":["信号id",...],"layout":{groups,rows,table,plot,axes,write}}`：上报本端表/波显示集合与波形分组布局，用于其他端“正在查看”提示、删除确认和“复制布局”；`layout.write` 为写入模块快照；不影响采样 |
| `POST /api/config` | `{"signals":[...],"rate":100}`，**单调试器共享采样配置**：应用后广播 `config` 给所有 SSE 客户端；通道变了清历史。多客户端时新客户端采用服务器当前配置，不自动覆盖 |
| `POST /api/signal-flags` | `{"id":"x","table":true,"plot":false,"write":false,"color":"#22d3ee"}` 或批量 `{"flags":{"id":{...}}}`；`read:true` 只做一次读取，`clear:true` 撤销该 id 的覆盖。浏览器轮询/SSE 应用后重新下发采样配置 |
| `POST /api/record` | `{"active":true}` 开始后端录制 |
| `POST /api/connect` | `{"mode":"openocd"|"sim"|"attach", "iface":"cmsis-dap.cfg"?, "serial":"002B..."?, "openocd":"自定义根目录"?}` 重新连；`iface` 覆盖默认 interface cfg，`serial` 通过 `-c "adapter serial <serial>"` 精确指定用哪个同款调试器（多 DAP 切换用，值来自 `GET /api/usb-devices`）；`openocd` 指定自定义 OpenOCD 根目录，留空则只在工程 `tools/openocd/` 查找 |
| `POST /api/control/connect` | `POST /api/connect` 的别名（自动化/Agent 统一前缀），参数、返回值完全相同 |
| `POST /api/disconnect` | 断开并释放 OpenOCD/H7-TOOL |
| `POST /api/control/disconnect` | `POST /api/disconnect` 的别名 |
| `POST /api/reset` | **会复位目标**：ARM 写 `AIRCR.SYSRESETREQ`，RISC-V 用 OpenOCD `reset run`；电机可能重新启动 |
| `POST /api/control/reset` | `POST /api/reset` 的别名 |
| `POST /api/scan/id` | `{"connect":true?, "keep_connected":false?, "mode":"openocd"?, "iface":..., "serial":..., "openocd":..., "arch":...}`：扫描芯片 ID。已连接时直接扫描；未连接且 `connect=true`（默认 true）时用当前机型/传入参数临时连接，扫描后默认断开；`keep_connected=true` 保留连接。返回 `ok/connected/autoconnect/kept_connected/was_connected/chip/profile` |
| `POST /api/catalog/axf` | **按本机路径更新 AXF/SVD/头文件并立即重建**：`{"axf":"D:\\...\\fw.axf","svd":"...","header":"...","table":"...","map":"...","profile":"N32G003","mcu":"...","ram":[536870912,536879104],"target_cfg":"...","interface":"..."}`。不复制文件，profile 直接指回构建输出，下一次构建后再次调用即可；`axf` 变化会自动按 ELF 段更新 `ram/arch`，SVD 变化会按 `<name>` 更新型号。别名 `POST /api/catalog/source/update` |
| `POST /api/catalog/reload` | 从当前机型的源 AXF/SVD 重建 signals.json；请求体带 `axf`/`svd`/`header`/`table`/`map` 路径时等价于 `POST /api/catalog/axf` |
| `POST /api/profiles/switch` | `{"id":"LKS32-FOC"}` 切换机型；返回 `catalog/config/profile(s)`，会断开调试源 |
| `POST /api/profiles/create` | `{"name":"N32G003","base":"DR1152"}` 复制指定/当前机型为新机型并切换（“新建副本”入口） |
| `POST /api/profiles/config` | `{"config":{...},"manual":true}` 保存前端工程快照到 `profiles/<ID>/config.json` |
| `POST /api/profiles/build` | `{"id":"LKS32-FOC"}` 重建该机型符号表；返回新 `catalog/counts` |
| `POST /api/read` | `{"addr":..., "size":1\|2\|4, "signed":bool, "float":bool?, "bit":[shift,width]?}` 读一次（不加入采样），返回 `value/word`；浮点变量传 `float:true`（或 `type:"float"`），按 IEEE754 float32 解码 |
| `POST /api/reginfo/import` | `{"model":"LKS32MC07x","entries":[...]}` 独立导入寄存器描述；写到 `web/mcu/<model>.info.json` |
| `POST /api/catalog/import` | multipart：`axf`（新建时必填）、`table`（`.svd`/`.json`，可选）、`header`（可选）；字段 `target=new\|update`、`name`（新建机型名）、`mcu`（可选）。`target=new` 新建机型并切换；`update` 写入当前机型并持久化 `profile.source`，只传 `table` 时仅替换寄存器表 |
| `POST /api/probe` | 一次性 TCL 握手，读 CPUID |
| `POST /api/write` | **会改目标内存**；写 RAM/SFR 并回读，见 5.1。浮点变量目前只支持显示/导出，不要按整数写 |

这些接口没有鉴权、是共享状态；Agent 只读时只使用 GET。

### 5.1 写入 `POST /api/write`

请求：

```json
{
  "addr": 536871762,
  "size": 2,
  "value": 1500,
  "bit": null,
  "verify": true
}
```

- `addr`：目标地址，按 `size` 对齐；
- `size`：1 / 2 / 4（字节）；
- `value`：写入值；超过位宽会被截断；
- `bit`：可选 `[shift, width]`，走读-改-写，只改位域，保留同字其它位；
- `verify`：保留字段；服务端始终回读。

允许范围：RAM `0x2000_0000..0x2000_2000`、SFR `0x4000_0000..0x5000_0000`，
且整个写入跨度必须在范围内。响应：

```json
{ "ok": true, "addr": 536871762, "size": 2, "value": 1500,
  "readback": 1500, "verified": true }
```

`verified=false` 表示写入已发出但回读不一致（固件可能在改、或寄存器不接受写入）。
未连接、未解锁、地址非法、对齐错误、宽度不支持等返回
`{"ok":false,"error":"..."}`（HTTP 500），前端会显示状态和 toast。

```bash
curl -s -X POST http://127.0.0.1:8765/api/write \
  -H "Content-Type: application/json" \
  -d '{"addr":536871762,"size":2,"value":1500}'
```

> 写入是**真实改内存**。改堵转阈值等控制变量前确认电机处于安全状态；
> 不要写读清零/读后触发类寄存器。浏览器端必须手动勾选“允许写入”，
> 且该解锁状态不跨刷新/工程切换保存。

## 5.1 服务端分块压缩录制缓存（旁路，只读当前会话）

现有 `/api/history`、SSE、前端 `S.samples`、`/api/record`+CSV 的语义**不变**；
录制缓存是额外的落盘旁路，采样线程只做非阻塞入队。默认目录 `./.record-cache/`，
默认总容量 4096 MB（`--record-cache-dir` / `--record-cache-limit-mb` /
`--record-cache-block-points` / `--no-record-cache` 可配，目录已 gitignore）。

- 会话：`session-<时间>-<随机>/`，`meta.json` 保存信号列、块索引（每通道 min/max）、
  `saved` / `clearable` / `active`、总容量计数。
- 块：`blk-000001.bin`，zlib 压缩；压缩前为
  `magic/version/channels/seq/start_ms/count` 头 + int32 时间偏移 + int32 样本矩阵。
  写入用临时文件 + `os.replace` 原子替换。块在满 `block_points`（默认 2000）、
  最长 5 秒、或采样停止/结束时落盘（低速率下最多积压 5 秒）。
- 退出/断开/换通道：未保存会话标记 `clearable=true`；下次启动优先删除。
- 容量满：先删 clearable 会话 → 再按创建时间删最旧 saved 会话 → 最后裁当前活动
  会话最旧块（保留最新块；当前正在写入的块绝不删）。单块即超限时短暂超限并记录
  `error`。保存只写本地 `saved=true` 标记，不做云上传。

```text
GET  /api/record-cache                    # 当前会话 info（start/end/count/saved/clearable/size/limit）
GET  /api/record-cache/overview?max_points=2000
                                          # 当前会话每桶每通道 min/max（并 flush 当前尾巴）
GET  /api/record-cache/window?start=&end=&max_points=20000
                                          # 当前会话时间窗原始样本；超 max_points 时等步长抽稀
POST /api/record-cache/save               # 标记当前会话 saved=true, clearable=false
```

`t_ms` 与 `/api/history` 一样是相对服务器启动毫秒。当前只暴露“当前会话”；
打开旧历史（saved 旧会话列表/按会话读取）尚未实现。窗口样本的列顺序以响应里的
`signals[]` 为准；前端按 `id` 重映射到自己的通道顺序。

### 5.2 API 侧表 / 波 / 写 / 读

- `POST /api/signal-flags` 影响 UI 的“表/波/写”开关和波形颜色；打开页面收到 SSE `flags`
  （或 3s 轮询 `GET /api/signal-flags`）后应用并重新 POST `/api/config`。
  **只有表/波/支撑会进入实时采样；仅 `write:true`、表/波都关的行不会进入采样**，因此 `/api/config` 与 `/api/history` 的列会减少。
- `color` 接受 `#RGB` / `#RRGGBB`（可省略 `#`）；会立即同步到 `/api/config` 的
  `config.signals[].color`（已采样行），并广播给页面，用于图例/波形颜色。
- `write:true` 等价于把该信号加入写入模块；`write:false` 移除。写入仍需页面手动解锁。
- `read:true` 是一次性读取，**不会**变成开关；也可继续用 `POST /api/read` 按地址读。
- API 覆盖是服务端内存态（重启丢失）；页面本地手动点表/波/写会撤销对应 id 的 API 覆盖。
- 未打开页面时，服务端不会主动改采样列；采样列仍由 `/api/config` 决定。

### 5.3 自动化控制 / 扫描 API 速查

给 Agent / 脚本用的稳定入口（不依赖前端页面）。纯枚举接口不打开、不 claim 任何 USB
设备；`connect` / `reset` 会实际占用调试器，`reset` 还会让目标重新运行。

```bash
BASE=http://127.0.0.1:8765

# 1) 扫描调试器列表（supported 每条含 serial/iface，可直接给 connect）
curl -s $BASE/api/scan/debuggers
curl -s "$BASE/api/scan/debuggers?all=1"      # 附带未识别的 USB 设备

# 2) 扫描 HID 列表（H7-TOOL 等 HID 接口；known=true 的项带 iface/backend）
curl -s $BASE/api/scan/hid

# 3) 连接（serial/iface 可省略，由 OpenOCD 自选；mode=sim 可无硬件演示）
curl -s -X POST $BASE/api/control/connect \
  -H 'Content-Type: application/json' \
  -d '{"mode":"openocd","serial":"002B00313031510537363237"}'

# 4) 扫描芯片 ID：
#    已连接 -> 直接读；未连接 -> POST 默认临时连接、扫描后断开（keep_connected 可保留）
curl -s -X POST $BASE/api/scan/id -H 'Content-Type: application/json' -d '{}'
curl -s -X POST $BASE/api/scan/id -H 'Content-Type: application/json' \
  -d '{"connect":true,"keep_connected":true,"mode":"openocd"}'

# 5) 复位 / 断开
curl -s -X POST $BASE/api/control/reset
curl -s -X POST $BASE/api/control/disconnect
```

`POST /api/scan/id` 未连接且 `connect` 未显式设为 false 时，会按当前机型临时拉起
OpenOCD；扫描失败会返回 `{"ok":false,"error":"自动连接失败: ..."}`，不会抛 500。
`GET /api/scan/id` 永远不自动连接，适合只读轮询。

> HID 列表里的 `serial` 是 Windows PNP 实例后缀，通常**不能**直接当 OpenOCD
> `adapter serial` 用；要按调试器连接，请取 `GET /api/scan/debuggers` 返回的
> `supported[].serial` / `supported[].iface`。

### 5.4 更新 AXF / 波形截图（给构建脚本和智能体）

**更新 AXF（不复制文件，直接指向构建输出）**：

```bash
BASE=http://127.0.0.1:8765

# 先看当前机型源文件路径/存在性
curl -s "$BASE/api/catalog/source"

# 指向最新构建的 AXF（可同时给 svd/header/table/map）
curl -s -X POST $BASE/api/catalog/axf \
  -H 'Content-Type: application/json' \
  -d '{"axf":"D:\\Code\\DR1152\\DR1152_Project\\MDK\\Objects\\DR1152.axf"}'

# 也可用 /api/catalog/reload，带路径时等价
curl -s -X POST $BASE/api/catalog/reload \
  -H 'Content-Type: application/json' \
  -d '{"axf":"D:\\Code\\DR1152\\DR1152_Project\\MDK\\Objects\\DR1152.axf"}'
```

- 更新成功后返回 `catalog/counts/profile/profiles/source/exists`，并广播 SSE
  `catalog` 事件，已打开的浏览器页面会自动换用新符号表。
- `axf` 变化会自动按 ELF 段更新 `ram/arch`；`svd` 变化会按 SVD `<name>` 更新型号。
- 传坏路径/坏 AXF 会报错并回滚 `profile.json`，不会把机型改坏。

**波形截图**：

```bash
# 先看可截图范围/通道
curl -s $BASE/api/screenshot/info

# 最近 10 秒（默认全部可用时间窗的 PNG）
curl -s -o shot.png "$BASE/api/screenshot?seconds=10"

# 全部时间、指定通道、深色主题
curl -s -o shot.png "$BASE/api/screenshot?all=1&signals=motor.over.current,adc.RES[0]&theme=dark"

# 指定 t_ms 时间窗（与 /api/history 的 t 一致）
curl -s -o shot.png "$BASE/api/screenshot?start=12000&end=20000&width=1600"

# 智能体取图 + 精确统计（JSON 里是 base64 PNG）
curl -s "$BASE/api/screenshot?format=json&all=1"
```

参数：`all=1` | `seconds=N` | `start=&end=`（`t_ms`），三者优先级
`start/end` > `seconds` > `all` > 默认全部；`signals=a,b` / `sig=a&sig=b` 选通道
（只接受当前采样列）；`width`（默认 1200，480..2400）、`height`（自动）、
`theme=dark|light`（默认 dark，与网页一致）、`title=...`、`max=12`、
`max_points=20000`、`format=png|json`。

PNG 响应头带 `X-MotorScope-Source/Samples/Start-Ms/End-Ms/Signals`；JSON 响应
额外包含每通道 `min/max/avg/count/unit`、`range.start_ms/end_ms/start_wall_ms/
end_wall_ms`、`axes`（`bottom` 绝对时间轴 + `left` 0 起相对时间轴、主/次刻度数）、
`available_signals`、`truncated`、`clamped`。渲染与网页波形区一致：每个通道一个
pane（各自 y 轴 + 主/次横向标尺）、纵向主/次网格、面积渐变 + 描边；底部是原来的
绝对时间轴，左侧新增 0 起的相对时间轴（顶部 0、向下递增）。精确比较请用
`format=json` 的统计。

### 5.5 多输入源（TCL / OpenOCD / 仿真）

`runtime/workspace.json` 保存源列表；每个源绑定自己的机型（AXF/寄存器表）和连接参数。
每个信号有全局 `key = 源ID::局部ID`（如 `mcu1::motor.rpm`、`scope1::CH1`），
同一个页面可以同时显示不同 AXF/寄存器表的信号。

- `GET /api/sources` 看源状态；`POST /api/sources` 新建源；
- `POST /api/sources/<id>/connect` 连接单个源；TCL 源就是 `kind:"attach"`，
  示波器 feed.py 每个端口一个源，可多个并存；
- `POST /api/config` 新格式：

```json
{
  "fusion_rate": 200,
  "sources": [{"id": "mcu1", "rate": 200}, {"id": "scope1", "rate": 15}],
  "signals": [
    {"id": "motor.rpm", "key": "mcu1::motor.rpm", "source": "mcu1", "addr": 536873472, "size": 4},
    {"id": "CH1", "key": "scope1::CH1", "source": "scope1", "addr": 0, "size": 4, "unit": "V"}
  ]
}
```

- 旧格式 `{rate, signals}` 仍可用：没有 `source` 的信号归主源（迁移后通常是 `default`）；
- `/api/history`、`/api/screenshot` 返回融合后的全部列，`signals[]` 带 `source/key`；
- `/api/status` 保留旧单源字段，同时新增 `sources/primary/fusion_rate`；
- 新加源时它的第一帧盖当前全局时间戳，已有源历史不移动。

### 5.6 波形分组（新建 / 命名 / 加入已选择波形 / 颜色）

分组数据保存在当前机型 `profiles/<ID>/config.json` 的 `config.wave.groups`，每个波形行用
`groupId` 归属。`POST` 会**立即写盘**并通过 SSE `type:"wave_groups"` 广播，已打开的页面
会自动重绘分组和颜色，不需要手动“保存配置”。

数据源是该机型已保存的 `config.json`；页面改动约 1.8s 自动保存一次，刚改完立即调 API
可能读到上一版，先点“保存配置”或等自动保存。

只处理 `config.rows` 中已存在的信号：`plot:true` 是波形，`table:true` 是表格行；
显式点名加入的表格行会被提升为 `plot:true`。不在当前 config 里的信号会进入 `skipped`
（不会临时从符号表新建行）。`default` 分组永远存在、不能删除、不能重复命名。

**`GET /api/wave/groups`** — 分组 + 已选择波形：

```json
{
  "ok": true,
  "profile": "LKS32-FOC",
  "saved_at": "2026-11-16 16:00:00",
  "groups": [
    {"id": "default", "name": "默认分组", "visible": true, "auto": true, "count": 3},
    {"id": "wg2", "name": "电流环", "visible": true, "auto": false, "count": 2}
  ],
  "selected": [
    {"id": "motor.over.current", "name": "motor.over.current",
     "plot": true, "table": false, "groupId": "wg2", "color": "#42d7cf"}
  ],
  "count": 5,
  "waveforms": 5,
  "default": "default"
}
```

**`POST /api/wave/groups`**（别名 `/api/wave/groups/create`）— 新建分组，可同时加入波形：

```json
{"name": "电流环", "signals": ["motor.over.current", "adc.RES[0]"]}
```

- `name` 省略时自动用 `分组 N`；重名（不区分大小写）返回 400。
- `signals` 省略/为空只建空分组；支持字符串或对象：

```json
{
  "name": "电流环",
  "signals": [
    "motor.over.current",
    {"id": "adc.RES[0]", "color": "#ff8800"}
  ],
  "colors": {"speed": "00ff00"},
  "recolor": true
}
```

**`POST /api/wave/groups/add`** — 把波形加入已有分组：

```json
{"id": "wg2"}
```

- 只给 `id`：把**所有已选择波形**（`plot:true` 且还没在该组）加进去；没有可加项返回 400。
- 也可显式给 `signals` / `colors` / `recolor`，格式同上；部分信号不在 config 时返回
  `added` + `skipped`，全部失败才返回 400。

**`POST /api/wave/groups/rename`** — 重命名：

```json
{"id": "wg2", "name": "速度环"}
```

**`POST /api/wave/groups/delete`** — 删除分组（组内波形回到 `default`，默认分组不可删）：

```json
{"id": "wg2"}
```

**颜色规则（`add` / `create` 带 `signals` 时）**

1. 每个被加入的波形默认按**变量名 hash** 上色：`sha1(name)` 的字节 b0..b3 →
   `hue=(b0<<8|b1)%360`、`sat=0.62+(b2%11)/100`、`light=0.52+(b3%9)/100`，再 HLS→RGB；
   同一个变量名在任何机器/任何次运行都是同一个 `#rrggbb`；
2. 手动颜色优先：单信号对象 `{"id":"x","color":"#ff8800"}` > `colors` 映射 >
   顶层 `"color"`（本次所有没单独指定颜色的信号）；
3. `recolor:false` 时，没有显式颜色的波形保留原有颜色；默认 `true` 会覆盖为 hash 色；
4. 颜色接受 `#RGB` / `#RRGGBB`（可省略 `#`），非法颜色返回 400。

响应除 `groups/selected` 外还带本次结果：

```json
{"ok": true, "profile": "LKS32-FOC", "saved_at": "...",
 "group": {"id": "wg2", "name": "电流环", "count": 2},
 "added": ["motor.over.current", "adc.RES[0]"],
 "skipped": [],
 "colors": {"motor.over.current": "#42d7cf", "adc.RES[0]": "#ff8800"}}
```

curl 示例：

```bash
BASE=http://127.0.0.1:8765
# 新建空分组（响应里的 group.id 就是下一步的 id）
curl -s -X POST $BASE/api/wave/groups \
  -H 'Content-Type: application/json' -d '{"name":"电流环"}'
# 把当前所有已选择波形加入 wg2（不传 signals = 全部已选择）
curl -s -X POST $BASE/api/wave/groups/add \
  -H 'Content-Type: application/json' -d '{"id":"wg2"}'
# 把指定波形加入 wg2，并手动指定其中一个的颜色
curl -s -X POST $BASE/api/wave/groups/add \
  -H 'Content-Type: application/json' \
  -d '{"id":"wg2","signals":[{"id":"adc.RES[0]","color":"#ff8800"}]}'
# 重命名 / 查看
curl -s -X POST $BASE/api/wave/groups/rename \
  -H 'Content-Type: application/json' -d '{"id":"wg2","name":"速度环"}'
curl -s $BASE/api/wave/groups
```

## 6. Agent 轮询模板

```text
1. GET /api/status        -> 记住 config.signals 和 generation
2. GET /api/history?limit=500
3. cursor = 响应.cursor
4. loop:
     GET /api/history/next?after=cursor&timeout=20
     if timeout: 继续
     if reset: 回到 1
     for [t, vals] in samples:
         value[i] = vals[i] * signals[i].scale + signals[i].offset
         cursor = t
```

只读判断堵转时，在 `signals` 里找：

- `motor.over.current`
- `motor.over.thresholdLast`

然后 `current >= thresholdLast`。注意：**600ms 抖动合并、触发计数、自动暂停是网页前端算的**，服务端不返回这些派生值。

## 7. 从 WSL / 局域网访问

服务默认监听 `0.0.0.0`，局域网固定 80：同网段设备直接访问 `http://<Windows 局域网 IP>:80`。
WSL 里访问 Windows 本机仍走 `cmd.exe /c curl`（WSL 的 127.0.0.1 不是 Windows 的）：

```bash
cmd.exe /c "curl -s http://127.0.0.1:8765/api/status"
cmd.exe /c 'curl -s "http://127.0.0.1:8765/api/history/next?after=1441480.1&timeout=20"'
```

Python：

```python
import json, subprocess
def api(path):
    out = subprocess.check_output(["cmd.exe", "/c", "curl", "-s",
                                   "http://127.0.0.1:8765" + path])
    return json.loads(out)
```

如果 Agent 跑在 Windows 上，直接 `requests`/`fetch` 即可。

## 8. 限制

- 环形缓冲：服务端 `maxlen=40000` 个样本；只存当前 `config.signals`；改配置/重启会丢。
- `/api/history?seconds` 上限 180 秒；新接口 `limit` 上限 40000 点。
- 无鉴权、无 TLS；不要绑 `0.0.0.0` 暴露到网络。
- 时间戳相对服务器启动；需要 wall clock 自己加。
- 采样率受 SWD/Tcl 限制；实际值看 `status.sampler.rate_actual`。
  `status.sampler.busy_ms` 是一轮读内存的平滑耗时，`status.sampler.duty` 是它占目标周期的比例
  （>1 表示读不过来，实际速率由探针决定）；`status.source.plan` 给出当前分块数、字数、
  标定出的 `region_cost_ms` / `word_cost_ms` 与估算 Hz。
