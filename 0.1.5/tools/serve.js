#!/usr/bin/env node
/**
 * tools/serve.js
 *
 * Minimal static file server for the browser version of SOLACE.  It has no
 * dependencies, binds to 0.0.0.0 (so it also works from a phone on the same
 * Wi-Fi network or from a hosted preview) and sends permissive headers so the
 * page can be embedded in an iframe.
 *
 *   node tools/serve.js [port] [--host 0.0.0.0]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const portArg = args.find((a) => /^\d+$/.test(a));
const hostIndex = args.indexOf('--host');
const port = Number(portArg ?? process.env.PORT ?? 3000);
const host = hostIndex >= 0 ? args[hostIndex + 1] : (process.env.HOST ?? '0.0.0.0');
const root = resolve(process.cwd());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/web/index.html';
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    const finalPath = info && info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const data = await readFile(finalPath);

    response.writeHead(200, {
      'Content-Type': MIME[extname(finalPath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      // Allow embedding in the hosted preview iframe.
      'X-Frame-Options': 'ALLOWALL',
      'Content-Security-Policy': "frame-ancestors *",
    });
    response.end(data);
  } catch (err) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`not found: ${err.message}\n`);
  }
});

server.listen(port, host, () => {
  console.log(`SOLACE web UI: http://${host}:${port}/  (serving ${root})`);
  console.log('Open the page, pick whether SOLACE plays white or black, and play.');
});
