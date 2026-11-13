// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Texer II's resize path on the GPU, with the processor's integer arithmetic (texerParticle.ts):
 * for each particle the processor works out where it goes (`resizeGeometry`) and the bitmap column,
 * row and 8-bit fractions of every column and row it covers (the 16.16 walk, wrapped as an int);
 * a fragment shader then does the per-pixel part — the four taps, ((b·fx) >> 8) + ((a·(fx^255)) >> 8)
 * across, the same down, & 0xffff, × colour & 0xffff >> 8 — on whole numbers below 2^24, which
 * a highp float holds exactly (products and shifts as multiplications and floors by powers of
 * two), and GL's blending puts it on the frame in the particles' order. Only for the line modes
 * GL blends exactly on 8-bit channels (replace, additive, maximum, minimum, both subtractions —
 * Texer II's own formulas for them are the same clamped sums and differences), and only with
 * highp floats in fragment shaders; the rest stays on the processor.
 *
 * The data goes as RGBA8 textures 2048 wide, so a linear index becomes a texel with a power of
 * two: a 24-bit number in RGB and a fraction in A. The bitmap's four variants (as drawn, mirrored,
 * flipped, turned) lie one after another in the same way, so a tap reads it as the processor reads
 * its array: by index, past the row's end into the next row, and 0 past the last pixel.
 *
 * (A test page may set __avsTexerGpu = false to draw on the processor.)
 */
import { WebGLVarType } from "../utils";
import Buffer from "../webgl/Buffer";
import ShaderProgram from "../webgl/ShaderProgram";
import type { ITexture, ResizeGeometry } from "./texerParticle";
import { walkColumns, walkRows } from "./texerParticle";

const WIDTH = 2048;
/** Texels a batch may use in each data texture (2048 × 512); a larger frame draws in batches. */
const CAPACITY = WIDTH * 512;

/** The bitmap's variants for the GPU: index by pixel, `pixels` per variant. */
export interface GpuSprite {
    texture: WebGLTexture;
    pixels: number;
    width: number;
    rows: number;
}

/** Uploads the four variants (normal, mirrored, flipped, rot180) of a Texer II bitmap; null when they
 *  do not fit in a texture (the processor draws then). */
export function gpuSprite(gl: WebGLRenderingContext, variants: ITexture[]): GpuSprite | null {
    const width = variants[0].width;
    const pixels = width * variants[0].height;
    const rows = Math.max(1, Math.ceil((pixels * variants.length) / WIDTH));
    if (rows > gl.getParameter(gl.MAX_TEXTURE_SIZE) || pixels * variants.length >= 1 << 24) {
        return null;
    }
    const data = new Uint8Array(WIDTH * rows * 4);
    variants.forEach((variant, k) => data.set(variant.data.subarray(0, pixels * 4), k * pixels * 4));
    const texture = createDataTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WIDTH, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { pixels, rows, texture, width };
}

function createDataTexture(gl: WebGLRenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
}

/** A growing array of RGBA8 texels: (24-bit value, 8-bit fraction) each. */
class Texels {
    public data = new Uint8Array(WIDTH * 4 * 4);
    public count = 0;

    public reset() {
        this.count = 0;
    }

    public push(value: number, fraction: number) {
        const at = this.count * 4;
        if (at + 4 > this.data.length) {
            const grown = new Uint8Array(Math.min(CAPACITY * 4, this.data.length * 2));
            grown.set(this.data);
            this.data = grown;
        }
        this.data[at] = (value >>> 16) & 255;
        this.data[at + 1] = (value >>> 8) & 255;
        this.data[at + 2] = value & 255;
        this.data[at + 3] = fraction;
        this.count++;
    }

    /** Rows of 2048 used (at least one). */
    public rows(): number {
        return Math.max(1, Math.ceil(this.count / WIDTH));
    }

    public upload(gl: WebGLRenderingContext, texture: WebGLTexture) {
        const rows = this.rows();
        if (this.data.length < WIDTH * rows * 4) {
            const grown = new Uint8Array(WIDTH * rows * 4);
            grown.set(this.data);
            this.data = grown;
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WIDTH, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.data.subarray(0, WIDTH * rows * 4));
    }
}

export class TexerGpu {
    private gl: WebGLRenderingContext;
    private program: ShaderProgram;
    private minmax: any;
    private usable: boolean;
    private vertices: Buffer;
    private vertexData: Float32Array = new Float32Array(6 * 3 * 256);
    private quads = 0;
    private heads = new Texels();
    private columns = new Texels();
    private lines = new Texels();
    private headTexture: WebGLTexture;
    private columnTexture: WebGLTexture;
    private rowTexture: WebGLTexture;
    private width = 0;
    private height = 0;
    private sprite: GpuSprite | null = null;
    private tsm = null;
    private mode = 0;
    private pushColumn = (column: number, fraction: number) => this.columns.push(column, fraction);
    private pushRow = (base: number, fraction: number) => this.lines.push(base, fraction);

    constructor(rctx) {
        const gl = rctx.getGl();
        this.gl = gl;
        this.minmax = gl.getExtension("EXT_blend_minmax");
        const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        this.usable = Boolean(high && high.precision >= 23);
        if (!this.usable) {
            return;
        }
        try {
            this.vertices = new Buffer(rctx);
            this.headTexture = createDataTexture(gl);
            this.columnTexture = createDataTexture(gl);
            this.rowTexture = createDataTexture(gl);
            this.program = this.makeProgram(rctx);
        } catch (error) {
            // A shader this GPU will not take: the processor draws.
            // tslint:disable-next-line:no-console
            console.warn("AVS: Texer II stays on the processor", error);
            this.usable = false;
        }
    }

    private makeProgram(rctx): ShaderProgram {
        return new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    vertices: { name: "a_vertex", size: 3 },
                },
                uniforms: {
                    columns: { name: "u_columns", valueType: WebGLVarType.TEXTURE2D },
                    frameHeight: { name: "u_frameHeight", valueType: WebGLVarType._1F },
                    heads: { name: "u_heads", valueType: WebGLVarType.TEXTURE2D },
                    rows: { name: "u_rows", valueType: WebGLVarType.TEXTURE2D },
                    sizes: { name: "u_sizes", valueType: WebGLVarType._4FV },
                    sprite: { name: "u_sprite", valueType: WebGLVarType.TEXTURE2D },
                    spriteShape: { name: "u_spriteShape", valueType: WebGLVarType._2FV },
                },
            },
            drawHook: (values, gl2) => {
                this.glBlend(values.mode);
                gl2.drawArrays(gl2.TRIANGLES, 0, values.count);
                gl2.blendEquation(gl2.FUNC_ADD);
                gl2.blendFunc(gl2.ONE, gl2.ZERO);
            },
            fragmentShader: `
                precision highp float;
                uniform sampler2D u_heads;
                uniform sampler2D u_columns;
                uniform sampler2D u_rows;
                uniform sampler2D u_sprite;
                uniform highp vec4 u_sizes;        // rows of the head, column, row and sprite textures
                uniform highp vec2 u_spriteShape;  // pixels per variant, bitmap width
                uniform highp float u_frameHeight;
                varying highp float v_index;

                highp vec4 texel(sampler2D data, highp float index, highp float rows) {
                    highp float y = floor(index / ${WIDTH}.0);
                    highp float x = index - y * ${WIDTH}.0;
                    return floor(texture2D(data, vec2((x + 0.5) / ${WIDTH}.0, (y + 0.5) / rows)) * 255.0 + 0.5);
                }
                highp float word(highp vec4 b) {
                    return b.r * 65536.0 + b.g * 256.0 + b.b;
                }
                highp vec3 tap(highp float base, highp float index) {
                    if (index >= u_spriteShape.x) {
                        return vec3(0.0);
                    }
                    return texel(u_sprite, base + index, u_sizes.w).rgb;
                }
                void main() {
                    highp float particle = floor(v_index + 0.5) * 5.0;
                    highp vec4 head = texel(u_heads, particle, u_sizes.x);
                    highp float left = word(head);
                    highp float base = head.a * u_spriteShape.x;
                    highp float top = word(texel(u_heads, particle + 1.0, u_sizes.x));
                    highp float firstColumn = word(texel(u_heads, particle + 2.0, u_sizes.x));
                    highp float firstRow = word(texel(u_heads, particle + 3.0, u_sizes.x));
                    highp vec3 color = texel(u_heads, particle + 4.0, u_sizes.x).rgb;
                    highp float x = floor(gl_FragCoord.x);
                    highp float y = u_frameHeight - 1.0 - floor(gl_FragCoord.y);
                    highp vec4 column = texel(u_columns, firstColumn + x - left, u_sizes.y);
                    highp vec4 row = texel(u_rows, firstRow + y - top, u_sizes.z);
                    highp float fx = column.a;
                    highp float fy = row.a;
                    highp float at = word(row) + word(column);
                    highp vec3 a = tap(base, at);
                    highp vec3 b = tap(base, at + 1.0);
                    highp vec3 c = tap(base, at + u_spriteShape.y);
                    highp vec3 d = tap(base, at + u_spriteShape.y + 1.0);
                    highp vec3 upper = floor(b * fx / 256.0) + floor(a * (255.0 - fx) / 256.0);
                    highp vec3 lower = floor(c * (255.0 - fx) / 256.0) + floor(d * fx / 256.0);
                    highp vec3 t = mod(floor(lower * fy / 256.0) + floor(upper * (255.0 - fy) / 256.0), 65536.0);
                    highp vec3 p = floor(mod(t * color, 65536.0) / 256.0);
                    setFragColor(vec4(p / 255.0, 1.0));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute highp vec3 a_vertex;
                varying highp float v_index;
                void main() {
                    setPosition(a_vertex.xy);
                    v_index = a_vertex.z;
                }
            `,
        });
    }

    /** Whether a Texer II drawing in line mode `mode` can be drawn here. */
    public handles(mode: number): boolean {
        if (!this.usable || (globalThis as any).__avsTexerGpu === false) {
            return false;
        }
        return mode === 0 || mode === 1 || mode === 4 || mode === 5 || ((mode === 2 || mode === 9) && Boolean(this.minmax));
    }

    /** Starts a Texer II's particles on a W × H frame of `tsm` (the bound render target). */
    public begin(tsm, width: number, height: number, sprite: GpuSprite, mode: number) {
        this.tsm = tsm;
        this.width = width;
        this.height = height;
        this.sprite = sprite;
        this.mode = mode;
        this.reset();
    }

    /** One particle (variant 0…3, the resize path's geometry, colour 0xRRGGBB), after the ones before. */
    public add(variant: number, g: ResizeGeometry, color: number) {
        const count = g.right2 - g.left2 + 1;
        const rows = g.bottom2 - g.top2 + 1;
        if (this.columns.count + count > CAPACITY || this.lines.count + rows > CAPACITY || this.heads.count + 5 > CAPACITY) {
            this.flush();
        }
        const sprite = this.sprite;
        const limit = sprite.pixels;
        const index = this.heads.count / 5;
        this.heads.push(g.left2, variant);
        this.heads.push(g.top2, 0);
        this.heads.push(this.columns.count, 0);
        this.heads.push(this.lines.count, 0);
        this.heads.push(color & 0xffffff, 0);
        // The 16.16 walk as the processor makes it (an int), clamped where it reads nothing anyway.
        walkColumns(g, limit, this.pushColumn);
        walkRows(g, sprite.width, limit, this.pushRow);
        const x0 = (g.left2 / this.width) * 2 - 1;
        const x1 = ((g.right2 + 1) / this.width) * 2 - 1;
        const y0 = 1 - (g.top2 / this.height) * 2;
        const y1 = 1 - ((g.bottom2 + 1) / this.height) * 2;
        let at = this.quads * 18;
        if (at + 18 > this.vertexData.length) {
            const grown = new Float32Array(this.vertexData.length * 2);
            grown.set(this.vertexData);
            this.vertexData = grown;
        }
        const v = this.vertexData;
        const corner = (x: number, y: number) => {
            v[at] = x;
            v[at + 1] = y;
            v[at + 2] = index;
            at += 3;
        };
        corner(x0, y0);
        corner(x1, y0);
        corner(x0, y1);
        corner(x0, y1);
        corner(x1, y0);
        corner(x1, y1);
        this.quads++;
    }

    /** Draws the particles added since the last flush, in their order. */
    public flush() {
        if (!this.quads) {
            return;
        }
        const gl = this.gl;
        this.heads.upload(gl, this.headTexture);
        this.columns.upload(gl, this.columnTexture);
        this.lines.upload(gl, this.rowTexture);
        this.vertices.setData(this.vertexData.subarray(0, this.quads * 18));
        this.program.run(this.tsm, {
            columns: this.columnTexture,
            count: this.quads * 6,
            frameHeight: this.height,
            heads: this.headTexture,
            mode: this.mode,
            rows: this.rowTexture,
            sizes: [this.heads.rows(), this.columns.rows(), this.lines.rows(), this.sprite.rows],
            sprite: this.sprite.texture,
            spriteShape: [this.sprite.pixels, this.sprite.width],
            vertices: this.vertices,
        });
        this.reset();
    }

    private reset() {
        this.quads = 0;
        this.heads.reset();
        this.columns.reset();
        this.lines.reset();
    }

    private glBlend(mode: number) {
        const gl = this.gl;
        if (mode === 0) {
            gl.disable(gl.BLEND);
            return;
        }
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO);
        const equation = mode === 1 ? gl.FUNC_ADD
            : mode === 4 ? gl.FUNC_REVERSE_SUBTRACT
            : mode === 5 ? gl.FUNC_SUBTRACT
            : mode === 2 ? this.minmax.MAX_EXT
            : this.minmax.MIN_EXT;
        gl.blendEquationSeparate(equation, gl.FUNC_ADD);
    }
}

const renderers = new WeakMap();

/** The GPU Texer II of main's rendering context. */
export function texerGpu(main): TexerGpu {
    const rctx = main.getRctx();
    let renderer = renderers.get(rctx);
    if (!renderer) {
        renderer = new TexerGpu(rctx);
        renderers.set(rctx, renderer);
    }
    return renderer;
}
