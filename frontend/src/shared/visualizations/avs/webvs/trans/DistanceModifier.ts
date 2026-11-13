// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Dynamic Distance Modifier, after Nullsoft's vis_avs r_ddm.cpp (BSD licence, see
 * ../LICENSE-vis_avs.txt).
 *
 * Every frame the code runs once per whole distance from the centre (d = 0…1)
 * and AVS keeps how much each distance is scaled, in 8.8 fixed point. Every
 * pixel then looks up its distance — through AVS's own approximate integer
 * square root (a 256-entry table, so far from the centre the distance comes in
 * steps of 2 or 4 pixels: the rings these presets show) of x² − x + y² + 256 —
 * and takes its colour from that scale times its offset, bilinear (BLEND4) or
 * nearest, 50/50 over the frame if asked.
 *
 * The pixel → distance step depends only on the screen size and is a texture
 * built once; the scale per distance is a small texture uploaded every frame.
 * Without float textures the older Dynamic Movement approximation runs instead.
 */
import Component from "../Component";
import compileExpr from "../expr/compileExpr";
import { avsBlend4Glsl, HIGH_PRECISION, simpleBlend } from "../avsSupport";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { GridDistanceModifier } from "./Extras";

const SQ_TABLE = Uint8Array.from((
    "0,16,22,27,32,35,39,42,45,48,50,53,55,57,59,61,64,65,67,69,71,73,75,76,78,80,81,83,84,86,87,89,"
    + "90,91,93,94,96,97,98,99,101,102,103,104,106,107,108,109,110,112,113,114,115,116,117,118,119,120,"
    + "121,122,123,124,125,126,128,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,"
    + "144,145,146,147,148,149,150,150,151,152,153,154,155,155,156,157,158,159,160,160,161,162,163,163,"
    + "164,165,166,167,167,168,169,170,170,171,172,173,173,174,175,176,176,177,178,178,179,180,181,181,"
    + "182,183,183,184,185,185,186,187,187,188,189,189,190,191,192,192,193,193,194,195,195,196,197,197,"
    + "198,199,199,200,201,201,202,203,203,204,204,205,206,206,207,208,208,209,209,210,211,211,212,212,"
    + "213,214,214,215,215,216,217,217,218,218,219,219,220,221,221,222,222,223,224,224,225,225,226,226,"
    + "227,227,228,229,229,230,230,231,231,232,232,233,234,234,235,235,236,236,237,237,238,238,239,240,"
    + "240,241,241,242,242,243,243,244,244,245,245,246,246,247,247,248,248,249,249,250,250,251,251,252,"
    + "252,253,253,254,254,255"
).split(",").map(Number));

/** r_ddm.cpp's isqrt: eight significant bits from the table, the rest a power of two. */
export function avsIsqrt(n: number): number {
    if (n >= 0x10000) {
        if (n >= 0x1000000) {
            if (n >= 0x10000000) {
                return n >= 0x40000000 ? SQ_TABLE[n >>> 24] << 8 : SQ_TABLE[n >>> 22] << 7;
            }
            return n >= 0x4000000 ? SQ_TABLE[n >>> 20] << 6 : SQ_TABLE[n >>> 18] << 5;
        }
        if (n >= 0x100000) {
            return n >= 0x400000 ? SQ_TABLE[n >>> 16] << 4 : SQ_TABLE[n >>> 14] << 3;
        }
        return n >= 0x40000 ? SQ_TABLE[n >>> 12] << 2 : SQ_TABLE[n >>> 10] << 1;
    }
    if (n >= 0x100) {
        if (n >= 0x1000) {
            return n >= 0x4000 ? SQ_TABLE[n >>> 8] : SQ_TABLE[n >>> 6] >> 1;
        }
        return n >= 0x400 ? SQ_TABLE[n >>> 4] >> 2 : SQ_TABLE[n >>> 2] >> 3;
    }
    if (n >= 0x10) {
        return n >= 0x40 ? SQ_TABLE[n] >> 4 : SQ_TABLE[n << 2] << 5;
    }
    return n >= 0x4 ? SQ_TABLE[n >>> 4] << 6 : SQ_TABLE[n >>> 6] << 7;
}

export default class DistanceModifier extends Component {
    public static componentName: string = "DynamicDistanceModifier";
    public static componentTag: string = "trans";

    private fallback: Component;
    private program: ShaderProgram;
    private code: any;
    private inited: boolean;
    private indexTexture: WebGLTexture;
    private indexKey: string;
    private tableTexture: WebGLTexture;
    private table: Float32Array;
    private hasPointCode: boolean;

    public init() {
        const gl = this.main.getRctx().getGl();
        if (!gl.getExtension("OES_texture_float")) {
            this.fallback = new GridDistanceModifier(this.main, this.parent, { ...this.opts, enabled: true });
            return;
        }
        const code = this.opts.code || {};
        this.code = compileExpr(
            { init: code.init || "", onBeat: code.onBeat || "", perFrame: code.perFrame || "", perPoint: code.perPoint || "" },
            ["init", "onBeat", "perFrame", "perPoint"], [], [],
        ).codeInst;
        this.code.setup(this.main);
        this.code.d = 0;
        this.code.b = 0;
        this.inited = false;
        this.hasPointCode = String(code.perPoint || "").trim().length > 0;
        const average = simpleBlend(this.opts.blendMode) === "AVERAGE";
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    index: { name: "u_index", valueType: WebGLVarType.TEXTURE2D },
                    table: { name: "u_table", valueType: WebGLVarType.TEXTURE2D },
                    tableSize: { name: "u_tableSize", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_index;
                uniform sampler2D u_table;
                uniform float u_tableSize;
                ${avsBlend4Glsl()}
                vec3 levelsAt(vec2 pixel) {
                    vec2 uv = (pixel + 0.5) / u_resolution;
                    return floor(texture2D(u_srcTexture, vec2(uv.x, 1.0 - uv.y)).rgb * 255.0 + 0.5);
                }
                void main() {
                    vec2 frag = floor(gl_FragCoord.xy);
                    float row = u_resolution.y - 1.0 - frag.y;
                    float distance = floor(texture2D(u_index, vec2((frag.x + 0.5) / u_resolution.x, (row + 0.5) / u_resolution.y)).r + 0.5);
                    // The scale qd in 8.8 fixed point, as qd = 256·high + low (low 0…255),
                    // so (qd·offset + 128) >> 8 and its low byte stay exact in floats.
                    vec2 scale = texture2D(u_table, vec2((distance + 0.5) / u_tableSize, 0.5)).rg;
                    vec2 centre = floor(u_resolution * 0.5);
                    vec2 offset = vec2(frag.x, row) - centre;
                    vec2 low = scale.y * offset + 128.0;
                    vec2 source = centre + scale.x * offset + floor(low / 256.0);
                    vec2 fraction = low - 256.0 * floor(low / 256.0);
                    vec3 color;
                    ${this.opts.bilinear !== false ? `
                    if (source.x < 0.0) { source.x = 0.0; } else if (source.x >= u_resolution.x - 1.0) { source.x = u_resolution.x - 2.0; }
                    if (source.y < 0.0) { source.y = 0.0; } else if (source.y >= u_resolution.y - 1.0) { source.y = u_resolution.y - 2.0; }
                    color = avsBlend4(levelsAt(source), levelsAt(source + vec2(1.0, 0.0)),
                                      levelsAt(source + vec2(0.0, 1.0)), levelsAt(source + vec2(1.0, 1.0)),
                                      fraction.x, fraction.y);` : `
                    source = clamp(source, vec2(0.0), u_resolution - 1.0);
                    color = levelsAt(source);`}
                    ${average ? "color = floor(color * 0.5) + floor(floor(getSrcColor().rgb * 255.0 + 0.5) * 0.5);" : ""}
                    setFragColor(vec4(color / 255.0, 1.0));
                }`,
            swapFrame: true,
        });
    }

    public draw() {
        if (this.fallback) {
            this.fallback.draw();
            return;
        }
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        if (w < 2 || h < 2) {
            return;
        }
        this.updateIndex(w, h);
        const maxD = Math.sqrt((w * w + h * h) / 4.0);
        let size = Math.trunc(maxD + 32.9);
        if (size < 33) {
            size = 33;
        }
        const code = this.code;
        const beat = this.main.getAnalyser().isBeat();
        code.b = beat ? 1 : 0;
        if (!this.inited) {
            code.init();
            this.inited = true;
        }
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        // The scale of every whole distance, as (int)(d · 256 · max_d / (x + 1)).
        if (!this.table || this.table.length !== size * 4) {
            this.table = new Float32Array(size * 4);
        }
        const table = this.table;
        let previous = 0;
        for (let x = 0; x < size; x++) {
            let scale = 0;
            if (!this.hasPointCode) {
                scale = 0;
            } else if (x < size - 32) {
                code.d = x / (maxD - 1);
                code.perPoint();
                const value = (Number(code.d) * 256.0 * maxD) / (x + 1);
                scale = value > -2147483649 && value < 2147483648 ? Math.trunc(value) : -2147483648;
            } else {
                scale = previous;
            }
            previous = scale;
            const high = Math.floor(scale / 256);
            table[x * 4] = high;
            table[x * 4 + 1] = scale - high * 256;
        }
        if (!this.tableTexture) {
            this.tableTexture = this.floatTexture();
        }
        gl.bindTexture(gl.TEXTURE_2D, this.tableTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, 1, 0, gl.RGBA, gl.FLOAT, table);
        this.program.run(this.parent.getTSM(), {
            index: this.indexTexture,
            table: this.tableTexture,
            tableSize: size,
        });
    }

    public destroy() {
        super.destroy();
        if (this.fallback) {
            this.fallback.destroy();
            return;
        }
        const gl = this.main.getRctx().getGl();
        this.program.destroy();
        for (const texture of [this.indexTexture, this.tableTexture]) {
            if (texture) {
                gl.deleteTexture(texture);
            }
        }
    }

    private floatTexture(): WebGLTexture {
        const gl = this.main.getRctx().getGl();
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    /** Each pixel's distance index, isqrt(x² − x + y² + 256) as AVS walks it. */
    private updateIndex(w: number, h: number) {
        const key = `${w}x${h}`;
        if (this.indexKey === key) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const data = new Float32Array(w * h * 4);
        const halfW = Math.trunc(w / 2);
        const halfH = Math.trunc(h / 2);
        for (let y = 0; y < h; y++) {
            const ty = y - halfH;
            for (let x = 0; x < w; x++) {
                const xx = x - halfW;
                data[(y * w + x) * 4] = avsIsqrt(xx * xx - xx + ty * ty + 256);
            }
        }
        if (!this.indexTexture) {
            this.indexTexture = this.floatTexture();
        }
        gl.bindTexture(gl.TEXTURE_2D, this.indexTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, data);
        this.indexKey = key;
    }
}
