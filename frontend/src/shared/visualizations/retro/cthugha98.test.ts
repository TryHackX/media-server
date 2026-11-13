import assert from "node:assert/strict";
import test from "node:test";

import { IDENTITY, kaleidoMap, present, shownPart } from "./cthughalike/display.ts";
import { LIGHT_LEVELS, FieldRenderer, seal, shadeTable } from "./cthughalike/field3d.ts";
import { burn, flameTable, speckleTable, tapCount, type FlameKernel } from "./cthughalike/flames.ts";
import { BLOCK_HEIGHT, BLOCK_WIDTH, blockChar, blockChars, blockGlyph, spellTitle } from "./cthughalike/font-block.ts";
import { markStrokes, parseStrokes, serifs, strokeChar, strokeChars, strokeGlyph, strokeMarks } from "./cthughalike/font-stroke.ts";
import { BANDS, Listener, SAMPLES } from "./cthughalike/listen.ts";
import { cssFont, findFont, matchesPrint, WINDOWS_FONTS } from "./cthughalike/local-font.ts";
import { brightness, hueCycles, inventPalette, mix, PALETTES, ramp, toWords, word } from "./cthughalike/palettes.ts";
import { PARTICLE_SCENES, Particles, PARTICLES } from "./cthughalike/particles.ts";
import { between, pick, seeded, weighted, whole } from "./cthughalike/random.ts";
import { disc, fillContours, line, lineShaded, makePicture, penStroke, stamp } from "./cthughalike/raster.ts";
import { TABLE_KINDS, TableBuilder, translate } from "./cthughalike/translate.ts";

// Cthugha98 and Cthugha-4-Winamp (retro/cthugha98, retro/cthugha4winamp): the arithmetic of their
// shared engine (retro/cthughalike) without the DOM — flames, translation tables, displays,
// palettes, drawing, the fonts, the 3dfx height field and the listening.

const W = 64;
const H = 48;

test("random: a seed replays exactly; whole, between and weighted stay in their bounds", () => {
  const a = seeded(1998);
  const b = seeded(1998);
  for (let k = 0; k < 100; k += 1) assert.equal(a(), b());
  const random = seeded(7);
  for (let k = 0; k < 1000; k += 1) {
    const n = whole(random, 3, 9);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 9);
    const x = between(random, -2, 5);
    assert.ok(x >= -2 && x < 5);
  }
  // A weight of 0 is never chosen; the others in about their proportion.
  const counts = new Map<string, number>();
  for (let k = 0; k < 4000; k += 1) {
    const item = weighted(random, [["never", 0], ["once", 1], ["thrice", 3]] as const);
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  assert.equal(counts.get("never"), undefined);
  const ratio = (counts.get("thrice") ?? 0) / (counts.get("once") ?? 1);
  assert.ok(ratio > 2.5 && ratio < 3.6, String(ratio));
  assert.equal(pick(random, ["only"]), "only");
});

test("palettes: 256 colours each, black floors, gradients through their stops", () => {
  assert.ok(PALETTES.length >= 40);
  for (const palette of PALETTES) {
    assert.equal(palette.rgb.length, 768, palette.name);
    // Value 0 is what everything burns down to: black, or nearly, in all but the cyclic ones.
    if (!palette.name.startsWith("Boil")) assert.ok(brightness(palette.rgb, 0) < 8, palette.name);
  }
  const grey = ramp([[0, 0x000000], [255, 0xffffff]]);
  assert.deepEqual([...grey.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...grey.subarray(765, 768)], [255, 255, 255]);
  assert.ok(Math.abs(grey[128 * 3]! - 128) <= 1);
  // A cyclic palette comes round to where it started.
  const cycle = hueCycles(40, 2, 0.9, true);
  for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(cycle[channel]! - cycle[765 + channel]!) < 40);
  const random = seeded(3);
  for (let k = 0; k < 50; k += 1) {
    const invented = inventPalette(random);
    assert.equal(invented.rgb.length, 768);
  }
  const half = new Uint8Array(768);
  mix(grey, new Uint8Array(768), 0.5, half);
  assert.ok(Math.abs(half[765]! - 128) <= 1);
});

test("palettes: words are opaque RGBA as a canvas stores them", () => {
  const words = new Int32Array(256);
  toWords(ramp([[0, 0x102030], [255, 0x102030]]), words);
  const bytes = new Uint8Array(words.buffer);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x10, 0x20, 0x30, 255]);
  assert.equal(word(255, 255, 255), -1);
});

test("flames: the tables divide down and fade, boil wraps round, swell rings over", () => {
  const decay = flameTable({ kernel: "rise", rule: "decay", amount: 2 }, 4);
  assert.equal(decay[4 * 100], 98);
  assert.equal(decay[4 * 1], 0);
  assert.equal(decay[0], 0);
  const boil = flameTable({ kernel: "rise", rule: "boil", amount: 3 }, 4);
  assert.equal(boil[4 * 254], 1);
  assert.equal(boil[0], 3);
  const swell = flameTable({ kernel: "haze", rule: "swell", amount: 1 }, 8);
  // Bright parts climb past 255 and come round dark; dim ones die.
  assert.ok(swell[8 * 255]! < 64);
  assert.ok(swell[8 * 200]! > 200);
  assert.equal(swell[8 * 1], 0);
  for (const kernel of ["rise", "riseFast", "fall", "left", "right", "glow", "haze", "streak", "lift", "sway", "climbLeft", "climbRight", "still"] as FlameKernel[]) {
    assert.ok(tapCount(kernel) === 4 || tapCount(kernel) === 8, kernel);
  }
});

test("flames: fire rises and fades, the edges stay dark, the spare zero stays zero", () => {
  const src = new Uint8Array(W * H + 1);
  const dst = new Uint8Array(W * H + 1);
  // A bright bar low in the picture.
  for (let x = 20; x < 44; x += 1) src[40 * W + x] = 240;
  const table = flameTable({ kernel: "rise", rule: "decay", amount: 1 }, 4);
  burn("rise", src, dst, W, H, table, null, 0, 0);
  // It has moved up: the row above holds it now, its own row less.
  assert.ok(dst[39 * W + 32]! > 100);
  assert.ok(dst[39 * W + 32]! < 240);
  for (let y = 0; y < H; y += 1) {
    assert.equal(dst[y * W], 0);
    assert.equal(dst[y * W + W - 1], 0);
  }
  assert.equal(dst[W * H], 0);
  // Burning on, the total only falls.
  let before = src.reduce((sum, value) => sum + value, 0);
  let a = src;
  let b = dst;
  const speckle = speckleTable(seeded(5), 4);
  for (const kernel of ["rise", "glow", "haze", "sway", "still", "left"] as FlameKernel[]) {
    const kernelTable = flameTable({ kernel, rule: "decay", amount: 1 }, tapCount(kernel));
    burn(kernel, a, b, W, H, kernelTable, kernel === "glow" ? speckle : null, 77, 1.5);
    const after = b.reduce((sum, value) => sum + value, 0);
    assert.ok(after <= before, `${kernel}: ${after} > ${before}`);
    before = after;
    [a, b] = [b, a];
  }
});

test("translation tables: every kind is whole and points inside or at the zero after the end", () => {
  for (const kind of TABLE_KINDS) {
    const builder = new TableBuilder({ kind, strength: 1.2, turn: -1, seed: 1234 }, W, H);
    let slices = 0;
    while (!builder.advance(7)) slices += 1;
    assert.ok(slices >= 5, kind);
    for (const index of builder.table) assert.ok(index >= 0 && index <= W * H, `${kind}: ${index}`);
    // Most pixels come from inside the picture.
    const inside = builder.table.filter((index) => index < W * H).length;
    assert.ok(inside > W * H * 0.6, kind);
  }
});

test("translation tables: a zoom keeps its centre and carries a point outwards", () => {
  const width = 200;
  const height = 150;
  const builder = new TableBuilder({ kind: "zoom", strength: 1, turn: 1, seed: 1 }, width, height);
  while (!builder.advance(50));
  const centre = 75 * width + 100;
  assert.equal(builder.table[centre], centre);
  let src = new Uint8Array(width * height + 1);
  let dst = new Uint8Array(width * height + 1);
  src[75 * width + 160] = 255;
  for (let step = 0; step < 10; step += 1) {
    translate(src, dst, builder.table);
    [src, dst] = [dst, src];
  }
  let x = -1;
  for (let index = 0; index < width * height; index += 1) if (src[index] === 255) x = index % width;
  assert.ok(x > 160, String(x));
  assert.equal(src[width * height], 0);
});

test("displays: mirrors and the kaleidoscope are symmetric, plain is as it is", () => {
  const random = seeded(11);
  const picture = new Uint8Array(W * H + 1);
  for (let index = 0; index < W * H; index += 1) picture[index] = Math.floor(random() * 256);
  const out = new Uint8Array(W * H);
  present("normal", picture, W, H, IDENTITY, out, null);
  assert.deepEqual(out, picture.subarray(0, W * H));
  present("mirror", picture, W, H, IDENTITY, out, null);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) assert.equal(out[y * W + x], out[y * W + W - 1 - x]);
  present("quad", picture, W, H, IDENTITY, out, null);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      assert.equal(out[y * W + x], out[(H - 1 - y) * W + x]);
      assert.equal(out[y * W + x], out[y * W + W - 1 - x]);
    }
  }
  present("mirrorFlip", picture, W, H, IDENTITY, out, null);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W / 2; x += 1) assert.equal(out[y * W + x], out[(H - 1 - y) * W + W - 1 - x]);
  present("kaleido", picture, W, H, IDENTITY, out, kaleidoMap(W, H));
  // Across the diagonals of the square about the centre, too.
  const half = H / 2;
  for (let dy = 0; dy < half; dy += 1) {
    for (let dx = 0; dx < half; dx += 1) {
      const at = (dy2: number, dx2: number): number => out[(half + dy2) * W + W / 2 + dx2]!;
      assert.equal(at(dy, dx), at(dx, dy));
      assert.equal(at(dy, dx), at(-1 - dy, dx));
      assert.equal(at(dy, dx), at(dy, -1 - dx));
    }
  }
  assert.deepEqual(shownPart("quad"), { right: false, bottom: false });
  assert.deepEqual(shownPart("normal"), { right: true, bottom: true });
});

test("drawing: lines reach both ends, outlines fill around their holes, pens are soft", () => {
  const picture = makePicture(W, H);
  line(picture, 3, 4, 40, 30, 200);
  assert.equal(picture.data[4 * W + 3], 200);
  assert.equal(picture.data[30 * W + 40], 200);
  lineShaded(picture, 0, 0, 10, 0, 10, 110);
  assert.equal(picture.data[0], 10);
  assert.equal(picture.data[10], 110);
  // A line far outside does nothing (and does not hang).
  line(picture, -1e9, -1e9, 1e9, -1e9, 255);
  const square = makePicture(W, H);
  fillContours(square, [[10, 10, 50, 10, 50, 40, 10, 40], [20, 20, 40, 20, 40, 30, 20, 30]], 99);
  assert.equal(square.data[15 * W + 15], 99);
  assert.equal(square.data[25 * W + 30], 0);
  assert.equal(square.data[5 * W + 5], 0);
  const round = makePicture(W, H);
  disc(round, 32, 24, 10, 7);
  const area = round.data.filter((value) => value === 7).length;
  assert.ok(Math.abs(area - Math.PI * 100) < 25, String(area));
  const mask = new Uint8Array(W * H);
  penStroke(mask, W, H, 10, 10, 50, 10, 3);
  assert.equal(mask[10 * W + 30], 255);
  assert.equal(mask[20 * W + 30], 0);
  const stamped = makePicture(W, H);
  stamped.data[10 * W + 30] = 250;
  stamp(stamped, mask, W, H, 0, 0, 100);
  assert.equal(stamped.data[10 * W + 30], 250);
  assert.equal(stamped.data[10 * W + 20], 100);
});

test("block font: every capital and digit, closed outlines on the grid, titles spelt in capitals", () => {
  const chars = blockChars();
  for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") assert.ok(chars.includes(char), char);
  for (const char of chars) {
    const contours = blockGlyph(char)!;
    assert.ok(contours.length >= 1, char);
    for (const contour of contours) {
      assert.ok(contour.length >= 6 && contour.length % 2 === 0, `${char}: ${contour.length}`);
      for (let k = 0; k < contour.length; k += 2) {
        assert.ok(contour[k]! >= -0.5 && contour[k]! <= BLOCK_WIDTH + 1.1, `${char} x ${contour[k]}`);
        assert.ok(contour[k + 1]! >= -1.1 && contour[k + 1]! <= BLOCK_HEIGHT, `${char} y ${contour[k + 1]}`);
      }
    }
  }
  assert.equal(blockChar("ą"), "A");
  assert.equal(blockChar("ł"), "L");
  assert.equal(blockChar("é"), "E");
  assert.equal(blockChar(" "), null);
  assert.deepEqual(spellTitle("Breathe — The Prodigy", 14), [..."BREATHE"]);
  assert.deepEqual(spellTitle("Zażółć gęślą jaźń — Ktoś", 6), [..."ZAZOLC"]);
  assert.equal(spellTitle("Under Sea Disturbances — Drexciya", 14).length, 14);
  assert.deepEqual(spellTitle("", 14), []);
});

test("stroke font: every glyph parses, accents map, slab serifs sit on the lines", () => {
  for (const char of strokeChars()) {
    const glyph = strokeGlyph(char)!;
    assert.ok(glyph.strokes.length >= 1, char);
    assert.ok(glyph.right >= glyph.left, char);
    for (const stroke of glyph.strokes) {
      for (const value of stroke) assert.ok(Number.isFinite(value) && value > -4 && value < 12, `${char}: ${value}`);
    }
  }
  for (const char of "AaZz09") assert.ok(strokeGlyph(char), char);
  assert.equal(strokeChar("ż"), "z");
  assert.equal(strokeChar("Ł"), "L");
  assert.equal(strokeChar("€"), null);
  const arc = parseStrokes("M 0 0 L 1 0 A 2 0 1 1 180 0");
  assert.equal(arc.length, 1);
  const bars = serifs(strokeGlyph("I")!, 1.3);
  assert.equal(bars.length, 2);
  assert.deepEqual([...bars.map((bar) => bar[1])].sort(), [0, 10]);
  // A slanting tail gets no serif.
  assert.ok(serifs(strokeGlyph("y")!, 1.3).every((bar) => bar[1] !== -3));
});

test("stroke font: Polish (and other) accents are drawn, above and below", () => {
  assert.deepEqual(strokeMarks("ą"), ["\u0328"]);
  assert.deepEqual(strokeMarks("ż"), ["\u0307"]);
  assert.deepEqual(strokeMarks("ó"), ["\u0301"]);
  assert.deepEqual(strokeMarks("ł"), ["bar"]);
  assert.deepEqual(strokeMarks("a"), []);
  for (const char of "ąćęłńóśźżÄÉÑÇÅŠ") {
    const glyph = strokeGlyph(char)!;
    const marks = strokeMarks(char);
    assert.ok(marks.length >= 1, char);
    for (const mark of marks) assert.ok(markStrokes(mark, glyph.left, glyph.right, 7).length >= 1, `${char} ${mark}`);
  }
  // An acute sits above the x-height, an ogonek below the baseline.
  const acute = markStrokes("\u0301", 0, 6, 7)[0]!;
  assert.ok(Math.min(acute[1]!, acute[3]!) > 7);
  const ogonek = markStrokes("\u0328", 0, 6, 7)[0]!;
  assert.ok(Math.min(...[1, 3, 5, 7].map((k) => ogonek[k]!)) < 0);
});

test("3dfx field: light levels shade the palette; a lit plateau comes out whole", () => {
  const rgb = ramp([[0, 0x000000], [255, 0x80c0ff]]);
  const shades = new Int32Array(LIGHT_LEVELS * 256);
  shadeTable(rgb, shades);
  const bytes = new Uint8Array(shades.buffer);
  // Level 0 is black, level 20 the colour itself, the top washed towards white.
  assert.deepEqual([...bytes.subarray(255 * 4, 255 * 4 + 3)], [0, 0, 0]);
  assert.deepEqual([...bytes.subarray((20 * 256 + 255) * 4, (20 * 256 + 255) * 4 + 3)], [0x80, 0xc0, 0xff]);
  assert.ok(bytes[((LIGHT_LEVELS - 1) * 256 + 255) * 4]! > 0x80);

  const width = 160;
  const height = 120;
  const picture = new Uint8Array(width * height + 1);
  for (let y = 30; y < 90; y += 1) for (let x = 40; x < 120; x += 1) picture[y * width + x] = 200;
  const field = new FieldRenderer(40, 30);
  field.setPalette(rgb);
  field.sample(picture, width, height);
  const pixels = new Int32Array(320 * 240);
  const background = word(0, 0, 0);
  const camera = { yaw: 0.4, pitch: 0.9, distance: 3.2, lift: 0.4, focal: 200 * 3.2 / 2, centreX: 160, centreY: 125 };
  field.mesh(camera, { pixels, width: 320, height: 240 }, width / height, background);
  // The plateau's top, seen from above, is drawn without holes around the middle.
  let drawn = 0;
  for (let y = 105; y < 135; y += 1) for (let x = 140; x < 180; x += 1) if (pixels[y * 320 + x] !== background) drawn += 1;
  assert.equal(drawn, 30 * 40);
  // Nothing is left unpainted: the background is opaque black.
  for (const value of pixels) assert.notEqual(value, 0);
  const cloud = new Int32Array(320 * 240).fill(background);
  const words = new Int32Array(256);
  toWords(rgb, words);
  field.points(picture, width, height, 2, camera, { pixels: cloud, width: 320, height: 240 }, width / height, words, background);
  assert.ok(cloud.some((value) => value !== background));
});

test("3dfx field: the seal fills a pinhole and leaves the edge of the landscape", () => {
  const pixels = new Int32Array(8 * 8);
  const colour = word(200, 100, 50);
  for (let y = 2; y < 6; y += 1) for (let x = 0; x < 8; x += 1) pixels[y * 8 + x] = colour;
  pixels[3 * 8 + 4] = 0;
  const background = word(0, 0, 0);
  seal({ pixels, width: 8, height: 8 }, background, 0, 7, 0, 7);
  assert.equal(pixels[3 * 8 + 4], colour);
  assert.equal(pixels[6 * 8 + 4], background);
  assert.equal(pixels[1 * 8 + 4], background);
});

/** A RetroAudio of a sine in both channels at `level`. */
function sine(level: number): Parameters<Listener["hear"]>[0] {
  const left = new Float32Array(8192);
  for (let index = 0; index < left.length; index += 1) left[index] = level * Math.sin(index * 0.05);
  return {
    rate: 48000, left, right: left, mono: left, fresh: 800, spectrum: new Float32Array(1024).fill(0.6), binHz: 23.4,
    rmsLeft: level * 0.707, rmsRight: level * 0.707, peakLeft: level, peakRight: level,
    beat: 0, onset: false, sounding: level > 0, silence: level > 0 ? 0 : 3
  };
}

test("listening: a quiet track is brought up, the samples stay in a soft knee, bands 0–1", () => {
  const listener = new Listener();
  for (let k = 0; k < 300; k += 1) listener.hear(sine(0.05), 1 / 60);
  assert.ok(listener.gain > 3, String(listener.gain));
  assert.equal(listener.left.length, SAMPLES);
  let peak = 0;
  for (const value of listener.mono) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak > 0.2 && peak < 4, String(peak));
  assert.equal(listener.bands.length, BANDS);
  for (const value of listener.bands) assert.ok(value >= 0 && value <= 1);
  // Silence is left silent.
  for (let k = 0; k < 120; k += 1) listener.hear(sine(0), 1 / 60);
  assert.ok(listener.mono.every((value) => value === 0));
});

test("listening: kicks are heard in the bass and kept until a step takes them", () => {
  // Ten seconds of a 55 Hz kick twice a second over a quiet hum, fed a frame (800 samples) at a time.
  const rate = 48000;
  const total = rate * 10;
  const signal = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    const t = index / rate;
    const inBeat = t % 0.5;
    signal[index] = 0.6 * Math.exp(-inBeat * 18) * Math.sin(2 * Math.PI * 55 * inBeat) + 0.02 * Math.sin(2 * Math.PI * 880 * t);
  }
  const listener = new Listener();
  const window = new Float32Array(8192);
  let kicks = 0;
  for (let frame = 0; frame < total / 800; frame += 1) {
    const end = (frame + 1) * 800;
    for (let index = 0; index < 8192; index += 1) window[index] = signal[end - 8192 + index] ?? 0;
    const audio = { ...sine(0.3), left: window, right: window, mono: window, fresh: 800, rmsLeft: 0.2, rmsRight: 0.2 };
    listener.hear(audio, 1 / 60);
    // A step every other frame takes what came since the last one.
    if (frame % 2 === 1) kicks += listener.takeKicks();
  }
  assert.ok(kicks >= 17 && kicks <= 21, String(kicks));
  assert.equal(listener.takeKicks(), 0);
});

test("particles: every scene keeps its points finite and draws only inside the picture", () => {
  const listener = new Listener();
  listener.hear(sine(0.3), 1 / 30);
  for (const scene of PARTICLE_SCENES) {
    const particles = new Particles(W * 4, H * 4, seeded(9));
    particles.begin(scene);
    const picture = makePicture(W * 4, H * 4);
    for (let step = 0; step < 90; step += 1) {
      particles.step(listener, step / 30);
      particles.draw(picture, 255);
    }
    for (let k = 0; k < PARTICLES; k += 1) {
      assert.ok(Number.isFinite(particles.x[k]!) && Number.isFinite(particles.y[k]!), `${scene} ${k}`);
    }
    assert.ok(picture.data.some((value) => value > 0), scene);
    assert.equal(picture.data[W * 4 * H * 4], 0, scene);
  }
});

test("a Windows font counts as the viewer's own only when its widths and its capital are the real font's", () => {
  const arial = WINDOWS_FONTS["Arial"];
  // At 200 px: Arial's sample is 2256.2 px wide and its H 143.2 px high.
  assert.ok(matchesPrint(arial, 2256.2, 143.2));
  assert.ok(matchesPrint(arial, 2260, 141));
  // A face with Arial's widths but a lower capital (a metric twin), a font with other widths
  // (Android answers "Arial" with Roboto), and the monospace fallback of a missing font: no.
  assert.equal(matchesPrint(arial, 2256.2, 137.6), false);
  assert.equal(matchesPrint(arial, 2210, 142), false);
  assert.equal(matchesPrint(arial, 22 * 0.6 * 200, 0.57 * 200), false);
  // Courier New's fallback is a proportional face, since every monospace font is 600 units wide.
  assert.equal(cssFont(WINDOWS_FONTS["Courier New"], 40), '40px "Courier New", serif');
  assert.equal(matchesPrint(WINDOWS_FONTS["Courier New"], 2640, 114.2), true);
  assert.equal(matchesPrint(WINDOWS_FONTS["Courier New"], 2640, 140), false);
  // findFont measures the sample and the H in the family, then the generic face unlike it.
  const asked: string[] = [];
  const measure = (font: string, text: string): { width: number; ascent: number } => {
    asked.push(`${font}|${text}`);
    return text === "H" ? { width: 144, ascent: 132.4 } : { width: 2116.4, ascent: 140 };
  };
  assert.ok(findFont(WINDOWS_FONTS["Times New Roman"], measure));
  assert.deepEqual(asked, ['200px "Times New Roman", monospace|Hamburgefontsiv WM 0.9', '200px "Times New Roman", monospace|H']);
});
