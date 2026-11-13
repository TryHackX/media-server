import assert from "node:assert/strict";
import test from "node:test";

import { BROKEN_PRESETS, milkdropVisualizers, packLabel, playablePresets, presetDeck } from "./milkdrop.ts";

test("auto mode deals every preset once before any comes back", () => {
  const names = Array.from({ length: 30 }, (_, index) => `preset ${index}`);
  let seed = 3;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const draw = presetDeck(names, random);
  const first = Array.from({ length: names.length }, draw);
  assert.equal(new Set(first).size, names.length);
  const second = Array.from({ length: names.length }, draw);
  assert.equal(new Set(second).size, names.length);
  // The seam between two decks never repeats the preset just shown.
  assert.notEqual(second[0], first.at(-1));
});

test("a single preset is simply shown again", () => {
  const draw = presetDeck(["only"]);
  assert.deepEqual([draw(), draw(), draw()], ["only", "only", "only"]);
});

test("MilkDrop and Geiss are WebGL visualizers the engine mounts", () => {
  assert.deepEqual(milkdropVisualizers.map((plugin) => plugin.id), ["milkdrop", "geiss"]);
  assert.ok(milkdropVisualizers.every((plugin) => typeof plugin.external === "function"));
});

test("presets that failed on this browser are not offered; none fails everywhere any more", () => {
  const names = ["Geiss - Game of Life 3", "Geiss - Eggs", "Geiss - Spiral Artifact", "Zylot - Shiny"];
  // Game of Life 3 was black until the simple waveform's dots were drawn (basic-wave-dots patch);
  // astral projection threw from WebAssembly until eel-wasm was patched.
  assert.equal(BROKEN_PRESETS.size, 0);
  assert.deepEqual(playablePresets(names, () => true), ["Geiss - Eggs", "Geiss - Game of Life 3", "Geiss - Spiral Artifact", "Zylot - Shiny"]);
  // What failed on this browser is left out.
  assert.deepEqual(playablePresets(names, () => true, new Set(["Zylot - Shiny"])), ["Geiss - Eggs", "Geiss - Game of Life 3", "Geiss - Spiral Artifact"]);
  assert.deepEqual(playablePresets(names, (name) => name.toLowerCase().startsWith("geiss"), new Set(["Geiss - Eggs"])), ["Geiss - Game of Life 3", "Geiss - Spiral Artifact"]);
});

test("the packs the interface knows get readable names; any other keeps its folder's", () => {
  const t = (text: string): string => `«${text}»`;
  const label = (id: string): string => packLabel({ id, name: id }, t);
  assert.equal(label("cream-of-the-crop"), "«projectM — Cream of the Crop»");
  assert.equal(label("presets-milkdrop-original"), "«Oryginalny MilkDrop 2 (klasyka)»");
  assert.equal(label("projectm-classic"), "«projectM — klasyczne presety»");
  assert.equal(label("presets-projectm-classic"), "«projectM — klasyczne presety»");
  assert.equal(label("en-d"), "projectM — En D");
  assert.equal(label("presets-en-d"), "projectM — En D");
  assert.equal(label("beatdrop"), "BeatDrop");
  assert.equal(label("moje"), "moje");
});
