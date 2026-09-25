<div align="center">

# ✎ QSketch

**A fast, infinite-canvas sketch & handwritten-notes app that runs entirely in the browser — with its geometry engine written in [Nim](https://nim-lang.org) and compiled to WebAssembly.**

Pressure-sensitive vector strokes · infinite pan/zoom canvas · eraser · undo/redo · save & export — served as a single static page, deployable to GitHub Pages with zero backend.

</div>

---

## What this is

QSketch is a from-scratch, statically-hosted take on the drawing experience of
[**Rnote**](https://github.com/flxzt/rnote) (the Rust/GTK vector notes app),
rebuilt for the web. Rnote is a native desktop program; QSketch keeps the parts
that make it feel good to draw with — smooth, pressure-varying vector strokes on
an endless canvas — and delivers them as a page you can open anywhere.

The performance-critical core (stroke smoothing, variable-width tessellation,
spatial hit-testing, undo history, serialization) is written in Nim and
cross-compiled to a ~30 KB `wasm32` module. The build approach — driving Nim
through `clang`/`wasm-ld` to a freestanding WebAssembly binary with a tiny libc
shim — is inspired by
[**bindweb-nim-WASM-compiler**](https://github.com/benagastov/bindweb-nim-WASM-compiler),
here reduced to a single command-line pipeline instead of an in-browser IDE.

### Features

- **Four brushes**, each remembering its own size and settings. Pick one by
  tapping the pen button again or pressing `1`–`4`.
  - **Ballpoint**: a thin, even line with only a slight pressure response.
  - **Fountain pen**: pressure tapers the line from hairline to full width.
  - **Calligraphy**: a rigid, flat, angled nib (like a qalam or broad-edge
    pen), so thick and thin come from the direction you move. A one-nib-width
    dab straight across the nib makes a clean rhombic dot (the "diamond" unit
    of Arabic calligraphy). The nib angle is adjustable.
  - **Marker**: broad, nearly constant width and translucent ink that stays
    even where a stroke crosses itself.
- **True vector strokes**: the tip shape (a disc, or the flat nib) is swept
  along the smoothed path and emitted as one closed outline per stroke. That
  gives clean round ends, solid sharp corners and no anti-aliasing seams, and
  the stroke you see while drawing is pixel-identical to the saved one.
- **Stabilization** (Brush ⚙ panel, per brush):
  - **Stabilizer** (pull string): the ink trails the pen on a visible string
    and only moves once the pen is further away than the string. Hand tremor
    never reaches the page and the line goes exactly as fast as you steer it,
    which is ideal for slow, careful calligraphy. Set in screen pixels, so it
    feels the same at any zoom.
  - **StreamLine**: a time-based pull on the nib that removes hand jitter.
    It follows event timestamps, so a 240 Hz S Pen and a 60 Hz mouse feel the
    same. When the pen lifts, the line eases onto the lift point.
  - **Smoothing**: evens out the finished path; endpoints stay where you put them.
  - StreamLine and Smoothing go well past their old maximums (2× and 3×).
- **Pressure settings**: on/off, a soft ↔ firm **pressure curve** with a live
  preview graph and pen-pressure meter, and a per-brush **Min size** (width at
  the lightest touch) and **Opacity**.
- **Touch navigation**: pinch to zoom (anchored between your fingers), two
  fingers to pan, **2-finger tap = undo, 3-finger tap = redo**.
- **Pen-first input**: fingers draw until a stylus is used, then switch to
  pan & zoom (configurable: Auto / Draw / Pan & zoom only). Palm rejection
  ignores touches while the pen is down. The **S Pen side button erases**.
- **Infinite canvas**: pan and zoom are a pure Canvas2D transform. Committed
  strokes are cached in a layer, so only the live stroke redraws while you draw.
- **Tools**: pen, stroke eraser with its own size (one drag = one undo step), pan.
- **Undo / redo**, **Save / open** (`.qsketch` stores each stroke's tip and
  brush settings; older files still open), **Export PNG**.
- **No runtime dependencies**: one HTML file, one JS file, one CSS file and one
  self-contained `.wasm` with zero imports. Light/dark aware; settings are
  remembered per browser.

## Architecture

```
┌─────────────────────────── browser ───────────────────────────┐
│  index.html · styles.css · app.js   (camera + Canvas2D render) │
│        │  world-space coords over a tiny (ptr,len) ABI          │
│        ▼                                                        │
│  qsketch.wasm   ← Nim engine (document, smoothing, hit-test,    │
│                    undo/redo, save/load)                        │
└────────────────────────────────────────────────────────────────┘
```

- **JS owns the camera and rendering.** Pointer events are converted to *world*
  coordinates and pushed into the engine; pan/zoom is a `ctx.setTransform`.
  Each committed stroke's outline is turned into a `Path2D` exactly once (it
  never changes) and cached by id — only the in-progress stroke re-tessellates
  per pointer move. This is what keeps it smooth with thousands of strokes.
- **Nim owns all geometry**, in world space, exported over a minimal C ABI
  (`qs_begin_stroke`, `qs_add_point`, `qs_live_update`, `qs_commit_stroke`,
  `qs_erase`, `qs_undo`, `qs_save_ptr`/`qs_load`, …). Buffers cross the boundary as
  `(pointer, count)` pairs read directly from linear memory.

Source layout:

| Path | What |
|------|------|
| `src/qsketch.nim` | WASM entry points / ABI |
| `src/engine/geometry.nim` | vec2 / AABB maths |
| `src/engine/stroke.nim` | StreamLine + smoothing, tip sweep → one outline per stroke (round tip, calligraphy nib) |
| `src/engine/document.nim` | stroke store, undo/redo, binary (de)serialize |
| `web/` | the static site (`index.html`, `app.js`, `styles.css`, built `qsketch.wasm`) |
| `build/walloc.c`, `build/inc/` | freestanding libc shim + stub headers |
| `tools/build.sh` | the Nim → C → wasm build pipeline |
| `.github/workflows/deploy.yml` | build + deploy to GitHub Pages |

## Build locally

Requirements: `clang` + `wasm-ld` (LLVM ≥ 11) and `curl`. A Nim compiler is
optional — if `nim` isn't on your `PATH`, the build script downloads the pinned
`2.0.14` release into `build/.cache/`.

```bash
bash tools/build.sh          # produces web/qsketch.wasm
```

Then serve the `web/` folder over HTTP (WebAssembly won't load from `file://`):

```bash
cd web && python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy to GitHub Pages

The included workflow (`.github/workflows/deploy.yml`) builds the engine and
publishes `web/` on every push to `main`.

1. Push this repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually). The site goes live at
   `https://<user>.github.io/<repo>/`.

No secrets or servers required — it's a fully static build.

## Controls

| Input | Action | Input | Action |
|-------|--------|-------|--------|
| Pen / mouse | Draw | S Pen side button | Erase while held |
| Pinch | Zoom | Two-finger drag | Pan |
| 2-finger tap | Undo | 3-finger tap | Redo |
| `P` / `E` / `H` | Pen / Eraser / Pan | hold `Space` | Pan |
| `[` / `]` | Size − / + | `B` | Brush settings |
| `1`–`4` | Ballpoint / Fountain / Calligraphy / Marker | tap pen again | Brush picker |
| `Ctrl/⌘ Z` | Undo | `Ctrl/⌘ Shift Z`, `Ctrl Y` | Redo |
| scroll | Zoom to cursor | `+` / `-` / `0` | Zoom / reset view |

## Credits & licence

- Drawing experience inspired by **Rnote** by flxzt — https://github.com/flxzt/rnote (GPL-3.0). No Rnote code is used here; QSketch is an independent implementation.
- Nim → WebAssembly build approach inspired by **bindweb-nim-WASM-compiler** by benagastov — https://github.com/benagastov/bindweb-nim-WASM-compiler.

QSketch's own code is released under the MIT licence — see [`LICENSE`](LICENSE).
