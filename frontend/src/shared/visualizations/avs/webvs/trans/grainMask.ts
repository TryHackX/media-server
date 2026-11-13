// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Moving Grain on a frame that is on the GPU (grainDice.ts has the walk): the GPU packs which pixels
 * are lit into a bitmask (32 pixels a texel, w/32 × h), the processor reads back that much (1/32 of
 * the frame), walks the plug-in's table over the lit pixels in their order and writes each one's
 * scale byte (0 when its chance missed), and a shader applies the bytes. The frame itself never
 * leaves the GPU: the read-back of a whole 1280×720 frame was most of the time moving Grain took.
 * (Grain on a frame the processor already holds, after a Super Scope or Texer II, walks that frame.)
 */
import { blendGlsl, HIGH_PRECISION } from "../avsSupport";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { grainMask, grainMaskWasm } from "./grainDice";

export class GrainMask {
    private gl: WebGLRenderingContext;
    private pack: ShaderProgram;
    private apply: ShaderProgram;
    private maskTexture: WebGLTexture | null = null;
    private maskBuffer: WebGLFramebuffer | null = null;
    private scaleTexture: WebGLTexture | null = null;
    private width = 0;
    private height = 0;
    private stride = 0;
    private mask = new Uint8Array(0);
    private scale = new Uint8Array(0);

    /** `blend`: simpleBlend's name of the Grain's mode (REPLACE, ADDITIVE, AVERAGE). */
    constructor(rctx, blend: string) {
        this.gl = rctx.getGl();
        // Texel x of row y: pixels 32x … 32x + 31, channel c bit b is pixel 32x + 8c + b.
        const lit = [];
        for (let c = 0; c < 4; c++) {
            const bits = [];
            for (let b = 0; b < 8; b++) {
                bits.push(`${(1 << b).toFixed(1)} * lit(x + ${(c * 8 + b).toFixed(1)})`);
            }
            lit.push(bits.join(" + "));
        }
        this.pack = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    frame: { name: "u_frame", valueType: WebGLVarType.TEXTURE2D },
                    size: { name: "u_size", valueType: WebGLVarType._2FV },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_frame;
                uniform vec2 u_size;
                float row;
                float lit(float x) {
                    if (x >= u_size.x) {
                        return 0.0;
                    }
                    vec3 c = texture2D(u_frame, vec2((x + 0.5) / u_size.x, row / u_size.y)).rgb;
                    return c.r + c.g + c.b > 0.5 / 255.0 ? 1.0 : 0.0;
                }
                void main() {
                    row = gl_FragCoord.y;
                    float x = floor(gl_FragCoord.x) * 32.0;
                    setFragColor(vec4(${lit.join(", ")}) / 255.0);
                }
            `,
            swapFrame: false,
        });
        this.apply = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    scale: { name: "u_scale", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                ${blendGlsl(blend)}
                uniform sampler2D u_scale;
                void main() {
                    vec3 color = getSrcColor().rgb;
                    vec3 level = floor(color * 255.0 + 0.5);
                    if (level == vec3(0.0)) {
                        setFragColor(vec4(color, 1.0));
                        return;
                    }
                    float scale = floor(texture2D(u_scale, (floor(gl_FragCoord.xy) + 0.5) / u_resolution).r * 255.0 + 0.5);
                    setFragColor(vec4(blendAvs(color, floor(level * scale / 256.0) / 255.0), 1.0));
                }
            `,
            swapFrame: true,
        });
    }

    private allocate(width: number, height: number) {
        const gl = this.gl;
        this.width = width;
        this.height = height;
        const texels = Math.ceil(width / 32);
        this.stride = texels * 4;
        this.mask = new Uint8Array(this.stride * height);
        this.scale = new Uint8Array(width * height);
        const texture = (format: number, w: number) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, format, w, height, 0, format, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        this.release();
        this.maskTexture = texture(gl.RGBA, texels);
        this.scaleTexture = texture(gl.LUMINANCE, width);
        this.maskBuffer = gl.createFramebuffer();
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskBuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTexture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    }

    /**
     * The grain over tsm's current frame: the walk (from `dice`; rand() from `state` in
     * WebAssembly, or `rand` in JavaScript without it) and the shader. Returns the state after the
     * walk (or -1 when JavaScript drew from `rand`).
     */
    public draw(tsm, width: number, height: number, dice, limit: number, state: number, rand: () => number): number {
        const gl = this.gl;
        if (this.width !== width || this.height !== height) {
            this.allocate(width, height);
        }
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskBuffer);
        gl.viewport(0, 0, this.stride / 4, height);
        this.pack.run(null, { frame: tsm.getCurrentTexture(), size: [width, height] });
        gl.readPixels(0, 0, this.stride / 4, height, gl.RGBA, gl.UNSIGNED_BYTE, this.mask);
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        // The viewport webvs keeps (Main.ts), as mscopes/gl.ts puts it back.
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        const after = grainMaskWasm(this.mask, this.stride, width, height, dice, state, limit, this.scale);
        if (after < 0) {
            grainMask(this.mask, this.stride, width, height, dice, rand, limit, this.scale);
        }
        gl.bindTexture(gl.TEXTURE_2D, this.scaleTexture);
        const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.scale);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
        this.apply.run(tsm, { scale: this.scaleTexture });
        return after;
    }

    private release() {
        const gl = this.gl;
        if (this.maskTexture) gl.deleteTexture(this.maskTexture);
        if (this.scaleTexture) gl.deleteTexture(this.scaleTexture);
        if (this.maskBuffer) gl.deleteFramebuffer(this.maskBuffer);
        this.maskTexture = null;
        this.scaleTexture = null;
        this.maskBuffer = null;
    }

    public destroy() {
        this.release();
        this.pack.destroy();
        this.apply.destroy();
    }
}
