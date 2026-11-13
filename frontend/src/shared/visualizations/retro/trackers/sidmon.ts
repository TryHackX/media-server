import type { PixelImage, RetroFrame, RetroScene } from "../types";
import { SM2, SM2_BIG, SM2_TINY, SM2_VALUE } from "./fonts-amiga2";
import { decimal } from "./notation";
import { type Font, measure, printable, rgb, sheet, Surface, Target } from "./raster";
import { type StepEntry, StepSequence } from "./sequence-amiga2";
import { emptyCell, ROWS, Song, type SongSpec } from "./song";

/**
 * SidMon II, "the MIDI version" (Amiga, Michael Kleps for Turtle Byte, 1990), playing along: its
 * 320 × 256 song screen of blue-grey metal plates — a plate for each of the four channels with
 * its pattern, note transpose and instrument transpose, the song's position, length and speed,
 * the song timer and the chip memory, the four level meters, the song's name, and the buttons
 * of its editors, menus and the player.
 *
 * SidMon II's patterns hold one voice each, and every song position names, for each channel, a
 * pattern and its two transposes. The module here is song.ts's (drums on the first channel, the
 * bass on the second, the lead on the third, hi-hats and chords on the fourth), a position a
 * 64-row pattern; sequence-amiga2.ts numbers each channel's rows as patterns by their shape.
 * Everything is drawn from this project's own fonts (fonts-amiga2.ts) and these coordinates,
 * after screenshots of the program.
 */

const WIDTH = 320;
const HEIGHT = 256;

/** The program's eight colours: black and a ramp of blue-greys from shadow to highlight. */
const BLACK = rgb(0x000000);
const K = rgb(0x103050);
const D = rgb(0x204060);
const d = rgb(0x305070);
const B = rgb(0x406080);
const M = rgb(0x507090);
const L = rgb(0x80a0c0);
const W = rgb(0xb0d0f0);

const label = sheet(SM2.sheet, SM2.cell, SM2.height, SM2.fixed);
const value = sheet(SM2_VALUE.sheet, SM2_VALUE.cell, SM2_VALUE.height, SM2_VALUE.fixed);
const big = sheet(SM2_BIG.sheet, SM2_BIG.cell, SM2_BIG.height, SM2_BIG.fixed);
const tiny = sheet(SM2_TINY.sheet, SM2_TINY.cell, SM2_TINY.height, SM2_TINY.fixed);

const CHANNELS = 4;
const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  low: 12,
  high: 71,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 24, lead: 48, chord: 48 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 128,
  seed: 90
};

/** The four channels' plates: their left edges, and the tops of their three value rows. */
const CHANNEL_X = [17, 89, 161, 233];
const CHANNEL_ROWS = [38, 58, 78];
const CHANNEL_LABELS = [[32, "PATTERN"], [52, "NOTE-TRANS"], [72, "INST.-TRANS"]] as const;
/** The song plate's rows, the timer plate, the meters' slots. */
const SONG_ROWS = [109, 122, 135];
const SLOTS = [250, 261, 272, 283];
const SLOT_TOP = 112;
const SLOT_HEIGHT = 31;

/**
 * A plate: a rim two pixels wide (light above and left, dark below and right) round a dish whose
 * upper and left sides fall into shadow and whose lower and right sides catch the light. `cut`
 * chamfers the upper corners (left, right) by so many pixels.
 */
function plate(s: Surface, x0: number, y0: number, x1: number, y1: number, cutLeft = 0, cutRight = 0): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dl = x - x0;
      const dt = y - y0;
      const dr = x1 - x;
      const db = y1 - y;
      const u = dl + dt - cutLeft;
      const v = dr + dt - cutRight;
      if ((cutLeft && u < 0) || (cutRight && v < 0)) continue;
      let colour: number;
      if (cutLeft && dt < cutLeft && u <= 2 && (dt > 0 || u === 0)) colour = W;
      else if (cutRight && dt < cutRight && v <= 2 && (dt > 0 || v === 0)) colour = L;
      else if (dt === 0) colour = dl === 0 ? W : dr === 0 ? B : L;
      else if (dt === 1 && dl === 1 && !cutLeft) colour = W;
      else if (dt === 1 && dr <= 1) colour = dr === 1 ? B : K;
      else if (db === 0) colour = dl === 0 ? B : K;
      else if (db === 1) colour = dl === 0 ? L : dl === 1 ? B : K;
      else if (dl < 2) colour = L;
      else if (dr < 2) colour = K;
      else colour = dish(dl - 2, Math.min(dt - 2, cutLeft ? u - 3 : 99, cutRight ? v - 3 : 99), dr - 2, db - 2, cutLeft > 0 || cutRight > 0);
      s.pixel(x, y, colour);
    }
  }
}

/** The dish inside a plate's rim, by the distance from its left, top, right and bottom edges. */
function dish(ix: number, iy: number, ex: number, ey: number, chamfered: boolean): number {
  if (ey === 0) return ix === 0 ? B : ex === 0 ? W : L;
  if (iy === 0) return ex === 0 ? B : !chamfered && ix < 8 ? K : D;
  if (ix === 0) return iy < 9 ? K : D;
  if (ex === 0) return L;
  if (iy === 1) return ix <= 4 ? D : ex === 1 ? B : d;
  if (iy === 2) return ix <= 2 ? D : ex === 2 ? B : ex === 1 ? M : d;
  if (ey === 1) return ix === 1 ? B : M;
  if (ey === 2) return ix === 1 ? d : ix <= 3 ? B : M;
  if (ey === 3) return ix === 1 ? d : ix <= 4 ? B : ix <= 6 || ex <= 6 ? M : B;
  if (ey === 4) return ix <= 2 ? d : ex <= 4 ? M : B;
  if (iy <= 4) return ix === 1 ? D : ix <= 6 - iy + 3 ? d : ex <= 2 ? M : B;
  const band = iy <= 8 || ey <= 6 ? 3 : 2;
  return ix <= band ? d : ex <= band ? M : B;
}

/** A small button: a rim one pixel wide, a shallow dish, its label in the middle. */
function key(s: Surface, x0: number, y0: number, x1: number, y1: number, text: string): void {
  s.fill(x0, y0, x1 - x0 + 1, y1 - y0 + 1, B);
  s.fill(x0, y0, x1 - x0, 1, L);
  s.pixel(x0, y0, W);
  s.pixel(x1, y0, B);
  s.fill(x0, y0 + 1, 1, y1 - y0 - 1, L);
  s.fill(x1, y0 + 1, 1, y1 - y0, K);
  s.fill(x0 + 1, y0 + 1, x1 - x0 - 2, 1, D);
  s.fill(x0 + 1, y0 + 2, 1, y1 - y0 - 3, d);
  s.fill(x1 - 1, y0 + 2, 1, y1 - y0 - 3, L);
  s.fill(x0 + 1, y1 - 1, x1 - x0 - 1, 1, L);
  s.pixel(x0 + 1, y1 - 1, M);
  s.fill(x0, y1, x1 - x0 + 1, 1, K);
  s.pixel(x0, y1, B);
  centred(s, label, x0, x1, y0 + Math.floor((y1 - y0 - 4) / 2), text);
}

/** Lettering with its shadow, centred between two columns. */
function centred(s: Surface, face: Font, x0: number, x1: number, y: number, text: string): void {
  s.embossed(face, x0 + Math.round((x1 - x0 + 1 - measure(face, text)) / 2), y, text, W, K);
}

/**
 * A value row of a plate (the tip of its buttons at `top`): the minus button, the black box,
 * the plus button, and the three grooves that run from the plate's edges to them.
 */
function valueRow(s: Surface, plateLeft: number, plateRight: number, top: number, minus: number, box: number, plus: number): void {
  for (const groove of [top + 4, top + 6, top + 8]) {
    s.fill(plateLeft, groove, 2, 1, W);
    s.pixel(plateLeft + 2, groove, d);
    s.fill(plateLeft + 5, groove, minus - plateLeft - 4, 1, M);
    s.pixel(minus + 10, groove, d);
    s.fill(minus + 11, groove, box - minus - 11, 1, M);
    s.fill(box + 27, groove, plus - box - 26, 1, M);
    s.pixel(plus + 10, groove, d);
    s.fill(plus + 11, groove, plateRight - plus - 15, 1, M);
    s.fill(plateRight - 4, groove, 2, 1, L);
    s.pixel(plateRight - 2, groove, W);
    s.fill(plateRight - 1, groove, 2, 1, D);
  }
  for (const [x, plusSign] of [[minus, false], [plus, true]] as const) {
    // The button: a tip of light at its corner, its face, its shadow below and right.
    s.pixel(x + 1, top, M);
    s.pixel(x, top + 1, M);
    s.pixel(x + 1, top + 1, L);
    s.pixel(x + 2, top + 1, M);
    s.fill(x, top + 2, 9, 1, L);
    s.pixel(x + 1, top + 2, W);
    s.fill(x + 2, top + 3, 7, 6, B);
    s.fill(x + 1, top + 3, 1, 7, L);
    s.fill(x + 2, top + 3, 1, 6, d);
    s.fill(x + 3, top + 3, 5, 1, d);
    s.pixel(x + 2, top + 3, D);
    s.fill(x + 8, top + 4, 1, 5, M);
    s.fill(x + 3, top + 9, 5, 1, M);
    s.pixel(x + 8, top + 9, L);
    s.fill(x + 9, top + 3, 1, 7, K);
    s.fill(x + 2, top + 10, 8, 1, K);
    s.fill(x + 3, top + 11, 8, 1, D);
    s.fill(x + 10, top + 5, 1, 6, D);
    s.fill(x + 3, top + 6, 5, 1, L);
    if (plusSign) s.fill(x + 5, top + 4, 1, 5, L);
  }
  // The box: shadowed above and left, lit below and right, black inside.
  s.fill(box, top + 1, 26, 1, D);
  s.pixel(box, top + 1, K);
  s.fill(box, top + 2, 1, 9, D);
  s.fill(box + 1, top + 2, 25, 9, BLACK);
  s.fill(box + 26, top + 2, 1, 9, L);
  s.fill(box + 1, top + 11, 25, 1, L);
  s.pixel(box + 26, top + 11, W);
  for (const groove of [top + 4, top + 6, top + 8]) {
    s.pixel(box, groove, B);
    s.pixel(box + 26, groove, W);
  }
}

/** A sunken slot of the level meters. */
function slot(s: Surface, x: number): void {
  s.fill(x, SLOT_TOP - 1, 1, 1, K);
  s.fill(x + 1, SLOT_TOP - 1, 6, 1, D);
  s.fill(x, SLOT_TOP, 1, SLOT_HEIGHT, D);
  s.fill(x + 7, SLOT_TOP, 1, SLOT_HEIGHT, L);
  s.fill(x + 1, SLOT_TOP + SLOT_HEIGHT, 6, 1, L);
  s.pixel(x + 7, SLOT_TOP + SLOT_HEIGHT, W);
}

function drawChrome(): Surface {
  const s = new Surface(WIDTH, HEIGHT);
  s.fill(0, 0, WIDTH, HEIGHT, BLACK);
  // The channels: a tab with the channel's name over a plate of its three values.
  CHANNEL_X.forEach((x, index) => {
    plate(s, x, 2, x + 69, 24, 7, 7);
    centred(s, label, x, x + 69, 10, `CHANNEL ${index + 1}`);
    plate(s, x, 27, x + 69, 99);
    for (const [y, text] of CHANNEL_LABELS) centred(s, label, x, x + 69, y, text);
    for (const top of CHANNEL_ROWS) valueRow(s, x, x + 69, top, x + 8, x + 22, x + 52);
    // The rivets that hold the tab to its plate.
    s.pixel(x, 25, K);
    s.pixel(x, 26, d);
    s.pixel(x - 2, 27, K);
    s.pixel(x - 1, 27, d);
  });
  for (const x of [139, 238]) {
    s.pixel(x, 100, K);
    s.pixel(x, 101, d);
    s.pixel(x - 2, 102, K);
    s.pixel(x - 1, 102, d);
  }
  for (const x of [17, 70, 142, 188, 223, 258]) {
    s.pixel(x, 169, x === 70 ? K : d);
    s.pixel(x - 2, 170, K);
    s.pixel(x - 1, 170, d);
  }
  // The song: position, length and speed.
  plate(s, 17, 102, 136, 154, 7, 0);
  for (const top of SONG_ROWS) valueRow(s, 17, 136, top, 73, 87, 117);
  for (const [index, text] of ["POSITION", "LENGTH", "SPEED"].entries()) s.embossed(label, 29, SONG_ROWS[index]! + 4, text, W, K);
  // The timer and the chip memory.
  plate(s, 139, 102, 235, 153);
  s.embossed(label, 155, 112, "SONG-TIMER :", W, K);
  s.embossed(label, 157, 131, "CHIPMEMORY:", W, K);
  s.embossed(tiny, 210, 139, "BYTE", W, K);
  // The level meters.
  plate(s, 238, 102, 302, 153);
  for (const x of SLOTS) slot(s, x);
  // The song's name: its label on a plate, the name in a black field.
  plate(s, 17, 156, 302, 168);
  s.fill(79, 157, 218, 1, D);
  s.fill(79, 158, 1, 9, D);
  s.fill(80, 158, 217, 9, BLACK);
  s.fill(297, 158, 1, 9, L);
  s.fill(78, 158, 1, 9, L);
  s.fill(77, 159, 1, 7, M);
  s.fill(19, 167, 278, 1, L);
  s.pixel(297, 167, W);
  s.embossed(label, 24, 160, "SONGNAME", W, K);
  // The editors, the sample menu and the player's buttons.
  for (const [x0, x1, top, bottom] of [[17, 67, "PATTERN", "EDITOR"], [70, 139, "INSTRUMENT", "EDITOR"], [142, 185, "SAMPLE", "MENU"]] as const) {
    plate(s, x0, 170, x1, 194);
    centred(s, label, x0, x1, 176, top);
    centred(s, label, x0, x1, 183, bottom);
  }
  for (const [x0, x1, top, bottom] of [[188, 220, "PLAY", "STOP"], [223, 255, "LOAD", "SAVE"], [258, 302, "MIDI OFF", "SLEEP"]] as const) {
    key(s, x0, 170, x1, 180, top);
    key(s, x0, 184, x1, 194, bottom);
  }
  return s;
}

export function createSidMon(): RetroScene {
  const chrome = drawChrome();
  const song = new Song(SPEC);
  const target = new Target();
  const cell = emptyCell();
  const sequence = new StepSequence(CHANNELS, 8);
  const rows = Array.from({ length: CHANNELS }, () => ({ notes: new Int16Array(ROWS), instruments: new Uint8Array(ROWS) }));
  let live: StepEntry[] = [];
  let position = -1;
  let titleSeen: string | null = null;
  const meters = new Float32Array(CHANNELS);
  const seen = new Float64Array(CHANNELS);
  let drawn = -1;
  let screen: Surface | null = null;

  /** The position playing moves on: the one left is kept as heard, the new one is read. */
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
      const { notes, instruments } = rows[channel]!;
      for (let row = 0; row < ROWS; row += 1) {
        song.cell(channel, row, cell);
        const pitched = cell.note >= 0 && cell.note <= 119;
        notes[row] = pitched ? cell.note : -1;
        instruments[row] = pitched ? cell.instrument : 0;
      }
    }
    live = sequence.entries(rows, false);
  };

  /** A figure right-aligned in a value box. */
  const figure = (s: Surface, box: number, top: number, n: number): void => {
    const text = String(Math.round(n));
    s.text(value, box + 24 - text.length * 6, top + 3, text, W);
  };

  const drawValues = (s: Surface, frame: RetroFrame): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const entry = live[channel];
      const x = CHANNEL_X[channel]! + 22;
      figure(s, x, CHANNEL_ROWS[0]!, entry?.pattern ?? 0);
      figure(s, x, CHANNEL_ROWS[1]!, entry?.transpose ?? 0);
      figure(s, x, CHANNEL_ROWS[2]!, Math.max(0, (entry?.sound ?? 1) - 1));
    }
    figure(s, 87, SONG_ROWS[0]!, song.position);
    figure(s, 87, SONG_ROWS[1]!, song.length(frame.track.duration));
    figure(s, 87, SONG_ROWS[2]!, 6);
    // The song timer and the chip memory left (less as the song's patterns grow).
    const seconds = Math.floor(song.time);
    const timer = `${decimal(Math.floor(seconds / 3600), 2)}:${decimal(Math.floor(seconds / 60) % 60, 2)}:${decimal(seconds % 60, 2)}`;
    s.embossed(big, 152, 119, timer, W, K);
    const patterns = song.patternAt(song.length(frame.track.duration) - 1) + 1;
    s.embossed(big, 152, 139, decimal(1_753_448 - patterns * CHANNELS * 256, 7), W, K);
    // The song's name in its field.
    const name = printable(frame.track.title, label, true).replace(/\s+/g, " ").trim();
    let shown = name;
    while (shown.length && measure(label, shown) > 208) shown = shown.slice(0, -1);
    s.embossed(label, 84, 160, shown, W, K);
  };

  /** The meters leap with each note and fall back, a bar of light in each slot. */
  const drawMeters = (s: Surface, dt: number): void => {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const hits = song.hits(channel);
      let level = meters[channel]! - dt * 1.6;
      if (hits !== seen[channel]) {
        seen[channel] = hits;
        level = Math.max(level, song.hitVolume(channel));
      }
      level = Math.max(level, song.level(channel) * 0.85);
      meters[channel] = Math.max(0, Math.min(1, level));
      const height = Math.round(meters[channel]! * SLOT_HEIGHT);
      if (height <= 0) continue;
      const x = SLOTS[channel]! + 1;
      const y = SLOT_TOP + SLOT_HEIGHT - height;
      s.fill(x, y, 6, height, L);
      s.fill(x, y, 1, height, W);
      s.fill(x + 5, y, 1, height, M);
      s.fill(x, y, 6, 1, W);
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
      drawValues(screen, frame);
      drawMeters(screen, frame.dt);
      target.close(image);
    }
  };
}
