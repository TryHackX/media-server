// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import isArray from "lodash-es/isArray";
import reduce from "lodash-es/reduce";
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { glslFloatRepr, WebGLVarType } from "../utils";
import RenderingContext from "../webgl/RenderingContext";
import ShaderProgram from "../webgl/ShaderProgram";
import { cpuFrameRun } from "../cpuFrameRun";
import { convolutionGlsl, convolutionRecursive, convolveAvs, planConvolution } from "./convolutionCpu";
import { ConvolutionEdges, ConvolutionEdgesGpu, FrameTransfer } from "./convolutionEdges";
import { ConvolutionWasm } from "./convolutionWasm";

/**
 * Edge handling modes for [[Convolution]] component
 */
enum ConvEdgeMode {
    /**
     * Extend edge value beyond edge
     */
    EXTEND = 0,
    /**
     * Wrap around to opposite edge
     */
    WRAP,
}

/**
 * Options for [[Convolution]] component
 */
export interface IConvolutionOpts {
    /**
     * Edge handline mode. see [[ConvEdgeMode]].
     * Default: `EXTEND`
     */
    edgeMode: string;
    /**
     * Automatically compute scale value. Default: `true`
     */
    autoScale: boolean;
    /**
     * Scale for convolution. Default: 0
     */
    scale: number;
    /**
     * 2D Matrix with convolution kernel. Default: `[0,0,0 0,1,0, 0,0,0]`
     */
    kernel: number[];
    /**
     * Convolution bias value. Default: 0
     */
    bias: number;
}

/**
 * A component that applies a convolution kernel
 */
export default class Convolution extends Component {
    public static componentName: string = "Convolution";
    public static componentTag: string = "trans";
    protected static optUpdateHandlers = {
        edgeMode: "updateProgram",
        kernel: ["updateScale", "updateProgram"],
        scale: "updateScale",
        bias: "updateProgram",
    };
    protected static defaultOptions: IConvolutionOpts = {
        autoScale: true,
        bias: 0,
        edgeMode: "EXTEND",
        kernel: [
            0, 0, 0,
            0, 1, 0,
            0, 0, 0,
        ],
        scale: 0,
    };

    protected opts: IConvolutionOpts;
    private program: ShaderProgram;
    private scale: number;
    /**
     * Fork: a kernel that runs in place and reads pixels it has already written (convolutionCpu.ts):
     * "edges" where only the last column and the last two rows do (the GPU's pass, then those in
     * two more passes on the GPU, convolutionEdges.ts; on the processor for frames wider than its
     * loop), "frame" where the second pass reads the rows above (the whole filter on the
     * processor, its inside in WebAssembly SIMD where there is any, a user of the frame run,
     * cpuFrameRun.ts).
     */
    private cpuPlan;
    private cpuMode: "" | "edges" | "frame";
    private edges: ConvolutionEdges | null;
    private edgesGpu: ConvolutionEdgesGpu | null;
    private wasm: ConvolutionWasm | null;
    private wasmSize: string;
    private transfer: FrameTransfer | null;
    public avsCpuFrameUser: boolean;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.updateScale();
        this.updateProgram();
    }

    public draw() {
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (this.cpuMode === "frame") {
            const run = cpuFrameRun(this.main);
            const tsm = this.parent.getTSM();
            try {
                const size = `${width}x${height}`;
                if (this.wasmSize !== size) {
                    // null until a large module has compiled (then asked again next frame).
                    this.wasm = ConvolutionWasm.make(this.cpuPlan, width, height);
                    this.wasmSize = this.wasm ? size : "";
                }
                if (this.wasm && !run.holds(tsm, width, height) && !this.main.avsCpuRunNext) {
                    // No other effect shares the frame: read back into the module's memory and send
                    // back from it, in GL's row order (no flip, no copies).
                    run.flush();
                    (this.transfer ||= new FrameTransfer(this.main.getRctx())).read(this.wasm.view, width, height);
                    this.wasm.filter(width, height, true);
                    this.transfer.write(tsm, this.wasm.view, width, height);
                } else {
                    const frame = run.acquire(tsm, width, height);
                    if (this.wasm) {
                        this.wasm.run(frame, width, height);
                    } else {
                        convolveAvs(this.cpuPlan, frame, frame, width, height);
                    }
                    run.changed();
                }
            } finally {
                run.finish(this.main);
            }
            return;
        }
        const tsm = this.parent.getTSM();
        if (this.cpuMode === "edges" && ConvolutionEdgesGpu.fits(width, height)) {
            // The picture as it was: the pass draws into the set's other texture.
            const source = tsm.getCurrentTexture();
            this.program.run(tsm, { scale: this.scale, bias: this.opts.bias });
            (this.edgesGpu ||= new ConvolutionEdgesGpu(this.main.getRctx(), this.cpuPlan)).draw(tsm, source, width, height);
            return;
        }
        const edges = this.cpuMode === "edges" && ConvolutionEdges.fits(width, height);
        if (edges) {
            (this.edges ||= new ConvolutionEdges(this.main.getRctx())).read(width, height);
        }
        this.program.run(tsm, { scale: this.scale, bias: this.opts.bias });
        if (edges) {
            this.edges.draw(tsm, this.cpuPlan);
        }
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        if (this.edges) {
            this.edges.destroy();
            this.edges = null;
        }
        if (this.edgesGpu) {
            this.edgesGpu.destroy();
            this.edgesGpu = null;
        }
        if (this.transfer) {
            this.transfer.destroy();
            this.transfer = null;
        }
    }

    private updateScale() {
        const opts = this.opts;
        if (opts.autoScale) {
            this.scale = reduce(opts.kernel, (memo, num) => memo + num, 0);
        } else {
            this.scale = opts.scale;
        }
        // Fork: the scale decides the code (its sign and how it divides), so the program follows it.
        if (this.program) {
            this.updateProgram();
        }
    }

    /**
     * Fork: AVS's arithmetic, as e_convolution.cpp (Tom Holden's generated MMX) does it, per
     * channel in whole 0…255 levels:
     *
     * - a negative scale turns every weight's and the bias's sign round and divides by its size;
     * - the positive and the negative terms are summed apart, the bias as 256 × bias
     *   (m64_bias) on its side;
     * - then the difference: never below 0 (psubusw); with "wrap" — which webvsc reads as
     *   `edgeMode: "WRAP"` — a negative one wraps round to 65536 + it (psubw); with "absolute"
     *   it is psubsw and the sign bit cleared, not an absolute value: a negative one comes out
     *   as 32768 + it, white after the division;
     * - "two pass" runs the kernel a second time turned a quarter round (x = 6 − row,
     *   y = column) and adds the two results, up to 65535 (paddusw — the source's comment
     *   says psubusw, its bytes 0F DD are paddusw, and autoscale doubles the sum for it);
     * - the division: none for 1, a shift for a power of two, otherwise a 16-bit multiply by
     *   65536 / scale keeping the high word;
     * - packuswb reads the word as signed: 32768 and above is black, the rest is cut to 255.
     *
     * Pixels beyond the picture repeat its edge: AVS has no other edge mode. With `avsEdges`
     * (ConvolutionFilter) the edges are the generated code's: the last three columns of the
     * output read at most column width − 2 (their offsets are `min(…, width-2)`), the columns
     * before them read their neighbours as they are (the column before those three still reaches
     * the last one, 3 to the right); every row reads at most row height − 2 (the row pointer c[6]
     * stays put when the next one would be the last row), so the last row is never read; the left
     * and top edges repeat column and row 0. Upstream added the bias as if it were 0…1, wrapped
     * the texture coordinates for "WRAP" and took a true absolute value.
     */
    private updateProgram() {
        const opts = this.opts;
        if (!isArray(opts.kernel) || opts.kernel.length % 2 !== 1) {
            throw new Error("Invalid convolution kernel");
        }
        const kernelSize = Math.floor(Math.sqrt(opts.kernel.length));
        if (kernelSize * kernelSize !== opts.kernel.length) {
            throw new Error("Invalid convolution kernel");
        }
        const scale = Math.trunc(Number(this.scale)) || 1;
        const sign = scale < 0 ? -1 : 1;
        const divisor = Math.abs(scale);
        const mid = Math.floor(kernelSize / 2);
        const bias = sign * Math.trunc(Number(opts.bias) || 0);
        // e_convolution.cpp writes in place (use_fbout = 0) when the kernel starts with at least
        // half its entries zero: every read lies at or after the pixel written, except where the
        // edges clamp it back onto pixels already written. For a kernel of the centre alone (309 of
        // the 393 such filters in the presets) that is the last row, which reads the row above as
        // already filtered, and the last column, which reads the one before it as filtered: the
        // filter twice there. Other kernels in place are AVS's order on the processor (cpuMode).
        const center = Math.floor(opts.kernel.length / 2);
        let leading = 0;
        while (leading < opts.kernel.length && !opts.kernel[leading]) {
            leading++;
        }
        const centerOnly = Boolean(opts.kernel[center]) && opts.kernel.every((value, index) => index === center || !value);
        const filteredTwice = Boolean(opts.avsEdges) && centerOnly && leading >= Math.floor(opts.kernel.length / 2);
        // The APE's 7×7 kernel: the generated code's arithmetic as one plan for the GPU and the
        // processor (convolutionCpu.ts).
        const plan = opts.avsEdges && opts.kernel.length === 49
            ? planConvolution({
                kernel: opts.kernel,
                bias: Math.trunc(Number(opts.bias) || 0),
                scale,
                wrap: Boolean(opts.wrap) && !opts.absolute,
                absolute: Boolean(opts.absolute),
                twoPass: Boolean(opts.twoPass),
            })
            : null;
        this.cpuPlan = null;
        this.cpuMode = "";
        this.wasm = null;
        this.wasmSize = "";
        if (this.edgesGpu) {
            this.edgesGpu.destroy();
        }
        this.edgesGpu = null;
        if (plan && !centerOnly && leading >= 24 && leading < 49) {
            this.cpuPlan = plan;
            this.cpuMode = convolutionRecursive(plan) ? "frame" : "edges";
        }
        this.avsCpuFrameUser = this.cpuMode === "frame";

        const sums = (pass: number) => {
            const positive: string[] = [];
            const negative: string[] = [];
            for (let i = 0; i < kernelSize; i++) {
                for (let j = 0; j < kernelSize; j++) {
                    const weight = sign * opts.kernel[i * kernelSize + j];
                    if (!weight) {
                        continue;
                    }
                    // Pass 0: column j, row i. Pass 1 (two pass): x = 6 − row, y = column.
                    const x = pass === 0 ? j : kernelSize - 1 - i;
                    const y = pass === 0 ? i : j;
                    const read = centerOnly ? "c" : "px(vec2(" + glslFloatRepr(x - mid) + "," + glslFloatRepr(mid - y) + "))";
                    const term = read + " * " + glslFloatRepr(Math.abs(weight));
                    (weight > 0 ? positive : negative).push(term);
                }
            }
            if (bias > 0) {
                positive.push("vec3(" + glslFloatRepr(256 * bias) + ")");
            } else if (bias < 0) {
                negative.push("vec3(" + glslFloatRepr(-256 * bias) + ")");
            }
            return [positive.join(" + ") || "vec3(0.0)", negative.join(" + ") || "vec3(0.0)"];
        };
        const mode = opts.absolute ? "ABSOLUTE" : opts.wrap ? "WRAP" : "SATURATE";
        let power = 0;
        while ((1 << power) < divisor) {
            power++;
        }
        const division = divisor === 1
            ? "vec3 y = x;"
            : (1 << power) === divisor
                ? "vec3 y = floor(x / " + glslFloatRepr(divisor) + ");"
                // mul dx by 65536/scale, the high word; split so that float32 stays exact.
                : "vec3 hi = floor(x / 256.0); vec3 lo = x - hi * 256.0;" +
                  " vec3 a = hi * " + glslFloatRepr(Math.floor(65536 / divisor)) + " / 256.0;" +
                  " vec3 y = floor(a) + floor(fract(a) + lo * " + glslFloatRepr(Math.floor(65536 / divisor)) + " / 65536.0);";
        const [positive0, negative0] = sums(0);
        const [positive1, negative1] = sums(1);

        const program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    bias: { name: "u_bias", valueType: WebGLVarType._1F },
                    scale: { name: "u_scale", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                #ifdef GL_FRAGMENT_PRECISION_HIGH
                precision highp float;
                #endif
                uniform float u_scale;
                uniform float u_bias;
                vec2 texel;
                vec3 px(vec2 offset) {
                    vec2 pos = clamp(v_position + texel * offset, ${opts.avsEdges
                        // rows (GL's y up): AVS's last row is never read; columns: in the last three
                        // of the output at most width − 2, elsewhere the last one too.
                        ? "vec2(0.5, 1.5) * texel, vec2(1.0 - (floor(gl_FragCoord.x) >= u_resolution.x - 3.0 ? 1.5 : 0.5) * texel.x, 1.0 - 0.5 * texel.y)"
                        : "texel * 0.5, 1.0 - texel * 0.5"});
                    return floor(texture2D(u_srcTexture, pos).rgb * 255.0 + 0.5);
                }
                vec3 difference(vec3 positive, vec3 negative) {
                    vec3 x = min(positive, 65535.0) - min(negative, 65535.0);
                    ${mode === "ABSOLUTE"
                        ? "x = clamp(x, -32768.0, 32767.0); x += 32768.0 * step(x, vec3(-0.5));"
                        : mode === "WRAP"
                            ? "x += 65536.0 * step(x, vec3(-0.5));"
                            : "x = max(x, 0.0);"}
                    return x;
                }
                // c: the centre pixel (read as c with a plan, or for a kernel of the centre alone).
                vec3 convolve(vec3 c) {
                    ${plan ? convolutionGlsl(plan) : `
                    vec3 x = difference(${positive0}, ${negative0});
                    ${opts.twoPass ? `x = min(x + difference(${positive1}, ${negative1}), 65535.0);` : ""}
                    ${division}
                    return mix(clamp(y, 0.0, 255.0), vec3(0.0), step(vec3(32767.5), y));`}
                }
                void main() {
                    texel = 1.0/u_resolution;
                    vec3 y = convolve(${plan || centerOnly ? "px(vec2(0.0))" : "vec3(0.0)"});
                    ${filteredTwice ? "if (gl_FragCoord.y < 1.0 || gl_FragCoord.x >= u_resolution.x - 1.0) { y = convolve(y); }" : ""}
                    setFragColor(vec4(y / 255.0, 1.0));
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
