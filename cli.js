#!/usr/bin/env node
/**
 * cli.js - SOLACE command line entry point.
 *
 * Everything works with plain Node.js (no dependencies).  On Android you can
 * run this inside Termux; see README.md.
 *
 *   node cli.js                      UCI mode (also used by GUIs / match tools)
 *   node cli.js play                 friendly interactive board (phone friendly)
 *   node cli.js perft [depth] [fen]  perft node counts
 *   node cli.js bench [depth]        benchmark suite
 *   node cli.js analyze [fen]        search one position and print details
 *   node cli.js selfplay [options]   SOLACE against itself (in-process)
 *   node cli.js match [options]      engine-vs-engine match over UCI processes
 *   node cli.js test [suite]         run the automated test-suite
 *   node cli.js uci                  explicit UCI mode
 */

import { createInterface } from 'node:readline';
import { Position } from './src/core/position.js';
import { UciEngine, ENGINE_VERSION } from './src/uci/uci.js';
import { perft, perftDivide } from './src/search/perft.js';
import { moveToUci, MoveList } from './src/core/moves.js';
import { Searcher } from './src/search/search.js';
import { runBenchmark } from './src/tools/bench.js';
import { evaluate, evaluateBreakdown } from './src/eval/evaluate.js';
import { WHITE } from './src/core/types.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const args = process.argv.slice(2);
const command = args[0] ?? 'uci';

function parseFlags(list) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) {
        flags[key] = list[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// UCI mode
// ---------------------------------------------------------------------------
function runUciMode() {
  const engine = new UciEngine({ output: (line) => process.stdout.write(line + '\n') });
  const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const keepRunning = engine.handleLine(line);
    if (!keepRunning) {
      rl.close();
      shutdown(engine);
    }
  });
  rl.on('close', () => shutdown(engine));
}

function shutdown(engine) {
  const finish = () => process.exit(0);
  if (engine.searching) {
    const wait = setInterval(() => {
      if (!engine.searching) {
        clearInterval(wait);
        finish();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(wait);
      finish();
    }, 5000);
  } else {
    finish();
  }
}

// ---------------------------------------------------------------------------
// Friendly interactive mode (nice on a phone keyboard)
// ---------------------------------------------------------------------------
function runPlayMode() {
  const engine = new UciEngine({
    output: (line) => handleEngineOutput(line),
    applyMovesToPosition: true,
  });
  let quiet = false;
  const history = [START_FEN];

  const say = (text) => process.stdout.write(text + '\n');
  const handleEngineOutput = (line) => {
    if (line.startsWith('info depth') && !quiet) {
      // Keep the terminal calm: show only the final depth report of a search.
      lastInfo = line;
      return;
    }
    if (line.startsWith('bestmove')) {
      if (!quiet && lastInfo) say(lastInfo);
      const move = line.split(/\s+/)[1];
      if (move && move !== '0000') {
        say(`SOLACE plays: ${move}`);
        history.push(engine.position.toFen());
      }
      return;
    }
    if (line.startsWith('info string')) return; // chatty diagnostics are hidden
    say(line);
  };
  let lastInfo = null;

  say(`SOLACE ${ENGINE_VERSION} - interactive mode`);
  say('Type "help" for the command list, "go" to let SOLACE move.');
  printBoard(engine.position, say);

  const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (line === '') return;
    const [cmd, ...rest] = line.split(/\s+/);

    switch (cmd) {
      case 'help':
        say('new                 reset to the starting position');
        say('play <move>         play a move in UCI form, e.g. play e2e4');
        say('go [ms]             SOLACE thinks for <ms> (default 1000) and plays');
        say('depth <n>           let SOLACE search to depth <n> and play');
        say('undo                take back the last two plies');
        say('moves               list the moves played so far');
        say('d                   show the board');
        say('eval                show the static evaluation');
        say('fen                 show the current FEN');
        say('quiet               toggle chatty search output');
        say('quit                leave');
        break;
      case 'new':
        engine.position.setFen(START_FEN);
        history.length = 0;
        history.push(START_FEN);
        printBoard(engine.position, say);
        break;
      case 'play': {
        const text = rest.join('');
        const move = engine.position.parseMove(text);
        if (!move) {
          say(`illegal or unknown move: ${text}`);
          break;
        }
        engine.position.makeMove(move);
        history.push(engine.position.toFen());
        printBoard(engine.position, say);
        break;
      }
      case 'go':
        if (engine.searching) { say('still thinking...'); break; }
        engine.handleLine(`position fen ${engine.position.toFen()}`);
        engine.handleLine(`go movetime ${Number(rest[0]) || 1000}`);
        break;
      case 'depth':
        if (engine.searching) { say('still thinking...'); break; }
        engine.handleLine(`position fen ${engine.position.toFen()}`);
        engine.handleLine(`go depth ${Number(rest[0]) || 5}`);
        break;
      case 'undo': {
        if (engine.searching) { say('still thinking...'); break; }
        history.pop();
        history.pop();
        const fen = history[history.length - 1] ?? START_FEN;
        engine.position.setFen(fen);
        printBoard(engine.position, say);
        break;
      }
      case 'moves':
        say(history.map((fen) => fen.split(' ')[0]).join('\n') === '' ? '(no moves yet)' : `ply ${history.length - 1}`);
        break;
      case 'd':
        printBoard(engine.position, say);
        break;
      case 'eval': {
        const breakdown = evaluateBreakdown(engine.position);
        say(`static eval (side to move): ${(evaluate(engine.position) / 100).toFixed(2)}`);
        say(`white-relative: ${(breakdown.absolute / 100).toFixed(2)} (phase ${breakdown.phase}/24)`);
        break;
      }
      case 'fen':
        say(engine.position.toFen());
        break;
      case 'quiet':
        quiet = !quiet;
        say(`quiet mode ${quiet ? 'on' : 'off'}`);
        break;
      case 'quit':
      case 'exit':
        engine.breakSearchState();
        rl.close();
        process.exit(0);
        break;
      default:
        say(`unknown command "${cmd}" (type "help")`);
        break;
    }
  });
  rl.on('close', () => {
    engine.breakSearchState();
    process.exit(0);
  });
}

function printBoard(position, say) {
  const letters = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
  const lines = [];
  lines.push('    a   b   c   d   e   f   g   h');
  lines.push('  +---+---+---+---+---+---+---+---+');
  for (let rank = 7; rank >= 0; rank--) {
    let row = `${rank + 1} |`;
    for (let file = 0; file < 8; file++) {
      const code = position.board[rank * 8 + file];
      const letter = code === 0 ? ' ' : letters[code & 7];
      row += ` ${code !== 0 && code >> 3 === 0 ? letter : letter.toLowerCase()} |`;
    }
    lines.push(row);
    lines.push('  +---+---+---+---+---+---+---+---+');
  }
  lines.push('    a   b   c   d   e   f   g   h');
  lines.push(`${position.side === WHITE ? 'White' : 'Black'} to move`);
  const inCheck = position.inCheck();
  if (inCheck) lines.push('CHECK!');
  if (!position.hasLegalMoves()) lines.push(inCheck ? 'Checkmate.' : 'Stalemate.');
  for (const line of lines) say(line);
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------
function runPerft(positional) {
  const depth = Number(positional[0] ?? 5);
  const fen = positional.slice(1).join(' ') || START_FEN;
  const position = new Position().setFen(fen);
  console.log(`perft depth ${depth} from ${position.toFen()}`);
  for (let d = 1; d <= depth; d++) {
    const started = Date.now();
    const nodes = perft(position, d);
    const elapsed = Math.max(1, Date.now() - started);
    console.log(`  depth ${d}: ${nodes} nodes (${elapsed} ms, ${Math.round((nodes * 1000) / elapsed)} nps)`);
  }
  if (positional.includes('--divide') || positional.includes('-d')) {
    for (const row of perftDivide(position, depth, moveToUci)) {
      console.log(`  ${row.move}: ${row.nodes}`);
    }
  }
}

function runBench(positional) {
  const depth = Number(positional[0] ?? 5);
  const result = runBenchmark({ depth });
  for (const line of result.lines) console.log(line);
  return result;
}

function runAnalyze(positional) {
  const fen = positional[0] ?? START_FEN;
  const depth = Number(positional[1] ?? 6);
  const position = new Position().setFen(fen);
  const searcher = new Searcher({ hashMB: 32 });
  const result = searcher.go(position, { depth }, (info) => {
    const pv = info.pv.map(moveToUci).join(' ');
    const score = info.mate !== null ? `mate ${info.mate}` : `cp ${info.score}`;
    console.log(`depth ${info.depth} score ${score} nodes ${info.nodes} nps ${info.nps} time ${info.timeMs}ms pv ${pv}`);
  });
  console.log('');
  console.log(`best move: ${result.bestMove ? moveToUci(result.bestMove) : '(none)'}`);
  console.log(`score: ${result.mate !== null ? `mate in ${result.mate}` : `${result.score} cp`}`);
  console.log(`depth ${result.depth} (seldepth ${result.seldepth}), ${result.nodes} nodes, ${result.nps} nps, ${result.timeMs} ms`);
  console.log(`pv: ${result.pv.map(moveToUci).join(' ')}`);
  const legal = new MoveList(256);
  position.generateLegalMoves(legal);
  let ok = false;
  for (let i = 0; i < legal.count; i++) if (legal.moves[i] === result.bestMove) ok = true;
  console.log(`best move legal: ${ok ? 'yes' : 'NO'}`);
}

async function main() {
  const { flags, positional } = parseFlags(args.slice(1));

  switch (command) {
    case 'uci':
      runUciMode();
      break;
    case 'play':
      runPlayMode();
      break;
    case 'perft':
      runPerft(positional);
      break;
    case 'bench': {
      runBench(positional);
      break;
    }
    case 'analyze':
    case 'fen':
      runAnalyze(positional);
      break;
    case 'selfplay': {
      const { runSelfPlay } = await import('./src/tools/selfplay.js');
      runSelfPlay({
        games: Number(flags.games ?? positional[0] ?? 2),
        movetime: Number(flags.movetime ?? 0),
        depth: Number(flags.depth ?? (flags.movetime ? 0 : 5)),
        hashMB: Number(flags.hash ?? 32),
        maxMoves: Number(flags['max-moves'] ?? 240),
        quiet: Boolean(flags.quiet),
        fen: flags.fen ? String(flags.fen) : undefined,
        // --no-openings starts every game from the initial position.
        openings: flags['no-openings'] ? [] : undefined,
      });
      break;
    }
    case 'match': {
      const { runMatch } = await import('./src/tools/match.js');
      const engineCmd = flags.engine ?? 'node cli.js uci';
      const opponent = flags.opponent ?? 'node cli.js uci';
      const games = Number(flags.games ?? 2);
      const tc = flags.tc ?? 'movetime:1000';
      const match = runMatch({
        engineCommand: engineCmd,
        opponentCommand: opponent,
        games,
        timeControl: tc,
        hashMB: Number(flags.hash ?? 32),
        maxMoves: Number(flags['max-moves'] ?? 240),
        verbose: !flags.quiet,
        // --openings "fen1|fen2" or --no-openings for the bare starting position.
        openings: flags.openings
          ? String(flags.openings).split('|').filter(Boolean)
          : flags['no-openings']
            ? [{ name: 'startpos', moves: [] }]
            : undefined,
      });
      await match;
      break;
    }
    case 'test': {
      const { runSuites } = await import('./tests/run.js');
      await runSuites(positional[0]);
      break;
    }
    case 'help':
    default: {
      console.log(`SOLACE ${ENGINE_VERSION} - independent JavaScript chess engine`);
      console.log('');
      console.log('Usage: node cli.js <command> [options]');
      console.log('');
      console.log('  (no command) / uci   UCI protocol on stdin/stdout');
      console.log('  play                 interactive text board (good on a phone)');
      console.log('  perft [depth] [fen]  perft node counts');
      console.log('  bench [depth]        reproducible benchmark');
      console.log('  analyze [fen] [depth]  search one position');
      console.log('  selfplay [--games N] [--depth N|--movetime MS]');
      console.log('  match [--games N] [--tc movetime:1000|depth:6] [--opponent "cmd"]');
      console.log('  test [suite]         run the automated tests');
      break;
    }
  }
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});

export { START_FEN };
