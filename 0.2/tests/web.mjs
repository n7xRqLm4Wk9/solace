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
const base = `http://127.0.0.1:${PORT}`;

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
    const res = await fetch(`http://127.0.0.1:${PORT}/0.2/engine/solace.wasm`, { method: 'HEAD' });
    assert.equal(res.status, 200, 'engine/solace.wasm missing — run scripts/build.sh');
    assert.equal(res.headers.get('content-type'), 'application/wasm');
    assert.ok(Number(res.headers.get('content-length')) > 100000);
  });
await check('the network is cacheable and the wasm binary revalidates', async () => {
  // HEAD: the point is the header, not the 98 MB body.
  const net = await fetch(`${base}/0.2/assets/nn-1a298aa575a0.nnue`, { method: 'HEAD' });
  const cc = net.headers.get('cache-control') || '';
  assert.match(cc, /max-age=31536000/, `the 98 MB network should be cacheable, got "${cc}"`);
  assert.match(cc, /immutable/);

  const wasm = await fetch(`${base}/0.2/engine/solace.wasm`);
  assert.ok((wasm.headers.get('etag') || '').length > 0, 'wasm needs an ETag to revalidate cheaply');
  const again = await fetch(`${base}/0.2/engine/solace.wasm`, {
    headers: { 'If-None-Match': wasm.headers.get('etag') },
  });
  assert.equal(again.status, 304, 'an unchanged build should answer 304, not re-download');
});

} finally {
  server.kill();
}

// ---- build-level mobile guards ---------------------------------------------

await check('the wasm build reserves phone-sized memory and can load the net from a buffer', async () => {
  const { readFile } = await import('node:fs/promises');
  const glue = await readFile(join(ROOT, 'engine', 'solace.js'), 'utf8');

  const m = /INITIAL_MEMORY=(\d+)/.exec(glue);
  assert.ok(m, 'the glue should pin INITIAL_MEMORY');
  const initial = Number(m[1]);
  assert.ok(
    initial <= 128 * 1024 * 1024,
    `INITIAL_MEMORY is ${initial / 1048576} MB; a phone should not be asked for that up front`,
  );

  assert.match(glue, /_solace_load_net/, 'the build has to export solace_load_net (patch 0004)');
});

// ---- mobile behaviour -----------------------------------------------------

await check('thermal.js shortens searches on a throttling device', async () => {
  const { ThrottleGuard, HOT_RATIO, MIN_THINK_TIME } = await import(
    pathToFileURL(join(ROOT, 'web', 'thermal.js')).href
  );

  const guard = new ThrottleGuard();
  assert.equal(guard.observe(120000).hot, false, 'a fast first sample is not throttling');
  for (let i = 0; i < 4; i++) guard.observe(118000);
  assert.equal(guard.hot, false);
  assert.equal(guard.thinkTime(1000), 1000, 'a cool device gets the full think time');

  for (let i = 0; i < 6; i++) guard.observe(60000);
  const hot = guard.state();
  assert.equal(hot.hot, true, `60k against a 118k peak is throttling (HOT_RATIO ${HOT_RATIO})`);
  assert.ok(hot.factor < 1, 'the throttle factor has to drop');
  assert.ok(guard.thinkTime(1000) <= 700, 'searches get shorter');
  assert.ok(guard.overheadBonus() > 0, 'and the reserve gets bigger');
  assert.ok(guard.thinkTime(10) >= MIN_THINK_TIME, 'but never below the floor');

  // a phone that cools down has to recover
  for (let i = 0; i < 40; i++) guard.observe(125000);
  assert.equal(guard.hot, false, 'recovery must not be permanent');
  assert.equal(guard.thinkTime(1000), 1000);
});

await check('deviceProfile sizes the engine to the device', async () => {
  const { deviceProfile } = await import(pathToFileURL(join(ROOT, 'src', 'config.js')).href);

  const low = deviceProfile({ deviceMemory: 2, hardwareConcurrency: 4 });
  const mid = deviceProfile({ deviceMemory: 4, hardwareConcurrency: 8 });
  const high = deviceProfile({ deviceMemory: 8, hardwareConcurrency: 8 });

  assert.ok(low.hashMB < mid.hashMB && mid.hashMB <= high.hashMB, 'hash has to grow with the device');
  assert.equal(low.hashMB, 4, 'a 2 GB phone gets a small table');
  assert.equal(low.thinkTime <= mid.thinkTime, true, 'a weak phone gets shorter searches');
  for (const p of [low, mid, high]) {
    assert.equal(p.threads, 1, 'one search thread on every phone profile');
    assert.equal(p.tier === 'low' || p.tier === 'mid' || p.tier === 'high', true);
  }
  // Safari reports no memory at all: the fallback must still be usable
  assert.ok(deviceProfile({}).hashMB >= 4);
});

// ---- the time-management helper -------------------------------------------

await check('overhead.js turns measured lateness into a Move Overhead value', async () => {
  const { overheadFromSamples, lateness, OverheadMeter, MIN_OVERHEAD, MAX_OVERHEAD, searchTime, MIN_THINK_TIME } = await import(
    pathToFileURL(join(ROOT, 'web', 'overhead.js')).href
  );

  // no samples yet: keep the browser-safe floor instead of Stockfish's 10 ms
  assert.equal(overheadFromSamples([]), MIN_OVERHEAD);
  assert.ok(MIN_OVERHEAD >= 50, 'the floor has to cover a task hop');

  // 1.5x the worst recent sample, rounded
  assert.equal(overheadFromSamples([12, 80, 40]), 120);
  // clamped at both ends
  assert.equal(overheadFromSamples([1000]), MAX_OVERHEAD);
  assert.equal(overheadFromSamples([1, 2]), MIN_OVERHEAD);

  // lateness is never negative and ignores nonsense input
  assert.equal(lateness(200, 260), 60);
  assert.equal(lateness(200, 150), 0);
  assert.equal(lateness(NaN, 10), null);

  // A `go movetime` search ignores Move Overhead, so the reserve is subtracted
  // from the request instead — this is the function that does it.
  assert.equal(searchTime({ requested: 1000, reserve: 50 }), 950);
  assert.equal(searchTime({ requested: 1000, factor: 0.55, reserve: 170 }), 380);
  assert.equal(searchTime({ requested: 200, reserve: 500 }), MIN_THINK_TIME, 'never below the floor');

  const meter = new OverheadMeter(3);
  assert.equal(meter.record(200, 210), MIN_OVERHEAD, 'a fast answer keeps the floor');
  assert.equal(meter.record(200, 400), 300, 'a slow answer raises the reserve');
  meter.markApplied();
  assert.equal(meter.shouldUpdate(), false, 'the same value is not re-sent');

  // the window is bounded, so one old outlier eventually stops counting
  meter.record(200, 210);
  meter.record(200, 210);
  meter.record(200, 210);
  assert.ok(meter.current < 300, 'old samples leave the window');
});

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

  /** The worker batches output: flatten `lines` batches into single-line events. */
  const flat = () =>
    messages.flatMap((m) =>
      m.type === 'lines' ? m.lines.map((line) => ({ type: 'line', line })) : [m],
    );

  const waitFor = (pred, timeout = 180000) =>
    new Promise((res, rej) => {
      const found = flat().find(pred);
      if (found) return res(found);
      const timer = setTimeout(() => rej(new Error('timeout')), timeout);
      pending.push(() => {
        const msg = flat().find(pred);
        if (msg) {
          clearTimeout(timer);
          res(msg);
        }
      });
    });

  send({
    type: 'init',
    moduleUrl: pathToFileURL(join(ROOT, 'engine', 'solace.js')).href,
    wasmUrl: pathToFileURL(join(ROOT, 'engine', 'solace.wasm')).href,
    netUrl: pathToFileURL(join(ROOT, 'assets', 'nn-1a298aa575a0.nnue')).href,
  });

  const status = await waitFor((m) => m.type === 'status' && (m.state === 'ready' || m.state === 'error'));
  assert.equal(status.state, 'ready', `engine failed to start: ${status.detail}`);
  // The banner carries the build's architecture ("64 POPCNT" natively, nothing
  // extra in WebAssembly), so only the name and the author credit are checked.
  assert.ok(
    flat().some(
      (m) => m.type === 'line' && m.line.startsWith('Solace 0.2 ') && m.line.includes(' by '),
    ),
    'engine banner was not forwarded',
  );

  send({ type: 'cmd', line: 'uci' });
  const id = await waitFor((m) => m.type === 'line' && m.line.startsWith('id name '));
  assert.equal(id.line, 'id name Solace 0.2');

  send({ type: 'cmd', line: 'position startpos' });
  send({ type: 'cmd', line: 'go depth 6' });
  const best = await waitFor((m) => m.type === 'line' && m.line.startsWith('bestmove'));
  assert.match(best.line, /^bestmove [a-h][1-8][a-h][1-8]/);

  // Batching has to actually batch, and the terminating line must never wait
  // for the 30 ms timer.
  const batches = messages.filter((m) => m.type === 'lines');
  assert.ok(batches.length > 0, 'output should be batched');
  const lastBatch = batches.at(-1);
  assert.ok(lastBatch.lines.includes(best.line), 'bestmove has to be flushed with its batch');
});

console.log(`\n${failures === 0 ? 'all web checks passed' : `${failures} web checks failed`}`);
process.exit(failures ? 1 : 0);
