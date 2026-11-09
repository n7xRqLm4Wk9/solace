/**
 * src/core/types.js
 *
 * Fundamental constants and 64-bit helper routines shared by every other
 * module.  SOLACE stores each 64-bit bitboard as two 32-bit words (``lo`` for
 * squares 0-31 and ``hi`` for squares 32-63) because JavaScript bitwise
 * operators only work on 32 bits.  This is the representation that was
 * benchmarked fastest among the options considered (see README, section
 * "Board representation").
 *
 * Square numbering follows the usual convention:
 *   a1 = 0, b1 = 1, ..., h1 = 7, a2 = 8, ..., h8 = 63.
 */

// ---------------------------------------------------------------------------
// Colours and pieces
// ---------------------------------------------------------------------------
export const WHITE = 0;
export const BLACK = 1;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

/** Board codes: 0 = empty, otherwise ``type | (colour << 3)``. */
export const EMPTY = 0;
export const WHITE_PAWN = 1;
export const WHITE_KNIGHT = 2;
export const WHITE_BISHOP = 3;
export const WHITE_ROOK = 4;
export const WHITE_QUEEN = 5;
export const WHITE_KING = 6;
export const BLACK_PAWN = 9;
export const BLACK_KNIGHT = 10;
export const BLACK_BISHOP = 11;
export const BLACK_ROOK = 12;
export const BLACK_QUEEN = 13;
export const BLACK_KING = 14;

/** Piece type of a board code (0 for empty). */
export const pieceType = (code) => code & 7;
/** Colour of a board code (undefined for empty boards is not used). */
export const pieceColour = (code) => code >> 3;
/** Build a board code from colour and type. */
export const makePiece = (colour, type) => type | (colour << 3);

/** Index into the per-colour piece bitboard arrays: colour * 6 + (type - 1). */
export const pieceIndex = (colour, type) => colour * 6 + (type - 1);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
export const FILE_A = 0;
export const FILE_H = 7;
export const RANK_1 = 0;
export const RANK_2 = 1;
export const RANK_7 = 6;
export const RANK_8 = 7;

export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 3;
export const squareOf = (file, rank) => rank * 8 + file;
export const SQUARE_NAMES = [
  'a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1',
  'a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2',
  'a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3',
  'a4', 'b4', 'c4', 'd4', 'e4', 'f4', 'g4', 'h4',
  'a5', 'b5', 'c5', 'd5', 'e5', 'f5', 'g5', 'h5',
  'a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6',
  'a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7',
  'a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8',
];

/** Convert "e4" style text to a square index, or -1 when invalid. */
export function parseSquare(text) {
  if (typeof text !== 'string' || text.length !== 2) return -1;
  const file = text.charCodeAt(0) - 97; // 'a'
  const rank = text.charCodeAt(1) - 49; // '1'
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

export const squareName = (sq) => SQUARE_NAMES[sq];

// ---------------------------------------------------------------------------
// 32-bit bit tricks
// ---------------------------------------------------------------------------
/** Number of set bits in an unsigned 32-bit integer. */
export function popcount32(v) {
  const x = v >>> 0;
  const a = x - ((x >>> 1) & 0x55555555);
  const b = (a & 0x33333333) + ((a >>> 2) & 0x33333333);
  return (((b + (b >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Index of the least significant set bit (undefined for 0). */
export function lsbIndex(v) {
  // v & -v isolates the lowest set bit; Math.clz32 sees it as unsigned 32-bit.
  return 31 - Math.clz32(v & -v);
}

/** Number of set bits in a 64-bit (two-word) value. */
export const popcount64 = (lo, hi) => popcount32(lo) + popcount32(hi);

/**
 * High 32 bits of the unsigned 32x32 -> 64 bit product.
 * Used for magic-index calculation without BigInt.
 */
export function mulShi32(a, b) {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const low = aL * bL;
  const mid = aH * bL + (low >>> 16);
  const midH = mid >>> 16;
  const midL = mid & 0xffff;
  return (aH * bH + midH + ((aL * bH + midL) >>> 16)) | 0;
}

/**
 * Bits 32..63 of the 64x64 -> (low 128 bits) product of two unsigned 64-bit
 * values given as word pairs.  This is exactly the slice of the product a
 * magic-index calculation needs, and it costs three 32-bit multiplies.
 */
export function productWord1(occLo, occHi, mLo, mHi) {
  return (mulShi32(occLo, mLo) + Math.imul(occLo, mHi) + Math.imul(occHi, mLo)) | 0;
}

// ---------------------------------------------------------------------------
// Castling rights
// ---------------------------------------------------------------------------
export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;
export const CASTLE_ALL = 15;

/** Squares that must be empty / not attacked for each castling move. */
export const CASTLE_ROOK_FROM = { [CASTLE_WK]: 7, [CASTLE_WQ]: 0, [CASTLE_BK]: 63, [CASTLE_BQ]: 56 };
export const CASTLE_ROOK_TO = { [CASTLE_WK]: 5, [CASTLE_WQ]: 3, [CASTLE_BK]: 61, [CASTLE_BQ]: 59 };

/** Map of "from-to king move" -> castling right bit. */
export const CASTLE_MOVE_RIGHT = {
  '4>6': CASTLE_WK,
  '4>2': CASTLE_WQ,
  '60>62': CASTLE_BK,
  '60>58': CASTLE_BQ,
};
