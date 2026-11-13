import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { ARKOS_MONO, ARKOS_SANS } from "./fonts-arkos";
import { hex, noteText } from "./notation";
import { mix, rgb, Surface, Target } from "./raster";
import { emptyCell, hash, NOTE_NONE, NOTE_OFF, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * Arkos Tracker 3 (Julien Névo, 2024–2026; a tracker for the AY of the Amstrad CPC and its
 * cousins) playing a song in its main window, 1280 × 720, in its default violet theme: the title
 * and tool bars, the meters (each PSG channel's waveform over the chip's sixteen volume steps),
 * the linker (the song's positions as boxes, the one playing lit, the timeline's triangle moving
 * through it), the instrument list, the pattern viewer — line numbers, the three tracks with
 * notes coloured by instrument and four effect columns, the speed and event tracks, the play line
 * taller in the middle — and the test area's piano. Each track's header shows its channel's
 * frequencies as the program does while playing: a bar per partial on a log scale, as high as
 * the volume, noise in red.
 *
 * The module is song.ts's: the bass on the first track (a "hard" sound, the AY's hardware
 * envelope), the drums on the second, the lead on the third, a chord there as an inline arpeggio
 * (b37) when the lead rests. The PSG's output the meters draw is made from what each channel
 * plays. All text is fonts-arkos.ts's strokes, antialiased here; nothing comes from the program.
 */

const WIDTH = 1280;
const HEIGHT = 720;

/** The "Violet dawning" theme as the screenshots show it. */
const TITLE = 0x380060;
const BAR = 0x604185;
const GAP = 0x1f003a;
const PANEL = 0x380060;
const DEEP = 0x2c0052;
const NAVY = 0x202070;
const TAB = 0x533873;
const SELECTED_NAVY = 0x5f5f98;
const WHITE = 0xffffff;
const LIST_TEXT = 0xc0c0c0;
const GREY_TEXT = 0xa0a0a0;
const LINK_BORDER = 0xc4c4c4;
const LINK_LIT = 0x7979a9;
const MARKER = 0x808080;
const TIMELINE = 0x52316e;
const SCOPE_LABEL = 0x404040;
const GRID = 0x303030;
const TRACE = 0xd4d4d4;
const PARTIAL = 0xcec4d9;
const NOISE = 0xce1328;
const KEY_WHITE = 0xe0e0e0;
const KEY_BLACK = 0x101010;
const KEY_GAP = 0x404040;
const CURSOR = 0x1010ff;
/** The pattern's rows: plain, every fourth, every sixteenth, the play line. */
const ROW_PLAIN = 0x000000;
const ROW_BEAT = 0x202020;
const ROW_BAR = 0x282828;
const ROW_PLAY = 0x080840;
const LINE_NUMBER = 0xc0c0c0;
const EMPTY = 0x5f5f5f;
const EFFECT_VOLUME = 0x40ff40;
const EFFECT_PITCH = 0x5050ff;
const EFFECT_ARPEGGIO = 0x40e0e0;
const SPEED_TEXT = 0xd88a8a;

/** The instruments: name and colour (a note is written in its instrument's colour). */
const INSTRUMENTS: readonly (readonly [string, number])[] = [
  ["Silence (read-only)", 0],
  ["Bass", 0xee9090],
  ["Kick", 0xffb0b0],
  ["Snare", 0x90bbee],
  ["Hihat", 0xb0ccff],
  ["Open hihat", 0x70aadd],
  ["Lead", 0x50cc40],
  ["Chords", 0x90ee70],
  ["Echo", 0xb0ff90],
  ["Pluck", 0x70dd50],
  ["HardBass2", 0xdd7070],
  ["TomLow", 0x5099cc],
  ["Crash", 0x3088bb],
  ["Pad", 0x90ee70]
];

const SPEC: SongSpec = {
  channels: [{ parts: ["bass"] }, { parts: ["kick", "snare", "hats"] }, { parts: ["lead", "chord"] }],
  low: 12,
  high: 107,
  drums: { kick: 36, snare: 40, hats: 66 },
  floors: { bass: 24, lead: 48, chord: 48 },
  instruments: { kick: 2, snare: 3, hats: 4, bass: 1, lead: 6, chord: 7, echo: 8 },
  positions: 256,
  noteOff: true,
  seed: 3
};

/** The layout. */
const SCOPE_X = [2, 162, 322];
const SCOPE_WIDTH = 158;
const SCOPE_TOP = 53;
const SCOPE_BOTTOM = 190;
const LINK_LEFT = 496;
const LINK_STEP = 57;
const LINK_TOP = 104;
const LIST_TOP = 225;
const LIST_ROW = 30;
const PV_BOTTOM = 650;
const ROWS_TOP = 262;
const ROW_HEIGHT = 14;
const PLAY_HEIGHT = 20;
/** Rows above the play line; it sits in the middle of the viewer. */
const ABOVE = 13;
const LINE_X = 276;
const TRACK_X = [312, 564, 816];
const TRACK_WIDTH = 244;
const SPEED_X = 1068;
const EVENT_X = 1104;
const HEADER_TOP = 236;
/** The header's frequency view: 20 Hz at its left, ten octaves across. */
const FREQ_LEFT = 32;
const FREQ_WIDTH = 163;
const PIANO_X = 290;
const PIANO_TOP = 661;

/** The AY's sixteen volume steps as fractions of full scale (its DAC is logarithmic, about 3 dB a step). */
const AY_LEVELS = [0, 0.011, 0.016, 0.023, 0.034, 0.048, 0.066, 0.103, 0.125, 0.206, 0.287, 0.375, 0.5, 0.632, 0.816, 1];

const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;

/** `color` (0xRRGGBB) over a pixel word with coverage `a` (0–256). */
function over(dst: number, color: number, a: number): number {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  if (littleEndian) {
    const dr = dst & 255;
    const dg = (dst >>> 8) & 255;
    const db = (dst >>> 16) & 255;
    return ((255 << 24) | ((db + (((b - db) * a) >> 8)) << 16) | ((dg + (((g - dg) * a) >> 8)) << 8) | (dr + (((r - dr) * a) >> 8))) >>> 0;
  }
  const dr = (dst >>> 24) & 255;
  const dg = (dst >>> 16) & 255;
  const db = (dst >>> 8) & 255;
  return (((dr + (((r - dr) * a) >> 8)) << 24) | ((dg + (((g - dg) * a) >> 8)) << 16) | ((db + (((b - db) * a) >> 8)) << 8) | 255) >>> 0;
}

/** Coverage, 0–256 per pixel, of a shape at (x, y). */
interface Coverage {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint16Array;
}

/** A pen path (fonts-arkos.ts's syntax) as polylines, each a flat list of x, y. */
function parsePath(d: string): number[][] {
  const tokens = d.match(/[MLCA]|-?\d*\.?\d+/g) ?? [];
  const lines: number[][] = [];
  let line: number[] | null = null;
  let px = 0;
  let py = 0;
  let at = 0;
  const num = (): number => Number(tokens[at++]);
  const start = (x: number, y: number): void => {
    line = [x, y];
    lines.push(line);
    px = x;
    py = y;
  };
  const to = (x: number, y: number): void => {
    if (!line) start(px, py);
    line!.push(x, y);
    px = x;
    py = y;
  };
  while (at < tokens.length) {
    const command = tokens[at++];
    if (command === "M") {
      start(num(), num());
    } else if (command === "L") {
      to(num(), num());
    } else if (command === "C") {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      const x3 = num();
      const y3 = num();
      const x0 = px;
      const y0 = py;
      for (let k = 1; k <= 10; k += 1) {
        const t = k / 10;
        const u = 1 - t;
        to(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
    } else if (command === "A") {
      const cx = num();
      const cy = num();
      const rx = num();
      const ry = num();
      const from = num();
      const until = num();
      const steps = Math.max(2, Math.ceil(Math.abs(until - from) / 8));
      for (let k = 0; k <= steps; k += 1) {
        const angle = ((from + ((until - from) * k) / steps) * Math.PI) / 180;
        const x = cx + rx * Math.cos(angle);
        const y = cy + ry * Math.sin(angle);
        if (k === 0 && (!line || Math.hypot(x - px, y - py) > 0.05)) start(x, y);
        else if (k > 0) to(x, y);
      }
    }
  }
  return lines;
}

/**
 * Polylines stroked with a round pen of `radius` px, after scaling and moving them: the pixels'
 * coverage, sampled 4 × 4 where the edge passes.
 */
function strokeCoverage(lines: readonly number[][], sx: number, sy: number, radius: number, ox: number, oy: number): Coverage {
  const segments: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    const points: number[] = [];
    for (let k = 0; k + 1 < line.length; k += 2) {
      const x = ox + line[k]! * sx;
      const y = oy + line[k + 1]! * sy;
      points.push(x, y);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (points.length === 2) points.push(points[0]!, points[1]!);
    for (let k = 0; k + 3 < points.length; k += 2) segments.push(points[k]!, points[k + 1]!, points[k + 2]!, points[k + 3]!);
  }
  if (!segments.length) return { x: 0, y: 0, width: 0, height: 0, alpha: new Uint16Array(0) };
  const x0 = Math.floor(minX - radius - 1);
  const y0 = Math.floor(minY - radius - 1);
  const width = Math.ceil(maxX + radius + 1) - x0;
  const height = Math.ceil(maxY + radius + 1) - y0;
  const alpha = new Uint16Array(width * height);
  const seg = Float64Array.from(segments);
  const r2 = radius * radius;
  const nearest = (px: number, py: number): number => {
    let best = Infinity;
    for (let k = 0; k < seg.length; k += 4) {
      const ax = seg[k]!;
      const ay = seg[k + 1]!;
      const dx = seg[k + 2]! - ax;
      const dy = seg[k + 3]! - ay;
      const length = dx * dx + dy * dy;
      let t = length > 0 ? ((px - ax) * dx + (py - ay) * dy) / length : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return best;
  };
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const cx = x0 + i + 0.5;
      const cy = y0 + j + 0.5;
      const d = Math.sqrt(nearest(cx, cy));
      if (d > radius + 0.72) continue;
      if (d < radius - 0.72) {
        alpha[j * width + i] = 256;
        continue;
      }
      let count = 0;
      for (let v = 0; v < 4; v += 1) for (let u = 0; u < 4; u += 1) if (nearest(x0 + i + (u + 0.5) / 4, y0 + j + (v + 0.5) / 4) <= r2) count += 1;
      alpha[j * width + i] = count * 16;
    }
  }
  return { x: x0, y: y0, width, height, alpha };
}

/** A polygon filled (even-odd), sampled 4 × 4: the icons' solid shapes. */
function fillCoverage(points: readonly number[]): Coverage {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < points.length; k += 2) {
    minX = Math.min(minX, points[k]!);
    maxX = Math.max(maxX, points[k]!);
    minY = Math.min(minY, points[k + 1]!);
    maxY = Math.max(maxY, points[k + 1]!);
  }
  const x0 = Math.floor(minX);
  const y0 = Math.floor(minY);
  const width = Math.ceil(maxX) - x0;
  const height = Math.ceil(maxY) - y0;
  const alpha = new Uint16Array(Math.max(0, width * height));
  const inside = (px: number, py: number): boolean => {
    let odd = false;
    for (let k = 0, l = points.length - 2; k < points.length; l = k, k += 2) {
      const xi = points[k]!;
      const yi = points[k + 1]!;
      const xj = points[l]!;
      const yj = points[l + 1]!;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
  };
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      let count = 0;
      for (let v = 0; v < 4; v += 1) for (let u = 0; u < 4; u += 1) if (inside(x0 + i + (u + 0.5) / 4, y0 + j + (v + 0.5) / 4)) count += 1;
      alpha[j * width + i] = count * 16;
    }
  }
  return { x: x0, y: y0, width, height, alpha };
}

/** The row below which nothing is painted (the pattern viewer's bottom edge while its rows are drawn). */
let clipBottom = HEIGHT;

function paint(s: Surface, coverage: Coverage, x: number, y: number, color: number): void {
  const pixels = s.pixels;
  const word = rgb(color);
  const limit = Math.min(s.height, clipBottom);
  for (let j = 0; j < coverage.height; j += 1) {
    const py = y + coverage.y + j;
    if (py < 0 || py >= limit) continue;
    for (let i = 0; i < coverage.width; i += 1) {
      const a = coverage.alpha[j * coverage.width + i]!;
      if (!a) continue;
      const px = x + coverage.x + i;
      if (px < 0 || px >= s.width) continue;
      const at = py * s.width + px;
      pixels[at] = a >= 256 ? word : over(pixels[at]!, color, a);
    }
  }
}

/** A typeface of fonts-arkos.ts at a size: glyphs rasterized once, when first used. */
class Face {
  private readonly cache = new Map<string, Coverage>();
  constructor(
    private readonly pathOf: (char: string) => string | undefined,
    private readonly advanceOf: (char: string) => number,
    private readonly sx: number,
    private readonly sy: number,
    private readonly pen: number,
    private readonly dy = 0
  ) {}

  has(char: string): boolean {
    return this.pathOf(char) !== undefined;
  }

  advance(char: string): number {
    return this.advanceOf(this.has(char) ? char : " ") * this.sx;
  }

  glyph(char: string): Coverage {
    let coverage = this.cache.get(char);
    if (!coverage) {
      coverage = strokeCoverage(parsePath(this.pathOf(char) ?? ""), this.sx, this.sy, this.pen / 2, 0, this.dy);
      this.cache.set(char, coverage);
    }
    return coverage;
  }
}

/** The sans at a size: a little wider than high, as the program's face is, and spaced a little. */
function sans(scale: number, pen: number, wide = 1.02, tracking = 0.25): Face {
  return new Face((char) => ARKOS_SANS[char]?.[1], (char) => (ARKOS_SANS[char]?.[0] ?? 3.4) + tracking, scale * wide, scale, pen);
}

function mono(sx: number, sy: number, pen: number): Face {
  return new Face((char) => (char === " " ? "" : ARKOS_MONO[char]), () => 9, sx, sy, pen);
}

const ui = sans(1.08, 1.62);
const uiBold = sans(1.08, 2.15);
const label = sans(1.14, 1.7);
const small = sans(0.86, 1.4);
const big = sans(2.5, 3.9, 1.05, 0);
const pattern = mono(1, 1, 1.45);
const playLine = mono(1, 14 / 9, 2.25);

/** Text as the faces show it: accents dropped, unknown characters as spaces. */
function plain(text: string): string {
  const stripped = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[łŁ]/g, (c) => (c === "ł" ? "l" : "L"));
  let out = "";
  for (const char of stripped) out += ui.has(char) ? char : " ";
  return out;
}

function write(s: Surface, face: Face, x: number, y: number, text: string, color: number): number {
  let pen = x;
  for (const char of text) {
    if (char !== " ") paint(s, face.glyph(char), Math.round(pen), y, color);
    pen += face.advance(char);
  }
  return pen;
}

function width(face: Face, text: string): number {
  let total = 0;
  for (const char of text) total += face.advance(char);
  return total;
}

function rect(s: Surface, x: number, y: number, w: number, h: number, color: number): void {
  s.fill(x, y, w, h, rgb(color));
}

/**
 * A rectangle with round corners (which: 1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left):
 * the corners blended over what is under them, then the rest filled.
 */
function rounded(s: Surface, x: number, y: number, w: number, h: number, radius: number, color: number, which = 15): void {
  const corners: readonly [number, number, number, number, number][] = [
    [1, x, y, x + radius, y + radius],
    [2, x + w - radius, y, x + w - radius, y + radius],
    [4, x + w - radius, y + h - radius, x + w - radius, y + h - radius],
    [8, x, y + h - radius, x + radius, y + h - radius]
  ];
  for (const [bit, cx0, cy0, ccx, ccy] of corners) {
    if (!(which & bit)) continue;
    for (let j = 0; j < radius; j += 1) {
      for (let i = 0; i < radius; i += 1) {
        const px = cx0 + i;
        const py = cy0 + j;
        if (px < 0 || py < 0 || px >= s.width || py >= s.height) continue;
        let count = 0;
        for (let v = 0; v < 4; v += 1) {
          for (let u = 0; u < 4; u += 1) {
            const dx = px + (u + 0.5) / 4 - ccx;
            const dy = py + (v + 0.5) / 4 - ccy;
            if (dx * dx + dy * dy <= radius * radius) count += 1;
          }
        }
        const at = py * s.width + px;
        s.pixels[at] = over(s.pixels[at]!, color, count * 16);
      }
    }
  }
  const top = (which & 1 ? 1 : 0) | (which & 2 ? 2 : 0);
  const bottom = (which & 8 ? 1 : 0) | (which & 4 ? 2 : 0);
  const band = (from: number, rows: number, ends: number): void => {
    const left = ends & 1 ? radius : 0;
    const right = ends & 2 ? radius : 0;
    rect(s, x + left, from, w - left - right, rows, color);
  };
  band(y, radius, top);
  rect(s, x, y + radius, w, h - 2 * radius, color);
  band(y + h - radius, radius, bottom);
}

function stroke(s: Surface, d: string, x: number, y: number, scale: number, pen: number, color: number): void {
  paint(s, strokeCoverage(parsePath(d), scale, scale, pen / 2, x, y), 0, 0, color);
}

function polygon(s: Surface, points: readonly number[], color: number): void {
  paint(s, fillCoverage(points), 0, 0, color);
}

/** A button of the program: navy with round corners, its label or icon centred. */
function button(s: Surface, x: number, y: number, w: number, h: number, text = "", color = NAVY, ink = WHITE): void {
  rounded(s, x, y, w, h, 2, GAP);
  rect(s, x + 1, y + 1, w - 2, h - 2, color);
  if (text) write(s, label, Math.round(x + (w - width(label, text)) / 2), y + Math.round((h - 11) / 2), text, ink);
}

/** A sunken field: the deep violet with a light edge. */
function field(s: Surface, x: number, y: number, w: number, h: number): void {
  rect(s, x, y, w, h, BAR);
  rect(s, x + 1, y + 1, w - 2, h - 2, DEEP);
}

/** The frequency of a note (0 is C-0, 57 A-4). */
function frequency(note: number): number {
  return 440 * Math.pow(2, (note - 57) / 12);
}

function drawIcons(s: Surface): void {
  // Transport: play the song from its start, play it, the pattern from its start, the pattern, stop.
  rect(s, 264, 33, 2, 11, WHITE);
  polygon(s, [268, 33, 276, 38.5, 268, 44], WHITE);
  polygon(s, [296, 33, 304, 38.5, 296, 44], WHITE);
  rect(s, 327, 33, 12, 2, WHITE);
  polygon(s, [327, 37, 339, 37, 333, 43.5], WHITE);
  polygon(s, [359, 35, 372, 35, 365.5, 42.5], WHITE);
  rect(s, 393, 33, 12, 12, WHITE);
  // The MIDI link button: a note, a dotted lead, a socket.
  stroke(s, "M0 9 L0 1 M0 9 A-1.4 9 1.4 1.1 0 360", 903, 31, 1, 1.3, WHITE);
  for (let x = 906; x < 915; x += 2) s.pixel(x, 39, rgb(WHITE));
  stroke(s, "M2 0 L13 0 A13 2.5 2.5 2.5 -90 90 L2 5 A2 2.5 2.5 2.5 90 270", 913.5, 35.5, 1, 1.1, WHITE);
  for (let x = 916; x < 927; x += 2) {
    s.pixel(x, 37, rgb(0xb8b8d8));
    s.pixel(x + 1, 39, rgb(0xb8b8d8));
  }
  // The window's buttons.
  rect(s, 1196, 17, 12, 1, WHITE);
  stroke(s, "M0 0 L11 0 L11 10 L0 10 L0 0 M0 1 L11 1", 1227.5, 7.5, 1, 1, WHITE);
  stroke(s, "M0 0 L10 10 M10 0 L0 10", 1258.5, 7.5, 1, 1.1, WHITE);
  // The pattern viewer's: record, follow, steps.
  stroke(s, "M0 0 L0 0", 289.5, 213.5, 1, 9, WHITE);
  rect(s, 324, 206, 11, 2, WHITE);
  rect(s, 324, 209, 11, 1, WHITE);
  polygon(s, [325, 212, 334, 212, 329.5, 217.5], WHITE);
  stroke(s, "M0 0 L7 0 M0 3 L7 3 M0 6 L7 6 M0 9 L7 9", 391.5, 207.5, 1, 1, WHITE);
  stroke(s, "M-4 0 L-4 9 M-6 7 L-4 9.5 L-2 7", 391.5, 207.5, 1, 1.1, WHITE);
  // A keyboard, and the columns.
  rect(s, 529, 207, 13, 10, WHITE);
  for (const x of [531, 534, 537, 540]) rect(s, x, 207, 1, 6, NAVY);
  for (const x of [560, 563, 566, 569, 572]) rect(s, x, 205, 1, 15, WHITE);
  // The effect drop-down's arrow, the lock (dimmed: nothing to lock).
  polygon(s, [756, 209, 766, 209, 761, 216], WHITE);
  stroke(s, "M0 8 L0 4 A3 4 3 3 180 360 L6 2.5 M-2 8 L8 8 L8 15 L-2 15 L-2 8", 786.5, 204.5, 1, 1, 0x7a64a0);
}

/** The window as it stands, without what the song changes. */
function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  rect(s, 0, 0, WIDTH, HEIGHT, PANEL);
  // The title bar and the tool bar.
  rect(s, 0, 0, WIDTH, 26, TITLE);
  rect(s, 0, 26, WIDTH, 25, BAR);
  rect(s, 0, 51, WIDTH, 1, GAP);
  for (const [menu, at] of [["File", 12], ["Edit", 61], ["Tools", 111], ["Help", 172]] as const) write(s, ui, at, 33, menu, WHITE);
  for (const at of [253, 286, 319, 352, 385]) button(s, at, 28, 28, 21);
  write(s, ui, 452, 33, "Octave", WHITE);
  field(s, 510, 28, 25, 21);
  write(s, ui, 518, 33, "3", WHITE);
  button(s, 538, 28, 18, 21);
  button(s, 557, 28, 18, 21);
  rect(s, 542, 38, 10, 1, WHITE);
  rect(s, 561, 38, 10, 1, WHITE);
  rect(s, 566, 33, 1, 11, WHITE);
  write(s, ui, 610, 33, "Speed", WHITE);
  write(s, ui, 661, 33, "6", GREY_TEXT);
  ["1", "2", "3", "4"].forEach((subsong, index) => button(s, 733 + index * 33, 28, 28, 21, subsong, index === 0 ? SELECTED_NAVY : NAVY));
  button(s, 895, 28, 38, 21);
  // The meters: three scopes on black, the chip's volume steps as faint lines.
  rect(s, 0, 52, 484, 143, GAP);
  rect(s, 1, 52, 480, 140, BAR);
  rect(s, 2, SCOPE_TOP, 478, SCOPE_BOTTOM - SCOPE_TOP + 1, 0x000000);
  rect(s, 160, SCOPE_TOP, 2, SCOPE_BOTTOM - SCOPE_TOP + 1, DEEP);
  rect(s, 320, SCOPE_TOP, 2, SCOPE_BOTTOM - SCOPE_TOP + 1, DEEP);
  for (let level = 1; level < 15; level += 1) {
    const y = SCOPE_BOTTOM + 0.5 - AY_LEVELS[level]! * (SCOPE_BOTTOM - SCOPE_TOP - 1);
    const row = Math.floor(y);
    const share = y - row;
    for (const left of SCOPE_X) {
      for (let i = 0; i < SCOPE_WIDTH; i += 1) {
        s.pixel(left + i, row, over(rgb(0), GRID, Math.round((1 - share) * 256)));
        s.pixel(left + i, row + 1, over(rgb(0), GRID, Math.round(share * 256)));
      }
    }
  }
  // The linker.
  rect(s, 484, 52, WIDTH - 484, 140, BAR);
  rect(s, 485, 53, WIDTH - 486, 138, DEEP);
  for (let y = 60; y < 100; y += 4) rect(s, 495, y, 1, 2, 0x8a76a0);
  write(s, small, 499, 60, "Start", WHITE);
  for (let xx = 495; xx < WIDTH - 2; xx += 8) rect(s, xx, 158, 4, 2, TIMELINE);
  rect(s, 0, 192, WIDTH, 3, GAP);
  // The instrument list and its tabs.
  rect(s, 0, 195, 263, PV_BOTTOM - 195, GAP);
  rect(s, 1, 195, 259, PV_BOTTOM - 195, BAR);
  rect(s, 2, 225, 257, PV_BOTTOM - 225, DEEP);
  rect(s, 2, 195, 30, 30, BAR);
  rect(s, 32, 195, 60, 30, GAP);
  rect(s, 92, 195, 47, 30, GAP);
  rect(s, 139, 195, 30, 30, BAR);
  rect(s, 169, 195, 90, 30, GAP);
  drawTabIcons(s);
  INSTRUMENTS.forEach(([name, color], index) => {
    const y = LIST_TOP + index * LIST_ROW;
    if (y + LIST_ROW > PV_BOTTOM - 4) return;
    rect(s, 2, y, 246, LIST_ROW, index === 1 ? BAR : index % 2 ? PANEL : DEEP);
    if (index === 1) rect(s, 2, y, 2, LIST_ROW, 0xa995c0);
    stroke(s, "M0 13 L0 0 L5 0 L5 13 L10 13 L10 0 L15 0", 14.5, y + 8.5, 1, 1.25, WHITE);
    write(s, ui, 42, y + 9, `${hex(index, 2)}: ${name}`, index === 1 ? WHITE : LIST_TEXT);
    if (color) {
      rect(s, 225, y + 7, 16, 16, 0x8c8c8c);
      rect(s, 226, y + 8, 14, 14, color);
    }
  });
  rounded(s, 249, 228, 9, 200, 4, BAR);
  button(s, 187, PV_BOTTOM - 30, 39, 24);
  rect(s, 199, PV_BOTTOM - 19, 15, 1, WHITE);
  rect(s, 206, PV_BOTTOM - 26, 1, 15, WHITE);
  // The pattern viewer: its tool bar, the headers, the columns' rows drawn with the song.
  rect(s, 262, 195, WIDTH - 262, PV_BOTTOM - 195, GAP);
  rect(s, 263, 195, WIDTH - 264, PV_BOTTOM - 195, BAR);
  rect(s, 264, 196, WIDTH - 266, PV_BOTTOM - 197, PANEL);
  button(s, 276, 202, 28, 23);
  button(s, 316, 202, 28, 23);
  field(s, 416, 202, 32, 23);
  write(s, ui, 429, 208, "1", WHITE);
  button(s, 452, 202, 18, 23);
  button(s, 471, 202, 18, 23);
  rect(s, 456, 213, 10, 1, WHITE);
  rect(s, 475, 213, 10, 1, WHITE);
  rect(s, 480, 208, 1, 11, WHITE);
  button(s, 521, 202, 28, 23);
  button(s, 553, 202, 28, 23);
  field(s, 613, 202, 158, 23);
  write(s, ui, 621, 208, "(no selected effect)", WHITE);
  button(s, 775, 202, 28, 23);
  field(s, 835, 202, WIDTH - 850, 23);
  write(s, ui, 843, 208, "Column for an effect number", WHITE);
  drawIcons(s);
  // Headers: the position's height, the three tracks (number, frequencies, transposition), speed, event.
  rounded(s, LINE_X, HEADER_TOP, 28, 26, 5, BAR, 3);
  write(s, uiBold, LINE_X + 6, HEADER_TOP + 9, "40", WHITE);
  TRACK_X.forEach((left, index) => {
    rounded(s, left - 1, HEADER_TOP, 30, 26, 5, TAB, 1);
    write(s, uiBold, left + 10, HEADER_TOP + 9, String(index + 1), WHITE);
    rounded(s, left + 32, HEADER_TOP, TRACK_WIDTH - 32, 26, 5, BAR, 2);
    rect(s, left + 195, HEADER_TOP + 2, 39, 22, GAP);
    rect(s, left + 196, HEADER_TOP + 3, 37, 20, NAVY);
    write(s, label, left + 205, HEADER_TOP + 7, "+0", 0xd8d8e8);
  });
  rounded(s, SPEED_X - 1, HEADER_TOP, 29, 26, 5, BAR, 3);
  polygon(s, [SPEED_X + 8, 243, SPEED_X + 14, 248.5, SPEED_X + 8, 254], WHITE);
  polygon(s, [SPEED_X + 14, 243, SPEED_X + 20, 248.5, SPEED_X + 14, 254], WHITE);
  rounded(s, EVENT_X - 1, HEADER_TOP, 29, 26, 5, BAR, 3);
  stroke(s, "M0 3 L0 0 L3 0 M8 0 L11 0 L11 3 M11 8 L11 11 L8 11 M3 11 L0 11 L0 8 M0 0 L3 3 M11 0 L8 3 M11 11 L8 8 M0 11 L3 8", EVENT_X + 8.5, 243.5, 1, 1.1, WHITE);
  rect(s, LINE_X, ROWS_TOP, 28, PV_BOTTOM - 2 - ROWS_TOP, 0);
  for (const left of TRACK_X) rect(s, left, ROWS_TOP, TRACK_WIDTH, PV_BOTTOM - 2 - ROWS_TOP, 0);
  rect(s, SPEED_X, ROWS_TOP, 28, PV_BOTTOM - 2 - ROWS_TOP, 0);
  rect(s, EVENT_X, ROWS_TOP, 28, PV_BOTTOM - 2 - ROWS_TOP, 0);
  rounded(s, WIDTH - 14, 344, 8, 22, 4, BAR);
  // The test area: its buttons and the piano.
  rect(s, 0, PV_BOTTOM, WIDTH, 3, GAP);
  rect(s, 1, PV_BOTTOM + 3, WIDTH - 2, HEIGHT - PV_BOTTOM - 4, BAR);
  rect(s, 2, PV_BOTTOM + 4, WIDTH - 4, HEIGHT - PV_BOTTOM - 6, DEEP);
  button(s, 13, 677, 28, 23);
  button(s, 48, 677, 28, 23);
  stroke(s, "M0 12.5 L4 12.5 L4 0.5 L8 0.5", 22.5, 682.5, 1, 1.4, WHITE);
  stroke(s, "M1.5 0.8 C6.0 0.0 7.0 4.0 3.6 6.3 C0.4 8.4 1.2 13.0 5.8 12.4", 57.5, 682.5, 1, 1.4, WHITE);
  button(s, 98, 677, 58, 23, "Play!", NAVY, LIST_TEXT);
  button(s, 178, 677, 58, 23, "Mono", NAVY, LIST_TEXT);
  button(s, 240, 677, 28, 23);
  stroke(s, "M1.5 14.5 L8 8", 246, 680, 1, 3, WHITE);
  stroke(s, "A11.2 5.2 3.4 3.4 10 280", 246, 680, 1, 2.6, WHITE);
  rect(s, PIANO_X - 1, PIANO_TOP, WIDTH - 10 - PIANO_X, 56, KEY_GAP);
  for (let key = 0; key * 20 + PIANO_X + 18 <= WIDTH - 10; key += 1) {
    const left = PIANO_X + key * 20;
    rect(s, left, PIANO_TOP, 18, 56, KEY_WHITE);
    if (key % 7 === 0) write(s, small, left + 4, PIANO_TOP + 44, String(key / 7), 0x8c8c8c);
  }
  for (let octave = 0; PIANO_X + octave * 140 < WIDTH - 10; octave += 1) {
    for (const offset of [13, 33, 73, 93, 113]) {
      const left = PIANO_X + octave * 140 + offset;
      if (left + 13 <= WIDTH - 10) rect(s, left, PIANO_TOP, 13, 33, KEY_BLACK);
    }
  }
  return s;
}

function drawTabIcons(s: Surface): void {
  // The left tabs: the instrument list (keys beside a dotted rule), the arpeggios (a step), the
  // pitches (a curve); the right ones: instruments (notes), their list, arpeggio, pitch editors.
  const dots = (x: number): void => {
    for (let y = 203; y < 219; y += 2) s.pixel(x, y, rgb(0xd8d0e0));
  };
  dots(13);
  rect(s, 15, 202, 7, 16, WHITE);
  for (let y = 204; y < 217; y += 3) rect(s, 18, y, 4, 1, BAR);
  dots(42);
  stroke(s, "M0 10.5 L3.5 10.5 L3.5 0.5 L7 0.5", 43.5, 203.5, 1, 1.3, WHITE);
  dots(72);
  stroke(s, "M1.5 0.8 C5.5 0.0 6.5 3.4 3.4 5.4 C0.6 7.2 1.2 11.2 5.2 10.6", 73.5, 203.5, 1, 1.3, WHITE);
  // Two beamed notes.
  polygon(s, [149.5, 203, 158.5, 201.5, 158.5, 203.5, 149.5, 205], WHITE);
  rect(s, 149, 203, 2, 13, WHITE);
  rect(s, 157, 202, 2, 13, WHITE);
  stroke(s, "M0 0 L0.6 0", 147.6, 215.5, 1, 3.4, WHITE);
  stroke(s, "M0 0 L0.6 0", 155.6, 214.5, 1, 3.4, WHITE);
  rect(s, 177, 202, 11, 16, WHITE);
  for (let y = 204; y < 217; y += 3) rect(s, 182, y, 6, 1, GAP);
  stroke(s, "M0 10.5 L3.5 10.5 L3.5 0.5 L7 0.5", 205.5, 203.5, 1, 1.3, WHITE);
  stroke(s, "M1.5 0.8 C5.5 0.0 6.5 3.4 3.4 5.4 C0.6 7.2 1.2 11.2 5.2 10.6", 236.5, 203.5, 1, 1.3, WHITE);
}

/** Text over a row as the viewer colours it: brighter on the beat rows, softer on the play line. */
function shade(color: number, row: number, playing: boolean): number {
  if (playing) return mix(color, 0xcdcdcd, 0.4);
  if (row % 16 === 0) return mix(color, 0xffffff, 0.39);
  if (row % 4 === 0) return mix(color, 0xbebebe, 0.4);
  return color;
}

/** The meters' picture of a channel: the PSG's output, one sample a column. */
interface Voice {
  /** "square", "envelope" (a hardware saw), "noise" or "silent"; its frequency, its volume step 0–15. */
  kind: "square" | "envelope" | "noise" | "silent";
  frequency: number;
  volume: number;
}

export function createArkosTracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const earlier = emptyCell();
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let shownTitle: string | null = null;
  let shownPosition = -1;
  let shownLength = -1;
  let shownRow = -1;
  let screen: Surface | null = null;
  let clock = 0;
  const voices: Voice[] = [0, 1, 2].map(() => ({ kind: "silent", frequency: 0, volume: 0 }));

  /** The volume a track's last note before `row` was given (−1: none in this pattern). */
  const volumeBefore = (channel: number, row: number): number => {
    for (let back = row - 1; back >= 0; back -= 1) {
      song.cell(channel, back, earlier);
      if (earlier.note >= 0 && earlier.note !== NOTE_OFF) return earlier.volume;
    }
    return -1;
  };

  /**
   * A cell's effects in the program's letters (up to four), each with its colour. An arpeggio or a
   * volume slide goes on by itself in this tracker, so it is written where it starts, not again.
   */
  const effects = (channel: number, row: number, c: Cell): [string, number][] => {
    const out: [string, number][] = [];
    const p = c.param & 255;
    if (c.note === NOTE_NONE && (c.effect === "arpeggio" || c.effect === "volumeSlide") && row > 0) {
      song.cell(channel, row - 1, earlier);
      if (earlier.effect === c.effect) return out;
    }
    switch (c.effect) {
      case "arpeggio": out.push([`b${hex(p, 2)}-`, EFFECT_ARPEGGIO]); break;
      case "vibrato": out.push([`p${hex(1 + ((p & 15) % 3), 2)}-`, EFFECT_PITCH]); break;
      case "tonePorta": out.push([`g${hex(p << 4, 3)}`, EFFECT_PITCH]); break;
      case "slideUp": out.push([`u${hex(p << 2, 3)}`, EFFECT_PITCH]); break;
      case "slideDown": out.push([`d${hex(p << 2, 3)}`, EFFECT_PITCH]); break;
      case "volumeSlide": out.push([`o${hex(Math.max(1, p & 15) << 4, 3)}`, EFFECT_VOLUME]); break;
      default: break;
    }
    // The volume stays until changed: written where a note's differs from the one before.
    if (c.note >= 0 && c.note !== NOTE_OFF && c.volume >= 0 && channel !== 1) {
      const before = volumeBefore(channel, row);
      if (c.volume !== before && (before >= 0 || c.volume < 60)) out.push([`v${hex(Math.min(15, Math.round((c.volume * 15) / 64)), 1)}--`, EFFECT_VOLUME]);
    }
    return out;
  };

  /** The speed track: a new speed where the song's tempo changes (frames a line at 50 Hz). */
  const speedAt = (row: number): string => {
    for (let channel = 0; channel < 3; channel += 1) {
      song.cell(channel, row, cell);
      if (cell.effect === "speed") return hex(Math.max(1, cell.param), 2);
      if (cell.effect === "tempo") return hex(Math.max(1, Math.min(255, Math.round(750 / cell.param))), 2);
    }
    return "";
  };

  const drawTrackCell = (s: Surface, channel: number, row: number, y: number, playing: boolean): void => {
    const face = playing ? playLine : pattern;
    const top = y + (playing ? 3 : 2);
    song.cell(channel, row, cell);
    const x = TRACK_X[channel]! + 4;
    const dash = shade(EMPTY, row, playing);
    if (cell.note === NOTE_OFF) {
      write(s, face, x, top, "RST", shade(LINE_NUMBER, row, playing));
    } else if (cell.note !== NOTE_NONE) {
      const color = shade(INSTRUMENTS[cell.instrument]?.[1] ?? LINE_NUMBER, row, playing);
      write(s, face, x, top, noteText(cell.note), color);
      if (cell.instrument) write(s, face, x + 36, top, hex(cell.instrument, 2), color);
    } else {
      write(s, face, x, top, "---", dash);
    }
    const list = effects(channel, row, cell);
    for (let column = 0; column < 4; column += 1) {
      const at = x + 63 + column * 45;
      const effect = list[column];
      if (!effect) {
        write(s, face, at, top, "----", dash);
        continue;
      }
      const [text, tint] = effect;
      const color = shade(tint, row, playing);
      // The digits an effect does not use are dashes, dimmer.
      const used = text.replace(/-+$/, "");
      write(s, face, at, top, used, color);
      write(s, face, at + used.length * 9, top, "-".repeat(4 - used.length), shade(0x474747, row, playing));
    }
  };

  const drawPattern = (s: Surface): void => {
    s.copy(chrome, LINE_X, ROWS_TOP, EVENT_X + 28 - LINE_X, PV_BOTTOM - 2 - ROWS_TOP, LINE_X, ROWS_TOP);
    clipBottom = PV_BOTTOM - 2;
    const current = song.row;
    let y = ROWS_TOP;
    for (let line = -ABOVE; y < PV_BOTTOM - 2; line += 1) {
      const playing = line === 0;
      const height = playing ? PLAY_HEIGHT : ROW_HEIGHT;
      const row = current + line;
      const bottom = Math.min(PV_BOTTOM - 2, y + height);
      if (row >= 0 && row < ROWS) {
        const band = playing ? ROW_PLAY : row % 16 === 0 ? ROW_BAR : row % 4 === 0 ? ROW_BEAT : ROW_PLAIN;
        rect(s, LINE_X, y, 28, bottom - y, band);
        for (const left of TRACK_X) rect(s, left, y, TRACK_WIDTH, bottom - y, band);
        rect(s, SPEED_X, y, 28, bottom - y, band);
        rect(s, EVENT_X, y, 28, bottom - y, band);
        const top = y + (playing ? 3 : 2);
        const face = playing ? playLine : pattern;
        write(s, face, LINE_X + 4, top, hex(row, 2), shade(LINE_NUMBER, row, playing));
        for (let channel = 0; channel < 3; channel += 1) drawTrackCell(s, channel, row, y, playing);
        const speed = speedAt(row);
        if (speed) write(s, face, SPEED_X + 4, top, speed, shade(SPEED_TEXT, row, playing));
        if (playing) {
          // The edit cursor, in the first track's second effect.
          rect(s, TRACK_X[0]! + 4 + 63 + 45 + 9 + 1, y + 2, 7, 16, CURSOR);
        }
      }
      y += height;
    }
    clipBottom = HEIGHT;
  };

  /** The linker: positions around the one playing, its box lit; the timeline under it. */
  const drawLinker = (s: Surface, length: number): void => {
    s.copy(chrome, 485, 86, WIDTH - 487, 104, 485, 86);
    const position = song.position;
    const first = Math.max(0, position - 9);
    for (let index = 0; ; index += 1) {
      const at = first + index;
      const left = LINK_LEFT + index * LINK_STEP;
      if (left + 43 > WIDTH - 3 || at >= length) break;
      const number = hex(at, 1 + (at > 15 ? 1 : 0));
      write(s, small, Math.round(left + 21.5 - width(small, number) / 2), 92, number, WHITE);
      const playing = at === position;
      if (playing) {
        rect(s, left - 1, LINK_TOP - 1, 45, 45, LINK_BORDER);
        rect(s, left + 2, LINK_TOP + 2, 39, 39, LINK_LIT);
      } else {
        rect(s, left - 1, LINK_TOP - 1, 45, 45, LINK_BORDER);
        rect(s, left, LINK_TOP, 43, 43, NAVY);
      }
      const digits = song.patternAt(at).toString(16);
      write(s, big, Math.round(left + 21.5 - width(big, digits) / 2), LINK_TOP + 8, digits, WHITE);
      rect(s, left + 2, LINK_TOP + 30, 9, 9, 0x262626);
      rect(s, left + 3, LINK_TOP + 31, 7, 7, MARKER);
      if (playing) {
        // The timeline: the position's span, the triangle where the pattern has got to.
        rect(s, left, 158, LINK_STEP, 2, LINK_BORDER);
        rect(s, left, 154, 2, 10, LINK_BORDER);
        rect(s, left + LINK_STEP - 2, 154, 2, 10, LINK_BORDER);
        const tip = left + 4 + Math.round((song.row / ROWS) * (LINK_STEP - 14));
        polygon(s, [tip, 153.5, tip + 8, 159, tip, 164.5], LINK_BORDER);
      }
    }
    // The scroll bar: the part of the song in view.
    const shown = Math.max(1, Math.min(length, 13));
    const span = WIDTH - 490;
    const thumb = Math.max(40, Math.round((span * shown) / Math.max(length, shown)));
    const offset = Math.round(((span - thumb) * first) / Math.max(1, length - shown));
    rect(s, 485, 180, WIDTH - 487, 10, 0x2c0052);
    rounded(s, 486 + Math.max(0, Math.min(span - thumb, offset)), 180, thumb, 10, 5, BAR);
  };

  const drawTitle = (s: Surface, title: string): void => {
    s.copy(chrome, 0, 0, 1180, 26, 0, 0);
    const name = plain((title.split(/\s[—–-]\s/)[0] ?? "").replace(/\s+/g, " ").trim());
    write(s, ui, 12, 6, name ? `Arkos Tracker - ${name}` : "Arkos Tracker", WHITE);
  };

  /** What each channel's PSG voice is doing now, from the part it plays. */
  const listen = (): void => {
    for (let channel = 0; channel < 3; channel += 1) {
      const voice = voices[channel]!;
      const part = song.partOf(channel);
      const level = song.level(channel);
      const note = song.noteOf(channel);
      const volume = level < 0.02 ? 0 : Math.max(1, Math.min(15, Math.round(15 + 2.2 * Math.log2(level))));
      voice.volume = volume;
      if (!volume || part === null || note < 0 || note === NOTE_OFF) {
        voice.kind = "silent";
        continue;
      }
      if (part === "bass") {
        voice.kind = "envelope";
        voice.frequency = frequency(note);
      } else if (part === "kick") {
        // A kick's tone falls as it dies away.
        voice.kind = "square";
        voice.frequency = 50 + 110 * level;
      } else if (part === "snare" || part === "hats") {
        voice.kind = "noise";
        voice.frequency = part === "hats" ? 9000 : 4500;
      } else if (part === "chord") {
        // The inline arpeggio: root, third, fifth, a step every 50 Hz frame.
        const step = Math.floor(clock * 50) % 3;
        song.cell(channel, song.row, cell);
        voice.kind = "square";
        voice.frequency = frequency(note + [0, 3 + ((cell.param >> 4) === 4 ? 1 : 0), 7][step]!);
      } else {
        voice.kind = "square";
        voice.frequency = frequency(note);
      }
    }
  };

  /** One sample of a voice, 0–1 of full scale, at time t (s). */
  const sample = (voice: Voice, t: number, channel: number): number => {
    const amplitude = AY_LEVELS[voice.volume]!;
    switch (voice.kind) {
      case "square": return (t * voice.frequency) % 1 < 0.5 ? amplitude : 0;
      case "envelope": {
        // The AY's saw down: sixteen steps from the top, over and over.
        const phase = (t * voice.frequency) % 1;
        return AY_LEVELS[15 - Math.min(15, Math.floor(phase * 16))]!;
      }
      case "noise": return hash(Math.floor(t * voice.frequency), channel, 7) & 1 ? amplitude : 0;
      default: return 0;
    }
  };

  const drawScopes = (s: Surface): void => {
    const trace = rgb(TRACE);
    const span = SCOPE_BOTTOM - SCOPE_TOP - 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const voice = voices[channel]!;
      const left = SCOPE_X[channel]!;
      let last = -1;
      for (let i = 0; i < SCOPE_WIDTH; i += 1) {
        const t = clock + (i * 0.026) / SCOPE_WIDTH;
        const y = SCOPE_BOTTOM - Math.round(sample(voice, t, channel) * span);
        if (last < 0) last = y;
        const from = Math.min(y, last);
        const to = Math.max(y, last);
        for (let yy = from; yy <= to; yy += 1) s.pixels[yy * WIDTH + left + i] = trace;
        last = y;
      }
      // The channel's number, over its trace.
      rect(s, left + 134, 58, 19, 20, SCOPE_LABEL);
      write(s, ui, left + 140, 63, String(channel + 1), WHITE);
    }
  };

  /** Each header's frequencies: a bar a partial, as high as its volume; noise in red. */
  const drawFrequencies = (s: Surface): void => {
    for (let channel = 0; channel < 3; channel += 1) {
      const voice = voices[channel]!;
      const left = TRACK_X[channel]! + FREQ_LEFT;
      const bar = (f: number, height: number, color: number): void => {
        if (f < 20 || height < 1) return;
        const x = Math.round(left + (FREQ_WIDTH * Math.log2(f / 20)) / 10);
        if (x < left + 1 || x > left + FREQ_WIDTH - 3) return;
        const h = Math.min(16, Math.round(height));
        rect(s, x - 1, HEADER_TOP + 21 - h, 3, h, color);
      };
      if (voice.kind === "silent") continue;
      const full = (16 * voice.volume) / 15;
      if (voice.kind === "square") {
        for (const harmonic of [1, 3, 5, 7]) bar(voice.frequency * harmonic, full / harmonic, PARTIAL);
      } else if (voice.kind === "envelope") {
        for (const harmonic of [1, 2, 3, 4]) bar(voice.frequency * harmonic, 16 / harmonic, PARTIAL);
      } else {
        bar(voice.frequency, full, NOISE);
        bar(voice.frequency * 0.55, full * 0.4, NOISE);
      }
    }
  };

  const drawTime = (s: Surface, frame: RetroFrame): void => {
    const time = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    const total = frame.track.duration > 0 ? frame.track.duration : song.time;
    write(s, ui, 977, 33, `${time(song.time)}/${time(total)}`, WHITE);
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      song.update(frame.audio, frame.track, frame.dt);
      clock += frame.dt;
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) screen = new Surface(WIDTH, HEIGHT, pixels);
      const length = song.length(frame.track.duration);
      if (song.changes !== drawn) {
        drawn = song.changes;
        drawPattern(base);
      }
      if (song.position !== shownPosition || length !== shownLength || song.row !== shownRow) {
        shownPosition = song.position;
        shownLength = length;
        shownRow = song.row;
        drawLinker(base, length);
      }
      if (frame.track.title !== shownTitle) {
        shownTitle = frame.track.title;
        drawTitle(base, frame.track.title);
      }
      pixels.set(base.pixels);
      listen();
      drawScopes(screen);
      drawFrequencies(screen);
      drawTime(screen, frame);
      target.close(image);
    }
  };
}
