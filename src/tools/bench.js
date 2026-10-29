/**
 * src/tools/bench.js
 *
 * Reproducible search benchmark.  It runs a fixed set of positions to a fixed
 * depth (or fixed time) and records search depth, nodes, nodes per second, time
 * per move, the evaluation score, the best move and whether that move was
 * legal.  Everything is printed and returned so the numbers can be pasted into
 * the README or a report.
 */

import { Position } from '../core/position.js';
import { Searcher } from '../search/search.js';
import { moveToUci, MoveList } from '../core/moves.js';

/** Well-known positions covering opening, middlegame, tactics and endgames. */
export const BENCH_POSITIONS = [
  { name: 'startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
  { name: 'position-3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
  { name: 'position-4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1' },
  { name: 'position-5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8' },
  { name: 'position-6', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10' },
  { name: 'italian-middlegame', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6' },
  { name: 'rook-endgame', fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1' },
  { name: 'queen-endgame', fen: '8/8/4k3/8/4K3/8/6Q1/8 w - - 0 1' },
  { name: 'mate-in-2', fen: 'r5rk/5p1p/5R2/4B3/8/8/7P/7K w - - 0 1' },
  { name: 'promotion-race', fen: '8/P6k/8/8/8/8/6p1/K7 w - - 0 1' },
  { name: 'tactics-1', fen: 'r1b1k2r/ppq2ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w kq - 0 8' },
];

/**
 * Run the benchmark.
 *
 * @param {object} options
 * @param {number} [options.depth=5] fixed depth for every position
 * @param {number} [options.movetime] alternative: fixed thinking time per move
 * @param {number} [options.hashMB=16]
 * @param {boolean} [options.verbose=true] also collect one line per position
 */
export function runBenchmark(options = {}) {
  const depth = options.depth ?? 5;
  const hashMB = options.hashMB ?? 16;
  const verbose = options.verbose ?? true;
  const searcher = new Searcher({ hashMB });
  const lines = [];
  const results = [];

  const push = (text) => {
    if (verbose) lines.push(text);
  };

  push(`SOLACE benchmark: ${BENCH_POSITIONS.length} positions, fixed depth ${depth}, hash ${hashMB} MB`);
  push('position              depth    nodes      time(ms)   nps        score    bestmove  legal');

  let totalNodes = 0;
  let totalTime = 0;
  let illegalMoves = 0;

  for (const entry of BENCH_POSITIONS) {
    const position = new Position().setFen(entry.fen);
    const started = Date.now();
    const result = options.movetime
      ? searcher.go(position, { movetime: options.movetime })
      : searcher.go(position, { depth });
    const timeMs = Math.max(1, Date.now() - started);

    // Legality check: the returned move must be one of the legal moves.
    const legal = new MoveList(256);
    position.generateLegalMoves(legal);
    let isLegal = false;
    for (let i = 0; i < legal.count; i++) {
      if (legal.moves[i] === result.bestMove) {
        isLegal = true;
        break;
      }
    }
    if (!isLegal) illegalMoves++;

    totalNodes += result.nodes;
    totalTime += timeMs;

    const row = {
      name: entry.name,
      fen: entry.fen,
      depth: result.depth,
      seldepth: result.seldepth,
      nodes: result.nodes,
      nps: Math.round((result.nodes * 1000) / timeMs),
      timeMs,
      score: result.score,
      bestMove: result.bestMove ? moveToUci(result.bestMove) : '(none)',
      legal: isLegal,
      pv: result.pv.map(moveToUci).join(' '),
    };
    results.push(row);

    push(
      `${row.name.padEnd(20)} ${String(row.depth).padStart(4)} `
      + `${String(row.nodes).padStart(8)} ${String(row.timeMs).padStart(9)} `
      + `${String(row.nps).padStart(9)} ${String(row.score).padStart(7)} `
      + `${row.bestMove.padEnd(8)} ${row.legal ? 'yes' : 'NO'}`,
    );
  }

  const overallNps = Math.round((totalNodes * 1000) / Math.max(1, totalTime));
  push('');
  push(`total nodes: ${totalNodes}`);
  push(`total time:  ${totalTime} ms`);
  push(`overall nps: ${overallNps}`);
  push(`illegal moves: ${illegalMoves}`);
  push(`average time per move: ${(totalTime / BENCH_POSITIONS.length).toFixed(1)} ms`);

  return {
    lines,
    results,
    totals: {
      nodes: totalNodes,
      timeMs: totalTime,
      nps: overallNps,
      illegalMoves,
      positions: BENCH_POSITIONS.length,
      depth,
    },
  };
}
