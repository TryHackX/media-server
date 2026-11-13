import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { AMIGA } from "./fonts";
import { decimal, fieldText, hex, noteText } from "./notation";
import { type Font, measure, printable, rgb, sheet, Surface, Target } from "./raster";
import { Meters, NoteBars, scrollOffset } from "./soundtracker-parts";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * The D.O.C SoundTracker 2.0 (Unknown of D.O.C, 1988) playing along: its 320 × 256 screen in
 * the Amiga's greys — the six fields with their arrows, the twelve buttons with the four voices'
 * switches, the "spectrum analyzer" of black segments, the scroll text over DISK STATUS, SONGNAME
 * and SAMPLENAME, the title over the tracks and the four tracks scrolling under the play row, each
 * with its green meter rising over the rows already played.
 *
 * The analyzer is the program's own: no spectrum but a bar per pitch, lifted by every note a
 * channel strikes (soundtracker-parts.ts). Fifteen samples, one hex digit each; effects 0
 * (arpeggio), 1 and 2 (slides), C (volume) and F (speed up to 0F). Drawn from this project's own
 * font (fonts.ts) and these coordinates.
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
/** The panels' labels: the same capitals as wide as they are, a pixel apart, dots and spaces narrow. */
function spaced(space: number): Font {
  const loose = sheet(AMIGA.sheet, AMIGA.cell, AMIGA.height, false);
  return { ...loose, glyphs: new Map([...loose.glyphs, [" ", { width: space, rows: [0, 0, 0, 0, 0] }]]) };
}
const labels = spaced(3);
/** The title over the tracks sets its words further apart. */
const title = spaced(6);

const UP = [0b001100, 0b011110, 0b111111, 0b001100, 0b001100, 0b001100];
const DOWN = [0b001100, 0b001100, 0b001100, 0b111111, 0b011110, 0b001100];

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["hats", "chord", "snare"] }],
  // C-1 … B-3: the two-octave keyboard and the octave F1/F2 move it by.
  low: 12,
  high: 47,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 12, lead: 24, chord: 24 },
  instruments: { kick: 12, snare: 13, hats: 14, bass: 3, lead: 9, chord: 6, echo: 2 },
  positions: 128,
  seed: 37
};

/** The pattern: rows above the play row, its text, rows below; a row every 7 lines. */
const ABOVE_TOP = 141;
const BAR_TEXT = 192;
const BELOW_TOP = 205;
const LINE = 7;
const TRACK_LEFT = 29;
const TRACK_STEP = 72;
/** The meters: 44 lines up from the play row, green, then yellow, then red. */
const METER_BOTTOM = 190;
const METER_HEIGHT = 44;
/** The analyzer: 23 slots of 8 pixels; up to 18 black segments, one every other line. */
const SLOT_LEFT = 128;
const SEGMENTS = 18;

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

/** Text leaning forward: its upper rows a pixel or two to the right (the title's "D.O.C"). */
function italic(s: Surface, x: number, y: number, text: string, color: number, shadow: number): void {
  const shifts = [1, 1, 0, 0, 0];
  for (const [dx, dy, ink] of [[1, 1, shadow], [0, 0, color]] as const) {
    let at = x + dx;
    for (const char of text) {
      const glyph = title.glyphs.get(char);
      if (glyph) {
        for (let row = 0; row < glyph.rows.length; row += 1) s.bits(at + shifts[row]!, y + dy + row, [glyph.rows[row]!], glyph.width, ink);
      }
      at += (glyph ? glyph.width : title.width) + title.spacing;
    }
  }
}

/** The meters' colours from the bottom up: green, yellow over it, red at the top; each lit on the left, shaded right. */
const METER: number[][] = Array.from({ length: METER_HEIGHT }, (_, step) => {
  const [light, base, dark] = step < 29 ? [0x00aa00, 0x007700, 0x004400] : step < 39 ? [0xbbaa00, 0x997700, 0x774400] : [0xcc0000, 0x990000, 0x660000];
  return [light, light, base, base, base, base, base, base, dark, dark].map(rgb);
});

/** The screen as it stands, without the values that change. */
function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, GREY);
  // The fields, each with its two arrows.
  const fields = ["POSITION", "PATTERN", "LENGTH", "PRESET", "SAMPLE", "VOLUME"];
  for (let row = 0; row < fields.length; row += 1) {
    const y = row * 11;
    button(s, 0, y, 62, fields[row]!);
    panel(s, 62, y, 36, 11);
    for (const [x, shape] of [[98, UP], [109, DOWN]] as const) {
      panel(s, x, y, 11, 11);
      s.bits(x + 3, y + 3, shape, 6, DARK);
      s.bits(x + 2, y + 2, shape, 6, LIGHT);
    }
  }
  // The buttons, the voices' switches and the analyzer's title.
  const buttons = [["PATTERN", "PAT. PLAY", "VOICE1: ON"], ["PLAY", "USE PSET", "VOICE2: ON"], ["STOP", "DISK OP.", "VOICE3: ON"], ["EDIT", "RECORD", "VOICE4: ON"]];
  for (let row = 0; row < 4; row += 1) {
    const y = row * 11;
    button(s, 120, y, 62, buttons[row]![0]!);
    button(s, 182, y, 62, buttons[row]![1]!);
    button(s, 244, y, 76, buttons[row]![2]!);
  }
  button(s, 120, 44, 200, "SPECTRUM ANALYZER");
  // The analyzer: its slots, raised.
  panel(s, 120, 55, 200, 45);
  for (let bar = 0; bar < 23; bar += 1) {
    const x = SLOT_LEFT + bar * 8;
    s.fill(x, 58, 7, 1, LIGHT);
    s.fill(x, 58, 1, 38, LIGHT);
    s.fill(x + 7, 59, 1, 38, DARK);
    s.fill(x + 1, 96, 7, 1, DARK);
  }
  // The scroll text's strip and DISK STATUS under it.
  panel(s, 0, 67, 120, 14);
  panel(s, 0, 82, 120, 18);
  const disk = "DISK STATUS";
  s.embossed(labels, Math.round((120 - measure(labels, disk)) / 2), 85, disk, LIGHT, DARK);
  s.text(font, 24, 92, "ALL RIGHT", BLACK);
  // SONGNAME and SAMPLENAME.
  panel(s, 0, 100, WIDTH, 11);
  s.embossed(labels, 26, 103, "SONGNAME:", LIGHT, DARK);
  panel(s, 0, 111, WIDTH, 11);
  s.embossed(labels, 12, 114, "SAMPLENAME:", LIGHT, DARK);
  // The title over the tracks, between the pattern's number and the program's town.
  for (const [x, width] of [[0, 28], [28, 216], [244, 76]] as const) {
    s.fill(x, 122, width, 1, LIGHT);
    s.fill(x, 122, 1, 16, LIGHT);
    s.fill(x + width - 1, 123, 1, 15, DARK);
  }
  s.embossed(title, 47, 125, "THE", LIGHT, DARK);
  italic(s, 75, 125, "D.O.C", LIGHT, DARK);
  s.embossed(title, 111, 125, "SOUNDTRACKER", LIGHT, DARK);
  s.embossed(title, 203, 125, "V2.0", LIGHT, DARK);
  s.embossed(title, 46, 131, "WRITTEN BY UNKNOWN OF D.O.C", LIGHT, DARK);
  s.embossed(title, 248, 124, "D.O.C 1988", LIGHT, DARK);
  s.embossed(title, 249, 131, "2300 KIEL", LIGHT, DARK);
  // The pattern: the row numbers' well and the four tracks', sunken, and the play row's bar.
  for (const [x, width] of [[2, 26], [29, 71], [101, 71], [173, 71], [245, 73]] as const) {
    for (const [top, bottom] of [[138, 189], [202, 253]] as const) {
      s.fill(x, top, width, bottom - top + 1, BLACK);
      s.fill(x, top, width - 1, 1, DARK);
      s.fill(x, top, 1, bottom - top + 1, DARK);
      s.fill(x + width - 1, top + 1, 1, bottom - top, LIGHT);
    }
    s.fill(x, 190, width, 2, LIGHT);
    s.fill(x, 192, width, 10, GREY);
    s.fill(x, 254, width, 1, LIGHT);
  }
  return s;
}

export function createDocSoundTracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const bars = new NoteBars(4, SPEC.low, SPEC.high, 0.9);
  const meters = new Meters(4, 1.3);
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;
  let scroll = "";
  let scrollFor: string | null = null;
  /** The scroll text's window, drawn apart and copied in so the letters end at its edges. */
  const strip = new Surface(118, 5);

  /** One track's cell as the D.O.C SoundTracker writes it: note, sample, effect ("D-3 3000"). */
  const cellText = (channel: number, row: number): string => {
    song.cell(channel, row, cell);
    const p = cell.param & 255;
    let effect = "000";
    switch (cell.effect) {
      case "arpeggio": effect = `0${hex(p, 2)}`; break;
      case "slideUp": effect = `1${hex(p, 2)}`; break;
      case "slideDown": effect = `2${hex(p, 2)}`; break;
      case "volume": effect = `C${hex(Math.min(64, p), 2)}`; break;
      case "speed": effect = `F${hex(Math.max(1, Math.min(15, p)), 2)}`; break;
      default:
        // No volume column: a note not at full volume sets its volume with C.
        if (cell.volume >= 0 && cell.volume < 0x38 && cell.note >= 0 && cell.note < 120) effect = `C${hex(cell.volume, 2)}`;
    }
    return `${noteText(cell.note, "---")} ${hex(cell.instrument & 15, 1)}${effect}`;
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
    s.fill(30, 190, 11, 2, CURSOR);
    s.fill(30, 202, 11, 1, CURSOR);
    s.fill(30, 192, 1, 10, CURSOR);
    s.fill(40, 192, 1, 10, CURSOR);
  };

  /** The fields that change, and the scroll text: the song's name and where it stands. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const length = song.length(frame.track.duration);
    s.text(font, 65, 3, decimal(song.position, 4), BLACK);
    s.text(font, 65, 14, decimal(song.pattern, 4), BLACK);
    s.text(font, 65, 25, decimal(length, 4), BLACK);
    s.text(font, 65, 36, "0001", BLACK);
    s.text(font, 65, 47, "000F", BLACK);
    s.text(font, 65, 58, "0040", BLACK);
    const name = printable(frame.track.title, font, true);
    s.text(font, 106, 103, fieldText(name, 20, true, "_"), BLACK);
    s.text(font, 106, 114, fieldText("ST-01:BASSDRUM1", 22, true, "_"), BLACK);
    s.text(font, 8, 131, decimal(song.pattern, 2), BLACK);
    // The scroll text runs through the strip under the fields.
    if (scrollFor !== frame.track.title) {
      scrollFor = frame.track.title;
      const playing = fieldText(name, 40, true).trim();
      scroll = `${playing ? `NOW PLAYING: ${playing} ... ` : ""}THE D.O.C SOUNDTRACKER V2.0 PLAYS ALONG WITH YOUR MUSIC ... FOUR VOICES, FIFTEEN SAMPLES ... HAVE A NICE DAY!`;
    }
    const offset = scrollOffset(frame.time, 40, scroll.length * 8, strip.width);
    strip.fill(0, 0, strip.width, strip.height, GREY);
    const start = strip.width - offset;
    const first = Math.max(0, Math.floor(-start / 8));
    const last = Math.min(scroll.length, Math.ceil((strip.width - start) / 8));
    if (last > first) strip.text(font, start + first * 8, 0, scroll.slice(first, last), BLACK);
    s.copy(strip, 0, 0, strip.width, strip.height, 1, 71);
  };

  const drawAnalyzer = (s: Surface): void => {
    for (let bar = 0; bar < 23; bar += 1) {
      const segments = Math.round(bars.levels[bar]! * SEGMENTS);
      const x = SLOT_LEFT + bar * 8 + 2;
      for (let segment = 0; segment < segments; segment += 1) s.fill(x, 95 - segment * 2, 4, 1, BLACK);
    }
  };

  const drawMeters = (s: Surface): void => {
    for (let channel = 0; channel < 4; channel += 1) {
      const height = Math.round(meters.values[channel]! * METER_HEIGHT);
      const x = TRACK_LEFT + channel * TRACK_STEP + 26;
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
        base.copy(chrome, 0, 138, WIDTH, HEIGHT - 138, 0, 138);
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
