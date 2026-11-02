/**
 * src/search/search.js
 *
 * SOLACE's search: iterative deepening negamax with alpha-beta pruning.
 *
 * Features:
 *   - iterative deepening with aspiration windows
 *   - principal variation search (PVS / zero-window re-search)
 *   - transposition table with Zobrist keys and mate-score correction
 *   - move ordering: TT move, MVV-LVA captures, killers, history heuristic
 *   - quiescence search (captures, promotions and check evasions)
 *   - null-move pruning
 *   - late move reductions with re-search
 *   - check extension
 *   - reverse futility pruning
 *   - draw detection: fifty-move, repetition, insufficient material
 *   - time and node limits with cooperative cancellation
 *   - full search statistics (depth, seldepth, nodes, nps, pv, hashfull)
 *
 * Scores are in centipawns from the point of view of the side to move.
 *
 * The search is organised as a ``SearchSession`` that runs **one iteration of
 * iterative deepening per call**.  ``Searcher.go()`` drives a session to
 * completion synchronously (used by tests and the benchmark), while the UCI
 * layer drives the same session between event-loop turns so that a "stop" or
 * "quit" command is always handled promptly.
 */

import { evaluate } from '../eval/evaluate.js';
import { TranspositionTable, TT_EXACT, TT_LOWER, TT_UPPER } from './transposition.js';
import { MoveList, isCapture, isPromotion } from '../core/moves.js';
import { scoreMoves, pickNext } from './moveOrdering.js';
import { WHITE, WHITE as WHITE_COLOUR } from '../core/types.js';
import { verifyNode } from '../core/verify.js';
import { see } from '../eval/see.js';

export const MAX_PLY = 128;
export const MATE = 30000;
export const MATE_THRESHOLD = MATE - MAX_PLY - 1;
export const INFINITE = 100000;
export const DRAW = 0;

/** Thrown internally to unwind the search as soon as a limit is reached. */
export class SearchAborted extends Error {
  constructor() {
    super('search aborted');
    this.name = 'SearchAborted';
  }
}
const ABORT = new SearchAborted();
export { ABORT };

/** Values used by delta pruning (must match the evaluation's material). */
const CAPTURE_VALUES = [0, 100, 320, 335, 500, 950, 0];

/**
 * Draw test used inside the search tree (not at the root, where the engine must
 * still produce a move).
 *   - fifty-move rule: 100 halfmoves without a pawn move or capture
 *   - threefold/fifty-move style repetition: the position already occurred once
 *     in this line (a second occurrence makes the draw claimable, so engines
 *     score it as a draw to avoid repetition blindness)
 *   - insufficient material
 */
export function isImmediateDraw(position) {
  if (position.halfmove >= 100) return true;
  if (position.repetitionCount() > 0) return true;
  // With more than four men on the board the material is always sufficient,
  // so the (slightly longer) check is skipped in almost every node.
  return position.pieceTotal <= 4 && position.hasInsufficientMaterial();
}

export class Searcher {
  constructor(options = {}) {
    this.tt = new TranspositionTable(options.hashMB ?? 16);
    this.verifyMoves = Boolean(options.verifyMoves);
    this.moveOverhead = options.moveOverhead ?? 30;
    // Heuristics can be switched off for A/B testing (see docs/STRENGTH.md).
    // Measured with tools/see-ab (see docs/STRENGTH.md): SEE pruning in the
    // quiescence search wins, SEE pruning of captures in the main search loses,
    // so it is available but disabled by default.
    this.seeQuiescence = options.seeQuiescence ?? true;
    this.seePruning = options.seePruning ?? false;

    this.killer1 = new Int32Array(MAX_PLY);
    this.killer2 = new Int32Array(MAX_PLY);
    this.history = new Int32Array(2 * 4096);
    /** counterMoves[side * 4096 + previous move index] = good reply. */
    this.counterMoves = new Int32Array(2 * 4096);
    /** The move played at each ply of the current line. */
    this.moveStack = new Int32Array(MAX_PLY + 2);
    /** History bonus ceiling used by the gravity update. */
    this.historyMax = 1 << 15;
    this.moveLists = [];
    for (let i = 0; i < MAX_PLY + 2; i++) this.moveLists.push(new MoveList(256));

    // Late move reduction table: LMR_TABLE[depth][moveNumber].
    this.lmrTable = new Int32Array(MAX_PLY * 64);
    for (let d = 1; d < MAX_PLY; d++) {
      for (let m = 1; m < 64; m++) {
        this.lmrTable[d * 64 + m] = Math.max(0, Math.floor(0.75 + Math.log(d) * Math.log(m) / 2.25));
      }
    }

    this.pvTable = new Int32Array(MAX_PLY * MAX_PLY);
    this.pvLength = new Int32Array(MAX_PLY + 1);

    this.nodes = 0;
    this.qnodes = 0;
    this.seldepth = 0;
    this.stopRequested = false;
    this.deadline = Infinity;
    this.maxNodes = Infinity;
    this.startTime = 0;
    this.pv = [];
    this.pvScore = 0;
    this.rootMoves = new MoveList(256);
    this.rootBestMove = 0;
    this.debugCounters = { ttHits: 0, nullCutoffs: 0, lmReductions: 0 };
  }

  /** Ask a running search to stop (UCI "stop" or "quit"). */
  stop() {
    this.stopRequested = true;
  }

  /** Reset per-search state. Killers/history/TT survive between moves on purpose. */
  reset() {
    this.killer1.fill(0);
    this.killer2.fill(0);
    this.tt.newSearch();
    this.nodes = 0;
    this.qnodes = 0;
    this.seldepth = 0;
    this.stopRequested = false;
    this.pv = [];
    this.pvScore = 0;
    this.debugCounters = { ttHits: 0, nullCutoffs: 0, lmReductions: 0 };
  }

  setHashSize(mb) {
    this.tt.resize(mb);
  }

  clearHash() {
    this.tt.clear();
    this.killer1.fill(0);
    this.killer2.fill(0);
    this.history.fill(0);
    this.counterMoves.fill(0);
  }

  /** Create a session for ``position`` without running it. */
  createSession(position, limits = {}, onInfo = null) {
    return new SearchSession(this, position, limits, onInfo);
  }

  /**
   * Search synchronously until the limits are reached.
   * @returns {object} result, see SearchSession#result()
   */
  go(position, limits = {}, onInfo = null) {
    const session = this.createSession(position, limits, onInfo);
    if (!session.noLegalMoves) {
      while (session.runNextIteration()) { /* keep deepening */ }
    }
    return session.result();
  }

  // -------------------------------------------------------------------------
  // Low level helpers shared with the session
  // -------------------------------------------------------------------------
  checkTime() {
    if (this.stopRequested) throw ABORT;
    if (this.nodes >= this.maxNodes) throw ABORT;
    if (Date.now() >= this.deadline) throw ABORT;
  }

  /** Convert a mate score into "mate in N moves" (negative = getting mated). */
  static mateDistance(score) {
    if (Math.abs(score) < MATE_THRESHOLD) return null;
    const plies = MATE - Math.abs(score);
    const moves = Math.ceil(plies / 2);
    return score > 0 ? moves : -moves;
  }

  // -------------------------------------------------------------------------
  // Root search
  // -------------------------------------------------------------------------
  searchRoot(position, depth, alpha, beta) {
    const list = this.rootMoves;
    const us = position.side;
    const ttMove = this.tt.probeMove(position.keyLo, position.keyHi);
    scoreMoves(list, ttMove, us, 0, this.killer1, this.killer2, this.history);

    let bestScore = -INFINITE;
    let bestMove = list.moves[0];
    let alphaLocal = alpha;
    this.pvLength[0] = 0;

    for (let i = 0; i < list.count; i++) {
      const move = pickNext(list, i);
      position.makeMove(move);
      let score;
      if (i === 0) {
        score = -this.negamax(position, depth - 1, -beta, -alphaLocal, 1, true);
      } else {
        score = -this.negamax(position, depth - 1, -alphaLocal - 1, -alphaLocal, 1, true);
        if (score > alphaLocal && score < beta) {
          score = -this.negamax(position, depth - 1, -beta, -alphaLocal, 1, true);
        }
      }
      position.unmakeMove(move);
      if (this.stopRequested) throw ABORT;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alphaLocal) {
          alphaLocal = score;
          // Rebuild the principal variation for this iteration.
          this.pvTable[0] = move;
          const childLength = this.pvLength[1];
          if (childLength > 0) this.pvTable.copyWithin(1, MAX_PLY, MAX_PLY + childLength);
          this.pvLength[0] = childLength + 1;
          this.pv = Array.from(this.pvTable.subarray(0, this.pvLength[0]));
          this.pvScore = score;
        }
      }
      if (alphaLocal >= beta) break;
    }

    // Leave the best move first so the next iteration searches it immediately.
    for (let i = 1; i < list.count; i++) {
      if (list.moves[i] === bestMove) {
        const m = list.moves[0];
        list.moves[0] = list.moves[i];
        list.moves[i] = m;
        const s = list.scores[0];
        list.scores[0] = list.scores[i];
        list.scores[i] = s;
        break;
      }
    }
    this.rootBestMove = bestMove;
    return bestScore;
  }

  // -------------------------------------------------------------------------
  // Main alpha-beta search
  // -------------------------------------------------------------------------
  negamax(position, depth, alpha, beta, ply, canNull) {
    this.pvLength[ply] = 0;

    if (depth <= 0) return this.quiescence(position, alpha, beta, ply);

    this.nodes++;
    if ((this.nodes & 511) === 0) this.checkTime();
    if (ply > this.seldepth) this.seldepth = ply;
    if (ply >= MAX_PLY - 2) return evaluate(position);

    const us = position.side;
    const them = us ^ 1;
    const inCheck = position.isKingInCheck(us);

    // --- draw detection ----------------------------------------------------
    if (ply > 0 && isImmediateDraw(position)) return DRAW;

    // Mate-distance pruning.
    if (alpha < -MATE + ply) alpha = -MATE + ply;
    if (beta > MATE - ply - 1) beta = MATE - ply - 1;
    if (alpha >= beta) return alpha;

    const isPV = beta - alpha > 1;

    // --- transposition table ----------------------------------------------
    let ttMove = 0;
    if (this.tt.probe(position.keyLo, position.keyHi)) {
      ttMove = this.tt.entryMove;
      if (!isPV && this.tt.entryDepth >= depth) {
        let ttScore = this.tt.entryScore;
        if (ttScore > MATE_THRESHOLD) ttScore -= ply;
        else if (ttScore < -MATE_THRESHOLD) ttScore += ply;
        const flag = this.tt.entryFlag;
        if (flag === TT_EXACT
          || (flag === TT_LOWER && ttScore >= beta)
          || (flag === TT_UPPER && ttScore <= alpha)) {
          this.debugCounters.ttHits++;
          return ttScore;
        }
      }
    }

    // --- check extension ---------------------------------------------------
    if (inCheck) depth++;

    // The static evaluation is only needed for the pruning decisions below, so
    // it is computed on demand instead of at every node.
    let staticEval = -INFINITE;
    const getStaticEval = () => {
      if (staticEval === -INFINITE) staticEval = evaluate(position);
      return staticEval;
    };

    // --- reverse futility (static null move) pruning -----------------------
    if (!isPV && !inCheck && depth <= 4 && Math.abs(beta) < MATE_THRESHOLD
      && getStaticEval() - 90 * depth >= beta) {
      return staticEval;
    }

    // --- null move pruning -------------------------------------------------
    if (canNull && !isPV && !inCheck && depth >= 3 && getStaticEval() >= beta
      && Math.abs(beta) < MATE_THRESHOLD
      && position.hasNonPawnMaterial(us)) {
      const reduction = depth > 6 ? 3 : 2;
      position.makeNullMove();
      const score = -this.negamax(position, depth - 1 - reduction, -beta, -beta + 1, ply + 1, false);
      position.unmakeNullMove();
      if (score >= beta) {
        this.debugCounters.nullCutoffs++;
        // A mate score obtained through a null move is not trustworthy.
        return Math.abs(score) > MATE_THRESHOLD ? beta : score;
      }
    }

    // --- generate and order moves ------------------------------------------
    const list = this.moveLists[ply];
    list.clear();
    position.generateMoves(list);
    if (this.verifyMoves) verifyNode(position, list);

    // Countermove: the quiet move that refuted the opponent's previous move.
    const previousMove = ply > 0 ? this.moveStack[ply - 1] : 0;
    const counterMove = previousMove !== 0
      ? this.counterMoves[us * 4096 + ((previousMove & 63) << 6) + ((previousMove >>> 6) & 63)]
      : 0;
    scoreMoves(list, ttMove, us, ply, this.killer1, this.killer2, this.history, counterMove);

    let bestScore = -INFINITE;
    let bestMove = 0;
    let legalMoves = 0;
    const originalAlpha = alpha;
    // Pruning is only allowed once a move has been searched at this node.
    const canPrune = !isPV && !inCheck && Math.abs(beta) < MATE_THRESHOLD;

    for (let i = 0; i < list.count; i++) {
      const move = pickNext(list, i);
      const quiet = !isCapture(move) && !isPromotion(move);

      position.makeMove(move);
      if (position.isKingInCheck(us)) {
        position.unmakeMove(move);
        continue;
      }
      legalMoves++;

      if (legalMoves > 1 && canPrune) {
        // Static exchange pruning (off by default, see the constructor): a
        // capture that loses material outright is not worth searching.
        if (this.seePruning && !isPromotion(move) && isCapture(move)
          && depth <= 4 && see(position, move) < -90 * depth) {
          position.unmakeMove(move);
          continue;
        }

        if (quiet) {
          const givesCheck = position.isKingInCheck(them);

          // Futility pruning: a quiet move that cannot lift the static score to
          // alpha at depth 1-2 is hopeless unless it gives check.
          if (depth <= 2 && !givesCheck && getStaticEval() + 140 * depth <= alpha) {
            position.unmakeMove(move);
            continue;
          }

          // Late move pruning: with many better moves available, the last quiet
          // moves at very shallow depth are not worth searching.
          if (depth <= 3 && !givesCheck && legalMoves > 14 + (depth * 6)) {
            position.unmakeMove(move);
            continue;
          }
        }
      }

      this.moveStack[ply] = move;

      let score;
      if (legalMoves === 1) {
        score = -this.negamax(position, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // Late move reductions: quiet moves late in the list are searched with
        // a shallower depth.  Anything that still beats alpha is re-searched at
        // full depth, so a reduction can only cost accuracy in positions that
        // are already worse for the mover.
        let reduction = 0;
        if (quiet && depth >= 3 && legalMoves > 3 && !inCheck) {
          reduction = this.lmrTable[depth * 64 + Math.min(63, legalMoves)];
          if (isPV) reduction = Math.max(0, reduction - 1);
          reduction = Math.min(reduction, depth - 2);
        }
        score = -this.negamax(position, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (reduction > 0 && score > alpha) {
          this.debugCounters.lmReductions++;
          score = -this.negamax(position, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        if (score > alpha && score < beta) {
          score = -this.negamax(position, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      position.unmakeMove(move);

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          // Record the principal variation.
          this.pvTable[ply * MAX_PLY] = move;
          const childLength = this.pvLength[ply + 1];
          if (childLength > 0) {
            this.pvTable.copyWithin(
              ply * MAX_PLY + 1,
              (ply + 1) * MAX_PLY,
              (ply + 1) * MAX_PLY + childLength,
            );
          }
          this.pvLength[ply] = childLength + 1;
        }
      }

      if (alpha >= beta) {
        if (quiet) {
          if (this.killer1[ply] !== move) {
            this.killer2[ply] = this.killer1[ply];
            this.killer1[ply] = move;
          }
          const idx = (us * 4096) + ((move & 63) << 6) + ((move >>> 6) & 63);
          // History gravity: small updates move the entry, and the values stay
          // bounded without ever needing a full rescale.
          const bonus = Math.min(1600, depth * 32 + 64);
          this.history[idx] += bonus - Math.round((this.history[idx] * bonus) / this.historyMax);
          if (this.history[idx] < 0) this.history[idx] = 0;
          // Countermove: remember this quiet move as a good answer to the
          // opponent's previous move.
          if (previousMove !== 0) {
            const cmIdx = us * 4096 + ((previousMove & 63) << 6) + ((previousMove >>> 6) & 63);
            this.counterMoves[cmIdx] = move;
          }
        }
        break;
      }
    }

    if (legalMoves === 0) {
      return inCheck ? -MATE + ply : DRAW;
    }

    // --- store in the transposition table ----------------------------------
    let storeScore = bestScore;
    if (storeScore > MATE_THRESHOLD) storeScore += ply;
    else if (storeScore < -MATE_THRESHOLD) storeScore -= ply;
    let flag = TT_EXACT;
    if (bestScore <= originalAlpha) flag = TT_UPPER;
    else if (bestScore >= beta) flag = TT_LOWER;
    this.tt.store(position.keyLo, position.keyHi, bestMove, storeScore, depth, flag);

    return bestScore;
  }

  // -------------------------------------------------------------------------
  // Quiescence search
  // -------------------------------------------------------------------------
  quiescence(position, alpha, beta, ply) {
    this.nodes++;
    this.qnodes++;
    if ((this.nodes & 511) === 0) this.checkTime();
    if (ply > this.seldepth) this.seldepth = ply;
    if (ply >= MAX_PLY - 2) return evaluate(position);

    const us = position.side;
    const inCheck = position.isKingInCheck(us);

    if (isImmediateDraw(position)) return DRAW;

    // A transposition-table bound from a previous search of this position is
    // valid here too; quiescence trees are full of transpositions.
    let ttMove = 0;
    if (this.tt.probe(position.keyLo, position.keyHi)) {
      const ttScore = this.tt.entryScore;
      const flag = this.tt.entryFlag;
      ttMove = this.tt.entryMove;
      // Mate scores are ply-relative and are not adjusted here, so they are
      // never used as a quiescence cutoff.
      if (Math.abs(ttScore) < MATE_THRESHOLD
        && (flag === TT_EXACT
          || (flag === TT_LOWER && ttScore >= beta)
          || (flag === TT_UPPER && ttScore <= alpha))) {
        return ttScore;
      }
    }

    const alphaOrig = alpha;
    let bestScore;
    if (!inCheck) {
      const standPat = evaluate(position);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
      bestScore = standPat;
    } else {
      bestScore = -INFINITE;
    }

    const list = this.moveLists[ply];
    list.clear();
    // In check every move must be tried, otherwise only noisy moves.
    position.generateMoves(list, !inCheck);
    if (this.verifyMoves) verifyNode(position, list);
    scoreMoves(list, ttMove, us, ply, this.killer1, this.killer2, this.history);

    let legalMoves = 0;
    for (let i = 0; i < list.count; i++) {
      const move = pickNext(list, i);

      if (!inCheck) {
        // Delta pruning: if winning the captured material cannot lift the score
        // to alpha, the move cannot matter. Promotions are always searched.
        if (!isPromotion(move)) {
          const victimValue = CAPTURE_VALUES[(move >>> 21) & 7];
          if (bestScore + victimValue + 200 < alpha) continue;
        }
        // Static exchange pruning: a capture that loses material even when it
        // wins the first piece is almost never worth searching.
        if (this.seeQuiescence && !isPromotion(move) && see(position, move) < 0) continue;
      }

      position.makeMove(move);
      if (position.isKingInCheck(us)) {
        position.unmakeMove(move);
        continue;
      }
      legalMoves++;
      const score = -this.quiescence(position, -beta, -alpha, ply + 1);
      position.unmakeMove(move);

      if (score > bestScore) {
        bestScore = score;
        if (score > alpha) alpha = score;
      }
      if (alpha >= beta) break;
    }

    if (inCheck && legalMoves === 0) return -MATE + ply;
    // Depth 0 entries never replace a deeper entry, but they do catch
    // transpositions between capture lines.
    if (Math.abs(bestScore) < MATE_THRESHOLD) {
      const flag = bestScore >= beta ? TT_LOWER
        : (bestScore <= alphaOrig ? TT_UPPER : TT_EXACT);
      this.tt.store(position.keyLo, position.keyHi, 0, bestScore, 0, flag);
    }
    return bestScore;
  }
}

// ---------------------------------------------------------------------------
// SearchSession: one iteration of iterative deepening per call
// ---------------------------------------------------------------------------
export class SearchSession {
  constructor(searcher, position, limits = {}, onInfo = null) {
    this.searcher = searcher;
    // Search a private copy: the caller's Position is never mutated, even when
    // the search is aborted in the middle of an iteration (make/unmake pairs
    // cannot be unwound when an exception unwinds the tree).
    this.original = position;
    this.position = position.clone();
    this.limits = limits;
    this.onInfo = onInfo;
    this.started = Date.now();
    this.finished = false;
    this.aborted = false;
    this.noLegalMoves = false;

    this.maxDepth = Math.max(1, Math.min(limits.depth ?? MAX_PLY - 2, MAX_PLY - 2));
    this.depth = 0;
    this.completedDepth = 0;
    this.bestScore = 0;
    this.bestMove = 0;
    this.ponderMove = 0;
    this.aspirationScore = 0;
    this.haveScore = false;

    searcher.reset();
    searcher.startTime = this.started;

    // ---- time management ---------------------------------------------------
    searcher.maxNodes = limits.nodes && limits.nodes > 0 ? limits.nodes : Infinity;
    let soft = Infinity;
    let hard = Infinity;
    if (limits.movetime && limits.movetime > 0) {
      soft = Math.max(1, limits.movetime - searcher.moveOverhead);
      hard = Math.max(1, limits.movetime - Math.min(searcher.moveOverhead, 10));
    } else if ((limits.wtime !== undefined && limits.wtime > 0)
      || (limits.btime !== undefined && limits.btime > 0)) {
      const myTime = position.side === WHITE ? (limits.wtime ?? 0) : (limits.btime ?? 0);
      const inc = position.side === WHITE ? (limits.winc ?? 0) : (limits.binc ?? 0);
      const movesToGo = limits.movestogo && limits.movestogo > 0 ? limits.movestogo : 30;
      const usable = Math.max(1, myTime - searcher.moveOverhead);
      const base = usable / movesToGo + inc * 0.75;
      soft = Math.max(1, Math.min(base, usable * 0.4));
      hard = Math.max(soft, Math.min(base * 3, usable * 0.75));
    }
    if (limits.infinite) {
      soft = Infinity;
      hard = Infinity;
    }
    this.softDeadline = Number.isFinite(soft) ? this.started + soft : Infinity;
    searcher.deadline = Number.isFinite(hard)
      ? this.started + hard
      : Number.MAX_SAFE_INTEGER;

    // ---- root move list ----------------------------------------------------
    searcher.rootMoves.clear();
    this.position.generateLegalMoves(searcher.rootMoves);
    if (limits.searchMoves && limits.searchMoves.length > 0 && searcher.rootMoves.count > 0) {
      // UCI "searchmoves": only the listed root moves are searched.  Moves that
      // are not legal in this position are ignored; if none of them is legal
      // the whole list is searched (a GUI error must not produce a null move).
      const allowed = limits.searchMoves;
      const kept = [];
      for (let i = 0; i < searcher.rootMoves.count; i++) {
        const move = searcher.rootMoves.moves[i];
        if (allowed.includes(move)) kept.push(move);
      }
      if (kept.length > 0) {
        searcher.rootMoves.count = kept.length;
        for (let i = 0; i < kept.length; i++) searcher.rootMoves.moves[i] = kept[i];
      }
    }
    if (searcher.rootMoves.count === 0) {
      this.noLegalMoves = true;
      this.finished = true;
      const inCheck = this.position.isKingInCheck(this.position.side);
      this.bestScore = inCheck ? -MATE : 0;
    } else {
      this.bestMove = searcher.rootMoves.moves[0];
      searcher.rootBestMove = this.bestMove;
    }
  }

  /**
   * Run the next iterative-deepening iteration.
   * @returns {boolean} true when another iteration may be run, false when the
   *          search is complete (limit reached, mate found, or aborted).
   */
  runNextIteration() {
    if (this.finished) return false;
    const s = this.searcher;
    if (s.stopRequested) {
      this.aborted = true;
      this.finished = true;
      return false;
    }
    this.depth++;
    s.rootDepth = this.depth;

    // Aspiration window around the previous score.
    let alpha = -INFINITE;
    let beta = INFINITE;
    if (this.haveScore && this.depth >= 4 && Math.abs(this.aspirationScore) < MATE_THRESHOLD) {
      alpha = this.aspirationScore - 25;
      beta = this.aspirationScore + 25;
    }

    let score;
    try {
      for (let attempt = 0; ; attempt++) {
        score = s.searchRoot(this.position, this.depth, alpha, beta);
        if (score <= alpha) {
          alpha = Math.max(-INFINITE, alpha - (25 << Math.min(attempt, 4)));
          continue;
        }
        if (score >= beta) {
          beta = Math.min(INFINITE, beta + (25 << Math.min(attempt, 4)));
          continue;
        }
        break;
      }
    } catch (err) {
      if (err !== ABORT) throw err;
      this.aborted = true;
      this.finished = true;
      return false;
    }

    this.completedDepth = this.depth;
    this.bestScore = score;
    this.aspirationScore = score;
    this.haveScore = true;
    this.bestMove = s.rootBestMove;
    this.ponderMove = s.pv.length > 1 ? s.pv[1] : 0;

    if (this.onInfo) this.onInfo(this.info());

    // Decide whether to keep going.
    const elapsed = Date.now() - this.started;
    if (this.depth >= this.maxDepth) this.finished = true;
    else if (Math.abs(score) >= MATE_THRESHOLD) this.finished = true;
    else if (Number.isFinite(this.softDeadline) && elapsed >= this.softDeadline - this.started) this.finished = true;
    return !this.finished;
  }

  /** Structured information about the completed iteration. */
  info() {
    const s = this.searcher;
    const elapsed = Math.max(1, Date.now() - this.started);
    return {
      depth: this.completedDepth,
      seldepth: s.seldepth,
      score: this.bestScore,
      mate: Searcher.mateDistance(this.bestScore),
      nodes: s.nodes,
      nps: Math.round((s.nodes * 1000) / elapsed),
      timeMs: elapsed,
      hashfull: s.tt.hashfull(),
      pv: s.pv.slice(),
    };
  }

  /** Final result of the search. */
  result() {
    const s = this.searcher;
    const elapsed = Math.max(1, Date.now() - this.started);
    if (this.noLegalMoves) {
      return {
        bestMove: 0,
        ponderMove: 0,
        pv: [],
        score: this.bestScore,
        mate: Searcher.mateDistance(this.bestScore),
        depth: 0,
        seldepth: 0,
        nodes: 0,
        qnodes: 0,
        nps: 0,
        timeMs: 0,
        hashfull: 0,
        aborted: this.aborted,
        noLegalMoves: true,
      };
    }
    // If the first iteration could not even finish, fall back to the first
    // legal move so the engine never returns an illegal or empty move.
    if (this.completedDepth === 0) {
      this.bestMove = s.rootMoves.moves[0];
      this.bestScore = evaluate(this.position);
    }
    return {
      bestMove: this.bestMove,
      ponderMove: this.ponderMove,
      pv: s.pv.slice(),
      score: this.bestScore,
      mate: Searcher.mateDistance(this.bestScore),
      depth: this.completedDepth,
      seldepth: s.seldepth,
      nodes: s.nodes,
      qnodes: s.qnodes,
      nps: Math.round((s.nodes * 1000) / elapsed),
      timeMs: elapsed,
      hashfull: s.tt.hashfull(),
      aborted: this.aborted,
      noLegalMoves: false,
    };
  }
}

export { WHITE_COLOUR };
