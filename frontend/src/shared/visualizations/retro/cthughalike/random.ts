/**
 * A small seeded random source for the Cthugha-like scenes (cthughalike/), so a scene can be
 * replayed exactly in a test or an offline render. Numbers come out in [0, 1).
 */

export type Random = () => number;

/** mulberry32: fast, 32 bits of state, good enough for picking effects. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed for a scene that was not given one: different every time it is shown. */
export function freshSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}

export function between(random: Random, low: number, high: number): number {
  return low + (high - low) * random();
}

/** A whole number from `low` to `high`, both included. */
export function whole(random: Random, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

/** One of `items` by weight; weights need not add up to anything. */
export function weighted<T>(random: Random, items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, weight] of items) total += Math.max(0, weight);
  let left = random() * total;
  for (const [item, weight] of items) {
    left -= Math.max(0, weight);
    if (left < 0) return item;
  }
  return items[items.length - 1]![0];
}

/** One of `items` by weight, but not `not` (when there is anything else). */
export function weightedOther<T>(random: Random, items: readonly (readonly [T, number])[], not: T): T {
  const others = items.filter(([item, weight]) => item !== not && weight > 0);
  return others.length ? weighted(random, others) : weighted(random, items);
}
