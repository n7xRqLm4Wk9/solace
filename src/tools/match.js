/**
 * src/tools/match.js
 *
 * Engine-versus-engine match runner over the UCI protocol.  Two engine
 * processes are started, handshaken ("uci" / "isready") and then play a series
 * of games with alternating colours.  This is the same mechanism used to play
 * SOLACE against Stockfish: point --opponent at the Stockfish binary.
 *
 * Time controls:
 *   movetime:1000        fixed 1 s per move
 *   depth:6             fixed depth 6
 *   wtime=60000+inc=1000  clock based (60 s + 1 s per move for each side)
 *
 * Every move is validated against SOLACE's own move generator, so an engine
 * that plays an illegal move loses the game immediately (and the incident is
 * reported), which keeps the match results trustworthy.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DEFAULT_OPENINGS, openingPosition } from './openings.js';
import { MoveList, moveToUci } from '../core/moves.js';
import { adjudicate } from './selfplay.js';

class UciProcess {
  constructor(command, { name = 'engine', onLine = null } = {}) {
    this.name = name;
    this.command = command;
    this.onLine = onLine;
    this.lines = [];
    this.waiters = [];
    this.pendingBestmove = null;
    this.alive = true;

    this.child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (data) => {
      // Keep stderr quiet unless the process dies; some engines log there.
      this.stderr = (this.stderr ?? '') + data.toString();
    });
    this.child.on('exit', (code) => {
      this.alive = false;
      for (const waiter of this.waiters) waiter.reject(new Error(`${this.name} exited with code ${code}`));
      this.waiters = [];
    });
  }

  handleLine(line) {
    if (this.onLine) this.onLine(line);
    if (line.startsWith('bestmove')) {
      this.pendingBestmove = line;
    }
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (line.startsWith(waiter.prefix)) {
        this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
        return;
      }
    }
    this.lines.push(line);
  }

  send(text) {
    if (!this.alive) throw new Error(`${this.name}: process is not running`);
    this.child.stdin.write(text + '\n');
  }

  /** Wait for a line starting with ``prefix`` (also checks already-received lines). */
  waitFor(prefix, timeoutMs = 30000) {
    const existing = this.lines.findIndex((l) => l.startsWith(prefix));
    if (existing >= 0) {
      const [line] = this.lines.splice(existing, 1);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`${this.name}: timed out waiting for "${prefix}"`));
      }, timeoutMs);
      this.waiters.push({ prefix, resolve, reject, timer });
    });
  }

  async handshake(hashMB, options = {}) {
    this.send('uci');
    await this.waitFor('uciok');
    if (hashMB) this.send(`setoption name Hash value ${hashMB}`);
    for (const [name, value] of Object.entries(options)) {
      this.send(`setoption name ${name} value ${value}`);
    }
    this.send('isready');
    await this.waitFor('readyok');
    this.lines.length = 0;
  }

  async go(position, timeControl) {
    this.lines.length = 0;
    this.pendingBestmove = null;
    const fen = position.toFen();
    this.send(`position fen ${fen}`);
    const started = Date.now();
    this.send(`go ${timeControl}`);
    const line = await this.waitFor('bestmove', 120000);
    const elapsedMs = Date.now() - started;
    const tokens = line.split(/\s+/);
    return { bestMove: tokens[1], raw: line, elapsedMs };
  }

  quit() {
    if (!this.alive) return;
    try {
      this.send('quit');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.alive) this.child.kill('SIGKILL');
    }, 1000);
  }
}

/** Parse "movetime:1000", "depth:6" or "wtime=60000+inc=1000". */
function parseTimeControl(spec) {
  const text = String(spec);
  if (text.startsWith('movetime:')) {
    const ms = Number(text.slice('movetime:'.length));
    return { type: 'movetime', ms, goFor: () => `movetime ${ms}` };
  }
  if (text.startsWith('depth:')) {
    const depth = Number(text.slice('depth:'.length));
    return { type: 'depth', depth, goFor: () => `depth ${depth}` };
  }
  const clock = text.match(/wtime=(\d+)\+inc=(\d+)/);
  if (clock) {
    const base = Number(clock[1]);
    const inc = Number(clock[2]);
    return {
      type: 'clock',
      base,
      inc,
      clock: { wtime: base, btime: base },
      goFor(side) {
        const key = side === 0 ? 'wtime' : 'btime';
        return `wtime ${this.clock.wtime} btime ${this.clock.btime} winc ${inc} binc ${inc}`;
      },
    };
  }
  throw new Error(`unrecognised time control "${spec}" (use movetime:MS, depth:N or wtime=MS+inc=MS)`);
}

function legalMovesOf(position) {
  const list = new MoveList(256);
  position.generateLegalMoves(list);
  return list;
}

/**
 * Play a match.
 *
 * @param {object} options
 * @param {string} options.engineCommand   command that starts SOLACE (or any UCI engine)
 * @param {string} options.opponentCommand command that starts the opponent
 * @param {number} [options.games=2]
 * @param {string} [options.timeControl='movetime:1000']
 * @param {number} [options.hashMB=32]
 * @param {number} [options.maxMoves=240]
 * @param {boolean} [options.verbose=true]
 * @param {string[]} [options.openings]  list of FENs used round-robin as starts
 * @returns {Promise<object>} match summary
 */
export async function runMatch(options = {}) {
  const games = Math.max(1, options.games ?? 2);
  const timeControlSpec = options.timeControl ?? 'movetime:1000';
  const hashMB = options.hashMB ?? 32;
  const maxMoves = options.maxMoves ?? 240;
  const verbose = options.verbose ?? true;
  const openings = options.openings && options.openings.length > 0
    ? options.openings
    : DEFAULT_OPENINGS;

  const log = (text) => {
    if (verbose) console.log(text);
  };

  const engine = new UciProcess(options.engineCommand, { name: 'SOLACE' });
  const opponent = new UciProcess(options.opponentCommand, { name: 'opponent' });

  const summary = {
    games: 0,
    wins: 0, // SOLACE wins
    losses: 0,
    draws: 0,
    illegalMoves: 0,
    results: [],
    timeControl: timeControlSpec,
    // Timing: a match is only meaningful if neither side loses on time.
    moves: 0,
    totalMoveMs: 0,
    maxMoveMs: 0,
    timeOverruns: 0,
  };

  try {
    await engine.handshake(hashMB, { VerifyMoves: 'false' });
    if (options.opponentCommand === options.engineCommand) {
      await opponent.handshake(hashMB, {});
    } else {
      await opponent.handshake(hashMB, {});
    }

    for (let game = 0; game < games; game++) {
      const opening = openingPosition(openings[Math.floor(game / 2) % openings.length]);
      const position = opening.position.clone();
      const tc = parseTimeControl(timeControlSpec);
      // Alternate colours so colour advantage cancels out over the match.  Each
      // opening is played twice, once with each colour.
      const engineIsWhite = game % 2 === 0;
      const movetext = [...opening.moves];
      let verdict = null;

      log(`\nGame ${game + 1}: SOLACE plays ${engineIsWhite ? 'white' : 'black'} from ${opening.name}`);

      for (let ply = 0; ply < maxMoves; ply++) {
        const terminal = adjudicate(position);
        if (terminal) {
          verdict = terminal;
          break;
        }
        const engineToMove = (position.side === 0) === engineIsWhite;
        const mover = engineToMove ? engine : opponent;

        let bestMove;
        try {
          const go = tc.type === 'clock'
            ? await mover.go(position, tc.goFor(position.side))
            : await mover.go(position, tc.goFor());
          bestMove = go.bestMove;
          summary.moves++;
          summary.totalMoveMs += go.elapsedMs;
          if (go.elapsedMs > summary.maxMoveMs) summary.maxMoveMs = go.elapsedMs;
          // 50% plus 200 ms of headroom: slower than that means the engine is
          // not respecting the requested thinking time.
          if (tc.type === 'movetime' && go.elapsedMs > tc.ms * 1.5 + 200) {
            summary.timeOverruns++;
            log(`  warning: ${mover.name} took ${go.elapsedMs} ms for a ${tc.ms} ms move`);
          }
        } catch (err) {
          log(`  ${mover.name} failed: ${err.message}`);
          verdict = {
            result: engineToMove ? '0-1' : '1-0',
            reason: `${mover.name} error: ${err.message}`,
          };
          break;
        }

        if (!bestMove || bestMove === '0000') {
          // Some engines answer 0000 when there is no legal move.
          const terminal = adjudicate(position);
          verdict = terminal ?? { result: '1/2-1/2', reason: 'engine reported no move' };
          break;
        }

        const legal = legalMovesOf(position);
        let move = 0;
        for (let i = 0; i < legal.count; i++) {
          if (moveToUci(legal.moves[i]) === bestMove) {
            move = legal.moves[i];
            break;
          }
        }
        if (!move) {
          summary.illegalMoves++;
          log(`  ILLEGAL MOVE by ${mover.name}: ${bestMove} in ${position.toFen()}`);
          verdict = {
            result: engineToMove ? '0-1' : '1-0',
            reason: `${mover.name} played an illegal move (${bestMove})`,
          };
          break;
        }

        if (tc.type === 'clock') {
          const spent = tc.inc; // engines self-report; charge the increment only
          if (position.side === 0) tc.clock.wtime = Math.max(0, tc.clock.wtime - spent);
          else tc.clock.btime = Math.max(0, tc.clock.btime - spent);
        }

        movetext.push(bestMove);
        position.makeMove(move);
      }

      if (!verdict) verdict = adjudicate(position, true) ?? { result: '1/2-1/2', reason: 'unfinished' };

      let solWon = false;
      let solLost = false;
      if (verdict.result === '1-0') {
        if (engineIsWhite) solWon = true;
        else solLost = true;
      } else if (verdict.result === '0-1') {
        if (engineIsWhite) solLost = true;
        else solWon = true;
      }
      if (solWon) summary.wins++;
      else if (solLost) summary.losses++;
      else summary.draws++;
      summary.games++;

      summary.results.push({
        game: game + 1,
        engineIsWhite,
        result: verdict.result,
        reason: verdict.reason,
        moves: movetext,
        finalFen: position.toFen(),
      });

      const fromSolace = solWon ? 'SOLACE wins' : solLost ? 'SOLACE loses' : 'draw';
      log(`  ${verdict.result} (${verdict.reason}) - ${fromSolace}`);
      log(`  moves: ${movetext.join(' ')}`);

      // Tell both engines a new game starts so they can clear their tables.
      engine.send('ucinewgame');
      opponent.send('ucinewgame');
    }
  } finally {
    engine.quit();
    opponent.quit();
  }

  const score = summary.wins + summary.draws * 0.5;
  const rate = summary.games > 0 ? (score / summary.games) * 100 : 0;
  log('');
  log(`match result: +${summary.wins} -${summary.losses} =${summary.draws} of ${summary.games} games`);
  log(`score: ${score} / ${summary.games} (${rate.toFixed(1)}%)`);
  log(`illegal moves: ${summary.illegalMoves}`);
  if (summary.moves > 0) {
    log(`move times: average ${Math.round(summary.totalMoveMs / summary.moves)} ms, `
      + `slowest ${summary.maxMoveMs} ms, overruns ${summary.timeOverruns}`);
  }
  if (summary.games < 30) {
    log('note: fewer than 30 games - treat any strength estimate as indicative only, not an Elo rating');
  }

  summary.score = score;
  summary.scoreRate = rate;
  return summary;
}
