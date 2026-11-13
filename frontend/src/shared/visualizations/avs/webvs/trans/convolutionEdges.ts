// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * The edges of a Convolution Filter that runs in place (convolutionCpu.ts) but reads pixels it
 * has already written only there: the GPU's pass over a copy is right everywhere else, and the
 * processor computes the last column and the last two rows as AVS does, from what they read.
 *
 * ConvolutionEdgesGpu (below) does it with two more GPU passes and no read-back; this class, for
 * frames wider than its loop: read() takes, before the GPU pass, the frame's last 8 columns (the
 * edge reads columns w − 5 … w − 1) and row h − 2, as they are; draw(), after it, runs the filter
 * over those pixels in AVS's order (`convolveAvs` with `edgesOnly`) and draws the result over the
 * frame: column w − 1 of the rows above the last two, and the last two rows. FrameTransfer (at
 * the end) moves a whole frame for the recursive kernels.
 */
import { HIGH_PRECISION } from "../avsSupport";
import { WebGLVarType } from "../utils";
import Buffer from "../webgl/Buffer";
import ShaderProgram from "../webgl/ShaderProgram";
import { convolutionGlsl, convolveAvs } from "./convolutionCpu";

const STRIP = 8;

export class ConvolutionEdges {
    private gl: WebGLRenderingContext;
    private program: ShaderProgram;
    private quad: Buffer;
    private texture: WebGLTexture | null = null;
    private width = 0;
    private height = 0;
    /** The frame top row first, only the columns and row read are filled. */
    private frame = new Uint8Array(0);
    private strip = new Uint8Array(0);
    private column = new Uint8Array(0);
    private vertices = new Float32Array(24);

    constructor(rctx) {
        this.gl = rctx.getGl();
        this.quad = new Buffer(rctx);
        this.program = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    quad: { name: "a_position", size: 2 },
                },
                uniforms: {
                    picture: { name: "u_picture", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            drawHook: (values, gl) => {
                gl.drawArrays(gl.TRIANGLES, 0, 12);
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_picture;
                void main() {
                    setFragColor(vec4(texture2D(u_picture, (floor(gl_FragCoord.xy) + 0.5) / u_resolution).rgb, 1.0));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute vec2 a_position;
                void main() {
                    setPosition(a_position);
                }
            `,
        });
    }

    /** Whether the frame is large enough for the generated code's layout. */
    public static fits(width: number, height: number): boolean {
        return width >= STRIP && height >= STRIP;
    }

    /** Before the GPU pass, from the bound frame: its last columns and row h − 2. */
    public read(width: number, height: number) {
        const gl = this.gl;
        if (this.width !== width || this.height !== height) {
            this.width = width;
            this.height = height;
            this.frame = new Uint8Array(width * height * 4);
            this.strip = new Uint8Array(STRIP * height * 4);
            this.column = new Uint8Array(height * 4);
            if (!this.texture) {
                this.texture = gl.createTexture();
            }
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        const frame = this.frame;
        const strip = this.strip;
        const stride = STRIP * 4;
        gl.readPixels(width - STRIP, 0, STRIP, height, gl.RGBA, gl.UNSIGNED_BYTE, strip);
        // GL's row r is the frame's row h − 1 − r.
        for (let r = 0; r < height; r++) {
            frame.set(strip.subarray(r * stride, (r + 1) * stride), ((height - 1 - r) * width + width - STRIP) * 4);
        }
        gl.readPixels(0, 1, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, frame.subarray((height - 2) * width * 4, (height - 1) * width * 4));
    }

    /** After the GPU pass: AVS's last column and last two rows over the frame (the current target). */
    public draw(tsm, plan) {
        const { gl, width, height, frame } = this;
        convolveAvs(plan, frame, frame, width, height, true);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        // Texture rows as GL's: rows 0 and 1 are the frame's last two (h − 1, h − 2).
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, frame.subarray((height - 1) * width * 4, height * width * 4));
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, frame.subarray((height - 2) * width * 4, (height - 1) * width * 4));
        // Column w − 1 of GL rows 2 … h − 1 (the frame's rows h − 3 … 0).
        const column = this.column;
        for (let r = 2; r < height; r++) {
            const from = ((height - 1 - r) * width + width - 1) * 4;
            column.set(frame.subarray(from, from + 4), (r - 2) * 4);
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, width - 1, 2, 1, height - 2, gl.RGBA, gl.UNSIGNED_BYTE, column.subarray(0, (height - 2) * 4));
        const v = this.vertices;
        const split = (2 / height) * 2 - 1;
        const left = ((width - 1) / width) * 2 - 1;
        // The two bottom rows, then the last column above them: two quads.
        v.set([-1, -1, 1, -1, -1, split, -1, split, 1, -1, 1, split,
            left, split, 1, split, left, 1, left, 1, 1, split, 1, 1]);
        this.quad.setData(v);
        this.program.run(tsm, { picture: this.texture, quad: this.quad });
    }

    public destroy() {
        this.program.destroy();
        this.quad.destroy();
        if (this.texture) {
            this.gl.deleteTexture(this.texture);
            this.texture = null;
        }
    }
}

/** Frames up to this wide: the row's recurrence runs as a loop of at most this many steps. */
export const EDGE_LOOP = 16384;

/**
 * The same edges with no read-back (the processor's version above stays for frames wider than
 * EDGE_LOOP). Every edge pixel AVS computes from pixels already written depends on them in a chain
 * the GPU can follow:
 * - row h − 2 reads itself to the left (the rows below clamp to it): a recurrence along the row,
 *   at most three pixels back, not linear (saturation, division, packing), so not a scan. One pass
 *   over a w × 1 texture runs it whole in every fragment — each the same steps along the row as it
 *   was, keeping the step at its own column: w steps a fragment, the other rows not involved;
 * - row h − 1 reads only row h − 2 as computed, and column w − 1 (above them) only pixel w − 2 of
 *   its own row, which the plain filter gives: a second pass draws both, and row h − 2, over the
 *   frame, from the picture as it was (the texture the GPU pass read) and the row.
 */
export class ConvolutionEdgesGpu {
    private gl: WebGLRenderingContext;
    private recurrence: ShaderProgram;
    private patch: ShaderProgram;
    private quad: Buffer;
    private row: WebGLTexture | null = null;
    private rowBuffer: WebGLFramebuffer | null = null;
    private width = 0;
    private vertices = new Float32Array(24);

    constructor(rctx, plan) {
        this.gl = rctx.getGl();
        const f = (n: number) => n.toFixed(1);
        const levels = (texture: string, at: string) => `floor(texture2D(${texture}, ${at}).rgb * 255.0 + 0.5)`;
        // The columns (x − 3) the terms read; at row h − 2 they all read that row.
        const offsets = new Set<number>();
        for (let pass = 0; pass < plan.passes; pass++) {
            const lists = [[plan.posX[pass], plan.posMul[pass]], [plan.negX[pass], plan.negMul[pass]]];
            for (const [xs, muls] of lists) {
                xs.forEach((x, e) => muls[e] && offsets.add(x - 3));
            }
        }
        const tag = (d: number) => (d < 0 ? `m${-d}` : `p${d}`);
        const used = [...offsets].sort((a, b) => a - b);
        // Step k of row h − 2: the value at column clamp(k + d) — computed already (c1…c3) left of
        // k, as it was (o0…o3) from k on; the edges clamp as AVS's code does.
        const pick = used.map((d) => [
            `float col_${tag(d)} = k + ${f(d)};`,
            `col_${tag(d)} = k < 3.0 ? max(col_${tag(d)}, 0.0) : k >= u_resolution.x - 3.0 ? min(col_${tag(d)}, u_resolution.x - 2.0) : col_${tag(d)};`,
            `vec3 s_${tag(d)} = at(col_${tag(d)} - k, c1, c2, c3, o0, o1, o2, o3);`,
        ].join("\n")).join("\n");
        const rowBody = convolutionGlsl(plan, (x) => `s_${tag(x - 3)}`);
        this.recurrence = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    frame: { name: "u_frame", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_frame;
                vec3 original(float col) {
                    return ${levels("u_frame", "vec2((col + 0.5) / u_resolution.x, 1.5 / u_resolution.y)")};
                }
                vec3 at(float d, vec3 c1, vec3 c2, vec3 c3, vec3 o0, vec3 o1, vec3 o2, vec3 o3) {
                    return d < 0.0 ? (d > -1.5 ? c1 : d > -2.5 ? c2 : c3) : (d < 0.5 ? o0 : d < 1.5 ? o1 : d < 2.5 ? o2 : o3);
                }
                vec3 convolve(${used.map((d) => `vec3 s_${tag(d)}`).join(", ")}) {
                    ${rowBody}
                }
                void main() {
                    float i = floor(gl_FragCoord.x);
                    vec3 c1 = vec3(0.0);
                    vec3 c2 = vec3(0.0);
                    vec3 c3 = vec3(0.0);
                    vec3 o0 = original(0.0);
                    vec3 o1 = original(1.0);
                    vec3 o2 = original(2.0);
                    vec3 o3 = original(3.0);
                    vec3 result = vec3(0.0);
                    for (int n = 0; n < ${EDGE_LOOP}; n++) {
                        float k = float(n);
                        if (k >= u_resolution.x) {
                            break;
                        }
                        ${pick}
                        vec3 v = convolve(${used.map((d) => `s_${tag(d)}`).join(", ")});
                        if (k == i) {
                            result = v;
                        }
                        c3 = c2;
                        c2 = c1;
                        c1 = v;
                        o0 = o1;
                        o1 = o2;
                        o2 = o3;
                        o3 = original(k + 4.0);
                    }
                    setFragColor(vec4(result / 255.0, 1.0));
                }
            `,
            swapFrame: false,
        });
        // Frame row r (from the top) is GL row h − 1 − r.
        const source = (col: string, row: string) => levels("u_frame", `vec2((${col} + 0.5) / u_resolution.x, (u_resolution.y - 0.5 - (${row})) / u_resolution.y)`);
        const rowOf = (y: number) => `clamp(j + ${f(y - 3)}, 0.0, u_resolution.y - 2.0)`;
        // Pixel w − 2 of row j, the plain filter (it reads only pixels not yet written).
        const w2Body = convolutionGlsl(plan, (x, y) => source(`min(u_resolution.x + ${f(x - 5)}, u_resolution.x - 2.0)`, rowOf(y)));
        // Pixel w − 1: its own row only at column w − 2 (kernel row 3 has x ≥ 3 there).
        const w1Body = convolutionGlsl(plan, (x, y) => (y === 3 ? "w2v" : source(`min(u_resolution.x + ${f(x - 4)}, u_resolution.x - 2.0)`, rowOf(y))));
        // Row h − 1: every term reads row h − 2, computed (the row texture).
        const bottomBody = convolutionGlsl(plan, (x) => levels("u_row", `vec2((clampColumn(i, i + ${f(x - 3)}) + 0.5) / u_resolution.x, 0.5)`));
        this.patch = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    quad: { name: "a_position", size: 2 },
                },
                uniforms: {
                    frame: { name: "u_frame", valueType: WebGLVarType.TEXTURE2D },
                    row: { name: "u_row", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            drawHook: (values, gl) => {
                gl.drawArrays(gl.TRIANGLES, 0, 12);
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_frame;
                uniform sampler2D u_row;
                float clampColumn(float i, float col) {
                    return i < 3.0 ? max(col, 0.0) : i >= u_resolution.x - 3.0 ? min(col, u_resolution.x - 2.0) : col;
                }
                vec3 pixelW2(float j) {
                    ${w2Body}
                }
                vec3 pixelW1(float j, vec3 w2v) {
                    ${w1Body}
                }
                vec3 bottom(float i) {
                    ${bottomBody}
                }
                void main() {
                    float i = floor(gl_FragCoord.x);
                    float j = u_resolution.y - 1.0 - floor(gl_FragCoord.y);
                    vec3 v;
                    if (j > u_resolution.y - 1.5) {
                        v = bottom(i);
                    } else if (j > u_resolution.y - 2.5) {
                        v = ${levels("u_row", "vec2((i + 0.5) / u_resolution.x, 0.5)")};
                    } else {
                        v = pixelW1(j, pixelW2(j));
                    }
                    setFragColor(vec4(v / 255.0, 1.0));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute vec2 a_position;
                void main() {
                    setPosition(a_position);
                }
            `,
        });
        this.quad = new Buffer(rctx);
    }

    /** Whether the frame suits: the row's recurrence fits the loop. */
    public static fits(width: number, height: number): boolean {
        return width >= STRIP && height >= STRIP && width <= EDGE_LOOP;
    }

    /**
     * After the GPU pass: the edges over the frame (tsm's current target), from `source`, the texture
     * the pass read (the picture as it was).
     */
    public draw(tsm, source: WebGLTexture, width: number, height: number) {
        const gl = this.gl;
        if (this.width !== width) {
            this.width = width;
            if (!this.row) {
                this.row = gl.createTexture();
                this.rowBuffer = gl.createFramebuffer();
            }
            gl.bindTexture(gl.TEXTURE_2D, this.row);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.rowBuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.row, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
        }
        // Row h − 2 into the row texture.
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rowBuffer);
        gl.viewport(0, 0, width, 1);
        this.recurrence.run(null, { frame: source });
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        // The viewport webvs keeps (Main.ts).
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        // The last two rows, then the last column above them.
        const v = this.vertices;
        const split = (2 / height) * 2 - 1;
        const left = ((width - 1) / width) * 2 - 1;
        v.set([-1, -1, 1, -1, -1, split, -1, split, 1, -1, 1, split,
            left, split, 1, split, left, 1, left, 1, 1, split, 1, 1]);
        this.quad.setData(v);
        this.patch.run(tsm, { frame: source, row: this.row, quad: this.quad });
    }

    public destroy() {
        this.recurrence.destroy();
        this.patch.destroy();
        this.quad.destroy();
        if (this.row) {
            this.gl.deleteTexture(this.row);
            this.gl.deleteFramebuffer(this.rowBuffer);
            this.row = null;
            this.rowBuffer = null;
        }
    }
}

/**
 * A frame for the filter on the processor (Convolution.ts "frame"), read back and sent back as GL
 * keeps it — bottom row first, into and from the WebAssembly module's memory — when no other
 * effect shares it (the frame run, cpuFrameRun.ts, keeps its frame top row first: a flip and two
 * copies more).
 */
export class FrameTransfer {
    private gl: WebGLRenderingContext;
    private program: ShaderProgram;
    private texture: WebGLTexture | null = null;
    private size = "";

    constructor(rctx) {
        this.gl = rctx.getGl();
        this.program = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    picture: { name: "u_picture", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_picture;
                void main() {
                    setFragColor(vec4(texture2D(u_picture, (floor(gl_FragCoord.xy) + 0.5) / u_resolution).rgb, 1.0));
                }
            `,
            swapFrame: true,
        });
    }

    /** The bound frame into `view` (width · height · 4 bytes). */
    public read(view: Uint8Array, width: number, height: number) {
        const gl = this.gl;
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, view);
    }

    /** `view` as tsm's next frame. */
    public write(tsm, view: Uint8Array, width: number, height: number) {
        const gl = this.gl;
        const size = `${width}x${height}`;
        if (!this.texture) {
            this.texture = gl.createTexture();
        }
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        if (this.size !== size) {
            this.size = size;
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, view);
        }
        this.program.run(tsm, { picture: this.texture });
    }

    public destroy() {
        this.program.destroy();
        if (this.texture) {
            this.gl.deleteTexture(this.texture);
            this.texture = null;
        }
    }
}
