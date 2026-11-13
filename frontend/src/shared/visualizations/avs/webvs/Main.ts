// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import clone from "lodash-es/clone";
import defaults from "lodash-es/defaults";
import pick from "lodash-es/pick";
// stats.js (debug overlay) removed in this fork: the showStat option is ignored.
import AnalyserAdapter from "./analyser/AnalyserAdapter";
import { restartRandom } from "./avsRandom";
import builtinResourcePack from "./builtinResourcePack";
import Component from "./Component";
import ComponentRegistry from "./ComponentRegistry";
import EffectList from "./EffectList";
import IMain from "./IMain";
import BufferSave from "./misc/BufferSave";
import GlobalVar from "./misc/GlobalVar";
import Model from "./Model";
import ClearScreen from "./render/ClearScreen";
// Fork: AVS's Picture and Picture II (render/AvsPicture.ts) instead of webvs's sprite.
import { AvsPicture, PictureII } from "./render/AvsPicture";
import SuperScope from "./render/SuperScope";
import Texer from "./render/Texer";
import ResourceManager from "./ResourceManager";
import ChannelShift from "./trans/ChannelShift";
import ColorClip from "./trans/ColorClip";
import ColorMap from "./trans/ColorMap";
import Convolution from "./trans/Convolution";
import { AVSTransAutomation, Blur, Comment, ConvolutionFilter, CustomBPM, FastBrightness, FramerateLimiter, GlobalVariables, Interleave, Multiplier, SetRenderMode } from "./trans/Extras";
import TexerII from "./render/TexerII";
// Fork: Movement per pixel, as r_trans.cpp (trans/Movement.ts).
import Movement from "./trans/Movement";
// Fork: Dynamic Distance Modifier per pixel, as r_ddm.cpp (trans/DistanceModifier.ts).
import DynamicDistanceModifier from "./trans/DistanceModifier";
// Fork: AVS's own effects ported from vis_avs (trans/Native.ts); Fadeout replaces webvs's.
import { AddBorders, BlitterFeedback, Brightness, Bump, ColorModifier, ColorReduction, Colorfade, DynamicShift, FadeOut, Grain, MovingParticle, MultiFilter, OnBeatClear, RotoBlitter, Scatter, VideoDelay, Water } from "./trans/Native";
import { DotPlane, FyrewurX, Starfield } from "./render/ExtraRender";
// Fork: AVS's classic effects ported from vis_avs (render/Classic.ts, trans/Interferences.ts, trans/WaterBump.ts).
import { BassSpin, DotFountain, DotGrid, OscilliscopeStar, Ring, RotatingStars, Simple, Timescope } from "./render/Classic";
import Interferences from "./trans/Interferences";
import WaterBump from "./trans/WaterBump";
import Text from "./render/Text";
import Triangle from "./render/Triangle";
// Fork: Dynamic Movement runs its per-pixel code on the CPU (trans/CpuDynamicMovement.ts).
import DynamicMovement from "./trans/CpuDynamicMovement";
import Invert from "./trans/Invert";
import Mirror from "./trans/Mirror";
import Mosaic from "./trans/Mosaic";
import UniqueTone from "./trans/UniqueTone";
// Fork: AVS's plug-in interface (APE, SVP) for ported plug-ins (ape/), and Multi Delay.
import { Ape, SVP } from "./ape/apeHost";
import "./ape/builtinApes";
import MultiDelay from "./trans/MultiDelay";
import Avi from "./render/Avi";
import TexerV1 from "./render/TexerV1";
import { mscopesComponents } from "./mscopes";
import {checkRequiredOptions} from "./utils";
import { applyAvsTrans } from "./avsTrans";
import { presetEelDialect } from "../eel2-parser";
import Buffer from "./webgl/Buffer";
import CopyProgram from "./webgl/CopyProgram";
import RenderingContext from "./webgl/RenderingContext";
import TextureSetManager from "./webgl/TextureSetManager";

// Fork: was a webpack define.
const WEBVS_VERSION = "3.0.0+tryhackx";

/**
 * Options for Main constructor
 */
export interface IMainOpts {
    /**
     * Canvas element in which the visualization will be rendered
     */
    canvas: HTMLCanvasElement;
    /**
     * an analyser that will provide music data for the visualizations
     */
    analyser: AnalyserAdapter;
    /**
     * show or hide performance stats
     */
    showStat?: boolean;
    /**
     * Override baked-in resource url prefix for builtin resources
     */
    resourcePrefix?: string;
    /**
     * Custom requestAnimationFrame. Useful for testing/custom frame-rate control.
     * Use together with [[cancelAnimationFrame]]
     */
    requestAnimationFrame?: (callback: () => void) => any;
    /**
     * Custom cancelAnimationFrame. Useful for testing/custom frame-rate control.
     * Use together with [[requestAnimationFrame]]
     */
    cancelAnimationFrame?: (reqId: any) => void;
}

/**
 * Main is the primary interface that controls loading of presets, starting stopping animations, etc.
 * It maintains the root Component and the hierarchy of components under it.
 * A typical usage involves creating an Analyser and a Main object. The Analyser interfaces with your
 * audio source and generates the visualization data, while the Main object serves as the primary
 * interface for controlling the visualization. E.g:
 * ```
 * const analyser = new Webvs.WebAudioAnalyser();
 * const webvs = new Webvs.Main({
 *     canvas: document.getElementById("canvas"),
 *     analyser: analyser,
 *     showStat: true
 * });
 * webvs.loadPreset({
 *   "clearFrame": true,
 *   "components": [
 *       {
 *           "type": "SuperScope",
 *           "source": "WAVEFORM",
 *           "code": {
 *               "perPoint": "x=i*2-1;y=v;"
 *           },
 *           "colors": ["#ffffff"]
 *       }
 *   ]
 * });
 * webvs.start();
 * analyser.load("music.ogg");
 * analyser.play();
 * ```
 */
/**
 * Fork: the preset's EEL dialect on every code it holds: `_dialect` in a code object (compileExpr
 * skips keys with "_"), `_eelDialect` beside a code string (Movement passes it on to its worker).
 */
function markEelDialect(node: any, dialect: string) {
    if (Array.isArray(node)) {
        node.forEach((item) => markEelDialect(item, dialect));
        return;
    }
    if (!node || typeof node !== "object") {
        return;
    }
    if (node.code && typeof node.code === "object" && !Array.isArray(node.code)) {
        node.code._dialect = dialect;
    } else if (typeof node.code === "string") {
        node._eelDialect = dialect;
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
            markEelDialect(value, dialect);
        }
    }
}

export default class Main extends Model implements IMain {
    /**
     * version of Webvs library
     */
    public static version: string = WEBVS_VERSION;
    private analyser: AnalyserAdapter;
    private rsrcMan: ResourceManager;
    private rctx: RenderingContext;
    private copier: CopyProgram;
    private componentRegistry: ComponentRegistry;
    private tempTSM: TextureSetManager;
    private registerBank: {[key: string]: number};
    private bootTime: number;

    private canvas: HTMLCanvasElement;
    private isStarted: boolean;
    private stats: any;
    private meta: any;
    private rootComponent: Component;
    private animReqId: number;
    private buffers: {[name: string]: Buffer};
    private requestAnimationFrame: (callback: () => void) => any;
    private cancelAnimationFrame: (reqId: any) => void;
    private presetResourceKeys: string[] = [];
    /**
     * Fork: the picture the last preset left, waiting for the next preset's first frame
     * (loadPreset with carryFrame; the root EffectList draws it and lets it go).
     */
    public avsCarried: WebGLTexture | null = null;
    private contextLostHander: (event: any) => void;
    private contextRestoredHander: (event: any) => void;

    /**
     * Constructs a Webvs Main object that can load and render visualization presets
     * @param options options for Main
     */
    constructor(options: IMainOpts) {
        super();
        checkRequiredOptions(options, ["canvas", "analyser"]);
        options = defaults(options, {
            showStat: false,
        });
        this.canvas = options.canvas;
        this.analyser = options.analyser;
        this.isStarted = false;
        if (options.requestAnimationFrame && options.cancelAnimationFrame) {
            this.requestAnimationFrame = options.requestAnimationFrame;
            this.cancelAnimationFrame = options.cancelAnimationFrame;
        } else {
            this.requestAnimationFrame = window.requestAnimationFrame.bind(window);
            this.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        }
        // showStat is not supported in this fork (no stats.js dependency).

        this.meta = {};
        this.buffers = {};
        this._initComponentRegistry();
        this._initResourceManager(options.resourcePrefix || "");
        this._registerContextEvents();
        this._initGl();
        this._setupRoot({id: "root"});
    }

    /**
     * Starts running the animation when ready. The animation may not start
     * playing immediately because preset may use external resources which
     * needs to be loaded asynchronously by the resource manager.
     */
    public start() {
        if (this.isStarted) {
            return;
        }
        this.isStarted = true;
        if (this.rsrcMan.ready) {
            this._startAnimation();
        }
    }

    /**
     * Stops the animation
     */
    public stop() {
        if (!this.isStarted) {
            return;
        }
        this.isStarted = false;
        if (this.rsrcMan.ready) {
            this._stopAnimation();
        }
    }

    /**
     * Loads a preset into this webvs main instance.
     *
     * @param preset an object that contains the preset. The root object should
     * have a `components` property which will contain an Array for component configurations
     * for all the components. All component configurations should have a
     * `type` property containing the string name of the Component. Other
     * properties are specific to each component. The `resources.uris` property
     * in preset is used to register resources with [[ResourceManager]] and has
     * the same format accepted by the [[ResourceManager.registerUri]].
     * @param options Fork: `carryFrame` starts the preset on the picture the one before left, as
     * Winamp switches presets (the player); without it the preset starts on black, as a fresh
     * AVS does (the comparison and audit pages).
     */
    public loadPreset(preset: any, options: { carryFrame?: boolean } = {}) {
        // Fork: as a fresh AVS process (matters only when comparing, see avsRandom.ts).
        restartRandom();
        preset = clone(preset); // use our own copy
        // Fork: code as AVS compiles it under an AVS Trans Automation (its #define macros).
        preset = applyAvsTrans(preset);
        // Fork: a preset written for EEL2 (chavs, AVS 2.82+) is read the EEL2 way, all of it;
        // every other one as AVS 2.81's ns-eel (eel2-parser.ts). The choice rides with the code.
        markEelDialect(preset, presetEelDialect(preset));
        preset.id = "root";
        // Fork: AVS 2.81 keeps one framebuffer across presets. Without a transition the new root
        // list renders into the frame the old one left (r_transition.cpp), with one both start as
        // copies of it, and r_list.cpp clears it only with "clear every frame" — so presets made
        // as parts (S_KuPeRS — AVS Parts: DynMov …, Mov …) move the picture they find. A root that
        // never drew (its bitmaps still loading) passes on what it was given.
        if (!options.carryFrame) {
            this.dropCarried();
        } else {
            const left = (this.rootComponent as EffectList).takeFrame();
            if (left) {
                this.dropCarried();
                this.avsCarried = left;
            }
        }
        this.rootComponent.destroy();

        // setup resources
        this.rsrcMan.clear(this.presetResourceKeys);
        if ("resources" in preset && "uris" in preset.resources) {
            // Fork: a bitmap this preset names after its own pack's copy (scripts/avs-presets.mjs)
            // must not come from a copy another preset left loaded under the same name.
            this.rsrcMan.clear(Object.keys(preset.resources.uris));
            this.rsrcMan.registerUri(preset.resources.uris);
            this.presetResourceKeys = Object.keys(preset.resources.uris);
        } else {
            this.presetResourceKeys = [];
        }

        // load meta
        this.meta = clone(preset.meta);
        // Fork: buffers saved by this preset (AVS reads an unsaved one as missing).
        this.avsWrittenBuffers = new Set();
        // Fork: the Mirrors' shared fade state (r_mirror.cpp's statics), as in a fresh AVS.
        this.avsMirrorStatics = null;

        this._setupRoot(preset);
    }

    /**
     * Resets and reinitializes all the components and canvas.
     */
    public resetCanvas() {
        const preset = this.rootComponent.toJSON();
        this.rootComponent.destroy();
        // Fork: a restored context has none of the old textures.
        this.avsCarried = null;
        this.tempTSM.destroy();
        this._initGl();
        this._setupRoot(preset);
    }

    /**
     * This function should be called if the canvas element's
     * width or height attribute has changed. This allows Webvs
     * to update and resize all the buffers.
     */
    public notifyResize() {
        const gl = this.rctx.getGl();
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        // Fork: AVS drew lines, dots and sprites in pixels of a window about
        // 480 lines tall; drawn here at that size relative to the screen.
        this.avsScale = Math.max(1, gl.drawingBufferHeight / 480);
        this.tempTSM.resize();
        this.emit("resize", gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    /**
     * Cache webgl Buffers. Useful to store buffers that can be shared. e.g. geometries.
     * @param name Name of the buffer
     * @param buffer Buffer to be cached
     */
    public cacheBuffer(name: string, buffer: Buffer) {
        this.buffers[name] = buffer;
    }

    /**
     * Returns buffer cached under given name
     * @param name Name of the buffer
     * @returns The buffer cached under given name. `undefined` if not found.
     */
    public getBuffer(name: string): Buffer {
        return this.buffers[name];
    }

    /**
     * Gets the current value of a preset property. Eg. `main.get("meta")`
     * @param key preset property to be returned
     */
    public get(key: string) {
        if (key === "meta") {
            return this.meta;
        }
    }

    /**
     * Generates and returns the instantaneous preset JSON representation
     * @returns JSON representaton of the preset
     */
    public toJSON(): any {
        let preset = this.rootComponent.toJSON();
        preset = pick(preset, "clearFrame", "components");
        preset.resources = this.rsrcMan.toJSON();
        preset.meta = clone(this.meta);
        return preset;
    }

    /**
     * Destroys and cleans up all resources
     */
    public destroy() {
        this.stop();

        this.rootComponent.destroy();
        this.rootComponent = null;
        this.dropCarried();
        this.copier.destroy();
        for (const bufName in this.buffers) {
            if (!this.buffers.hasOwnProperty(bufName)) {
                continue;
            }
            this.buffers[bufName].destroy();
        }
        this.tempTSM.destroy();
        this.tempTSM = null;
        this.rctx.destroy();
        this.rctx = null;
        if (this.stats) {
            const statsDomElement = this.stats.domElement;
            statsDomElement.parentNode.removeChild(statsDomElement);
            this.stats = null;
        }
        this.rsrcMan = null;
        this.stopListening();
        this.canvas.removeEventListener("webglcontextlost", this.contextLostHander);
        this.canvas.removeEventListener("webglcontextrestored", this.contextRestoredHander);
    }

    /** Fork: lets go of the picture kept for the next preset (drawn, refused or out of date). */
    public dropCarried() {
        if (this.avsCarried) {
            this.rctx.getGl().deleteTexture(this.avsCarried);
            this.avsCarried = null;
        }
    }

    /**
     * Returns the rendering context for webgl rendering
     */
    public getRctx(): RenderingContext { return this.rctx; }

    /**
     * Returns the Resource Manager that manages media resources
     */
    public getRsrcMan(): ResourceManager { return this.rsrcMan; }

    /**
     * Returns A shader program that can be used to copy frames
     */
    public getCopier(): CopyProgram { return this.copier; }

    /**
     * Returns the analyser instance that's used to get music data
     * for the visualization
     */
    public getAnalyser(): AnalyserAdapter { return this.analyser; }

    /**
     * Returns a registry of [[Component]] classes that will be used
     * to create preset effects
     */
    public getComponentRegistry(): ComponentRegistry { return this.componentRegistry; }
    /**
     * Returns a TextureSetManager for global temporary buffers, that can
     * be shared between components.
     */
    public getTempTSM(): TextureSetManager { return this.tempTSM; }

    /**
     * Returns register bank, a map of shared register values available
     * in EEL code in components.
     */
    public getRegisterBank(): {[key: string]: number} {return this.registerBank; }

    /**
     * Returns the timestamp at which this instance was constructed
     */
    public getBootTime(): number {return this.bootTime; }
    // Fork: the player's track position and length for gettime(-1) and gettime(-2).
    private playback: (() => { position: number; duration: number } | null) | null = null;
    public setPlayback(source: (() => { position: number; duration: number } | null) | null): void { this.playback = source; }
    public getPlayback(): { position: number; duration: number } | null { return this.playback ? this.playback() : null; }

    protected setAttribute(key: string, value: any, options: any) {
        if (key === "meta") {
            this.meta = value;
            return true;
        }
        return false;
    }

    // event handlers
    private handleRsrcWait() {
        if (this.isStarted) {
            this._stopAnimation();
        }
    }

    private handleRsrcReady() {
        if (this.isStarted) {
            this._startAnimation();
        }
    }

    private _initComponentRegistry() {
        this.componentRegistry = new ComponentRegistry([
            EffectList,

            ClearScreen,
            MovingParticle,
            AvsPicture,
            SuperScope,
            Texer,

            ChannelShift,
            ColorClip,
            ColorMap,
            Convolution,
            DynamicMovement,
            // Fork: components AVS presets use that upstream lacks (trans/Extras.ts).
            Movement, ConvolutionFilter, TexerII, Blur,
            Comment, CustomBPM, SetRenderMode, OnBeatClear, AVSTransAutomation, FramerateLimiter, PictureII, DotPlane,
            Ring, Simple, Starfield, FyrewurX, Triangle, Text,
            RotoBlitter, BlitterFeedback, Interleave, FastBrightness, Multiplier,
            Brightness, Colorfade, ColorReduction, ColorModifier, Grain, Scatter, Water, Bump,
            DynamicShift, DynamicDistanceModifier, VideoDelay, AddBorders, MultiFilter, GlobalVariables,
            Ape, SVP, MultiDelay, Avi, TexerV1,
            DotGrid, OscilliscopeStar, RotatingStars, Timescope, BassSpin, DotFountain, Interferences, WaterBump,
            FadeOut,
            Invert,
            Mirror,
            Mosaic,
            UniqueTone,

            BufferSave,
            GlobalVar,

            // Fork: mscopes' modern effects and simulations (mscopes/, BSD-3).
            ...mscopesComponents,
        ]);
    }

    private _initResourceManager(prefix: string): void {
        let builtinPack = builtinResourcePack;
        if (prefix) {
            builtinPack = clone(builtinPack);
            builtinPack.prefix = prefix;
        }
        this.rsrcMan = new ResourceManager(builtinPack);
        this.listenTo(this.rsrcMan, "wait", () => this.handleRsrcWait());
        this.listenTo(this.rsrcMan, "ready", () => this.handleRsrcReady());
    }

    private _registerContextEvents() {
        this.contextLostHander = (event) => {
            event.preventDefault();
            this.stop();
        };
        this.canvas.addEventListener("webglcontextlost", this.contextLostHander);

        this.contextRestoredHander = (event) => {
            this.resetCanvas();
        };
        this.canvas.addEventListener("webglcontextrestored", this.contextRestoredHander);
    }

    private _initGl() {
        try {
            const gl = this.canvas.getContext("webgl", {alpha: false});
            if (!gl) {
                throw new Error("context is falsy");
            }
            this.rctx = new RenderingContext(gl);
            this.copier = new CopyProgram(this.rctx, true);
            this.tempTSM = new TextureSetManager(this.rctx, this.copier, true, 0);
        } catch (e) {
            throw new Error("Couldnt get webgl context" + e);
        }
    }

    private _setupRoot(preset: any) {
        this.registerBank = {};
        this.bootTime = (new Date()).getTime();
        this.rootComponent = new EffectList(this, null, preset);
    }

    private _startAnimation() {
        let drawFrame = () => {
            this.analyser.update();
            // Fork: Set render mode lasts until the end of the frame it was set in.
            this.avsRenderMode = null;
            // Fork: no effect list is running yet, so no beat decided in one.
            (this.analyser as any).beatOverride = null;
            // Fork: a Framerate Limiter that runs this frame sets the wait before the next (trans/Extras.ts).
            this.avsFrameInterval = 0;
            this.rootComponent.draw();
            this.animReqId = this.requestAnimationFrame(drawFrame);
        };

        // Wrap drawframe in stats collection if required
        if (this.stats) {
            const oldDrawFrame = drawFrame;
            drawFrame = () => {
                this.stats.begin();
                oldDrawFrame();
                this.stats.end();
            };
        }
        this.animReqId = this.requestAnimationFrame(drawFrame);
    }

    private _stopAnimation() {
        this.cancelAnimationFrame(this.animReqId);
    }
}
