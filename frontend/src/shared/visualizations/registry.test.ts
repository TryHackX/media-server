import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { canonicalVisualizerId, INTERNAL_ORDER } from "./internal-plugin.ts";

// The registry imports the plugin modules without extensions (bundler resolution),
// which plain Node cannot load, so the invariants are checked on the source text.
const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const registrySource = read("registry.ts");
const pluginSources = [
  "internal-plugin.ts", "favorites-plugin.ts", "milkdrop.ts", "geiss.ts", "avs-plugin.ts", "voltviz-plugin.ts",
  "soundforms-plugin.ts", "shaders-plugin.ts", "retro-plugin.ts"
].map(read);
/** The player's own visualizations: the presets of Internal. */
const internalSources = ["spectrum.ts", "radial.ts", "fields.ts", "classic.ts", "psychedelic.ts", "showcase.ts"].map(read);

function defaultOrder(): string[] {
  const block = registrySource.match(/defaultVisualizerOrder = \[([\s\S]*?)\];/);
  assert.ok(block, "defaultVisualizerOrder array literal not found");
  return [...block[1].matchAll(/"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]);
}

function registeredIds(): string[] {
  return pluginSources.flatMap((source) => [...source.matchAll(/\bid:\s*"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]));
}

test("every registered visualizer is reachable through the default order", () => {
  const order = defaultOrder();
  const registered = registeredIds();
  assert.equal(new Set(order).size, order.length, "default order has duplicates");
  assert.equal(new Set(registered).size, registered.length, "plugin ids collide");
  assert.deepEqual([...order].sort(), [...registered].sort());
});

test("Internal holds every one of the player's own visualizations, once, the curated four first", () => {
  const declared = internalSources.flatMap((source) => [...source.matchAll(/\bid:\s*"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]));
  assert.equal(new Set(INTERNAL_ORDER).size, INTERNAL_ORDER.length, "Internal lists one twice");
  assert.deepEqual([...INTERNAL_ORDER].sort(), [...declared].sort());
  assert.deepEqual(INTERNAL_ORDER.slice(0, 4), ["snow-spectrum", "poweramp", "solar-flare", "flow-field"]);
  assert.equal(defaultOrder()[0], "internal");
});

test("a setting that still names one of them means Internal; anything else is left alone", () => {
  for (const id of INTERNAL_ORDER) assert.equal(canonicalVisualizerId(id), "internal");
  for (const id of ["internal", "milkdrop", "avs", "voltviz", "unknown"]) assert.equal(canonicalVisualizerId(id), id);
});

test("classic visualizers use the migrated implementations", () => {
  const classicSource = read("classic.ts");
  assert.match(classicSource, /id:\s*"poweramp"[\s\S]*?fftSize:\s*16384/);
  assert.match(classicSource, /id:\s*"solar-flare"[\s\S]*?fftSize:\s*16384/);
  assert.match(classicSource, /id:\s*"flow-field"[\s\S]*?label:\s*"Audio Flow Field"[\s\S]*?fftSize:\s*2048/);
});

test("VoltViz offers every vendored voltviz visualization, each one once", () => {
  const catalog = read("voltviz/catalog.ts");
  const ids = [...catalog.matchAll(/\bid:\s*"([a-z0-9]+)"/g)].map((match) => match[1]);
  const modules = [...catalog.matchAll(/import\("\.\/visualizers\/impl\/([A-Za-z0-9]+)"\)/g)].map((match) => match[1]);
  const vendored = readdirSync(new URL("./voltviz/visualizers/impl/", import.meta.url))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3));
  assert.equal(new Set(ids).size, ids.length, "VoltViz ids collide");
  assert.equal(ids.length, modules.length, "every VoltViz entry names its module");
  // Your Logo is offered by the adapter instead, once per logo in vendor/voltviz-logos.
  assert.match(read("voltviz/index.ts"), /import\("\.\/visualizers\/impl\/YourLogo"\)/);
  assert.ok(!modules.includes("YourLogo"));
  assert.deepEqual([...new Set([...modules, "YourLogo"])].sort(), [...vendored].sort());
  // Not MIT (CC BY-NC shaders), or the player has its own MilkDrop: never vendored.
  for (const left of ["MossBall", "Flame", "MilkDrop", "MilkDropWarp"]) assert.ok(!vendored.includes(left), left);
});
