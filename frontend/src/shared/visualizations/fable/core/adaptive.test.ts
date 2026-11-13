import assert from "node:assert/strict";
import test from "node:test";

import { AdaptiveScale } from "./adaptive.ts";

const BUDGET = 1000 / 60;

/** `seconds` of frames `delta` ms apart, each costing the GPU `gpu(scale)` ms (null: no timer). */
function run(adaptive: AdaptiveScale, seconds: number, delta: number, gpu: ((scale: number) => number) | null): number {
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += delta) adaptive.update(delta, gpu ? gpu(adaptive.scale) : null);
  return adaptive.scale;
}

test("a picture that is cheap stays at full size", () => {
  assert.equal(run(new AdaptiveScale(BUDGET), 20, BUDGET, () => 3), 1);
  assert.equal(run(new AdaptiveScale(BUDGET), 20, BUDGET, null), 1);
});

test("a picture too dear for the GPU is drawn smaller until it fits, never under the floor", () => {
  // The cost goes with the pixel count: 40 ms at full size.
  const adaptive = new AdaptiveScale(BUDGET, 0.35);
  const scale = run(adaptive, 30, 40, (at) => 40 * at * at);
  assert.ok(scale < 0.7 && scale >= 0.35, String(scale));
  assert.ok(40 * scale * scale <= BUDGET, "it fits the frame");
  // One that cannot fit at any size stops at the floor.
  assert.equal(run(new AdaptiveScale(BUDGET, 0.35), 30, 100, () => 100), 0.35);
});

test("without a GPU timer it goes by the time between frames", () => {
  const adaptive = new AdaptiveScale(BUDGET, 0.35);
  // 30 fps where 60 is wanted.
  assert.ok(run(adaptive, 10, 33.3, null) < 1);
});

test("with a GPU timer a slow frame clock alone changes nothing", () => {
  // A 30 Hz display, or a throttled tab: frames are far apart but the picture is cheap.
  assert.equal(run(new AdaptiveScale(BUDGET), 20, 33.3, () => 2), 1);
});

test("when there is room again the size comes back, a step at a time", () => {
  const adaptive = new AdaptiveScale(BUDGET, 0.35);
  let cost = 40;
  run(adaptive, 20, 20, (at) => cost * at * at);
  const low = adaptive.scale;
  assert.ok(low < 1);
  cost = 4;
  const seen: number[] = [];
  for (let elapsed = 0; elapsed < 120_000; elapsed += BUDGET) {
    const before = adaptive.scale;
    adaptive.update(BUDGET, cost * before * before);
    if (adaptive.scale !== before) seen.push(adaptive.scale / before);
  }
  assert.equal(adaptive.scale, 1);
  for (const step of seen) assert.ok(step > 1 && step <= 1.1 + 1e-9, `a step of ${step}`);
});

test("a step up that does not hold is taken back and tried again later, not at once", () => {
  // Fits at 0.8 of the size, not above it.
  const cost = (at: number): number => (at > 0.82 ? 30 : 6);
  const adaptive = new AdaptiveScale(BUDGET, 0.35, 0.8);
  let ups = 0;
  let downs = 0;
  for (let elapsed = 0; elapsed < 60_000; elapsed += BUDGET) {
    const before = adaptive.scale;
    adaptive.update(BUDGET, cost(before));
    if (adaptive.scale > before) ups += 1;
    if (adaptive.scale < before) downs += 1;
  }
  assert.ok(ups >= 1 && downs >= 1, "it tried");
  // Probing every 2.5 s it would overreach six times in the minute; each time doubles the wait.
  assert.ok(downs <= 3, `${downs} steps taken back in a minute`);
  assert.ok(adaptive.scale <= 0.82 * 1.1);
});
