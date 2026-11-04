/**
 * tests/regression.test.js
 *
 * Quality guard-rails.  The other suites answer "is it legal and correct?";
 * this one answers "did the search get worse?" - which is the failure mode that
 * a legality test cannot see.
 *
 * Two kinds of guard:
 *
 *   1. **Pinned work.** The number of nodes needed to reach a fixed depth on a
 *      few reference positions, recorded from a known-good build
 *      (docs/results/baseline-0.1.5-depth10.json).  A change is allowed to move
 *      these around; a change that makes the search 25 % dumber is not.  The
 *      tolerance is deliberately generous, because node counts legitimately
 *      shift with any pruning or ordering change - the point is to catch a
 *      regression, not to freeze the tree.
 *
 *   2. **Tactics that must never break.** Mate-in-N positions that the search
 *      has always solved, a well-known tactical win, and the rule that the
 *      engine must not lose material on a free piece.  These run at a modest
 *      depth so the suite stays fast (~2 s).
 */

import { test, assert, assertEqual } from './harness.js';
import { createPosition } from '../src/core/position.js';
import { Searcher } from '../src/search/search.js';
import { moveToUci } from '../src/core/moves.js';

/** Nodes to depth 10 on the reference positions of a known-good build. */
const NODE_BASELINE = {
  startpos: 226117,
  italian: 446475,
  kiwipete: 897602,
  endgame: 60031,
};

const FENS = {
  startpos: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  italian: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6',
  kiwipete: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  endgame: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
};

const TOLERANCE = 0.25;

test('search still reaches depth 10 with a comparable tree size', () => {
  // Not a performance test: the tree may shrink (that is a win) as long as the
  // search finds the same depth and does not suddenly need far more nodes.
  for (const [name, fen] of Object.entries(FENS)) {
    const searcher = new Searcher({ hashMB: 64 });
    const result = searcher.go(createPosition(fen), { depth: 10 });
    const expected = NODE_BASELINE[name];
    assertEqual(result.depth, 10, `${name}: reached depth 10`);
    const ratio = result.nodes / expected;
    assert(
      ratio < 1 + TOLERANCE,
      `${name}: ${result.nodes} nodes is ${((ratio - 1) * 100).toFixed(1)} % more than the `
      + `${expected} recorded for this depth (limit ${TOLERANCE * 100} %)`,
    );
  }
});

test('mate suite: every position is solved by the search', () => {
  // [fen, mate in N moves, expected first move]
  // [fen, mate in N moves, a move that delivers the shortest mate].  The
  // distances were confirmed with a depth-14 search of the pre-change build.
  const mates = [
    ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 1, 'a1a8'],
    ['r5rk/5p1p/5R2/4B3/8/8/7P/7K w - - 0 1', 3, 'f6a6'],
    ['2k5/8/1K6/8/8/8/8/1Q6 w - - 0 1', 2, 'b1d1'],
    ['7k/6pp/8/8/8/8/5PPP/R5K1 w - - 0 1', 1, 'a1a8'],
    ['k7/8/1K6/8/8/8/8/1Q6 w - - 0 1', 2, 'b1h1'],
  ];
  for (const [fen, plies, expected] of mates) {
    const searcher = new Searcher({ hashMB: 16 });
    const result = searcher.go(createPosition(fen), { depth: 12 });
    assert(result.mate !== null, `${fen}: reported a mate score (got ${result.score})`);
    assertEqual(result.mate, plies, `${fen}: mate distance`);
    assertEqual(moveToUci(result.bestMove), expected, `${fen}: first move of the mate`);
  }
});

test('tactics: the search wins a free queen and finds the fork', () => {
  // Black queen is loose on d8 and White has Qxd8+ ... this is a plain win.
  const freeQueen = '3q3k/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
  let result = new Searcher({ hashMB: 16 }).go(createPosition(freeQueen), { depth: 8 });
  assert(result.score > 500, `free queen must score as a win, got ${result.score}`);

  // Knight fork on e6 picking up the queen.
  const fork = 'r1b1k2r/pppp1ppp/8/4N3/8/8/PPPP1PPP/R1B1K2R w KQkq - 0 1';
  result = new Searcher({ hashMB: 16 }).go(createPosition(fork), { depth: 8 });
  assert(result.score > 300, `knight fork must score well, got ${result.score}`);
});

test('quiet positions do not get a nonsensical score', () => {
  // Guard against a pruning change that silently returns a garbage evaluation.
  const searcher = new Searcher({ hashMB: 16 });
  const result = searcher.go(createPosition(FENS.startpos), { depth: 8 });
  assert(Math.abs(result.score) < 150, `start position must be near equal, got ${result.score}`);
});

test('a fixed node budget is still respected after the pruning changes', () => {
  const searcher = new Searcher({ hashMB: 16 });
  const result = searcher.go(createPosition(FENS.italian), { nodes: 20000 });
  assert(result.nodes <= 21000, `node limit respected (searched ${result.nodes})`);
  assert(result.bestMove !== 0, 'still returns a move under a node limit');
});

test('the search stays deterministic across pruning changes', () => {
  const run = () => {
    const searcher = new Searcher({ hashMB: 32 });
    const r = searcher.go(createPosition(FENS.kiwipete), { depth: 8 });
    return `${r.bestMove}|${r.nodes}|${r.score}`;
  };
  assertEqual(run(), run(), 'two identical searches agree exactly');
});
