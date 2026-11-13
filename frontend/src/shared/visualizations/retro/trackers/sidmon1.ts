import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { readSheet, SM1_LABEL, SM1_VALUE, sidmonNote } from "./fonts-sidmon1";
import { rgb, Surface, Target } from "./raster";
import { type StepEntry, StepSequence } from "./sequence-amiga2";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * SidMon 1 (Amiga, Reinier van Vliet for Turtle Byte, 1989), playing along: the 320 × 256
 * pattern editor, where its PLAY and STOP are — light grey plates with blue edges and bracket
 * corners, a step list and a pattern of one voice in black fields (NOTE, INST, BEND TO, BEND
 * SPEED), the PLAY, STOP and EDIT plates, and the program's name cut down a plate of its own.
 *
 * A SidMon pattern holds one voice; this one is the lead's, read from song.ts's module, its
 * number given by sequence-amiga2.ts from the rows' shape. The step playing is lit and the list
 * moves with it. A bend (BEND TO a note at BEND SPEED) is where the module slides to a note.
 * Everything is drawn here, with the lettering of fonts-sidmon1.ts, after screenshots of the
 * program; nothing of it was used.
 */

const WIDTH = 320;
const HEIGHT = 256;

/** The program's colours: black, the plates' grey, white, two blues and a blue-black. */
const BLACK = rgb(0x000000);
const GREY = rgb(0xbfbfbf);
const WHITE = rgb(0xf0f0f0);
const NAVY = rgb(0x102040);
const BLUE = rgb(0x5070a0);
const INK = rgb(0x000020);

const LABEL = readSheet(SM1_LABEL);
const VALUE = readSheet(SM1_VALUE);

/** An engraved label: '#' the dark blue, '+' the light; a column between letters, four for a space. */
function label(s: Surface, x: number, y: number, text: string): void {
  for (const char of text) {
    if (char === " ") {
      x += 5;
      continue;
    }
    const glyph = LABEL.get(char);
    if (!glyph) continue;
    glyph.rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx += 1) {
        if (row[dx] === "#") s.pixel(x + dx, y + dy, NAVY);
        else if (row[dx] === "+") s.pixel(x + dx, y + dy, BLUE);
      }
    });
    x += glyph.width + 1;
  }
}

/** White figures and letters, one to a cell of eight. */
function value(s: Surface, x: number, y: number, text: string): void {
  for (const char of text) {
    const glyph = VALUE.get(char);
    if (glyph) {
      glyph.rows.forEach((row, dy) => {
        for (let dx = 0; dx < row.length; dx += 1) if (row[dx] === "#") s.pixel(x + dx, y + dy, WHITE);
      });
    }
    x += 8;
  }
}

/**
 * The bracket at a plate's corner, row by row from the corner: the inner line turning into a
 * short stub along the top or bottom. On the left it starts at the line and runs right, its ends
 * dark blue; on the right it runs left to the line, its ends blue-black.
 */
const LEFT_ARC = ["NBBBBBNN", "BBBNN", "BBN", "BN", "BN"];
const RIGHT_ARC = ["kkBBBBBk", "kkBBB", "kBB", "kB", "kB"];

function bracket(s: Surface, x: number, y: number, right: boolean, down: boolean): void {
  (right ? RIGHT_ARC : LEFT_ARC).forEach((run, step) => {
    const yy = down ? y - step : y + step;
    const from = right ? x - run.length + 1 : x;
    for (let i = 0; i < run.length; i += 1) s.pixel(from + i, yy, run[i] === "B" ? BLUE : run[i] === "N" ? NAVY : INK);
  });
}

/**
 * A plate: grey, lit along its top and left (blue), in shadow along its right and bottom (dark
 * blue), a line inside each side that turns at the corners into the plate's bracket.
 */
function plate(s: Surface, x0: number, y0: number, x1: number, y1: number, options: { top?: boolean; bottom?: number } = {}): void {
  const atTop = options.top === true;
  const bottomRows = options.bottom ?? 2;
  s.fill(x0, y0, x1 - x0 + 1, y1 - y0 + 1, GREY);
  if (!atTop) s.fill(x0, y0, x1 - x0 - 1, 2, BLUE);
  s.fill(x0, y0, 2, y1 - y0 - 3, BLUE);
  s.fill(x0, y1 - 3, 2, 4, BLACK);
  s.fill(x1 - 1, y0, 2, y1 - y0 + 1, NAVY);
  s.fill(x0 + 2, y1 - bottomRows + 1, x1 - x0 - 1, bottomRows, NAVY);
  const top = atTop ? y0 + 2 : y0 + 3;
  const bottom = y1 - bottomRows - 1;
  s.fill(x0 + 3, top, 1, bottom - top + 1, BLUE);
  s.fill(x1 - 3, top, 1, bottom - top + 1, BLUE);
  bracket(s, x0 + 3, top, false, false);
  bracket(s, x1 - 3, top, true, false);
  bracket(s, x0 + 3, bottom, false, true);
  bracket(s, x1 - 3, bottom, true, true);
}

/** A black field cut into a plate: dark above and left, blue below and right. */
function field(s: Surface, x0: number, y0: number, x1: number, y1: number): void {
  s.fill(x0, y0, x1 - x0 + 1, 2, NAVY);
  s.fill(x0, y0, 2, y1 - y0 + 1, NAVY);
  s.fill(x0 + 2, y1 - 1, x1 - x0 - 1, 2, BLUE);
  s.fill(x1 - 1, y0 + 2, 2, y1 - y0 - 1, BLUE);
  s.fill(x0 + 2, y0 + 2, x1 - x0 - 3, y1 - y0 - 3, BLACK);
}

/** A small button of the PATTERN NR plate, with its sign. */
function smallButton(s: Surface, x: number, y: number, plus: boolean): void {
  s.fill(x, y, 7, 1, BLUE);
  s.fill(x, y, 1, 9, BLUE);
  s.fill(x + 1, y + 9, 7, 1, NAVY);
  s.fill(x + 7, y + 1, 1, 9, NAVY);
  s.fill(x + 2, y + 4, 4, 1, NAVY);
  if (plus) s.fill(x + 3, y + 2, 1, 5, NAVY);
}

/** An engraved line from (x0, y0) to (x1, y1): dark, with a light line beside it, below and right. */
function cut(s: Surface, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    s.pixel(x + 1, y + 1, BLUE);
  }
  for (let i = 0; i <= steps; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    s.pixel(x, y, NAVY);
  }
}

/**
 * The program's name down its plate: each letter a shape of strokes, of which only the edges are
 * drawn, dark where the plate's light falls on them (above and left), blue below and right.
 */
type Stroke = readonly (readonly [number, number])[];

const LOGO: readonly (readonly Stroke[])[] = [
  // S
  [[[16, 4], [13, 2], [6, 2], [2, 5], [3, 8], [9, 10], [15, 12], [16, 16], [13, 19], [6, 19], [2, 16]]],
  // I
  [[[10, 2], [10, 19]], [[5, 2], [15, 2]], [[5, 19], [15, 19]]],
  // D
  [[[3, 2], [3, 19]], [[3, 2], [10, 2], [15, 5], [16, 10], [15, 16], [10, 19], [3, 19]]],
  // M
  [[[2, 19], [2, 2], [10, 11], [17, 2], [17, 19]]],
  // O
  [[[10, 2], [14, 3], [16, 7], [16, 14], [14, 18], [10, 19], [6, 18], [3, 14], [3, 7], [6, 3], [10, 2]]],
  // N
  [[[3, 19], [3, 2], [16, 19], [16, 2]]]
];
const LETTER_W = 20;
const LETTER_H = 22;
const STROKE = 2.5;
/** Where the logo's glints sparkle (centre, arm length). */
const GLINTS: readonly (readonly [number, number, number])[] = [[283, 57, 3], [286, 76, 2], [304, 116, 3], [283, 170, 3]];

function logoMask(strokes: readonly Stroke[]): Uint8Array {
  const mask = new Uint8Array(LETTER_W * LETTER_H);
  for (let y = 0; y < LETTER_H; y += 1) {
    for (let x = 0; x < LETTER_W; x += 1) {
      let best = Infinity;
      for (const stroke of strokes) {
        for (let i = 0; i + 1 < stroke.length; i += 1) {
          const [ax, ay] = stroke[i]!;
          const [bx, by] = stroke[i + 1]!;
          const dx = bx - ax;
          const dy = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
          best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        }
      }
      if (best <= STROKE) mask[y * LETTER_W + x] = 1;
    }
  }
  return mask;
}

function logo(s: Surface, x0: number, y0: number): void {
  const narrow = 0.85;
  LOGO.forEach((strokes, index) => {
    strokes = strokes.map((stroke) => stroke.map(([x, y]) => [Math.round(1 + (x - 1) * narrow), y] as const));
    const mask = logoMask(strokes);
    const top = y0 + index * (LETTER_H + 2);
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < LETTER_W && y < LETTER_H && mask[y * LETTER_W + x] === 1;
    for (let y = 0; y < LETTER_H; y += 1) {
      for (let x = 0; x < LETTER_W; x += 1) {
        if (!inside(x, y)) continue;
        const lit = !inside(x - 1, y) || !inside(x, y - 1);
        const shaded = !inside(x + 1, y) || !inside(x, y + 1);
        if (lit) s.pixel(x0 + x, top + y, NAVY);
        else if (shaded) s.pixel(x0 + x, top + y, BLUE);
      }
    }
  });
  for (const [x, y, arm] of GLINTS) {
    s.fill(x - arm, y, 2 * arm + 1, 1, NAVY);
    s.fill(x, y - arm, 1, 2 * arm + 1, NAVY);
    s.pixel(x, y, INK);
  }
}

/** Where the rows of the step list and the pattern start, and how many show. */
const LIST_TOP = 55;
const LIST_ROWS = 17;
const COLUMNS = { step: 24, note: 80, instrument: 120, bendTo: 160, bendSpeed: 200 };

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, BLACK);
  // Above: the ways back to the song editor, and the pattern's number.
  for (const x of [0, 256]) {
    plate(s, x, 0, x + 63, 30, { top: true });
    label(s, x + 22, 2, "BACK");
    label(s, x + 26, 11, "TO");
    label(s, x + 10, 20, "SONG-EDIT");
  }
  plate(s, 64, 0, 255, 30, { top: true });
  label(s, 122, 4, "PATTERN NR");
  smallButton(s, 125, 13, false);
  smallButton(s, 164, 13, true);
  field(s, 134, 12, 161, 23);
  // Below: the step list, the pattern, the player's plates and the name.
  plate(s, 0, 31, 63, 196, { bottom: 1 });
  label(s, 23, 43, "STEP");
  field(s, 14, 52, 49, 191);
  plate(s, 64, 31, 235, 196, { bottom: 1 });
  label(s, 80, 43, "NOTE");
  label(s, 121, 43, "INST");
  label(s, 161, 34, "BEND");
  label(s, 165, 43, "TO");
  label(s, 202, 34, "BEND");
  label(s, 200, 43, "SPEED");
  field(s, 64, 52, 235, 191);
  plate(s, 236, 31, 265, 86);
  label(s, 241, 56, "PLAY");
  cut(s, 247, 67, 247, 83);
  cut(s, 247, 67, 257, 75);
  cut(s, 247, 83, 257, 75);
  plate(s, 236, 87, 265, 142);
  label(s, 241, 112, "STOP");
  cut(s, 245, 123, 255, 123);
  cut(s, 245, 123, 245, 133);
  s.fill(246, 134, 11, 1, BLUE);
  s.fill(256, 124, 1, 11, BLUE);
  plate(s, 236, 143, 265, 196, { bottom: 1 });
  label(s, 241, 166, "EDIT");
  for (let a = 0; a < 64; a += 1) {
    const angle = (a / 64) * 2 * Math.PI;
    const x = Math.round(251 + 5.5 * Math.cos(angle));
    const y = Math.round(183 + 5.5 * Math.sin(angle));
    s.pixel(x, y, Math.cos(angle) + Math.sin(angle) > 0 ? BLUE : NAVY);
  }
  plate(s, 266, 31, 319, 196, { bottom: 1 });
  logo(s, 285, 44);
  return s;
}

const CHANNELS = 4;
const LEAD = 2;
const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  low: 12,
  high: 71,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 24, lead: 36, chord: 48 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 4, lead: 5, chord: 6, echo: 7 },
  positions: 128,
  seed: 89
};

function three(n: number): string {
  return String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, "0");
}

export function createSidMon1(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const sequence = new StepSequence(CHANNELS, 8);
  const rows = Array.from({ length: CHANNELS }, () => ({ notes: new Int16Array(ROWS), instruments: new Uint8Array(ROWS) }));
  /** The lead's pattern as shown: note, instrument, bend target and speed, row by row. */
  const notes = new Int16Array(ROWS).fill(-1);
  const instruments = new Uint8Array(ROWS);
  const bends = new Int16Array(ROWS).fill(-1);
  const speeds = new Uint8Array(ROWS);
  let live: StepEntry[] = [];
  let position = -1;
  let titleSeen: string | null = null;
  let drawn = -1;
  let screen: Surface | null = null;

  const follow = (frame: RetroFrame): void => {
    const now = song.position;
    if (frame.track.title !== titleSeen || now < position || now > position + 1) {
      titleSeen = frame.track.title;
      sequence.clear();
    } else if (now !== position && position >= 0) {
      sequence.keep(position, sequence.entries(rows, true));
    }
    position = now;
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const voice = rows[channel]!;
      for (let row = 0; row < ROWS; row += 1) {
        song.cell(channel, row, cell);
        const pitched = cell.note >= 0 && cell.note <= 119;
        voice.notes[row] = pitched ? cell.note : -1;
        voice.instruments[row] = pitched ? cell.instrument : 0;
        if (channel !== LEAD) continue;
        // A slide to a note is SidMon's bend: the note stays where it is, the bend names the goal.
        const bend = cell.effect === "tonePorta" && pitched;
        notes[row] = bend ? -1 : voice.notes[row]!;
        instruments[row] = bend ? 0 : voice.instruments[row]!;
        bends[row] = bend ? cell.note : -1;
        speeds[row] = bend ? Math.max(1, cell.param & 0x3f) : 0;
      }
    }
    live = sequence.entries(rows, false);
  };

  const drawValues = (s: Surface): void => {
    value(s, 136, 15, three(live[LEAD]?.pattern ?? 0));
    const playing = song.row;
    const first = Math.max(0, Math.min(ROWS - LIST_ROWS, playing - 8));
    for (let i = 0; i < LIST_ROWS; i += 1) {
      const row = first + i;
      const y = LIST_TOP + i * 8;
      if (row === playing) {
        s.fill(16, y - 1, 32, 9, BLUE);
        s.fill(66, y - 1, 168, 9, BLUE);
      }
      value(s, COLUMNS.step, y, three(row));
      value(s, COLUMNS.note, y, sidmonNote(notes[row]!));
      value(s, COLUMNS.instrument, y, three(instruments[row]!));
      value(s, COLUMNS.bendTo, y, sidmonNote(bends[row]!));
      value(s, COLUMNS.bendSpeed, y, three(speeds[row]!));
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
        follow(frame);
      }
      pixels.set(chrome.pixels);
      drawValues(screen);
      target.close(image);
    }
  };
}
