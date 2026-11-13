import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findLogos } from "../../../scripts/voltviz-logos.mjs";
import { traceLogo, type LogoPixels } from "./voltviz/logo.ts";

/** A picture of `width` × `height` whose pixel colour (RGBA, 0…255) `paint` gives. */
function picture(width: number, height: number, paint: (x: number, y: number) => readonly number[]): LogoPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(paint(x + 0.5, y + 0.5), (y * width + x) * 4);
  return { width, height, data };
}

/** Distances of a path's points from (0, 0): the smallest and the largest. */
function radii(path: number[][]): [number, number] {
  const distances = path.map(([x, y]) => Math.hypot(x!, y!));
  return [Math.min(...distances), Math.max(...distances)];
}

test("Your Logo traces a picture: a ring on a transparent picture is two closed outlines, sampled as voltviz samples an SVG path", () => {
  const ring = picture(128, 128, (x, y) => {
    const r = Math.hypot(x - 64, y - 64);
    return r <= 40 && r >= 20 ? [30, 120, 255, 255] : [0, 0, 0, 0];
  });
  const paths = traceLogo(ring);
  assert.equal(paths.length, 2);
  for (const { path, color } of paths) {
    assert.equal(color, null);
    // 300 to 3000 points by length (getPointAtLength in voltviz), and the last on the first.
    assert.ok(path.length >= 301 && path.length <= 3001, `${path.length} points`);
    assert.deepEqual(path.at(-1), path[0]);
    assert.ok(path.every((point) => point.length === 3 && point[2] === 0));
  }
  // Normalised as loadSvg normalises: centred, half the larger side is 1.
  const [outer, inner] = paths.map((entry) => radii(entry.path)).sort((a, b) => b[1] - a[1]);
  assert.ok(Math.abs(outer![0] - 1) < 0.04 && Math.abs(outer![1] - 1) < 0.04, `outer ${outer}`);
  assert.ok(Math.abs(inner![0] - 0.5) < 0.04 && Math.abs(inner![1] - 0.5) < 0.04, `inner ${inner}`);
});

test("Your Logo traces a picture: a soft glow stays out, the opaque shape is the logo", () => {
  // A solid square 40 px wide in a glow 30 px wide that is at most 60% opaque.
  const glowing = picture(160, 160, (x, y) => {
    const d = Math.max(Math.abs(x - 80), Math.abs(y - 80));
    if (d <= 20) return [255, 255, 255, 255];
    const glow = Math.max(0, 1 - (d - 20) / 30) * 0.6;
    return [80, 120, 255, Math.round(glow * 255)];
  });
  const paths = traceLogo(glowing);
  assert.equal(paths.length, 1);
  // The square's corners are at (±1, ±1): its sides, not the glow's, are the outline.
  const [near, far] = radii(paths[0]!.path);
  assert.ok(Math.abs(near - 1) < 0.08 && far > 1.3 && far <= Math.SQRT2 + 0.01, `${near} … ${far}`);
});

test("Your Logo traces a picture: on an opaque background the logo is what differs from it, left to right", () => {
  // Two dark discs on a yellow square, the right one smaller.
  const signature = picture(200, 100, (x, y) => {
    const left = Math.hypot(x - 50, y - 50) <= 30;
    const right = Math.hypot(x - 150, y - 50) <= 15;
    return left || right ? [25, 25, 25, 255] : [254, 188, 5, 255];
  });
  const paths = traceLogo(signature);
  assert.equal(paths.length, 2);
  const centre = (path: number[][]): number => path.reduce((sum, point) => sum + point[0]!, 0) / path.length;
  assert.ok(centre(paths[0]!.path) < centre(paths[1]!.path));
  // The pair spans x 20…165: the left disc's centre is (50 - 92.5) / 72.5 from the middle.
  assert.ok(Math.abs(centre(paths[0]!.path) + 42.5 / 72.5) < 0.02, `${centre(paths[0]!.path)}`);
  assert.deepEqual(traceLogo(picture(64, 64, () => [254, 188, 5, 255])), []);
  assert.deepEqual(traceLogo(picture(64, 64, () => [0, 0, 0, 0])), []);
});

test("Your Logo's logos come from vendor/voltviz-logos by file name, and nothing else in the folder is one", () => {
  const directory = mkdtempSync(join(tmpdir(), "voltviz-logos-"));
  try {
    assert.deepEqual(findLogos(join(directory, "missing")), []);
    for (const file of ["logo-2022.png", "logo-2013.PNG", "Mark_one.svg", "SOURCE.txt", "notes.md"]) writeFileSync(join(directory, file), "x");
    mkdirSync(join(directory, "folder.png"));
    assert.deepEqual(findLogos(directory), [
      { file: "logo-2013.PNG", id: "yourlogo-logo-2013", name: "Logo 2013", kind: "image" },
      { file: "logo-2022.png", id: "yourlogo-logo-2022", name: "Logo 2022", kind: "image" },
      { file: "Mark_one.svg", id: "yourlogo-mark-one", name: "Mark one", kind: "svg" }
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
