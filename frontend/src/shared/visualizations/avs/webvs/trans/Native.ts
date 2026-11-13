// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Ports of AVS's own colour and pixel effects, after Nullsoft's vis_avs source
 * (BSD licence; r_fadeout.cpp, r_bright.cpp, r_colorfade.cpp, r_grain.cpp,
 * r_scat.cpp, r_water.cpp, r_shift.cpp, r_dcolormod.cpp,
 * r_colorreduction.cpp): the same arithmetic in 0…255 steps, one fragment
 * shader per effect.
 *
 * These are the effects that keep a feedback preset in balance. Without Fadeout
 * working AVS's way (move every channel a fixed step towards a colour each
 * frame) or without Brightness, whatever a preset adds every frame piled up
 * until the picture was white.
 */
import { cRand, grainRand, grainRandState, setGrainRandState, skipGrainRand } from "../avsRandom";
import { cpuFrameRun } from "../cpuFrameRun";
import { GRAIN_ADDITIVE, GRAIN_AVERAGE, GRAIN_REPLACE, GrainDice, grainMoving, grainMovingWasm } from "./grainDice";
import { GrainMask } from "./grainMask";
import Component from "../Component";
import compileExpr from "../expr/compileExpr";
import { parseColorNorm, WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { avsBilinearGlsl, avsBlend4Glsl, blendGlsl, HIGH_PRECISION, IKeptFrame, keepFrame, LookupTexture, RANDOM_GLSL, simpleBlend } from "../avsSupport";
import { DelayRing, newDelayRing, resizeDelayRing, stepDelayRing, trimDelayRing } from "./videoDelayRing";
import { addBorderPixels } from "./addBorders";
import { AVS_BLEND_GLSL, avsLineMode } from "../avsDraw";

const glslFloat = (value: number) => {
    const number = Number.isFinite(value) ? value : 0;
    const text = String(number);
    return /[.e]/.test(text) ? text : `${text}.0`;
};
const glslColor = (hex) => {
    const [r, g, b] = parseColorNorm(hex || "#000000");
    return `vec3(${glslFloat(r)}, ${glslFloat(g)}, ${glslFloat(b)})`;
};

/** A component that is one full-screen fragment shader over the frame. */
class ShaderEffect extends Component {
    protected program: ShaderProgram;

    public init() {
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: { uniforms: this.uniforms() },
            fragmentShader: this.fragment(),
            swapFrame: true,
        });
    }

    public draw() {
        const values = this.values();
        if (values) {
            this.program.run(this.parent.getTSM(), values);
        }
    }

    public destroy() {
        super.destroy();
        if (this.program) {
            this.program.destroy();
        }
    }

    protected uniforms() {
        return {};
    }

    protected fragment(): string {
        return "void main() { setFragColor(getSrcColor()); }";
    }

    /** Uniform values for this frame; null skips the frame. */
    protected values(): any {
        return {};
    }
}

/** Fadeout: every channel moves `speed` steps (of 255) towards the colour. */
export class FadeOut extends ShaderEffect {
    public static componentName: string = "FadeOut";
    public static componentTag: string = "trans";
    protected static defaultOptions = { color: "#000000", speed: 16 };

    protected uniforms() {
        return { step: { name: "u_step", valueType: WebGLVarType._1F } };
    }

    protected fragment() {
        return `
            uniform float u_step;
            void main() {
                vec3 color = getSrcColor().rgb;
                color += clamp(${glslColor(this.opts.color)} - color, -u_step, u_step);
                setFragColor(vec4(color, 1.0));
            }`;
    }

    protected values() {
        // AVS's slider is 0…92 steps. A value below 1 is webvs's own scale.
        const speed = Number(this.opts.speed) || 0;
        const steps = speed > 0 && speed < 1 ? speed * 92 : speed;
        return steps > 0 ? { step: Math.min(255, steps) / 255 } : null;
    }
}

/** Brightness: a factor per channel, AVS's sliders (−4096…4096). */
export class Brightness extends ShaderEffect {
    public static componentName: string = "Brightness";
    public static componentTag: string = "trans";

    protected fragment() {
        const opts = this.opts;
        const factor = (value) => {
            const slider = Math.max(-4096, Math.min(4096, Number(value) || 0));
            return 1 + (slider < 0 ? 1 : 16) * (slider / 4096);
        };
        const red = factor(opts.red);
        // Without "dissociate", the green and blue sliders follow the red one.
        const green = opts.separate === false ? red : factor(opts.green);
        const blue = opts.separate === false ? red : factor(opts.blue);
        const exclude = opts.exclude
            ? `if (all(lessThanEqual(abs(color - ${glslColor(opts.excludeColor)}), vec3(${glslFloat((Number(opts.distance) || 0) / 255 + 0.0001)})))) { setFragColor(vec4(color, 1.0)); return; }`
            : "";
        return `
            ${blendGlsl(simpleBlend(opts.blendMode))}
            void main() {
                vec3 color = getSrcColor().rgb;
                ${exclude}
                // r_bright.cpp's tables: floor(n · m / 65536) for the whole level n, m = 65536 ·
                // (1 + k · slider / 4096), a multiple of 1/4096 the product holds exactly.
                vec3 level = floor(color * 255.0 + 0.5);
                vec3 bright = min(floor(level * vec3(${glslFloat(red)}, ${glslFloat(green)}, ${glslFloat(blue)})) / 255.0, vec3(1.0));
                setFragColor(vec4(blendAvs(color, bright), 1.0));
            }`;
    }
}

/**
 * Colorfade: adds three fader values to a pixel's channels in an order chosen
 * by which channel is strongest; on a beat the faders jump and drift back.
 */
export class Colorfade extends ShaderEffect {
    public static componentName: string = "Colorfade";
    public static componentTag: string = "trans";
    private faders: number[];
    private position: number[];
    private beatFaders: number[];

    public init() {
        super.init();
        const opts = this.opts;
        this.faders = [Number(opts.fader1) || 0, Number(opts.fader2) || 0, Number(opts.fader3) || 0];
        this.beatFaders = [Number(opts.beatFader1) || 0, Number(opts.beatFader2) || 0, Number(opts.beatFader3) || 0];
        this.position = this.faders.slice();
    }

    protected uniforms() {
        return { faders: { name: "u_faders", valueType: WebGLVarType._3FV } };
    }

    protected fragment() {
        return `
            uniform vec3 u_faders;
            void main() {
                vec3 color = getSrcColor().rgb;
                vec3 add;
                if (color.g > color.r && color.g > color.b) {
                    add = u_faders.xyz;
                } else if (color.b > color.r && color.b > color.g) {
                    add = u_faders.zxy;
                } else if (color.r > color.g && color.r > color.b) {
                    add = u_faders.yzx;
                } else {
                    add = vec3(u_faders.z);
                }
                setFragColor(vec4(clamp(color + add, 0.0, 1.0), 1.0));
            }`;
    }

    protected values() {
        const opts = this.opts;
        const position = this.position;
        const faders = this.faders;
        // The drift as in r_colorfade.cpp, second and third fader crossed.
        const targets = [faders[0], faders[2], faders[1]];
        for (let index = 0; index < 3; index++) {
            if (position[index] < targets[index]) {
                position[index]++;
            } else if (position[index] > targets[index]) {
                position[index]--;
            }
        }
        const beat = this.main.getAnalyser().isBeat();
        if (!opts.onBeat) {
            this.position = faders.slice();
        } else if (beat && opts.onBeatRandom) {
            const second = (cRand() % 32) - 6;
            const middle = (cRand() % 64) - 32;
            const third = (cRand() % 32) - 6;
            this.position = [
                second,
                middle < 0 && middle > -16 ? -32 : middle >= 0 && middle < 16 ? 32 : middle,
                third,
            ];
        } else if (beat) {
            this.position = this.beatFaders.slice();
        }
        const [one, two, three] = this.position;
        return { faders: [one / 255, two / 255, three / 255] };
    }
}

/** Color Reduction: keeps the top bits of every channel (2…256 levels). */
export class ColorReduction extends ShaderEffect {
    public static componentName: string = "ColorReduction";
    public static componentTag: string = "trans";

    protected fragment() {
        const colors = Math.max(2, Math.min(256, Number(this.opts.colors) || 256));
        const step = 256 / Math.pow(2, Math.round(Math.log2(colors)));
        return `
            void main() {
                vec3 level = floor(getSrcColor().rgb * 255.0 + 0.5);
                setFragColor(vec4(floor(level / ${glslFloat(step)}) * ${glslFloat(step)} / 255.0, 1.0));
            }`;
    }
}

/**
 * Grain (r_grain.cpp): a lit pixel (any channel above 0) gets, with some chance, itself scaled by
 * s/256 in every channel, rounded down — added, averaged or put in its place. Moving grain takes
 * a byte for the chance (below amount·255/100) and one for s from the plug-in's table of 491
 * random bytes, walked through the lit pixels in their order (grainDice.ts): over a bitmask of the
 * lit pixels that the GPU packs and a shader that applies the bytes (grainMask.ts), or over the
 * frame itself when the processor holds it (a user of the frame run, cpuFrameRun.ts, after a
 * Super Scope or Texer II). Static grain uses a table made once for the frame's
 * size, two numbers per pixel: rand() % 255 for s and rand() % 100 for the chance, so from an
 * amount of 40 on every lit pixel gets its grain; a fragment shader applies it.
 *
 * The walk is exact where the result must be the reference's: on the comparison page (its
 * generator) or with __avsGrainExact = true. AVS 2.81 seeds rand() from the time at every start
 * (main.cpp), so the walk draws another pattern in every session: in the player a fragment shader
 * rolls the same two bytes per pixel, without the read-back the walk needs (5–10 ms a Grain at
 * 1280×720).
 */
export class Grain extends ShaderEffect {
    public static componentName: string = "Grain";
    public static componentTag: string = "trans";
    private table: WebGLTexture | null;
    private tableSize: string;
    private dice: GrainDice;
    private mask: GrainMask | null;
    private exact: boolean;

    public init() {
        this.exact = grainRandState() !== null || (globalThis as any).__avsGrainExact === true;
        // AVS's constructor: a table of 491 random bytes and a position in it.
        this.dice = new GrainDice(grainRand);
        this.table = null;
        this.tableSize = "";
        this.mask = null;
        if (this.opts.static || !this.exact) {
            super.init();
        }
    }

    /** Moving grain is a user of the frame run (cpuFrameRun.ts kind()): it walks a frame the run holds. */
    public get avsCpuFrameUser(): boolean {
        return !this.opts.static && this.exact;
    }

    public draw() {
        const gl = this.main.getRctx().getGl();
        const tsm = this.parent.getTSM();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const size = `${width}x${height}`;
        if (size !== this.tableSize) {
            // reinit(): two numbers per pixel, rows from the top. Moving grain never reads them.
            this.tableSize = size;
            if (this.opts.static) {
                const data = new Uint8Array(width * height * 4);
                for (let y = 0; y < height; y++) {
                    let at = (height - 1 - y) * width * 4;
                    for (let x = 0; x < width; x++, at += 4) {
                        data[at] = grainRand() % 255;
                        data[at + 1] = grainRand() % 100;
                        data[at + 3] = 255;
                    }
                }
                if (!this.table) {
                    this.table = gl.createTexture();
                }
                gl.bindTexture(gl.TEXTURE_2D, this.table);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            } else {
                skipGrainRand(2 * width * height);
            }
        }
        // The table position moves on every frame (rand() % 300); moving grain draws more as it goes.
        this.dice.frame(grainRand);
        if (!this.opts.static && !this.exact) {
            // The player's moving grain: the chance and s rolled per pixel in the shader.
            this.program.run(tsm, { seed: [Math.random() * 512, Math.random() * 512], table: null });
            return;
        }
        if (!this.opts.static) {
            const run = cpuFrameRun(this.main);
            try {
                const amount = Math.max(0, Math.min(100, Math.trunc(Number(this.opts.amount) || 0)));
                const mode = simpleBlend(this.opts.blendMode);
                const blend = mode === "ADDITIVE" ? GRAIN_ADDITIVE : mode === "AVERAGE" ? GRAIN_AVERAGE : GRAIN_REPLACE;
                const limit = Math.floor((amount * 255) / 100);
                // rand() inside WebAssembly: the comparison page's Grain generator (its state handed
                // over and back), otherwise any seed; grainRand itself in JavaScript.
                const state = grainRandState();
                const seed = state === null ? (Math.random() * 4294967296) >>> 0 : state;
                let after: number;
                if (run.holds(tsm, width, height)) {
                    after = grainMovingWasm(run.pixels32, width * height, this.dice, seed, limit, blend);
                    if (after < 0) {
                        grainMoving(run.pixels32, width * height, this.dice, grainRand, limit, blend);
                    }
                    run.changed();
                } else {
                    run.flush();
                    if (!this.mask) {
                        this.mask = new GrainMask(this.main.getRctx(), mode);
                    }
                    after = this.mask.draw(tsm, width, height, this.dice, limit, seed, grainRand);
                }
                if (after >= 0 && state !== null) {
                    setGrainRandState(after);
                }
            } finally {
                run.finish(this.main);
            }
            return;
        }
        this.program.run(tsm, { seed: [0, 0], table: this.table });
    }

    public destroy() {
        super.destroy();
        if (this.table) {
            this.main.getRctx().getGl().deleteTexture(this.table);
            this.table = null;
        }
        if (this.mask) {
            this.mask.destroy();
            this.mask = null;
        }
    }

    protected uniforms() {
        return {
            seed: { name: "u_seed", valueType: WebGLVarType._2FV },
            table: { name: "u_table", valueType: WebGLVarType.TEXTURE2D },
        };
    }

    /** Static grain, and moving grain in the player (the exact walk has no shader). */
    protected fragment() {
        const amount = Math.max(0, Math.min(100, Math.trunc(Number(this.opts.amount) || 0)));
        const limit = Math.floor((amount * 255) / 100);
        return `
            ${RANDOM_GLSL}
            ${blendGlsl(simpleBlend(this.opts.blendMode))}
            uniform vec2 u_seed;
            uniform sampler2D u_table;
            void main() {
                vec3 color = getSrcColor().rgb;
                vec3 level = floor(color * 255.0 + 0.5);
                if (level == vec3(0.0)) {
                    setFragColor(vec4(color, 1.0));
                    return;
                }
                ${this.opts.static ? `
                vec4 entry = texture2D(u_table, (floor(gl_FragCoord.xy) + 0.5) / u_resolution);
                float scale = floor(entry.r * 255.0 + 0.5);
                float roll = floor(entry.g * 255.0 + 0.5);` : `
                vec2 cell = gl_FragCoord.xy + u_seed;
                float roll = floor(avsRandom(cell) * 256.0);
                float scale = floor(avsRandom(cell + 71.37) * 256.0);`}
                vec3 grain = roll < ${glslFloat(limit)} ? floor(level * scale / 256.0) : vec3(0.0);
                setFragColor(vec4(blendAvs(color, grain / 255.0), 1.0));
            }`;
    }
}

/** Scatter: every pixel (but the top and bottom four rows) from up to 3 pixels away. */
export class Scatter extends ShaderEffect {
    public static componentName: string = "Scatter";
    public static componentTag: string = "trans";

    protected uniforms() {
        return {
            seed: { name: "u_seed", valueType: WebGLVarType._2FV },
            scale: { name: "u_scale", valueType: WebGLVarType._1F },
        };
    }

    protected fragment() {
        // Offsets in pixels of AVS's window, scaled to this one.
        return `
            ${RANDOM_GLSL}
            uniform vec2 u_seed;
            uniform float u_scale;
            void main() {
                if (gl_FragCoord.y < 4.0 * u_scale || gl_FragCoord.y > u_resolution.y - 4.0 * u_scale) {
                    setFragColor(getSrcColor());
                    return;
                }
                vec2 roll = floor(vec2(avsRandom(gl_FragCoord.xy + u_seed), avsRandom(gl_FragCoord.yx + u_seed.yx + 13.1)) * 8.0) - 4.0;
                roll += step(roll, vec2(-0.5));
                setFragColor(getSrcColorAtPos(v_position + floor(roll * u_scale + 0.5) / u_resolution));
            }`;
    }

    protected values() {
        return { seed: [Math.random() * 512, Math.random() * 512], scale: this.main.avsScale || 1 };
    }
}

/** Water: ripples — the four neighbours, halved, minus the previous frame. */
export class Water extends ShaderEffect {
    public static componentName: string = "Water";
    public static componentTag: string = "trans";
    private previous;
    private primed: boolean;

    public init() {
        super.init();
        this.previous = keepFrame(this.main);
        this.primed = false;
    }

    public draw() {
        const tsm = this.parent.getTSM();
        const input = tsm.getCurrentTexture();
        // AVS starts from a black previous frame and ripples from the first frame on.
        if (!this.primed) {
            this.previous.clear();
            this.primed = true;
        }
        this.program.run(tsm, { previous: this.previous.texture() });
        this.previous.store(input);
    }

    public destroy() {
        super.destroy();
        if (this.previous) {
            this.previous.release();
        }
    }

    protected uniforms() {
        return { previous: { name: "u_previous", valueType: WebGLVarType.TEXTURE2D } };
    }

    protected fragment() {
        return `
            uniform sampler2D u_previous;
            vec3 level(vec2 pos) {
                return floor(getSrcColorAtPos(pos).rgb * 255.0 + 0.5);
            }
            void main() {
                // AVS (r_water.cpp): the neighbours there are, summed; with three
                // or four the sum is halved (rounded down), with two (a corner)
                // not; minus the previous frame, in whole levels.
                vec2 texel = 1.0 / u_resolution;
                vec2 pixel = floor(v_position * u_resolution);
                vec3 sum = vec3(0.0);
                float count = 0.0;
                if (pixel.x > 0.5) { sum += level(v_position - vec2(texel.x, 0.0)); count += 1.0; }
                if (pixel.x < u_resolution.x - 1.5) { sum += level(v_position + vec2(texel.x, 0.0)); count += 1.0; }
                if (pixel.y > 0.5) { sum += level(v_position - vec2(0.0, texel.y)); count += 1.0; }
                if (pixel.y < u_resolution.y - 1.5) { sum += level(v_position + vec2(0.0, texel.y)); count += 1.0; }
                if (count > 2.5) { sum = floor(sum * 0.5); }
                vec3 result = sum - floor(texture2D(u_previous, v_position).rgb * 255.0 + 0.5);
                setFragColor(vec4(clamp(result, 0.0, 255.0) / 255.0, 1.0));
            }`;
    }
}

/** C's (int) of a double: towards zero, and 0x80000000 where it does not fit (NaN too). */
const cInt = (value: number): number => (Math.abs(value) < 2147483648 ? Math.trunc(value) : -2147483648);

/**
 * Dynamic Shift, as r_shift.cpp: the frame moved by x, y pixels that the code sets each frame.
 * x, y and alpha are 0, 0, 0.5 just before the init code runs — and only if there is init code
 * (with none they stay 0, and with "blend" on alpha 0 draws nothing). Without subpixel the shift
 * is (int)x, (int)y. With it, BLEND4 mixes four pixels by 8-bit fractions, and a whole or
 * positive part shifts one more pixel with the weights turned round: even standing still the
 * picture loses a level or two and gets a black edge on every side, as feedback presets had it.
 * Blend mixes by (int)(alpha·255) as BLEND_ADJ does; at 0 or below nothing is drawn.
 */
export class DynamicShift extends ShaderEffect {
    public static componentName: string = "DynamicShift";
    public static componentTag: string = "trans";
    private code;
    private inited: boolean;
    private size: string;

    public init() {
        super.init();
        const code = compileExpr(this.opts.code || {}, ["init", "perFrame", "onBeat"]).codeInst;
        code.setup(this.main);
        for (const name of ["x", "y", "b", "alpha"]) {
            if (code[name] === undefined) {
                code[name] = 0;
            }
        }
        this.code = code;
        this.inited = false;
        this.size = "";
    }

    protected uniforms() {
        return {
            shift: { name: "u_shift", valueType: WebGLVarType._2FV },
            part: { name: "u_part", valueType: WebGLVarType._2FV },
            alpha: { name: "u_alpha", valueType: WebGLVarType._1F },
        };
    }

    protected fragment() {
        const subpixel = this.opts.bilinear !== false;
        return `
            ${HIGH_PRECISION}
            ${avsBlend4Glsl()}
            uniform vec2 u_shift; // whole pixels, x to the right, y down
            uniform vec2 u_part;  // BLEND4's weights
            uniform float u_alpha; // BLEND_ADJ's v; below 0 no blend
            vec3 level(vec2 avs) {
                vec2 pos = vec2(avs.x + 0.5, u_resolution.y - avs.y - 0.5) / u_resolution;
                return floor(getSrcColorAtPos(pos).rgb * 255.0 + 0.5);
            }
            void main() {
                vec2 frag = floor(gl_FragCoord.xy);
                vec2 at = vec2(frag.x, u_resolution.y - 1.0 - frag.y);
                vec3 moved = vec3(0.0);
                ${subpixel ? `
                vec2 end = clamp(u_resolution - 1.0 + u_shift, vec2(0.0), u_resolution - 1.0);
                if (all(greaterThanEqual(at, max(u_shift, vec2(0.0)))) && all(lessThan(at, end))) {
                    vec2 s = at - u_shift;
                    moved = avsBlend4(level(s), level(s + vec2(1.0, 0.0)), level(s + vec2(0.0, 1.0)),
                        level(s + vec2(1.0, 1.0)), u_part.x, u_part.y);
                }` : `
                vec2 s = at - u_shift;
                if (all(greaterThanEqual(s, vec2(0.0))) && all(lessThan(s, u_resolution))) {
                    moved = level(s);
                }`}
                if (u_alpha >= 0.0) {
                    vec3 here = floor(getSrcColor().rgb * 255.0 + 0.5);
                    moved = floor((moved * u_alpha + here * (255.0 - u_alpha)) / 256.0);
                }
                setFragColor(vec4(moved / 255.0, 1.0));
            }`;
    }

    protected values() {
        const code = this.code;
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const beat = this.main.getAnalyser().isBeat();
        // r_shift.cpp sets w, h and b every frame, before the init code.
        code.w = width;
        code.h = height;
        code.b = beat ? 1 : 0;
        const size = `${width}x${height}`;
        if (code.compiled && code.compiled.init && (!this.inited || size !== this.size)) {
            this.size = size;
            code.x = 0;
            code.y = 0;
            code.alpha = 0.5;
            code.init();
            this.inited = true;
        }
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        let blend = simpleBlend(this.opts.blendMode) === "AVERAGE";
        let alpha = -1;
        if (blend) {
            alpha = cInt(Number(code.alpha) * 255);
            if (alpha <= 0) {
                return null;
            }
            if (alpha >= 255) {
                alpha = -1;
            }
        }
        // Pixels of AVS's window, scaled to this one.
        const scale = this.main.avsScale || 1;
        const vx = Number(code.x) * scale;
        const vy = Number(code.y) * scale;
        let xa = cInt(vx);
        let ya = cInt(vy);
        let xpart = 0;
        let ypart = 0;
        if (this.opts.bilinear !== false) {
            const part = (value: number, whole: number): [number, number] => {
                let fraction = cInt((value - whole) * 255);
                if (fraction < 0) {
                    fraction = fraction === -2147483648 ? fraction : -fraction;
                } else {
                    whole += 1;
                    fraction = 255 - fraction;
                }
                return [whole, Math.max(0, Math.min(255, fraction))];
            };
            [xa, xpart] = part(vx, xa);
            [ya, ypart] = part(vy, ya);
            xa = Math.max(1 - width, Math.min(width - 1, xa));
            ya = Math.max(1 - height, Math.min(height - 1, ya));
        }
        return { shift: [xa, ya], part: [xpart, ypart], alpha };
    }
}

/**
 * Color Modifier: the code maps a level (red = green = blue = 0…1) to new
 * channel values; the 256 results become a lookup table for the frame.
 */
export class ColorModifier extends ShaderEffect {
    public static componentName: string = "ColorModifier";
    public static componentTag: string = "trans";
    private code;
    private inited: boolean;
    private lookup: LookupTexture;
    private table: Uint8Array;
    private valid: boolean;

    public init() {
        super.init();
        const code = compileExpr(this.opts.code || {}, ["init", "perFrame", "onBeat", "perPoint"]).codeInst;
        code.setup(this.main);
        for (const name of ["red", "green", "blue", "beat"]) {
            if (code[name] === undefined) {
                code[name] = 0;
            }
        }
        this.code = code;
        this.inited = false;
        this.lookup = new LookupTexture(this.main.getRctx().getGl());
        this.table = new Uint8Array(256 * 4);
        this.valid = false;
    }

    public destroy() {
        super.destroy();
        if (this.lookup) {
            this.lookup.destroy();
        }
    }

    protected uniforms() {
        return { lookup: { name: "u_lookup", valueType: WebGLVarType.TEXTURE2D } };
    }

    protected fragment() {
        return `
            uniform sampler2D u_lookup;
            float level(float value, int channel) {
                vec4 entry = texture2D(u_lookup, vec2((floor(value * 255.0 + 0.5) + 0.5) / 256.0, 0.5));
                return channel == 0 ? entry.r : channel == 1 ? entry.g : entry.b;
            }
            void main() {
                vec3 color = getSrcColor().rgb;
                setFragColor(vec4(level(color.r, 0), level(color.g, 1), level(color.b, 2), 1.0));
            }`;
    }

    protected values() {
        const code = this.code;
        const beat = this.main.getAnalyser().isBeat();
        code.beat = beat ? 1 : 0;
        if (!this.inited) {
            code.init();
            this.inited = true;
        }
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        if (this.opts.recomputeEveryFrame || !this.valid) {
            const table = this.table;
            const byte = (value) => Math.max(0, Math.min(255, Math.floor(value * 255 + 0.5))) || 0;
            for (let index = 0; index < 256; index++) {
                code.red = code.green = code.blue = index / 255;
                code.perPoint();
                table[index * 4] = byte(code.red);
                table[index * 4 + 1] = byte(code.green);
                table[index * 4 + 2] = byte(code.blue);
                table[index * 4 + 3] = 255;
            }
            this.lookup.update(table);
            this.valid = true;
        }
        return { lookup: this.lookup.texture() };
    }
}

/**
 * Bump: lights the picture as if its brightness were height, from a point the
 * code moves (x, y in 0…1). The depth comes from the frame itself or from a
 * saved buffer. Distances count in pixels of AVS's ~384-line window, so the
 * lit area covers as much of the screen as it did there.
 */
export class Bump extends ShaderEffect {
    public static componentName: string = "Bump";
    public static componentTag: string = "trans";
    private code;
    private inited: boolean;
    private depth: number;
    private beatFrames: number;

    public init() {
        super.init();
        const code = compileExpr(this.opts.code || {}, ["init", "perFrame", "onBeat"]).codeInst;
        code.setup(this.main);
        for (const name of ["x", "y", "isbeat", "islbeat"]) {
            if (code[name] === undefined) {
                code[name] = 0;
            }
        }
        code.bi = 1;
        this.code = code;
        this.inited = false;
        this.depth = Number(this.opts.depth) || 0;
        this.beatFrames = 0;
    }

    protected uniforms() {
        return {
            light: { name: "u_light", valueType: WebGLVarType._2FV },
            depth: { name: "u_depth", valueType: WebGLVarType._1F },
            scale: { name: "u_scale", valueType: WebGLVarType._1F },
            depthSource: { name: "u_depthSource", valueType: WebGLVarType.TEXTURE2D },
        };
    }

    /**
     * r_bump.cpp: fbout starts black and only rows 1…h−2, columns 1…w−2 are lit, so the frame
     * keeps a black border one AVS pixel wide. Each pixel compares its neighbours' depth (the
     * brightest channel) with its distance in whole pixels from the light; where the depth is
     * the frame itself, a pixel whose four neighbours are all black stays black. The light dot
     * ("show light") survives only where nothing is drawn over it.
     */
    protected fragment() {
        const invert = Boolean(this.opts.invertDepth);
        const ownFrame = !this.opts.depthSource;
        const showLight = Boolean(this.opts.showDot);
        return `
            uniform vec2 u_light;
            uniform float u_depth;
            uniform float u_scale;
            uniform sampler2D u_depthSource;
            ${blendGlsl(simpleBlend(this.opts.blendMode))}
            vec3 sampleDepth(vec2 pos) {
                return texture2D(u_depthSource, clamp(pos, 0.0, 1.0)).rgb;
            }
            float depthOf(vec3 color) {
                float level = floor(max(max(color.r, color.g), color.b) * 255.0 + 0.5);
                return ${invert ? "255.0 - level" : "level"};
            }
            vec4 nothing(vec2 pixel) {
                ${showLight ? `if (floor(pixel / u_scale) == floor(u_light / u_scale)) return vec4(1.0);` : ""}
                return vec4(0.0, 0.0, 0.0, 1.0);
            }
            void main() {
                // Whole pixels, y down, as AVS counted them.
                vec2 pixel = floor(vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y));
                if (pixel.x < u_scale || pixel.y < u_scale || pixel.x >= u_resolution.x - u_scale || pixel.y >= u_resolution.y - u_scale) {
                    setFragColor(nothing(pixel));
                    return;
                }
                vec3 color = getSrcColor().rgb;
                vec2 t = u_scale / u_resolution;
                vec3 left = sampleDepth(v_position - vec2(t.x, 0.0));
                vec3 right = sampleDepth(v_position + vec2(t.x, 0.0));
                vec3 above = sampleDepth(v_position + vec2(0.0, t.y));
                vec3 below = sampleDepth(v_position - vec2(0.0, t.y));
                ${ownFrame ? `if (left + right + above + below == vec3(0.0)) {
                    setFragColor(nothing(pixel));
                    return;
                }` : ""}
                vec2 away = floor((pixel - u_light) / u_scale);
                float across = 127.0 - abs(depthOf(right) - depthOf(left) - away.x);
                float down = 127.0 - abs(depthOf(below) - depthOf(above) - away.y);
                vec3 lit = min(color, vec3(254.0 / 255.0));
                if (across > 0.0 && down > 0.0) {
                    float light = floor(across * down * u_depth / 16384.0);
                    lit = min(floor(color * 255.0 + 0.5) + light, vec3(254.0)) / 255.0;
                }
                setFragColor(vec4(blendAvs(color, lit), 1.0));
            }`;
    }

    protected values() {
        const opts = this.opts;
        const code = this.code;
        const beat = this.main.getAnalyser().isBeat();
        if (!this.inited) {
            code.init();
            this.inited = true;
        }
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        code.isbeat = beat ? -1 : 1;
        code.islbeat = this.beatFrames ? -1 : 1;
        const depth = Number(opts.depth) || 0;
        const beatDepth = Number(opts.onBeatDepth) || 0;
        const duration = Math.max(1, Number(opts.duration) || 1);
        if (opts.onBeat && beat) {
            this.depth = beatDepth;
            this.beatFrames = duration;
        } else if (!this.beatFrames) {
            this.depth = depth;
        }
        const bi = Math.max(0, Math.min(1, Number.isFinite(code.bi) ? code.bi : 1));
        code.bi = bi;
        this.depth = Math.trunc(this.depth * bi);
        const scaled = Math.trunc((this.depth * 256) / 100);
        if (this.beatFrames) {
            this.beatFrames--;
            if (this.beatFrames) {
                this.depth += Math.trunc(Math.abs(depth - beatDepth) / duration) * (beatDepth > depth ? -1 : 1);
            }
        }
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const scale = Math.max(1, height / 384);
        const x = Number.isFinite(code.x) ? code.x : 0.5;
        const y = Number.isFinite(code.y) ? code.y : 0.5;
        // The depth from a saved buffer (see converterCompat), else the frame
        // itself; AVS skips the effect while that buffer was never saved.
        let source = this.parent.getTSM().getCurrentTexture();
        if (opts.depthSource) {
            if (!this.main.avsWrittenBuffers || !this.main.avsWrittenBuffers.has(opts.depthSource)) {
                return null;
            }
            try {
                source = this.main.getTempTSM().getTexture(opts.depthSource);
            } catch (missing) {
                return null;
            }
        }
        // (int)(x · w), or of x / 100 in presets saved before AVS had the option (a missing
        // field reads as "old style", as load_config does); then cut to 0 … w and 0 … h.
        const oldStyle = opts.oldStyle === undefined ? true : Boolean(opts.oldStyle);
        const avsW = Math.max(1, Math.round(width / scale));
        const avsH = Math.max(1, Math.round(height / scale));
        const cx = Math.max(0, Math.min(avsW, Math.trunc(oldStyle ? (x / 100.0) * avsW : x * avsW)));
        const cy = Math.max(0, Math.min(avsH, Math.trunc(oldStyle ? (y / 100.0) * avsH : y * avsH)));
        return {
            light: [cx * scale, cy * scale],
            depth: scaled,
            scale,
            depthSource: source,
        };
    }
}

/** OnBeat Clear: every n-th beat the screen is filled with a colour (or half blended). */
export class OnBeatClear extends ShaderEffect {
    public static componentName: string = "OnBeatClear";
    public static componentTag: string = "render";
    private beats: number;

    public init() {
        super.init();
        this.beats = 0;
    }

    protected fragment() {
        const color = glslColor(this.opts.color);
        const average = simpleBlend(this.opts.blendMode) === "AVERAGE";
        return `
            void main() {
                ${average ? `setFragColor(vec4((getSrcColor().rgb + ${color}) * 0.5, 1.0));` : `setFragColor(vec4(${color}, 1.0));`}
            }`;
    }

    protected values() {
        const every = Math.max(0, Number(this.opts.clearBeats) || 0);
        if (!every || !this.main.getAnalyser().isBeat()) {
            return null;
        }
        this.beats++;
        if (this.beats < every) {
            return null;
        }
        this.beats = 0;
        return {};
    }
}

/**
 * Add Borders ("Virtual Effect: Addborders" APE): a frame of one colour, its rows and columns from
 * addBorders.ts (size % of the height and the width, at least a pixel). Until 09.11 the size was
 * taken for pixels, so a 1 drew one pixel instead of 1% (DarK MatteR — Transform).
 */
export class AddBorders extends ShaderEffect {
    public static componentName: string = "AddBorders";
    public static componentTag: string = "trans";

    protected uniforms() {
        return {
            columns: { name: "u_columns", valueType: WebGLVarType._1F },
            rows: { name: "u_rows", valueType: WebGLVarType._1F },
        };
    }

    protected fragment() {
        return `
            uniform float u_rows;
            uniform float u_columns;
            void main() {
                vec2 pixel = floor(gl_FragCoord.xy);
                bool border = pixel.x < u_columns || pixel.y < u_rows || pixel.x >= u_resolution.x - u_columns || pixel.y >= u_resolution.y - u_rows;
                setFragColor(border ? vec4(${glslColor(this.opts.color)}, 1.0) : getSrcColor());
            }`;
    }

    protected values() {
        if (this.opts.enabled === false) {
            return null;
        }
        const gl = this.main.getRctx().getGl();
        return addBorderPixels(gl.drawingBufferWidth, gl.drawingBufferHeight, this.opts.size);
    }
}

/** MultiFilter (Jheriko's APE): the chrome filters — every channel folded back at the top. */
export class MultiFilter extends ShaderEffect {
    public static componentName: string = "MultiFilter";
    public static componentTag: string = "trans";

    protected fragment() {
        const effect = String(this.opts.effect || "CHROME").toUpperCase();
        const folds = effect.indexOf("TRIPLE") >= 0 ? 3 : effect.indexOf("DOUBLE") >= 0 ? 2 : effect.indexOf("CHROME") >= 0 ? 1 : 0;
        const fold = "color = 1.0 - abs(1.0 - color * 2.0);";
        return `
            void main() {
                vec3 color = getSrcColor().rgb;
                ${fold.repeat(folds)}
                setFragColor(vec4(color, 1.0));
            }`;
    }
}

/**
 * Video Delay (Tom Holden's APE, in vis_avs 2.81 as r_videodelay.cpp): shows the frame from
 * framedelay frames ago and keeps the current one in its place (videoDelayRing.ts: AVS's buffer,
 * frame for frame — black until it has filled, frames moved as AVS moved them when the delay
 * changes). AVS starts framedelay at 10 and its load_config sets only `delay`, so a preset as
 * loaded delays 10 frames whatever its setting says; on beats it becomes frames-since-the-last-
 * beat x delay (at most 400). Frames live on the graphics card: past a 128 MB budget only every
 * n-th frame is kept (the delay stays, fewer frames are shown).
 */
export class VideoDelay extends Component {
    public static componentName: string = "VideoDelay";
    public static componentTag: string = "trans";
    private ring: DelayRing<IKeptFrame>;
    private live: Set<IKeptFrame>;
    private black: IKeptFrame | null;
    private blackFrame: string;
    private frameDelay: number;
    private sinceBeat: number;
    // The budget's way, past it.
    private frames;
    private written: number;
    private tick: number;

    public init() {
        this.ring = newDelayRing();
        this.live = new Set();
        this.black = null;
        this.blackFrame = "";
        this.frameDelay = 10;
        this.sinceBeat = 0;
        this.frames = [];
        this.written = 0;
        this.tick = 0;
    }

    public draw() {
        const opts = this.opts;
        const useBeats = Boolean(opts.useBeats);
        // load_config: at most 16 (beats) or 200 frames.
        const delay = Math.min(useBeats ? 16 : 200, Math.max(0, Math.trunc(Number(opts.delay) || 0)));
        if (useBeats) {
            if (this.main.getAnalyser().isBeat()) {
                this.frameDelay = Math.min(400, this.sinceBeat * delay);
                this.sinceBeat = 0;
            }
            this.sinceBeat++;
        }
        if (opts.enabled === false || this.frameDelay <= 0) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const frameBytes = Math.max(1, gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        const budget = Math.max(2, Math.floor((128 * 1024 * 1024) / frameBytes));
        if (this.frameDelay > budget) {
            this.clearRing();
            this.decimated(this.frameDelay, budget);
            return;
        }
        this.clearDecimated();
        const frame = `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
        resizeDelayRing(this.ring, this.frameDelay, frame, useBeats);
        trimDelayRing(this.ring);
        const tsm = this.parent.getTSM();
        const kept = keepFrame(this.main);
        kept.store(tsm.getCurrentTexture());
        this.live.add(kept);
        const shown = stepDelayRing(this.ring, kept);
        if (shown) {
            this.main.getCopier().run(tsm, { srcTexture: shown.texture() });
        } else {
            // Memory AVS had just allocated: zeros.
            if (!this.black || this.blackFrame !== frame) {
                this.black = this.black || keepFrame(this.main);
                this.black.clear();
                this.blackFrame = frame;
            }
            this.main.getCopier().run(tsm, { srcTexture: this.black.texture() });
        }
        // Frames no slot holds any more go back to the pool.
        const held = new Set(this.ring.ring);
        for (const frameKept of this.live) {
            if (!held.has(frameKept)) {
                frameKept.release();
                this.live.delete(frameKept);
            }
        }
    }

    public destroy() {
        super.destroy();
        this.clearRing();
        this.clearDecimated();
        if (this.black) {
            this.black.release();
            this.black = null;
        }
    }

    private clearRing() {
        for (const frameKept of this.live || []) {
            frameKept.release();
        }
        this.live = new Set();
        this.ring = newDelayRing();
    }

    private clearDecimated() {
        for (const frame of this.frames || []) {
            frame.release();
        }
        this.frames = [];
        this.written = 0;
        this.tick = 0;
    }

    /** Past the budget: every n-th frame kept in `slots` slots, the delay kept. */
    private decimated(delay: number, slots: number) {
        const every = Math.ceil(delay / slots);
        while (this.frames.length < slots) {
            this.frames.push(keepFrame(this.main));
        }
        while (this.frames.length > slots) {
            this.frames.pop().release();
        }
        const tsm = this.parent.getTSM();
        const current = tsm.getCurrentTexture();
        const slot = this.written % slots;
        const store = this.tick % every === 0;
        this.tick++;
        if (store) {
            // Keep this frame before the old one in its slot is shown.
            if (this.written >= slots) {
                const shown = this.frames[slot];
                const kept = keepFrame(this.main);
                kept.store(current);
                this.main.getCopier().run(tsm, { srcTexture: shown.texture() });
                shown.release();
                this.frames[slot] = kept;
            } else {
                this.frames[slot].store(current);
            }
            this.written++;
        } else if (this.written >= slots) {
            this.main.getCopier().run(tsm, { srcTexture: this.frames[slot].texture() });
        }
    }
}

/** Sampling the frame at a pixel position (y down); smooth is AVS's integer bilinear. */
const PIXEL_SAMPLING = `
    ${HIGH_PRECISION}
    vec3 pixelAt(vec2 pixel) {
        vec2 uv = (pixel + 0.5) / u_resolution;
        return getSrcColorAtPos(vec2(uv.x, 1.0 - uv.y)).rgb;
    }
    ${avsBilinearGlsl("pixelSmooth", "u_srcTexture")}`;

/**
 * Roto Blitter as r_rotblit.cpp: each row walks the frame in 16.16 fixed point from
 * sstart + row·ds_dy by ds_dx a pixel (and t likewise), folded into [0, (w − 1) << 16) at
 * every step; with "bilinear" BLEND4_16 reads four pixels by the walk's 8-bit fractions,
 * otherwise the pixel itself; "blend" is 50/50 ((a >> 1) + (b >> 1)). The position is
 * start + row·step_y + x·step_x, which the shader adds exactly in floats as high parts (>> 8)
 * and low bytes, like Dynamic Movement's walk. A step a whole frame wide made AVS draw nothing.
 */
export class RotoBlitter extends ShaderEffect {
    public static componentName: string = "RotoBlitter";
    public static componentTag: string = "trans";
    private scaleFpos: number;
    private rotRev: number;
    private rotRevPos: number;

    public init() {
        super.init();
        this.scaleFpos = Math.trunc(Number(this.opts.zoom) || 0);
        this.rotRev = 1;
        this.rotRevPos = 1.0;
    }

    protected uniforms() {
        return {
            start: { name: "u_start", valueType: WebGLVarType._4FV },
            stepX: { name: "u_stepX", valueType: WebGLVarType._4FV },
            stepY: { name: "u_stepY", valueType: WebGLVarType._4FV },
        };
    }

    protected fragment() {
        const average = simpleBlend(this.opts.blendMode) === "AVERAGE";
        const bilinear = Boolean(this.opts.bilinear);
        return `
            ${HIGH_PRECISION}
            ${avsBlend4Glsl()}
            uniform vec4 u_start; // s, t: high part (>> 8), low byte
            uniform vec4 u_stepX; // ds_dx, dt_dx: the same
            uniform vec4 u_stepY; // ds_dy, dt_dy: the same
            vec3 levelAt(vec2 pixel) {
                vec2 uv = (pixel + 0.5) / u_resolution;
                return floor(getSrcColorAtPos(vec2(uv.x, 1.0 - uv.y)).rgb * 255.0 + 0.5);
            }
            void main() {
                vec2 frag = floor(gl_FragCoord.xy);
                float x = frag.x;
                float row = u_resolution.y - 1.0 - frag.y;
                vec2 period = (u_resolution - 1.0) * 256.0;
                vec2 high = u_start.xz + row * u_stepY.xz + x * u_stepX.xz;
                vec2 low = u_start.yw + row * u_stepY.yw + x * u_stepX.yw;
                vec2 at8 = high + floor(low / 256.0);
                at8 -= period * floor(at8 / period);
                vec2 pixel = floor(at8 / 256.0);
                vec2 fraction = at8 - pixel * 256.0;
                vec3 color = ${bilinear
                    ? `avsBlend4(levelAt(pixel), levelAt(pixel + vec2(1.0, 0.0)), levelAt(pixel + vec2(0.0, 1.0)),
                        levelAt(pixel + vec2(1.0, 1.0)), fraction.x, fraction.y)`
                    : "levelAt(pixel)"};
                ${average ? "color = floor(color * 0.5) + floor(floor(getSrcColor().rgb * 255.0 + 0.5) * 0.5);" : ""}
                setFragColor(vec4(color / 255.0, 1.0));
            }`;
    }

    protected values() {
        const opts = this.opts;
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const beat = this.main.getAnalyser().isBeat();
        const zoomScale = Math.trunc(Number(opts.zoom) || 0);
        const zoomScale2 = Math.trunc(Number(opts.onBeatZoom) || 0);
        if (beat && opts.onBeatReverse) {
            this.rotRev = -this.rotRev;
        }
        if (!opts.onBeatReverse) {
            this.rotRev = 1;
        }
        const speed = Math.trunc(Number(opts.reversalSpeed) || 0);
        this.rotRevPos += (1.0 / (1 + speed * 4)) * (this.rotRev - this.rotRevPos);
        if (this.rotRevPos > this.rotRev && this.rotRev > 0) {
            this.rotRevPos = this.rotRev;
        }
        if (this.rotRevPos < this.rotRev && this.rotRev < 0) {
            this.rotRevPos = this.rotRev;
        }
        if (beat && opts.onBeat) {
            this.scaleFpos = zoomScale2;
        }
        let fVal;
        if (zoomScale < zoomScale2) {
            fVal = Math.max(this.scaleFpos, zoomScale);
            if (this.scaleFpos > zoomScale) {
                this.scaleFpos -= 3;
            }
        } else {
            fVal = Math.min(this.scaleFpos, zoomScale);
            if (this.scaleFpos < zoomScale) {
                this.scaleFpos += 3;
            }
        }
        const zoom = 1.0 + (fVal - 31) / 31.0;
        const theta = ((Math.trunc(Number(opts.rotate) || 0) - 32)) * this.rotRevPos;
        const cInt = (value: number) => (Math.abs(value) < 2147483648 ? Math.trunc(value) : -2147483648);
        let temp = Math.cos((theta * Math.PI) / 180.0) * zoom;
        const dsDx = cInt(temp * 65536.0);
        const dtDy = cInt(temp * 65536.0);
        temp = Math.sin((theta * Math.PI) / 180.0) * zoom;
        const dsDy = -cInt(temp * 65536.0);
        const dtDx = cInt(temp * 65536.0);
        const ds = (w - 1) * 65536;
        const dt = (h - 1) * 65536;
        if (dsDx <= -ds || dsDx >= ds || dtDx <= -dt || dtDx >= dt) {
            return null; // AVS wrote nothing (its other buffer, as it was, became the frame)
        }
        const half = (n: number) => Math.trunc((n - 1) / 2);
        const sStart = (-(half(w) * dsDx + half(h) * dsDy) + (w - 1) * (32768 + (1 << 20))) | 0;
        const tStart = (-(half(w) * dtDx + half(h) * dtDy) + (h - 1) * (32768 + (1 << 20))) | 0;
        const split = (a: number, b: number) => [a >> 8, a & 255, b >> 8, b & 255];
        return { start: split(sStart, tStart), stepX: split(dsDx, dtDx), stepY: split(dsDy, dtDy) };
    }
}

/**
 * Blitter Feedback as r_blit.cpp. Below 32 (zoom in) every pixel reads the frame at
 * isx + x·ds_x, s_y + row·ds_x in 16.16 (ds_x = ((f + 32) << 16) / 64, the start centring the
 * picture), with "bilinear" through the MMX BLEND4 of the 8-bit fractions, otherwise the pixel
 * itself; above 32 (zoom out) a box of ((w << 16) / ds_x) & ~3 by (h << 16) / ds_x pixels in the
 * middle gets the whole frame, nearest, stepping from 32768 by ds_x = (f + 96) << 9, and the
 * rest stays. "Blend" is 50/50 with the frame. A beat jumps to the other zoom, which walks back
 * 3 steps a frame. The positions are added exactly in floats as high parts and low bytes.
 */
export class BlitterFeedback extends ShaderEffect {
    public static componentName: string = "BlitterFeedback";
    public static componentTag: string = "trans";
    private fpos: number;

    public init() {
        super.init();
        this.fpos = Math.trunc(Number(this.opts.zoom) || 0);
    }

    protected uniforms() {
        return {
            outward: { name: "u_outward", valueType: WebGLVarType._1F },
            start: { name: "u_start", valueType: WebGLVarType._4FV },
            step: { name: "u_step", valueType: WebGLVarType._2FV },
            box: { name: "u_box", valueType: WebGLVarType._4FV },
        };
    }

    protected fragment() {
        const average = simpleBlend(this.opts.blendMode) === "AVERAGE";
        const bilinear = Boolean(this.opts.bilinear);
        return `
            ${HIGH_PRECISION}
            ${avsBlend4Glsl()}
            uniform float u_outward;
            uniform vec4 u_start; // s_x, s_y: high part (>> 8), low byte
            uniform vec2 u_step;  // ds_x: high part, low byte
            uniform vec4 u_box;   // zoom out: start_x, start_y, x_len, y_len
            vec3 levelAt(vec2 pixel) {
                vec2 uv = (pixel + 0.5) / u_resolution;
                return floor(getSrcColorAtPos(vec2(uv.x, 1.0 - uv.y)).rgb * 255.0 + 0.5);
            }
            void main() {
                vec2 frag = floor(gl_FragCoord.xy);
                vec2 at = vec2(frag.x, u_resolution.y - 1.0 - frag.y);
                vec3 here = floor(getSrcColor().rgb * 255.0 + 0.5);
                vec2 walk = at;
                if (u_outward > 0.5) {
                    walk = at - u_box.xy;
                    if (any(lessThan(walk, vec2(0.0))) || any(greaterThanEqual(walk, u_box.zw))) {
                        setFragColor(vec4(here / 255.0, 1.0));
                        return;
                    }
                }
                vec2 at8 = u_start.xz + walk * u_step.x + floor((u_start.yw + walk * u_step.y) / 256.0);
                vec2 pixel = floor(at8 / 256.0);
                vec2 fraction = at8 - pixel * 256.0;
                vec3 color = ${bilinear
                    ? `u_outward > 0.5 ? levelAt(pixel) : avsBlend4(levelAt(pixel), levelAt(pixel + vec2(1.0, 0.0)),
                        levelAt(pixel + vec2(0.0, 1.0)), levelAt(pixel + vec2(1.0, 1.0)), fraction.x, fraction.y)`
                    : "levelAt(pixel)"};
                ${average ? "color = floor(color * 0.5) + floor(here * 0.5);" : ""}
                setFragColor(vec4(color / 255.0, 1.0));
            }`;
    }

    protected values() {
        const opts = this.opts;
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const scale = Math.trunc(Number(opts.zoom) || 0);
        const scale2 = Math.trunc(Number(opts.onBeatZoom) || 0);
        if (opts.onBeat && this.main.getAnalyser().isBeat()) {
            this.fpos = scale2;
        }
        let fVal;
        if (scale < scale2) {
            fVal = this.fpos > scale ? this.fpos : scale;
            this.fpos -= 3;
        } else {
            fVal = this.fpos < scale ? this.fpos : scale;
            this.fpos += 3;
        }
        if (fVal < 0) {
            fVal = 0;
        }
        const split = (a: number, b: number) => [a >> 8, a & 255, b >> 8, b & 255];
        if (fVal < 32) {
            const ds = Math.trunc(((fVal + 32) << 16) / 64);
            const isx = Math.trunc(((w << 16) - ds * w) / 2);
            const sy = Math.trunc(((h << 16) - ds * h) / 2);
            return { outward: 0, start: split(isx, sy), step: [ds >> 8, ds & 255], box: [0, 0, w, h] };
        }
        if (fVal > 32) {
            const ds = (fVal + (1 << 7) - 32) << (16 - 7);
            const xLen = Math.trunc((w << 16) / ds) & ~3;
            const yLen = Math.trunc((h << 16) / ds);
            if (xLen >= w || yLen >= h) {
                return null;
            }
            const startX = Math.trunc((w - xLen) / 2);
            const startY = Math.trunc((h - yLen) / 2);
            return { outward: 1, start: split(32768, 32768), step: [ds >> 8, ds & 255], box: [startX, startY, xLen, yLen] };
        }
        return null;
    }
}

/**
 * Moving Particle, after vis_avs r_parts.cpp: a dot on a spring that a beat
 * sends to a new place (±1/3 of the way), drawn as AVS's filled circle of
 * `size` pixels (a beat can set `onBeatSize`, which halves back towards size
 * every frame). The webvs version never drew: its vertex attribute had
 * another name than its shader's.
 */
export class MovingParticle extends ShaderEffect {
    public static componentName: string = "MovingParticle";
    public static componentTag: string = "render";
    private target: number[];
    private velocity: number[];
    private position: number[];
    private size: number;

    public init() {
        super.init();
        // AVS (r_parts.cpp) starts the particle left of and below the centre, moving left.
        this.target = [0, 0];
        this.velocity = [-0.01551, 0];
        this.position = [-0.6, 0.3];
        this.size = Number(this.opts.particleSize) || 0;
    }

    protected uniforms() {
        return {
            adjust: { name: "u_adjust", valueType: WebGLVarType._1F },
            centre: { name: "u_centre", valueType: WebGLVarType._2FV },
            lineMode: { name: "u_lineMode", valueType: WebGLVarType._1I },
            size: { name: "u_size", valueType: WebGLVarType._1F },
        };
    }

    protected fragment() {
        const mode = String(this.opts.blendMode || "").toUpperCase();
        const average = mode.indexOf("FIFTY") >= 0 || mode.indexOf("50") >= 0;
        // r_parts.cpp: 0 replace, 1 additive, 2 50/50, 3 BLEND_LINE — the line mode the
        // last Set Render Mode left (none: replace). "Default" used to add, so
        // overlapping particles burned white.
        const line = mode === "DEFAULT";
        const additive = mode === "ADDITIVE";
        const paint = line
            ? "avsBlendLine(u_lineMode, floor(color * 255.0 + 0.5), floor(ink * 255.0 + 0.5), u_adjust) / 255.0"
            : additive
                ? "min(color + ink, vec3(1.0))"
                : average
                    ? "(floor(floor(color * 255.0 + 0.5) * 0.5) + floor(floor(ink * 255.0 + 0.5) * 0.5)) / 255.0"
                    : "ink";
        return `
            ${AVS_BLEND_GLSL}
            uniform vec2 u_centre;
            uniform float u_size;
            uniform int u_lineMode;
            uniform float u_adjust;
            void main() {
                vec3 color = getSrcColor().rgb;
                vec2 pixel = floor(vec2(v_position.x, 1.0 - v_position.y) * u_resolution);
                bool inside;
                if (u_size <= 1.0) {
                    inside = pixel == u_centre;
                } else {
                    float row = pixel.y - (u_centre.y - floor(u_size * 0.5));
                    float across = row - u_size * 0.5;
                    float reach = max(1.0, floor(sqrt(max(0.0, u_size * u_size * 0.25 - across * across)) + 0.99));
                    inside = row >= 0.0 && row < u_size && pixel.x >= u_centre.x - reach && pixel.x < u_centre.x + reach;
                }
                vec3 ink = ${glslColor(this.opts.color)};
                setFragColor(vec4(inside ? ${paint} : color, 1.0));
            }`;
    }

    protected values() {
        const opts = this.opts;
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const beat = this.main.getAnalyser().isBeat();
        if (beat) {
            const targetX = ((cRand() % 33) - 16) / 48;
            this.target = [targetX, ((cRand() % 33) - 16) / 48];
        }
        for (const axis of [0, 1]) {
            this.velocity[axis] -= 0.004 * (this.position[axis] - this.target[axis]);
            this.position[axis] += this.velocity[axis];
            this.velocity[axis] *= 0.991;
        }
        const reach = Math.min(h / 2, (w * 3) / 8) * ((Number(opts.distance) || 0) / 32);
        const x = Math.trunc(this.position[0] * reach) + Math.floor(w / 2);
        const y = Math.trunc(this.position[1] * reach) + Math.floor(h / 2);
        if (beat && opts.onBeatSizeChange) {
            this.size = Number(opts.onBeatParticleSize) || 0;
        }
        const size = Math.min(128, this.size);
        this.size = Math.trunc((this.size + (Number(opts.particleSize) || 0)) / 2);
        // Pixels of AVS's window, scaled to this one.
        const scale = this.main.avsScale || 1;
        const line = avsLineMode(this.main);
        return {
            adjust: line.adjust,
            centre: [x, y],
            lineMode: line.mode,
            size: size <= 1 ? 1 : Math.round(size * scale),
        };
    }
}
