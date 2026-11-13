import assert from "node:assert/strict";
import test from "node:test";

import { decimate, rateFactor, scaledFftSize } from "./audio-rate.ts";

test("44.1 and 48 kHz are read as they are, faster contexts down to them", () => {
  assert.equal(rateFactor(44100), 1);
  assert.equal(rateFactor(48000), 1);
  assert.equal(rateFactor(88200), 2);
  assert.equal(rateFactor(96000), 2);
  assert.equal(rateFactor(176400), 4);
  assert.equal(rateFactor(192000), 4);
  // Below 44.1 kHz nothing is stretched either.
  assert.equal(rateFactor(22050), 1);
});

test("the analyser grows with the factor, up to what an AnalyserNode takes", () => {
  assert.equal(scaledFftSize(1024, 1), 1024);
  assert.equal(scaledFftSize(1024, 4), 4096);
  assert.equal(scaledFftSize(16384, 4), 32768);
});

test("decimating keeps the newest samples, each the mean of its neighbours", () => {
  const source = new Float32Array([9, 9, 1, 3, 5, 7, -2, -4]);
  assert.deepEqual([...decimate(source, 2, new Float32Array(3))], [2, 6, -3]);
  // Factor 1: the newest samples unchanged.
  assert.deepEqual([...decimate(source, 1, new Float32Array(3))], [7, -2, -4]);
  // Bytes are rounded, not cut: (128 + 131) / 2 = 129.5 → 130.
  const bytes = new Uint8Array([128, 131, 100, 101]);
  assert.deepEqual([...decimate(bytes, 2, new Uint8Array(2))], [130, 101]);
});

test("a sine read at 192 kHz comes out as the same sine at 48 kHz", () => {
  const rate = 192000;
  const factor = rateFactor(rate);
  const raw = new Float32Array(4096);
  for (let index = 0; index < raw.length; index += 1) raw[index] = Math.sin((2 * Math.PI * 100 * index) / rate);
  const out = decimate(raw, factor, new Float32Array(576));
  // 576 samples at 48 kHz: 12 ms, 1.2 periods of 100 Hz — as Winamp's 576 at 44.1 kHz were.
  const crossings = out.reduce((count, value, index) => count + (index && Math.sign(value) !== Math.sign(out[index - 1]!) ? 1 : 0), 0);
  assert.ok(crossings >= 2 && crossings <= 3, `crossings ${crossings}`);
  assert.ok(Math.max(...out) > 0.95);
});
