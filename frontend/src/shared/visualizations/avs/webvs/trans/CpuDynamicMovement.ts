// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Dynamic Movement with the per-pixel code run on the CPU, the way AVS runs it
 * (grandchild/vis_avs e_dynamicmovement.cpp, BSD licence).
 *
 * The code runs at the points of a grid (gridW + 1 by gridH + 1, at least
 * 2 × 2) and the source position is interpolated between them. Per point:
 * x and y are −1…1 across the screen (y downwards); d is the distance from the
 * centre in pixels over half the screen's diagonal (1 at a corner) and r the
 * angle, measured so the code sees what AVS gives it. webvs translated this to
 * GLSL with its own idea of d (44% larger on a 16:9 screen) and could not
 * express registers, loops or megabuf; here every section is compiled by
 * ../../eel.ts and the shader only receives where each point samples from.
 *
 * The source is the frame itself or one of AVS's global buffers. "Blend" mixes
 * the result over the frame by alpha; "alpha only" does not move at all and
 * only mixes the source (or black, for the frame itself) in by alpha.
 *
 * Where float textures exist (everywhere WebGL runs AVS), the grid is r_dmove.cpp's to the bit:
 * its points sit on (w << 16) / gridW steps, the code's x, y, d, r and alpha become 16.16
 * positions with (int), and dmoveTable.ts walks between them as AVS did, in integers; the shader
 * then reads each pixel's source with BLEND4_16 (or the pixel itself) and blends by alpha with
 * the MMX BLEND_ADJ of Winamp's AVS 2.81, (s·a + d·(255 − a)) >> 8. The mesh below, drawn by
 * the GPU's interpolation, is what runs without float textures.
 */
import Component from "../Component";
import compileExpr from "../expr/compileExpr";
import Buffer from "../webgl/Buffer";
import { BlendMode, WebGLVarType } from "../utils";
import { avsBilinearGlsl, avsBlend4Glsl, HIGH_PRECISION } from "../avsSupport";
import ShaderProgram from "../webgl/ShaderProgram";
import DynamicMovement from "./DynamicMovement";
import { dmoveGrid, dmoveGridArray, dmovePixels, dmoveResolution, dmoveRows } from "./dmoveTable";

const MAX_GRID = 161;

/**
 * GLSL: a pixel's entry from the cell walk (dmoveTable.ts dmoveRows): its cell and offset j from
 * u_columns, the cell's start and step (high part >> 8, low byte) for x, y and alpha from three
 * texels of u_table, and position >> 8 = start_hi + j * step_hi + floor((start_lo + j * step_lo)
 * / 256), exact in floats (dmoveAt); with wrap folded by u_period (w_adj / 256 and h_adj / 256).
 */
const WALK_GLSL = `
    uniform sampler2D u_columns;
    uniform float u_cells;
    uniform vec2 u_period;
    float walkAt(vec4 q, float j) {
        return q.x + j * q.z + floor((q.y + j * q.w) / 256.0);
    }
    vec4 entryAt(vec2 frag, float row) {
        vec4 column = texture2D(u_columns, vec2((frag.x + 0.5) / u_resolution.x, 0.5));
        float v = (row + 0.5) / u_resolution.y;
        float base = 3.0 * column.x;
        float width = 3.0 * u_cells;
        vec4 qx = texture2D(u_table, vec2((base + 0.5) / width, v));
        vec4 qy = texture2D(u_table, vec2((base + 1.5) / width, v));
        vec4 qa = texture2D(u_table, vec2((base + 2.5) / width, v));
        float x8 = walkAt(qx, column.y);
        float y8 = walkAt(qy, column.y);
        if (u_period.x > 0.0) {
            x8 -= u_period.x * floor(x8 / u_period.x);
            y8 -= u_period.y * floor(y8 / u_period.y);
        }
        float sx = floor(x8 / 256.0);
        float sy = floor(y8 / 256.0);
        return vec4(sx, sy, (x8 - sx * 256.0) + 256.0 * (y8 - sy * 256.0), floor(walkAt(qa, column.y) / 256.0));
    }`;

export default class CpuDynamicMovement extends Component {
    public static componentName: string = "DynamicMovement";
    public static componentTag: string = "trans";
    protected static optUpdateHandlers = {
        bFilter: "updateProgram",
        blend: "updateProgram",
        code: "updateCode",
        coord: "updateCode",
        gridH: "updateGrid",
        gridW: "updateGrid",
        noGrid: "updateGrid",
    };
    protected static defaultOptions = {
        alphaOnly: false,
        bFilter: true,
        blend: false,
        code: { init: "", onBeat: "", perFrame: "", perPixel: "" },
        compat: false,
        coord: "POLAR",
        gridH: 16,
        gridW: 16,
        noGrid: false,
        wrap: false,
    };

    private code: any;
    private inited: boolean;
    private program: ShaderProgram;
    private positions: Buffer;
    private sources: Buffer;
    private cols: number;
    private rows: number;
    private corners: Uint32Array;
    private sourceData: Float32Array;
    private pointX: Float32Array;
    private pointY: Float32Array;
    private pointAlpha: Float32Array;
    private exact: boolean;
    private exactProgram: ShaderProgram;
    private walkProgram: ShaderProgram;
    private table: WebGLTexture;
    private columnsTexture: WebGLTexture;
    private walk: { cells: number; columns: Float32Array; rows: Float32Array };
    private grid: Int32Array;
    private pixels: Float32Array;

    constructor(main, parent, opts) {
        super(main, parent, DynamicMovement.fromConverter(opts));
    }

    public init() {
        this.exact = Boolean(this.main.getRctx().getGl().getExtension("OES_texture_float"));
        this.updateCode();
        this.updateProgram();
        this.updateGrid();
        this.listenTo(this.main, "resize", () => this.updateGrid());
    }

    public draw() {
        // AVS: a movement that reads a buffer nothing has saved does nothing.
        let input = this.parent.getTSM().getCurrentTexture();
        const buffer = this.opts.sourceBuffer;
        if (buffer) {
            if (!this.main.avsWrittenBuffers || !this.main.avsWrittenBuffers.has(buffer)) {
                return;
            }
            try {
                input = this.main.getTempTSM().getTexture(buffer);
            } catch (missing) {
                return;
            }
        }

        const code = this.code;
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const beat = this.main.getAnalyser().isBeat();
        // Once per frame, as AVS does: w, h, b and alpha = 0.5.
        code.w = w;
        code.h = h;
        code.b = beat ? 1 : 0;
        code.alpha = 0.5;
        if (!this.inited) {
            code.init();
            this.inited = true;
        }
        code.perFrame();
        if (beat) {
            code.onBeat();
        }
        if (this.exact && !this.opts.noGrid) {
            this.drawExact(input, w, h, Boolean(buffer));
            return;
        }

        const halfW = w / 2;
        const halfH = h / 2;
        const maxD = Math.sqrt(w * w + h * h) / 2;
        const polar = String(this.opts.coord).toUpperCase() !== "RECT";
        const still = Boolean(this.opts.alphaOnly);
        const cols = this.cols;
        const rows = this.rows;
        // AVS clamps the grid (without wrap) to the last pixel a read can start
        // at; wrapping happens per pixel, after interpolation (in the shader).
        const wrap = Boolean(this.opts.wrap);
        const limitX = this.opts.bFilter ? w - 2 : w - 1;
        const limitY = this.opts.bFilter ? h - 2 : h - 1;
        // AVS keeps positions in 16.16 fixed point, cast with (int).
        const fixed = (value) => {
            const scaled = value * 65536;
            return (scaled > -2147483649 && scaled < 2147483648 ? Math.trunc(scaled) : -2147483648) / 65536;
        };
        for (let row = 0; row < rows; row++) {
            // Row 0 is the top of the screen; grid row i sits on pixel row i·h/(rows − 1).
            const yd = (row / (rows - 1)) * h - halfH;
            for (let col = 0; col < cols; col++) {
                const xd = (col / (cols - 1)) * w - halfW;
                code.x = xd / halfW;
                code.y = yd / halfH;
                code.d = Math.sqrt(xd * xd + yd * yd) / maxD;
                code.r = Math.atan2(yd, xd) + Math.PI / 2;
                code.perPixel();
                if (polar) {
                    // As AVS: d and r stay converted (d·max_screen_d in 16.16, r − π/2) for the
                    // next frame's per-frame code (dmoveTable.ts dmoveGrid).
                    code.d = Number(code.d) * maxD * 65536;
                    code.r = Number(code.r) - Math.PI / 2;
                }
                // Where this point samples from, in AVS pixels (x right, y down).
                let px;
                let py;
                if (still) {
                    px = xd + halfW;
                    py = yd + halfH;
                } else if (polar) {
                    const distance = Number(code.d) / 65536;
                    const angle = Number(code.r);
                    px = fixed(halfW + Math.cos(angle) * distance);
                    py = fixed(halfH + Math.sin(angle) * distance);
                } else {
                    px = fixed((Number(code.x) + 1) * halfW);
                    py = fixed((Number(code.y) + 1) * halfH);
                }
                if (!wrap) {
                    px = Math.max(0, Math.min(limitX, px));
                    py = Math.max(0, Math.min(limitY, py));
                }
                const index = row * cols + col;
                this.pointX[index] = px;
                this.pointY[index] = py;
                const alpha = Number(code.alpha);
                this.pointAlpha[index] = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0.5;
            }
        }
        // The mesh is drawn half a pixel right and down (a fragment's centre is
        // AVS's pixel corner), its first column and row stretched to the screen's
        // edge: their values are carried on by that half pixel.
        const outX = 0.5 / (w / (cols - 1));
        const outY = 0.5 / (h / (rows - 1));
        for (const values of [this.pointX, this.pointY, this.pointAlpha]) {
            for (let row = 0; row < rows; row++) {
                const first = row * cols;
                values[first] -= (values[first + 1] - values[first]) * outX;
            }
            for (let col = 0; col < cols; col++) {
                values[col] -= (values[cols + col] - values[col]) * outY;
            }
        }
        const corners = this.corners;
        const data = this.sourceData;
        for (let vertex = 0; vertex < corners.length; vertex++) {
            const point = corners[vertex];
            data[vertex * 3] = this.pointX[point];
            data[vertex * 3 + 1] = this.pointY[point];
            data[vertex * 3 + 2] = this.pointAlpha[point];
        }
        this.sources.setData(data);
        this.program.run(this.parent.getTSM(), {
            grid: this.positions,
            input,
            source: this.sources,
            useInput: still && !buffer ? 0 : 1,
        });
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        for (const program of [this.exactProgram, this.walkProgram]) {
            if (program) {
                program.destroy();
            }
        }
        for (const texture of [this.table, this.columnsTexture]) {
            if (texture) {
                this.main.getRctx().getGl().deleteTexture(texture);
            }
        }
        if (this.positions) {
            this.positions.destroy();
        }
        if (this.sources) {
            this.sources.destroy();
        }
    }

    /** r_dmove.cpp: the grid with AVS's arithmetic, the walk in integers, one pixel at a time. */
    private drawExact(input, w: number, h: number, fromBuffer: boolean) {
        const code = this.code;
        const [xres, yres] = dmoveResolution(this.opts.gridW, this.opts.gridH);
        const subpixel = Boolean(this.opts.bFilter);
        const wrap = Boolean(this.opts.wrap);
        const rect = String(this.opts.coord).toUpperCase() === "RECT";
        if (!this.grid || this.grid.length !== xres * yres * 3 + xres * 6 + 6) {
            this.grid = dmoveGridArray(xres, yres);
        }
        if (!this.pixels || this.pixels.length !== w * h * 4) {
            this.pixels = new Float32Array(w * h * 4);
        }
        const grid = this.grid;
        dmoveGrid(code, w, h, xres, yres, subpixel, wrap, rect, Boolean(!code.compiled || code.compiled.perPixel), grid);
        const still = Boolean(this.opts.alphaOnly);
        const gl = this.main.getRctx().getGl();
        const upload = (texture: WebGLTexture, width: number, height: number, data: Float32Array) => {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, data);
        };
        if (!this.table) {
            this.table = gl.createTexture();
        }
        // The walk down to cells on the CPU, the pixels on the GPU; where the GPU could not follow
        // it exactly (or AVS stopped early), every pixel on the CPU.
        if (!this.walk) {
            this.walk = { cells: 0, columns: new Float32Array(0), rows: new Float32Array(0) };
        }
        if (dmoveRows(w, h, xres, yres, grid, subpixel, wrap, this.walk)) {
            if (!this.columnsTexture) {
                this.columnsTexture = gl.createTexture();
            }
            upload(this.columnsTexture, w, 1, this.walk.columns);
            upload(this.table, this.walk.cells * 3, h, this.walk.rows);
            if (!this.walkProgram) {
                this.walkProgram = this.buildExactProgram(true);
            }
            this.walkProgram.run(this.parent.getTSM(), {
                input,
                table: this.table,
                columns: this.columnsTexture,
                cells: this.walk.cells,
                period: wrap ? [(subpixel ? w - 2 : w - 1) * 256, (subpixel ? h - 2 : h - 1) * 256] : [0, 0],
                fromFrame: fromBuffer ? 0 : 1,
            });
            return;
        }
        dmovePixels(w, h, xres, yres, grid, subpixel, wrap, still, this.pixels);
        upload(this.table, w, h, this.pixels);
        if (!this.exactProgram) {
            this.exactProgram = this.buildExactProgram(false);
        }
        this.exactProgram.run(this.parent.getTSM(), { input, table: this.table, fromFrame: fromBuffer ? 0 : 1 });
    }

    /** `walk`: each pixel finds its cell and steps in (dmoveRows); otherwise one entry a pixel. */
    private buildExactProgram(walk: boolean): ShaderProgram {
        const subpixel = Boolean(this.opts.bFilter);
        const blend = Boolean(this.opts.blend);
        const still = Boolean(this.opts.alphaOnly);
        const moved = subpixel
            ? `float fy = floor(entry.z / 256.0);
               float fx = entry.z - fy * 256.0;
               vec3 moved = avsBlend4(levelAt(entry.xy), levelAt(entry.xy + vec2(1.0, 0.0)),
                   levelAt(entry.xy + vec2(0.0, 1.0)), levelAt(entry.xy + vec2(1.0, 1.0)), fx, fy);`
            : "vec3 moved = levelAt(entry.xy);";
        const body = still
            ? `vec3 source = u_fromFrame > 0.5 ? vec3(0.0) : levelAt(vec2(frag.x, row));
               vec3 result = floor((source * entry.w + current * (255.0 - entry.w)) / 256.0);`
            : `${moved}
               vec3 result = ${blend ? "floor((moved * entry.w + current * (255.0 - entry.w)) / 256.0)" : "moved"};`;
        return new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    input: { name: "u_input", valueType: WebGLVarType.TEXTURE2D },
                    table: { name: "u_table", valueType: WebGLVarType.TEXTURE2D },
                    fromFrame: { name: "u_fromFrame", valueType: WebGLVarType._1F },
                    ...(walk ? {
                        columns: { name: "u_columns", valueType: WebGLVarType.TEXTURE2D },
                        cells: { name: "u_cells", valueType: WebGLVarType._1F },
                        period: { name: "u_period", valueType: WebGLVarType._2FV },
                    } : {}),
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_input;
                uniform sampler2D u_table;
                uniform float u_fromFrame;
                ${avsBlend4Glsl()}
                vec3 levelAt(vec2 pixel) {
                    vec2 uv = (pixel + 0.5) / u_resolution;
                    return floor(texture2D(u_input, vec2(uv.x, 1.0 - uv.y)).rgb * 255.0 + 0.5);
                }
                ${walk ? WALK_GLSL : ""}
                void main() {
                    vec2 frag = floor(gl_FragCoord.xy);
                    float row = u_resolution.y - 1.0 - frag.y;
                    vec4 entry = ${walk ? "entryAt(frag, row)" : "texture2D(u_table, vec2((frag.x + 0.5) / u_resolution.x, (row + 0.5) / u_resolution.y))"};
                    vec3 current = floor(getSrcColor().rgb * 255.0 + 0.5);
                    if (entry.x < 0.0) {
                        // AVS ended the frame early and left this pixel as it was.
                        setFragColor(vec4(current / 255.0, 1.0));
                        return;
                    }
                    ${body}
                    setFragColor(vec4(result / 255.0, 1.0));
                }`,
            swapFrame: true,
        });
    }

    private updateCode() {
        // Every section to JavaScript, per-pixel included: no GLSL translation.
        const compileResult = compileExpr(this.opts.code, ["init", "onBeat", "perFrame", "perPixel"], [], []);
        const code = compileResult.codeInst;
        code.setup(this.main);
        for (const name of ["x", "y", "d", "r", "b", "alpha"]) {
            if (code[name] === undefined) {
                code[name] = 0;
            }
        }
        this.code = code;
        this.inited = false;
    }

    private updateGrid() {
        // AVS: grid_w + 1 points across (and grid_h + 1 down), never fewer than 2.
        const opts = this.opts;
        const cols = opts.noGrid ? 97 : Math.max(2, Math.min(MAX_GRID, Math.round(Number(opts.gridW) || 0) + 1));
        const rows = opts.noGrid ? 73 : Math.max(2, Math.min(MAX_GRID, Math.round(Number(opts.gridH) || 0) + 1));
        this.cols = cols;
        this.rows = rows;
        const cells = (cols - 1) * (rows - 1);
        const gl = this.main.getRctx().getGl();
        const w = Math.max(2, gl.drawingBufferWidth);
        const h = Math.max(2, gl.drawingBufferHeight);
        const positions = new Float32Array(cells * 6 * 2);
        const corners = new Uint32Array(cells * 6);
        let vertex = 0;
        for (let row = 0; row < rows - 1; row++) {
            for (let col = 0; col < cols - 1; col++) {
                const quad = [
                    [col, row], [col + 1, row], [col, row + 1],
                    [col + 1, row], [col + 1, row + 1], [col, row + 1],
                ];
                for (const [c, r] of quad) {
                    // Grid point c sits on AVS pixel c·w/(cols − 1), and a pixel's
                    // fragment centre is half a pixel further on: the mesh moves
                    // by that much (its first column and row reach the edge).
                    const x = c === 0 ? 0 : (c * w) / (cols - 1) + 0.5;
                    const y = r === 0 ? 0 : (r * h) / (rows - 1) + 0.5;
                    positions[vertex * 2] = -1 + (2 * x) / w;
                    // Row 0 at the top (y = 1 in clip space).
                    positions[vertex * 2 + 1] = 1 - (2 * y) / h;
                    corners[vertex] = r * cols + c;
                    vertex++;
                }
            }
        }
        this.corners = corners;
        this.sourceData = new Float32Array(cells * 6 * 3);
        this.pointX = new Float32Array(cols * rows);
        this.pointY = new Float32Array(cols * rows);
        this.pointAlpha = new Float32Array(cols * rows);
        const rctx = this.main.getRctx();
        if (!this.positions) {
            this.positions = new Buffer(rctx);
        }
        if (!this.sources) {
            this.sources = new Buffer(rctx);
        }
        this.positions.setData(positions);
    }

    private updateProgram() {
        for (const program of [this.exactProgram, this.walkProgram]) {
            if (program) {
                program.destroy();
            }
        }
        this.exactProgram = null;
        this.walkProgram = null;
        const rctx = this.main.getRctx();
        // The source position in AVS's pixels: (x + 1)·w/2 across, y downwards.
        // Bilinear is AVS's own integer filter (see avsSupport); nearest takes
        // the pixel the position falls in.
        // Wrap: AVS moves a position back by one period once (w - 2 pixels with
        // bilinear, w - 1 without); otherwise clamped (the grid already is).
        const period = this.opts.bFilter ? "(u_resolution - 2.0)" : "(u_resolution - 1.0)";
        const place = this.opts.wrap
            ? `pixel += ${period} * (step(pixel, vec2(-0.000001)) - step(${period}, pixel));
               pixel = mod(pixel, ${period});`
            : `pixel = clamp(pixel, vec2(0.0), ${period} - 1.0 / 256.0);`;
        const filter = this.opts.bFilter
            ? `
            ${HIGH_PRECISION}
            ${avsBilinearGlsl("avsBilinear", "u_input")}
            vec3 filter(vec2 pixel) {
               ${place}
               return avsBilinear(pixel);
            }`
            : `
            ${HIGH_PRECISION}
            vec3 filter(vec2 pixel) {
               ${place}
               vec2 at = (floor(pixel) + 0.5) / u_resolution;
               return texture2D(u_input, vec2(at.x, 1.0 - at.y)).rgb;
            }`;
        const blend = Boolean(this.opts.blend) || Boolean(this.opts.alphaOnly);
        // "Blend" (and "alpha only") mix the result over the frame as AVS does,
        // in whole levels that round down: by the code's alpha (blend_adjustable),
        // or half and half for Movement's 50/50 ((a >> 1) + (b >> 1)).
        const mix = !blend
            ? "setFragColor(vec4(moved, 1.0));"
            : `
                   vec3 current = floor(getSrcColor().rgb * 255.0 + 0.5);
                   vec3 next = floor(moved * 255.0 + 0.5);
                   ${this.opts.averageBlend
                       ? "vec3 result = floor(next * 0.5) + floor(current * 0.5);"
                       : `float level = floor(clamp(v_alpha, 0.0, 1.0) * 255.0);
                   vec3 result = floor(next * level / 255.0) + floor(current * (255.0 - level) / 255.0);`}
                   setFragColor(vec4(result / 255.0, 1.0));`;
        const program = new ShaderProgram(rctx, {
            blendMode: BlendMode.REPLACE,
            bindings: {
                attribs: {
                    grid: { name: "a_position", drawMode: rctx.getGl().TRIANGLES },
                    source: { name: "a_source", size: 3 },
                },
                uniforms: {
                    input: { name: "u_input", valueType: WebGLVarType.TEXTURE2D },
                    useInput: { name: "u_useInput", valueType: WebGLVarType._1F },
                },
            },
            // The grid covers the whole screen, so nothing needs copying over.
            swapFrame: true,
            vertexShader: `
                attribute vec2 a_position;
                attribute vec3 a_source;
                varying vec2 v_newPoint;
                varying float v_alpha;
                void main() {
                    v_newPoint = a_source.xy;
                    v_alpha = a_source.z;
                    setPosition(a_position);
                }
            `,
            fragmentShader: `
                ${HIGH_PRECISION}
                varying vec2 v_newPoint;
                varying float v_alpha;
                uniform sampler2D u_input;
                uniform float u_useInput;
                ${filter}
                void main() {
                   vec3 moved = filter(v_newPoint) * u_useInput;
                   ${mix}
                }
            `,
        });
        if (this.program) {
            this.program.destroy();
        }
        this.program = program;
    }
}
