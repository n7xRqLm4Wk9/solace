#!/usr/bin/env node
/**
 * Solace 0.2 — small static server for the browser UI.
 *
 *     node 0.2/server.mjs [--port 8080]
 *     # then open http://localhost:8080/0.2/web/
 *
 * Why not `python3 -m http.server`? The engine is built with Emscripten
 * pthreads, which need SharedArrayBuffer, which browsers only expose to
 * cross-origin isolated pages. That requires two response headers:
 *
 *     Cross-Origin-Opener-Policy: same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *
 * This server sends them. A static host must be configured the same way
 * (see docs/BUILD.md).
 *
 * Only files under 0.1.5/src, 0.2/web, 0.2/src, 0.2/dist and 0.2/assets are
 * served; nothing else in the repository is reachable.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ALLOWED = ['0.1.5/src/', '0.2/web/', '0.2/src/', '0.2/dist/', '0.2/assets/'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.nnue': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT) || 8080;

const server = createServer(async (req, res) => {
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  };

  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/' || pathname === '') pathname = '/0.2/web/';
  const rel = normalize(pathname.slice(1));

  if (rel.endsWith('/')) {
    res.writeHead(302, { ...headers, Location: `${pathname}index.html` });
    res.end();
    return;
  }
  if (rel.includes('..') || !ALLOWED.some((prefix) => rel.startsWith(prefix))) {
    res.writeHead(404, headers);
    res.end('not found');
    return;
  }

  const file = join(ROOT, rel);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, headers);
    res.end('not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Solace 0.2 UI:  http://localhost:${port}/0.2/web/`);
});
