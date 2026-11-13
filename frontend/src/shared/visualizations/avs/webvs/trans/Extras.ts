// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Components AVS presets use that webvs never had, or has under another name.
 *
 * - GridMovement: AVS's Movement on a fine Dynamic Movement grid, the fallback
 *   of trans/Movement.ts (the exact per-pixel port).
 * - ConvolutionFilter (the APE) is webvs's Convolution with its 7×7 kernel.
 * - Blur is AVS's light/medium/heavy blur.
 * - Comment and AVSTransAutomation draw nothing (AVS Trans works when a preset
 *   loads, avsTrans.ts); they are registered so a preset loads instead of being
 *   skipped component by component with a warning each. Picture II lives in
 *   render/AvsPicture.ts.
 * - GridDistanceModifier: Dynamic Distance Modifier on a Dynamic Movement grid,
 *   the fallback of DistanceModifier.ts; GlobalVariables is webvs's GlobalVar.
 */
import { skipCRand } from "../avsRandom";
import Component from "../Component";
import GlobalVar from "../misc/GlobalVar";
import { HIGH_PRECISION, simpleBlend } from "../avsSupport";
import { avsBlend, WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import Convolution from "./Convolution";
import CpuDynamicMovement from "./CpuDynamicMovement";

const BUILTIN_MOVEMENT: { [name: string]: { code: string; rect: boolean } } = {
    "none": { code: "", rect: false },
    "slight fuzzify": { code: "x = x + (rand(3) - 2) * 0.004; y = y + (rand(3) - 2) * 0.004;", rect: true },
    "shift rotate left": { code: "x=x+1/32;", rect: true },
    "big swirl out": { code: "r = r + (0.1 - (0.2 * d));\nd = d * 0.96;", rect: false },
    "medium swirl": { code: "d = d * (0.99 * (1.0 - sin(r-$PI*0.5) / 32.0));\nr = r + (0.03 * sin(d * $PI * 4));", rect: false },
    "sunburster": { code: "d = d * (0.94 + (cos((r-$PI*0.5) * 32.0) * 0.06));", rect: false },
    "swirl to center": { code: "d = d * (1.01 + (cos((r-$PI*0.5) * 4) * 0.04));\nr = r + (0.03 * sin(d * $PI * 4));", rect: false },
    "blocky partial out": { code: "x = x * 0.985; y = y * 0.985;", rect: true },
    "swirling around both ways at once": { code: "r = r + (0.1 * sin(d * $PI * 5));", rect: false },
    "bubbling outward": { code: "t = sin(d * $PI);\nd = d - (8*t*t*t*t*t)/sqrt((w*w+h*h)/4);", rect: false },
    "bubbling outward with swirl": { code: "t = sin(d * $PI);\nd = d - (8*t*t*t*t*t)/sqrt((w*w+h*h)/4);\nt=cos(d*$PI/2.0);\nr= r + 0.1*t*t*t;", rect: false },
    "5 pointed distro": { code: "d = d * (0.95 + (cos(((r-$PI*0.5) * 5.0) - ($PI / 2.50)) * 0.03));", rect: false },
    "tunneling": { code: "r = r + 0.04;\nd = d * (0.96 + cos(d * $PI) * 0.05);", rect: false },
    "bleedin'": { code: "t = cos(d * $PI);\nr = r + (0.07 * t);\nd = d * (0.98 + t * 0.10);", rect: false },
    "shifted big swirl out": { code: "d=sqrt(x*x+y*y); r=atan2(y,x);\nr=r+0.1-0.2*d; d=d*0.96;\nx=cos(r)*d + 8/128; y=sin(r)*d;", rect: true },
    "psychotic beaming outward": { code: "d = 0.15", rect: false },
    "cosine radial 3-way": { code: "r = cos(r * 3)", rect: false },
    "spinny tube": { code: "d = d * (1 - ((d - .35) * .5));\nr = r + .1;", rect: false },
    "radial swirlies": { code: "d = d * (1 - (sin((r-$PI*0.5) * 7) * .03));\nr = r + (cos(d * 12) * .03);", rect: false },
    "swill": { code: "d = d * (1 - (sin((r - $PI*0.5) * 12) * .05));\nr = r + (cos(d * 18) * .05);\nd = d * (1-((d - .4) * .03));\nr = r + ((d - .4) * .13)", rect: false },
    "gridley": { code: "x = x + (cos(y * 18) * .02);\ny = y + (sin(x * 14) * .03);", rect: true },
    "grapevine": { code: "x = x + (cos(abs(y-.5) * 8) * .02);\ny = y + (sin(abs(x-.5) * 8) * .05);\nx = x * .95;\ny = y * .95;", rect: true },
    "quadrant": { code: "y = y * ( 1 + (sin(r + $PI/2) * .3) );\nx = x * ( 1 + (cos(r + $PI/2) * .3) );\nx = x * .995;\ny = y * .995;", rect: true },
    "6-way kaleida (use wrap!)": { code: "y = (r*6)/($PI); x = d;", rect: true },
};

/**
 * Movement approximated on a fine Dynamic Movement grid: what trans/Movement.ts
 * falls back to where the GPU cannot hold its per-pixel table (no float textures).
 */
export class GridMovement extends CpuDynamicMovement {
    public static componentName: string = "GridMovement";
    public static componentTag: string = "trans";

    constructor(main, parent, opts) {
        super(main, parent, GridMovement.translate(opts || {}));
    }

    public static translate(opts) {
        const builtinName = String(opts.builtinEffect || "").toLowerCase();
        const builtin = BUILTIN_MOVEMENT[builtinName];
        const source = builtin ? builtin.code : String(opts.code || "");
        // AVS Movement calls the screen size sw/sh; DynamicMovement calls it w/h.
        const code = source.replace(/\bsw\b/gi, "w").replace(/\bsh\b/gi, "h");
        const coordinates = String(opts.coordinates || "").toUpperCase();
        const rect = builtin ? builtin.rect : coordinates === "CARTESIAN" || coordinates === "RECT" || coordinates === "RECTANGULAR";
        return {
            id: opts.id,
            enabled: opts.enabled,
            code: { init: "", onBeat: "", perFrame: "", perPixel: code },
            coord: rect ? "RECT" : "POLAR",
            bFilter: opts.bilinear !== false,
            blend: String(opts.output || "").indexOf("50") >= 0,
            // AVS blends Movement's 50/50 as (a >> 1) + (b >> 1).
            averageBlend: true,
            // A static warp is computed per pixel in AVS; a finer grid comes close.
            gridW: 48,
            gridH: 36,
            compat: false,
            noGrid: false,
        };
    }
}

export class ConvolutionFilter extends Convolution {
    public static componentName: string = "ConvolutionFilter";
    public static componentTag: string = "trans";

    constructor(main, parent, opts) {
        const kernel = opts && opts.kernel && Array.isArray(opts.kernel.data) ? opts.kernel.data.slice() : [0, 0, 0, 0, 1, 0, 0, 0, 0];
        // AVS divides by the scale as saved (0 means 1). webvsc names AVS's "wrap" (a negative
        // result wraps round to white) `edgeMode`; it is not about the picture's edges, which AVS
        // always extends (and never reads the last row, nor the last column from the last three:
        // `avsEdges`).
        // Convolution.ts does the arithmetic as AVS does.
        const scale = Math.trunc(Number(opts.scale) || 0) || 1;
        super(main, parent, {
            id: opts.id,
            enabled: opts.enabled,
            kernel,
            edgeMode: "EXTEND",
            avsEdges: true,
            wrap: opts.edgeMode === "WRAP" && !opts.absolute,
            absolute: Boolean(opts.absolute),
            twoPass: Boolean(opts.twoPass),
            autoScale: false,
            scale,
            bias: Number(opts.bias) || 0,
        });
    }
}


export class Blur extends Component {
    public static componentName: string = "Blur";
    public static componentTag: string = "trans";
    private program: ShaderProgram;

    public init() {
        // AVS (e_blur.cpp), per channel, every term rounded down:
        //   light:  c/2 + c/4 + each neighbour/16
        //   medium: c/2 + each neighbour/8
        //   heavy:  each neighbour/4 (the pixel itself drops out)
        // "Round up" adds what the truncation loses at most (5, 4, 3).
        const level = String(this.opts.blur || "MEDIUM").toUpperCase();
        const up = String(this.opts.round || "").toUpperCase() === "UP";
        const formula = level === "LIGHT"
            ? `floor(c / 2.0) + floor(c / 4.0) + floor(l / 16.0) + floor(r / 16.0) + floor(u / 16.0) + floor(d / 16.0)${up ? " + 5.0" : ""}`
            : level === "HEAVY"
                ? `floor(l / 4.0) + floor(r / 4.0) + floor(u / 4.0) + floor(d / 4.0)${up ? " + 3.0" : ""}`
                : `floor(c / 2.0) + floor(l / 8.0) + floor(r / 8.0) + floor(u / 8.0) + floor(d / 8.0)${up ? " + 4.0" : ""}`;
        this.program = new ShaderProgram(this.main.getRctx(), {
            fragmentShader: `
                vec3 level(vec2 pos) {
                    return floor(getSrcColorAtPos(clamp(pos, vec2(0.0), vec2(1.0))).rgb * 255.0 + 0.5);
                }
                void main() {
                    vec2 t = 1.0 / u_resolution;
                    vec3 c = level(v_position);
                    vec3 l = level(v_position - vec2(t.x, 0.0));
                    vec3 r = level(v_position + vec2(t.x, 0.0));
                    vec3 u = level(v_position + vec2(0.0, t.y));
                    vec3 d = level(v_position - vec2(0.0, t.y));
                    setFragColor(vec4(min(${formula}, vec3(255.0)) / 255.0, 1.0));
                }
            `,
            swapFrame: true,
        });
    }

    public draw() {
        if (String(this.opts.blur || "").toUpperCase() !== "NONE") this.program.run(this.parent.getTSM(), null);
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
    }
}

function quiet(name: string, tag: string) {
    return class extends Component {
        public static componentName: string = name;
        public static componentTag: string = tag;
        public init() { /* nothing to prepare */ }
        public draw() { /* not drawn yet */ }
    };
}

export const Comment = quiet("Comment", "misc");
/**
 * Custom BPM, after Nullsoft's vis_avs r_bpm.cpp: decides the beat for the effects
 * after it in its list. Arbitrary: a beat whenever more than `arbitraryValue` ms
 * have passed since the last one (and none in between); skip: every
 * (`skipValue` + 1)th beat; reverse: a beat on every frame without one. The
 * first `skipFirstBeats` beats are dropped whatever the mode.
 */
export class CustomBPM extends Component {
    public static componentName: string = "CustomBPM";
    public static componentTag: string = "misc";
    /** true: a beat, false: none, null: as it was (read by EffectList). */
    public beatDecision: boolean | null;
    private beats: number;
    private skipped: number;
    private start: number | null;
    private last: number | null;

    public init() {
        this.beatDecision = null;
        this.beats = 0;
        this.skipped = 0;
        this.start = null;
        this.last = null;
    }

    public draw() {
        this.beatDecision = this.decide(this.main.getAnalyser().isBeat());
    }

    private decide(beat: boolean): boolean | null {
        const opts = this.opts;
        if (beat) {
            this.beats++;
        }
        const skipFirst = Math.trunc(Number(opts.skipFirstBeats) || 0);
        if (skipFirst > 0 && this.beats <= skipFirst) {
            return beat ? false : null;
        }
        const mode = String(opts.mode || "").toUpperCase();
        if (mode === "ARBITRARY") {
            // GetTickCount() in AVS: milliseconds since this effect's first frame here.
            const clock = Number((this.main as any).avsFrameTime);
            const time = Number.isFinite(clock) ? clock : performance.now();
            if (this.start === null) {
                this.start = time;
            }
            const now = Math.floor(time - this.start + 1e-6);
            const interval = Math.trunc(Number(opts.arbitraryValue) || 0);
            if (this.last === null || now > this.last + interval) {
                this.last = now;
                return true;
            }
            return false;
        }
        if (mode === "SKIP") {
            if (beat && ++this.skipped >= Math.trunc(Number(opts.skipValue) || 0) + 1) {
                this.skipped = 0;
                return true;
            }
            return false;
        }
        if (mode === "REVERSE" || mode === "INVERT") {
            return !beat;
        }
        return null;
    }
}
export class SetRenderMode extends Component {
    public static componentName: string = "SetRenderMode";
    public static componentTag: string = "misc";
    public init() { /* nothing to prepare */ }
    public draw() {
        // The blend mode for the scopes drawn after this one, until the frame ends.
        // Fork: adjust is "Adjustable Blend"'s value (g_line_blend_mode >> 8), for the AVS line drawing (avsDraw.ts).
        this.main.avsRenderMode = { blend: avsBlend(this.opts.blend), lineSize: this.opts.lineSize || 1, adjust: Number(this.opts.adjustBlend) || 0 };
    }
}

/** A full-screen effect that is one fragment shader over the current frame. */
function shaderEffect(name: string, fragment: (opts: any) => string) {
    return class extends Component {
        public static componentName: string = name;
        public static componentTag: string = "trans";
        private program: ShaderProgram;
        public init() {
            this.program = new ShaderProgram(this.main.getRctx(), { fragmentShader: fragment(this.opts || {}), swapFrame: true });
        }
        public draw() {
            this.program.run(this.parent.getTSM(), null);
        }
        public destroy() {
            super.destroy();
            if (this.program) {
                this.program.destroy();
            }
        }
    };
}

const float = (value: number) => (Number.isFinite(value) ? value : 0).toFixed(4);
const rgb = (hex: string) => {
    const value = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    const n = value ? parseInt(value[1], 16) : 0;
    return `vec3(${float(((n >> 16) & 255) / 255)}, ${float(((n >> 8) & 255) / 255)}, ${float((n & 255) / 255)})`;
};

/**
 * Interleave, as r_interleave.cpp: rows take turns between painted in full and
 * patterned, and a patterned row paints every other run of `tx` pixels; the
 * pattern is centred by the remainder of the frame's size. A beat (with "on
 * beat") jumps to x2/y2, which ease back towards x/y by (beatdur + 448)/512 a
 * frame, truncated to whole pixels. The row and column masks are worked out on
 * the processor exactly like the original's loops, in AVS's window pixels; the
 * shader blends level for level: replace, saturating add, or (a >> 1) + (b >> 1).
 * (The fork's first version drew fixed stripes and missed the beat entirely.)
 */
export class Interleave extends Component {
    public static componentName: string = "Interleave";
    public static componentTag: string = "trans";
    private program: ShaderProgram;
    private rows: WebGLTexture;
    private cols: WebGLTexture;
    private curX: number;
    private curY: number;

    public init() {
        const opts = this.opts || {};
        this.curX = Math.trunc(Number(opts.x) || 0);
        this.curY = Math.trunc(Number(opts.y) || 0);
        const mode = simpleBlend(opts.blendMode);
        const paint = mode === "ADDITIVE"
            ? "min(c + ink, vec3(255.0))"
            : mode === "AVERAGE" ? "floor(c * 0.5) + floor(ink * 0.5)" : "ink";
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    cols: { name: "u_cols", valueType: WebGLVarType.TEXTURE2D },
                    rows: { name: "u_rows", valueType: WebGLVarType.TEXTURE2D },
                    size: { name: "u_avsSize", valueType: WebGLVarType._2FV },
                    scale: { name: "u_scale", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_cols;
                uniform sampler2D u_rows;
                uniform vec2 u_avsSize;
                uniform float u_scale;
                void main() {
                    vec2 p = floor(floor(vec2(v_position.x, 1.0 - v_position.y) * u_resolution) / u_scale);
                    float row = texture2D(u_rows, vec2((p.y + 0.5) / u_avsSize.y, 0.5)).r;
                    float col = texture2D(u_cols, vec2((p.x + 0.5) / u_avsSize.x, 0.5)).r;
                    vec3 c = floor(getSrcColor().rgb * 255.0 + 0.5);
                    vec3 ink = floor(${rgb(opts.color)} * 255.0 + 0.5);
                    bool painted = row > 0.75 || (row > 0.25 && col > 0.5);
                    setFragColor(vec4((painted ? ${paint} : c) / 255.0, 1.0));
                }
            `,
            swapFrame: true,
        });
    }

    public draw() {
        const opts = this.opts || {};
        const gl = this.main.getRctx().getGl();
        const scale = Math.max(1, Math.floor(gl.drawingBufferHeight / 480 + 0.5));
        const w = Math.max(1, Math.floor(gl.drawingBufferWidth / scale));
        const h = Math.max(1, Math.floor(gl.drawingBufferHeight / scale));
        const beatdur = Number(opts.beatDuration ?? 4) || 0;
        const sc1 = (beatdur + 512 - 64) / 512;
        this.curX = this.curX * sc1 + (Number(opts.x) || 0) * (1 - sc1);
        this.curY = this.curY * sc1 + (Number(opts.y) || 0) * (1 - sc1);
        if (opts.onbeat && this.main.getAnalyser().isBeat()) {
            this.curX = Number(opts.x2) || 0;
            this.curY = Number(opts.y2) || 0;
        }
        const tx = Math.trunc(this.curX);
        const ty = Math.trunc(this.curY);
        if (tx < 0 || ty < 0) {
            return;
        }
        // Rows: 255 painted in full, 128 patterned (columns decide), 0 left alone.
        const rows = new Uint8Array(h * 4);
        let ystat = ty ? 0 : 1;
        let yp = ty > 0 ? Math.trunc((h % ty) / 2) : 0;
        for (let j = 0; j < h; j++) {
            if (ty && ++yp >= ty) {
                ystat = ystat ? 0 : 1;
                yp = 0;
            }
            rows[j * 4] = !ystat ? 255 : tx ? 128 : 0;
        }
        // Columns of a patterned row: runs of tx, the first tx - xos long, painted first.
        const cols = new Uint8Array(w * 4);
        if (tx) {
            const xos = Math.trunc((w % tx) / 2);
            let x = 0;
            let xo = xos;
            let xstat = 0;
            while (x < w) {
                const run = Math.min(w - x, tx - xo);
                xo = 0;
                for (let i = 0; i < run; i++) {
                    cols[(x + i) * 4] = xstat ? 0 : 255;
                }
                x += run;
                xstat = xstat ? 0 : 1;
            }
        }
        this.rows = this.upload(this.rows, rows, h);
        this.cols = this.upload(this.cols, cols, w);
        this.program.run(this.parent.getTSM(), { cols: this.cols, rows: this.rows, scale, size: [w, h] });
    }

    public destroy() {
        super.destroy();
        const gl = this.main.getRctx().getGl();
        for (const texture of [this.rows, this.cols]) {
            if (texture) {
                gl.deleteTexture(texture);
            }
        }
        if (this.program) {
            this.program.destroy();
        }
    }

    private upload(texture: WebGLTexture, data: Uint8Array, length: number): WebGLTexture {
        const gl = this.main.getRctx().getGl();
        if (!texture) {
            texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, texture);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return texture;
    }
}

/** The source pixel in AVS's whole levels, 0…255 per channel. */
const LEVELS = "vec3 v = floor(getSrcColor().rgb * 255.0 + 0.5);";

/** A multiplier as AVS computes it: up by doubling with saturation (paddusb), down by shifting. */
function scaleLevels(scale: number): string {
    if (scale >= 1) return `v = min(v * ${float(scale)}, vec3(255.0));`;
    return `v = floor(v * ${float(scale)});`;
}

/**
 * Fast Brightness (r_fastbright.cpp): ×2 saturating, ×½ by a shift (rounded down), or nothing.
 * webvsc gives the factor itself — 2, 0.5 or 1 — which was read as AVS's mode index before, so
 * ×2 did nothing and "nothing" halved the picture.
 */
export const FastBrightness = shaderEffect("FastBrightness", (opts) => {
    const label = String(opts.factor ?? "").toUpperCase();
    const number = Number(label);
    const scale = Number.isFinite(number) && label !== ""
        ? number
        : label.indexOf("HALF") >= 0 ? 0.5 : label.indexOf("NONE") >= 0 ? 1 : 2;
    return `void main() { ${LEVELS} ${scaleLevels(scale === 0.5 ? 0.5 : scale === 1 ? 1 : 2)} setFragColor(vec4(v / 255.0, 1.0)); }`;
});

/**
 * Multiplier (r_multiplier.cpp): ×8, ×4, ×2 saturate per channel, ×½, ×¼, ×⅛ shift; "infinite
 * root" turns every pixel that is not black into white and "infinite square" every pixel that is
 * not pure white into black — whole pixels, not channels. Those two loops leave pixel 0 (the
 * top-left one) as it was.
 */
export const Multiplier = shaderEffect("Multiplier", (opts) => {
    const mode = String(opts.multiply ?? "").toUpperCase();
    const infinite = mode.indexOf("ROOT") >= 0 ? "root" : mode.indexOf("SQUARE") >= 0 ? "square" : "";
    let body: string;
    if (infinite === "root") body = "v = any(greaterThan(v, vec3(0.0))) ? vec3(255.0) : vec3(0.0);";
    else if (infinite === "square") body = "v = all(equal(v, vec3(255.0))) ? vec3(255.0) : vec3(0.0);";
    else body = scaleLevels(Number(/([\d.]+)/.exec(mode)?.[1] ?? 2) || 2);
    const firstPixel = infinite
        ? "if (gl_FragCoord.x < 1.0 && gl_FragCoord.y > u_resolution.y - 1.0) { setFragColor(getSrcColor()); return; }"
        : "";
    return `void main() { ${firstPixel} ${LEVELS} ${body} setFragColor(vec4(v / 255.0, 1.0)); }`;
});

export const AVSTransAutomation = quiet("AVSTransAutomation", "misc");

/**
 * The VFX Framerate Limiter APE (vis_avs e_frameratelimiter.cpp): AVS slept until 1000/limit ms
 * (whole ms) had passed since the limiter's last frame, so the preset ran at most `limit` frames a
 * second — and a preset that moves a step a frame moved at that pace. Here the visualizer's frame
 * clock waits instead (avs/index.ts reads `avsFrameInterval`, which Main clears every frame): only
 * a limiter that ran this frame holds the next one back, as AVS's sleep did.
 */
export class FramerateLimiter extends Component {
    public static componentName: string = "FramerateLimiter";
    public static componentTag: string = "misc";
    public init() { /* nothing to prepare */ }
    public draw() {
        if (this.opts.enabled === false) {
            return;
        }
        const limit = Math.trunc(Number(this.opts.limit));
        if (!(limit > 0)) {
            return;
        }
        const main = this.main as any;
        main.avsFrameInterval = Math.max(Number(main.avsFrameInterval) || 0, Math.trunc(1000 / limit));
    }
}

/** Jheriko's Global Variables APE: code with no picture, for the registers. */
export class GlobalVariables extends GlobalVar {
    public static componentName: string = "GlobalVariables";
    public static componentTag: string = "misc";

    public init() {
        // AVS names the variables file with ten draws of rand() (e_globalvariables.cpp).
        skipCRand(10);
        super.init();
    }
}

/**
 * Dynamic Distance Modifier: the code gets each pixel's distance from the
 * centre as d (1 at a corner) and returns a new one; the pixel is taken from
 * that distance in the same direction.
 */
/** Dynamic Distance Modifier on a Dynamic Movement grid: DistanceModifier.ts's fallback. */
export class GridDistanceModifier extends CpuDynamicMovement {
    public static componentName: string = "GridDistanceModifier";
    public static componentTag: string = "trans";

    constructor(main, parent, opts) {
        const code = (opts && opts.code) || {};
        const user = String(code.perPoint || "").replace(/[\s;]+$/, "");
        const perPixel = [
            "ddm__a=w/h",
            "ddm__o=sqrt(sqr(x*ddm__a)+sqr(y))/sqrt(sqr(ddm__a)+1)",
            "d=ddm__o",
            user,
            "ddm__s=if(above(ddm__o,0.00001),d/ddm__o,1)",
            "x=x*ddm__s",
            "y=y*ddm__s",
        ].filter(Boolean).join(";\n");
        super(main, parent, {
            id: opts.id,
            enabled: opts.enabled,
            code: { init: code.init || "", perFrame: code.perFrame || "", onBeat: code.onBeat || "", perPixel },
            coord: "RECT",
            bFilter: opts.bilinear !== false,
            blend: simpleBlend(opts.blendMode) === "AVERAGE",
            averageBlend: true,
            gridW: 64,
            gridH: 48,
            compat: false,
            noGrid: false,
            wrap: false,
        });
    }
}
