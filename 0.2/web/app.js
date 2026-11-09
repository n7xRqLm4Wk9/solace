/**
 * Solace 0.2 — browser UI.
 *
 * Rules, move generation and FEN handling come from the battle-tested board
 * model of the pure-JavaScript engine in 0.1.5 (read-only import: 0.1.5 is not
 * modified by this folder). The engine doing the thinking is the WebAssembly
 * build of Stockfish in ../engine/.
 */

import { createPosition } from '../../0.1.5/src/core/position.js';
import { MoveList, moveFrom, moveTo, moveToUci, promotionType } from '../../0.1.5/src/core/moves.js';
import { WHITE, BLACK, KING, pieceType, pieceColour } from '../../0.1.5/src/core/types.js';
import { SolaceClient } from '../src/client.js';
import { bookMove, setKeyFunction } from './book.js';
import { OverheadMeter, MIN_OVERHEAD, searchTime } from './overhead.js';
import { ThrottleGuard } from './thermal.js';
import { NET_NAME, deviceProfile, engineFiles, pickVariant } from '../src/config.js';

const GLYPHS = { [1]: '♟', [2]: '♞', [3]: '♝', [4]: '♜', [5]: '♛', [6]: '♚' };
const WHITE_GLYPHS = { [1]: '♙', [2]: '♘', [3]: '♗', [4]: '♖', [5]: '♕', [6]: '♔' };

const ui = {
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  progressWrap: document.getElementById('progress-wrap'),
  progress: document.getElementById('progress'),
  side: document.getElementById('side'),
  strength: document.getElementById('strength'),
  movetime: document.getElementById('movetime'),
  newGame: document.getElementById('new-game'),
  undo: document.getElementById('undo'),
  flip: document.getElementById('flip'),
  eval: document.getElementById('eval'),
  moves: document.getElementById('move-list'),
  promotion: document.getElementById('promotion'),
  book: document.getElementById('book'),
  device: document.getElementById('device'),
};

// Learns this device's Move Overhead instead of assuming a desktop default.
const overheadMeter = new OverheadMeter();
// Notices thermal throttling from the nodes/second the engine reports.
const throttle = new ThrottleGuard();
// What this device can afford, filled in during startEngine().
const profile = deviceProfile();

const game = {
  position: createPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
  history: [], // { uci, fenBefore }
  moves: [],
  playerColor: WHITE,
  flipped: false,
  selected: null,
  lastMove: null,
  legal: new MoveList(256),
  thinking: false,
  engineMoveCount: 0,
  gameOver: false,
};

let engine = null;

// ---------------------------------------------------------------------------
// opening book: only the first plies are randomised, so games differ
// ---------------------------------------------------------------------------

function keyAfterMoves(moves) {
  let pos;
  try {
    pos = createPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    for (const uci of moves) {
      const list = new MoveList(256);
      pos.generateLegalMoves(list);
      let applied = false;
      for (let i = 0; i < list.count; i++) {
        if (moveToUci(list.moves[i]) === uci) {
          pos.makeMove(list.moves[i]);
          applied = true;
          break;
        }
      }
      if (!applied) return null;
    }
  } catch {
    return null;
  }
  return pos.toFen().split(' ').slice(0, 4).join(' ');
}

setKeyFunction(keyAfterMoves);

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

async function startEngine() {
  setStatus('Loading engine…');
  ui.progressWrap.hidden = false;
  try {
    engine = await loadEngine(pickVariant());

    engine.on('net', ({ loaded, total }) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      ui.progress.style.width = `${pct}%`;
      setStatus(`Downloading network… ${pct}%`);
    });

    engine.on('info', (info) => {
      if (info.nps) feedThroughput(info.nps);
      if (info.score || info.depth) showInfo(info);
    });

    engine.on('bestmove', (line) => onBestMove(line));
    engine.on('error', ({ message }) => setStatus(message, true));

    engine.position(null);
    // Mobile defaults: a hash sized to the device, one search thread, and a
    // think time the phone can actually deliver.
    engine.setOption('Hash', String(profile.hashMB));
    engine.setOption('Threads', String(profile.threads));
    engine.setOption('Move Overhead', String(MIN_OVERHEAD));
    overheadMeter.markApplied();
    applyDefaultThinkTime();
    showDeviceHint();
    ui.progressWrap.hidden = true;
    setStatus('Ready');
    applyStrength();
    maybeEngineMove();
  } catch (err) {
    ui.progressWrap.hidden = true;
    setStatus(
      `${err.message} — is assets/${NET_NAME} present? Run "node scripts/fetch-net.mjs".`,
      true,
    );
  }
}

/**
 * Starts the engine on the best build this runtime can run. A build can also be
 * missing (only one variant was compiled), so a failed relaxed load falls back
 * to the plain SIMD build instead of leaving the page broken.
 */
async function loadEngine(variant) {
  const files = engineFiles(variant);
  setStatus(`Loading engine (${variant === 'relaxed' ? 'relaxed SIMD' : 'SIMD'})…`);
  try {
    return await SolaceClient.start({
      workerUrl: '../src/worker.js',
      moduleUrl: `../engine/${files.js}`,
      wasmUrl: `../engine/${files.wasm}`,
      netUrl: `../assets/${NET_NAME}`,
      onStatus: ({ state, detail }) => {
        if (state === 'error') setStatus(detail || 'engine error', true);
      },
    });
  } catch (err) {
    if (variant !== 'relaxed') throw err;
    setStatus('Relaxed SIMD build unavailable, using the SIMD build…');
    return loadEngine('simd');
  }
}

function applyStrength() {
  if (!engine) return;
  const mode = ui.strength.value;
  if (mode === 'full') {
    engine.setOption('Skill Level', 20);
    engine.setOption('UCI_LimitStrength', 'false');
    return;
  }
  const skill = { club: 10, casual: 5, beginner: 0 }[mode] ?? 20;
  engine.setOption('Skill Level', skill);
}

function askEngineToMove() {
  if (!engine || game.gameOver) return;
  const sideToMove = game.position.side;
  if (sideToMove === game.playerColor) return;

  // Opening variety: play a book move for the first plies when there is one.
  if (game.moves.length < 6 && ui.book.checked) {
    const candidate = bookMove(game.moves);
    if (candidate && playUci(candidate)) {
      maybeEngineMove();
      return;
    }
  }

  game.thinking = true;
  setStatus('Solace is thinking…');
  engine.position(game.position.toFen(), []);
  // The budget the player chose, minus what this browser needs to hand the
  // answer back (see searchTime(): a `go movetime` search ignores `Move
  // Overhead`, so the reserve has to come off the request itself).
  const time = searchTime({
    requested: Number(ui.movetime.value) || 1000,
    factor: throttle.factor,
    reserve: reserve() + (game.wakeReserve || 0),
  });
  game.wakeReserve = 0;
  // Timed so the page can learn how late this browser answers (overhead.js).
  game.searchStarted = performance.now();
  game.searchRequested = time;
  engine.send(`go movetime ${time}`);
}

function onBestMove(line) {
  game.thinking = false;
  learnOverhead();
  const [, move] = line.split(/\s+/);
  if (!move || move === '(none)') {
    finishIfOver();
    return;
  }
  playUci(move);
  maybeEngineMove();
}

// ---------------------------------------------------------------------------
// game flow
// ---------------------------------------------------------------------------

/**
 * Measures how much later than requested the engine answered, and raises the
 * engine's Move Overhead when this browser is consistently late. Stockfish
 * stops `go movetime X` at `X - Move Overhead`; the reserve has to cover the
 * task hop, the wasm boundary and the occasional garbage collection.
 */
/**
 * The reserve this browser needs right now: what the last searches measured,
 * plus what thermal throttling adds. Kept as one function so the measured value
 * (which is recomputed from samples every move) is never overwritten by the
 * throttle term.
 */
function reserve() {
  return overheadMeter.current + throttle.overheadBonus();
}

function learnOverhead() {
  if (!game.searchStarted || !game.searchRequested) return;
  overheadMeter.record(game.searchRequested, performance.now() - game.searchStarted);
  game.searchStarted = 0;
  // `Move Overhead` only affects clock-based searches, but the CLI and any UCI
  // client share the same engine settings, so keep it in step anyway.
  if (overheadMeter.shouldUpdate()) {
    engine.setOption('Move Overhead', String(reserve()));
    overheadMeter.markApplied();
  }
}

function maybeEngineMove() {
  if (game.gameOver || !engine) return;
  if (game.position.side !== game.playerColor) setTimeout(askEngineToMove, 60);
}

function playUci(uci) {
  const list = new MoveList(256);
  game.position.generateLegalMoves(list);
  for (let i = 0; i < list.count; i++) {
    if (moveToUci(list.moves[i]) === uci) {
      applyMove(list.moves[i], uci);
      return true;
    }
  }
  setStatus(`engine returned an illegal move: ${uci}`, true);
  return false;
}

function applyMove(move, uci) {
  const fenBefore = game.position.toFen();
  game.history.push({ uci, fenBefore });
  game.position.makeMove(move);
  game.moves.push(uci);
  game.lastMove = uci;
  game.selected = null;
  render();
  finishIfOver();
}

function finishIfOver() {
  const list = new MoveList(256);
  game.position.generateLegalMoves(list);
  if (list.count === 0) {
    game.gameOver = true;
    setStatus(game.position.inCheck() ? 'Checkmate' : 'Stalemate');
    return true;
  }
  if (game.position.hasInsufficientMaterial?.()) {
    game.gameOver = true;
    setStatus('Draw (insufficient material)');
    return true;
  }
  if (game.position.repetitionCount?.() >= 3) {
    game.gameOver = true;
    setStatus('Draw (threefold repetition)');
    return true;
  }
  setStatus(game.position.inCheck() ? 'Check' : '');
  return false;
}

function newGame() {
  game.position = createPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  game.history = [];
  game.moves = [];
  game.selected = null;
  game.lastMove = null;
  game.gameOver = false;
  game.playerColor = ui.side.value === 'black' ? BLACK : WHITE;
  if (engine) {
    engine.send('ucinewgame');
    engine.position(null);
    applyStrength();
  }
  ui.eval.textContent = '';
  render();
  maybeEngineMove();
}

function undo() {
  if (game.thinking || game.history.length === 0) return;
  // take back the engine reply and the player move when possible
  const takeBack = game.position.side === game.playerColor ? 2 : 1;
  for (let i = 0; i < takeBack && game.history.length; i++) {
    const entry = game.history.pop();
    game.moves.pop();
    game.position = createPosition(entry.fenBefore);
  }
  game.gameOver = false;
  game.selected = null;
  game.lastMove = game.history.at(-1)?.uci ?? null;
  render();
  ui.eval.textContent = '';
}

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

function legalMoves() {
  const list = new MoveList(256);
  game.position.generateLegalMoves(list);
  return list;
}

function onSquareClick(sq) {
  if (!engine || game.gameOver || game.thinking) return;
  if (game.position.side !== game.playerColor) return;

  const list = legalMoves();
  if (game.selected !== null) {
    const candidates = [];
    for (let i = 0; i < list.count; i++) {
      const m = list.moves[i];
      if (moveFrom(m) === game.selected && moveTo(m) === sq) candidates.push(m);
    }
    if (candidates.length === 1) {
      applyMove(candidates[0], moveToUci(candidates[0]));
      maybeEngineMove();
      return;
    }
    if (candidates.length > 1) {
      askPromotion(candidates);
      return;
    }
  }

  const piece = game.position.board[sq];
  if (piece && pieceColour(piece) === game.playerColor) game.selected = sq;
  else game.selected = null;
  render();
}

function askPromotion(candidates) {
  const container = ui.promotion.querySelector('.promotion-pieces');
  container.innerHTML = '';
  ui.promotion.hidden = false;
  for (const move of candidates) {
    const type = promotionType(move);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = GLYPHS[type] || '?';
    btn.addEventListener('click', () => {
      ui.promotion.hidden = true;
      applyMove(move, moveToUci(move));
      maybeEngineMove();
    });
    container.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  ui.board.innerHTML = '';
  const list = legalMoves();
  const targets = new Map();
  if (game.selected !== null) {
    for (let i = 0; i < list.count; i++) {
      const m = list.moves[i];
      if (moveFrom(m) === game.selected) {
        const to = moveTo(m);
        targets.set(to, Boolean(game.position.board[to]));
      }
    }
  }

  const kingSquare = findKing();
  const inCheck = game.position.inCheck();

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = game.flipped ? row : 7 - row;
      const file = game.flipped ? 7 - col : col;
      const sq = rank * 8 + file;
      const cell = document.createElement('div');
      cell.className = `square ${(rank + file) % 2 === 0 ? 'dark' : 'light'}`;
      cell.dataset.square = String(sq);
      if (game.lastMove && (moveFromUci(game.lastMove) === sq || moveToUciTarget(game.lastMove) === sq))
        cell.classList.add('last-move');
      if (game.selected === sq) cell.classList.add('selected');
      if (targets.has(sq)) cell.classList.add('target', ...(targets.get(sq) ? ['capture'] : []));
      if (inCheck && sq === kingSquare) cell.classList.add('check');

      const code = game.position.board[sq];
      if (code) {
        const span = document.createElement('span');
        const colour = pieceColour(code);
        span.className = `piece ${colour === WHITE ? 'white' : 'black'}`;
        span.textContent = colour === WHITE ? WHITE_GLYPHS[pieceType(code)] : GLYPHS[pieceType(code)];
        cell.appendChild(span);
      }
      if (file === 7) {
        const label = document.createElement('span');
        label.className = 'coord rank';
        label.textContent = String(rank + 1);
        cell.appendChild(label);
      }
      if (rank === 0) {
        const label = document.createElement('span');
        label.className = 'coord file';
        label.textContent = 'abcdefgh'[file];
        cell.appendChild(label);
      }
      cell.addEventListener('click', () => onSquareClick(sq));
      ui.board.appendChild(cell);
    }
  }

  renderMoves();
  ui.undo.disabled = game.thinking || game.history.length === 0;
}

function findKing() {
  const kingCode = KING + (game.position.side << 3);
  for (let sq = 0; sq < 64; sq++) if (game.position.board[sq] === kingCode) return sq;
  return -1;
}

function renderMoves() {
  ui.moves.innerHTML = '';
  for (let i = 0; i < game.moves.length; i += 2) {
    const li = document.createElement('li');
    li.textContent = `${game.moves[i]} ${game.moves[i + 1] || ''}`.trim();
    ui.moves.appendChild(li);
  }
  ui.moves.scrollTop = ui.moves.scrollHeight;
}

/**
 * The eval readout is redrawn at most once per animation frame. Engine output
 * arrives far faster than the screen refreshes, and writing to the DOM for
 * every `info` line is one of the cheapest ways to make a phone stutter.
 */
let pendingInfo = null;
let infoFrame = 0;

function showInfo(info) {
  pendingInfo = info;
  if (infoFrame) return;
  infoFrame = requestAnimationFrame(() => {
    infoFrame = 0;
    const shown = pendingInfo;
    if (!shown) return;
    const parts = [];
    if (shown.depth) parts.push(`depth ${shown.depth}`);
    if (shown.score) {
      const { type, value } = shown.score;
      parts.push(type === 'mate' ? `#${value > 0 ? '' : '-'}${Math.abs(value)}` : (value / 100).toFixed(2));
    }
    if (shown.nps) parts.push(`${(shown.nps / 1e3).toFixed(0)} kn/s`);
    ui.eval.textContent = parts.join('  ');
  });
}

/** Feeds the search rate to the throttle detector and adapts if the phone is hot. */
function feedThroughput(nps) {
  const wasHot = throttle.hot;
  const state = throttle.observe(nps);
  if (!state.hot) {
    if (wasHot) setStatus('Device cooled down — back to full thinking time');
    return;
  }

  // A hot device needs a bigger reserve for everything around the search, and
  // the next `go movetime` is shortened by searchTime() using throttle.factor.
  engine.setOption('Move Overhead', String(reserve()));
  overheadMeter.markApplied();
  if (!wasHot)
    setStatus(`Phone is warming up — ${Math.round(state.factor * 100)}% think time to stay smooth`);
}

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', Boolean(isError));
}

function moveFromUci(uci) {
  return (uci.charCodeAt(0) - 97) + (Number(uci[1]) - 1) * 8;
}

function moveToUciTarget(uci) {
  return (uci.charCodeAt(2) - 97) + (Number(uci[3]) - 1) * 8;
}

// ---------------------------------------------------------------------------
// mobile behaviour
// ---------------------------------------------------------------------------

/** Preselects the think time this device can keep up with. */
function applyDefaultThinkTime() {
  const options = [...ui.movetime.options].map((o) => Number(o.value));
  const closest = options.reduce(
    (best, v) => (Math.abs(v - profile.thinkTime) < Math.abs(best - profile.thinkTime) ? v : best),
    options[0],
  );
  ui.movetime.value = String(closest);
}

/** Tells the player what the page decided, so nothing is silently different. */
function showDeviceHint() {
  const note = `This device: ${profile.tier} profile, ${profile.hashMB} MB hash, optimised for phones`;
  if (ui.device) {
    ui.device.textContent = note;
    return;
  }
  const line = document.createElement('p');
  line.className = 'fineprint device-hint';
  line.textContent = note;
  ui.status.after(line);
}

/**
 * A hidden tab is not a paused engine: the search keeps running on its worker
 * thread, burns battery and heats the phone for a move nobody is looking at,
 * and when the tab comes back the browser has throttled its timers so much that
 * the first answer arrives late. So the pending search is stopped outright and
 * re-issued on return, with a larger time reserve for the first move back.
 */
function handleVisibility() {
  if (document.hidden) {
    if (game.thinking && engine) {
      engine.send('stop');
      game.paused = true;
    }
    return;
  }
  if (!game.paused) return;
  game.paused = false;
  // Timers were throttled while the tab was hidden, so the first answer back is
  // going to be late; reserve extra for that one move.
  game.wakeReserve = 150;
  overheadMeter.reset();
  game.thinking = false;
  setStatus('Back — continuing the game');
  maybeEngineMove();
}

document.addEventListener('visibilitychange', handleVisibility);

ui.newGame.addEventListener('click', newGame);
ui.undo.addEventListener('click', undo);
ui.flip.addEventListener('click', () => {
  game.flipped = !game.flipped;
  render();
});
ui.side.addEventListener('change', newGame);
ui.strength.addEventListener('change', applyStrength);

render();
startEngine();
