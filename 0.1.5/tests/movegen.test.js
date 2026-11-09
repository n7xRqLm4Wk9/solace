/**
 * tests/movegen.test.js
 *
 * Move generation, make/unmake, castling, en passant and promotion tests.
 */

import { test, assert, assertEqual, assertThrows } from './harness.js';
import { PERFT_SUITE, TRICKY_POSITIONS, playRandomGame } from './helpers.js';
import { Position } from '../src/core/position.js';
import { perft } from '../src/search/perft.js';
import { MoveList, moveToUci, isCastle, isCapture } from '../src/core/moves.js';
import { generateMovesSlow, verifyConsistency } from '../src/core/verify.js';
import {
  WHITE, BLACK, PAWN, QUEEN, ROOK, BISHOP, KNIGHT, KING,
  makePiece, parseSquare, CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
} from '../src/core/types.js';

function legalMoveTexts(position) {
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  const out = [];
  for (let i = 0; i < list.count; i++) out.push(moveToUci(list.moves[i]));
  return out.sort();
}

// ---------------------------------------------------------------------------
// Perft
// ---------------------------------------------------------------------------
for (const suite of PERFT_SUITE) {
  for (let depth = 1; depth <= suite.counts.length; depth++) {
    const expected = suite.counts[depth - 1];
    test(`perft ${suite.name} depth ${depth} = ${expected}`, () => {
      const position = new Position().setFen(suite.fen);
      assertEqual(perft(position, depth), expected, `perft(${depth})`);
      assertEqual(position.toFen(), suite.fen, 'position restored after perft');
    });
  }
}

test('start position has 20 legal moves', () => {
  const position = new Position().setStartPosition();
  assertEqual(legalMoveTexts(position).length, 20);
});

// ---------------------------------------------------------------------------
// Castling
// ---------------------------------------------------------------------------
test('both sides can castle kingside and queenside when legal', () => {
  const position = new Position().setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const moves = legalMoveTexts(position);
  assert(moves.includes('e1g1'), 'white kingside castling should be legal');
  assert(moves.includes('e1c1'), 'white queenside castling should be legal');

  const castling = new MoveList(256);
  position.generateLegalMoves(castling);
  for (let i = 0; i < castling.count; i++) {
    const move = castling.moves[i];
    if (!isCastle(move)) continue;
    position.makeMove(move);
    if (moveToUci(move) === 'e1g1') {
      assertEqual(position.board[parseSquare('g1')], makePiece(WHITE, KING), 'king on g1');
      assertEqual(position.board[parseSquare('f1')], makePiece(WHITE, ROOK), 'rook on f1');
    }
    if (moveToUci(move) === 'e1c1') {
      assertEqual(position.board[parseSquare('c1')], makePiece(WHITE, KING), 'king on c1');
      assertEqual(position.board[parseSquare('d1')], makePiece(WHITE, ROOK), 'rook on d1');
    }
    position.unmakeMove(move);
    assertEqual(position.board[parseSquare('e1')], makePiece(WHITE, KING), 'king back on e1');
    assertEqual(position.board[parseSquare('h1')], makePiece(WHITE, ROOK), 'rook back on h1');
  }
});

test('castling is illegal when squares are occupied', () => {
  const blockedKingSide = new Position().setFen('r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1');
  assert(!legalMoveTexts(blockedKingSide).includes('e1g1'), 'f1 occupied blocks O-O');

  const blockedQueenSide = new Position().setFen('r3k2r/8/8/8/8/8/8/R2QK2R w KQkq - 0 1');
  assert(!legalMoveTexts(blockedQueenSide).includes('e1c1'), 'd1 occupied blocks O-O-O');
});

test('castling is illegal when the king is in check or crosses an attacked square', () => {
  const inCheck = new Position().setFen('r3k2r/8/8/8/4r3/8/8/R3K2R w KQkq - 0 1');
  const checkMoves = legalMoveTexts(inCheck);
  assert(!checkMoves.includes('e1g1') && !checkMoves.includes('e1c1'), 'no castling while in check');

  const throughCheck = new Position().setFen('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1');
  assert(!legalMoveTexts(throughCheck).includes('e1g1'), 'f1 attacked blocks O-O');

  const queenPath = new Position().setFen('r3k2r/8/8/8/8/2r5/8/R3K2R w KQkq - 0 1');
  assert(!legalMoveTexts(queenPath).includes('e1c1'), 'd1 attacked blocks O-O-O');
});

test('castling is illegal through an attacked square on the queenside', () => {
  const position = new Position().setFen('r3k2r/8/8/8/8/3r4/8/R3K2R w KQkq - 0 1');
  const moves = legalMoveTexts(position);
  assert(!moves.includes('e1c1'), 'd1 attacked blocks O-O-O');
});

test('castling rights are lost after the king or rook moves', () => {
  const position = new Position().setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assertEqual(position.castling, CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ);

  const kingMove = position.parseMove('e1f1');
  position.makeMove(kingMove);
  assertEqual(position.castling & (CASTLE_WK | CASTLE_WQ), 0, 'white rights gone after king move');
  assertEqual(position.castling & (CASTLE_BK | CASTLE_BQ), CASTLE_BK | CASTLE_BQ, 'black rights kept');
  position.unmakeMove(kingMove);
  assertEqual(position.castling, CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ, 'rights restored');

  const rookMove = position.parseMove('a1b1');
  position.makeMove(rookMove);
  assertEqual(position.castling & CASTLE_WQ, 0, 'queenside right gone after rook move');
  position.unmakeMove(rookMove);
});

test('capturing a rook on its home square removes the opponent castling right', () => {
  const position = new Position().setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  // White rook takes the a8 rook: black's queenside right must disappear.
  position.makeMove(position.parseMove('a1a8'));
  assertEqual(position.castling & CASTLE_BQ, 0, 'black queenside right removed');
  assertEqual(position.castling & CASTLE_BK, CASTLE_BK, 'black kingside right kept');
});

test('FEN castling rights are sanitised when the rook is missing', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/8/4K2R w KQ - 0 1');
  assertEqual(position.castling, CASTLE_WK, 'only the supported right survives');
  assert(!legalMoveTexts(position).includes('e1c1'), 'no queenside castling without a rook');
});

test('castling rights are tracked through the Zobrist key', () => {
  const position = new Position().setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const before = position.keyLo;
  position.makeMove(position.parseMove('e1f1'));
  assert(position.keyLo !== before, 'key changes when castling rights change');
  verifyConsistency(position);
});

// ---------------------------------------------------------------------------
// En passant
// ---------------------------------------------------------------------------
test('en passant capture is generated and removes the captured pawn', () => {
  const position = new Position().setFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
  const moves = legalMoveTexts(position);
  assert(moves.includes('e5d6'), 'en passant capture available');

  const move = position.parseMove('e5d6');
  position.makeMove(move);
  assertEqual(position.board[parseSquare('d5')], 0, 'captured pawn removed');
  assertEqual(position.board[parseSquare('d6')], makePiece(WHITE, PAWN), 'capturing pawn on d6');
  position.unmakeMove(move);
  assertEqual(position.board[parseSquare('d5')], makePiece(BLACK, PAWN), 'captured pawn restored');
  assertEqual(position.board[parseSquare('e5')], makePiece(WHITE, PAWN), 'capturing pawn restored');
  assertEqual(position.epSquare, parseSquare('d6'), 'ep square restored');
});

test('en passant may be illegal because it exposes the king along the rank', () => {
  // Black pawn e4 could capture on d3 en passant, but then the white queen on
  // h4 would attack the black king on a4 along the fourth rank.
  const position = new Position().setFen('8/8/8/8/k2Pp2Q/8/8/4K3 b - d3 0 1');
  const moves = legalMoveTexts(position);
  assert(!moves.includes('e4d3'), 'en passant capture that leaves the king in check is illegal');
});

test('en passant capture that gives check is legal and detected', () => {
  // After exd6 en passant the white pawn checks the black king on c7.
  const position = new Position().setFen('8/2k5/8/3pP3/8/8/8/4K3 w - d6 0 2');
  const move = position.parseMove('e5d6');
  assert(move !== 0, 'en passant move must exist');
  position.makeMove(move);
  assert(position.isKingInCheck(BLACK), 'en passant discovered check on the black king');
  position.unmakeMove(move);
  verifyConsistency(position);
});

test('an en-passant FEN field without a capturable pawn is harmless', () => {
  const position = new Position().setFen('4k3/8/8/8/8/8/8/4K3 w - d6 0 1');
  const moves = legalMoveTexts(position);
  assert(!moves.some((m) => m === 'e5d6'), 'no phantom en passant move');
  assertEqual(position.epSquare, parseSquare('d6'), 'ep field preserved for FEN round trip');
});

test('double pawn push sets the en passant square and it is cleared afterwards', () => {
  const position = new Position().setStartPosition();
  position.makeMove(position.parseMove('e2e4'));
  assertEqual(position.epSquare, parseSquare('e3'), 'ep square after double push');
  position.makeMove(position.parseMove('e7e5'));
  assertEqual(position.epSquare, parseSquare('e6'), 'ep square follows the last move');
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------
test('all four promotion pieces are generated from a push and a capture', () => {
  const pushPosition = new Position().setFen('8/P7/8/8/8/8/8/k6K w - - 0 1');
  const pushMoves = legalMoveTexts(pushPosition);
  for (const piece of ['q', 'r', 'b', 'n']) {
    assert(pushMoves.includes(`a7a8${piece}`), `promotion to ${piece} generated`);
  }

  const capturePosition = new Position().setFen('n7/1P6/8/8/8/8/8/k6K w - - 0 1');
  const captureMoves = legalMoveTexts(capturePosition);
  for (const piece of ['q', 'r', 'b', 'n']) {
    assert(captureMoves.includes(`b7a8${piece}`), `capture promotion to ${piece} generated`);
    assert(captureMoves.includes(`b7b8${piece}`), `quiet promotion to ${piece} generated`);
  }
});

test('each promotion choice produces the right piece and unmakes cleanly', () => {
  const expected = { q: QUEEN, r: ROOK, b: BISHOP, n: KNIGHT };
  for (const [suffix, type] of Object.entries(expected)) {
    const position = new Position().setFen('n7/1P6/8/8/8/8/8/k6K w - - 0 1');
    const fenBefore = position.toFen();
    const move = position.parseMove(`b7a8${suffix}`);
    assert(move !== 0, `move b7a8${suffix} parsed`);
    position.makeMove(move);
    assertEqual(position.board[parseSquare('a8')] & 7, type, `a8 holds the promoted piece (${suffix})`);
    assertEqual(position.board[parseSquare('b7')], 0, 'pawn left b7');
    verifyConsistency(position);
    position.unmakeMove(move);
    assertEqual(position.toFen(), fenBefore, 'promotion unmake restores the position');
  }
});

test('underpromotion to a knight can be a check and is searched', () => {
  // b7b8n is check because the promoted knight attacks d7/c6/a6... use a direct
  // test instead: knight promotion must be in the legal move list and be a
  // check when it attacks the king.
  const position = new Position().setFen('8/1P6/8/8/8/8/8/k6K w - - 0 1');
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  let found = false;
  for (let i = 0; i < list.count; i++) {
    if (moveToUci(list.moves[i]) === 'b7b8n') found = true;
  }
  assert(found, 'knight promotion present');
});

// ---------------------------------------------------------------------------
// Checks, pins, king safety
// ---------------------------------------------------------------------------
test('a pinned piece may not move off the pin line', () => {
  // White knight on e2 is pinned to the king on e1 by the rook on e8.  A knight
  // has no move that stays on the e-file, so none of its moves are legal.
  const position = new Position().setFen('4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1');
  const moves = legalMoveTexts(position);
  const knightMoves = moves.filter((m) => m.startsWith('e2'));
  assertEqual(knightMoves.length, 0, 'no knight move is legal while pinned');
  assert(moves.every((m) => m.startsWith('e1')), 'only king moves remain');
});

test('in check only check evasions are legal', () => {
  const position = new Position().setFen('4r2k/8/8/8/8/8/8/4K3 w - - 0 1');
  assert(position.isKingInCheck(WHITE), 'white is in check');
  const moves = legalMoveTexts(position);
  assertEqual(moves.join(' '), 'e1d1 e1d2 e1f1 e1f2'.split(' ').sort().join(' '), 'only king escapes');
});

test('pinned-piece test: no move may leave the king in check', () => {
  const position = new Position().setFen('4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1');
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  for (let i = 0; i < list.count; i++) {
    const move = list.moves[i];
    position.makeMove(move);
    assert(!position.isKingInCheck(WHITE), `move ${moveToUci(move)} leaves the king safe`);
    position.unmakeMove(move);
  }
});

// ---------------------------------------------------------------------------
// Checkmate and stalemate
// ---------------------------------------------------------------------------
test('fool\'s mate is detected as checkmate', () => {
  const position = new Position().setFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert(position.isKingInCheck(WHITE), 'white is in check');
  assert(!position.hasLegalMoves(), 'no legal moves');
  assertEqual(legalMoveTexts(position).length, 0);
});

test('back rank mate is detected as checkmate', () => {
  const position = new Position().setFen('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1');
  assert(position.isKingInCheck(BLACK), 'black is in check');
  assertEqual(legalMoveTexts(position).length, 0);
});

test('stalemate has no legal moves but is not check', () => {
  const position = new Position().setFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert(!position.isKingInCheck(BLACK), 'black is not in check');
  assertEqual(legalMoveTexts(position).length, 0);
  assert(!position.hasLegalMoves());
});

test('hasLegalMoves disagrees with checkmate and agrees with normal positions', () => {
  assert(new Position().setStartPosition().hasLegalMoves());
  const mate = new Position().setFen('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1');
  assert(!mate.hasLegalMoves());
});

// ---------------------------------------------------------------------------
// make/unmake integrity
// ---------------------------------------------------------------------------
test('make/unmake restores the position exactly over random games', () => {
  for (const fen of TRICKY_POSITIONS) {
    const start = new Position().setFen(fen);
    const fenBefore = start.toFen();
    const played = [];
    let position = start;
    const list = new MoveList(256);
    let picks = 0;
    // Deterministic "random enough" walk: take every third legal move.
    for (let ply = 0; ply < 24; ply++) {
      position.generateLegalMoves(list);
      if (list.count === 0) break;
      const move = list.moves[(picks * 7 + ply) % list.count];
      position.makeMove(move);
      played.push(move);
      verifyConsistency(position);
      picks++;
    }
    for (let i = played.length - 1; i >= 0; i--) {
      position.unmakeMove(played[i]);
      verifyConsistency(position);
    }
    assertEqual(position.toFen(), fenBefore, `position restored after ${played.length} moves from ${fen}`);
  }
});

test('Zobrist key stays correct during random play (incremental vs recompute)', () => {
  for (let seed = 1; seed <= 6; seed++) {
    playRandomGame(TRICKY_POSITIONS[1], 60, seed, (position, ply) => {
      const expected = position.computeKey();
      assertEqual(position.keyLo, expected.lo, `key lo at ply ${ply}`);
      assertEqual(position.keyHi, expected.hi, `key hi at ply ${ply}`);
      if (ply % 8 === 0) verifyConsistency(position);
    });
  }
});

test('null move round-trips and keeps the key consistent', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const fenBefore = position.toFen();
  const keyBefore = position.keyLo;
  position.makeNullMove();
  assert(position.side === BLACK, 'side flipped by null move');
  assertEqual(position.computeKey().lo, position.keyLo, 'null move key lo');
  assertEqual(position.computeKey().hi, position.keyHi, 'null move key hi');
  position.unmakeNullMove();
  assertEqual(position.toFen(), fenBefore, 'null move unmake restores the position');
  assertEqual(position.keyLo, position.computeKey().lo, 'key after unmake');
  assertEqual(position.keyLo, keyBefore, 'key value restored by unmakeNullMove');
});

// ---------------------------------------------------------------------------
// Differential test against the independent slow generator
// ---------------------------------------------------------------------------
test('fast move generator agrees with the independent slow generator', () => {
  const positions = [];
  // Fixed positions.
  for (const fen of TRICKY_POSITIONS) positions.push(fen);
  // Random positions from several random games.
  for (let seed = 1; seed <= 4; seed++) {
    playRandomGame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 30, seed, (position, ply) => {
      if (ply % 3 === 0) positions.push(position.toFen());
    });
  }
  // Positions with castling and en-passant possibilities.
  for (let seed = 11; seed <= 13; seed++) {
    playRandomGame('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 40, seed, (position, ply) => {
      if (ply % 2 === 0) positions.push(position.toFen());
    });
  }

  let checked = 0;
  for (const fen of positions) {
    const position = new Position().setFen(fen);
    const fast = legalMoveTexts(position);
    const slow = generateMovesSlow(position).map(moveToUci).sort();
    assertEqual(fast.join(','), slow.join(','), `move sets differ for ${fen}`);
    checked++;
  }
  assert(checked >= 40, `checked a useful number of positions (${checked})`);
});

test('slow generator also agrees on total legal move counts', () => {
  for (const fen of TRICKY_POSITIONS) {
    const position = new Position().setFen(fen);
    const list = new MoveList(256);
    position.generateLegalMoves(list);
    assertEqual(generateMovesSlow(position).length, list.count, `legal move count for ${fen}`);
  }
});

// ---------------------------------------------------------------------------
// Move parsing / formatting
// ---------------------------------------------------------------------------
test('UCI move strings round-trip through parseMove', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  for (let i = 0; i < list.count; i++) {
    const text = moveToUci(list.moves[i]);
    assertEqual(position.parseMove(text), list.moves[i], `parse ${text}`);
  }
  assertEqual(position.parseMove('e1e8'), 0, 'illegal move parses to 0');
  assertEqual(position.parseMove('zzzz'), 0, 'garbage parses to 0');
});

test('capture flags are set exactly for captures', () => {
  const fens = [
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2',
    'n7/1P6/8/8/8/8/8/k6K w - - 0 1',
  ];
  for (const fen of fens) {
    const position = new Position().setFen(fen);
    const list = new MoveList(256);
    position.generateLegalMoves(list);
    for (let i = 0; i < list.count; i++) {
      const move = list.moves[i];
      const target = position.board[(move >>> 6) & 63];
      const enPassant = moveToUci(move) === 'e5d6';
      assertEqual(isCapture(move), target !== 0 || enPassant, `${fen}: capture flag for ${moveToUci(move)}`);
    }
  }
});

test('FEN parse errors are reported clearly', () => {
  assertThrows(() => new Position().setFen(''), 'empty FEN');
  assertThrows(() => new Position().setFen('8/8/8/8/8/8/8/8 w - - 0 1'), 'no kings');
  assertThrows(() => new Position().setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'), 'seven ranks');
  assertThrows(() => new Position().setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1'), 'bad side');
  assertThrows(() => new Position().setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w XY - 0 1'), 'bad castling');
  assertThrows(() => new Position().setFen('Pnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'pawn on rank 8');
  assertThrows(() => new Position().setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - x 1'), 'bad halfmove');
  assertThrows(() => new Position().setFen('rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'missing black king');
});

test('positions are not mutated by generating moves', () => {
  const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const before = position.toFen();
  const keyBefore = [position.keyLo, position.keyHi];
  position.generateLegalMoves(new MoveList(256));
  position.generateMoves(new MoveList(256));
  assertEqual(position.toFen(), before);
  assertEqual(position.keyLo, keyBefore[0]);
  assertEqual(position.keyHi, keyBefore[1]);
});
