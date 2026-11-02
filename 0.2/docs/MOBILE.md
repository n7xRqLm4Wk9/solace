# Solace 0.2 on a phone

Solace 0.2 is a WebAssembly build of Stockfish 19. Stockfish's defaults were
chosen on desktops with unlimited time, 8–32 GB of RAM and a mains cable. A
mid-range Android phone (Snapdragon 4 Gen 2, 4–8 GB, Chrome) is different in
four ways that matter, and this document is about what was changed for them.

| | desktop Stockfish 19 | what a phone actually has |
|---|---|---|
| memory for the engine | 16 MB hash, network embedded | a tab budget of a few hundred MB, shared with the page and the 98 MB network |
| speed | millions of nodes/s | tens of thousands of nodes/s |
| speed *later in the game* | constant | drops 30–50 % when the phone heats up |
| "the answer is ready" | microseconds after the search stops | a task hop, a wasm call, sometimes a GC pause |

The goals were: as strong as possible on that hardware, as smooth as possible,
without giving up full UCI or the name.

## 1. Memory: the network is no longer copied twice

**Before.** The loader fetched the 98 MB `.nnue` into a JavaScript array, then
wrote it into Emscripten's in-memory filesystem, which keeps its own copy, and
the engine then read it back through that filesystem. At peak the same 98 MB
existed twice in RAM, the wasm heap was *reserved* at 256 MB before anything
happened, and the write itself cost 62 ms on the machine used below.

**Now.** Patch `0004-mobile-memory.patch` adds
`Network::load_from_memory()` / `Engine::load_network_from_memory()` and exports
them as `solace_load_net(ptr, size)`. The loader streams the download straight
into one buffer in the wasm heap — no JavaScript copy — and the engine parses it
from there, then the buffer is freed.

| | before | after |
|---|---|---|
| wasm heap reserved at start-up | 256 MB | 64 MB, grows on demand |
| copies of the network file at peak | 2 (JS array + in-memory filesystem) | 1 (a buffer in the wasm heap, freed after parsing) |
| filesystem write | 98 MB | none |
| JavaScript-side buffers after start-up | 190 MB | 5–24 MB |

Measured with `node 0.2/tools/profile.mjs` on the same machine and network file;
see the table at the end of this file.

## 2. Start-up: the network is cached, and the server lets it be

A returning visitor used to download 98 MB again, because the server sent
`Cache-Control: no-cache` for every file. Now:

* `server.mjs` serves `*.nnue` as `max-age=31536000, immutable` (the file name
  contains its content hash, so this is safe) and `*.wasm`/`*.js` with a short
  `max-age` plus an `ETag`, so a rebuild is picked up with one 304 per file;
* the loader additionally stores the network in **Cache Storage**
  (`caches.open('solace-net-v1')`), which survives even when the HTTP cache
  evicts a file this large, and reads it back as a stream.

Net effect on a phone: first visit downloads 98 MB once; every later visit
starts from disk.

## 3. Speed: flags and variants

* Two SIMD builds are produced. `src/config.js` validates a one-function
  relaxed-SIMD module and loads `engine/solace-relaxed.*` when the browser
  supports it, otherwise `engine/solace.*`. Relaxed SIMD has been in Chrome for
  Android since 2023; the check means the older variant is never a broken page.
* `-O3`, `-msimd128`, `-mbulk-memory`, `-msign-ext`, `-mnontrapping-fptoint`
  (the last three are Emscripten defaults for wasm32) and `-sINITIAL_MEMORY`
  small enough to grow lazily.
* Link-time optimisation was tried and dropped: the LTO link did not finish in
  26 minutes with the wasm-hosted toolchain used here (see `docs/BUILD.md`), and
  it is not worth shipping a build nobody else can reproduce.

The node count of `bench 1` is 1,808,810 in every build and on every platform:
these flags change *how fast* the same search runs, never what it searches.

## 4. The JS ↔ wasm bridge

* **Output is batched.** A search prints an `info` line per depth (and per PV
  line with MultiPV). Each one used to be its own `postMessage` from the engine
  worker to the page — thousands of main-thread wake-ups per game. The worker
  now collects lines and posts them every ~30 ms, and flushes immediately on a
  terminating line (`bestmove`, `readyok`, `uciok`) so nothing waits.
* **The page paints once per frame.** The eval readout is written from a
  `requestAnimationFrame` callback with the latest info line, instead of on
  every line.
* **The line buffer is bounded.** `SolaceClient` kept every line it had ever
  seen in an array; on a phone playing a long game, or after one `bench`, that
  is a slow leak. It now keeps the last 400.

## 5. Time management and heat

Two independent controllers, both measured rather than guessed:

**`web/overhead.js` — how late this browser answers.** The page times every
`go movetime X` call, keeps the worst of the last twelve, and sets
`Move Overhead` to 1.5× that (clamped 50–500 ms). Stockfish's default of 10 ms
was measured on native binaries; a browser adds a task hop, a wasm call boundary
and garbage collection. A fast desktop settles near the floor; a phone with
janky scheduling raises it and stops losing moves on time.

**`web/thermal.js` — how much slower the phone has become.** The engine reports
nodes/second in every `info` line. The guard remembers the best rate it has
seen (decaying very slowly) and compares the current median to it:

| current / best | state | think time | extra overhead |
|---|---|---|---|
| ≥ 75 % | cool | 100 % | 0 |
| 55–75 % | warm | 80 % | +60 ms |
| < 55 % | throttling | 55 % | +120 ms |

The point is not to make the engine weaker: at a fixed *wall clock* the phone
already delivers fewer nodes when hot, and the browser itself gets slower, so a
search that keeps asking for the full second increasingly overruns and stutters
the page. Shortening the request keeps the number of moves per minute constant
instead of letting the game grind to a halt. The floor is 120 ms, and the guard
recovers as soon as the device does.

## 6. Backgrounding

A hidden tab is not a paused engine: the search keeps running on its worker
thread, heating the phone for a move nobody is looking at, and when the tab
comes back the browser has throttled its timers so much that the first answer
arrives late. Now:

* `visibilitychange` → the pending search is stopped outright (`stop`), so no
  battery is spent on it;
* on return, the move is re-issued and `Move Overhead` is raised by 150 ms for
  the first move back, because the timers were throttled.

## 7. Device-sized defaults

`deviceProfile()` in `src/config.js` reads `navigator.deviceMemory` and
`navigator.hardwareConcurrency` (and `(pointer: coarse)`, for phones that report
neither) and picks:

| device | hash | think time | threads |
|---|---|---|---|
| ≤ 2 GB | 4 MB | 0.5 s | 1 |
| mid-range (4 GB, or unknown) | 8–16 MB | 1 s | 1 |
| ≥ 8 GB and 8 cores | 32 MB | 1.5 s | 1 |

The hash is deliberately small: at 50 000 nodes/s a one-second search visits
about 50 000 nodes, and 4 MB of hash holds far more than that, so a bigger table
would only cost memory. One search thread is right on a phone — a second one
competes with the page for the same cores and the same thermal budget.

The page says which profile it chose, under the board, so nothing is silently
different from the desktop defaults.

## 8. What was *not* done, and why

* **A smaller network.** Stockfish 19's evaluation architecture is fixed by the
  engine sources and the network it was released with (`nn-1a298aa575a0.nnue`).
  A smaller or faster network would mean training a new one, which is neither
  reproducible here nor part of "a fork of Stockfish 19". What *is* done is to
  stop paying for the same network twice, and to stop re-downloading it.
* **Fewer threads than one.** Already the default.
* **A single-threaded build without `SharedArrayBuffer`.** It would let the page
  run on hosts that cannot send COOP/COEP headers, but a search on the main
  thread blocks the page and makes `stop` impossible, which is worse than the
  current explicit error message. `server.mjs` sends the headers; any static
  host must do the same (`docs/BUILD.md`).
* **Auto-detecting throttling from CPU temperature.** Not exposed to the web.
  Nodes/second is the observable that matters, and it is what the engine
  reports anyway.

## Measurements

Fill-in table for `tools/profile.mjs` and `tools/bench.mjs` on the same machine,
same network file, same process settings. Node is not a phone, but the ratios
(heap per copy of the network, milliseconds per phase) are properties of the
build.

Both builds: Node 22.22.3, 2 vCPU container, the 98,511,183-byte network file
(93.9 MiB), `Hash 16`, `Threads 1`; the memory figures are MiB. Two runs each, ranges are the two runs — the spread is machine
noise, not build differences.

| | before (committed build) | after (this build) |
|---|---|---|
| wasm memory reserved at start-up | 256 MB | 64 MB |
| wasm memory committed after load | not readable¹ | 429.6 MB |
| copies of the network file at peak | 2 | 1 |
| JavaScript buffers (Node `external`) | 189.9 MB | 4.9–23.9 MB |
| filesystem write of the network | 93.9 MB | none |
| start-up to first engine output | 721–795 ms | 685–734 ms |
| - instantiate the module | 14–16 ms | 14–16 ms |
| - read the network | 138–154 ms | 3–4 ms (streamed lazily) |
| - move it into wasm | 62 ms (filesystem write) | 110–124 ms (download+copy) |
| - parse the network | — (inside `main()`) | 351–386 ms |
| - `main()` | 547 ms | 225–246 ms |
| peak RSS, whole process | 483–485 MB | 524–526 MB |
| `bench 1` nodes | 1,808,810 | 1,808,810 |
| `bench 1` nodes/second, SIMD | 70,335–72,957 | 70,979–71,816 |
| `bench 1` nodes/second, relaxed SIMD | 72,421–73,110 | 71,997–72,214 |

¹ The old build does not export `HEAPU8`, which is also why it cannot load the
network from memory.

What the numbers say, including the part that is not an improvement:

* **Start-up is ~10 % faster** (721–795 → 685–734 ms): the 93.9 MB filesystem
  write disappears and the network is parsed by the engine instead of being
  read back out of a JavaScript filesystem. `bench 1` is bit-identical before
  and after (1,808,810 nodes), so the search did not change.
* **Peak RSS is ~40 MB *higher* in Node.** That is honest and expected: the old
  build kept the download in JavaScript (`external` 190 MB) and released it
  early; the new build's staging buffer lives in the wasm heap, and a wasm heap
  cannot be shrunk, so the freed 94 MB stays committed. In exchange the
  JavaScript side — the part the browser's tab budget and GC pressure care
  about — drops by ~170 MB, and the peak number of copies of the file goes from
  two to one.
* **Node is not a phone.** A browser also holds the `fetch` response and its own
  copy of the file, which is exactly the duplication the memory path removes;
  that part cannot be measured here (no browser in the sandbox) and is not
  claimed as a measured win.
* **Throughput is unchanged** within noise on both variants. The relaxed build
  is not faster on this x86 host; relaxed SIMD is about not being *slower* on
  phones whose `pmaddubsw`/`pmaddwd` sequences are expensive. `web/app.js` picks
  the relaxed build when the browser reports support, the portable SIMD build
  otherwise, so a phone never downloads a binary it cannot run.
