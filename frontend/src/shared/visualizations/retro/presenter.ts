import type { PixelImage, RetroScene } from "./types";

/**
 * A scene's low-resolution picture on a canvas the size of the panel × devicePixelRatio, with
 * pixels that stay sharp and even at any scale.
 *
 * Scaling 320 × 200 by 5.625 with nearest-neighbour alone gives columns of five and six device
 * pixels side by side, and a pixel font wobbles. So the picture is first enlarged by whole
 * numbers with nearest-neighbour, to just above the size it is shown at, and that is brought down
 * the rest of the way with bilinear filtering: every source pixel comes out the same size, soft by
 * a fraction of a device pixel at its edges only (what emulators call "sharp bilinear").
 *
 * A scene of the TV age (`crt: "tv"`) is drawn the way a set drew it: soft along the line, its
 * lines apart, with a dark gap between them.
 */

const MAX_SCALE = 2;

export class PixelPresenter {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly source: HTMLCanvasElement;
  private readonly sourceContext: CanvasRenderingContext2D;
  private readonly scaled: HTMLCanvasElement;
  private readonly scaledContext: CanvasRenderingContext2D;
  private readonly lines: HTMLCanvasElement;
  private image: ImageData | null = null;
  private pixels: PixelImage | null = null;
  private linesKey = "";

  constructor(className: string) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = className;
    const context = this.canvas.getContext("2d", { alpha: false });
    this.source = document.createElement("canvas");
    this.scaled = document.createElement("canvas");
    this.lines = document.createElement("canvas");
    const sourceContext = this.source.getContext("2d");
    const scaledContext = this.scaled.getContext("2d");
    if (!context || !sourceContext || !scaledContext) throw new Error("Canvas 2D is not available");
    this.context = context;
    this.sourceContext = sourceContext;
    this.scaledContext = scaledContext;
  }

  /** The panel's size in CSS pixels; the canvas becomes that × devicePixelRatio (2 at most). */
  resize(width: number, height: number): void {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
  }

  /** The picture a scene draws into, `width × height`, made again when that changes. */
  frame(width: number, height: number): PixelImage {
    if (!this.image || this.image.width !== width || this.image.height !== height) {
      this.image = new ImageData(Math.max(1, width), Math.max(1, height));
      this.pixels = { width: this.image.width, height: this.image.height, data: this.image.data };
      this.source.width = this.image.width;
      this.source.height = this.image.height;
    }
    return this.pixels!;
  }

  /** The picture drawn last onto the canvas, scaled as the scene asks. */
  present(scene: RetroScene): void {
    // A scene drawn with WebGL hands over its canvas; the others, the image they filled.
    const surface = scene.surface?.() ?? null;
    const image = surface ? { width: scene.width, height: scene.height } : this.image;
    if (!image) return;
    if (!surface && this.image) this.sourceContext.putImageData(this.image, 0, 0);
    const base: CanvasImageSource = surface ?? this.source;
    const target = this.canvas;
    const context = this.context;
    let width = target.width;
    let height = target.height;
    if (scene.aspect > 0) {
      if (width / height > scene.aspect) width = Math.round(height * scene.aspect);
      else height = Math.round(width / scene.aspect);
    }
    const left = Math.floor((target.width - width) / 2);
    const top = Math.floor((target.height - height) / 2);
    context.fillStyle = "#000";
    if (width < target.width || height < target.height) context.fillRect(0, 0, target.width, target.height);

    const tv = scene.crt === "tv";
    // Whole-number enlargements to just above the size shown; a TV set is soft along its lines.
    const across = tv ? Math.max(1, Math.ceil(width / image.width / 3)) : Math.max(1, Math.ceil(width / image.width));
    const down = Math.max(1, Math.ceil(height / image.height));
    let picture: CanvasImageSource = base;
    if (across > 1 || down > 1) {
      const scaledWidth = image.width * across;
      const scaledHeight = image.height * down;
      if (this.scaled.width !== scaledWidth || this.scaled.height !== scaledHeight) {
        this.scaled.width = scaledWidth;
        this.scaled.height = scaledHeight;
      }
      this.scaledContext.imageSmoothingEnabled = false;
      this.scaledContext.drawImage(base, 0, 0, scaledWidth, scaledHeight);
      picture = this.scaled;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "low";
    context.drawImage(picture, left, top, width, height);
    if (tv) this.scanlines(left, top, width, height, image.height);
  }

  /** Dark gaps between the TV lines: a strip, one device pixel wide, stretched across. */
  private scanlines(left: number, top: number, width: number, height: number, rows: number): void {
    const perRow = height / rows;
    if (perRow < 2.2) return;
    const key = `${height}x${rows}`;
    if (key !== this.linesKey) {
      this.linesKey = key;
      this.lines.width = 1;
      this.lines.height = height;
      const context = this.lines.getContext("2d");
      if (!context) return;
      const strip = context.createImageData(1, height);
      for (let y = 0; y < height; y += 1) {
        // Where this device row lies within its TV line: dark at the edges, clear in the middle.
        const within = ((y + 0.5) / perRow) % 1;
        const edge = Math.abs(within - 0.5) * 2;
        strip.data[y * 4 + 3] = Math.round(Math.max(0, edge - 0.35) / 0.65 * 150);
      }
      context.putImageData(strip, 0, 0);
    }
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(this.lines, left, top, width, height);
  }

  dispose(): void {
    this.image = null;
    this.pixels = null;
    // Zero-sized canvases give their memory back now rather than when collected.
    for (const canvas of [this.source, this.scaled, this.lines]) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.canvas.remove();
  }
}
