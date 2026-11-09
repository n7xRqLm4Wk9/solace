/**
 * Solace 0.2 — how much time the engine should keep in reserve.
 *
 * Stockfish stops a `go movetime X` search at `X - Move Overhead` and counts on
 * the remaining overhead to cover "everything else". Natively that is a few
 * microseconds; in a browser it is a `postMessage`, a task hop, a wasm call
 * boundary and occasionally a garbage collection. With the Stockfish default of
 * 10 ms a game played at 200 ms per move can therefore lose a few moves per
 * game on time.
 *
 * This module measures the real, observed lateness — how much later than
 * requested the engine actually answered — and turns it into a Move Overhead
 * value. It is deliberately a pure function of the samples plus a tiny
 * collector, so it can be tested without a browser.
 */

/** Never reserve less than this: one task hop can already cost 20-30 ms. */
export const MIN_OVERHEAD = 50;

/** Shortest search worth asking for, in ms. */
export const MIN_THINK_TIME = 120;

/** Never reserve more: past this the engine would spend its time waiting. */
export const MAX_OVERHEAD = 500;

/** Samples older than this are dropped; runtimes get slower (thermal, GC). */
export const SAMPLE_WINDOW = 12;

/**
 * Turns observed lateness (milliseconds) into a Move Overhead value.
 *
 * The rule is "one and a half times the worst recent case", clamped: the engine
 * should not lose on time because of a single slow answer, and should not throw
 * away its thinking time because of one fast one.
 *
 * @param {number[]} samples lateness in ms, one per completed search
 * @returns {number} Move Overhead in ms, always an integer
 */
export function overheadFromSamples(samples) {
  const usable = (samples || []).filter((s) => Number.isFinite(s) && s >= 0);
  if (!usable.length) return MIN_OVERHEAD;
  const worst = Math.max(...usable);
  return Math.round(Math.min(MAX_OVERHEAD, Math.max(MIN_OVERHEAD, worst * 1.5)));
}

/**
 * How long to actually ask the engine to search.
 *
 * This exists because of a Stockfish detail that is easy to get wrong: the UCI
 * option `Move Overhead` is only used when the search is bounded by a *clock*
 * (`go wtime … btime …`). A `go movetime X` search stops at exactly X, so no
 * amount of `Move Overhead` shortens it — the reserve has to be subtracted by
 * whoever sends the command. The page sends `movetime`, so it subtracts here.
 *
 * @param {object} options
 * @param {number} options.requested  what the player asked for (ms)
 * @param {number} [options.factor]   throttle factor from ThrottleGuard (≤ 1)
 * @param {number} [options.reserve]  time to keep back for browser latency (ms)
 * @returns {number} milliseconds to send in `go movetime`
 */
export function searchTime({ requested, factor = 1, reserve = 0 }) {
  const budget = Math.max(MIN_THINK_TIME, Number(requested) * factor);
  return Math.max(MIN_THINK_TIME, Math.round(budget - reserve));
}

/** Lateness of one search: how long it took minus how long it was asked for. */
export function lateness(requestedMs, elapsedMs) {
  if (!Number.isFinite(requestedMs) || !Number.isFinite(elapsedMs)) return null;
  const late = elapsedMs - requestedMs;
  // A search that came back early is not interesting, but it must not be
  // recorded as a negative sample either — that would hide a real slow case.
  return late > 0 ? late : 0;
}

/**
 * Collects lateness samples and reports the Move Overhead they imply.
 *
 * The app only sends a `setoption` when the recommendation actually changes by
 * at least one step, so a jittery runtime does not spam the engine.
 */
export class OverheadMeter {
  /** @param {number} [window] samples to keep */
  constructor(window = SAMPLE_WINDOW) {
    this.window = window;
    this.samples = [];
    this.current = MIN_OVERHEAD;
    this.applied = MIN_OVERHEAD;
  }

  /** Records one finished search and returns the new recommendation. */
  record(requestedMs, elapsedMs) {
    const sample = lateness(requestedMs, elapsedMs);
    if (sample !== null) {
      this.samples.push(sample);
      if (this.samples.length > this.window) this.samples.shift();
    }
    this.current = overheadFromSamples(this.samples);
    return this.current;
  }

  /** True when the recommendation moved enough to be worth a setoption. */
  shouldUpdate(step = 25) {
    return Math.abs(this.current - this.applied) >= step;
  }

  /** Marks the current recommendation as sent to the engine. */
  markApplied() {
    this.applied = this.current;
  }

  reset() {
    this.samples = [];
    this.current = MIN_OVERHEAD;
    this.applied = MIN_OVERHEAD;
  }
}
