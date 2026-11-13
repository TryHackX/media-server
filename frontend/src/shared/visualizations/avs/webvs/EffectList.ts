// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import Component from "./Component";
import Container from "./Container";
import CodeInstance from "./expr/CodeInstance";
import compileExpr from "./expr/compileExpr";
import IMain from "./IMain";
import { avsBlend, BlendMode, WebGLVarType } from "./utils";
import ShaderProgram from "./webgl/ShaderProgram";
import TextureSetManager from "./webgl/TextureSetManager";
import { avsBufferName } from "./converterCompat";
import { blendTwoGlsl, HIGH_PRECISION } from "./avsSupport";
import { cpuFrameRun, cpuRunContinues } from "./cpuFrameRun";
import { frameTextureType } from "./mscopes/gl";

// Fork: blends webvs could only approximate, done with AVS's arithmetic.
const EXACT = ["EVERY_OTHER_LINE", "EVERY_OTHER_PIXEL", "ADJUSTABLE", "MULTIPLY"];

// Fork: AVS's "Buffer" blend — mixed by the brightness of a saved buffer.
const BUFFER_BLEND = -1;

/**
 * BlendModes supported by Effectlist
 */
export enum ELBlendMode {
    REPLACE = 1,
    MAXIMUM,
    AVERAGE,
    ADDITIVE,
    SUBTRACTIVE1,
    SUBTRACTIVE2,
    MULTIPLY,
    MULTIPLY2,
    ADJUSTABLE,
    ALPHA,
    IGNORE,
    // Fork: same values as BlendMode's additions.
    MINIMUM = 12,
    XOR = 13,
}

/**
 * Options for EffectList
 */
export interface IEffectListOpts {
    /**
     * EEL code to control the effectlist.
     *
     * Following varaibles are available:
     *
     * + `beat`: 0 or 1 to indicate a beat for the current frame
     * + `enabled`: set this to 0 or 1 to disable or enable the effectlist
     * + `clear`: set this to 0 or 1 to clear the frame
     */
    code: {
        /**
         * EEL that will be run on init
         */
        init: string,
        /**
         * EEL that will be run per frame
         */
        perFrame: string,
    };
    /**
     * The output blend mode. Default: "REPLACE"
     */
    output: string;
    /**
     * The input blend mode. Default: "IGNORE"
     */
    input: string;
    /**
     * Enable clearing each frame. Default: false
     */
    clearFrame: boolean;
    /**
     * If set, the this effectlist is enabled only on a beat. Default: false
     */
    enableOnBeat: boolean;
    /**
     * When enableOnBeat, this determines the number of beats
     * counted before the Effectlist is enabled. Default: 1
     */
    enableOnBeatFor: number;
}

interface IELCodeInstance extends CodeInstance {
    beat: number;
    enabled: number;
    clear: number;
    init: () => void;
    perFrame: () => void;
}

/**
 * Effectlist is a container that renders components to a separate buffer. And blends
 * it in with the parent buffer.
 *
 * An implicit Effeclist is also created by [[Main]] as a root component.
 */
export default class EffectList extends Container {
    public static componentName = "EffectList";
    public static componentTag = "";
    protected static defaultOptions: IEffectListOpts = {
        clearFrame: false,
        code: {
            init: "",
            perFrame: "",
        },
        enableOnBeat: false,
        enableOnBeatFor: 1,
        input: "IGNORE",
        output: "REPLACE",
    };
    protected static optUpdateHandlers = {
        code: "updateCode",
        input: "updateBlendMode",
        output: "updateBlendMode",
    };

    protected opts: IEffectListOpts;
    private frameCounter: number;
    private first: boolean;
    /** Fork: the root's current texture holds a frame it drew (none before the first, nor after a resize). */
    private hasFrame: boolean = false;
    private inited: boolean = false;
    private code: IELCodeInstance;
    private input: ELBlendMode;
    private output: ELBlendMode;
    private bufferBlend: ShaderProgram;
    private inputExact: string;
    private outputExact: string;
    private exactPrograms: { [mode: string]: ShaderProgram };

    constructor(main: IMain, parent: Container, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        super.init();
        // Fork: a half-float frame when the preset asks for one (the mscopes presets).
        const tsm = new TextureSetManager(
            this.main.getRctx(), this.main.getCopier(), this.parent ? false : true,
            2, frameTextureType(this.main, this.opts, this.parent));
        this.setTSM(tsm);
        this.updateCode();
        this.updateBlendMode(this.opts.input, "input");
        this.updateBlendMode(this.opts.output, "output");
        this.frameCounter = 0;
        this.first = true;
        this.listenTo(this.main, "resize", () => this.handleResize());
    }

    public draw() {
        const opts = this.opts;
        const isRoot = !this.parent;
        const beatNow = this.main.getAnalyser().isBeat();

        // Fork: as r_list.cpp. A list is on when its settings say so, or for
        // enableOnBeatFor frames after a beat ("enable on beat" only matters for a
        // list switched off). Its parent always asks it to draw (see below): the
        // code runs first and may switch it on or off — presets draw a fixed
        // picture into a buffer once with enabled=1-equal(lw,w)*equal(lh,h).
        if (opts.enableOnBeat && beatNow) {
            this.frameCounter = Math.max(1, Math.trunc(Number(opts.enableOnBeatFor) || 1));
        }
        let enabled = isRoot || this.isEnabled() || this.frameCounter > 0;

        // Every frame the code starts from the settings (beat, enabled, clear,
        // alphain/alphaout = the adjustable blends over 255) and what it leaves
        // there is used for this frame; only with "use code" switched on.
        let listBeat = beatNow;
        let clear = Boolean(opts.clearFrame);
        let inAdjust = this.adjustLevel(opts.inAdjustBlend);
        let outAdjust = this.adjustLevel(opts.outAdjustBlend);
        if (!isRoot && !(opts.code && opts.code.enabled === false)) {
            this.code.beat = beatNow ? 1 : 0;
            this.code.enabled = enabled ? 1 : 0;
            // r_list.cpp sets w and h every frame too (code that assigns them gets them back).
            const gl = this.main.getRctx().getGl();
            this.code.w = gl.drawingBufferWidth;
            this.code.h = gl.drawingBufferHeight;
            this.code.clear = clear ? 1 : 0;
            this.code.alphain = inAdjust / 255;
            this.code.alphaout = outAdjust / 255;
            if (!this.inited) {
                this.inited = true;
                this.code.init();
            }
            this.code.perFrame();
            const flag = (value) => Number(value) > 0.1 || Number(value) < -0.1;
            listBeat = flag(this.code.beat);
            clear = flag(this.code.clear);
            inAdjust = this.adjustLevel(Math.trunc(Number(this.code.alphain) * 255));
            outAdjust = this.adjustLevel(Math.trunc(Number(this.code.alphaout) * 255));
            enabled = flag(this.code.enabled);
        }
        if (!enabled) {
            // AVS frees the list's frame: the next time it is on, it starts black.
            this.first = true;
            return;
        }
        if (this.frameCounter > 0) {
            this.frameCounter--;
        }

        // set rendertarget to internal framebuffer
        this.getTSM().setAsRenderTarget();

        // clear frame
        if (clear || this.first) {
            const gl = this.main.getRctx().getGl();
            // Fork: the root's first frame starts on the picture the preset before left
            // (Main.loadPreset with carryFrame), unless the preset clears every frame anyway.
            const carried = !isRoot ? null : (this.main as any).avsCarried as WebGLTexture | null;
            if (this.first && carried && !clear) {
                this.main.getCopier().run(null, { srcTexture: carried });
            } else {
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            if (isRoot && this.first) {
                (this.main as any).dropCarried();
            }
            this.first = false;
        }

        // blend input texture onto internal texture
        if (this.input !== ELBlendMode.IGNORE) {
            const inputTexture = this.parent.getTSM().getCurrentTexture();
            if (this.input === BUFFER_BLEND) {
                this.blendByBuffer(this.getTSM(), inputTexture, opts.inBuffer, opts.inBufferInvert);
            } else if (this.inputExact === "ADJUSTABLE" && inAdjust >= 255) {
                // r_list.cpp: "if (use_blendin == 10 && use_inblendval >= 255) use_blendin=1" —
                // adjustable at 255 is a copy, not BLEND_ADJ's (s·255 + d·0) >> 8 one level darker.
                this.main.getCopier().run(this.getTSM(), { srcTexture: inputTexture }, ELBlendMode.REPLACE, 1);
            } else if (this.inputExact) {
                this.blendExactly(this.inputExact, this.getTSM(), inputTexture, inAdjust);
            } else {
                this.main.getCopier().run(this.getTSM(), { srcTexture: inputTexture }, this.input as number, inAdjust / 255);
            }
        }

        // render all the components
        // Fork: a Set Render Mode inside this list lasts until the list ends, and the
        // list starts from the default (replace, one pixel), as AVS r_list.cpp sets
        // g_line_blend_mode = 0 and restores the parent's mode afterwards.
        const renderMode = this.main.avsRenderMode;
        this.main.avsRenderMode = null;
        // Fork: so does the beat: the code's `beat` is what the effects in this list
        // see, and a Custom BPM sets or clears it for the ones after it.
        const analyser = this.main.getAnalyser() as any;
        const outerBeat = analyser.beatOverride ?? null;
        analyser.beatOverride = listBeat;
        // Fork: Texer IIs in a row keep the frame on the processor between them (cpuFrameRun.ts).
        const run = cpuFrameRun(this.main);
        const drawn = (component: Component) => component.isEnabled() || component instanceof EffectList;
        const components = this.components;
        try {
            for (let index = 0; index < components.length; index++) {
                const component = components[index];
                // Fork: a list decides itself whether it draws (its code can switch it on).
                if (drawn(component)) {
                    this.main.avsCpuRunNext = cpuRunContinues(components, index, drawn);
                    component.draw();
                    const decided = (component as any).beatDecision;
                    if (decided === true || decided === false) {
                        analyser.beatOverride = decided;
                    }
                }
            }
        } finally {
            // Nothing stays on the processor past the list (nor past a child that threw).
            this.main.avsCpuRunNext = false;
            run.flush();
        }
        analyser.beatOverride = outerBeat;
        this.main.avsRenderMode = renderMode;

        // switch to old framebuffer
        this.getTSM().unsetAsRenderTarget();

        // blend current texture to the output framebuffer
        if (this.output !== ELBlendMode.IGNORE) {
            if (this.parent && this.output === BUFFER_BLEND) {
                this.blendByBuffer(this.parent.getTSM(), this.getTSM().getCurrentTexture(), opts.outBuffer, opts.outBufferInvert);
            } else if (this.parent && this.outputExact === "ADJUSTABLE" && outAdjust >= 255) {
                // r_list.cpp, likewise for the output: use_blendout=1.
                this.main.getCopier().run(this.parent.getTSM(), { srcTexture: this.getTSM().getCurrentTexture() }, ELBlendMode.REPLACE, 1);
            } else if (this.parent && this.outputExact) {
                this.blendExactly(this.outputExact, this.parent.getTSM(), this.getTSM().getCurrentTexture(), outAdjust);
            } else if (this.parent) {
                this.main.getCopier().run(
                    this.parent.getTSM(),
                    { srcTexture: this.getTSM().getCurrentTexture() },
                    this.output as number,
                    outAdjust / 255,
                );
            } else {
                this.main.getCopier().run(null, { srcTexture: this.getTSM().getCurrentTexture() });
            }
        }
        if (isRoot) {
            this.hasFrame = true;
        }
    }

    /**
     * Fork: the root's last frame for the next preset (Main.loadPreset), taken out of this list's
     * textures (it is destroyed next); null when it has not drawn one.
     */
    public takeFrame(): WebGLTexture | null {
        if (this.parent || !this.hasFrame) {
            return null;
        }
        this.hasFrame = false;
        return this.getTSM().detachCurrentTexture();
    }

    public destroy() {
        super.destroy();
        if (this.bufferBlend) {
            this.bufferBlend.destroy();
            this.bufferBlend = null;
        }
        for (const mode of Object.keys(this.exactPrograms || {})) {
            this.exactPrograms[mode].destroy();
        }
        this.exactPrograms = null;
        if (this.getTSM()) {
            // destroy the framebuffer manager
            this.getTSM().destroy();
        }
    }

    private updateCode() {
        this.code = compileExpr(this.opts.code, ["init", "perFrame"]).codeInst as IELCodeInstance;
        this.code.setup(this.main);
        this.inited = false;
    }

    private updateBlendMode(value: string, name: "input" | "output") {
        const mode = String(value || "").toUpperCase() === "BUFFER"
            ? BUFFER_BLEND
            : ELBlendMode[avsBlend(value)] ?? ELBlendMode.REPLACE;
        const exact = EXACT.indexOf(String(value || "").toUpperCase()) >= 0 ? String(value).toUpperCase() : null;
        if (name === "input") {
            this.input = mode;
            this.inputExact = exact;
        } else {
            this.output = mode;
            this.outputExact = exact;
        }
    }

    /** Fork: blend(target, source) written into the target's next texture, AVS's way. */
    private blendExactly(mode: string, target: TextureSetManager, source: WebGLTexture, adjust) {
        if (!this.exactPrograms) {
            this.exactPrograms = {};
        }
        let program = this.exactPrograms[mode];
        if (!program) {
            program = new ShaderProgram(this.main.getRctx(), {
                bindings: {
                    uniforms: {
                        dest: { name: "u_dest", valueType: WebGLVarType.TEXTURE2D },
                        height: { name: "u_height", valueType: WebGLVarType._1F },
                        src: { name: "u_src", valueType: WebGLVarType.TEXTURE2D },
                        value: { name: "u_value", valueType: WebGLVarType._1F },
                    },
                },
                fragmentShader: `
                    ${HIGH_PRECISION}
                    uniform sampler2D u_dest;
                    uniform sampler2D u_src;
                    uniform float u_value;
                    uniform float u_height;
                    ${blendTwoGlsl(mode)}
                    void main() {
                        setFragColor(vec4(blendTwo(texture2D(u_dest, v_position).rgb, texture2D(u_src, v_position).rgb), 1.0));
                    }
                `,
                swapFrame: true,
            });
            this.exactPrograms[mode] = program;
        }
        const number = Number(adjust);
        const value = Number.isFinite(number) ? Math.max(0, Math.min(255, number)) : 128;
        program.run(target, {
            dest: target.getCurrentTexture(),
            height: this.main.getRctx().getGl().drawingBufferHeight,
            src: source,
            value,
        });
    }

    /** Fork: AVS's adjustable blend slider (0…255) as the 0…1 webvs passes to GL. */
    /** An adjustable blend's value in whole levels, 0…255 (128 when unreadable). */
    private adjustLevel(value): number {
        const number = Math.trunc(Number(value));
        return Number.isFinite(number) ? Math.max(0, Math.min(255, number)) : 128;
    }

    /**
     * Fork: AVS's "Buffer" blend. Where a saved buffer is bright the source
     * shows, where it is dark the target stays (inverted on request). A buffer
     * never saved leaves the target as it is, as AVS did.
     */
    private blendByBuffer(target: TextureSetManager, source: WebGLTexture, buffer, invert) {
        const name = avsBufferName(buffer);
        if (!this.main.avsWrittenBuffers || !this.main.avsWrittenBuffers.has(name)) {
            return;
        }
        let mask = null;
        try {
            mask = this.main.getTempTSM().getTexture(name);
        } catch (missing) {
            return;
        }
        if (!this.bufferBlend) {
            this.bufferBlend = new ShaderProgram(this.main.getRctx(), {
                bindings: {
                    uniforms: {
                        invert: { name: "u_invert", valueType: WebGLVarType._1F },
                        mask: { name: "u_mask", valueType: WebGLVarType.TEXTURE2D },
                        source: { name: "u_source", valueType: WebGLVarType.TEXTURE2D },
                    },
                },
                // AVS (r_list.cpp): BLEND_ADJ(list, frame, v) with v the buffer
                // pixel's brightest channel (255 - v inverted), in whole levels. Winamp's
                // AVS 2.81 ran the MMX BLEND_ADJ (r_defs.h): (s·v + d·(255 − v)) >> 8, so
                // what the buffer leaves dark fades by 255/256 a frame; until 09.11 this was
                // the C table (s·v/255 + d·(255 − v)/255), which kept it forever (Atero —
                // Neon Dreams: trails that never faded).
                fragmentShader: `
                    uniform sampler2D u_source;
                    uniform sampler2D u_mask;
                    uniform float u_invert;
                    void main() {
                        vec3 m = floor(texture2D(u_mask, v_position).rgb * 255.0 + 0.5);
                        float v = max(max(m.r, m.g), m.b);
                        v = u_invert > 0.5 ? 255.0 - v : v;
                        vec3 list = floor(texture2D(u_source, v_position).rgb * 255.0 + 0.5);
                        vec3 frame = floor(getSrcColor().rgb * 255.0 + 0.5);
                        setFragColor(vec4(floor((list * v + frame * (255.0 - v)) / 256.0) / 255.0, 1.0));
                    }
                `,
                swapFrame: true,
            });
        }
        this.bufferBlend.run(target, { invert: invert ? 1 : 0, mask, source });
    }

    private handleResize() {
        this.getTSM().resize();
        // Fork: a resized frame starts empty, as AVS allocates its framebuffer anew; a picture
        // kept from the preset before has the old size, so it goes too.
        if (!this.parent) {
            this.hasFrame = false;
            (this.main as any).dropCarried();
        }
        this.code.updateDimVars(this.main.getRctx().getGl());
    }
}
