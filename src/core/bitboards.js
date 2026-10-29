/**
 * src/core/bitboards.js
 *
 * Attack generation.  Sliding pieces use magic bitboards: the attack tables are
 * filled at start-up (a few milliseconds) from the magic numbers in
 * ``magics.js``.  Leapers (knight, king, pawn) use plain 64-entry tables.
 *
 * 64-bit sets are passed around as two 32-bit words.  The attack functions
 * write their result into the module-level pair ``ATK_LO`` / ``ATK_HI`` rather
 * than returning an object, so nothing is allocated in the search hot path.
 */

import {
  WHITE, BLACK, KNIGHT, KING, PAWN,
  lsbIndex, mulShi32, productWord1,
} from './types.js';
import {
  ROOK_MAGIC_LO, ROOK_MAGIC_HI, BISHOP_MAGIC_LO, BISHOP_MAGIC_HI,
  ROOK_MASK_LO, ROOK_MASK_HI, BISHOP_MASK_LO, BISHOP_MASK_HI,
  ROOK_SHIFT, BISHOP_SHIFT,
} from './magics.js';

// ---------------------------------------------------------------------------
// Result registers of the attack functions
// ---------------------------------------------------------------------------
/** Set by every attack helper below: the attacked squares as two words. */
export let ATK_LO = 0;
export let ATK_HI = 0;

// ---------------------------------------------------------------------------
// Leaper tables
// ---------------------------------------------------------------------------
export const KNIGHT_ATK_LO = new Int32Array(64);
export const KNIGHT_ATK_HI = new Int32Array(64);
export const KING_ATK_LO = new Int32Array(64);
export const KING_ATK_HI = new Int32Array(64);
/** PAWN_ATK_LO[colour][square]: squares attacked by a pawn of that colour. */
export const PAWN_ATK_LO = [new Int32Array(64), new Int32Array(64)];
export const PAWN_ATK_HI = [new Int32Array(64), new Int32Array(64)];

const KNIGHT_STEPS = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_STEPS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Slow reference ray scan used to build the magic tables. */
function rayAttacks(sq, dirs, occLo, occHi) {
  const file = sq & 7;
  const rank = sq >> 3;
  let lo = 0;
  let hi = 0;
  for (let d = 0; d < dirs.length; d++) {
    const df = dirs[d][0];
    const dr = dirs[d][1];
    let f = file + df;
    let r = rank + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const s = r * 8 + f;
      if (s < 32) lo |= 1 << s;
      else hi |= 1 << (s - 32);
      const blocked = s < 32 ? (occLo & (1 << s)) !== 0 : (occHi & (1 << (s - 32))) !== 0;
      if (blocked) break;
      f += df;
      r += dr;
    }
  }
  return [lo, hi];
}

/** Squares on a ray that are relevant for sliding attacks (edges excluded). */
function relevantMask(sq, dirs) {
  const file = sq & 7;
  const rank = sq >> 3;
  let lo = 0;
  let hi = 0;
  for (let d = 0; d < dirs.length; d++) {
    const df = dirs[d][0];
    const dr = dirs[d][1];
    let f = file + df;
    let r = rank + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const nf = f + df;
      const nr = r + dr;
      const onEdge = nf < 0 || nf > 7 || nr < 0 || nr > 7;
      if (!onEdge) {
        const s = r * 8 + f;
        if (s < 32) lo |= 1 << s;
        else hi |= 1 << (s - 32);
      }
      f += df;
      r += dr;
    }
  }
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Magic attack tables
// ---------------------------------------------------------------------------
export const ROOK_TABLE_LO = new Int32Array(102400);
export const ROOK_TABLE_HI = new Int32Array(102400);
export const BISHOP_TABLE_LO = new Int32Array(5248);
export const BISHOP_TABLE_HI = new Int32Array(5248);
export const ROOK_OFFSET = new Int32Array(64);
export const BISHOP_OFFSET = new Int32Array(64);

/** Milliseconds spent building the attack tables (reported by "bench"). */
export let TABLE_BUILD_MS = 0;

function fillTable(dirs, magicLo, magicHi, maskLo, maskHi, shift, offsets, tableLo, tableHi) {
  let offset = 0;
  for (let sq = 0; sq < 64; sq++) {
    offsets[sq] = offset;
    const mLo = maskLo[sq];
    const mHi = maskHi[sq];
    const bits = 32 - shift[sq];
    const size = 1 << bits;
    const used = new Uint8Array(size);

    // Enumerate every subset of the relevant-occupancy mask (Carry-Rippler).
    let sLo = 0;
    let sHi = 0;
    for (;;) {
      const a = rayAttacks(sq, dirs, sLo, sHi);
      const idx = (productWord1(
        sLo & mLo, sHi & mHi, magicLo[sq], magicHi[sq],
      ) >>> shift[sq]) & (size - 1);
      tableLo[offset + idx] = a[0];
      tableHi[offset + idx] = a[1];
      used[idx] = 1;

      // subset = (subset - mask) & mask on two words
      let nLo = sLo - mLo;
      let nHi = sHi - mHi;
      if ((sLo >>> 0) < (mLo >>> 0)) nHi = (nHi - 1) | 0;
      sLo = nLo & mLo;
      sHi = nHi & mHi;
      if (sLo === 0 && sHi === 0) break;
    }
    offset += size;
  }
}

function initLeapers() {
  const add = (arrLo, arrHi, sq, f, r) => {
    const s = r * 8 + f;
    if (s < 32) arrLo[sq] |= 1 << s;
    else arrHi[sq] |= 1 << (s - 32);
  };

  for (let sq = 0; sq < 64; sq++) {
    const file = sq & 7;
    const rank = sq >> 3;
    for (const [df, dr] of KNIGHT_STEPS) {
      const f = file + df;
      const r = rank + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) add(KNIGHT_ATK_LO, KNIGHT_ATK_HI, sq, f, r);
    }
    for (const [df, dr] of KING_STEPS) {
      const f = file + df;
      const r = rank + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) add(KING_ATK_LO, KING_ATK_HI, sq, f, r);
    }
    // Pawn attacks: white pawns attack towards higher ranks, black towards lower.
    if (rank < 7) {
      if (file > 0) add(PAWN_ATK_LO[WHITE], PAWN_ATK_HI[WHITE], sq, file - 1, rank + 1);
      if (file < 7) add(PAWN_ATK_LO[WHITE], PAWN_ATK_HI[WHITE], sq, file + 1, rank + 1);
    }
    if (rank > 0) {
      if (file > 0) add(PAWN_ATK_LO[BLACK], PAWN_ATK_HI[BLACK], sq, file - 1, rank - 1);
      if (file < 7) add(PAWN_ATK_LO[BLACK], PAWN_ATK_HI[BLACK], sq, file + 1, rank - 1);
    }
  }
}

function initMagicTables() {
  initLeapers();
  fillTable(ROOK_DIRS, ROOK_MAGIC_LO, ROOK_MAGIC_HI, ROOK_MASK_LO, ROOK_MASK_HI,
    ROOK_SHIFT, ROOK_OFFSET, ROOK_TABLE_LO, ROOK_TABLE_HI);
  fillTable(BISHOP_DIRS, BISHOP_MAGIC_LO, BISHOP_MAGIC_HI, BISHOP_MASK_LO, BISHOP_MASK_HI,
    BISHOP_SHIFT, BISHOP_OFFSET, BISHOP_TABLE_LO, BISHOP_TABLE_HI);
}

// The tables are built once, when the module is first imported.
{
  const started = Date.now();
  initMagicTables();
  TABLE_BUILD_MS = Date.now() - started;
}

// ---------------------------------------------------------------------------
// Attack queries (results land in ATK_LO / ATK_HI)
// ---------------------------------------------------------------------------
export function knightAttacks(sq) {
  ATK_LO = KNIGHT_ATK_LO[sq];
  ATK_HI = KNIGHT_ATK_HI[sq];
}

export function kingAttacks(sq) {
  ATK_LO = KING_ATK_LO[sq];
  ATK_HI = KING_ATK_HI[sq];
}

export function pawnAttacks(colour, sq) {
  ATK_LO = PAWN_ATK_LO[colour][sq];
  ATK_HI = PAWN_ATK_HI[colour][sq];
}

export function rookAttacks(sq, occLo, occHi) {
  const idx = (productWord1(
    occLo & ROOK_MASK_LO[sq], occHi & ROOK_MASK_HI[sq],
    ROOK_MAGIC_LO[sq], ROOK_MAGIC_HI[sq],
  ) >>> ROOK_SHIFT[sq]) & ((1 << (32 - ROOK_SHIFT[sq])) - 1);
  const off = ROOK_OFFSET[sq] + idx;
  ATK_LO = ROOK_TABLE_LO[off];
  ATK_HI = ROOK_TABLE_HI[off];
}

export function bishopAttacks(sq, occLo, occHi) {
  const idx = (productWord1(
    occLo & BISHOP_MASK_LO[sq], occHi & BISHOP_MASK_HI[sq],
    BISHOP_MAGIC_LO[sq], BISHOP_MAGIC_HI[sq],
  ) >>> BISHOP_SHIFT[sq]) & ((1 << (32 - BISHOP_SHIFT[sq])) - 1);
  const off = BISHOP_OFFSET[sq] + idx;
  ATK_LO = BISHOP_TABLE_LO[off];
  ATK_HI = BISHOP_TABLE_HI[off];
}

export function queenAttacks(sq, occLo, occHi) {
  const ri = (productWord1(
    occLo & ROOK_MASK_LO[sq], occHi & ROOK_MASK_HI[sq],
    ROOK_MAGIC_LO[sq], ROOK_MAGIC_HI[sq],
  ) >>> ROOK_SHIFT[sq]) & ((1 << (32 - ROOK_SHIFT[sq])) - 1);
  const bi = (productWord1(
    occLo & BISHOP_MASK_LO[sq], occHi & BISHOP_MASK_HI[sq],
    BISHOP_MAGIC_LO[sq], BISHOP_MAGIC_HI[sq],
  ) >>> BISHOP_SHIFT[sq]) & ((1 << (32 - BISHOP_SHIFT[sq])) - 1);
  const ro = ROOK_OFFSET[sq] + ri;
  const bo = BISHOP_OFFSET[sq] + bi;
  ATK_LO = ROOK_TABLE_LO[ro] | BISHOP_TABLE_LO[bo];
  ATK_HI = ROOK_TABLE_HI[ro] | BISHOP_TABLE_HI[bo];
}

/**
 * Generate attacks for a piece type in place: used by move generation where
 * the piece type is only known at run time.
 */
export function attacksFor(type, colour, sq, occLo, occHi) {
  switch (type) {
    case KNIGHT: knightAttacks(sq); break;
    case KING: kingAttacks(sq); break;
    case PAWN: pawnAttacks(colour, sq); break;
    case ROOK: rookAttacks(sq, occLo, occHi); break;
    case BISHOP: bishopAttacks(sq, occLo, occHi); break;
    case QUEEN: queenAttacks(sq, occLo, occHi); break;
    default:
      ATK_LO = 0;
      ATK_HI = 0;
  }
}

// ---------------------------------------------------------------------------
// Small utilities shared elsewhere (masks, distances)
// ---------------------------------------------------------------------------
export const FILE_BB_LO = new Int32Array(8);
export const FILE_BB_HI = new Int32Array(8);
export const RANK_BB_LO = new Int32Array(8);
export const RANK_BB_HI = new Int32Array(8);

for (let sq = 0; sq < 64; sq++) {
  const f = sq & 7;
  const r = sq >> 3;
  if (sq < 32) {
    FILE_BB_LO[f] |= 1 << sq;
    RANK_BB_LO[r] |= 1 << sq;
  } else {
    FILE_BB_HI[f] |= 1 << (sq - 32);
    RANK_BB_HI[r] |= 1 << (sq - 32);
  }
}

/** Chebyshev distance between two squares (used by evaluation). */
export function distance(a, b) {
  const df = Math.abs((a & 7) - (b & 7));
  const dr = Math.abs((a >> 3) - (b >> 3));
  return df > dr ? df : dr;
}

/** Convert a two-word bitboard into an array of square indices (tests/debug). */
export function squaresOf(lo, hi) {
  const out = [];
  let v = lo >>> 0;
  while (v) {
    out.push(lsbIndex(v));
    v = (v & (v - 1)) >>> 0;
  }
  v = hi >>> 0;
  while (v) {
    out.push(32 + lsbIndex(v));
    v = (v & (v - 1)) >>> 0;
  }
  return out;
}

export { mulShi32 };
