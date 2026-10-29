# SOLACE ⇄ Chess.fish integration handoff

This document describes **only what exists and has been tested** in this
repository. Nothing here claims any knowledge of Chess.fish's source, protocol or
architecture: the Chess.fish archive was not available, so every statement about
Chess.fish below is an open question, not an assumption.

Measured 2026-10-29 on Linux x86-64, Node.js v22.22.3.

---

## 1. Audit: what SOLACE actually is

### Entry points (verified by reading the source and by running them)

| entry point | runtime | what it does |
| --- | --- | --- |
| `cli.js` with no arguments (or `uci`) | Node ≥18 | Reads UCI commands from stdin, writes UCI to stdout (`readline`, one command per line) |
| `cli.js play` | Node | Human-friendly board; drives the same `UciEngine` object in-process |
| `web/index.html` + `web/engine.worker.js` | Browser | The page spawns a **module Web Worker**; the worker hosts `UciEngine` and forwards UCI lines |
| `import { UciEngine } from 'src/uci/uci.js'` | any JS host | In-process use: `new UciEngine({ output })`, `handleLine(cmd)` |
| `import { Searcher } from 'src/search/search.js'` | any JS host | Direct search calls without the UCI layer |
| `import { Position } from 'src/core/position.js'` | any JS host | Rules, FEN, move generation |
| `src/tools/match.js`, `selfplay.js`, `bench.js` | Node | Development tools (match runner needs `child_process`) |

`package.json` declares `"type": "module"`, `node >= 18`, no dependencies, and a
`bin` entry `solace → ./cli.js`.

### Files

* **Engine (runtime agnostic, no Node APIs):** `src/core/*`, `src/eval/*`,
  `src/search/*`, `src/uci/uci.js`, `src/tools/{bench,openings,selfplay}.js`
  (only `selfplay`'s logging uses `console`, nothing Node-specific).
  Verified: `grep` finds **zero** `node:` imports and zero uses of `process`,
  `require`, `Buffer` or `__dirname` in `src/` and `web/`.
* **Node-only:** `src/tools/match.js` (`node:child_process`, `node:readline`),
  `tools/serve.js` (`node:http`, `node:fs`), `tools/gen-magics.js`,
  `tools/uci-client.js`.
* **Tests:** `tests/*.test.js` + `tests/harness.js` (Node only, no framework).
* **Docs:** `README.md`, `docs/ARCHITECTURE.md`, `docs/STRENGTH.md`,
  `docs/ANDROID.md`, this file.
* **Size:** `src/` is ~220 KB and 5 058 lines of JavaScript; `web/` adds ~40 KB
  (38-line worker + page/CSS). No binary assets; the only generated file is the
  7.7 KB magic-number table (`src/core/magics.js`).

### How positions go in and moves come out

The only interface the search exposes to the outside world is **UCI text**:

```
in : position fen <6 fields> [moves <m1> <m2> ...]      (or: position startpos ...)
out: info depth 12 seldepth 24 multipv 1 score cp 34 nodes 152340 nps 450000
     hashfull 12 time 338 pv e2e4 e7e5 g1f3
in : go movetime 500
out: bestmove e2e4 ponder e7e5
```

Inside the process the position is a `Position` object (`src/core/position.js`);
`UciEngine.cmdPosition()` parses the command, loads the FEN, replays the move list
with `position.parseMove()` (which only accepts **legal** moves and handles
`e7e8q` / `e7e8n` / `e7e8r` / `e7e8b`, upper or lower case), and stores it.
`UciEngine.cmdGo()` builds a limits object, creates a `SearchSession` and runs one
iterative-deepening iteration per event-loop turn, so `stop`/`quit` stay
responsive without threads. `bestmove` is emitted exactly once per search.

Nothing in the engine depends on a GUI, a file system, environment variables or a
terminal. The search never mutates the caller's position (it searches a clone).

---

## 2. UCI support: what SOLACE does and does not do

SOLACE **already spoke UCI** before this task (the protocol handler in
`src/uci/uci.js` predates it and is used by `play`, the browser UI and the match
tool). It was audited here, extended where it deviated from the specification, and
covered by new tests.

### Commands

| command | status | notes |
| --- | --- | --- |
| `uci` | ✅ | `id name SOLACE 1.0.0`, `id author`, 4 `option` lines, `uciok` |
| `isready` | ✅ | `readyok` immediately (search is single-threaded and interruptible) |
| `ucinewgame` | ✅ | clears hash + killer/history/countermove tables, cancels a running search, resets to the start position |
| `position startpos [moves ...]` | ✅ | |
| `position fen <fen> [moves ...]` | ✅ | rejecting malformed FENs and illegal moves with an `info string` and keeping the previous position |
| `go depth N` / `nodes N` / `movetime N` | ✅ | |
| `go wtime … btime … winc … binc … movestogo …` | ✅ | soft/hard budgets with `Move Overhead` headroom |
| `go infinite` | ✅ | runs until `stop` |
| `go searchmoves …` | ✅ | **new**: restricts the root moves; illegal/absent moves fall back to a full search |
| `go ponder` + `ponderhit` | ⚠️ approximate | starts an infinite search; `ponderhit` stops it and plays the best move found so far |
| `go mate N` | ⚠️ ignored | parsed and treated as an unlimited search |
| `stop` | ✅ | between iterations; never mid-iteration, so the position is never corrupted; exactly one `bestmove` |
| `quit` | ✅ | emits the pending `bestmove` if a search is running, then exits 0 |
| `setoption name Hash value N` | ✅ | 1–512 MB |
| `setoption name Move Overhead value N` | ✅ | 0–5000 ms |
| `setoption name VerifyMoves value true` | ✅ | debug: cross-checks attack detection with an independent scanner |
| `setoption name Clear Hash` | ✅ | button |
| `debug on/off` | ✅ | **new**: echoes the position after `position` and reports ignored commands |
| `register` | ✅ ignored | the engine has no registration |
| unknown commands / unknown options | ✅ ignored silently | **changed**: earlier versions printed `info string unknown command`, which is noise for a GUI |
| `d`, `eval`, `perft`, `bench`, `help` | ➕ extensions | not part of UCI; harmless, but a strict client should ignore unknown `info string` lines |

### Not supported (documented, not hidden)

* MultiPV > 1 (every `info` line says `multipv 1`).
* Real pondering (see above). Matches should run with pondering disabled.
* `go mate N` as a mate-search limit.
* No opening book, no tablebases, no Syzygy/Gaviota probing.
* The engine **never claims draws**: it returns `bestmove 0000` when there is no
  legal move (checkmate or stalemate); the rules of repetition/fifty-move/
  insufficient material are used inside the search, but the game result is the
  client's decision.

### Protocol hygiene details a client can rely on

* Every search produces **exactly one** `bestmove` line, including after `stop`,
  after `quit`, and for positions with no legal moves (`bestmove 0000`).
* `info depth …` lines are only sent for **completed** iterations, so `score` and
  `pv` always belong together and are always from a finished depth.
* Output is line-oriented ASCII, flushed per line (`process.stdout.write` in the
  CLI, `postMessage` per line in the worker). No carriage returns.
* `bestmove` may carry `ponder <move>`; clients that do not ponder can ignore the
  rest of the line.

---

## 3. Runtime targets and their differences

Three ways to run the same engine exist. They differ **only in transport**; the
protocol and the search are identical.

| target | transport | start-up | needs |
| --- | --- | --- | --- |
| **Node child process** (what a desktop GUI/Chess.fish server would use) | stdin/stdout lines | `node cli.js` (measured: 120–134 ms to `uciok`, table build included) | Node ≥18 on the host |
| **Web Worker** (what a browser page would use) | `worker.postMessage({cmd})` → worker → `{type:'line', line}` messages | worker import | a browser that supports module workers (all current Chromium/Firefox/Safari) |
| **In-process** (same JS runtime, no process/worker) | direct function calls | none | importing ES modules |

Verified: the worker module contains **no Node API**, and driving it through a
fake `self` object (the way `web/app.js` does) produces `uciok`, `readyok` and a
legal `bestmove`.

Consequences:

* If Chess.fish runs in a **browser**, it must not spawn a process; it should load
  `src/uci/uci.js` in a worker (see §4.2). No `SharedArrayBuffer`, no threads.
* If Chess.fish runs on a **server in Node**, the simplest and most robust
  integration is the child-process route (§4.1) — it is exactly what the match
  runner and `tools/uci-client.js` already do.
* If Chess.fish is written in **another language** (Python, Rust, Go, …), only the
  child-process route applies: no FFI, no bindings, just a pipe.

---

## 4. Integration recipes (all three verified here)

### 4.1 Node / any language: child process

```js
import { spawn } from 'node:child_process';
const engine = spawn('node', ['/path/to/solace/cli.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (line) => engine.stdin.write(line + '\n');

send('uci');                                  // wait for "uciok"
send('isready');                              // wait for "readyok"
send('position startpos moves e2e4 e7e5');    // or: position fen <fen> moves ...
send('go movetime 500');
// on a line starting with "bestmove": use token[1], then send "stop"/next position
send('quit');
```

A runnable 120-line version of this is `tools/uci-client.js`:

```sh
node tools/uci-client.js                        # one move from the start position
node tools/uci-client.js --fen "<FEN>" --movetime 500
node tools/uci-client.js --moves "e2e4 e7e5" --depth 4
```

It also exports `connect(command, onLine)` for reuse.

### 4.2 Browser: module Web Worker

```js
const worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }) => {
  if (data.type === 'line') handleUciLine(data.line);   // exactly the UCI text
  else if (data.type === 'error') console.error(data.message);
};
worker.postMessage({ cmd: 'uci' });
worker.postMessage({ cmd: 'position startpos moves e2e4' });
worker.postMessage({ cmd: 'go movetime 500' });
```

`web/engine.worker.js` is 40 lines and can be copied verbatim into another
project; it only needs the `src/` tree next to it (relative ES-module imports).
The worker must be served over HTTP(S) — browsers refuse ES modules on `file://`.

### 4.3 Same runtime: in-process

```js
import { UciEngine } from './src/uci/uci.js';
const engine = new UciEngine({ output: (line) => route(line) });
engine.handleLine('position startpos');
engine.handleLine('go depth 8');       // output arrives through the callback
```

or, without the protocol at all:

```js
import { Position } from './src/core/position.js';
import { Searcher } from './src/search/search.js';
const position = new Position().setFen(fen);
const result = new Searcher({ hashMB: 32 }).go(position, { movetime: 1000 });
// result = { bestMove, ponderMove, pv, score, mate, depth, nodes, nps, … }
```

---

## 5. What was tested for this handoff

`node tests/run.js` → **160 passed, 0 failed** (~8 s). Per suite: movegen 59,
fen 9, eval 12, draw 13, search 15, uci 26, uci-process 10, tools 8, web 8.
Relevant for this handoff:

* `tests/uci.test.js` (26 tests, the suite also picks up the process suite when
  filtered by "uci") — handshake, `isready`, options and bad option
  values, `position startpos` / `position fen` / `position … moves …`, promotions
  (queen and underpromotion, upper- and lower-case), the fifty-move and
  mate/stalemate cases, `stop`, immediate `stop`, double `stop`, `ponderhit`,
  `go nodes`, `go` without limits, `searchmoves` (single, multiple, illegal-only,
  promotion), `debug` echo, ignored unknown commands, `quit`, `ucinewgame`;
* `tests/uci-process.test.js` (10 tests, **new**) — the same protocol over a real
  `node cli.js` child process: handshake, startpos, FEN + moves, promotion,
  `stop`, `bestmove 0000` for mate/stalemate, `movetime` budget, pipelined
  `ucinewgame/position/go`, exit code 0 after `quit` (idle and mid-search), and
  40 plies of engine-vs-engine moves every one of which was validated as legal
  with the rules module.

Not tested / not possible to test here:

* **Anything involving Chess.fish** — no source, no binary, no protocol spec.
* A real chess GUI (no GUI is installed in this environment).
* Stockfish matches (not installed; see `docs/STRENGTH.md`).
* Mobile browsers (no device in this environment).
* Long-run stability beyond the ~60-ply sessions in the tests.

---

## 6. What Chess.fish integration will require

**If Chess.fish expects a UCI engine as a subprocess** (most common for a
desktop/web-server app): nothing needs to change in SOLACE. Register:

```
name:     SOLACE 1.0.0
command:  node /absolute/path/to/solace/cli.js
protocol: UCI
options:  Hash (16), Move Overhead (30), VerifyMoves (false), Clear Hash
```

**If Chess.fish is a browser app**: copy `src/` and `web/engine.worker.js`, export
`src/` over its static file host, and instantiate the worker as in §4.2. If it
already has its own worker, copy the 40-line `engine.worker.js` body into it.

**If Chess.fish expects an engine library/FFI**: not supported without new work —
SOLACE is JavaScript. The in-process API (§4.3) is the closest thing.

### Files I need from Chess.fish (when you can upload them)

In priority order, most useful first:

1. **The engine interface layer** — whatever code spawns or embeds a chess
   engine, e.g. `engine.*`, `uci.*`, `worker.*`, `chess-engine.*`, or a
   `Stockfish`-related wrapper. This decides whether we go subprocess or worker.
2. **The board/game-state model** — how Chess.fish represents a position and
   move list (FEN? its own format? SAN or UCI moves?). This decides whether we
   need a conversion shim between its move type and UCI strings.
3. **The build/run description** — `package.json`, `vite.config.*`,
   `webpack.config.*`, `requirements.txt`/`Cargo.toml`, Dockerfile, README, or
   however it declares its runtime. This tells us whether a subprocess is even
   possible in its deployment target (a static browser build cannot spawn
   processes; a Node/Electron/desktop app can).
4. **The exact place where the opponent/engine is configured** — settings page,
   config file, environment variable, or hard-coded path.
5. Optionally: any existing engine protocol documentation, and one example game
   record so the move notation can be verified end to end.

### Open questions that only the Chess.fish source can answer

* Does it embed a JavaScript engine in the page/worker, or launch a binary?
  (Determines §4.2 vs §4.1 — the two are mutually exclusive in a browser.)
* Which move notation does it use internally — UCI (`e2e4`), long algebraic, SAN
  (`Nf3`), or an index pair? SOLACE only produces UCI; SAN would need a small
  converter (the rules module has everything needed for it, but it does not exist
  yet).
* How does it want to receive search progress — plain `info` lines, parsed
  depth/score/nodes fields, or nothing but `bestmove`?
* Does it need `MultiPV`, a fixed depth, a fixed time, or skill levels?
* Who decides draws, and does it want the engine to adjudicate?
* Does it need to support more than one simultaneous game/engine instance?
  (One worker/process per game is the simplest answer; the engine holds no global
  mutable state outside its `UciEngine` instance.)
* Is the target offline-only (then everything must be bundled, no CDN) and what
  are the size limits? (`src/` is ~330 KB of source, no binary assets.)

---

## 7. Exact next steps

1. **Upload the Chess.fish engine-interface file(s)** from the list in §6 (items
   1–4 are enough to write the adapter).
2. I will then classify Chess.fish as one of: *UCI subprocess host* (adapter:
   configuration only), *browser page with workers* (adapter: copy
   `engine.worker.js`, add a message-based client), or *in-process JS*
   (adapter: import `UciEngine`).
3. Write the adapter **next to** `src/uci/` (e.g. `src/uci/chessfish.js` or a
   drop-in file inside Chess.fish), with no changes to the search, the evaluation
   or the move generator.
4. Add an automated test for the adapter itself: fixed positions → expected legal
   moves, `stop` mid-search, promotion handling, and a full game played through
   the adapter to a real termination.
5. Only after that: run a real match/play session inside Chess.fish and report
   the outcome honestly (including failures).

Until step 1 happens, no claim of Chess.fish compatibility is made.
