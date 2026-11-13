// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Render / Text, after Nullsoft's vis_avs r_text.cpp (BSD licence).
 *
 * The preset's text is a list of words (";" separated in AVS); one is shown at
 * a time and the next one comes every `normSpeed` frames, or on a beat for
 * `onBeatSpeed` frames. Blank frames between words, a random word, a random
 * place, an outline or a shadow as AVS offered them. The word is drawn with
 * the browser's canvas into a texture and blended onto the frame where it has
 * ink, as AVS did with GDI.
 */
import Component from "../Component";
import { parseColorNorm, WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { blendGlsl, simpleBlend } from "../avsSupport";

/** AVS fonts are sized in pixels of a window about this tall. */
const REFERENCE_HEIGHT = 360;
const WEIGHTS = {
    DONTCARE: 400, THIN: 100, EXTRALIGHT: 200, LIGHT: 300, REGULAR: 400,
    MEDIUM: 500, SEMIBOLD: 600, BOLD: 700, EXTRABOLD: 800, BLACK: 900,
};

function css(hex): string {
    const [r, g, b] = parseColorNorm(hex || "#ffffff");
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

export default class Text extends Component {
    public static componentName: string = "Text";
    public static componentTag: string = "render";

    private program: ShaderProgram;
    private canvas: HTMLCanvasElement;
    private context: CanvasRenderingContext2D;
    private texture: WebGLTexture;
    private words: string[];
    private word: number;
    private frames: number;
    private beatFrames: number;
    private oddEven: number;
    private place: { align: string; baseline: string; x: number; y: number };
    private drawn: string;

    public init() {
        const opts = this.opts;
        const text = Array.isArray(opts.text) ? opts.text : String(opts.text ?? "").split(";");
        this.words = text.map((word) => String(word ?? ""));
        if (this.words.length === 0) {
            this.words = [""];
        }
        this.word = 0;
        this.frames = 0;
        this.beatFrames = 0;
        this.oddEven = 0;
        this.place = this.fixedPlace();
        this.drawn = null;
        this.canvas = document.createElement("canvas");
        this.context = this.canvas.getContext("2d");
        const gl = this.main.getRctx().getGl();
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: { uniforms: { text: { name: "u_text", valueType: WebGLVarType.TEXTURE2D } } },
            fragmentShader: `
                uniform sampler2D u_text;
                ${blendGlsl(simpleBlend(opts.blendMode))}
                void main() {
                    vec3 color = getSrcColor().rgb;
                    vec4 ink = texture2D(u_text, vec2(v_position.x, 1.0 - v_position.y));
                    setFragColor(vec4(mix(color, blendAvs(color, ink.rgb), ink.a), 1.0));
                }
            `,
            swapFrame: true,
        });
        this.listenTo(this.main, "resize", () => {
            this.drawn = null;
        });
    }

    public draw() {
        const opts = this.opts;
        const beat = this.main.getAnalyser().isBeat();
        const onBeat = Boolean(opts.onBeat);
        const normSpeed = Math.max(1, Number(opts.normSpeed) || 1);
        const onBeatSpeed = Math.max(1, Number(opts.onBeatSpeed) || 1);
        const words = this.words;

        const advance = (!onBeat && this.frames >= normSpeed) || (onBeat && beat && !this.beatFrames);
        if (advance) {
            if (!(opts.insertBlanks && !(this.oddEven % 2))) {
                this.word = opts.randomWord ? Math.floor(Math.random() * words.length) : (this.word + 1) % words.length;
            }
            this.oddEven = (this.oddEven + 1) % 2;
        }
        if (onBeat && beat && !this.beatFrames) {
            this.beatFrames = onBeatSpeed;
        }
        const text = opts.insertBlanks && !this.oddEven ? "" : words[this.word];
        if ((!onBeat && this.frames >= normSpeed) || (onBeat && beat && this.beatFrames === onBeatSpeed)) {
            this.frames = 0;
            this.place = opts.randomPosition ? this.randomPlace(text) : this.fixedPlace();
            this.drawn = null;
        }
        if (!(onBeat && !this.beatFrames) && text) {
            this.render(text);
            this.program.run(this.parent.getTSM(), { text: this.texture });
        }
        if (!onBeat) {
            this.frames++;
        }
        if (onBeat && this.beatFrames) {
            this.beatFrames--;
        }
    }

    public destroy() {
        super.destroy();
        if (this.program) {
            this.program.destroy();
        }
        if (this.texture) {
            this.main.getRctx().getGl().deleteTexture(this.texture);
        }
    }

    private scale(): number {
        const gl = this.main.getRctx().getGl();
        return gl.drawingBufferHeight / REFERENCE_HEIGHT;
    }

    private font(): string {
        const opts = this.opts;
        const height = Math.abs(Number(opts.fontHeight) || 0) || 24;
        const size = Math.max(6, Math.round(height * this.scale()));
        const weight = WEIGHTS[String(opts.weight || "").toUpperCase()] || 400;
        const family = String(opts.fontName || "").replace(/["\\]/g, "").trim() || "Arial";
        return `${opts.italic ? "italic " : ""}${weight} ${size}px "${family}", sans-serif`;
    }

    private fixedPlace() {
        const opts = this.opts;
        const align = { LEFT: "left", CENTER: "center", RIGHT: "right" }[String(opts.horizontalAlign || "").toUpperCase()] || "center";
        const baseline = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" }[String(opts.verticalAlign || "").toUpperCase()] || "middle";
        return { align, baseline, x: Number(opts.shiftX) || 0, y: Number(opts.shiftY) || 0 };
    }

    /** AVS: left/top aligned at a random percentage that keeps the word on screen. */
    private randomPlace(text: string) {
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        this.context.font = this.font();
        const metrics = this.context.measureText(text || " ");
        const textHeight = (metrics.actualBoundingBoxAscent || 0) + (metrics.actualBoundingBoxDescent || 0);
        const room = (used, total) => Math.max(1, Math.floor(((total - used) / total) * 100));
        return {
            align: "left",
            baseline: "top",
            x: metrics.width < width ? Math.floor(Math.random() * room(metrics.width, width)) : 0,
            y: textHeight < height ? Math.floor(Math.random() * room(textHeight, height)) : 0,
        };
    }

    private render(text: string) {
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const key = `${text}|${width}x${height}|${this.place.align}|${this.place.baseline}|${this.place.x}|${this.place.y}`;
        if (key === this.drawn) {
            return;
        }
        this.drawn = key;
        const canvas = this.canvas;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const context = this.context;
        const opts = this.opts;
        context.clearRect(0, 0, width, height);
        context.font = this.font();
        context.textAlign = this.place.align;
        context.textBaseline = this.place.baseline;
        // The shift is a signed percentage of the window, cut to whole pixels as r_text.cpp does.
        const x = (this.place.align === "left" ? 0 : this.place.align === "right" ? width : width / 2) + Math.trunc((this.place.x * width) / 100);
        const y = (this.place.baseline === "top" ? 0 : this.place.baseline === "bottom" ? height : height / 2) + Math.trunc((this.place.y * height) / 100);
        const edge = Math.max(1, Math.round((Number(opts.outlineShadowSize) || 1) * this.scale()));
        if (opts.outline) {
            context.fillStyle = css(opts.outlineColor);
            for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
                context.fillText(text, x + dx * edge, y + dy * edge);
            }
        } else if (opts.shadow) {
            context.fillStyle = css(opts.outlineColor);
            context.fillText(text, x + edge, y + edge);
        }
        context.fillStyle = css(opts.color);
        context.fillText(text, x, y);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
}
