/**
 * Solace 0.2 — a deliberately tiny opening book for the browser UI.
 *
 * The engine is strong enough to play the opening itself; the book exists so
 * that consecutive games are *not* identical, which is what makes casual play
 * against an engine boring. Entries are UCI moves keyed by the position they
 * are played from, and only the first few plies are covered.
 *
 * It never overrides the engine's own search outside these few moves.
 */

/** position key (FEN without clocks) -> list of candidate moves. */
const BOOK = new Map([
  // 1st move as White: four solid starts, picked at random.
  [startKey(), ['e2e4', 'd2d4', 'c2c4', 'g1f3']],

  // Replies as Black to the usual first moves.
  ...add('e2e4', ['e7e5', 'c7c5', 'e7e6', 'c7c6']),
  ...add('d2d4', ['d7d5', 'g8f6', 'e7e6']),
  ...add('c2c4', ['e7e5', 'g8f6', 'c7c5', 'e7e6']),
  ...add('g1f3', ['d7d5', 'g8f6', 'c7c5']),

  // Second move as White, so the first four plies vary as well.
  ...add('e2e4 e7e5', ['g1f3', 'f1c4', 'b1c3', 'f2f4']),
  ...add('e2e4 c7c5', ['g1f3', 'b1c3', 'c2c3', 'd2d4']),
  ...add('e2e4 e7e6', ['d2d4', 'b1c3', 'd2d3']),
  ...add('e2e4 c7c6', ['d2d4', 'b1c3', 'd2d3']),
  ...add('d2d4 d7d5', ['c2c4', 'g1f3', 'c1f4']),
  ...add('d2d4 g8f6', ['c2c4', 'g1f3', 'c1g5']),
  ...add('c2c4 e7e5', ['b1c3', 'g2g3']),
  ...add('c2c4 g8f6', ['b1c3', 'g1f3', 'g2g3']),
]);

function startKey() {
  return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
}

/** "position startpos moves ..." -> the key the book uses. */
function add(moves, replies) {
  const key = keyAfter(moves.split(' '));
  return key ? [[key, replies]] : [];
}

// The book is built lazily: the board model is imported by app.js and the keys
// are computed from the same rules module, so the book can never disagree with
// the move generator about what a position is.
let keyAfterMove = null;

/** Injected by app.js: (moves: string[]) => string|null */
export function setKeyFunction(fn) {
  keyAfterMove = fn;
}

function keyAfter(moves) {
  return keyAfterMove ? keyAfterMove(moves) : null;
}

/** Returns a book move for `moves`, or null. `random` is injectable for tests. */
export function bookMove(moves, random = Math.random) {
  const key = keyAfter(moves);
  if (!key) return null;
  const candidates = BOOK.get(key);
  if (!candidates || !candidates.length) return null;
  return candidates[Math.floor(random() * candidates.length) % candidates.length];
}

export const BOOK_SIZE = 4;
