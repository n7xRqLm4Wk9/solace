/**
 * tests/tools.test.js
 *
 * Tests for the supporting machinery: transposition table, perft divide,
 * benchmark harness and the move-ordering helpers.
 */

import { test, assert, assertEqual } from './harness.js';
import { Position } from '../src/core/position.js';
import { TranspositionTable, TT_EXACT, TT_LOWER, TT_UPPER } from '../src/search/transposition.js';
import { perft, perftDivide } from '../src/search/perft.js';
import { moveToUci, MoveList } from '../src/core/moves.js';
import { runBenchmark, BENCH_POSITIONS } from '../src/tools/bench.js';
import { scoreMoves, pickNext } from '../src/search/moveOrdering.js';

test('transposition table stores and retrieves entries', () => {
  const tt = new TranspositionTable(1);
  tt.newSearch();
  tt.store(1234, 5678, 4242, 99, 7, TT_EXACT);
  assert(tt.probe(1234, 5678), 'entry found');
  assertEqual(tt.entryMove, 4242);
  assertEqual(tt.entryScore, 99);
  assertEqual(tt.entryDepth, 7);
  assertEqual(tt.entryFlag, TT_EXACT);
  assert(!tt.probe(9999, 1111), 'different key does not match');
  assert(!tt.probe(1234, 5679), 'one word different does not match');
});

test('transposition table prefers deeper entries', () => {
  const tt = new TranspositionTable(1);
  tt.newSearch();
  tt.store(10, 20, 1, 50, 8, TT_LOWER);
  tt.store(10, 20, 2, 20, 3, TT_UPPER);
  assert(tt.probe(10, 20));
  assertEqual(tt.entryDepth, 8, 'shallow entry did not replace the deeper one');
  assertEqual(tt.entryMove, 1);
});

test('transposition table clear and resize keep it usable', () => {
  const tt = new TranspositionTable(2);
  tt.newSearch();
  tt.store(1, 2, 3, 4, 5, TT_EXACT);
  tt.clear();
  assert(!tt.probe(1, 2), 'cleared table has no entries');
  tt.resize(4);
  assertEqual(tt.sizeMB, 4);
  tt.newSearch();
  tt.store(7, 8, 9, 10, 11, TT_EXACT);
  assert(tt.probe(7, 8));
  assert(tt.hashfull() >= 0 && tt.hashfull() <= 1000);
});

test('perft divide agrees with perft', () => {
  const position = new Position().setStartPosition();
  const rows = perftDivide(position, 3, moveToUci);
  const total = rows[rows.length - 1].nodes;
  assertEqual(total, 8902, 'divide total matches perft(3)');
  assertEqual(perft(position, 3), 8902);
  assertEqual(rows.length, 21, '20 moves plus the total row');
});

test('benchmark runs every position and returns legal moves', () => {
  const result = runBenchmark({ depth: 2, verbose: false });
  assertEqual(result.totals.positions, BENCH_POSITIONS.length);
  assertEqual(result.totals.illegalMoves, 0, 'no illegal moves in the benchmark');
  assert(result.totals.nodes > 0, 'searched nodes');
  assert(result.results.every((r) => r.legal), 'every best move legal');
});

test('move ordering puts the TT move and captures first', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const list = new MoveList(256);
  position.generateMoves(list);
  const ttMove = position.parseMove('d5e6');
  const killer1 = new Int32Array(128);
  const killer2 = new Int32Array(128);
  const history = new Int32Array(2 * 4096);
  scoreMoves(list, ttMove, position.side, 0, killer1, killer2, history);
  const first = pickNext(list, 0);
  assertEqual(first, ttMove, 'TT move ordered first');

  // Without a TT move the first move must be a capture.
  scoreMoves(list, 0, position.side, 0, killer1, killer2, history);
  const firstWithoutTT = pickNext(list, 0);
  const target = position.board[(firstWithoutTT >>> 6) & 63];
  assert(target !== 0 || moveToUci(firstWithoutTT).endsWith('q'), 'captures and promotions come before quiet moves');
});

test('capture ordering prefers the most valuable victim', () => {
  const position = new Position().setFen('4k3/8/8/3q4/8/8/4P3/3RK3 w - - 0 1');
  const list = new MoveList(256);
  position.generateMoves(list);
  scoreMoves(list, 0, position.side, 0, new Int32Array(128), new Int32Array(128), new Int32Array(8192));
  const first = pickNext(list, 0);
  assertEqual(moveToUci(first), 'd1d5', `rook takes queen should be ordered first, got ${moveToUci(first)}`);
});

test('killer moves are remembered per ply', () => {
  const tt = new Int32Array(0);
  void tt;
  const position = new Position().setFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  const list = new MoveList(256);
  position.generateMoves(list);
  const killer1 = new Int32Array(128);
  const killer2 = new Int32Array(128);
  const history = new Int32Array(8192);
  const killer = list.moves[3];
  killer1[5] = killer;
  scoreMoves(list, 0, position.side, 5, killer1, killer2, history);
  let best = 0;
  for (let i = 0; i < list.count; i++) best = Math.max(best, list.scores[i]);
  let killerScore = -1;
  for (let i = 0; i < list.count; i++) if (list.moves[i] === killer) killerScore = list.scores[i];
  assertEqual(killerScore, best, 'killer gets the highest score among quiet moves');
});
