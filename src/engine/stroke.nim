## Stroke model: turns raw pressure-tagged input samples into filled vector
## geometry. All heavy geometry lives here so it runs as compiled wasm.
##
## Rendering is a true sweep of the pen tip along the smoothed path, emitted
## as ONE closed outline per stroke (the way vector stroker libraries do it):
## the left edge forward, around the end cap, the right edge back, around the
## start cap. On the outside of a turn the outline follows the tip's own
## shape; on the inside it routes through the turn's centre, which keeps the
## nonzero fill solid there. One contour means no internal edges, so there is
## nothing for the browser's anti-aliasing to leave seams on, translucent ink
## stays even where a stroke crosses itself, and it is cheap to redraw.
##
## The tip is a convex polygon, scaled per sample by pressure:
##
## * round -- a 64-gon disc whose radius follows pressure (ballpoint, fountain
##   pen and marker differ only in size / pressure response / opacity)
## * nib   -- a flat, angled calligraphy nib (a thin rectangle): thick or thin
##   depending on the direction of travel relative to the nib
##
## Input goes through two Procreate-style stabilisers:
##
## * StreamLine -- a time-based exponential "pull" on the pen position. It is
##   driven by event timestamps rather than per-sample, so a 240 Hz S Pen and
##   a 60 Hz mouse feel identical. When the pen lifts, the filtered point is
##   eased onto the lift position so strokes end where the pen did.
## * Smoothing -- a non-destructive moving average over the (already
##   stabilised) samples, applied at tessellation time, endpoints pinned.

import std/math
import geometry

type
  InputSample* = object
    pos*: Vec2
    pressure*: float32

  BrushKind* = enum
    bkRound = 0   ## disc tip
    bkNib = 1     ## flat broad-edge nib

  Stroke* = object
    ## Stabilised samples in world space (kept for re-tessellation / save).
    raw*: seq[InputSample]
    ## Fill geometry as a list of polygons, each encoded as
    ## [n, x0, y0, ..., x(n-1), y(n-1)]. Filled together with the nonzero rule.
    outline*: seq[float32]
    ## Sampled centerline for cheap hit testing (eraser / selection).
    centerline*: seq[Vec2]
    color*: uint32          ## 0xRRGGBBAA
    baseWidth*: float32     ## nominal (max) diameter in world units
    minRatio*: float32      ## width at zero pressure, relative to baseWidth
    smoothing*: float32     ## 0..1 moving-average strength
    kind*: BrushKind
    nibDir*: Vec2           ## unit vector along the nib edge (bkNib)
    nibRatio*: float32      ## nib thickness relative to baseWidth (bkNib)
    bbox*: Aabb
    alive*: bool
    # --- capture-only state (not serialized) ---
    tau: float32            ## StreamLine time constant in ms (0 = off)
    filt: Vec2              ## current stabilised position
    filtPr: float32         ## current stabilised pressure
    lastT: float32          ## timestamp of the previous input, ms
    target: Vec2            ## most recent unfiltered pen position
    targetPr: float32
    started: bool

const
  DefaultMinRatio* = 0.35'f32
  DefaultNibRatio* = 0.15'f32
  CircleSegs = 64               ## resolution of the unit-circle table
  # cos/sin of 2*PI/CircleSegs, so the table is built without libm.
  StepCos = 0.99518472667219688
  StepSin = 0.09801714032956060
  MaxSmoothRadius = 10          ## samples each side at smoothing = 1
  CatchUpStepMs = 8.0'f32       ## simulated frame length when easing to pen-lift
  CatchUpMaxSteps = 90

## exp(-x) for x >= 0 without libm: (1 - x/256)^256 via 8 squarings.
## Relative error is well under 1% for the x < 6 range StreamLine uses.
func expNeg(x: float32): float32 =
  if x <= 0'f32: return 1'f32
  if x >= 16'f32: return 0'f32
  var y = 1'f32 - x / 256'f32
  if y <= 0'f32: return 0'f32
  for _ in 0 ..< 8: y = y * y
  y

## `streamline` in 0..1 maps to a time constant: 0 = off, 1 = heavy lag.
func streamlineTau*(streamline: float32): float32 =
  let s = clamp(streamline, 0'f32, 1'f32)
  if s <= 0.001'f32: 0'f32 else: 8'f32 + 140'f32 * s * s

func newStroke*(color: uint32, baseWidth: float32,
                minRatio = DefaultMinRatio, smoothing = 0'f32,
                streamline = 0'f32, kind = bkRound,
                nibDir = vec2(0.70710678'f32, -0.70710678'f32),
                nibRatio = DefaultNibRatio): Stroke =
  var dir = nibDir.normalized
  if dir.lenSq < 0.5'f32: dir = vec2(0.70710678'f32, -0.70710678'f32)
  Stroke(color: color, baseWidth: baseWidth, alive: true, bbox: emptyAabb(),
         minRatio: clamp(minRatio, 0'f32, 1'f32),
         smoothing: clamp(smoothing, 0'f32, 1'f32),
         kind: kind, nibDir: dir,
         nibRatio: clamp(nibRatio, 0.02'f32, 1'f32),
         tau: streamlineTau(streamline))

## Append a sample, lightly de-noised: drop samples that land almost on top
## of the previous one so the smoothing spline stays well conditioned.
proc addSample*(s: var Stroke, p: Vec2, pressure: float32) =
  let pr = clamp(pressure, 0.0'f32, 1.0'f32)
  if s.raw.len > 0:
    let d = (p - s.raw[^1].pos).lenSq
    if d < 0.25'f32:  # < 0.5 units in world space
      # keep the freshest pressure but don't add a redundant vertex
      s.raw[^1].pressure = (s.raw[^1].pressure + pr) * 0.5'f32
      return
  s.raw.add InputSample(pos: p, pressure: pr)

proc stepFilter(s: var Stroke, dt: float32) {.inline.} =
  let a = 1'f32 - expNeg(dt / s.tau)
  s.filt = lerp(s.filt, s.target, a)
  s.filtPr = s.filtPr + (s.targetPr - s.filtPr) * a

## Feed one pen sample (world coords, pressure 0..1, timestamp in ms)
## through StreamLine and into the stroke.
proc capture*(s: var Stroke, p: Vec2, pressure: float32, t: float32) =
  let pr = clamp(pressure, 0'f32, 1'f32)
  s.target = p
  s.targetPr = pr
  if not s.started or s.tau <= 0'f32:
    s.started = true
    s.filt = p
    s.filtPr = pr
    s.lastT = t
    s.addSample(p, pr)
    return
  var dt = t - s.lastT
  if dt < 0'f32: dt = 0'f32
  if dt > 100'f32: dt = 100'f32       # tab switch / dropped events
  s.lastT = t
  s.stepFilter(dt)
  s.addSample(s.filt, s.filtPr)

## Pen lifted: ease the stabilised point onto the lift position, as if the
## pen had kept still for a few frames, so the stroke ends under the nib.
proc finishCapture*(s: var Stroke) =
  if not s.started or s.tau <= 0'f32: return
  var i = 0
  while i < CatchUpMaxSteps and (s.target - s.filt).lenSq > 0.0625'f32:
    s.stepFilter(CatchUpStepMs)
    s.addSample(s.filt, s.filtPr)
    inc i
  s.addSample(s.target, s.filtPr)

## Moving average (triangular weights) with a window that shrinks towards
## the ends so the first and last samples stay exactly where they were.
func smoothRadius(amount: float32): int {.inline.} =
  int(amount * float32(MaxSmoothRadius) + 0.5'f32)

proc smoothed(raw: seq[InputSample], amount: float32): seq[InputSample] =
  let n = raw.len
  let r = smoothRadius(amount)
  if r <= 0 or n < 3: return raw
  result = newSeq[InputSample](n)
  for i in 0 ..< n:
    let k = min(r, min(i, n - 1 - i))
    if k == 0:
      result[i] = raw[i]
      continue
    var sx, sy, sp, sw: float32
    for j in -k .. k:
      let w = float32(k + 1 - abs(j))
      let q = raw[i + j]
      sx += q.pos.x * w
      sy += q.pos.y * w
      sp += q.pressure * w
      sw += w
    result[i] = InputSample(pos: vec2(sx / sw, sy / sw), pressure: sp / sw)

## Catmull-Rom interpolation of position and pressure, producing a dense,
## smooth centerline. This is what gives strokes their fluid feel.
proc resample(raw: seq[InputSample]): tuple[pts: seq[Vec2], pr: seq[float32]] =
  var pts: seq[Vec2]
  var pr: seq[float32]
  let n = raw.len
  if n == 0: return (pts, pr)
  if n == 1:
    pts.add raw[0].pos; pr.add raw[0].pressure
    return (pts, pr)
  if n == 2:
    pts.add raw[0].pos; pr.add raw[0].pressure
    pts.add raw[1].pos; pr.add raw[1].pressure
    return (pts, pr)

  template samp(i: int): InputSample =
    raw[clamp(i, 0, n - 1)]

  for i in 0 ..< n - 1:
    let p0 = samp(i - 1).pos
    let p1 = samp(i).pos
    let p2 = samp(i + 1).pos
    let p3 = samp(i + 2).pos
    let r1 = samp(i).pressure
    let r2 = samp(i + 1).pressure
    # subdivision density scales with segment length for even spacing
    let segLen = (p2 - p1).len
    var steps = int(segLen / 3.0'f32) + 1
    if steps < 1: steps = 1
    if steps > 24: steps = 24
    for k in 0 ..< steps:
      let t = float32(k) / float32(steps)
      let t2 = t * t
      let t3 = t2 * t
      # Catmull-Rom basis
      let a = (p1 * 2.0'f32) +
              ((p2 - p0) * t) +
              ((p0 * 2.0'f32 - p1 * 5.0'f32 + p2 * 4.0'f32 - p3) * t2) +
              ((p1 * 3.0'f32 - p0 - p2 * 3.0'f32 + p3) * t3)
      pts.add(a * 0.5'f32)
      pr.add(r1 + (r2 - r1) * t)
  pts.add raw[^1].pos
  pr.add raw[^1].pressure
  (pts, pr)

proc widthAt(s: Stroke, pressure: float32): float32 {.inline.} =
  ## Half-width (disc radius, or half nib length) for a pressure 0..1.
  let r = s.minRatio + (1.0'f32 - s.minRatio) * pressure
  max(0.5'f32 * s.baseWidth * r, 0.3'f32)

# --------------------------------------------------------------------------
# The tip: a convex polygon with vertices in counter-clockwise order (y-up
# sense), scaled per sample. Its edge directions do not depend on the scale,
# so which vertex faces a given direction ("support vertex") is the same
# whatever the pressure.
# --------------------------------------------------------------------------

var unitCircle: array[CircleSegs, Vec2]
var unitCircleReady = false

proc ensureCircle() =
  if unitCircleReady: return
  var c = 1.0
  var sn = 0.0
  for k in 0 ..< CircleSegs:
    unitCircle[k] = vec2(float32(c), float32(sn))
    let nc = c * StepCos - sn * StepSin
    sn = c * StepSin + sn * StepCos
    c = nc
  unitCircleReady = true

func tipCount(s: Stroke): int {.inline.} =
  if s.kind == bkNib: 4 else: CircleSegs

func nibThickness(s: Stroke): float32 {.inline.} =
  max(0.5'f32 * s.baseWidth * s.nibRatio, 0.35'f32)

## Vertex k of the tip at half-size h, relative to the tip centre.
proc tipVertex(s: Stroke, k: int, h: float32): Vec2 {.inline.} =
  if s.kind == bkRound: return unitCircle[k] * h
  let u = s.nibDir
  let v = perp(u)
  let t = s.nibThickness
  case k
  of 0: u * h - v * t
  of 1: u * h + v * t
  of 2: v * t - u * h
  else: (u * h + v * t) * -1'f32

## Index of the tip vertex furthest in direction n.
proc support(s: Stroke, n: Vec2): int =
  if s.kind == bkNib:
    let su = dot(s.nibDir, n) >= 0'f32
    let sv = dot(perp(s.nibDir), n) >= 0'f32
    return (if su: (if sv: 1 else: 0) else: (if sv: 2 else: 3))
  var best = 0
  var bestDot = -2'f32
  for k in 0 ..< CircleSegs:
    let d = dot(unitCircle[k], n)
    if d > bestDot: bestDot = d; best = k
  best

proc addPt(o: var seq[Vec2], p: Vec2) {.inline.} =
  if o.len == 0 or (p - o[^1]).lenSq > 1e-8'f32: o.add p

## Walk tip vertices from index `a` to `b` (exclusive of `a`, inclusive of
## `b`) stepping by `dir` (+1 / -1), appending them around centre `c`.
proc walk(s: Stroke, o: var seq[Vec2], c: Vec2, h: float32, a, b, dir: int) =
  let K = s.tipCount
  var k = a
  var guard = 0
  while k != b and guard < K:
    k = (k + dir + K) mod K
    o.addPt c + s.tipVertex(k, h)
    inc guard

## The whole stroke as one closed contour.
proc sweep(s: var Stroke, pts0: seq[Vec2], prs0: seq[float32]) =
  ensureCircle()
  # drop repeated positions (keep the fattest), they carry no direction
  var pts: seq[Vec2]
  var h: seq[float32]
  for i in 0 ..< pts0.len:
    let w = s.widthAt(prs0[i])
    if pts.len > 0 and (pts0[i] - pts[^1]).lenSq < 1e-6'f32:
      h[^1] = max(h[^1], w)
    else:
      pts.add pts0[i]
      h.add w
  let n = pts.len
  let K = s.tipCount
  var contour: seq[Vec2]
  if n == 1:
    for k in countdown(K - 1, 0): contour.addPt pts[0] + s.tipVertex(k, h[0])
  else:
    var d = newSeq[Vec2](n - 1)
    var kL = newSeq[int](n - 1)
    var kR = newSeq[int](n - 1)
    for i in 0 ..< n - 1:
      d[i] = (pts[i + 1] - pts[i]).normalized
      let nl = perp(d[i])
      kL[i] = s.support(nl)
      kR[i] = s.support(nl * -1'f32)
    var left, right: seq[Vec2]           # both built start -> end
    left.addPt pts[0] + s.tipVertex(kL[0], h[0])
    right.addPt pts[0] + s.tipVertex(kR[0], h[0])
    for j in 1 ..< n:
      let p = pts[j]
      left.addPt p + s.tipVertex(kL[j - 1], h[j])
      right.addPt p + s.tipVertex(kR[j - 1], h[j])
      if j == n - 1: break
      let turn = cross(d[j - 1], d[j])
      # a dead-straight reversal has no side; treat it as a right turn
      let rightTurn = turn < 0'f32 or (turn == 0'f32 and dot(d[j - 1], d[j]) < 0'f32)
      if rightTurn:
        # left is the outside: follow the tip clockwise; right: via the centre
        s.walk(left, p, h[j], kL[j - 1], kL[j], -1)
        if kR[j - 1] != kR[j]: right.addPt p
      else:
        if kL[j - 1] != kL[j]: left.addPt p
        s.walk(right, p, h[j], kR[j - 1], kR[j], +1)
      left.addPt p + s.tipVertex(kL[j], h[j])
      right.addPt p + s.tipVertex(kR[j], h[j])
    # left edge, end cap (clockwise round the front), right edge back,
    # start cap (clockwise round the back)
    for q in left: contour.addPt q
    s.walk(contour, pts[n - 1], h[n - 1], kL[n - 2], kR[n - 2], -1)
    for i in countdown(right.len - 1, 0): contour.addPt right[i]
    s.walk(contour, pts[0], h[0], kR[0], kL[0], -1)
    if contour.len > 1 and (contour[^1] - contour[0]).lenSq <= 1e-8'f32:
      contour.setLen(contour.len - 1)    # closePath joins them anyway
  if contour.len < 3: return
  s.outline.add float32(contour.len)
  for q in contour:
    s.outline.add q.x
    s.outline.add q.y

## Rebuild `outline`, `centerline` and `bbox` from the stabilised samples.
proc retessellate*(s: var Stroke) =
  s.outline.setLen(0)
  s.centerline.setLen(0)
  s.bbox = emptyAabb()
  let (pts, prs) = resample(smoothed(s.raw, s.smoothing))
  if pts.len == 0: return
  s.centerline = pts
  for p in pts: s.bbox.expand(p)
  s.sweep(pts, prs)
  s.bbox = s.bbox.pad(0.5'f32 * s.baseWidth + 1.0'f32)

## Distance test used by the eraser: true when `p` lies within `radius`
## of the stroke's inked area (cheap bbox reject, then centerline check).
proc hit*(s: Stroke, p: Vec2, radius: float32): bool =
  if not s.alive: return false
  let r = radius + 0.5'f32 * s.baseWidth
  if not s.bbox.pad(r).contains(p): return false
  let r2 = r * r
  if s.centerline.len == 1:
    return (p - s.centerline[0]).lenSq <= r2
  for i in 0 ..< s.centerline.len - 1:
    let a = s.centerline[i]
    let b = s.centerline[i + 1]
    let ab = b - a
    let l2 = ab.lenSq
    var t = 0.0'f32
    if l2 > 1e-6'f32:
      t = clamp(dot(p - a, ab) / l2, 0.0'f32, 1.0'f32)
    let proj = a + ab * t
    if (p - proj).lenSq <= r2: return true
  false
