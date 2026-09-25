## Small vector maths used across the engine. Kept dependency-free so the
## whole thing cross-compiles to freestanding wasm32 with nothing but the
## Nim runtime and our tiny libc shim.

import std/math

type
  Vec2* = object
    x*, y*: float32

func vec2*(x, y: float32): Vec2 {.inline.} = Vec2(x: x, y: y)

func `+`*(a, b: Vec2): Vec2 {.inline.} = vec2(a.x + b.x, a.y + b.y)
func `-`*(a, b: Vec2): Vec2 {.inline.} = vec2(a.x - b.x, a.y - b.y)
func `*`*(a: Vec2, s: float32): Vec2 {.inline.} = vec2(a.x * s, a.y * s)

func dot*(a, b: Vec2): float32 {.inline.} = a.x * b.x + a.y * b.y
func cross*(a, b: Vec2): float32 {.inline.} = a.x * b.y - a.y * b.x
func lenSq*(a: Vec2): float32 {.inline.} = a.x * a.x + a.y * a.y
func len*(a: Vec2): float32 {.inline.} = sqrt(a.x * a.x + a.y * a.y)

func normalized*(a: Vec2): Vec2 {.inline.} =
  let l = a.len
  if l > 1e-6'f32: vec2(a.x / l, a.y / l) else: vec2(0, 0)

## Left-hand perpendicular (rotate +90 degrees). For a direction pointing
## "forward" along a stroke this gives the left side normal.
func perp*(a: Vec2): Vec2 {.inline.} = vec2(-a.y, a.x)

func lerp*(a, b: Vec2, t: float32): Vec2 {.inline.} =
  vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)

type
  Aabb* = object
    minx*, miny*, maxx*, maxy*: float32

func emptyAabb*(): Aabb {.inline.} =
  Aabb(minx: 1e30'f32, miny: 1e30'f32, maxx: -1e30'f32, maxy: -1e30'f32)

func expand*(b: var Aabb, p: Vec2) {.inline.} =
  if p.x < b.minx: b.minx = p.x
  if p.y < b.miny: b.miny = p.y
  if p.x > b.maxx: b.maxx = p.x
  if p.y > b.maxy: b.maxy = p.y

func pad*(b: Aabb, m: float32): Aabb {.inline.} =
  Aabb(minx: b.minx - m, miny: b.miny - m, maxx: b.maxx + m, maxy: b.maxy + m)

func contains*(b: Aabb, p: Vec2): bool {.inline.} =
  p.x >= b.minx and p.x <= b.maxx and p.y >= b.miny and p.y <= b.maxy

## Even-odd point-in-polygon test (poly given as a closed ring of points).
func insidePoly*(poly: openArray[Vec2], p: Vec2): bool =
  var inside = false
  var j = poly.len - 1
  for i in 0 ..< poly.len:
    let a = poly[i]
    let b = poly[j]
    if (a.y > p.y) != (b.y > p.y):
      let x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)
      if p.x < x: inside = not inside
    j = i
  inside

func overlaps*(a, b: Aabb): bool {.inline.} =
  a.minx <= b.maxx and b.minx <= a.maxx and a.miny <= b.maxy and b.miny <= a.maxy
