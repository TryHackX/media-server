import type { RetroAudio } from "../types";

/**
 * What the Cthugha-like scenes hear: the newest samples of both channels at a lively level, a
 * spectrum in bands, and the moments worth changing on.
 *
 * The originals read a sound card's line in, which a hi-fi drove hard; today's tracks come in at
 * any level. An automatic gain brings the music's recent loudness to where the waves fill a good
 * part of the screen, and leaves silence silent.
 */

/** Samples of each channel the waves draw from (the newest), at 44.1/48 kHz some 21 ms. */
export const SAMPLES = 1024;
/** Spectrum bands, spaced evenly in pitch from 40 Hz to 16 kHz. */
export const BANDS = 48;

export class Listener {
  readonly left = new Float32Array(SAMPLES);
  readonly right = new Float32Array(SAMPLES);
  readonly mono = new Float32Array(SAMPLES);
  /** The same through a gentle low-pass (about 2.5 kHz): rounder waves, as a sound filter gave. */
  readonly smoothLeft = new Float32Array(SAMPLES);
  readonly smoothRight = new Float32Array(SAMPLES);
  readonly smoothMono = new Float32Array(SAMPLES);
  readonly bands = new Float32Array(BANDS);
  /** Loudness after the gain, about 0–1 (0.35 is a usual level). */
  level = 0;
  /** The gain on the samples now. */
  gain = 1;
  /** 1 at a kick, falling back to 0 soon after; true for the frame of one. */
  beat = 0;
  onset = false;
  /** A sudden rise in loudness: the attack the originals changed their effect on. */
  attack = false;
  sounding = false;
  silence = 0;

  private envelope = 0.12;
  private fast = 0;
  private slow = 0;
  private sinceAttack = 10;
  /** The kick detector: the bass (a low-pass of the mono mix) against its own recent level. */
  private lowA = 0;
  private lowB = 0;
  private bassAverage = 0;
  private sinceKick = 1;
  private pulse = 0;
  /** Kicks and attacks heard since a step last took them (steps are fewer than frames). */
  private kicksHeard = 0;
  private attackHeard = false;

  hear(audio: RetroAudio, dt: number): void {
    const step = Math.min(0.1, Math.max(0.001, dt));
    const rms = Math.max(audio.rmsLeft, audio.rmsRight);
    this.sounding = audio.sounding;
    this.silence = audio.silence;
    if (audio.sounding) {
      const tau = rms > this.envelope ? 0.6 : 4;
      this.envelope += (rms - this.envelope) * (1 - Math.exp(-step / tau));
    }
    this.gain = Math.min(7, Math.max(0.6, 0.27 / Math.max(this.envelope, 0.035)));
    const gain = audio.sounding || audio.silence < 0.5 ? this.gain : this.gain * Math.max(0, 1 - audio.silence);

    const from = audio.left.length - SAMPLES;
    for (let index = 0; index < SAMPLES; index += 1) {
      // A soft knee instead of a hard clip: loud peaks round off as an overdriven input did.
      const l = (audio.left[from + index] ?? 0) * gain;
      const r = (audio.right[from + index] ?? 0) * gain;
      this.left[index] = l / (1 + Math.abs(l) * 0.25);
      this.right[index] = r / (1 + Math.abs(r) * 0.25);
      this.mono[index] = (this.left[index]! + this.right[index]!) / 2;
    }
    // Two passes of a one-pole low-pass, forwards and back, so the smoothing does not shift.
    const pole = Math.exp((-2 * Math.PI * 2500) / Math.max(8000, audio.rate || 48000));
    for (const [from, to] of [[this.left, this.smoothLeft], [this.right, this.smoothRight]] as const) {
      let state = from[0]!;
      for (let index = 0; index < SAMPLES; index += 1) {
        state = from[index]! + (state - from[index]!) * pole;
        to[index] = state;
      }
      state = to[SAMPLES - 1]!;
      for (let index = SAMPLES - 1; index >= 0; index -= 1) {
        state = to[index]! + (state - to[index]!) * pole;
        to[index] = state * 1.15;
      }
    }
    for (let index = 0; index < SAMPLES; index += 1) this.smoothMono[index] = (this.smoothLeft[index]! + this.smoothRight[index]!) / 2;

    // Bands: the strongest bin of each, read on the analyser's decibel scale.
    const binHz = audio.binHz > 0 ? audio.binHz : 23.4;
    const bins = audio.spectrum.length;
    for (let band = 0; band < BANDS; band += 1) {
      const low = 40 * Math.pow(400, band / BANDS);
      const high = 40 * Math.pow(400, (band + 1) / BANDS);
      const a = Math.max(1, Math.floor(low / binHz));
      const b = Math.min(bins - 1, Math.max(a, Math.ceil(high / binHz)));
      let peak = 0;
      for (let bin = a; bin <= b; bin += 1) peak = Math.max(peak, audio.spectrum[bin] ?? 0);
      // A floor under the noise, a curve for contrast, a little lift for the treble (which
      // music has less of): bars that rise and fall rather than stand.
      const raised = Math.min(1, Math.max(0, (peak - 0.3) / 0.62) * (0.85 + 0.35 * (band / BANDS)));
      const lifted = raised * raised * (1.6 - 0.6 * raised);
      this.bands[band] = audio.sounding ? lifted : this.bands[band]! * Math.exp(-step * 6);
    }

    const loud = rms * gain;
    this.level += (loud - this.level) * (1 - Math.exp(-step / (loud > this.level ? 0.03 : 0.25)));
    // A kick: the bass of the samples new since the last frame well above its recent level.
    const length = audio.left.length;
    const fresh = Math.max(1, Math.min(length, audio.fresh || Math.round((audio.rate || 48000) * step)));
    const k = 1 - Math.exp((-2 * Math.PI * 120) / Math.max(8000, audio.rate || 48000));
    let energy = 0;
    for (let index = length - fresh; index < length; index += 1) {
      const sample = ((audio.left[index] ?? 0) + (audio.right[index] ?? 0)) * 0.5;
      this.lowA += (sample - this.lowA) * k;
      this.lowB += (this.lowA - this.lowB) * k;
      energy += this.lowB * this.lowB;
    }
    const bass = Math.sqrt(energy / fresh) * this.gain;
    this.sinceKick += step;
    const kick = audio.sounding && this.sinceKick > 0.22 && bass > this.bassAverage * 1.45 + 0.012;
    this.bassAverage += (bass - this.bassAverage) * (1 - Math.exp(-step / 0.45));
    if (kick) {
      this.sinceKick = 0;
      this.kicksHeard += 1;
      this.pulse = 1;
    } else {
      this.pulse *= Math.exp(-step * 7);
    }
    this.onset = kick || audio.onset;
    this.beat = Math.max(audio.beat, this.pulse);
    // An attack: the last tenth of a second much louder than the last two seconds.
    this.fast += (loud - this.fast) * (1 - Math.exp(-step / 0.08));
    this.slow += (loud - this.slow) * (1 - Math.exp(-step / 2));
    this.sinceAttack += step;
    this.attack = audio.sounding && this.sinceAttack > 1 && this.fast > this.slow * 1.7 + 0.04;
    if (this.attack) {
      this.sinceAttack = 0;
      this.attackHeard = true;
    }
  }

  /** The kicks heard since the last call (a step takes them all at once). */
  takeKicks(): number {
    const kicks = this.kicksHeard;
    this.kicksHeard = 0;
    return kicks;
  }

  /** Whether a loud attack came since the last call. */
  takeAttack(): boolean {
    const attack = this.attackHeard;
    this.attackHeard = false;
    return attack;
  }
}
