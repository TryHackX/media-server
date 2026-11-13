// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * mscopes' multi-pass glows (GpuFx.mm gpu::bloom, gpu::streaks).
 *
 * Bloom: the glow pyramid of mscopes' picture pass — a luminance-threshold prefilter
 * into half size (pic_prefilter), box downsamples to a depth set by the radius
 * (pic_down, level i at 1/2^(i+1) size, at most six levels, none under 8 pixels),
 * tent upsample-and-add back up (pic_up), then frame + glow × intensity / depth through
 * the soft roll-off 1 − e^−x (pic_bloom_add). The bass lifts the intensity.
 *
 * Streaks: an anamorphic flare — the bright parts (fx_threshold) blurred sideways three
 * times with a growing sigma (fx_blur), tinted and added with the same roll-off
 * (fx_streak_combine).
 */
import { MscopesAudioFrame } from "./audio";
import MscopesEffect from "./base";
import { GLSL_COMMON, lightType, nearest, PRELUDE } from "./gl";

const BOX5 = `
vec3 box5(vec2 uv, vec2 o) {
    return texture2D(u_src, uv).rgb * 0.5
         + (texture2D(u_src, uv + vec2(-o.x, -o.y)).rgb + texture2D(u_src, uv + vec2(o.x, -o.y)).rgb
          + texture2D(u_src, uv + vec2(-o.x,  o.y)).rgb + texture2D(u_src, uv + vec2(o.x,  o.y)).rgb) * 0.125;
}`;

const PREFILTER = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec2 u_texel;
uniform float u_threshold;
${GLSL_COMMON}
${BOX5}
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec3 c = clamp(box5(uv, u_texel), 0.0, 4.0);
    float lum = luma601(c);
    float k = lum <= u_threshold ? 0.0 : (lum - u_threshold) / max(1.0 - u_threshold, 1e-4);
    gl_FragColor = vec4(c * k, 1.0);
}`;

const DOWN = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec2 u_texel;
${BOX5}
void main() {
    gl_FragColor = vec4(box5(gl_FragCoord.xy / u_size, u_texel), 1.0);
}`;

const UP = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_fine;
uniform vec2 u_size;
uniform vec2 u_texel;
vec3 c(vec2 uv) { return texture2D(u_src, uv).rgb; }
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec2 o = u_texel;
    vec3 s = c(uv) * 4.0
           + (c(uv + vec2(o.x, 0.0)) + c(uv - vec2(o.x, 0.0)) + c(uv + vec2(0.0, o.y)) + c(uv - vec2(0.0, o.y))) * 2.0
           + (c(uv + o) + c(uv - o) + c(uv + vec2(o.x, -o.y)) + c(uv + vec2(-o.x, o.y)));
    gl_FragColor = vec4(texture2D(u_fine, uv).rgb + s * (1.0 / 16.0), 1.0);
}`;

const COMBINE = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_glow;
uniform vec2 u_size;
uniform float u_gain;
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec3 x = max(texture2D(u_src, uv).rgb + texture2D(u_glow, uv).rgb * u_gain, 0.0);
    gl_FragColor = vec4(1.0 - exp(-x), 1.0);
}`;

/** Bloom (GpuEffects.h): threshold, radius in pixels, intensity, bass boost. */
export class MscopesBloom extends MscopesEffect {
    public static componentName = "MscopesBloom";

    protected render(audio: MscopesAudioFrame) {
        const intensity = this.param("intensity", 1.1, 0, 4) * (1 + this.param("bassBoost", 0.6, 0, 3) * audio.bass);
        const W = this.width();
        const H = this.height();
        const sizes = [];
        let w = Math.max(1, Math.floor(W / 2));
        let h = Math.max(1, Math.floor(H / 2));
        while (sizes.length < 6 && Math.min(w, h) >= 8) {
            sizes.push([w, h]);
            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
        }
        if (!sizes.length) {
            return;
        }
        const radius = this.param("radius", 14, 1, 64);
        const levels = Math.min(sizes.length, Math.max(2, Math.round(Math.log2(Math.max(2, radius)))));
        const threshold = Math.min(4, Math.max(0, this.param("threshold", 0.55, 0, 1)));
        const type = lightType(this.gl);
        const down = [];
        for (let i = 0; i < levels; i++) {
            down.push(this.scratch("down" + i, sizes[i][0], sizes[i][1], type));
        }
        const frame = this.frameTexture();
        this.run(down[0], this.program("prefilter", PREFILTER),
            (p) => p.texture("u_src", frame, true).f("u_texel", 1 / W, 1 / H).f("u_threshold", threshold));
        // The list's textures are read nearest everywhere else.
        nearest(this.gl, frame);
        for (let i = 1; i < levels; i++) {
            const previous = down[i - 1];
            this.run(down[i], this.program("down", DOWN),
                (p) => p.texture("u_src", previous.texture, true).f("u_texel", 1 / previous.width, 1 / previous.height));
        }
        let coarse = down[levels - 1];
        for (let i = levels - 2; i >= 0; i--) {
            const up = this.scratch("up" + i, sizes[i][0], sizes[i][1], type);
            const from = coarse;
            this.run(up, this.program("up", UP),
                (p) => p.texture("u_src", from.texture, true).texture("u_fine", down[i].texture).f("u_texel", 1 / from.width, 1 / from.height));
            coarse = up;
        }
        // The pyramid sums one copy of the light per level: 1/levels keeps the total.
        this.pass(this.program("combine", COMBINE),
            (p) => p.texture("u_glow", coarse.texture, true).f("u_gain", intensity / levels), false);
    }
}

const THRESHOLD = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform float u_threshold;
${GLSL_COMMON}
void main() {
    vec3 c = texture2D(u_src, gl_FragCoord.xy / u_size).rgb;
    float lum = luma601(c);
    float k = lum <= u_threshold ? 0.0 : (lum - u_threshold) / max(1.0 - u_threshold, 1e-4);
    gl_FragColor = vec4(c * k, 1.0);
}`;

// fx_blur: a gaussian of `sigma` over ±taps pixels along one direction, edges clamped.
const BLUR = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec4 u_p;
void main() {
    vec2 g = floor(gl_FragCoord.xy);
    float sigma = max(u_p.x, 0.5);
    float taps = clamp(floor(u_p.y), 1.0, 63.0);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int k = -63; k <= 63; k++) {
        float i = float(k);
        if (abs(i) > taps) continue;
        vec2 q = clamp(g + u_p.zw * i, vec2(0.0), u_size - 1.0);
        float w = exp(-0.5 * i * i / (sigma * sigma));
        acc += texture2D(u_src, (q + 0.5) / u_size).rgb * w;
        wsum += w;
    }
    gl_FragColor = vec4(acc / wsum, 1.0);
}`;

const STREAK_COMBINE = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_streak;
uniform vec2 u_size;
uniform vec4 u_p;
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec3 c = texture2D(u_src, uv).rgb + texture2D(u_streak, uv).rgb * u_p.x * u_p.yzw;
    gl_FragColor = vec4(1.0 - exp(-c), 1.0);
}`;

/** Streaks (GpuEffects.h): threshold, length (the last blur's sigma), intensity, tint. */
export class MscopesStreaks extends MscopesEffect {
    public static componentName = "MscopesStreaks";

    protected render() {
        const threshold = this.param("threshold", 0.6, 0, 1);
        const length = this.param("length", 40, 8, 63);
        const intensity = this.param("intensity", 0.9, 0, 3);
        const tint = [this.param("tintR", 0.55, 0, 1), this.param("tintG", 0.7, 0, 1), this.param("tintB", 1, 0, 1)];
        const type = lightType(this.gl);
        const a = this.scratch("a", undefined, undefined, type);
        const b = this.scratch("b", undefined, undefined, type);
        const s1 = Math.max(2, length * 0.15);
        const s2 = Math.max(4, length * 0.4);
        const s3 = Math.max(8, length);
        const frame = this.frameTexture();
        this.run(a, this.program("threshold", THRESHOLD), (p) => p.texture("u_src", frame).f("u_threshold", threshold));
        const blur = this.program("blur", BLUR);
        this.run(b, blur, (p) => p.texture("u_src", a.texture).f("u_p", s1, Math.min(63, s1 * 2), 1, 0));
        this.run(a, blur, (p) => p.texture("u_src", b.texture).f("u_p", s2, Math.min(63, s2 * 2), 1, 0));
        this.run(b, blur, (p) => p.texture("u_src", a.texture).f("u_p", s3, 63, 1, 0));
        this.pass(this.program("combine", STREAK_COMBINE),
            (p) => p.texture("u_streak", b.texture).f("u_p", intensity, tint[0], tint[1], tint[2]), false);
    }
}
