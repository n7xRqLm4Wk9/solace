#!/usr/bin/env node
/**
 * Solace 0.2 — checks around the browser build.
 *
 * There is no browser in this test environment, so instead of pretending, this
 * script checks the pieces the page depends on:
 *
 *   1. every relative import of web/app.js points at a file that exists,
 *   2. the static server answers, sends the cross-origin-isolation headers the
 *      wasm threads need, and serves the wasm with the right MIME type,
 *   3. src/worker.js really does load the engine and answer UCI when driven
 *      through its message protocol (with a small shim standing in for the
 *      browser's `self`).
 *
 *     node 0.2/tests/web.mjs
 */

import { strict as assert } from 'node:assert';
import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = join(ROOT, '..');
const PORT = 8123 + Math.floor(Math.random() * 200);

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

console.log('Solace 0.2 — web checks\n');

await check('every import in web/app.js resolves to a file', async () => {
  const source = await readFile(join(ROOT, 'web', 'app.js'), 'utf8');
  const specifiers = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specifiers.length >= 4, `only found ${specifiers.length} relative imports`);
  for (const spec of specifiers) {
    const file = resolve(join(ROOT, 'web'), spec);
    await access(file).catch(() => {
      throw new Error(`import ${spec} -> ${file} does not exist`);
    });
  }
});

await check('web/index.html references only local files', async () => {
  const html = await readFile(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /src="app\.js"/);
  assert.match(html, /href="style\.css"/);
  assert.ok(!/https?:\/\//.test(html), 'page must not need external resources');
});

// ---- the static server ----------------------------------------------------

const server = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const ready = new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('server did not start')), 10000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('Solace 0.2 UI')) {
      clearTimeout(timer);
      res();
    }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});

try {
  await ready;

  await check('server sends the headers wasm threads require', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/0.2/web/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  await check('server serves the page module and the stylesheet', async () => {
    for (const [path, type] of [
      ['/0.2/web/app.js', /javascript/],
      ['/0.2/web/style.css', /css/],
      ['/0.1.5/src/core/position.js', /javascript/],
      ['/0.2/src/worker.js', /javascript/],
    ]) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
      assert.match(res.headers.get('content-type'), type, `${path} has type ${res.headers.get('content-type')}`);
    }
  });

  await check('server refuses paths outside the app', async () => {
    for (const path of ['/0.1.5/package.json', '/README.md', '/.git/config', '/0.2/vendor/stockfish/src/uci.cpp']) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      assert.equal(res.status, 404, `${path} should not be served (got ${res.status})`);
    }
  });

  await check('the wasm binary is served as application/wasm', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/0.2/dist/solace.wasm`, { method: 'HEAD' });
    assert.equal(res.status, 200, 'dist/solace.wasm missing — run build/build.sh');
    assert.equal(res.headers.get('content-type'), 'application/wasm');
    assert.ok(Number(res.headers.get('content-length')) > 100000);
  });
} finally {
  server.kill();
}

// ---- the worker protocol --------------------------------------------------

await check('src/worker.js loads the engine and answers uci / isready / go', async () => {
  const messages = [];
  const pending = [];
  globalThis.self = {
    postMessage: (msg) => {
      messages.push(msg);
      for (const p of [...pending]) p(msg);
    },
    close: () => {},
  };

  await import(pathToFileURL(join(ROOT, 'src', 'worker.js')).href);
  const send = (msg) => globalThis.self.onmessage({ data: msg });

  const waitFor = (pred, timeout = 180000) =>
    new Promise((res, rej) => {
      const found = messages.find(pred);
      if (found) return res(found);
      const timer = setTimeout(() => rej(new Error('timeout')), timeout);
      pending.push((msg) => {
        if (pred(msg)) {
          clearTimeout(timer);
          res(msg);
        }
      });
    });

  send({
    type: 'init',
    moduleUrl: pathToFileURL(join(ROOT, 'dist', 'solace.js')).href,
    wasmUrl: pathToFileURL(join(ROOT, 'dist', 'solace.wasm')).href,
    netUrl: pathToFileURL(join(ROOT, 'assets', 'nn-1a298aa575a0.nnue')).href,
  });

  const status = await waitFor((m) => m.type === 'status' && (m.state === 'ready' || m.state === 'error'));
  assert.equal(status.state, 'ready', `engine failed to start: ${status.detail}`);
  assert.ok(
    messages.some((m) => m.type === 'line' && m.line === 'Solace 0.2 64 POPCNT by the Stockfish developers'),
    'engine banner was not forwarded',
  );

  send({ type: 'cmd', line: 'uci' });
  const id = await waitFor((m) => m.type === 'line' && m.line.startsWith('id name '));
  assert.equal(id.line, 'id name Solace 0.2');

  send({ type: 'cmd', line: 'position startpos' });
  send({ type: 'cmd', line: 'go depth 6' });
  const best = await waitFor((m) => m.type === 'line' && m.line.startsWith('bestmove'));
  assert.match(best.line, /^bestmove [a-h][1-8][a-h][1-8]/);
});

console.log(`\n${failures === 0 ? 'all web checks passed' : `${failures} web checks failed`}`);
process.exit(failures ? 1 : 0);
