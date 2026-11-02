# Building Solace 0.2

Solace 0.2 is Stockfish 19 compiled to WebAssembly. The build is one shell
script plus a network download; nothing else is installed into the system.

```sh
cd 0.2
node scripts/fetch-net.mjs
./scripts/build.sh
```

`scripts/build.sh` never edits `vendor/stockfish`: it copies the engine to
`scripts/work/`, applies `patches/*.patch`, copies `src/cpp/*` in, compiles every
translation unit and links the engine into `engine/`.

It builds **two** variants by default, because relaxed SIMD is measurably faster
but is not available in every browser:

| variant | flags | output |
|---|---|---|
| `simd` | `-msimd128` | `engine/solace.js` + `engine/solace.wasm` |
| `relaxed` | `-msimd128 -mrelaxed-simd` | `engine/solace-relaxed.js` + `engine/solace-relaxed.wasm` |

`src/config.js` decides which one to load: it feature-tests a one-function
module for `i8x16.relaxed_swizzle` and prefers the relaxed build when the runtime
supports it and the file exists, otherwise the plain SIMD one.

Useful switches:

| variable | effect |
|---|---|
| `EMXX=/path/to/em++` | use a specific Emscripten |
| `VARIANT=simd` | build only one variant (also `relaxed`, `nosimd`) |
| `NO_SIMD=1` | build without `-msimd128` (slower, for very old runtimes) |
| `CLEAN=1` | ignore cached objects and rebuild everything |
| `BUILD_DIR=/tmp/obj` | where the objects live (default `scripts/obj`) |
| `EXTRA_CFLAGS=-flto` | extra compile **and** link flags, for experiments |
| `INITIAL_MEMORY=67108864` | wasm memory reserved at start-up (default 64 MB) |
| `MAXIMUM_MEMORY=1073741824` | how far it may grow (default 1 GB) |

Objects live in `scripts/obj/<variant>/` and are reused, so after editing one
file only that file is recompiled:

```
  [ 1/28] attacks.cpp (cached)
  ...
  [28/28] solace.cpp
```

## 1. Install Emscripten

### Normal route (emsdk)

```sh
git clone --depth 1 https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh          # puts em++ on PATH for this shell
```

Any Emscripten 3.1.50 or newer works; 4.x/5.x/6.x are fine. The upstream
Stockfish project builds its wasm releases exactly this way.

### Without root, or on Android (Termux)

```sh
pkg install git python nodejs clang ninja cmake
git clone --depth 1 https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
. ./emsdk_env.sh
```

Then follow the steps above inside the same Termux session. Building takes
20–60 minutes on a phone and needs ~1 GB of free storage; the resulting
`engine/` files can be copied to any other machine.

### When no Emscripten can be installed at all

The npm package `@ai-ecoverse/wasm-emscripten` ships clang and binaryen compiled
to WebAssembly and runs them under Node, which needs no toolchain install at
all. It does not behave like a compiler driver as shipped, so
`tools/toolchain/setup-toolchain.py` fixes it up:

```sh
mkdir -p ~/emtool && cd ~/emtool
npm install @ai-ecoverse/wasm-emscripten@6.0.9-31
python3 /home/user/solace/0.2/tools/toolchain/setup-toolchain.py --dir .
. ./env.sh                       # EM_CONFIG, EM_CACHE, PATH for em++
cd /home/user/solace/0.2 && EMXX=em++ ./scripts/build.sh
```

Two bugs in the packaged tools have to be worked around, and both are fixed by
those scripts:

* the tools have an in-memory filesystem, so the host directories must be
  mounted *over* the ones the runtime already created (`NODEFS`), not symlinked
  — a symlink onto a non-empty directory fails and leaves the tool with an
  empty filesystem, which is why `emcc` otherwise cannot see any input file;
* the clang driver cannot fork, so `tools/toolchain/clang-wrap.py` runs the
  assembler in-process for `.S` inputs — and it must pass `-filetype obj` to
  `-cc1as`, otherwise the assembler writes assembly **text** into the object
  file. That silently produced a `libc-mt.a` without `__set_thread_state`, and
  every `-pthread` link then failed with undefined thread symbols.

If a build with that toolchain fails to link with
`undefined symbol: __set_thread_state`, the cached multi-threaded libc was built
before the fix: delete `emcache/sysroot/lib/wasm32-emscripten/libc-mt.a` and
rebuild.

### Completely offline machines

`build.sh` needs only `em++`, `patch`, `cp`, `sed` and a POSIX shell. To build
without internet access, copy `assets/nn-1a298aa575a0.nnue` (98 MB) and a
prebuilt `engine/` from a machine that has them; the network is only needed at
runtime.

## 2. Build

```sh
cd 0.2
./scripts/build.sh
```

Expected tail of the output:

```
== variant relaxed (-msimd128 -mrelaxed-simd) ==
  [27/28] wasm_bridge.cpp
  [28/28] solace.cpp
linking engine/solace-relaxed.js + engine/solace-relaxed.wasm
-rw-r--r-- ... engine/solace-relaxed.js
-rwxr-xr-x ... engine/solace-relaxed.wasm
done.
```

A build takes about 10 minutes for both variants on two slow cores with the
npm-hosted toolchain, and considerably less with a normal emsdk.

Measured size, with the network kept out of the binary:

| file | bytes |
|---|---|
| `engine/solace.js` | 78 506 |
| `engine/solace.wasm` | 577 330 |
| `engine/solace-relaxed.js` | 78 530 |
| `engine/solace-relaxed.wasm` | 577 327 |

## 3. Compiler flags worth knowing

```
-O3 -std=c++17 -fno-exceptions -fno-rtti -DNDEBUG
-DUSE_POPCNT -DNNUE_EMBEDDING_OFF -DUSE_SLOPPY_ATOMICS -DNO_TABLEBASES
-DSOLACE_WASM -pthread -msimd128 [-mrelaxed-simd]
```

* `-DNNUE_EMBEDDING_OFF` keeps the network out of the binary; the loader writes
  it into the virtual filesystem instead. This is what keeps the wasm ~0.6 MB
  instead of ~100 MB.
* `-DNO_TABLEBASES` matches the upstream wasm build (no Syzygy in the browser).
* `-pthread` enables Emscripten threads: the engine searches on its own thread,
  so `go infinite` + `stop` behave like the desktop engine.
* `-msimd128` uses WebAssembly SIMD; `-mrelaxed-simd` additionally uses the
  relaxed-SIMD instructions.
* `-sINVOKE_RUN=0 -sEXIT_RUNTIME=0` let the loader fill the network buffer
  *before* `main()` runs (and parse it right after), then keep the runtime alive
  after `main()` returns.
* `-sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=1GB` reserve
  little and grow on demand. This matters on phones: a module that asks the
  browser for 256 MB of shared memory before doing anything is the difference
  between a page that loads and a tab that gets killed. The engine quickly grows
  the heap to hold the network and the hash; it never shrinks, so raise
  `INITIAL_MEMORY` only if you know the target.
* `-sEXPORTED_FUNCTIONS` includes `_solace_load_net` (patch 0004) and
  `-sEXPORTED_RUNTIME_METHODS` includes `HEAPU8`: the loader streams the network
  into the wasm heap through that view instead of writing a 98 MB file into the
  virtual filesystem.

### What the flags are worth, measured

`node tools/bench.mjs` runs Stockfish's own benchmark through the real loader.
The node count is fixed by the search itself, so it doubles as a parity check
and the run time is what the flags actually change. On the machine this was
measured on (2 shared vCPUs, Node 22):

| build | `bench 1` nodes | time | nodes/second |
|---|---|---|---|
| `simd` | 1 808 810 | 18 235 ms | 99 194 |
| `relaxed` | 1 808 810 | 17 504 ms | 103 336 |

So the relaxed-SIMD build is ~4 % faster with a bit-identical search, which is
why the loader prefers it. The same node count is also what the **native** build
of the same sources reports, so the wasm port does not change the search at all
— it only decides what the move comes out of.

Link-time optimisation was tried (`EXTRA_CFLAGS=-flto`) and abandoned: the LTO
link did not finish after 26 minutes with the wasm-hosted toolchain, so it is
not part of the shipped build.

## 4. Serving the page

```sh
node server.mjs         # http://localhost:8080/0.2/web/
```

Emscripten threads need `SharedArrayBuffer`, which browsers only expose to
cross-origin isolated pages. `server.mjs` sends:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

On a static host you must send the same headers. GitHub Pages cannot, but the
usual workaround is a service worker that injects them
(`coi-serviceworker`); without it the page reports that
`SharedArrayBuffer` is unavailable.

The page also needs `engine/*.wasm` to be served as `application/wasm`
(any normal static server does that).

## 5. Rebuilding after a change

| change | rebuild? |
|---|---|
| `src/cpp/*.cpp`, `patches/*`, `vendor/stockfish` | yes: `CLEAN=1 ./scripts/build.sh` |
| `src/*.js`, `web/*` | no, just reload the page |
| a newer Stockfish release | replace `vendor/stockfish`, refresh the patches (see docs/MODIFICATIONS.md) |

`scripts/build.sh` copies the patched tree to `scripts/work/` on every run, so a
patch edit is picked up immediately; only *object* caching needs `CLEAN=1`, and
only when flags change rather than sources.

## 6. Verifying a build

```sh
node tests/loader.mjs    # the JS loader: net handling, line splitting, parsing
node tests/run.mjs       # UCI, perft, stop, threads, MultiPV, self-play
node tests/web.mjs       # page assets, server headers, worker protocol
node tools/bench.mjs     # throughput + node parity
node tools/profile.mjs   # start-up phases, memory, bridge cost
```

All five run without a browser. `tests/run.mjs` checks move legality with the
independent JavaScript board model from `0.1.5`, so a broken build is caught
rather than "the engine answered something".

The test suite picks the same engine variant the page would, and honours
`SOLACE_VARIANT=simd` to force the fallback path:

```sh
SOLACE_VARIANT=simd node tests/run.mjs
```
