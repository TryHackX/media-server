import assert from "node:assert/strict";
import test from "node:test";

import { drawParticle, paddedTexture, resizeGeometry, walkColumns, walkRows } from "./texerParticle.ts";
import type { ResizeGeometry } from "./texerParticle.ts";

// The plain port of e_texer2.cpp's DrawParticle that texerParticle.ts was written from (TexerII.ts
// until 10.11.2026), kept here as the reference.
const REPLACE = 0, ADDITIVE = 1, MAXIMUM = 2, AVERAGE = 3, SUB1 = 4, SUB2 = 5, MULTIPLY = 6, ADJUSTABLE = 7, XOR = 8, MINIMUM = 9;

/** The x87's fistp in its default mode: to the nearest integer, halves to the even one. */
function fistp(value: number): number {
    if (!(value > -2147483649 && value < 2147483648)) {
        return -2147483648;
    }
    const floor = Math.floor(value);
    const fraction = value - floor;
    return fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/** C's (int) of a double: towards zero, 0x80000000 out of range. */
function cInt(value: number): number {
    return value > -2147483649 && value < 2147483648 ? Math.trunc(value) : -2147483648;
}

/** One blend of Texer II, resize path: dest channel `d`, the filtered texel `p` (0…255). */
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

/** One blend of Texer II, plain path: dest `d`, texel `t`, colour channel `c` (null: no colorize). */
function blendPlain(mode: number, d: number, t: number, c: number | null, alpha: number): number {
    if (mode === MULTIPLY) {
        // ((dest · texel) >> 8) · colour >> 8
        const product = (d * t) >> 8;
        return c === null ? product : (product * c) >> 8;
    }
    const p = c === null ? t : (t * c) >> 8;
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

interface ITexture {
    data: Uint8Array;
    width: number;
    height: number;
}

/**
 * DrawParticle (e_texer2.cpp) into `frame` (RGBA, row 0 at the top, W × H): the texture's
 * centre at (x, y) in −1…1, `sizex` × `sizey`, colour 0xRRGGBB.
 */
function referenceDrawParticle(frame: Uint8Array, W: number, H: number, texture: ITexture, x: number, y: number,
                             sizex: number, sizey: number, color: number, resize: boolean, colorize: boolean,
                             mode: number, alpha: number) {
    const w = W - 1;
    const h = H - 1;
    const iw0 = texture.width;
    const iw = iw0 - 1;
    const ih = texture.height - 1;
    const tex = texture.data;
    const colors = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
    if (resize) {
        const left = -iw * 0.5 * sizex + 0.5 + (x * 0.5 + 0.5) * w;
        const top = -ih * 0.5 * sizey + 0.5 + (y * 0.5 + 0.5) * h;
        const right = (iw - 1) * 0.5 * sizex + 0.5 + (x * 0.5 + 0.5) * w;
        const bottom = (ih - 1) * 0.5 * sizey + 0.5 + (y * 0.5 + 0.5) * h;
        let left2 = fistp(left);
        let top2 = fistp(top);
        let right2 = fistp(right);
        let bottom2 = fistp(bottom);
        if (right2 < 0 || left2 > w || bottom2 < 0 || top2 > h) {
            return;
        }
        const fractional = (value: number) => value - cInt(value);
        let x0 = (0.5 - fractional(left + 0.5)) / (right - left);
        let y0 = (0.5 - fractional(top + 0.5)) / (bottom - top);
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
            return;
        }
        const tot = right2 - left2;
        for (let row = top2; row <= bottom2; ++row) {
            const fy = (cy0 & 0xffff) >>> 8;
            const rowBase = (cy0 >>> 16) * iw0;
            let ebx = cx0;
            let out = (row * W + left2) * 4;
            for (let k = 0; k <= tot; k++) {
                const fx = (ebx & 0xffff) >>> 8;
                const a = (rowBase + (ebx >>> 16)) * 4;
                const c = a + iw0 * 4;
                for (let ch = 0; ch < 3; ch++) {
                    const ta = tex[a + ch] ?? 0;
                    const tb = tex[a + 4 + ch] ?? 0;
                    const tc = tex[c + ch] ?? 0;
                    const td = tex[c + 4 + ch] ?? 0;
                    const upper = ((tb * fx) >> 8) + ((ta * (fx ^ 255)) >> 8);
                    const lower = ((tc * (fx ^ 255)) >> 8) + ((td * fx) >> 8);
                    const t = (((lower * fy) >> 8) + ((upper * (fy ^ 255)) >> 8)) & 0xffff;
                    const p = ((t * colors[ch]) & 0xffff) >>> 8;
                    frame[out + ch] = blendScaled(mode, frame[out + ch], p, alpha);
                }
                ebx = (ebx + sdx) | 0;
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
    for (let row = top2; row <= bottom2; ++row) {
        let input = (ty * iw0 + cx0) * 4;
        let out = (row * W + left2) * 4;
        for (let k = 0; k <= tot; k++) {
            for (let ch = 0; ch < 3; ch++) {
                frame[out + ch] = blendPlain(mode, frame[out + ch], tex[input + ch] ?? 0, colorize ? colors[ch] : null, alpha);
            }
            input += 4;
            out += 4;
        }
        ++ty;
    }
}


/** Small LCG for reproducible inputs. */
function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function bitmap(rnd: () => number, width: number, height: number): Uint8Array {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256);
    return data;
}

test("drawParticle: every mode, both paths, edges and sizes, the same pixels as the plain port", () => {
    const rnd = random(20261110);
    let drawn = 0;
    for (let round = 0; round < 1500; round++) {
        const W = 32 + Math.floor(rnd() * 120);
        const H = 24 + Math.floor(rnd() * 90);
        const tw = 2 + Math.floor(rnd() * 30);
        const th = 2 + Math.floor(rnd() * 30);
        const data = bitmap(rnd, tw, th);
        const base = bitmap(rnd, W, H);
        const a = base.slice();
        const b = base.slice();
        const x = rnd() * 2.6 - 1.3;
        const y = rnd() * 2.6 - 1.3;
        const sizex = rnd() < 0.2 ? 0.02 + rnd() * 0.3 : 0.2 + rnd() * 4;
        const sizey = rnd() < 0.2 ? 0.02 + rnd() * 0.3 : 0.2 + rnd() * 4;
        const color = Math.floor(rnd() * 0x1000000);
        const resize = rnd() < 0.75;
        const colorize = rnd() < 0.5;
        const mode = Math.floor(rnd() * 11) % 10;
        const alpha = Math.floor(rnd() * 256);
        referenceDrawParticle(a, W, H, { data, width: tw, height: th }, x, y, sizex, sizey, color, resize, colorize, mode, alpha);
        drawParticle(b, W, H, paddedTexture(data, tw, th), x, y, sizex, sizey, color, resize, colorize, mode, alpha);
        assert.deepEqual(b, a, `round ${round}: mode ${mode} resize ${resize}`);
        if (!a.every((v, i) => v === base[i])) drawn++;
    }
    assert.ok(drawn > 900, `${drawn} rounds changed the frame`);
});

test("drawParticle: an unpadded bitmap draws the same as a padded one", () => {
    const rnd = random(7);
    for (let round = 0; round < 200; round++) {
        const data = bitmap(rnd, 9, 7);
        const base = bitmap(rnd, 64, 48);
        const a = base.slice();
        const b = base.slice();
        const args = [rnd() * 2 - 1, rnd() * 2 - 1, 0.5 + rnd() * 3, 0.5 + rnd() * 3, 0xffffff, true, false, Math.floor(rnd() * 10), 128] as const;
        drawParticle(a, 64, 48, { data, width: 9, height: 7 }, ...args);
        drawParticle(b, 64, 48, paddedTexture(data, 9, 7), ...args);
        assert.deepEqual(a, b);
    }
});

/**
 * What texerGpu.ts's fragment shader computes for a pixel, from the same tables (walkColumns, walkRows)
 * and with its operations (whole numbers, floor of products over 256, mod 65536), blended as GL does
 * in the direct modes. Checks that the GPU's arithmetic is the processor's.
 */
function gpuEmulated(frame: Uint8Array, W: number, data: Uint8Array, width: number, pixels: number,
                     g: ResizeGeometry, color: number, mode: number) {
    const columns: [number, number][] = [];
    const rows: [number, number][] = [];
    walkColumns(g, pixels, (c, f) => columns.push([c, f]));
    walkRows(g, width, pixels, (b, f) => rows.push([b, f]));
    const tap = (index: number, ch: number) => (index >= pixels ? 0 : data[index * 4 + ch]!);
    const cs = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
    for (let j = 0; j < rows.length; j++) {
        const [rowBase, fy] = rows[j]!;
        for (let k = 0; k < columns.length; k++) {
            const [col, fx] = columns[k]!;
            const at = rowBase + col;
            const out = ((g.top2 + j) * W + g.left2 + k) * 4;
            for (let ch = 0; ch < 3; ch++) {
                const a = tap(at, ch), b = tap(at + 1, ch), c = tap(at + width, ch), d = tap(at + width + 1, ch);
                const upper = Math.floor((b * fx) / 256) + Math.floor((a * (255 - fx)) / 256);
                const lower = Math.floor((c * (255 - fx)) / 256) + Math.floor((d * fx) / 256);
                const t = (Math.floor((lower * fy) / 256) + Math.floor((upper * (255 - fy)) / 256)) % 65536;
                const p = Math.floor(((t * cs[ch]!) % 65536) / 256);
                const dest = frame[out + ch]!;
                frame[out + ch] = mode === 1 ? Math.min(255, dest + p) : mode === 2 ? Math.max(dest, p)
                    : mode === 4 ? Math.max(0, dest - p) : mode === 5 ? Math.max(0, p - dest) : mode === 9 ? Math.min(dest, p) : p;
            }
        }
    }
}

test("the GPU resize path's arithmetic (tables + per-pixel formula) gives the processor's pixels", () => {
    const rnd = random(424242);
    const geometry: ResizeGeometry = { left2: 0, top2: 0, right2: 0, bottom2: 0, cx0: 0, cy0: 0, sdx: 0, sdy: 0 };
    let drawn = 0;
    for (let round = 0; round < 1200; round++) {
        const W = 40 + Math.floor(rnd() * 140);
        const H = 30 + Math.floor(rnd() * 100);
        const tw = 2 + Math.floor(rnd() * 40);
        const th = 2 + Math.floor(rnd() * 40);
        const data = bitmap(rnd, tw, th);
        const base = bitmap(rnd, W, H);
        const cpu = base.slice();
        const gpu = base.slice();
        const x = rnd() * 2.8 - 1.4, y = rnd() * 2.8 - 1.4;
        const sx = rnd() < 0.2 ? 0.02 + rnd() * 0.4 : 0.2 + rnd() * 5;
        const sy = rnd() < 0.2 ? 0.02 + rnd() * 0.4 : 0.2 + rnd() * 5;
        const color = Math.floor(rnd() * 0x1000000);
        const mode = [0, 1, 2, 4, 5, 9][Math.floor(rnd() * 6)]!;
        drawParticle(cpu, W, H, paddedTexture(data, tw, th), x, y, sx, sy, color, true, rnd() < 0.5, mode, 128);
        const g = resizeGeometry(W, H, tw, th, x, y, sx, sy, geometry);
        if (g) gpuEmulated(gpu, W, data, tw, tw * th, g, color, mode);
        assert.deepEqual(gpu, cpu, `round ${round}, mode ${mode}`);
        if (!cpu.every((v, i) => v === base[i])) drawn++;
    }
    assert.ok(drawn > 700, `${drawn} rounds drew`);
});
