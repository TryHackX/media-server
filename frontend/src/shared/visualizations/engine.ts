import type { VisualizerPlugin } from "./types";

const STORAGE_KEY = "media-visualizer-mode";

export class VisualizerEngine {
  private frame = 0;
  private running = false;
  private previousTime = performance.now();
  private frequency = new Uint8Array(new ArrayBuffer(1));
  private waveform = new Uint8Array(new ArrayBuffer(1));
  private pluginIndex = 0;
  private readonly context: CanvasRenderingContext2D | null;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly analyser: AnalyserNode,
    private readonly plugins: VisualizerPlugin[]
  ) {
    // An alpha channel is what lets a visualiser fade old frames with
    // "destination-out" instead of painting translucent black over them. Blending
    // towards black never quite arrives in eight bits, so it leaves a coloured
    // haze; removing alpha instead reaches full transparency and the panel
    // background shows through cleanly. Every plugin paints an opaque backdrop,
    // so nothing else changes.
    this.context = canvas.getContext("2d", { alpha: true });
    const stored = localStorage.getItem(STORAGE_KEY);
    const index = plugins.findIndex((plugin) => plugin.id === stored);
    if (index >= 0) this.pluginIndex = index;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelFrame();
      else if (this.running) this.schedule();
    });
    this.configurePlugin();
  }

  public current(): VisualizerPlugin | undefined { return this.plugins[this.pluginIndex]; }

  public select(id: string): void {
    const index = this.plugins.findIndex((plugin) => plugin.id === id);
    if (index < 0 || index === this.pluginIndex) return;
    this.current()?.reset?.();
    this.pluginIndex = index;
    localStorage.setItem(STORAGE_KEY, id);
    this.configurePlugin();
  }

  public next(direction: 1 | -1): VisualizerPlugin | undefined {
    if (!this.plugins.length) return undefined;
    const index = (this.pluginIndex + direction + this.plugins.length) % this.plugins.length;
    this.select(this.plugins[index]!.id);
    return this.current();
  }

  public start(): void {
    this.running = true;
    this.previousTime = performance.now();
    this.schedule();
  }

  public stop(): void {
    this.running = false;
    this.cancelFrame();
  }

  public resize(reset = false): void {
    if (reset) this.current()?.reset?.();
    this.paint(performance.now());
  }

  private configurePlugin(): void {
    const plugin = this.current();
    if (!plugin) return;
    this.analyser.fftSize = plugin.fftSize ?? 2048;
    this.analyser.smoothingTimeConstant = plugin.smoothing ?? 0.85;
    this.frequency = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.waveform = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
  }

  private schedule(): void {
    if (!this.running || document.hidden || this.frame) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = 0;
      this.paint(time);
      this.schedule();
    });
  }

  private cancelFrame(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private paint(time: number): void {
    const plugin = this.current();
    const context = this.context;
    if (!plugin || !context) return;
    // Measure the container, not the canvas. A canvas contributes its pixel
    // buffer as intrinsic size, so sizing the buffer from the canvas's own box
    // lets a layout feed its previous frame back in and stay stretched after the
    // panel shrinks. The canvas fills its parent, so the parent's content box is
    // the same rectangle without that loop.
    const host = this.canvas.parentElement;
    const bounds = this.canvas.getBoundingClientRect();
    const measuredWidth = host?.clientWidth || bounds.width;
    const measuredHeight = host?.clientHeight || bounds.height;
    const width = Math.max(1, Math.floor(measuredWidth));
    const height = Math.max(1, Math.floor(measuredHeight));
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.floor(width * scale);
    const pixelHeight = Math.floor(height * scale);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    this.analyser.getByteFrequencyData(this.frequency);
    this.analyser.getByteTimeDomainData(this.waveform);
    plugin.render({ canvas: this.canvas, context, analyser: this.analyser, frequency: this.frequency,
      waveform: this.waveform, width, height, time, delta: Math.min(80, Math.max(0, time - this.previousTime)) });
    this.previousTime = time;
  }
}
