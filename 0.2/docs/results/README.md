# Raw match results

Each file here is one full self-play screening match from
[`../TUNING.md`](../TUNING.md), written by
[`tools/match.mjs`](../../tools/match.mjs) with `--json`. The move lists are
trimmed to one entry per game (`plies`), because the full game scores are
several hundred kilobytes each and the aggregate is what the table uses.

```json
{
  "label": "opt50",
  "engineB": { "Solace Tuning": "Stockfish 19", "Solace Optimism Scale": "50" },
  "movetime": 30,
  "games": 120,
  "winsForA": 44, "winsForB": 28, "draws": 48,
  "scoreForA": 0.5667,
  "eloForB": 46.6,
  "results": [ { "opening": "e2e4 e7e5 ...", "whiteIsA": false, "plies": 164, "result": "B" } ]
}
```

`whiteIsA` alternates, so every opening is played once with each colour.
`result` is `A`, `B` or `draw`; a game that hits the 250-ply cap or the
fifty-move rule counts as a draw, and legality, mate, stalemate, threefold and
insufficient material are adjudicated by the independent board model of the
0.1.5 engine, not by the engines themselves.

Archived so far: `hist115.json`, `opt50.json` — the last two runs. The four
earlier matches (LMR ×1.15 / ×0.85, pruning ×1.10 / ×0.90) were run before this
folder existed and survive only as the aggregates printed in `TUNING.md`; their
numbers are reproduced exactly as reported, with no per-game data claimed for
them.

Reproduce any row with:

```sh
node 0.2/tools/match.mjs --engine-a <native-0.2-build> --engine-b <same> \
  --a "Solace Tuning=Stockfish 19" \
  --b "Solace Tuning=Stockfish 19,Solace Optimism Scale=50" \
  --games 120 --movetime 30 --concurrency 2 --json /tmp/tune-opt50.json
```
