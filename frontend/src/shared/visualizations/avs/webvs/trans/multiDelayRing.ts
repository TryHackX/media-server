/**
 * Multi Delay's buffers as r_multidelay.cpp (vis_avs 2.81d, BSD) keeps them: six buffers of
 * frames shared by every Multi Delay of the preset, each with an in and an out position, resized
 * the way render() resizes them — with MoveMemory/CopyMemory on whole frames, so a slot is a frame
 * and moving frames is moving references. Pure: slots hold anything (GPU frames in MultiDelay.ts),
 * null for fresh memory (VirtualAlloc gives zeros: black).
 */
export interface MultiDelayBuffer<T> {
    slots: (T | null)[];
    /** buffersize in frames (memory allocated). */
    capacity: number;
    /** oldvirtualbuffersize in frames (the delay in use). */
    oldSize: number;
    inpos: number;
    outpos: number;
}

export interface MultiDelayState<T> {
    instances: number;
    renderId: number;
    framesSinceBeat: number;
    framesPerBeat: number;
    /** framemem: the frame size; oldframemem as AVS keeps it. */
    frame: string;
    oldFrame: string;
    useBeats: boolean[];
    delay: number[];
    frameDelay: number[];
    buffers: MultiDelayBuffer<T>[];
}

export function newMultiDelayState<T>(): MultiDelayState<T> {
    const buffers: MultiDelayBuffer<T>[] = [];
    for (let i = 0; i < 6; i++) {
        buffers.push({ slots: [], capacity: 0, oldSize: 0, inpos: 0, outpos: 0 });
    }
    return {
        instances: 0, renderId: 0, framesSinceBeat: 0, framesPerBeat: 0, frame: "", oldFrame: "",
        useBeats: [false, false, false, false, false, false], delay: [0, 0, 0, 0, 0, 0],
        frameDelay: [0, 0, 0, 0, 0, 0], buffers,
    };
}

/** load_config: mode, active buffer, then each buffer's "use beats" (== 1) and delay (AVS's globals). */
export function loadMultiDelayConfig<T>(state: MultiDelayState<T>, data: Uint8Array): { mode: number; activeBuffer: number } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const left = () => data.length - pos;
    let mode = 0;
    let activeBuffer = 0;
    if (left() >= 4) {
        mode = view.getInt32(pos, true);
        pos += 4;
    }
    if (left() >= 4) {
        activeBuffer = view.getInt32(pos, true);
        pos += 4;
    }
    if (left() >= 4) {
        for (let i = 0; i < 6; i++) {
            if (left() >= 4) {
                state.useBeats[i] = view.getInt32(pos, true) === 1;
                pos += 4;
            }
            if (left() >= 4) {
                state.delay[i] = view.getInt32(pos, true);
                state.frameDelay[i] = (state.useBeats[i] ? state.framesPerBeat : state.delay[i]!) + 1;
                pos += 4;
            }
        }
    }
    return { mode, activeBuffer };
}

/** VirtualAlloc'd memory for `size` frames (twice that with beats): zeros, positions reset. */
function allocate<T>(buffer: MultiDelayBuffer<T>, size: number, useBeats: boolean) {
    buffer.capacity = useBeats ? 2 * size : size;
    buffer.slots = new Array<T | null>(buffer.capacity).fill(null);
    buffer.outpos = 0;
    buffer.inpos = size - 1;
}

/** MoveMemory of `count` frames from slot `from` to slot `to` (overlap allowed). */
function move<T>(slots: (T | null)[], from: number, to: number, count: number) {
    const block = slots.slice(from, from + count);
    for (let k = 0; k < count; k++) {
        slots[to + k] = block[k] ?? null;
    }
}

/**
 * render() for the instance that renders first in a frame (renderid == 1): beats, then each
 * buffer with a delay over one frame sized for it. `frame` names the frame size (framemem).
 */
export function multiDelayFrameStart<T>(state: MultiDelayState<T>, frame: string, beat: boolean) {
    state.frame = frame;
    if (beat) {
        state.framesPerBeat = state.framesSinceBeat;
        for (let i = 0; i < 6; i++) {
            if (state.useBeats[i]) {
                state.frameDelay[i] = state.framesPerBeat + 1;
            }
        }
        state.framesSinceBeat = 0;
    }
    state.framesSinceBeat++;
    for (let i = 0; i < 6; i++) {
        if (state.frameDelay[i]! > 1) {
            resizeBuffer(state, i);
        }
    }
}

function resizeBuffer<T>(state: MultiDelayState<T>, i: number) {
    const buffer = state.buffers[i]!;
    const size = state.frameDelay[i]!;
    const useBeats = state.useBeats[i]!;
    if (state.frame === state.oldFrame) {
        if (size !== buffer.oldSize) {
            if (size > buffer.oldSize) {
                if (size > buffer.capacity) {
                    allocate(buffer, size, useBeats);
                } else {
                    // The frames from the out position to the old end go to the new end; the gap
                    // is filled with copies of the frame then at the start of the moved block.
                    const tail = buffer.oldSize - buffer.outpos;
                    const d = size - tail;
                    move(buffer.slots, buffer.outpos, d, tail);
                    for (let l = buffer.outpos; l < d; l++) {
                        buffer.slots[l] = buffer.slots[d] ?? null;
                    }
                }
            } else {
                const before = buffer.outpos;
                if (before > size) {
                    move(buffer.slots, before - size, 0, size);
                    buffer.inpos = size - 1;
                    buffer.outpos = 0;
                } else if (before < size) {
                    move(buffer.slots, buffer.oldSize + before - size, buffer.outpos, size - before);
                }
            }
            buffer.oldSize = size;
        }
    } else {
        allocate(buffer, size, useBeats);
        buffer.oldSize = size;
    }
    // AVS sets oldframemem inside the loop: only the first active buffer sees a new frame size.
    state.oldFrame = state.frame;
}

/** The instance's own part: "output" (2) shows the out slot, "input" (1) writes the in slot. */
export function multiDelayShown<T>(state: MultiDelayState<T>, mode: number, active: number): T | null | undefined {
    if (mode !== 2 || !(active >= 0 && active < 6) || !(state.frameDelay[active]! > 1)) {
        return undefined;
    }
    const buffer = state.buffers[active]!;
    return buffer.slots[buffer.outpos] ?? null;
}

export function multiDelayStore<T>(state: MultiDelayState<T>, mode: number, active: number, frame: T): boolean {
    if (mode === 0 || mode === 2 || !(active >= 0 && active < 6) || !(state.frameDelay[active]! > 1)) {
        return false;
    }
    const buffer = state.buffers[active]!;
    if (buffer.inpos >= buffer.slots.length) {
        return false;
    }
    buffer.slots[buffer.inpos] = frame;
    return true;
}

/** After the last instance of the frame: every buffer's positions one frame on, wrapped. */
export function multiDelayFrameEnd<T>(state: MultiDelayState<T>) {
    for (const buffer of state.buffers) {
        buffer.inpos++;
        buffer.outpos++;
        if (buffer.inpos >= buffer.oldSize) {
            buffer.inpos = 0;
        }
        if (buffer.outpos >= buffer.oldSize) {
            buffer.outpos = 0;
        }
    }
}
