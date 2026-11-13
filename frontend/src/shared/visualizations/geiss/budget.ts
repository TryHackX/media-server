/**
 * How many pixels the Geiss port may draw: it shrinks its picture when the machine cannot keep up
 * and grows it back when frames are cheap again. Pure logic, without imports, so the tests run it
 * as it is.
 *
 * Geiss 4.30 never changed its video mode while it ran; what it did about speed was to measure it.
 * render1() keeps the times of the last 30 frames (`time_array`) and takes the frame rate over
 * them, smoothed from frame 33 on (`fps = fps*0.95 + 0.05*new`), and its motion, map lifetime and
 * damping follow that rate. The port judges its cost over the same 30 frames, by their median, so
 * a single expensive frame — a map built at once ("n", a map chosen in the panel), 50–150 ms —
 * does not count, as it would not move Geiss's own 30-frame rate much either.
 *
 * - Down, quickly: three windows in a row (about 1.5 s at 60 frames a second) whose median is over
 *   the frame budget, and the picture takes 60% of its pixels.
 * - Up, slowly: the next size up (pixels / 0.6, at most what the panel wants) is predicted to cost
 *   the median times the ratio of pixels; when every window for 8 s predicts at most 80% of the
 *   frame budget, the picture grows by that step. Cost is not quite proportional to the pixels
 *   (part of a frame is per frame), so the prediction errs on the high side.
 * - No oscillation: down at the budget, up only well under it — a load that makes a size too
 *   slow keeps the smaller one. A step up that turns out too slow all the same (and so is undone
 *   within 6 s) doubles the wait before the next try, up to a minute; a step up that holds
 *   brings the wait back to 8 s.
 * - A gap of more than 3 s inside a window (a hidden page, a closed panel) starts the counting
 *   again, and so does every new picture (`restart()`, a size or colour depth change), whose
 *   first window — the map being built, the code warming up — is not judged.
 */

/** Geiss's own measure: the frame rate over the last 30 frames (render1(), `time_array`). */
export const BUDGET_WINDOW = 30;
/** A frame costing more than this (ms) is too slow: 14 ms leaves room for the rest at 60 Hz. */
export const FRAME_BUDGET_MS = 14;
/** Windows over the budget in a row before the picture shrinks. */
export const DOWN_WINDOWS = 3;
/** The share of pixels a step down keeps; a step up divides by it. */
export const BUDGET_STEP = 0.6;
/** A step up only when the bigger picture is predicted at most this share of the budget. */
export const UP_MARGIN = 0.8;
/** How long (ms) every window must have been comfortable before a step up, at first. */
export const UP_WAIT_MS = 8000;
/** The longest the wait grows to after steps up that did not hold. */
export const UP_WAIT_MAX_MS = 64000;
/**
 * A step up undone within this long (ms) did not hold — a wrong prediction shows within 2–4 s, and
 * a load that comes back later is a new load, not the step's fault; one that lasts this long held.
 */
export const UP_HOLD_MS = 6000;
/** A window this long (ms) had a pause in it: the counting starts again. */
export const PAUSE_WINDOW_MS = 3000;

export interface BudgetLimits {
  /** The most pixels the picture may have on this device. */
  max: number;
  /** The fewest it is shrunk to. */
  min: number;
}

export class PictureBudget {
  /** The pixels the picture may have now. */
  budget: number;
  private readonly limits: BudgetLimits;
  private readonly costs: number[] = [];
  private windowStart = -1;
  private judged = false;
  private slowWindows = 0;
  /** Since when (ms) every window has predicted a comfortable step up; -1 when none has. */
  private comfortSince = -1;
  private upWait = UP_WAIT_MS;
  /** When the last step up was taken (ms), until it has held or been undone; -1 when none. */
  private upAt = -1;

  constructor(limits: BudgetLimits) {
    this.limits = { max: Math.max(limits.min, limits.max), min: limits.min };
    this.budget = this.limits.max;
  }

  /** The current wait before a step up (ms): grows after steps up that did not hold. */
  get wait(): number {
    return this.upWait;
  }

  /** A new picture: its frames are counted afresh and its first window is not judged. */
  restart(): void {
    this.costs.length = 0;
    this.windowStart = -1;
    this.judged = false;
    this.slowWindows = 0;
    this.comfortSince = -1;
  }

  /**
   * One frame drawn: what it cost (ms), when it was drawn (ms, any steady clock), the pixels of
   * the picture and the pixels the panel would take at full size (already capped by the device).
   * True when the budget changed and the picture should be rebuilt for it.
   */
  observe(cost: number, time: number, pixels: number, wanted: number): boolean {
    if (this.windowStart < 0) this.windowStart = time;
    this.costs.push(cost);
    if (this.costs.length < BUDGET_WINDOW) return false;
    const span = time - this.windowStart;
    const median = this.median();
    this.costs.length = 0;
    this.windowStart = time;
    if (span > PAUSE_WINDOW_MS) {
      this.slowWindows = 0;
      this.comfortSince = -1;
      return false;
    }
    if (!this.judged) {
      this.judged = true;
      return false;
    }
    // A step up that has lasted is a step up that held: the next one waits the shortest again.
    if (this.upAt >= 0 && time - this.upAt >= UP_HOLD_MS) {
      this.upAt = -1;
      this.upWait = UP_WAIT_MS;
    }
    if (median > FRAME_BUDGET_MS) {
      this.comfortSince = -1;
      this.slowWindows += 1;
      if (this.slowWindows < DOWN_WINDOWS || pixels <= this.limits.min) return false;
      this.slowWindows = 0;
      const next = Math.max(this.limits.min, Math.min(this.budget, pixels) * BUDGET_STEP);
      if (this.upAt >= 0) {
        // The last step up was too much after all: wait longer before trying again.
        this.upAt = -1;
        this.upWait = Math.min(UP_WAIT_MAX_MS, this.upWait * 2);
      }
      if (next >= this.budget) return false;
      this.budget = next;
      return true;
    }
    this.slowWindows = 0;
    const target = Math.min(this.limits.max, wanted);
    // As big as the panel wants (or the device allows): nothing to grow to.
    if (this.budget >= target || pixels >= target) {
      this.comfortSince = -1;
      return false;
    }
    const up = Math.min(this.limits.max, this.budget / BUDGET_STEP, target);
    const predicted = median * Math.max(1, up / Math.max(1, pixels));
    if (predicted > FRAME_BUDGET_MS * UP_MARGIN) {
      this.comfortSince = -1;
      return false;
    }
    if (this.comfortSince < 0) {
      // The comfort counts from the start of this window: it was all comfortable.
      this.comfortSince = time - span;
      return false;
    }
    if (time - this.comfortSince < this.upWait) return false;
    this.comfortSince = -1;
    this.upAt = time;
    this.budget = Math.max(this.budget, up);
    return true;
  }

  private median(): number {
    const sorted = [...this.costs].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
}
