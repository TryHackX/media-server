import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { OKT, OKT_CREDIT } from "./fonts-amiga2";
import { decimal, hex, noteText } from "./notation";
import { type Font, printable, rgb, sheet, Surface, Target } from "./raster";
import { type Cell, emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * Oktalyzer 1.57 (Amiga, Armin Sander, 1989–93) playing along: its 640 × 256 hires screen of
 * text on bands of colour, the whole program in one page — the yellow headings over the menu of
 * song, editor, sample and memory in the navy band (positions, lengths, the sample's name, the
 * channels' lamps), the eight tracks of the pattern in white on black, two pairs either side of
 * a second row-number column, and the credit line on the purple at the foot.
 *
 * Oktalyzer plays eight channels by mixing two into each of the Amiga's four voices; here every
 * pair is doubled, so all eight show. The module is song.ts's: kick, snare, bass, hi-hats, the
 * lead on the right and on the left by where it is heard, chords, and the lead's echo. The edit
 * cursor rides the play row as it does while recording, and the page scrolls to keep it in view.
 * Everything here is drawn from this project's own fonts (fonts-amiga2.ts) and these coordinates.
 */

const WIDTH = 640;
const HEIGHT = 256;

const PURPLE = rgb(0x3d3192);
const NAVY = rgb(0x1d1745);
const BLACK = rgb(0x000000);
const YELLOW = rgb(0xe7f9aa);
const TEAL = rgb(0x44cba9);
const WHITE = rgb(0xfcfcfc);

const font = sheet(OKT.sheet, OKT.cell, OKT.height, OKT.fixed);
const credit = sheet(OKT_CREDIT.sheet, OKT_CREDIT.cell, OKT_CREDIT.height, OKT_CREDIT.fixed, 2);

const CHANNELS = 8;
const SPEC: SongSpec = {
  // The pairs of the Amiga's voices: 1–2 and 7–8 on the left, 3–6 on the right.
  channels: [{ parts: ["kick"] }, { parts: ["snare"] }, { parts: ["bass"] }, { parts: ["hats"] }, { parts: ["lead"], side: 1 }, { parts: ["chord"] }, { parts: ["lead"], side: -1 }, { parts: ["echo"] }],
  // C-1 … B-3, Oktalyzer's three octaves.
  low: 12,
  high: 47,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 12, lead: 24, chord: 24 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 128,
  seed: 157
};

/** The text grid: a cell is 8 pixels wide; text row r has its glyphs from y = 8r. */
const CELL = 8;
const MENU_TOP = 7;
const PATTERN_TOP = 56;
const CREDIT_TOP = 248;
/** Pattern rows on screen, and the columns of the eight tracks (two either side of the middle row numbers). */
const VISIBLE = 24;
const SLOTS = [6, 15, 24, 33, 45, 54, 63, 72];
/** Where the lamps, the channel switches and their numbers stand. */
const LAMPS = 71;

/** The sample's name field: twenty cells, its unused ones dotted. */
const NAME_CELLS = 20;

/** A sample number or a command as Oktalyzer writes them: one character, 0–9 then A–Z. */
export function base36(value: number): string {
  const n = Math.max(0, Math.min(35, Math.round(value)));
  return n < 10 ? String(n) : String.fromCharCode(55 + n);
}

/**
 * A cell's command in Oktalyzer's notation: a letter or digit and two hex digits ("A37", "V20").
 * Arpeggio is A, the slides 1 (up) and 2 (down), volume and its slides V, speed S; what the
 * program has no command for is left out ("000"). A note not at full volume sets it with V.
 */
export function oktEffect(cell: Cell): string {
  const p = cell.param & 255;
  switch (cell.effect) {
    case "arpeggio": return `A${hex(p, 2)}`;
    case "slideUp": return `1${hex(p, 2)}`;
    case "slideDown": return `2${hex(p, 2)}`;
    case "volume": return `V${hex(Math.min(64, p), 2)}`;
    case "volumeSlide": return `V${hex(0x40 + Math.min(16, Math.max(1, p & 15)), 2)}`;
    case "speed": return `S${hex(Math.min(31, p), 2)}`;
    case "cut": return "V00";
    default:
      if (cell.volume >= 0 && cell.volume < 0x38 && cell.note >= 0) return `V${hex(cell.volume, 2)}`;
      return "000";
  }
}

/** Text in the program's face, on the text grid. */
function put(s: Surface, column: number, row: number, text: string, color: number): void {
  s.text(font, column * CELL, row * CELL, text, color);
}

/** The credit line's capitals, leaned to the right a pixel a row. */
function slanted(s: Surface, face: Font, x: number, y: number, text: string, color: number): void {
  const last = face.height - 1;
  let at = x;
  for (const char of text) {
    const glyph = face.glyphs.get(char);
    if (glyph) {
      for (let row = 0; row < glyph.rows.length; row += 1) {
        if (glyph.rows[row]) s.bits(at + last - row, y + row, [glyph.rows[row]!], glyph.width, color);
      }
    }
    at += (glyph ? glyph.width : 4) + face.spacing;
  }
}

function slantedWidth(face: Font, text: string): number {
  let width = 0;
  for (const char of text) width += (face.glyphs.get(char)?.width ?? 4) + face.spacing;
  return width - face.spacing + face.height - 1;
}

const CREDIT = "OKTALYZER V1.57  © 1989-93 media GmbH  BY A.SANDER (SIMPLEX)";

/** The page as it stands, without the values that change. */
function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  // The bands: the headings on purple, the menu on navy, the pattern on black, the credit line.
  s.fill(0, 0, WIDTH, MENU_TOP, PURPLE);
  s.fill(0, MENU_TOP, WIDTH, PATTERN_TOP - MENU_TOP, NAVY);
  s.fill(0, PATTERN_TOP, WIDTH, CREDIT_TOP - PATTERN_TOP, BLACK);
  s.fill(0, CREDIT_TOP, WIDTH, HEIGHT - CREDIT_TOP, PURPLE);
  put(s, 1, 0, "Current Song:", YELLOW);
  put(s, 16, 0, "Editor:", YELLOW);
  put(s, 40, 0, "Current Sample: 1", YELLOW);
  put(s, 67, 0, "Memory:", YELLOW);
  // The menu: six rows of commands and fields.
  const menu: readonly (readonly [number, number, string])[] = [
    [1, 1, "New"], [6, 1, "Pos..:"], [16, 1, "Play Song"], [26, 1, "MidiMode: Off"], [40, 1, "Name:"], [67, 1, "Chip:"],
    [1, 2, "Load"], [6, 2, "Patt.:"], [16, 2, "Play Patt"], [26, 2, "Copy Cut Curs"], [40, 2, "Len.: 046286"], [54, 2, "Load"], [60, 2, "Clear"], [67, 2, "Fast:"],
    [1, 3, "Save"], [6, 3, "Len..:"], [16, 3, "Edit.:Off"], [26, 3, "Replc. Mix It"], [40, 3, "RStr: 000000"], [54, 3, "Save"], [60, 3, "Clear"], [67, 3, "Song:"],
    [1, 4, "Pref"], [6, 4, "Ins. Del."], [16, 4, "Poly.:Off"], [26, 4, "NoteUp NoDown"], [40, 4, "RLen: 000000"], [54, 4, "Edit"], [61, 4, "All"],
    [1, 5, "Exit"], [6, 5, "Speed:  6"], [16, 5, "Quant.:01"], [26, 5, "OctaUp OcDown"], [40, 5, "Vol.: 64"], [54, 5, "Copy"], [61, 5, "Mix"], [68, 5, "2"],
    [1, 6, "CLI"], [6, 6, "SLen.:"], [16, 6, "PLen.: 40"], [26, 6, "ChInst ChaEff"], [40, 6, "Mode: B"], [54, 6, "Swap"], [60, 6, "ClrCB"]
  ];
  for (const [column, row, text] of menu) put(s, column, row, text, TEAL);
  // The channels: switched on, and numbered.
  put(s, LAMPS - 1, 5, `S${"●".repeat(CHANNELS)}`, TEAL);
  put(s, LAMPS - 1, 6, `C${"12345678".slice(0, CHANNELS)}`, TEAL);
  // The credit line, centred.
  slanted(s, credit, Math.round((WIDTH - slantedWidth(credit, CREDIT)) / 2), CREDIT_TOP + 1, CREDIT, YELLOW);
  return s;
}

export function createOktalyzer(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const lamps = new Float32Array(CHANNELS);
  const seen = new Float64Array(CHANNELS);
  // The page with the pattern as it stands, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const length = song.length(frame.track.duration);
    put(s, 12, 1, decimal(song.position, 3), TEAL);
    put(s, 13, 2, decimal(song.pattern, 2), TEAL);
    put(s, 12, 3, decimal(length, 3), TEAL);
    // The patterns stored: as many as the song's last position plays.
    const patterns = song.patternAt(length - 1) + 1;
    put(s, 13, 6, decimal(patterns, 2), TEAL);
    // The first sample is named after the song, its unused cells dotted.
    const name = printable(frame.track.title, font).replace(/\s+/g, " ").trim().slice(0, NAME_CELLS);
    put(s, 46, 1, name.padEnd(NAME_CELLS, "-"), TEAL);
    // The module's size grows with its patterns; the chip memory left shrinks by as much.
    const size = 1084 + patterns * CHANNELS * 4 * ROWS + 186_240;
    put(s, 73, 1, decimal(1_791_016 - size, 7), TEAL);
    put(s, 74, 2, decimal(277_336, 6), TEAL);
    put(s, 73, 3, decimal(size, 7), TEAL);
  };

  /** The lamps over the channel numbers light as a note starts and go out as it fades. */
  const drawLamps = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const hits = song.hits(channel);
      let value = lamps[channel]! - dt * 2.5;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        value = Math.max(value, 0.4 + 0.6 * song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel) * 0.8);
      lamps[channel] = Math.max(0, Math.min(1, value));
      if (lamps[channel]! > 0.35) s.fill((LAMPS + channel) * CELL + 1, 4 * CELL, 7, 7, TEAL);
    }
  };

  /** One track's cell: the note (a dash of dots for none), the sample, the command. */
  const drawCell = (s: Surface, channel: number, row: number, y: number): void => {
    song.cell(channel, row, cell);
    const x = SLOTS[channel]! * CELL;
    const note = cell.note >= 0 && cell.note <= 119 ? noteText(cell.note) : "---";
    s.text(font, x, y, note, WHITE);
    const sample = cell.note >= 0 && cell.note <= 119 && cell.instrument > 0 ? base36(cell.instrument) : "0";
    s.text(font, x + 4 * CELL, y, `${sample}${oktEffect(cell)}`, WHITE);
  };

  /** The page of the pattern around the play row, the cursor on the first track's note. */
  const drawPattern = (s: Surface): void => {
    const current = song.row;
    const top = Math.max(0, Math.min(ROWS - VISIBLE, current - (VISIBLE >> 1) + 1));
    const position = decimal(song.position, 2);
    for (let line = 0; line < VISIBLE; line += 1) {
      const row = top + line;
      const y = PATTERN_TOP + line * CELL;
      const number = hex(row, 2);
      s.text(font, 0, y, position, WHITE);
      s.text(font, 3 * CELL, y, number, WHITE);
      s.text(font, 42 * CELL, y, number, WHITE);
      for (let channel = 0; channel < CHANNELS; channel += 1) drawCell(s, channel, row, y);
    }
    // The cursor: the cell under it turned over, a pixel to the right as the Amiga sets it.
    const y = PATTERN_TOP + (current - top) * CELL;
    const x = SLOTS[0]! * CELL + 1;
    for (let line = 0; line < 7; line += 1) {
      const at = (y + line) * WIDTH + x;
      for (let column = 0; column < CELL; column += 1) s.pixels[at + column] = s.pixels[at + column] === WHITE ? BLACK : WHITE;
    }
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
        base.copy(chrome, 0, PATTERN_TOP, WIDTH, CREDIT_TOP - PATTERN_TOP, 0, PATTERN_TOP);
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawLamps(screen, frame.dt);
      target.close(image);
    }
  };
}
