/**
 * src/eval/evaluate.js
 *
 * SOLACE's handcrafted evaluation.  Everything is in centipawns (100 = one
 * pawn) and the function returns the score **from the point of view of the side
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
 *     supported/connected, passed pawns       (tapered, passed has rank table)
 *   - rooks on open / semi-open files,
 *     rook on the seventh rank                (tapered)
 *   - king safety: pawn shield, open files
 *     next to the king, enemy pressure on the
 *     squares around the king                 (middlegame only)
 *   - king activity                           (endgame, via the king PST)
 *
 * All tables are written from White's point of view, rank 8 first (the way
 * chess players read them) and converted to the a1..h8 internal order below.
 */

import {
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  makePiece, fileOf, rankOf,
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

// Material values (middlegame, endgame).  Pawns gain value in the endgame
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

/** Mirrored square for Black: rank 1 and rank 8 are symmetric. */
export const pstIndex = (sq, colour) => (colour === WHITE ? sq : sq ^ 56);

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

// Precomputed masks ---------------------------------------------------------
/** Squares in front of ``sq`` on its own and adjacent files (passed pawns). */
const PASSED_MASK_LO = [new Int32Array(64), new Int32Array(64)];
const PASSED_MASK_HI = [new Int32Array(64), new Int32Array(64)];
/** Squares next to ``sq`` (other files), all ranks (isolated pawns). */
const ADJACENT_FILES_LO = new Int32Array(64);
const ADJACENT_FILES_HI = new Int32Array(64);
/** The king's own square plus its neighbours. */
const KING_RING_LO = new Int32Array(64);
const KING_RING_HI = new Int32Array(64);
/** Squares directly in front of the king (its pawn shield area). */
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

    // Adjacent files, all ranks.
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

    // Passed-pawn masks (squares ahead on own + adjacent files) per colour.
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
    }

    // King ring and shield.
    KING_RING_LO[sq] = KING_ATK_LO[sq] | (sq < 32 ? 1 << sq : 0);
    KING_RING_HI[sq] = KING_ATK_HI[sq] | (sq >= 32 ? 1 << (sq - 32) : 0);

    for (const colour of [WHITE, BLACK]) {
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
  }
}
initMasks();

// Phase weights: knights/bishops 1, rooks 2, queens 4 (maximum 24).
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const MAX_PHASE = 24;

// Scratch objects reused across calls (the evaluator never allocates).
const whiteScore = { mg: 0, eg: 0 };
const blackScore = { mg: 0, eg: 0 };
const fileCounts = new Int8Array(8);

/**
 * Evaluate ``position`` from the point of view of the side to move, in
 * centipawns.  Positive means the side to move is better.
 */
export function evaluate(position) {
  sideScore(position, WHITE, whiteScore);
  sideScore(position, BLACK, blackScore);

  const phase = currentPhase(position);
  const mgWhite = whiteScore.mg - blackScore.mg;
  const egWhite = whiteScore.eg - blackScore.eg;
  const tapered = ((mgWhite * phase) + (egWhite * (MAX_PHASE - phase))) / MAX_PHASE;

  // Convert to the side-to-move's point of view, then add the tempo bonus so
  // that it always favours whoever is on the move.
  const relative = position.side === WHITE ? tapered : -tapered;
  return Math.round(relative + WEIGHTS.tempo);
}

/**
 * White-relative evaluation without the tempo bonus.  Used by the symmetry
 * tests (mirroring a position must flip the sign exactly).
 */
export function evaluateAbsolute(position) {
  sideScore(position, WHITE, whiteScore);
  sideScore(position, BLACK, blackScore);
  const phase = currentPhase(position);
  const mgWhite = whiteScore.mg - blackScore.mg;
  const egWhite = whiteScore.eg - blackScore.eg;
  return Math.round(((mgWhite * phase) + (egWhite * (MAX_PHASE - phase))) / MAX_PHASE);
}

/** Detailed numbers behind evaluate(), for debugging and the UCI "eval" command. */
export function evaluateBreakdown(position) {
  sideScore(position, WHITE, whiteScore);
  sideScore(position, BLACK, blackScore);
  const phase = currentPhase(position);
  const mg = whiteScore.mg - blackScore.mg;
  const eg = whiteScore.eg - blackScore.eg;
  const absolute = ((mg * phase) + (eg * (MAX_PHASE - phase))) / MAX_PHASE;
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
    absolute: Math.round(absolute),
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
 * Score one colour's pieces, writing { mg, eg } into ``out``.
 * Templated loops over piece bitboards keep this allocation-free.
 */
function sideScore(position, us, out) {
  const them = us ^ 1;
  let mg = 0;
  let eg = 0;

  const ownPawnLo = position.piecesLo[us * 6 + (PAWN - 1)];
  const ownPawnHi = position.piecesHi[us * 6 + (PAWN - 1)];
  const enemyPawnLo = position.piecesLo[them * 6 + (PAWN - 1)];
  const enemyPawnHi = position.piecesHi[them * 6 + (PAWN - 1)];

  // ---- material, piece-square tables and mobility -------------------------
  for (let type = PAWN; type <= KING; type++) {
    const idx = us * 6 + (type - 1);
    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? position.piecesLo[idx] : position.piecesHi[idx];
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;

        mg += PIECE_VALUE_MG[type];
        eg += PIECE_VALUE_EG[type];
        const pstSq = pstIndex(sq, us);
        mg += PST_MG[type][pstSq];
        eg += PST_EG[type][pstSq];

        // Mobility: attacked squares not occupied by our own pieces.
        if (type === PAWN || type === KING) continue;
        if (type === KNIGHT) knightAttacks(sq);
        else if (type === BISHOP) bishopAttacks(sq, position.occLo, position.occHi);
        else if (type === ROOK) rookAttacks(sq, position.occLo, position.occHi);
        else queenAttacks(sq, position.occLo, position.occHi);
        const mobLo = ATK_LO & ~position.colourLo[us];
        const mobHi = ATK_HI & ~position.colourHi[us];
        const mobility = popcount(mobLo) + popcount(mobHi);
        mg += mobility * WEIGHTS.mobilityMg[type];
        eg += mobility * WEIGHTS.mobilityEg[type];
      }
    }
  }

  // ---- bishop pair --------------------------------------------------------
  if (position.pieceCount(us, BISHOP) >= 2) {
    mg += WEIGHTS.bishopPairMg;
    eg += WEIGHTS.bishopPairEg;
  }

  // ---- pawn structure -----------------------------------------------------
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
      const relRank = us === WHITE ? r : 7 - r;

      // Doubled: more than one own pawn on this file.
      if (fileCounts[f] > 1) {
        mg += WEIGHTS.doubledMg;
        eg += WEIGHTS.doubledEg;
      }

      // Isolated: no own pawn on either adjacent file.
      const adjLo = ADJACENT_FILES_LO[sq];
      const adjHi = ADJACENT_FILES_HI[sq];
      if ((adjLo & ownPawnLo) === 0 && (adjHi & ownPawnHi) === 0) {
        mg += WEIGHTS.isolatedMg;
        eg += WEIGHTS.isolatedEg;
      }

      // Supported (our pawn attacks this square) and phalanx (neighbour rank).
      const supportersLo = PAWN_ATK_LO[us ^ 1][sq];
      const supportersHi = PAWN_ATK_HI[us ^ 1][sq];
      if ((supportersLo & ownPawnLo) !== 0 || (supportersHi & ownPawnHi) !== 0) {
        mg += WEIGHTS.supportedMg;
        eg += WEIGHTS.supportedEg;
      }
      const neighbourLo = (f > 0 ? FILE_BB_LO[f - 1] : 0) | (f < 7 ? FILE_BB_LO[f + 1] : 0);
      const neighbourHi = (f > 0 ? FILE_BB_HI[f - 1] : 0) | (f < 7 ? FILE_BB_HI[f + 1] : 0);
      if (((neighbourLo & RANK_BB_LO[r] & ownPawnLo) !== 0)
        || ((neighbourHi & RANK_BB_HI[r] & ownPawnHi) !== 0)) {
        mg += WEIGHTS.phalanxMg;
        eg += WEIGHTS.phalanxEg;
      }

      // Passed pawn: no enemy pawn ahead on this or an adjacent file.
      const passedLo = PASSED_MASK_LO[us][sq];
      const passedHi = PASSED_MASK_HI[us][sq];
      if ((passedLo & enemyPawnLo) === 0 && (passedHi & enemyPawnHi) === 0) {
        mg += WEIGHTS.passedMg[relRank];
        eg += WEIGHTS.passedEg[relRank];
        // In the endgame the king should escort / stop passers.
        const enemyKing = position.kingSq[them];
        const ownKing = position.kingSq[us];
        if (enemyKing >= 0 && ownKing >= 0) {
          eg += WEIGHTS.passedKingSupportEg * (distance(enemyKing, sq) - distance(ownKing, sq));
        }
      }
    }
  }

  // ---- rooks --------------------------------------------------------------
  const rookIdx = us * 6 + (ROOK - 1);
  for (let word = 0; word < 2; word++) {
    let bits = word === 0 ? position.piecesLo[rookIdx] : position.piecesHi[rookIdx];
    const base = word === 0 ? 0 : 32;
    while (bits !== 0) {
      const sq = base + 31 - Math.clz32(bits & -bits);
      bits &= bits - 1;
      const f = fileOf(sq);
      const r = rankOf(sq);
      const fileOwnLo = FILE_BB_LO[f] & ownPawnLo;
      const fileOwnHi = FILE_BB_HI[f] & ownPawnHi;
      const fileEnemyLo = FILE_BB_LO[f] & enemyPawnLo;
      const fileEnemyHi = FILE_BB_HI[f] & enemyPawnHi;
      const ownPawnOnFile = (fileOwnLo | fileOwnHi) !== 0;
      const enemyPawnOnFile = (fileEnemyLo | fileEnemyHi) !== 0;
      if (!ownPawnOnFile && !enemyPawnOnFile) {
        mg += WEIGHTS.rookOpenFileMg;
        eg += WEIGHTS.rookOpenFileEg;
      } else if (!ownPawnOnFile) {
        mg += WEIGHTS.rookSemiOpenFileMg;
        eg += WEIGHTS.rookSemiOpenFileEg;
      }
      const relRank = us === WHITE ? r : 7 - r;
      if (relRank === 6) {
        mg += WEIGHTS.rookSeventhMg;
        eg += WEIGHTS.rookSeventhEg;
      }
    }
  }

  // ---- king safety (middlegame only) --------------------------------------
  const kingSq = position.kingSq[us];
  if (kingSq >= 0) {
    // Pawn shield: own pawns on the two ranks in front of the king.
    const shieldLo = SHIELD_LO[us][kingSq] & ownPawnLo;
    const shieldHi = SHIELD_HI[us][kingSq] & ownPawnHi;
    const shieldCount = popcount(shieldLo) + popcount(shieldHi);
    mg += shieldCount * WEIGHTS.kingShieldMg;

    // Open / semi-open files next to the king are dangerous.
    const kingFile = fileOf(kingSq);
    for (let df = -1; df <= 1; df++) {
      const f = kingFile + df;
      if (f < 0 || f > 7) continue;
      const ownOnFile = ((FILE_BB_LO[f] & ownPawnLo) | (FILE_BB_HI[f] & ownPawnHi)) !== 0;
      const enemyOnFile = ((FILE_BB_LO[f] & enemyPawnLo) | (FILE_BB_HI[f] & enemyPawnHi)) !== 0;
      if (!ownOnFile && !enemyOnFile) mg += WEIGHTS.kingOpenFileMg;
      else if (!ownOnFile) mg += WEIGHTS.kingSemiOpenFileMg;
    }

    // Enemy pressure on the squares around our king.
    let danger = 0;
    for (let type = KNIGHT; type <= QUEEN; type++) {
      const weight = WEIGHTS.kingAttackWeight[type];
      if (weight === 0) continue;
      const idx = them * 6 + (type - 1);
      for (let word = 0; word < 2; word++) {
        let bits = word === 0 ? position.piecesLo[idx] : position.piecesHi[idx];
        const base = word === 0 ? 0 : 32;
        while (bits !== 0) {
          const sq = base + 31 - Math.clz32(bits & -bits);
          bits &= bits - 1;
          if (type === KNIGHT) knightAttacks(sq);
          else if (type === BISHOP) bishopAttacks(sq, position.occLo, position.occHi);
          else if (type === ROOK) rookAttacks(sq, position.occLo, position.occHi);
          else queenAttacks(sq, position.occLo, position.occHi);
          const hits = popcount(ATK_LO & KING_RING_LO[kingSq]) + popcount(ATK_HI & KING_RING_HI[kingSq]);
          danger += hits * weight;
        }
      }
    }
    // Enemy pawns pressing on the king ring are dangerous too.
    const enemyPawnIdx = them * 6;
    for (let word = 0; word < 2; word++) {
      let bits = word === 0 ? position.piecesLo[enemyPawnIdx] : position.piecesHi[enemyPawnIdx];
      const base = word === 0 ? 0 : 32;
      while (bits !== 0) {
        const sq = base + 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const hitsLo = PAWN_ATK_LO[them][sq] & KING_RING_LO[kingSq];
        const hitsHi = PAWN_ATK_HI[them][sq] & KING_RING_HI[kingSq];
        danger += (popcount(hitsLo) + popcount(hitsHi)) * WEIGHTS.kingAttackWeight[PAWN];
      }
    }
    if (danger > 0) {
      const penalty = Math.min((danger * danger) / WEIGHTS.kingDangerDivisor, WEIGHTS.kingDangerMax);
      mg -= penalty;
    }
  }

  out.mg = mg;
  out.eg = eg;
  return out;
}

function popcount(v) {
  const x = v >>> 0;
  const a = x - ((x >>> 1) & 0x55555555);
  const b = (a & 0x33333333) + ((a >>> 2) & 0x33333333);
  return (((b + (b >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

