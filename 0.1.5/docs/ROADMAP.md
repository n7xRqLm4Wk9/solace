# SOLACE 0.1.5 — where it stands and what to do next

This document is the result of reading the 0.1.5 sources and measuring them, not
of guessing from other engines. **No engine code was changed to produce it**: it
is an assessment plus a prioritised plan, so that the next changes can be
justified and measured instead of hoped for.

Nothing here is a strength claim. Every number below was produced on the machine
and software listed under [Reproducing the numbers](#reproducing-the-numbers);
where a number is an expectation rather than a measurement it is labelled
*expected*.

---

## 1. What the engine is today

| | |
|---|---|
| search | iterative deepening PVS, aspiration windows, TT, null move, RFP, futility, LMR, LMP, check extension, quiescence with SEE + delta pruning |
| evaluation | tapered handcrafted, ~44 tunable weights, one allocation-free pass |
| board | 32-bit word-pair bitboards, magic sliders, pseudo-legal generation + make/verify |
| interface | full UCI (+ `d`, `eval`, `perft`, `bench`, `help`), CLI, Web Worker |
| tests | 160, ~8 s, no dependencies |
| size | 5.3 k lines of engine JavaScript (8.9 k including tests and tools) |

### What is genuinely strong

1. **Correctness infrastructure.** Perft against published counts, a second
   deliberately slow generator that is compared move-for-move, an optional
   `VerifyMoves` mode that re-checks attack detection at every node, incremental
   Zobrist keys re-derived from scratch during random games, and make/unmake
   round trips compared to the original FEN. This is better than most hobby
   engines and it is why performance work can be done at all without breaking
   legality.
2. **Allocation-free hot paths.** Typed arrays everywhere, move lists preallocated
   per ply, no objects per node. Measured GC time during a depth-10 search: 0.5 %
   (profile below).
3. **A clean split** between `core/`, `eval/`, `search/` and `uci/`, with the UCI
   adapter free of search logic and the search callable directly from tests.
4. **It already does the things that are easy to get wrong**: mate-distance
   pruning, mate-score correction in the TT, fifty-move and repetition detection
   inside the tree, an aborted search that still returns a legal move, and
   determinism at fixed depth (there are tests for all of these).

### What is weak

1. **The pruning is conservative, and some of it is effectively dead code.** The
   late-move-pruning threshold is `legalMoves > 14 + 6·depth`, i.e. more than 32
   legal moves at depth 3 and more than 44 at depth 5. Most middlegame positions
   have 30-40 legal moves, so LMP almost never fires (measured: raising its depth
   limit from 3 to 5 changed node counts by 1 %). Raising `depth <= 3` to
   `depth <= 5` alone is a no-op on realistic positions.
2. **Move ordering is basic.** Captures are ordered by MVV-LVA only — SEE is
   computed for *filtering* in quiescence but never for *ordering*. Quiet moves
   are ordered by a single `(side, from, to)` history table plus two killers and
   one countermove. There is no capture history, no 1-ply continuation history,
   no history bonus proportional to depth², and no SEE-based "bad captures last".
3. **The transposition table is shallow.** One slot per index, no buckets, no
   depth-preferred replacement across slots, and no stored static evaluation
   (so the same position is re-evaluated instead of read). The default `Hash` of
   16 MB is also too small for the depths the engine reaches: on the reference
   middlegame at depth 12, 16 MB costs 2,510,908 nodes against 1,946,941 with
   256 MB — **22 % more nodes**, and hashfull is already 66 % at 16 MB.
4. **Evaluation dominates the node cost** (below) and is missing several standard
   terms: no space/centre control, no candidate passers, no opposite-coloured
   bishop scaling in the endgame, no scaling of passed-pawn scores by remaining
   material, no "safe check" term, and the doubled/isolated penalties are flat
   constants rather than being aware of the file or rank. King safety does have a
   weighted attack count with a quadratic penalty (`kingAttackWeight`,
   `kingDangerDivisor`, `kingDangerMax`); what it lacks is the surrounding shape —
   it is not damped when the attacking side has no queen, and mobility is counted
   without a "mobility area" (own pawns and enemy pawn attacks are not excluded).
5. **No automated tuning.** The ~44 weights were set by hand. `docs/STRENGTH.md`
   already identifies weight tuning as the largest expected gain, and nothing in
   the repository does it.
6. **Strength measurement is under-powered.** `tools/ab-match.mjs` works and is
   fast (2.2 s/game at fixed depth 6, 6.3 s/game at 70 ms/move) but there is no
   sequential test, no resumable match, no fixed-node mode (to separate search
   quality from speed), and no record of past results in machine-readable form.
7. **No performance/regression snapshots.** Nothing fails if a change makes the
   search 30 % slower or 30 % dumber; the test suite checks legality, not quality.

---

## 2. Where the time actually goes

### Profile (CPU sampling, 3 positions, depth 10, 1.44 M nodes, 3.67 s)

| function | self time | share |
|---|---|---|
| `evaluateBothSides` | 1237 ms | **33.1 %** |
| `negamax` | 358 ms | 9.6 % |
| `isAttacked` | 257 ms | 6.9 % |
| `makeMove` | 235 ms | 6.3 % |
| `quiescence` | 228 ms | 6.1 % |
| `scoreMoves` | 153 ms | 4.1 % |
| `unmakeMove` | 141 ms | 3.8 % |
| `rookAttacks` / `bishopAttacks` / `queenAttacks` | 263 ms | 7.1 % |
| `generateSliderMoves` / `generatePawnMoves` / `generateMoves` | 292 ms | 7.9 % |
| `evaluate` (wrapper) | 97 ms | 2.6 % |
| `popcount` | 55 ms | 1.5 % |
| `see` + `leastValuableAttacker` | 103 ms | 2.8 % |
| TT `store`, `probe`, `clear` | 69 ms | 1.9 % |
| garbage collector | 18 ms | 0.5 % |

### Cost per node (instrumented copy, same positions, depth 10)

| operation | calls per node | measured cost per call |
|---|---|---|
| `evaluate` | 0.81-0.87 | 1145-1280 ns |
| `makeMove` | 2.26-3.13 | 60 ns |
| `generateMoves` | 0.39-0.51 | 842 ns (48 moves) |
| `isAttacked` | 4.90-5.42 | 20 ns |
| `repetitionCount` | 1.00 | ~30 ns |
| `tt.probe` | 1.00 | ~30 ns |
| `tt.store` | 0.39-0.51 | ~40 ns |
| `see` | 0.45 | ~34 ns |

Read together: **evaluation is 33-40 % of search time, and one evaluation happens
per node** — because the quiescence search evaluates a stand-pat score at every
node, and 46-67 % of all nodes are quiescence nodes. The rest is spread thin: no
single function exceeds 10 %.

A direct measurement of the ceiling: replacing `evaluate()` with `return 0` raises
throughput from 372 k to 864 k nps (224 k nodes instead of 1.63 M, so the tree
collapses as well — it is an upper bound, not a target). Evaluation is clearly
more than a third of the wall clock of a real search.

### Splitting the evaluator

Material + piece-square alone cost **210 ns**; the interaction terms (mobility,
pawn structure, threats, king safety) are the remaining ~1070 ns, i.e. **85 % of
the evaluation**. That kills the obvious idea (see §5, experiment D): a lazy gate
around the expensive part only fires where the search was already going to cut
off, and measured +3.6 % throughput.

### Search statistics

Effective branching factor on the reference Italian middlegame (fresh TT per
depth, 64 MB):

| depth | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|
| nodes | 23,290 | 54,373 | 116,811 | 245,392 | 446,475 | 1,112,805 | 2,051,272 |
| EBF | 1.92 | 2.33 | 2.15 | 2.10 | 1.82 | 2.49 | 1.84 |

An EBF near 2.0 is respectable for a JavaScript engine but well above the 1.6-1.8
a modern tuned engine reaches; combined with the conservative pruning above, this
is the clearest *node-side* opportunity. The score also wobbles between iterations
(…51, 57, 62, 54…) and changes with a one-line pruning edit, which is what weak
ordering looks like from the outside.

---

## 3. Bottlenecks, ordered by expected value

| # | bottleneck | evidence | who pays |
|---|---|---|---|
| 1 | pruning that never fires; no modern margins | LMP inert at depth ≤ 5 (+1 % nodes when extended) | every node |
| 2 | ordering without SEE / continuation history | EBF 2.1, unstable scores, MVV-LVA only | every node |
| 3 | `evaluate` at 1145-1280 ns, once per node | 33 % of profile; 0.87 calls/node | every node |
| 4 | TT: one slot, no static eval, 16 MB default | 22 % more nodes than 256 MB at d12 | deep nodes |
| 5 | missing evaluation terms | reading `evaluate.js`; no space/OCB/scaling | decision quality |
| 6 | untuned weights | 44 hand values, no tuner | decision quality |
| 7 | weak measurement/regression tooling | no SPRT, no snapshots | development speed |

---

## 4. Is a pure-JavaScript NNUE realistic here?

Short answer: **technically yes, strategically not yet.** The reasons, with the
arithmetic in the open rather than a hand-wave:

**What it would cost at run time.** A HalfKP-style net (40,960 inputs per side)
with 256-wide accumulators is 2 × 40,960 × 256 weights ≈ 21 M parameters, i.e.
21 MB at int8 or 42 MB at int16, and a forward pass of 2 × 256 → 32 → 1. A pure
JavaScript implementation would need int16 accumulators updated per move
(≈ 256 adds per changed piece) and then ~16 k multiply-accumulates per
evaluation. That is affordable *only* if the accumulator is incremental; a
from-scratch pass would be several microseconds and would sink the 1.1 µs the
current evaluator costs.

**What it would cost to train.** This is the real blocker. A net needs weights,
and there is no trainer, no dataset and no compute budget in this project. A
usable net needs on the order of 10⁷-10⁸ positions labelled by search, and a
gradient-descent trainer (in JS, on one thread) to fit 10⁶-10⁷ parameters. That
is weeks of wall clock for a result that may not beat a well-tuned handcrafted
evaluation at this scale — published results only clearly favour NNUE once the
net is big enough that JavaScript inference becomes the bottleneck instead.

**The version that fits this project.** A small net over *piece × square*
features (768 inputs, optionally with a king bucket) with one hidden layer:

| architecture | parameters | int8 size | inference (est.) |
|---|---|---|---|
| 768 → 32 → 1 | 24,641 | ~25 KB | ~80-150 ns with an incremental accumulator |
| 768 → 64 → 32 → 1 | 51,265 | ~51 KB | ~150-250 ns |

Such a net is (a) trainable in pure JS from self-play with a proper data pipeline,
(b) small enough to be incrementally updated in `makeMove`/`unmakeMove`, and
(c) honest about its limits: it sees material and piece placement, not the pawn
structure and king-safety interactions the handcrafted evaluator models explicitly.

**Verdict and gate.** Treat NNUE as *phase 5*, not phase 1:

* it must not replace the handcrafted evaluator until it wins a match;
* the handcrafted evaluator stays available as a fallback (an `EvalFile` /
  `EvalMode` UCI option, default handcrafted until the gate is passed);
* the gate is **+30 Elo at 95 % confidence over ≥ 2 000 games** at two time
  controls, with the incumbent as the baseline;
* the prerequisite work (a data pipeline that records positions and results, and
  an automated tuner) is *the same work* needed for weight tuning in phase 3, so
  starting with tuning costs nothing even if NNUE is later abandoned.

The likely outcome, stated plainly so it is not a surprise later: a 768→32→1 net
trained on a few million self-play positions will probably land within ±30 Elo of
the tuned handcrafted evaluator, not far above it. The step that historically
wins big is HalfKP *with* the handcrafted terms' knowledge — and that one does not
fit this project's constraints yet.

---

## 5. Pilot experiments already run (all reversible, none shipped)

These were done on throw-away copies to check that the plan's assumptions are
true. "nodes" are identical-workload counts (3 positions, depth 10, fresh TT);
"sig" is the score triplet of those positions, which must stay identical for a
pure speed change.

| id | change | nodes | time | nps | sig | verdict |
|---|---|---|---|---|---|---|
| — | baseline | 1,631,861 | 4388 ms | 371,892 | 47 / −87 / 117 | — |
| A | remove the per-node closure in `negamax` | 1,631,861 | 4342 ms | 375,832 | identical | +1.1 %, free, keep |
| B | repetition scan strides 2 plies (only same-side positions can repeat) | 1,631,861 | 4222 ms | 386,514 | identical | +3.9 %, free, keep |
| C | late-move pruning depth 3 → 5 (same threshold) | 1,653,536 | 4253 ms | 388,793 | 51 / −87 / 117 | **inert**: the threshold almost never fires |
| C′ | modern LMP threshold `(3 + d²)/2`, depth ≤ 6 | 1,377,413 | 4008 ms | 343,666 | 104 / −87 / 0 | −16 % nodes at d10, −31 % at d12 — promising, needs a match |
| D | staged evaluation (material+PST first, skip the rest when decided) | 1,649,137 | 4278 ms | 385,493 | 55 / −63 / 117 | +3.6 % only: the gate rarely fires at a sound margin |

Experiment D detail, because it is the one that eliminates an attractive-looking
idea: the difference between the full evaluation and material+PST over 1,399
positions from random games is median 57 cp, p99 372 cp, max 420 cp. A sound
margin is therefore ≥ 420 cp, and with a margin that large the cheap score is
almost never decisive at the moment the search needs it.

---

## 6. Results since this assessment (phase 0, first phase 1 round, ordering round)

`docs/STRENGTH.md` §8 has the numbers; the summary that changes the plan:

* **Shipped:** two provable no-op speed fixes (repetition scan 85.3 -> 60.7 ns
  per call, no closure per node), default `Hash` 16 -> 32 MB (-11 % nodes at
  depth 12), plus the measurement tooling this document asked for:
  `tools/progress.mjs`, `nodes:N` matches in `tools/ab-match.mjs` with a 95 %
  interval, and `tests/regression.test.js` (pinned tree size, mate suite,
  tactical sanity, determinism).
* **Rejected, with numbers:** aggressive late-move pruning (-163 Elo at equal
  depth for 31 % fewer nodes), continuation-history ordering (+9 % nodes),
  SEE-based capture demotion (306 knps vs 376).

The LMP result is the important one: it says the engine's *ordering* is not good
enough to support sharper pruning, so phase 1 items are reordered below - capture
and quiet ordering work comes first, and every pruning change is now judged with
`nodes:N` matches (equal work) *and* `movetime` matches (equal time).

**Follow-up round: the ordering hypothesis was tested and rejected** (STRENGTH.md
§9). Eight ordering candidates - piece-to history, depth-squared history bonus,
mild continuation history, capture history, history malus, history aging,
piece-to + from-to, history allowed to outrank killers - were screened on the
depth-10 workload. Seven grew the tree (by 0.6 % to 26.6 %); the two best were
then played at **equal nodes** over 240 games each and both lost: piece-to
**-66 Elo** (95 %: -104..-30), history aging **-44 Elo** (95 %: -83..-6).

`tools/ordering-report.mjs` (new) explains why: 92 % of beta cutoffs already
happen within the first three moves, so there is almost nothing left for ordering
to win, while 29 % of internal nodes are all-nodes that search 32 moves each.
That is also the real reason the aggressive LMP cost 163 Elo: it was removing the
defences of all-nodes, not skipping doomed moves in cut-nodes.

Consequences, applied below: **ordering work is closed for now**, pruning is
deferred until it can be guarded properly, and **evaluation work moves to the
front**.

**Passed pawns were tested first; neither candidate is kept** (STRENGTH.md §10).
A broad feature bundle lost **-163 Elo** at 240 equal-node games (95 %:
-209..-122). A restrained rank/protection/connected/rook refinement scored
+22 Elo, but was inconclusive (95 %: -15..+59) and failed the pinned startpos
tree-size guard at +43.5 %. The evaluator was unchanged by either passer candidate: do not call the latter
a win based on its positive point estimate.

**King safety, focused first change:** attenuate the existing ring-danger
penalty to 75 % when the attacking side has no queen. At equal nodes over 240
games it scored 120-45-75 (**+112 match-implied Elo**, 95 %: +76..+151), with
zero illegal moves. It adds +1.4 % nodes to the fixed-depth benchmark; the paired
nps difference was -1.2 %. All 169 tests pass. Details: STRENGTH.md §11.

A second king-safety idea (gate open-file penalties on an enemy rook/queen) was
rejected at equal nodes: **-89 Elo** (95 %: -133..-47; STRENGTH.md §12). Following
the requested priority, the next pawn-structure change adds a modest backward
pawn penalty. It scored **+66** at equal nodes (95 %: +23..+111); two 240-game
fixed-time matches pooled to **-1 Elo** (95 %: -27..+26), so fixed-time is
neutral, not a claimed gain. The depth-10 workload fell 20.9 % in nodes and the
full suite passes 170/170 (STRENGTH.md §13). Keep this isolated term, but do not
extrapolate the equal-node score to fixed-time strength.

## 7. The plan

Each phase lists the change, the expected benefit (labelled), the risk, and the
tests that have to pass. **No phase ships without a match result** unless it is a
provable no-op (bit-identical scores, e.g. A and B above).

### Phase 0 — measurement first (half a day, no strength change)

Rationale: every later phase needs to answer "did this help?" cheaply and
honestly, and the current tooling cannot.

1. `tools/progress.mjs` — fixed-node and fixed-depth runs over the benchmark
   positions, printing nodes, time, nps and the score of each position, with
   `--json`. Written to `docs/results/` so numbers are comparable over time.
   Done, plus `tools/ordering-report.mjs`, which measures cutoff distribution and
   the all-node share - the two numbers that decide whether ordering or pruning
   work can pay at all.
2. `tools/ab-match.mjs` — add `--nodes N` (equal-work matches, so search quality
   is measured without a speed advantage), `--resume`, and a sequential
   likelihood-ratio report (H0: 0 Elo, H1: +5 Elo, α = β = 0.05) alongside the
   existing Elo estimate.
3. `tests/regression.test.js` — pin per-position depth-8 node counts and best
   moves to ±10 %, plus a table of mate-in-N positions that must be solved. This
   is the guard that stops a "speed" change from silently costing strength.
4. Record the baseline in `docs/results/baseline-0.1.5.json`.

Risk: none (tooling only). Tests: the existing 160 must stay green.

### Phase 1 — search: fewer nodes at equal depth (largest expected gain)

Ordered by expected value per hour:

**Ordering: closed.** Eight candidates, two equal-node matches, no gain (§6 above
and STRENGTH.md §9). Do not re-open this until the search has the pieces that
make modern ordering pay (two-slot TT buckets, SEE pruning, singular
extensions) - adding the ordering heuristics on their own measurably loses.

**Pruning: deferred, with a specification.** When it is retried, the guarded
version must satisfy all of these, each of which was missing from the version
that lost 163 Elo:
* never prune when the node is already failing low (no cut has been found yet
  and `beta - alpha == 1`), because that is exactly the all-node case that owns
  29 % of the tree;
* never prune when a mate score is in flight (`|bestScore| >= MATE_THRESHOLD`);
* count *quiet* moves searched, not legal moves, and require at least a handful
  before the first cut;
* exclude moves that give check (already done) and promotions (already done);
* validate with `nodes:N` at two budgets *and* `movetime` - the two disagree
  often enough to matter (§8.2, §9.2).

Then the remaining phase 1 items stand:

1. **Transposition table.** Store the static evaluation and use 2-slot buckets
   with depth-preferred replacement; the default `Hash` is now 32 MB (measured
   16 -> 32 MB is -11 % nodes at depth 12, and 32 -> 64 MB a further -5 %, which is
   available to desktop users through the option rather than as a new default,
   because 0.1.5 targets phones first).
2. **Aspiration and re-search policy.** Width by depth and by how stable the
   previous iterations were, rather than a fixed 25 cp; on a fail, re-search with
   the TT move forced first. *Expected*: small but cheap; risk near zero.
3. **"Improving" heuristic** for RFP and futility margins. *Expected*: 5-10 %;
   needs a match, because it is a pure search-shape change.

Testing: each item is a separate branch with (a) identical-score checks for
order-only changes, (b) a node/nps table, (c) a 600-game match at 70 ms/move and
one at fixed nodes, (d) the full test suite. Items are kept only if the match is
non-negative at 95 % confidence, or clearly positive with fewer nodes.

### Phase 2 — evaluation: cheaper and better shaped

1. **Speed (target 1.3× on `evaluate`, ~10 % overall nps).** Inline the attack
   generation instead of the module-level `ATK_LO`/`ATK_HI` ping-pong; compute one
   popcount per mask pair; hoist the piece-bitboard loads; keep the phase counter
   incrementally in `makeMove`/`unmakeMove`; skip mobility for pieces that cannot
   move. Every step is provable as a no-op and must produce identical scores on the
   whole benchmark.
2. **Incremental material + PST** in `makeMove`/`unmakeMove` (exact, no drift, and
   a prerequisite for any later lazy scheme). Verify with a property test that
   compares the incremental value with a from-scratch pass after every move of long
   random games — the same pattern already used for Zobrist keys.
3. **Shape.** Add the missing standard terms one at a time, each behind a weight:
   space/centre control, candidate passers, opposite-coloured-bishop scaling in
   endgames, passed-pawn scaling by material, and a proper attack-count shape in
   king safety. *Expected*: 10-40 Elo if the terms are right; each one needs a
   match, and the previous experience in this repository (a rejected search
   package at −67 Elo) is the reason they are not bundled together.

### Phase 3 — automatic weight tuning (best expected Elo per hour)

SPSA over ~25 of the 44 weights (the ones that are continuous), using the match
harness at short time controls and paired openings. Throughput measured here:
2.2 s/game at depth 6, 6.3 s/game at 70 ms/move, so a 1 000-game iteration is
35 min-1.8 h. *Expected*: +30-80 Elo is the usual outcome for an untuned engine of
this shape — but that is an expectation from the field, not a measurement, and it
will be reported as a measured match or not at all. Risk: tuning to self-play on
one opening set overfits; mitigate with a held-out opening set and two time
controls. Tests: the tuned weights become a data file, and a test asserts the
engine still finds the mate suite and stays colour-symmetric.

### Phase 4 — time management

Small but visible at bullet speed: predict the cost of the next iteration from the
previous ones (EBF estimate) and stop *before* starting an iteration that cannot
finish, keep the `Move Overhead` subtraction, and use the stability of the best
move as a stop signal. *Expected*: a few percent at fast time controls; the risk
is losing games on time, so the guard is the existing time-limit test plus a match
with a hard 50 ms/move.

### Phase 5 — NNUE, only if phases 1-3 have landed

As analysed in §4: 768→32→1 first (trainable in JS, ~25 KB, incremental
accumulator), behind an option, gated on +30 Elo over 2 000 games. The data
pipeline and tuner it needs are the ones built in phases 0 and 3.

### Explicitly not doing

* No C++, no WebAssembly, no external engine code, no npm dependencies.
* No "rewrite the search from scratch" — the pilots show the existing structure
  responds to targeted changes.
* No multi-threading: the browser build's contract is one Worker, and lazy SMP in
  JavaScript would fight the engine's own determinism tests.
* No strength claim without a match of the stated size.

---

## 8. Measurement protocol (so results mean something)

1. **Two kinds of test, never mixed.** *Equal work* (fixed nodes or fixed depth)
   answers "is the search smarter?"; *equal time* (movetime) answers "is it
   stronger?" A change that wins the first and loses the second is a speed
   regression.
2. **Sample size.** 10 games between two identical engines scored 7/10 (70 %) in
   this environment — a perfect illustration that small matches prove nothing.
   A 200-game match resolves about ±50 Elo; the plan uses ≥ 600 games for
   "keep it" decisions and ≥ 2 000 for the NNUE gate.
3. **Paired openings, colours swapped**, adjudication by rules only (already the
   behaviour of `ab-match.mjs`), fresh TT per game.
4. **Record everything** in `docs/results/*.json`, including losses. The two
   rejected experiments already published in `docs/STRENGTH.md` stay published.
5. **Never weaken a test to make a change pass.** If a change needs a test
   changed, the test change is part of the review.

---

## 9. Reproducing the numbers

```sh
cd 0.1.5

# sanity and correctness
node tests/run.js                     # 160 tests
node cli.js perft 5                   # 4865609 nodes
node cli.js bench 6                   # 12 positions, fixed depth

# the fixed workload used in §5 and §9 (7 positions, fresh TT each)
node tools/progress.mjs --depth 10
node tools/ordering-report.mjs        # cutoff distribution and all-node share

# profiles
node --cpu-prof tools/progress.mjs --depth 10

# matches (both arguments are checkouts; the second is the baseline)
node tools/ab-match.mjs . /path/to/baseline 600 movetime:70
node tools/ab-match.mjs . /path/to/baseline 600 depth:6
```

Environment for every number in this document: Linux x86-64, 2 vCPU container,
Node.js v22.22.3, single process, no other load. Absolute speeds on a phone are
lower; the ratios and node counts are what the plan relies on.

---

## 10. Decisions taken

1. **Target: phone first, desktop where it costs nothing.** Given directly:
   *"phone friendly/desktop friendly if possible but phone more forward"*. What
   that means concretely:
   * the default `Hash` is 32 MB — enough to avoid the 11 % node penalty measured
     at 16 MB, small enough for a phone tab; desktop users raise it through the
     option (up to 512 MB);
   * per-node *time* is the priority over tree size, which is why the aggressive
     pruning was rejected on quality rather than kept on node count;
   * the browser worker keeps `Threads`-free single-threaded operation and the
     evaluation stays allocation-free, so the UI thread and the phone's GC see
     the same load as before;
   * nothing introduced may need more than the existing test suite's runtime or
     any non-Node tool.
2. **NNUE: deferred, not started.** It stays phase 5 and gated on +30 Elo at
   95 % over 2 000 games. No code was written for it in this round; the roadmap
   keeps the analysis so the decision can be revisited once phases 1-3 have
   been measured. If you want it earlier, say so and it becomes phase 2 —
   the plan and the gate stay the same either way.
