// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Drawing the way AVS's own render effects drew (Nullsoft's vis_avs, BSD licence:
 * linedraw.cpp, r_defs.h, matrix.cpp), pixel for pixel.
 *
 * - `avsLine` is linedraw.cpp's line(): AVS's Bresenham, the end pixel left out,
 *   the width as a run of `lw` pixels across the line, its clipping (which does not
 *   correct the error term) and all.
 * - Pixels are written through the plotter in the order AVS wrote them and blended
 *   with BLEND_LINE's ten modes in whole 0…255 levels (`AVS_BLEND_GLSL`). AVS blended
 *   each write into what the write before it had left, so a pixel written twice with
 *   additive got both colours: modes where that adds up to one write of a combined
 *   colour (replace, additive, maximum, minimum, subtractive 1, XOR) are folded into
 *   one write a pixel; the others are drawn in passes, the n-th write to a pixel in
 *   pass n.
 * - `avsVisdata` is AVS's visdata, left and right: the waveform as signed bytes, the
 *   spectrum as unsigned ones (Winamp's bytes, avs/winamp-visdata.ts); `avsChannel` is the
 *   `fa_data` an effect read from it, its centre made as AVS made it.
 */
import { avsCenter, createVisdata } from "../winamp-visdata";
import { HIGH_PRECISION } from "./avsSupport";
import { cpuFrameRunOf, plotterFast } from "./cpuFrameRun";
import type { CpuFrameRun } from "./cpuFrameRun";
import { WebGLVarType } from "./utils";
import Buffer from "./webgl/Buffer";
import ShaderProgram from "./webgl/ShaderProgram";

/** BLEND_LINE's modes (r_defs.h) by the names avsBlend() gives Set Render Mode's. */
const LINE_MODES = {
    REPLACE: 0, ADDITIVE: 1, MAXIMUM: 2, AVERAGE: 3, SUBTRACTIVE1: 4, SUBTRACTIVE2: 5,
    MULTIPLY: 6, ADJUSTABLE: 7, XOR: 8, MINIMUM: 9,
};
export const BLEND_REPLACE = 0;
export const BLEND_ADDITIVE = 1;
export const BLEND_AVERAGE = 3;

/**
 * The line blend mode, its adjustable value and the line width in this screen's
 * pixels: g_line_blend_mode as the last Set Render Mode left it (none: replace, 1
 * pixel), the width scaled like the Super Scope's (AVS drew in a window about 480
 * lines tall).
 */
export function avsLineMode(main): { mode: number; adjust: number; width: number; avsWidth: number } {
    const set = main.avsRenderMode;
    const scale = main.avsScale || 1;
    if (!set) {
        return { adjust: 0, avsWidth: 1, mode: 0, width: Math.max(1, Math.round(scale)) };
    }
    const mode = LINE_MODES[String(set.blend || "").toUpperCase()];
    const avsWidth = Math.max(1, Math.min(255, Math.trunc(Number(set.lineSize) || 1)));
    return {
        adjust: Math.max(0, Math.min(255, Math.trunc(Number(set.adjust) || 0))),
        // the width AVS itself drew with, for lines that sit side by side (solid scopes)
        avsWidth,
        mode: mode === undefined ? 0 : mode,
        width: Math.max(1, Math.round(avsWidth * scale)),
    };
}

/** "#rrggbb" as AVS keeps a colour: 0x00RRGGBB (blue in the low byte). */
export function avsColor(value): number {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value || "").trim());
    return match ? parseInt(match[1], 16) : 0;
}

/**
 * The colour cycle of Dot Grid, Oscilloscope Star and Rotating Stars: 64 frames
 * from each colour to the next, weights 63 − r and r over 64 (so one colour alone
 * is drawn at 63/64 of itself). `position` is the already advanced color_pos.
 */
export function avsCycleColor(colors: number[], position: number): number {
    const p = Math.floor(position / 64);
    const r = position & 63;
    const c1 = colors[p];
    const c2 = p + 1 < colors.length ? colors[p + 1] : colors[0];
    const r1 = Math.floor(((c1 & 255) * (63 - r) + (c2 & 255) * r) / 64);
    const r2 = Math.floor((((c1 >> 8) & 255) * (63 - r) + ((c2 >> 8) & 255) * r) / 64);
    const r3 = Math.floor((((c1 >> 16) & 255) * (63 - r) + ((c2 >> 16) & 255) * r) / 64);
    return r1 | (r2 << 8) | (r3 << 16);
}

export interface IAvsVisdata {
    /** visdata[1][ch]: the waveform, −128…127 (Winamp's top bytes of the PCM). */
    wave: [Int8Array, Int8Array];
    /** visdata[0][ch] read as unsigned char: the spectrum, 0…255 (after AVS's log table). */
    spectrum: [Uint8Array, Uint8Array];
}

const fallback = createVisdata();

/**
 * This frame's audio as AVS's 576 bytes per kind and channel: the analyser's own visdata
 * (avs/analyser.ts), or, from an analyser that has only floats, bytes made from them.
 */
export function avsVisdata(main): IAvsVisdata {
    const analyser = main.getAnalyser();
    if (typeof analyser.getVisdata === "function") {
        const visdata = analyser.getVisdata();
        return { spectrum: visdata.spectrum, wave: visdata.waveform };
    }
    for (let ch = 0; ch < 2; ch++) {
        const waveform = analyser.getWaveform(ch + 1);
        const spectrum = analyser.getSpectrum(ch + 1);
        for (let i = 0; i < 576; i++) {
            const w = Math.floor((Number(waveform[i]) || 0) * 128);
            fallback.waveform[ch][i] = w > 127 ? 127 : w < -128 ? -128 : w;
            const s = Math.round((Number(spectrum[i]) || 0) * 255);
            fallback.spectrum[ch][i] = s > 255 ? 255 : s < 0 ? 0 : s;
        }
    }
    return { spectrum: fallback.spectrum, wave: fallback.waveform };
}

/**
 * The `fa_data` an AVS effect read: channel 0 or 1 of one kind as unsigned bytes, or (2 and
 * up) the centre, `visdata[k][0][x]/2 + visdata[k][1][x]/2` on C's signed chars. One byte
 * longer than AVS's 576, as effects that interpolate read one past the end: in
 * `char visdata[2][2][576]` (spectrum, then wave) that is the next array's first byte — the
 * right channel after the left, the wave's left after the spectrum's right. Past the wave's
 * right channel and past the centre (a local array) AVS read whatever followed: 0 here.
 */
export function avsChannel(visdata: IAvsVisdata, waveform: boolean, channel: number, out?: Uint8Array): Uint8Array {
    const data = out ?? new Uint8Array(577);
    const [left, right] = waveform ? visdata.wave : visdata.spectrum;
    if (channel >= 2) {
        avsCenter(left, right, data);
        data[576] = 0;
    } else {
        const source = channel === 1 ? right : left;
        for (let i = 0; i < 576; i++) {
            data[i] = source[i] & 255;
        }
        data[576] = channel === 0 ? right[0] & 255 : waveform ? 0 : visdata.wave[0][0] & 255;
    }
    return data;
}

/** C's int: a JS number cut to 32 bits the way x86 wraps. */
export const int32 = (value: number) => value | 0;

const isInt = (value: number) => (value | 0) === value;

/**
 * linedraw.cpp's line() from (x1, y1) to (x2, y2), `lw` pixels wide, on a width ×
 * height frame (y down). The plotter takes its pixels as rectangles (plotter.rect): a run of
 * columns of an x-major line that share their rows is one rectangle, likewise rows of a
 * y-major one. The pixels are avsLinePixels's, each once (a line never writes a pixel twice,
 * so their order within the line is free; avsDraw.test.ts compares the two).
 */
export function avsLine(plotter, x1: number, y1: number, x2: number, y2: number,
                        width: number, height: number, color: number, lw: number) {
    if (!plotter.fast || !isInt(x1) || !isInt(y1) || !isInt(x2) || !isInt(y2) || !isInt(lw) || !isInt(width) || !isInt(height)) {
        avsLinePixels(plotter, x1, y1, x2, y2, width, height, color, lw);
        return;
    }
    const dy = Math.abs(y2 - y1);
    const dx = Math.abs(x2 - x1);
    if (lw < 1) {
        lw = 1;
    } else if (lw > 255) {
        lw = 255;
    }
    const lw2 = lw >> 1;
    if (!dx) {
        // vertical: rows min … max − 1, lw pixels from x1 − lw/2 in each
        x1 -= lw2;
        if (x1 + lw >= 0 && x1 < width) {
            const d = Math.max(Math.min(y1, y2), 0);
            const ye = Math.min(Math.max(y1, y2), height - 1);
            if (x1 < 0) {
                lw += x1;
                x1 = 0;
            }
            if (x1 + lw >= width) {
                lw = width - x1;
            }
            if (lw > 0 && ye > d) {
                plotter.rect(x1, d, lw, ye - d, color);
            }
        }
        return;
    }
    if (y1 === y2) {
        // horizontal: columns min … max − 1 in lw rows from y1 − lw/2
        y1 -= lw2;
        if (y1 + lw >= 0 && y1 < height) {
            const d = Math.max(Math.min(x1, x2), 0);
            const xe = Math.min(Math.max(x1, x2), width - 1);
            if (y1 < 0) {
                lw += y1;
                y1 = 0;
            }
            if (y1 + lw >= height) {
                lw = height - y1;
            }
            if (xe > d && lw > 0) {
                plotter.rect(d, y1, xe - d, lw, color);
            }
        }
        return;
    }
    let temp;
    if (dy <= dx) {
        // x major: a run of lw pixels down from y1 − lw/2 in every column x1 … x2 − 1
        if (x2 < x1) {
            temp = x1; x1 = x2; x2 = temp;
            temp = y1; y1 = y2; y2 = temp;
        }
        const yincr = y2 > y1 ? 1 : -1;
        y1 -= lw2;
        let d = dy + dy - dx;
        const Eincr = dy + dy;
        const NEincr = d - dx;
        if (x2 >= 0 && x1 < width) {
            if (x1 < 0) {
                // clipped at the left: y moved on by the slope, the error term not
                let v = yincr * -x1;
                v = Math.trunc((v * dy) / dx);
                y1 += v;
                x1 = 0;
            }
            if (x2 > width) {
                x2 = width;
            }
            // Columns from `first` on have the rows of y1 (clipped to the frame).
            let first = x1;
            while (x1 < x2) {
                if (d < 0) {
                    d += Eincr;
                } else {
                    d += NEincr;
                    const yp = y1 < 0 ? 0 : y1;
                    const ype = y1 + lw > height ? height : y1 + lw;
                    if (ype > yp) {
                        plotter.rect(first, yp, x1 + 1 - first, ype - yp, color);
                    }
                    y1 += yincr;
                    first = x1 + 1;
                }
                x1++;
            }
            if (first < x2) {
                const yp = y1 < 0 ? 0 : y1;
                const ype = y1 + lw > height ? height : y1 + lw;
                if (ype > yp) {
                    plotter.rect(first, yp, x2 - first, ype - yp, color);
                }
            }
        }
    } else {
        // y major: a run of lw pixels right from x1 − lw/2 in every row y1 … y2 − 1
        if (y2 < y1) {
            temp = x1; x1 = x2; x2 = temp;
            temp = y1; y1 = y2; y2 = temp;
        }
        const xincr = x2 > x1 ? 1 : -1;
        let d = dx + dx - dy;
        const Eincr = dx + dx;
        const NEincr = d - dy;
        x1 -= lw2;
        if (y2 >= 0 && y1 < height) {
            if (y1 < 0) {
                let v = xincr * -y1;
                v = Math.trunc((v * dx) / dy);
                x1 += v;
                y1 = 0;
            }
            if (y2 > height) {
                y2 = height;
            }
            // Rows from `first` on have the columns of x1 (clipped to the frame).
            let first = y1;
            while (y1 < y2) {
                if (d < 0) {
                    d += Eincr;
                } else {
                    d += NEincr;
                    const xp = x1 < 0 ? 0 : x1;
                    const xpe = x1 + lw > width ? width : x1 + lw;
                    if (xpe > xp) {
                        plotter.rect(xp, first, xpe - xp, y1 + 1 - first, color);
                    }
                    x1 += xincr;
                    first = y1 + 1;
                }
                y1++;
            }
            if (first < y2) {
                const xp = x1 < 0 ? 0 : x1;
                const xpe = x1 + lw > width ? width : x1 + lw;
                if (xpe > xp) {
                    plotter.rect(xp, first, xpe - xp, y2 - first, color);
                }
            }
        }
    }
}

/**
 * linedraw.cpp's line() as before 10.11, pixel by pixel: every pixel written goes to
 * plotter.plotRun(offset, count, step, color) (the plotter's lists for __avsPlotterFast = false,
 * and the reference avsLine is tested against).
 */
export function avsLinePixels(plotter, x1: number, y1: number, x2: number, y2: number,
                              width: number, height: number, color: number, lw: number) {
    const dy = Math.abs(y2 - y1);
    const dx = Math.abs(x2 - x1);
    if (lw < 1) {
        lw = 1;
    } else if (lw > 255) {
        lw = 255;
    }
    const lw2 = lw >> 1;
    if (!dx) {
        // vertical: rows min … max − 1
        x1 -= lw2;
        if (x1 + lw >= 0 && x1 < width) {
            let d = Math.max(Math.min(y1, y2), 0);
            const ye = Math.min(Math.max(y1, y2), height - 1);
            if (x1 < 0) {
                lw += x1;
                x1 = 0;
            }
            if (x1 + lw >= width) {
                lw = width - x1;
            }
            let fb = d * width + x1;
            const skip = width - lw;
            if (lw > 0) {
                while (d++ < ye) {
                    plotter.plotRun(fb, lw, 1, color);
                    fb += lw + skip;
                }
            }
        }
        return;
    }
    if (y1 === y2) {
        // horizontal: columns min … max − 1
        y1 -= lw2;
        if (y1 + lw >= 0 && y1 < height) {
            const d = Math.max(Math.min(x1, x2), 0);
            const xe = Math.min(Math.max(x1, x2), width - 1);
            if (y1 < 0) {
                lw += y1;
                y1 = 0;
            }
            if (y1 + lw >= height) {
                lw = height - y1;
            }
            let fb = y1 * width + d;
            const skip = width - (xe - d);
            for (let y = lw; y > 0; y--) {
                if (xe > d) {
                    plotter.plotRun(fb, xe - d, 1, color);
                    fb += xe - d;
                }
                fb += skip;
            }
        }
        return;
    }
    let temp;
    if (dy <= dx) {
        // x major: a run of lw pixels down from y1 − lw/2 in every column x1 … x2 − 1
        if (x2 < x1) {
            temp = x1; x1 = x2; x2 = temp;
            temp = y1; y1 = y2; y2 = temp;
        }
        const yincr = y2 > y1 ? 1 : -1;
        const offsincr = y2 > y1 ? width : -width;
        y1 -= lw2;
        let offs = y1 * width + x1;
        let d = dy + dy - dx;
        const Eincr = dy + dy;
        const NEincr = d - dx;
        if (x2 >= 0 && x1 < width) {
            if (x1 < 0) {
                // clipped at the left: y moved on by the slope, the error term not
                let v = yincr * -x1;
                v = Math.trunc((v * dy) / dx);
                y1 += v;
                offs += v * width - x1;
                x1 = 0;
            }
            if (x2 > width) {
                x2 = width;
            }
            while (x1 < x2) {
                let yp = y1;
                let ype = y1 + lw;
                let at = offs;
                if (yp < 0) {
                    at -= yp * width;
                    yp = 0;
                }
                if (ype > height) {
                    ype = height;
                }
                if (ype > yp) {
                    plotter.plotRun(at, ype - yp, width, color);
                }
                if (d < 0) {
                    d += Eincr;
                } else {
                    d += NEincr;
                    y1 += yincr;
                    offs += offsincr;
                }
                offs++;
                x1++;
            }
        }
    } else {
        // y major: a run of lw pixels right from x1 − lw/2 in every row y1 … y2 − 1
        if (y2 < y1) {
            temp = x1; x1 = x2; x2 = temp;
            temp = y1; y1 = y2; y2 = temp;
        }
        const xincr = x2 > x1 ? 1 : -1;
        let d = dx + dx - dy;
        const Eincr = dx + dx;
        const NEincr = d - dy;
        x1 -= lw2;
        let offs = y1 * width + x1;
        if (y2 >= 0 && y1 < height) {
            if (y1 < 0) {
                let v = xincr * -y1;
                v = Math.trunc((v * dx) / dy);
                x1 += v;
                offs += v - y1 * width;
                y1 = 0;
            }
            if (y2 > height) {
                y2 = height;
            }
            while (y1 < y2) {
                let xp = x1;
                let xpe = x1 + lw;
                let at = offs;
                if (xp < 0) {
                    at -= xp;
                    xp = 0;
                }
                if (xpe > width) {
                    xpe = width;
                }
                if (xpe > xp) {
                    plotter.plotRun(at, xpe - xp, 1, color);
                }
                if (d < 0) {
                    d += Eincr;
                } else {
                    d += NEincr;
                    x1 += xincr;
                    offs += xincr;
                }
                offs += width;
                y1++;
            }
        }
    }
}

/**
 * GLSL on 0…255 levels (high precision): `vec3 avsBlendLine(int mode, vec3 dest,
 * vec3 src, float adjust)`, BLEND_LINE's modes in r_defs.h; `float avsMul(float a,
 * float b)` is g_blendtable[a][b] = (unsigned char)((a / 255.0) · b).
 */
export const AVS_BLEND_GLSL = `
    ${HIGH_PRECISION}
    float avsMul(float a, float b) {
        float t = floor((a * b + 0.5) / 255.0);
        // a / 255.0 in double lands just below the exact value: 12 products one level lower.
        if ((a == 147.0 || a == 171.0) && (b == 85.0 || b == 170.0)) t -= 1.0;
        if (a == 155.0 && (b == 51.0 || b == 102.0 || b == 153.0 || b == 204.0)) t -= 1.0;
        if (a == 187.0 && (b == 75.0 || b == 150.0 || b == 165.0)) t -= 1.0;
        if (a == 195.0 && b == 153.0) t -= 1.0;
        return t;
    }
    vec3 avsXor(vec3 x, vec3 y) {
        vec3 result = vec3(0.0);
        float bit = 1.0;
        for (int i = 0; i < 8; i++) {
            result += mod(mod(x, 2.0) + mod(y, 2.0), 2.0) * bit;
            x = floor(x * 0.5);
            y = floor(y * 0.5);
            bit *= 2.0;
        }
        return result;
    }
    vec3 avsBlendLine(int mode, vec3 d, vec3 s, float adjust) {
        if (mode == 1) return min(d + s, vec3(255.0));
        if (mode == 2) return max(d, s);
        if (mode == 3) return floor(d * 0.5) + floor(s * 0.5);
        if (mode == 4) return max(d - s, vec3(0.0));
        if (mode == 5) return max(s - d, vec3(0.0));
        if (mode == 6) return vec3(avsMul(d.r, s.r), avsMul(d.g, s.g), avsMul(d.b, s.b));
        if (mode == 7) {
            return vec3(avsMul(d.r, adjust), avsMul(d.g, adjust), avsMul(d.b, adjust))
                + vec3(avsMul(s.r, 255.0 - adjust), avsMul(s.g, 255.0 - adjust), avsMul(s.b, 255.0 - adjust));
        }
        if (mode == 8) return avsXor(d, s);
        if (mode == 9) return min(d, s);
        return s;
    }`;

/** Modes where n writes of colours a, b, … to one pixel make one write of a combination. */
const FOLDED = [true, true, true, false, true, false, false, false, true, true];

/**
 * More passes than this (one per write to the busiest pixel) and the writes are blended on
 * the processor instead: a Dot Fountain's dots meet at its tip, and with 50/50 or adjustable
 * lines (Set Render Mode) that was thousands of passes, each a copy of the frame — a frame
 * took 200 ms (Mr_Nudge — 01FireWorks).
 */
const MAX_PASSES = 8;

/** avsMul of AVS_BLEND_GLSL: g_blendtable[a][b], with the same twelve products one level lower. */
function avsMulCpu(a: number, b: number): number {
    let t = Math.floor((a * b + 0.5) / 255);
    if ((a === 147 || a === 171) && (b === 85 || b === 170)) t -= 1;
    if (a === 155 && (b === 51 || b === 102 || b === 153 || b === 204)) t -= 1;
    if (a === 187 && (b === 75 || b === 150 || b === 165)) t -= 1;
    if (a === 195 && b === 153) t -= 1;
    return t;
}

let mulTable: Uint8Array | null = null;

/** avsMulCpu(a, b) at (a << 8) | b, for blending on the processor a whole pixel at a time. */
function avsMulTable(): Uint8Array {
    if (!mulTable) {
        mulTable = new Uint8Array(65536);
        for (let a = 0; a < 256; a++) {
            for (let b = 0; b < 256; b++) {
                mulTable[(a << 8) | b] = avsMulCpu(a, b);
            }
        }
    }
    return mulTable;
}

/** Typed arrays as 32-bit words read the bytes little-endian (every platform a browser runs on). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Up to this many writes of a direct mode are blended on the processor into a frame a run there
 * holds (cpuFrameRun.ts), more go to the GPU after the frame is sent back: both give the same
 * pixels; this only weighs the cost.
 */
const CPU_DIRECT_WRITES = 1 << 20;

/**
 * From this many writes a 50/50, multiply or adjustable flush is blended on the processor even
 * when it needs no more than MAX_PASSES passes: each pass costs a copy and a draw of its pixels
 * worked out here (Planet X: 1.5 million multiplied writes in 2 passes, ~30 ms a frame); the
 * processor gives the same pixels (blendRectsCpu, AVS_BLEND_GLSL's arithmetic).
 */
const CPU_BLEND_WRITES = 1 << 17;

/** avsBlendLine of AVS_BLEND_GLSL on one channel, 0…255. */
export function blendLineCpu(mode: number, d: number, s: number, adjust: number): number {
    switch (mode) {
        case 1: return Math.min(d + s, 255);
        case 2: return Math.max(d, s);
        case 3: return (d >> 1) + (s >> 1);
        case 4: return Math.max(d - s, 0);
        case 5: return Math.max(s - d, 0);
        case 6: return avsMulCpu(d, s);
        case 7: return avsMulCpu(d, adjust) + avsMulCpu(s, 255 - adjust);
        case 8: return d ^ s;
        case 9: return Math.min(d, s);
        default: return s;
    }
}

function fold(mode: number, a: number, b: number): number {
    switch (mode) {
        case 1: // additive
        case 4: { // subtractive 1: what is taken off adds up
            const r = Math.min(255, (a & 255) + (b & 255));
            const g = Math.min(255, ((a >> 8) & 255) + ((b >> 8) & 255));
            const bl = Math.min(255, ((a >> 16) & 255) + ((b >> 16) & 255));
            return r | (g << 8) | (bl << 16);
        }
        case 2:
            return Math.max(a & 255, b & 255) | (Math.max(a & 0xff00, b & 0xff00)) | (Math.max(a & 0xff0000, b & 0xff0000));
        case 9:
            return Math.min(a & 255, b & 255) | (Math.min(a & 0xff00, b & 0xff00)) | (Math.min(a & 0xff0000, b & 0xff0000));
        case 8:
            return (a ^ b) & 0xffffff;
        default: // replace: the last write
            return b;
    }
}

const adjustTables = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
const blendBounds = new Int32Array(4);

/**
 * Rectangles (the plotter's records: x, y, w, h as 16-bit words, 6 to a record; the colour
 * 0x00RRGGBB as the third 32-bit word of each 12 bytes) blended in order into a width × height
 * frame of 32-bit RGBA words (red in the low byte, top row first), pixel after pixel, with
 * BLEND_LINE's arithmetic: blendLineCpu, a whole pixel at a time. Written pixels get alpha 1, as
 * the GPU's draws give them. Returns the columns x0…x1 − 1 and rows y0…y1 − 1 written to.
 */
export function blendRectsCpu(px: Uint32Array, width: number, height: number, r16: Uint16Array, r32: Uint32Array,
                              n: number, mode: number, adjust: number): Int32Array {
    const OPAQUE = 0xff000000 | 0;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    for (let k = 0; k < n; k++) {
        const q = k * 6;
        const x = r16[q];
        const y = r16[q + 1];
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + r16[q + 2] > x1) x1 = x + r16[q + 2];
        if (y + r16[q + 3] > y1) y1 = y + r16[q + 3];
    }
    blendBounds[0] = x0;
    blendBounds[1] = y0;
    blendBounds[2] = x1;
    blendBounds[3] = y1;
    // One loop per mode, each rectangle row by row; `s` is the colour as the frame's words hold it
    // (red in the low byte).
    switch (mode) {
        case 0:
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const value = ((c >>> 16) & 255) | (c & 0xff00) | ((c & 255) << 16) | OPAQUE;
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    if (w === 1) {
                        px[start] = value;
                    } else {
                        px.fill(value, start, start + w);
                    }
                }
            }
            break;
        case 3:
            // (d >> 1) + (s >> 1) per channel: no channel carries into the next.
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const half = (((c >>> 16) & 255) | (c & 0xff00) | ((c & 255) << 16)) >>> 1 & 0x7f7f7f;
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    for (let o = start; o < start + w; o++) {
                        px[o] = (((px[o] >>> 1) & 0x7f7f7f) + half) | OPAQUE;
                    }
                }
            }
            break;
        case 6: {
            const mul = avsMulTable();
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const sr = (c >>> 16) & 255;
                const sg = (c >>> 8) & 255;
                const sb = c & 255;
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    for (let o = start; o < start + w; o++) {
                        const d = px[o];
                        px[o] = mul[((d & 255) << 8) | sr] | (mul[(d & 0xff00) | sg] << 8) | (mul[((d >>> 8) & 0xff00) | sb] << 16) | OPAQUE;
                    }
                }
            }
            break;
        }
        case 7: {
            // avsMul(d, adjust) + avsMul(s, 255 − adjust) per channel, at most 255: no carry.
            const mul = avsMulTable();
            const [d0, d1, d2] = adjustTables;
            for (let c = 0; c < 256; c++) {
                const v = mul[(c << 8) | adjust];
                d0[c] = v;
                d1[c] = v << 8;
                d2[c] = v << 16;
            }
            const back = 255 - adjust;
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const add = (mul[(((c >>> 16) & 255) << 8) | back] | (mul[(c & 0xff00) | back] << 8) | (mul[((c & 255) << 8) | back] << 16)) | OPAQUE;
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    for (let o = start; o < start + w; o++) {
                        const d = px[o];
                        px[o] = (d0[d & 255] | d1[(d >>> 8) & 255] | d2[(d >>> 16) & 255]) + add;
                    }
                }
            }
            break;
        }
        case 8:
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const s = ((c >>> 16) & 255) | (c & 0xff00) | ((c & 255) << 16);
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    for (let o = start; o < start + w; o++) {
                        px[o] = ((px[o] ^ s) & 0xffffff) | OPAQUE;
                    }
                }
            }
            break;
        case 1:
        case 2:
        case 4:
        case 5:
        case 9:
            // Channel by channel as blendLineCpu, inline: additive (at most 255), maximum, both
            // subtractions (at least 0), minimum.
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const sr = (c >>> 16) & 255;
                const sg = (c >>> 8) & 255;
                const sb = c & 255;
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    for (let o = start; o < start + w; o++) {
                        const d = px[o];
                        const dr = d & 255;
                        const dg = (d >>> 8) & 255;
                        const db = (d >>> 16) & 255;
                        let r;
                        let g;
                        let b;
                        if (mode === 1) {
                            r = dr + sr; g = dg + sg; b = db + sb;
                            if (r > 255) r = 255;
                            if (g > 255) g = 255;
                            if (b > 255) b = 255;
                        } else if (mode === 2) {
                            r = dr > sr ? dr : sr; g = dg > sg ? dg : sg; b = db > sb ? db : sb;
                        } else if (mode === 9) {
                            r = dr < sr ? dr : sr; g = dg < sg ? dg : sg; b = db < sb ? db : sb;
                        } else if (mode === 4) {
                            r = dr - sr; g = dg - sg; b = db - sb;
                            if (r < 0) r = 0;
                            if (g < 0) g = 0;
                            if (b < 0) b = 0;
                        } else {
                            r = sr - dr; g = sg - dg; b = sb - db;
                            if (r < 0) r = 0;
                            if (g < 0) g = 0;
                            if (b < 0) b = 0;
                        }
                        px[o] = r | (g << 8) | (b << 16) | OPAQUE;
                    }
                }
            }
            break;
        default:
            for (let k = 0; k < n; k++) {
                const q = k * 6;
                const c = r32[k * 3 + 2];
                const sr = (c >>> 16) & 255;
                const sg = (c >>> 8) & 255;
                const sb = c & 255;
                const w = r16[q + 2];
                for (let start = r16[q + 1] * width + r16[q], end = start + r16[q + 3] * width; start < end; start += width) {
                    for (let o = start; o < start + w; o++) {
                        const d = px[o];
                        px[o] = blendLineCpu(mode, d & 255, sr, adjust)
                            | (blendLineCpu(mode, (d >>> 8) & 255, sg, adjust) << 8)
                            | (blendLineCpu(mode, (d >>> 16) & 255, sb, adjust) << 16) | OPAQUE;
                    }
                }
            }
            break;
    }
    return blendBounds;
}

/**
 * Pixels written AVS's way onto the current frame: begin(), plot() / span() in AVS's order,
 * flush() with the blend mode. One per rendering context, shared by the effects.
 *
 * Since 10.11 the writes are kept as rectangles of one colour (12 bytes each: x, y, width, height
 * as 16-bit numbers and the colour as 0x00RRGGBB), a rectangle that adjoins the one before it in
 * the same colour joined to it — the same pixels, each pixel's writes in the same order, as a
 * pixel's writes only ever come from different rectangles. Then:
 * - the modes GL blends exactly (replace, additive, maximum, minimum, both subtractions) are
 *   one instanced draw of the rectangles in AVS's order: GL blends the fragments of one draw in
 *   the order of its primitives, so every pixel gets its writes one after the other, as in AVS
 *   (Raz — Peace And Love writes 59 million pixels a frame, a wide line's column at a time:
 *   folded write by write on the processor that took ~480 ms a frame);
 * - a frame a run holds on the processor (cpuFrameRun.ts: a Super Scope, Texer II … before) is
 *   blended there, every write in order with BLEND_LINE's integer arithmetic (blendRectsCpu),
 *   and so is a 50/50, multiply or adjustable flush that would need more than MAX_PASSES passes
 *   or has more than CPU_BLEND_WRITES writes: Super Scopes in a row then share one read-back and
 *   one upload;
 * - everything else (XOR, a few passes of 50/50 …) goes through the pixel lists as before.
 * For 50/50, multiply and adjustable the rectangles are expanded into the pixel lists with the
 * pass count in the same loop (expandCounted), so a flush that stays on the GPU costs what it did.
 * __avsPlotterFast = false on a test page keeps the pixel lists for every flush.
 */
export class AvsPlotter {
    /** This frame's writes go in as rectangles (else the pixel lists, the way before 10.11). */
    public fast = false;
    private rectBytes = new ArrayBuffer(12 * 4096);
    private rect16 = new Uint16Array(this.rectBytes);
    private rect32 = new Uint32Array(this.rectBytes);
    private rects = 0;
    private writes = 0;
    /** A colour outside 0…0xFFFFFF came in: this flush goes through the pixel lists, as before. */
    private odd = false;
    private frames: CpuFrameRun;
    private instancing: any;
    private fragmentHighp = false;
    private rectProgram: ShaderProgram;
    private rectBuffer: Buffer;
    private cornerBuffer: Buffer;
    private program: ShaderProgram;
    private points: Buffer;
    private colors: Buffer;
    private width = 0;
    private height = 0;
    private size = 0;
    private seen: Int32Array = new Int32Array(0);
    private offsets: Int32Array = new Int32Array(1024);
    private values: Int32Array = new Int32Array(1024);
    private count = 0;
    // Work arrays kept from frame to frame (a solid Simple writes ~10⁵ pixels a frame).
    private at: Int32Array = new Int32Array(1024);
    private value: Int32Array = new Int32Array(1024);
    private pass: Int32Array = new Int32Array(1024);
    private pointData: Float32Array = new Float32Array(2048);
    private colorData: Float32Array = new Float32Array(3072);
    private gl: WebGLRenderingContext;
    private readBuffer: WebGLFramebuffer | null = null;
    private pixels: Uint8Array = new Uint8Array(0);
    // Modes GL's blending computes exactly on 8-bit channels, drawn straight into the frame.
    private direct: ShaderProgram;
    // The direct modes' writes as they came: offsets and colours unpacked by the vertex shader.
    private packed: ShaderProgram;
    private offsetBuffer: Buffer;
    private rgbBuffer: Buffer;
    private offsetData: Float32Array = new Float32Array(1024);
    private rgbData: Float32Array = new Float32Array(1024);
    private minmax: any;
    // The other modes read the frame: from a copy of the rectangle the writes cover.
    private blend: ShaderProgram;
    private scratch: WebGLTexture | null = null;
    private scratchWidth = 0;
    private scratchHeight = 0;

    constructor(rctx) {
        this.gl = rctx.getGl();
        this.points = new Buffer(rctx);
        this.colors = new Buffer(rctx);
        this.program = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    colors: { name: "a_color", size: 3 },
                    points: { name: "a_position" },
                },
                uniforms: {
                    adjust: { name: "u_adjust", valueType: WebGLVarType._1F },
                    // The frame being drawn on, bound by this program after the swap's
                    // copy (the copier works on texture unit 0, u_srcTexture's: a blend
                    // read from there once saw black).
                    dest: { name: "u_dest", valueType: WebGLVarType.TEXTURE2D },
                    mode: { name: "u_mode", valueType: WebGLVarType._1I },
                },
            },
            copyOnSwap: true,
            drawHook: (values, gl) => {
                gl.drawArrays(gl.POINTS, 0, values.count);
            },
            fragmentShader: `
                ${AVS_BLEND_GLSL}
                uniform int u_mode;
                uniform float u_adjust;
                uniform sampler2D u_dest;
                varying vec3 v_color;
                void main() {
                    vec3 dest = floor(texture2D(u_dest, gl_FragCoord.xy / u_resolution).rgb * 255.0 + 0.5);
                    vec3 src = floor(v_color * 255.0 + 0.5);
                    setFragColor(vec4(avsBlendLine(u_mode, dest, src, u_adjust) / 255.0, 1.0));
                }
            `,
            swapFrame: true,
            vertexShader: `
                attribute vec2 a_position;
                attribute vec3 a_color;
                varying vec3 v_color;
                void main() {
                    gl_PointSize = 1.0;
                    setPosition(a_position);
                    v_color = a_color;
                }
            `,
        });
        this.minmax = this.gl.getExtension("EXT_blend_minmax");
        this.frames = cpuFrameRunOf(rctx);
        this.instancing = LITTLE_ENDIAN ? this.gl.getExtension("ANGLE_instanced_arrays") : null;
        // The run's patch upload (cpuFrameRun.ts flushRows) finds its texels by gl_FragCoord: exact
        // only with highp floats in fragment shaders. Without them (old mobile GPUs) the plotter keeps
        // the pixel lists, which write the touched pixels and nothing else.
        const high = this.gl.getShaderPrecisionFormat(this.gl.FRAGMENT_SHADER, this.gl.HIGH_FLOAT);
        this.fragmentHighp = Boolean(high && high.precision >= 23);
        this.rectBuffer = new Buffer(rctx);
        this.cornerBuffer = new Buffer(rctx, false, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
        // The rectangles: a unit square per instance, stretched over the rectangle's pixels (corners on
        // pixel edges, so a pixel is in it exactly when its centre is), in the rectangle's colour.
        this.rectProgram = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    inverse: { name: "u_inverse", valueType: WebGLVarType._2FV },
                },
            },
            drawHook: (values, gl, shader) => {
                this.drawInstances(values, gl, shader);
            },
            fragmentShader: `
                varying vec3 v_color;
                void main() {
                    setFragColor(vec4(v_color, 1.0));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute highp vec2 a_corner;
                attribute highp vec4 a_rect;
                attribute vec4 a_bgr;
                uniform highp vec2 u_inverse;
                varying vec3 v_color;
                void main() {
                    highp vec2 p = a_rect.xy + a_corner * a_rect.zw;
                    setPosition(vec2(p.x * u_inverse.x * 2.0 - 1.0, 1.0 - p.y * u_inverse.y * 2.0));
                    v_color = a_bgr.zyx;
                }
            `,
        });
        this.offsetBuffer = new Buffer(rctx);
        this.rgbBuffer = new Buffer(rctx);
        this.packed = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    offsets: { name: "a_offset", size: 1 },
                    rgb: { name: "a_rgb", size: 1 },
                },
                uniforms: {
                    frame: { name: "u_frame", valueType: WebGLVarType._2FV },
                    inverse: { name: "u_inverse", valueType: WebGLVarType._2FV },
                },
            },
            drawHook: (values, gl) => {
                this.glBlend(values.mode);
                gl.drawArrays(gl.POINTS, 0, values.count);
                gl.blendEquation(gl.FUNC_ADD);
                gl.blendFunc(gl.ONE, gl.ZERO);
            },
            fragmentShader: `
                varying vec3 v_color;
                void main() {
                    setFragColor(vec4(v_color, 1.0));
                }
            `,
            swapFrame: false,
            // Offsets (y · width + x, below 2^24) and 0xRRGGBB are whole numbers a highp float holds
            // exactly; the row is taken with a multiply by 1/width (no division), which keeps it
            // well inside the half pixel between a pixel's centre and the next row.
            vertexShader: `
                attribute highp float a_offset;
                attribute highp float a_rgb;
                uniform highp vec2 u_frame;
                uniform highp vec2 u_inverse;
                varying vec3 v_color;
                void main() {
                    gl_PointSize = 1.0;
                    highp float row = floor((a_offset + 0.5) * u_inverse.x);
                    highp float x = a_offset - row * u_frame.x;
                    setPosition(vec2((x + 0.5) * u_inverse.x * 2.0 - 1.0, 1.0 - (row + 0.5) * u_inverse.y * 2.0));
                    highp float r = floor(a_rgb * (1.0 / 65536.0));
                    highp float g = floor((a_rgb - r * 65536.0) * (1.0 / 256.0));
                    highp float b = a_rgb - r * 65536.0 - g * 256.0;
                    v_color = vec3(r, g, b) / 255.0;
                }
            `,
        });
        this.direct = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    colors: { name: "a_color", size: 3 },
                    points: { name: "a_position" },
                },
            },
            drawHook: (values, gl) => {
                this.glBlend(values.mode);
                gl.drawArrays(gl.POINTS, 0, values.count);
                gl.blendEquation(gl.FUNC_ADD);
                gl.blendFunc(gl.ONE, gl.ZERO);
            },
            fragmentShader: `
                varying vec3 v_color;
                void main() {
                    setFragColor(vec4(v_color, 1.0));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute vec2 a_position;
                attribute vec3 a_color;
                varying vec3 v_color;
                void main() {
                    gl_PointSize = 1.0;
                    setPosition(a_position);
                    v_color = a_color;
                }
            `,
        });
        this.blend = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    colors: { name: "a_color", size: 3 },
                    points: { name: "a_position" },
                },
                uniforms: {
                    adjust: { name: "u_adjust", valueType: WebGLVarType._1F },
                    dest: { name: "u_dest", valueType: WebGLVarType.TEXTURE2D },
                    mode: { name: "u_mode", valueType: WebGLVarType._1I },
                },
            },
            drawHook: (values, gl) => {
                gl.drawArrays(gl.POINTS, 0, values.count);
            },
            fragmentShader: `
                ${AVS_BLEND_GLSL}
                uniform int u_mode;
                uniform float u_adjust;
                uniform sampler2D u_dest;
                varying vec3 v_color;
                void main() {
                    vec3 dest = floor(texture2D(u_dest, gl_FragCoord.xy / u_resolution).rgb * 255.0 + 0.5);
                    vec3 src = floor(v_color * 255.0 + 0.5);
                    setFragColor(vec4(avsBlendLine(u_mode, dest, src, u_adjust) / 255.0, 1.0));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute vec2 a_position;
                attribute vec3 a_color;
                varying vec3 v_color;
                void main() {
                    gl_PointSize = 1.0;
                    setPosition(a_position);
                    v_color = a_color;
                }
            `,
        });
    }

    /**
     * The frame's pixels under the rectangle of these writes, copied into the scratch texture
     * (same size and place as the frame) for the blend to read: the frame is the target.
     */
    private copyRect(at: Int32Array, from: number, to: number): boolean {
        const gl = this.gl;
        const width = this.width;
        const height = this.height;
        if (!this.scratch || this.scratchWidth !== width || this.scratchHeight !== height) {
            if (!this.scratch) {
                this.scratch = gl.createTexture();
            }
            gl.bindTexture(gl.TEXTURE_2D, this.scratch);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.scratchWidth = width;
            this.scratchHeight = height;
        }
        let minX = width;
        let maxX = -1;
        let minRow = height;
        let maxRow = -1;
        for (let i = from; i < to; i++) {
            const offset = at[i];
            const row = Math.floor(offset / width);
            const x = offset - row * width;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
        }
        if (maxX < 0) {
            return false;
        }
        // GL rows count from the bottom.
        const y = height - 1 - maxRow;
        gl.bindTexture(gl.TEXTURE_2D, this.scratch);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, minX, y, minX, y, maxX - minX + 1, maxRow - minRow + 1);
        return true;
    }

    /**
     * Whether GL's blend unit gives BLEND_LINE's result for `mode` exactly: replace, additive
     * (saturating), maximum, minimum (EXT_blend_minmax), subtractive both ways (clamped at 0) —
     * channels of k/255 add, subtract and compare without rounding. These need no copy of the
     * frame to read it: the writes go straight into it, pass after pass in AVS's order.
     */
    private isDirect(mode: number): boolean {
        if ((globalThis as any).__avsPlotterDirect === false) {
            return false;
        }
        return mode === 0 || mode === 1 || mode === 4 || mode === 5 || ((mode === 2 || mode === 9) && Boolean(this.minmax));
    }

    private glBlend(mode: number) {
        const gl = this.gl;
        if (mode === 0) {
            gl.disable(gl.BLEND);
            return;
        }
        gl.enable(gl.BLEND);
        // Colour from the mode; alpha 1, as the shader path wrote it (later blends may read it).
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO);
        const equation = mode === 1 ? gl.FUNC_ADD
            : mode === 4 ? gl.FUNC_REVERSE_SUBTRACT
            : mode === 5 ? gl.FUNC_SUBTRACT
            : mode === 2 ? this.minmax.MAX_EXT
            : this.minmax.MIN_EXT;
        gl.blendEquationSeparate(equation, gl.FUNC_ADD);
    }

    /** Starts a frame's writes on a width × height frame. */
    public begin(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.size = width * height;
        if (this.seen.length !== this.size) {
            this.seen = new Int32Array(this.size).fill(-1);
        }
        this.count = 0;
        this.rects = 0;
        this.writes = 0;
        this.odd = false;
        this.fast = LITTLE_ENDIAN && this.fragmentHighp && plotterFast() && width < 65536 && height < 65536;
    }

    /** One write at offset y · width + x (y down) of colour 0xRRGGBB; off-frame writes are dropped. */
    public plot(offset: number, color: number) {
        if (offset < 0 || offset >= this.size) {
            return;
        }
        if (this.fast) {
            const at = offset | 0;
            const y = (at / this.width) | 0;
            this.rect(at - y * this.width, y, 1, 1, color);
            return;
        }
        if (this.count === this.offsets.length) {
            const offsets = new Int32Array(this.count * 2);
            offsets.set(this.offsets);
            this.offsets = offsets;
            const values = new Int32Array(this.count * 2);
            values.set(this.values);
            this.values = values;
        }
        this.offsets[this.count] = offset;
        this.values[this.count] = color;
        this.count++;
    }

    /**
     * `count` writes of one colour from `offset` on, `step` apart (a run of a line's pixels), as
     * plot() would take them one by one.
     */
    public plotRun(offset: number, count: number, step: number, color: number) {
        if (count <= 0) {
            return;
        }
        if (this.fast) {
            const width = this.width;
            const end = offset + (count - 1) * step;
            if (isInt(offset) && isInt(count) && offset >= 0 && end < this.size && (step === 1 || step === width)) {
                const y = (offset / width) | 0;
                const x = offset - y * width;
                if (step === width) {
                    this.rect(x, y, 1, count, color);
                    return;
                }
                if (x + count <= width) {
                    this.rect(x, y, count, 1, color);
                    return;
                }
            }
            for (let k = 0; k < count; k++, offset += step) {
                this.plot(offset, color);
            }
            return;
        }
        const last = offset + (count - 1) * step;
        if (offset < 0 || offset >= this.size || last < 0 || last >= this.size) {
            for (let k = 0; k < count; k++, offset += step) {
                this.plot(offset, color);
            }
            return;
        }
        let at = this.count;
        if (at + count > this.offsets.length) {
            const length = Math.max(at + count, this.offsets.length * 2);
            const offsets = new Int32Array(length);
            offsets.set(this.offsets);
            this.offsets = offsets;
            const values = new Int32Array(length);
            values.set(this.values);
            this.values = values;
        }
        const offsets = this.offsets;
        const values = this.values;
        for (let k = 0; k < count; k++, offset += step, at++) {
            offsets[at] = offset;
            values[at] = color;
        }
        this.count = at;
    }

    /**
     * The w × h pixels from (x, y) (y down), all of one colour, written in one go — as many plot()s
     * in any order, since they are different pixels.
     */
    public span(x: number, y: number, w: number, h: number, color: number) {
        if (w <= 0 || h <= 0) {
            return;
        }
        if (this.fast && x >= 0 && y >= 0 && x + w <= this.width && y + h <= this.height && isInt(x) && isInt(y) && isInt(w) && isInt(h)) {
            this.rect(x, y, w, h, color);
            return;
        }
        const width = this.width;
        for (let row = 0; row < h; row++) {
            for (let column = 0; column < w; column++) {
                this.plot((y + row) * width + x + column, color);
            }
        }
    }

    /**
     * span() of a rectangle known to lie inside the frame, of whole numbers, w and h at least 1
     * (avsLine's), while `fast`: joined to the one before when they adjoin in one colour.
     */
    public rect(x: number, y: number, w: number, h: number, color: number) {
        this.writes += w * h;
        if ((color & 0xffffff) !== color) {
            this.odd = true;
        }
        const n = this.rects;
        const r16 = this.rect16;
        if (n > 0 && this.rect32[n * 3 - 1] === color >>> 0) {
            const p = n * 6 - 6;
            if (r16[p + 1] === y && r16[p + 3] === h && r16[p] + r16[p + 2] === x) {
                r16[p + 2] += w;
                this.coalesce();
                return;
            }
            if (r16[p] === x && r16[p + 2] === w && r16[p + 1] + r16[p + 3] === y) {
                r16[p + 3] += h;
                this.coalesce();
                return;
            }
        }
        if ((n + 1) * 12 > this.rectBytes.byteLength) {
            const bytes = new ArrayBuffer(this.rectBytes.byteLength * 2);
            new Uint8Array(bytes).set(new Uint8Array(this.rectBytes));
            this.rectBytes = bytes;
            this.rect16 = new Uint16Array(bytes);
            this.rect32 = new Uint32Array(bytes);
        }
        const q = n * 6;
        this.rect16[q] = x;
        this.rect16[q + 1] = y;
        this.rect16[q + 2] = w;
        this.rect16[q + 3] = h;
        this.rect32[n * 3 + 2] = color;
        this.rects = n + 1;
    }

    /** The last rectangle, grown, joined to the one before it when they now adjoin in one colour. */
    private coalesce() {
        const n = this.rects;
        if (n < 2 || this.rect32[n * 3 - 1] !== this.rect32[n * 3 - 4]) {
            return;
        }
        const r16 = this.rect16;
        const a = n * 6 - 12;
        const b = n * 6 - 6;
        if (r16[a] === r16[b] && r16[a + 2] === r16[b + 2] && r16[a + 1] + r16[a + 3] === r16[b + 1]) {
            r16[a + 3] += r16[b + 3];
            this.rects = n - 1;
        } else if (r16[a + 1] === r16[b + 1] && r16[a + 3] === r16[b + 3] && r16[a] + r16[a + 2] === r16[b]) {
            r16[a + 2] += r16[b + 2];
            this.rects = n - 1;
        }
    }

    /**
     * Blends this frame's writes into the frame of `tsm` with BLEND_LINE's `mode`. `run`: the caller
     * is a user of the processor's frame run (cpuFrameRun.ts) and calls its finish() after; without
     * it a frame blended on the processor goes back now.
     */
    public flush(tsm, mode: number, adjust: number, run: CpuFrameRun | null = null) {
        if (!this.fast) {
            // A Super Scope counts as a user of the run whenever plotterFast() says so
            // (cpuFrameRun.ts kind()), so a Texer II before it may have left the frame on the
            // processor: it goes back before the GPU draws on it.
            this.frames.flush();
            this.flushPixels(tsm, mode, adjust);
            return;
        }
        const n = this.rects;
        const writes = this.writes;
        const odd = this.odd;
        this.rects = 0;
        this.writes = 0;
        this.odd = false;
        if (!n) {
            return;
        }
        const frames = this.frames;
        const known = !odd && mode >= 0 && mode <= 9 && isInt(mode) && isInt(adjust) && adjust >= 0 && adjust <= 255;
        const direct = this.isDirect(mode);
        if (known && frames.holds(tsm, this.width, this.height) && (!direct || writes <= CPU_DIRECT_WRITES || !this.instancing)) {
            this.blendRects(n, mode, adjust);
            if (!run) {
                frames.flush();
            }
            return;
        }
        // Whatever the run holds goes back before the GPU draws.
        frames.flush();
        if (known && direct && this.instancing) {
            this.drawRects(tsm, n, mode);
            return;
        }
        if (known && !direct && !FOLDED[mode] && writes > CPU_BLEND_WRITES && frames.acquireTexture(tsm, this.width, this.height)) {
            this.blendRects(n, mode, adjust);
            if (!run) {
                frames.flush();
            }
            return;
        }
        if (known && !direct && !FOLDED[mode]) {
            // The passes as flushPixels makes them, counted while the rectangles are expanded; past
            // MAX_PASSES the rectangles are blended on the processor (flushPasses).
            const passes = this.expandCounted(n, writes);
            const total = this.count;
            this.count = 0;
            this.flushPasses(tsm, total, passes, mode, adjust, n, run);
            return;
        }
        this.expand(n, writes);
        this.flushPixels(tsm, mode, adjust);
    }

    /**
     * expand() with flushPixels' pass count in the same loop: pass[i] is the number of writes to the
     * pixel before write i (seen[] counts them, left counted for flushPasses). Returns the passes.
     */
    private expandCounted(n: number, writes: number): number {
        this.reserve(writes);
        const offsets = this.offsets;
        const values = this.values;
        const pass = this.pass;
        const seen = this.seen;
        const r16 = this.rect16;
        const r32 = this.rect32;
        const width = this.width;
        let at = 0;
        let passes = 0;
        for (let k = 0; k < n; k++) {
            const q = k * 6;
            const x = r16[q];
            const y = r16[q + 1];
            const w = r16[q + 2];
            const h = r16[q + 3];
            const color = r32[k * 3 + 2] | 0;
            for (let row = y; row < y + h; row++) {
                const start = row * width + x;
                for (let o = start; o < start + w; o++, at++) {
                    offsets[at] = o;
                    values[at] = color;
                    const before = seen[o] + 1;
                    seen[o] = before;
                    pass[at] = before;
                    if (before + 1 > passes) {
                        passes = before + 1;
                    }
                }
            }
        }
        this.count = at;
        return passes;
    }

    /** The pixel lists and flushPixels' work arrays at least `writes` long. */
    private reserve(writes: number) {
        if (this.offsets.length < writes) {
            const length = Math.max(writes, this.offsets.length * 2);
            this.offsets = new Int32Array(length);
            this.values = new Int32Array(length);
        }
        if (this.at.length < writes) {
            const length = Math.max(writes, this.at.length * 2);
            this.at = new Int32Array(length);
            this.value = new Int32Array(length);
            this.pass = new Int32Array(length);
        }
    }

    /** The rectangles' writes into the pixel lists, each rectangle row by row. */
    private expand(n: number, writes: number) {
        if (this.offsets.length < writes) {
            const length = Math.max(writes, this.offsets.length * 2);
            this.offsets = new Int32Array(length);
            this.values = new Int32Array(length);
        }
        const offsets = this.offsets;
        const values = this.values;
        const r16 = this.rect16;
        const r32 = this.rect32;
        const width = this.width;
        let at = 0;
        for (let k = 0; k < n; k++) {
            const q = k * 6;
            const x = r16[q];
            const y = r16[q + 1];
            const w = r16[q + 2];
            const h = r16[q + 3];
            const color = r32[k * 3 + 2] | 0;
            for (let row = y; row < y + h; row++) {
                const start = row * width + x;
                for (let o = start; o < start + w; o++, at++) {
                    offsets[at] = o;
                    values[at] = color;
                }
            }
        }
        this.count = at;
    }

    /** The rectangles blended into the frame the run holds (blendRectsCpu). */
    private blendRects(n: number, mode: number, adjust: number) {
        const bounds = blendRectsCpu(this.frames.pixels32, this.width, this.height, this.rect16, this.rect32, n, mode, adjust);
        this.frames.drawn(bounds[0], bounds[1], bounds[2], bounds[3]);
    }

    /** The rectangles in one instanced draw of a direct mode (see the class). */
    private drawRects(tsm, n: number, mode: number) {
        this.rectBuffer.setData(new Uint8Array(this.rectBytes, 0, n * 12));
        this.rectProgram.run(tsm, { count: n, inverse: [1 / this.width, 1 / this.height], mode });
    }

    private drawInstances(values, gl: WebGLRenderingContext, shader: ShaderProgram) {
        const ext = this.instancing;
        const corner = shader.getLocation("a_corner", true) as number;
        const rect = shader.getLocation("a_rect", true) as number;
        const bgr = shader.getLocation("a_bgr", true) as number;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer.getGlBuffer());
        gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(corner);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer.getGlBuffer());
        gl.vertexAttribPointer(rect, 4, gl.UNSIGNED_SHORT, false, 12, 0);
        gl.enableVertexAttribArray(rect);
        ext.vertexAttribDivisorANGLE(rect, 1);
        // 0x00RRGGBB little-endian: the bytes b, g, r, 0.
        gl.vertexAttribPointer(bgr, 4, gl.UNSIGNED_BYTE, true, 12, 8);
        gl.enableVertexAttribArray(bgr);
        ext.vertexAttribDivisorANGLE(bgr, 1);
        this.glBlend(values.mode);
        ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, values.count);
        ext.vertexAttribDivisorANGLE(rect, 0);
        ext.vertexAttribDivisorANGLE(bgr, 0);
        gl.disableVertexAttribArray(corner);
        gl.disableVertexAttribArray(rect);
        gl.disableVertexAttribArray(bgr);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ZERO);
    }

    /**
     * The pixel lists' flush (every flush before 10.11): writes in plot()'s order.
     */
    private flushPixels(tsm, mode: number, adjust: number) {
        const total = this.count;
        this.count = 0;
        if (!total) {
            return;
        }
        if (this.isDirect(mode) && !FOLDED[mode] && (globalThis as any).__avsPlotterAll !== false) {
            // Subtractive 2 (source − frame) does not fold, so it went in passes, one per write to
            // the busiest pixel (thousands for wide lines). GL blends a draw's fragments in the
            // order of its points and this mode needs only the frame's pixel and the write: every
            // write in AVS's order, in one draw, is AVS's result. (The folding modes keep folding:
            // drawing every write of a wide line instead of each pixel once was far slower.)
            // (A test page may set __avsPlotterAll = false for the passes.)
            this.drawAll(tsm, total, mode);
            return;
        }
        const seen = this.seen;
        const offsets = this.offsets;
        const values = this.values;
        if (this.at.length < total) {
            const length = Math.max(total, this.at.length * 2);
            this.at = new Int32Array(length);
            this.value = new Int32Array(length);
            this.pass = new Int32Array(length);
        }
        const at = this.at;
        const value = this.value;
        if (FOLDED[mode] || mode < 0 || mode > 9) {
            // One write a pixel: seen[] holds its slot in the compacted list.
            let unique = 0;
            for (let i = 0; i < total; i++) {
                const offset = offsets[i];
                const slot = seen[offset];
                if (slot < 0) {
                    seen[offset] = unique;
                    at[unique] = offset;
                    value[unique] = values[i];
                    unique++;
                } else {
                    value[slot] = fold(mode, value[slot], values[i]);
                }
            }
            for (let i = 0; i < unique; i++) {
                seen[at[i]] = -1;
            }
            this.draw(tsm, at, value, 0, unique, mode, adjust);
            return;
        }
        // Pass n gets every pixel's n-th write; seen[] counts the writes so far.
        const pass = this.pass;
        let passes = 0;
        for (let i = 0; i < total; i++) {
            const offset = offsets[i];
            const n = seen[offset] + 1;
            seen[offset] = n;
            pass[i] = n;
            if (n + 1 > passes) {
                passes = n + 1;
            }
        }
        this.flushPasses(tsm, total, passes, mode, adjust, 0, null);
    }

    /**
     * flushPixels after its pass count: past MAX_PASSES passes the frame is read back and blended on
     * the processor, else pass after pass on the GPU. `rects`: the writes are still this many
     * rectangles (the rectangles' path), blended then as blendRectsCpu does into the run's frame
     * (`run`: the caller finishes the run) instead of blendOnProcessor's pixel by pixel.
     */
    private flushPasses(tsm, total: number, passes: number, mode: number, adjust: number, rects: number, run: CpuFrameRun | null) {
        const seen = this.seen;
        const offsets = this.offsets;
        const values = this.values;
        const at = this.at;
        const value = this.value;
        const pass = this.pass;
        const direct = this.isDirect(mode);
        // (A test page may set __avsPlotterPasses to compare both ways.)
        if (!direct && passes > ((globalThis as any).__avsPlotterPasses ?? MAX_PASSES)) {
            if (rects > 0 && this.frames.acquireTexture(tsm, this.width, this.height)) {
                for (let i = 0; i < total; i++) {
                    seen[offsets[i]] = -1;
                }
                this.blendRects(rects, mode, adjust);
                if (!run) {
                    this.frames.flush();
                }
                return;
            }
            const frame = this.readFrame(tsm);
            if (frame) {
                for (let i = 0; i < total; i++) {
                    seen[offsets[i]] = -1;
                }
                this.blendOnProcessor(tsm, frame, total, mode, adjust);
                return;
            }
        }
        const start = new Int32Array(passes + 1);
        for (let i = 0; i < total; i++) {
            start[pass[i] + 1]++;
        }
        for (let p = 0; p < passes; p++) {
            start[p + 1] += start[p];
        }
        const fill = start.slice(0, passes);
        for (let i = 0; i < total; i++) {
            const slot = fill[pass[i]]++;
            at[slot] = offsets[i];
            value[slot] = values[i];
            seen[offsets[i]] = -1;
        }
        for (let p = 0; p < passes; p++) {
            this.draw(tsm, at, value, start[p], start[p + 1], mode, adjust);
        }
    }

    /** Every write, in order, in one draw of a direct mode (offsets and colours as floats). */
    private drawAll(tsm, total: number, mode: number) {
        this.drawPacked(tsm, this.offsets, this.values, 0, total, mode);
    }

    /**
     * Writes from..to of `at`/`value`, in order, in one draw of a direct mode: the offsets and colours
     * go as floats (whole numbers) and the vertex shader places and unpacks them.
     */
    private drawPacked(tsm, at: Int32Array, value: Int32Array, from: number, to: number, mode: number) {
        const total = to - from;
        if (this.offsetData.length < total) {
            const length = Math.max(total, this.offsetData.length * 2);
            this.offsetData = new Float32Array(length);
            this.rgbData = new Float32Array(length);
        }
        const offsets = this.offsetData.subarray(0, total);
        const rgb = this.rgbData.subarray(0, total);
        offsets.set(at.subarray(from, to));
        rgb.set(value.subarray(from, to));
        this.offsetBuffer.setData(offsets);
        this.rgbBuffer.setData(rgb);
        this.packed.run(tsm, {
            count: total,
            frame: [this.width, this.height],
            inverse: [1 / this.width, 1 / this.height],
            mode,
            offsets: this.offsetBuffer,
            rgb: this.rgbBuffer,
        });
    }

    public destroy() {
        this.rectProgram.destroy();
        this.rectBuffer.destroy();
        this.cornerBuffer.destroy();
        this.program.destroy();
        this.direct.destroy();
        this.blend.destroy();
        if (this.scratch) {
            this.gl.deleteTexture(this.scratch);
        }
        this.points.destroy();
        this.colors.destroy();
        this.packed.destroy();
        this.offsetBuffer.destroy();
        this.rgbBuffer.destroy();
        if (this.readBuffer) {
            this.gl.deleteFramebuffer(this.readBuffer);
        }
    }

    /** The frame tsm draws on, as bytes (rows bottom up, as GL reads them); null if unreadable. */
    private readFrame(tsm): Uint8Array | null {
        const gl = this.gl;
        const width = this.width;
        const height = this.height;
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        if (!this.readBuffer) {
            this.readBuffer = gl.createFramebuffer();
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.readBuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tsm.getCurrentTexture(), 0);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        if (complete) {
            if (this.pixels.length !== width * height * 4) {
                this.pixels = new Uint8Array(width * height * 4);
            }
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        return complete ? this.pixels : null;
    }

    /**
     * Every write blended into the frame's bytes in AVS's order, then each written pixel put
     * back in one pass that replaces it: the same result as one pass per write.
     */
    private blendOnProcessor(tsm, frame: Uint8Array, total: number, mode: number, adjust: number) {
        const width = this.width;
        const height = this.height;
        const seen = this.seen;
        const offsets = this.offsets;
        const values = this.values;
        const at = this.at;
        const value = this.value;
        let unique = 0;
        for (let i = 0; i < total; i++) {
            const offset = offsets[i];
            let slot = seen[offset];
            if (slot < 0) {
                // The frame's pixel: offsets count rows from the top, GL rows from the bottom.
                const row = Math.floor(offset / width);
                const at4 = ((height - 1 - row) * width + (offset - row * width)) * 4;
                slot = unique++;
                seen[offset] = slot;
                at[slot] = offset;
                value[slot] = (frame[at4] << 16) | (frame[at4 + 1] << 8) | frame[at4 + 2];
            }
            const d = value[slot];
            const s = values[i];
            value[slot] = (blendLineCpu(mode, (d >> 16) & 255, (s >> 16) & 255, adjust) << 16)
                | (blendLineCpu(mode, (d >> 8) & 255, (s >> 8) & 255, adjust) << 8)
                | blendLineCpu(mode, d & 255, s & 255, adjust);
        }
        for (let i = 0; i < unique; i++) {
            seen[at[i]] = -1;
        }
        this.draw(tsm, at, value, 0, unique, 0, 0);
    }

    private draw(tsm, at: Int32Array, value: Int32Array, from: number, to: number, mode: number, adjust: number) {
        const n = to - from;
        if (n <= 0) {
            return;
        }
        if (this.isDirect(mode) && (globalThis as any).__avsPlotterAll !== false) {
            // The same points, packed: two floats a point instead of five worked out here.
            this.drawPacked(tsm, at, value, from, to, mode);
            return;
        }
        const width = this.width;
        const height = this.height;
        if (this.pointData.length < n * 2) {
            const length = Math.max(n, this.pointData.length);
            this.pointData = new Float32Array(length * 2);
            this.colorData = new Float32Array(length * 3);
        }
        const points = this.pointData.subarray(0, n * 2);
        const colors = this.colorData.subarray(0, n * 3);
        for (let i = 0; i < n; i++) {
            const offset = at[from + i];
            const color = value[from + i];
            const row = Math.floor(offset / width);
            const x = offset - row * width;
            points[i * 2] = ((x + 0.5) / width) * 2 - 1;
            points[i * 2 + 1] = 1 - ((row + 0.5) / height) * 2;
            colors[i * 3] = ((color >> 16) & 255) / 255;
            colors[i * 3 + 1] = ((color >> 8) & 255) / 255;
            colors[i * 3 + 2] = (color & 255) / 255;
        }
        this.points.setData(points);
        this.colors.setData(colors);
        if (this.isDirect(mode)) {
            this.direct.run(tsm, { colors: this.colors, count: n, mode, points: this.points });
            return;
        }
        if ((globalThis as any).__avsPlotterDirect !== false && this.copyRect(at, from, to)) {
            this.blend.run(tsm, { adjust, colors: this.colors, count: n, dest: this.scratch, mode, points: this.points });
            return;
        }
        // (The way before: the whole frame copied by a swap — kept for comparing, see isDirect.)
        const dest = tsm.getCurrentTexture();
        this.program.run(tsm, { adjust, colors: this.colors, count: n, dest, mode, points: this.points });
    }
}

const plotters = new WeakMap();

/** The plotter of main's rendering context (a restored context gets a new one). */
export function avsPlotter(main): AvsPlotter {
    const rctx = main.getRctx();
    let plotter = plotters.get(rctx);
    if (!plotter) {
        plotter = new AvsPlotter(rctx);
        plotters.set(rctx, plotter);
    }
    return plotter;
}

/** matrix.cpp in single precision, every operation rounded as C's float. */
const f = Math.fround;

export function matrixRotate(m: Float32Array, axis: number, degrees: number) {
    const radians = f(f(degrees) * f(f(3.141592653589) / f(180)));
    m.fill(0);
    m[((axis - 1) << 2) + axis - 1] = 1;
    m[15] = 1;
    const m1 = axis % 3;
    const m2 = (m1 + 1) % 3;
    const c = f(Math.cos(radians));
    const s = f(Math.sin(radians));
    m[(m1 << 2) + m1] = c;
    m[(m1 << 2) + m2] = s;
    m[(m2 << 2) + m2] = c;
    m[(m2 << 2) + m1] = -s;
}

export function matrixTranslate(m: Float32Array, x: number, y: number, z: number) {
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[3] = x;
    m[7] = y;
    m[11] = z;
}

export function matrixMultiply(dest: Float32Array, src: Float32Array) {
    const temp = Float32Array.from(dest);
    for (let i = 0; i < 16; i += 4) {
        for (let j = 0; j < 4; j++) {
            dest[i + j] = f(f(f(f(src[i] * temp[j]) + f(src[i + 1] * temp[4 + j])) + f(src[i + 2] * temp[8 + j])) + f(src[i + 3] * temp[12 + j]));
        }
    }
}

/** matrixApply: out[0…2] = m · (x, y, z, 1). */
export function matrixApply(m: Float32Array, x: number, y: number, z: number, out: Float32Array) {
    out[0] = f(f(f(f(x * m[0]) + f(y * m[1])) + f(z * m[2])) + m[3]);
    out[1] = f(f(f(f(x * m[4]) + f(y * m[5])) + f(z * m[6])) + m[7]);
    out[2] = f(f(f(f(x * m[8]) + f(y * m[9])) + f(z * m[10])) + m[11]);
}
