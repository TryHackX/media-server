/**
 * The panel's "random next" (the toggle beside ‹ ›): with it on, › and a double click on the
 * picture pick a preset at random instead of the one after it in the list. Pure, so the tests
 * run it as it is.
 */

/** Where the toggle is kept, per browser: "1" on, anything else off. */
export const RANDOM_NEXT_KEY = "media-visualizer-random-next";

export interface RandomNextOptions {
  /** On screen now, and the preset pinned: neither comes next. */
  current: string;
  chosen: string;
  /** "Auto — tylko ulubione": the favourites to pick among, while some of them are in the pool. */
  favorites?: readonly string[] | null;
  /** Math.random, or a fixed sequence in the tests. */
  random?: () => number;
}

/**
 * A preset of `pool` (the visualizer's list, its pack or category already applied) other than
 * the one on screen and the one pinned, among the favourites when "Auto — tylko ulubione" names
 * some of them; null when the pool has nothing else.
 */
export function randomPreset(pool: readonly string[], options: RandomNextOptions): string | null {
  const { current, chosen, favorites, random = Math.random } = options;
  let candidates = [...new Set(pool)].filter((id) => id !== current && id !== chosen && id !== "auto");
  if (favorites?.length) {
    const wanted = new Set(favorites);
    const among = candidates.filter((id) => wanted.has(id));
    if (among.length) candidates = among;
  }
  if (!candidates.length) return null;
  const index = Math.floor(random() * candidates.length);
  return candidates[Math.max(0, Math.min(candidates.length - 1, index))]!;
}
