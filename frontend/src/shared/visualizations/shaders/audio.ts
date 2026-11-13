import { decimate, rateFactor, scaledFftSize } from "../audio-rate";
import type { AudioName, MvAudioOptions } from "./types";

/**
 * The music as the shaders were written to read it.
 *
 * Monkey Hi Hat's shaders read eyecandy's textures (MIT, Jon McGuire), and eyecandy's numbers are
 * reproduced here from the player's analyser:
 *
 *   - `eyecandyShadertoy`, 1024 × 2: row 0 the spectrum up to 11 kHz (512 bins of a 2048-sample
 *     Blackman FFT, smoothed 0.8 the way WebAudio smooths, stretched to 1024 texels), row 1 the
 *     newest 1024 samples as 0–1 with 0.5 silence — as Shadertoy's audio input, but in green;
 *   - `eyecandyWebAudio`, 1024 × 128: that smoothed spectrum over 0–22 kHz, newest row first, a row
 *     every 1024 samples of 44.1 kHz;
 *   - `eyecandyFreqDB`, the same unsmoothed, scaled for a 90 dB peak.
 *
 * eyecandy's decibels are of 16-bit samples and FftSharp's doubled magnitudes, which puts them
 * 20·log10(2·32767) ≈ 96.3 dB above WebAudio's dBFS; its spectrum texture divides by 60, its
 * decibel history by 90. Above 48 kHz the analysers are read down to 48 kHz (audio-rate.ts), so
 * a 192 kHz device shows what a 44.1/48 kHz one does.
 *
 * music_visualizer's shaders read four 1D textures of 2048 values: each channel's waveform, scaled
 * to a peak of 0.66, and each channel's spectrum (a 4096-point Hann FFT of the signal at half rate,
 * |X|/√4096). That is the data they were written for; how it is held steady here is this project's
 * own: the segment shown is the one, within a period of the strongest low tone, that best matches
 * the one shown before (or starts on a rising zero crossing). Worked out per frame, for each preset
 * with its `wave_smooth` and `fft_smooth`.
 */

const EYECANDY_WIDTH = 1024;
const HISTORY_ROWS = 128;
/** eyecandy adds a row per 1024 samples captured at 44.1 kHz. */
const ROWS_PER_SECOND = 44100 / 1024;
const EYECANDY_DB_OFFSET = 20 * Math.log10(2 * 32767);
const WEBAUDIO_PEAK = 60;
const DECIBEL_PEAK = 90;

const floatView = new Float32Array(1);
const bitsView = new Uint32Array(floatView.buffer);

/** A float as the 16 bits of a half float. */
export function toHalf(value: number): number {
  floatView[0] = value;
  const bits = bitsView[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 112;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    return sign | (((mantissa | 0x800000) >> (1 - exponent)) + 0x1000) >> 13;
  }
  if (exponent >= 31) return sign | 0x7c00;
  return sign | ((exponent << 10) + ((mantissa + 0x1000) >> 13));
}

/** eyecandy's value for a WebAudio decibel reading, never below 0 (silence reads −∞ dB). */
const eyecandy = (decibels: number, peak: number): number => Math.max(0, (decibels + EYECANDY_DB_OFFSET) / peak);

interface Tap {
  node: AnalyserNode;
  /** Of the analyser, at the context's rate. */
  rawFrequency: Float32Array<ArrayBuffer>;
  rawTime: Float32Array<ArrayBuffer>;
}

/** The player's signal as eyecandy and music_visualizer took it: analysers of their own. */
export class ShaderAudio {
  private readonly factor: number;
  private readonly context: BaseAudioContext;
  private smoothed: Tap | null = null;
  private raw: Tap | null = null;
  private stereo: { splitter: ChannelSplitterNode; left: Tap; right: Tap } | null = null;
  private readonly textures = new Map<AudioName, WebGLTexture>();
  /** The 2-row Shadertoy texture, RGBA floats. */
  private readonly shadertoy = new Float32Array(EYECANDY_WIDTH * 2 * 4);
  /** The histories, half floats, newest row first. */
  private readonly webAudioRows = new Uint16Array(EYECANDY_WIDTH * HISTORY_ROWS * 4);
  private readonly decibelRows = new Uint16Array(EYECANDY_WIDTH * HISTORY_ROWS * 4);
  private readonly smoothedDb = new Float32Array(EYECANDY_WIDTH);
  private readonly rawDb = new Float32Array(EYECANDY_WIDTH);
  private readonly wave = new Float32Array(2048);
  private rowsDue = 0;
  private lastUpdate = 0;
  /** The newest 8192 samples of each channel at 48 kHz or below, for music_visualizer. */
  public readonly left = new Float32Array(8192);
  public readonly right = new Float32Array(8192);
  /** Where the newest of them stands, in samples since the context started. */
  public writer = 0;
  public readonly nominalRate: number;

  public constructor(private readonly gl: WebGL2RenderingContext, private readonly source: AnalyserNode) {
    this.context = source.context;
    this.factor = rateFactor(this.context.sampleRate);
    this.nominalRate = this.context.sampleRate / this.factor;
  }

  private tap(samples: number, smoothing: number): Tap {
    const node = this.context.createAnalyser();
    node.fftSize = scaledFftSize(samples, this.factor);
    node.smoothingTimeConstant = smoothing;
    this.source.connect(node);
    return {
      node,
      rawFrequency: new Float32Array(new ArrayBuffer(node.frequencyBinCount * 4)),
      rawTime: new Float32Array(new ArrayBuffer(node.fftSize * 4))
    };
  }

  /** Reads what `needs` asks for and uploads it: once a frame, before the presets draw. */
  public update(now: number, needs: { eyecandy: ReadonlySet<AudioName>; stereo: boolean }): void {
    const elapsed = this.lastUpdate ? Math.min(0.25, Math.max(0, (now - this.lastUpdate) / 1000)) : 0;
    this.lastUpdate = now;
    const wantsSpectrum = needs.eyecandy.has("eyecandyShadertoy") || needs.eyecandy.has("eyecandyWebAudio");
    if (wantsSpectrum) {
      this.smoothed ??= this.tap(2048, 0.8);
      const tap = this.smoothed;
      tap.node.getFloatFrequencyData(tap.rawFrequency);
      this.smoothedDb.set(tap.rawFrequency.subarray(0, EYECANDY_WIDTH));
      tap.node.getFloatTimeDomainData(tap.rawTime);
      decimate(tap.rawTime, this.factor, this.wave);
    }
    if (needs.eyecandy.has("eyecandyFreqDB")) {
      this.raw ??= this.tap(2048, 0);
      this.raw.node.getFloatFrequencyData(this.raw.rawFrequency);
      this.rawDb.set(this.raw.rawFrequency.subarray(0, EYECANDY_WIDTH));
    }
    this.rowsDue = Math.min(HISTORY_ROWS, this.rowsDue + elapsed * ROWS_PER_SECOND);
    const rows = Math.floor(this.rowsDue);
    this.rowsDue -= rows;
    for (const name of needs.eyecandy) this.uploadEyecandy(name, rows);
    if (needs.stereo) this.readStereo();
  }

  private uploadEyecandy(name: AudioName, rows: number): void {
    const gl = this.gl;
    let texture = this.textures.get(name);
    const height = name === "eyecandyShadertoy" ? 2 : HISTORY_ROWS;
    const fresh = !texture;
    if (!texture) {
      texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, EYECANDY_WIDTH, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(name, texture);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (name === "eyecandyShadertoy") {
      const data = this.shadertoy;
      for (let x = 0; x < EYECANDY_WIDTH; x += 1) {
        // 512 bins over 1024 texels, every other one halfway between its neighbours.
        const half = x >> 1;
        let decibels = this.smoothedDb[half]!;
        if (x & 1) decibels = (decibels + this.smoothedDb[Math.min(EYECANDY_WIDTH - 1, half + 1)]!) / 2;
        data[x * 4 + 1] = eyecandy(Number.isFinite(decibels) ? decibels : -Infinity, WEBAUDIO_PEAK);
        data[(EYECANDY_WIDTH + x) * 4 + 1] = this.wave[1024 + x]! / 2 + 0.5;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, EYECANDY_WIDTH, 2, gl.RGBA, gl.FLOAT, data);
      return;
    }
    if (rows === 0 && !fresh) return;
    const history = name === "eyecandyWebAudio" ? this.webAudioRows : this.decibelRows;
    const decibels = name === "eyecandyWebAudio" ? this.smoothedDb : this.rawDb;
    const peak = name === "eyecandyWebAudio" ? WEBAUDIO_PEAK : DECIBEL_PEAK;
    const width = EYECANDY_WIDTH * 4;
    for (let row = 0; row < rows; row += 1) {
      // Row 0 is the newest; the others move one up.
      history.copyWithin(width, 0, history.length - width);
      for (let x = 0; x < EYECANDY_WIDTH; x += 1) history[x * 4 + 1] = toHalf(eyecandy(decibels[x]!, peak));
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, EYECANDY_WIDTH, HISTORY_ROWS, gl.RGBA, gl.HALF_FLOAT, history);
  }

  public texture(name: AudioName): WebGLTexture | null {
    return this.textures.get(name) ?? null;
  }

  private readStereo(): void {
    if (!this.stereo) {
      const splitter = this.context.createChannelSplitter(2);
      this.source.connect(splitter);
      const make = (channel: number): Tap => {
        const node = this.context.createAnalyser();
        node.fftSize = scaledFftSize(8192, this.factor);
        node.smoothingTimeConstant = 0;
        splitter.connect(node, channel);
        return { node, rawFrequency: new Float32Array(new ArrayBuffer(4)), rawTime: new Float32Array(new ArrayBuffer(node.fftSize * 4)) };
      };
      this.stereo = { splitter, left: make(0), right: make(1) };
    }
    const { left, right } = this.stereo;
    left.node.getFloatTimeDomainData(left.rawTime);
    right.node.getFloatTimeDomainData(right.rawTime);
    decimate(left.rawTime, this.factor, this.left);
    decimate(right.rawTime, this.factor, this.right);
    this.writer = Math.round(this.context.currentTime * this.nominalRate);
  }

  public destroy(): void {
    for (const tap of [this.smoothed, this.raw]) {
      try {
        if (tap) this.source.disconnect(tap.node);
      } catch { /* już odłączony */ }
    }
    if (this.stereo) {
      try {
        this.source.disconnect(this.stereo.splitter);
        this.stereo.splitter.disconnect();
      } catch { /* już odłączony */ }
    }
    this.smoothed = null;
    this.raw = null;
    this.stereo = null;
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture);
    this.textures.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// music_visualizer

/** Values of each channel the shaders see: samples, and spectrum bins. */
const VL = 2048;
/** The newest samples read each frame (at 48 kHz or below). */
const WINDOW = 8192;
/** The spectrum: every other sample of the window, so a 4096-point FFT at half the rate. */
const FFT_LENGTH = 4096;
/** The waveform's peak, as music_visualizer's shaders expect it (they scale and offset from it). */
const WAVE_PEAK = 0.66;

/** Bit-reversed order and twiddles of a 4096-point FFT. */
const plan = (() => {
  const bits = Math.log2(FFT_LENGTH);
  const reverse = new Uint16Array(FFT_LENGTH);
  for (let index = 0; index < FFT_LENGTH; index += 1) {
    let value = 0;
    for (let bit = 0; bit < bits; bit += 1) value |= ((index >> bit) & 1) << (bits - 1 - bit);
    reverse[index] = value;
  }
  const cos = new Float64Array(FFT_LENGTH / 2);
  const sin = new Float64Array(FFT_LENGTH / 2);
  for (let index = 0; index < FFT_LENGTH / 2; index += 1) {
    cos[index] = Math.cos((-2 * Math.PI * index) / FFT_LENGTH);
    sin[index] = Math.sin((-2 * Math.PI * index) / FFT_LENGTH);
  }
  const window = new Float64Array(FFT_LENGTH);
  for (let index = 0; index < FFT_LENGTH; index += 1) window[index] = Math.sin((Math.PI * index) / FFT_LENGTH) ** 2;
  return { reverse, cos, sin, window };
})();

function fft(re: Float64Array, im: Float64Array): void {
  const { reverse, cos, sin } = plan;
  for (let index = 0; index < FFT_LENGTH; index += 1) {
    const other = reverse[index]!;
    if (other > index) {
      [re[index], re[other]] = [re[other]!, re[index]!];
      [im[index], im[other]] = [im[other]!, im[index]!];
    }
  }
  for (let size = 2; size <= FFT_LENGTH; size <<= 1) {
    const half = size >> 1;
    const step = FFT_LENGTH / size;
    for (let start = 0; start < FFT_LENGTH; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

interface Channel {
  /** What the shaders see. */
  wave: Float32Array<ArrayBuffer>;
  freq: Float32Array<ArrayBuffer>;
  magnitude: Float64Array;
  /** The segment shown last, unscaled, for lining the next one up with it. */
  previous: Float32Array;
  hasPrevious: boolean;
  /** The segment's peak, followed slowly, for the gain. */
  peak: number;
}

const channel = (): Channel => ({
  wave: new Float32Array(new ArrayBuffer(VL * 4)),
  freq: new Float32Array(new ArrayBuffer(VL * 4)),
  magnitude: new Float64Array(FFT_LENGTH / 2 + 1),
  previous: new Float32Array(VL),
  hasPrevious: false,
  peak: 0.5
});

/**
 * One music_visualizer preset's view of the music, and its four textures: per channel the
 * waveform (VL samples, scaled to a steady peak, held still by lining each frame up with the
 * last) and the spectrum (a Hann-windowed FFT, |X|/√N, smoothed over time and across bins), each
 * eased frame to frame by the preset's `wave_smooth` and `fft_smooth`.
 */
export class MvAudio {
  private readonly left = channel();
  private readonly right = channel();
  private readonly re = new Float64Array(FFT_LENGTH);
  private readonly im = new Float64Array(FFT_LENGTH);
  private readonly blurred = new Float32Array(VL);
  private readonly textures: WebGLTexture[] = [];
  private lastWriter = -1;

  public constructor(private readonly gl: WebGL2RenderingContext, private readonly options: MvAudioOptions) {
    for (let index = 0; index < 4; index += 1) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, VL, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.textures.push(texture);
    }
  }

  /** iSoundR, iSoundL, iFreqR, iFreqL. */
  public texture(name: string): WebGLTexture | null {
    const index = ["iSoundR", "iSoundL", "iFreqR", "iFreqL"].indexOf(name);
    return index >= 0 ? this.textures[index]! : null;
  }

  public update(audio: ShaderAudio): void {
    // The same samples twice (a frame faster than the audio moves): nothing new to show.
    if (audio.writer === this.lastWriter) return;
    this.lastWriter = audio.writer;
    // Both channels' spectra from one complex FFT: left as the real part, right as the imaginary.
    const { window } = plan;
    for (let index = 0; index < FFT_LENGTH; index += 1) {
      this.re[index] = audio.left[index * 2]! * window[index]!;
      this.im[index] = audio.right[index * 2]! * window[index]!;
    }
    fft(this.re, this.im);
    for (let k = 0; k <= FFT_LENGTH / 2; k += 1) {
      const j = (FFT_LENGTH - k) % FFT_LENGTH;
      const ar = this.re[k]!;
      const ai = this.im[k]!;
      const br = this.re[j]!;
      const bi = this.im[j]!;
      this.left.magnitude[k] = Math.hypot(ar + br, ai - bi) / 2;
      this.right.magnitude[k] = Math.hypot(ai + bi, br - ar) / 2;
    }
    const rate = audio.nominalRate;
    this.channel(this.left, audio.left, rate);
    this.channel(this.right, audio.right, rate);
    const gl = this.gl;
    [this.right.wave, this.left.wave, this.right.freq, this.left.freq].forEach((data, index) => {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[index]!);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, VL, 1, gl.RED, gl.FLOAT, data);
    });
  }

  private channel(side: Channel, samples: Float32Array, rate: number): void {
    const { fftSync, xcorrSync, fftSmooth, waveSmooth } = this.options;
    // Spectrum: without the lowest bins (the constant part), eased over time, blurred across bins.
    const scale = 1 / Math.sqrt(FFT_LENGTH);
    for (let index = 0; index < VL; index += 1) {
      const magnitude = index < 2 ? 0 : side.magnitude[index]! * scale;
      side.freq[index] = side.freq[index]! + (magnitude - side.freq[index]!) * fftSmooth;
    }
    for (let index = 0; index < VL; index += 1) {
      let sum = 0;
      let weight = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const at = index + offset;
        if (at < 0 || at >= VL) continue;
        const w = 3 - Math.abs(offset);
        sum += side.freq[at]! * w;
        weight += w;
      }
      this.blurred[index] = sum / weight;
    }
    side.freq.set(this.blurred);

    // Waveform: the newest VL samples, or — to hold it still — the segment within one period of
    // the strongest low tone that best matches the segment shown last.
    const newest = WINDOW - VL;
    let start = newest;
    if ((fftSync || xcorrSync) && side.hasPrevious) {
      let strongest = 2;
      const highest = Math.min(FFT_LENGTH / 2, Math.round((500 / (rate / 2)) * FFT_LENGTH));
      for (let k = 3; k < highest; k += 1) if (side.magnitude[k]! > side.magnitude[strongest]!) strongest = k;
      const frequency = (strongest * (rate / 2)) / FFT_LENGTH;
      const period = Math.max(32, Math.min(VL / 2, Math.round(rate / Math.max(1, frequency))));
      if (xcorrSync) {
        let best = -Infinity;
        for (let candidate = newest; candidate > newest - period; candidate -= 4) {
          let score = 0;
          for (let index = 0; index < VL; index += 4) score += samples[candidate + index]! * side.previous[index]!;
          if (score > best) {
            best = score;
            start = candidate;
          }
        }
      } else {
        // A rising zero crossing within the last period: the trace starts at the same phase.
        for (let candidate = newest; candidate > newest - period; candidate -= 1) {
          if (samples[candidate - 1]! < 0 && samples[candidate]! >= 0) {
            start = candidate;
            break;
          }
        }
      }
    }
    let loudest = 0;
    for (let index = 0; index < VL; index += 1) loudest = Math.max(loudest, Math.abs(samples[start + index]!));
    side.peak += (Math.max(loudest, 1e-4) - side.peak) * 0.25;
    for (let index = 0; index < VL; index += 1) {
      const sample = samples[start + index]!;
      side.previous[index] = sample;
      const value = (WAVE_PEAK * sample) / (side.peak + 1e-4);
      side.wave[index] = side.wave[index]! + (value - side.wave[index]!) * waveSmooth;
    }
    side.hasPrevious = true;
  }

  public destroy(): void {
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.textures.length = 0;
  }
}
