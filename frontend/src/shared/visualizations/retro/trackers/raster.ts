import type { PixelImage } from "../types";

/**
 * Drawing for the tracker screens: a picture of 32-bit pixels (the RGBA bytes of a PixelImage
 * seen as words), filled, framed and lettered with the bitmap fonts of fonts.ts. Without
 * runtime imports, so the tests run it as it is (trackers.test.ts).
 */

/** A bitmap font: each glyph's rows as bits (the leftmost pixel the highest of `width`). */
export interface Font {
  /** The cell: how far a fixed font moves on per character, and how tall its glyphs are. */
  readonly width: number;
  readonly height: number;
  /** Fixed: every glyph as wide as the cell; else each as wide as its pixels, plus `spacing`. */
  readonly fixed: boolean;
  readonly spacing: number;
  readonly glyphs: ReadonlyMap<string, Glyph>;
}

export interface Glyph {
  readonly width: number;
  readonly rows: readonly number[];
}

const littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;

/** A colour as a pixel word: 0xRRGGBB to the bytes R, G, B, 255 in memory. */
export function rgb(value: number): number {
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (littleEndian ? ((255 << 24) | (b << 16) | (g << 8) | r) : ((r << 24) | (g << 16) | (b << 8) | 255)) >>> 0;
}

/** Between two 0xRRGGBB colours, `t` 0–1 of the way. */
export function mix(from: number, to: number, t: number): number {
  const part = (shift: number): number => {
    const a = (from >> shift) & 255;
    const b = (to >> shift) & 255;
    return Math.round(a + (b - a) * t) << shift;
  };
  return part(16) | part(8) | part(0);
}

/** Text as a font can show it: accents dropped (ł is l), unknown characters as spaces. */
export function printable(text: string, font: Font, upper = false): string {
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[łŁ]/g, (c) => (c === "ł" ? "l" : "L"));
  let out = "";
  for (const raw of upper ? plain.toUpperCase() : plain) {
    const char = font.glyphs.has(raw) ? raw : font.glyphs.has(raw.toUpperCase()) ? raw.toUpperCase() : " ";
    out += char;
  }
  return out;
}

export class Surface {
  readonly width: number;
  readonly height: number;
  pixels: Uint32Array;

  constructor(width: number, height: number, pixels?: Uint32Array) {
    this.width = width;
    this.height = height;
    this.pixels = pixels ?? new Uint32Array(width * height);
  }

  /** A rectangle, clipped to the picture. */
  fill(x: number, y: number, width: number, height: number, color: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + width);
    const y1 = Math.min(this.height, y + height);
    if (x1 <= x0) return;
    for (let row = y0; row < y1; row += 1) this.pixels.fill(color, row * this.width + x0, row * this.width + x1);
  }

  pixel(x: number, y: number, color: number): void {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.pixels[y * this.width + x] = color;
  }

  /**
   * A one-pixel frame: `light` along the top and left, `dark` along the bottom and right (a
   * raised panel; swapped, a sunken one). The corners where they meet take `corner`.
   */
  bevel(x: number, y: number, width: number, height: number, light: number, dark: number, corner = dark): void {
    this.fill(x, y, width, 1, light);
    this.fill(x, y, 1, height, light);
    this.fill(x, y + height - 1, width, 1, dark);
    this.fill(x + width - 1, y, 1, height, dark);
    this.pixel(x + width - 1, y, corner);
    this.pixel(x, y + height - 1, corner);
  }

  /** Part of another picture, copied as it is. */
  copy(from: Surface, sx: number, sy: number, width: number, height: number, dx: number, dy: number): void {
    for (let row = 0; row < height; row += 1) {
      const y = dy + row;
      if (y < 0 || y >= this.height) continue;
      const start = (sy + row) * from.width + sx;
      this.pixels.set(from.pixels.subarray(start, start + width), y * this.width + dx);
    }
  }

  /** A bitmap (rows of bits, the leftmost the highest of `width`), each pixel `scaleX` × `scaleY`. */
  bits(x: number, y: number, rows: readonly number[], width: number, color: number, scaleY = 1, scaleX = 1): void {
    // Wholly inside and at its own size (most text): straight into the pixels.
    if (scaleX === 1 && scaleY === 1 && x >= 0 && y >= 0 && x + width <= this.width && y + rows.length <= this.height) {
      const pixels = this.pixels;
      for (let row = 0; row < rows.length; row += 1) {
        const bits = rows[row]!;
        if (!bits) continue;
        const at = (y + row) * this.width + x;
        for (let column = 0; column < width; column += 1) if (bits & (1 << (width - 1 - column))) pixels[at + column] = color;
      }
      return;
    }
    for (let row = 0; row < rows.length; row += 1) {
      const bits = rows[row]!;
      if (!bits) continue;
      for (let column = 0; column < width; column += 1) {
        if (!(bits & (1 << (width - 1 - column)))) continue;
        if (scaleX === 1 && scaleY === 1) this.pixel(x + column, y + row, color);
        else this.fill(x + column * scaleX, y + row * scaleY, scaleX, scaleY, color);
      }
    }
  }

  /**
   * Text from (x, y), its glyphs' top-left there; `scaleY` 2 draws each row twice. Returns where
   * the next character would go. Characters the font lacks are spaces.
   */
  text(font: Font, x: number, y: number, text: string, color: number, scaleY = 1, scaleX = 1): number {
    let at = x;
    for (const char of text) {
      const glyph = font.glyphs.get(char);
      if (glyph) this.bits(at, y, glyph.rows, glyph.width, color, scaleY, scaleX);
      at += (font.fixed ? font.width : (glyph ? glyph.width : font.width) + font.spacing) * scaleX;
    }
    return at;
  }

  /** Text with a shadow one pixel right and down: the raised lettering of a panel. */
  embossed(font: Font, x: number, y: number, text: string, color: number, shadow: number): number {
    this.text(font, x + 1, y + 1, text, shadow);
    return this.text(font, x, y, text, color);
  }
}

/** How wide a text comes out in a font. */
export function measure(font: Font, text: string): number {
  if (font.fixed) return [...text].length * font.width;
  let width = 0;
  for (const char of text) {
    const glyph = font.glyphs.get(char);
    width += (glyph ? glyph.width : font.width) + font.spacing;
  }
  return Math.max(0, width - font.spacing);
}

/**
 * A font from a sheet of glyphs drawn as text: blocks of a header line (the characters, one at
 * the start of each cell of `cell` + 1 columns) and `height` lines of pixels ('#' lit, any other
 * character dark). A proportional font's glyphs are as wide as their lit pixels; a space is
 * `cell` − 2 wide (or the cell, fixed).
 */
export function sheet(text: string, cell: number, height: number, fixed: boolean, spacing = 1): Font {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const glyphs = new Map<string, Glyph>();
  for (let block = 0; block + height < lines.length; block += height + 1) {
    const header = lines[block]!;
    for (let start = 0; start < header.length; start += cell + 1) {
      const char = header[start]!;
      if (char === " ") continue;
      const rows: number[] = [];
      let used = 0;
      for (let row = 0; row < height; row += 1) {
        const line = lines[block + 1 + row] ?? "";
        let bits = 0;
        for (let column = 0; column < cell; column += 1) {
          if (line[start + column] === "#") {
            bits |= 1 << (cell - 1 - column);
            used = Math.max(used, column + 1);
          }
        }
        rows.push(bits);
      }
      const width = fixed ? cell : Math.max(1, used);
      // A proportional glyph keeps its leftmost pixels at the top bits of its own width.
      glyphs.set(char, { width, rows: fixed ? rows : rows.map((bits) => bits >> (cell - width)) });
    }
  }
  if (!glyphs.has(" ")) glyphs.set(" ", { width: fixed ? cell : Math.max(1, cell - 2), rows: new Array<number>(height).fill(0) });
  return { width: cell, height, fixed, spacing, glyphs };
}

/**
 * A PixelImage's bytes as pixel words to draw on: the bytes themselves where they can be seen
 * so, else a copy put back by `close`.
 */
export class Target {
  private data: Uint8ClampedArray | null = null;
  private words: Uint32Array | null = null;
  private copied = false;

  open(image: PixelImage): Uint32Array {
    const size = image.width * image.height;
    if (this.data !== image.data || !this.words || this.words.length !== size) {
      this.data = image.data;
      this.copied = image.data.byteOffset % 4 !== 0;
      this.words = this.copied ? new Uint32Array(size) : new Uint32Array(image.data.buffer, image.data.byteOffset, size);
    }
    return this.words;
  }

  close(image: PixelImage): void {
    if (this.copied && this.words) image.data.set(new Uint8Array(this.words.buffer, 0, image.width * image.height * 4));
  }
}
