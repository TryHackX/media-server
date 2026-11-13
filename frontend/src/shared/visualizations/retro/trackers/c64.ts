import { C64 } from "./fonts-8bit";
import { rgb, sheet, Surface, type Font } from "./raster";

/**
 * A Commodore 64's text screen as a PAL monitor shows it, for the C64 music editors
 * (soundmonitor.ts, jch.ts): 384 × 272 pixels with the border, the 40 × 25 characters of 8 × 8
 * inside it from (32, 35), one background colour behind every character and a colour of its own
 * for each. A reversed character shows its colour as the cell and the background through its
 * strokes, as the C64 draws one.
 */

export const C64_WIDTH = 384;
export const C64_HEIGHT = 272;
/** Where the text screen starts inside the border, and its size in characters. */
export const SCREEN_LEFT = 32;
export const SCREEN_TOP = 35;
export const COLUMNS = 40;
export const LINES = 25;

/** The C64's colours that the editors use, as the reference screenshots show them. */
export const PALETTE = {
  black: rgb(0x000000),
  white: rgb(0xffffff),
  cyan: rgb(0x7abfc7),
  green: rgb(0x68a941),
  yellow: rgb(0xd0dc71),
  darkGrey: rgb(0x555555),
  grey: rgb(0x808080),
  lightBlue: rgb(0x7c70da),
  lightGrey: rgb(0xababab)
} as const;

export const c64Font: Font = sheet(C64.sheet, C64.cell, C64.height, C64.fixed);

/** The left and top pixel of a character cell. */
export const cellX = (column: number): number => SCREEN_LEFT + column * 8;
export const cellY = (row: number): number => SCREEN_TOP + row * 8;

export class TextScreen {
  readonly surface: Surface;
  /** The background colour ($D021): behind every character, inside every reversed one. */
  readonly background: number;

  constructor(surface: Surface, background: number) {
    this.surface = surface;
    this.background = background;
  }

  /** The border all round and the screen's background inside it. */
  clear(border: number): void {
    const s = this.surface;
    s.fill(0, 0, s.width, s.height, border);
    s.fill(SCREEN_LEFT, SCREEN_TOP, COLUMNS * 8, LINES * 8, this.background);
  }

  /** Text from a cell on, in `color`; reversed: the cells in `color`, the letters in the background. */
  put(column: number, row: number, text: string, color: number, reverse = false): void {
    const s = this.surface;
    if (reverse) {
      s.fill(cellX(column), cellY(row), [...text].length * 8, 8, color);
      s.text(c64Font, cellX(column), cellY(row), text, this.background);
    } else {
      s.text(c64Font, cellX(column), cellY(row), text, color);
    }
  }

  /**
   * A line of the box-drawing characters along a row, two pixels thick through the cells' middle:
   * from the middle of `from` (or its left edge, `open`) to the middle of `to` (or its right edge).
   * Lines that meet make the corners and junctions the characters have.
   */
  horizontal(row: number, from: number, to: number, color: number, openStart = false, openEnd = false): void {
    const x0 = openStart ? cellX(from) : cellX(from) + 3;
    const x1 = openEnd ? cellX(to) + 7 : cellX(to) + 4;
    this.surface.fill(x0, cellY(row) + 3, x1 - x0 + 1, 2, color);
  }

  /** The same down a column. */
  vertical(column: number, from: number, to: number, color: number, openStart = false, openEnd = false): void {
    const y0 = openStart ? cellY(from) : cellY(from) + 3;
    const y1 = openEnd ? cellY(to) + 7 : cellY(to) + 4;
    this.surface.fill(cellX(column) + 3, y0, 2, y1 - y0 + 1, color);
  }
}

/** Lower-case hex as the C64 editors print it in the lower-case character set. */
export function hexLower(value: number, digits: number): string {
  return (Math.max(0, Math.round(value)) >>> 0).toString(16).padStart(digits, "0").slice(-digits);
}
