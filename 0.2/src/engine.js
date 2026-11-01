/**
 * Solace 0.2 — JavaScript loader for the WebAssembly engine.
 *
 * This is the only file that knows how the C++ side is wired up:
 *
 *   1. load dist/solace.js + dist/solace.wasm (Emscripten output),
 *   2. write the NNUE file into the module's in-memory filesystem,
 *   3. start Stockfish's main(), which initialises the engine and returns,
 *   4. feed UCI command lines through the exported `solace_command()`.
 *
 * It works unchanged in a browser, in a Web Worker and in Node, so the tests
 * run against exactly the same code the page uses.
 */

import { NET_NAME } from './config.js';

/**
 * @param {object} options
 * @param {Function} options.createModule  the factory exported by dist/solace.js
 * @param {string} [options.wasmUrl]       URL/path of dist/solace.wasm
 * @param {string} [options.netUrl]        URL/path of the .nnue file
 * @param {string} [options.netFile]       path inside the virtual FS
 * @param {(line: string) => void} [options.onLine]  one UCI output line
 * @param {(msg: string) => void} [options.onError]
 * @param {(loaded: number, total: number) => void} [options.onNetProgress]
 * @param {boolean} [options.freeNetFile]  drop the 98 MB file after the engine
 *                                         has read it (default true)
 */
export async function createEngine(options) {
  const {
    createModule,
    wasmUrl,
    netUrl,
    netFile = `/${NET_NAME}`,
    onLine = () => {},
    onError = () => {},
    onNetProgress,
    freeNetFile = true,
  } = options;

  if (typeof createModule !== 'function') throw new Error('createEngine: createModule is required');

  // ---- 1. the network has to be in the virtual filesystem before main() ----
  const netBytes = await fetchBinary(netUrl, onNetProgress);

  const module = await createModule({
    print: (text) => emitLines(text, onLine),
    printErr: (text) => emitLines(text, onLine),
    locateFile: (path) => (path.endsWith('.wasm') && wasmUrl ? wasmUrl : path),
    noExitRuntime: true,
  });

  if (!module.FS) throw new Error('createEngine: the build has no filesystem (FORCE_FILESYSTEM missing)');

  module.FS.writeFile(netFile, netBytes);

  // ---- 2. main() initialises the engine and returns ----
  module.callMain([]);

  if (!module._solace_ready || module._solace_ready() !== 1)
    throw new Error('createEngine: the engine did not initialise');

  // The network is parsed into the engine's own weights at startup, so the raw
  // file is no longer needed. Keeping it would cost another 98 MB of RAM.
  if (freeNetFile) {
    try {
      module.FS.unlink(netFile);
    } catch {
      /* harmless: some builds keep it open */
    }
  }

  const encoding = (s) => {
    const size = module.lengthBytesUTF8(s) + 1;
    const ptr = module._malloc(size);
    module.stringToUTF8(s, ptr, size);
    return ptr;
  };

  /** Send one UCI command line (without newline). */
  function send(line) {
    const text = String(line);
    if (!text.length) return;
    const ptr = encoding(text);
    try {
      module._solace_command(ptr);
    } finally {
      module._free(ptr);
    }
  }

  return {
    send,
    module,
    /** True once main() has created the engine object. */
    get ready() {
      return module._solace_ready() === 1;
    },
    /** Releases WebAssembly memory; the engine cannot be used afterwards. */
    dispose() {
      send('quit');
    },
  };
}

/** Splits a chunk of engine output into complete lines. */
function emitLines(chunk, onLine) {
  const text = String(chunk);
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length) onLine(trimmed);
  }
}

async function fetchBinary(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
