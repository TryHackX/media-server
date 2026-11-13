import assert from "node:assert/strict";
import test from "node:test";

import { RANDOM_NEXT_KEY, randomPreset } from "./random-next.ts";

/** A fixed sequence of "random" numbers in [0, 1). */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

/** A small LCG, so a long run is the same every time. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("random next: a preset of the pool other than the one on screen and the one pinned", () => {
  const pool = ["a", "b", "c", "d"];
  assert.equal(randomPreset(pool, { current: "b", chosen: "b", random: sequence(0) }), "a");
  assert.equal(randomPreset(pool, { current: "b", chosen: "b", random: sequence(0.99) }), "d");
  // The candidates are a, c, d: a third each.
  assert.equal(randomPreset(pool, { current: "b", chosen: "b", random: sequence(0.34) }), "c");
  // On screen and pinned may differ (a preset still loading): neither comes next.
  assert.equal(randomPreset(["a", "b", "c"], { current: "a", chosen: "b", random: sequence(0) }), "c");
  // "auto" is never a preset to pick, and a pool listing one twice does not weigh it double.
  assert.equal(randomPreset(["auto", "a", "a", "b"], { current: "b", chosen: "b", random: sequence(0.9) }), "a");
});

test("random next: nothing else in the pool, nothing picked (the panel steps as before)", () => {
  assert.equal(randomPreset([], { current: "", chosen: "auto" }), null);
  assert.equal(randomPreset(["a"], { current: "a", chosen: "a" }), null);
});

test("random next: among the favourites while \"Auto — tylko ulubione\" names some in the pool", () => {
  const pool = ["a", "b", "c", "d", "e"];
  const favorites = ["d", "b", "x"];
  for (const value of [0, 0.3, 0.6, 0.99]) {
    assert.ok(["b", "d"].includes(randomPreset(pool, { current: "a", chosen: "a", favorites, random: sequence(value) })!));
  }
  // On a favourite: the other one.
  assert.equal(randomPreset(pool, { current: "d", chosen: "d", favorites, random: sequence(0.7) }), "b");
  // No favourite left in this pack (or only the one on screen): the whole pack.
  assert.equal(randomPreset(["a", "b", "c"], { current: "b", chosen: "b", favorites: ["b", "x"], random: sequence(0.99) }), "c");
  assert.equal(randomPreset(pool, { current: "a", chosen: "a", favorites: null, random: sequence(0.99) }), "e");
});

test("random next: a long run never shows a preset twice in a row and reaches every one", () => {
  const pool = Array.from({ length: 12 }, (_, index) => `preset-${index}`);
  const random = lcg(7);
  let current = pool[0]!;
  const seen = new Set<string>([current]);
  for (let step = 0; step < 600; step += 1) {
    const next = randomPreset(pool, { current, chosen: current, random })!;
    assert.notEqual(next, current);
    assert.ok(pool.includes(next));
    seen.add(next);
    current = next;
  }
  assert.equal(seen.size, pool.length);
  // Kept per browser under its own key.
  assert.equal(RANDOM_NEXT_KEY, "media-visualizer-random-next");
});
