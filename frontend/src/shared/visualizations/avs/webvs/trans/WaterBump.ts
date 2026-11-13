// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Trans / Water Bump, ported from Nullsoft's vis_avs 2.81d (r_waterbump.cpp, BSD
 * licence): a height field the frame is seen through. Every beat drops a blob
 * into it (cosine-shaped, `depth` deep and `dropRadius` wide, at a set place or
 * — random — anywhere, its radius then a percentage of the frame); every frame
 * the waves spread (the eight neighbours, quartered, minus the frame before) and
 * lose 1/2^density of themselves, and each pixel is taken from (dx >> 3, dy >> 3)
 * away, where dx and dy are the height's steps right and down.
 *
 * The field runs on the processor in AVS's integers, at the size of AVS's window
 * (about 480 lines: at up to that many it is the frame's own size), with C's
 * rand() for the random drops and AVS's loops, which take pixels two at a time
 * and on a frame of odd width wander off by one column from row to row. Which
 * pixel each one reads is sent to the shader as a small texture; the frame is
 * read there. The pixels AVS's loop never wrote (the border) keep the frame's
 * own, where AVS left whatever was in its second buffer.
 */
import { cRand } from "../avsRandom";
import { int32 } from "../avsDraw";
import { HIGH_PRECISION } from "../avsSupport";
import Component from "../Component";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";

export default class WaterBump extends Component {
    public static componentName: string = "WaterBump";
    public static componentTag: string = "trans";

    private program: ShaderProgram;
    private buffers: Int32Array[];
    private width: number;
    private height: number;
    private page: number;
    private source: Uint8Array;
    private texture: WebGLTexture;
    private textureSize: string;

    public init() {
        this.buffers = null;
        this.width = 0;
        this.height = 0;
        this.page = 0;
        this.texture = null;
        this.textureSize = "";
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    grid: { name: "u_grid", valueType: WebGLVarType._2FV },
                    source: { name: "u_source", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_source;
                uniform vec2 u_grid;
                void main() {
                    // This pixel (y down), the field's cell it lies in, and the cell it reads.
                    vec2 pixel = floor(vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y));
                    vec2 cell = min(floor((pixel * u_grid + 0.5) / u_resolution), u_grid - 1.0);
                    vec4 stored = floor(texture2D(u_source, (cell + 0.5) / u_grid) * 255.0 + 0.5);
                    vec2 from = vec2(stored.r + stored.g * 256.0, stored.b + stored.a * 256.0);
                    vec2 at = clamp(pixel + floor((from - cell) * u_resolution / u_grid + 0.5), vec2(0.0), u_resolution - 1.0);
                    setFragColor(texture2D(u_srcTexture, vec2(at.x + 0.5, u_resolution.y - at.y - 0.5) / u_resolution));
                }`,
            swapFrame: true,
        });
    }

    public draw() {
        const opts = this.opts;
        const gl = this.main.getRctx().getGl();
        const scale = this.main.avsScale || 1;
        const w = Math.max(1, Math.round(gl.drawingBufferWidth / scale));
        const h = Math.max(1, Math.round(gl.drawingBufferHeight / scale));
        if (!this.buffers || this.width !== w || this.height !== h) {
            // GlobalAlloc(GPTR): zeroed.
            this.buffers = [new Int32Array(w * h), new Int32Array(w * h)];
            this.width = w;
            this.height = h;
            this.source = new Uint8Array(w * h * 4);
        }
        if (this.main.getAnalyser().isBeat()) {
            const depth = int32(Number(opts.depth) || 0);
            const radius = int32(Number(opts.dropRadius) || 0);
            if (opts.random) {
                const max = h > w ? h : w;
                this.sineBlob(-1, -1, Math.trunc((radius * max) / 100), -depth, this.page);
            } else {
                // AVS left x or y unset for other values; the middle here.
                const x = [Math.trunc(w / 4), Math.trunc(w / 2), Math.trunc((w * 3) / 4)][int32(Number(opts.dropPositionX) || 0)] ?? Math.trunc(w / 2);
                const y = [Math.trunc(h / 4), Math.trunc(h / 2), Math.trunc((h * 3) / 4)][int32(Number(opts.dropPositionY) || 0)] ?? Math.trunc(h / 2);
                this.sineBlob(x, y, radius, -depth, this.page);
            }
        }

        // Where every pixel reads from: itself unless the loop gets to it.
        const len = w * h;
        const from = new Int32Array(len);
        for (let i = 0; i < len; i++) {
            from[i] = i;
        }
        const ptr = this.buffers[this.page];
        const take = (offset) => {
            const dx = ptr[offset] - ptr[offset + 1];
            const dy = ptr[offset] - ptr[offset + w];
            const ofs = offset + w * (dy >> 3) + (dx >> 3);
            // (Past the field's end C read whatever came next; that only happens on the
            // last row of an odd-width frame, read here as staying put.)
            if (offset < len && ofs < len && ofs > -1) {
                from[offset] = ofs;
            }
        };
        let offset = w + 1;
        for (const end = (h - 1) * w; offset < end; offset += 2) {
            for (const x = offset + w - 2; offset < x; offset++) {
                take(offset);
                offset++;
                take(offset);
            }
        }
        const source = this.source;
        for (let i = 0; i < len; i++) {
            const at = from[i];
            const row = Math.floor(at / w);
            const column = at - row * w;
            source[i * 4] = column & 255;
            source[i * 4 + 1] = column >> 8;
            source[i * 4 + 2] = row & 255;
            source[i * 4 + 3] = row >> 8;
        }
        this.upload(gl, w, h);
        this.program.run(this.parent.getTSM(), { grid: [w, h], source: this.texture });

        this.calcWater(this.page ? 0 : 1, int32(Number(opts.density) || 0));
        this.page = this.page ? 0 : 1;
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
        if (this.texture) {
            this.main.getRctx().getGl().deleteTexture(this.texture);
            this.texture = null;
        }
    }

    private upload(gl: WebGLRenderingContext, w: number, h: number) {
        if (!this.texture) {
            this.texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
        }
        const size = `${w}x${h}`;
        if (size !== this.textureSize) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
            this.textureSize = size;
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
        }
    }

    /** SineBlob(): a cosine bump of the given height (negative: a dip) added to the field. */
    private sineBlob(x: number, y: number, radius: number, height: number, page: number) {
        const w = this.width;
        const h = this.height;
        const radsquare = Math.imul(radius, radius);
        const length = (1024.0 / Math.fround(radius)) * (1024.0 / Math.fround(radius));
        // rand() % n as C does it: the sign of rand(), so a radius wider than the frame
        // puts the centre past its far edge. (n = 0 would have crashed AVS.)
        if (x < 0) {
            const n = w - 2 * radius - 1;
            if (!n) {
                return;
            }
            x = 1 + radius + (cRand() % n);
        }
        if (y < 0) {
            const n = h - 2 * radius - 1;
            if (!n) {
                return;
            }
            y = 1 + radius + (cRand() % n);
        }
        let left = -radius;
        let right = radius;
        let top = -radius;
        let bottom = radius;
        // edge clipping
        if (x - radius < 1) {
            left -= x - radius - 1;
        }
        if (y - radius < 1) {
            top -= y - radius - 1;
        }
        if (x + radius > w - 1) {
            right -= x + radius - w + 1;
        }
        if (y + radius > h - 1) {
            bottom -= y + radius - h + 1;
        }
        const buffer = this.buffers[page];
        for (let cy = top; cy < bottom; cy++) {
            for (let cx = left; cx < right; cx++) {
                const square = cy * cy + cx * cx;
                if (square < radsquare) {
                    const dist = Math.sqrt(square * length);
                    const at = w * (cy + y) + cx + x;
                    if (at >= 0 && at < buffer.length) {
                        buffer[at] += Math.trunc((Math.cos(dist) + 0xffff) * height) >> 19;
                    }
                }
            }
        }
    }

    /** CalcWater(): the next field from this one (the eight-neighbour method), damped. */
    private calcWater(npage: number, density: number) {
        const w = this.width;
        const newptr = this.buffers[npage];
        const oldptr = this.buffers[npage ? 0 : 1];
        let count = w + 1;
        for (const end = (this.height - 1) * w; count < end; count += 2) {
            for (const x = count + w - 2; count < x; count++) {
                const newh = ((oldptr[count + w]
                    + oldptr[count - w]
                    + oldptr[count + 1]
                    + oldptr[count - 1]
                    + oldptr[count - w - 1]
                    + oldptr[count - w + 1]
                    + oldptr[count + w - 1]
                    + oldptr[count + w + 1]) >> 2) - newptr[count];
                newptr[count] = newh - (newh >> density);
            }
        }
    }
}
