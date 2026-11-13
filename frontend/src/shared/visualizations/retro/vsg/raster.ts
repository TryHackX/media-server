/**
 * The screen of VSG+ (DOS): 640 × 480 colour numbers 0–15, as VGA mode 12h held them, and
 * QuickBASIC's primitives on it — PSET, LINE with its B and BF boxes, and CIRCLE — drawn the
 * integer way: Bresenham's line, the midpoint circle and the midpoint ellipse, one pixel wide.
 * No imports, so the tests run it as it is (vsg.test.ts).
 *
 * Coordinates may be fractional (they are rounded) and may lie off the screen: what falls
 * outside is not drawn.
 */

/** Beyond this many pixels off the screen a line is clipped before it is stepped. */
const GUARD = 2048;

export class Raster {
  readonly width: number;
  readonly height: number;
  /** One colour number per pixel, rows top to bottom. */
  readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height);
  }

  /** CLS: every pixel `color` (0, black, by default). */
  clear(color = 0): void {
    this.pixels.fill(color);
  }

  /** PSET (x, y), color. */
  pset(x: number, y: number, color: number): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    this.pixels[py * this.width + px] = color;
  }

  /**
   * LINE (x0, y0)-(x1, y1), color: Bresenham's line, both ends included. The pixels are the same
   * whichever end is given first.
   */
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    let bx = Math.round(x1);
    let by = Math.round(y1);
    if (bx < ax || (bx === ax && by < ay)) {
      const tx = ax;
      ax = bx;
      bx = tx;
      const ty = ay;
      ay = by;
      by = ty;
    }
    const width = this.width;
    const height = this.height;
    if ((ax < 0 && bx < 0) || (ax >= width && bx >= width) || (ay < 0 && by < 0) || (ay >= height && by >= height)) return;
    if (ay === by) {
      this.hline(ax, bx, ay, color);
      return;
    }
    if (ax === bx) {
      this.vline(ax, ay, by, color);
      return;
    }
    if (Math.max(-ax, -ay, ax - width, ay - height, -bx, -by, bx - width, by - height) > GUARD) {
      // Far off the screen: cut the line to the screen and a pixel around it first.
      const clipped = clip(ax, ay, bx, by, -1, -1, width, height);
      if (!clipped) return;
      [ax, ay, bx, by] = clipped;
    }
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let error = dx + dy;
    let x = ax;
    let y = ay;
    const pixels = this.pixels;
    for (;;) {
      if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = color;
      if (x === bx && y === by) break;
      const twice = 2 * error;
      if (twice >= dy) {
        error += dy;
        x += sx;
      }
      if (twice <= dx) {
        error += dx;
        y += sy;
      }
    }
  }

  /** A row from x0 to x1 (in either order) at y. */
  hline(x0: number, x1: number, y: number, color: number): void {
    const row = Math.round(y);
    if (row < 0 || row >= this.height) return;
    let from = Math.round(Math.min(x0, x1));
    let to = Math.round(Math.max(x0, x1));
    if (to < 0 || from >= this.width) return;
    if (from < 0) from = 0;
    if (to >= this.width) to = this.width - 1;
    this.pixels.fill(color, row * this.width + from, row * this.width + to + 1);
  }

  /** A column from y0 to y1 (in either order) at x. */
  vline(x: number, y0: number, y1: number, color: number): void {
    const column = Math.round(x);
    if (column < 0 || column >= this.width) return;
    let from = Math.round(Math.min(y0, y1));
    let to = Math.round(Math.max(y0, y1));
    if (to < 0 || from >= this.height) return;
    if (from < 0) from = 0;
    if (to >= this.height) to = this.height - 1;
    const pixels = this.pixels;
    for (let at = from * this.width + column, end = to * this.width + column; at <= end; at += this.width) pixels[at] = color;
  }

  /** LINE (x0, y0)-(x1, y1), color, B: the outline of a box. */
  box(x0: number, y0: number, x1: number, y1: number, color: number): void {
    this.hline(x0, x1, y0, color);
    this.hline(x0, x1, y1, color);
    this.vline(x0, y0, y1, color);
    this.vline(x1, y0, y1, color);
  }

  /** LINE (x0, y0)-(x1, y1), color, BF: a filled box. */
  fillBox(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const top = Math.max(0, Math.round(Math.min(y0, y1)));
    const bottom = Math.min(this.height - 1, Math.round(Math.max(y0, y1)));
    for (let y = top; y <= bottom; y += 1) this.hline(x0, x1, y, color);
  }

  /** CIRCLE (cx, cy), r, color: the midpoint circle, eight octants mirrored. */
  circle(cx: number, cy: number, r: number, color: number): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const radius = Math.round(r);
    const width = this.width;
    const height = this.height;
    if (radius < 0 || x0 + radius < 0 || x0 - radius >= width || y0 + radius < 0 || y0 - radius >= height) return;
    const pixels = this.pixels;
    if (radius === 0) {
      pixels[y0 * width + x0] = color;
      return;
    }
    const inside = x0 - radius >= 0 && x0 + radius < width && y0 - radius >= 0 && y0 + radius < height;
    let x = radius;
    let y = 0;
    let decision = 1 - radius;
    while (x >= y) {
      if (inside) {
        pixels[(y0 + y) * width + x0 + x] = color;
        pixels[(y0 + y) * width + x0 - x] = color;
        pixels[(y0 - y) * width + x0 + x] = color;
        pixels[(y0 - y) * width + x0 - x] = color;
        pixels[(y0 + x) * width + x0 + y] = color;
        pixels[(y0 + x) * width + x0 - y] = color;
        pixels[(y0 - x) * width + x0 + y] = color;
        pixels[(y0 - x) * width + x0 - y] = color;
      } else {
        this.plot(x0 + x, y0 + y, color);
        this.plot(x0 - x, y0 + y, color);
        this.plot(x0 + x, y0 - y, color);
        this.plot(x0 - x, y0 - y, color);
        this.plot(x0 + y, y0 + x, color);
        this.plot(x0 - y, y0 + x, color);
        this.plot(x0 + y, y0 - x, color);
        this.plot(x0 - y, y0 - x, color);
      }
      y += 1;
      if (decision <= 0) {
        decision += 2 * y + 1;
      } else {
        x -= 1;
        decision += 2 * (y - x) + 1;
      }
    }
  }

  /** CIRCLE (cx, cy), r, color, , , aspect: the midpoint ellipse with half-axes rx and ry. */
  ellipse(cx: number, cy: number, rx: number, ry: number, color: number): void {
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const a = Math.round(Math.abs(rx));
    const b = Math.round(Math.abs(ry));
    if (x0 + a < 0 || x0 - a >= this.width || y0 + b < 0 || y0 - b >= this.height) return;
    if (a === 0 || b === 0) {
      this.line(x0 - a, y0 - b, x0 + a, y0 + b, color);
      return;
    }
    const a2 = a * a;
    const b2 = b * b;
    let x = 0;
    let y = b;
    // Region 1, where the slope is under one: step x. Decisions are kept four times over.
    let stepX = 0;
    let stepY = 2 * a2 * y;
    let decision = 4 * b2 - 4 * a2 * b + a2;
    while (stepX < stepY) {
      this.plot4(x0, y0, x, y, color);
      x += 1;
      stepX += 2 * b2;
      if (decision < 0) {
        decision += 4 * (stepX + b2);
      } else {
        y -= 1;
        stepY -= 2 * a2;
        decision += 4 * (stepX - stepY + b2);
      }
    }
    // Region 2: step y.
    decision = b2 * (2 * x + 1) * (2 * x + 1) + 4 * a2 * (y - 1) * (y - 1) - 4 * a2 * b2;
    while (y >= 0) {
      this.plot4(x0, y0, x, y, color);
      y -= 1;
      stepY -= 2 * a2;
      if (decision > 0) {
        decision += 4 * (a2 - stepY);
      } else {
        x += 1;
        stepX += 2 * b2;
        decision += 4 * (stepX - stepY + a2);
      }
    }
  }

  private plot(x: number, y: number, color: number): void {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.pixels[y * this.width + x] = color;
  }

  private plot4(x0: number, y0: number, x: number, y: number, color: number): void {
    this.plot(x0 + x, y0 + y, color);
    this.plot(x0 - x, y0 + y, color);
    this.plot(x0 + x, y0 - y, color);
    this.plot(x0 - x, y0 - y, color);
  }
}

/**
 * Liang–Barsky: the part of the line (x0, y0)-(x1, y1) inside [left, right] × [top, bottom],
 * rounded to whole pixels, or null when none of it is.
 */
export function clip(
  x0: number, y0: number, x1: number, y1: number, left: number, top: number, right: number, bottom: number
): [number, number, number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let enter = 0;
  let leave = 1;
  const edges: [number, number][] = [[-dx, x0 - left], [dx, right - x0], [-dy, y0 - top], [dy, bottom - y0]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > leave) return null;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return null;
      if (t < leave) leave = t;
    }
  }
  return [Math.round(x0 + enter * dx), Math.round(y0 + enter * dy), Math.round(x0 + leave * dx), Math.round(y0 + leave * dy)];
}

/** The screen in colour: each colour number looked up in `palette` (packed RGBA words). */
export function blit(pixels: Uint8Array, palette: Uint32Array, out: Uint32Array): void {
  const count = Math.min(pixels.length, out.length);
  for (let index = 0; index < count; index += 1) out[index] = palette[pixels[index]! & 15]!;
}
