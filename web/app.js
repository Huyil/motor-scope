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
    // S.rows: 用户拥有的所有行（含仅支撑 AVG 的隐藏通道、两个开关都关的行）
    rows: new Map(),
    // S.signals: 真正下发给 /api/config 并被采样的通道；samples 的列顺序与它一致
    signals: [],
    virtuals: [],
    virtualSeq: 0,
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
    zeroLine: true,
    glow: false,
    focusId: null,
    focusPinned: false,
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
      view: 'list',
      search: '',
      openGroups: new Set(['motor', 'adc', 'sys']),
      openNodes: new Set(['g:motor', 'g:adc', 'g:sys']),
      openPeriph: new Set(['ADC', 'ATIM', 'GPIOA']),
      openRegs: new Set(),
      overlayDismissed: false,
      drawer: false,
      log: false,
      connecting: false,
      tableOpen: true,
      topCompact: false,
    },
    es: null,
    selRows: new Map(),
    liveRows: new Map(),
    legendEls: new Map(),
    avgCells: new Map(),
    arrayEntries: new Map(),
    vtRows: new Map(),
    toastKeys: new Set(),
    configTimer: 0,
    configDirty: false,
    lastStatsAt: 0,
    lastChannelKey: '',
    historyTimer: 0,
    glowBuf: { cv: null, ctx: null, w: 0, h: 0 },
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
    D.valueTable = $('#valueTable');
    D.tableCard = $('#tableCard');
    D.tableBody = $('#tableBody');
    D.tableCount = $('#tableCount');
    D.tableSum = $('#tableSum');
    D.tableHead = $('#tableHead');
    D.btnTableToggle = $('#btnTableToggle');
    D.viewNote = $('#viewNote');
    D.topbar = $('#topbar');
    D.actions = $('#topActions');
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
    D.axfFile = $('#axfFile');
    D.hdrFile = $('#hdrFile');
    D.btnImportAxf = $('#btnImportAxf');
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

  // ---------------------------------------------------------------- rows / channels
  // 设计：S.rows 是用户拥有的行（含隐藏支撑通道、两个开关都关的行）；
  // S.signals 只放真正要下发给 /api/config 的通道，samples 的列与它一一对应。
  const MAX_SAMPLED = 24;

  function byId(id) { return S.signals.find((s) => s.id === id) || null; }
  function rowById(id) {
    if (S.rows.has(id)) return S.rows.get(id);
    return S.virtuals.find((v) => v.id === id) || null;
  }
  function signalIndex(id) { return S.signals.findIndex((s) => s.id === id); }
  function isHidden(row) { return !!row.support && !row.table && !row.plot; }
  function plotRows() {
    const out = [];
    for (const r of S.rows.values()) if (r.plot) out.push(r);
    for (const v of S.virtuals) if (v.plot) out.push(v);
    return out;
  }
  function tableRows() {
    const out = [];
    for (const r of S.rows.values()) if (r.table) out.push(r);
    for (const v of S.virtuals) if (v.table) out.push(v);
    return out;
  }
  function avgVirtualFor(arrayId) { return S.virtuals.find((v) => v.arrayId === arrayId) || null; }

  function visibleRowCount() {
    const ids = new Set();
    for (const r of S.rows.values()) if (r.table || r.plot) ids.add(r.id);
    for (const v of S.virtuals) if (v.table || v.plot) ids.add(v.id);
    return ids.size;
  }

  function normalizeSignal(d) {
    const bit = Array.isArray(d.bit) ? [Number(d.bit[0]), Number(d.bit[1])] : null;
    const visible = d.visible !== false;
    const table = d.table !== undefined ? !!d.table : visible;
    const plot = d.plot !== undefined ? !!d.plot : visible;
    return {
      kind: 'channel',
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
      table,
      plot,
      support: !!d.support,
      visible,
      axis: d.axis === 'right' ? 'right' : d.axis === 'left' ? 'left' : inferAxis(d.name),
      type: String(d.type || ''),
      value: null,
      ci: -1,
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
    const used = new Set();
    for (const r of S.rows.values()) used.add(r.color);
    for (const v of S.virtuals) used.add(v.color);
    const palette = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#60a5fa',
      '#fb7185', '#facc15', '#2dd4bf', '#c084fc', '#fb923c', '#4ade80'];
    return palette.find((c) => !used.has(c)) || palette[(S.rows.size + S.virtuals.length) % palette.length];
  }

  function isStepSignal(entry) {
    return !!entry.bit || /(threshold|state|level|conts|power|overlevel|direction)/i.test(entry.name || '');
  }

  function newRow(entry, opts = {}) {
    return normalizeSignal({
      ...entry,
      color: opts.color || nextColor(),
      scale: opts.scale ?? 1,
      offset: opts.offset ?? 0,
      unit: opts.unit !== undefined ? opts.unit : inferUnit(entry.name),
      step: opts.step ?? isStepSignal(entry),
      table: opts.table !== undefined ? !!opts.table : true,
      plot: opts.plot !== undefined ? !!opts.plot : true,
      support: !!opts.support,
    });
  }

  function addRow(entry, opts = {}) {
    if (!entry) return null;
    const id = entry.id || entry.name;
    const old = S.rows.get(id);
    if (old) {
      if (opts.table !== undefined) old.table = !!opts.table;
      if (opts.plot !== undefined) old.plot = !!opts.plot;
      if (opts.support === false) old.support = false;
      afterSignalsChanged();
      return old;
    }
    if (S.signals.length >= MAX_SAMPLED) {
      toast('最多同时采样 ' + MAX_SAMPLED + ' 路（含数组 AVG 的支撑通道）', 'err');
      return null;
    }
    const row = newRow(entry, opts);
    S.rows.set(id, row);
    afterSignalsChanged();
    return row;
  }

  function addSignal(id, opts = {}) {
    const entry = S.index.get(id);
    if (!entry) { toast('找不到信号: ' + id, 'err'); return null; }
    return addRow(entry, opts);
  }

  function addCustomSignal(addr, size, signed, name) {
    if (!Number.isFinite(addr) || addr < 0) { toast('地址无效', 'err'); return; }
    const id = 'custom.' + hex(addr) + '.' + size;
    const entry = {
      id, name: name || ('@' + hex(addr, 4)), addr, size, signed,
      bit: null, type: signed ? 'int' : 'uint', kind: 'custom', group: '自定义',
    };
    S.index.set(id, entry);
    addRow(entry, { table: true, plot: true });
  }

  function releaseOrphans() {
    const used = new Set();
    for (const v of S.virtuals) for (const id of v.sourceIds) used.add(id);
    for (const [id, row] of Array.from(S.rows.entries())) {
      if (row.support && !row.table && !row.plot && !used.has(id)) S.rows.delete(id);
    }
  }

  function removeVirtual(v) {
    const i = S.virtuals.indexOf(v);
    if (i >= 0) S.virtuals.splice(i, 1);
    releaseOrphans();
  }

  function removeSignal(id) {
    const row = S.rows.get(id);
    const vr = S.virtuals.find((v) => v.id === id);
    if (!row && !vr) return;
    if (vr) {
      removeVirtual(vr);
      afterSignalsChanged();
      return;
    }
    S.rows.delete(id);
    for (const v of Array.from(S.virtuals)) {
      const at = v.sourceIds.indexOf(id);
      if (at >= 0) {
        v.sourceIds.splice(at, 1);
        if (!v.sourceIds.length) removeVirtual(v);
      }
    }
    releaseOrphans();
    afterSignalsChanged();
  }

  function ensureSupport(entries) {
    let added = 0;
    for (const entry of entries) {
      const id = entry.id || entry.name;
      if (!id || S.rows.has(id)) continue;
      if (S.signals.length + added >= MAX_SAMPLED) {
        toast('数组展开需要 ' + entries.length + ' 路支撑通道，超过 ' + MAX_SAMPLED + ' 路上限', 'err');
        return false;
      }
      S.rows.set(id, newRow({ ...entry, id, name: entry.name || id }, { table: false, plot: false, support: true }));
      added++;
    }
    return true;
  }

  function createVirtual(arrayId, entries, opts = {}) {
    let v = avgVirtualFor(arrayId);
    if (v) return v;
    const first = entries[0] || {};
    const baseName = arrayId.replace(/\[\]$/, '');
    v = {
      kind: 'virtual',
      id: 'avg:' + arrayId,
      arrayId,
      name: baseName + '[] AVG',
      sourceIds: entries.map((e) => e.id),
      color: opts.color || nextColor(),
      axis: opts.axis || inferAxis(baseName),
      unit: entries.every((e) => (inferUnit(e.name) === inferUnit(first.name))) ? inferUnit(first.name) : '',
      scale: 1,
      offset: 0,
      step: false,
      table: false,
      plot: false,
      support: false,
      value: null,
      _src: [],
    };
    S.virtuals.push(v);
    return v;
  }

  function setRowFlag(id, flag, on, entry) {
    if (flag !== 'table' && flag !== 'plot') return;
    let row = S.rows.get(id);
    if (!row) {
      if (!on) return;
      const src = entry || S.index.get(id);
      if (!src) { toast('找不到信号: ' + id, 'err'); return; }
      row = newRow(src, { table: flag === 'table', plot: flag === 'plot', support: false });
      S.rows.set(id, row);
      afterSignalsChanged();
      return;
    }
    if (row.support && on) row.support = false;
    row[flag] = !!on;
    if (!row.table && !row.plot) {
      const used = S.virtuals.some((v) => v.sourceIds.indexOf(row.id) >= 0);
      row.support = used;
    }
    afterSignalsChanged();
  }

  function setBothFlags(id, on) {
    let row = S.rows.get(id);
    if (!row) {
      if (!on) return;
      addSignal(id, { table: true, plot: true });
      return;
    }
    row.table = row.plot = !!on;
    afterSignalsChanged();
  }

  function setAvgFlag(arrayId, entries, flag, on) {
    if (flag !== 'table' && flag !== 'plot') return;
    let v = avgVirtualFor(arrayId);
    if (!v) {
      if (!on) return;
      if (!ensureSupport(entries)) return;
      v = createVirtual(arrayId, entries);
    } else if (on) {
      if (!ensureSupport(entries)) return;
      v.sourceIds = entries.map((e) => e.id);
    }
    v[flag] = !!on;
    if (!v.table && !v.plot) removeVirtual(v);
    afterSignalsChanged();
  }

  function syncChannels() {
    const before = S.signals.map((s) => s.id).join('|');
    const need = new Set();
    for (const r of S.rows.values()) if (r.table || r.plot) need.add(r.id);
    for (const v of S.virtuals) for (const id of v.sourceIds) need.add(id);
    const next = [];
    for (const r of S.rows.values()) if (need.has(r.id)) next.push(r);
    S.signals = next;
    next.forEach((r, i) => { r.ci = i; });
    for (const v of S.virtuals) {
      v._src = v.sourceIds
        .map((id) => S.rows.get(id))
        .filter((r) => r && r.ci >= 0)
        .map((r) => r.ci);
    }
    const after = S.signals.map((s) => s.id).join('|');
    if (before !== after) {
      // 服务端在通道构成变化时会清历史；本地也清，否则旧列会和新列错位。
      S.samples = [];
      S.lastT = 0;
      S.hoverT = null;
      S.paused = false;
      S.pauseAt = 0;
      resetStall();
      updatePauseUI();
      updateStallUI(0);
      S.lastChannelKey = after;
      scheduleHistoryReload();
      S.dirty = true;
    }
  }

  function scheduleHistoryReload() {
    if (S.historyTimer) clearTimeout(S.historyTimer);
    S.historyTimer = setTimeout(() => {
      S.historyTimer = 0;
      loadHistory();
    }, 500);
  }

  function afterSignalsChanged() {
    syncChannels();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
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
    renderValueTable();
    renderStallSelects();
    renderCalib();
    syncTablePanel();
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
      const raw = localStorage.getItem('ms.cfg.v2') || localStorage.getItem('ms.cfg.v1');
      if (raw) {
        const c = JSON.parse(raw);
        const rows = c.rows || c.signals || [];
        if (Array.isArray(rows) && rows.length) {
          S.rows.clear();
          S.virtuals = [];
          for (const item of rows) {
            let entry = S.index.get(item.id);
            if (!entry && item.id && item.addr !== undefined) {
              entry = {
                id: item.id, name: item.name || item.id,
                addr: Number(item.addr) >>> 0, size: Number(item.size) || 4,
                signed: !!item.signed, bit: null, type: item.type || 'custom',
                kind: 'custom', group: '自定义',
              };
              S.index.set(item.id, entry);
            }
            if (!entry) continue;
            const row = normalizeSignal({
              ...entry, ...item,
              table: item.table !== undefined ? item.table : item.visible !== false,
              plot: item.plot !== undefined ? item.plot : item.visible !== false,
              support: !!item.support,
            });
            S.rows.set(row.id, row);
          }
          for (const v of c.virtuals || []) {
            const sourceIds = (v.sourceIds || []).filter((id) => S.rows.has(id));
            if (!sourceIds.length) continue;
            S.virtuals.push({
              ...v, kind: 'virtual', sourceIds,
              table: !!v.table, plot: !!v.plot, support: false,
              scale: 1, offset: 0, step: false, _src: [],
            });
          }
          releasedAfterRestore();
          restored = S.rows.size > 0;
        }
        S.windowSec = Number(c.windowSec) || S.windowSec;
        S.rate = Number(c.rate) || S.rate;
        S.autoZero = !!c.autoZero;
        S.fillOn = c.fillOn !== false;
        S.gridOn = c.gridOn !== false;
        S.zeroLine = c.zeroLine !== false;
        S.glow = !!c.glow;
        S.ui.view = c.view === 'tree' ? 'tree' : 'list';
        S.ui.tableOpen = c.tableOpen !== false;
        if (c.stall) {
          S.stall.enabled = c.stall.enabled !== false;
          S.stall.autoPause = !!c.stall.autoPause;
          S.stall.currentId = c.stall.currentId || '';
          S.stall.thresholdId = c.stall.thresholdId || '';
        }
      }
    } catch (e) { console.warn(e); }

    if (!restored && !S.rows.size) {
      const defaults = S.catalog.defaults || [];
      const names = defaults.length ? defaults : (S.catalog.variables || []).slice(0, 4).map((v) => v.name);
      for (let i = 0; i < names.length; i++) {
        const entry = S.index.get(names[i]);
        if (!entry) continue;
        S.rows.set(entry.id, newRow(entry, {
          color: ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399'][i % 4],
          unit: 'counts', table: true, plot: true,
        }));
      }
    }
    syncChannels();
    const st = S.catalog.stall || {};
    const sampled = S.signals.filter((s) => !isHidden(s));
    if (!byId(S.stall.currentId)) S.stall.currentId = st.current || (sampled[0]?.id || '');
    if (!byId(S.stall.thresholdId)) S.stall.thresholdId = st.threshold || (sampled[1]?.id || '');
    syncToggles();
    updateViewSeg();
    syncTablePanel();
    if (S.rows.size) sendConfig(true);
  }

  function releasedAfterRestore() {
    const used = new Set();
    for (const v of S.virtuals) for (const id of v.sourceIds) used.add(id);
    for (const [id, row] of Array.from(S.rows.entries())) {
      if (row.support && !row.table && !row.plot && !used.has(id)) S.rows.delete(id);
    }
  }

  function syncToggles() {
    if (D.winSel) D.winSel.value = String(S.windowSec);
    if (D.winSel2) D.winSel2.value = String(S.windowSec);
    if (D.rateSel) D.rateSel.value = String(S.rate);
    const az = $('#autoZero'); if (az) az.checked = S.autoZero;
    const fo = $('#fillOn'); if (fo) fo.checked = S.fillOn;
    const go = $('#gridOn'); if (go) go.checked = S.gridOn;
    const zl = $('#zeroLine'); if (zl) zl.checked = S.zeroLine;
    const gl = $('#glowOn'); if (gl) gl.checked = S.glow;
    const se = $('#stallEnable'); if (se) se.checked = S.stall.enabled;
    const ap = $('#autoPause'); if (ap) ap.checked = S.stall.autoPause;
  }

  function saveLocal() {
    try {
      localStorage.setItem('ms.cfg.v2', JSON.stringify({
        v: 2,
        rows: Array.from(S.rows.values()).map((s) => ({
          id: s.id, name: s.name, addr: s.addr, size: s.size, signed: s.signed,
          scale: s.scale, offset: s.offset, unit: s.unit, color: s.color,
          step: s.step, axis: s.axis, type: s.type,
          table: !!s.table, plot: !!s.plot, support: !!s.support,
        })),
        virtuals: S.virtuals.map((v) => ({
          id: v.id, arrayId: v.arrayId, name: v.name, sourceIds: v.sourceIds.slice(),
          color: v.color, axis: v.axis, unit: v.unit, table: !!v.table, plot: !!v.plot,
        })),
        rate: S.rate,
        windowSec: S.windowSec,
        autoZero: S.autoZero,
        fillOn: S.fillOn,
        gridOn: S.gridOn,
        zeroLine: S.zeroLine,
        glow: S.glow,
        view: S.ui.view,
        tableOpen: S.ui.tableOpen,
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
    S.rows.clear();
    S.virtuals = [];
    for (const x of list || []) {
      if (!x || !x.id) continue;
      const row = normalizeSignal(x);
      S.rows.set(row.id, row);
    }
    syncChannels();
    if (rate) S.rate = Number(rate) || S.rate;
    const st = S.catalog.stall || {};
    const sampled = S.signals.filter((s) => !isHidden(s));
    if (!byId(S.stall.currentId)) S.stall.currentId = st.current || (sampled[0]?.id || '');
    if (!byId(S.stall.thresholdId)) S.stall.thresholdId = st.threshold || (sampled[1]?.id || '');
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
        // 只发实际需要采样的通道 union；AVG 虚拟行没有地址，不会出现在这里。
        signals: S.signals.map((s) => ({
          id: s.id, name: s.name, addr: s.addr, size: s.size, signed: s.signed,
          bit: s.bit, scale: s.scale, offset: s.offset, unit: s.unit,
          color: s.color, step: s.step, visible: !isHidden(s),
          role: s.support ? 'support' : 'signal',
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
        if (!S.rows.size && msg.config?.signals?.length) {
          adoptSignals(msg.config.signals, msg.config.rate);
          renderSelected(); renderLegend(); renderValueTable(); renderStallSelects(); renderCalib();
          saveLocal();
          loadHistory();
        } else if (S.rows.size) {
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
      const vals = s[1] || [];
      // 配置切换期间服务端还可能吐旧列数的样本，丢掉避免列错位
      if (!S.signals.length || vals.length !== S.signals.length) continue;
      if (!map.has(s[0])) map.set(s[0], [Number(s[0]), vals]);
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
    const nchan = S.signals.length;
    for (const item of batch) {
      const t = Number(item[0]);
      const vals = item[1] || [];
      if (!isFinite(t)) continue;
      // 旧配置的在途样本列数不同，丢弃
      if (!nchan || vals.length !== nchan) continue;
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

  function channelValue(row, vals) {
    const i = row.ci;
    if (i < 0 || i >= vals.length) return null;
    const raw = vals[i];
    if (raw === undefined || raw === null) return null;
    const v = raw * row.scale + row.offset;
    return isFinite(v) ? v : null;
  }

  function virtualValue(v, vals) {
    let sum = 0, n = 0;
    const src = v._src;
    for (let k = 0; k < src.length; k++) {
      const ch = S.signals[src[k]];
      if (!ch) continue;
      const raw = vals[src[k]];
      if (raw === undefined || raw === null) continue;
      const val = raw * ch.scale + ch.offset;
      if (!isFinite(val)) continue;
      sum += val; n++;
    }
    return n ? sum / n : null;
  }

  function rowValue(row, vals) {
    return row.kind === 'virtual' ? virtualValue(row, vals) : channelValue(row, vals);
  }

  function fmtPhysical(row, v) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    if (row.kind === 'virtual') return (Math.round(v * 10) / 10).toLocaleString('en-US');
    if ((row.scale ?? 1) === 1 && (row.offset ?? 0) === 0) return fmtInt(v);
    return (Math.round(v * 100) / 100).toLocaleString('en-US');
  }

  function fmtStat(v) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    if (Math.abs(v) >= 100) return Math.round(v).toLocaleString('en-US');
    return (Math.round(v * 10) / 10).toLocaleString('en-US');
  }

  function rowValueText(row, vals) {
    const v = rowValue(row, vals);
    return fmtPhysical(row, v);
  }

  function refreshLiveValues() {
    const last = latestSample();
    if (!last) return;
    const vals = last[1];
    const cur = byId(S.stall.currentId);
    const thr = byId(S.stall.thresholdId);
    const ci = cur ? cur.ci : -1;
    const ti = thr ? thr.ci : -1;
    if (cur && ci >= 0 && ci < vals.length) {
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
    // 目录/波形列表/图例/数值表里的实时值
    for (const row of S.rows.values()) {
      const txt = rowValueText(row, vals);
      const sel = S.selRows.get(row.id);
      if (sel) { const el = sel.querySelector('.sel-val'); if (el) el.textContent = txt; }
      const chip = S.legendEls.get(row.id);
      if (chip) { const el = chip.querySelector('.lval'); if (el) el.textContent = txt; }
      const live = S.liveRows.get(row.id);
      if (live) live.textContent = txt;
      const vt = S.vtRows.get(row.id);
      if (vt) { vt.cur.textContent = txt; vt.cur.title = row.name + ' · ' + hex(row.addr); }
    }
    for (const v of S.virtuals) {
      const txt = rowValueText(v, vals);
      const sel = S.selRows.get(v.id);
      if (sel) { const el = sel.querySelector('.sel-val'); if (el) el.textContent = txt; }
      const chip = S.legendEls.get(v.id);
      if (chip) { const el = chip.querySelector('.lval'); if (el) el.textContent = txt; }
      const avg = S.avgCells.get(v.id);
      if (avg) avg.textContent = txt;
      const vt = S.vtRows.get(v.id);
      if (vt) vt.cur.textContent = txt;
    }
    updateStallUI(last[0]);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - S.lastStatsAt > 240) {
      S.lastStatsAt = now;
      updateTableStats();
    }
  }

  function tableWindow() {
    if (S.view && isFinite(S.view.start) && isFinite(S.view.end)) return [S.view.start, S.view.end];
    const end = S.paused ? (S.pauseAt || S.lastT) : S.lastT;
    return [end - S.windowSec * 1000, end];
  }

  function updateTableStats() {
    const rows = tableRows();
    if (!rows.length) return;
    const [start, end] = tableWindow();
    const range = sampleRange(start, end);
    for (const row of rows) {
      const vt = S.vtRows.get(row.id);
      if (!vt) continue;
      let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
      for (let i = range[0]; i < range[1]; i++) {
        const v = rowValue(row, S.samples[i][1]);
        if (v === null || !isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v; n++;
      }
      vt.min.textContent = n ? fmtStat(mn) : '--';
      vt.max.textContent = n ? fmtStat(mx) : '--';
      vt.avg.textContent = n ? fmtStat(sum / n) : '--';
    }
    if (D.tableSum) {
      const span = Math.max(0, (end - start) / 1000);
      D.tableSum.textContent = span.toFixed(0) + ' s 窗口 · ' + rows.length + ' 项';
    }
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
        const ci = cur ? cur.ci : -1;
        const ti = thr ? thr.ci : -1;
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
    const ci = cur.ci;
    const ti = thr.ci;
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
    if (!S.rows.size && st.config?.signals?.length && !S.ui.connecting) {
      adoptSignals(st.config.signals, st.config.rate);
      renderSelected(); renderLegend(); renderValueTable(); renderStallSelects(); renderCalib();
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
      fitTopbar();
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
    S.avgCells.clear();
    S.arrayEntries = S.arrayEntries || new Map();
    S.arrayEntries.clear();
    const tab = S.ui.tab;
    const q = S.ui.search.trim().toLowerCase();
    D.sigCount.textContent = String(visibleRowCount());
    D.selCount.textContent = String(plotRows().length);
    D.search.placeholder = tab === 'periph' ? '搜索外设 / 寄存器 / 位' : tab === 'custom' ? '自定义地址' : '搜索变量 / 寄存器 / 地址';
    if (D.viewNote) {
      D.viewNote.textContent = S.ui.view === 'tree'
        ? '对象 · 结构体 · 数组 · 位域'
        : (tab === 'periph' ? '按外设分组' : tab === 'vars' ? '按对象分组' : '任意地址');
    }
    if (tab === 'vars') {
      if (S.ui.view === 'tree') renderVarsTree(body, q); else renderVars(body, q);
    } else if (tab === 'periph') {
      if (S.ui.view === 'tree') renderPeriphTree(body, q); else renderPeriph(body, q);
    } else {
      renderCustom(body);
    }
  }

  function matchText(parts, q) {
    if (!q) return true;
    return parts.some((p) => String(p || '').toLowerCase().includes(q));
  }

  function rowFlagButtons(id, entry) {
    const wrap = document.createElement('span');
    wrap.className = 'sig-toggles';
    const row = S.rows.get(id);
    for (const [flag, label, title] of [['table', '表', '数值表'], ['plot', '波', '波形']]) {
      const b = document.createElement('button');
      b.className = 'tgl tgl-' + flag + (row && row[flag] ? ' on' : '');
      b.textContent = label;
      b.title = (row && row[flag] ? '从' : '加入') + title;
      b.dataset.rowToggle = id;
      b.dataset.flag = flag;
      b.setAttribute('aria-label', (row && row[flag] ? '从' : '加入') + title);
      b.setAttribute('aria-pressed', row && row[flag] ? 'true' : 'false');
      wrap.appendChild(b);
    }
    return wrap;
  }

  function sigRow(entry, kind, opts = {}) {
    const rowEl = document.createElement('div');
    const eid = entry.id || entry.name;
    const row = S.rows.get(eid);
    rowEl.className = 'sig-row' + (row ? ' selected' : '') + (row && !row.table && !row.plot ? ' idle' : '');
    rowEl.dataset.id = eid;
    rowEl.dataset.kind = kind;
    if (opts.bit) rowEl.classList.add('bit-row');
    if (opts.reg) rowEl.classList.add('reg-row');
    if (opts.tree) rowEl.classList.add('tree-leaf');
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
    name.title = entry.name + '\n' + hex(entry.addr) + ' · ' + (entry.size * 8) + ' bit ' + (entry.signed ? 'signed' : 'unsigned') +
      '\n点击数：切换“表/波”；两个小按钮可分别开关';
    main.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'sig-meta';
    meta.textContent = hex(entry.addr) + ' · ' + (entry.type || (entry.size * 8 + 'b'));
    main.appendChild(meta);
    const val = document.createElement('span');
    val.className = 'sig-val';
    val.textContent = '—';
    rowEl.appendChild(rowFlagButtons(eid, entry));
    rowEl.appendChild(main);
    rowEl.appendChild(val);
    S.liveRows.set(eid, val);
    return rowEl;
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

  // ---- tree model ----
  function pathSegments(path) {
    return String(path).split('.').map((seg) => {
      const m = /^([^\[\]]+?)(?:\[(\d+)\])?$/.exec(seg);
      if (!m) return { name: seg, idx: null };
      return { name: m[1], idx: m[2] !== undefined ? Number(m[2]) : null };
    });
  }

  function makeTreeNode(name, full) {
    return {
      name, full, key: 'n:' + full, children: new Map(), indices: new Map(),
      leaf: null, isArray: false, isIndex: false, idx: null,
    };
  }

  function buildVarForest(vars) {
    const roots = new Map();
    for (const v of vars) {
      let group = v.group || '全局';
      let path;
      if (group === v.name) { group = '全局'; path = v.name; }
      else if (String(v.name).startsWith(group + '.')) path = v.name.slice(group.length + 1);
      else path = v.name;
      let root = roots.get(group);
      if (!root) {
        root = makeTreeNode(group, group);
        root.key = 'g:' + group;
        roots.set(group, root);
      }
      let cur = root;
      for (const seg of pathSegments(path)) {
        if (seg.idx !== null) {
          let arr = cur.children.get(seg.name);
          if (!arr) {
            arr = makeTreeNode(seg.name, cur.full + '.' + seg.name);
            arr.isArray = true;
            cur.children.set(seg.name, arr);
          }
          let elem = arr.indices.get(seg.idx);
          if (!elem) {
            elem = makeTreeNode('[' + seg.idx + ']', arr.full + '[' + seg.idx + ']');
            elem.isIndex = true;
            elem.idx = seg.idx;
            arr.indices.set(seg.idx, elem);
          }
          cur = elem;
        } else {
          let child = cur.children.get(seg.name);
          if (!child) {
            child = makeTreeNode(seg.name, cur.full + '.' + seg.name);
            cur.children.set(seg.name, child);
          }
          cur = child;
        }
      }
      cur.leaf = v;
    }
    return roots;
  }

  function treeLeafCount(node) {
    let n = node.leaf ? 1 : 0;
    for (const c of node.children.values()) n += treeLeafCount(c);
    for (const c of node.indices.values()) n += treeLeafCount(c);
    return n;
  }

  function arrayEntriesOf(node) {
    const out = [];
    const idx = Array.from(node.indices.keys()).sort((a, b) => a - b);
    for (const i of idx) {
      const elem = node.indices.get(i);
      if (elem && elem.leaf) {
        out.push({ ...elem.leaf, id: elem.leaf.id || elem.leaf.name });
      }
    }
    return out;
  }

  function isScalarArray(node) {
    if (!node.isArray || !node.indices.size) return false;
    for (const elem of node.indices.values()) {
      if (!elem.leaf || elem.children.size) return false;
    }
    return true;
  }

  function renderVarsTree(body, q) {
    const vars = S.catalog.variables || [];
    const filtered = q ? vars.filter((v) => matchText([v.name, v.group, hex(v.addr), v.type], q)) : vars;
    if (!filtered.length) {
      body.innerHTML = '<div class="cat-empty muted">没有匹配的变量</div>';
      return;
    }
    const roots = buildVarForest(filtered);
    const priority = { motor: 0, adc: 1, sys: 2, '全局': 99 };
    const ordered = Array.from(roots.entries()).sort((a, b) => {
      const pa = priority[a[0]] ?? 10, pb = priority[b[0]] ?? 10;
      if (pa !== pb) return pa - pb;
      return (a[1].leaf?.addr || 0) - (b[1].leaf?.addr || 0);
    });
    const frag = document.createDocumentFragment();
    for (const [, root] of ordered) frag.appendChild(renderTreeNode(root, 0, q, true));
    body.innerHTML = '';
    body.appendChild(frag);
  }

  function renderTreeNode(node, depth, q, isRoot = false) {
    const open = !!q || S.ui.openNodes.has(node.key);
    if (!node.children.size && !node.indices.size && node.leaf) {
      const wrap = document.createElement('div');
      wrap.className = 'tree-leaf-row';
      wrap.style.setProperty('--depth', String(depth));
      const row = sigRow(node.leaf, 'var', { tree: true });
      wrap.appendChild(row);
      return wrap;
    }
    const box = document.createElement('div');
    box.className = 'tree-node' + (open ? ' open' : '');
    const head = document.createElement('div');
    head.className = 'tree-head';
    head.dataset.node = node.key;
    head.style.setProperty('--depth', String(depth));
    head.innerHTML = '<span class="arrow">▶</span><span class="tname"></span><span class="tkind"></span><span class="taddr"></span><span class="tcount"></span>';
    const nLeaves = treeLeafCount(node);
    const nm = head.querySelector('.tname');
    nm.textContent = node.name + (node.isArray ? '[]' : '');
    const kind = head.querySelector('.tkind');
    kind.textContent = node.isArray ? 'array' : (depth === 0 ? 'object' : 'struct');
    const addr = head.querySelector('.taddr');
    const firstLeaf = node.leaf || firstLeafOf(node);
    if (firstLeaf) addr.textContent = hex(firstLeaf.addr, 6);
    head.querySelector('.tcount').textContent = nLeaves + ' 项';
    head.title = (node.full || node.name) + (firstLeaf ? '\n' + hex(firstLeaf.addr) : '');
    box.appendChild(head);
    const inner = document.createElement('div');
    inner.className = 'tree-body';
    if (node.leaf) inner.appendChild(sigRow(node.leaf, 'var', { tree: true }));
    if (node.isArray) {
      if (isScalarArray(node)) {
        inner.appendChild(renderArrayTable(node, node.indices, depth + 1));
      } else {
        for (const i of Array.from(node.indices.keys()).sort((a, b) => a - b)) {
          inner.appendChild(renderTreeNode(node.indices.get(i), depth + 1, q));
        }
      }
    }
    const kids = Array.from(node.children.values()).sort((a, b) => {
      if (a.isArray !== b.isArray) return a.isArray ? -1 : 1;
      const aa = firstLeafOf(a), bb = firstLeafOf(b);
      return (aa?.addr || 0) - (bb?.addr || 0);
    });
    for (const c of kids) inner.appendChild(renderTreeNode(c, depth + 1, q));
    box.appendChild(inner);
    return box;
  }

  function firstLeafOf(node) {
    if (node.leaf) return node.leaf;
    for (const c of node.children.values()) { const l = firstLeafOf(c); if (l) return l; }
    for (const c of node.indices.values()) { const l = firstLeafOf(c); if (l) return l; }
    return null;
  }

  function renderArrayTable(node, indices, depth) {
    const entries = arrayEntriesOf(node);
    S.arrayEntries.set(node.full, entries);
    const vid = 'avg:' + node.full;
    const v = S.virtuals.find((x) => x.arrayId === node.full);
    const wrap = document.createElement('div');
    wrap.className = 'array-table';
    wrap.style.setProperty('--depth', String(depth));
    const head = document.createElement('div');
    head.className = 'at-row at-head';
    head.innerHTML = '<span class="at-idx">idx</span><span class="at-val">当前值</span><span class="at-tgl">表 / 波</span>';
    wrap.appendChild(head);
    for (const i of Array.from(indices.keys()).sort((a, b) => a - b)) {
      const elem = indices.get(i);
      if (!elem || !elem.leaf) continue;
      const entry = { ...elem.leaf, id: elem.leaf.id || elem.leaf.name };
      if (!entry.id) continue;
      const rowEl = document.createElement('div');
      rowEl.className = 'at-row';
      const ix = document.createElement('span');
      ix.className = 'at-idx';
      ix.textContent = '[' + i + ']';
      const val = document.createElement('span');
      val.className = 'at-val';
      val.textContent = '—';
      S.liveRows.set(entry.id, val);
      rowEl.appendChild(ix);
      rowEl.appendChild(val);
      rowEl.appendChild(rowFlagButtons(entry.id, entry));
      wrap.appendChild(rowEl);
    }
    const avg = document.createElement('div');
    avg.className = 'at-row avg';
    const ix = document.createElement('span');
    ix.className = 'at-idx';
    ix.textContent = 'AVG';
    const val = document.createElement('span');
    val.className = 'at-val';
    val.textContent = '—';
    S.avgCells.set(vid, val);
    const tg = document.createElement('span');
    tg.className = 'sig-toggles';
    for (const [flag, label, title] of [['table', '表', '数值表'], ['plot', '波', '波形']]) {
      const b = document.createElement('button');
      b.className = 'tgl tgl-' + flag + (v && v[flag] ? ' on' : '');
      b.textContent = label;
      b.title = (v && v[flag] ? '从' : '加入') + '数组平均值到' + title;
      b.dataset.avgToggle = node.full;
      b.dataset.flag = flag;
      b.setAttribute('aria-pressed', v && v[flag] ? 'true' : 'false');
      tg.appendChild(b);
    }
    avg.appendChild(ix);
    avg.appendChild(val);
    avg.appendChild(tg);
    wrap.appendChild(avg);
    const note = document.createElement('div');
    note.className = 'at-note';
    note.textContent = 'AVG = 数组元素物理量平均；勾选“表/波”后自动下发元素支撑通道（隐藏，不画图例）';
    wrap.appendChild(note);
    return wrap;
  }

  function renderPeriph(body, q) {
    body.innerHTML = '';
    renderPeriphInto(body, q);
  }

  function renderPeriphTree(body, q) {
    const open = !!q || S.ui.openNodes.has('g:periph');
    const box = document.createElement('div');
    box.className = 'tree-node' + (open ? ' open' : '');
    const head = document.createElement('div');
    head.className = 'tree-head';
    head.dataset.node = 'g:periph';
    head.innerHTML = '<span class="arrow">▶</span><span class="tname">外设</span><span class="tkind">periph</span><span class="tcount"></span>';
    head.querySelector('.tcount').textContent = (S.catalog.peripherals || []).length + ' 个';
    box.appendChild(head);
    const inner = document.createElement('div');
    inner.className = 'tree-body';
    renderPeriphInto(inner, q);
    box.appendChild(inner);
    body.innerHTML = '';
    body.appendChild(box);
  }

  function renderPeriphInto(body, q) {
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
        const blockDiv = document.createElement('div');
        blockDiv.className = 'reg-block' + (regOpen ? ' open' : '');
        blockDiv.dataset.reg = rid;
        const entry = {
          id: rid, name: rid, addr: r.addr, size: r.size || 4,
          signed: !!r.signed, bit: null, type: r.type || '', group: p.name,
        };
        const rowEl = sigRow(entry, 'reg', { reg: true, hasBits });
        blockDiv.appendChild(rowEl);
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
          blockDiv.appendChild(bitsBox);
        }
        inner.appendChild(blockDiv);
      }
      box.appendChild(inner);
      frag.appendChild(box);
    }
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
      '<button id="custAdd" class="btn primary">添加（表 + 波形）</button>';
    body.appendChild(form);
    const list = Array.from(S.rows.values()).filter((s) => s.id.startsWith('custom.'));
    if (list.length) {
      const head = document.createElement('div');
      head.className = 'side-title';
      head.style.margin = '14px 0 4px';
      head.textContent = '自定义信号';
      body.appendChild(head);
      for (const s of list) {
        body.appendChild(sigRow(s, 'var', { tree: true }));
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
    const rows = plotRows();
    D.selCount.textContent = String(rows.length);
    if (!rows.length) {
      const empty = tableRows().length
        ? '数值表里有信号，但“波”都关着'
        : '把左侧“波”打开，加入波形列表';
      box.innerHTML = '<div class="cat-empty muted">' + empty + '</div>';
      return;
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'sel-row';
      el.dataset.id = row.id;
      el.innerHTML = '<span class="dot"></span><span class="sel-name"></span><span class="sel-tgls"></span><span class="sel-val">—</span><button class="sel-x" title="移除">×</button>';
      const dot = el.querySelector('.dot');
      dot.style.background = row.color;
      dot.style.color = row.color;
      const nm = el.querySelector('.sel-name');
      nm.textContent = shortName(row.name);
      nm.title = row.kind === 'virtual'
        ? row.name + ' · ' + row.sourceIds.length + ' 个数组元素平均'
        : hex(row.addr) + ' · ' + row.name;
      const tgs = el.querySelector('.sel-tgls');
      for (const [flag, label, title] of [['table', '表', '数值表'], ['plot', '波', '波形']]) {
        const b = document.createElement('button');
        b.className = 'tgl tgl-' + flag + (row[flag] ? ' on' : '');
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (row.kind === 'virtual') {
            const entries = S.arrayEntries.get(row.arrayId) || [];
            setAvgFlag(row.arrayId, entries, flag, !row[flag]);
          } else {
            setRowFlag(row.id, flag, !row[flag], S.index.get(row.id));
          }
        });
        tgs.appendChild(b);
      }
      el.addEventListener('click', (e) => {
        if (e.target.closest('.sel-x') || e.target.closest('.tgl')) return;
        if (row.kind === 'virtual') { toast('AVG 虚拟行没有地址，可在左侧数组表里管理'); return; }
        openDrawer();
        setTimeout(() => {
          const inp = document.querySelector('.calib-row[data-id="' + CSS.escape(row.id) + '"] input');
          if (inp) inp.focus();
        }, 80);
      });
      el.querySelector('.sel-x').addEventListener('click', (e) => {
        e.stopPropagation();
        removeSignal(row.id);
      });
      box.appendChild(el);
      S.selRows.set(row.id, el);
    }
    if (S.samples.length) refreshLiveValues();
    updateEmptyHint();
  }

  function renderLegend() {
    const box = D.legend;
    if (!box) return;
    box.innerHTML = '';
    S.legendEls.clear();
    for (const row of plotRows()) {
      const chip = document.createElement('div');
      chip.className = 'legend-chip' + (S.focusId === row.id ? ' focus' : '');
      if (S.focusPinned && S.focusId === row.id) chip.classList.add('pinned');
      chip.dataset.id = row.id;
      chip.title = row.kind === 'virtual'
        ? row.name + ' · 数组平均 · ' + (row.unit || '')
        : row.name + ' · ' + hex(row.addr) + ' · ' + (row.unit || '') + (row.step ? ' · step' : '') +
          '\n单击聚焦（其他路淡出），再次单击取消';
      chip.innerHTML = '<span class="dot"></span><span class="lname"></span><span class="lax"></span><span class="lval">—</span>';
      const dot = chip.querySelector('.dot');
      dot.style.background = row.color;
      dot.style.color = row.color;
      chip.querySelector('.lname').textContent = shortName(row.name);
      if (row.axis === 'right') chip.querySelector('.lax').textContent = 'R';
      if (row.kind === 'virtual') chip.querySelector('.lax').textContent = '';
      chip.addEventListener('pointerenter', () => setFocus(row.id, false));
      chip.addEventListener('pointerleave', () => { if (!S.focusPinned) setFocus(null, false); });
      chip.addEventListener('click', () => {
        if (S.focusPinned && S.focusId === row.id) {
          S.focusPinned = false;
          setFocus(null, false);
        } else {
          S.focusPinned = true;
          setFocus(row.id, true);
        }
      });
      box.appendChild(chip);
      S.legendEls.set(row.id, chip);
    }
    if (S.samples.length) refreshLiveValues();
  }

  function setFocus(id, pinned) {
    if (S.focusId === id && pinned === S.focusPinned) return;
    S.focusId = id;
    if (!pinned && !id) S.focusPinned = false;
    for (const [rid, chip] of S.legendEls.entries()) {
      const on = !id || rid === id;
      chip.classList.toggle('dim', !on);
      chip.classList.toggle('focus', rid === id);
      chip.classList.toggle('pinned', rid === id && S.focusPinned);
    }
    S.dirty = true;
  }

  function setTableOpen(open) {
    S.ui.tableOpen = !!open;
    syncTablePanel();
    saveLocal();
    S.dirty = true;
  }

  function syncTablePanel() {
    if (!D.tableCard) return;
    D.tableCard.classList.toggle('collapsed', !S.ui.tableOpen);
    if (D.btnTableToggle) D.btnTableToggle.setAttribute('aria-expanded', S.ui.tableOpen ? 'true' : 'false');
  }

  function updateViewSeg() {
    const seg = $('#viewSeg');
    if (!seg) return;
    for (const b of seg.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.view === S.ui.view);
    }
  }

  function renderValueTable() {
    const body = D.valueTable;
    if (!body) return;
    body.innerHTML = '';
    S.vtRows.clear();
    const rows = tableRows();
    if (D.tableCount) D.tableCount.textContent = String(rows.length);
    if (!rows.length) {
      body.innerHTML = '<div class="vt-empty">还没有“表”打开的项；在左侧信号行或数组表里点“表”。</div>';
      if (D.tableSum) D.tableSum.textContent = '';
      return;
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'vt-row' + (row.kind === 'virtual' ? ' avg' : '');
      el.dataset.id = row.id;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = row.color;
      dot.style.color = row.color;
      const nm = document.createElement('span');
      nm.className = 'vt-name';
      nm.textContent = shortName(row.name);
      nm.title = row.kind === 'virtual' ? row.name : hex(row.addr) + ' · ' + row.name;
      const cur = document.createElement('span');
      cur.className = 'num vt-cur';
      cur.textContent = '—';
      const mn = document.createElement('span'); mn.className = 'num vt-stat'; mn.textContent = '--';
      const mx = document.createElement('span'); mx.className = 'num vt-stat'; mx.textContent = '--';
      const av = document.createElement('span'); av.className = 'num vt-stat'; av.textContent = '--';
      const un = document.createElement('span'); un.className = 'vt-c-unit'; un.textContent = row.unit || '';
      el.append(dot, nm, cur, mn, mx, av, un);
      body.appendChild(el);
      S.vtRows.set(row.id, { cur, min: mn, max: mx, avg: av });
    }
    updateTableStats();
    if (S.samples.length) refreshLiveValues();
  }

  function updateEmptyHint() {
    const hasPlot = plotRows().length > 0;
    const hasTable = tableRows().length > 0;
    D.empty.classList.toggle('hidden', hasPlot);
    const div = D.empty.querySelector('div');
    const small = D.empty.querySelector('small');
    if (div) div.textContent = '还没有波形';
    if (small) {
      small.textContent = hasTable
        ? '数值表里有信号；把对应行的“波”打开就会画出来'
        : '在左侧把“波”打开，或点击“连接”';
    }
  }

  // ---------------------------------------------------------------- stall selects / calibration
  function renderStallSelects() {
    for (const [el, current] of [[D.curSel, S.stall.currentId], [D.thrSel, S.stall.thresholdId]]) {
      if (!el) continue;
      el.innerHTML = '';
      const usable = S.signals.filter((x) => !isHidden(x));
      if (!usable.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '（先添加信号）';
        el.appendChild(o);
        continue;
      }
      for (const s of usable) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        el.appendChild(o);
      }
      const want = current || usable[0].id;
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
    const rows = Array.from(S.rows.values()).filter((r) => !r.support);
    if (!rows.length) {
      box.innerHTML = '<div class="muted" style="font-size:10.5px">先添加信号</div>';
      return;
    }
    for (const sig of rows) {
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

  function ensureGlowBuffer(pw, ph) {
    const b = S.glowBuf;
    const w = clamp(Math.round(pw * 0.55), 240, 640);
    const h = clamp(Math.round(ph * 0.55), 140, 400);
    if (!b.cv) b.cv = document.createElement('canvas');
    if (!b.ctx) b.ctx = b.cv.getContext('2d');
    if (b.w !== w || b.h !== h) {
      b.w = w; b.h = h;
      b.cv.width = w; b.cv.height = h;
      b.ctx.setTransform(1, 0, 0, 1, 0, 0);
      b.ctx.clearRect(0, 0, w, h);
    }
    return b;
  }

  function primaryRow(rows) {
    const cur = byId(S.stall.currentId);
    if (cur && cur.plot) return cur;
    return rows.find((r) => r.kind !== 'virtual' && /current/i.test(r.name)) ||
      rows.find((r) => r.kind === 'virtual') || rows[0] || null;
  }

  function axisRef(range) {
    if (range.min <= 0 && range.max >= 0) return { v: 0, label: '0' };
    return { v: (range.min + range.max) / 2, label: 'mid' };
  }

  function drawZeroLine(ctx, range, Y, x0, pw, y0, ph, color) {
    const ref = axisRef(range);
    const y = Math.round(Y(ref.v)) + 0.5;
    if (y < y0 + 1 || y > y0 + ph - 1) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + pw, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '9px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const ly = y - 3 < y0 + 9 ? y + 11 : y - 3;
    ctx.fillStyle = 'rgba(190,210,232,.55)';
    ctx.fillText(ref.label, x0 + 4, ly);
    ctx.restore();
  }

  function draw() {
    const cv = D.chart;
    const ctx = cv.getContext('2d');
    const W = S.size.w, H = S.size.h;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const rows = plotRows();
    const anyRight = rows.some((s) => s.axis === 'right');
    const pad = { l: 58, r: anyRight ? 56 : 16, t: 16, b: 36 };
    const x0 = pad.l, y0 = pad.t;
    const pw = Math.max(10, W - pad.l - pad.r);
    const ph = Math.max(10, H - pad.t - pad.b);
    const end = S.paused ? (S.pauseAt || S.lastT) : S.lastT;
    const start = end - S.windowSec * 1000;

    const range = sampleRange(start, end);
    const i0 = range[0], i1 = range[1];

    const leftSigs = rows.filter((s) => s.axis !== 'right');
    const rightSigs = rows.filter((s) => s.axis === 'right');
    const axisRange = (list) => {
      let mn = Infinity, mx = -Infinity, dmin = Infinity;
      for (const row of list) {
        for (let i = i0; i < i1; i++) {
          const tv = rowValue(row, S.samples[i][1]);
          if (tv === null || !isFinite(tv)) continue;
          if (tv < mn) mn = tv;
          if (tv < dmin) dmin = tv;
          if (tv > mx) mx = tv;
        }
      }
      if (!isFinite(mn)) return null;
      const mid = (mx + mn) / 2;
      const minSpan = Math.max(2, Math.abs(mid) * 0.10);
      if (mx - mn < minSpan) { mn = mid - minSpan / 2; mx = mid + minSpan / 2; }
      const p = (mx - mn) * 0.08;
      mn -= p; mx += p;
      if (S.autoZero) mn = Math.min(0, mn);
      else if (dmin >= 0 && mn < 0) mn = Math.max(0, mn);
      return { min: mn, max: mx };
    };
    const left = axisRange(leftSigs) || { min: 0, max: 1 };
    const right = axisRange(rightSigs) || { min: 0, max: 1 };
    const labelLeft = leftSigs.length ? left : right;
    S.view = { x0, y0, pw, ph, start, end, left, right, anyRight };

    const X = (t) => x0 + ((t - start) / Math.max(1, end - start)) * pw;
    const YL = (v) => y0 + ph - ((v - labelLeft.min) / Math.max(1e-9, labelLeft.max - labelLeft.min)) * ph;
    const YR = (v) => y0 + ph - ((v - right.min) / Math.max(1e-9, right.max - right.min)) * ph;
    const yFor = (row, v) => (row.axis === 'right' ? YR(v) : YL(v));

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

    // 0 / center reference
    if (S.zeroLine) {
      if (leftSigs.length) drawZeroLine(ctx, left, YL, x0, pw, y0, ph, 'rgba(190,214,240,.26)');
      if (anyRight) drawZeroLine(ctx, right, YR, x0, pw, y0, ph, 'rgba(96,165,250,.16)');
    }

    // axes
    ctx.strokeStyle = 'rgba(120,150,190,.22)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0); ctx.lineTo(x0 + 0.5, y0 + ph + 0.5); ctx.lineTo(x0 + pw, y0 + ph + 0.5);
    if (anyRight) { ctx.moveTo(x0 + pw + 0.5, y0); ctx.lineTo(x0 + pw + 0.5, y0 + ph); }
    ctx.stroke();

    const primary = primaryRow(rows);
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
    if (S.fillOn && primary && primary.plot) {
      const row = primary;
      if (i1 - i0 > 1) {
        ctx.beginPath();
        let started = false;
        for (let i = i0; i < i1; i++) {
          const v = rowValue(row, S.samples[i][1]);
          if (v === null) continue;
          const x = X(S.samples[i][0]);
          const y = yFor(row, v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        if (started) {
          const lastX = X(S.samples[i1 - 1][0]);
          ctx.lineTo(lastX, y0 + ph);
          ctx.lineTo(X(S.samples[i0][0]), y0 + ph);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, y0, 0, y0 + ph);
          g.addColorStop(0, hexAlpha(row.color, .14));
          g.addColorStop(1, hexAlpha(row.color, 0));
          ctx.fillStyle = g;
          ctx.fill();
        }
      }
    }

    const focus = S.focusId;
    const alphaFor = (row) => {
      if (focus) return row.id === focus ? 1 : 0.12;
      return row.id === (primary && primary.id) ? 1 : 0.62;
    };
    const widthFor = (row) => {
      const isThr = row.id === S.stall.thresholdId || /threshold/i.test(row.name) || row.name.endsWith('.thresholdLast');
      if (isThr) return 1.2;
      return row.id === (primary && primary.id) ? 2.2 : 1.15;
    };

    // traces
    for (const row of rows) {
      const isThr = row.id === S.stall.thresholdId || /threshold/i.test(row.name);
      const isPrimary = primary && row.id === primary.id;
      const alpha = alphaFor(row);
      ctx.beginPath();
      let started = false, prevY = 0;
      for (let i = i0; i < i1; i++) {
        const v = rowValue(row, S.samples[i][1]);
        if (v === null) continue;
        const x = X(S.samples[i][0]);
        const y = yFor(row, v);
        if (!started) {
          ctx.moveTo(x, y); started = true;
        } else if (row.step) {
          ctx.lineTo(x, prevY);
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevY = y;
      }
      if (!started) continue;
      if (S.glow) {
        // 轻量光晕：不累积亮度缓冲，只沿当前路径加一圈低 alpha 辉光，
        // 避免把整条历史反复叠加成一片白。
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = hexAlpha(row.color, 0.055 * alpha);
        ctx.lineWidth = widthFor(row) * 5.5;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.strokeStyle = hexAlpha(row.color, 0.10 * alpha);
        ctx.lineWidth = widthFor(row) * 2.4;
        ctx.stroke();
        ctx.restore();
      }
      ctx.lineWidth = widthFor(row);
      ctx.strokeStyle = alpha >= 1 ? row.color : hexAlpha(row.color, alpha);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(isThr ? [6, 4] : []);
      if (isPrimary && !focus) {
        ctx.save();
        ctx.shadowColor = hexAlpha(row.color, .55);
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
        for (const row of rows) {
          const v = rowValue(row, nearest[1]);
          if (v === null) continue;
          const y = yFor(row, v);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = row.color;
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
    for (const row of plotRows()) {
      const v = rowValue(row, near[1]);
      if (v === null) continue;
      rows.push('<div class="ct-row"><span class="dot" style="background:' + row.color + ';color:' + row.color + '"></span>' +
        '<span>' + esc(shortName(row.name)) + '</span><span class="v">' + esc(fmtPhysical(row, v)) + '</span></div>');
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

  // ---------------------------------------------------------------- topbar fit
  function setupTopbarFit() {
    if (!D.topbar || !D.actions) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; fitTopbar(); });
    };
    if (window.ResizeObserver) new ResizeObserver(schedule).observe(D.topbar);
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => {});
    schedule();
  }

  function fitTopbar() {
    const actions = D.actions;
    if (!actions) return;
    const wasCompact = actions.classList.contains('compact');
    // 量的是“图标+文字”的自然宽度：先临时去掉 compact，再恢复
    if (wasCompact) actions.classList.remove('compact');
    const kids = Array.from(actions.children).filter((el) => getComputedStyle(el).display !== 'none');
    let need = 0;
    for (const el of kids) need += el.offsetWidth;
    const gap = parseFloat(getComputedStyle(actions).gap) || 6;
    need += gap * Math.max(0, kids.length - 1);
    const avail = actions.clientWidth;
    // 带回差，避免边界抖动导致文字反复闪现
    const compact = wasCompact ? (need + 28 > avail) : (need > avail);
    actions.classList.toggle('compact', compact);
    S.ui.topCompact = compact;
  }

  // ---------------------------------------------------------------- UI bindings
  function bindUI() {
    window.addEventListener('resize', () => { resizeChart(); fitTopbar(); });
    if (window.ResizeObserver) new ResizeObserver(resizeChart).observe(D.wrap);
    setupTopbarFit();

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
    $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
      S.ui.view = b.dataset.view === 'tree' ? 'tree' : 'list';
      updateViewSeg();
      saveLocal();
      renderCatalog();
    }));
    $('#btnReloadSymbols').addEventListener('click', reloadCatalog);

    // value table collapse
    D.btnTableToggle?.addEventListener('click', (e) => { e.stopPropagation(); setTableOpen(!S.ui.tableOpen); });
    D.tableHead?.addEventListener('click', (e) => {
      if (e.target.closest('#btnTableToggle')) return;
      setTableOpen(!S.ui.tableOpen);
    });
    syncTablePanel();

    // toolbar
    D.winSel.addEventListener('change', () => { S.windowSec = Number(D.winSel.value); D.winSel2.value = D.winSel.value; saveLocal(); S.dirty = true; });
    D.winSel2.addEventListener('change', () => { S.windowSec = Number(D.winSel2.value); D.winSel.value = D.winSel2.value; saveLocal(); S.dirty = true; });
    $('#autoZero').addEventListener('change', (e) => { S.autoZero = e.target.checked; saveLocal(); S.dirty = true; });
    $('#fillOn').addEventListener('change', (e) => { S.fillOn = e.target.checked; saveLocal(); S.dirty = true; });
    $('#gridOn').addEventListener('change', (e) => { S.gridOn = e.target.checked; saveLocal(); S.dirty = true; });
    $('#zeroLine').addEventListener('change', (e) => { S.zeroLine = e.target.checked; saveLocal(); S.dirty = true; });
    $('#glowOn').addEventListener('change', (e) => { S.glow = e.target.checked; saveLocal(); S.dirty = true; });

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
    $('#btnImportAxf').addEventListener('click', importAxf);
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
    const tgl = e.target.closest('[data-row-toggle]');
    if (tgl) {
      e.preventDefault();
      e.stopPropagation();
      const id = tgl.dataset.rowToggle;
      const flag = tgl.dataset.flag;
      const row = S.rows.get(id);
      setRowFlag(id, flag, !(row && row[flag]), S.index.get(id));
      return;
    }
    const atgl = e.target.closest('[data-avg-toggle]');
    if (atgl) {
      e.preventDefault();
      e.stopPropagation();
      const arrayId = atgl.dataset.avgToggle;
      const entries = S.arrayEntries.get(arrayId) || [];
      const v = S.virtuals.find((x) => x.arrayId === arrayId);
      setAvgFlag(arrayId, entries, atgl.dataset.flag, !(v && v[atgl.dataset.flag]));
      return;
    }
    const treeHead = e.target.closest('.tree-head');
    if (treeHead) {
      const key = treeHead.dataset.node;
      if (key) {
        if (S.ui.openNodes.has(key)) S.ui.openNodes.delete(key); else S.ui.openNodes.add(key);
        treeHead.parentElement.classList.toggle('open');
      }
      return;
    }
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
    const existing = S.rows.get(id);
    if (existing) {
      // 两个开关都关是合法状态；行点击只在这两种状态间切换
      setBothFlags(id, !(existing.table || existing.plot));
      return;
    }
    addSignal(id, { table: true, plot: true });
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
    const label = D.btnPause.querySelector('.btn-label');
    if (label) label.textContent = S.paused ? '继续' : '暂停';
    D.btnPause.setAttribute('aria-label', S.paused ? '继续' : '暂停');
    D.btnPause.title = (S.paused ? '继续' : '暂停') + ' (空格)';
    if (typeof fitTopbar === 'function') fitTopbar();
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
    for (const el of S.avgCells.values()) el.textContent = '—';
    for (const vt of S.vtRows.values()) {
      vt.cur.textContent = '—';
      vt.min.textContent = '--';
      vt.max.textContent = '--';
      vt.avg.textContent = '--';
    }
    S.lastStatsAt = 0;
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
    const rows = [];
    for (const r of S.rows.values()) if (r.table || r.plot) rows.push(r);
    for (const v of S.virtuals) if (v.table || v.plot) rows.push(v);
    if (!rows.length) { toast('没有可导出的通道', 'err'); return; }
    const lines = [];
    lines.push(['t_s'].concat(rows.map((r) => r.name + (r.unit ? ' [' + r.unit + ']' : ''))).map(csvCell).join(','));
    const t0 = S.samples[0][0];
    for (const [t, vals] of S.samples) {
      const line = [((t - t0) / 1000).toFixed(3)];
      for (const row of rows) {
        const v = rowValue(row, vals);
        line.push(v === null || !isFinite(v) ? '' : String(Number(v.toFixed(4))));
      }
      lines.push(line.join(','));
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

  function applyCatalog(catalog, note = '') {
    S.catalog = catalog;
    buildIndex();
    S.samples = [];
    S.lastT = 0;
    resetStall();
    let missing = 0;
    // 按 id 重新解析地址；新 AXF 里不存在的旧行删掉，避免拿旧地址继续采样
    for (const [id, row] of Array.from(S.rows.entries())) {
      const e = S.index.get(id);
      if (e) {
        row.addr = e.addr; row.size = e.size; row.signed = e.signed;
        row.bit = e.bit; row.type = e.type; row.name = e.name || row.name;
      } else {
        S.rows.delete(id);
        missing++;
      }
    }
    S.virtuals = S.virtuals.filter((v) => (v.sourceIds || []).some((id) => S.index.has(id)));
    syncChannels();
    renderCatalog(); renderSelected(); renderLegend(); renderValueTable();
    renderStallSelects(); renderCalib();
    sendConfig(true);
    if (D.catalogMeta && catalog.meta) {
      D.catalogMeta.textContent = 'AXF ' + (catalog.meta.generated_at || '?') + ' · ' +
        (catalog.variables ? catalog.variables.length : 0) + ' 变量 / ' +
        (catalog.peripherals ? catalog.peripherals.length : 0) + ' 外设 · ' +
        (catalog.meta.axf || '');
    }
    if (missing) toast(missing + ' 个旧信号在新 AXF 里找不到，已移除', 'err');
    if (note) toast(note, 'ok');
  }

  async function reloadCatalog() {
    toast('正在从 AXF 重建符号表…');
    try {
      const res = await post('/api/catalog/reload', {});
      if (!res.ok) throw new Error(res.error || '失败');
      applyCatalog(res.catalog, '符号表已更新');
    } catch (e) {
      toast('重建失败: ' + e.message, 'err');
    }
  }

  async function importAxf() {
    const axf = D.axfFile?.files?.[0];
    if (!axf) { toast('先选择 .axf / .elf 文件', 'err'); return; }
    const hdr = D.hdrFile?.files?.[0];
    const fd = new FormData();
    fd.append('axf', axf, axf.name || 'firmware.axf');
    if (hdr) fd.append('header', hdr, hdr.name || 'cw32l011.h');
    const btn = D.btnImportAxf;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '解析中…'; }
    toast('正在解析 AXF…');
    try {
      const res = await fetch('/api/catalog/import', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      if (!res.ok || !data.ok) throw new Error(data.error || '导入失败');
      applyCatalog(data.catalog);
      toast('AXF 已导入：' + data.counts.variables + ' 变量 / ' +
        data.counts.peripherals + ' 外设', 'ok');
      if (data.warning) toast(data.warning, 'err');
    } catch (e) {
      toast('导入失败: ' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || '导入并重建符号'; }
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
