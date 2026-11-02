/**
 * src/uci/uci.js
 *
 * UCI protocol implementation.
 *
 * The engine speaks standard UCI, so it can be driven by any chess GUI or
 * engine-match tool (Cute Chess, Arena, BanksiaGUI, ...) and can play against
 * Stockfish.  The protocol handler is transport agnostic: it is given an
 * ``output`` callback and a ``handleLine()`` method, which the Node CLI wires
 * to stdin/stdout and the browser version wires to a Web Worker.
 *
 * Supported, all exercised by tests/uci.test.js and tests/uci-process.test.js:
 *   uci, isready, ucinewgame, setoption, position (startpos|fen + moves), go
 *   (depth, nodes, movetime, wtime/btime/winc/binc/movestogo, infinite,
 *   searchmoves), stop, ponderhit, quit.
 * Extension commands (not part of UCI, harmless for GUIs): d/board, eval,
 * perft, bench, help.
 *
 * Not implemented (deliberately, and documented in the README):
 *   - real pondering ("go ponder" runs as an infinite search and "ponderhit"
 *     stops it and plays the move found so far),
 *   - MultiPV > 1,
 *   - "go mate <n>" (treated as an unlimited search).
 *
 * Protocol hygiene: unknown commands, unknown options and the optional
 * "debug"/"register" commands are ignored silently, as the UCI specification
 * asks.  Set "debug on" to get an "info string" for each of them, plus an echo
 * of the position after every "position" command.
 */

import { Position } from '../core/position.js';
import { Searcher, MATE } from '../search/search.js';
import { moveToUci, MoveList } from '../core/moves.js';
import { WHITE } from '../core/types.js';
import { evaluate, evaluateBreakdown } from '../eval/evaluate.js';
import { perft, perftDivide } from '../search/perft.js';
import { runBenchmark, BENCH_POSITIONS } from '../tools/bench.js';

export const ENGINE_NAME = 'SOLACE';
export const ENGINE_VERSION = '0.1.5';
export const ENGINE_AUTHOR = 'SOLACE project';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Tokens that terminate a "searchmoves" list in a "go" command. */
const GO_KEYWORDS = new Set([
  'searchmoves', 'ponder', 'wtime', 'btime', 'winc', 'binc', 'movestogo',
  'depth', 'nodes', 'mate', 'movetime', 'infinite',
]);

export class UciEngine {
  /**
   * @param {object} options
   * @param {function(string)} options.output called once per output line
   */
  constructor(options = {}) {
    this.output = options.output ?? ((line) => console.log(line));

    this.searcher = new Searcher({ hashMB: 16, moveOverhead: 30 });
    this.position = new Position();
    this.position.setStartPosition();
    this.positionHistory = [START_FEN];

    this.searching = false;
    this.session = null;
    this.timer = null;
    this.quitRequested = false;
    this.pondering = false;
    // UCI "debug on" enables chatty diagnostics (unknown commands, position echo).
    this.debugEcho = false;
    this.applyMovesToPosition = options.applyMovesToPosition ?? false;
    this.options = {
      Hash: 16,
      'Move Overhead': 30,
      VerifyMoves: false,
    };
    this.lastResult = null;
  }

  // -------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------
  send(line) {
    this.output(line);
  }

  sendInfo(info) {
    const parts = [
      `depth ${info.depth}`,
      `seldepth ${info.seldepth}`,
      'multipv 1',
    ];
    if (info.mate !== null && info.mate !== undefined) {
      parts.push(`score mate ${info.mate}`);
    } else {
      parts.push(`score cp ${info.score}`);
    }
    parts.push(`nodes ${info.nodes}`);
    parts.push(`nps ${info.nps}`);
    parts.push(`hashfull ${info.hashfull}`);
    parts.push(`time ${info.timeMs}`);
    if (info.pv && info.pv.length) parts.push(`pv ${info.pv.map(moveToUci).join(' ')}`);
    this.send('info ' + parts.join(' '));
  }

  // -------------------------------------------------------------------------
  // Command handling
  // -------------------------------------------------------------------------
  /** Process one UCI command line. Returns false when the engine should quit. */
  handleLine(rawLine) {
    const line = String(rawLine ?? '').trim();
    if (line === '') return true;
    const tokens = line.split(/\s+/);
    const command = tokens[0];

    switch (command) {
      case 'uci': this.cmdUci(); break;
      case 'isready': this.send('readyok'); break;
      case 'setoption': this.cmdSetOption(tokens); break;
      case 'debug': this.cmdDebug(tokens); break;
      case 'register': /* optional and irrelevant here, ignore like a GUI would */ break;
      case 'ucinewgame':
        this.searcher.clearHash();
        this.stopSearch();
        this.breakSearchState();
        this.position.setFen(START_FEN);
        break;
      case 'position': this.cmdPosition(tokens); break;
      case 'go': this.cmdGo(tokens); break;
      case 'stop': this.cmdStop(); break;
      case 'ponderhit': this.cmdPonderhit(); break;
      case 'quit':
        this.quitRequested = true;
        // Report the move of a search that is still running before leaving.
        this.stopSearch();
        this.breakSearchState();
        return false;
      case 'd':
      case 'board':
        this.cmdBoard();
        break;
      case 'eval': this.cmdEval(); break;
      case 'perft': this.cmdPerft(tokens); break;
      case 'bench': this.cmdBench(tokens); break;
      case 'help': this.cmdHelp(); break;
      default:
        // The UCI specification expects unknown commands to be ignored; only
        // "debug on" makes them visible.
        if (this.debugEcho) this.send(`info string ignored unknown command "${command}"`);
        break;
    }
    return true;
  }

  cmdDebug(tokens) {
    this.debugEcho = tokens[1] === 'on';
    if (this.debugEcho) this.send('info string debug on');
  }

  cmdUci() {
    this.send(`id name ${ENGINE_NAME} ${ENGINE_VERSION}`);
    this.send(`id author ${ENGINE_AUTHOR}`);
    this.send('option name Hash type spin default 16 min 1 max 512');
    this.send('option name Move Overhead type spin default 30 min 0 max 5000');
    this.send('option name VerifyMoves type check default false');
    this.send('option name Clear Hash type button');
    this.send('uciok');
  }

  cmdHelp() {
    const lines = [
      'UCI commands: uci, isready, ucinewgame, setoption name <Name> value <Value>,',
      '              position startpos|fen ... [moves ...], go [depth|nodes|movetime|',
      '              wtime/btime/winc/binc/movestogo|infinite|searchmoves ...], stop,',
      '              ponderhit, quit, debug on|off, register',
      'Extra commands: d (show board), eval, perft <depth>, bench [depth], help',
    ];
    for (const line of lines) this.send('info string ' + line);
  }

  cmdSetOption(tokens) {
    const nameIndex = tokens.indexOf('name');
    const valueIndex = tokens.indexOf('value');
    if (nameIndex < 0) {
      this.send('info string setoption needs a name');
      return;
    }
    const name = tokens.slice(nameIndex + 1, valueIndex >= 0 ? valueIndex : tokens.length).join(' ');
    const value = valueIndex >= 0 ? tokens.slice(valueIndex + 1).join(' ') : '';

    switch (name.toLowerCase()) {
      case 'hash': {
        const mb = Number(value);
        if (!Number.isFinite(mb) || mb < 1 || mb > 512) {
          this.send('info string Hash must be between 1 and 512 MB');
          return;
        }
        this.options.Hash = Math.round(mb);
        this.searcher.setHashSize(this.options.Hash);
        break;
      }
      case 'move overhead': {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms < 0 || ms > 5000) {
          this.send('info string Move Overhead must be between 0 and 5000 ms');
          return;
        }
        this.options['Move Overhead'] = Math.round(ms);
        this.searcher.moveOverhead = Math.round(ms);
        break;
      }
      case 'verifymoves':
        this.options.VerifyMoves = value === 'true';
        this.searcher.verifyMoves = this.options.VerifyMoves;
        this.send(`info string VerifyMoves ${this.options.VerifyMoves ? 'on' : 'off'}`);
        break;
      case 'clear hash':
        this.searcher.clearHash();
        this.send('info string hash cleared');
        break;
      default:
        // Unknown options (Ponder, UCI_AnalyseMode, ...) are ignored, as the
        // specification requires.  Known options always report bad values.
        if (this.debugEcho) this.send(`info string ignored unknown option "${name}"`);
        break;
    }
  }

  cmdPosition(tokens) {
    // A position command that arrives mid-search ends that search: the old
    // position is about to be replaced, so its result is no longer useful.
    if (this.searching) this.stopSearch();
    let index = 1;
    let fen;
    if (tokens[index] === 'startpos') {
      fen = START_FEN;
      index++;
    } else if (tokens[index] === 'fen') {
      const fenTokens = [];
      index++;
      while (index < tokens.length && tokens[index] !== 'moves') {
        fenTokens.push(tokens[index]);
        index++;
      }
      fen = fenTokens.join(' ');
    } else {
      this.send('info string position needs "startpos" or "fen"');
      return;
    }

    const position = new Position();
    try {
      position.setFen(fen);
    } catch (err) {
      this.send(`info string invalid FEN: ${err.message}`);
      return;
    }

    if (tokens[index] === 'moves') {
      index++;
      for (; index < tokens.length; index++) {
        const text = tokens[index];
        const move = position.parseMove(text);
        if (!move) {
          this.send(`info string illegal move in position command: ${text}`);
          return;
        }
        position.makeMove(move);
      }
    }

    this.position = position;
    if (this.debugEcho) this.send(`info string position set: ${position.toFen()}`);
    return true;
  }

  cmdGo(tokens) {
    // A new "go" cancels whatever is running (same rule as "position").
    if (this.searching) this.stopSearch();
    const limits = {};
    this.pondering = false;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      const next = () => {
        const v = Number(tokens[i + 1]);
        i++;
        return Number.isFinite(v) ? v : 0;
      };
      switch (token) {
        case 'wtime': limits.wtime = next(); break;
        case 'btime': limits.btime = next(); break;
        case 'winc': limits.winc = next(); break;
        case 'binc': limits.binc = next(); break;
        case 'movestogo': limits.movestogo = next(); break;
        case 'depth': limits.depth = next(); break;
        case 'nodes': limits.nodes = next(); break;
        case 'movetime': limits.movetime = next(); break;
        case 'infinite': limits.infinite = true; break;
        case 'ponder': limits.infinite = true; this.pondering = true; break;
        case 'searchmoves': {
          // The move list runs until the next keyword.
          const moves = [];
          while (i + 1 < tokens.length && !GO_KEYWORDS.has(tokens[i + 1])) {
            const text = tokens[++i];
            const move = this.position.parseMove(text);
            if (move) moves.push(move);
            else if (this.debugEcho) this.send(`info string searchmoves: ignoring illegal move ${text}`);
          }
          if (moves.length > 0) limits.searchMoves = moves;
          break;
        }
        case 'mate': next(); break; // treated as an unlimited search
        default: break;
      }
    }
    this.startSearch(limits);
  }

  cmdStop() {
    this.stopSearch();
  }

  /**
   * Stop a running search and send its ``bestmove``.  Safe to call when no
   * search is running.  Because the engine is single threaded, this can only
   * run between two search iterations, so no iteration is ever cut in half.
   */
  stopSearch() {
    if (!this.searching) return;
    this.searcher.stop();
    this.finishSearch();
  }

  cmdPonderhit() {
    // Pondering is approximated as an infinite search: play the best move found
    // so far as soon as the opponent's move is confirmed.
    this.pondering = false;
    if (this.searching) this.searcher.stop();
  }

  cmdBoard() {
    const lines = [];
    lines.push(`position: ${this.position.toFen()}`);
    lines.push('  +---+---+---+---+---+---+---+---+');
    for (let rank = 7; rank >= 0; rank--) {
      let row = `${rank + 1} |`;
      for (let file = 0; file < 8; file++) {
        const code = this.position.board[rank * 8 + file];
        row += ' ' + boardChar(code) + ' |';
      }
      lines.push(row);
      lines.push('  +---+---+---+---+---+---+---+---+');
    }
    lines.push('    a   b   c   d   e   f   g   h');
    lines.push(`${this.position.side === WHITE ? 'White' : 'Black'} to move, castling ${castlingText(this.position)}, en passant ${this.position.epSquare >= 0 ? 'yes' : 'no'}, halfmove ${this.position.halfmove}, fullmove ${this.position.fullmove}`);
    for (const line of lines) this.send('info string ' + line);
  }

  cmdEval() {
    const breakdown = evaluateBreakdown(this.position);
    this.send(`info string static evaluation (side to move): ${(evaluate(this.position) / 100).toFixed(2)} pawns`);
    this.send(`info string white-relative: ${(breakdown.absolute / 100).toFixed(2)} pawns, phase ${breakdown.phase}/24, middlegame ${(breakdown.mg / 100).toFixed(2)}, endgame ${(breakdown.eg / 100).toFixed(2)}`);
    this.send(`info string material white=${breakdown.materialWhite} black=${breakdown.materialBlack}, check=${this.position.inCheck()}`);
  }

  cmdPerft(tokens) {
    const depth = Number(tokens[1] ?? 3);
    if (!Number.isInteger(depth) || depth < 1 || depth > 8) {
      this.send('info string perft depth must be an integer between 1 and 8');
      return;
    }
    const started = Date.now();
    const rows = perftDivide(this.position, depth, moveToUci);
    for (const row of rows) {
      if (row.move === 'total') continue;
      this.send(`info string ${row.move}: ${row.nodes}`);
    }
    const total = rows[rows.length - 1].nodes;
    const elapsed = Math.max(1, Date.now() - started);
    this.send(`info string perft(${depth}) = ${total} in ${elapsed} ms (${Math.round((total * 1000) / elapsed)} nps)`);
  }

  cmdBench(tokens) {
    const depth = Number(tokens[1] ?? 5);
    const result = runBenchmark({ depth: Number.isFinite(depth) ? depth : 5 });
    for (const line of result.lines) this.send('info string ' + line);
  }

  // -------------------------------------------------------------------------
  // Search driving
  // -------------------------------------------------------------------------
  startSearch(limits) {
    const position = this.position.clone();
    this.session = this.searcher.createSession(position, limits, (info) => this.sendInfo(info));
    this.searching = true;

    if (this.session.noLegalMoves) {
      this.finishSearch();
      return;
    }

    const step = () => {
      this.timer = null;
      if (!this.searching) return;
      let more = false;
      try {
        more = this.session.runNextIteration();
      } catch (err) {
        this.send(`info string search error: ${err.message}`);
        this.searching = false;
        this.session = null;
        return;
      }
      if (more) {
        // Yield to the event loop so "stop"/"quit" can be processed.
        this.timer = setTimeout(step, 0);
      } else {
        this.finishSearch();
      }
    };
    this.timer = setTimeout(step, 0);
  }

  finishSearch() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const session = this.session;
    this.searching = false;
    this.session = null;
    if (!session) return;

    const result = session.result();
    this.lastResult = result;

    if (result.noLegalMoves) {
      const inCheck = session.position.isKingInCheck(session.position.side);
      this.send(`info string ${inCheck ? 'checkmate' : 'stalemate'} - no legal moves`);
    }
    if (result.bestMove === 0) {
      this.send('bestmove 0000');
      return;
    }

    const best = moveToUci(result.bestMove);
    const ponder = result.ponderMove ? ` ponder ${moveToUci(result.ponderMove)}` : '';
    this.send(`bestmove ${best}${ponder}`);

    if (this.applyMovesToPosition) {
      const move = this.position.parseMove(best);
      if (move) this.position.makeMove(move);
    }
  }

  /** Stop any running search immediately (used by "quit"). */
  breakSearchState() {
    this.searcher.stop();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.searching = false;
    this.session = null;
  }
}

function boardChar(code) {
  if (code === 0) return ' ';
  const letters = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
  const letter = letters[code & 7];
  return (code >> 3) === WHITE ? letter : letter.toLowerCase();
}

function castlingText(position) {
  let text = '';
  if (position.castling & 1) text += 'K';
  if (position.castling & 2) text += 'Q';
  if (position.castling & 4) text += 'k';
  if (position.castling & 8) text += 'q';
  return text || '-';
}

export { START_FEN, MATE, MoveList, BENCH_POSITIONS };
