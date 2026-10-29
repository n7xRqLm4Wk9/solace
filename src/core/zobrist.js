/**
 * src/core/zobrist.js
 *
 * Zobrist hashing keys.  A 64-bit key is kept as two 32-bit words
 * (``lo``/``hi``).  The random numbers come from a deterministic xorshift
 * generator, so every run of the engine (and every test run) hashes identical
 * positions identically.
 */

import { WHITE, BLACK, PAWN, KING } from './types.js';

let state = 0x1a2b3c4d;
function next32() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state | 0;
}

// Board codes 0..14 are used; index by code * 64 + square.
export const PIECE_LO = new Int32Array(15 * 64);
export const PIECE_HI = new Int32Array(15 * 64);
for (let code = 0; code < 15; code++) {
  for (let sq = 0; sq < 64; sq++) {
    PIECE_LO[code * 64 + sq] = next32();
    PIECE_HI[code * 64 + sq] = next32();
  }
}

export const SIDE_LO = next32();
export const SIDE_HI = next32();

/** Castling rights 0..15. */
export const CASTLING_LO = new Int32Array(16);
export const CASTLING_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) {
  CASTLING_LO[i] = next32();
  CASTLING_HI[i] = next32();
}

/** En-passant file 0..7 (only hashed when the capture is actually available). */
export const EP_FILE_LO = new Int32Array(8);
export const EP_FILE_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) {
  EP_FILE_LO[i] = next32();
  EP_FILE_HI[i] = next32();
}

export { WHITE, BLACK, PAWN, KING };
