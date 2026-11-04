#!/usr/bin/env node
/**
 * tools/progress.mjs
 *
 * The measuring stick for development.  Runs a fixed set of positions to a
 * fixed depth (or a fixed number of nodes, which is what you want when the
 * comparison must not be influenced by a speed difference), and prints - or
 * saves - the work each position took.
 *
 *   node tools/progress.mjs --depth 10
 *   node tools/progress.mjs --nodes 300000
 *   node tools/progress.mjs --depth 12 --save docs/results/baseline.json
 *   node tools/progress.mjs --depth 12 --baseline docs/results/baseline.json
 *
 * Two uses:
 *
 *   1. **Equal work.** `--nodes` makes every position stop at the same node
 *      count, so a tree reduction shows up as a *better move at equal work*
 *      rather than as a faster search.
 *   2. **Regression guard.** `--baseline` prints a per-position delta, and
 *      `--fail-on-regression <pct>` exits non-zero when nodes grew by more than
 *      that percentage.  tests/regression.test.js uses the recorded numbers so a
 *      "harmless" refactor cannot quietly make the search 30 % dumber.
 *
 * Everything runs in-process with a fresh transposition table per position, so
 * results are comparable between runs and between checkouts (point `--root` at
 * another checkout to compare versions).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const has = (name) => args.includes(`--${name}`);

const root = resolve(flag('root', '.'));
const depthArg = flag('depth', has('nodes') ? null : '10');
const nodesArg = flag('nodes', null);
const hashMB = Number(flag('hash', '64'));
const json = has('json');
const baselinePath = flag('baseline', null);
const savePath = flag('save', null);
const failPct = flag('fail-on-regression', null);
// Timing on a shared machine is noisy; repeating and keeping the fastest run per
// position measures the work, not whatever else the CPU was doing.
const repeat = Math.max(1, Number(flag('repeat', '1')));

/**
 * The reference set.  Chosen to cover the shapes the search meets in real
 * games - open, closed, tactical, endgame - and kept small so a full run is a
 * few seconds at depth 10 and under a minute at depth 12.
 */
const POSITIONS = [
  { name: 'startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { name: 'italian', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6' },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
  { name: 'closed', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10' },
  { name: 'tactical', fen: 'r1b1k2r/ppq2ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w kq - 0 8' },
  { name: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
  { name: 'rook-endgame', fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1' },
];

const { createPosition } = await import(`${root}/src/core/position.js`);
const { Searcher } = await import(`${root}/src/search/search.js`);
const { moveToUci } = await import(`${root}/src/core/moves.js`);

const limits = nodesArg
  ? { nodes: Number(nodesArg) }
  : { depth: Number(depthArg) };

const rows = [];
const t0 = Date.now();
for (const entry of POSITIONS) {
  // A fresh searcher per position: no hash or heuristic carried between
  // positions, so every number is independent and reproducible.
  let result = null;
  let ns = Infinity;
  for (let run = 0; run < repeat; run++) {
    const searcher = new Searcher({ hashMB });
    const position = createPosition(entry.fen);
    const started = process.hrtime.bigint();
    result = searcher.go(position, limits);
    ns = Math.min(ns, Number(process.hrtime.bigint() - started));
  }
  rows.push({
    name: entry.name,
    depth: result.depth,
    seldepth: result.seldepth,
    nodes: result.nodes,
    qnodes: result.qnodes,
    ms: Number((ns / 1e6).toFixed(1)),
    knps: Number((result.nodes / (ns / 1e6)).toFixed(0)),
    score: result.score,
    mate: result.mate,
    bestmove: moveToUci(result.bestMove),
    pv: result.pv.slice(0, 6).map(moveToUci),
  });
}
const totalMs = Date.now() - t0;
const totals = {
  nodes: rows.reduce((a, r) => a + r.nodes, 0),
  qnodes: rows.reduce((a, r) => a + r.qnodes, 0),
  ms: Number(rows.reduce((a, r) => a + r.ms, 0).toFixed(1)),
};

const baseline = baselinePath
  ? JSON.parse(await readFile(baselinePath, 'utf8'))
  : null;
const baseByName = new Map((baseline?.positions ?? []).map((r) => [r.name, r]));

const deltas = rows.map((r) => {
  const b = baseByName.get(r.name);
  return b ? { name: r.name, nodes: (r.nodes - b.nodes) / b.nodes, ms: (r.ms - b.ms) / b.ms } : null;
}).filter(Boolean);

const summary = {
  tool: 'progress',
  root,
  limits,
  hashMB,
  totalMs,
  totals: { ...totals, knps: Number((totals.nodes / Math.max(1, totals.ms)).toFixed(0)) },
  positions: rows,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const mode = nodesArg ? `fixed ${limits.nodes} nodes` : `depth ${limits.depth}`;
  console.log(`SOLACE progress: ${rows.length} positions, ${mode}, hash ${hashMB} MB\n`);
  console.log('position        depth  nodes      knps   ms       score    bestmove');
  for (const r of rows) {
    const score = r.mate !== null ? `#${r.mate > 0 ? '' : '-'}${Math.abs(r.mate)}` : String(r.score);
    console.log(
      `${r.name.padEnd(15)} ${String(r.depth).padStart(4)}  ${String(r.nodes).padStart(9)}  `
      + `${String(r.knps).padStart(5)}  ${String(r.ms).padStart(7)}  ${score.padStart(8)}  ${r.bestmove}`,
    );
  }
  console.log(`\ntotal ${totals.nodes} nodes, ${totals.ms} ms, ${summary.totals.knps} knps`);

  if (deltas.length) {
    const nodeDelta = deltas.reduce((a, d) => a + d.nodes, 0) / deltas.length;
    const timeDelta = deltas.reduce((a, d) => a + d.ms, 0) / deltas.length;
    console.log(`\nagainst ${baselinePath}: nodes ${(nodeDelta * 100).toFixed(1)} %, time ${(timeDelta * 100).toFixed(1)} % (mean per position)`);
    for (const d of deltas) {
      const mark = d.nodes < -0.02 ? 'better' : d.nodes > 0.02 ? 'worse ' : 'same  ';
      console.log(`  ${mark} ${d.name.padEnd(15)} nodes ${(d.nodes * 100).toFixed(1).padStart(6)} %  time ${(d.ms * 100).toFixed(1).padStart(6)} %`);
    }
  }
}

if (savePath) {
  await mkdir(dirname(resolve(savePath)), { recursive: true });
  await writeFile(savePath, `${JSON.stringify(summary, null, 2)}\n`);
  if (!json) console.log(`\nsaved to ${savePath}`);
}

if (failPct !== null && deltas.length) {
  const worst = Math.max(...deltas.map((d) => d.nodes));
  if (worst > Number(failPct) / 100) {
    console.error(`\nregression: worst position grew ${(worst * 100).toFixed(1)} % in nodes (limit ${failPct} %)`);
    process.exit(1);
  }
}
