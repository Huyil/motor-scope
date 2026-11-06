/* MotorScope 渲染模式插件 —— ds 组：两种"高频波形"渲染算法
 *
 * 注册（window.MSRenderModes.register）：
 *   ds-dual  「双线」   原始线细而亮 + 均值线「双轨描边」+ 包络外沿虚线
 *   ds-tape  「采样带」 每个 2px 时间列画一根 min/max 短竖线（磁带梳齿）+ 均值叠加
 *
 * 算法说明
 * --------
 * ds-dual：三层绘制，均为 O(raw.length + env.length)。
 *   ① 原始线：用 o.step 决定的折线，线宽 = width*0.5、alpha≈0.40，细而亮，
 *      让原始高频抖动仍然可见（内置 mean 把原始线压到 0.16 太淡，几乎看不见）。
 *   ② 包络外沿：抽稀时才对 env.top / env.bottom 画 [2,4] 短虚线轨道，勾出
 *      振幅走廊的边界（内置 mean 完全没有这一层）。
 *   ③ 均值线：先画 ±1.6px 偏移的两条同色细轨（"双线"/电缆感），再压一条本色
 *      实线，最后叠一条 0.30 alpha 的白色芯线。三条路径都基于同一组 mean 点，
 *      只是 y 偏移不同，所以整体形态仍是均值，但视觉上和内置 mean 的单线不同。
 *   无 mean 时退化为「原始线 + 包络虚线」，仍然可用。
 *
 * ds-tape：一维分桶 + 每列一条竖线，O(raw.length) 或 O(env.top.length)。
 *   列宽固定 2px（屏幕绝对锚定：col = floor(x/2)），列内取 min/max 画一根 1px
 *   竖线，形成"梳齿/磁带采样"纹理——列与列之间留 1px 空隙，因此即使高频噪声
 *   糊成一片也不会变成 band 那样的实心填充。列高 < 1.4px 时画 ±1px 的短刻线，
 *   保证稀疏采样也有可见的"采样点"。列高 ≥ 8px 时在上下端各加 1px 横帽（I 形），
 *   像磁带上的采样刻度。
 *   抽稀（o.env 非空）时直接用 env 的每 bin min/max 起草，避免 o.raw 里
 *   "一个 bin 的 min/max 两点被拆到两列"而丢掉振幅；未抽稀时对 raw 单遍流式
 *   分列取 min/max。列密度只取决于数据（每列平均点数），不用随机数、不依赖帧计数。
 *   最后叠加均值线：深色衬底 + 可选 glow + 本色实线 + 白色芯线，把均值从
 *   "梳齿"里托出来；无 mean（阶梯通道/稀疏窗口）时只留采样带本体。
 *
 * 所有绘制都在本函数内 save/restore，并把 setLineDash / lineJoin / lineCap /
 * globalCompositeOperation 复原，不依赖调用方恢复样式。
 */
(() => {
  'use strict';

  const API = window.MSRenderModes;
  if (!API || typeof API.register !== 'function') return;

  const H = API.helpers || {};

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function num(v, d) { return Number.isFinite(v) ? v : d; }

  // 本地 hexAlpha 兜底（render-core 里的 helper 优先），避免 helpers 缺失时整块不画。
  function hexA(color, a) {
    if (typeof H.hexAlpha === 'function') return H.hexAlpha(color, a);
    const c = String(color || '#22d3ee').replace('#', '');
    let r = 34, g = 211, b = 238;
    if (c.length === 3) {
      r = parseInt(c[0] + c[0], 16);
      g = parseInt(c[1] + c[1], 16);
      b = parseInt(c[2] + c[2], 16);
    } else if (c.length >= 6) {
      r = parseInt(c.slice(0, 2), 16);
      g = parseInt(c.slice(2, 4), 16);
      b = parseInt(c.slice(4, 6), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  // 与 render-core 的 strokePath 同语义，额外支持整体 y 偏移（双线的并行轨用）。
  function tracePath(ctx, pts, step, dy) {
    if (!pts || !pts.length) return false;
    const off = dy || 0;
    ctx.beginPath();
    let started = false, prevY = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p[0], y = p[1] + off;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else if (step) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
      prevY = y;
    }
    return started;
  }

  // ---- 模式 1：双线 ----
  function drawDual(ctx, o) {
    const color = o.color || '#22d3ee';
    const alpha = clamp01(num(o.alpha, 1));
    const width = Math.max(0.8, num(o.width, 1.5));
    const raw = Array.isArray(o.raw) ? o.raw : [];
    const mean = Array.isArray(o.mean) && o.mean.length > 1 ? o.mean : null;
    const env = (o.env && Array.isArray(o.env.top) && o.env.top.length > 1) ? o.env : null;
    if (!raw.length && !mean) return;

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // ① 原始线：细、亮，高频抖动依然可见
    if (raw.length > 1) {
      if (tracePath(ctx, raw, !!o.step, 0)) {
        ctx.lineWidth = Math.max(0.7, width * 0.5);
        ctx.strokeStyle = hexA(color, 0.42 * alpha);
        ctx.stroke();
      }
    }

    // ② 包络外沿：短虚线轨道，勾出振幅走廊
    if (env) {
      const top = env.top;
      const bot = (Array.isArray(env.bottom) && env.bottom.length) ? env.bottom : null;
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
      if (bot) {
        for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
      }
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = hexA(color, 0.32 * alpha);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ③ 均值线：±1.6px 双轨 + 本色实线 + 白色芯线
    if (mean) {
      const railA = 0.34 * alpha;
      const railW = Math.max(0.6, width * 0.34);
      if (tracePath(ctx, mean, false, -1.6)) {
        ctx.setLineDash([]);
        ctx.lineWidth = railW;
        ctx.strokeStyle = hexA(color, railA);
        ctx.stroke();
      }
      if (tracePath(ctx, mean, false, 1.6)) {
        ctx.lineWidth = railW;
        ctx.strokeStyle = hexA(color, railA * 0.85);
        ctx.stroke();
      }
      if (tracePath(ctx, mean, false, 0)) {
        if (o.glow) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = hexA(color, 0.07 * alpha);
          ctx.lineWidth = width * 4.2;
          ctx.stroke();
          ctx.strokeStyle = hexA(color, 0.12 * alpha);
          ctx.lineWidth = width * 1.8;
          ctx.stroke();
          ctx.restore();
        }
        ctx.lineWidth = width;
        ctx.strokeStyle = alpha >= 1 ? color : hexA(color, alpha);
        ctx.stroke();
        // 顶光芯线：让均值线有"实体"质感
        ctx.lineWidth = Math.max(0.55, width * 0.32);
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.30 * alpha).toFixed(3) + ')';
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ---- 模式 2：采样带 ----
  const TAPE_COL = 2;      // 屏幕列宽（px）：1px 竖线 + 1px 空隙
  const TAPE_MIN_H = 1.4;  // 列高小于此值画成刻线而不是竖线

  function drawTape(ctx, o) {
    const color = o.color || '#22d3ee';
    const alpha = clamp01(num(o.alpha, 1));
    const width = Math.max(0.9, num(o.width, 1.5));
    const raw = Array.isArray(o.raw) ? o.raw : [];
    const mean = Array.isArray(o.mean) && o.mean.length > 1 ? o.mean : null;
    const env = (o.env && Array.isArray(o.env.top) && o.env.top.length > 1) ? o.env : null;
    if (!raw.length && !mean) return;

    ctx.save();
    ctx.setLineDash([]);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';

    let cols = 0, samples = 0;

    // 单列落笔：竖线 / 极矮列画成上下 1px 的刻线；较高的列补 I 形横帽。
    function emit(px, y0, y1) {
      if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
      if (y1 - y0 < TAPE_MIN_H) {
        const mid = (y0 + y1) / 2;
        ctx.moveTo(px, mid - 1.0);
        ctx.lineTo(px, mid + 1.0);
      } else {
        ctx.moveTo(px, y0);
        ctx.lineTo(px, y1);
        if (y1 - y0 >= 8) {
          ctx.moveTo(px - 1, y0); ctx.lineTo(px + 1, y0);
          ctx.moveTo(px - 1, y1); ctx.lineTo(px + 1, y1);
        }
      }
      cols++;
    }

    ctx.beginPath();
    if (env) {
      // 抽稀路径：直接用每个 bin 的绝对 min/max，避免 raw 的 min/max 两点被拆列。
      const top = env.top;
      const bot = (Array.isArray(env.bottom) && env.bottom.length) ? env.bottom : top;
      const n = Math.min(top.length, bot.length);
      for (let i = 0; i < n; i++) {
        const x = Math.min(top[i][0], bot[i][0]);
        const px = Math.floor(x / TAPE_COL) * TAPE_COL + TAPE_COL / 2;
        emit(px, top[i][1], bot[i][1]);
      }
      samples = n;
    } else if (raw.length) {
      // 未抽稀：单遍流式按列聚合 min/max（raw 的 x 单调不减）。
      let col = Math.floor(raw[0][0] / TAPE_COL);
      let lo = raw[0][1], hi = raw[0][1];
      for (let i = 1; i < raw.length; i++) {
        const p = raw[i];
        const c = Math.floor(p[0] / TAPE_COL);
        if (c !== col) {
          emit(col * TAPE_COL + TAPE_COL / 2, lo, hi);
          col = c; lo = hi = p[1];
        } else {
          if (p[1] < lo) lo = p[1];
          if (p[1] > hi) hi = p[1];
        }
      }
      emit(col * TAPE_COL + TAPE_COL / 2, lo, hi);
      samples = raw.length;
    }

    // 密度只由数据决定（每列平均点数），不发生随机/帧计数抖动。
    if (cols) {
      const per = samples / cols;
      const base = per >= 6 ? 0.38 : per >= 3 ? 0.50 : 0.62;
      ctx.lineWidth = 1;
      ctx.strokeStyle = hexA(color, base * alpha);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 均值叠加：深色衬底 → 可选辉光 → 本色实线 → 白色芯线
    if (mean) {
      if (tracePath(ctx, mean, false, 0)) {
        ctx.setLineDash([]);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = width + 2.6;
        ctx.strokeStyle = 'rgba(4,9,16,' + (0.58 * alpha).toFixed(3) + ')';
        ctx.stroke();
        if (o.glow) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = hexA(color, 0.07 * alpha);
          ctx.lineWidth = width * 4.2;
          ctx.stroke();
          ctx.strokeStyle = hexA(color, 0.12 * alpha);
          ctx.lineWidth = width * 1.8;
          ctx.stroke();
          ctx.restore();
        }
        ctx.lineWidth = width;
        ctx.strokeStyle = alpha >= 1 ? color : hexA(color, alpha);
        ctx.stroke();
        ctx.lineWidth = Math.max(0.55, width * 0.30);
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.22 * alpha).toFixed(3) + ')';
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  API.register('ds-dual', { label: '双线', draw: drawDual });
  API.register('ds-tape', { label: '采样带', draw: drawTape });
})();
