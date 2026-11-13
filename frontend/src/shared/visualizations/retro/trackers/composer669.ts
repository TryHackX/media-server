import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { VGA } from "./fonts";
import { VGA_669 } from "./fonts-8bit";
import { decimal, hex } from "./notation";
import { printable, rgb, sheet, Surface, Target, type Font } from "./raster";
import { emptyCell, ROWS, Song, type Cell, type SongSpec } from "./song";

/**
 * Composer 669 1.3 (Tran of Renaissance, DOS, 1992) playing along: its one screen in VGA's
 * 80 × 50 text mode, a character 8 × 8, in the deep blue of its colour set — the title bar, the
 * samples with their loop start, loop end and length, the song's message in a black box, the
 * Sound Blaster Pro's mixer as purple bars, the fields of what plays (Vol, Ord, Pat, Row, Loop,
 * Inst), each channel's sample and volume in squares, the order list with each pattern's tempo,
 * the eight channels "On", and under them half a pattern, 32 rows, with the break column and
 * every fourth row shaded; the status bar at the foot. Tracking, the editor's line follows the
 * row playing down the half shown, and the other half comes up when it gets there.
 *
 * The module is song.ts's on the first PC tracker with eight channels: kick and snare, hi-hats
 * (and a snare that meets a kick), the bass, the lead, its echo, and a chord's three notes side
 * by side, as 669 has no arpeggio. Its volume column is written on every row a note fades on, as
 * 669 composers faded their notes, having no volume slide either.
 */

const WIDTH = 640;
const HEIGHT = 400;
const CELL = 8;

/** The colour set of the reference: Composer 669 sets the VGA's palette to its own blues. */
const BAR_BLUE = rgb(0x2c5986);
const TITLE = rgb(0x00d3ff);
const DESK = rgb(0x1c3855);
const BRIGHT = rgb(0x00c7be);
const TEAL = rgb(0x007d75);
const BLACK = rgb(0x000000);
const LIGHT = rgb(0x82bedf);
const DIM = rgb(0x698a9a);
const BEAT = rgb(0x283441);
const PURPLE = rgb(0x410082);
const VIOLET = rgb(0x5100a2);
const COMMAND = rgb(0x8200ff);
const COMMAND_VALUE = rgb(0x6100c3);
/** The volume squares, four to a shade. */
const SQUARES = [rgb(0x410082), rgb(0x490092), rgb(0x5100a2), rgb(0x6100c3)];

const vga = sheet(VGA.sheet, VGA.cell, VGA.height, VGA.fixed);
const own = sheet(VGA_669.sheet, VGA_669.cell, VGA_669.height, VGA_669.fixed);
const font: Font = { ...vga, glyphs: new Map([...vga.glyphs, ...own.glyphs]) };

const CHANNELS = 8;
const SPEC: SongSpec = {
  channels: [
    { parts: ["kick", "snare"] }, { parts: ["hats", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] },
    { parts: ["echo"] }, { parts: ["chord"] }, { parts: ["chord"] }, { parts: ["chord"] }
  ],
  // C 0 … B 4, the five octaves of a 669 module.
  low: 0,
  high: 59,
  drums: { kick: 24, snare: 26, hats: 31 },
  floors: { bass: 12, lead: 36, chord: 24 },
  // 669 counts its samples from 00; the echo is the lead's sample, quieter.
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 6 },
  positions: 128,
  chordVoices: true,
  seed: 669
};

/** The samples: name, loop start, loop end (FFFFF: none), length, as the list shows them. */
const SAMPLES: readonly (readonly [string, number, number, number])[] = [
  ["Bassdrum", 0x00000, 0xfffff, 0x01f4a],
  ["Snare", 0x00000, 0xfffff, 0x02a16],
  ["Closed hihat", 0x00000, 0xfffff, 0x00b8c],
  ["Open hihat", 0x00000, 0xfffff, 0x02164],
  ["Bass", 0x00a40, 0x01e2c, 0x01e2c],
  ["Lead", 0x00620, 0x013b8, 0x013b8],
  ["Strings", 0x01c00, 0x0a4f0, 0x0a4f0]
];
const SAMPLES_SHOWN = 12;
const MEMORY = Math.round(SAMPLES.reduce((sum, sample) => sum + sample[3], 0) / 1024);

/** The screen's places, in characters. */
const SAMPLE_TOP = 2;
const MESSAGE_LEFT = 35;
const MESSAGE_WIDTH = 36;
const INFO_LEFT = 43;
const INFO_TOP = 7;
const MONITOR_TOP = 6;
const MONITOR_LEFT = 53;
const ORDER_LEFT = 72;
const ORDERS_SHOWN = 12;
const HEADER_ROW = 15;
const PATTERN_TOP = 16;
const VISIBLE = 32;
const CHANNEL_LEFT = 8;
const CHANNEL_STEP = 9;
const STATUS_ROW = 49;
/** The SBPro mixer's seven bars (master, voice and line left and right, the microphone), in pixels. */
const MIXER_LEFT = 280;
const MIXER_BOTTOM = 111;
const MIXER_LEVELS = [36, 36, 36, 36, 4, 4, 4];

const at = (cells: number): number => cells * CELL;

function put(s: Surface, column: number, row: number, text: string, color: number, background?: number): void {
  if (background !== undefined) s.fill(at(column), at(row), text.length * CELL, CELL, background);
  s.text(font, at(column), at(row), text, color);
}

/** The tempo of a 669 pattern: ticks a row at the player's 31.2 ticks a second. */
function speedOf(bpm: number): number {
  return Math.max(1, Math.min(15, Math.round(468 / bpm)));
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, DESK);
  s.fill(0, 0, WIDTH, CELL, BAR_BLUE);
  put(s, 2, 0, "Composer 669: (c) 1992, Tran", TITLE);
  put(s, 34, 0, "Soundcard: SBPro", TITLE);
  put(s, 58, 0, "File:", TITLE);
  s.fill(0, at(STATUS_ROW), WIDTH, CELL, BAR_BLUE);
  put(s, 3, STATUS_ROW, "Tempo:", TITLE);
  put(s, 15, STATUS_ROW, "Octave: 2", TITLE);
  put(s, 28, STATUS_ROW, "Voice: 0", TITLE);
  put(s, 40, STATUS_ROW, "Pattern:", TITLE);
  put(s, 55, STATUS_ROW, "Order:", TITLE);
  put(s, 68, STATUS_ROW, `Mem: ${decimal(MEMORY, 4)}k`, TITLE);
  // The samples, the first one chosen (Inst).
  for (let index = 0; index < SAMPLES_SHOWN; index += 1) {
    const row = SAMPLE_TOP + index;
    const chosen = index === 0;
    const [name, loop, end, length] = SAMPLES[index] ?? ["", 0, 0xfffff, 0];
    const field = chosen ? BAR_BLUE : BLACK;
    const color = chosen ? LIGHT : DIM;
    put(s, 1, row, hex(index, 2), chosen ? BRIGHT : TEAL, BLACK);
    put(s, 4, row, name.padEnd(12).slice(0, 12), color, field);
    put(s, 17, row, hex(loop, 5), color, field);
    put(s, 23, row, hex(end, 5), color, field);
    put(s, 29, row, hex(length, 5), color, field);
  }
  // The message's box, the fields of what plays, the channels' boxes, the order list's.
  s.fill(at(MESSAGE_LEFT), at(2), at(MESSAGE_WIDTH), at(3), BLACK);
  ["Vol:", "Ord:", "Pat:", "Row:", "Loop:", "Inst:"].forEach((label, index) => {
    put(s, INFO_LEFT, INFO_TOP + index, label, TEAL);
    if (index > 0) s.fill(at(49), at(INFO_TOP + index), at(2), CELL, BLACK);
  });
  put(s, 50, INFO_TOP, "F", BRIGHT);
  for (let channel = 0; channel < CHANNELS; channel += 1) s.fill(at(MONITOR_LEFT), at(MONITOR_TOP + channel), at(2), CELL, BLACK);
  for (let index = 0; index < ORDERS_SHOWN; index += 1) {
    const row = SAMPLE_TOP + index;
    s.fill(at(ORDER_LEFT), at(row), at(2), CELL, BLACK);
    s.fill(at(ORDER_LEFT + 3), at(row), at(2), CELL, BLACK);
    s.fill(at(ORDER_LEFT + 6), at(row), CELL, CELL, BLACK);
  }
  // The mixer: dark and light purple by turns, each its level high.
  MIXER_LEVELS.forEach((level, index) => s.fill(MIXER_LEFT + index * CELL, MIXER_BOTTOM + 1 - level, CELL, level, index % 2 ? VIOLET : PURPLE));
  // The channels' lights, and the pattern's row numbers and break column.
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const column = CHANNEL_LEFT + channel * CHANNEL_STEP;
    s.fill(at(column), at(HEADER_ROW), at(8), CELL, TEAL);
    put(s, column + 3, HEADER_ROW, "On", BRIGHT);
  }
  s.fill(at(1), at(PATTERN_TOP), at(2), at(VISIBLE), BLACK);
  s.fill(at(4), at(PATTERN_TOP), at(3), at(VISIBLE), PURPLE);
  return s;
}

/** A DOS name for the track: its first words, upper case, eight letters at most. */
function fileName(title: string): string {
  const name = printable(title.split(/\s[—–-]\s/)[0] ?? "", font).toUpperCase().replace(/[^A-Z0-9_]+/g, "").slice(0, 8);
  return name || "UNTITLED";
}

/** The song's message: the title and the artist, each in the middle of its line. */
function message(title: string): string[] {
  const [name = "", ...rest] = title.split(/\s[—–]\s/);
  return [name, rest.join(" — "), ""].map((line) => {
    const text = printable(line, font).replace(/\s+/g, " ").trim().slice(0, MESSAGE_WIDTH);
    return " ".repeat(Math.floor((MESSAGE_WIDTH - text.length) / 2)) + text;
  });
}

const NAMES = ["C ", "C#", "D ", "D#", "E ", "F ", "F#", "G ", "G#", "A ", "A#", "B "];

/** A command as 669 writes it: a letter and a digit (a, b slide, c to a note, e vibrato, f tempo). */
function command(cell: Cell): string | null {
  const low = Math.max(1, Math.min(15, cell.param & 15));
  switch (cell.effect) {
    case "slideUp": return `a${hex(low, 1)}`;
    case "slideDown": return `b${hex(low, 1)}`;
    case "tonePorta": return `c${hex(Math.max(1, (cell.param >> 4) & 15), 1)}`;
    case "vibrato": return `e${hex(low, 1)}`;
    case "speed": return `f${hex(Math.min(15, cell.param), 1)}`;
    case "tempo": return `f${hex(speedOf(cell.param), 1)}`;
    default: return null;
  }
}

export function createComposer669(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const meters = new Float32Array(CHANNELS);
  const seen = new Float64Array(CHANNELS);
  const volumes = new Int8Array(CHANNELS);
  // The screen with the half pattern as it stands, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  /**
   * The volume a cell writes (0–F), or -1 for none: a note's own, and down a step a row while a
   * held note fades (669 has no volume slide, so its composers wrote the fade out).
   */
  const volumeOf = (channel: number, from: Cell): number => {
    if (from.note >= 0 && from.note < 120) return (volumes[channel] = Math.round((Math.max(0, from.volume) * 15) / 64));
    if (from.effect !== "volumeSlide" || volumes[channel]! <= 0) return -1;
    return (volumes[channel] = Math.max(0, volumes[channel]! - Math.max(1, Math.round(from.param / 4))));
  };

  /** One channel's cell at a row of the half shown: note, sample, volume, command, dots for empty. */
  const drawCell = (s: Surface, channel: number, row: number, y: number, playing: boolean): void => {
    song.cell(channel, row, cell);
    const x = CHANNEL_LEFT + channel * CHANNEL_STEP;
    const dots = playing ? LIGHT : DIM;
    const bright = LIGHT;
    if (cell.note >= 0 && cell.note < 120) {
      const name = NAMES[cell.note % 12]!;
      put(s, x, y, name[0]!, bright);
      if (name[1] === "#") put(s, x + 1, y, "#", bright);
      put(s, x + 2, y, String(Math.floor(cell.note / 12)), bright);
      put(s, x + 3, y, hex(Math.max(0, cell.instrument - 1), 2), playing ? bright : DIM);
    } else {
      put(s, x, y, "···", dots);
      put(s, x + 3, y, "··", dots);
    }
    const volume = volumeOf(channel, cell);
    if (volume >= 0) put(s, x + 5, y, hex(volume, 1), bright);
    else put(s, x + 5, y, "·", dots);
    const written = command(cell);
    if (written) {
      put(s, x + 6, y, written[0]!, playing ? bright : COMMAND);
      put(s, x + 7, y, written[1]!, playing ? bright : COMMAND_VALUE);
    } else {
      put(s, x + 6, y, "··", dots);
    }
  };

  /** The half pattern holding the row playing, the editor's line on that row. */
  const drawPattern = (s: Surface): void => {
    const current = song.row;
    const first = current - (current % VISIBLE);
    volumes.fill(0);
    // The volumes written before the half shown, so a fade carries on into it.
    for (let row = 0; row < first; row += 1) {
      for (let channel = 0; channel < CHANNELS; channel += 1) volumeOf(channel, song.cell(channel, row, cell));
    }
    for (let line = 0; line < VISIBLE; line += 1) {
      const row = first + line;
      const y = PATTERN_TOP + line;
      const playing = row === current;
      const background = playing ? BAR_BLUE : row % 4 === 0 ? BEAT : BLACK;
      put(s, 1, y, hex(row, 2), playing ? BRIGHT : TEAL);
      if (row === ROWS - 1) put(s, 4, y, "-B-", LIGHT);
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        s.fill(at(CHANNEL_LEFT + channel * CHANNEL_STEP), at(y), at(8), CELL, background);
        drawCell(s, channel, row, y, playing);
      }
    }
  };

  /** What changes as the song plays: its place, the order list, each channel's sample and volume. */
  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const speed = speedOf(song.bpm);
    const length = song.length(frame.track.duration);
    put(s, 64, 0, fileName(frame.track.title), TITLE);
    message(frame.track.title).forEach((line, index) => put(s, MESSAGE_LEFT, 2 + index, line, TEAL));
    put(s, 49, INFO_TOP + 1, hex(song.position, 2), BRIGHT);
    put(s, 49, INFO_TOP + 2, hex(song.pattern, 2), BRIGHT);
    put(s, 49, INFO_TOP + 3, hex(song.row, 2), BRIGHT);
    put(s, 49, INFO_TOP + 4, "00", BRIGHT);
    put(s, 49, INFO_TOP + 5, "00", BRIGHT);
    const first = Math.max(0, Math.min(song.position - 5, length - ORDERS_SHOWN));
    for (let index = 0; index < ORDERS_SHOWN; index += 1) {
      const order = first + index;
      if (order >= length) break;
      const row = SAMPLE_TOP + index;
      put(s, ORDER_LEFT, row, hex(order, 2), order === song.position ? BRIGHT : TEAL);
      put(s, ORDER_LEFT + 3, row, hex(song.patternAt(order), 2), DIM);
      put(s, ORDER_LEFT + 6, row, hex(speed, 1), DIM);
    }
    put(s, 10, STATUS_ROW, hex(speed, 1), TITLE);
    put(s, 49, STATUS_ROW, hex(song.pattern, 2), TITLE);
    put(s, 62, STATUS_ROW, hex(song.position, 2), TITLE);
  };

  /** Each channel's sample and its volume in squares, rising at a note and falling away. */
  const drawMonitor = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const hits = song.hits(channel);
      let value = meters[channel]! - dt * 1.6;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        value = Math.max(value, song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel) * 0.9);
      meters[channel] = Math.max(0, Math.min(1, value));
      const row = MONITOR_TOP + channel;
      put(s, MONITOR_LEFT, row, hex(Math.max(0, song.instrumentOf(channel) - 1), 2), BAR_BLUE);
      const squares = Math.round(meters[channel]! * 15);
      for (let square = 0; square < squares; square += 1) s.fill(at(MONITOR_LEFT + 2 + square) + 2, at(row) + 2, 4, 4, SQUARES[square >> 2]!);
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
        base.copy(chrome, 0, at(PATTERN_TOP), WIDTH, at(VISIBLE), 0, at(PATTERN_TOP));
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawMonitor(screen, frame.dt);
      target.close(image);
    }
  };
}
