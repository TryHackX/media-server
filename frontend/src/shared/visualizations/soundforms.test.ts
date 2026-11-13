import assert from "node:assert/strict";
import test from "node:test";

import { english } from "../i18n-en.ts";
import { provideDictionary, setLanguage, t } from "../i18n.ts";
import { autoGain, bandEdges, bandValue, envelope, triggerIndex } from "./soundforms/analysis.ts";
import { GROUPS, PRESETS } from "./soundforms/catalog.ts";

provideDictionary("en", english);

test("Formy dźwięku: every preset once, under a heading that exists, each heading used", () => {
  const ids = PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "preset ids collide");
  for (const id of ids) assert.match(id, /^[a-z]+(-[a-z]+)+$/, id);
  const names = PRESETS.map((preset) => preset.name);
  assert.equal(new Set(names).size, names.length, "two presets share a name");
  const groups = new Set(GROUPS.map((group) => group.id));
  for (const preset of PRESETS) assert.ok(groups.has(preset.group), `${preset.id}: no heading ${preset.group}`);
  for (const group of GROUPS) assert.ok(PRESETS.some((preset) => preset.group === group.id), `${group.id} is empty`);
});

test("Formy dźwięku answers each vizz.fm variant the owner asked for, once", () => {
  const range = (type: string, numbers: number[]): string[] => numbers.map((n) => `${type} ${n}`);
  const asked = [
    ...range("Particle Dance", [3, 4]),
    ...range("Dot Grid", [3]),
    ...range("Classic Spectrum", [6, 7, 10, 11, 12]),
    ...range("Textured Sphere", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    ...range("Wavy Form", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
    ...range("Equalizer Rings", [4]),
    ...range("Mesh Grid", [5, 6, 9])
  ];
  assert.deepEqual(PRESETS.map((preset) => preset.answers).sort(), asked.sort());
});

test("Formy dźwięku's gradients fit the shader (one to eight stops) and its backdrops one or two", () => {
  for (const preset of PRESETS) {
    const colors = preset.settings.colors;
    assert.ok(colors.length >= 1 && colors.length <= 8, `${preset.id}: ${colors.length} stops`);
    assert.ok(preset.background.length >= 1 && preset.background.length <= 2, preset.id);
    for (const color of [...colors, ...preset.background]) assert.ok(Number.isInteger(color) && color >= 0 && color <= 0xffffff);
  }
});

test("Formy dźwięku speaks English: the visualizer, its headings and every preset", () => {
  setLanguage("en");
  for (const text of ["Formy dźwięku", ...GROUPS.map((group) => group.name), ...PRESETS.map((preset) => preset.name)]) {
    assert.notEqual(t(text), text, `no English for "${text}"`);
  }
  setLanguage("pl");
});

test("bands are spaced evenly in octaves, from the lowest to the highest frequency", () => {
  const edges = bandEdges(128, 32, 16000, 44100 / 2048);
  assert.equal(edges.length, 129);
  assert.ok(Math.abs(edges[0]! - 32 / (44100 / 2048)) < 1e-6);
  assert.ok(Math.abs(edges[128]! - 16000 / (44100 / 2048)) < 1e-3);
  const ratio = edges[1]! / edges[0]!;
  for (let band = 1; band < 128; band += 1) assert.ok(Math.abs(edges[band + 1]! / edges[band]! - ratio) < 1e-4);
});

test("a band of silence is 0, a band at full scale close to 1, and quiet stays low", () => {
  const silence = new Uint8Array(1024);
  const full = new Uint8Array(1024).fill(255);
  const quiet = new Uint8Array(1024).fill(64);
  assert.equal(bandValue(silence, 1024, 10, 20, 0.5), 0);
  assert.equal(bandValue(full, 1024, 10, 20, 0.5), 1);
  // Bass is tilted down a little against treble, which music has less of.
  assert.ok(bandValue(full, 1024, 10, 20, 0) > 0.8);
  assert.ok(bandValue(full, 1024, 10, 20, 0) < bandValue(full, 1024, 10, 20, 0.2));
  assert.ok(bandValue(quiet, 1024, 10, 20, 0) < 0.1);
  // Narrower than a bin: read between the two neighbours.
  const ramp = Uint8Array.from({ length: 1024 }, (_, index) => Math.min(255, index * 10));
  assert.ok(bandValue(ramp, 1024, 2.2, 2.4, 0) > bandValue(ramp, 1024, 1.2, 1.4, 0));
  // The audible part only: bins beyond `usable` are never read (a 192 kHz analyser's top).
  const loudTop = new Uint8Array(1024);
  loudTop.fill(255, 256);
  assert.equal(bandValue(loudTop, 256, 300, 400, 1), 0);
});

test("quiet music is brought up, loud music is not, and silence stays silence", () => {
  assert.equal(autoGain(0.5), 1);
  assert.ok(autoGain(0.12) > 2.5 && autoGain(0.12) <= 2.6);
  assert.equal(autoGain(0), 2.6);
  assert.equal(0 * autoGain(0), 0);
});

test("the follower rises quickly, falls slowly and never overshoots", () => {
  const up = envelope(0, 1, 1 / 60, 0.02, 0.5);
  const down = envelope(1, 0, 1 / 60, 0.02, 0.5);
  assert.ok(up > 0.5 && up < 1);
  assert.ok(down > 0.95 && down < 1);
  let value = 0;
  for (let step = 0; step < 600; step += 1) value = envelope(value, 0.7, 1 / 60, 0.05, 0.3);
  assert.ok(Math.abs(value - 0.7) < 1e-6);
});

test("the waveform is read from a rising zero crossing, leaving room for the whole window", () => {
  const samples = Float32Array.from({ length: 2048 }, (_, index) => Math.sin((index - 700.5) / 40));
  const start = triggerIndex(samples, 1024);
  assert.ok(start >= 512 && start <= 1024);
  assert.ok(samples[start - 1]! < 0 && samples[start]! >= 0);
  // No crossing at all: the newest samples.
  assert.equal(triggerIndex(new Float32Array(2048).fill(0.5), 1024), 1024);
});
