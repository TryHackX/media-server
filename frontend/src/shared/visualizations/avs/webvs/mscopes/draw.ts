// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * mscopes' drawing effects: Scope, Starfield (BuiltinEffects.cpp), Ring
 * (RenderEffects.cpp), Particles and Vectorscope (ModernEffects.cpp).
 *
 * mscopes drew them on the CPU: lines through its smooth rasterizer (UtilEffects.cpp
 * drawSegmentAA / plotDotAA — coverage anti-aliasing, a pixel lit by how far its centre
 * lies inside the line, round caps where a path turns sharply, thin lines rescaled so a
 * diagonal carries the light a straight one does) and additive light clamped at white.
 * Here every segment, dot or sprite is a quad whose fragment shader works out the same
 * coverage for its pixel; additive light is summed in a light texture and added to the
 * frame clamped at white where any light fell (addLight), replace-mode lines blend over
 * the frame by coverage. "Smooth" is mscopes' default for its own presets; `smooth: 0`
 * draws Scope and Starfield the authentic way (one-pixel spans and 2×2 dots).
 */
import { bandAt, MscopesAudioFrame, WAVEFORM_SAMPLES, SPECTRUM_BINS } from "./audio";
import MscopesEffect from "./base";
import { clearTarget, drawQuad, into, lightType, PRELUDE, Program } from "./gl";

const SEGMENT = 0;
const DOT = 1;
const SPRITE = 2;
const RECT = 3;
const HARD_LINE = 4;

const FLOATS = 13;

const VERTEX = `
attribute vec2 a_corner;
attribute vec4 a_seg;
attribute vec4 a_info;
attribute vec3 a_color;
uniform vec2 u_size;
varying vec4 v_seg;
varying vec4 v_info;
varying vec3 v_color;
void main() {
    v_seg = a_seg;
    v_info = a_info;
    v_color = a_color;
    gl_Position = vec4(a_corner / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 v_seg;
varying vec4 v_info;
varying vec3 v_color;
uniform float u_replace;

float dotCoverage(vec2 pc, vec2 at, float radius) {
    if (radius <= 0.75) {
        // A one-pixel footprint split over the pixels it overlaps.
        vec2 d = abs(pc - at);
        return max(0.0, 1.0 - d.x) * max(0.0, 1.0 - d.y);
    }
    return clamp(radius + 0.5 - length(pc - at), 0.0, 1.0);
}

// drawSegmentAA's coverage for the pixel whose centre is pc.
float segmentCoverage(vec2 pc) {
    float x0 = v_seg.x, y0 = v_seg.y, x1 = v_seg.z, y1 = v_seg.w;
    float hw = max(0.5, v_info.x);
    bool capStart = mod(v_info.y, 2.0) > 0.5;
    bool capEnd = v_info.y > 1.5;
    float dx = x1 - x0, dy = y1 - y0;
    float len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) {
        return (capStart || capEnd) ? dotCoverage(pc, vec2(x0, y0), hw) : 0.0;
    }
    float reach = hw + 0.5;
    float len = sqrt(len2);
    vec2 r = pc - vec2(x0, y0);
    float dperp = abs(r.x * dy - r.y * dx) / len;
    if (dperp >= reach) return 0.0;
    float t = (r.x * dx + r.y * dy) / len2;
    float cov;
    if (t < 0.0) {
        if (!capStart) return 0.0;
        cov = clamp(reach - length(r), 0.0, 1.0);
    } else if (t > 1.0) {
        if (!capEnd) return 0.0;
        cov = clamp(reach - length(r - vec2(dx, dy)), 0.0, 1.0);
    } else {
        cov = min(1.0, reach - dperp);
    }
    if (hw <= 1.51) {
        // Each major-axis step carries exactly what the infinite line would there.
        bool xMajor = abs(dx) >= abs(dy);
        float major = xMajor ? abs(dx) : abs(dy);
        float span = reach * len / major;
        float expect = 2.0 * hw * len / major;
        float s = 0.0;
        if (xMajor) {
            float yi = y0 + (pc.x - x0) * dy / dx;
            float lo = floor(yi - span), hi = ceil(yi + span);
            for (int k = 0; k < 10; k++) {
                float py = lo + float(k);
                if (py > hi) break;
                s += clamp(reach - abs((py + 0.5 - y0) * dx - (pc.x - x0) * dy) / len, 0.0, 1.0);
            }
        } else {
            float xi = x0 + (pc.y - y0) * dx / dy;
            float lo = floor(xi - span), hi = ceil(xi + span);
            for (int k = 0; k < 10; k++) {
                float px = lo + float(k);
                if (px > hi) break;
                s += clamp(reach - abs((pc.y - y0) * dx - (px + 0.5 - x0) * dy) / len, 0.0, 1.0);
            }
        }
        if (s > 1e-4) cov *= expect / s;
    }
    return min(cov, 1.0);
}

// A one-pixel line between integer pixel centres, one pixel per major-axis step.
float hardLine(vec2 pc) {
    vec2 a = v_seg.xy, b = v_seg.zw;
    vec2 d = b - a;
    if (abs(d.x) >= abs(d.y)) {
        if (pc.x < min(a.x, b.x) || pc.x > max(a.x, b.x)) return 0.0;
        float y = abs(d.x) < 1e-6 ? a.y : a.y + (pc.x - a.x) * d.y / d.x;
        return abs(pc.y - floor(y) - 0.5) < 0.25 ? 1.0 : 0.0;
    }
    if (pc.y < min(a.y, b.y) || pc.y > max(a.y, b.y)) return 0.0;
    float x = a.x + (pc.y - a.y) * d.x / d.y;
    return abs(pc.x - floor(x) - 0.5) < 0.25 ? 1.0 : 0.0;
}

void main() {
    vec2 pc = floor(gl_FragCoord.xy) + 0.5;
    float kind = v_info.z;
    float cov;
    if (kind < 0.5) {
        cov = segmentCoverage(pc);
    } else if (kind < 1.5) {
        cov = dotCoverage(pc, v_seg.xy, v_info.x);
    } else if (kind < 2.5) {
        // A gaussian sprite: centre v_seg.xy, the integer square around it in v_seg.zw.
        vec2 e = pc - v_seg.xy;
        cov = exp(-dot(e, e) * v_info.x) * v_info.w;
        if (cov < 0.02) cov = 0.0;
    } else if (kind < 3.5) {
        cov = 1.0;
    } else {
        cov = hardLine(pc);
    }
    if (cov <= 0.0) discard;
    if (u_replace > 0.5) {
        gl_FragColor = vec4(v_color, min(cov, 1.0));
    } else {
        gl_FragColor = vec4(v_color * cov, 1.0);
    }
}`;

const COMPOSITE = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_light;
uniform vec2 u_size;
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec3 c = texture2D(u_src, uv).rgb;
    vec3 l = max(texture2D(u_light, uv).rgb, 0.0);
    // addLight: where light fell, the sum clamped at white; elsewhere the frame as it was.
    vec3 o = vec3(l.r > 0.0 ? min(1.0, c.r + l.r) : c.r,
                  l.g > 0.0 ? min(1.0, c.g + l.g) : c.g,
                  l.b > 0.0 ? min(1.0, c.b + l.b) : c.b);
    gl_FragColor = vec4(o, 1.0);
}`;

/** BuiltinEffects.cpp hsv(): h in turns. */
export function hsvSwitch(h: number, s: number, v: number): [number, number, number] {
    h = h - Math.floor(h);
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - s * f);
    const t = v * (1 - s * (1 - f));
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

/** ModernEffects.cpp hue2rgb(). */
export function hueRgb(h: number): [number, number, number] {
    h -= Math.floor(h);
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    return [clamp01(Math.abs(h * 6 - 3) - 1), clamp01(2 - Math.abs(h * 6 - 2)), clamp01(2 - Math.abs(h * 6 - 4))];
}

/** sharpTurn (LineMode.h): the path a → b → c turns by more than about 35° at b. */
export function sharpTurn(ax, ay, bx, by, cx, cy): boolean {
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by;
    const lu = ux * ux + uy * uy, lv = vx * vx + vy * vy;
    if (lu < 1e-8 || lv < 1e-8) {
        return true;
    }
    return (ux * vx + uy * vy) / Math.sqrt(lu * lv) < 0.82;
}

/** xorshift32 as mscopes' effects roll it: 24 bits, 0…1. */
export function xorshift(state: { rng: number }): number {
    let x = state.rng >>> 0;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    state.rng = x;
    return (x & 0xffffff) / 0x1000000;
}

/** Quads to draw this frame: segments, dots, sprites and rectangles in pixels. */
class Batch {
    private data: Float32Array;
    public count: number;

    constructor() {
        this.data = new Float32Array(6 * FLOATS * 256);
        this.count = 0;
    }

    public reset(): void {
        this.count = 0;
    }

    private grow(): void {
        if ((this.count + 1) * 6 * FLOATS > this.data.length) {
            const bigger = new Float32Array(this.data.length * 2);
            bigger.set(this.data);
            this.data = bigger;
        }
    }

    private quad(corners: number[], seg: number[], info: number[], color: number[]): void {
        this.grow();
        let o = this.count * 6 * FLOATS;
        const order = [0, 1, 2, 0, 2, 3];
        for (const c of order) {
            this.data[o++] = corners[c * 2];
            this.data[o++] = corners[c * 2 + 1];
            this.data[o++] = seg[0]; this.data[o++] = seg[1]; this.data[o++] = seg[2]; this.data[o++] = seg[3];
            this.data[o++] = info[0]; this.data[o++] = info[1]; this.data[o++] = info[2]; this.data[o++] = info[3];
            this.data[o++] = color[0]; this.data[o++] = color[1]; this.data[o++] = color[2];
        }
        this.count++;
    }

    /** drawSegmentAA (halfWidth in pixels). */
    public segment(x0, y0, x1, y1, halfWidth, r, g, b, capStart = true, capEnd = true): void {
        if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
            return;
        }
        const cl = (v) => Math.min(8192, Math.max(-8192, v));
        x0 = cl(x0); y0 = cl(y0); x1 = cl(x1); y1 = cl(y1);
        const hw = Math.max(0.5, halfWidth);
        const ext = hw + 2;
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        const ux = len > 1e-3 ? dx / len : 1, uy = len > 1e-3 ? dy / len : 0;
        const nx = -uy, ny = ux;
        const ax = x0 - ux * ext, ay = y0 - uy * ext, bx = x1 + ux * ext, by = y1 + uy * ext;
        this.quad([ax + nx * ext, ay + ny * ext, ax - nx * ext, ay - ny * ext, bx - nx * ext, by - ny * ext, bx + nx * ext, by + ny * ext],
            [x0, y0, x1, y1], [hw, (capStart ? 1 : 0) + (capEnd ? 2 : 0), SEGMENT, 0], [r, g, b]);
    }

    /** plotDotAA. */
    public dot(x, y, radius, r, g, b): void {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const e = radius + 2;
        this.quad([x - e, y - e, x + e, y - e, x + e, y + e, x - e, y + e], [x, y, x, y], [radius, 0, DOT, 0], [r, g, b]);
    }

    /** A gaussian sprite over the pixels [x0, x1) × [y0, y1). */
    public sprite(x, y, x0, y0, x1, y1, inv2s2, fade, r, g, b): void {
        this.quad([x0, y0, x1, y0, x1, y1, x0, y1], [x, y, 0, 0], [inv2s2, 0, SPRITE, fade], [r, g, b]);
    }

    /** Pixels [x0, x1) × [y0, y1), fully. */
    public rect(x0, y0, x1, y1, r, g, b): void {
        this.quad([x0, y0, x1, y0, x1, y1, x0, y1], [0, 0, 0, 0], [0, 0, RECT, 0], [r, g, b]);
    }

    /** A one-pixel line between integer pixels (Bresenham's). */
    public hardLine(x0, y0, x1, y1, r, g, b): void {
        const ax = x0 + 0.5, ay = y0 + 0.5, bx = x1 + 0.5, by = y1 + 0.5;
        this.quad([Math.min(ax, bx) - 1, Math.min(ay, by) - 1, Math.max(ax, bx) + 1, Math.min(ay, by) - 1,
            Math.max(ax, bx) + 1, Math.max(ay, by) + 1, Math.min(ax, bx) - 1, Math.max(ay, by) + 1],
        [ax, ay, bx, by], [0.5, 0, HARD_LINE, 0], [r, g, b]);
    }

    public array(): Float32Array {
        return this.data.subarray(0, this.count * 6 * FLOATS);
    }
}

/** A drawing effect: collects quads, then adds them to the frame as light (or blends them over it). */
export class MscopesDrawEffect extends MscopesEffect {
    protected batch: Batch;
    private buffer: WebGLBuffer;

    protected setup() {
        this.batch = new Batch();
        this.buffer = this.gl.createBuffer();
        this.start();
    }

    protected teardown() {
        if (this.buffer) {
            this.gl.deleteBuffer(this.buffer);
            this.buffer = null;
        }
    }

    protected start() {}

    /** Render pixels per "point": a one-point line stays one point wide (DrawQuality.widthScale). */
    protected widthScale(): number {
        const canvas = this.gl.canvas as HTMLCanvasElement;
        const shown = canvas && canvas.clientWidth;
        return shown > 0 ? Math.max(1, this.gl.drawingBufferWidth / shown) : 1;
    }

    private drawBatch(replace: boolean): void {
        const gl = this.gl;
        const program = this.program("draw", FRAGMENT, VERTEX);
        program.use();
        program.f("u_size", gl.drawingBufferWidth, gl.drawingBufferHeight);
        program.f("u_replace", replace ? 1 : 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.batch.array(), gl.STREAM_DRAW);
        const stride = FLOATS * 4;
        const attributes = [["a_corner", 2, 0], ["a_seg", 4, 2], ["a_info", 4, 6], ["a_color", 3, 10]];
        const enabled = [];
        for (const [name, size, offset] of attributes) {
            const location = program.attribute(name);
            if (location < 0) {
                continue;
            }
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
            gl.enableVertexAttribArray(location);
            enabled.push(location);
        }
        gl.drawArrays(gl.TRIANGLES, 0, this.batch.count * 6);
        for (const location of enabled) {
            gl.disableVertexAttribArray(location);
        }
    }

    /** Adds the batch to the frame as light, clamped at white where any light fell. */
    protected addLight(): void {
        if (!this.batch.count) {
            return;
        }
        const gl = this.gl;
        const light = this.scratch("light", undefined, undefined, lightType(gl));
        clearTarget(gl, light, 0, 0, 0, 0);
        into(gl, light, () => {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.blendEquation(gl.FUNC_ADD);
            this.drawBatch(false);
            gl.disable(gl.BLEND);
        });
        this.pass(this.program("composite", COMPOSITE), (p) => p.texture("u_light", light.texture), false);
    }

    /** Blends the batch over the frame by coverage (replace-mode lines), the frame's alpha kept. */
    protected blendOver(): void {
        if (!this.batch.count) {
            return;
        }
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.blendEquation(gl.FUNC_ADD);
        this.drawBatch(true);
        gl.disable(gl.BLEND);
    }
}

/**
 * Scope (BuiltinEffects.cpp): the waveform as a bright additive trace, hue cycling,
 * plus a spectrum glow of 96 one-pixel bars along the bottom (the log bands, cubed).
 * `steady` draws the triggered waveform, which holds a steady tone still.
 */
export class MscopesScope extends MscopesDrawEffect {
    public static componentName = "MscopesScope";
    public static componentTag = "render";

    protected render(audio: MscopesAudioFrame) {
        const W = this.width(), H = this.height();
        const amp = this.param("amp", 0.34, 0.05, 0.6);
        const gain = this.param("gain", 0.9, 0.2, 1.5);
        const steady = this.param("steady", 0, 0, 1);
        const smooth = this.param("smooth", 1, 0, 1) > 0.5;
        const midY = H * 0.5;
        const hueBase = (this.host.frame % 600) / 600;
        const wave = audio.hasFeatures && steady > 0.5 ? audio.scope : audio.waveform;
        const batch = this.batch;
        batch.reset();
        if (smooth) {
            const hw = 0.5 * Math.max(0.25, this.widthScale());
            const N = Math.max(2, Math.floor(W / 2));
            let lx = 0, ly = midY, llx = 0, lly = midY;
            for (let i = 0; i < N; i++) {
                const t = i / (N - 1);
                const pos = t * (WAVEFORM_SAMPLES - 1);
                const i0 = Math.trunc(pos), i1 = Math.min(i0 + 1, WAVEFORM_SAMPLES - 1);
                const s = wave[i0] + (wave[i1] - wave[i0]) * (pos - i0);
                const x = 0.5 + t * (W - 1), y = midY + s * (H * amp);
                if (i > 0) {
                    const [r, g, b] = hsvSwitch(hueBase + t * 0.25, 0.85, gain);
                    batch.segment(lx, ly, x, y, hw, r, g, b, i === 1 || sharpTurn(llx, lly, lx, ly, x, y), i === N - 1);
                }
                llx = lx; lly = ly; lx = x; ly = y;
            }
        } else {
            let prevY = midY;
            for (let x = 0; x < W; x++) {
                const t = x / (W - 1);
                const wi = Math.min(Math.trunc(t * WAVEFORM_SAMPLES), WAVEFORM_SAMPLES - 1);
                const y = midY + wave[wi] * (H * amp);
                const [r, g, b] = hsvSwitch(hueBase + t * 0.25, 0.85, gain);
                const y0 = Math.min(H - 1, Math.max(0, Math.trunc(Math.min(prevY, y))));
                const y1 = Math.min(H - 1, Math.max(0, Math.trunc(Math.max(prevY, y))));
                batch.rect(x, y0, x + 1, y1 + 1, r, g, b);
                prevY = y;
            }
        }
        // The spectrum glow: one column per bar, from the bottom row up.
        const bars = 96;
        for (let bar = 0; bar < bars; bar++) {
            const f = bar / bars;
            let e;
            if (audio.hasFeatures) {
                const level = bandAt(audio, f + 0.5 / bars);
                e = level * level * level * 0.3;
            } else {
                const lo = Math.trunc(f * SPECTRUM_BINS), hi = Math.min(Math.trunc((f + 1 / bars) * SPECTRUM_BINS), SPECTRUM_BINS);
                e = 0;
                for (let i = lo; i < hi; i++) {
                    e += audio.spectrum[i];
                }
                e /= Math.max(1, hi - lo);
            }
            const bh = Math.trunc(e * H * 0.35);
            if (bh > 0) {
                const [r, g, b] = hsvSwitch(0.6 - f * 0.6, 0.9, gain * 0.7);
                const x = Math.trunc(f * W);
                batch.rect(x, 0, x + 1, Math.min(H, bh), r, g, b);
            }
        }
        this.addLight();
    }
}

/** Starfield (BuiltinEffects.cpp): stars flying out of the centre, faster with the bass. */
export class MscopesStarfield extends MscopesDrawEffect {
    public static componentName = "MscopesStarfield";
    public static componentTag = "render";
    private stars: Float32Array;
    private random: { rng: number };

    protected start() {
        this.random = { rng: 0x9d2c5680 };
        this.stars = new Float32Array(320 * 3);
        for (let i = 0; i < 320; i++) {
            this.stars[i * 3] = xorshift(this.random) * 2 - 1;
            this.stars[i * 3 + 1] = xorshift(this.random) * 2 - 1;
            this.stars[i * 3 + 2] = 0.05 + xorshift(this.random) * 0.95;
        }
    }

    protected render(audio: MscopesAudioFrame) {
        const W = this.width(), H = this.height();
        const cx = W * 0.5, cy = H * 0.5;
        const scale = 0.5 * Math.min(W, H);
        const dz = (this.param("speed", 0.35, 0.05, 1.5) + this.param("speedBass", 1.2, 0, 3) * audio.bass) * this.host.dt;
        const brightness = this.param("brightness", 0.9, 0.2, 1.5);
        const smooth = this.param("smooth", 1, 0, 1) > 0.5;
        const radius = Math.max(0.25, this.widthScale());
        const stars = this.stars;
        const batch = this.batch;
        batch.reset();
        for (let i = 0; i < 320; i++) {
            const o = i * 3;
            stars[o + 2] -= dz;
            if (stars[o + 2] <= 0.05) {
                stars[o] = xorshift(this.random) * 2 - 1;
                stars[o + 1] = xorshift(this.random) * 2 - 1;
                stars[o + 2] = 1;
            }
            const px = cx + (stars[o] / stars[o + 2]) * scale;
            const py = cy + (stars[o + 1] / stars[o + 2]) * scale;
            const lum = brightness * (1 - stars[o + 2]) * (0.6 + 0.4 * audio.mid);
            if (smooth) {
                batch.dot(px, py, radius, lum, lum, Math.min(1, lum * 1.15));
            } else if (px > -4 && py > -4 && px < W + 4 && py < H + 4) {
                const ix = Math.trunc(px), iy = Math.trunc(py);
                batch.rect(ix, iy, ix + 2, iy + 2, lum, lum, Math.min(1, lum * 1.15));
            }
        }
        this.addLight();
    }
}

/**
 * Ring (RenderEffects.cpp, mscopes' take on AVS Ring): 80 segments round a centre,
 * the radius following the first 41 waveform taps (mirrored), in one hue; drawn in
 * the line mode's default (replace), smooth unless `smooth: 0`.
 */
export class MscopesRing extends MscopesDrawEffect {
    public static componentName = "MscopesRing";
    public static componentTag = "render";

    protected render(audio: MscopesAudioFrame) {
        const W = this.width(), H = this.height();
        const [r, g, b] = hsvSwitch(this.param("hue", 0.5, 0, 1), 0.85, this.param("gain", 0.8, 0.1, 1.5));
        const sizePx = this.param("size", 0.25, 0.05, 1) * Math.min(W, H);
        const cy = Math.trunc(H / 2);
        const p = Math.min(2, Math.max(0, Math.trunc(this.param("posX", 1, 0, 2))));
        const cx = p === 0 ? Math.trunc(W / 4) : p === 2 ? Math.trunc(W / 2) + Math.trunc(W / 4) : Math.trunc(W / 2);
        const wave = audio.waveform;
        const sampleWave = (pos) => {
            pos = Math.min(WAVEFORM_SAMPLES - 1, Math.max(0, pos));
            const i0 = Math.trunc(pos), i1 = Math.min(i0 + 1, WAVEFORM_SAMPLES - 1);
            const f = pos - i0;
            return wave[i0] * (1 - f) + wave[i1] * f;
        };
        const sca = (q) => {
            const qq = q > 40 ? 80 - q : q;
            return 0.1 + (sampleWave((qq * (WAVEFORM_SAMPLES - 1)) / 40) * 0.5 + 0.5) * 0.9;
        };
        const passes = Math.min(4, Math.max(1, Math.trunc(this.param("thickness", 1, 1, 4))));
        const smooth = this.param("smooth", 1, 0, 1) > 0.5;
        const hw = 0.5 * Math.max(0.25, this.widthScale());
        const batch = this.batch;
        batch.reset();
        for (let pass = 0; pass < passes; pass++) {
            const rad = sizePx + pass;
            let ang = 0;
            const s0 = sca(0);
            if (smooth) {
                const ox = cx + 0.5, oy = cy + 0.5;
                let lx = ox + Math.cos(ang) * rad * s0, ly = oy + Math.sin(ang) * rad * s0;
                let llx = lx, lly = ly;
                for (let q = 1; q <= 80; q++) {
                    ang -= (Math.PI * 2) / 80;
                    const s = sca(q);
                    const tx = ox + Math.cos(ang) * rad * s, ty = oy + Math.sin(ang) * rad * s;
                    batch.segment(lx, ly, tx, ty, hw, r, g, b, q === 1 || sharpTurn(llx, lly, lx, ly, tx, ty), false);
                    llx = lx; lly = ly; lx = tx; ly = ty;
                }
            } else {
                let lx = cx + Math.trunc(Math.cos(ang) * rad * s0), ly = cy + Math.trunc(Math.sin(ang) * rad * s0);
                for (let q = 1; q <= 80; q++) {
                    ang -= (Math.PI * 2) / 80;
                    const s = sca(q);
                    const tx = cx + Math.trunc(Math.cos(ang) * rad * s), ty = cy + Math.trunc(Math.sin(ang) * rad * s);
                    batch.hardLine(tx, ty, lx, ly, r, g, b);
                    lx = tx; ly = ty;
                }
            }
        }
        this.blendOver();
    }
}

/**
 * Particles (ModernEffects.cpp ParticleSystemEffect): an emitter at the centre,
 * velocity, drag and gravity, bursts on hits, additive gaussian sprites along a hue
 * ramp that fade with their life.
 */
export class MscopesParticles extends MscopesDrawEffect {
    public static componentName = "MscopesParticles";
    public static componentTag = "render";
    private particles: any[];
    private carry: number;
    private random: { rng: number };

    protected start() {
        this.particles = [];
        this.carry = 0;
        this.random = { rng: 0x1234567 };
    }

    protected render(audio: MscopesAudioFrame) {
        const W = this.width(), H = this.height();
        const dt = Math.min(1 / 15, Math.max(1 / 240, this.host.dt));
        const unit = H * 0.5;
        const cap = Math.min(4000, Math.max(32, Math.trunc(this.param("maxCount", 600, 32, 2000))));
        const frand = () => xorshift(this.random);
        this.carry += this.param("emitRate", 120, 0, 1000) * dt + (this.onBeat(audio) ? this.param("beatBurst", 150, 0, 600) : 0);
        const born = Math.trunc(this.carry);
        this.carry -= born;
        const v0 = this.param("speed", 0.45, 0.05, 2) * (1 + this.param("speedBass", 0.8, 0, 3) * audio.bass);
        const lifetime = this.param("lifetime", 2.2, 0.3, 6);
        const hue = this.param("hue", 0.58, 0, 1);
        const hueSpread = this.param("hueSpread", 0.25, 0, 1);
        for (let k = 0; k < born && this.particles.length < cap; k++) {
            const ang = frand() * 6.2831853;
            const mag = v0 * (0.4 + 0.6 * frand());
            const life = lifetime * (0.5 + 0.5 * frand());
            this.particles.push({
                x: W * 0.5, y: H * 0.5,
                vx: Math.cos(ang) * mag * unit, vy: Math.sin(ang) * mag * unit,
                life, maxLife: life, hue: hue + (frand() - 0.5) * hueSpread,
            });
        }
        const dragK = Math.exp(-this.param("drag", 0.5, 0, 3) * dt);
        const gravity = this.param("gravity", 0.15, -1, 1) * unit * dt;
        for (const p of this.particles) {
            p.vx *= dragK;
            p.vy *= dragK;
            p.vy += gravity;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= dt;
        }
        this.particles = this.particles.filter((p) => !(p.life <= 0 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20));

        const size = this.param("size", 3.5, 1, 12);
        const rad = Math.max(1, Math.trunc(size));
        const inv2s2 = 1 / (2 * (size * 0.5) * (size * 0.5) + 1e-3);
        const batch = this.batch;
        batch.reset();
        for (const p of this.particles) {
            let fade = p.life / p.maxLife;
            fade = fade * fade * (3 - 2 * fade);
            const [r, g, b] = hueRgb(p.hue);
            const cx = Math.floor(p.x), cy = Math.floor(p.y);
            batch.sprite(p.x, p.y, cx - rad, cy - rad, cx + rad + 2, cy + rad + 2, inv2s2, fade, r, g, b);
        }
        this.addLight();
    }
}

/**
 * Vectorscope (ModernEffects.cpp): every sample since the previous frame as one
 * continuous beam, brighter where it moves slowly — stereo (a goniometer) or phase
 * (the signal against itself a moment earlier; the player's audio is mono, so stereo
 * mode is a vertical line). The level is followed so quiet music fills it too.
 */
export class MscopesVectorscope extends MscopesDrawEffect {
    public static componentName = "MscopesVectorscope";
    public static componentTag = "render";
    private peakX: number;
    private peakY: number;
    private lpU: number;
    private lpV: number;
    private hist: Float32Array;
    private xs: Float32Array;
    private ys: Float32Array;
    private haveLast: boolean;
    private lx: number;
    private ly: number;

    protected start() {
        this.peakX = 0.05;
        this.peakY = 0.05;
        this.lpU = 0;
        this.lpV = 0;
        this.hist = new Float32Array(256);
        this.xs = new Float32Array(4096);
        this.ys = new Float32Array(4096);
        this.haveLast = false;
        this.lx = 0;
        this.ly = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        const W = this.width(), H = this.height();
        let samples, n;
        if (audio.hasFeatures && audio.recentCount > 1) {
            samples = audio.recent;
            n = audio.recentCount;
        } else {
            samples = audio.waveform;
            n = WAVEFORM_SAMPLES;
            this.haveLast = false;
        }
        const dt = Math.max(1e-3, this.host.dt);
        const phase = this.param("mode", 1, 0, 1) > 0.5;
        const d = Math.min(200, Math.max(1, Math.trunc(this.param("delay", 96, 1, 200))));
        if (this.xs.length < n) {
            this.xs = new Float32Array(n);
            this.ys = new Float32Array(n);
        }
        const xs = this.xs, ys = this.ys;
        const lpA = 1 - Math.exp((-2 * Math.PI * 1500) / 48000);
        let pk = 0, sX = 0, sY = 0;
        for (let i = 0; i < n; i++) {
            let u, v;
            if (phase) {
                u = samples[i];
                v = i >= d ? samples[i - d] : this.hist[256 - d + i];
            } else {
                u = samples[i];
                v = samples[i];
            }
            pk = Math.max(pk, Math.max(Math.abs(u), Math.abs(v)));
            this.lpU += lpA * (u - this.lpU);
            this.lpV += lpA * (v - this.lpV);
            xs[i] = (this.lpU - this.lpV) * 0.70710678;
            ys[i] = (this.lpU + this.lpV) * 0.70710678;
            sX += xs[i] * xs[i];
            sY += ys[i] * ys[i];
        }
        for (let j = 0; j < 256; j++) {
            const i = n - 256 + j;
            this.hist[j] = i >= 0 ? samples[i] : this.hist[Math.min(255, j + n)];
        }
        if (pk < 0.003) {
            this.haveLast = false;
            return;
        }
        const rX = Math.sqrt(sX / n), rY = Math.sqrt(sY / n);
        const a0 = 1 - Math.exp(-dt / 0.5);
        this.peakX += ((phase ? rX : Math.max(rX, rY)) - this.peakX) * a0;
        this.peakY += ((phase ? rY : Math.max(rX, rY)) - this.peakY) * a0;
        this.peakX = Math.max(this.peakX, 0.003);
        this.peakY = Math.max(this.peakY, 0.003);
        const normalize = this.param("normalize", 1, 0, 1) > 0.5;
        const half = 0.5 * Math.min(W, H) * this.param("size", 0.8, 0.1, 1);
        const sx = (normalize ? 0.45 / this.peakX : 1) * half;
        const sy = (normalize ? 0.45 / this.peakY : 1) * half;
        const cx = W * 0.5, cy = H * 0.5;
        const pointX = (i) => cx + xs[i] * sx;
        const pointY = (i) => cy - ys[i] * sy;
        const rgb = hueRgb(this.param("hue", 0.36, 0, 1) + this.param("hueSpeed", 0, 0, 0.5) * this.host.time).map((c) => 0.25 + 0.75 * c);
        const scale = this.widthScale();
        const hw = 0.5 * this.param("width", 1, 0.5, 4) * Math.max(0.25, scale);
        const k = 3 * this.param("gain", 1, 0, 3) * Math.max(1, scale);
        let px, py, ppx = 0, ppy = 0, i0 = 0;
        if (this.haveLast) {
            px = this.lx;
            py = this.ly;
        } else {
            px = pointX(0);
            py = pointY(0);
            i0 = 1;
        }
        const merge = 1.5 * Math.max(1, scale);
        const batch = this.batch;
        batch.reset();
        let first = true, m = 0, path = 0, qx = px, qy = py;
        for (let i = i0; i < n; i++) {
            const x = pointX(i), y = pointY(i);
            path += Math.hypot(x - qx, y - qy);
            qx = x;
            qy = y;
            m++;
            if (path < merge && m < 16 && i !== n - 1) {
                continue;
            }
            const len = Math.hypot(x - px, y - py);
            const e = Math.min((m * k) / Math.max(len, 0.7), 1.5);
            const capStart = first || sharpTurn(ppx, ppy, px, py, x, y);
            batch.segment(px, py, x, y, hw, rgb[0] * e, rgb[1] * e, rgb[2] * e, capStart, i === n - 1);
            ppx = px; ppy = py; px = x; py = y;
            first = false;
            m = 0;
            path = 0;
        }
        this.lx = px;
        this.ly = py;
        this.haveLast = audio.hasFeatures && audio.recentCount > 1;
        this.addLight();
    }
}
