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
| Strength | identical to Stockfish 19 with the same NNUE network and the same limits |
| Licence | GPLv3 (inherited from Stockfish) — see [docs/GPL.md](docs/GPL.md) |

## What is (and is not) different from Stockfish 19

Everything that makes Stockfish strong — search, evaluation, the NNUE network —
is stock. The changes are the minimum needed to ship it under this name and to
drive it from JavaScript:

1. the version string is `Solace 0.2` (`src/misc.cpp`),
2. `UCIEngine::command()` is split out of the stdin loop so a page can inject
   commands, and `main()` returns after initialisation instead of blocking on
   `stdin` (`src/uci.cpp`, `src/uci.h`, `src/main.cpp`),
3. a small new file `src/wasm/wasm_bridge.cpp` exports `solace_command()`.

The patches are in [`patches/`](patches) and are listed line by line in
[docs/MODIFICATIONS.md](docs/MODIFICATIONS.md), as the GPL requires.

## Quick start

```sh
cd 0.2

node build/fetch-net.mjs     # once: downloads the 98 MB NNUE network (verified)
./build/build.sh             # compiles dist/solace.js + dist/solace.wasm
node tests/run.mjs           # runs the test suite against the real wasm build
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
committing it, `build/fetch-net.mjs` downloads `nn-1a298aa575a0.nnue` from the
official Stockfish sources and verifies its SHA-256
(`1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`) — the same
hash the upstream `networks` repository publishes. If the official hosts are
unreachable the script falls back to carving the identical file out of the
official `stockfish` npm package and verifies the hash again.

## Layout

```
0.2/
├── build/build.sh        # copy vendor -> apply patches -> compile -> dist/
├── build/fetch-net.mjs   # download + verify the NNUE network
├── patches/              # every change made to Stockfish, as unified diffs
├── src/wasm/             # the only C++ file that is ours (command bridge)
├── src/                  # JavaScript loader, worker, page client
├── web/                  # playable browser UI (no build step, no dependencies)
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
* `dist/` is built output. The committed copy was produced with the toolchain
  described in docs/BUILD.md; rebuild it if you change anything under `src/` or
  `patches/`.
