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
    // 波形时间轴：follow=实时滚动窗口；overview=在完整可用历史上框选
    chartFollow: true,
    chartFull: false,        // 波形全屏：仅隐藏顶部 hero 卡片
    chartRange: null,        // overview 的 {start,end}（ms，绝对时间戳）
    chartAutoFull: false,    // 恢复页面时先自动铺满，直到用户真正操作时间轴
    chartRightLock: false,   // overview 右端锁定实时（不切 follow）
    cacheLockAt: 0,          // 锁定时缓存窗口的节流刷新时间
    tlDrag: null,            // 时间轴拖拽会话
    tlUiKey: '',
    tlSaveTimer: 0,
    // 服务端分块压缩录制缓存（旁路；只用于 overview/进度条，不改变 live 语义）
    cacheInfo: null,
    cacheInfoBusy: false,
    cacheInfoTimer: 0,
    cacheSaveBusy: false,
    cacheSamples: null,      // overview 选中窗口的缓存样本 [[t,[raw...]],...]
    cacheRange: null,        // 上述样本对应的请求窗口 {start,end}
    cacheToken: 0,
    cacheWindowTimer: 0,
    cacheError: '',
    autoZero: false,
    fillOn: true,
    gridOn: true,
    zeroLine: true,
    glow: false,
    // 芯片型号 / 寄存器模板（与后端识别结果共用 web/mcu/index.json）
    chip: null,
    lastMode: 'openocd',
    arch: 'cw32',
    margin: { cur: '', thr: '' },
    recordSel: new Set(),
    mcu: {
      models: [], active: '', detected: '', candidates: [], exact: false,
      expected: '', match: null, warning: '', loaded: false, periphs: [], manual: false,
    },
    // 机型工程：后端 profiles/ 下的四套「符号 + 芯片 + 连接 + 配置」
    profiles: { active: '', items: [], loaded: false, error: '' },
    profileSavedAt: 0,
    switching: false,
    // 寄存器信息（与寄存器模板分开导入）：key -> {static, full, states, values, ...}
    reginfo: { model: '', entries: [], map: new Map(), loaded: false },
    readVals: new Map(),
    // 波形分组：默认分组内每路独立轴；拖入自定义组则共享轴
    wave: {
      groups: [{ id: 'default', name: '默认分组', visible: true, auto: true }],
      seq: 1,
    },
    // 写入窗口：多个独立模块，每个有自己的类型/范围/锁定/状态
    write: {
      armed: false, seq: 1,
      mods: [{
        id: 'wm1', rowId: 'motor.over.threshold', mode: 'slider',
        width: 0.5, widthTouched: false,
        min: 0, max: 4095, step: 1, locked: false, lockValue: 0,
        onValue: 1, offValue: 0,
        status: '', statusKind: '', busy: false, pending: null, timer: 0,
        liveTimer: null, lockTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
        dragging: false, lastResult: null, expanded: false, layout: 'bar',
      }],
    },
    focusId: null,
    focusPinned: false,
    paused: false,
    pauseAt: 0,
    dirty: true,
    hoverT: null,
    hoverX: null,
    pinT: null,
    pinX: null,
    pinY: null,
    pinTipW: 0,
    pinTipH: 0,
    view: null,
    size: { w: 0, h: 0 },
    ui: {
      tab: 'vars',
      view: 'list',
      search: '',
      openGroups: new Set(['motor', 'adc', 'sys', '__custom']),
      openNodes: new Set(['g:motor', 'g:adc', 'g:sys']),
      openPeriph: new Set(['ADC', 'ATIM', 'GPIOA']),
      openRegs: new Set(),
      expanded: new Set(),
      overlayDismissed: true,
      panel: '',
      log: false,
      connecting: false,
      tableOpen: true,
      topCompact: false,
      sections: { chart: true, table: true, write: true },
    },
    es: null,
    sseReady: false,
    clientId: '',
    clientNo: 0,
    presence: [],
    presenceKey: '',
    viewTimer: 0,
    viewSentKey: '',
    viewHeartbeat: 0,
    shareApplied: false,
    shareApplying: false,
    shareId: '',
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

  // 每个标签页/固定客户端独立 key：避免同机多个页面互相覆盖 localStorage。
  // 固定标识：URL ?client=dsh，或 localStorage.setItem('ms.clientId','dsh')。
  const LEGACY_CFG_KEY = 'ms.cfg.v2';
  const LEGACY_PROJECTS_KEY = 'ms.projects.v2';
  const CFG_LAST_KEY = 'ms.cfg.last';
  const PROJECTS_LAST_KEY = 'ms.projects.last';
  function safeClientToken(v) {
    return String(v || '').replace(/[^A-Za-z0-9_.-]+/g, '').slice(0, 32);
  }
  function resolveClientKey() {
    try {
      const q = new URLSearchParams(location.search).get('client');
      const qt = safeClientToken(q);
      if (qt) return 'fixed-' + qt;
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('client');
      const ht = safeClientToken(h);
      if (ht) return 'fixed-' + ht;
      const fixed = safeClientToken(localStorage.getItem('ms.clientId'));
      if (fixed) return 'fixed-' + fixed;
      let k = sessionStorage.getItem('ms.clientKey');
      if (!k) {
        k = 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        sessionStorage.setItem('ms.clientKey', k);
      }
      return safeClientToken(k) || ('tab-' + Date.now().toString(36));
    } catch {
      return 'tab-' + Date.now().toString(36);
    }
  }
  const CLIENT_KEY = resolveClientKey();
  const CLIENT_LABEL = CLIENT_KEY.startsWith('fixed-') ? CLIENT_KEY.slice(6) : CLIENT_KEY;
  const CFG_KEY = LEGACY_CFG_KEY + '@' + CLIENT_KEY;
  const PROJECTS_KEY = LEGACY_PROJECTS_KEY + '@' + CLIENT_KEY;

  function writeCfgRaw(text) {
    try { localStorage.setItem(CFG_KEY, text); } catch {}
    try { localStorage.setItem(CFG_LAST_KEY, text); } catch {}
    // 兼容旧版本/外部工具：只作为 seed，不会被已打开页面回读覆盖
    try { localStorage.setItem(LEGACY_CFG_KEY, text); } catch {}
  }
  function readCfgRaw() {
    try {
      return localStorage.getItem(CFG_KEY)
        || localStorage.getItem(CFG_LAST_KEY)
        || localStorage.getItem(LEGACY_CFG_KEY)
        || localStorage.getItem('ms.cfg.v1');
    } catch { return null; }
  }
  function writeProjectsRaw(text) {
    try { localStorage.setItem(PROJECTS_KEY, text); } catch {}
    try { localStorage.setItem(PROJECTS_LAST_KEY, text); } catch {}
    try { localStorage.setItem(LEGACY_PROJECTS_KEY, text); } catch {}
  }
  function readProjectsRaw() {
    try {
      return localStorage.getItem(PROJECTS_KEY)
        || localStorage.getItem(PROJECTS_LAST_KEY)
        || localStorage.getItem(LEGACY_PROJECTS_KEY);
    } catch { return null; }
  }
  S.clientKey = CLIENT_KEY;
  S.clientLabel = CLIENT_LABEL;

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
    D.btnCollapseAll = $('#btnCollapseAll');
    D.selCount = $('#selCount');
    D.selectedList = $('#selectedList');
    D.legend = $('#legend');
    D.valueTable = $('#valueTable');
    D.tableCard = $('#tableCard');
    D.chartCard = $('#chartCard');
    D.tableBody = $('#tableBody');
    D.tableCount = $('#tableCount');
    D.tableSum = $('#tableSum');
    D.tableHead = $('#tableHead');
    D.btnTableToggle = $('#btnTableToggle');
    D.viewNote = $('#viewNote');
    D.topbar = $('#topbar');
    D.actions = $('#topActions');
    D.chart = $('#chart');
    D.btnChartFull = $('#btnChartFull');
    D.wrap = $('#canvasWrap');
    D.tip = $('#cursorTip');
    D.pinTip = $('#pinTip');
    D.timelineBar = $('#timelineBar');
    D.tlMode = $('#tlMode');
    D.tlModeText = $('#tlModeText');
    D.tlRail = $('#tlRail');
    D.tlWindow = $('#tlWindow');
    D.tlFirst = $('#tlFirst');
    D.tlLast = $('#tlLast');
    D.tlWin = $('#tlWin');
    D.tlCache = $('#tlCache');
    D.tlCacheSize = $('#tlCacheSize');
    D.tlCacheLimit = $('#tlCacheLimit');
    D.tlCacheState = $('#tlCacheState');
    D.tlCacheSave = $('#tlCacheSave');
    D.empty = $('#emptyHint');
    D.statSamples = $('#statSamples');
    D.statRate = $('#statRate');
    D.statLatency = $('#statLatency');
    D.statRecord = $('#statRecord');
    D.statMsg = $('#statMsg');
    D.calibModal = $('#calibModal');
    D.calibTarget = $('#calibTarget');
    D.calScale = $('#calScale');
    D.calOffset = $('#calOffset');
    D.calUnit = $('#calUnit');
    D.calAxis = $('#calAxis');
    D.catalogMeta = $('#catalogMeta');
    D.mcuSel = $('#mcuSel');
    D.chipWarn = $('#chipWarn');
    D.chipInfo = $('#chipInfo');
    D.chipLine = $('#chipLine');
    D.chipBanner = $('#chipBanner');
    D.chipBannerText = $('#chipBannerText');
    D.brandSub = $('#brandSub');
    D.cardProjectVal = $('#cardProjectVal');
    D.cardProjectSub = $('#cardProjectSub');
    D.cardRecordVal = $('#cardRecordVal');
    D.cardRecordSub = $('#cardRecordSub');
    D.recCount = $('#recCount');
    D.recSeconds = $('#recSeconds');
    D.recStart = $('#recStart');
    D.recLimit = $('#recLimit');
    D.recHint = $('#recHint');
    D.btnRecVars = $('#btnRecVars');
    D.recVars = $('#recVars');
    D.btnRecExport = $('#btnRecExport');
    D.marginCur = $('#marginCur');
    D.marginThr = $('#marginThr');
    D.cardSourceVal = $('#cardSourceVal');
    D.cardSourceSub = $('#cardSourceSub');
    D.cardRateVal = $('#cardRateVal');
    D.cardRateSub = $('#cardRateSub');
    D.cardRateBar = $('#cardRateBar');
    D.cardRateBarText = $('#cardRateBarText');
    D.axfFile = $('#axfFile');
    D.hdrFile = $('#hdrFile');
    D.btnImportVars = $('#btnImportVars');
    D.btnImportRegs = $('#btnImportRegs');
    D.regInfoFile = $('#regInfoFile');
    D.btnImportRegInfo = $('#btnImportRegInfo');
    D.btnRecReset = $('#btnRecReset');
    D.writeCard = $('#writeCard');
    D.writeList = $('#writeList');
    D.writeArmed = $('#writeArmed');
    D.writeState = $('#writeState');
    D.projectSel = $('#projectSel');
    D.projectSel2 = $('#projectSel2');
    D.projectState = $('#projectState');
    D.projectFile = $('#projectFile');
    D.machineList = $('#machineList');
    D.profileState = $('#profileState');
    D.profileBadge = $('#profileBadge');
    D.btnProfileBuild = $('#btnProfileBuild');
    D.btnProfileSave = $('#btnProfileSave');
    D.toasts = $('#toasts');
    D.logPanel = $('#logPanel');
    D.logText = $('#logText');
    D.btnPause = $('#btnPause');
    D.btnReset = $('#btnReset');
    D.btnChart = $('#btnChart');
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

  // 外设列表：AXF 里解析出的优先；缺失的型号用 web/mcu 模板补齐。
  function peripheralList() {
    const base = S.catalog.peripherals || [];
    const tpl = S.mcu.periphs || [];
    if (!tpl.length) return base;
    const meta = String(S.catalog.meta?.mcu || '').toUpperCase();
    const active = String(S.mcu.active || '').toUpperCase();
    // 型号和符号表不是同一家族时，别把两边的外设混在一起
    if (meta && active && meta.slice(0, 6) !== active.slice(0, 6)) return tpl;
    const have = new Set(base.map((p) => p.name));
    const extra = tpl.filter((p) => !have.has(p.name));
    return extra.length ? base.concat(extra) : base;
  }

  function buildIndex() {
    S.index.clear();
    for (const v of S.catalog.variables || []) {
      S.index.set(v.name, {
        ...v, id: v.name, kind: 'var',
        group: v.group || '', bit: v.bit || null,
      });
    }
    for (const p of peripheralList()) {
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

  // ---------------------------------------------------------------- MCU / 芯片
  function resolveMcuId(id) {
    const up = String(id || '').trim().toUpperCase();
    if (!up) return '';
    const exact = S.mcu.models.find((m) => m.id.toUpperCase() === up);
    if (exact) return exact.id;
    const fam = S.mcu.models.find((m) => {
      const mid = m.id.toUpperCase();
      const family = String(m.identify?.family || '').toUpperCase();
      return (family && family === up) || mid.startsWith(up) || up.startsWith(mid);
    });
    return fam ? fam.id : '';
  }

  async function loadMcuIndex() {
    try {
      const data = await fetchJSON('/mcu/index.json');
      S.mcu.models = Array.isArray(data.models) ? data.models : [];
      S.mcu.loaded = true;
    } catch (e) {
      S.mcu.models = [];
      S.mcu.loaded = false;
    }
    if (D.mcuSel) {
      D.mcuSel.innerHTML = '';
      for (const m of S.mcu.models) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.id + (m.package ? ' · ' + m.package : '');
        D.mcuSel.appendChild(o);
      }
    }
    S.mcu.expected = String(S.catalog.meta?.mcu || '');
    const snap = currentSnapshot();
    const want = [snap.mcu, S.mcu.expected].map(resolveMcuId).find(Boolean);
    if (want) await selectMcu(want);
    else renderCards();
  }

  async function loadReginfo(model) {
    model = String(model || '');
    S.reginfo = { model, entries: [], map: new Map(), loaded: false };
    S.readVals.clear();
    if (!model) return;
    try {
      const data = await fetchJSON('/mcu/' + encodeURIComponent(model) + '.info.json?t=' + Date.now());
      const list = Array.isArray(data.entries) ? data.entries : [];
      const map = new Map();
      for (const e of list) {
        if (e && e.key) map.set(String(e.key), e);
      }
      S.reginfo = { model, entries: list, map, loaded: true };
    } catch (e) {
      // 没有 info 文件是正常情况（变量/旧型号），保持空表
    }
  }

  let mcuReq = 0;
  async function selectMcu(id, manual = false) {
    const m = S.mcu.models.find((x) => x.id === id);
    if (!m) return;
    S.mcu.active = id;
    if (manual) S.mcu.manual = true;
    if (D.mcuSel && D.mcuSel.value !== id) D.mcuSel.value = id;
    if (!m.file) {
      await loadReginfo(id);
      renderCards();
      return;
    }
    const req = ++mcuReq;
    try {
      const t = await fetchJSON('/mcu/' + m.file);
      if (req !== mcuReq) return;
      S.mcu.periphs = Array.isArray(t.peripherals) ? t.peripherals : [];
    } catch (e) {
      if (req !== mcuReq) return;
      S.mcu.periphs = [];
    }
    await loadReginfo(id);
    if (req !== mcuReq) return;
    buildIndex();
    renderCatalog();
    renderCards();
  }

  function applyChip(chip) {
    S.chip = chip || null;
    const c = chip || {};
    S.mcu.detected = c.detected || '';
    S.mcu.candidates = Array.isArray(c.candidates) ? c.candidates : [];
    S.mcu.exact = !!c.exact;
    if (c.expected) S.mcu.expected = c.expected;
    S.mcu.match = c.match == null ? null : !!c.match;
    S.mcu.warning = c.warning || '';
    if (S.mcu.detected) {
      const cands = S.mcu.candidates;
      let pick = '';
      if (cands.includes(S.mcu.expected)) pick = S.mcu.expected;
      else if (cands.length) pick = cands[0];
      else pick = resolveMcuId(S.mcu.detected) || S.mcu.detected;
      if (pick) selectMcu(pick);
    }
    renderChipUI();
    renderCards();
    if (S.mcu.warning && S.lastChipWarning !== S.mcu.warning) {
      S.lastChipWarning = S.mcu.warning;
      toast(S.mcu.warning, 'err');
    }
    if (!S.mcu.warning) S.lastChipWarning = '';
  }

  async function probeChipNow() {
    try {
      const r = await post('/api/chip/probe', {});
      if (!r.ok) throw new Error(r.error || '识别失败');
      S.lastChipKey = r.chip ? JSON.stringify(r.chip) : '';
      applyChip(r.chip);
      toast(r.chip?.detected ? '识别到 ' + r.chip.detected : '未识别到芯片型号',
        r.chip?.detected ? 'ok' : 'err');
    } catch (e) {
      toast('芯片识别失败: ' + e.message, 'err');
    }
  }

  function renderChipUI() {
    const c = S.chip;
    const det = c?.detected || '';
    const exp = S.mcu.expected || '';
    const cands = (c?.candidates || []).join(' / ');
    if (D.chipLine) {
      D.chipLine.textContent = det ? '芯片：' + det + (c.exact ? '' : '（系列）') : '芯片：未识别';
    }
    if (D.chipInfo) {
      if (!c) {
        D.chipInfo.textContent = '连接后自动读取芯片 ID；也可以手动选型号。';
      } else {
        D.chipInfo.textContent = '检测：' + (det || '未识别') +
          (c.exact ? '' : '（系列）') +
          ' · 符号表：' + (exp || '未标注') +
          (cands ? ' · 候选：' + cands : '') +
          (c.evidence?.flash_kb ? ' · Flash ' + c.evidence.flash_kb + ' KB' : '');
      }
    }
    if (D.chipWarn) {
      D.chipWarn.classList.toggle('hidden', !S.mcu.warning);
      D.chipWarn.textContent = S.mcu.warning || '';
    }
    if (D.chipBanner) {
      D.chipBanner.classList.toggle('hidden', !S.mcu.warning);
      if (D.chipBannerText) D.chipBannerText.textContent = S.mcu.warning || '';
    }
    if (D.brandSub) {
      D.brandSub.textContent = [S.mcu.active || S.mcu.expected, det && det !== (S.mcu.active || S.mcu.expected) ? '检测 ' + det : '']
        .filter(Boolean).join(' · ') || '通用波形台';
    }
  }

  function fmtDuration(sec) {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function fmtClock(epoch) {
    if (!epoch) return '--';
    return new Date(epoch * 1000).toLocaleTimeString('zh-CN', { hour12: false });
  }

  function ensureMarginDefaults() {
    const rows = Array.from(S.rows.values()).filter((r) => !r.support && r.addr);
    if (!rows.length) { S.margin.cur = ''; S.margin.thr = ''; return; }
    if (!rows.some((r) => r.id === S.margin.cur)) {
      S.margin.cur = (rows.find((r) => /current/i.test(r.name)) || rows[0]).id;
    }
    if (!rows.some((r) => r.id === S.margin.thr)) {
      S.margin.thr = (rows.find((r) => /threshold/i.test(r.name)) || rows[1] || rows[0]).id;
    }
  }

  function marginInfo() {
    const last = latestSample();
    if (!last) return null;
    const cur = S.rows.get(S.margin.cur), thr = S.rows.get(S.margin.thr);
    if (!cur || !thr) return null;
    const c = rowValue(cur, last[1]);
    const t = rowValue(thr, last[1]);
    if (c === null || t === null || !isFinite(c) || !isFinite(t)) return null;
    return { cur: c, thr: t, margin: t - c };
  }

  function renderMarginSelects() {
    ensureMarginDefaults();
    const rows = Array.from(S.rows.values()).filter((r) => !r.support && r.addr);
    for (const [el, key] of [[D.marginCur, 'cur'], [D.marginThr, 'thr']]) {
      if (!el) continue;
      el.innerHTML = '';
      for (const r of rows) {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = shortName(r.name);
        el.appendChild(o);
      }
      el.value = S.margin[key] || '';
    }
  }

  function renderRecordVars(signals) {
    if (!D.recVars) return;
    const list = (signals || []).filter((s) => s && s.id);
    const ids = list.map((s) => String(s.id));
    const sel = S.recordSel instanceof Set ? S.recordSel : (S.recordSel = new Set());
    const keep = new Set(ids.filter((id) => sel.has(id)));
    if (!sel.size) for (const id of ids) keep.add(id);
    S.recordSel = keep;
    D.recVars.innerHTML = '';
    if (!list.length) {
      D.recVars.innerHTML = '<div class="muted" style="font-size:11px">还没有录制列</div>';
      return;
    }
    for (const s of list) {
      const lab = document.createElement('label');
      lab.className = 'rec-var';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = keep.has(s.id);
      cb.addEventListener('change', () => {
        if (cb.checked) S.recordSel.add(s.id); else S.recordSel.delete(s.id);
        saveLocal();
      });
      const span = document.createElement('span');
      span.textContent = s.name + (s.unit ? ' [' + s.unit + ']' : '');
      lab.appendChild(cb);
      lab.appendChild(span);
      D.recVars.appendChild(lab);
    }
  }

  function renderRecordPanel() {
    const rec = S.record || {};
    if (D.recCount) D.recCount.textContent = (rec.count || 0).toLocaleString('en-US');
    if (D.recSeconds) D.recSeconds.textContent = fmtDuration(rec.seconds || 0);
    if (D.recStart) D.recStart.textContent = fmtClock(rec.start_wall);
    if (D.recLimit) D.recLimit.textContent = rec.limit ? Number(rec.limit).toLocaleString('en-US') : '--';
    if (D.recHint) {
      D.recHint.textContent = rec.active
        ? '自动录制中；队列满后最旧样本被丢弃，起始时间会随之前移。'
        : '连接后自动开始录制，断开即停止。';
    }
    const sig = (rec.signals || []).map((s) => s.id).join('|');
    if (sig !== S.recordSig) {
      S.recordSig = sig;
      renderRecordVars(rec.signals || []);
    }
  }

  function exportRecording() {
    const ids = Array.from(S.recordSel || []);
    if (!ids.length) { toast('至少选择一个变量', 'err'); return; }
    window.location.href = '/api/record.csv?ids=' + encodeURIComponent(ids.join(','));
  }

  function renderCards() {
    const p = readProjects();
    const prof = activeProfile();
    if (D.cardProjectVal) {
      D.cardProjectVal.textContent = S.profiles.active || p.active || '默认';
    }
    if (D.cardProjectSub) {
      const model = S.mcu.active || S.mcu.expected || '';
      const vars = (S.catalog.variables || []).length;
      const periphs = peripheralList().length;
      const bits = [];
      if (model) bits.push(model);
      if (vars) bits.push(vars + ' 变量');
      if (periphs) bits.push(periphs + ' 外设');
      if (prof && p.active && p.active !== prof.id) bits.push(p.active);
      if (S.profileSavedAt) bits.push('已保存 ' + new Date(S.profileSavedAt).toLocaleTimeString('zh-CN', { hour12: false }));
      D.cardProjectSub.textContent = bits.join(' · ') || '自动保存到 profiles/';
      D.cardProjectSub.classList.toggle('warn', !!S.mcu.warning);
    }

    const rec = S.record || {};
    if (D.cardRecordVal) D.cardRecordVal.textContent = (rec.count || 0).toLocaleString('en-US') + ' 点';
    if (D.cardRecordSub) {
      const connected = sourceConnected(S.source) && !S.sampler?.error;
      if (rec.count) {
        D.cardRecordSub.textContent = '已录 ' + fmtDuration(rec.seconds || 0) + ' · 起 ' + fmtClock(rec.start_wall);
      } else {
        D.cardRecordSub.textContent = connected ? '等待样本…' : '连接后自动录制';
      }
    }

    const kind = S.source?.kind || 'none';
    const connected = sourceConnected(S.source) && !S.sampler?.error;
    const srcLabel = kind === 'openocd' ? 'OpenOCD' : kind === 'attach' ? 'TCL' : kind === 'sim' ? '仿真' : '待连接';
    if (D.cardSourceVal) {
      D.cardSourceVal.textContent = connected ? srcLabel : (kind === 'none' ? '待连接' : srcLabel + '（断开）');
    }
    if (D.cardSourceSub) {
      const chip = S.mcu.detected || S.mcu.expected || '';
      D.cardSourceSub.textContent = connected
        ? (chip ? '已连接 · ' + chip : '已连接')
        : (kind === 'none' ? '待连接 · 待运行' : '待重连');
      D.cardSourceSub.classList.toggle('warn', !!S.sampler?.error);
    }
    if (D.btnConnect) {
      const label = D.btnConnect.querySelector('.btn-label');
      if (label) label.textContent = connected ? '断开' : '连接';
      D.btnConnect.classList.toggle('primary', !connected);
      D.btnConnect.classList.toggle('danger', !!connected);
      D.btnConnect.title = connected
        ? '再次按下断开，彻底结束 OpenOCD 并释放 HID / SWD，可切给 MRS、Keil 等工具'
        : '连接当前信号源';
    }

    const target = Number(S.rate) || 0;
    const actual = Number(S.sampler?.rate_actual) || 0;
    if (D.cardRateVal) D.cardRateVal.innerHTML = target + ' <i>Hz</i>';
    if (D.cardRateSub) D.cardRateSub.textContent = connected ? '实际 ' + actual.toFixed(1) + ' Hz' : '实际 --';
    const mi = marginInfo();
    const pct = mi && mi.thr > 0 ? Math.max(0, Math.min(100, mi.margin / mi.thr * 100)) : 0;
    if (D.cardRateBar) {
      D.cardRateBar.style.width = pct.toFixed(1) + '%';
      D.cardRateBar.classList.toggle('neg', !!mi && mi.margin < 0);
    }
    if (D.cardRateBarText) {
      D.cardRateBarText.textContent = mi ? '余量 ' + fmtTableNum(mi.margin) : '余量 --';
    }
    renderRecordPanel();
  }

  // 按 id 或名字找目录项（写入模块重绑地址、导入 AXF 后重解析都用到）
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
    sendViewState();
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
    sendViewState();
  }

  function addWaveGroup() {
    const name = (prompt('新分组名称（拖入同一组的波形共享坐标轴）', '分组 ' + (S.wave.seq + 1)) || '').trim();
    if (!name) return;
    S.wave.seq += 1;
    S.wave.groups.push({ id: 'wg' + S.wave.seq, name, visible: true, auto: false });
    renderCatalog();
    saveLocal();
    sendViewState();
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
    sendViewState();
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

  // “已选择”= 共享监视集；表/波开关只决定本端是否显示，不改变监视集
  function selectedRows() {
    const out = [];
    const seen = new Set();
    for (const r of S.rows.values()) {
      const inWrite = !!writeModForRow(r.id);
      const internal = r.support || r.configRole === 'support'
        || ((r.writeOnly || r.configRole === 'write') && !inWrite);
      if (r.monitor && (!internal || r.table || r.plot) && !seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
    for (const v of S.virtuals) {
      if (!seen.has(v.id) && (v.table || v.plot)) { seen.add(v.id); out.push(v); }
    }
    return out;
  }

  function syncSections() {
    const secs = S.ui.sections || (S.ui.sections = { chart: true, table: true, write: true });
    for (const [key, el] of [['chart', D.chartCard], ['table', D.tableCard], ['write', D.writeCard]]) {
      if (el) el.classList.toggle('section-hidden', secs[key] === false);
    }
    if (D.btnChart) {
      const on = secs.chart !== false;
      D.btnChart.classList.toggle('active', on);
      D.btnChart.setAttribute('aria-pressed', on ? 'true' : 'false');
      D.btnChart.title = on ? '隐藏波形分区' : '显示波形分区';
    }
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
    const monitor = d.monitor !== undefined ? !!d.monitor : (!d.support && (visible || !!d.writeOnly));
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
      monitor,
      configRole: String(d.configRole || ''),
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
      old.monitor = true;
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
      row.monitor = true;
      row.groupId = 'default';
      if (row.plot) { const g = waveGroupFor(row); if (g) g.visible = true; }
      S.rows.set(id, row);
      afterSignalsChanged();
      return;
    }
    if (row.support && on) row.support = false;
    if (on) { row.writeOnly = false; row.monitor = true; }
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
    if (on) { row.writeOnly = false; row.monitor = true; }
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
    for (const r of S.rows.values()) if (r.monitor) need.add(r.id);
    for (const v of S.virtuals) for (const id of v.sourceIds) need.add(id);
    // 写入模块即使不在表/波形里，也要采样，才能显示当前值和回读
    for (const m of S.write.mods) if (m.rowId && S.rows.has(m.rowId)) need.add(m.rowId);
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
    }
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

  const WRITE_WIDTH_STEPS = [1 / 3, 0.5, 1];
  function defaultWriteWidth(mode) { return mode === 'switch' ? 1 / 3 : 0.5; }
  function widthLabel(w) {
    if (Math.abs(w - 1 / 3) < 0.01) return '1/3';
    if (Math.abs(w - 0.5) < 0.01) return '1/2';
    return '1';
  }
  function widthSpan(w) {
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
      min: 0, max: 0, step: 1, locked: false, lockValue: 0,
      onValue: 1, offValue: 0,
      status: '', statusKind: '', busy: false, pending: null, timer: 0,
      liveTimer: null, lockTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
      dragging: false, lastResult: null, expanded: false, layout: 'bar',
      addr: row.addr, size: row.size, signed: !!row.signed, name: row.name,
    };
    resetWriteRange(row, mod);
    return mod;
  }

  function releaseWriteRows() {
    const used = new Set(S.write.mods.map((m) => m.rowId));
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
      stopLockWrite(existing);
      existing.liveHeld = false;
      const row = S.rows.get(rowId);
      if (row) {
        row.writeOnly = false;
        row.monitor = true;
        // 从共享配置继承来的 write 角色不要在关闭本地写入模块后继续把自己隐藏掉
        if (row.configRole === 'write') row.configRole = '';
      }
      ensureWriteMods();
      afterSignalsChanged();
      toast('已取消写入：' + (S.index.get(rowId)?.name || rowId) + '（仍保留在已选择）', 'ok');
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
    row.monitor = true;
    S.write.mods.push(makeWriteMod(row));
    ensureWriteMods();
    afterSignalsChanged();
    toast('已加入写入窗口，并加入已选择：' + (row.name || row.id), 'ok');
  }

  // 写入模块的 DOM 只构建一次，后续只更新文本/class，避免整块重建造成闪烁
  const writeUI = new Map();

  function writeStatusText(mod) {
    if (mod.status) return mod.status;
    return S.write.armed ? '就绪' : '未解锁';
  }

  function setWriteError(mod, msg, live) {
    mod.status = msg;
    mod.statusKind = 'err';
    if (live) { stopLiveWrite(mod); stopLockWrite(mod); mod.liveHeld = false; mod.dragging = false; if (mod.locked) mod.locked = false; }
    refreshWriteUI();
    toast(msg, 'err');
  }

  function syncWriteUI() {
    const armed = !!S.write.armed;
    if (D.writeCard) D.writeCard.classList.toggle('locked', !armed);
    if (D.writeArmed) D.writeArmed.checked = armed;
    if (D.writeState) {
      const txt = armed ? ('已解锁 · ' + S.write.mods.length + ' 个模块') : '未解锁';
      if (D.writeState.textContent !== txt) D.writeState.textContent = txt;
      D.writeState.className = armed ? 'ok' : 'muted';
    }
    for (const mod of S.write.mods) {
      const ui = writeUI.get(mod.id);
      if (!ui) continue;
      ui.wbtn.disabled = !armed;
      ui.wbtn.title = armed ? '写入当前值并回读' : '先勾选“允许写入”';
      ui.onBtn.disabled = !armed;
      ui.offBtn.disabled = !armed;
    }
  }

  function updateSliderFill(ui, mod, value) {
    const span = mod.max - mod.min;
    const p = span > 0 ? clamp((Number(value) - mod.min) / span, 0, 1) * 100 : 0;
    ui.slider.style.setProperty('--p', p.toFixed(1) + '%');
  }

  function syncWriteCardExpanded() {
    // 卡片高度由 CSS 保持，展开只影响列表内部滚动，不再压到旁边数值表的高度。
    if (D.writeCard) D.writeCard.classList.toggle('has-expanded', S.write.mods.some((m) => m.expanded));
  }

  function setSwitchButtons(ui, which) {
    ui.onBtn.classList.toggle('on', which === 'on');
    ui.offBtn.classList.toggle('on', which === 'off');
  }

  function writeValueOf(mod, ui) {
    if (mod.mode === 'switch') {
      if (ui.onBtn.classList.contains('on')) return mod.onValue;
      if (ui.offBtn.classList.contains('on')) return mod.offValue;
      return mod.onValue;
    }
    const v = Number(ui.num.value);
    return isFinite(v) ? v : (Number(ui.slider.value) || 0);
  }

  function makeWriteField(labelText, title) {
    const lab = document.createElement('label');
    lab.className = 'wm-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.title = title;
    input.setAttribute('aria-label', title);
    lab.append(span, input);
    return { lab, input };
  }

  function buildWriteStatusRow(ui) {
    const row = document.createElement('div');
    row.className = 'wm-status-row';
    const min = document.createElement('span');
    min.className = 'wm-min';
    const status = document.createElement('span');
    status.className = 'wm-status';
    const liveTag = document.createElement('span');
    liveTag.className = 'wm-live-tag';
    liveTag.textContent = '';
    const liveDot = document.createElement('span');
    liveDot.className = 'wm-live-dot';
    liveDot.title = '周期性写入中';
    const max = document.createElement('span');
    max.className = 'wm-max';
    row.append(min, status, liveTag, liveDot, max);
    ui.minLabel = min;
    ui.status = status;
    ui.liveTag = liveTag;
    ui.liveDot = liveDot;
    ui.maxLabel = max;
    return row;
  }

  function buildWriteDetail(mod, ui) {
    const detail = document.createElement('div');
    detail.className = 'wm-detail';

    const layoutSeg = document.createElement('div');
    layoutSeg.className = 'seg small wm-layout';
    const layoutBtns = {};
    for (const [lay, label] of [['bar', '条'], ['block', '块']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.layout = lay;
      b.textContent = label;
      b.title = lay === 'bar' ? '横条样式（顶部）' : '方块样式（底部）';
      b.addEventListener('click', () => setWriteLayout(mod, lay));
      layoutBtns[lay] = b;
      layoutSeg.appendChild(b);
    }

    const modeSeg = document.createElement('div');
    modeSeg.className = 'seg small wm-mode';
    const modeBtns = {};
    for (const [mode, label] of [['slider', '滑条'], ['switch', '开关']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = mode;
      b.textContent = label;
      b.addEventListener('click', () => setWriteMode(mod, mode));
      modeBtns[mode] = b;
      modeSeg.appendChild(b);
    }

    const widthBtn = document.createElement('button');
    widthBtn.type = 'button';
    widthBtn.className = 'wm-width';
    widthBtn.addEventListener('click', () => {
      mod.width = nextWriteWidth(mod.width);
      mod.widthTouched = true;
      renderWriteMods();
      saveLocal();
    });

    const wbtn = document.createElement('button');
    wbtn.type = 'button';
    wbtn.className = 'btn primary wm-write';
    wbtn.textContent = '写入';
    wbtn.title = '写入当前值并回读';

    const range = document.createElement('div');
    range.className = 'wm-range';
    const minF = makeWriteField('最小', '最小值');
    const maxF = makeWriteField('最大', '最大值');
    const stepF = makeWriteField('步长', '步长');
    const minI = minF.input, maxI = maxF.input, stepI = stepF.input;
    range.append(minF.lab, maxF.lab, stepF.lab);

    const switchVals = document.createElement('div');
    switchVals.className = 'wm-switch-vals';
    const onF = makeWriteField('开值', '开关“开”按钮写入的值');
    const offF = makeWriteField('关值', '开关“关”按钮写入的值');
    const onI = onF.input, offI = offF.input;
    switchVals.append(onF.lab, offF.lab);

    detail.append(layoutSeg, modeSeg, widthBtn, wbtn, range, switchVals);
    ui.layoutBtns = layoutBtns;
    ui.modeBtns = modeBtns;
    ui.widthBtn = widthBtn;
    ui.wbtn = wbtn;
    ui.minI = minI;
    ui.maxI = maxI;
    ui.stepI = stepI;
    ui.onI = onI;
    ui.offI = offI;
    return detail;
  }

  function initWriteValues(mod, ui) {
    const row = S.rows.get(mod.rowId);
    const raw = latestRawOf(row);
    const locked = !!mod.locked;
    const init = (raw === null || locked) ? clamp(Number(mod.liveValue) || mod.min, mod.min, mod.max) : clamp(raw, mod.min, mod.max);
    ui.slider.value = String(init);
    ui.num.value = String(locked ? init : (raw === null ? init : raw));
    updateSliderFill(ui, mod, init);
    const which = raw === null ? '' : (raw === mod.onValue ? 'on' : (raw === mod.offValue ? 'off' : ''));
    setSwitchButtons(ui, which);
  }

  function bindWriteEvents(mod, ui) {
    const { slider, num, onBtn, offBtn, onI, offI, minI, maxI, stepI, lock, wbtn, expand, del } = ui;

    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      num.value = String(v);
      mod.liveValue = v;
      updateSliderFill(ui, mod, v);
    });
    slider.addEventListener('pointerdown', () => {
      mod.dragging = true;
      if (!S.write.armed || mod.locked) return;
      mod.liveHeld = true;
      mod.liveValue = Number(slider.value);
      startLiveWrite(mod, mod.liveValue);
    });
    slider.addEventListener('change', () => {
      const wasHeld = mod.liveHeld;
      finishLiveWrite(mod);
      // 键盘方向键/点击轨道不会触发 pointerdown：默认滑动即写入，补发一次
      if (!wasHeld && !mod.locked && S.write.armed) {
        const v = Number(slider.value);
        if (v !== mod.lastSent) sendWrite(mod, v, { live: false });
      }
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (!isFinite(v)) { num.value = String(mod.liveValue || mod.min); return; }
      const sv = clamp(v, mod.min, mod.max);
      slider.value = String(sv);
      mod.liveValue = v;
      updateSliderFill(ui, mod, sv);
      if (!mod.locked && S.write.armed) sendWrite(mod, v, { live: false });
    });

    const sendSwitch = (which) => {
      const v = which === 'on' ? mod.onValue : mod.offValue;
      mod.liveValue = v;
      mod.lockValue = v;
      setSwitchButtons(ui, which);
      if (S.write.armed) sendWrite(mod, v, { live: false });
    };
    onBtn.addEventListener('click', () => sendSwitch('on'));
    offBtn.addEventListener('click', () => sendSwitch('off'));

    onI.addEventListener('change', () => {
      const v = Number(onI.value);
      mod.onValue = isFinite(v) ? v : 1;
      onI.value = String(mod.onValue);
      ui.onBtn.textContent = String(mod.onValue);
      ui.onBtn.title = '写入开值 ' + mod.onValue;
      saveLocal();
    });
    offI.addEventListener('change', () => {
      const v = Number(offI.value);
      mod.offValue = isFinite(v) ? v : 0;
      offI.value = String(mod.offValue);
      ui.offBtn.textContent = String(mod.offValue);
      ui.offBtn.title = '写入关值 ' + mod.offValue;
      saveLocal();
    });
    minI.addEventListener('change', () => {
      mod.min = Number(minI.value) || 0;
      if (mod.max <= mod.min) { mod.max = mod.min + 1; maxI.value = String(mod.max); }
      ui.slider.min = String(mod.min);
      ui.slider.max = String(mod.max);
      ui.minLabel.textContent = String(mod.min);
      ui.maxLabel.textContent = String(mod.max);
      const v = clamp(Number(ui.slider.value) || mod.min, mod.min, mod.max);
      ui.slider.value = String(v);
      updateSliderFill(ui, mod, v);
      saveLocal();
    });
    maxI.addEventListener('change', () => {
      mod.max = Number(maxI.value) || 0;
      if (mod.max <= mod.min) { mod.min = Math.max(0, mod.max - 1); minI.value = String(mod.min); }
      ui.slider.min = String(mod.min);
      ui.slider.max = String(mod.max);
      ui.minLabel.textContent = String(mod.min);
      ui.maxLabel.textContent = String(mod.max);
      const v = clamp(Number(ui.slider.value) || mod.min, mod.min, mod.max);
      ui.slider.value = String(v);
      updateSliderFill(ui, mod, v);
      saveLocal();
    });
    stepI.addEventListener('change', () => {
      mod.step = Math.max(1, Number(stepI.value) || 1);
      stepI.value = String(mod.step);
      ui.slider.step = String(mod.step);
      saveLocal();
    });
    wbtn.addEventListener('click', () => sendWrite(mod, writeValueOf(mod, ui), { live: false }));
    lock.addEventListener('click', () => setLocked(mod, !mod.locked));
    del.addEventListener('click', () => toggleWriteRow(mod.rowId));
    expand.addEventListener('click', () => {
      mod.expanded = !mod.expanded;
      ui.el.classList.toggle('expanded', mod.expanded);
      ui.expand.textContent = mod.expanded ? '▾' : '▸';
      ui.expand.title = mod.expanded ? '收起数值设置' : '展开数值设置';
      if (mod.expanded && ui.el.scrollIntoView) ui.el.scrollIntoView({ block: 'nearest' });
      syncWriteCardExpanded();
      saveLocal();
    });
  }

  function buildBarModEl(mod) {
    const el = document.createElement('div');
    el.className = 'write-mod layout-bar';
    el.dataset.mod = mod.id;
    el._mod = mod;
    el._layout = 'bar';
    const ui = { el, layout: 'bar' };

    const bar = document.createElement('div');
    bar.className = 'wm-bar';
    const name = document.createElement('span');
    name.className = 'wm-name';
    const type = document.createElement('span');
    type.className = 'wm-type';
    const addr = document.createElement('span');
    addr.className = 'wm-addr';
    const switchBtns = document.createElement('div');
    switchBtns.className = 'wm-switch-btns';
    const onBtn = document.createElement('button');
    onBtn.type = 'button';
    onBtn.className = 'wm-switch-btn';
    const offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'wm-switch-btn';
    onBtn.textContent = String(mod.onValue);
    offBtn.textContent = String(mod.offValue);
    onBtn.title = '写入开值 ' + mod.onValue;
    offBtn.title = '写入关值 ' + mod.offValue;
    switchBtns.append(onBtn, offBtn);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'wm-number';
    num.title = '写入值（按位宽 clamp）';
    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = 'wm-lock';
    lock.textContent = '锁定';
    lock.title = '锁定：持续周期性写入；默认单击/滑动写一次';
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'wm-expand';
    expand.textContent = '▸';
    expand.title = '展开数值设置';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wm-del';
    del.textContent = '×';
    del.title = '从写入窗口移除（保留在已选择）';
    bar.append(name, switchBtns, type, addr, num, lock, expand, del);

    const sliderRow = document.createElement('div');
    sliderRow.className = 'wm-slider-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'wm-slider';
    sliderRow.appendChild(slider);

    Object.assign(ui, { name, type, addr, num, onBtn, offBtn, lock, expand, del, slider, sliderRow });
    const statusRow = buildWriteStatusRow(ui);
    const detail = buildWriteDetail(mod, ui);
    el.append(bar, sliderRow, statusRow, detail);
    bindWriteEvents(mod, ui);
    initWriteValues(mod, ui);
    return ui;
  }

  function buildBlockModEl(mod) {
    const el = document.createElement('div');
    el.className = 'write-mod layout-block';
    el.dataset.mod = mod.id;
    el._mod = mod;
    el._layout = 'block';
    const ui = { el, layout: 'block' };

    const top = document.createElement('div');
    top.className = 'wm-top';
    const name = document.createElement('span');
    name.className = 'wm-name';
    const type = document.createElement('span');
    type.className = 'wm-type';
    const addr = document.createElement('span');
    addr.className = 'wm-addr';
    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = 'wm-lock';
    lock.textContent = '锁定';
    lock.title = '锁定：持续周期性写入；默认单击/滑动写一次';
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'wm-expand';
    expand.textContent = '▸';
    expand.title = '展开数值设置';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wm-del';
    del.textContent = '×';
    del.title = '从写入窗口移除（保留在已选择）';
    top.append(name, type, addr, lock, expand, del);

    const body = document.createElement('div');
    body.className = 'wm-body';
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'wm-slider-wrap';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'wm-slider';
    sliderWrap.appendChild(slider);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'wm-number';
    num.title = '写入值（按位宽 clamp）';
    const switchBtns = document.createElement('div');
    switchBtns.className = 'wm-switch-btns';
    const onBtn = document.createElement('button');
    onBtn.type = 'button';
    onBtn.className = 'wm-switch-btn';
    const offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'wm-switch-btn';
    onBtn.textContent = String(mod.onValue);
    offBtn.textContent = String(mod.offValue);
    onBtn.title = '写入开值 ' + mod.onValue;
    offBtn.title = '写入关值 ' + mod.offValue;
    switchBtns.append(onBtn, offBtn);
    body.append(sliderWrap, num, switchBtns);

    Object.assign(ui, { name, type, addr, num, onBtn, offBtn, lock, expand, del, slider, sliderWrap });
    const statusRow = buildWriteStatusRow(ui);
    const detail = buildWriteDetail(mod, ui);
    el.append(top, body, statusRow, detail);
    bindWriteEvents(mod, ui);
    initWriteValues(mod, ui);
    return ui;
  }

  function buildWriteModEl(mod) {
    return mod.layout === 'block' ? buildBlockModEl(mod) : buildBarModEl(mod);
  }

  function updateWriteModEl(ui, mod, row) {
    const el = ui.el;
    const isBlock = mod.layout === 'block';
    el.classList.toggle('layout-bar', !isBlock);
    el.classList.toggle('layout-block', isBlock);
    el.classList.toggle('mode-switch', mod.mode === 'switch');
    el.classList.toggle('expanded', !!mod.expanded);
    el.style.gridColumn = isBlock ? 'span ' + widthSpan(mod.width) : 'span 12';
    const name = row.name || mod.name || mod.rowId;
    if (ui.name.textContent !== name) ui.name.textContent = name;
    ui.name.title = name + '\n' + hex(row.addr) + ' · ' + row.size + 'B';
    const addrTxt = '@' + hex(row.addr, 6);
    if (ui.addr.textContent !== addrTxt) ui.addr.textContent = addrTxt;
    ui.addr.title = hex(row.addr) + ' · ' + (row.width || row.size * 8) + ' 位';
    const bits = row.width || row.size * 8;
    const bitTxt = Array.isArray(row.bit) ? ' · bit[' + row.bit[0] + ':' + (row.bit[0] + row.bit[1] - 1) + ']' : '';
    const typeTxt = bits + 'b' + bitTxt;
    if (ui.type.textContent !== typeTxt) ui.type.textContent = typeTxt;
    ui.type.title = '位宽 ' + bits + ' 位' + (Array.isArray(row.bit) ? ' · 位域 [' + row.bit[0] + ':' + (row.bit[0] + row.bit[1] - 1) + ']（读-改-写）' : '');
    for (const [lay, b] of Object.entries(ui.layoutBtns)) b.classList.toggle('active', mod.layout === lay);
    for (const [mode, b] of Object.entries(ui.modeBtns)) b.classList.toggle('active', mod.mode === mode);
    const wl = widthLabel(mod.width);
    if (ui.widthBtn.textContent !== wl) ui.widthBtn.textContent = wl;
    ui.widthBtn.title = '方块宽度：1/3 → 1/2 → 整行（当前 ' + wl + '）';
    ui.slider.min = String(mod.min);
    ui.slider.max = String(mod.max);
    ui.slider.step = String(mod.step);
    if (document.activeElement !== ui.minI) ui.minI.value = String(mod.min);
    if (document.activeElement !== ui.maxI) ui.maxI.value = String(mod.max);
    if (document.activeElement !== ui.stepI) ui.stepI.value = String(mod.step);
    if (document.activeElement !== ui.onI) ui.onI.value = String(mod.onValue);
    if (document.activeElement !== ui.offI) ui.offI.value = String(mod.offValue);
    ui.minLabel.textContent = String(mod.min);
    ui.maxLabel.textContent = String(mod.max);
    ui.onBtn.textContent = String(mod.onValue);
    ui.offBtn.textContent = String(mod.offValue);
    ui.onBtn.title = '写入开值 ' + mod.onValue;
    ui.offBtn.title = '写入关值 ' + mod.offValue;
    ui.expand.textContent = mod.expanded ? '▾' : '▸';
    ui.expand.title = mod.expanded ? '收起数值设置' : '展开数值设置';
    ui.lock.classList.toggle('on', !!mod.locked);
    ui.lock.title = mod.locked ? '已锁定：持续周期性写入，点击关闭' : '锁定：持续周期性写入；默认单击/滑动写一次';
    ui.status.textContent = writeStatusText(mod);
    ui.status.className = 'wm-status' + (mod.statusKind ? ' ' + mod.statusKind : (S.write.armed ? '' : ' muted'));
  }

  function setWriteMode(mod, mode) {
    if (mod.mode === mode) return;
    mod.mode = mode;
    mod.status = '';
    mod.statusKind = '';
    mod.expanded = true;
    if (!mod.widthTouched) mod.width = defaultWriteWidth(mode);
    stopLiveWrite(mod);
    mod.liveHeld = false;
    mod.dragging = false;
    renderWriteMods();
    saveLocal();
  }

  function setWriteLayout(mod, layout) {
    if (mod.layout === layout) return;
    mod.layout = layout;
    mod.expanded = true;
    renderWriteMods();
    saveLocal();
  }

  function renderWriteMods() {
    if (!D.writeList) return;
    stopAllDragWrites();
    const list = D.writeList;
    const empty = list.querySelector('.write-empty');
    if (!S.write.mods.length) {
      for (const ui of writeUI.values()) ui.el.remove();
      writeUI.clear();
      if (!empty) {
        const div = document.createElement('div');
        div.className = 'write-empty muted';
        div.textContent = '还没有写入模块。左侧每个信号的“写”键可把该寄存器加入这里。';
        list.appendChild(div);
      }
      syncWriteUI();
      syncWriteCardExpanded();
      return;
    }
    if (empty) empty.remove();
    const ordered = S.write.mods.slice().sort((a, b) => (a.layout === 'block' ? 1 : 0) - (b.layout === 'block' ? 1 : 0));
    const seen = new Set();
    for (const mod of ordered) {
      const row = S.rows.get(mod.rowId);
      if (!row) continue;
      seen.add(mod.id);
      let ui = writeUI.get(mod.id);
      if (!ui || ui.el._mod !== mod || ui.layout !== (mod.layout === 'block' ? 'block' : 'bar')) {
        if (ui) ui.el.remove();
        ui = buildWriteModEl(mod);
        writeUI.set(mod.id, ui);
      }
      updateWriteModEl(ui, mod, row);
      list.appendChild(ui.el);
    }
    for (const [id, ui] of Array.from(writeUI)) {
      if (!seen.has(id)) { ui.el.remove(); writeUI.delete(id); }
    }
    syncWriteUI();
    refreshWriteUI();
    syncWriteCardExpanded();
  }

  function refreshWriteUI() {
    if (!D.writeList) return;
    for (const mod of S.write.mods) {
      const ui = writeUI.get(mod.id);
      if (!ui) continue;
      const row = S.rows.get(mod.rowId);
      const raw = latestRawOf(row);
      const focused = ui.el.contains(document.activeElement);
      const hold = mod.dragging || mod.liveHeld || mod.locked;
      // 正在拖动/输入/请求中时，不用采样值覆盖用户当前值
      if (raw !== null && !focused && !hold && !mod.busy) {
        const sv = clamp(raw, mod.min, mod.max);
        if (ui.slider.value !== String(sv)) {
          ui.slider.value = String(sv);
          updateSliderFill(ui, mod, sv);
        }
        if (ui.num.value !== String(raw)) ui.num.value = String(raw);
        if (mod.mode === 'switch' && !mod.locked) {
          const which = raw === mod.onValue ? 'on' : (raw === mod.offValue ? 'off' : '');
          setSwitchButtons(ui, which);
        }
      }
      if (mod.mode === 'switch' && mod.locked) {
        const which = mod.lockValue === mod.onValue ? 'on' : (mod.lockValue === mod.offValue ? 'off' : '');
        setSwitchButtons(ui, which);
      }
      const lockOn = !!mod.locked && !!S.write.armed;
      const dragOn = !!mod.liveHeld && !!S.write.armed;
      const active = lockOn || dragOn;
      if (ui.el.classList.contains('lock-on') !== active) ui.el.classList.toggle('lock-on', active);
      const tagTxt = lockOn ? 'LOCK' : '';
      if (ui.liveTag.textContent !== tagTxt) ui.liveTag.textContent = tagTxt;
      const txt = writeStatusText(mod);
      if (ui.status.textContent !== txt) ui.status.textContent = txt;
      const cls = 'wm-status' + (mod.statusKind ? ' ' + mod.statusKind : (S.write.armed ? '' : ' muted'));
      if (ui.status.className !== cls) ui.status.className = cls;
      if (ui.lock) {
        const locked = !!mod.locked;
        if (ui.lock.classList.contains('on') !== locked) ui.lock.classList.toggle('on', locked);
        const lockTitle = locked ? '已锁定：持续周期性写入，点击关闭' : '锁定：持续周期性写入；默认单击/滑动写一次';
        if (ui.lock.title !== lockTitle) ui.lock.title = lockTitle;
      }
      const dis = !S.write.armed;
      if (ui.wbtn.disabled !== dis) {
        ui.wbtn.disabled = dis;
        ui.wbtn.title = dis ? '先勾选“允许写入”' : '写入当前值并回读';
      }
      if (ui.onBtn.disabled !== dis) ui.onBtn.disabled = dis;
      if (ui.offBtn.disabled !== dis) ui.offBtn.disabled = dis;
    }
  }

  async function sendWrite(mod, value, opts = {}) {
    const live = !!opts.live;
    const row = S.rows.get(mod.rowId);
    if (!row || !row.addr) { setWriteError(mod, '没有可写的目标', live); return; }
    if (!S.write.armed) { setWriteError(mod, '未解锁：先勾选“允许写入”', live); return; }
    let v = Number(value);
    if (!isFinite(v)) { setWriteError(mod, '写入值无效', live); return; }
    const bits = row.width || (row.size * 8);
    const max = Math.pow(2, bits) - 1;
    v = Math.max(0, Math.min(max, Math.trunc(v)));
    mod.lastSent = v;
    if (mod.busy) {
      // 周期写排队时保留更“显式”的那次请求（显式写优先于锁定 tick）
      if (!mod.pending || !live || mod.pending.live) mod.pending = { value: v, live };
      return;
    }
    mod.busy = true;
    if (!live) {
      mod.status = '写入中…';
      mod.statusKind = 'muted';
      refreshWriteUI();
    }
    try {
      const res = await post('/api/write', {
        addr: row.addr, size: row.size, value: v, bit: row.bit || null, verify: true,
      });
      mod.lastResult = { value: v, readback: res.readback, verified: !!res.verified };
      if (!live) {
        if (S.write.armed) {
          mod.status = '已写 ' + fmtInt(v) + ' · 回读 ' + fmtInt(res.readback) + (res.verified ? '' : '（不一致）');
          mod.statusKind = res.verified ? 'ok' : 'err';
        } else {
          // 请求在途时被锁定：不要把“已写”盖到“未解锁”上
          mod.status = '';
          mod.statusKind = '';
        }
      }
      if (!res.verified && !live) toast('写入已发出，但回读不一致（固件可能正在改它）', 'err');
    } catch (e) {
      mod.status = '写入失败: ' + e.message;
      mod.statusKind = 'err';
      if (live) {
        stopLiveWrite(mod);
        mod.liveHeld = false;
        mod.dragging = false;
        if (mod.locked) { stopLockWrite(mod); mod.locked = false; }
      }
      toast(mod.status, 'err');
    } finally {
      mod.busy = false;
      refreshWriteUI();
      const pending = mod.pending;
      mod.pending = null;
      if (pending && (pending.value !== v || pending.live !== live)) {
        sendWrite(mod, pending.value, { live: pending.live });
      }
    }
  }

  // ---- 写入节拍: 默认滑动/单击写一次; 锁定后持续周期性写 ----
  function stopLiveWrite(mod) {
    if (mod.liveTimer) { clearInterval(mod.liveTimer); clearTimeout(mod.liveTimer); mod.liveTimer = null; }
    if (mod.timer) { clearTimeout(mod.timer); mod.timer = 0; }
    mod.timer = 0;
  }

  function stopLockWrite(mod) {
    if (mod.lockTimer) { clearInterval(mod.lockTimer); clearTimeout(mod.lockTimer); mod.lockTimer = null; }
  }

  function startLiveWrite(mod, value) {
    stopLiveWrite(mod);
    if (!S.write.armed) return;
    mod.liveHeld = true;
    mod.liveValue = Number(value);
    const tick = () => {
      if (!S.write.armed) {
        stopLiveWrite(mod);
        mod.liveHeld = false;
        refreshWriteUI();
        return;
      }
      sendWrite(mod, mod.liveValue, { live: true });
    };
    tick();
    mod.liveTimer = setInterval(tick, 100);
  }

  function finishLiveWrite(mod) {
    mod.dragging = false;
    if (!mod.liveHeld) return;
    mod.liveHeld = false;
    stopLiveWrite(mod);
    if (!S.write.armed) { refreshWriteUI(); return; }
    if (mod.locked) { refreshWriteUI(); return; }
    const v = Number(mod.liveValue);
    const done = mod.lastResult;
    // 最后一次 100ms 写已经覆盖最终值：只把结果落到状态栏一次，不重复发请求
    if (!mod.busy && mod.lastSent === v && done && done.value === v) {
      mod.status = '已写 ' + fmtInt(done.value) + ' · 回读 ' + fmtInt(done.readback) + (done.verified ? '' : '（不一致）');
      mod.statusKind = done.verified ? 'ok' : 'err';
      if (!done.verified) toast('写入已发出，但回读不一致（固件可能正在改它）', 'err');
      refreshWriteUI();
      return;
    }
    // 松开补发最终值（显式写，状态栏只更新这一次）
    sendWrite(mod, v, { live: false });
  }

  function lockValueOf(mod) {
    const ui = writeUI.get(mod.id);
    if (!ui) return null;
    if (mod.mode === 'switch') {
      if (mod.lockValue !== mod.onValue && mod.lockValue !== mod.offValue) mod.lockValue = mod.onValue;
      return mod.lockValue;
    }
    const v = Number(ui.num.value);
    return isFinite(v) ? v : (Number(ui.slider.value) || 0);
  }

  function startLockWrite(mod) {
    stopLockWrite(mod);
    if (!mod.locked || !S.write.armed) return;
    const tick = () => {
      if (!mod.locked || !S.write.armed) { stopLockWrite(mod); refreshWriteUI(); return; }
      const v = lockValueOf(mod);
      if (v === null) return;
      mod.liveValue = v;
      sendWrite(mod, v, { live: true });
    };
    tick();
    mod.lockTimer = setInterval(tick, 100);
  }

  function setLocked(mod, locked) {
    mod.locked = !!locked;
    if (mod.locked) {
      if (mod.mode === 'switch') {
        const raw = latestRawOf(S.rows.get(mod.rowId));
        if (raw !== null && (raw === mod.onValue || raw === mod.offValue)) mod.lockValue = raw;
        else if (mod.lockValue !== mod.onValue && mod.lockValue !== mod.offValue) mod.lockValue = mod.onValue;
      }
      const v = lockValueOf(mod);
      if (v !== null) mod.liveValue = v;
      startLockWrite(mod);
    } else {
      stopLockWrite(mod);
      if (mod.pending && mod.pending.live) mod.pending = null;
    }
    refreshWriteUI();
    saveLocal();
  }

  function stopAllDragWrites() {
    for (const mod of S.write.mods) {
      stopLiveWrite(mod);
      mod.liveHeld = false;
      mod.dragging = false;
    }
  }

  function stopAllLiveWrites() {
    for (const mod of S.write.mods) {
      stopLiveWrite(mod);
      stopLockWrite(mod);
      mod.liveHeld = false;
      mod.dragging = false;
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
    ensureWriteMods();
    ensureWaveGroups();
    syncChannels();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderWriteMods();
    renderMarginSelects();
    updateEmptyHint();
    saveLocal();
    sendViewState();
    if (monitorKey() !== S.lastConfigKey) sendConfig();
    S.dirty = true;
  }

  // ---------------------------------------------------------------- boot
  async function ensureBootMachine() {
    if (!S.profiles.items.length) {
      await loadCatalog();
      return;
    }
    const p = readProjects();
    const cur = p.items[p.active];
    const target = cur && cur.machine;
    if (target && target !== S.profiles.active &&
        S.profiles.items.some((x) => x.id === target)) {
      try {
        const res = await post('/api/profiles/switch', { id: target }, { timeout: 30000 });
        if (res.ok) {
          S.catalog = res.catalog;
          S.profiles.items = res.profiles?.items || S.profiles.items;
          S.profiles.active = target;
          S.arch = res.profile && res.profile.arch === 'riscv' ? 'riscv' : 'cw32';
          S.mcu.expected = String((res.profile && res.profile.mcu) || '');
          buildIndex();
          renderMachines();
          return;
        }
      } catch (e) {
        console.warn('启动时切换机型失败', e);
      }
    }
    await loadCatalog();
  }

  async function boot() {
    cacheDom();
    bindUI();
    await loadProfiles();
    await ensureBootMachine();
    await loadMcuIndex();
    await loadStatus();
    restoreConfig();
    syncArchUI();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderWriteMods();
    ensureWaveGroups();
    syncTablePanel();
    syncSections();
    saveLocal();
    updateProjectUI();
    renderCards();
    resizeChart();
    updateOverlay();
    startCachePolling();
    connectSSE();
    setTimeout(() => maybeApplyShare(), 4000); // SSE 未及时 hello 时的分享兜底
    setTimeout(() => saveLocal(), 1500);   // 启动后把当前机型的配置自动保存一份
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

  function restoreConfig(snapshot) {
    let restored = false;
    // 安全: 解锁状态绝不跨工程/刷新保留，任何在途写入也一并取消
    disarmWrite('');
    if (snapshot === undefined) {
      try {
        const proj = readProjects();
        if (proj.active && proj.items[proj.active]) {
          writeCfgRaw(JSON.stringify(proj.items[proj.active]));
        }
      } catch {}
    }
    try {
      const raw = snapshot === undefined
        ? readCfgRaw()
        : (snapshot ? JSON.stringify(snapshot) : '');
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
        // 时间轴模式持久化；overview 的具体 range 不落盘，避免跨会话拿到过期窗口，
        // 载入后由 ensureChartRange() 按当前可用历史重新 clamp（默认整体历史）。
        S.chartFollow = c.chartFollow !== false;
        S.chartFull = !!c.chartFull;
        S.chartRange = null;
        S.chartAutoFull = !S.chartFollow;
        S.rate = Number(c.rate) || S.rate;
        S.autoZero = !!c.autoZero;
        S.fillOn = c.fillOn !== false;
        S.gridOn = c.gridOn !== false;
        S.zeroLine = c.zeroLine !== false;
        S.glow = !!c.glow;
        if (['openocd', 'attach', 'sim'].includes(c.lastMode)) S.lastMode = c.lastMode;
        if (c.arch === 'riscv' || c.arch === 'cw32') S.arch = c.arch;
        if (c.margin && typeof c.margin === 'object') {
          S.margin.cur = String(c.margin.cur || '');
          S.margin.thr = String(c.margin.thr || '');
        }
        if (Array.isArray(c.recordSel)) S.recordSel = new Set(c.recordSel.map(String));
        S.ui.view = 'list';
        S.ui.tableOpen = c.tableOpen !== false;
        if (c.sections && typeof c.sections === 'object') {
          S.ui.sections = {
            chart: c.sections.chart !== false,
            table: c.sections.table !== false,
            write: c.sections.write !== false,
          };
        }
        // 旧版的“监视卡片”行不再使用，避免留下不可见的采样通道
        for (const [id, row] of Array.from(S.rows.entries())) {
          if (row.watchOnly && !row.table && !row.plot) S.rows.delete(id);
        }
        if (Array.isArray(c.write?.mods)) {
          S.write.mods = c.write.mods.slice(0, 8).map((m, i) => ({
            id: String(m.id || ('wm' + (i + 1))),
            rowId: String(m.rowId || ''),
            mode: m.mode === 'switch' ? 'switch' : 'slider',
            width: Number(m.width) || (m.mode === 'switch' ? 1 / 3 : 0.5),
            widthTouched: !!m.widthTouched,
            min: Number(m.min) || 0,
            max: Number(m.max) || 0,
            step: Math.max(1, Number(m.step) || 1),
            locked: !!m.locked, lockValue: Number(m.lockValue) || 0,
            onValue: Number.isFinite(Number(m.onValue)) ? Number(m.onValue) : 1,
            offValue: Number.isFinite(Number(m.offValue)) ? Number(m.offValue) : 0,
            status: '', statusKind: '', busy: false, pending: null, timer: 0,
            liveTimer: null, lockTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
            dragging: false, lastResult: null, expanded: !!m.expanded, layout: m.layout === 'block' ? 'block' : 'bar',
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
            width: c.write.mode === 'switch' ? 1 / 3 : 0.5,
            widthTouched: false,
            min: Number(c.write.min) || 0,
            max: Number(c.write.max) || 4095,
            step: Math.max(1, Number(c.write.step) || 1),
            locked: !!c.write.locked, lockValue: Number(c.write.lockValue) || 0,
            onValue: Number.isFinite(Number(c.write.onValue)) ? Number(c.write.onValue) : 1,
            offValue: Number.isFinite(Number(c.write.offValue)) ? Number(c.write.offValue) : 0,
            status: '', statusKind: '', busy: false, pending: null, timer: 0,
            liveTimer: null, lockTimer: null, liveHeld: false, liveValue: 0, lastSent: null,
            dragging: false, lastResult: null, expanded: !!c.write.expanded, layout: 'bar',
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
        // 安全: 写入解锁状态不跨工程/刷新保留；旧存档的 write.size 直接忽略
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
    ensureWriteMods();
    ensureWaveGroups();
    syncChannels();
    syncToggles();
    syncChartModeUI();
    syncChartFullUI();
    updateViewSeg();
    syncTablePanel();
    syncSections();
    renderMarginSelects();
    if (S.rows.size) sendConfig(true);
  }

  function releasedAfterRestore() {
    const used = new Set();
    for (const v of S.virtuals) for (const id of v.sourceIds) used.add(id);
    for (const [id, row] of Array.from(S.rows.entries())) {
      if (row.support && !row.table && !row.plot && !used.has(id)) S.rows.delete(id);
    }
  }

  function syncWindowSecSelects() {
    const v = String(S.windowSec);
    for (const sel of [D.winSel, D.winSel2]) {
      if (!sel) continue;
      for (const opt of Array.from(sel.options)) {
        if (opt.dataset && opt.dataset.dynamic) opt.remove();
      }
      if (!Array.from(sel.options).some((o) => o.value === v)) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = fmtSpanMs(S.windowSec * 1000);
        o.dataset.dynamic = '1';
        sel.appendChild(o);
      }
      sel.value = v;
    }
  }

  function setWindowSec(value, opts = {}) {
    let v = Number(value);
    if (!isFinite(v) || v <= 0) return S.windowSec;
    const max = Number(opts.max) > 0 ? Number(opts.max) : 86400;
    v = clamp(v, 0.5, max);
    // 0.1 s 分辨率，避免滚轮/拖拽产生 12.345678 这种值
    v = Math.round(v * 10) / 10;
    S.windowSec = v;
    syncWindowSecSelects();
    if (opts.save !== false) scheduleTimelineSave();
    S.dirty = true;
    return v;
  }

  function syncToggles() {
    syncWindowSecSelects();
    if (D.rateSel) { D.rateSel.value = String(S.rate); syncRateOptions(); }
    const az = $('#autoZero'); if (az) az.checked = S.autoZero;
    const fo = $('#fillOn'); if (fo) fo.checked = S.fillOn;
    const go = $('#gridOn'); if (go) go.checked = S.gridOn;
    const zl = $('#zeroLine'); if (zl) zl.checked = S.zeroLine;
    const gl = $('#glowOn'); if (gl) gl.checked = S.glow;
  }

  function saveLocal() {
    try {
      writeCfgRaw(JSON.stringify({
        v: 2,
        machine: S.profiles.active,
        rows: Array.from(S.rows.values()).map((s) => ({
          id: s.id, name: s.name, addr: s.addr, size: s.size, signed: s.signed,
          scale: s.scale, offset: s.offset, unit: s.unit, color: s.color,
          step: s.step, axis: s.axis, type: s.type,
          table: !!s.table, plot: !!s.plot, support: !!s.support, groupId: s.groupId || '',
          writeOnly: !!s.writeOnly, monitor: !!s.monitor, configRole: s.configRole || '',
        })),
        virtuals: S.virtuals.map((v) => ({
          id: v.id, arrayId: v.arrayId, name: v.name, sourceIds: v.sourceIds.slice(),
          color: v.color, axis: v.axis, unit: v.unit, table: !!v.table, plot: !!v.plot,
          groupId: v.groupId || '',
        })),
        rate: S.rate,
        windowSec: S.windowSec,
        chartFollow: S.chartFollow !== false,
        chartFull: !!S.chartFull,
        autoZero: S.autoZero,
        fillOn: S.fillOn,
        gridOn: S.gridOn,
        zeroLine: S.zeroLine,
        glow: S.glow,
        view: S.ui.view,
        tableOpen: S.ui.tableOpen,
        sections: Object.assign({ chart: true, table: true, write: true }, S.ui.sections || {}),
        mcu: S.mcu.active,
        lastMode: S.lastMode,
        arch: S.arch,
        margin: { cur: S.margin.cur, thr: S.margin.thr },
        recordSel: Array.from(S.recordSel || []),
        wave: {
          seq: S.wave.seq,
          groups: S.wave.groups.map((g) => ({
            id: g.id, name: g.name, visible: g.visible !== false, auto: !!g.auto,
          })),
        },
        write: {
          armed: false, // 解锁状态不落盘
          seq: S.write.seq,
          mods: S.write.mods.map((m) => ({
            id: m.id, rowId: m.rowId, mode: m.mode,
            width: m.width, widthTouched: !!m.widthTouched,
            min: m.min, max: m.max, step: m.step, locked: !!m.locked, lockValue: m.lockValue || 0,
            onValue: m.onValue, offValue: m.offValue, expanded: !!m.expanded, layout: m.layout === 'block' ? 'block' : 'bar',
            addr: m.addr, size: m.size, signed: !!m.signed, name: m.name || '',
          })),
        },
      }));
      // 多工程自动保存
      try {
        const p = readProjects();
        if (!p.active) p.active = '默认';
        p.items[p.active] = Object.assign(JSON.parse(readCfgRaw() || '{}'), {
          name: p.active, savedAt: new Date().toISOString(),
        });
        writeProjectsRaw(JSON.stringify(p));
        S.projectSavedAt = Date.now();
        updateProjectUI();
      } catch {}
      scheduleProfileSave();
    } catch {}
  }

  // ---------------------------------------------------------------- 机型工程
  function activeProfile() {
    return (S.profiles.items || []).find((x) => x.id === S.profiles.active) || null;
  }

  async function loadProfiles() {
    try {
      const data = await fetchJSON('/api/profiles');
      S.profiles.items = Array.isArray(data.items) ? data.items : [];
      S.profiles.active = data.active || '';
      S.profiles.error = data.error || '';
      S.profiles.loaded = true;
    } catch (e) {
      S.profiles.items = [];
      S.profiles.error = e.message;
      S.profiles.loaded = false;
    }
    ensureMachineProjects();
    renderMachines();
    updateProjectUI();
  }

  function findProjectByMachine(id, p) {
    const proj = p || readProjects();
    for (const [name, item] of Object.entries(proj.items || {})) {
      if (item && item.machine === id) return name;
    }
    return '';
  }

  function uniqueProjectName(base) {
    const p = readProjects();
    if (!p.items[base]) return base;
    let n = 2;
    while (p.items[base + ' ' + n]) n += 1;
    return base + ' ' + n;
  }

  // 升级迁移: 每个机型建一个同名工程; 老工程（没有 machine）原样保留
  function ensureMachineProjects() {
    if (!S.profiles.items.length) return;
    const p = readProjects();
    let changed = false;
    for (const prof of S.profiles.items) {
      if (findProjectByMachine(prof.id, p)) continue;
      if (p.items[prof.id] && p.items[prof.id].machine === undefined) {
        p.items[prof.id].machine = prof.id;
      } else if (!p.items[prof.id]) {
        p.items[prof.id] = { name: prof.id, machine: prof.id, savedAt: new Date().toISOString() };
      } else {
        const n = uniqueProjectName(prof.id);
        p.items[n] = Object.assign({}, p.items[prof.id], {
          name: n, machine: prof.id, savedAt: new Date().toISOString(),
        });
      }
      changed = true;
    }
    if (!p.active || !p.items[p.active]) {
      const first = findProjectByMachine(S.profiles.active, p);
      p.active = first || Object.keys(p.items)[0] || '默认';
      changed = true;
    } else if (p.items[p.active].machine === undefined && S.profiles.active) {
      // 老工程没有绑定机型: 当前机型有同名工程就迁过去, 老工程保留在列表里
      const first = findProjectByMachine(S.profiles.active, p);
      if (first && first !== p.active) {
        p.active = first;
        changed = true;
      }
    }
    if (changed) writeProjects(p);
  }

  function resetMachineWorkspace() {
    // 换机型后旧写入模块/波形分组可能指向别的固件地址, 必须清掉
    S.write.mods = [];
    S.write.seq = 0;
    S.write.armed = false;
    S.wave.groups = [{ id: 'default', name: '默认分组', visible: true, auto: true }];
    S.wave.seq = 1;
    S.focusId = null;
    S.hoverT = null;
    S.hoverX = null;
  }

  function renderMachines() {
    if (!D.machineList) return;
    D.machineList.innerHTML = '';
    for (const prof of S.profiles.items) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'machine-card'
        + (prof.id === S.profiles.active ? ' active' : '')
        + (prof.available ? '' : ' unavailable')
        + (S.switching ? ' busy' : '');
      el.title = [prof.note, prof.mcu, prof.source_axf].filter(Boolean).join('\n');
      el.innerHTML =
        '<b>' + esc(prof.name || prof.id) + '</b>' +
        '<span class="mc-mcu">' + esc(prof.mcu || '—') + '</span>' +
        '<span class="mc-sub">' + (prof.variables || 0) + ' 变量 · ' +
        (prof.peripherals || 0) + ' 外设' + (prof.available ? '' : ' · 未生成') + '</span>' +
        '<i class="mc-dot"></i>';
      el.addEventListener('click', () => { switchMachine(prof.id); });
      D.machineList.appendChild(el);
    }
    if (D.profileBadge) D.profileBadge.textContent = S.profiles.active || '机型';
  }

  async function switchMachine(id) {
    if (!id || S.switching) return false;
    if (id === S.profiles.active) {
      toast('当前已是机型 ' + id, 'ok');
      return true;
    }
    S.switching = true;
    renderMachines();
    try {
      saveLocal();                     // 旧机型最新界面状态写回 localStorage
      await flushProfileSave(false);   // 再落盘到 profiles/<旧机型>/config.json
      S.profileSavedAt = 0;
      const res = await post('/api/profiles/switch', { id }, { timeout: 30000 });
      if (!res.ok) throw new Error(res.error || '切换失败');
      S.profiles.items = res.profiles?.items || S.profiles.items;
      S.profiles.active = id;
      S.catalog = res.catalog || { variables: [], peripherals: [], defaults: [], stall: {}, meta: {} };
      S.chip = null;
      S.lastChipKey = '';
      S.mcu.detected = '';
      S.mcu.candidates = [];
      S.mcu.exact = false;
      S.mcu.warning = '';
      S.mcu.manual = false;
      S.arch = res.profile && res.profile.arch === 'riscv' ? 'riscv' : 'cw32';
      S.mcu.expected = String((res.profile && res.profile.mcu) || '');
      S.rows.clear();
      S.virtuals = [];
      S.samples = [];
      S.lastT = 0;
      S.margin.cur = '';
      S.margin.thr = '';
      resetMachineWorkspace();
      buildIndex();
      const mcuId = resolveMcuId(S.mcu.expected);
      if (mcuId) selectMcu(mcuId);

      // 配置优先级: 本机该机型工程 > 服务器 config.json > 空（用新符号表的默认信号）
      const p = readProjects();
      let name = findProjectByMachine(id);
      let cfg = name ? p.items[name] : null;
      const serverCfg = res.config && (Array.isArray(res.config.rows) || Array.isArray(res.config.signals))
        ? res.config : null;
      if ((!cfg || !(cfg.rows || cfg.signals || []).length) && serverCfg) cfg = serverCfg;
      if (!name) name = uniqueProjectName(id);
      p.items[name] = Object.assign({}, cfg || {}, {
        name, machine: id, savedAt: new Date().toISOString(),
      });
      p.active = name;
      writeProjects(p);
      writeCfgRaw(JSON.stringify(p.items[name]));
      restoreConfig(p.items[name]);
      renderAfterProjectLoad();
      applyChip(null);
      updateProjectUI();
      await refreshStatus();
      setTimeout(() => saveLocal(), 0);   // 让新机型的配置也自动落盘
      toast('已切换机型：' + id + (res.was_connected ? '（已断开，请重新连接）' : ''), 'ok');
      return true;
    } catch (e) {
      toast('切换机型失败: ' + brief(e.message), 'err');
      return false;
    } finally {
      S.switching = false;
      renderMachines();
      syncArchUI();
    }
  }

  let profileSaveTimer = 0;
  let profileSaveSeq = 0;

  function scheduleProfileSave() {
    if (!S.profiles.loaded || !S.profiles.active || S.switching) return;
    if (profileSaveTimer) clearTimeout(profileSaveTimer);
    profileSaveTimer = setTimeout(() => {
      profileSaveTimer = 0;
      flushProfileSave(false);
    }, 1800);
  }

  async function flushProfileSave(manual) {
    if (!S.profiles.loaded || !S.profiles.active) return;
    if (profileSaveTimer) { clearTimeout(profileSaveTimer); profileSaveTimer = 0; }
    const machine = S.profiles.active;
    const cfg = Object.assign(currentSnapshot(), { machine, savedAt: new Date().toISOString() });
    const seq = ++profileSaveSeq;
    try {
      const r = await post('/api/profiles/config', { config: cfg, manual: !!manual }, { timeout: 8000 });
      if (seq === profileSaveSeq && r.ok) {
        S.profileSavedAt = Date.now();
        updateProjectUI();
        renderCards();
        if (manual) toast('已保存工程配置：' + machine + ' · ' + (r.saved_at || ''), 'ok');
      }
    } catch (e) {
      if (manual) toast('保存失败: ' + brief(e.message), 'err');
    }
  }

  async function buildCurrentProfile() {
    const id = S.profiles.active;
    if (!id) return;
    if (!confirm('从源 AXF/SVD 重建机型「' + id + '」的符号表？\n地址会按当前固件更新，现有波形会被清空。')) return;
    try {
      toast('正在重建 ' + id + ' 的符号表…');
      const r = await post('/api/profiles/build', { id }, { timeout: 60000 });
      if (!r.ok) throw new Error(r.error || '重建失败');
      S.profiles.items = r.profiles?.items || S.profiles.items;
      if (r.catalog) {
        S.catalog = r.catalog;
        buildIndex();
        S.rows.clear();
        S.virtuals = [];
        S.samples = [];
        S.lastT = 0;
        resetMachineWorkspace();
        restoreConfig({});
        renderAfterProjectLoad();
      }
      renderMachines();
      renderChipUI();
      toast('已重建 ' + id + '：' + (r.counts?.variables || 0) + ' 变量 / ' +
        (r.counts?.peripherals || 0) + ' 外设', 'ok');
    } catch (e) {
      toast('重建失败: ' + brief(e.message), 'err');
    }
  }

  // ---------------------------------------------------------------- 工程存档
  function readProjects() {
    try {
      const raw = readProjectsRaw();
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
    try { writeProjectsRaw(JSON.stringify(p)); } catch {}
  }

  function currentSnapshot() {
    try { return JSON.parse(readCfgRaw() || '{}'); } catch { return {}; }
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
        const machine = p.items[n] && p.items[n].machine;
        o.value = n;
        o.textContent = n + (machine && machine !== n ? ' · ' + machine : '');
        el.appendChild(o);
      }
      el.value = active;
    }
    if (D.projectState) {
      const t = S.projectSavedAt
        ? '已自动保存 ' + new Date(S.projectSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : '自动保存到浏览器 localStorage';
      D.projectState.textContent = t + ' · 当前工程：' + active;
    }
    if (D.profileState) {
      const pid = S.profiles.active;
      const t = S.profileSavedAt
        ? new Date(S.profileSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : '';
      D.profileState.textContent = pid
        ? ('机型 ' + pid + ' · 配置' + (t ? ' 已保存 ' + t : ' 每 1.8s 自动保存到 profiles/' + pid + '/config.json'))
        : '未加载机型配置';
    }
    if (D.profileBadge) D.profileBadge.textContent = S.profiles.active || '机型';
    if (typeof renderCards === 'function') renderCards();
  }

  function renderAfterProjectLoad() {
    resetChartTimeline();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderWriteMods();
    syncTablePanel();
    syncSections();
    updateProjectUI();
    renderCards();
    S.dirty = true;
    scheduleHistoryReload();
  }

  async function switchProject(name) {
    if (!name) return;
    saveLocal(); // 先把当前状态写回旧工程
    const p = readProjects();
    if (!p.items[name]) p.items[name] = currentSnapshot();
    const target = p.items[name] || {};
    if (target.machine && target.machine !== S.profiles.active) {
      // 工程绑定的是另一个机型：先切后端符号/芯片，再恢复这个工程的界面配置
      const ok = await switchMachine(target.machine);
      if (!ok) return;
      const p2 = readProjects();
      p2.items[name] = Object.assign({}, target, { name, machine: target.machine });
      p2.active = name;
      writeProjects(p2);
      writeCfgRaw(JSON.stringify(p2.items[name]));
      S.samples = [];
      S.lastT = 0;
      S.paused = false;
      updatePauseUI();
      restoreConfig(p2.items[name]);
      renderAfterProjectLoad();
      toast('已切换工程：' + name, 'ok');
      return;
    }
    p.active = name;
    writeProjects(p);
    writeCfgRaw(JSON.stringify(p.items[name] || {}));
    S.samples = [];
    S.lastT = 0;
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
    p.items[name] = Object.assign(currentSnapshot(), {
      name, machine: S.profiles.active, savedAt: new Date().toISOString(),
    });
    p.active = name;
    writeProjects(p);
    writeCfgRaw(JSON.stringify(p.items[name]));
    updateProjectUI();
    toast('已创建工程：' + name + '（机型 ' + (S.profiles.active || '?') + '）', 'ok');
  }

  function saveProjectAs() {
    const p = readProjects();
    const name = (prompt('另存为工程名', p.active + ' 副本') || '').trim();
    if (!name) return;
    if (p.items[name] && !confirm('工程“' + name + '”已存在，覆盖？')) return;
    saveLocal();
    p.items[name] = Object.assign(currentSnapshot(), {
      name, machine: S.profiles.active, savedAt: new Date().toISOString(),
    });
    p.active = name;
    writeProjects(p);
    writeCfgRaw(JSON.stringify(p.items[name]));
    updateProjectUI();
    toast('已另存为：' + name, 'ok');
  }

  async function deleteProject() {
    const p = readProjects();
    const names = Object.keys(p.items);
    if (names.length <= 1) { toast('至少保留一个工程', 'err'); return; }
    if (!confirm('删除当前工程“' + p.active + '”？')) return;
    delete p.items[p.active];
    const next = Object.keys(p.items)[0];
    const target = p.items[next] || {};
    p.active = next;
    writeProjects(p);
    if (target.machine && target.machine !== S.profiles.active) {
      const ok = await switchMachine(target.machine);
      if (!ok) return;
      const p2 = readProjects();
      p2.active = next;
      writeProjects(p2);
    }
    writeCfgRaw(JSON.stringify(target));
    S.samples = [];
    S.lastT = 0;
    restoreConfig(target);
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
      if (!data.machine) data.machine = S.profiles.active;
      if (data.machine && data.machine !== S.profiles.active &&
          S.profiles.items.some((x) => x.id === data.machine)) {
        const ok = await switchMachine(data.machine);
        if (!ok) throw new Error('导入的工程绑定机型 ' + data.machine + '，切换失败');
      }
      const p = readProjects();
      let name = (data.name || file.name.replace(/\.json$/i, '') || '导入工程').trim();
      if (p.items[name] && !confirm('工程“' + name + '”已存在，覆盖？')) return;
      p.items[name] = data;
      p.active = name;
      writeProjects(p);
      writeCfgRaw(JSON.stringify(data));
      S.samples = [];
      S.lastT = 0;
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
      const role = x.role === 'support' ? 'support' : (x.role === 'write' ? 'write' : 'signal');
      const support = role === 'support';
      const hidden = role !== 'signal';
      const row = normalizeSignal({
        ...x, support, writeOnly: false, configRole: role, monitor: true,
        table: hidden ? false : undefined,
        plot: hidden ? false : undefined,
      });
      S.rows.set(row.id, row);
    }
    ensureWaveGroups();
    ensureWriteMods();
    syncChannels();
    renderWriteMods();
    renderMarginSelects();
    if (rate) S.rate = Number(rate) || S.rate;
    syncToggles();
  }

  function configKeyOf(list, rate) {
    return JSON.stringify({
      rate: Number(rate) || 0,
      signals: (list || []).map((x) => ({
        id: String(x.id || x.name || ''),
        name: String(x.name || x.id || ''),
        addr: Number(x.addr) >>> 0,
        size: Number(x.size) || 4,
        signed: !!x.signed,
        bit: Array.isArray(x.bit) ? [Number(x.bit[0]), Number(x.bit[1])] : null,
        scale: Number(x.scale ?? 1),
        offset: Number(x.offset ?? 0),
        unit: x.unit !== undefined ? String(x.unit || '') : '',
        color: String(x.color || ''),
        step: !!x.step,
        role: x.role === 'support' ? 'support' : (x.role === 'write' ? 'write' : 'signal'),
      })),
    });
  }

  function adoptSharedConfig(list, rate) {
    const incoming = (list || []).filter((x) => x && x.id);
    const prev = new Map(S.rows);
    const prevChannelKey = S.lastChannelKey || '';
    const incomingKey = configKeyOf(incoming, rate);
    S.rows.clear();
    for (const item of incoming) {
      const was = prev.get(item.id);
      const role = item.role === 'support' ? 'support' : (item.role === 'write' ? 'write' : 'signal');
      const support = role === 'support';
      const hidden = role !== 'signal';
      const row = normalizeSignal({
        ...item,
        support,
        monitor: true,
        configRole: role,
        table: was ? was.table : (hidden ? false : true),
        plot: was ? was.plot : (hidden ? false : true),
        groupId: was ? was.groupId : (item.groupId || ''),
        axis: was ? was.axis : item.axis,
        writeOnly: was ? !!was.writeOnly : false,
      });
      S.rows.set(row.id, row);
    }
    if (rate) S.rate = Number(rate) || S.rate;
    if (D.rateSel) D.rateSel.value = String(S.rate);
    ensureWaveGroups();
    ensureWriteMods();
    syncChannels();
    const channelKey = S.signals.map((s) => s.id).join('|');
    const channelChanged = channelKey !== prevChannelKey;
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderWriteMods();
    renderMarginSelects();
    syncToggles();
    updateEmptyHint();
    if (channelChanged) { S.samples = []; S.lastT = 0; resetChartTimeline(); }
    S.lastConfigKey = incomingKey;
    S.configDirty = false;
    saveLocal();
    sendViewState(true);
    loadHistory();
    S.dirty = true;
    // 本地写入模块可能补充了共享集之外的通道；如果本地监视集与服务器不同，主动补发一次
    if (monitorKey() !== incomingKey) sendConfig(true);
  }

  function monitorConfigPayload() {
    return {
      rate: S.rate,
      // 共享监视集：只发 monitor 通道，表/波形可见性不影响采样
      signals: S.signals.map((s) => ({
        id: s.id, name: s.name, addr: s.addr, size: s.size, signed: s.signed,
        bit: s.bit, scale: s.scale, offset: s.offset, unit: s.unit,
        color: s.color, step: s.step,
        role: s.configRole || (s.support ? 'support' : (s.writeOnly ? 'write' : 'signal')),
      })),
    };
  }

  function monitorKey() {
    return JSON.stringify(monitorConfigPayload());
  }

  function sendConfig(force = false) {
    S.configDirty = true;
    if (S.configTimer) clearTimeout(S.configTimer);
    const run = async () => {
      S.configTimer = 0;
      if (!S.configDirty && !force) return;
      if (!S.sseReady) { S.configDirty = true; return; }
      S.configDirty = false;
      const payload = monitorConfigPayload();
      const key = JSON.stringify(payload);
      if (!force && key === S.lastConfigKey) return;
      S.lastConfigKey = key;
      try {
        await post('/api/config', payload);
      } catch (e) {
        toast('配置下发失败: ' + e.message, 'err');
      }
    };
    if (force) return run();
    S.configTimer = setTimeout(run, 120);
  }

  function otherViewersFor(id) {
    return (S.presence || []).filter((p) => p
      && p.id !== S.clientId
      && Array.isArray(p.visible)
      && p.visible.includes(id));
  }

  function updatePresence(list) {
    const arr = Array.isArray(list) ? list : [];
    const key = JSON.stringify(arr);
    if (key === S.presenceKey) return;
    S.presenceKey = key;
    S.presence = arr;
    if (S.ui.tab === 'waves') renderCatalog();
  }

  function localVisibleIds() {
    const out = [];
    const seen = new Set();
    for (const r of S.rows.values()) {
      if (!r.monitor) continue;
      const g = waveGroupFor(r);
      const plotOn = !!r.plot && (!g || g.visible !== false);
      if (r.table || plotOn) { out.push(r.id); seen.add(r.id); }
    }
    // 虚拟行（AVG）本身不采样，但它引用的源通道正在被本端查看
    for (const v of S.virtuals) {
      const g = waveGroupFor(v);
      const plotOn = !!v.plot && (!g || g.visible !== false);
      if (!v.table && !plotOn) continue;
      for (const id of v.sourceIds || []) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    return out;
  }

  function writeModsSnapshot() {
    return S.write.mods.map((m) => ({
      id: m.id, rowId: m.rowId, mode: m.mode,
      width: m.width, widthTouched: !!m.widthTouched,
      min: m.min, max: m.max, step: m.step,
      onValue: m.onValue, offValue: m.offValue, lockValue: m.lockValue || 0,
      locked: false, // 分享/复制不继承锁定，避免对方已解锁时立即周期写
      expanded: !!m.expanded, layout: m.layout || 'bar',
      addr: m.addr, size: m.size, signed: !!m.signed, name: m.name || '',
    }));
  }

  function waveLayoutPayload() {
    const groups = (S.wave.groups || []).map((g) => ({
      id: String(g.id), name: String(g.name || g.id),
      auto: !!g.auto, visible: g.visible !== false,
    }));
    const rows = {};
    const table = [];
    const plot = [];
    const axes = {};
    const add = (row) => {
      rows[row.id] = row.groupId || 'default';
      if (row.table) table.push(row.id);
      if (row.plot) plot.push(row.id);
      axes[row.id] = row.axis === 'right' ? 'right' : 'left';
    };
    for (const r of S.rows.values()) {
      const inWrite = !!writeModForRow(r.id);
      const internal = r.support || r.configRole === 'support'
        || ((r.writeOnly || r.configRole === 'write') && !inWrite);
      if (!r.monitor || internal) continue;
      add(r);
    }
    for (const v of S.virtuals) add(v);
    return { groups, rows, table, plot, axes, write: writeModsSnapshot() };
  }

  function sendViewState(force = false) {
    if (!S.sseReady || !S.clientId) return;
    const visible = localVisibleIds();
    const layout = waveLayoutPayload();
    const key = JSON.stringify({ visible, layout });
    if (!force && key === S.viewSentKey) return;
    S.viewSentKey = key;
    if (S.viewTimer) clearTimeout(S.viewTimer);
    const run = () => {
      S.viewTimer = 0;
      fetch('/api/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: S.clientId, label: S.clientLabel || '', visible, layout }),
      }).catch(() => {});
    };
    if (force) return run();
    S.viewTimer = setTimeout(run, 120);
  }

  function applyWriteModsSnapshot(list) {
    if (!Array.isArray(list)) return false;
    const mods = [];
    for (const m of list.slice(0, 16)) {
      if (!m || !m.rowId) continue;
      const row = S.rows.get(String(m.rowId));
      if (!row) continue;
      row.monitor = true;
      const mod = makeWriteMod(row);
      mod.mode = m.mode === 'switch' ? 'switch' : 'slider';
      mod.width = Number(m.width) || defaultWriteWidth(mod.mode);
      mod.widthTouched = !!m.widthTouched;
      if (Number.isFinite(Number(m.min))) mod.min = Number(m.min);
      if (Number.isFinite(Number(m.max))) mod.max = Number(m.max);
      mod.step = Math.max(1, Number(m.step) || 1);
      mod.onValue = Number.isFinite(Number(m.onValue)) ? Number(m.onValue) : 1;
      mod.offValue = Number.isFinite(Number(m.offValue)) ? Number(m.offValue) : 0;
      mod.lockValue = Number.isFinite(Number(m.lockValue)) ? Number(m.lockValue) : 0;
      mod.locked = false;
      mod.expanded = !!m.expanded;
      mod.layout = m.layout === 'block' ? 'block' : 'bar';
      mods.push(mod);
    }
    S.write.mods = mods;
    S.write.seq = Math.max(1, ...mods.map((m) => Number(String(m.id).replace(/\D/g, '')) || 0));
    ensureWriteMods();
    return true;
  }

  function applyWaveLayout(layout) {
    if (!layout || !Array.isArray(layout.groups) || !layout.groups.length) return false;
    const remoteGroups = layout.groups.filter((g) => g && g.id);
    const remoteDefault = remoteGroups.find((g) => g.id === 'default');
    const map = { default: 'default' };
    let seq = Math.max(1, Number(S.wave.seq) || 1);
    const groups = [{
      id: 'default',
      name: (remoteDefault && remoteDefault.name) || '默认分组',
      auto: remoteDefault ? remoteDefault.auto !== false : true,
      visible: remoteDefault ? remoteDefault.visible !== false : true,
    }];
    for (const g of remoteGroups) {
      if (g.id === 'default') continue;
      seq += 1;
      while (S.wave.groups.some((x) => x.id === 'wg' + seq)) seq += 1;
      const id = 'wg' + seq;
      map[g.id] = id;
      groups.push({
        id,
        name: String(g.name || ('分组 ' + seq)),
        auto: !!g.auto,
        visible: g.visible !== false,
      });
    }
    S.wave.seq = Math.max(seq, ...groups.map((g) => Number(String(g.id).replace(/\D/g, '')) || 0));
    S.wave.groups = groups;
    const remoteRows = layout.rows && typeof layout.rows === 'object' ? layout.rows : {};
    const tableSet = Array.isArray(layout.table) ? new Set(layout.table) : null;
    const plotSet = Array.isArray(layout.plot) ? new Set(layout.plot) : null;
    const axes = layout.axes && typeof layout.axes === 'object' ? layout.axes : {};
    const apply = (row) => {
      const gid = remoteRows[row.id];
      row.groupId = gid && map[gid] ? map[gid] : 'default';
      if (tableSet) row.table = tableSet.has(row.id);
      if (plotSet) row.plot = plotSet.has(row.id);
      if (axes[row.id] === 'right' || axes[row.id] === 'left') row.axis = axes[row.id];
    };
    for (const r of S.rows.values()) apply(r);
    for (const v of S.virtuals) apply(v);
    if (Array.isArray(layout.write)) applyWriteModsSnapshot(layout.write);
    ensureWaveGroups();
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderWriteMods();
    updateEmptyHint();
    S.dirty = true;
    saveLocal();
    sendViewState(true);
    return true;
  }

  function copyWaveLayoutFrom(peer) {
    if (!applyWaveLayout(peer && peer.layout)) {
      toast('客户端 ' + (peer && peer.no ? peer.no : '?') + ' 暂无可复制的布局', 'err');
      return;
    }
    toast('已复制 ' + (peer.label || ('客户端 ' + peer.no)) + ' 的分组/显示布局到本窗口', 'ok');
  }

  function confirmRemoveMonitor(row) {
    if (!row) return;
    if (row.kind === 'virtual') {
      if (confirm('从本端移除虚拟行“' + shortName(row.name) + '”？')) removeSignal(row.id);
      return;
    }
    const mods = S.write.mods.filter((m) => m.rowId === row.id);
    const viewers = otherViewersFor(row.id);
    const labels = viewers.map((p) => p.label || ('客户端 ' + p.no)).join('、');
    const base = viewers.length
      ? '“' + shortName(row.name) + '”正在被 ' + labels + ' 查看。\n删除后所有客户端都会同步移除。'
      : '从共享监视集移除“' + shortName(row.name) + '”？所有在线客户端都会同步移除。';
    const extra = mods.length ? '\n该信号还属于写入模块，删除会同时移除写入模块。' : '';
    if (!confirm(base + extra + '\n仍要删除？')) return;
    for (const m of mods) {
      stopLiveWrite(m);
      stopLockWrite(m);
    }
    if (mods.length) S.write.mods = S.write.mods.filter((m) => m.rowId !== row.id);
    removeSignal(row.id);
  }

  function shareIdFromHash() {
    const m = /(?:^|[#&])share=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  function shareBase() {
    const q = new URLSearchParams(location.search).get('lan');
    if (q) {
      try {
        const u = new URL(q);
        if ((u.protocol === 'http:' || u.protocol === 'https:')
            && !/^(127\.|localhost$)/i.test(u.hostname)) return u.origin;
      } catch {}
    }
    const host = String(location.hostname || '');
    if (/^192\.168\./.test(host)) return location.origin;
    const lan = S.status && S.status.lan;
    const ips = lan && Array.isArray(lan.ips) ? lan.ips.slice() : [];
    const rank = (ip) => {
      if (/^192\.168\./.test(ip)) return 0;
      if (/^10\./.test(ip)) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
      return 9;
    };
    ips.sort((a, b) => rank(a) - rank(b));
    const ip = ips.find((x) => rank(x) < 9);
    if (ip) {
      const port = Number(lan.port) || Number(location.port) || 0;
      const suffix = port && !(port === 80 && location.protocol === 'http:') ? ':' + port : '';
      return location.protocol + '//' + ip + suffix;
    }
    return location.origin;
  }

  async function shareViewLink() {
    const lanNow = S.status && S.status.lan;
    if (!lanNow || !Array.isArray(lanNow.ips) || lanNow.ips.length === 0) {
      try {
        const st = await fetchJSON('/api/status');
        if (st && st.lan) S.status = st;
      } catch {}
    }
    const snapshot = {
      v: 1,
      profile: S.profiles.active || '',
      rate: S.rate,
      windowSec: S.windowSec,
      chart: {
        autoZero: !!S.autoZero, fillOn: S.fillOn !== false,
        gridOn: S.gridOn !== false, zeroLine: S.zeroLine !== false, glow: !!S.glow,
      },
      signals: monitorConfigPayload().signals,
      layout: waveLayoutPayload(),
    };
    const res = await post('/api/share', snapshot);
    if (!res || !res.ok || !res.id) throw new Error((res && res.error) || '生成分享失败');
    const base = shareBase();
    const path = location.pathname || '/';
    const url = base.replace(/\/$/, '') + path + '#share=' + encodeURIComponent(res.id);
    const ok = await copyText(url);
    if (ok) toast('分享链接已复制：' + url, 'ok');
    else prompt('浏览器不允许自动复制，请手动复制分享链接：', url);
    return url;
  }

  function applyShareChart(share) {
    if (share.windowSec != null && Number.isFinite(Number(share.windowSec))) {
      setWindowSec(Number(share.windowSec), { save: false });
      S.view = null;
    }
    const c = share.chart;
    if (c && typeof c === 'object') {
      S.autoZero = !!c.autoZero;
      S.fillOn = c.fillOn !== false;
      S.gridOn = c.gridOn !== false;
      S.zeroLine = c.zeroLine !== false;
      S.glow = !!c.glow;
    }
    syncToggles();
    renderCards();
    S.dirty = true;
  }

  async function maybeApplyShare() {
    if (S.shareApplied || S.shareApplying) return;
    const sid = shareIdFromHash();
    if (!sid) return;
    S.shareApplying = true;
    try {
      const share = await fetchJSON('/api/share/' + encodeURIComponent(sid));
      if (!share || !share.ok || !Array.isArray(share.signals)) throw new Error('分享内容无效');
      if (share.profile && S.profiles.active && share.profile !== S.profiles.active) {
        const ok = await switchMachine(share.profile);
        if (!ok) toast('分享来自机型 ' + share.profile + '，切换失败，尝试按分享内容恢复', 'err');
      }
      adoptSharedConfig(share.signals, share.rate);
      if (share.layout) applyWaveLayout(share.layout);
      applyShareChart(share);
      await sendConfig(true);
      sendViewState(true);
      S.shareId = sid;
      S.shareApplied = true;
      toast('已应用分享的波形选择和显示布局', 'ok');
    } catch (e) {
      toast('应用分享失败: ' + brief(e.message), 'err');
    } finally {
      S.shareApplying = false;
    }
  }

  // ---------------------------------------------------------------- SSE
  function connectSSE() {
    if (S.es) S.es.close();
    if (!S.viewHeartbeat) {
      S.viewHeartbeat = setInterval(() => { if (S.sseReady) sendViewState(true); }, 5000);
    }
    const es = new EventSource('/api/stream');
    S.es = es;
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        applyStatus(msg.status);
        S.sseReady = true;
        S.clientId = String(msg.clientId || '');
        S.clientNo = Number(msg.clientNo) || 0;
        updatePresence(msg.presence);
        const shared = msg.config?.signals || [];
        const clients = Number(msg.clients) || 1;
        const sharePending = !!shareIdFromHash() || S.shareApplying || S.shareApplied;
        if (S.shareApplied) {
          // 分享已应用: 服务器可能还是旧配置, 以分享内容为准
          sendConfig(true);
        } else if (sharePending) {
          // 分享正在/即将应用: 不要先用服务器旧配置覆盖
          maybeApplyShare();
        } else if (clients <= 1 && S.rows.size) {
          // 只有自己在线: 用本地监视集初始化共享配置
          sendConfig(true).then(loadHistory);
        } else if (shared.length) {
          // 多客户端: 以服务器共享配置为准, 不覆盖别人的配置
          adoptSharedConfig(shared, msg.config?.rate);
        } else if (S.rows.size) {
          sendConfig(true).then(loadHistory);
        } else {
          loadHistory();
        }
        sendViewState(true);
      } else if (msg.type === 'config') {
        // 任一客户端改了共享监视集/参数, 所有客户端同步
        adoptSharedConfig(msg.config?.signals || [], msg.config?.rate);
      } else if (msg.type === 'presence') {
        updatePresence(msg.presence);
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
      // 优先按点数拉满服务端 history deque（上限 40000，约 100 Hz × 400 s），
      // 时间轴 overview 需要“当前可用历史”而不是固定 60 s。
      let r = null;
      try {
        r = await fetchJSON('/api/history?limit=40000');
      } catch (e) {
        r = null;
      }
      if (!r || !Array.isArray(r.samples) || !r.samples.length) {
        // 老服务端不支持 limit 时退回 seconds（服务端上限 180 s）
        r = await fetchJSON('/api/history?seconds=180');
      }
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
    pruneSamples();
    syncAutoFullRange();
    S.dirty = true;
    refreshLiveValues();
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
    }
    S.sampleCountSeen += batch.length;
    pruneSamples();
    syncAutoFullRange();
    S.dirty = true;
    refreshLiveValues();
  }

  function pruneSamples() {
    // 时间轴 overview 要能看到客户端已缓存的全部历史，因此不再按 windowSec 裁掉旧样本。
    // 只保留内存硬上限（20 万点）；服务端 deque 本身最多 4 万点，正常不会触顶。
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

  function hasCustomCalibration(row) {
    if (!row) return false;
    if (row.kind === 'virtual') return String(row.unit || '').trim() !== '';
    return (row.scale ?? 1) !== 1 || (row.offset ?? 0) !== 0 || String(row.unit || '').trim() !== '';
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

  function plotValue(row, vals, pane) {
    // 共享组也按每行自己的换算值绘制；未设置换算的行 scale=1/offset=0，等价原始值。
    return rowValue(row, vals);
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
        const v = rawValue(row, S.samples[i][1]);
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

  function disarmWrite(reason) {
    for (const mod of S.write.mods) {
      stopLiveWrite(mod);
      stopLockWrite(mod);
      mod.liveHeld = false;
      mod.dragging = false;
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
      resetChartTimeline();
      updatePauseUI();
      S.dirty = true;
    }
    S.serverUptime = up;
    S.source = st.source || { kind: 'none', connected: false };
    S.sampler = st.sampler || {};
    S.record = st.record || {};
    S.lastStatusAt = Date.now();
    if (st.profiles && Array.isArray(st.profiles.items) && !S.switching) {
      const oldActive = S.profiles.active;
      S.profiles.items = st.profiles.items;
      S.profiles.active = st.profiles.active || oldActive;
      S.profiles.loaded = true;
      if (oldActive !== S.profiles.active) {
        renderMachines();
        updateProjectUI();
      }
    }
    const chipKey = st.chip ? JSON.stringify(st.chip) : '';
    if (chipKey !== S.lastChipKey) {
      S.lastChipKey = chipKey;
      applyChip(st.chip);
    }
    const kind = S.source.kind || 'none';
    const connected = sourceConnected(S.source) && !S.sampler.error;
    if (connected && kind !== 'none') S.lastMode = kind;
    if (connected && (st.arch === 'riscv' || st.arch === 'cw32') && st.arch !== S.arch) {
      S.arch = st.arch;
      syncArchUI();
    }
    if (!connected && S.write.armed) {
      disarmWrite('连接断开，写入已锁定');
      saveLocal();
    }
    const label = kind === 'openocd' ? 'OpenOCD' : kind === 'attach' ? 'TCL' : kind === 'sim' ? '仿真' : '待连接';
    D.connText.textContent = label;
    D.connRate.textContent = (S.sampler.rate_actual || S.sampler.rate || 0).toFixed(0) + ' Hz';
    D.connPill.classList.toggle('on', !!connected);
    D.connPill.classList.toggle('warn', !connected || !!S.sampler.error);
    D.statSamples.textContent = fmtInt(S.sampler.samples || 0);
    D.statRate.textContent = (S.sampler.rate_actual || 0).toFixed(1) + ' Hz';
    const lat = st.uptime != null && S.sampler.last_t ? Math.max(0, st.uptime * 1000 - S.sampler.last_t) : null;
    D.statLatency.textContent = lat === null ? '--' : (lat < 1000 ? Math.round(lat) + ' ms' : (lat / 1000).toFixed(1) + ' s');
    D.statRecord.textContent = S.record.active
      ? ('自动 ' + ((S.record.count || 0).toLocaleString('en-US') + ' 点'))
      : '关';
    let msg = '运行中';
    if (S.sampler.error) msg = brief(S.sampler.error);
    else if (S.source.kind === 'none') msg = brief(st.connect_error) || '待连接 · 待运行';
    else if (!connected) msg = '连接已断开';
    else if (!S.sampler.samples) msg = '待运行';
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
      toast('连接失败: ' + brief(st.connect_error), 'err');
    }
    updateOverlay();
    renderCards();
    if (!S.rows.size && st.config?.signals?.length && !S.ui.connecting) {
      adoptSignals(st.config.signals, st.config.rate);
      renderSelected(); renderLegend(); renderValueTable();
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
    // 启动页已关闭：连接入口改用顶栏“连接”按钮 / 信号源卡片，不再弹遮罩
    if (D.overlay) D.overlay.classList.add('hidden');
  }

  async function doConnect(mode) {
    S.lastMode = mode;
    D.srcSegMode = mode;
    const payload = { mode };
    if (mode === 'openocd') {
      payload.arch = S.arch;
      const prof = activeProfile();
      if (prof) {
        if (prof.target) payload.target = prof.target;
        if (prof.interface) payload.interface = prof.interface;
      }
      if (S.arch === 'riscv' && S.rate > 50) {
        S.rate = 20;
        syncToggles();
        saveLocal();
        toast('RISC-V 每次读取需要短暂 halt，采样率已降到 20 Hz');
      }
      const p = ($('#inpOcd')?.value || '').trim();
      if (p) payload.openocd = p;
    } else if (mode === 'attach') {
      payload.host = ($('#inpAttachHost')?.value || '127.0.0.1').trim();
      payload.port = Number($('#inpAttachPort')?.value || 6666);
    }
    S.ui.connecting = true;
    S.ui.overlayDismissed = true;
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
      toast('连接失败: ' + brief(e.message), 'err');
      openLog();
    } finally {
      S.ui.connecting = false;
      updateOverlay();
      fitTopbar();
      refreshStatus();
    }
  }

  async function disconnectSource() {
    try {
      await post('/api/disconnect', {});
      disarmWrite('已断开，写入已锁定');
      // 主动断开时不要把“连接目标”弹窗又顶出来
      S.ui.overlayDismissed = true;
      S.lastChipKey = '';
      applyChip(null);
      toast('已断开，调试器已释放', 'ok');
      await refreshStatus();
    } catch (e) {
      toast('断开失败: ' + e.message, 'err');
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
    if (D.selCount) D.selCount.textContent = String(selectedRows().length);
    D.search.placeholder = tab === 'periph' ? '搜索外设 / 寄存器 / 位' : tab === 'custom' ? '自定义地址'
      : tab === 'waves' ? '搜索已选择 / 分组' : '搜索变量 / 寄存器 / 地址';
    const viewRow = document.querySelector('.view-row');
    if (viewRow) viewRow.classList.toggle('hidden', tab === 'waves');
    if (D.viewNote) {
      D.viewNote.textContent = tab === 'waves'
        ? '分组 · 独立轴 / 共享轴 · 拖动合并'
        : (tab === 'periph' ? '按外设分组' : tab === 'vars' ? '按对象分组' : '任意地址');
    }
    // 树视图暂时下线（按钮保留，后续替换）：统一走列表
    S.ui.view = 'list';
    if (tab === 'vars') {
      renderVars(body, q);
    } else if (tab === 'periph') {
      renderPeriph(body, q);
    } else if (tab === 'waves') {
      renderWaveList(body, q);
    } else {
      renderCustom(body);
    }
  }

  function waveRowToggles(row) {
    if (row.kind !== 'virtual') {
      return rowFlagButtons(row.id, S.index.get(row.id) || row, { flat: true });
    }
    const wrap = document.createElement('span');
    wrap.className = 'sig-toggles flat';
    for (const [flag, label, title] of [['table', '表', '数值表'], ['plot', '波', '波形']]) {
      const b = document.createElement('button');
      b.className = 'tgl tgl-' + flag + (row[flag] ? ' on' : '');
      b.textContent = label;
      b.title = (row[flag] ? '从' : '加入') + title;
      b.dataset.avgToggle = row.arrayId;
      b.dataset.flag = flag;
      b.setAttribute('aria-pressed', row[flag] ? 'true' : 'false');
      wrap.appendChild(b);
    }
    return wrap;
  }

  function renderRemoteLayouts(body) {
    const peers = (S.presence || []).filter((p) => p
      && p.id !== S.clientId
      && p.layout && Array.isArray(p.layout.groups) && p.layout.groups.length);
    if (!peers.length) return;
    const details = document.createElement('details');
    details.className = 'wave-remote';
    const summary = document.createElement('summary');
    summary.textContent = '其他端布局 · ' + peers.length + '（展开查看 / 复制）';
    details.appendChild(summary);
    const nameOf = (id) => {
      const row = S.rows.get(id) || S.virtuals.find((v) => v.id === id);
      return row ? shortName(row.name) : String(id);
    };
    for (const peer of peers) {
      const layout = peer.layout;
      const goods = layout.groups || [];
      const rows = layout.rows && typeof layout.rows === 'object' ? layout.rows : {};
      const byGroup = {};
      for (const [id, gid] of Object.entries(rows)) {
        (byGroup[gid] = byGroup[gid] || []).push(id);
      }
      const shown = new Set([...(layout.table || []), ...(layout.plot || [])]).size;
      const item = document.createElement('div');
      item.className = 'wr-item';
      const head = document.createElement('div');
      head.className = 'wr-head';
      const label = document.createElement('span');
      label.textContent = peer.label || ('客户端 ' + peer.no);
      const meta = document.createElement('span');
      meta.className = 'wr-meta';
      const wm = Array.isArray(layout.write) ? layout.write.length : 0;
      meta.textContent = goods.length + ' 组 · ' + shown + ' 显示' + (wm ? ' · ' + wm + ' 写' : '');
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'mini';
      copy.textContent = '复制到本窗口';
      copy.title = '把客户端 ' + peer.no + ' 的分组/显示布局复制到当前预览窗口（只影响本端）';
      copy.addEventListener('click', () => copyWaveLayoutFrom(peer));
      head.append(label, meta, copy);
      const detail = document.createElement('div');
      detail.className = 'wr-groups';
      detail.textContent = goods.map((g) => {
        const names = (byGroup[g.id] || []);
        const headTxt = (g.name || g.id) + '（' + (g.auto ? '独立轴' : '共享轴')
          + (g.visible === false ? '·隐藏' : '') + '，' + names.length + ' 行）';
        const list = names.slice(0, 6).map(nameOf).join('、') + (names.length > 6 ? ' …' : '');
        return headTxt + (list ? '：' + list : '');
      }).join('  |  ');
      item.append(head, detail);
      details.appendChild(item);
    }
    body.appendChild(details);
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
    hint.textContent = '本端 ' + (S.clientLabel || '?') + ' · 共享 ' + ((S.presence && S.presence.length) || 1) + ' 端 · 表/波仅本端 · 拖动行 = 共享轴';
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'mini';
    share.textContent = '分享';
    share.title = '生成分享链接：打开链接会应用当前波形选择/分组/显示设置一次';
    share.addEventListener('click', () => {
      shareViewLink().catch((e) => toast('生成分享链接失败: ' + brief(e.message), 'err'));
    });
    top.append(add, share, hint);
    body.appendChild(top);
    renderRemoteLayouts(body);

    let shown = 0;
    for (const g of S.wave.groups) {
      // “已选择”页包含表、波两种选中行（原 selected-block 已移除）
      const all = selectedRows().filter((row) => (row.groupId || 'default') === g.id);
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
        el.className = 'wave-row' + (!row.table && !row.plot ? ' local-hidden' : '');
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
        rm.title = '从已选择移除';
        rm.title = '从共享监视集移除（会同步到所有客户端）';
        rm.addEventListener('click', (e) => { e.stopPropagation(); confirmRemoveMonitor(row); });
        const toggles = waveRowToggles(row);
        const actions = document.createElement('span');
        actions.className = 'wave-actions';
        const viewers = otherViewersFor(row.id);
        if (viewers.length) {
          const vw = document.createElement('span');
          vw.className = 'wave-viewers';
          vw.textContent = '其他端 ' + viewers.length;
          vw.title = viewers.map((p) => p.label || ('客户端 ' + p.no)).join('、') + ' 正在查看';
          actions.append(vw);
        }
        actions.append(tag, rm);
        el.addEventListener('click', (e) => {
          if (e.target.closest('button') || e.target.closest('.sig-toggles')) return;
          setFocus(row.id, true);
        });
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.id);
          el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.append(dot, nm, val, toggles, actions);
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
      empty.textContent = q ? '没有匹配的已选择项' : '还没有已选择信号；在变量/外设行点“表/波”加入';
      body.appendChild(empty);
    }
    if (S.samples.length) refreshLiveValues();
  }

  function matchText(parts, q) {
    if (!q) return true;
    return parts.some((p) => String(p || '').toLowerCase().includes(q));
  }

  function entryId(entry) {
    return String((entry && (entry.id || entry.name)) || '');
  }

  function reginfoFor(entry) {
    if (!S.reginfo.map.size) return null;
    return S.reginfo.map.get(entryId(entry)) || null;
  }

  function dynamicInfoText(info, value) {
    if (!info || value === undefined || value === null) return '';
    const k = String(value);
    if (info.states && Object.prototype.hasOwnProperty.call(info.states, k)) {
      return info.states[k];
    }
    if (info.values) {
      if (Object.prototype.hasOwnProperty.call(info.values, k)) return info.values[k];
      const n = Number(value);
      if (Number.isFinite(n)) {
        for (const kk of ['0x' + n.toString(16), '0x' + n.toString(16).toUpperCase(),
                          n.toString(16).toUpperCase(), n.toString(16),
                          '0b' + n.toString(2), n.toString()]) {
          if (Object.prototype.hasOwnProperty.call(info.values, kk)) return info.values[kk];
        }
      }
    }
    return '';
  }

  function descFor(entry, staticOnly) {
    if (entry && entry.desc) return entry.desc; // 手册/源码中文注释（annotate_vars 生成），优先直出
    const info = reginfoFor(entry);
    if (!info) return '';
    if (!staticOnly) {
      const v = S.readVals.get(entryId(entry));
      if (v !== undefined) {
        const d = dynamicInfoText(info, v);
        if (d) return d;
      }
    }
    return info.static || '';
  }

  function rowFlagButtons(id, entry, opts = {}) {
    const wrap = document.createElement('span');
    wrap.className = 'sig-toggles' + (opts.flat ? ' flat' : '');
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
    // 右下角：读一次（不加入采样，只刷新 sig-val 与简述）
    if (opts.read !== false) {
      const rb = document.createElement('button');
      rb.className = 'tgl tgl-read';
      rb.textContent = '读';
      rb.title = '读取一次并刷新数值/简述';
      rb.dataset.rowRead = id;
      rb.setAttribute('aria-label', '读取一次');
      wrap.appendChild(rb);
    }
    return wrap;
  }

  function sigRow(entry, kind, opts = {}) {
    const item = document.createElement('div');
    item.className = 'sig-item';
    const rowEl = document.createElement('div');
    const eid = entryId(entry);
    const row = S.rows.get(eid);
    const staticOnly = !!(row && (row.table || row.plot));
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
    const fullName = String(entry.name || '');
    const leaf = (opts.reg || opts.bit) ? fullName.split('.').pop() : fullName;
    const isRegOrBit = !!(opts.reg || opts.bit);
    if (isRegOrBit) {
      // 寄存器和位域只显示内层名，前面加 . 区分层级
      name.innerHTML = '<span class="name-dot">.</span>' + esc(leaf) + (entry.bit
        ? ' <span class="bit">[' + (entry.bit[1] > 1
          ? (entry.bit[0] + ':' + (entry.bit[0] + entry.bit[1] - 1)) : entry.bit[0]) + ']</span>'
        : '');
    } else if (fullName.length > 24 && fullName.includes('.')) {
      // 长变量名按第一个 . 拆成两行：对象名 / .成员名
      const i = fullName.indexOf('.');
      name.classList.add('two-line');
      name.innerHTML = esc(fullName.slice(0, i)) + '<br><span class="name-tail">' +
        esc(fullName.slice(i)) + '</span>';
    } else {
      name.textContent = fullName;
    }
    name.title = entry.name + '\n' + hex(entry.addr) + ' · ' + (entry.size * 8) + ' bit ' + (entry.signed ? 'signed' : 'unsigned') +
      '\n点击行展开详情；表 / 波 / 写 / 读 都在右侧按钮';
    main.appendChild(name);
    const desc = document.createElement('div');
    desc.className = 'sig-desc';
    desc.dataset.descId = eid;
    desc.textContent = descFor(entry, staticOnly);
    desc.title = desc.textContent || '';
    main.appendChild(desc);
    const val = document.createElement('span');
    val.className = 'sig-val';
    val.textContent = S.readVals.has(eid)
      ? fmtValue(row || entry, S.readVals.get(eid)) : '—';
    rowEl.appendChild(main);
    rowEl.appendChild(val);
    rowEl.appendChild(rowFlagButtons(eid, entry));
    item.appendChild(rowEl);

    const info = reginfoFor(entry);
    const detail = document.createElement('div');
    detail.className = 'sig-detail';
    const meta = document.createElement('div');
    meta.className = 'sig-meta';
    meta.textContent = hex(entry.addr) + ' · ' + (entry.type || ((entry.size || 4) * 8 + 'b')) +
      ' · ' + ((entry.size || 4) * 8) + ' bit ' + (entry.signed ? 'signed' : 'unsigned');
    detail.appendChild(meta);
    const full = document.createElement('div');
    full.className = 'sig-full';
    full.textContent = (info && (info.full || info.static)) || '暂无手册描述（可在设置里导入寄存器信息 JSON）';
    detail.appendChild(full);
    const tags = document.createElement('div');
    tags.className = 'sig-tags';
    const tagPairs = [];
    if (info && info.access) tagPairs.push(['访问', info.access]);
    if (info && info.reset) tagPairs.push(['复位', info.reset]);
    if (info && info.page) tagPairs.push(['页码', 'p.' + info.page]);
    if (info && info.states) tagPairs.push(['状态', Object.keys(info.states).length + ' 种']);
    if (info && info.values) tagPairs.push(['枚举', Object.keys(info.values).length + ' 种']);
    for (const [k, v] of tagPairs) {
      const t = document.createElement('span');
      t.className = 'sig-tag';
      t.textContent = k + ' ' + v;
      tags.appendChild(t);
    }
    if (tags.childNodes.length) detail.appendChild(tags);
    item.appendChild(detail);
    if (S.ui.expanded.has(eid)) item.classList.add('open');
    S.liveRows.set(eid, val);
    return item;
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
    let headIdx = 0;
    for (const [g, list] of ordered) {
      const open = !!q || S.ui.openGroups.has(g);
      const box = document.createElement('div');
      box.className = 'cat-group' + (open ? ' open' : '');
      const head = document.createElement('div');
      head.className = 'cat-group-head' + ((headIdx++ % 2) ? ' alt' : '');
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
        stopLockWrite(mod);
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
    head.querySelector('.tcount').textContent = peripheralList().length + ' 个';
    box.appendChild(head);
    const inner = document.createElement('div');
    inner.className = 'tree-body';
    renderPeriphInto(inner, q);
    box.appendChild(inner);
    body.innerHTML = '';
    body.appendChild(box);
  }

  const PERIPH_CN = {
    SYS: '系统控制', FLASH: '闪存', SPI: '串行外设接口', I2C: 'I2C 接口',
    CMP: '比较器', HALL: '霍尔接口', ADC: '模数转换器', TIMER: '通用定时器',
    QEP: '正交编码器', MCPWM: '电机 PWM', GPIO: '通用输入输出', EXTI: '外部中断',
    CRC: 'CRC 校验', UART: '串口', DMA: '直接存储器访问', DSP: '数学运算单元',
    IWDG: '独立看门狗', AON: '电源管理', SIF: '单线接口', CL0: '可配置逻辑',
    CAN: 'CAN 总线', ATIM: '高级定时器', GTIM: '通用定时器', LPTIM: '低功耗定时器',
    SYSCTRL: '系统控制', DBG: '调试', RCC: '复位与时钟',
    GPIOA: '通用输入输出', GPIOB: '通用输入输出', GPIOC: '通用输入输出',
    GPIOD: '通用输入输出', GPIOE: '通用输入输出', GPIOF: '通用输入输出',
    AFIO: '复用功能', PWR: '电源控制',
  };

  function periphCn(name) {
    const s = String(name || '').toUpperCase();
    const base = s.replace(/[0-9]+$/, '');
    return PERIPH_CN[s] || PERIPH_CN[base] || '';
  }

  function renderPeriphInto(body, q) {
    const list = peripheralList();
    const frag = document.createDocumentFragment();
    let any = false;
    let headIdx = 0;
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
      head.className = 'periph-head' + ((headIdx++ % 2) ? ' alt' : '');
      head.dataset.periph = p.name;
      head.innerHTML = '<span class="arrow">▶</span><span class="pname"></span><span class="pcn"></span>' +
        '<button class="periph-read" type="button" data-periph-read="" title="连续读取该外设全部寄存器一次">读</button>' +
        '<span class="pbase"></span>';
      head.querySelector('.pname').textContent = p.name;
      head.querySelector('.pcn').textContent = periphCn(p.name);
      const pbase = head.querySelector('.pbase');
      pbase.textContent = hex(p.base, 8);
      const prb = head.querySelector('.periph-read');
      prb.dataset.periphRead = p.name;
      prb.title = '连续读取 ' + p.name + ' 全部寄存器一次（' + (p.regs || []).length + ' 个）';
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
      const open = S.ui.openGroups.has('__custom');
      const box = document.createElement('div');
      box.className = 'cat-group' + (open ? ' open' : '');
      box.dataset.group = '__custom';
      const head = document.createElement('div');
      head.className = 'cat-group-head';
      head.dataset.group = '__custom';
      head.innerHTML = '<span class="arrow">▶</span><span class="gname">自定义信号</span><span class="gcount"></span>';
      head.querySelector('.gcount').textContent = list.length + ' 项';
      const inner = document.createElement('div');
      inner.className = 'cat-group-body';
      for (const s of list) inner.appendChild(sigRow(s, 'var', { tree: true }));
      box.append(head, inner);
      body.appendChild(box);
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

  function brief(text, max = 160) {
    const s = String(text || '').trim();
    if (!s) return '';
    const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const head = lines.slice(0, 2).join(' · ');
    return head.length > max ? head.slice(0, max) + '…' : head;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function flashRow(id) {
    renderSelected();
  }

  // ---------------------------------------------------------------- selected / legend
  function renderSelected() {
    S.selRows.clear();
    const box = D.selectedList;
    if (!box) return;
    box.innerHTML = '';
    const rows = selectedRows();
    if (D.selCount) D.selCount.textContent = String(rows.length);
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
      chip.innerHTML = '<span class="lmod"></span><span class="dot"></span><span class="lname"></span><span class="lax"></span><span class="lval">—</span>';
      const lmod = chip.querySelector('.lmod');
      if (hasCustomCalibration(row)) {
        lmod.textContent = '※';
        lmod.title = '已修改换算/单位';
      }
      const dot = chip.querySelector('.dot');
      dot.style.background = row.color;
      dot.style.color = row.color;
      chip.querySelector('.lname').textContent = shortName(row.name);
      chip.querySelector('.lax').textContent = row.axis === 'right' ? 'R' : '';
      chip.addEventListener('pointerenter', () => setFocus(row.id, false));
      chip.addEventListener('pointerleave', () => { if (!S.focusPinned) setFocus(null, false); });
      // 右键（包括已经变暗的通道）打开换算/单位
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openCalibModal(row);
      });
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
    S.ui.view = 'list';
    for (const b of seg.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.view === 'list');
    }
  }

  function collapseAll() {
    if (S.ui.search) {
      S.ui.search = '';
      if (D.search) D.search.value = '';
    }
    S.ui.openGroups.clear();
    S.ui.openNodes.clear();
    S.ui.openPeriph.clear();
    S.ui.openRegs.clear();
    S.ui.expanded.clear();
    renderCatalog();
    toast('已全部收起', 'ok');
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
    const hint = $('#calibHint');
    if (hint) {
      const base = '值 = 原始 × 比例 + 偏移。提示：右键图例里变暗的通道也能打开这里。';
      if (row.kind === 'virtual') {
        hint.textContent = base + ' 数组平均虚拟行：比例/偏移不可直接改；波形使用源行换算后的平均值，单位/轴只影响显示。';
      } else if (!plotRows().some((r) => r.id === row.id)) {
        hint.textContent = base + ' 该行当前未开波形；换算会反映在数值表/悬浮值；如果它被数组 AVG 引用，也会进入 AVG 波形。';
      } else {
        const group = S.wave.groups.find((g) => g.id === (row.groupId || 'default'));
        const peers = plotRows().filter((r) => (r.groupId || 'default') === (row.groupId || 'default'));
        if (group && !group.auto && peers.length > 1) {
          hint.textContent = base + ' 当前共享组有 ' + peers.length + ' 路：每行按各自换算值绘制，未设置的行按原始值绘制。';
        } else if (isCalibrated(row)) {
          hint.textContent = base + ' 当前波形会使用换算值。';
        } else {
          hint.textContent = base + ' 当前只设置了单位/轴，数值仍是原始值（比例为 1、偏移为 0）；Y 轴会显示新单位。';
        }
      }
    }
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
    if (monitorKey() !== S.lastConfigKey) sendConfig();
    sendViewState();
    renderSelected();
    renderValueTable();
    renderLegend();
    if (S.samples.length) refreshLiveValues();
    S.dirty = true;
    closeCalibModal();
    toast('已更新换算：' + shortName(row.name) +
      (isCalibrated(row)
        ? ' · ' + row.scale + '× + ' + row.offset + (row.unit ? ' ' + row.unit : '')
        : (row.unit ? ' · 单位 ' + row.unit : ' · 未设置换算')), 'ok');
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

  function sampleRange(t0, t1, a = S.samples) {
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

  // ---------------------------------------------------------------- timeline
  // 时间轴（框选条）。数据源统一走 getTimelineSamples()：当前只包含客户端
  // 已拉取的 /api/history（服务端 deque 最多 40000 点，约 100 Hz × 400 s）。
  // 以后若服务端提供完整录制索引，只需替换这个函数和 loadHistory()。
  const TL_MIN_SPAN_MS = 500;

  function getTimelineSamples() {
    return S.samples;
  }

  function sampleTimelineBounds() {
    const a = getTimelineSamples();
    if (!a.length) return null;
    const first = a[0][0];
    const last = a[a.length - 1][0];
    return { first, last, span: Math.max(0, last - first) };
  }

  // 服务端缓存会话的完整时间范围；不可用/未就绪时返回 null。
  function cacheTimelineBounds() {
    const c = S.cacheInfo;
    if (!c || !c.enabled) return null;
    const first = Number(c.start);
    const last = Number(c.end);
    if (!isFinite(first) || !isFinite(last) || last <= first) return null;
    if (!(Number(c.count) > 0)) return null;
    return { first, last, span: last - first };
  }

  function timelineBounds() {
    const cache = cacheTimelineBounds();
    const live = sampleTimelineBounds();
    if (!cache) return live;
    if (!live) return cache;
    // 轨道起点用服务端缓存（完整录制周期）；终点取缓存尾部或尚未落盘的实时尾巴。
    const last = Math.max(cache.last, live.last);
    return { first: cache.first, last, span: Math.max(0, last - cache.first) };
  }

  function timelineMinSpan(bounds) {
    const full = bounds ? bounds.span : 0;
    return full > 0 ? Math.min(TL_MIN_SPAN_MS, full) : 0;
  }

  function clampRangeToBounds(range, bounds) {
    if (!bounds) return null;
    if (bounds.span <= 0) return { start: bounds.first, end: bounds.last };
    const minSpan = timelineMinSpan(bounds);
    let s = Number.isFinite(range && range.start) ? range.start : bounds.first;
    let e = Number.isFinite(range && range.end) ? range.end : bounds.last;
    if (e < s) { const t = s; s = e; e = t; }
    // 完全落在当前缓存之外（例如服务重启/换工程后时间戳整体变化）→ 回到完整历史
    if (e < bounds.first || s > bounds.last) return { start: bounds.first, end: bounds.last };
    s = clamp(s, bounds.first, bounds.last);
    e = clamp(e, bounds.first, bounds.last);
    if (e - s < minSpan) {
      const c = (s + e) / 2;
      s = clamp(c - minSpan / 2, bounds.first, bounds.last - minSpan);
      e = s + minSpan;
    }
    return { start: s, end: e };
  }

  // overview 的 range 唯一入口：越界自动 clamp，数据变化后也能自愈。
  function ensureChartRange() {
    const bounds = timelineBounds();
    if (!bounds) return null;
    S.chartRange = clampRangeToBounds(S.chartRange, bounds);
    return S.chartRange;
  }

  // 页面恢复成 overview 但用户还没动过时间轴：跟着“当前可用历史”持续铺满，
  // 避免首次渲染只看到 1~2 个样本时把窗口永久钉在 500 ms。
  function syncAutoFullRange() {
    if (S.chartFollow || !S.chartAutoFull) return;
    const bounds = timelineBounds();
    if (!bounds) return;
    S.chartRange = { start: bounds.first, end: bounds.last };
  }

  // 时间轴 / 波形区当前实际可见窗口。follow 时取 draw() 算出的 S.view；
  // overview 时取 S.chartRange。
  function currentTimelineWindow() {
    const bounds = timelineBounds();
    if (!bounds) return null;
    let start, end;
    if (S.chartFollow) {
      start = (S.view ? S.view.start : S.lastT - S.windowSec * 1000);
      end = (S.view ? S.view.end : S.lastT);
    } else {
      const r = ensureChartRange();
      if (!r) return null;
      start = r.start;
      end = r.end;
    }
    if (!isFinite(start) || !isFinite(end)) return null;
    if (end < start) { const t = start; start = end; end = t; }
    const ds = clamp(start, bounds.first, bounds.last);
    const de = clamp(end, bounds.first, bounds.last);
    return {
      first: bounds.first, last: bounds.last, span: bounds.span,
      start: ds, end: de, rawStart: start, rawEnd: end,
      len: Math.max(0, end - start), follow: S.chartFollow,
    };
  }

  function fmtClockMs(ms) {
    // 采样时间戳是“服务启动后的相对毫秒”（scope_server 的 t_ms），不是墙上时钟；
    // 这里按 hh:mm:ss（相对时间）显示，避免出现 1970 年。
    if (!isFinite(ms)) return '--';
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h > 0 ? pad2(h) + ':' : '') + pad2(m) + ':' + pad2(s);
  }

  function fmtSpanMs(ms) {
    const s = Math.max(0, Number(ms) || 0) / 1000;
    if (s < 1) return Math.round(s * 1000) + ' ms';
    if (s < 10) return s.toFixed(1) + ' s';
    if (s < 60) return Math.round(s) + ' s';
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    if (r === 60) return (m + 1) + 'm';
    return m + 'm' + (r ? ' ' + r + 's' : '');
  }

  function syncChartFullUI() {
    document.body.classList.toggle('hero-hidden', !!S.chartFull);
    if (!D.btnChartFull) return;
    D.btnChartFull.classList.toggle('active', !!S.chartFull);
    D.btnChartFull.setAttribute('aria-pressed', S.chartFull ? 'true' : 'false');
    D.btnChartFull.title = S.chartFull
      ? '退出全屏（恢复顶部卡片）'
      : '全屏波形（仅隐藏顶部卡片）';
    const label = D.btnChartFull.querySelector('.cf-label');
    if (label) label.textContent = S.chartFull ? '退出' : '全屏';
  }

  function setChartFull(on) {
    S.chartFull = !!on;
    syncChartFullUI();
    saveLocal();
    requestAnimationFrame(() => { try { resizeChart(); } catch {} });
  }

  function syncChartModeUI() {
    if (!D.timelineBar || !D.tlMode) return;
    const overview = !S.chartFollow;
    D.timelineBar.dataset.mode = overview ? 'overview' : 'follow';
    D.tlMode.classList.toggle('overview', overview);
    if (D.tlModeText) D.tlModeText.textContent = overview ? '整体' : '跟随';
    D.tlMode.setAttribute('aria-pressed', overview ? 'true' : 'false');
    D.tlMode.title = overview
      ? '整体历史（点击回到跟随实时）'
      : '跟随实时（点击查看整体历史）';
  }

  function scheduleTimelineSave() {
    if (S.tlSaveTimer) clearTimeout(S.tlSaveTimer);
    S.tlSaveTimer = setTimeout(() => { S.tlSaveTimer = 0; saveLocal(); }, 500);
  }

  function setChartFollow(on) {
    const follow = !!on;
    if (follow === S.chartFollow && (follow || S.chartRange)) {
      syncChartModeUI();
      return;
    }
    S.chartFollow = follow;
    setChartRightLock(false);
    if (follow) {
      S.chartRange = null;
      S.chartAutoFull = false;
    } else {
      const bounds = timelineBounds();
      // 按钮进入整体：初始选中完整可用历史；还没有数据时等首批样本到达再铺满
      S.chartRange = bounds ? { start: bounds.first, end: bounds.last } : null;
      S.chartAutoFull = !bounds;
      ensureChartRange();
    }
    S.tlDrag = null;
    syncChartModeUI();
    scheduleTimelineSave();
    if (!follow) scheduleCacheWindow(60);
    S.dirty = true;
  }

  function updateTimelineUI(force) {
    if (!D.tlRail || !D.tlWindow || !D.timelineBar) return;
    const cur = currentTimelineWindow();
    const has = !!cur && cur.span > 0 && cur.len > 0;
    D.timelineBar.classList.toggle('no-data', !has);
    if (!has) {
      D.tlWindow.classList.add('hidden');
      if (force || S.tlUiKey !== 'none') {
        S.tlUiKey = 'none';
        if (D.tlFirst) D.tlFirst.textContent = '--';
        if (D.tlLast) D.tlLast.textContent = '--';
        if (D.tlWin) D.tlWin.textContent = '暂无历史';
        D.tlRail.setAttribute('aria-valuetext', '暂无历史');
      }
      return;
    }
    D.tlWindow.classList.remove('hidden');
    const l = clamp((cur.start - cur.first) / cur.span, 0, 1);
    const r = clamp((cur.end - cur.first) / cur.span, 0, 1);
    D.tlWindow.style.left = (l * 100).toFixed(4) + '%';
    D.tlWindow.style.width = (Math.max(0, r - l) * 100).toFixed(4) + '%';
    const key = [cur.first, cur.last, cur.start, cur.end,
      S.chartFollow ? 1 : 0, S.chartRightLock ? 1 : 0].join('|');
    if (!force && key === S.tlUiKey) return;
    S.tlUiKey = key;
    if (D.tlFirst) D.tlFirst.textContent = '起 ' + fmtClockMs(cur.first);
    if (D.tlLast) D.tlLast.textContent = '止 ' + fmtClockMs(cur.last);
    if (D.tlWin) {
      D.tlWin.textContent = (S.chartFollow ? '跟随 ' : '窗口 ') +
        fmtClockMs(cur.start) + ' → ' + fmtClockMs(cur.end) +
        ' · ' + fmtSpanMs(cur.end - cur.start) +
        (S.chartRightLock ? ' · 右端锁定' : '');
    }
    const title = '完整历史 ' + fmtClockMs(cur.first) + ' → ' + fmtClockMs(cur.last) +
      '（' + fmtSpanMs(cur.span) + '，相对服务启动）· 拖手柄调整窗口（follow 仅左手柄）；' +
      '空白处点击居中；普通滚轮：整体=平移 / 跟随=缩放' +
      (S.chartRightLock ? '；右端已锁定实时（拖右手柄/滚轮解锁）' : '');
    D.tlRail.title = title;
    D.tlRail.setAttribute('aria-valuetext', title +
      '；当前窗口 ' + fmtClockMs(cur.start) + ' → ' + fmtClockMs(cur.end) +
      '，' + fmtSpanMs(cur.end - cur.start));
  }

  // ---- 服务端分块压缩缓存（旁路） ----
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(v >= 10 * 1024 * 1024 * 1024 ? 0 : 1) + ' GB';
    if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(v >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return Math.round(v) + ' B';
  }

  function updateCacheUI() {
    if (!D.tlCache) return;
    const c = S.cacheInfo;
    if (!c || !c.enabled) {
      D.tlCache.classList.add('hidden');
      return;
    }
    D.tlCache.classList.remove('hidden');
    const saved = !!c.saved;
    const clearable = !!c.clearable;
    const session = !!c.session;
    D.tlCache.classList.toggle('saved', saved);
    D.tlCache.classList.toggle('clearable', !saved && clearable);
    D.tlCache.classList.toggle('warn', !!c.error);
    if (D.tlCacheSize) D.tlCacheSize.textContent = '缓存 ' + fmtBytes(c.total_bytes);
    if (D.tlCacheLimit) D.tlCacheLimit.textContent = ' / ' + fmtBytes(c.limit_bytes);
    if (D.tlCacheState) {
      let state = '无会话';
      if (c.error) state = '容量告警';
      else if (saved) state = '已保存';
      else if (session && (c.active || clearable)) state = c.active ? '未保存' : '可清理';
      else if (session) state = '未保存';
      D.tlCacheState.textContent = ' · ' + state;
    }
    if (D.tlCacheSave) D.tlCacheSave.classList.toggle('hidden', !session || saved);
    const bits = [];
    if (c.session) bits.push(c.session);
    if (session) bits.push((c.blocks || 0) + ' 块 · ' + fmtInt(c.count || 0) + ' 点');
    if (session) bits.push('会话 ' + fmtBytes(c.session_bytes || 0));
    if (c.error) bits.push(c.error);
    D.tlCache.title = '服务端分块压缩缓存（本地，不上传）' +
      (bits.length ? '\n' + bits.join(' · ') : '') +
      (clearable && !saved ? '\n会话未保存：退出后可被清理' : '') +
      '\n总上限 ' + fmtBytes(c.limit_bytes) + '，满了先清未保存会话，再覆盖最旧已保存会话';
  }

  async function refreshCacheInfo(force) {
    if (S.cacheInfoBusy) return;
    S.cacheInfoBusy = true;
    let next = null;
    try {
      const r = await fetchJSON('/api/record-cache', { timeout: 6000 });
      if (r && r.ok !== false) next = r;
      else next = { ok: false, enabled: false, error: (r && r.error) || '缓存不可用' };
    } catch (e) {
      next = { ok: false, enabled: false, error: brief(e.message || String(e)) };
    } finally {
      S.cacheInfoBusy = false;
    }
    if (!next) return;
    const prev = S.cacheInfo;
    const prevUsable = !!prev && prev.enabled && Number(prev.count) > 0;
    const prevSession = prev && prev.session;
    S.cacheInfo = next;
    const usable = !!next.enabled && Number(next.count) > 0;
    if (!next.enabled) {
      S.cacheSamples = null;
      S.cacheRange = null;
    } else if (prevSession && next.session && prevSession !== next.session) {
      // 通道变更/重连会换会话；旧窗口数据不能再用
      S.cacheSamples = null;
      S.cacheRange = null;
    }
    const oldRange = S.chartRange ? (S.chartRange.start + '|' + S.chartRange.end) : '';
    if (!S.chartFollow) {
      if (S.chartAutoFull) syncAutoFullRange();
      else ensureChartRange();
      const newRange = S.chartRange ? (S.chartRange.start + '|' + S.chartRange.end) : '';
      if (usable && (force || !prevUsable || newRange !== oldRange ||
          (prevSession && next.session && prevSession !== next.session))) {
        scheduleCacheWindow(80);
      }
    }
    updateCacheUI();
    S.dirty = true;
  }

  function startCachePolling() {
    if (S.cacheInfoTimer) clearInterval(S.cacheInfoTimer);
    refreshCacheInfo(true);
    S.cacheInfoTimer = setInterval(() => refreshCacheInfo(false), 4000);
  }

  async function saveCacheSession() {
    if (S.cacheSaveBusy || !D.tlCacheSave) return;
    S.cacheSaveBusy = true;
    D.tlCacheSave.disabled = true;
    try {
      const r = await post('/api/record-cache/save', {});
      if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
      S.cacheInfo = r;
      updateCacheUI();
      toast('缓存已标记保存（本地，不上传）', 'ok');
    } catch (e) {
      toast('保存缓存失败: ' + brief(e.message), 'err');
    } finally {
      S.cacheSaveBusy = false;
      if (D.tlCacheSave) D.tlCacheSave.disabled = false;
    }
  }

  // overview 当前视图使用的数据序列：缓存窗口覆盖视图时优先用缓存，否则回退实时样本。
  function viewSeries(start, end) {
    if (!S.chartFollow && Array.isArray(S.cacheSamples) && S.cacheSamples.length) {
      const cs = S.cacheSamples[0][0];
      const ce = S.cacheSamples[S.cacheSamples.length - 1][0];
      if (cs <= end && ce >= start) {
        // 缓存块比实时样本晚落盘（默认最多一个块）：把缓存末尾之后的实时尾巴接上，
        // 这样 overview 右侧不会缺最新一段。数值仍是真实样本，不做插值。
        if (end > ce + 0.5) {
          const out = S.cacheSamples.slice();
          // S.samples 有序：二分找到缓存末尾之后的第一条，避免每帧遍历全部样本
          let lo = 0, hi = S.samples.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (S.samples[mid][0] <= ce) lo = mid + 1; else hi = mid;
          }
          for (let i = lo; i < S.samples.length; i++) {
            const row = S.samples[i];
            if (row[0] > end + 0.5) break;
            out.push(row);
          }
          return out;
        }
        return S.cacheSamples;
      }
    }
    return S.samples;
  }

  function scheduleCacheWindow(delay = 120) {
    if (S.chartFollow || !cacheTimelineBounds()) return;
    // 节流而不是防抖：持续拖拽时也每 ~140 ms 取一次当前窗口，
    // 同时避免每个 pointermove 都发请求。
    if (S.cacheWindowTimer) return;
    S.cacheWindowTimer = setTimeout(() => {
      S.cacheWindowTimer = 0;
      loadCacheWindow();
    }, Math.max(20, delay));
  }

  async function loadCacheWindow() {
    if (S.chartFollow || !cacheTimelineBounds()) return;
    const r = ensureChartRange();
    if (!r) return;
    const token = ++S.cacheToken;
    const maxPoints = Math.round(clamp((S.view ? S.view.pw : 900) * 8, 2000, 60000));
    const q = 'start=' + encodeURIComponent(r.start) + '&end=' + encodeURIComponent(r.end) +
      '&max_points=' + maxPoints;
    try {
      const res = await fetchJSON('/api/record-cache/window?' + q, { timeout: 20000 });
      if (token !== S.cacheToken || S.chartFollow) return;
      if (!res || !res.ok || res.empty || !Array.isArray(res.samples) || !res.samples.length) {
        S.cacheSamples = [];
        S.cacheRange = { start: r.start, end: r.end };
        S.cacheError = (res && res.error) || '';
        S.dirty = true;
        return;
      }
      const order = (res.signals || []).map((x) => String(x.id));
      const pos = new Map(order.map((id, i) => [id, i]));
      const ids = S.signals.map((x) => x.id);
      const samples = [];
      for (const row of res.samples) {
        const t = Number(row && row[0]);
        if (!isFinite(t)) continue;
        const vals = (row && row[1]) || [];
        const mapped = ids.map((id) => {
          if (!order.length) return null;
          const i = pos.get(id);
          return i === undefined ? null : vals[i];
        });
        samples.push([t, order.length ? mapped : vals]);
      }
      S.cacheSamples = samples;
      S.cacheRange = { start: r.start, end: r.end };
      S.cacheError = '';
      S.dirty = true;
    } catch (e) {
      if (token !== S.cacheToken) return;
      S.cacheSamples = [];
      S.cacheRange = null;
      S.cacheError = brief(e.message || String(e));
      S.dirty = true;
    }
  }

  // ---- 时间轴交互 ----
  function tlEventTime(e) {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0 || !D.tlRail) return null;
    const rect = D.tlRail.getBoundingClientRect();
    if (!rect.width) return null;
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    return bounds.first + (x / rect.width) * bounds.span;
  }

  function applyTimelineResize(drag, t, bounds) {
    S.chartAutoFull = false;
    const minSpan = timelineMinSpan(bounds);
    let s = drag.origStart;
    let e = drag.origEnd;
    if (drag.mode === 'l') s = clamp(t, bounds.first, e - minSpan);
    else e = clamp(t, s + minSpan, bounds.last);
    if (e <= s) return;
    const tol = Math.max(2, bounds.span * 0.0005);
    if (Math.abs(t - drag.startT) > 0.5) drag.moved = true;
    if (drag.mode === 'r') drag.rightAtEnd = e >= bounds.last - tol;
    S.chartRange = { start: s, end: e };
  }

  function onTlPointerDown(e) {
    if (e.button !== 0 || !D.tlRail) return;
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    const t = tlEventTime(e);
    if (t === null) return;
    const handle = e.target.closest ? e.target.closest('.tl-handle') : null;
    const inWindow = e.target.closest ? e.target.closest('.tl-window') : null;

    if (S.chartFollow) {
      // follow：只允许拖左手柄增大/缩小窗口，右端始终贴实时。
      // 右手柄/窗口中间/轨道空白都不响应，也不切 overview。
      if (!handle || handle.dataset.h !== 'l') return;
      e.preventDefault();
      S.tlDrag = { mode: 'follow-l', startT: t, pointerId: e.pointerId };
      try { D.tlRail.setPointerCapture(e.pointerId); } catch {}
      S.dirty = true;
      return;
    }

    // overview：窗口中间不再可拖动；只有左右手柄可拖。
    if (inWindow && !handle) return;
    e.preventDefault();
    const cur = ensureChartRange();
    if (!cur) return;
    if (handle) {
      S.chartAutoFull = false;
      S.tlDrag = {
        mode: handle.dataset.h === 'r' ? 'r' : 'l',
        startT: t, origStart: cur.start, origEnd: cur.end,
        pointerId: e.pointerId, moved: false, rightAtEnd: false,
      };
      try { D.tlRail.setPointerCapture(e.pointerId); } catch {}
      S.dirty = true;
      return;
    }
    // 轨道空白：单击把窗口居中（离散跳转，不进入拖动）；保持 overview。
    setChartRightLock(false);
    const len = Math.max(timelineMinSpan(bounds), cur.end - cur.start);
    let cs = clamp(t - len / 2, bounds.first, Math.max(bounds.first, bounds.last - len));
    S.chartAutoFull = false;
    S.chartRange = { start: cs, end: cs + len };
    syncWindowSecFromRange();
    scheduleCacheWindow(80);
    scheduleTimelineSave();
    S.dirty = true;
  }

  function onTlPointerMove(e) {
    const drag = S.tlDrag;
    if (!drag) return;
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    const t = tlEventTime(e);
    if (t === null) return;
    if (drag.mode === 'follow-l') {
      applyFollowLeftDrag(t, bounds);
      S.dirty = true;
      return;
    }
    applyTimelineResize(drag, t, bounds);
    scheduleCacheWindow(140);
    S.dirty = true;
  }

  function endTlDrag() {
    const drag = S.tlDrag;
    if (!drag) return;
    S.tlDrag = null;
    if (D.tlRail) {
      try { D.tlRail.releasePointerCapture(drag.pointerId); } catch {}
    }
    if (drag.mode === 'follow-l') {
      scheduleTimelineSave();
      S.dirty = true;
      return;
    }
    if (!S.chartFollow) {
      if (drag.mode === 'r') {
        if (drag.rightAtEnd) setChartRightLock(true);
        else if (drag.moved) setChartRightLock(false);
      }
      if (S.chartRightLock) syncChartRightLock();
      else ensureChartRange();
      syncWindowSecFromRange();
    }
    scheduleTimelineSave();
    S.dirty = true;
  }

  function wheelZoomFactor(e) {
    const d = clamp(Number(e.deltaY) || 0, -120, 120);
    return Math.exp(d * 0.0022);
  }

  function zoomTimelineAt(anchorT, factor) {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return false;
    // 只有 overview 可围绕鼠标时间点缩放；不再自动切换模式。
    if (S.chartFollow) return false;
    S.chartAutoFull = false;
    const cur = ensureChartRange();
    if (!cur) return false;
    const minSpan = timelineMinSpan(bounds);
    const curLen = Math.max(1, cur.end - cur.start);
    const newLen = clamp(curLen * factor, minSpan, bounds.span);
    if (Math.abs(newLen - curLen) < 0.5) return false;
    const anchor = clamp(isFinite(anchorT) ? anchorT : (cur.start + cur.end) / 2,
      bounds.first, bounds.last);
    const ratio = clamp((anchor - cur.start) / curLen, 0, 1);
    let s = anchor - ratio * newLen;
    let e = s + newLen;
    if (s < bounds.first) { s = bounds.first; e = s + newLen; }
    if (e > bounds.last) { e = bounds.last; s = e - newLen; }
    S.chartRange = { start: s, end: e };
    S.dirty = true;
    scheduleTimelineSave();
    scheduleCacheWindow(120);
    return true;
  }

  function applyWindowSecToOverview() {
    if (S.chartFollow) return;
    S.chartAutoFull = false;
    const bounds = timelineBounds();
    const cur = ensureChartRange();
    if (!bounds || !cur) return;
    const minSpan = timelineMinSpan(bounds);
    const len = clamp(S.windowSec * 1000, minSpan, Math.max(minSpan, bounds.span));
    if (S.chartRightLock) {
      // 锁定右端时改窗口长度：右端不动，往左扩/缩
      const end = bounds.last;
      S.chartRange = { start: Math.max(bounds.first, end - len), end };
      scheduleCacheWindow(80);
      return;
    }
    const c = (cur.start + cur.end) / 2;
    const s = clamp(c - len / 2, bounds.first, Math.max(bounds.first, bounds.last - len));
    S.chartRange = { start: s, end: s + len };
    scheduleCacheWindow(80);
  }

  // follow 模式拖左手柄：左端跟指针，右端保持实时；窗口只增/减长度，不切 overview。
  function applyFollowLeftDrag(t, bounds) {
    const end = (S.view && isFinite(S.view.end))
      ? S.view.end
      : (S.paused ? (S.pauseAt || S.lastT) : S.lastT);
    const avail = Math.max(0.5, (end - bounds.first) / 1000);
    const span = clamp((end - t) / 1000, 0.5, avail);
    setWindowSec(span, { max: avail, save: false });
  }

  function wheelDeltaAmount(e) {
    const scale = e.deltaMode === 1 ? 40 : (e.deltaMode === 2 ? 800 : 1);
    const x = (Number(e.deltaX) || 0) * scale;
    const y = (Number(e.deltaY) || 0) * scale;
    return Math.abs(x) > Math.abs(y) ? x : y;
  }

  // overview 里用手柄改完窗口后，让窗口下拉框反映真实跨度（而不是停留在旧值）
  function syncWindowSecFromRange() {
    if (!S.chartRange) return;
    const span = Math.max(0.5, (S.chartRange.end - S.chartRange.start) / 1000);
    setWindowSec(span, { save: false, max: Math.max(0.5, span) });
  }

  // overview 右端锁定：右边缘钉在实时右端，窗口按原跨度随实时滑动，但不切 follow。
  function setChartRightLock(on) {
    const next = !!on && !S.chartFollow;
    const changed = next !== S.chartRightLock;
    S.chartRightLock = next;
    if (!next) S.cacheLockAt = 0;
    D.timelineBar?.classList.toggle('right-lock', next);
    if (next) {
      S.chartAutoFull = false;
      syncChartRightLock();
    }
    if (changed) S.dirty = true;
  }

  function syncChartRightLock() {
    if (!S.chartRightLock || S.chartFollow || S.tlDrag) return;
    const bounds = timelineBounds();
    const cur = ensureChartRange();
    if (!bounds || !cur) return;
    const span = Math.max(timelineMinSpan(bounds),
      Math.min(cur.end - cur.start, bounds.span));
    const end = bounds.last;
    const start = Math.max(bounds.first, end - span);
    S.chartRange = { start, end };
    S.chartAutoFull = false;
    // 缓存窗口节流刷新；波形右侧本来就会用 live 尾巴补齐
    const now = Date.now();
    if (!S.cacheLockAt || now - S.cacheLockAt > 2500) {
      S.cacheLockAt = now;
      scheduleCacheWindow(300);
    }
  }

  // follow：缩放时间窗口（右端仍贴实时），不切换模式。
  function zoomFollowWindowByFactor(factor) {
    if (!S.chartFollow) return false;
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return false;
    const end = S.view ? S.view.end : S.lastT;
    const max = Math.max(0.5, (end - bounds.first) / 1000);
    setWindowSec(S.windowSec * factor, { max, save: false });
    scheduleTimelineSave();
    return true;
  }

  function zoomFollowWithWheel(e) {
    if (!S.chartFollow) return false;
    const d = clamp(wheelDeltaAmount(e), -240, 240);
    if (!d) return false;
    return zoomFollowWindowByFactor(Math.exp(d * 0.0016));
  }

  // overview：普通滚轮左右滑动窗口（不改变跨度）。
  function panOverviewWithWheel(e) {
    if (S.chartFollow) return false;
    const bounds = timelineBounds();
    const cur = ensureChartRange();
    if (!bounds || !cur) return false;
    const d = clamp(wheelDeltaAmount(e), -360, 360);
    if (!d) return false;
    const len = Math.max(1, cur.end - cur.start);
    // 细粒度横移：约 3% 窗口/格，单格 300 ms ~ 3 s；比原来的 15% 小约 5 倍
    const unit = clamp(len * 0.03, 300, 3000);
    const step = (d / 100) * unit;
    if (S.chartRightLock && step < 0) setChartRightLock(false);
    const s = clamp(cur.start + step, bounds.first, Math.max(bounds.first, bounds.last - len));
    S.chartRange = { start: s, end: s + len };
    S.chartAutoFull = false;
    const tol = Math.max(2, bounds.span * 0.0005);
    // 滚轮横移接近/撞到右端：磁吸到右端并锁定（不切 follow）；左移则解锁
    if (step > 0 && len < bounds.span - tol) {
      const gap = bounds.last - (s + len);
      const snap = Math.max(1000, len * 0.02);
      if (gap <= snap) setChartRightLock(true);
    }
    scheduleCacheWindow(80);
    scheduleTimelineSave();
    S.dirty = true;
    return true;
  }

  function onTlKeyDown(e) {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    const keys = ['ArrowLeft', 'ArrowRight', '+', '=', '-', '_', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    if (S.chartFollow) {
      // follow 下只有 +/- 有意义：缩放窗口；方向键不再自动切 overview。
      if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomFollowWindowByFactor(e.key === '+' || e.key === '=' ? 0.8 : 1.25);
      }
      return;
    }
    if (S.chartRightLock) setChartRightLock(false);
    const cur = ensureChartRange();
    if (!cur) return;
    const len = cur.end - cur.start;
    const step = Math.max(100, len * 0.1);
    let handled = true;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const delta = e.key === 'ArrowLeft' ? -step : step;
      let s = clamp(cur.start + delta, bounds.first, Math.max(bounds.first, bounds.last - len));
      S.chartRange = { start: s, end: Math.min(bounds.last, s + len) };
    } else if (e.key === 'Home' || e.key === 'End') {
      const s = e.key === 'Home' ? bounds.first : Math.max(bounds.first, bounds.last - len);
      S.chartRange = { start: s, end: Math.min(bounds.last, s + len) };
    } else if (e.key === '+' || e.key === '=') {
      handled = zoomTimelineAt((cur.start + cur.end) / 2, 0.8);
    } else if (e.key === '-' || e.key === '_') {
      handled = zoomTimelineAt((cur.start + cur.end) / 2, 1.25);
    }
    if (handled) {
      e.preventDefault();
      scheduleCacheWindow(120);
      S.dirty = true;
    }
  }

  // 时间轴影响到的“重置”入口：清空缓冲、切机型/工程、服务重启、通道变化。
  function resetChartTimeline() {
    S.chartFollow = true;
    S.chartRange = null;
    S.chartAutoFull = false;
    S.chartRightLock = false;
    S.cacheLockAt = 0;
    D.timelineBar?.classList.remove('right-lock');
    S.tlDrag = null;
    S.tlUiKey = '';
    S.cacheSamples = null;
    S.cacheRange = null;
    if (S.cacheWindowTimer) { clearTimeout(S.cacheWindowTimer); S.cacheWindowTimer = 0; }
    syncChartModeUI();
    S.dirty = true;
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
    return rows.find((r) => r.kind !== 'virtual') || rows[0] || null;
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
    if (!W || !H) { updateTimelineUI(); return; }
    ctx.clearRect(0, 0, W, H);

    const rows = visiblePlotRows();
    const panes = wavePanes();
    const anyRight = rows.some((r) => r.axis === 'right');
    const pad = { l: 62, r: anyRight ? 54 : 14, t: 14, b: 34 };
    const x0 = pad.l, y0 = pad.t;
    const pw = Math.max(10, W - pad.l - pad.r);
    const ph = Math.max(10, H - pad.t - pad.b);
    if (!S.chartFollow && S.chartRightLock) syncChartRightLock();
    let end = S.paused ? (S.pauseAt || S.lastT) : S.lastT;
    let start = end - S.windowSec * 1000;
    if (!S.chartFollow) {
      // overview：使用用户框选的历史窗口（自动 clamp 到当前可用历史）
      const r = ensureChartRange();
      if (r) { start = r.start; end = r.end; }
    }
    const series = viewSeries(start, end);
    const range = sampleRange(start, end, series);
    const i0 = range[0], i1 = range[1];
    const usingCache = !S.chartFollow && series !== S.samples;
    S.view = { x0, y0, pw, ph, start, end, panes, series, usingCache };
    updatePinTipPosition(S.view);
    updateTimelineUI();

    if (!panes.length) {
      if (D.pinTip) D.pinTip.classList.add('hidden');
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
          const tv = plotValue(row, series[i][1], pane);
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
      const paneUnits = new Set(pane.rows.map((r) => String(r.unit || '').trim()).filter(Boolean));
      pane.unit = paneUnits.size === 1 ? [...paneUnits][0] : '';
      pane.range = axisRange(pane.rows, pane) || { min: 0, max: 1 };
      pane.Y = (v) => pane.top + pane.h - ((v - pane.range.min) / Math.max(1e-9, pane.range.max - pane.range.min)) * pane.h;
      pane.primary = pane.rows[0] || null;
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

    // bottom time labels（follow 显示相对秒；overview 显示绝对时钟，便于对照历史）
    ctx.font = '9.5px ' + mono;
    ctx.fillStyle = 'rgba(127,147,173,.75)';
    const clockAxis = !S.chartFollow;
    for (let i = 0; i <= xt; i++) {
      const x = Math.round(x0 + pw * i / xt) + 0.5;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const t = start + (end - start) * i / xt;
      const rel = (t - end) / 1000;
      ctx.fillText(clockAxis ? fmtClockMs(t) : ((rel >= -0.05 ? '0' : rel.toFixed(0)) + 's'),
        x, y0 + ph + 8);
    }

    const focus = S.focusId;
    const alphaFor = (row) => {
      if (focus) return row.id === focus ? 1 : 0.12;
      return row.id === (panes.find((p) => p.primary && p.primary.id === row.id)?.primary?.id) ? 1 : 0.66;
    };
    const widthFor = (row) => (
      panes.some((p) => p.primary && p.primary.id === row.id) ? 2.1 : 1.15
    );

    // overview 下可能一次显示 4 万点：按像素列做 min/max 包络抽稀，
    // 保留尖峰形态；hover/PIN 仍走 nearestSample() 取真实最近样本。
    const visibleSamples = Math.max(0, i1 - i0);
    const decimate = visibleSamples > Math.max(1, pw) * 2.5;
    const XOf = (t) => x0 + ((t - start) / Math.max(1, end - start)) * pw;
    function tracePoints(row, pane) {
      const pts = [];
      if (!decimate || visibleSamples <= 2) {
        for (let i = i0; i < i1; i++) {
          const v = plotValue(row, series[i][1], pane);
          if (v === null || !isFinite(v)) continue;
          pts.push([XOf(series[i][0]), pane.Y(v)]);
        }
        return pts;
      }
      const buckets = Math.max(1, Math.round(pw));
      const per = visibleSamples / buckets;
      const add = (i) => {
        const v = plotValue(row, series[i][1], pane);
        if (v === null || !isFinite(v)) return;
        const x = XOf(series[i][0]);
        const y = pane.Y(v);
        const p = pts[pts.length - 1];
        if (p && Math.abs(p[0] - x) < 0.01 && Math.abs(p[1] - y) < 0.01) return;
        pts.push([x, y]);
      };
      for (let b = 0; b < buckets; b++) {
        const a = i0 + Math.floor(b * per);
        const z = Math.min(i1, i0 + Math.floor((b + 1) * per));
        let minI = -1, maxI = -1, minV = Infinity, maxV = -Infinity;
        for (let i = a; i < z; i++) {
          const v = plotValue(row, series[i][1], pane);
          if (v === null || !isFinite(v)) continue;
          if (v < minV) { minV = v; minI = i; }
          if (v > maxV) { maxV = v; maxI = i; }
        }
        if (minI < 0) continue;
        if (minI === maxI) add(minI);
        else if (minI < maxI) { add(minI); add(maxI); }
        else { add(maxI); add(minI); }
      }
      return pts;
    }

    // fills (primary per pane)
    if (S.fillOn) {
      for (const pane of panes) {
        const row = pane.primary;
        if (!row || i1 - i0 <= 1) continue;
        const pts = tracePoints(row, pane);
        if (pts.length <= 1) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
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
        const isPrimary = pane.primary && row.id === pane.primary.id;
        const alpha = alphaFor(row);
        const pts = tracePoints(row, pane);
        if (!pts.length) continue;
        ctx.beginPath();
        let started = false, prevY = 0;
        for (const p of pts) {
          const x = p[0], y = p[1];
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
        ctx.setLineDash([]);
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

    // pinned cursor (left click)
    if (S.pinT !== null && S.pinT >= start && S.pinT <= end) {
      const x = x0 + ((S.pinT - start) / Math.max(1, end - start)) * pw;
      ctx.strokeStyle = 'rgba(245,158,11,.72)';
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph); ctx.stroke();
      ctx.setLineDash([]);
      const nearest = nearestSample(S.pinT);
      if (nearest) {
        for (const pane of panes) {
          for (const row of pane.rows) {
            const v = plotValue(row, nearest[1], pane);
            if (v === null) continue;
            const y = pane.Y(v);
            ctx.beginPath();
            ctx.arc(x, y, 3.4, 0, Math.PI * 2);
            ctx.fillStyle = row.color;
            ctx.fill();
            ctx.strokeStyle = 'rgba(5,10,18,.9)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(245,158,11,.95)';
      ctx.font = 'bold 8px ' + mono;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('PIN', x, y0 + 8);
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
    const a = (S.view && Array.isArray(S.view.series) && S.view.series.length)
      ? S.view.series : S.samples;
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
  function buildTipHTML(t, near, view) {
    const rows = [];
    for (const row of visiblePlotRows()) {
      const pane = (view.panes || []).find((p) => p.rows.includes(row));
      const v = plotValue(row, near[1], pane);
      if (v === null) continue;
      const unit = String(row.unit || '');
      const main = (row.kind === 'virtual' ? fmtTableNum(v) : fmtPhysical(row, v)) + (unit ? ' ' + unit : '');
      rows.push('<div class="ct-row"><span class="dot" style="background:' + row.color + ';color:' + row.color + '"></span>' +
        '<span>' + esc(shortName(row.name)) + '</span><span class="v">' + main + '</span></div>');
    }
    const rel = ((t - view.end) / 1000).toFixed(2);
    return '<div class="ct-time">' + rel + ' s · t=' + (near[0] / 1000).toFixed(2) + ' s</div>' + rows.join('');
  }

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
    D.tip.innerHTML = buildTipHTML(t, near, view);
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

  function setPin(t, x, y) {
    const near = nearestSample(t);
    if (!near || !D.pinTip) return;
    S.pinT = near[0];
    S.pinX = x;
    S.pinY = y;
    D.pinTip.innerHTML = buildTipHTML(t, near, S.view);
    const timeEl = D.pinTip.querySelector('.ct-time');
    if (timeEl) timeEl.textContent = 'PIN · t=' + (near[0] / 1000).toFixed(2) + ' s · 右键/Esc 取消';
    D.pinTip.classList.remove('hidden');
    S.pinTipW = D.pinTip.offsetWidth || 160;
    S.pinTipH = D.pinTip.offsetHeight || 60;
    updatePinTipPosition(S.view);
    S.dirty = true;
  }

  function clearPin() {
    if (S.pinT === null) return;
    S.pinT = null;
    S.pinX = null;
    S.pinY = null;
    if (D.pinTip) D.pinTip.classList.add('hidden');
    S.dirty = true;
  }

  function updatePinTipPosition(view) {
    if (!D.pinTip) return;
    if (S.pinT === null || !view) { D.pinTip.classList.add('hidden'); return; }
    if (S.pinT < view.start || S.pinT > view.end) { D.pinTip.classList.add('hidden'); return; }
    const x = view.x0 + ((S.pinT - view.start) / Math.max(1, view.end - view.start)) * view.pw;
    const tw = S.pinTipW || D.pinTip.offsetWidth || 160;
    const th = S.pinTipH || D.pinTip.offsetHeight || 60;
    let left = x + 14;
    if (left + tw > S.size.w - 6) left = x - tw - 14;
    left = clamp(left, 6, S.size.w - tw - 6);
    const top = clamp((S.pinY || view.y0 + 14) - th / 2, 6, S.size.h - th - 6);
    D.pinTip.style.left = left + 'px';
    D.pinTip.style.top = top + 'px';
    D.pinTip.classList.remove('hidden');
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
    initPanels();
    window.addEventListener('resize', () => { resizeChart(); fitTopbar(); });
    if (window.ResizeObserver) new ResizeObserver(resizeChart).observe(D.wrap);
    setupTopbarFit();

    D.chart.addEventListener('pointermove', onPointerMove);
    D.chart.addEventListener('pointerleave', onPointerLeave);
    D.chart.addEventListener('wheel', (e) => {
      // Ctrl+滚轮：围绕鼠标时间点缩放（follow 下会切 overview）。
      // 普通滚轮：overview=左右平移窗口；follow=缩放时间窗口（右端仍贴实时）。
      if (!e.ctrlKey) {
        const b = timelineBounds();
        if (!b || b.span <= 0) return;
        e.preventDefault();
        if (S.chartFollow) zoomFollowWithWheel(e);
        else panOverviewWithWheel(e);
        return;
      }
      if (S.chartFollow) {
        if (!timelineBounds()) return;
        e.preventDefault();
        zoomFollowWindowByFactor(wheelZoomFactor(e));
        return;
      }
      if (S.chartRightLock) setChartRightLock(false);
      const view = S.view;
      if (!view || !view.pw) return;
      e.preventDefault();
      const rect = D.chart.getBoundingClientRect();
      const x = clamp(e.clientX - rect.left, view.x0, view.x0 + view.pw);
      const anchor = view.start + ((x - view.x0) / view.pw) * (view.end - view.start);
      zoomTimelineAt(anchor, wheelZoomFactor(e));
    }, { passive: false });
    D.chart.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      const view = S.view;
      if (!view) return;
      const rect = D.chart.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < view.x0 || x > view.x0 + view.pw || y < view.y0 || y > view.y0 + view.ph) return;
      const t = view.start + ((x - view.x0) / view.pw) * (view.end - view.start);
      setPin(t, x, y);
    });
    D.chart.addEventListener('contextmenu', (e) => {
      if (S.pinT === null) return;
      e.preventDefault();
      clearPin();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.pinT !== null) clearPin();
    });

    // 时间轴（框选条）
    D.tlMode?.addEventListener('click', () => setChartFollow(!S.chartFollow));
    if (D.tlRail) {
      D.tlRail.addEventListener('pointerdown', onTlPointerDown);
      D.tlRail.addEventListener('pointermove', onTlPointerMove);
      D.tlRail.addEventListener('pointerup', endTlDrag);
      D.tlRail.addEventListener('pointercancel', endTlDrag);
      D.tlRail.addEventListener('lostpointercapture', endTlDrag);
      D.tlRail.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) {
          const b = timelineBounds();
          if (!b || b.span <= 0) return;
          e.preventDefault();
          if (S.chartFollow) zoomFollowWithWheel(e);
          else panOverviewWithWheel(e);
          return;
        }
        if (S.chartFollow) {
          if (!timelineBounds()) return;
          e.preventDefault();
          zoomFollowWindowByFactor(wheelZoomFactor(e));
          return;
        }
        if (S.chartRightLock) setChartRightLock(false);
        const t = tlEventTime(e);
        if (t === null) return;
        e.preventDefault();
        zoomTimelineAt(t, wheelZoomFactor(e));
      }, { passive: false });
      D.tlRail.addEventListener('keydown', onTlKeyDown);
    }
    D.tlWindow?.addEventListener('pointerdown', (e) => e.stopPropagation());
    D.tlWindow?.addEventListener('pointerdown', onTlPointerDown);
    D.tlCacheSave?.addEventListener('click', (e) => { e.stopPropagation(); saveCacheSession(); });

    $('#btnQuickConnect')?.addEventListener('click', () => doConnect('openocd'));
    $('#btnQuickSim')?.addEventListener('click', () => doConnect('sim'));
    $('#btnOverlayAdvanced')?.addEventListener('click', () => {
      S.ui.overlayDismissed = true;
      updateOverlay();
      togglePanel('source');
    });

    D.btnPause.addEventListener('click', togglePause);
    D.btnReset?.addEventListener('click', resetTarget);
    $('#btnSidebar')?.addEventListener('click', () => D.sidebar?.classList.toggle('open'));
    $('#btnClear').addEventListener('click', clearAll);
    $('#btnChart')?.addEventListener('click', () => toggleSection('chart'));
    D.btnChartFull?.addEventListener('click', () => setChartFull(!S.chartFull));
    $('#btnShot').addEventListener('click', snapshot);
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
      if (b.dataset.view === 'tree') {
        toast('树视图暂时下线，后续替换', 'ok');
        return;
      }
      S.ui.view = 'list';
      updateViewSeg();
      saveLocal();
      renderCatalog();
    }));
    D.btnCollapseAll?.addEventListener('click', collapseAll);
    $('#btnReloadSymbols').addEventListener('click', reloadCatalog);

    // value table collapse
    D.btnTableToggle?.addEventListener('click', (e) => { e.stopPropagation(); setTableOpen(!S.ui.tableOpen); });
    D.tableHead?.addEventListener('click', (e) => {
      if (e.target.closest('#btnTableToggle')) return;
      setTableOpen(!S.ui.tableOpen);
    });
    syncTablePanel();

    // toolbar
    D.winSel.addEventListener('change', () => {
      setWindowSec(Number(D.winSel.value), { save: false });
      applyWindowSecToOverview();
      saveLocal();
    });
    D.winSel2.addEventListener('change', () => {
      setWindowSec(Number(D.winSel2.value), { save: false });
      applyWindowSecToOverview();
      saveLocal();
    });
    $('#autoZero').addEventListener('change', (e) => { S.autoZero = e.target.checked; saveLocal(); S.dirty = true; });
    $('#fillOn').addEventListener('change', (e) => { S.fillOn = e.target.checked; saveLocal(); S.dirty = true; });
    $('#gridOn').addEventListener('change', (e) => { S.gridOn = e.target.checked; saveLocal(); S.dirty = true; });
    $('#zeroLine').addEventListener('change', (e) => { S.zeroLine = e.target.checked; saveLocal(); S.dirty = true; });
    $('#glowOn').addEventListener('change', (e) => { S.glow = e.target.checked; saveLocal(); S.dirty = true; });

    // drawer
    $$('#archSeg button').forEach((b) => b.addEventListener('click', () => {
      S.arch = b.dataset.arch === 'riscv' ? 'riscv' : 'cw32';
      syncArchUI();
      saveLocal();
    }));
    $$('#srcSeg button').forEach((b) => b.addEventListener('click', () => {
      $$('#srcSeg button').forEach((x) => x.classList.toggle('active', x === b));
      const mode = b.dataset.mode;
      $('#fieldOpenocd').classList.toggle('hidden', mode !== 'openocd');
      $('#fieldAttach').classList.toggle('hidden', mode !== 'attach');
      D.srcSegMode = mode;
      updateSourceHint();
    }));
    $('#btnDoConnect').addEventListener('click', () => {
      const mode = D.srcSegMode || 'openocd';
      doConnect(mode);
    });
    $('#btnDisconnect').addEventListener('click', disconnectSource);
    D.btnConnect?.addEventListener('click', async () => {
      if (sourceConnected(S.source) && !S.sampler?.error) {
        await disconnectSource();
        return;
      }
      const mode = S.lastMode
        || (S.source?.kind === 'sim' ? 'sim' : S.source?.kind === 'attach' ? 'attach' : 'openocd');
      await doConnect(mode);
    });
    D.rateSel.addEventListener('change', () => {
      let v = Number(D.rateSel.value) || 20;
      if (S.arch === 'riscv' && v > 50) v = 50;
      S.rate = v;
      if (D.rateSel.value !== String(v)) D.rateSel.value = String(v);
      saveLocal();
      sendConfig();
      renderCards();
    });

    // 写入：全局解锁 + 每个模块自己的类型/范围/锁定
    const finishPointerLive = () => {
      for (const mod of S.write.mods) finishLiveWrite(mod);
    };
    window.addEventListener('pointerup', finishPointerLive);
    window.addEventListener('pointercancel', finishPointerLive);
    window.addEventListener('blur', finishPointerLive);
    D.writeArmed?.addEventListener('change', () => {
      S.write.armed = !!D.writeArmed.checked;
      if (!S.write.armed) stopAllLiveWrites();
      else for (const mod of S.write.mods) if (mod.locked) startLockWrite(mod);
      for (const mod of S.write.mods) {
        mod.pending = null;
        mod.status = '';
        mod.statusKind = '';
        mod.dragging = false;
      }
      syncWriteUI();
      refreshWriteUI();
      saveLocal();
    });

    // 顶部 4 张控制卡：工程 / 符号 / 信号源 / 采样率
    for (const card of $$('.ctl-card')) {
      const go = () => togglePanel(card.dataset.go);
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
    D.mcuSel?.addEventListener('change', () => selectMcu(D.mcuSel.value, true));
    $('#btnChipProbe')?.addEventListener('click', probeChipNow);
    $('#btnChipBannerFix')?.addEventListener('click', () => togglePanel('symbol'));

    // 工程
    D.projectSel?.addEventListener('change', () => switchProject(D.projectSel.value));
    D.projectSel2?.addEventListener('change', () => switchProject(D.projectSel2.value));
    $('#btnProjectNew')?.addEventListener('click', newProject);
    $('#btnProjectSaveAs')?.addEventListener('click', saveProjectAs);
    $('#btnProjectDelete')?.addEventListener('click', deleteProject);
    $('#btnProjectExport')?.addEventListener('click', exportProject);
    $('#btnProjectImport')?.addEventListener('click', () => D.projectFile?.click());
    D.btnProfileSave?.addEventListener('click', () => flushProfileSave(true));
    D.btnProfileBuild?.addEventListener('click', buildCurrentProfile);
    D.projectFile?.addEventListener('change', () => {
      const f = D.projectFile.files && D.projectFile.files[0];
      if (f) importProjectFile(f);
      D.projectFile.value = '';
    });
    $('#btnCalibClose')?.addEventListener('click', closeCalibModal);
    $('#btnCalibCancel')?.addEventListener('click', closeCalibModal);
    $('#btnCalibApply')?.addEventListener('click', applyCalibModal);
    D.calibModal?.addEventListener('click', (e) => { if (e.target === D.calibModal) closeCalibModal(); });

    document.querySelectorAll('[data-sec-close]').forEach((b) => {
      b.addEventListener('click', () => {
        const sec = b.dataset.secClose;
        if (!S.ui.sections) S.ui.sections = { chart: true, table: true, write: true };
        S.ui.sections[sec] = false;
        syncSections();
        saveLocal();
      });
    });
    D.btnRecVars?.addEventListener('click', () => {
      D.recVars?.classList.toggle('hidden');
    });
    D.btnRecExport?.addEventListener('click', exportRecording);
    for (const [el, key] of [[D.marginCur, 'cur'], [D.marginThr, 'thr']]) {
      el?.addEventListener('change', () => {
        S.margin[key] = el.value;
        saveLocal();
        S.dirty = true;
        renderCards();
      });
    }
    $('#btnReloadCatalog').addEventListener('click', reloadCatalog);
    $('#btnImportVars').addEventListener('click', importAxf);
    $('#btnImportRegs').addEventListener('click', importRegisters);
    D.btnImportRegInfo?.addEventListener('click', () => D.regInfoFile?.click());
    D.regInfoFile?.addEventListener('change', () => { if (D.regInfoFile.files?.length) importRegInfo(); });
    D.btnRecReset?.addEventListener('click', async () => {
      if (!confirm('确定丢弃当前录制数据并重新计时？')) return;
      try {
        const r = await post('/api/record/reset', {});
        S.record = r.record || {};
        toast('录制已重置', 'ok');
        await refreshStatus();
      } catch (e) {
        toast('重置失败: ' + e.message, 'err');
      }
    });

    // keyboard
    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape') {
        if (D.calibModal && !D.calibModal.classList.contains('hidden')) { closeCalibModal(); return; }
        if (S.ui.panel) closePanels();
        else if (S.ui.log) { S.ui.log = false; D.logPanel.classList.add('hidden'); }
        return;
      }
      if (typing) return;
      // Ctrl/Cmd/Alt 组合键交给浏览器（尤其是 Ctrl+C 复制），不要抢
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      else if (e.key === 'c' || e.key === 'C') clearAll();
      else if (e.key === '/') { e.preventDefault(); D.search.focus(); }
    });
  }

  function setReadDisplay(id, value) {
    const entry = S.index.get(id);
    if (!entry) return;
    S.readVals.set(id, value);
    const row = S.rows.get(id);
    const txt = fmtValue(row || entry, value);
    const staticOnly = !!(row && (row.table || row.plot));
    const live = S.liveRows.get(id);
    if (live) live.textContent = txt;
    const sel = S.selRows.get(id);
    if (sel) { const el = sel.querySelector('.sel-val'); if (el) el.textContent = txt; }
    for (const el of document.querySelectorAll('.sig-row')) {
      if (el.dataset.id !== id) continue;
      const v = el.querySelector('.sig-val');
      if (v) v.textContent = txt;
      const d = el.querySelector('.sig-desc');
      if (d) {
        const t = descFor(entry, staticOnly);
        d.textContent = t;
        d.title = t;
      }
    }
  }

  function decodeRegBits(regId, word) {
    const w = Number(word) >>> 0;
    for (const [id, entry] of S.index) {
      if (!entry.bit || !id.startsWith(regId + '.')) continue;
      const shift = Number(entry.bit[0]) || 0;
      const width = Number(entry.bit[1]) || 1;
      const mask = width >= 32 ? 0xFFFFFFFF : ((1 << width) - 1);
      setReadDisplay(id, (w >>> shift) & mask);
    }
  }

  async function readOne(id) {
    const entry = S.index.get(id);
    if (!entry) { toast('找不到信号: ' + id, 'err'); return; }
    if (!sourceConnected(S.source)) { toast('未连接，无法读取', 'err'); return; }
    try {
      const r = await post('/api/read', {
        addr: entry.addr, size: entry.size || 4,
        signed: !!entry.signed, bit: entry.bit || null,
      });
      if (!r.ok) throw new Error(r.error || '读取失败');
      setReadDisplay(id, r.value);
      // 寄存器行：用同一次读回的 word 刷新所有子位域，不额外读
      if (!entry.bit && entry.kind === 'reg') decodeRegBits(id, r.word);
    } catch (e) {
      toast('读取失败: ' + brief(e.message), 'err');
    }
  }

  async function readPeripheral(name) {
    if (!sourceConnected(S.source)) { toast('未连接，无法读取', 'err'); return; }
    const p = peripheralList().find((x) => x.name === name);
    if (!p) { toast('找不到外设: ' + name, 'err'); return; }
    let btn = null;
    for (const b of document.querySelectorAll('[data-periph-read]')) {
      if (b.dataset.periphRead === name) { btn = b; break; }
    }
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    let ok = 0, fail = 0;
    for (const r of p.regs || []) {
      const id = name + '.' + r.name;
      const entry = S.index.get(id);
      if (!entry) continue;
      try {
        const rsp = await post('/api/read', {
          addr: entry.addr, size: entry.size || 4, signed: !!entry.signed,
        });
        if (rsp.ok) {
          setReadDisplay(id, rsp.value);
          decodeRegBits(id, rsp.word);
          ok++;
        } else {
          fail++;
        }
      } catch (e) {
        fail++;
      }
      await new Promise((res) => setTimeout(res, 0));
    }
    if (btn) { btn.disabled = false; btn.textContent = '读'; }
    toast(name + ' 读取完成：' + ok + ' 个寄存器' + (fail ? '，' + fail + ' 个失败' : ''),
      fail ? 'err' : 'ok');
  }

  function onCatalogClick(e) {
    const rd = e.target.closest('[data-row-read]');
    if (rd) {
      e.preventDefault();
      e.stopPropagation();
      readOne(rd.dataset.rowRead);
      return;
    }
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
    const periphRead = e.target.closest('[data-periph-read]');
    if (periphRead) {
      e.preventDefault();
      e.stopPropagation();
      readPeripheral(periphRead.dataset.periphRead);
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
    // 行点击只展开/收起详情，不再加入波/表；波/表/写/读都在右侧按钮
    const item = row.closest('.sig-item');
    if (!item) return;
    item.classList.toggle('open');
    if (S.ui.expanded.has(id)) S.ui.expanded.delete(id); else S.ui.expanded.add(id);
  }

  // ---------------------------------------------------------------- 卡片悬浮面板
  const PANEL_NAMES = ['project', 'record', 'source', 'rate'];

  function panelFor(name) {
    return document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1));
  }

  function closePanels() {
    for (const n of PANEL_NAMES) {
      const el = panelFor(n);
      if (el) el.hidden = true;
    }
    document.querySelectorAll('.ctl-card.active').forEach((c) => c.classList.remove('active'));
    S.ui.panel = '';
  }

  function placePanel(el, card) {
    const r = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.style.visibility = 'hidden';
    el.hidden = false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.max(8, Math.min(r.left, vw - w - 8));
    let top = r.bottom + 8;
    const maxH = vh - top - 10;
    el.style.maxHeight = Math.max(220, maxH) + 'px';
    if (h > maxH) {
      top = Math.max(8, vh - Math.max(220, maxH) - 10);
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.visibility = '';
  }

  function togglePanel(name) {
    const el = panelFor(name);
    const card = document.querySelector('.ctl-card[data-go="' + name + '"]');
    if (!el) return;
    const isOpen = !el.hidden;
    closePanels();
    if (isOpen) return;
    el.hidden = false;
    S.ui.panel = name;
    if (card) {
      card.classList.add('active');
      placePanel(el, card);
    } else {
      el.style.left = '50%';
      el.style.top = '80px';
      el.style.transform = 'translateX(-50%)';
    }
    el.style.visibility = '';
  }

  function updateSourceHint() {
    if (!D.srcHint) return;
    const mode = D.srcSegMode || 'openocd';
    if (mode === 'sim') {
      D.srcHint.textContent = '不连硬件，用脚本信号演示全部 UI。';
    } else if (mode === 'attach') {
      D.srcHint.textContent = '连到已经在跑的 OpenOCD tcl_port（如手工启动的 openocd -c "tcl_port 6666"），RISC-V / ARM 都可。';
    } else if (S.arch === 'riscv') {
      D.srcHint.textContent = '启动 WCH OpenOCD（wlinke + sdi）连接 CH32V203。读取内存需要短暂 halt；可选 1–50 Hz，越低干扰越小。程序会短暂停顿，但不会一直暂停。';
    } else {
      const prof = activeProfile();
      if (prof && prof.id === 'LKS32-FOC') {
        D.srcHint.textContent = '启动 ARM OpenOCD（SWD）连接 LKS32MC07x；目标配置 profiles/targets/lks32mc07x.cfg，只读采样、不碰 Flash/复位。';
      } else {
        D.srcHint.textContent = '启动 ARM OpenOCD（cmsis-dap + SWD）连接 ' +
          ((prof && prof.mcu) || 'CW32L0') + '，读芯片 ID 自动识别型号。';
      }
    }
  }

  function syncRateOptions() {
    if (!D.rateSel) return;
    const max = S.arch === 'riscv' ? 50 : 200;
    for (const o of D.rateSel.options) {
      o.disabled = Number(o.value) > max;
    }
    if (Number(D.rateSel.value) > max) {
      D.rateSel.value = String(max);
    }
    S.rate = Number(D.rateSel.value) || S.rate;
  }

  function syncArchUI() {
    $$('#archSeg button').forEach((b) => {
      b.classList.toggle('active', (b.dataset.arch === 'riscv') === (S.arch === 'riscv'));
    });
    const label = $('#fieldOpenocd label');
    const inp = $('#inpOcd');
    if (S.arch === 'riscv') {
      if (label) label.textContent = 'WCH OpenOCD 根目录（留空自动）';
      if (inp) inp.placeholder = 'C:\\MounRiver\\MounRiver_Studio3\\...\\WCH\\OpenOCD\\OpenOCD';
    } else {
      if (label) label.textContent = 'OpenOCD 根目录（留空自动）';
      if (inp) inp.placeholder = 'D:\\Code\\DR2159\\tools\\openocd';
    }
    syncRateOptions();
    updateSourceHint();
  }

  function initPanels() {
    document.querySelectorAll('[data-panel-close]').forEach((b) => {
      b.addEventListener('click', closePanels);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!S.ui.panel) return;
      if (e.target.closest('.float-panel') || e.target.closest('.ctl-card')) return;
      if (e.target.closest('#chipBanner')) return;
      closePanels();
    });
    window.addEventListener('resize', () => closePanels());
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

  async function resetTarget() {
    if (!sourceConnected(S.source)) {
      toast('未连接，不能复位', 'err');
      return;
    }
    if (!confirm('复位目标？电机会按固件从复位向量重新启动。')) return;
    const btn = D.btnReset;
    const old = btn ? btn.querySelector('.btn-label')?.textContent : '';
    if (btn) { btn.disabled = true; const l = btn.querySelector('.btn-label'); if (l) l.textContent = '复位中'; }
    try {
      const r = await post('/api/reset', {});
      if (!r.ok) throw new Error(r.error || '复位失败');
      toast('已复位目标' + (r.method ? '（' + r.method + '）' : ''), 'ok');
      setTimeout(refreshStatus, 400);
    } catch (e) {
      toast('复位失败: ' + brief(e.message), 'err');
    } finally {
      if (btn) {
        btn.disabled = false;
        const l = btn.querySelector('.btn-label');
        if (l) l.textContent = old || '复位';
      }
    }
  }

  function clearAll() {
    clearPin();
    S.samples = [];
    S.lastT = 0;
    S.pauseAt = 0;
    S.paused = false;
    S.hoverT = null;
    resetChartTimeline();
    scheduleTimelineSave();
    updatePauseUI();
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

  function snapshot() {
    try {
      const url = D.chart.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'motorscope_' + stamp() + '.png';
      a.click();
    } catch (e) { toast('截图失败: ' + e.message, 'err'); }
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
    S.readVals.clear();
    buildIndex();
    S.samples = [];
    S.lastT = 0;
    resetChartTimeline();
    let missing = 0;
    // 按 id 重新解析地址；新 AXF 里不存在的旧行删掉，避免拿旧地址继续采样
    for (const [id, row] of Array.from(S.rows.entries())) {
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
    ensureWriteMods();
    ensureWaveGroups();
    syncChannels();
    renderCatalog(); renderSelected(); renderLegend(); renderValueTable();
    renderWriteMods();
    S.mcu.expected = String(catalog.meta?.mcu || '');
    const mid = resolveMcuId(S.mcu.expected);
    if (!S.chip && mid) selectMcu(mid);
    applyChip(S.chip);
    renderCards();
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
    const fd = new FormData();
    fd.append('axf', axf, axf.name || 'firmware.axf');
    fd.append('expect', 'vars');
    const btn = D.btnImportVars;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '解析中…'; }
    toast('正在解析 AXF/ELF…');
    try {
      const res = await fetch('/api/catalog/import', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      if (!res.ok || !data.ok) throw new Error(data.error || '导入失败');
      applyCatalog(data.catalog);
      toast('AXF/ELF 已导入：' + data.counts.variables + ' 变量', 'ok');
      if (data.warning) toast(data.warning, 'err');
    } catch (e) {
      toast('导入失败: ' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || '导入 AXF/ELF'; }
    }
  }

  async function importRegisters() {
    const f = D.hdrFile?.files?.[0];
    if (!f) { toast('先选择寄存器表（.h / .svd / .json）', 'err'); return; }
    const fd = new FormData();
    fd.append('table', f, f.name || 'registers.svd');
    const btn = D.btnImportRegs;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '解析中…'; }
    toast('正在解析寄存器表…');
    try {
      const res = await fetch('/api/catalog/registers', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      if (!res.ok || !data.ok) throw new Error(data.error || '导入失败');
      applyCatalog(data.catalog);
      toast('寄存器表已导入：' + data.counts.peripherals + ' 外设' +
        (data.source ? '（' + data.source + '）' : ''), 'ok');
    } catch (e) {
      toast('导入失败: ' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || '导入寄存器表'; }
    }
  }

  async function importRegInfo() {
    const f = D.regInfoFile?.files?.[0];
    if (!f) { toast('先选择寄存器信息 JSON', 'err'); return; }
    const btn = D.btnImportRegInfo;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.entries)) {
        throw new Error('不是寄存器信息 JSON（缺少 entries 数组）');
      }
      const model = S.mcu.active || S.catalog.meta?.mcu || '';
      if (!model) throw new Error('未确定型号');
      const r = await post('/api/reginfo/import', Object.assign({}, data, { model }));
      if (!r.ok) throw new Error(r.error || '导入失败');
      await loadReginfo(model);
      renderCatalog();
      S.dirty = true;
      const un = r.counts && r.counts.unmatched ? '，' + r.counts.unmatched + ' 条与模板不匹配' : '';
      toast('寄存器信息已导入：' + r.counts.entries + ' 条（' + model + un + '）', 'ok');
    } catch (e) {
      toast('导入寄存器信息失败: ' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || '导入寄存器信息'; }
      if (D.regInfoFile) D.regInfoFile.value = '';
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
    if (!D.toasts) return null;
    const key = kind + '|' + msg;
    // 同一条消息不重复堆叠：先移除旧的，再放一条新的
    for (const old of Array.from(D.toasts.children)) {
      if (old.dataset.key === key) {
        clearTimeout(old._timer);
        old.remove();
      }
    }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.dataset.key = key;
    const text = document.createElement('span');
    text.className = 'toast-msg';
    text.textContent = msg;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-x';
    x.title = '关闭';
    x.textContent = '×';
    el.appendChild(text);
    el.appendChild(x);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(el._timer);
      el.classList.add('out');
      setTimeout(() => el.remove(), 200);
    };
    x.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    el.addEventListener('click', close);

    D.toasts.appendChild(el);
    while (D.toasts.children.length > 4) D.toasts.firstElementChild.remove();
    el._timer = setTimeout(close, kind === 'err' ? 6000 : 3200);
    return el;
  }

  // ---------------------------------------------------------------- go
  window.__MS = S;          // 调试/自动化用
  window.__MS_draw = draw;
  document.addEventListener('DOMContentLoaded', boot);
})();
