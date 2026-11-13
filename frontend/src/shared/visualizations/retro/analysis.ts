/**
 * The listening of "Klasyka retro", without imports so the tests run it as it is (retro.test.ts)
 * and the same arithmetic works on samples that do not come from an AnalyserNode.
 *
 * Every scene reads the music from one RetroAnalysis: the newest WINDOW samples of each channel,
 * how many of them are new since the last frame (a scene that simulates a circuit or scrolls a
 * scope runs over exactly those), their loudness, a spectrum and a kick.
 */

/** Samples of each channel kept, at 44.1/48 kHz: some 170 ms, enough for a slow frame. */
export const WINDOW = 8192;
/** The spectrum's FFT length (the newest samples of the mono mix) and its bins. */
export const FFT_SIZE = 2048;
export const SPECTRUM_BINS = FFT_SIZE / 2;
/** The spectrum's scale: these decibels are 0 and 1 (an AnalyserNode's defaults are −100 and −30). */
const MIN_DB = -90;
const MAX_DB = -20;
/** Below this RMS the music counts as silent. */
const NOISE_FLOOR = 0.004;

/** Bit-reversed order, twiddles and the Blackman window of the FFT, made once. */
const plan = (() => {
  const bits = Math.log2(FFT_SIZE);
  const reverse = new Uint16Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    let value = 0;
    for (let bit = 0; bit < bits; bit += 1) value |= ((index >> bit) & 1) << (bits - 1 - bit);
    reverse[index] = value;
  }
  const cos = new Float64Array(FFT_SIZE / 2);
  const sin = new Float64Array(FFT_SIZE / 2);
  for (let index = 0; index < FFT_SIZE / 2; index += 1) {
    cos[index] = Math.cos((-2 * Math.PI * index) / FFT_SIZE);
    sin[index] = Math.sin((-2 * Math.PI * index) / FFT_SIZE);
  }
  // The Blackman window an AnalyserNode uses (Web Audio, 1.15.4), so the bins read alike.
  const window = new Float64Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const phase = (2 * Math.PI * index) / FFT_SIZE;
    window[index] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
  }
  return { reverse, cos, sin, window };
})();

/** In-place radix-2 FFT of FFT_SIZE complex values. */
export function fft(re: Float64Array, im: Float64Array): void {
  const { reverse, cos, sin } = plan;
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const other = reverse[index]!;
    if (other > index) {
      const r = re[index]!;
      re[index] = re[other]!;
      re[other] = r;
      const i = im[index]!;
      im[index] = im[other]!;
      im[other] = i;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k += 1) {
        const c = cos[k * step]!;
        const s = sin[k * step]!;
        const a = start + k;
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
}

/** A value moving towards `target`: quick to rise (`rise` s), slower to fall (`fall` s). */
export function envelope(value: number, target: number, dt: number, rise: number, fall: number): number {
  const tau = target > value ? rise : fall;
  return value + (target - value) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
}

/** RMS and peak of `count` samples at the end of `samples`. */
export function loudness(samples: Float32Array, count: number): { rms: number; peak: number } {
  const from = Math.max(0, samples.length - Math.max(1, count));
  let sum = 0;
  let peak = 0;
  for (let index = from; index < samples.length; index += 1) {
    const value = samples[index]!;
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: Math.sqrt(sum / Math.max(1, samples.length - from)), peak };
}

/** The 12-tone note of a frequency: 0 is C-0 (16.35 Hz), 57 is A-4 (440 Hz). */
export function noteOf(frequency: number): number {
  if (!(frequency > 0)) return -1;
  return Math.round(12 * Math.log2(frequency / 440) + 57);
}

/** A note as trackers write it: "C-4", "F#2"; out of 0–119, "---". */
export function noteName(note: number, sharp = "#"): string {
  if (!Number.isInteger(note) || note < 0 || note > 119) return "---";
  const names = ["C-", "C", "D-", "D", "E-", "F-", "F", "G-", "G", "A-", "A", "B-"];
  const name = names[note % 12]!;
  return `${name.length === 1 ? name + sharp : name}${Math.floor(note / 12)}`;
}

/**
 * The music as the scenes hear it, moved on once a frame by `update`: the caller has written
 * the newest WINDOW samples of each channel into `left` and `right`.
 */
export class RetroAnalysis {
  readonly left = new Float32Array(WINDOW);
  readonly right = new Float32Array(WINDOW);
  readonly mono = new Float32Array(WINDOW);
  readonly spectrum = new Float32Array(SPECTRUM_BINS);
  fresh = 0;
  rate = 48000;
  binHz = 48000 / FFT_SIZE;
  rmsLeft = 0;
  rmsRight = 0;
  peakLeft = 0;
  peakRight = 0;
  beat = 0;
  onset = false;
  sounding = false;
  silence = 0;

  private readonly re = new Float64Array(FFT_SIZE);
  private readonly im = new Float64Array(FFT_SIZE);
  private fastBass = 0;
  private slowBass = 0;
  private sinceBeat = 1;

  /** `fresh` new samples arrived at `rate`; `dt` seconds passed. */
  update(fresh: number, rate: number, dt: number): void {
    const step = Math.min(0.1, Math.max(0.001, dt));
    this.rate = rate;
    this.binHz = rate / FFT_SIZE;
    this.fresh = Math.max(0, Math.min(WINDOW, Math.round(fresh)));
    for (let index = 0; index < WINDOW; index += 1) this.mono[index] = (this.left[index]! + this.right[index]!) / 2;

    // Loudness of what is new; with nothing new (a stalled clock) the last frame's samples.
    const span = this.fresh || Math.round(rate * step);
    const left = loudness(this.left, span);
    const right = loudness(this.right, span);
    this.rmsLeft = left.rms;
    this.rmsRight = right.rms;
    this.peakLeft = left.peak;
    this.peakRight = right.peak;
    this.sounding = Math.max(left.rms, right.rms) > NOISE_FLOOR;
    this.silence = this.sounding ? 0 : this.silence + step;

    // The spectrum of the newest FFT_SIZE samples, smoothed over time as an analyser smooths it.
    const offset = WINDOW - FFT_SIZE;
    for (let index = 0; index < FFT_SIZE; index += 1) {
      this.re[index] = this.mono[offset + index]! * plan.window[index]!;
      this.im[index] = 0;
    }
    fft(this.re, this.im);
    const smoothing = Math.exp(-step / 0.045);
    let bass = 0;
    const bassTo = Math.max(2, Math.round(150 / this.binHz));
    for (let bin = 0; bin < SPECTRUM_BINS; bin += 1) {
      const magnitude = Math.hypot(this.re[bin]!, this.im[bin]!) / FFT_SIZE;
      const decibels = 20 * Math.log10(Math.max(1e-12, magnitude));
      const value = Math.max(0, Math.min(1, (decibels - MIN_DB) / (MAX_DB - MIN_DB)));
      this.spectrum[bin] = Math.max(value, this.spectrum[bin]! * smoothing);
      if (bin >= 1 && bin <= bassTo) bass += value;
    }
    bass /= bassTo;

    // A kick: the bass of this instant well above that of the last half second.
    this.fastBass = envelope(this.fastBass, bass, step, 0.02, 0.06);
    this.slowBass = envelope(this.slowBass, bass, step, 0.45, 0.45);
    this.sinceBeat += step;
    this.onset = this.fastBass > this.slowBass * 1.12 + 0.03 && this.sinceBeat > 0.2 && this.fastBass > 0.3;
    if (this.onset) {
      this.beat = 1;
      this.sinceBeat = 0;
    } else {
      this.beat *= Math.exp(-step * 6);
    }
  }
}
