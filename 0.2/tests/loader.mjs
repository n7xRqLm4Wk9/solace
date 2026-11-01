#!/usr/bin/env node
/**
 * Solace 0.2 — unit tests for the JavaScript loader (src/engine.js).
 *
 * These run without WebAssembly: a stub stands in for the Emscripten module and
 * records what the loader does with it. They pin down the contract the page and
 * the tests rely on — the network is in place *before* main() runs, commands are
 * copied into wasm memory correctly, and free() is always called.
 *
 *     node 0.2/tests/loader.mjs
 */

import { strict as assert } from 'node:assert';
import { createEngine } from '../src/engine.js';
import { parseInfo } from '../src/client.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const NET = new Uint8Array([1, 2, 3, 4, 5]);

/** Minimal stand-in for the Emscripten module factory. */
function stubFactory(log, { ready = 1 } = {}) {
  return async (config) => {
    log.push('factory');
    config.print('Solace 0.2 64 POPCNT by the Stockfish developers\n');
    const memory = new Map();
    return {
      FS: {
        writeFile: (name, bytes) => {
          log.push(`writeFile:${name}:${bytes.length}`);
          memory.set(name, bytes);
        },
        unlink: (name) => {
          log.push(`unlink:${name}`);
          memory.delete(name);
        },
      },
      callMain: () => {
        log.push(`callMain:${memory.size > 0 ? 'net-present' : 'net-missing'}`);
      },
      _solace_ready: () => ready,
      _solace_command: (ptr) => {
        let text = '';
        for (let i = 0; ; i++) {
          const code = fakeHeap[ptr + i];
          if (!code) break;
          text += String.fromCharCode(code);
        }
        log.push(`command:${text}`);
      },
      _malloc: (size) => {
        const ptr = 1024;
        fakeHeap.fill(0, ptr, ptr + size);
        log.push(`malloc:${size}`);
        return ptr;
      },
      _free: () => log.push('free'),
      stringToUTF8: (str, ptr) => {
        for (let i = 0; i < str.length; i++) fakeHeap[ptr + i] = str.charCodeAt(i);
        fakeHeap[ptr + str.length] = 0;
      },
      lengthBytesUTF8: (str) => Buffer.byteLength(str, 'utf8'),
    };
  };
}

const fakeHeap = new Uint8Array(4096);

// the loader fetches the network through the global fetch
globalThis.fetch = async (url) => {
  if (String(url).includes('missing')) return { ok: false, status: 404 };
  return { ok: true, headers: { get: () => String(NET.length) }, arrayBuffer: async () => NET.slice().buffer };
};

console.log('Solace 0.2 — loader tests\n');

await check('network is written before main() runs, then freed', async () => {
  const log = [];
  const engine = await createEngine({ createModule: stubFactory(log), netUrl: 'net', wasmUrl: 'x.wasm' });
  assert.deepEqual(
    log.filter((l) => !l.startsWith('malloc')),
    ['factory', 'writeFile:/nn-1a298aa575a0.nnue:5', 'callMain:net-present', 'unlink:/nn-1a298aa575a0.nnue'],
  );
  assert.equal(engine.ready, true);
});

await check('freeNetFile: false keeps the network file', async () => {
  const log = [];
  await createEngine({ createModule: stubFactory(log), netUrl: 'net', freeNetFile: false });
  assert.ok(!log.some((l) => l.startsWith('unlink')), 'file should not be removed');
});

await check('send() copies the command into wasm memory and frees it', async () => {
  const log = [];
  const engine = await createEngine({ createModule: stubFactory(log), netUrl: 'net' });
  log.length = 0;
  engine.send('position startpos moves e2e4');
  assert.deepEqual(log, ['malloc:29', 'command:position startpos moves e2e4', 'free']);
});

await check('engine output is split into lines', async () => {
  const lines = [];
  const log = [];
  await createEngine({ createModule: stubFactory(log), netUrl: 'net', onLine: (line) => lines.push(line) });
  assert.deepEqual(lines, ['Solace 0.2 64 POPCNT by the Stockfish developers']);
});

await check('an engine that fails to initialise is reported', async () => {
  const log = [];
  await assert.rejects(
    () => createEngine({ createModule: stubFactory(log, { ready: 0 }), netUrl: 'net' }),
    /did not initialise/,
  );
});

await check('a missing network fails with a clear message', async () => {
  await assert.rejects(() => createEngine({ createModule: stubFactory([]), netUrl: 'missing' }), /cannot load/);
});

await check('parseInfo reads depth, score, nodes and pv', async () => {
  const info = parseInfo(
    'info depth 18 seldepth 24 multipv 1 score cp -35 nodes 1234567 nps 900000 hashfull 12 time 1400 pv d2d4 g8f6 c2c4',
  );
  assert.equal(info.depth, 18);
  assert.deepEqual(info.score, { type: 'cp', value: -35 });
  assert.equal(info.nodes, 1234567);
  assert.deepEqual(info.pv, ['d2d4', 'g8f6', 'c2c4']);
});

await check('parseInfo understands mate scores', async () => {
  const info = parseInfo('info depth 12 score mate 3 pv h5f7');
  assert.deepEqual(info.score, { type: 'mate', value: 3 });
});

console.log(`\n${failures === 0 ? 'all loader tests passed' : `${failures} loader tests failed`}`);
process.exit(failures ? 1 : 0);
