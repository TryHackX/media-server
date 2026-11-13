// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * AVS render effects webvs never had, rebuilt as SuperScope configurations.
 *
 * In many presets one of these is the only thing that draws; without it every
 * effect after it worked on a black frame and the preset showed nothing.
 * Starfield and Dot Plane are ported from vis_avs; FyrewurX (an APE without published source) is a
 * re-creation of what it looks like, with dice of its own, for builds without the port of the plug-in
 * in vendor/avs-apes (which then runs instead, apeHost.ts). (Simple and Ring are ports of
 * r_simple.cpp and r_oscring.cpp now, in Classic.ts.)
 */
import { fromBase64Config } from "../ape/config";
import { avsVisdata } from "../avsDraw";
import { cRand } from "../avsRandom";
import Component from "../Component";
import { avsBlend, BlendMode, parseColorNorm, WebGLVarType } from "../utils";
import Buffer from "../webgl/Buffer";
import ShaderProgram from "../webgl/ShaderProgram";
import SuperScope from "./SuperScope";

/**
 * Starfield, after vis_avs r_stars.cpp: stars fly from depth 255 towards the
 * viewer, each at its own speed, brighter (and more of the chosen colour) as
 * they come closer; a beat can kick the warp speed, which settles back over
 * `durFrames` frames. Run in a window of AVS's size and drawn scaled up, so
 * the field looks as dense as it did in AVS's small window.
 */
export class Starfield extends Component {
    public static componentName: string = "Starfield";
    public static componentTag: string = "render";

    private program: ShaderProgram;
    private points: Buffer;
    private colors: Buffer;
    private stars: Float32Array;
    private count: number;
    private width: number;
    private height: number;
    private speed: number;
    private step: number;
    private beatFrames: number;

    public init() {
        const rctx = this.main.getRctx();
        this.points = new Buffer(rctx);
        this.colors = new Buffer(rctx);
        this.width = 0;
        this.height = 0;
        this.speed = this.warp();
        this.step = 0;
        this.beatFrames = 0;
        this.program = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    colors: { name: "a_color", size: 3 },
                    points: { name: "a_position" },
                },
                uniforms: { size: { name: "u_pointSize", valueType: WebGLVarType._1F } },
            },
            blendMode: BlendMode[avsBlend(this.opts.blendMode)] ?? BlendMode.REPLACE,
            copyOnSwap: true,
            // gl.POINTS is 0, which webvs takes for "no draw mode": drawn here.
            drawHook: (values, gl) => {
                gl.drawArrays(gl.POINTS, 0, values.count);
            },
            fragmentShader: `
                varying vec3 v_color;
                void main() {
                    setFragColor(vec4(v_color, 1.0));
                }
            `,
            vertexShader: `
                attribute vec2 a_position;
                attribute vec3 a_color;
                uniform float u_pointSize;
                varying vec3 v_color;
                void main() {
                    gl_PointSize = u_pointSize;
                    setPosition(a_position);
                    v_color = a_color;
                }
            `,
        });
    }

    public draw() {
        const opts = this.opts;
        const gl = this.main.getRctx().getGl();
        // AVS's window was about 512×384; the field runs at that size.
        const scale = Math.max(1, gl.drawingBufferHeight / 384);
        const width = Math.max(16, Math.round(gl.drawingBufferWidth / scale));
        const height = Math.max(16, Math.round(gl.drawingBufferHeight / scale));
        if (width !== this.width || height !== this.height) {
            this.width = width;
            this.height = height;
            this.populate();
        }
        if (Number(opts.onbeat) && this.main.getAnalyser().isBeat()) {
            const duration = Math.max(1, Number(opts.durFrames) || 1);
            // r_stars.cpp's floats (CurrentSpeed, incBeat), its sums in x87 doubles.
            this.speed = Math.fround(Number(opts.spdBeat) || this.warp());
            this.step = Math.fround((this.warp() - this.speed) / duration);
            this.beatFrames = duration;
        }
        const stars = this.stars;
        const count = this.count;
        const halfW = Math.floor(width / 2);
        const halfH = Math.floor(height / 2);
        const [cr, cg, cb] = parseColorNorm(opts.color || "#ffffff");
        const white = cr === 1 && cg === 1 && cb === 1;
        // A coloured field: r_stars.cpp's BLEND_ADAPT, top nibbles of the grey and the colour
        // weighed by the grey's top nibble (16 steps, up to 240).
        const nibbles = [cr, cg, cb].map((value) => (Math.round(value * 255) >> 4) & 15);
        const points = new Float32Array(count * 2);
        const colors = new Float32Array(count * 3);
        let drawn = 0;
        for (let index = 0; index < count; index++) {
            const s = index * 4;
            const z = Math.trunc(stars[s + 2]);
            if (z > 0) {
                const nx = Math.trunc((stars[s] * 128) / z) + halfW;
                const ny = Math.trunc((stars[s + 1] * 128) / z) + halfH;
                if (nx > 0 && nx < width && ny > 0 && ny < height) {
                    const level = Math.max(0, Math.min(255, Math.trunc((255 - z) * stars[s + 3])));
                    points[drawn * 2] = ((nx + 0.5) / width) * 2 - 1;
                    points[drawn * 2 + 1] = 1 - ((ny + 0.5) / height) * 2;
                    if (white) {
                        colors[drawn * 3] = colors[drawn * 3 + 1] = colors[drawn * 3 + 2] = level / 255;
                    } else {
                        const weight = level >> 4;
                        const grey = (level >> 4) * (16 - weight);
                        colors[drawn * 3] = (grey + nibbles[0] * weight) / 255;
                        colors[drawn * 3 + 1] = (grey + nibbles[1] * weight) / 255;
                        colors[drawn * 3 + 2] = (grey + nibbles[2] * weight) / 255;
                    }
                    drawn++;
                    stars[s + 2] -= stars[s + 3] * this.speed;
                    continue;
                }
            }
            this.respawn(s);
        }
        if (this.beatFrames > 0) {
            this.speed = Math.fround(Math.max(0, this.speed + this.step));
            this.beatFrames--;
        } else {
            this.speed = this.warp();
        }
        if (drawn === 0) {
            return;
        }
        this.points.setData(points.subarray(0, drawn * 2));
        this.colors.setData(colors.subarray(0, drawn * 3));
        this.program.run(this.parent.getTSM(), { points: this.points, colors: this.colors, size: Math.round(scale), count: drawn });
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        this.points.destroy();
        this.colors.destroy();
    }

    private warp(): number {
        return Number(this.opts.WarpSpeed) || 6;
    }

    private populate() {
        const wanted = Number(this.opts.MaxStars_set) || 350;
        // MulDiv(stars, w·h, 512·384): rounded to the nearest, as r_stars.cpp counted them.
        this.count = Math.min(4095, Math.floor((wanted * this.width * this.height + 98304) / (512 * 384)));
        this.stars = new Float32Array(this.count * 4);
        for (let index = 0; index < this.count; index++) {
            const s = index * 4;
            this.respawn(s);
            this.stars[s + 2] = cRand() % 255;
            this.stars[s + 3] = ((cRand() % 9) + 1) / 10;
        }
    }

    private respawn(s: number) {
        this.stars[s] = (cRand() % this.width) - Math.floor(this.width / 2);
        this.stars[s + 1] = (cRand() % this.height) - Math.floor(this.height / 2);
        this.stars[s + 2] = 255;
    }
}

/**
 * FyrewurX (FunkyFX's APE): a re-creation, a burst of dots on every beat, used when vendor/avs-apes
 * has no port of the plug-in. Its dice are its own (a small LCG in the code, `sd`): an APE is a DLL
 * apart (the plug-in links its own C runtime), and rand() in code draws from the C generator AVS's
 * effects share (avsRandom.ts), which put every Moving Particle, Starfield and rand() after a
 * FyrewurX out of step with AVS.
 */
export class FyrewurX extends SuperScope {
    public static componentName: string = "FyrewurX";
    public static componentTag: string = "render";

    constructor(main, parent, opts) {
        super(main, parent, {
            id: opts.id,
            // The converter keeps the plug-in's bytes: int32 "enabled", then the colour.
            enabled: opts.config !== undefined ? fyrewurxEnabled(opts.config) : opts.enabled,
            colors: ["#ffcc66"],
            drawMode: "DOTS",
            code: {
                init: "n=220; t=1; cx=0; cy=0; hue=0; sd=1",
                perFrame: "t=t+0.02",
                onBeat: "t=0; sd=(sd*75+74)%65537; cx=sd*1.6/65537-0.8; sd=(sd*75+74)%65537; cy=sd*1.2/65537-0.6;"
                    + " sd=(sd*75+74)%65537; hue=sd/65537",
                perPoint: "a=i*$PI*2*37.7; sp=0.4+0.6*abs(sin(i*91.7)); rr=t*sp*0.9; x=cx+sin(a)*rr; y=cy+cos(a)*rr+t*t*0.35;"
                    + " fade=max(0,1-t*0.9); red=fade; green=fade*(0.4+0.5*hue); blue=fade*(1-hue)*0.6;",
            },
        });
    }
}

/** The plug-in's "enabled" (load_config: the first int32, when there are 4 bytes). */
function fyrewurxEnabled(config): boolean {
    const bytes = fromBase64Config(config);
    return bytes.length < 4 || (bytes[0] | bytes[1] | bytes[2] | bytes[3]) !== 0;
}

/**
 * Dot Plane, after Nullsoft's vis_avs r_dotpln.cpp: a 64 × 64 field of dots
 * seen in perspective. Every frame the front row takes the spectrum (the
 * highest of each three bins) and each row hands its heights one row back,
 * with a velocity pulled down by gravity, so peaks roll away over the plane.
 * A dot keeps the colour of the height it was born with, in 64 steps between
 * five colours; the plane turns by rotationSpeed / 5 degrees a frame and is
 * tilted by `angle`. Dots are single pixels drawn with the line blend mode
 * (Set Render Mode), far rows first.
 */
const PLANE = 64;

export class DotPlane extends Component {
    public static componentName: string = "DotPlane";
    public static componentTag: string = "render";

    private program: ShaderProgram;
    private points: Buffer;
    private colors: Buffer;
    private heights: Float32Array;
    private speeds: Float32Array;
    private dotColors: Int32Array;
    private colorTable: Int32Array;
    private rotation: number;

    public init() {
        const rctx = this.main.getRctx();
        this.points = new Buffer(rctx);
        this.colors = new Buffer(rctx);
        this.heights = new Float32Array(PLANE * PLANE);
        this.speeds = new Float32Array(PLANE * PLANE);
        this.dotColors = new Int32Array(PLANE * PLANE);
        // The rotation the preset was saved at, ×32 (webvsc read it as padding until 08.11.2026).
        this.rotation = Math.fround((Number(this.opts.rotation ?? this.opts.null0) || 0) / 32);
        // initcolortab(): 16 steps from each colour to the next, in 16.16 fixed point.
        const keys = ["colorTop", "colorHigh", "colorMid", "colorLow", "colorBottom"];
        const colors = keys.map((key) => parseColorNorm(this.opts[key] || "#000000").map((c) => Math.round(c * 255)));
        this.colorTable = new Int32Array(PLANE * 3);
        for (let t = 0; t < 4; t++) {
            for (let c = 0; c < 3; c++) {
                let value = colors[t][c] << 16;
                const delta = Math.trunc(((colors[t + 1][c] - colors[t][c]) << 16) / 16);
                for (let x = 0; x < 16; x++) {
                    this.colorTable[(t * 16 + x) * 3 + c] = value >> 16;
                    value += delta;
                }
            }
        }
        this.program = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    colors: { name: "a_color", size: 3 },
                    points: { name: "a_position" },
                },
            },
            copyOnSwap: true,
            dynamicBlend: true,
            drawHook: (values, gl) => {
                gl.drawArrays(gl.POINTS, 0, values.count);
            },
            fragmentShader: `
                varying vec3 v_color;
                void main() {
                    setFragColor(vec4(v_color, 1.0));
                }
            `,
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

    public draw() {
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const f32 = Math.fround;
        const heights = this.heights;
        const speeds = this.speeds;
        const dotColors = this.dotColors;

        // Every row from the one in front of it; the front row from the spectrum.
        const front = Float32Array.from(heights.subarray(0, PLANE));
        // r_dotpln.cpp: the left spectrum's bytes, visdata[0][0].
        const spectrum = avsVisdata(this.main).spectrum[0];
        const level = (index) => spectrum[index] ?? 0;
        for (let fo = 0; fo < PLANE; fo++) {
            const t = (PLANE - (fo + 2)) * PLANE;
            if (fo === PLANE - 1) {
                for (let p = 0; p < PLANE; p++) {
                    let value = Math.max(level(p * 3), level(p * 3 + 1));
                    value = Math.max(value, level(p * 3 + 2));
                    heights[t + PLANE + p] = value;
                    dotColors[t + PLANE + p] = Math.min(63, value >> 2);
                    speeds[t + PLANE + p] = f32((value - front[p]) / 90);
                }
            } else {
                for (let p = 0; p < PLANE; p++) {
                    let value = f32(heights[t + p] + speeds[t + p]);
                    if (value < 0) {
                        value = 0;
                    }
                    heights[t + PLANE + p] = value;
                    speeds[t + PLANE + p] = f32(speeds[t + p] - f32(0.15 * (value / 255)));
                    dotColors[t + PLANE + p] = dotColors[t + p];
                }
            }
        }

        // rotate(2, r), then rotate(1, angle), then translate(0, -20, 400), as AVS multiplies them.
        const rotate = (axis, degrees) => {
            const m = new Float32Array(16);
            const radians = f32(f32(degrees) * f32(3.141592653589 / 180));
            m[((axis - 1) << 2) + axis - 1] = 1;
            m[15] = 1;
            const m1 = axis % 3;
            const m2 = (m1 + 1) % 3;
            const c = f32(Math.cos(radians));
            const s = f32(Math.sin(radians));
            m[(m1 << 2) + m1] = c;
            m[(m1 << 2) + m2] = s;
            m[(m2 << 2) + m2] = c;
            m[(m2 << 2) + m1] = -s;
            return m;
        };
        const multiply = (dest, src) => {
            const temp = Float32Array.from(dest);
            for (let i = 0; i < 16; i += 4) {
                for (let j = 0; j < 4; j++) {
                    dest[i + j] = f32(src[i] * temp[j] + src[i + 1] * temp[4 + j] + src[i + 2] * temp[8 + j] + src[i + 3] * temp[12 + j]);
                }
            }
        };
        const matrix = rotate(2, this.rotation);
        multiply(matrix, rotate(1, Number(this.opts.angle) || 0));
        const translate = new Float32Array(16);
        translate[0] = translate[5] = translate[10] = translate[15] = 1;
        translate[7] = -20;
        translate[11] = 400;
        multiply(matrix, translate);

        let adjust = f32((width * 440) / 640);
        const adjust2 = f32((height * 440) / 480);
        if (adjust2 < adjust) {
            adjust = adjust2;
        }
        const points = new Float32Array(PLANE * PLANE * 2);
        const colors = new Float32Array(PLANE * PLANE * 3);
        let count = 0;
        const r = this.rotation;
        for (let fo = 0; fo < PLANE; fo++) {
            const f = (r < 90 || r > 270) ? PLANE - fo - 1 : fo;
            let dw = f32(350 / PLANE);
            let w = f32(-(PLANE * 0.5) * dw);
            const q = f32((f - PLANE * 0.5) * dw);
            let at = f * PLANE;
            let da = 1;
            if (r < 180) {
                da = -1;
                dw = -dw;
                w = f32(-w + dw);
                at += PLANE - 1;
            }
            for (let p = 0; p < PLANE; p++) {
                const y0 = f32(64 - heights[at]);
                const x = f32(w * matrix[0] + y0 * matrix[1] + q * matrix[2] + matrix[3]);
                const y = f32(w * matrix[4] + y0 * matrix[5] + q * matrix[6] + matrix[7]);
                let z = f32(w * matrix[8] + y0 * matrix[9] + q * matrix[10] + matrix[11]);
                z = f32(adjust / z);
                const ix = Math.trunc(x * z) + Math.trunc(width / 2);
                const iy = Math.trunc(y * z) + Math.trunc(height / 2);
                if (iy >= 0 && iy < height && ix >= 0 && ix < width) {
                    points[count * 2] = ((ix + 0.5) / width) * 2 - 1;
                    points[count * 2 + 1] = 1 - ((iy + 0.5) / height) * 2;
                    const entry = dotColors[at] * 3;
                    colors[count * 3] = this.colorTable[entry] / 255;
                    colors[count * 3 + 1] = this.colorTable[entry + 1] / 255;
                    colors[count * 3 + 2] = this.colorTable[entry + 2] / 255;
                    count++;
                }
                w = f32(w + dw);
                at += da;
            }
        }
        this.rotation = f32(this.rotation + f32((Number(this.opts.rotationSpeed) || 0) / 5));
        if (this.rotation >= 360) {
            this.rotation = f32(this.rotation - 360);
        }
        if (this.rotation < 0) {
            this.rotation = f32(this.rotation + 360);
        }
        if (!count) {
            return;
        }
        this.points.setData(points.subarray(0, count * 2));
        this.colors.setData(colors.subarray(0, count * 3));
        const lineBlend = this.main.avsRenderMode ? this.main.avsRenderMode.blend : "REPLACE";
        this.program.run(this.parent.getTSM(), { colors: this.colors, count, points: this.points },
            BlendMode[avsBlend(lineBlend)] ?? BlendMode.REPLACE);
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        this.points.destroy();
        this.colors.destroy();
    }
}
