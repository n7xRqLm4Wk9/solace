/**
 * tests/helpers.js
 *
 * Shared test utilities: a deterministic pseudo-random number generator, random
 * legal-move play, and the standard perft reference data.
 */

import { Position } from '../src/core/position.js';
import { MoveList, moveToUci } from '../src/core/moves.js';

/** Small deterministic PRNG (mulberry32) so test runs are reproducible. */
export function makeRng(seed = 0x12345678) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Play ``plies`` random legal moves from ``fen``.  ``visit`` is called with the
 * position after every move.
 */
export function playRandomGame(fen, plies, seed, visit) {
  const position = new Position().setFen(fen);
  const list = new MoveList(256);
  const rng = makeRng(seed);
  const moves = [];
  for (let ply = 0; ply < plies; ply++) {
    position.generateLegalMoves(list);
    if (list.count === 0) break;
    const move = list.moves[Math.floor(rng() * list.count)];
    position.makeMove(move);
    moves.push(moveToUci(move));
    if (visit) visit(position, ply);
  }
  return { position, moves };
}

/** Standard perft reference data (depth 1 first). */
export const PERFT_SUITE = [
  {
    name: 'initial position',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    counts: [20, 400, 8902, 197281, 4865609],
  },
  {
    name: 'kiwipete (castling, pins, en passant)',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    counts: [48, 2039, 97862, 4085603],
  },
  {
    name: 'position 3 (en passant, promotion)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    counts: [14, 191, 2812, 43238, 674624],
  },
  {
    name: 'position 4 (promotions, castling rights)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    counts: [6, 264, 9467, 422333],
  },
  {
    name: 'position 5 (many promotions)',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    counts: [44, 1486, 62379, 2103487],
  },
  {
    name: 'position 6',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    counts: [46, 2079, 89890, 3894594],
  },
];

/** A spread of tricky positions used by several test files. */
export const TRICKY_POSITIONS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
  'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  '4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 2',
  '8/8/8/8/k2Pp2Q/8/8/4K3 b - d3 0 1',
  '4k3/8/8/8/8/8/8/4K2R w K - 0 1',
  '8/8/8/8/8/8/6k1/4K2R b K - 0 1',
  '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1',
  '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
];
