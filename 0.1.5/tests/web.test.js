/**
 * tests/web.test.js
 *
 * Integration tests for the browser build.  There is no real DOM in Node, so a
 * small stub implements exactly the handful of DOM/Worker APIs that web/app.js
 * and web/engine.worker.js use.  This catches broken wiring (missing elements,
 * worker protocol mistakes, crashes during rendering) without a browser.
 */

import { test, assert, assertEqual } from './harness.js';

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------
class ClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.set.has(name)) this.set.delete(name); else this.set.add(name);
    } else if (force) {
      this.set.add(name);
    } else {
      this.set.delete(name);
    }
  }
  contains(name) { return this.set.has(name); }
  toString() { return [...this.set].join(' '); }
}

class StubElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this.listeners = {};
    this._textContent = '';
    this._innerHTML = '';
    this.disabled = false;
    this.value = '';
  }

  get className() { return this.classList.toString(); }

  set className(value) {
    this.classList = new ClassList();
    for (const part of String(value).split(/\s+/)) if (part) this.classList.add(part);
  }

  get textContent() { return this._textContent; }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get innerHTML() { return this._innerHTML; }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (value === '') this.children = [];
    // Extract the text so tests can inspect it.
    this._textContent = String(value).replace(/<[^>]*>/g, '');
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] ?? []).push(handler);
  }

  dispatch(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }

  get scrollHeight() { return 0; }
}

class StubWorker {
  constructor(url) {
    this.url = url;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    StubWorker.instances.push(this);
  }

  postMessage(message) {
    this.posted.push(message);
  }

  emit(payload) {
    if (this.onmessage) this.onmessage({ data: payload });
  }
}
StubWorker.instances = [];

function installDomStub() {
  const elements = new Map();
  const ids = [
    'board', 'status', 'engineSide', 'searchMode', 'thinkTime', 'depth', 'promotion',
    'timeControl', 'depthControl', 'flip', 'newgame', 'undo', 'hint', 'copyfen',
    'evalFill', 'evalText', 'statDepth', 'statScore', 'statNodes', 'statNps', 'statTime',
    'pv', 'fen', 'fenInput', 'loadFen', 'movelist', 'log', 'selftest', 'selftestResult',
  ];
  for (const id of ids) {
    const element = new StubElement(id === 'fenInput' ? 'input' : 'div');
    element.id = id;
    if (id === 'engineSide') element.value = 'black';
    if (id === 'searchMode') element.value = 'time';
    if (id === 'thinkTime') element.value = '1000';
    if (id === 'depth') element.value = '5';
    if (id === 'promotion') element.value = 'q';
    elements.set(id, element);
  }

  const documentStub = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new StubElement(tag),
    addEventListener: () => {},
    body: new StubElement('body'),
  };

  globalThis.document = documentStub;
  globalThis.Worker = StubWorker;
  globalThis.window = globalThis;
  // Node >= 21 exposes `navigator` as a getter-only global; only polyfill when absent.
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  }
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
  return { elements, documentStub };
}

const dom = installDomStub();

// Import the page script once; boot() runs immediately.
await import('../web/app.js');

function workerStub() {
  if (StubWorker.instances.length === 0) throw new Error('no worker was created');
  return StubWorker.instances[StubWorker.instances.length - 1];
}

function boardSquares() {
  return dom.elements.get('board').children;
}

function clickSquare(row, col) {
  const square = boardSquares()[row * 8 + col];
  square.dispatch('click', { currentTarget: square });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('web UI builds a board with 64 squares and starts the engine worker', () => {
  assertEqual(boardSquares().length, 64, 'board has 64 squares');
  assert(workerStub().posted.some((m) => m.cmd === 'uci'), 'worker received the uci handshake');
  assertEqual(dom.elements.get('fen').textContent, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert(dom.elements.get('status').textContent.includes('White to move'), 'status shows the side to move');
});

test('clicking a piece and a destination plays a legal move', () => {
  // e2 is row 6, column 4 on an unflipped board; e4 is row 4, column 4.
  clickSquare(6, 4);
  assert(dom.elements.get('status').textContent.includes('White to move'), 'status unchanged while selecting');
  clickSquare(4, 4);
  assert(dom.elements.get('fen').textContent.startsWith('rnbqkbnr/pppppppp/8/8/4P3'),
    `pawn moved to e4 (fen: ${dom.elements.get('fen').textContent})`);
  assert(dom.elements.get('movelist').textContent.includes('e2e4'), 'move list updated');
});

test('an illegal destination is rejected', () => {
  const before = dom.elements.get('fen').textContent;
  // Try to move the a1 rook like a knight: a1 (row 7, col 0) -> b3 (row 5, col 1).
  clickSquare(7, 0);
  clickSquare(5, 1);
  assertEqual(dom.elements.get('fen').textContent, before, 'position did not change');
});

test('the engine plays its move when it is to move', async () => {
  const worker = workerStub();
  // The human move above handed the turn to Black, and the default is "SOLACE
  // plays black", so the page must have asked the worker to search.
  assert(worker.posted.some((m) => typeof m.cmd === 'string' && m.cmd.startsWith('go ')),
    'a search was requested after the human move');
  const goMessage = worker.posted.filter((m) => m.cmd && m.cmd.startsWith('position fen')).pop();
  assert(goMessage, 'position was sent');

  // Feed a legal black reply (e7e5) back to the page as if the worker had found it.
  worker.emit({ type: 'line', line: 'info depth 5 seldepth 9 multipv 1 score cp -32 nodes 4000 nps 200000 time 20 pv e7e5' });
  worker.emit({ type: 'line', line: 'bestmove e7e5 ponder g1f3' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert(dom.elements.get('fen').textContent.startsWith('rnbqkbnr/pppp1ppp/8/4p3/4P3'),
    `engine reply applied (fen: ${dom.elements.get('fen').textContent})`);
  assertEqual(dom.elements.get('statDepth').textContent, '5 / 9', 'depth statistic displayed');
});

test('the engine worker module runs the UCI engine', async () => {
  // Load the worker module with a fake `self`, exactly as a browser would.
  const messages = [];
  const fakeSelf = {
    postMessage: (payload) => messages.push(payload),
    onmessage: null,
  };
  const previousSelf = globalThis.self;
  globalThis.self = fakeSelf;
  try {
    await import(`../web/engine.worker.js?worker-test=${Date.now()}`);
    assert(messages.some((m) => m.type === 'ready'), 'worker announced ready');
    assert(typeof fakeSelf.onmessage === 'function', 'worker installed a message handler');

    fakeSelf.onmessage({ data: { cmd: 'uci' } });
    assert(messages.some((m) => m.type === 'line' && m.line === 'uciok'), 'uci handshake answered');

    fakeSelf.onmessage({ data: { cmd: 'position startpos' } });
    fakeSelf.onmessage({ data: { cmd: 'go depth 2' } });

    const started = Date.now();
    let bestmove = null;
    while (Date.now() - started < 15000) {
      const line = messages.find((m) => m.type === 'line' && m.line.startsWith('bestmove'));
      if (line) {
        bestmove = line.line.split(/\s+/)[1];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(bestmove && bestmove !== '0000', `worker produced a bestmove (${bestmove})`);

    fakeSelf.onmessage({ data: { cmd: 'quit' } });
  } finally {
    globalThis.self = previousSelf;
  }
});

test('new game resets the board through the UI', () => {
  dom.elements.get('newgame').dispatch('click', {});
  assertEqual(dom.elements.get('fen').textContent,
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert(dom.elements.get('status').textContent.includes('White to move'));
});

test('loading an invalid FEN reports an error instead of crashing', () => {
  const input = dom.elements.get('fenInput');
  input.value = 'this-is-not-a-fen';
  dom.elements.get('loadFen').dispatch('click', {});
  assert(dom.elements.get('status').textContent.includes('Invalid FEN'),
    'invalid FEN reported in the status line');
  input.value = '';
});

test('perft self-test in the page reports the reference counts', () => {
  dom.elements.get('selftest').dispatch('click', {});
  const text = dom.elements.get('selftestResult').textContent;
  assert(text.includes('20'), 'perft 1');
  assert(text.includes('400'), 'perft 2');
  assert(text.includes('8902'), 'perft 3');
  assert(text.includes('197281'), 'perft 4');
  assert(text.includes('verified'), 'self-test reports success');
});
