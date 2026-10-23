/* MotorScope UI — vanilla JS, canvas waveform, SSE */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, '0');

  function fmtInt(v) {
    if (!isFinite(v)) return '--';
    const r = Math.round(v);
    return Math.abs(r) >= 10000 ? r.toLocaleString('en-US') : String(r);
  }
  function fmtAxis(v) {
    if (!isFinite(v)) return '';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a >= 1000) return Math.round(v).toLocaleString('en-US');
    if (a >= 100) return String(Math.round(v));
    if (a >= 10) return (Math.round(v * 10) / 10).toString();
    if (a >= 1) return (Math.round(v * 100) / 100).toString();
    return (Math.round(v * 1000) / 1000).toString();
  }
  function fmtValue(sig, raw) {
    if (raw === null || raw === undefined) return '--';
    const v = raw * (sig?.scale ?? 1) + (sig?.offset ?? 0);
    if (!isFinite(v)) return '--';
    if ((sig?.scale ?? 1) === 1 && (sig?.offset ?? 0) === 0) return fmtInt(v);
    return (Math.round(v * 100) / 100).toLocaleString('en-US');
  }
  function hex(n, w = 8) {
    return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
  }
  function shortName(name) {
    return String(name || '').replace(/^motor\./, '').replace(/^adc\./, 'adc.');
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function fetchJSON(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  const post = (url, body) => fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  // ---------------------------------------------------------------- state
  const S = {
    catalog: { variables: [], peripherals: [], defaults: [], stall: {}, meta: {} },
    index: new Map(),
    signals: [],
    samples: [],
    lastT: 0,
    status: null,
    source: { kind: 'none', connected: false },
    sampler: {},
    record: {},
    rate: 100,
    windowSec: 20,
    autoZero: false,
    fillOn: true,
    gridOn: true,
    paused: false,
    pauseAt: 0,
    dirty: true,
    hoverT: null,
    hoverX: null,
    view: null,
    size: { w: 0, h: 0 },
    stall: {
      enabled: true,
      currentId: '',
      thresholdId: '',
      autoPause: false,
      active: false,
      since: 0,
      count: 0,
      lastDuration: 0,
      events: [],
    },
    ui: {
      tab: 'vars',
      search: '',
      openGroups: new Set(['motor', 'adc', 'sys']),
      openPeriph: new Set(['ADC', 'ATIM', 'GPIOA']),
      openRegs: new Set(),
      overlayDismissed: false,
      drawer: false,
      log: false,
      connecting: false,
    },
    es: null,
    selRows: new Map(),
    liveRows: new Map(),
    legendEls: new Map(),
    toastKeys: new Set(),
    configTimer: 0,
    configDirty: false,
    lastStatusAt: 0,
    serverUptime: 0,
    errors: new Set(),
    sampleCountSeen: 0,
  };

  // ---------------------------------------------------------------- dom
  const D = {};
  function cacheDom() {
    D.overlay = $('#overlay');
    D.overlayHint = $('#overlayHint');
    D.connPill = $('#connPill');
    D.connText = $('#connText');
    D.connRate = $('#connRate');
    D.sidebar = $('#sidebar');
    D.catalogBody = $('#catalogBody');
    D.search = $('#search');
    D.sigCount = $('#sigCount');
    D.selCount = $('#selCount');
    D.selectedList = $('#selectedList');
    D.legend = $('#legend');
    D.chart = $('#chart');
    D.wrap = $('#canvasWrap');
    D.tip = $('#cursorTip');
    D.empty = $('#emptyHint');
    D.ribbon = $('#stallRibbon');
    D.ribbonText = $('#stallRibbonText');
    D.curVal = $('#curVal');
    D.thrVal = $('#thrVal');
    D.marginVal = $('#marginVal');
    D.curUnit = $('#curUnit');
    D.thrUnit = $('#thrUnit');
    D.marginUnit = $('#marginUnit');
    D.marginBar = $('#marginBar');
    D.curRaw = $('#curRaw');
    D.thrRaw = $('#thrRaw');
    D.mCurrent = $('#mCurrent');
    D.stallCard = $('#stallCard');
    D.stallText = $('#stallText');
    D.stallSub = $('#stallSub');
    D.stallCount = $('#stallCount');
    D.statSamples = $('#statSamples');
    D.statRate = $('#statRate');
    D.statLatency = $('#statLatency');
    D.statRecord = $('#statRecord');
    D.statMsg = $('#statMsg');
    D.drawer = $('#drawer');
    D.drawerBackdrop = $('#drawerBackdrop');
    D.calibList = $('#calibList');
    D.curSel = $('#curSel');
    D.thrSel = $('#thrSel');
    D.catalogMeta = $('#catalogMeta');
    D.toasts = $('#toasts');
    D.logPanel = $('#logPanel');
    D.logText = $('#logText');
    D.btnRecord = $('#btnRecord');
    D.btnPause = $('#btnPause');
    D.btnConnect = $('#btnConnect');
    D.srcHint = $('#srcHint');
    D.rateSel = $('#rateSel');
    D.winSel = $('#winSel');
    D.winSel2 = $('#winSel2');
  }

  // ---------------------------------------------------------------- catalog
  async function loadCatalog() {
    try {
      S.catalog = await fetchJSON('/api/catalog');
    } catch (e) {
      toast('加载信号表失败: ' + e.message, 'err');
      S.catalog = { variables: [], peripherals: [], defaults: [], stall: {}, meta: {} };
    }
    buildIndex();
  }

  function buildIndex() {
    S.index.clear();
    for (const v of S.catalog.variables || []) {
      S.index.set(v.name, {
        ...v, id: v.name, kind: 'var',
        group: v.group || '', bit: v.bit || null,
      });
    }
    for (const p of S.catalog.peripherals || []) {
      for (const r of p.regs || []) {
        const rid = p.name + '.' + r.name;
        S.index.set(rid, {
          id: rid, name: rid, addr: r.addr, size: r.size || 4,
          signed: !!r.signed, bit: null, type: r.type || '',
          kind: 'reg', group: p.name, base: p.base,
        });
        for (const b of r.bits || []) {
          const bid = rid + '.' + b.name;
          S.index.set(bid, {
            id: bid, name: bid, addr: r.addr, size: r.size || 4,
            signed: false, bit: [b.shift, b.width], type: 'bit' + b.width,
            kind: 'bit', group: p.name, base: p.base,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- signals
  function byId(id) { return S.signals.find((s) => s.id === id) || null; }
  function signalIndex(id) { return S.signals.findIndex((s) => s.id === id); }

  function normalizeSignal(d) {
    const bit = Array.isArray(d.bit) ? [Number(d.bit[0]), Number(d.bit[1])] : null;
    return {
      id: String(d.id || d.name || ''),
      name: String(d.name || d.id || ''),
      addr: Number(d.addr) >>> 0,
      size: Number(d.size) || 4,
      signed: !!d.signed,
      bit,
      scale: Number(d.scale ?? 1),
      offset: Number(d.offset ?? 0),
      unit: d.unit !== undefined ? String(d.unit || '') : inferUnit(d.name),
      color: String(d.color || '#22d3ee'),
      step: !!d.step,
      visible: d.visible !== false,
      axis: d.axis === 'right' ? 'right' : d.axis === 'left' ? 'left' : inferAxis(d.name),
      type: String(d.type || ''),
      value: null,
    };
  }

  function inferAxis(name) {
    return /(vol|speed|level|state|power|conts|tick|duty|ccr|arr|batlevel|direction|overlevel)/i.test(String(name || ''))
      ? 'right' : 'left';
  }

  function inferUnit(name) {
    const n = String(name || '');
    if (/(threshold|current|adc\.RES|offset)/i.test(n)) return 'counts';
    if (/(vol|ccr|duty)/i.test(n)) return 'duty';
    if (/speed/i.test(n)) return 'cnt';
    if (/(tick|msTick)/i.test(n)) return 'ms';
    return '';
  }

  function nextColor() {
    const used = new Set(S.signals.map((s) => s.color));
    const palette = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#60a5fa',
      '#fb7185', '#facc15', '#2dd4bf', '#c084fc', '#fb923c', '#4ade80'];
    return palette.find((c) => !used.has(c)) || palette[S.signals.length % palette.length];
  }

  function isStepSignal(entry) {
    return !!entry.bit || /(threshold|state|level|conts|power|overlevel|direction)/i.test(entry.name || '');
  }

  function addSignal(id, opts = {}) {
    const entry = S.index.get(id);
    if (!entry) { toast('找不到信号: ' + id, 'err'); return; }
    const old = byId(id);
    if (old) { flashRow(id); return; }
    if (S.signals.length >= 16) { toast('最多同时显示 16 路', 'err'); return; }
    const sig = normalizeSignal({
      ...entry,
      color: opts.color || nextColor(),
      scale: opts.scale ?? 1,
      offset: opts.offset ?? 0,
      unit: opts.unit !== undefined ? opts.unit : inferUnit(entry.name),
      step: opts.step ?? isStepSignal(entry),
      visible: true,
    });
    S.signals.push(sig);
    afterSignalsChanged();
  }

  function addCustomSignal(addr, size, signed, name) {
    if (!Number.isFinite(addr) || addr < 0) { toast('地址无效', 'err'); return; }
    const id = 'custom.' + hex(addr) + '.' + size;
    const entry = {
      id, name: name || ('@' + hex(addr, 4)), addr, size, signed,
      bit: null, type: signed ? 'int' : 'uint', kind: 'custom', group: '自定义',
    };
    S.index.set(id, entry);
    addSignal(id);
  }

  function removeSignal(id) {
    const i = signalIndex(id);
    if (i < 0) return;
    S.signals.splice(i, 1);
    for (const row of S.samples) {
      if (Array.isArray(row[1]) && i < row[1].length) row[1].splice(i, 1);
    }
    afterSignalsChanged();
  }

  function afterSignalsChanged() {
    renderCatalog();
    renderSelected();
    renderLegend();
    renderStallSelects();
    renderCalib();
    updateEmptyHint();
    saveLocal();
    sendConfig();
    S.dirty = true;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    cacheDom();
    bindUI();
    await loadCatalog();
    await loadStatus();
    restoreConfig();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderStallSelects();
    renderCalib();
    resizeChart();
    updateOverlay();
    connectSSE();
    setTimeout(loadHistory, 900);
    requestAnimationFrame(drawLoop);
    setInterval(tick, 1000);
    setTimeout(() => { if (!S.ui.overlayDismissed) updateOverlay(); }, 400);
  }

  async function loadStatus() {
    try {
      const st = await fetchJSON('/api/status');
      applyStatus(st);
      if (st.config && Array.isArray(st.config.signals) && st.config.signals.length) {
        adoptSignals(st.config.signals, st.config.rate);
      }
    } catch (e) {
      toast('服务未响应: ' + e.message, 'err');
    }
  }

  function restoreConfig() {
    let restored = false;
    try {
      const raw = localStorage.getItem('ms.cfg.v1');
      if (raw) {
        const c = JSON.parse(raw);
        const list = [];
        for (const item of c.signals || []) {
          let entry = S.index.get(item.id);
          if (!entry && item.id.startsWith('custom.') && item.addr !== undefined) {
            entry = {
              id: item.id, name: item.name || item.id,
              addr: Number(item.addr) >>> 0, size: Number(item.size) || 4,
              signed: !!item.signed, bit: null, type: 'custom',
              kind: 'custom', group: '自定义',
            };
            S.index.set(item.id, entry);
          }
          if (!entry) continue;
          list.push(normalizeSignal({ ...entry, ...item }));
        }
        if (list.length) {
          S.signals = list;
          restored = true;
        }
        S.windowSec = Number(c.windowSec) || S.windowSec;
        S.rate = Number(c.rate) || S.rate;
        S.autoZero = !!c.autoZero;
        S.fillOn = c.fillOn !== false;
        S.gridOn = c.gridOn !== false;
        if (c.stall) {
          S.stall.enabled = c.stall.enabled !== false;
          S.stall.autoPause = !!c.stall.autoPause;
          S.stall.currentId = c.stall.currentId || '';
          S.stall.thresholdId = c.stall.thresholdId || '';
        }
      }
    } catch (e) { console.warn(e); }

    if (!restored && S.signals.length) {
      // 没有本地配置: 用服务端当前的通道
      syncToggles();
      return;
    }
    if (!restored) {
      const defaults = S.catalog.defaults || [];
      const names = defaults.length ? defaults : (S.catalog.variables || []).slice(0, 4).map((v) => v.name);
      for (let i = 0; i < names.length; i++) {
        const entry = S.index.get(names[i]);
        if (!entry) continue;
        S.signals.push(normalizeSignal({
          ...entry, color: ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399'][i % 4],
          unit: 'counts', step: isStepSignal(entry),
        }));
      }
    }
    const st = S.catalog.stall || {};
    if (!byId(S.stall.currentId)) S.stall.currentId = st.current || (S.signals[0]?.id || '');
    if (!byId(S.stall.thresholdId)) S.stall.thresholdId = st.threshold || (S.signals[1]?.id || '');
    syncToggles();
    if (S.signals.length) sendConfig(true);
  }

  function syncToggles() {
    if (D.winSel) D.winSel.value = String(S.windowSec);
    if (D.winSel2) D.winSel2.value = String(S.windowSec);
    if (D.rateSel) D.rateSel.value = String(S.rate);
    const az = $('#autoZero'); if (az) az.checked = S.autoZero;
    const fo = $('#fillOn'); if (fo) fo.checked = S.fillOn;
    const go = $('#gridOn'); if (go) go.checked = S.gridOn;
    const se = $('#stallEnable'); if (se) se.checked = S.stall.enabled;
    const ap = $('#autoPause'); if (ap) ap.checked = S.stall.autoPause;
  }

  function saveLocal() {
    try {
      localStorage.setItem('ms.cfg.v1', JSON.stringify({
        signals: S.signals.map((s) => {
          const rec = {
            id: s.id, scale: s.scale, offset: s.offset, unit: s.unit,
            color: s.color, step: s.step, visible: s.visible, axis: s.axis,
          };
          if (s.id.startsWith('custom.')) {
            rec.name = s.name; rec.addr = s.addr; rec.size = s.size; rec.signed = s.signed;
          }
          return rec;
        }),
        rate: S.rate,
        windowSec: S.windowSec,
        autoZero: S.autoZero,
        fillOn: S.fillOn,
        gridOn: S.gridOn,
        stall: {
          enabled: S.stall.enabled,
          autoPause: S.stall.autoPause,
          currentId: S.stall.currentId,
          thresholdId: S.stall.thresholdId,
        },
      }));
    } catch {}
  }

  function adoptSignals(list, rate) {
    S.signals = (list || []).filter((x) => x && x.id).map(normalizeSignal);
    S.samples = [];
    S.lastT = 0;
    resetStall();
    if (rate) S.rate = Number(rate) || S.rate;
    const st = S.catalog.stall || {};
    if (!byId(S.stall.currentId)) S.stall.currentId = st.current || (S.signals[0]?.id || '');
    if (!byId(S.stall.thresholdId)) S.stall.thresholdId = st.threshold || (S.signals[1]?.id || '');
    syncToggles();
  }

  function sendConfig(force = false) {
    S.configDirty = true;
    if (S.configTimer) clearTimeout(S.configTimer);
    const run = async () => {
      S.configTimer = 0;
      if (!S.configDirty && !force) return;
      S.configDirty = false;
      const payload = {
        rate: S.rate,
        signals: S.signals.map((s) => ({
          id: s.id, name: s.name, addr: s.addr, size: s.size, signed: s.signed,
          bit: s.bit, scale: s.scale, offset: s.offset, unit: s.unit,
          color: s.color, step: s.step, visible: s.visible,
        })),
      };
      try {
        await post('/api/config', payload);
      } catch (e) {
        toast('配置下发失败: ' + e.message, 'err');
      }
    };
    if (force) return run();
    S.configTimer = setTimeout(run, 120);
  }

  // ---------------------------------------------------------------- SSE
  function connectSSE() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/stream');
    S.es = es;
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        applyStatus(msg.status);
        if (!S.signals.length && msg.config?.signals?.length) {
          adoptSignals(msg.config.signals, msg.config.rate);
          renderSelected(); renderLegend(); renderStallSelects(); renderCalib();
          saveLocal();
          loadHistory();
        } else if (S.signals.length) {
          // 服务重启/重连后把页面的通道和频率重新下发, 否则服务端会退回默认配置
          sendConfig(true).then(loadHistory);
        } else {
          loadHistory();
        }
      } else if (msg.type === 'status') {
        applyStatus(msg.status);
      } else if (msg.type === 's') {
        onSamples(msg.b || []);
      }
    };
    es.onerror = () => {
      D.connPill.classList.add('warn');
      if (!S.toastKeys.has('sse')) {
        S.toastKeys.add('sse');
        toast('实时连接中断，正在重连…', 'err');
        setTimeout(() => S.toastKeys.delete('sse'), 8000);
      }
    };
  }

  async function loadHistory() {
    try {
      const r = await fetchJSON('/api/history?seconds=60');
      if (r && Array.isArray(r.samples) && r.samples.length) mergeHistory(r.samples);
    } catch {}
  }

  function mergeHistory(list) {
    const map = new Map();
    for (const s of S.samples) map.set(s[0], s);
    for (const s of list) {
      if (!Array.isArray(s) || s.length < 2) continue;
      if (!map.has(s[0])) map.set(s[0], [Number(s[0]), s[1] || []]);
    }
    const arr = Array.from(map.values()).sort((a, b) => a[0] - b[0]);
    S.samples = arr;
    if (arr.length) S.lastT = Math.max(S.lastT, arr[arr.length - 1][0]);
    resetStall();
    for (const [t, vals] of arr) detectStall(t, vals, true);
    pruneSamples();
    S.dirty = true;
    refreshLiveValues();
    updateStallUI(S.lastT);
  }

  function onSamples(batch) {
    if (!batch.length) return;
    const n = S.signals.length;
    for (const item of batch) {
      const t = Number(item[0]);
      const vals = item[1] || [];
      if (!isFinite(t)) continue;
      S.samples.push([t, vals]);
      S.lastT = t;
      detectStall(t, vals);
    }
    S.sampleCountSeen += batch.length;
    pruneSamples();
    S.dirty = true;
    refreshLiveValues();
  }

  function pruneSamples() {
    const keep = Math.max(120000, S.windowSec * 1000 + 30000);
    const cutoff = S.lastT - keep;
    let i = 0;
    while (i < S.samples.length && S.samples[i][0] < cutoff) i++;
    if (i > 0) S.samples.splice(0, i);
    if (S.samples.length > 200000) S.samples.splice(0, S.samples.length - 200000);
  }

  function latestSample() {
    return S.samples.length ? S.samples[S.samples.length - 1] : null;
  }

  function refreshLiveValues() {
    const last = latestSample();
    if (!last) return;
    const vals = last[1];
    const sigs = S.signals;
    const cur = byId(S.stall.currentId);
    const thr = byId(S.stall.thresholdId);
    const ci = cur ? sigs.indexOf(cur) : -1;
    const ti = thr ? sigs.indexOf(thr) : -1;
    if (cur && ci >= 0 && ci < vals.length) {
      const v = vals[ci] * cur.scale + cur.offset;
      D.curVal.textContent = fmtValue(cur, vals[ci]);
      D.curUnit.textContent = cur.unit || '';
      D.curRaw.textContent = cur.name;
      D.curRaw.title = hex(cur.addr) + ' · ' + cur.name;
    }
    if (thr && ti >= 0 && ti < vals.length) {
      D.thrVal.textContent = fmtValue(thr, vals[ti]);
      D.thrUnit.textContent = thr.unit || '';
      D.thrRaw.textContent = thr.name;
      D.thrRaw.title = hex(thr.addr) + ' · ' + thr.name;
    }
    if (cur && thr && ci >= 0 && ti >= 0 && ci < vals.length && ti < vals.length) {
      const cv = vals[ci] * cur.scale + cur.offset;
      const tv = vals[ti] * thr.scale + thr.offset;
      const margin = tv - cv;
      D.marginVal.textContent = fmtInt(margin);
      D.marginUnit.textContent = cur.unit || '';
      const pct = tv > 0 ? clamp((cv / tv) * 100, 0, 100) : 0;
      D.marginBar.style.width = pct.toFixed(1) + '%';
    }
    // 已选列表 / 图例 / 目录里的选中行
    for (const sig of sigs) {
      const i = sigs.indexOf(sig);
      if (i < 0 || i >= vals.length) continue;
      const txt = fmtValue(sig, vals[i]);
      const row = S.selRows.get(sig.id);
      if (row) {
        const el = row.querySelector('.sel-val');
        if (el) el.textContent = txt;
      }
      const chip = S.legendEls.get(sig.id);
      if (chip) {
        const el = chip.querySelector('.lval');
        if (el) el.textContent = txt;
      }
      const live = S.liveRows.get(sig.id);
      if (live) live.textContent = txt;
    }
    updateStallUI(last[0]);
  }

  function updateStallUI(t) {
    const st = S.stall;
    const active = st.enabled && st.active;
    D.stallCard.classList.toggle('danger', active);
    D.mCurrent.classList.toggle('danger', active);
    D.ribbon.classList.toggle('hidden', !active);
    if (active) {
      const dur = Math.max(0, t - st.since) / 1000;
      D.stallText.textContent = '堵转判定';
      D.stallSub.textContent = '电流 ≥ 阈值 · 持续 ' + dur.toFixed(1) + ' s';
      D.ribbonText.textContent = '电流 ≥ 阈值 · ' + dur.toFixed(1) + ' s';
    } else {
      D.stallText.textContent = '安全';
      const last = latestSample();
      let marginTxt = '未达到堵转阈值';
      if (last) {
        const cur = byId(st.currentId), thr = byId(st.thresholdId);
        const ci = cur ? S.signals.indexOf(cur) : -1;
        const ti = thr ? S.signals.indexOf(thr) : -1;
        if (ci >= 0 && ti >= 0 && ci < last[1].length && ti < last[1].length) {
          const cv = last[1][ci] * cur.scale + cur.offset;
          const tv = last[1][ti] * thr.scale + thr.offset;
          marginTxt = '余量 ' + fmtInt(tv - cv) + (cur.unit ? ' ' + cur.unit : '');
          if (st.lastDuration > 0) marginTxt += ' · 上次 ' + (st.lastDuration / 1000).toFixed(1) + ' s';
        }
      }
      D.stallSub.textContent = marginTxt;
    }
    D.stallCount.textContent = st.count + ' 次';
  }

  function detectStall(t, vals, replay = false) {
    const st = S.stall;
    if (!st.enabled) return;
    const cur = byId(st.currentId);
    const thr = byId(st.thresholdId);
    if (!cur || !thr) return;
    const ci = S.signals.indexOf(cur);
    const ti = S.signals.indexOf(thr);
    if (ci < 0 || ti < 0 || ci >= vals.length || ti >= vals.length) return;
    const cv = vals[ci] * cur.scale + cur.offset;
    const tv = vals[ti] * thr.scale + thr.offset;
    const above = tv > 0 && cv >= tv;
    if (above && !st.active) {
      // 电流在阈值附近抖会切出很多 0.1s 的假事件; 600ms 内的间隔并成一次
      const prev = st.events[st.events.length - 1];
      const merge = prev && prev.end != null && (t - prev.end) < 600;
      st.active = true;
      st.since = merge ? prev.t : t;
      if (merge) {
        prev.end = null;
      } else {
        st.count += 1;
        st.events.push({ t, end: null });
        if (st.events.length > 500) st.events.shift();
      }
      if (!replay && st.autoPause && !S.paused) {
        S.paused = true;
        S.pauseAt = t;
        updatePauseUI();
      }
    } else if (!above && st.active) {
      st.active = false;
      st.lastDuration = t - st.since;
      const ev = st.events[st.events.length - 1];
      if (ev && ev.end === null) ev.end = t;
    }
  }

  function resetStall() {
    S.stall.active = false;
    S.stall.since = 0;
    S.stall.count = 0;
    S.stall.lastDuration = 0;
    S.stall.events = [];
  }

  function applyStatus(st) {
    if (!st) return;
    S.status = st;
    const up = Number(st.uptime) || 0;
    if (S.serverUptime > 0 && up + 1 < S.serverUptime) {
      // 服务重启: 时间轴/游标全部作废, 清掉旧样本再重新拉
      S.samples = [];
      S.lastT = 0;
      S.pauseAt = 0;
      S.paused = false;
      S.hoverT = null;
      resetStall();
      updatePauseUI();
      updateStallUI(0);
      S.dirty = true;
    }
    S.serverUptime = up;
    S.source = st.source || { kind: 'none', connected: false };
    S.sampler = st.sampler || {};
    S.record = st.record || {};
    S.lastStatusAt = Date.now();
    const kind = S.source.kind || 'none';
    const connected = sourceConnected(S.source) && !S.sampler.error;
    const label = kind === 'openocd' ? 'OpenOCD' : kind === 'attach' ? 'TCL' : kind === 'sim' ? '仿真' : '未连接';
    D.connText.textContent = label;
    D.connRate.textContent = (S.sampler.rate_actual || S.sampler.rate || 0).toFixed(0) + ' Hz';
    D.connPill.classList.toggle('on', !!connected);
    D.connPill.classList.toggle('warn', !connected || !!S.sampler.error);
    D.statSamples.textContent = fmtInt(S.sampler.samples || 0);
    D.statRate.textContent = (S.sampler.rate_actual || 0).toFixed(1) + ' Hz';
    const lat = st.uptime != null && S.sampler.last_t ? Math.max(0, st.uptime * 1000 - S.sampler.last_t) : null;
    D.statLatency.textContent = lat === null ? '--' : (lat < 1000 ? Math.round(lat) + ' ms' : (lat / 1000).toFixed(1) + ' s');
    D.statRecord.textContent = S.record.active ? ((S.record.count || 0).toLocaleString('en-US') + ' 点') : '关';
    D.btnRecord.classList.toggle('active', !!S.record.active);
    let msg = '运行中';
    if (S.sampler.error) msg = S.sampler.error;
    else if (S.source.kind === 'none') msg = st.connect_error || '等待连接';
    else if (!connected) msg = '连接已断开';
    else if (S.paused) msg = '已暂停（数据仍在后台缓存）';
    D.statMsg.textContent = msg;
    D.statMsg.classList.toggle('muted', !S.sampler.error);
    if (st.catalog?.meta && D.catalogMeta) {
      const m = st.catalog.meta;
      D.catalogMeta.textContent = 'AXF ' + (m.generated_at || '?') + ' · ' +
        (st.catalog.counts?.variables || 0) + ' 变量 / ' +
        (st.catalog.counts?.peripherals || 0) + ' 外设 · ' + (m.axf || '');
    }
    if (S.source.kind === 'none' && st.connect_error && !S.errors.has(st.connect_error)) {
      S.errors.add(st.connect_error);
      toast('连接失败: ' + st.connect_error, 'err');
    }
    updateOverlay();
    if (!S.signals.length && st.config?.signals?.length && !S.ui.connecting) {
      adoptSignals(st.config.signals, st.config.rate);
      renderSelected(); renderLegend(); renderStallSelects(); renderCalib();
    }
  }

  function sourceConnected(src) {
    if (!src) return false;
    if (src.kind === 'sim') return true;
    if (src.kind === 'openocd') return !!src.running && src.connected !== false;
    if (src.kind === 'attach') return src.connected !== false;
    return false;
  }

  function tick() {
    updateOverlay();
    if (S.ui.log) refreshLog();
  }

  // ---------------------------------------------------------------- overlay
  function updateOverlay() {
    const src = S.status?.source;
    const connected = sourceConnected(src);
    const shouldShow = !connected && !S.ui.overlayDismissed && !S.ui.connecting && !S.ui.drawer;
    D.overlay.classList.toggle('hidden', !shouldShow);
    if (S.ui.connecting) {
      D.overlayHint.textContent = '正在启动 OpenOCD 并读 CPUID 握手…';
    } else if (S.status?.connect_error) {
      D.overlayHint.textContent = S.status.connect_error;
    } else {
      D.overlayHint.textContent = '将自动寻找 tools/openocd，启动 tcl_port 并读 CPUID 握手。';
    }
  }

  async function doConnect(mode) {
    const payload = { mode };
    if (mode === 'openocd') {
      const p = ($('#inpOcd')?.value || '').trim();
      if (p) payload.openocd = p;
    } else if (mode === 'attach') {
      payload.host = ($('#inpAttachHost')?.value || '127.0.0.1').trim();
      payload.port = Number($('#inpAttachPort')?.value || 6666);
    }
    S.ui.connecting = true;
    S.ui.overlayDismissed = true;
    D.btnConnect.disabled = true;
    const label = D.btnConnect.querySelector('span');
    const old = label ? label.textContent : '';
    if (label) label.textContent = '连接中';
    updateOverlay();
    try {
      const res = await post('/api/connect', payload, { timeout: 30000 });
      if (!res.ok) throw new Error(res.error || '连接失败');
      toast('已连接: ' + (mode === 'sim' ? '仿真' : mode === 'attach' ? 'TCL' : 'OpenOCD'), 'ok');
      await sendConfig(true);
      await refreshStatus();
    } catch (e) {
      toast('连接失败: ' + e.message, 'err');
      openLog();
    } finally {
      S.ui.connecting = false;
      D.btnConnect.disabled = false;
      if (label) label.textContent = old || '连接';
      updateOverlay();
      refreshStatus();
    }
  }

  async function refreshStatus() {
    try {
      const st = await fetchJSON('/api/status');
      applyStatus(st);
    } catch {}
  }

  // ---------------------------------------------------------------- catalog UI
  function renderCatalog() {
    const body = D.catalogBody;
    if (!body) return;
    S.liveRows.clear();
    const tab = S.ui.tab;
    const q = S.ui.search.trim().toLowerCase();
    D.sigCount.textContent = String(S.signals.length);
    D.selCount.textContent = String(S.signals.length);
    D.search.placeholder = tab === 'periph' ? '搜索外设 / 寄存器 / 位' : tab === 'custom' ? '自定义地址' : '搜索变量 / 寄存器 / 地址';
    if (tab === 'vars') renderVars(body, q);
    else if (tab === 'periph') renderPeriph(body, q);
    else renderCustom(body);
  }

  function matchText(parts, q) {
    if (!q) return true;
    return parts.some((p) => String(p || '').toLowerCase().includes(q));
  }

  function renderVars(body, q) {
    const vars = S.catalog.variables || [];
    const groups = new Map();
    for (const v of vars) {
      if (q && !matchText([v.name, v.group, hex(v.addr), v.type], q)) continue;
      let g = v.group || '全局';
      if (g === v.name) g = '全局';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(v);
    }
    if (!groups.size) {
      body.innerHTML = '<div class="cat-empty muted">没有匹配的变量</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    const priority = { motor: 0, adc: 1, sys: 2, '全局': 99 };
    const ordered = Array.from(groups.entries()).sort((a, b) => {
      const pa = priority[a[0]] ?? 10, pb = priority[b[0]] ?? 10;
      if (pa !== pb) return pa - pb;
      const ga = a[1][0].addr >>> 0, gb = b[1][0].addr >>> 0;
      return ga - gb;
    });
    let shown = 0;
    for (const [g, list] of ordered) {
      const open = !!q || S.ui.openGroups.has(g);
      const box = document.createElement('div');
      box.className = 'cat-group' + (open ? ' open' : '');
      const head = document.createElement('div');
      head.className = 'cat-group-head';
      head.dataset.group = g;
      head.innerHTML = '<span class="arrow">▶</span><span class="gname"></span><span class="gcount"></span>';
      head.querySelector('.gname').textContent = g;
      head.querySelector('.gcount').textContent = list.length + ' 项 · ' + hex(list[0].addr, 6);
      box.appendChild(head);
      const inner = document.createElement('div');
      inner.className = 'cat-group-body';
      for (const v of list) {
        if (shown++ > 600) break;
        inner.appendChild(sigRow(v, 'var'));
      }
      box.appendChild(inner);
      frag.appendChild(box);
      if (shown > 600) break;
    }
    body.innerHTML = '';
    body.appendChild(frag);
  }

  function sigRow(entry, kind, opts = {}) {
    const row = document.createElement('div');
    const eid = entry.id || entry.name;
    const selected = !!byId(eid);
    row.className = 'sig-row' + (selected ? ' selected' : '');
    row.dataset.id = eid;
    row.dataset.kind = kind;
    if (opts.bit) row.classList.add('bit-row');
    if (opts.reg) row.classList.add('reg-row');
    const check = document.createElement('span');
    check.className = 'sig-check';
    check.textContent = selected ? '✓' : '';
    const main = document.createElement('div');
    main.className = 'sig-main';
    if (opts.reg && opts.hasBits) {
      const t = document.createElement('button');
      t.className = 'reg-toggle';
      t.dataset.regToggle = eid;
      t.textContent = S.ui.openRegs.has(entry.id) ? '−' : '+';
      t.title = '展开位域';
      main.appendChild(t);
    }
    const name = document.createElement('span');
    name.className = 'sig-name';
    if (entry.bit) {
      name.innerHTML = esc(entry.name) + ' <span class="bit">[' +
        (entry.bit[1] > 1 ? (entry.bit[0] + ':' + (entry.bit[0] + entry.bit[1] - 1)) : entry.bit[0]) + ']</span>';
    } else {
      name.textContent = entry.name;
    }
    name.title = entry.name + '\n' + hex(entry.addr) + ' · ' + (entry.size * 8) + ' bit ' + (entry.signed ? 'signed' : 'unsigned');
    main.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'sig-meta';
    meta.textContent = hex(entry.addr) + ' · ' + (entry.type || (entry.size * 8 + 'b'));
    main.appendChild(meta);
    const val = document.createElement('span');
    val.className = 'sig-val';
    val.textContent = '—';
    row.appendChild(check);
    row.appendChild(main);
    row.appendChild(val);
    if (selected) S.liveRows.set(eid, val);
    return row;
  }

  function renderPeriph(body, q) {
    const list = S.catalog.peripherals || [];
    const frag = document.createDocumentFragment();
    let any = false;
    for (const p of list) {
      const regs = [];
      for (const r of p.regs || []) {
        const rid = p.name + '.' + r.name;
        const bits = r.bits || [];
        if (q) {
          const hitReg = matchText([rid, p.name, hex(r.addr)], q);
          const hitBits = bits.filter((b) => matchText([rid + '.' + b.name, b.name], q));
          if (!hitReg && !hitBits.length) continue;
          regs.push({ ...r, _bits: hitReg ? bits : hitBits, _autoOpen: hitBits.length > 0 && !hitReg });
        } else {
          regs.push({ ...r, _bits: bits, _autoOpen: false });
        }
      }
      if (!regs.length) continue;
      any = true;
      const open = !!q || S.ui.openPeriph.has(p.name);
      const box = document.createElement('div');
      box.className = 'cat-group' + (open ? ' open' : '');
      const head = document.createElement('div');
      head.className = 'periph-head';
      head.dataset.periph = p.name;
      head.innerHTML = '<span class="arrow">▶</span><span class="pname"></span><span class="pbase"></span>';
      head.querySelector('.pname').textContent = p.name;
      head.querySelector('.pbase').textContent = hex(p.base, 8);
      box.appendChild(head);
      const inner = document.createElement('div');
      inner.className = 'cat-group-body';
      for (const r of regs) {
        const rid = p.name + '.' + r.name;
        const hasBits = (r._bits || []).length > 0;
        const regOpen = !!q || S.ui.openRegs.has(rid) || r._autoOpen;
        const block = document.createElement('div');
        block.className = 'reg-block' + (regOpen ? ' open' : '');
        block.dataset.reg = rid;
        const entry = {
          id: rid, name: rid, addr: r.addr, size: r.size || 4,
          signed: !!r.signed, bit: null, type: r.type || '', group: p.name,
        };
        const row = sigRow(entry, 'reg', { reg: true, hasBits });
        block.appendChild(row);
        if (hasBits) {
          const bitsBox = document.createElement('div');
          bitsBox.className = 'bit-list';
          for (const b of r._bits) {
            const bid = rid + '.' + b.name;
            const bentry = {
              id: bid, name: bid, addr: r.addr, size: r.size || 4,
              signed: false, bit: [b.shift, b.width], type: 'bit' + b.width, group: p.name,
            };
            bitsBox.appendChild(sigRow(bentry, 'bit', { bit: true }));
          }
          block.appendChild(bitsBox);
        }
        inner.appendChild(block);
      }
      box.appendChild(inner);
      frag.appendChild(box);
    }
    body.innerHTML = '';
    if (!any) {
      body.innerHTML = '<div class="cat-empty muted">没有匹配的寄存器</div>';
    } else {
      body.appendChild(frag);
    }
  }

  function renderCustom(body) {
    body.innerHTML = '';
    const form = document.createElement('div');
    form.className = 'custom-form';
    form.innerHTML =
      '<div class="field"><label>地址 (hex / dec)</label><input id="custAddr" placeholder="0x20000352"></div>' +
      '<div class="row2"><div class="field"><label>长度</label><select id="custSize">' +
      '<option value="1">8 bit</option><option value="2" selected>16 bit</option><option value="4">32 bit</option>' +
      '</select></div><div class="field"><label>类型</label><select id="custSigned">' +
      '<option value="0">无符号</option><option value="1">有符号</option></select></div></div>' +
      '<div class="field"><label>名称（可选）</label><input id="custName" placeholder="自定义信号"></div>' +
      '<button id="custAdd" class="btn primary">添加到波形</button>';
    body.appendChild(form);
    const list = S.signals.filter((s) => s.id.startsWith('custom.'));
    if (list.length) {
      const head = document.createElement('div');
      head.className = 'side-title';
      head.style.margin = '14px 0 4px';
      head.textContent = '自定义信号';
      body.appendChild(head);
      for (const s of list) {
        const row = document.createElement('div');
        row.className = 'sig-row selected';
        row.innerHTML = '<span class="sig-check">✓</span><div class="sig-main"><span class="sig-name"></span><div class="sig-meta"></div></div><span class="sig-val">—</span>';
        row.querySelector('.sig-name').textContent = s.name;
        row.querySelector('.sig-meta').textContent = hex(s.addr) + ' · ' + (s.size * 8) + 'b';
        row.addEventListener('click', () => removeSignal(s.id));
        body.appendChild(row);
      }
    }
    $('#custAdd')?.addEventListener('click', () => {
      const raw = ($('#custAddr')?.value || '').trim();
      if (!raw) return;
      const addr = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
      const size = Number($('#custSize')?.value || 2);
      const signed = $('#custSigned')?.value === '1';
      const name = ($('#custName')?.value || '').trim();
      addCustomSignal(addr, size, signed, name);
      renderCustom(body);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function flashRow(id) {
    renderSelected();
  }

  // ---------------------------------------------------------------- selected / legend
  function renderSelected() {
    const box = D.selectedList;
    if (!box) return;
    box.innerHTML = '';
    S.selRows.clear();
    if (!S.signals.length) {
      box.innerHTML = '<div class="cat-empty muted">勾选左侧信号加入波形</div>';
      return;
    }
    for (const sig of S.signals) {
      const row = document.createElement('div');
      row.className = 'sel-row';
      row.dataset.id = sig.id;
      row.innerHTML = '<span class="dot"></span><span class="sel-name"></span><span class="sel-val">—</span><button class="sel-x" title="移除">×</button>';
      row.querySelector('.dot').style.background = sig.color;
      row.querySelector('.dot').style.color = sig.color;
      row.querySelector('.sel-name').textContent = sig.name;
      row.querySelector('.sel-name').title = hex(sig.addr) + ' · ' + sig.name;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.sel-x')) {
          e.stopPropagation();
          removeSignal(sig.id);
        } else {
          openDrawer();
          setTimeout(() => {
            const inp = document.querySelector('.calib-row[data-id="' + CSS.escape(sig.id) + '"] input');
            if (inp) inp.focus();
          }, 80);
        }
      });
      box.appendChild(row);
      S.selRows.set(sig.id, row);
    }
    if (S.samples.length) refreshLiveValues();
    updateEmptyHint();
  }

  function renderLegend() {
    const box = D.legend;
    if (!box) return;
    box.innerHTML = '';
    S.legendEls.clear();
    for (const sig of S.signals) {
      const chip = document.createElement('div');
      chip.className = 'legend-chip' + (sig.visible ? '' : ' off');
      chip.dataset.id = sig.id;
      chip.title = sig.name + ' · ' + hex(sig.addr) + ' · ' + (sig.unit || '') + (sig.step ? ' · step' : '');
      chip.innerHTML = '<span class="dot"></span><span class="lname"></span><span class="lax"></span><span class="lval">—</span>';
      chip.querySelector('.dot').style.background = sig.color;
      chip.querySelector('.dot').style.color = sig.color;
      chip.querySelector('.lname').textContent = shortName(sig.name);
      if (sig.axis === 'right') chip.querySelector('.lax').textContent = 'R';
      chip.addEventListener('click', () => {
        sig.visible = !sig.visible;
        chip.classList.toggle('off', !sig.visible);
        saveLocal();
        S.dirty = true;
      });
      box.appendChild(chip);
      S.legendEls.set(sig.id, chip);
    }
    if (S.samples.length) refreshLiveValues();
  }

  function updateEmptyHint() {
    const has = S.signals.length > 0;
    D.empty.classList.toggle('hidden', has);
    D.empty.querySelector('div').textContent = has ? '' : '还没有信号';
  }

  // ---------------------------------------------------------------- stall selects / calibration
  function renderStallSelects() {
    for (const [el, current] of [[D.curSel, S.stall.currentId], [D.thrSel, S.stall.thresholdId]]) {
      if (!el) continue;
      el.innerHTML = '';
      if (!S.signals.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '（先添加信号）';
        el.appendChild(o);
        continue;
      }
      for (const s of S.signals) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        el.appendChild(o);
      }
      const want = current || S.signals[0].id;
      el.value = want;
      if (el.value !== want) {
        if (el === D.curSel) S.stall.currentId = el.value;
        else S.stall.thresholdId = el.value;
      }
    }
  }

  function renderCalib() {
    const box = D.calibList;
    if (!box) return;
    box.innerHTML = '';
    if (!S.signals.length) {
      box.innerHTML = '<div class="muted" style="font-size:10.5px">先添加信号</div>';
      return;
    }
    for (const sig of S.signals) {
      const row = document.createElement('div');
      row.className = 'calib-row';
      row.dataset.id = sig.id;
      row.innerHTML = '<span class="cname"></span><input class="scale" type="number" step="0.001" title="缩放"><input class="offset" type="number" step="0.001" title="偏移"><input class="unit" type="text" title="单位"><select class="axis" title="左轴 / 右轴"><option value="left">L</option><option value="right">R</option></select>';
      row.querySelector('.cname').textContent = sig.name;
      row.querySelector('.cname').title = hex(sig.addr) + ' · ' + sig.name;
      const sc = row.querySelector('.scale');
      const of = row.querySelector('.offset');
      const un = row.querySelector('.unit');
      const ax = row.querySelector('.axis');
      sc.value = String(sig.scale);
      of.value = String(sig.offset);
      un.value = sig.unit || '';
      ax.value = sig.axis || 'left';
      const commit = () => {
        sig.scale = Number(sc.value) || 0;
        sig.offset = Number(of.value) || 0;
        sig.unit = un.value.trim();
        sig.axis = ax.value === 'right' ? 'right' : 'left';
        saveLocal();
        sendConfig();
        S.dirty = true;
        refreshLiveValues();
      };
      sc.addEventListener('change', commit);
      of.addEventListener('change', commit);
      un.addEventListener('change', commit);
      ax.addEventListener('change', commit);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- chart
  function resizeChart() {
    const cv = D.chart;
    if (!cv) return;
    const rect = cv.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.size = { w, h };
    S.dirty = true;
  }

  function drawLoop() {
    if (S.dirty) {
      S.dirty = false;
      try { draw(); } catch (e) { console.error(e); }
    }
    requestAnimationFrame(drawLoop);
  }

  function sampleRange(t0, t1) {
    const a = S.samples;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] < t0) lo = mid + 1; else hi = mid;
    }
    const start = lo;
    lo = start; hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] <= t1) lo = mid + 1; else hi = mid;
    }
    return [start, lo];
  }

  function draw() {
    const cv = D.chart;
    const ctx = cv.getContext('2d');
    const W = S.size.w, H = S.size.h;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const vis = S.signals.filter((s) => s.visible);
    const anyRight = vis.some((s) => s.axis === 'right');
    const pad = { l: 58, r: anyRight ? 56 : 16, t: 16, b: 36 };
    const x0 = pad.l, y0 = pad.t;
    const pw = Math.max(10, W - pad.l - pad.r);
    const ph = Math.max(10, H - pad.t - pad.b);
    const end = S.paused ? (S.pauseAt || S.lastT) : S.lastT;
    const start = end - S.windowSec * 1000;

    const range = sampleRange(start, end);
    const indices = [];
    for (let i = range[0]; i < range[1]; i++) indices.push(i);

    const leftSigs = vis.filter((s) => s.axis !== 'right');
    const rightSigs = vis.filter((s) => s.axis === 'right');
    const axisRange = (list) => {
      let mn = Infinity, mx = -Infinity, dmin = Infinity;
      for (const sig of list) {
        const idx = S.signals.indexOf(sig);
        for (const i of indices) {
          const v = S.samples[i][1][idx];
          if (v === undefined) continue;
          const tv = v * sig.scale + sig.offset;
          if (!isFinite(tv)) continue;
          if (tv < mn) mn = tv;
          if (tv < dmin) dmin = tv;
          if (tv > mx) mx = tv;
        }
      }
      if (!isFinite(mn)) return null;
      // 常量信号 (例如 vol 恒为 1050) 如果只按 0 跨度加 1, 右轴会出现
      // 1,049/1,050/1,051 这种没信息量的刻度; 给一个最小可见跨度.
      const mid = (mx + mn) / 2;
      const minSpan = Math.max(2, Math.abs(mid) * 0.10);
      if (mx - mn < minSpan) { mn = mid - minSpan / 2; mx = mid + minSpan / 2; }
      const p = (mx - mn) * 0.08;
      mn -= p; mx += p;
      if (S.autoZero) mn = Math.min(0, mn);
      else if (dmin >= 0 && mn < 0) mn = Math.max(0, mn);
      return { min: mn, max: mx };
    };
    let left = axisRange(leftSigs) || { min: 0, max: 1 };
    let right = axisRange(rightSigs) || { min: 0, max: 1 };
    const labelLeft = leftSigs.length ? left : right;
    S.view = { x0, y0, pw, ph, start, end, left, right, anyRight };

    const X = (t) => x0 + ((t - start) / Math.max(1, end - start)) * pw;
    const YL = (v) => y0 + ph - ((v - labelLeft.min) / Math.max(1e-9, labelLeft.max - labelLeft.min)) * ph;
    const YR = (v) => y0 + ph - ((v - right.min) / Math.max(1e-9, right.max - right.min)) * ph;
    const yFor = (sig, v) => (sig.axis === 'right' ? YR(v) : YL(v));

    // background
    const bg = ctx.createLinearGradient(0, y0, 0, y0 + ph);
    bg.addColorStop(0, 'rgba(14,24,42,.45)');
    bg.addColorStop(1, 'rgba(7,12,23,.2)');
    ctx.fillStyle = bg;
    ctx.fillRect(x0, y0, pw, ph);

    // grid lines (labels always on, grid optional)
    {
      ctx.strokeStyle = 'rgba(120,150,190,.10)';
      ctx.lineWidth = 1;
      ctx.font = '9.5px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      ctx.fillStyle = 'rgba(127,147,173,.75)';
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const ratio = i / ticks;
        const v = labelLeft.min + (labelLeft.max - labelLeft.min) * ratio;
        const y = Math.round(y0 + ph - ratio * ph) + 0.5;
        if (S.gridOn) {
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + pw, y); ctx.stroke();
        }
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtAxis(v), x0 - 9, y);
        if (anyRight) {
          const rv = right.min + (right.max - right.min) * ratio;
          ctx.textAlign = 'left';
          ctx.fillStyle = 'rgba(127,147,173,.55)';
          ctx.fillText(fmtAxis(rv), x0 + pw + 9, y);
          ctx.fillStyle = 'rgba(127,147,173,.75)';
        }
      }
      const xt = 5;
      for (let i = 0; i <= xt; i++) {
        const x = Math.round(x0 + pw * i / xt) + 0.5;
        if (S.gridOn) {
          ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph); ctx.stroke();
        }
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const t = start + (end - start) * i / xt;
        const rel = (t - end) / 1000;
        ctx.fillText((rel >= -0.05 ? '0' : rel.toFixed(0)) + 's', x, y0 + ph + 8);
      }
    }
    // axes
    ctx.strokeStyle = 'rgba(120,150,190,.22)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0); ctx.lineTo(x0 + 0.5, y0 + ph + 0.5); ctx.lineTo(x0 + pw, y0 + ph + 0.5);
    if (anyRight) { ctx.moveTo(x0 + pw + 0.5, y0); ctx.lineTo(x0 + pw + 0.5, y0 + ph); }
    ctx.stroke();

    const cur = byId(S.stall.currentId);
    // stall bands (使用合并后的事件, 与 "N 次" 计数一致)
    if (S.stall.enabled && S.stall.events.length) {
      for (const ev of S.stall.events) {
        const evEnd = ev.end == null ? end : ev.end;
        if (evEnd < start || ev.t > end) continue;
        const xa = X(Math.max(ev.t, start));
        const xb = X(Math.min(evEnd, end));
        ctx.fillStyle = 'rgba(251,77,103,.075)';
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), ph);
        ctx.fillStyle = 'rgba(251,77,103,.55)';
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), 2);
      }
    }

    // fills (primary current only)
    if (S.fillOn && cur) {
      const sig = cur;
      const idx = S.signals.indexOf(sig);
      if (vis.includes(sig) && indices.length > 1) {
        ctx.beginPath();
        let started = false;
        for (const i of indices) {
          const vals = S.samples[i][1];
          if (vals[idx] === undefined) continue;
          const x = X(S.samples[i][0]);
          const y = yFor(sig, vals[idx] * sig.scale + sig.offset);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        if (started) {
          const lastX = X(S.samples[indices[indices.length - 1]][0]);
          ctx.lineTo(lastX, y0 + ph);
          ctx.lineTo(X(S.samples[indices[0]][0]), y0 + ph);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, y0, 0, y0 + ph);
          g.addColorStop(0, hexAlpha(sig.color, .14));
          g.addColorStop(1, hexAlpha(sig.color, 0));
          ctx.fillStyle = g;
          ctx.fill();
        }
      }
    }

    // traces
    for (const sig of vis) {
      const idx = S.signals.indexOf(sig);
      const isThr = sig.id === S.stall.thresholdId || /threshold/i.test(sig.name);
      const isCur = sig.id === S.stall.currentId;
      ctx.beginPath();
      let started = false, prevX = 0, prevY = 0;
      for (const i of indices) {
        const vals = S.samples[i][1];
        if (vals[idx] === undefined) continue;
        const x = X(S.samples[i][0]);
        const y = yFor(sig, vals[idx] * sig.scale + sig.offset);
        if (!started) {
          ctx.moveTo(x, y); started = true;
        } else if (sig.step) {
          ctx.lineTo(x, prevY);
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevX = x; prevY = y;
      }
      if (!started) continue;
      ctx.lineWidth = isThr ? 1.3 : (isCur ? 2 : 1.6);
      ctx.strokeStyle = sig.color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (isThr) {
        ctx.setLineDash([6, 4]);
      } else {
        ctx.setLineDash([]);
      }
      if (isCur) {
        ctx.save();
        ctx.shadowColor = hexAlpha(sig.color, .55);
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // stall markers at top
    if (S.stall.enabled) {
      for (const ev of S.stall.events) {
        if (ev.t < start) continue;
        const x = X(ev.t);
        ctx.fillStyle = 'rgba(251,77,103,.9)';
        ctx.beginPath();
        ctx.moveTo(x, y0 + 1);
        ctx.lineTo(x + 5, y0 + 1);
        ctx.lineTo(x + 2.5, y0 + 7);
        ctx.closePath();
        ctx.fill();
      }
    }

    // hover
    if (S.hoverT !== null && S.hoverT >= start && S.hoverT <= end) {
      const x = X(S.hoverT);
      ctx.strokeStyle = 'rgba(220,235,250,.28)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph); ctx.stroke();
      ctx.setLineDash([]);
      const nearest = nearestSample(S.hoverT);
      if (nearest) {
        for (const sig of vis) {
          const idx = S.signals.indexOf(sig);
          const v = nearest[1][idx];
          if (v === undefined) continue;
          const y = yFor(sig, v * sig.scale + sig.offset);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = sig.color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(5,10,18,.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // paused badge
    if (S.paused) {
      ctx.fillStyle = 'rgba(245,158,11,.14)';
      ctx.strokeStyle = 'rgba(245,158,11,.55)';
      const label = 'PAUSED';
      ctx.font = 'bold 9px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      const tw = ctx.measureText(label).width + 14;
      ctx.beginPath();
      roundRect(ctx, x0 + pw - tw - 8, y0 + 8, tw, 18, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fbbf24';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x0 + pw - 8 - tw / 2, y0 + 17);
    }
  }

  function nearestSample(t) {
    const a = S.samples;
    if (!a.length) return null;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] < t) lo = mid + 1; else hi = mid;
    }
    const i = lo;
    if (i > 0 && Math.abs(a[i - 1][0] - t) < Math.abs(a[i][0] - t)) return a[i - 1];
    return a[i];
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

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

  // ---------------------------------------------------------------- hover
  function onPointerMove(e) {
    const view = S.view;
    if (!view) return;
    const rect = D.chart.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < view.x0 || x > view.x0 + view.pw || y < view.y0 || y > view.y0 + view.ph) {
      onPointerLeave();
      return;
    }
    const t = view.start + ((x - view.x0) / view.pw) * (view.end - view.start);
    S.hoverT = t;
    S.hoverX = x;
    S.dirty = true;
    const near = nearestSample(t);
    if (!near) { D.tip.classList.add('hidden'); return; }
    const rows = [];
    for (const sig of S.signals.filter((s) => s.visible)) {
      const idx = S.signals.indexOf(sig);
      const v = near[1][idx];
      if (v === undefined) continue;
      rows.push('<div class="ct-row"><span class="dot" style="background:' + sig.color + ';color:' + sig.color + '"></span>' +
        '<span>' + esc(shortName(sig.name)) + '</span><span class="v">' + esc(fmtValue(sig, v)) + '</span></div>');
    }
    const rel = ((t - view.end) / 1000).toFixed(2);
    D.tip.innerHTML = '<div class="ct-time">' + rel + ' s · t=' + (near[0] / 1000).toFixed(2) + ' s</div>' + rows.join('');
    D.tip.classList.remove('hidden');
    const tw = D.tip.offsetWidth || 160;
    const th = D.tip.offsetHeight || 60;
    let left = x + 14;
    if (left + tw > S.size.w - 6) left = x - tw - 14;
    left = clamp(left, 6, S.size.w - tw - 6);
    let top = clamp(y - th / 2, 6, S.size.h - th - 6);
    D.tip.style.left = left + 'px';
    D.tip.style.top = top + 'px';
  }

  function onPointerLeave() {
    if (S.hoverT === null) return;
    S.hoverT = null;
    S.hoverX = null;
    D.tip.classList.add('hidden');
    S.dirty = true;
  }

  // ---------------------------------------------------------------- UI bindings
  function bindUI() {
    window.addEventListener('resize', resizeChart);
    if (window.ResizeObserver) new ResizeObserver(resizeChart).observe(D.wrap);

    D.chart.addEventListener('pointermove', onPointerMove);
    D.chart.addEventListener('pointerleave', onPointerLeave);

    $('#btnQuickConnect')?.addEventListener('click', () => doConnect('openocd'));
    $('#btnQuickSim')?.addEventListener('click', () => doConnect('sim'));
    $('#btnOverlayAdvanced')?.addEventListener('click', () => {
      S.ui.overlayDismissed = true;
      updateOverlay();
      openDrawer();
    });

    D.btnConnect.addEventListener('click', () => {
      if (sourceConnected(S.source)) openDrawer();
      else openDrawer();
    });

    D.btnPause.addEventListener('click', togglePause);
    $('#btnClear').addEventListener('click', clearAll);
    D.btnRecord.addEventListener('click', toggleRecord);
    $('#btnCsv').addEventListener('click', downloadCsv);
    $('#btnShot').addEventListener('click', snapshot);
    $('#btnSettings').addEventListener('click', () => openDrawer());
    $('#btnSidebar').addEventListener('click', () => D.sidebar.classList.toggle('open'));
    $('#btnDrawerClose').addEventListener('click', closeDrawer);
    D.drawerBackdrop.addEventListener('click', closeDrawer);
    $('#btnLog').addEventListener('click', () => { S.ui.log = true; D.logPanel.classList.remove('hidden'); refreshLog(); });
    $('#btnLogClose').addEventListener('click', () => { S.ui.log = false; D.logPanel.classList.add('hidden'); });

    // catalog
    D.catalogBody.addEventListener('click', onCatalogClick);
    D.search.addEventListener('input', () => { S.ui.search = D.search.value; renderCatalog(); });
    $$('#catalogTabs .tab').forEach((b) => b.addEventListener('click', () => {
      $$('#catalogTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
      S.ui.tab = b.dataset.tab;
      renderCatalog();
    }));
    $('#btnReloadSymbols').addEventListener('click', reloadCatalog);

    // toolbar
    D.winSel.addEventListener('change', () => { S.windowSec = Number(D.winSel.value); D.winSel2.value = D.winSel.value; saveLocal(); S.dirty = true; });
    D.winSel2.addEventListener('change', () => { S.windowSec = Number(D.winSel2.value); D.winSel.value = D.winSel2.value; saveLocal(); S.dirty = true; });
    $('#autoZero').addEventListener('change', (e) => { S.autoZero = e.target.checked; saveLocal(); S.dirty = true; });
    $('#fillOn').addEventListener('change', (e) => { S.fillOn = e.target.checked; saveLocal(); S.dirty = true; });
    $('#gridOn').addEventListener('change', (e) => { S.gridOn = e.target.checked; saveLocal(); S.dirty = true; });

    // drawer
    $$('#srcSeg button').forEach((b) => b.addEventListener('click', () => {
      $$('#srcSeg button').forEach((x) => x.classList.toggle('active', x === b));
      const mode = b.dataset.mode;
      $('#fieldOpenocd').classList.toggle('hidden', mode !== 'openocd');
      $('#fieldAttach').classList.toggle('hidden', mode !== 'attach');
      D.srcHint.textContent = mode === 'sim'
        ? '不连硬件，用脚本电流/阈值演示全部 UI 与堵转判定。'
        : mode === 'attach'
          ? '连到已经在跑的 OpenOCD tcl_port（例如手工启动的 openocd -c "tcl_port 6666"）。'
          : '启动 openocd.exe（tcl_port 自动选空闲端口），读 CPUID 0x410CC601 握手。';
      D.srcSegMode = mode;
    }));
    $('#btnDoConnect').addEventListener('click', () => {
      const mode = D.srcSegMode || 'openocd';
      doConnect(mode);
    });
    $('#btnDisconnect').addEventListener('click', async () => {
      try {
        await post('/api/disconnect', {});
        S.ui.overlayDismissed = false;
        toast('已断开', 'ok');
        await refreshStatus();
      } catch (e) { toast(e.message, 'err'); }
    });
    D.rateSel.addEventListener('change', () => { S.rate = Number(D.rateSel.value); saveLocal(); sendConfig(); });
    D.curSel.addEventListener('change', () => {
      S.stall.currentId = D.curSel.value; resetStall(); saveLocal(); S.dirty = true;
    });
    D.thrSel.addEventListener('change', () => {
      S.stall.thresholdId = D.thrSel.value; resetStall(); saveLocal(); S.dirty = true;
    });
    $('#stallEnable').addEventListener('change', (e) => { S.stall.enabled = e.target.checked; resetStall(); saveLocal(); S.dirty = true; });
    $('#autoPause').addEventListener('change', (e) => { S.stall.autoPause = e.target.checked; saveLocal(); });
    $('#btnReloadCatalog').addEventListener('click', reloadCatalog);
    $('#btnRecordCsv').addEventListener('click', () => {
      if (!S.record.active && !(S.record.count > 0)) { toast('先点录制，再下载', 'err'); return; }
      window.location.href = '/api/record.csv';
    });

    // keyboard
    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape') {
        if (S.ui.drawer) closeDrawer();
        else if (S.ui.log) { S.ui.log = false; D.logPanel.classList.add('hidden'); }
        return;
      }
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      else if (e.key === 'c' || e.key === 'C') clearAll();
      else if (e.key === 'r' || e.key === 'R') toggleRecord();
      else if (e.key === '/') { e.preventDefault(); D.search.focus(); }
    });
  }

  function onCatalogClick(e) {
    const group = e.target.closest('.cat-group-head');
    if (group) {
      const g = group.dataset.group;
      if (S.ui.openGroups.has(g)) S.ui.openGroups.delete(g); else S.ui.openGroups.add(g);
      group.parentElement.classList.toggle('open');
      return;
    }
    const periph = e.target.closest('.periph-head');
    if (periph) {
      const p = periph.dataset.periph;
      if (S.ui.openPeriph.has(p)) S.ui.openPeriph.delete(p); else S.ui.openPeriph.add(p);
      periph.parentElement.classList.toggle('open');
      return;
    }
    const regToggle = e.target.closest('[data-reg-toggle]');
    if (regToggle) {
      e.stopPropagation();
      const rid = regToggle.dataset.regToggle;
      if (S.ui.openRegs.has(rid)) S.ui.openRegs.delete(rid); else S.ui.openRegs.add(rid);
      renderCatalog();
      return;
    }
    const row = e.target.closest('.sig-row');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;
    if (byId(id)) { removeSignal(id); return; }
    addSignal(id);
  }

  function openDrawer() {
    S.ui.drawer = true;
    S.ui.overlayDismissed = true;
    D.drawer.classList.add('open');
    D.drawerBackdrop.classList.remove('hidden');
    renderCalib();
    renderStallSelects();
    updateOverlay();
    const mode = S.source.kind === 'sim' ? 'sim' : S.source.kind === 'attach' ? 'attach' : 'openocd';
    D.srcSegMode = mode;
    $$('#srcSeg button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
    $('#fieldOpenocd').classList.toggle('hidden', mode !== 'openocd');
    $('#fieldAttach').classList.toggle('hidden', mode !== 'attach');
  }

  function closeDrawer() {
    S.ui.drawer = false;
    D.drawer.classList.remove('open');
    D.drawerBackdrop.classList.add('hidden');
  }

  function togglePause() {
    S.paused = !S.paused;
    S.pauseAt = S.paused ? S.lastT : 0;
    updatePauseUI();
    S.dirty = true;
  }

  function updatePauseUI() {
    D.btnPause.classList.toggle('active', S.paused);
    const p = D.btnPause.querySelector('.ico-pause');
    const q = D.btnPause.querySelector('.ico-play');
    if (p) p.classList.toggle('hidden', S.paused);
    if (q) q.classList.toggle('hidden', !S.paused);
  }

  function clearAll() {
    S.samples = [];
    S.lastT = 0;
    S.pauseAt = 0;
    S.paused = false;
    S.hoverT = null;
    resetStall();
    updatePauseUI();
    updateStallUI(0);
    D.curVal.textContent = '--';
    D.thrVal.textContent = '--';
    D.marginVal.textContent = '--';
    D.marginBar.style.width = '0%';
    for (const row of S.selRows.values()) {
      const v = row.querySelector('.sel-val'); if (v) v.textContent = '—';
    }
    for (const chip of S.legendEls.values()) {
      const v = chip.querySelector('.lval'); if (v) v.textContent = '—';
    }
    for (const el of S.liveRows.values()) el.textContent = '—';
    S.dirty = true;
    toast('已清空缓冲', 'ok');
  }

  async function toggleRecord() {
    try {
      const res = await post('/api/record', { active: !S.record.active });
      S.record = res.record || {};
      D.btnRecord.classList.toggle('active', !!S.record.active);
      toast(S.record.active ? '开始录制（后端缓存）' : '已停止录制', 'ok');
      await refreshStatus();
    } catch (e) { toast(e.message, 'err'); }
  }

  function snapshot() {
    try {
      const url = D.chart.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'motorscope_' + stamp() + '.png';
      a.click();
    } catch (e) { toast('截图失败: ' + e.message, 'err'); }
  }

  function downloadCsv() {
    if (!S.samples.length) { toast('没有数据', 'err'); return; }
    const sigs = S.signals;
    const lines = [];
    lines.push(['t_s'].concat(sigs.map((s) => s.name + (s.unit ? ' [' + s.unit + ']' : ''))).map(csvCell).join(','));
    const t0 = S.samples[0][0];
    for (const [t, vals] of S.samples) {
      const row = [((t - t0) / 1000).toFixed(3)];
      for (let i = 0; i < sigs.length; i++) {
        const s = sigs[i];
        const raw = vals[i];
        row.push(raw === undefined || raw === null ? '' : String(Number((raw * s.scale + s.offset).toFixed(4))));
      }
      lines.push(row.join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'motorscope_' + stamp() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function csvCell(v) {
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  async function reloadCatalog() {
    toast('正在从 AXF 重建符号表…');
    try {
      const res = await post('/api/catalog/reload', {});
      if (!res.ok) throw new Error(res.error || '失败');
      S.catalog = res.catalog;
      buildIndex();
      S.samples = [];
      S.lastT = 0;
      resetStall();
      // 按 id 重新解析地址（固件重编译后地址会变）
      for (const sig of S.signals) {
        const e = S.index.get(sig.id);
        if (e) {
          sig.addr = e.addr; sig.size = e.size; sig.signed = e.signed;
          sig.bit = e.bit; sig.type = e.type;
        }
      }
      renderCatalog(); renderSelected(); renderStallSelects(); renderCalib(); sendConfig(true);
      toast('符号表已更新', 'ok');
    } catch (e) {
      toast('重建失败: ' + e.message, 'err');
    }
  }

  let logTimer = 0;
  async function refreshLog() {
    if (Date.now() - logTimer < 900) return;
    logTimer = Date.now();
    try {
      const res = await fetchJSON('/api/log');
      D.logText.textContent = (res.log || []).join('\n');
      D.logText.scrollTop = D.logText.scrollHeight;
    } catch {}
  }

  function openLog() {
    S.ui.log = true;
    D.logPanel.classList.remove('hidden');
    refreshLog();
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    D.toasts.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .2s';
      setTimeout(() => el.remove(), 220);
    }, kind === 'err' ? 6000 : 3200);
  }

  // ---------------------------------------------------------------- go
  window.__MS = S;          // 调试/自动化用
  window.__MS_draw = draw;
  document.addEventListener('DOMContentLoaded', boot);
})();
