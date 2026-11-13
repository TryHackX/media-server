import assert from "node:assert/strict";
import test from "node:test";

import { convolveAvs, planConvolution } from "./convolutionCpu.ts";
import type { ConvolutionSettings } from "./convolutionCpu.ts";
import { ConvolutionWasm, convolutionStep } from "./convolutionWasm.ts";

function lcg(seed: number) {
    let state = seed >>> 0;
    return (limit: number) => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % limit;
    };
}

/** Rows of an RGBA frame in the other order (as GL reads a frame back). */
function flipRows(frame: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(frame.length);
    const stride = width * 4;
    for (let r = 0; r < height; r++) {
        out.set(frame.subarray(r * stride, (r + 1) * stride), (height - 1 - r) * stride);
    }
    return out;
}

test("WebAssembly SIMD: the same pixels as the JavaScript loop, in place, rows either way up", () => {
    const random = lcg(4242);
    let steps1 = 0;
    let steps2 = 0;
    for (let round = 0; round < 160; round++) {
        const width = 8 + random(40);
        const height = 8 + random(16);
        const kernel = new Array(49).fill(0);
        const inPlace = random(4) !== 0;
        const terms = 1 + random(7);
        for (let t = 0; t < terms; t++) {
            const pick = random(10);
            const size = pick < 5 ? 1 + random(6) : pick < 8 ? 1 << random(10) : pick < 9 ? 200 + random(600) : 1 + random(60);
            kernel[inPlace ? 24 + random(25) : random(49)] = random(3) === 0 ? -size : size;
        }
        const mode = random(3);
        const settings: ConvolutionSettings = {
            kernel,
            bias: random(4) === 0 ? random(400) - 200 : 0,
            scale: [1, 2, 3, 4, 7, 9, 16, 36, 65536, 100000, -1, -2, -3, -7][random(14)]!,
            wrap: mode === 1,
            absolute: mode === 2,
            twoPass: random(2) === 0,
        };
        const plan = planConvolution(settings);
        if (convolutionStep(plan) === 1) steps1++;
        else steps2++;
        const frame = new Uint8Array(width * height * 4);
        for (let i = 0; i < frame.length; i++) frame[i] = (i & 3) === 3 ? 255 : random(4) === 0 ? 255 - random(4) : random(256);
        const js = frame.slice();
        convolveAvs(plan, js, js, width, height);
        const wasm = ConvolutionWasm.make(plan, width, height);
        assert.ok(wasm, "WebAssembly SIMD in Node");
        const ours = frame.slice();
        wasm.run(ours, width, height);
        assert.deepEqual(ours, js, `round ${round}: ${JSON.stringify(settings)} ${width}x${height}`);
        // The frame as GL reads it back (bottom row first), filtered where it lies.
        wasm.view.set(flipRows(frame, width, height));
        wasm.filter(width, height, true);
        assert.deepEqual(flipRows(wasm.view.slice(), width, height), js, `round ${round} bottom up`);
    }
    // Both kinds of step were tried.
    assert.ok(steps1 > 0 && steps2 > 0, `${steps1} / ${steps2}`);
});
