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
node scripts/fetch-net.mjs     # downloads the 98 MB NNUE network (verified by SHA-256)
./scripts/build.sh             # needs Emscripten; produces both SIMD variants in engine/
node tests/run.mjs             # 16 UCI tests against the real wasm build
node tests/web.mjs             # page assets, server headers, worker protocol
node tools/bench.mjs           # nodes/second + node parity of the build
node cli.mjs                   # UCI on stdin/stdout
node server.mjs                # playable page on http://localhost:8080/0.2/web/
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
  src/cpp/            C++ that is ours: UCI bridge + tuning layer
  src/                JavaScript loader/worker/client
  web/                playable page
  engine/             built wasm (both SIMD variants), committed
  tools/              self-play match runner, benchmark, toolchain helpers
  scripts/ tests/ docs/
LICENSE         MIT licence of the 0.1.x engine
```

## Honest limitations

* Solace 0.1.5 is a handcrafted engine: its strength is club level, and the
  published Elo figures are measured self-play comparisons against earlier
  Solace versions, not against other engines.
* Solace 0.2 moves with Stockfish 19's search and evaluation, so its strength
  is Stockfish's. The work of this project is the WebAssembly port, the JS
  layer, the UCI wiring, the browser UI, a tuning layer with published
  self-play measurements (six variants tested, all worse than the upstream
  values, which therefore ship), a latency-adaptive time reserve and a small
  opening book. No stronger-than-Stockfish claim is made anywhere.
* The browser build of 0.2 needs `SharedArrayBuffer`, so the page must be served
  with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (the included `server.mjs` does
  this). Without those headers the page explains the problem instead of
  pretending to work.
