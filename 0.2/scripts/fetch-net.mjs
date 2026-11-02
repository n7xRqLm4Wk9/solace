#!/usr/bin/env node
/**
 * Solace 0.2 — fetch the neural network the engine needs.
 *
 * Stockfish 19 evaluates with an NNUE network (nn-1a298aa575a0.nnue, ~98 MB)
 * which is far too large to keep in this repository. Run this script once:
 *
 *     node 0.2/scripts/fetch-net.mjs
 *
 * It writes 0.2/assets/nn-1a298aa575a0.nnue and verifies its SHA-256 against the
 * hash published in the official stockfish/networks repository.
 *
 * Two sources are tried, so the script also works when one is unreachable:
 *   1. the official Stockfish URLs (the ones Stockfish's scripts/net.sh uses),
 *   2. the wasm bundle on npm that embeds the same network file inside its
 *      WebAssembly binary; the network is carved out of the wasm data segments
 *      and then hash-checked, so a corrupt download cannot slip through.
 */

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NET_NAME = 'nn-1a298aa575a0.nnue';
const NET_SIZE = 98511183;
const NET_SHA256 = '1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2';
const OUT = join(ROOT, 'assets', NET_NAME);

const SOURCES = [
  `https://tests.stockfishchess.org/api/nn/${NET_NAME}`,
  `https://github.com/official-stockfish/networks/raw/master/${NET_NAME}`,
];
const NPM_TARBALL = 'https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function alreadyPresent() {
  try {
    if ((await stat(OUT)).size === NET_SIZE && sha256(await readFile(OUT)) === NET_SHA256) {
      console.log(`already present and verified: ${OUT}`);
      return true;
    }
  } catch {
    /* not there yet */
  }
  return false;
}

async function save(buf) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, buf);
  console.log(`wrote ${OUT} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function fromOfficial() {
  for (const url of SOURCES) {
    process.stdout.write(`trying ${url}\n`);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        console.log(`  HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== NET_SIZE || sha256(buf) !== NET_SHA256) {
        console.log(`  unexpected content (${buf.length} bytes), skipping`);
        continue;
      }
      await save(buf);
      return true;
    } catch (err) {
      console.log(`  failed: ${err.message}`);
    }
  }
  return false;
}

/** Minimal ustar reader: returns the bytes of `wanted` from a .tar.gz buffer. */
function extractFromTarGz(gz, wanted) {
  const tar = gunzipSync(gz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const start = off + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Rebuild the linear-memory image described by the data segments of a wasm
 * module and carve the NNUE file out of it. Emscripten stores `--preload-file`
 * data this way, so the bytes are identical to the file the engine shipped.
 */
function carveNetFromWasm(wasm) {
  const leb = (p) => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = wasm[p++];
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return [result >>> 0, p];
      shift += 7;
    }
  };

  let pos = 8;
  let segments = null;
  while (pos < wasm.length) {
    const id = wasm[pos++];
    let size;
    [size, pos] = leb(pos);
    const body = pos;
    if (id === 11) {
      let count;
      [count, pos] = leb(body);
      segments = [];
      let p = pos;
      for (let i = 0; i < count; i++) {
        let flags;
        [flags, p] = leb(p);
        let offset = null;
        if (flags === 0 || flags === 2) {
          p += 1;
          [offset, p] = leb(p);
          p += 1;
        }
        let len;
        [len, p] = leb(p);
        segments.push([offset, p, len]);
        p += len;
      }
      break;
    }
    pos = body + size;
  }
  if (!segments) throw new Error('no data section in wasm');

  const end = Math.max(...segments.map(([o, , len]) => (o ?? 0) + len));
  const image = Buffer.alloc(end);
  for (const [offset, p, len] of segments) image.set(wasm.subarray(p, p + len), offset ?? 0);

  const magic = Buffer.from([0xfa, 0x8a, 0x44, 0x6a]); // NNUE file format version
  const netHash = Buffer.from([0x05, 0x22, 0x5b, 0xa8]); // network architecture hash
  let at = image.indexOf(magic);
  while (at >= 0) {
    if (image.subarray(at + 4, at + 8).equals(netHash) && at + NET_SIZE <= image.length)
      return image.subarray(at, at + NET_SIZE);
    at = image.indexOf(magic, at + 1);
  }
  throw new Error('NNUE data not found in the wasm image');
}

async function fromNpm() {
  process.stdout.write(`trying ${NPM_TARBALL}\n`);
  const res = await fetch(NPM_TARBALL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const wasm = extractFromTarGz(Buffer.from(await res.arrayBuffer()), 'package/bin/stockfish-19-single.wasm');
  if (!wasm) throw new Error('stockfish wasm not found in the npm tarball');
  const net = carveNetFromWasm(wasm);
  if (net.length !== NET_SIZE || sha256(net) !== NET_SHA256)
    throw new Error('carved network does not match the published SHA-256');
  await save(net);
  return true;
}

if (await alreadyPresent()) process.exit(0);

let ok = false;
try {
  ok = await fromOfficial();
} catch (err) {
  console.log(`official download failed: ${err.message}`);
}
if (!ok) {
  try {
    ok = await fromNpm();
  } catch (err) {
    console.error(`npm fallback failed: ${err.message}`);
  }
}
if (!ok) {
  console.error(
    `\nCould not obtain ${NET_NAME}.\n\n` +
      'Download it manually from\n' +
      `  https://tests.stockfishchess.org/api/nn/${NET_NAME}\n` +
      `and save it as assets/${NET_NAME}.\n` +
      `Expected size ${NET_SIZE} bytes, SHA-256 ${NET_SHA256}.`,
  );
  process.exit(1);
}
