import assert from "node:assert/strict";
import test from "node:test";

import { ALL_POOL as MILKDROP_ALL, BUILTIN_POOL, packPool, parsePool, poolGroups, type PackInfo } from "../milkdrop-packs.ts";
import { ALL_POOL, avsPackPresets, avsPool, avsPoolOptions, FAILED_KEY, presetId, storedFailures } from "./packs.ts";

const pack = (id: string, name: string, count: number, categories: string[] = []): PackInfo => ({
  id,
  name,
  count,
  index: "/assets/avs/index-1.json",
  categories: categories.map((category) => ({ name: category, count: 1 }))
});

const packs = [
  pack("anthology", "Anthology", 3, ["01 - Mirror Us CD1", "02 - End of Billenium CD1"]),
  pack("8-ronin", "8_ronin", 1),
  pack("tuggummi", "tuggummi", 2, ["One2Pack", "Strobotonic"]),
  pack("mscopes", "mscopes", 1)
];

const index = {
  packs: {
    anthology: {
      chunks: ["anthology/a.json", "anthology/b.json"],
      groups: [
        { category: "01 - Mirror Us CD1", group: "", folder: "01 - Mirror Us CD1", presets: [["Intro", 0]] },
        { category: "02 - End of Billenium CD1", group: "", folder: "02 - End of Billenium CD1", presets: [["Outro", 1], ["Sun", 1]] }
      ]
    },
    "8-ronin": { chunks: ["8-ronin/c.json"], groups: [{ category: "", group: "", folder: "", presets: [["Ronin", 0]] }] },
    tuggummi: {
      chunks: ["tuggummi/d.json"],
      groups: [
        { category: "One2Pack", group: "Tuggummi - strobotonic II", folder: "One2Pack/Tuggummi - strobotonic II", presets: [["Twist", 0]] },
        { category: "Strobotonic", group: "", folder: "Strobotonic", presets: [["Strobe", 0]] }
      ]
    },
    mscopes: { chunks: ["mscopes/e.json"], groups: [{ category: "", group: "", folder: "", presets: [["Spiral", 0]] }] }
  }
};

test("a preset keeps the name the single list gave it: name, then its folders after a dash", () => {
  assert.equal(presetId("Intro", "Anthology", "01 - Mirror Us CD1"), "Intro — Anthology / 01 - Mirror Us CD1");
  assert.equal(presetId("Ronin", "8_ronin", ""), "Ronin — 8_ronin");
  assert.equal(presetId("Spiral", "mscopes"), "Spiral — mscopes");
  assert.equal(presetId("Twist", "tuggummi", "One2Pack/Tuggummi - strobotonic II"), "Twist — tuggummi / One2Pack / Tuggummi - strobotonic II");
});

test("the index gives every pack's presets, keyed in their chunk and fetched beside the index", () => {
  const presets = avsPackPresets(packs, index, "/assets/avs/index-1.json");
  assert.deepEqual(presets.get("anthology")!.map((preset) => [preset.id, preset.key, preset.chunk]), [
    ["Intro — Anthology / 01 - Mirror Us CD1", "01 - Mirror Us CD1/Intro", "/assets/avs/anthology/a.json"],
    ["Outro — Anthology / 02 - End of Billenium CD1", "02 - End of Billenium CD1/Outro", "/assets/avs/anthology/b.json"],
    ["Sun — Anthology / 02 - End of Billenium CD1", "02 - End of Billenium CD1/Sun", "/assets/avs/anthology/b.json"]
  ]);
  assert.deepEqual(presets.get("8-ronin")!.map((preset) => [preset.id, preset.key]), [["Ronin — 8_ronin", "Ronin"]]);
  assert.throws(() => avsPackPresets(packs, null, "/x.json"), /unreadable/);
});

test("every pack together is where AVS starts; a pool the build lacks falls back to it", () => {
  assert.equal(ALL_POOL, MILKDROP_ALL);
  assert.equal(avsPool(null, packs), ALL_POOL);
  assert.equal(avsPool(BUILTIN_POOL, packs), ALL_POOL);
  assert.equal(avsPool("pack:gone", packs), ALL_POOL);
  assert.equal(avsPool("pack:anthology/03 - Nowhere", packs), ALL_POOL);
  for (const id of [packPool("tuggummi"), packPool("tuggummi", "One2Pack"), ALL_POOL]) {
    assert.equal(avsPool(id, packs), id);
    assert.ok(parsePool(id, packs), id);
  }
});

test("the pack choice: every pack first, single packs, then an author's packs under a heading", () => {
  const pools = avsPoolOptions(packs, {
    all: "All packs",
    allCategories: "All categories",
    pack: (entry) => entry.name,
    count: (value) => String(value)
  });
  assert.deepEqual(pools.map((pool) => [pool.id, pool.label, pool.group ?? ""]), [
    ["all", "All packs (7)", ""],
    ["pack:8-ronin", "8_ronin (1)", ""],
    ["pack:mscopes", "mscopes (1)", ""],
    ["pack:anthology", "All categories (3)", "Anthology"],
    ["pack:anthology/01 - Mirror Us CD1", "01 - Mirror Us CD1 (1)", "Anthology"],
    ["pack:anthology/02 - End of Billenium CD1", "02 - End of Billenium CD1 (1)", "Anthology"],
    ["pack:tuggummi", "All categories (2)", "tuggummi"],
    ["pack:tuggummi/One2Pack", "One2Pack (1)", "tuggummi"],
    ["pack:tuggummi/Strobotonic", "Strobotonic (1)", "tuggummi"]
  ]);
  // Every pool offered is one MilkDrop's lists understand.
  for (const pool of pools) assert.ok(parsePool(pool.id, packs), pool.id);
  assert.deepEqual(avsPoolOptions([packs[0]!], { all: "", allCategories: "", pack: () => "", count: String }), []);
});

test("an author's pool lists their packs under headings, without the author's name", () => {
  const loaded = avsPackPresets(packs, index, "/assets/avs/index-1.json");
  const labels = { builtin: "", pack: (entry: PackInfo) => entry.name };
  const groups = poolGroups(packPool("tuggummi"), [], packs, loaded, labels);
  assert.deepEqual(groups.map((group) => [group.label, group.presets.map((preset) => preset.label)]), [
    ["One2Pack · Tuggummi - strobotonic II", ["Twist"]],
    ["Strobotonic", ["Strobe"]]
  ]);
  const all = poolGroups(ALL_POOL, [], packs, loaded, labels, new Set(["Sun — Anthology / 02 - End of Billenium CD1"]));
  assert.equal(all.flatMap((group) => group.presets).length, 6);
  assert.equal(all[0]!.label, "Anthology · 01 - Mirror Us CD1");
});

test("a preset found by the search in another pack is reachable from its own pack's pool", () => {
  const loaded = avsPackPresets(packs, index, "/assets/avs/index-1.json");
  const labels = { builtin: "", pack: (entry: PackInfo) => entry.name };
  for (const presets of loaded.values()) {
    for (const preset of presets) {
      const pool = avsPool(packPool(preset.pack), packs);
      assert.notEqual(pool, ALL_POOL, preset.id);
      const ids = poolGroups(pool, [], packs, loaded, labels).flatMap((group) => group.presets.map((entry) => entry.id));
      assert.ok(ids.includes(preset.id), preset.id);
    }
  }
});

test("the presets remembered as broken are read back as ids, anything else as none", () => {
  assert.equal(FAILED_KEY, "media-visualizer-failed-avs:2");
  assert.deepEqual(storedFailures('["Sun — Anthology", 1]'), ["Sun — Anthology"]);
  assert.deepEqual(storedFailures(null), []);
  assert.deepEqual(storedFailures("]"), []);
});
