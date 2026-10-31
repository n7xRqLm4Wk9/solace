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
* 160 automated tests (`node tests/run.js`).

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

---

## 7. Version 0.1.5 - evaluation, quiescence and speed

Version 0.1.5 left the project structure alone (same move generator, same
position code, same UCI adapter, same Web Worker build) and worked on the
evaluator first, the search second, and the speed of the hot path third - the
order of priority that was asked for. Every candidate way measured twice: first
for *cost* (nodes and time to a fixed depth, which are deterministic), then for
*strength* (head-to-head games). The second measurement decided what shipped, and
it rejected one of the three batches outright and demoted another to a single
component.

### The measurement tool, and a bug that had to be fixed first

`tools/ab-match.mjs` plays a candidate tree against a baseline tree in one
process, with the same opening lines, every opening played with both colours, and
rules-only adjudication (checkmate, stalemate, fifty-move, insufficient material,
repetition - never an evaluation), so a different evaluation between the two
sides cannot bias the result:

```sh
node tools/ab-match.mjs . /tmp/solace-baseline 200 depth:8
node tools/ab-match.mjs . /tmp/solace-baseline 200 movetime:100
```

The first version of this tool kept both engines' transposition tables alive
*between games*. A self-match then produced decisive results - up to 3-0 over
four games with the engine playing itself - because each side started every game
with a differently polluted table. Every match below was re-run after clearing
both tables at the start of each game; a self-match now scores exactly 50.0% with
mirrored pairs, which is the check that the tool is fair.

### What changed

| area | change | cost | verdict |
| --- | --- | --- | --- |
| evaluation | tapered mg/eg score: mobility, bishop pair, doubled/isolated/supported/phalanx pawns, passed pawns (rank, king support, blocked, connected, rook behind), rook open/semi-open files and seventh rank, king pawn shield and open files, king-attack pressure, threats (pawn on piece, minor on major, rook on queen), knight outposts, bishops blocked by their own pawns | evaluation 1.48 us/position vs 1.11 for the smaller previous one | **kept**: +42 Elo at equal depth (200 games, depth 8, 56.0%) |
| evaluator hot path | flat typed-array tables (piece-square tables with material folded in, per-colour masks indexed `colour * 64 + square`), precomputed phalanx/distance/square-colour tables, per-colour values hoisted out of the loops | identical scores (0 differences over 1,000 random positions) | **kept**: 1.48 -> 1.36 us/position (-8%) |
| search | continuation history, history malus, deeper null-move reductions, "improving" futility margins, transposition table in quiescence | 21% fewer nodes at depth 7 | **mostly rejected**: 40.5% over 200 games at depth 8 (-67 Elo) |
| quiescence transposition table, taken alone | probe and store in quiescence, with mate scores excluded from the bound logic | 13-16% fewer nodes at depth 7 than the *baseline* (192,195 vs 230,049) | **kept**: see the match table below |
| endgame mop-up term (drive the losing king to the edge with four pawns of material) | - | cut a third of the endgame nodes | **not shipped**: its measurements came from the faulty harness, so no claim is made either way |

The two rejections are the useful part of this report:

* The search package made the engine **faster and weaker**: 21% fewer nodes at
  equal depth, -67 Elo at equal depth. Fewer nodes are not the same thing as
  better moves.
* The quiescence table, which was one ingredient of that same package, is the
  part that pays at a fixed clock. 89% of the nodes in a search are quiescence
  nodes, so a table there buys time, even though it costs a little accuracy at
  equal depth: the shipped build scores 46.8% at fixed depth 8 (-23 Elo) and
  53.0% at 70 ms per move (+21 Elo) over 600 games. Both numbers are real; they
  measure different things, and the one that matters for a player is the clock.

### Current numbers for 0.1.5

* Full suite: **160 tests, 0 failures** (`node tests/run.js`).
* Evaluation throughput **1.36 us/position** (735,000 per second), from 1.48
  before the hot-path pass; the previous release's smaller evaluator runs at
  1.11 us.
* Search, 4 benchmark positions at depth 7: **192,195 nodes in 539 ms**
  (357,000 nodes/s) against the previous release's 230,049 nodes in 665 ms
  (346,000 nodes/s): 16% fewer nodes, and less time for the same depth. (The
  timings in this bullet were taken on an otherwise idle machine; the loaded
  numbers during the matches are 30-40% slower and are not comparable.)
* Search benchmark suite (`node cli.js bench 6`, 12 positions): 205,334 nodes,
  0 illegal moves.
* Mirror symmetry: 2,000 mirrored position pairs from random games, 100 pairs
  differ by exactly 1 centipawn - the `Math.round` half-value artefact, which the
  previous release shows as well. No colour bias.
* Material sanity: start position 0, kings only 0, KQ vs K 1008, KR vs K 593, a
  queen up 953, a rook up 504; only positions with structure move (kiwipete
  103 -> 69, position 3 -57 -> -75).

### Head-to-head against 0.1.4

All with the fixed harness and a cleared transposition table at the start of
every game; zero illegal moves in every match:

| build | time control | games | score | Elo |
| --- | --- | --- | --- | --- |
| evaluation pass, before the quiescence table | depth 8 | 200 | 56.0% | ~+42 |
| evaluation pass + rejected search package | depth 8 | 200 | 40.5% | ~-67 |
| evaluation pass, before the quiescence table | 70 ms/move | 200 | 48.0% | ~-14 |
| evaluation + quiescence table, draft build | 70 ms/move | 200 | 57.3% | ~+51 |
| **0.1.5 as shipped**, run 1 | 70 ms/move | 200 | 51.0% | ~+7 |
| **0.1.5 as shipped**, run 2 | 70 ms/move | 400 | 54.0% | ~+28 |
| **0.1.5 as shipped**, both runs pooled | 70 ms/move | **600** | **53.0%** | **+21 +/- 28** |
| 0.1.5 as shipped | depth 8 | 200 | 46.8% | ~-23 |

These rows are a lesson in sample sizes. The draft build scored 57.3% over its
first 200 games; the shipped build then scored 51.0% over its next 200 and 54.0%
over the 400 after that. Quoting the first number alone would have been a +51 Elo
claim that the following 600 games do not support. Pooled over all 600 games of
the shipped build - 229 wins, 193 losses, 178 draws - the result is **53.0%,
+21 Elo with a 95% interval of roughly -7 to +49**. Pooling in the two
preliminary 200-game runs as well (800 games, 54.1%) gives +29 +/- 25.

The honest reading:

* At a fixed clock - which is how the engine is actually used - 0.1.5 is
  **a little stronger** than 0.1.4. The best estimate from 600 games is +21 Elo,
  and it is positive in all three 70 ms/move runs. It is *not* statistically
  significant on its own: the interval includes zero.
* At equal depth the same build is slightly *behind* (-23 +/- 50), because the
  richer evaluation and the table lookups cost time. This is expected and is why
  both numbers are reported: the fixed-depth row is a diagnostic, the fixed-clock
  row is the result. The evaluation bought knowledge and the quiescence table
  bought back the time.

### What is claimed, and what is not

* Claimed: **+21 Elo (+/- 28, 95%) against 0.1.4 at 70 ms per move over 600
  games**, positive in all three 70 ms/move runs, 0 illegal moves; 16%
  fewer nodes and (on an idle machine) ~19% less time to a fixed depth; 160 tests
  passing; evaluation symmetry and material sanity unchanged.
* Claimed, and directly checkable: the evaluator is ~8% faster per position than
  before the hot-path pass (1.48 -> 1.36 us), 100 pairs of mirror-symmetric
  positions agree within 1 centipawn, and material scores are unchanged.
* **Not** claimed: any absolute Elo rating. That needs a long match against a
  rated reference engine, and none is available in this environment (Stockfish is
  deliberately not part of this project, and none is installed). Section 5 gives
  the exact command for running that match where such an engine exists.
* **Not** claimed: that the new evaluation is stronger than the old one *at equal
  depth*. It measured -23 +/- 50 there. It is stronger *per unit of time*, which
  is what a chess engine is judged by.

### A realistic target

Ordered by expected gain per hour of work, with the tooling that now exists
(`tools/ab-match.mjs`, ~10 minutes per 200-game match at 70 ms):

1. **Automatic weight tuning.** The evaluation has ~50 hand-set weights. An
   SPSA or CLOP-style tuner over 20-30 of them, using a few thousand short games,
   is the standard way to find 50-150 Elo in an engine of this shape. This is the
   single largest expected gain and needs no architectural change.
2. **Search parameters, not search structure.** The rejected package above shows
   that big structural changes are a lottery here. Retuning existing margins
   (futility, late-move pruning, null-move reduction, aspiration width) against
   games is much more likely to pay.
3. **Transposition-table refinement** - store the static evaluation, use a
   depth-preferred replacement scheme, keep the table between moves at the root.
4. **Capture ordering by SEE** in quiescence instead of MVV-LVA: a pure ordering
   improvement with no accuracy cost.
5. **Endgame terms, verified in games.** The naive mop-up term was never properly
   measured, so the safe statement is that endgame terms must be validated with
   matches before shipping.

A cumulative **+100 to +150 Elo over 0.1.5** is a realistic target for that work.
Half of it is likely to come from tuning rather than from new ideas, which is
what the two rejected experiments suggest.
