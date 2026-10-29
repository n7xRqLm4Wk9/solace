# SOLACE

**SOLACE** is a complete chess engine written from scratch in plain JavaScript.
It has its own move generation, its own handcrafted evaluation and its own
search: no Stockfish, no other engine's source, no chess library, no neural
network and no npm dependencies.

* 160 automated tests, all passing (`node tests/run.js`, ~8 s).
* Full UCI: verified over a real child process, not just in-process.
* Exact perft results up to depth 5 on six standard positions.
* ~0.45 M nodes/second search, ~6-7 M nodes/second perft on a laptop.
* Plays from the command line, over UCI (any GUI), in the browser or on Android.

---

## Quick start

You need Node.js 18 or newer. Nothing else - there are no dependencies.

```sh
git clone <this repository> solace
cd solace

node tests/run.js        # run the test suite (~8 s, 160 tests)
node cli.js perft 4      # 197281 nodes
node cli.js bench 5      # reproducible search benchmark
node cli.js play         # play against it in the terminal
node cli.js              # speak UCI on stdin/stdout
```

`node cli.js help` lists everything:

```
(node command) / uci   UCI protocol on stdin/stdout
play                   interactive text board
perft [depth] [fen]    perft node counts
bench [depth]          reproducible benchmark
analyze [fen] [depth]  search one position
selfplay [--games N] [--depth N|--movetime MS]
match [--games N] [--tc movetime:1000|depth:6] [--opponent "cmd"]
test [suite]           run the automated tests
```

### Inside `node cli.js play`

```
play e2e4     make a move (UCI notation)
go 1000       think for 1000 ms and reply
depth 4       search to a fixed depth and reply
undo          take back the last two plies
d  eval  fen  moves  quiet  quit
```

### In a GUI

SOLACE speaks standard UCI. In any GUI (DroidFish, Cute Chess, Arena, Nalwald…)
register the engine as:

```
command: node /absolute/path/to/solace/cli.js
```

or simply run `node cli.js` and talk the protocol yourself:

```
uci
isready
position startpos moves e2e4 e7e5
go movetime 1000
```

### UCI reference

| command | supported |
| --- | --- |
| `uci`, `isready`, `ucinewgame` | yes |
| `position startpos\|fen ... [moves ...]` | yes, with promotion parsing |
| `go depth\|nodes\|movetime\|wtime/btime/winc/binc/movestogo\|infinite\|searchmoves` | yes |
| `stop`, `quit` | yes (exactly one `bestmove` per search; `bestmove 0000` when there is no legal move) |
| `setoption Hash`, `Move Overhead`, `VerifyMoves`, `Clear Hash` | yes |
| `debug on\|off`, `register` (ignored), unknown commands (ignored silently) | yes |
| `go ponder` + `ponderhit` | approximate (infinite search, then play the best move found) |
| `go mate N`, MultiPV > 1 | **not supported** |

There is a runnable client example in `tools/uci-client.js`:

```sh
node tools/uci-client.js --fen "<FEN>" --movetime 500
```

Integrating SOLACE into another program (child process, Web Worker or in-process)
is described in **[docs/INTEGRATION.md](docs/INTEGRATION.md)**, together with the
exact runtime requirements of each option.

### In the browser / on a phone

`web/` is a complete mobile-first UI; the engine runs in a Web Worker, so the
board never freezes. Serve the folder over HTTP (browsers block ES modules from
`file://`):

```sh
node tools/serve.js 3000     # then open http://127.0.0.1:3000
```

For Android (Termux, no terminal, editing on the phone, phone-friendly settings)
see **[docs/ANDROID.md](docs/ANDROID.md)**.

---

## What is implemented

### Rules (`src/core/`)

All of it, from scratch, on a bitboard board representation:

* pawn single/double pushes, captures, en passant (including the discovered-check
  case), all four promotions;
* knights, bishops, rooks, queens (magic bitboards) and kings;
* castling on both sides with every legality condition (rights, empty squares,
  king not in/through/into check);
* pins, discovered attacks, double check, checkmate and stalemate;
* make/unmake that restores the position exactly, with castling rights,
  en-passant square, halfmove clock and move number;
* threefold repetition, fifty-move rule, insufficient material;
* FEN parsing and serialisation, with validation and useful error messages;
* standard UCI, including `Hash`, `Move Overhead`, `VerifyMoves` and `Clear Hash`.

### Evaluation (`src/eval/evaluate.js`)

Handcrafted, tapered middlegame/endgame scores in centipawns, from the point of
view of the side to move: material, piece-square tables, mobility, bishop pair,
pawn structure (doubled, isolated, supported, phalanx, passed with rank scaling
and king escort), rooks on open/semi-open files and the seventh, king safety
(pawn shield, open files, enemy pressure on the king ring) and endgame king
activity. No neural network, no learned weights.

### Search (`src/search/`)

Iterative deepening negamax with principal variation search, a Zobrist
transposition table, quiescence search with static exchange evaluation, move
ordering (TT move, MVV-LVA, promotions, countermove, killers, history), null-move
pruning, reverse futility, futility and late-move pruning, late move reductions,
check extensions, aspiration windows, mate-distance pruning and full draw
detection inside the tree.

Fixed depth, fixed time, node limits and cooperative cancellation are supported;
the search runs on one thread, uses no `SharedArrayBuffer` and searches a private
copy of the position, so stopping it can never corrupt the game state.

### Tooling (`src/tools/`, `tools/`)

* `bench` - fixed set of 12 positions, prints depth/nodes/nps/time/score/move and
  verifies that every returned move is legal;
* `selfplay` - games between two instances, with legality checking, adjudication
  and statistics;
* `match` - matches between two UCI processes with alternating colours, built-in
  opening lines and adjustable time control;
* `tools/gen-magics.js` - the offline magic-number generator that produced
  `src/core/magics.js` (deterministic, ~0.7 s);
* `tools/serve.js` - dependency-free static server for the browser build.

---

## Measured results

All numbers below were produced by actually running the code on this machine
(Linux x86-64, 2 vCPU, Node.js v22.22.3). They are not estimates. See
[docs/STRENGTH.md](docs/STRENGTH.md) for methodology and caveats.

### Tests

| suite | tests | result |
| --- | --- | --- |
| movegen, fen, eval, draw, search, uci, uci-process, tools, web | 160 | **160 passed, 0 failed (~8 s)** |

### Perft (exact reference counts)

| position | depth 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| initial | 20 | 400 | 8,902 | 197,281 | 4,865,609 |
| kiwipete | 48 | 2,039 | 97,862 | 4,085,603 | - |
| position 3 | 14 | 191 | 2,812 | 43,238 | 674,624 |
| position 4 | 6 | 264 | 9,467 | 422,333 | - |
| position 5 | 44 | 1,486 | 62,379 | 2,103,487 | - |
| position 6 | 46 | 2,079 | 89,890 | 3,894,594 | - |

Speed: 4,865,609 nodes in 827 ms (5.9 M nps) for the initial position at depth 5;
4,085,603 nodes in 537 ms (7.6 M nps) for kiwipete at depth 4.

### Search benchmark (`node cli.js bench 6`, 12 positions, hash 16 MB)

| position | depth | nodes | ms | nps | score | best move | legal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| startpos | 6 | 19,447 | 294 | 66,146 | +8 | b1c3 | yes |
| kiwipete | 6 | 74,570 | 261 | 285,709 | +3 | d5e6 | yes |
| position-3 | 6 | 7,924 | 23 | 344,522 | +74 | b4f4 | yes |
| position-4 | 6 | 6,882 | 21 | 327,714 | -407 | c4c5 | yes |
| position-5 | 6 | 6,248 | 24 | 260,333 | +511 | d7c8r | yes |
| position-6 | 6 | 17,477 | 80 | 218,463 | +63 | g5f6 | yes |
| italian-middlegame | 6 | 49,075 | 116 | 423,060 | +40 | c4b5 | yes |
| lucena-endgame | 6 | 3,456 | 6 | 576,000 | +301 | c1c8 | yes |
| queen-endgame | 6 | 25,482 | 30 | 849,400 | +1088 | g2g6 | yes |
| mate-in-3 | 3 | 443 | 1 | 443,000 | M3 | f6a6 | yes |
| promotion-race | 6 | 3,032 | 4 | 758,000 | -38 | a7a8q | yes |
| tactics-1 | 6 | 25,574 | 62 | 412,484 | +282 | c1g5 | yes |
| **total** | | **239,610** | **922** | **259,881** | | | **0 illegal** |

The per-position nps numbers include JIT warm-up; a sustained search on a
middlegame position runs at roughly 450,000 nodes/second.

### Effect of the last optimisation round

Same four positions, same fixed depths, measured before and after the evaluator
rewrite and the pruning work:

| build | nodes | time |
| --- | --- | --- |
| before (commit `47d97c3`) | 2,343,347 | 4,545 ms |
| after | 836,089 | 1,862 ms |

That is **2.8x fewer nodes and 2.4x less time for the same fixed depth**.

### Playing strength

Two independent 24-game matches (12 openings, each played with both colours,
100 ms per move, `node cli.js match`) of the current build against the previous
one:

```
run 1: match result +13 -4 =7 of 24 games   score 16.5 / 24 (68.8%)
run 2: match result  +9 -4 =11 of 24 games  score 14.5 / 24 (60.4%)
combined over 48 games: +22 -8 =18          score 31 / 48 (64.6%)
illegal moves in 48 games: 0
```

That is consistent with an improvement of roughly **+100 Elo**, but with 48 games
the 95% confidence interval is wide (about +15 to +220 Elo), so the honest claim
is "clearly stronger than the previous build", not a rating. Games ended by
checkmate (19), threefold repetition (8) and once each by stalemate, the
fifty-move rule and the move limit - a useful sanity check that whole-game
handling works. **No Elo rating is claimed for SOLACE**: no match against a
rated reference engine has been run yet (see
[docs/STRENGTH.md](docs/STRENGTH.md) for the exact command to do it with
Stockfish, and why it is not part of this report).

Self-play (`node cli.js selfplay --games 4 --depth 5`) completes every game with
a real termination (checkmate, repetition or fifty-move rule), 0 illegal moves,
about 500,000 nodes/second, and each opening gives the same result with the
colours reversed - the engine is deterministic and does not depend on the colour.

---

## Project layout

```
cli.js                  command line and UCI entry point
src/core/               types, magics, bitboards, moves, zobrist, position, verifier
src/eval/               evaluate.js (classical evaluation), see.js
src/search/             perft, transposition, move ordering, search
src/uci/                UCI protocol handler
src/tools/              bench, selfplay, match, openings
tests/                  dependency-free test suite (harness + 8 suites)
web/                    browser UI (HTML/CSS, app.js, engine Web Worker)
tools/                  gen-magics.js, serve.js
docs/                   ARCHITECTURE.md, INTEGRATION.md, STRENGTH.md, ANDROID.md
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the board representation,
the move generator, the evaluation terms, the search and the UCI layer in more
detail, including why the representation was chosen.

---

## Testing

```sh
node tests/run.js            # everything
node tests/run.js movegen    # one suite: movegen fen eval draw search uci tools web
node cli.js test eval        # same thing through the CLI
```

No test framework is used: `tests/harness.js` is under a hundred lines and the
suites are plain Node modules. Coverage includes:

* perft against published reference counts, including six tricky positions;
* the fast move generator compared move-by-move with an independent slow
  generator on fixed and randomly generated positions;
* make/unmake round trips and incremental Zobrist keys verified against a
  from-scratch recomputation during long random games;
* checkmate, stalemate, castling legality and rights, en passant including the
  discovered-check case, all four promotions, pins and king safety;
* FEN round trips, malformed FEN rejection and illegal-position rejection;
* threefold repetition, fifty-move rule, insufficient material;
* search termination under depth, time and node limits, legal best moves, mate
  detection, determinism, transposition-table behaviour;
* the UCI layer end to end (options, `position`, `go`, `stop`, `searchmoves`,
  mate scores) **and** over a real `node cli.js` child process
  (`tests/uci-process.test.js`), i.e. the exact transport a GUI would use;
* the browser build: worker protocol, move legality, perft self-test.

---

## Honest limitations

* **Strength is unmeasured against reference engines.** No Elo claim is made.
* **No neural network** (by design) and no learned evaluation parameters; all
  weights are hand-chosen.
* **Single-threaded**: no lazy SMP, no `SharedArrayBuffer`, no pondering on
  multiple cores. Pondering is approximated (see below).
* **No opening book and no tablebases.** The opening lines in
  `src/tools/openings.js` are only used by the self-play and match tools.
* **No MultiPV** and no `go mate N` limit, and the `uci` extension commands
  (`d`, `eval`, `perft`, `bench`, `help`) are non-standard extras.
* **Pondering is approximate**: `go ponder` starts an infinite search and
  `ponderhit` plays the best move found so far. Matches here run with pondering
  off.
* **K+N+N vs K is not treated as a draw** (mate is possible with help, and FIDE
  agrees), and the engine never *claims* a draw: it detects draws internally but
  a GUI or the match tool decides the result.
* **Time management is simple**: soft/hard limits derived from the remaining
  time and `Move Overhead`. On a heavily loaded phone, increase `Move Overhead`.
* **No repetition-proof opening variety in self-play** beyond the built-in
  opening list: two deterministic engines playing the same opening produce the
  same game twice, which is expected and visible in the logs.

---

## License and provenance

MIT licensed (see `LICENSE`). The engine is an original implementation written
for this project. It uses no
third-party chess library and no other engine's code. The magic numbers in
`src/core/magics.js` were generated by this repository's own
`tools/gen-magics.js`; the perft reference counts are the published values from
the Chess Programming Wiki and are used only as test data.
