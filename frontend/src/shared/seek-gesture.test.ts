import assert from "node:assert/strict";
import test from "node:test";

import { fineScrubLabel, fineScrubSpeed } from "./seek-gesture.ts";

test("a finger on or below the bar seeks at full speed", () => {
  assert.equal(fineScrubSpeed(-40), 1);
  assert.equal(fineScrubSpeed(0), 1);
  assert.equal(fineScrubSpeed(47), 1);
});

test("lifting the finger slows the seek in steps: half, a quarter, a tenth", () => {
  assert.equal(fineScrubSpeed(48), 0.5);
  assert.equal(fineScrubSpeed(95), 0.5);
  assert.equal(fineScrubSpeed(96), 0.25);
  assert.equal(fineScrubSpeed(143), 0.25);
  assert.equal(fineScrubSpeed(144), 0.1);
  assert.equal(fineScrubSpeed(600), 0.1);
});

test("each speed has its label", () => {
  assert.deepEqual([1, 0.5, 0.25, 0.1].map(fineScrubLabel), ["×1", "×½", "×¼", "×⅒"]);
});
