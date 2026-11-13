import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { UST_CAPS, UST_HEADER, UST_LABEL_NARROW, UST_LOGO_LARGE, UST_LOGO_SMALL, UST_SMALL } from "./fonts-soundtracker";
import { decimal, fieldText, hex, noteText } from "./notation";
import { type Font, measure, printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * The Ultimate Soundtracker 1.21 (Karsten Obarski, 1987) playing along: its 320 × 256 PAL screen
 * in the brown of the original — the fields with their + and − buttons, the eight buttons, the
 * logo panel, SONGNAME and SAMPLENAME, and the four tracks under their names (Melody, Accompany,
 * Bass, Percussions) scrolling under the play row, as the program shows a pattern playing.
 *
 * The first tracker had no meters, scopes or clock, so neither has this screen. Its module is
 * song.ts's, laid out as the program's own names say: the lead in Melody, the chords (a root and
 * its arpeggio) in Accompany, the bass, and every drum in Percussions. Fifteen samples, one hex
 * digit each; the only effects are 1 (arpeggio) and 2 (pitch bend). Everything is drawn from
 * this project's own fonts (fonts-soundtracker.ts) and these coordinates.
 */

const WIDTH = 320;
const HEIGHT = 256;

const BLACK = rgb(0x000000);
const TAN = rgb(0x997755);
const LIGHT = rgb(0xaa8866);
const DARK = rgb(0x553311);
const TEAL = rgb(0x006699);
const CURSOR = rgb(0x99aabb);

/** The fields' and the tracks' capitals, eight pixels apart. */
const caps = sheet(UST_CAPS.sheet, UST_CAPS.cell, UST_CAPS.height, UST_CAPS.fixed);
/** The labels of the panel: the same capitals set tight, with a narrow I, colon and space. */
const labels: Font = (() => {
  const tight = sheet(UST_CAPS.sheet, UST_CAPS.cell, UST_CAPS.height, false);
  const narrow = sheet(UST_LABEL_NARROW.sheet, UST_LABEL_NARROW.cell, UST_LABEL_NARROW.height, false);
  const glyphs = new Map(tight.glyphs);
  for (const char of ["I", ":"]) glyphs.set(char, narrow.glyphs.get(char)!);
  glyphs.set(" ", { width: 2, rows: [0, 0, 0, 0, 0] });
  return { ...tight, glyphs };
})();
const small = sheet(UST_SMALL.sheet, UST_SMALL.cell, UST_SMALL.height, false);
const header = sheet(UST_HEADER.sheet, UST_HEADER.cell, UST_HEADER.height, false);

/** The logo's letters, each as its rows of '#' (black), 'o' (brown) and '.' (none). */
type Art = ReadonlyMap<string, readonly string[]>;

function art(text: string, cell: number, height: number): Art {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const letters = new Map<string, string[]>();
  for (let block = 0; block + height < lines.length; block += height + 1) {
    const names = lines[block]!;
    for (let start = 0; start < names.length; start += cell + 1) {
      const char = names[start]!;
      if (char === " ") continue;
      const rows = Array.from({ length: height }, (_, row) => (lines[block + 1 + row] ?? "").slice(start, start + cell).padEnd(cell, "."));
      let used = 1;
      for (const row of rows) for (let column = 0; column < cell; column += 1) if (row[column] !== ".") used = Math.max(used, column + 1);
      letters.set(char, rows.map((row) => row.slice(0, used)));
    }
  }
  return letters;
}

const logoLarge = art(UST_LOGO_LARGE.sheet, UST_LOGO_LARGE.cell, UST_LOGO_LARGE.height);
const logoSmall = art(UST_LOGO_SMALL.sheet, UST_LOGO_SMALL.cell, UST_LOGO_SMALL.height);

/** The keys beside the right-hand buttons, thin capitals five rows high. */
const KEYS: Record<string, readonly number[]> = {
  U: [0b1001, 0b1001, 0b1001, 0b1001, 0b0110],
  S: [0b0111, 0b1000, 0b0110, 0b0001, 0b1110],
  L: [0b1000, 0b1000, 0b1000, 0b1000, 0b1111]
};

/** The + and − of the fields' buttons. */
const PLUS = [0b010, 0b111, 0b010];
const MINUS = [0b000, 0b111, 0b000];

const SPEC: SongSpec = {
  channels: [{ parts: ["lead"] }, { parts: ["chord"] }, { parts: ["bass"] }, { parts: ["kick", "snare", "hats"] }],
  // C-1 … B-3, the three octaves of the Amiga's period table.
  low: 12,
  high: 47,
  // A-2, C-3 and D-3: where the songs of the time struck their drum samples.
  drums: { kick: 33, snare: 36, hats: 38 },
  floors: { bass: 12, lead: 24, chord: 24 },
  instruments: { kick: 13, snare: 14, hats: 11, bass: 6, lead: 1, chord: 4, echo: 2 },
  positions: 128,
  seed: 5
};

/** The pattern: rows above the play row, the play row's text, rows below; a row every 7 lines. */
const ABOVE_TOP = 142;
const BAR_TEXT = 192;
const BELOW_TOP = 205;
const LINE = 7;
const TRACK_TEXT = 33;
const TRACK_STEP = 72;
/** The wells: the row numbers' and the four tracks' (the last two pixels wider). */
const WELLS: readonly (readonly [number, number])[] = [[2, 26], [29, 71], [101, 71], [173, 71], [245, 73]];

/** A button's edge: light along the top and left, dark along the bottom and right (both corners). */
function button(s: Surface, x: number, y: number, width: number, height: number): void {
  s.fill(x, y, width - 1, 1, LIGHT);
  s.fill(x, y, 1, height - 1, LIGHT);
  s.fill(x, y + height - 1, width, 1, DARK);
  s.fill(x + width - 1, y, 1, height, DARK);
}

/** A small raised edge: its top row all light, its bottom row all dark. */
function raised(s: Surface, x: number, y: number, width: number, height: number): void {
  s.fill(x, y, width, 1, LIGHT);
  s.fill(x, y, 1, height, LIGHT);
  s.fill(x, y + height - 1, width, 1, DARK);
  s.fill(x + width - 1, y + 1, 1, height - 1, DARK);
}

/** How wide a logo word comes out. */
function logoWidth(letters: Art, text: string, gap: number, space: number): number {
  let width = 0;
  for (const char of text) width += (letters.get(char)?.[0]?.length ?? space) + gap;
  return width - gap;
}

/**
 * A word of the logo: its letters (black, folds in brown), the panel's light edge over every top
 * and the shadow they cast two rows down and one along.
 */
function logo(s: Surface, letters: Art, x0: number, y0: number, text: string, gap: number, space: number): void {
  const width = logoWidth(letters, text, gap, space);
  const height = [...letters.values()][0]!.length;
  const ink = new Uint8Array(width * height);
  let at = 0;
  for (const char of text) {
    const rows = letters.get(char);
    if (!rows) {
      at += space + gap;
      continue;
    }
    for (let row = 0; row < height; row += 1) {
      const line = rows[row]!;
      for (let column = 0; column < line.length; column += 1) {
        if (line[column] === "#") ink[row * width + at + column] = 1;
        else if (line[column] === "o") ink[row * width + at + column] = 2;
      }
    }
    at += rows[0]!.length + gap;
  }
  const lit = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && ink[y * width + x] !== 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (lit(x, y) && !lit(x, y - 1)) s.pixel(x0 + x, y0 + y - 1, LIGHT);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!lit(x, y)) continue;
      for (const down of [1, 2]) if (!lit(x + 1, y + down)) s.pixel(x0 + x + 1, y0 + y + down, DARK);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = ink[y * width + x];
      if (value) s.pixel(x0 + x, y0 + y, value === 1 ? BLACK : DARK);
    }
  }
}

/** The screen as it stands, without the values that change. */
function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, TAN);
  // Two black lines over the screen, as the program opens it.
  s.fill(0, 0, WIDTH, 2, BLACK);
  // The left edge runs down the whole screen, the right edge's dark line too.
  s.fill(0, 2, 1, HEIGHT - 2, LIGHT);
  s.fill(WIDTH - 1, 2, 1, HEIGHT - 2, DARK);

  // The fields: three, then PRESET, then the sound's five, each group a panel of its own.
  s.fill(0, 2, 140, 1, LIGHT);
  s.fill(140, 2, 1, 98, DARK);
  s.fill(0, 34, WIDTH, 1, DARK);
  s.fill(0, 35, 140, 1, LIGHT);
  s.fill(0, 45, WIDTH, 1, DARK);
  s.fill(0, 46, 140, 1, LIGHT);
  const fields = ["POSITION", "PATTERN", "LENGHT", "PRESET", "SOUND", "LENGHT", "VOLUME", "REPEAT", "REPLEN"];
  for (let row = 0; row < fields.length; row += 1) {
    const y = 5 + row * 11;
    s.text(labels, 4, y, fields[row]!, BLACK);
    for (const [x, sign] of [[118, PLUS], [130, MINUS]] as const) {
      raised(s, x, y - 1, 9, 7);
      s.bits(x + 3, y + 1, sign, 3, BLACK);
    }
  }

  // The eight buttons in two columns; the right-hand ones with their keys.
  const left = ["PATTERN", "PLAY", "STOP", "EDIT"];
  const right = ["USE PRESET", "SAVE SONG", "LOAD SONG", "LOAD SAMPLE"];
  const keys = ["U", "S", "L", "L"];
  for (let row = 0; row < 4; row += 1) {
    const y = 2 + row * 11;
    button(s, 141, y, 80, 11);
    button(s, 221, y, 99, 11);
    s.text(labels, 141 + Math.round((79 - measure(labels, left[row]!)) / 2), y + 3, left[row]!, BLACK);
    s.text(labels, 221 + Math.round((99 - measure(labels, right[row]!)) / 2), y + 3, right[row]!, BLACK);
    s.bits(313, y + 3, KEYS[keys[row]!]!, 4, BLACK);
  }

  // The logo panel, its edge two pixels deep.
  s.fill(141, 46, 178, 2, LIGHT);
  s.fill(141, 46, 2, 54, LIGHT);
  s.fill(141, 99, 179, 2, DARK);
  s.fill(318, 47, 2, 53, DARK);
  s.pixel(141, 99, LIGHT);
  const smallWidth = logoWidth(logoSmall, "THE ULTIMATE", 2, 5);
  logo(s, logoSmall, 235 - Math.round(smallWidth / 2), 51, "THE ULTIMATE", 2, 5);
  const largeWidth = logoWidth(logoLarge, "SOUNDTRACKER", 1, 6);
  logo(s, logoLarge, 231 - Math.round(largeWidth / 2), 65, "SOUNDTRACKER", 1, 6);
  s.text(small, 149, 90, "1987 by Karsten Obarski", BLACK);
  const version = "V1.21  PAL";
  s.text(small, 313 - measure(small, version), 90, version, BLACK);

  // SONGNAME and SAMPLENAME.
  s.fill(0, 100, WIDTH, 1, DARK);
  for (const [y, label] of [[101, "SONGNAME:"], [112, "SAMPLENAME:"]] as const) {
    s.fill(0, y, WIDTH - 1, 1, LIGHT);
    s.fill(0, y + 10, WIDTH, 1, DARK);
    s.text(labels, 4, y + 3, label, BLACK);
  }

  // The tracks' names over their wells.
  s.fill(0, 123, WIDTH - 1, 1, LIGHT);
  const names = ["Melody", "Accompany", "Bass", "Percussions"];
  for (let track = 0; track < 4; track += 1) {
    const [x, width] = WELLS[track + 1]!;
    s.text(header, x + Math.round((width - measure(header, names[track]!)) / 2), 127, names[track]!, BLACK);
  }

  // The wells over and under the play row, and the play row between them.
  for (const [x, width] of WELLS) {
    for (const [top, bottom] of [[139, 189], [202, 253]] as const) {
      s.fill(x, top, width, bottom - top + 1, BLACK);
      s.fill(x, top, width - 1, 1, DARK);
      if (top === 202) s.fill(x, 203, width - 1, 1, DARK);
      s.fill(x, top, 1, bottom - top + 1, DARK);
      s.fill(x + width - 1, top, 1, bottom - top + 1, LIGHT);
    }
    s.fill(x, 190, width, 2, LIGHT);
    s.fill(x, 192, width, 10, TAN);
    s.fill(x, 254, width, 1, LIGHT);
  }
  return s;
}

export function createUltimateSoundtracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  // The screen with the tracks as they stand, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  /** One track's cell as the Soundtracker writes it: note, sample, effect ("C-3 E000"). */
  const cellText = (channel: number, row: number): string => {
    song.cell(channel, row, cell);
    let effect = "000";
    if (cell.effect === "arpeggio") effect = `1${hex(cell.param, 2)}`;
    else if (cell.effect === "slideUp") effect = `20${hex(Math.min(15, cell.param), 1)}`;
    else if (cell.effect === "slideDown") effect = `2${hex(Math.min(15, cell.param), 1)}0`;
    return `${noteText(cell.note, "---")} ${hex(cell.instrument & 15, 1)}${effect}`;
  };

  const drawPattern = (s: Surface): void => {
    const current = song.row;
    for (let offset = -7; offset <= 7; offset += 1) {
      const row = current + offset;
      if (row < 0 || row >= ROWS) continue;
      const playing = offset === 0;
      const y = playing ? BAR_TEXT : offset < 0 ? ABOVE_TOP + (offset + 7) * LINE : BELOW_TOP + (offset - 1) * LINE;
      const color = playing ? BLACK : TEAL;
      const scale = playing ? 2 : 1;
      s.text(caps, 9, y, decimal(row, 2), color, scale);
      for (let channel = 0; channel < 4; channel += 1) s.text(caps, TRACK_TEXT + channel * TRACK_STEP, y, cellText(channel, row), color, scale);
    }
    // The edit cursor on the first track's note.
    s.fill(31, 190, 10, 2, CURSOR);
    s.fill(31, 202, 10, 2, CURSOR);
    s.fill(31, 192, 1, 10, CURSOR);
    s.fill(40, 192, 1, 10, CURSOR);
  };

  /** The fields that change: the position, the pattern, the song's length and name. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const length = song.length(frame.track.duration);
    s.text(caps, 81, 5, decimal(song.position, 4), BLACK);
    s.text(caps, 81, 16, decimal(song.pattern, 4), BLACK);
    s.text(caps, 81, 27, decimal(length, 4), BLACK);
    s.text(caps, 81, 38, "0001", BLACK);
    s.text(caps, 81, 49, "0001", BLACK);
    s.text(caps, 81, 60, "0C2A", BLACK);
    s.text(caps, 81, 71, "0064", BLACK);
    s.text(caps, 81, 82, "0000", BLACK);
    s.text(caps, 81, 93, "0001", BLACK);
    s.text(caps, 105, 104, fieldText(printable(frame.track.title, caps, true), 20, true, "_"), BLACK);
    s.text(caps, 105, 115, fieldText("BASSDRUM1", 22, true, "_"), BLACK);
    s.text(caps, 9, 132, decimal(song.pattern, 2), BLACK);
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      song.update(frame.audio, frame.track, frame.dt);
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) screen = new Surface(WIDTH, HEIGHT, pixels);
      if (song.changes !== drawn) {
        drawn = song.changes;
        base.copy(chrome, 0, 139, WIDTH, HEIGHT - 139, 0, 139);
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      target.close(image);
    }
  };
}
