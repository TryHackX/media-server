/**
 * A Windows font on the viewer's own machine, found and drawn the way GDI drew text on a 256-colour
 * DirectDraw surface: no font file ships with the app (Windows' fonts may not), so a scene that
 * wrote with one — Cthugha-4-Winamp's title in Arial, Courier New or Times New Roman — uses it only
 * where the browser has it locally, and its own stroke faces (lettering.ts) elsewhere.
 *
 * Found by measuring, since a browser does not say which font it drew with: a font name it does not
 * know falls back to another face, and Android answers "Arial" with Roboto. The font counts as
 * there when the width of a sample text and the height of a capital H, drawn large, are the real
 * font's (from its metrics; Liberation and other metric twins share the widths but not the
 * capital). Drawn as GDI drew on 8 bits: without smoothing (a pixel is the text where at least half
 * of it is), each character at GDI's pen position, the baseline at GDI's ascent.
 */

/** What identifies a font: a sample's width and a capital H's height, in thousandths of the em. */
export interface FontPrint {
  family: string;
  sample: string;
  /** The sample's advance width (its characters' advances summed). */
  width: number;
  /** The top of "H" above the baseline. */
  cap: number;
  /** A generic family unlike it, to fall back on when it is missing. */
  fallback: "serif" | "sans-serif" | "monospace";
}

const SAMPLE = "Hamburgefontsiv WM 0.9";

/** The three TrueType faces of Windows 3.1 onwards; the widths are Helvetica's, Times', Courier's (the fonts were made to match them). */
export const WINDOWS_FONTS: Readonly<Record<"Arial" | "Times New Roman" | "Courier New", FontPrint>> = {
  // H 722 a 556 m 833 b 556 u 556 r 333 g 556 e 556 f 278 o 556 n 556 t 278 s 500 i 222 v 500, space 278,
  // W 944 M 833, space 278, 0 556 . 278 9 556; the H 1467 / 2048 of the em.
  "Arial": { family: "Arial", sample: SAMPLE, width: 11281, cap: 716, fallback: "monospace" },
  // H 722 a 444 m 778 b 500 u 500 r 333 g 500 e 444 f 333 o 500 n 500 t 278 s 389 i 278 v 500, space 250,
  // W 944 M 889, space 250, 0 500 . 250 9 500; the H 1356 / 2048.
  "Times New Roman": { family: "Times New Roman", sample: SAMPLE, width: 10582, cap: 662, fallback: "monospace" },
  // 22 characters of 600; the H 1170 / 2048.
  "Courier New": { family: "Courier New", sample: SAMPLE, width: 13200, cap: 571, fallback: "serif" }
};

/** How far a measurement may stray from the print: the width a little (rounding), the H more (outline vs hinting). */
const WIDTH_TOLERANCE = 0.006;
const CAP_TOLERANCE = 0.025;
/** The size the sample is measured at, in CSS pixels. */
const PROBE_PX = 200;

/** A measurement of `font` (a CSS font): the sample's width and the H's height, in pixels. */
export type Measure = (font: string, text: string) => { width: number; ascent: number };

/** Whether a measurement at `px` pixels is the print's font. */
export function matchesPrint(print: FontPrint, width: number, cap: number, px = PROBE_PX): boolean {
  const expectedWidth = (print.width / 1000) * px;
  const expectedCap = (print.cap / 1000) * px;
  return Math.abs(width - expectedWidth) <= expectedWidth * WIDTH_TOLERANCE && Math.abs(cap - expectedCap) <= expectedCap * CAP_TOLERANCE;
}

/** The CSS font the print is measured or drawn in: the family, then a generic family unlike it. */
export function cssFont(print: FontPrint, px: number): string {
  return `${px}px "${print.family}", ${print.fallback}`;
}

/** Whether `print`'s font is the one `measure` draws with. */
export function findFont(print: FontPrint, measure: Measure): boolean {
  const font = cssFont(print, PROBE_PX);
  const sample = measure(font, print.sample);
  const capital = measure(font, "H");
  return matchesPrint(print, sample.width, capital.ascent);
}

const found = new Map<string, boolean>();
let context: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  context = null;
  if (typeof document === "undefined") return context;
  try {
    context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  } catch {
    context = null;
  }
  return context;
}

/**
 * Whether the viewer's browser draws `family` (one of WINDOWS_FONTS) with that very font; asked once.
 * `globalThis.retroLocalFonts = false` (set before the first question) makes every one missing, as
 * on a system without them: for renders and checks of the fallback.
 */
export function hasLocalFont(family: keyof typeof WINDOWS_FONTS): boolean {
  if ((globalThis as { retroLocalFonts?: boolean }).retroLocalFonts === false) return false;
  const known = found.get(family);
  if (known !== undefined) return known;
  const ctx = canvasContext();
  const print = WINDOWS_FONTS[family];
  const result = ctx !== null && findFont(print, (font, text) => {
    ctx.font = font;
    const metrics = ctx.measureText(text);
    return { width: metrics.width, ascent: metrics.actualBoundingBoxAscent };
  });
  found.set(family, result);
  return result;
}

/**
 * `text` as GDI's TextOut(dc, 0, 0) drew it on an 8-bit surface `width` × `height`, in the local
 * `family` at `em` pixels to the em, the baseline `ascent` pixels down, each character at the pen
 * position its `advances` give: 1 where the text is. Null where there is no canvas.
 */
export function localTextMask(text: string, family: keyof typeof WINDOWS_FONTS, em: number, ascent: number, advances: readonly number[],
  width: number, height: number): Uint8Array | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = cssFont(WINDOWS_FONTS[family], em);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  let pen = 0;
  [...text].forEach((char, index) => {
    if (pen < width) ctx.fillText(char, pen, ascent);
    pen += advances[index] ?? 0;
  });
  const data = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = data[index * 4 + 3]! >= 128 ? 1 : 0;
  return mask;
}
