import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { AMIGA_TINY, FT_NOTES, FT_SMALL, FT_UI } from "./fonts";
import { clock, hex, modEffect, noteText } from "./notation";
import { measure, printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, NOTE_NONE, NOTE_OFF, ROWS, Song, type SongSpec } from "./song";

/**
 * Fasttracker II (DOS, 1994–1996) playing along: its 640 × 400 main screen in the blue of its
 * panels — the position editor with its list of song positions, tempo and pattern fields, the
 * logo, the two columns of buttons, the instrument and sample lists with the song's name, the
 * instrument banks, a scope for each of the eight channels, and the pattern editor beneath,
 * its play row a bar across the middle and the pattern scrolling through it.
 *
 * The module is song.ts's, a channel a part: kick, snare, hi-hats, bass, the lead on the left
 * and on the right by where it is heard, chords, and the lead's echo three rows later.
 */

const WIDTH = 640;
const HEIGHT = 400;

const PANEL = rgb(0x285586);
const LIGHT = rgb(0x4996eb);
const DARK = rgb(0x102034);
const BLACK = rgb(0x000000);
const WHITE = rgb(0xffffff);
const FACE = rgb(0x9696b6);
const SHADE = rgb(0x343441);
const NOTES = rgb(0x9ed3ff);
const BRIGHT = rgb(0xe7e7ff);
const SKY = rgb(0x6aaef2);

const ui = sheet(FT_UI.sheet, FT_UI.cell, FT_UI.height, FT_UI.fixed);
const notes = sheet(FT_NOTES.sheet, FT_NOTES.cell, FT_NOTES.height, FT_NOTES.fixed);
const small = sheet(FT_SMALL.sheet, FT_SMALL.cell, FT_SMALL.height, FT_SMALL.fixed);
const tiny = sheet(AMIGA_TINY.sheet, AMIGA_TINY.cell, AMIGA_TINY.height, AMIGA_TINY.fixed);

const CHANNELS = 8;
const SPEC: SongSpec = {
  channels: [{ parts: ["kick"] }, { parts: ["snare"] }, { parts: ["hats"] }, { parts: ["bass"] }, { parts: ["lead"], side: -1 }, { parts: ["lead"], side: 1 }, { parts: ["chord"] }, { parts: ["echo"] }],
  low: 0,
  high: 95,
  drums: { kick: 60, snare: 62, hats: 66 },
  floors: { bass: 24, lead: 60, chord: 48 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 256,
  noteOff: true,
  seed: 1996
};

const INSTRUMENTS = ["Bassdrum", "Snare", "Closed hihat", "Open hihat", "Fat bass", "Lead", "Strings", "Lead echo"];
const SAMPLES = ["kick", "", "", "", ""];

/** The pattern editor: rows above the play row, the bar, rows below; the channels' columns. */
const ROW_ABOVE = 177;
const BAR_TOP = 273;
const ROW_BELOW = 285;
const LINE = 8;
const SIDE = 12;
const CHANNEL_LEFT = 29;
const CHANNEL_STEP = 72;

/** Arrows for the buttons, six pixels wide. */
const UP = [0b001100, 0b011110, 0b111111, 0b001100, 0b001100, 0b001100];
const DOWN = [0b001100, 0b001100, 0b001100, 0b111111, 0b011110, 0b001100];
const LEFT = [0b000100, 0b001100, 0b011111, 0b111111, 0b011111, 0b001100, 0b000100];
const RIGHT = [0b100000, 0b110000, 0b111110, 0b111111, 0b111110, 0b110000, 0b100000];

/** How much of a channel's band a scope shows: a few periods of a pitched part, a drum's thump. */
function scopeSeconds(part: string | null): number {
  return part === "lead" || part === "echo" || part === "chord" ? 0.008 : part === "hats" || part === "snare" ? 0.006 : 0.03;
}

/** A panel: the blue with a light edge above and left, a dark one below and right. */
function panel(s: Surface, x: number, y: number, width: number, height: number): void {
  s.fill(x, y, width, height, PANEL);
  s.bevel(x, y, width, height, LIGHT, DARK, PANEL);
}

/** A sunken black box. */
function well(s: Surface, x: number, y: number, width: number, height: number): void {
  s.fill(x, y, width, height, BLACK);
  s.bevel(x - 1, y - 1, width + 2, height + 2, DARK, LIGHT, PANEL);
}

/** A button: black outline, the grey face lit above and left, its label in black. */
function button(s: Surface, x: number, y: number, width: number, height: number, label = "", arrow?: readonly number[]): void {
  s.fill(x, y, width, height, BLACK);
  s.fill(x + 1, y + 1, width - 2, height - 2, FACE);
  s.fill(x + 1, y + 1, width - 2, 1, WHITE);
  s.fill(x + 1, y + 1, 1, height - 2, WHITE);
  s.fill(x + 1, y + height - 2, width - 2, 1, SHADE);
  s.fill(x + width - 2, y + 1, 1, height - 2, SHADE);
  if (arrow) {
    const tall = arrow.length;
    s.bits(x + Math.floor((width - 6) / 2), y + Math.floor((height - tall) / 2), arrow, 6, BLACK);
  } else if (label) {
    s.text(ui, x + Math.round((width - measure(ui, label)) / 2), y + Math.floor((height - 8) / 2), label, BLACK);
  }
}

/** White lettering with a dark shadow, as the panels' labels are. */
function label(s: Surface, x: number, y: number, text: string, color = WHITE): number {
  s.text(ui, x + 1, y + 1, text, BLACK);
  return s.text(ui, x, y, text, color);
}

/** A label ending at `right`. */
function value(s: Surface, right: number, y: number, text: string): void {
  label(s, right - measure(ui, text), y, text);
}

function arrowPair(s: Surface, x: number, y: number): void {
  button(s, x, y, 17, 13, "", UP);
  button(s, x + 18, y, 17, 13, "", DOWN);
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, PANEL);
  // The position editor: the song's positions around the one playing, and its buttons.
  panel(s, 0, 0, 112, 77);
  well(s, 3, 3, 50, 17);
  well(s, 3, 32, 50, 17);
  button(s, 56, 2, 17, 13, "", UP);
  well(s, 57, 16, 15, 19);
  button(s, 56, 36, 17, 13, "", DOWN);
  button(s, 75, 2, 34, 15, "Ins.");
  arrowPair(s, 74, 18);
  button(s, 75, 32, 34, 15, "Del.");
  label(s, 3, 51, "Songlen.");
  label(s, 3, 64, "Repstart");
  arrowPair(s, 76, 49);
  arrowPair(s, 76, 62);
  // The logo: the name over a sky of blue diamonds, and its makers beside it.
  panel(s, 112, 0, 155, 33);
  for (let y = 1; y < 32; y += 1) {
    for (let x = 113; x < 266; x += 1) {
      const wave = Math.sin(x * 0.11 + Math.sin(y * 0.23 + x * 0.02) * 1.6) + Math.cos(y * 0.29 - x * 0.07);
      const diamond = (Math.abs(((x - 113) % 26) - 13) + Math.abs((y % 18) - 9)) < 9;
      const tone = wave > 0.9 ? SKY : wave > -0.2 ? (diamond ? LIGHT : PANEL) : diamond ? PANEL : DARK;
      s.pixel(x, y, tone);
    }
  }
  const logo = "Fasttracker";
  const logoWidth = measure(ui, logo) * 2;
  const logoX = 113 + Math.floor((153 - logoWidth) / 2);
  s.text(ui, logoX + 2, 5, logo, BLACK, 2, 2);
  s.text(ui, logoX + 1, 4, logo, DARK, 2, 2);
  s.text(ui, logoX, 3, logo, WHITE, 2, 2);
  s.text(ui, 247, 23, "II", BLACK);
  s.text(ui, 246, 22, "II", WHITE);
  panel(s, 267, 0, 24, 33);
  for (const [text, y] of [["BY", 3], ["TRITON", 10], ["PROD.", 17], ["1996", 25]] as const) s.text(tiny, 267 + Math.floor((24 - text.length * 4) / 2) + 1, y, text, WHITE);
  // Tempo and pattern fields.
  panel(s, 112, 33, 90, 44);
  label(s, 115, 36, "BPM");
  label(s, 115, 50, "Spd.");
  label(s, 115, 64, "Add.");
  for (let row = 0; row < 3; row += 1) arrowPair(s, 166, 35 + row * 14);
  panel(s, 202, 33, 89, 44);
  label(s, 206, 36, "Ptn.");
  label(s, 206, 50, "Ln.");
  for (let row = 0; row < 2; row += 1) arrowPair(s, 253, 35 + row * 14);
  button(s, 205, 63, 41, 13, "Expd.");
  button(s, 247, 63, 41, 13, "Srnk.");
  // Memory and the time.
  panel(s, 0, 77, 291, 16);
  // Spread out as the line has room: free memory, the sound card's, the time (drawn each frame).
  const avail = label(s, 4, 80, "Avail 31744k");
  const gus = label(s, avail + 10, 80, "GUS 0000k");
  label(s, gus + 10, 80, "Time");
  // The scopes, two rows of four.
  panel(s, 0, 93, 291, 80);
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const x = 3 + (channel % 4) * 72;
    const y = 96 + Math.floor(channel / 4) * 38;
    well(s, x + 1, y + 1, 68, 34);
  }
  // The buttons.
  panel(s, 291, 0, 65, 173);
  panel(s, 356, 0, 65, 173);
  const first = ["About", "Nibbles", "Zap", "CD-Dump", "Extend", "Transps.", "I.E.Ext.", "S.E.Ext.", "Adv. Edit"];
  const second = ["Play sng.", "Play ptn.", "Stop", "Rec. sng.", "Rec. ptn.", "Disk op.", "Instr. Ed.", "Smp. Ed.", "Config", "Help"];
  first.forEach((text, index) => button(s, 294, 3 + index * 17, 59, 16, text));
  button(s, 294, 156, 29, 16, "Add");
  button(s, 324, 156, 29, 16, "Sub");
  second.forEach((text, index) => button(s, 359, 3 + index * 17, 59, 16, text));
  // Instruments, samples and the song's name.
  panel(s, 421, 0, 173, 173);
  well(s, 447, 3, 143, 89);
  well(s, 447, 96, 113, 56);
  well(s, 425, 156, 165, 15);
  button(s, 563, 95, 27, 13, "", UP);
  well(s, 564, 110, 25, 27);
  s.fill(565, 111, 23, 9, NOTES);
  button(s, 563, 139, 27, 13, "", DOWN);
  // The instruments, the first chosen, and its samples.
  for (let index = 0; index < 8; index += 1) {
    const y = 4 + index * 11;
    if (index === 0) {
      s.fill(424, y - 1, 20, 10, FACE);
      s.fill(448, y - 1, 141, 10, FACE);
    }
    s.text(ui, 426, y, hex(index + 1, 2), WHITE);
    s.text(ui, 450, y, INSTRUMENTS[index]!, WHITE);
  }
  for (let index = 0; index < 5; index += 1) {
    const y = 98 + index * 11;
    if (index === 0) {
      s.fill(424, y - 1, 20, 10, FACE);
      s.fill(448, y - 1, 111, 10, FACE);
    }
    s.text(ui, 426, y, hex(index, 2), WHITE);
    s.text(ui, 450, y, SAMPLES[index]!, WHITE);
  }
  // The instrument banks.
  panel(s, 594, 0, 46, 173);
  const banks = ["01-08", "09-10", "11-18", "19-20", "21-28", "29-30", "31-38", "39-40"];
  banks.forEach((text, index) => button(s, 597, 3 + index * 18 + (index >= 4 ? 3 : 0), 40, 16, text));
  button(s, 597, 151, 40, 21, "");
  s.text(tiny, 607, 155, "SWAP", BLACK);
  s.text(tiny, 607, 163, "BANK", BLACK);
  // The pattern editor: row numbers either side, eight channels, the play row's bar.
  panel(s, 0, 173, WIDTH, HEIGHT - 173);
  s.fill(3, 175, 634, 208, BLACK);
  for (let edge = 0; edge <= CHANNELS + 1; edge += 1) {
    const x = edge === 0 ? 0 : CHANNEL_LEFT - 3 + (edge - 1) * CHANNEL_STEP;
    if (x > WIDTH - 3) break;
    s.fill(x, 175, 1, 208, LIGHT);
    s.fill(x + 1, 175, 1, 208, PANEL);
    s.fill(x + 2, 175, 1, 208, DARK);
  }
  s.fill(WIDTH - 3, 175, 1, 208, LIGHT);
  s.fill(WIDTH - 2, 175, 2, 208, PANEL);
  s.fill(0, BAR_TOP, WIDTH, 11, PANEL);
  s.fill(0, BAR_TOP, WIDTH, 1, LIGHT);
  s.fill(0, BAR_TOP + 10, WIDTH, 1, DARK);
  s.fill(0, 383, WIDTH, 1, DARK);
  // The scrollbar under it: every channel is on screen, so its thumb fills the track.
  button(s, 3, 386, 23, 12, "", LEFT);
  s.fill(28, 386, 574, 12, BLACK);
  s.fill(29, 387, 572, 10, NOTES);
  button(s, 605, 386, 23, 12, "", RIGHT);
  return s;
}

export function createFastTracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const wave = new Float32Array(66);
  // The screen with the pattern as it stands, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  // The time follows its label as the chrome set it.
  const timeX = 4 + measure(ui, "Avail 31744k") + 10 + measure(ui, "GUS 0000k") + 10 + measure(ui, "Time") + 7;
  let screen: Surface | null = null;

  const drawFields = (s: Surface, frame: RetroFrame): void => {
    // The positions around the one playing: two above, it on the bar, two below.
    const length = song.length(frame.track.duration);
    const position = song.position;
    const line = (offset: number, y: number, color: number): void => {
      const at = position + offset;
      if (at < 0 || at >= length) return;
      s.text(notes, 8, y, hex(at, 2), color);
      s.text(notes, 33, y, hex(song.patternAt(at), 2), color);
    };
    line(-2, 4, NOTES);
    line(-1, 12, NOTES);
    s.text(notes, 9, 23, hex(position, 2), BLACK);
    s.text(notes, 34, 23, hex(song.patternAt(position), 2), BLACK);
    line(0, 22, WHITE);
    line(1, 33, NOTES);
    line(2, 41, NOTES);
    // The scroll thumb of the position list.
    s.fill(58, 17 + Math.round((Math.min(position, length - 1) / Math.max(1, length - 1)) * 14), 13, 3, NOTES);
    value(s, 74, 51, hex(length, 2));
    value(s, 74, 64, "00");
    value(s, 163, 36, String(song.bpm));
    value(s, 163, 50, "06");
    value(s, 163, 64, "01");
    value(s, 250, 36, hex(song.pattern, 2));
    value(s, 250, 50, "040");
    label(s, timeX, 80, clock(song.time, true).padStart(8, "0"));
    // The song's name under the sample list.
    const name = printable(frame.track.title, ui).replace(/\s+/g, " ").trim();
    let shown = name;
    while (shown.length && measure(ui, shown) > 158) shown = shown.slice(0, -1);
    s.text(ui, 428, 159, shown, WHITE);
  };

  /** Each channel's scope: its number, REC., and its waveform in dots. */
  const drawScopes = (s: Surface, rate: number): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const x = 4 + (channel % 4) * 72;
      const y = 97 + Math.floor(channel / 4) * 38;
      song.scope(channel, wave, scopeSeconds(song.partOf(channel)), rate);
      const middle = y + 17;
      for (let index = 0; index < wave.length; index += 1) s.pixel(x + 1 + index, middle - Math.round(wave[index]! * 13), NOTES);
      s.text(ui, x + 2, y + 1, String(channel), WHITE);
      s.text(tiny, x + 2, y + 27, "REC.", WHITE);
    }
  };

  /** One channel's cell: the note big, instrument, volume and command small, dots for empty. */
  const drawCell = (s: Surface, channel: number, row: number, y: number, playing: boolean): void => {
    song.cell(channel, row, cell);
    const x = CHANNEL_LEFT + channel * CHANNEL_STEP;
    const text = playing ? WHITE : NOTES;
    if (cell.note === NOTE_OFF) {
      s.fill(x + 4, y + 2, 21, 3, text);
    } else if (cell.note === NOTE_NONE) {
      for (let dot = 0; dot < 8; dot += 1) s.pixel(x + 7 + dot * 2, y + 3, text);
    } else {
      s.text(notes, x + 3, y, noteText(cell.note), text);
    }
    if (cell.instrument) {
      const digits = hex(cell.instrument, 2);
      s.text(small, x + 35, y, digits[1]!, text);
      if (digits[0] !== "0") s.text(small, x + 31, y, digits[0]!, text);
    }
    if (cell.volume >= 0 && cell.volume < 64 && cell.note >= 0 && cell.note !== NOTE_OFF) s.text(small, x + 43, y, hex(0x10 + cell.volume, 2), text);
    else for (let dot = 0; dot < 4; dot += 1) s.pixel(x + 43 + dot * 2, y + 3, text);
    s.text(small, x + 56, y, modEffect(cell.effect, cell.param), text);
  };

  const drawPattern = (s: Surface): void => {
    const current = song.row;
    for (let offset = -SIDE; offset <= SIDE; offset += 1) {
      const row = current + offset;
      if (row < 0 || row >= ROWS) continue;
      const playing = offset === 0;
      const y = playing ? BAR_TOP + 2 : offset < 0 ? ROW_ABOVE + (offset + SIDE) * LINE : ROW_BELOW + (offset - 1) * LINE;
      const number = hex(row, 2);
      const color = playing ? WHITE : row % 4 === 0 ? BRIGHT : NOTES;
      s.text(notes, 8, y, number, color);
      s.text(notes, 611, y, number, color);
      for (let channel = 0; channel < CHANNELS; channel += 1) drawCell(s, channel, row, y, playing);
    }
    // The edit cursor over the first channel's note on the play row.
    s.fill(CHANNEL_LEFT + 1, BAR_TOP + 1, 27, 9, BLACK);
    song.cell(0, current, cell);
    if (cell.note >= 0 && cell.note !== NOTE_OFF) s.text(notes, CHANNEL_LEFT + 3, BAR_TOP + 2, noteText(cell.note), NOTES);
    else if (cell.note === NOTE_OFF) s.fill(CHANNEL_LEFT + 4, BAR_TOP + 4, 21, 3, NOTES);
    else for (let dot = 0; dot < 8; dot += 1) s.pixel(CHANNEL_LEFT + 7 + dot * 2, BAR_TOP + 5, NOTES);
    // Each channel's number over the top row.
    for (let channel = 0; channel < CHANNELS; channel += 1) s.text(ui, CHANNEL_LEFT + 1 + channel * CHANNEL_STEP, 176, String(channel), WHITE);
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
        base.copy(chrome, 0, 175, WIDTH, 208, 0, 175);
        drawPattern(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawScopes(screen, frame.audio.rate);
      target.close(image);
    }
  };
}
