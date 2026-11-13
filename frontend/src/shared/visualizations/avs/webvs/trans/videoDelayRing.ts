/**
 * Video Delay's frames as r_videodelay.cpp (AVS 2.81; Tom Holden's APE, built into vis_avs)
 * keeps them: one buffer of `capacity` frames, the delay's `size` of them in use, and `pos` the
 * frame read (shown) and then written (the current frame) every frame. When the delay changes —
 * on beats — AVS moves the frames with memmove; it moves whole frames, so here a slot is a frame
 * and moving frames is moving references.
 *
 * Pure, testable without a browser: slots hold anything (the GPU frames in Native.ts), null for
 * memory AVS had just allocated (VirtualAlloc gives zeros: a black frame).
 */
export interface DelayRing<T> {
    ring: (T | null)[];
    capacity: number;
    size: number;
    pos: number;
    /** The frame size the buffer was made for; another size makes a new buffer. */
    frame: string;
}

export function newDelayRing<T>(): DelayRing<T> {
    // buffersize = 1 byte (no whole frame), oldframemem never set: the first frame allocates.
    return { ring: [], capacity: 0, size: 0, pos: 0, frame: "" };
}

/** Fresh zeroed memory of `capacity` frames, as VirtualAlloc gave it. */
function allocate<T>(state: DelayRing<T>, capacity: number): void {
    state.capacity = capacity;
    state.ring = new Array<T | null>(capacity).fill(null);
    state.pos = 0;
}

/**
 * The buffer for a delay of `delay` frames (> 0) of size `frame`, before this frame is read and
 * written — render() up to its CopyMemory calls.
 */
export function resizeDelayRing<T>(state: DelayRing<T>, delay: number, frame: string, useBeats: boolean): void {
    if (frame !== state.frame) {
        // A new frame size, or the first frame: new memory (beats: room for twice the delay).
        allocate(state, useBeats ? 2 * delay : delay);
        state.size = delay;
        state.frame = frame;
        return;
    }
    if (delay === state.size) {
        return;
    }
    if (delay > state.size) {
        if (delay > state.capacity) {
            allocate(state, useBeats ? Math.min(2 * delay, 400) : delay);
        } else {
            // The frames from pos to the old end move to the new end; the gap they leave is
            // filled with copies of the frame then at the start of the moved block.
            const tail = state.size - state.pos;
            const d = delay - tail;
            const moved = state.ring.slice(state.pos, state.pos + tail);
            for (let k = 0; k < tail; k++) {
                state.ring[d + k] = moved[k] ?? null;
            }
            for (let l = state.pos; l < d; l++) {
                state.ring[l] = state.ring[d] ?? null;
            }
        }
    } else {
        const before = state.pos + 1;
        if (before > delay) {
            // Keep the `delay` frames up to and with pos, from the start; pos is the last of them.
            const kept = state.ring.slice(before - delay, before);
            for (let k = 0; k < delay; k++) {
                state.ring[k] = kept[k] ?? null;
            }
            state.pos = delay - 1;
        } else if (before < delay) {
            const from = state.size + before - delay;
            const moved = state.ring.slice(from, from + delay - before);
            for (let k = 0; k < delay - before; k++) {
                state.ring[state.pos + 1 + k] = moved[k] ?? null;
            }
        }
    }
    state.size = delay;
}

/** This frame's read and write: the frame shown (null: black) and the current one kept in its place. */
export function stepDelayRing<T>(state: DelayRing<T>, current: T): T | null {
    const shown = state.ring[state.pos] ?? null;
    state.ring[state.pos] = current;
    state.pos += 1;
    if (state.pos >= state.size) {
        state.pos = 0;
    }
    return shown;
}

/** Slots past the delay are never read before they are written: what they hold can go. */
export function trimDelayRing<T>(state: DelayRing<T>): void {
    for (let k = state.size; k < state.ring.length; k++) {
        state.ring[k] = null;
    }
}
