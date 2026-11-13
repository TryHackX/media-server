// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * AVS's two picture effects, after Nullsoft's vis_avs (BSD licence, see
 * LICENSE-vis_avs.txt): Render / Picture (r_picture.cpp) and the Picture II APE
 * as grandchild/vis_avs carries it (e_picture2.cpp).
 *
 * Both scale the bitmap to the frame on the CPU, the way AVS did, once per
 * frame size: Picture by whole pixels (StretchBlt, colour-on-colour: each pixel the
 * source pixel under its centre), with
 * black bars when it keeps the aspect ratio; Picture II by whole pixels or with
 * AVS's integer bilinear filter (BLEND4). The scaled picture is then blended
 * onto the frame in the shader, level for level (blendTwoGlsl).
 *
 * Upstream webvs's Picture drew a sprite at its own size and read other option
 * names, so presets with a picture (the AVSociety intros) showed a dot, and
 * Picture II drew nothing at all.
 */
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { blendTwoGlsl, HIGH_PRECISION } from "../avsSupport";

/** The picture's pixels: RGBA, row 0 at the top. */
interface IPixels {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

/** A frame-sized picture, uploaded as a texture, blended onto the frame. */
abstract class PictureBase extends Component {
    protected pixels: IPixels;
    private texture: WebGLTexture;
    private textureWidth: number;
    private textureHeight: number;
    private programs: { [mode: string]: ShaderProgram };
    private loading: string;

    public init() {
        this.programs = {};
        this.textureWidth = 0;
        this.textureHeight = 0;
        this.pixels = null;
        this.loadImage();
    }

    public destroy() {
        super.destroy();
        for (const mode of Object.keys(this.programs || {})) {
            this.programs[mode].destroy();
        }
        this.programs = {};
        if (this.texture) {
            this.main.getRctx().getGl().deleteTexture(this.texture);
            this.texture = null;
        }
    }

    /** The bitmap's file name in the options. */
    protected abstract imageName(): string;

    /** The frame-sized picture for this frame size: RGBA, row 0 at the top. */
    protected abstract scale(width: number, height: number): Uint8Array;

    /** Blends the picture onto the frame with one of blendTwoGlsl's modes. */
    protected blend(mode: string, adjust = 0) {
        if (!this.pixels || mode === "IGNORE") {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (!this.texture || this.textureWidth !== width || this.textureHeight !== height) {
            this.upload(width, height);
        }
        this.program(mode).run(this.parent.getTSM(), {
            height,
            picture: this.texture,
            value: Math.max(0, Math.min(255, Math.trunc(Number(adjust) || 0))),
        });
    }

    /** The scaled picture again, at the next frame (a new size or a new bitmap). */
    protected invalidate() {
        this.textureWidth = 0;
        this.textureHeight = 0;
    }

    private loadImage() {
        const name = String(this.imageName() || "");
        // AVS draws nothing without the bitmap; getImage would stand a sprite in.
        if (!name || !this.main.getRsrcMan().hasImage(name)) {
            return;
        }
        this.loading = name;
        try {
            this.main.getRsrcMan().getImage(name, (image) => {
                if (this.loading !== name || !this.programs) {
                    return;
                }
                const canvas = document.createElement("canvas");
                canvas.width = image.naturalWidth || image.width;
                canvas.height = image.naturalHeight || image.height;
                if (!canvas.width || !canvas.height) {
                    return;
                }
                const context = canvas.getContext("2d");
                context.drawImage(image, 0, 0);
                const data = context.getImageData(0, 0, canvas.width, canvas.height);
                this.pixels = { width: canvas.width, height: canvas.height, data: data.data };
                this.invalidate();
            });
        } catch (missing) {
            // AVS draws nothing when the bitmap cannot be loaded.
            this.pixels = null;
        }
    }

    private upload(width: number, height: number) {
        const gl = this.main.getRctx().getGl();
        if (!this.texture) {
            this.texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.scale(width, height));
        this.textureWidth = width;
        this.textureHeight = height;
    }

    private program(mode: string): ShaderProgram {
        let program = this.programs[mode];
        if (!program) {
            program = new ShaderProgram(this.main.getRctx(), {
                bindings: {
                    uniforms: {
                        height: { name: "u_height", valueType: WebGLVarType._1F },
                        picture: { name: "u_picture", valueType: WebGLVarType.TEXTURE2D },
                        value: { name: "u_value", valueType: WebGLVarType._1F },
                    },
                },
                fragmentShader: `
                    ${HIGH_PRECISION}
                    uniform sampler2D u_picture;
                    uniform float u_height;
                    uniform float u_value;
                    ${blendTwoGlsl(mode, true)}
                    void main() {
                        vec2 at = (floor(gl_FragCoord.xy) + 0.5) / u_resolution;
                        vec3 picture = texture2D(u_picture, vec2(at.x, 1.0 - at.y)).rgb;
                        setFragColor(vec4(blendTwo(getSrcColor().rgb, picture), 1.0));
                    }
                `,
                swapFrame: true,
            });
            this.programs[mode] = program;
        }
        return program;
    }
}

/** RGBA of the bitmap's pixel (x, y). */
function pixelAt(pixels: IPixels, x: number, y: number, out: Uint8Array, index: number) {
    const from = (x + y * pixels.width) * 4;
    out[index] = pixels.data[from];
    out[index + 1] = pixels.data[from + 1];
    out[index + 2] = pixels.data[from + 2];
    out[index + 3] = 255;
}

/**
 * Render / Picture (r_picture.cpp): the bitmap stretched to the frame, or kept
 * in proportion along one axis with black around it. Replace, additive or
 * 50/50; "adapt" turns 50/50 into additive on a beat and for `onBeatPersist`
 * frames after it.
 */
export class AvsPicture extends PictureBase {
    public static componentName: string = "Picture";
    public static componentTag: string = "render";

    private persistCount: number = 0;

    public draw() {
        const opts = this.opts;
        const beat = this.main.getAnalyser().isBeat();
        const persist = Math.trunc(Number(opts.onBeatPersist) || 0);
        if (beat) {
            this.persistCount = persist;
        } else if (this.persistCount > 0) {
            this.persistCount--;
        }
        const mode = String(opts.blendMode || "").toUpperCase();
        const additive = mode === "ADDITIVE";
        const average = mode === "FIFTY_FIFTY";
        const adapt = Boolean(Number(opts.adapt));
        if (additive || (adapt && (beat || this.persistCount > 0))) {
            this.blend("ADDITIVE");
        } else if (average || adapt) {
            this.blend("AVERAGE");
        } else {
            this.blend("REPLACE");
        }
    }

    protected imageName(): string {
        return this.opts.file || this.opts.src;
    }

    protected scale(width: number, height: number): Uint8Array {
        const pixels = this.pixels;
        const out = new Uint8Array(width * height * 4);
        let outWidth = width;
        let outHeight = height;
        let xStart = 0;
        let yStart = 0;
        if (Number(this.opts.ratio)) {
            if (String(this.opts.aspectRatioAxis || "X").toUpperCase() !== "Y") {
                outHeight = Math.trunc((pixels.height * width) / pixels.width);
                yStart = Math.trunc(height / 2) - Math.trunc(outHeight / 2);
            } else {
                outWidth = Math.trunc((pixels.width * height) / pixels.height);
                xStart = Math.trunc(width / 2) - Math.trunc(outWidth / 2);
            }
        }
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (x + y * width) * 4;
                out[index + 3] = 255;
                if (x < xStart || x >= xStart + outWidth || y < yStart || y >= yStart + outHeight) {
                    continue;
                }
                // StretchBlt with COLORONCOLOR samples at pixel centres: source ⌊(d + ½)·s / D⌋,
                // measured on GDI itself (scratch/avs-reference/tools/gdi_stretch.py, 60 of 60
                // axes; ⌊d·s / D⌋ matched 15).
                const sourceX = Math.floor(((2 * (x - xStart) + 1) * pixels.width) / (2 * outWidth));
                const sourceY = Math.floor(((2 * (y - yStart) + 1) * pixels.height) / (2 * outHeight));
                pixelAt(pixels, sourceX, sourceY, out, index);
            }
        }
        return out;
    }
}

/**
 * Picture II (UnConeD's APE): the bitmap scaled to the frame by whole pixels or
 * with AVS's bilinear filter, blended in one of ten modes; a beat frame may use
 * its own mode, filter and adjustable value.
 */
export class PictureII extends PictureBase {
    public static componentName: string = "PictureII";
    public static componentTag: string = "render";

    private plain: Uint8Array;
    private smooth: Uint8Array;
    private sizeKey: string;
    private builtFrom: IPixels;
    private beatSmooth: boolean;

    public draw() {
        const opts = this.opts;
        const beat = this.main.getAnalyser().isBeat();
        const smooth = beat ? Boolean(opts.onBeatBilinear) : Boolean(opts.bilinear);
        if (smooth !== this.beatSmooth) {
            // The texture holds one of the two scalings: upload the other one.
            this.beatSmooth = smooth;
            this.invalidate();
        }
        const mode = String((beat ? opts.onBeatOutput : opts.blendMode) || "REPLACE").toUpperCase();
        const adjust = beat ? opts.onBeatAdjustBlend : opts.adjustBlend;
        this.blend(mode === "FIFTY_FIFTY" ? "AVERAGE" : mode, adjust);
    }

    protected imageName(): string {
        return this.opts.image;
    }

    protected scale(width: number, height: number): Uint8Array {
        const key = width + "x" + height;
        if (this.sizeKey !== key || this.builtFrom !== this.pixels || !this.plain) {
            this.sizeKey = key;
            this.builtFrom = this.pixels;
            this.build(width, height);
        }
        return this.beatSmooth ? this.smooth : this.plain;
    }

    /** e_picture2.cpp refresh_image(): both scalings of the bitmap with a one-pixel border. */
    private build(width: number, height: number) {
        const pixels = this.pixels;
        const iw = pixels.width + 2;
        const ih = pixels.height + 2;
        // The first and last rows and columns doubled, so the filter reads "outside" the image.
        const padded = new Uint8Array(iw * ih * 4);
        for (let y = 0; y < ih; y++) {
            for (let x = 0; x < iw; x++) {
                const sourceX = Math.max(0, Math.min(iw - 3, x - 1));
                const sourceY = Math.max(0, Math.min(ih - 3, y - 1));
                pixelAt(pixels, sourceX, sourceY, padded, (x + y * iw) * 4);
            }
        }
        const smooth = new Uint8Array(width * height * 4);
        const plain = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            const py = 0.5 + (y * (ih - 2)) / height;
            const pyi = Math.trunc(py);
            const fy = Math.trunc((py - pyi) * 256) & 255;
            for (let x = 0; x < width; x++) {
                const px = 0.5 + (x * (iw - 2)) / width;
                const pxi = Math.trunc(px);
                const fx = Math.trunc((px - pxi) * 256) & 255;
                const a = (pxi + pyi * iw) * 4;
                const b = a + 4;
                const c = a + iw * 4;
                const d = c + 4;
                const index = (x + y * width) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    // BLEND4: each row mixed by the 8-bit fraction, both shifts rounding down.
                    const top = (padded[a + channel] * (255 - fx) + padded[b + channel] * fx) >> 8;
                    const bottom = (padded[c + channel] * (255 - fx) + padded[d + channel] * fx) >> 8;
                    smooth[index + channel] = (top * (255 - fy) + bottom * fy) >> 8;
                }
                smooth[index + 3] = 255;
                const nearest = (1 + Math.trunc((x * (iw - 2)) / width) + (1 + Math.trunc((y * (ih - 2)) / height)) * iw) * 4;
                plain[index] = padded[nearest];
                plain[index + 1] = padded[nearest + 1];
                plain[index + 2] = padded[nearest + 2];
                plain[index + 3] = 255;
            }
        }
        this.smooth = smooth;
        this.plain = plain;
    }
}
