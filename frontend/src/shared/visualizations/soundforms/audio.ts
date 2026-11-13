import { decimate, rateFactor, scaledFftSize } from "../audio-rate";
import { autoGain, bandEdges, bandValue, envelope, triggerIndex } from "./analysis";

/**
 * What Formy dźwięku hears: an analyser of its own behind the player's (so the panel's settings
 * for other visualizers do not change it), read at 44.1/48 kHz on a faster device as
 * audio-rate.ts explains, and turned into what the scenes use — a spectrum in bands spaced the way
 * the ear hears them, a steadied waveform, the loudness of bass, middle and treble, and a beat.
 */

/** Bands of the spectrum, 32 Hz to 16 kHz on a logarithmic scale. */
export const BANDS = 128;
/** The waveform: its newest samples from a rising zero crossing, as an oscilloscope shows them. */
export const WAVE = 1024;
/** Samples the spectrum is taken from, at 44.1/48 kHz. */
const FFT = 2048;

export class AudioFeed {
  /** 0–1 per band, quick to rise and slower to fall. */
  readonly spectrum = new Float32Array(BANDS);
  /** −1…1, the quiet ones brought up to a readable size. */
  readonly wave = new Float32Array(WAVE);
  bass = 0;
  mid = 0;
  treble = 0;
  /** Loudness of the whole spectrum, 0–1. */
  level = 0;
  /** 1 at a kick, back to 0 within half a second. */
  beat = 0;
  /** The loudness of the last seconds: how much is going on. */
  energy = 0;

  private readonly node: AnalyserNode;
  private readonly factor: number;
  private readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly raw: Float32Array<ArrayBuffer>;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly edges: Float32Array;
  private readonly fresh = new Float32Array(BANDS);
  private fastBass = 0;
  private slowBass = 0;
  private sinceBeat = 1;
  private waveGain = 0.3;
  /** How loud the music has been lately, before the gain that brings quiet music up. */
  private loudness = 0.3;
  private connected = true;

  constructor(private readonly source: AnalyserNode) {
    const context = source.context;
    this.factor = rateFactor(context.sampleRate);
    const node = context.createAnalyser();
    node.fftSize = scaledFftSize(FFT, this.factor);
    node.smoothingTimeConstant = 0.5;
    node.minDecibels = -90;
    node.maxDecibels = -22;
    source.connect(node);
    this.node = node;
    const samples = node.fftSize / this.factor;
    this.bytes = new Uint8Array(new ArrayBuffer(node.frequencyBinCount));
    this.raw = new Float32Array(new ArrayBuffer(node.fftSize * 4));
    this.samples = new Float32Array(new ArrayBuffer(samples * 4));
    // The bins of the audible part: the same width as at 44.1/48 kHz (audio-rate.ts).
    const binHz = context.sampleRate / node.fftSize;
    this.edges = bandEdges(BANDS, 32, Math.min(16000, (context.sampleRate / this.factor) * 0.48), binHz);
  }

  /** Read the analyser and move every value towards what it hears; `dt` in seconds. */
  update(dt: number): void {
    if (!this.connected) return;
    const step = Math.min(0.1, Math.max(0.001, dt));
    this.node.getByteFrequencyData(this.bytes);
    const audible = this.bytes.length / this.factor;
    let raw = 0;
    for (let band = 0; band < BANDS; band += 1) {
      const value = bandValue(this.bytes, audible, this.edges[band]!, this.edges[band + 1]!, band / BANDS);
      this.fresh[band] = value;
      raw += value;
    }
    // Quiet music is brought up towards the level of loud music, slowly, so a soft passage still
    // moves the picture; silence is zero whatever the gain, and stays calm.
    this.loudness = envelope(this.loudness, raw / BANDS, step, 0.8, 4);
    const gain = autoGain(this.loudness);
    let sum = 0, low = 0, middle = 0, high = 0;
    let lows = 0, middles = 0, highs = 0;
    for (let band = 0; band < BANDS; band += 1) {
      const value = Math.min(1, this.fresh[band]! * gain);
      const previous = this.spectrum[band]!;
      this.spectrum[band] = envelope(previous, value, step, 0.025, 0.16);
      sum += value;
      if (band < 22) { low += value; lows += 1; }
      else if (band < 70) { middle += value; middles += 1; }
      else if (band < 112) { high += value; highs += 1; }
    }
    this.level = envelope(this.level, sum / BANDS, step, 0.05, 0.25);
    this.bass = envelope(this.bass, low / Math.max(1, lows), step, 0.03, 0.2);
    this.mid = envelope(this.mid, middle / Math.max(1, middles), step, 0.04, 0.25);
    this.treble = envelope(this.treble, high / Math.max(1, highs), step, 0.03, 0.2);
    this.energy += (this.level - this.energy) * (1 - Math.exp(-step / 2.5));

    // A kick: the bass of this instant well above that of the last half second.
    const instant = low / Math.max(1, lows);
    this.fastBass += (instant - this.fastBass) * (1 - Math.exp(-step / 0.03));
    this.slowBass += (instant - this.slowBass) * (1 - Math.exp(-step / 0.45));
    this.sinceBeat += step;
    if (this.fastBass > this.slowBass * 1.18 + 0.045 && this.sinceBeat > 0.22 && this.fastBass > 0.12) {
      this.beat = 1;
      this.sinceBeat = 0;
    } else {
      this.beat *= Math.exp(-step * 5);
    }

    this.node.getFloatTimeDomainData(this.raw);
    decimate(this.raw, this.factor, this.samples);
    const start = triggerIndex(this.samples, WAVE);
    let peak = 0;
    for (let index = 0; index < WAVE; index += 1) {
      const value = this.samples[start + index] ?? 0;
      peak = Math.max(peak, Math.abs(value));
    }
    // Quiet music still draws a waveform you can see; silence stays a flat line.
    this.waveGain += (Math.max(0.12, peak) - this.waveGain) * (1 - Math.exp(-step / 0.8));
    const waveScale = Math.min(6, 0.85 / this.waveGain);
    for (let index = 0; index < WAVE; index += 1) {
      this.wave[index] = Math.max(-1, Math.min(1, (this.samples[start + index] ?? 0) * waveScale));
    }
  }

  /** A waveform sample averaged over `width` neighbours, `position` 0–1 across the window. */
  waveAt(position: number, width: number): number {
    const center = Math.round(position * (WAVE - 1));
    const half = Math.max(0, Math.floor(width / 2));
    let sum = 0, count = 0;
    for (let index = center - half; index <= center + half; index += 1) {
      if (index < 0 || index >= WAVE) continue;
      sum += this.wave[index]!;
      count += 1;
    }
    return count ? sum / count : 0;
  }

  dispose(): void {
    if (!this.connected) return;
    this.connected = false;
    try {
      this.source.disconnect(this.node);
    } catch { /* już odłączony */ }
  }
}

/**
 * The music's recent past as a texture the shaders read (gl.ts, HISTORY): a row per moment — 60
 * a second whatever the frame rate — with the spectrum in red and the waveform in green. The
 * newest row is at `head`; `phase` is how far time has moved on since it was written, so lines
 * drawn from it flow smoothly instead of stepping a row at a time.
 */
export class History {
  readonly texture: WebGLTexture;
  head = 0;
  phase = 0;
  private clock = 0;
  private readonly row = new Uint8Array(BANDS * 2);

  constructor(private readonly gl: WebGL2RenderingContext, readonly rows: number, private readonly rate = 60) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const empty = new Uint8Array(BANDS * rows * 2);
    for (let index = 1; index < empty.length; index += 2) empty[index] = 128;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, BANDS, rows, 0, gl.RG, gl.UNSIGNED_BYTE, empty);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = texture;
  }

  /** Write the moments that passed since the last frame. */
  push(feed: AudioFeed, dt: number): void {
    this.clock += Math.min(0.25, Math.max(0, dt)) * this.rate;
    const steps = Math.min(4, Math.floor(this.clock));
    this.clock -= Math.floor(this.clock);
    this.phase = this.clock;
    if (steps <= 0) return;
    const width = WAVE / BANDS;
    for (let band = 0; band < BANDS; band += 1) {
      this.row[band * 2] = Math.round(Math.min(1, feed.spectrum[band]!) * 255);
      this.row[band * 2 + 1] = Math.round((feed.waveAt((band + 0.5) / BANDS, width) * 0.5 + 0.5) * 255);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let step = 0; step < steps; step += 1) {
      this.head = (this.head + 1) % this.rows;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.head, BANDS, 1, gl.RG, gl.UNSIGNED_BYTE, this.row);
    }
  }

  /** Bind to a texture unit and set the uniforms HISTORY reads. */
  bind(program: { i(name: string, x: number): unknown; f(name: string, x: number): unknown }, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    program.i("uHist", unit);
    program.i("uHead", this.head);
    program.i("uRows", this.rows);
    program.f("uPhase", this.phase);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
