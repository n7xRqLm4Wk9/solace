/**
 * Solace 0.2 — Web Worker wrapper.
 *
 * The engine searches on its own pthread, but the Wasm module itself lives in
 * this worker, so the page never blocks while it loads, parses the network or
 * prints a long `bench`.
 *
 * Protocol (page -> worker):
 *   { type: 'init', wasmUrl, netUrl, moduleUrl }
 *   { type: 'cmd', line }
 *   { type: 'quit' }
 *
 * Protocol (worker -> page):
 *   { type: 'status', state: 'loading' | 'starting' | 'ready' | 'error', detail }
 *   { type: 'net', loaded, total }
 *   { type: 'lines', lines: [...] }   a batch, flushed every ~30 ms
 *   { type: 'line', line }           a single line that had to go out at once
 *   { type: 'error', message }
 *
 * Output is batched on purpose. A search prints an `info` line per depth (and
 * per PV move at MultiPV), each of which used to be its own postMessage; on a
 * phone that is thousands of main-thread wake-ups per game, which shows up as
 * jank and as thermal load. Lines that end a command (`bestmove`, `readyok`,
 * `uciok`) are flushed immediately so nothing waits on the timer.
 */

import { createEngine } from './engine.js';

let engine = null;

// --- output batching -------------------------------------------------------

const FLUSH_MS = 30;
const MAX_BUFFER = 400;
let pending = [];
let timer = null;

function flush() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.length) return;
  const lines = pending;
  pending = [];
  post({ type: 'lines', lines });
}

function queue(line) {
  pending.push(line);
  // A terminating line is what the page is waiting for: never delay it.
  if (pending.length >= MAX_BUFFER || /^(bestmove|readyok|uciok|info string)/.test(line)) {
    flush();
    return;
  }
  if (timer === null) timer = setTimeout(flush, FLUSH_MS);
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'init') {
    try {
      post({ type: 'status', state: 'loading' });
      const mod = await import(msg.moduleUrl || '../engine/solace.js');
      const createModule = mod.default || mod.createSolace;
      engine = await createEngine({
        createModule,
        wasmUrl: msg.wasmUrl,
        netUrl: msg.netUrl,
        // The network is 98 MB and never changes for a given build: keep it in
        // Cache Storage so a returning visitor does not download it again (on a
        // phone that is the difference between a 2 second and a 2 minute load).
        cacheName: msg.cacheName ?? 'solace-net-v1',
        onLine: queue,
        onError: (message) => post({ type: 'error', message }),
        onNetProgress: (loaded, total) => post({ type: 'net', loaded, total }),
      });
      flush();
      post({ type: 'status', state: 'ready' });
    } catch (err) {
      post({ type: 'error', message: err && err.message ? err.message : String(err) });
      post({ type: 'status', state: 'error', detail: err && err.message });
    }
    return;
  }

  if (!engine) {
    post({ type: 'error', message: `command before init: ${msg.line || msg.type}` });
    return;
  }

  if (msg.type === 'cmd') {
    try {
      engine.send(msg.line);
    } catch (err) {
      post({ type: 'error', message: String(err) });
    }
  } else if (msg.type === 'quit') {
    try {
      engine.dispose();
    } finally {
      flush();
      self.close();
    }
  }
};

function post(message) {
  self.postMessage(message);
}
