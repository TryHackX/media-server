import assert from "node:assert/strict";
import test from "node:test";

import { BANDS, bandEdgeHz, BeatDetector, MscopesAnalyzer, RealFft, type MscopesAudioFrame } from "./analysis.ts";

/**
 * mscopes' own checks of its analysis (core/tests/features_selftest.cpp, drumsynth.h),
 * run against this port: synthetic drums with known hit times at 48 kHz, 60 frames a
 * second, every sample handed over as the player's analyser hands them.
 */
const SR = 48000;

/** mulberry32: a seeded generator for the drum noise (mscopes used mt19937; any noise will do). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const tail = (t: number, len: number): number => (len - t < 0.005 ? 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, len - t)) / 0.005) : 1);

function fade(t: number, len: number): number {
  let g = 1;
  if (t < 0.005) g *= 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.005);
  if (len - t < 0.005) g *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, len - t)) / 0.005);
  return g;
}

function addTone(s: Float32Array, hz: number, amp: number, t0 = 0, t1 = 1e9): void {
  for (let i = 0; i < s.length; i += 1) {
    const t = i / SR;
    if (t >= t0 && t < t1) s[i]! += amp * (t1 < 1e8 ? fade(t - t0, t1 - t0) : 1) * Math.sin(2 * Math.PI * hz * t);
  }
}

function addKick(s: Float32Array, t0: number, amp: number): void {
  let phase = 0;
  for (let i = 0; i < Math.trunc(0.45 * SR); i += 1) {
    const n = Math.trunc(t0 * SR) + i;
    if (n >= s.length) break;
    const t = i / SR;
    phase += (2 * Math.PI * (50 + 110 * Math.exp(-t / 0.03))) / SR;
    s[n]! += amp * 0.8 * Math.exp(-t / 0.12) * Math.sin(phase) * tail(t, 0.45);
  }
}

function addSnare(s: Float32Array, t0: number, amp: number, noise: () => number): void {
  let prev = 0;
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 7000) / SR);
  for (let i = 0; i < Math.trunc(0.35 * SR); i += 1) {
    const n = Math.trunc(t0 * SR) + i;
    if (n >= s.length) break;
    const t = i / SR;
    const w = noise();
    const hp = 0.5 * (w - prev);
    prev = w;
    lp += a * (hp - lp);
    const body = 0.35 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 185 * t);
    s[n]! += amp * (body + 0.9 * Math.exp(-t / 0.08) * lp) * tail(t, 0.35);
  }
}

function addHat(s: Float32Array, t0: number, amp: number, noise: () => number): void {
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < Math.trunc(0.12 * SR); i += 1) {
    const n = Math.trunc(t0 * SR) + i;
    if (n >= s.length) break;
    const t = i / SR;
    const w = noise();
    const hp = (w - 2 * p1 + p2) * 0.25;
    p2 = p1;
    p1 = w;
    s[n]! += amp * 0.5 * Math.exp(-t / 0.025) * hp * tail(t, 0.12);
  }
}

/** 120 BPM, 8 s: kicks on 1 and 3, snares on 2 and 4, hats on every eighth. */
function makeDrums(kick: boolean, snare: boolean, hat: boolean, gain: number, bassline: boolean) {
  const sig = new Float32Array(Math.trunc(SR * 8.5));
  const kicks: number[] = [];
  const snares: number[] = [];
  const hats: number[] = [];
  const noise = random(42);
  for (let beat = 0; beat < 16; beat += 1) {
    const t = 0.25 + beat * 0.5;
    if (kick && beat % 2 === 0) {
      addKick(sig, t, gain);
      kicks.push(t);
    }
    if (snare && beat % 2 === 1) {
      addSnare(sig, t, gain, noise);
      snares.push(t);
    }
    if (hat) {
      for (let e = 0; e < 2; e += 1) {
        addHat(sig, t + e * 0.25, gain, noise);
        hats.push(t + e * 0.25);
      }
    }
  }
  if (bassline) {
    for (let bar = 0; bar < 4; bar += 1) addTone(sig, bar % 2 ? 73.4 : 55.0, 0.12 * gain, 0.25 + bar * 2, 0.25 + bar * 2 + 1.9);
  }
  return { sig, kicks, snares, hats };
}

/** The signal through an analyzer, one frame per `SR / fps` samples. */
function run(sig: Float32Array, fps: number, each: (frame: MscopesAudioFrame, tEnd: number) => void): void {
  const analyzer = new MscopesAnalyzer();
  analyzer.setSampleRate(SR);
  const block = Math.round(SR / fps);
  for (let pos = 0; pos + block <= sig.length; pos += block) {
    each(analyzer.analyze(sig.subarray(pos, pos + block), block, 1 / fps), (pos + block) / SR);
  }
}

function detect(sig: Float32Array, fps: number) {
  const found = { kick: [] as number[], snare: [] as number[], hat: [] as number[] };
  run(sig, fps, (frame, t) => {
    if (frame.kickHit) found.kick.push(t);
    if (frame.snareHit) found.snare.push(t);
    if (frame.hatHit) found.hat.push(t);
  });
  return found;
}

/** A detection in the frame ending at t matches an onset in [t − 75 ms, t]. */
function score(truth: number[], detected: number[]) {
  const used = truth.map(() => false);
  let extra = 0;
  for (const t of detected) {
    const index = truth.findIndex((onset, i) => !used[i] && onset <= t + 1e-9 && onset >= t - 0.075);
    if (index >= 0) used[index] = true;
    else extra += 1;
  }
  return { found: used.filter(Boolean).length, total: truth.length, extra };
}

test("the FFT gives vDSP's magnitudes: twice the DFT's", () => {
  const fft = new RealFft(1024);
  const input = new Float32Array(1024).map((_, i) => Math.sin((2 * Math.PI * 64 * i) / 1024));
  const mags = new Float32Array(512);
  fft.magnitudes(input, mags);
  assert.ok(Math.abs(mags[64]! - 1024) < 1e-3);
  assert.ok(mags[10]! < 1e-3 && mags[200]! < 1e-3);
});

test("a 1 kHz tone lights its band and leaves far bands dark", () => {
  const s = new Float32Array(SR * 2);
  addTone(s, 1000, 0.1);
  let last: MscopesAudioFrame | null = null;
  run(s, 60, (frame) => {
    last = frame;
  });
  const band = (hz: number) => {
    for (let b = 0; b < BANDS; b += 1) if (hz >= bandEdgeHz(b) && hz < bandEdgeHz(b + 1)) return b;
    return -1;
  };
  const frame = last as unknown as MscopesAudioFrame;
  assert.ok(frame.hasFeatures);
  assert.ok(frame.bands[band(1000)]! > 0.85, `1 kHz band ${frame.bands[band(1000)]}`);
  assert.ok(frame.bands[band(60)]! < 0.1 && frame.bands[band(10000)]! < 0.1);
});

test("silence: no hits, dark bands, no level", () => {
  let hits = 0;
  let maxBand = 0;
  let maxLevel = 0;
  run(new Float32Array(SR * 3), 60, (frame) => {
    hits += Number(frame.kickHit) + Number(frame.snareHit) + Number(frame.hatHit);
    for (const value of frame.bands) maxBand = Math.max(maxBand, value);
    maxLevel = Math.max(maxLevel, frame.level);
  });
  assert.equal(hits, 0);
  assert.ok(maxBand < 0.05 && maxLevel < 0.05);
});

test("each drum alone is found by its own detector, the others stay quiet", () => {
  const k = makeDrums(true, false, false, 1, false);
  const dk = detect(k.sig, 60);
  const sk = score(k.kicks, dk.kick);
  assert.ok(sk.found >= 7 && sk.extra <= 1, `kick solo ${JSON.stringify(sk)}`);
  assert.ok(dk.snare.length <= 1 && dk.hat.length <= 1);

  const sn = makeDrums(false, true, false, 1, false);
  const ds = detect(sn.sig, 60);
  const ss = score(sn.snares, ds.snare);
  assert.ok(ss.found >= 7 && ss.extra <= 1, `snare solo ${JSON.stringify(ss)}`);
  assert.ok(ds.kick.length <= 1 && ds.hat.length <= 2);

  const h = makeDrums(false, false, true, 1, false);
  const dh = detect(h.sig, 60);
  const sh = score(h.hats, dh.hat);
  assert.ok(sh.found >= 29 && sh.extra <= 2, `hat solo ${JSON.stringify(sh)}`);
  assert.equal(dh.kick.length, 0);
});

test("the full kit over a bass line: kicks, snares and the unmasked hats", () => {
  for (const [gain, fps] of [[1, 60], [0.1, 60], [1, 30]] as const) {
    const d = makeDrums(true, true, true, gain, true);
    const found = detect(d.sig, fps);
    const sk = score(d.kicks, found.kick);
    const ss = score(d.snares, found.snare);
    const sh = score(d.hats, found.hat);
    assert.ok(sk.found >= 7 && sk.extra <= 1, `${gain} ${fps} fps kick ${JSON.stringify(sk)}`);
    assert.ok(ss.found >= 7 && ss.extra <= 1, `${gain} ${fps} fps snare ${JSON.stringify(ss)}`);
    assert.ok(sh.found >= 23 && sh.extra <= 2, `${gain} ${fps} fps hat ${JSON.stringify(sh)}`);
  }
});

test("the kick envelope is 1 at the hit and decays", () => {
  const k = makeDrums(true, false, false, 1, false);
  let hitT = -1;
  let atHit = 0;
  let later = 1;
  run(k.sig, 60, (frame, t) => {
    if (frame.kickHit && hitT < 0) {
      hitT = t;
      atHit = frame.kick;
    }
    if (hitT > 0 && Math.abs(t - (hitT + 0.3)) < 0.009) later = frame.kick;
  });
  assert.ok(atHit > 0.7 && later < 0.25, `${atHit} ${later}`);
});

test("the classic beat follows a pulsing bass and finds its tempo", () => {
  const detector = new BeatDetector();
  let beats = 0;
  for (let frame = 0; frame < 60 * 8; frame += 1) {
    // 120 BPM: a bass level that jumps every 30 frames and decays.
    const energy = 0.01 + 0.2 * Math.exp(-(frame % 30) / 4);
    if (detector.process(energy, 1 / 60)) beats += 1;
  }
  assert.ok(beats >= 14 && beats <= 17, `${beats} beats`);
  assert.ok(Math.abs(detector.bpm - 120) < 2, `${detector.bpm} BPM`);
});
