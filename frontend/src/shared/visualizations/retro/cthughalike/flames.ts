/**
 * Flames: what makes everything burn away and move. Each step a new picture is made from the
 * last one, every pixel the sum of a few neighbours ("taps") put through a table: divided down
 * and less a little (the picture fades as it spreads), or with something added and wrapped round
 * at 256 (it boils through the palette), or swelled until it wraps (bright cores ring over). The
 * taps decide where it goes: up like fire, down, sideways, nowhere (a glow), or swaying.
 *
 * Pictures are `width × height` bytes plus one more at the end that stays 0 (the translation
 * tables point there for "outside"). Our own design, after the descriptions of Cthugha's flames.
 */

export type FlameKernel =
  | "rise" | "riseFast" | "fall" | "left" | "right" | "glow" | "haze" | "streak" | "lift" | "sway"
  | "climbLeft" | "climbRight" | "still";

export type FlameRule = "decay" | "boil" | "swell";

export interface FlameSpec {
  kernel: FlameKernel;
  rule: FlameRule;
  /** decay: subtracted each step; boil: added (wraps); swell: subtracted after a gain of 1/16. */
  amount: number;
  /** Speckle: up to this much more taken off at random, a pixel here and there (0 for none). */
  speckle?: number;
}

/** Where a kernel's taps are, as [dx, dy] from the pixel being made. */
const TAPS: Record<FlameKernel, readonly (readonly [number, number])[]> = {
  rise: [[-1, 1], [0, 1], [1, 1], [0, 2]],
  riseFast: [[-1, 2], [0, 2], [1, 2], [0, 3]],
  fall: [[-1, -1], [0, -1], [1, -1], [0, -2]],
  left: [[1, -1], [1, 0], [1, 1], [2, 0]],
  right: [[-1, -1], [-1, 0], [-1, 1], [-2, 0]],
  glow: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  haze: [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  streak: [[-1, 0], [1, 0], [0, 0], [0, 0]],
  lift: [[0, 0], [-1, 1], [0, 1], [1, 1]],
  sway: [[-1, 1], [0, 1], [1, 1], [0, 2]],
  climbLeft: [[0, 1], [1, 1], [1, 0], [2, 2]],
  climbRight: [[0, 1], [-1, 1], [-1, 0], [-2, 2]],
  still: [[0, 0], [0, 0], [0, 0], [0, 0]]
};

export function tapCount(kernel: FlameKernel): number {
  return TAPS[kernel].length;
}

/**
 * The table from a sum of `taps` neighbours to the new value. Sums run to 255 × taps; the table
 * has room for that many entries plus one.
 */
export function flameTable(spec: FlameSpec, taps: number, out: Uint8Array = new Uint8Array(255 * 8 + 1)): Uint8Array {
  const amount = Math.round(spec.amount);
  for (let sum = 0; sum <= 255 * taps; sum += 1) {
    const mean = Math.floor(sum / taps);
    let value: number;
    if (spec.rule === "boil") {
      value = (mean + amount) & 255;
    } else if (spec.rule === "swell") {
      // A gain of 17/16: bright parts climb until they wrap to dark and start again.
      value = (Math.floor((sum * 17) / (taps * 16)) - amount) & 255;
      if (mean <= amount) value = 0;
    } else {
      value = mean > amount ? mean - amount : 0;
    }
    out[sum] = value;
  }
  return out;
}

/** Random amounts 0…`most` for the speckle, read round in a ring. */
export function speckleTable(random: () => number, most: number, size = 65536): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    // Mostly nothing, now and then a bite: the fire's grain.
    out[index] = random() < 0.35 ? Math.floor(random() * (most + 1)) : 0;
  }
  return out;
}

function burnPlain(
  src: Uint8Array, dst: Uint8Array, width: number, xFrom: number, xTo: number, yFrom: number, yTo: number,
  table: Uint8Array, o0: number, o1: number, o2: number, o3: number
): void {
  for (let y = yFrom; y < yTo; y += 1) {
    const end = y * width + xTo;
    for (let i = y * width + xFrom; i < end; i += 1) dst[i] = table[src[i + o0]! + src[i + o1]! + src[i + o2]! + src[i + o3]!]!;
  }
}

function burnSpeckled(
  src: Uint8Array, dst: Uint8Array, width: number, xFrom: number, xTo: number, yFrom: number, yTo: number,
  table: Uint8Array, o0: number, o1: number, o2: number, o3: number, speckle: Uint8Array, phase: number
): void {
  for (let y = yFrom; y < yTo; y += 1) {
    const end = y * width + xTo;
    let s = (phase + y * 977) & 65535;
    for (let i = y * width + xFrom; i < end; i += 1) {
      const value = table[src[i + o0]! + src[i + o1]! + src[i + o2]! + src[i + o3]!]!;
      const bite = speckle[s]!;
      s = (s + 1) & 65535;
      dst[i] = value > bite ? value - bite : 0;
    }
  }
}

/** "sway": each row takes from a little to the left or right, a slow wave up the picture. */
function burnSway(
  src: Uint8Array, dst: Uint8Array, width: number, xFrom: number, xTo: number, yFrom: number, yTo: number,
  table: Uint8Array, o0: number, o1: number, o2: number, o3: number, time: number
): void {
  for (let y = yFrom; y < yTo; y += 1) {
    const shift = Math.round(Math.sin(y * 0.045 + time * 1.7) * 1.4 + Math.sin(y * 0.13 - time * 2.3) * 0.6);
    const p0 = o0 + shift;
    const p1 = o1 + shift;
    const p2 = o2 + shift;
    const p3 = o3 + shift;
    const end = y * width + xTo;
    for (let i = y * width + xFrom; i < end; i += 1) dst[i] = table[src[i + p0]! + src[i + p1]! + src[i + p2]! + src[i + p3]!]!;
  }
}

/** The eight neighbours: a 3 × 3 box less its middle, a running sum along each row. */
function burnBox(
  src: Uint8Array, dst: Uint8Array, width: number, xFrom: number, xTo: number, yFrom: number, yTo: number,
  table: Uint8Array
): void {
  for (let y = yFrom; y < yTo; y += 1) {
    const row = y * width;
    const up = row - width;
    const down = row + width;
    let x = xFrom;
    // Column sums of the three rows, sliding along.
    let a = src[up + x - 1]! + src[row + x - 1]! + src[down + x - 1]!;
    let b = src[up + x]! + src[row + x]! + src[down + x]!;
    for (; x < xTo; x += 1) {
      const c = src[up + x + 1]! + src[row + x + 1]! + src[down + x + 1]!;
      dst[row + x] = table[a + b + c - src[row + x]!]!;
      a = b;
      b = c;
    }
  }
}

/**
 * One step of a flame from `src` into `dst` (both `width × height + 1`). `table` is flameTable's
 * for this kernel; `speckle` (65536 entries) and `phase` add the grain; `time` sways "sway".
 */
export function burn(
  kernel: FlameKernel, src: Uint8Array, dst: Uint8Array, width: number, height: number,
  table: Uint8Array, speckle: Uint8Array | null, phase: number, time: number
): void {
  const taps = TAPS[kernel];
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  for (const [dx, dy] of taps) {
    left = Math.max(left, -dx);
    right = Math.max(right, dx);
    top = Math.max(top, -dy);
    bottom = Math.max(bottom, dy);
  }
  if (kernel === "sway") {
    left += 1;
    right += 1;
  }
  const xFrom = left;
  const xTo = width - right;
  const yFrom = top;
  const yTo = height - bottom;
  if (taps.length === 8) {
    burnBox(src, dst, width, xFrom, xTo, yFrom, yTo, table);
  } else {
    const [o0, o1, o2, o3] = taps.map(([dx, dy]) => dy * width + dx) as [number, number, number, number];
    // Each loop on its own, so the engine compiles it for just that case.
    if (kernel === "sway") burnSway(src, dst, width, xFrom, xTo, yFrom, yTo, table, o0, o1, o2, o3, time);
    else if (speckle) burnSpeckled(src, dst, width, xFrom, xTo, yFrom, yTo, table, o0, o1, o2, o3, speckle, phase);
    else burnPlain(src, dst, width, xFrom, xTo, yFrom, yTo, table, o0, o1, o2, o3);
  }
  // What the taps could not reach goes dark: the rows the fire leaves and the side columns.
  if (yFrom > 0) dst.fill(0, 0, yFrom * width);
  if (yTo < height) dst.fill(0, yTo * width, height * width);
  if (xFrom > 0 || xTo < width) {
    for (let y = yFrom; y < yTo; y += 1) {
      const row = y * width;
      for (let x = 0; x < xFrom; x += 1) dst[row + x] = 0;
      for (let x = xTo; x < width; x += 1) dst[row + x] = 0;
    }
  }
  dst[width * height] = 0;
}
