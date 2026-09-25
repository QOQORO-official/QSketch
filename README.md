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
cross-compiled to a ~20 KB `wasm32` module. The build approach — driving Nim
through `clang`/`wasm-ld` to a freestanding WebAssembly binary with a tiny libc
shim — is inspired by
[**bindweb-nim-WASM-compiler**](https://github.com/benagastov/bindweb-nim-WASM-compiler),
here reduced to a single command-line pipeline instead of an in-browser IDE.

### Features

- **Pressure-sensitive brush** — real stylus pressure (via Pointer Events) drives
  variable stroke width; strokes are Catmull-Rom smoothed and rendered as filled
  vector outlines with rounded caps.
- **Infinite canvas** — pan (Space+drag / middle-drag) and zoom-to-cursor
  (scroll / pinch) implemented as a pure Canvas2D transform, so the engine never
  re-runs on a view change.
- **Tools** — pen, stroke eraser (spatial hit-test), pan.
- **Undo / redo** — O(1) command history in the engine.
- **Save / open** — compact binary `.qsketch` format (round-trips through the
  Nim serializer).
- **Export PNG** — tight-cropped, 2× raster export of the inked area.
- **Zero dependencies at runtime** — no frameworks; one HTML file, one JS file,
  one CSS file, one `.wasm`. Works from any static host.
- **Light / dark aware**, responsive toolbar, keyboard shortcuts.

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
  (`qs_begin_stroke`, `qs_add_point`, `qs_commit_stroke`, `qs_erase`, `qs_undo`,
  `qs_save_ptr`/`qs_load`, …). Buffers cross the boundary as
  `(pointer, count)` pairs read directly from linear memory.

Source layout:

| Path | What |
|------|------|
| `src/qsketch.nim` | WASM entry points / ABI |
| `src/engine/geometry.nim` | vec2 / AABB maths |
| `src/engine/stroke.nim` | smoothing + variable-width outline tessellation |
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

## Keyboard shortcuts

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `P` | Pen | `Ctrl/⌘ Z` | Undo |
| `E` | Eraser | `Ctrl/⌘ Shift Z` / `Ctrl Y` | Redo |
| `H` / hold `Space` | Pan | `+` / `-` | Zoom |
| scroll | Zoom to cursor | `0` | Reset view |

## Credits & licence

- Drawing experience inspired by **Rnote** by flxzt — https://github.com/flxzt/rnote (GPL-3.0). No Rnote code is used here; QSketch is an independent implementation.
- Nim → WebAssembly build approach inspired by **bindweb-nim-WASM-compiler** by benagastov — https://github.com/benagastov/bindweb-nim-WASM-compiler.

QSketch's own code is released under the MIT licence — see [`LICENSE`](LICENSE).
