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
 *   { type: 'line', line }
 *   { type: 'error', message }
 */

import { createEngine } from './engine.js';

let engine = null;

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'init') {
    try {
      post({ type: 'status', state: 'loading' });
      const mod = await import(msg.moduleUrl || '../dist/solace.js');
      const createModule = mod.default || mod.createSolace;
      engine = await createEngine({
        createModule,
        wasmUrl: msg.wasmUrl,
        netUrl: msg.netUrl,
        onLine: (line) => post({ type: 'line', line }),
        onError: (message) => post({ type: 'error', message }),
        onNetProgress: (loaded, total) => post({ type: 'net', loaded, total }),
      });
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
      self.close();
    }
  }
};

function post(message) {
  self.postMessage(message);
}
