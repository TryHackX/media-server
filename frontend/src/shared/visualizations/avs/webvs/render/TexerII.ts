// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Texer II (Acko.net's APE; e_texer2.cpp in grandchild/vis_avs, BSD licence): the bitmap
 * drawn at every point of the code, pixel for pixel as its MMX did it.
 *
 * Each frame the picture is read back from the GPU, every particle is drawn into it on the
 * CPU in the code's order (texerParticle.ts), and the result goes back as the frame (Texer IIs
 * one after another share one read-back and one upload, cpuFrameRun.ts):
 * - "resize": the bitmap scaled to sizex × sizey with Texer II's own fixed-point bilinear
 *   filter (16.16 steps, 8-bit fractions, each product shifted right), always through the
 *   colour filter (without "colorize" a white one: × 255 >> 8);
 * - otherwise the bitmap at its size less one pixel each way, as its rectangle came out,
 *   multiplied by the colour (>> 8) only with "colorize";
 * - the ten line blend modes of Set Render Mode in Texer II's own arithmetic: 50/50 is
 *   (a + b) >> 1, multiply and "adjustable" shift the products right by 8 (resize and plain
 *   weigh "adjustable" the other way round, as the original does);
 * - negative sizes mirror and flip the bitmap; "wrap" draws a particle once more across an
 *   edge it overlaps (AVS 2.81's Texer II wrapped only once).
 *
 * At up to 480 lines that is AVS's frame. Above, the frame stands for AVS's smaller window
 * (avsScale) and particles are scaled up with it (through the resizing path).
 *
 * The resizing path in the line modes GL blends exactly (replace, additive, maximum, minimum,
 * subtractive) is drawn on the GPU with the same integer arithmetic (texerGpu.ts): no frame
 * read-back, and the per-pixel work off the processor.
 */
import { avsLineMode, avsVisdata } from "../avsDraw";
import Component from "../Component";
import { cpuFrameRun } from "../cpuFrameRun";
import compileExpr from "../expr/compileExpr";
import { EelPort } from "../../eel-wasm-backend";
import { gpuSprite, texerGpu } from "./texerGpu";
import type { GpuSprite } from "./texerGpu";
import type { ITexture, ResizeGeometry } from "./texerParticle";
import { drawParticle, fistp, paddedTexture, resizeGeometry } from "./texerParticle";

const geometry: ResizeGeometry = { left2: 0, top2: 0, right2: 0, bottom2: 0, cx0: 0, cy0: 0, sdx: 0, sdy: 0 };

/** The variables a Texer II sets and reads around each particle, in EelPort order. */
const POINT = ["i", "skip", "v", "sizex", "sizey", "red", "green", "blue", "x", "y"];
const [P_I, P_SKIP, P_V, P_SIZEX, P_SIZEY, P_RED, P_GREEN, P_BLUE, P_X, P_Y] = POINT.map((_, k) => k);

/** e_texer2.cpp's overlaps_edge: does the particle reach over the edge at ±1? */
function overlapsEdge(coord: number, size: number, sizePx: number, screenPx: number): boolean {
    const half = (size * (sizePx - 1)) / screenPx;
    const abs = Math.abs(coord);
    return abs + half > 1.0 && abs - half < 1.0;
}

export default class TexerII extends Component {
    public static componentName: string = "TexerII";
    public static componentTag: string = "render";

    private code;
    private inited: boolean;
    private port: EelPort;
    private textures: { normal: ITexture; flipped: ITexture; mirrored: ITexture; rot180: ITexture } | null;
    private loading: string;
    // The bitmap's variants on the GPU (texerGpu.ts), made when first needed (false: too large).
    private sprite: GpuSprite | null | false;

    public init() {
        const code = compileExpr(this.opts.code || {}, ["init", "onBeat", "perFrame", "perPoint"]).codeInst;
        code.setup(this.main);
        this.code = code;
        this.inited = false;
        this.textures = null;
        this.sprite = null;
        this.loadImage();
    }

    public destroy() {
        super.destroy();
        if (this.sprite) {
            this.main.getRctx().getGl().deleteTexture(this.sprite.texture);
        }
        this.sprite = null;
    }

    private loadImage() {
        const name = String(this.opts.imageSrc || "") || "avsres_texer_circle_heavyblur_21x21.bmp";
        this.loading = name;
        try {
            // A bitmap that is not there: the resource manager stands Texer II's own sprite in.
            this.main.getRsrcMan().getImage(name, (image) => {
                if (this.loading !== name) {
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
                const normal = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
                const width = canvas.width;
                const height = canvas.height;
                const flipped = new Uint8Array(normal.length);
                const mirrored = new Uint8Array(normal.length);
                const rot180 = new Uint8Array(normal.length);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const from = (y * width + x) * 4;
                        const copy = (to: Uint8Array, at: number) => to.set(normal.subarray(from, from + 4), at * 4);
                        copy(flipped, (height - y - 1) * width + x);
                        copy(mirrored, (y + 1) * width - x - 1);
                        copy(rot180, (height - y) * width - x - 1);
                    }
                }
                const make = (data: Uint8Array) => paddedTexture(data, width, height);
                this.textures = { flipped: make(flipped), mirrored: make(mirrored), normal: make(normal), rot180: make(rot180) };
                if (this.sprite) {
                    this.main.getRctx().getGl().deleteTexture(this.sprite.texture);
                }
                this.sprite = null;
            });
        } catch (missing) {
            this.textures = null;
        }
    }

    public draw() {
        const run = cpuFrameRun(this.main);
        try {
            this.drawParticles(run);
        } finally {
            // Back to the GPU unless the next child drawn is a Texer II too (cpuFrameRun.ts).
            run.finish(this.main);
        }
    }

    private drawParticles(run) {
        const code = this.code;
        const textures = this.textures;
        if (!textures) {
            return;
        }
        const gl = this.main.getRctx().getGl();
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        const imageWidth = textures.normal.width;
        const imageHeight = textures.normal.height;
        // init_variables: every frame, before any code.
        code.i = 0;
        code.x = 0;
        code.y = 0;
        code.v = 0;
        code.b = this.main.getAnalyser().isBeat() ? 1 : 0;
        code.iw = imageWidth;
        code.ih = imageHeight;
        code.sizex = 1;
        code.sizey = 1;
        code.red = 1;
        code.green = 1;
        code.blue = 1;
        code.skip = 0;
        if (!this.inited) {
            code.n = 0;
            code.init();
            this.inited = true;
        }
        code.perFrame();
        if (code.b) {
            code.onBeat();
        }
        const n = Math.max(0, Math.min(65536, fistp(Number(code.n) || 0)));
        if (n <= 0) {
            return;
        }
        const { wave } = avsVisdata(this.main);
        const line = avsLineMode(this.main);
        const resize = Boolean(this.opts.resizing);
        const colorize = Boolean(this.opts.colorFiltering);
        const wrap = Boolean(this.opts.wrapAround);
        // Above AVS's window the particles grow with the frame (the resizing path).
        const scale = this.main.avsScale || 1;
        const tsm = this.parent.getTSM();
        // The resizing path in a mode GL blends exactly: on the GPU (texerGpu.ts).
        if ((resize || scale !== 1) && this.sprite === null && texerGpu(this.main).handles(line.mode)) {
            const t = textures;
            this.sprite = gpuSprite(gl, [t.normal, t.mirrored, t.flipped, t.rot180]) || false;
        }
        const gpu = (resize || scale !== 1) && this.sprite && texerGpu(this.main).handles(line.mode) ? texerGpu(this.main) : null;
        let frame = null;
        if (gpu) {
            // A frame a Texer II before left on the processor goes back first.
            run.flush();
            gpu.begin(tsm, W, H, this.sprite, line.mode);
        } else {
            // The frame, row 0 at the top; it goes back as drawn (the run's copy: the colour, alpha 1).
            frame = run.acquire(tsm, W, H);
            run.changed();
        }
        const step = 1.0 / (n - 1);
        let i = 0.0;
        // code.i, code.x … as slots of the code's WebAssembly memory when it runs as wasm
        // (eel-wasm-backend.ts EelPort); the same reads and writes as properties otherwise.
        const port = (this.port ||= new EelPort("perPoint", POINT)).bind(code);
        for (let j = 0; j < n; ++j) {
            port.set(P_I, i);
            port.set(P_SKIP, 0.0);
            const at = Math.trunc((j * 575) / n);
            port.set(P_V, ((wave[0][at] || 0) + (wave[1][at] || 0)) / 256.0);
            i += step;
            port.run();
            if (Number(port.get(P_SKIP)) !== 0.0) {
                continue;
            }
            const sx = Number(port.get(P_SIZEX)) || 0;
            const sy = Number(port.get(P_SIZEY)) || 0;
            const szx = Math.abs(sx);
            const szy = Math.abs(sy);
            if (!(szx > 0.01) || !(szy > 0.01)) {
                continue;
            }
            const channel = (value) => Math.min(255, Math.max(0, fistp(255.0 * Number(value))));
            const color = colorize ? (channel(port.get(P_RED)) << 16) | (channel(port.get(P_GREEN)) << 8) | channel(port.get(P_BLUE)) : 0xffffff;
            const variant = sx < 0 && sy > 0 ? 1 : sx > 0 && sy < 0 ? 2 : sx < 0 && sy < 0 ? 3 : 0;
            const texture = variant === 1 ? textures.mirrored : variant === 2 ? textures.flipped : variant === 3 ? textures.rot180 : textures.normal;
            const draw = (px: number, py: number) => {
                if (gpu) {
                    const g = resizeGeometry(W, H, imageWidth, imageHeight, px, py, (resize ? szx : 1) * scale, (resize ? szy : 1) * scale, geometry);
                    if (g) {
                        gpu.add(variant, g, color);
                    }
                } else if (scale !== 1) {
                    drawParticle(frame, W, H, texture, px, py, (resize ? szx : 1) * scale, (resize ? szy : 1) * scale, color, true, colorize, line.mode, line.adjust);
                } else {
                    drawParticle(frame, W, H, texture, px, py, szx, szy, color, resize, colorize, line.mode, line.adjust);
                }
            };
            let x = Number(port.get(P_X)) || 0;
            let y = Number(port.get(P_Y)) || 0;
            if (wrap) {
                // AVS 2.81's Texer II: wrapped once, the overlap measured on the unwrapped place.
                const once = (value: number) => (value > 1.0 ? 2.0 : value < -1.0 ? -2.0 : 0.0);
                const overlapsX = overlapsEdge(x, szx, imageWidth, W);
                const overlapsY = overlapsEdge(y, szy, imageHeight, H);
                x -= once(x);
                y -= once(y);
                const signX = x > 0 ? 2.0 : -2.0;
                const signY = y > 0 ? 2.0 : -2.0;
                if (overlapsX) {
                    draw(x - signX, y);
                }
                if (overlapsY) {
                    draw(x, y - signY);
                }
                if (overlapsX && overlapsY) {
                    draw(x - signX, y - signY);
                }
            }
            draw(x, y);
        }
        if (gpu) {
            gpu.flush();
        }
    }
}
