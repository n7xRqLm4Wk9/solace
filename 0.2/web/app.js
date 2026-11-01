/**
 * Solace 0.2 — browser UI.
 *
 * Rules, move generation and FEN handling come from the battle-tested board
 * model of the pure-JavaScript engine in 0.1.5 (read-only import: 0.1.5 is not
 * modified by this folder). The engine doing the thinking is the WebAssembly
 * build of Stockfish in ../dist/.
 */

import { createPosition } from '../../0.1.5/src/core/position.js';
import { MoveList, moveFrom, moveTo, moveToUci, promotionType } from '../../0.1.5/src/core/moves.js';
import { WHITE, BLACK, KING, pieceType, pieceColour } from '../../0.1.5/src/core/types.js';
import { SolaceClient } from '../src/client.js';
import { NET_NAME } from '../src/config.js';

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
};

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
// engine
// ---------------------------------------------------------------------------

async function startEngine() {
  setStatus('Loading engine…');
  ui.progressWrap.hidden = false;
  try {
    engine = await SolaceClient.start({
      workerUrl: '../src/worker.js',
      moduleUrl: '../dist/solace.js',
      wasmUrl: '../dist/solace.wasm',
      netUrl: `../assets/${NET_NAME}`,
      onStatus: ({ state, detail }) => {
        if (state === 'error') setStatus(detail || 'engine error', true);
      },
    });

    engine.on('net', ({ loaded, total }) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      ui.progress.style.width = `${pct}%`;
      setStatus(`Downloading network… ${pct}%`);
    });

    engine.on('line', (line) => {
      if (line.startsWith('info ') && line.includes(' score ')) showInfo(line);
    });

    engine.on('bestmove', (line) => onBestMove(line));
    engine.on('error', ({ message }) => setStatus(message, true));

    engine.position(null);
    ui.progressWrap.hidden = true;
    setStatus('Ready');
    applyStrength();
    maybeEngineMove();
  } catch (err) {
    ui.progressWrap.hidden = true;
    setStatus(
      `${err.message} — is assets/${NET_NAME} present? Run "node build/fetch-net.mjs".`,
      true,
    );
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

  game.thinking = true;
  setStatus('Solace is thinking…');
  engine.position(game.position.toFen(), []);
  const time = Number(ui.movetime.value) || 1000;
  engine.send(`go movetime ${time}`);
}

function onBestMove(line) {
  game.thinking = false;
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

function showInfo(line) {
  const depth = /depth (\d+)/.exec(line)?.[1];
  const score = /score (cp|mate) (-?\d+)/.exec(line);
  const nps = /nps (\d+)/.exec(line)?.[1];
  let text = '';
  if (depth) text += `depth ${depth}`;
  if (score) {
    const value = Number(score[2]);
    const shown = score[1] === 'mate' ? `#${value > 0 ? '' : '-'}${Math.abs(value)}` : (value / 100).toFixed(2);
    text += `  ${shown}`;
  }
  if (nps) text += `  ${(Number(nps) / 1e6).toFixed(2)} Mn/s`;
  ui.eval.textContent = text;
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
