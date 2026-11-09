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
 *   node tools/ab-match.mjs . /tmp/solace-0.1.4 200 nodes:50000
 *   node tools/ab-match.mjs . /tmp/solace-0.1.4 200 movetime:100
 *
 * ``tc`` is ``depth:N`` (fixed depth), ``nodes:N`` (fixed node budget - the
 * "equal work" control, which separates search quality from raw speed) or
 * ``movetime:N`` (milliseconds per move, which is how a game is really played).
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
  console.error('usage: node tools/ab-match.mjs <candidate-root> <baseline-root> [games] [depth:N|nodes:N|movetime:N]');
  process.exit(2);
}
const games = Number(gamesArg ?? 24);
const tc = tcArg ?? 'depth:6';
const tcKind = tc.split(':')[0];
const tcValue = Number(tc.split(':')[1]);
if (!['depth', 'nodes', 'movetime'].includes(tcKind) || !(tcValue > 0)) {
  console.error(`unsupported time control '${tc}' (use depth:N, nodes:N or movetime:N)`);
  process.exit(2);
}
// nodes:N is the "equal work" control: both sides get the same node budget, so
// a tree reduction shows up as a better move rather than as a faster search.
const limits = { [tcKind]: tcValue };

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
// Elo difference implied by a score rate (logistic model).
const toElo = (r) => (r <= 0 ? -Infinity : r >= 1 ? Infinity : -400 * Math.log10(1 / r - 1));
const elo = toElo(rate);

// Standard error of the score rate from the per-game results (a win is 1, a
// draw 0.5, a loss 0), then a 95 % interval converted back to Elo.
const variance = (wins * (1 - rate) ** 2 + losses * (0 - rate) ** 2 + draws * (0.5 - rate) ** 2)
  / Math.max(1, games - 1);
const stderr = Math.sqrt(variance / games);
const lo = Math.max(1e-6, rate - 1.96 * stderr);
const hi = Math.min(1 - 1e-6, rate + 1.96 * stderr);
const eloLo = toElo(lo);
const eloHi = toElo(hi);

const fmt = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(0)}` : `${v > 0 ? '+' : '-'}inf`);
console.log(
  `A ${wins} - B ${losses} = ${draws} | score ${score}/${games} (${(rate * 100).toFixed(1)} %) `
  + `| Elo ${fmt(elo)} (95 %: ${fmt(eloLo)} .. ${fmt(eloHi)}) `
  + `| illegal ${illegal} | ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
if (eloLo > 0) console.log('verdict: A is better at 95 % confidence');
else if (eloHi < 0) console.log('verdict: A is worse at 95 % confidence');
else console.log(`verdict: inconclusive - ${games} games cannot separate these builds`);
