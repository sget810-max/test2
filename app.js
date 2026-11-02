'use strict';
/* 路線図メーカー — 架空の路線図エディタ */
(() => {
  // ---------- 定数 ----------
  const STORE_KEY = 'rosenzu-maker-v1';
  const PREFS_KEY = 'rosenzu-maker-prefs';
  const PALETTE = ['#e60012', '#0079c2', '#009944', '#f39800', '#9b7cb6', '#00a7db',
    '#d7c447', '#a0522d', '#e85298', '#6cbb5a', '#333333', '#1a237e'];
  const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const DIR_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const GRID_ORDER = [7, 0, 1, 6, -1, 2, 5, 4, 3]; // 3x3グリッドの並び(-1=自動)
  const FONT = '"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic",Meiryo,sans-serif';
  const DOUBLE_TAP_MS = 350;
  const LANDMARKS = [
    ['temple', '卍', '寺院'], ['shrine', '⛩️', '神社'], ['tower', '🗼', 'タワー'], ['castle', '🏯', '城'],
    ['mountain', '⛰️', '山'], ['park', '🌳', '公園'], ['school', '🏫', '学校'], ['hospital', '🏥', '病院'],
    ['airport', '✈️', '空港'], ['port', '⚓', '港'], ['stadium', '🏟️', '競技場'], ['building', '🏢', 'ビル'],
    ['amusement', '🎡', '遊園地'], ['onsen', '♨️', '温泉'], ['star', '⭐', 'その他'],
  ];
  const LM = Object.fromEntries(LANDMARKS.map(([id, g, n]) => [id, { g, n }]));
  const TERRAIN_HINTS = {
    water: 'マスをタップ・なぞって水域（海・川・湖）にする ／ 2本指・右ドラッグで画面移動',
    land: 'マスをタップ・なぞって陸地に戻す ／ 2本指・右ドラッグで画面移動',
    landmark: 'タップでランドマークを配置 ／ ドラッグで移動 ／ ダブルタップで名前を編集',
  };
  const HINTS = {
    select: 'ダブルクリック（タップ）で駅を追加 ／ 駅をドラッグで移動（他の駅に重ねると乗換駅に統合）／ 背景ドラッグで範囲選択',
    range: 'ドラッグで範囲選択（Shiftで追加）／ 駅をタップで選択に追加・解除 ／ 選んだ駅はまとめて移動できます',
    station: 'ダブルクリック（タップ）で駅を追加 ／ 路線の上をダブルクリックするとその区間に駅を挿入',
    line: '駅をクリックで路線を延長（Shift+クリックで起点側）／ 線をタップで駅間を選び、ダブルクリックした場所を通るように曲げる（□はドラッグで移動・ダブルクリックで削除）',
    delete: '駅または路線をクリックして削除',
  };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  // 要素が見つからなくても(古い画面がキャッシュに残っている等)全体が止まらないようにする
  const on = (sel, ev, fn, opt) => { const el = $(sel); if (el) el.addEventListener(ev, fn, opt); };
  const svg = $('#map');
  const vp = $('#viewport');
  const gridRect = $('#gridRect');
  const gridPat = $('#gridPattern');
  const bgRect = $('#bgRect');
  const gLines = $('#gLines'), gHits = $('#gHits'), gStations = $('#gStations'),
    gLabels = $('#gLabels'), gPreview = $('#gPreview'), gSelUnder = $('#gSelUnder'), gSelOver = $('#gSelOver');
  const inspector = $('#inspector');
  const lineList = $('#lineList');
  const nameEditor = $('#nameEditor');
  const terrainVp = $('#terrainVp'), gTerrain = $('#gTerrain'), gTerrainPreview = $('#gTerrainPreview'), gLandmarks = $('#gLandmarks');

  // ---------- 状態 ----------
  let state;
  let prefs;
  let view = { x: 0, y: 0, k: 1 };
  let mode = 'select';
  let sel = null; // {type:'station', ids:[...]} | {type:'line', id, seg}
  let activeLineId = null;
  let undoStack = [], redoStack = [];
  let geom = null;
  let drag = null;
  let spaceDown = false;
  let editing = false;
  let cursorWorld = null;
  let lastTap = null;
  let nameEdit = null;
  const pointers = new Map();
  let terrainTool = 'water';
  let cellN = 1; // 一度に塗るマス数(一辺)
  let lmIcon = 'temple';
  let modeBeforeTerrain = 'select';

  // ---------- ユーティリティ ----------
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const segKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const r1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // すべての配置はグリッドに沿わせる
  const snap = (v) => Math.round(v / prefs.gridSize) * prefs.gridSize;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  // ---------- 操作設定(ブラウザごと) ----------
  function defaultPrefs() {
    return { snap: true, gridSize: 20, autoName: true, namePrefix: '新駅', bgDrag: 'auto', mergeOnDrop: true };
  }
  function loadPrefs() {
    const p = defaultPrefs();
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (typeof raw.snap === 'boolean') p.snap = raw.snap;
      if ([10, 20, 40].includes(raw.gridSize)) p.gridSize = raw.gridSize;
      if (typeof raw.autoName === 'boolean') p.autoName = raw.autoName;
      if (typeof raw.namePrefix === 'string') p.namePrefix = raw.namePrefix.slice(0, 20);
      if (['auto', 'select', 'pan'].includes(raw.bgDrag)) p.bgDrag = raw.bgDrag;
      if (typeof raw.mergeOnDrop === 'boolean') p.mergeOnDrop = raw.mergeOnDrop;
    } catch (_) { /* 無視 */ }
    return p;
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* 無視 */ }
  }

  // ---------- データ ----------
  function defaultSettings() {
    return { title: '架空鉄道 路線図', bg: '#ffffff', grid: true, fontSize: 14, showLegend: true, stationScale: 1, waterColor: '#a9d4f2' };
  }

  function emptyState() {
    return { version: 1, stations: {}, lines: [], bends: {}, waypoints: {}, terrain: { shapes: [], landmarks: [] }, settings: defaultSettings() };
  }

  function sampleState() {
    const s = emptyState();
    s.settings.title = '架空市 都市鉄道 路線図';
    const add = (id, name, sub, x, y, label = -1) => { s.stations[id] = { id, name, sub, x, y, label }; };
    add('nishiminato', '西港', 'Nishi-minato', -360, 0, 4);
    add('minatomachi', '港町', 'Minatomachi', -180, 0, 4);
    add('chuo', '中央', 'Chuō', 0, 0, 3);
    Object.assign(s.stations.chuo, { terminal: true, tw: 80, th: 40 });
    add('higashimachi', '東町', 'Higashimachi', 180, 0, 3);
    add('higashiyama', '東山', 'Higashiyama', 340, -100, 2);
    add('kitayama', '北山', 'Kitayama', -80, -300, 2);
    add('kitaguchi', '北口', 'Kitaguchi', 0, -160, 2);
    add('minamimachi', '南町', 'Minamimachi', 0, 160, 6);
    add('minamihama', '南浜', 'Minamihama', 120, 300, 2);
    add('daigaku', '大学前', 'Daigaku-mae', 180, -200, 2);
    add('hamabe', '浜辺公園', 'Hamabe-kōen', -200, 220, 6);
    s.lines = [
      { id: 'L1', name: '赤崎線', code: 'A', color: '#e60012', width: 8, loop: false,
        stations: ['nishiminato', 'minatomachi', 'chuo', 'higashimachi', 'higashiyama'] },
      { id: 'L2', name: '青葉線', code: 'B', color: '#0079c2', width: 8, loop: false,
        stations: ['kitayama', 'kitaguchi', 'chuo', 'minamimachi', 'minamihama'] },
      { id: 'L3', name: '環状線', code: 'C', color: '#009944', width: 8, loop: true,
        stations: ['kitaguchi', 'daigaku', 'higashimachi', 'minamimachi', 'hamabe', 'minatomachi'] },
      { id: 'L4', name: '臨海線', code: 'D', color: '#f39800', width: 6, loop: false,
        stations: ['minatomachi', 'chuo', 'higashimachi', 'minamihama'] },
    ];
    s.terrain.shapes = [
      { t: 'water', f: true, w: 0, p: [-700, 40, -460, 40, -330, 120, -280, 300, -120, 380, 140, 400, 320, 440, 480, 560, -700, 560] },
      { t: 'water', f: false, w: 30, p: [520, -420, 400, -330, 300, -260, 270, -140, 290, 20, 250, 200, 230, 330, 260, 440] },
    ].map((sh) => toCells(sh, 20));
    s.terrain.landmarks = [
      { id: 'lm1', x: -180, y: -180, icon: 'temple', name: '古寺' },
      { id: 'lm2', x: 100, y: -80, icon: 'tower', name: '架空タワー' },
      { id: 'lm3', x: -100, y: 100, icon: 'park', name: '中央公園' },
      { id: 'lm4', x: -460, y: 100, icon: 'port', name: '西港ふ頭' },
    ];
    return s;
  }

  /** 自由形状(旧形式)をマス目に変換 */
  function toCells(sh, g) {
    const pts = [];
    for (let i = 0; i < sh.p.length; i += 2) pts.push([sh.p[i], sh.p[i + 1]]);
    const h = sh.f ? 0 : Math.max(sh.w / 2, g / 2);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const cx0 = Math.floor((Math.min(...xs) - h) / g), cx1 = Math.floor((Math.max(...xs) + h) / g);
    const cy0 = Math.floor((Math.min(...ys) - h) / g), cy1 = Math.floor((Math.max(...ys) + h) / g);
    const out = [];
    const inPoly = (x, y) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const nearLine = (x, y) => {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        const t = L2 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / L2, 0, 1) : 0;
        if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= h) return true;
      }
      return false;
    };
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const x = (cx + 0.5) * g, y = (cy + 0.5) * g;
      if (sh.f ? inPoly(x, y) : nearLine(x, y)) out.push(cx, cy);
    }
    return out.length ? { t: sh.t, g, c: out } : null;
  }

  function normalize(raw) {
    const s = emptyState();
    if (!raw || typeof raw !== 'object') throw new Error('invalid');
    if (!raw.stations || typeof raw.stations !== 'object' || !Array.isArray(raw.lines)) throw new Error('invalid');
    for (const [id, st] of Object.entries(raw.stations)) {
      if (!st) continue;
      s.stations[id] = {
        id, name: String(st.name ?? ''), sub: String(st.sub ?? ''),
        x: Number(st.x) || 0, y: Number(st.y) || 0,
        label: Number.isInteger(st.label) && st.label >= -1 && st.label < 8 ? st.label : -1,
        ...(st.terminal ? { terminal: true, tw: clamp(Number(st.tw) || 80, 20, 400), th: clamp(Number(st.th) || 40, 20, 400) } : {}),
      };
    }
    s.lines = raw.lines.filter(Boolean).map((ln, i) => ({
      id: String(ln.id || uid('L')),
      name: String(ln.name ?? `路線${i + 1}`),
      code: String(ln.code ?? ''),
      color: /^#[0-9a-f]{6}$/i.test(ln.color) ? ln.color : PALETTE[i % PALETTE.length],
      width: clamp(Number(ln.width) || 8, 2, 20),
      loop: !!ln.loop,
      stations: (Array.isArray(ln.stations) ? ln.stations : []).filter((id) => s.stations[id]),
    }));
    s.bends = {};
    if (raw.bends && typeof raw.bends === 'object') {
      for (const [k, v] of Object.entries(raw.bends)) if ([1, 2, 3].includes(v)) s.bends[k] = v;
    }
    s.waypoints = {};
    if (raw.waypoints && typeof raw.waypoints === 'object') {
      for (const [k, v] of Object.entries(raw.waypoints)) {
        if (!Array.isArray(v)) continue;
        const wp = v.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
        if (wp.length) s.waypoints[k] = wp;
      }
    }
    Object.assign(s.settings, raw.settings || {});
    s.settings.fontSize = clamp(Number(s.settings.fontSize) || 14, 8, 40);
    s.settings.stationScale = clamp(Number(s.settings.stationScale) || 1, 0.5, 2);
    if (!/^#[0-9a-f]{6}$/i.test(s.settings.waterColor)) s.settings.waterColor = defaultSettings().waterColor;
    const T = raw.terrain || {};
    s.terrain.shapes = (Array.isArray(T.shapes) ? T.shapes : [])
      .filter((sh) => sh && (sh.t === 'water' || sh.t === 'land'))
      .map((sh) => {
        if (Array.isArray(sh.c)) {
          const g = clamp(Number(sh.g) || 20, 5, 200);
          const c = sh.c.filter(Number.isInteger);
          return c.length >= 2 && c.length % 2 === 0 ? { t: sh.t, g, c } : null;
        }
        if (!Array.isArray(sh.p) || sh.p.length < 2 || sh.p.length % 2 || !sh.p.every(Number.isFinite)) return null;
        return toCells({ t: sh.t, f: !!sh.f, w: clamp(Number(sh.w) || 0, 0, 400), p: sh.p }, 20);
      })
      .filter(Boolean);
    s.terrain.landmarks = (Array.isArray(T.landmarks) ? T.landmarks : [])
      .filter((l) => l && Number.isFinite(l.x) && Number.isFinite(l.y))
      .map((l) => ({ id: String(l.id || uid('m')), x: l.x, y: l.y, icon: LM[l.icon] ? l.icon : 'star', name: String(l.name ?? '') }));
    return s;
  }

  function saveNow() {
    clearTimeout(save.timer);
    save.timer = null;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* 保存不可 */ }
  }
  function save() {
    clearTimeout(save.timer);
    save.timer = setTimeout(saveNow, 300);
  }
  // ページを閉じる・切り替える直前に保存し損ねないようにする
  window.addEventListener('pagehide', () => { if (save.timer) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && save.timer) saveNow(); });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (_) { /* 無視 */ }
    return null;
  }

  // ---------- 履歴 ----------
  function pushUndo() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    closeNameEditor(true, true);
    redoStack.push(JSON.stringify(state));
    state = normalize(JSON.parse(undoStack.pop()));
    afterHistory();
  }
  function redo() {
    if (!redoStack.length) return;
    closeNameEditor(true, true);
    undoStack.push(JSON.stringify(state));
    state = normalize(JSON.parse(redoStack.pop()));
    afterHistory();
  }
  function afterHistory() {
    validateSelection();
    renderAll();
    save();
  }
  function updateUndoButtons() {
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnRedo').disabled = !redoStack.length;
  }
  function validateSelection() {
    if (sel?.type === 'station') {
      sel.ids = sel.ids.filter((id) => state.stations[id]);
      if (!sel.ids.length) sel = null;
    }
    if (sel?.type === 'line' && !lineById(sel.id)) sel = null;
    if (sel?.type === 'landmark' && !landmarkById(sel.id)) sel = null;
    if (activeLineId && !lineById(activeLineId)) activeLineId = null;
  }

  function commit() {
    renderAll();
    save();
  }

  // ---------- 選択 ----------
  const selIds = () => (sel?.type === 'station' ? sel.ids.filter((id) => state.stations[id]) : []);
  function selectStations(ids) {
    const u = [...new Set(ids)].filter((id) => state.stations[id]);
    sel = u.length ? { type: 'station', ids: u } : null;
  }
  function toggleStation(id) {
    const ids = selIds();
    selectStations(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  // ---------- 操作 ----------
  const lineById = (id) => state.lines.find((l) => l.id === id);
  const activeLine = () => lineById(activeLineId);
  const landmarkById = (id) => state.terrain.landmarks.find((l) => l.id === id);

  function stationNear(x, y, excludeId) {
    let best = null, bd = 6;
    for (const s of Object.values(state.stations)) {
      if (s.id === excludeId) continue;
      if (s.terminal && Math.abs(x - s.x) <= s.tw / 2 && Math.abs(y - s.y) <= s.th / 2) return s;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= bd) { bd = d; best = s; }
    }
    return best;
  }

  function nextStationName() {
    const prefix = prefs.namePrefix || '新駅';
    const names = new Set(Object.values(state.stations).map((s) => s.name));
    let i = 1;
    while (names.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  function createStation(x, y) {
    const id = uid('s');
    state.stations[id] = { id, name: nextStationName(), sub: '', x, y, label: -1 };
    return state.stations[id];
  }

  function createLine() {
    const used = new Set(state.lines.map((l) => l.color));
    const color = PALETTE.find((c) => !used.has(c)) || PALETTE[state.lines.length % PALETTE.length];
    const codes = new Set(state.lines.map((l) => l.code));
    let code = 'A';
    for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!codes.has(c)) { code = c; break; } }
    const ln = { id: uid('L'), name: `新路線${state.lines.length + 1}`, code, color, width: 8, loop: false, stations: [] };
    state.lines.push(ln);
    activeLineId = ln.id;
    return ln;
  }

  function tidyLine(ln) {
    ln.stations = ln.stations.filter((s, i, a) => i === 0 || a[i - 1] !== s);
    if (ln.loop && ln.stations.length > 1 && ln.stations[0] === ln.stations[ln.stations.length - 1]) ln.stations.pop();
    if (ln.stations.length < 3) ln.loop = false;
  }

  function deleteStations(ids) {
    const set = new Set(ids);
    for (const id of set) delete state.stations[id];
    for (const ln of state.lines) {
      ln.stations = ln.stations.filter((s) => !set.has(s));
      tidyLine(ln);
    }
    cleanBends();
    validateSelection();
  }

  function deleteLine(id) {
    state.lines = state.lines.filter((l) => l.id !== id);
    if (activeLineId === id) activeLineId = state.lines[0]?.id ?? null;
    if (sel?.type === 'line' && sel.id === id) sel = null;
    cleanBends();
  }

  function cleanBends() {
    const used = new Set();
    for (const ln of state.lines) for (const [p, q] of linePairs(ln)) used.add(segKey(p, q));
    for (const k of Object.keys(state.bends)) if (!used.has(k)) delete state.bends[k];
    for (const k of Object.keys(state.waypoints)) if (!used.has(k)) delete state.waypoints[k];
  }

  function removeFromLine(lineId, stationId) {
    const ln = lineById(lineId);
    if (!ln) return;
    ln.stations = ln.stations.filter((s) => s !== stationId);
    tidyLine(ln);
    cleanBends();
  }

  function setTerminal(st, on) {
    if (!st) return;
    if (on) {
      st.terminal = true;
      st.tw = st.tw || prefs.gridSize * 4;
      st.th = st.th || prefs.gridSize * 2;
    } else {
      delete st.terminal; delete st.tw; delete st.th;
    }
  }

  /** fromId の駅を toId の駅に統合(乗換駅化) */
  function mergeStations(fromId, toId) {
    const from = state.stations[fromId], to = state.stations[toId];
    if (!from || !to) return;
    if (!to.sub && from.sub) to.sub = from.sub;
    for (const ln of state.lines) {
      ln.stations = ln.stations.map((s) => (s === fromId ? toId : s));
      tidyLine(ln);
    }
    delete state.stations[fromId];
    cleanBends();
  }

  /** 路線を延長。変更があれば true */
  function extendLine(stationId, prepend) {
    let ln = activeLine();
    if (ln) {
      const s = ln.stations;
      if (prepend ? s[0] === stationId : s[s.length - 1] === stationId) return false;
    }
    pushUndo();
    if (!ln) ln = createLine();
    const s = ln.stations;
    if (!prepend && !ln.loop && s.length >= 3 && s[0] === stationId) {
      ln.loop = true;
      toast(`「${ln.name}」を環状線にしました`);
    } else if (prepend) {
      s.unshift(stationId);
    } else {
      s.push(stationId);
    }
    sel = { type: 'line', id: ln.id, seg: null };
    return true;
  }

  /** 区間 a-b に駅を挿入(その区間を通る全路線に) */
  function insertIntoSegment(key, station) {
    const [a, b] = key.split('|');
    for (const ln of state.lines) {
      const s = ln.stations;
      for (let i = 0; i < s.length - 1; i++) {
        if ((s[i] === a && s[i + 1] === b) || (s[i] === b && s[i + 1] === a)) {
          s.splice(i + 1, 0, station.id);
          i++;
        }
      }
      if (ln.loop && s.length > 2) {
        const last = s[s.length - 1];
        if ((last === a && s[0] === b) || (last === b && s[0] === a)) s.push(station.id);
      }
    }
    delete state.bends[key];
    delete state.waypoints[key];
  }

  /** 位置 w に駅を置く(線の上なら区間に挿入)。作成/既存の駅を返す。履歴は呼び出し側で */
  function placeStation(w, seg) {
    const x = snap(w.x), y = snap(w.y);
    const existing = stationNear(x, y);
    const st = existing || createStation(x, y);
    if (seg) {
      const [a, b] = seg.split('|');
      if (st.id !== a && st.id !== b) insertIntoSegment(seg, st);
    }
    return { st, created: !existing };
  }

  // ---------- ジオメトリ ----------
  function linePairs(ln) {
    const s = ln.stations, out = [];
    for (let i = 0; i < s.length - 1; i++) if (s[i] !== s[i + 1]) out.push([s[i], s[i + 1]]);
    if (ln.loop && s.length > 2 && s[0] !== s[s.length - 1]) out.push([s[s.length - 1], s[0]]);
    return out;
  }

  /** 8方向(0/45/90度)で a→b を結ぶ折れ線。bend: 0/1=折れ方, 2=直線 */
  function routePoints(a, b, bend) {
    const A = [a.x, a.y], B = [b.x, b.y];
    if (bend === 2) return [A, B];
    const dx = b.x - a.x, dy = b.y - a.y, adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < 0.5 || ady < 0.5 || Math.abs(adx - ady) < 0.5) return [A, B];
    const sx = Math.sign(dx), sy = Math.sign(dy);
    let m;
    if (adx > ady) m = bend ? [a.x + sx * ady, b.y] : [b.x - sx * ady, a.y];
    else m = bend ? [b.x, a.y + sy * adx] : [a.x, b.y - sy * adx];
    return [A, m, B];
  }

  /** Catmull-Rom 曲線で点列をなめらかにつなぐ */
  function splinePoints(nodes) {
    const P = nodes.map((n) => [n.x, n.y]);
    if (P.length < 3) return P;
    const out = [P[0]];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
      const steps = Math.max(6, Math.ceil(dist(p1, p2) / 12));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((j) => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    return out;
  }

  /** 区間(正規化キー a<b)の中心線。経由点と曲がり方(0,1=折れ線 2=直線 3=曲線)を反映 */
  function segmentRoute(key) {
    const [a, b] = key.split('|');
    const nodes = [state.stations[a], ...(state.waypoints[key] || []).map((p) => ({ x: p[0], y: p[1] })), state.stations[b]];
    const bend = state.bends[key] || 0;
    if (bend === 3) {
      if (nodes.length > 2) return splinePoints(nodes);
      // 経由点がないときは、折れ線の角を制御点にしたなめらかなカーブにする
      const r = routePoints(nodes[0], nodes[1], 0);
      if (r.length < 3) return r;
      const [A, M, B] = r, out = [];
      const steps = Math.max(8, Math.ceil((dist(A, M) + dist(M, B)) / 12));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        out.push([u * u * A[0] + 2 * u * t * M[0] + t * t * B[0], u * u * A[1] + 2 * u * t * M[1] + t * t * B[1]]);
      }
      return out;
    }
    const pts = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const leg = routePoints(nodes[i], nodes[i + 1], bend);
      pts.push(...(i ? leg.slice(1) : leg));
    }
    return pts;
  }

  /** 経由点を入れる位置(何番目の区間の近くか) */
  function waypointInsertIndex(key, w) {
    const [a, b] = key.split('|');
    const nodes = [state.stations[a], ...(state.waypoints[key] || []).map((p) => ({ x: p[0], y: p[1] })), state.stations[b]];
    let best = 0, bd = Infinity;
    for (let i = 0; i < nodes.length - 1; i++) {
      const A = nodes[i], B = nodes[i + 1];
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
      const t = L2 ? clamp(((w.x - A.x) * dx + (w.y - A.y) * dy) / L2, 0, 1) : 0;
      const d = Math.hypot(w.x - A.x - t * dx, w.y - A.y - t * dy);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function offsetPolyline(pts, d) {
    if (!d) return pts.map((p) => p.slice());
    const n = pts.length, normals = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      const L = Math.hypot(dx, dy) || 1;
      normals.push([-dy / L, dx / L]);
    }
    return pts.map((p, i) => {
      let nx, ny;
      if (i === 0) [nx, ny] = normals[0];
      else if (i === n - 1) [nx, ny] = normals[n - 2];
      else {
        const a = normals[i - 1], b = normals[i];
        const s = 1 + a[0] * b[0] + a[1] * b[1];
        if (s < 0.2) [nx, ny] = a; else { nx = (a[0] + b[0]) / s; ny = (a[1] + b[1]) / s; }
      }
      return [p[0] + nx * d, p[1] + ny * d];
    });
  }

  function roundedPath(raw, r) {
    const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 0.01);
    if (pts.length < 2) return '';
    let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const l1 = dist(p0, p1), l2 = dist(p1, p2);
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const a = [p1[0] + (p0[0] - p1[0]) * rr / l1, p1[1] + (p0[1] - p1[1]) * rr / l1];
      const b = [p1[0] + (p2[0] - p1[0]) * rr / l2, p1[1] + (p2[1] - p1[1]) * rr / l2];
      d += ` L${r1(a[0])},${r1(a[1])} Q${r1(p1[0])},${r1(p1[1])} ${r1(b[0])},${r1(b[1])}`;
    }
    const last = pts[pts.length - 1];
    d += ` L${r1(last[0])},${r1(last[1])}`;
    return d;
  }

  function computeGeom() {
    const segs = new Map();
    for (const ln of state.lines) {
      for (const [p, q] of linePairs(ln)) {
        const k = segKey(p, q);
        let s = segs.get(k);
        if (!s) { const [a, b] = k.split('|'); s = { key: k, a, b, lines: [] }; segs.set(k, s); }
        if (!s.lines.includes(ln)) s.lines.push(ln);
      }
    }
    for (const s of segs.values()) {
      s.pts = segmentRoute(s.key);
      const n = s.lines.length;
      const sp = Math.max(...s.lines.map((l) => l.width)) + 2;
      s.off = new Map();
      s.lines.forEach((l, i) => s.off.set(l.id, (i - (n - 1) / 2) * sp));
    }
    const lines = new Map(), stPts = {}, stLines = {};
    for (const ln of state.lines) {
      const parts = [];
      const pts = [];
      for (const [p, q] of linePairs(ln)) {
        const s = segs.get(segKey(p, q));
        const op = offsetPolyline(s.pts, s.off.get(ln.id));
        if (p !== s.a) op.reverse();
        parts.push({ key: s.key, pts: op });
        if (pts.length && dist(pts[pts.length - 1], op[0]) < 0.01) pts.push(...op.slice(1));
        else pts.push(...op);
        (stPts[p] ??= []).push(op[0]);
        (stPts[q] ??= []).push(op[op.length - 1]);
      }
      lines.set(ln.id, { pts, parts });
      for (const id of new Set(ln.stations)) (stLines[id] ??= []).push(ln);
    }
    return { segs, lines, stPts, stLines };
  }

  function farthestPair(pts) {
    let best = [pts[0], pts[0]], bd = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const d = dist(pts[i], pts[j]);
      if (d > bd) { bd = d; best = [pts[i], pts[j]]; }
    }
    return best;
  }

  /** 駅名ラベルの自動配置方向 */
  function autoLabelDir(id) {
    const counts = new Array(8).fill(0);
    let any = false;
    for (const s of geom.segs.values()) {
      if (s.a !== id && s.b !== id) continue;
      const pts = s.pts;
      const [p0, p1] = s.a === id ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const dir = ((Math.round((ang + Math.PI / 2) / (Math.PI / 4)) % 8) + 8) % 8;
      counts[dir] = 1;
      any = true;
    }
    if (!any) return 2;
    const pref = [0, 4, 2, 6, 1, 3, 5, 7];
    let best = pref[0], bestScore = -1;
    for (const d of pref) {
      if (counts[d]) continue;
      const score = 3 - counts[(d + 1) % 8] - counts[(d + 7) % 8] + (d % 2 === 0 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  // ---------- 描画 ----------
  function stationRadius(lns) {
    const w = lns.length ? Math.max(...lns.map((l) => l.width)) : 8;
    return (w * 0.55 + 2.5) * (state.settings.stationScale || 1);
  }

  function stationShape(st) {
    if (st.terminal) return { p1: [st.x, st.y], p2: [st.x, st.y], R: 0, rect: { w: st.tw, h: st.th } };
    const pts = geom.stPts[st.id] || [[st.x, st.y]];
    const [p1, p2] = farthestPair(pts);
    const R = stationRadius(geom.stLines[st.id] || []);
    return { p1, p2, R };
  }

  function terminalMarkup(st) {
    const W = st.tw, H = st.th, x = st.x - W / 2, y = st.y - H / 2;
    const fs = state.settings.fontSize;
    const nameFs = r1(clamp(Math.min(fs * 1.25, (W - 10) / Math.max(1, [...st.name].length) * 1.05), 8, fs * 1.6));
    const subFs = r1(Math.min(fs * 0.62, (W - 8) / Math.max(1, st.sub.length) * 1.8));
    const showSub = st.sub && H >= nameFs + subFs + 8;
    const ny = st.y + (showSub ? -subFs / 2 - 1 : 0);
    let t = `<rect x="${r1(x - 7)}" y="${r1(y - 7)}" width="${r1(W + 14)}" height="${r1(H + 14)}" fill="transparent"/>`
      + `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(W)}" height="${r1(H)}" rx="${r1(Math.min(8, H / 4))}" fill="#fff" stroke="#222" stroke-width="3.5"/>`
      + `<rect x="${r1(x + 4)}" y="${r1(y + 4)}" width="${r1(W - 8)}" height="${r1(H - 8)}" rx="${r1(Math.min(5, H / 5))}" fill="none" stroke="#222" stroke-width="1"/>`;
    if (st.name) t += `<text x="${r1(st.x)}" y="${r1(ny)}" font-size="${nameFs}" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="#1d2330">${esc(st.name)}</text>`;
    if (showSub) t += `<text x="${r1(st.x)}" y="${r1(ny + nameFs / 2 + subFs / 2 + 2)}" font-size="${subFs}" text-anchor="middle" dominant-baseline="central" fill="#5b6472">${esc(st.sub)}</text>`;
    return t;
  }

  function stationMarkup(st) {
    if (st.terminal) return terminalMarkup(st);
    const lns = geom.stLines[st.id] || [];
    const { p1, p2, R } = stationShape(st);
    const inter = lns.length >= 2;
    const ring = inter ? '#222' : (lns[0]?.color || '#888');
    const bw = inter ? 2.5 : Math.max(2, R * 0.5);
    // タッチしやすいように透明な当たり判定を少し大きめに
    const hit = `<line x1="${r1(p1[0])}" y1="${r1(p1[1])}" x2="${r1(p2[0])}" y2="${r1(p2[1])}" stroke="transparent" stroke-width="${r1(2 * R + 14)}" stroke-linecap="round"/>`;
    if (dist(p1, p2) < 0.5) {
      return hit + `<circle cx="${r1(p1[0])}" cy="${r1(p1[1])}" r="${r1(R)}" fill="#fff" stroke="${ring}" stroke-width="${r1(bw)}"/>`;
    }
    const line = (w, c) => `<line x1="${r1(p1[0])}" y1="${r1(p1[1])}" x2="${r1(p2[0])}" y2="${r1(p2[1])}" stroke="${c}" stroke-width="${r1(w)}" stroke-linecap="round"/>`;
    return hit + line(2 * R + bw, ring) + line(2 * R - bw, '#fff');
  }

  function labelMarkup(st) {
    if (st.terminal || (!st.name && !st.sub)) return '';
    const fs = state.settings.fontSize;
    const subFs = Math.round(fs * 0.62 * 10) / 10;
    const dirIdx = st.label >= 0 ? st.label : autoLabelDir(st.id);
    const [dx, dy] = DIRS[dirIdx];
    const L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L;
    const { p1, p2, R } = stationShape(st);
    const cx = (p1[0] + p2[0]) / 2, cy = (p1[1] + p2[1]) / 2;
    const ext = Math.abs((p2[0] - p1[0]) * ux + (p2[1] - p1[1]) * uy) / 2 + R + 5;
    const px = cx + ux * ext, py = cy + uy * ext;
    const anchor = dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle';
    const h = fs + (st.sub ? subFs + 2 : 0);
    const top = dy < 0 ? py - h : dy > 0 ? py : py - h / 2;
    const y1 = top + fs * 0.88;
    const y2 = y1 + 2 + subFs;
    let t = `<text x="${r1(px)}" y="${r1(y1)}" font-size="${fs}" font-weight="700" text-anchor="${anchor}" fill="#1d2330" stroke="${esc(state.settings.bg)}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(st.name)}</text>`;
    if (st.sub) t += `<text x="${r1(px)}" y="${r1(y2)}" font-size="${subFs}" text-anchor="${anchor}" fill="#5b6472" stroke="${esc(state.settings.bg)}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(st.sub)}</text>`;
    return t;
  }

  function applyGrid() {
    const g = prefs.gridSize;
    gridPat.setAttribute('width', g);
    gridPat.setAttribute('height', g);
    gridPat.querySelector('path').setAttribute('d', `M${g} 0H0V${g}`);
  }

  function smoothPath(pts, closed) {
    if (!pts.length) return '';
    const f = (p) => `${r1(p[0])},${r1(p[1])}`;
    if (pts.length < 3) return `M${f(pts[0])} L${f(pts[pts.length - 1])}${closed ? 'Z' : ''}`;
    let d = `M${f(pts[0])}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
      d += ` Q${f(pts[i])} ${f(m)}`;
    }
    d += ` L${f(pts[pts.length - 1])}`;
    return closed ? d + 'Z' : d;
  }
  const unflat = (p) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push([p[i], p[i + 1]]); return o; };

  function shapeMarkup(sh, preview) {
    const col = sh.t === 'water' ? state.settings.waterColor : state.settings.bg;
    if (sh.c) {
      const g = sh.g;
      let d = '';
      for (let i = 0; i < sh.c.length; i += 2) d += `M${sh.c[i] * g} ${sh.c[i + 1] * g}h${g}v${g}h${-g}Z`;
      return `<path d="${d}" fill="${esc(col)}" stroke="${esc(col)}" stroke-width="0.6" shape-rendering="crispEdges"${preview ? ' fill-opacity="0.75"' : ''}/>`;
    }
    const pts = unflat(sh.p);
    if (sh.f) {
      if (preview) return `<path d="${smoothPath(pts, true)}" fill="${esc(col)}" fill-opacity="0.6" stroke="#0b8fd6" stroke-width="${r1(2 / view.k)}" stroke-dasharray="${r1(6 / view.k)} ${r1(4 / view.k)}"/>`;
      return `<path d="${smoothPath(pts, true)}" fill="${esc(col)}" stroke="${esc(col)}" stroke-width="2" stroke-linejoin="round"/>`;
    }
    return `<path d="${smoothPath(pts, false)}" fill="none" stroke="${esc(col)}" stroke-width="${sh.w}" stroke-linecap="round" stroke-linejoin="round"${preview ? ' stroke-opacity="0.75"' : ''}/>`;
  }

  function renderTerrain() {
    gTerrain.innerHTML = state.terrain.shapes.map((sh) => shapeMarkup(sh)).join('');
    renderTerrainPreview();
  }
  function renderTerrainPreview() {
    if (drag?.type !== 'paint') { gTerrainPreview.innerHTML = ''; return; }
    gTerrainPreview.innerHTML = drag.grid
      ? shapeMarkup({ t: drag.kind, g: drag.g, c: [...drag.cells].flatMap((k) => k.split(',').map(Number)) }, true)
      : shapeMarkup({ t: drag.kind, f: drag.fill, w: drag.w, p: drag.pts.flat() }, true);
  }

  function landmarkMarkup(l) {
    const k = state.settings.stationScale || 1;
    const r = 14 * k, fs = state.settings.fontSize;
    const glyph = LM[l.icon]?.g || '⭐';
    let t = `<g data-landmark="${esc(l.id)}" transform="translate(${r1(l.x)} ${r1(l.y)})">`
      + `<circle r="${r1(r + 6)}" fill="transparent"/>`
      + `<circle r="${r1(r)}" fill="#fff" stroke="#8a8f99" stroke-width="1.5"/>`
      + `<text y="${r1(r * 0.05)}" font-size="${r1(r * 1.15)}" text-anchor="middle" dominant-baseline="central">${esc(glyph)}</text>`;
    if (l.name) t += `<text y="${r1(r + fs * 0.85 + 3)}" font-size="${r1(fs * 0.8)}" text-anchor="middle" fill="#5b6472" stroke="${esc(state.settings.bg)}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(l.name)}</text>`;
    return t + '</g>';
  }

  function renderMap() {
    geom = computeGeom();
    renderTerrain();
    gLandmarks.innerHTML = state.terrain.landmarks.map(landmarkMarkup).join('');
    gLandmarks.setAttribute('font-family', FONT);
    const S = state.settings;
    bgRect.setAttribute('fill', S.bg);
    gridRect.style.display = S.grid || mode === 'terrain' ? '' : 'none';

    let lh = '', hh = '';
    for (let i = state.lines.length - 1; i >= 0; i--) {
      const ln = state.lines[i];
      const g = geom.lines.get(ln.id);
      if (!g.pts.length) continue;
      lh += `<path d="${roundedPath(g.pts, 14)}" fill="none" stroke="${esc(ln.color)}" stroke-width="${ln.width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    for (const ln of state.lines) {
      const g = geom.lines.get(ln.id);
      for (const part of g.parts) {
        hh += `<path data-line="${esc(ln.id)}" data-seg="${esc(part.key)}" d="${roundedPath(part.pts, 14)}" fill="none" stroke="transparent" stroke-width="${ln.width + 12}" stroke-linecap="round"/>`;
      }
    }
    gLines.innerHTML = lh;
    gHits.innerHTML = hh;

    let sh = '', th = '';
    for (const st of Object.values(state.stations)) {
      sh += `<g data-station="${esc(st.id)}">${stationMarkup(st)}</g>`;
      const lab = labelMarkup(st);
      if (lab) th += `<g data-station="${esc(st.id)}">${lab}</g>`;
    }
    gStations.innerHTML = sh;
    gLabels.innerHTML = th;
    gLabels.setAttribute('font-family', FONT);
    gStations.setAttribute('font-family', FONT);
    renderHandles();

    renderSelection();
    renderPreview();
    renderOverlays();
  }

  function renderHandles() {
    const g = $('#gHandles');
    const ln = mode === 'line' ? activeLine() : mode === 'select' && sel?.type === 'line' ? lineById(sel.id) : null;
    if (!ln) { g.innerHTML = ''; return; }
    const keys = new Set(linePairs(ln).map(([p, q]) => segKey(p, q)));
    const sz = 7 / view.k;
    let h = '';
    for (const k of keys) {
      (state.waypoints[k] || []).forEach((p, i) => {
        h += `<g data-wp="${esc(k)}" data-wpi="${i}"><circle cx="${p[0]}" cy="${p[1]}" r="${r1(sz * 2.2)}" fill="transparent"/>`
          + `<rect x="${r1(p[0] - sz)}" y="${r1(p[1] - sz)}" width="${r1(sz * 2)}" height="${r1(sz * 2)}" rx="${r1(sz * 0.4)}" fill="#fff" stroke="${esc(ln.color)}" stroke-width="${r1(2.5 / view.k)}"/></g>`;
      });
    }
    g.innerHTML = h;
  }

  function renderSelection() {
    let under = '', over = '';
    if (sel?.type === 'line') {
      const g = geom.lines.get(sel.id);
      const ln = lineById(sel.id);
      if (g && ln) {
        under += `<path d="${roundedPath(g.pts, 14)}" fill="none" stroke="#1f6feb" stroke-opacity="0.28" stroke-width="${ln.width + 12}" stroke-linejoin="round" stroke-linecap="round"/>`;
        const part = g.parts.find((p) => p.key === sel.seg);
        if (part) {
          over += `<path d="${roundedPath(part.pts, 14)}" fill="none" stroke="#1f6feb" stroke-opacity="0.45" stroke-width="${ln.width + 10}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
          over += `<path d="${roundedPath(part.pts, 14)}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>`;
        }
      }
    } else if (sel?.type === 'landmark') {
      const l = landmarkById(sel.id);
      if (l) over += `<circle cx="${r1(l.x)}" cy="${r1(l.y)}" r="${r1(14 * (state.settings.stationScale || 1) + 7)}" fill="#1f6feb" fill-opacity="0.25" pointer-events="none"/>`;
    } else {
      for (const id of selIds()) {
        const st0 = state.stations[id];
        if (st0.terminal) {
          over += `<rect x="${r1(st0.x - st0.tw / 2 - 7)}" y="${r1(st0.y - st0.th / 2 - 7)}" width="${r1(st0.tw + 14)}" height="${r1(st0.th + 14)}" rx="10" fill="#1f6feb" fill-opacity="0.25" pointer-events="none"/>`;
          continue;
        }
        const { p1, p2, R } = stationShape(st0);
        over += `<line x1="${r1(p1[0])}" y1="${r1(p1[1])}" x2="${r1(p2[0])}" y2="${r1(p2[1])}" stroke="#1f6feb" stroke-opacity="0.35" stroke-width="${r1(2 * R + 14)}" stroke-linecap="round" pointer-events="none"/>`;
      }
    }
    if (drag?.type === 'marquee' && drag.moved) {
      const x = Math.min(drag.start.x, drag.cur.x), y = Math.min(drag.start.y, drag.cur.y);
      const w = Math.abs(drag.cur.x - drag.start.x), h = Math.abs(drag.cur.y - drag.start.y);
      over += `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="#1f6feb" fill-opacity="0.08" stroke="#1f6feb" stroke-width="${r1(1.5 / view.k)}" stroke-dasharray="${r1(6 / view.k)} ${r1(4 / view.k)}" pointer-events="none"/>`;
    }
    gSelUnder.innerHTML = under;
    gSelOver.innerHTML = over;
  }

  function renderPreview() {
    const ln = activeLine();
    if (mode !== 'line' || !ln || !ln.stations.length || !cursorWorld || drag) { gPreview.innerHTML = ''; return; }
    // 延長は既存の駅をクリックしたときだけなので、駅の上にいるときだけ予告線を出す
    const target = stationNear(cursorWorld.x, cursorWorld.y);
    const last = state.stations[ln.stations[ln.stations.length - 1]];
    if (!target || target.id === last.id) { gPreview.innerHTML = ''; return; }
    const pts = routePoints(last, target, 0);
    gPreview.innerHTML = `<path d="${roundedPath(pts, 14)}" fill="none" stroke="${esc(ln.color)}" stroke-opacity="0.5" stroke-width="${ln.width}" stroke-dasharray="${ln.width * 1.5} ${ln.width}" stroke-linecap="round" pointer-events="none"/>`
      + `<circle cx="${target.x}" cy="${target.y}" r="5" fill="none" stroke="${esc(ln.color)}" stroke-width="2" pointer-events="none"/>`;
  }

  function applyView() {
    vp.setAttribute('transform', `translate(${r1(view.x)} ${r1(view.y)}) scale(${view.k})`);
    terrainVp.setAttribute('transform', `translate(${r1(view.x)} ${r1(view.y)}) scale(${view.k})`);
    gridPat.setAttribute('patternTransform', `translate(${r1(view.x)} ${r1(view.y)}) scale(${view.k})`);
    if (nameEdit) positionNameEditor();
    if (sel?.type === 'line' && geom) renderHandles();
  }

  function renderOverlays() {
    const S = state.settings;
    $('#mapTitle').textContent = S.title || '';
    const items = state.lines.filter((l) => l.stations.length > 1);
    $('#legend').innerHTML = S.showLegend && items.length
      ? items.map((l) => `<div class="legend-item">${l.code ? `<span class="badge" style="background:${esc(l.color)}">${esc(l.code)}</span>` : ''}<span class="bar" style="background:${esc(l.color)}"></span><span>${esc(l.name)}</span></div>`).join('')
      : '';
    const ln = activeLine();
    const n = selIds().length;
    let hint = mode === 'line' ? (ln ? `【${ln.name}】 ` : '【新しい路線】 ') + HINTS.line : HINTS[mode];
    if (mode === 'line' && sel?.type === 'line' && sel.seg && ln && sel.id === ln.id) {
      const [a, b] = sel.seg.split('|');
      if (state.stations[a] && state.stations[b]) hint = `【${ln.name}：${state.stations[a].name}–${state.stations[b].name} 間を選択中】ダブルクリックした場所を通るように曲げる ／ 別の駅間はタップで選び直し`;
    }
    if (mode === 'terrain') hint = '【地形】' + TERRAIN_HINTS[terrainTool];
    if (n > 1 && (mode === 'select' || mode === 'range')) hint = `${n}駅を選択中 ／ ドラッグでまとめて移動・矢印キーで微調整・Deleteで削除`;
    $('#hint').textContent = hint;
  }

  function renderLineChips() {
    $('#lineChips').innerHTML = state.lines.map((l) => `<button class="chip ${l.id === activeLineId ? 'active' : ''}" data-chip="${esc(l.id)}" style="background:${esc(l.color)}" title="${esc(l.name)}">${esc(l.code || l.name.slice(0, 1) || '?')}</button>`).join('')
      + '<button class="chip add" data-chip-add title="路線を追加">＋</button>';
    const tids = selIds();
    $('#btnTerminal').classList.toggle('active', !!tids.length && tids.every((id) => state.stations[id].terminal));
    const ln = activeLine();
    const rb = $('#btnReverse');
    rb.disabled = !ln || ln.stations.length < 2;
    rb.title = ln ? `「${ln.name}」の向きを反転` : '路線を選んでください';
  }

  function renderLineList() {
    renderLineChips();
    if (!state.lines.length) {
      lineList.innerHTML = '<li class="empty">路線がありません。「＋ 路線を追加」から作成しましょう。</li>';
      return;
    }
    lineList.innerHTML = state.lines.map((l) => `
      <li data-line-id="${esc(l.id)}" class="${l.id === activeLineId ? 'active' : ''}">
        <span class="badge" style="background:${esc(l.color)}">${esc(l.code || '　')}</span>
        <span class="name">${esc(l.name)}${l.loop ? ' ↻' : ''}</span>
        <span class="count">${l.stations.length}駅</span>
      </li>`).join('');
  }

  function renderInspector() {
    renderLineChips();
    const ids = selIds();
    if (ids.length === 1) return renderStationInspector(state.stations[ids[0]]);
    if (ids.length > 1) return renderMultiInspector(ids);
    if (sel?.type === 'line' && lineById(sel.id)) return renderLineInspector(lineById(sel.id));
    if (sel?.type === 'landmark' && landmarkById(sel.id)) return renderLandmarkInspector(landmarkById(sel.id));
    if (mode === 'terrain') return renderTerrainInspector();
    inspector.innerHTML = '<h2>選択中</h2><p class="muted">駅や路線をクリックすると、ここで名前や色などを編集できます。背景をドラッグ（スマホは「範囲」ツール）すると複数の駅をまとめて選択できます。</p>';
  }

  function dirGrid(current, auto) {
    return `<div class="dir-grid">${GRID_ORDER.map((d) => d === -1
      ? `<button data-act="label" data-dir="-1" class="${current === -1 ? 'on' : ''}" title="自動">自動</button>`
      : `<button data-act="label" data-dir="${d}" class="${current === d ? 'on' : ''} ${d === auto ? 'auto' : ''}" title="${d === auto ? '自動で選ばれている位置' : ''}">${DIR_ARROWS[d]}</button>`).join('')}</div>`;
  }

  function renderStationInspector(st) {
    const lns = state.lines.filter((l) => l.stations.includes(st.id));
    const auto = st.label < 0 ? autoLabelDir(st.id) : -2;
    const terminals = state.lines.filter((l) => !l.loop && l.stations.length && (l.stations[0] === st.id || l.stations[l.stations.length - 1] === st.id));
    inspector.innerHTML = `
      <h2>駅</h2>
      <label class="field">駅名 <input type="text" data-field="name" value="${esc(st.name)}" maxlength="40"></label>
      <label class="field">副駅名（英字・読みなど） <input type="text" data-field="sub" value="${esc(st.sub)}" maxlength="60"></label>
      <div class="field">駅の種類
        <div class="seg-toggle" style="align-self:flex-start">
          <button data-act="kind" data-kind="normal" class="${st.terminal ? '' : 'active'}">◯ 普通駅</button>
          <button data-act="kind" data-kind="terminal" class="${st.terminal ? 'active' : ''}">🚉 ターミナル駅</button>
        </div>
      </div>
      ${st.terminal ? `<div class="row">
        <div class="field">幅（マス）<div class="stepper"><button data-act="tsize" data-dim="tw" data-d="-1">－</button><span>${Math.round(st.tw / prefs.gridSize)}</span><button data-act="tsize" data-dim="tw" data-d="1">＋</button></div></div>
        <div class="field">高さ（マス）<div class="stepper"><button data-act="tsize" data-dim="th" data-d="-1">－</button><span>${Math.round(st.th / prefs.gridSize)}</span><button data-act="tsize" data-dim="th" data-d="1">＋</button></div></div>
      </div>` : `<div class="field">駅名の位置 ${dirGrid(st.label, auto)}</div>`}
      <div class="field">所属路線
        ${lns.length ? `<ul class="st-list">${lns.map((l) => `
          <li><span class="badge" style="background:${esc(l.color)}">${esc(l.code || '　')}</span>
          <span class="nm" data-act="goto-line" data-id="${esc(l.id)}">${esc(l.name)}</span>
          <button data-act="remove-from-line" data-id="${esc(l.id)}" title="この路線から外す">外す</button></li>`).join('')}</ul>`
        : '<span class="muted">どの路線にも属していません</span>'}
      </div>
      <div class="field">この駅から
        <div class="btn-row">
          ${terminals.map((l) => `<button class="small" data-act="extend-from" data-id="${esc(l.id)}"><span class="dot" style="background:${esc(l.color)}"></span>${esc(l.name)}を延長</button>`).join('')}
          <button class="small primary" data-act="new-line-from">＋ 新しい路線を始める</button>
        </div>
      </div>
      <div class="field">位置
        <div class="row">
          <label class="field">X <input type="number" data-field="x" value="${st.x}" step="${prefs.gridSize}"></label>
          <label class="field">Y <input type="number" data-field="y" value="${st.y}" step="${prefs.gridSize}"></label>
        </div>
      </div>
      <div class="btn-row"><button class="danger" data-act="delete-stations">この駅を削除</button></div>
      <p class="muted">駅をドラッグして別の駅に重ねると、1つの乗換駅に統合されます。矢印キーで位置を微調整できます。</p>`;
  }

  function lmGrid(cur) {
    return `<div class="lm-grid">${LANDMARKS.map(([id, g, n]) => `<button data-act="lm-icon" data-icon="${id}" class="${id === cur ? 'on' : ''}" title="${n}">${g}<small>${n}</small></button>`).join('')}</div>`;
  }

  function renderLandmarkInspector(l) {
    inspector.innerHTML = `
      <h2>ランドマーク</h2>
      <label class="field">名前 <input type="text" data-field="lmname" value="${esc(l.name)}" maxlength="40" placeholder="例: 架空タワー"></label>
      <div class="field">種類 ${lmGrid(l.icon)}</div>
      <div class="btn-row"><button class="danger" data-act="lm-delete">このランドマークを削除</button></div>
      <p class="muted">地形モードでドラッグすると移動、ダブルタップで名前を編集できます。</p>`;
  }

  function renderTerrainInspector() {
    const n = state.terrain.shapes.length, m = state.terrain.landmarks.length;
    inspector.innerHTML = `
      <h2>地形エディター</h2>
      <p class="muted">
        地形はすべて<b>グリッドのマス目単位</b>で塗ります。<br>
        <b>🌊 水域</b>: タップ・なぞったマスを海・川・湖にします。<br>
        <b>🟩 陸地</b>: タップ・なぞったマスを陸地に戻します。<br>
        一度に塗るマス数は上の「1マス／2×2／3×3／5×5」で、マスの大きさは操作設定の「グリッド間隔」で変えられます。<br>
        <b>📍 ランドマーク</b>: 種類を選んでタップで配置。ドラッグで移動、ダブルタップで名前を編集。<br>
        描いている間は2本指（パソコンは右ドラッグ／Space+ドラッグ）で画面を動かせます。
      </p>
      <div class="row">
        <label class="field">水の色 <input type="color" data-field="water" value="${esc(state.settings.waterColor)}"></label>
        <label class="field">陸地の色 <input type="color" data-field="land" value="${esc(state.settings.bg)}"></label>
      </div>
      <p class="muted">塗り: ${n}件 ／ ランドマーク: ${m}件</p>
      <div class="btn-row">
        <button class="danger small" data-act="terrain-clear-shapes" ${n ? '' : 'disabled'}>水域・陸地をすべて消す</button>
        <button class="danger small" data-act="terrain-clear-landmarks" ${m ? '' : 'disabled'}>ランドマークをすべて消す</button>
      </div>`;
  }

  function renderMultiInspector(ids) {
    const labels = new Set(ids.map((id) => state.stations[id].label));
    const cur = labels.size === 1 ? [...labels][0] : -2;
    const names = ids.slice(0, 12).map((id) => esc(state.stations[id].name)).join('、') + (ids.length > 12 ? ' ほか' : '');
    inspector.innerHTML = `
      <h2>${ids.length}駅を選択中</h2>
      <p class="muted">${names}</p>
      <div class="field">整列
        <div class="btn-row">
          <button class="small" data-act="align-h" title="Y座標をそろえる">横一列にそろえる</button>
          <button class="small" data-act="align-v" title="X座標をそろえる">縦一列にそろえる</button>
          <button class="small" data-act="distribute" ${ids.length < 3 ? 'disabled' : ''}>等間隔に並べる</button>
        </div>
      </div>
      <div class="field">駅の種類（まとめて変更）
        <div class="btn-row">
          <button class="small" data-act="kind" data-kind="normal">◯ 普通駅にする</button>
          <button class="small" data-act="kind" data-kind="terminal">🚉 ターミナル駅にする</button>
        </div>
      </div>
      <div class="field">駅名の位置（まとめて変更） ${dirGrid(cur, -2)}</div>
      <div class="field">路線
        <div class="btn-row">
          <button class="small primary" data-act="line-from-selection" ${ids.length < 2 ? 'disabled' : ''}>選んだ駅で新しい路線を作る</button>
        </div>
      </div>
      <div class="btn-row">
        <button data-act="clear-selection">選択解除</button>
        <button class="danger" data-act="delete-stations">${ids.length}駅を削除</button>
      </div>
      <p class="muted">選んだ駅はどれか1つをドラッグするとまとめて移動できます（矢印キーでも移動可）。</p>`;
  }

  function renderLineInspector(ln) {
    const segInfo = (() => {
      if (!sel.seg) return '';
      const [a, b] = sel.seg.split('|');
      if (!state.stations[a] || !state.stations[b]) return '';
      const cur = state.bends[sel.seg] || 0;
      const nwp = (state.waypoints[sel.seg] || []).length;
      return `<div class="field">選択区間: ${esc(state.stations[a].name)} – ${esc(state.stations[b].name)} の経路
        <div class="btn-row">
          ${['折れ線1', '折れ線2', '直線', '曲線'].map((t, i) => `<button class="small ${cur === i ? 'primary' : ''}" data-act="bend" data-bend="${i}">${t}</button>`).join('')}
        </div>
        <span class="muted">経由点: ${nwp}個 ${nwp ? '<button class="small" data-act="wp-clear">経由点をすべて消す</button>' : ''}<br>線をドラッグすると経由点ができ、経路を自由に曲げられます。□をドラッグで移動、ダブルタップで削除。</span>
      </div>`;
    })();
    inspector.innerHTML = `
      <h2>路線</h2>
      <div class="row">
        <label class="field" style="flex:3">路線名 <input type="text" data-field="lname" value="${esc(ln.name)}" maxlength="40"></label>
        <label class="field" style="flex:1">記号 <input type="text" data-field="code" value="${esc(ln.code)}" maxlength="3"></label>
      </div>
      <div class="field">ラインカラー
        <div class="row" style="align-items:center">
          <input type="color" data-field="color" value="${esc(ln.color)}">
          <div class="palette" style="margin:0">${PALETTE.map((c) => `<button data-act="color" data-color="${c}" class="${c === ln.color ? 'on' : ''}" style="background:${c}" title="${c}"></button>`).join('')}</div>
        </div>
      </div>
      <label class="field">線の太さ: <span id="widthVal">${ln.width}</span>px
        <input type="range" data-field="width" min="2" max="20" step="1" value="${ln.width}">
      </label>
      <label class="check"><input type="checkbox" data-field="loop" ${ln.loop ? 'checked' : ''} ${ln.stations.length < 3 ? 'disabled' : ''}> 環状線（終点と始発駅をつなぐ）</label>
      ${segInfo}
      <div class="field">駅一覧（${ln.stations.length}駅）
        ${ln.stations.length ? `<ul class="st-list">${ln.stations.map((id, i) => `
          <li><span class="idx">${i + 1}</span>
          <span class="nm" data-act="goto-station" data-id="${esc(id)}">${esc(state.stations[id]?.name || '?')}</span>
          <button data-act="move" data-i="${i}" data-d="-1" title="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-act="move" data-i="${i}" data-d="1" title="下へ" ${i === ln.stations.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-act="remove-index" data-i="${i}" title="路線から外す">✕</button></li>`).join('')}</ul>`
        : '<span class="muted">「路線」ツールで駅をクリックして追加してください</span>'}
      </div>
      <div class="btn-row">
        <button class="small" data-act="line-route" data-bend="3" title="この路線の全区間を曲線にする">全区間を曲線に</button>
        <button class="small" data-act="line-route" data-bend="0" title="この路線の全区間を折れ線に戻す">全区間を折れ線に</button>
        <button class="small" data-act="line-wp-clear" title="この路線の経由点をすべて消す">経由点をリセット</button>
      </div>
      <div class="btn-row">
        <button class="primary" data-act="draw-line">この路線を延長する</button>
        <button data-act="select-line-stations" ${ln.stations.length ? '' : 'disabled'}>駅をすべて選択</button>
        <button data-act="reverse" ${ln.stations.length < 2 ? 'disabled' : ''}>向きを反転</button>
        <button data-act="up-order" title="重なる区間で内側/外側の順序を変える">描画順 ↑</button>
        <button data-act="down-order">描画順 ↓</button>
        <button class="danger" data-act="delete-line">路線を削除</button>
      </div>`;
  }

  function renderSettings() {
    const S = state.settings;
    $('#setTitle').value = S.title;
    $('#setBg').value = S.bg;
    $('#setWater').value = S.waterColor;
    $('#setFont').value = S.fontSize;
    $('#setGrid').checked = S.grid;
    $('#setLegend').checked = S.showLegend;
    $('#setScale').value = S.stationScale;
    $('#prefGrid').value = String(prefs.gridSize);
    $('#prefAutoName').checked = prefs.autoName;
    $('#prefPrefix').value = prefs.namePrefix;
    $('#prefBgDrag').value = prefs.bgDrag;
    $('#prefMerge').checked = prefs.mergeOnDrop;
  }

  function renderAll() {
    renderMap();
    renderLineList();
    renderInspector();
    renderSettings();
    updateUndoButtons();
  }

  function setMode(m) {
    if (m === 'terrain' && mode !== 'terrain') { modeBeforeTerrain = mode; sel = null; }
    if (m !== 'terrain' && sel?.type === 'landmark') sel = null;
    mode = m;
    document.body.classList.toggle('terrain-on', m === 'terrain');
    $('#logoTerrain')?.classList.toggle('on', m === 'terrain');
    $('#logoRoute')?.classList.toggle('on', m !== 'terrain');
    renderTerrainControls();
    document.querySelectorAll('.tools [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    svg.setAttribute('class', `mode-${m}`);
    if (m === 'line' && !activeLine() && state.lines.length) activeLineId = state.lines[0].id;
    renderMap();
    renderLineList();
    renderInspector();
  }

  function renderTerrainControls() {
    document.body.classList.toggle('tt-landmark', terrainTool === 'landmark');
    document.querySelectorAll('[data-ttool]').forEach((b) => b.classList.toggle('active', b.dataset.ttool === terrainTool));
    document.querySelectorAll('[data-cells]').forEach((b) => b.classList.toggle('active', Number(b.dataset.cells) === cellN));
    $('#lmPalette').innerHTML = LANDMARKS.map(([id, g, n]) => `<button class="lm-chip ${id === lmIcon ? 'active' : ''}" data-lmicon="${id}" title="${n}">${g}</button>`).join('');
  }

  // ---------- 駅名のその場編集 ----------
  const editTarget = (ne) => (ne.kind === 'landmark' ? landmarkById(ne.id) : state.stations[ne.id]);
  function positionNameEditor() {
    const st = editTarget(nameEdit);
    if (!st) return;
    const stage = $('#stage').getBoundingClientRect();
    const bw = nameEditor.offsetWidth || 220, bh = nameEditor.offsetHeight || 90;
    const sx = st.x * view.k + view.x, sy = st.y * view.k + view.y;
    let top = sy + 22;
    if (top + bh > stage.height - 8) top = sy - 22 - bh;
    nameEditor.style.left = clamp(sx - bw / 2, 8, stage.width - bw - 8) + 'px';
    nameEditor.style.top = clamp(top, 8, stage.height - bh - 8) + 'px';
  }

  function openNameEditor(id, isNew, kind = 'station') {
    const st = kind === 'landmark' ? landmarkById(id) : state.stations[id];
    if (!st) return;
    closeNameEditor(true);
    nameEdit = { id, kind, orig: { name: st.name, sub: st.sub }, pushed: false, isNew };
    $('#neName').value = st.name;
    $('#neName').placeholder = kind === 'landmark' ? 'ランドマークの名前' : '駅名';
    $('#neSub').value = st.sub || '';
    $('#neSub').hidden = kind === 'landmark';
    nameEditor.hidden = false;
    positionNameEditor();
    const inp = $('#neName');
    inp.focus({ preventScroll: true });
    inp.select();
  }

  function closeNameEditor(apply, silent) {
    if (!nameEdit) return;
    const ne = nameEdit;
    nameEdit = null;
    nameEditor.hidden = true;
    const st = editTarget(ne);
    if (!apply && st) {
      st.name = ne.orig.name;
      if (ne.kind !== 'landmark') st.sub = ne.orig.sub;
      if (ne.pushed) { undoStack.pop(); updateUndoButtons(); }
    }
    if (!silent) { renderMap(); renderInspector(); save(); }
  }

  nameEditor.addEventListener('input', (e) => {
    if (!nameEdit) return;
    const st = editTarget(nameEdit);
    if (!st) return;
    if (!nameEdit.pushed && !nameEdit.isNew) { pushUndo(); nameEdit.pushed = true; }
    if (e.target.id === 'neName') st.name = e.target.value;
    if (e.target.id === 'neSub') st.sub = e.target.value;
    renderMap();
  });
  nameEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); closeNameEditor(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeNameEditor(false); }
    e.stopPropagation();
  });
  nameEditor.addEventListener('focusout', (e) => {
    if (e.relatedTarget && nameEditor.contains(e.relatedTarget)) return;
    setTimeout(() => { if (nameEdit && !nameEditor.contains(document.activeElement)) closeNameEditor(true); }, 0);
  });
  on('#neOk', 'click', () => closeNameEditor(true));
  nameEditor.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ---------- 表示操作 ----------
  function screenPoint(e) {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toWorldPt(p) {
    return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
  }
  const toWorld = (e) => toWorldPt(screenPoint(e));
  function zoomAt(sx, sy, factor) {
    const k = clamp(view.k * factor, 0.15, 6);
    const wx = (sx - view.x) / view.k, wy = (sy - view.y) / view.k;
    view.k = k;
    view.x = sx - wx * k;
    view.y = sy - wy * k;
    applyView();
    if (drag?.type === 'marquee') renderSelection();
  }
  function fitView() {
    const r = svg.getBoundingClientRect();
    const sts = Object.values(state.stations);
    if (!sts.length) { view = { x: r.width / 2, y: r.height / 2, k: 1 }; applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sts) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y); }
    const pad = 120;
    const k = clamp(Math.min(r.width / (x1 - x0 + pad * 2), r.height / (y1 - y0 + pad * 2)), 0.15, 1.6);
    view.k = k;
    view.x = r.width / 2 - ((x0 + x1) / 2) * k;
    view.y = r.height / 2 - ((y0 + y1) / 2) * k;
    applyView();
  }

  // ---------- ポインタ操作 ----------
  /** 背景をドラッグしたときの動作 */
  function bgDragKind(e) {
    if (mode === 'line') return 'pan';
    if (mode === 'range') return 'marquee';
    if (e.shiftKey) return 'marquee';
    if (prefs.bgDrag === 'select') return 'marquee';
    if (prefs.bgDrag === 'pan') return 'pan';
    return e.pointerType === 'touch' ? 'pan' : 'marquee';
  }

  function startBgDrag(e, sp, w, opts) {
    const kind = bgDragKind(e);
    if (kind === 'marquee') {
      drag = { type: 'marquee', sp, start: w, cur: w, moved: false, add: e.shiftKey || mode === 'range', base: selIds(), ...opts };
    } else {
      drag = { type: 'pan', sp, orig: { ...view }, moved: false, ...opts };
    }
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    if (drag?.type === 'station' && drag.moved) finishStationDrag();
    const hadPaint = drag?.type === 'paint';
    drag = {
      type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...view },
    };
    lastTap = null;
    if (hadPaint) renderTerrainPreview();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (nameEdit) closeNameEditor(true);
    // 互換マウスイベントで直後に開く入力欄のフォーカスが外れないようにする
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const sp = screenPoint(e);
    pointers.set(e.pointerId, sp);
    svg.setPointerCapture(e.pointerId);
    if (pointers.size === 2 && e.pointerType === 'touch') { startPinch(); return; }
    if (pointers.size > 1) return;

    const w = toWorld(e);
    const stEl = e.target.closest('[data-station]');
    const lnEl = e.target.closest('[data-line]');

    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { type: 'pan', sp, orig: { ...view }, moved: false }; return; }

    if (mode === 'terrain') {
      const lmEl = e.target.closest('[data-landmark]');
      if (lmEl) {
        const l = landmarkById(lmEl.dataset.landmark);
        if (!l) return;
        sel = { type: 'landmark', id: l.id };
        drag = { type: 'landmark', id: l.id, sp, start: w, orig: { x: l.x, y: l.y }, moved: false, tap: { kind: 'landmark', id: l.id, sp } };
        renderMap(); renderInspector();
        return;
      }
      if (terrainTool === 'landmark') {
        drag = { type: 'pan', sp, orig: { ...view }, moved: false, tap: { kind: 'lm-place', sp, w } };
        return;
      }
      drag = { type: 'paint', kind: terrainTool, grid: true, g: prefs.gridSize, n: cellN, cells: new Set(), pts: [[w.x, w.y]], sp, lastSp: sp };
      addCells(drag, w);
      renderTerrainPreview();
      return;
    }

    const wpEl = e.target.closest('[data-wp]');
    if (wpEl && (mode === 'select' || mode === 'line')) {
      const key = wpEl.dataset.wp, idx = Number(wpEl.dataset.wpi);
      const p = state.waypoints[key]?.[idx];
      if (p) {
        drag = { type: 'waypoint', key, idx, sp, start: w, orig: p.slice(), moved: false, tap: { kind: 'wp', key, idx, sp } };
        return;
      }
    }

    if (stEl) {
      const id = stEl.dataset.station;
      if (mode === 'delete') { pushUndo(); deleteStations([id]); commit(); return; }
      if (mode === 'line') {
        if (extendLine(id, e.shiftKey)) commit();
        return;
      }
      const ids = selIds();
      if (e.shiftKey || e.ctrlKey || e.metaKey || mode === 'range') {
        toggleStation(id);
        if (!selIds().includes(id)) { renderMap(); renderInspector(); return; }
      } else if (!ids.includes(id)) {
        selectStations([id]);
      }
      const origs = {};
      for (const sid of selIds()) origs[sid] = { x: state.stations[sid].x, y: state.stations[sid].y };
      drag = { type: 'station', anchor: id, start: w, origs, moved: false, tap: { kind: 'station', id, sp } };
      renderMap(); renderInspector();
      return;
    }

    if (lnEl) {
      const id = lnEl.dataset.line, seg = lnEl.dataset.seg;
      if (mode === 'delete') {
        const ln = lineById(id);
        if (ln && confirm(`路線「${ln.name}」を削除しますか？`)) { pushUndo(); deleteLine(id); commit(); }
        return;
      }
      if (mode === 'station') {
        startBgDrag(e, sp, w, { tap: { kind: 'line', seg, sp, w } });
        return;
      }
      if (mode === 'select') {
        activeLineId = id;
        sel = { type: 'line', id, seg };
        renderAll();
        // 線をドラッグすると経由点を作って経路を曲げる
        drag = { type: 'waypoint', key: seg, idx: -1, sp, start: w, orig: [w.x, w.y], moved: false, tap: { kind: 'line', seg, sp, w } };
        return;
      }
      if (mode === 'line') {
        // 線をタップ → その駅間を選択。次のダブルクリックでこの駅間を曲げる
        const changed = !(sel?.type === 'line' && sel.id === id && sel.seg === seg);
        activeLineId = id;
        sel = { type: 'line', id, seg };
        renderAll();
        if (changed) {
          const [a, b] = seg.split('|');
          toast(`${state.stations[a].name}–${state.stations[b].name} 間を選択。ダブルクリックした場所を通るように曲げます`);
        }
        drag = { type: 'pan', sp, orig: { ...view }, moved: false, tap: { kind: 'bg', sp, w } };
        return;
      }
      // 範囲モードでは線の上も背景と同じ扱い
    }

    // 背景（駅の作成はダブルクリックで行う）
    if (mode === 'station' || mode === 'line') {
      startBgDrag(e, sp, w, { tap: { kind: 'bg', sp, w, shift: e.shiftKey } });
      return;
    }
    startBgDrag(e, sp, w, { clickDeselect: true, tap: { kind: 'bg', sp, w } });
  });

  svg.addEventListener('pointermove', (e) => {
    const sp = screenPoint(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, sp);
    const w = toWorldPt(sp);
    cursorWorld = { x: snap(w.x), y: snap(w.y) };
    if (!drag) { if (mode === 'line') renderPreview(); return; }

    if (drag.type === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = clamp(drag.v0.k * d / drag.d0, 0.15, 6);
      const wx = (drag.m0.x - drag.v0.x) / drag.v0.k, wy = (drag.m0.y - drag.v0.y) / drag.v0.k;
      view.k = k; view.x = m.x - wx * k; view.y = m.y - wy * k;
      applyView();
      return;
    }

    const moved = Math.hypot(sp.x - (drag.sp?.x ?? sp.x), sp.y - (drag.sp?.y ?? sp.y)) >= 5;

    if (drag.type === 'paint') {
      if (Math.hypot(sp.x - drag.lastSp.x, sp.y - drag.lastSp.y) < 3) return;
      if (drag.grid) {
        // 速くなぞってもマスが飛ばないよう補間する
        const [px, py] = drag.pts[drag.pts.length - 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(w.x - px, w.y - py) / (drag.g / 2)));
        for (let i = 1; i <= steps; i++) addCells(drag, { x: px + (w.x - px) * i / steps, y: py + (w.y - py) * i / steps });
      }
      drag.pts.push([w.x, w.y]);
      drag.lastSp = sp;
      renderTerrainPreview();
      return;
    }
    if (drag.type === 'waypoint') {
      if (!drag.moved && !moved) return;
      const nx = snap(drag.orig[0] + (w.x - drag.start.x)), ny = snap(drag.orig[1] + (w.y - drag.start.y));
      if (!drag.moved) {
        pushUndo();
        drag.moved = true;
        lastTap = null;
        if (drag.idx < 0) {
          const list = (state.waypoints[drag.key] ??= []);
          drag.idx = waypointInsertIndex(drag.key, drag.start);
          list.splice(drag.idx, 0, [nx, ny]);
        }
      }
      const p = state.waypoints[drag.key]?.[drag.idx];
      if (!p) return;
      p[0] = nx; p[1] = ny;
      renderMap();
      return;
    }
    if (drag.type === 'landmark') {
      const l = landmarkById(drag.id);
      if (!l || (!drag.moved && !moved)) return;
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      const nx = snap(drag.orig.x + (w.x - drag.start.x)), ny = snap(drag.orig.y + (w.y - drag.start.y));
      if (nx === l.x && ny === l.y) return;
      l.x = nx; l.y = ny;
      gLandmarks.innerHTML = state.terrain.landmarks.map(landmarkMarkup).join('');
      renderSelection();
      return;
    }

    if (drag.type === 'station') {
      const a = drag.origs[drag.anchor];
      if (!a || !state.stations[drag.anchor]) { drag = null; return; }
      if (!drag.moved && !moved && Math.hypot(w.x - drag.start.x, w.y - drag.start.y) * view.k < 5) return;
      let nx = a.x + (w.x - drag.start.x), ny = a.y + (w.y - drag.start.y);
      nx = snap(nx); ny = snap(ny);
      const dx = nx - a.x, dy = ny - a.y;
      const cur = state.stations[drag.anchor];
      if (cur.x === nx && cur.y === ny) { drag.moved = drag.moved || false; return; }
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      for (const [id, o] of Object.entries(drag.origs)) {
        const st = state.stations[id];
        if (st) { st.x = o.x + dx; st.y = o.y + dy; }
      }
      renderMap();
      // 重ねると統合されることを予告
      if (prefs.mergeOnDrop && Object.keys(drag.origs).length === 1) {
        const target = stationNear(nx, ny, drag.anchor);
        $('#hint').textContent = target ? `離すと「${target.name}」に統合して乗換駅にします` : HINTS[mode];
      }
    } else if (drag.type === 'pan') {
      if (!drag.moved && !moved) return;
      drag.moved = true;
      svg.classList.add('panning');
      view.x = drag.orig.x + (sp.x - drag.sp.x);
      view.y = drag.orig.y + (sp.y - drag.sp.y);
      applyView();
    } else if (drag.type === 'marquee') {
      if (!drag.moved && !moved) return;
      drag.moved = true;
      drag.cur = w;
      const x0 = Math.min(drag.start.x, w.x), x1 = Math.max(drag.start.x, w.x);
      const y0 = Math.min(drag.start.y, w.y), y1 = Math.max(drag.start.y, w.y);
      const inside = Object.values(state.stations).filter((s) => s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1).map((s) => s.id);
      const prev = selIds().join(',');
      selectStations(drag.add ? [...drag.base, ...inside] : inside);
      renderSelection();
      if (selIds().join(',') !== prev) { renderOverlays(); }
    }
  });

  function finishStationDrag() {
    const ids = Object.keys(drag.origs);
    if (prefs.mergeOnDrop && ids.length === 1) {
      const st = state.stations[ids[0]];
      const target = st && stationNear(st.x, st.y, st.id);
      if (target) {
        mergeStations(st.id, target.id);
        selectStations([target.id]);
        toast(`「${st.name}」を「${target.name}」に統合しました（元に戻す で取り消し）`);
      }
    }
    commit();
  }

  function handleTap(tap, e) {
    const now = performance.now();
    const key = tap.kind === 'wp' ? `wp:${tap.key}:${tap.idx}` : tap.kind === 'landmark' ? 'lm:' + tap.id : tap.kind === 'station' ? 'st:' + tap.id : tap.kind === 'line' ? 'ln:' + tap.seg : 'bg';
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && lastTap.key === key &&
      Math.hypot(tap.sp.x - lastTap.sp.x, tap.sp.y - lastTap.sp.y) < 24) {
      lastTap = null;
      onDoubleTap(tap, e);
      return true;
    }
    lastTap = { t: now, key, sp: tap.sp };
    return false;
  }

  function addCells(d, w) {
    const cx = Math.floor(w.x / d.g), cy = Math.floor(w.y / d.g);
    const o = Math.floor((d.n - 1) / 2);
    for (let i = 0; i < d.n; i++) for (let j = 0; j < d.n; j++) d.cells.add(`${cx - o + i},${cy - o + j}`);
  }

  /** 路線ツールのダブルクリック: 選択中の路線の最寄り区間に経由点を足し、線路をそこへ通す */
  function addRoutePoint(w) {
    const ln = activeLine();
    const pairs = ln ? linePairs(ln) : [];
    if (!pairs.length) { toast('経路を変えたい路線（2駅以上）を上の路線ボタンで選んでください'); return; }
    let bestKey = null, bd = Infinity;
    // タップで駅間を選んでいれば、その駅間を曲げる
    if (sel?.type === 'line' && sel.id === ln.id && sel.seg && pairs.some(([p, q]) => segKey(p, q) === sel.seg)) bestKey = sel.seg;
    if (!bestKey) for (const [p, q] of pairs) {
      const k = segKey(p, q);
      const pts = geom.segs.get(k)?.pts || [];
      for (let i = 0; i < pts.length - 1; i++) {
        const A = pts[i], B = pts[i + 1];
        const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
        const t = L2 ? clamp(((w.x - A[0]) * dx + (w.y - A[1]) * dy) / L2, 0, 1) : 0;
        const d = Math.hypot(w.x - A[0] - t * dx, w.y - A[1] - t * dy);
        if (d < bd) { bd = d; bestKey = k; }
      }
    }
    if (!bestKey) return;
    const pt = [snap(w.x), snap(w.y)];
    const list = state.waypoints[bestKey] || [];
    if (list.some((p) => p[0] === pt[0] && p[1] === pt[1])) return;
    pushUndo();
    const idx = waypointInsertIndex(bestKey, { x: pt[0], y: pt[1] });
    list.splice(idx, 0, pt);
    state.waypoints[bestKey] = list;
    sel = { type: 'line', id: ln.id, seg: bestKey };
    commit();
    const [a, b] = bestKey.split('|');
    toast(`「${ln.name}」の ${state.stations[a].name}–${state.stations[b].name} 間をここに通しました`);
  }

  function finishPaint(d) {
    if (d.grid) {
      if (!d.cells.size) return;
      pushUndo();
      state.terrain.shapes.push({ t: d.kind, g: d.g, c: [...d.cells].flatMap((k) => k.split(',').map(Number)) });
      commit();
      return;
    }
    let pts = d.pts.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    if (d.fill && pts.length < 3) { renderTerrainPreview(); return; }
    if (pts.length === 1) pts.push(pts[0].slice());
    pushUndo();
    state.terrain.shapes.push({ t: d.kind, f: d.fill, w: d.fill ? 0 : d.w, p: pts.flat() });
    commit();
  }

  function placeLandmark(w) {
    pushUndo();
    const l = { id: uid('m'), x: snap(w.x), y: snap(w.y), icon: lmIcon, name: '' };
    state.terrain.landmarks.push(l);
    sel = { type: 'landmark', id: l.id };
    commit();
    openNameEditor(l.id, true, 'landmark');
  }

  function onDoubleTap(tap) {
    if (tap.kind === 'landmark') { openNameEditor(tap.id, false, 'landmark'); return; }
    if (tap.kind === 'wp') {
      pushUndo();
      const list = state.waypoints[tap.key];
      if (list) { list.splice(tap.idx, 1); if (!list.length) delete state.waypoints[tap.key]; }
      commit();
      toast('経由点を削除しました');
      return;
    }
    if (tap.kind === 'station') { openNameEditor(tap.id); return; }
    if (mode === 'line') { addRoutePoint(tap.w); return; }
    if (!['select', 'station', 'range'].includes(mode)) return;
    pushUndo();
    const { st, created } = placeStation(tap.w, tap.kind === 'line' ? tap.seg : null);
    selectStations([st.id]);
    commit();
    if (created) {
      toast(tap.kind === 'line' ? '区間に駅を挿入しました' : '駅を追加しました');
      if (prefs.autoName) openNameEditor(st.id, true);
    }
  }

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.type === 'pinch') {
      if (pointers.size < 2) drag = null;
      return;
    }
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (d.type === 'waypoint') {
      if (d.moved) { save(); renderInspector(); }
      else if (e.type === 'pointerup' && d.tap) handleTap(d.tap, e);
      return;
    }
    if (d.type === 'paint') { if (e.type === 'pointerup') finishPaint(d); else renderTerrainPreview(); return; }
    if (d.type === 'landmark') {
      if (d.moved) { save(); renderMap(); }
      else if (e.type === 'pointerup') handleTap(d.tap, e);
      return;
    }
    if (d.type === 'station') {
      if (d.moved) { drag = d; finishStationDrag(); drag = null; renderOverlays(); }
      else if (d.tap && e.type === 'pointerup') handleTap(d.tap, e);
      return;
    }
    if (d.type === 'marquee' && d.moved) {
      renderMap(); renderInspector();
      const n = selIds().length;
      if (n) toast(`${n}駅を選択しました`);
      lastTap = null;
      return;
    }
    if (d.type === 'pan' && d.moved) { lastTap = null; return; }
    // 動かずに離した = タップ
    if (e.type !== 'pointerup') return;
    if (d.tap?.kind === 'lm-place') { placeLandmark(d.tap.w); return; }
    if (d.tap && handleTap(d.tap, e)) return;
    if (d.clickDeselect && sel && !e.shiftKey && mode !== 'range') {
      sel = null;
      renderMap(); renderInspector();
    }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', () => { if (!drag) { cursorWorld = null; renderPreview(); } });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const sp = screenPoint(e);
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(sp.x, sp.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else { view.x -= e.deltaX; applyView(); }
  }, { passive: false });

  svg.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- 複数駅の操作 ----------
  function nudge(ids, dx, dy) {
    pushUndo();
    for (const id of ids) { const s = state.stations[id]; s.x += dx; s.y += dy; }
    commit();
  }

  function alignStations(ids, axis) {
    const sts = ids.map((id) => state.stations[id]);
    const avg = sts.reduce((a, s) => a + s[axis], 0) / sts.length;
    const v = snap(avg);
    pushUndo();
    for (const s of sts) s[axis] = v;
    commit();
  }

  function principalAxis(sts) {
    const xs = sts.map((s) => s.x), ys = sts.map((s) => s.y);
    return Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 'x' : 'y';
  }

  function distributeStations(ids) {
    const sts = ids.map((id) => state.stations[id]);
    const ax = principalAxis(sts);
    sts.sort((a, b) => a[ax] - b[ax]);
    const first = sts[0], last = sts[sts.length - 1];
    pushUndo();
    sts.forEach((s, i) => {
      const t = i / (sts.length - 1);
      s.x = snap(first.x + (last.x - first.x) * t);
      s.y = snap(first.y + (last.y - first.y) * t);
    });
    commit();
  }

  function lineFromSelection(ids) {
    const sts = ids.map((id) => state.stations[id]);
    const ax = principalAxis(sts);
    sts.sort((a, b) => a[ax] - b[ax]);
    pushUndo();
    const ln = createLine();
    ln.stations = sts.map((s) => s.id);
    sel = { type: 'line', id: ln.id, seg: null };
    commit();
    toast(`「${ln.name}」を作成しました`);
  }

  // ---------- キーボード ----------
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if ((e.ctrlKey || e.metaKey) && !typing) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
      if (k === 's') { e.preventDefault(); saveJSON(); return; }
      if (k === 'a') { e.preventDefault(); selectStations(Object.keys(state.stations)); renderMap(); renderInspector(); return; }
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
    const ids = selIds();
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && ids.length) {
      e.preventDefault();
      const step = prefs.gridSize * (e.shiftKey ? 5 : 1);
      nudge(ids, arrows[e.key][0] * step, arrows[e.key][1] * step);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'v') setMode('select');
    else if (k === 'r') setMode('range');
    else if (k === 't') setMode(mode === 'terrain' ? modeBeforeTerrain : 'terrain');
    else if (k === 's') setMode('station');
    else if (k === 'l') setMode('line');
    else if (k === 'd') setMode('delete');
    else if (k === 'enter' && ids.length === 1) { e.preventDefault(); openNameEditor(ids[0]); }
    else if (k === 'escape') { sel = null; if (mode !== 'select') setMode('select'); renderMap(); renderInspector(); }
    else if (k === 'delete' || k === 'backspace') {
      if (ids.length) { pushUndo(); deleteStations(ids); commit(); }
      else if (sel?.type === 'landmark') { pushUndo(); state.terrain.landmarks = state.terrain.landmarks.filter((l) => l.id !== sel.id); sel = null; commit(); }
      else if (sel?.type === 'line') {
        const ln = lineById(sel.id);
        if (ln && confirm(`路線「${ln.name}」を削除しますか？`)) { pushUndo(); deleteLine(ln.id); commit(); }
      }
    } else if (k === 'f') fitView();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

  // ---------- サイドバー ----------
  lineList.addEventListener('click', (e) => {
    const li = e.target.closest('[data-line-id]');
    if (!li) return;
    activeLineId = li.dataset.lineId;
    sel = { type: 'line', id: activeLineId, seg: null };
    renderAll();
  });

  on('#lineChips', 'click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (c) {
      activeLineId = c.dataset.chip;
      sel = { type: 'line', id: activeLineId, seg: null };
      renderAll();
      const ln = activeLine();
      if (ln) toast(`「${ln.name}」を選択`);
      return;
    }
    if (e.target.closest('[data-chip-add]')) $('#btnAddLine').click();
  });

  on('#btnTerminal', 'click', () => {
    const ids = selIds();
    if (!ids.length) { toast('ターミナル駅にしたい駅を選んでください'); return; }
    const on = !ids.every((id) => state.stations[id].terminal);
    pushUndo();
    for (const id of ids) setTerminal(state.stations[id], on);
    commit();
    toast(on ? 'ターミナル駅にしました' : '普通駅に戻しました');
  });

  on('#btnReverse', 'click', () => {
    const ln = activeLine();
    if (!ln || ln.stations.length < 2) return;
    pushUndo();
    ln.stations.reverse();
    commit();
    toast(`「${ln.name}」の向きを反転しました`);
  });

  on('#btnAddLine', 'click', () => {
    pushUndo();
    const ln = createLine();
    sel = { type: 'line', id: ln.id, seg: null };
    setMode('line');
    commit();
    toast(`「${ln.name}」を作成しました。駅を順にクリックしてください`);
  });

  function beginEdit() {
    if (!editing) { pushUndo(); editing = true; }
  }
  inspector.addEventListener('focusout', () => { editing = false; });
  inspector.addEventListener('change', (e) => {
    editing = false;
    if (e.target.dataset.field === 'x' || e.target.dataset.field === 'y') renderInspector();
  });

  inspector.addEventListener('input', (e) => {
    const f = e.target.dataset.field;
    if (!f) return;
    const ids = selIds();
    if (ids.length === 1) {
      const st = state.stations[ids[0]];
      if (f === 'x' || f === 'y') {
        const v = Number(e.target.value);
        if (!Number.isFinite(v) || e.target.value === '') return;
        beginEdit();
        st[f] = snap(v);
      } else {
        beginEdit();
        if (f === 'name') st.name = e.target.value;
        if (f === 'sub') st.sub = e.target.value;
      }
      renderMap();
    } else if (sel?.type === 'landmark') {
      const l = landmarkById(sel.id);
      if (!l) return;
      beginEdit();
      if (f === 'lmname') l.name = e.target.value;
      renderMap();
    } else if (mode === 'terrain' && (f === 'water' || f === 'land')) {
      beginEdit();
      if (f === 'water') state.settings.waterColor = e.target.value;
      else state.settings.bg = e.target.value;
      renderMap();
      renderSettings();
    } else if (sel?.type === 'line') {
      const ln = lineById(sel.id);
      if (!ln) return;
      beginEdit();
      if (f === 'lname') ln.name = e.target.value;
      if (f === 'code') ln.code = e.target.value;
      if (f === 'color') ln.color = e.target.value;
      if (f === 'width') { ln.width = Number(e.target.value); $('#widthVal').textContent = ln.width; }
      if (f === 'loop') { ln.loop = e.target.checked; editing = false; }
      renderMap();
      renderLineList();
    }
    save();
  });

  inspector.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    const ids = selIds();
    if (ids.length) {
      if (act === 'kind') {
        pushUndo();
        for (const id of ids) setTerminal(state.stations[id], b.dataset.kind === 'terminal');
        commit();
        return;
      }
      if (act === 'tsize') {
        const st = state.stations[ids[0]], g = prefs.gridSize;
        const v = clamp(Math.round(st[b.dataset.dim] / g) + Number(b.dataset.d), 1, 20) * g;
        if (v === st[b.dataset.dim]) return;
        pushUndo();
        st[b.dataset.dim] = v;
        commit();
        return;
      }
      if (act === 'label') {
        pushUndo();
        for (const id of ids) state.stations[id].label = Number(b.dataset.dir);
        commit();
      } else if (act === 'delete-stations') { pushUndo(); deleteStations(ids); commit(); }
      else if (act === 'clear-selection') { sel = null; renderMap(); renderInspector(); }
      else if (act === 'align-h') alignStations(ids, 'y');
      else if (act === 'align-v') alignStations(ids, 'x');
      else if (act === 'distribute') distributeStations(ids);
      else if (act === 'line-from-selection') lineFromSelection(ids);
      else if (act === 'remove-from-line') { pushUndo(); removeFromLine(b.dataset.id, ids[0]); commit(); }
      else if (act === 'goto-line') { activeLineId = b.dataset.id; sel = { type: 'line', id: b.dataset.id, seg: null }; renderAll(); }
      else if (act === 'extend-from') {
        const ln = lineById(b.dataset.id);
        if (!ln) return;
        if (ln.stations[0] === ids[0] && ln.stations[ln.stations.length - 1] !== ids[0]) { pushUndo(); ln.stations.reverse(); }
        activeLineId = ln.id;
        sel = { type: 'line', id: ln.id, seg: null };
        setMode('line');
        commit();
        toast(`「${ln.name}」の延長先の駅をクリックしてください`);
      } else if (act === 'new-line-from') {
        pushUndo();
        const ln = createLine();
        ln.stations.push(ids[0]);
        sel = { type: 'line', id: ln.id, seg: null };
        setMode('line');
        commit();
        toast(`「${ln.name}」を作成しました。次の駅をクリックしてください`);
      }
      return;
    }
    if (sel?.type === 'landmark') {
      const l = landmarkById(sel.id);
      if (!l) return;
      if (act === 'lm-icon') { pushUndo(); l.icon = b.dataset.icon; lmIcon = l.icon; renderTerrainControls(); commit(); }
      else if (act === 'lm-delete') { pushUndo(); state.terrain.landmarks = state.terrain.landmarks.filter((x) => x.id !== l.id); sel = null; commit(); }
      return;
    }
    if (act === 'terrain-clear-shapes' && confirm('水域・陸地の塗りをすべて消しますか？')) { pushUndo(); state.terrain.shapes = []; commit(); return; }
    if (act === 'terrain-clear-landmarks' && confirm('ランドマークをすべて消しますか？')) { pushUndo(); state.terrain.landmarks = []; sel = null; commit(); return; }
    if (sel?.type === 'line') {
      const ln = lineById(sel.id);
      if (!ln) return;
      const i = Number(b.dataset.i);
      if (act === 'color') { pushUndo(); ln.color = b.dataset.color; commit(); }
      else if (act === 'bend') {
        pushUndo();
        const v = Number(b.dataset.bend);
        if (v) state.bends[sel.seg] = v; else delete state.bends[sel.seg];
        commit();
      } else if (act === 'wp-clear') { pushUndo(); delete state.waypoints[sel.seg]; commit(); }
      else if (act === 'goto-station') { selectStations([b.dataset.id]); renderAll(); }
      else if (act === 'line-route' || act === 'line-wp-clear') {
        pushUndo();
        for (const [p, q] of linePairs(ln)) {
          const k = segKey(p, q);
          if (act === 'line-wp-clear') delete state.waypoints[k];
          else if (Number(b.dataset.bend)) state.bends[k] = Number(b.dataset.bend); else delete state.bends[k];
        }
        commit();
      } else if (act === 'select-line-stations') { selectStations(ln.stations); renderAll(); }
      else if (act === 'move') {
        const j = i + Number(b.dataset.d);
        if (j < 0 || j >= ln.stations.length) return;
        pushUndo();
        [ln.stations[i], ln.stations[j]] = [ln.stations[j], ln.stations[i]];
        cleanBends();
        commit();
      } else if (act === 'remove-index') {
        pushUndo();
        ln.stations.splice(i, 1);
        tidyLine(ln);
        cleanBends();
        commit();
      } else if (act === 'draw-line') { activeLineId = ln.id; setMode('line'); renderAll(); }
      else if (act === 'reverse') { pushUndo(); ln.stations.reverse(); commit(); }
      else if (act === 'up-order' || act === 'down-order') {
        const idx = state.lines.indexOf(ln);
        const j = idx + (act === 'up-order' ? -1 : 1);
        if (j < 0 || j >= state.lines.length) return;
        pushUndo();
        [state.lines[idx], state.lines[j]] = [state.lines[j], state.lines[idx]];
        commit();
      } else if (act === 'delete-line') {
        if (confirm(`路線「${ln.name}」を削除しますか？`)) { pushUndo(); deleteLine(ln.id); commit(); }
      }
    }
  });

  // 地図の設定
  const settingsEditing = { on: false };
  function settingInput(fn) {
    return (e) => {
      if (!settingsEditing.on) { pushUndo(); settingsEditing.on = true; }
      fn(e.target);
      renderMap();
      save();
    };
  }
  ['#setTitle', '#setBg', '#setWater', '#setFont', '#setGrid', '#setLegend', '#setScale'].forEach((s) => {
    $(s).addEventListener('change', () => { settingsEditing.on = false; });
    $(s).addEventListener('blur', () => { settingsEditing.on = false; });
  });
  on('#setTitle', 'input', settingInput((t) => { state.settings.title = t.value; }));
  on('#setBg', 'input', settingInput((t) => { state.settings.bg = t.value; }));
  on('#setWater', 'input', settingInput((t) => { state.settings.waterColor = t.value; }));
  on('#setFont', 'input', settingInput((t) => { const v = Number(t.value); if (v >= 8 && v <= 40) state.settings.fontSize = v; }));
  on('#setScale', 'input', settingInput((t) => { state.settings.stationScale = Number(t.value); }));
  on('#setGrid', 'input', settingInput((t) => { state.settings.grid = t.checked; settingsEditing.on = false; }));
  on('#setLegend', 'input', settingInput((t) => { state.settings.showLegend = t.checked; settingsEditing.on = false; }));

  // 操作設定
  on('#prefGrid', 'change', (e) => { prefs.gridSize = Number(e.target.value); savePrefs(); applyGrid(); renderInspector(); });
  on('#prefAutoName', 'change', (e) => { prefs.autoName = e.target.checked; savePrefs(); });
  on('#prefPrefix', 'input', (e) => { prefs.namePrefix = e.target.value.slice(0, 20); savePrefs(); });
  on('#prefBgDrag', 'change', (e) => { prefs.bgDrag = e.target.value; savePrefs(); });
  on('#prefMerge', 'change', (e) => { prefs.mergeOnDrop = e.target.checked; savePrefs(); });
  on('#prefReset', 'click', () => { prefs = defaultPrefs(); savePrefs(); applyGrid(); renderSettings(); toast('操作設定を初期値に戻しました'); });

  // ---------- ツールバー ----------
  document.querySelectorAll('.tools [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  on('#logoTerrain', 'click', () => { if (mode !== 'terrain') { setMode('terrain'); toast('地形エディター'); } });
  on('#logoRoute', 'click', () => { if (mode === 'terrain') { setMode(modeBeforeTerrain === 'terrain' ? 'select' : modeBeforeTerrain); toast('路線図エディター'); } });
  on('#btnTerrainDone', 'click', () => setMode(modeBeforeTerrain === 'terrain' ? 'select' : modeBeforeTerrain));
  document.querySelectorAll('[data-ttool]').forEach((b) => b.addEventListener('click', () => {
    terrainTool = b.dataset.ttool;
    if (sel?.type === 'landmark' && terrainTool !== 'landmark') sel = null;
    renderTerrainControls(); renderMap(); renderInspector();
  }));
  document.querySelectorAll('[data-cells]').forEach((b) => b.addEventListener('click', () => {
    cellN = Number(b.dataset.cells); renderTerrainControls();
  }));
  on('#lmPalette', 'click', (e) => {
    const c = e.target.closest('[data-lmicon]');
    if (!c) return;
    lmIcon = c.dataset.lmicon;
    const l = sel?.type === 'landmark' && landmarkById(sel.id);
    if (l && l.icon !== lmIcon) { pushUndo(); l.icon = lmIcon; commit(); }
    renderTerrainControls();
  });
  on('#btnUndo', 'click', undo);
  on('#btnRedo', 'click', redo);
  on('#zoomIn', 'click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); });
  on('#zoomOut', 'click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); });
  on('#zoomFit', 'click', fitView);

  on('#btnNew', 'click', () => {
    if (!confirm('現在の路線図を消去して新規作成しますか？（「元に戻す」で復元できます）')) return;
    pushUndo();
    state = emptyState();
    sel = null; activeLineId = null;
    commit();
    fitView();
  });
  on('#btnSample', 'click', () => {
    if (Object.keys(state.stations).length && !confirm('サンプルの路線図を読み込みますか？（「元に戻す」で復元できます）')) return;
    pushUndo();
    state = sampleState();
    sel = null; activeLineId = state.lines[0].id;
    commit();
    fitView();
  });

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function fileBase() {
    return (state.settings.title || 'rosenzu').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'rosenzu';
  }

  function saveJSON() {
    download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), fileBase() + '.json');
    toast('JSONファイルを保存しました');
  }
  on('#btnSave', 'click', saveJSON);
  on('#btnOpen', 'click', () => $('#fileInput').click());
  on('#fileInput', 'change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const s = normalize(JSON.parse(rd.result));
        pushUndo();
        state = s;
        sel = null; activeLineId = state.lines[0]?.id ?? null;
        commit();
        fitView();
        toast('読み込みました');
      } catch (_) {
        alert('ファイルを読み込めませんでした。路線図メーカーで保存したJSONファイルを選んでください。');
      }
    };
    rd.readAsText(f);
    e.target.value = '';
  });

  // ---------- 書き出し ----------
  function buildExportSVG() {
    const groups = [gLines, gLandmarks, gStations, gLabels];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sh of state.terrain.shapes) {
      if (sh.c) {
        for (let i = 0; i < sh.c.length; i += 2) {
          x0 = Math.min(x0, sh.c[i] * sh.g); x1 = Math.max(x1, (sh.c[i] + 1) * sh.g);
          y0 = Math.min(y0, sh.c[i + 1] * sh.g); y1 = Math.max(y1, (sh.c[i + 1] + 1) * sh.g);
        }
        continue;
      }
      const h = sh.f ? 0 : sh.w / 2;
      for (let i = 0; i < sh.p.length; i += 2) {
        x0 = Math.min(x0, sh.p[i] - h); x1 = Math.max(x1, sh.p[i] + h);
        y0 = Math.min(y0, sh.p[i + 1] - h); y1 = Math.max(y1, sh.p[i + 1] + h);
      }
    }
    for (const g of groups) {
      if (!g.childNodes.length) continue;
      const b = g.getBBox();
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 200; y1 = 100; }
    const S = state.settings;
    const pad = 48;
    const cw = x1 - x0, ch = y1 - y0;
    const W = Math.ceil(Math.max(cw + pad * 2, 480));
    const titleH = S.title ? 64 : 0;
    const items = state.lines.filter((l) => l.stations.length > 1);
    const colW = 230;
    const cols = Math.max(1, Math.floor((W - pad * 2) / colW));
    const rows = Math.ceil(items.length / cols);
    const legendH = S.showLegend && items.length ? rows * 30 + 36 : 0;
    const H = Math.ceil(titleH + ch + pad * 2 + legendH);
    const tx = (W - cw) / 2 - x0, ty = titleH + pad - y0;

    let legend = '';
    if (legendH) {
      const ly = titleH + ch + pad * 2;
      legend += `<line x1="${pad}" y1="${ly}" x2="${W - pad}" y2="${ly}" stroke="#d0d4da" stroke-width="1"/>`;
      items.forEach((l, i) => {
        const cx = pad + (i % cols) * colW, cy = ly + 24 + Math.floor(i / cols) * 30;
        let x = cx;
        if (l.code) {
          legend += `<rect x="${x}" y="${cy - 2}" width="24" height="24" rx="5" fill="${esc(l.color)}"/><text x="${x + 12}" y="${cy + 15}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">${esc(l.code)}</text>`;
          x += 32;
        }
        legend += `<line x1="${x}" y1="${cy + 10}" x2="${x + 36}" y2="${cy + 10}" stroke="${esc(l.color)}" stroke-width="${l.width}" stroke-linecap="round"/>`;
        legend += `<text x="${x + 46}" y="${cy + 15}" font-size="14" fill="#1d2330">${esc(l.name)}</text>`;
      });
    }
    const title = S.title ? `<text x="${pad}" y="${pad + 8}" font-size="26" font-weight="700" fill="#1d2330">${esc(S.title)}</text>` : '';
    // 当たり判定用の透明な要素は書き出さない
    const clean = (html) => html.replace(/<line[^>]*stroke="transparent"[^>]*\/>/g, '');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>
<rect width="100%" height="100%" fill="${esc(S.bg)}"/>
${title}
<g transform="translate(${r1(tx)} ${r1(ty)})">${gTerrain.innerHTML}${gLines.innerHTML}<g font-family='${FONT}'>${gLandmarks.innerHTML.replace(/<circle r="[^"]*" fill="transparent"\/>/g, '')}</g>${clean(gStations.innerHTML)}${gLabels.innerHTML}</g>
${legend}
</svg>`;
  }

  function exportPrep() {
    const prevSel = sel;
    sel = null;
    renderMap();
    const out = buildExportSVG();
    sel = prevSel;
    renderMap();
    return out;
  }

  on('#btnSVG', 'click', () => {
    if (!Object.keys(state.stations).length) { toast('駅がありません'); return; }
    download(new Blob([exportPrep()], { type: 'image/svg+xml' }), fileBase() + '.svg');
    toast('SVGを書き出しました');
  });

  on('#btnPNG', 'click', () => {
    if (!Object.keys(state.stations).length) { toast('駅がありません'); return; }
    const src = exportPrep();
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = img.width * scale; c.height = img.height * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      c.toBlob((b) => { if (b) { download(b, fileBase() + '.png'); toast('PNGを書き出しました'); } }, 'image/png');
    };
    img.onerror = () => alert('PNGの書き出しに失敗しました。SVGで書き出してください。');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
  });

  // ---------- 初期化 ----------
  prefs = loadPrefs();
  state = load() || sampleState();
  activeLineId = state.lines[0]?.id ?? null;
  applyGrid();
  setMode('select');
  renderAll();
  requestAnimationFrame(fitView);
  window.addEventListener('resize', () => applyView());

  // デバッグ/テスト用
  window.__rosenzu = { get state() { return state; }, get sel() { return sel; }, get view() { return view; }, fitView };
})();
