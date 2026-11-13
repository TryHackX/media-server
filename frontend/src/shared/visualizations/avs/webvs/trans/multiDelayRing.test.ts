import assert from "node:assert/strict";
import test from "node:test";

import {
    loadMultiDelayConfig, multiDelayFrameEnd, multiDelayFrameStart, multiDelayShown, multiDelayStore, newMultiDelayState,
} from "./multiDelayRing.ts";

/**
 * r_multidelay.cpp's render() byte for byte for frames of `framemem` bytes that each hold one
 * value (VirtualAlloc: zeros), one instance per buffer listed in `instances` ([mode, buffer]).
 * Returns per frame what each "output" instance showed.
 */
function literal(framemem: number) {
    const usebeats = [false, false, false, false, false, false];
    const delay = [0, 0, 0, 0, 0, 0];
    const framedelay = [0, 0, 0, 0, 0, 0];
    const buffer: Uint8Array[] = [];
    const buffersize = [1, 1, 1, 1, 1, 1];
    const virtualbuffersize = [1, 1, 1, 1, 1, 1];
    const oldvirtualbuffersize = [1, 1, 1, 1, 1, 1];
    const inpos = [0, 0, 0, 0, 0, 0];
    const outpos = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) buffer.push(new Uint8Array(1));
    let framessincebeat = 0;
    let framesperbeat = 0;
    let oldframemem = 1;
    const alloc = (i: number, size: number) => {
        buffersize[i] = size;
        buffer[i] = new Uint8Array(size);
    };
    const move = (i: number, to: number, from: number, count: number) => buffer[i]!.copyWithin(to, from, from + count);
    return {
        config(i: number, beats: boolean, frames: number) {
            usebeats[i] = beats;
            delay[i] = frames;
            framedelay[i] = (usebeats[i] ? framesperbeat : delay[i]!) + 1;
        },
        frame(isBeat: boolean, value: number, instances: [number, number][]): number[] {
            const shown: number[] = [];
            const fm = framemem;
            if (isBeat) {
                framesperbeat = framessincebeat;
                for (let i = 0; i < 6; i++) if (usebeats[i]) framedelay[i] = framesperbeat + 1;
                framessincebeat = 0;
            }
            framessincebeat++;
            for (let i = 0; i < 6; i++) {
                if (framedelay[i]! > 1) {
                    virtualbuffersize[i] = framedelay[i]! * fm;
                    if (fm === oldframemem) {
                        if (virtualbuffersize[i] !== oldvirtualbuffersize[i]) {
                            if (virtualbuffersize[i]! > oldvirtualbuffersize[i]!) {
                                if (virtualbuffersize[i]! > buffersize[i]!) {
                                    alloc(i, usebeats[i] ? 2 * virtualbuffersize[i]! : virtualbuffersize[i]!);
                                    outpos[i] = 0;
                                    inpos[i] = virtualbuffersize[i]! - fm;
                                } else {
                                    const size = oldvirtualbuffersize[i]! - outpos[i]!;
                                    const d = virtualbuffersize[i]! - size;
                                    move(i, d, outpos[i]!, size);
                                    for (let l = outpos[i]!; l < d; l += fm) move(i, l, d, fm);
                                }
                            } else {
                                const presegsize = outpos[i]!;
                                if (presegsize > virtualbuffersize[i]!) {
                                    move(i, 0, presegsize - virtualbuffersize[i]!, virtualbuffersize[i]!);
                                    inpos[i] = virtualbuffersize[i]! - fm;
                                    outpos[i] = 0;
                                } else if (presegsize < virtualbuffersize[i]!) {
                                    move(i, outpos[i]!, oldvirtualbuffersize[i]! + presegsize - virtualbuffersize[i]!, virtualbuffersize[i]! - presegsize);
                                }
                            }
                            oldvirtualbuffersize[i] = virtualbuffersize[i]!;
                        }
                    } else {
                        alloc(i, usebeats[i] ? 2 * virtualbuffersize[i]! : virtualbuffersize[i]!);
                        outpos[i] = 0;
                        inpos[i] = virtualbuffersize[i]! - fm;
                        oldvirtualbuffersize[i] = virtualbuffersize[i]!;
                    }
                    oldframemem = fm;
                }
            }
            for (const [mode, active] of instances) {
                if (mode !== 0 && framedelay[active]! > 1) {
                    if (mode === 2) shown.push(buffer[active]![outpos[active]!]!);
                    else buffer[active]!.fill(value, inpos[active]!, inpos[active]! + fm);
                } else if (mode === 2) {
                    shown.push(-1);
                }
            }
            for (let i = 0; i < 6; i++) {
                inpos[i] = inpos[i]! + fm;
                outpos[i] = outpos[i]! + fm;
                if (inpos[i]! >= virtualbuffersize[i]!) inpos[i] = 0;
                if (outpos[i]! >= virtualbuffersize[i]!) outpos[i] = 0;
            }
            return shown;
        },
    };
}

function lcg(seed: number) {
    let state = seed >>> 0;
    return (n: number) => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
}

test("config: mode, active buffer, then per buffer beats (== 1) and delay while bytes remain", () => {
    const state = newMultiDelayState<number>();
    const bytes = new Uint8Array(8 + 48);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 1, true);
    view.setInt32(4, 3, true);
    view.setInt32(8 + 3 * 8, 1, true);
    view.setInt32(8 + 3 * 8 + 4, 9, true);
    view.setInt32(8 + 4 * 8, 2, true);
    view.setInt32(8 + 4 * 8 + 4, 5, true);
    assert.deepEqual(loadMultiDelayConfig(state, bytes), { mode: 1, activeBuffer: 3 });
    assert.equal(state.useBeats[3], true);
    assert.equal(state.useBeats[4], false, "only 1 means beats");
    assert.equal(state.frameDelay[4], 6);
    // A second instance's 8-byte config leaves the shared table alone.
    assert.deepEqual(loadMultiDelayConfig(state, new Uint8Array([2, 0, 0, 0, 4, 0, 0, 0])), { mode: 2, activeBuffer: 4 });
    assert.equal(state.frameDelay[4], 6);
});

test("buffers move frames as r_multidelay.cpp's MoveMemory/CopyMemory do, beats and all", () => {
    for (const seed of [3, 11, 99, 2026]) {
        const random = lcg(seed);
        const reference = literal(3);
        const state = newMultiDelayState<number>();
        // Buffer 0 by frames, buffer 1 by beats, buffer 2 by frames changed now and then.
        const setup: [number, boolean, number][] = [[0, false, 4], [1, true, 0], [2, false, 7]];
        const bytes = new Uint8Array(8 + 48);
        const view = new DataView(bytes.buffer);
        for (const [i, beats, frames] of setup) {
            view.setInt32(8 + i * 8, beats ? 1 : 0, true);
            view.setInt32(8 + i * 8 + 4, frames, true);
            reference.config(i, beats, frames);
        }
        loadMultiDelayConfig(state, bytes);
        const instances: [number, number][] = [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]];
        for (let frame = 1; frame <= 400; frame++) {
            const beat = random(6) === 0;
            if (random(60) === 0) {
                const frames = 1 + random(12);
                reference.config(2, false, frames);
                state.delay[2] = frames;
                state.frameDelay[2] = frames + 1;
            }
            const value = 1 + (frame % 250);
            const expected = reference.frame(beat, value, instances);
            multiDelayFrameStart(state, "3", beat);
            const got: number[] = [];
            for (const [mode, active] of instances) {
                if (mode === 2) {
                    const shown = multiDelayShown(state, mode, active);
                    got.push(shown === undefined ? -1 : shown ?? 0);
                } else {
                    multiDelayStore(state, mode, active, value);
                }
            }
            multiDelayFrameEnd(state);
            assert.deepEqual(got, expected, `seed ${seed}, frame ${frame}`);
        }
    }
});
