# How Solace 0.2 is put together

```
                 browser page (web/app.js)
                          │  UCI strings
                          ▼
              src/client.js  (SolaceClient)
                          │  postMessage
                          ▼
              src/worker.js  (Web Worker, module)
                          │
                 src/engine.js  (loader)
        ┌─────────────────┼────────────────────┐
        ▼                 ▼                    ▼
  dist/solace.js    dist/solace.wasm     assets/*.nnue
  (Emscripten       (Stockfish 19 +      (NNUE weights,
   glue)             wasm_bridge.cpp)     downloaded once)
```

## The layers, and why they exist

**`vendor/stockfish/`** — stock Stockfish 19. Never edited. Keeping it pristine
means an upgrade is "replace the folder, re-apply the patches" and the diff
against upstream is exactly `patches/`.

**`src/wasm/wasm_bridge.cpp`** — 30 lines of C++ inside the engine that expose
`solace_command()` to JavaScript. The engine has no idea a browser exists; it
parses the same UCI command lines as the desktop binary.

**`dist/solace.{js,wasm}`** — build output. `-sMODULARIZE` gives an ES module
factory; `-sINVOKE_RUN=0` means the loader controls when `main()` runs, which is
what allows the 98 MB network to be written into the virtual filesystem first.

**`src/engine.js`** — the only file that knows the wasm details: it fetches the
network, instantiates the module, writes `nn-1a298aa575a0.nnue` into the
Emscripten MEMFS, calls `main()`, frees the file, and exposes `send(cmd)`.
Runs unchanged in a browser, a worker and Node, so tests exercise the same code
the page does.

**`src/worker.js`** — keeps wasm out of the page's main thread. The engine also
searches on its own pthread, so the worker is free to receive `stop` while a
search is running.

**`src/client.js`** — promise-friendly UCI: `send`, `position`, `setOption`,
`go` (returns `bestmove` plus parsed info), `waitFor`, plus a small `info` line
parser.

**`web/`** — the page. It draws the board, applies moves and talks to the
client. For chess rules it imports `../0.1.5/src/core/position.js` and
`moves.js`, the board model of the pure-JavaScript engine: it already has 160
tests behind it, so the UI does not need a second move generator. Those files
are imported read-only; 0.1.5 is not modified.

**`server.mjs`** — static server that adds the two headers that make
`SharedArrayBuffer` available (Emscripten threads need it).

## Data flow of one move

1. The player clicks a square. `web/app.js` asks the 0.1.5 board model for the
   legal moves from that square and highlights them.
2. On a legal drop it plays the move locally (so the board reacts instantly) and
   sends `position fen <current position>` followed by `go movetime 1000`.
3. The worker forwards both lines to `solace_command()`.
4. Stockfish starts a search on its pthread and prints `info …` lines; the
   `print` callback turns them into `{type:'line'}` messages.
5. `bestmove e2e4` ends the search; the UI applies it against the same board
   model, which rejects it if it were illegal.

## Threading model

`-pthread` builds Stockfish with its normal thread pool. `Threads` is a real UCI
option (up to the usual limit), `go infinite` returns immediately and `stop`
interrupts the search — the behaviour GUIs expect. The price is that the page
must be cross-origin isolated, because WebAssembly shared memory needs
`SharedArrayBuffer`.

## Why the network is loaded at runtime instead of embedded

Embedding it with `--preload-file` makes `dist/solace.wasm` 100 MB, so every
visit downloads 100 MB even when the browser already has the file cached.
Loading it separately keeps the engine small, lets the browser cache the network
on its own, and shows a progress bar. `-sNNUE_EMBEDDING_OFF` is the switch that
makes the engine read the file from disk instead.
