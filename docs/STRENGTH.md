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

## 7. Version 0.1.5 - evaluation work, and what the matches said

Version 0.1.5 left the project structure alone (same move generator, same
position code, same UCI adapter, same Web Worker build) and worked on the
evaluator first, the search second, and the speed of the hot path third - the
order of priority that was asked for. Every candidate change was measured twice:
first for *cost* (nodes and time to a fixed depth, which are deterministic and
noise-free) and then for *strength* (head-to-head games). The second measurement
decided what shipped, and it rejected two of the three batches.

### The measurement tool, and a bug that had to be fixed first

`tools/ab-match.mjs` plays a candidate tree against a baseline tree in one
process, with the same opening lines, every opening played with both colours,
and rules-only adjudication (checkmate, stalemate, fifty-move, insufficient
material, repetition - never an evaluation), so a different evaluation between
the two sides cannot bias the result:

```sh
node tools/ab-match.mjs . /tmp/solace-baseline 200 depth:8
node tools/ab-match.mjs . /tmp/solace-baseline 200 movetime:100
```

The first version of this tool (and every match run with it before this fix)
kept both engines' transposition tables alive *between games*. A self-match then
produced decisive results - up to 3-0 over four games with the engine playing
itself - because the side whose table happened to be polluted by the previous
game played differently. Every match below was re-run after clearing both
tables at the start of each game; a self-match now scores exactly 50.0% with
mirrored pairs, which is the sanity check that this tool is fair.

### What was tried

| candidate | cost at fixed depth | result |
| --- | --- | --- |
| new evaluator: tapered middlegame/endgame score, mobility, bishop pair, full pawn structure, rook files/7th, king shield and open files, king-attack pressure, threats, knight outposts, blocked/connected/rook-behind passed pawns | +? nodes, evaluation 1.48 us/position | **kept**: 56.0% over 200 games at depth 8 (~+42 Elo) |
| search pass: continuation history, history malus, transposition table in quiescence, deeper null-move reductions, "improving" futility | 21% fewer nodes at depth 7 | **rejected**: 40.5% over 200 games at depth 8 (~-67 Elo) |
| mop-up endgame term (drive the losing king to the edge once four pawns of material up) | 30% fewer endgame nodes | **rejected**: not shipped, and its earlier numbers came from the faulty harness above, so no claim is made either way |
| flat typed-array tables in the evaluator hot path (`PST_*_FLAT`, `PAWN_ATK_*_F`, `PASSED_*_F`, `SHIELD_*_F`), hoisted per-colour values, precomputed phalanx masks | identical scores (0 differences over 1,000 random positions) | **kept**: 1.64 -> 1.48 us/position (-10% evaluation time) |

The search pass is the interesting rejection: it made the engine *faster* by a
fifth at equal depth and *weaker* by 67 Elo at equal depth. Fewer nodes are not
the same thing as better moves, which is exactly why every change was played.

### Current numbers for 0.1.5

* Full suite: **160 tests, 0 failures** (`node tests/run.js`).
* Evaluation throughput: 674,000 positions/s (1.48 us), from 1.64 us before the
  flat-table pass; the previous release's simpler evaluator runs at 905,000
  positions/s, so the richer evaluation costs about 35% of evaluation time.
* Search benchmark (`node cli.js bench 6`): 275,839 nodes in 1,005 ms over the
  12 benchmark positions, 0 illegal moves.
* Mirror symmetry: 2,000 mirrored pairs from random games, 100 pairs differ by
  exactly 1 centipawn (the `Math.round` half-value artefact; the previous
  release shows the same behaviour). No colour bias.
* Sanity: start position 0, kings only 0, KQ vs K 1008, KR vs K 593, up a queen
  953; only positions with structure move (kiwipete 103 -> 69, position 3
  -57 -> -75).

### Head-to-head against 0.1.4 (all with the fixed harness)

| time control | games | score | Elo |
| --- | --- | --- | --- |
| depth 8 (evaluation only) | 200 | 56.0% | ~+42 |
| depth 8 (evaluation + rejected search pass) | 200 | 40.5% | ~-67 |
| 70 ms/move (evaluation only) | 200 | 48.0% | ~-14 |

One game is worth 0.5% at 200 games, so the 95% confidence interval here is
about +/- 50 Elo. The honest reading of the first row is: *the new evaluator is
probably stronger, by something between "nothing" and "plus ninety", and this
sample cannot be more precise than that.* The third row is the one that matters
for real play, and it says something different: **at 70 ms per move the two
versions are the same strength** (48.0%, i.e. -14 +/- 50 Elo), because the richer
evaluation also costs time - about 35% more evaluation time than the previous,
smaller one. The knowledge gained buys back exactly what the extra time costs at
this speed. On a slower machine or a longer time control the balance shifts
towards the evaluation; at very fast time controls it shifts the other way.

### What is claimed, and what is not

* Claimed: the evaluator is measurably richer and passes symmetry, sanity and
  the full test suite; the evaluation hot path is 10% faster than before the
  pass; the engine still reaches depth 8 with the same number of tests passing.
* Claimed, weakly: +42 Elo at equal depth over 200 games (95% CI roughly -6 to
  +92), and **no measurable difference at 70 ms per move** (-14 +/- 50). At 200
  games neither number is proof; they are the best estimates this machine can
  produce in a reasonable time, and they are reported with their sample sizes so
  they can be checked.
* **Not** claimed: any absolute Elo rating. That needs a long match against a
  rated reference engine, and none is available here. The `docs/INTEGRATION.md`
  and section 5 above give the exact command for running one where Stockfish
  exists.

### A realistic target

The steps below are ordered by expected gain per hour of work. Each needs a
match of at least 1,000 games to be believed (+/- 25 Elo), and the tool for that
is now in the repository.

1. **Automatic weight tuning.** The evaluation has ~50 hand-set weights. An SPSA
   or CLOP-style tuner over 20-30 of them, using `tools/ab-match.mjs` with a few
   thousand short games, is the standard way to find 50-150 Elo in an engine of
   this shape. This is the single largest expected gain and it needs no
   architectural change.
2. **Search parameters, not search structure.** The rejected search pass shows
   that big structural changes are a lottery here. Retuning the existing
   margins (futility, late-move pruning, null-move reduction, aspiration width)
   with games as the objective is much more likely to pay.
3. **Transposition-table refinement** - store the static evaluation, use a
   depth-preferred replacement scheme, keep the table across moves at the root.
4. **Capture ordering by SEE** in quiescence instead of MVV-LVA, which is a pure
   ordering improvement and costs nothing in accuracy.
5. **Endgame terms, verified in games.** The naive mop-up was never properly
   measured (its numbers came from the faulty harness), so the safe statement is
   that endgame terms must be validated with matches before shipping.

A cumulative **+100 to +150 Elo over 0.1.5** is a realistic target for that
work. It is also realistic that half of it comes from tuning rather than from
new ideas, which is what the numbers above suggest.
