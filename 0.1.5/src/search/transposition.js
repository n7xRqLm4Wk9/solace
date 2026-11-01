/**
 * src/search/transposition.js
 *
 * Transposition table: stores the result of a search for a position keyed by
 * the full 64-bit Zobrist key, so a position reached by a different move order
 * does not have to be searched again.
 *
 * Layout: parallel typed arrays (cache friendly, no object per entry, no
 * garbage).  Size is configurable in megabytes through the UCI "Hash" option.
 *
 * A replacement scheme with aging is used: a deeper entry is preferred, but an
 * entry written by an older search can be replaced by a shallower new one.
 */

export const TT_EXACT = 1;
export const TT_LOWER = 2; // score is a lower bound (fail-high / beta cutoff)
export const TT_UPPER = 3; // score is an upper bound (fail-low)

export class TranspositionTable {
  constructor(sizeMB = 16) {
    this.sizeMB = 0;
    this.mask = 0;
    this.entries = 0;
    this.generation = 0;
    this.resize(sizeMB);
  }

  /**
   * (Re)allocate the table.  The size is rounded down to a power of two so the
   * index calculation is a bitwise AND.
   */
  resize(sizeMB) {
    const bytes = Math.max(1, Math.floor(sizeMB)) * 1024 * 1024;
    const entryBytes = 16; // 3 x Int32 + Int16 + 4 x Int8, padded
    let count = Math.floor(bytes / entryBytes);
    count = Math.max(1024, 2 ** Math.floor(Math.log2(Math.max(1024, count))));

    this.sizeMB = sizeMB;
    this.entries = count;
    this.mask = count - 1;
    this.keyLo = new Int32Array(count);
    this.keyHi = new Int32Array(count);
    this.move = new Int32Array(count);
    this.score = new Int16Array(count);
    this.depth = new Int8Array(count);   // stored as depth + 1, 0 means empty
    this.flag = new Int8Array(count);
    this.gen = new Uint8Array(count);
    this.clear();
  }

  clear() {
    this.keyLo.fill(0);
    this.keyHi.fill(0);
    this.move.fill(0);
    this.score.fill(0);
    this.depth.fill(0);
    this.flag.fill(0);
    this.gen.fill(0);
    this.generation = 0;
  }

  /** Start a new search: aged entries become cheaper to replace. */
  newSearch() {
    this.generation = (this.generation + 1) & 0xff;
  }

  index(keyLo, keyHi) {
    // Mix both key words, then take the low bits.
    return (keyLo ^ Math.imul(keyHi, 0x9e3779b1)) & this.mask;
  }

  /**
   * Probe the table.  Results are written to the fields below instead of
   * returning an object, so this is allocation-free.
   * @returns {boolean} true when a matching entry was found
   */
  probe(keyLo, keyHi) {
    const i = this.index(keyLo, keyHi);
    if (this.depth[i] !== 0 && this.keyLo[i] === keyLo && this.keyHi[i] === keyHi) {
      this.entryMove = this.move[i];
      this.entryScore = this.score[i];
      this.entryDepth = this.depth[i] - 1;
      this.entryFlag = this.flag[i];
      return true;
    }
    this.entryMove = 0;
    this.entryScore = 0;
    this.entryDepth = -1;
    this.entryFlag = 0;
    return false;
  }

  /** Score that only stores a move (used by the root search's bookkeeping). */
  probeMove(keyLo, keyHi) {
    const i = this.index(keyLo, keyHi);
    if (this.depth[i] !== 0 && this.keyLo[i] === keyLo && this.keyHi[i] === keyHi) return this.move[i];
    return 0;
  }

  /**
   * Store an entry, replacing the existing one when the new result is at least
   * as deep, or when the existing entry is from an older search generation.
   */
  store(keyLo, keyHi, move, score, depth, flag) {
    const i = this.index(keyLo, keyHi);
    const samePosition = this.depth[i] !== 0 && this.keyLo[i] === keyLo && this.keyHi[i] === keyHi;
    const storedDepth = this.depth[i] - 1;
    if (samePosition && this.gen[i] === this.generation && depth < storedDepth) return;
    if (samePosition && this.gen[i] === this.generation && depth === storedDepth && flag !== TT_EXACT) return;
    if (!samePosition && this.depth[i] !== 0 && storedDepth > depth + 3 && this.gen[i] === this.generation) return;

    this.keyLo[i] = keyLo;
    this.keyHi[i] = keyHi;
    this.move[i] = move;
    this.score[i] = score;
    this.depth[i] = depth + 1;
    this.flag[i] = flag;
    this.gen[i] = this.generation;
  }

  /** Approximate fill rate in permille, as reported by the UCI "info" line. */
  hashfull() {
    const sample = Math.min(1000, this.entries);
    let used = 0;
    for (let i = 0; i < sample; i++) {
      if (this.depth[i] !== 0 && this.gen[i] === this.generation) used++;
    }
    return Math.round((used * 1000) / sample);
  }

  /** Memory footprint in megabytes (useful for the UCI "Hash" report). */
  memoryMB() {
    return (this.entries * 16) / (1024 * 1024);
  }
}
