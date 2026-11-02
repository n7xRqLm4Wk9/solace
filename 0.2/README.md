# Solace 0.2 — Stockfish compiled to WebAssembly

Solace 0.2 is the same idea as Solace 0.1.5 — a chess engine named **Solace**,
written in the languages of the web — but with a completely different engine
underneath: it is a **fork of [Stockfish](https://github.com/official-stockfish/Stockfish)
release `sf_19`**, compiled to WebAssembly with Emscripten.

The pure-JavaScript engine from 0.1.x is untouched in [`../0.1.5`](../0.1.5);
this folder is self-contained and does not import it at runtime (only the
browser UI reuses its board model to draw the position — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

| | |
|---|---|
| Engine | Stockfish `sf_19` (2026-09-05), vendored in `vendor/stockfish` |
| Target | `wasm32` + SIMD + pthreads, built with Emscripten |
| Name | UCI `id name Solace 0.2` |
| Interface | full UCI, plus the usual Stockfish debug commands (`d`, `eval`, `bench`, `export_net`, `perft`) |
| Strength | the search of Stockfish 19 (identical `bench` node counts), plus a tuning layer whose preset was chosen by self-play |
| Throughput | WebAssembly SIMD, ~100 000 nodes/s single-threaded in Node 22 on 2 shared vCPUs; the relaxed-SIMD build is ~4 % faster |
| Licence | GPLv3 (inherited from Stockfish) — see [docs/GPL.md](docs/GPL.md) |

## What is (and is not) different from Stockfish 19

Everything that makes Stockfish strong — search, evaluation, the NNUE network —
is stock. The changes are the minimum needed to ship it under this name and to
drive it from JavaScript:

1. the version string is `Solace 0.2` (`src/misc.cpp`),
2. `UCIEngine::command()` is split out of the stdin loop so a page can inject
   commands, and `main()` returns after initialisation instead of blocking on
   `stdin` (`src/uci.cpp`, `src/uci.h`, `src/main.cpp`),
3. a small new file `src/cpp/wasm_bridge.cpp` exports `solace_command()`,
4. a tuning layer (`src/cpp/solace.cpp`, patch `0003`) exposes the search and
   evaluation parameters Solace re-tunes for browser time controls, and its
   preset is measured by self-play — see [docs/TUNING.md](docs/TUNING.md),
5. the page measures how late this browser answers and raises the engine's
   `Move Overhead` to match (`web/overhead.js`), instead of assuming the native
   10 ms reserve,
6. the page plays a small opening book so consecutive games differ
   (`web/book.js`),
7. two SIMD builds are produced and the faster one is chosen at load time
   (`src/config.js`).

The tuning layer was used to play four 120-game matches against the upstream
constants (LMR ×1.15, LMR ×0.85, pruning ×1.10, pruning ×0.90). **All four
measured neutral or worse**, so the shipped preset keeps Stockfish's numbers and
the results are published rather than the losers being quietly dropped — see
[docs/TUNING.md](docs/TUNING.md).

The patches are in [`patches/`](patches) and are listed line by line in
[docs/MODIFICATIONS.md](docs/MODIFICATIONS.md), as the GPL requires.

## Quick start

```sh
cd 0.2

node scripts/fetch-net.mjs     # once: downloads the 98 MB NNUE network (verified)
./scripts/build.sh             # compiles both variants into engine/ (already committed)
node tests/run.mjs             # 16 UCI tests against the real wasm build
node tests/web.mjs             # page assets, server headers, worker protocol
node tools/bench.mjs           # throughput + node parity
node server.mjs              # http://localhost:8080/0.2/web/  -> play in a browser
```

The command line works too:

```sh
node cli.mjs                        # interactive UCI over stdin/stdout
node cli.mjs "go depth 12"          # or a single command
echo -e "uci\nisready\nquit" | node cli.mjs
```

### Requirements

* Node.js 18 or newer (only for the build helper, the server and the tests).
* Emscripten (`em++` 3.1.50+). If you already have emsdk sourced, the build
  script just works.
* ~2 GB of free RAM and ~1 GB of disk for the build; a phone browser needs
  ~250 MB of free RAM to run the engine.

Full instructions, including installing Emscripten without root and building on
an Android phone through Termux, are in [docs/BUILD.md](docs/BUILD.md).

## Why the network is not in the repository

The NNUE file is 98 MB and the wasm build needs it at runtime. Instead of
committing it, `scripts/fetch-net.mjs` downloads `nn-1a298aa575a0.nnue` from the
official Stockfish sources and verifies its SHA-256
(`1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`) — the same
hash the upstream `networks` repository publishes. If the official hosts are
unreachable the script falls back to carving the identical file out of the
official `stockfish` npm package and verifies the hash again.

## Layout

```
0.2/
├── scripts/build.sh        # copy vendor -> apply patches -> compile -> dist/
├── scripts/fetch-net.mjs   # download + verify the NNUE network
├── patches/              # every change made to Stockfish, as unified diffs
├── src/cpp/              # the C++ that is ours: command bridge + tuning layer
├── src/                  # JavaScript loader, worker, page client
├── web/                  # playable browser UI (no build step, no dependencies)
├── engine/               # built wasm + glue, committed so the page runs without a compiler
├── tools/match.mjs       # self-play match runner used for tuning
├── tools/bench.mjs       # nodes/second + node-parity check of a build
├── tools/toolchain/      # scripts that make the npm-hosted Emscripten usable
├── tests/run.mjs         # UCI / perft / stop / multi-thread / self-play tests
├── cli.mjs               # UCI front end for Node
├── server.mjs            # static server with the headers wasm threads need
├── vendor/stockfish/     # pristine Stockfish sf_19 (GPLv3)
└── docs/                 # build, architecture, modifications, licence
```

## Known limitations

* **Cross-origin isolation is required.** The engine uses Emscripten pthreads,
  so the browser needs `SharedArrayBuffer`, which is only available to pages
  served with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. `server.mjs` sends them; a
  static host must be configured the same way (docs/BUILD.md explains the
  GitHub Pages workaround). Without them the page shows an explicit error
  instead of silently failing.
* **No tablebases.** Syzygy support is compiled out (`NO_TABLEBASES`), exactly
  as in the upstream WebAssembly build.
* The network is downloaded at startup; on a slow connection the first load
  takes a while (the page shows a progress bar). It is cached by the browser.
* `engine/` is built output, committed so the page runs without installing a
  compiler. It was produced with the toolchain described in docs/BUILD.md;
  rebuild it if you change anything under `src/` or `patches/`.
* The engine is single-threaded in practice: `Threads` is 1, because a second
  search thread in a page competes with the UI and the wasm build gains little
  from it. `Threads` is a working UCI option if you want to experiment.
* No strength claim is made against Stockfish 19 at equal thinking time. The
  tuning matches were too small to resolve small differences, and none of them
  found a large one.
