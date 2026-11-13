// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * AVS's classic render effects, ported from Nullsoft's vis_avs 2.81d (BSD licence):
 * Simple (r_simple.cpp), Dot Grid (r_dotgrid.cpp), Oscilloscope Star (r_oscstar.cpp),
 * Ring (r_oscring.cpp), Rotating Stars (r_rotstar.cpp), Timescope (r_timescope.cpp),
 * Bass Spin (r_bspin.cpp) and Dot Fountain (r_dotfnt.cpp). Audio comes as AVS's visdata
 * bytes, left and right (avsDraw.ts avsVisdata, avsChannel).
 *
 * Each keeps the original's state from frame to frame and does its arithmetic the
 * same way: C's integer division and (int) casts, single precision where AVS used
 * float, the 64-step colour cycle, lines from linedraw.cpp and pixels blended with
 * BLEND_LINE (avsDraw.ts), in the line blend mode and width a Set Render Mode
 * chose. Geometry is worked out on this frame's size as AVS did on its window's;
 * where AVS counted in pixels (Dot Grid's spacing, Timescope's columns, the line
 * width, a fountain dot) the effect runs at the size of AVS's window (about 480
 * lines) and is drawn scaled up, as the Starfield is. At up to 480 lines that is
 * AVS's frame exactly.
 */
import { AVS_BLEND_GLSL, avsChannel, avsColor, avsCycleColor, avsLine, avsLineMode, avsPlotter, avsVisdata, BLEND_ADDITIVE, BLEND_AVERAGE, BLEND_REPLACE, int32, matrixApply, matrixMultiply, matrixRotate, matrixTranslate } from "../avsDraw";
import Component from "../Component";
import { WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";

/** Colours of a colour-list effect; AVS read more than 16 as none (`fallback`, if any). */
function colorList(value, fallback: number[]): number[] {
    if (!Array.isArray(value)) {
        return fallback;
    }
    return value.length > 16 ? fallback : value.map(avsColor);
}

/** The frame's size, and the size of the AVS window it stands for. */
function frameSize(main) {
    const gl = main.getRctx().getGl();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const scale = main.avsScale || 1;
    return { h, w, avsH: Math.max(1, Math.round(h / scale)), avsW: Math.max(1, Math.round(w / scale)) };
}

/** AVS's one-pixel dot at (x, y), as a `size` × `size` block on a frame larger than AVS's window. */
function plotDot(plotter, x: number, y: number, w: number, h: number, size: number, color: number) {
    if (size === 1) {
        plotter.plot(y * w + x, color);
        return;
    }
    const lead = size >> 1;
    for (let row = Math.max(0, y - lead); row < Math.min(h, y - lead + size); row++) {
        for (let column = Math.max(0, x - lead); column < Math.min(w, x - lead + size); column++) {
            plotter.plot(row * w + column, color);
        }
    }
}

const f = Math.fround;

/**
 * Simple: the spectrum (200 values) or the waveform (288) across the frame, as a
 * solid shape, a line or dots, at the top, the bottom or the middle, in the cycled
 * colour (r_simple.cpp). Solid and line modes draw lines in the line blend mode
 * and width; dots are written over what is there. The centre channel is AVS's
 * left / 2 + right / 2 of the signed bytes.
 */
export class Simple extends Component {
    public static componentName: string = "Simple";
    public static componentTag: string = "render";

    private colors: number[];
    private colorPos: number;

    public init() {
        this.colors = colorList(this.opts.colors, []);
        this.colorPos = 0;
    }

    public draw() {
        const colors = this.colors;
        if (!colors.length) {
            return;
        }
        const opts = this.opts;
        // webvsc's names for the bits of `effect`: bit 6 dots, (effect & 3) the kind
        // (0 solid analyzer, 1 line analyzer, 2 line scope, 3 solid scope; for dots
        // bit 1 alone: scope or analyzer), (effect >> 2) & 3 the channel, (effect >> 4) & 3
        // the position.
        const render = String(opts.renderType || "").toUpperCase();
        const scope = String(opts.audioSource || "").toUpperCase().indexOf("WAVE") === 0;
        const dots = render === "DOTS";
        const kind = dots ? (scope ? 2 : 0) : render === "LINES" ? (scope ? 2 : 1) : (scope ? 3 : 0);
        const channel = { LEFT: 0, RIGHT: 1, CENTER: 2 }[String(opts.audioChannel || "").toUpperCase()] ?? 3;
        const yPos = { TOP: 0, BOTTOM: 1, CENTER: 2 }[String(opts.positionY || "").toUpperCase()] ?? 3;
        const { w, h } = frameSize(this.main);
        const yscale = f(f(h / 2) / 256);
        const xscale = f(288 / w);
        this.colorPos++;
        if (this.colorPos >= colors.length * 64) {
            this.colorPos = 0;
        }
        const color = avsCycleColor(colors, this.colorPos);
        // fa_data: visdata[scope ? 1 : 0][channel] as unsigned bytes; the centre is
        // visdata[..][0][x] / 2 + visdata[..][1][x] / 2 on the signed ones.
        const fa = avsChannel(avsVisdata(this.main), kind > 1, channel);
        const line = avsLineMode(this.main);
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        if (dots) {
            const size = Math.max(1, Math.round(this.main.avsScale || 1));
            if (kind === 2) {
                // dot scope
                const yh = yPos === 2 ? Math.trunc(h / 4) : Math.trunc((yPos * h) / 2);
                for (let x = 0; x < w; x++) {
                    const r = f(x * xscale);
                    const ir = Math.trunc(r);
                    const s1 = f(r - ir);
                    const yr = f(f((fa[ir] ^ 128) * f(1 - s1)) + f((fa[ir + 1] ^ 128) * s1));
                    const y = yh + Math.trunc(f(yr * yscale));
                    if (y >= 0 && y < h) {
                        plotDot(plotter, x, y, w, h, size, color);
                    }
                }
            } else {
                // dot analyzer
                let h2 = Math.trunc(h / 2);
                let ys = yscale;
                const xs = f(200 / w);
                let adj = 1;
                if (yPos !== 1) {
                    ys = -ys;
                    adj = 0;
                }
                if (yPos === 2) {
                    h2 -= Math.trunc(f(f(ys * 256) / 2));
                }
                for (let x = 0; x < w; x++) {
                    const r = f(x * xs);
                    const ir = Math.trunc(r);
                    const s1 = f(r - ir);
                    const yr = f(f(fa[ir] * f(1 - s1)) + f(fa[ir + 1] * s1));
                    const y = h2 + adj + Math.trunc(f(f(yr * ys) - 1));
                    if (y >= 0 && y < h) {
                        plotDot(plotter, x, y, w, h, size, color);
                    }
                }
            }
            // Dots are written, not blended.
            plotter.flush(this.parent.getTSM(), BLEND_REPLACE, 0);
            return;
        }
        if (kind === 0 || kind === 1) {
            let h2 = Math.trunc(h / 2);
            let ys = yscale;
            let adj = 1;
            if (yPos !== 1) {
                ys = -ys;
                adj = 0;
            }
            if (yPos === 2) {
                h2 -= Math.trunc(f(f(ys * 256) / 2));
            }
            if (kind === 0) {
                // solid analyzer: a column a pixel, side by side (AVS's own line width)
                const xs = f(200 / w);
                for (let x = 0; x < w; x++) {
                    const r = f(x * xs);
                    const ir = Math.trunc(r);
                    const s1 = f(r - ir);
                    const yr = f(f(fa[ir] * f(1 - s1)) + f(fa[ir + 1] * s1));
                    avsLine(plotter, x, h2 - adj, x, h2 + adj + Math.trunc(f(f(yr * ys) - 1)), w, h, color, line.avsWidth);
                }
            } else {
                // line analyzer: 200 values
                const xs = f(f(1 / xscale) * f(288 / 200));
                let ly = h2 + Math.trunc(f(fa[0] * ys));
                let lx = 0;
                for (let x = 1; x < 200; x++) {
                    const oy = h2 + Math.trunc(f(fa[x] * ys));
                    const ox = Math.trunc(f(x * xs));
                    avsLine(plotter, lx, ly, ox, oy, w, h, color, line.width);
                    ly = oy;
                    lx = ox;
                }
            }
        } else {
            const yh = yPos === 2 ? Math.trunc(h / 4) : Math.trunc((yPos * h) / 2);
            if (kind === 2) {
                // line scope: 288 values
                const xs = f(1 / xscale);
                let lx = 0;
                let ly = yh + Math.trunc(f((fa[0] ^ 128) * yscale));
                for (let x = 1; x < 288; x++) {
                    const ox = Math.trunc(f(x * xs));
                    const oy = yh + Math.trunc(f((fa[x] ^ 128) * yscale));
                    avsLine(plotter, lx, ly, ox, oy, w, h, color, line.width);
                    lx = ox;
                    ly = oy;
                }
            } else {
                // solid scope: a column a pixel from the middle of the band to the wave
                const ys = yh + Math.trunc(f(yscale * 128));
                for (let x = 0; x < w; x++) {
                    const r = f(x * xscale);
                    const ir = Math.trunc(r);
                    const s1 = f(r - ir);
                    const yr = f(f((fa[ir] ^ 128) * f(1 - s1)) + f((fa[ir + 1] ^ 128) * s1));
                    avsLine(plotter, x, ys - 1, x, yh + Math.trunc(f(yr * yscale)), w, h, color, line.avsWidth);
                }
            }
        }
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust);
    }
}

/**
 * Dot Grid: a dot every `spacing` pixels both ways, the grid moving by speedX,
 * speedY 1/256 pixel a frame, in the cycled colour; replace, additive, 50/50 or
 * the line blend mode.
 */
export class DotGrid extends Component {
    public static componentName: string = "DotGrid";
    public static componentTag: string = "render";

    private program: ShaderProgram;
    private colors: number[];
    private colorPos: number;
    private xp: number;
    private yp: number;
    private spacing: number;
    private blend: number;

    public init() {
        const opts = this.opts;
        this.colors = colorList(opts.colors, []);
        this.colorPos = 0;
        this.xp = 0;
        this.yp = 0;
        this.spacing = int32(Number(opts.spacing) || 0);
        this.blend = { REPLACE: 0, ADDITIVE: 1, FIFTY_FIFTY: 2, DEFAULT: 3 }[String(opts.blendMode || "").toUpperCase()] ?? 0;
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    adjust: { name: "u_adjust", valueType: WebGLVarType._1F },
                    color: { name: "u_color", valueType: WebGLVarType._3FV },
                    grid: { name: "u_grid", valueType: WebGLVarType._2FV },
                    mode: { name: "u_mode", valueType: WebGLVarType._1I },
                    spacing: { name: "u_spacing", valueType: WebGLVarType._1F },
                    start: { name: "u_start", valueType: WebGLVarType._2FV },
                },
            },
            fragmentShader: `
                ${AVS_BLEND_GLSL}
                uniform vec2 u_start;
                uniform float u_spacing;
                uniform vec2 u_grid;
                uniform vec3 u_color;
                uniform int u_mode;
                uniform float u_adjust;
                void main() {
                    vec3 dest = floor(texture2D(u_srcTexture, gl_FragCoord.xy / u_resolution).rgb * 255.0 + 0.5);
                    // The pixel of AVS's frame (y down) this one is part of.
                    vec2 pixel = floor(vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y));
                    vec2 cell = floor((pixel * u_grid + 0.5) / u_resolution);
                    vec2 along = cell - u_start;
                    vec2 rest = along - u_spacing * floor((along + 0.5) / u_spacing);
                    if (along.x > -0.5 && along.y > -0.5 && abs(rest.x) < 0.5 && abs(rest.y) < 0.5) {
                        dest = avsBlendLine(u_mode, dest, u_color, u_adjust);
                    }
                    setFragColor(vec4(dest / 255.0, 1.0));
                }`,
            swapFrame: true,
        });
    }

    public draw() {
        const colors = this.colors;
        if (!colors.length) {
            return;
        }
        this.colorPos++;
        if (this.colorPos >= colors.length * 64) {
            this.colorPos = 0;
        }
        const color = avsCycleColor(colors, this.colorPos);
        if (this.spacing < 2) {
            this.spacing = 2;
        }
        const spacing = this.spacing;
        // while (yp < 0) yp += spacing * 256;
        const period = spacing * 256;
        if (this.yp < 0) {
            this.yp += Math.ceil(-this.yp / period) * period;
        }
        if (this.xp < 0) {
            this.xp += Math.ceil(-this.xp / period) * period;
        }
        const sy = (this.yp >> 8) % spacing;
        const sx = (this.xp >> 8) % spacing;
        let mode = BLEND_REPLACE;
        let adjust = 0;
        if (this.blend === 1) {
            mode = BLEND_ADDITIVE;
        } else if (this.blend === 2) {
            mode = BLEND_AVERAGE;
        } else if (this.blend === 3) {
            const line = avsLineMode(this.main);
            mode = line.mode;
            adjust = line.adjust;
        }
        const { avsW, avsH } = frameSize(this.main);
        this.program.run(this.parent.getTSM(), {
            adjust,
            color: [(color >> 16) & 255, (color >> 8) & 255, color & 255],
            grid: [avsW, avsH],
            mode,
            spacing,
            start: [sx, sy],
        });
        this.xp = int32(this.xp + int32(Number(this.opts.speedX) || 0));
        this.yp = int32(this.yp + int32(Number(this.opts.speedY) || 0));
    }

    public destroy() {
        super.destroy();
        this.program.destroy();
    }
}

/**
 * Oscilloscope Star: five arms of 64 waveform values each, turning by rotation/100
 * radians a frame, the swing growing from the centre outwards.
 */
export class OscilliscopeStar extends Component {
    public static componentName: string = "OscilliscopeStar";
    public static componentTag: string = "render";

    private colors: number[];
    private colorPos: number;
    private turn: number;
    private channel: number;
    private position: number;

    public init() {
        const opts = this.opts;
        this.colors = colorList(opts.colors, [0xffffff]);
        this.colorPos = 0;
        this.turn = 0;
        // (effect >> 2) & 3 and effect >> 4; webvsc names 0…2 and leaves 3 unnamed.
        this.channel = { LEFT: 0, RIGHT: 1 }[String(opts.audioChannel || "").toUpperCase()] ?? 2;
        this.position = { LEFT: 0, RIGHT: 1, CENTER: 2 }[String(opts.positionX || "").toUpperCase()] ?? 3;
    }

    public draw() {
        const colors = this.colors;
        if (!colors.length) {
            return;
        }
        this.colorPos++;
        if (this.colorPos >= colors.length * 64) {
            this.colorPos = 0;
        }
        const color = avsCycleColor(colors, this.colorPos);
        const { w, h } = frameSize(this.main);
        // fa_data: the waveform's channel, or its centre visdata[1][0][x] / 2 + visdata[1][1][x] / 2.
        const fa = avsChannel(avsVisdata(this.main), true, this.channel);
        const scale = int32(Number(this.opts.size) || 0) / 32.0;
        const size = Math.min(Math.trunc(h * scale), Math.trunc(w * scale));
        const centre = this.position === 2 ? Math.trunc(w / 2) : this.position === 0 ? Math.trunc(w / 4) : Math.trunc(w / 2) + Math.trunc(w / 4);
        const middle = Math.trunc(h / 2);
        const line = avsLineMode(this.main);
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        let ii = 0;
        for (let q = 0; q < 5; q++) {
            const s = Math.sin(this.turn + q * (3.14159 * 2.0 / 5.0));
            const c = Math.cos(this.turn + q * (3.14159 * 2.0 / 5.0));
            let p = 0.0;
            let lx = centre;
            let ly = middle;
            const dp = size / 64;
            let dfactor = 1.0 / 1024.0;
            const hw = size;
            for (let t = 0; t < 64; t++) {
                const ale = ((fa[ii] ^ 128) - 128) * dfactor * hw;
                ii++;
                const x = centre + Math.trunc(c * p) - Math.trunc(s * ale);
                const y = middle + Math.trunc(s * p) + Math.trunc(c * ale);
                if ((x >= 0 && x < w && y >= 0 && y < h) || (lx >= 0 && lx < w && ly >= 0 && ly < h)) {
                    avsLine(plotter, x, y, lx, ly, w, h, color, line.width);
                }
                lx = x;
                ly = y;
                p += dp;
                dfactor -= ((1.0 / 1024.0) - (1.0 / 128.0)) / 64.0;
            }
        }
        this.turn += 0.01 * int32(Number(this.opts.rotation) || 0);
        if (this.turn >= 3.14159 * 2) {
            this.turn -= 3.14159 * 2;
        }
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust);
    }
}

/**
 * Ring (r_oscring.cpp): 80 segments around a centre at ½, ¼ or ¾ of the width, the point
 * at angle −q·2π/80 at min(w, h)·size/32 times 0.1 + 0.9·level, the level of audio value
 * q (mirrored past 40): the waveform byte as (b ^ 128)/255, the spectrum as the pair
 * (b[2q]/2 + b[2q+1]/2)/255, from the chosen channel or AVS's centre of the two.
 */
export class Ring extends Component {
    public static componentName: string = "Ring";
    public static componentTag: string = "render";

    private colors: number[];
    private colorPos: number;
    private channel: number;
    private position: number;
    private spectrum: boolean;

    public init() {
        const opts = this.opts;
        // More than 16 colours: AVS kept its default one, white.
        this.colors = colorList(opts.colors, [0xffffff]);
        this.colorPos = 0;
        // (effect >> 2) & 3 and effect >> 4; webvsc names 0…2 and leaves 3 unnamed.
        this.channel = { LEFT: 0, RIGHT: 1 }[String(opts.audioChannel || "").toUpperCase()] ?? 2;
        this.position = { LEFT: 0, RIGHT: 1, CENTER: 2 }[String(opts.positionX || "").toUpperCase()] ?? 3;
        // `source ? 0 : 1`: any source but 0 is the spectrum.
        this.spectrum = String(opts.audioSource || "").toUpperCase().indexOf("SPEC") === 0;
    }

    public draw() {
        const colors = this.colors;
        if (!colors.length) {
            return;
        }
        this.colorPos++;
        if (this.colorPos >= colors.length * 64) {
            this.colorPos = 0;
        }
        const color = avsCycleColor(colors, this.colorPos);
        const { w, h } = frameSize(this.main);
        const fa = avsChannel(avsVisdata(this.main), !this.spectrum, this.channel);
        const s = int32(Number(this.opts.size) || 0) / 32.0;
        const size = Math.min(h * s, w * s);
        const cx = this.position === 2 ? Math.trunc(w / 2) : this.position === 0 ? Math.trunc(w / 4) : Math.trunc(w / 2) + Math.trunc(w / 4);
        const cy = Math.trunc(h / 2);
        const level = (q: number) => this.spectrum
            ? 0.1 + ((Math.trunc(fa[q * 2] / 2) + Math.trunc(fa[q * 2 + 1] / 2)) / 255.0) * 0.9
            : 0.1 + ((fa[q] ^ 128) / 255.0) * 0.9;
        const line = avsLineMode(this.main);
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        let a = 0.0;
        let sca = level(0);
        // int = int + double: the sum cut towards zero.
        let lx = Math.trunc(cx + Math.cos(a) * size * sca);
        let ly = Math.trunc(cy + Math.sin(a) * size * sca);
        for (let q = 1; q <= 80; q++) {
            a -= 3.14159 * 2.0 / 80.0;
            sca = level(q > 40 ? 80 - q : q);
            const tx = Math.trunc(cx + Math.cos(a) * size * sca);
            const ty = Math.trunc(cy + Math.sin(a) * size * sca);
            if ((tx >= 0 && tx < w && ty >= 0 && ty < h) || (lx >= 0 && lx < w && ly >= 0 && ly < h)) {
                avsLine(plotter, tx, ty, lx, ly, w, h, color, line.width);
            }
            lx = tx;
            ly = ty;
        }
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust);
    }
}

/**
 * Rotating Stars: two five-pointed stars circling the centre opposite each other,
 * each as big as the highest clear peak of spectrum values 3…13 (read as signed
 * bytes, as AVS did: loud values count as negative).
 */
export class RotatingStars extends Component {
    public static componentName: string = "RotatingStars";
    public static componentTag: string = "render";

    private colors: number[];
    private colorPos: number;
    private turn: number;

    public init() {
        this.colors = colorList(this.opts.colors, []);
        this.colorPos = 0;
        this.turn = 0.0;
    }

    public draw() {
        const colors = this.colors;
        if (!colors.length) {
            return;
        }
        this.colorPos++;
        if (this.colorPos >= colors.length * 64) {
            this.colorPos = 0;
        }
        const color = avsCycleColor(colors, this.colorPos);
        const { w, h } = frameSize(this.main);
        const { spectrum } = avsVisdata(this.main);
        // visdata[0][star][l] as C's signed char: loud values are negative there.
        const signed = (star, index) => (spectrum[star][index] >= 128 ? spectrum[star][index] - 256 : spectrum[star][index]);
        const line = avsLineMode(this.main);
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        const x = Math.trunc(Math.cos(this.turn) * w / 4.0);
        const y = Math.trunc(Math.sin(this.turn) * h / 4.0);
        const halfW = Math.trunc(w / 2);
        const halfH = Math.trunc(h / 2);
        for (let star = 0; star < 2; star++) {
            let r2 = -this.turn;
            let s = 0;
            let a = x;
            let b = y;
            for (let l = 3; l < 14; l++) {
                const v = signed(star, l);
                if (v > s && v > signed(star, l + 1) + 4 && v > signed(star, l - 1) + 4) {
                    s = v;
                }
            }
            if (star === 1) {
                a = -a;
                b = -b;
            }
            const vw = w / 8.0 * (s + 9) / 88.0;
            const vh = h / 8.0 * (s + 9) / 88.0;
            let lx = halfW + a + Math.trunc(Math.cos(r2) * vw);
            let ly = halfH + b + Math.trunc(Math.sin(r2) * vh);
            r2 += 3.14159 * 4.0 / 5.0;
            for (let t = 0; t < 5; t++) {
                const nx = Math.trunc(Math.cos(r2) * vw + halfW + a);
                const ny = Math.trunc(Math.sin(r2) * vh + halfH + b);
                r2 += 3.14159 * 4.0 / 5.0;
                avsLine(plotter, lx, ly, nx, ny, w, h, color, line.width);
                lx = nx;
                ly = ny;
            }
        }
        this.turn += 0.1;
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust);
    }
}

/**
 * Timescope: one column a frame, left to right, each pixel the colour scaled by
 * the spectrum value of its band (AVS's left channel whatever the setting said).
 */
export class Timescope extends Component {
    public static componentName: string = "Timescope";
    public static componentTag: string = "render";

    private column: number;

    public init() {
        this.column = 0;
    }

    public draw() {
        const opts = this.opts;
        const mode = String(opts.blendMode || "").toUpperCase();
        const { w, h, avsW, avsH } = frameSize(this.main);
        this.column++;
        this.column %= avsW;
        const { spectrum, wave } = avsVisdata(this.main);
        // visdata[0][0][(i · nbands) / h] & 0xFF whatever the channel; past 576 C read on into
        // the arrays after it: the right spectrum, then the waveforms.
        const bands = opts.bands === undefined ? 576 : int32(Number(opts.bands) || 0);
        const visdata = (index) => {
            if (index < 0 || index >= 2304) {
                return 0;
            }
            const part = Math.floor(index / 576);
            return part < 2 ? spectrum[part][index % 576] : wave[part - 2][index % 576] & 255;
        };
        const color = avsColor(opts.color);
        const r = color & 255;
        const g = (color >> 8) & 255;
        const b = (color >> 16) & 255;
        let blend = BLEND_REPLACE;
        let adjust = 0;
        if (mode === "DEFAULT") {
            const line = avsLineMode(this.main);
            blend = line.mode;
            adjust = line.adjust;
        } else if (mode === "ADDITIVE") {
            blend = BLEND_ADDITIVE;
        } else if (mode === "FIFTY_FIFTY") {
            blend = BLEND_AVERAGE;
        }
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        const left = Math.floor((this.column * w) / avsW);
        const right = Math.floor(((this.column + 1) * w) / avsW);
        for (let i = 0; i < avsH; i++) {
            const c = visdata(Math.trunc((i * bands) / avsH)) & 255;
            const value = Math.floor((r * c) / 256) + (Math.floor((g * c) / 256) << 8) + (Math.floor((b * c) / 256) << 16);
            const top = Math.floor((i * h) / avsH);
            const bottom = Math.floor(((i + 1) * h) / avsH);
            for (let row = top; row < bottom; row++) {
                for (let x = left; x < right; x++) {
                    plotter.plot(row * w + x, value);
                }
            }
        }
        plotter.flush(this.parent.getTSM(), blend, adjust);
    }
}

const F16 = (value: number) => value << 16;

/** r_bspin.cpp's my_triangle(): rows top to bottom, each span blended with BLEND_LINE. */
function bassTriangle(plotter, points: number[], width: number, height: number, color: number) {
    let swap;
    for (let k = 0; k < 2; k++) {
        if (points[1] > points[3]) {
            swap = points[2]; points[2] = points[0]; points[0] = swap;
            swap = points[3]; points[3] = points[1]; points[1] = swap;
        }
        if (points[3] > points[5]) {
            swap = points[4]; points[4] = points[2]; points[2] = swap;
            swap = points[5]; points[5] = points[3]; points[3] = swap;
        }
    }
    let x1 = F16(points[0]);
    let x2 = x1;
    let dx1 = points[1] < points[3] ? (F16(points[2] - points[0]) / (points[3] - points[1])) | 0 : 0;
    const dx2 = points[1] < points[5] ? (F16(points[4] - points[0]) / (points[5] - points[1])) | 0 : 0;
    let fb = points[1] * width;
    const ymax = Math.min(points[5], height);
    for (let y = points[1]; y < ymax; y++) {
        if (y === points[3]) {
            if (y === points[5]) {
                return;
            }
            x1 = F16(points[2]);
            dx1 = (F16(points[4] - points[2]) / (points[5] - points[3])) | 0;
        }
        if (y >= 0) {
            const x = (Math.min(x1, x2) - 32768) >> 16;
            let xl = ((Math.max(x1, x2) + 32768) >> 16) - x;
            if (xl < 0) {
                xl = -xl;
            }
            if (!xl) {
                xl++;
            }
            let t = fb + x;
            // As in AVS: left of the frame the span grows instead of shrinking, and a
            // span past the right edge runs on into the next row.
            if (x < 0) {
                t -= x;
                xl -= x;
            }
            if (x + xl >= width) {
                xl = width - x;
            }
            while (xl-- > 0) {
                plotter.plot(t++, color);
            }
        }
        fb += width;
        x1 = (x1 + dx1) | 0;
        x2 = (x2 + dx2) | 0;
    }
}

/**
 * Bass Spin: per channel a blade spinning about a point left or right of the
 * centre, faster and longer the louder the bass (spectrum 0…43 against the
 * previous frame's — one value shared by both channels, as in AVS); drawn as
 * lines from the last position or as filled triangles.
 */
export class BassSpin extends Component {
    public static componentName: string = "BassSpin";
    public static componentTag: string = "render";

    private lastA: number;
    private lx: number[][];
    private ly: number[][];
    private rv: number[];
    private v: number[];
    private dir: number[];

    public init() {
        this.lastA = 0;
        this.lx = [[0, 0], [0, 0]];
        this.ly = [[0, 0], [0, 0]];
        this.rv = [3.14159, 0.0];
        this.v = [0, 0];
        this.dir = [-1.0, 1.0];
    }

    public draw() {
        const opts = this.opts;
        const enabled = (opts.enabledLeft ? 1 : 0) | (opts.enabledRight ? 2 : 0);
        const colors = [avsColor(opts.colorLeft), avsColor(opts.colorRight)];
        const mode = { LINES: 0, TRIANGLES: 1 }[String(opts.mode || "").toUpperCase()] ?? -1;
        const { w, h } = frameSize(this.main);
        const { spectrum } = avsVisdata(this.main);
        const line = avsLineMode(this.main);
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        const halfH = Math.trunc(h / 2);
        for (let y = 0; y < 2; y++) {
            if (!(enabled & (1 << y))) {
                continue;
            }
            const ss = Math.min(Math.trunc(h / 2), Math.trunc((w * 3) / 8));
            let s = ss;
            const cx = !y ? Math.trunc(w / 2) - Math.trunc(ss / 2) : Math.trunc(w / 2) + Math.trunc(ss / 2);
            const color = colors[y];
            let d = 0;
            // fa_data = visdata[0][y]: the left spinner reads the left spectrum.
            for (let x = 0; x < 44; x++) {
                d += spectrum[y][x];
            }
            let a = Math.trunc((d * 512) / (this.lastA + 30 * 256));
            this.lastA = d;
            if (a > 255) {
                a = 255;
            }
            this.v[y] = 0.7 * (Math.max(a - 104, 12) / 96.0) + 0.3 * this.v[y];
            this.rv[y] += 3.14159 / 6.0 * this.v[y] * this.dir[y];
            s *= a * 1.0 / 256.0;
            const yp = Math.trunc(Math.sin(this.rv[y]) * s);
            const xp = Math.trunc(Math.cos(this.rv[y]) * s);
            const lx = this.lx;
            const ly = this.ly;
            if (mode === 0) {
                if (lx[0][y] || ly[0][y]) {
                    avsLine(plotter, lx[0][y], ly[0][y], xp + cx, yp + halfH, w, h, color, line.width);
                }
                lx[0][y] = xp + cx;
                ly[0][y] = yp + halfH;
                avsLine(plotter, cx, halfH, cx + xp, halfH + yp, w, h, color, line.width);
                if (lx[1][y] || ly[1][y]) {
                    avsLine(plotter, lx[1][y], ly[1][y], cx - xp, halfH - yp, w, h, color, line.width);
                }
                lx[1][y] = cx - xp;
                ly[1][y] = halfH - yp;
                avsLine(plotter, cx, halfH, cx - xp, halfH - yp, w, h, color, line.width);
            } else if (mode === 1) {
                if (lx[0][y] || ly[0][y]) {
                    bassTriangle(plotter, [cx, halfH, lx[0][y], ly[0][y], xp + cx, yp + halfH], w, h, color);
                }
                lx[0][y] = xp + cx;
                ly[0][y] = yp + halfH;
                if (lx[1][y] || ly[1][y]) {
                    bassTriangle(plotter, [cx, halfH, lx[1][y], ly[1][y], cx - xp, halfH - yp], w, h, color);
                }
                lx[1][y] = cx - xp;
                ly[1][y] = halfH - yp;
            }
        }
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust);
    }
}

/** Dot Fountain's rings: 256 of 30 points, each r, dr, h, dh, ax, ay (float) and c (int). */
const ROT_DIV = 30;
const ROT_HEIGHT = 256;
const POINT = 7;

/**
 * Dot Fountain: every frame a ring of 30 dots shoots up from the waveform (higher
 * on a beat), the rings already there rise, slow, fall and widen; the fountain
 * turns by rotationSpeed / 5 degrees a frame and is tilted by `angle`. A dot keeps
 * the colour of its launch speed, in 64 steps between five colours (AVS read below
 * that table for the slowest ones: the ends of the oldest ring, taken here from the
 * same place).
 */
export class DotFountain extends Component {
    public static componentName: string = "DotFountain";
    public static componentTag: string = "render";

    private floats: Float32Array;
    private ints: Int32Array;
    private colorTab: Int32Array;
    private rotation: number;

    public init() {
        const buffer = new ArrayBuffer(ROT_HEIGHT * ROT_DIV * POINT * 4);
        this.floats = new Float32Array(buffer);
        this.ints = new Int32Array(buffer);
        const opts = this.opts;
        const colors = [opts.colorTop, opts.colorHigh, opts.colorMid, opts.colorLow, opts.colorBottom].map(avsColor);
        // initcolortab(): 16 steps from each colour to the next, in 16.16 fixed point.
        this.colorTab = new Int32Array(64);
        for (let t = 0; t < 4; t++) {
            let r = (colors[t] & 255) << 16;
            let g = ((colors[t] >> 8) & 255) << 16;
            let b = ((colors[t] >> 16) & 255) << 16;
            const dr = Math.trunc((((colors[t + 1] & 255) - (colors[t] & 255)) << 16) / 16);
            const dg = Math.trunc(((((colors[t + 1] >> 8) & 255) - ((colors[t] >> 8) & 255)) << 16) / 16);
            const db = Math.trunc(((((colors[t + 1] >> 16) & 255) - ((colors[t] >> 16) & 255)) << 16) / 16);
            for (let x = 0; x < 16; x++) {
                this.colorTab[t * 16 + x] = (r >> 16) | ((g >> 16) << 8) | ((b >> 16) << 16);
                r += dr;
                g += dg;
                b += db;
            }
        }
        // The rotation the preset was saved at (r · 32).
        this.rotation = f(int32(Number(opts.rotation) || 0) / f(32));
    }

    public draw() {
        const opts = this.opts;
        const floats = this.floats;
        const ints = this.ints;
        const matrix = new Float32Array(16);
        const matrix2 = new Float32Array(16);
        matrixRotate(matrix, 2, this.rotation);
        matrixRotate(matrix2, 1, int32(Number(opts.angle) || 0));
        matrixMultiply(matrix, matrix2);
        matrixTranslate(matrix2, 0, -20, 400);
        matrixMultiply(matrix, matrix2);

        // Every ring moves one place on, changed as it goes.
        const first = floats.slice(0, ROT_DIV * POINT);
        for (let fo = ROT_HEIGHT - 2; fo >= 0; fo--) {
            const booga = f(f(1.3) / (fo + 100));
            const from = fo * ROT_DIV * POINT;
            const to = from + ROT_DIV * POINT;
            for (let p = 0; p < ROT_DIV; p++) {
                const i = from + p * POINT;
                const o = to + p * POINT;
                floats[o + 1] = floats[i + 1];
                floats[o + 4] = floats[i + 4];
                floats[o + 5] = floats[i + 5];
                ints[o + 6] = ints[i + 6];
                floats[o] = f(floats[i] + floats[i + 1]);
                floats[o + 3] = f(floats[i + 3] + f(0.05));
                floats[o + 1] = f(floats[o + 1] + booga);
                floats[o + 2] = f(floats[i + 2] + floats[o + 3]);
            }
        }

        // A new ring from the waveform (visdata[1][0]).
        const { wave } = avsVisdata(this.main);
        const beat = this.main.getAnalyser().isBeat();
        const end = ROT_HEIGHT * ROT_DIV * POINT;
        for (let p = 0; p < ROT_DIV; p++) {
            const o = p * POINT;
            let t = ((wave[0][p] & 255) ^ 128) * 5;
            t = Math.trunc(t / 4);
            t -= 64;
            if (beat) {
                t += 128;
            }
            if (t > 255) {
                t = 255;
            }
            floats[o] = 1;
            let dr = f(t / f(200));
            if (dr < 0) {
                dr = -dr;
            }
            floats[o + 2] = 250;
            dr = f(dr + 1.0);
            // (out->dh − in->dh) is the old dh minus its own copy: 0.
            floats[o + 3] = f(f(f(-dr * f(f(100) + f(floats[o + 3] - first[o + 3]))) / f(100)) * f(2.8));
            t = Math.trunc(t / 4);
            if (t > 63) {
                t = 63;
            }
            // color_tab[t]; below 0 AVS read the ints before the table, the end of points[].
            ints[o + 6] = t >= 0 ? this.colorTab[t] : ints[end + t];
            const a = f(f(f(p * f(3.14159)) * f(2)) / ROT_DIV);
            floats[o + 4] = f(Math.sin(a));
            floats[o + 5] = f(Math.cos(a));
            floats[o + 1] = 0;
        }

        const { w, h } = frameSize(this.main);
        let adj = f(f(w * f(440)) / f(640));
        const adj2 = f(f(h * f(440)) / f(480));
        if (adj2 < adj) {
            adj = adj2;
        }
        const line = avsLineMode(this.main);
        const dot = Math.max(1, Math.round(this.main.avsScale || 1));
        const plotter = avsPlotter(this.main);
        plotter.begin(w, h);
        const out = new Float32Array(3);
        const halfW = Math.trunc(w / 2);
        const halfH = Math.trunc(h / 2);
        for (let index = 0; index < ROT_HEIGHT * ROT_DIV; index++) {
            const i = index * POINT;
            const radius = floats[i];
            matrixApply(matrix, f(floats[i + 4] * radius), floats[i + 2], f(floats[i + 5] * radius), out);
            const z = f(adj / out[2]);
            if (z > 0.0000001) {
                const ix = Math.trunc(f(out[0] * z)) + halfW;
                const iy = Math.trunc(f(out[1] * z)) + halfH;
                if (iy >= 0 && iy < h && ix >= 0 && ix < w) {
                    plotDot(plotter, ix, iy, w, h, dot, ints[i + 6]);
                }
            }
        }
        plotter.flush(this.parent.getTSM(), line.mode, line.adjust);
        this.rotation = f(this.rotation + f(int32(Number(opts.rotationSpeed) || 0) / f(5)));
        if (this.rotation >= 360) {
            this.rotation = f(this.rotation - 360);
        }
        if (this.rotation < 0) {
            this.rotation = f(this.rotation + 360);
        }
    }
}
