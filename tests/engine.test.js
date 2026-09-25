// Engine regression tests: node tests/engine.test.js (after tools/build.sh).
// Covers stroke geometry (tip sweeps, caps, joins, calligraphy nib),
// StreamLine/smoothing, pressure min-size, deferred tessellation and
// .qsketch save/load (QSK3 round-trip, corrupt input, legacy QSK1/QSK2).
'use strict';
const fs = require('fs');
const path = require('path');

const WASM = fs.readFileSync(path.join(__dirname, '..', 'web', 'qsketch.wasm'));
function boot() {
  const e = new WebAssembly.Instance(new WebAssembly.Module(WASM), { env: {} }).exports;
  e.qs_init();
  return e;
}

const ROUND = 0, NIB = 1;
const NIB45 = [Math.SQRT1_2, -Math.SQRT1_2];   // edge rising to the right (y down)

// begin a stroke with defaults for the new tip parameters
function begin(e, color, width, minRatio, smoothing, streamline, kind = ROUND, nib = NIB45, nibRatio = 0.15, rope = 0) {
  e.qs_begin_stroke(color >>> 0, width, minRatio, smoothing, streamline, kind, nib[0], nib[1], nibRatio, rope);
}
function draw(e, pts, opts = {}) {
  const { width = 4, minRatio = 1, smoothing = 0, streamline = 0, kind = ROUND, nib, nibRatio, color = 0xff, rope = 0 } = opts;
  begin(e, color, width, minRatio, smoothing, streamline, kind, nib, nibRatio, rope);
  pts.forEach(([x, y, p = 1], i) => e.qs_add_point(x, y, p, i * 8));
  return e.qs_commit_stroke();
}

// Decode [n, x0, y0, ...]* into polygons.
function polys(e, id) {
  const cnt = e.qs_stroke_outline_count(id);
  if (!cnt) return [];
  const a = new Float32Array(e.memory.buffer, e.qs_stroke_outline_ptr(id), cnt);
  const out = [];
  for (let i = 0; i < a.length;) {
    const n = a[i++];
    const poly = [];
    for (let k = 0; k < n; k++, i += 2) poly.push([a[i], a[i + 1]]);
    out.push(poly);
  }
  return out;
}
const allPts = (ps) => ps.flat();
function bounds(ps) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const [x, y] of allPts(ps)) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  return { minx, miny, maxx, maxy };
}
// Nonzero winding over all polygons, exactly how Canvas2D fills the Path2D.
function filled(ps, px, py) {
  let w = 0;
  for (const poly of ps) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const side = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
      if (y1 <= py) { if (y2 > py && side > 0) w++; }
      else if (y2 <= py && side < 0) w--;
    }
  }
  return w !== 0;
}
const area = (poly) => poly.reduce((s, [x1, y1], i) => {
  const [x2, y2] = poly[(i + 1) % poly.length];
  return s + x1 * y2 - x2 * y1;
}, 0) / 2;
function distToPolyline(line, px, py) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

let ok = true;
function check(name, cond, info = '') {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (info ? '  (' + info + ')' : ''));
  ok = ok && !!cond;
}

// ---------------------------------------------------------------- geometry

{ // round caps are filled out to the full radius, no bite at the tips
  const e = boot();
  const id = draw(e, Array.from({ length: 21 }, (_, i) => [i * 5, 0]), { width: 20 });
  const ps = polys(e, id);
  const probes = [[-6, 0], [2, 6], [106, 0], [98, -6], [50, 0], [-9.5, 0], [109.5, 0]];
  check('round tips fully filled (no bite)', probes.every(([x, y]) => filled(ps, x, y)));
  check('nothing outside the round tips', !filled(ps, -10.6, 0) && !filled(ps, 110.6, 0) && !filled(ps, 50, 10.6));
  check('a stroke is one closed outline (no internal seams)', ps.length === 1 && Math.abs(area(ps[0])) > 100, `${ps.length} contour, ${ps[0].length} points`);
}

{ // a sharp hairpin at full width: filled exactly where the tip passed
  const e = boot();
  const line = [];
  for (let i = 0; i <= 10; i++) line.push([i * 10, i * 6]);        // down-right
  for (let i = 1; i <= 10; i++) line.push([100 - i * 10, 60 - i * 1.5]); // sharp turn back
  const r = 12;
  const id = draw(e, line, { width: r * 2 });
  const ps = polys(e, id);
  let holes = 0, spill = 0, n = 0;
  for (let x = -20; x <= 120; x += 1.7) for (let y = -20; y <= 80; y += 1.7) {
    const d = distToPolyline(line, x, y), f = filled(ps, x, y);
    if (d < r - 1.2 && !f) holes++;
    if (d > r + 1.2 && f) spill++;
    n++;
  }
  check('sharp turn: no holes inside the swept tip', holes === 0, `${holes} holes / ${n} probes`);
  check('sharp turn: no ink outside the swept tip', spill === 0, `${spill} stray`);
}

{ // a looped stroke that crosses itself: overlap is ink, the loop's middle is not
  const e = boot();
  const line = [];
  for (let i = 0; i <= 72; i++) { const a = i / 72 * Math.PI * 2.3; line.push([Math.cos(a) * 40, Math.sin(a) * 40]); }
  const r = 6;
  const ps = polys(e, draw(e, line, { width: r * 2 }));
  let holes = 0, spill = 0;
  for (let x = -60; x <= 60; x += 1.3) for (let y = -60; y <= 60; y += 1.3) {
    const d = distToPolyline(line, x, y), f = filled(ps, x, y);
    if (d < r - 1.2 && !f) holes++;
    if (d > r + 1.2 && f) spill++;
  }
  check('self-crossing loop: overlap solid, middle empty', holes === 0 && spill === 0 && !filled(ps, 0, 0),
        `${holes} holes, ${spill} stray, centre ${filled(ps, 0, 0) ? 'inked' : 'empty'}`);
}

{ // calligraphy: width comes from travel direction relative to the nib
  const e = boot();
  const W = 20;
  const along = draw(e, Array.from({ length: 11 }, (_, i) => [i * 10, -i * 10]), { width: W, kind: NIB });   // up-right, along the edge
  const across = draw(e, Array.from({ length: 11 }, (_, i) => [i * 10, i * 10]), { width: W, kind: NIB });   // down-right, across it
  // thickness measured perpendicular to each stroke's own direction
  const thick = (id, dir) => {
    const [dx, dy] = dir, nx = -dy, ny = dx, pts = allPts(polys(e, id));
    const proj = pts.map(([x, y]) => x * nx + y * ny);
    return Math.max(...proj) - Math.min(...proj);
  };
  const tAlong = thick(along, [Math.SQRT1_2, -Math.SQRT1_2]);
  const tAcross = thick(across, [Math.SQRT1_2, Math.SQRT1_2]);
  check('nib: hairline when moving along the edge', tAlong < W * 0.2, `${tAlong.toFixed(2)} for width ${W}`);
  check('nib: full width when moving across the edge', Math.abs(tAcross - W) < 0.6, `${tAcross.toFixed(2)}`);
  check('nib stroke is one closed outline', polys(e, across).length === 1 && polys(e, along).length === 1);
  // the ink is continuous: centre line of the thin stroke is inked end to end
  const psA = polys(e, along);
  check('nib hairline has no gaps', Array.from({ length: 50 }, (_, i) => i * 2).every(k => filled(psA, k, -k)));
}

// ------------------------------------------------------ stabilisation

// jittery zig-zag input along y=100 at 240Hz, x 0..300 (round, width 4)
function jitter(streamline, smoothing) {
  const e = boot();
  begin(e, 0xff, 4, 0.2, smoothing, streamline);
  let t = 0;
  for (let i = 0; i <= 300; i += 2) { e.qs_add_point(i, 100 + ((i / 2) % 2 ? 6 : -6), 0.6, t); t += 4.17; }
  const id = e.qs_commit_stroke();
  // wobble band in the middle of the stroke (ends are pinned on purpose)
  let miny = 1e9, maxy = -1e9, maxx = -1e9;
  for (const [x, y] of allPts(polys(e, id))) {
    maxx = Math.max(maxx, x);
    if (x < 60 || x > 240) continue;
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  return { h: maxy - miny, maxx };
}
const raw = jitter(0, 0), sm = jitter(0, 0.8), sl = jitter(0.3, 0), both = jitter(0.3, 0.8);   // 0.3 = the old 0.6
console.log('mid-stroke band height  raw:', raw.h.toFixed(2), ' smoothing:', sm.h.toFixed(2),
            ' streamline:', sl.h.toFixed(2), ' both:', both.h.toFixed(2));
check('smoothing reduces jitter', sm.h < raw.h * 0.7);
check('streamline reduces jitter', sl.h < raw.h * 0.7);
check('combined is as clean as either alone', both.h <= Math.min(sm.h, sl.h) + 0.5 && both.h < raw.h * 0.3);
check('streamline catches up to pen-lift (x=300 + radius)', both.maxx > 301, 'maxx=' + both.maxx.toFixed(2));

// rate independence: same path at 60Hz vs 240Hz should end up similarly smooth
function rate(hz) {
  const e = boot();
  begin(e, 0xff, 4, 0.2, 0, 0.3);
  let t = 0; const dt = 1000 / hz;
  for (let k = 0; k <= hz / 2; k++) { e.qs_add_point(k * (600 / hz), 100 + ((k % 2) ? 6 : -6), 0.6, t); t += dt; }
  const b = bounds(polys(e, e.qs_commit_stroke()));
  return b.maxy - b.miny;
}
const r60 = rate(60), r240 = rate(240);
check('streamline is time-based (60Hz vs 240Hz similar)', Math.abs(r60 - r240) < 4,
      `60Hz h=${r60.toFixed(2)} 240Hz h=${r240.toFixed(2)}`);

// min size: zero-pressure stroke thinner with minRatio 0.1 than 0.9
function width(minR) {
  const e = boot();
  const id = draw(e, Array.from({ length: 51 }, (_, i) => [i * 4, 0, 0]), { width: 20, minRatio: minR });
  // measure mid-stroke only; the round end caps are wider than the body
  const ys = allPts(polys(e, id)).filter(([x]) => x > 40 && x < 160).map(([, y]) => y);
  return Math.max(...ys) - Math.min(...ys);
}
const w1 = width(0.1), w9 = width(0.9);
check('min size controls zero-pressure width', w1 < w9 * 0.3, `min10%=${w1.toFixed(2)} min90%=${w9.toFixed(2)}`);

// ------------------------------------------------------ slow, careful writing
// A 300-unit line with +-3 tremor at 240 Hz, drawn at a normal pace or at a
// slow calligraphy pace. Returns the wobble left in the middle third.
function tremor(pace, { smoothing = 0, streamline = 0, rope = 0, kind = ROUND, width = 4 } = {}) {
  const e = boot();
  begin(e, 0xff, width, 1, smoothing, streamline, kind, NIB45, 0.15, rope);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const n = Math.round(300 / pace * 240);
  for (let i = 0; i <= n; i++) e.qs_add_point(i / n * 300, 100 + rnd() * 6, 1, i * 1000 / 240);
  const ps = polys(e, e.qs_commit_stroke());
  const mid = allPts(ps).filter(([x]) => x > 100 && x < 200).map(([, y]) => y);
  // perimeter of the whole outline vs a clean stroke: how ragged the edges are
  let per = 0;
  for (const poly of ps) for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; per += Math.hypot(x2 - x1, y2 - y1);
  }
  return { wobble: Math.max(...mid) - Math.min(...mid) - width, ragged: per / (2 * 300) };
}
{
  const slow = 40;                                   // units per second
  const none = tremor(slow), s1 = tremor(slow, { smoothing: 1 }), s3 = tremor(slow, { smoothing: 3 });
  check('smoothing goes 3x further than before', s3.wobble < s1.wobble * 0.6,
        `slow line wobble: off ${none.wobble.toFixed(2)}, old max ${s1.wobble.toFixed(2)}, new max ${s3.wobble.toFixed(2)}`);
  const t5 = tremor(slow, { streamline: 0.5 }), t10 = tremor(slow, { streamline: 1 });
  check('StreamLine has headroom past the old maximum', t10.wobble < t5.wobble * 0.7,
        `old max (50%) ${t5.wobble.toFixed(2)}, new max ${t10.wobble.toFixed(2)}`);
}
// A real hand: a 9 Hz physiological tremor plus slower drift (not white noise,
// which every filter removes easily). Calligraphy nib, width 14, slow pace.
function hand(pace, { smoothing = 0, streamline = 0, rope = 0, amp = 1.5 } = {}) {
  const e = boot();
  begin(e, 0xff, 14, 1, smoothing, streamline, NIB, NIB45, 0.15, rope);
  const n = Math.round(300 / pace * 240);
  for (let i = 0; i <= n; i++) {
    const t = i / 240;
    const y = 100 + amp * (Math.sin(2 * Math.PI * 9 * t) + 0.6 * Math.sin(2 * Math.PI * 4.3 * t + 1) + 0.4 * Math.sin(2 * Math.PI * 11.7 * t + 2));
    e.qs_add_point(i / n * 300, y, 1, t * 1000);
  }
  const [poly] = polys(e, e.qs_commit_stroke());
  let per = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; per += Math.hypot(x2 - x1, y2 - y1); }
  const mid = poly.filter(([x]) => x > 100 && x < 200).map(([, y]) => y);
  return { edge: per, band: Math.max(...mid) - Math.min(...mid) };
}
{
  const clean = hand(40, { amp: 0 });
  const rel = (r) => ({ edge: r.edge / clean.edge, jitter: r.band - clean.band });
  const oldDefaults = rel(hand(40, { smoothing: 0.4, streamline: 0.175 }));
  const newDefaults = rel(hand(40, { smoothing: 0.3, streamline: 0.2, rope: 24 }));
  check('calligraphy at a slow pace: old defaults were ragged', oldDefaults.edge > 1.5,
        `edges ${oldDefaults.edge.toFixed(2)}x a clean stroke, thickness jitter ${oldDefaults.jitter.toFixed(2)}`);
  check('calligraphy at a slow pace: new defaults are clean', newDefaults.edge < 1.02 && newDefaults.jitter < 0.3,
        `edges ${newDefaults.edge.toFixed(2)}x, thickness jitter ${newDefaults.jitter.toFixed(2)}`);
  const quick = rel(hand(250, { smoothing: 0.3, streamline: 0.2, rope: 24 }));
  check('calligraphy at a brisk pace: new defaults stay steady', quick.edge < 1.02 && quick.jitter < 1,
        `edges ${quick.edge.toFixed(2)}x, thickness jitter ${quick.jitter.toFixed(2)}`);
}
{ // holding the pen still with a shaky hand: the ink does not move at all
  const e = boot();
  begin(e, 0xff, 14, 1, 0, 0, NIB, NIB45, 0.15, 24);
  let drift = 0;
  for (let i = 0; i <= 240; i++) {                         // one second of ±3 tremor
    const t = i / 240;
    e.qs_add_point(50 + 3 * Math.sin(2 * Math.PI * 9 * t), 53 - 3 + 3 * Math.cos(2 * Math.PI * 7 * t), 1, t * 1000);
    drift = Math.max(drift, Math.hypot(e.qs_live_tip_x() - 50, e.qs_live_tip_y() - 53));
  }
  check('stabilizer: a trembling pen held still does not move the ink', drift < 1e-4, `ink moved ${drift.toFixed(4)}`);
}
{ // the ink trails the pen by the string length, then lands on the lift point
  const e = boot();
  begin(e, 0xff, 4, 1, 0, 0, ROUND, NIB45, 0.15, 20);
  for (let i = 0; i <= 50; i++) e.qs_add_point(i * 2, 0, 1, i * 8);
  const lag = 100 - e.qs_live_tip_x();
  const b = bounds(polys(e, e.qs_commit_stroke()));
  check('stabilizer: ink trails the pen by the string length', Math.abs(lag - 20) < 0.01, `lag ${lag.toFixed(2)}`);
  check('stabilizer: stroke still ends where the pen lifts', Math.abs(b.maxx - 102) < 0.2, `ends at x=${(b.maxx - 2).toFixed(2)}`);
}
{ // a short dab (a rhombic dot) shorter than the string still leaves its mark
  const e = boot();
  begin(e, 0xff, 14, 1, 0, 0, NIB, NIB45, 0.15, 20);
  for (let i = 0; i <= 10; i++) e.qs_add_point(i * 1.2, i * 1.2, 1, i * 8);      // 17 units down-right
  const b = bounds(polys(e, e.qs_commit_stroke()));
  check('stabilizer: a dab shorter than the string still draws', b.maxx - b.minx > 20 && b.maxy - b.miny > 20,
        `${(b.maxx - b.minx).toFixed(1)} x ${(b.maxy - b.miny).toFixed(1)}`);
}
{ // a rhombic dot: one nib-width dab straight across a 45° nib is an exact rhombus
  const e = boot();
  const id = draw(e, Array.from({ length: 11 }, (_, i) => [i * 1.7, i * 1.7]), { width: 24, kind: NIB });
  const [poly] = polys(e, id);
  let corners = 0;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[(k - 1 + poly.length) % poly.length], [bx, by] = poly[k], [cx, cy] = poly[(k + 1) % poly.length];
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu > 1e-6 && lv > 1e-6 && Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) > 20 * Math.PI / 180) corners++;
  }
  check('rhombic dot: clean rhombus outline (no zig-zag from tied nib corners)', corners === 4,
        `${corners} corners, ${poly.length} outline points`);
}
{ // callers that leave the string length out must not freeze the ink
  const e = boot();
  e.qs_begin_stroke(0xff, 4, 1, 0, 0, 0, 1, 0, 0.15);           // no 10th argument -> NaN
  for (let i = 0; i <= 10; i++) e.qs_add_point(i * 10, 0, 1, i * 8);
  const b = bounds(polys(e, e.qs_commit_stroke()));
  check('missing string length means "off", not frozen ink', b.maxx - b.minx > 100);
}

// ------------------------------------------------------ live stroke API
{
  const e = boot();
  begin(e, 0xff, 4, 0.3, 0.3, 0.3);
  for (let i = 0; i < 20; i++) e.qs_add_point(i * 5, 0, 0.5, i * 8);
  check("add_point doesn't tessellate", e.qs_live_outline_count() === 0);
  e.qs_live_update(); check('live_update tessellates', e.qs_live_outline_count() > 0);
  e.qs_cancel_stroke(); check('cancel clears live outline', e.qs_live_outline_count() === 0);
  check('cancelled stroke not committed', e.qs_commit_stroke() === -1 && e.qs_stroke_count() === 0);
}

// ------------------------------------------------------ save / load
function saveBytes(e) {
  const sp = e.qs_save_ptr(), n = e.qs_save_len();
  return new Uint8Array(e.memory.buffer, sp, n).slice();
}
function load(e, bytes) {
  const p = e.qs_alloc(bytes.length);
  new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
  return e.qs_load(p, bytes.length);
}
const outline = (e, id) => Array.from(new Float32Array(e.memory.buffer, e.qs_stroke_outline_ptr(id), e.qs_stroke_outline_count(id)));
{
  const e = boot();
  begin(e, 0x336699ff, 8, 0.15, 0.7, 0.4);
  for (let i = 0; i < 40; i++) e.qs_add_point(i * 7, Math.sin(i / 4) * 30, i / 40, i * 6);
  e.qs_commit_stroke();
  const ang = 30 * Math.PI / 180;
  begin(e, 0xaa3300ff, 16, 0.4, 0.3, 0.2, NIB, [Math.cos(ang), -Math.sin(ang)], 0.2);
  for (let i = 0; i < 30; i++) e.qs_add_point(i * 5, Math.cos(i / 5) * 40 + 80, 0.3 + i / 60, i * 6);
  e.qs_commit_stroke();
  const before = [outline(e, 0), outline(e, 1)];
  const bytes = saveBytes(e);
  check('save header QSK3', String.fromCharCode(...bytes.slice(0, 4)) === 'QSK3');

  const e2 = boot();
  check('load QSK3', load(e2, bytes) === 1 && e2.qs_stroke_count() === 2);
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
  check('round stroke reloads identically', same(before[0], outline(e2, 0)));
  check('calligraphy stroke reloads identically (tip kept)', same(before[1], outline(e2, 1)));
  check('fresh file has no undo history', e2.qs_can_undo() === 0);

  const trunc = bytes.slice(0, bytes.length - 10);
  check('truncated file rejected', load(e2, trunc) === 0);
  check('drawing survives bad load', e2.qs_stroke_count() === 2 && e2.qs_stroke_alive(0) === 1);
}
{ // legacy QSK1: header + color/width/n + samples
  const dv = new DataView(new ArrayBuffer(4 + 4 + 12 + 12 * 3));
  [0x51, 0x53, 0x4b, 0x31].forEach((b, i) => dv.setUint8(i, b));    // "QSK1"
  dv.setUint32(4, 1, true); dv.setUint32(8, 0xff0000ff, true); dv.setFloat32(12, 5, true); dv.setUint32(16, 3, true);
  [[0, 0, .5], [20, 0, .5], [40, 5, .5]].forEach((v, i) => v.forEach((f, j) => dv.setFloat32(20 + i * 12 + j * 4, f, true)));
  const e = boot();
  check('legacy QSK1 loads', load(e, new Uint8Array(dv.buffer)) === 1 && e.qs_stroke_count() === 1 && e.qs_stroke_outline_count(0) > 0);
}
{ // legacy QSK2: adds minRatio + smoothing
  const dv = new DataView(new ArrayBuffer(4 + 4 + 20 + 12 * 2));
  [0x51, 0x53, 0x4b, 0x32].forEach((b, i) => dv.setUint8(i, b));    // "QSK2"
  dv.setUint32(4, 1, true); dv.setUint32(8, 0x00ff00ff, true); dv.setFloat32(12, 6, true);
  dv.setFloat32(16, 0.3, true); dv.setFloat32(20, 0.2, true); dv.setUint32(24, 2, true);
  [[0, 0, .5], [30, 10, .8]].forEach((v, i) => v.forEach((f, j) => dv.setFloat32(28 + i * 12 + j * 4, f, true)));
  const e = boot();
  check('legacy QSK2 loads', load(e, new Uint8Array(dv.buffer)) === 1 && e.qs_stroke_count() === 1 && e.qs_stroke_outline_count(0) > 0);
}

console.log(ok ? '\nALL ENGINE TESTS PASS' : '\nSOME TESTS FAILED');
process.exit(ok ? 0 : 1);
