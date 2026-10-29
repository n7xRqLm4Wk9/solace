#!/usr/bin/env node
/**
 * tests/run.js
 *
 * Runs the whole SOLACE test-suite.  No dependencies, no test framework: it is
 * plain Node so it also works in Termux on Android.
 *
 * Usage:
 *   node tests/run.js               # run everything
 *   node tests/run.js movegen       # only files whose name matches
 */

import { pathToFileURL } from 'node:url';
import { run } from './harness.js';

const suites = [
  ['movegen', './movegen.test.js'],
  ['fen', './fen.test.js'],
  ['eval', './eval.test.js'],
  ['draw', './draw.test.js'],
  ['search', './search.test.js'],
  ['uci', './uci.test.js'],
  ['uci-process', './uci-process.test.js'],
  ['tools', './tools.test.js'],
  ['web', './web.test.js'],
];

/**
 * Import the matching suites and run every registered test.
 * @param {string} [filter] only run suites whose name contains this string
 * @returns {Promise<{passed: number, failed: number}>}
 */
export async function runSuites(filter) {
  const started = Date.now();
  for (const [name, path] of suites) {
    if (filter && !name.includes(filter)) continue;
    console.log(`\n== ${name} ==`);
    try {
      await import(path);
    } catch (err) {
      console.log(`  ✗ suite ${name} failed to load: ${err.message}`);
      process.exitCode = 1;
    }
  }
  const result = await run();
  console.log(`suite time: ${Date.now() - started} ms`);
  if (result.failed > 0) process.exitCode = 1;
  return result;
}

// When executed directly (`node tests/run.js [filter]`) run immediately; when
// imported (by cli.js) the caller decides which suites to run.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await runSuites(process.argv[2]);
