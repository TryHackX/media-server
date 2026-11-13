// @ts-nocheck — part of this project's webvs fork (MIT); rewritten after
// Nullsoft's vis_avs r_mosaic.cpp (BSD licence, see ../LICENSE-vis_avs.txt).
/**
 * Mosaic, as AVS draws it: `quality` blocks across and down (1…100, 100 is off),
 * each the colour of the pixel AVS steps to in 16.16 fixed point — half a block
 * in from the top left, then a block's width on — and on a beat `quality2` for
 * `durFrames` frames, walking back in whole steps of |quality − quality2| /
 * durFrames (integer division, as AVS does it). Additive or 50/50 over the frame.
 *
 * The block of every column and row is worked out on the CPU (a few thousand
 * steps) and handed to the shader as a small lookup texture.
 */
import Component from "../Component";
import { simpleBlend } from "../avsSupport";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";

/** AVS's walk along one axis: the source pixel of every output pixel, −1 where it stops. */
export function mosaicSteps(size: number, quality: number): Int32Array {
    const steps = new Int32Array(size).fill(-1);
    const increment = Math.trunc((size * 65536) / quality);
    let position = increment >> 17;
    let travelled = 0;
    for (let i = 0; i < size; i++) {
        steps[i] = position;
        travelled += 65536;
        if (travelled >= increment) {
            position += travelled >> 16;
            if (position >= size) {
                break;
            }
            travelled -= increment;
        }
    }
    return steps;
}

export default class Mosaic extends Component {
    public static componentName = "Mosaic";
    public static componentTag = "trans";
    protected static defaultOptions = {
        blendMode: "REPLACE",
        onBeatSizeChange: false,
        onBeatSizeDuration: 10,
        onBeatSquareSize: 1,
        squareSize: 50,
    };
    protected static optUpdateHandlers = {
        blendMode: "updateProgram",
    };

    private program: ShaderProgram;
    private lookup: WebGLTexture;
    private lookupKey: string;
    private quality: number;
    private framesLeft: number;

    public init() {
        this.quality = Math.trunc(Number(this.opts.squareSize) || 0);
        this.framesLeft = 0;
        this.updateProgram();
    }

    public draw() {
        const opts = this.opts;
        const quality = Math.trunc(Number(opts.squareSize) || 0);
        const quality2 = Math.trunc(Number(opts.onBeatSquareSize) || 0);
        const duration = Math.max(1, Math.trunc(Number(opts.onBeatSizeDuration) || 0));
        if (opts.onBeatSizeChange && this.main.getAnalyser().isBeat()) {
            this.quality = quality2;
            this.framesLeft = duration;
        } else if (!this.framesLeft) {
            this.quality = quality;
        }
        if (this.quality > 0 && this.quality < 100) {
            const gl = this.main.getRctx().getGl();
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            this.updateLookup(w, h, this.quality);
            this.program.run(this.parent.getTSM(), { lookup: this.lookup, lookupWidth: Math.max(w, h) });
        }
        if (this.framesLeft) {
            this.framesLeft--;
            if (this.framesLeft) {
                const step = Math.trunc(Math.abs(quality - quality2) / duration);
                this.quality += step * (quality2 > quality ? -1 : 1);
            }
        }
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        if (this.lookup) {
            this.main.getRctx().getGl().deleteTexture(this.lookup);
        }
    }

    /** Row 0: the source column of every column; row 1: the source row of every row. */
    private updateLookup(w: number, h: number, quality: number) {
        const key = `${w}x${h}:${quality}`;
        if (this.lookupKey === key) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const width = Math.max(w, h);
        const data = new Uint8Array(width * 2 * 4);
        const write = (row: number, steps: Int32Array) => {
            for (let i = 0; i < width; i++) {
                const value = i < steps.length ? steps[i] : -1;
                const at = (row * width + i) * 4;
                data[at] = value < 0 ? 0 : value & 255;
                data[at + 1] = value < 0 ? 0 : value >> 8;
                data[at + 2] = value < 0 ? 255 : 0;
                data[at + 3] = 255;
            }
        };
        write(0, mosaicSteps(w, quality));
        write(1, mosaicSteps(h, quality));
        if (!this.lookup) {
            this.lookup = gl.createTexture();
        }
        gl.bindTexture(gl.TEXTURE_2D, this.lookup);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        this.lookupKey = key;
    }

    private updateProgram() {
        const blend = simpleBlend(this.opts.blendMode);
        const mix = blend === "ADDITIVE"
            ? "color = min(color + current, vec3(255.0));"
            : blend === "AVERAGE"
                ? "color = floor(color * 0.5) + floor(current * 0.5);"
                : "";
        const program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    lookup: { name: "u_lookup", valueType: WebGLVarType.TEXTURE2D },
                    lookupWidth: { name: "u_lookupWidth", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                #ifdef GL_FRAGMENT_PRECISION_HIGH
                precision highp float;
                #endif
                uniform sampler2D u_lookup;
                uniform float u_lookupWidth;
                // The source index (or -1) stored for output pixel i on one axis.
                float blockSource(float i, float axis) {
                    vec4 t = texture2D(u_lookup, vec2((i + 0.5) / u_lookupWidth, (axis + 0.5) / 2.0));
                    return t.b > 0.5 ? -1.0 : floor(t.r * 255.0 + 0.5) + floor(t.g * 255.0 + 0.5) * 256.0;
                }
                void main() {
                    vec2 frag = floor(gl_FragCoord.xy);
                    float row = u_resolution.y - 1.0 - frag.y;
                    float sx = blockSource(frag.x, 0.0);
                    float sy = blockSource(row, 1.0);
                    vec3 current = floor(getSrcColor().rgb * 255.0 + 0.5);
                    if (sx < 0.0 || sy < 0.0) {
                        // AVS stops writing past its last block.
                        setFragColor(vec4(current / 255.0, 1.0));
                        return;
                    }
                    vec2 at = vec2((sx + 0.5) / u_resolution.x, 1.0 - (sy + 0.5) / u_resolution.y);
                    vec3 color = floor(texture2D(u_srcTexture, at).rgb * 255.0 + 0.5);
                    ${mix}
                    setFragColor(vec4(color / 255.0, 1.0));
                }
            `,
            swapFrame: true,
        });
        if (this.program) {
            this.program.destroy();
        }
        this.program = program;
    }
}
