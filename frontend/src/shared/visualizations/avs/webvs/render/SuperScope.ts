// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); the drawing is this project's fork.
import each from "lodash-es/each";
import map from "lodash-es/map";
import Component, {IContainer} from "../Component";
import CodeInstance from "../expr/CodeInstance";
import compileExpr, { ICompileResult } from "../expr/compileExpr";
import { EelPort } from "../../eel-wasm-backend";
import IMain from "../IMain";
import { avsChannel, avsLine, avsLineMode, avsPlotter, avsVisdata, BLEND_ADDITIVE } from "../avsDraw";
import { cpuFrameRun } from "../cpuFrameRun";
import { Channels, Color, parseColorNorm, Source } from "../utils";

/**
 * Drawing modes for the [[SuperScope]] component
 */
enum SuperScopeDrawMode {
    LINES = 1,
    DOTS,
}

/** Fork: the variables a SuperScope sets and reads around each point, in EelPort order. */
const POINT = ["i", "v", "skip", "x", "y", "red", "green", "blue", "drawmode", "linesize"];
const [P_I, P_V, P_SKIP, P_X, P_Y, P_RED, P_GREEN, P_BLUE, P_DRAWMODE, P_LINESIZE] = POINT.map((_, k) => k);

/**
 * Options for the [[SuperScope]] component
 */

export interface ISuperScopeOpts {
    /**
     * EEL code to control drawing of scope
     *
     * EEL Variables:
     * + `red: `(ReadWrite, perPoint)` Set red of color (0-1)
     * + `green`: `(ReadWrite, perPoint)` Set green of color (0-1)
     * + `blue`: `(ReadWrite, perPoint)` Set blue of color (0-1)
     * + `n`: `(ReadWrite, init/perFrame/onBeat)` Set the number of points to be drawn
     * + `b`: `(Read, onBeat/perFrame/perPixel)` - 0/1 value indicate a beat
     * + `i`: `(Read, perPixel)` - (0-1) value indicating index of current point
     * + `v`: `(Read, perPixel)` - (0-1) value indicating value of scope at current point
     * + `x`: `(Write, perPixel)` - set this to set position of current point
     * + `y`: `(Write, perPixel)` - set this to set position of current point
     */
    code: {
        /**
         * EEL that'll be run on init
         */
        init: string,
        /**
         * EEL code that's run per frame
         */
        perFrame: string,
        /**
         * EEL code that's run on beat
         */
        onBeat: string,
        /**
         * EEL code that's run for each point
         */
        perPoint: string,
    };
    /**
     * Blend mode for superscope. Default: `REPLACE`
     */
    blendMode: string;
    /**
     * Channel for scope values. Default: `CENTER`
     */
    channel: string;
    /**
     * Data source of scope value. Default: `SPECTRUM`
     */
    source: string;
    /**
     * Drawing mode for the scope. see [[SuperScopeDrawMode]]. Default: `LINES`
     */
    drawMode: string;
    /**
     * Thickness of dots/line. Default: 1
     */
    thickness: number;
    /**
     * Number of times this superscope instance should be cloned. Default: 1
     */
    clone: number;
    /**
     * Colors that the superscope should cycle through.
     * RGB values set through EEL override this color.
     * Default: `["#FFFFFF"]`
     */
    colors: string[];
    /**
     * Speed at which superscope colors will be cycled.
     * Default: `0.01`
     */
    cycleSpeed: number;
}

interface ISSCodeInstance extends CodeInstance {
    red: number;
    green: number;
    blue: number;
    n: number;
    b: number;
    i: number;
    v: number;
    x: number;
    y: number;
    init: () => void;
    perFrame: () => void;
    onBeat: () => void;
    perPoint: () => void;
}

/**
 * A generic scope, that can draw points or lines based on user code
 */
export default class SuperScope extends Component {
    public static componentName: string = "SuperScope";
    public static componentTag: string = "render";
    protected static optUpdateHandlers = {
        channel: "updateChannel",
        clone: "updateClones",
        code: [ "updateCode", "updateClones"],
        colors: "updateColors",
        cycleSpeed: "updateSpeed",
        drawMode: "updateDrawMode",
        source: "updateSource",
    };
    protected static defaultOptions: ISuperScopeOpts = {
        blendMode: "REPLACE",
        channel: "CENTER",
        clone: 1,
        code: {
            init: "n=800",
            onBeat: "",
            perFrame: "t=t-0.05",
            perPoint: "d=i+v*0.2; r=t+i*$PI*4; x=cos(r)*d; y=sin(r)*d",
        },
        colors: ["#ffffff"],
        cycleSpeed: 0.01,
        drawMode: "LINES",
        source: "SPECTRUM",
        thickness: 1,
    };

    protected opts: ISuperScopeOpts;
    private code: ISSCodeInstance[];
    private inited: boolean;
    // Fork: the point's variables (POINT) through one port, rebound for each code instance drawn.
    private port: EelPort;
    private source: Source;
    private channel: Channels;
    private drawMode: SuperScopeDrawMode;
    private fa: Uint8Array;
    private colors: Color[];
    private curColorId: number;
    private colorPosition: number;
    private maxStep: number;
    private curStep: number;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.updateDrawMode();
        this.updateSource();
        this.updateCode();
        this.updateClones();
        this.updateSpeed();
        this.updateColors();
        this.updateChannel();
        this.listenTo(this.main, "resize", () => this.handleResize());

    }

    public draw() {
        // Fork: a user of the processor's frame run (cpuFrameRun.ts): the plotter may blend into a
        // frame the effect before left there, or leave it there for the next; back to the GPU
        // unless the next child drawn goes on with it — also when this scope draws nothing.
        const run = cpuFrameRun(this.main);
        try {
            // AVS (r_sscope.cpp): a scope without colours draws nothing and runs no code.
            if (!this.colors.length) {
                return;
            }
            const color = this._makeColor();
            each(this.code, (code) => {
                this.drawScope(code, color, !this.inited, run);
            });
            this.inited = true;
        } finally {
            run.finish(this.main);
        }
    }

    /**
     * Fork: the scope as r_sscope.cpp draws it, pixel for pixel through avsDraw's plotter: each
     * frame w, h, b, the cycled colour, skip = 0, linesize (Set Render Mode's width) and drawmode
     * are set before the code; per point, `skip` below 0.00001 draws it, `drawmode` (which the
     * code may change) picks a dot or a line from the point before (AVS's line(): Bresenham, the
     * far end left out), in the colour (int)(c * 255) of this point and `linesize` + 0.5 wide; the
     * writes blend as Set Render Mode says. A point that is skipped still starts the next line.
     * Without per-point code nothing is drawn; init runs once, when it compiled.
     */
    private drawScope(code: ISSCodeInstance, color: Color, runInit: boolean, run) {
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const line = avsLineMode(this.main);
        const set = this.main.avsRenderMode;
        const beat = this.main.getAnalyser().isBeat();
        // AVS sets w and h every frame before the code: code that assigns them (`W=3.14*2` in
        // an init) has them back the next frame.
        (code as any).w = w;
        (code as any).h = h;
        code.b = beat ? 1 : 0;
        code.red = color[0];
        code.green = color[1];
        code.blue = color[2];
        code.skip = 0;
        (code as any).linesize = set ? Math.max(0, Math.min(255, Math.trunc(Number(set.lineSize) || 0))) : 0;
        (code as any).drawmode = this.drawMode === SuperScopeDrawMode.DOTS ? 0 : 1;
        const compiled = (code as any).compiled;
        if (runInit && (!compiled || compiled.init)) {
            code.init();
        }
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        if (compiled && !compiled.perPoint) {
            return;
        }

        // Fork: n comes from the preset's code; NaN or -4 used to throw RangeError.
        const nPoints = Math.max(0, Math.min(131072, Math.floor(code.n) || 0));
        if (!nPoints) {
            return;
        }
        // Fork: v as r_sscope.cpp reads it: AVS's bytes of the channel (the centre as
        // visdata[0][x]/2 + visdata[1][x]/2 on signed chars), the wave's sign bit flipped
        // (^ 128), interpolated at a*576/n with the next byte (past the end: 0 here, whatever
        // followed the array in AVS), then /128 - 1.
        const spectrum = this.source === Source.SPECTRUM;
        const channel = this.channel === Channels.LEFT ? 0 : this.channel === Channels.RIGHT ? 1 : 2;
        this.fa = avsChannel(avsVisdata(this.main), !spectrum, channel, this.fa);
        const fa = this.fa;
        const xorv = spectrum ? 0 : 128;
        // (int) as x86 does it; far off-screen for NaN and overflow.
        const avsPixel = (value, size) => {
            const scaled = (value + 1) * size * 0.5;
            return scaled > -2147483649 && scaled < 2147483648 ? Math.trunc(scaled) : -1000000;
        };
        // AVS's makeint(): (int)(c * 255), 0 below 0, 255 from 1 up.
        const makeint = (value) => {
            const c = Number(value);
            return c >= 1 ? 255 : c > 0 ? Math.trunc(c * 255) : 0;
        };
        const scale = this.main.avsScale || 1;
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        let candraw = false;
        let lx = 0;
        let ly = 0;
        // Fork: code.i, code.x … as slots of the code's WebAssembly memory when it runs as wasm
        // (eel-wasm-backend.ts EelPort); the same reads and writes as properties otherwise.
        const port = (this.port ||= new EelPort("perPoint", POINT)).bind(code);
        for (let a = 0; a < nPoints; a++) {
            const r = (a * 576.0) / nPoints;
            const index = Math.trunc(r);
            const s1 = r - index;
            const yr = (fa[index] ^ xorv) * (1.0 - s1) + (fa[index + 1] ^ xorv) * s1;
            port.set(P_I, a / (nPoints - 1));
            port.set(P_V, yr / 128.0 - 1.0);
            port.set(P_SKIP, 0);
            port.run();
            const x = avsPixel(Number(port.get(P_X)), w);
            const y = avsPixel(Number(port.get(P_Y)), h);
            if (Number(port.get(P_SKIP)) < 0.00001) {
                const thisColor = makeint(port.get(P_BLUE)) | (makeint(port.get(P_GREEN)) << 8) | (makeint(port.get(P_RED)) << 16);
                if (Number(port.get(P_DRAWMODE)) < 0.00001) {
                    if (y >= 0 && y < h && x >= 0 && x < w) {
                        plotter.plot(x + y * w, thisColor);
                    }
                } else if (candraw && (thisColor || line.mode !== BLEND_ADDITIVE)) {
                    const width = Math.trunc(Number(port.get(P_LINESIZE)) + 0.5) || 0;
                    avsLine(plotter, lx, ly, x, y, w, h, thisColor, scale === 1 ? width : Math.round(width * scale));
                }
            }
            candraw = true;
            lx = x;
            ly = y;
        }
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust, run);
    }

    private updateCode() {
        const code = compileExpr(
            this.opts.code,
            ["init", "onBeat", "perFrame", "perPoint"],
        ).codeInst as ISSCodeInstance;
        code.n = 100;
        code.setup(this.main);
        // Fork: AVS registers x and y at 0 and keeps whatever the code last left in them; code
        // that never sets x (Echolot's first list draws a line with y alone) draws at x = 0,
        // where an unset variable here was NaN and the points fell off the screen.
        for (const name of ["x", "y"]) {
            if ((code as any)[name] === undefined) {
                (code as any)[name] = 0;
            }
        }
        this.inited = false;
        this.code = [code];
    }

    private updateClones() {
        this.code = CodeInstance.clone(this.code, this.opts.clone) as ISSCodeInstance[];
    }

    private updateColors() {
        this.colors = map(this.opts.colors, parseColorNorm);
        this.curColorId = 0;
        this.colorPosition = 0;
    }

    private updateSpeed() {
        const oldMaxStep = this.maxStep;
        this.maxStep = Math.floor(1 / this.opts.cycleSpeed);
        if (this.curStep) {
            // curStep adjustment when speed changes
            this.curStep = Math.floor((this.curStep / oldMaxStep) * this.maxStep);
        } else {
            this.curStep = 0;
        }
    }

    private updateChannel() {
        this.channel = Channels[this.opts.channel];
    }

    private updateSource() {
        this.source = Source[this.opts.source];
    }

    private updateDrawMode() {
        this.drawMode = SuperScopeDrawMode[this.opts.drawMode];
    }

    /**
     * Fork: the colour as AVS cycles it (e_superscope.cpp): 64 frames from each
     * colour to the next, weights 63 − r and r over 64 in whole levels, the
     * position moved on before it is used. One colour is drawn at 63/64 of itself.
     */
    private _makeColor(): Color {
        const count = this.colors.length;
        if (!count) {
            return [1, 1, 1];
        }
        this.colorPosition = ((this.colorPosition || 0) + 1) % (count * 64);
        const p = Math.floor(this.colorPosition / 64);
        const r = this.colorPosition & 63;
        const first = this.colors[p];
        const second = this.colors[p + 1 < count ? p + 1 : 0];
        const color: Color = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const a = Math.round(first[i] * 255);
            const b = Math.round(second[i] * 255);
            color[i] = Math.floor((a * (63 - r) + b * r) / 64) / 255;
        }
        return color;
    }

    private handleResize() {
        each(this.code, (code) => {
            code.updateDimVars(this.main.getRctx().getGl());
        });
    }
}
