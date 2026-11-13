// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Trans / Interferences, ported from Nullsoft's vis_avs 2.81d (r_interf.cpp, BSD
 * licence): the frame laid over itself `numberOfLayers` times, each copy moved
 * `distance` pixels out from the centre in its own direction (the directions
 * evenly spaced and turning by `rotation`/255 of a circle a frame) and dimmed by
 * alpha/255, the copies added up. A beat (when on) swings distance, alpha and the
 * turn towards their on-beat values and back over π / speed frames. With three or
 * six layers "separate RGB" takes blue, green and red each from its own copies.
 * The result replaces the frame or is added to it or mixed 50/50.
 *
 * The integer arithmetic is AVS's: g_blendtable[alpha][level], sums clipped at 255,
 * the layer offsets as (int)(cos(a) · distance); AVS's additive and 50/50 passes
 * work in blocks of four pixels and leave the last w·h mod 4 pixels as they were.
 * Offsets count in pixels of AVS's window (about 480 lines), scaled to this one.
 */
import { AVS_BLEND_GLSL, int32 } from "../avsDraw";
import Component from "../Component";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";

const PI = 3.14159;
const MAX_POINTS = 8;
const f = Math.fround;

export default class Interferences extends Component {
    public static componentName: string = "Interferences";
    public static componentTag: string = "trans";

    private program: ShaderProgram;
    private rotation: number;
    private status: number;

    public init() {
        // load_config: the saved rotation, and no on-beat swing under way.
        this.rotation = int32(Number(this.opts.initialRotation) || 0);
        this.status = f(PI);
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    alpha: { name: "u_alpha", valueType: WebGLVarType._1F },
                    blend: { name: "u_blend", valueType: WebGLVarType._1I },
                    count: { name: "u_count", valueType: WebGLVarType._1F },
                    limit: { name: "u_limit", valueType: WebGLVarType._1F },
                    offsets: { name: "u_offsets", valueType: WebGLVarType._2FV },
                    rgb: { name: "u_rgb", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                ${AVS_BLEND_GLSL}
                uniform vec2 u_offsets[${MAX_POINTS}];
                uniform float u_count;
                uniform float u_alpha;
                uniform float u_rgb;
                uniform int u_blend;
                uniform float u_limit;
                // A pixel of the frame (x, y down) in levels 0…255.
                vec3 level(vec2 pixel) {
                    vec2 uv = vec2(pixel.x + 0.5, u_resolution.y - pixel.y - 0.5) / u_resolution;
                    return floor(texture2D(u_srcTexture, uv).rgb * 255.0 + 0.5);
                }
                vec3 dim(vec3 c) {
                    return vec3(avsMul(u_alpha, c.r), avsMul(u_alpha, c.g), avsMul(u_alpha, c.b));
                }
                void main() {
                    vec2 pixel = floor(vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y));
                    vec3 sum = vec3(0.0);
                    for (int i = 0; i < ${MAX_POINTS}; i++) {
                        if (float(i) >= u_count) {
                            break;
                        }
                        vec2 at = pixel - u_offsets[i];
                        if (at.x >= 0.0 && at.x < u_resolution.x && at.y >= 0.0 && at.y < u_resolution.y) {
                            vec3 c = dim(level(at));
                            if (u_rgb > 0.5) {
                                // Layer i feeds one channel: 0 blue (AVS's low byte), 1 green, 2 red.
                                int channel = i - 3 * (i / 3);
                                if (channel == 0) {
                                    sum.b += c.b;
                                } else if (channel == 1) {
                                    sum.g += c.g;
                                } else {
                                    sum.r += c.r;
                                }
                            } else {
                                sum += c;
                            }
                        }
                    }
                    vec3 result = min(sum, vec3(255.0));
                    if (u_blend != 0) {
                        vec3 frame = level(pixel);
                        if (pixel.y * u_resolution.x + pixel.x < u_limit) {
                            result = u_blend == 1 ? min(frame + result, vec3(255.0)) : floor(frame * 0.5) + floor(result * 0.5);
                        } else {
                            result = frame;
                        }
                    }
                    setFragColor(vec4(result / 255.0, 1.0));
                }`,
            swapFrame: true,
        });
    }

    public draw() {
        const opts = this.opts;
        let points = int32(Number(opts.numberOfLayers) || 0);
        if (points === 0) {
            return;
        }
        // The slider stops at 8; AVS's arrays hold no more.
        points = Math.min(points, MAX_POINTS);
        const distance = int32(Number(opts.distance) || 0);
        const alpha = int32(Number(opts.alpha) || 0);
        const rotationInc = int32(Number(opts.rotation) || 0);
        const distance2 = int32(Number(opts.onBeatDistance) || 0);
        const alpha2 = int32(Number(opts.onBeatAlpha) || 0);
        const rotationInc2 = int32(Number(opts.onBeatRotation) || 0);
        const speed = f(Number(opts.speed) || 0);
        const mode = String(opts.blendMode || "").toUpperCase();

        const angle = f(f(2 * PI) / points);
        if (opts.onBeat && this.main.getAnalyser().isBeat() && this.status >= PI) {
            this.status = 0;
        }
        const s = f(Math.sin(this.status));
        const turn = rotationInc + Math.trunc(f(f(rotationInc2 - rotationInc) * s));
        const level = alpha + Math.trunc(f(f(alpha2 - alpha) * s));
        const reach = distance + Math.trunc(f(f(distance2 - distance) * s));

        let a = f(f(f(f(this.rotation) / 255) * f(PI)) * 2);
        const scale = this.main.avsScale || 1;
        const offsets = new Float32Array(MAX_POINTS * 2);
        for (let i = 0; i < points; i++) {
            offsets[i * 2] = Math.round(Math.trunc(Math.cos(a) * reach) * scale);
            offsets[i * 2 + 1] = Math.round(Math.trunc(Math.sin(a) * reach) * scale);
            a = f(a + angle);
        }

        const gl = this.main.getRctx().getGl();
        const pixels = gl.drawingBufferWidth * gl.drawingBufferHeight;
        this.program.run(this.parent.getTSM(), {
            alpha: Math.max(0, Math.min(255, level)),
            blend: mode === "FIFTY_FIFTY" ? 2 : mode === "ADDITIVE" ? 1 : 0,
            count: Math.max(0, points),
            limit: pixels - (pixels % 4),
            offsets,
            rgb: opts.separateRGB && (points === 3 || points === 6) ? 1 : 0,
        });

        this.rotation += turn;
        this.rotation = this.rotation > 255 ? this.rotation - 255 : this.rotation;
        this.rotation = this.rotation < -255 ? this.rotation + 255 : this.rotation;
        this.status = f(this.status + speed);
        this.status = Math.min(this.status, f(PI));
        if (this.status < -PI) {
            this.status = f(PI);
        }
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
    }
}
