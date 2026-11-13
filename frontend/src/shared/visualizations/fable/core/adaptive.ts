/**
 * Adaptive internal resolution: the share of the picture's size a visualization works at,
 * lowered when frames run long and raised again, carefully, when there is room.
 *
 * It goes by the GPU time of a frame where the browser gives it (EXT_disjoint_timer_query_webgl2):
 * that says what the picture costs whatever the display's refresh rate is. Elsewhere it goes by
 * the time between frames. A step up that turns out too dear is taken back and not tried again
 * for a while, longer each time.
 */
export class AdaptiveScale {
  public scale: number;
  private readonly budget: number;
  private readonly minimum: number;
  private frameMs: number;
  private gpuMs = 0;
  private sinceChange = 0;
  private probeAfter = 2.5;
  private lastGood: number;

  /** `budgetMs`: 16.7 for 60 fps, 33.3 for 30 fps (phones). */
  public constructor(budgetMs = 1000 / 60, minimum = 0.35, initial = 1) {
    this.budget = budgetMs;
    this.minimum = minimum;
    this.frameMs = budgetMs;
    this.scale = initial;
    this.lastGood = initial;
  }

  /** Once a frame: the time since the last one (ms), and the frame's GPU time when it is known. */
  public update(deltaMs: number, gpuMs: number | null = null): number {
    const delta = Math.min(250, Math.max(1, deltaMs));
    this.frameMs += (delta - this.frameMs) * 0.08;
    if (gpuMs !== null) this.gpuMs = this.gpuMs ? this.gpuMs + (gpuMs - this.gpuMs) * 0.15 : gpuMs;
    this.sinceChange += delta / 1000;
    const timed = this.gpuMs > 0;
    // How far over (or under) the budget a frame is: by the GPU's own time, else by the clock.
    const load = timed ? this.gpuMs / (this.budget * 0.8) : this.frameMs / (this.budget * 1.22);
    if (load > 1 && this.sinceChange > 0.6 && this.scale > this.minimum) {
      // A step up that did not hold: wait longer before the next try.
      if (this.scale > this.lastGood) this.probeAfter = Math.min(60, this.probeAfter * 2);
      this.scale = Math.max(this.minimum, this.scale * Math.max(0.7, Math.min(0.92, 1 / Math.sqrt(load))));
      this.lastGood = this.scale;
      this.sinceChange = 0;
      // The measurements were of the old size.
      this.frameMs = this.budget;
      this.gpuMs = 0;
    } else if (load <= 1 && this.scale < 1 && this.sinceChange > this.probeAfter) {
      const room = timed ? this.gpuMs < this.budget * 0.5 : this.frameMs < this.budget * 1.06;
      if (room) {
        this.lastGood = this.scale;
        this.scale = Math.min(1, this.scale * 1.1);
        this.sinceChange = 0;
        this.gpuMs = 0;
      }
    }
    return this.scale;
  }
}
