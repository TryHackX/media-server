// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Moving Grain (r_grain.cpp with "static" off), as AVS 2.81 draws it: the plug-in fills a table of
 * 491 bytes with rand() & 255 when it is made and starts at rand() % 491; every frame the place
 * moves on by rand() % 300, and then every lit pixel, from the top row, left to right, takes a
 * byte for the chance (below amount · 255 / 100 it gets grain) and, if so, a byte for the scale.
 * Taking a byte steps through the table, and every 16th place it jumps on by rand() % 73
 * (fastrandbyte()), so how many numbers a frame draws depends on how much of it is lit.
 *
 * A lit pixel is one with any colour channel above 0 (AVS tests the whole word; the alpha byte
 * is 0 in its frames). Its grain is each channel times the scale, over 256, rounded down; added
 * (up to 255), averaged ((a >> 1) + (b >> 1)) or put in its place; no grain is black.
 *
 * grainMoving walks a frame the processor holds, in JavaScript (with any rand()); grainMovingWasm
 * the same in WebAssembly, about twice as fast, with rand() as Microsoft's generator stepped inside
 * from a given state. grainMask / grainMaskWasm walk a bitmask of the lit pixels instead and write
 * each one's scale byte, for a shader to apply (grainMask.ts). No imports, so that Node runs the
 * test as it is.
 */

const SIZE = 491;

export class GrainDice {
    public table = new Uint8Array(SIZE);
    public position = 0;

    /** C_GrainClass(): 491 bytes, then the place. `rand` is C's rand() (0 … 32767). */
    constructor(rand: () => number) {
        for (let x = 0; x < SIZE; x++) {
            this.table[x] = rand() & 255;
        }
        this.position = rand() % SIZE;
    }

    /** The start of render(): the place moves on. */
    public frame(rand: () => number) {
        this.position += rand() % 300;
        if (this.position >= SIZE) {
            this.position -= SIZE;
        }
    }

    /** fastrandbyte(). */
    public byte(rand: () => number): number {
        const r = this.table[this.position];
        this.position++;
        if (!(this.position & 15)) {
            this.position += rand() % 73;
        }
        if (this.position >= SIZE) {
            this.position -= SIZE;
        }
        return r;
    }
}

/** Blend modes of Grain: replace, additive, 50/50. */
export const GRAIN_REPLACE = 0;
export const GRAIN_ADDITIVE = 1;
export const GRAIN_AVERAGE = 2;

/**
 * Moving grain over `count` RGBA pixels (top row first) as 32-bit words (R in the low byte), in
 * place: the dice's bytes in the plug-in's order, `limit` = amount · 255 / 100. The frame's own
 * rand() % 300 is the caller's (dice.frame()). fastrandbyte() is written out in the loop, the
 * second byte taken without a branch on the chance (an unlit roll is a scale of 0: no grain).
 */
export function grainMoving(pixels: Uint32Array, count: number, dice: GrainDice, rand: () => number, limit: number, blend: number) {
    const table = dice.table;
    let position = dice.position;
    const below = limit - 1;
    for (let i = 0; i < count; i++) {
        const w = pixels[i];
        if (!(w & 0xffffff)) {
            continue;
        }
        const chance = table[position];
        position++;
        if (!(position & 15)) {
            position += rand() % 73;
        }
        if (position >= SIZE) {
            position -= SIZE;
        }
        // 1 when chance < limit (chance <= limit - 1), else 0.
        const take = ((below - chance) >>> 31) ^ 1;
        const s = table[position] & -take;
        position += take;
        if (take && !(position & 15)) {
            position += rand() % 73;
        }
        if (position >= SIZE) {
            position -= SIZE;
        }
        const r = w & 0xff;
        const g = (w >> 8) & 0xff;
        const b = (w >> 16) & 0xff;
        const cr = (r * s) >> 8;
        const cg = (g * s) >> 8;
        const cb = (b * s) >> 8;
        if (blend === GRAIN_ADDITIVE) {
            pixels[i] = (r + cr > 255 ? 255 : r + cr) | ((g + cg > 255 ? 255 : g + cg) << 8) | ((b + cb > 255 ? 255 : b + cb) << 16) | 0xff000000;
        } else if (blend === GRAIN_AVERAGE) {
            pixels[i] = ((r >> 1) + (cr >> 1)) | (((g >> 1) + (cg >> 1)) << 8) | (((b >> 1) + (cb >> 1)) << 16) | 0xff000000;
        } else {
            pixels[i] = cr | (cg << 8) | (cb << 16) | 0xff000000;
        }
    }
    dice.position = position;
}

// ---- The same walk in WebAssembly (about twice the speed of the loop above at 1280×720).

function unsigned(value: number, out: number[]) {
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (value);
}

function signed(value: number, out: number[]) {
    for (;;) {
        const byte = value & 0x7f;
        value >>= 7;
        if ((value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40)) {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

function section(id: number, body: number[], out: number[]) {
    out.push(id);
    unsigned(body.length, out);
    out.push(...body);
}

/** Where the module keeps the table, the generator's state and the pixels. */
const TABLE = 0;
const STATE = 496;
const PIXELS = 512;

/**
 * `walk(a, end, limit, blend, pos, state) -> pos`: grainMoving over the words at a … end, the
 * table at TABLE; rand() is Microsoft's (state · 214013 + 2531011, bits 16…30), its state left at
 * STATE.
 */
function grainModule(pages: number): Uint8Array {
    // Params 0 a, 1 end, 2 limit, 3 blend, 4 pos, 5 state; locals 6 w, 7 take, 8 s, 9 r, 10 g,
    // 11 b, 12 cr, 13 cg, 14 cb, 15 scratch.
    const c: number[] = [];
    const get = (i: number) => c.push(0x20, i);
    const set = (i: number) => c.push(0x21, i);
    const tee = (i: number) => c.push(0x22, i);
    const i32 = (v: number) => {
        c.push(0x41);
        signed(v, c);
    };
    // pos += rand() % 73
    const jump = () => {
        get(5);
        i32(214013);
        c.push(0x6c); // i32.mul
        i32(2531011);
        c.push(0x6a); // i32.add
        set(5);
        get(4);
        get(5);
        i32(16);
        c.push(0x76); // i32.shr_u
        i32(0x7fff);
        c.push(0x71); // i32.and
        i32(73);
        c.push(0x70); // i32.rem_u
        c.push(0x6a);
        set(4);
    };
    const wrap = () => {
        get(4);
        i32(TABLE + 491);
        c.push(0x4f, 0x04, 0x40); // i32.ge_u, if
        get(4);
        i32(491);
        c.push(0x6b); // i32.sub
        set(4);
        c.push(0x0b);
    };
    c.push(0x02, 0x40, 0x03, 0x40); // block, loop
    get(0);
    get(1);
    c.push(0x4f, 0x0d, 0x01); // i32.ge_u, br_if 1
    get(0);
    c.push(0x28, 0x02, 0x00); // i32.load
    tee(6);
    i32(0xffffff);
    c.push(0x71, 0x45, 0x04, 0x40); // and, eqz, if: unlit, next pixel
    get(0);
    i32(4);
    c.push(0x6a);
    set(0);
    c.push(0x0c, 0x01, 0x0b); // br loop, end
    // The chance byte; take = chance < limit.
    get(4);
    c.push(0x2d, 0x00, TABLE); // i32.load8_u
    get(2);
    c.push(0x48); // i32.lt_s
    set(7);
    get(4);
    i32(1);
    c.push(0x6a);
    set(4);
    get(4);
    i32(15);
    c.push(0x71, 0x45, 0x04, 0x40);
    jump();
    c.push(0x0b);
    wrap();
    // The scale byte, if taken: s = byte & -take, pos += take, the jump only then.
    get(4);
    c.push(0x2d, 0x00, TABLE);
    i32(0);
    get(7);
    c.push(0x6b, 0x71);
    set(8);
    get(4);
    get(7);
    c.push(0x6a);
    set(4);
    get(7);
    get(4);
    i32(15);
    c.push(0x71, 0x45, 0x71, 0x04, 0x40); // take & !(pos & 15)
    jump();
    c.push(0x0b);
    wrap();
    // Each channel times s, >> 8.
    const channel = (shift: number, level: number, grain: number) => {
        get(6);
        if (shift) {
            i32(shift);
            c.push(0x76);
        }
        i32(255);
        c.push(0x71);
        tee(level);
        get(8);
        c.push(0x6c);
        i32(8);
        c.push(0x76);
        set(grain);
    };
    channel(0, 9, 12);
    channel(8, 10, 13);
    channel(16, 11, 14);
    get(0); // the store's address
    get(3);
    i32(1);
    c.push(0x46, 0x04, 0x7f); // blend == 1: if (result i32)
    // min(level + grain, 255) per channel
    const add = (level: number, grain: number) => {
        i32(255);
        get(level);
        get(grain);
        c.push(0x6a);
        tee(15);
        get(15);
        i32(255);
        c.push(0x4b, 0x1b); // i32.gt_u, select: 255 when above
    };
    add(9, 12);
    add(10, 13);
    i32(8);
    c.push(0x74, 0x72); // shl, or
    add(11, 14);
    i32(16);
    c.push(0x74, 0x72);
    c.push(0x05); // else
    get(3);
    i32(2);
    c.push(0x46, 0x04, 0x7f); // blend == 2
    const average = (level: number, grain: number) => {
        get(level);
        i32(1);
        c.push(0x76);
        get(grain);
        i32(1);
        c.push(0x76, 0x6a);
    };
    average(9, 12);
    average(10, 13);
    i32(8);
    c.push(0x74, 0x72);
    average(11, 14);
    i32(16);
    c.push(0x74, 0x72);
    c.push(0x05); // else: replace
    get(12);
    get(13);
    i32(8);
    c.push(0x74, 0x72);
    get(14);
    i32(16);
    c.push(0x74, 0x72);
    c.push(0x0b, 0x0b);
    i32(-16777216);
    c.push(0x72); // alpha 255
    c.push(0x36, 0x02, 0x00); // i32.store
    get(0);
    i32(4);
    c.push(0x6a);
    set(0);
    c.push(0x0c, 0x00, 0x0b, 0x0b); // br loop, end loop, end block
    i32(STATE);
    get(5);
    c.push(0x36, 0x02, 0x00);
    get(4);
    c.push(0x0b);
    const fn = [1, 10, 0x7f, ...c];
    const fn2 = maskBody();
    const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    section(1, [1, 0x60, 6, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f], out);
    const imports = [1, 1, 0x6d, 6, ...Array.from("memory", (ch) => ch.charCodeAt(0)), 0x02, 0x00];
    unsigned(pages, imports);
    section(2, imports, out);
    section(3, [2, 0, 0], out);
    section(7, [2, 4, 0x77, 0x61, 0x6c, 0x6b, 0x00, 0x00, 4, 0x6d, 0x61, 0x73, 0x6b, 0x00, 0x01], out);
    const bodies = [2];
    unsigned(fn.length, bodies);
    bodies.push(...fn);
    unsigned(fn2.length, bodies);
    bodies.push(...fn2);
    section(10, bodies, out);
    return new Uint8Array(out);
}

/**
 * `mask(m, end, out, limit, pos, state) -> pos`: grainMask over the bitmask bytes m … end of one
 * row (pixel x: byte x >> 3, bit x & 7), the scale byte of each lit pixel (0 without grain) to
 * out + x. Params 0 m, 1 end, 2 out, 3 limit, 4 pos, 5 state; locals 6 bits, 7 bit, 8 take.
 */
function maskBody(): number[] {
    const c: number[] = [];
    const get = (i: number) => c.push(0x20, i);
    const set = (i: number) => c.push(0x21, i);
    const i32 = (v: number) => {
        c.push(0x41);
        signed(v, c);
    };
    const jump = () => {
        get(5);
        i32(214013);
        c.push(0x6c);
        i32(2531011);
        c.push(0x6a);
        set(5);
        get(4);
        get(5);
        i32(16);
        c.push(0x76);
        i32(0x7fff);
        c.push(0x71);
        i32(73);
        c.push(0x70, 0x6a);
        set(4);
    };
    const wrap = () => {
        get(4);
        i32(TABLE + 491);
        c.push(0x4f, 0x04, 0x40);
        get(4);
        i32(491);
        c.push(0x6b);
        set(4);
        c.push(0x0b);
    };
    c.push(0x02, 0x40, 0x03, 0x40); // block, loop: bytes
    get(0);
    get(1);
    c.push(0x4f, 0x0d, 0x01); // m >= end: done
    get(0);
    c.push(0x2d, 0x00, 0x00); // i32.load8_u
    set(6);
    c.push(0x02, 0x40, 0x03, 0x40); // block, loop: bits
    get(6);
    c.push(0x45, 0x0d, 0x01); // no bits left: next byte
    get(6);
    c.push(0x68); // i32.ctz
    set(7);
    get(6);
    get(6);
    i32(1);
    c.push(0x6b, 0x71); // bits &= bits - 1
    set(6);
    get(4);
    c.push(0x2d, 0x00, TABLE);
    get(3);
    c.push(0x48); // chance < limit
    set(8);
    get(4);
    i32(1);
    c.push(0x6a);
    set(4);
    get(4);
    i32(15);
    c.push(0x71, 0x45, 0x04, 0x40);
    jump();
    c.push(0x0b);
    wrap();
    get(2);
    get(7);
    c.push(0x6a); // out + bit
    get(4);
    c.push(0x2d, 0x00, TABLE);
    i32(0);
    get(8);
    c.push(0x6b, 0x71); // byte & -take
    c.push(0x3a, 0x00, 0x00); // i32.store8
    get(4);
    get(8);
    c.push(0x6a);
    set(4);
    get(8);
    get(4);
    i32(15);
    c.push(0x71, 0x45, 0x71, 0x04, 0x40);
    jump();
    c.push(0x0b);
    wrap();
    c.push(0x0c, 0x00, 0x0b, 0x0b); // next bit; end bits
    get(0);
    i32(1);
    c.push(0x6a);
    set(0);
    get(2);
    i32(8);
    c.push(0x6a);
    set(2);
    c.push(0x0c, 0x00, 0x0b, 0x0b); // next byte; end bytes
    i32(STATE);
    get(5);
    c.push(0x36, 0x02, 0x00);
    get(4);
    c.push(0x0b);
    return [1, 3, 0x7f, ...c];
}

let shared: { pages: number; bytes: Uint8Array; words: Uint32Array; walk: (...args: number[]) => number; mask: (...args: number[]) => number } | null = null;
let missing = false;

/** The module with at least `pages` of memory, or null without WebAssembly. */
function grainWasm(pages: number) {
    if (!shared || shared.pages < pages) {
        if (missing || typeof WebAssembly !== "object") {
            return null;
        }
        try {
            const memory = new WebAssembly.Memory({ initial: pages });
            const instance = new WebAssembly.Instance(new WebAssembly.Module(grainModule(pages)), { m: { memory } });
            shared = { pages, bytes: new Uint8Array(memory.buffer), words: new Uint32Array(memory.buffer), walk: instance.exports.walk, mask: instance.exports.mask };
        } catch {
            missing = true;
            return null;
        }
    }
    return shared;
}

/**
 * grainMoving in WebAssembly, rand() as Microsoft's generator from `state` (for the comparison
 * page the private Grain generator's, otherwise any): returns the generator's state after the
 * frame, or -1 without WebAssembly (then nothing was done; grainMoving does the same).
 */
export function grainMovingWasm(pixels: Uint32Array, count: number, dice: GrainDice, state: number, limit: number, blend: number): number {
    const module = grainWasm(Math.ceil((PIXELS + count * 4) / 65536));
    if (!module) {
        return -1;
    }
    const { bytes, words, walk } = module;
    bytes.set(dice.table, TABLE);
    const view = words.subarray(PIXELS / 4, PIXELS / 4 + count);
    view.set(pixels.subarray(0, count));
    dice.position = walk(PIXELS, PIXELS + count * 4, limit, blend, dice.position, state | 0);
    pixels.set(view);
    return words[STATE / 4];
}

/**
 * The same walk over a bitmask of the lit pixels instead of the frame (trans/grainMask.ts: the GPU
 * packs it, the GPU applies the result): `mask` has `stride` bytes a row, pixel x of a row at byte
 * x >> 3, bit x & 7, rows bottom up as GL reads them (the walk goes from the top). Each lit pixel's
 * scale byte (0 when the chance missed: no grain) goes to `out` at row · width + x, also bottom up;
 * the bytes of unlit pixels are left as they were.
 */
export function grainMask(mask: Uint8Array, stride: number, width: number, height: number, dice: GrainDice, rand: () => number, limit: number, out: Uint8Array) {
    const table = dice.table;
    let position = dice.position;
    const below = limit - 1;
    for (let row = height - 1; row >= 0; row--) {
        const from = row * stride;
        const to = row * width;
        for (let j = 0; j < stride; j++) {
            let bits = mask[from + j];
            while (bits) {
                const bit = 31 - Math.clz32(bits & -bits);
                bits &= bits - 1;
                const chance = table[position];
                position++;
                if (!(position & 15)) {
                    position += rand() % 73;
                }
                if (position >= SIZE) {
                    position -= SIZE;
                }
                const take = ((below - chance) >>> 31) ^ 1;
                out[to + j * 8 + bit] = table[position] & -take;
                position += take;
                if (take && !(position & 15)) {
                    position += rand() % 73;
                }
                if (position >= SIZE) {
                    position -= SIZE;
                }
            }
        }
    }
    dice.position = position;
}

/**
 * grainMask in WebAssembly, rand() as Microsoft's generator from `state`: returns the state after
 * the frame, or -1 without WebAssembly (then nothing was done).
 */
export function grainMaskWasm(mask: Uint8Array, stride: number, width: number, height: number, dice: GrainDice, state: number, limit: number, out: Uint8Array): number {
    const maskBytes = stride * height;
    const outAt = PIXELS + maskBytes + 64;
    const module = grainWasm(Math.ceil((outAt + width * height + 64) / 65536));
    if (!module) {
        return -1;
    }
    const { bytes, words, mask: walkRow } = module;
    bytes.set(dice.table, TABLE);
    bytes.set(mask.subarray(0, maskBytes), PIXELS);
    // Rows the walk does not reach keep their bytes: the module's copy starts as the caller's.
    bytes.set(out.subarray(0, width * height), outAt);
    let position = dice.position;
    let hold = state | 0;
    for (let row = height - 1; row >= 0; row--) {
        position = walkRow(PIXELS + row * stride, PIXELS + (row + 1) * stride, outAt + row * width, limit, position, hold);
        hold = words[STATE / 4] | 0;
    }
    dice.position = position;
    out.set(bytes.subarray(outAt, outAt + width * height));
    return hold >>> 0;
}
