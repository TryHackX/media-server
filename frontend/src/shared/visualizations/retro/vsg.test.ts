import assert from "node:assert/strict";
import test from "node:test";

import { RetroAnalysis, WINDOW } from "./analysis.ts";
import { BANDS, bandEdges, HIGH_HZ, Listener, LOW_HZ, trigger } from "./vsg/listen.ts";
import { DEFAULT_PALETTE, packPalette, PALETTES } from "./vsg/palettes.ts";
import { blit, clip, Raster } from "./vsg/raster.ts";

// VSG+ (DOS): QuickBASIC's primitives on a 16-colour screen, the machines' palettes and the
// listening the effects share — the arithmetic without the DOM.

/** The lit pixels of a raster as "x,y" strings. */
function lit(raster: Raster): Set<string> {
  const pixels = new Set<string>();
  for (let index = 0; index < raster.pixels.length; index += 1) {
    if (raster.pixels[index]) pixels.add(`${index % raster.width},${Math.floor(index / raster.width)}`);
  }
  return pixels;
}

function point(key: string): [number, number] {
  const [x, y] = key.split(",").map(Number);
  return [x!, y!];
}

/** A little sequence of numbers for the randomised tests, the same every run. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 4294967296;
  };
}

test("a line has both ends, one pixel per step of its longer side, each within half a pixel of the line", () => {
  const random = sequence(7);
  for (let trial = 0; trial < 200; trial += 1) {
    const raster = new Raster(64, 48);
    const [x0, y0, x1, y1] = [random() * 64, random() * 48, random() * 64, random() * 48].map(Math.floor) as [number, number, number, number];
    raster.line(x0, y0, x1, y1, 15);
    const pixels = lit(raster);
    assert.ok(pixels.has(`${x0},${y0}`) && pixels.has(`${x1},${y1}`));
    assert.equal(pixels.size, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1);
    const length = Math.hypot(x1 - x0, y1 - y0);
    for (const key of pixels) {
      const [x, y] = point(key);
      const distance = length ? Math.abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / length : 0;
      assert.ok(distance <= Math.SQRT1_2 + 1e-9, `${key} is ${distance} off`);
    }
  }
});

test("a line is the same pixels whichever end comes first, and steps 8-connected", () => {
  const random = sequence(11);
  for (let trial = 0; trial < 200; trial += 1) {
    const ends = [random() * 80 - 8, random() * 60 - 6, random() * 80 - 8, random() * 60 - 6] as const;
    const forth = new Raster(64, 48);
    const back = new Raster(64, 48);
    forth.line(ends[0], ends[1], ends[2], ends[3], 9);
    back.line(ends[2], ends[3], ends[0], ends[1], 9);
    assert.deepEqual(forth.pixels, back.pixels);
  }
  const raster = new Raster(40, 40);
  raster.line(2, 3, 37, 21, 1);
  for (const key of lit(raster)) {
    const [x, y] = point(key);
    let neighbours = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && raster.pixels[(y + dy) * 40 + x + dx]) neighbours += 1;
    assert.ok(neighbours >= 1 && neighbours <= 2, `${key} has ${neighbours}`);
  }
});

test("level, upright and diagonal lines are exact", () => {
  const raster = new Raster(10, 10);
  raster.line(1, 2, 7, 2, 4);
  assert.deepEqual([...lit(raster)].sort(), ["1,2", "2,2", "3,2", "4,2", "5,2", "6,2", "7,2"].sort());
  raster.clear();
  raster.line(3, 8, 3, 5, 4);
  assert.deepEqual([...lit(raster)].sort(), ["3,5", "3,6", "3,7", "3,8"]);
  raster.clear();
  raster.line(0, 0, 4, 4, 4);
  assert.deepEqual([...lit(raster)].sort(), ["0,0", "1,1", "2,2", "3,3", "4,4"]);
  // Fractional ends are rounded.
  raster.clear();
  raster.line(0.4, 0.6, 2.4, 0.6, 4);
  assert.deepEqual([...lit(raster)].sort(), ["0,1", "1,1", "2,1"]);
});

test("off the screen nothing is drawn; a line far off is clipped first and keeps its course", () => {
  const raster = new Raster(32, 24);
  raster.line(-50, -5, -2, 30, 7);
  raster.line(40, 0, 90, 20, 7);
  raster.pset(-1, 3, 7);
  raster.pset(32, 3, 7);
  assert.equal(lit(raster).size, 0);
  // Across the screen from very far away: the same pixels on screen as a line between nearer
  // points of the same course would give, to within a pixel.
  raster.line(-100000, 12, 100000, 12, 2);
  assert.equal(lit(raster).size, 32);
  raster.clear();
  raster.line(-9000, -9000, 9000, 9000, 2);
  const diagonal = lit(raster);
  assert.ok(diagonal.size >= 23 && diagonal.size <= 25, String(diagonal.size));
  for (const key of diagonal) {
    const [x, y] = point(key);
    assert.ok(Math.abs(x - y) <= 1, key);
  }
});

test("Liang–Barsky keeps the part inside and refuses what misses", () => {
  assert.deepEqual(clip(-10, 5, 30, 5, 0, 0, 20, 10), [0, 5, 20, 5]);
  assert.deepEqual(clip(2, 2, 8, 8, 0, 0, 20, 10), [2, 2, 8, 8]);
  assert.deepEqual(clip(-5, -5, 25, 25, 0, 0, 20, 10), [0, 0, 10, 10]);
  assert.equal(clip(-10, -10, -1, 20, 0, 0, 20, 10), null);
  assert.equal(clip(0, 11, 20, 30, 0, 0, 20, 10), null);
});

test("a circle lies within half a pixel of its radius, the same in all eight octants", () => {
  for (const radius of [1, 2, 3, 5, 8, 13, 21, 37, 60]) {
    const raster = new Raster(140, 140);
    raster.circle(70, 70, radius, 12);
    const pixels = lit(raster);
    for (const key of pixels) {
      const [x, y] = point(key);
      const distance = Math.hypot(x - 70, y - 70);
      assert.ok(Math.abs(distance - radius) <= 0.6, `r ${radius}: ${key} at ${distance}`);
      // Mirrored across both axes and the diagonals.
      for (const [mx, my] of [[140 - x, y], [x, 140 - y], [70 + (y - 70), 70 + (x - 70)]] as const) {
        assert.ok(pixels.has(`${mx},${my}`), `r ${radius}: ${key} has no mirror ${mx},${my}`);
      }
    }
    // Closed: every pixel has at least two lit neighbours.
    for (const key of pixels) {
      const [x, y] = point(key);
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && pixels.has(`${x + dx},${y + dy}`)) neighbours += 1;
      assert.ok(neighbours >= 2, `r ${radius}: ${key} has ${neighbours}`);
    }
  }
  const dot = new Raster(9, 9);
  dot.circle(4, 4, 0, 3);
  assert.deepEqual([...lit(dot)], ["4,4"]);
  dot.clear();
  dot.circle(4, 4, -2, 3);
  assert.equal(lit(dot).size, 0);
});

test("a circle partly off the screen draws just the part a larger screen would show", () => {
  const whole = new Raster(200, 200);
  whole.circle(60, 90, 70, 5);
  const part = new Raster(100, 100);
  part.circle(10, 40, 70, 5);
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 100; x += 1) assert.equal(part.pixels[y * 100 + x], whole.pixels[(y + 50) * 200 + x + 50], `${x},${y}`);
  }
});

test("an ellipse keeps to its equation, and with equal half-axes it is the circle's shape", () => {
  const raster = new Raster(200, 120);
  raster.ellipse(100, 60, 80, 30, 6);
  const pixels = lit(raster);
  for (const key of pixels) {
    const [x, y] = point(key);
    const value = ((x - 100) / 80) ** 2 + ((y - 60) / 30) ** 2;
    assert.ok(Math.abs(value - 1) < 0.08, `${key}: ${value}`);
  }
  for (const key of ["20,60", "180,60", "100,30", "100,90"]) assert.ok(pixels.has(key), key);
  const round = new Raster(80, 80);
  round.ellipse(40, 40, 25, 25, 1);
  for (const key of lit(round)) {
    const [x, y] = point(key);
    assert.ok(Math.abs(Math.hypot(x - 40, y - 40) - 25) <= 0.75, key);
  }
});

test("LINE B outlines a box and BF fills it, corners included", () => {
  const raster = new Raster(12, 10);
  raster.box(2, 1, 6, 4, 9);
  const outline = lit(raster);
  assert.equal(outline.size, 14);
  for (const key of ["2,1", "6,1", "2,4", "6,4", "4,1", "2,3"]) assert.ok(outline.has(key), key);
  assert.ok(!outline.has("4,2"));
  raster.clear();
  raster.fillBox(6, 4, 2, 1, 9);
  assert.equal(lit(raster).size, 20);
  raster.clear();
  raster.fillBox(-5, -5, 3, 2, 9);
  assert.equal(lit(raster).size, 12);
});

test("the screen is looked up in the palette, pixel by pixel", () => {
  const raster = new Raster(4, 2);
  raster.pset(1, 0, 15);
  raster.pset(3, 1, 4);
  const palette = new Uint32Array(16).map((_, index) => 1000 + index);
  const out = new Uint32Array(8);
  blit(raster.pixels, palette, out);
  assert.deepEqual([...out], [1000, 1015, 1000, 1000, 1000, 1000, 1000, 1004]);
});

test("every palette has sixteen colours, black first; the default is EGA", () => {
  const ids = new Set<string>();
  for (const palette of PALETTES) {
    assert.equal(palette.colors.length, 16, palette.id);
    assert.equal(palette.colors[0], 0, palette.id);
    for (const color of palette.colors) assert.ok(Number.isInteger(color) && color >= 0 && color <= 0xffffff, `${palette.id} ${color}`);
    assert.ok(!ids.has(palette.id), palette.id);
    ids.add(palette.id);
  }
  for (const id of ["ega", "bw", "cpc", "c64", "amiga", "sms", "nes"]) assert.ok(ids.has(id), id);
  assert.equal(PALETTES[DEFAULT_PALETTE]!.id, "ega");
  assert.deepEqual(PALETTES[DEFAULT_PALETTE]!.colors, [
    0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
    0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff
  ]);
});

test("each machine's palette keeps to the machine's own colours", () => {
  const byId = (id: string): readonly number[] => PALETTES.find((palette) => palette.id === id)!.colors;
  const channels = (color: number): number[] => [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  // The C64: Pepto's sixteen, each once.
  const pepto = [
    0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f,
    0x6f4f25, 0x433900, 0x9a6759, 0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595
  ];
  assert.deepEqual([...byId("c64")].sort((a, b) => a - b), [...pepto].sort((a, b) => a - b));
  // The CPC: 0, 50 and 100 % only.
  for (const color of byId("cpc")) for (const level of channels(color)) assert.ok([0x00, 0x80, 0xff].includes(level), color.toString(16));
  // The Master System: two bits a channel; the TMS9918 modes' fifteen colours all appear.
  for (const color of byId("sms")) for (const level of channels(color)) assert.equal(level % 85, 0, color.toString(16));
  assert.equal(new Set(byId("sms")).size, 15);
  // The Amiga: four bits a channel.
  for (const color of byId("amiga")) for (const level of channels(color)) assert.equal(level % 17, 0, color.toString(16));
  // The NES RGB PPU: eight levels a channel.
  const nesLevels = [0, 1, 2, 3, 4, 5, 6, 7].map((digit) => Math.round((digit * 255) / 7));
  for (const color of byId("nes")) for (const level of channels(color)) assert.ok(nesLevels.includes(level), color.toString(16));
  // Black and white is just that; the monochrome VGA is the BIOS's sum of EGA's colours.
  assert.deepEqual(new Set(byId("bw")), new Set([0x000000, 0xffffff]));
  const ega = byId("ega");
  byId("mono").forEach((color, index) => {
    const [r, g, b] = channels(ega[index]!) as [number, number, number];
    const grey = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    assert.equal(color, (grey << 16) | (grey << 8) | grey);
  });
});

test("a palette packs to RGBA words for either byte order", () => {
  const little = packPalette([0x000000, 0x123456], true);
  assert.equal(little[1], 0xff563412);
  assert.equal(little[0], 0xff000000);
  const big = packPalette([0x000000, 0x123456], false);
  assert.equal(big[1], 0x123456ff);
  assert.equal(little.length, 16);
});

test("the bands are log-spaced from 40 Hz to 16 kHz", () => {
  const edges = bandEdges();
  assert.equal(edges.length, BANDS + 1);
  assert.ok(Math.abs(edges[0]! - LOW_HZ) < 1e-9 && Math.abs(edges[BANDS]! - HIGH_HZ) < 1e-6);
  const ratio = edges[1]! / edges[0]!;
  for (let index = 1; index < edges.length; index += 1) assert.ok(Math.abs(edges[index]! / edges[index - 1]! - ratio) < 1e-9);
});

test("the trigger finds the newest rising zero crossing that came up from below the floor", () => {
  const samples = new Float32Array(1000);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin((2 * Math.PI * (index + 0.5)) / 100);
  // Rising crossings just before 100, 200, 300…; a window of 300 can start at 700 at the latest.
  assert.equal(trigger(samples, 300, 500), 700);
  assert.equal(trigger(samples, 350, 500), 600);
  // Ripples smaller than the floor do not count: the newest window then.
  const quiet = new Float32Array(1000).map((_, index) => 0.001 * Math.sin(index));
  assert.equal(trigger(quiet, 300, 500, 0.01), 700);
});

test("the listener: a tone lights its band, plays at about half against itself, and is brought to ±0.95", () => {
  const analysis = new RetroAnalysis();
  const listener = new Listener();
  const rate = 48000;
  const frame = rate / 60;
  let clock = 0;
  const play = (amplitude: number, hz: number, frames: number): void => {
    for (let count = 0; count < frames; count += 1) {
      analysis.left.copyWithin(0, frame);
      analysis.right.copyWithin(0, frame);
      for (let index = WINDOW - frame; index < WINDOW; index += 1) {
        const value = amplitude * Math.sin((2 * Math.PI * hz * clock) / rate);
        analysis.left[index] = value;
        analysis.right[index] = value;
        clock += 1;
      }
      analysis.update(frame, rate, 1 / 60);
      listener.update(analysis, 1 / 60);
    }
  };
  play(0.5, 1000, 600);
  const edges = bandEdges();
  const band = edges.findIndex((edge, index) => edge <= 1000 && edges[index + 1]! > 1000);
  const strongest = listener.bands.indexOf(Math.max(...listener.bands));
  assert.equal(strongest, band);
  assert.ok(Math.abs(listener.level - 0.5) < 0.08, String(listener.level));
  assert.ok(Math.abs(listener.gain * 0.5 - 0.95) < 0.05, String(listener.gain));
  // Twice as loud: the level climbs towards 1 before the usual catches up.
  play(1, 1000, 6);
  assert.ok(listener.level > 0.75, String(listener.level));
  // Silence: no level, the bands fall away, and the gain stays as it was.
  const gain = listener.gain;
  play(0, 1000, 120);
  assert.equal(Math.round(listener.level * 1000), 0);
  assert.ok(Math.max(...listener.bands) < 0.01);
  assert.equal(listener.gain, gain);
});
