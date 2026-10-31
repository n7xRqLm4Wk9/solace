/**
 * tests/draw.test.js
 *
 * Threefold repetition, fifty-move rule and insufficient material.
 */

import { test, assert, assertEqual } from './harness.js';
import { Position } from '../src/core/position.js';
import { Searcher, isImmediateDraw, INFINITE } from '../src/search/search.js';
import {
  WHITE, BLACK, makePiece, parseSquare, PAWN, KNIGHT, BISHOP, ROOK,
} from '../src/core/types.js';

test('repetitionCount detects repeated positions', () => {
  const position = new Position().setStartPosition();
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  assertEqual(position.repetitionCount(), 0, 'nothing repeated yet');
  for (const text of moves) position.makeMove(position.parseMove(text));
  assertEqual(position.repetitionCount(), 1, 'start position has occurred twice');
  for (const text of moves) position.makeMove(position.parseMove(text));
  assertEqual(position.repetitionCount(), 2, 'start position has occurred three times');
});

test('repetition is not counted across irreversible moves', () => {
  const position = new Position().setStartPosition();
  position.makeMove(position.parseMove('e2e4'));
  position.makeMove(position.parseMove('e7e5'));
  const keyNow = position.keyLo;
  // A pawn move resets the halfmove clock, so nothing older can repeat.
  assertEqual(position.halfmove, 0, 'halfmove clock reset by a pawn move');
  position.makeMove(position.parseMove('g1f3'));
  position.makeMove(position.parseMove('g8f6'));
  position.makeMove(position.parseMove('f3g1'));
  position.makeMove(position.parseMove('f6g8'));
  assertEqual(position.repetitionCount(), 1, 'the position after 1.e4 e5 has occurred once before');
  assertEqual(position.keyLo, keyNow, 'this is the position after 1.e4 e5, exactly as recorded');
});

test('the search treats a repeated position as a draw inside the tree', () => {
  // Shuffle the rook back and forth twice: the position then occurred 3 times.
  const position = new Position().setFen('7k/8/8/8/8/8/8/R6K w - - 0 1');
  const shuffle = ['a1a7', 'h8g8', 'a7a1', 'g8h8'];
  for (let round = 0; round < 2; round++) {
    for (const text of shuffle) position.makeMove(position.parseMove(text));
  }
  assertEqual(position.repetitionCount(), 2, 'the position has now occurred three times');
  assert(isImmediateDraw(position), 'the position is a claimable draw');

  // Inside the tree (ply > 0) such a position must score exactly 0.
  const searcher = new Searcher({ hashMB: 4 });
  searcher.reset();
  const score = searcher.negamax(position, 4, -INFINITE, INFINITE, 1, true);
  assertEqual(score, 0, 'a repeated position is a draw inside the search');
});

test('insufficient material: bare kings', () => {
  assert(new Position().setFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').hasInsufficientMaterial());
});

test('insufficient material: king and minor against king', () => {
  assert(new Position().setFen('4k3/8/8/8/8/8/8/4KN2 w - - 0 1').hasInsufficientMaterial());
  assert(new Position().setFen('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').hasInsufficientMaterial());
});

test('insufficient material: two bishops on the same colour', () => {
  // a1 is dark, so a square is dark when (file + rank) is even.
  // Bf8 (5+7=12, dark) and Bd4 (3+3=6, dark) run on the same squares: the
  // defending bishop can never block a flight square of its own king, so mate
  // is impossible and the position is dead.
  assert(new Position().setFen('5b2/4k3/8/8/3B4/8/8/4K3 w - - 0 1').hasInsufficientMaterial(),
    'bishops on one colour can never mate');

  // Bf8 (dark) and Bc4 (2+3=5, light) can mate with the defender's help, so
  // the position is not dead.
  assert(!new Position().setFen('5b2/4k3/8/8/2B5/8/8/4K3 w - - 0 1').hasInsufficientMaterial(),
    'opposite-coloured bishops can still mate with help');
});

test('K+2B vs K and K+N+N vs K are not dead positions', () => {
  assert(!new Position().setFen('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1').hasInsufficientMaterial(),
    'two bishops win by force');
  assert(!new Position().setFen('4k3/8/8/8/8/8/8/1N2K1N1 w - - 0 1').hasInsufficientMaterial(),
    'two knights can mate with help');
});

test('material with pawns or majors is sufficient', () => {
  assert(!new Position().setFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1').hasInsufficientMaterial());
  assert(!new Position().setFen('4k3/8/8/8/8/8/8/4KR2 w - - 0 1').hasInsufficientMaterial());
  assert(!new Position().setFen('4k3/8/8/8/8/8/8/3QK3 w - - 0 1').hasInsufficientMaterial());
});

test('the fifty-move rule is applied inside the search tree', () => {
  // No pawns and no possible captures: with the clock at 99 every move makes
  // the position a fifty-move draw, so the extra rook is worth nothing.
  const drawn = new Position().setFen('4k3/8/8/8/8/8/8/4K2R w - - 99 80');
  const searcher = new Searcher({ hashMB: 4 });
  const drawnResult = searcher.go(drawn, { depth: 4 });
  assertEqual(drawnResult.score, 0, 'everything leads to a fifty-move draw');

  // The same position with a fresh clock is clearly winning for White.
  const fresh = new Position().setFen('4k3/8/8/8/8/8/8/4K2R w - - 0 80');
  const freshResult = searcher.go(fresh, { depth: 4 });
  assert(freshResult.score > 400, `a rook up should score well, got ${freshResult.score}`);
});

test('the halfmove clock resets on captures and pawn moves only', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/4P3/4K3 w - - 10 20');
  position.makeMove(position.parseMove('e2e3'));
  assertEqual(position.halfmove, 0, 'pawn move resets the clock');
  position.makeMove(position.parseMove('e8e7'));
  assertEqual(position.halfmove, 1, 'king move increments the clock');
  position.makeMove(position.parseMove('e3e4'));
  assertEqual(position.halfmove, 0, 'another pawn move resets it');
});

test('fullmove number increments after black moves', () => {
  const position = new Position().setStartPosition();
  assertEqual(position.fullmove, 1);
  position.makeMove(position.parseMove('e2e4'));
  assertEqual(position.fullmove, 1, 'white move keeps the number');
  position.makeMove(position.parseMove('e7e5'));
  assertEqual(position.fullmove, 2, 'black move increments it');
  position.unmakeMove(position.parseMove('e7e5'));
  assertEqual(position.fullmove, 1, 'unmake restores it');
});

test('draw scores are zero from the search and draws are not mistaken for wins', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  const searcher = new Searcher({ hashMB: 4 });
  const result = searcher.go(position, { depth: 5 });
  assertEqual(result.score, 0, 'bare kings must be a draw');
});

test('insufficient material positions are not scored as wins', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/8/4KB2 w - - 0 1');
  const searcher = new Searcher({ hashMB: 4 });
  const result = searcher.go(position, { depth: 5 });
  assertEqual(result.score, 0);
});

export { WHITE, BLACK, makePiece, parseSquare, PAWN, KNIGHT, BISHOP, ROOK };
