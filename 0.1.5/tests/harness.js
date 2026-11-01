/**
 * tests/harness.js
 *
 * A tiny dependency-free test harness: ``test(name, fn)`` registers a test,
 * ``run()`` executes them all and reports pass/fail with timings.
 */

const registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition, message = 'assertion failed') {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new AssertionError(`${message}${message ? ': ' : ''}expected ${format(expected)}, got ${format(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(`${message}${message ? ': ' : ''}expected ${b}, got ${a}`);
  }
}

export function assertThrows(fn, message = 'expected function to throw') {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
  }
  if (!threw) throw new AssertionError(message);
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

/** Run every registered test. Returns { passed, failed, failures }. */
export async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  for (const entry of registry) {
    const testStart = Date.now();
    try {
      await entry.fn();
      passed++;
      const ms = Date.now() - testStart;
      console.log(`  ✓ ${entry.name}${ms > 40 ? ` (${ms} ms)` : ''}`);
    } catch (err) {
      failures.push({ name: entry.name, error: err });
      console.log(`  ✗ ${entry.name}`);
      console.log(`      ${err.name === 'AssertionError' ? err.message : err.stack.split('\n').slice(0, 4).join('\n      ')}`);
    }
  }

  const elapsed = Date.now() - started;
  console.log('');
  console.log(`${passed} passed, ${failures.length} failed (${elapsed} ms)`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  }
  return { passed, failed: failures.length, failures, elapsed };
}

export const summary = { total: () => registry.length };
export default { test, run };
