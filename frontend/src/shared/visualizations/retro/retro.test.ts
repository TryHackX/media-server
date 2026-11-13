import assert from "node:assert/strict";
import test from "node:test";

import { envelope, fft, FFT_SIZE, loudness, noteName, noteOf, RetroAnalysis, WINDOW } from "./analysis.ts";
import { CREDITS } from "./credits-list.ts";
import { TRACKER_PRESETS } from "./trackers/presets.ts";
import { english } from "../../i18n-en.ts";
import { provideDictionary, setLanguage, t } from "../../i18n.ts";
import {
  COLOR_VOLTS, colourIndex, contourRelease, RAMP_COLOR_VOLTS, ramp, RING_CLOCKS, shapeLine, stageDegrees, tapChroma,
  tapChromaAt, tapColour, tapOfCount, yiqToRgb
} from "./avm-circuit.ts";

provideDictionary("en", english);

// "Klasyka retro": the arithmetic without the DOM — the Atari Video Music's circuit as the patent
// describes it, and the listening every scene shares.

test("a V-ramp is 15 at the ends of each period and 0 in its middle", () => {
  assert.equal(ramp(0, 1), 15);
  assert.equal(ramp(0.5, 1), 0);
  assert.equal(ramp(0.999, 1), 15);
  // Two periods across: a valley at a quarter and at three quarters.
  assert.equal(ramp(0.25, 2), 0);
  assert.equal(ramp(0.5, 2), 15);
  for (let i = 0; i < 100; i += 1) {
    const value = ramp(i / 100, 3);
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 15, String(value));
  }
});

test("TABLE I: two counts a tap up to 15, four up to 31, eight up to 63, then it rolls over", () => {
  assert.equal(tapOfCount(0), 16);
  assert.equal(tapOfCount(1), 16);
  assert.equal(tapOfCount(2), 15);
  assert.equal(tapOfCount(15), 9);
  assert.equal(tapOfCount(16), 8);
  assert.equal(tapOfCount(19), 8);
  assert.equal(tapOfCount(20), 7);
  assert.equal(tapOfCount(31), 5);
  assert.equal(tapOfCount(32), 4);
  assert.equal(tapOfCount(63), 1);
  assert.equal(tapOfCount(64), 16);
  assert.equal(tapOfCount(-3), 16);
  // In frequencies (a count over a field of 1/60 s), as the patent's table writes them.
  assert.equal(colourIndex(100), 16);
  assert.equal(colourIndex(1000), 8);
  assert.equal(colourIndex(3500), 1);
  assert.equal(colourIndex(3900), 16);
});

test("the taps' colours: spread apart round the hue circle, the same luminance", () => {
  const [i16, q16] = tapChroma(16, 30, 0, 0.4);
  assert.ok(Math.abs(i16 - 0.4) < 1e-9 && Math.abs(q16) < 1e-9);
  const [i13, q13] = tapChroma(13, 30, 0, 0.4);
  // Three taps on: 90 degrees.
  assert.ok(Math.abs(i13) < 1e-9 && Math.abs(q13 - 0.4) < 1e-9);
  // Without chroma, grey: R = G = B.
  const grey = tapColour(5, 30, 0, 0.5, 0);
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
  const rgb = new Uint8ClampedArray(3);
  yiqToRgb(1.5, 0, 0, rgb, 0);
  assert.deepEqual([...rgb], [255, 255, 255]);
});

test("SOLID lights either channel, HOLE exactly one, RING seven clocks from each edge of HOLE", () => {
  const width = 64;
  const horizontal = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) horizontal[x] = ramp((x + 0.5) / width, 1);
  const out = new Uint8Array(width);
  // The left channel louder than the right: two nested ranges along the line.
  shapeLine("solid", 20, 10, 2, horizontal, out);
  const solid = [...out];
  assert.ok(solid.every((value, x) => (value !== 0) === (20 > horizontal[x]! + 2)));
  shapeLine("hole", 20, 10, 2, horizontal, out);
  const hole = [...out];
  for (let x = 0; x < width; x += 1) {
    const left = 20 > horizontal[x]! + 2;
    const right = 10 > horizontal[x]! + 2;
    assert.equal(hole[x] !== 0, left !== right, String(x));
  }
  // Where both are on, the colour of the channel that came on last along the line: the right;
  // where the left alone is on, the left's.
  const middle = width / 2;
  shapeLine("solid", 20, 10, 2, horizontal, out);
  assert.equal(out[middle], 2);
  assert.equal(horizontal[8], 11);
  assert.equal(out[8], 1);
  shapeLine("ring", 20, 10, 2, horizontal, out);
  let lit = 0;
  for (const value of out) if (value) lit += 1;
  // Four edges of HOLE along the line, a pulse of seven clocks from each (overlaps aside).
  assert.ok(lit > 0 && lit <= 4 * RING_CLOCKS, String(lit));
  // Silence: nothing at all.
  shapeLine("solid", 0, 0, 0, horizontal, out);
  assert.ok(out.every((value) => value === 0));
});

test("the manual's knobs: CONTOUR's release, COLOR's rainbow", () => {
  // CONTOUR fully anticlockwise: C23 lets go in about 10 ms, towards almost a volt below idle
  // (soft shapes); fully clockwise in about 238 ms, towards half a volt (geometric shapes).
  const soft = contourRelease(0);
  const geometric = contourRelease(1);
  assert.ok(Math.abs(soft.tau - 0.0101) < 0.0005, String(soft.tau));
  assert.ok(Math.abs(geometric.tau - 0.2376) < 0.002, String(geometric.tau));
  assert.ok(Math.abs(soft.idle - 0.978) < 0.002 && Math.abs(geometric.idle - 0.4945) < 0.002);
  // The ramps move the delay line's bias by about 1.35 V either way of the pot's setting: in the
  // middle of its travel the stages change most (a rainbow), fully clockwise hardly (one colour).
  const swing = (position: number): number =>
    stageDegrees(COLOR_VOLTS * position - 15 * RAMP_COLOR_VOLTS) - stageDegrees(COLOR_VOLTS * position + 15 * RAMP_COLOR_VOLTS);
  assert.ok(swing(0.5) > 30, String(swing(0.5)));
  assert.ok(swing(1) < 5 && swing(0) < 10, `${swing(1)} ${swing(0)}`);
  // Anticlockwise the slow stages pass less of the colour clock: less colour.
  const length = (position: number): number => Math.hypot(...tapChromaAt(8, 15, position, 0, 1));
  assert.ok(length(0) < length(0.5) && length(0.5) < length(1));
  assert.ok(length(1) <= 1);
});

test("the FFT finds a sine in its bin", () => {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const bin = 37;
  for (let i = 0; i < FFT_SIZE; i += 1) re[i] = Math.sin((2 * Math.PI * bin * i) / FFT_SIZE);
  fft(re, im);
  let best = 0;
  for (let i = 1; i < FFT_SIZE / 2; i += 1) if (Math.hypot(re[i]!, im[i]!) > Math.hypot(re[best]!, im[best]!)) best = i;
  assert.equal(best, bin);
});

test("loudness, envelopes and note names", () => {
  const samples = new Float32Array(1000).fill(0.5);
  samples[999] = -1;
  const { rms, peak } = loudness(samples, 100);
  assert.equal(peak, 1);
  assert.ok(rms > 0.5 && rms < 0.6);
  // Quick to rise, slow to fall.
  assert.ok(envelope(0, 1, 0.01, 0.01, 1) > 0.6);
  assert.ok(envelope(1, 0, 0.01, 0.01, 1) > 0.98);
  assert.equal(noteOf(440), 57);
  assert.equal(noteName(57), "A-4");
  assert.equal(noteName(61), "C#5");
  assert.equal(noteName(-1), "---");
});

test("the analysis hears a kick, and silence as silence", () => {
  const analysis = new RetroAnalysis();
  const rate = 48000;
  let onsets = 0;
  let sounding = 0;
  for (let frame = 0; frame < 240; frame += 1) {
    // A 50 Hz kick every half second, decaying in 80 ms.
    for (let i = 0; i < WINDOW; i += 1) {
      const t = (frame * 800 + i - WINDOW) / rate;
      const since = ((t % 0.5) + 0.5) % 0.5;
      const value = Math.sin(2 * Math.PI * 50 * since) * Math.exp(-since / 0.08) * 0.8;
      analysis.left[i] = value;
      analysis.right[i] = value;
    }
    analysis.update(800, rate, 1 / 60);
    if (analysis.onset) onsets += 1;
    if (analysis.sounding) sounding += 1;
  }
  // Sounding while a kick rings, not in the quiet end of each half second.
  assert.ok(sounding > 60 && sounding < 220, String(sounding));
  // Eight kicks in four seconds: about one onset each (the first may be missed while the
  // detector learns, a long decay may count again after the 0.2 s it waits).
  assert.ok(onsets >= 6 && onsets <= 12, String(onsets));
  analysis.left.fill(0);
  analysis.right.fill(0);
  for (let frame = 0; frame < 120; frame += 1) analysis.update(800, rate, 1 / 60);
  assert.equal(analysis.sounding, false);
  assert.ok(analysis.silence > 1.9);
});

test("the credits name every tracker's authors, Cthugha's always, and translate only their words", () => {
  const credited = new Set(CREDITS.flatMap((section) => section.entries.flatMap((entry) => entry.presets ?? [])));
  for (const preset of TRACKER_PRESETS) assert.ok(credited.has(preset.id), `${preset.id} has no credit`);
  const programs = CREDITS.flatMap((section) => section.entries.map((entry) => entry.program));
  // Credits are facts: the Cthugha lines are part of the list itself, not of the port in vendor/.
  for (const program of ["Cthugha", "Cthugha-L", "Cthugha98", "Cthugha-4-Winamp", "Atari Video Music (1977)", "VSG"]) {
    assert.ok(programs.includes(program), `${program} missing`);
  }
  for (const section of CREDITS) for (const entry of section.entries) assert.ok(entry.lines.length > 0, entry.program);
  // Headings and notes are Polish source text with English entries; names stay as they are.
  setLanguage("en");
  try {
    const words = CREDITS.flatMap((section) => [section.heading ?? null, ...section.entries.flatMap((entry) => entry.notes ?? [])]).filter((word): word is string => word !== null);
    for (const word of [...words, "Autorzy", "Dziękujemy!"]) assert.notEqual(t(word), word, `"${word}" has no English`);
  } finally {
    setLanguage("pl");
  }
});
