/**
 * mscopes' audio analysis, ported from GarAlex/mscopes (BSD-3, see LICENSE-mscopes.txt):
 * core/audio/Analyzer.cpp, BeatDetector.cpp, Features.cpp and core/platform/fft.cpp —
 * the same arithmetic on the same samples:
 *
 * - the classic part: the newest 1024 samples through a normalised Hann window and a
 *   radix-2 FFT, a 512-value spectrum on a log curve, bass / mid / treble as its means,
 *   and a beat from the bass RMS (an energy-flux detector with a tempo estimate);
 * - the features: 32 log bands with their own automatic gain, overall level, slow
 *   lows / mids / highs, onset strength and kick / snare / hi-hat hits from spectral flux
 *   on fixed 256-sample hops, a triggered waveform that holds a steady tone still, and
 *   every sample since the previous frame.
 *
 * Mono: the player's analyser node mixes the channels. No imports, so the unit test
 * (analysis.test.ts) runs it in Node; audio.ts feeds it from the AnalyserNode.
 */
const PI = Math.PI;
export const WAVEFORM_SAMPLES = 512;
export const SPECTRUM_BINS = 512;
export const BANDS = 32;
export const RECENT_MAX = 2048;
const ANALYZER_FFT = 1024;
const RING = 8192;

/** Everything one frame of analysis gives (VizFrame.h), mono. */
export interface MscopesAudioFrame {
  waveform: Float32Array;
  spectrum: Float32Array;
  bass: number;
  mid: number;
  treble: number;
  beat: boolean;
  bpm: number;
  beatPhase: number;
  time: number;
  hasFeatures: boolean;
  bands: Float32Array;
  level: number;
  bassAtt: number;
  midAtt: number;
  trebleAtt: number;
  onset: number;
  kick: number;
  snare: number;
  hat: number;
  kickHit: boolean;
  snareHit: boolean;
  hatHit: boolean;
  scope: Float32Array;
  recent: Float32Array;
  recentCount: number;
}

function emptyFrame(): MscopesAudioFrame {
  return {
    waveform: new Float32Array(WAVEFORM_SAMPLES), spectrum: new Float32Array(SPECTRUM_BINS),
    bass: 0, mid: 0, treble: 0, beat: false, bpm: 0, beatPhase: 0, time: 0, hasFeatures: false,
    bands: new Float32Array(BANDS), level: 0, bassAtt: 0, midAtt: 0, trebleAtt: 0, onset: 0,
    kick: 0, snare: 0, hat: 0, kickHit: false, snareHit: false, hatHit: false,
    scope: new Float32Array(WAVEFORM_SAMPLES), recent: new Float32Array(RECENT_MAX), recentCount: 0
  };
}

/** The bands as a curve over x = 0…1 (low to high), interpolated (VizFrame::bandAt). */
export function bandAt(frame: MscopesAudioFrame, x: number): number {
  const p = Math.max(0, Math.min(1, x)) * (BANDS - 1);
  const i = Math.floor(p);
  if (i >= BANDS - 1) return frame.bands[BANDS - 1]!;
  return frame.bands[i]! + (frame.bands[i + 1]! - frame.bands[i]!) * (p - i);
}

/** Band b covers bandEdgeHz(b) … bandEdgeHz(b + 1): 30 Hz … 16 kHz, log-spaced. */
export function bandEdgeHz(index: number): number {
  return 30 * Math.pow(16000 / 30, index / BANDS);
}

const clamp = (value: number, low: number, high: number): number => (value < low ? low : value > high ? high : value);

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** One-pole follower with separate attack and release time constants. */
function follow(y: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > y ? attack : release;
  return y + (target - y) * (1 - Math.exp(-dt / tau));
}

function hann(n: number, scale = 1): Float32Array {
  const window = new Float32Array(n);
  for (let i = 0; i < n; i += 1) window[i] = scale * 0.5 * (1 - Math.cos((2 * PI * i) / n));
  return window;
}

/**
 * platform/fft.cpp: radix-2, magnitudes in vDSP's convention (twice the DFT's), bin 0
 * without the packed Nyquist term.
 */
export class RealFft {
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Int32Array;
  private readonly n: number;

  public constructor(n: number) {
    this.n = n;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k += 1) {
      const angle = (-2 * PI * k) / n;
      this.cos[k] = Math.cos(angle);
      this.sin[k] = Math.sin(angle);
    }
    let bits = 0;
    while ((1 << bits) < n) bits += 1;
    this.rev = new Int32Array(n);
    for (let i = 0; i < n; i += 1) {
      let reversed = 0;
      for (let b = 0; b < bits; b += 1) if (i & (1 << b)) reversed |= 1 << (bits - 1 - b);
      this.rev[i] = reversed;
    }
  }

  public magnitudes(input: ArrayLike<number>, mags: Float32Array): void {
    const { n, re, im, cos, sin, rev } = this;
    for (let i = 0; i < n; i += 1) {
      re[rev[i]!] = input[i] ?? 0;
      im[rev[i]!] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j += 1) {
          const c = cos[j * step]!;
          const s = sin[j * step]!;
          const a = i + j;
          const b = a + half;
          const tr = re[b]! * c - im[b]! * s;
          const ti = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
    for (let k = 0; k < n / 2; k += 1) {
      mags[k] = 2 * Math.sqrt(re[k]! * re[k]! + (k ? im[k]! * im[k]! : 0));
    }
  }
}

/** BeatDetector.cpp: bass energy against its recent mean and variance, with a tempo. */
export class BeatDetector {
  public sensitivity = 1;
  public refractorySeconds = 0.15;
  public silenceFloor = 0.003;
  private static readonly HISTORY = 45;
  private static readonly INTERVALS = 8;
  private hist = new Float64Array(BeatDetector.HISTORY);
  private histPos = 0;
  private histCount = 0;
  private prevEnergy = 0;
  private clock = 0;
  private lastBeat = -1;
  private intervals = new Float64Array(BeatDetector.INTERVALS);
  private intervalPos = 0;
  private intervalCount = 0;
  private interval = 0;
  public bpm = 0;
  public phase = 0;
  public confidence = 0;

  public process(input: number, frameDt: number): boolean {
    const energy = Math.max(0, input);
    const dt = Math.max(0, Math.min(frameDt, 0.25));
    this.clock += dt;
    let mean = 0;
    let variance = 0;
    if (this.histCount > 0) {
      for (let i = 0; i < this.histCount; i += 1) mean += this.hist[i]!;
      mean /= this.histCount;
      for (let i = 0; i < this.histCount; i += 1) {
        const d = this.hist[i]! - mean;
        variance += d * d;
      }
      variance /= this.histCount;
    }
    const relative = mean > 1e-6 ? variance / (mean * mean) : 0;
    let threshold = Math.max(1.2, Math.min(1.6, 1.6 - 0.5 * relative));
    threshold = 1 + (threshold - 1) / Math.max(0.25, this.sensitivity);
    const rising = energy > this.prevEnergy * 1.05;
    const loud = this.histCount >= BeatDetector.HISTORY / 3 && energy > mean * threshold;
    const audible = mean > this.silenceFloor;
    const rested = this.lastBeat < 0 || this.clock - this.lastBeat >= this.refractorySeconds;
    const beat = rising && loud && audible && rested;
    if (beat) this.noteBeat();
    this.phase = this.interval > 0 && this.lastBeat >= 0 ? ((this.clock - this.lastBeat) / this.interval) % 1 : 0;
    this.hist[this.histPos] = energy;
    this.histPos = (this.histPos + 1) % BeatDetector.HISTORY;
    this.histCount = Math.min(this.histCount + 1, BeatDetector.HISTORY);
    this.prevEnergy = energy;
    return beat;
  }

  private noteBeat(): void {
    if (this.lastBeat >= 0) {
      const gap = this.clock - this.lastBeat;
      // Only intervals in a musical range train the tempo (40…250 BPM).
      if (gap >= 0.24 && gap <= 1.5) {
        this.intervals[this.intervalPos] = gap;
        this.intervalPos = (this.intervalPos + 1) % BeatDetector.INTERVALS;
        this.intervalCount = Math.min(this.intervalCount + 1, BeatDetector.INTERVALS);
      }
    }
    this.lastBeat = this.clock;
    this.phase = 0;
    if (this.intervalCount >= 3) {
      const sorted = Array.from(this.intervals.subarray(0, this.intervalCount)).sort((a, b) => a - b);
      const median = sorted[this.intervalCount >> 1]!;
      let deviation = 0;
      for (const value of sorted) deviation += Math.abs(value - median);
      deviation /= this.intervalCount;
      this.confidence = Math.max(0, 1 - deviation / (median * 0.5));
      this.interval = median;
      this.bpm = 60 / median;
    }
  }
}

/** Features.h OnsetDetector: peak picking on a flux signal against adaptive statistics. */
export class OnsetDetector {
  public k = 1.6;
  public relFloor = 0.2;
  public absFloor = 1e-6;
  public refractory = 0.09;
  private static readonly N = 192;
  private hist = new Float64Array(OnsetDetector.N);
  private pos = 0;
  private count = 0;
  private f1 = 0;
  private f2 = 0;
  private runMax = 0;
  private threshold = 0;
  private mean = 0;
  private std = 0;
  private lastHit = -1e9;
  private candidate = -1e9;

  public process(flux: number, t: number, hopSeconds: number): boolean {
    let mean = 0;
    let variance = 0;
    if (this.count > 0) {
      for (let i = 0; i < this.count; i += 1) mean += this.hist[i]!;
      mean /= this.count;
      for (let i = 0; i < this.count; i += 1) {
        const d = this.hist[i]! - mean;
        variance += d * d;
      }
      variance /= this.count;
    }
    this.mean = mean;
    this.std = Math.sqrt(variance);
    this.threshold = mean + this.k * this.std;
    this.runMax = Math.max(this.f1, this.runMax * Math.exp(-hopSeconds / 2));
    const floor = Math.max(this.absFloor, this.relFloor * this.runMax);
    const peakTime = t - hopSeconds;
    const hit = this.count >= OnsetDetector.N / 4
      && this.f1 > this.f2 && this.f1 >= flux
      && this.f1 > this.threshold && this.f1 > floor
      && peakTime - this.lastHit >= this.refractory;
    if (hit) this.candidate = peakTime;
    this.hist[this.pos] = flux;
    this.pos = (this.pos + 1) % OnsetDetector.N;
    this.count = Math.min(this.count + 1, OnsetDetector.N);
    this.f2 = this.f1;
    this.f1 = flux;
    return hit;
  }

  public accept(): void {
    this.lastHit = this.candidate;
  }

  /** How far `flux` stands above this region's recent flux, in standard deviations. */
  public z(flux: number): number {
    return (flux - this.mean) / Math.max(this.std, 1e-9);
  }
}

const HIST = 16384;
const HOP = 256;
const ONSET_N = 1024;
const BAND_N = 4096;
const E_LOW = 32;
const mod = (value: number, n: number): number => ((value % n) + n) % n;

/** Features.cpp AudioFeatures, mono. */
export class AudioFeatures {
  private sr = 48000;
  private hist = new Float32Array(HIST);
  private lp = new Float32Array(HIST);
  private written = 0;
  private lp1 = 0;
  private lp2 = 0;
  private lpA = 0;
  private readonly fftOnset = new RealFft(ONSET_N);
  private readonly winOnset = hann(ONSET_N);
  private readonly prevLog = new Float32Array(ONSET_N / 2);
  private havePrevLog = false;
  private nextHopEnd = ONSET_N;
  private readonly kick = new OnsetDetector();
  private readonly snare = new OnsetDetector();
  private readonly hat = new OnsetDetector();
  private kickAt = 0;
  private snareAt = 0;
  private hatAt = 0;
  private kickSeen = false;
  private snareSeen = false;
  private hatSeen = false;
  private onset = 0;
  private fullMax = 0;
  private hk = new Float64Array(4);
  private hs = new Float64Array(4);
  private hh = new Float64Array(4);
  private spS = new Float64Array(4);
  private hpos = 0;
  private eLow = new Float64Array(E_LOW);
  private ePos = 0;
  private readonly fftBands = new RealFft(BAND_N);
  private readonly winBands = hann(BAND_N);
  private readonly bandInput = new Float32Array(BAND_N);
  private readonly bandMags = new Float32Array(BAND_N / 2);
  private readonly onsetInput = new Float32Array(ONSET_N);
  private readonly onsetMags = new Float32Array(ONSET_N / 2);
  private readonly lg = new Float32Array(ONSET_N / 2);
  private peakDb = new Float64Array(BANDS).fill(-60);
  private bands = new Float64Array(BANDS);
  private att = new Float64Array(3);
  private levelPeakDb = -60;
  private level = 0;
  private prevScope = new Float32Array(WAVEFORM_SAMPLES);
  private havePrevScope = false;

  public constructor() {
    // Kick: the low band is sparse and hits are strong; hats are dense and short.
    this.kick.refractory = 0.10;
    this.snare.refractory = 0.10;
    this.hat.refractory = 0.05;
    this.hat.k = 1.4;
    this.setSampleRate(48000);
  }

  public setSampleRate(hz: number): void {
    this.sr = hz > 1000 ? hz : 48000;
    // Two one-pole low-passes at ~350 Hz: the trigger looks for zero crossings of the fundamental.
    this.lpA = 1 - Math.exp((-2 * PI * 350) / this.sr);
  }

  private envelope(seen: boolean, at: number, tau: number): number {
    if (!seen || at > this.written) return 0;
    return Math.exp(-((this.written - at) / this.sr) / tau);
  }

  private runHop(end: number, out: { kick: boolean; snare: boolean; hat: boolean; onsetPeak: number }): void {
    const N = ONSET_N;
    const H = N / 2;
    const buffer = this.onsetInput;
    for (let i = 0; i < N; i += 1) buffer[i] = this.hist[mod(end - N + i, HIST)]! * this.winOnset[i]!;
    this.fftOnset.magnitudes(buffer, this.onsetMags);
    const lg = this.lg;
    const prev = this.prevLog;
    const scale = 2 / N;
    let s2 = 0;
    for (let k = 0; k < H; k += 1) {
      lg[k] = this.onsetMags[k]! * scale;
      s2 += lg[k]! * lg[k]!;
    }
    if (!this.havePrevLog) {
      prev.set(lg);
      this.havePrevLog = true;
      return;
    }
    const binHz = this.sr / N;
    const range = (f0: number, f1: number): [number, number] => [
      Math.max(1, Math.ceil(f0 / binHz)), Math.min(H, Math.ceil(f1 / binHz))
    ];
    const flux = (f0: number, f1: number): number => {
      let [k0, k1] = range(f0, f1);
      if (k1 <= k0) k1 = Math.min(H, k0 + 1);
      let sum = 0;
      for (let k = k0; k < k1; k += 1) sum += Math.max(0, lg[k]! - prev[k]!);
      return k1 > k0 ? sum / (k1 - k0) : 0;
    };
    const spread = (f0: number, f1: number): number => {
      const [k0, k1] = range(f0, f1);
      if (k1 <= k0) return 0;
      let max = 0;
      for (let k = k0; k < k1; k += 1) max = Math.max(max, lg[k]! - prev[k]!);
      if (max <= 0) return 0;
      let count = 0;
      for (let k = k0; k < k1; k += 1) if (lg[k]! - prev[k]! > 0.25 * max) count += 1;
      return count / (k1 - k0);
    };
    // Kick: the thump below 120 Hz. Snare: the wires, 1.5–5 kHz. Hi-hat: the top.
    const fk = flux(35, 120);
    let eLow = 0;
    const [l0, l1] = range(35, 120);
    for (let k = l0; k < l1; k += 1) eLow += lg[k]! * lg[k]!;
    const fs = flux(1500, 5000);
    const fh = flux(7000, 16000);
    const spreadS = spread(1500, 5000);
    const ff = flux(35, 16000);
    prev.set(lg);

    const hopSeconds = HOP / this.sr;
    const t = end / this.sr;
    const peakAt = end - HOP;
    // Nothing below about −70 dBFS counts.
    const audible = Math.sqrt(s2) > 3e-4;
    const kc = this.kick.process(fk, t, hopSeconds);
    const sc = this.snare.process(fs, t, hopSeconds);
    const hc = this.hat.process(fh, t, hopSeconds);
    this.hk[this.hpos] = fk;
    this.hs[this.hpos] = fs;
    this.hh[this.hpos] = fh;
    this.spS[this.hpos] = spreadS;
    const previous = (this.hpos + 3) % 4;
    this.hpos = (this.hpos + 1) % 4;
    const ok = this.hk[previous]!;
    const os = this.hs[previous]!;
    const oh = this.hh[previous]!;
    const nk = Math.max(...this.hk);
    const ns = Math.max(...this.hs);
    const nh = Math.max(...this.hh);
    // A kick is a jump in low energy over the moment before it.
    this.eLow[this.ePos] = eLow;
    this.ePos = (this.ePos + 1) % E_LOW;
    let before = 0;
    for (let i = 3; i < E_LOW; i += 1) before += this.eLow[mod(this.ePos - 1 - i, E_LOW)]!;
    before /= E_LOW - 3;
    const now = Math.max(this.eLow[mod(this.ePos - 1, E_LOW)]!, this.eLow[mod(this.ePos - 2, E_LOW)]!);
    const jump = now / Math.max(before, 1e-12);
    const zK = this.kick.z(ok);
    const zS = this.snare.z(os);
    const zH = this.hat.z(oh);
    const spS = this.spS[previous]!;
    const kickOk = audible && kc && jump >= 2.5 && zK >= 3 && ok >= 40 * ns;
    const snareOk = audible && sc && spS >= 0.3 && os >= 0.005 * nk && os >= 0.25 * nh;
    const hatOk = audible && hc && (oh >= 3 * ns || zH - zS >= 2);
    if (kickOk) {
      this.kick.accept();
      out.kick = true;
      this.kickAt = peakAt;
      this.kickSeen = true;
    }
    if (snareOk) {
      this.snare.accept();
      out.snare = true;
      this.snareAt = peakAt;
      this.snareSeen = true;
    }
    if (hatOk) {
      this.hat.accept();
      out.hat = true;
      this.hatAt = peakAt;
      this.hatSeen = true;
    }
    // Overall onset strength: full-band flux against its recent maximum.
    this.fullMax = Math.max(ff, this.fullMax * Math.exp(-hopSeconds / 3));
    if (audible && this.fullMax > 1e-6) out.onsetPeak = Math.max(out.onsetPeak, Math.min(1, ff / this.fullMax));
  }

  /** Append `count` new samples and fill the feature fields of `out` (Features.cpp process). */
  public process(samples: Float32Array, count: number, frameDt: number, out: MscopesAudioFrame): void {
    let dt = frameDt > 0 ? frameDt : 1 / 60;
    dt = Math.min(dt, 0.25);
    const n = Math.max(0, count);
    for (let i = 0; i < n; i += 1) {
      const p = mod(this.written + i, HIST);
      const value = samples[i]!;
      this.hist[p] = value;
      this.lp1 += this.lpA * (value - this.lp1);
      this.lp2 += this.lpA * (this.lp1 - this.lp2);
      this.lp[p] = this.lp2;
    }
    this.written += n;

    const recent = Math.min(n, RECENT_MAX);
    out.recentCount = recent;
    out.recent.set(samples.subarray(n - recent, n));

    // Onsets, on fixed hops.
    const hits = { kick: false, snare: false, hat: false, onsetPeak: 0 };
    const oldest = this.written > HIST ? this.written - HIST : 0;
    if (this.nextHopEnd < oldest + ONSET_N) {
      this.nextHopEnd = oldest + ONSET_N;
      this.havePrevLog = false;
    }
    while (this.nextHopEnd <= this.written) {
      this.runHop(this.nextHopEnd, hits);
      this.nextHopEnd += HOP;
    }
    out.kickHit = hits.kick;
    out.snareHit = hits.snare;
    out.hatHit = hits.hat;
    out.kick = this.envelope(this.kickSeen, this.kickAt, 0.14);
    out.snare = this.envelope(this.snareSeen, this.snareAt, 0.12);
    out.hat = this.envelope(this.hatSeen, this.hatAt, 0.06);
    this.onset = Math.max(hits.onsetPeak, this.onset * Math.exp(-dt / 0.12));
    out.onset = this.onset;

    // Log bands with per-band automatic gain.
    {
      const N = BAND_N;
      const H = N / 2;
      const x = this.bandInput;
      const available = Math.min(this.written, N);
      for (let i = 0; i < N; i += 1) {
        x[i] = i >= N - available ? this.hist[mod(this.written - N + i, HIST)]! * this.winBands[i]! : 0;
      }
      const mag = this.bandMags;
      this.fftBands.magnitudes(x, mag);
      const scale = 2 / N;
      for (let k = 0; k < H; k += 1) {
        const m = mag[k]! * scale;
        mag[k] = m * m;
      }
      const binHz = this.sr / N;
      const db = new Float64Array(BANDS);
      let maxPeak = -200;
      for (let b = 0; b < BANDS; b += 1) {
        const x0 = bandEdgeHz(b) / binHz;
        const x1 = bandEdgeHz(b + 1) / binHz;
        let power = 0;
        if (x1 - x0 >= 2) {
          for (let k = Math.max(1, Math.ceil(x0)); k < Math.ceil(x1) && k < H; k += 1) power += mag[k]!;
        } else {
          const centre = 0.5 * (x0 + x1);
          const k0 = clamp(Math.trunc(centre), 0, H - 2);
          const fraction = clamp(centre - k0, 0, 1);
          power = (mag[k0]! * (1 - fraction) + mag[k0 + 1]! * fraction) * (x1 - x0);
        }
        db[b] = 10 * Math.log10(power + 1e-12);
        this.peakDb[b] = Math.max(db[b]!, this.peakDb[b]! - 3 * dt);
        maxPeak = Math.max(maxPeak, this.peakDb[b]!);
      }
      // Each band against its own recent peak, over a 30 dB range.
      const sum = [0, 0, 0];
      const counts = [0, 0, 0];
      for (let b = 0; b < BANDS; b += 1) {
        const ceil = Math.max(this.peakDb[b]!, maxPeak - 24, -60);
        let value = clamp((db[b]! - (ceil - 30)) / 30, 0, 1);
        value *= smoothstep(-90, -72, db[b]!);
        this.bands[b] = follow(this.bands[b]!, value, dt, 0.012, 0.16);
        out.bands[b] = this.bands[b]!;
        const centre = Math.sqrt(bandEdgeHz(b) * bandEdgeHz(b + 1));
        const group = centre < 250 ? 0 : centre < 4000 ? 1 : 2;
        sum[group]! += this.bands[b]!;
        counts[group]! += 1;
      }
      for (let g = 0; g < 3; g += 1) {
        this.att[g] = follow(this.att[g]!, counts[g] ? sum[g]! / counts[g]! : 0, dt, 0.10, 0.50);
      }
      out.bassAtt = this.att[0]!;
      out.midAtt = this.att[1]!;
      out.trebleAtt = this.att[2]!;
    }

    // Overall level.
    {
      const count = Math.min(this.written, 1024);
      let s2 = 0;
      for (let i = 0; i < count; i += 1) {
        const value = this.hist[mod(this.written - count + i, HIST)]!;
        s2 += value * value;
      }
      const db = 20 * Math.log10(Math.sqrt(count ? s2 / count : 0) + 1e-9);
      this.levelPeakDb = Math.max(db, this.levelPeakDb - 2 * dt);
      const ceil = Math.max(this.levelPeakDb, -45);
      const value = clamp((db - (ceil - 24)) / 24, 0, 1) * smoothstep(-80, -65, db);
      this.level = follow(this.level, value, dt, 0.02, 0.25);
      out.level = this.level;
    }

    // Triggered waveform.
    {
      const W = WAVEFORM_SAMPLES;
      const written = this.written;
      const high = written - W;
      const low = Math.max(Math.max(1, high - 1536), written - HIST + 1);
      let start = Math.max(0, high);
      if (high > low) {
        const candidates: number[] = [];
        for (let s = high; s > low && candidates.length < 48; s -= 1) {
          if (this.lp[mod(s - 1, HIST)]! < 0 && this.lp[mod(s, HIST)]! >= 0) candidates.push(s);
        }
        let previousEnergy = 0;
        if (this.havePrevScope) for (let i = 0; i < W; i += 2) previousEnergy += this.prevScope[i]! * this.prevScope[i]!;
        if (candidates.length > 0) {
          start = candidates[0]!;
          if (previousEnergy > 1e-6) {
            let best = -2;
            for (const candidate of candidates) {
              let dot = 0;
              let energy = 0;
              for (let i = 0; i < W; i += 2) {
                const value = this.hist[mod(candidate + i, HIST)]!;
                dot += value * this.prevScope[i]!;
                energy += value * value;
              }
              const score = dot / Math.sqrt(energy * previousEnergy + 1e-12) + (0.05 * (candidate - low)) / (high - low);
              if (score > best) {
                best = score;
                start = candidate;
              }
            }
          }
        }
      }
      for (let i = 0; i < W; i += 1) {
        const index = start + i;
        const have = index >= 0 && index < written && index > written - HIST;
        const value = have ? this.hist[mod(index, HIST)]! : 0;
        out.scope[i] = clamp(value, -1, 1);
        this.prevScope[i] = value;
      }
      this.havePrevScope = true;
    }
    out.hasFeatures = true;
  }
}

/** Analyzer.cpp: the classic frame (waveform, spectrum, bands, beat) plus the features. */
export class MscopesAnalyzer {
  private readonly fft = new RealFft(ANALYZER_FFT);
  private readonly window = hann(ANALYZER_FFT, Math.sqrt(8 / 3));
  private readonly ring = new Float32Array(RING);
  private written = 0;
  private readonly chan = new Float32Array(ANALYZER_FFT);
  private readonly windowed = new Float32Array(ANALYZER_FFT);
  private readonly mags = new Float32Array(ANALYZER_FFT / 2);
  private readonly beat = new BeatDetector();
  private readonly features = new AudioFeatures();
  private elapsed = 0;
  private haveClock = false;
  public readonly frame = emptyFrame();

  public setSampleRate(hz: number): void {
    this.features.setSampleRate(hz);
  }

  /** Analyse after `count` new samples (oldest first) arrived over `frameDt` seconds. */
  public analyze(samples: Float32Array, count: number, frameDt: number): MscopesAudioFrame {
    for (let i = 0; i < count; i += 1) this.ring[mod(this.written + i, RING)] = samples[i]!;
    this.written += count;
    const start = this.written - ANALYZER_FFT;
    for (let i = 0; i < ANALYZER_FFT; i += 1) {
      const index = start + i;
      this.chan[i] = index >= 0 ? this.ring[mod(index, RING)]! : 0;
    }
    let dt = this.haveClock ? frameDt : 0;
    this.haveClock = true;
    this.elapsed += Math.max(0, dt);
    if (dt <= 0) dt = 1 / 60;
    const out = this.frame;
    out.time = this.elapsed;
    for (let i = 0; i < WAVEFORM_SAMPLES; i += 1) out.waveform[i] = clamp(this.chan[ANALYZER_FFT - WAVEFORM_SAMPLES + i]!, -1, 1);
    for (let i = 0; i < ANALYZER_FFT; i += 1) this.windowed[i] = this.chan[i]! * this.window[i]!;
    this.fft.magnitudes(this.windowed, this.mags);
    // Normalized to 0…1 with a log curve so quiet detail is visible.
    const scale = 1 / ANALYZER_FFT;
    const boost = 120;
    const denominator = Math.log10(1 + boost);
    for (let i = 0; i < SPECTRUM_BINS; i += 1) {
      const m = i < ANALYZER_FFT / 2 ? this.mags[i]! * scale : 0;
      out.spectrum[i] = clamp(Math.log10(1 + boost * m) / denominator, 0, 1);
    }
    // The beat wants a linear bass level: the RMS of the raw bass-band magnitudes.
    const bassBins = SPECTRUM_BINS / 16;
    let sum = 0;
    for (let i = 1; i < bassBins; i += 1) {
      const m = this.mags[i]! * scale;
      sum += m * m;
    }
    const bassRms = Math.sqrt(sum / (bassBins - 1));
    const average = (low: number, high: number): number => {
      let total = 0;
      for (let i = low; i < high; i += 1) total += out.spectrum[i]!;
      return high > low ? total / (high - low) : 0;
    };
    out.bass = average(0, SPECTRUM_BINS / 16);
    out.mid = average(SPECTRUM_BINS / 16, SPECTRUM_BINS / 4);
    out.treble = average(SPECTRUM_BINS / 4, SPECTRUM_BINS);
    out.beat = this.beat.process(bassRms, dt);
    out.bpm = this.beat.bpm;
    out.beatPhase = this.beat.phase;
    this.features.process(samples, count, dt, out);
    return out;
  }
}
