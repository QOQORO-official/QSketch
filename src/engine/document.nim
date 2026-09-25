## The document: an ordered store of strokes plus undo/redo and a compact
## binary serializer. Strokes are never physically removed while the app is
## live (erase just flips `alive`), which keeps undo O(1) and lets the JS
## side cache one Path2D per stroke id for the lifetime of the session.

import geometry
import stroke

type
  ActionKind = enum
    akAdd      ## a stroke was drawn
    akErase    ## one or more strokes were erased
    akClear    ## everything was erased at once

  Action = object
    kind: ActionKind
    ids: seq[int]

  Document* = object
    strokes*: seq[Stroke]
    undoStack: seq[Action]
    redoStack: seq[Action]

func newDocument*(): Document = Document()

proc addStroke*(d: var Document, s: Stroke): int =
  ## Commit a finished stroke, returning its stable id (index).
  d.strokes.add s
  result = d.strokes.len - 1
  d.undoStack.add Action(kind: akAdd, ids: @[result])
  d.redoStack.setLen(0)

proc eraseAt*(d: var Document, p: Vec2, radius: float32): int =
  ## Kill every alive stroke touching `p`. Returns how many were removed.
  var removed: seq[int]
  for i in 0 ..< d.strokes.len:
    if d.strokes[i].alive and d.strokes[i].hit(p, radius):
      d.strokes[i].alive = false
      removed.add i
  if removed.len > 0:
    d.undoStack.add Action(kind: akErase, ids: removed)
    d.redoStack.setLen(0)
  removed.len

proc clearAll*(d: var Document): int =
  var removed: seq[int]
  for i in 0 ..< d.strokes.len:
    if d.strokes[i].alive:
      d.strokes[i].alive = false
      removed.add i
  if removed.len > 0:
    d.undoStack.add Action(kind: akClear, ids: removed)
    d.redoStack.setLen(0)
  removed.len

proc applyReverse(d: var Document, a: Action) =
  case a.kind
  of akAdd:
    for id in a.ids: d.strokes[id].alive = false
  of akErase, akClear:
    for id in a.ids: d.strokes[id].alive = true

proc applyForward(d: var Document, a: Action) =
  case a.kind
  of akAdd:
    for id in a.ids: d.strokes[id].alive = true
  of akErase, akClear:
    for id in a.ids: d.strokes[id].alive = false

proc undo*(d: var Document): bool =
  if d.undoStack.len == 0: return false
  let a = d.undoStack.pop()
  d.applyReverse(a)
  d.redoStack.add a
  true

proc redo*(d: var Document): bool =
  if d.redoStack.len == 0: return false
  let a = d.redoStack.pop()
  d.applyForward(a)
  d.undoStack.add a
  true

func canUndo*(d: Document): bool = d.undoStack.len > 0
func canRedo*(d: Document): bool = d.redoStack.len > 0

# --------------------------------------------------------------------------
# Binary serialization: "QSK1" + strokes as raw samples so they can be
# re-tessellated identically on load. Little-endian, packed.
# --------------------------------------------------------------------------

proc putU32(b: var seq[byte], v: uint32) =
  b.add byte(v and 0xff)
  b.add byte((v shr 8) and 0xff)
  b.add byte((v shr 16) and 0xff)
  b.add byte((v shr 24) and 0xff)

proc putF32(b: var seq[byte], v: float32) =
  putU32(b, cast[uint32](v))

proc getU32(b: seq[byte], o: var int): uint32 =
  result = uint32(b[o]) or (uint32(b[o+1]) shl 8) or
           (uint32(b[o+2]) shl 16) or (uint32(b[o+3]) shl 24)
  o += 4

proc getF32(b: seq[byte], o: var int): float32 =
  cast[float32](getU32(b, o))

proc serialize*(d: Document): seq[byte] =
  result.add byte('Q'); result.add byte('S'); result.add byte('K'); result.add byte('1')
  var alive: seq[int]
  for i in 0 ..< d.strokes.len:
    if d.strokes[i].alive: alive.add i
  putU32(result, uint32(alive.len))
  for i in alive:
    let s = d.strokes[i]
    putU32(result, s.color)
    putF32(result, s.baseWidth)
    putU32(result, uint32(s.raw.len))
    for smp in s.raw:
      putF32(result, smp.pos.x)
      putF32(result, smp.pos.y)
      putF32(result, smp.pressure)

proc deserialize*(d: var Document, b: seq[byte]): bool =
  if b.len < 8: return false
  if b[0] != byte('Q') or b[1] != byte('S') or b[2] != byte('K') or b[3] != byte('1'):
    return false
  var o = 4
  d.strokes.setLen(0)
  d.undoStack.setLen(0)
  d.redoStack.setLen(0)
  let count = getU32(b, o)
  for _ in 0 ..< int(count):
    let color = getU32(b, o)
    let bw = getF32(b, o)
    let ns = int(getU32(b, o))
    var s = newStroke(color, bw)
    for _ in 0 ..< ns:
      let x = getF32(b, o)
      let y = getF32(b, o)
      let pr = getF32(b, o)
      s.addSample(vec2(x, y), pr)
    s.retessellate()
    discard d.addStroke(s)
  true
