import assert from "node:assert/strict";
import test from "node:test";

import { jchColumns, likeness, type BarShape, type JchColumns } from "./trackers/eightbit.ts";
import { VGA } from "./trackers/fonts.ts";
import { C64, VGA_669 } from "./trackers/fonts-8bit.ts";
import { noteText } from "./trackers/notation.ts";
import { sheet } from "./trackers/raster.ts";
import { emptyCell, NOTE_NONE, NOTE_OFF, type Cell } from "./trackers/song.ts";

/** A bar of notes: [row, instrument, note] each. */
function bar(...notes: [number, number, number][]): BarShape {
  return new Map(notes.map(([row, instrument, note]) => [row * 32 + instrument, note]));
}

test("8-bit fonts: every glyph a full cell of 8 × 8, the C64's characters all there", () => {
  for (const [name, definition] of Object.entries({ C64, VGA_669 })) {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    for (const [char, glyph] of font.glyphs) {
      assert.equal(glyph.rows.length, 8, `${name} "${char}": rows`);
      assert.equal(glyph.width, 8, `${name} "${char}": width`);
      if (char !== " " && char !== "_") assert.ok(glyph.rows.some((bits) => bits !== 0), `${name} "${char}" is empty`);
    }
  }
  const c64 = sheet(C64.sheet, C64.cell, C64.height, C64.fixed);
  const needed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:.-+=/\"*£↑@#!?(),';<>&%$[]←_";
  for (const char of needed) assert.ok(c64.glyphs.has(char), `C64 lacks "${char}"`);
  // The screens' fixed text, and a C64 letter's strokes two pixels wide (no lone pixel in "l").
  for (const text of ["SOUNDMONITOR V1.1", "TRACK/STEP TABLE", "SP TRK1 TR ST TRK2 TR ST TRK3 TR ST AR/S", "keytranspose :↑↑↑", "sound £/clr", ".soundtranspose", "O4", "0+", "S2", "SP"]) {
    for (const char of text) assert.ok(c64.glyphs.has(char), `"${char}" missing for "${text}"`);
  }
  assert.deepEqual(c64.glyphs.get("l")!.rows, [0, 0b00111000, 0b00011000, 0b00011000, 0b00011000, 0b00011000, 0b00111100, 0]);
  // Composer 669 draws its zero seven pixels wide; the rest of its letters are VGA's.
  const zero = sheet(VGA_669.sheet, 8, 8, true).glyphs.get("0")!;
  assert.equal(zero.rows[0], 0b01111100);
  assert.notDeepEqual(zero.rows, sheet(VGA.sheet, 8, 8, true).glyphs.get("0")!.rows);
});

test("SoundMonitor: a bar heard again is the same bar, moved up or down it has a transpose", () => {
  const riff = bar([0, 5, 33], [4, 5, 33], [8, 5, 40], [12, 5, 38]);
  assert.deepEqual(likeness(riff, riff), { score: 1, transpose: 0 });
  // The same riff a fourth higher: the same rhythm on the same instrument, moved by five.
  const higher = bar([0, 5, 38], [4, 5, 38], [8, 5, 45], [12, 5, 43]);
  assert.deepEqual(likeness(higher, riff), { score: 1, transpose: 5 });
  assert.equal(likeness(riff, higher).transpose, -5);
  // A note a row late still counts, for less; another instrument's notes do not.
  const late = bar([0, 5, 33], [5, 5, 33], [8, 5, 40], [12, 5, 38]);
  assert.equal(likeness(late, riff).score, (3 + 0.75) / 4);
  assert.equal(likeness(bar([0, 6, 33], [4, 6, 33]), riff).score, 0);
  // Drums keep their notes, so a drum bar never reads as moved.
  const beat = bar([0, 1, 24], [4, 2, 40], [8, 1, 24], [12, 2, 40]);
  const busier = bar([0, 1, 24], [4, 2, 40], [8, 1, 24], [10, 1, 24], [12, 2, 40], [14, 3, 66]);
  assert.deepEqual(likeness(busier, beat), { score: 4 / 6, transpose: 0 });
  assert.equal(likeness(bar(), bar()).score, 0);
});

test("JCH: a note held with +++, the gate off a row before the next, the instrument where it changes", () => {
  const cells: Cell[] = Array.from({ length: 12 }, () => emptyCell());
  const note = (index: number, value: number, instrument: number): void => {
    cells[index]!.note = value;
    cells[index]!.instrument = instrument;
  };
  note(0, 24, 1);
  note(4, 26, 1);
  note(6, NOTE_OFF, 0);
  note(8, 36, 2);
  cells[9]!.effect = "tonePorta";
  cells[9]!.param = 0x10;
  const out: JchColumns = { instruments: new Array<string>(11).fill(""), notes: new Array<string>(11).fill("") };
  const command = (cell: Cell): string | null => (cell.effect === "tonePorta" ? "S01" : null);
  jchColumns(cells, 0, 0, 64, (cell) => cell.instrument, noteText, command, out);
  assert.deepEqual(out.notes, ["C-2", "+++", "+++", "---", "D-2", "+++", "---", "---", "C-3", "+++", "+++"]);
  assert.deepEqual(out.instruments, ["I01", "---", "---", "---", "---", "---", "---", "---", "I02", "S01", "---"]);
  // A sequence names its instrument again at its first note; rows before the screen only set the scene.
  note(0, NOTE_NONE, 0);
  note(2, 24, 1);
  note(4, 26, 1);
  const shown: JchColumns = { instruments: new Array<string>(4).fill(""), notes: new Array<string>(4).fill("") };
  jchColumns(cells, 60, 3, 64, (cell) => cell.instrument, noteText, () => null, shown);
  assert.deepEqual(shown.notes, ["---", "D-2", "+++", "---"]);
  assert.deepEqual(shown.instruments, ["---", "I01", "---", "---"]);
});
