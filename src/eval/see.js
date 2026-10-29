/**
 * src/eval/see.js
 *
 * Static exchange evaluation (SEE).
 *
 * SEE answers "if both sides keep recapturing on this square, always with their
 * least valuable attacker, does this capture win or lose material?".  It is the
 * standard way to recognise losing captures in the quiescence search (and to
 * prune them in the main search) without actually searching them.
 *
 * Implementation: the classic swap-list algorithm.  Attackers are recomputed on
 * the target square with an occupancy and piece set that shrink as pieces are
 * used up; because the attack rays start *on* the target square, x-ray
 * attackers appear automatically once the blocking piece is removed.
 */

import { PAWN, KING, KNIGHT, BISHOP, ROOK, QUEEN } from '../core/types.js';
import {
  PAWN_ATK_LO, PAWN_ATK_HI, KNIGHT_ATK_LO, KNIGHT_ATK_HI, KING_ATK_LO, KING_ATK_HI,
  bishopAttacks, rookAttacks, ATK_LO, ATK_HI,
} from '../core/bitboards.js';
import {
  moveFrom, moveTo, moveFlag, movePieceType, moveCapturedType,
  isCapture, isPromotion, promotionType, FLAG_EN_PASSANT,
} from '../core/moves.js';

/** Piece values used for exchange calculations (the king is effectively infinite). */
export const SEE_VALUE = [0, 100, 320, 335, 500, 950, 20000];

// Scratch storage, reused so that SEE never allocates.
const gain = new Int32Array(40);
const boardLo = new Int32Array(12);
const boardHi = new Int32Array(12);

function clearBit(colour, type, sq) {
  const idx = colour * 6 + (type - 1);
  if (sq < 32) boardLo[idx] &= ~(1 << sq);
  else boardHi[idx] &= ~(1 << (sq - 32));
}

function occupancySetOcc(sq) {
  return sq < 32 ? (1 << sq) : (1 << (sq - 32));
}

/**
 * Static exchange evaluation of ``move`` for the side to move.
 * @returns {number} material gain in centipawns; negative means the capture loses
 *          material against best play.
 */
export function see(position, move) {
  if (!isCapture(move) && !isPromotion(move)) return 0;

  const to = moveTo(move);
  const from = moveFrom(move);
  const flag = moveFlag(move);
  const us = position.side;
  const them = us ^ 1;
  const promoType = promotionType(move);

  boardLo.set(position.piecesLo);
  boardHi.set(position.piecesHi);
  let occLo = position.occLo;
  let occHi = position.occHi;

  const toBitLow = to < 32;
  const toBit = 1 << (to & 31);

  // The moving piece leaves its square.
  clearBit(us, movePieceType(move), from);
  if (toBitLow) occLo &= ~toBit;
  else occHi &= ~toBit;

  // Work out what is captured.
  let victimValue = 0;
  if (flag === FLAG_EN_PASSANT) {
    victimValue = SEE_VALUE[PAWN];
    const capturedSq = to + (us === 0 ? -8 : 8);
    clearBit(them, PAWN, capturedSq);
    if (capturedSq < 32) occLo &= ~(1 << capturedSq);
    else occHi &= ~(1 << (capturedSq - 32));
  } else if (isCapture(move)) {
    victimValue = SEE_VALUE[moveCapturedType(move)];
    clearBit(them, moveCapturedType(move), to);
    // `to` stays occupied (the capturing piece arrives), so no occupancy change.
  }

  const promotedBonus = promoType ? SEE_VALUE[promoType] - SEE_VALUE[PAWN] : 0;
  gain[0] = victimValue + promotedBonus;

  // Value of the piece now standing on the target square.
  let onSquareValue = promoType ? SEE_VALUE[promoType] : SEE_VALUE[movePieceType(move)];
  let side = them;
  let depth = 0;

  for (;;) {
    const attacker = leastValuableAttacker(to, side, occLo, occHi);
    if (attacker === 0) break;
    depth++;
    if (depth >= 38) break;
    gain[depth] = onSquareValue - gain[depth - 1];

    const sq = attacker - 1;
    const attackerType = position.board[sq] & 7;
    clearBit(side, attackerType, sq);
    if (sq < 32) occLo &= ~(1 << sq);
    else occHi &= ~(1 << (sq - 32));

    // The attacker now stands on the target square; the previous piece is gone.
    onSquareValue = SEE_VALUE[attackerType];
    if (attackerType === KING) break; // a king cannot be captured
    side ^= 1;
  }

  // Minimax the swap list back to the front: at each step the side to move can
  // either stop (keeping its current gain) or capture again.
  while (depth > 0) {
    depth--;
    gain[depth] = -Math.max(-gain[depth], gain[depth + 1]);
  }
  return gain[0];
}

/**
 * Least valuable attacker of ``sq`` for ``colour`` with the current occupancy.
 * Returns 0 when there is none, otherwise the attacker's square + 1.
 */
function leastValuableAttacker(sq, colour, occLo, occHi) {
  const base = colour * 6;

  // Pawns: an enemy pawn would attack `sq` from the squares our own pawns attack.
  let lo = PAWN_ATK_LO[colour ^ 1][sq] & boardLo[base];
  let hi = PAWN_ATK_HI[colour ^ 1][sq] & boardHi[base];
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) + 1;
  if (hi !== 0) return 32 + 31 - Math.clz32(hi & -hi) + 1;

  // Knights
  lo = KNIGHT_ATK_LO[sq] & boardLo[base + 1];
  hi = KNIGHT_ATK_HI[sq] & boardHi[base + 1];
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) + 1;
  if (hi !== 0) return 32 + 31 - Math.clz32(hi & -hi) + 1;

  // Bishops
  bishopAttacks(sq, occLo, occHi);
  lo = ATK_LO & boardLo[base + 2];
  hi = ATK_HI & boardHi[base + 2];
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) + 1;
  if (hi !== 0) return 32 + 31 - Math.clz32(hi & -hi) + 1;

  // Rooks
  rookAttacks(sq, occLo, occHi);
  lo = ATK_LO & boardLo[base + 3];
  hi = ATK_HI & boardHi[base + 3];
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) + 1;
  if (hi !== 0) return 32 + 31 - Math.clz32(hi & -hi) + 1;

  // Queens: diagonal or straight
  bishopAttacks(sq, occLo, occHi);
  const diagLo = ATK_LO;
  const diagHi = ATK_HI;
  rookAttacks(sq, occLo, occHi);
  lo = (diagLo | ATK_LO) & boardLo[base + 4];
  hi = (diagHi | ATK_HI) & boardHi[base + 4];
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) + 1;
  if (hi !== 0) return 32 + 31 - Math.clz32(hi & -hi) + 1;

  // King
  lo = KING_ATK_LO[sq] & boardLo[base + 5];
  hi = KING_ATK_HI[sq] & boardHi[base + 5];
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) + 1;
  if (hi !== 0) return 32 + 31 - Math.clz32(hi & -hi) + 1;

  return 0;
}

export { KNIGHT, BISHOP, ROOK, QUEEN, occupancySetOcc };
