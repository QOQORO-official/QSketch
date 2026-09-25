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
    akReplace  ## strokes swapped for edited copies (move/resize/rotate/recolor)

  Action = object
    kind: ActionKind
    ids: seq[int]           ## added (akAdd) or removed (the others)
    added: seq[int]         ## akReplace: the copies that took their place

  PagePattern* = enum
    ppBlank = 0, ppDots = 1, ppGrid = 2, ppLines = 3, ppNotebook = 4

  Document* = object
    strokes*: seq[Stroke]
    undoStack: seq[Action]
    redoStack: seq[Action]
    ## While an eraser drag is in progress every stroke it removes is folded
    ## into one undo step, like a single brush stroke.
    eraseGroup: bool
    eraseGroupOpen: bool
    ## Lasso selection: ids of alive strokes.
    selection*: seq[int]
    ## Page style, saved with the drawing (the UI draws it).
    pagePattern*: PagePattern
    pageSpacing*: float32
    pagePaper*: uint32      ## 0xRRGGBBAA; 0 = follow the app theme
    pageLoaded*: bool       ## the last file loaded carried a page style

func newDocument*(): Document =
  Document(pagePattern: ppDots, pageSpacing: 24'f32)

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
  d.selection.setLen(0)
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
  of akReplace:
    for id in a.added: d.strokes[id].alive = false
    for id in a.ids: d.strokes[id].alive = true

proc applyForward(d: var Document, a: Action) =
  case a.kind
  of akAdd:
    for id in a.ids: d.strokes[id].alive = true
  of akErase, akClear:
    for id in a.ids: d.strokes[id].alive = false
  of akReplace:
    for id in a.ids: d.strokes[id].alive = false
    for id in a.added: d.strokes[id].alive = true

proc undo*(d: var Document): bool =
  d.selection.setLen(0)
  if d.undoStack.len == 0: return false
  let a = d.undoStack.pop()
  d.applyReverse(a)
  d.redoStack.add a
  true

proc redo*(d: var Document): bool =
  d.selection.setLen(0)
  if d.redoStack.len == 0: return false
  let a = d.redoStack.pop()
  d.applyForward(a)
  d.undoStack.add a
  true

func canUndo*(d: Document): bool = d.undoStack.len > 0
func canRedo*(d: Document): bool = d.redoStack.len > 0

# --------------------------------------------------------------------------
# Lasso selection
# --------------------------------------------------------------------------

proc lassoSelect*(d: var Document, poly: seq[Vec2]): int =
  ## Select every alive stroke that lies mostly (>= half of its path) inside
  ## the closed lasso polygon, so a loop that merely grazes a stroke does not
  ## grab it. Returns the number selected.
  d.selection.setLen(0)
  if poly.len < 3: return 0
  var box = emptyAabb()
  for p in poly: box.expand(p)
  for i in 0 ..< d.strokes.len:
    let s = d.strokes[i]
    if not s.alive or not s.bbox.overlaps(box) or s.centerline.len == 0: continue
    var inside = 0
    for p in s.centerline:
      if box.contains(p) and poly.insidePoly(p): inc inside
    if inside * 2 >= s.centerline.len: d.selection.add i
  d.selection.len

proc clearSelection*(d: var Document) = d.selection.setLen(0)

proc selectionBounds*(d: Document): Aabb =
  ## Tight bounds of the selected ink (from the filled outlines).
  result = emptyAabb()
  for id in d.selection:
    let o = d.strokes[id].outline
    var i = 0
    while i < o.len:
      let n = int(o[i])
      inc i
      for k in 0 ..< n:
        result.expand(vec2(o[i + 2 * k], o[i + 2 * k + 1]))
      i += 2 * n

proc replaceSelection(d: var Document, fresh: seq[Stroke]) =
  ## Swap the selection for `fresh` (same order) as one undoable step;
  ## the copies become the new selection.
  var added: seq[int]
  for s in fresh:
    d.strokes.add s
    added.add d.strokes.len - 1
  for id in d.selection: d.strokes[id].alive = false
  d.undoStack.add Action(kind: akReplace, ids: d.selection, added: added)
  d.redoStack.setLen(0)
  d.selection = added

proc transformSelection*(d: var Document, sc, cosA, sinA: float32, t, pivot: Vec2): int =
  if d.selection.len == 0 or not (sc > 0.001'f32): return 0
  var fresh: seq[Stroke]
  for id in d.selection:
    fresh.add d.strokes[id].transformed(sc, cosA, sinA, t, pivot)
  d.replaceSelection(fresh)
  d.selection.len

proc recolorSelection*(d: var Document, color: uint32): int =
  if d.selection.len == 0: return 0
  var fresh: seq[Stroke]
  for id in d.selection:
    var s = d.strokes[id]
    # new hue, but each stroke keeps its own opacity (a marker stays translucent)
    s.color = (color and 0xFFFFFF00'u32) or (s.color and 0xFF'u32)
    fresh.add s
  d.replaceSelection(fresh)
  d.selection.len

proc deleteSelection*(d: var Document): int =
  if d.selection.len == 0: return 0
  for id in d.selection: d.strokes[id].alive = false
  d.undoStack.add Action(kind: akErase, ids: d.selection)
  d.redoStack.setLen(0)
  result = d.selection.len
  d.selection.setLen(0)

proc duplicateSelection*(d: var Document, offset: Vec2): int =
  ## Add moved copies (one undo step); the copies become the selection.
  if d.selection.len == 0: return 0
  var added: seq[int]
  for id in d.selection:
    d.strokes.add d.strokes[id].transformed(1'f32, 1'f32, 0'f32, offset, vec2(0, 0))
    added.add d.strokes.len - 1
  d.undoStack.add Action(kind: akAdd, ids: added)
  d.redoStack.setLen(0)
  d.selection = added
  added.len

# --------------------------------------------------------------------------
# Binary serialization: "QSK4" + page style + strokes as stabilised samples
# so they can be re-tessellated identically on load. Little-endian, packed:
#   u32 count, u32 pagePattern, f32 pageSpacing, u32 pagePaper, then per stroke
#   u32 color, f32 baseWidth, f32 minRatio, f32 smoothing,
#   u32 kind, f32 nibX, f32 nibY, f32 nibRatio, u32 n, n*(x,y,p)
# "QSK3" (no page block), "QSK2" (no tip fields) and "QSK1" (no minRatio /
# smoothing either) still load.
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
  result.add byte('Q'); result.add byte('S'); result.add byte('K'); result.add byte('4')
  var alive: seq[int]
  for i in 0 ..< d.strokes.len:
    if d.strokes[i].alive: alive.add i
  putU32(result, uint32(alive.len))
  putU32(result, uint32(ord(d.pagePattern)))
  putF32(result, d.pageSpacing)
  putU32(result, d.pagePaper)
  for i in alive:
    let s = d.strokes[i]
    putU32(result, s.color)
    putF32(result, s.baseWidth)
    putF32(result, s.minRatio)
    putF32(result, s.smoothing)
    putU32(result, uint32(ord(s.kind)))
    putF32(result, s.nibDir.x)
    putF32(result, s.nibDir.y)
    putF32(result, s.nibRatio)
    putU32(result, uint32(s.raw.len))
    for smp in s.raw:
      putF32(result, smp.pos.x)
      putF32(result, smp.pos.y)
      putF32(result, smp.pressure)

proc deserialize*(d: var Document, b: seq[byte]): bool =
  if b.len < 8: return false
  if b[0] != byte('Q') or b[1] != byte('S') or b[2] != byte('K'): return false
  let version = b[3]
  if version < byte('1') or version > byte('4'): return false
  let perStroke =                                      # header bytes
    if version >= byte('3'): 36 elif version == byte('2'): 20 else: 12
  let pageBytes = if version >= byte('4'): 12 else: 0
  # Validate the whole buffer before touching the document, so a truncated
  # or corrupt file leaves the current drawing intact.
  var o = 4
  let count = int(getU32(b, o))
  if o + pageBytes > b.len: return false
  var probe = o + pageBytes
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
  d.selection.setLen(0)
  d.pageLoaded = pageBytes > 0
  if pageBytes > 0:
    let pat = getU32(b, o)
    d.pagePattern = if pat <= uint32(ord(high(PagePattern))): PagePattern(pat) else: ppDots
    d.pageSpacing = getF32(b, o)
    d.pagePaper = getU32(b, o)
  for _ in 0 ..< count:
    let color = getU32(b, o)
    let bw = getF32(b, o)
    var minRatio = DefaultMinRatio
    var smoothing = 0'f32
    var kind = bkRound
    var nibDir = vec2(0.70710678'f32, -0.70710678'f32)
    var nibRatio = DefaultNibRatio
    if version >= byte('2'):
      minRatio = getF32(b, o)
      smoothing = getF32(b, o)
    if version >= byte('3'):
      let k = getU32(b, o)
      if k == uint32(ord(bkNib)): kind = bkNib
      let nx = getF32(b, o)
      let ny = getF32(b, o)
      nibDir = vec2(nx, ny)
      nibRatio = getF32(b, o)
    let ns = int(getU32(b, o))
    var s = newStroke(color, bw, minRatio, smoothing, 0'f32, kind, nibDir, nibRatio)
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
