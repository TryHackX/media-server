import assert from "node:assert/strict";
import test from "node:test";

import { positionState } from "./media-session.ts";

test("a track that has a length reports where it is, at its own speed", () => {
  assert.deepEqual(positionState({ duration: 240, playbackRate: 1, currentTime: 61.5 }), { duration: 240, playbackRate: 1, position: 61.5 });
  assert.deepEqual(positionState({ duration: 240, playbackRate: 1.25, currentTime: 0 }), { duration: 240, playbackRate: 1.25, position: 0 });
});

test("nothing is reported before the length is known", () => {
  assert.equal(positionState({ duration: Number.NaN, playbackRate: 1, currentTime: 3 }), null);
  assert.equal(positionState({ duration: 0, playbackRate: 1, currentTime: 0 }), null);
  assert.equal(positionState({ duration: Number.POSITIVE_INFINITY, playbackRate: 1, currentTime: 9 }), null);
});

test("a position past the end, before the start or unknown is brought inside the track", () => {
  assert.equal(positionState({ duration: 100, playbackRate: 1, currentTime: 100.4 })?.position, 100);
  assert.equal(positionState({ duration: 100, playbackRate: 1, currentTime: -2 })?.position, 0);
  assert.equal(positionState({ duration: 100, playbackRate: 1, currentTime: Number.NaN })?.position, 0);
});

test("a speed the system would refuse is told as normal speed", () => {
  assert.equal(positionState({ duration: 100, playbackRate: 0, currentTime: 5 })?.playbackRate, 1);
  assert.equal(positionState({ duration: 100, playbackRate: Number.NaN, currentTime: 5 })?.playbackRate, 1);
});
