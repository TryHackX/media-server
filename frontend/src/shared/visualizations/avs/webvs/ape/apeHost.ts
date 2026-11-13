// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * AVS's plug-in interface in the browser: effects that AVS ran as APE DLLs (and Sonique
 * visualizations through its SVP Loader) as ports with AVS's own calling convention —
 * `render(visdata, isBeat, framebuffer, fbout, w, h)` on 32-bit pixels 0x00RRGGBB, row 0 at
 * the top, and APEinfo's registers, line blend mode and global buffers.
 *
 * Ports come from two places:
 * - this repository, where the plug-in's source is published under a licence that allows it
 *   (`builtinApes.ts`: Normalise after grandchild/vis_avs);
 * - the owner's `frontend/vendor/avs-apes/` (git-ignored, `virtual:avs-apes`, scripts/avs-apes.mjs):
 *   ports of plug-ins without published source. A vendor port of an id replaces a built-in one.
 *
 * A component of an id with no port does nothing, as AVS did with an APE it did not have; one the
 * engine has a component of its own for (FyrewurX's look-alike) uses that unless a vendor port of
 * the id is there (`apeComponentType`, Container.ts).
 * The frame goes to the processor and back once per such component (`readPixels`, as Texer II),
 * except for a port that only adds to pixels with saturation (`additive`): its writes go through
 * the plotter (avsDraw.ts), blended additively by GL, with no copy of the frame.
 */
import Component from "../Component";
import { avsLineMode, avsPlotter, avsVisdata, BLEND_ADDITIVE } from "../avsDraw";
import { cRand } from "../avsRandom";
import { avsBufferName } from "../converterCompat";
import { fromBase64Config, msvcRand, svpFileName } from "./config";

/** A port's context: what AVS handed an APE's render() and APEinfo. */
export interface ApeContext {
    readonly w: number;
    readonly h: number;
    readonly isBeat: boolean;
    readonly visdata: Int8Array;
    readonly visdataUnsigned: Uint8Array;
    rand(): number;
    makeRand(seed?: number): () => number;
    readonly registers: Float64Array;
    lineBlendMode: number;
    globalBuffer(index: number, create: boolean): Int32Array | null;
    now(): number;
}

export interface ApeEffect {
    render(ctx: ApeContext, framebuffer: Int32Array, fbout: Int32Array): number;
    /**
     * The same frame for a port whose render() only adds to pixels, per channel with saturation
     * (top byte untouched): each write as plot(y * w + x, 0xRRGGBB) instead of a change to the frame.
     */
    additive?(ctx: ApeContext, plot: (offset: number, rgb: number) => void): void;
    destroy?(): void;
}

export interface SvpVisData {
    millSec: number;
    waveform: [Uint8Array, Uint8Array];
    spectrum: [Uint8Array, Uint8Array];
}

export interface SvpEffect {
    render(video: Int32Array, width: number, height: number, pitch: number, vd: SvpVisData, ctx: ApeContext): void;
    destroy?(): void;
}

export interface ApePort {
    id: string;
    create(config: Uint8Array, files?: Record<string, string>): ApeEffect;
}

export interface SvpPort {
    file: string;
    create(): SvpEffect;
}

const builtinPorts = new Map<string, ApePort>();
const vendorPorts = new Map<string, ApePort>();
const svpPorts = new Map<string, SvpPort>();
let portFiles: Record<string, string> = {};

/** Ports this repository carries (source published under a compatible licence). */
export function addBuiltinApe(port: ApePort) {
    builtinPorts.set(port.id, port);
}

/** The owner's ports (vendor/avs-apes): APEs by id, SVPs by file name, data files by name. */
export function registerVendorPorts(module: { apes?: ApePort[]; svps?: SvpPort[]; files?: Record<string, string> } | null) {
    if (!module) {
        return;
    }
    for (const port of module.apes || []) {
        if (port && typeof port.id === "string") {
            vendorPorts.set(port.id, port);
        }
    }
    for (const port of module.svps || []) {
        if (port && typeof port.file === "string") {
            svpPorts.set(port.file.toLowerCase(), port);
        }
    }
    portFiles = { ...portFiles, ...(module.files || {}) };
}

export function apePort(id: string): ApePort | null {
    return vendorPorts.get(id) || builtinPorts.get(id) || null;
}

/**
 * The component type for converter options: an APE the engine has a component of its own for
 * (`{ type: "FyrewurX", apeId, config }`) runs through the host when a vendor port of the id is
 * there, since a port of the plug-in replaces the engine's stand-in.
 */
export function apeComponentType(opts): string {
    const type = opts && opts.type;
    if (type && type !== "Ape" && typeof opts.apeId === "string" && vendorPorts.has(opts.apeId)) {
        return "Ape";
    }
    return type;
}

/** AVS keeps the library name with its folder; ports go by the file name, lower-case. */
export function svpPort(library: string): SvpPort | null {
    return svpPorts.get(svpFileName(library)) || null;
}


/**
 * The frame on the processor: read from the current render target (row 0 at the bottom in GL)
 * into AVS's layout, and back as a texture drawn over the frame.
 */
export class CpuFrame {
    private raw: Uint8Array | null = null;
    private width = 0;
    private height = 0;
    public framebuffer: Int32Array | null = null;
    public fbout: Int32Array | null = null;
    private upload: WebGLTexture | null = null;

    public size(w: number, h: number) {
        if (w !== this.width || h !== this.height || !this.raw) {
            this.width = w;
            this.height = h;
            this.raw = new Uint8Array(w * h * 4);
            this.framebuffer = new Int32Array(w * h);
            this.fbout = new Int32Array(w * h);
        }
    }

    /** gl.readPixels of what is bound, into `out` (default: the framebuffer). */
    public read(gl: WebGLRenderingContext, out?: Int32Array) {
        const w = this.width;
        const h = this.height;
        const raw = this.raw;
        const dest = out || this.framebuffer;
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        for (let y = 0; y < h; y++) {
            let from = (h - 1 - y) * w * 4;
            let to = y * w;
            for (let x = 0; x < w; x++, from += 4, to++) {
                dest[to] = (raw[from] << 16) | (raw[from + 1] << 8) | raw[from + 2];
            }
        }
    }

    /** `pixels` as a texture, rows the GL way up (for the copier). */
    public texture(gl: WebGLRenderingContext, pixels: Int32Array): WebGLTexture {
        const w = this.width;
        const h = this.height;
        const raw = this.raw;
        for (let y = 0; y < h; y++) {
            let to = (h - 1 - y) * w * 4;
            let from = y * w;
            for (let x = 0; x < w; x++, to += 4, from++) {
                const p = pixels[from];
                raw[to] = (p >>> 16) & 255;
                raw[to + 1] = (p >>> 8) & 255;
                raw[to + 2] = p & 255;
                raw[to + 3] = 255;
            }
        }
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
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        return this.upload;
    }

    public destroy(gl: WebGLRenderingContext) {
        if (this.upload) {
            gl.deleteTexture(this.upload);
            this.upload = null;
        }
        this.raw = null;
        this.framebuffer = null;
        this.fbout = null;
    }
}

/** APEinfo and render()'s arguments for one frame. */
function makeContext(main, gl: WebGLRenderingContext, w: number, h: number, frame: CpuFrame) {
    const visdata = new Int8Array(2 * 2 * 576);
    const { spectrum, wave } = avsVisdata(main);
    for (let ch = 0; ch < 2; ch++) {
        visdata.set(new Int8Array(spectrum[ch].buffer, spectrum[ch].byteOffset, 576), ch * 576);
        visdata.set(wave[ch].subarray(0, 576), (2 + ch) * 576);
    }
    const bank = main.getRegisterBank() || {};
    const registers = new Float64Array(100);
    for (let i = 0; i < 100; i++) {
        registers[i] = Number(bank[`reg${String(i).padStart(2, "0")}`]) || 0;
    }
    const line = avsLineMode(main);
    const buffers = new Map<number, Int32Array>();
    const ctx = {
        w, h,
        isBeat: Boolean(main.getAnalyser().isBeat()),
        visdata,
        visdataUnsigned: new Uint8Array(visdata.buffer),
        rand: cRand,
        makeRand: msvcRand,
        registers,
        lineBlendMode: ((line.avsWidth & 255) << 16) | ((line.adjust & 255) << 8) | (line.mode & 255),
        now: () => Math.floor(typeof main.avsFrameTime === "number" ? main.avsFrameTime : performance.now()),
        globalBuffer(index: number, create: boolean): Int32Array | null {
            const n = Math.trunc(Number(index));
            if (!(n >= 0 && n <= 7)) {
                return null;
            }
            if (buffers.has(n)) {
                return buffers.get(n);
            }
            const name = avsBufferName(n);
            const written = main.avsWrittenBuffers;
            const exists = written ? written.has(name) : true;
            if (!exists && !create) {
                return null;
            }
            const tsm = main.getTempTSM();
            try {
                tsm.getTexture(name);
            } catch (missing) {
                tsm.addTexture(name);
            }
            const pixels = new Int32Array(w * h);
            if (exists) {
                tsm.setAsRenderTarget(name);
                frame.read(gl, pixels);
                tsm.unsetAsRenderTarget();
            } else if (written) {
                written.add(name);
            }
            buffers.set(n, pixels);
            return pixels;
        },
    };
    /** Registers and global buffers back where the engine keeps them. */
    const finish = () => {
        for (let i = 0; i < 100; i++) {
            const name = `reg${String(i).padStart(2, "0")}`;
            const value = registers[i];
            if ((Number(bank[name]) || 0) !== value) {
                bank[name] = value;
            }
        }
        if (buffers.size) {
            const tsm = main.getTempTSM();
            for (const [n, pixels] of buffers) {
                const texture = frame.texture(gl, pixels);
                tsm.setAsRenderTarget(avsBufferName(n));
                main.getCopier().run(null, { srcTexture: texture });
                tsm.unsetAsRenderTarget();
            }
        }
    };
    return { ctx, finish };
}

/** An APE component: `apeId` and its config bytes, as the converter kept them. */
export class Ape extends Component {
    public static componentName: string = "Ape";
    public static componentTag: string = "misc";
    // Fields without initializers: the base constructor runs init() before they would apply.
    private effect: ApeEffect | null;
    private frame: CpuFrame | null;

    public init() {
        const port = apePort(String(this.opts.apeId || ""));
        this.frame = new CpuFrame();
        if (!port) {
            this.effect = null;
            return;
        }
        try {
            this.effect = port.create(fromBase64Config(this.opts.config), portFiles);
        } catch (error) {
            // tslint:disable-next-line:no-console
            console.warn(`AVS: ${this.opts.apeId} could not start`, error);
            this.effect = null;
        }
    }

    /** Whether a port runs this id (the audit lists the others as unsupported). */
    public isSupported(): boolean {
        return Boolean(this.effect);
    }

    public draw() {
        if (!this.effect) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const frame = this.frame;
        frame.size(w, h);
        // (A test page may set __avsApeAdditive = false to compare with the frame copy.)
        if (this.effect.additive && (globalThis as any).__avsApeAdditive !== false) {
            const { ctx, finish } = makeContext(this.main, gl, w, h, frame);
            const plotter = avsPlotter(this.main);
            plotter.begin(w, h);
            try {
                this.effect.additive(ctx, (offset, rgb) => plotter.plot(offset, rgb));
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.warn(`AVS: ${this.opts.apeId} stopped`, error);
                this.effect = null;
                plotter.begin(w, h);
                return;
            }
            finish();
            plotter.flush(this.parent.getTSM(), BLEND_ADDITIVE, 0);
            return;
        }
        frame.read(gl);
        const { ctx, finish } = makeContext(this.main, gl, w, h, frame);
        let swapped: boolean;
        try {
            swapped = this.effect.render(ctx, frame.framebuffer, frame.fbout) === 1;
        } catch (error) {
            // A port that fails stops (once, with a note) instead of taking the preset down.
            // tslint:disable-next-line:no-console
            console.warn(`AVS: ${this.opts.apeId} stopped`, error);
            this.effect = null;
            return;
        }
        finish();
        const texture = frame.texture(gl, swapped ? frame.fbout : frame.framebuffer);
        this.main.getCopier().run(this.parent.getTSM(), { srcTexture: texture });
    }

    public destroy() {
        super.destroy();
        if (this.effect && this.effect.destroy) {
            this.effect.destroy();
        }
        this.effect = null;
        if (this.frame) {
            this.frame.destroy(this.main.getRctx().getGl());
            this.frame = null;
        }
    }
}

/**
 * Render / SVP Loader (r_svp.cpp): a Sonique visualization drawn into the frame each frame, with
 * the waveform (512 bytes a channel) and the spectrum (256, pairs of AVS's bytes halved and
 * added) that AVS filled in, and GetTickCount().
 */
export class SVP extends Component {
    public static componentName: string = "SVP";
    public static componentTag: string = "render";
    // Fields without initializers: the base constructor runs init() before they would apply.
    private effect: SvpEffect | null;
    private frame: CpuFrame | null;
    private vd: SvpVisData | null;

    public init() {
        const port = svpPort(this.opts.library);
        this.frame = new CpuFrame();
        this.vd = {
            millSec: 0,
            spectrum: [new Uint8Array(256), new Uint8Array(256)],
            waveform: [new Uint8Array(512), new Uint8Array(512)],
        };
        try {
            this.effect = port ? port.create() : null;
        } catch (error) {
            // tslint:disable-next-line:no-console
            console.warn(`AVS: ${this.opts.library} could not start`, error);
            this.effect = null;
        }
    }

    public isSupported(): boolean {
        return Boolean(this.effect);
    }

    public draw() {
        if (!this.effect) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const frame = this.frame;
        frame.size(w, h);
        frame.read(gl);
        const { ctx, finish } = makeContext(this.main, gl, w, h, frame);
        const vd = this.vd;
        const bytes = ctx.visdataUnsigned;
        for (let ch = 0; ch < 2; ch++) {
            vd.waveform[ch].set(bytes.subarray((2 + ch) * 576, (2 + ch) * 576 + 512));
            const spec = ch * 576;
            for (let p = 0; p < 256; p++) {
                vd.spectrum[ch][p] = (bytes[spec + p * 2] >> 1) + (bytes[spec + p * 2 + 1] >> 1);
            }
        }
        vd.millSec = ctx.now();
        try {
            this.effect.render(frame.framebuffer, w, h, w, vd, ctx);
        } catch (error) {
            // tslint:disable-next-line:no-console
            console.warn(`AVS: ${this.opts.library} stopped`, error);
            this.effect = null;
            return;
        }
        finish();
        const texture = frame.texture(gl, frame.framebuffer);
        this.main.getCopier().run(this.parent.getTSM(), { srcTexture: texture });
    }

    public destroy() {
        super.destroy();
        if (this.effect && this.effect.destroy) {
            this.effect.destroy();
        }
        this.effect = null;
        if (this.frame) {
            this.frame.destroy(this.main.getRctx().getGl());
            this.frame = null;
        }
    }
}
