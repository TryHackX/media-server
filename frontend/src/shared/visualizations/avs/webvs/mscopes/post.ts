// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * mscopes' one-pass GPU effects (core/effects/GpuEffects.cpp, ModernEffects.cpp,
 * BuiltinEffects.cpp; kernels fx_* in core/gpu/metal/GpuFx.mm), each the Metal kernel
 * as a fragment shader with the same parameters, defaults and per-frame logic.
 * `g` is the kernel's pixel (row 0 at the bottom, as in mscopes' framebuffer), `u_src`
 * the frame, sampled bilinearly with clamped edges where the kernel sampled
 * (`src.sample`) and at texel centres where it read (`src.read`).
 */
import { MscopesAudioFrame } from "./audio";
import MscopesEffect from "./base";
import { DataTexture, GLSL_COMMON, PRELUDE } from "./gl";

const KERNEL = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
${GLSL_COMMON}
vec4 readAt(vec2 g) { return texture2D(u_src, (g + 0.5) / u_size); }
vec4 sampleUv(vec2 uv) { return texture2D(u_src, clamp(uv, 0.5 / u_size, 1.0 - 0.5 / u_size)); }
`;

// wv_q8: AVS's 8-bit truncation, as mscopes' classic ports end every pass.
const Q8 = "vec3 q8(vec3 v) { return floor(clamp(v, 0.0, 1.0) * 255.0) / 255.0; }";

/** fx_kaleido: N-fold mirrored kaleidoscope with continuous spin. */
export class MscopesKaleidoscope extends MscopesEffect {
    public static componentName = "MscopesKaleidoscope";
    private angle: number;
    private kick: number;

    protected setup() {
        this.angle = 0;
        this.kick = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        const dt = this.stepTime();
        if (this.onBeat(audio)) {
            this.kick += this.param("spinBeat", 0.35, 0, 2);
        }
        this.kick *= Math.pow(0.05, dt);
        this.angle += (this.param("spin", 0.15, -2, 2) + this.kick) * dt;
        const segments = Math.min(16, Math.max(2, Math.trunc(this.param("segments", 6, 2, 16))));
        const zoom = this.param("zoom", 1, 0.5, 2);
        this.pass(this.program("k", `${KERNEL}
            uniform vec3 u_p;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec2 c = u_size * 0.5;
                vec2 d = (g - c) / c.y;
                float r = length(d);
                float seg = 6.2831853 / max(u_p.x, 2.0);
                float a = atan(d.y, d.x) + u_p.y;
                a = a - seg * floor(a / seg);
                a = abs(a - seg * 0.5);
                vec2 s = vec2(cos(a), sin(a)) * r * u_p.z;
                vec2 uv = (s * c.y + c) / u_size;
                gl_FragColor = vec4(sampleUv(uv).rgb, 1.0);
            }`), (p) => p.f("u_p", segments, this.angle, zoom));
    }
}

/** fx_rgbsplit: red and blue sampled ± an offset along an angle, pumped by the beat. */
export class MscopesRgbSplit extends MscopesEffect {
    public static componentName = "MscopesRgbSplit";
    private pump: number;

    protected setup() {
        this.pump = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        const dt = this.stepTime();
        if (this.onBeat(audio)) {
            this.pump = this.param("beatPump", 6, 0, 24);
        }
        this.pump *= Math.pow(0.02, dt);
        const amount = this.param("amount", 2.5, 0, 24) + this.pump;
        if (amount < 0.05) {
            return;
        }
        const angle = this.param("angle", 0, 0, 6.2832);
        this.pass(this.program("k", `${KERNEL}
            uniform vec2 u_offset;
            void main() {
                vec2 uv = gl_FragCoord.xy / u_size;
                vec2 off = u_offset / u_size;
                gl_FragColor = vec4(sampleUv(uv + off).r, sampleUv(uv).g, sampleUv(uv - off).b, 1.0);
            }`), (p) => p.f("u_offset", amount * Math.cos(angle), amount * Math.sin(angle)));
    }
}

/** fx_tonemap: exposure roll-off (1 − e^−x), gamma, saturation. */
export class MscopesToneMap extends MscopesEffect {
    public static componentName = "MscopesToneMap";

    protected render() {
        const exposure = this.param("exposure", 1.4, 0.25, 4);
        const gamma = this.param("gamma", 1, 0.5, 2.5);
        const saturation = this.param("saturation", 1.15, 0, 2);
        this.pass(this.program("k", `${KERNEL}
            uniform vec3 u_p;
            void main() {
                vec3 c = readAt(floor(gl_FragCoord.xy)).rgb;
                c = 1.0 - exp(-c * u_p.x);
                c = pow(max(c, 0.0), vec3(u_p.y));
                float lum = luma601(c);
                c = mix(vec3(lum), c, u_p.z);
                gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
            }`), (p) => p.f("u_p", exposure, 1 / Math.max(0.1, gamma), saturation), false);
    }
}

/** fx_vignette: darker towards the edge, aspect-true (1 = half the height). */
export class MscopesVignette extends MscopesEffect {
    public static componentName = "MscopesVignette";

    protected render() {
        const inner = this.param("inner", 0.55, 0, 1.5);
        const outer = this.param("outer", 1.25, 0.2, 2);
        const strength = this.param("strength", 0.65, 0, 1);
        this.pass(this.program("k", `${KERNEL}
            uniform vec3 u_p;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec2 c = u_size * 0.5;
                vec2 d = (g - c) / c.y;
                float t = smoothstep(u_p.x, max(u_p.y, u_p.x + 1e-3), length(d));
                gl_FragColor = vec4(readAt(g).rgb * (1.0 - t * u_p.z), 1.0);
            }`), (p) => p.f("u_p", inner, outer, strength), false);
    }
}

/** fx_shockwave: up to four rings from the centre on hits, displacing the picture. */
export class MscopesShockwave extends MscopesEffect {
    public static componentName = "MscopesShockwave";
    private radii: number[];

    protected setup() {
        this.radii = [-1, -1, -1, -1];
    }

    protected render(audio: MscopesAudioFrame) {
        const dt = this.stepTime();
        // The bass gate filters the plain beat; a detected drum needs no gate.
        const drum = audio.hasFeatures && Math.trunc(this.param("trigger", 0, 0, 3)) !== 0;
        if (this.onBeat(audio) && (drum || audio.bass >= this.param("bassGate", 0.3, 0, 1))) {
            const free = this.radii.findIndex((radius) => radius < 0);
            this.radii[free >= 0 ? free : 0] = 0.01;
        }
        const speed = this.param("speed", 1.4, 0.3, 4);
        let any = false;
        for (let i = 0; i < 4; i++) {
            if (this.radii[i] < 0) {
                continue;
            }
            this.radii[i] += speed * dt;
            if (this.radii[i] > 2.6) {
                this.radii[i] = -1;
            } else {
                any = true;
            }
        }
        if (!any) {
            return;
        }
        const width = this.param("width", 0.08, 0.02, 0.3);
        const strength = this.param("strength", 0.05, 0, 0.2);
        this.pass(this.program("k", `${KERNEL}
            uniform vec4 u_radii;
            uniform vec2 u_p;
            float radius(int i) { return i == 0 ? u_radii.x : i == 1 ? u_radii.y : i == 2 ? u_radii.z : u_radii.w; }
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec2 c = u_size * 0.5;
                vec2 d = (g - c) / (u_size.y * 0.5);
                float dist = length(d);
                vec2 dir = dist > 1e-4 ? d / dist : vec2(0.0);
                float disp = 0.0, glow = 0.0;
                for (int i = 0; i < 4; i++) {
                    float r = radius(i);
                    if (r < 0.0) continue;
                    float x = (dist - r) / max(u_p.x, 1e-3);
                    float band = exp(-x * x);
                    disp += band * u_p.y * (dist - r < 0.0 ? -1.0 : 1.0);
                    glow += band;
                }
                vec2 uv = ((d - dir * disp) * (u_size.y * 0.5) + c) / u_size;
                vec3 col = sampleUv(uv).rgb * (1.0 + glow * 0.25);
                gl_FragColor = vec4(clamp(col, 0.0, 4.0), 1.0);
            }`), (p) => p.f("u_radii", this.radii[0], this.radii[1], this.radii[2], this.radii[3]).f("u_p", width, strength));
    }
}

/** fx_glitch: beat-gated band shifts, RGB tears and posterize flashes. */
export class MscopesGlitch extends MscopesEffect {
    public static componentName = "MscopesGlitch";
    private energy: number;
    private seed: number;

    protected setup() {
        this.energy = 0;
        this.seed = 1;
    }

    protected render(audio: MscopesAudioFrame) {
        const dt = this.stepTime();
        if (this.onBeat(audio)) {
            this.energy = 1;
        }
        this.energy *= Math.exp(-this.param("decay", 4, 0.5, 12) * dt);
        const amount = Math.min(1, Math.max(0, this.energy * this.param("intensity", 0.7, 0, 1) + this.param("constant", 0, 0, 1)));
        if (amount < 0.02) {
            return;
        }
        // std::fmod keeps the sign of the dividend; both are positive here.
        this.seed = (this.seed + 7.31 + this.host.time * 13.7) % 977;
        const block = this.param("blockSize", 18, 4, 64);
        const tear = this.param("tear", 6, 0, 24);
        this.pass(this.program("k", `${KERNEL}
            uniform vec4 u_p;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                float amount = u_p.x, seed = u_p.y;
                float band = floor(g.y / max(u_p.z, 2.0));
                float active = shHash(band, seed) < amount * 0.6 ? 1.0 : 0.0;
                float shift = (shHash(band + 17.0, seed) - 0.5) * 2.0 * amount * 0.25 * active;
                float tear = u_p.w * amount * active / u_size.x;
                vec2 uv = (g + 0.5) / u_size;
                uv.x = fract(uv.x + shift);
                float r = sampleUv(vec2(fract(uv.x + tear), uv.y)).r;
                float gg = sampleUv(uv).g;
                float b = sampleUv(vec2(fract(uv.x - tear), uv.y)).b;
                vec3 col = vec3(r, gg, b);
                if (active > 0.5 && shHash(band + 41.0, seed) < amount * 0.4) col = floor(col * 6.0) / 6.0;
                gl_FragColor = vec4(col, 1.0);
            }`), (p) => p.f("u_p", amount, this.seed, block, tear));
    }
}

/** fx_lens: fisheye (or pincushion below zero), breathing with the bass. */
export class MscopesLens extends MscopesEffect {
    public static componentName = "MscopesLens";

    protected render(audio: MscopesAudioFrame) {
        const strength = this.param("strength", 0.35, -1, 1);
        const s = strength + this.param("bassBoost", 0.4, 0, 2) * audio.bass * (strength >= 0 ? 1 : -1);
        if (Math.abs(s) < 0.01) {
            return;
        }
        this.pass(this.program("k", `${KERNEL}
            uniform float u_strength;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec2 c = u_size * 0.5;
                vec2 d = (g - c) / (u_size.y * 0.5);
                float r = length(d);
                float k = 1.0 + u_strength * r * r;
                vec2 uv = ((d / k) * (u_size.y * 0.5) + c) / u_size;
                gl_FragColor = vec4(sampleUv(uv).rgb, 1.0);
            }`), (p) => p.f("u_strength", s));
    }
}

/** fx_radialblur: zoom blur towards the centre, pumped by the beat. */
export class MscopesRadialBlur extends MscopesEffect {
    public static componentName = "MscopesRadialBlur";
    private pump: number;

    protected setup() {
        this.pump = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        const dt = this.stepTime();
        if (this.onBeat(audio)) {
            this.pump = this.param("beatPump", 0.5, 0, 1);
        }
        this.pump *= Math.pow(0.03, dt);
        const amount = Math.min(1, Math.max(0, this.param("amount", 0.25, 0, 1) + this.pump));
        if (amount < 0.02) {
            return;
        }
        const taps = Math.min(32, Math.max(4, Math.trunc(this.param("quality", 16, 4, 32))));
        this.pass(this.program("k", `${KERNEL}
            uniform vec2 u_p;
            void main() {
                vec2 uv = gl_FragCoord.xy / u_size;
                vec3 acc = vec3(0.0);
                for (int i = 0; i < 32; i++) {
                    if (float(i) >= u_p.y) break;
                    float t = u_p.x * 0.35 * float(i) / u_p.y;
                    acc += sampleUv(mix(uv, vec2(0.5), t)).rgb;
                }
                gl_FragColor = vec4(acc / u_p.y, 1.0);
            }`), (p) => p.f("u_p", amount, taps));
    }
}

/** fx_edges: Sobel edges in tinted neon, over a share of the picture. */
export class MscopesNeonEdges extends MscopesEffect {
    public static componentName = "MscopesNeonEdges";

    protected render() {
        const glow = this.param("glow", 2.5, 0, 8);
        const keep = this.param("keepSource", 0.25, 0, 1);
        const tint = [this.param("tintR", 0.3, 0, 1), this.param("tintG", 1, 0, 1), this.param("tintB", 0.9, 0, 1)];
        this.pass(this.program("k", `${KERNEL}
            uniform vec2 u_p;
            uniform vec3 u_tint;
            float lum(vec2 q) {
                q = clamp(q, vec2(0.0), u_size - 1.0);
                return luma601(readAt(q).rgb);
            }
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                float x = g.x, y = g.y;
                float gx = lum(vec2(x+1.0,y-1.0)) + 2.0*lum(vec2(x+1.0,y)) + lum(vec2(x+1.0,y+1.0))
                         - lum(vec2(x-1.0,y-1.0)) - 2.0*lum(vec2(x-1.0,y)) - lum(vec2(x-1.0,y+1.0));
                float gy = lum(vec2(x-1.0,y+1.0)) + 2.0*lum(vec2(x,y+1.0)) + lum(vec2(x+1.0,y+1.0))
                         - lum(vec2(x-1.0,y-1.0)) - 2.0*lum(vec2(x,y-1.0)) - lum(vec2(x+1.0,y-1.0));
                float e = clamp(sqrt(gx*gx + gy*gy) * u_p.x, 0.0, 1.0);
                vec3 base = readAt(g).rgb * u_p.y;
                gl_FragColor = vec4(1.0 - exp(-(base + u_tint * e)), 1.0);
            }`), (p) => p.f("u_p", glow, keep).f("u_tint", tint[0], tint[1], tint[2]), false);
    }
}

/** fx_duotone: luminance graded from a shadow colour to a highlight colour. */
export class MscopesDuotone extends MscopesEffect {
    public static componentName = "MscopesDuotone";

    protected render() {
        const shadow = [this.param("shadowR", 0.05, 0, 1), this.param("shadowG", 0.03, 0, 1), this.param("shadowB", 0.25, 0, 1)];
        const high = [this.param("highR", 1, 0, 1), this.param("highG", 0.45, 0, 1), this.param("highB", 0.25, 0, 1)];
        const amount = this.param("mix", 0.85, 0, 1);
        this.pass(this.program("k", `${KERNEL}
            uniform vec3 u_shadow;
            uniform vec3 u_high;
            uniform float u_mix;
            void main() {
                vec3 c = readAt(floor(gl_FragCoord.xy)).rgb;
                vec3 duo = mix(u_shadow, u_high, smoothstep(0.0, 1.0, luma601(c)));
                gl_FragColor = vec4(mix(c, duo, u_mix), 1.0);
            }`), (p) => p.f("u_shadow", shadow[0], shadow[1], shadow[2]).f("u_high", high[0], high[1], high[2]).f("u_mix", amount), false);
    }
}

/** fx_shimmer: heat shimmer, a drifting value-noise displacement; the bass ripples it. */
export class MscopesShimmer extends MscopesEffect {
    public static componentName = "MscopesShimmer";
    private t: number;

    protected setup() {
        this.t = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        const dt = this.stepTime();
        this.t += this.param("speed", 0.8, 0, 4) * dt;
        const amount = this.param("amount", 3, 0, 16) + this.param("bassBoost", 1.5, 0, 8) * audio.bass;
        if (amount < 0.05) {
            return;
        }
        const scale = this.param("scale", 9, 2, 40);
        this.pass(this.program("k", `${KERNEL}
            uniform vec3 u_p;
            void main() {
                vec2 uv = gl_FragCoord.xy / u_size;
                float sx = uv.x * u_p.y, sy = uv.y * u_p.y * (u_size.y / u_size.x);
                float nx = shNoise(sx + u_p.z, sy) - 0.5;
                float ny = shNoise(sx + 37.7, sy + u_p.z * 1.31) - 0.5;
                vec2 off = vec2(nx, ny) * 2.0 * u_p.x / u_size;
                gl_FragColor = vec4(sampleUv(uv + off).rgb, 1.0);
            }`), (p) => p.f("u_p", amount, scale, this.t));
    }
}

/** fx_crt: barrel curvature, scanlines, a phosphor triad mask and dark corners. */
export class MscopesCRT extends MscopesEffect {
    public static componentName = "MscopesCRT";

    protected render() {
        const curvature = this.param("curvature", 0.12, 0, 0.4);
        const scanlines = this.param("scanlines", 0.35, 0, 0.8);
        const mask = this.param("mask", 0.25, 0, 0.8);
        const corner = this.param("corner", 0.5, 0, 1);
        this.pass(this.program("k", `${KERNEL}
            uniform vec4 u_p;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec2 uv = (g + 0.5) / u_size * 2.0 - 1.0;
                float r2 = dot(uv, uv);
                vec2 cuv = uv * (1.0 + u_p.x * r2);
                vec2 suv = (cuv + 1.0) * 0.5;
                vec3 col = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) ? vec3(0.0) : sampleUv(suv).rgb;
                float scan = 1.0 - u_p.y * (0.5 + 0.5 * sin(suv.y * u_size.y * 3.14159));
                float m = mod(g.x, 3.0);
                vec3 triad = vec3(m < 0.5 ? 1.0 : 1.0 - u_p.z, (m > 0.5 && m < 1.5) ? 1.0 : 1.0 - u_p.z, m > 1.5 ? 1.0 : 1.0 - u_p.z);
                float c = 1.0 - u_p.w * smoothstep(0.6, 1.6, r2);
                gl_FragColor = vec4(col * scan * triad * c, 1.0);
            }`), (p) => p.f("u_p", curvature, scanlines, mask, corner));
    }
}

/**
 * Trails (ModernEffects.cpp, fx_trails): the previous frame's final picture against
 * this one — 0 crossfade, 1 phosphor (max), 2 fade (the frame becomes the previous
 * one times the persistence). A hit can lower the persistence for a moment.
 */
export class MscopesTrails extends MscopesEffect {
    public static componentName = "MscopesTrails";
    private flash: number;

    protected setup() {
        this.flash = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        const previous = this.previousFrame();
        const mode = Math.min(2, Math.max(0, Math.round(this.param("mode", 1, 0, 2))));
        if (this.onBeat(audio)) {
            this.flash = this.param("beatFlash", 0, 0, 1);
        }
        this.flash *= Math.pow(0.05, this.host.dt);
        const persistence = Math.min(0.98, Math.max(0, this.param("persistence", 0.85, 0, 0.98) - this.flash));
        if (persistence <= 0 && mode !== 2) {
            return;
        }
        this.pass(this.program("k", `${KERNEL}
            uniform sampler2D u_prev;
            uniform vec2 u_p;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec3 c = readAt(g).rgb;
                vec3 q = texture2D(u_prev, (g + 0.5) / u_size).rgb * u_p.x;
                if (u_p.y > 1.5) gl_FragColor = vec4(q, 1.0);
                else if (u_p.y > 0.5) gl_FragColor = vec4(max(c, q), 1.0);
                else gl_FragColor = vec4(c * (1.0 - u_p.x) + q, 1.0);
            }`), (p) => p.texture("u_prev", previous).f("u_p", persistence, mode), false);
    }
}

/**
 * Feedback Warp (BuiltinEffects.cpp, fx_warp mode 10): the previous frame resampled
 * through a zoom and a turn about the centre and faded — the tunnel. The bass zooms,
 * the treble turns, a hit kicks the zoom. Kept in full precision, as in mscopes.
 */
export class MscopesFeedbackWarp extends MscopesEffect {
    public static componentName = "MscopesFeedbackWarp";

    protected render(audio: MscopesAudioFrame) {
        const previous = this.previousFrame();
        let zoom = this.param("zoom", 1.015, 0.9, 1.1) + this.param("zoomBass", 0.06, 0, 0.15) * audio.bass;
        const angle = this.param("spin", 0.01, -0.08, 0.08) + this.param("spinTreble", 0.02, 0, 0.08) * audio.treble;
        if (this.onBeat(audio)) {
            zoom += this.param("beatKick", 0.03, 0, 0.1);
        }
        const inverse = 1 / zoom;
        const ca = Math.cos(-angle) * inverse;
        const sa = Math.sin(-angle) * inverse;
        const decay = this.param("decay", 0.955, 0.75, 1);
        this.pass(this.program("k", `${KERNEL}
            uniform sampler2D u_prev;
            uniform vec3 u_p;
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec2 centre = (u_size - 1.0) * 0.5;
                vec2 d = g - centre;
                vec2 s = centre + vec2(d.x * u_p.x - d.y * u_p.y, d.x * u_p.y + d.y * u_p.x);
                vec2 uv = clamp((s + 0.5) / u_size, 0.5 / u_size, 1.0 - 0.5 / u_size);
                gl_FragColor = vec4(texture2D(u_prev, uv).rgb * u_p.z, 1.0);
            }`), (p) => p.texture("u_prev", previous, true).f("u_p", ca, sa, decay), false);
    }
}

/**
 * Blur (BuiltinEffects.cpp, fx_boxblur): a separable box blur of integer radius,
 * mixed with the sharp frame; 8-bit truncation after each pass, as mscopes' GPU path.
 */
export class MscopesBlur extends MscopesEffect {
    public static componentName = "MscopesBlur";

    protected render() {
        const radius = Math.min(64, Math.trunc(this.param("radius", 1, 0, 4)));
        if (radius <= 0) {
            return;
        }
        const amount = this.param("mix", 1, 0, 1);
        const program = this.program("k", `${KERNEL}
            uniform sampler2D u_orig;
            uniform vec4 u_p;
            ${Q8}
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec3 acc = vec3(0.0);
                for (int k = -64; k <= 64; k++) {
                    if (abs(float(k)) > u_p.x) continue;
                    vec2 q = clamp(g + u_p.yz * float(k), vec2(0.0), u_size - 1.0);
                    acc += readAt(q).rgb;
                }
                acc /= 2.0 * u_p.x + 1.0;
                vec3 o = texture2D(u_orig, (g + 0.5) / u_size).rgb;
                gl_FragColor = vec4(q8(o + (acc - o) * u_p.w), 1.0);
            }`);
        // Pass one: across (mixed fully) into a texture of its own; pass two: down,
        // mixed against the sharp frame.
        const sharp = this.frameTexture();
        const across = this.scratch("across");
        this.run(across, program, (p) => p.texture("u_src", sharp).texture("u_orig", sharp).f("u_p", radius, 1, 0, 1));
        this.pass(program, (p) => p.texture("u_orig", sharp).f("u_p", radius, 0, 1, amount), false, across.texture);
    }
}

/** The four palettes of mscopes' Color Map (stops → 256-entry tables). */
const PALETTES = [
    // fire: black → red → orange → yellow → white
    [[0, 0, 0, 0], [0.35, 0.8, 0.05, 0], [0.6, 1, 0.5, 0], [0.85, 1, 0.9, 0.2], [1, 1, 1, 1]],
    // ocean: black → deep blue → cyan → white
    [[0, 0, 0, 0], [0.4, 0, 0.15, 0.55], [0.75, 0, 0.8, 0.9], [1, 1, 1, 1]],
    // toxic: black → green → yellow-green → white
    [[0, 0, 0, 0], [0.45, 0.1, 0.65, 0.1], [0.8, 0.7, 0.95, 0.1], [1, 1, 1, 1]],
    // purple haze: black → violet → magenta → white
    [[0, 0, 0, 0], [0.4, 0.4, 0, 0.7], [0.75, 0.95, 0.2, 0.8], [1, 1, 1, 1]],
].map((stops) => {
    // q8 of the table, as the kernel truncates what it looks up.
    const table = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let s = 0;
        while (s + 1 < stops.length && stops[s + 1][0] < t) {
            s++;
        }
        const a = stops[s];
        const b = stops[Math.min(s + 1, stops.length - 1)];
        const f = Math.min(1, Math.max(0, (t - a[0]) / Math.max(1e-6, b[0] - a[0])));
        for (let c = 0; c < 3; c++) {
            const value = Math.fround(a[c + 1] + (b[c + 1] - a[c + 1]) * f);
            table[i * 4 + c] = Math.floor(Math.min(1, Math.max(0, value)) * 255);
        }
        table[i * 4 + 3] = 255;
    }
    return table;
});

/**
 * Color Map (BuiltinEffects.cpp, fx_colorop 9): every pixel replaced by a gradient
 * palette looked up by its luma; a hit can move on to the next palette.
 */
export class MscopesColorMap extends MscopesEffect {
    public static componentName = "MscopesColorMap";
    private palette: number;
    private lookup: DataTexture;
    private shown: number;

    protected setup() {
        this.palette = this.param("palette", 0, 0, 3);
        this.lookup = new DataTexture(this.gl, 256, 1, this.gl.UNSIGNED_BYTE);
        this.shown = -1;
    }

    protected teardown() {
        if (this.lookup) {
            this.lookup.destroy();
        }
    }

    protected render(audio: MscopesAudioFrame) {
        if (this.param("cycleOnBeat", 1, 0, 1) > 0.5 && this.onBeat(audio)) {
            this.palette = (Math.trunc(this.palette) + 1) % PALETTES.length;
        }
        const index = Math.trunc(this.palette) % PALETTES.length;
        if (index !== this.shown) {
            this.lookup.update(PALETTES[index]);
            this.shown = index;
        }
        this.pass(this.program("k", `${KERNEL}
            uniform sampler2D u_lut;
            void main() {
                vec3 c = readAt(floor(gl_FragCoord.xy)).rgb;
                float idx = floor(clamp(luma601(c), 0.0, 1.0) * 255.0);
                gl_FragColor = vec4(texture2D(u_lut, vec2((idx + 0.5) / 256.0, 0.5)).rgb, 1.0);
            }`), (p) => p.texture("u_lut", this.lookup.texture), false);
    }
}

/**
 * Grain (TransGeo.cpp, mscopes' take on AVS Grain): a share of the lit pixels gets
 * its own colour times a random level, blended (replace, additive or 50/50 — where
 * nothing was drawn, 50/50 halves the pixel). Random every frame, or one fixed field.
 */
export class MscopesGrain extends MscopesEffect {
    public static componentName = "MscopesGrain";
    private frameSeed: number;

    protected setup() {
        this.frameSeed = 0;
    }

    protected render(audio: MscopesAudioFrame) {
        let amount = this.param("amount", 0.5, 0, 1);
        if (audio.beat) {
            amount = Math.min(1, amount + this.param("onBeatBoost", 0, 0, 1));
        }
        const fixed = this.param("static", 0, 0, 1) > 0.5;
        this.frameSeed = fixed ? 0 : (this.frameSeed + 1) % 4096;
        const blend = Math.trunc(this.param("blend", 2, 0, 2));
        this.pass(this.program("k", `${KERNEL}
            uniform vec3 u_p;
            float rnd(vec2 g, float k) {
                vec3 p = fract(vec3(g.xyx + vec3(k * 17.31, k * 9.17, k * 3.71) + u_p.z * 0.6180339) * 0.1031);
                p += dot(p, p.yzx + 33.33);
                return fract((p.x + p.y) * p.z);
            }
            void main() {
                vec2 g = floor(gl_FragCoord.xy);
                vec3 p = readAt(g).rgb;
                if (p.r <= 0.0 && p.g <= 0.0 && p.b <= 0.0) { gl_FragColor = vec4(p, 1.0); return; }
                float thresh = rnd(g, 1.0), noise = rnd(g, 2.0);
                vec3 c = thresh < u_p.x ? min(vec3(1.0), p * noise) : vec3(0.0);
                vec3 o = u_p.y > 1.5 ? (p + c) * 0.5 : u_p.y > 0.5 ? min(vec3(1.0), p + c) : c;
                gl_FragColor = vec4(o, 1.0);
            }`), (p) => p.f("u_p", amount, blend, this.frameSeed), false);
    }
}
