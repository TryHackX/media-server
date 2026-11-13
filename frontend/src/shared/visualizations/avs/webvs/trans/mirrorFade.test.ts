import assert from "node:assert/strict";
import test from "node:test";

import { mirrorAdvance, mirrorPasses, newMirrorStatics } from "./mirrorFade.ts";

test("without smooth the set directions are copied, in r_mirror.cpp's order", () => {
  const statics = newMirrorStatics();
  for (let frame = 0; frame < 3; frame += 1) {
    assert.deepEqual(mirrorPasses(statics, 15, false), [
      { bit: 4, divisor: 0 }, { bit: 8, divisor: 0 }, { bit: 1, divisor: 0 }, { bit: 2, divisor: 0 }
    ]);
  }
  // "On beat random" before its first beat uses mode 0: nothing.
  assert.deepEqual(mirrorPasses(newMirrorStatics(), 0, false), []);
});

test("a direction fades in over 1…15 and is then copied", () => {
  const statics = newMirrorStatics();
  const seen: number[] = [];
  for (let frame = 1; frame <= 18; frame += 1) {
    const passes = mirrorPasses(statics, 1, true);
    assert.equal(passes.length, 1);
    seen.push(passes[0]!.divisor);
    mirrorAdvance(statics); // slower = 1
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 0, 0]);
});

test("a direction switched off fades out from 16 and then stops", () => {
  const statics = newMirrorStatics();
  mirrorPasses(statics, 4, false); // on, no fade
  statics.divisors = [0, 0, 0, 0];
  const seen: Array<number | null> = [];
  for (let frame = 1; frame <= 18; frame += 1) {
    const passes = mirrorPasses(statics, 0, true);
    seen.push(passes.length ? passes[0]!.divisor : null);
    mirrorAdvance(statics);
  }
  assert.deepEqual(seen, [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, null, null]);
});

test("a fade turned around keeps its divisor and changes its step", () => {
  const statics = newMirrorStatics();
  mirrorPasses(statics, 2, true); // turning on: 1
  mirrorAdvance(statics);
  mirrorAdvance(statics); // 3
  assert.deepEqual(mirrorPasses(statics, 0, true), [{ bit: 2, divisor: 3 }]);
  mirrorAdvance(statics);
  assert.deepEqual(mirrorPasses(statics, 0, true), [{ bit: 2, divisor: 2 }]);
});

test("the state is shared: a second Mirror draws the first one's fade too", () => {
  const statics = newMirrorStatics();
  assert.deepEqual(mirrorPasses(statics, 1, true), [{ bit: 1, divisor: 1 }]);
  // The second one's mode differs, so for it bit 1 is turning off (its divisor stays 1).
  assert.deepEqual(mirrorPasses(statics, 4, true), [{ bit: 4, divisor: 1 }, { bit: 1, divisor: 1 }]);
});
