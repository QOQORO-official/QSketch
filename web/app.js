/* QSketch front-end.
 *
 * The Nim/WASM engine owns all geometry (stroke smoothing, tessellation,
 * hit-testing, undo, serialization) in *world* coordinates. This file owns
 * the camera and rendering: pan/zoom are a single Canvas2D setTransform, so
 * the engine never re-runs for a view change. Committed strokes are turned
 * into a Path2D exactly once (their outline never changes) and cached by id;
 * only the in-progress stroke is re-tessellated per pointer move.
 */
'use strict';

const WASM_URL = 'qsketch.wasm';

// ---- engine handle (filled after load) ----
let E = null;        // wasm exports
let mem = null;      // DataView-free typed views rebuilt if memory grows

function f32(ptr, count) { return new Float32Array(E.memory.buffer, ptr, count); }
function u8(ptr, count)  { return new Uint8Array(E.memory.buffer, ptr, count); }

// ---- camera: screen = world * scale + offset (CSS pixels) ----
const cam = { x: 0, y: 0, scale: 1 };        // offset x/y, zoom
function screenToWorld(sx, sy) {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

// ---- state ----
let tool = 'pen';
let color = '#1b1d23';
let width = 4;
let dpr = Math.max(1, window.devicePixelRatio || 1);

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

// per-stroke Path2D cache: id -> {path, css}
const pathCache = new Map();
let liveStroke = null;         // {path, css} for the in-progress stroke
let drawing = false;
let panning = false;
let spaceHeld = false;
let lastPan = null;
let activePointerId = null;
let needsRedraw = true;

// -------------------------------------------------------------------------
// colour helpers
// -------------------------------------------------------------------------
function hexToRGBA(hex) {              // "#rrggbb" -> 0xRRGGBBAA (>>>0)
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0);
}
function rgbaToCss(v) {                 // 0xRRGGBBAA -> css
  const r = (v >>> 24) & 0xff, g = (v >>> 16) & 0xff, b = (v >>> 8) & 0xff, a = v & 0xff;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

// -------------------------------------------------------------------------
// building Path2D from an engine outline buffer (world coords)
// -------------------------------------------------------------------------
function outlineToPath(ptr, count) {
  const p = new Path2D();
  if (!ptr || count < 4) return p;
  const a = f32(ptr, count);
  p.moveTo(a[0], a[1]);
  for (let i = 2; i < count; i += 2) p.lineTo(a[i], a[i + 1]);
  p.closePath();
  return p;
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
function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  needsRedraw = true;
}

function drawBackground(w, h) {
  ctx.fillStyle = getVar('--canvas-bg');
  ctx.fillRect(0, 0, w, h);
  // dotted grid in screen space, following the camera
  const base = 24;                             // world units between dots
  let step = base * cam.scale;
  while (step < 14) step *= 4;                  // keep dots from crowding
  while (step > 120) step /= 4;
  const ox = ((cam.x % step) + step) % step;
  const oy = ((cam.y % step) + step) % step;
  ctx.fillStyle = getVar('--dot');
  const r = Math.min(1.4, Math.max(0.7, cam.scale));
  for (let x = ox; x < w; x += step) {
    for (let y = oy; y < h; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.283185307);
      ctx.fill();
    }
  }
}

function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(w, h);

  // world-space transform for strokes
  ctx.setTransform(cam.scale * dpr, 0, 0, cam.scale * dpr, cam.x * dpr, cam.y * dpr);

  const n = E.qs_stroke_count();
  for (let id = 0; id < n; id++) {
    if (!E.qs_stroke_alive(id)) continue;
    const e = getCommittedPath(id);
    ctx.fillStyle = e.css;
    ctx.fill(e.path);
  }
  if (liveStroke) {
    ctx.fillStyle = liveStroke.css;
    ctx.fill(liveStroke.path);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function frame() {
  if (needsRedraw) { needsRedraw = false; render(); }
  requestAnimationFrame(frame);
}
function invalidate() { needsRedraw = true; }

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
}

// -------------------------------------------------------------------------
// pointer input
// -------------------------------------------------------------------------
function pressureOf(ev) {
  // Pen gives real pressure; mouse/touch report 0 or 0.5 -> use a sane default.
  if (ev.pointerType === 'pen' && ev.pressure > 0) return ev.pressure;
  if (ev.pressure && ev.pressure !== 0.5) return ev.pressure;
  return 0.5;
}

function beginStroke(ev) {
  drawing = true;
  activePointerId = ev.pointerId;
  E.qs_begin_stroke(hexToRGBA(color), width);
  liveStroke = { path: new Path2D(), css: rgbaToCss(hexToRGBA(color)) };
  addPoint(ev);
}

function addPoint(ev) {
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  const list = events.length ? events : [ev];
  const rect = canvas.getBoundingClientRect();
  for (const e of list) {
    const wpt = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    E.qs_add_point(wpt.x, wpt.y, pressureOf(e));
  }
  const ptr = E.qs_live_outline_ptr();
  const cnt = E.qs_live_outline_count();
  liveStroke = { path: outlineToPath(ptr, cnt), css: rgbaToCss(hexToRGBA(color)) };
  invalidate();
}

function endStroke() {
  if (!drawing) return;
  drawing = false;
  activePointerId = null;
  const id = E.qs_commit_stroke();
  liveStroke = null;
  if (id >= 0) getCommittedPath(id);     // warm the cache
  syncUndo();
  invalidate();
}

function eraseAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const wpt = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
  const rWorld = Math.max(6, width * 1.5) / cam.scale;
  const removed = E.qs_erase(wpt.x, wpt.y, rWorld);
  if (removed > 0) { syncUndo(); invalidate(); }
}

function isPanGesture(ev) {
  return tool === 'pan' || spaceHeld || ev.button === 1 ||
         (ev.pointerType === 'touch' && ev.button === -1 && ev.isPrimary === false);
}

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  hideHint();
  if (isPanGesture(ev)) {
    panning = true; lastPan = { x: ev.clientX, y: ev.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  if (tool === 'eraser') { drawing = true; activePointerId = ev.pointerId; eraseAt(ev); return; }
  beginStroke(ev);
});

canvas.addEventListener('pointermove', (ev) => {
  if (panning) {
    cam.x += ev.clientX - lastPan.x;
    cam.y += ev.clientY - lastPan.y;
    lastPan = { x: ev.clientX, y: ev.clientY };
    invalidate();
    return;
  }
  if (!drawing || ev.pointerId !== activePointerId) return;
  if (tool === 'eraser') eraseAt(ev);
  else addPoint(ev);
});

function stopPointer(ev) {
  if (panning) {
    panning = false; lastPan = null;
    canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    return;
  }
  if (tool === 'eraser') { drawing = false; activePointerId = null; return; }
  endStroke();
}
canvas.addEventListener('pointerup', stopPointer);
canvas.addEventListener('pointercancel', stopPointer);
canvas.addEventListener('lostpointercapture', () => { if (drawing) endStroke(); });

// wheel: zoom toward cursor (ctrl/pinch also zooms); shift+wheel pans x
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
  if (ev.ctrlKey || !ev.shiftKey) {
    const before = screenToWorld(cx, cy);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    cam.scale = Math.min(20, Math.max(0.05, cam.scale * factor));
    // keep the point under the cursor fixed
    cam.x = cx - before.x * cam.scale;
    cam.y = cy - before.y * cam.scale;
    updateZoomLabel();
  } else {
    cam.x -= ev.deltaX || ev.deltaY;
    cam.y -= ev.shiftKey ? 0 : ev.deltaY;
  }
  invalidate();
}, { passive: false });

// -------------------------------------------------------------------------
// UI wiring
// -------------------------------------------------------------------------
const PALETTE = ['#1b1d23', '#e5484d', '#f5a524', '#30a46c', '#4f6bed', '#8e4ec6', '#e93d82', '#ffffff'];

function buildSwatches() {
  const host = document.getElementById('swatches');
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
  document.getElementById('colorInput').value = c;
  document.querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', 'false'));
  if (btn) btn.setAttribute('aria-pressed', 'true');
  if (tool !== 'pen') selectTool('pen');
}
function selectTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  canvas.style.cursor = t === 'pan' ? 'grab' : (t === 'eraser' ? 'cell' : 'crosshair');
}
function updateZoomLabel() {
  document.getElementById('zoomVal').textContent = Math.round(cam.scale * 100) + '%';
}
function syncUndo() {
  document.getElementById('undoBtn').disabled = !E.qs_can_undo();
  document.getElementById('redoBtn').disabled = !E.qs_can_redo();
}

document.querySelectorAll('.tool').forEach(b =>
  b.addEventListener('click', () => selectTool(b.dataset.tool)));
document.getElementById('colorInput').addEventListener('input', (e) => setColor(e.target.value, null));
document.getElementById('widthInput').addEventListener('input', (e) => {
  width = parseInt(e.target.value, 10);
  document.getElementById('widthVal').textContent = width;
});
document.getElementById('undoBtn').addEventListener('click', () => { if (E.qs_undo()) { syncUndo(); invalidate(); } });
document.getElementById('redoBtn').addEventListener('click', () => { if (E.qs_redo()) { syncUndo(); invalidate(); } });
document.getElementById('clearBtn').addEventListener('click', () => {
  if (E.qs_clear() > 0) { syncUndo(); invalidate(); }
});
document.getElementById('zoomIn').addEventListener('click', () => zoomCenter(1.25));
document.getElementById('zoomOut').addEventListener('click', () => zoomCenter(0.8));
document.getElementById('zoomFit').addEventListener('click', () => {
  cam.x = 0; cam.y = 0; cam.scale = 1; updateZoomLabel(); invalidate();
});
function zoomCenter(f) {
  const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
  const before = screenToWorld(cx, cy);
  cam.scale = Math.min(20, Math.max(0.05, cam.scale * f));
  cam.x = cx - before.x * cam.scale;
  cam.y = cy - before.y * cam.scale;
  updateZoomLabel(); invalidate();
}

// save / open / png
document.getElementById('saveBtn').addEventListener('click', () => {
  const ptr = E.qs_save_ptr(), len = E.qs_save_len();
  const bytes = u8(ptr, len).slice();
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  downloadBlob(blob, 'drawing.qsketch');
});
document.getElementById('openBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  const dst = E.qs_alloc(buf.length);
  u8(dst, buf.length).set(buf);
  if (E.qs_load(dst, buf.length)) {
    pathCache.clear(); liveStroke = null; syncUndo(); invalidate();
  } else {
    alert('Not a valid .qsketch file.');
  }
  e.target.value = '';
});
document.getElementById('pngBtn').addEventListener('click', exportPNG);

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
    if (!ptr || cnt < 2) continue;
    const a = f32(ptr, cnt);
    for (let i = 0; i < cnt; i += 2) {
      if (a[i] < minx) minx = a[i]; if (a[i] > maxx) maxx = a[i];
      if (a[i + 1] < miny) miny = a[i + 1]; if (a[i + 1] > maxy) maxy = a[i + 1];
    }
    any = true;
  }
  if (!any) { alert('Nothing to export yet — draw something first.'); return; }
  const pad = 24, sc = 2;
  const w = Math.ceil((maxx - minx) + pad * 2), h = Math.ceil((maxy - miny) + pad * 2);
  const off = document.createElement('canvas');
  off.width = w * sc; off.height = h * sc;
  const c = off.getContext('2d');
  c.fillStyle = getVar('--canvas-bg'); c.fillRect(0, 0, off.width, off.height);
  c.setTransform(sc, 0, 0, sc, sc * (pad - minx), sc * (pad - miny));
  for (let id = 0; id < n; id++) {
    if (!E.qs_stroke_alive(id)) continue;
    const e = getCommittedPath(id);
    c.fillStyle = e.css; c.fill(e.path);
  }
  off.toBlob(b => downloadBlob(b, 'qsketch.png'), 'image/png');
}

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { spaceHeld = true; if (!drawing) canvas.style.cursor = 'grab'; return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { if (E.qs_redo()) { syncUndo(); invalidate(); } }
    else { if (E.qs_undo()) { syncUndo(); invalidate(); } }
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); if (E.qs_redo()) { syncUndo(); invalidate(); } return; }
  if (mod) return;
  switch (e.key.toLowerCase()) {
    case 'p': selectTool('pen'); break;
    case 'e': selectTool('eraser'); break;
    case 'h': selectTool('pan'); break;
    case '+': case '=': zoomCenter(1.25); break;
    case '-': zoomCenter(0.8); break;
    case '0': cam.x = 0; cam.y = 0; cam.scale = 1; updateZoomLabel(); invalidate(); break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceHeld = false; if (!drawing && !panning) canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair'; }
});
window.addEventListener('resize', resize);

let hintTimer = null;
function hideHint() {
  const h = document.getElementById('hint');
  if (h && !h.classList.contains('gone')) h.classList.add('gone');
  clearTimeout(hintTimer);
}

// -------------------------------------------------------------------------
// boot the wasm engine
// -------------------------------------------------------------------------
async function boot() {
  const resp = await fetch(WASM_URL);
  const bytes = await resp.arrayBuffer();
  const module = await WebAssembly.compile(bytes);
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
  window.QSketch = E;   // exposed for automation / debugging (read-only engine)

  buildSwatches();
  selectTool('pen');
  resize();
  updateZoomLabel();
  syncUndo();
  document.getElementById('loading').classList.add('hidden');
  requestAnimationFrame(frame);
  hintTimer = setTimeout(hideHint, 7000);
}

boot().catch(err => {
  console.error(err);
  const l = document.getElementById('loading');
  l.innerHTML = '<p style="color:#e5484d">Failed to load the WASM engine.<br>' +
                'Serve this folder over HTTP (not file://) and reload.</p>';
});
