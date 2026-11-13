import assert from "node:assert/strict";
import test from "node:test";

import { ARKOS_MONO, ARKOS_SANS } from "./trackers/fonts-arkos.ts";
import { STK_BIG, STK_SMALL } from "./trackers/fonts-cpc.ts";
import { sheet } from "./trackers/raster.ts";

/** The Amstrad CPC screens' fonts: Soundtracker DMA's bitmaps and Arkos Tracker's strokes. */

test("Soundtracker DMA's fonts decode, every glyph in its cell, all the screen writes", () => {
  for (const [name, definition] of Object.entries({ STK_BIG, STK_SMALL })) {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    for (const [char, glyph] of font.glyphs) {
      assert.equal(glyph.rows.length, definition.height, `${name} "${char}": rows`);
      assert.equal(glyph.width, definition.cell, `${name} "${char}": a fixed cell`);
      for (const bits of glyph.rows) assert.ok(bits >= 0 && bits < 1 << glyph.width, `${name} "${char}": a pixel outside`);
      if (char !== " ") assert.ok(glyph.rows.some((bits) => bits !== 0), `${name} "${char}" is empty`);
    }
    // The small font keeps its fourth column free: the gap between letters.
    if (definition === STK_SMALL) for (const [char, glyph] of font.glyphs) for (const bits of glyph.rows) assert.equal(bits & 1, 0, `STK_SMALL "${char}" touches the next cell`);
    const needed = definition === STK_BIG
      ? "DiscopPATN-EdPLAYSONGInfosSEQCOYINSOthersCLEARSMPabout:ArpSPitchSampleInstr.Len0123456789ABCDEF#~Smp Res T"
      : "Song name:Smp/Song mem:Octave:Clipboard:Skip:0123456789ABCDEF-";
    for (const char of needed) assert.ok(font.glyphs.has(char), `${name} lacks "${char}"`);
  }
});

/** A pen path's commands and their arguments, as arkostracker.ts reads them. */
function commands(path: string): { command: string; args: number[] }[] {
  const tokens = path.match(/[MLCA]|-?\d*\.?\d+/g) ?? [];
  const out: { command: string; args: number[] }[] = [];
  for (const token of tokens) {
    if (/^[MLCA]$/.test(token)) out.push({ command: token, args: [] });
    else {
      assert.ok(out.length, `"${path}" starts with a number`);
      out.at(-1)!.args.push(Number(token));
    }
  }
  // Nothing but commands and numbers.
  assert.equal(path.replace(/[MLCA]|-?\d*\.?\d+|\s/g, ""), "", `"${path}" has stray characters`);
  return out;
}

const ARGUMENTS: Record<string, number> = { M: 2, L: 2, C: 6, A: 6 };

test("Arkos Tracker's stroke faces: well-formed paths inside their cells", () => {
  const check = (name: string, path: string, advance: number, top: number, bottom: number): void => {
    for (const { command, args } of commands(path)) {
      assert.equal(args.length, ARGUMENTS[command], `${name}: ${command} takes ${ARGUMENTS[command]} numbers`);
      if (command === "A") {
        const [cx, cy, rx, ry] = args as [number, number, number, number];
        assert.ok(rx > 0 && ry > 0, `${name}: an arc needs radii`);
        assert.ok(cx - rx >= -1.5 && cx + rx <= advance + 1.5 && cy - ry >= top && cy + ry <= bottom, `${name}: an arc leaves the cell`);
      } else {
        for (let k = 0; k < args.length; k += 2) {
          const x = args[k]!;
          const y = args[k + 1]!;
          assert.ok(x >= -1.5 && x <= advance + 1.5, `${name}: x ${x} outside 0–${advance}`);
          assert.ok(y >= top && y <= bottom, `${name}: y ${y} outside`);
        }
      }
    }
  };
  for (const [char, [advance, path]] of Object.entries(ARKOS_SANS)) {
    assert.ok(advance > 0 && advance < 13, `sans "${char}": advance ${advance}`);
    if (char !== " ") assert.ok(path.length > 0, `sans "${char}" is empty`);
    check(`sans "${char}"`, path, advance, -1, 13.5);
  }
  for (const [char, path] of Object.entries(ARKOS_MONO)) check(`mono "${char}"`, path, 9, -0.5, 12);
  // All of printable ASCII in the interface face (titles are the user's), and the pattern's letters.
  for (let code = 32; code < 127; code += 1) assert.ok(String.fromCharCode(code) in ARKOS_SANS, `sans lacks "${String.fromCharCode(code)}"`);
  for (const char of "0123456789ABCDEFGRST#-abcdefgiopsuvw") assert.ok(char in ARKOS_MONO, `mono lacks "${char}"`);
});
