import assert from "node:assert/strict";
import test from "node:test";

import { FC, FC_SMALL, FC_TINY, FC_TITLE, OKT, OKT_CREDIT, SM2, SM2_BIG, SM2_TINY, SM2_VALUE } from "./trackers/fonts-amiga2.ts";
import { TRACKER_PRESETS } from "./trackers/presets.ts";
import { sheet } from "./trackers/raster.ts";
import { ALIKE, likeness, shapeOf, signedHex, StepSequence, type StepRows } from "./trackers/sequence-amiga2.ts";

type Definition = { sheet: string; cell: number; height: number; fixed: boolean };

const FONTS: Record<string, Definition> = { OKT, OKT_CREDIT, FC, FC_TITLE, FC_SMALL, FC_TINY, SM2, SM2_VALUE, SM2_BIG, SM2_TINY };

/** A voice's rows: notes at the given rows (the rest none), all of one instrument. */
function rows(length: number, notes: Record<number, number>, instrument = 1): StepRows {
  const out = { notes: new Int16Array(length).fill(-1), instruments: new Uint8Array(length) };
  for (const [row, note] of Object.entries(notes)) {
    out.notes[Number(row)] = note;
    out.instruments[Number(row)] = instrument;
  }
  return out;
}

test("Oktalyzer, Future Composer and SidMon II are presets of their own, fetched on first use", () => {
  const byId = new Map(TRACKER_PRESETS.map((preset) => [preset.id, preset]));
  for (const [id, name] of [["tracker-oktalyzer", "Oktalyzer 1.57"], ["tracker-futurecomposer", "Future Composer 1.4"], ["tracker-sidmon", "SidMon II"]]) {
    const preset = byId.get(id!);
    assert.ok(preset, `${id} missing`);
    assert.equal(preset.name, name);
    assert.equal(preset.translate, false);
    assert.equal(typeof preset.create, "function");
  }
});

test("the fonts of the three Amiga screens decode, every glyph inside its cell", () => {
  for (const [name, definition] of Object.entries(FONTS)) {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    assert.ok(font.glyphs.size >= 4, `${name}: ${font.glyphs.size} glyphs`);
    for (const [char, glyph] of font.glyphs) {
      assert.equal(glyph.rows.length, definition.height, `${name} "${char}": rows`);
      assert.ok(glyph.width >= 1 && glyph.width <= definition.cell, `${name} "${char}": width ${glyph.width}`);
      if (definition.fixed) assert.equal(glyph.width, definition.cell, `${name} "${char}"`);
      for (const bits of glyph.rows) assert.ok(bits >= 0 && bits < 1 << glyph.width, `${name} "${char}": a pixel outside`);
      if (char !== " " && char !== "_") assert.ok(glyph.rows.some((bits) => bits !== 0) || (name === "OKT_CREDIT" && char === "."), `${name} "${char}" is empty`);
    }
  }
});

test("each screen's fonts hold every character its fixed text needs", () => {
  const has = (definition: Definition, text: string): void => {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    for (const char of text) assert.ok(char === " " || font.glyphs.has(char), `"${char}" missing for "${text}"`);
  };
  for (const text of ["Current Song:", "Editor:", "Current Sample: 1", "Memory:", "New Pos..: Play Song MidiMode: Off Name: Chip:", "Load Patt.: Play Patt Copy Cut Curs Len.: 046286 Clear Fast:",
    "Save Len..: Edit.:Off Replc. Mix It RStr: 000000 Song:", "Pref Ins. Del. Poly.:Off NoteUp NoDown RLen: All", "Exit Speed: 6 Quant.:01 OctaUp OcDown Vol.: 64 2 S●",
    "CLI SLen.: PLen.: 40 ChInst ChaEff Mode: B Swap ClrCB C12345678", "F-3 A#2 0123456789ABCDEF V S", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"]) has(OKT, text);
  has(OKT_CREDIT, "OKTALYZER V1.57 © 1989-93 media GmbH BY A.SANDER (SIMPLEX)");
  for (const text of ["SP", "PTTRST", "RS", "0123456789abcdef", "PLAY STOP LOAD SAVE TYPE QUIT", "Current step:", "First step", "Last step", "EDIT Patterns", "Sound ( ) #",
    "Wave/Sample #", "EDIT Sounds", "Filetype:Module", "Df0:Modules/", "DIR", "fc14.intro"]) has(FC, text);
  has(FC_TITLE, "FUTURE COMPOSER V1.4");
  for (const text of ["LENGTH IN BYTES", "REPEAT START", "REPEAT LENGTH", "INSTR."]) has(FC_SMALL, text);
  for (const text of ["CLEAR", "DF0:", "MODULES", "SOUNDS", "DF1:"]) has(FC_TINY, text);
  for (const text of ["CHANNEL 1234", "PATTERN", "NOTE-TRANS", "INST.-TRANS", "POSITION", "LENGTH", "SPEED", "SONG-TIMER :", "CHIPMEMORY:", "SONGNAME", "PATTERN EDITOR",
    "INSTRUMENT EDITOR", "SAMPLE MENU", "PLAY", "STOP", "LOAD", "SAVE", "MIDI OFF", "SLEEP", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]) has(SM2, text);
  has(SM2_VALUE, "0123456789-");
  has(SM2_BIG, "0123456789:");
  has(SM2_TINY, "BYTE");
});

test("a transpose is a signed byte in two hex digits", () => {
  assert.equal(signedHex(-7), "f9");
  assert.equal(signedHex(0), "00");
  assert.equal(signedHex(12), "0c");
  assert.equal(signedHex(255, true), "FF");
  assert.equal(signedHex(-1, true), "FF");
});

test("a voice's rows reduce to a shape: its base note, its lowest instrument, where its notes fall", () => {
  assert.equal(shapeOf(rows(32, {})), null);
  const shape = shapeOf(rows(32, { 0: 36, 4: 36, 8: 43, 12: 36 }, 3), 4)!;
  assert.equal(shape.base, 36, "the note played most");
  assert.equal(shape.sound, 3);
  assert.deepEqual([...shape.tokens].sort(), ["0:0", "1:0", "2:0", "3:0"]);
  // A note a row late falls in the same beat.
  const late = shapeOf(rows(32, { 1: 36, 4: 36, 9: 43, 12: 36 }, 3), 4)!;
  assert.equal(likeness(shape.tokens, late.tokens), 1);
  assert.ok(likeness(new Set(["0:0", "1:0"]), new Set(["2:0"])) < ALIKE);
});

test("patterns are numbered by shape: a riff that comes back is the same pattern, transposed", () => {
  const sequence = new StepSequence(2, 4);
  const first = sequence.entries([rows(32, { 0: 24, 8: 24, 16: 27 }, 5), rows(32, { 0: 36, 4: 36, 8: 36, 12: 36 }, 1)], true);
  assert.deepEqual(first.map((entry) => entry.pattern), [1, 2], "new shapes take the next numbers in turn");
  assert.deepEqual(first.map((entry) => entry.sound), [5, 1]);
  // The bass five semitones up, the drums as before.
  const again = sequence.entries([rows(32, { 0: 29, 8: 29, 16: 32 }, 5), rows(32, { 0: 36, 4: 36, 8: 36, 12: 36 }, 1)], true);
  assert.deepEqual(again.map((entry) => [entry.pattern, entry.transpose]), [[1, 5], [2, 0]]);
  // A shape the other voice played is not borrowed: the drums' rhythm on the bass is new.
  const other = sequence.entries([rows(32, { 0: 24, 4: 24, 8: 24, 12: 24 }, 5), rows(32, {}, 1)], true);
  assert.equal(other[0]!.pattern, 3);
  assert.deepEqual(other[1], { pattern: 0, transpose: 0, sound: 0 }, "a silent voice plays the empty pattern");
});

test("the step still being heard numbers its new shapes without using the numbers up", () => {
  const sequence = new StepSequence(1, 4);
  const live = sequence.entries([rows(32, { 0: 40, 16: 40 })], false);
  assert.equal(live[0]!.pattern, 1);
  const changed = sequence.entries([rows(32, { 0: 40, 4: 41, 16: 40, 28: 47 })], false);
  assert.equal(changed[0]!.pattern, 1, "still the next free number");
  const kept = sequence.entries([rows(32, { 0: 40, 4: 41, 16: 40, 28: 47 })], true);
  assert.equal(kept[0]!.pattern, 1);
  assert.equal(sequence.entries([rows(32, { 2: 40 })], false)[0]!.pattern, 2);
});

test("steps away from the one playing show what was heard, or what a song repeating itself would", () => {
  const sequence = new StepSequence(1, 4);
  const a = sequence.entries([rows(32, { 0: 30 })], true);
  sequence.keep(4, a);
  const b = sequence.entries([rows(32, { 0: 30, 16: 30, 24: 30 })], true);
  sequence.keep(5, b);
  const live = sequence.entries([rows(32, { 8: 30 })], false);
  assert.deepEqual(sequence.at(6, 6, live), live);
  assert.deepEqual(sequence.at(4, 6, live), a);
  assert.deepEqual(sequence.at(7, 6, live), b, "two steps on from the step heard last");
  assert.deepEqual(sequence.at(8, 6, live), live);
  assert.deepEqual(sequence.at(3, 6, live), b, "before the first step heard: the song repeated backwards");
  sequence.clear();
  assert.deepEqual(sequence.at(4, 6, live), live, "nothing heard: an even step away repeats the one playing");
  assert.deepEqual(sequence.at(5, 6, live), [{ pattern: 0, transpose: 0, sound: 0 }], "and an odd one is empty");
});

test("SidMon 1: its preset, its lettering, its notes", async () => {
  const preset = TRACKER_PRESETS.find((candidate) => candidate.id === "tracker-sidmon1");
  assert.ok(preset, "tracker-sidmon1 missing");
  assert.equal(preset.name, "SidMon 1.0");
  assert.equal(preset.translate, false);
  const { readSheet, SM1_LABEL, SM1_VALUE, sidmonNote } = await import("./trackers/fonts-sidmon1.ts");
  // The engraved labels: seven rows, three to five columns, two blues; every letter the plates need.
  const labels = readSheet(SM1_LABEL);
  for (const [char, glyph] of labels) {
    assert.equal(glyph.rows.length, 7, `label "${char}"`);
    assert.ok(glyph.width >= 3 && glyph.width <= 5, `label "${char}": ${glyph.width}`);
    for (const row of glyph.rows) assert.match(row, /^[#+.]+$/, `label "${char}"`);
  }
  for (const char of "BACKTOSONG-EDITPATTERNNRSTEPNOTEINSTBENDSPEEDPLAYSTOP") assert.ok(labels.has(char), `label "${char}" missing`);
  // The white figures: cells of seven, everything a step, a number or a note needs.
  const values = readSheet(SM1_VALUE);
  for (const char of "0123456789ABCDEFG-#") {
    const glyph = values.get(char);
    assert.ok(glyph, `value "${char}" missing`);
    assert.equal(glyph.width, 7);
    assert.equal(glyph.rows.length, 7);
  }
  assert.equal(sidmonNote(57), "A-4");
  assert.equal(sidmonNote(61), "C#5");
  assert.equal(sidmonNote(-1), "---");
});
