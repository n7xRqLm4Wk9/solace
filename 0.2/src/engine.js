/**
 * Solace 0.2 — JavaScript loader for the WebAssembly engine.
 *
 * This is the only file that knows how the C++ side is wired up:
 *
 *   1. load engine/solace.js + engine/solace.wasm (Emscripten output),
 *   2. get the NNUE network into the engine: by default it is streamed straight
 *      into a buffer in the WebAssembly heap and parsed from there
 *      (`solace_load_net`), so the 98 MB file is never duplicated,
 *   3. start Stockfish's main(), which initialises the engine and returns,
 *   4. hand the buffered network to the engine and free the buffer,
 *   5. feed UCI command lines through the exported `solace_command()`.
 *
 * The buffer has to be filled before `main()` (the command line is parsed
 * there) but can only be parsed after it (that is when the engine object
 * exists), so steps 2 and 4 are split.
 *
 * It works unchanged in a browser, in a Web Worker and in Node, so the tests
 * run against exactly the same code the page uses.
 *
 * Why the network does not go through the filesystem any more: the old path
 * fetched 98 MB into a JavaScript array and wrote it into the Emscripten MEMFS,
 * which keeps its own copy — 196 MB of RAM for a file the engine reads once. On
 * a 4 GB Android phone that plus the engine's weights is enough to have the tab
 * killed. Builds without `solace_load_net` (and tests) still take the old path.
 */

import { NET_NAME } from './config.js';

/**
 * @param {object} options
 * @param {Function} options.createModule  the factory exported by engine/solace.js
 * @param {string} [options.wasmUrl]       URL/path of engine/solace.wasm
 * @param {string} [options.netUrl]        URL/path of the .nnue file
 * @param {string} [options.netFile]       path inside the virtual FS (fallback)
 * @param {string} [options.cacheName]     Cache Storage bucket for the network
 *                                         (browser only; null disables caching)
 * @param {(line: string) => void} [options.onLine]  one UCI output line
 * @param {(msg: string) => void} [options.onError]
 * @param {(loaded: number, total: number) => void} [options.onNetProgress]
 * @param {boolean} [options.freeNetFile]  drop the network file after the engine
 *                                         has read it (fallback path only)
 * @param {object} [options.timings]       filled with { fetch, instantiate,
 *                                         netCopy, netParse, main, heapPeak,
 *                                         heapAfterLoad } in ms / bytes
 */
export async function createEngine(options) {
  const {
    createModule,
    wasmUrl,
    netUrl,
    netFile = `/${NET_NAME}`,
    cacheName = null,
    onLine = () => {},
    onError = () => {},
    onNetProgress,
    freeNetFile = true,
    timings = {},
  } = options;

  if (typeof createModule !== 'function') throw new Error('createEngine: createModule is required');

  // ---- 1. the wasm module first: the network may have to be copied into it --
  let t = now();
  const module = await createModule({
    print: (text) => emitLines(text, onLine),
    printErr: (text) => emitLines(text, onLine),
    locateFile: (path) => (path.endsWith('.wasm') && wasmUrl ? wasmUrl : path),
    noExitRuntime: true,
  });
  timings.instantiate = now() - t;

  // Both are needed for the memory path: the export from patch 0004 and the
  // HEAPU8 view to write into.
  const fromMemory = typeof module._solace_load_net === 'function' && Boolean(module.HEAPU8);

  let pending = null;
  if (fromMemory) {
    // ---- 2a. stream the network into the wasm heap; it is parsed after main()
    t = now();
    const source = await openNet(netUrl, { cacheName, onProgress: onNetProgress });
    timings.fetch = now() - t;

    t = now();
    pending = await copyIntoHeap(module, source, onNetProgress);
    timings.netCopy = now() - t;
    timings.heapPeak = Math.max(timings.heapPeak || 0, module.HEAPU8.length);
  } else {
    // ---- 2b. older build (or a stub): the network has to be a file ---------
    if (!module.FS) throw new Error('createEngine: the build has no filesystem (FORCE_FILESYSTEM missing)');

    t = now();
    const bytes = await fetchBinary(netUrl, onNetProgress);
    timings.fetch = now() - t;

    t = now();
    module.FS.writeFile(netFile, bytes);
    timings.netCopy = now() - t;
    timings.heapPeak = Math.max(timings.heapPeak || 0, module.HEAPU8 ? module.HEAPU8.length : 0);
  }

  // ---- 3. main() initialises the engine and returns ----
  t = now();
  module.callMain([]);
  timings.main = now() - t;

  if (!module._solace_ready || module._solace_ready() !== 1)
    throw new Error('createEngine: the engine did not initialise');

  // ---- 4. hand the buffered network to the engine, then free the buffer ----
  if (pending) {
    t = now();
    const ok = module._solace_load_net(pending.ptr, pending.size);
    module._free(pending.ptr);
    timings.netParse = now() - t;
    timings.heapAfterLoad = module.HEAPU8.length;
    if (!ok) throw new Error(`createEngine: ${netUrl} is not a usable NNUE network`);
  }

  if (!fromMemory && freeNetFile) {
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
    timings,
    /** Live size of the WebAssembly heap in bytes. */
    heapSize: () => (module.HEAPU8 ? module.HEAPU8.length : 0),
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

// ---------------------------------------------------------------------------
// network plumbing
// ---------------------------------------------------------------------------

/**
 * Opens the network and returns something that can be streamed: a fetch body,
 * a cached body, or a local file. Never buffers the whole file in JS memory.
 *
 * @returns {Promise<{stream: ReadableStream<Uint8Array>|null, size: number, bytes?: Uint8Array}>}
 */
async function openNet(url, { cacheName, onProgress } = {}) {
  // Node (CLI, tests, tools): read from disk, no fetch() file support needed.
  if (typeof url === 'string' && url.startsWith('file:')) {
    const { open, stat } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const file = fileURLToPath(url);
    let size, fh;
    try {
      size = (await stat(file)).size;
      fh = await open(file);
    } catch (err) {
      throw new Error(`cannot load ${url}: ${err.code || err.message}`);
    }
    // Streamed in small reads: the network never exists twice in memory, which
    // matters on a phone running the CLI under Termux.
    let at = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const buf = Buffer.alloc(Math.min(1 << 20, Math.max(1, size - at)));
          const { bytesRead } = await fh.read(buf, 0, buf.length, at);
          if (!bytesRead) {
            await fh.close();
            controller.close();
            return;
          }
          at += bytesRead;
          if (onProgress) onProgress(at, size);
          controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
        } catch (err) {
          await fh.close().catch(() => {});
          controller.error(err);
        }
      },
    });
    return { stream, size };
  }

  const cache = await openCache(cacheName);
  if (cache) {
    const hit = await cache.match(url).catch(() => null);
    if (hit) {
      const size = Number(hit.headers.get('content-length')) || 0;
      return { stream: hit.body, size };
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`);

  const size = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    // Runtime without streaming bodies (or a stub in the tests): no choice but
    // to materialise the bytes here.
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (onProgress) onProgress(bytes.length, bytes.length);
    return { stream: null, bytes, size: bytes.length };
  }
  if (cache) {
    // Store a copy while we stream the original; not awaited, so a slow cache
    // never delays start-up and a cache failure is not fatal.
    try {
      cache.put(url, res.clone()).catch(() => {});
    } catch {
      /* ignore */
    }
  }
  return { stream: res.body, size };
}

/** Cache Storage if the runtime has it, otherwise null (Node, old browsers). */
async function openCache(name) {
  if (!name || typeof caches === 'undefined' || !caches || !caches.open) return null;
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

/**
 * Copies the network into one buffer in the WebAssembly heap and returns it.
 * The bytes are written chunk by chunk, so a browser download never has to be
 * held in JavaScript memory first.
 */
async function copyIntoHeap(module, source, onProgress) {
  if (!source.size && source.stream) {
    // No Content-Length (chunked response): the buffer cannot be sized up
    // front, so collect the chunks first. This is the only path that holds the
    // network twice, and it only happens on servers that do not announce it.
    const chunks = [];
    let total = 0;
    const reader = source.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      if (onProgress) onProgress(total, 0);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    source = { bytes: all, size: total, stream: null };
  }

  const size = source.size || (source.bytes ? source.bytes.length : 0);
  if (!size) throw new Error('createEngine: the network size is unknown (missing Content-Length)');

  const ptr = module._malloc(size);
  if (!ptr) throw new Error(`createEngine: no room in the wasm heap for a ${size} byte network`);

  let written = 0;
  const write = (chunk) => {
    // HEAPU8 is re-read every time: _malloc may have grown the memory.
    if (written + chunk.length > size) throw new Error('createEngine: the network is larger than announced');
    module.HEAPU8.set(chunk, ptr + written);
    written += chunk.length;
    if (onProgress) onProgress(written, size);
  };

  try {
    if (source.bytes) {
      write(source.bytes);
    } else if (source.stream && source.stream.getReader) {
      const reader = source.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) write(value);
      }
    } else {
      throw new Error('createEngine: the network source cannot be streamed');
    }
  } catch (err) {
    module._free(ptr);
    throw err;
  }

  if (written !== size) {
    module._free(ptr);
    throw new Error(`createEngine: the network is truncated (${written} of ${size} bytes)`);
  }
  return { ptr, size };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Splits a chunk of engine output into complete lines. */
function emitLines(chunk, onLine) {
  const text = String(chunk);
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length) onLine(trimmed);
  }
}

/** Reads a URL fully into memory — only used by the legacy filesystem path. */
async function fetchBinary(url, onProgress) {
  const source = await openNet(url, { onProgress: undefined });
  if (source.bytes) {
    if (onProgress) onProgress(source.bytes.length, source.bytes.length);
    return source.bytes;
  }

  const chunks = [];
  let loaded = 0;
  const reader = source.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, source.size);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
