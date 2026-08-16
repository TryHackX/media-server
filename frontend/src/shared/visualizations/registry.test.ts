import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The registry imports the plugin modules without extensions (bundler resolution),
// which plain Node cannot load, so the invariants are checked on the source text.
const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const registrySource = read("registry.ts");
const pluginSources = ["spectrum.ts", "radial.ts", "fields.ts", "classic.ts", "psychedelic.ts", "showcase.ts"].map(read);

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

test("the curated originals keep their positions at the head of the order", () => {
  assert.deepEqual(defaultOrder().slice(0, 4), ["snow-spectrum", "poweramp", "solar-flare", "flow-field"]);
});

test("classic visualizers use the migrated implementations", () => {
  const classicSource = read("classic.ts");
  assert.match(classicSource, /id:\s*"poweramp"[\s\S]*?fftSize:\s*16384/);
  assert.match(classicSource, /id:\s*"solar-flare"[\s\S]*?fftSize:\s*16384/);
  assert.match(classicSource, /id:\s*"flow-field"[\s\S]*?label:\s*"Audio Flow Field"[\s\S]*?fftSize:\s*2048/);
});
