import type { Kit, Uniforms } from "./kit";

/**
 * The music as the Fable visualizations read it, worked out once a frame from what an
 * AnalyserNode gives (byte spectrum and byte waveform at 44.1/48 kHz, fftSize 2048, smoothing
 * 0.5, -90…-10 dB — the settings the preset kind asks Internal for).
 *
 * Nothing here is drawn from the raw bytes directly: every value passes an attack/release
 * envelope, so nothing jitters, and every band is measured against its own recent peak, so a
 * quiet passage moves the picture as a loud one does. Kicks are onsets of the bass band with a
 * refractory time of a third of a second: nothing driven by `kick` can pulse more than three
 * times a second, whatever the music does.
 */

export const FFT_SIZE = 2048;
export const SMOOTHING = 0.5;
/**
 * The analyser's decibel range. Its default (-100…-30 dB) clips: a loud track's bass bins sit
 * at 255 the whole bar, kick or no kick. -90…-10 dB keeps the top of the scale free (a
 * full-scale sine reads -13.5 dB through the Blackman window).
 */
export const MIN_DECIBELS = -90;
export const MAX_DECIBELS = -10;
export const BANDS = 128;
// As wide as the spectrum, so both rows of the texture span 0–1 in x.
const WAVE = 128;
const MIN_HZ = 30;
const MAX_HZ = 16000;
/** Seconds between two kicks, at least: under three a second. */
export const KICK_REFRACTORY = 0.34;

export interface AudioFeatures {
  /** Seconds since the analysis began. */
  time: number;
  dt: number;
  /** Band envelopes, 0–1 against each band's recent peak. */
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  air: number;
  /** Overall loudness, slow (0–1 against its recent peak). */
  level: number;
  /** Loudness in absolute terms: 0 in silence, whatever came before. */
  presence: number;
  /** A kick's envelope: up in ~30 ms on a bass onset, down over ~0.3 s. */
  kick: number;
  /** The same for onsets in the top of the spectrum (hats, consonants): sparkle. */
  hat: number;
  /** Kicks counted since the start. */
  beat: number;
  /** 0–1 from one kick to the next expected one (0 with no steady beat). */
  beatPhase: number;
  /** How steady the beat is, 0–1. */
  beatConfidence: number;
  /** A phase that turns once per beat (once in 0.6 s with no beat), never stopping: for breathing. */
  breath: number;
  /** Musical time: runs with the clock, faster with the music; never stops. */
  flow: number;
  /** True on the frame a kick was found. */
  onset: boolean;
  /** Seconds between kicks, as estimated. */
  period: number;
}

function follow(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
}

/**
 * A byte of the analyser as power. The bytes are decibels (0…255 over MIN…MAX_DECIBELS), which
 * squeeze a kick and the bar between two kicks into a tenth of the scale; as power they stand
 * apart.
 */
const POWER = new Float32Array(256);
for (let byte = 0; byte < 256; byte += 1) POWER[byte] = Math.pow(10, (byte / 255 - 1) * (MAX_DECIBELS - MIN_DECIBELS) / 10);

/** A band's level between two frequencies: the root of its mean power, 0–1 (1: every bin at MAX_DECIBELS). */
function bandLevel(frequency: Uint8Array, sampleRate: number, fromHz: number, toHz: number): number {
  const nyquist = sampleRate / 2;
  const from = Math.max(1, Math.floor(fromHz / nyquist * frequency.length));
  const to = Math.min(frequency.length, Math.max(from + 1, Math.ceil(toHz / nyquist * frequency.length)));
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += POWER[frequency[index] ?? 0]!;
  return Math.sqrt(sum / (to - from));
}

class Band {
  public value = 0;
  /** The level before the envelope, against the recent peak. */
  public normal = 0;
  private peak = 0.02;
  private trough = 0;
  private readonly fromHz: number;
  private readonly toHz: number;
  private readonly attack: number;
  private readonly release: number;
  public constructor(fromHz: number, toHz: number, attack: number, release: number) {
    this.fromHz = fromHz;
    this.toHz = toHz;
    this.attack = attack;
    this.release = release;
  }

  public update(frequency: Uint8Array, sampleRate: number, dt: number): number {
    const raw = bandLevel(frequency, sampleRate, this.fromHz, this.toHz);
    // The recent peak: up at once, down over ten seconds, never under a floor that keeps hiss at rest.
    this.peak = Math.max(raw, this.peak + (0.004 - this.peak) * (1 - Math.exp(-dt / 10)));
    // The recent trough: down quickly, up over three seconds. Between the two the band is
    // stretched, so a bass line under the kicks still leaves the kicks standing out.
    this.trough += (raw - this.trough) * (1 - Math.exp(-dt / (raw < this.trough ? 0.12 : 3)));
    const stretched = Math.min(1, Math.max(0, (raw - this.trough) / Math.max(this.peak - this.trough, this.peak * 0.3)));
    this.normal = 0.4 * Math.pow(Math.min(1, raw / this.peak), 0.8) + 0.6 * stretched;
    this.value = follow(this.value, this.normal, dt, this.attack, this.release);
    return this.value;
  }
}

/** Onsets of one band: a rise over its own short average, above what is usual lately. */
class Onsets {
  public envelope = 0;
  private slow = 0;
  private mean = 0;
  private peak = 0.02;
  private since = 10;
  private impulse = 0;
  private readonly fromHz: number;
  private readonly toHz: number;
  private readonly refractory: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly threshold: number;
  public constructor(fromHz: number, toHz: number, refractory: number, attack: number, release: number, threshold: number) {
    this.fromHz = fromHz;
    this.toHz = toHz;
    this.refractory = refractory;
    this.attack = attack;
    this.release = release;
    this.threshold = threshold;
  }

  /** Returns the strength of an onset found this frame (0: none). */
  public update(frequency: Uint8Array, sampleRate: number, dt: number): number {
    const raw = bandLevel(frequency, sampleRate, this.fromHz, this.toHz);
    this.peak = Math.max(raw, this.peak + (0.004 - this.peak) * (1 - Math.exp(-dt / 10)));
    const level = raw / this.peak;
    const novelty = Math.max(0, level - this.slow);
    this.slow += (level - this.slow) * (1 - Math.exp(-dt / 0.2));
    this.mean += (novelty - this.mean) * (1 - Math.exp(-dt / 1.5));
    this.since += dt;
    let strength = 0;
    if (this.since >= this.refractory && novelty > this.threshold + this.mean * 1.6) {
      strength = Math.min(1, 0.5 + novelty);
      this.since = 0;
      this.impulse = strength;
    }
    this.envelope = follow(this.envelope, this.impulse, dt, this.attack, this.release);
    // The impulse holds for the attack, then lets the envelope fall.
    if (this.since > this.attack * 2.2) this.impulse = 0;
    return strength;
  }
}

export class AudioAnalysis {
  public readonly features: AudioFeatures = {
    time: 0, dt: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0, level: 0, presence: 0, kick: 0, hat: 0,
    beat: 0, beatPhase: 0, beatConfidence: 0, breath: 0, flow: 0, onset: false, period: 0.5
  };
  /** The spectrum in BANDS log-spaced bands, 0–1, smoothed. */
  public readonly spectrum = new Float32Array(BANDS);
  /** Row 0 the spectrum, row 1 the waveform; what `uSpec` holds. */
  private readonly data = new Float32Array(Math.max(BANDS, WAVE) * 2);
  private readonly width = Math.max(BANDS, WAVE);
  private texture: WebGLTexture | null = null;
  /** The texture is behind the data. */
  private stale = true;
  private readonly bass = new Band(35, 140, 0.035, 0.26);
  private readonly lowMid = new Band(140, 450, 0.04, 0.3);
  private readonly mid = new Band(450, 2000, 0.045, 0.3);
  private readonly high = new Band(2000, 6000, 0.03, 0.22);
  private readonly air = new Band(6000, 15000, 0.025, 0.18);
  private readonly loud = new Band(35, 12000, 0.25, 0.9);
  private readonly kicks = new Onsets(35, 130, KICK_REFRACTORY, 0.03, 0.3, 0.1);
  private readonly hats = new Onsets(5000, 14000, 0.11, 0.015, 0.14, 0.045);
  private spectrumPeak = 0.4;
  private lastKick = -10;
  private readonly intervals: number[] = [];

  public update(frequency: Uint8Array, waveform: Uint8Array, sampleRate: number, dtSeconds: number): AudioFeatures {
    const f = this.features;
    const dt = Math.min(0.1, Math.max(1e-4, dtSeconds));
    f.dt = dt;
    f.time += dt;
    f.bass = this.bass.update(frequency, sampleRate, dt);
    f.lowMid = this.lowMid.update(frequency, sampleRate, dt);
    f.mid = this.mid.update(frequency, sampleRate, dt);
    f.high = this.high.update(frequency, sampleRate, dt);
    f.air = this.air.update(frequency, sampleRate, dt);
    f.level = this.loud.update(frequency, sampleRate, dt);
    // Absolute loudness: the byte scale itself, so silence is 0 whatever the peaks were.
    let total = 0;
    for (let index = 2; index < frequency.length >> 1; index += 1) total += frequency[index] ?? 0;
    f.presence = follow(f.presence, Math.min(1, total / ((frequency.length >> 1) - 2) / 255 * 2.4), dt, 0.2, 0.8);

    const kick = this.kicks.update(frequency, sampleRate, dt);
    f.onset = kick > 0;
    f.kick = this.kicks.envelope;
    this.hats.update(frequency, sampleRate, dt);
    f.hat = this.hats.envelope;

    if (f.onset) {
      const interval = f.time - this.lastKick;
      this.lastKick = f.time;
      f.beat += 1;
      if (interval > 0.3 && interval < 1.25) {
        this.intervals.push(interval);
        if (this.intervals.length > 8) this.intervals.shift();
      } else if (interval >= 2.5) this.intervals.length = 0;
    }
    if (this.intervals.length >= 3) {
      const sorted = [...this.intervals].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1]!;
      const spread = sorted.reduce((sum, value) => sum + Math.abs(value - median), 0) / sorted.length / median;
      f.period = median;
      const alive = f.time - this.lastKick < median * 2.5 ? 1 : 0;
      f.beatConfidence = follow(f.beatConfidence, alive * Math.max(0, 1 - spread * 6), dt, 0.5, 1.2);
    } else f.beatConfidence = follow(f.beatConfidence, 0, dt, 0.5, 1.2);
    f.beatPhase = f.beatConfidence > 0.05 ? Math.min(1, (f.time - this.lastKick) / f.period) : 0;
    const breathRate = 1 / (f.beatConfidence > 0.3 ? f.period : 0.6);
    f.breath += dt * breathRate;
    f.flow += dt * (0.4 + 1.1 * f.level * f.presence + 0.9 * f.kick);

    this.stale = true;
    this.bands(frequency, sampleRate, dt);
    for (let index = 0; index < WAVE; index += 1) {
      const at = Math.floor(index * waveform.length / WAVE);
      this.data[this.width + index] = ((waveform[at] ?? 128) - 128) / 128;
    }
    return f;
  }

  private bands(frequency: Uint8Array, sampleRate: number, dt: number): void {
    const nyquist = sampleRate / 2;
    const last = frequency.length - 1;
    let peak = 0;
    for (let band = 0; band < BANDS; band += 1) {
      const lowHz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, band / BANDS);
      const highHz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (band + 1) / BANDS);
      const from = lowHz / nyquist * frequency.length;
      const to = highHz / nyquist * frequency.length;
      let value: number;
      if (to - from < 1) {
        const lower = Math.min(last, Math.floor(from));
        const blend = from - lower;
        value = (frequency[lower] ?? 0) * (1 - blend) + (frequency[Math.min(last, lower + 1)] ?? 0) * blend;
      } else {
        value = 0;
        for (let index = Math.floor(from); index < Math.min(last + 1, Math.ceil(to)); index += 1) value = Math.max(value, frequency[index] ?? 0);
      }
      // Music falls off toward the top of the spectrum; a tilt brings the bands level.
      const tilted = value / 255 + 0.3 * (band / BANDS) - 0.04;
      peak = Math.max(peak, tilted);
      const floor = this.spectrumPeak * 0.4;
      const normal = Math.min(1, Math.max(0, (tilted - floor) / Math.max(0.08, this.spectrumPeak - floor)));
      const shaped = normal * normal * (3 - 2 * normal);
      this.spectrum[band] = follow(this.spectrum[band] ?? 0, shaped, dt, 0.03, 0.2);
      this.data[band] = this.spectrum[band]!;
    }
    this.spectrumPeak = Math.max(peak, this.spectrumPeak + (0.3 - this.spectrumPeak) * (1 - Math.exp(-dt / 8)));
  }

  /**
   * The uniforms of glsl.ts's AUDIO block. The spectrum and waveform go up once per update; the
   * texture belongs to the kit of the first call, so the host makes that call before any
   * visualization does (a visualization's kit goes when it does).
   */
  public uniforms(kit: Kit): Uniforms {
    if (!this.texture) this.texture = kit.dataTexture(this.width, 2, 1, this.data);
    else if (this.stale) kit.updateDataTexture(this.texture, this.width, 2, 1, this.data);
    this.stale = false;
    const f = this.features;
    return {
      uTime: f.time, uDt: f.dt, uFlow: f.flow, uBass: f.bass, uLowMid: f.lowMid, uMid: f.mid, uHigh: f.high, uAir: f.air,
      uLevel: f.level, uKick: f.kick, uHat: f.hat, uBeat: f.beat, uBeatPhase: f.beatPhase, uBreath: f.breath,
      uPresence: f.presence, uSpec: this.texture
    };
  }

  public release(kit: Kit): void {
    kit.deleteTexture(this.texture);
    this.texture = null;
    this.stale = true;
  }
}
