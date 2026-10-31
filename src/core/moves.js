/**
 * src/core/moves.js
 *
 * Moves are packed into a single 32-bit integer so the search never allocates:
 *
 *   bits  0.. 5 : from square        (0..63)
 *   bits  6..11 : to square          (0..63)
 *   bits 12..15 : flag               (0..13, see FLAG_*)
 *   bits 16..20 : moving piece type  (1..6) - stored for fast ordering/eval
 *   bits 21..23 : captured piece type(0..6) - stored for fast ordering/eval
 *
 * The extra fields are a pure cache: make/unmake re-derives everything it needs
 * from the board itself, so a bug in them cannot corrupt the position.
 */

export const FLAG_QUIET = 0;
export const FLAG_CAPTURE = 1;
export const FLAG_DOUBLE_PUSH = 2;
export const FLAG_EN_PASSANT = 3;
export const FLAG_CASTLE_KING = 4;
export const FLAG_CASTLE_QUEEN = 5;
export const FLAG_PROMO_Q = 6;
export const FLAG_PROMO_N = 7;
export const FLAG_PROMO_R = 8;
export const FLAG_PROMO_B = 9;
export const FLAG_PROMO_CAP_Q = 10;
export const FLAG_PROMO_CAP_N = 11;
export const FLAG_PROMO_CAP_R = 12;
export const FLAG_PROMO_CAP_B = 13;

export const FLAG_MASK = 0xf;

export function encodeMove(from, to, flag, pieceType, capturedType) {
  return (from & 63)
    | ((to & 63) << 6)
    | ((flag & 15) << 12)
    | ((pieceType & 7) << 16)
    | ((capturedType & 7) << 21);
}

export const moveFrom = (m) => m & 63;
export const moveTo = (m) => (m >>> 6) & 63;
export const moveFlag = (m) => (m >>> 12) & 15;
export const movePieceType = (m) => (m >>> 16) & 7;
export const moveCapturedType = (m) => (m >>> 21) & 7;

export const isCapture = (m) => {
  const f = moveFlag(m);
  return f === FLAG_CAPTURE || f === FLAG_EN_PASSANT || f >= FLAG_PROMO_CAP_Q;
};
export const isPromotion = (m) => moveFlag(m) >= FLAG_PROMO_Q;
export const isCastle = (m) => {
  const f = moveFlag(m);
  return f === FLAG_CASTLE_KING || f === FLAG_CASTLE_QUEEN;
};

/** Promotion piece type for a promotion move (0 otherwise). */
export function promotionType(m) {
  switch (moveFlag(m)) {
    case FLAG_PROMO_Q: case FLAG_PROMO_CAP_Q: return 5; // QUEEN
    case FLAG_PROMO_N: case FLAG_PROMO_CAP_N: return 2; // KNIGHT
    case FLAG_PROMO_R: case FLAG_PROMO_CAP_R: return 4; // ROOK
    case FLAG_PROMO_B: case FLAG_PROMO_CAP_B: return 3; // BISHOP
    default: return 0;
  }
}

/**
 * Promotion flag for a given piece type, optionally capturing.
 * Used when the caller knows what it wants (e.g. generating all four choices).
 */
export function promotionFlag(pieceType, capturing) {
  switch (pieceType) {
    case 5: return capturing ? FLAG_PROMO_CAP_Q : FLAG_PROMO_Q;
    case 2: return capturing ? FLAG_PROMO_CAP_N : FLAG_PROMO_N;
    case 4: return capturing ? FLAG_PROMO_CAP_R : FLAG_PROMO_R;
    case 3: return capturing ? FLAG_PROMO_CAP_B : FLAG_PROMO_B;
    default: throw new Error('invalid promotion piece type ' + pieceType);
  }
}

export const PROMOTION_CHARS = { 5: 'q', 2: 'n', 4: 'r', 3: 'b' };
export const CHAR_TO_PIECE = { q: 5, n: 2, r: 4, b: 3 };

/** Long algebraic (UCI) notation, e.g. "e2e4" or "e7e8q". */
export function moveToUci(m) {
  const from = moveFrom(m);
  const to = moveTo(m);
  const fromName = 'abcdefgh'[from & 7] + (1 + (from >> 3));
  const toName = 'abcdefgh'[to & 7] + (1 + (to >> 3));
  const promo = promotionType(m);
  return fromName + toName + (promo ? PROMOTION_CHARS[promo] : '');
}

/**
 * Fixed-capacity move container.  Reused across the whole search so that no
 * arrays are allocated per node.
 */
export class MoveList {
  constructor(capacity = 256) {
    this.moves = new Int32Array(capacity);
    this.scores = new Int32Array(capacity);
    this.count = 0;
  }

  clear() {
    this.count = 0;
  }

  add(move) {
    this.moves[this.count] = move;
    this.scores[this.count] = 0;
    this.count++;
  }

  /** Copy the contents of another list (keeps the score array in sync). */
  copyFrom(other) {
    const n = other.count;
    this.moves.set(other.moves.subarray(0, n));
    this.scores.set(other.scores.subarray(0, n));
    this.count = n;
  }
}
