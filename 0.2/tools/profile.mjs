#!/usr/bin/env node
/**
 * Solace 0.2 — measure what a phone actually pays for.
 *
 *     node 0.2/tools/profile.mjs                       # auto variant
 *     node 0.2/tools/profile.mjs --variant simd
 *     node 0.2/tools/profile.mjs --bench 1
 *     node 0.2/tools/profile.mjs --engine-dir /tmp/old # profile another build
 *
 * Reports, for the real loader and the real build:
 *
 *   * startup: open + copy the network into the heap, parse, main() (the
 *     network is the big part),
 *   * memory: wasm heap size and process RSS right after startup,
 *   * throughput: nodes/second from `bench`,
 *   * bridge cost: time spent in send() for a command whose output is large.
 *
 * Node cannot tell you how a Snapdragon 4 will behave, but the ratios here
 * (heap used per megabyte of network, milliseconds per line of engine output)
 * carry over: they are properties of the build, not of the CPU.
 */

import { createEngine } from '../src/engine.js';
import { NET_NAME, engineFiles, pickVariant } from '../src/config.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// A different build directory makes before/after comparisons possible without
// swapping files around.
const engineDir = arg('engine-dir', process.env.SOLACE_ENGINE_DIR || join(ROOT, 'engine'));
let variant = pickVariant(arg('variant', 'auto'));
if (!existsSync(join(engineDir, engineFiles(variant).js))) variant = 'simd';
const files = engineFiles(variant);
const benchDepth = arg('bench', '1');

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ms = (n) => `${Math.round(n)} ms`;

const netPath = join(ROOT, 'assets', NET_NAME);
const netSize = existsSync(netPath) ? statSync(netPath).size : 0;

const { default: createModule } = await import(
  pathToFileURL(join(engineDir, files.js)).href
);

const lines = [];
const timings = {};
const t0 = performance.now();
const engine = await createEngine({
  timings,
  createModule,
  wasmUrl: pathToFileURL(join(engineDir, files.wasm)).href,
  netUrl: pathToFileURL(netPath).href,
  onLine: (line) => lines.push(line),
  onError: (m) => console.error(m),
});
const startup = performance.now() - t0;

const heap = typeof engine.heapSize === 'function' ? engine.heapSize() : null;
const rss = process.memoryUsage();

console.log(`Solace 0.2 — profile of the ${variant} build\n`);
console.log('startup');
console.log(`  network file          ${mb(netSize)}`);
console.log(`  total to first ready  ${ms(startup)}`);
if (timings.instantiate !== undefined) {
  console.log(`    instantiate wasm    ${ms(timings.instantiate)}`);
  // `fetch` is only the time to open the stream (headers / file handle), so on
  // a local file it is ~0 ms and the read shows up in the copy phase. In a
  // browser it is the network round trip, and the download lands in the copy.
  console.log(`    open net            ${ms(timings.fetch)}`);
  console.log(`    download+copy       ${ms(timings.netCopy)}`);
  console.log(`    parse net           ${ms(timings.netParse || 0)}`);
  console.log(`    main()              ${ms(timings.main)}`);
}
console.log('\nmemory');
if (timings.heapPeak) console.log(`  wasm heap at peak     ${mb(timings.heapPeak)}`);
if (heap) console.log(`  wasm heap after load  ${mb(heap)}`);
console.log(`  node RSS              ${mb(rss.rss)}`);
console.log(`  node external         ${mb(rss.external)}`);
// Peak RSS for the whole process: this is the number a phone's tab budget sees.
const maxRss = process.resourceUsage ? process.resourceUsage().maxRSS * 1024 : 0;
if (maxRss) console.log(`  peak RSS              ${mb(maxRss)}`);

const mark = lines.length;
const tBench = performance.now();
engine.send(`bench ${benchDepth}`);
const benchMs = performance.now() - tBench;
const out = lines.slice(mark).join('\n');
const nodes = Number(/Nodes searched\s*:\s*(\d+)/.exec(out)?.[1]);
const infoLines = lines.slice(mark).length;

console.log('\nthroughput');
console.log(`  bench ${benchDepth}                ${nodes} nodes in ${ms(benchMs)}`);
console.log(`  nodes/second          ${Math.round((nodes / benchMs) * 1000).toLocaleString('en-US')}`);

console.log('\nJS <-> wasm bridge');
console.log(`  output lines          ${infoLines}`);
console.log(`  per line              ${((benchMs / infoLines) * 1000).toFixed(0)} µs (includes the search itself)`);
engine.dispose();
process.exit(0);
