import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// avsDraw.ts and its neighbours import without extensions (lodash-es by file too), and some have
// enums: resolved and transformed here (tests only), then loaded.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
      if (!specifier.startsWith(".") && !specifier.endsWith(".js")) return next(`${specifier}.js`, context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.endsWith(".test.ts")) {
      // webgl/Buffer.ts imports the type TypedArray with its values (a bundler drops it).
      const source = readFileSync(fileURLToPath(url), "utf8").replace("import { isTypedArray, TypedArray } from", "import { isTypedArray } from");
      return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform" }), shortCircuit: true };
    }
    return next(url, context);
  }
});

const draw = await import("./avsDraw.ts");

/** A seeded generator (mulberry32), so a failure names its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A WebGL context that accepts everything and draws nothing: the plotter's lists and records only. */
function fakeRctx(): unknown {
  const extension = { MAX_EXT: 0x8008, MIN_EXT: 0x8007, vertexAttribDivisorANGLE() {}, drawArraysInstancedANGLE() {} };
  const gl = new Proxy({}, {
    get(_target, property) {
      if (property === "getShaderParameter" || property === "getProgramParameter") return () => true;
      if (property === "getExtension") return () => extension;
      if (property === "getParameter") return () => null;
      // highp in fragment shaders, as on the GPUs the rectangles are for (avsDraw.ts fragmentHighp)
      if (property === "getShaderPrecisionFormat") return () => ({ rangeMin: 127, rangeMax: 127, precision: 23 });
      if (typeof property === "string" && /^[A-Z][A-Z_0-9]*$/.test(property)) return 1;
      return () => ({});
    }
  });
  return { getGl: () => gl };
}

/** A line's pixels from a plotter that records them (offsets y · width + x, in order). */
function recordPixels(fast: boolean, width: number, line: number[], lw: number): number[] {
  const pixels: number[] = [];
  const plotter = {
    fast,
    plotRun(offset: number, count: number, step: number) {
      for (let k = 0; k < count; k++) pixels.push(offset + k * step);
    },
    rect(x: number, y: number, w: number, h: number) {
      // avsLine's rectangles: whole numbers, at least a pixel, inside the frame
      for (const value of [x, y, w, h]) assert.ok(Number.isInteger(value));
      assert.ok(w >= 1 && h >= 1 && x >= 0 && y >= 0 && x + w <= width && y + h <= line[4]!);
      for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) pixels.push(row * width + column);
    },
    plot(offset: number) {
      pixels.push(offset);
    }
  };
  const [x1, y1, x2, y2, height] = line;
  (fast ? draw.avsLine : draw.avsLinePixels)(plotter, x1!, y1!, x2!, y2!, width, height!, 0xffffff, lw);
  return pixels;
}

test("avsLine writes linedraw.cpp's pixels (avsLinePixels), each once, inside the frame", () => {
  const random = generator(20261110);
  const pick = (values: number[]) => values[Math.floor(random() * values.length)]!;
  let lines = 0;
  let pixels = 0;
  const marks = new Int8Array(1280 * 720);
  for (let k = 0; k < 20000; k++) {
    const width = pick([1, 2, 3, 17, 64, 100, 320, 1280]);
    const height = pick([1, 2, 5, 31, 48, 180, 720]);
    const coordinate = (size: number) => {
      const r = random();
      if (r < 0.04) return pick([-1000000, 1000000, -2147483647, 2147483647]);
      if (r < 0.25) return Math.floor(random() * 7) - 3 + pick([0, size - 1, size, size + 1, -1]);
      return Math.floor(random() * (size * 3)) - size;
    };
    const x1 = coordinate(width);
    const y1 = random() < 0.1 ? coordinate(height) : coordinate(height);
    const x2 = random() < 0.1 ? x1 : coordinate(width);
    const y2 = random() < 0.1 ? y1 : coordinate(height);
    const lw = pick([-3, 0, 1, 1, 2, 2, 3, 4, 7, 16, 50, 255, 256, 300]);
    const before = recordPixels(false, width, [x1, y1, x2, y2, height], lw);
    const after = recordPixels(true, width, [x1, y1, x2, y2, height], lw);
    const where = `line (${x1}, ${y1})–(${x2}, ${y2}) lw ${lw} on ${width}×${height}`;
    // The same pixels, each once in both (linedraw.cpp never writes a pixel twice either).
    assert.equal(after.length, before.length, where);
    for (const offset of before) {
      assert.ok(offset >= 0 && offset < width * height && marks[offset] === 0, `before: ${where}`);
      marks[offset] = 1;
    }
    for (const offset of after) {
      assert.ok(offset >= 0 && offset < width * height && marks[offset] === 1, `after: ${where}`);
      marks[offset] = 0;
    }
    lines += 1;
    pixels += after.length;
  }
  assert.ok(lines === 20000 && pixels > 100000);
});

/** What a sequence of writes leaves at each pixel: its colours in order. */
function writesByPixel(offsets: ArrayLike<number>, values: ArrayLike<number>, count: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const list = out.get(offsets[i]!) ?? [];
    list.push(values[i]!);
    out.set(offsets[i]!, list);
  }
  return out;
}

test("the plotter's rectangles hold every pixel's writes in order, as the pixel lists do", () => {
  const random = generator(7);
  const plotter = new draw.AvsPlotter(fakeRctx()) as any;
  for (let round = 0; round < 3000; round++) {
    const width = 1 + Math.floor(random() * 90);
    const height = 1 + Math.floor(random() * 60);
    const colors = [0x000000, 0xffffff, 0x123456, 0xff0000, Math.floor(random() * 0x1000000)];
    const steps: (() => void)[] = [];
    const count = Math.floor(random() * 40);
    for (let k = 0; k < count; k++) {
      const color = colors[Math.floor(random() * colors.length)]!;
      const r = random();
      if (r < 0.35) {
        const x = Math.floor(random() * width);
        const y = Math.floor(random() * height);
        // dots side by side in a colour (Dot Grid, FyrewurX's blocks): joined into rectangles
        const run = 1 + Math.floor(random() * 6);
        steps.push(() => { for (let j = 0; j < run; j++) plotter.plot(y * width + x + j, color); });
      } else if (r < 0.45) {
        const offset = Math.floor(random() * (width * height + 20)) - 10;
        const step = random() < 0.5 ? 1 : width;
        const n = Math.floor(random() * 8);
        steps.push(() => plotter.plotRun(offset, n, step, color));
      } else if (r < 0.55) {
        const x = Math.floor(random() * width * 1.5) - 5;
        const y = Math.floor(random() * height * 1.5) - 5;
        const w = Math.floor(random() * 6);
        const h = Math.floor(random() * 6);
        steps.push(() => plotter.span(x, y, w, h, color));
      } else {
        const line = [0, 1, 2, 3].map((i) => Math.floor(random() * (i % 2 ? height : width) * 1.6) - Math.floor((i % 2 ? height : width) * 0.3));
        const lw = [1, 1, 2, 3, 5, 12][Math.floor(random() * 6)]!;
        steps.push(() => draw.avsLine(plotter, line[0]!, line[1]!, line[2]!, line[3]!, width, height, color, lw));
      }
    }
    (globalThis as { __avsPlotterFast?: boolean }).__avsPlotterFast = false;
    plotter.begin(width, height);
    assert.equal(plotter.fast, false);
    steps.forEach((step) => step());
    const before = writesByPixel(plotter.offsets, plotter.values, plotter.count);
    delete (globalThis as { __avsPlotterFast?: boolean }).__avsPlotterFast;
    plotter.begin(width, height);
    assert.equal(plotter.fast, true);
    steps.forEach((step) => step());
    const rects = plotter.rects;
    const writes = plotter.writes;
    plotter.expand(rects, writes);
    assert.equal(plotter.count, writes);
    const after = writesByPixel(plotter.offsets, plotter.values, plotter.count);
    assert.deepEqual(after, before, `round ${round}`);
    for (let k = 0; k < rects; k++) {
      const [x, y, w, h] = plotter.rect16.subarray(k * 6, k * 6 + 4);
      assert.ok(w > 0 && h > 0 && x + w <= width && y + h <= height, `round ${round}: rectangle ${k} outside the frame`);
    }
  }
});

test("a wide x-major line is a handful of rectangles, not a column each", () => {
  const plotter = new draw.AvsPlotter(fakeRctx()) as any;
  plotter.begin(1280, 720);
  draw.avsLine(plotter, 10, 100, 1200, 160, 1280, 720, 0xabcdef, 8);
  assert.equal(plotter.writes, 1190 * 8);
  assert.equal(plotter.rects, 61);
});

test("blendRectsCpu blends each write as blendLineCpu does, channel by channel, alpha 1", () => {
  const random = generator(99);
  const width = 23;
  const height = 17;
  for (let round = 0; round < 400; round++) {
    const mode = round % 10;
    const adjust = Math.floor(random() * 256);
    const frame = new Uint32Array(width * height);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.floor(random() * 2 ** 32);
    const n = 1 + Math.floor(random() * 30);
    const bytes = new ArrayBuffer(n * 12);
    const r16 = new Uint16Array(bytes);
    const r32 = new Uint32Array(bytes);
    for (let k = 0; k < n; k++) {
      const x = Math.floor(random() * width);
      const y = Math.floor(random() * height);
      r16[k * 6] = x;
      r16[k * 6 + 1] = y;
      r16[k * 6 + 2] = 1 + Math.floor(random() * (width - x));
      r16[k * 6 + 3] = 1 + Math.floor(random() * (height - y));
      // colours that find the table's twelve corrected products too
      r32[k * 3 + 2] = random() < 0.3 ? [147, 171, 155, 187, 195, 85, 170, 153][Math.floor(random() * 8)]! * 0x10101 : Math.floor(random() * 0x1000000);
    }
    const expected = frame.slice();
    let [x0, y0, x1, y1] = [width, height, 0, 0];
    for (let k = 0; k < n; k++) {
      const [x, y, w, h] = r16.subarray(k * 6, k * 6 + 4) as unknown as number[];
      x0 = Math.min(x0, x!); y0 = Math.min(y0, y!); x1 = Math.max(x1, x! + w!); y1 = Math.max(y1, y! + h!);
      const color = r32[k * 3 + 2]!;
      for (let row = y!; row < y! + h!; row++) {
        for (let column = x!; column < x! + w!; column++) {
          const d = expected[row * width + column]!;
          const channel = (shift: number, sourceShift: number) =>
            draw.blendLineCpu(mode, (d >>> shift) & 255, (color >>> sourceShift) & 255, adjust) << shift;
          expected[row * width + column] = (channel(0, 16) | channel(8, 8) | channel(16, 0) | 0xff000000) >>> 0;
        }
      }
    }
    const bounds = draw.blendRectsCpu(frame, width, height, r16, r32, n, mode, adjust);
    assert.deepEqual(frame, expected, `mode ${mode} adjust ${adjust} round ${round}`);
    assert.deepEqual([...bounds], [x0, y0, x1, y1]);
  }
});

test("expandCounted counts each write's place among its pixel's writes as flushPixels does", () => {
  const random = generator(31);
  const plotter = new draw.AvsPlotter(fakeRctx()) as any;
  for (let round = 0; round < 500; round++) {
    const width = 1 + Math.floor(random() * 40);
    const height = 1 + Math.floor(random() * 30);
    plotter.begin(width, height);
    const count = Math.floor(random() * 30);
    for (let k = 0; k < count; k++) {
      const line = [0, 1, 2, 3].map((i) => Math.floor(random() * (i % 2 ? height : width) * 1.4) - 2);
      draw.avsLine(plotter, line[0]!, line[1]!, line[2]!, line[3]!, width, height, k % 3 === 0 ? 0x10101 : Math.floor(random() * 0x1000000), 1 + Math.floor(random() * 6));
    }
    const writes = plotter.writes;
    const passes = plotter.expandCounted(plotter.rects, writes);
    assert.equal(plotter.count, writes);
    const before = new Map<number, number>();
    let most = 0;
    for (let i = 0; i < writes; i++) {
      const o = plotter.offsets[i];
      const n = before.get(o) ?? 0;
      assert.equal(plotter.pass[i], n, `round ${round} write ${i}`);
      before.set(o, n + 1);
      most = Math.max(most, n + 1);
    }
    assert.equal(passes, most);
    for (let o = 0; o < width * height; o++) {
      assert.equal(plotter.seen[o], (before.get(o) ?? 0) - 1);
      plotter.seen[o] = -1;
    }
    plotter.count = 0;
  }
});
