# 写入面板重构（handoff）

> 状态：待实现。基线 commit `70d0506`，仓库 `<工程目录>`。
> 目标：**整体重做写入模块 UI**（不是小修），后端 `/api/write` 不改。

## 1. 用户原话 / 需求

1. **去掉界面上的 `writeSize` 选择器**（紧凑/标准/大/自动拉伸）。
   - 全局面板尺寸只保留一种（固定的小尺寸布局）。
   - `seg small`（模块里的 `滑条 / 开关` 分段选择）保留。
   - 模块尺寸由**每个子项自己管理**：现有 `width`（1/4、1/3、1/2、整行）继续保留，
     不再由整个写入界面统一改。
2. 现在实时写滑条时，状态会在 `写入中…` 和 `已写 38,692 · 回读 38,692` 之间
   每 100ms 闪一次；**必须消除闪烁**。实时拖动时状态应稳定，只在有意义的时候更新。
3. **重构开关样式、滑条样式和信息布局**；基本等于把 `renderWriteMods` 重写。
4. 保留所有安全/功能语义：
   - “允许写入”全局解锁；未解锁按钮禁用；
   - 每模块独立 `写入` 按钮；写后回读；不一致标红/提示；
   - 位域走读-改-写（后端已有）；
   - `滑条 / 开关` 两种模式；`实时` 按住滑条 100ms 写一次、松开补最后一次；
   - 每模块 `min/max/step` 可编辑；
   - 每模块宽度 1/4 → 1/3 → 1/2 → 整行；
   - 模块可删除；写入模块状态随工程保存/恢复。

## 2. 现有实现位置

- HTML：`web/index.html` 第 ~305 行 `#writeCard`：
  - 头部：`写`、提示、`×`、`#writeSize` 选择器、`#writeArmed`、`#writeState`；
  - `#writeList` 容器。
- JS（`web/app.js`）：
  - `D.writeSize` / `D.writeList` / `D.writeArmed` / `D.writeState` 缓存；
  - `applyWriteSize()`：给 `#writeCard` 切 `size-sm/md/lg/auto`；
  - `syncWriteUI()`：解锁状态/按钮禁用；
  - `renderWriteMods()`：整块 `innerHTML=''` 重建成模块；
  - `refreshWriteUI()`：每帧/状态刷新时改 slider/number/switch/status；
  - `sendWrite()`：写请求 + 回读；实时写时每 100ms 调一次；
  - `finishLiveWrite()` / `startLiveWrite()` / `stopLiveWrite()`；
  - 保存/恢复：`saveLocal()` / `restoreConfig()` 里的 `write: { size, mods }`；
  - 监听：`#writeSize` change（约 4595 行）。
- CSS：`web/style.css`：
  - `.write-card`、`.write-card.size-sm/md/lg/auto`、`.write-list`、`.write-mod`；
  - `.wm-head`、`.wm-name`、`.wm-addr`、`.wm-width`、`.wm-write`、`.wm-del`；
  - `.wm-body`、`.wm-slider`、`.wm-number`、`.wm-range`、`.wm-live`、`.wm-status`；
  - `.write-card.locked ...`。
- 文档：`README.md` §3.1 写入窗口（需要同步更新为新的交互）。

## 3. 当前问题 / 重做要点

### 3.1 尺寸选择器

- 删除 `#writeSize`、`D.writeSize`、`applyWriteSize()`、`S.write.size`、
  `.write-card.size-*` 和 `--write-h` 多档高度。
- `writeCard` 只保留一种固定/自适应小布局（建议 `max-height` + 内部滚动，
  不因模块数量把整页撑开）。
- 旧工程存档里的 `write.size` 要**兼容忽略**，不能报错；新存档不再写 `size`。
- 每个模块的 `width` 继续保存/恢复。

### 3.2 闪烁

原因：`sendWrite()` 每次都把 `mod.status='写入中…'` 并 `refreshWriteUI()`，
请求回来又改成 `已写…`；实时写 100ms 一次，状态文本反复横跳。

建议：

- 模块 DOM **只构建一次**，状态更新只改文本节点/class，不整块重建。
- 把“实时写进行中”做成独立、稳定的视觉状态（例如滑条旁的细进度点/`LIVE` 徽标），
  不要每 tick 改 `wm-status` 文案。
- `wm-status` 只在：
  - 一次显式 `写入` 完成；
  - 松开滑条后的最后一次写完成；
  - 出错；
  - 解锁状态变化
  时更新；实时写过程中的中间结果不刷文案（或只在值真正变化时节流更新）。
- 同一状态文本相同就不要写 DOM（或比较后更新），避免布局抖动。
- 滑条拖动时数字框跟随，但不要因为采样值刷新覆盖用户正在拖的值
  （现有 `focused` 检查保留并加强）。

### 3.3 开关 / 滑条 / 信息布局

- 头部建议：第一行 `名称` + 地址/类型 + 删除；第二行 `模式 seg` + 宽度 + `写入`；
  或更紧凑的两行布局，避免现在 `name` 在 `head` 外面单独一行造成错位。
- 滑条：统一自定义轨道/滑块样式（不要原生 accent 的随机观感），
  显示 min/max 或当前值；数字输入靠右。
- 开关：做成明确的滑动开关（track + knob），带 ON/OFF 文案；
  0/1 状态一目了然；不要和 `check` 原生 checkbox 混用。
- 信息布局：地址、位宽/位域、当前值、状态各归其位；1/4 宽度时仍可读。
- 保持深色主题、青/琥珀强调色，和现有设计语言一致。
- 可选择地给模块加“实时写入中”呼吸点，但不要造成闪烁。

## 4. 必须保持的契约

- 状态对象：`S.write.mods[]` 字段保持 `id/rowId/mode/width/widthTouched/min/max/step/live/
  addr/size/signed/name`，可新增 UI 字段；`saveLocal/restoreConfig` 要兼容旧字段。
- 后端接口不变：`POST /api/write {addr,size,value,bit,verify}`。
- `afterSignalsChanged()`、`ensureWriteMods()`、`toggleWriteRow()` 的调用关系不要破坏；
  写模块来自左侧信号行“写”键。
- 未解锁时所有写操作/实时写都必须被拒绝；刷新/切工程不保留 `armed`。
- 写值范围仍按位宽 clamp；位域 RMW 由后端做。
- 不要改 `/api/read`、寄存器描述、机型工程、已选择页等无关功能。

## 5. 验收清单

- [ ] `#writeSize` 从 UI 和状态里消失；旧存档不报错。
- [ ] 写入面板固定一种布局；模块多时内部滚动，不撑破页面。
- [ ] 滑条实时写 3 秒以上，`wm-status` 不闪；`LIVE`/实时状态稳定。
- [ ] 松开滑条后最终值写入，状态显示一次“已写 X · 回读 Y”。
- [ ] 开关模式：ON/OFF 样式清晰，点开关（实时开）只发一次；点“写入”也正常。
- [ ] 1/4、1/3、1/2、整行四种宽度都可用；1/4 下信息不重叠。
- [ ] 未解锁、无地址、写入失败、回读不一致都有明确提示。
- [ ] 刷新页面/切工程后模块与宽度恢复，`armed` 不恢复。
- [ ] `python3 -m unittest discover -s tests` 通过；`node --check web/app.js` 通过。
- [ ] README §3.1 更新。

## 6. 备注

- 之前已删除 `selected-block`/overlay，新增读/寄存器描述/复位等；不要回退。
- 工作区有未跟踪的 `docs/wchlinke-research.md` 与 `tools/openocd-wch-fast/`，与本任务无关。
- 完成后**不要 git commit**，保留工作区改动，汇报改动摘要 + 测试结果 + 已知问题。
