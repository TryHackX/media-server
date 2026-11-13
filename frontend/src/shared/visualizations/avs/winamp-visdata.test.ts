import assert from "node:assert/strict";
import test from "node:test";

import {
  AVS_LOG_TABLE, AVS_SAMPLES, avsCenter, avsGetvis, avsVisdataFrom, createVisdata, pcmTopByte, winampSpectrum
} from "./winamp-visdata.ts";

const sine = (bin: number, amplitude: number, length = AVS_SAMPLES): Int8Array =>
  Int8Array.from({ length }, (_, n) => Math.round(amplitude * Math.sin((2 * Math.PI * bin * n) / 512)));

test("waveform bytes are the top byte of 16-bit PCM", () => {
  assert.deepEqual([-1, -0.5, 0, 0.5, 0.999, 1, 2, -2, Number.NaN].map(pcmTopByte), [-128, -64, 0, 64, 127, 127, 127, -128, -128]);
  // -1/32768 is PCM -1, whose top byte is -1 (an arithmetic shift, not a cut towards zero).
  assert.equal(pcmTopByte(-1 / 32768), -1);
  assert.equal(pcmTopByte(255 / 32768), 0);
  assert.equal(pcmTopByte(256 / 32768), 1);
});

test("AVS 2.81's log table lifts quiet bytes: 255·log(1 + 60x/255)/log 60", () => {
  assert.equal(AVS_LOG_TABLE[0], 0);
  assert.equal(AVS_LOG_TABLE[1], 13);
  assert.equal(AVS_LOG_TABLE[10], 75);
  assert.equal(AVS_LOG_TABLE[29], 128);
  assert.equal(AVS_LOG_TABLE[128], 214);
  assert.equal(AVS_LOG_TABLE[255], 255);
  for (let x = 1; x < 256; x += 1) assert.ok(AVS_LOG_TABLE[x]! >= AVS_LOG_TABLE[x - 1]!);
});

test("silence is an empty spectrum", () => {
  const out = winampSpectrum(new Int8Array(AVS_SAMPLES), new Uint8Array(AVS_SAMPLES));
  assert.equal(out.reduce((sum, value) => sum + value, 0), 0);
});

test("a sine lands on its bin: twice, the first time halfway from the bin before", () => {
  // Amplitude 8 (of 128) at bin 40: |X| ≈ 8 · 512/4 = 1024, / 16 = 64.
  const out = winampSpectrum(sine(40, 8), new Uint8Array(AVS_SAMPLES));
  const peak = out[81]!;
  assert.ok(peak >= 60 && peak <= 68, `peak ${peak}`);
  // The byte before is the mean of bins 39 and 40; Hann leaks half a bin's height into 39.
  assert.ok(Math.abs(out[80]! - Math.round((out[79]! + peak) / 2)) <= 1);
  // Far from it nothing but the rounding of the sine to bytes.
  assert.ok(out.slice(0, 70).every((value) => value === 0));
  assert.ok(out.slice(100, 512).every((value) => value <= 2));
});

test("a loud sine is capped at 255, and the tail halves the top bin", () => {
  const loud = winampSpectrum(sine(100, 120), new Uint8Array(AVS_SAMPLES));
  assert.equal(loud[201], 255);
  const top = winampSpectrum(sine(255, 120), new Uint8Array(AVS_SAMPLES));
  assert.equal(top[511], 255);
  assert.deepEqual([...top.slice(512, 520)], [128, 64, 32, 16, 8, 4, 2, 1]);
  assert.ok(top.slice(520).every((value) => value === 0));
});

test("the spectrum reads the block's first 512 samples only", () => {
  const block = sine(40, 8);
  const changed = Int8Array.from(block);
  for (let n = 512; n < AVS_SAMPLES; n += 1) changed[n] = 100;
  assert.deepEqual(winampSpectrum(block, new Uint8Array(AVS_SAMPLES)), winampSpectrum(changed, new Uint8Array(AVS_SAMPLES)));
});

test("a frame's visdata: both channels, log table on the spectrum", () => {
  const left = Float32Array.from({ length: AVS_SAMPLES }, (_, n) => 0.0625 * Math.sin((2 * Math.PI * 40 * n) / 512));
  const right = new Float32Array(AVS_SAMPLES);
  const visdata = avsVisdataFrom(left, right, createVisdata());
  assert.equal(visdata.waveform[0][128], pcmTopByte(left[128]!));
  assert.ok(visdata.waveform[1].every((value) => value === 0));
  const raw = winampSpectrum(visdata.waveform[0], new Uint8Array(AVS_SAMPLES));
  assert.equal(visdata.spectrum[0][81], AVS_LOG_TABLE[raw[81]!]);
  assert.ok(visdata.spectrum[1].every((value) => value === 0));
});

test("the centre channel adds halves of C's signed chars", () => {
  const out = new Uint8Array(AVS_SAMPLES);
  // Waveform: (-3)/2 + 5/2 = -1 + 2 = 1.
  avsCenter(Int8Array.of(-3, 100, -128), Int8Array.of(5, 101, -128), out);
  assert.deepEqual([...out.slice(0, 3)], [1, 100, 128]);
  // Spectrum: 200 is -56 as a char, so 200 and 50 meet at -28 + 25 = -3, a byte of 253.
  avsCenter(Uint8Array.of(200, 200, 100), Uint8Array.of(50, 200, 60), out);
  assert.deepEqual([...out.slice(0, 3)], [253, 200, 80]);
});

test("getspec and getosc average bytes as avs_eelif.cpp does", () => {
  const visdata = createVisdata();
  visdata.spectrum[0].fill(255);
  visdata.spectrum[1].fill(51);
  visdata.waveform[0].fill(-128);
  visdata.waveform[1].fill(64);
  assert.equal(avsGetvis(visdata, false, 0.5, 0.1, 1), 1);
  assert.equal(avsGetvis(visdata, false, 0.5, 0.1, 2), 0.2);
  assert.equal(avsGetvis(visdata, false, 0.5, 0.1, 0), (255 + 51) / 255 / 2);
  assert.equal(avsGetvis(visdata, true, 0.5, 0, 1), -128 / 127.5);
  assert.equal(avsGetvis(visdata, true, 0.5, 0, 0), (-128 + 64) / 255);
  assert.equal(avsGetvis(visdata, true, 0.5, 0, 3), 0);
  // The band is cut at the ends: from -0.1 with width 0.4 it covers 0 … 0.1.
  visdata.spectrum[0].fill(0);
  visdata.spectrum[0].fill(255, 0, 58);
  assert.equal(avsGetvis(visdata, false, -0.1, 0.4, 1), 1);
});
