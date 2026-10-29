/**
 * tests/uci.test.js
 *
 * Drives the UCI layer the way a GUI would: every command is fed as a line and
 * the emitted output lines are inspected.
 */

import { test, assert, assertEqual } from './harness.js';
import { UciEngine } from '../src/uci/uci.js';
import { Position } from '../src/core/position.js';


function makeEngine() {
  const lines = [];
  const engine = new UciEngine({ output: (line) => lines.push(line) });
  return { engine, lines };
}

function waitForSearchEnd(engine, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (!engine.searching) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('search did not finish in time'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function lastBestMove(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('bestmove')) return lines[i].split(/\s+/)[1];
  }
  return null;
}

test('uci handshake announces the engine and its options', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('uci');
  assert(lines.some((l) => l.startsWith('id name SOLACE')), 'id name line');
  assert(lines.some((l) => l.startsWith('id author ')), 'id author line');
  assert(lines.some((l) => l.startsWith('option name Hash type spin')), 'Hash option');
  assert(lines.some((l) => l.startsWith('option name VerifyMoves type check')), 'VerifyMoves option');
  assertEqual(lines[lines.length - 1], 'uciok');
});

test('isready is answered with readyok', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('isready');
  assertEqual(lines[0], 'readyok');
});

test('setoption changes the hash size and rejects nonsense', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('setoption name Hash value 32');
  assertEqual(engine.searcher.tt.sizeMB, 32, 'hash resized');
  engine.handleLine('setoption name Hash value 9999');
  assert(lines.some((l) => l.includes('between 1 and 512')), 'out-of-range value reported');
  engine.handleLine('setoption name VerifyMoves value true');
  assertEqual(engine.searcher.verifyMoves, true, 'verify moves enabled');
});

test('position startpos followed by go depth plays a legal move', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go depth 3');
  await waitForSearchEnd(engine);
  const best = lastBestMove(lines);
  assert(best && best !== '0000', `got a bestmove (${best})`);
  const position = new Position().setStartPosition();
  assert(position.parseMove(best) !== 0, 'bestmove is legal in the start position');
  assert(lines.some((l) => l.startsWith('info depth 3')), 'reported info for depth 3');
});

test('go with a clock allocation answers in time', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos moves e2e4 e7e5');
  const started = Date.now();
  engine.handleLine('go wtime 1000 btime 1000 winc 0 binc 0');
  await waitForSearchEnd(engine);
  const elapsed = Date.now() - started;
  assert(elapsed < 900, `should move quickly with 1 s on the clock (took ${elapsed} ms)`);
  assert(lastBestMove(lines) !== null, 'bestmove emitted');
});

test('go movetime respects the requested thinking time', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos moves d2d4 d7d5 c2c4');
  const started = Date.now();
  engine.handleLine('go movetime 200');
  await waitForSearchEnd(engine, 5000);
  const elapsed = Date.now() - started;
  assert(elapsed >= 100, `should actually think for a while (took ${elapsed} ms)`);
  assert(elapsed < 600, `must not overshoot the 200 ms budget by much (took ${elapsed} ms)`);
  assert(lastBestMove(lines) !== null, 'bestmove emitted');
});

test('a new position during a search ends that search with a bestmove', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go infinite');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(engine.searching, 'engine is searching');
  engine.handleLine('position fen 4k3/8/8/8/8/8/8/4K2R w - - 0 1');
  assert(!engine.searching, 'the old search was cancelled');
  assert(lastBestMove(lines) !== null, 'the cancelled search still reported a bestmove');
  engine.handleLine('quit');
});

test('quit reports a bestmove for a search in progress', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go infinite');
  await new Promise((resolve) => setTimeout(resolve, 40));
  engine.handleLine('quit');
  assert(!engine.searching, 'search state cleared');
  assert(lastBestMove(lines) !== null, 'bestmove emitted before quitting');
});

test('stop during an infinite search produces a bestmove promptly', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go infinite');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(engine.searching, 'engine is still searching');
  engine.handleLine('stop');
  await waitForSearchEnd(engine);
  const best = lastBestMove(lines);
  assert(best && best !== '0000', 'bestmove after stop');
});

test('position fen with moves is applied', () => {
  const { engine } = makeEngine();
  engine.handleLine('position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves e1g1');
  assertEqual(engine.position.toFen(), 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
});

test('invalid FEN and illegal moves are reported without crashing', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position fen not-a-fen');
  assert(lines.some((l) => l.includes('invalid FEN')), 'invalid FEN reported');
  engine.handleLine('position startpos moves e2e5');
  assert(lines.some((l) => l.includes('illegal move')), 'illegal move reported');
});

test('perft command reports the right totals', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('perft 3');
  assert(lines.some((l) => l.includes('perft(3) = 8902')), 'perft 3 total');
  assert(lines.some((l) => l.includes('e2e4: 600')), 'perft divide row for e2e4');
});

test('board display and eval commands work', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('d');
  assert(lines.some((l) => l.includes('position: rnbqkbnr')), 'board FEN shown');
  engine.handleLine('eval');
  assert(lines.some((l) => l.includes('static evaluation')), 'eval shown');
});

test('unknown commands do not crash the engine', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('frobnicate');
  assert(lines.some((l) => l.includes('unknown command')), 'unknown command reported');
  engine.handleLine('   ');
  engine.handleLine('');
  assert(true);
});

test('quit stops the search and asks the caller to exit', async () => {
  const { engine } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go infinite');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const keepRunning = engine.handleLine('quit');
  assertEqual(keepRunning, false, 'quit returns false');
  assert(!engine.searching, 'search state cleared');
});

test('ucinewgame resets the position', () => {
  const { engine } = makeEngine();
  engine.handleLine('position startpos moves e2e4 e7e5');
  engine.handleLine('ucinewgame');
  assertEqual(engine.position.toFen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});
