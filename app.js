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
  const HINTS = {
    select: 'ダブルクリック（タップ）で駅を追加 ／ 駅をドラッグで移動（他の駅に重ねると乗換駅に統合）／ 背景ドラッグで範囲選択',
    range: 'ドラッグで範囲選択（Shiftで追加）／ 駅をタップで選択に追加・解除 ／ 選んだ駅はまとめて移動できます',
    station: 'ダブルクリック（タップ）で駅を追加 ／ 路線の上をダブルクリックするとその区間に駅を挿入',
    line: '駅を順にクリックして路線を延長（Shift+クリックで起点側）／ 空白をダブルクリックで新駅を作成して延長',
    delete: '駅または路線をクリックして削除',
  };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
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

  // ---------- ユーティリティ ----------
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const segKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const r1 = (v) => Math.round(v * 10) / 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const snap = (v, force) => (prefs.snap || force ? Math.round(v / prefs.gridSize) * prefs.gridSize : Math.round(v));

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
    return { title: '架空鉄道 路線図', bg: '#ffffff', grid: true, fontSize: 14, showLegend: true, stationScale: 1 };
  }

  function emptyState() {
    return { version: 1, stations: {}, lines: [], bends: {}, settings: defaultSettings() };
  }

  function sampleState() {
    const s = emptyState();
    s.settings.title = '架空市 都市鉄道 路線図';
    const add = (id, name, sub, x, y, label = -1) => { s.stations[id] = { id, name, sub, x, y, label }; };
    add('nishiminato', '西港', 'Nishi-minato', -360, 0, 4);
    add('minatomachi', '港町', 'Minatomachi', -180, 0, 4);
    add('chuo', '中央', 'Chuō', 0, 0, 3);
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
    return s;
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
      for (const [k, v] of Object.entries(raw.bends)) if ([1, 2].includes(v)) s.bends[k] = v;
    }
    Object.assign(s.settings, raw.settings || {});
    s.settings.fontSize = clamp(Number(s.settings.fontSize) || 14, 8, 40);
    s.settings.stationScale = clamp(Number(s.settings.stationScale) || 1, 0.5, 2);
    return s;
  }

  function save() {
    clearTimeout(save.timer);
    save.timer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* 保存不可 */ }
    }, 300);
  }

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

  function stationNear(x, y, excludeId) {
    let best = null, bd = 6;
    for (const s of Object.values(state.stations)) {
      if (s.id === excludeId) continue;
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
  }

  function removeFromLine(lineId, stationId) {
    const ln = lineById(lineId);
    if (!ln) return;
    ln.stations = ln.stations.filter((s) => s !== stationId);
    tidyLine(ln);
    cleanBends();
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
      s.pts = routePoints(state.stations[s.a], state.stations[s.b], state.bends[s.key] || 0);
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
    const pts = geom.stPts[st.id] || [[st.x, st.y]];
    const [p1, p2] = farthestPair(pts);
    const R = stationRadius(geom.stLines[st.id] || []);
    return { p1, p2, R };
  }

  function stationMarkup(st) {
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
    if (!st.name && !st.sub) return '';
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

  function renderMap() {
    geom = computeGeom();
    const S = state.settings;
    bgRect.setAttribute('fill', S.bg);
    gridRect.style.display = S.grid ? '' : 'none';

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

    renderSelection();
    renderPreview();
    renderOverlays();
  }

  function renderSelection() {
    let under = '', over = '';
    if (sel?.type === 'line') {
      const g = geom.lines.get(sel.id);
      const ln = lineById(sel.id);
      if (g && ln) {
        under += `<path d="${roundedPath(g.pts, 14)}" fill="none" stroke="#1f6feb" stroke-opacity="0.28" stroke-width="${ln.width + 12}" stroke-linejoin="round" stroke-linecap="round"/>`;
        const part = g.parts.find((p) => p.key === sel.seg);
        if (part) over += `<path d="${roundedPath(part.pts, 14)}" fill="none" stroke="#1f6feb" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>`;
      }
    } else {
      for (const id of selIds()) {
        const { p1, p2, R } = stationShape(state.stations[id]);
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
    const last = state.stations[ln.stations[ln.stations.length - 1]];
    const pts = routePoints(last, cursorWorld, 0);
    gPreview.innerHTML = `<path d="${roundedPath(pts, 14)}" fill="none" stroke="${esc(ln.color)}" stroke-opacity="0.5" stroke-width="${ln.width}" stroke-dasharray="${ln.width * 1.5} ${ln.width}" stroke-linecap="round" pointer-events="none"/>`
      + `<circle cx="${cursorWorld.x}" cy="${cursorWorld.y}" r="5" fill="none" stroke="${esc(ln.color)}" stroke-width="2" pointer-events="none"/>`;
  }

  function applyView() {
    vp.setAttribute('transform', `translate(${r1(view.x)} ${r1(view.y)}) scale(${view.k})`);
    gridPat.setAttribute('patternTransform', `translate(${r1(view.x)} ${r1(view.y)}) scale(${view.k})`);
    if (nameEdit) positionNameEditor();
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
    if (n > 1 && (mode === 'select' || mode === 'range')) hint = `${n}駅を選択中 ／ ドラッグでまとめて移動・矢印キーで微調整・Deleteで削除`;
    $('#hint').textContent = hint;
  }

  function renderLineList() {
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
    const ids = selIds();
    if (ids.length === 1) return renderStationInspector(state.stations[ids[0]]);
    if (ids.length > 1) return renderMultiInspector(ids);
    if (sel?.type === 'line' && lineById(sel.id)) return renderLineInspector(lineById(sel.id));
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
      <div class="field">駅名の位置 ${dirGrid(st.label, auto)}</div>
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
      return `<div class="field">選択区間: ${esc(state.stations[a].name)} – ${esc(state.stations[b].name)} の曲がり方
        <div class="btn-row">
          ${['折れ方1', '折れ方2', '直線'].map((t, i) => `<button class="small ${cur === i ? 'primary' : ''}" data-act="bend" data-bend="${i}">${t}</button>`).join('')}
        </div></div>`;
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
    $('#setFont').value = S.fontSize;
    $('#setGrid').checked = S.grid;
    $('#setLegend').checked = S.showLegend;
    $('#setScale').value = S.stationScale;
    $('#prefSnap').checked = prefs.snap;
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
    mode = m;
    document.querySelectorAll('.tools [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    svg.setAttribute('class', `mode-${m}`);
    if (m === 'line' && !activeLine() && state.lines.length) activeLineId = state.lines[0].id;
    renderMap();
    renderLineList();
  }

  // ---------- 駅名のその場編集 ----------
  function positionNameEditor() {
    const st = state.stations[nameEdit.id];
    if (!st) return;
    const stage = $('#stage').getBoundingClientRect();
    const bw = nameEditor.offsetWidth || 220, bh = nameEditor.offsetHeight || 90;
    const sx = st.x * view.k + view.x, sy = st.y * view.k + view.y;
    let top = sy + 22;
    if (top + bh > stage.height - 8) top = sy - 22 - bh;
    nameEditor.style.left = clamp(sx - bw / 2, 8, stage.width - bw - 8) + 'px';
    nameEditor.style.top = clamp(top, 8, stage.height - bh - 8) + 'px';
  }

  function openNameEditor(id, isNew) {
    const st = state.stations[id];
    if (!st) return;
    closeNameEditor(true);
    nameEdit = { id, orig: { name: st.name, sub: st.sub }, pushed: false, isNew };
    $('#neName').value = st.name;
    $('#neSub').value = st.sub;
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
    const st = state.stations[ne.id];
    if (!apply && st) {
      st.name = ne.orig.name;
      st.sub = ne.orig.sub;
      if (ne.pushed) { undoStack.pop(); updateUndoButtons(); }
    }
    if (!silent) { renderMap(); renderInspector(); save(); }
  }

  nameEditor.addEventListener('input', (e) => {
    if (!nameEdit) return;
    const st = state.stations[nameEdit.id];
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
  $('#neOk').addEventListener('click', () => closeNameEditor(true));
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
    drag = {
      type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...view },
    };
    lastTap = null;
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
        startBgDrag(e, sp, w, { tap: { kind: 'line', seg, sp, w } });
        return;
      }
      // 路線/範囲モードでは線の上も背景と同じ扱い
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
    cursorWorld = e.altKey ? { x: w.x, y: w.y } : { x: snap(w.x), y: snap(w.y) };
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

    if (drag.type === 'station') {
      const a = drag.origs[drag.anchor];
      if (!a || !state.stations[drag.anchor]) { drag = null; return; }
      if (!drag.moved && !moved && Math.hypot(w.x - drag.start.x, w.y - drag.start.y) * view.k < 5) return;
      let nx = a.x + (w.x - drag.start.x), ny = a.y + (w.y - drag.start.y);
      if (e.altKey) { nx = Math.round(nx); ny = Math.round(ny); } else { nx = snap(nx); ny = snap(ny); }
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
    const key = tap.kind === 'station' ? 'st:' + tap.id : tap.kind === 'line' ? 'ln:' + tap.seg : 'bg';
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && lastTap.key === key &&
      Math.hypot(tap.sp.x - lastTap.sp.x, tap.sp.y - lastTap.sp.y) < 24) {
      lastTap = null;
      onDoubleTap(tap, e);
      return true;
    }
    lastTap = { t: now, key, sp: tap.sp };
    return false;
  }

  function onDoubleTap(tap) {
    if (tap.kind === 'station') { openNameEditor(tap.id); return; }
    if (mode === 'line') {
      const x = snap(tap.w.x), y = snap(tap.w.y);
      const existing = stationNear(x, y);
      if (existing) { if (extendLine(existing.id, tap.shift)) commit(); return; }
      pushUndo();
      const st = createStation(x, y);
      const ln = activeLine() || createLine();
      if (tap.shift) ln.stations.unshift(st.id); else ln.stations.push(st.id);
      sel = { type: 'line', id: ln.id, seg: null };
      commit();
      if (prefs.autoName) openNameEditor(st.id, true);
      return;
    }
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
    const v = snap(avg, prefs.snap);
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
    else if (k === 's') setMode('station');
    else if (k === 'l') setMode('line');
    else if (k === 'd') setMode('delete');
    else if (k === 'enter' && ids.length === 1) { e.preventDefault(); openNameEditor(ids[0]); }
    else if (k === 'escape') { sel = null; if (mode !== 'select') setMode('select'); renderMap(); renderInspector(); }
    else if (k === 'delete' || k === 'backspace') {
      if (ids.length) { pushUndo(); deleteStations(ids); commit(); }
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

  $('#btnAddLine').addEventListener('click', () => {
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
        st[f] = Math.round(v);
      } else {
        beginEdit();
        if (f === 'name') st.name = e.target.value;
        if (f === 'sub') st.sub = e.target.value;
      }
      renderMap();
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
      } else if (act === 'goto-station') { selectStations([b.dataset.id]); renderAll(); }
      else if (act === 'select-line-stations') { selectStations(ln.stations); renderAll(); }
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
  ['#setTitle', '#setBg', '#setFont', '#setGrid', '#setLegend', '#setScale'].forEach((s) => {
    $(s).addEventListener('change', () => { settingsEditing.on = false; });
    $(s).addEventListener('blur', () => { settingsEditing.on = false; });
  });
  $('#setTitle').addEventListener('input', settingInput((t) => { state.settings.title = t.value; }));
  $('#setBg').addEventListener('input', settingInput((t) => { state.settings.bg = t.value; }));
  $('#setFont').addEventListener('input', settingInput((t) => { const v = Number(t.value); if (v >= 8 && v <= 40) state.settings.fontSize = v; }));
  $('#setScale').addEventListener('input', settingInput((t) => { state.settings.stationScale = Number(t.value); }));
  $('#setGrid').addEventListener('input', settingInput((t) => { state.settings.grid = t.checked; settingsEditing.on = false; }));
  $('#setLegend').addEventListener('input', settingInput((t) => { state.settings.showLegend = t.checked; settingsEditing.on = false; }));

  // 操作設定
  $('#prefSnap').addEventListener('change', (e) => { prefs.snap = e.target.checked; savePrefs(); });
  $('#prefGrid').addEventListener('change', (e) => { prefs.gridSize = Number(e.target.value); savePrefs(); applyGrid(); renderInspector(); });
  $('#prefAutoName').addEventListener('change', (e) => { prefs.autoName = e.target.checked; savePrefs(); });
  $('#prefPrefix').addEventListener('input', (e) => { prefs.namePrefix = e.target.value.slice(0, 20); savePrefs(); });
  $('#prefBgDrag').addEventListener('change', (e) => { prefs.bgDrag = e.target.value; savePrefs(); });
  $('#prefMerge').addEventListener('change', (e) => { prefs.mergeOnDrop = e.target.checked; savePrefs(); });
  $('#prefReset').addEventListener('click', () => { prefs = defaultPrefs(); savePrefs(); applyGrid(); renderSettings(); toast('操作設定を初期値に戻しました'); });

  // ---------- ツールバー ----------
  document.querySelectorAll('.tools [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); });
  $('#zoomOut').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); });
  $('#zoomFit').addEventListener('click', fitView);

  $('#btnNew').addEventListener('click', () => {
    if (!confirm('現在の路線図を消去して新規作成しますか？（「元に戻す」で復元できます）')) return;
    pushUndo();
    state = emptyState();
    sel = null; activeLineId = null;
    commit();
    fitView();
  });
  $('#btnSample').addEventListener('click', () => {
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
  $('#btnSave').addEventListener('click', saveJSON);
  $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
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
    const groups = [gLines, gStations, gLabels];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
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
<g transform="translate(${r1(tx)} ${r1(ty)})">${gLines.innerHTML}${clean(gStations.innerHTML)}${gLabels.innerHTML}</g>
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

  $('#btnSVG').addEventListener('click', () => {
    if (!Object.keys(state.stations).length) { toast('駅がありません'); return; }
    download(new Blob([exportPrep()], { type: 'image/svg+xml' }), fileBase() + '.svg');
    toast('SVGを書き出しました');
  });

  $('#btnPNG').addEventListener('click', () => {
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
