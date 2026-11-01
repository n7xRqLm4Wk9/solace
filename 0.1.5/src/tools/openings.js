/**
 * src/tools/openings.js
 *
 * A handful of short, well-known opening lines.  Tools that play whole games
 * (self-play, matches) start from these instead of always from the initial
 * position, otherwise two runs of a deterministic engine produce the same game
 * every time.
 *
 * These are *not* a book: nothing here is consulted during a search, and the
 * engine has no opening knowledge of its own.
 */

import { Position } from '../core/position.js';

/** Short opening lines in UCI notation, each played with both colours. */
export const DEFAULT_OPENINGS = [
  { name: 'Ruy Lopez', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'] },
  { name: 'Sicilian Defence', moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4'] },
  { name: "Queen's Gambit", moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6'] },
  { name: 'English Opening', moves: ['c2c4', 'e7e5', 'b1c3', 'g8f6'] },
  { name: 'French Defence', moves: ['e2e4', 'e7e6', 'd2d4', 'd7d5'] },
  { name: "King's Indian", moves: ['d2d4', 'g8f6', 'c2c4', 'g7g6'] },
  { name: 'Caro-Kann', moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5'] },
  { name: 'Réti Opening', moves: ['g1f3', 'd7d5', 'g2g3', 'g8f6'] },
];

/**
 * Build the starting position of a game.
 *
 * @param {{name?: string, moves: string[]}|string} opening either one of the
 *   lines above, or a FEN string
 * @returns {{name: string, position: Position, moves: string[]}}
 */
export function openingPosition(opening) {
  if (typeof opening === 'string') {
    return { name: opening, position: new Position().setFen(opening), moves: [] };
  }
  const position = new Position().setStartPosition();
  const applied = [];
  for (const text of opening.moves) {
    const move = position.parseMove(text);
    if (!move) throw new Error(`illegal opening move "${text}" in ${opening.name}`);
    position.makeMove(move);
    applied.push(text);
  }
  return { name: opening.name ?? applied.join(' '), position, moves: applied };
}
