/**
 * src/core/verify.js
 *
 * Independent, deliberately slow implementations used to cross-check the fast
 * bitboard code:
 *
 *   - squareAttackedSlow(): board scanning with file/rank arithmetic, no magic
 *     bitboards, no attack tables.
 *   - generateMovesSlow(): a completely separate move generator built the
 *     "textbook" way (loop over the 64 squares, step offsets, ray scans).
 *   - verifyConsistency(): checks that every derived structure (bitboards,
 *     counts, king squares, Zobrist key) agrees with the 64-square board.
 *
 * The search can call verifyNode() at every node when the "VerifyMoves" UCI
 * option is on; the test-suite uses the slow generator for differential tests.
 */

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  EMPTY, makePiece, fileOf, rankOf, squareName,
} from './types.js';
import {
  encodeMove, moveFrom, moveTo, moveFlag, promotionType,
  FLAG_QUIET, FLAG_CAPTURE, FLAG_DOUBLE_PUSH, FLAG_EN_PASSANT,
  FLAG_CASTLE_KING, FLAG_CASTLE_QUEEN, promotionFlag,
} from './moves.js';
import { CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ } from './types.js';

const KNIGHT_STEPS = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_STEPS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Is ``sq`` attacked by any piece of colour ``by``?  Pure board scan.
 */
export function squareAttackedSlow(position, sq, by) {
  const board = position.board;
  const file = fileOf(sq);
  const rank = rankOf(sq);

  // Pawns: a white pawn attacks upwards, so search downwards.
  const pawnDir = by === WHITE ? -1 : 1;
  for (const df of [-1, 1]) {
    const f = file + df;
    const r = rank + pawnDir;
    if (f < 0 || f > 7 || r < 0 || r > 7) continue;
    const code = board[r * 8 + f];
    if (code === makePiece(by, PAWN)) return true;
  }

  // Knights
  for (const [df, dr] of KNIGHT_STEPS) {
    const f = file + df;
    const r = rank + dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) continue;
    if (board[r * 8 + f] === makePiece(by, KNIGHT)) return true;
  }

  // King
  for (const [df, dr] of KING_STEPS) {
    const f = file + df;
    const r = rank + dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) continue;
    if (board[r * 8 + f] === makePiece(by, KING)) return true;
  }

  // Sliding pieces
  for (const [dirs, sliderType, queenType] of [
    [ROOK_DIRS, ROOK, QUEEN],
    [BISHOP_DIRS, BISHOP, QUEEN],
  ]) {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const code = board[r * 8 + f];
        if (code !== EMPTY) {
          if ((code >> 3) === by && ((code & 7) === sliderType || (code & 7) === queenType)) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
  }
  return false;
}

/** Find a king of ``colour`` by scanning the board. */
function findKing(position, colour) {
  for (let sq = 0; sq < 64; sq++) {
    if (position.board[sq] === makePiece(colour, KING)) return sq;
  }
  return -1;
}

/**
 * Verify that all derived structures agree with the board array and that the
 * Zobrist key is the one computeKey() produces.  Throws on any mismatch.
 */
export function verifyConsistency(position) {
  let occLo = 0;
  let occHi = 0;
  const colourLo = [0, 0];
  const colourHi = [0, 0];
  const typesSeen = new Int32Array(15);

  for (let sq = 0; sq < 64; sq++) {
    const code = position.board[sq];
    if (code === EMPTY) continue;
    const colour = code >> 3;
    const type = code & 7;
    const lo = sq < 32 ? 1 << sq : 0;
    const hi = sq < 32 ? 0 : 1 << (sq - 32);
    occLo |= lo;
    occHi |= hi;
    colourLo[colour] |= lo;
    colourHi[colour] |= hi;
    typesSeen[code]++;
    const idx = colour * 6 + (type - 1);
    if (((position.piecesLo[idx] & lo) === 0 && lo !== 0)
      || ((position.piecesHi[idx] & hi) === 0 && hi !== 0)) {
      throw new Error(`verifyConsistency: piece bitboard missing ${squareName(sq)} (code ${code})`);
    }
    if (type === KING && position.kingSq[colour] !== sq) {
      throw new Error(`verifyConsistency: kingSq for ${colour} is ${position.kingSq[colour]}, board says ${sq}`);
    }
  }
  if (occLo !== position.occLo || occHi !== position.occHi) {
    throw new Error('verifyConsistency: occupancy bitboard mismatch');
  }
  if (colourLo[0] !== position.colourLo[0] || colourHi[0] !== position.colourHi[0]
    || colourLo[1] !== position.colourLo[1] || colourHi[1] !== position.colourHi[1]) {
    throw new Error('verifyConsistency: colour bitboard mismatch');
  }
  for (let idx = 0; idx < 12; idx++) {
    let lo = position.piecesLo[idx];
    let hi = position.piecesHi[idx];
    while (lo !== 0) {
      const sq = 31 - Math.clz32(lo & -lo);
      lo &= lo - 1;
      if ((position.board[sq] & 7) - 1 !== idx % 6) {
        throw new Error(`verifyConsistency: stray piece bit at ${squareName(sq)} for index ${idx}`);
      }
    }
    while (hi !== 0) {
      const sq = 32 + 31 - Math.clz32(hi & -hi);
      hi &= hi - 1;
      if ((position.board[sq] & 7) - 1 !== idx % 6) {
        throw new Error(`verifyConsistency: stray piece bit at ${squareName(sq)} for index ${idx}`);
      }
    }
  }
  for (let code = 1; code < 15; code++) {
    if (position.counts[code] !== typesSeen[code]) {
      throw new Error(`verifyConsistency: count mismatch for board code ${code}`);
    }
  }
  for (const colour of [WHITE, BLACK]) {
    const ksq = findKing(position, colour);
    if (ksq !== position.kingSq[colour]) {
      throw new Error(`verifyConsistency: king square mismatch for colour ${colour}`);
    }
  }
  const key = position.computeKey();
  if (key.lo !== position.keyLo || key.hi !== position.keyHi) {
    throw new Error('verifyConsistency: Zobrist key mismatch');
  }
  const wk = position.kingSq[WHITE];
  const bk = position.kingSq[BLACK];
  if (wk >= 0 && bk >= 0) {
    if (Math.abs(fileOf(wk) - fileOf(bk)) <= 1 && Math.abs(rankOf(wk) - rankOf(bk)) <= 1) {
      throw new Error('verifyConsistency: kings are adjacent');
    }
  }
  return true;
}

/**
 * Generate all legal moves with the slow, independent generator.
 * Returns an array of encoded moves.
 */
export function generateMovesSlow(position) {
  const us = position.side;
  const board = position.board;
  const pseudo = [];

  const add = (from, to, flag, type, victim) => {
    pseudo.push(encodeMove(from, to, flag, type, victim));
  };

  for (let from = 0; from < 64; from++) {
    const code = board[from];
    if (code === EMPTY || (code >> 3) !== us) continue;
    const type = code & 7;
    const file = fileOf(from);
    const rank = rankOf(from);
    const forward = us === WHITE ? 1 : -1;

    if (type === PAWN) {
      const promoRank = us === WHITE ? 7 : 0;
      const startRank = us === WHITE ? 1 : 6;
      const oneAhead = rank + forward;
      if (oneAhead >= 0 && oneAhead <= 7 && board[oneAhead * 8 + file] === EMPTY) {
        const to = oneAhead * 8 + file;
        if (oneAhead === promoRank) {
          for (const pt of [QUEEN, ROOK, BISHOP, KNIGHT]) add(from, to, promotionFlag(pt, false), PAWN, 0);
        } else {
          add(from, to, FLAG_QUIET, PAWN, 0);
          const twoAhead = rank + 2 * forward;
          if (rank === startRank && board[twoAhead * 8 + file] === EMPTY) {
            add(from, twoAhead * 8 + file, FLAG_DOUBLE_PUSH, PAWN, 0);
          }
        }
      }
      for (const df of [-1, 1]) {
        const f = file + df;
        if (f < 0 || f > 7 || oneAhead < 0 || oneAhead > 7) continue;
        const to = oneAhead * 8 + f;
        const target = board[to];
        if (target !== EMPTY && (target >> 3) !== us) {
          if (oneAhead === promoRank) {
            for (const pt of [QUEEN, ROOK, BISHOP, KNIGHT]) add(from, to, promotionFlag(pt, true), PAWN, target & 7);
          } else {
            add(from, to, FLAG_CAPTURE, PAWN, target & 7);
          }
        }
        if (to === position.epSquare && target === EMPTY) {
          const victimSq = to + (us === WHITE ? -8 : 8);
          if (board[victimSq] === makePiece(us ^ 1, PAWN)) add(from, to, FLAG_EN_PASSANT, PAWN, PAWN);
        }
      }
      continue;
    }

    const steps = type === KNIGHT ? KNIGHT_STEPS : type === KING ? KING_STEPS : null;
    if (steps) {
      for (const [df, dr] of steps) {
        const f = file + df;
        const r = rank + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        const to = r * 8 + f;
        const target = board[to];
        if (target === EMPTY) add(from, to, FLAG_QUIET, type, 0);
        else if ((target >> 3) !== us) add(from, to, FLAG_CAPTURE, type, target & 7);
      }
      continue;
    }

    const dirs = type === ROOK ? ROOK_DIRS : type === BISHOP ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const to = r * 8 + f;
        const target = board[to];
        if (target === EMPTY) {
          add(from, to, FLAG_QUIET, type, 0);
        } else {
          if ((target >> 3) !== us) add(from, to, FLAG_CAPTURE, type, target & 7);
          break;
        }
        f += df;
        r += dr;
      }
    }
  }

  // Castling, decided independently of the fast generator.
  const kingSq = findKing(position, us);
  const them = us ^ 1;
  if (kingSq === (us === WHITE ? 4 : 60)) {
    const kingSideRight = us === WHITE ? CASTLE_WK : CASTLE_BK;
    const queenSideRight = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
    const rookSquare = us === WHITE ? 7 : 63;
    const queenRookSquare = us === WHITE ? 0 : 56;
    if ((position.castling & kingSideRight)
      && board[rookSquare] === makePiece(us, ROOK)
      && board[kingSq + 1] === EMPTY && board[kingSq + 2] === EMPTY
      && !squareAttackedSlow(position, kingSq, them)
      && !squareAttackedSlow(position, kingSq + 1, them)
      && !squareAttackedSlow(position, kingSq + 2, them)) {
      add(kingSq, kingSq + 2, FLAG_CASTLE_KING, KING, 0);
    }
    if ((position.castling & queenSideRight)
      && board[queenRookSquare] === makePiece(us, ROOK)
      && board[kingSq - 1] === EMPTY && board[kingSq - 2] === EMPTY && board[kingSq - 3] === EMPTY
      && !squareAttackedSlow(position, kingSq, them)
      && !squareAttackedSlow(position, kingSq - 1, them)
      && !squareAttackedSlow(position, kingSq - 2, them)) {
      add(kingSq, kingSq - 2, FLAG_CASTLE_QUEEN, KING, 0);
    }
  }

  // Filter by legality using make/unmake plus the slow attack test.
  const legal = [];
  for (const move of pseudo) {
    position.makeMove(move);
    const slowKing = findKing(position, us);
    const attacked = slowKing >= 0 && squareAttackedSlow(position, slowKing, them);
    if (!attacked) legal.push(move);
    position.unmakeMove(move);
  }
  return legal;
}

/**
 * Called at every node when the "VerifyMoves" option is enabled: makes sure the
 * fast attack detection agrees with the slow scan for every pseudo-legal move.
 */
export function verifyNode(position, list) {
  const us = position.side;
  const them = us ^ 1;
  for (let i = 0; i < list.count; i++) {
    const move = list.moves[i];
    const from = moveFrom(move);
    if (position.board[from] === EMPTY || (position.board[from] >> 3) !== us) {
      throw new Error(`verifyNode: move from empty/enemy square ${squareName(from)}`);
    }
    position.makeMove(move);
    const kingSq = position.kingSq[us];
    const fast = position.isAttacked(kingSq, them);
    const slow = squareAttackedSlow(position, kingSq, them);
    position.unmakeMove(move);
    if (fast !== slow) {
      throw new Error(`verifyNode: attack detection mismatch after ${squareName(moveFrom(move))}-${squareName(moveTo(move))}`);
    }
  }
  return true;
}

export { promotionType, moveFlag };
