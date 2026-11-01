#!/usr/bin/env node
/**
 * Solace 0.2 — test suite for the WebAssembly engine.
 *
 *     node 0.2/tests/run.mjs              # everything
 *     node 0.2/tests/run.mjs uci perft    # only tests whose name matches
 *
 * The tests drive the real wasm build through the same loader the browser
 * uses (src/engine.js) and check what the engine prints. Move legality is
 * verified with the independent pure-JavaScript board model from 0.1.5, so a
 * wrong bestmove cannot slip through.
 */

import { createEngine } from '../src/engine.js';
import { NET_NAME, ENGINE_NAME } from '../src/config.js';
import { createPosition } from '../../0.1.5/src/core/position.js';
import { MoveList, moveToUci } from '../../0.1.5/src/core/moves.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const tests = [];
const only = process.argv.slice(2);
const test = (name, fn) => tests.push({ name, fn });

let failures = 0;
let passes = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// engine harness
// ---------------------------------------------------------------------------

let engine;
let lines = [];
const listeners = new Set();

function send(cmd) {
  engine.send(cmd);
}

async function waitFor(pattern, timeoutMs = 180000) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const current = lines;
  for (const line of current) if (re.test(line)) return line;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`timeout waiting for ${re} (last line: ${lines.at(-1) || 'none'})`));
    }, timeoutMs);
    const listener = (line) => {
      if (re.test(line)) {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(line);
      }
    };
    listeners.add(listener);
  });
}

async function command(cmd, expect) {
  const pending = waitFor(expect);
  send(cmd);
  return pending;
}

async function bestmove(go, timeoutMs) {
  const pending = waitFor(/^bestmove/, timeoutMs);
  send(go);
  const line = await pending;
  return line.split(/\s+/)[1];
}

function legalMovesFor(fen) {
  const pos = createPosition(fen);
  const list = new MoveList(256);
  pos.generateLegalMoves(list);
  const moves = [];
  for (let i = 0; i < list.count; i++) moves.push(moveToUci(list.moves[i]));
  return moves;
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('handshake: id name is Solace 0.2', async () => {
  send('uci');
  const id = await waitFor(/^id name /);
  await waitFor(/^uciok/);
  check(id === `id name ${ENGINE_NAME}`, `unexpected id line: ${id}`);
});

test('handshake: uci exposes the standard options', async () => {
  send('uci');
  await waitFor(/^uciok/);
  const text = lines.join('\n');
  for (const option of ['Threads', 'Hash', 'MultiPV', 'Skill Level', 'UCI_LimitStrength', 'UCI_Elo', 'EvalFile'])
    check(text.includes(`option name ${option} `), `missing option ${option}`);
});

test('isready answers readyok', async () => {
  await command('isready', /^readyok/);
});

test('position + go depth returns a legal move', async () => {
  send('position startpos');
  const move = await bestmove('go depth 10');
  const legal = legalMovesFor(START);
  check(legal.includes(move), `illegal bestmove ${move}`);
});

test('go prints increasing depth and a score', async () => {
  lines = [];
  send('ucinewgame');
  send('position startpos');
  const move = await bestmove('go depth 10');
  check(move, 'no bestmove');
  const depths = lines
    .filter((l) => /^info .*\bdepth \d+/.test(l))
    .map((l) => Number(/depth (\d+)/.exec(l)[1]));
  check(depths.length > 0, 'no info lines with depth');
  check(Math.max(...depths) >= 8, `max depth ${Math.max(...depths)} was below 8`);
  check(lines.some((l) => /score cp|score mate/.test(l)), 'no score reported');
});

test('perft matches known node counts', async () => {
  const cases = [
    [START, 1, 20],
    [START, 2, 400],
    [START, 3, 8902],
    [KIWIPETE, 2, 2039],
    [KIWIPETE, 3, 97862],
  ];
  for (const [fen, depth, expected] of cases) {
    lines = [];
    const done = waitFor(/^Nodes searched: \d+/);
    send(`position fen ${fen}`);
    send(`go perft ${depth}`);
    const line = await done;
    const nodes = Number(/Nodes searched: (\d+)/.exec(line)[1]);
    check(nodes === expected, `perft ${depth} on ${fen} gave ${nodes}, expected ${expected}`);
  }
});

test('stop interrupts an infinite search', async () => {
  lines = [];
  send('position startpos');
  const pending = waitFor(/^bestmove/, 10000);
  send('go infinite');
  await waitFor(/^info .*\bdepth \d+/, 20000);
  send('stop');
  const line = await pending;
  check(/^bestmove [a-h][1-8][a-h][1-8]/.test(line), `unexpected bestmove line: ${line}`);
});

test('movetime is respected within a sane margin', async () => {
  lines = [];
  send('position startpos');
  const started = Date.now();
  await bestmove('go movetime 300', 20000);
  const elapsed = Date.now() - started;
  check(elapsed >= 250, `search returned after ${elapsed} ms, expected >= 250 ms`);
  check(elapsed < 5000, `search took ${elapsed} ms, far longer than movetime 300`);
});

test('MultiPV produces several principal variations', async () => {
  lines = [];
  send('setoption name MultiPV value 3');
  await command('isready', /^readyok/);
  send('position startpos');
  await bestmove('go depth 9');
  const multipv = new Set(
    lines
      .filter((l) => l.includes(' multipv '))
      .map((l) => /multipv (\d+)/.exec(l)[1]),
  );
  for (const n of ['1', '2', '3']) check(multipv.has(n), `missing multipv ${n}`);
  send('setoption name MultiPV value 1');
  await command('isready', /^readyok/);
});

test('Threads and Hash options can be changed', async () => {
  send('setoption name Threads value 2');
  send('setoption name Hash value 32');
  await command('isready', /^readyok/);
  send('position startpos');
  const move = await bestmove('go depth 10');
  check(legalMovesFor(START).includes(move), `illegal bestmove ${move} with 2 threads`);
  send('setoption name Threads value 1');
  await command('isready', /^readyok/);
});

test('Skill Level limits the engine and stays legal', async () => {
  send('setoption name Skill Level value 0');
  await command('isready', /^readyok/);
  send('position startpos');
  const move = await bestmove('go movetime 200');
  check(legalMovesFor(START).includes(move), `illegal bestmove ${move} at Skill 0`);
  send('setoption name Skill Level value 20');
  await command('isready', /^readyok/);
});

test('chess rules: mate in one is found', async () => {
  // Black king on g8 boxed in by its own pawns; Ra8 is mate in one.
  const fen = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
  send(`position fen ${fen}`);
  const move = await bestmove('go depth 8');
  check(legalMovesFor(fen).includes(move), `illegal bestmove ${move}`);
  const mate = lines.some((l) => /score mate 1/.test(l));
  check(mate, `engine did not report mate 1 (lines: ${lines.slice(-4).join(' | ')})`);
});

test('debug commands d and eval work', async () => {
  lines = [];
  send('position startpos');
  const fenLine = waitFor(/Fen: /);
  send('d');
  await fenLine;
  lines = [];
  const evalLine = waitFor(/Final evaluation/);
  send('eval');
  await evalLine;
});

test('benchmark runs and reports a node count', async () => {
  lines = [];
  const done = waitFor(/Nodes searched\s*:/, 300000);
  send('bench 1');
  const line = await done;
  check(/\d{4,}/.test(line), `unexpected bench line: ${line}`);
});

test('self-play stays legal for 16 plies', async () => {
  const pos = createPosition(START);
  const moves = [];
  for (let ply = 0; ply < 16; ply++) {
    const legal = legalMovesFor(pos.toFen());
    send(`position startpos${moves.length ? ' moves ' + moves.join(' ') : ''}`);
    const move = await bestmove('go depth 8');
    check(legal.includes(move), `ply ${ply}: engine played ${move}, not in legal moves (${legal.slice(0, 5)}…)`);
    moves.push(move);
    const list = new MoveList(256);
    pos.generateLegalMoves(list);
    let applied = false;
    for (let i = 0; i < list.count; i++) {
      if (moveToUci(list.moves[i]) === move) {
        pos.makeMove(list.moves[i]);
        applied = true;
        break;
      }
    }
    check(applied, `ply ${ply}: could not apply ${move}`);
  }
});

test('loader rejects a missing network with a clear error', async () => {
  const { default: createModule } = await import(pathToFileURL(join(ROOT, 'dist', 'solace.js')).href);
  let failed = false;
  try {
    await createEngine({
      createModule,
      wasmUrl: pathToFileURL(join(ROOT, 'dist', 'solace.wasm')).href,
      netUrl: pathToFileURL(join(ROOT, 'assets', 'does-not-exist.nnue')).href,
    });
  } catch (err) {
    failed = /cannot load/.test(err.message);
  }
  check(failed, 'loading a missing network should fail with a "cannot load" error');
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const selected = only.length ? tests.filter((t) => only.some((o) => t.name.includes(o))) : tests;

console.log(`Solace 0.2 — ${selected.length} tests\n`);

const { default: createModule } = await import(pathToFileURL(join(ROOT, 'dist', 'solace.js')).href);
engine = await createEngine({
  createModule,
  wasmUrl: pathToFileURL(join(ROOT, 'dist', 'solace.wasm')).href,
  netUrl: pathToFileURL(join(ROOT, 'assets', NET_NAME)).href,
  onLine: (line) => {
    lines.push(line);
    for (const listener of [...listeners]) listener(line);
  },
});

for (const { name, fn } of selected) {
  lines = [];
  const started = Date.now();
  try {
    await fn();
    passes++;
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
