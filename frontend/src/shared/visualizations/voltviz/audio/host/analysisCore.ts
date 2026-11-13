// @ts-nocheck — vendored from voltviz 0.35.1 (MIT, see LICENSE-voltviz.txt); kept close to upstream.
/**
 * Host-independent glue around the Analyzer: downmixes input channels, runs the analysis and
 * batches messages. Shared by the AudioWorklet and the ScriptProcessor fallback.
 */
import { Analyzer, type AnalyzerEvent } from '../core/Analyzer';
import type { StyleId } from '../core/styles';
import { HOPS_PER_MESSAGE, type EngineToHost, type HostToEngine } from './protocol';
import { rateFactor } from './rate';

export class AnalysisCore {
  readonly analyzer: Analyzer;
  private readonly post: (m: HostToEngine, transfer?: Transferable[]) => void;
  private mono = new Float32Array(128);
  private events: AnalyzerEvent[] = [];
  private phase: number[] = [];
  private kick: number[] = [];
  private threshold: number[] = [];
  private lastTime = 0;
  private hopsSincePost = 0;
  private ctxOffset = NaN;
  private readonly sampleRate: number;
  private samples = 0;
  /** Fork: above 48 kHz the analysis hears the mean of every `step` samples (see ./rate). */
  private readonly step: number;
  private carry = 0;
  private carried = 0;

  constructor(sampleRate: number, post: (m: HostToEngine, transfer?: Transferable[]) => void, neural: boolean, style?: StyleId) {
    // Fork: no log-mel front end or neural arbiter (the beat model is not part of this build);
    // with AI beat tracking off, upstream's DSP takes exactly the same decisions either way.
    this.step = rateFactor(sampleRate);
    this.analyzer = new Analyzer(sampleRate / this.step, { neural: false, style });
    this.analyzer.setNeuralActive(neural);
    this.post = post;
    this.sampleRate = sampleRate;
  }

  onMessage(m: EngineToHost): void {
    if (m.type === 'neuralResult') this.analyzer.applyNeural(m.t0, m.activation, m.validFrom, m.downbeat);
    else if (m.type === 'neuralActive') this.analyzer.setNeuralActive(m.active);
    else if (m.type === 'style') this.analyzer.setStyle(m.style);
    else if (m.type === 'songChange') this.analyzer.songChanged();
  }

  /** Process one block. `channels` are the input channel arrays; `contextTime` the block start. */
  process(channels: Float32Array[], length: number, contextTime: number): void {
    if (!channels.length || length === 0) return;
    if (this.mono.length < length) this.mono = new Float32Array(length);
    const m = this.mono;
    if (channels.length === 1) m.set(channels[0].subarray(0, length));
    else {
      // mean of all channels (the beat model was trained on the channel mean)
      const inv = 1 / channels.length;
      for (let i = 0; i < length; i++) {
        let s = 0;
        for (const ch of channels) s += ch[i];
        m[i] = s * inv;
      }
    }
    const a = this.analyzer;
    // Stream time -> context time, re-anchored every block: the worklet's currentTime can lag
    // the context by the module load time (~350 ms in Chrome) on the first blocks, and a frozen
    // offset would then stamp every event that much too early.
    this.ctxOffset = contextTime - this.samples / this.sampleRate;
    this.samples += length;
    const before = a.state.time;
    a.process(m, this.step > 1 ? this.decimate(m, length) : length);
    for (const e of a.drainEvents()) this.events.push(e);
    if (a.state.time !== before) {
      // one or more hops completed in this block; record the newest values
      this.phase.push(a.state.odfSnare);
      this.kick.push(a.state.odfKick);
      this.threshold.push(a.state.kickThreshold);
      this.hopsSincePost++;
    }
    const req = a.takeNeuralRequest();
    if (req) this.post({ type: 'neuralRequest', t0: req.t0, validFrom: req.validFrom, frames: req.frames }, [req.frames.buffer]);
    if (this.hopsSincePost >= HOPS_PER_MESSAGE || this.events.length > 0) this.flush();
    this.lastTime = a.state.time;
  }

  /** Fork: `m` decimated in place (the mean of every `step` samples); returns how many there are. */
  private decimate(m: Float32Array, length: number): number {
    const k = this.step;
    let out = 0;
    for (let i = 0; i < length; i++) {
      this.carry += m[i];
      if (++this.carried === k) {
        m[out++] = this.carry / k;
        this.carry = 0;
        this.carried = 0;
      }
    }
    return out;
  }

  private flush(): void {
    const phase = Float32Array.from(this.phase);
    const kick = Float32Array.from(this.kick);
    const threshold = Float32Array.from(this.threshold);
    this.post(
      { type: 'analysis', ctxOffset: this.ctxOffset, state: this.analyzer.state, events: this.events, phase, kick, threshold },
      [phase.buffer, kick.buffer, threshold.buffer],
    );
    this.events = [];
    this.phase.length = 0;
    this.kick.length = 0;
    this.threshold.length = 0;
    this.hopsSincePost = 0;
  }
}
