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
  function fmtFloat(v) {
    if (!isFinite(v)) return '--';
    const a = Math.abs(v);
    const digits = a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
    return v.toLocaleString('en-US', { maximumFractionDigits: digits });
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
  function fmtAxisFloat(v) {
    if (!isFinite(v)) return '';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M';
    if (a >= 1e4) return (v / 1e3).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'k';
    const digits = a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return v.toLocaleString('en-US', { maximumFractionDigits: digits });
  }
  function fmtValue(sig, raw) {
    if (raw === null || raw === undefined) return '--';
    const v = raw * (sig?.scale ?? 1) + (sig?.offset ?? 0);
    if (!isFinite(v)) return '--';
    if (sig?.float || /^float/i.test(String(sig?.type || ''))) return fmtFloat(v);
    if ((sig?.scale ?? 1) === 1 && (sig?.offset ?? 0) === 0) return fmtInt(v);
    return (Math.round(v * 100) / 100).toLocaleString('en-US');
  }
  function hex(n, w = 8) {
    return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
  }
  function shortName(name) {
    return String(name || '').replace(/^motor\./, '').replace(/^adc\./, 'adc.');
  }
  function rowDisplayName(row) {
    if (!row) return '';
    const base = shortName(row.name || row.id);
    if ((S.sources || []).length > 1 && row.source) {
      return '[' + (sourceInfo(row.source)?.label || row.source) + '] ' + base;
    }
    return base;
  }
  // 导入文件落盘时会加时间戳前缀；界面显示时去掉
  function stripStamp(name) {
    return String(name || '').replace(/^\d{8}_\d{6}(?:_\d+)?_/, '');
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
    // 多输入源
    sources: [],
    primarySource: '',
    activeSource: '',
    catalogs: new Map(),
    ocdConfigs: new Map(),
    // S.rows: 用户拥有的所有行（含仅支撑 AVG 的隐藏通道、两个开关都关的行）
    rows: new Map(),
    // S.signals: 真正下发给 /api/config 并被采样的通道；samples 的列顺序与它一致
    signals: [],
    virtuals: [],
    virtualSeq: 0,
    samples: [],
    lastT: 0,
    displaySince: 0,
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
    // API 侧表/波/写开关（服务端 POST /api/signal-flags 下发；本地可覆盖）
    signalFlags: {},
    signalFlagsKey: '',
    signalFlagsBusy: false,
    signalFlagsTimer: 0,
    autoZero: false,
    fillOn: true,
    smoothOn: false,
    renderMode: 'classic',
    gridOn: true,
    zeroLine: true,
    glow: false,
    // 芯片型号 / 寄存器模板（与后端识别结果共用 web/mcu/index.json）
    chip: null,
    lastMode: 'openocd',
    arch: 'cw32',
    // 调试器 / USB 接口选择：iface 为 OpenOCD interface cfg 名（'' = 自动）
    // 当前选中的调试器：serial 为主键（区分同款多设备），'' = OpenOCD 自动选
    usb: { serial: '', iface: '', label: '自动', name: '', devices: [], available: false },
    recordSel: new Set(),
    mcu: {
      models: [], active: '', detected: '', candidates: [], exact: false,
      expected: '', match: null, warning: '', loaded: false, periphs: [], manual: false,
    },
    // 机型工程：后端 profiles/ 下的四套「符号 + 芯片 + 连接 + 配置」
    profiles: { active: '', items: [], loaded: false, error: '' },
    profileConfigRestored: false,  // 当前 UI 的通道是否来自该机型 config.json
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
    paneRanges: new Map(),
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
    analysis: { mode: 'spectrum', x: '', y: '', range: null, busy: false },
    measure: { on: false, drag: null, key: '', stats: [], lastAt: 0 },
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
    D.connDev = $('#connDev');
    D.connRate = $('#connRate');
    D.sidebar = $('#sidebar');
    D.catalogBody = $('#catalogBody');
    D.search = $('#search');
    D.sigCount = $('#sigCount');
    D.btnCollapseAll = $('#btnCollapseAll');
    D.selCount = $('#selCount');
    D.selectedList = $('#selectedList');
    D.legend = $('#legend');
    D.legendRow = $('#legendRow');
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
    D.measureTip = $('#measureTip');
    D.btnMeasure = $('#btnMeasure');
    D.timelineBar = $('#timelineBar');
    D.tlMode = $('#tlMode');
    D.tlModeText = $('#tlModeText');
    D.tlRail = $('#tlRail');
    D.tlWindow = $('#tlWindow');
    D.tlBack10 = $('#tlBack10');
    D.tlFwd10 = $('#tlFwd10');
    D.tlLatest = $('#tlLatest');
    D.tlFirst = $('#tlFirst');
    D.tlLast = $('#tlLast');
    D.tlWin = $('#tlWin');
    D.renderModes = $('#renderModes');
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
    D.cardSample = $('#cardSample');
    D.cardAnalysis = $('#cardAnalysis');
    D.cardAnalysisSub = $('#cardAnalysisSub');
    D.anaTabs = $('#anaTabs');
    D.anaSignal = $('#anaSignal');
    D.anaSignalY = $('#anaSignalY');
    D.anaYField = $('#anaYField');
    D.anaCanvas = $('#anaCanvas');
    D.anaInfo = $('#anaInfo');
    D.anaPreview = $('#anaPreview');
    D.anaTimeAxis = $('#anaTimeAxis');
    D.anaRangeText = $('#anaRangeText');
    D.btnAnaFull = $('#btnAnaFull');
    D.btnAnaLast = $('#btnAnaLast');
    D.btnAnaRefresh = $('#btnAnaRefresh');
    D.cardRecordSub = $('#cardRecordSub');
    D.recCount = $('#recCount');
    D.recSeconds = $('#recSeconds');
    D.recStart = $('#recStart');
    D.recLimit = $('#recLimit');
    D.recHint = $('#recHint');
    D.btnRecVars = $('#btnRecVars');
    D.recVars = $('#recVars');
    D.btnRecExport = $('#btnRecExport');
    D.cardSourceVal = $('#cardSourceVal');
    D.btnAddSource = $('#btnAddSource');
    D.sourceHeroes = $('#sourceHeroes');
    D.sourceChips = $('#sourceChips');
    D.srcAddLabel = $('#srcAddLabel');
    D.srcAddKind = $('#srcAddKind');
    D.srcAddRate = $('#srcAddRate');
    D.srcAddProfile = $('#srcAddProfile');
    D.srcAddAttach = $('#srcAddAttach');
    D.srcAddOpenocd = $('#srcAddOpenocd');
    D.srcAddHost = $('#srcAddHost');
    D.srcAddPort = $('#srcAddPort');
    D.srcAddAxf = $('#srcAddAxf');
    D.srcAddTable = $('#srcAddTable');
    D.srcAddMcu = $('#srcAddMcu');
    D.srcAddSerial = $('#srcAddSerial');
    D.srcAddHint = $('#srcAddHint');
    D.inpIface = $('#inpIface');
    D.inpTarget = $('#inpTarget');
    D.btnOcdRefresh = $('#btnOcdRefresh');
    D.srcAddOcd = $('#srcAddOcd');
    D.srcAddIface = $('#srcAddIface');
    D.srcAddTarget = $('#srcAddTarget');
    D.btnSrcAddOcdRefresh = $('#btnSrcAddOcdRefresh');
    D.btnSrcAddCreate = $('#btnSrcAddCreate');
    D.btnSrcAddCreateConnect = $('#btnSrcAddCreateConnect');
    D.cardSourceSub = $('#cardSourceSub');
    D.cardRateVal = $('#cardRateVal');
    D.cardRateSub = $('#cardRateSub');
    D.cardRateBar = $('#cardRateBar');
    D.cardRateBarText = $('#cardRateBarText');
    D.btnImportVars = $('#btnImportVars');
    D.importModal = $('#importModal');
    D.importAxf = $('#importAxf');
    D.importTable = $('#importTable');
    D.importName = $('#importName');
    D.importHint = $('#importHint');
    D.btnImportClose = $('#btnImportClose');
    D.btnImportCancel = $('#btnImportCancel');
    D.btnImportUpdate = $('#btnImportUpdate');
    D.btnImportCreate = $('#btnImportCreate');
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
    D.btnProfileNew = $('#btnProfileNew');
    D.btnProfileCopy = $('#btnProfileCopy');
    D.btnProfileBuild = $('#btnProfileBuild');
    D.btnProfileSave = $('#btnProfileSave');
    D.toasts = $('#toasts');
    D.logPanel = $('#logPanel');
    D.logText = $('#logText');
    D.btnPause = $('#btnPause');
    D.btnReset = $('#btnReset');
    D.btnChart = $('#btnChart');
    D.btnConnect = $('#btnConnect');
    D.btnSyncServer = $('#btnSyncServer');
    D.srcHint = $('#srcHint');
    D.rateSel = $('#rateSel');
    D.winSel = $('#winSel');
    D.winSel2 = $('#winSel2');
  }

  // ---------------------------------------------------------------- catalog
  function activeSourceId() {
    return String(S.activeSource || S.primarySource ||
      (S.sources && S.sources[0] && S.sources[0].id) || 'default');
  }
  function sourceInfo(id) {
    return (S.sources || []).find((x) => x.id === String(id || '')) || null;
  }
  function sourceLabel(id) {
    const src = sourceInfo(id);
    return src ? (src.label || src.id) : String(id || '');
  }
  function srcKey(localId, sid) {
    return String(sid || activeSourceId()) + '::' + String(localId || '');
  }

  async function loadSources() {
    try {
      const res = await fetchJSON('/api/sources');
      S.sources = Array.isArray(res.sources) ? res.sources : [];
      S.primarySource = String(res.primary || S.primarySource || '');
    } catch (e) {
      S.sources = S.sources || [];
      S.primarySource = S.primarySource || '';
    }
    if (!S.activeSource || !sourceInfo(S.activeSource)) {
      S.activeSource = S.primarySource || (S.sources[0] && S.sources[0].id) || 'default';
    }
    renderSourceHeros();
    renderSourceChips();
    return S.sources;
  }

  async function loadCatalog(sourceId) {
    const sid = String(sourceId || '');
    try {
      const cat = await fetchJSON(sid
        ? '/api/catalog?source=' + encodeURIComponent(sid)
        : '/api/catalog');
      if (sid) S.catalogs.set(sid, cat);
      if (!sid || sid === activeSourceId()) {
        S.catalog = cat;
        buildIndex();
      }
    } catch (e) {
      toast('加载信号表失败: ' + e.message, 'err');
      if (!sid || sid === activeSourceId()) {
        S.catalog = { variables: [], peripherals: [], defaults: [], stall: {}, meta: {} };
        buildIndex();
      }
    }
  }

  async function selectSource(sid) {
    const id = String(sid || '');
    if (!id || !sourceInfo(id)) return;
    S.activeSource = id;
    if (!S.catalogs.has(id)) await loadCatalog(id);
    else { S.catalog = S.catalogs.get(id); buildIndex(); }
    renderSourceHeros();
    renderSourceChips();
    renderCatalog();
    renderSelected();
    updateEmptyHint();
    if (S.ui.panel === 'source') syncSourceConnectionUI();
  }

  function buildIndex() {
    S.index.clear();
    const sid = activeSourceId();
    for (const v of S.catalog.variables || []) {
      const key = srcKey(v.name, sid);
      S.index.set(key, {
        ...v, id: key, localId: v.name, source: sid, kind: 'var',
        name: v.name, group: v.group || '', bit: v.bit || null,
      });
    }
    for (const p of peripheralList()) {
      for (const r of p.regs || []) {
        const local = p.name + '.' + r.name;
        const rid = srcKey(local, sid);
        S.index.set(rid, {
          id: rid, localId: local, source: sid, name: local,
          addr: r.addr, size: r.size || 4,
          signed: !!r.signed, bit: null, type: r.type || '',
          kind: 'reg', group: p.name, base: p.base,
        });
        for (const b of r.bits || []) {
          const blocal = local + '.' + b.name;
          const bid = srcKey(blocal, sid);
          S.index.set(bid, {
            id: bid, localId: blocal, source: sid, name: blocal,
            addr: r.addr, size: r.size || 4,
            signed: false, bit: [b.shift, b.width], type: 'bit' + b.width,
            kind: 'bit', group: p.name, base: p.base,
          });
        }
      }
    }
  }

  // 外设列表：明确导入过 SVD/JSON 寄存器表时以它为准，不能再叠加内置模板；
  // 只有从 AXF/头文件生成、模板能补齐缺失外设时才合并 web/mcu 模板。
  function peripheralList() {
    const base = S.catalog.peripherals || [];
    const src = String(S.catalog.meta?.register_source || '').toLowerCase();
    if (src === 'svd' || src === 'json') return base;
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

  // 自定义机型（例如只带 SVD 的 N32G003）不在 web/mcu 内置表里：给它补一个
  // 没有模板文件的条目，芯片下拉框仍能显示型号，寄存器表直接用 signals.json。
  function adoptExpectedMcu() {
    const exp = String(S.mcu.expected || '').trim();
    if (!exp) return '';
    const known = resolveMcuId(exp);
    if (known) return known;
    if (!S.mcu.models.some((m) => m.id === exp)) {
      S.mcu.models.push({ id: exp, vendor: '', file: '', identify: {}, aliases: [] });
    }
    if (D.mcuSel && !Array.from(D.mcuSel.options).some((o) => o.value === exp)) {
      const o = document.createElement('option');
      o.value = exp;
      o.textContent = exp + ' · 自定义 / SVD';
      D.mcuSel.appendChild(o);
    }
    if (!S.mcu.active) S.mcu.active = exp;
    return exp;
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
    adoptExpectedMcu();
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
      // 自定义型号（只有 SVD/机型自带寄存器表）：不能沿用上一个型号的模板
      S.mcu.periphs = [];
      buildIndex();
      renderCatalog();
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

  function renderRecordVars(signals) {
    if (!D.recVars) return;
    const list = (signals || []).filter((s) => s && s.id);
    const ids = list.map((s) => String(s.id));
    const sel = S.recordSel instanceof Set ? S.recordSel : (S.recordSel = new Set());
    const keep = new Set(ids.filter((id) => sel.has(id)));
    // 保存的 recordSel 可能来自旧固件/旧机型，和当前录制列没有交集：
    // 此时默认全选，避免“看起来都勾着、导出却只有一列/只有时间戳”。
    if (!keep.size) for (const id of ids) keep.add(id);
    S.recordSel = keep;
    D.recVars.innerHTML = '';
    if (!list.length) {
      D.recVars.innerHTML = '<div class="muted" style="font-size:11px">还没有录制列</div>';
      return;
    }
    const head = document.createElement('div');
    head.className = 'rec-vars-head';
    const countEl = document.createElement('span');
    countEl.textContent = '已选 ' + keep.size + ' / ' + list.length;
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'mini';
    allBtn.textContent = '全选';
    allBtn.addEventListener('click', () => {
      S.recordSel = new Set(ids);
      renderRecordVars(list);
      saveLocal();
    });
    head.appendChild(countEl);
    head.appendChild(allBtn);
    D.recVars.appendChild(head);
    for (const s of list) {
      const lab = document.createElement('label');
      lab.className = 'rec-var';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = keep.has(s.id);
      cb.addEventListener('change', () => {
        if (cb.checked) S.recordSel.add(s.id); else S.recordSel.delete(s.id);
        countEl.textContent = '已选 ' + S.recordSel.size + ' / ' + list.length;
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
    const valid = new Set(((S.record && S.record.signals) || []).map((s) => String(s.id)));
    let ids = Array.from(S.recordSel || []).filter((id) => valid.has(String(id)));
    // 选中项可能来自旧固件/旧机型；没有有效项时退回全部录制列
    if (!ids.length) ids = Array.from(valid);
    if (!ids.length) { toast('还没有可导出的录制列，请先连接并开始录制', 'err'); return; }
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
    if (D.cardRecordSub) {
      const connected = sourceConnected(S.source) && !S.sampler?.error;
      if (rec.count) {
        D.cardRecordSub.textContent = Number(rec.count || 0).toLocaleString('en-US') +
          ' 点 · 已录 ' + fmtDuration(rec.seconds || 0);
      } else {
        D.cardRecordSub.textContent = connected ? '等待样本…' : '连接后自动录制';
      }
    }

    const activeSrc = sourceInfo(S.activeSource);
    const kind = activeSrc?.kind || S.source?.kind || 'none';
    const connected = activeSrc
      ? !!activeSrc.connected
      : (sourceConnected(S.source) && !S.sampler?.error);
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
    const busy = Number(S.sampler?.busy_ms) || 0;
    const duty = Number(S.sampler?.duty) || 0;
    if (D.cardRateVal) D.cardRateVal.innerHTML = target + ' <i>Hz</i>';
    if (D.cardRateSub) {
      D.cardRateSub.textContent = connected
        ? '实际 ' + actual.toFixed(1) + ' Hz · ' + busy.toFixed(1) + ' ms/轮'
        : '实际 --';
    }
    // 占用率 = 一轮读+推送耗时 / 目标周期; 拉满说明探针已经读不过来
    const pct = Math.max(0, Math.min(100, duty * 100));
    if (D.cardRateBar) {
      D.cardRateBar.style.width = pct.toFixed(1) + '%';
      D.cardRateBar.classList.toggle('neg', duty >= 0.95);
    }
    if (D.cardRateBarText) {
      D.cardRateBarText.textContent = connected
        ? '占用 ' + (duty * 100).toFixed(0) + '%'
        : '占用 --';
      D.cardRateBarText.title = connected
        ? '每轮采样耗时 / 目标周期 (1/' + target + 's)。100% 表示刚好读得过来，超过就自动降速'
        : '连接后显示采样占用率';
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
  // 设计：S.rows 是用户拥有的行（含隐藏支撑通道、表/波/写全关的行）；
  // S.signals 只放真正要下发给 /api/config 的通道：至少勾选表/波/支撑之一，
  // 或作为 AVG 支撑/写入目标；samples 的列与它一一对应。
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

  // “已选择”保留本地拥有的行；真正进入实时采样的是表/波/支撑打开的行（见 syncChannels）
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
    const panels = document.getElementById('panels');
    if (panels) {
      panels.classList.toggle('write-hidden', secs.write === false);
      panels.classList.toggle('table-hidden', secs.table === false);
    }
    if (D.btnChart) {
      const on = secs.chart !== false;
      D.btnChart.classList.toggle('active', on);
      D.btnChart.setAttribute('aria-pressed', on ? 'true' : 'false');
      D.btnChart.title = on ? '隐藏波形分区' : '显示波形分区';
    }
    syncChartFullUI();
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
    const type = String(d.type || '');
    const size = Number(d.size) || 4;
    const isFloat = !bit && (!!d.float ||
      (size === 4 && /^(float|float32|_float)$/i.test(type)));
    let id = String(d.key || d.id || d.name || '');
    let localId = String(d.localId || d.id || d.name || '');
    let source = String(d.source || '');
    if (id.includes('::')) {
      const parts = id.split('::');
      source = source || parts[0];
      if (!d.localId) localId = parts[1] || localId;
    } else {
      source = source || activeSourceId();
      id = source + '::' + (localId || id);
    }
    return {
      kind: 'channel',
      id,
      localId,
      source,
      key: id,
      name: String(d.name || localId),
      addr: Number(d.addr) >>> 0,
      size,
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
      type,
      float: isFloat,
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
      // 型号/寄存器表里的 scale/unit/offset 优先，避免 voltage 被猜成 duty
      scale: Number(opts.scale ?? entry.scale ?? 1),
      offset: Number(opts.offset ?? entry.offset ?? 0),
      unit: opts.unit !== undefined
        ? opts.unit
        : (entry.unit !== undefined ? String(entry.unit || '') : inferUnit(entry.name)),
      step: opts.step ?? entry.step ?? isStepSignal(entry),
      table: opts.table !== undefined ? !!opts.table : true,
      plot: opts.plot !== undefined ? !!opts.plot : true,
      support: !!opts.support,
    });
  }

  function addRow(entry, opts = {}) {
    if (!entry) return null;
    const id = entry.id || entry.name;
    clearSignalFlag(id);
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
    const localId = 'custom.' + hex(addr) + '.' + size;
    const sid = activeSourceId();
    const id = srcKey(localId, sid);
    const entry = {
      id, localId, source: sid, name: name || ('@' + hex(addr, 4)), addr, size, signed,
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
    clearSignalFlag(id);
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
    clearSignalFlag(id);
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
    clearSignalFlag(id);
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
    const beforeFloat = new Map(S.signals.map((s) => [s.id, !!s.float]));
    const need = new Set();
    const avgSrc = new Set();
    for (const v of S.virtuals) for (const id of v.sourceIds) avgSrc.add(id);
    // 只有“表/波/支撑”需要实时读取；“写”只负责写，不参与连续采样。
    // 数组 AVG 的支撑通道和 support 角色例外。
    for (const r of S.rows.values()) {
      if (r.table || r.plot || r.support ||
          avgSrc.has(r.id) || r.configRole === 'support') {
        need.add(r.id);
      }
    }
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
    const sigKey = (s) => s.id + (s.float ? ':f' : ':i');
    const beforeSig = beforeIds.map((id) => id + (beforeFloat.get(id) ? ':f' : ':i')).join('|');
    const afterSig = S.signals.map(sigKey).join('|');
    if (beforeSig !== afterSig) {
      // 通道 id 没变、只是 int/float 解释变了：旧样本是 bit pattern，不能复用
      const typeChanged = next.some((s) =>
        beforeFloat.has(s.id) && beforeFloat.get(s.id) !== !!s.float);
      if (typeChanged) {
        S.samples = [];
        S.lastT = 0;
      } else {
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
      }
      S.lastChannelKey = afterSig;
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
      if (e && (e.float || /^float/i.test(e.type || ''))) {
        // 浮点变量当前只能显示/导出，不能按整数位写入
        continue;
      }
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
    clearSignalFlag(rowId);
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
    if ((row && (row.float || /^float/i.test(row.type || ''))) ||
        (entry && (entry.float || /^float/i.test(entry.type || '')))) {
      toast('浮点变量暂不支持写入（避免按整数位写坏 float32）', 'err');
      return;
    }
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
    const card = document.getElementById('writeCard');
    if (card) card.classList.toggle('empty', !S.write.mods.length);
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
        source: row.source || '',
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
    updateEmptyHint();
    saveLocal();
    sendViewState();
    if (monitorKey() !== S.lastConfigKey) sendConfig();
    S.dirty = true;
  }

  // ---- API 侧 表/波/写 开关 ----
  function setWriteFlagForRow(row, on) {
    if (!row) return false;
    const existing = writeModForRow(row.id);
    if (on) {
      if (existing) return false;
      if (!row.addr) return false;
      row.monitor = true;
      S.write.mods.push(makeWriteMod(row));
      ensureWriteMods();
      return true;
    }
    if (!existing) {
      let changed = false;
      if (row.writeOnly) { row.writeOnly = false; changed = true; }
      if (row.configRole === 'write') { row.configRole = ''; changed = true; }
      return changed;
    }
    S.write.mods = S.write.mods.filter((m) => m !== existing);
    stopLiveWrite(existing);
    stopLockWrite(existing);
    existing.liveHeld = false;
    row.writeOnly = false;
    if (row.configRole === 'write') row.configRole = '';
    ensureWriteMods();
    return true;
  }

  function applySignalFlags(flags) {
    if (!flags || typeof flags !== 'object') return;
    const key = JSON.stringify(flags);
    if (key === S.signalFlagsKey) return;
    S.signalFlags = flags;
    S.signalFlagsKey = key;
    let changed = false;
    for (const [id, spec] of Object.entries(flags)) {
      if (!spec || typeof spec !== 'object') continue;
      let row = S.rows.get(id);
      if (!row) {
        const entry = S.index.get(id);
        if (!entry || !entry.addr) continue;
        row = newRow(entry, { table: false, plot: false, support: false });
        row.monitor = true;
        S.rows.set(id, row);
        changed = true;
      }
      if (spec.table !== undefined && !!row.table !== !!spec.table) {
        row.table = !!spec.table;
        changed = true;
      }
      if (spec.plot !== undefined && !!row.plot !== !!spec.plot) {
        row.plot = !!spec.plot;
        changed = true;
      }
      if (spec.write !== undefined && setWriteFlagForRow(row, !!spec.write)) {
        changed = true;
      }
      if (typeof spec.color === 'string' &&
          /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(spec.color) &&
          row.color !== spec.color) {
        row.color = spec.color;
        changed = true;
      }
      if (row.table || row.plot) {
        if (row.support) { row.support = false; changed = true; }
        const g = waveGroupFor(row);
        if (g) g.visible = true;
      }
    }
    if (changed) {
      ensureWaveGroups();
      afterSignalsChanged();
    }
  }

  async function refreshSignalFlags() {
    if (S.signalFlagsBusy) return;
    S.signalFlagsBusy = true;
    try {
      const r = await fetchJSON('/api/signal-flags', { timeout: 5000 });
      if (r && r.ok) applySignalFlags(r.flags || {});
    } catch {
      // 老服务端没有该接口时保持本地开关
    } finally {
      S.signalFlagsBusy = false;
    }
  }

  function startSignalFlagsPolling() {
    if (S.signalFlagsTimer) clearInterval(S.signalFlagsTimer);
    refreshSignalFlags();
    S.signalFlagsTimer = setInterval(refreshSignalFlags, 3000);
  }

  // 本地手动点“表/波/写”后，撤掉该信号的 API 覆盖，避免下一次轮询又改回去
  function clearSignalFlag(id) {
    if (!S.signalFlags || !Object.prototype.hasOwnProperty.call(S.signalFlags, id)) return;
    delete S.signalFlags[id];
    S.signalFlagsKey = JSON.stringify(S.signalFlags);
    post('/api/signal-flags', { id, clear: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- boot
  async function ensureBootMachine() {
    if (!S.profiles.items.length) {
      await loadCatalog();
      return;
    }
    // 服务端 active 机型是权威：刷新后保持服务端选择的机型，不再被浏览器
    // localStorage 里最后一次工程“拽回去”。本地工程由
    // alignProjectToActiveMachine() 对齐到当前机型。
    if (S.profiles.active && S.profiles.items.some((x) => x.id === S.profiles.active)) {
      await loadCatalog();
      return;
    }
    // 只有服务端没有有效 active 机型时，才用本地工程的 machine 兜底。
    const p = readProjects();
    const cur = p.items[p.active];
    const target = cur && cur.machine;
    if (target && S.profiles.items.some((x) => x.id === target)) {
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
    await loadSources();
    await ensureBootMachine();
    alignProjectToActiveMachine();
    await hydrateProfileConfigFromServer();
    await loadSources();
    await loadMcuIndex();
    await loadStatus();
    await loadSources();
    if (!S.catalogs.has(S.activeSource)) await loadCatalog(S.activeSource);
    // 启动即空闲：没有已连接源时先进入暂停态（连接任一源时自动恢复）
    if (!(S.sources || []).some((x) => x && x.connected)) {
      S.paused = true;
      updatePauseUI();
    }
    restoreConfig();
    syncArchUI();
    updateConnPill();          // 恢复的上次选中的调试器先显示到顶栏
    refreshUsbDevices(false);  // 启动时枚举一次已连接的调试器实例
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
    startSignalFlagsPolling();
    window.MSRenderModes?.onChange?.(syncRenderModeUI);
    syncRenderModeUI();
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
    S.profileConfigRestored = false;
    const bootLoad = snapshot === undefined;
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
            const rawId = String(item.key || item.id || item.name || '');
            const src = String(item.source || (rawId.includes('::') ? rawId.split('::')[0] : activeSourceId()));
            const localId = String(item.localId ||
              (rawId.includes('::') ? rawId.split('::')[1] : rawId));
            const key = srcKey(localId, src);
            let entry = S.index.get(key) || S.index.get(rawId) || S.index.get(item.id);
            if (!entry && localId && item.addr !== undefined) {
              entry = {
                id: key, localId, source: src, name: item.name || localId,
                addr: Number(item.addr) >>> 0, size: Number(item.size) || 4,
                signed: !!item.signed, bit: null, type: item.type || 'custom',
                kind: 'custom', group: '自定义',
              };
              S.index.set(key, entry);
            }
            if (!entry) continue;
            const row = normalizeSignal({
              ...entry, ...item, key, id: key, localId, source: src,
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
            const sourceIds = (v.sourceIds || []).map((id) => {
              if (S.rows.has(id)) return id;
              return srcKey(id, activeSourceId());
            }).filter((id) => S.rows.has(id));
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
          S.profileConfigRestored = restored;
        }
        S.windowSec = Number(c.windowSec) || S.windowSec;
        // 时间轴模式持久化；overview 的具体 range 不落盘，避免跨会话拿到过期窗口，
        // 载入后默认最近 2 分钟，可用时间轴 «10m 往前扩。
        S.chartFollow = c.chartFollow !== false;
        S.chartFull = !!c.chartFull;
        S.chartRange = null;
        S.chartAutoFull = !S.chartFollow;
        S.rate = Number(c.rate) || S.rate;
        S.autoZero = !!c.autoZero;
        S.fillOn = c.fillOn !== false;
        S.smoothOn = c.smoothOn !== false;
        S.renderMode = typeof c.renderMode === 'string' ? c.renderMode : 'classic';
        S.smoothOn = S.renderMode !== 'classic';
        S.gridOn = c.gridOn !== false;
        S.zeroLine = c.zeroLine !== false;
        S.glow = !!c.glow;
        if (['openocd', 'attach', 'sim'].includes(c.lastMode)) S.lastMode = c.lastMode;
        if (c.arch === 'riscv' || c.arch === 'cw32') S.arch = c.arch;
        if (typeof c.usbSerial === 'string') S.usb.serial = c.usbSerial;
        if (typeof c.usbIface === 'string') S.usb.iface = c.usbIface;
        if (typeof c.usbName === 'string') S.usb.name = c.usbName;
        S.usb.label = S.usb.name
          ? devLabel({ name: S.usb.name, serial: S.usb.serial })
          : '自动（OpenOCD 自选）';
        if (typeof c.openocdDir === 'string') {
          const inp = $('#inpOcd');
          if (inp) inp.value = c.openocdDir;
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
        const entry = S.index.get(srcKey(names[i], activeSourceId())) || S.index.get(names[i]);
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
    // 刷新页面时如果服务端已经在采样，以服务端采样集为准：
    // 本地存档可能是旧的，先推上去会清掉后台 history/开新缓存会话。
    const serverCfg = S.status && S.status.config;
    const serverHas = bootLoad &&
      Array.isArray(serverCfg?.signals) && serverCfg.signals.length > 0 &&
      sourceConnected(S.status.source) && !(S.status.sampler && S.status.sampler.error);
    if (serverHas) {
      const localKey = configKeyOf(S.signals, S.rate);
      const serverKey = configKeyOf(serverCfg.signals, serverCfg.rate);
      adoptSharedConfig(serverCfg.signals, serverCfg.rate, { pushLocal: false });
      if (localKey !== serverKey) {
        toast('已采用服务器当前采样集（避免刷新覆盖后台记录）', 'ok');
      }
    } else if (S.rows.size) {
      sendConfig(true);
    }
    // 恢复的 recordSel 可能和当前录制列不一致，重建勾选状态，避免“显示全选、导出单列”
    if (D.recVars) renderRecordVars((S.record && S.record.signals) || []);
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
    S.paneRanges.clear();
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
    syncRenderModeUI();
  }

  function syncRenderModeUI() {
    const box = D.renderModes || $('#renderModes');
    if (!box) return;
    const api = window.MSRenderModes;
    const modes = api ? api.list() : [];
    if (!modes.length) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    if (!modes.some((m) => m.id === S.renderMode)) {
      S.renderMode = modes.some((m) => m.id === 'classic') ? 'classic' : modes[0].id;
      S.smoothOn = S.renderMode !== 'classic';
    }
    box.innerHTML = '';
    for (const mode of modes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rm-btn' + (mode.id === S.renderMode ? ' active' : '');
      b.dataset.renderMode = mode.id;
      b.textContent = mode.label || mode.id;
      let title = '波形渲染：' + (mode.label || mode.id);
      if (mode.id === 'mean' || mode.id === 'band') {
        title += '（可见窗口 <5 分钟时自动回退为原始，避免压扁真实电流/尖峰）';
      }
      b.title = title;
      b.setAttribute('aria-pressed', mode.id === S.renderMode ? 'true' : 'false');
      b.addEventListener('click', () => setRenderMode(mode.id));
      box.appendChild(b);
    }
  }

  function setRenderMode(id) {
    const api = window.MSRenderModes;
    if (!api || !api.get(id)) return;
    S.renderMode = String(id);
    S.smoothOn = S.renderMode !== 'classic';
    syncRenderModeUI();
    if (S.renderMode === 'mean' || S.renderMode === 'band') {
      const win = currentTimelineWindow();
      const span = win ? (win.end - win.start) : (S.windowSec || 20) * 1000;
      if (span && span < 5 * 60 * 1000) {
        toast('当前窗口 <5 分钟：均线/包络自动回退为原始，避免压扁真实电流曲线', 'ok');
      }
    }
    saveLocal();
    S.dirty = true;
  }

  function saveLocal() {
    try {
      writeCfgRaw(JSON.stringify({
        v: 2,
        machine: S.profiles.active,
        rows: Array.from(S.rows.values()).map((s) => ({
          id: s.id, name: s.name, addr: s.addr, size: s.size, signed: s.signed,
          scale: s.scale, offset: s.offset, unit: s.unit, color: s.color,
          step: s.step, axis: s.axis, type: s.type, float: !!s.float,
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
        smoothOn: S.smoothOn !== false,
        renderMode: S.renderMode,
        gridOn: S.gridOn,
        zeroLine: S.zeroLine,
        glow: S.glow,
        view: S.ui.view,
        tableOpen: S.ui.tableOpen,
        sections: Object.assign({ chart: true, table: true, write: true }, S.ui.sections || {}),
        mcu: S.mcu.active,
        lastMode: S.lastMode,
        arch: S.arch,
        usbSerial: S.usb.serial || '',
        usbIface: S.usb.iface || '',
        usbName: S.usb.name || '',
        openocdDir: ($('#inpOcd')?.value || '').trim(),
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

  // 服务端当前机型是权威：浏览器 localStorage 里的 active 工程若属于别的机型，
  // 直接恢复它会把那个机型的通道写进当前机型 config.json（表现：每次打开都被
  // 覆盖成同一套）。启动时先对齐到当前机型的工程，再 restoreConfig。
  function alignProjectToActiveMachine() {
    if (!S.profiles.active) return;
    const p = readProjects();
    const cur = p.items[p.active];
    if (cur && cur.machine === S.profiles.active) return;
    const name = findProjectByMachine(S.profiles.active, p);
    if (!name || name === p.active) return;
    p.active = name;
    writeProjects(p);
  }

  // 启动时以服务器 config.json 为准：浏览器 localStorage 里的工程可能过期，
  // 直接 restore 会把旧的一套通道再写回服务器（表现：每次打开都变回同一个配置）。
  async function hydrateProfileConfigFromServer() {
    const pid = S.profiles.active;
    if (!pid) return;
    try {
      const r = await fetchJSON('/api/profiles/config?id=' + encodeURIComponent(pid),
        { timeout: 5000 });
      const cfg = r && r.config;
      const rows = cfg && (cfg.rows || cfg.signals);
      if (!Array.isArray(rows) || !rows.length) return;  // 服务器空: 保留本地
      const p = readProjects();
      let name = findProjectByMachine(pid, p);
      if (!name) name = p.items[pid] ? pid : uniqueProjectName(pid);
      p.items[name] = Object.assign({}, cfg, {
        name, machine: pid, savedAt: new Date().toISOString(),
      });
      p.active = name;
      writeProjects(p);
      writeCfgRaw(JSON.stringify(p.items[name]));
    } catch (e) {
      console.warn('[profiles] 读取服务器机型配置失败，使用本地存档', e);
    }
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
      S.mcu.active = '';
      S.mcu.periphs = [];
      S.arch = res.profile && res.profile.arch === 'riscv' ? 'riscv' : 'cw32';
      S.mcu.expected = String((res.profile && res.profile.mcu) || '');
      S.rows.clear();
      S.virtuals = [];
      S.samples = [];
      S.lastT = 0;
      resetMachineWorkspace();
      buildIndex();
      adoptExpectedMcu();
      const mcuId = resolveMcuId(S.mcu.expected);
      if (mcuId) selectMcu(mcuId);

      // 配置优先级: 本机该机型工程 > 服务器 config.json > 空（用新符号表的默认信号）
      const p = readProjects();
      let name = findProjectByMachine(id);
      let cfg = name ? p.items[name] : null;
      const serverCfg = res.config && (Array.isArray(res.config.rows) || Array.isArray(res.config.signals))
        ? res.config : null;
      // 服务器 config.json 是权威；本地工程只在服务器为空时兜底。
      if (serverCfg && (serverCfg.rows || serverCfg.signals || []).length) {
        cfg = serverCfg;
      } else if ((!cfg || !(cfg.rows || cfg.signals || []).length) && serverCfg) {
        cfg = serverCfg;
      }
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
      await loadSources();
      await loadCatalog(S.activeSource);
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
    const snap = currentSnapshot();
    if (snap && snap.machine && snap.machine !== machine) {
      // 浏览器存档还是别的机型（常见于页面启动时源已在线、ensureBootMachine
      // 为避免断线没有切机型）；此时写盘会把别的机型通道覆盖到当前机型。
      console.warn('[profiles] 跳过跨机型保存:', snap.machine, '->', machine);
      return;
    }
    const cfg = Object.assign(snap, { machine, savedAt: new Date().toISOString() });
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
      D.projectState.textContent = t + ' · 当前配置：' + active;
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
      if (!x || !(x.key || x.id || x.name)) continue;
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
    if (rate) S.rate = Number(rate) || S.rate;
    syncToggles();
  }

  function configKeyOf(list, rate) {
    return JSON.stringify({
      fusion_rate: Number(rate) || 0,
      sources: (S.sources || []).map((x) => ({
        id: String(x.id || ''), rate: Number(x.rate) || 0,
      })),
      signals: (list || []).map((x) => ({
        id: String(x.localId || x.id || x.name || ''),
        key: String(x.key || x.id || ''),
        source: String(x.source || ''),
        name: String(x.name || x.id || ''),
        addr: Number(x.addr) >>> 0,
        size: Number(x.size) || 4,
        signed: !!x.signed,
        bit: Array.isArray(x.bit) ? [Number(x.bit[0]), Number(x.bit[1])] : null,
        float: !!x.float,
        scale: Number(x.scale ?? 1),
        offset: Number(x.offset ?? 0),
        unit: x.unit !== undefined ? String(x.unit || '') : '',
        color: String(x.color || ''),
        step: !!x.step,
        role: x.role === 'support' ? 'support' : (x.role === 'write' ? 'write' : 'signal'),
      })),
    });
  }

  function adoptSharedConfig(list, rate, opts = {}) {
    const pushLocal = opts.pushLocal !== false;
    const incoming = (list || []).filter((x) => x && (x.key || x.id || x.name));
    const prev = new Map(S.rows);
    const prevChannelKey = S.lastChannelKey || '';
    const incomingKey = configKeyOf(incoming, rate);
    S.rows.clear();
    for (const item of incoming) {
      const itemKey = String(item.key || item.id || item.name || '');
      const was = prev.get(itemKey) || prev.get(String(item.id || ''));
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
    // 保留本地“已选择但表/波/写全关”的行：它们不在采样集里，但用户仍要能在
    // 已选择列表里重新打开，不能因为共享 config 里没有采样列就被清掉。
    for (const [id, row] of prev) {
      if (S.rows.has(id)) continue;
      const inWrite = !!writeModForRow(id);
      const used = S.virtuals.some((v) => v.sourceIds.indexOf(id) >= 0);
      if (!row.table && !row.plot && !row.writeOnly && !inWrite && !row.support &&
          row.configRole !== 'write' && row.configRole !== 'support' && !used) {
        S.rows.set(id, row);
      }
    }
    if (rate) S.rate = Number(rate) || S.rate;
    if (D.rateSel) D.rateSel.value = String(S.rate);
    ensureWaveGroups();
    ensureWriteMods();
    syncChannels();
    const channelKey = S.signals.map((s) => s.id + (s.float ? ':f' : ':i')).join('|');
    const channelChanged = channelKey !== prevChannelKey;
    renderCatalog();
    renderSelected();
    renderLegend();
    renderValueTable();
    renderWriteMods();
    syncToggles();
    updateEmptyHint();
    if (channelChanged) { S.samples = []; S.lastT = 0; resetChartTimeline(); }
    S.lastConfigKey = incomingKey;
    S.configDirty = false;
    S.profileConfigRestored = false;   // 当前通道来自服务器共享集，不是机型存档
    saveLocal();
    sendViewState(true);
    loadHistory();
    S.dirty = true;
    // 本地写入模块可能补充了共享集之外的通道；如果本地监视集与服务器不同，主动补发一次
    if (pushLocal && monitorKey() !== incomingKey) sendConfig(true);
  }

  function monitorConfigPayload() {
    return {
      fusion_rate: S.rate,
      sources: (S.sources || []).map((s) => ({ id: s.id, rate: Number(s.rate) || 0 })),
      // 共享采样集：只有勾选表/波/支撑（或 AVG 支撑）的行才会进入这里
      signals: S.signals.map((s) => ({
        id: s.localId || s.id, key: s.id, source: s.source,
        name: s.name, addr: s.addr, size: s.size, signed: s.signed,
        bit: s.bit, float: !!s.float, scale: s.scale, offset: s.offset, unit: s.unit,
        color: s.color, step: s.step,
        role: s.configRole || (s.support ? 'support' : (s.writeOnly ? 'write' : 'signal')),
      })),
    };
  }

  function monitorKey() {
    return configKeyOf(S.signals, S.rate);
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
      const key = configKeyOf(payload.signals, payload.fusion_rate);
      if (!force && key === S.lastConfigKey) return;
      // 防止配置回显/字段不一致导致无限 POST：2 秒内最多 8 次
      const now = Date.now();
      if (!S.configBurst || now - S.configBurst.t > 2000) {
        S.configBurst = { t: now, n: 0 };
      }
      S.configBurst.n += 1;
      if (S.configBurst.n > 8) {
        console.warn('config burst guard tripped; skip send');
        return;
      }
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
        autoZero: !!S.autoZero, fillOn: S.fillOn !== false, smoothOn: S.smoothOn !== false, renderMode: S.renderMode,
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
      S.smoothOn = c.smoothOn !== false;
      if (typeof c.renderMode === 'string') S.renderMode = c.renderMode;
      S.smoothOn = S.renderMode !== 'classic';
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

  // API（/api/wave/groups/*）改了分组/颜色：所有页面即时同步。
  function applyWaveGroupsEvent(msg) {
    if (!msg) return;
    if (msg.profile && S.profiles.active && msg.profile !== S.profiles.active) return;
    if (!S.wave || !Array.isArray(S.wave.groups)) {
      S.wave = { groups: [{ id: 'default', name: '默认分组', visible: true, auto: true }], seq: 1 };
    }
    const groups = Array.isArray(msg.groups) ? msg.groups : [];
    if (groups.length) {
      S.wave.groups = groups.map((g) => ({
        id: String(g.id), name: String(g.name || g.id),
        visible: g.visible !== false, auto: !!g.auto,
      }));
      S.wave.seq = Math.max(1, ...S.wave.groups.map(
        (g) => Number(String(g.id).replace(/\D/g, '')) || 0));
    }
    const rows = (msg.rows && typeof msg.rows === 'object') ? msg.rows : {};
    const colors = (msg.colors && typeof msg.colors === 'object') ? msg.colors : {};
    for (const [id, gid] of Object.entries(rows)) {
      const row = S.rows.get(id);
      if (row) row.groupId = String(gid);
      const v = S.virtuals.find((x) => x.id === id);
      if (v) v.groupId = String(gid);
      const c = colors[id];
      if (c) {
        if (row) row.color = String(c);
        if (v) v.color = String(c);
      }
    }
    ensureWaveGroups();
    renderCatalog();
    renderSelected();
    renderLegend();
    updateEmptyHint();
    S.dirty = true;
    saveLocal();
    scheduleProfileSave();
    toast('波形分组已更新（API）', 'ok');
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
        applySourceRates(msg.config?.sources);
        if (msg.config && msg.config.signal_flags) {
          applySignalFlags(msg.config.signal_flags);
        }
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
        } else if (clients <= 1 && S.rows.size && S.profileConfigRestored) {
          // 当前机型有本地 config.json：以它为权威推给服务器。否则服务端上一
          // 次的共享采样集会把该机型的存档覆盖成同一套（页面一开就“变回去”）。
          sendConfig(true).then(loadHistory);
        } else if (clients <= 1 && S.rows.size) {
          // 本地没有机型存档时才采用服务端当前采样集。
          const serverActive = sourceConnected(msg.status?.source) &&
            !(msg.status?.sampler && msg.status.sampler.error);
          if (serverActive && shared.length) {
            adoptSharedConfig(shared, msg.config?.rate, { pushLocal: false });
          } else {
            sendConfig(true).then(loadHistory);
          }
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
        applySourceRates(msg.config?.sources);
        adoptSharedConfig(msg.config?.signals || [], msg.config?.rate);
      } else if (msg.type === 'presence') {
        updatePresence(msg.presence);
      } else if (msg.type === 'status') {
        applyStatus(msg.status);
      } else if (msg.type === 'flags') {
        applySignalFlags(msg.flags || {});
      } else if (msg.type === 'wave_groups') {
        applyWaveGroupsEvent(msg);
      } else if (msg.type === 'catalog') {
        // 外部 API 更新了 AXF/SVD 并重建了当前机型：所有页面同步符号表
        if (msg.profiles) {
          S.profiles.items = msg.profiles.items || S.profiles.items;
          S.profiles.active = msg.profiles.active || S.profiles.active;
        }
        if (msg.profile) {
          S.arch = msg.profile.arch === 'riscv' ? 'riscv' : 'cw32';
          S.mcu.expected = String(msg.profile.mcu || S.mcu.expected || '');
          S.mcu.manual = false;
          syncArchUI();
        }
        if (msg.catalog) applyCatalog(msg.catalog, '机型符号表已更新（AXF/SVD）');
        renderMachines();
        updateProjectUI();
        renderCards();
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
      if (S.displaySince > 0 && Number(s[0]) <= S.displaySince) continue;
      const vals = s[1] || [];
      // 配置切换期间服务端还可能吐旧列数的样本，丢掉避免列错位
      if (!S.signals.length || vals.length !== S.signals.length) continue;
      if (!map.has(s[0])) map.set(s[0], [Number(s[0]), vals]);
    }
    const arr = Array.from(map.values()).sort((a, b) => a[0] - b[0]);
    S.samples = arr;
    S.measure.key = '';
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
      if (S.displaySince > 0 && t <= S.displaySince) continue;
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
    if (row.float || /^float/i.test(row.type || '')) return fmtFloat(v);
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
  function fmtTableNum(v, row = null) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    if (row && (row.float || /^float/i.test(row.type || ''))) return fmtFloat(v);
    const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
    return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function rowTableText(row, vals) {
    return fmtTableNum(rowValue(row, vals), row);
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
        setTableNum(vt.cur, fmtTableNum(rawValue(row, vals), row), 'num vt-cur');
        vt.cur.title = row.name + ' · ' + hex(row.addr) + '（原始）';
        if (vt.conv) {
          setTableNum(vt.conv, isCalibrated(row) ? fmtTableNum(convertedValue(row, rawValue(row, vals)), row) : '-', 'num vt-conv');
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
        setTableNum(vt.cur, fmtTableNum(rawValue(v, vals), v), 'num vt-cur');
        if (vt.conv) setTableNum(vt.conv, isCalibrated(v) ? fmtTableNum(convertedValue(v, rawValue(v, vals)), v) : '-', 'num vt-conv');
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
      setTableNum(vt.min, n ? fmtTableNum(mn, row) : '--', 'num vt-stat');
      setTableNum(vt.max, n ? fmtTableNum(mx, row) : '--', 'num vt-stat');
      setTableNum(vt.avg, n ? fmtTableNum(sum / n, row) : '--', 'num vt-stat');
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

  function applySourceRates(list) {
    for (const item of list || []) {
      if (!item || !item.id) continue;
      const cur = sourceInfo(item.id);
      if (cur && item.rate != null) cur.rate = Number(item.rate) || cur.rate;
    }
  }

  function resumeOnConnect() {
    if (S.paused) {
      S.paused = false;
      updatePauseUI();
    }
  }

  function applyStatus(st) {
    if (!st) return;
    S.status = st;
    if (Array.isArray(st.sources)) S.sources = st.sources;
    if (st.primary) S.primarySource = String(st.primary);
    if (!S.activeSource || !sourceInfo(S.activeSource)) {
      S.activeSource = S.primarySource || (S.sources[0] && S.sources[0].id) || '';
    }
    S.sources = S.sources || [];
    renderSourceHeros();
    renderSourceChips();
    const up = Number(st.uptime) || 0;
    if (S.serverUptime > 0 && up + 1 < S.serverUptime) {
      // 服务重启: 时间轴/游标全部作废, 清掉旧样本再重新拉
      S.samples = [];
      S.lastT = 0;
      S.displaySince = 0;
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
    updateConnPill();
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
      const reg = m.register_table ? ' · 寄存器表 ' + m.register_table : '';
      D.catalogMeta.textContent = 'AXF ' + (m.generated_at || '?') + ' · ' +
        (st.catalog.counts?.variables || 0) + ' 变量 / ' +
        (st.catalog.counts?.peripherals || 0) + ' 外设 · ' +
        stripStamp(m.axf || '') + reg;
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
    const payload = { mode, source: S.activeSource || S.primarySource || '' };
    if (mode === 'openocd') {
      const activeSrc = sourceInfo(S.activeSource);
      const conn = (activeSrc && activeSrc.connection) || {};
      payload.arch = (activeSrc && activeSrc.arch) || S.arch;
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
      const editing = S.ui.panel === 'source';
      const p = String((editing && $('#inpOcd')?.value) || conn.openocd || '').trim();
      if (p) payload.openocd = p;
      // 选中的具体调试器：serial 精确指定用哪一个（同款多设备），
      // iface/target 覆盖默认 cfg（'' = 跟随 profile/OpenOCD 默认）
      const iface = String((editing && D.inpIface?.value) || conn.iface || '').trim();
      const target = String((editing && D.inpTarget?.value) || conn.target || '').trim();
      if (iface) payload.iface = iface;
      else if (S.usb.iface) payload.iface = S.usb.iface;
      if (target) payload.target = target;
      if (conn.serial) payload.serial = conn.serial;
      else if (S.usb.serial) payload.serial = S.usb.serial;
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
      resumeOnConnect();
      toast('已连接: ' + (mode === 'sim' ? '仿真' : mode === 'attach' ? 'TCL' : 'OpenOCD'), 'ok');
      await loadSources();
      await loadCatalog(S.activeSource);
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
      const sid = S.activeSource || S.primarySource || '';
      if (sid) await post('/api/sources/' + encodeURIComponent(sid) + '/disconnect', {});
      else await post('/api/disconnect', {});
      disarmWrite('已断开，写入已锁定');
      // 主动断开时不要把“连接目标”弹窗又顶出来
      S.ui.overlayDismissed = true;
      S.lastChipKey = '';
      applyChip(null);
      toast('已断开，调试器已释放', 'ok');
      await loadSources();
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

  // ---------------------------------------------------------------- 多输入源 UI
  function renderSourceHeros() {
    const box = D.sourceHeroes;
    if (!box) return;
    const uiKey = JSON.stringify((S.sources || []).map((x) => [
      x.id, x.label, x.kind, x.profile, x.profile_name, x.mcu, x.rate,
      x.rate_actual, x.connected, x.error, x.color,
    ])) + '|' + S.activeSource;
    if (uiKey === S.sourceHeroKey) return;
    S.sourceHeroKey = uiKey;
    box.innerHTML = '';
    const multi = (S.sources || []).length > 1;
    for (const src of S.sources || []) {
      const el = document.createElement('div');
      const connected = !!src.connected;
      el.className = 'source-hero' + (src.id === S.activeSource ? ' active' : '') +
        (connected ? '' : ' off');
      el.dataset.source = src.id;
      el.style.setProperty('--src', src.color || '#22d3ee');
      const state = src.error ? ('错误: ' + brief(src.error)) : (connected ? '已连接' : '等待连接');
      const stateCls = src.error ? 'err' : (connected ? 'ok' : '');
      const rate = fmtAxis(src.rate_actual || src.rate || 0);
      const prof = src.profile_name || src.profile || '—';
      const mcu = src.mcu ? (' · ' + src.mcu) : '';
      el.innerHTML =
        '<div class="sh-top"><span class="sh-dot"></span>' +
        '<span class="sh-name" title="' + esc(src.label || src.id) + '">' + esc(src.label || src.id) + '</span>' +
        '<span class="sh-kind">' + esc(src.kind || '?') + '</span></div>' +
        '<div class="sh-meta">' + esc(prof + mcu + ' · ' + rate + ' Hz') + '</div>' +
        '<div class="sh-foot"><span class="sh-state ' + stateCls + '" title="' + esc(state) + '">' +
        esc(state) + '</span><span class="sh-actions">' +
        '<button class="sh-btn" data-src-act="connect">' + (connected ? '断开' : '连接') + '</button>' +
        '<button class="sh-btn" data-src-act="edit" title="编辑当前源连接">编辑</button>' +
        (multi ? '<button class="sh-btn danger" data-src-act="remove" title="移除该输入源">×</button>' : '') +
        '</span></div>';
      box.appendChild(el);
    }
  }

  function renderSourceChips() {
    const box = D.sourceChips;
    if (!box) return;
    const list = S.sources || [];
    const uiKey = JSON.stringify(list.map((x) => [x.id, x.label, x.color])) + '|' + S.activeSource;
    if (uiKey === S.sourceChipKey) return;
    S.sourceChipKey = uiKey;
    if (list.length <= 1) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    for (const src of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'source-chip' + (src.id === S.activeSource ? ' active' : '');
      b.style.setProperty('--src', src.color || '#22d3ee');
      b.dataset.source = src.id;
      b.innerHTML = '<span class="sdot"></span>' + esc(src.label || src.id);
      box.appendChild(b);
    }
  }

  function openSourceAdd() {
    if (!D.srcAddProfile) return;
    const items = S.profiles.items || [];
    D.srcAddProfile.innerHTML = '<option value="">请选择工程 / 机型…</option>';
    for (const p of items) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.id + (p.mcu ? ' · ' + p.mcu : '');
      D.srcAddProfile.appendChild(o);
    }
    const preferred = String(S.profiles.active || (items[0] && items[0].id) || '');
    if (preferred) D.srcAddProfile.value = preferred;
    if (D.srcAddMcu) {
      D.srcAddMcu.innerHTML = '<option value="">自动（从 SVD / AXF 推断）</option>';
      const seen = new Set();
      for (const m of S.mcu.models || []) {
        const id = String(m.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const o = document.createElement('option');
        o.value = id;
        o.textContent = id + (m.vendor ? ' · ' + m.vendor : '');
        D.srcAddMcu.appendChild(o);
      }
    }
    if (D.srcAddSerial) {
      D.srcAddSerial.innerHTML = '<option value="">自动（OpenOCD 自选）</option>';
      for (const d of S.usb.devices || []) {
        if (!d || !d.serial) continue;
        const o = document.createElement('option');
        o.value = d.serial;
        o.textContent = devLabel(d) || d.name || d.serial;
        D.srcAddSerial.appendChild(o);
      }
    }
    if (D.srcAddLabel) D.srcAddLabel.value = '';
    if (D.srcAddRate) D.srcAddRate.value = String(S.rate || 100);
    if (D.srcAddKind) D.srcAddKind.value = 'openocd';
    if (D.srcAddAxf) D.srcAddAxf.value = '';
    if (D.srcAddTable) D.srcAddTable.value = '';
    if (D.srcAddOcd) D.srcAddOcd.value = String($('#inpOcd')?.value || '').trim();
    if (D.srcAddIface) D.srcAddIface.innerHTML = '<option value="">跟随机型 / 自动</option>';
    if (D.srcAddTarget) D.srcAddTarget.innerHTML = '<option value="">跟随机型 / 自动</option>';
    syncSourceAddFields();
    refreshAddOcdConfigs();
    togglePanel('sourceAdd');
  }

  function syncSourceAddFields() {
    const kind = D.srcAddKind ? D.srcAddKind.value : 'openocd';
    if (D.srcAddAttach) D.srcAddAttach.classList.toggle('hidden', kind !== 'attach');
    if (D.srcAddOpenocd) D.srcAddOpenocd.classList.toggle('hidden', kind !== 'openocd');
  }

  function ocdBaseName(path) {
    return String(path || '').split(/[\\/]/).pop() || String(path || '');
  }

  function fillOcdSelect(sel, items, current) {
    if (!sel) return;
    const val = String(current || '');
    sel.innerHTML = '<option value="">跟随机型 / 自动</option>';
    let found = false;
    for (const it of items || []) {
      const p = String(it.path || it.name || '');
      if (!p) continue;
      const o = document.createElement('option');
      o.value = p;
      o.textContent = it.name || ocdBaseName(p);
      sel.appendChild(o);
      if (p === val) found = true;
    }
    if (val && !found) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = ocdBaseName(val) + '（自定义）';
      sel.appendChild(o);
    }
    sel.value = val;
  }

  async function loadOcdConfigList(root, arch, ifaceSel, targetSel, currentIface, currentTarget) {
    const key = String(root || '') + '|' + String(arch || '');
    let data = S.ocdConfigs.get(key);
    if (!data) {
      try {
        data = await fetchJSON('/api/openocd/configs?root=' + encodeURIComponent(root || '') +
          '&arch=' + encodeURIComponent(arch || ''));
        S.ocdConfigs.set(key, data);
      } catch (e) {
        data = { ok: false, error: e.message, interfaces: [], targets: [] };
      }
    }
    fillOcdSelect(ifaceSel, data.interfaces || [], currentIface);
    fillOcdSelect(targetSel, data.targets || [], currentTarget);
    return data;
  }

  function syncSourceConnectionUI() {
    const src = sourceInfo(S.activeSource);
    const conn = (src && src.connection) || {};
    if (D.inpOcd) D.inpOcd.value = String(conn.openocd || '');
    loadOcdConfigList(conn.openocd || '', (src && src.arch) || S.arch,
      D.inpIface, D.inpTarget, conn.iface || '', conn.target || '');
  }

  function refreshAddOcdConfigs() {
    const root = String(D.srcAddOcd?.value || '').trim();
    loadOcdConfigList(root, S.arch || 'cw32', D.srcAddIface, D.srcAddTarget,
      D.srcAddIface?.value || '', D.srcAddTarget?.value || '');
  }

  async function submitSourceAdd(connect) {
    const label = String(D.srcAddLabel?.value || '').trim();
    const profile = String(D.srcAddProfile?.value || '').trim();
    let rate = Number(D.srcAddRate?.value || S.rate || 100);
    if (!Number.isFinite(rate)) rate = 100;
    // “新增信号”：只认第 1 步的工程/机型，忽略连接/AXF/SVD/序列号等所有填项。
    if (!connect) {
      if (!profile) {
        toast('请先选择工程 / 机型；“新增信号”只按工程创建', 'err');
        return;
      }
      try {
        const res = await post('/api/sources', {
          label: label || profile, kind: 'openocd', profile, rate,
          connection: {},
        });
        if (!res.ok) throw new Error(res.error || '创建失败');
        const sid = String(res.source?.id || '');
        await loadSources();
        if (sid) {
          await loadCatalog(sid);
          await selectSource(sid);
        }
        closePanels();
        toast('已新增信号源: ' + (label || profile), 'ok');
      } catch (e) {
        toast('新增信号源失败: ' + brief(e.message), 'err');
      }
      return;
    }
    const kind = String(D.srcAddKind?.value || 'openocd');
    const mcu = String(D.srcAddMcu?.value || '').trim();
    const serial = String(D.srcAddSerial?.value || '').trim();
    const axf = D.srcAddAxf?.files?.[0] || null;
    const table = D.srcAddTable?.files?.[0] || null;
    const addOcd = String(D.srcAddOcd?.value || '').trim();
    const addIface = String(D.srcAddIface?.value || '').trim();
    const addTarget = String(D.srcAddTarget?.value || '').trim();
    const connection = kind === 'attach' ? {
      host: String(D.srcAddHost?.value || '127.0.0.1').trim(),
      port: Number(D.srcAddPort?.value || 6666),
    } : {};
    if (kind === 'openocd') {
      if (serial) connection.serial = serial;
      if (addOcd) connection.openocd = addOcd;
      if (addIface) connection.iface = addIface;
      if (addTarget) connection.target = addTarget;
    }
    let sid = '';
    try {
      if (axf) {
        const fd = new FormData();
        fd.append('axf', axf, axf.name || 'firmware.axf');
        if (table) fd.append('table', table, table.name || 'registers.svd');
        fd.append('name', label || importLabelOf(axf.name));
        fd.append('mcu', mcu);
        fd.append('kind', kind);
        fd.append('rate', String(rate));
        if (serial) fd.append('serial', serial);
        if (kind === 'openocd') {
          if (addOcd) fd.append('openocd', addOcd);
          if (addIface) fd.append('iface', addIface);
          if (addTarget) fd.append('target', addTarget);
        }
        if (kind === 'attach') {
          fd.append('host', connection.host);
          fd.append('port', String(connection.port));
        }
        const resp = await fetch('/api/sources/import', { method: 'POST', body: fd });
        const data = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status }));
        if (!resp.ok || !data.ok) throw new Error(data.error || '导入失败');
        if (data.profiles) {
          S.profiles.items = data.profiles.items || S.profiles.items;
          S.profiles.active = data.profiles.active || S.profiles.active;
        }
        sid = String(data.source?.id || '');
      } else if (profile) {
        const res = await post('/api/sources', {
          label: label || (kind === 'attach' ? 'TCL 源' : kind === 'sim' ? '仿真源' : profile),
          kind, profile, rate, connection,
        });
        if (!res.ok) throw new Error(res.error || '创建失败');
        sid = String(res.source?.id || '');
      } else {
        toast('请选择 AXF/ELF，或选择一个已有芯片配置', 'err');
        return;
      }
      await loadSources();
      if (sid) {
        await loadCatalog(sid);
        await selectSource(sid);
      }
      closePanels();
      if (connect && sid) {
        await connectOneSource(sid);
      } else {
        toast('已新增信号源: ' + (label || sid), 'ok');
      }
      if (D.srcAddAxf) D.srcAddAxf.value = '';
      if (D.srcAddTable) D.srcAddTable.value = '';
    } catch (e) {
      toast('新增信号源失败: ' + brief(e.message), 'err');
    }
  }

  function sourceConnectPayload(src) {
    const mode = src.kind || 'openocd';
    const payload = { mode, source: src.id };
    if (mode === 'attach') {
      const conn = src.connection || {};
      payload.host = conn.host || String($('#inpAttachHost')?.value || '127.0.0.1').trim();
      payload.port = Number(conn.port || $('#inpAttachPort')?.value || 6666);
    } else if (mode === 'openocd') {
      const conn = src.connection || {};
      const isActive = src.id === S.activeSource;
      payload.arch = src.arch || S.arch;
      const p = String((isActive && $('#inpOcd')?.value) || conn.openocd || '').trim();
      if (p) payload.openocd = p;
      const target = (isActive && D.inpTarget?.value) || conn.target || '';
      if (target) payload.target = target;
      const iface = (isActive && D.inpIface?.value) || conn.iface || '';
      if (iface) payload.iface = iface;
      else if (S.usb.iface) payload.iface = S.usb.iface;
      if (conn.serial) payload.serial = conn.serial;
      else if (S.usb.serial) payload.serial = S.usb.serial;
    }
    return payload;
  }

  async function connectOneSource(sid) {
    const src = sourceInfo(sid);
    if (!src) return;
    S.activeSource = sid;
    renderSourceHeros();
    try {
      const res = await post('/api/sources/' + encodeURIComponent(sid) + '/connect',
        sourceConnectPayload(src), { timeout: 30000 });
      if (!res.ok) throw new Error(res.error || '连接失败');
      disarmWrite('');
      resumeOnConnect();
      await loadSources();
      await refreshStatus();
      await sendConfig(true);
      toast('已连接输入源: ' + (src.label || sid), 'ok');
    } catch (e) {
      toast('连接失败: ' + brief(e.message), 'err');
      await loadSources();
    }
  }

  async function disconnectOneSource(sid) {
    try {
      await post('/api/sources/' + encodeURIComponent(sid) + '/disconnect', {});
      disarmWrite('已断开，写入已锁定');
      await loadSources();
      await refreshStatus();
      toast('已断开输入源: ' + (sourceInfo(sid)?.label || sid), 'ok');
    } catch (e) {
      toast('断开失败: ' + brief(e.message), 'err');
    }
  }

  async function removeOneSource(sid) {
    const src = sourceInfo(sid);
    if (!src) return;
    if (!confirm('移除输入源“' + (src.label || sid) + '”？该源选中的信号会从采样列里移除。')) return;
    try {
      const res = await fetchJSON('/api/sources/' + encodeURIComponent(sid), { method: 'DELETE' });
      if (!res.ok) throw new Error(res.error || '删除失败');
      if (S.activeSource === sid) S.activeSource = '';
      await loadSources();
      await loadCatalog();
      await selectSource(S.activeSource);
      await refreshStatus();
      toast('已移除输入源: ' + (src.label || sid), 'ok');
    } catch (e) {
      toast('移除失败: ' + brief(e.message), 'err');
    }
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
    hint.textContent = '本端 ' + (S.clientLabel || '?') + ' · 共享 ' + ((S.presence && S.presence.length) || 1) + ' 端 · 表/波/支撑决定采样；写不参与 · 拖动行 = 共享轴';
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
        nm.textContent = rowDisplayName(row);
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
    const sid = activeSourceId();
    const vars = (S.catalog.variables || []).map((v) =>
      S.index.get(srcKey(v.name, sid)) || v);
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
    const sid = activeSourceId();
    const vars = (S.catalog.variables || []).map((v) =>
      S.index.get(srcKey(v.name, sid)) || v);
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
        const rid = srcKey(p.name + '.' + r.name);
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
        const rid = srcKey(p.name + '.' + r.name);
        const hasBits = (r._bits || []).length > 0;
        const regOpen = !!q || S.ui.openRegs.has(rid) || r._autoOpen;
        const blockDiv = document.createElement('div');
        blockDiv.className = 'reg-block' + (regOpen ? ' open' : '');
        blockDiv.dataset.reg = rid;
        const entry = {
          id: rid, localId: p.name + '.' + r.name, source: activeSourceId(),
          name: rid, addr: r.addr, size: r.size || 4,
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
              id: bid, localId: p.name + '.' + r.name + '.' + b.name,
              source: activeSourceId(), name: bid, addr: r.addr, size: r.size || 4,
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
      nm.textContent = rowDisplayName(row);
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
      chip.querySelector('.lname').textContent = rowDisplayName(row);
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
    if (D.legendRow) D.legendRow.hidden = !box.children.length;
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
      nm.textContent = rowDisplayName(row);
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
    S.paneRanges.clear();
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
  const TL_OVERVIEW_MS = 2 * 60 * 1000;

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

  // 页面恢复成 overview 但用户还没动过时间轴：默认显示最近 2 分钟，
  // 不再自动铺满整段历史；要看更早的用时间轴 «10m。
  function syncAutoFullRange() {
    if (S.chartFollow || !S.chartAutoFull) return;
    const bounds = timelineBounds();
    if (!bounds) return;
    const span = Math.min(TL_OVERVIEW_MS, Math.max(500, bounds.span));
    S.chartRange = { start: Math.max(bounds.first, bounds.last - span), end: bounds.last };
    if (Math.abs(S.windowSec - span / 1000) > 0.5) syncWindowSecFromRange();
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

  function fullscreenState() {
    const hero = !!S.chartFull;
    const writeHidden = !!(S.ui.sections && S.ui.sections.write === false);
    if (!hero && !writeHidden) return 0;
    if (hero && !writeHidden) return 1;
    if (hero && writeHidden) return 2;
    return 3;
  }

  function syncChartFullUI() {
    const state = fullscreenState();
    document.body.classList.toggle('hero-hidden', !!S.chartFull);
    if (!D.btnChartFull) return;
    D.btnChartFull.classList.toggle('active', state !== 0);
    D.btnChartFull.setAttribute('aria-pressed', state !== 0 ? 'true' : 'false');
    const titles = [
      '全屏波形（隐藏顶部卡片）；再按收起写分区',
      '顶部已收起；再按同时收起写分区',
      '顶部+写分区已收起；再按恢复顶部、保留写收起',
      '写分区已收起；再按全部恢复',
    ];
    const labels = ['全屏', '顶部收起', '顶+写', '写收起'];
    D.btnChartFull.title = titles[state];
    const label = D.btnChartFull.querySelector('.cf-label');
    if (label) label.textContent = labels[state];
  }

  function setFullscreenState(state) {
    const s = ((Number(state) || 0) % 4 + 4) % 4;
    S.chartFull = s === 1 || s === 2;
    if (!S.ui.sections) S.ui.sections = { chart: true, table: true, write: true };
    S.ui.sections.write = !(s === 2 || s === 3);
    syncSections();
    syncChartFullUI();
    saveLocal();
    requestAnimationFrame(() => { try { resizeChart(); } catch {} });
  }

  function cycleChartFull() {
    setFullscreenState((fullscreenState() + 1) % 4);
  }

  function syncChartModeUI() {
    if (!D.timelineBar || !D.tlMode) return;
    const overview = !S.chartFollow;
    D.timelineBar.dataset.mode = overview ? 'overview' : 'follow';
    D.tlMode.classList.toggle('overview', overview);
    if (D.tlModeText) D.tlModeText.textContent = overview ? '整体' : '跟随';
    D.tlMode.setAttribute('aria-pressed', overview ? 'true' : 'false');
    D.tlMode.title = overview
      ? '整体历史（默认最近 2 分钟；点«10m 往前扩，点击回到跟随实时）'
      : '跟随实时（点击查看整体历史，默认最近 2 分钟）';
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
    S.paneRanges.clear();
    setChartRightLock(false);
    if (follow) {
      S.chartRange = null;
      S.chartAutoFull = false;
    } else {
      const bounds = timelineBounds();
      // 整体：默认最近 2 分钟，不再一上来铺满整段 50 分钟历史；
      // 要看更早的，用时间轴的 «10m 往前扩。
      const span = bounds ? Math.min(TL_OVERVIEW_MS, Math.max(500, bounds.span)) : TL_OVERVIEW_MS;
      S.chartRange = bounds ? { start: Math.max(bounds.first, bounds.last - span), end: bounds.last } : null;
      S.chartAutoFull = !bounds;
      ensureChartRange();
      syncWindowSecFromRange();
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

  // 从服务器同步：只读，不把本地配置反推回服务器。
  // 刷新页面后服务端通常仍在采样；这里重新对齐 config/catalog，并加载整段缓存。
  let syncServerBusy = false;
  async function syncFromServer() {
    if (syncServerBusy) return;
    syncServerBusy = true;
    const btn = D.btnSyncServer;
    const label = btn ? btn.querySelector('.btn-label') : null;
    const old = label ? label.textContent : '同步';
    if (btn) btn.disabled = true;
    if (label) label.textContent = '同步中';
    toast('正在从服务器同步…');
    try {
      const st = await fetchJSON('/api/status', { timeout: 12000 });
      applyStatus(st);
      S.displaySince = 0;
      // AXF 可能被 API 更新过：先对齐服务端 catalog，再同步采样配置
      try {
        const cat = await fetchJSON('/api/catalog', { timeout: 12000 });
        if (cat && Array.isArray(cat.variables)) {
          S.catalog = cat;
          S.mcu.expected = String(cat.meta?.mcu || S.mcu.expected || '');
          buildIndex();
          adoptExpectedMcu();
        }
      } catch {}
      const cfg = (st && st.config) || {};
      const list = Array.isArray(cfg.signals) ? cfg.signals : [];
      if (list.length) adoptSharedConfig(list, cfg.rate, { pushLocal: false });
      if (st.record) S.record = st.record;
      renderRecordPanel();
      // 切到整体视图，优先用服务端整段缓存；没有缓存时 history 仍可显示
      S.chartFollow = false;
      S.chartAutoFull = true;
      S.chartRange = null;
      S.cacheSamples = null;
      S.cacheRange = null;
      S.tlUiKey = '';
      await refreshCacheInfo(true);
      syncAutoFullRange();
      await loadCacheWindow();
      await loadHistory();
      syncChartModeUI();
      updateViewSeg();
      syncTablePanel();
      syncSections();
      updateProjectUI();
      renderMachines();
      renderCards();
      saveLocal();
      S.dirty = true;
      const points = Math.max(S.samples.length, Number(S.cacheInfo?.count || 0));
      toast('已从服务器同步：' + ((list.length || S.signals.length) || 0) + ' 路 · ' +
        (points ? points + ' 点' : '暂无数据') +
        (S.cacheInfo?.session ? ' · 缓存 ' + S.cacheInfo.session : ''), 'ok');
    } catch (e) {
      toast('同步失败: ' + brief(e.message), 'err');
    } finally {
      syncServerBusy = false;
      if (btn) btn.disabled = false;
      if (label) label.textContent = old || '同步';
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
    S.paneRanges.clear();
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

    // overview：窗口整体可拖动平移；左右手柄单独调窗口边界。
    if (inWindow && !handle) {
      e.preventDefault();
      const cur = ensureChartRange();
      if (!cur) return;
      setChartRightLock(false);
      S.chartAutoFull = false;
      S.tlDrag = {
        mode: 'move', startT: t, origStart: cur.start, origEnd: cur.end,
        pointerId: e.pointerId, moved: false,
      };
      try { D.tlRail.setPointerCapture(e.pointerId); } catch {}
      S.dirty = true;
      return;
    }
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
    S.paneRanges.clear();
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
    if (drag.mode === 'move') {
      const len = Math.max(1, drag.origEnd - drag.origStart);
      const s = clamp(drag.origStart + (t - drag.startT),
        bounds.first, Math.max(bounds.first, bounds.last - len));
      S.chartRange = { start: s, end: s + len };
      S.paneRanges.clear();
      if (Math.abs(t - drag.startT) > 0.5) drag.moved = true;
      scheduleCacheWindow(140);
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
    return Math.exp(d * 0.0008);
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
    S.paneRanges.clear();
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
      S.paneRanges.clear();
      scheduleCacheWindow(80);
      return;
    }
    const c = (cur.start + cur.end) / 2;
    const s = clamp(c - len / 2, bounds.first, Math.max(bounds.first, bounds.last - len));
    S.chartRange = { start: s, end: s + len };
    S.paneRanges.clear();
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

  // 长录制历史翻页：每次按 10 分钟读一段，可连续往前/往后。
  const TL_PAGE_MS = 10 * 60 * 1000;

  function applyChartPage(start, end) {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    let s = clamp(Number(start) || bounds.first, bounds.first, bounds.last);
    let e = clamp(Number(end) || bounds.last, bounds.first, bounds.last);
    if (e < s) { const t = s; s = e; e = t; }
    if (e - s < 500) return;
    S.chartFollow = false;
    S.chartAutoFull = false;
    setChartRightLock(false);
    S.chartRange = { start: s, end: e };
    S.paneRanges.clear();
    S.tlDrag = null;
    syncWindowSecFromRange();
    syncChartModeUI();
    scheduleCacheWindow(80);
    scheduleTimelineSave();
    S.dirty = true;
  }

  function pageChartBack() {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    const cur = S.chartFollow
      ? {
          start: Math.max(bounds.first, bounds.last - TL_OVERVIEW_MS),
          end: bounds.last,
        }
      : ensureChartRange();
    if (!cur) return;
    // 往左扩 10 分钟：2 分钟窗口 → 12 分钟，再点 → 22 分钟，直到缓存起点。
    const start = Math.max(bounds.first, cur.start - TL_PAGE_MS);
    if (cur.start - start < 500) {
      toast('已经到最早的历史', 'ok');
      return;
    }
    applyChartPage(start, cur.end);
  }

  function pageChartForward() {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    if (S.chartFollow) {
      toast('已经是最新实时窗口', 'ok');
      return;
    }
    const cur = ensureChartRange();
    if (!cur) return;
    // 起点往回收 10 分钟：12 分钟 → 2 分钟；不足 10 分钟时收到最近 2 分钟。
    let start = cur.start + TL_PAGE_MS;
    if (start > cur.end - 500) start = Math.max(cur.start, cur.end - TL_OVERVIEW_MS);
    if (start - cur.start < 500) {
      toast('窗口已经是最近 2 分钟', 'ok');
      return;
    }
    applyChartPage(start, cur.end);
  }

  function pageChartLatest() {
    const bounds = timelineBounds();
    if (!bounds || bounds.span <= 0) return;
    const page = Math.min(TL_OVERVIEW_MS, Math.max(500, bounds.span));
    const start = Math.max(bounds.first, bounds.last - page);
    applyChartPage(start, bounds.last);
    setChartRightLock(true);
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
    return zoomFollowWindowByFactor(Math.exp(d * 0.0007));
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
    const unit = clamp(len * 0.01, 100, 1200);
    const step = (d / 100) * unit;
    if (S.chartRightLock && step < 0) setChartRightLock(false);
    const s = clamp(cur.start + step, bounds.first, Math.max(bounds.first, bounds.last - len));
    S.chartRange = { start: s, end: s + len };
    S.chartAutoFull = false;
    S.paneRanges.clear();
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
    S.paneRanges.clear();
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
        for (const r of rows) panes.push({ group: g, rows: [r], title: rowDisplayName(r), unit: r.unit || '' });
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

    // Y 轴自动量程做“快速扩张、缓慢收缩”的迟滞，避免窗口滚动时量程随
    // 每一帧的原始 min/max 抖动，导致均线看起来上下乱跳而不是平移。
    const seenPaneRanges = new Set();
    function stablePaneRange(key, target) {
      let st = S.paneRanges.get(key);
      if (!st) {
        st = { min: target.min, max: target.max };
      } else {
        const span = Math.max(1e-9, st.max - st.min);
        const now = performance.now();
        const margin = span * 0.01;
        const need = target.min < st.min - margin || target.max > st.max + margin;
        if (need) {
          st.min = Math.min(st.min, target.min);
          st.max = Math.max(st.max, target.max);
          st.holdUntil = now + 1500;
        } else if (!st.holdUntil || now > st.holdUntil) {
          // 目标在范围内时不要每帧追着原始毛刺缩放；等 1.5s 再缓慢收缩。
          st.min += (target.min - st.min) * 0.04;
          st.max += (target.max - st.max) * 0.04;
          if (Math.abs(target.min - st.min) < span * 0.004 &&
              Math.abs(target.max - st.max) < span * 0.004) {
            st.holdUntil = now + 1000;
          }
        }
        if (!(st.max > st.min)) { st.min = target.min; st.max = target.max; }
      }
      S.paneRanges.set(key, st);
      return { min: st.min, max: st.max };
    }
    for (let pi = 0; pi < panes.length; pi++) {
      const pane = panes[pi];
      pane.top = y0 + pi * (each + gap);
      pane.h = each;
      const paneUnits = new Set(pane.rows.map((r) => String(r.unit || '').trim()).filter(Boolean));
      pane.unit = paneUnits.size === 1 ? [...paneUnits][0] : '';
      const targetRange = axisRange(pane.rows, pane) || { min: 0, max: 1 };
      const rangeKey = pane.group.id + '|' + pane.rows.map((r) => r.id).join(',');
      seenPaneRanges.add(rangeKey);
      pane.range = stablePaneRange(rangeKey, targetRange);
      pane.Y = (v) => pane.top + pane.h - ((v - pane.range.min) / Math.max(1e-9, pane.range.max - pane.range.min)) * pane.h;
      pane.primary = pane.rows[0] || null;
    }
    for (const rangeKey of S.paneRanges.keys()) {
      if (!seenPaneRanges.has(rangeKey)) S.paneRanges.delete(rangeKey);
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
      const axisFmt = pane.rows.some((r) => r.float) ? fmtAxisFloat : fmtAxis;
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
        ctx.fillText(axisFmt(v), rightPane ? x0 + pw + 8 : x0 - 8, y);
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

    // 均线：对每个可见样本做 1~5s 因果滑动平均（窗口随像素/时长扩展），
    // 再按像素桶取样。滤波值只依赖历史样本，窗口滚动时不会被像素桶边界
    // 重新分组，所以均线是平移而不是持续抖动。
    const smoothCache = new Map();
    function smoothMean(row, pane) {
      if (!S.smoothOn || row.step || visibleSamples < 4) return null;
      // 可见窗口 <5 分钟：原始 min/max 抽稀已经能保留尖峰；均线只会把真实
      // 电流纹波/阶跃压平，并带来 1~5s 滞后。短窗一律回退原始。
      const winMs = end - start;
      if (!(winMs >= 5 * 60 * 1000)) return null;
      // 显示窗口内样本数不超过像素列数时，均线没有抽稀/抗混叠意义，自动关闭；
      // 否则短窗口会把真实尖峰/阶跃严重压扁。
      if (visibleSamples <= Math.max(8, Math.round(pw))) return null;
      const key = row.id + '|' + pane.top;
      if (smoothCache.has(key)) return smoothCache.get(key);
      // 先看相邻样本的屏幕像素差：平滑的锯齿/三角/阶跃不需要均线，
      // 只有真正的高频抖动/纹波才启用；这样不会把慢波形压扁。
      let prevY = null, stepSum = 0, stepN = 0;
      for (let i = i0; i < i1; i++) {
        const v = plotValue(row, series[i][1], pane);
        if (v === null || !isFinite(v)) continue;
        const y = pane.Y(v);
        if (prevY !== null) {
          stepSum += Math.abs(y - prevY);
          stepN++;
        }
        prevY = y;
      }
      if (!stepN || stepSum / stepN < 2.0) return null;
      // “秒平均”风格：至少 1s 窗；长窗口/窄屏时再按 10px 扩展。
      const bucketMs = Math.max(1, (end - start) / Math.max(1, Math.round(pw)));
      const smoothMs = clamp(Math.max(1000, bucketMs * 10), 1000, 5000);
      const lookStart = start - smoothMs * 3;
      const j0 = sampleRange(lookStart, lookStart, series)[0];
      const filt = new Array(visibleSamples);
      const qT = [], qV = [];
      let head = 0, qsum = 0;
      for (let i = j0; i < i1; i++) {
        const t = series[i][0];
        while (head < qT.length && qT[head] < t - smoothMs) {
          qsum -= qV[head];
          head++;
        }
        const v = plotValue(row, series[i][1], pane);
        if (v !== null && isFinite(v)) {
          qT.push(t);
          qV.push(v);
          qsum += v;
        }
        if (i >= i0) filt[i - i0] = qT.length > head ? qsum / (qT.length - head) : null;
      }
      const buckets = Math.max(1, Math.min(Math.round(pw), visibleSamples));
      const per = visibleSamples / buckets;
      const out = [];
      for (let b = 0; b < buckets; b++) {
        const a = i0 + Math.floor(b * per);
        const z = Math.min(i1, i0 + Math.floor((b + 1) * per));
        let sum = 0, count = 0, sumT = 0;
        for (let i = a; i < z; i++) {
          const f = filt[i - i0];
          if (f === null || !isFinite(f)) continue;
          sum += f;
          sumT += series[i][0];
          count++;
        }
        if (!count) continue;
        out.push([XOf(sumT / count), pane.Y(sum / count)]);
      }
      const result = out.length > 1 ? out : null;
      smoothCache.set(key, result);
      return result;
    }

    // 窄屏/长窗口时用“填充的振幅带”代替逐像素 min/max 折线：
    // 折线在列数变少时会出现明显的竖向闪烁，填充带看起来更接近振荡阴影。
    function rawEnvelope(row, pane) {
      if (!decimate || visibleSamples <= 2) return null;
      // 用绝对时间分桶（不是窗口相对分桶）：窗口滚动时，同一时间桶的
      // min/max 不会因为列边界移动而重新分组，包络边缘才能稳定平移。
      const binMs = Math.max(1e-6, (end - start) / Math.max(1, Math.round(pw)));
      const bins = new Map();
      for (let i = i0; i < i1; i++) {
        const v = plotValue(row, series[i][1], pane);
        if (v === null || !isFinite(v)) continue;
        const key = Math.floor(series[i][0] / binMs);
        let rec = bins.get(key);
        if (!rec) {
          rec = { minV: v, maxV: v, sumT: 0, count: 0 };
          bins.set(key, rec);
        }
        if (v < rec.minV) rec.minV = v;
        if (v > rec.maxV) rec.maxV = v;
        rec.sumT += series[i][0];
        rec.count++;
      }
      const keys = Array.from(bins.keys()).sort((a, b) => a - b);
      const top = [], bottom = [];
      for (const key of keys) {
        const rec = bins.get(key);
        if (!rec || !rec.count) continue;
        const x = clamp(XOf(rec.sumT / rec.count), x0, x0 + pw);
        top.push([x, pane.Y(rec.maxV)]);
        bottom.push([x, pane.Y(rec.minV)]);
      }
      if (top.length <= 1) return null;
      // 对上下包络做 5 桶平滑，进一步压掉列级毛刺；这是视觉阴影，
      // 不追求逐样本精度。
      const smoothY = (arr) => arr.map((p, i) => {
        let sy = 0, n = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(arr.length - 1, i + 2); j++) {
          sy += arr[j][1]; n++;
        }
        return [p[0], n ? sy / n : p[1]];
      });
      return { top: smoothY(top), bottom: smoothY(bottom) };
    }

    // fills (primary per pane)
    if (S.fillOn) {
      for (const pane of panes) {
        const row = pane.primary;
        if (!row || i1 - i0 <= 1) continue;
        const mean = smoothMean(row, pane);
        const pts = mean || tracePoints(row, pane);
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
        const mean = smoothMean(row, pane);
        if (!pts.length && !mean) continue;
        const env = decimate ? rawEnvelope(row, pane) : null;
        const data = {
          mode: S.renderMode,
          color: row.color,
          alpha,
          isPrimary,
          focus: !!focus,
          glow: !!S.glow,
          width: widthFor(row),
          step: !!row.step,
          raw: pts,
          mean,
          env,
          decimate,
          x0, pw,
          paneTop: pane.top,
          paneHeight: pane.h,
          row, pane,
        };
        if (window.MSRenderModes) {
          window.MSRenderModes.draw(ctx, data);
        } else {
          // 保险：render-core.js 未加载时退回原始折线
          ctx.beginPath();
          let started = false, prevY = 0;
          for (const p of pts) {
            const x = p[0], y = p[1];
            if (!started) { ctx.moveTo(x, y); started = true; }
            else if (row.step) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
            else ctx.lineTo(x, y);
            prevY = y;
          }
          if (started) {
            ctx.lineWidth = widthFor(row);
            ctx.strokeStyle = alpha >= 1 ? row.color : hexAlpha(row.color, alpha);
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
          }
        }
      }
    }

    // 框选测量：主波形上的区间高亮
    if (S.measure.on && S.analysis.range) {
      const r = S.analysis.range;
      const a = Math.max(start, r.start);
      const b = Math.min(end, r.end);
      if (b >= a) {
        const xs = x0 + ((a - start) / Math.max(1, end - start)) * pw;
        const xe = x0 + ((b - start) / Math.max(1, end - start)) * pw;
        ctx.fillStyle = 'rgba(34,211,238,.07)';
        ctx.fillRect(xs, y0, Math.max(1, xe - xs), ph);
        ctx.strokeStyle = 'rgba(34,211,238,.72)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xs, y0); ctx.lineTo(xs, y0 + ph);
        ctx.moveTo(xe, y0); ctx.lineTo(xe, y0 + ph);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(xs - 2, y0 + ph / 2 - 7, 4, 14);
        ctx.fillRect(xe - 2, y0 + ph / 2 - 7, 4, 14);
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

    updateMeasureTip();

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
        '<span>' + esc(rowDisplayName(row)) + '</span><span class="v">' + main + '</span></div>');
    }
    const rel = ((t - view.end) / 1000).toFixed(2);
    return '<div class="ct-time">' + rel + ' s · t=' + (near[0] / 1000).toFixed(2) + ' s</div>' + rows.join('');
  }

  function onPointerMove(e) {
    if (S.measure.drag) { onMeasureMove(e); return; }
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

  // ---- 主页框选测量：最大 / 最小 / 峰峰值 ----
  function syncMeasureUI() {
    const on = !!S.measure.on;
    if (D.btnMeasure) {
      D.btnMeasure.classList.toggle('active', on);
      D.btnMeasure.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (!on && D.measureTip) D.measureTip.classList.add('hidden');
  }

  function toggleMeasure() {
    S.measure.on = !S.measure.on;
    S.measure.drag = null;
    S.measure.key = '';
    if (!S.measure.on && D.measureTip) D.measureTip.classList.add('hidden');
    if (S.measure.on) toast('框选测量：在波形上拖动选择区间', 'ok');
    syncMeasureUI();
    S.dirty = true;
  }

  function measureTimeAt(e) {
    const v = S.view;
    if (!v || !v.pw || !D.chart) return null;
    const rect = D.chart.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, v.x0, v.x0 + v.pw);
    return v.start + ((x - v.x0) / v.pw) * (v.end - v.start);
  }

  function measureX(t) {
    const v = S.view;
    if (!v || !v.pw) return 0;
    return v.x0 + ((t - v.start) / Math.max(1, v.end - v.start)) * v.pw;
  }

  function measureRows(range) {
    const live = S.samples || [];
    if (live.length && live[0][0] <= range.start && live[live.length - 1][0] >= range.end) {
      return live;
    }
    return anaRows();
  }

  function measureStats(range) {
    const rows = measureRows(range);
    const out = [];
    if (!rows.length || !range) return out;
    for (const row of visiblePlotRows()) {
      let mn = Infinity, mx = -Infinity, n = 0;
      for (const smp of rows) {
        if (smp[0] < range.start || smp[0] > range.end) continue;
        const v = rowValue(row, smp[1]);
        if (v === null || v === undefined || !isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        n++;
      }
      if (n) out.push({ row, mn, mx, pp: mx - mn });
    }
    return out;
  }

  function measureKey(range, rows) {
    const last = rows.length ? rows[rows.length - 1][0] : 0;
    const ids = visiblePlotRows().map((r) => r.id).join(',');
    // 选区在历史中间时，新来的实时样本不应让统计每帧重算；
    // 只有选区贴着最新端/缓存会话/信号集变化时才更新。
    const nearLive = rows.length && range.end >= last - 500;
    return String(range.start) + '|' + String(range.end) + '|' + ids +
      '|' + (S.cacheInfo?.session || '') +
      (nearLive ? '|' + rows.length + '|' + last : '');
  }

  function updateMeasureTip() {
    const tip = D.measureTip;
    if (!tip) return;
    if (!S.measure.on || !S.analysis.range || !S.view) {
      tip.classList.add('hidden');
      return;
    }
    const range = S.analysis.range;
    if (!(range.end > range.start)) {
      tip.classList.add('hidden');
      return;
    }
    if (range.end < S.view.start || range.start > S.view.end) {
      tip.classList.add('hidden');
      return;
    }
    const rows = measureRows(range);
    if (!rows.length) {
      tip.classList.add('hidden');
      return;
    }
    const key = measureKey(range, rows);
    const nearLive = rows.length && range.end >= rows[rows.length - 1][0] - 500;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const force = !S.measure.key;
    // 拖动/实时数据变化时最多约 8 Hz 重算；选区结束（key 为空）立即重算。
    if (S.measure.key !== key && (force || now - (S.measure.lastAt || 0) > 120)) {
      S.measure.key = key;
      S.measure.lastAt = now;
      const stats = measureStats(range);
      S.measure.stats = stats;
      tip.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'mt-head';
      head.appendChild(document.createTextNode('框选 '));
      const b = document.createElement('b');
      b.textContent = anaDurationText(range.end - range.start);
      head.appendChild(b);
      head.appendChild(document.createTextNode(' · 最大 / 最小 / 峰峰'));
      tip.appendChild(head);
      if (!stats.length) {
        const none = document.createElement('div');
        none.className = 'mt-more';
        none.textContent = '区间内没有可见样本';
        tip.appendChild(none);
      } else {
        const cols = document.createElement('div');
        cols.className = 'mt-cols';
        for (const text of ['信号', '最大', '最小', '峰峰']) {
          const c = document.createElement('span');
          c.textContent = text;
          cols.appendChild(c);
        }
        tip.appendChild(cols);
        for (const st of stats.slice(0, 8)) {
          const rowEl = document.createElement('div');
          rowEl.className = 'mt-row';
          const name = document.createElement('span');
          name.className = 'mt-name';
          const dot = document.createElement('i');
          dot.style.background = st.row.color || '#22d3ee';
          name.appendChild(dot);
          const nm = document.createElement('span');
          nm.textContent = (st.row.name || st.row.id) + (st.row.unit ? ' [' + st.row.unit + ']' : '');
          nm.title = nm.textContent;
          name.appendChild(nm);
          rowEl.appendChild(name);
          for (const val of [st.mx, st.mn, st.pp]) {
            const cell = document.createElement('b');
            cell.textContent = fmtFloat(val);
            rowEl.appendChild(cell);
          }
          tip.appendChild(rowEl);
        }
        if (stats.length > 8) {
          const more = document.createElement('div');
          more.className = 'mt-more';
          more.textContent = '另有 ' + (stats.length - 8) + ' 路未显示';
          tip.appendChild(more);
        }
      }
    }
    tip.classList.remove('hidden');
    const view = S.view;
    const tw = tip.offsetWidth || 260;
    const th = tip.offsetHeight || 80;
    const xs = measureX(Math.max(range.start, view.start));
    const xe = measureX(Math.min(range.end, view.end));
    let left = xs + 10;
    if (xe > xs && left + tw > view.x0 + view.pw - 6) left = xs - tw - 10;
    left = clamp(left, 6, S.size.w - tw - 6);
    const top = clamp(view.y0 + 8, 6, S.size.h - th - 6);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function onMeasureDown(e) {
    if (!S.measure.on || e.button !== 0) return;
    const t = measureTimeAt(e);
    if (t === null) return;
    const x = e.clientX - D.chart.getBoundingClientRect().left;
    const r = S.analysis.range;
    let mode = 'new';
    let anchor = t;
    if (r) {
      if (Math.abs(x - measureX(r.start)) <= 7) mode = 'start';
      else if (Math.abs(x - measureX(r.end)) <= 7) mode = 'end';
    }
    S.measure.drag = { mode, anchor };
    S.measure.key = '';
    if (mode === 'new') S.analysis.range = { start: t, end: t };
    else if (mode === 'start') {
      S.analysis.range = { start: Math.min(t, r.end - 20), end: r.end };
    } else {
      S.analysis.range = { start: r.start, end: Math.max(t, r.start + 20) };
    }
    try { D.chart.setPointerCapture(e.pointerId); } catch (cause) { /* ignore */ }
    e.preventDefault();
    e.stopPropagation();
    S.dirty = true;
  }

  function onMeasureMove(e) {
    if (!S.measure.drag) return;
    const t = measureTimeAt(e);
    if (t === null) return;
    const r = S.analysis.range;
    if (!r) return;
    let a, z;
    if (S.measure.drag.mode === 'new') {
      a = Math.min(S.measure.drag.anchor, t);
      z = Math.max(S.measure.drag.anchor, t);
    } else if (S.measure.drag.mode === 'start') {
      a = Math.min(t, r.end - 20);
      z = r.end;
    } else {
      a = r.start;
      z = Math.max(t, r.start + 20);
    }
    if (z - a < 20) return;
    S.analysis.range = { start: a, end: z };
    S.measure.key = '';
    S.dirty = true;
  }

  function onMeasureUp() {
    if (!S.measure.drag) return;
    S.measure.drag = null;
    const r = S.analysis.range;
    if (r && r.end - r.start < 200) S.analysis.range = null;
    S.measure.key = '';
    S.dirty = true;
    if (S.ui.panel === 'analysis') anaRefresh();
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
    D.chart.addEventListener('dblclick', () => {
      if (!S.measure.on) return;
      S.analysis.range = null;
      S.measure.key = '';
      S.dirty = true;
      if (S.ui.panel === 'analysis') anaRefresh();
    });
    D.chart.addEventListener('pointerdown', onMeasureDown);
    D.chart.addEventListener('pointerup', onMeasureUp);
    D.chart.addEventListener('pointercancel', onMeasureUp);
    D.chart.addEventListener('lostpointercapture', onMeasureUp);
    D.btnMeasure?.addEventListener('click', toggleMeasure);
    syncMeasureUI();
    D.chart.addEventListener('click', (e) => {
      if (e.button !== 0 || S.measure.on) return;
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
    D.tlBack10?.addEventListener('click', pageChartBack);
    D.tlFwd10?.addEventListener('click', pageChartForward);
    D.tlLatest?.addEventListener('click', pageChartLatest);
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
    D.btnAddSource?.addEventListener('click', openSourceAdd);
    $('#btnChart')?.addEventListener('click', () => toggleSection('chart'));
    D.btnChartFull?.addEventListener('click', cycleChartFull);
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
    D.sourceHeroes?.addEventListener('click', (e) => {
      const card = e.target.closest('.source-hero');
      if (!card) return;
      if (card.dataset.action === 'add-source' || e.target.closest('[data-action="add-source"]')) {
        openSourceAdd();
        return;
      }
      const sid = card.dataset.source || '';
      if (!sid) return;
      const act = e.target.closest('[data-src-act]')?.dataset.srcAct || 'select';
      if (act === 'select') { selectSource(sid); return; }
      if (act === 'connect') {
        const src = sourceInfo(sid);
        if (src && src.connected) disconnectOneSource(sid);
        else connectOneSource(sid);
        return;
      }
      if (act === 'edit') {
        selectSource(sid).then(() => togglePanel('source'));
        return;
      }
      if (act === 'remove') { removeOneSource(sid); return; }
    });
    D.sourceChips?.addEventListener('click', (e) => {
      const chip = e.target.closest('.source-chip');
      if (!chip) return;
      selectSource(chip.dataset.source || '');
    });
    D.srcAddKind?.addEventListener('change', () => {
      syncSourceAddFields();
      if ((D.srcAddKind?.value || '') === 'openocd') refreshAddOcdConfigs();
    });
    D.btnOcdRefresh?.addEventListener('click', syncSourceConnectionUI);
    D.btnSrcAddOcdRefresh?.addEventListener('click', refreshAddOcdConfigs);
    D.srcAddOcd?.addEventListener('change', refreshAddOcdConfigs);
    D.inpOcd?.addEventListener('change', syncSourceConnectionUI);
    D.btnSrcAddCreate?.addEventListener('click', () => submitSourceAdd(false));
    D.btnSrcAddCreateConnect?.addEventListener('click', () => submitSourceAdd(true));
    const fillAddLabel = (file) => {
      if (!file || !D.srcAddLabel || D.srcAddLabel.value.trim()) return;
      D.srcAddLabel.value = importLabelOf(file.name) || file.name.replace(/\.[^.]+$/, '');
    };
    D.srcAddAxf?.addEventListener('change', () => fillAddLabel(D.srcAddAxf?.files?.[0]));
    D.srcAddTable?.addEventListener('change', () => fillAddLabel(D.srcAddTable?.files?.[0]));
    $('#btnUsbRefresh')?.addEventListener('click', () => refreshUsbDevices(true));
    $('#inpOcd')?.addEventListener('change', () => saveLocal());
    // connPill：点击直达「信号源」面板切换调试器
    const openSourceFromPill = () => {
      const el = panelFor('source');
      if (!el) return;
      if (!el.hidden) { closePanels(); return; }
      // 复用 togglePanel 的定位逻辑；临时借用 source 卡片锚点
      if (typeof togglePanel === 'function') togglePanel('source');
      else { el.hidden = false; S.ui.panel = 'source'; }
    };
    D.connPill?.addEventListener('click', openSourceFromPill);
    D.connPill?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSourceFromPill(); }
    });
    D.btnConnect?.addEventListener('click', async () => {
      const active = sourceInfo(S.activeSource);
      const connected = active ? !!active.connected
        : (sourceConnected(S.source) && !S.sampler?.error);
      if (connected) {
        await disconnectSource();
        return;
      }
      // 默认跟随当前源类型；不要用全局 lastMode 覆盖，避免页面恢复后把
      // 仿真/TCL 源误连成 OpenOCD（看起来像“被自动切换”）。
      const mode = (active && active.kind)
        || (S.source?.kind && S.source.kind !== 'none' ? S.source.kind : '')
        || S.lastMode || 'openocd';
      await doConnect(mode);
    });
    D.btnSyncServer?.addEventListener('click', syncFromServer);
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

    // 顶部 4 张控制卡：信号源 / 机型 / 采样录制 / 分析（按 DOM 顺序）
    for (const card of $$('.ctl-card')) {
      const go = () => togglePanel(card.dataset.go);
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
    D.anaTabs?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ana-mode]');
      if (!btn) return;
      S.analysis.mode = btn.dataset.anaMode || 'spectrum';
      D.anaTabs.querySelectorAll('[data-ana-mode]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      anaRefresh();
    });
    D.anaSignal?.addEventListener('change', () => {
      S.analysis.x = D.anaSignal.value || '';
      anaRefresh();
    });
    D.anaSignalY?.addEventListener('change', () => {
      S.analysis.y = D.anaSignalY.value || '';
      anaRefresh();
    });
    D.btnAnaRefresh?.addEventListener('click', anaRefresh);
    D.btnAnaFull?.addEventListener('click', () => {
      S.analysis.range = null;
      anaRefresh();
    });
    D.btnAnaLast?.addEventListener('click', () => {
      const rows = anaRows();
      if (rows.length) {
        const last = rows[rows.length - 1][0];
        const first = rows[0][0];
        S.analysis.range = last - first > 10000 ? { start: last - 10000, end: last } : null;
      }
      anaRefresh();
    });
    if (D.anaPreview) {
      D.anaPreview.addEventListener('pointerdown', anaPreviewDown);
      D.anaPreview.addEventListener('pointermove', anaPreviewMove);
      D.anaPreview.addEventListener('pointerup', anaPreviewUp);
      D.anaPreview.addEventListener('pointercancel', anaPreviewUp);
      D.anaPreview.addEventListener('dblclick', () => {
        S.analysis.range = null;
        anaRefresh();
      });
      // 指针在预览窗外松开时也能收尾（setPointerCapture 不可用时兜底）
      window.addEventListener('pointerup', () => { if (anaDrag) anaPreviewUp(); });
      window.addEventListener('pointercancel', () => { if (anaDrag) anaPreviewUp(); });
    }

    window.addEventListener('resize', () => {
      if (S.ui.panel === 'analysis') anaRefresh();
    });
    D.mcuSel?.addEventListener('change', () => selectMcu(D.mcuSel.value, true));
    $('#btnChipProbe')?.addEventListener('click', probeChipNow);
    $('#btnChipBannerFix')?.addEventListener('click', () => togglePanel('symbol'));

    // 工程 / 机型
    D.projectSel?.addEventListener('change', () => switchProject(D.projectSel.value));
    D.projectSel2?.addEventListener('change', () => switchProject(D.projectSel2.value));
    $('#btnProjectExport')?.addEventListener('click', exportProject);
    $('#btnProjectImport')?.addEventListener('click', () => D.projectFile?.click());
    D.btnProfileSave?.addEventListener('click', () => flushProfileSave(true));
    D.btnProfileBuild?.addEventListener('click', buildCurrentProfile);
    D.btnProfileNew?.addEventListener('click', () => openImportModal(true));
    D.btnProfileCopy?.addEventListener('click', copyCurrentProfile);
    D.projectFile?.addEventListener('change', () => {
      const f = D.projectFile.files && D.projectFile.files[0];
      if (f) importProjectFile(f);
      D.projectFile.value = '';
    });
    D.btnImportClose?.addEventListener('click', closeImportModal);
    D.btnImportCancel?.addEventListener('click', closeImportModal);
    D.btnImportUpdate?.addEventListener('click', () => doImport('update'));
    D.btnImportCreate?.addEventListener('click', () => doImport('new'));
    D.importAxf?.addEventListener('change', refreshImportFiles);
    D.importTable?.addEventListener('change', refreshImportFiles);
    D.importName?.addEventListener('input', () => { importNameTouched = true; });
    D.importModal?.addEventListener('click', (e) => {
      if (e.target === D.importModal) closeImportModal();
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
    $('#btnReloadCatalog').addEventListener('click', reloadCatalog);
    $('#btnImportVars').addEventListener('click', () => openImportModal(true));
    D.btnImportRegInfo?.addEventListener('click', () => D.regInfoFile?.click());
    D.regInfoFile?.addEventListener('change', () => { if (D.regInfoFile.files?.length) importRegInfo(); });
    D.btnRecReset?.addEventListener('click', () => {
      if (!confirm('只清空当前网页的波形显示，服务器录制继续。确定？')) return;
      clearAll();
    });

    // keyboard
    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape') {
        if (D.importModal && !D.importModal.classList.contains('hidden')) { closeImportModal(); return; }
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
    const sid = entry.source || (String(id).includes('::') ? String(id).split('::')[0] : '');
    const src = sid ? sourceInfo(sid) : null;
    if (src ? !src.connected : !sourceConnected(S.source)) {
      toast('未连接，无法读取', 'err');
      return;
    }
    try {
      const r = await post('/api/read', {
        addr: entry.addr, size: entry.size || 4,
        signed: !!entry.signed, bit: entry.bit || null,
        float: !!entry.float, type: entry.type || '', source: sid,
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
          float: !!entry.float, type: entry.type || '',
          source: entry.source || activeSourceId(),
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

  // ---------------------------------------------------------------- 分析面板
  let anaDrag = null;
  let anaPreviewCache = { key: '', series: null };
  // 数据只来自浏览器已收到的样本 / 当前缓存窗口；不做服务端重采样。
  function anaRows() {
    const live = S.samples || [];
    const cache = S.cacheSamples || [];
    // 缓存窗口通常覆盖更长的时间；live 更细，谁点数多用谁
    return cache.length > live.length ? cache : live;
  }

  function anaSignalList() {
    return (S.signals || []).filter((s) => s && s.id);
  }

  function anaRow(id) {
    return (S.signals || []).find((s) => s.id === id) || S.rows.get(id) || null;
  }

  function anaPopulate() {
    const list = anaSignalList();
    for (const sel of [D.anaSignal, D.anaSignalY]) {
      if (!sel) continue;
      const cur = sel.value;
      sel.innerHTML = '';
      if (!list.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '（暂无采样信号）';
        sel.appendChild(o);
        continue;
      }
      for (const s of list) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name || s.id;
        sel.appendChild(o);
      }
      if (cur && list.some((s) => s.id === cur)) sel.value = cur;
    }
    if (!S.analysis.x || !list.some((s) => s.id === S.analysis.x)) {
      S.analysis.x = list[0] ? list[0].id : '';
    }
    if (!S.analysis.y || !list.some((s) => s.id === S.analysis.y)) {
      S.analysis.y = (list[1] || list[0]) ? (list[1] || list[0]).id : '';
    }
    if (D.anaSignal) D.anaSignal.value = S.analysis.x;
    if (D.anaSignalY) D.anaSignalY.value = S.analysis.y;
  }

  function anaSeries(id, rows, range) {
    const row = anaRow(id);
    if (!row || !rows.length || row.ci === undefined || row.ci < 0) return null;
    const ci = row.ci;
    const last = rows[rows.length - 1][0];
    const first = range ? Math.max(rows[0][0], range.start) : rows[0][0];
    const end = range ? Math.min(last, range.end) : last;
    const t = [], v = [];
    for (const r of rows) {
      if (r[0] < first || r[0] > end) continue;
      const raw = r[1] ? r[1][ci] : null;
      if (raw === null || raw === undefined) continue;
      const val = raw * (row.scale ?? 1) + (row.offset ?? 0);
      if (!isFinite(val)) continue;
      t.push(r[0]);
      v.push(val);
    }
    return t.length >= 2 ? { t, v, row } : null;
  }

  function anaPair(xid, yid, rows, range) {
    const rx = anaRow(xid), ry = anaRow(yid);
    if (!rx || !ry || rx.ci < 0 || ry.ci < 0 || !rows.length) return null;
    const last = rows[rows.length - 1][0];
    const first = range ? Math.max(rows[0][0], range.start) : rows[0][0];
    const end = range ? Math.min(last, range.end) : last;
    const t = [], x = [], y = [];
    for (const r of rows) {
      if (r[0] < first || r[0] > end) continue;
      const rawX = r[1] ? r[1][rx.ci] : null;
      const rawY = r[1] ? r[1][ry.ci] : null;
      if (rawX === null || rawX === undefined || rawY === null || rawY === undefined) continue;
      const vx = rawX * (rx.scale ?? 1) + (rx.offset ?? 0);
      const vy = rawY * (ry.scale ?? 1) + (ry.offset ?? 0);
      if (!isFinite(vx) || !isFinite(vy)) continue;
      t.push(r[0]); x.push(vx); y.push(vy);
    }
    return t.length >= 2 ? { t, x, y, rx, ry } : null;
  }

  function anaUniform(series, range, n = 2048) {
    if (!series || series.t.length < 8) return null;
    const t = series.t, v = series.v;
    const t1 = range ? Math.min(t[t.length - 1], range.end) : t[t.length - 1];
    const t0 = range ? Math.max(t[0], range.start) : t[0];
    if (!(t1 > t0)) return null;
    n = Math.max(128, Math.min(4096, n));
    n = 1 << Math.round(Math.log2(n));
    const dt = (t1 - t0) / (n - 1);
    const outT = new Float64Array(n), outV = new Float64Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const tt = t0 + i * dt;
      while (k + 1 < t.length && t[k + 1] < tt) k++;
      if (k + 1 >= t.length) {
        outT[i] = tt;
        outV[i] = v[v.length - 1];
        continue;
      }
      const ta = t[k], tb = t[k + 1];
      const f = tb > ta ? (tt - ta) / (tb - ta) : 0;
      outT[i] = tt;
      outV[i] = v[k] + (v[k + 1] - v[k]) * Math.max(0, Math.min(1, f));
    }
    return { t: outT, v: outV, dt, fs: 1000 / dt, n, t0, t1, span: t1 - t0 };
  }

  function anaFft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        for (let j = 0; j < len / 2; j++) {
          const uR = re[i + j], uI = im[i + j];
          const vR = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
          const vI = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
          re[i + j] = uR + vR;
          im[i + j] = uI + vI;
          re[i + j + len / 2] = uR - vR;
          im[i + j + len / 2] = uI - vI;
          const nwr = wr * wr0 - wi * wi0;
          wi = wr * wi0 + wi * wr0;
          wr = nwr;
        }
      }
    }
  }

  function anaCtxFor(c, defaultH) {
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    const w = Math.max(120, Math.round(rect.width || 540));
    const h = Math.max(20, Math.round(rect.height || defaultH));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function anaCanvasCtx() { return anaCtxFor(D.anaCanvas, 280); }
  function anaPreviewCtx() { return anaCtxFor(D.anaPreview, 64); }
  function anaTimeAxisCtx() { return anaCtxFor(D.anaTimeAxis, 24); }

  function anaBounds(rows) {
    if (!rows || !rows.length) return null;
    return { first: rows[0][0], last: rows[rows.length - 1][0] };
  }

  function anaClampRange(range, bounds) {
    if (!range || !bounds) return null;
    const a = Math.max(bounds.first, Math.min(range.start, range.end));
    const b = Math.min(bounds.last, Math.max(range.start, range.end));
    if (!(b - a >= 50)) return null;
    if (b - a >= (bounds.last - bounds.first) * 0.995) return null;
    return { start: a, end: b };
  }

  function anaDurationText(ms) {
    const s = Math.max(0, Number(ms) || 0) / 1000;
    if (s < 1) return Math.round(s * 1000) + ' ms';
    if (s < 10) return s.toFixed(2) + ' s';
    if (s < 60) return s.toFixed(1) + ' s';
    return fmtDuration(s);
  }

  function anaRangeText() {
    const r = S.analysis.range;
    return r ? anaDurationText(r.end - r.start) : '全部';
  }

  function anaUpdateRangeText() {
    if (D.anaRangeText) D.anaRangeText.textContent = anaRangeText();
  }

  function anaFrame(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(6,12,22,.72)';
    ctx.fillRect(0, 0, w, h);
  }

  function anaAxis(ctx, x0, y0, x1, y1, xLab, yLab) {
    ctx.strokeStyle = 'rgba(120,150,190,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.fillStyle = 'rgba(145,165,190,.85)';
    ctx.font = '10px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(xLab, (x0 + x1) / 2, y1 + 17);
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(yLab, x0 + 2, y0 - 3);
  }

  function anaDrawEmpty(msg) {
    const c = anaCanvasCtx();
    if (!c) return;
    anaFrame(c.ctx, c.w, c.h);
    c.ctx.fillStyle = 'rgba(145,165,190,.8)';
    c.ctx.font = '12px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
    c.ctx.textAlign = 'center'; c.ctx.textBaseline = 'middle';
    c.ctx.fillText(msg, c.w / 2, c.h / 2);
  }

  function anaPreviewTime(e) {
    const c = D.anaPreview;
    const b = anaBounds(anaRows());
    if (!c || !b) return null;
    const rect = c.getBoundingClientRect();
    if (!rect.width) return null;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    return b.first + (x / rect.width) * (b.last - b.first);
  }

  function anaPreviewX(t, b) {
    const c = D.anaPreview;
    if (!c || !b) return 0;
    const rect = c.getBoundingClientRect();
    return ((t - b.first) / Math.max(1, b.last - b.first)) * rect.width;
  }

  function anaPreviewSeries(rows, xid) {
    const row = anaRow(xid);
    const key = String(xid) + '|' + rows.length + '|' +
      (rows.length ? rows[rows.length - 1][0] : '') + '|' +
      (row ? (row.ci + '|' + row.scale + '|' + row.offset) : '');
    if (anaPreviewCache.key !== key) {
      anaPreviewCache = { key, series: anaSeries(xid, rows, null) };
    }
    return anaPreviewCache.series;
  }

  function anaDrawPreview(rows, xid, range) {
    const c = anaPreviewCtx();
    if (!c) return;
    const { ctx, w, h } = c;
    anaFrame(ctx, w, h);
    const b = anaBounds(rows);
    const series = anaPreviewSeries(rows, xid);
    if (!b || !series) {
      ctx.fillStyle = 'rgba(145,165,190,.7)';
      ctx.font = '10px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暂无波形', w / 2, h / 2);
      return;
    }
    const x0 = 2, x1 = w - 2, y0 = 4, y1 = h - 4;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < series.v.length; i++) {
      if (series.v[i] < mn) mn = series.v[i];
      if (series.v[i] > mx) mx = series.v[i];
    }
    if (mx <= mn) { mx = mn + 1; }
    const px = (t) => x0 + (x1 - x0) * (t - b.first) / Math.max(1, b.last - b.first);
    const py = (v) => y1 - (y1 - y0) * (v - mn) / (mx - mn);
    const n = series.v.length;
    const buckets = Math.max(1, Math.floor(w));
    const per = Math.max(1, n / buckets);
    ctx.strokeStyle = 'rgba(34,211,238,.55)';
    ctx.lineWidth = 1;
    for (let k = 0; k < buckets; k++) {
      const a = Math.floor(k * per), z = Math.min(n, Math.floor((k + 1) * per));
      if (z <= a) continue;
      let imin = a, imax = a;
      for (let i = a + 1; i < z; i++) {
        if (series.v[i] < series.v[imin]) imin = i;
        if (series.v[i] > series.v[imax]) imax = i;
      }
      const x = Math.round(px(series.t[imin])) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, py(series.v[imin]));
      ctx.lineTo(x, py(series.v[imax]));
      ctx.stroke();
    }
    if (range) {
      const xs = px(range.start), xe = px(range.end);
      ctx.fillStyle = 'rgba(0,0,0,.48)';
      ctx.fillRect(x0, 0, Math.max(0, xs - x0), h);
      ctx.fillRect(xe, 0, Math.max(0, x1 - xe), h);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xs + 0.5, 0); ctx.lineTo(xs + 0.5, h);
      ctx.moveTo(xe + 0.5, 0); ctx.lineTo(xe + 0.5, h);
      ctx.stroke();
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(xs - 2, h / 2 - 4, 4, 8);
      ctx.fillRect(xe - 2, h / 2 - 4, 4, 8);
    }
  }

  function anaDrawTimeAxis(rows, range) {
    const c = anaTimeAxisCtx();
    if (!c) return;
    const { ctx, w, h } = c;
    anaFrame(ctx, w, h);
    const b = anaBounds(rows);
    if (!b) return;
    const x0 = 2, x1 = w - 2;
    const px = (t) => x0 + (x1 - x0) * (t - b.first) / Math.max(1, b.last - b.first);
    if (range) {
      const xs = px(range.start), xe = px(range.end);
      ctx.fillStyle = 'rgba(34,211,238,.10)';
      ctx.fillRect(xs, 0, Math.max(1, xe - xs), h);
    }
    ctx.strokeStyle = 'rgba(120,150,190,.28)';
    ctx.beginPath();
    ctx.moveTo(x0, h - 1); ctx.lineTo(x1, h - 1);
    ctx.stroke();
    ctx.fillStyle = 'rgba(145,165,190,.8)';
    ctx.font = '9px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let i = 0; i <= 4; i++) {
      const t = b.first + (b.last - b.first) * i / 4;
      const x = px(t);
      ctx.beginPath(); ctx.moveTo(x, h - 5); ctx.lineTo(x, h - 1); ctx.stroke();
      const rel = (t - b.last) / 1000;
      ctx.fillText((Math.abs(rel) < 0.05 ? '0' : fmtAxis(rel)) + 's', x, h - 6);
    }
  }

  function anaPreviewDrawAll() {
    const rows = anaRows();
    const xid = D.anaSignal ? D.anaSignal.value : S.analysis.x;
    anaDrawPreview(rows, xid, S.analysis.range);
    anaDrawTimeAxis(rows, S.analysis.range);
    anaUpdateRangeText();
    S.dirty = true;
  }

  function anaPreviewDown(e) {
    const b = anaBounds(anaRows());
    const t = anaPreviewTime(e);
    if (!b || t === null || !D.anaPreview) return;
    const rect = D.anaPreview.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let mode = 'new', anchor = t;
    if (S.analysis.range) {
      const r = S.analysis.range;
      const xs = anaPreviewX(r.start, b), xe = anaPreviewX(r.end, b);
      if (Math.abs(x - xs) <= 7) mode = 'start';
      else if (Math.abs(x - xe) <= 7) mode = 'end';
    }
    anaDrag = { mode, anchor, bounds: b };
    if (mode === 'new') S.analysis.range = { start: t, end: t };
    else if (mode === 'start') {
      S.analysis.range = { start: Math.min(t, S.analysis.range.end - 20), end: S.analysis.range.end };
    } else {
      S.analysis.range = { start: S.analysis.range.start, end: Math.max(t, S.analysis.range.start + 20) };
    }
    try { D.anaPreview.setPointerCapture(e.pointerId); } catch (cause) { /* ignore */ }
    e.preventDefault();
    anaPreviewDrawAll();
  }

  function anaPreviewMove(e) {
    if (!anaDrag) return;
    const t = anaPreviewTime(e);
    if (t === null) return;
    const b = anaDrag.bounds;
    let a, z;
    if (anaDrag.mode === 'new') {
      a = Math.min(anaDrag.anchor, t);
      z = Math.max(anaDrag.anchor, t);
    } else if (anaDrag.mode === 'start') {
      a = Math.min(t, S.analysis.range.end - 20);
      z = S.analysis.range.end;
    } else {
      a = S.analysis.range.start;
      z = Math.max(t, a + 20);
    }
    a = Math.max(b.first, a);
    z = Math.min(b.last, z);
    if (z - a < 20) return;
    S.analysis.range = { start: a, end: z };
    anaPreviewDrawAll();
  }

  function anaPreviewUp() {
    if (!anaDrag) return;
    anaDrag = null;
    const r = S.analysis.range;
    if (r && r.end - r.start < 200) S.analysis.range = null;
    anaRefresh();
  }

  function anaDrawSpectrum(series) {
    const u = anaUniform(series, S.analysis.range, 2048);
    if (!u) {
      anaDrawEmpty('样本不足，先连接/积累几秒数据');
      D.anaInfo.textContent = '样本不足（至少需要 8 个点）。';
      return;
    }
    const n = u.n;
    const re = new Float64Array(n), im = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += u.v[i];
    mean /= n;
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      re[i] = (u.v[i] - mean) * win;
    }
    anaFft(re, im);
    const half = n / 2;
    const mag = new Float64Array(half + 1);
    let maxMag = 0;
    for (let k = 1; k <= half; k++) {
      mag[k] = 2 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n;
      if (mag[k] > maxMag) maxMag = mag[k];
    }
    const df = u.fs / n;
    const c = anaCanvasCtx();
    if (!c) return;
    const { ctx, w, h } = c;
    anaFrame(ctx, w, h);
    const x0 = 46, y0 = 16, x1 = w - 14, y1 = h - 34;
    const fMax = u.fs / 2;
    const dbMin = -100;
    const px = (f) => x0 + (x1 - x0) * Math.max(0, Math.min(1, f / fMax));
    const py = (db) => y1 - (y1 - y0) * Math.max(0, Math.min(1, (db - dbMin) / (0 - dbMin)));
    ctx.strokeStyle = 'rgba(120,150,190,.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const f = fMax * i / 4;
      const x = px(f);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.fillStyle = 'rgba(145,165,190,.8)';
      ctx.font = '9px ' + (getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace');
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(fmtAxis(f), x, y1 + 4);
    }
    for (let i = 0; i <= 4; i++) {
      const db = dbMin + (0 - dbMin) * i / 4;
      const y = py(db);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = 'rgba(145,165,190,.8)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(String(db), x0 - 6, y);
    }
    anaAxis(ctx, x0, y0, x1, y1, 'Hz', 'dB');
    ctx.beginPath();
    let started = false;
    for (let k = 1; k <= half; k++) {
      const db = maxMag > 0 ? 20 * Math.log10(Math.max(mag[k] / maxMag, 1e-6)) : dbMin;
      const x = px(k * df), y = py(db);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    const peaks = [];
    for (let k = 2; k < half; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        const db = maxMag > 0 ? 20 * Math.log10(Math.max(mag[k] / maxMag, 1e-6)) : dbMin;
        if (db > -45) peaks.push({ f: k * df, db });
      }
    }
    peaks.sort((a, b) => b.db - a.db);
    const top = peaks.slice(0, 4);
    const row = series.row;
    const unit = row.unit ? ' ' + row.unit : '';
    const lines = [
      '区间 ' + anaDurationText(u.span) + '  ·  N=' + n + '  ·  fs≈' + u.fs.toFixed(1) + ' Hz  ·  Δf≈' + df.toFixed(3) + ' Hz  ·  Nyquist≈' + (u.fs / 2).toFixed(1) + ' Hz',
      top.length
        ? '峰值：' + top.map((p) => p.f.toFixed(2) + ' Hz (' + p.db.toFixed(1) + ' dB)').join('  ·  ')
        : '没有明显峰值（<-45 dB）。',
      '幅值按 Hann 窗归一化，纵轴相对峰值 0 dB；' + (series.row.float ? 'float32' : 'raw') + unit,
    ];
    if (u.fs < 50) lines.push('⚠ fs 较低，' + (u.fs / 2).toFixed(1) + ' Hz 以上不可见；请确认信号真实更新率。');
    D.anaInfo.textContent = lines.join('\n');
  }

  function anaDrawPhase(seriesX, seriesY) {
    const n = Math.min(seriesX.t.length, seriesY.t.length, 1600);
    if (n < 4) {
      anaDrawEmpty('两个信号的重叠样本不足');
      D.anaInfo.textContent = '两个信号至少需要 4 个重叠样本。';
      return;
    }
    const xs = seriesX.v.slice(-n), ys = seriesY.v.slice(-n);
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < xmin) xmin = xs[i];
      if (xs[i] > xmax) xmax = xs[i];
      if (ys[i] < ymin) ymin = ys[i];
      if (ys[i] > ymax) ymax = ys[i];
    }
    if (xmax <= xmin) xmax = xmin + 1;
    if (ymax <= ymin) ymax = ymin + 1;
    const c = anaCanvasCtx();
    if (!c) return;
    const { ctx, w, h } = c;
    anaFrame(ctx, w, h);
    const x0 = 48, y0 = 16, x1 = w - 16, y1 = h - 34;
    const px = (x) => x0 + (x1 - x0) * (x - xmin) / (xmax - xmin);
    const py = (y) => y1 - (y1 - y0) * (y - ymin) / (ymax - ymin);
    ctx.strokeStyle = 'rgba(120,150,190,.18)';
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (x1 - x0) * i / 4;
      const y = y0 + (y1 - y0) * i / 4;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
    anaAxis(ctx, x0, y0, x1, y1, seriesX.row.name || 'X', seriesY.row.name || 'Y');
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = px(xs[i]), y = py(ys[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(34,211,238,.8)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.fillStyle = '#34d399';
    ctx.beginPath(); ctx.arc(px(xs[0]), py(ys[0]), 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath(); ctx.arc(px(xs[n - 1]), py(ys[n - 1]), 3, 0, Math.PI * 2); ctx.fill();
    D.anaInfo.textContent = [
      '相图：' + n + ' 点（绿=起点，橙=终点）',
      seriesX.row.name + ' [' + fmtFloat(xmin) + ' … ' + fmtFloat(xmax) + ']',
      seriesY.row.name + ' [' + fmtFloat(ymin) + ' … ' + fmtFloat(ymax) + ']',
      '闭合轨道/极限环：看轨迹是否反复回到同一圈；单纯噪声不会闭合。',
    ].join('\n');
  }

  function anaLimitMetrics(series) {
    const t = series.t, v = series.v;
    if (t.length < 16) return null;
    let mean = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < v.length; i++) {
      mean += v[i];
      if (v[i] < mn) mn = v[i];
      if (v[i] > mx) mx = v[i];
    }
    mean /= v.length;
    const amp = (mx - mn) / 2;
    const h = Math.max(1e-12, amp * 0.12);
    let state = 0, lastRise = null;
    const periods = [], rises = [];
    for (let i = 0; i < v.length; i++) {
      const x = v[i] - mean;
      if (state <= 0 && x > h) {
        if (lastRise !== null) periods.push(t[i] - lastRise);
        lastRise = t[i];
        rises.push(t[i]);
        state = 1;
      } else if (state >= 0 && x < -h) {
        state = -1;
      }
    }
    if (periods.length < 2) return { amp, mn, mx, mean, periods, freq: 0, cv: 1 };
    const m = periods.reduce((a, b) => a + b, 0) / periods.length;
    const sd = Math.sqrt(periods.reduce((a, b) => a + (b - m) * (b - m), 0) / periods.length);
    return { amp, mn, mx, mean, periods, freq: m > 0 ? 1000 / m : 0, cv: m > 0 ? sd / m : 1, rises };
  }

  function anaDrawLimit(series) {
    const met = anaLimitMetrics(series);
    if (!met) {
      anaDrawEmpty('样本不足');
      D.anaInfo.textContent = '样本不足（至少需要 16 个点）。';
      return;
    }
    const c = anaCanvasCtx();
    if (!c) return;
    const { ctx, w, h } = c;
    anaFrame(ctx, w, h);
    const n = Math.min(series.t.length, 4000);
    const t0 = series.t[series.t.length - n], t1 = series.t[series.t.length - 1];
    const span = Math.max(1, t1 - t0);
    const y0 = 16, y1 = h - 34, x0 = 46, x1 = w - 14;
    const ymin = met.mn - met.amp * 0.15, ymax = met.mx + met.amp * 0.15;
    const px = (t) => x0 + (x1 - x0) * (t - t0) / span;
    const py = (v) => y1 - (y1 - y0) * (v - ymin) / Math.max(1e-12, ymax - ymin);
    ctx.strokeStyle = 'rgba(120,150,190,.2)';
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (x1 - x0) * i / 4;
      const y = y0 + (y1 - y0) * i / 4;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.beginPath();
    ctx.moveTo(x0, py(met.mean)); ctx.lineTo(x1, py(met.mean)); ctx.stroke();
    anaAxis(ctx, x0, y0, x1, y1, '时间 (s)', series.row.unit || '值');
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = px(series.t[series.t.length - n + i]);
      const y = py(series.v[series.v.length - n + i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 过零点（上升沿）标记
    ctx.fillStyle = '#f59e0b';
    for (const tr of met.rises || []) {
      if (tr < t0 || tr > t1) continue;
      ctx.beginPath();
      ctx.arc(px(tr), py(met.mean), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const stable = met.periods.length >= 4 && met.cv < 0.15;
    D.anaInfo.textContent = [
      (stable ? '检测到稳定振荡' : '未检测到稳定极限环') + (met.periods.length ? '' : '（周期不足）'),
      '幅值 ±' + fmtFloat(met.amp) + (series.row.unit ? ' ' + series.row.unit : '') +
        '  ·  均值 ' + fmtFloat(met.mean) +
        '  ·  范围 ' + fmtFloat(met.mn) + ' … ' + fmtFloat(met.mx),
      met.freq ? ('周期 ' + (1000 / met.freq).toFixed(2) + ' ms  ·  频率 ' + met.freq.toFixed(2) + ' Hz  ·  周期 CV ' + (met.cv * 100).toFixed(1) + '%') : '没有足够的上升沿周期。',
      '启发式：连续 4 个周期且周期波动 <15% 才算稳定；先确认采样率高于振荡频率的 2 倍。',
    ].join('\n');
  }

  function anaRefresh() {
    if (!D.anaCanvas || !D.anaInfo) return;
    const panel = panelFor('analysis');
    if (!panel || panel.hidden) return;
    anaPopulate();
    const mode = S.analysis.mode || 'spectrum';
    if (D.anaYField) D.anaYField.classList.toggle('hidden', mode !== 'phase');
    const rows = anaRows();
    const bounds = anaBounds(rows);
    S.analysis.range = anaClampRange(S.analysis.range, bounds);
    const xid = D.anaSignal ? D.anaSignal.value : S.analysis.x;
    const yid = D.anaSignalY ? D.anaSignalY.value : S.analysis.y;
    S.analysis.x = xid || '';
    S.analysis.y = yid || '';
    anaDrawPreview(rows, xid, S.analysis.range);
    anaDrawTimeAxis(rows, S.analysis.range);
    anaUpdateRangeText();
    const sx = anaSeries(xid, rows, S.analysis.range);
    if (!sx) {
      anaDrawEmpty('当前没有可用样本');
      D.anaInfo.textContent = '当前没有可用样本；连接后至少积累几秒，或点顶栏“同步”拉取服务端历史。';
      if (D.cardAnalysisSub) D.cardAnalysisSub.textContent = 'FFT / 极限环 · 暂无样本';
      return;
    }
    if (mode === 'phase') {
      const pair = anaPair(xid, yid, rows, S.analysis.range);
      if (!pair) {
        anaDrawEmpty('两个信号没有重叠样本');
        D.anaInfo.textContent = '两个信号没有可用样本，换一个信号。';
        return;
      }
      anaDrawPhase(
        { t: pair.t, v: pair.x, row: pair.rx },
        { t: pair.t, v: pair.y, row: pair.ry }
      );
    } else if (mode === 'limit') anaDrawLimit(sx);
    else anaDrawSpectrum(sx);
    const row = sx.row;
    const label = (row.name || row.id) + ' · ' + anaRangeText();
    if (D.cardAnalysisSub) D.cardAnalysisSub.textContent = label;
    S.dirty = true;
  }

  function anaOpen() {
    anaPopulate();
    requestAnimationFrame(() => {
      anaRefresh();
    });
  }

  // ---------------------------------------------------------------- 卡片悬浮面板
  const PANEL_NAMES = ['project', 'source', 'sample', 'analysis', 'sourceAdd'];

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
    if (name === 'source') {
      refreshUsbDevices(false);
      syncSourceConnectionUI();
    }
    if (name === 'analysis') anaOpen();
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

  // ---------------------------------------------------------------- USB 设备枚举 / 多调试器切换
  // GET /api/usb-devices：列出当前连接的**每一个**调试探针实例（含 USB 序列号）。
  // 同款多设备靠 adapter serial 区分；点选设备后连接时带 {iface, serial}。
  // 纯枚举、不占用设备；失败/不可用只在本区提示，不影响连接流程。
  let usbDevBusy = false;
  let usbDevLoaded = false;

  function devLabel(d) {
    if (!d) return '自动（OpenOCD 自选）';
    return (d.name || (d.vid + ':' + d.pid)) +
      (d.serial ? ' · ' + String(d.serial).slice(-6) : '');
  }

  // 统一记录「当前选中的调试器」并同步 connPill / 持久化。
  // dev 为 null 表示回到「自动」。
  function setUsbDevice(dev) {
    if (dev && dev.serial) {
      S.usb.serial = dev.serial;
      S.usb.iface = dev.iface || '';
      S.usb.name = dev.name || (dev.vid + ':' + dev.pid);
      S.usb.label = devLabel(dev);
    } else {
      S.usb.serial = '';
      S.usb.iface = '';
      S.usb.name = '';
      S.usb.label = '自动（OpenOCD 自选）';
    }
    saveLocal();
    updateConnPill();
  }

  function renderUsbDevices(data) {
    const box = $('#usbDevList');
    const hint = $('#usbDevHint');
    if (!box) return;
    S.usb.available = !!(data && data.ok && data.available);
    if (!data || !data.ok || !data.available) {
      box.innerHTML = '<div class="usb-dev-err">' +
        esc((data && data.error) || 'USB 枚举不可用') + '</div>';
      if (hint) hint.textContent = '枚举不可用时仍可点“连接”，OpenOCD 会自选第一个设备。';
      return;
    }
    const list = Array.isArray(data.supported) ? data.supported : [];
    S.usb.devices = list;
    if (hint) {
      hint.textContent = '枚举方式：' + (data.method || '?') + ' · 发现 ' + list.length +
        ' 个调试器。点击选中（靠序列号区分同款设备），再点“连接”切换。';
    }
    // 「自动」项 + 每个物理设备一项
    const autoSel = !S.usb.serial;
    let html = '<div class="usb-dev' + (autoSel ? ' active' : '') +
      '" role="button" tabindex="0" data-serial="" data-auto="1" ' +
      'title="不指定序列号，由 OpenOCD 自选第一个设备">' +
      '<div class="usb-dev-top"><span class="usb-dev-dot"></span>' +
      '<span class="usb-dev-name">自动（OpenOCD 自选）</span>' +
      (autoSel ? '<span class="usb-dev-tag on">当前</span>' : '') + '</div>' +
      '<div class="usb-dev-meta">不指定 adapter serial</div></div>';
    html += list.map((d) => {
      const name = d.name || d.product || (d.vid + ':' + d.pid);
      const selected = d.serial && d.serial === S.usb.serial;
      const metaBits = [];
      if (d.vid && d.pid) metaBits.push(d.vid.toUpperCase() + ':' + d.pid.toUpperCase());
      if (d.serial) metaBits.push('S/N ' + d.serial);
      if (d.transport) metaBits.push(d.transport);
      const arch = d.arch === 'riscv' ? 'RISC-V' : d.arch === 'cw32' ? 'ARM' : '';
      if (arch) metaBits.push(arch);
      if (d.status) metaBits.push(d.status);
      return '<div class="usb-dev' + (selected ? ' active' : '') + '" role="button" tabindex="0" ' +
          'data-serial="' + esc(d.serial || '') + '" data-iface="' + esc(d.iface || '') + '" ' +
          'data-name="' + esc(name) + '" title="点击选中该调试器，点连接后切换">' +
        '<div class="usb-dev-top">' +
          '<span class="usb-dev-dot' + (d.status && d.status !== 'OK' ? ' off' : '') + '"></span>' +
          '<span class="usb-dev-name">' + esc(name) + '</span>' +
          (selected ? '<span class="usb-dev-tag on">当前</span>'
                    : (d.backend ? '<span class="usb-dev-tag">' + esc(d.backend) + '</span>' : '')) +
        '</div>' +
        '<div class="usb-dev-meta">' + esc(metaBits.join(' · ')) + '</div>' +
      '</div>';
    }).join('');
    box.innerHTML = html;
    box.querySelectorAll('.usb-dev').forEach((el) => {
      const pick = () => {
        if (el.dataset.auto) {
          setUsbDevice(null);
          toast('已切回自动选择调试器，点“连接”生效', 'ok');
        } else {
          const dev = S.usb.devices.find((x) => x.serial === el.dataset.serial) || {
            serial: el.dataset.serial, iface: el.dataset.iface, name: el.dataset.name,
          };
          setUsbDevice(dev);
          toast('已选中 ' + devLabel(dev) + '，点“连接”切换', 'ok');
        }
        renderUsbDevices({ ok: true, available: true, supported: S.usb.devices,
                           method: data.method });
        // 已连接时自动按新设备重连，省一次手动点
        const mode = D.srcSegMode || S.lastMode || 'openocd';
        if (sourceConnected(S.source) && mode === 'openocd') doConnect('openocd');
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  async function refreshUsbDevices(force) {
    const box = $('#usbDevList');
    if (!box || usbDevBusy) return;
    if (usbDevLoaded && !force) return;
    usbDevBusy = true;
    const btn = $('#btnUsbRefresh');
    if (btn) btn.disabled = true;
    box.innerHTML = '<span class="usb-dev-empty">正在检测…</span>';
    try {
      const data = await fetchJSON('/api/usb-devices', { timeout: 12000 });
      usbDevLoaded = true;
      renderUsbDevices(data);
    } catch (e) {
      renderUsbDevices({ ok: false, error: '枚举失败: ' + (e.message || e) });
    } finally {
      usbDevBusy = false;
      if (btn) btn.disabled = false;
    }
  }

  // connPill 文本：连接状态 + 当前调试器 + 采样率；并动态维护 title。
  function updateConnPill() {
    const kind = (S.source && S.source.kind) || 'none';
    const connected = sourceConnected(S.source) && !S.sampler.error;
    const label = kind === 'openocd' ? 'OpenOCD' : kind === 'attach' ? 'TCL'
      : kind === 'sim' ? '仿真' : '待连接';
    if (D.connText) D.connText.textContent = label;
    if (D.connRate) D.connRate.textContent =
      (S.sampler.rate_actual || S.sampler.rate || 0).toFixed(0) + ' Hz';
    if (D.connDev) {
      const txt = S.usb.name ? devLabel({ name: S.usb.name, serial: S.usb.serial }) : '';
      D.connDev.textContent = txt;
      D.connDev.hidden = !txt;
    }
    if (D.connPill) {
      D.connPill.classList.toggle('on', !!connected);
      D.connPill.classList.toggle('warn', !connected || !!S.sampler.error);
      const cur = S.usb.name || '自动（OpenOCD 自选）';
      D.connPill.title = connected
        ? 'SWD / SDI 总线占用：调试器正在读取目标内存\n当前调试器：' + cur + ' · 点击切换'
        : '未连接 / 调试器：' + cur + ' · 点击切换调试器';
    }
  }

  function syncRateOptions() {
    if (!D.rateSel) return;
    const max = S.arch === 'riscv' ? 50 : 300;
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
      if (label) label.textContent = 'WCH OpenOCD 根目录（留空 = 自动用 tools/openocd-wch-fast）';
      if (inp) inp.placeholder = '留空则只在工程 tools/ 下查找，或填你自己的 OpenOCD 根目录';
    } else {
      if (label) label.textContent = 'OpenOCD 根目录（留空 = 自动用 tools/openocd）';
      if (inp) inp.placeholder = '留空则只在工程 tools/ 下查找，或填自定义路径';
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
      if (e.target.closest('#chipBanner') || e.target.closest('#connPill')) return;
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
    // 只清浏览器显示；服务器 Recorder / .record-cache 继续录制。
    // displaySince 防止之后的 loadHistory 把刚清掉的旧样本又补回来。
    if (S.lastT > S.displaySince) S.displaySince = S.lastT;
    S.samples = [];
    S.lastT = 0;
    S.pauseAt = 0;
    S.paused = false;
    S.hoverT = null;
    S.cacheSamples = null;
    S.cacheRange = null;
    S.cacheLockAt = 0;
    S.analysis.range = null;
    S.measure.key = '';
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
    if (S.ui.panel === 'analysis') anaRefresh();
    toast('已清空当前显示（服务器录制继续）', 'ok');
  }

  async function snapshot() {
    const cv = D.chart;
    if (!cv) return;
    const name = 'motorscope_' + stamp() + '.png';
    let dataUrl = '';
    try {
      dataUrl = cv.toDataURL('image/png');
    } catch (e) {
      toast('截图失败: ' + brief(e.message), 'err');
      return;
    }
    // 先同步触发下载，避免异步等待丢失用户手势
    let downloaded = false;
    try {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      downloaded = true;
    } catch (e) {
      toast('下载截图失败: ' + brief(e.message), 'err');
    }
    // 再复制到剪贴板：Promise<Blob> 形式，Chrome/Safari 均可在手势内写入
    if (!navigator.clipboard || !window.ClipboardItem) {
      toast(downloaded ? '截图已下载（当前浏览器不支持图片剪贴板）' : '截图失败：浏览器不支持图片剪贴板',
            downloaded ? '' : 'err');
      return;
    }
    const okMsg = downloaded ? '截图已复制到剪贴板，同时已下载' : '截图已复制到剪贴板';
    const blobPromise = new Promise((resolve, reject) => {
      try {
        cv.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob 返回空'))),
                  'image/png');
      } catch (e) { reject(e); }
    });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blobPromise }),
      ]);
      toast(okMsg, 'ok');
      return;
    } catch (e) {
      // Safari 某些版本不接受 Promise，退化为等 Blob 后再写一次
      try {
        const blob = await blobPromise;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast(okMsg, 'ok');
        return;
      } catch (e2) {
        const why = brief(e2.message || e.message);
        toast(downloaded ? '截图已下载（复制到剪贴板失败：' + why + '）'
                         : '截图失败（下载和复制剪贴板都失败：' + why + '）',
              'err');
      }
    }
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
    const prevMcu = String(S.mcu.expected || '');
    const nextMcu = String(catalog.meta?.mcu || '');
    S.catalog = catalog;
    S.readVals.clear();
    if (prevMcu && nextMcu && prevMcu !== nextMcu) {
      // 换了型号：不能把上一个型号的寄存器模板混进新机型的目录
      S.mcu.active = '';
      S.mcu.periphs = [];
    }
    S.mcu.expected = nextMcu;
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
    adoptExpectedMcu();
    const mid = resolveMcuId(S.mcu.expected);
    if (!S.chip && mid) selectMcu(mid);
    applyChip(S.chip);
    renderCards();
    sendConfig(true);
    if (D.catalogMeta && catalog.meta) {
      const reg = catalog.meta.register_table
        ? ' · 寄存器表 ' + catalog.meta.register_table
        : '';
      D.catalogMeta.textContent = 'AXF ' + (catalog.meta.generated_at || '?') + ' · ' +
        (catalog.variables ? catalog.variables.length : 0) + ' 变量 / ' +
        (catalog.peripherals ? catalog.peripherals.length : 0) + ' 外设 · ' +
        stripStamp(catalog.meta.axf || '') + reg;
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

  // ---------------------------------------------------------------- 导入 / 新建机型
  let importBusy = false;
  let importSvdName = '';
  let importNameTouched = false;

  function importLabelOf(name) {
    const s = stripStamp(String(name || '').replace(/\.[^.]+$/, '')).trim();
    return s.slice(0, 64);
  }

  function importFileInfo(f) {
    if (!f) return '';
    const kb = f.size >= 1024 * 1024
      ? (f.size / 1024 / 1024).toFixed(1) + ' MB'
      : Math.max(1, Math.round(f.size / 1024)) + ' KB';
    return f.name + ' · ' + kb;
  }

  async function readSvdDeviceName(file) {
    if (!file || !/\.svd$/i.test(file.name)) return '';
    try {
      const text = await file.text();
      try {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const root = doc.documentElement;
        for (const child of root?.children || []) {
          if (String(child.tagName || '').toLowerCase() === 'name') {
            return String(child.textContent || '').trim();
          }
        }
      } catch {}
      const m = text.match(/<device\b[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i);
      return m ? m[1].trim() : '';
    } catch { return ''; }
  }

  async function refreshImportFiles() {
    const axf = D.importAxf?.files?.[0] || null;
    const table = D.importTable?.files?.[0] || null;
    importSvdName = await readSvdDeviceName(table);
    if (!importNameTouched && D.importName) {
      D.importName.value = importSvdName || importLabelOf(table?.name) || importLabelOf(axf?.name);
    }
    const bits = [];
    if (axf) bits.push('AXF/ELF：' + importFileInfo(axf));
    if (table) bits.push('寄存器表：' + importFileInfo(table));
    if (!bits.length) bits.push('选择 AXF/ELF 和/或 SVD 后继续。');
    if (!axf && table) bits.push('只替换当前机型的寄存器表；新建机型需要 AXF/ELF。');
    if (axf && !table) bits.push('未选 SVD：外设寄存器只能来自 AXF 的头文件或内置模板，可能为空。');
    if (axf && table) bits.push('AXF + SVD 会一起写入：变量来自 AXF，寄存器表来自 SVD。');
    const curMcu = String(S.mcu.expected || '').trim();
    if (importSvdName && curMcu && importSvdName.toUpperCase() !== curMcu.toUpperCase()) {
      bits.push('SVD 型号 ' + importSvdName + ' 与当前机型 ' + curMcu + ' 不同，建议新建机型。');
    }
    const active = S.profiles.active || '当前';
    if (D.btnImportUpdate) {
      D.btnImportUpdate.textContent = (axf || table) ? '更新 ' + active : '更新当前机型';
      D.btnImportUpdate.disabled = !!importBusy || (!axf && !table);
    }
    if (D.btnImportCreate) {
      D.btnImportCreate.disabled = !!importBusy || !axf;
      D.btnImportCreate.title = axf ? '' : '新建机型需要 AXF/ELF';
    }
    if (D.btnImportClose) D.btnImportClose.disabled = !!importBusy;
    if (D.btnImportCancel) D.btnImportCancel.disabled = !!importBusy;
    if (D.importHint) D.importHint.textContent = bits.join(' ');
  }

  function openImportModal(pick = false) {
    importNameTouched = false;
    importSvdName = '';
    if (D.importName) D.importName.value = '';
    D.importModal?.classList.remove('hidden');
    refreshImportFiles();
    if (pick) D.importAxf?.click();
    else setTimeout(() => D.importAxf?.focus(), 0);
  }

  function closeImportModal() {
    if (importBusy) return;
    D.importModal?.classList.add('hidden');
  }

  function applyImportedCatalog(data) {
    if (data.profiles) {
      S.profiles.items = data.profiles.items || S.profiles.items;
      S.profiles.active = data.profiles.active || S.profiles.active;
    }
    if (data.profile) {
      S.arch = data.profile.arch === 'riscv' ? 'riscv' : 'cw32';
      S.mcu.manual = false;
      syncArchUI();
    }
    if (data.catalog) applyCatalog(data.catalog);
    if (data.profile) S.mcu.expected = String(data.profile.mcu || S.mcu.expected || '');
    adoptExpectedMcu();
    renderMachines();
    updateProjectUI();
    renderCards();
  }

  async function adoptImportedProfile(data) {
    const prof = data.profile || {};
    S.profileSavedAt = 0;
    if (data.profiles) {
      S.profiles.items = data.profiles.items || S.profiles.items;
      S.profiles.active = data.profiles.active || S.profiles.active;
    }
    S.profiles.loaded = true;
    if (prof.id) S.profiles.active = prof.id;
    S.catalog = data.catalog || { variables: [], peripherals: [], defaults: [], stall: {}, meta: {} };
    S.chip = null;
    S.lastChipKey = '';
    S.mcu.detected = '';
    S.mcu.candidates = [];
    S.mcu.exact = false;
    S.mcu.warning = '';
    S.mcu.manual = false;
    S.mcu.active = '';
    S.mcu.periphs = [];
    S.arch = prof.arch === 'riscv' ? 'riscv' : 'cw32';
    S.mcu.expected = String(prof.mcu || S.catalog.meta?.mcu || '');
    S.rows.clear();
    S.virtuals = [];
    S.samples = [];
    S.lastT = 0;
    resetMachineWorkspace();
    buildIndex();
    adoptExpectedMcu();
    const mcuId = resolveMcuId(S.mcu.expected);
    if (mcuId) selectMcu(mcuId);
    const cfg = data.config && (Array.isArray(data.config.rows) || Array.isArray(data.config.signals))
      ? Object.assign({}, data.config, { machine: S.profiles.active })
      : {};
    ensureMachineProjects();
    const p = readProjects();
    let name = findProjectByMachine(S.profiles.active);
    if (!name) name = uniqueProjectName(S.profiles.active);
    p.items[name] = Object.assign({}, p.items[name] || {}, cfg, {
      name, machine: S.profiles.active, savedAt: new Date().toISOString(),
    });
    p.active = name;
    writeProjects(p);
    writeCfgRaw(JSON.stringify(cfg));
    restoreConfig(cfg);
    renderAfterProjectLoad();
    applyChip(null);
    renderMachines();
    syncArchUI();
    updateProjectUI();
    await refreshStatus();
    setTimeout(() => saveLocal(), 0);
  }

  async function copyCurrentProfile() {
    const base = S.profiles.active;
    if (!base) { toast('没有激活机型', 'err'); return; }
    const name = (prompt('新机型名称（复制当前机型 ' + base + '）', base + ' 副本') || '').trim();
    if (!name) return;
    saveLocal();
    await flushProfileSave(false);   // 先保存当前机型的界面配置，再切走
    try {
      toast('正在复制机型…');
      const res = await fetchJSON('/api/profiles/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, base }),
        timeout: 60000,
      });
      if (!res.ok) throw new Error(res.error || '复制失败');
      await adoptImportedProfile(res);
      toast('已新建机型：' + (res.profile?.id || name) + '（复制自 ' + base + '）' +
        (res.was_connected ? '（已断开，请重新连接）' : ''), 'ok');
    } catch (e) {
      toast('新建机型失败: ' + brief(e.message), 'err');
    }
  }

  async function doImport(target) {
    if (importBusy) return;
    const axf = D.importAxf?.files?.[0] || null;
    const table = D.importTable?.files?.[0] || null;
    if (!axf && !table) { toast('请选择 AXF/ELF 或寄存器表', 'err'); return; }
    if (target === 'new' && !axf) { toast('新建机型需要 AXF/ELF', 'err'); return; }
    const name = String(D.importName?.value || '').trim();
    if (target === 'new' && !name) {
      toast('请填写新机型名称', 'err');
      D.importName?.focus();
      return;
    }
    if (target === 'update' && table && /\.svd$/i.test(table.name)) {
      const svdName = importSvdName || await readSvdDeviceName(table);
      const cur = String(S.mcu.expected || '').trim();
      if (svdName && cur && svdName.toUpperCase() !== cur.toUpperCase()) {
        const ok = confirm('SVD 型号 ' + svdName + ' 与当前机型 ' + cur +
          ' 不一致。\n更新当前机型会替换' + (axf ? '变量与寄存器表' : '寄存器表') +
          '，确定继续？');
        if (!ok) return;
      }
    }
    const fd = new FormData();
    if (axf) fd.append('axf', axf, axf.name || 'firmware.axf');
    if (table) fd.append('table', table, table.name || 'registers.svd');
    fd.append('target', target);
    if (target === 'new') fd.append('name', name);
    fd.append('expect', 'header');
    if (target === 'new') {
      saveLocal();
      await flushProfileSave(false);   // 切换前先保存当前机型的界面配置
    }
    importBusy = true;
    const btn = target === 'new' ? D.btnImportCreate : D.btnImportUpdate;
    const old = btn ? btn.textContent : '';
    if (btn) btn.textContent = '导入中…';
    if (D.btnImportVars) D.btnImportVars.disabled = true;
    await refreshImportFiles();
    try {
      const res = await fetch('/api/catalog/import', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      if (!res.ok || !data.ok) throw new Error(data.error || '导入失败');
      importBusy = false;
      closeImportModal();
      if (data.created) {
        await adoptImportedProfile(data);
        toast('已新建机型「' + (data.profile?.id || name) + '」：' +
          (data.counts?.variables || 0) + ' 变量 / ' +
          (data.counts?.peripherals || 0) + ' 外设' +
          (data.was_connected ? '（已断开，请重新连接）' : ''), 'ok');
      } else {
        applyImportedCatalog(data);
        const what = (data.counts?.variables || 0) + ' 变量 / ' +
          (data.counts?.peripherals || 0) + ' 外设';
        toast((axf ? '固件' : '寄存器表') + '已更新：' + what, 'ok');
      }
      if (data.warning) toast(data.warning, 'err');
      if (D.importAxf) D.importAxf.value = '';
      if (D.importTable) D.importTable.value = '';
      importNameTouched = false;
      if (D.importName) D.importName.value = '';
    } catch (e) {
      toast('导入失败: ' + brief(e.message), 'err');
    } finally {
      importBusy = false;
      if (btn) btn.textContent = old || (target === 'new' ? '新建机型' : '更新当前机型');
      if (D.btnImportVars) D.btnImportVars.disabled = false;
      refreshImportFiles();
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
