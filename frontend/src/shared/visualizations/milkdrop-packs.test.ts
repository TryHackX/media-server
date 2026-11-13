import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  ALL_POOL,
  BUILTIN_POOL,
  builtinPresetNames,
  chunkLoader,
  hydratePreset,
  isDoublePreset,
  packPool,
  packPresets,
  parsePool,
  poolGroups,
  poolOptions,
  poolPacks,
  presetPool,
  type PackInfo,
  type PackPreset
} from "./milkdrop-packs.ts";

const cream: PackInfo = {
  id: "cream-of-the-crop",
  name: "cream-of-the-crop",
  count: 3,
  index: "/assets/milkdrop/cream-of-the-crop/index-abc.json",
  categories: [{ name: "Dancer", count: 2 }, { name: "Fractal", count: 1 }]
};
const original: PackInfo = {
  id: "milkdrop-original",
  name: "milkdrop-original",
  count: 2,
  index: "/assets/milkdrop/milkdrop-original/index-def.json",
  categories: []
};
const labels = {
  builtin: "Built-in",
  all: "All packs",
  allCategories: "All categories",
  pack: (pack: PackInfo) => (pack.id === "cream-of-the-crop" ? "Cream" : "Original"),
  count: (value: number) => String(value)
};

const creamIndex = {
  chunks: ["c1.json", "c2.json"],
  groups: [
    { category: "Dancer", group: "Aurora", folder: "Dancer/Aurora", presets: [["Geiss - Cauldron", 0], ["Royal - Mashup", 0]] },
    { category: "Fractal", group: "", folder: "Fractal", presets: [["Mandelbox", 1]] }
  ]
};
const originalIndex = { chunks: ["o1.json"], groups: [{ category: "", group: "", folder: "", presets: [["Geiss - Cauldron", 0], ["Rovastar - Fractopia", 0]] }] };

function loadedPacks(): Map<string, PackPreset[]> {
  return new Map([[cream.id, packPresets(cream, creamIndex)], [original.id, packPresets(original, originalIndex)]]);
}

test("no packs in the build, no pack choice: the toolbar stays as it was", () => {
  assert.deepEqual(poolOptions([], 500, labels), []);
  assert.equal(parsePool(ALL_POOL, []), null);
});

test("butterchurn's presets come first, then everything, then each pack — headed ones last", () => {
  const pools = poolOptions([cream, original], 500, labels);
  assert.deepEqual(pools.map((pool) => [pool.id, pool.label, pool.group ?? ""]), [
    [BUILTIN_POOL, "Built-in (500)", ""],
    [ALL_POOL, "All packs (505)", ""],
    // A pack without categories is a single choice…
    [packPool("milkdrop-original"), "Original (2)", ""],
    // …and one with them a heading, after which no plain choice follows.
    [packPool("cream-of-the-crop"), "All categories (3)", "Cream"],
    [packPool("cream-of-the-crop", "Dancer"), "Dancer (2)", "Cream"],
    [packPool("cream-of-the-crop", "Fractal"), "Fractal (1)", "Cream"]
  ]);
});

test("a pool id names what it needs, and nothing that is not in the build", () => {
  const packs = [cream, original];
  assert.deepEqual(parsePool("pack:cream-of-the-crop/Dancer", packs), { kind: "pack", pack: "cream-of-the-crop", category: "Dancer" });
  assert.equal(parsePool("pack:cream-of-the-crop/Nowhere", packs), null);
  assert.equal(parsePool("pack:gone", packs), null);
  assert.deepEqual(poolPacks(BUILTIN_POOL, packs), []);
  assert.deepEqual(poolPacks("pack:cream-of-the-crop/Dancer", packs), ["cream-of-the-crop"]);
  assert.deepEqual(poolPacks(ALL_POOL, packs), ["cream-of-the-crop", "milkdrop-original"]);
});

test("a pack's presets get ids of their own, beside butterchurn's names, and chunks next to the index", () => {
  const presets = packPresets(cream, creamIndex);
  assert.deepEqual(presets[0], {
    id: "cream-of-the-crop:Dancer/Aurora/Geiss - Cauldron",
    name: "Geiss - Cauldron",
    pack: "cream-of-the-crop",
    category: "Dancer",
    group: "Aurora",
    key: "Dancer/Aurora/Geiss - Cauldron", // gitleaks:allow - a preset's path, not a key
    chunk: "/assets/milkdrop/cream-of-the-crop/c1.json"
  });
  assert.equal(packPresets(original, originalIndex)[0]!.id, "milkdrop-original:Geiss - Cauldron");
  assert.throws(() => packPresets(cream, "<!doctype html>"), /unreadable/);
});

test("butterchurn's list stays one plain list, exactly as before the packs", () => {
  const builtin = ["Geiss - Cauldron", "Zylot - Shiny"];
  const groups = poolGroups(BUILTIN_POOL, builtin, [cream, original], loadedPacks(), labels);
  assert.deepEqual(groups, [{ label: "", presets: [{ id: "Geiss - Cauldron", label: "Geiss - Cauldron" }, { id: "Zylot - Shiny", label: "Zylot - Shiny" }] }]);
});

test("a pack's list is headed by as much of category and group as the pool does not say", () => {
  const packs = [cream, original];
  const headings = (id: string) => poolGroups(id, ["Zylot - Shiny"], packs, loadedPacks(), labels).map((group) => [group.label, group.presets.map((preset) => preset.label)]);
  assert.deepEqual(headings(packPool("cream-of-the-crop")), [["Dancer · Aurora", ["Geiss - Cauldron", "Royal - Mashup"]], ["Fractal", ["Mandelbox"]]]);
  assert.deepEqual(headings(packPool("cream-of-the-crop", "Dancer")), [["Aurora", ["Geiss - Cauldron", "Royal - Mashup"]]]);
  assert.deepEqual(headings(packPool("milkdrop-original")), [["", ["Geiss - Cauldron", "Rovastar - Fractopia"]]]);
  assert.deepEqual(headings(ALL_POOL), [
    ["Built-in", ["Zylot - Shiny"]],
    ["Cream · Dancer · Aurora", ["Geiss - Cauldron", "Royal - Mashup"]],
    ["Cream · Fractal", ["Mandelbox"]],
    ["Original", ["Geiss - Cauldron", "Rovastar - Fractopia"]]
  ]);
});

test("the same name in two packs and in butterchurn's stays three presets", () => {
  const groups = poolGroups(ALL_POOL, ["Geiss - Cauldron"], [cream, original], loadedPacks(), labels);
  const ids = groups.flatMap((group) => group.presets.map((preset) => preset.id)).filter((id) => id.endsWith("Geiss - Cauldron"));
  assert.deepEqual(ids, ["Geiss - Cauldron", "cream-of-the-crop:Dancer/Aurora/Geiss - Cauldron", "milkdrop-original:Geiss - Cauldron"]);
});

test("presets that failed are left out of the list", () => {
  const groups = poolGroups(packPool("cream-of-the-crop"), [], [cream], loadedPacks(), labels, new Set(["cream-of-the-crop:Fractal/Mandelbox"]));
  assert.deepEqual(groups.map((group) => group.label), ["Dancer · Aurora"]);
});

test("a pack that has not arrived yet lists nothing rather than failing", () => {
  assert.deepEqual(poolGroups(packPool("cream-of-the-crop"), ["a"], [cream], new Map(), labels), []);
});

test("a stored preset is filled out to what butterchurn expects", () => {
  const full = hydratePreset({ baseVals: { zoom: 1.02 }, shapes: [{ baseVals: { enabled: 1 }, frame_eqs_eel: "ang = time;" }], warp: "shader_body { ret = vec3(1.0); }" }) as {
    version: number;
    baseVals: Record<string, number>;
    shapes: { baseVals: Record<string, number>; init_eqs_eel: string; frame_eqs_eel: string }[];
    waves: { baseVals: Record<string, number>; point_eqs_eel: string }[];
    init_eqs_eel: string;
    pixel_eqs_eel: string;
    comp: string;
  };
  assert.equal(full.version, 2);
  assert.deepEqual(full.baseVals, { zoom: 1.02 });
  assert.equal(full.shapes.length, 4);
  assert.deepEqual(full.shapes[0], { baseVals: { enabled: 1 }, init_eqs_eel: "", frame_eqs_eel: "ang = time;" });
  assert.deepEqual(full.shapes[3]!.baseVals, { enabled: 0 });
  assert.equal(full.waves.length, 4);
  assert.equal(full.waves[2]!.point_eqs_eel, "");
  assert.equal(full.init_eqs_eel, "");
  assert.equal(full.pixel_eqs_eel, "");
  assert.equal(full.comp, "");
  assert.equal("md" in full, false);
});

test("BeatDrop's and MilkDrop 3's extra shapes and waves, and the engine's field, are kept", () => {
  const many = hydratePreset({ shapes: Array.from({ length: 6 }, () => ({ baseVals: { enabled: 1 } })), waves: [{}], md: { waveModes: 18 } }) as {
    shapes: unknown[];
    waves: unknown[];
    md: unknown;
  };
  assert.equal(many.shapes.length, 6);
  assert.equal(many.waves.length, 4);
  assert.deepEqual(many.md, { waveModes: 18 });
  // At most 16, as BeatDrop and MilkDrop 3 have.
  assert.equal((hydratePreset({ shapes: Array.from({ length: 20 }, () => ({})) }) as { shapes: unknown[] }).shapes.length, 16);
});

test("a MilkDrop 3 double preset keeps its two halves, each filled out, and its blend", () => {
  const blend = { pattern: "side", progress: 0.55, direction: 1, randoms: [0.1, 0.2, 0.3, 0.4, 0.5] };
  const double = hydratePreset({ double: { first: { baseVals: { zoom: 1.1 } }, second: { warp: "x" }, blend } });
  assert.ok(isDoublePreset(double));
  assert.deepEqual(double.double.blend, blend);
  assert.equal((double.double.first as { shapes: unknown[] }).shapes.length, 4);
  assert.equal((double.double.second as { warp: string }).warp, "x");
  assert.equal(isDoublePreset(hydratePreset({})), false);
});

test("chunks are fetched once, the oldest forgotten past the limit, a failure tried again", async () => {
  const fetched: string[] = [];
  let fail = true;
  const load = chunkLoader(async (url) => {
    fetched.push(url);
    if (url === "flaky" && fail) {
      fail = false;
      throw new Error("offline");
    }
    return { [url]: {} };
  }, 2);
  await load("a");
  await load("a");
  await load("b");
  await load("c");
  await load("a");
  assert.deepEqual(fetched, ["a", "b", "c", "a"]);
  await assert.rejects(load("flaky"), /offline/);
  assert.deepEqual(Object.keys(await load("flaky")), ["flaky"]);
  await assert.rejects(chunkLoader(async () => null)("x"), /unreadable/);
});

test("a preset found elsewhere is at home in butterchurn's presets or its own pack, whole", () => {
  const packs = [cream, original, { ...original, id: "cream-of-the-crop-2", name: "more cream" }];
  assert.equal(presetPool("Geiss - Feedback", ["Geiss - Feedback"], packs), BUILTIN_POOL);
  assert.equal(presetPool("cream-of-the-crop:Dancer/Martin/x", [], packs), packPool("cream-of-the-crop"));
  // The longest pack id the preset starts with, before its ":".
  assert.equal(presetPool("cream-of-the-crop-2:y", [], packs), packPool("cream-of-the-crop-2"));
  assert.equal(presetPool("milkdrop-original:", [], packs), null);
  assert.equal(presetPool("nobody:z", [], packs), null);
  assert.equal(presetPool("Geiss - Feedback", [], []), null);
});

test("butterchurn's preset names come from its packs' list of names, each once, under however many defaults", () => {
  const meta = {
    getImagePresetKeys: () => ({ presets: ["b", "a"] }),
    getBasePresetKeys: () => ({ presets: ["a", "c"] }),
    getExtraPresetKeys: () => ({ presets: ["d", 4] }),
    getMD1PresetKeys: () => ({ presets: ["e"] }),
    getMinimalPresetKeys: () => ({ presets: ["not loaded"] })
  };
  assert.deepEqual(builtinPresetNames(meta), ["b", "a", "c", "d", "e"]);
  assert.deepEqual(builtinPresetNames({ default: { default: meta } }), ["b", "a", "c", "d", "e"]);
  assert.deepEqual(builtinPresetNames(null), []);
  assert.deepEqual(builtinPresetNames({ default: 3 }), []);
});

test("the list of names is exactly the presets MilkDrop loads from butterchurn-presets", () => {
  // The packages are UMD bundles written for a browser (`self`); read as CommonJS here.
  const require = createRequire(import.meta.url);
  const scope = globalThis as { self?: unknown };
  scope.self ??= globalThis;
  const dist = "butterchurn-presets/dist/";
  const unwrap = (module: unknown): Record<string, unknown> => {
    let value = module;
    for (let depth = 0; depth < 3 && value && typeof value === "object" && "default" in value; depth += 1) value = (value as { default: unknown }).default;
    return value as Record<string, unknown>;
  };
  const loaded = Object.keys(Object.assign({}, ...["image", "base", "extra", "md1"].map((pack) => unwrap(require(`${dist}${pack}.min.js`)))));
  const listed = builtinPresetNames(require(`${dist}presetPackMeta.min.js`));
  assert.ok(loaded.length > 400);
  assert.deepEqual([...listed].sort(), [...loaded].sort());
});
