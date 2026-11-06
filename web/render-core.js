/* MotorScope render modes — tiny plugin registry + default renderers.
 *
 * Mode contract:
 *   MSRenderModes.register(id, {
 *     label: '按钮文字',
 *     draw(ctx, data) { ... }
 *   });
 *
 * `data` supplied by app.js draw():
 *   mode, color, alpha (0..1), isPrimary, focus, glow, width, step,
 *   raw:   [[x,y], ...]       raw / decimated trace (always)
 *   mean:  [[x,y], ...]|null  filtered mean line (may be auto-disabled)
 *   env:   {top:[[x,y]], bottom:[[x,y]]}|null  absolute-bin min/max envelope
 *   x0, pw, paneTop, paneHeight, decimate, row, pane
 *
 * Helpers are exposed for third-party modes; keep drawing side-effect free
 * (save/restore is handled by the caller).
 */
(() => {
  'use strict';

  const modes = new Map();
  const listeners = new Set();

  function hexAlpha(color, a) {
    const c = String(color || '#22d3ee').replace('#', '');
    if (c.length === 3) {
      const r = parseInt(c[0] + c[0], 16), g = parseInt(c[1] + c[1], 16), b = parseInt(c[2] + c[2], 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    if (c.length >= 6) {
      const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    return color;
  }

  function register(id, mode) {
    if (!id || !mode || typeof mode.draw !== 'function') return false;
    modes.set(String(id), Object.assign({ id: String(id), label: String(mode.label || id) }, mode));
    listeners.forEach((fn) => { try { fn(); } catch {} });
    return true;
  }

  function list() { return Array.from(modes.values()); }
  function get(id) { return modes.get(String(id)) || null; }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function strokePath(ctx, pts, step) {
    if (!pts || !pts.length) return false;
    ctx.beginPath();
    let started = false, prevY = 0;
    for (const p of pts) {
      const x = p[0], y = p[1];
      if (!started) { ctx.moveTo(x, y); started = true; }
      else if (step) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
      prevY = y;
    }
    return started;
  }

  function drawMain(ctx, pts, o, opts = {}) {
    if (!strokePath(ctx, pts, !!o.step)) return;
    const color = o.color || '#22d3ee';
    const alpha = Number.isFinite(o.alpha) ? o.alpha : 1;
    const width = Number.isFinite(o.width) ? o.width : 1.5;
    if (o.glow) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexAlpha(color, 0.055 * alpha);
      ctx.lineWidth = width * 5.5;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.strokeStyle = hexAlpha(color, 0.10 * alpha);
      ctx.lineWidth = width * 2.4;
      ctx.stroke();
      ctx.restore();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = alpha >= 1 ? color : hexAlpha(color, alpha);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    if (opts.shadow && o.isPrimary && !o.focus) {
      ctx.save();
      ctx.shadowColor = hexAlpha(color, .55);
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawFaint(ctx, pts, o, alphaScale = 0.16, width = 1.1) {
    if (!pts || pts.length < 2) return;
    if (!strokePath(ctx, pts, !!o.step)) return;
    const alpha = Number.isFinite(o.alpha) ? o.alpha : 1;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.strokeStyle = hexAlpha(o.color || '#22d3ee', Math.min(0.28, alphaScale * alpha));
    ctx.stroke();
  }

  function drawBand(ctx, env, o, opts = {}) {
    if (!env || !env.top || !env.bottom || env.top.length < 2) return false;
    const color = o.color || '#22d3ee';
    const alpha = Number.isFinite(o.alpha) ? o.alpha : 1;
    ctx.beginPath();
    ctx.moveTo(env.top[0][0], env.top[0][1]);
    for (let i = 1; i < env.top.length; i++) ctx.lineTo(env.top[i][0], env.top[i][1]);
    for (let i = env.bottom.length - 1; i >= 0; i--) ctx.lineTo(env.bottom[i][0], env.bottom[i][1]);
    ctx.closePath();
    ctx.fillStyle = hexAlpha(color, Math.min(0.20, 0.10 * alpha + 0.02));
    ctx.fill();
    if (opts.texture !== false) {
      ctx.beginPath();
      for (let i = 0; i < env.top.length; i++) {
        const y0 = env.top[i][1], y1 = env.bottom[i][1];
        if (Math.abs(y1 - y0) < 0.6) continue;
        ctx.moveTo(env.top[i][0], y0);
        ctx.lineTo(env.top[i][0], y1);
      }
      ctx.strokeStyle = hexAlpha(color, Math.min(0.24, 0.12 * alpha));
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.stroke();
    }
    return true;
  }

  // ---- default modes ----
  register('classic', {
    label: '原始',
    draw(ctx, o) {
      drawMain(ctx, o.raw, o, { shadow: true });
    },
  });

  register('mean', {
    label: '均线',
    draw(ctx, o) {
      if (!o.mean) { drawMain(ctx, o.raw, o, { shadow: true }); return; }
      drawFaint(ctx, o.raw, o, 0.16, 1.1);
      drawMain(ctx, o.mean, o);
    },
  });

  register('band', {
    label: '包络',
    draw(ctx, o) {
      if (!o.mean) { drawMain(ctx, o.raw, o, { shadow: true }); return; }
      if (o.env) drawBand(ctx, o.env, o);
      else drawFaint(ctx, o.raw, o, 0.14, 1.0);
      drawMain(ctx, o.mean, o);
    },
  });

  window.MSRenderModes = {
    register, list, get, onChange, draw(ctx, data) {
      const mode = get(data && data.mode) || get('mean') || get('classic');
      if (mode) mode.draw(ctx, data);
    },
    helpers: { hexAlpha, strokePath, drawMain, drawFaint, drawBand },
    _modes: modes,
  };
})();
