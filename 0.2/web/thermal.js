/**
 * Solace 0.2 — behaviour on a phone that is getting hot.
 *
 * A mid-range Android phone starts a game at, say, 120 000 nodes/second and
 * after ten minutes on a warm battery it may be at 60 000. Nothing crashes; the
 * engine simply reaches less depth for the same wall-clock time, and — more
 * importantly — the *browser* gets slower too, so the time spent outside the
 * search (postMessage, painting, garbage collection) grows. At a fixed
 * "1 second per move" that means the engine increasingly loses its move on time
 * and the page stutters.
 *
 * The rule this module implements: watch the nodes/second the engine reports,
 * remember the best it has ever been, and when the current rate has fallen well
 * below that, (a) reserve more time for overhead and (b) ask for shorter
 * searches, so the *number of moves* the phone can still deliver on time stays
 * constant instead of the game grinding to a halt.
 *
 * Everything here is a pure function of the samples, so it is testable without
 * a browser or a phone.
 */

/** Below this fraction of the best observed rate, the device counts as hot. */
export const HOT_RATIO = 0.75;

/** Below this, it is really throttling and the search time is cut hard. */
export const VERY_HOT_RATIO = 0.55;

/**
 * Shortest search we are willing to ask for, in ms. Defined in overhead.js,
 * where the final `go movetime` is computed, and re-exported here.
 */
import { MIN_THINK_TIME } from './overhead.js';

export { MIN_THINK_TIME };

export class ThrottleGuard {
  /**
   * @param {object} [options]
   * @param {number} [options.window] samples kept for the "current" estimate
   */
  constructor({ window = 6 } = {}) {
    this.window = window;
    this.samples = [];
    this.peak = 0;
    this.factor = 1;
    this.hot = false;
  }

  /**
   * Records the nodes/second of one finished search.
   * @param {number} nps
   * @returns {{factor: number, hot: boolean, peak: number, current: number}}
   */
  observe(nps) {
    if (!Number.isFinite(nps) || nps <= 0) return this.state();

    this.samples.push(nps);
    if (this.samples.length > this.window) this.samples.shift();

    // The peak is the fastest this device has been seen to go. It decays very
    // slowly, so a phone that cools down again recovers its normal speed
    // instead of being punished for one hot afternoon.
    this.peak = Math.max(nps, this.peak * 0.995);

    const ratio = this.peak > 0 ? this.current() / this.peak : 1;
    this.hot = ratio < HOT_RATIO;

    if (ratio < VERY_HOT_RATIO) this.factor = 0.55;
    else if (ratio < HOT_RATIO) this.factor = 0.8;
    else this.factor = 1;

    return this.state();
  }

  /** Median-ish current rate: the mean of the newest half of the window. */
  current() {
    if (!this.samples.length) return 0;
    const recent = this.samples.slice(-Math.max(1, Math.ceil(this.samples.length / 2)));
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  state() {
    return { factor: this.factor, hot: this.hot, peak: Math.round(this.peak), current: Math.round(this.current()) };
  }

  /**
   * How long to search for: the requested time scaled by the throttle factor,
   * never below the floor. Returns `requested` on a cool device.
   */
  thinkTime(requested) {
    const ms = Math.max(MIN_THINK_TIME, Math.round(requested * this.factor));
    return ms;
  }

  /**
   * Extra Move Overhead in ms. A hot device is also a device whose browser is
   * slow to hand the result back, so the reserve grows with the throttling.
   */
  overheadBonus() {
    if (!this.hot) return 0;
    return this.factor <= 0.55 ? 120 : 60;
  }

  /** Forget history (new game, or after the tab was hidden for a long time). */
  reset() {
    this.samples = [];
    this.peak = 0;
    this.factor = 1;
    this.hot = false;
  }
}
