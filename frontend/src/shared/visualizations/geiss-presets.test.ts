import assert from "node:assert/strict";
import test from "node:test";

import { freeSlot, PRESETS_KEY, presetId, presetSlot, readPresets, validPreset, writePresets } from "./geiss/presets.ts";
import { GEISS_PRESET_FLOATS, GeissSim, NUM_MODES, WINAMP_SAMPLES, type GeissDepth, type GeissPreset, type WinampFrame } from "./geiss/sim.ts";

// Geiss 4.30's presets (`]##` saves, `[##` loads; SavePreset/LoadPreset in Effects.h): what the
// port saves, what it gives back, and that its loading is the original's, frame for frame.

/** The beating test signal of geiss.test.ts (integers only, so the reference run got the same bytes). */
function synthetic(frame: number, out: WinampFrame): void {
  const tri = (p: number): number => (p < 512 ? p : 1023 - p) - 256;
  const clamp = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v);
  const envelope = 20 + 6 * Math.max(0, 12 - (frame % 30));
  for (let i = 0; i < WINAMP_SAMPLES; i += 1) {
    out.wave[i] = clamp((tri(((frame * 576 + i) * 37) % 1024) * envelope) >> 7);
    out.wave[WINAMP_SAMPLES + i] = clamp((tri(((frame * 576 + i) * 53 + 300) % 1024) * envelope) >> 7);
    out.spectrum[i] = out.spectrum[WINAMP_SAMPLES + i] = Math.min(255, (envelope * (600 - i)) >> 8);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array, previous: number): number {
  let crc = ~previous >>> 0;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]!) & 255]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** What GEISS.INI's [PRESET ##] sections give LoadPreset(): "%f" floats, GetPrivateProfileInt integers. */
function parseIni(text: string): Map<number, Partial<GeissPreset>> {
  const sections = new Map<number, Partial<GeissPreset>>();
  const keys = new Map<string, keyof GeissPreset>();
  for (const key of ["x_center", "y_center", "mode", "damping", "wave", "magic", "volpos", "shift", "gamma", "t1", "t2", "s1", "s2",
    "f1", "f2", "f3", "f4", "effect_chasers", "effect_bar", "effect_dots", "effect_solar", "effect_grid", "effect_nuclide",
    "effect_shadebobs", "effect_spectral", "pal_lo_band", "pal_hi_band", "pal_bFX", "pal_FXpalnum", "pal_curve_id_1",
    "pal_curve_id_2", "pal_curve_id_3", "spectrum"] as const) keys.set(key.toLowerCase(), key);
  let section: Partial<GeissPreset> | null = null;
  for (const line of text.split(/\r?\n/).map((raw) => raw.trim())) {
    const head = /^\[PRESET (\d+)\]$/i.exec(line);
    if (head) sections.set(Number(head[1]), section = {});
    const pair = /^([^=]+)=(.*)$/.exec(line);
    const key = pair ? keys.get(pair[1]!.trim().toLowerCase()) : undefined;
    if (section && pair && key) section[key] = GEISS_PRESET_FLOATS.includes(key) ? Number.parseFloat(pair[2]!) : Number.parseInt(pair[2]!, 10);
  }
  return sections;
}

/**
 * A run as the reference harness makes it (384 × 240, 60 frames a second, the signal above),
 * its screen CRC'd frame after frame (at 8 bits with the palette), a mark every `every` frames.
 * `script` is the keys pressed before a frame: "mode N", "save N", "load N".
 */
function run(depth: GeissDepth, frames: number, every: number, script: Record<number, string>, ini?: Map<number, Partial<GeissPreset>>): string[] {
  const width = 384;
  const height = 240;
  const sim = new GeissSim(width, height, 18, { depth });
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  const surface = new Uint8Array(width * height * (depth / 8));
  const saved = new Map<number, GeissPreset>();
  const marks: string[] = [];
  let crc = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    synthetic(frame, audio);
    const [key, number] = (script[frame] ?? "").split(" ");
    const slot = Number(number);
    if (key === "mode") sim.selectMode(slot);
    if (key === "save") saved.set(slot, sim.savePreset()!);
    if (key === "load") sim.loadPreset((ini ?? saved).get(slot) ?? {});
    sim.frame(Math.trunc((frame * 1000) / 60), audio);
    const { top, bottom } = sim.band;
    surface.fill(0);
    if (depth === 8) {
      surface.set(sim.vs1.subarray(top * width, bottom * width), top * width);
    } else {
      for (let p = top * width * 4; p < bottom * width * 4; p += 1) if (p % 4 !== 3) surface[p] = Math.min(255, sim.vs1[p]! * 2);
    }
    crc = crc32(surface, crc);
    if (depth === 8) crc = crc32(sim.palette, crc);
    if ((frame + 1) % every === 0) marks.push(`0x${crc.toString(16).padStart(8, "0")}`);
  }
  return marks;
}

/** Two sections of a GEISS.INI the original wrote (seed 18 at 384 × 240: maps 12 and 15, `]12`, `]15`). */
const ORIGINAL_INI = `[PRESET 12]
x_center=0.442708
y_center=0.437500
mode=12
damping=0.500000
wave=3
magic=250
volpos=10
shift=1
gamma=10
t1=-0.008428
t2=-0.008428
s1=0.846679
s2=0.981069
f1=0.968800
f2=0.001732
f3=0.000000
f4=0.000000
effect_chasers=-1
effect_bar=-1
effect_dots=-1
effect_solar=-1
effect_grid=-1
effect_nuclide=-1
effect_shadebobs=-1
effect_spectral=-1
pal_lo_band=7
pal_hi_oband=22
pal_bFX=1
pal_FXpalnum=0
pal_curve_id_1=-1
pal_curve_id_2=-1
pal_curve_id_3=-1
spectrum=0
[PRESET 15]
x_center=0.476562
y_center=0.437500
mode=15
damping=0.500000
wave=5
magic=256
volpos=10
shift=1
gamma=10
t1=-0.035286
t2=-0.035286
s1=0.991242
s2=0.981069
f1=5.000000
f2=0.974960
f3=0.063400
f4=0.000000
effect_chasers=-1
effect_bar=-1
effect_dots=-1
effect_solar=-1
effect_grid=-1
effect_nuclide=-1
effect_shadebobs=-1
effect_spectral=-1
pal_lo_band=10
pal_hi_oband=17
pal_bFX=0
pal_FXpalnum=-1
pal_curve_id_1=3
pal_curve_id_2=3
pal_curve_id_3=2
spectrum=0
`;

// The expected values are the original's (main.cpp, Effects.h, video.h, proc_map.cpp compiled by
// MSVC for 32-bit x86, headless, rand() seeded), its LoadPreset() reading these files through
// GetPrivateProfileString(): see docs/FRONTEND.md, Geiss, "GEISS.INI".
test("Geiss presets: a GEISS.INI the original wrote loads as the original loads it, frame for frame", () => {
  const ini = parseIni(ORIGINAL_INI);
  const script = { 0: "mode 5", 30: "load 12", 70: "load 15" };
  assert.deepEqual(run(8, 150, 30, script, ini), ["0xb4a04c6d", "0x92db6d28", "0xdd89269d", "0xee4f1d6c", "0x975c891c"]);
  assert.deepEqual(run(32, 150, 30, script, ini), ["0x7a91b292", "0xfd0262a2", "0x3ec11c2b", "0x05995087", "0xb9afcb98"]);
});

test("Geiss presets: what the port saves, the original's LoadPreset() shows as the port does", () => {
  const script = { 0: "mode 12", 40: "save 12", 41: "mode 15", 80: "save 15", 81: "mode 5", 110: "load 12", 150: "load 15" };
  assert.deepEqual(run(8, 190, 38, script), ["0xb3dba53a", "0x7973dcd2", "0x8db17a2b", "0x85724680", "0xbef36a58"]);
  assert.deepEqual(run(32, 190, 38, script), ["0x630245fc", "0x4ec8f3c8", "0x9fa2240e", "0xebb4dc25", "0x16defd80"]);
});

/** What a loaded preset must give back, read from the port's state. */
interface Internals {
  mapOffset: Int32Array;
  mapWeights: Uint32Array;
  gXC: number;
  gYC: number;
  damping: number;
  weightsum: number;
  weightsumResAdjusted: number;
  visMode: number;
  ape2: Uint8Array;
}

function look(sim: GeissSim): Record<string, unknown> {
  const inner = sim as unknown as Internals;
  return {
    mode: sim.mode, gXC: inner.gXC, gYC: inner.gYC, damping: inner.damping, waveform: sim.waveform,
    effects: Array.from(sim.effect.subarray(0, 8)), shift: sim.slideShift,
    spectrum: inner.visMode, palette: sim.depth === 8 ? Array.from(inner.ape2) : null
  };
}

function frames(sim: GeissSim, count: number, from: number): void {
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  for (let frame = from; frame < from + count; frame += 1) {
    synthetic(frame, audio);
    sim.frame(Math.trunc((frame * 1000) / 60), audio);
  }
}

test("Geiss presets: every map saved and loaded again is the map that was saved, at 8 and 32 bits", () => {
  for (const depth of [8, 32] as const) {
    const sim = new GeissSim(320, 200, 7, { depth });
    let clock = 0;
    for (let mode = 1; mode <= NUM_MODES; mode += 1) {
      sim.selectMode(mode);
      frames(sim, 12, clock);
      clock += 12;
      const preset = sim.savePreset()!;
      const saved = look(sim);
      const inner = sim as unknown as Internals;
      const offsets = inner.mapOffset.slice();
      const weights = inner.mapWeights.slice();
      // Something else in between: another map, its own parameters and palette.
      sim.selectMode(mode % NUM_MODES + 1);
      frames(sim, 5, clock);
      clock += 5;
      assert.equal(sim.loadPreset(preset), true);
      assert.deepEqual(look(sim), saved, `map ${mode} at ${depth} bits`);
      // Maps 6, 7 and 14 draw part of the map from rand() (the vortices, the dither, the jitter),
      // which a preset does not hold, in Geiss as here: built again, not the same.
      if (mode !== 6 && mode !== 7 && mode !== 14) {
        assert.ok(inner.mapOffset.every((value, index) => value === offsets[index]), `map ${mode}: offsets`);
        assert.ok(inner.mapWeights.every((value, index) => value === weights[index]), `map ${mode}: weights`);
      }
      // Saved again, the same preset (bar the last pixel's scale of maps 7 and 14, which no map reads).
      const again = sim.savePreset()!;
      if (mode === 7 || mode === 14) again.s1 = preset.s1;
      assert.deepEqual(again, preset, `map ${mode} saved again`);
      frames(sim, 3, clock);
      clock += 3;
    }
  }
});

test("Geiss presets: GEISS.INI's keys, the centre as a fraction, the palette only at 8 bits", () => {
  const sim = new GeissSim(384, 240, 18, { depth: 8 });
  sim.selectMode(15);
  frames(sim, 4, 0);
  const preset = sim.savePreset()!;
  const inner = sim as unknown as Internals;
  assert.deepEqual(Object.keys(preset).sort(), [
    "damping", "effect_bar", "effect_chasers", "effect_dots", "effect_grid", "effect_nuclide", "effect_shadebobs", "effect_solar",
    "effect_spectral", "f1", "f2", "f3", "f4", "gamma", "magic", "mode", "pal_FXpalnum", "pal_bFX", "pal_curve_id_1", "pal_curve_id_2",
    "pal_curve_id_3", "pal_hi_band", "pal_lo_band", "s1", "s2", "shift", "spectrum", "t1", "t2", "volpos", "wave", "x_center", "y_center"
  ]);
  // LoadPreset(): (int)(x_center * FXW) in floats gives the centre back.
  assert.equal(Math.trunc(Math.fround(preset.x_center * 384)), inner.gXC);
  assert.equal(Math.trunc(Math.fround(preset.y_center * 240)), inner.gYC);
  assert.ok(Math.abs(preset.x_center - inner.gXC / 384) < 1e-6);
  // Elsewhere the same fraction of the picture, as in Geiss.
  const big = new GeissSim(640, 400, 3, { depth: 8 });
  big.loadPreset(preset);
  assert.equal((big as unknown as Internals).gXC, Math.trunc(Math.fround(preset.x_center * 640)));
  // Above 8 bits there is no palette to save.
  const colour = new GeissSim(384, 240, 18, { depth: 32 });
  colour.selectMode(15);
  const fromColour = colour.savePreset()!;
  assert.ok(!("pal_bFX" in fromColour) && !("pal_curve_id_1" in fromColour));
  // Loaded at 8 bits it gets a palette of its own, as a new map would, not curves "0" (all white).
  const classic = new GeissSim(384, 240, 18, { depth: 8 });
  classic.loadPreset(fromColour);
  frames(classic, 12, 0);
  assert.ok(classic.palette.some((value) => value < 255));
  assert.equal(classic.mode, 15);
});

test("Geiss presets: what Geiss's own file loses — the band of a palette, a pixel of the centre, map 12's fade", () => {
  const ini = parseIni(ORIGINAL_INI);
  const sim = new GeissSim(384, 240, 18, { depth: 8 });
  // Map 15 was saved with a band (pal_lo_band 10, its upper end 17 written as "pal_hi_oband"): loaded, it is gone.
  sim.loadPreset(ini.get(15)!);
  assert.equal(sim.savePreset()!.pal_hi_band, -1);
  // Map 12 was saved with its centre at x 170: 170/384 printed with six decimals, 0.442708, comes back 169.
  sim.loadPreset(ini.get(12)!);
  assert.equal((sim as unknown as Internals).gXC, 169);
  // …and with its weight sum already lowered (250), which loading lowers again.
  assert.equal((sim as unknown as Internals).weightsum, 245);
  // The port's file keeps the weight sum before the lowering (here Geiss's 250): the same map again.
  const own = sim.savePreset()!;
  assert.equal(own.magic, 250);
  sim.loadPreset(own);
  assert.equal((sim as unknown as Internals).weightsum, 245);
  // And a map 12 of the port's own: 256 saved, 250 on screen before and after.
  sim.selectMode(12);
  assert.equal((sim as unknown as Internals).weightsum, 250);
  const fresh = sim.savePreset()!;
  assert.equal(fresh.magic, 256);
  sim.loadPreset(fresh);
  assert.equal((sim as unknown as Internals).weightsum, 250);
});

test("Geiss presets: slots 00–99 kept in the browser, what cannot be loaded left out", () => {
  assert.equal(presetId(7), "preset-07");
  assert.equal(presetSlot("preset-07"), 7);
  assert.equal(presetSlot("preset-7"), null);
  assert.equal(presetSlot("map-07"), null);

  const sim = new GeissSim(320, 200, 5, { depth: 8 });
  sim.selectMode(9);
  const preset = sim.savePreset()!;
  assert.deepEqual(validPreset(preset), preset);
  assert.equal(validPreset({ ...preset, mode: 26 }), null);
  assert.equal(validPreset({ ...preset, t1: Number.NaN }), null);
  const { pal_bFX: _, ...partial } = preset;
  assert.equal(validPreset(partial), null);
  assert.deepEqual(validPreset({ ...preset, extra: 1 }), preset);

  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  };
  assert.equal(readPresets(storage).size, 0);
  assert.equal(writePresets(storage, new Map([[12, preset], [3, preset]])), true);
  assert.deepEqual(Object.keys(JSON.parse(items.get(PRESETS_KEY)!)).sort(), ["03", "12"]);
  const read = readPresets(storage);
  assert.deepEqual([...read.keys()], [3, 12]);
  assert.deepEqual(read.get(12), preset);
  // A slot that is not a preset any more, or not a slot, is skipped; the rest stays.
  items.set(PRESETS_KEY, JSON.stringify({ "03": preset, "04": { mode: 3 }, "7": preset, "x": 1 }));
  assert.deepEqual([...readPresets(storage).keys()], [3]);
  items.set(PRESETS_KEY, "{not json");
  assert.equal(readPresets(storage).size, 0);
  assert.equal(writePresets(storage, new Map()), true);
  assert.equal(items.has(PRESETS_KEY), false);

  assert.equal(freeSlot(new Map()), 1);
  assert.equal(freeSlot(new Map([[1, 0], [2, 0]])), 3);
  assert.equal(freeSlot(new Map(Array.from({ length: 99 }, (_, index) => [index + 1, 0] as const))), 0);
  assert.equal(freeSlot(new Map(Array.from({ length: 100 }, (_, index) => [index, 0] as const))), null);
});
