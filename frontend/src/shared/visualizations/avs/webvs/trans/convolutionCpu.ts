// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Convolution Filter on the processor, as the machine code e_convolution.cpp (Tom Holden's APE,
 * 2002) generates for a kernel runs it: pixel by pixel from the top row, left to right, in the
 * same buffer it reads when the kernel starts with at least 24 zeros (`use_fbout` = 0).
 *
 * Such a kernel only reads pixels at or after the one it writes, except where an edge moves a
 * read back onto pixels already written: the last row reads row h − 2 (filtered by then), the
 * row before it reads its own row to the left, the last column the column before it. With "two
 * pass" the second kernel is the first turned a quarter round, and it reads the rows above — a
 * recursive filter, which only this order computes. Convolution.ts sends those kernels here.
 *
 * The arithmetic is the generated code's, word by word (one 16-bit word per channel):
 * - a term is the byte times its weight: none for 1, `psllw` for a power of two, otherwise
 *   `pmullw` by the weight stored for the place it reads — for the second pass that is the
 *   kernel's entry at the turned place (x = 6 − row, y = column), not the entry being turned;
 * - the terms of one sign are added with `paddw` (wrapping) when that sign's weights (and bias)
 *   add up to less than 256 — counted before a negative scale swaps the signs — otherwise with
 *   `paddusw` (up to 65535); the bias, 256 × |bias|, comes last, with `paddusw`;
 * - positive minus negative: `psubusw` (not below 0), "wrap" `psubw` (mod 65536), "absolute"
 *   `psubsw` on the words read as signed and then bit 15 cleared; nothing when there is no
 *   negative term;
 * - two passes: `paddusw` of both; division: none for 1, `psrlw` for a power of two, otherwise
 *   the high word of the word times 65536 / scale; `packuswb`: 32768 and above is 0, else at
 *   most 255;
 * - reads: columns 0…2 of the output clamp at column 0, the last three at column w − 2, the ones
 *   between read their neighbours as they are; the seven row pointers start at row 0 (four
 *   times), 1, 2, 3 and move down one a row, except that the last one never moves onto the last
 *   row.
 */

/** A Convolution Filter's settings, as AVS keeps them (whole numbers). */
export interface ConvolutionSettings {
    kernel: ArrayLike<number>;
    bias: number;
    scale: number;
    wrap: boolean;
    absolute: boolean;
    twoPass: boolean;
}

/** The generated code, as tables. */
export interface ConvolutionPlan {
    inPlace: boolean;
    passes: number;
    /** Per pass: the positive terms' kernel place x (0…6), row y (0…6) and multiplier. */
    posX: Int32Array[];
    posY: Int32Array[];
    posMul: Int32Array[];
    negX: Int32Array[];
    negY: Int32Array[];
    negMul: Int32Array[];
    /** paddusw (true) or paddw for the terms of each sign. */
    posSaturate: boolean;
    negSaturate: boolean;
    /** The bias word added (paddusw) to each sign's sum, 0 for none. */
    posBias: number;
    negBias: number;
    hasNegative: boolean;
    /** 0: psubusw, 1: psubw ("wrap"), 2: psubsw and bit 15 cleared ("absolute"). */
    mode: number;
    /** Division: -1 for none, else a shift (>= 0) or, with `divShift` = -2, the multiplier. */
    divShift: number;
    divMultiplier: number;
}

const DIM = 7;
const SIZE = 49;

/** int32 as C has it. */
const int32 = (value: number) => (Number(value) || 0) | 0;

/** Whether the code writes into the frame it reads: fewer than 24 leading zeros means fbout. */
export function convolutionInPlace(kernel: ArrayLike<number>): boolean {
    let zeros = 0;
    while (zeros < SIZE && !int32(kernel[zeros])) {
        zeros++;
    }
    return !(zeros < Math.floor(SIZE / 2));
}

/** `for (j = 1; j < value; j <<= 1) k++` with unsigned j: k when j ends equal to value, else -1. */
function powerOfTwo(value: number): number {
    let j = 1;
    let k = 0;
    while (j < value) {
        j *= 2;
        k++;
        if (j > 4294967295) {
            return -1;
        }
    }
    return j === value ? k : -1;
}

/** The multiplier a term's byte is taken by, as a 16-bit product keeps it. */
function multiplier(value: number, stored: number): number {
    if (value === 1) {
        return 1;
    }
    const shift = powerOfTwo(value);
    if (shift >= 0) {
        // psllw: a count of 16 or more leaves 0.
        return shift >= 16 ? 0 : 1 << shift;
    }
    // pmullw by the int16 stored for the place read (its low 16 bits are what counts).
    return stored & 0xffff;
}

export function planConvolution(settings: ConvolutionSettings): ConvolutionPlan {
    const kernel = [];
    for (let i = 0; i < SIZE; i++) {
        kernel.push(int32(settings.kernel[i]));
    }
    const bias = int32(settings.bias);
    let divisor = int32(settings.scale) || 1;
    // m64_farray: the size of each weight as int16.
    const stored = kernel.map((value) => (value < 0 ? -value : value) & 0xffff);
    let possum = 0;
    let negsum = 0;
    for (const value of kernel) {
        if (value < 0) {
            negsum -= value;
        } else {
            possum += value;
        }
    }
    if (bias < 0) {
        negsum -= bias;
    } else {
        possum += bias;
    }
    possum >>>= 0;
    negsum >>>= 0;
    const biasWord = ((bias < 0 ? -bias : bias) * 256) & 0xffff;
    const swap = divisor <= 0;
    // [x, y, size] of each sign's entries per pass, in the kernel's order; the bias last (y = 7).
    const pos = [[], []];
    const neg = [[], []];
    for (let i = 0; i < SIZE; i++) {
        const value = kernel[i];
        if (!value) {
            continue;
        }
        const size = value < 0 ? -value : value;
        const positive = swap ? value < 0 : value > 0;
        const row = Math.floor(i / DIM);
        const col = i % DIM;
        (positive ? pos : neg)[0].push([col, row, size]);
        (positive ? pos : neg)[1].push([6 - row, col, size]);
    }
    let posBias = 0;
    let negBias = 0;
    if (bias) {
        if ((bias > 0) !== swap) {
            posBias = biasWord;
        } else {
            negBias = biasWord;
        }
    }
    if (swap) {
        divisor = -divisor;
    }
    const passes = settings.twoPass ? 2 : 1;
    const table = (lists, pass: number, field: number) => Int32Array.from(lists[pass].map((entry) => entry[field]));
    const multipliers = (lists, pass: number) => Int32Array.from(lists[pass].map(([x, y, size]) => multiplier(size, stored[DIM * y + x])));
    let divShift = -1;
    let divMultiplier = 0;
    if (divisor !== 1) {
        const shift = powerOfTwo(divisor >>> 0);
        if (shift >= 0) {
            divShift = shift;
        } else {
            divShift = -2;
            divMultiplier = Math.trunc(65536 / divisor) & 0xffff;
        }
    }
    const hasNegative = neg[0].length > 0 || Boolean(negBias);
    return {
        inPlace: convolutionInPlace(kernel),
        passes,
        posX: [table(pos, 0, 0), table(pos, 1, 0)],
        posY: [table(pos, 0, 1), table(pos, 1, 1)],
        posMul: [multipliers(pos, 0), multipliers(pos, 1)],
        negX: [table(neg, 0, 0), table(neg, 1, 0)],
        negY: [table(neg, 0, 1), table(neg, 1, 1)],
        negMul: [multipliers(neg, 0), multipliers(neg, 1)],
        posSaturate: !(possum < 256),
        negSaturate: !(negsum < 256),
        posBias,
        negBias,
        hasNegative,
        mode: settings.absolute ? 2 : settings.wrap ? 1 : 0,
        divShift,
        divMultiplier,
    };
}

/**
 * The same plan as GLSL for the GPU (Convolution.ts), for a kernel whose reads are all of the
 * picture as it was: the body of `vec3 convolve(vec3 c)`, given `vec3 px(vec2 offset)` (the
 * levels 0…255 of the pixel at offset x right, y up, the edges clamped as the generated code
 * does) and c, the pixel itself. Every value is a whole number below 2^24, so float stays exact.
 */
export function convolutionGlsl(plan: ConvolutionPlan, read?: (x: number, y: number) => string): string {
    const f = (n: number) => n.toFixed(1);
    // A term's pixel: by default px() and c as above; convolutionEdges.ts reads other textures.
    read ||= (x: number, y: number) => (x === 3 && y === 3 ? "c" : `px(vec2(${f(x - 3)}, ${f(3 - y)}))`);
    const list = (xs: Int32Array, ys: Int32Array, muls: Int32Array, saturate: boolean, bias: number) => {
        const parts = [];
        let most = 0;
        for (let e = 0; e < xs.length; e++) {
            const m = muls[e];
            if (!m) {
                continue;
            }
            const term = m === 1 ? read(xs[e], ys[e]) : `${read(xs[e], ys[e])} * ${f(m)}`;
            // pmullw keeps the low 16 bits of a product.
            parts.push(m > 257 ? `mod(${term}, 65536.0)` : term);
            most += m > 257 ? 65535 : 255 * m;
        }
        let sum = parts.join(" + ") || "vec3(0.0)";
        if (most > 65535) {
            sum = saturate ? `min(${sum}, 65535.0)` : `mod(${sum}, 65536.0)`;
        }
        return bias ? `min(${sum} + ${f(bias)}, 65535.0)` : sum;
    };
    const lines = [];
    for (let pass = 0; pass < plan.passes; pass++) {
        lines.push(`vec3 p${pass} = ${list(plan.posX[pass], plan.posY[pass], plan.posMul[pass], plan.posSaturate, plan.posBias)};`);
        if (!plan.hasNegative) {
            lines.push(`vec3 x${pass} = p${pass};`);
            continue;
        }
        lines.push(`vec3 n${pass} = ${list(plan.negX[pass], plan.negY[pass], plan.negMul[pass], plan.negSaturate, plan.negBias)};`);
        if (plan.mode === 2) {
            // psubsw on the words as signed, then bit 15 cleared.
            lines.push(`vec3 x${pass} = mod(clamp((p${pass} - 65536.0 * step(32768.0, p${pass})) - (n${pass} - 65536.0 * step(32768.0, n${pass})), -32768.0, 32767.0), 32768.0);`);
        } else if (plan.mode === 1) {
            lines.push(`vec3 x${pass} = mod(p${pass} - n${pass}, 65536.0);`);
        } else {
            lines.push(`vec3 x${pass} = max(p${pass} - n${pass}, 0.0);`);
        }
    }
    lines.push(plan.passes === 2 ? "vec3 x = min(x0 + x1, 65535.0);" : "vec3 x = x0;");
    if (plan.divShift >= 16) {
        lines.push("vec3 y = vec3(0.0);");
    } else if (plan.divShift >= 0) {
        lines.push(`vec3 y = floor(x / ${f(2 ** plan.divShift)});`);
    } else if (plan.divShift === -2) {
        // mul dx by 65536 / scale, the high word; split so that float stays exact.
        const m = f(plan.divMultiplier);
        lines.push(`vec3 hi = floor(x / 256.0); vec3 lo = x - hi * 256.0; vec3 a = hi * ${m} / 256.0; vec3 y = floor(a) + floor(fract(a) + lo * ${m} / 65536.0);`);
    } else {
        lines.push("vec3 y = x;");
    }
    // packuswb: the word as signed.
    lines.push("return mix(min(y, 255.0), vec3(0.0), step(vec3(32767.5), y));");
    return lines.join("\n");
}

/**
 * The terms of one sign (one list of the generated code) for the three colour channels, into
 * acc[0…2]: each the byte times its multiplier, 16 bits kept (`wrap`, for multipliers above 257),
 * added up; the caller wraps or saturates the totals.
 */
function terms(src: Uint8Array, at: Int32Array, add: number, mul: Int32Array, count: number, wrap: boolean, acc: Int32Array) {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    if (wrap) {
        for (let e = 0; e < count; e++) {
            const a = at[e] + add;
            const m = mul[e];
            s0 += Math.imul(src[a], m) & 0xffff;
            s1 += Math.imul(src[a + 1], m) & 0xffff;
            s2 += Math.imul(src[a + 2], m) & 0xffff;
        }
    } else {
        for (let e = 0; e < count; e++) {
            const a = at[e] + add;
            const m = mul[e];
            s0 += src[a] * m;
            s1 += src[a + 1] * m;
            s2 += src[a + 2] * m;
        }
    }
    acc[0] = s0;
    acc[1] = s1;
    acc[2] = s2;
}

/** A sign's total as its adds leave it: paddusw or paddw, then the bias with paddusw. */
function total(value: number, saturate: boolean, bias: number): number {
    value = saturate ? (value > 65535 ? 65535 : value) : value & 0xffff;
    if (bias) {
        value += bias;
        if (value > 65535) {
            value = 65535;
        }
    }
    return value;
}

/**
 * Whether the kernel, run in place, reads pixels it has already written anywhere but at the
 * edges: only the second pass can (a weight in rows 4…6 at column 3 or left of it reads, turned,
 * the rows above or the pixels before it in its row). Otherwise only the last column and the last
 * two rows differ from the filter over an untouched copy (`convolveAvs` with `edgesOnly`).
 */
export function convolutionRecursive(plan: ConvolutionPlan): boolean {
    if (!plan.inPlace || plan.passes < 2) {
        return false;
    }
    // A term multiplied by 0 reads nothing that counts (pmullw by the weight stored for the turned
    // place, which can be 0: mykaL — just another sound).
    const reads = (xs: Int32Array, ys: Int32Array, muls: Int32Array) => xs.some((x, e) => muls[e] !== 0 && (ys[e] < 3 || (ys[e] === 3 && x < 3)));
    return reads(plan.posX[1], plan.posY[1], plan.posMul[1]) || reads(plan.negX[1], plan.negY[1], plan.negMul[1]);
}

/**
 * The filter over an RGBA frame (top row first) of `width` × `height`, written to `out`: pass
 * the same array for a kernel that runs in place (plan.inPlace), as AVS does. The alpha bytes
 * become 255. Frames below 8 × 8 are not what the generated code was made for.
 *
 * `edgesOnly` (in place, a kernel that is not `convolutionRecursive`): only the pixels that read
 * pixels already written — columns w − 2 and w − 1 of the rows above the last two (w − 2 as
 * the last column reads it), then the last two rows. The frame needs to hold the picture as it
 * was at columns w − 5 … w − 1 and in row h − 2; the rest is not read.
 *
 * `interior(rows, k0, j)` (convolutionWasm.ts) may take columns 3 … of row j (row pointers
 * `rows`, the row at byte k0) and return the first column it left to this loop.
 */
export function convolveAvs(plan: ConvolutionPlan, src: Uint8Array, out: Uint8Array, width: number, height: number, edgesOnly = false,
    interior?: (rows: Int32Array, k0: number, j: number) => number) {
    const stride = width * 4;
    const passes = plan.passes;
    // The lists: pass 0 positive, pass 0 negative, pass 1 positive, pass 1 negative.
    const xs = [plan.posX[0], plan.negX[0], plan.posX[1], plan.negX[1]];
    const ys = [plan.posY[0], plan.negY[0], plan.posY[1], plan.negY[1]];
    const muls = [plan.posMul[0], plan.negMul[0], plan.posMul[1], plan.negMul[1]];
    const counts = xs.map((list) => list.length);
    const wraps = muls.map((list) => list.some((m) => m > 257));
    // Per row: each term's address for output column 3 (interior pixels add 4·(i − 3)); per edge
    // pixel: the clamped address.
    const bases = counts.map((count) => new Int32Array(count));
    const clamped = counts.map((count) => new Int32Array(count));
    const acc = [new Int32Array(3), new Int32Array(3), new Int32Array(3), new Int32Array(3)];
    const { posSaturate, negSaturate, posBias, negBias, hasNegative, mode, divShift, divMultiplier } = plan;
    const lists = passes * 2;
    const pixel = (at: Int32Array[], add: number, k: number) => {
        for (let l = 0; l < lists; l++) {
            if (counts[l]) {
                terms(src, at[l], add, muls[l], counts[l], wraps[l], acc[l]);
            }
        }
        for (let channel = 0; channel < 3; channel++) {
            let value = 0;
            for (let pass = 0; pass < passes; pass++) {
                let x = total(counts[pass * 2] ? acc[pass * 2][channel] : 0, posSaturate, posBias);
                if (hasNegative) {
                    const n = total(counts[pass * 2 + 1] ? acc[pass * 2 + 1][channel] : 0, negSaturate, negBias);
                    if (mode === 2) {
                        // psubsw: the words as signed, the difference cut to int16; then bit 15 off.
                        let d = (x >= 32768 ? x - 65536 : x) - (n >= 32768 ? n - 65536 : n);
                        d = d > 32767 ? 32767 : d < -32768 ? -32768 : d;
                        x = d & 0x7fff;
                    } else if (mode === 1) {
                        x = (x - n) & 0xffff;
                    } else {
                        x = x > n ? x - n : 0;
                    }
                }
                value = pass === 0 ? x : value + x > 65535 ? 65535 : value + x;
            }
            if (divShift >= 0) {
                value = divShift >= 16 ? 0 : value >>> divShift;
            } else if (divShift === -2) {
                value = Math.imul(value, divMultiplier) >>> 16;
            }
            out[k + channel] = value >= 32768 ? 0 : value > 255 ? 255 : value;
        }
        out[k + 3] = 255;
    };
    const lastCol = width - 2;
    const edge = (i: number, k: number) => {
        for (let l = 0; l < lists; l++) {
            const x = xs[l];
            const at = clamped[l];
            const base = bases[l];
            for (let e = 0; e < counts[l]; e++) {
                let col = i + x[e] - 3;
                if (i < 3) {
                    if (col < 0) col = 0;
                } else if (i >= width - 3 && col > lastCol) {
                    col = lastCol;
                }
                at[e] = base[e] + (col - x[e]) * 4;
            }
        }
        pixel(clamped, 0, k);
    };
    // Row pointers c[0…6], as row numbers.
    const rows = new Int32Array([0, 0, 0, 0, 1, 2, 3].map((row) => Math.min(row, height - 1)));
    for (let j = 0; j < height; j++) {
        for (let l = 0; l < lists; l++) {
            const x = xs[l];
            const y = ys[l];
            const base = bases[l];
            for (let e = 0; e < counts[l]; e++) {
                base[e] = rows[y[e]] * stride + x[e] * 4;
            }
        }
        const k0 = j * stride;
        if (edgesOnly && j < height - 2) {
            edge(width - 2, k0 + (width - 2) * 4);
            edge(width - 1, k0 + (width - 1) * 4);
        } else {
            edge(0, k0);
            edge(1, k0 + 4);
            edge(2, k0 + 8);
            const first = interior ? interior(rows, k0, j) : 3;
            for (let i = first, k = k0 + first * 4; i < width - 3; i++, k += 4) {
                pixel(bases, (i - 3) * 4, k);
            }
            for (let i = Math.max(3, width - 3); i < width; i++) {
                edge(i, k0 + i * 4);
            }
        }
        // c[0] = c[1] … c[5] = c[6]; c[6] one row on, unless that is the last row.
        const next = rows[6] + 1 === height - 1 ? rows[6] : rows[6] + 1;
        for (let r = 0; r < 6; r++) {
            rows[r] = rows[r + 1];
        }
        rows[6] = Math.min(next, height - 1);
    }
}
