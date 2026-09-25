## QSketch engine — WebAssembly entry points.
##
## The browser owns the camera (pan/zoom) and all rendering; this module owns
## the document model, stroke smoothing/tessellation, hit-testing, undo/redo
## and serialization. Coordinates crossing this boundary are always in world
## space (the JS side converts pointer events with its own camera transform),
## which keeps pan/zoom a pure Canvas2D `setTransform` with zero wasm work.
##
## Buffers are handed back as (pointer, count) pairs into the module's linear
## memory; JS reads them directly through a Float32Array/Uint8Array view.

import engine/geometry
import engine/stroke
import engine/document

{.pragma: wexport, exportc,
  codegenDecl: "__attribute__((export_name(\"$2\"))) $1 $2$3".}

var
  doc = newDocument()
  live: Stroke
  drawing = false
  scratch: seq[byte]        ## keeps serialize() output alive for JS to read

# --------------------------------------------------------------------------
# Shared scratch allocator for JS -> wasm transfers (e.g. loading a file).
# --------------------------------------------------------------------------
var inbuf: seq[byte]

proc qs_alloc(n: int32): pointer {.wexport.} =
  inbuf = newSeq[byte](int(n))
  if inbuf.len == 0: return nil
  addr inbuf[0]

# --------------------------------------------------------------------------
# Stroke capture.
# --------------------------------------------------------------------------

proc qs_begin_stroke(color: uint32, baseWidth, minRatio, smoothing,
                     streamline: float32) {.wexport.} =
  ## Start a stroke. `minRatio` is the width at zero pressure relative to
  ## `baseWidth`; `smoothing` and `streamline` are 0..1 stabiliser strengths.
  live = newStroke(color, baseWidth, minRatio, smoothing, streamline)
  drawing = true

proc qs_add_point(x, y, pressure, timeMs: float32) {.wexport.} =
  ## Queue one pen sample. Cheap: tessellation is deferred to
  ## qs_live_update so a burst of coalesced events costs one rebuild.
  if not drawing: return
  live.capture(vec2(x, y), pressure, timeMs)

proc qs_live_update() {.wexport.} =
  if drawing: live.retessellate()

proc qs_live_outline_ptr(): pointer {.wexport.} =
  if live.outline.len == 0: return nil
  addr live.outline[0]

proc qs_live_outline_count(): int32 {.wexport.} =
  int32(live.outline.len)

proc qs_commit_stroke(): int32 {.wexport.} =
  if not drawing: return -1
  drawing = false
  live.finishCapture()
  if live.raw.len == 0: return -1
  live.retessellate()
  int32(doc.addStroke(live))

proc qs_cancel_stroke() {.wexport.} =
  drawing = false
  live = newStroke(0, 1)
  live.retessellate()

# --------------------------------------------------------------------------
# Committed stroke access (for JS Path2D caching).
# --------------------------------------------------------------------------

proc qs_stroke_count(): int32 {.wexport.} =
  int32(doc.strokes.len)

proc qs_stroke_alive(id: int32): int32 {.wexport.} =
  if id < 0 or int(id) >= doc.strokes.len: return 0
  if doc.strokes[int(id)].alive: 1 else: 0

proc qs_stroke_outline_ptr(id: int32): pointer {.wexport.} =
  if id < 0 or int(id) >= doc.strokes.len: return nil
  if doc.strokes[int(id)].outline.len == 0: return nil
  addr doc.strokes[int(id)].outline[0]

proc qs_stroke_outline_count(id: int32): int32 {.wexport.} =
  if id < 0 or int(id) >= doc.strokes.len: return 0
  int32(doc.strokes[int(id)].outline.len)

proc qs_stroke_color(id: int32): uint32 {.wexport.} =
  if id < 0 or int(id) >= doc.strokes.len: return 0
  doc.strokes[int(id)].color

# --------------------------------------------------------------------------
# Editing.
# --------------------------------------------------------------------------

proc qs_erase(x, y, radius: float32): int32 {.wexport.} =
  int32(doc.eraseAt(vec2(x, y), radius))

proc qs_erase_begin() {.wexport.} =
  ## Group every qs_erase until qs_erase_end into a single undo step.
  doc.beginEraseGroup()

proc qs_erase_end() {.wexport.} =
  doc.endEraseGroup()

proc qs_clear(): int32 {.wexport.} =
  int32(doc.clearAll())

proc qs_undo(): int32 {.wexport.} =
  if doc.undo(): 1 else: 0

proc qs_redo(): int32 {.wexport.} =
  if doc.redo(): 1 else: 0

proc qs_can_undo(): int32 {.wexport.} =
  if doc.canUndo(): 1 else: 0

proc qs_can_redo(): int32 {.wexport.} =
  if doc.canRedo(): 1 else: 0

# --------------------------------------------------------------------------
# Serialization. save -> scratch buffer; JS reads (ptr,len) then may download.
# --------------------------------------------------------------------------

proc qs_save_ptr(): pointer {.wexport.} =
  scratch = doc.serialize()
  if scratch.len == 0: return nil
  addr scratch[0]

proc qs_save_len(): int32 {.wexport.} =
  int32(scratch.len)

proc qs_load(p: pointer, n: int32): int32 {.wexport.} =
  if p == nil or n <= 0: return 0
  var b = newSeq[byte](int(n))
  copyMem(addr b[0], p, int(n))
  if doc.deserialize(b): 1 else: 0

# The wasm module has no libc start; give it a no-op entry so any accidental
# reference resolves, and force the exports above to be retained.
proc NimMain() {.importc.}

proc qs_init() {.wexport.} =
  NimMain()
