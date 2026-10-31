#!/usr/bin/env node
/**
 * tools/ab-match.mjs
 *
 * Play two versions of SOLACE against each other, in one process, with the same
 * opening lines and alternating colours.  This is the tool used to produce the
 * head-to-head numbers in docs/STRENGTH.md, and it needs no UCI plumbing: both
 * trees are imported directly, so a match runs several times faster than going
 * through pipes.
 *
 *   node tools/ab-match.mjs <candidate-root> <baseline-root> <games> <tc>
 *
 *   node tools/ab-match.mjs . /tmp/solace-0.1.4 200 depth:5
 *   node tools/ab-match.mjs . /tmp/solace-0.1.4 200 movetime:100
 *
 * ``tc`` is either ``depth:N`` (fixed depth, measures quality at equal depth)
 * or ``movetime:N`` (milliseconds per move, measures playing strength).
 *
 * The game is adjudicated by the rules only - checkmate, stalemate, fifty-move
 * rule, insufficient material, threefold repetition - never by evaluation, so a
 * different evaluation between the two versions cannot bias the result.
 *
 * Output: one line per game and a summary with score, approximate Elo
 * difference, illegal-move count and elapsed time.  A 200-game match resolves
 * roughly +/- 50 Elo at 95% confidence; use 1000+ games for +/- 25 Elo.
 *
 * Both trees must be complete checkouts: the tool imports src/core/position.js,
 * src/core/moves.js, src/search/search.js, src/tools/openings.js and
 * src/tools/selfplay.js from each root.
 */

const [aRoot, bRoot, gamesArg, tcArg] = process.argv.slice(2);
if (!aRoot || !bRoot) {
  console.error('usage: node tools/ab-match.mjs <candidate-root> <baseline-root> [games] [depth:N|movetime:N]');
  process.exit(2);
}
const games = Number(gamesArg ?? 24);
const tc = tcArg ?? 'depth:6';
const limits = tc.startsWith('depth:')
  ? { depth: Number(tc.split(':')[1]) }
  : { movetime: Number(tc.split(':')[1]) };

// Candidate (A) and baseline (B).  Each module set is loaded from its own tree.
const A = {
  Position: (await import(`${aRoot}/src/core/position.js`)).Position,
  Searcher: (await import(`${aRoot}/src/search/search.js`)).Searcher,
  moves: await import(`${aRoot}/src/core/moves.js`),
  openings: await import(`${aRoot}/src/tools/openings.js`),
  adjudicate: (await import(`${aRoot}/src/tools/selfplay.js`)).adjudicate,
};
const B = {
  Position: (await import(`${bRoot}/src/core/position.js`)).Position,
  Searcher: (await import(`${bRoot}/src/search/search.js`)).Searcher,
  moves: await import(`${bRoot}/src/core/moves.js`),
};

const aEngine = new A.Searcher({ hashMB: 32 });
const bEngine = new B.Searcher({ hashMB: 32 });

let wins = 0;
let losses = 0;
let draws = 0;
let illegal = 0;
const started = Date.now();

for (let game = 0; game < games; game++) {
  const spec = A.openings.DEFAULT_OPENINGS[Math.floor(game / 2) % A.openings.DEFAULT_OPENINGS.length];
  const position = A.openings.openingPosition(spec).position.clone();
  // Fresh transposition tables for both engines: otherwise each game inherits
  // hash entries from the previous one and the two sides are not compared on
  // equal footing.
  aEngine.clearHash();
  bEngine.clearHash();
  const aIsWhite = game % 2 === 0;
  let result = null;

  for (let ply = 0; ply < 200; ply++) {
    const terminal = A.adjudicate(position);
    if (terminal) { result = terminal; break; }

    const aToMove = (position.side === 0) === aIsWhite;
    const fen = position.toFen();
    let text;
    if (aToMove) {
      const r = aEngine.go(new A.Position().setFen(fen), limits);
      if (!r.bestMove) { illegal++; result = { result: '0-1', reason: 'A produced no move' }; break; }
      text = A.moves.moveToUci(r.bestMove);
    } else {
      const r = bEngine.go(new B.Position().setFen(fen), limits);
      if (!r.bestMove) { illegal++; result = { result: '1-0', reason: 'B produced no move' }; break; }
      text = B.moves.moveToUci(r.bestMove);
    }
    const move = position.parseMove(text);
    if (!move) { illegal++; result = { result: aToMove ? '0-1' : '1-0', reason: `illegal ${text}` }; break; }
    position.makeMove(move);
  }
  if (!result) result = A.adjudicate(position, true) ?? { result: '1/2-1/2', reason: 'unfinished' };

  if (result.result === '1-0') { if (aIsWhite) wins++; else losses++; }
  else if (result.result === '0-1') { if (aIsWhite) losses++; else wins++; }
  else draws++;
  process.stdout.write(`game ${game + 1}: ${result.result} (${result.reason})\n`);
}

const score = wins + draws / 2;
const rate = score / games;
const elo = rate === 0 ? '-inf' : rate === 1 ? '+inf' : (-400 * Math.log10(1 / rate - 1)).toFixed(0);
console.log(
  `A ${wins} - B ${losses} = ${draws} | score ${score}/${games} (${(rate * 100).toFixed(1)}%) `
  + `| ~${elo} Elo | illegal ${illegal} | ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
