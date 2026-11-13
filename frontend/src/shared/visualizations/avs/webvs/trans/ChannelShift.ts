// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import { cRand } from "../avsRandom";
import flatMap from "lodash-es/flatMap";
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { WebGLVarType } from "../utils";
import RenderingContext from "../webgl/RenderingContext";
import ShaderProgram from "../webgl/ShaderProgram";

/**
 * Options for [[ChannelShift]] component
 */
export interface IChannelShiftOpts {
    /**
     * Channel shift mode. see [[ChannelShiftMode]]
     */
    channel: string;
    /**
     * If enabled, channel shift mode will randomize on beat
     */
    onBeatRandom: boolean;
}

/**
 * Channel shift mode for [[ChannelShift]] component
 */
enum ChannelShiftMode {
    RGB = 0,
    RBG,
    BRG,
    BGR,
    GBR,
    GRB,
}
const ShiftChannelsKeys = Object.keys(ChannelShiftMode).filter((s) => isNaN(parseInt(s, 10)));

/**
 * A component that swizzles the color component
 */
export default class ChannelShift extends Component {
    public static componentName: string = "ChannelShift";
    public static componentTag: string = "trans";
    protected static optUpdateHandlers = {
        channel: "updateChannel",
    };
    protected static defaultOptions: IChannelShiftOpts = {
        channel: "RGB",
        onBeatRandom: false,
    };

    protected opts: IChannelShiftOpts;
    private program: ShaderProgram;
    private channel: ChannelShiftMode;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    channel: { name: "u_channel", valueType: WebGLVarType._1I },
                },
            },
            fragmentShader: `
                uniform int u_channel;
                void main() {
                    vec3 color = getSrcColor().rgb;
                    ${
                        flatMap(ShiftChannelsKeys, (channel) => `
                            if(u_channel == ${ChannelShiftMode[channel]}) {
                                setFragColor(vec4(color.${channel.toLowerCase()}, 1));
                            }
                        `).join("\n")
                    }
                }
            `,
            swapFrame: true,
        });
        this.updateChannel();
    }

    public draw() {
        if (this.opts.onBeatRandom && this.main.getAnalyser().isBeat()) {
            // AVS (r_chanshift.cpp): {RGB, RBG, GBR, GRB, BRG, BGR}[rand() % 6].
            this.channel = [0, 1, 4, 5, 2, 3][cRand() % 6];
        }
        this.program.run(this.parent.getTSM(), { channel: this.channel });
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
    }

    private updateChannel() {
        this.channel = ChannelShiftMode[this.opts.channel];
    }
}
