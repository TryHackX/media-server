// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Pieces the ports of AVS's own effects share.
 *
 * - A frame a component keeps between frames (Water's previous frame, Video
 *   Delay's queue) lives in the shared temporary texture set under a name lent
 *   from a pool: textures there are never removed (see misc/BufferSave.ts), so
 *   names are reused instead of a new texture for every preset that is loaded.
 * - AVS blends by name; these effects do it in their own shader.
 * - Grain and Scatter roll new dice every frame, as AVS's rand() did.
 */
import { BlendMode, avsBlend } from "./utils";

const pools = new WeakMap();

export interface IKeptFrame {
    texture(): WebGLTexture;
    store(source: WebGLTexture): void;
    clear(): void;
    release(): void;
}

export function keepFrame(main): IKeptFrame {
    let pool = pools.get(main);
    if (!pool) {
        pool = { free: [], count: 0 };
        pools.set(main, pool);
    }
    const name = pool.free.pop() || `__avs_kept_${pool.count++}`;
    const ensure = () => {
        const tsm = main.getTempTSM();
        try {
            tsm.getTexture(name);
        } catch (missing) {
            tsm.addTexture(name);
        }
        return tsm;
    };
    ensure();
    let released = false;
    return {
        texture: () => ensure().getTexture(name),
        store(source) {
            const tsm = ensure();
            tsm.setAsRenderTarget(name);
            main.getCopier().run(null, { srcTexture: source });
            tsm.unsetAsRenderTarget();
        },
        clear() {
            // Black, as AVS's freshly allocated frames are.
            const tsm = ensure();
            const gl = main.getRctx().getGl();
            tsm.setAsRenderTarget(name);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            tsm.unsetAsRenderTarget();
        },
        release() {
            if (!released) {
                released = true;
                pool.free.push(name);
            }
        },
    };
}

/** "REPLACE", "ADDITIVE" or "AVERAGE" for an AVS blend name. */
export function simpleBlend(name): string {
    const mode = BlendMode[avsBlend(name)];
    if (mode === BlendMode.ADDITIVE) {
        return "ADDITIVE";
    }
    if (mode === BlendMode.AVERAGE) {
        return "AVERAGE";
    }
    return "REPLACE";
}

/** GLSL: `vec3 blendAvs(vec3 base, vec3 effect)` for one blend mode. */
export function blendGlsl(mode: string): string {
    // AVS's 50/50 halves each side and rounds down: (a >> 1) + (b >> 1).
    const expression = mode === "ADDITIVE"
        ? "min(base + effect, vec3(1.0))"
        : mode === "AVERAGE"
            ? "(floor(floor(base * 255.0 + 0.5) * 0.5) + floor(floor(effect * 255.0 + 0.5) * 0.5)) / 255.0"
            : "effect";
    return `vec3 blendAvs(vec3 base, vec3 effect) { return ${expression}; }`;
}

/** GLSL: high precision where there is any, and `float avsRandom(vec2 seed)` in 0…1. */
export const RANDOM_GLSL = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#endif
float avsRandom(vec2 seed) {
    vec3 p = fract(vec3(seed.xyx) * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}`;

/**
 * The arithmetic of AVS's bilinear read, BLEND4 / BLEND4_16 in Nullsoft's
 * r_defs.h (the MMX code every Winamp build ran): per channel, each row is
 * mixed by the 8-bit fraction x and shifted right by 8, then the two rows by y:
 *   top = (a·(255 − x) + b·x) >> 8,  bottom = (c·(255 − x) + d·x) >> 8,
 *   result = (top·(255 − y) + bottom·y) >> 8.
 * The weights add up to 255, not 256, and both shifts round down: every pass
 * loses a level or two, even standing still — the fade feedback presets are
 * tuned to (without it a preset that is dark in AVS piles up to white).
 * (grandchild/vis_avs's SSE rewrite loses less; its reference renderer was
 * patched to this for the comparisons.)
 */
const BLEND4_BODY = `
        vec3 top = floor((a * (255.0 - x) + b * x) / 256.0);
        vec3 bottom = floor((c * (255.0 - x) + d * x) / 256.0);
        return floor((top * (255.0 - y) + bottom * y) / 256.0);`;

/**
 * GLSL: `vec3 avsBlend4(vec3 a, vec3 b, vec3 c, vec3 d, float x, float y)` on
 * 0…255 levels: a, b the pixel and its right neighbour, c, d the row below;
 * x, y the 8-bit fractions. Needs high precision.
 */
export function avsBlend4Glsl(): string {
    return `
    vec3 avsBlend4(vec3 a, vec3 b, vec3 c, vec3 d, float x, float y) {${BLEND4_BODY}
    }`;
}

/**
 * GLSL: `vec3 name(vec2 pixel)`, AVS's bilinear read at a position in AVS's
 * pixels (pixel i spans i…i+1, y downwards), the fraction's top 8 bits as the
 * weights (BLEND4_16). Needs `u_resolution`, a sampler and high precision.
 */
export function avsBilinearGlsl(name: string, sampler: string): string {
    return `
    vec3 ${name}_blend4(vec3 a, vec3 b, vec3 c, vec3 d, float x, float y) {${BLEND4_BODY}
    }
    vec3 ${name}(vec2 pixel) {
        pixel = clamp(pixel, vec2(0.0), u_resolution - 2.0 + 255.0 / 256.0);
        vec2 base = floor(pixel);
        vec2 lerp = floor((pixel - base) * 256.0);
        vec2 t = 1.0 / u_resolution;
        vec2 at = vec2((base.x + 0.5) * t.x, 1.0 - (base.y + 0.5) * t.y);
        vec3 c1 = floor(texture2D(${sampler}, at).rgb * 255.0 + 0.5);
        vec3 c2 = floor(texture2D(${sampler}, at + vec2(t.x, 0.0)).rgb * 255.0 + 0.5);
        vec3 c3 = floor(texture2D(${sampler}, at - vec2(0.0, t.y)).rgb * 255.0 + 0.5);
        vec3 c4 = floor(texture2D(${sampler}, at + vec2(t.x, -t.y)).rgb * 255.0 + 0.5);
        return ${name}_blend4(c1, c2, c3, c4, lerp.x, lerp.y) / 255.0;
    }`;
}

/**
 * GLSL for AVS's blend of two pictures, integer for integer: `blendTwo(dest,
 * src)` returns what AVS writes into dest (Buffer Save, both ways; r_stack.cpp
 * and blend.cpp). Uses gl_FragCoord for the line and pixel patterns.
 * Adjustable is the MMX blend Winamp's AVS 2.81 ran (mmx_adjblend_block, BLEND_ADJ in r_defs.h:
 * (s·v + d·(255 − v)) >> 8, a level short at white); `adjustTable` asks for the C table
 * (g_blendtable: s·v/255 + d·(255 − v)/255, each rounded down) that APEs kept.
 */
export function blendTwoGlsl(mode: string, adjustTable = false): string {
    const body = {
        AVERAGE: "floor(d * 0.5) + floor(s * 0.5)",
        ADDITIVE: "min(d + s, vec3(255.0))",
        MAXIMUM: "max(d, s)",
        MINIMUM: "min(d, s)",
        SUB_DEST_SRC: "max(d - s, vec3(0.0))",
        SUB_SRC_DEST: "max(s - d, vec3(0.0))",
        MULTIPLY: "floor(d * s / 255.0)",
        ADJUSTABLE: adjustTable
            ? "floor(s * u_value / 255.0) + floor(d * (255.0 - u_value) / 255.0)"
            : "floor((s * u_value + d * (255.0 - u_value)) / 256.0)",
        // AVS copies h/2 even lines and w/2 pixels a row (r_list.cpp, r_stack.cpp): with an odd
        // height or width the last line or column keeps dest.
        EVERY_OTHER_LINE: "mod(row, 2.0) < 0.5 && row < 2.0 * floor(u_height * 0.5) ? s : d",
        EVERY_OTHER_PIXEL: "mod(column + row, 2.0) < 0.5 && column < mod(row, 2.0) + 2.0 * floor(u_resolution.x * 0.5) ? s : d",
        XOR: "xorBits(d, s)",
    }[mode] || "s";
    return `
    vec3 xorBits(vec3 x, vec3 y) {
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
    vec3 blendTwo(vec3 destColor, vec3 srcColor) {
        vec3 d = floor(destColor * 255.0 + 0.5);
        vec3 s = floor(srcColor * 255.0 + 0.5);
        float column = floor(gl_FragCoord.x);
        float row = floor(u_height - gl_FragCoord.y);
        return (${body}) / 255.0;
    }`;
}

/** Buffer Save's blend mode names as webvsc writes them, to blendTwoGlsl's. */
export function bufferBlendName(name): string {
    const mode = String(name || "REPLACE").toUpperCase();
    return mode === "FIFTY_FIFTY" ? "AVERAGE" : mode;
}

/** GLSL: high precision where the GPU has it (AVS's integer emulation needs 16+ bits). */
export const HIGH_PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#endif`;

/** A 256×1 lookup texture (Color Modifier's per-channel table). */
export class LookupTexture {
    private gl: WebGLRenderingContext;
    private handle: WebGLTexture;

    constructor(gl: WebGLRenderingContext) {
        this.gl = gl;
        this.handle = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.handle);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    public texture(): WebGLTexture {
        return this.handle;
    }

    public update(data: Uint8Array) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.handle);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    public destroy() {
        this.gl.deleteTexture(this.handle);
    }
}
