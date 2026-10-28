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
    // 顶部 3 张可配置监视卡片；mode='margin' 时是内置“阈值-电流”
    watch: [
      { key: 'w1', title: '电机电流', mode: 'value', signal: 'motor.over.current', addr: 0, size: 2, signed: false, bit: null, unit: 'counts', rowId: 'motor.over.current' },
      { key: 'w2', title: '堵转阈值', mode: 'value', signal: 'motor.over.thresholdLast', addr: 0, size: 2, signed: false, bit: null, unit: 'counts', rowId: 'motor.over.thresholdLast' },
      { key: 'w3', title: '余量', mode: 'margin', signal: '', addr: 0, size: 2, signed: false, bit: null, unit: 'counts', rowId: '' },
    ],
    // 波形分组：默认分组内每路独立轴；拖入自定义组则共享轴
    wave: {
      groups: [{ id: 'default', name: '默认分组', visible: true, auto: true }],
      seq: 1,
    },
    // 写入窗口：多个独立模块，每个有自己的类型/范围/实时/状态
    write: {
      armed: false, size: 'md', seq: 1,
      mods: [{
        id: 'wm1', rowId: 'motor.over.threshold', mode: 'slider',
        width: 0.5, widthTouched: false,
        min: 0, max: 4095, step: 1, live: false,
        status: '', statusKind: '', busy: false, pending: null, timer: 0,
        liveTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
      }],
    },
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
      sections: { chart: true, table: true, write: true },
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

  const PROJECTS_KEY = 'ms.projects.v2';

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
    D.chartCard = $('#chartCard');
    D.selectedHead = $('#selectedHead');
    D.sectionTabs = $('#sectionTabs');
    D.selectedCount = $('#selectedCount');
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
    D.mCurrent = $('#mCurrent');
    D.watchCards = { w1: $('#mCurrent'), w2: $('#mThreshold'), w3: $('#mMargin') };
    D.watchSignals = $('#watchSignals');
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
    D.calibModal = $('#calibModal');
    D.calibTarget = $('#calibTarget');
    D.calScale = $('#calScale');
    D.calOffset = $('#calOffset');
    D.calUnit = $('#calUnit');
    D.calAxis = $('#calAxis');
    D.curSel = $('#curSel');
    D.thrSel = $('#thrSel');
    D.catalogMeta = $('#catalogMeta');
    D.axfFile = $('#axfFile');
    D.hdrFile = $('#hdrFile');
    D.btnImportAxf = $('#btnImportAxf');
    D.writeCard = $('#writeCard');
    D.writeList = $('#writeList');
    D.writeArmed = $('#writeArmed');
    D.writeState = $('#writeState');
    D.writeSize = $('#writeSize');
    D.projectSel = $('#projectSel');
    D.projectSel2 = $('#projectSel2');
    D.projectState = $('#projectState');
    D.projectFile = $('#projectFile');
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
    renderWatchDatalist();
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
  // 只要行不在表/波形里，就不算可见。S.signals 里的隐藏行只有两种来源：
  // 数组 AVG 的支撑通道，或作为写入目标的 write-only 行。
  function isHidden(row) { return !row.table && !row.plot; }
  function plotRows() {
    const out = [];
    for (const r of S.rows.values()) if (r.plot) out.push(r);
    for (const v of S.virtuals) if (v.plot) out.push(v);
    return out;
  }

  function ensureWaveGroups() {
    if (!S.wave || !Array.isArray(S.wave.groups) || !S.wave.groups.length) {
      S.wave = { groups: [{ id: 'default', name: '默认分组', visible: true, auto: true }], seq: 1 };
    }
    if (!S.wave.groups.some((g) => g.id === 'default')) {
      S.wave.groups.unshift({ id: 'default', name: '默认分组', visible: true, auto: true });
    }
    const ids = new Set(S.wave.groups.map((g) => g.id));
    for (const row of plotRows()) {
      if (!row.groupId || !ids.has(row.groupId)) row.groupId = 'default';
    }
  }

  function waveGroupFor(row) {
    const gid = (row && row.groupId) || 'default';
    return S.wave.groups.find((g) => g.id === gid) || S.wave.groups[0];
  }

  function visiblePlotRows() {
    return plotRows().filter((row) => {
      const g = waveGroupFor(row);
      return !g || g.visible !== false;
    });
  }

  function assignWaveGroup(rowId, groupId) {
    const row = rowById(rowId);
    const g = S.wave.groups.find((x) => x.id === groupId);
    if (!row || !g) return;
    row.groupId = groupId;
    if (g.visible === false) g.visible = true;
    renderCatalog();
    renderSelected();
    renderLegend();
    updateEmptyHint();
    S.dirty = true;
    saveLocal();
  }

  function toggleWaveGroup(groupId) {
    const g = S.wave.groups.find((x) => x.id === groupId);
    if (!g) return;
    g.visible = g.visible === false;
    renderCatalog();
    renderSelected();
    renderLegend();
    updateEmptyHint();
    S.dirty = true;
    saveLocal();
  }

  function addWaveGroup() {
    const name = (prompt('新分组名称（拖入同一组的波形共享坐标轴）', '分组 ' + (S.wave.seq + 1)) || '').trim();
    if (!name) return;
    S.wave.seq += 1;
    S.wave.groups.push({ id: 'wg' + S.wave.seq, name, visible: true, auto: false });
    renderCatalog();
    saveLocal();
    toast('已新建波形分组：' + name, 'ok');
  }

  function deleteWaveGroup(groupId) {
    const g = S.wave.groups.find((x) => x.id === groupId);
    if (!g) return;
    if (g.id === 'default') { toast('默认分组不能删除，可以隐藏', 'err'); return; }
    if (!confirm('删除分组“' + g.name + '”？组内波形会回到默认分组。')) return;
    for (const row of plotRows()) if (row.groupId === groupId) row.groupId = 'default';
    S.wave.groups = S.wave.groups.filter((x) => x.id !== groupId);
    renderCatalog();
    renderSelected();
    renderLegend();
    updateEmptyHint();
    S.dirty = true;
    saveLocal();
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

  // “已选择”里要同时看到表/波；按 plot 优先、table 补充，去重
  function selectedRows() {
    const out = [];
    const seen = new Set();
    for (const r of plotRows()) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
    for (const r of tableRows()) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
    return out;
  }

  function syncSections() {
    const secs = S.ui.sections || (S.ui.sections = { chart: true, table: true, write: true });
    for (const [key, el] of [['chart', D.chartCard], ['table', D.tableCard], ['write', D.writeCard]]) {
      if (el) el.classList.toggle('section-hidden', secs[key] === false);
    }
    if (D.sectionTabs) {
      D.sectionTabs.querySelectorAll('button[data-sec]').forEach((b) => {
        b.classList.toggle('active', secs[b.dataset.sec] !== false);
        b.setAttribute('aria-pressed', secs[b.dataset.sec] !== false ? 'true' : 'false');
      });
    }
    if (D.selectedCount) D.selectedCount.textContent = String(selectedRows().length);
  }

  function toggleSection(sec) {
    if (!sec) return;
    if (!S.ui.sections) S.ui.sections = { chart: true, table: true, write: true };
    S.ui.sections[sec] = S.ui.sections[sec] === false;
    syncSections();
    saveLocal();
    if (sec === 'chart' && S.ui.sections.chart) requestAnimationFrame(() => resizeChart());
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
      groupId: String(d.groupId || ''),
      writeOnly: !!d.writeOnly,
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
    if (row.plot) {
      row.groupId = row.groupId || 'default';
      const g = waveGroupFor(row);
      if (g) g.visible = true;
    }
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
      row.groupId = 'default';
      if (row.plot) { const g = waveGroupFor(row); if (g) g.visible = true; }
      S.rows.set(id, row);
      afterSignalsChanged();
      return;
    }
    if (row.support && on) row.support = false;
    if (on) row.writeOnly = false;
    row[flag] = !!on;
    if (on && row.plot) { const g = waveGroupFor(row); if (g) g.visible = true; }
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
    if (on) row.writeOnly = false;
    if (on && row.plot) { const g = waveGroupFor(row); if (g) g.visible = true; }
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
    if (on && v.plot) { const g = waveGroupFor(v); if (g) g.visible = true; }
    if (!v.table && !v.plot) removeVirtual(v);
    afterSignalsChanged();
  }

  function syncChannels() {
    const beforeIds = S.signals.map((s) => s.id);
    const before = beforeIds.join('|');
    const need = new Set();
    for (const r of S.rows.values()) if (r.table || r.plot) need.add(r.id);
    for (const v of S.virtuals) for (const id of v.sourceIds) need.add(id);
    // 写入模块 / 监视卡片即使不在表/波形里，也要采样，才能显示当前值和回读
    for (const m of S.write.mods) if (m.rowId && S.rows.has(m.rowId)) need.add(m.rowId);
    for (const c of S.watch) if (c.mode === 'value' && c.rowId && S.rows.has(c.rowId)) need.add(c.rowId);
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
      // 服务端会在通道构成变化时清历史；但前端保留已有样本，按 id 重映射列。
      // 新增通道在旧样本里填 null，波形从当前时刻接着画，不整屏清空。
      if (!beforeIds.length && S.samples.length) S.samples = [];
      if (beforeIds.length && S.samples.length) {
        const oldPos = new Map(beforeIds.map((id, i) => [id, i]));
        for (const s of S.samples) {
          const oldVals = s[1] || [];
          const nv = new Array(next.length).fill(null);
          for (let j = 0; j < next.length; j++) {
            const oi = oldPos.get(next[j].id);
            if (oi !== undefined && oi < oldVals.length) nv[j] = oldVals[oi];
          }
          s[1] = nv;
        }
      }
      S.lastChannelKey = after;
      scheduleHistoryReload();
      S.dirty = true;
      if (!byId(S.stall.currentId) || !byId(S.stall.thresholdId)) {
        S.stall.active = false;
        updateStallUI(S.lastT);
      }
    }
  }

  // ---------------------------------------------------------------- 监视卡片
  function watchCard(key) { return S.watch.find((c) => c.key === key) || null; }
  function watchRow(card) { return card && card.rowId ? S.rows.get(card.rowId) : null; }
  function watchSourceText(row) {
    if (!row) return '';
    const bit = Array.isArray(row.bit)
      ? '[' + (row.bit[1] > 1 ? (row.bit[0] + ':' + (row.bit[0] + row.bit[1] - 1)) : row.bit[0]) + ']'
      : '';
    return row.name + bit + ' @ ' + hex(row.addr, 6);
  }

  function watchDom(key) {
    D.watchEls = D.watchEls || {};
    if (D.watchEls[key]) return D.watchEls[key];
    const root = D.watchCards[key];
    if (!root) return null;
    const els = {
      root,
      title: root.querySelector('.watch-title'),
      val: root.querySelector('.watch-val'),
      unit: root.querySelector('.watch-unit'),
      src: root.querySelector('.watch-src'),
      bar: root.querySelector('.watch-bar i'),
      editor: root.querySelector('.watch-editor'),
    };
    D.watchEls[key] = els;
    return els;
  }

  function findTarget(text, size, signed) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^0x[0-9a-f]+$/i.test(t) || /^\d+$/.test(t)) {
      const addr = parseInt(t, /^0x/i.test(t) ? 16 : 10);
      if (!isFinite(addr) || addr < 0) return null;
      return { id: '', name: '@' + hex(addr, 4), addr: addr >>> 0, size, signed, bit: null, unit: '' };
    }
    let e = S.index.get(t);
    if (!e) {
      const low = t.toLowerCase();
      for (const x of S.index.values()) {
        if ((x.name || '').toLowerCase() === low || (x.id || '').toLowerCase() === low) { e = x; break; }
      }
    }
    if (!e || !e.addr) return null;
    return {
      id: e.id || e.name, name: e.name || e.id, addr: e.addr >>> 0,
      size: e.size || size, signed: !!e.signed,
      bit: Array.isArray(e.bit) ? [Number(e.bit[0]), Number(e.bit[1])] : null,
      unit: e.unit || inferUnit(e.name) || '',
    };
  }

  // 按 id 找符号；找不到时按显示名兜底（应对 AXF 里 id/name 轻微差异）
  function catalogEntryFor(id, name) {
    let e = id ? S.index.get(id) : null;
    if (e) return e;
    const n = String(name || '').trim();
    if (!n) return null;
    e = S.index.get(n);
    if (e) return e;
    const low = n.toLowerCase();
    for (const x of S.index.values()) {
      if ((x.name || '').toLowerCase() === low || (x.id || '').toLowerCase() === low) return x;
    }
    return null;
  }

  function ensureWatchRows() {
    const used = new Set();
    for (const card of S.watch) {
      if (card.mode !== 'value') { card.rowId = ''; continue; }
      if (card.signal && S.index.has(card.signal)) {
        const e = S.index.get(card.signal);
        card.addr = e.addr >>> 0;
        card.size = e.size || card.size || 2;
        card.signed = !!e.signed;
        card.bit = Array.isArray(e.bit) ? [Number(e.bit[0]), Number(e.bit[1])] : null;
        card.unit = e.unit || inferUnit(e.name) || '';
      }
      let row = card.rowId ? S.rows.get(card.rowId) : null;
      if (!row && card.signal && S.rows.has(card.signal)) {
        row = S.rows.get(card.signal);
        card.rowId = card.signal;
      }
      if (!row) {
        if (!card.addr) continue;
        const id = 'watch:' + card.key;
        row = S.rows.get(id);
        if (!row) {
          row = newRow({
            id, name: card.title || ('@' + hex(card.addr, 4)),
            addr: card.addr >>> 0, size: card.size || 2, signed: !!card.signed,
            bit: Array.isArray(card.bit) ? card.bit : null,
            kind: 'watch', group: '监视', type: ((card.size || 2) * 8) + 'b',
          }, { table: false, plot: false, support: false });
          S.rows.set(id, row);
        }
        row.addr = card.addr >>> 0;
        row.size = card.size || 2;
        row.signed = !!card.signed;
        row.bit = Array.isArray(card.bit) ? card.bit : null;
        row.name = card.title;
        row.unit = card.unit || '';
        row.watchOnly = true;
        card.rowId = id;
      }
      if (row && row.watchOnly) {
        row.addr = card.addr >>> 0;
        row.size = card.size || 2;
        row.signed = !!card.signed;
        row.bit = Array.isArray(card.bit) ? card.bit : null;
        row.name = card.title;
        row.unit = card.unit || '';
      }
      used.add(card.rowId);
    }
    for (const [id, row] of Array.from(S.rows.entries())) {
      if (row.watchOnly && !used.has(id) && !row.table && !row.plot && !row.support) S.rows.delete(id);
    }
  }

  function renderWatchDatalist() {
    if (!D.watchSignals) return;
    const frag = document.createDocumentFragment();
    for (const e of S.index.values()) {
      if (!e || !e.addr) continue;
      const o = document.createElement('option');
      o.value = e.id || e.name;
      if (e.name && e.name !== o.value) o.label = e.name;
      frag.appendChild(o);
    }
    D.watchSignals.innerHTML = '';
    D.watchSignals.appendChild(frag);
  }

  function renderWatchLabels() {
    for (const card of S.watch) {
      const els = watchDom(card.key);
      if (!els) continue;
      els.title.textContent = card.title;
      els.root.classList.toggle('custom-value', card.mode !== 'margin');
      const row = watchRow(card);
      els.src.textContent = card.mode === 'margin'
        ? '阈值 − 电流（内置）'
        : (row ? watchSourceText(row) : '未绑定');
      els.root.dataset.mode = card.mode;
    }
  }

  function refreshWatchValues(vals) {
    const last = Array.isArray(vals) ? vals : (latestSample() ? latestSample()[1] : null);
    for (const card of S.watch) {
      const els = watchDom(card.key);
      if (!els) continue;
      if (card.mode === 'margin') {
        const cur = byId(S.stall.currentId);
        const thr = byId(S.stall.thresholdId);
        const ci = cur ? cur.ci : -1;
        const ti = thr ? thr.ci : -1;
        if (last && ci >= 0 && ti >= 0 && ci < last.length && ti < last.length) {
          const cv = last[ci] * cur.scale + cur.offset;
          const tv = last[ti] * thr.scale + thr.offset;
          els.val.textContent = fmtInt(tv - cv);
          els.unit.textContent = cur.unit || '';
          const pct = tv > 0 ? clamp((cv / tv) * 100, 0, 100) : 0;
          if (els.bar) els.bar.style.width = pct.toFixed(1) + '%';
        } else {
          els.val.textContent = '--';
          els.unit.textContent = 'counts';
          if (els.bar) els.bar.style.width = '0%';
        }
        continue;
      }
      const row = watchRow(card);
      if (!row || row.ci < 0 || !last) {
        els.val.textContent = '--';
        els.unit.textContent = '';
        continue;
      }
      const raw = last[row.ci];
      if (raw === undefined || raw === null) {
        els.val.textContent = '--';
        els.unit.textContent = row.unit || '';
        continue;
      }
      els.val.textContent = fmtValue(row, raw);
      els.unit.textContent = row.unit || '';
      els.src.textContent = watchSourceText(row);
    }
  }

  function renderWatchAll() {
    renderWatchLabels();
    const last = latestSample();
    refreshWatchValues(last ? last[1] : null);
  }

  function closeWatchEditor() {
    for (const card of S.watch) {
      const els = watchDom(card.key);
      if (!els) continue;
      els.root.classList.remove('editing');
      if (els.editor) els.editor.classList.add('hidden');
    }
  }

  function openWatchEditor(key) {
    closeWatchEditor();
    const card = watchCard(key);
    const els = watchDom(key);
    if (!card || !els || !els.editor) return;
    const name = els.editor.querySelector('.we-name');
    const target = els.editor.querySelector('.we-target');
    const size = els.editor.querySelector('.we-size');
    const signed = els.editor.querySelector('.we-signed');
    const margin = els.editor.querySelector('.we-margin');
    if (name) name.value = card.title || '';
    if (target) {
      target.value = card.mode === 'margin' ? '' : (card.signal || (card.addr ? hex(card.addr, 4) : ''));
      target.disabled = card.mode === 'margin';
    }
    if (size) size.value = String(card.size || 2);
    if (signed) signed.checked = !!card.signed;
    if (margin) margin.checked = card.mode === 'margin';
    els.root.classList.add('editing');
    els.editor.classList.remove('hidden');
    if (name) setTimeout(() => { name.focus(); name.select(); }, 20);
  }

  function applyWatchEditor(key) {
    const card = watchCard(key);
    const els = watchDom(key);
    if (!card || !els || !els.editor) return;
    const name = (els.editor.querySelector('.we-name')?.value || '').trim();
    const targetText = (els.editor.querySelector('.we-target')?.value || '').trim();
    const size = Number(els.editor.querySelector('.we-size')?.value) || 2;
    const signed = !!els.editor.querySelector('.we-signed')?.checked;
    const margin = !!els.editor.querySelector('.we-margin')?.checked;
    if (margin) {
      card.mode = 'margin';
      card.signal = '';
      card.addr = 0;
      card.rowId = '';
      card.title = name || '余量';
    } else {
      if (!targetText) { toast('请填写信号名或 0x 地址', 'err'); return; }
      const t = findTarget(targetText, size, signed);
      if (!t) { toast('找不到信号或地址: ' + targetText, 'err'); return; }
      card.mode = 'value';
      card.signal = t.id;
      card.addr = t.addr;
      card.size = t.size;
      card.signed = t.signed;
      card.bit = t.bit || null;
      card.unit = t.unit || '';
      card.title = name || t.name || ('@' + hex(t.addr, 4));
      card.rowId = (t.id && S.rows.has(t.id)) ? t.id : ('watch:' + card.key);
    }
    ensureWatchRows();
    syncChannels();
    closeWatchEditor();
    renderWatchLabels();
    renderWatchAll();
    saveLocal();
    sendConfig();
    S.dirty = true;
  }

  // ---------------------------------------------------------------- 写入模块
  function latestRawOf(row) {
    const last = latestSample();
    if (!last || !row || row.ci === undefined || row.ci < 0) return null;
    const v = last[1][row.ci];
    return v === undefined ? null : v;
  }

  function resetWriteRange(row, mod) {
    if (!row || !mod) return;
    const bits = row.width || (row.size * 8);
    let max = bits >= 32 ? 1000000 : ((1 << bits) - 1);
    if (/threshold/i.test(row.name)) max = Math.min(max, 4095);
    mod.min = 0;
    mod.max = max;
    mod.step = 1;
  }

  const WRITE_WIDTH_STEPS = [0.25, 1 / 3, 0.5, 1];
  function defaultWriteWidth(mode) { return mode === 'switch' ? 0.25 : 0.5; }
  function widthLabel(w) {
    if (Math.abs(w - 0.25) < 0.01) return '1/4';
    if (Math.abs(w - 1 / 3) < 0.01) return '1/3';
    if (Math.abs(w - 0.5) < 0.01) return '1/2';
    return '1';
  }
  function widthSpan(w) {
    if (Math.abs(w - 0.25) < 0.01) return 3;
    if (Math.abs(w - 1 / 3) < 0.01) return 4;
    if (Math.abs(w - 0.5) < 0.01) return 6;
    return 12;
  }
  function nextWriteWidth(w) {
    const i = WRITE_WIDTH_STEPS.findIndex((x) => Math.abs(x - w) < 0.01);
    return WRITE_WIDTH_STEPS[(i < 0 ? 0 : i + 1) % WRITE_WIDTH_STEPS.length];
  }

  function makeWriteMod(row) {
    S.write.seq = (S.write.seq || 0) + 1;
    const mod = {
      id: 'wm' + S.write.seq, rowId: row.id, mode: 'slider',
      width: 0.5, widthTouched: false,
      min: 0, max: 0, step: 1, live: false,
      status: '', statusKind: '', busy: false, pending: null, timer: 0,
      liveTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
      addr: row.addr, size: row.size, signed: !!row.signed, name: row.name,
    };
    resetWriteRange(row, mod);
    return mod;
  }

  function releaseWriteRows() {
    const used = new Set(S.write.mods.map((m) => m.rowId));
    for (const c of S.watch) if (c.rowId) used.add(c.rowId);
    for (const [id, row] of Array.from(S.rows.entries())) {
      if (row.writeOnly && !used.has(id) && !row.table && !row.plot && !row.support) S.rows.delete(id);
    }
  }

  function ensureWriteMods() {
    const mods = [];
    for (const mod of S.write.mods || []) {
      if (!mod || !mod.rowId) continue;
      let row = S.rows.get(mod.rowId);
      const e = catalogEntryFor(mod.rowId, mod.name);
      if (e) {
        if (!row) {
          row = newRow(e, { table: false, plot: false, support: false });
          mod.rowId = e.id || mod.rowId;
          S.rows.set(mod.rowId, row);
        } else {
          // AXF 重新导入后，写入模块必须跟着新符号表更新地址/宽度/符号性
          row.addr = e.addr >>> 0;
          row.size = e.size || row.size || 2;
          row.signed = !!e.signed;
          row.bit = Array.isArray(e.bit) ? [Number(e.bit[0]), Number(e.bit[1])] : null;
          row.type = e.type || row.type;
          row.name = e.name || row.name;
        }
        row.writeOnly = !row.table && !row.plot && !row.support;
      } else if (!row) {
        if (mod.addr) {
          row = newRow({
            id: mod.rowId, name: mod.name || mod.rowId, addr: mod.addr,
            size: mod.size || 2, signed: !!mod.signed, bit: null,
            kind: 'write', group: '写入', type: ((mod.size || 2) * 8) + 'b',
          }, { table: false, plot: false, support: false });
          row.writeOnly = true;
          S.rows.set(mod.rowId, row);
        }
      }
      if (!row) continue;
      if (mods.some((m) => m.rowId === mod.rowId)) continue;
      if (!(mod.max > mod.min)) resetWriteRange(row, mod);
      if (!WRITE_WIDTH_STEPS.some((w) => Math.abs(w - mod.width) < 0.01)) {
        mod.width = defaultWriteWidth(mod.mode);
      }
      if (mod.widthTouched === undefined) mod.widthTouched = false;
      mod.addr = row.addr;
      mod.size = row.size;
      mod.signed = !!row.signed;
      mod.name = row.name;
      row.writeOnly = !row.table && !row.plot && !row.support;
      mods.push(mod);
    }
    S.write.mods = mods;
    releaseWriteRows();
  }

  function writeModForRow(rowId) {
    return S.write.mods.find((m) => m.rowId === rowId) || null;
  }

  function toggleWriteRow(rowId) {
    const existing = writeModForRow(rowId);
    if (existing) {
      S.write.mods = S.write.mods.filter((m) => m !== existing);
      stopLiveWrite(existing);
      existing.liveHeld = false;
      ensureWriteMods();
      afterSignalsChanged();
      toast('已从写入窗口移除：' + (S.index.get(rowId)?.name || rowId), 'ok');
      return;
    }
    let row = S.rows.get(rowId);
    const entry = S.index.get(rowId);
    if (!row) {
      if (!entry || !entry.addr) { toast('该信号没有可写地址', 'err'); return; }
      row = newRow(entry, { table: false, plot: false, support: false });
      row.writeOnly = true;
      S.rows.set(rowId, row);
    }
    if (!row.addr) { toast('该信号没有可写地址', 'err'); return; }
    S.write.mods.push(makeWriteMod(row));
    ensureWriteMods();
    afterSignalsChanged();
    toast('已加入写入窗口：' + (row.name || row.id), 'ok');
  }

  function applyWriteSize() {
    const size = ['sm', 'md', 'lg', 'auto'].includes(S.write.size) ? S.write.size : 'md';
    S.write.size = size;
    if (D.writeCard) {
      for (const s of ['sm', 'md', 'lg', 'auto']) D.writeCard.classList.toggle('size-' + s, s === size);
    }
    if (D.writeSize) D.writeSize.value = size;
  }

  function syncWriteUI() {
    applyWriteSize();
    const armed = !!S.write.armed;
    if (D.writeCard) D.writeCard.classList.toggle('locked', !armed);
    if (D.writeArmed) D.writeArmed.checked = armed;
    if (D.writeState) {
      D.writeState.textContent = armed ? ('已解锁 · ' + S.write.mods.length + ' 个模块') : '未解锁';
      D.writeState.className = armed ? 'ok' : 'muted';
    }
    if (!D.writeList) return;
    for (const mod of S.write.mods) {
      const el = D.writeList.querySelector('[data-mod="' + mod.id + '"]');
      if (!el) continue;
      const btn = el.querySelector('.wm-write');
      if (btn) {
        btn.disabled = !armed;
        btn.title = armed ? '写入当前值并回读' : '先勾选“允许写入”';
      }
    }
  }

  function renderWriteMods() {
    if (!D.writeList) return;
    stopAllLiveWrites();
    D.writeList.innerHTML = '';
    if (!S.write.mods.length) {
      const empty = document.createElement('div');
      empty.className = 'write-empty muted';
      empty.textContent = '还没有写入模块。左侧每个信号的“写”键可把该寄存器加入这里。';
      D.writeList.appendChild(empty);
      syncWriteUI();
      return;
    }
    for (const mod of S.write.mods) {
      const row = S.rows.get(mod.rowId);
      if (!row) continue;
      const el = document.createElement('div');
      el.className = 'write-mod' + (Math.abs(mod.width - 0.25) < 0.01 ? ' wm-quarter' : '');
      el.dataset.mod = mod.id;
      el.style.gridColumn = 'span ' + widthSpan(mod.width);

      const head = document.createElement('div');
      head.className = 'wm-head';
      const name = document.createElement('span');
      name.className = 'wm-name';
      name.textContent = row.name;
      name.title = row.name + '\n' + hex(row.addr) + ' · ' + row.size + 'B';
      const addr = document.createElement('span');
      addr.className = 'wm-addr';
      addr.textContent = '@' + hex(row.addr, 6);
      const seg = document.createElement('div');
      seg.className = 'seg small';
      for (const [mode, label] of [['slider', '滑条'], ['switch', '开关']]) {
        const b = document.createElement('button');
        b.dataset.mode = mode;
        b.textContent = label;
        b.classList.toggle('active', mod.mode === mode);
        b.addEventListener('click', () => {
          mod.mode = mode;
          mod.status = '';
          if (!mod.widthTouched) mod.width = defaultWriteWidth(mode);
          stopLiveWrite(mod);
          mod.liveHeld = false;
          renderWriteMods();
          saveLocal();
        });
        seg.appendChild(b);
      }
      const widthBtn = document.createElement('button');
      widthBtn.className = 'wm-width';
      widthBtn.textContent = widthLabel(mod.width);
      widthBtn.title = '模块宽度：1/4 → 1/3 → 1/2 → 整行（当前 ' + widthLabel(mod.width) + '）';
      widthBtn.addEventListener('click', () => {
        mod.width = nextWriteWidth(mod.width);
        mod.widthTouched = true;
        renderWriteMods();
        saveLocal();
      });
      const wbtn = document.createElement('button');
      wbtn.className = 'btn primary wm-write';
      wbtn.textContent = '写入';
      wbtn.title = '写入当前值并回读';
      wbtn.addEventListener('click', () => sendWrite(mod, Number(num.value)));
      const del = document.createElement('button');
      del.className = 'wm-del';
      del.textContent = '×';
      del.title = '从写入窗口移除';
      del.addEventListener('click', () => toggleWriteRow(mod.rowId));
      head.append(addr, seg, widthBtn, wbtn, del);

      const body = document.createElement('div');
      body.className = 'wm-body';
      const isSwitch = mod.mode === 'switch';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'wm-slider' + (isSwitch ? ' hidden' : '');
      slider.min = String(mod.min);
      slider.max = String(mod.max);
      slider.step = String(mod.step);
      const num = document.createElement('input');
      num.type = 'number';
      num.className = 'wm-number' + (isSwitch ? ' hidden' : '');
      const swWrap = document.createElement('label');
      swWrap.className = 'check wm-switch-wrap' + (isSwitch ? '' : ' hidden');
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      swWrap.append(sw, document.createTextNode(' 1'));
      const range = document.createElement('span');
      range.className = 'wm-range' + (isSwitch ? ' hidden' : '');
      const minI = document.createElement('input'); minI.type = 'number'; minI.value = String(mod.min); minI.title = '最小值';
      const maxI = document.createElement('input'); maxI.type = 'number'; maxI.value = String(mod.max); maxI.title = '最大值';
      const stepI = document.createElement('input'); stepI.type = 'number'; stepI.value = String(mod.step); stepI.title = '步长';
      range.append(document.createTextNode('范围 '), minI, document.createTextNode(' … '), maxI, document.createTextNode(' 步 '), stepI);
      const liveLab = document.createElement('label');
      liveLab.className = 'check wm-live';
      const live = document.createElement('input');
      live.type = 'checkbox';
      live.checked = !!mod.live;
      liveLab.append(live, document.createTextNode(' 实时'));
      const status = document.createElement('span');
      status.className = 'wm-status ' + (mod.statusKind || '');
      status.textContent = mod.status || (S.write.armed ? (latestRawOf(row) === null ? '等待样本' : '当前 ' + latestRawOf(row)) : '未解锁');
      body.append(slider, num, swWrap, range, liveLab, status);

      const raw = latestRawOf(row);
      if (raw !== null) {
        slider.value = String(clamp(raw, mod.min, mod.max));
        num.value = String(raw);
        sw.checked = !!raw;
      }

      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        num.value = String(v);
        mod.liveValue = v;
        // 实时关闭时只改 UI，不发写；必须点“写入”
      });
      slider.addEventListener('pointerdown', () => {
        if (!S.write.armed || !mod.live) return;
        mod.liveHeld = true;
        mod.liveValue = Number(slider.value);
        startLiveWrite(mod, mod.liveValue); // 按住每 100ms 写一次
      });
      slider.addEventListener('change', () => {
        // 松开/键盘提交：先停掉 100ms 定时，再补发最后位置（实时开启时）
        finishLiveWrite(mod);
        if (mod.live && S.write.armed) {
          const v = Number(slider.value);
          if (v !== mod.lastSent) sendWrite(mod, v);
        }
      });
      num.addEventListener('change', () => {
        const v = Number(num.value);
        slider.value = String(clamp(v, mod.min, mod.max));
        mod.liveValue = v;
        if (mod.live) sendWrite(mod, v);
      });
      sw.addEventListener('change', () => {
        const v = sw.checked ? 1 : 0;
        num.value = String(v);
        slider.value = String(v);
        // 实时关闭时开关也只改 UI，点击“写入”才发
        if (S.write.armed && mod.live) sendWrite(mod, v);
      });
      minI.addEventListener('change', () => {
        mod.min = Number(minI.value) || 0;
        if (mod.max <= mod.min) { mod.max = mod.min + 1; maxI.value = String(mod.max); }
        slider.min = String(mod.min);
        saveLocal();
      });
      maxI.addEventListener('change', () => {
        mod.max = Number(maxI.value) || 0;
        if (mod.max <= mod.min) { mod.min = Math.max(0, mod.max - 1); minI.value = String(mod.min); }
        slider.max = String(mod.max);
        saveLocal();
      });
      stepI.addEventListener('change', () => {
        mod.step = Math.max(1, Number(stepI.value) || 1);
        stepI.value = String(mod.step);
        slider.step = String(mod.step);
        saveLocal();
      });
      live.addEventListener('change', () => {
        mod.live = !!live.checked;
        if (!mod.live) { stopLiveWrite(mod); mod.liveHeld = false; }
        saveLocal();
      });
      wbtn.addEventListener('click', () => {
        const v = Number(num.value);
        sendWrite(mod, v);
      });

      el.append(head, name, body);
      D.writeList.appendChild(el);
    }
    syncWriteUI();
  }

  function refreshWriteUI() {
    if (!D.writeList) return;
    for (const mod of S.write.mods) {
      const el = D.writeList.querySelector('[data-mod="' + mod.id + '"]');
      if (!el) continue;
      const row = S.rows.get(mod.rowId);
      const raw = latestRawOf(row);
      const slider = el.querySelector('.wm-slider');
      const num = el.querySelector('.wm-number');
      const sw = el.querySelector('.wm-switch-wrap input');
      // 焦点在模块内（正在输入/按按钮/按住滑条）时不要用采样值覆盖用户输入
      const focused = el.contains(document.activeElement);
      if (raw !== null && !focused && !mod.busy) {
        if (slider) slider.value = String(clamp(raw, mod.min, mod.max));
        if (num) num.value = String(raw);
        if (sw) sw.checked = !!raw;
      }
      const st = el.querySelector('.wm-status');
      if (st) {
        if (mod.status) {
          st.textContent = mod.status;
          st.className = 'wm-status ' + (mod.statusKind || '');
        } else {
          st.textContent = S.write.armed ? (raw === null ? '等待样本' : '当前 ' + raw) : '未解锁';
          st.className = 'wm-status';
        }
      }
    }
  }

  async function sendWrite(mod, value) {
    const row = S.rows.get(mod.rowId);
    if (!row || !row.addr) {
      mod.status = '没有可写的目标'; mod.statusKind = 'err';
      refreshWriteUI(); toast(mod.status, 'err'); return;
    }
    if (!S.write.armed) {
      mod.status = '未解锁：先勾选“允许写入”'; mod.statusKind = 'err';
      refreshWriteUI(); toast(mod.status, 'err'); return;
    }
    let v = Number(value);
    if (!isFinite(v)) {
      mod.status = '写入值无效'; mod.statusKind = 'err';
      refreshWriteUI(); toast(mod.status, 'err'); return;
    }
    const bits = row.width || (row.size * 8);
    const max = Math.pow(2, bits) - 1;
    v = Math.max(0, Math.min(max, Math.trunc(v)));
    mod.lastSent = v;
    if (mod.busy) { mod.pending = v; return; }
    mod.busy = true;
    mod.status = '写入中…'; mod.statusKind = 'muted';
    refreshWriteUI();
    try {
      const res = await post('/api/write', {
        addr: row.addr, size: row.size, value: v, bit: row.bit || null, verify: true,
      });
      mod.status = '已写 ' + fmtInt(v) + ' · 回读 ' + fmtInt(res.readback) + (res.verified ? '' : '（不一致）');
      mod.statusKind = res.verified ? 'ok' : 'err';
      if (!res.verified) toast('写入已发出，但回读不一致（固件可能正在改它）', 'err');
    } catch (e) {
      mod.status = '写入失败: ' + e.message; mod.statusKind = 'err';
      toast(mod.status, 'err');
    } finally {
      mod.busy = false;
      refreshWriteUI();
      saveLocal();
      const pending = mod.pending;
      mod.pending = null;
      if (pending !== null && pending !== v) sendWrite(mod, pending);
    }
  }

  // ---- 实时写入: 按住滑条每 100ms 写一次, 松开立即停 ----
  function stopLiveWrite(mod) {
    if (mod.liveTimer) { clearInterval(mod.liveTimer); clearTimeout(mod.liveTimer); mod.liveTimer = null; }
    if (mod.timer) { clearTimeout(mod.timer); mod.timer = 0; }
  }

  function startLiveWrite(mod, value) {
    stopLiveWrite(mod);
    if (!mod.live || !S.write.armed) return;
    mod.liveValue = Number(value);
    const tick = () => {
      if (!mod.live || !S.write.armed) { stopLiveWrite(mod); return; }
      sendWrite(mod, mod.liveValue);
    };
    tick();
    mod.liveTimer = setInterval(tick, 100);
  }

  function finishLiveWrite(mod) {
    if (!mod.liveHeld) return;
    mod.liveHeld = false;
    stopLiveWrite(mod);
    // 松开时补发最后位置（若最后一次定时写还没覆盖到），之后不再持续写
    if (mod.live && S.write.armed && mod.liveValue !== mod.lastSent) {
      sendWrite(mod, mod.liveValue);
    }
  }

  function stopAllLiveWrites() {
    for (const mod of S.write.mods) {
      stopLiveWrite(mod);
      mod.liveHeld = false;
    }
  }

  function scheduleWrite(mod, value) {
    if (!mod.live || !S.write.armed) return;
    if (mod.timer) clearTimeout(mod.timer);
    mod.timer = setTimeout(() => { mod.timer = 0; sendWrite(mod, value); }, 120);
  }

  function scheduleHistoryReload() {
    if (S.historyTimer) clearTimeout(S.historyTimer);
    S.historyTimer = setTimeout(() => {
      S.historyTimer = 0;
      loadHistory();
    }, 500);
  }

  function afterSignalsChanged() {
    ensureWatchRows();
    ensureWriteMods();
    ensureWaveGroups();
    syncChannels();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderStallSelects();
    renderCalib();
    renderWatchLabels();
    renderWriteMods();
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
    renderWatchAll();
    renderWriteMods();
    ensureWaveGroups();
    syncTablePanel();
    syncSections();
    saveLocal();
    updateProjectUI();
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
    // 安全: 解锁状态绝不跨工程/刷新保留，任何在途写入也一并取消
    disarmWrite('');
    try {
      const proj = readProjects();
      if (proj.active && proj.items[proj.active]) {
        localStorage.setItem('ms.cfg.v2', JSON.stringify(proj.items[proj.active]));
      }
    } catch {}
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
              groupId: item.groupId || '',
              writeOnly: !!item.writeOnly,
              watchOnly: !!item.watchOnly,
            });
            S.rows.set(row.id, row);
          }
          for (const v of c.virtuals || []) {
            const sourceIds = (v.sourceIds || []).filter((id) => S.rows.has(id));
            if (!sourceIds.length) continue;
            S.virtuals.push({
              ...v, kind: 'virtual', sourceIds,
              table: !!v.table, plot: !!v.plot, support: false,
              groupId: v.groupId || 'default',
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
        if (c.sections && typeof c.sections === 'object') {
          S.ui.sections = {
            chart: c.sections.chart !== false,
            table: c.sections.table !== false,
            write: c.sections.write !== false,
          };
        }
        if (c.stall) {
          S.stall.enabled = c.stall.enabled !== false;
          S.stall.autoPause = !!c.stall.autoPause;
          S.stall.currentId = c.stall.currentId || '';
          S.stall.thresholdId = c.stall.thresholdId || '';
        }
        if (Array.isArray(c.watch)) {
          const base = S.watch.slice();
          S.watch = [0, 1, 2].map((i) => {
            const w = c.watch[i] || base[i] || {};
            return {
              key: 'w' + (i + 1),
              title: String(w.title || base[i]?.title || ('监视 ' + (i + 1))).slice(0, 24),
              mode: w.mode === 'margin' ? 'margin' : 'value',
              signal: String(w.signal || ''),
              addr: Number(w.addr) >>> 0,
              size: Number(w.size) || 2,
              signed: !!w.signed,
              bit: Array.isArray(w.bit) ? [Number(w.bit[0]), Number(w.bit[1])] : null,
              unit: String(w.unit || ''),
              rowId: String(w.rowId || ''),
            };
          });
        }
        if (Array.isArray(c.write?.mods)) {
          S.write.mods = c.write.mods.slice(0, 8).map((m, i) => ({
            id: String(m.id || ('wm' + (i + 1))),
            rowId: String(m.rowId || ''),
            mode: m.mode === 'switch' ? 'switch' : 'slider',
            width: Number(m.width) || (m.mode === 'switch' ? 0.25 : 0.5),
            widthTouched: !!m.widthTouched,
            min: Number(m.min) || 0,
            max: Number(m.max) || 0,
            step: Math.max(1, Number(m.step) || 1),
            live: !!m.live,
            status: '', statusKind: '', busy: false, pending: null, timer: 0,
            liveTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
            addr: Number(m.addr) >>> 0, size: Number(m.size) || 2,
            signed: !!m.signed, name: String(m.name || ''),
          }));
          S.write.seq = Math.max(1, S.write.mods.length,
            ...S.write.mods.map((m) => Number(String(m.id).replace(/\D/g, '')) || 0));
        } else if (c.write && c.write.targetId) {
          // 兼容旧版单目标存档
          S.write.mods = [{
            id: 'wm1', rowId: c.write.targetId,
            mode: c.write.mode === 'switch' ? 'switch' : 'slider',
            width: c.write.mode === 'switch' ? 0.25 : 0.5,
            widthTouched: false,
            min: Number(c.write.min) || 0,
            max: Number(c.write.max) || 4095,
            step: Math.max(1, Number(c.write.step) || 1),
            live: !!c.write.live,
            status: '', statusKind: '', busy: false, pending: null, timer: 0,
            liveTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
          }];
          S.write.seq = 1;
        }
        if (c.wave && Array.isArray(c.wave.groups)) {
          const groups = c.wave.groups
            .filter((g) => g && g.id)
            .map((g) => ({
              id: String(g.id), name: String(g.name || g.id).slice(0, 24),
              visible: g.visible !== false, auto: !!g.auto,
            }));
          if (groups.length) S.wave.groups = groups;
          S.wave.seq = Math.max(1, Number(c.wave.seq) || 1,
            ...groups.map((g) => Number(String(g.id).replace(/\D/g, '')) || 0));
        }
        // 安全: 写入解锁状态不跨工程/刷新保留
        S.write.size = ['sm', 'md', 'lg', 'auto'].includes(c.write?.size) ? c.write.size : S.write.size;
        S.write.armed = false;
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
    ensureWatchRows();
    ensureWriteMods();
    ensureWaveGroups();
    syncChannels();
    const st = S.catalog.stall || {};
    const sampled = S.signals.filter((s) => !isHidden(s));
    if (!byId(S.stall.currentId)) S.stall.currentId = st.current || (sampled[0]?.id || '');
    if (!byId(S.stall.thresholdId)) S.stall.thresholdId = st.threshold || (sampled[1]?.id || '');
    syncToggles();
    updateViewSeg();
    syncTablePanel();
    syncSections();
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
          table: !!s.table, plot: !!s.plot, support: !!s.support, groupId: s.groupId || '',
          writeOnly: !!s.writeOnly, watchOnly: !!s.watchOnly,
        })),
        virtuals: S.virtuals.map((v) => ({
          id: v.id, arrayId: v.arrayId, name: v.name, sourceIds: v.sourceIds.slice(),
          color: v.color, axis: v.axis, unit: v.unit, table: !!v.table, plot: !!v.plot,
          groupId: v.groupId || '',
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
        sections: Object.assign({ chart: true, table: true, write: true }, S.ui.sections || {}),
        stall: {
          enabled: S.stall.enabled,
          autoPause: S.stall.autoPause,
          currentId: S.stall.currentId,
          thresholdId: S.stall.thresholdId,
        },
        watch: S.watch.map((c) => ({
          title: c.title, mode: c.mode, signal: c.signal, addr: c.addr,
          size: c.size, signed: !!c.signed, bit: c.bit || null, unit: c.unit, rowId: c.rowId,
        })),
        wave: {
          seq: S.wave.seq,
          groups: S.wave.groups.map((g) => ({
            id: g.id, name: g.name, visible: g.visible !== false, auto: !!g.auto,
          })),
        },
        write: {
          armed: false, // 解锁状态不落盘
          size: S.write.size,
          seq: S.write.seq,
          mods: S.write.mods.map((m) => ({
            id: m.id, rowId: m.rowId, mode: m.mode,
            width: m.width, widthTouched: !!m.widthTouched,
            min: m.min, max: m.max, step: m.step, live: !!m.live,
            addr: m.addr, size: m.size, signed: !!m.signed, name: m.name || '',
          })),
        },
      }));
      // 多工程自动保存
      try {
        const p = readProjects();
        if (!p.active) p.active = '默认';
        p.items[p.active] = Object.assign(JSON.parse(localStorage.getItem('ms.cfg.v2') || '{}'), {
          name: p.active, savedAt: new Date().toISOString(),
        });
        localStorage.setItem(PROJECTS_KEY, JSON.stringify(p));
        S.projectSavedAt = Date.now();
        updateProjectUI();
      } catch {}
    } catch {}
  }

  // ---------------------------------------------------------------- 工程存档
  function readProjects() {
    try {
      const raw = localStorage.getItem(PROJECTS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object' && p.items && typeof p.items === 'object') {
          return { active: p.active || '默认', items: p.items };
        }
      }
    } catch {}
    return { active: '默认', items: {} };
  }

  function writeProjects(p) {
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(p)); } catch {}
  }

  function currentSnapshot() {
    try { return JSON.parse(localStorage.getItem('ms.cfg.v2') || '{}'); } catch { return {}; }
  }

  function updateProjectUI() {
    const p = readProjects();
    const names = Object.keys(p.items).sort((a, b) => a.localeCompare(b));
    if (!names.length) names.push('默认');
    const active = names.indexOf(p.active) >= 0 ? p.active : names[0];
    for (const el of [D.projectSel, D.projectSel2]) {
      if (!el) continue;
      el.innerHTML = '';
      for (const n of names) {
        const o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        el.appendChild(o);
      }
      el.value = active;
    }
    if (D.projectState) {
      const t = S.projectSavedAt
        ? '已自动保存 ' + new Date(S.projectSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : '自动保存到浏览器 localStorage';
      D.projectState.textContent = t + ' · 当前：' + active;
    }
  }

  function renderAfterProjectLoad() {
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderStallSelects();
    renderCalib();
    renderWatchAll();
    renderWriteMods();
    syncTablePanel();
    syncSections();
    updateProjectUI();
    S.dirty = true;
    scheduleHistoryReload();
  }

  function switchProject(name) {
    if (!name) return;
    saveLocal(); // 先把当前状态写回旧工程
    const p = readProjects();
    if (!p.items[name]) p.items[name] = currentSnapshot();
    p.active = name;
    writeProjects(p);
    localStorage.setItem('ms.cfg.v2', JSON.stringify(p.items[name] || {}));
    S.samples = [];
    S.lastT = 0;
    resetStall();
    S.paused = false;
    updatePauseUI();
    restoreConfig();
    renderAfterProjectLoad();
    toast('已切换工程：' + name, 'ok');
  }

  function newProject() {
    const p = readProjects();
    const def = '工程 ' + (Object.keys(p.items).length + 1);
    const name = (prompt('新工程名（会复制当前配置）', def) || '').trim();
    if (!name) return;
    if (p.items[name] && !confirm('工程“' + name + '”已存在，覆盖？')) return;
    saveLocal();
    p.items[name] = Object.assign(currentSnapshot(), { name, savedAt: new Date().toISOString() });
    p.active = name;
    writeProjects(p);
    localStorage.setItem('ms.cfg.v2', JSON.stringify(p.items[name]));
    updateProjectUI();
    toast('已创建工程：' + name, 'ok');
  }

  function saveProjectAs() {
    const p = readProjects();
    const name = (prompt('另存为工程名', p.active + ' 副本') || '').trim();
    if (!name) return;
    if (p.items[name] && !confirm('工程“' + name + '”已存在，覆盖？')) return;
    saveLocal();
    p.items[name] = Object.assign(currentSnapshot(), { name, savedAt: new Date().toISOString() });
    p.active = name;
    writeProjects(p);
    localStorage.setItem('ms.cfg.v2', JSON.stringify(p.items[name]));
    updateProjectUI();
    toast('已另存为：' + name, 'ok');
  }

  function deleteProject() {
    const p = readProjects();
    const names = Object.keys(p.items);
    if (names.length <= 1) { toast('至少保留一个工程', 'err'); return; }
    if (!confirm('删除当前工程“' + p.active + '”？')) return;
    delete p.items[p.active];
    const next = Object.keys(p.items)[0];
    p.active = next;
    writeProjects(p);
    localStorage.setItem('ms.cfg.v2', JSON.stringify(p.items[next] || {}));
    S.samples = [];
    S.lastT = 0;
    resetStall();
    restoreConfig();
    renderAfterProjectLoad();
    toast('已删除，切换到：' + next, 'ok');
  }

  function exportProject() {
    const p = readProjects();
    const data = Object.assign(currentSnapshot(), { name: p.active, savedAt: new Date().toISOString() });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'motorscope-' + p.active.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  async function importProjectFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || (!Array.isArray(data.rows) && !Array.isArray(data.signals))) {
        throw new Error('不是 MotorScope 工程 JSON');
      }
      const p = readProjects();
      let name = (data.name || file.name.replace(/\.json$/i, '') || '导入工程').trim();
      if (p.items[name] && !confirm('工程“' + name + '”已存在，覆盖？')) return;
      p.items[name] = data;
      p.active = name;
      writeProjects(p);
      localStorage.setItem('ms.cfg.v2', JSON.stringify(data));
      S.samples = [];
      S.lastT = 0;
      resetStall();
      restoreConfig();
      renderAfterProjectLoad();
      toast('已导入工程：' + name, 'ok');
    } catch (e) {
      toast('导入工程失败: ' + e.message, 'err');
    }
  }

  function adoptSignals(list, rate) {
    S.rows.clear();
    S.virtuals = [];
    for (const x of list || []) {
      if (!x || !x.id) continue;
      const row = normalizeSignal(x);
      S.rows.set(row.id, row);
    }
    ensureWaveGroups();
    ensureWatchRows();
    ensureWriteMods();
    syncChannels();
    renderWatchLabels();
    renderWriteMods();
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

  function isCalibrated(row) {
    if (!row) return false;
    if (row.kind === 'virtual') {
      return (row.sourceIds || []).some((id) => isCalibrated(S.rows.get(id)));
    }
    return (row.scale ?? 1) !== 1 || (row.offset ?? 0) !== 0;
  }

  function rawValue(row, vals) {
    if (!row) return null;
    if (row.kind === 'virtual') {
      const src = row._src || [];
      let sum = 0, n = 0;
      for (const k of src) {
        const v = vals[k];
        if (v === undefined || v === null || !isFinite(v)) continue;
        sum += v; n++;
      }
      return n ? sum / n : null;
    }
    const i = row.ci;
    if (i < 0 || i >= vals.length) return null;
    const v = vals[i];
    return v === undefined || v === null || !isFinite(v) ? null : v;
  }

  // 同一组里只要有一个未换算（或单位不一致），整组按原始值画
  function paneUseScale(rows) {
    if (!rows || !rows.length) return false;
    if (!rows.every(isCalibrated)) return false;
    const units = new Set(rows.map((r) => String(r.unit || '').trim().toLowerCase()));
    return units.size === 1;
  }

  function plotValue(row, vals, pane) {
    return pane && pane.useScale ? rowValue(row, vals) : rawValue(row, vals);
  }

  function convertedValue(row, raw) {
    if (raw === null || raw === undefined) return null;
    if (row.kind === 'virtual') return raw;
    const v = raw * (row.scale ?? 1) + (row.offset ?? 0);
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

  // 数值表专用：始终带千分位逗号；列宽只按约 6 位数字预留，更长时在格内换行
  function fmtTableNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
    return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function rowTableText(row, vals) {
    return fmtTableNum(rowValue(row, vals));
  }

  function isLongTableNum(text) {
    return String(text).replace(/[^0-9]/g, '').length > 6;
  }

  function setTableNum(el, text, baseClass) {
    el.textContent = text;
    el.className = baseClass + (isLongTableNum(text) ? ' vt-long' : '');
  }

  function rowValueText(row, vals) {
    const v = rowValue(row, vals);
    return fmtPhysical(row, v);
  }

  function refreshLiveValues() {
    const last = latestSample();
    if (!last) return;
    const vals = last[1];
    refreshWatchValues(vals);
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
      if (vt) {
        setTableNum(vt.cur, fmtTableNum(rawValue(row, vals)), 'num vt-cur');
        vt.cur.title = row.name + ' · ' + hex(row.addr) + '（原始）';
        if (vt.conv) {
          setTableNum(vt.conv, isCalibrated(row) ? fmtTableNum(convertedValue(row, rawValue(row, vals))) : '-', 'num vt-conv');
          vt.conv.title = isCalibrated(row) ? '换算值 = 原始 × ' + row.scale + ' + ' + row.offset : '未设置换算';
        }
      }
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
      if (vt) {
        setTableNum(vt.cur, fmtTableNum(rawValue(v, vals)), 'num vt-cur');
        if (vt.conv) setTableNum(vt.conv, isCalibrated(v) ? fmtTableNum(convertedValue(v, rawValue(v, vals))) : '-', 'num vt-conv');
      }
    }
    updateStallUI(last[0]);
    refreshWriteUI();
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
      setTableNum(vt.min, n ? fmtTableNum(mn) : '--', 'num vt-stat');
      setTableNum(vt.max, n ? fmtTableNum(mx) : '--', 'num vt-stat');
      setTableNum(vt.avg, n ? fmtTableNum(sum / n) : '--', 'num vt-stat');
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
    for (const c of S.watch) {
      const els = watchDom(c.key);
      if (!els) continue;
      els.root.classList.toggle('danger', active && (c.rowId === st.currentId || c.mode === 'margin'));
    }
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

  // 主动/被动断开、重连、切工程都调用：清掉在途写入并强制回到未解锁
  function disarmWrite(reason) {
    for (const mod of S.write.mods) {
      stopLiveWrite(mod);
      mod.liveHeld = false;
      mod.busy = false;
      mod.pending = null;
      mod.status = reason || '';
      mod.statusKind = reason ? 'err' : '';
    }
    S.write.armed = false;
    syncWriteUI();
    refreshWriteUI();
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
    if (!connected && S.write.armed) {
      disarmWrite('连接断开，写入已锁定');
      saveLocal();
    }
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
      // 换源/重连后写入必须重新解锁
      disarmWrite('');
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
    ensureWaveGroups();
    S.liveRows.clear();
    S.avgCells.clear();
    S.arrayEntries = S.arrayEntries || new Map();
    S.arrayEntries.clear();
    const tab = S.ui.tab;
    const q = S.ui.search.trim().toLowerCase();
    D.sigCount.textContent = String(visibleRowCount());
    D.selCount.textContent = String(selectedRows().length);
    if (D.selectedCount) D.selectedCount.textContent = String(selectedRows().length);
    D.search.placeholder = tab === 'periph' ? '搜索外设 / 寄存器 / 位' : tab === 'custom' ? '自定义地址'
      : tab === 'waves' ? '搜索波形 / 分组' : '搜索变量 / 寄存器 / 地址';
    const viewRow = document.querySelector('.view-row');
    if (viewRow) viewRow.classList.toggle('hidden', tab === 'waves');
    if (D.viewNote) {
      D.viewNote.textContent = tab === 'waves'
        ? '分组 · 独立轴 / 共享轴 · 拖动合并'
        : (S.ui.view === 'tree'
          ? '对象 · 结构体 · 数组 · 位域'
          : (tab === 'periph' ? '按外设分组' : tab === 'vars' ? '按对象分组' : '任意地址'));
    }
    if (tab === 'vars') {
      if (S.ui.view === 'tree') renderVarsTree(body, q); else renderVars(body, q);
    } else if (tab === 'periph') {
      if (S.ui.view === 'tree') renderPeriphTree(body, q); else renderPeriph(body, q);
    } else if (tab === 'waves') {
      renderWaveList(body, q);
    } else {
      renderCustom(body);
    }
  }

  function renderWaveList(body, q) {
    body.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'wave-top';
    const add = document.createElement('button');
    add.className = 'mini';
    add.textContent = '+ 新建分组';
    add.title = '新建共享坐标轴分组，再把波形拖进去';
    add.addEventListener('click', addWaveGroup);
    const hint = document.createElement('span');
    hint.className = 'wave-hint';
    hint.textContent = '拖动行到分组 = 共享轴';
    top.append(add, hint);
    body.appendChild(top);

    let shown = 0;
    for (const g of S.wave.groups) {
      const all = plotRows().filter((row) => (row.groupId || 'default') === g.id);
      const rows = q
        ? all.filter((row) => matchText([row.name, shortName(row.name), g.name], q))
        : all;
      if (q && !rows.length && !String(g.name).toLowerCase().includes(q)) continue;
      shown++;
      const box = document.createElement('div');
      box.className = 'wave-group' + (g.visible === false ? ' off' : '');
      box.dataset.group = g.id;

      const head = document.createElement('div');
      head.className = 'wg-head';
      const eye = document.createElement('button');
      eye.className = 'wg-eye';
      eye.textContent = g.visible === false ? '○' : '◉';
      eye.title = g.visible === false ? '显示该分组' : '隐藏该分组';
      eye.setAttribute('aria-label', eye.title);
      eye.addEventListener('click', (e) => { e.stopPropagation(); toggleWaveGroup(g.id); });
      const name = document.createElement('span');
      name.className = 'wg-name';
      name.textContent = g.name;
      const meta = document.createElement('span');
      meta.className = 'wg-meta';
      meta.textContent = (g.auto ? '独立轴' : '共享轴') + ' · ' + all.length;
      head.append(eye, name, meta);
      if (g.id !== 'default') {
        const del = document.createElement('button');
        del.className = 'wg-del';
        del.textContent = '×';
        del.title = '删除分组（组内波形回到默认分组）';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteWaveGroup(g.id); });
        head.appendChild(del);
      }

      const inner = document.createElement('div');
      inner.className = 'wg-body';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'wg-empty';
        empty.textContent = '拖动波形到这里' + (g.auto ? '（默认分组内每路独立轴）' : '（共享一个坐标轴）');
        inner.appendChild(empty);
      }
      for (const row of rows) {
        const el = document.createElement('div');
        el.className = 'wave-row';
        el.dataset.id = row.id;
        el.draggable = true;
        el.title = (row.kind === 'virtual' ? row.name : hex(row.addr) + ' · ' + row.name) +
          '\n拖动到别的分组可共享坐标轴';
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = row.color;
        dot.style.color = row.color;
        const nm = document.createElement('span');
        nm.className = 'wave-name';
        nm.textContent = shortName(row.name);
        const val = document.createElement('span');
        val.className = 'wave-val';
        val.textContent = '—';
        const tag = document.createElement('span');
        tag.className = 'wave-axis-tag';
        tag.textContent = g.auto ? '独立' : '共享';
        const rm = document.createElement('button');
        rm.className = 'sel-x';
        rm.textContent = '×';
        rm.title = '从波形移除';
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeSignal(row.id); });
        el.addEventListener('click', (e) => {
          if (e.target.closest('.sel-x')) return;
          setFocus(row.id, true);
        });
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.id);
          el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.append(dot, nm, val, tag, rm);
        inner.appendChild(el);
        S.liveRows.set(row.id, val);
      }

      const markOver = (on) => { box.classList.toggle('drop-over', on); };
      for (const zone of [head, inner]) {
        zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; markOver(true); });
        zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) markOver(false); });
        zone.addEventListener('drop', (e) => {
          e.preventDefault();
          markOver(false);
          const id = e.dataTransfer.getData('text/plain');
          if (id) assignWaveGroup(id, g.id);
        });
      }
      box.append(head, inner);
      body.appendChild(box);
    }
    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'cat-empty muted';
      empty.textContent = q ? '没有匹配的波形' : '还没有波形；在变量/外设行点“波”加入';
      body.appendChild(empty);
    }
    if (S.samples.length) refreshLiveValues();
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
    const inWrite = !!writeModForRow(id);
    const wb = document.createElement('button');
    wb.className = 'tgl tgl-write' + (inWrite ? ' on' : '');
    wb.textContent = '写';
    wb.title = inWrite ? '从写入窗口移除' : '加入写入窗口';
    wb.dataset.rowWrite = id;
    wb.setAttribute('aria-label', wb.title);
    wb.setAttribute('aria-pressed', inWrite ? 'true' : 'false');
    wrap.appendChild(wb);
    // 十字分区右下角保留：先占位，后续可放“曲线设置”等
    const reserved = document.createElement('span');
    reserved.className = 'tgl-reserved';
    reserved.setAttribute('aria-hidden', 'true');
    wrap.appendChild(reserved);
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
      '\n表：加入数值表；波：加入波形；写：加入下方写入窗口（可再做开关/滑条）';
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

  function arrayRowFor(entry, create) {
    let row = S.rows.get(entry.id);
    if (!row && create) {
      row = newRow(entry, { table: false, plot: false, support: false });
      S.rows.set(entry.id, row);
    }
    return row;
  }

  function applyArrayFlags(entries, patch) {
    for (const entry of entries) {
      const row = arrayRowFor(entry, patch.table === true || patch.plot === true);
      if (!row) continue;
      if (patch.table !== undefined) row.table = !!patch.table;
      if (patch.plot !== undefined) row.plot = !!patch.plot;
      if (row.table || row.plot) row.support = false;
    }
    afterSignalsChanged();
  }

  function toggleArrayWrite(entries, on) {
    if (on) {
      for (const entry of entries) {
        if (writeModForRow(entry.id)) continue;
        const row = arrayRowFor(entry, true);
        if (!row || !row.addr) continue;
        S.write.mods.push(makeWriteMod(row));
      }
    } else {
      const ids = new Set(entries.map((e) => e.id));
      for (const mod of S.write.mods.slice()) {
        if (!ids.has(mod.rowId)) continue;
        stopLiveWrite(mod);
        S.write.mods = S.write.mods.filter((m) => m !== mod);
      }
    }
    ensureWriteMods();
    afterSignalsChanged();
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
    head.innerHTML = '<span class="at-idx">idx</span><span class="at-val">当前值</span>' +
      '<span class="at-tgl"><span class="at-actions">' +
      '<button data-arr-all title="全选 / 取消全部元素（表+波）">全选</button>' +
      '<button data-arr-flag="table" title="全部加入 / 移出数值表">表</button>' +
      '<button data-arr-flag="plot" title="全部加入 / 移出波形">波</button>' +
      '<button data-arr-write title="全部加入 / 移出写入">写</button>' +
      '</span></span>';
    wrap.appendChild(head);
    const allBtn = head.querySelector('[data-arr-all]');
    allBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const allOn = entries.every((en) => {
        const r = S.rows.get(en.id);
        return r && r.table && r.plot;
      });
      applyArrayFlags(entries, { table: !allOn, plot: !allOn });
      allBtn.classList.toggle('on', !allOn);
    });
    head.querySelectorAll('[data-arr-flag]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const flag = btn.dataset.arrFlag;
        const allOn = entries.every((en) => {
          const r = S.rows.get(en.id);
          return r && r[flag];
        });
        applyArrayFlags(entries, { [flag]: !allOn });
        btn.classList.toggle('on', !allOn);
      });
    });
    const writeBtn = head.querySelector('[data-arr-write]');
    writeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const allOn = entries.length > 0 && entries.every((en) => !!writeModForRow(en.id));
      toggleArrayWrite(entries, !allOn);
      writeBtn.classList.toggle('on', !allOn);
    });
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
    const rows = selectedRows();
    D.selCount.textContent = String(rows.length);
    if (D.selectedCount) D.selectedCount.textContent = String(rows.length);
    if (!rows.length) {
      box.innerHTML = '<div class="cat-empty muted">把左侧“表”或“波”打开，加入已选择</div>';
      return;
    }
    for (const row of rows) {
      const el = document.createElement('div');
      const wg = waveGroupFor(row);
      el.className = 'sel-row' + (wg && wg.visible === false ? ' group-hidden' : '');
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
        S.focusId = S.focusId === row.id ? null : row.id;
        for (const [id, node] of S.selRows) node.classList.toggle('focus', id === S.focusId);
        S.dirty = true;
      });
      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.sel-x') || e.target.closest('.tgl')) return;
        openCalibModal(row);
      });
      el.querySelector('.sel-x').addEventListener('click', (e) => {
        e.stopPropagation();
        removeSignal(row.id);
      });
      box.appendChild(el);
      S.selRows.set(row.id, el);
    }
    if (S.focusId) {
      if (S.selRows.has(S.focusId)) S.selRows.get(S.focusId).classList.add('focus');
      else S.focusId = null;
    }
    if (S.samples.length) refreshLiveValues();
    updateEmptyHint();
  }

  function renderLegend() {
    const box = D.legend;
    if (!box) return;
    box.innerHTML = '';
    S.legendEls.clear();
    for (const row of visiblePlotRows()) {
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
      chip.querySelector('.lax').textContent = row.axis === 'right' ? 'R' : '';
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
      const conv = document.createElement('span');
      conv.className = 'num vt-conv';
      conv.textContent = '-';
      const mn = document.createElement('span'); mn.className = 'num vt-stat'; mn.textContent = '--';
      const mx = document.createElement('span'); mx.className = 'num vt-stat'; mx.textContent = '--';
      const av = document.createElement('span'); av.className = 'num vt-stat'; av.textContent = '--';
      const un = document.createElement('span'); un.className = 'vt-c-unit'; un.textContent = row.unit || '';
      el.append(dot, nm, cur, conv, mn, mx, av, un);
      body.appendChild(el);
      S.vtRows.set(row.id, { cur, conv, min: mn, max: mx, avg: av });
    }
    updateTableStats();
    if (S.samples.length) refreshLiveValues();
  }

  function updateEmptyHint() {
    const hasPlot = plotRows().length > 0;
    const hasVisible = visiblePlotRows().length > 0;
    const hasTable = tableRows().length > 0;
    D.empty.classList.toggle('hidden', hasVisible);
    const div = D.empty.querySelector('div');
    const small = D.empty.querySelector('small');
    if (hasPlot && !hasVisible) {
      if (div) div.textContent = '波形分组已隐藏';
      if (small) small.textContent = '在左侧“波形”标签里点分组左侧的 ◉ 恢复显示';
    } else {
      if (div) div.textContent = '还没有波形';
      if (small) {
        small.textContent = hasTable
          ? '数值表里有信号；把对应行的“波”打开就会画出来'
          : '在左侧把“波”打开，或点击“连接”';
      }
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

  // ---------------------------------------------------------------- 换算弹窗
  let calibEditId = '';

  function openCalibModal(row) {
    if (!row || !D.calibModal) return;
    calibEditId = row.id;
    D.calibTarget.textContent = row.name + (row.addr ? ' · ' + hex(row.addr) : '') +
      (row.kind === 'virtual' ? ' · 数组平均' : '');
    D.calScale.value = String(row.scale ?? 1);
    D.calOffset.value = String(row.offset ?? 0);
    D.calUnit.value = row.unit || '';
    D.calAxis.value = row.axis === 'right' ? 'right' : 'left';
    D.calScale.disabled = row.kind === 'virtual';
    D.calOffset.disabled = row.kind === 'virtual';
    D.calibModal.classList.remove('hidden');
    setTimeout(() => D.calScale.focus(), 30);
  }

  function closeCalibModal() {
    calibEditId = '';
    D.calibModal?.classList.add('hidden');
  }

  function applyCalibModal() {
    const row = S.rows.get(calibEditId) || S.virtuals.find((v) => v.id === calibEditId);
    if (!row) { closeCalibModal(); return; }
    if (row.kind !== 'virtual') {
      const sc = Number(D.calScale.value);
      const of = Number(D.calOffset.value);
      row.scale = isFinite(sc) ? sc : 1;
      row.offset = isFinite(of) ? of : 0;
      row.unit = String(D.calUnit.value || '').trim();
      row.axis = D.calAxis.value === 'right' ? 'right' : 'left';
    } else {
      row.unit = String(D.calUnit.value || '').trim();
      row.axis = D.calAxis.value === 'right' ? 'right' : 'left';
    }
    saveLocal();
    renderSelected();
    renderValueTable();
    renderLegend();
    if (S.samples.length) refreshLiveValues();
    S.dirty = true;
    closeCalibModal();
    toast('已更新换算：' + shortName(row.name) +
      (isCalibrated(row) ? ' · ' + row.scale + '× + ' + row.offset + (row.unit ? ' ' + row.unit : '') : ' · 未设置'), 'ok');
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

  function wavePanes() {
    const panes = [];
    for (const g of S.wave.groups) {
      if (g.visible === false) continue;
      const rows = plotRows().filter((r) => (r.groupId || 'default') === g.id);
      if (!rows.length) continue;
      if (g.auto) {
        for (const r of rows) panes.push({ group: g, rows: [r], title: shortName(r.name), unit: r.unit || '' });
      } else {
        panes.push({ group: g, rows, title: g.name, unit: '' });
      }
    }
    return panes;
  }

  function draw() {
    const cv = D.chart;
    const ctx = cv.getContext('2d');
    const W = S.size.w, H = S.size.h;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    const rows = visiblePlotRows();
    const panes = wavePanes();
    const anyRight = rows.some((r) => r.axis === 'right');
    const pad = { l: 62, r: anyRight ? 54 : 14, t: 14, b: 34 };
    const x0 = pad.l, y0 = pad.t;
    const pw = Math.max(10, W - pad.l - pad.r);
    const ph = Math.max(10, H - pad.t - pad.b);
    const end = S.paused ? (S.pauseAt || S.lastT) : S.lastT;
    const start = end - S.windowSec * 1000;
    const range = sampleRange(start, end);
    const i0 = range[0], i1 = range[1];
    S.view = { x0, y0, pw, ph, start, end, panes };

    if (!panes.length) {
      const bg = ctx.createLinearGradient(0, y0, 0, y0 + ph);
      bg.addColorStop(0, 'rgba(14,24,42,.38)');
      bg.addColorStop(1, 'rgba(7,12,23,.18)');
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y0, pw, ph);
      return;
    }

    const gap = 6;
    const each = Math.max(10, (ph - gap * (panes.length - 1)) / panes.length);
    const axisRange = (list, pane) => {
      let mn = Infinity, mx = -Infinity, dmin = Infinity;
      for (const row of list) {
        for (let i = i0; i < i1; i++) {
          const tv = plotValue(row, S.samples[i][1], pane);
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

    for (let pi = 0; pi < panes.length; pi++) {
      const pane = panes[pi];
      pane.top = y0 + pi * (each + gap);
      pane.h = each;
      pane.useScale = paneUseScale(pane.rows);
      pane.unit = pane.useScale ? String(pane.rows[0].unit || '').trim() : '';
      pane.range = axisRange(pane.rows, pane) || { min: 0, max: 1 };
      pane.Y = (v) => pane.top + pane.h - ((v - pane.range.min) / Math.max(1e-9, pane.range.max - pane.range.min)) * pane.h;
      pane.primary = (byId(S.stall.currentId) && pane.rows.some((r) => r.id === S.stall.currentId))
        ? byId(S.stall.currentId)
        : (pane.rows.find((r) => /current/i.test(r.name)) || pane.rows[0] || null);
    }

    // pane backgrounds
    for (const pane of panes) {
      const bg = ctx.createLinearGradient(0, pane.top, 0, pane.top + pane.h);
      bg.addColorStop(0, 'rgba(14,24,42,.42)');
      bg.addColorStop(1, 'rgba(7,12,23,.18)');
      ctx.fillStyle = bg;
      ctx.fillRect(x0, pane.top, pw, pane.h);
    }

    // vertical time grid across panes
    const xt = 5;
    ctx.strokeStyle = 'rgba(120,150,190,.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= xt; i++) {
      const x = Math.round(x0 + pw * i / xt) + 0.5;
      if (S.gridOn) {
        for (const pane of panes) {
          ctx.beginPath(); ctx.moveTo(x, pane.top); ctx.lineTo(x, pane.top + pane.h); ctx.stroke();
        }
      }
    }

    // horizontal grid + per-pane Y axis labels
    const mono = getComputedStyle(document.body).getPropertyValue('--mono');
    for (const pane of panes) {
      const ticks = Math.max(1, Math.min(4, Math.round(pane.h / 38)));
      const rightPane = pane.rows.length && pane.rows.every((r) => r.axis === 'right');
      ctx.font = '9px ' + mono;
      ctx.fillStyle = 'rgba(127,147,173,.75)';
      for (let i = 0; i <= ticks; i++) {
        const ratio = i / ticks;
        const v = pane.range.min + (pane.range.max - pane.range.min) * ratio;
        const y = Math.round(pane.top + pane.h - ratio * pane.h) + 0.5;
        if (S.gridOn) {
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + pw, y); ctx.stroke();
        }
        ctx.textAlign = rightPane ? 'left' : 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtAxis(v), rightPane ? x0 + pw + 8 : x0 - 8, y);
      }
      // pane title + scale
      const title = pane.title + (pane.unit ? ' [' + pane.unit + ']' : '') +
        (pane.rows.length > 1 ? ' · ' + pane.rows.length + ' 路共享' : '');
      ctx.font = '9px ' + mono;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const tw = Math.min(pw - 12, ctx.measureText(title).width + 10);
      ctx.fillStyle = 'rgba(6,11,21,.62)';
      ctx.fillRect(x0 + 4, pane.top + 3, tw, 13);
      ctx.fillStyle = hexAlpha(pane.rows[0].color, .95);
      ctx.fillText(title, x0 + 8, pane.top + 5);
      // axes border
      ctx.strokeStyle = 'rgba(120,150,190,.22)';
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, pane.top); ctx.lineTo(x0 + 0.5, pane.top + pane.h + 0.5); ctx.lineTo(x0 + pw, pane.top + pane.h + 0.5);
      ctx.stroke();
      if (S.zeroLine) drawZeroLine(ctx, pane.range, pane.Y, x0, pw, pane.top, pane.h, 'rgba(190,214,240,.26)');
    }

    // bottom time labels
    ctx.font = '9.5px ' + mono;
    ctx.fillStyle = 'rgba(127,147,173,.75)';
    for (let i = 0; i <= xt; i++) {
      const x = Math.round(x0 + pw * i / xt) + 0.5;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const t = start + (end - start) * i / xt;
      const rel = (t - end) / 1000;
      ctx.fillText((rel >= -0.05 ? '0' : rel.toFixed(0)) + 's', x, y0 + ph + 8);
    }

    // stall bands across all panes
    if (S.stall.enabled && S.stall.events.length) {
      for (const ev of S.stall.events) {
        const evEnd = ev.end == null ? end : ev.end;
        if (evEnd < start || ev.t > end) continue;
        const xa = x0 + ((Math.max(ev.t, start) - start) / Math.max(1, end - start)) * pw;
        const xb = x0 + ((Math.min(evEnd, end) - start) / Math.max(1, end - start)) * pw;
        ctx.fillStyle = 'rgba(251,77,103,.075)';
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), ph);
        ctx.fillStyle = 'rgba(251,77,103,.55)';
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), 2);
      }
    }

    const focus = S.focusId;
    const alphaFor = (row) => {
      if (focus) return row.id === focus ? 1 : 0.12;
      return row.id === (panes.find((p) => p.primary && p.primary.id === row.id)?.primary?.id) ? 1 : 0.66;
    };
    const widthFor = (row) => {
      const isThr = row.id === S.stall.thresholdId || /threshold/i.test(row.name) || row.name.endsWith('.thresholdLast');
      if (isThr) return 1.2;
      return panes.some((p) => p.primary && p.primary.id === row.id) ? 2.1 : 1.15;
    };

    // fills (primary per pane)
    if (S.fillOn) {
      for (const pane of panes) {
        const row = pane.primary;
        if (!row || i1 - i0 <= 1) continue;
        ctx.beginPath();
        let started = false;
        for (let i = i0; i < i1; i++) {
          const v = plotValue(row, S.samples[i][1], pane);
          if (v === null) continue;
          const x = x0 + ((S.samples[i][0] - start) / Math.max(1, end - start)) * pw;
          const y = pane.Y(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        if (!started) continue;
        ctx.lineTo(x0 + pw, pane.top + pane.h);
        ctx.lineTo(x0, pane.top + pane.h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, pane.top, 0, pane.top + pane.h);
        g.addColorStop(0, hexAlpha(row.color, .14));
        g.addColorStop(1, hexAlpha(row.color, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
    }

    // traces
    for (const pane of panes) {
      for (const row of pane.rows) {
        const isThr = row.id === S.stall.thresholdId || /threshold/i.test(row.name);
        const isPrimary = pane.primary && row.id === pane.primary.id;
        const alpha = alphaFor(row);
        ctx.beginPath();
        let started = false, prevY = 0;
        for (let i = i0; i < i1; i++) {
          const v = plotValue(row, S.samples[i][1], pane);
          if (v === null) continue;
          const x = x0 + ((S.samples[i][0] - start) / Math.max(1, end - start)) * pw;
          const y = pane.Y(v);
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
    }

    // stall markers at top
    if (S.stall.enabled) {
      for (const ev of S.stall.events) {
        if (ev.t < start) continue;
        const x = x0 + ((ev.t - start) / Math.max(1, end - start)) * pw;
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
      const x = x0 + ((S.hoverT - start) / Math.max(1, end - start)) * pw;
      ctx.strokeStyle = 'rgba(220,235,250,.28)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph); ctx.stroke();
      ctx.setLineDash([]);
      const nearest = nearestSample(S.hoverT);
      if (nearest) {
        for (const pane of panes) {
          for (const row of pane.rows) {
            const v = plotValue(row, nearest[1], pane);
            if (v === null) continue;
            const y = pane.Y(v);
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
    }

    // paused badge
    if (S.paused) {
      ctx.fillStyle = 'rgba(245,158,11,.14)';
      ctx.strokeStyle = 'rgba(245,158,11,.55)';
      const label = 'PAUSED';
      ctx.font = 'bold 9px ' + mono;
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
    for (const row of visiblePlotRows()) {
      const pane = (view.panes || []).find((p) => p.rows.includes(row));
      const v = plotValue(row, near[1], pane);
      if (v === null) continue;
      const unit = pane && pane.useScale ? String(row.unit || '') : '';
      let main;
      if (pane && pane.useScale) {
        main = fmtPhysical(row, v) + (unit ? ' ' + unit : '');
      } else {
        main = fmtTableNum(v);
        if (isCalibrated(row)) {
          const cv = convertedValue(row, rawValue(row, near[1]));
          if (cv !== null) {
            main += ' <span class="ct-conv">→ ' + esc(fmtTableNum(cv) + (row.unit ? ' ' + row.unit : '')) + '</span>';
          }
        }
      }
      rows.push('<div class="ct-row"><span class="dot" style="background:' + row.color + ';color:' + row.color + '"></span>' +
        '<span>' + esc(shortName(row.name)) + '</span><span class="v">' + main + '</span></div>');
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
        disarmWrite('已断开，写入已锁定');
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

    // 写入：全局解锁 + 每个模块自己的类型/范围/实时
    D.writeSize?.addEventListener('change', () => {
      S.write.size = D.writeSize.value;
      applyWriteSize();
      saveLocal();
    });
    const finishPointerLive = () => {
      for (const mod of S.write.mods) finishLiveWrite(mod);
    };
    window.addEventListener('pointerup', finishPointerLive);
    window.addEventListener('pointercancel', finishPointerLive);
    window.addEventListener('blur', finishPointerLive);
    D.writeArmed?.addEventListener('change', () => {
      S.write.armed = !!D.writeArmed.checked;
      if (!S.write.armed) stopAllLiveWrites();
      for (const mod of S.write.mods) { mod.pending = null; mod.status = ''; mod.statusKind = ''; }
      syncWriteUI();
      refreshWriteUI();
      saveLocal();
    });

    // 监视卡片编辑
    for (const btn of $$('[data-watch-edit]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openWatchEditor(btn.dataset.watchEdit);
      });
    }
    for (const card of S.watch) {
      const els = watchDom(card.key);
      if (!els || !els.editor) continue;
      els.editor.querySelector('.we-apply')?.addEventListener('click', () => applyWatchEditor(card.key));
      els.editor.querySelector('.we-cancel')?.addEventListener('click', () => closeWatchEditor());
      els.editor.querySelector('.we-margin')?.addEventListener('change', (e) => {
        const target = els.editor.querySelector('.we-target');
        if (target) target.disabled = !!e.target.checked;
      });
    }
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.watch-card')) closeWatchEditor();
    });

    // 工程
    D.projectSel?.addEventListener('change', () => switchProject(D.projectSel.value));
    D.projectSel2?.addEventListener('change', () => switchProject(D.projectSel2.value));
    $('#btnProjectNew')?.addEventListener('click', newProject);
    $('#btnProjectSaveAs')?.addEventListener('click', saveProjectAs);
    $('#btnProjectDelete')?.addEventListener('click', deleteProject);
    $('#btnProjectExport')?.addEventListener('click', exportProject);
    $('#btnProjectImport')?.addEventListener('click', () => D.projectFile?.click());
    D.projectFile?.addEventListener('change', () => {
      const f = D.projectFile.files && D.projectFile.files[0];
      if (f) importProjectFile(f);
      D.projectFile.value = '';
    });
    $('#btnCalibSelected')?.addEventListener('click', () => {
      const row = (S.focusId && S.rows.get(S.focusId)) || selectedRows()[0];
      if (!row) { toast('先添加/选择一行信号', 'err'); return; }
      openCalibModal(row);
    });
    $('#btnCalibClose')?.addEventListener('click', closeCalibModal);
    $('#btnCalibCancel')?.addEventListener('click', closeCalibModal);
    $('#btnCalibApply')?.addEventListener('click', applyCalibModal);
    D.calibModal?.addEventListener('click', (e) => { if (e.target === D.calibModal) closeCalibModal(); });

    D.sectionTabs?.querySelectorAll('button[data-sec]').forEach((b) => {
      b.addEventListener('click', () => toggleSection(b.dataset.sec));
    });
    document.querySelectorAll('[data-sec-close]').forEach((b) => {
      b.addEventListener('click', () => {
        const sec = b.dataset.secClose;
        if (!S.ui.sections) S.ui.sections = { chart: true, table: true, write: true };
        S.ui.sections[sec] = false;
        syncSections();
        saveLocal();
      });
    });
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
        if (D.calibModal && !D.calibModal.classList.contains('hidden')) { closeCalibModal(); return; }
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
    const wtgl = e.target.closest('[data-row-write]');
    if (wtgl) {
      e.preventDefault();
      e.stopPropagation();
      toggleWriteRow(wtgl.dataset.rowWrite);
      return;
    }
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
    renderWatchAll();
    renderWriteMods();
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
      if (row.watchOnly) continue; // 监视卡由 ensureWatchRows 按自身绑定重解析
      const e = catalogEntryFor(id, row.name);
      if (e) {
        row.addr = e.addr >>> 0; row.size = e.size || row.size; row.signed = !!e.signed;
        row.bit = Array.isArray(e.bit) ? [Number(e.bit[0]), Number(e.bit[1])] : null;
        row.type = e.type || row.type; row.name = e.name || row.name;
      } else {
        S.rows.delete(id);
        missing++;
      }
    }
    S.virtuals = S.virtuals.filter((v) => (v.sourceIds || []).some((id) => S.index.has(id)));
    ensureWatchRows();
    ensureWriteMods();
    ensureWaveGroups();
    syncChannels();
    renderCatalog(); renderSelected(); renderLegend(); renderValueTable();
    renderStallSelects(); renderCalib(); renderWatchAll(); renderWriteMods();
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
