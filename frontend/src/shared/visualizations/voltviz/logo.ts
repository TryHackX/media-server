/**
 * A raster logo (PNG and the like) as the paths voltviz's Your Logo draws.
 *
 * Your Logo was made for SVG: it samples every shape's outline point by point
 * (`getPointAtLength`) and draws those outlines as glowing lines, the closed ones with copies
 * pushed out in depth on the beat. A picture has no outlines, so they are traced here: the iso-line
 * of how much of each pixel is the logo, found by marching squares, which for a filled logo is the
 * outline of every shape and of every hole in it, as its SVG would have them. Each outline is then
 * sampled as Your Logo samples a path — 300 to 3000 points by its length in the picture's pixels,
 * the last point on the first — and all are normalised as loadSvg normalises them: centred, half the
 * larger side is 1.
 *
 * What counts as the logo:
 * - on a transparent picture, the opaque part: the contour is halfway up the edges, or, when
 *   much of the picture is partly transparent (a glow or a soft shadow round the shapes), at 85%
 *   of its (nearly) highest opacity, so the glow stays out;
 * - on an opaque one, what differs from the background (the colour of most of the border), cut
 *   halfway between the background and the strongest difference.
 *
 * No imports: the tests run it in Node as it is.
 */

/** The pixels of a picture: RGBA, 8 bits a channel, row by row (ImageData). */
export interface LogoPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** One path as Your Logo keeps it: points [x, y, 0], and its own colour (none: neon). */
export interface TracedPath {
  path: number[][];
  color: string | null;
}

/** The picture is traced at most this size (its longer side, in pixels). */
const TRACE_SIDE = 640;
/** The most outlines kept (the largest), so a photo does not become thousands of specks. */
const MAX_PATHS = 96;
/** Your Logo samples a path at its length in points, within these bounds (getPointAtLength). */
const MIN_POINTS = 300;
const MAX_POINTS = 3000;

function percentile(values: Float32Array, share: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]! : 0;
}

/** How much each pixel is the logo (0…1, not yet cut), and where to cut. */
function coverage(image: LogoPixels): { field: Float32Array; level: number } {
  const { width, height, data } = image;
  const field = new Float32Array(width * height);
  const border: number[] = [];
  for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) border.push(y * width, y * width + width - 1);
  const clear = border.filter((index) => data[index * 4 + 3]! < 26).length;
  if (clear * 2 >= border.length) {
    let solid = 0;
    let soft = 0;
    for (let index = 0; index < field.length; index += 1) {
      const alpha = data[index * 4 + 3]! / 255;
      field[index] = alpha;
      if (alpha >= 0.8) solid += 1;
      else if (alpha > 0.05) soft += 1;
    }
    // Hard edges are a pixel or two of partial cover: cut halfway. A glow is a wide band of
    // it round the shapes: cut near the top, where the shapes themselves are.
    const top = percentile(field.filter((value) => value > 0.02), 0.995);
    return { field, level: (soft > solid * 0.5 ? 0.85 : 0.5) * top };
  }
  // The background: the median colour of the border.
  const channel = (offset: number): number => {
    const values = border.map((index) => data[index * 4 + offset]!).sort((a, b) => a - b);
    return values[values.length >> 1]!;
  };
  const background = [channel(0), channel(1), channel(2)];
  for (let index = 0; index < field.length; index += 1) {
    const alpha = data[index * 4 + 3]! / 255;
    let sum = 0;
    for (let c = 0; c < 3; c += 1) {
      const difference = data[index * 4 + c]! * alpha + background[c]! * (1 - alpha) - background[c]!;
      sum += difference * difference;
    }
    field[index] = Math.sqrt(sum) / (255 * Math.sqrt(3));
  }
  return { field, level: 0.5 * percentile(field, 0.995) };
}

/** Area-averaged down to `scale` (≤ 1) of the size, with a border of zeros all round. */
function shrink(field: Float32Array, width: number, height: number, scale: number): { field: Float32Array; width: number; height: number } {
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Float32Array((w + 2) * (h + 2));
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let sum = 0;
      for (let sy = y0; sy < y1; sy += 1) for (let sx = x0; sx < x1; sx += 1) sum += field[sy * width + sx]!;
      out[(y + 1) * (w + 2) + x + 1] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { field: out, width: w + 2, height: h + 2 };
}

/** A light blur (1 4 6 4 1 both ways) against the stair-steps of the pixels. */
function soften(field: Float32Array, width: number, height: number): Float32Array {
  const weights = [1, 4, 6, 4, 1];
  const pass = (source: Float32Array, dx: number, dy: number): Float32Array => {
    const out = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let k = -2; k <= 2; k += 1) {
          const sx = Math.min(width - 1, Math.max(0, x + k * dx));
          const sy = Math.min(height - 1, Math.max(0, y + k * dy));
          sum += source[sy * width + sx]! * weights[k + 2]!;
        }
        out[y * width + x] = sum / 16;
      }
    }
    return out;
  };
  return pass(pass(field, 1, 0), 0, 1);
}

/**
 * Marching squares: the closed iso-lines of `field` at `level` (the field is zero all round, so
 * every line closes), each with the logo on its left.
 */
export function isoLines(field: Float32Array, width: number, height: number, level: number): number[][][] {
  // Crossing points on the cell edges: horizontal edge (x, y)–(x+1, y) and vertical (x, y)–(x, y+1).
  const point = (key: number): number[] => {
    const vertical = key >= width * height;
    const index = vertical ? key - width * height : key;
    const x = index % width;
    const y = Math.floor(index / width);
    const a = field[index]!;
    const b = vertical ? field[index + width]! : field[index + 1]!;
    const t = a === b ? 0.5 : (level - a) / (b - a);
    return vertical ? [x, y + t] : [x + t, y];
  };
  const next = new Map<number, number>();
  const top = (x: number, y: number): number => y * width + x;
  const bottom = (x: number, y: number): number => (y + 1) * width + x;
  const left = (x: number, y: number): number => width * height + y * width + x;
  const right = (x: number, y: number): number => width * height + y * width + x + 1;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const tl = field[y * width + x]! > level ? 1 : 0;
      const tr = field[y * width + x + 1]! > level ? 1 : 0;
      const br = field[(y + 1) * width + x + 1]! > level ? 1 : 0;
      const bl = field[(y + 1) * width + x]! > level ? 1 : 0;
      const index = tl * 8 + tr * 4 + br * 2 + bl;
      if (index === 0 || index === 15) continue;
      const T = top(x, y), R = right(x, y), B = bottom(x, y), L = left(x, y);
      // Directed so that the inside (above the level) is on the left, y pointing down.
      const link = (from: number, to: number): void => { next.set(from, to); };
      switch (index) {
        case 1: link(B, L); break;
        case 2: link(R, B); break;
        case 3: link(R, L); break;
        case 4: link(T, R); break;
        case 6: link(T, B); break;
        case 7: link(T, L); break;
        case 8: link(L, T); break;
        case 9: link(B, T); break;
        case 11: link(R, T); break;
        case 12: link(L, R); break;
        case 13: link(B, R); break;
        case 14: link(L, B); break;
        case 5: case 10: {
          // A saddle: the centre of the cell decides whether the two insides touch.
          const centre = (field[y * width + x]! + field[y * width + x + 1]! + field[(y + 1) * width + x + 1]! + field[(y + 1) * width + x]!) / 4 > level;
          if (index === 5) {
            if (centre) { link(T, L); link(B, R); } else { link(T, R); link(B, L); }
          } else if (centre) { link(R, T); link(L, B); } else { link(L, T); link(R, B); }
          break;
        }
      }
    }
  }
  const lines: number[][][] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const line: number[][] = [];
    let key: number | undefined = start;
    while (key !== undefined && next.has(key)) {
      line.push(point(key));
      const following: number = next.get(key)!;
      next.delete(key);
      key = following;
    }
    if (line.length > 2) lines.push(line);
  }
  return lines;
}

function loopLength(points: number[][]): number {
  let length = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    length += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
  }
  return length;
}

function loopArea(points: number[][]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    area += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return area / 2;
}

/** `count` points evenly along a closed loop, the first where it starts. */
function resample(points: number[][], count: number): number[][] {
  const length = loopLength(points);
  const out: number[][] = [];
  let segment = 0;
  let walked = 0;
  for (let k = 0; k < count; k += 1) {
    const at = (k / count) * length;
    while (segment < points.length - 1) {
      const a = points[segment]!;
      const b = points[(segment + 1) % points.length]!;
      const step = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
      if (walked + step >= at) break;
      walked += step;
      segment += 1;
    }
    const a = points[segment]!;
    const b = points[(segment + 1) % points.length]!;
    const step = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
    const t = step > 0 ? Math.min(1, Math.max(0, (at - walked) / step)) : 0;
    out.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t]);
  }
  return out;
}

/** A moving average round the loop: the pixel grid's wobble goes, the shape stays. */
function smooth(points: number[][], radius: number, passes: number): number[][] {
  let current = points;
  const n = current.length;
  for (let pass = 0; pass < passes; pass += 1) {
    const out: number[][] = [];
    for (let index = 0; index < n; index += 1) {
      let x = 0;
      let y = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const p = current[(index + k + n) % n]!;
        x += p[0]!;
        y += p[1]!;
      }
      out.push([x / (2 * radius + 1), y / (2 * radius + 1)]);
    }
    current = out;
  }
  return current;
}

/**
 * The logo's outlines as Your Logo's paths (loadSvg's coordinates: centred, half the larger side
 * is 1, z = 0), left to right; none when the picture has nothing to trace.
 */
export function traceLogo(image: LogoPixels): TracedPath[] {
  const { width, height } = image;
  if (width < 2 || height < 2 || image.data.length < width * height * 4) return [];
  const { field, level } = coverage(image);
  if (!(level > 0)) return [];
  const scale = Math.min(1, TRACE_SIDE / Math.max(width, height));
  const small = shrink(field, width, height, scale);
  const lines = isoLines(soften(small.field, small.width, small.height), small.width, small.height, level);
  // Back to the picture's pixels (the traced field has a border of one pixel all round).
  const sx = width / (small.width - 2);
  const sy = height / (small.height - 2);
  const minimum = Math.max(4, width * height * 2e-4);
  const loops = lines
    .map((line) => line.map(([x, y]) => [(x! - 0.5) * sx, (y! - 0.5) * sy]))
    .map((points) => ({ points, area: Math.abs(loopArea(points)) }))
    .filter((loop) => loop.area >= minimum)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_PATHS)
    .map((loop) => {
      // About a point a pixel, then the wobble smoothed out over a couple of pixels.
      const even = resample(loop.points, Math.max(12, Math.round(loopLength(loop.points))));
      const smoothed = smooth(even, 2, 2);
      const length = loopLength(smoothed);
      const count = Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.floor(length)));
      const points = resample(smoothed, count);
      points.push([points[0]![0]!, points[0]![1]!]);
      return points;
    });
  if (!loops.length) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const points of loops) {
    for (const [x, y] of points) {
      minX = Math.min(minX, x!); maxX = Math.max(maxX, x!);
      minY = Math.min(minY, y!); maxY = Math.max(maxY, y!);
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 || 1;
  const left = (points: number[][]): number => Math.min(...points.map((p) => p[0]!));
  const upper = (points: number[][]): number => Math.min(...points.map((p) => p[1]!));
  return loops
    .sort((a, b) => left(a) - left(b) || upper(a) - upper(b))
    .map((points) => ({ path: points.map(([x, y]) => [(x! - cx) / half, (y! - cy) / half, 0]), color: null }));
}
