/**
 * Fine seeking with a finger on the film's bar (media-viewer.ts).
 *
 * On a phone the whole film is the width of the screen: two hours on some 350
 * pixels is twenty seconds a pixel, so a finger could not land on a scene. Phone
 * players solve it the same way: the finger keeps moving the position from where
 * it is, and the higher it is lifted above the bar, the slower — half, a quarter,
 * a tenth. Pure functions, so the steps are tested without a browser.
 */

/** How far above the bar (CSS pixels) each slower speed starts. */
const STEPS: readonly (readonly [lift: number, speed: number])[] = [
  [144, 0.1],
  [96, 0.25],
  [48, 0.5]
];

/** The speed for a finger `lift` pixels above the bar's top edge (below or on it: full speed). */
export function fineScrubSpeed(lift: number): number {
  for (const [from, speed] of STEPS) if (lift >= from) return speed;
  return 1;
}

/** "×½", "×¼", "×⅒" — what the time bubble says next to "dokładnie". */
export function fineScrubLabel(speed: number): string {
  if (speed <= 0.1) return "×⅒";
  if (speed <= 0.25) return "×¼";
  if (speed <= 0.5) return "×½";
  return "×1";
}
