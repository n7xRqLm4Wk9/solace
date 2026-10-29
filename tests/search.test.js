/**
 * tests/search.test.js
 *
 * Search behaviour: termination, legality of the chosen move, mate finding,
 * limits, statistics and internal consistency checking.
 */

import { test, assert, assertEqual } from './harness.js';
import { Position } from '../src/core/position.js';
import { Searcher, MATE, MATE_THRESHOLD } from '../src/search/search.js';
import { MoveList, moveToUci } from '../src/core/moves.js';
import { verifyConsistency } from '../src/core/verify.js';
import { playRandomGame } from './helpers.js';

function isLegal(position, move) {
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  for (let i = 0; i < list.count; i++) if (list.moves[i] === move) return true;
  return false;
}

test('fixed-depth search returns a legal move and statistics', () => {
  const position = new Position().setStartPosition();
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { depth: 4 });
  assert(isLegal(position, result.bestMove), 'best move is legal');
  assertEqual(result.depth, 4, 'reached the requested depth');
  assert(result.nodes > 0, 'searched some nodes');
  assert(result.nps > 0, 'reported nodes per second');
  assert(Array.isArray(result.pv) && result.pv.length > 0, 'has a principal variation');
  assert(result.pv[0] === result.bestMove, 'PV starts with the best move');
  assertEqual(position.toFen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'position untouched');
});

test('search finds mate in one', () => {
  const position = new Position().setFen('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { depth: 3 });
  assertEqual(moveToUci(result.bestMove), 'f3f7', 'Qxf7# is played');
  assert(Math.abs(result.score) >= MATE_THRESHOLD, 'score is a mate score');
  assertEqual(result.mate, 1, 'mate in 1 reported');
});

test('search finds mate in two', () => {
  // Classic mate in two: 1.Qg6+ (or similar). Position from the search bench.
  const position = new Position().setFen('r5rk/5p1p/5R2/4B3/8/8/7P/7K w - - 0 1');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { depth: 5 });
  assert(Math.abs(result.score) >= MATE_THRESHOLD, `mate score found, got ${result.score}`);
  assert(result.mate !== null && result.mate >= 1 && result.mate <= 3, `mate distance reported (${result.mate})`);
});

test('search recognises a lost position', () => {
  // White has only a king against a queen: the score must be hopeless.
  const position = new Position().setFen('4k3/8/8/8/8/8/8/q3K3 w - - 0 1');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { depth: 5 });
  assert(result.score < -800, `score should be around a queen down, got ${result.score}`);
  assert(result.score > -MATE_THRESHOLD, 'not checkmate yet');
});

test('search does not crash or hang on a position with no legal moves', () => {
  const mate = new Position().setFen('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(mate, { depth: 3 });
  assertEqual(result.bestMove, 0, 'no move to return');
  assert(result.noLegalMoves, 'flagged as having no legal moves');
  assert(result.score <= -MATE_THRESHOLD, 'mated score');

  const stalemate = new Position().setFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const stalemateResult = searcher.go(stalemate, { depth: 3 });
  assertEqual(stalemateResult.bestMove, 0);
  assertEqual(stalemateResult.score, 0, 'stalemate is a draw');
});

test('node limit is respected', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { nodes: 5000 });
  assert(result.nodes <= 5000 + 1024, `nodes ${result.nodes} should be close to the 5000 limit`);
  assert(result.nodes > 0);
  assert(isLegal(position, result.bestMove));
});

test('time limit is respected', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const searcher = new Searcher({ hashMB: 8 });
  const started = Date.now();
  const result = searcher.go(position, { movetime: 200 });
  const elapsed = Date.now() - started;
  assert(elapsed < 1200, `search with 200 ms budget took ${elapsed} ms`);
  assert(result.depth >= 1, 'completed at least one iteration');
  assert(isLegal(position, result.bestMove));
});

test('an aborted search still returns a legal move', () => {
  const position = new Position().setStartPosition();
  const searcher = new Searcher({ hashMB: 8 });
  // Drive the session by hand: two complete iterations, then abort mid-search.
  const session = searcher.createSession(position.clone(), { depth: 40 });
  assert(session.runNextIteration(), 'first iteration runs');
  assert(session.runNextIteration(), 'second iteration runs');
  searcher.stop();
  assertEqual(session.runNextIteration(), false, 'search stops when asked');
  const result = session.result();
  assert(isLegal(position, result.bestMove), 'legal move after abort');
  assert(result.aborted, 'result is marked as aborted');
});

test('search always returns a legal move across many random positions', () => {
  const searcher = new Searcher({ hashMB: 8 });
  let checked = 0;
  for (let seed = 1; seed <= 5; seed++) {
    playRandomGame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 24, seed, (position, ply) => {
      if (ply % 6 !== 0) return;
      const result = searcher.go(position, { depth: 3 });
      assert(isLegal(position, result.bestMove), `legal move at ply ${ply} (seed ${seed}): ${position.toFen()}`);
      checked++;
    });
  }
  assert(checked >= 20, `checked ${checked} positions`);
});

test('VerifyMoves cross-checks attack detection inside the search', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const searcher = new Searcher({ hashMB: 8, verifyMoves: true });
  const result = searcher.go(position, { depth: 3 });
  assert(isLegal(position, result.bestMove));
  verifyConsistency(position);
});

test('searches do not corrupt the transposition table between positions', () => {
  const searcher = new Searcher({ hashMB: 8 });
  const positions = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
  ];
  for (let round = 0; round < 3; round++) {
    for (const fen of positions) {
      const position = new Position().setFen(fen);
      const result = searcher.go(position, { depth: 4 });
      assert(isLegal(position, result.bestMove), `legal move for ${fen}`);
    }
  }
});

test('search plays obvious captures and avoids losing material', () => {
  // White queen can take a free rook on d5; any sensible engine grabs it.
  const position = new Position().setFen('4k3/8/8/3r4/8/8/8/3QK3 w - - 0 1');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { depth: 5 });
  const text = moveToUci(result.bestMove);
  assertEqual(text, 'd1d5', `queen should capture the rook, played ${text}`);
  assert(result.score > 400, 'score reflects the extra material');
});

test('search finds the only legal move when there is exactly one', () => {
  // White king h1 is in check from the queen on g2 and can only capture it.
  const position = new Position().setFen('7k/8/8/8/8/8/6q1/7K w - - 0 1');
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  assertEqual(list.count, 1, 'exactly one legal move');
  const searcher = new Searcher({ hashMB: 8 });
  const result = searcher.go(position, { depth: 3 });
  assertEqual(moveToUci(result.bestMove), 'h1g2', 'the only legal move is played');
});

test('iterative deepening reports increasing depth', () => {
  const position = new Position().setStartPosition();
  const searcher = new Searcher({ hashMB: 8 });
  const depths = [];
  searcher.go(position, { depth: 5 }, (info) => depths.push(info.depth));
  assertEqual(depths.join(','), '1,2,3,4,5', 'one info report per completed depth');
});

test('search is deterministic for a fixed depth', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const first = new Searcher({ hashMB: 8 }).go(new Position().setFen(fen), { depth: 5 });
  const second = new Searcher({ hashMB: 8 }).go(new Position().setFen(fen), { depth: 5 });
  assertEqual(moveToUci(first.bestMove), moveToUci(second.bestMove), 'same best move');
  assertEqual(first.nodes, second.nodes, 'same node count');
});
