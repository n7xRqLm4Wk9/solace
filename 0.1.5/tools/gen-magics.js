#!/usr/bin/env node
/**
 * tools/gen-magics.js
 *
 * Offline helper that searches for 64-bit "magic numbers" for rook and bishop
 * attacks.  The resulting constants are embedded in src/core/magics.js so that
 * SOLACE only has to *fill* the attack tables at start-up (a few milliseconds)
 * instead of searching for magic numbers every time it loads.
 *
 * Usage:  node tools/gen-magics.js > src/core/magics.js
 *
 * A magic number only needs to be *some* multiplier that maps every relevant
 * occupancy to a distinct index, so a deterministic pseudo-random trial and
 * error search is enough.  All arithmetic here uses pairs of 32-bit words,
 * because JavaScript bitwise operators are 32-bit.
 */

'use strict';

// ---------------------------------------------------------------------------
// 64-bit (two-word) helpers
// ---------------------------------------------------------------------------
function mulShi(a, b) {
  // High 32 bits of the unsigned 32x32 -> 64 bit product.
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

/** Word 1 (bits 32..63) of the 64x64 -> low-128 bit product. */
function productWord1(occLo, occHi, mLo, mHi) {
  return (mulShi(occLo, mLo) + Math.imul(occLo, mHi) + Math.imul(occHi, mLo)) | 0;
}

function popcount32(x) {
  const v = x >>> 0;
  const a = v - ((v >>> 1) & 0x55555555);
  const b = (a & 0x33333333) + ((a >>> 2) & 0x33333333);
  return (((b + (b >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function bitPair(sq) {
  return sq < 32 ? [1 << sq, 0] : [0, 1 << (sq - 32)];
}

function rayAttacks(sq, dir, occLo, occHi) {
  const file = sq & 7;
  const rank = sq >> 3;
  let lo = 0;
  let hi = 0;
  let f = file + dir[0];
  let r = rank + dir[1];
  while (f >= 0 && f < 8 && r >= 0 && r < 8) {
    const s = r * 8 + f;
    if (s < 32) lo |= 1 << s;
    else hi |= 1 << (s - 32);
    const blocked = s < 32 ? (occLo & (1 << s)) !== 0 : (occHi & (1 << (s - 32))) !== 0;
    if (blocked) break;
    f += dir[0];
    r += dir[1];
  }
  return [lo, hi];
}

function slidingAttacks(sq, dirs, occLo, occHi) {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < dirs.length; i++) {
    const a = rayAttacks(sq, dirs[i], occLo, occHi);
    lo |= a[0];
    hi |= a[1];
  }
  return [lo, hi];
}

function relevantMask(sq, dirs) {
  let lo = 0;
  let hi = 0;
  for (const d of dirs) {
    const file = sq & 7;
    const rank = sq >> 3;
    let f = file + d[0];
    let r = rank + d[1];
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const nf = f + d[0];
      const nr = r + d[1];
      const onEdge = nf < 0 || nf > 7 || nr < 0 || nr > 7;
      if (!onEdge) {
        const s = r * 8 + f;
        if (s < 32) lo |= 1 << s;
        else hi |= 1 << (s - 32);
      }
      f += d[0];
      r += d[1];
    }
  }
  return [lo, hi];
}

// Deterministic 32-bit xorshift so the generated file is reproducible.
let rngState = 0x9e3779b9;
function rnd32() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return rngState >>> 0;
}

function findMagic(sq, dirs) {
  const mask = relevantMask(sq, dirs);
  const [maskLo, maskHi] = mask;
  const bits = popcount32(maskLo) + popcount32(maskHi);
  const shift = 32 - bits;
  const size = 1 << bits;

  // Enumerate every subset of the mask with the Carry-Rippler trick.
  const occLoArr = [];
  const occHiArr = [];
  const attLoArr = [];
  const attHiArr = [];
  let sLo = 0;
  let sHi = 0;
  for (;;) {
    occLoArr.push(sLo);
    occHiArr.push(sHi);
    const a = slidingAttacks(sq, dirs, sLo, sHi);
    attLoArr.push(a[0]);
    attHiArr.push(a[1]);
    // subset = (subset - mask) & mask, done in two words
    let nLo = sLo - maskLo;
    let nHi = sHi - maskHi;
    // borrow from the low word into the high word
    if ((sLo >>> 0) < (maskLo >>> 0)) nHi = (nHi - 1) | 0;
    nLo &= maskLo;
    nHi &= maskHi;
    sLo = nLo;
    sHi = nHi;
    if (sLo === 0 && sHi === 0) break;
    if (occLoArr.length > size) throw new Error('subset enumeration overflow at ' + sq);
  }
  if (occLoArr.length !== size) throw new Error('bad subset count at ' + sq);

  const usedLo = new Int32Array(size).fill(-1);
  const usedHi = new Int32Array(size).fill(-1);

  for (let attempt = 0; attempt < 20000000; attempt++) {
    const mLo = (rnd32() & rnd32() & rnd32()) | 0;
    const mHi = (rnd32() & rnd32() & rnd32()) | 0;
    // Quick rejection: a useful magic must scatter high bits of the mask.
    if (popcount32(productWord1(maskLo, maskHi, mLo, mHi)) < 6) continue;

    usedLo.fill(-1);
    usedHi.fill(-1);
    let ok = true;
    for (let i = 0; i < size; i++) {
      const idx = (productWord1(occLoArr[i], occHiArr[i], mLo, mHi) >>> shift) & (size - 1);
      if (usedLo[idx] === -1) {
        usedLo[idx] = attLoArr[i];
        usedHi[idx] = attHiArr[i];
      } else if (usedLo[idx] !== attLoArr[i] || usedHi[idx] !== attHiArr[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { mLo, mHi, maskLo, maskHi, bits, shift };
  }
  throw new Error('magic search failed for square ' + sq);
}

// ---------------------------------------------------------------------------
// Emit the module
// ---------------------------------------------------------------------------
const rookMagics = [];
const bishopMagics = [];
for (let sq = 0; sq < 64; sq++) rookMagics.push(findMagic(sq, ROOK_DIRS));
for (let sq = 0; sq < 64; sq++) bishopMagics.push(findMagic(sq, BISHOP_DIRS));

const hex32 = (x) => '0x' + (x >>> 0).toString(16).padStart(8, '0');

function fmtArray(values, perLine) {
  const lines = [];
  for (let i = 0; i < values.length; i += perLine) {
    lines.push('  ' + values.slice(i, i + perLine).join(', ') + ',');
  }
  return lines.join('\n');
}

const out = [];
out.push('/**');
out.push(' * src/core/magics.js  --  GENERATED FILE, do not edit by hand.');
out.push(' *');
out.push(' * Regenerate with:  node tools/gen-magics.js > src/core/magics.js');
out.push(' *');
out.push(' * Packed 64-bit magic numbers for rook and bishop attacks, split into');
out.push(' * low/high 32-bit words (JavaScript bitwise operators are 32-bit).');
out.push(' * Produced by SOLACE\'s own deterministic search in tools/gen-magics.js.');
out.push(' */');
out.push('');

function emit(name, values, perLine = 8) {
  out.push(`export const ${name} = new Int32Array([`);
  out.push(fmtArray(values, perLine));
  out.push(']);');
  out.push('');
}

emit('ROOK_MAGIC_LO', rookMagics.map((m) => hex32(m.mLo)));
emit('ROOK_MAGIC_HI', rookMagics.map((m) => hex32(m.mHi)));
emit('BISHOP_MAGIC_LO', bishopMagics.map((m) => hex32(m.mLo)));
emit('BISHOP_MAGIC_HI', bishopMagics.map((m) => hex32(m.mHi)));
emit('ROOK_MASK_LO', rookMagics.map((m) => hex32(m.maskLo)));
emit('ROOK_MASK_HI', rookMagics.map((m) => hex32(m.maskHi)));
emit('BISHOP_MASK_LO', bishopMagics.map((m) => hex32(m.maskLo)));
emit('BISHOP_MASK_HI', bishopMagics.map((m) => hex32(m.maskHi)));
emit('ROOK_SHIFT', rookMagics.map((m) => String(m.shift)), 16);
emit('BISHOP_SHIFT', bishopMagics.map((m) => String(m.shift)), 16);

process.stdout.write(out.join('\n'));
console.error('magic numbers generated successfully');
