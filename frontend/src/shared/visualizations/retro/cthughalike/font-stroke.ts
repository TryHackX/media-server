/**
 * A stroke font for song titles: our own letters drawn as pen strokes along their centre lines,
 * so one design gives several faces by the pen alone (a round sans, a bold, a light, slab serifs
 * added at the stroke ends, a typewriter's fixed pitch, italics by shearing), as the plug-in wrote
 * titles in whatever Windows fonts there were.
 *
 * Glyphs are written in a small path language on a grid with capitals 10 high, the x-height 7 and
 * descenders to −3 (y up): `M x y` starts a stroke, `L x y` draws to a point, and
 * `A cx cy rx ry a0 a1` an elliptical arc from angle a0 to a1 (degrees, counter-clockwise from the
 * right), joined to the stroke before when it starts where that one ended.
 */

const GLYPHS: Record<string, string> = {
  a: "A 3 3.5 3 3.5 0 360 M 6 7 L 6 0",
  b: "M 0 10 L 0 0 A 3 3.5 3 3.5 180 540",
  c: "A 3.2 3.5 3.2 3.5 40 320",
  d: "A 3 3.5 3 3.5 0 360 M 6 10 L 6 0",
  e: "M 0.2 3.5 L 6.2 3.5 A 3.2 3.5 3 3.5 0 320",
  f: "M 4.5 10 L 3.5 10 A 3.5 8.5 1.5 1.5 90 180 L 2 0 M 0 7 L 4.5 7",
  g: "A 3 3.5 3 3.5 0 360 M 6 7 L 6 -1 A 3 -1 3 2 0 -150",
  h: "M 0 10 L 0 0 M 0 4 A 3 4 3 3 180 0 L 6 0",
  i: "M 1 7 L 1 0 M 1 9.4 L 1 9.6",
  j: "M 2 7 L 2 -1.5 A 0.5 -1.5 1.5 1.5 0 -90 M 2 9.4 L 2 9.6",
  k: "M 0 10 L 0 0 M 5 7 L 0 2.5 M 1.7 4 L 5.5 0",
  l: "M 1 10 L 1 0",
  m: "M 0 7 L 0 0 M 0 4.5 A 2.2 4.5 2.2 2.5 180 0 L 4.4 0 M 4.4 4.5 A 6.6 4.5 2.2 2.5 180 0 L 8.8 0",
  n: "M 0 7 L 0 0 M 0 4 A 3 4 3 3 180 0 L 6 0",
  o: "A 3.2 3.5 3.2 3.5 0 360",
  p: "M 0 7 L 0 -3 A 3 3.5 3 3.5 180 540",
  q: "A 3 3.5 3 3.5 0 360 M 6 7 L 6 -3",
  r: "M 0 7 L 0 0 M 0 4 A 3 4 3 3 180 60",
  s: "A 3 5.25 2.6 1.75 30 270 A 3 1.75 2.8 1.75 90 -150",
  t: "M 2 9.5 L 2 1.2 A 3.2 1.2 1.2 1.2 180 270 L 4 0 M 0 7 L 4 7",
  u: "M 0 7 L 0 3 A 3 3 3 3 180 360 L 6 7 M 6 3 L 6 0",
  v: "M 0 7 L 3 0 L 6 7",
  w: "M 0 7 L 2 0 L 4 6 L 6 0 L 8 7",
  x: "M 0 7 L 6 0 M 0 0 L 6 7",
  y: "M 0 7 L 3.1 0.2 M 6.2 7 L 2 -3",
  z: "M 0 7 L 6 7 L 0 0 L 6 0",
  A: "M 0 0 L 3.6 10 L 7.2 0 M 1.3 3.6 L 5.9 3.6",
  B: "M 0 0 L 0 10 L 3.6 10 A 3.6 7.6 2.4 2.4 90 -90 L 0 5.2 M 3.8 5.2 A 3.8 2.6 2.6 2.6 90 -90 L 0 0",
  C: "A 4.6 5 4.6 5 45 315",
  D: "M 0 0 L 0 10 L 2.5 10 A 2.5 5 4.8 5 90 -90 L 0 0",
  E: "M 6 10 L 0 10 L 0 0 L 6 0 M 0 5.2 L 4.8 5.2",
  F: "M 6 10 L 0 10 L 0 0 M 0 5.2 L 4.8 5.2",
  G: "A 4.8 5 4.8 5 42 360 L 9.6 4.4 L 5.8 4.4",
  H: "M 0 0 L 0 10 M 7 0 L 7 10 M 0 5.2 L 7 5.2",
  I: "M 0 0 L 0 10",
  J: "M 4.5 10 L 4.5 2.6 A 2.25 2.6 2.25 2.6 0 -180",
  K: "M 0 0 L 0 10 M 6.4 10 L 0 3.8 M 2 5.8 L 6.8 0",
  L: "M 0 10 L 0 0 L 5.6 0",
  M: "M 0 0 L 0 10 L 4.2 1.4 L 8.4 10 L 8.4 0",
  N: "M 0 0 L 0 10 L 7 0 L 7 10",
  O: "A 5 5 5 5 0 360",
  P: "M 0 0 L 0 10 L 3.8 10 A 3.8 7.4 2.6 2.6 90 -90 L 0 4.8",
  Q: "A 5 5 5 5 0 360 M 6 2.6 L 9.6 -0.6",
  R: "M 0 0 L 0 10 L 3.8 10 A 3.8 7.4 2.6 2.6 90 -90 L 0 4.8 M 3.4 4.8 L 6.6 0",
  S: "A 3.6 7.5 3.2 2.5 30 270 A 3.6 2.5 3.4 2.5 90 -150",
  T: "M 0 10 L 7.2 10 M 3.6 10 L 3.6 0",
  U: "M 0 10 L 0 3.6 A 3.6 3.6 3.6 3.6 180 360 L 7.2 10",
  V: "M 0 10 L 3.8 0 L 7.6 10",
  W: "M 0 10 L 2.6 0 L 5.2 8 L 7.8 0 L 10.4 10",
  X: "M 0 10 L 7 0 M 0 0 L 7 10",
  Y: "M 0 10 L 3.6 5 L 7.2 10 M 3.6 5 L 3.6 0",
  Z: "M 0 10 L 7 10 L 0 0 L 7 0",
  "0": "A 3.4 5 3.4 5 0 360",
  "1": "M 1 8 L 3.4 10 L 3.4 0",
  "2": "A 3.4 6.8 3.2 3.2 160 -40 L 0 0 L 6.8 0",
  "3": "A 3.3 7.6 2.9 2.4 150 -90 A 3.4 2.7 3.3 2.7 90 -150",
  "4": "M 5.4 0 L 5.4 10 L 0 2.8 L 7.4 2.8",
  "5": "M 6.4 10 L 1.2 10 L 0.6 5.4 A 3.4 3.3 3.4 3.3 140 -150",
  "6": "A 3.5 3.3 3.3 3.3 0 360 M 0.2 3.3 A 5.2 4.5 5 5.5 180 95",
  "7": "M 0 10 L 7 10 L 2.4 0",
  "8": "A 3.4 7.6 2.8 2.4 0 360 A 3.4 2.6 3.3 2.6 0 360",
  "9": "A 3.5 6.7 3.3 3.3 0 360 L 6.8 5.5 A 1.8 5.5 5 5.5 0 -85",
  ".": "M 0.5 0 L 0.5 0.4",
  ",": "M 0.8 0.6 L 0.8 0.2 L 0 -1.6",
  "!": "M 0.6 10 L 0.6 3 M 0.6 0.4 L 0.6 0",
  "?": "A 3 7.5 2.8 2.5 160 -60 L 3 3.4 L 3 2.6 M 3 0.4 L 3 0",
  "-": "M 0 4 L 4 4",
  "–": "M 0 4 L 6 4",
  "—": "M 0 4 L 9 4",
  "'": "M 0.5 10 L 0.5 7.5",
  "\"": "M 0.5 10 L 0.5 7.5 M 2 10 L 2 7.5",
  ":": "M 0.5 7 L 0.5 6.6 M 0.5 0.4 L 0.5 0",
  ";": "M 0.8 7 L 0.8 6.6 M 0.8 0.6 L 0.8 0.2 L 0 -1.6",
  "&": "M 7 0 L 1.4 6.6 A 2.8 8.3 1.6 1.7 210 -30 L 1.2 3.6 A 3.2 2.4 2.6 2.4 140 330 L 6.6 4.6",
  "(": "A 4 5 4 6.5 125 235",
  ")": "A 0 5 4 6.5 55 -55",
  "[": "M 3 11 L 0.5 11 L 0.5 -1 L 3 -1",
  "]": "M 0 11 L 2.5 11 L 2.5 -1 L 0 -1",
  "/": "M 0 -1 L 5 11",
  "+": "M 0 4.5 L 6 4.5 M 3 1.5 L 3 7.5",
  "*": "M 2 10 L 2 6 M 0.3 9 L 3.7 7 M 0.3 7 L 3.7 9",
  "=": "M 0 3 L 5 3 M 0 6 L 5 6",
  "_": "M 0 -1 L 6 -1",
  "#": "M 1.5 0 L 2.5 10 M 4.5 0 L 5.5 10 M 0 3.5 L 7 3.5 M 0 6.5 L 7 6.5"
};

/** A glyph: its strokes (flat x, y lists in grid units) and the width it takes up. */
export interface StrokeGlyph {
  strokes: Float32Array[];
  left: number;
  right: number;
}

/** Parses the path language into strokes. */
export function parseStrokes(path: string): Float32Array[] {
  const tokens = path.trim().split(/\s+/);
  const strokes: number[][] = [];
  let current: number[] | null = null;
  for (let at = 0; at < tokens.length;) {
    const command = tokens[at]!;
    at += 1;
    const number = (): number => Number(tokens[at++]);
    if (command === "M") {
      current = [number(), number()];
      strokes.push(current);
    } else if (command === "L") {
      const x = number();
      const y = number();
      if (!current) {
        current = [x, y];
        strokes.push(current);
      } else {
        current.push(x, y);
      }
    } else if (command === "A") {
      const cx = number();
      const cy = number();
      const rx = number();
      const ry = number();
      const a0 = number();
      const a1 = number();
      const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 15));
      const sx = cx + rx * Math.cos((a0 * Math.PI) / 180);
      const sy = cy + ry * Math.sin((a0 * Math.PI) / 180);
      const join = current !== null && Math.hypot(current[current.length - 2]! - sx, current[current.length - 1]! - sy) < 0.6;
      if (!join) {
        current = [];
        strokes.push(current);
      }
      for (let k = join ? 1 : 0; k <= steps; k += 1) {
        const angle = ((a0 + ((a1 - a0) * k) / steps) * Math.PI) / 180;
        current!.push(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle));
      }
    } else {
      throw new Error(`Unknown stroke command ${command}`);
    }
  }
  return strokes.map((points) => new Float32Array(points));
}

const parsed = new Map<string, StrokeGlyph>();

/** A character as the stroke font writes it: accents dropped, Ł/ł as L/l; null for none. */
export function strokeChar(char: string): string | null {
  if (char in GLYPHS) return char;
  const plain = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const mapped = plain === "Ł" ? "L" : plain === "ł" ? "l" : plain === "ß" ? "s" : plain;
  return mapped.length === 1 && mapped in GLYPHS ? mapped : null;
}

/** The accents a character carries, as the combining marks of its decomposition (and Ł's bar). */
export function strokeMarks(char: string): string[] {
  const marks: string[] = [...(char.normalize("NFD").match(/[\u0300-\u036f]/g) ?? [])];
  if (char === "Ł" || char === "ł") marks.push("bar");
  return marks;
}

/**
 * An accent's strokes for a glyph spanning `left`…`right`, its top at `top` (7 for small
 * letters, 10 for capitals): acute and grave, dot, two dots, circumflex, caron, ring, tilde above;
 * ogonek and cedilla below; Ł's bar across.
 */
export function markStrokes(mark: string, left: number, right: number, top: number): Float32Array[] {
  const middle = (left + right) / 2;
  const above = top + 1.6;
  switch (mark) {
    case "\u0301":
      return [new Float32Array([middle - 0.4, above, middle + 1.1, above + 1.8])];
    case "\u0300":
      return [new Float32Array([middle + 0.4, above, middle - 1.1, above + 1.8])];
    case "\u0307":
      return [new Float32Array([middle, above + 0.5, middle, above + 0.8])];
    case "\u0308":
      return [new Float32Array([middle - 1.3, above + 0.5, middle - 1.3, above + 0.8]), new Float32Array([middle + 1.3, above + 0.5, middle + 1.3, above + 0.8])];
    case "\u0302":
      return [new Float32Array([middle - 1.4, above, middle, above + 1.6, middle + 1.4, above])];
    case "\u030c":
      return [new Float32Array([middle - 1.4, above + 1.6, middle, above, middle + 1.4, above + 1.6])];
    case "\u030a": {
      const ring: number[] = [];
      for (let k = 0; k <= 12; k += 1) ring.push(middle + Math.cos((k * Math.PI) / 6) * 1, above + 1 + Math.sin((k * Math.PI) / 6) * 1);
      return [new Float32Array(ring)];
    }
    case "\u0303":
      return [new Float32Array([middle - 1.8, above + 0.4, middle - 0.9, above + 1.2, middle + 0.9, above + 0.4, middle + 1.8, above + 1.2])];
    case "\u0328":
      return [new Float32Array([right - 0.4, 0, right - 1.1, -1.2, right - 0.4, -2.1, right + 0.6, -1.9])];
    case "\u0327":
      return [new Float32Array([middle, 0, middle + 0.6, -1, middle - 0.4, -2.2])];
    case "bar":
      return [new Float32Array([left - 0.8, top === 10 ? 3.8 : 4.2, left + 2.2, top === 10 ? 6.6 : 6.4])];
    default:
      return [];
  }
}

export function strokeGlyph(char: string): StrokeGlyph | null {
  const key = strokeChar(char);
  if (!key) return null;
  let glyph = parsed.get(key);
  if (!glyph) {
    const strokes = parseStrokes(GLYPHS[key]!);
    let left = Infinity;
    let right = -Infinity;
    for (const stroke of strokes) {
      for (let k = 0; k < stroke.length; k += 2) {
        left = Math.min(left, stroke[k]!);
        right = Math.max(right, stroke[k]!);
      }
    }
    glyph = { strokes, left, right };
    parsed.set(key, glyph);
  }
  return glyph;
}

export function strokeChars(): string[] {
  return Object.keys(GLYPHS);
}

/**
 * Slab serifs for a glyph: short bars across the ends of strokes that stop on the baseline, the
 * x-height or the capital height, as a typewriter face has them.
 */
export function serifs(glyph: StrokeGlyph, size: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const stroke of glyph.strokes) {
    const count = stroke.length >> 1;
    if (count < 2) continue;
    for (const end of [0, count - 1]) {
      const x = stroke[end * 2]!;
      const y = stroke[end * 2 + 1]!;
      const near = end === 0 ? 1 : count - 2;
      const dx = stroke[near * 2]! - x;
      const dy = stroke[near * 2 + 1]! - y;
      // Only ends of upright strokes (not a slanting tail), on a line of the grid.
      if (Math.abs(dy) < Math.abs(dx) * 3) continue;
      const onLine = [0, 7, 10, -3].some((line) => Math.abs(y - line) < 0.3);
      if (!onLine) continue;
      out.push(new Float32Array([x - size, y, x + size, y]));
    }
  }
  return out;
}
