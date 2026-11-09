/**
 * web/app.js
 *
 * SOLACE web UI.  The page owns a Position for rules and rendering; the engine
 * itself runs in a Web Worker (web/engine.worker.js) behind the UCI protocol,
 * exactly the same interface a desktop GUI would use.
 */

import { Position } from '../src/core/position.js';
import { MoveList, moveToUci, moveFrom, moveTo, moveFlag } from '../src/core/moves.js';
import { squareName, WHITE } from '../src/core/types.js';
import { perft } from '../src/search/perft.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const GLYPHS = {
  P: '♟', N: '♞', B: '♝', R: '♜', Q: '♛', K: '♚',
};

const state = {
  position: new Position().setStartPosition(),
  legalMoves: new MoveList(256),
  selected: -1,
  flipped: false,
  lastMove: null,
  history: [START_FEN],
  enginePlays: 'black',
  searchMode: 'time',
  thinkTime: 1000,
  depth: 5,
  promotion: 'q',
  thinking: false,
  searchFen: null,
  gameOver: null,
  hint: null,
  lastInfo: null,
};

const elements = {
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  engineSide: document.getElementById('engineSide'),
  searchMode: document.getElementById('searchMode'),
  thinkTime: document.getElementById('thinkTime'),
  depth: document.getElementById('depth'),
  promotion: document.getElementById('promotion'),
  timeControl: document.getElementById('timeControl'),
  depthControl: document.getElementById('depthControl'),
  flip: document.getElementById('flip'),
  newgame: document.getElementById('newgame'),
  undo: document.getElementById('undo'),
  hint: document.getElementById('hint'),
  copyfen: document.getElementById('copyfen'),
  evalFill: document.getElementById('evalFill'),
  evalText: document.getElementById('evalText'),
  statDepth: document.getElementById('statDepth'),
  statScore: document.getElementById('statScore'),
  statNodes: document.getElementById('statNodes'),
  statNps: document.getElementById('statNps'),
  statTime: document.getElementById('statTime'),
  pv: document.getElementById('pv'),
  fen: document.getElementById('fen'),
  fenInput: document.getElementById('fenInput'),
  loadFen: document.getElementById('loadFen'),
  movelist: document.getElementById('movelist'),
  log: document.getElementById('log'),
  selftest: document.getElementById('selftest'),
  selftestResult: document.getElementById('selftestResult'),
};

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------
let worker = null;
const lineQueue = [];

function startWorker() {
  worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => handleWorkerMessage(event.data);
  worker.onerror = (event) => {
    appendLog(`worker error: ${event.message}`);
    setStatus('Engine worker failed to load. Serve the folder over http:// (not file://).', 'over');
  };
  worker.postMessage({ cmd: 'uci' });
  worker.postMessage({ cmd: 'setoption name Hash value 32' });
}

function send(cmd) {
  if (!worker) {
    lineQueue.push(cmd);
    return;
  }
  worker.postMessage({ cmd });
}

function handleWorkerMessage(data) {
  if (!data) return;
  if (data.type === 'ready') {
    appendLog('engine ready');
    maybeEngineMove();
    return;
  }
  if (data.type === 'error') {
    appendLog(`engine error: ${data.message}`);
    return;
  }
  if (data.type !== 'line') return;
  const line = data.line;
  if (line.startsWith('info depth')) {
    handleInfo(line);
    return;
  }
  if (line.startsWith('bestmove')) {
    handleBestmove(line);
    return;
  }
  if (line.startsWith('uciok') || line.startsWith('readyok')) return;
  if (line.startsWith('info string')) {
    appendLog(line.slice('info string '.length));
    return;
  }
  if (line.startsWith('option name') || line.startsWith('id ')) return;
  appendLog(line);
}

// ---------------------------------------------------------------------------
// Search info
// ---------------------------------------------------------------------------
function handleInfo(line) {
  const info = {};
  const tokens = line.split(/\s+/);
  let pvStart = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case 'depth': info.depth = Number(tokens[++i]); break;
      case 'seldepth': info.seldepth = Number(tokens[++i]); break;
      case 'nodes': info.nodes = Number(tokens[++i]); break;
      case 'nps': info.nps = Number(tokens[++i]); break;
      case 'time': info.time = Number(tokens[++i]); break;
      case 'score':
        info.scoreType = tokens[++i];
        info.scoreValue = Number(tokens[++i]);
        break;
      case 'pv': pvStart = i + 1; i = tokens.length; break;
      default: break;
    }
  }
  if (pvStart >= 0) info.pv = tokens.slice(pvStart).join(' ');
  state.lastInfo = info;

  if (info.depth !== undefined) elements.statDepth.textContent = `${info.depth}${info.seldepth ? ` / ${info.seldepth}` : ''}`;
  if (info.nodes !== undefined) elements.statNodes.textContent = info.nodes.toLocaleString();
  if (info.nps !== undefined) elements.statNps.textContent = `${info.nps.toLocaleString()} nps`;
  if (info.time !== undefined) elements.statTime.textContent = `${(info.time / 1000).toFixed(2)} s`;
  if (info.pv) elements.pv.textContent = info.pv;

  if (info.scoreType === 'mate') {
    const moves = info.scoreValue;
    elements.statScore.textContent = `mate in ${moves}`;
    const whiteMate = state.engineToMoveWhite ? moves > 0 : moves < 0;
    elements.evalText.textContent = `mate in ${Math.abs(moves)} for ${whiteMate ? 'White' : 'Black'}`;
    elements.evalFill.style.width = whiteMate ? '100%' : '0%';
  } else if (info.scoreType === 'cp') {
    // Engine scores are from the point of view of the side that was to move.
    const whiteScore = state.engineToMoveWhite ? info.scoreValue : -info.scoreValue;
    const pawns = whiteScore / 100;
    elements.statScore.textContent = `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
    elements.evalText.textContent = `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)} (White)`;
    // Map -5..+5 pawns onto the bar.
    const clamped = Math.max(-500, Math.min(500, whiteScore));
    elements.evalFill.style.width = `${50 + (clamped / 500) * 50}%`;
  }
}

function handleBestmove(line) {
  const tokens = line.split(/\s+/);
  const moveText = tokens[1];
  state.thinking = false;

  // Ignore replies that belong to a position we have already left.
  if (state.searchFen !== state.position.toFen()) {
    render();
    maybeEngineMove();
    return;
  }

  if (!moveText || moveText === '0000') {
    setStatus('No legal moves for the engine.');
    render();
    return;
  }

  elements.hint.disabled = false;
  if (state.hintRequested) {
    state.hintRequested = false;
    const move = state.position.parseMove(moveText);
    if (move) {
      state.hint = { from: moveFrom(move), to: moveTo(move) };
      setStatus(`Hint: ${moveText}`, '');
    }
    render();
    return;
  }

  const move = state.position.parseMove(moveText);
  if (!move) {
    appendLog(`engine proposed an illegal move: ${moveText}`);
    setStatus(`Engine returned an illegal move (${moveText}); ignored.`, 'over');
    render();
    return;
  }
  applyMove(move);
  render();
  maybeEngineMove();
}

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------
function buildBoard() {
  elements.board.innerHTML = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = document.createElement('div');
      square.className = 'square';
      square.dataset.row = String(row);
      square.dataset.col = String(col);
      square.addEventListener('click', onSquareClick);
      elements.board.appendChild(square);
    }
  }
}

function squareFromRowCol(row, col) {
  // row 0 is the top of the board as displayed.
  const rank = state.flipped ? row : 7 - row;
  const file = state.flipped ? 7 - col : col;
  return rank * 8 + file;
}

function rowColFromSquare(sq) {
  const rank = sq >> 3;
  const file = sq & 7;
  return {
    row: state.flipped ? rank : 7 - rank,
    col: state.flipped ? 7 - file : file,
  };
}

function render() {
  const squares = elements.board.children;
  const checks = state.position.isKingInCheck(state.position.side)
    ? state.position.kingSq[state.position.side]
    : -1;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = squareFromRowCol(row, col);
      const element = squares[row * 8 + col];
      const light = ((sq >> 3) + (sq & 7)) % 2 === 1;
      element.className = `square ${light ? 'light' : 'dark'}`;
      element.innerHTML = '';

      if (sq === state.selected) element.classList.add('selected');
      if (state.lastMove && (state.lastMove.from === sq || state.lastMove.to === sq)) {
        element.classList.add('lastmove');
      }
      if (state.hint && (state.hint.from === sq || state.hint.to === sq)) element.classList.add('hint-from');
      if (sq === checks) element.classList.add('check');

      const code = state.position.board[sq];
      if (code !== 0) {
        const letter = ['', 'P', 'N', 'B', 'R', 'Q', 'K'][code & 7];
        const isWhite = (code >> 3) === WHITE;
        const piece = document.createElement('span');
        piece.textContent = GLYPHS[letter];
        piece.style.color = isWhite ? '#fbfbf7' : '#15181f';
        piece.style.textShadow = isWhite
          ? '0 0 2px #2a2f38, 0 1px 0 #2a2f38'
          : '0 0 1px #000';
        element.appendChild(piece);
      }

      // Legal move markers for the selected piece.
      if (state.selected >= 0 && isLegalTarget(state.selected, sq)) {
        const marker = document.createElement('span');
        marker.className = code === 0 ? 'dot' : 'capture-ring';
        element.appendChild(marker);
      }

      // Coordinates on the edges.
      if (col === 0) {
        const coord = document.createElement('span');
        coord.className = 'coord';
        coord.textContent = squareName(sq)[1];
        element.appendChild(coord);
      }
    }
  }

  elements.fen.textContent = state.position.toFen();
  elements.movelist.textContent = formatMoveList();
  elements.status.className = 'status';

  if (state.gameOver) {
    setStatus(state.gameOver, 'over');
  } else if (state.thinking) {
    setStatus('SOLACE is thinking…', 'thinking');
  } else {
    const side = state.position.side === WHITE ? 'White' : 'Black';
    const engineTurn = isEngineTurn();
    setStatus(`${side} to move${state.position.isKingInCheck(state.position.side) ? ' (in check)' : ''}${engineTurn ? ' — SOLACE' : ''}`);
  }
}

function setStatus(text, kind = '') {
  elements.status.textContent = text;
  elements.status.className = `status ${kind}`.trim();
}

function formatMoveList() {
  const moves = state.moveTexts || [];
  const parts = [];
  for (let i = 0; i < moves.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${moves[i]}${moves[i + 1] ? ' ' + moves[i + 1] : ''}`);
  }
  return parts.join('  ') || '(no moves yet)';
}

function appendLog(text) {
  const line = `${text}\n`;
  elements.log.textContent = (elements.log.textContent + line).slice(-4000);
  elements.log.scrollTop = elements.log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
function isLegalTarget(from, to) {
  for (let i = 0; i < state.legalMoves.count; i++) {
    const move = state.legalMoves.moves[i];
    if (moveFrom(move) === from && moveTo(move) === to) return true;
  }
  return false;
}

function findMove(from, to) {
  const wanted = state.promotion;
  const wantedFlags = { q: [6, 10], r: [8, 12], b: [9, 13], n: [7, 11] }[wanted];
  let fallback = 0;
  for (let i = 0; i < state.legalMoves.count; i++) {
    const move = state.legalMoves.moves[i];
    if (moveFrom(move) !== from || moveTo(move) !== to) continue;
    const flag = moveFlag(move);
    if (wantedFlags && wantedFlags.includes(flag)) return move;
    fallback = move;
  }
  return fallback;
}

function onSquareClick(event) {
  if (state.gameOver) return;
  if (state.thinking && isEngineTurn()) return;
  const row = Number(event.currentTarget.dataset.row);
  const col = Number(event.currentTarget.dataset.col);
  const sq = squareFromRowCol(row, col);
  const code = state.position.board[sq];
  const sideToMove = state.position.side;

  if (state.selected >= 0) {
    if (sq === state.selected) {
      state.selected = -1;
      render();
      return;
    }
    if (isLegalTarget(state.selected, sq)) {
      const move = findMove(state.selected, sq);
      if (move) {
        state.selected = -1;
        state.hint = null;
        applyMove(move);
        render();
        maybeEngineMove();
        return;
      }
    }
  }

  if (code !== 0 && (code >> 3) === sideToMove && !isEngineTurn()) {
    state.selected = sq;
  } else {
    state.selected = -1;
  }
  render();
}

function applyMove(move) {
  const text = moveToUci(move);
  state.position.makeMove(move);
  state.lastMove = { from: moveFrom(move), to: moveTo(move) };
  state.selected = -1;
  state.hint = null;
  state.history.push(state.position.toFen());
  state.moveTexts.push(text);
  refreshLegalMoves();
  checkGameOver();
}

function refreshLegalMoves() {
  state.legalMoves.clear();
  state.position.generateLegalMoves(state.legalMoves);
}

function checkGameOver() {
  if (state.legalMoves.count === 0) {
    state.gameOver = state.position.isKingInCheck(state.position.side)
      ? `Checkmate — ${state.position.side === WHITE ? 'Black' : 'White'} wins`
      : 'Stalemate — draw';
    return;
  }
  if (state.position.halfmove >= 100) {
    state.gameOver = 'Draw by the fifty-move rule';
    return;
  }
  if (state.position.repetitionCount() >= 2) {
    state.gameOver = 'Draw by threefold repetition';
    return;
  }
  if (state.position.hasInsufficientMaterial()) {
    state.gameOver = 'Draw by insufficient material';
    return;
  }
  state.gameOver = null;
}

function isEngineTurn() {
  if (state.enginePlays === 'both') return true;
  if (state.enginePlays === 'none') return false;
  return (state.position.side === WHITE) === (state.enginePlays === 'white');
}

function maybeEngineMove() {
  if (state.gameOver || state.thinking) return;
  if (!isEngineTurn()) return;
  if (state.enginePlays === 'none') return;
  startSearch(false);
}

function startSearch(isHint) {
  if (state.gameOver) return;
  state.thinking = true;
  state.searchFen = state.position.toFen();
  state.hintRequested = isHint;
  state.engineToMoveWhite = state.position.side === WHITE;
  elements.hint.disabled = true;
  render();
  send(`position fen ${state.searchFen}`);
  if (isHint || state.searchMode === 'depth') {
    send(`go depth ${isHint ? Math.max(6, state.depth) : state.depth}`);
  } else {
    send(`go movetime ${isHint ? Math.max(1000, state.thinkTime) : state.thinkTime}`);
  }
}

function stopSearch() {
  if (!worker) return;
  send('stop');
  state.thinking = false;
  elements.hint.disabled = false;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function newGame() {
  stopSearch();
  state.position.setFen(START_FEN);
  state.history = [START_FEN];
  state.moveTexts = [];
  state.lastMove = null;
  state.selected = -1;
  state.hint = null;
  state.gameOver = null;
  state.lastInfo = null;
  state.thinking = false;
  elements.hint.disabled = false;
  refreshLegalMoves();
  elements.statDepth.textContent = '-';
  elements.statScore.textContent = '-';
  elements.statNodes.textContent = '-';
  elements.statNps.textContent = '-';
  elements.statTime.textContent = '-';
  elements.pv.textContent = '-';
  elements.evalText.textContent = '+0.00';
  elements.evalFill.style.width = '50%';
  send('ucinewgame');
  render();
  maybeEngineMove();
}

function undoMove() {
  if (state.thinking) return;
  if (state.history.length <= 1) return;
  const humansTurn = (side) => state.enginePlays === 'both' || state.enginePlays === 'none'
    || (side === WHITE) !== (state.enginePlays === 'white');

  state.history.pop();
  state.moveTexts.pop();
  state.position.setFen(state.history[state.history.length - 1]);
  refreshLegalMoves();
  // If the engine would be to move from the restored position, take back one
  // more ply so that the human gets the move.
  if (!humansTurn(state.position.side) && state.history.length > 1) {
    state.history.pop();
    state.moveTexts.pop();
    state.position.setFen(state.history[state.history.length - 1]);
    refreshLegalMoves();
  }
  state.lastMove = null;
  state.hint = null;
  state.selected = -1;
  state.gameOver = null;
  checkGameOver();
  render();
}

function loadFen() {
  const text = elements.fenInput.value.trim();
  if (!text) return;
  try {
    const position = new Position().setFen(text);
    stopSearch();
    state.position = position;
    state.history = [position.toFen()];
    state.moveTexts = [];
    state.lastMove = null;
    state.selected = -1;
    state.hint = null;
    state.gameOver = null;
    refreshLegalMoves();
    checkGameOver();
    render();
    maybeEngineMove();
  } catch (err) {
    setStatus(`Invalid FEN: ${err.message}`, 'over');
  }
}

function copyFen() {
  const fen = state.position.toFen();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(fen).then(
      () => setStatus('FEN copied to the clipboard'),
      () => setStatus(fen),
    );
  } else {
    setStatus(fen);
  }
}

function runSelfTest() {
  const expected = [20, 400, 8902, 197281];
  const rows = [];
  let allOk = true;
  for (let depth = 1; depth <= 4; depth++) {
    const position = new Position().setStartPosition();
    const started = performance.now();
    const nodes = perft(position, depth);
    const ms = Math.max(1, Math.round(performance.now() - started));
    const ok = nodes === expected[depth - 1];
    if (!ok) allOk = false;
    rows.push(`perft ${depth}: ${nodes} ${ok ? '<span class="ok">ok</span>' : `<span class="bad">expected ${expected[depth - 1]}</span>`} (${ms} ms)`);
  }
  elements.selftestResult.innerHTML = rows.join('<br>') + (allOk ? '<br><span class="ok">move generator verified</span>' : '');
}

function bindControls() {
  elements.engineSide.addEventListener('change', () => {
    state.enginePlays = elements.engineSide.value;
    render();
    maybeEngineMove();
  });

  elements.searchMode.addEventListener('change', () => {
    state.searchMode = elements.searchMode.value;
    elements.timeControl.classList.toggle('hidden', state.searchMode !== 'time');
    elements.depthControl.classList.toggle('hidden', state.searchMode !== 'depth');
  });

  elements.thinkTime.addEventListener('change', () => {
    state.thinkTime = Number(elements.thinkTime.value);
  });

  elements.depth.addEventListener('change', () => {
    state.depth = Number(elements.depth.value);
  });

  elements.promotion.addEventListener('change', () => {
    state.promotion = elements.promotion.value;
  });

  elements.flip.addEventListener('click', () => {
    state.flipped = !state.flipped;
    render();
  });

  elements.newgame.addEventListener('click', newGame);
  elements.undo.addEventListener('click', undoMove);
  elements.copyfen.addEventListener('click', copyFen);
  elements.loadFen.addEventListener('click', loadFen);
  elements.fenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadFen();
  });
  elements.selftest.addEventListener('click', runSelfTest);

  elements.hint.addEventListener('click', () => {
    if (state.thinking || state.gameOver) return;
    startSearch(true);
  });

  document.addEventListener('keydown', (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.key === 'f') {
      state.flipped = !state.flipped;
      render();
    }
    if (event.key === 'n') newGame();
    if (event.key === 'u') undoMove();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  buildBoard();
  bindControls();
  refreshLegalMoves();
  state.moveTexts = [];
  render();
  startWorker();
  for (const cmd of lineQueue) send(cmd);
  lineQueue.length = 0;
}

boot();
