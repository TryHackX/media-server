// @ts-nocheck — vendored from voltviz 0.35.1 (MIT, see LICENSE-voltviz.txt); kept close to upstream.
// Fork: a context faster than 48 kHz is read as if it ran at 44.1/48 kHz (see ./rate).
import type { FftSize } from '../types';
import { rateFactor } from './rate';

interface Entry {
  node: AnalyserNode;
  /** Fork: node.fftSize over the requested size (the rate factor; 1 at 44.1/48 kHz). */
  k: number;
  freq: Uint8Array<ArrayBuffer>;
  time: Uint8Array<ArrayBuffer>;
  timeF: Float32Array<ArrayBuffer>;
  /** Fork: what is handed out, the audible bins and every k-th sample (the arrays above when k is 1). */
  freqOut: Uint8Array;
  timeOut: Uint8Array;
  timeFOut: Float32Array;
  freqFrame: number;
  timeFrame: number;
  timeFFrame: number;
  lastUsed: number;
}

/**
 * Shared display analysers keyed by (fftSize, smoothing), created lazily on first use. Every
 * visualizer keeps reading exactly the data it was tuned on (same FFT size and smoothing),
 * but all layers share one audio graph and each analyser is read at most once per frame.
 */
export class AnalyserPool {
  private readonly ctx: AudioContext;
  private readonly input: AudioNode;
  private readonly entries = new Map<string, Entry>();
  private frame = 0;
  private splitter: ChannelSplitterNode | null = null;
  private stereoNodes: [AnalyserNode, AnalyserNode] | null = null;
  private stereoBufs: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] | null = null;
  private stereoFrame = -1;
  private mono = true;
  /** Fork: see ./rate. */
  readonly factor: number;
  private stereoOut: [Float32Array, Float32Array] | null = null;

  constructor(ctx: AudioContext, input: AudioNode) {
    this.ctx = ctx;
    this.input = input;
    this.factor = rateFactor(ctx.sampleRate);
  }

  /** Advance the frame counter (data is re-read at most once per frame). */
  nextFrame(): void {
    this.frame++;
    // drop analysers nobody used for ~10 s (e.g. after switching visualizers)
    if (this.frame % 600 === 0) {
      for (const [k, e] of this.entries) {
        if (this.frame - e.lastUsed > 600) {
          e.node.disconnect();
          this.entries.delete(k);
        }
      }
    }
  }

  private get(fftSize: FftSize = 2048, smoothing = 0.8): Entry {
    const key = `${fftSize}:${smoothing}`;
    let e = this.entries.get(key);
    if (!e) {
      const node = this.ctx.createAnalyser();
      node.fftSize = Math.min(32768, fftSize * this.factor);
      node.smoothingTimeConstant = smoothing;
      this.input.connect(node);
      const k = node.fftSize / fftSize;
      const freq = new Uint8Array(node.frequencyBinCount);
      const time = new Uint8Array(node.fftSize);
      const timeF = new Float32Array(node.fftSize);
      e = {
        node, k, freq, time, timeF,
        freqOut: k > 1 ? freq.subarray(0, fftSize / 2) : freq,
        timeOut: k > 1 ? new Uint8Array(fftSize) : time,
        timeFOut: k > 1 ? new Float32Array(fftSize) : timeF,
        freqFrame: -1, timeFrame: -1, timeFFrame: -1, lastUsed: this.frame,
      };
      this.entries.set(key, e);
    }
    e.lastUsed = this.frame;
    return e;
  }

  spectrum(fftSize?: FftSize, smoothing?: number): Uint8Array {
    const e = this.get(fftSize, smoothing);
    if (e.freqFrame !== this.frame) {
      e.node.getByteFrequencyData(e.freq);
      e.freqFrame = this.frame;
    }
    return e.freqOut;
  }

  waveform(fftSize?: FftSize, smoothing?: number): Uint8Array {
    const e = this.get(fftSize, smoothing);
    if (e.timeFrame !== this.frame) {
      e.node.getByteTimeDomainData(e.time);
      if (e.k > 1) decimate(e.time, e.timeOut, e.k);
      e.timeFrame = this.frame;
    }
    return e.timeOut;
  }

  waveformFloat(fftSize?: FftSize, smoothing?: number): Float32Array {
    const e = this.get(fftSize, smoothing);
    if (e.timeFFrame !== this.frame) {
      e.node.getFloatTimeDomainData(e.timeF);
      if (e.k > 1) decimate(e.timeF, e.timeFOut, e.k);
      e.timeFFrame = this.frame;
    }
    return e.timeFOut;
  }

  /** Per-channel float time-domain data (2048 samples, no smoothing), created lazily. */
  stereo(): { left: Float32Array; right: Float32Array } {
    if (!this.stereoNodes) {
      this.splitter = this.ctx.createChannelSplitter(2);
      this.input.connect(this.splitter);
      const l = this.ctx.createAnalyser();
      const r = this.ctx.createAnalyser();
      for (const n of [l, r]) {
        n.fftSize = 2048 * this.factor;
        n.smoothingTimeConstant = 0;
      }
      this.splitter.connect(l, 0);
      this.splitter.connect(r, 1);
      this.stereoNodes = [l, r];
      this.stereoBufs = [new Float32Array(2048 * this.factor), new Float32Array(2048 * this.factor)];
      this.stereoOut = this.factor > 1 ? [new Float32Array(2048), new Float32Array(2048)] : this.stereoBufs;
    }
    const [l, r] = this.stereoNodes;
    const [fl, fr] = this.stereoBufs!;
    const [bl, br] = this.stereoOut!;
    if (this.stereoFrame !== this.frame) {
      l.getFloatTimeDomainData(fl);
      r.getFloatTimeDomainData(fr);
      if (this.factor > 1) {
        decimate(fl, bl, this.factor);
        decimate(fr, br, this.factor);
      }
      this.stereoFrame = this.frame;
      // mono sources leave the right channel silent: mirror the left channel
      let energy = 0;
      for (let i = 0; i < br.length; i += 16) energy += br[i] * br[i];
      this.mono = energy === 0;
    }
    return { left: bl, right: this.mono ? bl : br };
  }

  dispose(): void {
    for (const e of this.entries.values()) e.node.disconnect();
    this.entries.clear();
    this.splitter?.disconnect();
    this.stereoNodes?.forEach(n => n.disconnect());
  }
}

/** Fork: every k-th sample of `from` into `to` (the same stretch of time at 1/k the rate). */
function decimate<T extends Uint8Array | Float32Array>(from: T, to: T, k: number): void {
  for (let i = 0; i < to.length; i++) to[i] = from[i * k];
}
