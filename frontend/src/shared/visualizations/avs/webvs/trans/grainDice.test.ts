import assert from "node:assert/strict";
import test from "node:test";

import { GRAIN_ADDITIVE, GRAIN_AVERAGE, GRAIN_REPLACE, GrainDice, grainMask, grainMaskWasm, grainMoving, grainMovingWasm } from "./grainDice.ts";

/** Microsoft's rand() from seed 1, as AVS 2.81 (and the reference's private Grain generator). */
function msRand() {
    let hold = 1;
    let calls = 0;
    const rand = () => {
        calls++;
        hold = (Math.imul(hold, 214013) + 2531011) >>> 0;
        return (hold >>> 16) & 0x7fff;
    };
    return { rand, calls: () => calls };
}

/**
 * r_grain.cpp's moving loop written as the C is (fastrandbyte() a function, the pixel as one
 * 0x00RRGGBB word), to check grainMoving against.
 */
function reference(frame: number[], dice: { table: number[]; pos: number }, rand: () => number, limit: number, blend: number): number[] {
    const fastrandbyte = () => {
        const r = dice.table[dice.pos]!;
        dice.pos++;
        if (!(dice.pos & 15)) dice.pos += rand() % 73;
        if (dice.pos >= 491) dice.pos -= 491;
        return r;
    };
    return frame.map((p) => {
        if (!p) return p;
        let c = 0;
        if (fastrandbyte() < limit) {
            const s = fastrandbyte();
            let r = ((p & 0xff0000) * s) / 256;
            c |= Math.floor(r) & 0xff0000;
            r = ((p & 0xff00) * s) >> 8;
            c |= r & 0xff00;
            r = ((p & 0xff) * s) >> 8;
            c |= r;
        }
        if (blend === GRAIN_ADDITIVE) {
            let out = 0;
            for (const shift of [0, 8, 16]) out |= Math.min(255, ((p >> shift) & 255) + ((c >> shift) & 255)) << shift;
            return out;
        }
        if (blend === GRAIN_AVERAGE) return ((p >> 1) & 0x7f7f7f) + ((c >> 1) & 0x7f7f7f);
        return c;
    });
}

test("the table: 491 bytes of rand() & 255, then the place rand() % 491", () => {
    const { rand, calls } = msRand();
    const dice = new GrainDice(rand);
    const check = msRand();
    const bytes = Array.from({ length: 491 }, () => check.rand() & 255);
    assert.deepEqual(Array.from(dice.table), bytes);
    assert.equal(dice.position, check.rand() % 491);
    assert.equal(calls(), 492);
});

test("a byte steps on, and jumps on by rand() % 73 at every 16th place", () => {
    const { rand, calls } = msRand();
    const dice = new GrainDice(rand);
    dice.position = 14;
    assert.equal(dice.byte(rand), dice.table[14]);
    assert.equal(dice.position, 15);
    const before = calls();
    dice.byte(rand);
    assert.equal(calls(), before + 1);
    assert.ok(dice.position >= 16 && dice.position < 16 + 73);
    // From the end the place wraps round.
    dice.position = 490;
    dice.byte(rand);
    assert.equal(dice.position, 0);
});

test("moving grain: the plug-in's bytes in its order, over lit pixels only, every blend mode", () => {
    const random = msRand();
    const width = 61;
    const height = 37;
    for (const blend of [GRAIN_REPLACE, GRAIN_ADDITIVE, GRAIN_AVERAGE]) {
        for (const amount of [0, 13, 40, 100]) {
            const limit = Math.floor((amount * 255) / 100);
            // Some black pixels (no byte drawn), the rest of any colour.
            const frame = Array.from({ length: width * height }, () => (random.rand() % 3 === 0 ? 0 : ((random.rand() << 9) ^ random.rand()) & 0xffffff));
            const ours = msRand();
            const theirs = msRand();
            const dice = new GrainDice(ours.rand);
            const plain = { table: Array.from({ length: 491 }, () => theirs.rand() & 255), pos: theirs.rand() % 491 };
            for (let f = 0; f < 3; f++) {
                dice.frame(ours.rand);
                plain.pos += theirs.rand() % 300;
                if (plain.pos >= 491) plain.pos -= 491;
                const bytes = new Uint8Array(width * height * 4);
                frame.forEach((p, i) => {
                    bytes[i * 4] = (p >> 16) & 255;
                    bytes[i * 4 + 1] = (p >> 8) & 255;
                    bytes[i * 4 + 2] = p & 255;
                    bytes[i * 4 + 3] = 255;
                });
                grainMoving(new Uint32Array(bytes.buffer), width * height, dice, ours.rand, limit, blend);
                const expected = reference(frame, plain, theirs.rand, limit, blend);
                const got = Array.from({ length: width * height }, (_, i) => (bytes[i * 4]! << 16) | (bytes[i * 4 + 1]! << 8) | bytes[i * 4 + 2]!);
                assert.deepEqual(got, expected, `blend ${blend} amount ${amount} frame ${f}`);
                assert.equal(dice.position, plain.pos);
                assert.equal(ours.calls(), theirs.calls());
            }
        }
    }
});

test("the walk in WebAssembly: the same pixels, place and rand() state as the loop", () => {
    const random = msRand();
    for (const [width, height] of [[61, 37], [320, 180], [7, 3]] as const) {
        for (const blend of [GRAIN_REPLACE, GRAIN_ADDITIVE, GRAIN_AVERAGE]) {
            for (const amount of [0, 40, 77, 100]) {
                const limit = Math.floor((amount * 255) / 100);
                // Microsoft's generator from the same seed on both sides.
                let hold = random.rand() * 65536 + random.rand();
                const js = () => {
                    hold = (Math.imul(hold, 214013) + 2531011) | 0;
                    return (hold >>> 16) & 0x7fff;
                };
                const dice = new GrainDice(js);
                const twin = new GrainDice(() => 0);
                twin.table.set(dice.table);
                twin.position = dice.position;
                let state = hold >>> 0;
                for (let f = 0; f < 3; f++) {
                    const frame = new Uint32Array(width * height).map(() => (random.rand() % 4 === 0 ? 0xff000000 : (((random.rand() << 9) ^ random.rand()) & 0xffffff) | 0xff000000));
                    const a = frame.slice();
                    const b = frame.slice();
                    grainMoving(a, width * height, dice, js, limit, blend);
                    state = grainMovingWasm(b, width * height, twin, state, limit, blend);
                    assert.ok(state >= 0, "WebAssembly in Node");
                    assert.deepEqual(b, a, `${width}x${height} blend ${blend} amount ${amount} frame ${f}`);
                    assert.equal(twin.position, dice.position);
                    assert.equal(state, hold >>> 0);
                    // The frame's own step, as render() does before the walk.
                    dice.frame(js);
                    hold = (Math.imul(state, 214013) + 2531011) | 0;
                    twin.position += ((hold >>> 16) & 0x7fff) % 300;
                    if (twin.position >= 491) twin.position -= 491;
                    state = hold >>> 0;
                }
            }
        }
    }
});

test("the walk over a bitmask of lit pixels: the scale bytes grainMoving applies, JS and WebAssembly", () => {
    const random = msRand();
    for (const [width, height] of [[64, 9], [61, 37], [1280, 4]] as const) {
        const stride = Math.ceil(width / 32) * 4;
        for (const amount of [0, 33, 100]) {
            const limit = Math.floor((amount * 255) / 100);
            let hold = random.rand() * 65536 + random.rand();
            const js = () => {
                hold = (Math.imul(hold, 214013) + 2531011) | 0;
                return (hold >>> 16) & 0x7fff;
            };
            const dice = new GrainDice(js);
            const viaMask = new GrainDice(() => 0);
            viaMask.table.set(dice.table);
            viaMask.position = dice.position;
            const viaWasm = new GrainDice(() => 0);
            viaWasm.table.set(dice.table);
            viaWasm.position = dice.position;
            const start = hold;
            // Top row first in the frame, bottom row first (GL) in the mask and the scale bytes.
            const frame = new Uint32Array(width * height).map(() => (random.rand() % 3 === 0 ? 0xff000000 : (((random.rand() << 9) ^ random.rand()) & 0xffffff) | 0xff000000));
            const mask = new Uint8Array(stride * height);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (frame[y * width + x]! & 0xffffff) mask[(height - 1 - y) * stride + (x >> 3)] |= 1 << (x & 7);
                }
            }
            const moved = frame.slice();
            grainMoving(moved, width * height, dice, js, limit, GRAIN_REPLACE);
            const after = hold;
            hold = start;
            const scale = new Uint8Array(width * height);
            grainMask(mask, stride, width, height, viaMask, js, limit, scale);
            assert.equal(hold, after, "the same rand() draws");
            assert.equal(viaMask.position, dice.position);
            // Replace mode: the grain is each channel times the scale byte, >> 8.
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const p = frame[y * width + x]!;
                    if (!(p & 0xffffff)) continue;
                    const s = scale[(height - 1 - y) * width + x]!;
                    const expected = ((p & 0xff) * s >> 8) | ((((p >> 8) & 0xff) * s >> 8) << 8) | ((((p >> 16) & 0xff) * s >> 8) << 16) | 0xff000000;
                    assert.equal(moved[y * width + x], expected >>> 0, `${width}x${height} amount ${amount} (${x}, ${y})`);
                }
            }
            const scaleWasm = new Uint8Array(width * height);
            const state = grainMaskWasm(mask, stride, width, height, viaWasm, start >>> 0, limit, scaleWasm);
            assert.equal(state, after >>> 0);
            assert.equal(viaWasm.position, dice.position);
            assert.deepEqual(scaleWasm, scale);
        }
    }
});
