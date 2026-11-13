// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Render / Triangle (TomyLobo's APE, "Render: Triangle"): filled triangles from code, the way
 * grandchild/vis_avs's e_triangle.cpp draws them (the APE's own source is not around; that port
 * keeps its quirks), pixel for pixel through avsDraw's plotter.
 *
 * - Variables: n is 0 before the init code, which runs once; w and h hold the frame size, also
 *   in init (grandchild sets them only after it, so h is 0 there; but "3 zebras (yathosho's
 *   stereovision mix)" and "destroy dat!" take n1 = h, h/3 in init and drew in AVS). Every frame
 *   before the frame code x1 … y3 are 0 and red1, green1, blue1 are 1 (white): presets that
 *   never set a colour draw white triangles. `b` is not the beat here, the APE does not set it
 *   (grandchild's presets decay their own b), and `i` is not reset before the frame code.
 * - n is rounded (C's round); triangle k runs the point code with skip = 0 and i = drawn/(n − 1)
 *   (skipped ones do not count); skip ≠ 0 leaves it out.
 * - Corners to pixels: (v + 1) · (size − 1)/2 cut to an int; rows from the top corner's (left out
 *   when the corner is on it, as above the frame) down to the bottom one's (left out); each row
 *   from one edge's x to the other's, integer arithmetic, the right end left out and never the
 *   last column — triangleSpans().
 * - Colour (int)(c · 255) through the int max/min of vis_avs's platform.h: 0 below 0, 255 from 1
 *   up, 0 for NaN and for values past 2^31 / 255.
 * - Blending: the line blend mode (Set Render Mode), each row a fill of BLEND_LINE writes.
 *   With zbuf ≠ 0 a triangle goes through the depth buffer one Triangle shares with every other:
 *   a pixel takes the colour (replacing it) where z1 · 100000 (40000 at most, 0 below 0) is at
 *   least what the buffer holds, and keeps that depth. zbclear ≠ 0 empties it before drawing.
 */
import Component from "../Component";
import compileExpr from "../expr/compileExpr";
import { avsLineMode, avsPlotter } from "../avsDraw";
import { cpuFrameRun } from "../cpuFrameRun";
import { cInt, triangleChannel, triangleDepth, triangleScreen, triangleSpans } from "./triangleRaster";

/** A bound on n per frame (e_triangle.cpp has none; n = 10^9 would hang the page). */
const MAX_TRIANGLES = 1 << 20;

/** The depth buffer every Triangle of one renderer shares (a static in e_triangle.cpp). */
interface IDepthBuffer {
    width: number;
    height: number;
    depth: Float64Array;
    users: number;
}
const depthBuffers = new WeakMap<object, IDepthBuffer>();

export default class Triangle extends Component {
    public static componentName: string = "Triangle";
    public static componentTag: string = "render";
    protected static defaultOptions = { code: { init: "", perFrame: "", onBeat: "", perPoint: "" } };

    // No initializers: init() (from the base constructor) sets these before they would run.
    private code;
    private inited: boolean;
    private depthKey: object;

    public init() {
        const code = compileExpr(this.opts.code || {}, ["init", "perFrame", "onBeat", "perPoint"]).codeInst;
        code.setup(this.main);
        for (const name of ["w", "h", "n", "i", "skip", "x1", "y1", "x2", "y2", "x3", "y3", "red1", "green1", "blue1",
            "red2", "green2", "blue2", "red3", "green3", "blue3", "z1", "zbuf", "zbclear"]) {
            if (code[name] === undefined) {
                code[name] = 0;
            }
        }
        this.code = code;
        this.inited = false;
        this.depthKey = this.main.getRctx();
        const shared = depthBuffers.get(this.depthKey);
        if (shared) {
            shared.users++;
        } else {
            depthBuffers.set(this.depthKey, { depth: new Float64Array(0), height: -1, users: 1, width: -1 });
        }
    }

    public draw() {
        // A user of the processor's frame run (cpuFrameRun.ts), as a Super Scope: the plotter may
        // blend into a frame the effect before left there, or leave it there for the next.
        const run = cpuFrameRun(this.main);
        try {
            this.drawTriangles(run);
        } finally {
            run.finish(this.main);
        }
    }

    public destroy() {
        super.destroy();
        const shared = this.depthKey && depthBuffers.get(this.depthKey);
        if (shared && --shared.users <= 0) {
            depthBuffers.delete(this.depthKey);
        }
    }

    private drawTriangles(run) {
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const code = this.code;
        const beat = this.main.getAnalyser().isBeat();
        if (!this.inited) {
            code.w = w;
            code.h = h;
            code.n = 0;
            code.init();
            this.inited = true;
        }
        // Triangle_Vars::init(), every frame before the frame code; i stays as the last frame left it.
        code.w = w;
        code.h = h;
        code.x1 = 0; code.y1 = 0; code.x2 = 0; code.y2 = 0; code.x3 = 0; code.y3 = 0;
        code.red1 = 1; code.green1 = 1; code.blue1 = 1;
        code.red2 = 1; code.green2 = 1; code.blue2 = 1;
        code.red3 = 1; code.green3 = 1; code.blue3 = 1;
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        const shared = depthBuffers.get(this.depthKey);
        if (Number(code.zbclear) !== 0 || shared.width !== w || shared.height !== h) {
            if (shared.depth.length !== w * h) {
                shared.depth = new Float64Array(w * h);
            } else {
                shared.depth.fill(0);
            }
            shared.width = w;
            shared.height = h;
        }
        // (int)round(n): for the counts that draw (n ≥ 0.5) Math.round is C's round.
        const count = Math.min(MAX_TRIANGLES, cInt(Math.round(Number(code.n))));
        if (!(count > 0)) {
            return;
        }
        const line = avsLineMode(this.main);
        const plotter = avsPlotter(this.main);
        const tsm = this.parent.getTSM();
        const depth = shared.depth;
        const step = count > 1 ? 1.0 / (count - 1.0) : 1.0;
        const wHalf = (w - 1) / 2.0;
        const hHalf = (h - 1) / 2.0;
        let i = 0.0;
        // The writes of a run of triangles drawn the same way go to the plotter together; a
        // depth-buffered triangle replaces pixels whatever the line blend mode says.
        let mode = -1;
        let writes = false;
        let color = 0;
        let z = 0;
        const fill = (y: number, x: number, k: number) => {
            plotter.span(x, y, k, 1, color);
            writes = true;
        };
        const fillDepth = (y: number, x: number, k: number) => {
            const row = y * w;
            let start = -1;
            for (let at = x; at < x + k; at++) {
                if (z >= depth[row + at]) {
                    depth[row + at] = z;
                    if (start < 0) {
                        start = at;
                    }
                } else if (start >= 0) {
                    plotter.span(start, y, at - start, 1, color);
                    start = -1;
                }
            }
            if (start >= 0) {
                plotter.span(start, y, x + k - start, 1, color);
            }
            writes = true;
        };
        code.i = i;
        for (let k = 0; k < count; k++) {
            code.skip = 0;
            code.perPoint();
            if (Number(code.skip) !== 0) {
                continue;
            }
            const useDepth = Number(code.zbuf) !== 0;
            const want = useDepth ? 0 : line.mode;
            if (want !== mode) {
                if (writes) {
                    plotter.flush(tsm, mode, mode === line.mode ? line.adjust : 0, run);
                    writes = false;
                }
                plotter.begin(w, h);
                mode = want;
            }
            color = triangleChannel(code.blue1) | (triangleChannel(code.green1) << 8) | (triangleChannel(code.red1) << 16);
            z = triangleDepth(Number(code.z1));
            triangleSpans(
                triangleScreen(code.x1, wHalf), triangleScreen(code.y1, hHalf),
                triangleScreen(code.x2, wHalf), triangleScreen(code.y2, hHalf),
                triangleScreen(code.x3, wHalf), triangleScreen(code.y3, hHalf),
                w, h, useDepth ? fillDepth : fill);
            i += step;
            code.i = i;
        }
        if (writes) {
            plotter.flush(tsm, mode, mode === line.mode ? line.adjust : 0, run);
        }
    }
}
