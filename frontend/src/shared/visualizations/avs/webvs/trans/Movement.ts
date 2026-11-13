// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Movement (Trans / Movement), after Nullsoft's vis_avs r_trans.cpp (BSD
 * licence, see ../LICENSE-vis_avs.txt).
 *
 * AVS works out once, for every pixel, where it takes its colour from, and keeps
 * that table until the code or the screen size changes. movementTable.ts builds
 * the same table with the same arithmetic — the built-in effects with their C
 * formulas (not the script approximations AVS's editor shows), custom code per
 * pixel with d, r, x, y, sw and sh — and the GPU reads it every frame:
 *
 * - bilinear ("subpixel") positions are kept to 1/32 of a pixel and filtered
 *   with AVS's MMX BLEND4 arithmetic (see avsSupport.avsBlend4Glsl);
 * - without wrap, positions are clamped as AVS clamps them (also its quirks: the
 *   built-in effects sample half a pixel down and right of where custom code does);
 * - 50/50 is (a >> 1) + (b >> 1);
 * - "source mapped" pushes every pixel to its table position instead and keeps
 *   the brightest per channel (BLEND_MAX), optionally toggled on each beat.
 *
 * A table at 1280×720 runs the preset's code almost a million times, so it is
 * built in a worker (movementWorker.ts); until it arrives the effect runs as
 * GridMovement, the same code on a fine Dynamic Movement grid, which is also
 * what runs where the GPU cannot hold the table (no float textures).
 */
import Component from "../Component";
import { avsBlend4Glsl, HIGH_PRECISION, keepFrame } from "../avsSupport";
import { WebGLVarType } from "../utils";
import Buffer from "../webgl/Buffer";
import ShaderProgram from "../webgl/ShaderProgram";
import { GridMovement } from "./Extras";
import {
    buildMovementTable, movementEffectId, needsPage, scatterPoints, tableTextureData,
} from "./movementTable";

interface ITableResult {
    data: Float32Array;
    points: Float32Array | null;
    subpixel: boolean;
}

/** One worker for every Movement; jobs answer by id. */
let worker: Worker | null = null;
let workerBroken = false;
let nextJob = 1;
const waiting = new Map<number, (result: ITableResult | null) => void>();

function tableWorker(): Worker | null {
    if (worker || workerBroken) {
        return worker;
    }
    try {
        worker = new Worker(new URL("./movementWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event) => {
            const message = event.data || {};
            const done = waiting.get(message.id);
            waiting.delete(message.id);
            if (done) {
                done(message.error ? null : message);
            }
        };
        worker.onerror = () => {
            // The page builds tables itself from now on.
            workerBroken = true;
            worker = null;
            for (const done of waiting.values()) {
                done(null);
            }
            waiting.clear();
        };
    } catch (error) {
        workerBroken = true;
        worker = null;
    }
    return worker;
}

/** Tests can ask for tables built on the spot, so frame n is the same every run. */
function synchronous(): boolean {
    return Boolean(globalThis.__avsSynchronousTables);
}

export default class Movement extends Component {
    public static componentName: string = "Movement";
    public static componentTag: string = "trans";
    protected static optUpdateHandlers = {
        bilinear: "invalidate",
        builtinEffect: "invalidate",
        code: "invalidate",
        coordinates: "invalidate",
        effectId: "invalidate",
        wrap: "invalidate",
    };
    protected static defaultOptions = {
        bilinear: true,
        builtinEffect: "",
        code: "",
        coordinates: "POLAR",
        onBeatSourceMapped: false,
        output: "Replace",
        sourceMapped: false,
        wrap: false,
    };

    private fallback: Component;
    private exact: boolean;
    private minMax: any;
    private gather: ShaderProgram;
    private start: ShaderProgram;
    private scatter: ShaderProgram;
    private average: ShaderProgram;
    private table: WebGLTexture;
    private tableKey: string;
    private tableSubpixel: boolean;
    private pendingKey: string;
    private pendingJob: number;
    private version: number;
    private points: Buffer;
    private pointCount: number;
    private input;
    private sourceMapped: boolean;
    private effect: number;

    public init() {
        const gl = this.main.getRctx().getGl();
        this.exact = Boolean(gl.getExtension("OES_texture_float"));
        this.fallback = new GridMovement(this.main, this.parent, { ...this.opts, enabled: true });
        this.version = 0;
        this.sourceMapped = Boolean(this.opts.sourceMapped);
        this.effect = movementEffectId(this.opts);
        if (this.exact) {
            this.minMax = gl.getExtension("EXT_blend_minmax");
            this.buildPrograms();
        }
    }

    public draw() {
        if (!this.effect) {
            return;
        }
        if (!this.exact) {
            this.fallback.draw();
            return;
        }
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        if (w < 2 || h < 2) {
            return;
        }
        if (this.opts.onBeatSourceMapped && this.main.getAnalyser().isBeat()) {
            this.sourceMapped = !this.sourceMapped;
        }
        const key = `${w}x${h}:${this.version}`;
        if (this.tableKey !== key) {
            this.requestTable(w, h, key);
            if (this.tableKey !== key) {
                // Not there yet (or the screen just changed size): the grid version.
                this.fallback.draw();
                return;
            }
        }
        const blend = String(this.opts.output || "").indexOf("50") >= 0;
        const tsm = this.parent.getTSM();
        if (!this.sourceMapped) {
            this.gather.run(tsm, {
                blend: blend ? 1 : 0,
                subpixel: this.tableSubpixel ? 1 : 0,
                table: this.table,
            });
            return;
        }
        // Source mapped: every pixel goes to its table position, brightest wins.
        if (!this.input) {
            this.input = keepFrame(this.main);
        }
        this.input.store(tsm.getCurrentTexture());
        this.start.run(tsm, { keep: blend ? 1 : 0 });
        this.scatter.run(tsm, { input: this.input.texture(), points: this.points });
        if (blend) {
            this.average.run(tsm, { input: this.input.texture() });
        }
    }

    public destroy() {
        super.destroy();
        this.fallback.destroy();
        this.cancelPending();
        for (const program of [this.gather, this.start, this.scatter, this.average]) {
            if (program) {
                program.destroy();
            }
        }
        if (this.table) {
            this.main.getRctx().getGl().deleteTexture(this.table);
        }
        if (this.points) {
            this.points.destroy();
        }
        if (this.input) {
            this.input.release();
        }
    }

    /** Code or settings changed: AVS rebuilds the table on the next frame. */
    private invalidate() {
        this.effect = movementEffectId(this.opts);
        this.version++;
        this.cancelPending();
        this.fallback.destroy();
        this.fallback = new GridMovement(this.main, this.parent, { ...this.opts, enabled: true });
    }

    private cancelPending() {
        if (this.pendingJob) {
            waiting.delete(this.pendingJob);
            if (worker) {
                worker.postMessage({ cancel: this.pendingJob });
            }
            this.pendingJob = 0;
        }
        this.pendingKey = null;
    }

    private requestTable(w: number, h: number, key: string) {
        if (this.pendingKey === key) {
            return;
        }
        this.cancelPending();
        const coordinates = String(this.opts.coordinates || "").toUpperCase();
        const options = {
            code: String(this.opts.code || ""),
            // Fork: the preset's EEL dialect (Main.loadPreset), for the worker's compiler too.
            dialect: this.opts._eelDialect === "eel2" ? "eel2" : "ns-eel",
            rect: coordinates === "CARTESIAN" || coordinates === "RECT" || coordinates === "RECTANGULAR",
            subpixel: this.opts.bilinear !== false,
            wrap: Boolean(this.opts.wrap),
        };
        const points = Boolean(this.opts.sourceMapped || this.opts.onBeatSourceMapped);
        const pool = synchronous() || needsPage(this.effect, options.code) ? null : tableWorker();
        if (!pool) {
            const table = buildMovementTable(this.effect, w, h, options, this.main);
            const data = tableTextureData(table.entries, table.subpixel, w, h);
            this.useTable({ data, points: points ? scatterPoints(data, w, h) : null, subpixel: table.subpixel }, w, h, key);
            return;
        }
        const job = nextJob++;
        this.pendingKey = key;
        this.pendingJob = job;
        waiting.set(job, (result) => {
            if (this.pendingJob !== job) {
                return;
            }
            this.pendingJob = 0;
            this.pendingKey = null;
            if (result) {
                this.useTable(result, w, h, key);
            } else {
                // The worker failed: build it here instead, on the next frame.
                const table = buildMovementTable(this.effect, w, h, options, this.main);
                const data = tableTextureData(table.entries, table.subpixel, w, h);
                this.useTable({ data, points: points ? scatterPoints(data, w, h) : null, subpixel: table.subpixel }, w, h, key);
            }
        });
        pool.postMessage({ effect: this.effect, h, id: job, options, points, w });
    }

    private useTable(result: ITableResult, w: number, h: number, key: string) {
        const gl = this.main.getRctx().getGl();
        if (!this.table) {
            this.table = gl.createTexture();
        }
        gl.bindTexture(gl.TEXTURE_2D, this.table);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, result.data);
        if (result.points) {
            if (!this.points) {
                this.points = new Buffer(this.main.getRctx());
            }
            this.points.setData(result.points);
            this.pointCount = w * h;
        }
        this.tableSubpixel = result.subpixel;
        this.tableKey = key;
    }

    private buildPrograms() {
        const rctx = this.main.getRctx();
        this.gather = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    blend: { name: "u_blend", valueType: WebGLVarType._1F },
                    subpixel: { name: "u_subpixel", valueType: WebGLVarType._1F },
                    table: { name: "u_table", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_table;
                uniform float u_blend;
                uniform float u_subpixel;
                ${avsBlend4Glsl()}
                vec3 levelsAt(vec2 pixel) {
                    vec2 uv = (pixel + 0.5) / u_resolution;
                    return floor(texture2D(u_srcTexture, vec2(uv.x, 1.0 - uv.y)).rgb * 255.0 + 0.5);
                }
                void main() {
                    vec2 frag = floor(gl_FragCoord.xy);
                    float row = u_resolution.y - 1.0 - frag.y;
                    vec4 entry = texture2D(u_table, vec2((frag.x + 0.5) / u_resolution.x, (row + 0.5) / u_resolution.y));
                    vec3 moved;
                    if (u_subpixel > 0.5) {
                        moved = avsBlend4(levelsAt(entry.xy), levelsAt(entry.xy + vec2(1.0, 0.0)),
                                          levelsAt(entry.xy + vec2(0.0, 1.0)), levelsAt(entry.xy + vec2(1.0, 1.0)),
                                          entry.z, entry.w);
                    } else {
                        moved = levelsAt(entry.xy);
                    }
                    if (u_blend > 0.5) {
                        vec3 current = floor(getSrcColor().rgb * 255.0 + 0.5);
                        moved = floor(moved * 0.5) + floor(current * 0.5);
                    }
                    setFragColor(vec4(moved / 255.0, 1.0));
                }`,
            swapFrame: true,
        });
        this.start = new ShaderProgram(rctx, {
            bindings: { uniforms: { keep: { name: "u_keep", valueType: WebGLVarType._1F } } },
            fragmentShader: `
                uniform float u_keep;
                void main() {
                    setFragColor(u_keep > 0.5 ? vec4(getSrcColor().rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0));
                }`,
            swapFrame: true,
        });
        const minMax = this.minMax;
        this.scatter = new ShaderProgram(rctx, {
            bindings: {
                attribs: { points: { name: "a_point", size: 4 } },
                uniforms: { input: { name: "u_input", valueType: WebGLVarType.TEXTURE2D } },
            },
            drawHook: (values, glContext) => {
                // BLEND_MAX: the brightest of all pixels landing on one spot.
                glContext.enable(glContext.BLEND);
                glContext.blendFunc(glContext.ONE, glContext.ONE);
                if (minMax) {
                    glContext.blendEquation(minMax.MAX_EXT);
                } else {
                    glContext.disable(glContext.BLEND);
                }
                glContext.drawArrays(glContext.POINTS, 0, this.pointCount);
                glContext.blendEquation(glContext.FUNC_ADD);
                return false;
            },
            vertexShader: `
                attribute vec4 a_point;
                varying vec2 v_source;
                void main() {
                    v_source = a_point.zw;
                    gl_PointSize = 1.0;
                    setPosition(a_point.xy);
                }`,
            fragmentShader: `
                uniform sampler2D u_input;
                varying vec2 v_source;
                void main() {
                    setFragColor(vec4(texture2D(u_input, v_source).rgb, 1.0));
                }`,
        });
        this.average = new ShaderProgram(rctx, {
            bindings: { uniforms: { input: { name: "u_input", valueType: WebGLVarType.TEXTURE2D } } },
            fragmentShader: `
                uniform sampler2D u_input;
                void main() {
                    vec3 mapped = floor(getSrcColor().rgb * 255.0 + 0.5);
                    vec3 original = floor(texture2D(u_input, v_position).rgb * 255.0 + 0.5);
                    setFragColor(vec4((floor(mapped * 0.5) + floor(original * 0.5)) / 255.0, 1.0));
                }`,
            swapFrame: true,
        });
    }
}
