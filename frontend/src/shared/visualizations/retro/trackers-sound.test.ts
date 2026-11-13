import assert from "node:assert/strict";
import test from "node:test";

import { AMIGA } from "./trackers/fonts.ts";
import { NT_LOGO, UST_CAPS, UST_HEADER, UST_LABEL_NARROW, UST_LOGO_LARGE, UST_LOGO_SMALL, UST_SMALL } from "./trackers/fonts-soundtracker.ts";
import { sheet } from "./trackers/raster.ts";
import type { Song } from "./trackers/song.ts";
import { amiga, BARS, barOf, copper, Meters, NoteBars, scrollOffset } from "./trackers/soundtracker-parts.ts";

/**
 * The SoundTracker screens (ultimatesoundtracker.ts, docsoundtracker.ts, noisetracker.ts): their
 * faces, the logo's letters, and the analyzer, meters and gradients they share
 * (soundtracker-parts.ts).
 */

const FACES = { UST_CAPS, UST_LABEL_NARROW, UST_SMALL, UST_HEADER, NT_LOGO };

test("the SoundTracker faces decode: every glyph inside its cell, fixed ones as wide as the cell", () => {
  for (const [name, definition] of Object.entries(FACES)) {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    assert.ok(font.glyphs.size >= 3, `${name}: ${font.glyphs.size} glyphs`);
    for (const [char, glyph] of font.glyphs) {
      assert.equal(glyph.rows.length, definition.height, `${name} "${char}": rows`);
      assert.ok(glyph.width >= 1 && glyph.width <= definition.cell, `${name} "${char}": width ${glyph.width}`);
      if (definition.fixed) assert.equal(glyph.width, definition.cell, `${name} "${char}"`);
      for (const bits of glyph.rows) assert.ok(bits >= 0 && bits < 1 << glyph.width, `${name} "${char}": a pixel outside`);
      if (char !== " " && char !== "_") assert.ok(glyph.rows.some((bits) => bits !== 0), `${name} "${char}" is empty`);
    }
  }
});

test("each SoundTracker screen's faces hold every character its text needs", () => {
  const has = (definition: { sheet: string; cell: number; height: number; fixed: boolean }, text: string, name: string): void => {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    for (const char of text) assert.ok(font.glyphs.has(char), `${name} lacks "${char}" for "${text}"`);
  };
  // Ultimate Soundtracker: its labels and buttons, the fields' hex, the notes and the names.
  for (const text of ["POSITION PATTERN LENGHT PRESET SOUND VOLUME REPEAT REPLEN", "SONGNAME: SAMPLENAME:", "PLAY STOP EDIT USE SAVE LOAD SONG SAMPLE", "0123456789ABCDEF", "C-#DEFGAB-_", "BASSDRUM1"]) has(UST_CAPS, text, "UST_CAPS");
  has(UST_LABEL_NARROW, "I:", "UST_LABEL_NARROW");
  has(UST_SMALL, "1987 by Karsten Obarski V1.21 PAL", "UST_SMALL");
  has(UST_HEADER, "Melody Accompany Bass Percussions", "UST_HEADER");
  // NoiseTracker's name; the D.O.C's and NoiseTracker's labels are AMIGA's.
  has(NT_LOGO, "NOISETRACKER V2.0", "NT_LOGO");
  for (const text of ["POSITION PATTERN LENGTH PRESET SAMPLE VOLUME", "PAT. PLAY USE PSET DISK OP. RECORD VOICE1: ON", "SPECTRUM ANALYZER DISK STATUS ALL RIGHT", "THE D.O.C SOUNDTRACKER V2.0 WRITTEN BY UNKNOWN OF", "POSI RESTART REPEAT REPLEN QUANT: CLR TIMER TUNE FREEMEM", "PATTREC SONGREC SAMPLER MIDI:OFF PLST-ED PRINT CLEAR"]) has(AMIGA, text, "AMIGA");
});

test("the logo's letters: black and brown on a cell of their own, every one the words need", () => {
  for (const [name, definition, word] of [["UST_LOGO_LARGE", UST_LOGO_LARGE, "SOUNDTRACKER"], ["UST_LOGO_SMALL", UST_LOGO_SMALL, "THEULTIMATE"]] as const) {
    const lines = definition.sheet.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length % (definition.height + 1), 0, `${name}: blocks of a header and ${definition.height} rows`);
    const letters = new Set<string>();
    for (let block = 0; block < lines.length; block += definition.height + 1) {
      const header = lines[block]!;
      for (let start = 0; start < header.length; start += definition.cell + 1) {
        const char = header[start]!;
        if (char === " ") continue;
        letters.add(char);
        let ink = 0;
        for (let row = 1; row <= definition.height; row += 1) {
          const cell = (lines[block + row] ?? "").slice(start, start + definition.cell);
          assert.equal(cell.length, definition.cell, `${name} "${char}" row ${row}: ${cell.length} columns`);
          assert.match(cell, /^[#o.]+$/, `${name} "${char}" row ${row}`);
          ink += cell.replace(/\./g, "").length;
        }
        assert.ok(ink > definition.height * 2, `${name} "${char}" is too faint`);
      }
    }
    for (const char of word) assert.ok(letters.has(char), `${name} lacks "${char}"`);
  }
});

test("Amiga colours and copper gradients: sixteen steps a channel, from the first stop to the last", () => {
  assert.equal(amiga(0xabc), 0xaabbcc);
  assert.equal(amiga(0x0f0), 0x00ff00);
  const ramp = copper(16, [[0, 0x000], [15, 0xf80]]);
  assert.equal(ramp.length, 16);
  assert.equal(ramp[0], 0x000000);
  assert.equal(ramp[15], 0xff8800);
  for (let row = 1; row < ramp.length; row += 1) assert.ok(((ramp[row]! >> 16) & 255) >= ((ramp[row - 1]! >> 16) & 255), "red never falls back");
  for (const colour of ramp) assert.equal(((colour >> 16) & 255) % 17, 0, "a 4-bit step");
  // Held flat between two equal stops, then on to the next.
  const held = copper(6, [[0, 0x0a0], [2, 0x0a0], [5, 0x0f0]]);
  assert.deepEqual(held.slice(0, 3), [0x00aa00, 0x00aa00, 0x00aa00]);
  assert.equal(held[5], 0x00ff00);
});

/** A song as the analyzer and the meters read it: notes struck per channel, their volumes, the sound's level. */
function fakeSong(channels: number): { song: Song; strike(channel: number, note: number, volume: number): void; levels: number[] } {
  const hits = new Array<number>(channels).fill(0);
  const notes = new Array<number>(channels).fill(-1);
  const volumes = new Array<number>(channels).fill(0);
  const levels = new Array<number>(channels).fill(0);
  const song = {
    channels,
    hits: (channel: number) => hits[channel]!,
    noteOf: (channel: number) => notes[channel]!,
    hitVolume: (channel: number) => volumes[channel]!,
    level: (channel: number) => levels[channel]!
  } as unknown as Song;
  return {
    song,
    levels,
    strike(channel, note, volume) {
      hits[channel] = hits[channel]! + 1;
      notes[channel] = note;
      volumes[channel] = volume;
    }
  };
}

test("the analyzer lifts the bar of each note struck and lets it sink; low notes left, high right", () => {
  assert.equal(barOf(12, 12, 47), 0);
  assert.equal(barOf(47, 12, 47), BARS - 1);
  assert.equal(barOf(0, 12, 47), 0, "below the range: the first bar");
  assert.equal(barOf(119, 12, 47), BARS - 1, "above it: the last");
  const { song, strike } = fakeSong(4);
  const bars = new NoteBars(4, 12, 47, 1);
  bars.update(song, 0.02);
  assert.ok(bars.levels.every((level) => level === 0), "nothing before a note");
  strike(1, 24, 0.64);
  strike(3, 47, 1);
  bars.update(song, 0.02);
  assert.ok(Math.abs(bars.levels[barOf(24, 12, 47)]! - 0.8) < 1e-6, "a note's bar rises to the root of its volume");
  assert.equal(bars.levels[BARS - 1], 1);
  // No new note: the bars sink and stay down.
  for (let frame = 0; frame < 30; frame += 1) bars.update(song, 0.02);
  assert.ok(Math.abs(bars.levels[BARS - 1]! - 0.4) < 1e-4, `falls at its rate: ${bars.levels[BARS - 1]}`);
  for (let frame = 0; frame < 100; frame += 1) bars.update(song, 0.02);
  assert.ok(bars.levels.every((level) => level === 0));
  // The same note again lifts it again; a quieter one does not pull a higher bar down.
  strike(3, 47, 1);
  bars.update(song, 0.02);
  strike(2, 47, 0.25);
  bars.update(song, 0.02);
  assert.ok(bars.levels[BARS - 1]! > 0.9);
});

test("the meters leap to a note's volume, sink, and are held up while the sound lasts", () => {
  const { song, strike, levels } = fakeSong(2);
  const meters = new Meters(2, 2);
  strike(0, 30, 0.75);
  meters.update(song, 0.02);
  assert.equal(meters.values[0], 0.75);
  assert.equal(meters.values[1], 0);
  for (let frame = 0; frame < 10; frame += 1) meters.update(song, 0.02);
  assert.ok(Math.abs(meters.values[0]! - 0.35) < 1e-4, `sinks at its rate: ${meters.values[0]}`);
  levels[0] = 0.5;
  for (let frame = 0; frame < 50; frame += 1) meters.update(song, 0.02);
  assert.ok(Math.abs(meters.values[0]! - 0.45) < 1e-6, "held at nine tenths of the sound");
});

test("a scroll text loops: in at the right edge, out at the left, then again", () => {
  assert.equal(scrollOffset(0, 40, 400, 118), 0);
  assert.equal(scrollOffset(1, 40, 400, 118), 40);
  assert.equal(scrollOffset((400 + 118) / 40, 40, 400, 118), 0, "after the whole text has passed it starts over");
  assert.ok(scrollOffset(123.4, 40, 400, 118) < 518);
});
