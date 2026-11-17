# MotorScope 多输入源支持计划（计划稿）

> 状态：**P1/P2 MVP 已落地**；P3（每源 worker）/ P4（stream/触发窗口）待做。
> 关联会话：`session-f2f3b673-5278-4f1e-9bb8-11f55d751d7d`（示波器转发 / `ScopeFeed`）。
> 目标：多个调试器 / 外部队列同时采样，各用各的 AXF 或寄存器表，在同一张波形页和
> “已选择”页里显示。

## 实现状态（2026-11-13）

- ✅ `Signal` 增加 `source/key`；`SourceManager` / `AggregateSource`；workspace 迁移
- ✅ `/api/sources` 增删改查/单源连接/断开；`/api/status`、`/api/config`、`/api/history`
  返回 `source/key`；旧单源格式兼容
- ✅ 前端：topbar “新增”替换“清空”、多源 hero 卡片、源 chips、按源 catalog、
  “已选择”/图例/数值表带源标签、每源连接/断开/移除
- ✅ 多个 TCL attach 源（feed.py 多端口）与仿真源可共存；实测两源同页
- ✅ 修复 config 回显循环（`configKeyOf` 与 `monitorKey` 形状不一致会导致无限 POST/SSE）
- ⏳ P3：每源独立 worker、异速率隔离、history 追加列
- ⏳ P4：stream values/frames、触发窗口 FrameBuffer/pane

---

## 0. 结论

**可以做，而且不需要推翻现有架构。**

现在 `Sampler` 只有一个 `source`、一套 `signals`、一个 `profile`/`catalog`，
前端也用一个 `id`（变量名）当全局主键。多源的关键不是“再加一个连接”，而是两件事：

1. **给每个信号一个全局唯一身份**：`source_id + "::" + local_id`；
2. **在采样层加一个聚合层**：一个 `AggregateSource` 对 `Sampler` 暴露成“一个源”，
   内部按 `source` 把读取分派给各自的调试器/外部源。

推荐分两步落地：

- **P1/P2（先可用）**：多个调试器源 + 每源独立 rate 调度 + 前端源筛选/已选择页；
  采样仍是**一个融合循环**（慢源用“保持上次值”）。这能覆盖“两个 MCU / 两个 AXF”的主场景。
- **P3（再稳）**：每源独立读线程 + 融合层；慢源（15 fps 示波器、串口）不会拖慢 200 Hz 的 MCU。
- **P4（接示波器）**：多源模型原生支持 `attach`（TCL），先把多个 `feed.py` 端口
  跑通；同时做 `stream` 增强通道（values / frame / 触发窗口），TCL 与 stream 并存。

**时间戳已确认统一**：所有源共用同一个全局 epoch，每个融合行只有一个 `t_ms`；
新加/重连的设备不重置全局时间轴，只把它的第一个采样点盖成“当前融合时刻”。
详见 3.5。

---

## 1. 现状与硬约束

| 位置 | 现状 | 多源下的问题 |
|---|---|---|
| `scope_server.py::Signal` | `id=name`，没有 source | 两个 AXF 都有 `motor.rpm` 时主键冲突 |
| `scope_server.py::Sampler` | 1 个 `source`、1 个 `rate`、1 份 history | 只能读一个后端；所有列同一节奏 |
| `scope_server.py::App` | 1 个 `profile/catalog/arch/mcu/axf` | 切换机型会断开唯一连接 |
| `App.connect()` | 先 `disconnect()` 再连新源 | 多源不能并存 |
| `App.apply_config()` | 收扁平 `signals`，按 `id` 去重 | 不知道每条信号属于哪个源 |
| `/api/status` | 单 `source/sampler/profile/catalog` | 前端无法列出多源 |
| `/api/history` | `signals[]` 是扁平数组，`samples` 每行一条 | 没有 `source/key` 元数据 |
| `web/app.js::S.index` | 以变量名 `id` 为 key | 跨源同名会覆盖 |
| `S.rows/S.signals` | 以 `id` 为 key；`ci` 是列号 | 行 id 必须是全局 key |
| `monitorConfigPayload()` | 发扁平 `{rate, signals}` | 没有每源 rate、没有 source |
| `web/index.html` 侧栏 | 一套“变量/外设/已选择” | 需要源筛选和已选择跨源 |
| `profiles/` | 一个 active profile | 每个源应绑定自己的 profile |
| `sampler.json` | 存在 `profiles/<id>/sampler.json` | 多个源共用 profile 时会互相覆盖 |

另一个会话已经验证：`attach` TCL 可以被 `feed.py` 冒充，
但现有 `Sampler` 单 `source`，所以多源必须在“采样层”解决，不是起两个服务。

---

## 2. 目标 / 非目标

### 目标

- 同一页面同时显示 2~4 个输入源的不同信号；每个源可以来自**不同 AXF / 寄存器表**。
- 每个源独立连接、断开、出错、重连；一个源挂了不影响其它源显示。
- 每个源可以有自己的采样率（例如 MCU 200 Hz、示波器 15 Hz）。
- “已选择”页跨源汇总；波形分组可以跨源（同 pane 共享轴或各自 pane）。
- 旧 API / 旧配置 / 旧浏览器存档尽量兼容，升级后单源用户行为不变。
- 截图、CSV、录制、分享链接、在线状态都带源信息，不串列。

### 非目标（本期不做）

- 不做多进程/多实例服务；仍然一个 `scope_server.py` 进程。
- 不做跨机器分布式采样。
- 不在服务端直接驱动 VISA/USB-TMC 示波器；示波器协议留在 `ScopeFeed` 侧。
- 不做多用户权限/账号体系。

---

## 3. 核心模型

### 3.1 SourceInstance（输入源实例）

一个源 = 一套“符号表 + 连接 + 采样率 + 已选信号”：

```text
SourceInstance
  id          稳定 slug，如 "mcu1" / "scope1"（工作区内唯一）
  label       显示名，如 "主控 CW32" / "示波器 CH1-4"
  kind        openocd | attach | sim | stream
  profile_id  引用 profiles/<ID>（AXF/寄存器表/芯片/连接默认值）
  catalog     该源的符号目录（从 profile 的 signals.json 加载）
  connection  本源的覆盖参数（serial/target/iface/tcl_port/host/port/...）
  rate        目标采样率 Hz
  color       源标签颜色
  backend     运行中的 Source 实例（可为空）
  signals     本源“选中并参与采样”的 Signal 列表
  started_at_ms 本源第一个样本的全局时间（新加/重连时盖当前融合时刻）
  state       connected / error / last_t / rate_actual / busy_ms / duty
```

要点：

- **一个 profile 可以被多个源复用**（同固件两块板，不同探针 serial）；
- 源实例的 `connection` 覆盖 profile 默认值，不改 `profile.json`；
- 每个源有独立 `catalog`，所以不同 AXF/寄存器表天然隔离。

### 3.2 信号全局身份

新增字段：

```text
Signal.id       local_id，保持原变量名/寄存器名（兼容旧 API）
Signal.source   source_id
Signal.key      source_id + "::" + local_id     ← 全局唯一
```

示例：

```json
{
  "id": "motor.rpm",
  "name": "motor.rpm",
  "source": "mcu1",
  "key": "mcu1::motor.rpm",
  "addr": 536873472,
  "size": 4,
  "scale": 1.0,
  "offset": 0.0,
  "unit": "rpm",
  "color": "#f59e0b",
  "axis": "right"
}
```

规则：

- **服务端/前端内部一律用 `key` 当主键**；`id` 只作为该源内的局部名。
- API 优先接受 `key`；也接受 `{source, id}`；只有 `id` 时按“主源”解析（旧行为）。
- 前端 `row.id = key`，另存 `row.localId = id`、`row.source`、`row.name = name`；
  显示仍用 `name`，所以 UI 文字不变，只是主键变了。
- 分组、写模块、`signal_flags`、在线状态 `visible`、录制勾选、分享快照，
  全部改用 `key`。
- 单源兼容：默认源 id 使用 `"default"`，其 key 为 `default::<id>`；
  前端加载旧存档时统一加前缀（见 6.7）。

### 3.3 Workspace（工作区）

新增 `runtime/workspace.json`（`runtime/` 已 gitignore），保存“多源会话”：

```json
{
  "schema": 2,
  "primary": "mcu1",
  "fusion_rate": 200,
  "sources": [
    {
      "id": "mcu1",
      "label": "主控 CW32",
      "kind": "openocd",
      "profile": "DR2159",
      "rate": 200,
      "color": "#22d3ee",
      "connection": {"arch": "cw32", "target": "", "interface": "", "serial": ""},
      "signals": [{"id": "motor.rpm", "scale": 1, "offset": 0, "unit": "rpm", "color": "#f59e0b"}]
    },
    {
      "id": "scope1",
      "label": "示波器 CH1-4",
      "kind": "stream",
      "profile": "SCOPE-CH4",
      "rate": 15,
      "color": "#a78bfa",
      "connection": {"listen_host": "127.0.0.1", "listen_port": 0, "token": ""},
      "signals": [{"id": "CH1", "scale": 0.001, "offset": 0, "unit": "V"}]
    }
  ]
}
```

- `signals` 按源分块保存；融合后的列顺序 = 源顺序 + 源内顺序。前端可把不同源的
  行放进同一波形分组，但“列顺序”不要求与分组顺序一致。
- 每源信号只存局部 `id` + 显示/换算字段；启动时按该源 `catalog` 重新解析地址，
  这样固件重编译后仍能按变量名找回新地址（沿用 `_signals_from_saved` 的思路）。
- 原子写（tmp + os.replace），损坏时回退到“单源 legacy 模式”，不丢旧数据。

### 3.4 Profile / Catalog

- `profiles/` 仍是“机型工程”（AXF/寄存器表 + 芯片 + 连接默认值），**一个源引用一个 profile**。
- “添加源 → 导入 AXF/寄存器表”复用现有 `import_catalog()`：它本来就会新建/更新 profile。
- 每个源的 `catalog` 独立加载，互不覆盖；`/api/catalog?source=...` 只影响该源。
- 源的 `arch/mcu/chip` 从 profile + 连接探测得到，按源保存；顶栏/状态栏的旧字段
  指向 `primary` 源。

### 3.5 统一时间戳（所有源共用一条时间轴）

**结论：所有源共用同一个全局 epoch，每行融合帧只有一个 `t_ms`。**
新加/重连设备**不重建全局时间轴**，只把新设备的第一个采样点对齐到“当前融合时刻”。

规则：

1. 全局 `epoch` 只在服务启动 / 用户“清空并重置时间轴”时创建一次，所有源共用。
2. 新加/重连一个源时：
   - 不为它单独建 epoch；
   - 它的第一个采样点的 `t_ms = (monotonic_now - epoch) * 1000`，即当前融合时刻；
   - 该值同时记到 `sources[].started_at_ms`，供 UI/诊断显示“从何时开始有数据”；
   - 其它源已记录的历史不移动、不重算；
   - 该源加入之前的时间段没有数据（UI 显示为 gap / 未连接）。
3. 每个融合 tick 只有一条 history row，所有列共享同一个 `t_ms`。
   各源实际读取完成时间可能差 1 个 tick；需要诊断时看 `sources[].last_t/age`，
   不改变行时间戳。
4. 慢源（如 15 Hz）在快源 tick 之间保持上次值（sample-and-hold），
   所以行时间戳仍是融合 tick，值来自它最近一次采样；这是“几乎同步”的代价。
5. 多路 MCU 若在同一个 OpenOCD 批次里读，本来就是同一次读取；
   多个探针/多进程读取时物理上无法完全同时，融合 tick 是显示对齐点。
6. 外部流源（示波器）在 `hello` 里带自己的 `t_ms`，MotorScope 算一次
   `offset = global_now - producer_t`，之后把 `values.t_ms` / `frame.t0_ms`
   映射到同一条全局时间轴；重连时重算 offset。没有时间戳的消息按到达时刻盖戳。
7. 需要记录“源本地时间”的场合（触发窗口、帧时间基），在 frame/trigger 元数据里
   保留 `source_t0_ms`，但融合 history 的 `t_ms` 不变。

示意：

```text
global epoch E
  ├─ mcu1  first sample at t=1200.0ms
  ├─ mcu2  added at t=5300.0ms → first sample t=5300.0ms (之前为空)
  ├─ scope1 hello at t=5400.0ms → offset 映射，之后 values t=...
  └─ fusion rows: t=1200.0, 1205.0, ... 所有列共用
```

> **不要**“每加一个设备就重置全局 epoch”：那会把其它源已有 history 整体平移，
> 游标/截图/录制全部失效。正确做法是保持全局 epoch，只给新源盖当前时间戳；
> 这样新源的起点与现有源“几乎同步”，已有数据不动。

采样调度：

- **P1 单循环模式**：融合 tick = `max(各源 rate)`（上限 300 Hz）。每个 tick 检查各源
  `next_due`，到点才真正读；未到点复用上次值。
- **P3 每源 worker 模式**：每源独立线程按自己的 rate 读，写 `latest`；
  融合 tick 只做快照，不阻塞。慢源/偶发卡顿不会拖慢其它源；时间戳规则不变。
- 每个源记录 `last_t`、`rate_actual`、`busy_ms`、`duty`、`error`；`/api/status`
  里按源返回，前端顶部只显示聚合速率，源卡片显示各自速率。
- 每源 rate 独立；`fusion_rate` 默认取 `max(active rates)`，也允许用户固定显示帧率。
- RISC-V 的 50 Hz 上限按源生效（不再全局限速）。

### 3.6 示波器：TCL（attach）原生支持 + stream 增强

**结论：示波器可以作为 TCL（attach）源接入，这是必做项，不是过渡方案。**
多源模型原本就有 `kind:"attach"`；多源只是让多个 attach 端口同时存在。
`stream` 是增强通道，用于动态通道、高频帧和触发窗口，**不替代 TCL**。

| 能力 | TCL attach | stream |
|---|---|---|
| 值 / 抽稀波形 | ✅ 现成 `feed.py` 可直接用 | ✅ |
| 动态通道（无需 AXF） | 需预置 profile/自定义信号 | ✅ `hello.channels[]` |
| 2048 点整帧 / 触发窗口 | ❌ 不适合塞进 `ms_read` | ✅ |
| 实现成本 | 低（已有） | 中 |

#### 3.6.1 TCL 路径（必做）

- 新建 `kind:"attach"` 源，`connection:{"host":"127.0.0.1","port":6666}`；
- 每个源独立 `TclClient` / 端口 / 连接状态；`feed.py` 每个实例一个端口；
- 4 通道映射：`feed.py` 用 4 个地址段（或 4 个基址）暴露 CH1~CH4；
  MotorScope 侧建一个 `SCOPE-CH4` profile（`signals.json` 4 条自定义地址），
  地址与 `feed.py` 对齐；`scale` 用“伏/码”，`unit="V"`；
- TCL 只回 32bit 字，适合“值/抽稀波形”；触发帧不走 TCL，走 3.6.3；
- 时间戳：attach 源和其它源共用全局 epoch；新加/重连时首样本盖当前融合时刻；
- 验收：两个 `feed.py` 端口 + 一个 sim 源同页；断开一个不影响其它。

#### 3.6.2 Stream 路径（增强，P4）

- `kind:"stream"` 的 `SourceInstance`，MotorScope 监听一个本地 TCP 端口
  （默认 `127.0.0.1`，端口 `0` = 自动分配），外部采集进程连上来推流。
- 流断开后源保持“等待中”，不删源、不清其它源；重连重新 `hello` + 时钟校准。
- 消息用 **NDJSON**（一行一个 JSON），先保证可调试；帧数据量大时可加
  `encoding:"int16-base64"` 或后续二进制帧，不改变外层语义。
- `hello` 必须带 `source`、`t_ms`、`channels[]`；`values` / `frame` / `trigger` 可选。

协议（初版）：

```json
{"type":"hello","v":1,"source":"scope1","label":"DS1054Z","t_ms":123456.7,
 "rate":15,
 "channels":[
   {"id":"CH1","name":"CH1","unit":"V","scale":0.001,"offset":0},
   {"id":"CH2","name":"CH2","unit":"V","scale":0.001,"offset":0}
 ],
 "capabilities":{"values":true,"frames":true,"trigger":true}}

{"type":"values","seq":42,"t_ms":123500.0,"values":{"CH1":1.23,"CH2":-0.5}}

{"type":"frame","seq":7,"t0_ms":123480.0,"dt_ms":0.001,
 "channels":{"CH1":[...],"CH2":[...]},
 "trigger":{"seq":3,"t_ms":123500.0,"channel":"CH1","level":1.5,
            "edge":"rising","pre_ms":0.5,"post_ms":0.5}}

{"type":"ack","t_ms":123456.7}
{"type":"trigger","action":"arm","mode":"normal","channel":"CH1",
 "level":1.5,"edge":"rising","pre_ms":0.5,"post_ms":0.5}
```

- `channels[]` 是动态符号表：源一连上，UI 就能看到 CH1/CH2，不需要 AXF。
- `values` 进入融合时间轴（采样保持）；`frame` 进入帧缓冲，不进融合 history。
- `trigger` 可由 MotorScope 下发（arm/stop/set），也可只由示波器上报；
  能力不支持时返回 `supported:false`。

#### 3.6.3 触发窗口（预留接口）

数据模型：

```text
TriggerWindow {
  source, seq, t_ms, channel, level, edge, pre_ms, post_ms,
  t0_ms, dt_ms, channels{...}, decimated{...}
}
```

- 每源 `FrameBuffer` 保留最近 N 个触发窗口（默认 8 个）+ 最新一帧。
- 接口（P4 先实现返回结构，采集侧可以暂时只上报一个 trigger 帧）：

| 方法/路径 | 说明 |
|---|---|
| `GET /api/sources/<id>/frames?kind=trigger&limit=8` | 最近触发窗口（按像素抽稀） |
| `GET /api/sources/<id>/frames/latest?kind=trigger` | 最新触发窗口 |
| `POST /api/sources/<id>/trigger` | `{action:"arm"|"stop"|"set", mode, channel, level, edge, pre_ms, post_ms, holdoff_ms}`；能力不支持时 `supported:false` |
| `POST /api/sources/<id>/frames` | 非 stream 源（如 feed.py）用 HTTP 上报触发帧，复用同一缓冲 |
| SSE `source-frame` | `{source, kind:"trigger", seq, t_ms}`，前端据此刷新 |

- 前端：源卡片里加“触发窗口”折叠区/pane，显示最近窗口、pre/post 标记、
  可切换窗口；不占用融合波形列。
- `trigger` 字段在 `hello`/`frame` 里先留好，P4 初版即使不实现触发采集，
  API/字段也已存在，后续只补采集侧。

#### 3.6.4 落地顺序

1. P1/P2：先做 **多 attach 源**（多个 `feed.py`），示波器通过 TCL 接入；
2. P4：`stream` 路径落地（values/frames/trigger）；`feed.py` 可逐步从 TCL
   升级为 stream producer，TCL 保留作为兼容/低带宽路径；
3. 触发帧：优先 `stream.frame`，非 stream 源可用 `POST /api/sources/<id>/frames`。

---

## 4. 后端改造

### 4.1 新增模块

建议新建 `sources.py`（避免 `scope_server.py` 继续膨胀），放：

- `SourceInstance`
- `SourceManager`
- `AggregateSource(Source)`
- `SourceWorker`（P3，可选）
- `load/save_workspace()`、`migrate_workspace()`

`scope_server.py` 只做 App 接线和 HTTP 适配。

### 4.2 SourceManager

职责：

```text
create(payload)                 新建源（id/label/kind/profile/rate/connection）
update(id, payload)             改标签/连接/rate
remove(id)                      断开 + 移除源 + 重算列
list()/get(id)
connect(id, payload)            单源连接（复用 App.connect 里的 openocd/attach/sim 逻辑）
disconnect(id)
connect_all()/disconnect_all()
switch_profile(id, pid)         单源换 profile
import_catalog(id, ...)         单源导入 AXF/寄存器表
apply_config(payload)           每源 signals/rate；重建融合列
merged_signals()                按列顺序返回所有源的 Signal
status()                        每源 + 聚合状态
find_signal(key_or_id, source)  按 key 优先、旧 id 兜底
```

每个 `SourceInstance` 有自己的 `RLock`，避免采样读和 UI 写并发打架。

### 4.3 AggregateSource

实现现有 `Source` 接口，让 `Sampler` 不用变成“多源感知”：

```python
class AggregateSource(Source):
    def __init__(manager): ...
    def read(self, signals):      # Sampler 每 tick 调一次
        # 1) 按 signal.source 分组
        # 2) 对到期的源调用 backend.read(子集)
        # 3) 未到期的源用 last_values 填充
        # 4) 按传入 signals 的顺序返回 values
    def read_word(self, source_id, addr): ...
    def write(self, source_id, addr, size, value): ...
    def close(self): ...           # 关闭所有 backend
    def info(self): ...            # {kind:"multi", sources:[...]}
```

调度状态：

```text
next_due[source] = now
last_values[source] = [...]
last_t[source]、rate_actual、busy_ms、duty、error
```

这样 `Sampler` 的“一个 source”约束仍然成立（符合另一个会话的判断），
但内部可以挂 N 个后端。

### 4.4 Sampler 改造

- `set_signals(signals, fusion_rate)`：
  - 计算新 `key` 列表；
  - **追加型变更**（旧 key 是新 key 的前缀）不清 history：旧行保持，新列在读取时
    补 `None`/`null`；
  - 删除或重排：按 key 重映射 history；映射不了再清空（失败安全）。
  - Recorder/RecordCache：列变了就重开一段（CSV/缓存不跨列会话），避免旧行列数不一致。
- `run()`：
  - P1 仍按 `fusion_rate` 节拍；`source.read()` 内部做每源 due 调度；
  - `status()` 增加 `sources`（每源 last_t/rate_actual/duty/error）与 `fusion_rate`。
- `history_*` 返回的 `signals` 带 `id/local_id/key/source/source_label`。
- `generation`：源集合或列集合变化时递增；单纯改 rate 不递增（避免游标 reset）。

### 4.5 App 兼容层

`App` 里仍保留旧属性/方法给旧 API 和内部调用，但改成**指向 primary 源**：

```text
App.source        -> primary backend（旧 /api/status.source、log_tail 等）
App.profile       -> primary profile
App.catalog       -> primary catalog
App.arch/mcu/axf  -> primary 的诊断字段
App.sampler.source-> AggregateSource（采样走聚合层）
```

新增：

```text
App.sources       -> SourceManager
App.primary_id    -> workspace.primary
```

`connect()/disconnect()/switch_profile()/apply_config()/read_value()/write_value()/
status_payload()/config_payload()/screenshot_*()` 都加可选 `source` 参数；
不带参数时走 primary，保持旧行为。

### 4.6 导入 / 机型

- `POST /api/catalog/import`、`/api/catalog/axf`、`/api/catalog/reload` 加 `source` 字段；
  不带则更新 primary。
- `POST /api/profiles/switch` 加 `source`；不带则 primary。
- 单源 `profile` 切换逻辑保持：断开该源、换 catalog、恢复该源采样集。
- 多源时不再有“全局切换机型会断开所有源”的行为；只影响当前源。

### 4.7 持久化与迁移

启动顺序：

1. 读 `runtime/workspace.json`；
2. 不存在/损坏 → legacy 迁移：
   - `profiles.get_active()` 的 profile 作为源 `default`（label=profile name）；
   - `profiles/<id>/sampler.json` 的信号作为该源 `signals`；
   - `profiles/<id>/config.json` 的 `rows` 作为兜底；
   - `fusion_rate = sampler.rate`；
   - 写一份 workspace（原子写）。
3. 每个源加载自己的 catalog；失败只标记该源 `error`，不影响其它源。
4. `restore_sampler()` 改为按 workspace 恢复所有源，再 `apply_config` 重建融合列。

兼容写：

- primary 源的采样集继续写 `profiles/<primary>/sampler.json`（旧版本可读）；
- `profiles/index.json.active` 始终同步 primary 的 profile；
- `profiles/<id>/config.json` 仍可保存单 profile 的前端快照；多源 UI 状态以
  workspace + 浏览器本地 config 为准，避免两个源共用 profile 时互相覆盖。

### 4.8 错误与重连

- 每个源独立 `error/last_connect_error`；状态栏只汇总“N/M 源在线”。
- 一个源断开不触发全局 `disconnect()`；其它源的 history/SSE 继续。
- 连接失败只影响该源；`/api/status.sources[]` 里带错误。
- 采样错误：该源 `last_values` 保持最后一次值，状态标 `stale`；不要用 `None`
  把整列清空（除非用户断开）。

---

## 5. API 设计

### 5.1 新接口

| 方法 / 路径 | 说明 |
|---|---|
| `GET /api/sources` | 源列表 + 每源状态/profile/rate/连接/错误 + `primary` |
| `POST /api/sources` | 新建源：`{id,label,kind,profile,rate,connection}` |
| `POST /api/sources/<id>` | 更新 label/profile/rate/connection |
| `DELETE /api/sources/<id>` | 删除源（自动断开、从列里移除） |
| `POST /api/sources/<id>/connect` | 连接该源，body 同旧 `/api/connect` |
| `POST /api/sources/<id>/disconnect` | 断开该源 |
| `GET /api/sources/<id>/catalog` | 该源符号目录（也可 `/api/catalog?source=`） |
| `POST /api/sources/<id>/config` | `{rate, signals:[...]}` 该源采样集 |
| `POST /api/sources/<id>/profile` | `{profile:"DR1152"}` 单源换机型 |
| `GET /api/sources/<id>/frames` | P4：`?kind=trigger&limit=8` 最近触发窗口/帧（抽稀） |
| `GET /api/sources/<id>/frames/latest` | P4：最新触发窗口/帧 |
| `POST /api/sources/<id>/trigger` | P4：`arm/stop/set` 触发配置；能力不支持时 `supported:false` |

### 5.2 旧接口兼容

| 旧接口 | 多源行为 |
|---|---|
| `GET /api/status` | 保留 `source/sampler/profile/catalog/config`（=primary），新增 `sources`、`fusion_rate` |
| `GET /api/config` | 返回 primary 的扁平 signals + 全量 `sources` |
| `POST /api/config` | 无 `sources` 字段：按旧格式应用到 primary；有 `sources`：按源应用 |
| `GET /api/history` | 返回融合后的全部列；`signals[]` 每条带 `source/key/source_label` |
| `POST /api/connect` | 无 `source`：连 primary；有 `source`：连指定源 |
| `POST /api/disconnect` | 无 `source`：断 primary；`{all:true}` 断全部 |
| `POST /api/profiles/switch` | 无 `source`：primary |
| `/api/catalog/import` | 无 `source`：primary |
| `/api/signal-flags` | key 为全局 key；旧 `id` 在唯一时兜底 |
| `/api/read` `/api/write` | 加 `source`/`key`；旧 `addr` 走 primary |
| `/api/screenshot` | 默认全部源；`?sources=mcu1,scope1` 过滤 |
| `/api/share` | 快照加 `sources`/keys；旧分享按 default 源应用 |
| `/api/view` | `visible` 用 key；旧 id 兜底 |

### 5.3 配置 payload

推荐新格式：

```json
{
  "fusion_rate": 200,
  "sources": [
    {"id": "mcu1", "rate": 200},
    {"id": "scope1", "rate": 15}
  ],
  "signals": [
    {"id": "motor.rpm", "key": "mcu1::motor.rpm", "source": "mcu1", "addr": 536873472,
     "size": 4, "scale": 1, "offset": 0, "unit": "rpm", "color": "#f59e0b",
     "step": false, "role": "signal"},
    {"id": "CH1", "key": "scope1::CH1", "source": "scope1", "addr": 536870912,
     "size": 4, "scale": 0.001, "offset": 0, "unit": "V", "color": "#a78bfa",
     "step": false, "role": "signal"}
  ]
}
```

服务端：

- 按 `source` 分组，校验 source 存在、key 匹配；
- 每源保存 `signals`，重建融合列；
- 无 `source` 的信号归 primary；
- `rate` 缺失时沿用该源上次 rate。

---

## 6. 前端改造

### 6.1 状态

```js
S.sources = [];                 // 来自 /api/status.sources
S.sourceById = new Map();
S.activeSource = 'mcu1';        // 侧栏当前浏览的源
S.catalogs = new Map();         // sourceId -> catalog
S.index = new Map();            // key -> entry（所有源）
```

- `S.catalog` 保留为 active source 的 catalog，减少现有代码改动；
- `S.index` 改为全源合并；entry 带 `source/localId/key`；
- `buildIndex()` 遍历所有 `S.catalogs`，key 用 `source::localId`。

### 6.2 源筛选与侧栏

在现有 tabs 上方加一排源 chips：

```text
[全部] [主控 CW32 ●] [示波器 ●] [+ 添加源]
```

- `变量 / 外设 / 自定义`：按 `S.activeSource` 过滤；“全部”时按源分组显示。
- “已选择”（`data-tab="waves"`）：**跨源显示**，每行前面加源标签/颜色点；
  搜索支持 `源名` 和变量名。
- 波形分组不限制源：同一组可以放不同源的行；`auto` 组仍是每行一个 pane，
  pane 标题加 `[源名]`。
- 图例/数值表/游标 tip：多源时在名字前加短源标签（`MCU1 · rpm`）。

### 6.3 行模型与 key

- `normalizeSignal()` 增加 `source/localId`，并约定 `id = key`；
- `addRow(entry)` 的 `entry.id` 来自 `S.index`（已是 key）；
- `addCustomSignal(addr, ...)` 使用 active source，key = `${source}::custom.<addr>.<size>`；
- `rowById/removeSignal/setRowFlag` 等继续用 `row.id`（=key），不用大改；
- `selectedRows()`、`plotRows()`、`tableRows()` 逻辑不变；
- 写模块 `rowId` 用 key；`write` API 带 `source`。

### 6.4 多源 hero 卡片（主区顶部）

现在 `#hero` 是四个全局卡片（信号源 / 机型 / 采样 / 分析）。多源**不建议复制多个
`<section id="hero">`** —— HTML `id` 必须唯一；应改成“`#hero` 容器 + 每源一个
`section.source-hero`”，用 `data-source` 区分：

```html
<section id="hero">
  <section class="source-hero" data-source="mcu1"> ... </section>
  <section class="source-hero" data-source="mcu2"> ... </section>
  <section class="source-hero add-source" data-action="add-source"> + 添加输入源 </section>
</section>
```

每个 `source-hero` 放该源的“快配置”：

```text
[● 主控 CW32 | OpenOCD | 已连接]   [机型 DR2159 / AXF]   [200 Hz / 实际 198]   [连接|编辑|×]
[● 示波器    | TCL     | 等待]     [SCOPE-CH4 / 4ch]     [15 Hz / 实际 --]     [连接|编辑|×]
```

规则：

- 每个源一个 `section.source-hero`，`data-source` 区分；**不要重复 `id="hero"`**；
- 现有 4 张卡片按职责拆开：源状态 / profile+AXF / rate+录制 / 全局分析；
  “分析”是全局能力，保留一张，不按源复制；
- `#hero` 仍是容器，`body.hero-hidden #hero` 的全屏折叠逻辑不变；
- 2~4 个源时一行一个；更多时折叠成源 chips + 展开，避免挤掉波形高度；
- 点击某个 `source-hero` = 切换 active source；连接/编辑/删除按 `data-source` 路由；
- `renderSourceHeros()` 由 `S.sources` 驱动；`renderCards()` 保留全局统计；
- “添加输入源” = 最后一个 `+` 卡片，打开 6.5 的源编辑器；
- 兼容：旧的 `#cardSource/#cardProject/#cardSample/#cardAnalysis` 先保留为
  primary/global 卡片，或改成 `data-role` 动态绑定；逐步替换，不做一次性删除。

### 6.5 添加/管理源

“信号源”面板改成源列表 + 编辑区：

```text
┌ 信号源 ─────────────────────────────┐
│ ● 主控 CW32   OpenOCD  200Hz  [连接]│
│ ● 示波器      TCL 15Hz  [断开] [×] │
│ [+ 添加信号源]                       │
├ 当前源：主控 CW32 ─────────────────┤
│ 标签 / 机型 / AXF / 架构 / 调试器…  │
│ rate / target / iface / serial      │
│ 芯片识别 / 日志                      │
└─────────────────────────────────────┘
```

添加源流程：

1. 标签 + 类型（OpenOCD / 附加 TCL / 仿真 / 外部流）；
2. 选择现有 profile，或“导入 AXF/寄存器表”新建 profile（复用现有导入面板）；
3. 连接参数（探针 serial、target/iface、attach host/port、stream port）；
4. rate；
5. 创建后加载该源 catalog，侧栏切到该源，用户勾选信号。

顶栏“连接/断开”作用于 active source；源卡片各自有连接按钮。
“全部断开”放源面板菜单，避免误操作。

### 6.6 配置下发

`monitorConfigPayload()` 改为：

```js
{
  fusion_rate: S.fusionRate,
  sources: S.sources.map(s => ({id:s.id, rate:s.rate})),
  signals: S.signals.map(s => ({
    id: s.localId || s.id, key: s.id, source: s.source,
    name: s.name, addr: s.addr, size: s.size, signed: s.signed,
    bit: s.bit, float: !!s.float, scale: s.scale, offset: s.offset,
    unit: s.unit, color: s.color, step: s.step,
    role: s.configRole || (s.support ? 'support' : (s.writeOnly ? 'write' : 'signal')),
  })),
}
```

- `configKeyOf` 计入 `source/key`/每源 rate；
- `sendConfig` 的防抖/去重键同步；
- `adoptSharedConfig` 支持新格式，旧格式按 primary 处理；
- 服务端 `config` 事件带 `sources`，前端按源更新。

### 6.7 状态/SSE

- `applyStatus(st)`：
  - `S.sources = st.sources`，更新源卡片、源 chips；
  - 兼容：`st.source` 作为 primary 的旧字段；
  - 顶部连接 pill 显示 primary 或“N/M 源在线”；
  - 采样统计仍用 `st.sampler`（融合流），源卡片显示各自 `rate_actual`。
- `hello/config` 事件带 `sources`；
- `s` 事件仍是扁平 row，列顺序与 `/api/history.signals` 一致；
- 新增 `source` 状态变化可只靠 `status` 轮询/SSE 广播，不必单独事件。

### 6.8 本地存档迁移

浏览器 localStorage 的 config 增加 `workspaceVersion: 2`：

- v1 → v2：
  - 默认源 = 服务端 primary（迁移后为 `default`）；
  - `rows[].id` 加 `source::` 前缀，另存 `localId`；
  - `virtuals[].sourceIds`、`write.mods[].rowId`、`wave.groups[].rows`、
    `recordSel`、`signal_flags`、`visible` 全部加前缀；
  - 无法映射的行丢弃并提示，不阻塞启动。
- 服务端 workspace 优先于本地行；本地只保留分组/显示/颜色等 UI 状态。
- 分享快照：
  - 新快照写 `sources` + keys；
  - 旧快照无 `source` → 按 default 应用；
  - 应用分享前确认目标 workspace 存在对应源，不存在则自动创建/提示。

### 6.9 图表/截图

- 图表本身已经按 `S.signals` 画；多源只是列更多、名字带源标签。
- pane 标题：`[MCU1] motor.iq [A]`（源标签用源 color 的小色块）。
- `auto` 分组下每源信号各自 pane；共享组允许跨源，但单位不一致时给出提示。
- 截图 API：
  - 默认所有源；`?sources=` 过滤；
  - PNG 顶部 `profile/mcu` 改为 `sources: 主控 CW32 (6 ch) | 示波器 (4 ch)`；
  - 每个 pane 标题带源短标签；
  - `format=json` 的 `signals[]` 带 `source/key/source_label`。

---

## 7. 录制 / CSV / 分享 / 在线状态

- `Recorder`/`RecordCache` 仍记录融合流：列 = 全局 key 顺序；
  CSV 表头用 `源.局部名`（如 `mcu1.motor.rpm`、`scope1.CH1`），
  保证跨源同名不冲突。
- 源集合/列集合变化时，录制/缓存开新段（旧数据留给导出/回放处理），
  避免 CSV 行长度不一致。
- `record.csv?ids=` 接受 key 或唯一局部 id。
- 分享快照、`/api/view.visible`、`signal_flags` 全部 key 化；旧值在唯一时兜底。
- presence 的“其他端正在看”按 key 匹配。

---

## 8. 给示波器会话的接口建议

**已确认：示波器可以作为 TCL（attach）连接，TCL 必须支持；stream 是增强通道，**
用于动态通道/整帧/触发窗口，两者并存。详见 3.6。

### 8.1 TCL 路径（必做，先跑通）

- 示波器作为 `kind:"attach"` 源：`host:127.0.0.1` + 端口；
- `feed.py` 每个实例一个端口，多源支持后可以同时开多个；
- 4 通道用 4 个地址段/基址暴露，配一个 `SCOPE-CH4` profile（`signals.json`）；
- TCL 只传值/抽稀波形；触发帧不走 TCL，走 8.2/8.3；
- 时间戳与其它源共用全局 epoch，新加/重连首样本盖当前融合时刻。

### 8.2 Stream 路径（增强）

- `feed.py` 升级为 stream producer：`hello` / `values` / `frame` / `trigger`；
- `values` 15 Hz 进融合时间轴；`frame` 进 FrameBuffer；
- 动态通道 CH1~CH4 不需要 AXF；
- 时钟 offset：`hello.t_ms` 对齐全局 epoch；
- 触发窗口走 `frame.trigger` + `/api/sources/<id>/frames` + `POST /trigger`；
- 安全：默认只监听 `127.0.0.1`，LAN 需 token。

### 8.3 两个会话的边界

- MotorScope 负责：源注册、时钟 offset、融合时间轴、帧缓冲、API、前端 pane；
- ScopeFeed 负责：VISA 采集、帧解析、触发判定、`values`/`frame` 上报、可选的 trigger 命令执行。

---

## 9. 分阶段实施

### P0 方案确认（0.5 天）

- 确认第 11 节的决策点；
- 确定 key 规则、workspace 位置、P1 是否单循环；
- 写兼容性用例（旧 `/api/config`、旧存档、旧分享）。

**验收**：本文定稿，无代码改动。

### P1 后端多源底座（2~3 天）

- 新增 `sources.py`：`SourceInstance/SourceManager/AggregateSource`；
- `Signal` 加 `source/key`，`to_dict` 输出；
- `Sampler` 接 `AggregateSource`，每源 due 调度、per-source stats、追加型 history；
- App 兼容层：primary 属性、`/api/sources` CRUD/connect、`/api/config` 新格式；
- workspace 读写 + legacy 迁移；
- `/api/status` / `/api/history` / `/api/screenshot` 带源信息；
- 单源旧测试全绿；新增两源模拟测试。

**验收**：

- 同时创建 2 个 sim 源（不同 profile/catalog）；
- `/api/sources` 有 2 项，`/api/history.signals` 有 `source/key`；
- `/api/screenshot` 同时画出两源；
- 旧 `/api/config`/旧 `sampler.json` 仍能工作。

### P2 前端多源 UI（3~4 天）

- `S.sources/catalogs`、`S.index` key 化；
- 侧栏源 chips、已选择跨源、源标签；
- 主区 `#hero` 改成容器 + 每源 `source-hero` 快配置卡（6.4）；
- 源面板：列表/添加/连接/断开/删除/编辑；
- 每源配置下发、状态展示；
- 本地存档/分享迁移；
- 图表/图例/表格/写模块带源标签。

**验收**：

- 两个 sim 源各 2~3 路，同页显示、分别连接/断开；
- 主区每个源有独立 `source-hero` 快配置卡，可切换/连接/编辑；
- 已选择页跨源；刷新后恢复；
- 旧单源存档自动迁移，旧分享可用；
- 页面无同名冲突（故意让两个源都有 `motor.rpm`）。

### P3 异速率与稳定性（2 天）

- 每源 `SourceWorker`，融合层只读 latest；
- 慢源不拖垮快源（15 Hz + 200 Hz 压测）；
- history 列重映射/追加；每源 rate/duty/age 展示；
- 源错误隔离/重连。

**验收**：

- 200 Hz 源在 15 Hz 源卡住 2 s 时仍保持 ≥95% 速率；
- 融合流无整屏清空（添加源时保留旧行）；
- 每源状态可观测。

### P4 示波器 TCL 多实例 + stream 增强 + 触发窗口（3~5 天）

- 先验证多个 `attach` 源（多个 `feed.py` 端口）同页显示；
- `StreamSource` + TCP listener + NDJSON parser + hello/ack/heartbeat/reconnect；
- `hello.channels[]` 动态 catalog；`values` → latest → 融合流；
- 时钟 offset：`values.t_ms` / `frame.t0_ms` 映射到全局 epoch；
- `FrameBuffer` + `/api/sources/<id>/frames` + SSE `source-frame`；
- 触发窗口 API（`/trigger`）与前端 pane（先返回结构，采集侧可后补）；
- `feed.py` 可选升级为 stream producer；TCL 保留兼容。

**验收**：

- 示波器 TCL 源与 MCU 源同页显示，时间轴对齐；
- 示波器 stream `values` 15 Hz 与 MCU 200 Hz 同页，时间轴对齐；
- 新加/重连示波器不重置全局 epoch，MCU 已有 history 不动；
- 触发窗口接口返回最近窗口，前端能显示 pre/post 标记；
- 不阻塞 MCU 源；断流/重连不影响其它源。

### P5 收尾（1~2 天）

- CSV/录制/分享/在线状态 key 化；
- API.md/README/profiles README；
- 性能（4 源 × 8 路 @200 Hz）；
- 异常/回滚：workspace 损坏回退单源。

---

## 10. 测试计划

### 后端单测（新增 `tests/test_sources.py` 等）

- `SourceManager` CRUD、id 唯一、profile 绑定；
- `AggregateSource` 按 `source` 路由；未到期源保持上次值；
- 两源不同 rate；一个源抛错不影响另一个；
- `apply_config` 旧格式 → primary；新格式 → 按源；key 校验；
- `Signal` key/source 序列化；旧配置迁移；
- workspace 读写/损坏回退；
- history 追加列、删除列重映射；
- status/screenshot 多源元数据；
- CSV 表头跨源唯一。

### 前端/集成

- 两个 sim 源（不同 profile）同页显示；
- 同名信号（两源都有 `motor.rpm`）不冲突；
- 已选择/图例/表格/写模块源标签；
- 添加/删除源、刷新恢复、旧存档迁移；
- 旧分享链接/旧 API 单源回归；
- 截图 PNG 中双源 pane 标题；
- 性能：浏览器 4 源 × 8 路，200 Hz 融合。

### 兼容回归

- 现有 125 项 Python 测试全绿；
- 旧 `/api/history` 消费方（agent 模板）不改也能读；
- 旧 `sampler.json`/`config.json` 不丢；
- `signal_flags` 旧 id 在唯一时仍可用。

---

## 11. 风险与待确认

| # | 决策点 | 结论/推荐 |
|---|---|---|
| 1 | 时间戳：是否所有源共用？ | **已确认：共用全局 epoch**；新源首样本盖当前融合时刻，不重置全局时间轴 |
| 2 | 示波器：attach 还是流式？ | **已确认：TCL（attach）必须支持**；stream 作为增强通道并存，触发窗口预留 |
| 3 | 采样：单融合循环（简单）还是每源 worker（稳）？ | P1 单循环，P3 上 worker；若 P4 先接示波器，建议提前 P3 |
| 4 | key 规则：`source::local` 全局主键 | 是；旧 id 唯一时兜底 |
| 5 | workspace 位置/格式 | `runtime/workspace.json`，schema 2 |
| 6 | 每源 rate 是否一期就要 | 是（至少存储/显示；P1 调度，P3 隔离） |
| 7 | 一个源能否多 profile / 多源共用 profile | 一个源一个 profile；profile 可被多源复用 |

其它风险：

- **同名信号**：必须全局 key，否则前端 `S.rows` 直接覆盖；
- **旧 API 消费方**：`id` 语义保持局部，新增 `key/source`；文档要明确；
- **profile 共享**：两个源共用 profile 时，`sampler.json` 只能保留 primary，
  每源采样集以 workspace 为准；
- **前端改动面大**：`S.index/rows/groups/flags/write/presence/share` 都要 key 化，
  需要分步提交、旧存档迁移测试；
- **OpenOCD 多实例**：每个 openocd 源一个进程/端口；USB serial 必须能区分，
  否则两个源会抢同一个探针；需要在前端明确选择；
- **慢源**：P1 单循环会被阻塞；若第一期就接 15 fps 示波器，建议直接上 P3 worker；
- **示波器帧**：不能按 30k 行/秒塞进现有 history；必须单独 FrameBuffer/pane；
- **并发编辑**：当前 `web/app.js` 有另一个会话在改，落地时要先合并/冻结该文件。

---

## 12. 建议的提交拆分

1. `feat(sources): Signal key + workspace schema + SourceManager`
2. `feat(sampler): AggregateSource + per-source scheduling`
3. `feat(api): /api/sources + legacy mapping + status/history metadata`
4. `feat(web): source chips/cards + key migration`
5. `feat(web): selected page cross-source + legend/table labels`
6. `feat(web): per-source config/connect + persistence`
7. `feat(shot): multi-source screenshot header/panes`
8. `feat(stream): TCP NDJSON stream source + clock offset`（P4）
9. `feat(stream): trigger window buffer/API/pane`（P4，先留接口）
10. `test/docs: multi-source regression + API docs`

---

## 13. 一句话总结

多源不是“再开一个连接”，而是**把信号主键从变量名升级为 `source::signal`，
在 Sampler 前加一个 AggregateSource，并让所有源共用同一个全局 epoch**；
新设备接入只盖当前时间戳、不重置全局时间轴。先做后端聚合 + 前端源筛选，
就能让不同 AXF 的信号在同一个波形页/已选择页共存；示波器按 `stream` 流式输入接入，
触发窗口作为独立 FrameBuffer/pane 预留，不塞进 200 Hz 融合 history。
