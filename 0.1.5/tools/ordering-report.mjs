#!/usr/bin/env node
/**
 * tools/ordering-report.mjs
 *
 * Answers a question that node counts and match results cannot: *why* is the
 * search spending its nodes where it does?  Two numbers decide which kinds of
 * change can possibly help:
 *
 *   * **cutoff index** - where in the ordered move list a beta cutoff happens.
 *     If most cutoffs are at move 0-2 the ordering is doing its job and further
 *     ordering work has little headroom.
 *   * **all-node share and moves per all-node** - all-nodes are the positions
 *     where *no* move causes a cutoff; every move has to be searched, so ordering
 *     cannot help there at all, and pruning there removes defences.  A high share
 *     of all-nodes with many moves each is where a tree is actually spent.
 *
 *   node tools/ordering-report.mjs
 *   node tools/ordering-report.mjs --depth 8 --repeat 2 --json
 *
 * Measured on 0.1.5 (depth 10, 2 vCPU container): 76.8 % of cutoffs at move 0,
 * 92.2 % within three, 28.5 % of internal nodes are all-nodes searching 33.5
 * moves each.  Those numbers are why eight move-ordering candidates failed and
 * why aggressive late-move pruning cost 163 Elo - see docs/STRENGTH.md §9.
 */

import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const root = resolve(flag('root', '.'));
const depth = Number(flag('depth', '10'));
const repeat = Math.max(1, Number(flag('repeat', '1')));
const hashMB = Number(flag('hash', '64'));

const POSITIONS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
];

const { createPosition } = await import(`${root}/src/core/position.js`);
const { Searcher } = await import(`${root}/src/search/search.js`);

const cutIndex = new Int32Array(64);
let cutoffs = 0;
let internalNodes = 0;
let allNodes = 0;
let movesInAllNodes = 0;
let nodes = 0;
let ttHits = 0;

for (let run = 0; run < repeat; run++) {
  for (const fen of POSITIONS) {
    const searcher = new Searcher({ hashMB, diagnostics: true });
    const result = searcher.go(createPosition(fen), { depth });
    nodes += result.nodes;
    ttHits += searcher.debugCounters.ttHits;
    cutoffs += searcher.diag.cutoffs;
    internalNodes += searcher.diag.internalNodes;
    allNodes += searcher.diag.allNodes;
    movesInAllNodes += searcher.diag.movesInAllNodes;
    for (let i = 0; i < 64; i++) cutIndex[i] += searcher.diag.cutIndex[i];
  }
}

const pct = (n, d) => (d ? (100 * n) / d : 0);
let cumulative = 0;
const rows = [];
for (let i = 0; i < 10; i++) {
  cumulative += pct(cutIndex[i], cutoffs);
  rows.push({ moveIndex: i, share: Number(pct(cutIndex[i], cutoffs).toFixed(1)), cumulative: Number(cumulative.toFixed(1)) });
}
let tail = 0;
for (let i = 10; i < 64; i++) tail += cutIndex[i];

const summary = {
  root,
  depth,
  nodes,
  cutoffs,
  cutoffFirstMove: Number(pct(cutIndex[0], cutoffs).toFixed(1)),
  cutoffWithinThree: Number((pct(cutIndex[0] + cutIndex[1] + cutIndex[2], cutoffs)).toFixed(1)),
  cutoffTenPlus: Number(pct(tail, cutoffs).toFixed(1)),
  allNodeShare: Number(pct(allNodes, internalNodes).toFixed(1)),
  movesPerAllNode: Number((allNodes ? movesInAllNodes / allNodes : 0).toFixed(1)),
  ttHitShare: Number(pct(ttHits, nodes).toFixed(1)),
  distribution: rows,
};

if (has('json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`SOLACE ordering report — depth ${depth}, ${nodes} nodes, ${cutoffs} beta cutoffs\n`);
  console.log('where cutoffs happen:');
  for (const r of rows) {
    const bar = '#'.repeat(Math.round(r.share / 2));
    console.log(`  move #${String(r.moveIndex).padStart(2)}  ${String(r.share).padStart(5)} %  cumulative ${String(r.cumulative).padStart(5)} %  ${bar}`);
  }
  console.log(`  move #10+ ${summary.cutoffTenPlus.toFixed(1).padStart(5)} %`);
  console.log('\ntree shape:');
  console.log(`  internal nodes            ${internalNodes}`);
  console.log(`  all-nodes (no cutoff)     ${allNodes}  (${summary.allNodeShare} % of internal nodes)`);
  console.log(`  moves searched per all-node ${summary.movesPerAllNode}`);
  console.log(`  TT cutoffs                ${summary.ttHitShare} % of nodes`);
  console.log('\nreading: high concentration at move 0-2 means ordering has little headroom;');
  console.log('a high all-node share means most of the tree is positions where every move');
  console.log('must be searched, so pruning there removes defences rather than saving work.');
}
