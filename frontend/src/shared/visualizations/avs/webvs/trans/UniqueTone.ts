// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { parseColor, WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { blendGlsl, HIGH_PRECISION, LookupTexture, simpleBlend } from "../avsSupport";

export interface IUniqueToneOpts {
    color: string;
    invert: boolean;
    blendMode: string;
}

// A Component that applies a unique color tone
export default class UniqueTone extends Component {
    public static componentName = "UniqueTone";
    public static componentTag = "trans";
    protected static defaultOptions: IUniqueToneOpts = {
        blendMode: "REPLACE",
        color: "#ffffff",
        invert: false,
    };
    protected static optUpdateHandlers = {
        blendMode: "updateProgram",
        color: "updateColor",
    };

    protected opts: IUniqueToneOpts;
    private program: ShaderProgram;
    private lookup: LookupTexture;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.lookup = new LookupTexture(this.main.getRctx().getGl());
        this.updateColor();
        this.updateProgram();
    }

    public draw() {
        this.program.run(this.parent.getTSM(), {
            invert: this.opts.invert ? 1 : 0,
            lookup: this.lookup.texture(),
        });
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        if (this.lookup) {
            this.lookup.destroy();
        }
    }

    /**
     * Fork: the tone table as r_onetone.cpp builds it, in the same double
     * arithmetic: (unsigned char)((i / 255.0) * channel) for each level.
     */
    private updateColor() {
        const [red, green, blue] = parseColor(this.opts.color);
        const table = new Uint8Array(256 * 4);
        for (let level = 0; level < 256; level++) {
            table[level * 4] = Math.trunc((level / 255) * red);
            table[level * 4 + 1] = Math.trunc((level / 255) * green);
            table[level * 4 + 2] = Math.trunc((level / 255) * blue);
            table[level * 4 + 3] = 255;
        }
        this.lookup.update(table);
    }

    /**
     * Fork: AVS's depth (the brightest channel, 255 minus it inverted) and its
     * blend, in the shader on this frame: replace, saturating add, or 50/50
     * (a >> 1) + (b >> 1). Upstream blended with GL into the other texture of
     * the pair — the frame before the previous effect, not this one — so an
     * additive tone replaced the picture's colours with grey and burned white.
     */
    private updateProgram() {
        const program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    invert: { name: "u_invert", valueType: WebGLVarType._1F },
                    lookup: { name: "u_lookup", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_lookup;
                uniform float u_invert;
                ${blendGlsl(simpleBlend(this.opts.blendMode))}
                void main() {
                   vec3 color = getSrcColor().rgb;
                   vec3 level = floor(color * 255.0 + 0.5);
                   float depth = max(level.r, max(level.g, level.b));
                   if (u_invert > 0.5) {
                       depth = 255.0 - depth;
                   }
                   vec3 tone = texture2D(u_lookup, vec2((depth + 0.5) / 256.0, 0.5)).rgb;
                   setFragColor(vec4(blendAvs(color, tone), 1.0));
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
