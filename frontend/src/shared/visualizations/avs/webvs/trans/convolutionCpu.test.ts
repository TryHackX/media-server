import assert from "node:assert/strict";
import test from "node:test";

import { convolutionInPlace, convolutionRecursive, convolveAvs, planConvolution } from "./convolutionCpu.ts";
import type { ConvolutionSettings } from "./convolutionCpu.ts";

/**
 * e_convolution.cpp's generated code, emulated instruction by instruction on AVS's framebuffer
 * (0x00RRGGBB words, a word per channel in the MMX registers): the blocks im = 0…6 with their
 * addressing, the row pointers on the stack, edi's loop. Written apart from convolutionCpu.ts so
 * that the two check each other.
 */
function emulate(settings: ConvolutionSettings, frame: Uint32Array, width: number, height: number): { out: Uint32Array; fbout: boolean } {
    const kernel = Array.from({ length: 49 }, (_, i) => Number(settings.kernel[i]) | 0);
    const bias = settings.bias | 0;
    let divisionfactor = settings.scale | 0 || 1;
    const farray = new Uint16Array(49);
    let possum = 0;
    let negsum = 0;
    let zerostringl = 0;
    let zerostring = true;
    kernel.forEach((value, i) => {
        if (value < 0) {
            negsum -= value;
            zerostring = false;
            farray[i] = -value;
        } else if (value > 0) {
            possum += value;
            zerostring = false;
            farray[i] = value;
        } else if (zerostring) {
            zerostringl++;
        }
    });
    let biasWord: number;
    if (bias < 0) {
        negsum -= bias;
        biasWord = (-256 * bias) & 0xffff;
    } else {
        possum += bias;
        biasWord = (256 * bias) & 0xffff;
    }
    type Entry = [number, number, number];
    const fpos: Entry[][] = [[], []];
    const fneg: Entry[][] = [[], []];
    const swap = !(divisionfactor > 0);
    kernel.forEach((value, i) => {
        if (!value) return;
        const toPos = swap ? value < 0 : value > 0;
        const list = toPos ? fpos : fneg;
        const size = Math.abs(value);
        list[0]!.push([i % 7, Math.floor(i / 7), size]);
        list[1]!.push([6 - Math.floor(i / 7), i % 7, size]);
    });
    if (bias !== 0) {
        const toPos = swap ? bias < 0 : bias > 0;
        const list = toPos ? fpos : fneg;
        list[0]!.push([0, 7, Math.abs(bias)]);
        list[1]!.push([0, 7, Math.abs(bias)]);
    }
    if (swap) divisionfactor = -divisionfactor;
    const useFbout = zerostringl < 24;
    const out = useFbout ? new Uint32Array(frame.length) : frame;
    const words = (pixel: number) => [pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255, pixel >>> 24];
    const paddw = (a: number[], b: number[]) => a.map((v, n) => (v + b[n]!) & 0xffff);
    const paddusw = (a: number[], b: number[]) => a.map((v, n) => Math.min(65535, v + b[n]!));
    const signed = (v: number) => (v >= 32768 ? v - 65536 : v);
    // The stack: c[0] … c[6] as pixel indices of row starts.
    let c = [0, 0, 0, 0, width, 2 * width, 3 * width];
    for (let j = 0; j < height; j++) {
        let edi = 0;
        let k = j * width;
        const block = (im: number) => {
            let mm3 = [0, 0, 0, 0];
            let mm0 = [0, 0, 0, 0];
            for (let pass = 0; pass < (settings.twoPass ? 2 : 1); pass++) {
                mm0 = [0, 0, 0, 0];
                let mm1 = [0, 0, 0, 0];
                const run = (list: Entry[], sum: number) => {
                    let acc = [0, 0, 0, 0];
                    for (const [x, y, v] of list) {
                        if (y === 7) {
                            acc = paddusw(acc, [biasWord, biasWord, biasWord, biasWord]);
                            continue;
                        }
                        const eax = c[y]!;
                        let at: number;
                        if (im <= 2) at = eax + Math.max(x - 3 + im, 0);
                        else if (im === 3) at = eax + edi + x - 3;
                        else at = eax + Math.min(x - 10 + im + width, width - 2);
                        let mm2 = words(frame[at]!);
                        if (v !== 1) {
                            let jj = 1;
                            let kk = 0;
                            for (; jj < v; jj *= 2) kk++;
                            if (jj === v) mm2 = mm2.map((w) => (kk >= 16 ? 0 : (w << kk) & 0xffff));
                            else mm2 = mm2.map((w) => Math.imul(w, farray[7 * y + x]!) & 0xffff);
                        }
                        acc = sum < 256 ? paddw(acc, mm2) : paddusw(acc, mm2);
                    }
                    return acc;
                };
                mm0 = run(fpos[pass]!, possum);
                if (fneg[pass]!.length > 0) {
                    mm1 = run(fneg[pass]!, negsum);
                    if (settings.absolute) {
                        mm0 = mm0.map((v, n) => Math.max(-32768, Math.min(32767, signed(v) - signed(mm1[n]!))) & 0xffff);
                        mm0 = mm0.map((v) => ((v << 1) & 0xffff) >>> 1);
                    } else if (settings.wrap) {
                        mm0 = mm0.map((v, n) => (v - mm1[n]!) & 0xffff);
                    } else {
                        mm0 = mm0.map((v, n) => Math.max(0, v - mm1[n]!));
                    }
                }
                if (settings.twoPass && pass === 0) mm3 = mm0;
            }
            if (settings.twoPass) mm0 = paddusw(mm0, mm3);
            if (divisionfactor !== 1) {
                let jj = 1;
                let kk = 0;
                for (; jj < divisionfactor; jj *= 2) kk++;
                if (jj === divisionfactor) {
                    mm0 = mm0.map((v) => (kk >= 16 ? 0 : v >>> kk));
                } else {
                    const bx = Math.trunc(65536 / divisionfactor) & 0xffff;
                    // mul dx on the three low words only.
                    mm0 = mm0.map((v, n) => (n < 3 ? (v * bx) >>> 16 : v));
                }
            }
            const pack = (v: number) => (v >= 32768 ? 0 : Math.min(255, v));
            out[k] = (pack(mm0[0]!) | (pack(mm0[1]!) << 8) | (pack(mm0[2]!) << 16) | (pack(mm0[3]!) << 24)) >>> 0;
            k++;
            if (im < 4) edi++;
        };
        block(0);
        block(1);
        block(2);
        do {
            block(3);
        } while (edi < width - 3);
        block(4);
        block(5);
        block(6);
        let ebx = c[6]! + width;
        if (ebx === width * (height - 1)) ebx = c[6]!;
        c = [...c.slice(1), ebx];
    }
    return { out, fbout: useFbout };
}

/** A small deterministic generator for the tests. */
function lcg(seed: number) {
    let state = seed >>> 0;
    return (limit: number) => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % limit;
    };
}

function randomFrame(random: (limit: number) => number, size: number): Uint32Array {
    const frame = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        frame[i] = (random(256) | (random(256) << 8) | (random(256) << 16)) >>> 0;
    }
    return frame;
}

/** AVS's words to our RGBA bytes (alpha 255) and back (alpha left out). */
const toRgba = (frame: Uint32Array) => {
    const bytes = new Uint8Array(frame.length * 4);
    frame.forEach((pixel, i) => {
        bytes[i * 4] = (pixel >>> 16) & 255;
        bytes[i * 4 + 1] = (pixel >>> 8) & 255;
        bytes[i * 4 + 2] = pixel & 255;
        bytes[i * 4 + 3] = 255;
    });
    return bytes;
};
const rgbOf = (frame: Uint32Array) => Array.from(frame, (pixel) => pixel & 0xffffff);
const rgbOfBytes = (bytes: Uint8Array) => Array.from({ length: bytes.length / 4 }, (_, i) => (bytes[i * 4]! << 16) | (bytes[i * 4 + 1]! << 8) | bytes[i * 4 + 2]!);

function ours(settings: ConvolutionSettings, frame: Uint32Array, width: number, height: number): number[] {
    const plan = planConvolution(settings);
    const src = toRgba(frame);
    const out = plan.inPlace ? src : new Uint8Array(src.length);
    convolveAvs(plan, src, out, width, height);
    return rgbOfBytes(out);
}

function randomKernel(random: (limit: number) => number, inPlace: boolean): number[] {
    const kernel = new Array(49).fill(0);
    const terms = 1 + random(6);
    for (let t = 0; t < terms; t++) {
        const place = inPlace ? 24 + random(25) : random(49);
        const pick = random(10);
        // Mostly small weights, some powers of two, some large enough to wrap a 16-bit term.
        const size = pick < 5 ? 1 + random(5) : pick < 8 ? 1 << random(9) : pick < 9 ? 200 + random(400) : 1 + random(40);
        kernel[place] = random(3) === 0 ? -size : size;
    }
    return kernel;
}

test("in place: fewer than 24 leading zeros writes to fbout", () => {
    const kernel = new Array(49).fill(0);
    kernel[24] = 1;
    assert.equal(convolutionInPlace(kernel), true);
    kernel[23] = 1;
    assert.equal(convolutionInPlace(kernel), false);
    assert.equal(convolutionInPlace(new Array(49).fill(0)), true);
});

test("matches the emulated generated code: random kernels, frames, modes and scales", () => {
    const random = lcg(20261111);
    for (let round = 0; round < 400; round++) {
        const width = 8 + random(9);
        const height = 8 + random(7);
        const inPlace = random(2) === 0;
        const settings: ConvolutionSettings = {
            kernel: randomKernel(random, inPlace),
            bias: random(4) === 0 ? random(300) - 150 : 0,
            scale: [1, 2, 3, 4, 5, 7, 8, 12, 36, -1, -2, -3, -5, 0][random(14)]!,
            wrap: false,
            absolute: false,
            twoPass: random(3) === 0,
        };
        const mode = random(3);
        settings.wrap = mode === 1;
        settings.absolute = mode === 2;
        const frame = randomFrame(random, width * height);
        const expected = emulate(settings, frame.slice(), width, height);
        assert.equal(planConvolution(settings).inPlace, !expected.fbout);
        assert.deepEqual(ours(settings, frame, width, height), rgbOf(expected.out), `round ${round}: ${JSON.stringify(settings)} ${width}x${height}`);
    }
});

test("in place, one pass: only the last two rows and the last column read filtered pixels", () => {
    const random = lcg(7);
    const width = 16;
    const height = 12;
    // Weights below and to the left (row 5, column 1) and on the centre row to the right.
    const kernel = new Array(49).fill(0);
    kernel[24] = 2;
    kernel[26] = 1;
    kernel[36] = 1;
    const settings: ConvolutionSettings = { kernel, bias: 0, scale: 4, wrap: false, absolute: false, twoPass: false };
    const frame = randomFrame(random, width * height);
    const plan = planConvolution(settings);
    assert.equal(plan.inPlace, true);
    const inPlace = toRgba(frame);
    convolveAvs(plan, inPlace, inPlace, width, height);
    const copy = new Uint8Array(width * height * 4);
    convolveAvs(plan, toRgba(frame), copy, width, height);
    const a = rgbOfBytes(inPlace);
    const b = rgbOfBytes(copy);
    let lastColumn = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const same = a[y * width + x] === b[y * width + x];
            if (y < height - 2 && x < width - 1) {
                assert.ok(same, `(${x}, ${y}) should not read a filtered pixel`);
            } else if (y < height - 2 && !same) {
                lastColumn++;
            }
        }
    }
    assert.ok(lastColumn > 0, "the last column reads the one before it, filtered");
    assert.notDeepEqual(a.slice((height - 1) * width), b.slice((height - 1) * width));
});

test("in place, two passes: the turned kernel reads the rows above, already filtered", () => {
    const random = lcg(11);
    const width = 12;
    const height = 10;
    const kernel = new Array(49).fill(0);
    kernel[24] = 1;
    kernel[29] = -2;
    kernel[36] = 4;
    const settings: ConvolutionSettings = { kernel, bias: 0, scale: 2, wrap: false, absolute: false, twoPass: true };
    const frame = randomFrame(random, width * height);
    const plan = planConvolution(settings);
    const inPlace = toRgba(frame);
    convolveAvs(plan, inPlace, inPlace, width, height);
    const copy = new Uint8Array(width * height * 4);
    convolveAvs(plan, toRgba(frame), copy, width, height);
    const a = rgbOfBytes(inPlace);
    const b = rgbOfBytes(copy);
    // Well inside the frame the results differ.
    let inside = 0;
    for (let y = 3; y < height - 3; y++) {
        for (let x = 3; x < width - 3; x++) {
            if (a[y * width + x] !== b[y * width + x]) inside++;
        }
    }
    assert.ok(inside > 0);
});

test("second pass multiplies by the weight stored for the turned place", () => {
    // 3 at row 3, column 4 (one right of the centre). Turned, the term reads x = 3, y = 4 (one row
    // down) and pmullw takes m64_farray[7·4 + 3], which is 0 here: the second pass adds nothing.
    const kernel = new Array(49).fill(0);
    kernel[25] = 3;
    const width = 10;
    const height = 9;
    const frame = new Uint32Array(width * height).fill(0x010203);
    const settings: ConvolutionSettings = { kernel, bias: 0, scale: 1, wrap: false, absolute: false, twoPass: true };
    assert.equal(ours(settings, frame, width, height)[3 * width + 4], 0x030609);
    // With 5 at row 4, column 3 (below the centre): the first pass is 3p + 5p; turned, entry 25
    // reads below with m64_farray[31] = 5 and entry 31 reads the pixel to the left (filtered
    // already) with m64_farray[23] = 0: 8p + 5p.
    kernel[31] = 5;
    assert.equal(ours({ ...settings, kernel }, frame, width, height)[3 * width + 4], 0x0d1a27);
});

test("absolute: the words are signed, so a sum of 32768 and more turns round", () => {
    // 200 · 255 = 51000 positive, nothing negative but the bias: psubsw reads 51000 as −14536.
    const kernel = new Array(49).fill(0);
    kernel[24] = 200;
    const width = 8;
    const height = 8;
    const frame = new Uint32Array(width * height).fill(0xffffff);
    const settings: ConvolutionSettings = { kernel, bias: -1, scale: 256, wrap: false, absolute: true, twoPass: false };
    const result = ours(settings, frame, width, height);
    // (−14536 − 256) & 0x7fff = 17976, / 256 = 70.
    assert.equal(result[0], 0x464646);
});

test("recursive: only a second pass with a weight in rows 4…6 at column 3 or left of it", () => {
    const plan = (places: number[], twoPass: boolean) => {
        const kernel = new Array(49).fill(0);
        for (const place of places) kernel[place] = 1;
        return planConvolution({ kernel, bias: 0, scale: 1, wrap: false, absolute: false, twoPass });
    };
    assert.equal(convolutionRecursive(plan([24, 30], false)), false);
    assert.equal(convolutionRecursive(plan([24, 30], true)), true); // row 4, column 2: the row above
    assert.equal(convolutionRecursive(plan([24, 38], true)), true); // row 5, column 3: the pixels before
    assert.equal(convolutionRecursive(plan([24, 33, 40], true)), false); // column 5: rows below
    assert.equal(convolutionRecursive(plan([10, 30], true)), false); // not in place
});

test("edges only: the filter over a copy everywhere but the last column and the last two rows", () => {
    const random = lcg(99);
    for (let round = 0; round < 60; round++) {
        const width = 9 + random(20);
        const height = 9 + random(12);
        let settings: ConvolutionSettings;
        let plan: ReturnType<typeof planConvolution>;
        do {
            settings = {
                kernel: randomKernel(random, true),
                bias: random(3) === 0 ? random(40) - 20 : 0,
                scale: [1, 2, 3, 5, 8, -1, -3][random(7)]!,
                wrap: random(4) === 0,
                absolute: random(4) === 0,
                twoPass: random(2) === 0,
            };
            plan = planConvolution(settings);
        } while (convolutionRecursive(plan) || !plan.inPlace);
        const frame = randomFrame(random, width * height);
        const exact = toRgba(frame);
        convolveAvs(plan, exact, exact, width, height);
        const copy = new Uint8Array(width * height * 4);
        convolveAvs(plan, toRgba(frame), copy, width, height);
        // What convolutionEdges.ts reads back: the last 8 columns and row h − 2, nothing else.
        const src = toRgba(frame);
        const strips = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (x >= width - 8 || y === height - 2) {
                    const at = (y * width + x) * 4;
                    strips.set(src.subarray(at, at + 4), at);
                }
            }
        }
        convolveAvs(plan, strips, strips, width, height, true);
        const a = rgbOfBytes(exact);
        const b = rgbOfBytes(copy);
        const c = rgbOfBytes(strips);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                const edge = y >= height - 2 || x === width - 1;
                assert.equal(edge ? c[i] : b[i], a[i], `round ${round} (${x}, ${y}) ${JSON.stringify(settings)}`);
            }
        }
    }
});
