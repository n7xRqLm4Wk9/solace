# SOLACE architecture

SOLACE is a classical (handcrafted evaluation, no neural network) chess engine
written in plain JavaScript. Every part of it - move generation, evaluation,
search, hashing, UCI - is implemented in this repository. No chess library, no
engine source code and no third-party chess logic is used.

```
.
├── cli.js                    command line entry point (UCI, play, perft, bench, matches)
├── package.json              npm scripts, ESM module type
├── src/
│   ├── core/
│   │   ├── types.js          colours, pieces, squares, 32-bit bit tricks, castling bits
│   │   ├── magics.js         magic numbers (generated once by tools/gen-magics.js)
│   │   ├── bitboards.js      attack tables (leapers + magic sliders), filled at start-up
│   │   ├── moves.js          16-bit move encoding, move lists, UCI notation
│   │   ├── zobrist.js        deterministic Zobrist keys
│   │   ├── position.js       board, legal move generation, make/unmake, FEN, draws
│   │   └── verify.js         slow independent implementations used to cross-check
│   ├── eval/
│   │   ├── evaluate.js       tapered handcrafted evaluation
│   │   └── see.js            static exchange evaluation
│   ├── search/
│   │   ├── transposition.js  Zobrist-keyed hash table with aging
│   │   ├── moveOrdering.js   TT move, MVV-LVA, countermove, killers, history
│   │   ├── perft.js          perft / perft divide
│   │   └── search.js         iterative deepening negamax, quiescence, time control
│   ├── uci/uci.js            UCI protocol handler (transport agnostic)
│   └── tools/
│       ├── bench.js          reproducible benchmark suite
│       ├── selfplay.js       in-process self-play with legality checking
│       └── match.js          UCI process-vs-process match runner
├── tests/                    dependency-free test suite
├── web/                      browser UI (engine runs in a Web Worker)
├── tools/
│   ├── gen-magics.js         offline magic-number search (reproducible)
│   └── serve.js              static server for the browser build
└── docs/                     this file, STRENGTH.md, ANDROID.md
```

## Board representation

Each 64-bit set is stored as two 32-bit words (`lo` = squares 0-31, `hi` =
squares 32-63) because JavaScript bitwise operators work on 32 bits. The
position keeps:

* a 64-entry board array (board code per square),
* twelve piece bitboards (one per colour and piece type),
* two colour bitboards and a total occupancy bitboard,
* king squares, castling rights, en-passant square, halfmove clock and move number,
* an incrementally updated 64-bit Zobrist key plus a key history for repetition.

Why this design: it was benchmarked against the alternatives (a plain 0x88 board
with mailbox attacks, and a single BigInt bitboard). The 32-bit word pair avoids
the substantial cost of BigInt arithmetic while keeping the CPU-friendly
bitboard algorithms; perft runs at roughly 7 million nodes per second on the
development machine and move generation is fast enough that evaluation and
make/unmake dominate the search, as they should.

## Move generation

Sliding pieces use magic bitboards. The magic numbers themselves were found by
`tools/gen-magics.js` (a deterministic trial-and-error search over 32-bit word
arithmetic) and are embedded in `src/core/magics.js`, so the engine only fills
the attack tables at start-up (a few milliseconds).

Generation produces **pseudo-legal** moves; the search makes each move and asks
"is my king attacked now?". Castling is the exception: it is produced only when
it is fully legal, because the king's path must be checked anyway.

Correctness is enforced three ways:

1. perft against published reference counts (initial position, Kiwipete and
   positions 3-6, up to depth 5 where listed),
2. a completely independent slow generator (`src/core/verify.js`) that scans the
   board with file/rank arithmetic; the test suite compares the full move set of
   both generators on dozens of positions, including random ones,
3. the optional `VerifyMoves` UCI option, which re-checks attack detection with
   the slow scanner at every node during a search.

`makeMove` stores castling rights, en-passant square, halfmove clock, both
Zobrist words and the previous king square, so `unmakeMove` restores the position
bit-for-bit. The test suite plays long random games and compares the incremental
key with a from-scratch recomputation after every move, and checks that unmaking
everything reproduces the original FEN exactly.

## Evaluation

`src/eval/evaluate.js` returns centipawns from the point of view of the side to
move (the negamax convention). Terms are tapered between a middlegame and an
endgame value using a standard phase counter (24 = full material):

| term | notes |
| --- | --- |
| material | separate mg/eg values (pawns gain value in the endgame) |
| piece-square tables | pre-mirrored for Black, no per-square branches |
| mobility | per piece type, counts squares not occupied by own pieces |
| bishop pair | +30 mg / +45 eg |
| pawns | doubled, isolated, supported, phalanx, passed (rank scaled) |
| passed pawn escort | king distance term in the endgame |
| rooks | open/semi-open files, seventh rank |
| king safety | pawn shield, open files near the king, enemy pressure on the king ring (mg only) |
| king activity | endgame king piece-square table |
| tempo | +8 for the side to move |

The evaluator allocates nothing, computes each attack set once (mobility and king
pressure share it) and runs at roughly one million evaluations per second in
Node on the test machine. Its colour symmetry is verified by a test that mirrors
positions and requires the score to flip sign exactly.

## Search

`src/search/search.js` implements iterative deepening negamax with:

* principal variation search (zero-window re-search),
* transposition table (Zobrist key, depth, bound flag, best move, aging; the
  size is the UCI `Hash` option in MB),
* move ordering: TT move, MVV-LVA captures, promotions, countermove, killers,
  history heuristic (with gravity updates),
* quiescence search over captures, promotions and - when in check - all evasions,
  with delta pruning and static exchange pruning,
* null-move pruning, reverse futility pruning, futility pruning, late move
  reductions with re-search, late move pruning and check extensions,
* draw detection inside the tree (fifty-move, repetition, insufficient material),
* mate-distance pruning and mate score correction in the transposition table,
* aspiration windows,
* soft/hard time limits, node limits, and cooperative cancellation (`stop`).

The search never mutates the caller's position: it searches a private copy, so a
`stop` in the middle of an iteration cannot corrupt anything.

`SearchSession` exposes one iterative-deepening iteration per call. The UCI
layer drives it between event-loop turns, which keeps `stop`, `isready` and
`quit` responsive without threads. The browser build instead runs the whole
engine in a Web Worker, so the UI thread is never blocked.

## Draw handling

* Fifty-move rule: halfmove clock 100 => draw inside the tree.
* Repetition: a position that already occurred once in the current line scores 0
  (engines avoid repetition blindness); the third occurrence is what the rules
  require for a claim, so the engine is conservative here.
* Insufficient material: K vs K, K+minor vs K, and opposite-coloured kings and
  bishops. K+N+N vs K is *not* treated as a drawn position (FIDE allows mate with
  help) - documented limitation.

## UCI

`src/uci/uci.js` speaks standard UCI: `uci`, `isready`, `setoption`,
`ucinewgame`, `position` (`startpos`/`fen` + `moves`), `go` with `wtime`/`btime`/
`winc`/`binc`/`movestogo`/`depth`/`nodes`/`movetime`/`infinite`/`searchmoves`,
`stop`, `ponderhit`, `quit`, `debug on|off`, plus extensions (`d`, `eval`,
`perft`, `bench`, `help`) that are handy when playing with the engine by hand.

The handler is transport agnostic: it takes an `output` callback and gets input
through `handleLine()`, so the same code is driven by `node:readline` in `cli.js`
and by `postMessage` in `web/engine.worker.js`. Unknown commands, unknown options
and the optional `register` command are ignored silently (as the specification
requires); `debug on` makes them visible and echoes the position after every
`position` command. `searchmoves` filters the root move list inside
`SearchSession`, so the search itself is unaware of the protocol.

Options: `Hash` (1-512 MB, default 16), `Move Overhead` (default 30 ms),
`VerifyMoves` (default off), `Clear Hash` (button).

Known UCI limitations: no MultiPV, and pondering is approximated (a `go ponder`
search runs as an infinite search and `ponderhit` plays the best move found so
far). Matches should therefore be run with pondering disabled, which is the
default in the tooling here.
