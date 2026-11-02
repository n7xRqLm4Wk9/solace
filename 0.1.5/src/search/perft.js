/**
 * src/search/perft.js
 *
 * Perft ("performance test"): count the number of leaf nodes at a given depth.
 * Perft is the standard way to prove a move generator and make/unmake are
 * correct, and the numbers for standard positions are published reference data.
 */

import { MoveList } from '../core/moves.js';

/**
 * Count leaf nodes at ``depth`` plies.
 * Positions are generated pseudo-legally and filtered by "does my king stand in
 * check after the move?", which is the fastest reliable scheme in JavaScript.
 */
export function perft(position, depth) {
  const lists = [];
  for (let i = 0; i <= depth; i++) lists.push(new MoveList(256));
  return perftInner(position, depth, lists);
}

function perftInner(position, depth, lists) {
  if (depth === 0) return 1;
  const list = lists[depth];
  position.generateMoves(list);
  const us = position.side;
  let nodes = 0;

  if (depth === 1) {
    // Fast path: no need to recurse, just count legal moves.
    for (let i = 0; i < list.count; i++) {
      const move = list.moves[i];
      position.makeMove(move);
      if (!position.isKingInCheck(us)) nodes++;
      position.unmakeMove(move);
    }
    return nodes;
  }

  for (let i = 0; i < list.count; i++) {
    const move = list.moves[i];
    position.makeMove(move);
    if (!position.isKingInCheck(us)) nodes += perftInner(position, depth - 1, lists);
    position.unmakeMove(move);
  }
  return nodes;
}

/**
 * Perft broken down by root move, i.e. the output style of `stockfish perft`:
 * [{ move: 'e2e4', nodes: 20 }, ...]
 */
export function perftDivide(position, depth, moveToUciFn) {
  const list = new MoveList(256);
  position.generateMoves(list);
  const us = position.side;
  const rows = [];
  let total = 0;
  for (let i = 0; i < list.count; i++) {
    const move = list.moves[i];
    position.makeMove(move);
    if (!position.isKingInCheck(us)) {
      const nodes = depth <= 1 ? 1 : perft(position, depth - 1);
      total += nodes;
      rows.push({ move: moveToUciFn(move), nodes });
    }
    position.unmakeMove(move);
  }
  rows.push({ move: 'total', nodes: total });
  return rows;
}
