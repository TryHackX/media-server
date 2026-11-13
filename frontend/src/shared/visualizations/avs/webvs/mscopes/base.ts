// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * The base of the mscopes effects: an AVS component (webvs Component) with what
 * mscopes' Effect had — named parameters with their ranges, the "trigger" (which hit
 * sets off an on-beat reaction), the frame clock — and the plumbing to run a kernel
 * over the frame: read the list's current texture, draw into its next one.
 *
 * Options are mscopes' parameter keys in camelCase (`zoomBass` for `zoom_bass`; the
 * snake_case names are read too), clamped into the parameter's range as mscopes'
 * setParam did; a missing one is the parameter's default.
 */
import Component from "../Component";
import { MscopesAudioFrame } from "./audio";
import { drawQuad, into, nearest, Program, Target } from "./gl";
import { mscopesHost } from "./host";

const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());

export default class MscopesEffect extends Component {
    public static componentName: string = "MscopesEffect";
    public static componentTag: string = "trans";
    protected host;
    protected gl: WebGLRenderingContext;
    protected lastTime: number;
    private programCache: { [key: string]: Program };
    private scratchTargets: { [key: string]: Target };
    private watched;
    private previous;

    public init() {
        this.host = mscopesHost(this.main);
        this.gl = this.main.getRctx().getGl();
        this.lastTime = -1;
        this.programCache = {};
        this.scratchTargets = {};
        this.setup();
    }

    public draw() {
        this.render(this.host.audio.frame());
    }

    public destroy() {
        super.destroy();
        if (this.watched) {
            this.host.releasePrevious(this.watched);
            this.watched = null;
        }
        this.teardown();
        for (const key of Object.keys(this.programCache || {})) {
            this.programCache[key].destroy();
        }
        this.programCache = {};
        for (const key of Object.keys(this.scratchTargets || {})) {
            this.scratchTargets[key].destroy();
        }
        this.scratchTargets = {};
    }

    /** The texture type of the frame this effect draws on (half floats in a float frame). */
    protected frameType(): number {
        const tsm = this.parent.getTSM();
        return tsm && tsm.getTextureType ? tsm.getTextureType() : this.gl.UNSIGNED_BYTE;
    }

    /** A texture of this effect's own, the frame's size unless told otherwise. */
    protected scratch(key: string, width?: number, height?: number, type?: number): Target {
        const gl = this.gl;
        const w = width === undefined ? gl.drawingBufferWidth : width;
        const h = height === undefined ? gl.drawingBufferHeight : height;
        const kind = type === undefined ? this.frameType() : type;
        let target = this.scratchTargets[key];
        if (!target || target.type !== kind) {
            if (target) {
                target.destroy();
            }
            target = new Target(gl, w, h, kind);
            this.scratchTargets[key] = target;
        } else {
            target.resize(w, h);
        }
        return target;
    }

    /** Runs a program into one of the effect's own textures (`u_size` its size). */
    protected run(target: Target, program: Program, uniforms?: (program: Program) => void): void {
        const gl = this.gl;
        into(gl, target, () => {
            gl.disable(gl.BLEND);
            program.use();
            program.f("u_size", target.width, target.height);
            if (uniforms) {
                uniforms(program);
            }
            drawQuad(gl, program);
        });
    }

    /** Set-up after the options are known (state, programs). */
    protected setup() {}

    /** One frame. */
    protected render(audio: MscopesAudioFrame) {}

    /** Frees what setup made. */
    protected teardown() {}

    /** A parameter: the option, clamped into [min, max], or the default. */
    protected param(name: string, fallback: number, min: number, max: number): number {
        let value = this.opts[name];
        if (value === undefined) {
            value = this.opts[snake(name)];
        }
        if (typeof value === "boolean") {
            value = value ? 1 : 0;
        }
        const number = Number(value);
        if (value === undefined || value === null || value === "" || !Number.isFinite(number)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, number));
    }

    /** Which hit sets off the effect's reaction: 0 the beat, 1 kick, 2 snare, 3 hi-hat. */
    protected onBeat(audio: MscopesAudioFrame): boolean {
        if (!audio.hasFeatures) {
            return audio.beat;
        }
        switch (Math.trunc(this.param("trigger", 0, 0, 3))) {
            case 1: return audio.kickHit;
            case 2: return audio.snareHit;
            case 3: return audio.hatHit;
            default: return audio.beat;
        }
    }

    /** Seconds since this effect last ran (1/60 the first time), as mscopes' effects kept it. */
    protected stepTime(): number {
        const time = this.host.time;
        const dt = this.lastTime < 0 ? 1 / 60 : Math.max(0, time - this.lastTime);
        this.lastTime = time;
        return dt;
    }

    /** A program compiled once per effect. */
    protected program(key: string, source: string | (() => string), vertex?: string): Program {
        let program = this.programCache[key];
        if (!program) {
            program = new Program(this.gl, typeof source === "function" ? source() : source, vertex);
            this.programCache[key] = program;
        }
        return program;
    }

    protected width(): number {
        return this.gl.drawingBufferWidth;
    }

    protected height(): number {
        return this.gl.drawingBufferHeight;
    }

    /**
     * Runs a kernel over the frame: `u_src` is the frame as it is (bilinear unless
     * `linear` is false) or `from`, `u_size` the frame's size; the result becomes the
     * frame. (The list keeps two textures: the kernel writes the one it does not read.)
     */
    protected pass(program: Program, uniforms?: (program: Program) => void, linear: boolean = true, from?: WebGLTexture): void {
        const gl = this.gl;
        const tsm = this.parent.getTSM();
        const source = from || tsm.getCurrentTexture();
        tsm.switchTexture();
        gl.disable(gl.BLEND);
        program.use();
        program.texture("u_src", source, linear);
        program.f("u_size", gl.drawingBufferWidth, gl.drawingBufferHeight);
        if (uniforms) {
            uniforms(program);
        }
        drawQuad(gl, program);
        if (linear) {
            nearest(gl, source);
        }
    }

    /** The frame's current texture (what the next pass reads). */
    protected frameTexture(): WebGLTexture {
        return this.parent.getTSM().getCurrentTexture();
    }

    /**
     * The previous frame's final picture of this effect's list (mscopes' `prev`),
     * kept from the first frame this is asked for on — black until then, as
     * mscopes' frames start. (A list makes its textures after its components.)
     */
    protected previousFrame(): WebGLTexture {
        const tsm = this.parent.getTSM();
        if (this.watched !== tsm) {
            if (this.watched) {
                this.host.releasePrevious(this.watched);
            }
            this.watched = tsm;
            this.previous = this.host.watchPrevious(tsm);
        }
        return this.previous.target.texture;
    }
}
