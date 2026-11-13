import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { VGA } from "./fonts";
import { clock, decimal, noteText } from "./notation";
import { printable, rgb, sheet, Surface, Target } from "./raster";
import { emptyCell, NOTE_OFF, ROWS, Song, type SongSpec } from "./song";

/**
 * Impulse Tracker 2.14 (DOS, 1995–1998) playing along: its Info Page (F5) on the 80 × 50 text
 * screen — the song's fields in black wells, the line of what is playing, then for each
 * channel a meter of yellow stripes, the sample it plays in green and a dot for its pitch, and
 * under them the pattern in its compact view, three characters a channel, the play row lit.
 *
 * The module is song.ts's, spread over channels as Impulse Tracker's were: the drums one a
 * channel, the bass, the lead on the left and on the right, a chord's three notes side by side,
 * and the lead's echo.
 */

const WIDTH = 640;
const HEIGHT = 400;
const CELL = 8;

const TAN = rgb(0xb69679);
const CREAM = rgb(0xebebcb);
const BROWN = rgb(0x7d5945);
const BLACK = rgb(0x000000);
const YELLOW = rgb(0xffff55);
const GREEN = rgb(0x459a49);
const PLAYING = rgb(0x59413c);

const font = sheet(VGA.sheet, VGA.cell, VGA.height, VGA.fixed);

const CHANNELS = 16;
const SPEC: SongSpec = {
  channels: [
    { parts: ["kick"] }, { parts: ["snare"] }, { parts: ["hats"] }, { parts: ["bass"] },
    { parts: ["lead"], side: -1 }, { parts: ["lead"], side: 1 }, { parts: ["chord"] }, { parts: ["chord"] },
    { parts: ["chord"] }, { parts: ["echo"] }, { parts: [] }, { parts: [] }, { parts: [] }, { parts: [] }, { parts: [] }, { parts: [] }
  ],
  low: 0,
  high: 119,
  drums: { kick: 60, snare: 62, hats: 66 },
  floors: { bass: 36, lead: 60, chord: 60 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 256,
  noteOff: true,
  chordVoices: true,
  seed: 214
};

const SAMPLES = ["Bassdrum", "Snare", "Closed Hihat", "Open Hihat", "Fat Bass", "Square Lead", "Strings", "Lead Echo"];

/** The info panels' rows, and the pattern view's: its first row, how many, the play row. */
const PANEL_TOP = 13;
const VIEW_TOP = 36;
const VIEW_ROWS = 13;
const VIEW_PLAY = 6;
const VIEW_CHANNELS = 24;

const at = (cell: number): number => cell * CELL;

/** A sunken well, in cells (inclusive): brown above and left, cream below and right. */
function well(s: Surface, c0: number, r0: number, c1: number, r1: number): void {
  const x0 = at(c0);
  const y0 = at(r0);
  const x1 = at(c1 + 1);
  const y1 = at(r1 + 1);
  s.fill(x0, y0, x1 - x0, y1 - y0, BLACK);
  s.fill(x0 - 2, y0 - 2, x1 - x0 + 2, 2, BROWN);
  s.fill(x0 - 2, y0 - 2, 2, y1 - y0 + 2, BROWN);
  s.fill(x0, y1, x1 - x0 + 2, 2, CREAM);
  s.fill(x1, y0 - 2, 2, y1 - y0 + 4, CREAM);
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, TAN);
  s.fill(0, 0, WIDTH, 2, CREAM);
  s.fill(0, 0, 2, HEIGHT, CREAM);
  s.fill(0, HEIGHT - 2, WIDTH, 2, BROWN);
  s.fill(WIDTH - 2, 0, 2, HEIGHT, BROWN);
  const put = (column: number, row: number, text: string, color = BLACK): void => {
    s.text(font, at(column), at(row), text, color);
  };
  put(11, 1, "Impulse Tracker v2.14 Copyright (C) 1995-1998 Jeffrey Lim");
  well(s, 12, 3, 36, 3);
  well(s, 12, 4, 29, 4);
  well(s, 12, 5, 18, 7);
  put(2, 3, "Song Name");
  put(2, 4, "File Name");
  put(6, 5, "Order");
  put(4, 6, "Pattern");
  put(8, 7, "Row");
  well(s, 50, 3, 76, 3);
  well(s, 50, 4, 56, 4);
  well(s, 50, 5, 50, 5);
  put(39, 3, "Instrument");
  put(38, 4, "Speed/Tempo");
  put(43, 5, "Octave");
  put(21, 6, "F1...Help");
  put(21, 7, "ESC..Main Menu");
  put(38, 6, "F9.....Load");
  put(38, 7, "F5/F8..Play / Stop");
  put(63, 6, "FreeMem 412k");
  put(63, 7, "FreeEMS 15872k");
  // The page's title on a dotted rule.
  for (let x = 8; x < WIDTH - 8; x += 2) if (x < at(33) || x >= at(49)) s.pixel(x, at(11) + 4, BROWN);
  put(34, 11, "Info Page (F5)");
  // The meters, the samples, the pitches.
  well(s, 5, PANEL_TOP, 28, 30);
  well(s, 31, PANEL_TOP, 61, 30);
  well(s, 64, PANEL_TOP, 72, 30);
  put(2, 32, "Active Channels:");
  put(4, 33, "Global Volume: 128");
  // The pattern view: channel headers and the rows.
  for (let channel = 0; channel < VIEW_CHANNELS; channel += 1) {
    s.fill(at(5 + channel * 3), at(35), 3 * CELL, CELL, BROWN);
    put(6 + channel * 3, 35, decimal(channel + 1, 2), channel === 0 ? BLACK : TAN);
  }
  s.fill(at(6), at(35), 2 * CELL, CELL, CREAM);
  put(6, 35, "01");
  well(s, 5, VIEW_TOP, 76, VIEW_TOP + VIEW_ROWS - 1);
  return s;
}

/** A DOS name for the track: its first words, eight letters at most, ".IT". */
function fileName(title: string): string {
  const name = printable(title.split(/\s[—–-]\s/)[0] ?? "", font).toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 8);
  return `${name || "UNTITLED"}.IT`;
}

export function createImpulseTracker(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const meters = new Float32Array(CHANNELS);
  const seen = new Float64Array(CHANNELS);
  // The screen with the pattern view as it stands, drawn again only when the song moves.
  const base = new Surface(WIDTH, HEIGHT, chrome.pixels.slice());
  let drawn = -1;
  let screen: Surface | null = null;

  const put = (s: Surface, column: number, row: number, text: string, color: number): void => {
    s.text(font, at(column), at(row), text, color);
  };

  const drawFields = (s: Surface, frame: RetroFrame): void => {
    const length = song.length(frame.track.duration);
    const title = printable(frame.track.title, font).replace(/\s+/g, " ").trim();
    put(s, 12, 3, title.slice(0, 25), YELLOW);
    put(s, 12, 4, fileName(frame.track.title), YELLOW);
    put(s, 12, 5, `${decimal(song.position, 3)}/${decimal(length, 3)}`, YELLOW);
    put(s, 12, 6, `${decimal(song.pattern, 3)}/${decimal(song.patternAt(length - 1) + 1, 3)}`, YELLOW);
    put(s, 12, 7, `${decimal(song.row, 3)}/063`, YELLOW);
    s.text(font, at(15), at(5), "/", BROWN);
    s.text(font, at(15), at(6), "/", BROWN);
    s.text(font, at(15), at(7), "/", BROWN);
    put(s, 50, 3, `01 ${SAMPLES[0]}`, YELLOW);
    put(s, 50, 4, `006/${decimal(song.bpm, 3)}`, YELLOW);
    s.text(font, at(53), at(4), "/", BROWN);
    put(s, 50, 5, "4", YELLOW);
    // What is playing: the line with its numbers in cream.
    let x = 2;
    const say = (text: string, color = BLACK): void => {
      put(s, x, 9, text, color);
      x += text.length;
    };
    say(song.playing ? "Playing, Order: " : "Stopped, Order: ");
    say(String(song.position), CREAM);
    say("/");
    say(String(length), CREAM);
    say(", Pattern: ");
    say(String(song.pattern), CREAM);
    say(", Row: ");
    say(String(song.row), CREAM);
    say("/");
    say("64", CREAM);
    say(", ");
    say(String(CHANNELS), CREAM);
    say(" Channels");
    put(s, 63, 9, "Time", BLACK);
    put(s, 68, 9, clock(song.time, true), CREAM);
    let active = 0;
    for (let channel = 0; channel < CHANNELS; channel += 1) if (meters[channel]! > 0.04) active += 1;
    put(s, 19, 32, `${active} (${active + 3})`, BLACK);
  };

  /** Each channel's meter in yellow stripes, its sample in green, a dot for its pitch. */
  const drawChannels = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const row = PANEL_TOP + channel;
      put(s, 2, row, decimal(channel + 1, 2), channel === 0 ? CREAM : BROWN);
      const hits = song.hits(channel);
      let value = meters[channel]! - dt * 2.2;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        value = Math.max(value, song.hitVolume(channel));
      }
      value = Math.max(value, song.level(channel));
      meters[channel] = Math.max(0, Math.min(1, value));
      const stripes = Math.round(meters[channel]! * 63);
      for (let stripe = 0; stripe < stripes; stripe += 1) s.fill(at(5) + stripe * 3, at(row) + 1, 2, 7, YELLOW);
      if (meters[channel]! < 0.02 || song.partOf(channel) === null) continue;
      const instrument = song.instrumentOf(channel);
      const name = SAMPLES[instrument - 1] ?? "";
      put(s, 31, row, `${decimal(instrument, 2)}/${decimal(instrument, 2)}:${name}`, GREEN);
      const note = song.noteOf(channel);
      if (note >= 0 && note < 120) {
        const position = Math.round(((note - 24) / 84) * 66);
        s.fill(at(64) + Math.max(0, Math.min(66, position)), at(row) + 1, 6, 6, BROWN);
      }
    }
  };

  /** The compact pattern view: each channel's notes, three dots where it is silent. */
  const drawView = (s: Surface): void => {
    const current = song.row;
    for (let line = 0; line < VIEW_ROWS; line += 1) {
      const row = current - VIEW_PLAY + line;
      const y = VIEW_TOP + line;
      if (row < 0 || row >= ROWS) continue;
      if (line === VIEW_PLAY) s.fill(at(5), at(y), at(72), CELL, PLAYING);
      put(s, 1, y, decimal(row, 3), BLACK);
      for (let channel = 0; channel < VIEW_CHANNELS; channel += 1) {
        const column = 5 + channel * 3;
        if (channel < CHANNELS) song.cell(channel, row, cell);
        else cell.note = -1;
        const text = cell.note === NOTE_OFF ? "═══" : cell.note >= 0 ? noteText(cell.note) : "···";
        put(s, column, y, text, GREEN);
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
        base.copy(chrome, 0, at(VIEW_TOP), WIDTH, VIEW_ROWS * CELL, 0, at(VIEW_TOP));
        drawView(base);
      }
      pixels.set(base.pixels);
      drawFields(screen, frame);
      drawChannels(screen, frame.dt);
      target.close(image);
    }
  };
}
