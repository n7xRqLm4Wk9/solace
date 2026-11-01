/**
 * Solace 0.2 — page-side client.
 *
 * Starts the worker from src/worker.js and gives the UI a small, promise
 * friendly UCI interface on top of it:
 *
 *     const engine = await SolaceClient.start({ workerUrl, wasmUrl, netUrl });
 *     engine.on('line', console.log);
 *     engine.send('position startpos');
 *     engine.send('go depth 12');
 *
 * Everything the engine prints is forwarded unchanged, so the UI can either
 * listen to raw lines or use the parsed events below.
 */

export class SolaceClient {
  #worker;
  #lines = [];
  #listeners = new Map();
  #ready = false;
  #started;

  constructor(worker) {
    this.#worker = worker;
    worker.onmessage = (event) => this.#onMessage(event.data || {});
    worker.onerror = (event) => {
      this.#emit('error', { message: event.message || 'worker error' });
    };
  }

  static start({ workerUrl = '../src/worker.js', wasmUrl, netUrl, moduleUrl, onStatus } = {}) {
    const worker = new Worker(workerUrl, { type: 'module' });
    const client = new SolaceClient(worker);
    if (onStatus) client.on('status', onStatus);
    client.#started = new Promise((resolve, reject) => {
      const offStatus = client.on('status', ({ state, detail }) => {
        if (state === 'ready') {
          offStatus();
          client.#ready = true;
          resolve(client);
        } else if (state === 'error') {
          offStatus();
          reject(new Error(detail || 'engine failed to start'));
        }
      });
      client.on('error', ({ message }) => client.#emit('status', { state: 'error', detail: message }));
    });
    worker.postMessage({ type: 'init', wasmUrl, netUrl, moduleUrl });
    return client.#started;
  }

  get ready() {
    return this.#ready;
  }

  /** Sends one UCI command line. */
  send(line) {
    this.#worker.postMessage({ type: 'cmd', line: String(line) });
  }

  /** Subscribes to an event ('line', 'info', 'bestmove', 'status', 'net'). */
  on(event, handler) {
    const list = this.#listeners.get(event) || [];
    list.push(handler);
    this.#listeners.set(event, list);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Resolves with the first output line matching `pattern`. */
  waitFor(pattern, timeoutMs = 30000) {
    const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.on('line', (line) => {
        if (re.test(line)) {
          off();
          clearTimeout(timer);
          resolve(line);
        }
      });
      timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${re}`));
      }, timeoutMs);
    });
  }

  /** `isready` / `readyok` round trip. */
  async isReady(timeoutMs = 120000) {
    const done = this.waitFor(/^readyok/, timeoutMs);
    this.send('isready');
    await done;
    return this;
  }

  /** Moves the engine to `fen` (or the start position) plus optional moves. */
  position(fen, moves = []) {
    const base = !fen || fen === 'startpos' ? 'position startpos' : `position fen ${fen}`;
    this.send(moves.length ? `${base} moves ${moves.join(' ')}` : base);
  }

  setOption(name, value) {
    this.send(`setoption name ${name} value ${value}`);
  }

  /** Starts a search and resolves with the UCI info lines and the best move. */
  async go(limits, { timeoutMs = 300000 } = {}) {
    const infos = [];
    const off = this.on('line', (line) => {
      if (line.startsWith('info ') && line.includes(' score ')) infos.push(parseInfo(line));
    });
    const best = this.waitFor(/^bestmove/, timeoutMs);
    this.send(`go ${limits}`.trim());
    const line = await best;
    off();
    const [, move, ponder] = line.split(/\s+/);
    return { bestmove: move === '(none)' ? null : move, ponder: ponder || null, info: infos, last: infos.at(-1) || null };
  }

  quit() {
    this.#worker.postMessage({ type: 'quit' });
    this.#worker.terminate();
  }

  #onMessage(msg) {
    if (msg.type === 'line') {
      this.#lines.push(msg.line);
      this.#emit('line', msg.line);
      if (msg.line.startsWith('info ')) this.#emit('info', parseInfo(msg.line));
      else if (msg.line.startsWith('bestmove')) this.#emit('bestmove', msg.line);
    } else if (msg.type === 'status') {
      this.#emit('status', msg);
    } else if (msg.type === 'net') {
      this.#emit('net', msg);
    } else if (msg.type === 'error') {
      this.#emit('error', msg);
    }
  }

  #emit(event, payload) {
    for (const handler of this.#listeners.get(event) || []) handler(payload);
  }
}

/** Parses the useful fields of a UCI `info` line. */
export function parseInfo(line) {
  const out = { raw: line };
  const tokens = line.split(/\s+/);
  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        out.depth = Number(tokens[++i]);
        break;
      case 'seldepth':
        out.seldepth = Number(tokens[++i]);
        break;
      case 'multipv':
        out.multipv = Number(tokens[++i]);
        break;
      case 'nodes':
        out.nodes = Number(tokens[++i]);
        break;
      case 'nps':
        out.nps = Number(tokens[++i]);
        break;
      case 'time':
        out.time = Number(tokens[++i]);
        break;
      case 'hashfull':
        out.hashfull = Number(tokens[++i]);
        break;
      case 'score':
        i++;
        if (tokens[i] === 'cp') out.score = { type: 'cp', value: Number(tokens[++i]) };
        else if (tokens[i] === 'mate') out.score = { type: 'mate', value: Number(tokens[++i]) };
        break;
      case 'pv':
        out.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
        break;
    }
  }
  return out;
}
