/**
 * The 3dfx views, in software: the 8-bit picture as a landscape, every value a height, seen by a
 * camera that circles it. Cthugha98's Glide build drew it so on a Voodoo card ("the image rendered
 * as a rotating height field"); its screenshots show smooth, lit surfaces whose colours run
 * through the palette up the slopes. Here a grid of vertices takes the picture's values; each cell
 * is two triangles filled back to front (a height field needs no depth buffer), with the value
 * and the light interpolated across them and the colour looked up per pixel, so a slope from dark
 * to hot passes through every colour in between. A point cloud is the other view.
 */

export interface FieldCamera {
  /** Turn of the field about its upright axis (radians). */
  yaw: number;
  /** How far the camera looks down: 0 level with the field, π/2 straight down. */
  pitch: number;
  /** The camera's distance from the field's centre, in half-depths of the field. */
  distance: number;
  /** The height of a value-255 peak, in half-depths. */
  lift: number;
  /** Pixels per unit at distance 1. */
  focal: number;
  /** Where the field's centre falls on the screen. */
  centreX: number;
  centreY: number;
}

export interface FieldTarget {
  /** RGBA words as signed 32-bit numbers (palettes.ts, word()). */
  pixels: Int32Array;
  width: number;
  height: number;
}

/** Light levels in the shade table; level 20 is the plain palette colour, above it highlights. */
export const LIGHT_LEVELS = 32;
const PLAIN_LEVEL = 20;
/** Depth buckets for drawing back to front. */
const BUCKETS = 1024;
/** The depth of a band of cells drawn together, in grid steps. */
const BAND_STEPS = 3;

/**
 * The shade table: for each light level, the 256 palette colours lit that much (as RGBA words,
 * little-endian), dark at level 0, plain at PLAIN_LEVEL, washed towards white above it.
 */
export function shadeTable(rgb: Uint8Array, out: Int32Array, littleEndian = true): void {
  for (let level = 0; level < LIGHT_LEVELS; level += 1) {
    const light = Math.min(1, level / PLAIN_LEVEL);
    const glare = Math.max(0, (level - PLAIN_LEVEL) / (LIGHT_LEVELS - 1 - PLAIN_LEVEL)) * 0.55;
    for (let index = 0; index < 256; index += 1) {
      const channel = (c: number): number => {
        const lit = rgb[index * 3 + c]! * light;
        return Math.round(lit + (255 - lit) * glare * (rgb[index * 3 + c]! / 255 * 0.6 + 0.4));
      };
      const r = channel(0);
      const g = channel(1);
      const b = channel(2);
      out[level * 256 + index] = littleEndian
        ? (255 << 24) | (b << 16) | (g << 8) | r
        : (r << 24) | (g << 16) | (b << 8) | 255;
    }
  }
}

/**
 * What the triangles are drawn into, front to back. Each screen column is covered from its
 * horizon down, so a triangle draws only above it, and one wholly below the horizon in every
 * column it spans is skipped at once. The rows a band of cells draws raise the horizon when the
 * band is done, so cells side by side at about the same depth never hide one another.
 */
interface Canvas3d {
  pixels: Int32Array;
  width: number;
  height: number;
  shades: Int32Array;
  horizon: Int32Array;
  /** The band's highest row drawn in each column, and the columns it drew in. */
  bandTop: Int32Array;
  touched: Int32Array;
  touchedCount: number;
}

/** The band is done: what it drew raises the horizon. */
function flushBand(canvas: Canvas3d): void {
  const { horizon, bandTop, touched, height } = canvas;
  for (let t = 0; t < canvas.touchedCount; t += 1) {
    const x = touched[t]!;
    if (bandTop[x]! < horizon[x]!) horizon[x] = bandTop[x]!;
    bandTop[x] = height;
  }
  canvas.touchedCount = 0;
}

/**
 * One triangle, column by column: value `a` and light `b` interpolated across it, each pixel
 * `shades[(b << 8) | a]`, clipped to each column's horizon. Pixel centres inside are filled.
 */
function triangle(
  canvas: Canvas3d,
  x0: number, y0: number, a0: number, b0: number,
  x1: number, y1: number, a1: number, b1: number,
  x2: number, y2: number, a2: number, b2: number
): void {
  // Sorted left to right.
  if (x1 < x0) { let t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; t = a0; a0 = a1; a1 = t; t = b0; b0 = b1; b1 = t; }
  if (x2 < x1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; t = a1; a1 = a2; a2 = t; t = b1; b1 = b2; b2 = t; }
  if (x1 < x0) { let t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; t = a0; a0 = a1; a1 = t; t = b0; b0 = b1; b1 = t; }
  const { pixels, width, height, shades, horizon, bandTop, touched } = canvas;
  let xFrom = Math.ceil(x0 - 0.5);
  let xTo = Math.ceil(x2 - 0.5) - 1;
  if (xFrom < 0) xFrom = 0;
  if (xTo > width - 1) xTo = width - 1;
  if (xTo < xFrom) return;
  // Below the horizon in every column it spans: hidden by nearer cells, nothing to do.
  const top = Math.ceil((y0 < y1 ? (y0 < y2 ? y0 : y2) : (y1 < y2 ? y1 : y2)) - 0.5);
  let seen = false;
  for (let x = xFrom; x <= xTo; x += 1) {
    if (horizon[x]! > top) {
      seen = true;
      break;
    }
  }
  if (!seen) return;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (det > -1e-6 && det < 1e-6) return;
  const inverse = 1 / det;
  // The planes of the value and the light: their change per pixel across and down.
  const dadx = ((a1 - a0) * (y2 - y0) - (a2 - a0) * (y1 - y0)) * inverse;
  const dady = ((a2 - a0) * (x1 - x0) - (a1 - a0) * (x2 - x0)) * inverse;
  const dbdx = ((b1 - b0) * (y2 - y0) - (b2 - b0) * (y1 - y0)) * inverse;
  const dbdy = ((b2 - b0) * (x1 - x0) - (b1 - b0) * (x2 - x0)) * inverse;
  const long = (y2 - y0) / (x2 - x0);
  const first = x1 > x0 ? (y1 - y0) / (x1 - x0) : 0;
  const second = x2 > x1 ? (y2 - y1) / (x2 - x1) : 0;
  const levels = LIGHT_LEVELS - 1;
  for (let x = xFrom; x <= xTo; x += 1) {
    const cx = x + 0.5;
    const ya = y0 + (cx - x0) * long;
    const yb = cx < x1 ? y0 + (cx - x0) * first : y1 + (cx - x1) * second;
    let rowFrom = Math.ceil((ya < yb ? ya : yb) - 0.5);
    let rowTo = Math.ceil((ya < yb ? yb : ya) - 0.5) - 1;
    const limit = horizon[x]! - 1;
    if (rowTo > limit) rowTo = limit;
    if (rowFrom < 0) rowFrom = 0;
    if (rowTo < rowFrom) continue;
    if (rowFrom < bandTop[x]!) {
      if (bandTop[x] === height) touched[canvas.touchedCount++] = x;
      bandTop[x] = rowFrom;
    }
    let a = a0 + (cx - x0) * dadx + (rowFrom + 0.5 - y0) * dady;
    let b = b0 + (cx - x0) * dbdx + (rowFrom + 0.5 - y0) * dbdy;
    let at = rowFrom * width + x;
    for (let y = rowFrom; y <= rowTo; y += 1) {
      const value = a < 0 ? 0 : a > 255 ? 255 : a | 0;
      const level = b < 0 ? 0 : b > levels ? levels : b | 0;
      pixels[at] = shades[(level << 8) | value]!;
      at += width;
      a += dady;
      b += dbdy;
    }
  }
}

/**
 * The last touch: a pixel or two left undrawn between drawn ones in a column (where a cell sorted
 * a hair too early raised the horizon over its neighbour's tip) takes the colour above it, and
 * the background (still 0) becomes `background`. Only rows `top`…`bottom` and columns
 * `left`…`right` can hold the landscape; the rest is background outright.
 */
export function seal(target: FieldTarget, background: number, left: number, right: number, top: number, bottom: number): void {
  const { pixels, width, height } = target;
  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(width - 1, Math.ceil(right));
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(height - 1, Math.ceil(bottom));
  if (x1 < x0 || y1 < y0) {
    pixels.fill(background);
    return;
  }
  pixels.fill(background, 0, y0 * width);
  pixels.fill(background, (y1 + 1) * width);
  for (let y = y0; y <= y1; y += 1) {
    const row = y * width;
    pixels.fill(background, row, row + x0);
    pixels.fill(background, row + x1 + 1, row + width);
    for (let at = row + x0, end = row + x1; at <= end; at += 1) {
      if (pixels[at] !== 0) continue;
      // Rows above are done: background there is background, anything else was drawn.
      const above = y > y0 ? pixels[at - width]! : background;
      if (above !== background && y + 1 <= y1) {
        // Drawn again within two rows below: a pinhole, not the edge of the landscape.
        const below = pixels[at + width]!;
        if (below !== 0) {
          pixels[at] = above;
          continue;
        }
        if (y + 2 <= y1 && pixels[at + 2 * width] !== 0) {
          pixels[at] = above;
          pixels[at + width] = above;
          continue;
        }
      }
      pixels[at] = background;
    }
  }
}

export class FieldRenderer {
  readonly columns: number;
  readonly rows: number;
  /** The grid's values, 0–255, row by row (row 0 at the far edge before turning). */
  readonly heights: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly depth: Float32Array;
  /** Each vertex's distance along the view over the ground, height left out: the drawing order. */
  private readonly ground: Float32Array;
  private readonly light: Float32Array;
  private readonly cellDepth: Float32Array;
  private readonly cellBucket: Uint16Array;
  private readonly counts = new Int32Array(BUCKETS + 1);
  private readonly order: Int32Array;
  readonly shades = new Int32Array(LIGHT_LEVELS * 256);
  /** Where the projected field lies on the screen, after `project`. */
  private left = 0;
  private right = 0;
  private top = 0;
  private bottom = 0;
  /** Values up to this are black in the palette: cells all that dark are not drawn. */
  dark = 0;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    const vertices = columns * rows;
    const cells = (columns - 1) * (rows - 1);
    this.heights = new Float32Array(vertices);
    this.sx = new Float32Array(vertices);
    this.sy = new Float32Array(vertices);
    this.depth = new Float32Array(vertices);
    this.ground = new Float32Array(vertices);
    this.light = new Float32Array(vertices);
    this.cellDepth = new Float32Array(cells);
    this.cellBucket = new Uint16Array(cells);
    this.order = new Int32Array(cells);
  }

  /** The palette the field is coloured with (and lit through). */
  setPalette(rgb: Uint8Array, littleEndian = true): void {
    shadeTable(rgb, this.shades, littleEndian);
    let dark = -1;
    while (dark < 255 && rgb[(dark + 1) * 3]! + rgb[(dark + 1) * 3 + 1]! + rgb[(dark + 1) * 3 + 2]! < 12) dark += 1;
    this.dark = dark;
  }

  /**
   * The grid's values from a picture: each vertex the brightest of its block mixed with the
   * block's mean, so thin bright lines stand up as ridges instead of vanishing.
   */
  sample(picture: Uint8Array, width: number, height: number): void {
    const { columns, rows, heights } = this;
    for (let j = 0; j < rows; j += 1) {
      const y0 = Math.floor((j * height) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * height) / rows));
      for (let i = 0; i < columns; i += 1) {
        const x0 = Math.floor((i * width) / columns);
        const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * width) / columns));
        let peak = 0;
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1; y += 2) {
          const row = y * width;
          for (let x = x0; x < x1; x += 2) {
            const value = picture[row + x]!;
            if (value > peak) peak = value;
            sum += value;
            count += 1;
          }
        }
        heights[j * columns + i] = peak * 0.6 + (sum / Math.max(1, count)) * 0.4;
      }
    }
  }

  /**
   * Places and lights every vertex for a camera. The field spans x −aspect…aspect, y −1…1,
   * values rising as z.
   */
  private project(camera: FieldCamera, aspect: number): void {
    const { columns, rows, heights, sx, sy, depth, ground, light } = this;
    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);
    const lift = camera.lift / 255;
    const stepX = (2 * aspect) / (columns - 1);
    const stepY = 2 / (rows - 1);
    // The light comes from the upper left of the screen, a little from behind the viewer.
    const lx0 = -0.45;
    const ly0 = -0.55;
    const lz0 = 0.7;
    const norm = Math.sqrt(lx0 * lx0 + ly0 * ly0 + lz0 * lz0);
    const lx = lx0 / norm;
    const ly = ly0 / norm;
    const lz = lz0 / norm;
    // The half-way vector between the light and the eye, for the highlight.
    const hx = lx;
    const hy = ly - 1;
    const hz = lz + 0.4;
    const hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 0; j < rows; j += 1) {
      const wy = -1 + j * stepY;
      for (let i = 0; i < columns; i += 1) {
        const k = j * columns + i;
        const wx = -aspect + i * stepX;
        const wz = heights[k]! * lift;
        // Turned about the upright axis, then seen from the camera.
        const rx = wx * cosYaw - wy * sinYaw;
        const ry = wx * sinYaw + wy * cosYaw;
        const yc = ry * sinPitch + wz * cosPitch;
        const zc = ry * cosPitch - wz * sinPitch + camera.distance;
        depth[k] = zc;
        ground[k] = ry * cosPitch + camera.distance;
        const scale = camera.focal / Math.max(0.05, zc);
        const px = camera.centreX + rx * scale;
        const py = camera.centreY - yc * scale;
        sx[k] = px;
        sy[k] = py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        // The slope's normal from the neighbours, turned with the field, against the light.
        const left = heights[j * columns + Math.max(0, i - 1)]!;
        const right = heights[j * columns + Math.min(columns - 1, i + 1)]!;
        const up = heights[Math.max(0, j - 1) * columns + i]!;
        const down = heights[Math.min(rows - 1, j + 1) * columns + i]!;
        const nx = -((right - left) * lift) / (2 * stepX);
        const ny = -((down - up) * lift) / (2 * stepY);
        const tx = nx * cosYaw - ny * sinYaw;
        const ty = nx * sinYaw + ny * cosYaw;
        const length = Math.sqrt(tx * tx + ty * ty + 1);
        const diffuse = Math.max(0, (tx * lx + ty * ly + lz) / length);
        // A highlight where the slope faces between the light and the eye.
        const facing = Math.max(0, (tx * hx + ty * hy + hz) / (length * hn));
        const f2 = facing * facing;
        const f4 = f2 * f2;
        const f8 = f4 * f4;
        const glare = f8 * f8 * f2;
        light[k] = (0.3 + 0.82 * diffuse) * PLAIN_LEVEL + glare * (LIGHT_LEVELS - 1 - PLAIN_LEVEL) * 1.2;
      }
    }
    this.left = minX - 1;
    this.right = maxX + 1;
    this.top = minY - 1;
    this.bottom = maxY + 1;
  }

  /**
   * The landscape, lit, over `background` into `target`. Cells go nearest first, a band at a
   * time, each drawn only above the horizon the nearer bands left in its columns: down a screen
   * column a height field seen from above only ever comes nearer, so what lies below a column's
   * horizon is drawn already. Hidden cells cost next to nothing.
   */
  mesh(camera: FieldCamera, target: FieldTarget, aspect: number, background: number): void {
    // Nothing yet is 0 (no opaque colour is), so pinholes can be told from the background.
    target.pixels.fill(0);
    this.project(camera, aspect);
    const { columns, rows, heights, sx, sy, depth, ground, light, cellDepth, cellBucket, counts, order } = this;
    const cells = (columns - 1) * (rows - 1);
    let near = Infinity;
    let far = -Infinity;
    for (let j = 0; j < rows - 1; j += 1) {
      for (let i = 0; i < columns - 1; i += 1) {
        const k = j * columns + i;
        // Nearer over the ground first: a peak far away must not go before the slope in front of it.
        const d = (ground[k]! + ground[k + 1]! + ground[k + columns]! + ground[k + columns + 1]!) * 0.25;
        cellDepth[j * (columns - 1) + i] = d;
        if (d < near) near = d;
        if (d > far) far = d;
      }
    }
    // Front to back by a counting sort on depth.
    counts.fill(0);
    const scale = BUCKETS / Math.max(1e-6, far - near);
    for (let c = 0; c < cells; c += 1) {
      let bucket = ((cellDepth[c]! - near) * scale) | 0;
      if (bucket > BUCKETS - 1) bucket = BUCKETS - 1;
      cellBucket[c] = bucket;
      counts[bucket + 1] = counts[bucket + 1]! + 1;
    }
    for (let b = 0; b < BUCKETS; b += 1) counts[b + 1] = counts[b + 1]! + counts[b]!;
    for (let c = 0; c < cells; c += 1) {
      const bucket = cellBucket[c]!;
      order[counts[bucket]!] = c;
      counts[bucket] = counts[bucket]! + 1;
    }
    const canvas = this.canvas(target);
    const dark = this.dark;
    const across = columns - 1;
    // Cells within a few grid steps of depth make a band: a cell may sort a little before the
    // neighbour that fills the column under its edge, and must not hide it.
    const step = 2 / (rows - 1);
    const bandWidth = Math.max(1, Math.round(BAND_STEPS * step * scale));
    let band = -1;
    for (let n = 0; n < cells; n += 1) {
      const c = order[n]!;
      const cellBand = (cellBucket[c]! / bandWidth) | 0;
      if (cellBand !== band) {
        flushBand(canvas);
        band = cellBand;
      }
      const j = (c / across) | 0;
      const k00 = c + j;
      const k10 = k00 + 1;
      const k01 = k00 + columns;
      const k11 = k01 + 1;
      const h00 = heights[k00]!;
      const h10 = heights[k10]!;
      const h01 = heights[k01]!;
      const h11 = heights[k11]!;
      if (h00 <= dark && h10 <= dark && h01 <= dark && h11 <= dark) continue;
      if (depth[k00]! < 0.08 || depth[k10]! < 0.08 || depth[k01]! < 0.08 || depth[k11]! < 0.08) continue;
      triangle(canvas,
        sx[k00]!, sy[k00]!, h00, light[k00]!,
        sx[k10]!, sy[k10]!, h10, light[k10]!,
        sx[k11]!, sy[k11]!, h11, light[k11]!);
      triangle(canvas,
        sx[k00]!, sy[k00]!, h00, light[k00]!,
        sx[k11]!, sy[k11]!, h11, light[k11]!,
        sx[k01]!, sy[k01]!, h01, light[k01]!);
    }
    flushBand(canvas);
    seal(target, background, this.left, this.right, this.top, this.bottom);
  }

  private canvas3d: Canvas3d | null = null;

  private canvas(target: FieldTarget): Canvas3d {
    let canvas = this.canvas3d;
    if (!canvas || canvas.width !== target.width || canvas.height !== target.height) {
      canvas = {
        pixels: target.pixels, width: target.width, height: target.height, shades: this.shades,
        horizon: new Int32Array(target.width), bandTop: new Int32Array(target.width),
        touched: new Int32Array(target.width), touchedCount: 0
      };
      this.canvas3d = canvas;
    }
    canvas.pixels = target.pixels;
    canvas.horizon.fill(target.height);
    canvas.bandTop.fill(target.height);
    canvas.touchedCount = 0;
    return canvas;
  }



  /**
   * The picture as a cloud of points at their heights: every `stride`-th pixel that is not dark,
   * added onto what is there (a dense cloud glows, a thin one still shows), near ones bigger.
   * `palette` is the palette as RGBA words; `background` fills the target first.
   */
  points(picture: Uint8Array, width: number, height: number, stride: number, camera: FieldCamera, target: FieldTarget, aspect: number, palette: Int32Array, background: number): void {
    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);
    const lift = camera.lift / 255;
    const { pixels } = target;
    pixels.fill(background);
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length * 4);
    const colours = new Uint8Array(palette.buffer, palette.byteOffset, 1024);
    const tw = target.width;
    const th = target.height;
    const near = camera.focal * 0.8;
    for (let y = 0; y < height; y += stride) {
      const wy = -1 + (2 * y) / (height - 1);
      for (let x = 0; x < width; x += stride) {
        const value = picture[y * width + x]!;
        if (value <= this.dark) continue;
        const wx = -aspect + (2 * aspect * x) / (width - 1);
        const wz = value * lift;
        const rx = wx * cosYaw - wy * sinYaw;
        const ry = wx * sinYaw + wy * cosYaw;
        const yc = ry * sinPitch + wz * cosPitch;
        const zc = ry * cosPitch - wz * sinPitch + camera.distance;
        if (zc < 0.08) continue;
        const scale = camera.focal / zc;
        const px = Math.round(camera.centreX + rx * scale);
        const py = Math.round(camera.centreY - yc * scale);
        if (px < 0 || py < 0 || px >= tw - 1 || py >= th - 1) continue;
        // Each byte of the colour added (alpha stays full): the channels in whatever order.
        const c = value * 4;
        const size = scale > near ? 2 : 1;
        for (let dy = 0; dy < size; dy += 1) {
          for (let dx = 0; dx < size; dx += 1) {
            const at = ((py + dy) * tw + px + dx) * 4;
            for (let channel = 0; channel < 4; channel += 1) {
              const sum = bytes[at + channel]! + colours[c + channel]!;
              bytes[at + channel] = sum > 255 ? 255 : sum;
            }
          }
        }
      }
    }
  }

}
