/**
 * The first Texer APE's arithmetic (TexerV1.ts), pure: the tests run it with plain Node.
 */

export interface Bitmap {
    width: number;
    height: number;
    pixels: Int32Array;
}

export function parseTexerConfig(data: Uint8Array): { image: string; addToInput: boolean; colorize: boolean; particles: number } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 16;
    let image = "";
    if (data.length - pos >= 260) {
        for (let k = 0; k < 260 && data[pos + k]; k++) {
            image += String.fromCharCode(data[pos + k]!);
        }
    }
    pos += 260;
    let addToInput = false;
    let colorize = false;
    let particles = 100;
    if (data.length - pos >= 4) {
        const bits = view.getInt32(pos, true);
        addToInput = (bits & 3) === 2;
        colorize = (bits & 12) === 8;
    }
    pos += 4;
    if (data.length - pos >= 4) {
        particles = view.getInt32(pos, true);
    }
    return { image, addToInput, colorize, particles };
}

/** One frame of the port: `out` from `fb`, the bitmap at each lit pixel. */
export function texerFrame(fb: Int32Array, out: Int32Array, w: number, h: number, bitmap: Bitmap,
                           addToInput: boolean, colorize: boolean, particles: number) {
    if (addToInput) {
        out.set(fb);
    } else {
        out.fill(0);
    }
    const iw = bitmap.width;
    const ih = bitmap.height;
    const image = bitmap.pixels;
    const halfW = iw >> 1;
    const halfH = ih >> 1;
    let p = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const lit = fb[x + y * w]!;
            if ((lit & 0xffffff) === 0) {
                continue;
            }
            let startX = x - halfW;
            let startY = y - halfH;
            const endX = x + (iw - halfW);
            const endY = y + (ih - halfH);
            const imageStartX = -Math.min(0, startX);
            const imageStartY = -Math.min(0, startY);
            const imageEndX = iw + Math.min(0, w - endX);
            const imageEndY = ih + Math.min(0, h - endY);
            startX = Math.max(0, startX);
            startY = Math.max(0, startY);
            const mr = (lit >>> 16) & 255;
            const mg = (lit >>> 8) & 255;
            const mb = lit & 255;
            for (let iy = imageStartY, fy = startY; iy < imageEndY; iy++, fy++) {
                let at = fy * w + startX;
                for (let ix = imageStartX; ix < imageEndX; ix++, at++) {
                    const s = image[ix + iy * iw]!;
                    let r = (s >>> 16) & 255;
                    let g = (s >>> 8) & 255;
                    let b = s & 255;
                    if (colorize) {
                        r = (r * mr) >> 8;
                        g = (g * mg) >> 8;
                        b = (b * mb) >> 8;
                    }
                    const d = out[at]!;
                    r += (d >>> 16) & 255;
                    g += (d >>> 8) & 255;
                    b += d & 255;
                    out[at] = ((r > 255 ? 255 : r) << 16) | ((g > 255 ? 255 : g) << 8) | (b > 255 ? 255 : b);
                }
            }
            p++;
            if (p >= particles) {
                return;
            }
        }
    }
}
