// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * Pixel Shader (GpuEffects.cpp PixelShaderEffect, core/script/EelToMsl.cpp): a per-pixel
 * EEL script on the GPU. The init / frame / beat scripts run on the processor like any
 * AVS code (with b, t, w, h, bass, mid, treb, bpm, beatphase and the extra audio
 * variables set first, as mscopes' scripted effects did); the pixel script is
 * translated to GLSL with mscopes' semantics — eager if/band/bor, x/0 = 0, integer %,
 * auto-created variables — and runs once per pixel with x, y (−1…1 over the long side),
 * d, r, red, green, blue (read and written), w, h. Every other variable it touches is
 * taken from the frame scripts' state, as mscopes snapshotted it into uniforms.
 * Its extra functions: noise(x, y), hsv(h, s, v) → a packed colour, getr/getg/getb,
 * frac, lerp, clamp, smoothstep. getosc, getspec, gettime, megabuf and assign are
 * processor-only: a pixel script using them draws nothing (as in mscopes).
 */
import * as Ast from "../expr/Ast";
import compileExpr from "../expr/compileExpr";
import { parse } from "../../eel";
import { MscopesAudioFrame } from "./audio";
import { AUDIO_VARIABLES, audioVariable } from "./audioVars";
import MscopesEffect from "./base";
import { GLSL_COMMON, PRELUDE } from "./gl";

/** mscopes' default: an audio-reactive plasma folded over the incoming frame. */
const DEFAULT_CODE = {
    init: "",
    perFrame: "speed=2+bass*3;",
    onBeat: "",
    perPixel: "pl=0.5+0.5*sin(10*d - t*speed + noise(x*3+t, y*3)*2);"
        + "c=hsv(frac(pl*0.5 + t*0.05), 0.8, pl);"
        + "red=red*0.35 + getr(c);"
        + "green=green*0.35 + getg(c);"
        + "blue=blue*0.35 + getb(c);",
};

const PIXEL_VARIABLES = ["x", "y", "d", "r", "red", "green", "blue", "w", "h"];

const HELPERS = `
float e_trunc(float v) { return v < 0.0 ? -floor(-v) : floor(v); }
float e_div(float a, float b) { return b == 0.0 ? 0.0 : a / b; }
float e_mod(float a, float b) {
    float ib = e_trunc(b);
    if (ib == 0.0) return 0.0;
    float ia = e_trunc(a);
    return ia - ib * e_trunc(ia / ib);
}
float e_if(float c, float t, float f) { return c != 0.0 ? t : f; }
float e_band(float a, float b) { return (a != 0.0 && b != 0.0) ? 1.0 : 0.0; }
float e_bor(float a, float b) { return (a != 0.0 || b != 0.0) ? 1.0 : 0.0; }
float e_bnot(float a) { return a == 0.0 ? 1.0 : 0.0; }
float e_sqr(float a) { return a * a; }
float e_sqrt(float a) { return a <= 0.0 ? 0.0 : sqrt(a); }
float e_asin(float a) { return (a < -1.0 || a > 1.0) ? 0.0 : asin(a); }
float e_acos(float a) { return (a < -1.0 || a > 1.0) ? 0.0 : acos(a); }
float e_log(float a) { return a <= 0.0 ? 0.0 : log(a); }
float e_log10(float a) { return a <= 0.0 ? 0.0 : log(a) / 2.302585093; }
float e_invsqrt(float a) { return a <= 0.0 ? 0.0 : inversesqrt(a); }
float e_sigmoid(float v, float c) { float t = 1.0 + exp(-v * c); return t != 0.0 ? 1.0 / t : 0.0; }
float e_smoothstep(float e0, float e1, float x) {
    if (e0 == e1) return x < e0 ? 0.0 : 1.0;
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
float e_hsv(float hh, float s, float v) {
    float h6 = (hh - floor(hh)) * 6.0;
    float r = clamp(abs(h6 - 3.0) - 1.0, 0.0, 1.0);
    float g = clamp(2.0 - abs(h6 - 2.0), 0.0, 1.0);
    float b = clamp(2.0 - abs(h6 - 4.0), 0.0, 1.0);
    float qr = floor(clamp(v * (1.0 + s * (r - 1.0)), 0.0, 1.0) * 255.0 + 0.5);
    float qg = floor(clamp(v * (1.0 + s * (g - 1.0)), 0.0, 1.0) * 255.0 + 0.5);
    float qb = floor(clamp(v * (1.0 + s * (b - 1.0)), 0.0, 1.0) * 255.0 + 0.5);
    return qr * 65536.0 + qg * 256.0 + qb;
}
float e_getr(float c) { return mod(floor(e_trunc(c) / 65536.0), 256.0) / 255.0; }
float e_getg(float c) { return mod(floor(e_trunc(c) / 256.0), 256.0) / 255.0; }
float e_getb(float c) { return mod(e_trunc(c), 256.0) / 255.0; }
float e_bits(float a, float b, bool both) {
    float x = floor(abs(a)), y = floor(abs(b)), result = 0.0, bit = 1.0;
    for (int i = 0; i < 24; i++) {
        float p = mod(x, 2.0), q = mod(y, 2.0);
        if (both ? (p > 0.5 && q > 0.5) : (p > 0.5 || q > 0.5)) result += bit;
        x = floor(x * 0.5);
        y = floor(y * 0.5);
        bit *= 2.0;
    }
    return result;
}
`;

function literal(value: number): string {
    if (!Number.isFinite(value)) {
        return "0.0";
    }
    const text = String(value);
    return /[.e]/i.test(text) ? text : `${text}.0`;
}

/** The pixel script as GLSL, or an error (EelToMsl.cpp transpileToMsl). */
export function transpilePixelScript(source: string): { glsl: string; names: string[] } {
    const program = parse(source);
    const names: string[] = [];
    const nameOf = (name: string): string => {
        const lower = name.toLowerCase();
        if (PIXEL_VARIABLES.indexOf(lower) >= 0) {
            return "p_" + lower;
        }
        let index = names.indexOf(lower);
        if (index < 0) {
            names.push(lower);
            index = names.length - 1;
        }
        return "s_" + index;
    };
    const unsupported = (what: string) => {
        throw new Error(`${what} is not supported in pixel scripts`);
    };
    const emit = (node): string => {
        if (node instanceof Ast.PrimaryExpr) {
            switch (node.type) {
                case Ast.PrimaryExprType.VALUE: return literal(Number(node.value));
                case Ast.PrimaryExprType.CONST: return literal(node.value === "pi" ? Math.PI : node.value === "e" ? Math.E : 1.6180339887);
                default: return nameOf(String(node.value));
            }
        }
        if (node instanceof Ast.Assignment) {
            return `(${nameOf(String(node.lhs.value))} = ${emit(node.expr)})`;
        }
        if (node instanceof Ast.UnaryExpr) {
            return node.operator === "-" ? `(-${emit(node.operand)})` : emit(node.operand);
        }
        if (node instanceof Ast.BinaryExpr) {
            const a = emit(node.leftOperand), b = emit(node.rightOperand);
            switch (node.operator) {
                case "+": case "-": case "*": return `(${a} ${node.operator} ${b})`;
                case "/": return `e_div(${a}, ${b})`;
                case "%": return `e_mod(${a}, ${b})`;
                case "&": return `e_bits(${a}, ${b}, true)`;
                case "|": return `e_bits(${a}, ${b}, false)`;
                default: return unsupported(`operator ${node.operator}`);
            }
        }
        if (node instanceof Ast.FuncCall) {
            const args = node.args.map(emit);
            const [a, b, c] = args;
            const need = (count: number) => {
                if (args.length !== count) {
                    throw new Error(`${node.funcName} takes ${count} arguments`);
                }
            };
            switch (node.funcName) {
                case "sin": case "cos": case "tan": case "exp": case "floor": case "ceil": case "sign": case "abs":
                    need(1); return `${node.funcName}(${a})`;
                case "atan": need(1); return `atan(${a})`;
                case "asin": need(1); return `e_asin(${a})`;
                case "acos": need(1); return `e_acos(${a})`;
                case "atan2": need(2); return `atan(${a}, ${b})`;
                case "sqr": need(1); return `e_sqr(${a})`;
                case "sqrt": need(1); return `e_sqrt(${a})`;
                case "pow": need(2); return `pow(${a}, ${b})`;
                case "log": need(1); return `e_log(${a})`;
                case "log10": need(1); return `e_log10(${a})`;
                case "min": case "max": need(2); return `${node.funcName}(${a}, ${b})`;
                case "rand": need(1); return `e_rand(${a}, g)`;
                case "invsqrt": need(1); return `e_invsqrt(${a})`;
                case "sigmoid": need(2); return `e_sigmoid(${a}, ${b})`;
                case "band": need(2); return `e_band(${a}, ${b})`;
                case "bor": need(2); return `e_bor(${a}, ${b})`;
                case "bnot": need(1); return `e_bnot(${a})`;
                case "if": need(3); return `e_if(${a}, ${b}, ${c})`;
                case "equal": need(2); return `((${a} == ${b}) ? 1.0 : 0.0)`;
                case "above": need(2); return `((${a} > ${b}) ? 1.0 : 0.0)`;
                case "below": need(2); return `((${a} < ${b}) ? 1.0 : 0.0)`;
                case "exec2": case "exec3": case "execn": return `(${args.join(", ")})`;
                case "lerp": need(3); return `mix(${a}, ${b}, ${c})`;
                case "clamp": need(3); return `clamp(${a}, ${b}, ${c})`;
                case "frac": need(1); return `fract(${a})`;
                case "smoothstep": need(3); return `e_smoothstep(${a}, ${b}, ${c})`;
                case "noise": need(2); return `shNoise(${a}, ${b})`;
                case "hsv": need(3); return `e_hsv(${a}, ${b}, ${c})`;
                case "getr": need(1); return `e_getr(${a})`;
                case "getg": need(1); return `e_getg(${a})`;
                case "getb": need(1); return `e_getb(${a})`;
                default: return unsupported(`${node.funcName}()`);
            }
        }
        return unsupported("this syntax");
    };
    const body = program.statements.map((statement) => `    ${emit(statement)};\n`).join("");
    const locals = names.map((_, index) => `    float s_${index} = u_vars[${index}];\n`).join("");
    const glsl = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec2 u_scale;
uniform float u_seed;
uniform float u_vars[${Math.max(1, names.length)}];
${GLSL_COMMON}
${HELPERS}
float e_rand(float m, vec2 g) {
    float v = shHash(g.x + u_seed * 13.7, g.y + u_seed * 7.3);
    return m < 1.0 ? v : floor(v * m);
}
void main() {
    vec2 g = floor(gl_FragCoord.xy);
    float p_w = u_size.x, p_h = u_size.y;
    float p_x = (g.x + 0.5 - p_w * 0.5) / u_scale.x;
    float p_y = (g.y + 0.5 - p_h * 0.5) / u_scale.y;
    float p_d = sqrt(p_x * p_x + p_y * p_y) * 0.70710678;
    float p_r = atan(p_y, p_x) + 1.57079633;
    vec4 c_in = texture2D(u_src, (g + 0.5) / u_size);
    float p_red = c_in.r, p_green = c_in.g, p_blue = c_in.b;
${locals}${body}    gl_FragColor = vec4(clamp(p_red, 0.0, 1.0), clamp(p_green, 0.0, 1.0), clamp(p_blue, 0.0, 1.0), 1.0);
}`;
    return { glsl, names };
}

/** Names a script assigns (Program::assigns): `name = …`, `name += …`, assign(name, …). */
function assignedNames(source: string): Set<string> {
    const found = new Set<string>();
    if (!source || !source.trim()) {
        return found;
    }
    let program;
    try {
        program = parse(source);
    } catch (error) {
        return found;
    }
    const visit = (node) => {
        if (!node) {
            return;
        }
        if (node instanceof Ast.Assignment) {
            found.add(String(node.lhs.value).toLowerCase());
            visit(node.expr);
        } else if (node instanceof Ast.BinaryExpr) {
            visit(node.leftOperand);
            visit(node.rightOperand);
        } else if (node instanceof Ast.UnaryExpr) {
            visit(node.operand);
        } else if (node instanceof Ast.FuncCall) {
            if (node.funcName === "assign" && node.args[0] instanceof Ast.PrimaryExpr) {
                found.add(String(node.args[0].value).toLowerCase());
            }
            node.args.forEach(visit);
        }
    };
    program.statements.forEach(visit);
    return found;
}

export class MscopesPixelShader extends MscopesEffect {
    public static componentName = "MscopesPixelShader";
    private code;
    private inited: boolean;
    private shaderSource: string;
    private names: string[];
    private values: Float32Array;
    private own: Set<string>;
    private frameSeed: number;

    protected setup() {
        const given = this.opts.code || {};
        const pick = (...keys) => {
            for (const key of keys) {
                if (typeof given[key] === "string") {
                    return given[key];
                }
            }
            return undefined;
        };
        const hasCode = ["init", "perFrame", "frame", "onBeat", "beat", "perPixel", "point"].some((key) => typeof given[key] === "string");
        const scripts = hasCode
            ? { init: pick("init") || "", perFrame: pick("perFrame", "frame") || "", onBeat: pick("onBeat", "beat") || "", perPixel: pick("perPixel", "point") || "" }
            : DEFAULT_CODE;
        this.code = compileExpr({ init: scripts.init, perFrame: scripts.perFrame, onBeat: scripts.onBeat }, ["init", "perFrame", "onBeat"]).codeInst;
        this.code.setup(this.main);
        this.inited = false;
        this.frameSeed = 1;
        this.own = new Set();
        for (const script of [scripts.init, scripts.perFrame, scripts.onBeat, scripts.perPixel]) {
            for (const name of assignedNames(script)) {
                this.own.add(name);
            }
        }
        try {
            const { glsl, names } = transpilePixelScript(scripts.perPixel);
            this.shaderSource = glsl;
            this.names = names;
            this.values = new Float32Array(Math.max(1, names.length));
        } catch (error) {
            // As mscopes: a script that cannot run per pixel leaves the frame alone.
            console.warn("mscopes pixel shader:", error);
            this.shaderSource = null;
            this.names = [];
        }
    }

    protected render(audio: MscopesAudioFrame) {
        const code = this.code;
        const W = this.width(), H = this.height();
        code.t = this.host.time;
        code.w = W;
        code.h = H;
        code.b = audio.beat ? 1 : 0;
        code.bass = audio.bass;
        code.mid = audio.mid;
        code.treb = audio.treble;
        code.bpm = audio.bpm;
        code.beatphase = audio.beatPhase;
        for (const name of AUDIO_VARIABLES) {
            if (!this.own.has(name)) {
                code[name] = audioVariable(audio, name);
            }
        }
        if (!this.inited) {
            code.init();
            this.inited = true;
        }
        if (audio.beat) {
            code.onBeat();
        }
        code.perFrame();
        if (!this.shaderSource) {
            return;
        }
        const bank = this.main.getRegisterBank();
        this.names.forEach((name, index) => {
            const value = /^reg\d\d$/.test(name) ? bank[name] : code[name];
            this.values[index] = Number.isFinite(value) ? value : 0;
        });
        const seed = this.frameSeed++ % 65536;
        // mscopes' "fill" aspect (the app's default): x and y share the long side's scale.
        const scale = Math.max(W, H) * 0.5;
        let program;
        try {
            program = this.program("k", this.shaderSource);
        } catch (error) {
            console.warn("mscopes pixel shader:", error);
            this.shaderSource = null;
            return;
        }
        this.pass(program, (p) => p.f("u_scale", scale, scale).f("u_seed", seed).fv("u_vars", this.values), false);
    }
}
