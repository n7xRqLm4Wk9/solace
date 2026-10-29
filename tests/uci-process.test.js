/**
 * tests/uci-process.test.js
 *
 * End-to-end UCI test: it starts ``node cli.js`` as a child process and talks
 * to it over stdin/stdout, exactly the way a chess GUI or Chess.fish would.
 * The other UCI tests call ``UciEngine.handleLine()`` in-process; this suite
 * additionally covers the transport (readline wiring, flushing, exit codes).
 *
 * Environment: needs to be able to spawn Node (anything that is not a browser).
 * Set SOLACE_NO_SPAWN=1 to skip this suite, e.g. in a restricted sandbox.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, assert, assertEqual } from './harness.js';
import { Position } from '../src/core/position.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const SKIP = process.env.SOLACE_NO_SPAWN === '1';

/** The UCI move pattern: from-square, to-square, optional promotion piece. */
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

class EngineProcess {
  constructor() {
    this.lines = [];
    this.cursor = 0;
    this.stderr = '';
    this.child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.lines.push(line));
    this.exit = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  send(command) {
    this.child.stdin.write(`${command}\n`);
  }

  /** Wait for the next line that satisfies ``predicate`` after the cursor. */
  async next(predicate, timeoutMs = 15000, label = 'line') {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = this.cursor; i < this.lines.length; i++) {
        if (predicate(this.lines[i])) {
          this.cursor = i + 1;
          return this.lines[i];
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const seen = this.lines.slice(this.cursor).join('\n') || '(no output)';
    throw new Error(`timed out waiting for ${label}; output was:\n${seen}`);
  }

  async bestmove(timeoutMs = 20000) {
    const line = await this.next((l) => l.startsWith('bestmove'), timeoutMs, 'bestmove');
    const tokens = line.split(/\s+/);
    return { move: tokens[1], ponder: tokens[3] ?? null, raw: line };
  }

  async handshake() {
    this.send('uci');
    await this.next((l) => l === 'uciok', 10000, 'uciok');
    this.send('isready');
    await this.next((l) => l === 'readyok', 10000, 'readyok');
  }

  async collectUntilBestmove() {
    const start = this.cursor;
    const { move } = await this.bestmove();
    return { move, lines: this.lines.slice(start, this.cursor) };
  }

  async waitForExit(timeoutMs = 10000) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), timeoutMs));
    return Promise.race([this.exit, timeout]);
  }

  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Run ``fn`` with a fresh engine process; always clean it up. */
async function withEngine(fn) {
  const engine = new EngineProcess();
  try {
    return await fn(engine);
  } finally {
    engine.kill();
  }
}

function skipOrRun(name, fn) {
  test(name, async () => {
    if (SKIP) {
      console.log(`      (skipped: SOLACE_NO_SPAWN=1) ${name}`);
      return;
    }
    await fn();
  });
}

skipOrRun('process: uci handshake over stdin/stdout', async () => {
  await withEngine(async (engine) => {
    engine.send('uci');
    await engine.next((l) => l === 'uciok');
    const ids = engine.lines.filter((l) => l.startsWith('id '));
    const options = engine.lines.filter((l) => l.startsWith('option name '));
    assert(ids.length >= 2, `id name and id author, got ${JSON.stringify(ids)}`);
    assert(ids.some((l) => l.includes('SOLACE')), 'engine identifies itself as SOLACE');
    assert(options.length >= 1, 'at least one option is announced');
    assert(options.some((l) => l.startsWith('option name Hash')), 'Hash option announced');
    engine.send('isready');
    await engine.next((l) => l === 'readyok');
  });
});

skipOrRun('process: position startpos and a legal bestmove', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('position startpos');
    engine.send('go depth 4');
    const { move } = await engine.bestmove();
    assert(UCI_MOVE.test(move), `bestmove looks like a UCI move, got ${move}`);
    const position = new Position().setStartPosition();
    assert(position.parseMove(move) !== 0, `${move} is legal in the start position`);
  });
});

skipOrRun('process: position fen with a move sequence', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    // Kiwipete after 1.e4: the engine must answer for the right side to move.
    engine.send('position fen r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1 moves e1g1');
    engine.send('go depth 3');
    const { move } = await engine.bestmove();
    const position = new Position().setFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    position.makeMove(position.parseMove('e1g1'));
    assert(position.parseMove(move) !== 0, `${move} is legal after the supplied move`);
  });
});

skipOrRun('process: promotion is returned in UCI form', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('position fen 8/4P3/8/8/8/8/k7/4K3 w - - 0 1');
    engine.send('go depth 5');
    const { move } = await engine.bestmove();
    assertEqual(move, 'e7e8q', 'the engine promotes to a queen here');
  });
});

skipOrRun('process: stop ends an infinite search', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('position startpos');
    engine.send('go infinite');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEqual(engine.lines.filter((l) => l.startsWith('bestmove')).length, 0, 'nothing before stop');
    const started = Date.now();
    engine.send('stop');
    const { move } = await engine.bestmove();
    const elapsed = Date.now() - started;
    assert(UCI_MOVE.test(move), `bestmove after stop, got ${move}`);
    assert(elapsed < 1000, `stop answered within a second (${elapsed} ms)`);
    assertEqual(engine.lines.filter((l) => l.startsWith('bestmove')).length, 1, 'exactly one bestmove');
  });
});

skipOrRun('process: no legal moves is reported as bestmove 0000', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('position fen 7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'); // checkmate
    engine.send('go depth 2');
    const { move } = await engine.bestmove();
    assertEqual(move, '0000', 'a mated position yields bestmove 0000');

    engine.send('position fen 7k/5Q2/8/8/8/8/8/6K1 b - - 0 1'); // stalemate
    engine.send('go depth 2');
    const second = await engine.bestmove();
    assertEqual(second.move, '0000', 'a stalemate yields bestmove 0000');
  });
});

skipOrRun('process: movetime is respected', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('position startpos moves d2d4 d7d5 c2c4');
    const started = Date.now();
    engine.send('go movetime 200');
    await engine.bestmove();
    const elapsed = Date.now() - started;
    assert(elapsed >= 120, `thought for at least ~200 ms (${elapsed} ms)`);
    assert(elapsed < 900, `did not overshoot badly (${elapsed} ms)`);
  });
});

skipOrRun('process: ucinewgame and pipelined commands', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    // A GUI may pipeline position/go without waiting: this must work.
    engine.send('ucinewgame');
    engine.send('position startpos moves e2e4 e7e5');
    engine.send('go depth 3');
    const first = await engine.bestmove();
    assert(UCI_MOVE.test(first.move), `pipelined search answered (${first.move})`);

    engine.send('ucinewgame');
    engine.send('position startpos');
    engine.send('go depth 3');
    const second = await engine.bestmove();
    assert(UCI_MOVE.test(second.move), `second game answered (${second.move})`);
  });
});

skipOrRun('process: quit exits cleanly, with and without a search', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('quit');
    const exit = await engine.waitForExit();
    assertEqual(exit.code, 0, `clean exit code, got ${JSON.stringify(exit)}`);
  });

  await withEngine(async (engine) => {
    await engine.handshake();
    engine.send('position startpos');
    engine.send('go infinite');
    await new Promise((resolve) => setTimeout(resolve, 150));
    engine.send('quit');
    const exit = await engine.waitForExit();
    assertEqual(exit.code, 0, `clean exit during a search, got ${JSON.stringify(exit)}`);
  });
});

skipOrRun('process: 40 engine moves are all legal and end properly', async () => {
  await withEngine(async (engine) => {
    await engine.handshake();
    const position = new Position().setStartPosition();
    let plies = 0;
    for (; plies < 40; plies++) {
      engine.send(`position fen ${position.toFen()}`);
      engine.send('go depth 3');
      const { move } = await engine.bestmove();
      if (move === '0000') break;
      const parsed = position.parseMove(move);
      assert(parsed !== 0, `${move} is legal in ${position.toFen()}`);
      position.makeMove(parsed);
    }
    assert(plies >= 10, `played a reasonable number of plies (${plies})`);
  });
});
