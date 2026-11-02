#!/bin/sh
# Solace 0.2 — build the WebAssembly engine from vendor/stockfish.
#
#   ./scripts/build.sh              # both variants: SIMD and relaxed SIMD
#   VARIANT=simd ./scripts/build.sh # only the portable SIMD build
#   VARIANT=relaxed ./scripts/build.sh
#   NO_SIMD=1 ./scripts/build.sh    # portable build without SIMD at all
#
# Experiments:
#   CLEAN=1            rebuild every object instead of reusing scripts/obj
#   BUILD_DIR=<dir>    where objects live (default scripts/obj)
#   EXTRA_CFLAGS=<..>  extra flags for both compile and link, e.g. -flto
#
# Requirements: Emscripten (em++ 3.1.50 or newer) on PATH, or EMXX pointing at
# it. docs/BUILD.md explains how to install it.
#
# vendor/stockfish is never modified: it is copied to scripts/work/, the
# patches in patches/ are applied there, our sources from src/cpp/ are added,
# and the result is compiled into engine/.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
VENDOR="$ROOT/vendor/stockfish"
WORK="$HERE/work"
OBJ=${BUILD_DIR:-$HERE/obj}
OUT="$ROOT/engine"

EMXX=${EMXX:-em++}
if ! command -v "$EMXX" >/dev/null 2>&1; then
    echo "error: '$EMXX' not found. Install Emscripten or set EMXX=/path/to/em++" >&2
    echo "       (docs/BUILD.md explains both routes)" >&2
    exit 1
fi

echo "== Solace 0.2 build =="
echo "compiler: $("$EMXX" --version | head -1)"

# 1. Fresh working copy of the vendored engine + our patches.
rm -rf "$WORK"
mkdir -p "$WORK"
cp -R "$VENDOR/." "$WORK/"
for p in "$ROOT"/patches/*.patch; do
    echo "applying $(basename "$p")"
    patch -p1 -s -d "$WORK" < "$p"
done
cp "$ROOT"/src/cpp/*.cpp "$ROOT"/src/cpp/*.h "$WORK/src/"

# 2. Compile. Objects are reused unless CLEAN=1 is set, which matters when
#    iterating on one translation unit: a full rebuild of both variants takes
#    a few minutes, a one-file rebuild a few seconds.
mkdir -p "$OBJ"
if [ "${CLEAN:-0}" = "1" ]; then
    rm -rf "$OBJ"/*
fi

BASE_CFLAGS="-O3 -std=c++17 -fno-exceptions -fno-rtti -DNDEBUG"
VARIANT_LIST=${VARIANT:-"simd relaxed"}
if [ "${NO_SIMD:-0}" = "1" ]; then
    VARIANT_LIST="nosimd"
fi

# Sources are identical for every variant; only the SIMD flags differ, so each
# variant gets its own object directory.
SRCS="attacks.cpp benchmark.cpp bitboard.cpp evaluate.cpp main.cpp misc.cpp
      movegen.cpp movepick.cpp position.cpp search.cpp thread.cpp timeman.cpp
      tt.cpp uci.cpp ucioption.cpp tune.cpp syzygy/tbprobe.cpp
      nnue/nnue_accumulator.cpp nnue/nnue_misc.cpp nnue/network.cpp
      nnue/features/half_ka_v2_hm.cpp nnue/features/full_threats.cpp
      nnue/features/pp_3wide.cpp engine.cpp score.cpp memory.cpp
      wasm_bridge.cpp solace.cpp"

mkdir -p "$OUT"

for variant in $VARIANT_LIST; do
    case "$variant" in
        simd)    SIMDFLAGS="-msimd128" ;;
        relaxed) SIMDFLAGS="-msimd128 -mrelaxed-simd" ;;
        nosimd)  SIMDFLAGS="" ;;
        *) echo "error: unknown VARIANT '$variant'" >&2; exit 1 ;;
    esac

    CFLAGS="$BASE_CFLAGS $SIMDFLAGS -DUSE_POPCNT -DNNUE_EMBEDDING_OFF -DUSE_SLOPPY_ATOMICS -DNO_TABLEBASES -DSOLACE_WASM -pthread ${EXTRA_CFLAGS:-}"

    echo
    echo "== variant $variant ($SIMDFLAGS) =="
    mkdir -p "$OBJ/$variant"

    cd "$WORK/src"
    i=0
    total=$(echo $SRCS | wc -w)
    for src in $SRCS; do
        i=$((i + 1))
        out="$OBJ/$variant/$(echo "$src" | tr '/' '_' | sed 's/\.cpp$/.o/')"
        if [ -f "$out" ]; then
            printf '  [%2d/%d] %s (cached)\n' "$i" "$total" "$src"
            continue
        fi
        printf '  [%2d/%d] %s\n' "$i" "$total" "$src"
        # shellcheck disable=SC2086
        "$EMXX" $CFLAGS -I. -Isyzygy -Innue -Innue/features -c "$src" -o "$out"
    done
    cd "$HERE"

    case "$variant" in
        relaxed) NAME=solace-relaxed ;;
        simd)    NAME=solace ;;
        nosimd)  NAME=solace-nosimd ;;
    esac

    echo "linking engine/$NAME.js + engine/$NAME.wasm"
    # shellcheck disable=SC2086
    "$EMXX" "$OBJ/$variant"/*.o $CFLAGS \
        -sALLOW_MEMORY_GROWTH=1 \
        -sINITIAL_MEMORY=268435456 \
        -sMAXIMUM_MEMORY=2147483648 \
        -sSTACK_SIZE=5242880 \
        -sMODULARIZE=1 \
        -sEXPORT_ES6=1 \
        -sEXPORT_NAME=createSolace \
        -sINVOKE_RUN=0 \
        -sEXIT_RUNTIME=0 \
        -sFORCE_FILESYSTEM=1 \
        -sENVIRONMENT=web,worker,node \
        -sPTHREAD_POOL_SIZE=0 \
        -sPTHREAD_POOL_SIZE_STRICT=0 \
        -sEXPORTED_FUNCTIONS=['_main','_solace_command','_solace_ready','_malloc','_free'] \
        -sEXPORTED_RUNTIME_METHODS=['FS','callMain','ccall','UTF8ToString','stringToUTF8','lengthBytesUTF8'] \
        ${EXTRA_CFLAGS:-} \
        -o "$OUT/$NAME.js"
    ls -l "$OUT/$NAME.js" "$OUT/$NAME.wasm"
done

echo "done."
