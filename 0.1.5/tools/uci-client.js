#!/usr/bin/env node
/**
 * tools/uci-client.js
 *
 * A minimal, self-contained example of driving SOLACE over UCI as a child
 * process.  It is deliberately short so it can be copied into another project
 * (for example a Chess.fish adapter) as a starting point.
 *
 *   node tools/uci-client.js                      # one move from the start position
 *   node tools/uci-client.js --fen "<FEN>" --movetime 500
 *   node tools/uci-client.js --engine "node cli.js" --depth 6
 *
 * It prints every line the engine sends, so the wire format is visible.
 * This is a *client*; it is not used by the engine itself.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const key = args[i].slice(2);
  const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
  flags[key] = value;
}

const engineCommand = flags.engine ?? `${process.execPath} cli.js`;
const startFen = flags.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const moveList = flags.moves ? String(flags.moves).trim().split(/\s+/) : [];
const goCommand = flags.movetime
  ? `go movetime ${Number(flags.movetime)}`
  : `go depth ${Number(flags.depth ?? 5)}`;

/**
 * Talk UCI to any engine process.
 * @param {string} command shell command that starts the engine
 * @param {(line: string) => void} onLine called for every output line
 * @returns {Promise<{send: (line: string) => void, bestmove: () => Promise<string>, quit: () => Promise<void>}>}
 */
export function connect(command, onLine = () => {}) {
  const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const queue = [];
  const waiters = [];

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    onLine(line);
    const waiterIndex = waiters.findIndex((w) => w.predicate(line));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(line);
    } else {
      queue.push(line);
    }
  });

  const nextLine = (predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const queuedIndex = queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      resolve(queue.splice(queuedIndex, 1)[0]);
      return;
    }
    const waiter = { predicate };
    // Clear the watchdog when the line arrives, otherwise the pending timer
    // would keep the Node process alive for the whole timeout.
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error('timed out waiting for engine output'));
    }, timeoutMs);
    timer.unref?.();
    waiter.resolve = (line) => {
      clearTimeout(timer);
      resolve(line);
    };
    waiters.push(waiter);
  });

  const send = (line) => child.stdin.write(`${line}\n`);
  const bestmove = async () => {
    const line = await nextLine((l) => l.startsWith('bestmove'));
    return line.split(/\s+/)[1];
  };
  const quit = async () => {
    send('quit');
    await new Promise((resolve) => child.on('exit', resolve));
  };
  return Promise.resolve({ send, bestmove, quit, nextLine });
}

// Only run the demo when executed directly.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const engine = await connect(engineCommand, (line) => {
    if (!line.startsWith('info depth') || flags.verbose) console.log(`< ${line}`);
  });
  engine.send('uci');
  await engine.nextLine((l) => l === 'uciok');
  engine.send('isready');
  await engine.nextLine((l) => l === 'readyok');

  const moves = moveList.length ? ` moves ${moveList.join(' ')}` : '';
  engine.send(`position fen ${startFen}${moves}`);
  const started = Date.now();
  engine.send(goCommand);
  const move = await engine.bestmove();
  console.log(`bestmove ${move} (${Date.now() - started} ms)`);
  await engine.quit();
}
