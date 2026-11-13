import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { AMIGA } from "./fonts";
import { NT_LOGO } from "./fonts-soundtracker";
import { clock, decimal, fieldText, hex, modEffect, noteText } from "./notation";
import { type Font, measure, printable, rgb, sheet, Surface, Target } from "./raster";
import { copper, Meters, NoteBars } from "./soundtracker-parts";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * NoiseTracker 2.0 (Mahoney & Kaktus, 1990) playing along: its 320 × 256 screen in the Amiga's
 * greys — POSI with its arrows and the eight fields under it, the fifteen buttons with the four
 * channels' switches, the analyzer whose bars run from green to red down the copper's lines,
 * QUANT and SONGNAME, SAMPLENAME, the program's name with TIMER, TUNE and FREEMEM, and the four
 * tracks scrolling under the play row with their meters in the same copper colours.
 *
 * The analyzer is the program's: a bar per pitch, lifted by every note a channel strikes
 * (soundtracker-parts.ts). 31 samples, two hex digits; effects 0–4 and A–F as NoiseTracker had
 * them (no 9, no E commands but the filter, F a speed up to 1F). Drawn from this project's own
 * fonts (fonts.ts, fonts-soundtracker.ts) and these coordinates.
 */

const WIDTH = 320;
const HEIGHT = 256;

const BLACK = rgb(0x000000);
const GREY = rgb(0x777777);
const LIGHT = rgb(0xaaaaaa);
const DARK = rgb(0x444444);
const NOTES = rgb(0x0044dd);
const CURSOR = rgb(0xbb1111);

const font = sheet(AMIGA.sheet, AMIGA.cell, AMIGA.height, AMIGA.fixed);
/** The panels' labels: the capitals as wide as they are, a pixel apart, dots and spaces narrow. */
const labels: Font = (() => {
  const loose = sheet(AMIGA.sheet, AMIGA.cell, AMIGA.height, false);
  return { ...loose, glyphs: new Map([...loose.glyphs, [" ", { width: 3, rows: [0, 0, 0, 0, 0] }]]) };
})();
const logo: Font = (() => {
  const narrow = sheet(NT_LOGO.sheet, NT_LOGO.cell, NT_LOGO.height, NT_LOGO.fixed);
  return { ...narrow, glyphs: new Map([...narrow.glyphs, [" ", { width: 3, rows: new Array<number>(10).fill(0) }]]) };
})();

const UP = [0b001100, 0b011110, 0b111111, 0b001100, 0b001100, 0b001100];
const DOWN = [0b001100, 0b001100, 0b001100, 0b111111, 0b011110, 0b001100];
const LEFT = [0b001000, 0b011000, 0b111111, 0b111111, 0b011000, 0b001000];
const RIGHT = [0b000100, 0b000110, 0b111111, 0b111111, 0b000110, 0b000100];

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["chord", "hats", "echo"] }],
  // C-1 … B-3, the three octaves of the Amiga's period table.
  low: 12,
  high: 47,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 12, lead: 24, chord: 24 },
  instruments: { kick: 0x01, snare: 0x02, hats: 0x03, bass: 0x0e, lead: 0x11, chord: 0x0b, echo: 0x12 },
  positions: 128,
  seed: 71
};

/** The pattern: rows above the play row, its text, rows below; a row every 7 lines. */
const ABOVE_TOP = 142;
const BAR_TEXT = 193;
const BELOW_TOP = 206;
const LINE = 7;
const TRACK_LEFT = 29;
const TRACK_STEP = 72;
/** The meters: 44 lines up from the play row's top. */
const METER_BOTTOM = 191;
const METER_HEIGHT = 44;
/** The analyzer: 23 slots of 8 pixels, bars up to 38 lines. */
const SLOT_LEFT = 128;
const BAR_BOTTOM = 95;
const BAR_HEIGHT = 38;

/** The analyzer's copper, from its top line down: red, yellow, green, darker green at the foot. */
const BAR_COPPER = copper(BAR_HEIGHT, [[0, 0xc32], [2, 0xc32], [16, 0xcc2], [31, 0x2c2], [33, 0x2c2], [37, 0x292]]).map(rgb);

/**
 * The meters' copper from the bottom line up (green, lime, yellow, orange at the top), and across
 * each meter: lit on the left, shaded on the right, as its colour registers were.
 */
const METER: number[][] = copper(METER_HEIGHT, [[0, 0x0a0], [2, 0x0a0], [8, 0x0f0], [10, 0x0f0], [31, 0xbf0], [42, 0xb40], [43, 0xb40]]).map((base) => {
  const r = (base >> 16) & 255;
  const g = (base >> 8) & 255;
  const b = base & 255;
  const shade = (dr: number, dg: number): number => rgb((Math.max(0, Math.min(255, r + dr)) << 16) | (Math.max(0, Math.min(255, g + dg)) << 8) | b);
  const lit = shade(60, 0);
  return [lit, lit, shade(24, 0), rgb(base), rgb(base), rgb(base), rgb(base), rgb(base), shade(-40, -10), shade(-50, -20)];
});

/** A raised panel of the Amiga's grey. */
function panel(s: Surface, x: number, y: number, width: number, height: number): void {
  s.fill(x, y, width, height, GREY);
  s.bevel(x, y, width, height, LIGHT, DARK, GREY);
}

/** A raised button with its label, lettered light with a dark shadow. */
function button(s: Surface, x: number, y: number, width: number, label: string): void {
  panel(s, x, y, width, 11);
  s.embossed(labels, x + Math.round((width - measure(labels, label)) / 2), y + 3, label, LIGHT, DARK);
}

/** An arrow button. */
function arrow(s: Surface, x: number, y: number, shape: readonly number[]): void {
  panel(s, x, y, 11, 11);
  s.bits(x + 3, y + 3, shape, 6, DARK);
  s.bits(x + 2, y + 2, shape, 6, LIGHT);
}

/** The screen as it stands, without the values that change. */
function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, GREY);
  // The fields: two panels of names, the values beside them, each with its arrows.
  panel(s, 0, 0, 62, 44);
  panel(s, 0, 44, 62, 56);
  const fields = ["POSI", "PATTERN", "LENGTH", "RESTART", "SAMPLE", "VOLUME", "LENGTH", "REPEAT", "REPLEN"];
  const tops = [0, 11, 22, 33, 44, 55, 67, 78, 89];
  for (let row = 0; row < fields.length; row += 1) {
    const y = tops[row]!;
    const label = fields[row]!;
    const x = row === 0 ? 6 : Math.round((62 - measure(labels, label)) / 2);
    s.embossed(labels, x, y + 3, label, LIGHT, DARK);
    panel(s, 62, y, 36, 11);
    arrow(s, 98, y, UP);
    arrow(s, 109, y, DOWN);
  }
  // POSI moves the song back and on.
  arrow(s, 40, 0, LEFT);
  arrow(s, 51, 0, RIGHT);
  // The buttons; the first row ends in the four channels' switches.
  const buttons = [["PLAY", "STOP", ""], ["PATTERN", "CLEAR", "PRINT"], ["EDIT", "PLST", "PLST-ED"], ["PATTREC", "DISK OP.", "MIDI"], ["SONGREC", "SAMPLER", "MIDI:OFF"]];
  for (let row = 0; row < buttons.length; row += 1) {
    const y = row * 11;
    button(s, 120, y, 67, buttons[row]![0]!);
    button(s, 187, y, 68, buttons[row]![1]!);
    if (row > 0) button(s, 255, y, 65, buttons[row]![2]!);
  }
  for (let channel = 0; channel < 4; channel += 1) button(s, 255 + channel * 16, 0, channel === 3 ? 17 : 16, String(channel + 1));
  // The analyzer: its slots, raised.
  panel(s, 120, 55, 200, 45);
  for (let bar = 0; bar < 23; bar += 1) {
    const x = SLOT_LEFT + bar * 8;
    s.fill(x, 58, 7, 1, LIGHT);
    s.fill(x, 58, 1, 38, LIGHT);
    s.fill(x + 7, 59, 1, 38, DARK);
    s.fill(x + 1, 96, 7, 1, DARK);
  }
  // QUANT and SONGNAME, SAMPLENAME and CLR.
  panel(s, 0, 100, 62, 11);
  s.embossed(labels, 8, 103, "QUANT:", LIGHT, DARK);
  panel(s, 62, 100, 258, 11);
  s.embossed(labels, 73, 103, "SONGNAME:", LIGHT, DARK);
  panel(s, 0, 111, 288, 11);
  s.embossed(labels, 12, 114, "SAMPLENAME:", LIGHT, DARK);
  button(s, 288, 111, 32, "CLR");
  // The program's name between the pattern's number and the clock, the tune's size and the memory left.
  s.fill(0, 122, 1, 16, LIGHT);
  s.fill(6, 125, 19, 12, GREY);
  s.bevel(6, 125, 19, 12, DARK, LIGHT, GREY);
  s.embossed(logo, 48, 125, "NOISETRACKER V2.0", LIGHT, DARK);
  s.embossed(labels, 178, 124, "TIMER", LIGHT, DARK);
  s.embossed(labels, 229, 124, "TUNE", LIGHT, DARK);
  s.embossed(labels, 266, 124, "FREEMEM", LIGHT, DARK);
  // The pattern: the row numbers' well and the four tracks', sunken, and the play row's bar.
  for (const [x, width] of [[2, 26], [29, 71], [101, 71], [173, 71], [245, 73]] as const) {
    for (const [top, bottom] of [[139, 190], [203, 254]] as const) {
      s.fill(x, top, width, bottom - top + 1, BLACK);
      s.fill(x, top, width - 1, 1, DARK);
      s.fill(x, top, 1, bottom - top + 1, DARK);
      s.fill(x + width - 1, top + 1, 1, bottom - top, LIGHT);
    }
    s.fill(x, 191, width, 2, LIGHT);
    s.fill(x, 193, width, 10, GREY);
    s.fill(x, 255, width, 1, LIGHT);
  }
  return s;
}

export function createNoiseTracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const bars = new NoteBars(4, SPEC.low, SPEC.high, 0.9);
  const meters = new Meters(4, 1.3);
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  /** One track's cell as NoiseTracker writes it: note, sample, effect, all run together ("D#311C20"). */
  const cellText = (channel: number, row: number): string => {
    song.cell(channel, row, cell);
    let effect = "000";
    switch (cell.effect) {
      case "arpeggio":
      case "slideUp":
      case "slideDown":
      case "tonePorta":
      case "vibrato":
      case "volumeSlide":
      case "volume":
        effect = modEffect(cell.effect, cell.param);
        break;
      case "speed":
        effect = `F${hex(Math.max(1, Math.min(31, cell.param)), 2)}`;
        break;
      default:
        // No volume column: a note not at full volume sets its volume with C.
        if (cell.volume >= 0 && cell.volume < 0x38 && cell.note >= 0 && cell.note < 120) effect = `C${hex(cell.volume, 2)}`;
    }
    return `${noteText(cell.note, "---")}${hex(cell.instrument, 2)}${effect}`;
  };

  const drawPattern = (s: Surface): void => {
    const current = song.row;
    for (let offset = -7; offset <= 7; offset += 1) {
      const row = current + offset;
      if (row < 0 || row >= ROWS) continue;
      const playing = offset === 0;
      const y = playing ? BAR_TEXT : offset < 0 ? ABOVE_TOP + (offset + 7) * LINE : BELOW_TOP + (offset - 1) * LINE;
      const color = playing ? BLACK : NOTES;
      const scale = playing ? 2 : 1;
      s.text(font, 9, y, decimal(row, 2), color, scale);
      for (let channel = 0; channel < 4; channel += 1) s.text(font, TRACK_LEFT + 4 + channel * TRACK_STEP, y, cellText(channel, row), color, scale);
    }
    // The edit cursor on the first track's note.
    s.fill(30, 191, 11, 2, CURSOR);
    s.fill(30, 203, 11, 1, CURSOR);
    s.fill(30, 193, 1, 10, CURSOR);
    s.fill(40, 193, 1, 10, CURSOR);
  };

  /** The fields that change: the position, the pattern, the song's name, its clock and size. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const length = song.length(frame.track.duration);
    s.text(font, 65, 3, decimal(song.position, 4), BLACK);
    s.text(font, 65, 14, decimal(song.pattern, 4), BLACK);
    s.text(font, 65, 25, decimal(length, 4), BLACK);
    s.text(font, 65, 36, "0000", BLACK);
    s.text(font, 65, 47, "0001", BLACK);
    s.text(font, 65, 58, "0040", BLACK);
    s.text(font, 65, 70, "0A46", BLACK);
    s.text(font, 65, 81, "0000", BLACK);
    s.text(font, 65, 92, "0001", BLACK);
    s.text(font, 50, 103, "1", BLACK);
    s.text(font, 144, 103, fieldText(printable(frame.track.title, font, true), 20, true, "_"), BLACK);
    s.text(font, 104, 114, fieldText("ST-01:BASSDRUM", 22, true, "_"), BLACK);
    s.text(font, 8, 129, decimal(song.pattern, 2), BLACK);
    s.text(font, 176, 132, clock(song.time), BLACK);
    // The module's size: the song, its patterns and the samples; the chip memory left beside it.
    const tune = 1084 + (song.pattern + 1) * 1024 + 0x2a3c0;
    s.text(font, 224, 132, hex(tune, 5), BLACK);
    s.text(font, 272, 132, hex(0x7f000 - 0x31000 - tune, 5), BLACK);
  };

  const drawAnalyzer = (s: Surface): void => {
    for (let bar = 0; bar < 23; bar += 1) {
      const height = Math.round(bars.levels[bar]! * BAR_HEIGHT);
      const x = SLOT_LEFT + bar * 8 + 1;
      for (let step = 0; step < height; step += 1) {
        const y = BAR_BOTTOM - step;
        s.fill(x, y, 6, 1, BAR_COPPER[y - (BAR_BOTTOM - BAR_HEIGHT + 1)]!);
      }
    }
  };

  const drawMeters = (s: Surface): void => {
    for (let channel = 0; channel < 4; channel += 1) {
      const height = Math.round(meters.values[channel]! * METER_HEIGHT);
      const x = TRACK_LEFT + channel * TRACK_STEP + 25;
      for (let step = 0; step < height; step += 1) {
        const colours = METER[step]!;
        const y = METER_BOTTOM - step;
        for (let column = 0; column < 10; column += 1) s.pixel(x + column, y, colours[column]!);
      }
    }
  };

  return {
    width: WIDTH,
    height: HEIGHT,
    aspect: 4 / 3,
    crt: "none",
    render(frame: RetroFrame, image: PixelImage): void {
      song.update(frame.audio, frame.track, frame.dt);
      bars.update(song, frame.dt);
      meters.update(song, frame.dt);
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) screen = new Surface(WIDTH, HEIGHT, pixels);
      if (song.changes !== drawn) {
        drawn = song.changes;
        base.copy(chrome, 0, 139, WIDTH, HEIGHT - 139, 0, 139);
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawAnalyzer(screen);
      drawMeters(screen);
      target.close(image);
    }
  };
}
