/**
 * Texer II's DrawParticle (e_texer2.cpp in grandchild/vis_avs, BSD licence; Acko.net's APE), pixel for
 * pixel as its MMX did it, on a frame on the processor. Pure (no imports): TexerII.ts draws with it,
 * texerParticle.test.ts checks it against the plain port it was written from.
 *
 * - "resize": the bitmap scaled to sizex × sizey with Texer II's own fixed-point bilinear filter
 *   (16.16 steps, 8-bit fractions, each product shifted right), always through the colour filter
 *   (without "colorize" a white one: × 255 >> 8);
 * - otherwise the bitmap at its size less one pixel each way, as its rectangle came out, multiplied
 *   by the colour (>> 8) only with "colorize";
 * - the ten line blend modes of Set Render Mode in Texer II's own arithmetic: 50/50 is (a + b) >> 1,
 *   multiply and "adjustable" shift the products right by 8 (resize and plain weigh "adjustable" the
 *   other way round, as the original does).
 *
 * The loops are written for speed (a bitmap row's horizontal pass shared by the output rows that read
 * it, one blend switch a pixel, channels unrolled, the bitmap padded with zeros so a filter tap past
 * its end reads 0 as the port's `?? 0` did); the arithmetic is the port's.
 */

export const REPLACE = 0, ADDITIVE = 1, MAXIMUM = 2, AVERAGE = 3, SUB1 = 4, SUB2 = 5, MULTIPLY = 6, ADJUSTABLE = 7, XOR = 8, MINIMUM = 9;

export interface ITexture {
    /** RGBA, top row first, width × height pixels (and possibly zeros after them). */
    data: Uint8Array;
    width: number;
    height: number;
}

/** The x87's fistp in its default mode: to the nearest integer, halves to the even one. */
export function fistp(value: number): number {
    if (!(value > -2147483649 && value < 2147483648)) {
        return -2147483648;
    }
    const floor = Math.floor(value);
    const fraction = value - floor;
    return fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/** C's (int) of a double: towards zero, 0x80000000 out of range. */
export function cInt(value: number): number {
    return value > -2147483649 && value < 2147483648 ? Math.trunc(value) : -2147483648;
}

/** A texture's pixels with two rows of zeros after them: every filter tap stays inside the array. */
export function paddedTexture(data: Uint8Array, width: number, height: number): ITexture {
    const padded = new Uint8Array(data.length + (width + 2) * 4 * 2);
    padded.set(data);
    return { data: padded, width, height };
}

/** One blend of the resize path: dest channel `d`, the filtered texel `p` (0…255). */
function blendScaled(mode: number, d: number, p: number, alpha: number): number {
    switch (mode) {
        case ADDITIVE: return Math.min(255, d + p);
        case MAXIMUM: return p > d ? p : d;
        case AVERAGE: return (p + d) >> 1;
        case SUB1: return d > p ? d - p : 0;
        case SUB2: return p > d ? p - d : 0;
        case MULTIPLY: return (d * p) >> 8;
        case ADJUSTABLE: return Math.min(255, ((d * (255 - alpha)) >> 8) + ((p * alpha) >> 8));
        case XOR: return p ^ d;
        case MINIMUM: return p < d ? p : d;
        default: return p;
    }
}

/** One blend of the plain path: dest `d`, texel `t`, colour channel `c` (−1: no colorize). */
function blendPlain(mode: number, d: number, t: number, c: number, alpha: number): number {
    if (mode === MULTIPLY) {
        // ((dest · texel) >> 8) · colour >> 8
        const product = (d * t) >> 8;
        return c < 0 ? product : (product * c) >> 8;
    }
    const p = c < 0 ? t : (t * c) >> 8;
    switch (mode) {
        case ADDITIVE: return Math.min(255, d + p);
        case MAXIMUM: return p > d ? p : d;
        case AVERAGE: return (d + p) >> 1;
        case SUB1: return d > p ? d - p : 0;
        case SUB2: return p > d ? p - d : 0;
        case ADJUSTABLE: return Math.min(65535, d * alpha + p * (256 - alpha)) >> 8;
        case XOR: return p ^ d;
        case MINIMUM: return p < d ? p : d;
        default: return p;
    }
}

/** Where the resize path draws a particle: rows top2…bottom2 and columns left2…right2 of the frame, the
 *  bitmap position at their first pixel (cx0, cy0, 16.16) and its steps (sdx, sdy). */
export interface ResizeGeometry {
    left2: number;
    top2: number;
    right2: number;
    bottom2: number;
    cx0: number;
    cy0: number;
    sdx: number;
    sdy: number;
}

const scratchGeometry: ResizeGeometry = { left2: 0, top2: 0, right2: 0, bottom2: 0, cx0: 0, cy0: 0, sdx: 0, sdy: 0 };

/**
 * The resize path's rectangle and fixed-point walk for a texture of `width` × `height` at (x, y) in
 * −1…1, `sizex` × `sizey`, on a W × H frame, into `out`; null when nothing of it is drawn.
 */
export function resizeGeometry(W: number, H: number, width: number, height: number, x: number, y: number,
                               sizex: number, sizey: number, out: ResizeGeometry): ResizeGeometry | null {
    const w = W - 1;
    const h = H - 1;
    const iw = width - 1;
    const ih = height - 1;
    const left = -iw * 0.5 * sizex + 0.5 + (x * 0.5 + 0.5) * w;
    const top = -ih * 0.5 * sizey + 0.5 + (y * 0.5 + 0.5) * h;
    const right = (iw - 1) * 0.5 * sizex + 0.5 + (x * 0.5 + 0.5) * w;
    const bottom = (ih - 1) * 0.5 * sizey + 0.5 + (y * 0.5 + 0.5) * h;
    let left2 = fistp(left);
    let top2 = fistp(top);
    let right2 = fistp(right);
    let bottom2 = fistp(bottom);
    if (right2 < 0 || left2 > w || bottom2 < 0 || top2 > h) {
        return null;
    }
    let x0 = (0.5 - ((left + 0.5) - cInt(left + 0.5))) / (right - left);
    let y0 = (0.5 - ((top + 0.5) - cInt(top + 0.5))) / (bottom - top);
    if (left < 0) {
        x0 = -left / (right - left);
        left2 = 0;
    }
    if (top < 0) {
        y0 = -top / (bottom - top);
        top2 = 0;
    }
    if (right > w) {
        right2 = w;
    }
    if (bottom > h) {
        bottom2 = h;
    }
    const fx0 = x0 * iw;
    const fy0 = y0 * ih;
    let cx0 = fistp(fx0);
    let cy0 = fistp(fy0);
    const dx = 65535 - cInt((0.5 - (fx0 - cx0)) * 65536.0);
    const dy = 65535 - cInt((0.5 - (fy0 - cy0)) * 65536.0);
    const sdx = cInt(((iw - 1) / (right - left + 1)) * 65536.0);
    const sdy = cInt(((ih - 1) / (bottom - top + 1)) * 65536.0);
    cx0 = ((cx0 << 16) + dx) | 0;
    cy0 = ((cy0 << 16) + dy) | 0;
    if (cx0 < 0) {
        cx0 = (cx0 + sdx) | 0;
        ++left2;
    }
    if (cy0 < 0) {
        cy0 = (cy0 + sdy) | 0;
        ++top2;
    }
    if (right2 <= left2 || bottom2 <= top2) {
        return null;
    }
    out.left2 = left2;
    out.top2 = top2;
    out.right2 = right2;
    out.bottom2 = bottom2;
    out.cx0 = cx0;
    out.cy0 = cy0;
    out.sdx = sdx;
    out.sdy = sdy;
    return out;
}

/**
 * The resize path's walk across a particle for the GPU (texerGpu.ts): for column k (0…right2 − left2)
 * the bitmap column (ebx >>> 16) and x fraction ((ebx & 0xffff) >>> 8) of ebx = cx0 + k·sdx as an int,
 * the column clamped to `limit` (the bitmap's pixel count: from there on every tap reads 0 anyway).
 */
export function walkColumns(g: ResizeGeometry, limit: number, emit: (column: number, fraction: number) => void): void {
    const count = g.right2 - g.left2 + 1;
    for (let k = 0; k < count; k++) {
        const ebx = (g.cx0 + Math.imul(k, g.sdx)) | 0;
        emit(Math.min(ebx >>> 16, limit), (ebx & 0xffff) >>> 8);
    }
}

/** The same down a particle: the first pixel of the bitmap row (row · width, clamped) and the y fraction. */
export function walkRows(g: ResizeGeometry, width: number, limit: number, emit: (base: number, fraction: number) => void): void {
    const count = g.bottom2 - g.top2 + 1;
    for (let j = 0; j < count; j++) {
        const cy = (g.cy0 + Math.imul(j, g.sdy)) | 0;
        emit(Math.min((cy >>> 16) * width, limit), (cy & 0xffff) >>> 8);
    }
}

// Work arrays of the resize path (kept from particle to particle).
let columns = new Int32Array(64);
let fractions = new Int32Array(64);
let upperTaps = new Int32Array(192);
let lowerTaps = new Int32Array(192);

/** f(left, right) of bitmap row `base` (its first pixel's index) at every column, 3 channels each. */
function horizontal(tex: Uint8Array, base: number, count: number, into: Int32Array): void {
    for (let k = 0, j = 0; k < count; k++, j += 3) {
        const fx = fractions[k]!;
        const fxi = fx ^ 255;
        const a = (base + columns[k]!) * 4;
        // (A tap past the padded bitmap reads undefined: NaN through `>> 8` is 0, as `?? 0` was.)
        into[j] = ((tex[a + 4]! * fx) >> 8) + ((tex[a]! * fxi) >> 8);
        into[j + 1] = ((tex[a + 5]! * fx) >> 8) + ((tex[a + 1]! * fxi) >> 8);
        into[j + 2] = ((tex[a + 6]! * fx) >> 8) + ((tex[a + 2]! * fxi) >> 8);
    }
}

/**
 * DrawParticle into `frame` (RGBA, row 0 at the top, W × H): the texture's centre at (x, y) in −1…1,
 * `sizex` × `sizey`, colour 0xRRGGBB.
 */
export function drawParticle(frame: Uint8Array, W: number, H: number, texture: ITexture, x: number, y: number,
                             sizex: number, sizey: number, color: number, resize: boolean, colorize: boolean,
                             mode: number, alpha: number): void {
    const w = W - 1;
    const h = H - 1;
    const iw0 = texture.width;
    const iw = iw0 - 1;
    const ih = texture.height - 1;
    const tex = texture.data;
    const cr = (color >> 16) & 255;
    const cg = (color >> 8) & 255;
    const cb = color & 255;
    if (resize) {
        const g = resizeGeometry(W, H, iw0, texture.height, x, y, sizex, sizey, scratchGeometry);
        if (!g) {
            return;
        }
        const left2 = g.left2;
        const top2 = g.top2;
        const right2 = g.right2;
        const bottom2 = g.bottom2;
        const cx0 = g.cx0;
        const sdx = g.sdx;
        const sdy = g.sdy;
        let cy0 = g.cy0;
        const tot = right2 - left2;
        // Every output row walks the same columns: their bitmap column and x fraction once.
        const count = tot + 1;
        if (columns.length < count) {
            columns = new Int32Array(count * 2);
            fractions = new Int32Array(count * 2);
            upperTaps = new Int32Array(count * 6);
            lowerTaps = new Int32Array(count * 6);
        }
        let ebx = cx0;
        for (let k = 0; k < count; k++) {
            columns[k] = ebx >>> 16;
            fractions[k] = (ebx & 0xffff) >>> 8;
            ebx = (ebx + sdx) | 0;
        }
        // The horizontal pass of a bitmap row, f(left, right) = ((right·fx) >> 8) + ((left·(fx^255)) >> 8)
        // per channel, is the same for every output row that reads it: as the upper taps of one
        // output row and the lower taps of the row before. Kept for the rows that share it.
        let upper = upperTaps;
        let lower = lowerTaps;
        let upperRow = -1;
        let lowerRow = -1;
        for (let row = top2; row <= bottom2; ++row) {
            const fy = (cy0 & 0xffff) >>> 8;
            const fyi = fy ^ 255;
            const at = cy0 >>> 16;
            if (at !== upperRow) {
                if (at === lowerRow) {
                    const swap = upper;
                    upper = lower;
                    lower = swap;
                    lowerRow = upperRow;
                } else {
                    horizontal(tex, at * iw0, count, upper);
                }
                upperRow = at;
            }
            if (lowerRow !== at + 1) {
                horizontal(tex, (at + 1) * iw0, count, lower);
                lowerRow = at + 1;
            }
            let out = (row * W + left2) * 4;
            for (let k = 0, j = 0; k < count; k++, j += 3) {
                const r = ((((((lower[j]! * fy) >> 8) + ((upper[j]! * fyi) >> 8)) & 0xffff) * cr) & 0xffff) >>> 8;
                const g = ((((((lower[j + 1]! * fy) >> 8) + ((upper[j + 1]! * fyi) >> 8)) & 0xffff) * cg) & 0xffff) >>> 8;
                const b = ((((((lower[j + 2]! * fy) >> 8) + ((upper[j + 2]! * fyi) >> 8)) & 0xffff) * cb) & 0xffff) >>> 8;
                switch (mode) {
                    case MAXIMUM: {
                        if (r > frame[out]!) frame[out] = r;
                        if (g > frame[out + 1]!) frame[out + 1] = g;
                        if (b > frame[out + 2]!) frame[out + 2] = b;
                        break;
                    }
                    case ADDITIVE: {
                        // Uint8Array stores the low byte: saturate first.
                        const s0 = frame[out]! + r, s1 = frame[out + 1]! + g, s2 = frame[out + 2]! + b;
                        frame[out] = s0 > 255 ? 255 : s0;
                        frame[out + 1] = s1 > 255 ? 255 : s1;
                        frame[out + 2] = s2 > 255 ? 255 : s2;
                        break;
                    }
                    case REPLACE:
                        frame[out] = r;
                        frame[out + 1] = g;
                        frame[out + 2] = b;
                        break;
                    default:
                        frame[out] = blendScaled(mode, frame[out]!, r, alpha);
                        frame[out + 1] = blendScaled(mode, frame[out + 1]!, g, alpha);
                        frame[out + 2] = blendScaled(mode, frame[out + 2]!, b, alpha);
                }
                out += 4;
            }
            cy0 = (cy0 + sdy) | 0;
        }
        return;
    }
    // The plain renderer: the bitmap where it falls, by whole pixels.
    const left = fistp((x * 0.5 + 0.5) * w) - Math.trunc(iw / 2);
    const top = fistp((y * 0.5 + 0.5) * h) - Math.trunc(ih / 2);
    const right = left + iw - 1;
    const bottom = top + ih - 1;
    let left2 = left;
    let top2 = top;
    let right2 = right;
    let bottom2 = bottom;
    if (right2 < 0 || left2 > w || bottom2 < 0 || top2 > h) {
        return;
    }
    let x0 = 0.0;
    let y0 = 0.0;
    if (left < 0) {
        x0 = -left / (right - left);
        left2 = 0;
    }
    if (top < 0) {
        y0 = -top / (bottom - top);
        top2 = 0;
    }
    if (right > w) {
        right2 = w;
    }
    if (bottom > h) {
        bottom2 = h;
    }
    if (right2 <= left2 || bottom2 <= top2) {
        return;
    }
    const cx0 = fistp(x0 * iw);
    let ty = fistp(y0 * ih);
    const tot = right2 - left2;
    const kr = colorize ? cr : -1;
    const kg = colorize ? cg : -1;
    const kb = colorize ? cb : -1;
    for (let row = top2; row <= bottom2; ++row) {
        let input = (ty * iw0 + cx0) * 4;
        let out = (row * W + left2) * 4;
        for (let k = 0; k <= tot; k++) {
            frame[out] = blendPlain(mode, frame[out]!, tex[input] ?? 0, kr, alpha);
            frame[out + 1] = blendPlain(mode, frame[out + 1]!, tex[input + 1] ?? 0, kg, alpha);
            frame[out + 2] = blendPlain(mode, frame[out + 2]!, tex[input + 2] ?? 0, kb, alpha);
            input += 4;
            out += 4;
        }
        ++ty;
    }
}
