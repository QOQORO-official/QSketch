## Stroke model: turns raw pressure-tagged input samples into a smooth,
## variable-width filled outline (the same visual language as Rnote's brush
## strokes). All heavy geometry lives here so it runs as compiled wasm.

import std/math
import geometry

type
  InputSample* = object
    pos*: Vec2
    pressure*: float32

  Stroke* = object
    ## Raw captured samples in world space (kept for re-tessellation / save).
    raw*: seq[InputSample]
    ## Flattened outline polygon: x0,y0,x1,y1, ... ready for Canvas2D fill.
    outline*: seq[float32]
    ## Sampled centerline for cheap hit testing (eraser / selection).
    centerline*: seq[Vec2]
    color*: uint32          ## 0xRRGGBBAA
    baseWidth*: float32     ## nominal diameter in world units
    bbox*: Aabb
    alive*: bool

const
  MinPressureRatio = 0.35'f32   ## thinnest part relative to base width
  CapSteps = 7                  ## semicircle segments for round caps
  # Fixed rotation step for round caps (PI / CapSteps) precomputed so we
  # never need a runtime trig call inside wasm.
  CapCos = 0.9009688679'f32     ## cos(PI/7)
  CapSin = 0.4338837391'f32     ## sin(PI/7)

func newStroke*(color: uint32, baseWidth: float32): Stroke =
  Stroke(color: color, baseWidth: baseWidth, alive: true, bbox: emptyAabb())

## Append a sample, lightly de-noised: drop samples that land almost on top
## of the previous one so the smoothing spline stays well conditioned.
proc addSample*(s: var Stroke, p: Vec2, pressure: float32) =
  let pr = clamp(pressure, 0.0'f32, 1.0'f32)
  if s.raw.len > 0:
    let d = (p - s.raw[^1].pos).lenSq
    if d < 0.25'f32:  # < 0.5px in world space
      # keep the freshest pressure but don't add a redundant vertex
      s.raw[^1].pressure = (s.raw[^1].pressure + pr) * 0.5'f32
      return
  s.raw.add InputSample(pos: p, pressure: pr)

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
  let r = MinPressureRatio + (1.0'f32 - MinPressureRatio) * pressure
  0.5'f32 * s.baseWidth * r      # half-width

proc pushCap(outline: var seq[float32], center, normal: Vec2, forward: bool) =
  ## Emit a round cap as a fan of points sweeping the half-width normal
  ## across a semicircle. `normal` is the +half-width offset vector.
  var nx = normal.x
  var ny = normal.y
  # sweeping direction depends on which end we are rounding
  let c = CapCos
  let sgn = if forward: CapSin else: -CapSin
  for _ in 0 ..< CapSteps:
    let rx = nx * c - ny * sgn
    let ry = nx * sgn + ny * c
    nx = rx; ny = ry
    outline.add center.x + nx
    outline.add center.y + ny

## Rebuild `outline`, `centerline` and `bbox` from the raw samples.
proc retessellate*(s: var Stroke) =
  s.outline.setLen(0)
  s.centerline.setLen(0)
  s.bbox = emptyAabb()
  let (pts, prs) = resample(s.raw)
  if pts.len == 0: return

  s.centerline = pts
  for p in pts: s.bbox.expand(p)

  if pts.len == 1:
    # a dot: emit a small square-ish diamond so single taps are visible
    let hw = s.widthAt(prs[0])
    let c = pts[0]
    let d = max(hw, 0.75'f32)
    s.outline.add c.x - d; s.outline.add c.y
    s.outline.add c.x;     s.outline.add c.y - d
    s.outline.add c.x + d; s.outline.add c.y
    s.outline.add c.x;     s.outline.add c.y + d
    s.bbox = s.bbox.pad(d)
    return

  # Per-point normals from averaged adjacent segment directions.
  let n = pts.len
  var normals = newSeq[Vec2](n)
  for i in 0 ..< n:
    var dir: Vec2
    if i == 0:
      dir = (pts[1] - pts[0])
    elif i == n - 1:
      dir = (pts[n - 1] - pts[n - 2])
    else:
      dir = (pts[i + 1] - pts[i - 1])
    normals[i] = perp(dir.normalized)

  # Left side forward, then right side backward => single closed polygon.
  var left: seq[float32]
  var right: seq[float32]
  for i in 0 ..< n:
    let hw = s.widthAt(prs[i])
    let off = normals[i] * hw
    left.add pts[i].x + off.x
    left.add pts[i].y + off.y
    right.add pts[i].x - off.x
    right.add pts[i].y - off.y

  # start cap (round), around first point using its normal*hw
  let hw0 = s.widthAt(prs[0])
  pushCap(s.outline, pts[0], normals[0] * hw0, forward = false)
  # left side, start -> end
  for i in 0 ..< n:
    s.outline.add left[i * 2]
    s.outline.add left[i * 2 + 1]
  # end cap
  let hwN = s.widthAt(prs[n - 1])
  pushCap(s.outline, pts[n - 1], normals[n - 1] * hwN, forward = true)
  # right side, end -> start
  for i in countdown(n - 1, 0):
    s.outline.add right[i * 2]
    s.outline.add right[i * 2 + 1]

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
