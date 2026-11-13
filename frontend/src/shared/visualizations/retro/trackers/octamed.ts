import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { OM, OM_LABEL, OM_LOGO, OM_SMALL, OM_THIN, OM_WIDE } from "./fonts-gui";
import { clock, decimal, hex, noteText } from "./notation";
import { measure, mix, printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * OctaMED Professional 4.0 (Amiga, 1992; Teijo Kinnunen) playing along: its 640 × 256 hires
 * screen in the grey of Workbench 2 — the title strip with the timer and the program's metal
 * lettering, the control panel (the song's positions with their buttons, the two sliders, the
 * volume, filter and tempo settings, the channel mode, STOP and the four PLAY/CONT. buttons, the
 * menu of the program's windows), the line of the song's position, block and instrument, the
 * tracker editor with four tracks in its double-wide letters, the play line a grey bar across
 * the middle and a meter rising from each track's foot, the memory line, and the spectrum of
 * the notes played under it.
 *
 * The module is song.ts's: drums on track 0 (a snare that meets a kick moves to track 3), the
 * bass on track 1, the lead on track 2, hi-hats and chords on track 3. Drawn from this project's
 * own fonts (fonts-gui.ts) and these coordinates, after screenshots of the program.
 */

const WIDTH = 640;
const HEIGHT = 256;

const BLACK = rgb(0x000000);
const WHITE = rgb(0xffffff);
const GREY = rgb(0x9999aa);
const LIGHT = rgb(0xccccdd);
const DARK = rgb(0x666677);
const TEXT = rgb(0xcccccc);
const PINK = rgb(0xeeaaaa);
const CURSOR = rgb(0xcc3344);

/**
 * The faces: the seven-row one for names and numbers (proportional, or in its cells for the
 * numbers and the editor), the five-row capitals of the buttons and labels (two pixels apart,
 * one in a tight label), the broad capitals of TIMER and the window menu.
 */
const font = sheet(OM.sheet, OM.cell, OM.height, false, 2);
const cells = sheet(OM.sheet, OM.cell, OM.height, true);
const caps = sheet(OM_LABEL.sheet, OM_LABEL.cell, OM_LABEL.height, OM_LABEL.fixed, 2);
const tight = sheet(OM_LABEL.sheet, OM_LABEL.cell, OM_LABEL.height, OM_LABEL.fixed, 1);
const wide = sheet(OM_WIDE.sheet, OM_WIDE.cell, OM_WIDE.height, OM_WIDE.fixed, 2);
const logo = sheet(OM_LOGO.sheet, OM_LOGO.cell, OM_LOGO.height, OM_LOGO.fixed, 2);
const thin = sheet(OM_THIN.sheet, OM_THIN.cell, OM_THIN.height, OM_THIN.fixed, 2);
const small = sheet(OM_SMALL.sheet, OM_SMALL.cell, OM_SMALL.height, OM_SMALL.fixed, 2);

const TRACKS = 4;
const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  low: 12,
  high: 71,
  drums: { kick: 24, snare: 26, hats: 30 },
  floors: { bass: 24, lead: 36, chord: 36 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 999,
  seed: 1992
};

const INSTRUMENTS = ["bassdrum", "snare", "closedhat", "openhat", "fatbass", "lead", "strings", "echo"];

/** The editor: fifteen lines from its top, the play line the eighth; a track's columns. */
const EDITOR_TOP = 77;
const EDITOR_LINES = 15;
const PLAY_LINE = 7;
const LINE = 8;
const TRACK_LEFT = 64;
const TRACK_STEP = 144;
const METER_LEFT = 91;
const METER_HEIGHT = 58;
/** The spectrum: the left speaker's columns, the right's, the bars' steps. */
const BASELINE = 248;
const LEFT_COLUMNS = 31;
const RIGHT_COLUMNS = 41;
const BAR_STEP = 7;

/** The arrows of the position buttons, black, thirteen pixels wide. */
const FIRST = [0b1111111111111, 0b0000001000000, 0b0000011100000, 0b0000111110000, 0b0001111111000, 0b0011111111100, 0b0111111111110];
const UP = [0b0000001000000, 0b0000011100000, 0b0000111110000, 0b0001111111000, 0b0011111111100, 0b0111111111110];
const DOWN = UP.slice().reverse();
const LAST = FIRST.slice().reverse();
const LEFT = [0b00010, 0b00110, 0b01110, 0b11110, 0b01110, 0b00110, 0b00010];
const RIGHT = [0b10000, 0b11000, 0b11100, 0b11110, 0b11100, 0b11000, 0b10000];
/** The signs of +, − and INS↓, bolder than the letters. */
const PLUS = [0b0011000, 0b0011000, 0b1111111, 0b1111111, 0b0011000, 0b0011000];
const MINUS = [0b111111111, 0b111111111];
const INSERT_DOWN = [0b001100, 0b001100, 0b001100, 0b001100, 0b111111, 0b011110, 0b001100];
/** The window menu's two pictures: the editor's track layout, and the notation. */
const LINES = [0b111111110, 0b100000010, 0b111111110, 0b100000010, 0b111111110];
const NOTATION: readonly (readonly string[])[] = [
  ["....#...", "....##..", "....#.#.", "....#...", "..###...", ".####...", "..##...."],
  [".####...#.", "##..##....", "....##..#.", "...##.....", "..##......", "##........", ".........."],
  [".#..#..", "######.", ".#..#..", "######.", ".#..#..", ".......", "......."],
  ["#......", "#......", "#.##...", "##..#..", "#..#...", "###....", "......."]
];

/** The bars' colours across: a red tube, lit down its middle. */
const BAR = [0xb62128, 0xff5a5a, 0xffa6a8, 0xffc6c8, 0xffe4e4, 0xffa6a8, 0xff7a7a, 0xd51312].map(rgb);
/** A meter's colours from its foot up: dark green, green, yellow, orange, red. */
const METER = Array.from({ length: METER_HEIGHT }, (_, step) => {
  const t = step / (METER_HEIGHT - 1);
  const stops: [number, number][] = [[0, 0x058a04], [0.25, 0x03f903], [0.55, 0xf8fd33], [0.8, 0xffa020], [1, 0xff3010]];
  for (let index = 1; index < stops.length; index += 1) {
    const [at, color] = stops[index]!;
    const [from, before] = stops[index - 1]!;
    if (t <= at) return rgb(mix(before, color, (t - from) / (at - from)));
  }
  return rgb(0xff3010);
});

/** A raised gadget: light along the top and left, dark along the bottom and right. */
function raised(s: Surface, x: number, y: number, width: number, height: number, face = GREY): void {
  s.fill(x, y, width, height, face);
  s.fill(x, y, width - 1, 1, LIGHT);
  s.fill(x, y, 1, height - 1, LIGHT);
  s.fill(x + 1, y + height - 1, width - 1, 1, DARK);
  s.fill(x + width - 1, y + 1, 1, height - 1, DARK);
}

/** A sunken box: dark along the top and left, light along the bottom and right. */
function sunken(s: Surface, x: number, y: number, width: number, height: number, face = GREY): void {
  s.fill(x, y, width, height, face);
  s.fill(x, y, width - 1, 1, DARK);
  s.fill(x, y, 1, height - 1, DARK);
  s.fill(x + 1, y + height - 1, width - 1, 1, LIGHT);
  s.fill(x + width - 1, y + 1, 1, height - 1, LIGHT);
}

/** A small picture drawn as text, '#' lit. */
function art(s: Surface, x: number, y: number, rows: readonly string[], color: number): void {
  rows.forEach((row, line) => {
    for (let column = 0; column < row.length; column += 1) if (row[column] === "#") s.pixel(x + column, y + line, color);
  });
}

/** A button with its label in the middle; a button that is on is black, its label grey. */
function button(s: Surface, x: number, y: number, width: number, height: number, label: string, on = false, face = caps): void {
  raised(s, x, y, width, height);
  if (on) s.fill(x + 1, y + 1, width - 2, height - 2, BLACK);
  const tall = face === font ? 7 : face.height;
  if (label) s.text(face, x + Math.round((width - measure(face, label)) / 2), y + Math.floor((height - tall) / 2), label, on ? GREY : BLACK);
}

/** A slider: its well of black and dark grey, and its knob. */
function slider(s: Surface, x: number, width: number, knob: number): void {
  sunken(s, x - 1, 17, width + 2, 15, BLACK);
  for (let y = 18; y < 31; y += 1) for (let column = x; column < x + width; column += 1) if ((column + y) & 1) s.pixel(column, y, DARK);
  raised(s, knob, 18, 6, 13, LIGHT);
}

/**
 * The program's name in metal: the letters' shadow to the lower right, their faces light at
 * the top and darker below, a brighter top edge and a darker lower one.
 */
function metal(s: Surface, x: number, y: number, text: string): number {
  let at = x;
  for (const char of text) {
    const glyph = logo.glyphs.get(char);
    if (!glyph) {
      at += 6;
      continue;
    }
    const lit = (row: number, column: number): boolean => row >= 0 && row < glyph.rows.length && column >= 0 && column < glyph.width && ((glyph.rows[row]! >> (glyph.width - 1 - column)) & 1) === 1;
    for (let row = 0; row < glyph.rows.length; row += 1) {
      for (let column = 0; column < glyph.width; column += 1) {
        if (!lit(row, column)) continue;
        if (!lit(row + 1, column + 1)) s.pixel(at + column + 1, y + row + 1, rgb(0x444455));
      }
    }
    for (let row = 0; row < glyph.rows.length; row += 1) {
      for (let column = 0; column < glyph.width; column += 1) {
        if (!lit(row, column)) continue;
        let color = mix(0xf0f0ff, 0x8a8a9c, row / (glyph.rows.length - 1));
        if (!lit(row - 1, column)) color = 0xffffff;
        else if (!lit(row + 1, column) || !lit(row, column + 1)) color = mix(color, 0x555566, 0.45);
        s.pixel(at + column, y + row, rgb(color));
      }
    }
    at += glyph.width + 3;
  }
  return at;
}

/** A glint where two lines of the title strip cross: a bright point on a vertical line. */
function glint(s: Surface, x: number, y: number, height: number): void {
  for (let row = 0; row < height; row += 1) {
    const t = 1 - Math.abs(row - (height - 1) / 2) / (height / 2);
    s.pixel(x, y + row, rgb(mix(0x555566, 0xffffff, t)));
  }
  s.fill(x - 3, y + Math.floor(height / 2), 7, 1, rgb(0xddddee));
  s.pixel(x - 1, y + Math.floor(height / 2) - 1, rgb(0xbbbbcc));
  s.pixel(x + 1, y + Math.floor(height / 2) + 1, rgb(0xbbbbcc));
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, GREY);
  // The title strip: TIMER and its box, the program's name between its glints, its author.
  s.fill(0, 0, WIDTH, 13, BLACK);
  s.text(wide, 3, 3, "TIMER", WHITE);
  raised(s, 50, 0, 49, 13, rgb(0xaaaabb));
  s.fill(101, 1, 2, 11, rgb(0x777788));
  s.fill(104, 5, 20, 2, rgb(0xbbbbcc));
  s.fill(104, 7, 20, 1, rgb(0x666677));
  glint(s, 109, 1, 11);
  const name = metal(s, 125, 1, "OctaMED");
  s.fill(name + 1, 6, 7, 2, rgb(0xaaaabb));
  const professional = metal(s, name + 11, 1, "Professional");
  s.fill(professional, 6, 7, 2, rgb(0xaaaabb));
  let version = professional + 10;
  for (const char of "(v4.00)") version = s.text(thin, version, 2, char, rgb(0xccccdd));
  s.fill(version + 2, 4, WIDTH - version - 2, 1, rgb(0xccccdd));
  s.fill(version + 2, 5, WIDTH - version - 2, 1, rgb(0x777788));
  s.fill(476, 9, 30, 1, rgb(0x9999aa));
  glint(s, 496, 0, 13);
  s.text(small, 506, 6, "BY TEIJO KINNUNEN", rgb(0xdddde8));
  // The panel.
  s.fill(0, 13, WIDTH, 1, LIGHT);
  s.fill(0, 14, 1, 50, LIGHT);
  s.fill(WIDTH - 1, 14, 1, 51, DARK);
  s.fill(0, 64, WIDTH, 1, DARK);
  // The song's positions and their buttons.
  raised(s, 8, 16, 99, 47);
  sunken(s, 12, 18, 36, 44);
  button(s, 48, 18, 20, 10, "");
  s.bits(52, 19, FIRST, 13, BLACK);
  button(s, 48, 29, 20, 11, "");
  s.bits(52, 31, UP, 13, BLACK);
  s.fill(48, 40, 21, 1, BLACK);
  button(s, 48, 41, 20, 10, "");
  s.bits(52, 43, DOWN, 13, BLACK);
  button(s, 48, 52, 20, 10, "");
  s.bits(52, 53, LAST, 13, BLACK);
  button(s, 68, 18, 19, 11, "");
  s.bits(74, 20, PLUS, 7, BLACK);
  button(s, 88, 18, 17, 11, "");
  s.bits(92, 22, MINUS, 9, BLACK);
  button(s, 68, 29, 37, 11, "INS");
  button(s, 68, 40, 37, 11, "DEL");
  button(s, 68, 51, 37, 11, "");
  s.text(caps, 73, 54, "INS", BLACK);
  s.bits(94, 53, INSERT_DOWN, 6, BLACK);
  // The two sliders, each with its arrows.
  slider(s, 107, 186, 200);
  button(s, 296, 17, 15, 15, "");
  s.bits(301, 21, LEFT, 5, BLACK);
  button(s, 311, 17, 16, 15, "");
  s.bits(316, 21, RIGHT, 5, BLACK);
  slider(s, 331, 85, 341);
  button(s, 418, 17, 18, 15, "");
  s.bits(424, 21, LEFT, 5, BLACK);
  button(s, 436, 17, 20, 15, "");
  s.bits(443, 21, RIGHT, 5, BLACK);
  // Volumes in hex, the filter, the effect levels, the tempo.
  s.text(caps, 106, 36, "VOL:", BLACK);
  button(s, 133, 33, 28, 11, "HEX", true);
  button(s, 162, 33, 31, 11, "DEC");
  button(s, 194, 33, 51, 11, "FILTER");
  button(s, 246, 33, 27, 11, "E1", true);
  button(s, 274, 33, 26, 11, "E2", true);
  button(s, 301, 33, 25, 11, "E3", true);
  button(s, 327, 33, 28, 11, "STS", true);
  button(s, 357, 33, 40, 11, "BPM", false, font);
  raised(s, 398, 33, 59, 11);
  // The channel mode, STOP, PLAY and CONT.
  s.text(tight, 107, 46, "CH.MODE:", BLACK);
  button(s, 160, 44, 27, 10, "HQ");
  ["4", "5", "6", "7", "8"].forEach((label, index) => button(s, 108 + index * 15, 53, 15, 10, label, index === 0));
  button(s, 188, 44, 35, 19, "");
  s.text(caps, 192, 50, "STOP", BLACK);
  button(s, 346, 44, 112, 10, "CONT. SONG");
  button(s, 232, 53, 100, 10, "PLAY BLOCK");
  button(s, 332, 53, 14, 10, "D");
  button(s, 346, 53, 112, 10, "CONT. BLOCK");
  // The window menu.
  s.fill(459, 14, 2, 50, DARK);
  s.fill(461, 14, 1, 50, LIGHT);
  const menu = [["FILES", "PLAY", "INSTR", "BLOCK", "EDIT"], ["MISC", "VOL", "MIDI", "TRANS", "RANGE"], ["", "", "SYNTH", "SMPED", "SLIST"]];
  const columns: [number, number][] = [[463, 55], [520, 56], [578, 60]];
  for (let column = 0; column < 3; column += 1) {
    const [x, width] = columns[column]!;
    for (let row = 0; row < 5; row += 1) {
      const y = 15 + row * 10;
      const on = (column === 0 && row === 1) || (column === 2 && row === 0);
      raised(s, x, y, width, 10);
      if (on) s.fill(x + 1, y + 1, width - 2, 8, BLACK);
      s.text(wide, x + 3, y + 2, menu[column]![row]!, on ? GREY : BLACK);
    }
  }
  for (let index = 0; index < 4; index += 1) s.bits(583 + index * 13, 17, LINES, 9, GREY);
  [582, 595, 610, 622].forEach((x, index) => art(s, x, 27, NOTATION[index]!, BLACK));
  // The line under the panel: position, block, octave, edit, spacing, chords, the tracks, the instrument.
  s.fill(0, 65, WIDTH, 1, LIGHT);
  s.fill(0, 76, WIDTH, 1, DARK);
  raised(s, 3, 66, 86, 10);
  raised(s, 91, 66, 62, 10);
  raised(s, 155, 66, 22, 10);
  s.text(cells, 159, 68, "12", BLACK);
  button(s, 178, 66, 14, 10, "E");
  button(s, 193, 66, 20, 10, "SP");
  button(s, 214, 66, 35, 10, "CHRD", false, tight);
  for (let index = 0; index < 8; index += 1) {
    const x = 250 + index * 10;
    raised(s, x, 66, 10, 10, LIGHT);
    s.fill(x + 2, 67, 6, 3, BLACK);
    s.fill(x + 2, 71, 6, 4, index < TRACKS ? BLACK : DARK);
  }
  raised(s, 330, 66, 22, 10);
  sunken(s, 353, 66, 213, 10);
  button(s, 567, 66, 11, 10, "");
  s.bits(569, 67, LEFT, 5, BLACK);
  button(s, 578, 66, 11, 10, "");
  s.bits(582, 67, RIGHT, 5, BLACK);
  raised(s, 590, 66, 47, 10);
  s.text(cells, 592, 68, "01/01", BLACK);
  // The editor's black (its lines are drawn as the song moves).
  s.fill(0, EDITOR_TOP, WIDTH, EDITOR_LINES * LINE, BLACK);
  // The memory line.
  raised(s, 2, 197, 175, 10);
  s.text(font, 4, 198, "Mem", BLACK);
  s.text(cells, 45, 198, "8080680/", BLACK);
  s.text(cells, 117, 198, "3236832", BLACK);
  sunken(s, 178, 197, 225, 10, BLACK);
  sunken(s, 405, 197, 202, 10, BLACK);
  raised(s, 608, 197, 31, 10);
  s.text(font, 612, 198, "NRM", BLACK);
  // The spectrum: its scales at the sides and in the middle, the ruler along its foot.
  s.fill(0, 207, WIDTH, 1, LIGHT);
  s.fill(0, 255, WIDTH, 1, DARK);
  s.fill(15, 215, 1, 34, BLACK);
  s.fill(620, 215, 1, 34, BLACK);
  s.fill(264, 215, 1, 34, BLACK);
  s.fill(280, 215, 1, 34, BLACK);
  for (let step = 0; step < 9; step += 1) {
    const y = 216 + step * 4;
    s.fill(9, y, 6, 1, BLACK);
    s.fill(621, y, 6, 1, BLACK);
    s.fill(265, y, 15, 1, BLACK);
  }
  s.fill(15, BASELINE, 606, 1, BLACK);
  for (let x = 16; x < 620; x += 8) s.fill(x, BASELINE + 1, 1, 3, BLACK);
  return s;
}

/** A track's cell as OctaMED writes it: note, instrument (a digit of base 32), command and its byte. */
function cellText(cell: Cell): string {
  const pitched = cell.note >= 0 && cell.note < 120;
  const note = pitched ? noteText(cell.note) : "---";
  const instrument = cell.instrument > 0 ? (cell.instrument % 32).toString(32).toUpperCase() : "0";
  const p = cell.param & 255;
  let command = "0000";
  switch (cell.effect) {
    case "arpeggio": command = `00${hex(p, 2)}`; break;
    case "slideUp": command = `01${hex(p, 2)}`; break;
    case "slideDown": command = `02${hex(p, 2)}`; break;
    case "tonePorta": command = `03${hex(p, 2)}`; break;
    case "vibrato": command = `04${hex(p, 2)}`; break;
    case "volumeSlide": command = `0D${hex(p, 2)}`; break;
    case "volume": command = `0C${hex(Math.min(64, p), 2)}`; break;
    case "speed": command = `09${hex(Math.min(32, p), 2)}`; break;
    case "tempo": command = `0F${hex(p, 2)}`; break;
    case "offset": command = `19${hex(p, 2)}`; break;
    case "retrigger": command = `1F${hex(p & 15, 2)}`; break;
    case "cut": command = `18${hex(p & 15, 2)}`; break;
    default:
      if (pitched && cell.volume >= 0 && cell.volume < 0x38) command = `0C${hex(cell.volume, 2)}`;
  }
  return `${note} ${instrument}${command}`;
}

export function createOctaMED(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const meters = new Float32Array(TRACKS);
  const seen = new Float64Array(TRACKS);
  const heard = new Float64Array(TRACKS);
  /** The spectrum's bars: each column's height in steps (fractional, sinking). */
  const bars = new Float32Array(LEFT_COLUMNS + RIGHT_COLUMNS);
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;
  let length = 1;
  let last = 2;

  /** The song's positions around the one playing: the block each plays. */
  const drawPositions = (s: Surface): void => {
    s.fill(13, 19, 34, 42, GREY);
    s.fill(13, 35, 34, 8, DARK);
    for (let index = 0; index < 5; index += 1) {
      const at = song.position + index - 2;
      if (at < 0 || at >= length) continue;
      const y = 20 + index * 8;
      const text = decimal(song.patternAt(at), 2);
      s.text(cells, 32, y + 1, text, DARK);
      s.text(cells, 31, y, text, index === 2 ? WHITE : LIGHT);
    }
  };

  const drawEditor = (s: Surface): void => {
    s.fill(0, EDITOR_TOP, WIDTH, EDITOR_LINES * LINE, BLACK);
    const current = song.row;
    for (let line = 0; line < EDITOR_LINES; line += 1) {
      const row = current + line - PLAY_LINE;
      if (row < 0 || row >= ROWS) continue;
      const y = EDITOR_TOP + 1 + line * LINE;
      const playing = line === PLAY_LINE;
      if (playing) s.fill(0, y - 1, WIDTH, LINE + 1, DARK);
      const color = playing ? GREY : TEXT;
      // The line's number, then the tracks side by side.
      let text = `${decimal(row, 3)} `;
      for (let track = 0; track < TRACKS; track += 1) text += cellText(song.cell(track, row, cell));
      s.text(cells, 0, y, text, color, 1, 2);
    }
    // The tracks' rules, darker where they cross the play line; the edit cursor on track 0.
    const top = EDITOR_TOP + 1 + PLAY_LINE * LINE - 1;
    for (let track = 1; track < TRACKS; track += 1) {
      const x = TRACK_LEFT + track * TRACK_STEP - 1;
      s.fill(x, EDITOR_TOP, 1, EDITOR_LINES * LINE, rgb(0xddaaaa));
      s.fill(x - 1, top, 2, LINE + 1, CURSOR);
    }
    s.fill(TRACK_LEFT, top, 48, 1, CURSOR);
    s.fill(TRACK_LEFT, top + LINE, 48, 1, CURSOR);
    s.fill(TRACK_LEFT, top, 1, LINE + 1, CURSOR);
    s.fill(TRACK_LEFT + 47, top, 1, LINE + 1, CURSOR);
    // The tracks' numbers over their first line, and how many there are.
    for (let track = 0; track < TRACKS; track += 1) s.text(cells, TRACK_LEFT + track * TRACK_STEP + 56, EDITOR_TOP + 1, String(track), PINK);
    s.text(cells, 56, EDITOR_TOP + 1 + LINE, String(TRACKS), PINK);
  };

  /** The line under the panel, and the tempo. */
  const drawInfo = (s: Surface): void => {
    s.fill(4, 67, 84, 8, GREY);
    s.text(cells, 7, 68, `${decimal(song.position + 1, 4)}/${decimal(length, 4)}`, BLACK);
    let blocks = 0;
    for (let at = 0; at < length; at += 1) blocks = Math.max(blocks, song.patternAt(at) + 1);
    s.fill(92, 67, 60, 8, GREY);
    s.text(cells, 91, 68, `${decimal(song.pattern, 3)}/${decimal(blocks, 3)}`, BLACK);
    s.fill(399, 34, 57, 9, GREY);
    s.text(cells, 399, 35, decimal(song.bpm, 3), BLACK);
    s.text(cells, 425, 35, "/", BLACK);
    s.text(cells, 438, 35, "04", BLACK);
  };

  /** What changes every frame: the timer, the instrument last played, the song's name, PLAY SONG. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    s.text(cells, 55, 2, clock(song.time), BLACK);
    for (let track = 0; track < TRACKS; track += 1) {
      const hits = song.hits(track);
      if (hits !== heard[track]) {
        heard[track] = hits;
        if (song.instrumentOf(track) > 0) last = track;
      }
    }
    const instrument = Math.max(1, song.instrumentOf(last) || 1);
    s.text(cells, 334, 68, decimal(instrument, 2), BLACK);
    s.text(font, 357, 68, INSTRUMENTS[(instrument - 1) % INSTRUMENTS.length]!, BLACK);
    let name = printable(frame.track.title.replace(/[\u2012-\u2015]/g, "-"), font).replace(/\s+/g, " ").trim();
    if (name.length > 24) name = name.slice(0, 24);
    s.text(font, 408, 198, name, TEXT);
    // PLAY SONG is held down while the song plays.
    button(s, 232, 44, 114, 10, "PLAY SONG", song.playing);
  };

  /** Each track's meter rises from the editor's foot and falls back as OctaMED's did. */
  const drawMeters = (s: Surface, dt: number): void => {
    const bottom = EDITOR_TOP + EDITOR_LINES * LINE - 1;
    for (let track = 0; track < TRACKS; track += 1) {
      const hits = song.hits(track);
      let value = meters[track]! - dt * 1.4;
      if (hits !== seen[track]) {
        seen[track] = hits;
        value = Math.max(value, song.hitVolume(track));
      }
      value = Math.max(value, song.level(track) * 0.9);
      meters[track] = Math.max(0, Math.min(1, value));
      const height = Math.round(meters[track]! * METER_HEIGHT);
      if (height <= 0) continue;
      const x = TRACK_LEFT + track * TRACK_STEP + METER_LEFT;
      s.fill(x, bottom - height + 1, 2, height, TEXT);
      s.fill(x + 16, bottom - height + 1, 2, height, TEXT);
      for (let step = 0; step < height; step += 1) s.fill(x + 2, bottom - step, 14, 1, METER[step]!);
    }
  };

  /**
   * The spectrum of the notes played: a note's column (the left speaker's tracks 0 and 3 on the
   * left half, the right's 1 and 2 on the right) jumps to its loudness and sinks a step at a time.
   */
  const drawSpectrum = (s: Surface, dt: number): void => {
    for (let index = 0; index < bars.length; index += 1) bars[index] = Math.max(0, bars[index]! - dt * 3);
    for (let track = 0; track < TRACKS; track += 1) {
      const note = song.noteOf(track);
      if (note < 0 || note > 119 || song.level(track) <= 0.02) continue;
      // A column a semitone, from C-1.
      const left = track === 0 || track === 3;
      const columns = left ? LEFT_COLUMNS : RIGHT_COLUMNS;
      const column = Math.max(0, Math.min(columns - 1, note - SPEC.low));
      const first = left ? 0 : LEFT_COLUMNS;
      // The note's column at its loudness, a step lower a semitone either side.
      const steps = 1 + song.level(track) * 3.99;
      for (let offset = -1; offset <= 1; offset += 1) {
        const at = column + offset;
        if (at < 0 || at >= columns) continue;
        bars[first + at] = Math.max(bars[first + at]!, steps - Math.abs(offset));
      }
    }
    for (let index = 0; index < bars.length; index += 1) {
      const steps = Math.floor(bars[index]!);
      if (steps <= 0) continue;
      const height = steps * BAR_STEP + 1;
      const x = index < LEFT_COLUMNS ? 16 + index * 8 : 288 + (index - LEFT_COLUMNS) * 8;
      for (let column = 0; column < 8; column += 1) s.fill(x + column, BASELINE - height, 1, height, BAR[column]!);
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
      const nextLength = song.length(frame.track.duration);
      if (song.changes !== drawn || nextLength !== length) {
        drawn = song.changes;
        length = nextLength;
        drawPositions(base);
        drawInfo(base);
        drawEditor(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawMeters(screen, frame.dt);
      drawSpectrum(screen, frame.dt);
      target.close(image);
    }
  };
}
