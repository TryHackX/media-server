// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Movement's transformation table, as Nullsoft's vis_avs r_trans.cpp builds it
 * (BSD licence, see ../LICENSE-vis_avs.txt). No WebGL here: Movement.ts runs it
 * in a worker (movementWorker.ts) where it can, on the page where it must.
 */
import { cRand } from "../avsRandom";
import compileExpr from "../expr/compileExpr";

export const CUSTOM = 32767;
export const OFFSET_MASK = (1 << 22) - 1;

/** AVS's built-in effects in its own order (webvsc names them like this). */
const EFFECT_NAMES = [
    "none", "slight fuzzify", "shift rotate left", "big swirl out", "medium swirl", "sunburster",
    "swirl to center", "blocky partial out", "swirling around both ways at once", "bubbling outward",
    "bubbling outward with swirl", "5 pointed distro", "tunneling", "bleedin'", "shifted big swirl out",
    "psychotic beaming outward", "cosine radial 3-way", "spinny tube", "radial swirlies", "swill",
    "gridley", "grapevine", "quadrant", "6-way kaleida (use wrap!)",
];

/** Effects 18…23 were scripts even in AVS: [code, rectangular]. */
const EVAL_EFFECTS = {
    18: ["d = d * (1 - (sin((r-$PI*0.5) * 7) * .03));\nr = r + (cos(d * 12) * .03);", false],
    19: ["d = d * (1 - (sin((r - $PI*0.5) * 12) * .05));\nr = r + (cos(d * 18) * .05);\nd = d * (1-((d - .4) * .03));\nr = r + ((d - .4) * .13)", false],
    20: ["x = x + (cos(y * 18) * .02);\ny = y + (sin(x * 14) * .03);", true],
    21: ["x = x + (cos(abs(y-.5) * 8) * .02);\ny = y + (sin(abs(x-.5) * 8) * .05);\nx = x * .95;\ny = y * .95;", true],
    22: ["y = y * ( 1 + (sin(r + $PI/2) * .3) );\nx = x * ( 1 + (cos(r + $PI/2) * .3) );\nx = x * .995;\ny = y * .995;", true],
    23: ["y = (r*6)/($PI); x = d;", true],
};

/** Effects 3…17 in C (r_trans.cpp MAKE_REFFECT): r and d in pixels, r from atan2. */
const RADIAL = {
    3: (s) => { s.r += 0.1 - 0.2 * (s.d / s.maxD); s.d *= 0.96; },
    4: (s) => { s.d *= 0.99 * (1.0 - Math.sin(s.r) / 32.0); s.r += 0.03 * Math.sin(s.d / s.maxD * Math.PI * 4); },
    5: (s) => { s.d *= 0.94 + (Math.cos(s.r * 32.0) * 0.06); },
    6: (s) => { s.d *= 1.01 + (Math.cos(s.r * 4.0) * 0.04); s.r += 0.03 * Math.sin(s.d / s.maxD * Math.PI * 4); },
    8: (s) => { s.r += 0.1 * Math.sin(s.d / s.maxD * Math.PI * 5); },
    9: (s) => { const t = Math.sin(s.d / s.maxD * Math.PI); s.d -= 8 * t * t * t * t * t; },
    10: (s) => {
        let t = Math.sin(s.d / s.maxD * Math.PI);
        s.d -= 8 * t * t * t * t * t;
        t = Math.cos((s.d / s.maxD) * Math.PI / 2.0);
        s.r += 0.1 * t * t * t;
    },
    11: (s) => { s.d *= 0.95 + (Math.cos(s.r * 5.0 - Math.PI / 2.50) * 0.03); },
    12: (s) => { s.r += 0.04; s.d *= 0.96 + Math.cos(s.d / s.maxD * Math.PI) * 0.05; },
    13: (s) => { const t = Math.cos(s.d / s.maxD * Math.PI); s.r += 0.07 * t; s.d *= 0.98 + t * 0.10; },
    14: (s) => { s.r += 0.1 - 0.2 * (s.d / s.maxD); s.d *= 0.96; s.xo = 8; },
    15: (s) => { s.d = s.maxD * 0.15; },
    16: (s) => { s.r = Math.cos(s.r * 3); },
    17: (s) => { s.d *= (1 - (((s.d / s.maxD) - .35) * .5)); s.r += .1; },
};

/** C's (int) cast as x86 does it: truncation, and INT_MIN for NaN and overflow. */
function cInt(value: number): number {
    return value > -2147483649 && value < 2147483648 ? Math.trunc(value) : -2147483648;
}

/** The effect number of a converted Movement. */
export function movementEffectId(opts): number {
    const id = Number(opts.effectId);
    if (Number.isInteger(id) && (id === CUSTOM || (id >= 0 && id <= 23))) {
        return id;
    }
    const name = String(opts.builtinEffect || "").toLowerCase();
    if (name) {
        const index = EFFECT_NAMES.indexOf(name);
        return index >= 0 ? index : 0;
    }
    return String(opts.code || "").trim() ? CUSTOM : 0;
}

interface ITable {
    /** Per pixel: AVS's packed table entry (offset | partials << 22…31). */
    entries: Int32Array;
    subpixel: boolean;
}

/**
 * The transformation table, as r_trans.cpp builds it for a w × h frame.
 * `code` is the custom code (or null); `rect` its coordinate system.
 */
export function buildMovementTable(effect: number, w: number, h: number, options, main): ITable {
    const { code, rect, subpixel: wantSubpixel, wrap } = options;
    const entries = new Int32Array(w * h);
    const subpixel = Boolean(wantSubpixel) && w * h < (1 << 22)
        && ((effect >= 3 && effect <= 23 && effect !== 7) || effect === CUSTOM);

    // Where (tmp2, tmp1) lands, packed as AVS packs it.
    const pack = (tmp1: number, tmp2: number, rounding: number): number => {
        if (subpixel) {
            let oh = cInt(tmp1);
            let ow = cInt(tmp2);
            let xpartial = cInt(32.0 * (tmp2 - ow));
            let ypartial = cInt(32.0 * (tmp1 - oh));
            if (wrap) {
                ow %= (w - 1);
                oh %= (h - 1);
                if (ow < 0) { ow += w - 1; }
                if (oh < 0) { oh += h - 1; }
            } else {
                if (ow < 0) { xpartial = 0; ow = 0; }
                if (ow >= w - 1) { xpartial = 31; ow = w - 2; }
                if (oh < 0) { ypartial = 0; oh = 0; }
                if (oh >= h - 1) { ypartial = 31; oh = h - 2; }
            }
            return (ow + oh * w) | (ypartial << 22) | (xpartial << 27);
        }
        let oh = cInt(tmp1 + rounding);
        let ow = cInt(tmp2 + rounding);
        if (wrap) {
            ow %= w;
            oh %= h;
            if (ow < 0) { ow += w; }
            if (oh < 0) { oh += h; }
        } else {
            ow = Math.max(0, Math.min(w - 1, ow));
            oh = Math.max(0, Math.min(h - 1, oh));
        }
        return ow + oh * w;
    };

    if (effect === 1) {
        // Slight fuzzify: a random step of up to one pixel, fixed in the table.
        for (let p = 0; p < w * h; p++) {
            const dx = (cRand() % 3) - 1;
            const r = p + dx + ((cRand() % 3) - 1) * w;
            entries[p] = Math.min(w * h - 1, Math.max(r, 0));
        }
    } else if (effect === 2) {
        // Shift rotate left: each row from w/64 pixels further right, wrapping.
        let p = 0;
        for (let y = 0; y < h; y++) {
            let lp = Math.trunc(w / 64);
            for (let x = 0; x < w; x++) {
                entries[p + x] = p + lp++;
                if (lp >= w) { lp -= w; }
            }
            p += w;
        }
    } else if (effect === 7) {
        // Blocky partial out: one 2×2 block in every 4×4 moves out by 8/7.
        let p = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if ((x & 2) || (y & 2)) {
                    entries[p++] = x + y * w;
                } else {
                    const xp = Math.trunc(w / 2) + Math.trunc((((x & ~1) - Math.trunc(w / 2)) * 7) / 8);
                    const yp = Math.trunc(h / 2) + Math.trunc((((y & ~1) - Math.trunc(h / 2)) * 7) / 8);
                    entries[p++] = xp + yp * w;
                }
            }
        }
    } else if (RADIAL[effect]) {
        const formula = RADIAL[effect];
        const maxD = Math.sqrt((w * w + h * h) / 4.0);
        const halfW = Math.trunc(w / 2);
        const halfH = Math.trunc(h / 2);
        const state = { r: 0, d: 0, maxD, xo: 0, yo: 0 };
        let p = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const xd = x - halfW;
                const yd = y - halfH;
                state.d = Math.sqrt(xd * xd + yd * yd);
                state.r = Math.atan2(yd, xd);
                state.xo = 0;
                state.yo = 0;
                formula(state);
                // AVS adds 0.5 here before the subpixel split as well.
                const tmp1 = (halfH + Math.sin(state.r) * state.d + 0.5) + (state.yo * h) * (1.0 / 256.0);
                const tmp2 = (halfW + Math.cos(state.r) * state.d + 0.5) + (state.xo * w) * (1.0 / 256.0);
                entries[p++] = pack(tmp1, tmp2, 0);
            }
        }
    } else {
        // Script: custom code, or one of the effects AVS itself ran as a script.
        const source = effect === CUSTOM ? String(code || "") : EVAL_EFFECTS[effect][0];
        const isRect = effect === CUSTOM ? Boolean(rect) : EVAL_EFFECTS[effect][1];
        let instance = null;
        if (source.trim()) {
            try {
                instance = compileExpr({ perPixel: source, _dialect: options.dialect }, ["perPixel"], [], []).codeInst;
                instance.setup(main);
            } catch (error) {
                instance = null;
            }
        }
        if (!instance || typeof instance.perPixel !== "function" || (instance.compiled && !instance.compiled.perPixel)) {
            // AVS: code that does not compile (no code handle) leaves every pixel where it is,
            // without the subpixel read.
            for (let p = 0; p < w * h; p++) {
                entries[p] = p;
            }
            return { entries, subpixel: false };
        }
        for (const name of ["d", "r", "x", "y"]) {
            instance[name] = 0;
        }
        instance.sw = w;
        instance.sh = h;
        const maxD = Math.sqrt(w * w + h * h) / 2.0;
        const inverseMaxD = 1.0 / maxD;
        const halfW = Math.trunc(w / 2);
        const halfH = Math.trunc(h / 2);
        const xScale = 1.0 / halfW;
        const yScale = 1.0 / halfH;
        let p = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const xd = x - halfW;
                const yd = y - halfH;
                instance.x = xd * xScale;
                instance.y = yd * yScale;
                instance.d = Math.sqrt(xd * xd + yd * yd) * inverseMaxD;
                instance.r = Math.atan2(yd, xd) + Math.PI * 0.5;
                instance.perPixel();
                let tmp1;
                let tmp2;
                if (!isRect) {
                    const d = Number(instance.d) * maxD;
                    const r = Number(instance.r) - Math.PI / 2.0;
                    tmp1 = halfH + Math.sin(r) * d;
                    tmp2 = halfW + Math.cos(r) * d;
                } else {
                    tmp1 = (Number(instance.y) + 1.0) * halfH;
                    tmp2 = (Number(instance.x) + 1.0) * halfW;
                }
                entries[p++] = pack(tmp1, tmp2, 0.5);
            }
        }
    }
    return { entries, subpixel };
}

/**
 * The table as Movement's texture: per pixel (AVS rows, top first) the source
 * column, the source row and the two 8-bit fractions BLEND4 gets ((partial << 3),
 * 0…248; 0 without subpixel).
 */
export function tableTextureData(entries: Int32Array, subpixel: boolean, w: number, h: number): Float32Array {
    const data = new Float32Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
        const entry = entries[p];
        const offset = subpixel ? entry & OFFSET_MASK : entry;
        data[p * 4] = offset % w;
        data[p * 4 + 1] = Math.floor(offset / w);
        data[p * 4 + 2] = subpixel ? (entry >> 24) & (31 << 3) : 0;
        data[p * 4 + 3] = subpixel ? (entry >> 19) & (31 << 3) : 0;
    }
    return data;
}

/** Source mapping's points: per pixel, where it goes (clip space) and where it is (texture). */
export function scatterPoints(data: Float32Array, w: number, h: number): Float32Array {
    const points = new Float32Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
        const x = p % w;
        const y = Math.floor(p / w);
        points[p * 4] = ((data[p * 4] + 0.5) / w) * 2 - 1;
        points[p * 4 + 1] = 1 - ((data[p * 4 + 1] + 0.5) / h) * 2;
        points[p * 4 + 2] = (x + 0.5) / w;
        points[p * 4 + 3] = 1 - (y + 0.5) / h;
    }
    return points;
}

/**
 * Whether the table has to be built on the page: code that reads the global
 * registers or gmegabuf sees what the other effects left there (a worker has
 * its own, empty ones). The effects without a formula are cheap anyway.
 */
export function needsPage(effect: number, code: string): boolean {
    if (effect === 1 || effect === 2 || effect === 7) {
        return true;
    }
    return effect === CUSTOM && /\b(reg\d\d|gmegabuf)\b/i.test(String(code || ""));
}
