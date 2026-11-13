import { decimate, rateFactor, scaledFftSize } from "../audio-rate";
import AnalyserAdapter from "./webvs/analyser/AnalyserAdapter";
import { AVS_SAMPLES, avsCenter, avsVisdataFrom, createVisdata, type AvsVisdata } from "./winamp-visdata";

/**
 * The player's audio as Winamp handed it to AVS, for webvs.
 *
 * Every frame: the newest 576 samples of each channel, made into Winamp's vis bytes and
 * AVS 2.81's visdata (winamp-visdata.ts) — the waveform as signed bytes, the spectrum as
 * Winamp's 576 bytes through AVS's log table. Effects read those bytes the way AVS's did
 * (`getVisdata()`); the float views (`getWaveform`, `getSpectrum`) are the same bytes / 128
 * and / 255, the centre channel built as AVS built it.
 *
 * Left and right come from two analysers behind a channel splitter on the player's node,
 * with a gain node before it that makes mono into both channels as Winamp did. Where the
 * node cannot be split (a stand-in without a context), both channels are its mono signal.
 *
 * Beats as Winamp's AVS found them (vis_avs main.cpp): the louder channel's sum of |byte|
 * against a peak that decays, a beat when it is 1/16 above it. AVS also wanted the level
 * above a fixed 1/8 of full scale; that floor here follows the track's own loudness instead,
 * so a quiet song or a lowered volume still beats — presets that only move on beats stood
 * still on them. A beat also keeps the next one away for 100 ms, or one kick counted twice
 * or three times.
 *
 * Winamp's 576 samples were 13 ms of a 44.1 kHz track. A context at 96 or 192 kHz is read
 * as if it ran at 48 kHz (audio-rate.ts): the newest 576 × factor samples averaged down to
 * 576.
 */
export { AVS_SAMPLES };
/** Frames a beat blocks the next one: a kick's attack spans two or three frames at 60 fps. */
const BEAT_GAP = 6;
/** Samples each channel's analyser holds at the visualizers' rate: 576 fit in 1024. */
const TAP_SAMPLES = 1024;

interface StereoTap {
  left: AnalyserNode;
  right: AnalyserNode;
  disconnect(): void;
}

/** Left and right of `node`'s signal, or null where the node cannot be split. */
function stereoTap(node: AnalyserNode, factor: number): StereoTap | null {
  const context = node.context as BaseAudioContext | undefined;
  if (!context || typeof context.createChannelSplitter !== "function" || typeof node.connect !== "function") return null;
  try {
    // Mono up to both channels, as Winamp gave a mono track to both; more channels down to two.
    const mix = context.createGain();
    mix.channelCount = 2;
    mix.channelCountMode = "explicit";
    mix.channelInterpretation = "speakers";
    const splitter = context.createChannelSplitter(2);
    const channel = (): AnalyserNode => {
      const analyser = context.createAnalyser();
      analyser.fftSize = scaledFftSize(TAP_SAMPLES, factor);
      analyser.smoothingTimeConstant = 0;
      return analyser;
    };
    const left = channel();
    const right = channel();
    node.connect(mix);
    mix.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    return {
      left,
      right,
      disconnect(): void {
        try {
          node.disconnect(mix);
        } catch { /* already gone */ }
        mix.disconnect();
        splitter.disconnect();
      }
    };
  } catch {
    return null;
  }
}

export class NodeAnalyser extends AnalyserAdapter {
  // In WebAssembly memory: preset code compiled to wasm reads getosc/getspec there (eel-wasm-backend.ts).
  private readonly visdata: AvsVisdata = createVisdata(true);
  private readonly left = new Float32Array(AVS_SAMPLES);
  private readonly right = new Float32Array(AVS_SAMPLES);
  private raw = new Float32Array(TAP_SAMPLES);
  /** Float views: [centre, left, right] (webvs's Channels), filled when first asked each frame. */
  private readonly waveforms = [new Float32Array(AVS_SAMPLES), new Float32Array(AVS_SAMPLES), new Float32Array(AVS_SAMPLES)];
  private readonly spectra = [new Float32Array(AVS_SAMPLES), new Float32Array(AVS_SAMPLES), new Float32Array(AVS_SAMPLES)];
  private readonly centre = new Uint8Array(AVS_SAMPLES);
  private fresh = 0;
  private beat = false;
  private peak = 0;
  private peakPeak = 0;
  private recent = 0;
  private loudness = 0;
  private sinceBeat = BEAT_GAP;
  private readonly factor: number;
  private readonly tap: StereoTap | null;

  public constructor(private readonly node: AnalyserNode) {
    super();
    this.factor = rateFactor(node.context.sampleRate);
    this.tap = stereoTap(node, this.factor);
  }

  private read(source: AnalyserNode, out: Float32Array): void {
    if (this.raw.length !== source.fftSize) this.raw = new Float32Array(source.fftSize);
    source.getFloatTimeDomainData(this.raw);
    decimate(this.raw, this.factor, out);
  }

  public update(): void {
    if (this.tap) {
      this.read(this.tap.left, this.left);
      this.read(this.tap.right, this.right);
    } else {
      this.read(this.node, this.left);
      this.right.set(this.left);
    }
    avsVisdataFrom(this.left, this.right, this.visdata);
    this.fresh = 0;

    // main.cpp: lt[ch] = sum of |(byte ^ 128) - 128|, the louder channel counts.
    let louder = 0;
    for (const wave of this.visdata.waveform) {
      let sum = 0;
      for (let index = 0; index < AVS_SAMPLES; index += 1) sum += Math.abs(wave[index]!);
      if (sum > louder) louder = sum;
    }
    const level = louder / (AVS_SAMPLES * 128);
    this.loudness = this.loudness > 0 ? this.loudness * 0.995 + level * 0.005 : level;
    const floor = Math.max(0.003, Math.min(0.125, this.loudness * 0.6));
    this.peak = (this.peak * 125 + this.recent * 3) / 128;
    this.beat = false;
    this.sinceBeat += 1;
    if (level >= (this.peak * 34) / 32 && level > floor) {
      this.beat = this.sinceBeat >= BEAT_GAP;
      if (this.beat) this.sinceBeat = 0;
      this.peak = (level + this.peakPeak) / 2;
      this.peakPeak = level;
    } else if (level > this.recent) {
      this.recent = level;
    } else {
      this.recent = (this.recent * 14) / 16;
    }
  }

  /**
   * A beat decided inside an effect list (its code's `beat`, or a Custom BPM before
   * the effect asking), for the rest of that list; null: the music's own.
   */
  public beatOverride: boolean | null = null;

  public isBeat(): boolean {
    return this.beatOverride ?? this.beat;
  }

  /** This frame's visdata: AVS's bytes, read by the ported effects and by getosc/getspec. */
  public getVisdata(): AvsVisdata {
    return this.visdata;
  }

  /** The waveform, bytes / 128: webvs's channel 0 is the centre, 1 left, 2 right. */
  public getWaveform(channel = 0): Float32Array {
    const which = channel === 1 || channel === 2 ? channel : 0;
    const out = this.waveforms[which]!;
    if (!(this.fresh & (1 << which))) {
      this.fresh |= 1 << which;
      const [left, right] = this.visdata.waveform;
      const bytes = which === 0 ? avsCenter(left, right, this.centre) : which === 1 ? left : right;
      for (let index = 0; index < AVS_SAMPLES; index += 1) out[index] = ((bytes[index]! << 24) >> 24) / 128;
    }
    return out;
  }

  /** The spectrum, bytes / 255 (the centre as AVS's effects made it from signed chars). */
  public getSpectrum(channel = 0): Float32Array {
    const which = channel === 1 || channel === 2 ? channel : 0;
    const out = this.spectra[which]!;
    if (!(this.fresh & (8 << which))) {
      this.fresh |= 8 << which;
      const [left, right] = this.visdata.spectrum;
      const bytes = which === 0 ? avsCenter(left, right, this.centre) : which === 1 ? left : right;
      for (let index = 0; index < AVS_SAMPLES; index += 1) out[index] = bytes[index]! / 255;
    }
    return out;
  }

  /** Lets go of the channel taps on the player's node. */
  public disconnect(): void {
    this.tap?.disconnect();
  }
}
