import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { FC, FC_SMALL, FC_TINY, FC_TITLE } from "./fonts-amiga2";
import { type Font, measure, mix, printable, rgb, sheet, Surface, Target } from "./raster";
import { type StepEntry, StepSequence, signedHex } from "./sequence-amiga2";
import { emptyCell, Song, type SongSpec } from "./song";

/**
 * Future Composer 1.4 (Amiga, SuperSero of The Superions, 1990) playing along: its 320 × 256
 * main screen as it looks with a song running — the title in its copper colours, the sequence
 * of steps (SP) with each voice's pattern, transpose and sound transpose (PT TR ST) and the
 * replay speed (RS), the step playing on the grey bar in the middle with the edit cursor, the
 * PLAY … QUIT buttons, the step fields and the sound's fields on the left, the module's name,
 * its type and the disk's directory on the right.
 *
 * Future Composer's patterns hold one voice each, 32 rows, and the song is a list of steps
 * naming a pattern for every voice. The module here is song.ts's (drums on the first voice,
 * the bass on the second, the lead on the third, hi-hats and chords on the fourth), its 64-row
 * patterns read as two steps; sequence-amiga2.ts numbers each voice's rows as patterns by their
 * shape, so a riff that comes back is the same pattern, transposed where it moved. The copper
 * lights the sequence as the program did, lilac above the bar and green below.
 */

const WIDTH = 320;
const HEIGHT = 256;

const BLACK = rgb(0x000000);
const GREY = rgb(0x8b8b8b);
const LIGHT = rgb(0xc7c7c7);
const NAVY = rgb(0x102040);
const LAVENDER = rgb(0x9c9cd4);
const BLUE = rgb(0x2b26d8);
const MID = rgb(0x5a5aeb);
const GREEN = rgb(0x1a573a);
const MAROON = rgb(0x6c1830);
const VALUE = rgb(0xe0e0e0);
const CURSOR = rgb(0x8a2a2a);

const font = sheet(FC.sheet, FC.cell, FC.height, FC.fixed);
const title = sheet(FC_TITLE.sheet, FC_TITLE.cell, FC_TITLE.height, FC_TITLE.fixed, 2);
const small = sheet(FC_SMALL.sheet, FC_SMALL.cell, FC_SMALL.height, FC_SMALL.fixed);
const tiny = sheet(FC_TINY.sheet, FC_TINY.cell, FC_TINY.height, FC_TINY.fixed);

const VOICES = 4;
const STEP_ROWS = 32;
const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  low: 12,
  high: 59,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 12, lead: 36, chord: 36 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 128,
  seed: 14
};

/** The sequence: the glyph rows of its eleven lines (the sixth the step playing), its columns. */
const LINES = [35, 44, 53, 62, 71, 80, 89, 98, 107, 116, 125];
const MIDDLE = 5;
const VOICE_X = [32, 88, 144, 200];
const SP_X = 8;
const RS_X = 256;

/**
 * The copper's colours for the sequence, a line at a time: the patterns and sound transposes
 * lilac above the bar and green below, the transposes violet to blue, the step numbers and
 * speeds brightest beside the bar. The bar itself is grey, its figures white and black.
 */
const PTST = [0x94709e, 0x9a80b0, 0xa294c6, 0xaca6d8, 0xb2b6e4, 0xe8e8f8, 0xaab2e4, 0x9eb4d8, 0x90b6c8, 0x80b0b4, 0x66aaa0];
const TRANS = [0x44107f, 0x44138c, 0x46259c, 0x4e36ae, 0x5e50ba, 0x000000, 0x5856c0, 0x4a56b4, 0x3c56a2, 0x2a5094, 0x164c84];
const STEPS = [0x20267a, 0x323a8e, 0x4c54a4, 0x6268b8, 0x8088c8, 0x000000, 0x727cc4, 0x6468b8, 0x5056a8, 0x3a4090, 0x24287a];

/** Each line's colours (8 a glyph row), blending into the next line's on the way down. */
function copper(keys: readonly number[]): number[][] {
  return keys.map((key, line) => {
    const next = line === MIDDLE - 1 || line === MIDDLE || line === keys.length - 1 ? key : keys[line + 1]!;
    return Array.from({ length: 8 }, (_, row) => rgb(mix(key, next, row / 9)));
  });
}
const PTST_LINES = copper(PTST);
const TRANS_LINES = copper(TRANS);
const STEP_LINES = copper(STEPS);

/** The title's colours across the screen (the copper moving every eight pixels) and down it. */
const TITLE_STOPS: readonly (readonly [number, number])[] = [
  [60, 0xa8e8cc], [76, 0x98ccb4], [100, 0x7a9c88], [116, 0x908a80], [132, 0xb09888], [152, 0xd4c0b0],
  [176, 0xf0e8e0], [200, 0xfff8f6], [218, 0xf8e0ea], [240, 0xf0c0d4], [262, 0xe8a8c4]
];
const TITLE_SHADE = [1.1, 1.05, 1, 0.97, 0.93, 0.89, 0.85];

function titleColour(x: number, row: number): number {
  const at = Math.floor(x / 8) * 8 + 4;
  let colour = TITLE_STOPS[TITLE_STOPS.length - 1]![1];
  for (let index = 0; index < TITLE_STOPS.length - 1; index += 1) {
    const [from, a] = TITLE_STOPS[index]!;
    const [to, b] = TITLE_STOPS[index + 1]!;
    if (at < from) {
      colour = a;
      break;
    }
    if (at <= to) {
      colour = mix(a, b, (at - from) / (to - from));
      break;
    }
  }
  const shade = TITLE_SHADE[row] ?? 1;
  const channel = (shift: number): number => Math.min(255, Math.round(((colour >> shift) & 255) * shade)) << shift;
  return rgb(channel(16) | channel(8) | channel(0));
}

/** Text whose every row has its own colour (the copper's lines). */
function lined(s: Surface, face: Font, x: number, y: number, text: string, colours: readonly number[]): void {
  let at = x;
  for (const char of text) {
    const glyph = face.glyphs.get(char);
    if (glyph) for (let row = 0; row < glyph.rows.length; row += 1) if (glyph.rows[row]) s.bits(at, y + row, [glyph.rows[row]!], glyph.width, colours[row]!);
    at += face.fixed ? face.width : (glyph ? glyph.width : face.width) + face.spacing;
  }
}

/** Light figures on black, the black just behind them (the program's fields). */
function field(s: Surface, x: number, y: number, text: string): void {
  s.fill(x, y, text.length * 8, 7, BLACK);
  s.text(font, x, y, text, VALUE);
}

/** The small capitals, words three pixels apart as the sample fields set them. */
function smallText(s: Surface, x: number, y: number, text: string, colour: number): void {
  let at = x;
  for (const word of text.split(" ")) {
    s.text(small, at, y, word, colour);
    at += measure(small, word) + 3;
  }
}

/** A raised box of the panels: light above and left, navy below and right, grey between. */
function box(s: Surface, x0: number, y0: number, x1: number, y1: number): void {
  s.fill(x0, y0, x1 - x0 + 1, y1 - y0 + 1, GREY);
  s.fill(x0, y0, x1 - x0, 1, LIGHT);
  s.fill(x0, y0, 1, y1 - y0, LIGHT);
  s.fill(x1, y0, 1, y1 - y0 + 1, NAVY);
  s.fill(x0, y1, x1 - x0 + 1, 1, NAVY);
}

const UP = [0b000010000, 0b000111000, 0b001111100, 0b011010110, 0b000010000, 0b000010000, 0b000010000, 0b000010000, 0b000010000];
const DOWN = [...UP].reverse();

const FILES = ["fc14.intro", "fc14.ingame", "fc14.hiscore", "fc14.title", "fc13.sweet", "fc14.endpart", "fc14.loader"];

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, BLACK);
  // The title in the copper's colours.
  for (const [word, x0] of [["FUTURE", 60], ["COMPOSER", 132], ["V1.4", 226]] as const) {
    let x = x0;
    for (const char of word) {
      const glyph = title.glyphs.get(char)!;
      for (let row = 0; row < glyph.rows.length; row += 1) {
        for (let column = 0; column < glyph.width; column += 1) {
          if (glyph.rows[row]! & (1 << (glyph.width - 1 - column))) s.pixel(x + column, row, titleColour(x + column, row));
        }
      }
      x += glyph.width + (char === "1" ? 3 : title.spacing);
    }
  }
  // The sequence's heading.
  s.text(font, SP_X, 19, "SP", BLUE);
  for (const x of VOICE_X) {
    s.text(font, x, 19, "PT", LAVENDER);
    s.text(font, x + 16, 19, "TR", MID);
    s.text(font, x + 32, 19, "ST", LAVENDER);
  }
  s.text(font, RS_X, 19, "RS", BLUE);
  // The sequence's frame: wells for the steps, the four voices and the speed, above and below the bar.
  s.fill(5, 31, 270, 105, GREY);
  s.fill(5, 31, 270, 1, LIGHT);
  s.fill(5, 31, 1, 104, LIGHT);
  s.fill(274, 31, 1, 104, LIGHT);
  s.fill(5, 135, 270, 1, NAVY);
  const wells: readonly (readonly [number, number])[] = [[7, 24], [30, 81], [86, 137], [142, 193], [198, 249], [255, 272]];
  for (const [top, bottom] of [[33, 78], [88, 133]] as const) {
    for (const [left, right] of wells) {
      const sp = left === 7;
      s.fill(left + 1, top + 1, right - left - 1, bottom - top - 1, BLACK);
      s.fill(sp ? left : left + 1, top, sp ? right - left + 1 : right - left, 1, NAVY);
      s.fill(left, sp || top !== 33 ? top + 1 : top, 1, sp || top !== 33 ? bottom - top - 1 : bottom - top, sp ? NAVY : LIGHT);
      s.fill(right, top + 1, 1, bottom - top - 1, NAVY);
      if (top === 33) s.fill(left + (sp ? 0 : 1), bottom, right - left - (sp ? 0 : 1), 1, LIGHT);
    }
  }
  s.fill(7, 133, 266, 1, LIGHT);
  // The bar: the copper turns the step playing grey across the table; the edit cursor on its first figure.
  s.bevel(31, 78, 10, 10, CURSOR, CURSOR, CURSOR);
  // The buttons.
  ["PLAY", "STOP", "LOAD", "SAVE", "TYPE", "QUIT"].forEach((label, index) => {
    const top = 31 + index * 18;
    box(s, 278, top, 313, top + 14);
    s.text(font, 280, top + 4, label, GREEN);
  });
  // The step fields and the sound's fields.
  const left: readonly (readonly [number, number])[] = [[141, 152], [153, 164], [165, 176], [177, 191], [192, 241], [242, 255]];
  for (const [top, bottom] of left) box(s, 6, top, 129, bottom);
  s.text(font, 8, 143, "Current step", GREEN);
  s.text(font, 8, 155, "First step", GREEN);
  s.text(font, 8, 167, "Last step", GREEN);
  for (const y of [143, 155, 167]) s.text(font, 105, y, ":", GREEN);
  s.text(font, 16, 181, "EDIT Patterns", MAROON);
  s.text(font, 8, 194, "Sound", GREEN);
  s.text(font, 54, 194, "(", GREEN);
  smallText(s, 61, 196, "INSTR.", GREEN);
  s.text(font, 90, 194, ")", GREEN);
  s.text(font, 100, 194, "#", GREEN);
  s.text(font, 8, 203, "Wave/Sample", GREEN);
  s.text(font, 100, 203, "#", GREEN);
  for (const [label, y] of [["LENGTH IN BYTES", 214], ["REPEAT START", 224], ["REPEAT LENGTH", 234]] as const) {
    smallText(s, 9, y, label, GREEN);
    s.fill(93, y - 1, 2, 2, GREEN);
    s.fill(93, y + 3, 2, 2, GREEN);
    s.fill(96, y - 3, 32, 9, BLACK);
  }
  s.text(font, 16, 246, "EDIT Sounds", MAROON);
  // The module's name, its type, the directory with its scroller and the drives, the path.
  box(s, 134, 141, 313, 152);
  s.fill(136, 143, 176, 8, BLACK);
  box(s, 134, 153, 313, 164);
  s.text(font, 136, 155, "Filetype:", BLACK);
  s.fill(207, 155, 91, 8, BLACK);
  s.text(font, 208, 155, "Module", VALUE);
  box(s, 134, 165, 313, 255);
  s.fill(136, 167, 165, 69, BLACK);
  s.fill(302, 166, 1, 70, LIGHT);
  for (const y of [177, 223]) {
    s.fill(302, y, 12, 1, NAVY);
    s.fill(302, y + 1, 11, 1, LIGHT);
  }
  s.bits(303, 167, UP, 9, BLACK);
  s.bits(304, 226, DOWN, 9, BLACK);
  s.text(font, 304, 187, "D", BLACK);
  s.text(font, 304, 197, "I", BLACK);
  s.text(font, 304, 206, "R", BLACK);
  s.fill(135, 236, 179, 1, NAVY);
  const tabs: readonly (readonly [string, number, number])[] = [
    ["CLEAR", 136, 156], ["DF0:", 159, 176], ["MODULES", 179, 207], ["SOUNDS", 210, 234], ["DF1:", 237, 253], ["MODULES", 256, 284], ["SOUNDS", 287, 311]
  ];
  s.fill(135, 237, 1, 7, NAVY);
  for (const [label, from, to] of tabs) {
    s.fill(to + 1, 237, 1, 7, LIGHT);
    s.fill(to + 2, 237, 1, 7, NAVY);
    s.text(tiny, from + Math.ceil((to - from + 2 - label.length * 4) / 2), 238, label, BLACK);
  }
  s.fill(134, 244, 179, 1, LIGHT);
  s.fill(136, 246, 176, 8, BLACK);
  s.text(font, 136, 246, "Df0:Modules/", VALUE);
  FILES.forEach((name, index) => s.text(font, 136, 170 + index * 9, name, MID));
  return s;
}

/** The sounds as the sample fields show them: wave or sample, length, repeat start and length. */
const SOUNDS: Record<number, readonly [number, string, string, string]> = {
  1: [0x0a, "1838", "0000", "0002"],
  2: [0x0b, "2416", "0000", "0002"],
  3: [0x0c, "0640", "0000", "0002"],
  4: [0x0d, "1280", "0000", "0002"],
  5: [0x01, "0032", "0000", "0016"],
  6: [0x02, "0032", "0000", "0016"],
  7: [0x05, "0064", "0000", "0032"],
  8: [0x02, "0032", "0000", "0016"]
};

export function createFutureComposer(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const sequence = new StepSequence(VOICES, 4);
  // The rows of the step being heard, voice by voice, as they stand.
  const notes = Array.from({ length: VOICES }, () => new Int16Array(STEP_ROWS));
  const instruments = Array.from({ length: VOICES }, () => new Uint8Array(STEP_ROWS));
  const rows = notes.map((voice, index) => ({ notes: voice, instruments: instruments[index]! }));
  let live: StepEntry[] = Array.from({ length: VOICES }, () => ({ pattern: 0, transpose: 0, sound: 0 }));
  let step = -1;
  let titleSeen: string | null = null;
  const seen = new Float64Array(VOICES);
  let sound = 1;
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  /** The rows of the step playing, read into `notes` and `instruments`. */
  const readStep = (now: number): void => {
    const first = (now & 1) * STEP_ROWS;
    for (let voice = 0; voice < VOICES; voice += 1) {
      for (let row = 0; row < STEP_ROWS; row += 1) {
        song.cell(voice, first + row, cell);
        const pitched = cell.note >= 0 && cell.note <= 119;
        notes[voice]![row] = pitched ? cell.note : -1;
        instruments[voice]![row] = pitched ? cell.instrument : 0;
      }
    }
  };

  /** The step playing moves on: the one left is kept as it was heard, the new one is read. */
  const follow = (frame: RetroFrame): void => {
    const now = song.position * 2 + (song.row >= STEP_ROWS ? 1 : 0);
    if (frame.track.title !== titleSeen || now < step || now > step + 2) {
      titleSeen = frame.track.title;
      sequence.clear();
    } else if (now !== step && step >= 0) {
      sequence.keep(step, sequence.entries(rows, true));
    }
    step = now;
    readStep(now);
    live = sequence.entries(rows, false);
  };

  const drawSequence = (s: Surface, length: number): void => {
    for (let line = 0; line < LINES.length; line += 1) {
      const at = step - MIDDLE + line;
      const y = LINES[line]!;
      const entries = at >= 0 && at < length ? sequence.at(at, step, live) : null;
      lined(s, font, SP_X, y, signedHex(at), STEP_LINES[line]!);
      for (let voice = 0; voice < VOICES; voice += 1) {
        const entry = entries?.[voice];
        const x = VOICE_X[voice]!;
        lined(s, font, x, y, signedHex(entry?.pattern ?? 0), PTST_LINES[line]!);
        lined(s, font, x + 16, y, signedHex(entry?.transpose ?? 0), TRANS_LINES[line]!);
        lined(s, font, x + 32, y, signedHex(entry?.sound ?? 0), PTST_LINES[line]!);
      }
      lined(s, font, RS_X, y, at === 0 ? "06" : "00", STEP_LINES[line]!);
    }
  };

  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const steps = song.length(frame.track.duration) * 2;
    field(s, 112, 143, signedHex(step));
    field(s, 112, 155, "00");
    field(s, 112, 167, signedHex(steps - 1));
    // The sound fields follow the sound struck last.
    for (let voice = 0; voice < VOICES; voice += 1) {
      const hits = song.hits(voice);
      if (hits !== seen[voice]) {
        seen[voice] = hits;
        sound = song.instrumentOf(voice) || sound;
      }
    }
    const [wave, length, start, repeat] = SOUNDS[sound] ?? SOUNDS[1]!;
    field(s, 112, 194, signedHex(sound));
    field(s, 112, 203, signedHex(wave));
    s.text(font, 96, 212, length, VALUE);
    s.text(font, 96, 222, start, VALUE);
    s.text(font, 96, 232, repeat, VALUE);
    // The module's name in its field.
    const name = printable(frame.track.title, font).replace(/\s+/g, " ").trim().slice(0, 22);
    s.text(font, 136, 143, name, VALUE);
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
        base.pixels.set(chrome.pixels);
        drawSequence(base, song.length(frame.track.duration) * 2);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      target.close(image);
    }
  };
}
