/**
 * The mscopes analysis (analysis.ts) for one AVS analyser: the samples come from the
 * player's AnalyserNode — each frame the ones that arrived since the previous frame
 * (the audio clock says how many) are handed on, read down to 44.1/48 kHz on faster
 * contexts as every visualizer here is (audio-rate.ts).
 *
 * It runs only for presets that use it: the first mscopes effect or script variable
 * hooks the analyser's per-frame update, and a frame is analysed once, when first asked.
 */
import { rateFactor } from "../../../audio-rate";
import { MscopesAnalyzer, MscopesAudioFrame, RECENT_MAX } from "./analysis";

export { bandAt, bandEdgeHz, BANDS, SPECTRUM_BINS, WAVEFORM_SAMPLES } from "./analysis";
export type { MscopesAudioFrame } from "./analysis";

const clamp = (value: number, low: number, high: number): number => (value < low ? low : value > high ? high : value);

/** What an analyser offers: the player's (avs/analyser.ts) has the node, any other its waveform. */
interface AnalyserLike {
  update(): void;
  node?: AnalyserNode;
  getWaveform?(): ArrayLike<number>;
}

/**
 * The analysis for one AVS analyser: once per frame, on first use. The analyser's
 * update (the first thing every frame) is wrapped to count frames and to run what
 * wants the start of a frame (the previous-frame snapshots, mscopes/host.ts).
 */
export class MscopesAudio {
  private readonly analyzer = new MscopesAnalyzer();
  private frameCount = 0;
  private computedFrame = -1;
  private raw = new Float32Array(0);
  private fresh = new Float32Array(RECENT_MAX * 4);
  private factor = 1;
  private carry = 0;
  private lastAudioTime = -1;
  private lastFrameTime = -1;
  private frameDt = 1 / 60;
  private readonly startListeners = new Set<() => void>();
  /** The frame's time in ms (the engine's frame clock); performance.now() by default. */
  public timeSource: () => number = () => performance.now();

  public constructor(private readonly analyser: AnalyserLike) {
    const update = analyser.update.bind(analyser);
    analyser.update = () => {
      update();
      this.frameCount += 1;
      const now = this.timeSource();
      this.frameDt = this.lastFrameTime >= 0 ? Math.max(0, (now - this.lastFrameTime) / 1000) : 1 / 60;
      this.lastFrameTime = now;
      for (const listener of this.startListeners) listener();
    };
    const node = analyser.node;
    const rate = node?.context?.sampleRate ?? 44100;
    this.factor = node ? rateFactor(rate) : 1;
    this.analyzer.setSampleRate(rate / this.factor);
  }

  /** Seconds since the previous frame (unclamped). */
  public get dt(): number {
    return this.frameDt;
  }

  public onFrameStart(listener: () => void): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }

  /** This frame's analysis. */
  public frame(): MscopesAudioFrame {
    if (this.computedFrame === this.frameCount) return this.analyzer.frame;
    this.computedFrame = this.frameCount;
    const dt = this.frameDt;
    const node = this.analyser.node;
    let count = 0;
    if (node && typeof node.getFloatTimeDomainData === "function") {
      if (this.raw.length !== node.fftSize) this.raw = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(this.raw);
      const rate = node.context?.sampleRate ?? 48000;
      const audioTime = node.context?.currentTime;
      let arrived: number;
      if (typeof audioTime === "number" && this.lastAudioTime >= 0 && audioTime >= this.lastAudioTime) {
        arrived = Math.round((audioTime - this.lastAudioTime) * rate);
      } else {
        arrived = Math.round(dt * rate);
      }
      if (typeof audioTime === "number") this.lastAudioTime = audioTime;
      // Samples read down to the visualizers' rate; the newest few wait for the next frame.
      const total = Math.min(this.raw.length, arrived + this.carry);
      count = Math.min(this.fresh.length, Math.floor(total / this.factor));
      this.carry = total - count * this.factor;
      const end = this.raw.length - this.carry;
      for (let i = 0; i < count; i += 1) {
        let sum = 0;
        const from = end - (count - i) * this.factor;
        for (let step = 0; step < this.factor; step += 1) sum += this.raw[from + step] ?? 0;
        this.fresh[i] = clamp(sum / this.factor, -1, 1);
      }
    } else if (this.analyser.getWaveform) {
      // An analyser without a node: its own waveform, the newest of it as the new samples.
      const wave = this.analyser.getWaveform();
      count = Math.min(wave.length, Math.round(dt * 44100));
      for (let i = 0; i < count; i += 1) this.fresh[i] = wave[wave.length - count + i] ?? 0;
    }
    return this.analyzer.analyze(this.fresh, count, dt);
  }
}

const states = new WeakMap<object, MscopesAudio>();

/** The analysis for an AVS analyser, created (and its update hooked) on first use. */
export function mscopesAudio(analyser: object): MscopesAudio {
  let state = states.get(analyser);
  if (!state) {
    state = new MscopesAudio(analyser as AnalyserLike);
    states.set(analyser, state);
  }
  return state;
}
