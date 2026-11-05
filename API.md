# MotorScope HTTP API（给 Agent / 脚本用）

服务默认跑在 Windows 的 `http://127.0.0.1:8765`，并监听 `0.0.0.0`：
同网段可用 `http://<本机IP>:80` 访问（局域网固定 80，启动时会打印 `LAN:` URL）。
**无鉴权**，同一网络内的设备都能调写/复位接口；只在本机使用时加 `--host 127.0.0.1`。
页面本身就是这套 API 的客户端；Agent 可以直接读，不需要解析 HTML。

## 1. 数据模型

`GET /api/status` 返回的 `config.signals` 是**当前采样通道的顺序表**：

```json
{
  "id": "motor.over.current",
  "name": "motor.over.current",
  "addr": 536871762,
  "size": 2,
  "signed": false,
  "scale": 1.0,
  "offset": 0.0,
  "unit": "counts",
  "axis": "left",
  "bit": [0, 1]
}
```

`/api/history` 和 `/api/history/next` 的样本是：

```json
[[t_ms, [v0, v1, ...]], ...]
```

- 第 i 个值对应 `config.signals[i]`；
- `v` 已经是位域/有符号解码后的原始值；
- 实际物理量 = `v * scale + offset`；
- `t_ms` 是相对服务器启动的毫秒，不是 wall clock；可用 `/api/status` 的 `uptime` 反推；
- `generation` 是配置代数：改通道/换信号源会 +1，旧游标作废。

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
  "count": 1
}
```

- `gap: true`：`before` 比环形缓冲里最老的点还老，之前的数据已经丢了；
- `cursor` 建议作为下一次 `after`。

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
| `GET /api/status` | 连接状态、实际采样率、`generation`、`history` 点数、`oldest_t`/`latest_t`、`config.signals`、`lan.ips/port`（分享链接优先用 192.*） |
| `GET /api/catalog` | 当前机型的变量/外设，地址/类型/位域/默认堵转信号；变量可带 `desc`（由 `profiles/<ID>/annotations.json` 合并） |
| `GET /api/reginfo?model=<ID>` | 该型号的寄存器描述（entries 数组；没有就返回空） |
| `GET /api/profiles` | 机型列表：`id/name/mcu/arch/available/variables/peripherals/source_axf` + `active` |
| `GET /api/log` | 服务 + OpenOCD 尾部日志 |
| `GET /api/record.csv` | 后端录制 CSV（需要先 POST `/api/record` 开启） |
| `GET /api/share/<id>` | 取回分享快照；30 天/最多 200 条，持久化在 `imports/shares.json` |
| `GET /api/stream` | SSE：`hello`（含 `clients`、`clientId/clientNo`、`presence`、当前共享 config）/ `status` / `s` / `config`（共享配置广播）/ `presence`（各端本地显示集合广播）；浏览器实时用 |

## 5. 控制接口（只读 Agent 不要调）

| 接口 | 说明 |
| --- | --- |
| `POST /api/share` | 保存当前前端快照（信号集 + 分组布局 + 时间窗口/图表开关），返回 `{"ok":true,"id":"..."}`；链接 `#share=<id>` |
| `POST /api/view` | `{"clientId":"c1","label":"dsh","visible":["信号id",...],"layout":{groups,rows,table,plot,axes,write}}`：上报本端表/波显示集合与波形分组布局，用于其他端“正在查看”提示、删除确认和“复制布局”；`layout.write` 为写入模块快照；不影响采样 |
| `POST /api/config` | `{"signals":[...],"rate":100}`，**单调试器共享采样配置**：应用后广播 `config` 给所有 SSE 客户端；通道变了清历史。多客户端时新客户端采用服务器当前配置，不自动覆盖 |
| `POST /api/record` | `{"active":true}` 开始后端录制 |
| `POST /api/connect` | `{"mode":"openocd"|"sim"|"attach"}` 重新连 |
| `POST /api/disconnect` | 断开并释放 OpenOCD/H7-TOOL |
| `POST /api/reset` | **会复位目标**：ARM 写 `AIRCR.SYSRESETREQ`，RISC-V 用 OpenOCD `reset run`；电机可能重新启动 |
| `POST /api/catalog/reload` | 从当前机型的源 AXF/SVD 重建 signals.json |
| `POST /api/profiles/switch` | `{"id":"LKS32-FOC"}` 切换机型；返回 `catalog/config/profile(s)`，会断开调试源 |
| `POST /api/profiles/config` | `{"config":{...},"manual":true}` 保存前端工程快照到 `profiles/<ID>/config.json` |
| `POST /api/profiles/build` | `{"id":"LKS32-FOC"}` 重建该机型符号表；返回新 `catalog/counts` |
| `POST /api/read` | `{"addr":..., "size":1\|2\|4, "signed":bool, "bit":[shift,width]?}` 读一次（不加入采样），返回 `value/word` |
| `POST /api/reginfo/import` | `{"model":"LKS32MC07x","entries":[...]}` 独立导入寄存器描述；写到 `web/mcu/<model>.info.json` |
| `POST /api/catalog/import` | multipart：`axf`（必填）+ `header`（可选 cw32l011.h），导入任意 AXF/ELF 并重建 |
| `POST /api/probe` | 一次性 TCL 握手，读 CPUID |
| `POST /api/write` | **会改目标内存**；写 RAM/SFR 并回读，见 5.1 |

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
