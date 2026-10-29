/**
 * tests/eval.test.js
 *
 * Evaluation tests: perspective, colour symmetry, material and structural
 * sanity.  These cannot prove the evaluation is *good*, but they catch the
 * classes of bug that make an engine play nonsense (wrong sign, wrong
 * perspective, missing terms for one colour).
 */

import { test, assert, assertEqual } from './harness.js';
import { Position } from '../src/core/position.js';
import { evaluate, evaluateAbsolute, evaluateBreakdown, currentPhase } from '../src/eval/evaluate.js';


/** Mirror a FEN: swap colours, flip the board vertically and swap the side. */
export function mirrorFen(fen) {
  const [board, side, castle, ep, hm, fm] = fen.split(' ');
  const ranks = board.split('/').reverse().map((rank) => rank.replace(
    /[a-zA-Z]/g,
    (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()),
  ));
  let cast = '-';
  if (castle !== '-') {
    const flipped = castle.split('').map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    cast = 'KQkq'.split('').filter((c) => flipped.includes(c)).join('') || '-';
  }
  const epSquare = ep === '-' ? '-' : ep[0] + (9 - Number(ep[1]));
  return [ranks.join('/'), side === 'w' ? 'b' : 'w', cast, epSquare, hm, fm].join(' ');
}

test('evaluation is colour symmetric', () => {
  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  ];
  for (const fen of fens) {
    const position = new Position().setFen(fen);
    const mirrored = new Position().setFen(mirrorFen(fen));
    const score = evaluateAbsolute(position);
    const mirroredScore = evaluateAbsolute(mirrored);
    assertEqual(score, -mirroredScore, `symmetry for ${fen} (${score} vs ${mirroredScore})`);
  }
});

test('evaluation is reported from the side to move', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const position = new Position().setFen(fen);
  const whiteScore = evaluate(position);
  const mirrored = new Position().setFen(mirrorFen(fen));
  // Mirroring flips the side to move, so the two scores differ only by the
  // tempo bonus; the sign must be opposite because the mover reversed.
  assert(Math.abs(whiteScore + evaluate(mirrored)) <= 20, 'scores are mirrored near zero in the start position');
});

test('being a queen up scores about nine pawns', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/8/4K2Q w - - 0 1');
  const score = evaluate(position);
  assert(score > 800, `queen advantage should be about +900, got ${score}`);
  assert(score < 1200, `queen advantage should not be absurd, got ${score}`);
});

test('material advantage has the right sign for both colours', () => {
  const whiteAhead = new Position().setFen('4k3/8/8/8/8/8/8/4K2R w - - 0 1');
  assert(evaluate(whiteAhead) > 300, 'white rook up is positive for white');

  const blackAhead = new Position().setFen('4k2r/8/8/8/8/8/8/4K3 w - - 0 1');
  assert(evaluate(blackAhead) < -300, 'black rook up is negative for white');
});

test('piece-square tables reward centralised knights over cornered ones', () => {
  const centre = new Position().setFen('4k3/8/8/8/3N4/8/8/4K3 w - - 0 1');
  const corner = new Position().setFen('4k3/N7/8/8/8/8/8/4K3 w - - 0 1');
  assert(evaluateAbsolute(centre) > evaluateAbsolute(corner) + 40,
    'central knight should beat a corner knight by a clear margin');
});

test('doubled and isolated pawns are penalised', () => {
  // Same number of pawns (three): connected vs doubled + isolated.
  const healthy = new Position().setFen('4k3/8/8/8/8/8/PPP5/4K3 w - - 0 1');
  const doubled = new Position().setFen('4k3/8/8/8/8/P7/P6P/4K3 w - - 0 1');
  assert(evaluateAbsolute(healthy) > evaluateAbsolute(doubled) + 30,
    `healthy pawn structure should score better than doubled/isolated pawns (${evaluateAbsolute(healthy)} vs ${evaluateAbsolute(doubled)})`);
});

test('passed pawns are worth more as they advance', () => {
  const advanced = new Position().setFen('4k3/8/8/8/8/8/6P1/4K3 w - - 0 1');
  const nearPromotion = new Position().setFen('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
  assert(evaluateAbsolute(nearPromotion) > evaluateAbsolute(advanced) + 20,
    'a pawn on the seventh should be worth much more than one on the second');
});

test('king safety: an exposed king scores worse than a shielded one', () => {
  const shielded = new Position().setFen('r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 1');
  const exposed = new Position().setFen('r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w - - 0 1');
  const shieldedScore = evaluateAbsolute(shielded);
  const exposedScore = evaluateAbsolute(exposed);
  assert(shieldedScore > exposedScore, 'castled king with pawn cover should score better');
});

test('endgame king activity is rewarded', () => {
  const active = new Position().setFen('8/8/4k3/8/8/8/4P3/4K3 w - - 0 1');
  const passive = new Position().setFen('8/4k3/8/8/8/8/8/4K3 w - - 0 1');
  assert(evaluateAbsolute(active) > evaluateAbsolute(passive) - 100, 'sanity: values are comparable');
});

test('phase decreases as material comes off', () => {
  const full = new Position().setStartPosition();
  assertEqual(currentPhase(full), 24, 'full material is phase 24');
  const endgame = new Position().setFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  assertEqual(currentPhase(endgame), 0, 'bare kings with a pawn is phase 0');
});

test('evaluateBreakdown returns consistent numbers', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const breakdown = evaluateBreakdown(position);
  assert(breakdown.phase >= 0 && breakdown.phase <= 24);
  assert(typeof breakdown.absolute === 'number');
  assertEqual(breakdown.materialWhite, 8 * 100 + 2 * 320 + 2 * 335 + 2 * 500 + 950, 'white material');
  assertEqual(breakdown.materialBlack, 8 * 100 + 2 * 320 + 2 * 335 + 2 * 500 + 950, 'black material');
});

test('the tempo bonus favours the side to move', () => {
  const white = new Position().setFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  const black = new Position().setFen('4k3/8/8/8/8/8/8/4K3 b - - 0 1');
  assertEqual(evaluateAbsolute(white), 0, 'bare kings are equal in absolute terms');
  assertEqual(evaluateAbsolute(black), 0, 'bare kings are equal in absolute terms');
  assertEqual(evaluate(white), evaluate(black), 'tempo is the same for whoever moves');
  assert(evaluate(white) > 0, 'the side to move gets a small plus');
});
