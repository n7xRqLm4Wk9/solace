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

test('unknown commands are ignored silently, as UCI requires', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('frobnicate');
  engine.handleLine('register later');
  engine.handleLine('setoption name Ponder value false');
  engine.handleLine('   ');
  engine.handleLine('');
  assert(lines.length === 0, `no output for unknown commands, got ${JSON.stringify(lines)}`);
  // The engine keeps working afterwards.
  engine.handleLine('isready');
  assertEqual(lines[lines.length - 1], 'readyok');
});

test('debug on makes ignored commands and the position visible', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('debug on');
  engine.handleLine('frobnicate');
  engine.handleLine('position startpos moves e2e4');
  assert(lines.some((l) => l.includes('unknown command')), 'unknown command reported in debug mode');
  assert(
    lines.some((l) => l.includes('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')),
    'position echoed in debug mode',
  );
  engine.handleLine('debug off');
  const before = lines.length;
  engine.handleLine('position startpos');
  assertEqual(lines.length, before, 'position is not echoed with debug off');
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

test('searchmoves restricts the searched root moves', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go depth 4 searchmoves a2a3');
  await waitForSearchEnd(engine);
  assertEqual(lastBestMove(lines), 'a2a3', 'only the requested move can be played');

  const second = makeEngine();
  second.engine.handleLine('position startpos');
  second.engine.handleLine('go depth 3 searchmoves a2a3 h2h3');
  await waitForSearchEnd(second.engine);
  assert(
    ['a2a3', 'h2h3'].includes(lastBestMove(second.lines)),
    `the answer is one of the listed moves, got ${lastBestMove(second.lines)}`,
  );
});

test('searchmoves with only illegal moves falls back to a full search', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go depth 3 searchmoves e2e5 a7a6');
  await waitForSearchEnd(engine);
  const best = lastBestMove(lines);
  const position = new Position().setStartPosition();
  assert(best && position.parseMove(best) !== 0, `a legal move is returned, got ${best}`);
});

test('searchmoves accepts a promotion move', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position fen 8/4P3/8/8/8/8/k7/4K3 w - - 0 1');
  engine.handleLine('go depth 3 searchmoves e7e8n');
  await waitForSearchEnd(engine);
  assertEqual(lastBestMove(lines), 'e7e8n', 'underpromotion honoured');
});

test('go without limits searches until stop', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(engine.searching, 'a limit-less go keeps searching');
  assertEqual(lines.filter((l) => l.startsWith('bestmove')).length, 0, 'no bestmove before stop');
  engine.handleLine('stop');
  await waitForSearchEnd(engine);
  const best = lastBestMove(lines);
  const position = new Position().setStartPosition();
  assert(best && position.parseMove(best) !== 0, `bestmove after stop is legal, got ${best}`);
});

test('promotions in a position move list are applied correctly', () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('debug on');
  engine.handleLine('position fen 8/4P3/8/8/8/8/k7/4K3 w - - 0 1 moves e7e8q');
  const echo = lines.find((l) => l.startsWith('info string position set'));
  assert(echo && echo.includes('4Q3'), `queen appears on e8: ${echo}`);
  engine.handleLine('position fen 8/4P3/8/8/8/8/k7/4K3 w - - 0 1 moves e7e8n');
  const knightEcho = lines.filter((l) => l.startsWith('info string position set')).pop();
  assert(knightEcho && knightEcho.includes('4N3'), `knight appears on e8: ${knightEcho}`);
});

test('stop before the first iteration still returns a legal move', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go infinite');
  engine.handleLine('stop');
  await waitForSearchEnd(engine);
  const best = lastBestMove(lines);
  const position = new Position().setStartPosition();
  assert(best && position.parseMove(best) !== 0, `legal move even without a finished iteration, got ${best}`);
});

test('a stopped search never reports a move twice', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go infinite');
  await new Promise((resolve) => setTimeout(resolve, 60));
  engine.handleLine('stop');
  engine.handleLine('stop');
  await waitForSearchEnd(engine);
  assertEqual(lines.filter((l) => l.startsWith('bestmove')).length, 1, 'exactly one bestmove');
});

test('go nodes stops at the node limit', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos');
  engine.handleLine('go nodes 2000');
  await waitForSearchEnd(engine);
  const lastInfo = lines.filter((l) => l.startsWith('info depth')).pop();
  const nodes = Number((lastInfo ?? '').match(/nodes (\d+)/)?.[1] ?? NaN);
  assert(Number.isFinite(nodes) && nodes <= 4000, `stopped near the node limit (${nodes} nodes)`);
  assert(lastBestMove(lines) !== null, 'bestmove emitted');
});

test('ponderhit turns a ponder search into a normal answer', async () => {
  const { engine, lines } = makeEngine();
  engine.handleLine('position startpos moves e2e4');
  engine.handleLine('go ponder wtime 5000 btime 5000');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assertEqual(lines.filter((l) => l.startsWith('bestmove')).length, 0, 'no move while pondering');
  engine.handleLine('ponderhit');
  await waitForSearchEnd(engine);
  const best = lastBestMove(lines);
  const position = new Position().setStartPosition();
  position.makeMove(position.parseMove('e2e4'));
  assert(best && position.parseMove(best) !== 0, `legal reply after ponderhit, got ${best}`);
  assertEqual(lines.filter((l) => l.startsWith('bestmove')).length, 1, 'exactly one bestmove');
});
