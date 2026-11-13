import assert from "node:assert/strict";
import test from "node:test";

import { newDelayRing, resizeDelayRing, stepDelayRing, trimDelayRing } from "./videoDelayRing.ts";

/**
 * r_videodelay.cpp's render() from `virtualbuffersize = framedelay*framemem` on, byte for byte
 * (VirtualAlloc: zeros), for frames of `framemem` bytes that each hold one value. Returns the
 * value of the frame it shows (0 for zeros).
 */
function literal(framemem: number) {
    let buffer = new Uint8Array(1);
    let buffersize = 1;
    let virtualbuffersize = 1;
    let oldvirtualbuffersize = 1;
    let inoutpos = 0;
    let oldframemem = -1;
    const alloc = (size: number) => {
        buffersize = size;
        buffer = new Uint8Array(size);
        inoutpos = 0;
    };
    return (framedelay: number, frameValue: number, usebeats: boolean, mem = framemem): number => {
        virtualbuffersize = framedelay * mem;
        if (mem === oldframemem) {
            if (virtualbuffersize !== oldvirtualbuffersize) {
                if (virtualbuffersize > oldvirtualbuffersize) {
                    if (virtualbuffersize > buffersize) {
                        let size = usebeats ? 2 * virtualbuffersize : virtualbuffersize;
                        if (usebeats && size > mem * 400) size = mem * 400;
                        alloc(size);
                    } else {
                        const size = oldvirtualbuffersize - inoutpos;
                        const d = virtualbuffersize - size;
                        buffer.copyWithin(d, inoutpos, inoutpos + size);
                        for (let l = inoutpos; l < d; l += mem) buffer.copyWithin(l, d, d + mem);
                    }
                } else {
                    const presegsize = inoutpos + mem;
                    if (presegsize > virtualbuffersize) {
                        buffer.copyWithin(0, presegsize - virtualbuffersize, presegsize);
                        inoutpos = virtualbuffersize - mem;
                    } else if (presegsize < virtualbuffersize) {
                        const from = oldvirtualbuffersize + presegsize - virtualbuffersize;
                        buffer.copyWithin(inoutpos + mem, from, from + virtualbuffersize - presegsize);
                    }
                }
                oldvirtualbuffersize = virtualbuffersize;
            }
        } else {
            alloc(usebeats ? 2 * virtualbuffersize : virtualbuffersize);
            oldvirtualbuffersize = virtualbuffersize;
        }
        oldframemem = mem;
        const shown = buffer[inoutpos]!;
        buffer.fill(frameValue, inoutpos, inoutpos + mem);
        inoutpos += mem;
        if (inoutpos >= virtualbuffersize) inoutpos = 0;
        return shown;
    };
}

/** A small deterministic generator for the test's sequences. */
function lcg(seed: number) {
    let state = seed >>> 0;
    return (n: number) => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
}

test("a fixed delay shows black for its first frames, then the frame from that many frames ago", () => {
    const ring = newDelayRing<number>();
    const shown: (number | null)[] = [];
    for (let frame = 1; frame <= 25; frame++) {
        resizeDelayRing(ring, 10, "640x480", false);
        shown.push(stepDelayRing(ring, frame));
    }
    assert.deepEqual(shown.slice(0, 10), new Array(10).fill(null));
    assert.deepEqual(shown.slice(10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("delays changing on beats move the frames as r_videodelay.cpp's memmoves do", () => {
    for (const seed of [1, 7, 42, 2026, 31337]) {
        for (const usebeats of [true, false]) {
            const random = lcg(seed);
            const reference = literal(3);
            const ring = newDelayRing<number>();
            let size = "a";
            let mem = 3;
            for (let frame = 1; frame <= 600; frame++) {
                // Mostly small changes, sometimes a jump, now and then a new frame size.
                const delay = 1 + (random(10) < 7 ? random(12) : random(150));
                if (random(200) === 0) {
                    size = size === "a" ? "b" : "a";
                    mem = size === "a" ? 3 : 2;
                }
                const value = 1 + (frame % 250);
                const expected = reference(delay, value, usebeats, mem);
                resizeDelayRing(ring, delay, size, usebeats);
                trimDelayRing(ring);
                const got = stepDelayRing(ring, value);
                assert.equal(got ?? 0, expected, `seed ${seed}, beats ${usebeats}, frame ${frame}, delay ${delay}`);
            }
        }
    }
});
