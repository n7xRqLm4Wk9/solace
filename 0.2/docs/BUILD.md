# Building Solace 0.2

Solace 0.2 is Stockfish 19 compiled to WebAssembly. The build is one shell
script plus a network download; nothing else is installed into the system.

```sh
cd 0.2
node build/fetch-net.mjs
./build/build.sh
```

`build/build.sh` never edits `vendor/stockfish`: it copies the engine to
`build/work/`, applies `patches/*.patch`, copies `src/wasm/*` in, compiles every
translation unit and links `dist/solace.js` + `dist/solace.wasm`.

Useful switches:

| variable | effect |
|---|---|
| `EMXX=/path/to/em++` | use a specific Emscripten |
| `NO_SIMD=1` | build without `-msimd128` (slower, for very old runtimes) |

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
`dist/` files can be copied to any other machine.

### Completely offline machines

`build.sh` needs only `em++`, `patch`, `cp`, `sed` and a POSIX shell. To build
without internet access, copy `assets/nn-1a298aa575a0.nnue` (98 MB) and a
prebuilt `dist/` from a machine that has them; both are only needed at runtime.

## 2. Build

```sh
cd 0.2
./build/build.sh
```

Expected tail of the output:

```
  [26/27] score.cpp
  [27/27] memory.cpp
linking dist/solace.js + dist/solace.wasm
-rw-r--r-- ... dist/solace.js
-rw-r--r-- ... dist/solace.wasm
done.
```

The wasm binary is ~1.5 MB; the network is loaded separately at runtime.

## 3. Compiler flags worth knowing

```
-O2 -std=c++17 -fno-exceptions -fno-rtti -DNDEBUG
-DUSE_POPCNT -DNNUE_EMBEDDING_OFF -DUSE_SLOPPY_ATOMICS -DNO_TABLEBASES
-DSOLACE_WASM -pthread -msimd128
```

* `-DNNUE_EMBEDDING_OFF` keeps the network out of the binary; the loader writes
  it into the virtual filesystem instead.
* `-DNO_TABLEBASES` matches the upstream wasm build (no Syzygy in the browser).
* `-pthread` enables Emscripten threads: the engine searches on its own thread,
  so `go infinite` + `stop` behave like the desktop engine.
* `-msimd128` uses WebAssembly SIMD. Drop it with `NO_SIMD=1` for runtimes
  without SIMD support.
* `-sINVOKE_RUN=0 -sEXIT_RUNTIME=0` let the loader write the network file
  *before* `main()` runs, then keep the runtime alive after `main()` returns.

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

The page also needs `dist/solace.wasm` to be served as `application/wasm`
(any normal static server does that).

## 5. Rebuilding after a change

| change | rebuild? |
|---|---|
| `src/wasm/*.cpp`, `patches/*`, `vendor/stockfish` | yes: `./build/build.sh` |
| `src/*.js`, `web/*` | no, just reload the page |
| a newer Stockfish release | replace `vendor/stockfish`, refresh the patches (see docs/MODIFICATIONS.md) |

## 6. Verifying a build

```sh
node tests/run.mjs       # UCI, perft, stop, threads, MultiPV, self-play
node cli.mjs bench 1     # a quick benchmark
```

The test suite checks move legality with the independent JavaScript board model
from `0.1.5`, so it can actually catch a broken build rather than only checking
that the engine answers something.
