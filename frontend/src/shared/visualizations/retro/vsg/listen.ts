import type { RetroAudio } from "../types";
import type { Raster } from "./raster";

/**
 * What the effects of VSG+ (DOS) hear, worked out once a frame from the shared analysis
 * (retro/analysis.ts): sixteen bands, the loudness against what the music has lately been, and
 * a gain that brings the waveform's recent peaks to ±1. Only type imports, so the tests run it
 * as it is (vsg.test.ts).
 */

/** The screen of VGA mode 12h. */
export const WIDTH = 640;
export const HEIGHT = 480;

/** One effect on screen; a new one each time it comes on (the screen is cleared, as by CLS). */
export interface VsgEffect {
  /** 60 times a second, whatever the frame rate: what the effect remembers moves on. */
  tick?(input: VsgInput): void;
  /** Once a frame, onto a black screen. */
  draw(screen: Raster, input: VsgInput): void;
}

/** Bands of the spectrum the effects read, log-spaced from LOW_HZ to HIGH_HZ. */
export const BANDS = 16;
export const LOW_HZ = 40;
export const HIGH_HZ = 16000;
/** The spectrum's 0–1 (−90…−20 dB) that counts as a band's 0, and the lift of each band above the first. */
const FLOOR = 0.42;
const TILT = 0.006;

/** What an effect is given, each frame and each tick (the scene fills it in). */
export interface VsgInput {
  audio: RetroAudio;
  /** Seconds the effect has been on screen, and the step of this frame or tick. */
  time: number;
  dt: number;
  /** Loudness 0–1 against the music's recent loudness: about 0.5 as it usually plays. */
  level: number;
  levelLeft: number;
  levelRight: number;
  /** What brings the waveform's recent peaks to ±1. */
  gain: number;
  /** BANDS values 0–1, the lowest band first. */
  bands: Float32Array;
  /** Means of the bands: the lowest four, and the six highest. */
  bass: number;
  treble: number;
  /** 1 at a kick, falling to 0; a kick in this frame (or since the last tick). */
  beat: number;
  onset: boolean;
  /** 0 ≤ value < 1, the effect's own sequence. */
  random: () => number;
}

/** The BANDS + 1 edges of the bands in Hz. */
export function bandEdges(count = BANDS, low = LOW_HZ, high = HIGH_HZ): number[] {
  const edges: number[] = [];
  for (let index = 0; index <= count; index += 1) edges.push(low * (high / low) ** (index / count));
  return edges;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Towards `target`: `rise` seconds when it is above, `fall` when below. */
export function follow(value: number, target: number, dt: number, rise: number, fall: number): number {
  return value + (target - value) * (1 - Math.exp(-dt / (target > value ? rise : fall)));
}

export class Listener {
  readonly bands = new Float32Array(BANDS);
  level = 0;
  levelLeft = 0;
  levelRight = 0;
  gain = 3;
  bass = 0;
  treble = 0;
  /** The music's usual RMS and its recent peak, both slow. */
  private usual = 0.12;
  private peak = 0.3;
  private readonly edges = bandEdges();

  update(audio: RetroAudio, dt: number): void {
    const step = Math.min(0.1, Math.max(0.001, dt));
    const spectrum = audio.spectrum;
    for (let band = 0; band < BANDS; band += 1) {
      const from = Math.max(1, Math.round(this.edges[band]! / audio.binHz));
      const to = Math.min(spectrum.length - 1, Math.max(from, Math.round(this.edges[band + 1]! / audio.binHz) - 1));
      let strongest = 0;
      for (let bin = from; bin <= to; bin += 1) if (spectrum[bin]! > strongest) strongest = spectrum[bin]!;
      const value = clamp01((strongest - FLOOR + TILT * band) / (1 - FLOOR));
      this.bands[band] = audio.sounding ? value : this.bands[band]! * Math.exp(-step * 8);
    }
    this.bass = (this.bands[0]! + this.bands[1]! + this.bands[2]! + this.bands[3]!) / 4;
    let treble = 0;
    for (let band = 10; band < BANDS; band += 1) treble += this.bands[band]!;
    this.treble = treble / 6;

    // Loudness against the usual: the usual follows slowly and holds through silence.
    const rms = Math.max(audio.rmsLeft, audio.rmsRight);
    if (audio.sounding) {
      this.usual = follow(this.usual, rms, step, 2, 6);
      this.peak = follow(this.peak, Math.max(audio.peakLeft, audio.peakRight), step, 0.04, 1.2);
    }
    const usual = Math.max(this.usual, 0.01);
    const loud = (value: number): number => (audio.sounding ? clamp01(value / (2 * usual)) : 0);
    this.level = follow(this.level, loud(rms), step, 0.03, 0.15);
    this.levelLeft = follow(this.levelLeft, loud(audio.rmsLeft), step, 0.03, 0.15);
    this.levelRight = follow(this.levelRight, loud(audio.rmsRight), step, 0.03, 0.15);
    this.gain = Math.min(30, 0.95 / Math.max(this.peak, 0.02));
  }
}

/**
 * Where a window of `span` samples should start for a steady picture: just after a rising zero
 * crossing that came up from below −`floor`, the newest such one within `search` samples of the
 * newest possible start. Without one, the newest window.
 */
export function trigger(samples: Float32Array, span: number, search: number, floor = 0.02): number {
  const newest = samples.length - span;
  const oldest = Math.max(1, newest - search);
  let low = false;
  let found = -1;
  // Forwards, so "came up from below" is known; the last crossing found is the newest.
  for (let index = oldest; index <= newest; index += 1) {
    const value = samples[index]!;
    if (value < -floor) low = true;
    else if (low && value >= 0 && samples[index - 1]! < 0) {
      found = index;
      low = false;
    }
  }
  return found >= 0 ? found : newest;
}
