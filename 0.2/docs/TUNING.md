# Tuning Solace

Stockfish's search constants are tuned for long time controls on desktop
hardware (the engine's own comments say the marked values are "optimized to
time controls of 180 + 1.8 and longer"). Solace 0.2 runs in a browser at about
one second per move on one thread, which is a completely different regime: a
few hundred thousand nodes per move instead of tens of millions.

So Solace exposes the parameters that matter most as *scales* of the upstream
values. 100 % always reproduces Stockfish 19 exactly, which is also the
reference point every match is measured against.

| UCI option | what it scales | 100 % = |
|---|---|---|
| `Solace Tuning` | preset: `Solace 0.2` (default) or `Stockfish 19` | — |
| `Solace LMR Scale` | the late-move-reduction amount, `Worker::reduction()` | 982 and the `reductions[]` table |
| `Solace Pruning Scale` | futility margins and SEE-based pruning thresholds | `119*lmrDepth + 90*(...) + 164`, `234 + 247*lmrDepth`, `-23*lmrDepth²`, `177*depth` |
| `Solace History Scale` | the divisor turning history into extra LMR depth | `lmrDivisor[16]` |
| `Solace Optimism Scale` | the time-dependent optimism added to the NNUE evaluation | `114 * avg / (|avg| + 85)` |

All four are plain percentages, so `Solace Pruning Scale=110` prunes 10 % more
aggressively than Stockfish and `=90` 10 % less. `Solace Tuning=Stockfish 19`
resets every scale to 100.

## How the preset was chosen

Two engines that are identical except for one option play each other; the same
opening set is used twice with colours swapped, and the rules (legality, mate,
stalemate, fifty-move, threefold, insufficient material) are enforced by the
independent board model of the 0.1.5 engine, so a broken build cannot "win" by
playing illegal moves.

```sh
node 0.2/tools/match.mjs \
  --engine-a ./engine-cli --engine-b ./engine-cli \
  --a "Solace Tuning=Stockfish 19" --b "Solace Tuning=Stockfish 19,Solace LMR Scale=115" \
  --games 300 --movetime 30 --concurrency 2
```

`--engine-a` can be any UCI binary: the native build used for tuning, the
WebAssembly build (`node 0.2/cli.mjs`), or a released Stockfish, so the same
script also gives an honest "how strong is this really" number.

### Results

Run in this container (2 vCPU), 16 opening lines × colours swapped, 30 ms/move,
1 thread, hash 16 MB. "A" is always the Stockfish 19 parameter set, "B" the
variant:

| B (variant) | games | A wins | B wins | draws | score for A | 95 % for A | Elo (B − A) |
|---|---|---|---|---|---|---|---|
| `Solace LMR Scale=115` | 120 | 41 | 39 | 40 | 50.83 % | −49 … +61 | −5.8 |
| `Solace LMR Scale=85` | 120 | 45 | 40 | 35 | 52.08 % | −43 … +73 | −14.5 |
| `Solace Pruning Scale=110` | 120 | 43 | 39 | 38 | 51.67 % | −44 … +68 | −11.6 |
| `Solace Pruning Scale=90` | 120 | 47 | 30 | 43 | 57.08 % | −11 … +110 | −49.6 |
| `Solace History Scale=115` | 120 | 38 | 29 | 53 | 53.75 % | −36 … +90 | −26.1 |
| `Solace Optimism Scale=50` | 120 | 44 | 28 | 48 | 56.67 % | −15 … +112 | −46.6 |

Reading the table: with 120 games the 95 % interval is roughly ±50–60 Elo, so
only large effects are visible. **Every one of the six variants lost ground**,
and the three clearest losses are about −50 Elo each (10 % less pruning, more
history weight, half the optimism). The measured message is negative but useful:
at 30 ms/move the Stockfish 19 constants beat every scaled variant tried here,
so no search-parameter change ships as a default. `Solace 0.2` keeps the upstream
numbers and the options stay available for further tuning.

The runs also show how noisy this time control is, which is the argument for not
believing single small results. `Optimism Scale=50` was at 28.6 % for A after
seven games and finished at 56.7 % — a 28-point swing over 113 games with the
*same* engines. Any candidate that is decided by a handful of games at 30 ms is
probably noise, which is why no variant is shipped as an improvement.

The raw results of the last two matches are archived in
[`results/`](results/) (per game: opening, colours, length, result); the four
earlier ones survive as the aggregates above.

Three honest caveats:

* 120 games per variant cannot resolve a 10-Elo effect; a claim like "Solace
  searches better than Stockfish" would need thousands of games, and no such
  claim is made anywhere in this project.
* the matches ran on a *native* x86 build of exactly the same sources. It
  searches the identical node counts as the WebAssembly build (`bench 1` =
  1 808 810 nodes in both), so the search being measured is the same code; only
  the wall clock differs, which is what makes thousands of games affordable.
* tuning happened at 30 ms/move, which is much less thinking time than the
  browser's own default of one second per move. A parameter that is neutral at
  30 ms could still matter at one second, so the results decide "do not change
  the defaults", not "the upstream values are optimal".

### What the browser build does change

Two changes are made for playing in a page, and neither is a strength claim:

**The time reserve is measured, not assumed.** Stockfish's `Move Overhead` is
only used when a search is bounded by a clock (`go wtime … btime …`); a
`go movetime X` search stops at exactly X, whatever `Move Overhead` says. The
page sends `movetime`, so it subtracts the reserve itself: `web/overhead.js`
times every answer, keeps the worst of the last twelve, and
`searchTime()` requests `budget − reserve` with the reserve clamped to 50–500 ms.
So a desktop asks for ~950 ms of a 1 s budget and a phone with janky scheduling
asks for less, instead of overrunning and stuttering. `Move Overhead` is still
set on the engine so a client that uses clocks (the CLI, UCI integration) gets
the same protection from Stockfish's own time manager.

**The opening is varied.** A small book (`web/book.js`) plays one of a handful
of sane first moves for the first six plies, so two games in a row are not the
same game. It is book *variety*, not book theory: the engine leaves the book as
soon as the position is not in the (deliberately tiny) table.

Playing on a phone also changes how long to search and how much memory to use;
that is a separate subject with its own measurements — see
[MOBILE.md](MOBILE.md).
