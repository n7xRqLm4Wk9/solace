/**
 * src/search/moveOrdering.js
 *
 * Move ordering decides how much of the search tree alpha-beta actually cuts
 * away, so it matters as much as raw speed.  Order used:
 *
 *   1. transposition-table move
 *   2. winning/good captures (MVV-LVA: most valuable victim, least valuable
 *      attacker) and queen promotions
 *   3. killer moves (quiet moves that caused a cutoff at the same ply)
 *   4. quiet moves ordered by the history heuristic
 *
 * Scoring writes into MoveList.scores; pickNext() then performs the selection
 * sort lazily so only the moves that are actually searched get sorted.
 */

import {
  PAWN, KNIGHT, BISHOP, ROOK, QUEEN,
} from '../core/types.js';
import {
  moveTo, moveFrom, movePieceType, moveCapturedType, isCapture, isPromotion, promotionType,
} from '../core/moves.js';

// Values only used to rank captures, in centipawns.
export const ORDER_VALUE = [0, 100, 320, 330, 500, 950, 0];

const TT_SCORE = 1 << 30;
const CAPTURE_BASE = 1 << 24;
const KILLER_1 = 1 << 22;
const KILLER_2 = 1 << 21;
const HISTORY_MAX = (1 << 20) - 1;

/** Fill ``list.scores`` for the given search state. */
export function scoreMoves(list, ttMove, side, ply, killer1, killer2, history) {
  const historyBase = side * 4096;
  for (let i = 0; i < list.count; i++) {
    const move = list.moves[i];
    let score;
    if (move === ttMove) {
      score = TT_SCORE;
    } else if (isCapture(move)) {
      const victim = moveCapturedType(move);
      const attacker = movePieceType(move);
      score = CAPTURE_BASE + ORDER_VALUE[victim] * 16 - ORDER_VALUE[attacker];
      if (isPromotion(move)) score += 800000;
    } else if (isPromotion(move)) {
      // Quiet queen promotion is nearly as good as a capture.
      score = CAPTURE_BASE + ORDER_VALUE[promotionType(move)] * 16;
    } else if (move === killer1[ply]) {
      score = KILLER_1;
    } else if (move === killer2[ply]) {
      score = KILLER_2;
    } else {
      score = Math.min(history[historyBase + historyIndex(move)], HISTORY_MAX);
    }
    list.scores[i] = score;
  }
}

/** Compact from/to index into the history table (64*64 per colour). */
export function historyIndex(move) {
  return (moveFrom(move) << 6) | moveTo(move);
}

/**
 * Selection sort step: move the best remaining move to ``start`` and return it.
 * Only the moves that the search reaches are ever compared, which is cheaper
 * than sorting the whole list.
 */
export function pickNext(list, start) {
  let bestIndex = start;
  let bestScore = list.scores[start];
  for (let i = start + 1; i < list.count; i++) {
    if (list.scores[i] > bestScore) {
      bestScore = list.scores[i];
      bestIndex = i;
    }
  }
  if (bestIndex !== start) {
    const move = list.moves[start];
    list.moves[start] = list.moves[bestIndex];
    list.moves[bestIndex] = move;
    const score = list.scores[start];
    list.scores[start] = list.scores[bestIndex];
    list.scores[bestIndex] = score;
  }
  return list.moves[start];
}

export { PAWN, KNIGHT, BISHOP, ROOK, QUEEN };
