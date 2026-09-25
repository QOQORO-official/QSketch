/* QSketch front-end.
 *
 * The Nim/WASM engine owns all geometry (StreamLine + smoothing, stroke
 * tessellation, hit-testing, undo, serialization) in *world* coordinates.
 * This file owns input, the camera and rendering:
 *
 *  - Pen / mouse draw. Fingers draw until a stylus is seen, then fingers
 *    navigate (Procreate style); configurable in Brush settings.
 *  - One finger pans (when not drawing), two fingers pinch-zoom + pan,
 *    two-finger tap = undo, three-finger tap = redo.
 *  - Palm rejection: touches are ignored while the pen is down, and a pen
 *    touching down cancels any touch gesture in progress (the palm).
 *  - Committed strokes are drawn once into a cached layer; while drawing we
 *    only blit that layer and fill the live stroke.
 */
'use strict';

// Build version, stamped by tools/stamp.sh at deploy time ('dev' locally).
// The same value goes into index.html (<meta name="qsketch-version">) and
// into every asset URL (?v=...), so a deploy never mixes old and new files.
const APP_VERSION = 'dev';

// GitHub Pages lets browsers cache each file for 10 minutes, independently.
// A phone can therefore run this script inside a stale index.html from the
// previous deploy. Detect that before touching the DOM and reload once with
// a fresh copy of the page.
(function healStaleCache() {
  if (APP_VERSION === 'dev') return;
  const meta = document.querySelector('meta[name="qsketch-version"]');
  if (meta && meta.content === APP_VERSION) return;
  let tried = null;
  try { tried = sessionStorage.getItem('qsketch.heal'); } catch (_) {}
  if (tried === APP_VERSION) return;          // already tried once: don't loop
  try { sessionStorage.setItem('qsketch.heal', APP_VERSION); } catch (_) {}
  fetch(location.pathname, { cache: 'reload' })
    .catch(() => {})
    .then(() => location.reload());
  throw new Error('QSketch: page files from two versions were cached; reloading');
})();

const WASM_URL = 'qsketch.wasm' + (APP_VERSION === 'dev' ? '' : '?v=' + APP_VERSION);
const SETTINGS_KEY = 'qsketch.brush.v2';
const LEGACY_SETTINGS_KEY = 'qsketch.brush.v1';

let E = null;                              // wasm exports

function f32(ptr, count) { return new Float32Array(E.memory.buffer, ptr, count); }
function u8(ptr, count)  { return new Uint8Array(E.memory.buffer, ptr, count); }

// ---- camera: screen = world * scale + offset (CSS pixels) ----
const cam = { x: 0, y: 0, scale: 1 };
const MIN_ZOOM = 0.05, MAX_ZOOM = 20;
function screenToWorld(sx, sy) {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}
function zoomAbout(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  cam.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.scale * factor));
  cam.x = sx - before.x * cam.scale;
  cam.y = sy - before.y * cam.scale;
  updateZoomLabel();
  viewChanged();
}

// ---- brushes ----
// kind 0 = round tip, 1 = flat calligraphy nib. Everything else is a
// per-brush default the user can tune (and that we remember per brush).
const TIP_ROUND = 0, TIP_NIB = 1;
const NIB_RATIO = 0.15;                 // nib thickness relative to its width
// Slider values are stored as 0..1 of each slider's range; the engine gets
// them scaled: StreamLine 0..1, Smoothing 0..SMOOTHING_MAX, Stabilizer
// 0..STABILIZER_MAX_PX screen pixels (converted to world units per stroke).
const SMOOTHING_MAX = 3;
const STABILIZER_MAX_PX = 80;
const SETTINGS_SCHEMA = 3;       // 3: wider StreamLine/Smoothing + Stabilizer
const BRUSHES = [
  { id: 'ballpoint',   name: 'Ballpoint',    icon: '🖊️', kind: TIP_ROUND,
    size: 3,  minSize: 0.70, stabilizer: 0,    streamline: 0.08, smoothing: 0.07, opacity: 1 },
  { id: 'fountain',    name: 'Fountain pen', icon: '✒️', kind: TIP_ROUND,
    size: 5,  minSize: 0.20, stabilizer: 0,    streamline: 0.15, smoothing: 0.12, opacity: 1 },
  // a qalam / broad nib is rigid: width comes from the nib angle, not pressure
  { id: 'calligraphy', name: 'Calligraphy',  icon: '🖋️', kind: TIP_NIB,
    size: 14, minSize: 0.85, stabilizer: 0.30, streamline: 0.20, smoothing: 0.10, opacity: 1, nibAngle: 45 },
  { id: 'marker',      name: 'Marker',       icon: '🖍️', kind: TIP_ROUND,
    size: 18, minSize: 0.85, stabilizer: 0,    streamline: 0.12, smoothing: 0.10, opacity: 0.55 },
];
const BRUSH_PARAMS = ['size', 'minSize', 'stabilizer', 'streamline', 'smoothing', 'opacity', 'nibAngle'];

function brushDefaults(def) {
  const out = {};
  for (const k of BRUSH_PARAMS) if (def[k] !== undefined) out[k] = def[k];
  return out;
}
function defaultSettings() {
  return {
    schema: SETTINGS_SCHEMA,
    brush: 'fountain',
    brushes: Object.fromEntries(BRUSHES.map(b => [b.id, brushDefaults(b)])),
    eraserSize: 24,        // screen pixels
    pressure: true,        // pen pressure drives width
    curve: 0,              // -1 soft .. +1 firm  (gamma = 3^curve)
    fingers: 'auto',       // 'auto' | 'draw' | 'navigate'
    penButtonErase: true,  // S Pen / stylus barrel button = eraser
    page: { pattern: 'dots', spacing: 24, paper: 'auto' },   // last used page style
  };
}
// Settings saved before schema 3 used narrower StreamLine / Smoothing ranges.
// A value the user never changed takes the new default (the old calligraphy
// defaults in particular were too weak for slow writing); a value they did
// tune is rescaled so it feels exactly as before.
const OLD_DEFAULTS = {
  ballpoint:   { minSize: 0.70, streamline: 0.15, smoothing: 0.20 },
  fountain:    { minSize: 0.20, streamline: 0.30, smoothing: 0.35 },
  calligraphy: { minSize: 0.45, streamline: 0.35, smoothing: 0.40 },
  marker:      { minSize: 0.85, streamline: 0.25, smoothing: 0.30 },
};
function upgradeBrushParams(p, id) {
  const out = Object.assign({}, p);
  const untouched = OLD_DEFAULTS[id] || {};
  for (const k of ['minSize', 'streamline', 'smoothing'])
    if (out[k] !== undefined && out[k] === untouched[k]) delete out[k];
  if (out.streamline !== undefined) out.streamline /= 2;      // old 100% = new 50%
  if (out.smoothing !== undefined) out.smoothing /= 3;        // old 100% = new 33%
  return out;
}

function loadSettings() {
  const s = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const old = (saved.schema || 2) < SETTINGS_SCHEMA;
      for (const k of ['brush', 'eraserSize', 'pressure', 'curve', 'fingers', 'penButtonErase'])
        if (saved[k] !== undefined) s[k] = saved[k];
      if (saved.page) Object.assign(s.page, saved.page);
      for (const b of BRUSHES) {
        const p = (saved.brushes || {})[b.id];
        if (p) Object.assign(s.brushes[b.id], old ? upgradeBrushParams(p, b.id) : p);
      }
      if (!BRUSHES.some(b => b.id === s.brush)) s.brush = 'fountain';
      return s;
    }
    // v1 had one global brush: keep the user's tuning on the fountain pen
    const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy) {
      const v1 = JSON.parse(legacy);
      for (const k of ['pressure', 'curve', 'fingers', 'penButtonErase'])
        if (v1[k] !== undefined) s[k] = v1[k];
      const tuned = {};
      for (const k of ['streamline', 'smoothing', 'minSize'])
        if (v1[k] !== undefined) tuned[k] = v1[k];
      Object.assign(s.brushes.fountain, upgradeBrushParams(tuned, 'fountain'));
    }
  } catch (err) {
    // blocked storage (private mode) lands here too; never hide real bugs
    console.warn('QSketch: could not read saved settings, using defaults', err);
  }
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}
// (after OLD_DEFAULTS & co. are defined: loadSettings() uses them)
let settings = loadSettings();
const brushDef = () => BRUSHES.find(b => b.id === settings.brush) || BRUSHES[1];
const brushParams = () => settings.brushes[brushDef().id];
function nibVector(deg) {
  // angle of the nib edge, counter-clockwise from horizontal (screen y is down)
  const a = deg * Math.PI / 180;
  return [Math.cos(a), -Math.sin(a)];
}

// Map raw stylus pressure through the user's curve. Non-pen input (mouse,
// finger) has no real pressure, so it always draws at full Size.
function mapPressure(p, pointerType) {
  if (pointerType !== 'pen' || !settings.pressure) return 1;
  p = Math.min(1, Math.max(0, p));
  return Math.pow(p, Math.pow(3, settings.curve));
}

// ---- tool state ----
let tool = 'pen';
let color = '#1b1d23';
let dpr = Math.max(1, window.devicePixelRatio || 1);
let penSeen = false;               // a stylus has been used on this page

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

// committed strokes are rendered into this cached layer
const layer = document.createElement('canvas');
const lctx = layer.getContext('2d', { alpha: false });
let layerDirty = true;
let needsRedraw = true;

const pathCache = new Map();       // stroke id -> {path, css}
let liveDirty = false;             // engine has new samples to tessellate

let livePath = null;               // Path2D of the in-progress stroke
let penAt = null;                  // latest pen position (screen px), for the string
let liveCss = '';

// ---- input state ----
let stroke = null;                 // {id, type, erase, lasso, started}
let sel = null;                    // lasso selection: {ids:Set, box:{minx,miny,maxx,maxy}} (world)
let selT = null;                   // live move/resize/rotate: {s, a, tx, ty, px, py}
let mousePan = null;               // {x, y} while panning with mouse/pen
let spaceHeld = false;
const touches = new Map();         // touch pointerId -> {x, y, sx, sy}
let gesture = null;                // {kind:'pan', id} | {kind:'pinch', cx, cy, d}
let tap = null;                    // {t, max, moved} multi-finger tap tracking

// -------------------------------------------------------------------------
// colour + theme helpers
// -------------------------------------------------------------------------
function hexToRGBA(hex, alpha = 1) {   // "#rrggbb" -> 0xRRGGBBAA (>>>0)
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}
function rgbaToCss(v) {                 // 0xRRGGBBAA -> css
  const r = (v >>> 24) & 0xff, g = (v >>> 16) & 0xff, b = (v >>> 8) & 0xff, a = v & 0xff;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}
let theme = { bg: '#fbfcfe', dot: '#c7cede' };
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  theme = {
    bg: cs.getPropertyValue('--canvas-bg').trim() || '#fbfcfe',
    dot: cs.getPropertyValue('--dot').trim() || '#c7cede',
    accent: cs.getPropertyValue('--accent').trim() || '#4f6bed',
  };
  viewChanged();
}

// -------------------------------------------------------------------------
// building Path2D from an engine outline buffer (world coords)
// -------------------------------------------------------------------------
// The engine emits a list of convex pieces, [n, x0, y0, ..., x(n-1), y(n-1)]*,
// all wound the same way: filled together (nonzero) they form the stroke.
function outlineToPath(ptr, count) {
  const p = new Path2D();
  if (!ptr || count < 7) return p;
  const a = f32(ptr, count);
  for (let i = 0; i < count;) {
    const n = a[i++];
    if (n < 3 || i + 2 * n > count) break;
    p.moveTo(a[i], a[i + 1]);
    for (let k = 1; k < n; k++) p.lineTo(a[i + 2 * k], a[i + 2 * k + 1]);
    p.closePath();
    i += 2 * n;
  }
  return p;
}
function forEachOutlinePoint(ptr, count, fn) {
  if (!ptr) return;
  const a = f32(ptr, count);
  for (let i = 0; i < count;) {
    const n = a[i++];
    for (let k = 0; k < n; k++, i += 2) fn(a[i], a[i + 1]);
  }
}

function getCommittedPath(id) {
  let entry = pathCache.get(id);
  if (entry) return entry;
  const ptr = E.qs_stroke_outline_ptr(id);
  const cnt = E.qs_stroke_outline_count(id);
  entry = { path: outlineToPath(ptr, cnt), css: rgbaToCss(E.qs_stroke_color(id) >>> 0) };
  pathCache.set(id, entry);
  return entry;
}

// -------------------------------------------------------------------------
// rendering
// -------------------------------------------------------------------------
function viewChanged() { layerDirty = true; needsRedraw = true; }
function invalidate() { needsRedraw = true; }

function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = layer.width = Math.round(w * dpr);
  canvas.height = layer.height = Math.round(h * dpr);
  viewChanged();
}

// -------------------------------------------------------------------------
// page style: pattern + spacing + paper, anchored to the page (world space)
// so writing stays on the ruled lines while you pan and zoom.
// -------------------------------------------------------------------------
const PATTERNS = [
  { id: 'blank',    name: 'Blank' },
  { id: 'dots',     name: 'Dots' },
  { id: 'grid',     name: 'Grid' },
  { id: 'lines',    name: 'Lines' },
  { id: 'notebook', name: 'Notebook' },   // ruled lines + margin
];
const PAPERS = [
  { id: 'auto',  name: 'Match theme' },
  { id: 'white', name: 'White', css: '#ffffff' },
  { id: 'cream', name: 'Cream', css: '#fbf5e4' },
  { id: 'gray',  name: 'Gray',  css: '#eceef2' },
  { id: 'dark',  name: 'Dark',  css: '#1e2128' },
];
function paperCss(page = settings.page) {
  const p = PAPERS.find(q => q.id === page.paper);
  return p && p.css ? p.css : theme.bg;
}
function isDarkCss(css) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = css;                               // normalises any css colour to #rrggbb
  const h = c.fillStyle.replace('#', '');
  if (h.length !== 6) return false;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}
const inkCache = new Map();
function patternInk(paper) {
  if (!inkCache.has(paper)) {
    inkCache.set(paper, isDarkCss(paper)
      ? { dot: '#3b4252', line: 'rgba(150,175,230,0.17)', margin: 'rgba(240,100,105,0.50)' }
      : { dot: '#c1c8d6', line: 'rgba(79,107,190,0.24)', margin: 'rgba(229,72,77,0.55)' });
  }
  return inkCache.get(paper);
}

// Paint paper + pattern into `c` (device pixels, W x H). World point (x, y)
// lands at (x*k + ox, y*k + oy); `unit` is device pixels per CSS pixel.
function drawPage(c, k, ox, oy, W, H, unit, page = settings.page) {
  const paper = paperCss(page);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = paper;
  c.fillRect(0, 0, W, H);
  if (page.pattern === 'blank') return;
  const ink = patternInk(paper);
  // zoomed far out: skip every other line/dot instead of turning grey
  const minGap = (page.pattern === 'dots' ? 10 : 7) * unit;
  let step = page.spacing * k;
  while (step < minGap) step *= 2;
  const x0 = ((ox % step) + step) % step, y0 = ((oy % step) + step) % step;
  const lw = Math.max(1, Math.round(unit));        // crisp hairlines
  if (page.pattern === 'dots') {
    const r = Math.min(1.4, Math.max(0.7, k / unit)) * unit;
    c.fillStyle = ink.dot;
    c.beginPath();                                 // one path, one fill
    for (let x = x0; x < W; x += step)
      for (let y = y0; y < H; y += step) c.rect(x - r, y - r, r * 2, r * 2);
    c.fill();
    return;
  }
  c.fillStyle = ink.line;
  if (page.pattern === 'grid')
    for (let x = x0; x < W; x += step) c.fillRect(Math.round(x), 0, lw, H);
  for (let y = y0; y < H; y += step) c.fillRect(0, Math.round(y), W, lw);
  if (page.pattern === 'notebook') {               // red margin, three lines in
    const mx = Math.round(ox + page.spacing * 3 * k);
    if (mx > -lw && mx < W) { c.fillStyle = ink.margin; c.fillRect(mx, 0, Math.max(lw, Math.round(1.5 * unit)), H); }
  }
}

// The engine keeps the page style with the drawing, so it is saved in files.
function pushPageToEngine() {
  const idx = Math.max(0, PATTERNS.findIndex(q => q.id === settings.page.pattern));
  const p = PAPERS.find(q => q.id === settings.page.paper);
  E.qs_set_page(idx, settings.page.spacing, p && p.css ? hexToRGBA(p.css, 1) : 0);
}
function pullPageFromEngine() {
  const pat = PATTERNS[E.qs_page_pattern()] || PATTERNS[1];
  const rgba = E.qs_page_paper() >>> 0;
  const paper = PAPERS.find(q => q.css && hexToRGBA(q.css, 1) === rgba) || PAPERS[0];
  settings.page = { pattern: pat.id, spacing: E.qs_page_spacing(), paper: paper.id };
  saveSettings();
}

function renderLayer() {
  drawPage(lctx, cam.scale * dpr, cam.x * dpr, cam.y * dpr, layer.width, layer.height, dpr);
  lctx.setTransform(cam.scale * dpr, 0, 0, cam.scale * dpr, cam.x * dpr, cam.y * dpr);
  const n = E.qs_stroke_count();
  for (let id = 0; id < n; id++) {
    if (!E.qs_stroke_alive(id)) continue;
    if (sel && sel.ids.has(id)) continue;        // lifted: drawn on top, may be moving
    const e = getCommittedPath(id);
    lctx.fillStyle = e.css;
    lctx.fill(e.path);
  }
}

function setWorldTransform(c) {
  c.setTransform(cam.scale * dpr, 0, 0, cam.scale * dpr, cam.x * dpr, cam.y * dpr);
}

function render() {
  if (layerDirty) { layerDirty = false; renderLayer(); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  if (livePath) {
    // One closed outline per stroke: filling it directly is exact, even for
    // translucent ink, and matches the committed stroke pixel for pixel.
    setWorldTransform(ctx);
    ctx.fillStyle = liveCss;
    ctx.fill(livePath);
  }
  if (stroke && !stroke.erase && stroke.ropePx > 0 && penAt) drawString();
  if (sel) drawSelection();
  if (stroke && stroke.lasso && stroke.lasso.op === 'lasso') drawLassoPath(stroke.lasso.screen);
}

// The Stabilizer's string: from the ink to the pen, so you can see the slack.
function drawString() {
  const tx = E.qs_live_tip_x() * cam.scale + cam.x, ty = E.qs_live_tip_y() * cam.scale + cam.y;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = theme.accent;
  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(penAt.x, penAt.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(penAt.x, penAt.y, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(tx, ty, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

// Time spent per frame on stroke work + painting (last 240 frames that did work).
const frameTimes = [];
function frameStats() {
  if (!frameTimes.length) return null;
  const v = frameTimes.slice().sort((a, b) => a - b);
  const pick = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { frames: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, p95: pick(0.95), max: v[v.length - 1] };
}

function frame() {
  const t0 = performance.now();
  let worked = false;
  if (liveDirty) {
    // Tessellate once per frame no matter how many samples arrived.
    liveDirty = false;
    E.qs_live_update();
    livePath = outlineToPath(E.qs_live_outline_ptr(), E.qs_live_outline_count());
    needsRedraw = true;
  }
  if (needsRedraw) { needsRedraw = false; render(); worked = true; if (sel) placeSelBar(); }
  if (worked) {
    frameTimes.push(performance.now() - t0);
    if (frameTimes.length > 240) frameTimes.shift();
  }
  requestAnimationFrame(frame);
}

// -------------------------------------------------------------------------
// drawing / erasing
// -------------------------------------------------------------------------
function localXY(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
function capture(ev) {
  // Best effort: some browsers throw for pointers they consider inactive.
  try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
}
function samplesOf(ev) {
  const list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null;
  return list && list.length ? list : [ev];
}
function penButtonDown(ev) {
  // Stylus barrel button (S Pen side button) reports as button 2 / buttons&2;
  // an eraser tip reports as button 5 / buttons&32.
  return (ev.buttons & 2) !== 0 || (ev.buttons & 32) !== 0 || ev.button === 2 || ev.button === 5;
}

function beginStroke(ev, erase) {
  if (!erase && tool === 'lasso') { beginLasso(ev); return; }
  stroke = { id: ev.pointerId, type: ev.pointerType, erase, started: performance.now() };
  if (erase) {
    E.qs_erase_begin();
    eraseWith(ev);
    return;
  }
  const def = brushDef(), bp = brushParams();
  const rgba = hexToRGBA(color, bp.opacity);
  const minSize = settings.pressure ? bp.minSize : 1;
  const [nx, ny] = nibVector(bp.nibAngle ?? 45);
  const ropePx = (bp.stabilizer || 0) * STABILIZER_MAX_PX;
  E.qs_begin_stroke(rgba, bp.size, minSize, bp.smoothing * SMOOTHING_MAX, bp.streamline,
                    def.kind, nx, ny, NIB_RATIO, ropePx / cam.scale);
  stroke.ropePx = ropePx;
  liveCss = rgbaToCss(rgba);
  feedStroke(ev);
}

function feedStroke(ev) {
  for (const e of samplesOf(ev)) {
    const p = localXY(e);
    const w = screenToWorld(p.x, p.y);
    E.qs_add_point(w.x, w.y, mapPressure(e.pressure, e.pointerType), e.timeStamp);
    if (e.pointerType === 'pen') showPressure(e.pressure);
    penAt = p;
  }
  liveDirty = true;
}

function eraseWith(ev) {
  const radius = (settings.eraserSize / 2) / cam.scale;   // size is in screen px
  let removed = 0;
  for (const e of samplesOf(ev)) {
    const p = localXY(e);
    const w = screenToWorld(p.x, p.y);
    removed += E.qs_erase(w.x, w.y, radius);
  }
  if (removed > 0) { syncUndo(); viewChanged(); }
}

function endStroke() {
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  if (s.lasso) { finishLasso(s.lasso); return; }
  if (s.erase) { E.qs_erase_end(); syncUndo(); return; }
  const id = E.qs_commit_stroke();
  livePath = null; liveDirty = false;
  if (id >= 0) {
    const entry = getCommittedPath(id);
    if (!layerDirty) {                     // camera unchanged: just add it
      setWorldTransform(lctx);
      lctx.fillStyle = entry.css;
      lctx.fill(entry.path);
    }
  }
  syncUndo();
  needsRedraw = true;
}

function cancelStroke() {
  if (!stroke) return;
  if (stroke.lasso) { stroke = null; selT = null; showSelBar(); invalidate(); return; }
  if (stroke.erase) E.qs_erase_end(); else E.qs_cancel_stroke();
  stroke = null;
  livePath = null; liveDirty = false;
  needsRedraw = true;
  syncUndo();
  invalidate();
}

// -------------------------------------------------------------------------
// lasso: loop to select; drag inside to move, corner handle to resize, top
// handle to rotate. While dragging, the lifted strokes are drawn with a
// canvas transform (no engine work); letting go commits it in one call.
// -------------------------------------------------------------------------
const HANDLE_PX = 22;                            // touch-friendly hit radius
const ROTATE_GAP_PX = 34;                        // rotate handle above the box

// the live transform applied to a world point (identity when not dragging)
function selApply(x, y) {
  if (!selT) return { x, y };
  const c = Math.cos(selT.a) * selT.s, sn = Math.sin(selT.a) * selT.s;
  const dx = x - selT.px, dy = y - selT.py;
  return { x: selT.px + selT.tx + c * dx - sn * dy, y: selT.py + selT.ty + sn * dx + c * dy };
}
const toScreen = (p) => ({ x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y });
function selCorners() {                          // screen corners of the (transformed) box
  const b = sel.box, pad = 6 / cam.scale;
  return [[b.minx - pad, b.miny - pad], [b.maxx + pad, b.miny - pad], [b.maxx + pad, b.maxy + pad], [b.minx - pad, b.maxy + pad]]
    .map(([x, y]) => toScreen(selApply(x, y)));
}
function selHandles() {
  const c = selCorners();
  const top = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
  const mid = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 };
  const len = Math.hypot(top.x - mid.x, top.y - mid.y) || 1;
  const rot = { x: top.x + (top.x - mid.x) / len * ROTATE_GAP_PX, y: top.y + (top.y - mid.y) / len * ROTATE_GAP_PX };
  return { corners: c, scale: c[2], rotate: rot, top };
}

function setSelectionFromEngine() {
  const n = E.qs_selection_count();
  if (!n) { sel = null; showSelBar(); viewChanged(); return; }
  const ids = new Set();
  for (let i = 0; i < n; i++) ids.add(E.qs_selection_id(i));
  const b = f32(E.qs_selection_bounds(), 4);
  sel = { ids, box: { minx: b[0], miny: b[1], maxx: b[2], maxy: b[3] } };
  showSelBar();
  viewChanged();                                 // the layer leaves lifted strokes out
}
function dropSelection() {
  if (!sel && !selT) return;
  E.qs_select_clear();
  sel = null; selT = null;
  showSelBar();
  viewChanged();
}

function beginLasso(ev) {
  const p = localXY(ev), w = screenToWorld(p.x, p.y);
  stroke = { id: ev.pointerId, type: ev.pointerType, lasso: null, started: performance.now() };
  if (sel) {
    const h = selHandles();
    const near = (q) => Math.hypot(p.x - q.x, p.y - q.y) <= HANDLE_PX;
    const b = sel.box, pad = 10 / cam.scale;
    const inside = w.x >= b.minx - pad && w.x <= b.maxx + pad && w.y >= b.miny - pad && w.y <= b.maxy + pad;
    let op = null, pivot = null;
    if (near(h.rotate)) { op = 'rotate'; pivot = { x: (b.minx + b.maxx) / 2, y: (b.miny + b.maxy) / 2 }; }
    else if (near(h.scale)) { op = 'scale'; pivot = { x: b.minx, y: b.miny }; }
    else if (inside) { op = 'move'; pivot = { x: b.minx, y: b.miny }; }
    if (op) {
      stroke.lasso = { op, start: w, pivot };
      selT = { s: 1, a: 0, tx: 0, ty: 0, px: pivot.x, py: pivot.y };
      showSelBar();                              // hide the bar while dragging
      return;
    }
    dropSelection();                             // tapped elsewhere: start a new loop
  }
  stroke.lasso = { op: 'lasso', pts: [w.x, w.y], screen: [p] };
  invalidate();
}

function lassoMove(ev) {
  const L = stroke.lasso;
  for (const e of samplesOf(ev)) {
    const p = localXY(e), w = screenToWorld(p.x, p.y);
    if (L.op === 'lasso') {
      const last = L.screen[L.screen.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 3) continue;
      L.screen.push(p); L.pts.push(w.x, w.y);
    } else if (L.op === 'move') {
      selT.tx = w.x - L.start.x; selT.ty = w.y - L.start.y;
    } else if (L.op === 'scale') {
      // uniform, along the diagonal from the fixed corner
      const ax = L.start.x - L.pivot.x, ay = L.start.y - L.pivot.y;
      const d2 = ax * ax + ay * ay || 1;
      selT.s = Math.min(20, Math.max(0.05, ((w.x - L.pivot.x) * ax + (w.y - L.pivot.y) * ay) / d2));
    } else if (L.op === 'rotate') {
      let a = Math.atan2(w.y - L.pivot.y, w.x - L.pivot.x) - Math.atan2(L.start.y - L.pivot.y, L.start.x - L.pivot.x);
      const snap = Math.PI / 12;                 // gentle snap to 15° steps
      if (Math.abs(a - Math.round(a / snap) * snap) < 0.035) a = Math.round(a / snap) * snap;
      selT.a = a;
    }
  }
  invalidate();
}

function finishLasso(L) {
  if (L.op === 'lasso') {
    if (L.screen.length >= 3) {
      const n = L.pts.length;
      const dst = E.qs_alloc(n * 4);
      f32(dst, n).set(L.pts);
      E.qs_lasso(dst, n);
    } else {
      E.qs_select_clear();
    }
    setSelectionFromEngine();
    invalidate();
    return;
  }
  const t = selT;
  selT = null;
  const moved = t && (Math.abs(t.tx) + Math.abs(t.ty) > 1e-3 / cam.scale || Math.abs(t.s - 1) > 1e-4 || Math.abs(t.a) > 1e-4);
  if (moved) {
    E.qs_selection_transform(t.s, Math.cos(t.a), Math.sin(t.a), t.tx, t.ty, t.px, t.py);
    syncUndo();
    setSelectionFromEngine();                    // the edited copies stay selected
  } else {
    showSelBar();
    invalidate();
  }
}

function drawSelection() {
  // lifted strokes, moved by the live transform
  setWorldTransform(ctx);
  if (selT) {
    ctx.translate(selT.px + selT.tx, selT.py + selT.ty);
    ctx.rotate(selT.a);
    ctx.scale(selT.s, selT.s);
    ctx.translate(-selT.px, -selT.py);
  }
  for (const id of sel.ids) {
    const e = getCommittedPath(id);
    ctx.fillStyle = e.css;
    ctx.fill(e.path);
  }
  // dashed box + handles (screen space)
  const h = selHandles();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  h.corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(h.top.x, h.top.y); ctx.lineTo(h.rotate.x, h.rotate.y); ctx.stroke();
  for (const q of [h.scale, h.rotate]) {
    ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = theme.bg; ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = theme.accent;
  ctx.beginPath(); ctx.arc(h.rotate.x, h.rotate.y, 2.5, 0, Math.PI * 2); ctx.fill();
}

function drawLassoPath(pts) {
  if (pts.length < 2) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.globalAlpha = 0.08; ctx.fillStyle = theme.accent; ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.accent; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// floating Delete / Duplicate / Done bar above the selection
function showSelBar() {
  const bar = $('selBar');
  const dragging = !!(stroke && stroke.lasso && stroke.lasso.op !== 'lasso');
  if (!sel || dragging) { bar.hidden = true; return; }
  bar.hidden = false;
  placeSelBar();
}
function placeSelBar() {
  const bar = $('selBar');
  if (bar.hidden || !sel) return;
  const h = selHandles();
  const xs = h.corners.map(q => q.x), ys = h.corners.map(q => q.y);
  const bw = bar.offsetWidth, bh = bar.offsetHeight, W = canvas.clientWidth, H = canvas.clientHeight;
  let x = (Math.min(...xs) + Math.max(...xs)) / 2 - bw / 2;
  let y = Math.min(...ys, h.rotate.y) - bh - 12;
  if (y < 8) y = Math.max(...ys) + 12;          // no room above: go below
  bar.style.left = Math.max(8, Math.min(W - bw - 8, x)) + 'px';
  bar.style.top = Math.max(8, Math.min(H - bh - 8, y)) + 'px';
}
function deleteSelection() {
  if (!sel) return;
  E.qs_selection_delete();
  sel = null; selT = null; showSelBar(); syncUndo(); viewChanged();
}
function duplicateSelection() {
  if (!sel) return;
  const off = 24 / cam.scale;
  E.qs_selection_duplicate(off, off);
  syncUndo(); setSelectionFromEngine();
}

// -------------------------------------------------------------------------
// touch gestures
// -------------------------------------------------------------------------
function fingersDraw() {
  return settings.fingers === 'draw' || (settings.fingers === 'auto' && !penSeen);
}
function pinchInfo() {
  const [a, b] = touches.values();
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
}
function startPinch() {
  gesture = Object.assign({ kind: 'pinch' }, pinchInfo());
}
function abortTouches() {                 // palm rejection: the pen wins
  if (stroke && stroke.type === 'touch') cancelStroke();
  touches.clear(); gesture = null; tap = null;
}

function touchDown(ev) {
  if (stroke && stroke.type !== 'touch') return;          // palm while pen/mouse draws
  const p = localXY(ev);
  touches.set(ev.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y });
  capture(ev);

  if (touches.size === 1) {
    tap = { t: performance.now(), max: 1, moved: false };
    if (fingersDraw() && tool !== 'pan' && !spaceHeld) {
      beginStroke(ev, tool === 'eraser');
    } else {
      gesture = { kind: 'pan', id: ev.pointerId };
    }
    return;
  }
  if (tap) tap.max = Math.max(tap.max, touches.size);
  if (stroke) {
    // A second finger turns a just-started finger stroke into a gesture;
    // a stroke that was already well under way is kept.
    if (performance.now() - stroke.started < 250) cancelStroke(); else endStroke();
  }
  startPinch();
}

function touchMove(ev) {
  const t = touches.get(ev.pointerId);
  if (!t) return;
  const p = localXY(ev);
  const dx = p.x - t.x, dy = p.y - t.y;
  t.x = p.x; t.y = p.y;
  if (tap && Math.hypot(p.x - t.sx, p.y - t.sy) > 12) tap.moved = true;

  if (stroke && stroke.id === ev.pointerId) {
    if (stroke.erase) eraseWith(ev); else if (stroke.lasso) lassoMove(ev); else feedStroke(ev);
    return;
  }
  if (!gesture) return;
  if (gesture.kind === 'pan' && gesture.id === ev.pointerId) {
    cam.x += dx; cam.y += dy;
    viewChanged();
  } else if (gesture.kind === 'pinch' && touches.size >= 2) {
    const now = pinchInfo();
    // Keep the world point under the old centroid under the new centroid:
    // this does pinch-zoom and two-finger pan in one step.
    const before = screenToWorld(gesture.cx, gesture.cy);
    const f = gesture.d > 0 && now.d > 0 ? now.d / gesture.d : 1;
    cam.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.scale * f));
    cam.x = now.cx - before.x * cam.scale;
    cam.y = now.cy - before.y * cam.scale;
    Object.assign(gesture, now);
    updateZoomLabel();
    viewChanged();
  }
}

function touchUp(ev) {
  if (!touches.has(ev.pointerId)) return;
  touches.delete(ev.pointerId);

  if (stroke && stroke.id === ev.pointerId) endStroke();

  if (touches.size >= 2) {
    startPinch();                                   // re-seed with remaining pair
  } else if (touches.size === 1) {
    // pinch -> one finger left: keep panning with it, never start drawing
    gesture = { kind: 'pan', id: touches.keys().next().value };
  } else {
    gesture = null;
    if (tap && !tap.moved && tap.max >= 2 && performance.now() - tap.t < 350) {
      if (tap.max === 2) doUndo(true); else doRedo(true);
    }
    tap = null;
  }
}

// -------------------------------------------------------------------------
// pointer routing
// -------------------------------------------------------------------------
canvas.addEventListener('pointerdown', (ev) => {
  hideHint();
  closePanel();
  closeBrushMenu();
  closePagePanel();
  if (ev.pointerType === 'touch') { touchDown(ev); return; }

  if (ev.pointerType === 'pen') {
    markPen();
    abortTouches();
  }
  if (stroke) return;                               // already drawing with something

  const panGesture = tool === 'pan' || spaceHeld || ev.button === 1;
  if (panGesture) {
    capture(ev);
    mousePan = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  const penErase = ev.pointerType === 'pen' && settings.penButtonErase && penButtonDown(ev);
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  capture(ev);
  beginStroke(ev, tool === 'eraser' || penErase);
});

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType === 'touch') { touchMove(ev); return; }
  if (ev.pointerType === 'pen') { markPen(); if (!stroke) showPressure(ev.pressure); }
  if (mousePan && mousePan.id === ev.pointerId) {
    cam.x += ev.clientX - mousePan.x;
    cam.y += ev.clientY - mousePan.y;
    mousePan.x = ev.clientX; mousePan.y = ev.clientY;
    viewChanged();
    return;
  }
  if (!stroke || stroke.id !== ev.pointerId) return;
  if (stroke.erase) eraseWith(ev); else if (stroke.lasso) lassoMove(ev); else feedStroke(ev);
});

function pointerEnd(ev) {
  if (ev.pointerType === 'touch') { touchUp(ev); return; }
  if (mousePan && mousePan.id === ev.pointerId) {
    mousePan = null;
    setCursor();
    return;
  }
  if (stroke && stroke.id === ev.pointerId) endStroke();
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('lostpointercapture', (ev) => {
  if (stroke && stroke.id === ev.pointerId && ev.pointerType !== 'touch') endStroke();
});
// S Pen side-button clicks and long-presses must not open a context menu.
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// wheel: zoom toward cursor (ctrl+wheel = trackpad pinch); shift+wheel pans
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const p = localXY(ev);
  if (ev.shiftKey && !ev.ctrlKey) {
    cam.x -= ev.deltaX || ev.deltaY;
    viewChanged();
    return;
  }
  zoomAbout(p.x, p.y, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

// -------------------------------------------------------------------------
// UI wiring
// -------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const PALETTE = ['#1b1d23', '#e5484d', '#f5a524', '#30a46c', '#4f6bed', '#8e4ec6', '#e93d82', '#ffffff'];

function buildSwatches() {
  const host = $('swatches');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.setAttribute('aria-pressed', String(i === 0));
    b.title = c;
    b.addEventListener('click', () => setColor(c, b));
    host.appendChild(b);
  });
}
function setColor(c, btn) {
  color = c;
  $('colorInput').value = c;
  document.querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', 'false'));
  if (btn) btn.setAttribute('aria-pressed', 'true');
  if (sel) {                                     // lasso selection: recolour it
    E.qs_selection_recolor(hexToRGBA(c, 1));
    syncUndo(); setSelectionFromEngine();
    return;
  }
  if (tool !== 'pen') selectTool('pen');
}
function setCursor() {
  canvas.style.cursor = tool === 'pan' ? 'grab' : (tool === 'eraser' ? 'cell' : 'crosshair');
}
function selectTool(t) {
  if (t !== 'lasso') dropSelection();
  tool = t;
  document.querySelectorAll('.tool').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  setCursor();
  showSize();
}
// The Size slider edits whatever is active: the eraser, or the current brush.
const currentSize = () => (tool === 'eraser' ? settings.eraserSize : brushParams().size);
function showSize() {
  const v = currentSize();
  $('widthInput').value = v;
  $('widthVal').textContent = v;
  $('widthInput').closest('label').title =
    (tool === 'eraser' ? 'Eraser size' : brushDef().name + ' size') + ' ( [ and ] )';
}
function setSize(w) {
  const v = Math.max(1, Math.min(48, Math.round(w)));
  if (tool === 'eraser') settings.eraserSize = v; else brushParams().size = v;
  saveSettings();
  showSize();
}

// ---- brush picker ----
const brushMenu = $('brushMenu');
function selectBrush(id, { keepPanel = false } = {}) {
  if (!BRUSHES.some(b => b.id === id)) return;
  settings.brush = id;
  saveSettings();
  selectTool('pen');
  syncBrushUI();
  closeBrushMenu();
  if (!keepPanel) closePanel();
}
function syncBrushUI() {
  const def = brushDef();
  $('penIcon').textContent = def.icon;
  $('penName').textContent = def.name;
  $('brushSectionTitle').textContent = def.name;
  document.querySelectorAll('.nib-only').forEach(el => { el.hidden = def.kind !== TIP_NIB; });
  document.querySelectorAll('.brush-item').forEach(el =>
    el.setAttribute('aria-pressed', String(el.dataset.brush === def.id)));
  document.querySelectorAll('.brush-chip').forEach(el =>
    el.setAttribute('aria-checked', String(el.dataset.brush === def.id)));
  refreshers.forEach(f => f());
  showSize();
  drawCurve();
}
function buildBrushMenu() {
  const list = $('brushList');
  for (const b of BRUSHES) {
    const item = document.createElement('button');
    item.className = 'brush-item';
    item.dataset.brush = b.id;
    item.innerHTML = `<span class="bi-icon">${b.icon}</span><span class="bi-name">${b.name}</span>` +
                     `<canvas class="bi-preview" aria-hidden="true"></canvas>`;
    item.addEventListener('click', () => selectBrush(b.id));
    list.appendChild(item);
    // the same choice at the top of the Brush settings panel
    const chip = document.createElement('button');
    chip.className = 'brush-chip';
    chip.dataset.brush = b.id;
    chip.setAttribute('role', 'radio');
    chip.innerHTML = `<span class="ci">${b.icon}</span><span>${b.name}</span>`;
    chip.addEventListener('click', () => selectBrush(b.id, { keepPanel: true }));
    $('brushChips').appendChild(chip);
  }
}
function openBrushMenu() {
  closePanel();
  closePagePanel();
  brushMenu.hidden = false;
  $('penTool').setAttribute('aria-expanded', 'true');
  renderBrushPreviews();
}
function closeBrushMenu() {
  if (brushMenu.hidden) return;
  brushMenu.hidden = true;
  $('penTool').setAttribute('aria-expanded', 'false');
}
// Draw a sample stroke with every brush using the real engine, through the
// live-stroke API (begin -> points -> update -> cancel), so the document and
// undo history are never touched.
function renderBrushPreviews() {
  if (stroke) return;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#000';
  const r = Math.max(1, window.devicePixelRatio || 1);
  document.querySelectorAll('.brush-item').forEach(item => {
    const def = BRUSHES.find(b => b.id === item.dataset.brush);
    const bp = settings.brushes[def.id];
    const cv = item.querySelector('canvas');
    const W = cv.clientWidth || 200, H = cv.clientHeight || 44;
    cv.width = Math.round(W * r); cv.height = Math.round(H * r);
    const c = cv.getContext('2d');
    c.setTransform(r, 0, 0, r, 0, 0);
    c.clearRect(0, 0, W, H);
    const size = Math.min(bp.size, H * 0.5);          // keep fat brushes inside the box
    const amp = Math.max(2, H / 2 - size / 2 - 4);
    const [nx, ny] = nibVector(bp.nibAngle ?? 45);
    E.qs_begin_stroke(hexToRGBA('#000000', 1), size, settings.pressure ? bp.minSize : 1,
                      0, 0, def.kind, nx, ny, NIB_RATIO, 0);
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const press = settings.pressure ? mapPressure(0.15 + 0.85 * Math.sin(Math.PI * t), 'pen') : 1;
      E.qs_add_point(size / 2 + 6 + t * (W - size - 12), H / 2 - Math.sin(t * Math.PI * 2) * amp, press, i * 8);
    }
    E.qs_live_update();
    const path = outlineToPath(E.qs_live_outline_ptr(), E.qs_live_outline_count());
    E.qs_cancel_stroke();
    c.globalAlpha = bp.opacity;
    c.fillStyle = ink;
    c.fill(path);
  });
}
function updateZoomLabel() {
  $('zoomVal').textContent = Math.round(cam.scale * 100) + '%';
}
function syncUndo() {
  $('undoBtn').disabled = !E.qs_can_undo();
  $('redoBtn').disabled = !E.qs_can_redo();
}
function doUndo(fromGesture) {
  dropSelection();
  if (E.qs_undo()) { syncUndo(); viewChanged(); if (fromGesture) toast('Undo'); }
}
function doRedo(fromGesture) {
  dropSelection();
  if (E.qs_redo()) { syncUndo(); viewChanged(); if (fromGesture) toast('Redo'); }
}
function resetView() {
  cam.x = 0; cam.y = 0; cam.scale = 1;
  updateZoomLabel(); viewChanged();
}
function zoomCenter(f) { zoomAbout(canvas.clientWidth / 2, canvas.clientHeight / 2, f); }

document.querySelectorAll('.tool').forEach(b =>
  b.addEventListener('click', () => {
    if (b.dataset.tool === 'pen' && tool === 'pen') {
      brushMenu.hidden ? openBrushMenu() : closeBrushMenu();
      return;
    }
    closeBrushMenu();
    selectTool(b.dataset.tool);
  }));
$('colorInput').addEventListener('input', (e) => setColor(e.target.value, null));
$('widthInput').addEventListener('input', (e) => setSize(parseInt(e.target.value, 10)));
$('undoBtn').addEventListener('click', () => doUndo(false));
$('redoBtn').addEventListener('click', () => doRedo(false));
$('clearBtn').addEventListener('click', () => {
  dropSelection();
  if (E.qs_clear() > 0) { syncUndo(); viewChanged(); }
});
$('zoomIn').addEventListener('click', () => zoomCenter(1.25));
$('zoomOut').addEventListener('click', () => zoomCenter(0.8));
$('zoomFit').addEventListener('click', resetView);

// save / open / png
$('saveBtn').addEventListener('click', () => {
  const ptr = E.qs_save_ptr(), len = E.qs_save_len();
  const bytes = u8(ptr, len).slice();
  downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), 'drawing.qsketch');
});
$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  const dst = E.qs_alloc(buf.length);
  u8(dst, buf.length).set(buf);
  if (E.qs_load(dst, buf.length)) {
    pathCache.clear(); livePath = null; dropSelection();
    if (E.qs_page_loaded()) { pullPageFromEngine(); syncPageUI(); } else pushPageToEngine();
    syncUndo(); viewChanged();
  } else {
    alert('Not a valid .qsketch file.');
  }
  e.target.value = '';
});
$('pngBtn').addEventListener('click', exportPNG);
// lasso selection bar
$('selDelete').addEventListener('click', deleteSelection);
$('selDuplicate').addEventListener('click', duplicateSelection);
$('selDone').addEventListener('click', dropSelection);

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Export just the inked area (tight crop) to PNG at 2x for crisp output.
function exportPNG() {
  const n = E.qs_stroke_count();
  let minx = 1e30, miny = 1e30, maxx = -1e30, maxy = -1e30, any = false;
  for (let id = 0; id < n; id++) {
    if (!E.qs_stroke_alive(id)) continue;
    const ptr = E.qs_stroke_outline_ptr(id), cnt = E.qs_stroke_outline_count(id);
    if (!ptr || cnt < 7) continue;
    forEachOutlinePoint(ptr, cnt, (x, y) => {
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    });
    any = true;
  }
  if (!any) { alert('Nothing to export yet — draw something first.'); return; }
  const pad = 24, sc = 2;
  const w = Math.ceil((maxx - minx) + pad * 2), h = Math.ceil((maxy - miny) + pad * 2);
  const off = document.createElement('canvas');
  off.width = w * sc; off.height = h * sc;
  const c = off.getContext('2d');
  drawPage(c, sc, sc * (pad - minx), sc * (pad - miny), off.width, off.height, sc);
  c.setTransform(sc, 0, 0, sc, sc * (pad - minx), sc * (pad - miny));
  for (let id = 0; id < n; id++) {
    if (!E.qs_stroke_alive(id)) continue;
    const e = getCommittedPath(id);
    c.fillStyle = e.css; c.fill(e.path);
  }
  off.toBlob(b => downloadBlob(b, 'qsketch.png'), 'image/png');
}

// -------------------------------------------------------------------------
// Page panel
// -------------------------------------------------------------------------
const pagePanel = $('pagePanel');
function openPagePanel() {
  closePanel(); closeBrushMenu();
  pagePanel.hidden = false;
  $('pageBtn').setAttribute('aria-expanded', 'true');
  syncPageUI();
}
function closePagePanel() {
  if (pagePanel.hidden) return;
  pagePanel.hidden = true;
  $('pageBtn').setAttribute('aria-expanded', 'false');
}
$('pageBtn').addEventListener('click', () => (pagePanel.hidden ? openPagePanel() : closePagePanel()));
$('pageClose').addEventListener('click', closePagePanel);

function setPage(patch) {
  Object.assign(settings.page, patch);
  saveSettings();
  pushPageToEngine();
  syncPageUI();
  viewChanged();
}
function buildPagePanel() {
  for (const pat of PATTERNS) {
    const b = document.createElement('button');
    b.className = 'pattern-chip'; b.dataset.pattern = pat.id; b.setAttribute('role', 'radio');
    b.innerHTML = `<canvas aria-hidden="true"></canvas><span>${pat.name}</span>`;
    b.addEventListener('click', () => setPage({ pattern: pat.id }));
    $('patternChips').appendChild(b);
  }
  for (const pap of PAPERS) {
    const b = document.createElement('button');
    b.className = 'paper-chip'; b.dataset.paper = pap.id; b.setAttribute('role', 'radio');
    b.title = pap.name;
    b.innerHTML = `<i style="background:${pap.css || 'linear-gradient(135deg,#fff 50%,#1e2128 50%)'}"></i><span>${pap.name}</span>`;
    b.addEventListener('click', () => setPage({ paper: pap.id }));
    $('paperChips').appendChild(b);
  }
  $('pageSpacing').addEventListener('input', (e) => setPage({ spacing: +e.target.value }));
}
function syncPageUI() {
  const pg = settings.page;
  $('pageSpacing').value = pg.spacing;
  $('pageSpacingVal').textContent = Math.round(pg.spacing) + ' px';
  document.querySelectorAll('.paper-chip').forEach(el =>
    el.setAttribute('aria-checked', String(el.dataset.paper === pg.paper)));
  const r = Math.max(1, window.devicePixelRatio || 1);
  document.querySelectorAll('.pattern-chip').forEach(el => {
    el.setAttribute('aria-checked', String(el.dataset.pattern === pg.pattern));
    if (pagePanel.hidden) return;
    const cv = el.querySelector('canvas');
    const W = cv.clientWidth || 56, H = cv.clientHeight || 40;
    cv.width = Math.round(W * r); cv.height = Math.round(H * r);
    // preview each pattern on the current paper at a readable density
    drawPage(cv.getContext('2d'), r * 9 / 24, 4 * r, 4 * r, cv.width, cv.height, r,
             { pattern: el.dataset.pattern, spacing: 24, paper: pg.paper });
  });
}

// -------------------------------------------------------------------------
// Brush settings panel
// -------------------------------------------------------------------------
const panel = $('brushPanel');
function openPanel() {
  closeBrushMenu();
  closePagePanel();
  panel.hidden = false;
  $('brushBtn').setAttribute('aria-expanded', 'true');
  if (lastPenPressure != null) showPressure(lastPenPressure); else drawCurve();
}
function closePanel() { if (!panel.hidden) { panel.hidden = true; $('brushBtn').setAttribute('aria-expanded', 'false'); } }
$('brushBtn').addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
$('panelClose').addEventListener('click', closePanel);

const pct = (v) => Math.round(v * 100) + '%';
function curveLabel(c) {
  if (Math.abs(c) < 0.05) return 'Linear';
  return (c < 0 ? 'Soft ' : 'Firm ') + Math.round(Math.abs(c) * 100) + '%';
}

// Bind a slider to a value through get/set; `scale` maps value -> slider units.
function bindRange(id, get, set, label, scale = 100) {
  const el = $(id), out = $(id + 'Val');
  const show = () => { el.value = Math.round(get() * scale); out.textContent = label(get()); };
  el.addEventListener('input', () => {
    set(parseFloat(el.value) / scale);
    out.textContent = label(get());
    saveSettings(); drawCurve();
  });
  show();
  return show;
}
const bp = () => brushParams();
const refreshers = [
  bindRange('stabilizer', () => bp().stabilizer || 0, v => { bp().stabilizer = v; },
            v => v > 0 ? Math.round(v * STABILIZER_MAX_PX) + ' px' : 'Off'),
  bindRange('streamline', () => bp().streamline, v => { bp().streamline = v; }, pct),
  bindRange('smoothing', () => bp().smoothing, v => { bp().smoothing = v; }, pct),
  bindRange('opacity', () => bp().opacity, v => { bp().opacity = Math.max(0.05, v); }, pct),
  bindRange('nibAngle', () => bp().nibAngle ?? 45, v => { bp().nibAngle = v; },
            v => Math.round(v) + '°', 1),
  bindRange('minSize', () => bp().minSize, v => { bp().minSize = v; }, pct),
  bindRange('curve', () => settings.curve, v => { settings.curve = v; }, curveLabel),
];
function bindCheck(id, key) {
  const el = $(id);
  el.checked = !!settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); syncPressureUI(); });
  return () => { el.checked = !!settings[key]; };
}
refreshers.push(bindCheck('pressureOn', 'pressure'), bindCheck('penButtonErase', 'penButtonErase'));
$('fingers').value = settings.fingers;
$('fingers').addEventListener('change', (e) => { settings.fingers = e.target.value; saveSettings(); updateFingerNote(); });
refreshers.push(() => { $('fingers').value = settings.fingers; });

$('resetBrush').addEventListener('click', () => {
  const brush = settings.brush;
  settings = defaultSettings();
  settings.brush = brush;
  saveSettings();
  syncBrushUI();
  syncPressureUI(); updateFingerNote();
});

function syncPressureUI() {
  document.querySelectorAll('.needs-pressure').forEach(el =>
    el.classList.toggle('disabled', !settings.pressure));
  drawCurve();
}

// Pressure curve preview: x = pen pressure, y = resulting size.
function drawCurve() {
  const cv = $('curveCanvas');
  if (!cv || panel.hidden) return;
  const cssW = cv.clientWidth || 240, cssH = cv.clientHeight || 110;
  const r = Math.max(1, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(cssW * r)) { cv.width = Math.round(cssW * r); cv.height = Math.round(cssH * r); }
  const c = cv.getContext('2d');
  c.setTransform(r, 0, 0, r, 0, 0);
  const cs = getComputedStyle(document.documentElement);
  const grid = cs.getPropertyValue('--border').trim();
  const accent = cs.getPropertyValue('--accent').trim();
  const muted = cs.getPropertyValue('--muted').trim();
  c.clearRect(0, 0, cssW, cssH);
  const pad = 8, W = cssW - pad * 2, H = cssH - pad * 2;
  c.strokeStyle = grid; c.lineWidth = 1;
  c.strokeRect(pad + 0.5, pad + 0.5, W, H);
  c.beginPath();
  for (let i = 1; i < 4; i++) {
    c.moveTo(pad + (W * i) / 4, pad); c.lineTo(pad + (W * i) / 4, pad + H);
    c.moveTo(pad, pad + (H * i) / 4); c.lineTo(pad + W, pad + (H * i) / 4);
  }
  c.stroke();
  // size = minSize + (1 - minSize) * curve(pressure)
  const min = settings.pressure ? brushParams().minSize : 1;
  c.strokeStyle = settings.pressure ? accent : muted;
  c.lineWidth = 2.5;
  c.beginPath();
  for (let i = 0; i <= 64; i++) {
    const p = i / 64;
    const s = min + (1 - min) * mapPressure(p, 'pen');
    const x = pad + p * W, y = pad + H - s * H;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  if (lastPenPressure != null && settings.pressure) {
    const p = lastPenPressure;
    const s = min + (1 - min) * mapPressure(p, 'pen');
    c.fillStyle = accent;
    c.beginPath(); c.arc(pad + p * W, pad + H - s * H, 4, 0, Math.PI * 2); c.fill();
  }
}

let lastPenPressure = null;
function showPressure(p) {
  lastPenPressure = Math.min(1, Math.max(0, p || 0));
  if (panel.hidden) return;
  $('pressureNow').textContent = lastPenPressure.toFixed(2);
  $('pressureBar').style.width = (lastPenPressure * 100).toFixed(0) + '%';
  drawCurve();
}

function markPen() {
  if (penSeen) return;
  penSeen = true;
  updateFingerNote();
}
function updateFingerNote() {
  const note = $('fingerNote');
  if (settings.fingers === 'auto') {
    note.textContent = penSeen
      ? 'Pen detected — fingers now pan & zoom.'
      : 'Fingers draw until you use a pen, then switch to pan & zoom.';
  } else {
    note.textContent = settings.fingers === 'draw'
      ? 'One finger draws; two fingers pan & zoom.'
      : 'Fingers only pan & zoom. Draw with the pen or mouse.';
  }
}

// -------------------------------------------------------------------------
// keyboard, toast, hint
// -------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { spaceHeld = true; if (!stroke) canvas.style.cursor = 'grab'; return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo(false); else doUndo(false);
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(false); return; }
  if (mod && e.key.toLowerCase() === 'd' && sel) { e.preventDefault(); duplicateSelection(); return; }
  if (mod) return;
  switch (e.key.toLowerCase()) {
    case 'p': selectTool('pen'); break;
    case 'e': selectTool('eraser'); break;
    case 'h': selectTool('pan'); break;
    case 'l': selectTool('lasso'); break;
    case 'delete': case 'backspace': if (sel) { e.preventDefault(); deleteSelection(); } break;
    case 'b': panel.hidden ? openPanel() : closePanel(); break;
    case '[': setSize(currentSize() - 1); break;
    case ']': setSize(currentSize() + 1); break;
    case '1': case '2': case '3': case '4': selectBrush(BRUSHES[+e.key - 1].id); break;
    case '+': case '=': zoomCenter(1.25); break;
    case '-': zoomCenter(0.8); break;
    case '0': resetView(); break;
    case 'escape': closePanel(); closeBrushMenu(); closePagePanel(); dropSelection(); break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceHeld = false; if (!stroke && !mousePan) setCursor(); }
});
window.addEventListener('resize', resize);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 900);
}

let hintTimer = null;
function hideHint() {
  const h = $('hint');
  if (h && !h.classList.contains('gone')) h.classList.add('gone');
  clearTimeout(hintTimer);
}

// -------------------------------------------------------------------------
// boot the wasm engine
// -------------------------------------------------------------------------
// -------------------------------------------------------------------------
// new deploys: tell the user instead of silently running old code
// -------------------------------------------------------------------------
let updateShown = false;
async function checkForUpdate() {
  if (APP_VERSION === 'dev' || updateShown) return;
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (version && version !== APP_VERSION) showUpdate();
  } catch (_) { /* offline: try again later */ }
}
function showUpdate() {
  updateShown = true;
  $('updateBar').hidden = false;
}
function watchForUpdates() {
  if (APP_VERSION === 'dev') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  setInterval(checkForUpdate, 10 * 60 * 1000);
}
$('updateReload').addEventListener('click', () => {
  // A reload clears the canvas: offer to keep the drawing first.
  if (E && E.qs_can_undo() && !confirm('Reloading clears the current drawing. Reload now? (Cancel to Save it first.)')) return;
  fetch(location.pathname, { cache: 'reload' }).catch(() => {}).then(() => location.reload());
});
$('updateLater').addEventListener('click', () => { $('updateBar').hidden = true; });

async function boot() {
  const resp = await fetch(WASM_URL);
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching ' + WASM_URL);
  const module = await WebAssembly.compile(await resp.arrayBuffer());
  // Provide a stub for every import so instantiation can never fail, whatever
  // the toolchain happened to leave undefined.
  const env = {};
  for (const im of WebAssembly.Module.imports(module)) {
    if (im.module !== 'env') continue;
    env[im.name] = (im.kind === 'function') ? (() => 0) : 0;
  }
  const instance = await WebAssembly.instantiate(module, { env });
  E = instance.exports;
  E.qs_init();
  window.QSketch = E;   // exposed for automation / debugging
  window.QSketchView = { cam, frameStats, resetFrameStats: () => { frameTimes.length = 0; },
                         get settings() { return settings; }, get penSeen() { return penSeen; } };

  if (matchMedia('(pointer: coarse)').matches) {
    $('hint').innerHTML = '<b>Pinch</b> to zoom · <b>two fingers</b> to pan · <b>2-finger tap</b> undo';
  }
  buildSwatches();
  buildBrushMenu();
  buildPagePanel();
  pushPageToEngine();
  selectTool('pen');
  syncBrushUI();
  readTheme();
  resize();
  updateZoomLabel();
  syncUndo();
  syncPressureUI();
  updateFingerNote();
  $('loading').classList.add('hidden');
  requestAnimationFrame(frame);
  hintTimer = setTimeout(hideHint, 8000);
  watchForUpdates();
}

boot().catch(err => {
  console.error(err);
  $('loading').innerHTML = '<p style="color:#e5484d">Failed to load the WASM engine.<br>' +
                           'Serve this folder over HTTP (not file://) and reload.</p>';
});
