/**
 * src/eval/evaluate.js
 *
 * SOLACE's handcrafted evaluation.  Everything is in centipawns (100 = one
 * pawn) and evaluate() returns the score **from the point of view of the side
 * to move**, which is the convention the negamax search expects.
 *
 * The evaluation is tapered: every term contributes a middlegame value and an
 * endgame value, interpolated by the amount of material left on the board.
 *
 * Terms:
 *   - material                                (tapered)
 *   - piece-square tables                     (tapered)
 *   - mobility per piece                      (tapered)
 *   - bishop pair                             (tapered)
 *   - pawn structure: doubled, isolated,
 *     supported/connected, passed pawns       (tapered; passed pawns use a
 *                                              rank-dependent table plus king
 *                                              distance in the endgame)
 *   - rooks on open / semi-open files and on
 *     the seventh rank                        (tapered)
 *   - king safety: pawn shield, open files
 *     next to the king, enemy pressure on the
 *     squares around the king                 (middlegame only)
 *   - king activity                           (endgame, via the king PST)
 *
 * The whole evaluation is a single pass over the piece bitboards: the attack
 * sets computed for mobility are reused for the king-danger term, so no square
 * is attacked twice.  It allocates nothing.
 *
 * All tables are written from White's point of view, rank 8 first (the way chess
 * players read them) and converted to internal a1..h8 order below.  A mirrored
 * copy for Black is built once, so no rank flipping happens per square.
 */

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  fileOf, rankOf,
} from '../core/types.js';
import {
  PAWN_ATK_LO, PAWN_ATK_HI, KING_ATK_LO, KING_ATK_HI,
  knightAttacks, bishopAttacks, rookAttacks, queenAttacks,
  ATK_LO, ATK_HI, FILE_BB_LO, FILE_BB_HI, RANK_BB_LO, RANK_BB_HI, distance,
} from '../core/bitboards.js';

// ---------------------------------------------------------------------------
// Tables.  ``rows[0]`` is rank 8 (a8..h8), ``rows[7]`` is rank 1.
// ---------------------------------------------------------------------------
function tableFromRows(rows) {
  const table = new Int16Array(64);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) table[(7 - r) * 8 + f] = rows[r][f];
  }
  return table;
}

// Material values (middlegame, endgame).  Pawns are worth more in the endgame
// because promotion chances matter more than in the middlegame.
export const PIECE_VALUE_MG = [0, 100, 320, 335, 500, 950, 0];
export const PIECE_VALUE_EG = [0, 125, 320, 350, 545, 1000, 0];

export const PST_PAWN_MG = tableFromRows([
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 27, 27, 10, 5, 5],
  [0, 0, 0, 25, 25, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -25, -25, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
]);
export const PST_PAWN_EG = tableFromRows([
  [0, 0, 0, 0, 0, 0, 0, 0],
  [85, 85, 85, 85, 85, 85, 85, 85],
  [55, 55, 55, 55, 55, 55, 55, 55],
  [30, 30, 30, 30, 30, 30, 30, 30],
  [15, 15, 15, 15, 15, 15, 15, 15],
  [5, 5, 5, 5, 5, 5, 5, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
]);
export const PST_KNIGHT_MG = tableFromRows([
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50],
]);
export const PST_KNIGHT_EG = tableFromRows([
  [-30, -20, -10, -10, -10, -10, -20, -30],
  [-20, -10, 0, 5, 5, 0, -10, -20],
  [-10, 0, 10, 15, 15, 10, 0, -10],
  [-10, 5, 15, 20, 20, 15, 5, -10],
  [-10, 0, 15, 20, 20, 15, 0, -10],
  [-10, 5, 10, 15, 15, 10, 5, -10],
  [-20, -10, 0, 5, 5, 0, -10, -20],
  [-30, -20, -10, -10, -10, -10, -20, -30],
]);
export const PST_BISHOP_MG = tableFromRows([
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
]);
export const PST_BISHOP_EG = tableFromRows([
  [-15, -10, -5, -5, -5, -5, -10, -15],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 5, 10, 10, 10, 10, 5, -5],
  [-5, 5, 10, 15, 15, 10, 5, -5],
  [-5, 5, 10, 15, 15, 10, 5, -5],
  [-5, 5, 10, 10, 10, 10, 5, -5],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-15, -10, -5, -5, -5, -5, -10, -15],
]);
export const PST_ROOK_MG = tableFromRows([
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0],
]);
export const PST_ROOK_EG = tableFromRows([
  [-5, -5, -5, -5, -5, -5, -5, -5],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 5, 5, 5, 5, 5, 5, 5],
  [5, 5, 5, 5, 5, 5, 5, 5],
]);
export const PST_QUEEN_MG = tableFromRows([
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
]);
export const PST_QUEEN_EG = tableFromRows([
  [-10, -5, -5, -5, -5, -5, -5, -10],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [-5, 0, 5, 10, 10, 5, 0, -5],
  [-5, 0, 5, 10, 10, 5, 0, -5],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-10, -5, -5, -5, -5, -5, -5, -10],
]);
export const PST_KING_MG = tableFromRows([
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20],
]);
export const PST_KING_EG = tableFromRows([
  [-50, -40, -30, -20, -20, -30, -40, -50],
  [-30, -20, -10, 0, 0, -10, -20, -30],
  [-30, -10, 20, 30, 30, 20, -10, -30],
  [-30, -10, 30, 40, 40, 30, -10, -30],
  [-30, -10, 30, 40, 40, 30, -10, -30],
  [-30, -10, 20, 30, 30, 20, -10, -30],
  [-30, -30, 0, 0, 0, 0, -30, -30],
  [-50, -30, -30, -30, -30, -30, -30, -50],
]);

export const PST_MG = [null, PST_PAWN_MG, PST_KNIGHT_MG, PST_BISHOP_MG, PST_ROOK_MG, PST_QUEEN_MG, PST_KING_MG];
export const PST_EG = [null, PST_PAWN_EG, PST_KNIGHT_EG, PST_BISHOP_EG, PST_ROOK_EG, PST_QUEEN_EG, PST_KING_EG];

/** Mirrored square for Black: the board is symmetric between ranks 1 and 8. */
export const pstIndex = (sq, colour) => (colour === WHITE ? sq : sq ^ 56);

/** PST_MG_BY_COLOUR[colour][type][square]: pre-mirrored, no branches at run time. */
const PST_MG_BY_COLOUR = [[], []];
const PST_EG_BY_COLOUR = [[], []];
for (let type = PAWN; type <= KING; type++) {
  PST_MG_BY_COLOUR[WHITE][type] = PST_MG[type];
  PST_EG_BY_COLOUR[WHITE][type] = PST_EG[type];
  const mirrorMg = new Int16Array(64);
  const mirrorEg = new Int16Array(64);
  for (let sq = 0; sq < 64; sq++) {
    mirrorMg[sq] = PST_MG[type][sq ^ 56];
    mirrorEg[sq] = PST_EG[type][sq ^ 56];
  }
  PST_MG_BY_COLOUR[BLACK][type] = mirrorMg;
  PST_EG_BY_COLOUR[BLACK][type] = mirrorEg;
}
export { PST_MG_BY_COLOUR, PST_EG_BY_COLOUR };

// ---------------------------------------------------------------------------
// Tunable term weights
// ---------------------------------------------------------------------------
export const WEIGHTS = {
  bishopPairMg: 30,
  bishopPairEg: 45,
  mobilityMg: [0, 0, 4, 3, 2, 1, 0],
  mobilityEg: [0, 0, 4, 3, 4, 1, 0],
  doubledMg: -10,
  doubledEg: -16,
  isolatedMg: -12,
  isolatedEg: -12,
  supportedMg: 7,
  supportedEg: 5,
  phalanxMg: 4,
  phalanxEg: 3,
  passedMg: [0, 5, 8, 15, 28, 45, 70, 0],
  passedEg: [0, 10, 18, 32, 55, 85, 125, 0],
  rookOpenFileMg: 22,
  rookOpenFileEg: 12,
  rookSemiOpenFileMg: 10,
  rookSemiOpenFileEg: 6,
  rookSeventhMg: 18,
  rookSeventhEg: 25,
  kingShieldMg: 9,
  kingOpenFileMg: -22,
  kingSemiOpenFileMg: -10,
  kingAttackWeight: [0, 1, 2, 2, 3, 5, 0], // per piece attacking the king ring
  kingDangerDivisor: 4,
  kingDangerMax: 320,
  passedKingSupportEg: 5,
  tempo: 8,
};

// ---------------------------------------------------------------------------
// Precomputed masks
// ---------------------------------------------------------------------------
/** Squares in front of ``sq`` on its own and adjacent files (passed pawns). */
const PASSED_MASK_LO = [new Int32Array(64), new Int32Array(64)];
const PASSED_MASK_HI = [new Int32Array(64), new Int32Array(64)];
/** Squares on the two files next to ``sq`` (isolated pawns). */
const ADJACENT_FILES_LO = new Int32Array(64);
const ADJACENT_FILES_HI = new Int32Array(64);
/** The king's own square plus its neighbours. */
const KING_RING_LO = new Int32Array(64);
const KING_RING_HI = new Int32Array(64);
/** The two ranks in front of the king (its pawn shield area). */
const SHIELD_LO = [new Int32Array(64), new Int32Array(64)];
const SHIELD_HI = [new Int32Array(64), new Int32Array(64)];

function setBit(arrLo, arrHi, sq) {
  if (sq < 32) arrLo[sq] |= 1 << sq;
  else arrHi[sq] |= 1 << (sq - 32);
}

function initMasks() {
  for (let sq = 0; sq < 64; sq++) {
    const f = fileOf(sq);
    const r = rankOf(sq);

    for (let rr = 0; rr < 8; rr++) {
      for (const df of [-1, 1]) {
        const ff = f + df;
        if (ff >= 0 && ff < 8) {
          const s = rr * 8 + ff;
          if (s < 32) ADJACENT_FILES_LO[sq] |= 1 << s;
          else ADJACENT_FILES_HI[sq] |= 1 << (s - 32);
        }
      }
    }

    for (const colour of [WHITE, BLACK]) {
      for (let rr = 0; rr < 8; rr++) {
        const ahead = colour === WHITE ? rr > r : rr < r;
        if (!ahead) continue;
        for (let df = -1; df <= 1; df++) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          setBit(PASSED_MASK_LO[colour], PASSED_MASK_HI[colour], rr * 8 + ff);
        }
      }
      const dir = colour === WHITE ? 1 : -1;
      for (let dr = 1; dr <= 2; dr++) {
        const rr = r + dir * dr;
        if (rr < 0 || rr > 7) continue;
        for (let df = -1; df <= 1; df++) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          setBit(SHIELD_LO[colour], SHIELD_HI[colour], rr * 8 + ff);
        }
      }
    }

    KING_RING_LO[sq] = KING_ATK_LO[sq] | (sq < 32 ? 1 << sq : 0);
    KING_RING_HI[sq] = KING_ATK_HI[sq] | (sq >= 32 ? 1 << (sq - 32) : 0);
  }
}
initMasks();

// Phase weights: knights/bishops 1, rooks 2, queens 4 (maximum 24).
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const MAX_PHASE = 24;

function popcount(v) {
  const x = v >>> 0;
  const a = x - ((x >>> 1) & 0x55555555);
  const b = (a & 0x33333333) + ((a >>> 2) & 0x33333333);
  return (((b + (b >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Scratch storage: the evaluator never allocates.
const totals = {
  mg: [0, 0],
  eg: [0, 0],
  danger: [0, 0],
};
const fileCounts = new Int32Array(8);

/**
 * Evaluate ``position`` from the point of view of the side to move, in
 * centipawns.  Positive means the side to move is better.
 */
export function evaluate(position) {
  evaluateBothSides(position);
  const phase = currentPhase(position);
  const mgWhite = totals.mg[WHITE] - totals.mg[BLACK];
  const egWhite = totals.eg[WHITE] - totals.eg[BLACK];
  const tapered = ((mgWhite * phase) + (egWhite * (MAX_PHASE - phase))) / MAX_PHASE;
  const relative = position.side === WHITE ? tapered : -tapered;
  return Math.round(relative + WEIGHTS.tempo);
}

/**
 * White-relative evaluation without the tempo bonus.  Used by the symmetry
 * tests (mirroring a position must flip the sign exactly).
 */
export function evaluateAbsolute(position) {
  evaluateBothSides(position);
  const phase = currentPhase(position);
  const mgWhite = totals.mg[WHITE] - totals.mg[BLACK];
  const egWhite = totals.eg[WHITE] - totals.eg[BLACK];
  return Math.round(((mgWhite * phase) + (egWhite * (MAX_PHASE - phase))) / MAX_PHASE);
}

/** Detailed numbers behind evaluate(), for debugging and the UCI "eval" command. */
export function evaluateBreakdown(position) {
  evaluateBothSides(position);
  const phase = currentPhase(position);
  const mg = totals.mg[WHITE] - totals.mg[BLACK];
  const eg = totals.eg[WHITE] - totals.eg[BLACK];
  let materialWhite = 0;
  let materialBlack = 0;
  for (let type = PAWN; type <= QUEEN; type++) {
    materialWhite += position.pieceCount(WHITE, type) * PIECE_VALUE_MG[type];
    materialBlack += position.pieceCount(BLACK, type) * PIECE_VALUE_MG[type];
  }
  return {
    mg: Math.round(mg),
    eg: Math.round(eg),
    phase,
    absolute: Math.round(((mg * phase) + (eg * (MAX_PHASE - phase))) / MAX_PHASE),
    materialWhite,
    materialBlack,
  };
}

/** Material phase 0 (pure endgame) .. 24 (full material). */
export function currentPhase(position) {
  let phase = 0;
  for (let type = KNIGHT; type <= QUEEN; type++) {
    phase += (position.pieceCount(WHITE, type) + position.pieceCount(BLACK, type)) * PHASE_WEIGHT[type];
  }
  return Math.min(phase, MAX_PHASE);
}

/**
 * The real work: score both sides in one pass over the piece bitboards.
 * Results land in the module-level ``totals`` object.
 */
function evaluateBothSides(position) {
  const occLo = position.occLo;
  const occHi = position.occHi;
  totals.danger[WHITE] = 0;
  totals.danger[BLACK] = 0;

  const kingSqW = position.kingSq[WHITE];
  const kingSqB = position.kingSq[BLACK];
  const ringWLo = kingSqW >= 0 ? KING_RING_LO[kingSqW] : 0;
  const ringWHi = kingSqW >= 0 ? KING_RING_HI[kingSqW] : 0;
  const ringBLo = kingSqB >= 0 ? KING_RING_LO[kingSqB] : 0;
  const ringBHi = kingSqB >= 0 ? KING_RING_HI[kingSqB] : 0;

  for (let colour = 0; colour < 2; colour++) {
    const them = colour ^ 1;
    const pstMg = PST_MG_BY_COLOUR[colour];
    const pstEg = PST_EG_BY_COLOUR[colour];
    let mg = 0;
    let eg = 0;
    let danger = 0;

    // Ring of the enemy king: attacks landing there count towards our danger.
    const enemyRingLo = them === WHITE ? ringWLo : ringBLo;
    const enemyRingHi = them === WHITE ? ringWHi : ringBHi;
    const weights = WEIGHTS.kingAttackWeight;

    for (let type = PAWN; type <= KING; type++) {
      const idx = colour * 6 + (type - 1);
      const weight = weights[type];
      for (let word = 0; word < 2; word++) {
        let bits = word === 0 ? position.piecesLo[idx] : position.piecesHi[idx];
        const base = word === 0 ? 0 : 32;
        while (bits !== 0) {
          const sq = base + 31 - Math.clz32(bits & -bits);
          bits &= bits - 1;

          mg += PIECE_VALUE_MG[type] + pstMg[type][sq];
          eg += PIECE_VALUE_EG[type] + pstEg[type][sq];

          // Attacks (skipped for pawns and the king when nothing needs them).
          if (type === PAWN) {
            if (weight !== 0 && (enemyRingLo | enemyRingHi) !== 0) {
              const hitsLo = PAWN_ATK_LO[colour][sq] & enemyRingLo;
              const hitsHi = PAWN_ATK_HI[colour][sq] & enemyRingHi;
              danger += (popcount(hitsLo) + popcount(hitsHi)) * weight;
            }
            continue;
          }
          if (type === KING) continue;

          if (type === KNIGHT) knightAttacks(sq);
          else if (type === BISHOP) bishopAttacks(sq, occLo, occHi);
          else if (type === ROOK) rookAttacks(sq, occLo, occHi);
          else queenAttacks(sq, occLo, occHi);

          // Mobility: attacked squares not occupied by our own pieces.
          const mobLo = ATK_LO & ~position.colourLo[colour];
          const mobHi = ATK_HI & ~position.colourHi[colour];
          const mobility = popcount(mobLo) + popcount(mobHi);
          mg += mobility * WEIGHTS.mobilityMg[type];
          eg += mobility * WEIGHTS.mobilityEg[type];

          if (weight !== 0 && (enemyRingLo | enemyRingHi) !== 0) {
            danger += (popcount(ATK_LO & enemyRingLo) + popcount(ATK_HI & enemyRingHi)) * weight;
          }
        }
      }
    }

    // Bishop pair
    if (position.pieceCount(colour, BISHOP) >= 2) {
      mg += WEIGHTS.bishopPairMg;
      eg += WEIGHTS.bishopPairEg;
    }

    // ---- pawn structure ---------------------------------------------------
    const ownPawnLo = position.piecesLo[colour * 6];
    const ownPawnHi = position.piecesHi[colour * 6];
    const enemyPawnLo = position.piecesLo[them * 6];
    const enemyPawnHi = position.piecesHi[them * 6];

    for (let f = 0; f < 8; f++) {
      fileCounts[f] = popcount(ownPawnLo & FILE_BB_LO[f]) + popcount(ownPawnHi & FILE_BB_HI[f]);
    }

    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? ownPawnLo : ownPawnHi;
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const f = fileOf(sq);
        const r = rankOf(sq);
        const relRank = colour === WHITE ? r : 7 - r;

        if (fileCounts[f] > 1) {
          mg += WEIGHTS.doubledMg;
          eg += WEIGHTS.doubledEg;
        }

        if (((ADJACENT_FILES_LO[sq] & ownPawnLo) | (ADJACENT_FILES_HI[sq] & ownPawnHi)) === 0) {
          mg += WEIGHTS.isolatedMg;
          eg += WEIGHTS.isolatedEg;
        }

        // Supported by a pawn (a pawn of the *enemy* colour attacks this square
        // from exactly the squares our own supporting pawns stand on).
        if (((PAWN_ATK_LO[colour ^ 1][sq] & ownPawnLo) | (PAWN_ATK_HI[colour ^ 1][sq] & ownPawnHi)) !== 0) {
          mg += WEIGHTS.supportedMg;
          eg += WEIGHTS.supportedEg;
        }

        // Phalanx: a friendly pawn next to it on the same rank.
        const neighbourLo = (f > 0 ? FILE_BB_LO[f - 1] : 0) | (f < 7 ? FILE_BB_LO[f + 1] : 0);
        const neighbourHi = (f > 0 ? FILE_BB_HI[f - 1] : 0) | (f < 7 ? FILE_BB_HI[f + 1] : 0);
        if (((neighbourLo & RANK_BB_LO[r] & ownPawnLo) | (neighbourHi & RANK_BB_HI[r] & ownPawnHi)) !== 0) {
          mg += WEIGHTS.phalanxMg;
          eg += WEIGHTS.phalanxEg;
        }

        // Passed pawn
        if (((PASSED_MASK_LO[colour][sq] & enemyPawnLo) | (PASSED_MASK_HI[colour][sq] & enemyPawnHi)) === 0) {
          mg += WEIGHTS.passedMg[relRank];
          eg += WEIGHTS.passedEg[relRank];
          const ownKing = position.kingSq[colour];
          const enemyKing = position.kingSq[them];
          if (ownKing >= 0 && enemyKing >= 0) {
            eg += WEIGHTS.passedKingSupportEg * (distance(enemyKing, sq) - distance(ownKing, sq));
          }
        }
      }
    }

    // ---- rooks ------------------------------------------------------------
    const rookIdx = colour * 6 + (ROOK - 1);
    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? position.piecesLo[rookIdx] : position.piecesHi[rookIdx];
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const f = fileOf(sq);
        const r = rankOf(sq);
        const ownPawnOnFile = ((FILE_BB_LO[f] & ownPawnLo) | (FILE_BB_HI[f] & ownPawnHi)) !== 0;
        const enemyPawnOnFile = ((FILE_BB_LO[f] & enemyPawnLo) | (FILE_BB_HI[f] & enemyPawnHi)) !== 0;
        if (!ownPawnOnFile && !enemyPawnOnFile) {
          mg += WEIGHTS.rookOpenFileMg;
          eg += WEIGHTS.rookOpenFileEg;
        } else if (!ownPawnOnFile) {
          mg += WEIGHTS.rookSemiOpenFileMg;
          eg += WEIGHTS.rookSemiOpenFileEg;
        }
        if ((colour === WHITE ? r : 7 - r) === 6) {
          mg += WEIGHTS.rookSeventhMg;
          eg += WEIGHTS.rookSeventhEg;
        }
      }
    }

    // ---- king safety (middlegame only) ------------------------------------
    const kingSq = position.kingSq[colour];
    if (kingSq >= 0) {
      const shieldLo = SHIELD_LO[colour][kingSq] & ownPawnLo;
      const shieldHi = SHIELD_HI[colour][kingSq] & ownPawnHi;
      mg += (popcount(shieldLo) + popcount(shieldHi)) * WEIGHTS.kingShieldMg;

      const kingFile = fileOf(kingSq);
      for (let df = -1; df <= 1; df++) {
        const f = kingFile + df;
        if (f < 0 || f > 7) continue;
        const ownOnFile = ((FILE_BB_LO[f] & ownPawnLo) | (FILE_BB_HI[f] & ownPawnHi)) !== 0;
        const enemyOnFile = ((FILE_BB_LO[f] & enemyPawnLo) | (FILE_BB_HI[f] & enemyPawnHi)) !== 0;
        if (!ownOnFile && !enemyOnFile) mg += WEIGHTS.kingOpenFileMg;
        else if (!ownOnFile) mg += WEIGHTS.kingSemiOpenFileMg;
      }
    }

    totals.mg[colour] = mg;
    totals.eg[colour] = eg;
    // `danger` collected while iterating this colour is danger *against* them.
    totals.danger[them] += danger;
  }

  // Apply the king-danger penalty to the king being attacked (middlegame only).
  for (let colour = 0; colour < 2; colour++) {
    const danger = totals.danger[colour];
    if (danger > 0) {
      totals.mg[colour] -= Math.min((danger * danger) / WEIGHTS.kingDangerDivisor, WEIGHTS.kingDangerMax);
    }
  }
}

export { RANK_BB_LO, RANK_BB_HI };
