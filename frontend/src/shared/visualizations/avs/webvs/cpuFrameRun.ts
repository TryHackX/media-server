// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * The frame kept on the processor across a run of effects that draw it there (Texer II, a Super
 * Scope or Triangle whose writes the plotter blends there, moving Grain, a Convolution Filter whose
 * kernel reads the rows it has written), so it is read back from the GPU once where
 * the run starts and sent back once where it ends, instead of once per effect. Hboy — 01 Intro
 * has 176 Texer IIs in a row: 176 read-backs and uploads of a 1280×720 frame took ~680 ms a
 * frame; OnionRing — 15 has 27 Super Scopes in a row blending 50/50 (one read-back each).
 *
 * EffectList drives it: before drawing a child it says whether the next child it will draw also
 * works on the processor's frame (`main.avsCpuRunNext`), skipping children that touch neither the
 * frame nor GL (Comment, Set Render Mode, Custom BPM). A user of the run takes the frame with
 * acquire() (read back unless the run already holds it), draws into it, marks it changed() and
 * calls finish(), which sends it back unless the run goes on; the list flushes after its last
 * child too. The result is the same frame: each effect starts from the previous one's pixels.
 *
 * Sending back: a frame a Texer II drew into goes back whole, as the copy Texer II made after
 * each of its frames (the colour, alpha 1, drawn into the other texture of the set). A frame only
 * the plotter (avsDraw.ts) blended into goes back as the plotter drew before: the rectangle it
 * wrote, into the frame itself, every pixel as read back except the written ones (alpha 1 there,
 * as the plotter's draws leave it).
 *
 * (A test page may set __avsCpuRun = false to read back and upload around every effect again,
 * and __avsPlotterFast = false for the plotter's pixel lists as before 10.11, outside any run.)
 */
import { HIGH_PRECISION } from "./avsSupport";
import { WebGLVarType } from "./utils";
import Buffer from "./webgl/Buffer";
import ShaderProgram from "./webgl/ShaderProgram";

/** Children that neither touch the frame nor GL: a run goes on across them. */
const NEUTRAL = new Set(["Comment", "SetRenderMode", "CustomBPM"]);
/** Children that draw on the processor's frame through the run. */
const USERS = new Set(["TexerII"]);

/**
 * Whether the plotter takes its writes as rectangles and blends on the run's frame (avsDraw.ts);
 * a test page compares with the pixel lists from before with __avsPlotterFast = false (the older
 * switches __avsPlotterDirect and __avsPlotterAll = false also mean the lists).
 */
export function plotterFast(): boolean {
    const page = globalThis as any;
    return page.__avsPlotterFast !== false && page.__avsPlotterDirect !== false && page.__avsPlotterAll !== false;
}

function kind(component): "user" | "neutral" | "other" {
    const name = component && component.constructor && component.constructor.componentName;
    // avsCpuFrameUser: a component that draws on the processor only in some settings (a Convolution
    // Filter whose kernel reads the rows it has written, moving Grain).
    if (USERS.has(name) || ((name === "SuperScope" || name === "Triangle") && plotterFast()) || (component && component.avsCpuFrameUser === true)) {
        return "user";
    }
    return NEUTRAL.has(name) ? "neutral" : "other";
}

/**
 * For EffectList's loop: whether the first child after `index` that will be drawn (`drawn(child)`),
 * past neutral ones, works on the processor's frame.
 */
export function cpuRunContinues(components: any[], index: number, drawn: (component) => boolean): boolean {
    if ((globalThis as any).__avsCpuRun === false) {
        return false;
    }
    for (let k = index + 1; k < components.length; k++) {
        const child = components[k];
        if (!drawn(child)) {
            continue;
        }
        const which = kind(child);
        if (which === "neutral") {
            continue;
        }
        return which === "user";
    }
    return false;
}

export class CpuFrameRun {
    private gl: WebGLRenderingContext;
    private program: ShaderProgram;
    private upload: WebGLTexture | null = null;
    private raw: Uint8Array = new Uint8Array(0);
    private pixels: Uint8Array = new Uint8Array(0);
    /** The same pixels as 32-bit words (R in the low byte), for the plotter. */
    public pixels32: Uint32Array = new Uint32Array(0);
    private width = 0;
    private height = 0;
    private owner = null;
    private pending = false;
    /** A Texer II drew into the pending frame: it goes back whole (see the top). */
    private whole = false;
    /** What the plotter wrote: columns x0…x1 − 1 of rows y0…y1 − 1 (top-down). */
    private x0 = 0;
    private y0 = 0;
    private x1 = 0;
    private y1 = 0;
    private readBuffer: WebGLFramebuffer | null = null;
    private patch: ShaderProgram;
    private patchTexture: WebGLTexture | null = null;
    private patchWidth = 0;
    private patchHeight = 0;
    private patchQuad: Buffer;
    private quad = new Float32Array(12);
    private rows: Uint8Array = new Uint8Array(0);

    constructor(rctx) {
        this.gl = rctx.getGl();
        this.program = new ShaderProgram(rctx, {
            bindings: {
                uniforms: {
                    picture: { name: "u_picture", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_picture;
                void main() {
                    vec2 at = (floor(gl_FragCoord.xy) + 0.5) / u_resolution;
                    setFragColor(vec4(texture2D(u_picture, vec2(at.x, 1.0 - at.y)).rgb, 1.0));
                }
            `,
            swapFrame: true,
        });
        this.patchQuad = new Buffer(rctx);
        // The plotter's rows back into the frame itself, every byte as it is on the processor.
        this.patch = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    quad: { name: "a_position", size: 2 },
                },
                uniforms: {
                    picture: { name: "u_picture", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            drawHook: (values, gl) => {
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_picture;
                void main() {
                    vec2 at = (floor(gl_FragCoord.xy) + 0.5) / u_resolution;
                    setFragColor(texture2D(u_picture, vec2(at.x, 1.0 - at.y)));
                }
            `,
            swapFrame: false,
            vertexShader: `
                attribute vec2 a_position;
                void main() {
                    setPosition(a_position);
                }
            `,
        });
    }

    private allocate(width: number, height: number) {
        const size = width * height * 4;
        if (this.pixels.length !== size) {
            this.pixels = new Uint8Array(size);
            this.pixels32 = new Uint32Array(this.pixels.buffer);
            this.raw = new Uint8Array(size);
        }
    }

    /** The raw read-back (rows bottom up) into the pixels, top row first. */
    private flip(width: number, height: number) {
        const stride = width * 4;
        for (let row = 0; row < height; row++) {
            this.pixels.set(this.raw.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
        }
    }

    private start(tsm, width: number, height: number) {
        this.width = width;
        this.height = height;
        this.owner = tsm;
        this.whole = false;
        this.x0 = width;
        this.y0 = height;
        this.x1 = 0;
        this.y1 = 0;
    }

    /**
     * The current frame of `tsm` (the bound render target), RGBA with the top row first: the run's
     * copy when it holds this frame, else read back from the GPU.
     */
    public acquire(tsm, width: number, height: number): Uint8Array {
        if (this.holds(tsm, width, height)) {
            return this.pixels;
        }
        this.flush();
        this.allocate(width, height);
        this.start(tsm, width, height);
        const gl = this.gl;
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.raw);
        this.flip(width, height);
        return this.pixels;
    }

    /** Whether the run holds the frame of `tsm` (at this size) on the processor, newer than the GPU's. */
    public holds(tsm, width: number, height: number): boolean {
        return this.pending && this.owner === tsm && this.width === width && this.height === height;
    }

    /** Whether any frame waits to go back. */
    public isPending(): boolean {
        return this.pending;
    }

    /**
     * For the plotter: tsm's current texture read back into the pixels (the way the plotter read the
     * frame before); false when that texture cannot be read (then nothing is held).
     */
    public acquireTexture(tsm, width: number, height: number): boolean {
        if (this.holds(tsm, width, height)) {
            return true;
        }
        this.flush();
        const gl = this.gl;
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        if (!this.readBuffer) {
            this.readBuffer = gl.createFramebuffer();
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.readBuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tsm.getCurrentTexture(), 0);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        if (complete) {
            this.allocate(width, height);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.raw);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        if (!complete) {
            return false;
        }
        this.flip(width, height);
        this.start(tsm, width, height);
        this.pending = true;
        return true;
    }

    /** The acquired pixels were drawn into (by a Texer II): newer than the GPU's frame. */
    public changed() {
        this.pending = true;
        this.whole = true;
    }

    /** The plotter blended into columns x0…x1 − 1 of rows y0…y1 − 1 of the held frame. */
    public drawn(x0: number, y0: number, x1: number, y1: number) {
        this.pending = true;
        if (x0 < this.x0) this.x0 = x0;
        if (y0 < this.y0) this.y0 = y0;
        if (x1 > this.x1) this.x1 = x1;
        if (y1 > this.y1) this.y1 = y1;
    }

    /** At the end of a user's draw(): back to the GPU unless the next drawn child goes on with it. */
    public finish(main) {
        if (!main.avsCpuRunNext) {
            this.flush();
        }
    }

    /** Sends a changed frame back to its render target (see the top). */
    public flush() {
        if (!this.pending) {
            return;
        }
        this.pending = false;
        if (!this.whole) {
            this.flushRows();
            return;
        }
        this.whole = false;
        const gl = this.gl;
        if (!this.upload) {
            this.upload = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.upload);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.upload);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
        this.program.run(this.owner, { picture: this.upload });
    }

    /**
     * The plotter's part: the rectangle it wrote uploaded and drawn over the frame (no blending,
     * alpha too); its other pixels there are the frame's own, read back.
     */
    private flushRows() {
        const { x0, y0, x1, y1, width, height } = this;
        if (x1 <= x0 || y1 <= y0) {
            return;
        }
        const gl = this.gl;
        if (!this.patchTexture || this.patchWidth !== width || this.patchHeight !== height) {
            if (!this.patchTexture) {
                this.patchTexture = gl.createTexture();
            }
            gl.bindTexture(gl.TEXTURE_2D, this.patchTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.patchWidth = width;
            this.patchHeight = height;
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.patchTexture);
        }
        // Texture row r holds the frame's row r from the top, as the whole upload has it; only the
        // rectangle written goes up (its rows packed side by side when it is narrower than the frame).
        if (x1 - x0 === width) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, width, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE,
                this.pixels.subarray(y0 * width * 4, y1 * width * 4));
        } else {
            const stride = (x1 - x0) * 4;
            const size = stride * (y1 - y0);
            if (this.rows.length < size) {
                this.rows = new Uint8Array(size);
            }
            for (let row = y0; row < y1; row++) {
                const from = (row * width + x0) * 4;
                this.rows.set(this.pixels.subarray(from, from + stride), (row - y0) * stride);
            }
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, this.rows.subarray(0, size));
        }
        const left = (x0 / width) * 2 - 1;
        const right = (x1 / width) * 2 - 1;
        const top = 1 - (y0 / height) * 2;
        const bottom = 1 - (y1 / height) * 2;
        const quad = this.quad;
        quad[0] = left; quad[1] = top; quad[2] = right; quad[3] = top; quad[4] = left; quad[5] = bottom;
        quad[6] = left; quad[7] = bottom; quad[8] = right; quad[9] = top; quad[10] = right; quad[11] = bottom;
        this.patchQuad.setData(quad);
        this.patch.run(this.owner, { picture: this.patchTexture, quad: this.patchQuad });
    }

    /** Forgets a pending frame without sending it (a frame that failed part-way). */
    public drop() {
        this.pending = false;
        this.whole = false;
        this.owner = null;
    }

    public destroy() {
        this.program.destroy();
        this.patch.destroy();
        this.patchQuad.destroy();
        if (this.upload) {
            this.gl.deleteTexture(this.upload);
            this.upload = null;
        }
        if (this.patchTexture) {
            this.gl.deleteTexture(this.patchTexture);
            this.patchTexture = null;
        }
        if (this.readBuffer) {
            this.gl.deleteFramebuffer(this.readBuffer);
            this.readBuffer = null;
        }
    }
}

const runs = new WeakMap();

/** The run of a rendering context (a restored context gets a new one). */
export function cpuFrameRunOf(rctx): CpuFrameRun {
    let run = runs.get(rctx);
    if (!run) {
        run = new CpuFrameRun(rctx);
        runs.set(rctx, run);
    }
    return run;
}

/** The run of main's rendering context. */
export function cpuFrameRun(main): CpuFrameRun {
    return cpuFrameRunOf(main.getRctx());
}
