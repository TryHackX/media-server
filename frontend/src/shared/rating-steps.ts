/**
 * The arithmetic of the star row (rating.ts), kept apart from the DOM so it is
 * tested without one. Ratings run from half a star to five, in halves.
 *
 * No imports on purpose, so `node --test` can load it as it is.
 */

const MIN = 0.5;
const MAX = 5;

function clamp(value: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(value * 2) / 2));
}

/**
 * The rating a press `x` pixels into a row `width` pixels wide stands for.
 *
 * The row is five stars of equal width, each two halves: the half under the
 * pointer is the value, so the left edge of the first star is already 0.5 —
 * there is no "zero" to press, clearing is a second press on the same value.
 */
export function ratingAt(x: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(x)) return MIN;
  return clamp(Math.ceil((x / width) * 10) / 2);
}

/**
 * Where a key takes the rating from `current`, or null for a key that is not
 * about the rating. An unrated track (0) starts from nothing: the first arrow
 * up gives half a star.
 */
export function ratingStep(current: number, key: string): number | null {
  const from = Number.isFinite(current) ? Math.max(0, current) : 0;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(from + 0.5);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(from - 0.5);
    case "PageUp":
      return clamp(from + 1);
    case "PageDown":
      return clamp(from - 1);
    case "Home":
      return MIN;
    case "End":
      return MAX;
    default:
      return /^[1-5]$/.test(key) ? Number(key) : null;
  }
}
