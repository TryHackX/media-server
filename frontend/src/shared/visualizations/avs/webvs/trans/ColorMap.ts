// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import each from "lodash-es/each";
import { cRand } from "../avsRandom";
import map from "lodash-es/map";
import sortBy from "lodash-es/sortBy";
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { avsBlend, BlendMode, Color, parseColor, WebGLVarType } from "../utils";
import RenderingContext from "../webgl/RenderingContext";
import ShaderProgram from "../webgl/ShaderProgram";
import { blendTwoGlsl, bufferBlendName, HIGH_PRECISION } from "../avsSupport";

/**
 * Color Map Item for [[IColorMapDef]]
 */
export interface IColorMapItem {
    position: number;
    color: string;
}

/**
 * A single Color Map (a list of colors with position) for [[IcolorMapOpts]]
 */
export interface IColorMapDef {
    /**
     * If true the color map can be chosen through one of the
     * [[ColorMapCycleMode]]s.
     */
    enabled: boolean;
    /**
     * Colors and their position in the [[ColorMapKey]] space
     */
    colors: IColorMapItem[];
}

/**
 * Options for [[ColorMap]] component
 */
export interface IColorMapOpts {
    /**
     * Key by which color should be mapped. see [[ColorMapKey]]
     */
    key: string;
    /**
     * Output blending mode. see [[BlendMode]]
     */
    output: string;
    /**
     * Color map cycling mode. see [[ColorMapCycleMode]]
     */
    mapCycleMode: string;
    /**
     * Color map items
     */
    maps: IColorMapDef[];
}

/**
 * Color mapping key for [[ColorMap]] component
 */
enum ColorMapKey {
    RED = 0,
    GREEN,
    BLUE,
    "(R+G+B)/2",
    "(R+G+B)/3",
    MAX,
}

/**
 * Color map cycling modes for [[ColorMap]] component
 */
enum ColorMapCycleMode {
    SINGLE = 0,
    ONBEATRANDOM,
    ONBEATSEQUENTIAL,
}

/**
 * A component that changes colors according to a gradient map using
 * a key generated from the source colors
 */
export default class ColorMap extends Component {
    public static componentName: string = "ColorMap";
    public static componentTag: string = "trans";
    protected static optUpdateHandlers = {
        key: "updateKey",
        mapCycleMode: "updateCycleMode",
        maps: "updateMap",
        output: "updateBlendMode",
    };
    protected static defaultOptions: IColorMapOpts = {
        key: "RED",
        mapCycleMode: "SINGLE",
        maps: [
            {
                enabled: true,
                colors: [
                    {position: 0, color: "#000000"},
                    {position: 255, color: "#FFFFFF"},
                ]
            }
        ],
        output: "REPLACE",
    };

    protected opts: IColorMapOpts;
    private program: ShaderProgram;
    private mapCycleMode: ColorMapCycleMode;
    // Fork: AVS's eight map slots, baked to 256 colours each (null: no map there).
    private slots: Uint8Array[];
    /** The slots whose map is enabled: the ones a cycle may pick. */
    private enabledSlots: boolean[];
    private currentSlot: number;
    private nextSlot: number;
    private step: number;
    private lookup: WebGLTexture;
    private shown: Uint8Array;
    private blendMode: BlendMode;
    private key: ColorMapKey;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.updateMap();
        this.updateKey();
        this.updateCycleMode();
        this.updateBlendMode();
    }

    public draw() {
        // Fork: map changes as AVS's Color Map makes them (e_colormap.cpp): the step
        // grows by the cycle speed up to 256; a beat (not before the step is full if
        // fast beats are skipped) picks the next map and starts over; until the step
        // is full the map shown is next·step + current·(255 − step), then next is
        // the current map.
        let shown;
        if (this.mapCycleMode !== ColorMapCycleMode.ONBEATRANDOM && this.mapCycleMode !== ColorMapCycleMode.ONBEATSEQUENTIAL) {
            this.step = 0;
            shown = this.slotMap(this.currentSlot);
        } else {
            const speed = Math.max(0, Math.min(255, Math.trunc(Number(this.opts.cycleSpeed) || 0)));
            this.step = Math.min(this.step + speed, 256);
            if (this.main.getAnalyser().isBeat() && (!this.opts.dontSkipFastBeats || this.step === 256)) {
                if (this.enabledSlots.some(Boolean)) {
                    do {
                        this.nextSlot = this.mapCycleMode === ColorMapCycleMode.ONBEATRANDOM
                            ? cRand() % 8
                            : (this.nextSlot + 1) % 8;
                    } while (!this.enabledSlots[this.nextSlot]);
                }
                this.step = 0;
            }
            if (this.step === 0) {
                shown = this.slotMap(this.currentSlot);
            } else if (this.step === 256) {
                this.currentSlot = this.nextSlot;
                shown = this.slotMap(this.currentSlot);
            } else if (this.currentSlot !== this.nextSlot) {
                const next = this.slotMap(this.nextSlot);
                const current = this.slotMap(this.currentSlot);
                const v = this.step & 0xff;
                shown = new Uint8Array(768);
                for (let i = 0; i < 768; i++) {
                    shown[i] = Math.floor((next[i] * v) / 255) + Math.floor((current[i] * (255 - v)) / 255);
                }
            } else {
                shown = this.slotMap(this.currentSlot);
            }
        }
        const gl = this.main.getRctx().getGl();
        if (shown !== this.shown) {
            gl.bindTexture(gl.TEXTURE_2D, this.lookup);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, shown);
            this.shown = shown;
        }
        // Fork: the mapped colour is blended over the frame in the shader, AVS's
        // way; upstream let GL blend it onto the swapped-in, two-frame-old texture.
        this.program.run(
            this.parent.getTSM(),
            {
                colorMap: this.lookup,
                height: gl.drawingBufferHeight,
                key: this.key,
                value: Math.max(0, Math.min(255, Number(this.opts.adjustBlend) || 0)),
            },
        );
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        if (this.lookup) {
            this.main.getRctx().getGl().deleteTexture(this.lookup);
        }
    }

    private updateMap() {
        // Fork: the maps by AVS's slot (webvsc's index), baked as AVS bakes them, every
        // one of them: "enabled" only says which maps a cycle may pick (e_colormap.cpp).
        // The first enabled one is current, map 0 when none is (and then it is drawn,
        // enabled or not); the next one starts at slot 0.
        this.slots = [null, null, null, null, null, null, null, null];
        this.enabledSlots = [false, false, false, false, false, false, false, false];
        each(this.opts.maps, (colorMap, position) => {
            const slot = Number.isInteger(colorMap.index) ? colorMap.index : position;
            if (slot >= 0 && slot < 8 && colorMap.colors && colorMap.colors.length) {
                this.slots[slot] = this._buildColorMap(colorMap.colors);
                this.enabledSlots[slot] = Boolean(colorMap.enabled);
            }
        });
        const first = this.enabledSlots.indexOf(true);
        this.currentSlot = first >= 0 ? first : 0;
        this.nextSlot = 0;
        this.step = 256;
        this.shown = null;
        if (!this.lookup) {
            const gl = this.main.getRctx().getGl();
            this.lookup = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.lookup);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
    }

    /** A slot's baked colours; a slot without a map shows grey levels. */
    private slotMap(slot: number): Uint8Array {
        let baked = this.slots[slot];
        if (!baked) {
            baked = new Uint8Array(768);
            for (let i = 0; i < 256; i++) {
                baked[i * 3] = i;
                baked[i * 3 + 1] = i;
                baked[i * 3 + 2] = i;
            }
            this.slots[slot] = null;
        }
        return baked;
    }

    private updateCycleMode() {
        this.mapCycleMode = ColorMapCycleMode[this.opts.mapCycleMode];
    }

    private updateKey() {
        this.key = ColorMapKey[this.opts.key];
    }

    private updateBlendMode() {
        this.blendMode = (BlendMode[avsBlend(this.opts.output)] ?? BlendMode.REPLACE);
        // Fork: AVS's key (whole levels) and blend (blendTwoGlsl), all in the shader.
        const mode = bufferBlendName(this.opts.output);
        if (this.program) {
            this.program.destroy();
        }
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    colorMap: { name: "u_colorMap", valueType: WebGLVarType.TEXTURE2D },
                    height: { name: "u_height", valueType: WebGLVarType._1F },
                    key: { name: "u_key", valueType: WebGLVarType._1I },
                    value: { name: "u_value", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform int u_key;
                uniform sampler2D u_colorMap;
                uniform float u_value;
                uniform float u_height;
                ${blendTwoGlsl(mode, true)}
                void main() {
                   vec3 color = getSrcColor().rgb;
                   vec3 level = floor(color * 255.0 + 0.5);
                   float key = level.r;
                   if(u_key == ${ColorMapKey.GREEN}        ) { key = level.g; }
                   if(u_key == ${ColorMapKey.BLUE}         ) { key = level.b; }
                   if(u_key == ${ColorMapKey["(R+G+B)/2"]} ) { key = min(floor((level.r + level.g + level.b) / 2.0), 255.0); }
                   if(u_key == ${ColorMapKey["(R+G+B)/3"]} ) { key = floor((level.r + level.g + level.b) / 3.0); }
                   if(u_key == ${ColorMapKey.MAX}          ) { key = max(level.r, max(level.g, level.b)); }
                   vec3 mapped = texture2D(u_colorMap, vec2((key + 0.5) / 256.0, 0.5)).rgb;
                   setFragColor(vec4(blendTwo(color, mapped), 1.0));
                }
            `,
            swapFrame: true,
        });
    }

    /**
     * Fork: a map baked as AVS bakes it (e_colormap.cpp bake_full_map): the first
     * colour up to its position, then from each colour to the next with an 8-bit
     * step lerp = 256·i / width — from + (to − from)·lerp/255 in whole levels,
     * (i·k)/255 each — and the last colour to the end.
     */
    private _buildColorMap(mapItems: IColorMapItem[]): Uint8Array {
        const sorted = sortBy(mapItems, (mapItem) => mapItem.position)
            .map((mapItem) => ({
                color: parseColor(mapItem.color),
                position: Math.max(0, Math.min(256, Math.trunc(Number(mapItem.position) || 0))),
            }));
        const baked = new Uint8Array(768);
        const put = (index: number, color: number[]) => {
            baked[index * 3] = color[0];
            baked[index * 3 + 1] = color[1];
            baked[index * 3 + 2] = color[2];
        };
        let index = 0;
        for (; index < sorted[0].position; index++) {
            put(index, sorted[0].color);
        }
        for (let k = 0; k < sorted.length - 1; k++) {
            const from = sorted[k];
            const to = sorted[k + 1];
            for (; index < to.position; index++) {
                const width = to.position - from.position;
                const lerp = Math.trunc(Math.fround((256 * Math.fround(index - from.position)) / width)) & 0xff;
                put(index, [0, 1, 2].map((c) => Math.floor((to.color[c] * lerp) / 255) + Math.floor((from.color[c] * (255 - lerp)) / 255)));
            }
        }
        const lastColor = sorted[sorted.length - 1].color;
        for (; index < 256; index++) {
            put(index, lastColor);
        }
        return baked;
    }
}
