import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { english } from "../../i18n-en.ts";
import { provideDictionary, setLanguage, t } from "../../i18n.ts";
import { INTERNAL_ORDER } from "../internal-plugin.ts";
import { FABLE, fablePreset, fablePresetGroups, fablePresetId, fablePresetIds, presetMismatch } from "./catalog.ts";

provideDictionary("en", english);

// internal.ts and the visualizations import without extensions (bundler resolution), which
// plain Node cannot load, so what they must agree on with the list is checked on their source.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("the list is ten visualizations with four presets each, every id plain and unique", () => {
  assert.equal(FABLE.length, 10);
  assert.equal(new Set(FABLE.map((entry) => entry.id)).size, 10);
  for (const entry of FABLE) {
    assert.match(entry.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(!entry.id.includes("--"), `${entry.id} holds the separator`);
    assert.equal(entry.presets.length, 4, entry.id);
    assert.equal(new Set(entry.presets.map((preset) => preset.id)).size, 4, entry.id);
    for (const preset of entry.presets) assert.match(preset.id, /^[a-z][a-z0-9]+$/);
  }
});

test("preset ids are the list in order, unlike any 2D visualization's, and lead back to their preset", () => {
  const ids = fablePresetIds();
  assert.equal(ids.length, 40);
  assert.equal(new Set(ids).size, 40);
  assert.equal(ids[0], "liquid-silk--oil");
  assert.equal(ids.at(-1), "hyper-tunnel--crystal");
  for (const id of ids) assert.ok(!INTERNAL_ORDER.includes(id));
  for (const entry of FABLE) {
    for (const preset of entry.presets) {
      const found = fablePreset(fablePresetId(entry.id, preset.id));
      assert.equal(found?.entry, entry);
      assert.equal(found?.preset, preset);
    }
  }
  for (const id of ["auto", "", "snow-spectrum", "liquid-silk", "liquid-silk--", "--oil", "liquid-silk--nope", "nope--oil"]) {
    assert.equal(fablePreset(id), null, id);
  }
});

test("the headings are the visualizations in order, each with its presets under their translated names", () => {
  const groups = fablePresetGroups((text) => `<${text}>`);
  assert.deepEqual(groups.map((group) => group.label), FABLE.map((entry) => `<${entry.label}>`));
  assert.deepEqual(groups.flatMap((group) => group.presets.map((preset) => preset.id)), fablePresetIds());
  assert.deepEqual(groups[0], {
    label: "<Płynny jedwab>",
    presets: [
      { id: "liquid-silk--oil", label: "<Oliwa na wodzie>" }, { id: "liquid-silk--opal", label: "<Opal>" },
      { id: "liquid-silk--ember", label: "<Żar>" }, { id: "liquid-silk--abyss", label: "<Głębia>" }
    ]
  });
});

test("every name has its English, save the ones that are the same in both", () => {
  const same = new Set(["Opal", "Mandala", "Neon {7,3}", "Apeirogon {∞,3}"]);
  setLanguage("en");
  try {
    for (const label of FABLE.flatMap((entry) => [entry.label, ...entry.presets.map((preset) => preset.label)])) {
      if (same.has(label)) assert.equal(t(label), label);
      else assert.notEqual(t(label), label, `${label} has no English`);
    }
    assert.equal(fablePresetGroups(t)[9]?.label, "Hyperspace Tunnel");
    assert.equal(fablePresetGroups(t)[9]?.presets[1]?.label, "Stained Glass {5,4}");
  } finally {
    setLanguage("pl");
  }
  assert.equal(fablePresetGroups(t)[9]?.label, "Tunel hiperprzestrzeni");
});

test("each visualization's module says of itself what the list says of it", () => {
  const files = readdirSync(new URL("./vis/", import.meta.url)).filter((name) => name.endsWith(".ts")).sort();
  assert.equal(files.length, FABLE.length);
  files.forEach((file, index) => {
    const entry = FABLE[index]!;
    const source = read(`./vis/${file}`);
    const definition = source.slice(source.indexOf("export const definition"));
    assert.ok(definition.length > 0 && source.includes("export const definition"), file);
    assert.equal(/\bid: "([a-z0-9-]+)"/.exec(definition)?.[1], entry.id, file);
    assert.equal(Number(/\border: (\d+)/.exec(definition)?.[1]), index + 1, file);
    assert.equal(/\busesSource: (true|false)/.exec(definition)?.[1], String(entry.usesSource), file);
    assert.equal(/\bgentleByDefault: (true|false)/.exec(definition)?.[1], String(entry.gentle), file);
    assert.equal(/\blabelPl: "([^"]+)"/.exec(definition)?.[1], entry.label, file);
    const presets = [...definition.matchAll(/\{ id: "([a-z0-9]+)", labelPl: "([^"]+)"/g)].map((match) => ({ id: match[1], label: match[2] }));
    assert.deepEqual(presets, entry.presets.map((preset) => ({ id: preset.id, label: preset.label })), file);
    // And the list fetches that module for it.
    assert.ok(read("./catalog.ts").includes(`id: "${entry.id}"`) && String(entry.load).includes(file.replace(/\.ts$/, "")), file);
  });
});

test("a module that disagrees with the list is told apart", () => {
  const entry = FABLE[0]!;
  assert.deepEqual(presetMismatch(entry, { id: entry.id, presets: entry.presets.map((preset) => ({ id: preset.id, labelPl: "", labelEn: "" })) }), []);
  assert.deepEqual(presetMismatch(entry, { id: "other", presets: [{ id: "oil", labelPl: "", labelEn: "" }, { id: "new", labelPl: "", labelEn: "" }] }),
    ["id:other", "opal", "ember", "abyss", "new"]);
});

test("Internal's list and the panel's search are made by the same function, Fable headings included", () => {
  const internal = read("../internal.ts");
  const plugin = read("../internal-plugin.ts");
  assert.match(internal, /presetGroups: \(\): readonly PresetGroup\[\] => internalPresetGroups\(/);
  assert.match(plugin, /catalog: async \(\) => \(await import\("\.\/internal"\)\)\.internalPresetGroups\(\)/);
  assert.match(internal, /fable \? \[flat, \.\.\.fablePresetGroups\(t\)\] : \[flat\]/);
  // Both ask the same question about the browser, so neither offers what the other does not.
  assert.match(internal, /fable = fableSupported\(\)\): PresetGroup\[\]/);
  assert.match(internal, /const fable = fableSupported\(\) \? await import\("\.\/fable\/host"\)/);
});
