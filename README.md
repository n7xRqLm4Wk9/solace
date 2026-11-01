# Solace

Two chess engines named **Solace**, in one repository:

| | [`0.1.5/`](0.1.5) | [`0.2/`](0.2) |
|---|---|---|
| what | complete chess engine written from scratch in plain JavaScript | Stockfish 19 compiled to WebAssembly |
| code | own move generation, evaluation and search — no engine source, no libraries, no dependencies | vendored Stockfish `sf_19` + small GPL patches |
| runs in | Node.js, any UCI GUI, the browser, Android | the browser (Wasm + SIMD + threads), Node.js |
| strength | club level, ~1,800 Elo vs. its own previous versions measured over 600 games | identical to Stockfish 19 |
| licence | MIT | GPLv3 (inherited from Stockfish) |
| tests | `node tests/run.js` → 160 passing | `node tests/run.mjs` → UCI, perft, threads, self-play |

Both speak **UCI**, are called **Solace** in the `id name` line, and can be
played in a browser. The 0.1.5 engine is kept exactly as it was released —
`0.2/` does not touch it (the browser UI of 0.2 only imports its board model to
draw the position).

---

## 0.1.5 — the pure-JavaScript engine

```sh
cd 0.1.5
node tests/run.js        # 160 tests, ~8 s
node cli.js play         # play in the terminal
node cli.js              # UCI on stdin/stdout
node tools/serve.js      # browser UI on http://localhost:3000
```

Details, measured perft/bench numbers and the honest strength estimate:
[`0.1.5/README.md`](0.1.5/README.md) and [`0.1.5/docs/STRENGTH.md`](0.1.5/docs/STRENGTH.md).

## 0.2 — Stockfish in WebAssembly

```sh
cd 0.2
node build/fetch-net.mjs     # downloads the 98 MB NNUE network (verified by SHA-256)
./build/build.sh             # needs Emscripten; produces dist/solace.js + .wasm
node tests/run.mjs
node cli.mjs                 # UCI on stdin/stdout
node server.mjs              # playable page on http://localhost:8080/0.2/web/
```

Details, build instructions (including Termux/Android), the list of every change
made to Stockfish and the licensing story:
[`0.2/README.md`](0.2/README.md), [`0.2/docs/BUILD.md`](0.2/docs/BUILD.md),
[`0.2/docs/MODIFICATIONS.md`](0.2/docs/MODIFICATIONS.md),
[`0.2/docs/GPL.md`](0.2/docs/GPL.md).

## Repository layout

```
0.1.5/          pure-JavaScript Solace (MIT) — unchanged since its release
  src/ cli.js tests/ tools/ web/ docs/
0.2/            Solace 0.2 = Stockfish 19 in WebAssembly (GPLv3)
  vendor/stockfish/   pristine upstream sources
  patches/            every change, as unified diffs
  src/                C++ bridge + JavaScript loader/worker/client
  web/                playable page
  build/ tests/ docs/ dist/
LICENSE         MIT licence of the 0.1.x engine
```

## Honest limitations

* Solace 0.1.5 is a handcrafted engine: its strength is club level, and the
  published Elo figures are measured self-play comparisons against earlier
  Solace versions, not against other engines.
* Solace 0.2 is Stockfish — its strength is Stockfish's, not something this
  project earned. The work here is the WebAssembly port, the JS layer, the UCI
  wiring and the browser UI.
* The browser build of 0.2 needs `SharedArrayBuffer`, so the page must be served
  with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (the included `server.mjs` does
  this). Without those headers the page explains the problem instead of
  pretending to work.
