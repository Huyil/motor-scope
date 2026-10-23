# MotorScope HTTP API（给 Agent / 脚本用）

服务默认跑在 Windows 的 `http://127.0.0.1:8765`，无鉴权、只绑本机。
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
| `GET /api/status` | 连接状态、实际采样率、`generation`、`history` 点数、`oldest_t`/`latest_t`、`config.signals` |
| `GET /api/catalog` | 441 个变量 / 27 个外设，地址/类型/位域/默认堵转信号 |
| `GET /api/log` | 服务 + OpenOCD 尾部日志 |
| `GET /api/record.csv` | 后端录制 CSV（需要先 POST `/api/record` 开启） |
| `GET /api/stream` | SSE：`hello` / `status` / `s`；浏览器实时用 |

## 5. 控制接口（只读 Agent 不要调）

| 接口 | 说明 |
| --- | --- |
| `POST /api/config` | `{"signals":[...],"rate":100}`，会改变用户正在看的通道；通道变了清历史 |
| `POST /api/record` | `{"active":true}` 开始后端录制 |
| `POST /api/connect` | `{"mode":"openocd"|"sim"|"attach"}` 重新连 |
| `POST /api/disconnect` | 断开并释放 OpenOCD/H7-TOOL |
| `POST /api/catalog/reload` | 从 AXF 重建 signals.json |
| `POST /api/probe` | 一次性 TCL 握手，读 CPUID |

这些接口没有鉴权、是共享状态；Agent 只读时只使用 GET。

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

## 7. 从 WSL 访问

服务在 Windows loopback，WSL 直接 `curl http://127.0.0.1:8765` 不通；走 Windows 命令：

```bash
cmd.exe /c "curl -s http://127.0.0.1:8765/api/status"
cmd.exe /c "curl -s 'http://127.0.0.1:8765/api/history/next?after=1441480.1&timeout=20'"
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
