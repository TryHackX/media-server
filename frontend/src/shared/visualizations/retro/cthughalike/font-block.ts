/**
 * A block font for the rotating 3D letters of Cthugha-4-Winamp's song intro: our own outlines,
 * square letters with 45° corners as the plug-in's letters were (its own came from files in its
 * `objs` folder, which we did not use). Each glyph is one or more closed contours on a grid five
 * units wide and seven tall (y up, the baseline at 0); holes are contours inside others, filled
 * by the even-odd rule. Strokes are one unit wide, outer corners cut by one unit.
 *
 * Only capitals, digits and some punctuation: a title is spelt in capitals.
 */

const GLYPHS: Record<string, string> = {
  A: "0,0 0,6 1,7 4,7 5,6 5,0 4,0 4,3 1,3 1,0 | 1,4 1,5.6 1.4,6 3.6,6 4,5.6 4,4",
  B: "0,0 0,7 4,7 5,6 5,1 4,0 | 1,1 1,3 4,3 4,1.4 3.6,1 | 1,4 1,6 3.6,6 4,5.6 4,4",
  C: "1,0 0,1 0,6 1,7 5,7 5,6 1.4,6 1,5.6 1,1.4 1.4,1 5,1 5,0",
  D: "0,0 0,7 4,7 5,6 5,1 4,0 | 1,1 1,6 3.6,6 4,5.6 4,1.4 3.6,1",
  E: "0,0 0,7 5,7 5,6 1,6 1,4 4,4 4,3 1,3 1,1 5,1 5,0",
  F: "0,0 0,7 5,7 5,6 1,6 1,4 4,4 4,3 1,3 1,0",
  G: "1,0 0,1 0,6 1,7 5,7 5,6 1.4,6 1,5.6 1,1.4 1.4,1 3.6,1 4,1.4 4,3 2.5,3 2.5,4 5,4 5,1 4,0",
  H: "0,0 0,7 1,7 1,4 4,4 4,7 5,7 5,0 4,0 4,3 1,3 1,0",
  I: "1,0 1,1 2,1 2,6 1,6 1,7 4,7 4,6 3,6 3,1 4,1 4,0",
  J: "0,1 1,0 4,0 5,1 5,7 4,7 4,1.4 3.6,1 1.4,1 1,1.4 1,2.5 0,2.5",
  K: "0,0 0,7 1,7 1,4.2 1.6,4.2 4,7 5.3,7 2.3,3.5 5.3,0 4,0 1.6,2.8 1,2.8 1,0",
  L: "0,0 0,7 1,7 1,1 5,1 5,0",
  M: "0,0 0,7 1,7 2.5,5 4,7 5,7 5,0 4,0 4,5 2.5,3 1,5 1,0",
  N: "0,0 0,7 1,7 4,2.2 4,7 5,7 5,0 4,0 1,4.8 1,0",
  O: "1,0 0,1 0,6 1,7 4,7 5,6 5,1 4,0 | 1.4,1 1,1.4 1,5.6 1.4,6 3.6,6 4,5.6 4,1.4 3.6,1",
  P: "0,0 0,7 4,7 5,6 5,4 4,3 1,3 1,0 | 1,4 1,6 3.6,6 4,5.6 4,4.4 3.6,4",
  Q: "1,0 0,1 0,6 1,7 4,7 5,6 5,1 4,0 | 1.4,1 1,1.4 1,5.6 1.4,6 3.6,6 4,5.6 4,1.4 3.6,1 | 4.5,0.5 5,1 6,0 5.5,-0.5",
  R: "0,0 0,7 4,7 5,6 5,4 4,3 5,0 3.9,0 3,3 1,3 1,0 | 1,4 1,6 3.6,6 4,5.6 4,4.4 3.6,4",
  S: "0,0 0,1 3.6,1 4,1.4 4,2.6 3.6,3 1,3 0,4 0,6 1,7 5,7 5,6 1.4,6 1,5.6 1,4.4 1.4,4 4,4 5,3 5,1 4,0",
  T: "2,0 2,6 0,6 0,7 5,7 5,6 3,6 3,0",
  U: "1,0 0,1 0,7 1,7 1,1.4 1.4,1 3.6,1 4,1.4 4,7 5,7 5,1 4,0",
  V: "2,0 0,7 1.05,7 2.5,1.9 3.95,7 5,7 3,0",
  W: "1,0 0,7 1,7 1.6,2.2 2.1,5 2.9,5 3.4,2.2 4,7 5,7 4,0 3.2,0 2.5,3.2 1.8,0",
  X: "0,0 1.9,3.5 0,7 1.2,7 2.5,4.6 3.8,7 5,7 3.1,3.5 5,0 3.8,0 2.5,2.4 1.2,0",
  Y: "2,0 2,3 0,7 1.15,7 2.5,4.3 3.85,7 5,7 3,3 3,0",
  Z: "0,0 0,1 3.6,6 0,6 0,7 5,7 5,6 1.4,1 5,1 5,0",
  "0": "1,0 0,1 0,6 1,7 4,7 5,6 5,1 4,0 | 1.4,1 1,1.4 1,5.6 1.4,6 3.6,6 4,5.6 4,1.4 3.6,1",
  "1": "1,0 1,1 2,1 2,5.5 1,5 0.6,5.9 2.2,7 3,7 3,1 4,1 4,0",
  "2": "0,0 0,3 1,4 3.6,4 4,4.4 4,5.6 3.6,6 0,6 0,7 4,7 5,6 5,4 4,3 1.4,3 1,2.6 1,1 5,1 5,0",
  "3": "0,0 0,1 3.6,1 4,1.4 4,2.6 3.6,3 1.5,3 1.5,4 3.6,4 4,4.4 4,5.6 3.6,6 0,6 0,7 4,7 5,6 5,4.4 4.6,4 4.6,3 5,2.6 5,1 4,0",
  "4": "3,0 3,2 0,2 0,7 1,7 1,3 3,3 3,7 4,7 4,3 5,3 5,2 4,2 4,0",
  "5": "0,0 0,1 3.6,1 4,1.4 4,2.6 3.6,3 0,3 0,7 5,7 5,6 1,6 1,4 4,4 5,3 5,1 4,0",
  "6": "1,0 0,1 0,6 1,7 5,7 5,6 1.4,6 1,5.6 1,4 4,4 5,3 5,1 4,0 | 1,1.4 1.4,1 3.6,1 4,1.4 4,2.6 3.6,3 1,3",
  "7": "1,0 4,6 0,6 0,7 5,7 5,6 2.2,0",
  "8": "1,0 0,1 0,2.6 0.4,3.5 0,4.4 0,6 1,7 4,7 5,6 5,4.4 4.6,3.5 5,2.6 5,1 4,0 | 1.4,1 1,1.4 1,2.6 1.4,3 3.6,3 4,2.6 4,1.4 3.6,1 | 1.4,4 1,4.4 1,5.6 1.4,6 3.6,6 4,5.6 4,4.4 3.6,4",
  "9": "4,7 5,6 5,1 4,0 0,0 0,1 3.6,1 4,1.4 4,3 1,3 0,4 0,6 1,7 | 4,5.6 3.6,6 1.4,6 1,5.6 1,4.4 1.4,4 4,4",
  "!": "2,2 2,7 3,7 3,2 | 2,0 2,1 3,1 3,0",
  "?": "2,2 2,3.6 3,4 3.6,4 4,4.4 4,5.6 3.6,6 0,6 0,7 4,7 5,6 5,4 4,3 3,3 3,2 | 2,0 2,1 3,1 3,0",
  ".": "2,0 2,1 3,1 3,0",
  ",": "1.6,-1 2.2,0 2,0 2,1 3,1 3,0 2.6,-1",
  "-": "1,3 1,4 4,4 4,3",
  "'": "2,5 2,7 3,7 3,5",
  ":": "2,1 2,2 3,2 3,1 | 2,4 2,5 3,5 3,4",
  "+": "2,1 2,3 0.5,3 0.5,4 2,4 2,6 3,6 3,4 4.5,4 4.5,3 3,3 3,1",
  "/": "0,0 4,7 5,7 1,0",
  "(": "3,0 2,1 2,6 3,7 4,7 3,6 3,1 4,0",
  ")": "2,0 3,1 3,6 2,7 1,7 2,6 2,1 1,0",
  "=": "1,2 1,3 4,3 4,2 | 1,4 1,5 4,5 4,4"
};

/** The grid the glyphs are drawn on. */
export const BLOCK_WIDTH = 5;
export const BLOCK_HEIGHT = 7;

const parsed = new Map<string, Float32Array[]>();

/** A letter as the block font spells it: capitals, accents dropped, Ł as L; null for none. */
export function blockChar(char: string): string | null {
  const plain = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const mapped = plain === "Ł" ? "L" : plain === "&" ? "+" : plain === "ß" ? "S" : plain;
  return mapped.length === 1 && mapped in GLYPHS ? mapped : null;
}

/** A glyph's contours, each a flat list x0, y0, x1, y1, … in grid units; null for none. */
export function blockGlyph(char: string): Float32Array[] | null {
  const key = blockChar(char);
  if (!key) return null;
  let contours = parsed.get(key);
  if (!contours) {
    contours = GLYPHS[key]!.split("|").map((part) => new Float32Array(part.trim().split(/\s+/).flatMap((point) => point.split(",").map(Number))));
    parsed.set(key, contours);
  }
  return contours;
}

/**
 * The letters a song title is spelt with: the song's name (before " — artist"), in block capitals,
 * what the font lacks left out, at most `most` of them.
 */
export function spellTitle(title: string, most: number): string[] {
  const name = title.split(" — ")[0]!.trim() || title.trim();
  const letters: string[] = [];
  for (const char of name) {
    const block = blockChar(char);
    if (block) letters.push(block);
    if (letters.length >= most) break;
  }
  return letters;
}

/** Every character the block font has. */
export function blockChars(): string[] {
  return Object.keys(GLYPHS);
}
