import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { outlineOf, type Outline } from "./voltviz/outline.ts";

// impl/Icons.ts (vendored voltviz) imports its neighbours without extensions: resolved here
// (tests only), then loaded.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
      throw error;
    }
  }
});

const { ICON_POOL, parseIcon } = await import("./voltviz/visualizers/impl/Icons.ts");

const outline = (tag: string, attributes: Record<string, string>): Outline => {
  const measured = outlineOf(tag, attributes);
  assert.ok(measured, `${tag} has an outline`);
  return measured;
};

/** The points upstream samples: 300…3000 + 1 along the length (Icons.tsx, parseSVGString). */
function samples(measured: Outline): { x: number; y: number }[] {
  const length = measured.getTotalLength();
  const count = Math.min(3000, Math.max(300, Math.floor(length)));
  return Array.from({ length: count + 1 }, (_, i) => measured.getPointAtLength((i / count) * length));
}

const near = (actual: number, expected: number, tolerance: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);
};

test("lines and circles are measured as Chrome measures them", () => {
  const line = outline("line", { x1: "22", y1: "12", x2: "18", y2: "12" });
  assert.equal(line.getTotalLength(), 4);
  assert.deepEqual(samples(line)[77], { x: 20.97333335876465, y: 12 });
  // Skia's oval: four conics from the right, clockwise, flat within half a unit — a circle of
  // radius 2 measures as the square through its quarter points (8√2, not 4π)
  const lengths: [string, number][] = [["10", 62.426971435546875], ["6", 36.737606048583984], ["2", 11.313708305358887]];
  for (const [r, length] of lengths) assert.equal(outline("circle", { cx: "12", cy: "12", r }).getTotalLength(), length, `r = ${r}`);
  const circle = samples(outline("circle", { cx: "12", cy: "12", r: "10" }));
  assert.deepEqual(circle[0], { x: 22, y: 12 });
  assert.deepEqual(circle[77], { x: 11.60427474975586, y: 21.99216651916504 });
  assert.deepEqual(circle[150], { x: 1.9999990463256836, y: 12 });
  assert.deepEqual(circle[300], { x: 22, y: 12 });
  const small = samples(outline("circle", { cx: "12", cy: "8", r: "2" }));
  assert.deepEqual(small[77], { x: 11.924009323120117, y: 9.998556137084961 });
  assert.equal(outline("circle", { cx: "12", cy: "12", r: "0" }).getTotalLength(), 0);
  assert.equal(outlineOf("rect", { x: "1", y: "1", width: "2", height: "2" }), null);
});

test("paths are measured as Chrome's SVGPathQuery measures them", () => {
  // lengths and points Chrome 157 gives for lucide's paths (getTotalLength, getPointAtLength)
  const cases: [string, number, [number, number, number][]][] = [
    ["M14 13.12c0 2.38 0 6.38-1 8.88", 8.983869552612305,
      [[0, 14, 13.119999885559082], [150, 13.867568969726562, 17.608686447143555], [300, 13, 22]]],
    ["M17.29 21.02c.12-.6.43-2.3.5-3.02", 3.0618555545806885,
      [[0, 17.290000915527344, 21.020000457763672], [150, 17.565723419189453, 19.51414680480957]]],
    ["M10.268 21a2 2 0 0 0 3.464 0", 4.188649654388428,
      [[150, 12, 21.99991226196289], [77, 11.024330139160156, 21.745769500732422]]],
    ["M2 12a10 10 0 0 1 18-6", 24.981800079345703,
      [[150, 8.837723731994629, 2.513167381286621], [300, 20.000003814697266, 6.000004291534424]]],
    ["M12 22c4.2 0 7-1.667 7-5-4.2 0-7 1.667-7 5Z", 19.406787872314453,
      [[150, 18.999998092651367, 17], [77, 16.804046630859375, 20.922344207763672], [300, 12, 22]]],
    ["M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5", 59.038108825683594,
      [[0, 2, 9.5], [150, 21.5956974029541, 11.514430046081543], [77, 13.124528884887695, 5.151693344116211], [300, 2, 9.5]]],
    // several subpaths: a point exactly where one ends is that one's end
    ["M12 5a3 3 0 1 1 3 3m-3-3a3 3 0 1 0-3 3m3-3v1M9 8a3 3 0 1 0 3 3M9 8h1m5 0a3 3 0 1 1-3 3m3-3h-1m-2 3v-1", 60.55665969848633,
      [[0, 12, 5], [150, 8.01828384399414, 8.16431713104248], [77, 11.678234100341797, 3.6468937397003174], [300, 12, 10]]]
  ];
  for (const [d, length, points] of cases) {
    const measured = outline("path", { d });
    assert.equal(measured.getTotalLength(), length, d);
    const sampled = samples(measured);
    // the last float bits of an arc's sin/cos/tan may differ from the C library's
    for (const [i, x, y] of points) {
      near(sampled[i]!.x, x, 2e-5, `${d} #${i} x`);
      near(sampled[i]!.y, y, 2e-5, `${d} #${i} y`);
    }
  }
});

test("path data is read as the browser reads it", () => {
  const length = (d: string): number => outline("path", { d }).getTotalLength();
  assert.equal(length("M0 0h10v10H0z"), 40);
  assert.equal(length("m0 0 10 0 0 10"), 20, "numbers after a move are lines");
  assert.equal(length("M0 0L10 0 10 10"), 20);
  assert.equal(length("M0 0h1M5 5h2"), 3);
  assert.equal(length("M0 0L10 0L"), 10, "bad data ends the path");
  assert.equal(length("L10 0"), 0, "a path starts with a move");
  // compact numbers and arc flags: ".5.5" is two numbers, "1010" two flags and a 10
  assert.equal(length("M0 0h.5.5"), 1);
  assert.equal(length("M0 0a5 5 0 1010 0"), length("M0 0a5 5 0 1 0 10 0"), "glued arc flags");
  // a half circle as Blink's two cubics: a little longer than π·r (Chrome: 31.42034912109375 for r = 10)
  assert.equal(length("M2 12a10 10 0 0 1 20 0"), 31.42034912109375);
  near(length("M0 0a5 5 0 1 0 10 0"), Math.PI * 5, 5e-3, "a half circle");
  near(length("M0 0Q5 10 10 0T20 0"), length("M0 0Q5 10 10 0") * 2, 1e-5, "a smooth quadratic reflects its control point");
  near(length("M0 0C0 5 5 5 5 0S10 -5 10 0"), length("M0 0C0 5 5 5 5 0") * 2, 1e-5, "a smooth cubic reflects its control point");
  // a point exactly where a subpath ends belongs to it; past that, to the next one
  const split = outline("path", { d: "M0 0h1M5 5h2" });
  assert.deepEqual(split.getPointAtLength(1), { x: 1, y: 0 });
  assert.deepEqual(split.getPointAtLength(1.5), { x: 5.5, y: 5 });
  assert.deepEqual(split.getPointAtLength(99), { x: 7, y: 5 });
  assert.deepEqual(split.getPointAtLength(-1), { x: 0, y: 0 });
});

// What upstream draws for each icon in Chrome 157: its subpaths and how many of them are closed
// (voltviz's parseSVGString over Chrome's own getPointAtLength).
const CHROME: [string, number, number][] = [
  ["Heart", 1, 1], ["Star", 1, 1], ["Music", 3, 2], ["Zap", 1, 1], ["Flame", 1, 1], ["Crown", 2, 1],
  ["Diamond", 1, 1], ["Skull", 4, 4], ["Ghost", 3, 1], ["Rocket", 4, 2], ["Atom", 3, 3], ["Brain", 8, 0],
  ["Bug", 11, 1], ["Camera", 2, 2], ["Cloud", 1, 1], ["Coffee", 4, 0], ["Compass", 2, 2], ["Crosshair", 5, 1],
  ["Flower", 12, 3], ["Gamepad", 5, 3], ["Globe", 3, 2], ["Headphones", 1, 0], ["Hexagon", 1, 1], ["Key", 3, 1],
  ["Leaf", 2, 1], ["Moon", 1, 1], ["Shield", 1, 1], ["Snowflake", 12, 0], ["Sun", 9, 1], ["Target", 3, 3],
  ["Tree", 2, 1], ["Umbrella", 3, 1], ["Wind", 3, 0], ["Aperture", 7, 1], ["Fingerprint", 9, 1], ["Anchor", 4, 1],
  ["Bell", 2, 1], ["Bookmark", 1, 1], ["Eye", 2, 2], ["Fish", 6, 2]
];

test("the icon pool is voltviz's, in its order, and made of what outline.ts measures", () => {
  assert.deepEqual(ICON_POOL.map(([name]) => name), CHROME.map(([name]) => name));
  for (const [name, node] of ICON_POOL) {
    assert.ok(node.length > 0, name);
    for (const [tag] of node) assert.ok(["path", "circle", "line"].includes(tag), `${name}: <${tag}>`);
  }
});

test("every icon parses into the subpaths upstream draws, normalised to ±1", () => {
  ICON_POOL.forEach(([name, node], index) => {
    const parsed = parseIcon(node);
    const [, subpaths, closed] = CHROME[index]!;
    assert.equal(parsed.length, subpaths, `${name}: subpaths`);
    const isClosed = (path: number[][]): boolean => path.length > 2
      && Math.hypot(path[0]![0]! - path.at(-1)![0]!, path[0]![1]! - path.at(-1)![1]!) < 0.05;
    assert.equal(parsed.filter((item) => isClosed(item.path)).length, closed, `${name}: closed subpaths`);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { path } of parsed) {
      for (const [x, y, z] of path) {
        minX = Math.min(minX, x!); maxX = Math.max(maxX, x!);
        minY = Math.min(minY, y!); maxY = Math.max(maxY, y!);
        assert.equal(z, 0);
      }
    }
    // centred, the longer side from -1 to 1
    near(minX + maxX, 0, 1e-12, `${name}: centred x`);
    near(minY + maxY, 0, 1e-12, `${name}: centred y`);
    near(Math.max(maxX - minX, maxY - minY), 2, 1e-12, `${name}: size`);
  });
  const points = ICON_POOL.reduce((sum, [, node]) => sum + parseIcon(node).reduce((count, item) => count + item.path.length, 0), 0);
  assert.equal(points, 42742, "301 points for each of the 142 elements");
});
