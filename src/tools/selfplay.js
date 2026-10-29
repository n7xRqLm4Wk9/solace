/**
 * src/tools/selfplay.js
 *
 * SOLACE plays itself in-process, alternating colours between games, with
 * either a fixed depth or a fixed thinking time per move.  This is the cheapest
 * way to smoke-test the engine end to end: every move is checked for legality,
 * every game is played to a real termination, and statistics are collected.
 */

import { Position } from '../core/position.js';
import { Searcher } from '../search/search.js';
import { MoveList, moveToUci } from '../core/moves.js';
import { WHITE } from '../core/types.js';

/** Decide the game state without playing, or null if play continues. */
export function adjudicate(position, maxMovesReached = false) {
  const legal = new MoveList(256);
  position.generateLegalMoves(legal);
  if (legal.count === 0) {
    if (position.isKingInCheck(position.side)) {
      return { result: position.side === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
    }
    return { result: '1/2-1/2', reason: 'stalemate' };
  }
  if (position.halfmove >= 100) return { result: '1/2-1/2', reason: 'fifty-move rule' };
  if (position.hasInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient material' };
  if (position.repetitionCount() >= 2) return { result: '1/2-1/2', reason: 'threefold repetition' };
  if (maxMovesReached) return { result: '1/2-1/2', reason: 'move limit reached' };
  return null;
}

/**
 * @param {object} options
 * @param {number} [options.games=2]
 * @param {number} [options.depth=5]           fixed depth (used if movetime is 0)
 * @param {number} [options.movetime=0]        fixed thinking time per move in ms
 * @param {number} [options.hashMB=32]
 * @param {number} [options.maxMoves=240]      plies before the game is adjudicated
 * @param {boolean} [options.quiet=false]
 * @param {string} [options.fen]               starting position
 */
export function runSelfPlay(options = {}) {
  const games = Math.max(1, options.games ?? 2);
  const depth = options.depth ?? 5;
  const movetime = options.movetime ?? 0;
  const hashMB = options.hashMB ?? 32;
  const maxMoves = options.maxMoves ?? 240;
  const quiet = options.quiet ?? false;
  const startFen = options.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const log = (text) => {
    if (!quiet) console.log(text);
  };

  const gamesPlayed = [];
  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;
  let illegalMoves = 0;
  let totalNodes = 0;
  let totalTimeMs = 0;
  let totalDepths = 0;
  let moveCount = 0;

  log(`SOLACE self-play: ${games} games, ${movetime ? `movetime ${movetime} ms` : `depth ${depth}`}, hash ${hashMB} MB`);

  for (let game = 0; game < games; game++) {
    // Alternate colours: in even games White is "player A".
    const position = new Position().setFen(startFen);
    const searchers = [new Searcher({ hashMB }), new Searcher({ hashMB })];
    const movetext = [];
    let verdict = null;
    let plies = 0;

    for (let ply = 0; ply < maxMoves; ply++) {
      const terminal = adjudicate(position);
      if (terminal) {
        verdict = terminal;
        break;
      }
      const searcher = searchers[position.side];
      const limits = movetime > 0 ? { movetime } : { depth };
      const started = Date.now();
      const result = searcher.go(position, limits);
      const elapsed = Date.now() - started;

      const legal = new MoveList(256);
      position.generateLegalMoves(legal);
      let isLegal = false;
      for (let i = 0; i < legal.count; i++) {
        if (legal.moves[i] === result.bestMove) {
          isLegal = true;
          break;
        }
      }
      if (!isLegal) {
        illegalMoves++;
        log(`  ILLEGAL MOVE from ${position.side === WHITE ? 'white' : 'black'}: ${position.toFen()}`);
        verdict = { result: position.side === WHITE ? '0-1' : '1-0', reason: 'illegal move' };
        break;
      }

      totalNodes += result.nodes;
      totalTimeMs += elapsed;
      totalDepths += result.depth;
      moveCount++;

      movetext.push(moveToUci(result.bestMove));
      position.makeMove(result.bestMove);
      plies++;
    }

    if (!verdict) verdict = adjudicate(position, true) ?? { result: '1/2-1/2', reason: 'unfinished' };
    if (verdict.result === '1-0') whiteWins++;
    else if (verdict.result === '0-1') blackWins++;
    else draws++;

    gamesPlayed.push({
      game: game + 1,
      result: verdict.result,
      reason: verdict.reason,
      plies,
      moves: movetext,
      finalFen: position.toFen(),
    });

    log(`  game ${game + 1}: ${verdict.result} (${verdict.reason}) in ${plies} plies: ${movetext.join(' ')}`);
  }

  const summary = {
    games,
    whiteWins,
    blackWins,
    draws,
    illegalMoves,
    averageDepth: moveCount ? totalDepths / moveCount : 0,
    averageNodes: moveCount ? Math.round(totalNodes / moveCount) : 0,
    averageTimeMs: moveCount ? Math.round(totalTimeMs / moveCount) : 0,
    nodesPerSecond: totalTimeMs > 0 ? Math.round((totalNodes * 1000) / totalTimeMs) : 0,
    moves: moveCount,
    gamesPlayed,
  };

  log('');
  log(`results: white ${whiteWins}, black ${blackWins}, draws ${draws}, illegal moves ${illegalMoves}`);
  log(`averages per move: depth ${summary.averageDepth.toFixed(1)}, ${summary.averageNodes} nodes, ${summary.averageTimeMs} ms, ${summary.nodesPerSecond} nps`);
  return summary;
}
