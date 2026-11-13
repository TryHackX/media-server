import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { AHX_DATA, AHX_LABEL } from "./fonts-gui";
import { clock, decimal, hex, noteText } from "./notation";
import { printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * AHX 2.3d (Abyss' Highest eXperience, Amiga, 1998; Dexter and Pink of Abyss) playing along:
 * its 320 × 256 main screen in the mauve of its panels — the screen's white title bar, the
 * position, length, restart, track length and subsong fields with their arrows, the position
 * editor (each position's four tracks and their transposes, the one playing on a dark bar with
 * the blue edit cursor), the song's name, PLAY, STOP and the instrument, the status line, a
 * track field and a speaker for each channel, and the four tracks scrolling through the dark
 * play row, each with its blue meter rising over the rows already played.
 *
 * The module is song.ts's: drums on the first channel (a snare that meets a kick moves to the
 * fourth), the bass on the second, the lead on the third, hi-hats and chords on the fourth; in
 * AHX each channel plays a track of its own at every position. Drawn from this project's own
 * fonts (fonts-gui.ts) and these coordinates, after screenshots of the program.
 */

const WIDTH = 320;
const HEIGHT = 256;

const WHITE = rgb(0xffffff);
const BLACK = rgb(0x000000);
const MAUVE = rgb(0x9b8791);
const SHADE = rgb(0x595465);
const TEXT = rgb(0xcdcce0);
const DIM = rgb(0xc9c3cd);
const BLUE = rgb(0x1080c0);

const data = sheet(AHX_DATA.sheet, AHX_DATA.cell, AHX_DATA.height, AHX_DATA.fixed);
/** The labels set their capitals seven pixels apart. */
const labels = { ...sheet(AHX_LABEL.sheet, AHX_LABEL.cell, AHX_LABEL.height, AHX_LABEL.fixed), width: 7 };

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  // C-1 … B-5, AHX's five octaves.
  low: 12,
  high: 71,
  drums: { kick: 24, snare: 36, hats: 48 },
  floors: { bass: 12, lead: 36, chord: 36 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 999,
  seed: 98
};

const INSTRUMENTS = ["Bassdrum", "Snare", "Closed hat", "Open hat", "Fat bass", "Lead", "Chord", "Echo"];

/** The arrows of the panel's buttons and a channel's speaker, white over a black shadow. */
const UP = [0b00100, 0b01110, 0b11111, 0b01110, 0b01110, 0b01110];
const DOWN = [0b01110, 0b01110, 0b01110, 0b11111, 0b01110, 0b00100];
const SPEAKER = [0b000101, 0b001100, 0b111100, 0b111101, 0b001100, 0b000100, 0b000001];

/** The screen's depth gadget at the title bar's end: black, shade and white. */
const DEPTH = [
  "................",
  "###############+",
  "##++++++++#####+",
  "##+######+#####+",
  "##+##++++++++##+",
  "##+##+......+##+",
  "##++++......+##+",
  "#####+......+##+",
  "#####++++++++##+",
  "###############+"
];

/** The left column's fields: label, how far below the row's top it sits, and the top of the row. */
const FIELDS = ["POS", "LEN", "RES", "TRL", "SS", "SSN", "SSP"];
const LABEL_DROP = [3, 3, 2, 2, 2, 2, 2];
const FIELD_TOP = 12;
const FIELD_STEP = 11;

/** The position editor: its rows' tops, three above the one playing and three below. */
const POSITION_ROWS = [14, 23, 32, 41, 50, 59, 68];
const POSITION_LEFT = 74;
const ENTRY_LEFT = 101;
const ENTRY_STEP = 56;

/** The tracks: their boxes, the rows above and below the play row, the meters. */
const TRACK_LEFT = 32;
const TRACK_STEP = 72;
const ABOVE_TOP = 133;
const PLAY_TOP = 189;
const BELOW_TOP = 197;
const LINE = 8;
const SIDE = 7;
const METER_LEFT = 58;
const METER_WIDTH = 17;
const METER_BOTTOM = 187;
const METER_HEIGHT = 55;

/**
 * An Amiga bevel: `light` along the top and left, `dark` along the bottom and right, the
 * corners where they meet left as they were.
 */
function bevel(s: Surface, x: number, y: number, width: number, height: number, light: number, dark: number): void {
  s.fill(x, y, width - 1, 1, light);
  s.fill(x, y, 1, height - 1, light);
  s.fill(x + width - 1, y + 1, 1, height - 1, dark);
  s.fill(x + 1, y + height - 1, width - 1, 1, dark);
}

/** A raised button of the mauve. */
function button(s: Surface, x: number, y: number, width: number, height = 11): void {
  s.fill(x, y, width, height, MAUVE);
  bevel(s, x, y, width, height, WHITE, SHADE);
}

/** A sunken field, black inside. */
function field(s: Surface, x: number, y: number, width: number, height = 11): void {
  s.fill(x, y, width, height, BLACK);
  bevel(s, x, y, width, height, SHADE, WHITE);
}

/** A shape in white over its shadow one pixel right and down. */
function raised(s: Surface, x: number, y: number, rows: readonly number[], width: number): void {
  s.bits(x + 1, y + 1, rows, width, BLACK);
  s.bits(x, y, rows, width, WHITE);
}

/** A label: white capitals over a black shadow. */
function label(s: Surface, x: number, y: number, text: string): void {
  s.text(labels, x + 1, y + 1, text, BLACK);
  s.text(labels, x, y, text, WHITE);
}

/** An arrow button. */
function arrow(s: Surface, x: number, y: number, shape: readonly number[]): void {
  button(s, x, y, 10);
  raised(s, x + 2, y + 2, shape, 5);
}

/**
 * A track's field under the status line: a white frame with a dark line inside along its top
 * and left, and a dark shadow outside along its bottom and right.
 */
function trackField(s: Surface, x: number, width: number): void {
  s.fill(x, 117, width, 12, WHITE);
  s.fill(x + 1, 118, width - 2, 10, SHADE);
  s.fill(x + 2, 119, width - 3, 9, BLACK);
  s.fill(x + width, 118, 1, 12, SHADE);
  s.fill(x + 1, 129, width, 1, SHADE);
}

/** Every other pixel of a grid in white: Intuition's sign of a field that cannot be used. */
function ghost(s: Surface, x: number, y: number, width: number, height: number): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) if ((column & 3) === ((row & 1) ? 1 : 3)) s.pixel(column, row, WHITE);
  }
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, MAUVE);
  // The screen's title bar: its names, its depth gadget.
  s.fill(0, 0, WIDTH, 10, WHITE);
  s.fill(0, 10, WIDTH, 1, BLACK);
  s.text(data, 178, 1, "Abyss", BLACK);
  s.text(data, 250, 1, "Dexter.", BLACK);
  DEPTH.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const char = row[x]!;
      if (char !== ".") s.pixel(304 + x, y, char === "#" ? BLACK : SHADE);
    }
  });
  s.fill(303, 10, 17, 1, SHADE);
  s.fill(0, 11, 1, 93, WHITE);
  s.fill(319, 11, 1, 93, SHADE);
  // The fields on the left.
  FIELDS.forEach((name, index) => {
    const y = FIELD_TOP + index * FIELD_STEP;
    label(s, 24 - name.length * 7, y + LABEL_DROP[index]!, name);
    field(s, 25, y, 26);
    arrow(s, 52, y, UP);
    arrow(s, 62, y, DOWN);
  });
  // The position editor: the positions' column, a groove, the tracks of each.
  s.fill(72, 12, 246, 1, WHITE);
  s.fill(72, 12, 1, 64, WHITE);
  s.fill(317, 13, 1, 64, SHADE);
  s.fill(73, 76, 245, 1, SHADE);
  s.fill(98, 13, 1, 63, SHADE);
  s.fill(99, 13, 1, 63, WHITE);
  // The song's name and its LOAD; PLAY, STOP, the instrument and its LOAD.
  label(s, 74, 81, "NAME");
  field(s, 103, 79, 181);
  button(s, 285, 79, 33);
  label(s, 288, 82, "LOAD");
  button(s, 3, 91, 33);
  label(s, 6, 94, "PLAY");
  button(s, 37, 91, 34);
  label(s, 40, 94, "STOP");
  button(s, 72, 91, 26);
  label(s, 74, 94, "INS");
  field(s, 99, 91, 18);
  arrow(s, 118, 91, UP);
  arrow(s, 128, 91, DOWN);
  field(s, 138, 91, 146);
  button(s, 285, 91, 33);
  label(s, 288, 94, "LOAD");
  // The status line.
  s.fill(0, 104, WIDTH, 1, SHADE);
  s.fill(0, 105, WIDTH - 1, 1, WHITE);
  s.fill(0, 106, 1, 10, WHITE);
  label(s, 3, 108, "STATUS:");
  s.fill(140, 107, 52, 8, BLACK);
  s.fill(0, 116, WIDTH, 1, SHADE);
  // A field for each channel's track, with its arrows and its speaker; the channel's number.
  arrow(s, 0, 118, UP);
  arrow(s, 10, 118, DOWN);
  trackField(s, 20, 11);
  s.text(data, 22, 120, "1", WHITE);
  for (let channel = 0; channel < 4; channel += 1) {
    const x = 30 + channel * TRACK_STEP;
    trackField(s, x, 35);
    arrow(s, x + 37, 118, UP);
    arrow(s, x + 47, 118, DOWN);
    s.fill(x + 60, 118, 10, 11, MAUVE);
    bevel(s, x + 60, 118, 10, 11, SHADE, WHITE);
    raised(s, x + 62, 120, SPEAKER, 6);
  }
  // The tracks: the row numbers' box and the four tracks', the play row's bar across them.
  s.fill(12, 130, 308, 1, WHITE);
  s.fill(12, 254, 308, 1, WHITE);
  s.fill(13, 255, 307, 1, SHADE);
  for (const x of [12, 30, 102, 174, 246, 318]) {
    s.fill(x, 130, 1, 125, WHITE);
    if (x < 318) s.fill(x + 1, 131, 1, 123, SHADE);
  }
  s.fill(319, 131, 1, 125, SHADE);
  const boxes: [number, number][] = [[14, 16], [32, 70], [104, 70], [176, 70], [248, 70]];
  for (const [x, width] of boxes) {
    s.fill(x, 131, width, 1, SHADE);
    s.fill(x, 132, width, 122, BLACK);
    s.fill(x, 188, width, 1, MAUVE);
    s.fill(x, 189, width, 7, SHADE);
    s.fill(x, 196, width, 1, MAUVE);
  }
  for (const x of [13, 31, 103, 175, 247]) s.fill(x, 189, 1, 7, SHADE);
  return s;
}

/** A cell as AHX writes it: note, instrument (two decimal digits), command and its byte. */
function cellText(cell: Cell): string {
  const note = cell.note >= 0 && cell.note < 120 ? noteText(cell.note) : "---";
  const instrument = decimal(cell.instrument, 2);
  const p = cell.param & 255;
  let command = "000";
  switch (cell.effect) {
    case "slideUp": command = `1${hex(p, 2)}`; break;
    case "slideDown": command = `2${hex(p, 2)}`; break;
    case "tonePorta": command = `3${hex(p, 2)}`; break;
    case "volumeSlide": command = `A${hex(p & 15, 2)}`; break;
    case "volume": command = `C${hex(Math.min(64, p), 2)}`; break;
    case "speed": command = `F${hex(Math.min(31, p), 2)}`; break;
    case "cut": command = `EC${hex(p & 15, 1)}`; break;
    default:
      // No volume column: a note not at full volume sets its volume with C.
      if (cell.note >= 0 && cell.note < 120 && cell.volume >= 0 && cell.volume < 0x38) command = `C${hex(cell.volume, 2)}`;
  }
  return `${note}${instrument}${command}`;
}

export function createAHX(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const meters = new Float32Array(4);
  const seen = new Float64Array(4);
  // The screen with the positions and the tracks as they stand, drawn again only when they move.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;
  let length = 1;

  /** The track a channel plays at a position: one of its own for each pattern of the song. */
  const trackAt = (position: number, channel: number): number => (song.patternAt(position) * 4 + channel + 1) % 1000;

  /** The positions around the one playing: each one's number, and its tracks with their transposes. */
  const drawPositions = (s: Surface): void => {
    s.copy(chrome, 73, 13, 244, 63, 73, 13);
    const position = song.position;
    POSITION_ROWS.forEach((y, index) => {
      const at = position + index - 3;
      if (at < 0 || at >= length) return;
      const playing = index === 3;
      if (playing) {
        s.fill(73, y - 1, 244, 1, WHITE);
        s.fill(73, y, 244, 7, SHADE);
        s.fill(73, y + 7, 244, 1, WHITE);
        s.fill(98, y - 1, 1, 9, SHADE);
      }
      const color = playing ? WHITE : DIM;
      s.text(data, POSITION_LEFT, y, decimal(at, 3), color);
      for (let channel = 0; channel < 4; channel += 1) s.text(data, ENTRY_LEFT + channel * ENTRY_STEP, y, `${decimal(trackAt(at, channel), 3)}-00`, color);
    });
    // The edit cursor on the first track's first digit.
    const y = POSITION_ROWS[3]!;
    s.fill(100, y - 2, 9, 2, BLUE);
    s.fill(100, y + 7, 9, 2, BLUE);
    s.fill(99, y - 1, 2, 9, BLUE);
    s.fill(108, y - 1, 2, 9, BLUE);
  };

  /** The channels' tracks at the position playing. */
  const drawTrackFields = (s: Surface): void => {
    for (let channel = 0; channel < 4; channel += 1) {
      const x = 32 + channel * TRACK_STEP;
      s.fill(x, 119, 32, 9, BLACK);
      s.text(data, x, 120, decimal(trackAt(song.position, channel), 3), WHITE);
    }
  };

  const drawTracks = (s: Surface): void => {
    s.copy(chrome, 12, 131, 308, 123, 12, 131);
    const current = song.row;
    for (let offset = -SIDE; offset <= SIDE; offset += 1) {
      const row = current + offset;
      if (row < 0 || row >= ROWS) continue;
      const playing = offset === 0;
      const y = playing ? PLAY_TOP : offset < 0 ? ABOVE_TOP + (offset + SIDE) * LINE : BELOW_TOP + (offset - 1) * LINE;
      const color = playing ? WHITE : TEXT;
      s.text(data, 14, y, decimal(row, 2), color);
      for (let channel = 0; channel < 4; channel += 1) {
        song.cell(channel, row, cell);
        s.text(data, TRACK_LEFT + 3 + channel * TRACK_STEP, y, cellText(cell), color);
      }
    }
  };

  /** The fields that change: position, length, the names, the status line. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const values = [song.position, length, 0, ROWS, 1, 0, 0];
    values.forEach((value, index) => s.text(data, 26, FIELD_TOP + index * FIELD_STEP + 2, decimal(value, 3), WHITE));
    ghost(s, 26, FIELD_TOP + 6 * FIELD_STEP + 1, 24, 9);
    // The song's name; the instrument the lead plays, its number and name.
    let name = printable(frame.track.title.replace(/[\u2012-\u2015]/g, "-"), data).replace(/\s+/g, " ").trim();
    if (name.length > 22) name = name.slice(0, 22);
    s.text(data, 104, 80, name, WHITE);
    const instrument = Math.max(1, song.instrumentOf(2) || 1);
    s.text(data, 100, 93, decimal(instrument, 2), WHITE);
    s.text(data, 139, 92, INSTRUMENTS[(instrument - 1) % INSTRUMENTS.length]!, WHITE);
    // The status line: what the player does, the share of the processor it takes, the time.
    s.text(data, 52, 107, song.playing ? "Playing..." : "Stopped.", BLACK);
    let load = 0;
    for (let channel = 0; channel < 4; channel += 1) load += song.level(channel);
    const percent = song.playing ? Math.min(9, 3 + Math.round(load * 2)) : 0;
    s.text(data, 220, 107, `${decimal(percent, 2)}%`, BLACK);
    s.text(data, 252, 107, `${clock(song.time)}/06`, BLACK);
  };

  /** The meters: a blue bar over each track's rows above the play row, falling as AHX's did. */
  const drawMeters = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < 4; channel += 1) {
      const hits = song.hits(channel);
      let value = meters[channel]! - dt * 1.6;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        value = Math.max(value, song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel) * 0.85);
      meters[channel] = Math.max(0, Math.min(1, value));
      const height = Math.round(meters[channel]! * METER_HEIGHT);
      if (height > 0) s.fill(METER_LEFT + channel * TRACK_STEP, METER_BOTTOM + 1 - height, METER_WIDTH, height, BLUE);
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
        drawTrackFields(base);
        drawTracks(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawMeters(screen, frame.dt);
      target.close(image);
    }
  };
}
