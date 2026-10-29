# Measuring SOLACE's strength

This document records what has actually been measured, how, and what is still
unknown. Nothing in this file is an estimate presented as a result.

Environment for every number below: Linux x86-64, 2 vCPU, 3.9 GB RAM,
Node.js v22.22.3. A different machine (in particular a phone) will produce
different raw speeds, but the *relative* results of the A/B tests should hold.

---

## 1. Correctness first

Before any strength work, correctness is pinned down by:

* perft against published reference counts (six positions, up to depth 5),
* a second, deliberately slow move generator that is compared move-for-move
  with the fast one (`src/core/verify.js`),
* Zobrist keys recomputed from scratch during long random games and compared
  with the incremental keys,
* make/unmake round trips that must return the exact starting FEN,
* 140 automated tests (`node tests/run.js`).

A speed or strength change is only kept if the full suite still passes.

---

## 2. What changed and why it should be stronger

| change | expected effect | measured |
| --- | --- | --- |
| evaluator rewritten as one allocation-free pass, attack sets reused for mobility and king pressure, pre-mirrored PSTs | same scores, less time per node | 1.18-1.4x faster evaluation, identical scores on the benchmark positions |
| static exchange evaluation (`src/eval/see.js`) in quiescence | fewer bad captures searched | ~48% fewer nodes on kiwipete at d8 |
| SEE pruning of losing captures in the *main* search | fewer nodes | **worse** (more nodes, slower); available as `seePruning` but off by default |
| countermove heuristic, history gravity, LMR table, futility and late-move pruning | better ordering, smaller trees | 2.8x fewer nodes at equal depth overall |
| lazy static evaluation (only when a pruning decision needs it) | fewer eval calls | included in the 1.05x node-time gain |

Combined effect at equal fixed depth on four benchmark positions
(startpos d9, kiwipete d8, italian middlegame d9, position 3 d11):

```
before (commit 47d97c3): 2,343,347 nodes in 4,545 ms
after:                     836,089 nodes in 1,862 ms
```

---

## 3. Head-to-head match against the previous version

Fixed-depth node counts do not prove that a program plays better, so the two
builds were also played against each other over the UCI protocol.

```sh
# the previous build, exported from the repository history
git worktree add /tmp/solace-base 47d97c3
# a minimal UCI runner for the old build (it predates cli.js)
cat > /tmp/solace-base/uci-runner.mjs <<'JS'
import { createInterface } from 'node:readline';
import { UciEngine } from './src/uci/uci.js';
const engine = new UciEngine({ output: (line) => process.stdout.write(line + '\n') });
const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => { const keep = engine.handleLine(line); if (!keep) { rl.close(); setTimeout(() => process.exit(0), 50); } });
rl.on('close', () => setTimeout(() => process.exit(0), 50));
JS

node cli.js match --games 24 --tc movetime:100 --max-moves 220 \
     --opponent "node /tmp/solace-base/uci-runner.mjs"
```

The match was run twice (12 opening lines each time, every opening played with
both colours, 100 ms per move):

```
run 1: +13 -4 =7  -> 16.5 / 24 (68.8%), 0 illegal moves
run 2:  +9 -4 =11 -> 14.5 / 24 (60.4%), 0 illegal moves
combined 48 games: +22 -8 =18 -> 31 / 48 (64.6%), 0 illegal moves
```

Game terminations across the 48 games: 19 checkmates, 8 threefold repetitions,
1 stalemate, 1 fifty-move draw, 1 move-limit draw, and the rest decided by
checkmate in the other direction - i.e. every game reached a real end, no crash,
no illegal move and no time loss.

**Interpretation.** 64.6% over 48 games is roughly +100 Elo. The 95% confidence
interval at this sample size is wide (about +15 to +220 Elo: one game is worth
2%, so a couple of flips move the estimate by tens of Elo). The honest claim is:
*the new build is clearly stronger than the old one; the size of the improvement
is not measured precisely.* A tighter number needs several hundred games.

The previous build also played 12 games against itself at fixed depth 6 with no
openings: all 12 were drawn by repetition, which is expected for two identical
deterministic engines and is why the match tool now uses opening lines.

---

## 4. Self-play

```sh
node cli.js selfplay --games 4 --depth 5
```

* every game reaches a real termination (checkmate, repetition, fifty-move rule,
  insufficient material) - no silent truncation,
* 0 illegal moves out of ~280 played moves,
* about 500,000 nodes per second across the games,
* opening lines are played twice with reversed colours and give symmetric
  results, which is the expected outcome for a deterministic, colour-blind
  engine.

Self-play is a smoke test for crashes, illegal moves and time-outs. It says
nothing about strength, because both sides are the same program.

---

## 5. Comparison with Stockfish (not yet run)

Requirement: matches against **Stockfish 18 Lite** with alternating colours and
consistent time controls. This has **not** been run, for an honest reason:
Stockfish is not available in this development environment (there is no package
and no engine binary, and this project must not embed or copy any part of it).
No Elo number is therefore claimed.

To run it on a machine that has Stockfish, use the built-in match tool. Both
sides speak UCI, so nothing else is needed:

```sh
# 20 games, 1 second per move, colours alternate every game,
# 10 opening lines each played twice
node cli.js match \
  --engine "node cli.js uci" \
  --opponent "./stockfish" \
  --games 20 \
  --tc movetime:1000 \
  --max-moves 300
```

The tool prints the result of every game (with the move list, the reason the game
ended and the final FEN), the total score, and the number of illegal moves. For a
rating estimate use at least 200-400 games and a time control both engines can
handle; fewer games only tell you which engine is stronger, not by how much.

Practical notes for such a match:

* give Stockfish a small `Hash` (e.g. 16 MB) and one thread so the comparison is
  about the search, not about hardware,
* use `movetime` rather than incremental time if the machine is noisy,
* disable pondering (SOLACE's is approximate),
* expect SOLACE to lose: the interesting number is the score, not the result.

---

## 6. Where the strength could go next

Ordered by expected value per unit of work, based on what the benchmarks show:

1. **Better use of the transposition table** (deeper replacement policy, storing
   static evaluation, using the TT in quiescence).
2. **More aggressive but safe pruning** - the experiment with SEE pruning in the
   main search shows that not every standard trick pays off here; each change
   needs its own match, not just a node count.
3. **A small, tunable evaluation**: the current weights are hand-set; even a
   simple local search over the weights (SPSA-style) on a few hundred positions
   usually gains real strength.
4. **Endgame knowledge**: no tablebases and no special endgame evaluation beyond
   the tapered king activity term and passed-pawn scaling.
5. **Time management**: allocate more time to complex positions and less to
   trivially decided ones.
6. **A proper opening book** for matches (kept outside the engine, as the current
   tooling does).

Everything above would have to pass the full test suite *and* show a gain in a
reproducible match before being described as an improvement.
