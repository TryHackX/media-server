import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { AMIGA, AMIGA_TINY } from "./fonts";
import { clock, decimal, fieldText, hex, modEffect, noteText } from "./notation";
import { measure, mix, printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * ProTracker 2.3 (Amiga, 1993) playing along: its 320 × 256 main screen as it looks with a
 * module running — the grey panel of position, pattern and sample fields with their arrows, the
 * PLAY/STOP/EDIT buttons, the quadrascope's four channels (or, as the second view, the spectrum
 * analyzer the same panel switches to), SONGNAME and SAMPLENAME, the status line, and the four
 * tracks scrolling under the play row in the middle, each with its meter rising over the rows
 * already played.
 *
 * The module is song.ts's: drums on the first track (a snare that meets a kick moves to the
 * fourth), the bass on the second, the lead on the third, hi-hats and chords on the fourth.
 * Everything here is drawn from this project's own font (fonts.ts) and these coordinates.
 */

export type ProTrackerView = "scope" | "spectrum";

const WIDTH = 320;
const HEIGHT = 256;

const BLACK = rgb(0x000000);
const LIGHT = rgb(0xbbbbbb);
const GREY = rgb(0x888888);
const DARK = rgb(0x555555);
const NOTES = rgb(0x3355ff);
const SCOPE = rgb(0xffdd22);
const CURSOR_LIGHT = rgb(0xff4477);
const CURSOR_DARK = rgb(0xaa1122);

const font = sheet(AMIGA.sheet, AMIGA.cell, AMIGA.height, AMIGA.fixed);
/** The panels' labels set the same capitals a pixel closer than the fields and the tracks do. */
const labels = { ...font, width: 7 };
const tiny = sheet(AMIGA_TINY.sheet, AMIGA_TINY.cell, AMIGA_TINY.height, AMIGA_TINY.fixed);

/** The arrow buttons' arrows, six pixels wide and high. */
const UP = [0b001100, 0b011110, 0b111111, 0b001100, 0b001100, 0b001100];
const DOWN = [0b001100, 0b001100, 0b001100, 0b111111, 0b011110, 0b001100];

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  // C-1 … B-3, the three octaves of a ProTracker keyboard.
  low: 12,
  high: 47,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 12, lead: 24, chord: 24 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 128,
  seed: 23
};

/** The layout: rows of the top panel, the scope area, the pattern area. */
const ROW_HEIGHT = 11;
const SCOPE_TOP = 55;
const SCOPE_HEIGHT = 33;
const PATTERN_TOP = 137;
/** Text rows of the pattern: seven above the play row, the play row's bar, seven below. */
const ABOVE_TOP = 141;
const BAR_TOP = 189;
const BELOW_TOP = 205;
const LINE = 7;
const TRACK_LEFT = 29;
const TRACK_STEP = 72;
const METER_HEIGHT = 47;
const BANDS = 23;

/** A raised panel of the Amiga's grey. */
function panel(surface: Surface, x: number, y: number, width: number, height: number): void {
  surface.fill(x, y, width, height, GREY);
  surface.bevel(x, y, width, height, LIGHT, DARK, GREY);
}

/** A sunken box, black inside. */
function well(surface: Surface, x: number, y: number, width: number, height: number): void {
  surface.fill(x, y, width, height, BLACK);
  surface.bevel(x, y, width, height, DARK, LIGHT, GREY);
}

/** A raised button with its label in the middle. */
function button(surface: Surface, x: number, y: number, width: number, label: string): void {
  panel(surface, x, y, width, ROW_HEIGHT);
  const textWidth = measure(labels, label) - 1;
  surface.embossed(labels, x + Math.round((width - textWidth) / 2), y + 3, label, LIGHT, DARK);
}

function arrows(surface: Surface, x: number, y: number): void {
  for (const [offset, shape] of [[0, UP], [11, DOWN]] as const) {
    panel(surface, x + offset, y, 11, ROW_HEIGHT);
    surface.bits(x + offset + 3, y + 3, shape, 6, DARK);
    surface.bits(x + offset + 2, y + 2, shape, 6, LIGHT);
  }
}

/** The meters' colours from the bottom up, and across each one: lit on the left, shaded right. */
const METER = (() => {
  const rows: number[][] = [];
  for (let step = 0; step < METER_HEIGHT; step += 1) {
    const t = step / (METER_HEIGHT - 1);
    const base = t < 0.55 ? mix(0x22cc00, 0xffee00, t / 0.55) : mix(0xffee00, 0xff4400, (t - 0.55) / 0.45);
    rows.push([mix(base, 0xffffff, 0.45), mix(base, 0xffffff, 0.15), base, base, base, base, base, mix(base, 0x000000, 0.2), mix(base, 0x000000, 0.35), mix(base, 0x000000, 0.5)].map(rgb));
  }
  return rows;
})();

/** The analyzer's bars, coloured by height as the meters are. */
const BAR_COLOURS = Array.from({ length: SCOPE_HEIGHT }, (_, step) => {
  const t = step / (SCOPE_HEIGHT - 1);
  return rgb(t < 0.55 ? mix(0x22cc00, 0xffee00, t / 0.55) : mix(0xffee00, 0xff3300, (t - 0.55) / 0.45));
});

/** The panel as it stands, without the values that change. */
function drawChrome(view: ProTrackerView): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, GREY);
  // The fields on the left: POS with its insert and delete buttons, then the rest.
  const top = ["POS", "PATTERN", "LENGTH", "FINETUNE"];
  for (let row = 0; row < 4; row += 1) {
    const y = row * ROW_HEIGHT;
    if (row === 0) {
      button(s, 0, y, 40, "POS");
      button(s, 40, y, 11, "I");
      button(s, 51, y, 11, "D");
    } else {
      button(s, 0, y, 62, top[row]!);
    }
    panel(s, 62, y, 36, ROW_HEIGHT);
    arrows(s, 98, y);
  }
  panel(s, 0, 44, 62, 55);
  const sample = ["SAMPLE", "VOLUME", "LENGTH", "REPEAT", "REPLEN"];
  for (let row = 0; row < 5; row += 1) {
    const y = 44 + row * ROW_HEIGHT;
    const label = sample[row]!;
    s.embossed(labels, Math.round((62 - (measure(labels, label) - 1)) / 2), y + 3, label, LIGHT, DARK);
    panel(s, 62, y, 36, ROW_HEIGHT);
    arrows(s, 98, y);
  }
  // The buttons, four rows of three and the numbered column.
  const buttons = [["PLAY", "STOP", "PLST"], ["PATTERN", "CLEAR", "PSET-ED"], ["EDIT", "EDIT OP.", "SETUP"], ["RECORD", "DISK OP.", "SAMPLER"]];
  for (let row = 0; row < 4; row += 1) {
    const y = row * ROW_HEIGHT;
    for (let column = 0; column < 3; column += 1) button(s, 120 + column * 62, y, 62, buttons[row]![column]!);
    button(s, 306, y, 14, String(row + 1));
  }
  // The quadrascope (or the analyzer) under its title.
  button(s, 120, 44, 186, view === "scope" ? "QUADRASCOPE" : "SPECTRUM ANALYZER");
  panel(s, 306, 44, 14, ROW_HEIGHT);
  if (view === "scope") {
    for (let channel = 0; channel < 4; channel += 1) {
      const x = 120 + channel * 48;
      panel(s, x, SCOPE_TOP, 8, SCOPE_HEIGHT);
      s.embossed(tiny, x + 2, SCOPE_TOP + 2, String(channel + 1), LIGHT, DARK);
      well(s, x + 8, SCOPE_TOP, 40, SCOPE_HEIGHT);
    }
    panel(s, 312, SCOPE_TOP, 8, SCOPE_HEIGHT);
  } else {
    well(s, 120, SCOPE_TOP, 200, SCOPE_HEIGHT);
  }
  panel(s, 120, 88, 200, ROW_HEIGHT);
  s.embossed(tiny, 126, 91, "PROTRACKER V2.3D", DARK, LIGHT);
  s.embossed(tiny, 314 - 20 * 4, 91, "NOXIOUS JANUARY 1993", DARK, LIGHT);
  // SONGNAME and SAMPLENAME.
  panel(s, 0, 99, WIDTH, ROW_HEIGHT);
  s.text(font, 25, 102, "1", BLACK);
  s.embossed(labels, 34, 102, "SONGNAME:", LIGHT, DARK);
  panel(s, 0, 110, 289, ROW_HEIGHT);
  s.embossed(labels, 18, 113, "SAMPLENAME:", LIGHT, DARK);
  button(s, 289, 110, 31, "LOAD");
  // The status line.
  panel(s, 0, 121, WIDTH, 16);
  s.fill(5, 124, 21, 12, GREY);
  s.bevel(5, 124, 21, 12, DARK, LIGHT, GREY);
  s.bits(28, 131, [0b010, 0b111], 3, BLACK);
  s.text(tiny, 33, 130, "TEMPO", DARK);
  s.bits(54, 131, [0b111, 0b010], 3, BLACK);
  s.embossed(tiny, 62, 128, "STATUS:", DARK, LIGHT);
  s.embossed(labels, 226, 123, "TUNE", LIGHT, DARK);
  s.embossed(labels, 226, 130, "FREE", LIGHT, DARK);
  // The pattern area: the row numbers and the four tracks, sunken.
  panel(s, 0, PATTERN_TOP, WIDTH, HEIGHT - PATTERN_TOP);
  well(s, 2, 138, 26, 115);
  for (let track = 0; track < 4; track += 1) well(s, TRACK_LEFT + track * TRACK_STEP, 138, 71, 115);
  // The play row's bar across every box.
  const bar = (x: number, width: number): void => {
    s.fill(x, BAR_TOP, width, 14, GREY);
    s.fill(x, BAR_TOP, width, 2, LIGHT);
    s.fill(x, BAR_TOP + 12, width, 2, DARK);
    s.fill(x, BAR_TOP, 1, 14, LIGHT);
    s.fill(x + width - 1, BAR_TOP + 1, 1, 13, DARK);
  };
  bar(3, 24);
  for (let track = 0; track < 4; track += 1) bar(TRACK_LEFT + track * TRACK_STEP + 1, 69);
  return s;
}

export function createProTracker(view: ProTrackerView): RetroScene {
  const chrome = drawChrome(view);
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const meters = new Float32Array(4);
  const seen = new Float64Array(4);
  const wave = new Float32Array(40);
  const bands = new Float32Array(BANDS);
  // The panel with the tracks as they stand, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  const field = (s: Surface, x: number, y: number, text: string): void => {
    s.text(font, x, y, text, BLACK);
  };

  /** The fields that change: positions, the song's name and time, the tempo. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const length = song.length(frame.track.duration);
    field(s, 65, 3, decimal(song.position, 4));
    field(s, 65, 14, decimal(song.pattern, 4));
    field(s, 65, 25, decimal(length, 4));
    field(s, 89, 36, "0");
    field(s, 65, 47, "0001");
    field(s, 65, 58, "0040");
    field(s, 65, 69, "1A2C");
    field(s, 65, 80, "0000");
    field(s, 65, 91, "0002");
    const name = fieldText(printable(frame.track.title, font, true), 20, true, "_");
    field(s, 106, 102, name);
    field(s, 276, 102, clock(song.time));
    field(s, 106, 113, fieldText("BASSDRUM", 22, true, "_"));
    field(s, 8, 127, decimal(song.pattern, 2));
    field(s, 31, 123, decimal(song.bpm, 3));
    field(s, 94, 128, "ALL RIGHT");
    // The module's size: its patterns and samples; the chip memory left beside it.
    const tune = 1084 + (song.pattern + 1) * 1024 + 118_430;
    field(s, 272, 123, decimal(tune, 6));
    field(s, 272, 130, decimal(1_048_576 - 140_000 - tune, 6));
  };

  /**
   * Each channel's waveform, as much of it as shows a few periods of the note it plays (a drum's
   * thump at its own pace), joined up from point to point.
   */
  const drawScopes = (s: Surface, rate: number): void => {
    for (let channel = 0; channel < 4; channel += 1) {
      const part = song.partOf(channel);
      const seconds = part === "lead" || part === "chord" ? 0.006 : part === "hats" || part === "snare" ? 0.005 : 0.025;
      song.scope(channel, wave, seconds, rate);
      const x0 = 120 + channel * 48 + 9;
      const middle = SCOPE_TOP + 16;
      let last = middle - Math.round(wave[0]! * 14);
      for (let x = 0; x < 38; x += 1) {
        const y = middle - Math.round(wave[x + 1]! * 14);
        const from = Math.min(y, last + (y > last ? 1 : 0));
        const to = Math.max(y, last - (y < last ? 1 : 0));
        s.fill(x0 + x, from, 1, to - from + 1, SCOPE);
        last = y;
      }
    }
  };

  const drawAnalyzer = (s: Surface, frame: RetroFrame): void => {
    const audio = frame.audio;
    const spectrum = audio.spectrum;
    const fall = frame.dt * 40;
    for (let band = 0; band < BANDS; band += 1) {
      // Bands spaced evenly in octaves from 60 Hz to 14 kHz.
      const from = Math.max(1, Math.floor((60 * Math.pow(14000 / 60, band / BANDS)) / audio.binHz));
      const to = Math.max(from + 1, Math.floor((60 * Math.pow(14000 / 60, (band + 1) / BANDS)) / audio.binHz));
      let peak = 0;
      for (let bin = from; bin < to && bin < spectrum.length; bin += 1) peak = Math.max(peak, spectrum[bin]!);
      const height = audio.sounding ? Math.max(0, (peak - 0.25) / 0.7) * (SCOPE_HEIGHT - 3) : 0;
      bands[band] = Math.max(height, bands[band]! - fall);
      const bar = Math.round(bands[band]!);
      const x = 128 + band * 8;
      for (let step = 0; step < bar; step += 1) s.fill(x, SCOPE_TOP + SCOPE_HEIGHT - 2 - step, 6, 1, BAR_COLOURS[step]!);
    }
  };

  /** One track's cell as ProTracker writes it: note, sample, effect ("F-201903"). */
  const cellText = (channel: number, row: number): string => {
    song.cell(channel, row, cell);
    let effect = modEffect(cell.effect, cell.param);
    // No volume column: a note not at full volume sets its volume with C.
    if (cell.effect === "none" && cell.volume >= 0 && cell.volume < 0x38 && cell.note >= 0) effect = `C${hex(cell.volume, 2)}`;
    return `${noteText(cell.note, "---")}${hex(cell.instrument, 2)}${effect}`;
  };

  const drawPattern = (s: Surface): void => {
    const current = song.row;
    for (let offset = -7; offset <= 7; offset += 1) {
      const row = current + offset;
      if (row < 0 || row >= ROWS) continue;
      const playing = offset === 0;
      const y = playing ? BAR_TOP + 2 : offset < 0 ? ABOVE_TOP + (offset + 7) * LINE : BELOW_TOP + (offset - 1) * LINE;
      const color = playing ? BLACK : NOTES;
      const scale = playing ? 2 : 1;
      s.text(font, 9, y, decimal(row, 2), color, scale);
      for (let channel = 0; channel < 4; channel += 1) s.text(font, TRACK_LEFT + 4 + channel * TRACK_STEP, y, cellText(channel, row), color, scale);
    }
    // The edit cursor on the first track's note.
    s.bevel(TRACK_LEFT + 2, BAR_TOP, 11, 14, CURSOR_LIGHT, CURSOR_DARK, CURSOR_DARK);
  };

  /** The meters rise over the rows above the play row and fall back as ProTracker's did. */
  const drawMeters = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < 4; channel += 1) {
      const hits = song.hits(channel);
      let value = meters[channel]! - dt * 1.3;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        value = Math.max(value, song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel) * 0.9);
      meters[channel] = Math.max(0, Math.min(1, value));
      const height = Math.round(meters[channel]! * METER_HEIGHT);
      const x = TRACK_LEFT + channel * TRACK_STEP + 26;
      for (let step = 0; step < height; step += 1) {
        const colours = METER[step]!;
        const y = BAR_TOP - 2 - step;
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
      const pixels = target.open(image);
      if (!screen || screen.pixels !== pixels) screen = new Surface(WIDTH, HEIGHT, pixels);
      if (song.changes !== drawn) {
        drawn = song.changes;
        base.copy(chrome, 0, PATTERN_TOP, WIDTH, HEIGHT - PATTERN_TOP, 0, PATTERN_TOP);
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      if (view === "scope") drawScopes(screen, frame.audio.rate);
      else drawAnalyzer(screen, frame);
      drawMeters(screen, frame.dt);
      target.close(image);
    }
  };
}
