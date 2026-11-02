#!/usr/bin/env node
/**
 * Solace 0.2 — self-play match runner.
 *
 * Plays A against B with the same opening set twice (colours swapped) and
 * reports the score with an error bar, so a parameter change can be judged
 * instead of guessed at.
 *
 *   node 0.2/tools/match.mjs --engine-a "./sf" --engine-b "./sf" \
 *        --a "Solace Tuning=Stockfish 19" --b "Solace Tuning=Solace 0.2" \
 *        --games 200 --movetime 100 --concurrency 2
 *
 * Options:
 *   --engine-a / --engine-b   command lines (default: node 0.2/cli.mjs)
 *   --a / --b                 UCI options for each side, "Name=Value,Name=Value"
 *   --games N                 games to play (rounded up to whole openings pairs)
 *   --movetime MS             fixed thinking time per move (default 100)
 *   --depth D                 search to a fixed depth instead
 *   --hash MB                 hash size (default 16)
 *   --threads N               threads per engine (default 1)
 *   --concurrency N           games in parallel (default 1)
 *   --max-plies N             adjudicate as a draw after N plies (default 250)
 *   --json PATH               also write the raw result as JSON
 *
 * Both engines must speak UCI. The rules (legality, mate, stalemate, 50-move,
 * threefold, insufficient material) are enforced with the pure-JavaScript board
 * model of the 0.1.5 engine, so neither side can cheat a result.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createPosition } from '../../0.1.5/src/core/position.js';
import { MoveList, moveToUci } from '../../0.1.5/src/core/moves.js';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const ENGINE_A = opt('engine-a', `node ${new URL('../cli.mjs', import.meta.url).pathname}`);
const ENGINE_B = opt('engine-b', ENGINE_A);
const OPTS_A = parseOptions(opt('a', ''));
const OPTS_B = parseOptions(opt('b', ''));
const GAMES = Number(opt('games', 100));
const MOVETIME = opt('depth', null) ? null : Number(opt('movetime', 100));
const DEPTH = opt('depth', null) ? Number(opt('depth')) : null;
const HASH = Number(opt('hash', 16));
const THREADS = Number(opt('threads', 1));
const CONCURRENCY = Number(opt('concurrency', 1));
const MAX_PLIES = Number(opt('max-plies', 250));

function parseOptions(text) {
  const out = {};
  for (const pair of String(text).split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// openings — short, varied lines so no two games are the same
// ---------------------------------------------------------------------------

const OPENINGS = [
  // Balanced but varied mainlines, 8-12 plies. Long enough that the engines
  // are out of book (they have no book) but short enough to stay fair.
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7',
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6',
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6',
  'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 d4c6 b7c6',
  'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 e4e5 f6d7 f2f4 c7c5',
  'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6',
  'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5',
  'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8',
  'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c4d5 e6d5 c1g5 c7c6',
  'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5',
  'c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6',
  'c2c4 g8f6 b1c3 e7e6 e2e4 d7d5 e4e5 d5d4 c3e2 f6d7',
  'g1f3 g8f6 c2c4 g7g6 b1c3 f8g7 d2d4 e8g8 e2e4 d7d6',
  'e2e4 e7e5 f1c4 g8f6 d2d3 f8c5 c2c3 d7d6 g1f3 c8e6',
  'd2d4 d7d5 g1f3 g8f6 c2c4 e7e6 b1c3 f8e7 c1f4 e8g8',
  'e2e4 e7e5 b1c3 b8c6 f1c4 f8c5 d2d3 d7d6 f2f4 g8f6',
].map((line) => line.split(' '));


// ---------------------------------------------------------------------------
// tiny UCI engine wrapper
// ---------------------------------------------------------------------------

class Engine {
  constructor(command, options, label) {
    this.label = label;
    this.command = command;
    this.options = options;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.proc = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#data(chunk));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => this.#fail(new Error(`${label} exited`)));
  }

  #data(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      for (const waiter of [...this.waiters]) {
        if (waiter.re.test(line)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(line);
        }
      }
    }
  }

  #fail(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  send(line) {
    this.proc.stdin.write(`${line}\n`);
  }

  waitFor(pattern, timeoutMs = 300000) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    return new Promise((resolve, reject) => {
      const waiter = { re, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${this.label}: timeout waiting for ${re}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async init() {
    const done = this.waitFor(/^uciok/);
    this.send('uci');
    await done;
    this.send(`setoption name Hash value ${HASH}`);
    this.send(`setoption name Threads value ${THREADS}`);
    for (const [name, value] of Object.entries(this.options)) this.send(`setoption name ${name} value ${value}`);
    const ready = this.waitFor(/^readyok/);
    this.send('isready');
    await ready;
  }

  async newGame() {
    this.send('ucinewgame');
    const ready = this.waitFor(/^readyok/);
    this.send('isready');
    await ready;
  }

  async bestMove(moves) {
    const pending = this.waitFor(/^bestmove/);
    this.send(`position startpos${moves.length ? ' moves ' + moves.join(' ') : ''}`);
    this.send(
      DEPTH
        ? `go depth ${DEPTH}`
        : `go movetime ${MOVETIME}`,
    );
    const line = await pending;
    const move = line.split(/\s+/)[1];
    return move === '(none)' || !move ? null : move;
  }

  quit() {
    try {
      this.send('quit');
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// one game
// ---------------------------------------------------------------------------

async function playGame(opening, whiteIsA, seed) {
  const white = await (whiteIsA ? makeA() : makeB());
  const black = await (whiteIsA ? makeB() : makeA());
  const engines = [white, black];

  const pos = createPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const moves = [];
  const seen = new Map();
  let result = null; // 'a' | 'b' | 'draw'

  const applyUci = (uci) => {
    const list = new MoveList(256);
    pos.generateLegalMoves(list);
    for (let i = 0; i < list.count; i++) {
      if (moveToUci(list.moves[i]) === uci) {
        pos.makeMove(list.moves[i]);
        return true;
      }
    }
    return false;
  };

  try {
    for (const move of opening) {
      if (!applyUci(move)) throw new Error(`illegal opening move ${move}`);
      moves.push(move);
    }
    const key0 = pos.computeKey();
    seen.set(key0, 1);

    while (moves.length < MAX_PLIES) {
      const side = moves.length % 2 === 0 ? 0 : 1; // 0 = white, 1 = black
      const engine = engines[side];

      const list = new MoveList(256);
      pos.generateLegalMoves(list);
      if (list.count === 0) {
        result = pos.inCheck() ? (side === 0 ? 'b' : 'a') : 'draw';
        break;
      }
      if (pos.hasInsufficientMaterial && pos.hasInsufficientMaterial()) {
        result = 'draw';
        break;
      }
      if (Number(pos.toFen().split(' ')[4]) >= 100) {
        result = 'draw';
        break;
      }

      const move = await engine.bestMove(moves);
      if (!move || !applyUci(move)) {
        // an engine that cannot produce a legal move loses
        result = side === 0 ? 'b' : 'a';
        break;
      }
      moves.push(move);

      const key = pos.computeKey();
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count >= 3) {
        result = 'draw';
        break;
      }
    }
    if (!result) result = 'draw'; // move limit
  } finally {
    for (const engine of engines) engine.quit();
  }

  return { opening, whiteIsA, moves, result };
}

// engine pools so a pair is only spawned once per game
const poolA = [];
const poolB = [];
const makeA = async () => {
  const engine = poolA.pop() || new Engine(ENGINE_A, OPTS_A, 'A');
  if (!engine.ready) {
    await engine.init();
    engine.ready = true;
  }
  await engine.newGame();
  return engine;
};
const makeB = async () => {
  const engine = poolB.pop() || new Engine(ENGINE_B, OPTS_B, 'B');
  if (!engine.ready) {
    await engine.init();
    engine.ready = true;
  }
  await engine.newGame();
  return engine;
};

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

const pairs = Math.floor(GAMES / 2) || 1;
const jobs = [];
for (let p = 0; p < pairs; p++) {
  const opening = OPENINGS[p % OPENINGS.length];
  jobs.push({ opening, whiteIsA: true });
  jobs.push({ opening, whiteIsA: false });
}

console.log(
  `Solace 0.2 match: A=[${ENGINE_A}] ${JSON.stringify(OPTS_A)}  vs  B=[${ENGINE_B}] ${JSON.stringify(OPTS_B)}`,
);
console.log(
  `${jobs.length} games, ${DEPTH ? `depth ${DEPTH}` : `${MOVETIME} ms/move`}, ${THREADS} thread(s), hash ${HASH} MB\n`,
);

const results = [];
let running = 0;
let index = 0;
const started = Date.now();

await new Promise((resolve) => {
  const launch = () => {
    while (running < CONCURRENCY && index < jobs.length) {
      const job = jobs[index++];
      running++;
      playGame(job.opening, job.whiteIsA, index)
        .then((game) => {
          results.push(game);
          const a = game.result === 'a' ? 1 : game.result === 'b' ? -1 : 0;
          const sign = a > 0 ? 'A wins' : a < 0 ? 'B wins' : 'draw  ';
          const played = results.length;
          const scoreA = results.reduce((s, g) => s + (g.result === 'a' ? 1 : g.result === 'b' ? 0 : 0.5), 0);
          console.log(
            `#${played} ${sign} (${game.moves.length} plies)  A ${scoreA}/${played} = ${((scoreA / played) * 100).toFixed(1)}%`,
          );
        })
        .catch((err) => {
          results.push({ result: 'error', error: err.message });
          console.log(`game error: ${err.message}`);
        })
        .finally(() => {
          running--;
          if (index >= jobs.length && running === 0) resolve();
          else launch();
        });
    }
  };
  launch();
});

const played = results.filter((r) => r.result);
const wins = played.filter((r) => r.result === 'a').length;
const losses = played.filter((r) => r.result === 'b').length;
const draws = played.filter((r) => r.result === 'draw').length;
const n = played.length;
const score = (wins + draws / 2) / n;

const se = Math.sqrt((score * (1 - score)) / n);
const ci = 1.96 * se;
const toElo = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));
const elo = toElo(score);
const eloLow = toElo(Math.max(0.0001, score - ci));
const eloHigh = toElo(Math.min(0.9999, score + ci));
const minutes = ((Date.now() - started) / 60000).toFixed(1);

console.log(`\nA ${wins} wins, B ${losses} wins, ${draws} draws  (${n} games, ${minutes} min)`);
console.log(`score ${(score * 100).toFixed(2)}%  ->  ${elo >= 0 ? '+' : ''}${elo.toFixed(1)} Elo`);
console.log(`95% interval: ${(score - ci) * 100 >= 0 ? '+' : ''}${eloLow.toFixed(0)} .. +${eloHigh.toFixed(0)} Elo`);

const jsonPath = opt('json', null);
if (jsonPath)
  await writeFile(
    jsonPath,
    JSON.stringify({ engineA: ENGINE_A, optionsA: OPTS_A, engineB: ENGINE_B, optionsB: OPTS_B, movetime: MOVETIME, depth: DEPTH, wins, losses, draws, score, elo, games: results }, null, 2),
  );

process.exit(0);
