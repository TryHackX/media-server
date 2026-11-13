import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { VGA } from "./fonts";
import { decimal, hex, letterEffect, noteText } from "./notation";
import { printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, NOTE_CUT, NOTE_OFF, ROWS, Song, type SongSpec } from "./song";

/**
 * Scream Tracker 3.21 (DOS, 1994) playing along: its Pattern Editor (F2) on the 80 × 50 text
 * screen of a VGA, each character 8 × 8 — the tan desk with the song's fields in black wells,
 * the help lines, five channels of notes, instruments, volumes and commands under their
 * headers, every fourth row shaded, every sixteenth more, and the row playing lit across.
 *
 * The module is song.ts's: drums on L1 (a snare that meets a kick moves to L3), the bass on R1,
 * the lead on L2 and R2 by the side it is heard on, hi-hats and chords on L3.
 */

const WIDTH = 640;
const HEIGHT = 400;
const CELL = 8;

const TAN = rgb(0xa69255);
const YELLOW = rgb(0xffdf86);
const BROWN = rgb(0x514528);
const BLACK = rgb(0x000000);
const GREEN = rgb(0x00b200);
const TEXT = rgb(0x9a9692);
const BEAT = rgb(0x302c28);
const BAR = rgb(0x49413c);

const font = sheet(VGA.sheet, VGA.cell, VGA.height, VGA.fixed);

const CHANNELS = 5;
const NAMES = ["L1", "R1", "L2", "R2", "L3"];
/** The pattern: columns of the first channel, rows on screen, the row the play row sits on. */
const FIRST = 5;
const STEP = 14;
const TOP = 16;
const VISIBLE = 32;
const PLAY = 15;

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"], side: -1 }, { parts: ["lead"], side: 1 }, { parts: ["snare", "hats", "chord"] }],
  low: 0,
  high: 95,
  drums: { kick: 48, snare: 50, hats: 54 },
  floors: { bass: 24, lead: 48, chord: 36 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 256,
  noteOff: true,
  seed: 321
};

const INSTRUMENTS = ["Bassdrum", "Snare", "Hihat closed", "Hihat open", "Bass", "Lead", "Strings", "Lead echo"];

/** The cell's top-left pixel. */
const at = (column: number): number => column * CELL;

/**
 * The song's fields: black wells sunk into the desk, a brown edge along their tops and lefts,
 * a light one along their bottoms and rights, and a column dropping out of a wide one with its
 * corner cut at 45° (the Row, Channel and Baseoctave fields). Rectangles in cells, inclusive.
 */
function wells(s: Surface, boxes: readonly (readonly [number, number, number, number])[], cuts: readonly (readonly [number, number])[]): void {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (const [c0, r0, c1, r1] of boxes) {
    for (let y = at(r0); y < at(r1 + 1); y += 1) mask.fill(1, y * WIDTH + at(c0), y * WIDTH + at(c1 + 1));
  }
  // A cut corner: the cell's upper-right triangle is part of the well.
  for (const [column, row] of cuts) {
    for (let i = 0; i < CELL; i += 1) mask.fill(1, (at(row) + i) * WIDTH + at(column) + i + 1, (at(row) + i) * WIDTH + at(column + 1));
  }
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT && mask[y * WIDTH + x] === 1;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (inside(x, y)) {
        s.pixel(x, y, BLACK);
        continue;
      }
      // Two pixels of edge: light below and right of a well, brown above and left.
      if (inside(x - 1, y) || inside(x - 2, y) || inside(x, y - 1) || inside(x, y - 2)) s.pixel(x, y, YELLOW);
      else if (inside(x + 1, y) || inside(x + 2, y) || inside(x, y + 1) || inside(x, y + 2)) s.pixel(x, y, BROWN);
    }
  }
  // Along a cut, no edge: the well's black meets the desk.
  for (const [column, row] of cuts) {
    for (let i = 0; i < CELL; i += 1) for (let x = at(column); x <= at(column) + i; x += 1) s.pixel(x, at(row) + i, TAN);
  }
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, TAN);
  // The desk's raised edge.
  s.fill(0, 0, WIDTH, 2, YELLOW);
  s.fill(0, 0, 2, HEIGHT, YELLOW);
  s.fill(0, HEIGHT - 2, WIDTH, 2, BROWN);
  s.fill(WIDTH - 2, 0, 2, HEIGHT, BROWN);
  const put = (column: number, row: number, text: string, color: number): void => {
    s.text(font, at(column), at(row), text, color);
  };
  put(6, 1, "Scream Tracker V3.21", YELLOW);
  put(35, 1, "Copyright (C) 1993,1994 Sami Tammilehto", YELLOW);
  wells(s, [[13, 3, 42, 4], [13, 5, 19, 5], [13, 6, 14, 6], [27, 5, 28, 6], [41, 5, 42, 6], [52, 3, 76, 4], [52, 5, 53, 6], [75, 5, 76, 6]], [[26, 5], [40, 5], [74, 5]]);
  put(9, 3, "Song", BROWN);
  put(3, 4, "Instrument", BROWN);
  put(8, 5, "Order", BROWN);
  put(6, 6, "Pattern", BROWN);
  put(23, 6, "Row", BROWN);
  put(33, 6, "Channel", BROWN);
  put(48, 3, "File", BROWN);
  put(47, 4, "Chord", BROWN);
  put(45, 5, "C.Tempo", BROWN);
  put(45, 6, "C.Speed", BROWN);
  put(64, 6, "Baseoctave", BROWN);
  put(63, 8, "FreeMem:   347K", BROWN);
  put(63, 9, "FreeEMS: 15360K", BROWN);
  put(63, 10, "FreeGUS:   624K", BROWN);
  put(3, 10, "ESC ..... Main Menu", YELLOW);
  put(3, 11, "F10 ..... Quick-Help", YELLOW);
  put(3, 12, "CTRL-Q .. Quit to DOS", YELLOW);
  put(27, 10, "F1..F4 .. Edit Screen", YELLOW);
  put(27, 11, "CTRL-L .. Load Module", YELLOW);
  put(27, 12, "F5/F8 ... Play / Stop", YELLOW);
  // The editor's title on a dotted rule.
  for (let x = 8; x < WIDTH - 8; x += 2) if (x < at(29) - 2 || x >= at(48) + 1) s.pixel(x, at(14) + 3, BROWN);
  put(29, 14, "Pattern Editor (F2)", BROWN);
  // The channels' headers, and the pattern's frame: brown above and left, light below and right.
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const column = FIRST + 1 + channel * STEP;
    s.fill(at(column), at(15), 8 * CELL, CELL, BROWN);
    put(column + 1, 15, `0${channel + 1}: ${NAMES[channel]}`, YELLOW);
  }
  const left = at(FIRST);
  const right = at(FIRST + CHANNELS * STEP - 1);
  s.fill(left, at(TOP), right - left, VISIBLE * CELL, BLACK);
  for (let channel = 0; channel < CHANNELS - 1; channel += 1) s.fill(at(FIRST + channel * STEP + 13) + 2, at(TOP), 4, VISIBLE * CELL, TAN);
  s.fill(left - 2, at(TOP) - 2, right - left + 2, 2, BROWN);
  s.fill(left - 2, at(TOP) - 2, 2, VISIBLE * CELL + 2, BROWN);
  s.fill(right, at(TOP) - 2, 2, VISIBLE * CELL + 4, YELLOW);
  s.fill(left - 2, at(TOP + VISIBLE), right - left + 4, 2, YELLOW);
  // The marks under the column the cursor is in: the note's.
  for (let i = 0; i < 3; i += 1) s.bits(at(FIRST + i) + 1, at(TOP + VISIBLE) + 3, [0b0001000, 0b0011100, 0b0111110], 7, YELLOW);
  return s;
}

/** A DOS name for the track: its first word or two, lower-case, eight letters at most. */
function fileName(title: string): string {
  const name = printable(title.split(/\s[—–-]\s/)[0] ?? "", font).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8);
  return `${name || "untitled"}.s3m`;
}

export function createScreamTracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  // The screen with the pattern as it stands, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  const put = (s: Surface, column: number, row: number, text: string, color: number, background?: number): void => {
    if (background !== undefined) s.fill(at(column), at(row), text.length * CELL, CELL, background);
    s.text(font, at(column), at(row), text, color);
  };

  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const title = printable(frame.track.title, font).replace(/\s+/g, " ").trim();
    put(s, 13, 3, title.slice(0, 28), GREEN);
    put(s, 13, 4, `01: ${INSTRUMENTS[0]}`.slice(0, 30), GREEN);
    put(s, 13, 5, decimal(song.position, 3), GREEN);
    put(s, 16, 5, "/", BROWN);
    put(s, 17, 5, decimal(song.length(frame.track.duration), 3), GREEN);
    put(s, 13, 6, decimal(song.pattern, 2), GREEN);
    put(s, 27, 6, decimal(song.row, 2), GREEN);
    put(s, 41, 6, "01", GREEN);
    put(s, 52, 3, `${fileName(frame.track.title)} (S3M)`, GREEN);
    put(s, 52, 4, "none", GREEN);
    put(s, 52, 5, hex(song.bpm, 2), GREEN);
    put(s, 52, 6, "06", GREEN);
    put(s, 76, 6, "4", GREEN);
  };

  /** One channel's cell as Scream Tracker writes it: "C-4 01 32 J37", dots where empty. */
  const cellText = (channel: number, row: number): string => {
    song.cell(channel, row, cell);
    const note = cell.note === NOTE_OFF || cell.note === NOTE_CUT ? "^^." : noteText(cell.note, "...");
    const instrument = cell.instrument ? decimal(cell.instrument, 2) : "..";
    const volume = cell.volume >= 0 && cell.volume < 64 && cell.note >= 0 ? decimal(cell.volume, 2) : "..";
    return `${note} ${instrument} ${volume} ${letterEffect(cell.effect, cell.param) ?? ".00"}`;
  };

  const drawPattern = (s: Surface): void => {
    const current = song.row;
    for (let line = 0; line < VISIBLE; line += 1) {
      const row = current - PLAY + line;
      const y = TOP + line;
      if (row < 0 || row >= ROWS) continue;
      const playing = line === PLAY;
      const background = playing ? BROWN : row % 16 === 0 ? BAR : row % 4 === 0 ? BEAT : BLACK;
      const color = playing ? YELLOW : TEXT;
      put(s, 2, y, decimal(row, 2), playing ? YELLOW : BROWN);
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const column = FIRST + channel * STEP;
        put(s, column, y, cellText(channel, row), color, background);
        // The separator: a strip of the desk between two channels.
        if (channel < CHANNELS - 1) s.fill(at(column + 13) + 2, at(y), 4, CELL, TAN);
      }
    }
    // The cursor on the first channel's note.
    const y = TOP + PLAY;
    s.fill(at(FIRST), at(y), CELL, CELL, YELLOW);
    s.text(font, at(FIRST), at(y), cellText(0, current).slice(0, 1), BLACK);
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
        base.copy(chrome, 0, at(TOP), WIDTH, VISIBLE * CELL, 0, at(TOP));
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      target.close(image);
    }
  };
}
