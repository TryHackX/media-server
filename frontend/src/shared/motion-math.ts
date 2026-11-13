/**
 * The arithmetic of the interface's motion, apart from the page it moves.
 *
 * `motion.ts` asks these questions and applies the answers to elements; kept
 * here they can be answered — and tested — without a browser.
 */

/** The durations of styles/tokens.css, in milliseconds, for motion that is driven from script. */
export const DURATION = { fast: 140, normal: 220, slow: 340, sheet: 420 } as const;

/** Arrivals: quick to start, long to settle (`--ease-out`). */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Changes of state in place (`--ease-standard`). */
export const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";
/** Exits: quick to go, no settling (`--ease-exit`). */
export const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";

/**
 * How long something takes to leave, given how long it took to arrive: about
 * two thirds, to the nearest ten milliseconds. What goes away should get out of
 * the way faster than it came.
 */
export function exitDuration(enter: number): number {
  if (!Number.isFinite(enter) || enter <= 0) return 0;
  return Math.max(60, Math.round((enter * 0.7) / 10) * 10);
}

/**
 * The delay of the `index`-th child of a list that arrives one after another.
 *
 * Only the first `cap` are staggered: what comes after them is below the fold or
 * was appended later, and a card that waited behind eleven others would look
 * like a slow server. Everything past the cap arrives with the last staggered one.
 */
export function staggerDelay(index: number, step = 24, cap = 12): number {
  if (!Number.isFinite(index) || index <= 0 || step <= 0 || cap <= 1) return 0;
  return Math.min(Math.floor(index), cap - 1) * step;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FlipDelta {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/**
 * FLIP, the "invert" step: the transform that makes an element now sitting in
 * `last` look as if it were still in `first` (transform-origin: top left).
 * Animating from it to none moves the element from where it was to where it is,
 * on the compositor, without laying anything out again.
 *
 * Null when there is nothing to animate: the element did not move or change
 * size by so much as half a pixel, or one of the boxes has no area (hidden,
 * detached) and a scale to or from zero would be meaningless.
 */
export function flipInvert(first: Box, last: Box): FlipDelta | null {
  if (first.width <= 0 || first.height <= 0 || last.width <= 0 || last.height <= 0) return null;
  const x = first.left - last.left;
  const y = first.top - last.top;
  const scaleX = first.width / last.width;
  const scaleY = first.height / last.height;
  const moved = Math.abs(x) >= 0.5 || Math.abs(y) >= 0.5;
  const resized = Math.abs(first.width - last.width) >= 0.5 || Math.abs(first.height - last.height) >= 0.5;
  if (!moved && !resized) return null;
  return { x, y, scaleX: resized ? scaleX : 1, scaleY: resized ? scaleY : 1 };
}

/** That delta as a CSS transform (for an element with `transform-origin: 0 0`). */
export function flipTransform(delta: FlipDelta): string {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const move = `translate(${round(delta.x)}px, ${round(delta.y)}px)`;
  return delta.scaleX === 1 && delta.scaleY === 1 ? move : `${move} scale(${round(delta.scaleX)}, ${round(delta.scaleY)})`;
}

/**
 * How far a sheet dragged down by `distance` pixels should be drawn.
 *
 * Downwards it follows the finger; upwards (past its resting place) it resists,
 * moving a fifth of the way and never more than `limit` pixels — enough to feel
 * attached, not enough to show what is under it.
 */
export function sheetOffset(distance: number, limit = 24): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance >= 0) return distance;
  return Math.max(-limit, distance / 5);
}

/**
 * Whether a sheet that was let go should close: dragged past a third of its
 * height, or flicked downwards fast enough (pixels per millisecond) from at
 * least a little way down — a tap that happens to move must not close it.
 */
export function sheetShouldClose(distance: number, height: number, velocity: number): boolean {
  if (!(height > 0) || !Number.isFinite(distance)) return false;
  if (distance > height / 3) return true;
  return distance > 24 && velocity > 0.5;
}

/**
 * The fraction of a countdown that is left, for a ring that empties as it runs:
 * 1 at the start, 0 at the end, clamped — a timer that fires late must not draw
 * a negative arc.
 */
export function countdownFraction(elapsedMs: number, totalMs: number): number {
  if (!(totalMs > 0) || !Number.isFinite(elapsedMs)) return 0;
  return Math.min(1, Math.max(0, 1 - elapsedMs / totalMs));
}
