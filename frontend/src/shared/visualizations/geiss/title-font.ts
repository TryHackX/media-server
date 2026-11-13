import type { TitleMask } from "./sim";

/**
 * Geiss's song titles and custom messages as GDI drew them, for sim.ts (TitleMask), on a 2D canvas.
 *
 * The plug-in made its font with CreateFont(24, 10, 0, 0, 700, …, DEFAULT_CHARSET, …,
 * DEFAULT_QUALITY, VARIABLE_PITCH | FF_DONTCARE, NULL) and GDI gave it Arial Bold: a 24 px cell at
 * 20 px to the em, the baseline 19 px down; the width of 10 is Arial Bold's own there. Only when
 * the picture was more than 320 pixels wide — at 320 it made no font and the surface's DC drew in
 * its own, SYSTEM_FONT (a 16 px cell, the baseline 13 px down). Neither is bundled here: the text
 * is drawn in Arial where the viewer has it (Liberation Sans or Arimo, its metric twins, else a
 * sans-serif), each letter where GDI put it — its advance widths are kept below, measured from GDI
 * (scratch/geiss-reference/gdi_probe.cpp), so the text's width, and with it where Geiss places it,
 * is the plug-in's — and without smoothing, as GDI drew at 8 bits always (above 8 bits too where
 * Windows' font smoothing was off): a pixel is the text where the browser's smooth glyph covers two
 * thirds of it, which gives GDI's hinted stems best (against GDI's own pixels of twelve titles,
 * 0.92 of the text's pixels shared in Arial Bold, 0.81 in the stand-in for SYSTEM_FONT; at half,
 * the stems came out a pixel too thick).
 */

/** A font the plug-in drew with: the CSS font, the cell and baseline, GDI's advance widths. */
interface GdiFont {
  css: string;
  cell: number;
  ascent: number;
  /** Where each glyph goes from GDI's pen position, in pixels (the closest match to GDI's). */
  offset: number;
  /** U+0020–U+017F, a character each: the width in pixels + 48; "0" where the font has none. */
  latin: string;
  /** The same for EXTRA_CHARS. */
  extra: string;
}

/** Punctuation beyond Latin Extended-A that titles often carry: dashes, quotes, bullet, €, ™. */
const EXTRA_CHARS = "–—‘’‚“”„†‡•…‰‹›€™";

/** Arial Bold, 24 px cell (20 px em), as GDI hints it. */
const TITLE_FONT: GdiFont = {
  css: "bold 20px Arial, \"Liberation Sans\", Arimo, Helvetica, sans-serif",
  cell: 24,
  ascent: 19,
  offset: -0.25,
  latin: "679;;A>5778<6766;;;;;;;;;;77<<<<D=>>>=<@>5;><A>@=@>==>=C==;767<;7;<;<;7<<55;5A<<<<8;7<;?;;:868<00000000000000000000000000000000067;;;;6;7?7;<7?;8;777<;7677;AAA<>>>>>>D>====6666>>@@@@@<@>>>>==<;;;;;;B;;;;;6666<<<<<<<;<<<<<;<;=;=;=;>;>;>;>;>>><=;=;=;=;=;@<@<@<@<><><5555555555@;;5>;;<5<5<8<:<5><><><>><@<@<@<DC>8>8>8=;=;=;=;=7=:=7><><><><><><C?=;=;:;:;:5",
  extra: ";D666:::;;7DE77;D"
};

/**
 * SYSTEM_FONT, Windows' bold bitmap font of a DC (16 px cell): GDI's widths for what code page
 * 1250 holds. Its glyphs are a bitmap no browser draws; Arial Bold at 13 px stands in (closer to
 * them than MS Sans Serif or Tahoma).
 */
const SYSTEM_FONT: GdiFont = {
  css: "bold 13px Arial, \"Liberation Sans\", Arimo, Helvetica, sans-serif",
  cell: 16,
  ascent: 13,
  offset: 0.25,
  latin: "44688;94446844448888888888448888>8:9:98::4798<::9::98:8>9:9444585887884884474<888858488:8885455400000000000000000000000000000000400080485:0784:058005874500700000880800909090440000::0:800:0::080880800708080440000880860080880000888897000097:;:800000098980000000000000000000000000000084008700:7:800:80000000:800:500:698009898848700000000:8:800000009898980",
  extra: "69445776::78?8749"
};

/** Room around the cell for glyphs that reach out of it. */
const MARGIN = 8;
/** The coverage (alpha, 0–255) from which a pixel is the text. */
const INK = 170;

/** GDI's advance of `char` in `font`, or null where the table has none. */
export function gdiAdvance(font: "title" | "system", char: string): number | null {
  const table = font === "title" ? TITLE_FONT : SYSTEM_FONT;
  const code = char.codePointAt(0) ?? 0;
  let encoded: string | undefined;
  if (code >= 0x20 && code < 0x180) encoded = table.latin[code - 0x20];
  else {
    const at = EXTRA_CHARS.indexOf(char);
    if (at >= 0) encoded = table.extra[at];
  }
  if (encoded === undefined || encoded === "0") return null;
  return encoded.charCodeAt(0) - 48;
}

/**
 * `text` in the font Geiss used at a picture `width` pixels wide, as sim.ts wants it: the text's
 * width and height as GetTextExtentPoint() gave them (sum of the advances × the cell; 0 × 0 for
 * no text) and its pixels, 1 where the text is. Null without a canvas.
 */
export function rasteriseTitle(text: string, width: number): TitleMask | null {
  if (text === "") return { width: 0, height: 0, left: 0, top: 0, maskWidth: 0, maskHeight: 0, mask: new Uint8Array(0) };
  const name = width > 320 ? "title" : "system";
  const font = name === "title" ? TITLE_FONT : SYSTEM_FONT;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.font = font.css;
  const chars = [...text];
  const advances = chars.map((char) => gdiAdvance(name, char) ?? Math.max(0, Math.round(context.measureText(char).width)));
  const extent = advances.reduce((sum, advance) => sum + advance, 0);
  // A canvas stays within the browser's limits: a long title is cut where nothing would show.
  const drawn = Math.min(extent, 4096);
  canvas.width = drawn + MARGIN * 2;
  canvas.height = font.cell + MARGIN * 2;
  context.font = font.css;
  context.fillStyle = "#fff";
  context.textBaseline = "alphabetic";
  let pen = 0;
  chars.forEach((char, index) => {
    if (pen <= drawn) context.fillText(char, MARGIN + pen + font.offset, MARGIN + font.ascent);
    pen += advances[index]!;
  });
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  // The glyphs' box, then the mask in it.
  let left = canvas.width;
  let right = -1;
  let top = canvas.height;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (data[(y * canvas.width + x) * 4 + 3]! < INK) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return { width: extent, height: font.cell, left: 0, top: 0, maskWidth: 0, maskHeight: 0, mask: new Uint8Array(0) };
  const maskWidth = right - left + 1;
  const maskHeight = bottom - top + 1;
  const mask = new Uint8Array(maskWidth * maskHeight);
  for (let y = 0; y < maskHeight; y += 1) {
    for (let x = 0; x < maskWidth; x += 1) {
      mask[y * maskWidth + x] = data[((y + top) * canvas.width + x + left) * 4 + 3]! >= INK ? 1 : 0;
    }
  }
  return { width: extent, height: font.cell, left: left - MARGIN, top: top - MARGIN, maskWidth, maskHeight, mask };
}
