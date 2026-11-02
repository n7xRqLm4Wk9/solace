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
import { NET_NAME, engineFiles, pickVariant } from './src/config.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NET = join(HERE, 'assets', NET_NAME);

// Prefer the relaxed-SIMD build when this runtime supports it and it exists.
let variant = pickVariant(process.env.SOLACE_VARIANT || 'auto');
let files = engineFiles(variant);
if (!existsSync(join(HERE, 'engine', files.js))) {
  variant = 'simd';
  files = engineFiles(variant);
}
const { default: createModule } = await import(pathToFileURL(join(HERE, 'engine', files.js)).href);

const engine = await createEngine({
  createModule,
  wasmUrl: pathToFileURL(join(HERE, 'engine', files.wasm)).href,
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
