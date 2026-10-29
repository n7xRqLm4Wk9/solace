/**
 * tests/fen.test.js
 *
 * FEN parsing and serialisation, plus castling / en passant / clock fields.
 */

import { test, assert, assertEqual } from './harness.js';
import { TRICKY_POSITIONS } from './helpers.js';
import { Position } from '../src/core/position.js';
import { parseSquare, squareName } from '../src/core/types.js';

test('start position FEN round-trips exactly', () => {
  const position = new Position().setStartPosition();
  assertEqual(position.toFen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});

test('FEN round-trips for a spread of positions', () => {
  for (const fen of TRICKY_POSITIONS) {
    const position = new Position().setFen(fen);
    assertEqual(position.toFen(), fen, `round trip for ${fen}`);
  }
});

test('FEN round-trips after moves (clocks and ep square included)', () => {
  const position = new Position().setStartPosition();
  position.makeMove(position.parseMove('e2e4'));
  assertEqual(position.toFen(), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  position.makeMove(position.parseMove('c7c5'));
  assertEqual(position.toFen(), 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2');
  position.makeMove(position.parseMove('g1f3'));
  assertEqual(position.toFen(), 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
});

test('FEN defaults missing halfmove and fullmove fields', () => {
  const position = new Position().setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  assertEqual(position.halfmove, 0);
  assertEqual(position.fullmove, 1);
  assertEqual(position.toFen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});

test('FEN preserves the halfmove clock and fullmove number', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/8/4K3 w - - 37 84');
  assertEqual(position.halfmove, 37);
  assertEqual(position.fullmove, 84);
  assertEqual(position.toFen(), '4k3/8/8/8/8/8/8/4K3 w - - 37 84');
});

test('square names and parsing agree', () => {
  for (let sq = 0; sq < 64; sq++) {
    assertEqual(parseSquare(squareName(sq)), sq, `square ${sq}`);
  }
  assertEqual(parseSquare('a9'), -1);
  assertEqual(parseSquare('z1'), -1);
});

test('FEN with an illegal ep rank is rejected', () => {
  let threw = false;
  try {
    new Position().setFen('4k3/8/8/8/8/8/8/4K3 w - d5 0 1');
  } catch (err) {
    threw = true;
  }
  assert(threw, 'en passant square on the wrong rank must be rejected');
});

test('FEN with the side-not-to-move in check is rejected', () => {
  let threw = false;
  try {
    new Position().setFen('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1');
  } catch (err) {
    threw = true;
  }
  assert(threw, 'illegal position (side not to move in check) must be rejected');
});

test('clone produces an independent copy', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const copy = position.clone();
  copy.makeMove(copy.parseMove('e1g1'));
  assert(position.toFen() !== copy.toFen(), 'clone can be modified independently');
  assertEqual(position.toFen(), 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
});
