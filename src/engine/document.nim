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
    ## While an eraser drag is in progress every stroke it removes is folded
    ## into one undo step, like a single brush stroke.
    eraseGroup: bool
    eraseGroupOpen: bool

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
    if d.eraseGroup and d.eraseGroupOpen:
      d.undoStack[^1].ids.add removed
    else:
      d.undoStack.add Action(kind: akErase, ids: removed)
      d.eraseGroupOpen = d.eraseGroup
    d.redoStack.setLen(0)
  removed.len

proc beginEraseGroup*(d: var Document) =
  d.eraseGroup = true
  d.eraseGroupOpen = false

proc endEraseGroup*(d: var Document) =
  d.eraseGroup = false
  d.eraseGroupOpen = false

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
# Binary serialization: "QSK2" + strokes as stabilised samples so they can be
# re-tessellated identically on load. Little-endian, packed. Per stroke:
#   u32 color, f32 baseWidth, f32 minRatio, f32 smoothing, u32 n, n*(x,y,p)
# "QSK1" files (no minRatio/smoothing) still load with the old defaults.
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
  result.add byte('Q'); result.add byte('S'); result.add byte('K'); result.add byte('2')
  var alive: seq[int]
  for i in 0 ..< d.strokes.len:
    if d.strokes[i].alive: alive.add i
  putU32(result, uint32(alive.len))
  for i in alive:
    let s = d.strokes[i]
    putU32(result, s.color)
    putF32(result, s.baseWidth)
    putF32(result, s.minRatio)
    putF32(result, s.smoothing)
    putU32(result, uint32(s.raw.len))
    for smp in s.raw:
      putF32(result, smp.pos.x)
      putF32(result, smp.pos.y)
      putF32(result, smp.pressure)

proc deserialize*(d: var Document, b: seq[byte]): bool =
  if b.len < 8: return false
  if b[0] != byte('Q') or b[1] != byte('S') or b[2] != byte('K'): return false
  let version = b[3]
  if version != byte('1') and version != byte('2'): return false
  let perStroke = if version == byte('2'): 20 else: 12   # header bytes
  # Validate the whole buffer before touching the document, so a truncated
  # or corrupt file leaves the current drawing intact.
  var o = 4
  let count = int(getU32(b, o))
  var probe = o
  for _ in 0 ..< count:
    if probe + perStroke > b.len: return false
    let ns = int(uint32(b[probe + perStroke - 4]) or
                 (uint32(b[probe + perStroke - 3]) shl 8) or
                 (uint32(b[probe + perStroke - 2]) shl 16) or
                 (uint32(b[probe + perStroke - 1]) shl 24))
    probe += perStroke
    if ns < 0 or ns > (b.len - probe) div 12: return false
    probe += ns * 12

  d.strokes.setLen(0)
  d.undoStack.setLen(0)
  d.redoStack.setLen(0)
  for _ in 0 ..< count:
    let color = getU32(b, o)
    let bw = getF32(b, o)
    var minRatio = DefaultMinRatio
    var smoothing = 0'f32
    if version == byte('2'):
      minRatio = getF32(b, o)
      smoothing = getF32(b, o)
    let ns = int(getU32(b, o))
    var s = newStroke(color, bw, minRatio, smoothing)
    for _ in 0 ..< ns:
      let x = getF32(b, o)
      let y = getF32(b, o)
      let pr = getF32(b, o)
      s.addSample(vec2(x, y), pr)
    s.retessellate()
    discard d.addStroke(s)
  # a freshly opened file starts with a clean history
  d.undoStack.setLen(0)
  true
