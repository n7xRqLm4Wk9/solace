/**
 * web/engine.worker.js
 *
 * Runs SOLACE in a Web Worker so the page stays responsive while the engine
 * searches.  The worker simply hosts the UCI engine: everything arrives as UCI
 * command lines and everything the engine prints is posted back to the page.
 */

import { UciEngine } from '../src/uci/uci.js';

let engine;

function send(payload) {
  self.postMessage(payload);
}

try {
  engine = new UciEngine({
    output: (line) => send({ type: 'line', line }),
  });
  send({ type: 'ready', message: 'SOLACE worker ready' });
} catch (err) {
  send({ type: 'error', message: `engine failed to start: ${err.message}` });
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (!engine) {
    send({ type: 'error', message: 'engine is not available' });
    return;
  }
  if (typeof data.cmd !== 'string') return;
  try {
    engine.handleLine(data.cmd);
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
};
