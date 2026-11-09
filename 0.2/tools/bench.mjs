#!/usr/bin/env node
/**
 * Solace 0.2 — throughput benchmark for the WebAssembly build.
 *
 *     node 0.2/tools/bench.mjs                      # auto variant, bench 1
 *     node 0.2/tools/bench.mjs --variant simd --repeat 3
 *     node 0.2/tools/bench.mjs --variant relaxed --bench 2
 *
 * `bench` runs a fixed suite of positions at a fixed depth, so the node count
 * must be identical for every build of the same engine — that is the parity
 * check — while the time it takes measures how fast this runtime compiles and
 * executes that engine. Nodes per second is therefore the number to compare
 * when judging build flags; it is not an Elo measurement.
 */

import { createEngine } from '../src/engine.js';
import { NET_NAME, engineFiles, pickVariant } from '../src/config.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const wanted = arg('variant', process.env.SOLACE_VARIANT || 'auto');
const benchCount = Number(arg('bench', '1'));
const repeat = Number(arg('repeat', '1'));

let variant = pickVariant(wanted);
if (!existsSync(join(ROOT, 'engine', engineFiles(variant).js))) {
  console.error(`no build for variant "${variant}" in engine/ — falling back to simd`);
  variant = 'simd';
}
const files = engineFiles(variant);
if (!existsSync(join(ROOT, 'engine', files.js))) {
  console.error(`engine/${files.js} is missing: run ./scripts/build.sh first`);
  process.exit(1);
}

const { default: createModule } = await import(
  pathToFileURL(join(ROOT, 'engine', files.js)).href
);

const lines = [];
const engine = await createEngine({
  createModule,
  wasmUrl: pathToFileURL(join(ROOT, 'engine', files.wasm)).href,
  netUrl: pathToFileURL(join(ROOT, 'assets', NET_NAME)).href,
  onLine: (line) => lines.push(line),
  onError: (message) => console.error(message),
});

console.log(`Solace 0.2 — bench ${benchCount} on the ${variant} build\n`);

const runs = [];
for (let i = 0; i < repeat; i++) {
  const mark = lines.length;
  engine.send(`bench ${benchCount}`);
  const out = lines.slice(mark).join('\n');

  const nodes = Number(/Nodes searched\s*:\s*(\d+)/.exec(out)?.[1]);
  const ms = Number(/Total time \(ms\)\s*:\s*(\d+)/.exec(out)?.[1]);
  const nps = Number(/Nodes\/second\s*:\s*(\d+)/.exec(out)?.[1]) || Math.round((nodes / ms) * 1000);

  if (!nodes || !ms) {
    console.error('bench printed no node count — the engine is not working');
    process.exit(1);
  }
  runs.push({ nodes, ms, nps });
  console.log(`  run ${i + 1}: ${nodes} nodes in ${ms} ms  =>  ${nps.toLocaleString('en-US')} nps`);
}

const unique = [...new Set(runs.map((r) => r.nodes))];
const best = Math.max(...runs.map((r) => r.nps));
console.log(`\n  best: ${best.toLocaleString('en-US')} nps`);
if (unique.length > 1) {
  console.error(`  node count differs between runs (${unique.join(', ')}) — the search is not deterministic`);
  process.exit(1);
}
console.log(`  node parity: ${unique[0]} nodes, identical in every run`);
engine.dispose();
process.exit(0);
