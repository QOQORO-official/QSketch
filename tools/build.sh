#!/usr/bin/env bash
# Build the QSketch engine: Nim -> C -> freestanding wasm32 -> web/qsketch.wasm
#
# No emscripten, no WASI sysroot. Nim emits C, clang cross-compiles it for
# wasm32 against our stub headers + walloc.c shim, and wasm-ld links a single
# side-module-style wasm that the page instantiates directly.
#
# Requirements: clang + wasm-ld (LLVM >= 11), and a Nim 2.0.x compiler. If
# `nim` is not on PATH the script downloads the pinned linux-x64 release into
# a local cache, so CI needs nothing preinstalled but LLVM.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
CACHE="$BUILD/.cache"
NC="$BUILD/.nimcache"
OUT="$ROOT/web/qsketch.wasm"

NIM_VERSION="2.0.14"
mkdir -p "$CACHE" "$NC" "$ROOT/web"

# --- locate Nim -----------------------------------------------------------
if command -v nim >/dev/null 2>&1; then
  NIM="$(command -v nim)"
elif [ -x "$CACHE/nim-$NIM_VERSION/bin/nim" ]; then
  NIM="$CACHE/nim-$NIM_VERSION/bin/nim"
else
  echo ">> fetching Nim $NIM_VERSION ..."
  url="https://nim-lang.org/download/nim-$NIM_VERSION-linux_x64.tar.xz"
  curl -fsSL -o "$CACHE/nim.tar.xz" "$url"
  tar -C "$CACHE" -xf "$CACHE/nim.tar.xz"
  NIM="$CACHE/nim-$NIM_VERSION/bin/nim"
fi
NIMLIB="$(dirname "$(dirname "$NIM")")/lib"
echo ">> nim:     $NIM"
echo ">> nim lib: $NIMLIB"

CLANG="${CLANG:-clang}"
WASMLD="${WASMLD:-wasm-ld}"
command -v "$CLANG"  >/dev/null || { echo "clang not found"; exit 1; }
command -v "$WASMLD" >/dev/null || { echo "wasm-ld not found"; exit 1; }

# --- 1. Nim -> C ----------------------------------------------------------
echo ">> nim: transpiling to C"
rm -rf "$NC"
"$NIM" c \
  --cpu:wasm32 --os:any \
  --mm:arc --deepcopy:on -d:useMalloc \
  --exceptions:goto --panics:on \
  -d:danger --opt:speed \
  --noMain:on --compileOnly:on --nimcache:"$NC" \
  --header:off \
  "$ROOT/src/qsketch.nim"

# --- 2. C -> wasm objects -------------------------------------------------
echo ">> clang: compiling C -> wasm32 objects"
CFLAGS=(--target=wasm32 -O3 -flto -nostdlib -ffreestanding
        -fno-builtin-malloc -fno-builtin-calloc -fno-builtin-realloc -fno-builtin-free
        -isystem "$BUILD/inc" -I"$NIMLIB" -DNIM_INTBITS=32
        -Wno-implicit-function-declaration -Wno-incompatible-library-redeclaration)

"$CLANG" "${CFLAGS[@]}" -c "$BUILD/walloc.c" -o "$NC/walloc.o"
for f in "$NC"/*.nim.c; do
  "$CLANG" "${CFLAGS[@]}" -c "$f" -o "$f.o"
done

# --- 3. link --------------------------------------------------------------
echo ">> wasm-ld: linking $OUT"
"$WASMLD" \
  --no-entry --lto-O3 --allow-undefined \
  --export-dynamic --export=__heap_base --export=memory \
  --initial-memory=$((16*1024*1024)) --max-memory=$((512*1024*1024)) \
  -o "$OUT" "$NC"/*.o

# --- 4. optional size pass ------------------------------------------------
if command -v wasm-opt >/dev/null 2>&1; then
  echo ">> wasm-opt: -O3"
  wasm-opt -O3 --enable-bulk-memory "$OUT" -o "$OUT" || echo "   (wasm-opt skipped)"
fi

bytes=$(wc -c < "$OUT")
echo ">> done: $OUT ($bytes bytes)"
