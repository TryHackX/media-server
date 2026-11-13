import assert from "node:assert/strict";
import test from "node:test";

import { dmoveAt, dmoveGrid, dmoveGridArray, dmovePixels, dmoveResolution, dmoveRows } from "./dmoveTable.ts";

/** The grid AVS makes when the code leaves x and y alone (rectangular), clamped as without wrap. */
function identityGrid(w: number, h: number, xres: number, yres: number, subpixel: boolean): Int32Array {
  const m = dmoveGridArray(xres, yres);
  const wAdj = (subpixel ? w - 2 : w - 1) * 65536;
  const hAdj = (subpixel ? h - 2 : h - 1) * 65536;
  const xStep = Math.trunc((w * 65536) / (xres - 1));
  const yStep = Math.trunc((h * 65536) / (yres - 1));
  for (let y = 0; y < yres; y++) {
    for (let x = 0; x < xres; x++) {
      const at = (y * xres + x) * 3;
      m[at] = Math.min(wAdj, x * xStep);
      m[at + 1] = Math.min(hAdj, y * yStep);
      m[at + 2] = 128 * 65536;
    }
  }
  return m;
}

test("the grid is grid_w + 1 by grid_h + 1 points, 2 to 256", () => {
  assert.deepEqual(dmoveResolution(16, 16), [17, 17]);
  assert.deepEqual(dmoveResolution(0, 400), [2, 256]);
});

test("a row walks from one grid point to the next in steps rounded towards zero", () => {
  const w = 8, h = 4;
  const m = identityGrid(w, h, 3, 3, false);
  const out = new Float32Array(w * h * 4);
  dmovePixels(w, h, 3, 3, m, false, false, false, out);
  const columns = Array.from({ length: w }, (_, x) => out[x * 4]);
  // The last point is held at w − 1, so the second cell walks 4…7 in steps of 0.75.
  assert.deepEqual(columns, [0, 1, 2, 3, 4, 4, 5, 6]);
  assert.equal(out[5 * 4 + 2], 192); // x = 4.75: fraction 0.75 · 256
  const rows = Array.from({ length: h }, (_, y) => out[y * w * 4 + 1]);
  assert.deepEqual(rows, [0, 1, 2, 2]);
  assert.equal(out[3], 128); // alpha
});

test("with wrap a position folds back once per pixel", () => {
  const w = 8, h = 4;
  const m = identityGrid(w, h, 2, 2, false);
  // Every point 6 pixels further right: 6 → 13 in steps of 0.875, folded at w − 1 = 7:
  // 6, 6.875, 7.75 → 0.75, 1.625, 2.5, 3.375, 4.25, 5.125.
  for (let i = 0; i < 4; i++) m[i * 3] = (m[i * 3]! + 6 * 65536) | 0;
  const out = new Float32Array(w * h * 4);
  dmovePixels(w, h, 2, 2, m, false, true, false, out);
  assert.deepEqual(Array.from({ length: w }, (_, x) => out[x * 4]), [6, 6, 0, 1, 2, 3, 4, 5]);
});

test("a cell narrower than a pixel ends the frame early, as in AVS", () => {
  const w = 4, h = 4;
  const m = identityGrid(w, h, 8, 2, false);
  const out = new Float32Array(w * h * 4);
  dmovePixels(w, h, 8, 2, m, false, false, false, out);
  assert.ok(out.every((value, index) => index % 4 !== 0 || value === -1 || index < w * 4 * h));
  assert.equal(out[0], -1);
});

test("the cell walk the GPU finishes gives every pixel the CPU walk gives", () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (const [w, h, xres, yres] of [[40, 30, 5, 4], [37, 23, 9, 7], [64, 36, 17, 17], [20, 20, 2, 2]]) {
    for (const subpixel of [false, true]) {
      for (const wrap of [false, true]) {
        const grid = dmoveGridArray(xres, yres);
        const wAdj = (subpixel ? w - 2 : w - 1) * 65536;
        const hAdj = (subpixel ? h - 2 : h - 1) * 65536;
        for (let i = 0; i < xres * yres; i++) {
          let x = Math.trunc((random() * 1.4 - 0.2) * w * 65536);
          let y = Math.trunc((random() * 1.4 - 0.2) * h * 65536);
          if (!wrap) {
            x = Math.max(0, Math.min(wAdj, x));
            y = Math.max(0, Math.min(hAdj, y));
          }
          grid[i * 3] = x;
          grid[i * 3 + 1] = y;
          grid[i * 3 + 2] = Math.trunc(random() * 255 * 65536);
        }
        const cpu = new Float32Array(w * h * 4);
        dmovePixels(w, h, xres, yres, Int32Array.from(grid), subpixel, wrap, false, cpu);
        const rows = { cells: 0, columns: new Float32Array(0), rows: new Float32Array(0) };
        if (!dmoveRows(w, h, xres, yres, Int32Array.from(grid), subpixel, wrap, rows)) {
          continue; // the caller walks the pixels on the CPU then
        }
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            assert.deepEqual(dmoveAt(rows, w, h, x, y, subpixel, wrap), Array.from(cpu.subarray(o, o + 4)),
              `${w}x${h} grid ${xres}x${yres} subpixel ${subpixel} wrap ${wrap} at ${x},${y}`);
          }
        }
      }
    }
  }
});

test("polar mode leaves d and r converted in the variables for the next frame, as r_dmove.cpp does", () => {
  const w = 64, h = 36, xres = 3, yres = 3;
  const seen: number[] = [];
  const code = {
    x: 0, y: 0, d: 0, r: 0, alpha: 0.5,
    perPixel() {
      seen.push(Number(this.d));
      this.d = 0.25;
    },
  };
  const grid = dmoveGridArray(xres, yres);
  dmoveGrid(code, w, h, xres, yres, true, false, false, true, grid);
  const maxScreenD = Math.sqrt(w * w + h * h) * 0.5 * 65536;
  // Every point's code saw its own distance (1 at the corners), not the converted one before it.
  assert.equal(seen[0], 1);
  assert.equal(seen[4], 0);
  assert.equal(code.d, 0.25 * maxScreenD);
  // The last point is the bottom-right corner: r = atan2(h/2, w/2) + π/2, then − π/2.
  assert.equal(code.r, Math.atan2(h / 2, w / 2) + Math.PI * 0.5 - Math.PI * 0.5);
  // The centre point (r = 0 there) samples d · max_screen_d to the right of the centre.
  assert.deepEqual([grid[12], grid[13], grid[14]], [Math.trunc(w * 32768 + 0.25 * maxScreenD), h * 32768, Math.trunc(0.5 * 255 * 65536)]);
});

test("rectangular mode leaves d and r as the code left them; huge positions are held to the screen", () => {
  const w = 64, h = 36;
  const code = {
    x: 0, y: 0, d: 0, r: 0, alpha: 2,
    perPixel() {
      this.x = 1e30;
      this.y = Number.NaN;
    },
  };
  const grid = dmoveGridArray(2, 2);
  dmoveGrid(code, w, h, 2, 2, false, false, true, true, grid);
  assert.equal(code.d, 1);
  // (int) of 1e30 and of NaN is 0x80000000 on x86: held to 0.
  assert.deepEqual(Array.from(grid.subarray(0, 3)), [0, 0, 255 * 65536]);
});
