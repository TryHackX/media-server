import assert from "node:assert/strict";
import test from "node:test";

import { english } from "../i18n-en.ts";
import { provideDictionary, setLanguage, t } from "../i18n.ts";
import { BUDGET_STEP, BUDGET_WINDOW, PictureBudget, UP_WAIT_MAX_MS, UP_WAIT_MS } from "./geiss/budget.ts";
import { GEISS_MAPS, geissMap, geissMapId, mapRatings } from "./geiss/maps.ts";
import {
  BAR, CHASERS, DEFAULT_MODE_RATINGS, DOTS, GeissSim, GRID, MsvcRand, NUCLIDE, NUM_MODES, presentFrame, SHADE, SOLAR, WINAMP_SAMPLES,
  type GeissDepth, type WinampFrame
} from "./geiss/sim.ts";

provideDictionary("en", english);

test("Geiss draws with MSVC's rand(): srand(1) gives 41, 18467, 6334, 26500, 19169", () => {
  const rand = new MsvcRand(1);
  assert.deepEqual([rand.next(), rand.next(), rand.next(), rand.next(), rand.next()], [41, 18467, 6334, 26500, 19169]);
});

test("Geiss (Winamp): the 25 maps, numbered as the plug-in's keys, each named in both languages", () => {
  assert.equal(GEISS_MAPS.length, NUM_MODES);
  assert.deepEqual(GEISS_MAPS.map((map) => map.mode), Array.from({ length: NUM_MODES }, (_, index) => index + 1));
  assert.equal(new Set(GEISS_MAPS.map((map) => map.id)).size, NUM_MODES);
  assert.equal(new Set(GEISS_MAPS.map((map) => map.name)).size, NUM_MODES);
  for (const map of GEISS_MAPS) {
    assert.match(map.id, /^map-\d\d$/);
    assert.equal(geissMap(map.id), map);
    assert.equal(geissMapId(map.mode), map.id);
  }
  setLanguage("en");
  for (const map of GEISS_MAPS) assert.notEqual(t(map.name), map.name, `${map.name} has no English name`);
  setLanguage("pl");
});

test("Auto picks by Geiss's own stars; a pinned map or the favourites narrow the choice", () => {
  assert.equal(DEFAULT_MODE_RATINGS.length, NUM_MODES + 1);
  assert.deepEqual(mapRatings(DEFAULT_MODE_RATINGS, null, null), [...DEFAULT_MODE_RATINGS]);
  const pinned = mapRatings(DEFAULT_MODE_RATINGS, 12, null);
  assert.deepEqual(pinned.map((stars, mode) => (stars > 0 ? mode : 0)).filter(Boolean), [12]);
  // Favourites keep their stars; a one-star map among them stays possible.
  const favourites = mapRatings(DEFAULT_MODE_RATINGS, null, new Set(["map-05", "map-12"]));
  assert.equal(favourites[5], DEFAULT_MODE_RATINGS[5]);
  assert.equal(favourites[12], 1);
  assert.equal(favourites.reduce((sum, stars) => sum + stars, 0), favourites[5]! + favourites[12]!);
  // None of the favourites is a map: Geiss chooses freely again.
  assert.deepEqual(mapRatings(DEFAULT_MODE_RATINGS, null, new Set(["unknown"])), [...DEFAULT_MODE_RATINGS]);
});

/** CRC-32 (zlib's), chained like zlib.crc32(data, previous). */
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

/** A beating test signal in integers only, so the reference run got exactly these bytes. */
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

/**
 * The run's frames as the plug-in put them on the DirectDraw surface, CRC'd in turn: at 8 bits
 * the indices and the palette, at 32 bits each byte doubled (the unused fourth byte left out), at
 * 16 bits the 5-6-5 words; black outside the band.
 */
function run(width: number, height: number, seed: number, frames: number, every: number, script: (sim: GeissSim, frame: number) => void, depth: GeissDepth = 8): string[] {
  const sim = new GeissSim(width, height, seed, { depth });
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  const surface = new Uint8Array(width * height * (depth / 8));
  const twice = (value: number): number => Math.min(255, value * 2);
  const marks: string[] = [];
  let crc = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    synthetic(frame, audio);
    script(sim, frame);
    sim.frame(Math.trunc((frame * 1000) / 60), audio);
    const { top, bottom } = sim.band;
    surface.fill(0);
    const vs = sim.vs1;
    if (depth === 8) {
      surface.set(vs.subarray(top * width, bottom * width), top * width);
    } else {
      for (let p = top * width; p < bottom * width; p += 1) {
        const q = p * 4;
        if (depth === 32) {
          for (let c = 0; c < 3; c += 1) surface[q + c] = twice(vs[q + c]!);
        } else {
          const word = ((twice(vs[q + 2]!) >> 3) << 11) | ((twice(vs[q + 1]!) >> 2) << 5) | (twice(vs[q]!) >> 3);
          surface[p * 2] = word & 255;
          surface[p * 2 + 1] = word >> 8;
        }
      }
    }
    crc = crc32(surface, crc);
    if (depth === 8) crc = crc32(sim.palette, crc);
    if ((frame + 1) % every === 0) marks.push(`0x${crc.toString(16).padStart(8, "0")}`);
  }
  return marks;
}

/** Every map with its waveform and an effect forced, a new palette now and then (keys "##", w, q/u/d/Y/g/e/A, p). */
function everyMap(sim: GeissSim, frame: number): void {
  const effects = [[CHASERS, 2], [BAR, 1], [DOTS, 1], [SOLAR, 1], [GRID, 1], [SHADE, 1], [NUCLIDE, 1]] as const;
  const mode = Math.floor(frame / 12) + 1;
  const at = frame % 12;
  if (at === 0) sim.selectMode(mode);
  if (at === 4) {
    const [effect, value] = effects[(mode - 1) % effects.length]!;
    sim.effect[effect] = value;
  }
  if (at === 6) sim.waveform = 1 + ((mode - 1) % 7);
  if (at === 8 && mode % 5 === 0) sim.randomPalette();
}

// The expected values are what Ryan Geiss's own code gives for the same input: main.cpp,
// proc_map.cpp (its self-modifying asm), Effects.h and video.h compiled with MSVC for 32-bit
// x86, DirectDraw and Winamp replaced by a headless host, rand() seeded, the clock at 60 fps
// (the reference harness and its comparison runs are described in docs/FRONTEND.md).
test("Geiss (Winamp) draws the original's frames bit for bit: every map, waveform and effect", () => {
  assert.deepEqual(run(384, 240, 5, 300, 60, everyMap), ["0x71c51c98", "0xd845b345", "0x461e1403", "0xde52fe13", "0x90424e1f"]);
});

test("Geiss (Winamp) left to itself: the spectrum map, then a new map by the stars, as the original", () => {
  assert.deepEqual(run(320, 200, 9, 900, 300, () => undefined), ["0x7b89aff5", "0x97417be3", "0xe40b048d"]);
});

test("Geiss (Winamp) in 32-bit colour, Geiss 4.30's default: the original's screen, map by map", () => {
  assert.deepEqual(run(384, 240, 5, 300, 60, everyMap, 32), ["0x7a98f2cc", "0xe93cfbdd", "0xe5615e20", "0xd9c0f7fe", "0x43129157"]);
  assert.deepEqual(run(320, 200, 9, 900, 300, () => undefined, 32), ["0x187c9c04", "0x0e6d6d1b", "0xb28f496b"]);
});

test("Geiss (Winamp) in 16-bit colour: the original's 5-6-5 screen, map by map", () => {
  assert.deepEqual(run(384, 240, 5, 300, 60, everyMap, 16), ["0xaeb54a48", "0x74372e3a", "0x65bc7faf", "0x76473c58", "0x825a92d0"]);
});

test("the screen as the card showed it: 8 bits through the palette, 16/32 bits doubled, 16 bits cut to 5-6-5", () => {
  const out = new Uint32Array(320 * 200);
  const rgb = (word: number): number[] => [word & 255, (word >>> 8) & 255, (word >>> 16) & 255];
  const colour = new GeissSim(320, 200, 1, { depth: 32 });
  const at = (colour.band.top * 320 + 10) * 4;
  colour.vs1.set([10, 100, 200], at); // blue, green, red: twice each, red stops at 255
  presentFrame(colour, out);
  assert.deepEqual(rgb(out[colour.band.top * 320 + 10]!), [255, 200, 20]);
  assert.deepEqual(rgb(out[0]!), [0, 0, 0]);
  const sixteen = new GeissSim(320, 200, 1, { depth: 16 });
  sixteen.vs1.set([10, 100, 200], at);
  presentFrame(sixteen, out);
  // 400 → 255 → 31 → 255; 200 → 50 (6 bits) → 203; 20 → 2 (5 bits) → 16
  assert.deepEqual(rgb(out[sixteen.band.top * 320 + 10]!), [255, 203, 16]);
  const palette = new GeissSim(320, 200, 1);
  palette.vs1[palette.band.top * 320 + 10] = 7;
  palette.palette.set([1, 2, 3], 7 * 3);
  presentFrame(palette, out);
  assert.deepEqual(rgb(out[palette.band.top * 320 + 10]!), [1, 2, 3]);
  // 32-bit modes were 16 pixels a turn wide (the copy to the screen); 8 bits had no such rule here.
  assert.throws(() => new GeissSim(328, 200, 1, { depth: 32 }));
  assert.doesNotThrow(() => new GeissSim(328, 200, 1, { depth: 8 }));
});

// The picture's size under load (geiss/budget.ts): frames of 1/60 s, a window every 30 of them.
const FRAME_MS = 1000 / 60;
const LIMITS = { max: 1280 * 720, min: 400 * 300 };

/** Frames at a given cost: in which window the budget changes (-1: not within `windows`). */
function windowsUntilChange(budget: PictureBudget, cost: (frame: number) => number, pixels: number, wanted: number, windows: number, clock = { time: 0 }): number {
  for (let frame = 0; frame < windows * BUDGET_WINDOW; frame += 1) {
    clock.time += FRAME_MS;
    if (budget.observe(cost(frame), clock.time, pixels, wanted)) return Math.floor(frame / BUDGET_WINDOW) + 1;
  }
  return -1;
}

/**
 * A machine whose frame costs a fixed part and a part per pixel, times the load on its CPU, in the
 * adapter's loop: the picture takes the budget (as pictureSize() does), at most the panel.
 */
function machine(load: (second: number) => number, seconds: number, panel = LIMITS.max): number[] {
  const budget = new PictureBudget(LIMITS);
  let pixels = Math.min(panel, budget.budget);
  const sizes: number[] = [pixels];
  for (let time = 0; time < seconds * 1000; time += FRAME_MS) {
    const cost = (1 + pixels * 9e-6) * load(time / 1000);
    if (budget.observe(cost, time, pixels, panel)) {
      pixels = Math.min(panel, Math.round(budget.budget));
      budget.restart();
      sizes.push(pixels);
    }
  }
  return sizes;
}

test("Geiss under load: steady cheap frames change nothing, three slow windows shrink the picture to 60%", () => {
  const cheap = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(cheap, () => 6, LIMITS.max, LIMITS.max, 200), -1);
  assert.equal(cheap.budget, LIMITS.max);
  // The first window of a picture is not judged; then three slow windows in a row.
  const slow = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(slow, () => 20, LIMITS.max, LIMITS.max, 10), 4);
  assert.equal(slow.budget, LIMITS.max * BUDGET_STEP);
  // Two slow windows and a quick one, over and over: the count starts again each time.
  const mixed = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(mixed, (frame) => (Math.floor(frame / BUDGET_WINDOW) % 3 === 0 ? 10 : 20), LIMITS.max, LIMITS.max, 60), -1);
});

test("Geiss under load: one costly frame per window (a map built at once) is not a slow machine", () => {
  const spikes = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(spikes, (frame) => (frame % BUDGET_WINDOW === 7 ? 150 : 8), LIMITS.max, LIMITS.max, 100), -1);
  // A third of every window slow is not slow (the median); two thirds is.
  const third = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(third, (frame) => (frame % 3 ? 13 : 30), LIMITS.max, LIMITS.max, 10), -1);
  const most = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(most, (frame) => (frame % 3 ? 30 : 13), LIMITS.max, LIMITS.max, 10), 4);
});

test("Geiss under load: the picture grows back after 8 s of cheap frames, not before, never past the panel or the device", () => {
  const budget = new PictureBudget(LIMITS);
  const clock = { time: 0 };
  assert.equal(windowsUntilChange(budget, () => 20, LIMITS.max, LIMITS.max, 10, clock), 4);
  const small = budget.budget;
  budget.restart();
  // 4 ms at 60% of the pixels predicts 6.7 ms at full size: comfortable. The first window is not
  // judged, the 8 s count from the start of the second, and the step comes with the window ending them.
  const before = clock.time;
  windowsUntilChange(budget, () => 4, small, LIMITS.max, 40, clock);
  const waited = clock.time - before - BUDGET_WINDOW * FRAME_MS;
  assert.ok(waited >= UP_WAIT_MS && waited < UP_WAIT_MS + BUDGET_WINDOW * FRAME_MS + 1, `stepped up after ${waited} ms`);
  assert.equal(budget.budget, LIMITS.max);
  // As big as the panel wants: no step, however cheap.
  const fits = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(fits, () => 30, LIMITS.max, LIMITS.max, 4), 4);
  fits.restart();
  assert.equal(windowsUntilChange(fits, () => 1, LIMITS.max * BUDGET_STEP, LIMITS.max * BUDGET_STEP, 100), -1);
  // The floor, and nothing below it.
  const floor = new PictureBudget(LIMITS);
  for (let step = 0; step < 10; step += 1) {
    windowsUntilChange(floor, () => 40, Math.round(floor.budget), LIMITS.max, 4);
    floor.restart();
  }
  assert.equal(floor.budget, LIMITS.min);
  assert.equal(windowsUntilChange(floor, () => 40, LIMITS.min, LIMITS.max, 20), -1);
  // The ceiling: a picture that the panel would want bigger than the device allows.
  const ceiling = new PictureBudget(LIMITS);
  assert.equal(windowsUntilChange(ceiling, () => 1, LIMITS.max, LIMITS.max * 4, 100), -1);
  assert.equal(ceiling.budget, LIMITS.max);
});

test("Geiss under load: a cost between the two thresholds keeps the size, and a pause restarts the comfort", () => {
  const budget = new PictureBudget(LIMITS);
  windowsUntilChange(budget, () => 20, LIMITS.max, LIMITS.max, 4);
  const small = budget.budget;
  budget.restart();
  // 7.5 ms at 60% predicts 12.5 ms at full size: over 80% of 14 ms, under 14 ms itself.
  assert.equal(windowsUntilChange(budget, () => 7.5, small, LIMITS.max, 2000), -1);
  assert.equal(budget.budget, small);
  // Cheap frames, but a 5 s pause every 6 s: never 8 s of comfort in a row.
  const paused = new PictureBudget(LIMITS);
  const clock = { time: 0 };
  windowsUntilChange(paused, () => 20, LIMITS.max, LIMITS.max, 4, clock);
  paused.restart();
  for (let round = 0; round < 20; round += 1) {
    assert.equal(windowsUntilChange(paused, () => 3, small, LIMITS.max, 12, clock), -1);
    clock.time += 5000;
  }
});

test("Geiss under load: a machine loaded and then left alone shrinks, grows back, and does not oscillate", () => {
  // Unloaded, the full picture costs 1 + 8.3 = 9.3 ms; three times the load makes it 28 ms.
  const sizes = machine((second) => (second >= 10 && second < 40 ? 3 : 1), 120);
  assert.equal(sizes[0], LIMITS.max);
  const smallest = Math.min(...sizes);
  const at = sizes.indexOf(smallest);
  assert.ok(smallest < LIMITS.max * 0.4, `shrank to ${smallest}`);
  // Only down while loaded, then only up: no back and forth.
  for (let index = 1; index < sizes.length; index += 1) {
    if (index <= at) assert.ok(sizes[index]! < sizes[index - 1]!, sizes.join(" → "));
    else assert.ok(sizes[index]! > sizes[index - 1]!, sizes.join(" → "));
  }
  assert.equal(sizes.at(-1), LIMITS.max, sizes.join(" → "));
  // A steady load just too much for the full picture: one step down, and there it stays.
  assert.deepEqual(machine(() => 1.6, 600), [LIMITS.max, LIMITS.max * BUDGET_STEP]);
});

test("Geiss under load: a step up that does not hold makes the next one wait longer", () => {
  // A machine the prediction gets wrong: the full picture is far slower than its pixels say.
  const budget = new PictureBudget(LIMITS);
  let pixels = LIMITS.max;
  const changes: number[] = [];
  for (let time = 0; time < 600_000; time += FRAME_MS) {
    if (budget.observe(pixels >= LIMITS.max ? 20 : 4, time, pixels, LIMITS.max)) {
      pixels = Math.round(budget.budget);
      budget.restart();
      changes.push(time);
    }
  }
  assert.equal(budget.wait, UP_WAIT_MAX_MS);
  // Up, down, and up again later each time: a handful of tries in ten minutes.
  assert.ok(changes.length < 30, `${changes.length} changes`);
  const ups = changes.filter((_, index) => index % 2 === 1);
  const gaps = ups.slice(1).map((at, index) => at - ups[index]!);
  for (let index = 1; index < gaps.length; index += 1) assert.ok(gaps[index]! >= gaps[index - 1]! - BUDGET_WINDOW * FRAME_MS - 1, `gaps ${gaps.map(Math.round).join(", ")}`);
  assert.ok(gaps.at(-1)! > UP_WAIT_MAX_MS, `gaps ${gaps.map(Math.round).join(", ")}`);
});
