// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import Component, {IContainer} from "../Component";
import IMain from "../IMain";
import { avsBlend, BlendMode, Color, parseColorNorm} from "../utils";
import ClearScreenProgram from "../webgl/ClearScreenProgram";
import ShaderProgram from "../webgl/ShaderProgram";
import { WebGLVarType } from "../utils";
import { AVS_BLEND_GLSL, avsLineMode } from "../avsDraw";

export interface IClearScreenOpts {
    beatCount: number;
    color: string;
    blendMode: string;
}

// A component that clears the screen
export default class ClearScreen extends Component {
    public static componentName = "ClearScreen";
    public static componentTag = "render";
    protected static defaultOptions: IClearScreenOpts = {
        beatCount: 0,
        blendMode: "REPLACE",
        color: "#000000",
    };
    protected static optUpdateHandlers = {
        blendMode: "updateProgram",
        color: "updateColor",
    };
    protected opts: IClearScreenOpts;

    private prevBeat: boolean;
    private beatCount: number;
    private program: ClearScreenProgram;
    private color: Color;
    // No initializer: init() (from the base constructor) sets it before field initializers would run.
    private lineProgram: ShaderProgram | null;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.prevBeat = false;
        this.beatCount = 0;

        this.updateColor();
        this.updateProgram();
    }

    public draw() {
        let clear = false;
        if (this.opts.beatCount === -1) {
            // Fork: AVS "only first frame".
            clear = !this.clearedOnce;
            this.clearedOnce = true;
        } else if (this.opts.beatCount === 0) {
            clear = true;
        } else {
            if (this.main.getAnalyser().isBeat() && !this.prevBeat) {
                this.beatCount++;
                if (this.beatCount >= this.opts.beatCount) {
                    clear = true;
                    this.beatCount = 0;
                }
            }
            this.prevBeat = this.main.getAnalyser().isBeat();
        }

        if (clear) {
            if (this.lineProgram) {
                // r_clear.cpp's "default render blend": BLEND_LINE(p, color) on every pixel, with
                // the line blend mode Set Render Mode left (an additive one keeps the frame).
                const line = avsLineMode(this.main);
                this.lineProgram.run(this.parent.getTSM(), { adjust: line.adjust, color: this.color.slice(0, 3), mode: line.mode });
            } else {
                this.program.run(this.parent.getTSM(), {color: this.color});
            }
        }
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        if (this.lineProgram) {
            this.lineProgram.destroy();
            this.lineProgram = null;
        }
    }

    public updateColor() {
        this.color = parseColorNorm(this.opts.color);
    }

    public updateProgram() {
        // Fork: AVS's third choice, "default render blend" (blend == 2 in r_clear.cpp).
        if (String(this.opts.blendMode).toUpperCase() === "DEFAULT") {
            if (!this.lineProgram) {
                this.lineProgram = new ShaderProgram(this.main.getRctx(), {
                    bindings: {
                        uniforms: {
                            adjust: { name: "u_adjust", valueType: WebGLVarType._1F },
                            color: { name: "u_color", valueType: WebGLVarType._3FV },
                            mode: { name: "u_mode", valueType: WebGLVarType._1I },
                        },
                    },
                    fragmentShader: `
                        ${AVS_BLEND_GLSL}
                        uniform int u_mode;
                        uniform float u_adjust;
                        uniform vec3 u_color;
                        void main() {
                            vec3 dest = floor(getSrcColor().rgb * 255.0 + 0.5);
                            vec3 src = floor(u_color * 255.0 + 0.5);
                            setFragColor(vec4(avsBlendLine(u_mode, dest, src, u_adjust) / 255.0, 1.0));
                        }
                    `,
                    swapFrame: true,
                });
            }
        } else if (this.lineProgram) {
            this.lineProgram.destroy();
            this.lineProgram = null;
        }
        const blendMode = (BlendMode[avsBlend(this.opts.blendMode)] ?? BlendMode.REPLACE);
        const program = new ClearScreenProgram(this.main.getRctx(), blendMode);
        if (this.program) {
            this.program.destroy();
        }
        this.program = program;
    }
}
