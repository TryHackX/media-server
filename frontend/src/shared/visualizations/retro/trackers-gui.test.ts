import assert from "node:assert/strict";
import test from "node:test";

import { AHX_DATA, AHX_LABEL, MPT, OM, OM_LABEL, OM_LOGO, OM_SMALL, OM_THIN, OM_WIDE, WIN } from "./trackers/fonts-gui.ts";
import { TRACKER_PRESETS } from "./trackers/presets.ts";
import { measure, sheet } from "./trackers/raster.ts";

type Definition = { sheet: string; cell: number; height: number; fixed: boolean };

const FONTS: Record<string, Definition> = { AHX_LABEL, AHX_DATA, OM, OM_WIDE, OM_LABEL, OM_LOGO, OM_THIN, OM_SMALL, WIN, MPT };

test("OctaMED, AHX and ModPlug Tracker are presets of their own, fetched on first use", () => {
  const byId = new Map(TRACKER_PRESETS.map((preset) => [preset.id, preset]));
  for (const [id, name] of [["tracker-octamed", "OctaMED Professional 4.0"], ["tracker-ahx", "AHX 2.3d"], ["tracker-modplug", "ModPlug Tracker 1.16"]] as const) {
    const preset = byId.get(id);
    assert.ok(preset, `${id} missing`);
    assert.equal(preset.name, name);
    assert.equal(preset.translate, false);
    assert.equal(typeof preset.create, "function");
  }
});

test("the GUI screens' fonts decode, every glyph inside its cell", () => {
  for (const [name, definition] of Object.entries(FONTS)) {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    assert.ok(font.glyphs.size >= 6, `${name}: ${font.glyphs.size} glyphs`);
    for (const [char, glyph] of font.glyphs) {
      assert.equal(glyph.rows.length, definition.height, `${name} "${char}": rows`);
      assert.ok(glyph.width >= 1 && glyph.width <= definition.cell, `${name} "${char}": width ${glyph.width}`);
      if (definition.fixed) assert.equal(glyph.width, definition.cell, `${name} "${char}"`);
      for (const bits of glyph.rows) assert.ok(bits >= 0 && bits < 1 << glyph.width, `${name} "${char}": a pixel outside`);
      if (char !== " " && char !== "_") assert.ok(glyph.rows.some((bits) => bits !== 0), `${name} "${char}" is empty`);
    }
  }
});

test("each GUI screen's fonts hold every character its fixed text needs", () => {
  const has = (definition: Definition, text: string): void => {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    for (const char of text) assert.ok(char === " " || font.glyphs.has(char), `"${char}" missing for "${text}"`);
  };
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // AHX: the labels, and the face of values, names and tracks.
  for (const text of ["POS", "LEN", "RES", "TRL", "SS", "SSN", "SSP", "NAME", "LOAD", "PLAY", "STOP", "INS", "STATUS:"]) has(AHX_LABEL, text);
  for (const text of [letters, "Abyss", "Dexter.", "Playing...", "Stopped.", "C#3-00", "05%", "00:44/06", "Moz(Ic)Art / GT"]) has(AHX_DATA, text);
  // OctaMED: numbers, names and the editor; the buttons' capitals; the window menu; the title strip.
  for (const text of [letters, "Mem", "NRM", "BPM", "0003/0005", "01:03", "C#2 50C30", "8080680/"]) has(OM, text);
  for (const text of ["VOL:", "HEX", "DEC", "FILTER", "E1", "E2", "E3", "STS", "CH.MODE:", "HQ", "45678", "STOP", "PLAY SONG", "CONT. SONG", "PLAY BLOCK", "D", "CONT. BLOCK", "INS", "DEL", "E", "SP", "CHRD"]) has(OM_LABEL, text);
  for (const text of ["TIMER", "FILES", "PLAY", "INSTR", "BLOCK", "EDIT", "MISC", "VOL", "MIDI", "TRANS", "RANGE", "SYNTH", "SMPED", "SLIST"]) has(OM_WIDE, text);
  has(OM_LOGO, "OctaMEDProfessional");
  has(OM_THIN, "(v4.00)");
  has(OM_SMALL, "BY TEIJO KINNUNEN");
  // ModPlug Tracker: the window's words, and the pattern's letters.
  for (const text of [letters, "Modplug Tracker - [untitled.it]", "Tempo:", "Speed:", "Octave 4", "MIDI Library", "C:\\Modplug\\Samples", "Instrument:", "Spacing:", "Follow Song", "Pattern name:", "<<", ">>", "#0", "Row 0, Col 1", "0:00:00", "06: Square Lead"]) has(WIN, text);
  has(MPT, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#-=^v");
});

test("the dialog face is proportional, and its sheet keeps the backslash a template literal could swallow", () => {
  const font = sheet(WIN.sheet, WIN.cell, WIN.height, WIN.fixed, 1);
  assert.ok(font.glyphs.has("\\"), "backslash");
  assert.ok(font.glyphs.has("("), "the glyph after it");
  assert.ok(measure(font, "i") < measure(font, "m"), "i narrower than m");
  // OctaMED's labels set I as a single upright, two pixels wide.
  const caps = sheet(OM_LABEL.sheet, OM_LABEL.cell, OM_LABEL.height, OM_LABEL.fixed, 2);
  assert.equal(caps.glyphs.get("I")?.width, 2);
  assert.equal(measure(caps, "PLAY BLOCK"), 6 + 5 + 6 + 6 + 6 + 6 + 5 + 6 + 5 + 6 + 2 * 9);
});
