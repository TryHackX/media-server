/**
 * Translation tables: for every pixel, the pixel it takes its value from in the step before. Run
 * over and over, a table makes the picture flow: out of the centre in rays, round in a whirlpool,
 * up in turbulent smoke, into rings. Nearest-pixel lookups, as the originals' tables were, so the
 * flow keeps its hard, streaky grain.
 *
 * A table is `width × height` indices; one that points outside the picture points at the zero
 * after its end. Making one costs a few milliseconds at 640 × 480, so TableBuilder makes it a
 * slice of rows at a time. The fields are our own; the originals' `.tab` files were not used.
 */

export type TableKind =
  | "zoom" | "implode" | "rotate" | "swirl" | "hurricane" | "smoke" | "ripple" | "warp" | "tunnel"
  | "twin" | "fountain" | "drain" | "bubble" | "rings" | "cells" | "shear" | "flag";

export const TABLE_KINDS: readonly TableKind[] = [
  "zoom", "implode", "rotate", "swirl", "hurricane", "smoke", "ripple", "warp", "tunnel",
  "twin", "fountain", "drain", "bubble", "rings", "cells", "shear", "flag"
];

export interface TableSpec {
  kind: TableKind;
  /** How hard it pulls: about 0.6–1.6. */
  strength: number;
  /** Which way it turns: 1 or −1. */
  turn: number;
  /** For the noise of "smoke" and the phases of the others. */
  seed: number;
  /** Its centre, as a share of the width and height (0.5, 0.5 by default). */
  centreX?: number;
  centreY?: number;
}

/** A smooth noise field: a lattice of random values, bilinear with a smooth step, two octaves. */
function noiseField(seed: number): (x: number, y: number) => number {
  const size = 64;
  const lattice = new Float32Array(size * size);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < lattice.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    lattice[index] = ((state >>> 0) / 4294967296) * 2 - 1;
  }
  const at = (x: number, y: number): number => lattice[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!;
  const octave = (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  };
  return (x, y) => octave(x, y) * 0.7 + octave(x * 2.3 + 17, y * 2.3 + 31) * 0.3;
}

/**
 * Where pixel (x, y) takes its value from, as a function filling `out` with [sx, sy] in pixels.
 * Coordinates are normalised so that the shorter side runs −1…1 about the centre.
 */
export function tableField(spec: TableSpec, width: number, height: number): (x: number, y: number, out: Float64Array) => void {
  const cx = (spec.centreX ?? 0.5) * width;
  const cy = (spec.centreY ?? 0.5) * height;
  const scale = Math.min(width, height) / 2;
  const k = spec.strength;
  const turn = spec.turn < 0 ? -1 : 1;
  const phase = (spec.seed % 1000) / 159;
  // Turn by `angle` and scale by `grow` about the centre; grow > 1 takes from further out, so
  // the picture moves in; < 1, it moves out.
  const polar = (x: number, y: number, angle: number, grow: number, out: Float64Array): void => {
    const u = x - cx;
    const v = y - cy;
    const c = Math.cos(angle) * grow;
    const s = Math.sin(angle) * grow;
    out[0] = cx + u * c - v * s;
    out[1] = cy + u * s + v * c;
  };
  // The same for a turn and a scale that are the same everywhere: worked out once.
  const fixed = (angle: number, grow: number): ((x: number, y: number, out: Float64Array) => void) => {
    const c = Math.cos(angle) * grow;
    const s = Math.sin(angle) * grow;
    return (x, y, out) => {
      const u = x - cx;
      const v = y - cy;
      out[0] = cx + u * c - v * s;
      out[1] = cy + u * s + v * c;
    };
  };
  const radius = (x: number, y: number): number => Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / scale;
  switch (spec.kind) {
    case "zoom":
      return fixed(0.004 * turn * k, 1 - 0.028 * k);
    case "implode":
      return fixed(0.006 * turn * k, 1 + 0.022 * k);
    case "rotate":
      return fixed(0.03 * turn * k, 0.996);
    case "swirl":
      return (x, y, out) => {
        const r = radius(x, y);
        polar(x, y, turn * (0.13 * k * Math.exp(-r * 2.2) + 0.008), 0.994, out);
      };
    case "hurricane":
      return (x, y, out) => {
        const r = radius(x, y);
        polar(x, y, (turn * 0.018 * k) / (r + 0.12), 1 + 0.01 * k, out);
      };
    case "drain":
      return fixed(0.035 * turn * k, 1 + 0.018 * k);
    case "tunnel":
      return (x, y, out) => {
        const r = radius(x, y);
        polar(x, y, turn * 0.03 * k * (1.2 - Math.min(1, r)), 1 - 0.04 * k * Math.min(1, r + 0.15), out);
      };
    case "bubble":
      return (x, y, out) => {
        const r = radius(x, y);
        polar(x, y, 0, 1 - 0.045 * k * Math.exp(-r * r * 2.5), out);
      };
    case "rings":
      return (x, y, out) => {
        const r = radius(x, y);
        polar(x, y, turn * 0.045 * k * Math.sin(r * 13 + phase), 0.998, out);
      };
    case "ripple":
      return (x, y, out) => {
        const r = radius(x, y);
        const u = x - cx;
        const v = y - cy;
        const length = Math.sqrt(u * u + v * v) || 1;
        const push = 1.6 * k * Math.sin(r * 26 + phase);
        out[0] = x + (u / length) * push;
        out[1] = y + (v / length) * push;
      };
    case "warp":
      return (x, y, out) => {
        const u = (x - cx) / scale;
        const v = (y - cy) / scale;
        out[0] = x + 1.7 * k * Math.sin(v * 7 + phase);
        out[1] = y + 1.7 * k * Math.sin(u * 7 - phase * 0.7);
      };
    case "shear":
      return (x, y, out) => {
        const v = (y - cy) / scale;
        out[0] = x + 2.2 * k * turn * Math.sin(v * Math.PI * 1.5 + phase);
        out[1] = y + 0.3 * Math.sin((x - cx) / scale * 5);
      };
    case "flag":
      return (x, y, out) => {
        const v = (y - cy) / scale;
        out[0] = x + 1.4 * k * Math.sin(v * 9 + phase + (x - cx) / scale * 2);
        out[1] = y + 1.1 * k;
      };
    case "fountain":
      return (x, y, out) => {
        const u = (x - cx) / scale;
        const v = (y - cy) / scale;
        const lift = Math.cos(Math.min(Math.abs(u), 1.3) / 1.3 * Math.PI);
        out[0] = x - u * 1.3 * k + 0.4 * Math.sin(v * 6);
        out[1] = y + 1.8 * k * lift;
      };
    case "twin":
      return (x, y, out) => {
        let sx = x;
        let sy = y;
        for (const side of [-1, 1]) {
          const ox = cx + side * 0.55 * scale;
          const u = (x - ox) / scale;
          const v = (y - cy) / scale;
          const fall = Math.exp(-(u * u + v * v) * 5);
          const angle = side * turn * 0.11 * k * fall;
          sx += (u * Math.cos(angle) - v * Math.sin(angle) - u) * scale;
          sy += (u * Math.sin(angle) + v * Math.cos(angle) - v) * scale;
        }
        out[0] = sx;
        out[1] = sy + 0.6;
      };
    case "cells":
      return (x, y, out) => {
        let sx = x;
        let sy = y;
        for (const [qx, qy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const ox = cx + qx * width * 0.25;
          const oy = cy + qy * height * 0.25;
          const u = (x - ox) / scale;
          const v = (y - oy) / scale;
          const fall = Math.exp(-(u * u + v * v) * 9);
          const angle = qx * qy * turn * 0.09 * k * fall;
          sx += (u * Math.cos(angle) - v * Math.sin(angle) - u) * scale;
          sy += (u * Math.sin(angle) + v * Math.cos(angle) - v) * scale;
        }
        out[0] = sx;
        out[1] = sy;
      };
    case "smoke": {
      const noise = noiseField(spec.seed);
      const n2 = noiseField(spec.seed ^ 0x5bd1e995);
      return (x, y, out) => {
        const u = x / scale * 2.2;
        const v = y / scale * 2.2;
        out[0] = x + 2.2 * k * noise(u, v);
        out[1] = y + 1.1 * k + 1.6 * k * n2(u + 5, v + 9);
      };
    }
  }
}

/** The fields are smooth: worked out every GRID pixels, in between they are interpolated. */
const GRID = 4;

/**
 * Makes one table a slice of rows at a time. The field's displacement is worked out on a grid
 * GRID pixels apart and interpolated for the pixels between; the source pixel is then rounded,
 * so the flow keeps the nearest-pixel grain.
 */
export class TableBuilder {
  readonly spec: TableSpec;
  readonly width: number;
  readonly height: number;
  readonly table: Int32Array;
  private row = 0;
  private readonly field: (x: number, y: number, out: Float64Array) => void;
  private readonly point = new Float64Array(2);
  private readonly gridWidth: number;
  /** The displacement at the grid points, row by row, and how many grid rows are worked out. */
  private readonly shiftX: Float32Array;
  private readonly shiftY: Float32Array;
  private gridRows = 0;

  constructor(spec: TableSpec, width: number, height: number) {
    this.spec = spec;
    this.width = width;
    this.height = height;
    this.table = new Int32Array(width * height);
    this.field = tableField(spec, width, height);
    this.gridWidth = Math.ceil((width - 1) / GRID) + 2;
    const gridHeight = Math.ceil((height - 1) / GRID) + 2;
    this.shiftX = new Float32Array(this.gridWidth * gridHeight);
    this.shiftY = new Float32Array(this.gridWidth * gridHeight);
  }

  get done(): boolean {
    return this.row >= this.height;
  }

  /** Works out the grid's rows up to `row`. */
  private grid(row: number): void {
    const { gridWidth, point, shiftX, shiftY } = this;
    for (; this.gridRows <= row; this.gridRows += 1) {
      const y = this.gridRows * GRID;
      for (let i = 0; i < gridWidth; i += 1) {
        const x = i * GRID;
        this.field(x, y, point);
        shiftX[this.gridRows * gridWidth + i] = point[0]! - x;
        shiftY[this.gridRows * gridWidth + i] = point[1]! - y;
      }
    }
  }

  /** Makes up to `rows` more rows; true when the table is complete. */
  advance(rows: number): boolean {
    const { width, height, table, gridWidth, shiftX, shiftY } = this;
    const outside = width * height;
    const to = Math.min(height, this.row + rows);
    for (let y = this.row; y < to; y += 1) {
      const gy = Math.floor(y / GRID);
      const fy = (y - gy * GRID) / GRID;
      this.grid(gy + 1);
      const top = gy * gridWidth;
      const bottom = top + gridWidth;
      for (let x = 0; x < width; x += 1) {
        const gx = (x / GRID) | 0;
        const fx = (x - gx * GRID) / GRID;
        const a = top + gx;
        const b = bottom + gx;
        const dx0 = shiftX[a]! + (shiftX[a + 1]! - shiftX[a]!) * fx;
        const dx1 = shiftX[b]! + (shiftX[b + 1]! - shiftX[b]!) * fx;
        const dy0 = shiftY[a]! + (shiftY[a + 1]! - shiftY[a]!) * fx;
        const dy1 = shiftY[b]! + (shiftY[b + 1]! - shiftY[b]!) * fx;
        const sx = Math.round(x + dx0 + (dx1 - dx0) * fy);
        const sy = Math.round(y + dy0 + (dy1 - dy0) * fy);
        table[y * width + x] = sx >= 0 && sy >= 0 && sx < width && sy < height ? sy * width + sx : outside;
      }
    }
    this.row = to;
    return this.done;
  }
}

/** One step of the flow: `dst[i] = src[table[i]]` for the whole picture. */
export function translate(src: Uint8Array, dst: Uint8Array, table: Int32Array): void {
  const count = table.length;
  for (let index = 0; index < count; index += 1) dst[index] = src[table[index]!]!;
  dst[count] = 0;
}
