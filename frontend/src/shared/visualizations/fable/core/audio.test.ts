import assert from "node:assert/strict";
import test from "node:test";

import { AudioAnalysis, BANDS, FFT_SIZE, KICK_REFRACTORY } from "./audio.ts";

const RATE = 48000;
const FPS = 60;
const BINS = FFT_SIZE / 2;
const SILENT_WAVE = new Uint8Array(FFT_SIZE).fill(128);

/** A byte spectrum as the analyser gives it: a floor, and the bass bins (35–130 Hz) at `bass`. */
function spectrum(floor: number, bass: number): Uint8Array {
  const bytes = new Uint8Array(BINS).fill(floor);
  for (let bin = 1; bin <= 6; bin += 1) bytes[bin] = bass;
  return bytes;
}

/** `seconds` of music with a kick every `interval` seconds (each two frames long); the onset times found. */
function play(analysis: AudioAnalysis, seconds: number, interval: number): number[] {
  const quiet = spectrum(90, 110);
  const kick = spectrum(90, 235);
  const onsets: number[] = [];
  for (let frame = 0; frame < seconds * FPS; frame += 1) {
    const time = frame / FPS;
    const sinceKick = time % interval;
    const features = analysis.update(sinceKick < 2 / FPS ? kick : quiet, SILENT_WAVE, RATE, 1 / FPS);
    if (features.onset) onsets.push(features.time);
  }
  return onsets;
}

test("silence reads as nothing, and musical time still runs", () => {
  const analysis = new AudioAnalysis();
  const silence = new Uint8Array(BINS);
  for (let frame = 0; frame < 5 * FPS; frame += 1) analysis.update(silence, SILENT_WAVE, RATE, 1 / FPS);
  const f = analysis.features;
  assert.equal(f.presence, 0);
  assert.equal(f.kick, 0);
  assert.equal(f.beat, 0);
  assert.ok(Math.abs(f.time - 5) < 1e-6);
  // The pictures move on `flow` and `breath`: neither may stop in a quiet passage.
  assert.ok(f.flow > 1.5, String(f.flow));
  assert.ok(f.breath > 5, String(f.breath));
});

test("a steady four-on-the-floor is followed: every kick found, the period known, the phase running", () => {
  const analysis = new AudioAnalysis();
  const onsets = play(analysis, 12, 0.5);
  assert.ok(onsets.length >= 22 && onsets.length <= 24, `${onsets.length} kicks in 12 s at 120 BPM`);
  const f = analysis.features;
  assert.ok(Math.abs(f.period - 0.5) < 0.02, String(f.period));
  assert.ok(f.beatConfidence > 0.6, String(f.beatConfidence));
  assert.equal(f.beat, onsets.length);
});

test("kicks never come more than three a second, whatever the music does", () => {
  // Bass bursts ten times a second: what would strobe anything tied to them.
  const analysis = new AudioAnalysis();
  const onsets = play(analysis, 20, 0.1);
  assert.ok(onsets.length > 0, "some are found");
  for (let index = 1; index < onsets.length; index += 1) {
    assert.ok(onsets[index]! - onsets[index - 1]! >= KICK_REFRACTORY - 1e-6, `two kicks ${onsets[index]! - onsets[index - 1]!} s apart`);
  }
  for (const from of onsets) assert.ok(onsets.filter((time) => time >= from && time < from + 1).length <= 3);
  assert.ok(KICK_REFRACTORY > 1 / 3);
});

test("every envelope stays within 0…1 and moves without steps", () => {
  const analysis = new AudioAnalysis();
  const quiet = spectrum(90, 110);
  const kick = spectrum(200, 240);
  let previous = 0;
  for (let frame = 0; frame < 10 * FPS; frame += 1) {
    const f = analysis.update(frame % 30 < 2 ? kick : quiet, SILENT_WAVE, RATE, 1 / FPS);
    for (const value of [f.bass, f.lowMid, f.mid, f.high, f.air, f.level, f.presence, f.kick, f.hat, f.beatPhase, f.beatConfidence]) {
      assert.ok(value >= 0 && value <= 1, String(value));
    }
    // The kick's envelope rises over a few frames (a 30 ms attack), never in one.
    assert.ok(f.kick - previous < 0.6, `a step of ${f.kick - previous}`);
    previous = f.kick;
  }
  assert.equal(analysis.spectrum.length, BANDS);
  for (const band of analysis.spectrum) assert.ok(band >= 0 && band <= 1);
});
