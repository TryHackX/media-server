// @ts-nocheck — part of this project's webvs fork (MIT); webvs 3.0.0's Mirror replaced.
/**
 * Mirror, as r_mirror.cpp of AVS 2.81d (Nullsoft's vis_avs source, BSD licence) draws it: up to
 * four passes over the frame — left half onto the right, right onto left, top onto bottom, bottom
 * onto top, in that order, each one reading what the one before left. The fades and the state the
 * Mirrors of a preset share are in mirrorFade.ts. With "on beat random" a beat picks
 * `(rand() % 16) & mode`; before the first beat that mode is 0 (in AVS an uninitialised value).
 */
import { cRand } from "../avsRandom";
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { mirrorAdvance, mirrorPasses, newMirrorStatics } from "./mirrorFade";

export interface IMirrorDirs {
    topToBottom: boolean;
    bottomToTop: boolean;
    leftToRight: boolean;
    rightToLeft: boolean;
}

export interface IMirrorOpts extends IMirrorDirs {
    onBeatRandom: boolean;
    smoothTransition: boolean;
    transitionDuration: number;
}

/** The pass a mode bit draws (u_pass in the shader). */
const PASS_OF_BIT = { 1: 2, 2: 3, 4: 0, 8: 1 };

export default class Mirror extends Component {
    public static componentName: string = "Mirror";
    public static componentTag: string = "trans";
    protected static defaultOptions: IMirrorOpts = {
        bottomToTop: false,
        leftToRight: false,
        onBeatRandom: false,
        rightToLeft: false,
        smoothTransition: false,
        topToBottom: true,
        transitionDuration: 4,
    };

    protected opts: IMirrorOpts;
    private program: ShaderProgram;
    private frameCount: number;
    private randomMode: number;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    pass: { name: "u_pass", valueType: WebGLVarType._1I },
                    divisor: { name: "u_divisor", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                uniform int u_pass;      // 0 left to right, 1 right to left, 2 top to bottom, 3 bottom to top
                uniform float u_divisor; // 0 copies; 1…16: (16 - d)/16 of the pixel, d/16 of its mirror image
                void main() {
                    vec2 pixel = floor(gl_FragCoord.xy);
                    vec2 halves = floor(u_resolution * 0.5);
                    bool target;
                    vec2 from = pixel;
                    if (u_pass < 2) {
                        target = u_pass == 0 ? pixel.x >= u_resolution.x - halves.x : pixel.x < halves.x;
                        from.x = u_resolution.x - 1.0 - pixel.x;
                    } else {
                        // GL counts rows from the bottom: AVS's bottom half is GL's first rows.
                        target = u_pass == 2 ? pixel.y < halves.y : pixel.y >= u_resolution.y - halves.y;
                        from.y = u_resolution.y - 1.0 - pixel.y;
                    }
                    vec4 here = getSrcColor();
                    if (!target) {
                        setFragColor(here);
                        return;
                    }
                    vec4 there = getSrcColorAtPos((from + 0.5) / u_resolution);
                    if (u_divisor < 0.5) {
                        setFragColor(there);
                        return;
                    }
                    vec3 a = floor(floor(here.rgb * 255.0 + 0.5) / 16.0);
                    vec3 b = floor(floor(there.rgb * 255.0 + 0.5) / 16.0);
                    setFragColor(vec4((a * (16.0 - u_divisor) + b * u_divisor) / 255.0, 1.0));
                }
            `,
            swapFrame: true,
        });
        this.frameCount = 0;
        this.randomMode = 0;
    }

    public draw() {
        const opts = this.opts;
        const mode = (opts.topToBottom ? 1 : 0) | (opts.bottomToTop ? 2 : 0)
            | (opts.leftToRight ? 4 : 0) | (opts.rightToLeft ? 8 : 0);
        // AVS divides its frame count by `slower` (a slider from 1 to 16); 0 would stop AVS.
        const slower = Math.trunc(Number(opts.transitionDuration) || 0);
        const smooth = Boolean(opts.smoothTransition) && slower > 0;
        let thisMode = mode;
        if (opts.onBeatRandom) {
            if (this.main.getAnalyser().isBeat()) {
                this.randomMode = (cRand() % 16) & mode;
            }
            thisMode = this.randomMode;
        }
        const main = this.main as any;
        if (!main.avsMirrorStatics) {
            main.avsMirrorStatics = newMirrorStatics();
        }
        const statics = main.avsMirrorStatics;
        for (const pass of mirrorPasses(statics, thisMode, smooth)) {
            this.program.run(this.parent.getTSM(), { pass: PASS_OF_BIT[pass.bit], divisor: pass.divisor });
        }
        if (smooth) {
            this.frameCount++;
            if (this.frameCount % slower === 0) {
                mirrorAdvance(statics);
            }
        }
    }

    public destroy() {
        super.destroy();
        if (this.program) {
            this.program.destroy();
        }
    }
}
