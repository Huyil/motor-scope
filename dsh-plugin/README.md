# dsh-motorscope

DSH 里的 MotorScope 面板：左侧栏新增一个 `sidebar.panellist` 行（就是插件管理器那种
`HKBBFa_panelRow`），点开后主区是一整页 MotorScope，并在顶部提供 **打开 / 重启 / 关闭** 三个独立按键。

## 它解决什么

以前改完 `scope_server.py` 要手动关掉 `start_scope.bat` 的控制台窗口再重开。
现在点「重启」：

1. 找到所有 `scope_server.py` 进程；
2. 连同它们的控制台父进程（`cmd.exe /k ...dsh-launch.cmd` 或 `start_scope.bat`）整棵树
   `taskkill /T /F` —— 旧窗口直接关掉；
3. 用**上一次的同一组参数**重新开一个可见控制台窗口（`python -u scope_server.py ...`）；
4. 等 `/api/status` 就绪后自动刷新 iframe。

「打开」= 如果没在跑就启动（先清理残留实例）；「关闭」是**单独按键**，只有点它才会关进程树；
「刷新」只刷新页面，不动进程；「新窗口」在浏览器里单独打开。

切换 DSH 页面/面板**不会**启动或关闭 MotorScope：client 卸载时只停轮询，
不会对进程做任何操作；打开/重启请求由 host 侧继续执行，回来后再轮询到结果。

## 位置

| 东西 | 路径 |
|---|---|
| 插件源码 | `/home/dr/dsh-plugins/dsh-motorscope` |
| 构建产物 | `lib/index.js`（host）+ `lib/client.js`（ModuleLoader bundle） |
| 生成的启动器 | `D:\Code\motor-scope\runtime\dsh-launch.cmd` |
| 最近一次参数 | `~/.dsh/motorscope-panel.json` |
| host API | `/motorscope/api/{state,start,stop,restart}` |

## 局域网

- **默认关闭**：不启动 0.0.0.0 监听，也不加 80 portproxy/防火墙规则。
- 第一开关“局域网共享”：用当前 MotorScope 端口监听 `0.0.0.0`，首次会弹 Windows
  防火墙提示；面板显示共享地址 `http://<IP>:<端口>/`。
- 第二开关“80 端口”（可选）：再开 portproxy 80 → 当前端口 + 防火墙规则，
  显示 `http://<IP>/`；需要管理员权限。
- Windows IPv4 自动探测（`[System.Net.Dns]` + `Get-NetIPAddress`），**优先 192.168.\***，
  其次 10.x / 172.16-31；不写死 `192.168.0.71`。
- iframe 会带 `?lan=<当前共享URL>`；MotorScope 的分享链接优先使用它。

## 首次使用

注入/安装后**刷新一次 DSH 页面**，左侧栏（插件管理器图标下方）会出现 MotorScope 行。
第一次点开时**不会自动启动**：服务没在跑就显示「打开」按钮；
如果已经有一个实例（比如当前 8898 仿真），面板直接显示它，不会动它。
这样切换页面不会误触发启动/重启。

## 侧栏状态点

`MotorScope` 行的波形图标右下角有一个小圆点：

| 颜色 | 含义 |
|---|---|
| 绿 | 运行中且 `/api/status` 正常 |
| 琥珀 | 进程在，但还没就绪/不健康 |
| 灰 | 未运行 |

面板打开时每 3 秒刷新，只显示侧栏时每 10 秒刷新；按钮操作会立即更新。
点开面板/切回页面时会先强制刷新一次，不至于看到过期状态。

## 切页重载（DSH 限制）

DSH 的 `main` 槽是 keyed 单入口，**没有** `keepMounted`（只有右侧栏 tab 类型有）。
所以切到别的主面板再回来，iframe 会重新挂载、重新加载页面。
这是 dsh-web 的结构限制，按你的要求没有改。
服务进程和采样不受影响，MotorScope 的工程/配置从 localStorage 恢复，历史从 `/api/history` 补。

> ⚠️ 第一次点「重启」会关掉你现在正开着的那个 8898 控制台窗口，然后用同样参数重开。
> 这是预期行为，不是崩溃。

## 参数

重启/打开使用发现到的运行参数（`--sim --signals C:\tmp\imp_signals.json --port 8898` 这类），
`--open` 会被去掉以免重复弹浏览器。想换参数：直接改 `~/.dsh/motorscope-panel.json` 的
`args`，或先用命令行起一个新实例，面板发现后会自动记住。

## 构建 / 热重载

```bash
cd /home/dr/dsh-plugins/dsh-motorscope
node --check src/index.js && node --check src/client.js
bash scripts/build.sh
# 在 DSH 里：dev_reload_package dsh-motorscope
```

## 为什么之前重启后失效

DSH 的 profile 只把带 `dsh.bundle.patch` 的包当作 bundle 层。只把包名加进
`dsh.profile.bundles` 而包里没有 `dsh.bundle`，启动时会被跳过（表现为侧栏行消失、
`/motorscope/api/state` 404）。本包现在带：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { ... } }
```

`cordis.patch.yml` 里 `- insert:` 自己这一行。改完用离线 `loadProfile` 验证过：
层存在、无 skipped、entry 能 compose 出来。
