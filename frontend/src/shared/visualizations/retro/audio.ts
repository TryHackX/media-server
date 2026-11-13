import { decimate, rateFactor, scaledFftSize } from "../audio-rate";
import { RetroAnalysis, WINDOW } from "./analysis";

/**
 * What "Klasyka retro" hears: the player's signal split into left and right (Cthugha drew each
 * channel apart, the Atari Video Music gave each one a diamond, a tracker a scope per channel),
 * on analysers of its own behind the player's, so the panel's settings for other visualizers do
 * not change it. A context faster than 48 kHz is read down to 44.1/48 kHz (audio-rate.ts).
 *
 * The analysers hold the newest WINDOW samples; how many of them are new since the last frame
 * follows from the context's clock, so a scene that runs a circuit over the music, sample by
 * sample, sees each sample about once.
 */
export class RetroAudioFeed {
  readonly analysis = new RetroAnalysis();
  private readonly factor: number;
  private readonly splitter: ChannelSplitterNode;
  private readonly leftNode: AnalyserNode;
  private readonly rightNode: AnalyserNode;
  private readonly rawLeft: Float32Array<ArrayBuffer>;
  private readonly rawRight: Float32Array<ArrayBuffer>;
  /** The context's clock at the last read, in samples at the nominal rate; −1 before. */
  private clock = -1;
  private connected = true;

  constructor(private readonly source: AnalyserNode) {
    const context = source.context;
    this.factor = rateFactor(context.sampleRate);
    this.splitter = context.createChannelSplitter(2);
    const make = (): AnalyserNode => {
      const node = context.createAnalyser();
      node.fftSize = scaledFftSize(WINDOW, this.factor);
      node.smoothingTimeConstant = 0;
      return node;
    };
    this.leftNode = make();
    this.rightNode = make();
    source.connect(this.splitter);
    this.splitter.connect(this.leftNode, 0);
    this.splitter.connect(this.rightNode, 1);
    this.rawLeft = new Float32Array(new ArrayBuffer(this.leftNode.fftSize * 4));
    this.rawRight = new Float32Array(new ArrayBuffer(this.rightNode.fftSize * 4));
  }

  /** The nominal rate the scenes see. */
  get rate(): number {
    return this.source.context.sampleRate / this.factor;
  }

  /** Read both channels and move the analysis on; `dt` in seconds. */
  update(dt: number): RetroAnalysis {
    if (!this.connected) return this.analysis;
    this.leftNode.getFloatTimeDomainData(this.rawLeft);
    this.rightNode.getFloatTimeDomainData(this.rawRight);
    decimate(this.rawLeft, this.factor, this.analysis.left);
    decimate(this.rawRight, this.factor, this.analysis.right);
    const now = Math.round(this.source.context.currentTime * this.rate);
    const fresh = this.clock < 0 ? Math.round(this.rate / 60) : now - this.clock;
    this.clock = now;
    this.analysis.update(fresh, this.rate, dt);
    return this.analysis;
  }

  dispose(): void {
    if (!this.connected) return;
    this.connected = false;
    try {
      this.source.disconnect(this.splitter);
    } catch { /* już odłączony */ }
    this.splitter.disconnect();
  }
}
