/* GLM 渲染模式插件 —— 两种与内置 classic/mean/band 不同的高频波形渲染。
 *
 * 1) glm-phosphor「荧光」— 数字荧光 / DPO 风格的密度显示：
 *    用 env（无则由 raw 现场构建像素列 min/max 包络）做 5 层由外向内
 *    逐层收窄、透明度递增的包络描边叠加（'lighter' 混合模拟荧光余辉
 *    分层），再叠加极淡的竖向纹理表现包络内部密度过渡；有 mean 时叠
 *    一条实线，无 mean 时用包络中线。全部几何均由 env/raw 确定性导出，
 *    无随机数、无帧计数，不闪烁；复杂度 O(env 列数)=O(pixels)。
 *
 * 2) glm-scope「示波」— 示波器包络轮廓风格：
 *    只描出 min/max 包络的上下边缘轮廓线（不整块填充），两条轮廓线
 *    之间用固定像素间隔（8px 列）的稀疏斜纹/短竖线做内部纹理，中间
 *    叠一条点划中值线。与内置 band（整块半透明填充 + 每列竖线）在
 *    视觉上明显不同。复杂度 O(pixels)。
 *
 * 契约：MSRenderModes.register(id,{label,draw(ctx,data)})；data 字段
 * 见 render-core.js 顶部注释。draw 内部自行 ctx.save()/restore()，
 * 不假设调用方恢复样式。
 */
(() => {
  'use strict';
  const H = window.MSRenderModes && window.MSRenderModes.helpers;

  // 由 raw 折线构建像素列 min/max 包络（当 data.env 不存在时的回退）。
  // 复杂度 O(raw.length)。返回 {top,bottom} 或 null。
  function envelopeFromRaw(raw) {
    if (!raw || raw.length < 2) return null;
    const bins = new Map();
    for (const p of raw) {
      const k = Math.round(p[0]);
      const b = bins.get(k);
      if (!b) bins.set(k, { x: p[0], top: p[1], bot: p[1] });
      else {
        if (p[1] > b.top) b.top = p[1];
        if (p[1] < b.bot) b.bot = p[1];
      }
    }
    const keys = Array.from(bins.keys()).sort((a, b) => a - b);
    if (keys.length < 2) return null;
    const top = [], bottom = [];
    for (const k of keys) {
      const b = bins.get(k);
      top.push([b.x, b.top]);
      bottom.push([b.x, b.bot]);
    }
    return { top, bottom };
  }

  // 包络中线：每列 (top+bottom)/2。
  function midLine(env) {
    if (!env || !env.top || !env.bottom || env.top.length < 2) return null;
    const out = [];
    const n = Math.min(env.top.length, env.bottom.length);
    for (let i = 0; i < n; i++) {
      out.push([(env.top[i][0] + env.bottom[i][0]) / 2, (env.top[i][1] + env.bottom[i][1]) / 2]);
    }
    return out;
  }

  // 沿包络边缘向中线方向收缩 factor（0..1）后的轮廓点。
  function shrinkEdge(edge, other, factor) {
    const out = [];
    const n = Math.min(edge.length, other.length);
    for (let i = 0; i < n; i++) {
      out.push([edge[i][0], edge[i][1] + (other[i][1] - edge[i][1]) * factor]);
    }
    return out;
  }

  function strokePolyline(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  // ============ 1) glm-phosphor 荧光（数字荧光 / DPO 密度风格） ============
  window.MSRenderModes.register('glm-phosphor', {
    label: '荧光',
    draw(ctx, o) {
      const color = o.color || '#22d3ee';
      const alpha = Number.isFinite(o.alpha) ? o.alpha : 1;
      const env = o.env || envelopeFromRaw(o.raw);
      if (!env || env.top.length < 2) {
        // 数据太少：退回普通主线，保证任何情况下都有输出。
        if (H && H.drawMain) H.drawMain(ctx, o.raw, o, { shadow: true });
        return;
      }
      const bot = env.bottom, top = env.top;

      ctx.save();
      // 多层低透明度叠加模拟荧光余辉：外层宽而淡，内层窄而亮。
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      const layers = [
        { f: 0.00, w: (o.width || 1.5) * 6.0, a: 0.030 },
        { f: 0.18, w: (o.width || 1.5) * 3.6, a: 0.045 },
        { f: 0.38, w: (o.width || 1.5) * 2.2, a: 0.070 },
        { f: 0.60, w: (o.width || 1.5) * 1.4, a: 0.100 },
        { f: 0.80, w: (o.width || 1.5) * 1.0, a: 0.140 },
      ];
      for (const L of layers) {
        ctx.strokeStyle = H ? H.hexAlpha(color, Math.min(0.30, L.a * alpha))
          : 'rgba(120,220,255,' + Math.min(0.3, L.a * alpha) + ')';
        ctx.lineWidth = L.w;
        strokePolyline(ctx, shrinkEdge(top, bot, L.f));
        strokePolyline(ctx, shrinkEdge(bot, top, L.f));
      }

      // 很淡的竖向包络纹理：内部密度过渡，每 2 列画一条，透明度极低。
      ctx.strokeStyle = H ? H.hexAlpha(color, Math.min(0.10, 0.05 * alpha)) : color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const n = Math.min(top.length, bot.length);
      for (let i = 0; i < n; i += 2) {
        const dy = bot[i][1] - top[i][1];
        if (dy < 1.5) continue;
        ctx.moveTo(top[i][0], top[i][1] + 0.5);
        ctx.lineTo(top[i][0], bot[i][1] - 0.5);
      }
      ctx.stroke();
      ctx.restore();

      // 中轴：mean 优先，否则包络中线。
      const mid = o.mean || midLine(env);
      if (mid && mid.length > 1) {
        if (H && H.drawMain) H.drawMain(ctx, mid, o);
        else {
          ctx.save();
          ctx.lineWidth = o.width || 1.5;
          ctx.strokeStyle = color;
          ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
          strokePolyline(ctx, mid);
          ctx.restore();
        }
      }
    },
  });

  // ============ 2) glm-scope 示波（包络轮廓 + 稀疏纹理 + 点划中线） ============
  window.MSRenderModes.register('glm-scope', {
    label: '示波',
    draw(ctx, o) {
      const color = o.color || '#22d3ee';
      const alpha = Number.isFinite(o.alpha) ? o.alpha : 1;
      const env = o.env || envelopeFromRaw(o.raw);
      if (!env || env.top.length < 2) {
        if (H && H.drawMain) H.drawMain(ctx, o.raw, o, { shadow: true });
        return;
      }
      const top = env.top, bot = env.bottom;
      const n = Math.min(top.length, bot.length);
      const W = o.width || 1.5;

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash([]);

      // 极淡的整体填充打底（比内置 band 淡很多，仅做轮廓内衬托）。
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < n; i++) ctx.lineTo(top[i][0], top[i][1]);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
      ctx.closePath();
      ctx.fillStyle = H ? H.hexAlpha(color, Math.min(0.06, 0.04 * alpha)) : color;
      ctx.fill();

      // 上下包络边缘描边（核心视觉：轮廓线而非填充块）。
      ctx.strokeStyle = H ? H.hexAlpha(color, Math.min(0.85, 0.55 * alpha)) : color;
      ctx.lineWidth = W * 0.9;
      strokePolyline(ctx, top);
      strokePolyline(ctx, bot);

      // 内部稀疏纹理：固定 8px 列距的短竖线，只在包络内部、跳过窄列。
      // 与内置 band 的每列密纹不同——稀疏且只在边缘收缩后画，呈“栅格”观感。
      ctx.strokeStyle = H ? H.hexAlpha(color, Math.min(0.20, 0.13 * alpha)) : color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const stride = 8; // px，固定屏幕间距，宽度变化时密度稳定
      if (n >= 2) {
        const xStart = top[0][0], xEnd = top[n - 1][0];
        // 用线性扫描对齐列位置，O(n)。
        let idx = 0;
        for (let x = Math.ceil(xStart / stride) * stride; x <= xEnd; x += stride) {
          while (idx < n - 1 && top[idx + 1][0] < x) idx++;
          if (idx >= n - 1) break;
          const x0 = top[idx][0], x1 = top[idx + 1][0];
          if (x1 <= x0) continue;
          const t = (x - x0) / (x1 - x0);
          const yt = top[idx][1] + (top[idx + 1][1] - top[idx][1]) * t;
          const yb = bot[idx][1] + (bot[idx + 1][1] - bot[idx][1]) * t;
          if (yb - yt < 3) continue;
          ctx.moveTo(x, yt + 1);
          ctx.lineTo(x, yb - 1);
        }
      }
      ctx.stroke();

      // 中值/均值：点划线（区别于内置模式的实线均值）。
      const mid = o.mean || midLine(env);
      if (mid && mid.length > 1) {
        ctx.strokeStyle = alpha >= 1 ? (H ? H.hexAlpha(color, 0.9) : color)
          : (H ? H.hexAlpha(color, Math.min(0.9, 0.75 * alpha)) : color);
        ctx.lineWidth = W * 0.8;
        ctx.setLineDash([7, 4]);
        strokePolyline(ctx, mid);
        ctx.setLineDash([]);
      }
      ctx.restore();
    },
  });
})();
