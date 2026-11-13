// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * The first Texer APE ("Texer", 308 presets in the packs), as grandchild/vis_avs ports it
 * (e_texer.cpp, BSD): every lit pixel of the frame — in reading order, up to `particles` of them
 * (always at least one) — gets the bitmap centred on it, added with saturation to the output; the
 * output starts black, or as the frame with "add to input". With "colorize" the bitmap is first
 * multiplied by the lit pixel's colour, (c · m) >> 8 per channel. The result replaces the frame.
 * No bitmap (none named, or none in the packs): nothing happens.
 *
 * Config (load_legacy): 16 unused bytes, the bitmap name (260 bytes, NUL-terminated), then
 * input/output bits (& 3 == 2: add to input; & 12 == 8: colorize), then the particle count.
 * webvs's own "Texer" (code-driven sprites, Texer II's kind) is another effect.
 *
 * Above AVS's window (~480 lines) the bitmap grows with the frame (nearest pixel), as Texer II's
 * sprites do, so the picture keeps its look; up to it the arithmetic is the port's.
 */
import Component from "../Component";
import { CpuFrame } from "../ape/apeHost";
import { fromBase64Config } from "../ape/config";

import { Bitmap, parseTexerConfig, texerFrame } from "./texerV1Frame";

export default class TexerV1 extends Component {
    public static componentName: string = "TexerV1";
    public static componentTag: string = "render";
    private config: ReturnType<typeof parseTexerConfig>;
    // Fields without initializers: the base constructor runs init() before they would apply.
    private bitmap: Bitmap | null;
    private scaled: Bitmap | null;
    private scaledFor: number;
    private frame: CpuFrame | null;

    public init() {
        this.config = parseTexerConfig(fromBase64Config(this.opts.config));
        this.frame = new CpuFrame();
        this.bitmap = null;
        this.scaled = null;
        this.scaledFor = 0;
        const name = this.config.image;
        const rsrc = this.main.getRsrcMan();
        if (!name || !rsrc.hasImage(name)) {
            return;
        }
        try {
            rsrc.getImage(name, (image) => {
                if (!this.frame) {
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
                const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                const pixels = new Int32Array(canvas.width * canvas.height);
                for (let i = 0; i < pixels.length; i++) {
                    pixels[i] = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
                }
                this.bitmap = { width: canvas.width, height: canvas.height, pixels };
                this.scaled = null;
            });
        } catch (missing) {
            this.bitmap = null;
        }
    }

    /** The bitmap at the frame's scale (nearest pixel), as Texer II's sprites grow above 480 lines. */
    private sized(): Bitmap | null {
        const bitmap = this.bitmap;
        if (!bitmap) {
            return null;
        }
        const scale = this.main.avsScale || 1;
        if (scale <= 1) {
            return bitmap;
        }
        if (!this.scaled || this.scaledFor !== scale) {
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const pixels = new Int32Array(width * height);
            for (let y = 0; y < height; y++) {
                const sy = Math.min(bitmap.height - 1, Math.floor(((y + 0.5) * bitmap.height) / height));
                for (let x = 0; x < width; x++) {
                    const sx = Math.min(bitmap.width - 1, Math.floor(((x + 0.5) * bitmap.width) / width));
                    pixels[y * width + x] = bitmap.pixels[sy * bitmap.width + sx];
                }
            }
            this.scaled = { width, height, pixels };
            this.scaledFor = scale;
        }
        return this.scaled;
    }

    public draw() {
        const bitmap = this.sized();
        if (!bitmap || this.opts.enabled === false) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const frame = this.frame;
        frame.size(w, h);
        frame.read(gl);
        texerFrame(frame.framebuffer, frame.fbout, w, h, bitmap, this.config.addToInput, this.config.colorize, this.config.particles);
        const texture = frame.texture(gl, frame.fbout);
        this.main.getCopier().run(this.parent.getTSM(), { srcTexture: texture });
    }

    public destroy() {
        super.destroy();
        if (this.frame) {
            this.frame.destroy(this.main.getRctx().getGl());
            this.frame = null;
        }
        this.bitmap = null;
        this.scaled = null;
    }
}
