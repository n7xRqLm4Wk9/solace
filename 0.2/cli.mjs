#!/usr/bin/env node
/**
 * Solace 0.2 — UCI command line front end for the WebAssembly engine.
 *
 *     node 0.2/cli.mjs            # reads UCI commands from stdin
 *     node 0.2/cli.mjs bench      # any single command can be passed as arguments
 *
 * This is a thin pipe: the engine inside the wasm module is the real UCI
 * implementation, so every command behaves exactly as it does in the browser.
 */

import { createEngine } from './src/engine.js';
import { NET_NAME } from './src/config.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist', 'solace.js');
const WASM = join(HERE, 'dist', 'solace.wasm');
const NET = join(HERE, 'assets', NET_NAME);

const { default: createModule } = await import(DIST);
const { pathToFileURL } = await import('node:url');

const engine = await createEngine({
  createModule,
  wasmUrl: pathToFileURL(WASM).href,
  netUrl: pathToFileURL(NET).href,
  onLine: (line) => process.stdout.write(`${line}\n`),
  onError: (message) => process.stderr.write(`${message}\n`),
});

const args = process.argv.slice(2);
if (args.length) {
  engine.send(args.join(' '));
  engine.send('quit');
  // let the engine flush its output
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  engine.send(line);
  if (line.trim() === 'quit') {
    rl.close();
    setTimeout(() => process.exit(0), 50);
  }
});
rl.on('close', () => {
  engine.send('quit');
  setTimeout(() => process.exit(0), 50);
});
