// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * A frame of a Convolution Filter on the processor (convolutionCpu.ts) as WebAssembly SIMD, made
 * for one kernel: the generated code's MMX instructions have SIMD twins (paddw `i16x8.add`, paddusw
 * `add_sat_u`, psubusw `sub_sat_u`, psubw `sub`, psubsw `sub_sat_s`, pmullw and psllw `mul`,
 * psrlw `shr_u`, punpcklbw `extend_low_i8x16_u`, packuswb `i8x16.narrow_i16x8_u`), so every
 * word is AVS's.
 *
 * Every pixel in AVS's order: columns 0 … 2 and w − 3 … w − 1 one by one with their clamped
 * reads, columns 3 … w − 4 two pixels a step (eight words), unless a pixel reads the one just
 * before it (a second pass with a weight at row 4, column 3), since the frame is filtered in place.
 * Without WebAssembly SIMD (or while a large module compiles in the background) convolveAvs does
 * the same in JavaScript. (No imports, so that Node runs its test as it is.)
 */

const SIMD = 0xfd;

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

function signed(value: bigint | number, out: number[]) {
    let v = BigInt(value);
    for (;;) {
        const byte = Number(v & 0x7fn);
        v >>= 7n;
        if ((v === 0n && !(byte & 0x40)) || (v === -1n && byte & 0x40)) {
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

/** Two pixels a step unless a pixel reads the one before it (second pass, row 4, column 3). */
export function convolutionStep(plan): number {
    const left = (xs, ys, muls) => xs.some((x, e) => x === 2 && ys[e] === 3 && muls[e]);
    return plan.passes === 2 && (left(plan.posX[1], plan.posY[1], plan.posMul[1]) || left(plan.negX[1], plan.negY[1], plan.negMul[1])) ? 1 : 2;
}

/**
 * The module over the imported memory "m"."memory", three functions of ten i32 parameters:
 * - `row(k, end, out, c0 … c6)`: pixels at byte offsets out + k + 12, k from k to end by 4·step,
 *   of a row whose kernel rows start at c0 … c6 (a term at kernel place x reads c[y] + k + 4x);
 * - `row1(…)`: the same a pixel a step (rows where a pixel reads the one before it, and the odd
 *   pixel left over);
 * - `edge(i, w2, out, c0 … c6)`: the pixel at column i (0 … 2 or w − 3 … w − 1), its terms'
 *   columns clamped to 0 … w2 (= w − 2) as the generated code's first and last three blocks do.
 */
export function convolutionModule(plan, step: number, pages: number): Uint8Array {
    // v128 locals for the constants (splats), then the pass value; then i64 and i32 scratch, the column.
    const values = [0];
    const want = (value: number) => {
        if (!values.includes(value)) {
            values.push(value);
        }
    };
    for (let pass = 0; pass < plan.passes; pass++) {
        for (const muls of [plan.posMul[pass], plan.negMul[pass]]) {
            muls.forEach((m) => m > 1 && want(m));
        }
    }
    [plan.posBias, plan.negBias].forEach((bias) => bias && want(bias));
    if (plan.mode === 2) {
        want(0x7fff);
    }
    if (plan.divShift === -2) {
        want(plan.divMultiplier);
    }
    const constant = (value: number) => 10 + values.indexOf(value);
    const PASS = 10 + values.length;
    const WIDE = PASS + 1;
    const NARROW = PASS + 2;
    const COL = PASS + 3;
    const C = 3;
    // kind: 2 or 1 (a row, pixels a step), 0 (one edge pixel).
    const body = (kind: number): number[] => {
        const code: number[] = [];
        const op = (...bytes: number[]) => code.push(...bytes);
        const simd = (opcode: number) => {
            code.push(SIMD);
            unsigned(opcode, code);
        };
        const get = (index: number) => {
            code.push(0x20);
            unsigned(index, code);
        };
        const set = (index: number) => {
            code.push(0x21);
            unsigned(index, code);
        };
        const i32 = (value: number) => {
            op(0x41);
            signed(value, code);
        };
        // A term's pixel(s), widened to words.
        const load = (x: number, y: number) => {
            get(C + y);
            if (kind) {
                get(0);
                op(0x6a); // i32.add
                simd(kind === 2 ? 0x5d : 0x5c); // v128.load64_zero / v128.load32_zero
                unsigned(0, code);
                unsigned(x * 4, code);
            } else {
                // column min(max(i + x − 3, 0), w − 2)
                get(0);
                i32(x - 3);
                op(0x6a);
                set(COL);
                i32(0);
                get(COL);
                get(COL);
                i32(0);
                op(0x48); // i32.lt_s
                op(0x1b); // select
                set(COL);
                get(1);
                get(COL);
                get(COL);
                get(1);
                op(0x4a); // i32.gt_s
                op(0x1b);
                i32(2);
                op(0x74); // i32.shl
                op(0x6a);
                simd(0x5c);
                unsigned(0, code);
                unsigned(0, code);
            }
            simd(0x89); // i16x8.extend_low_i8x16_u
        };
        // One sign's sum: the terms (paddw or paddusw), then the bias (paddusw).
        const list = (xs, ys, muls, saturate: boolean, bias: number) => {
            let first = true;
            for (let e = 0; e < xs.length; e++) {
                const m = muls[e];
                if (!m) {
                    continue;
                }
                load(xs[e], ys[e]);
                if (m !== 1) {
                    get(constant(m));
                    simd(0x95); // i16x8.mul
                }
                if (!first) {
                    simd(saturate ? 0x90 : 0x8e); // i16x8.add_sat_u / i16x8.add
                }
                first = false;
            }
            if (first) {
                get(constant(0));
            }
            if (bias) {
                get(constant(bias));
                simd(0x90);
            }
        };
        values.forEach((value, index) => {
            i32(value);
            simd(0x10); // i16x8.splat
            set(10 + index);
        });
        if (kind) {
            op(0x02, 0x40, 0x03, 0x40); // block, loop
            get(0);
            get(1);
            op(0x4e, 0x0d, 0x01); // i32.ge_s, br_if 1
        }
        for (let pass = 0; pass < plan.passes; pass++) {
            list(plan.posX[pass], plan.posY[pass], plan.posMul[pass], plan.posSaturate, plan.posBias);
            if (plan.hasNegative) {
                list(plan.negX[pass], plan.negY[pass], plan.negMul[pass], plan.negSaturate, plan.negBias);
                if (plan.mode === 2) {
                    simd(0x92); // i16x8.sub_sat_s
                    get(constant(0x7fff));
                    simd(0x4e); // v128.and
                } else {
                    simd(plan.mode === 1 ? 0x91 : 0x93); // i16x8.sub / i16x8.sub_sat_u
                }
            }
            if (plan.passes === 2) {
                if (pass === 0) {
                    set(PASS);
                } else {
                    get(PASS);
                    simd(0x90); // paddusw mm0, mm3
                }
            }
        }
        if (plan.divShift >= 16) {
            op(0x1a); // drop
            get(constant(0));
        } else if (plan.divShift >= 0) {
            i32(plan.divShift);
            simd(0x8d); // i16x8.shr_u
        } else if (plan.divShift === -2) {
            // The high word of word × (65536 / scale), both halves, packed back (all below 65536).
            set(PASS);
            get(PASS);
            get(constant(plan.divMultiplier));
            simd(0xbe); // i32x4.extmul_low_i16x8_u
            i32(16);
            simd(0xad); // i32x4.shr_u
            get(PASS);
            get(constant(plan.divMultiplier));
            simd(0xbf); // i32x4.extmul_high_i16x8_u
            i32(16);
            simd(0xad);
            simd(0x86); // i16x8.narrow_i32x4_u
        }
        set(PASS);
        get(PASS);
        get(PASS);
        simd(0x66); // i8x16.narrow_i16x8_u (packuswb)
        if (kind === 2) {
            simd(0x1d); // i64x2.extract_lane 0
            op(0);
            op(0x42); // i64.const: alpha 255 in both pixels
            signed(0xff000000ff000000n - (1n << 64n), code);
            op(0x84); // i64.or
            set(WIDE);
            get(2);
            get(0);
            op(0x6a);
            get(WIDE);
            op(0x37, 0x00, 0x0c); // i64.store offset=12
        } else {
            simd(0x1b); // i32x4.extract_lane 0
            op(0);
            i32(-16777216); // 0xff000000
            op(0x72); // i32.or
            set(NARROW);
            get(2);
            if (kind) {
                get(0);
                op(0x6a);
                get(NARROW);
                op(0x36, 0x00, 0x0c); // i32.store offset=12
            } else {
                get(0);
                i32(2);
                op(0x74);
                op(0x6a);
                get(NARROW);
                op(0x36, 0x00, 0x00); // i32.store
            }
        }
        if (kind) {
            get(0);
            i32(4 * kind);
            op(0x6a);
            set(0);
            op(0x0c, 0x00, 0x0b, 0x0b); // br 0, end loop, end block
        }
        op(0x0b);
        const fn: number[] = [3];
        unsigned(values.length + 1, fn);
        fn.push(0x7b, 1, 0x7e, 2, 0x7f); // v128 …, i64, i32 × 2
        fn.push(...code);
        return fn;
    };
    const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    section(1, [1, 0x60, 10, ...new Array(10).fill(0x7f), 0], out);
    const imports = [1, 1, 0x6d, 6, ...Array.from("memory", (c) => c.charCodeAt(0)), 0x02, 0x00];
    unsigned(pages, imports);
    section(2, imports, out);
    section(3, [3, 0, 0, 0], out);
    const name = (text: string, index: number) => [text.length, ...Array.from(text, (c) => c.charCodeAt(0)), 0x00, index];
    section(7, [3, ...name("row", 0), ...name("row1", 1), ...name("edge", 2)], out);
    const bodies = [3];
    for (const fn of [body(step), body(1), body(0)]) {
        unsigned(fn.length, bodies);
        bodies.push(...fn);
    }
    section(10, bodies, out);
    return new Uint8Array(out);
}

const compiled = new Map<string, WebAssembly.Module | Promise<unknown> | null>();

/**
 * The filter over a whole frame in WebAssembly, for one plan and frame size: the frame in the
 * module's memory (`view`), every pixel in AVS's order — the edge columns one by one, the inside
 * a row at a time. The frame can lie there top row first or, as GL reads it back, bottom row first.
 */
export class ConvolutionWasm {
    /** The frame's bytes in the module's memory. */
    public view: Uint8Array;
    private row: (...args: number[]) => void;
    private row1: (...args: number[]) => void;
    private edge: (...args: number[]) => void;
    private step: number;
    /** Kernel rows y of the terms at x = 2 (they read the pixel before when c[y] is the row itself). */
    private left: number[];
    private rows = new Int32Array(7);

    private constructor(memory: WebAssembly.Memory, exports, step: number, plan, size: number) {
        this.view = new Uint8Array(memory.buffer, 0, size);
        this.row = exports.row;
        this.row1 = exports.row1;
        this.edge = exports.edge;
        this.step = step;
        this.left = [];
        for (let pass = 0; pass < plan.passes; pass++) {
            for (const [xs, ys, muls] of [[plan.posX[pass], plan.posY[pass], plan.posMul[pass]], [plan.negX[pass], plan.negY[pass], plan.negMul[pass]]]) {
                xs.forEach((x, e) => {
                    if (x === 2 && muls[e] && !this.left.includes(ys[e])) {
                        this.left.push(ys[e]);
                    }
                });
            }
        }
    }

    /**
     * For this plan and size; null without WebAssembly SIMD, and while a module over 64 KB still
     * compiles (the caller filters in JavaScript meanwhile, with the same result).
     */
    public static make(plan, width: number, height: number): ConvolutionWasm | null {
        if (typeof WebAssembly !== "object" || width < 8 || height < 8) {
            return null;
        }
        const step = convolutionStep(plan);
        const pages = Math.ceil((width * height * 4 + 64) / 65536);
        const bytes = convolutionModule(plan, step, pages);
        const key = `${pages}:${bytes.join(",")}`;
        let module = compiled.get(key);
        if (module === undefined) {
            module = null;
            try {
                // Chrome compiles up to 8 MB on the main thread; a kernel's module is a few KB.
                if (bytes.length <= 65536) {
                    module = new WebAssembly.Module(bytes);
                } else {
                    module = WebAssembly.compile(bytes).then(
                        (done) => compiled.set(key, done),
                        () => compiled.set(key, null),
                    );
                }
            } catch {
                module = null;
            }
            compiled.set(key, module);
        }
        if (!(module instanceof WebAssembly.Module)) {
            return null;
        }
        try {
            const memory = new WebAssembly.Memory({ initial: pages });
            const instance = new WebAssembly.Instance(module, { m: { memory } });
            return new ConvolutionWasm(memory, instance.exports, step, plan, width * height * 4);
        } catch {
            return null;
        }
    }

    /**
     * The filter in place over the frame in `view`, rows top first, or (`bottomUp`) as GL reads
     * them back. As convolveAvs: the seven row pointers c[0 … 6] start at rows 0, 0, 0, 0, 1, 2, 3
     * and move down a row each row, the last never onto the last row.
     */
    public filter(width: number, height: number, bottomUp: boolean) {
        const stride = width * 4;
        const step = this.step;
        const { row, row1, edge, left, rows } = this;
        const steps = Math.floor((width - 6) / step);
        const end = steps * step * 4;
        const all = (width - 6) * 4;
        const at = (r: number) => (bottomUp ? height - 1 - r : r) * stride;
        rows.set([0, 0, 0, 0, 1, 2, 3].map((r) => Math.min(r, height - 1)));
        const w2 = width - 2;
        for (let j = 0; j < height; j++) {
            const out = at(j);
            const c0 = at(rows[0]);
            const c1 = at(rows[1]);
            const c2 = at(rows[2]);
            const c3 = at(rows[3]);
            const c4 = at(rows[4]);
            const c5 = at(rows[5]);
            const c6 = at(rows[6]);
            edge(0, w2, out, c0, c1, c2, c3, c4, c5, c6);
            edge(1, w2, out, c0, c1, c2, c3, c4, c5, c6);
            edge(2, w2, out, c0, c1, c2, c3, c4, c5, c6);
            // Two pixels a step only where no term reads the pixel before: in the top row (rows above
            // clamp to it) and in row h − 2 (rows below clamp to it) a term at x = 2 may.
            if (step === 2 && left.some((y) => rows[y] === j)) {
                row1(0, all, out, c0, c1, c2, c3, c4, c5, c6);
            } else {
                row(0, end, out, c0, c1, c2, c3, c4, c5, c6);
                if (end < all) {
                    row1(end, all, out, c0, c1, c2, c3, c4, c5, c6);
                }
            }
            for (let i = Math.max(3, width - 3); i < width; i++) {
                edge(i, w2, out, c0, c1, c2, c3, c4, c5, c6);
            }
            // c[0] = c[1] … c[5] = c[6]; c[6] one row on, unless that is the last row.
            const next = rows[6] + 1 === height - 1 ? rows[6] : rows[6] + 1;
            rows.copyWithin(0, 1);
            rows[6] = Math.min(next, height - 1);
        }
    }

    /** The filter in place over an RGBA frame (top row first) of the size made for. */
    public run(frame: Uint8Array, width: number, height: number) {
        this.view.set(frame);
        this.filter(width, height, false);
        frame.set(this.view);
    }
}
