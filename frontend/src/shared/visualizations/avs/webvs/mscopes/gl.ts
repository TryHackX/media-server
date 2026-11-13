// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * A small WebGL toolkit for the mscopes effects: programs, render targets, a
 * full-screen quad, and what the engine's context can store (half-float and float
 * textures, through the WebGL 1 extensions webvs's context has).
 *
 * mscopes ran its effects as Metal compute kernels over float textures, one thread
 * per pixel `g` (row 0 at the bottom of the screen, as WebGL's): here each kernel is
 * a fragment shader with `g = floor(gl_FragCoord.xy)` and the same arithmetic, in
 * GLSL ES 1.00 — the dialect of the WebGL 1 context webvs renders with (loops over a
 * constant bound with a `break`, no integer bit operations).
 */

export const QUAD_VERTEX = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

/** Fragment prelude: high precision where there is any (the hashes and noise need it). */
export const PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
`;

/** GLSL helpers the kernels share (mscopes' MSL functions, same formulas). */
export const GLSL_COMMON = `
float luma601(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// sh_hash / e_hash: sin(x*127.1 + y*311.7)*43758.5453, fractional part.
float shHash(float x, float y) {
    float s = sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - floor(s);
}
// sh_noise / e_noise: value noise with a smoothstep fade.
float shNoise(float x, float y) {
    float ix = floor(x), iy = floor(y), fx = x - ix, fy = y - iy;
    float ux = fx * fx * (3.0 - 2.0 * fx), uy = fy * fy * (3.0 - 2.0 * fy);
    float a = shHash(ix, iy), b = shHash(ix + 1.0, iy);
    float c = shHash(ix, iy + 1.0), d = shHash(ix + 1.0, iy + 1.0);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
// sim_hsv: v * mix(1, hue ramp, s).
vec3 simHsv(float h, float s, float v) {
    vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), k, s);
}
`;

export interface Caps {
    /** HALF_FLOAT_OES when half-float textures can be rendered to and filtered, else 0. */
    half: number;
    /** FLOAT when float textures can be rendered to, else 0. */
    float: number;
    floatLinear: boolean;
    vertexTextures: boolean;
    instancing: any;
}

const capsCache = new WeakMap<WebGLRenderingContext, Caps>();

function renderable(gl: WebGLRenderingContext, type: number): boolean {
    const oldTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const oldFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, type, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.getError() === gl.NO_ERROR && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer);
    gl.deleteFramebuffer(framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, oldTexture);
    gl.deleteTexture(texture);
    return ok;
}

/** What this context can store and draw into (asked once, the extensions enabled then). */
export function glCaps(gl: WebGLRenderingContext): Caps {
    let caps = capsCache.get(gl);
    if (caps) {
        return caps;
    }
    // Errors left by others must not be taken for ours.
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    const half = gl.getExtension("OES_texture_half_float");
    const halfLinear = gl.getExtension("OES_texture_half_float_linear");
    gl.getExtension("EXT_color_buffer_half_float");
    const float = gl.getExtension("OES_texture_float");
    const floatLinear = gl.getExtension("OES_texture_float_linear");
    gl.getExtension("WEBGL_color_buffer_float");
    caps = {
        half: half && halfLinear && renderable(gl, half.HALF_FLOAT_OES) ? half.HALF_FLOAT_OES : 0,
        float: float && renderable(gl, gl.FLOAT) ? gl.FLOAT : 0,
        floatLinear: Boolean(floatLinear),
        vertexTextures: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0,
        instancing: gl.getExtension("ANGLE_instanced_arrays"),
    };
    capsCache.set(gl, caps);
    return caps;
}

/** The best texture type for light that needs headroom and fine steps: half float, else bytes. */
export function lightType(gl: WebGLRenderingContext): number {
    return glCaps(gl).half || gl.UNSIGNED_BYTE;
}

/**
 * The texture type of a list's frame: half floats when the preset asks for them
 * (`"floatFrame": true` on the preset itself — the mscopes presets: their effects were
 * made for a float picture) and the GPU can, for its nested lists too; undefined
 * (bytes, as always) otherwise. Lists are built before their parents' textures, so the
 * preset is found up the chain of parents.
 */
export function frameTextureType(main, opts, parent): number | undefined {
    let root = parent;
    while (root && root.parent) {
        root = root.parent;
    }
    const wanted = root ? root.get("floatFrame") : opts && opts.floatFrame;
    if (!wanted) {
        return undefined;
    }
    const gl = main.getRctx().getGl();
    return glCaps(gl).half || undefined;
}

export class Program {
    public readonly program: WebGLProgram;
    private readonly gl: WebGLRenderingContext;
    private readonly locations: { [name: string]: WebGLUniformLocation | null } = {};
    private readonly attributes: { [name: string]: number } = {};
    private units: number;

    constructor(gl: WebGLRenderingContext, fragment: string, vertex: string = QUAD_VERTEX) {
        this.gl = gl;
        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error("mscopes shader: " + log);
            }
            return shader;
        };
        const vs = compile(gl.VERTEX_SHADER, vertex);
        const fs = compile(gl.FRAGMENT_SHADER, fragment);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error("mscopes program: " + log);
        }
        this.program = program;
        this.units = 0;
    }

    public use(): Program {
        this.gl.useProgram(this.program);
        this.units = 0;
        return this;
    }

    public location(name: string): WebGLUniformLocation | null {
        if (!(name in this.locations)) {
            this.locations[name] = this.gl.getUniformLocation(this.program, name);
        }
        return this.locations[name];
    }

    public attribute(name: string): number {
        if (!(name in this.attributes)) {
            this.attributes[name] = this.gl.getAttribLocation(this.program, name);
        }
        return this.attributes[name];
    }

    public f(name: string, ...values: number[]): Program {
        const location = this.location(name);
        if (location) {
            const gl = this.gl;
            switch (values.length) {
                case 1: gl.uniform1f(location, values[0]); break;
                case 2: gl.uniform2f(location, values[0], values[1]); break;
                case 3: gl.uniform3f(location, values[0], values[1], values[2]); break;
                default: gl.uniform4f(location, values[0], values[1], values[2], values[3]); break;
            }
        }
        return this;
    }

    public fv(name: string, values: Float32Array | number[]): Program {
        const location = this.location(name);
        if (location) {
            this.gl.uniform1fv(location, values instanceof Float32Array ? values : new Float32Array(values));
        }
        return this;
    }

    public fv4(name: string, values: Float32Array | number[]): Program {
        const location = this.location(name);
        if (location) {
            this.gl.uniform4fv(location, values instanceof Float32Array ? values : new Float32Array(values));
        }
        return this;
    }

    /** Binds a texture to the next unit; `linear` samples it bilinearly for this draw. */
    public texture(name: string, texture: WebGLTexture, linear: boolean = false): Program {
        const gl = this.gl;
        const unit = this.units++;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const filter = linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        const location = this.location(name);
        if (location) {
            gl.uniform1i(location, unit);
        }
        return this;
    }

    public destroy(): void {
        const gl = this.gl;
        // webvs's programs put back the one that was in use before them: never a deleted one.
        if (gl.getParameter(gl.CURRENT_PROGRAM) === this.program) {
            gl.useProgram(null);
        }
        gl.deleteProgram(this.program);
    }
}

const quads = new WeakMap<WebGLRenderingContext, WebGLBuffer>();

/** Draws the full-screen quad with `program` (already in use). */
export function drawQuad(gl: WebGLRenderingContext, program: Program): void {
    let buffer = quads.get(gl);
    if (!buffer) {
        buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        quads.set(gl, buffer);
    }
    const location = program.attribute("a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(location);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(location);
}

/** Textures webvs keeps are sampled nearest; put a texture back that way after a linear read. */
export function nearest(gl: WebGLRenderingContext, texture: WebGLTexture): void {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}

/** A texture with its own framebuffer. */
export class Target {
    public texture: WebGLTexture;
    public framebuffer: WebGLFramebuffer;
    public width: number;
    public height: number;
    public readonly type: number;
    private readonly gl: WebGLRenderingContext;

    constructor(gl: WebGLRenderingContext, width: number, height: number, type: number) {
        this.gl = gl;
        this.type = type;
        this.width = 0;
        this.height = 0;
        this.texture = gl.createTexture();
        this.framebuffer = gl.createFramebuffer();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.resize(width, height);
    }

    /** New size (contents cleared to transparent black); nothing happens at the same size. */
    public resize(width: number, height: number): boolean {
        width = Math.max(1, Math.round(width));
        height = Math.max(1, Math.round(height));
        if (width === this.width && height === this.height) {
            return false;
        }
        const gl = this.gl;
        const oldFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, this.type, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer);
        this.width = width;
        this.height = height;
        return true;
    }

    public destroy(): void {
        this.gl.deleteTexture(this.texture);
        this.gl.deleteFramebuffer(this.framebuffer);
    }
}

/**
 * Draws into `target` (its framebuffer and viewport) and puts the framebuffer and
 * viewport webvs had back afterwards.
 */
export function into(gl: WebGLRenderingContext, target: Target, draw: () => void): void {
    const oldFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    try {
        draw();
    } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
}

/** Clears a target to a colour. */
export function clearTarget(gl: WebGLRenderingContext, target: Target, r = 0, g = 0, b = 0, a = 1): void {
    into(gl, target, () => {
        gl.disable(gl.BLEND);
        gl.clearColor(r, g, b, a);
        gl.clear(gl.COLOR_BUFFER_BIT);
    });
}

/** A 256×1 (or n×1) data texture, nearest, bytes or floats. */
export class DataTexture {
    public texture: WebGLTexture;
    private readonly gl: WebGLRenderingContext;
    private width: number;
    private height: number;
    private readonly type: number;

    constructor(gl: WebGLRenderingContext, width: number, height: number, type: number) {
        this.gl = gl;
        this.width = width;
        this.height = height;
        this.type = type;
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null);
    }

    public update(data: ArrayBufferView, width: number = this.width, height: number = this.height): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        if (width !== this.width || height !== this.height) {
            this.width = width;
            this.height = height;
        }
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, this.type, data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }

    public destroy(): void {
        this.gl.deleteTexture(this.texture);
    }
}
