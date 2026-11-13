import assert from "node:assert/strict";
import test from "node:test";

import { parseTexerConfig, texerFrame } from "./texerV1Frame.ts";

function config(image: string, bits: number | null, particles: number | null): Uint8Array {
    const length = 16 + 260 + (bits === null ? 0 : 4) + (particles === null ? 0 : 4);
    const data = new Uint8Array(length);
    for (let k = 0; k < image.length; k++) {
        data[16 + k] = image.charCodeAt(k);
    }
    const view = new DataView(data.buffer);
    if (bits !== null) view.setInt32(276, bits, true);
    if (particles !== null) view.setInt32(280, particles, true);
    return data;
}

test("config as load_legacy reads it: the name at 16, input/output bits, the particle count (100)", () => {
    assert.deepEqual(parseTexerConfig(config("dot.bmp", 2 | 8, 40)), { image: "dot.bmp", addToInput: true, colorize: true, particles: 40 });
    assert.deepEqual(parseTexerConfig(config("dot.bmp", 1 | 4, null)), { image: "dot.bmp", addToInput: false, colorize: false, particles: 100 });
    assert.equal(parseTexerConfig(new Uint8Array(20)).image, "");
});

test("each lit pixel in reading order gets the bitmap added, centred, clipped, up to the count", () => {
    const w = 5;
    const h = 3;
    const fb = new Int32Array(w * h);
    fb[1 * w + 1] = 0x000010; // lit: (1, 1)
    fb[0 * w + 4] = 0x800000; // lit first in reading order: (4, 0)
    const bitmap = { width: 3, height: 3, pixels: new Int32Array(9).fill(0x101010) };
    const out = new Int32Array(w * h);
    texerFrame(fb, out, w, h, bitmap, false, false, 1);
    // Only (4, 0): x 3..5 clipped to 3..4, y -1..1 clipped to 0..1.
    assert.deepEqual([...out].map((p) => (p ? 1 : 0)), [0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    texerFrame(fb, out, w, h, bitmap, true, false, 2);
    // Add to input keeps the frame under both particles: (4, 0)'s covers x 3..4, (1, 1)'s x 0..2.
    assert.equal(out[0 * w + 4], 0x800000 + 0x101010);
    assert.equal(out[1 * w + 3], 0x101010);
    assert.equal(out[1 * w + 1], 0x101010 + 0x000010);
    assert.equal(out[2 * w + 2], 0x101010);
    assert.equal(out[2 * w + 4], 0);
});

test("colorize multiplies by the lit pixel, (c · m) >> 8; the sums saturate", () => {
    const fb = new Int32Array([0x80ff40]);
    const bitmap = { width: 1, height: 1, pixels: new Int32Array([0xffffff]) };
    const out = new Int32Array(1);
    texerFrame(fb, out, 1, 1, bitmap, false, true, 1);
    assert.equal(out[0], (((0xff * 0x80) >> 8) << 16) | (((0xff * 0xff) >> 8) << 8) | ((0xff * 0x40) >> 8));
    texerFrame(fb, out, 1, 1, bitmap, true, false, 1);
    assert.equal(out[0], 0xffffff);
});
