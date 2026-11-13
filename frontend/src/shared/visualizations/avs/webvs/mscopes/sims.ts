// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * mscopes' GPU simulations (core/effects/SimEffects.cpp, kernels sim_* in
 * core/gpu/metal/GpuFx.mm), in WebGL 1 with float textures:
 *
 * - Flow Particles: tens of thousands of particles riding the curl of animated
 *   gradient noise, drawn as motion-blurred streaks into a half-float light texture
 *   and added to the frame clamped at white. Their state (position, velocity, the
 *   previous position, life, age) lives in two float textures updated by fragment
 *   passes; the streaks read it in the vertex shader. The noise's gradients come from
 *   mscopes' integer hash, worked out on the processor for the lattice points the
 *   particles can reach (GLSL ES 1.00 has no integer arithmetic); the random respawns
 *   use a float hash instead of mscopes' — the same distribution, not the same draws.
 * - Fluid: stable fluids on a grid a quarter of the frame — splats from emitters that
 *   orbit the centre (or wander) and from hits, vorticity confinement, a Jacobi
 *   pressure solve, semi-Lagrangian advection — the dye added to (or replacing) the frame.
 * - Reaction Diffusion: Gray-Scott on a torus at half the frame, seeded at the start and
 *   on hits, the recipe leaned by the music, shaded by its slope and mixed over the frame.
 *
 * mscopes' CPU fallbacks (for Macs without Metal) are not ported: without float
 * textures these effects draw nothing.
 */
import { MscopesAudioFrame } from "./audio";
import MscopesEffect from "./base";
import { clearTarget, drawQuad, glCaps, GLSL_COMMON, into, lightType, PRELUDE, Program, Target } from "./gl";
import { xorshift } from "./draw";

// ---- the processor's side: mscopes' hash, gradient noise and colours -------------

/** sim_hashu / hashu. */
export function hashu(value: number): number {
    let x = value >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
}

/** sim_grad / grad: a unit gradient at a lattice point. */
export function gradient(x: number, y: number, z: number, out: Float32Array | number[], offset = 0): void {
    const h = hashu(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791));
    const a = (h & 0xffff) * (6.2831853 / 65536);
    const zz = (h >>> 16) * (2 / 65536) - 1;
    const r = Math.sqrt(Math.max(0, 1 - zz * zz));
    out[offset] = r * Math.cos(a);
    out[offset + 1] = r * Math.sin(a);
    out[offset + 2] = zz;
}

const fade5 = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** simNoise: gradient noise, about −1…1 (SimEffects.cpp). */
export function simNoise(x: number, y: number, z: number): number {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const tx = x - fx, ty = y - fy, tz = z - fz;
    const g = [0, 0, 0];
    const n = new Array(8);
    for (let c = 0; c < 8; c++) {
        const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
        gradient(fx + dx, fy + dy, fz + dz, g);
        n[c] = g[0] * (tx - dx) + g[1] * (ty - dy) + g[2] * (tz - dz);
    }
    const u = fade5(tx), v = fade5(ty), w = fade5(tz);
    const lerp = (a, b, t) => a + (b - a) * t;
    return lerp(lerp(lerp(n[0], n[1], u), lerp(n[2], n[3], u), v), lerp(lerp(n[4], n[5], u), lerp(n[6], n[7], u), v), w);
}

/** sim_hsv on the processor: v · mix(1, hue ramp, s). */
export function simHsv(h: number, s: number, v: number): [number, number, number] {
    h -= Math.floor(h);
    const offsets = [0, 2 / 3, 1 / 3];
    return offsets.map((offset) => {
        let x = h + offset;
        x -= Math.floor(x);
        const k = Math.min(1, Math.max(0, Math.abs(x * 6 - 3) - 1));
        return v * (1 + (k - 1) * s);
    }) as [number, number, number];
}

/** The frame's lows / mids / highs and loudness (audioLevels). */
function audioLevels(audio: MscopesAudioFrame): { band: number[]; level: number } {
    if (audio.hasFeatures) {
        return { band: [audio.bassAtt, audio.midAtt, audio.trebleAtt], level: audio.level };
    }
    const band = [Math.min(1, audio.bass * 1.5), Math.min(1, audio.mid * 2), Math.min(1, audio.treble * 3)];
    return { band, level: (band[0] + band[1] + band[2]) / 3 };
}

/** A float target for simulation state: float32 when it can be drawn into, else half float. */
function stateType(gl: WebGLRenderingContext): number {
    const caps = glCaps(gl);
    return caps.float || caps.half;
}

// ---- shared GLSL -------------------------------------------------------------------

// A float hash for the random draws (mscopes used its integer hash): 0…1.
const HASH = `
float hash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}
float simRand(float id, float k) {
    return hash3(vec3(mod(id, 251.0), floor(id / 251.0) + 0.5, mod(k, 4093.0) + 0.25));
}`;

const ADD = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_light;
uniform vec2 u_size;
uniform vec2 u_p;
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec3 c = texture2D(u_src, uv).rgb;
    vec3 l = max(texture2D(u_light, uv).rgb, 0.0) * u_p.x;
    vec3 x = u_p.y > 0.5 ? l : c + l;
    gl_FragColor = vec4(min(x, 1.0), 1.0);
}`;

/** sim_add: frame + light (or the light alone), clamped at white. */
function composite(effect, light: WebGLTexture, gain: number, mode: number, linear: boolean): void {
    effect.pass(effect.program("add", ADD), (p) => p.texture("u_light", light, linear).f("u_p", gain, mode), false);
}

// ---- Flow Particles ------------------------------------------------------------------

const STEP = `${PRELUDE}
uniform sampler2D u_a;      // pos.xy, vel.xy
uniform sampler2D u_b;      // prev.xy, life, age
uniform sampler2D u_grad;   // gradients of the lattice the particles can reach
uniform vec4 u_lattice;     // first x, first y, first z, columns
uniform vec2 u_latticeSize; // texture size
uniform float u_rows;       // lattice rows per z slice
uniform vec2 u_size;        // state texture size
uniform float u_count;
uniform vec4 u_p0;          // aspect, dt, time, speed
uniform vec4 u_p1;          // scale, follow, drag, push
uniform vec4 u_p2;          // burst, turbulence, lifetime, seed
uniform vec2 u_p3;          // frame, reset
uniform float u_out;        // 0: write pos/vel, 1: write prev/life/age
${HASH}
vec3 grad(vec3 i) {
    vec3 at = i - u_lattice.xyz;
    vec2 texel = vec2(at.x, at.y + at.z * u_rows);
    return texture2D(u_grad, (texel + 0.5) / u_latticeSize).xyz;
}
float noise(vec3 p) {
    vec3 i = floor(p), f = p - i;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(grad(i), f);
    float n100 = dot(grad(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
    float n010 = dot(grad(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
    float n110 = dot(grad(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
    float n001 = dot(grad(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
    float n101 = dot(grad(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
    float n011 = dot(grad(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
    float n111 = dot(grad(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main() {
    vec2 cell = floor(gl_FragCoord.xy);
    float id = cell.y * u_size.x + cell.x;
    vec2 uv = gl_FragCoord.xy / u_size;
    vec4 a = texture2D(u_a, uv);
    vec4 b = texture2D(u_b, uv);
    vec2 pos = a.xy, vel = a.zw, prev = b.xy;
    float life = b.z, age = b.w;
    float aspect = u_p0.x, dt = u_p0.y;
    float s = floor(u_p2.w * 977.0);
    float frame = u_p3.x;
    bool respawn = false;
    if (u_p3.y > 0.5) {
        respawn = true;
    } else {
        prev = pos;
        life -= dt;
        age += dt;
        if (life <= 0.0 || abs(pos.x) > aspect * 1.15 || abs(pos.y) > 1.15) {
            respawn = true;
        } else {
            vec3 q = vec3(pos * u_p1.x, u_p0.z * 0.15);
            float e = 0.02;
            float dy = noise(q + vec3(0.0, e, 0.0)) - noise(q - vec3(0.0, e, 0.0));
            float dx = noise(q + vec3(e, 0.0, 0.0)) - noise(q - vec3(e, 0.0, 0.0));
            vec2 flow = vec2(dy, -dx) * (0.5 / e) * u_p0.w;
            float r = length(pos) + 1e-3;
            vec2 radial = pos / r;
            vec2 jit = vec2(simRand(id, frame * 5.0 + 11.0), simRand(id, frame * 5.0 + 12.0)) * 2.0 - 1.0;
            vel += ((flow - vel) * u_p1.y + radial * u_p1.w) * dt
                 + radial * (u_p2.x / (0.35 + r))
                 + jit * (u_p2.y * sqrt(dt));
            vel *= exp(-u_p1.z * dt);
            pos += vel * dt;
        }
    }
    if (respawn) {
        pos = vec2((simRand(id, frame * 3.0 + 1.0 + s) * 2.0 - 1.0) * aspect, simRand(id, frame * 3.0 + 2.0 + s) * 2.0 - 1.0);
        prev = pos;
        vel = vec2(0.0);
        life = u_p2.z * (0.5 + simRand(id, frame * 3.0 + 3.0 + s));
        age = 0.0;
        if (u_p3.y > 0.5) {
            // Scattered, with lives spread out.
            life *= simRand(id, 99.0);
            age = 1.0;
        }
    }
    gl_FragColor = u_out < 0.5 ? vec4(pos, vel) : vec4(prev, life, age);
}`;

const STREAK_VERTEX = `
attribute vec3 a_particle;   // state texel (x, y), corner 0…5
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec2 u_state;
uniform vec2 u_frame;        // W, H
uniform float u_width;
uniform float u_light;
uniform vec3 u_hue;          // hue, spread, -
varying vec3 v_col;
varying float v_across;
${HASH}
vec3 simHsvV(float h, float s, float v) {
    vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), k, s);
}
void main() {
    vec2 uv = (a_particle.xy + 0.5) / u_state;
    vec4 a = texture2D(u_a, uv);
    vec4 b = texture2D(u_b, uv);
    vec2 halfSz = u_frame * 0.5;
    vec2 A = b.xy * halfSz.y + halfSz;
    vec2 B = a.xy * halfSz.y + halfSz;
    vec2 d = B - A;
    float len = length(d);
    vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float hw = max(0.5, u_width * 0.5) + 0.75;
    float corner = a_particle.z;
    vec2 cs = corner < 0.5 ? vec2(0.0, -1.0) : corner < 1.5 ? vec2(1.0, -1.0) : corner < 2.5 ? vec2(1.0, 1.0)
            : corner < 3.5 ? vec2(0.0, -1.0) : corner < 4.5 ? vec2(1.0, 1.0) : vec2(0.0, 1.0);
    vec2 P = mix(A, B, cs.x) + dir * (cs.x * 2.0 - 1.0) * hw + nrm * cs.y * hw;
    gl_Position = vec4(P / u_frame * 2.0 - 1.0, 0.0, 1.0);
    v_across = cs.y * hw / max(0.5, u_width * 0.5 + 0.25);
    // A particle's light is the same however far it moved: a streak spreads it.
    float fadeIn = smoothstep(0.0, 0.4, b.w) * smoothstep(0.0, 0.6, b.z);
    float e = u_light * fadeIn / max(len, 1.0);
    float id = a_particle.y * u_state.x + a_particle.x;
    float tone = simRand(id, 7.0) - 0.5;
    float speed = length(a.zw);
    v_col = simHsvV(u_hue.x + tone * u_hue.y + speed * 0.08, 0.8 - min(speed, 1.0) * 0.2, 1.0) * e;
}`;

const STREAK_FRAGMENT = `${PRELUDE}
varying vec3 v_col;
varying float v_across;
void main() {
    float a = clamp(1.25 - abs(v_across), 0.0, 1.0);
    gl_FragColor = vec4(v_col * a, 1.0);
}`;

/**
 * Flow Particles (SimEffects.h): count, speed, scale (swirls per frame height),
 * follow, drag, bass push, burst on hits, treble turbulence, lifetime, width,
 * brightness, hue, hue spread, hue speed.
 */
export class MscopesFlowParticles extends MscopesEffect {
    public static componentName = "MscopesFlowParticles";
    public static componentTag = "render";
    private time: number;
    private started: boolean;
    private frameIndex: number;
    private stateSize: number;
    private count: number;
    private states: Target[];
    private current: number;
    private particleBuffer: WebGLBuffer;
    private gradTexture: WebGLTexture;
    private gradData: Float32Array;

    protected setup() {
        this.time = 0;
        this.started = false;
        this.frameIndex = 0;
        this.stateSize = 0;
        this.count = 0;
        this.states = [];
        this.current = 0;
        this.particleBuffer = null;
        this.gradTexture = null;
        this.gradData = null;
    }

    protected teardown() {
        for (const state of this.states) {
            state.destroy();
        }
        this.states = [];
        if (this.particleBuffer) {
            this.gl.deleteBuffer(this.particleBuffer);
        }
        if (this.gradTexture) {
            this.gl.deleteTexture(this.gradTexture);
        }
    }

    private allocate(count: number): boolean {
        const gl = this.gl;
        const type = stateType(gl);
        if (!type || !glCaps(gl).vertexTextures) {
            return false;
        }
        const size = Math.ceil(Math.sqrt(count));
        if (size !== this.stateSize || !this.states.length) {
            for (const state of this.states) {
                state.destroy();
            }
            // [a0, b0, a1, b1]: a = pos, vel; b = prev, life, age.
            this.states = [0, 1, 2, 3].map(() => new Target(gl, size, size, type));
            this.stateSize = size;
            this.current = 0;
        }
        if (count !== this.count) {
            const data = new Float32Array(count * 6 * 3);
            let o = 0;
            for (let id = 0; id < count; id++) {
                const x = id % size, y = Math.floor(id / size);
                for (let corner = 0; corner < 6; corner++) {
                    data[o++] = x;
                    data[o++] = y;
                    data[o++] = corner;
                }
            }
            if (!this.particleBuffer) {
                this.particleBuffer = gl.createBuffer();
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
            this.count = count;
        }
        return true;
    }

    /** The gradients of every lattice point the noise can be asked for this frame. */
    private lattice(scale: number, aspect: number, zTime: number) {
        const gl = this.gl;
        const reachX = Math.ceil(scale * aspect * 1.2 + 0.05) + 1;
        const reachY = Math.ceil(scale * 1.2 + 0.05) + 1;
        const x0 = -reachX - 1, y0 = -reachY - 1, z0 = Math.floor(zTime);
        const columns = reachX * 2 + 3, rows = reachY * 2 + 3;
        const data = this.gradData && this.gradData.length === columns * rows * 2 * 4
            ? this.gradData : new Float32Array(columns * rows * 2 * 4);
        let o = 0;
        for (let z = 0; z < 2; z++) {
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < columns; x++) {
                    gradient(x0 + x, y0 + y, z0 + z, data, o);
                    data[o + 3] = 0;
                    o += 4;
                }
            }
        }
        this.gradData = data;
        if (!this.gradTexture) {
            this.gradTexture = gl.createTexture();
        }
        gl.bindTexture(gl.TEXTURE_2D, this.gradTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, columns, rows * 2, 0, gl.RGBA, gl.FLOAT, data);
        return { x0, y0, z0, columns, rows };
    }

    protected render(audio: MscopesAudioFrame) {
        const gl = this.gl;
        if (!glCaps(gl).float && !glCaps(gl).half) {
            return;
        }
        const W = this.width(), H = this.height();
        const dt = Math.min(0.1, Math.max(0, this.host.dt));
        const { band, level } = audioLevels(audio);
        this.time += dt * (0.5 + 1.0 * level);
        const count = Math.min(1000000, Math.max(1000, Math.trunc(this.param("count", 150000, 10000, 400000))));
        let reset = !this.started;
        const before = this.count;
        if (!this.allocate(count)) {
            return;
        }
        if (before !== this.count) {
            reset = true;
        }
        this.started = true;
        const aspect = W / H;
        const scale = this.param("scale", 1.6, 0.3, 6);
        const speed = this.param("speed", 0.45, 0.05, 2) * (0.6 + 0.8 * level);
        const push = this.param("bassPush", 0.8, 0, 3) * band[0] * band[0] * 2;
        const burst = this.onBeat(audio) ? this.param("burst", 0.9, 0, 3) : 0;
        const turbulence = this.param("turbulence", 0.3, 0, 2) * band[2];
        const lifetime = Math.max(0.2, this.param("lifetime", 4, 0.5, 10));
        const width = this.param("width", 1, 0.5, 4) * Math.max(1, this.widthScale());
        const brightness = this.param("brightness", 1, 0, 4);
        const hue = this.param("hue", 0.55, 0, 1) + this.param("hueSpeed", 0, 0, 0.5) * this.host.time;
        const hueSpread = this.param("hueSpread", 0.2, 0, 1);
        const frame = this.frameIndex++;
        const lattice = this.lattice(scale, aspect, this.time * 0.15);

        // The step: new a from old a and b, then new b from the same.
        const [a0, b0, a1, b1] = this.current === 0 ? this.states : [this.states[2], this.states[3], this.states[0], this.states[1]];
        const step = this.program("step", STEP);
        const size = this.stateSize;
        for (const [target, out] of [[a1, 0], [b1, 1]] as [Target, number][]) {
            this.run(target, step, (p) => p.texture("u_a", a0.texture).texture("u_b", b0.texture).texture("u_grad", this.gradTexture)
                .f("u_lattice", lattice.x0, lattice.y0, lattice.z0, lattice.columns)
                .f("u_latticeSize", lattice.columns, lattice.rows * 2).f("u_rows", lattice.rows)
                .f("u_count", count).f("u_p0", aspect, dt, this.time, speed)
                .f("u_p1", scale, this.param("follow", 3, 0.2, 10), this.param("drag", 0.6, 0, 4), push)
                .f("u_p2", burst, turbulence, lifetime, 0).f("u_p3", frame % 4093, reset ? 1 : 0).f("u_out", out));
        }
        this.current ^= 1;

        // The streaks, additive, into a half-float light texture.
        const light = this.scratch("light", undefined, undefined, lightType(gl));
        clearTarget(gl, light, 0, 0, 0, 0);
        const draw = this.program("streak", STREAK_FRAGMENT, STREAK_VERTEX);
        into(gl, light, () => {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.blendEquation(gl.FUNC_ADD);
            draw.use().texture("u_a", a1.texture).texture("u_b", b1.texture)
                .f("u_state", size, size).f("u_frame", W, H).f("u_width", width)
                .f("u_light", (0.08 * brightness * W * H) / (count * Math.max(width, 1)))
                .f("u_hue", hue, hueSpread, 0);
            const location = draw.attribute("a_particle");
            gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
            gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(location);
            gl.drawArrays(gl.TRIANGLES, 0, count * 6);
            gl.disableVertexAttribArray(location);
            gl.disable(gl.BLEND);
        });
        composite(this, light.texture, 1, 0, true);
    }

    private widthScale(): number {
        const canvas = this.gl.canvas as HTMLCanvasElement;
        const shown = canvas && canvas.clientWidth;
        return shown > 0 ? Math.max(1, this.gl.drawingBufferWidth / shown) : 1;
    }
}

// ---- Fluid -----------------------------------------------------------------------------

const MAX_SPLATS = 16;

const SPLAT = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec4 u_a[${MAX_SPLATS}];   // x, y, vx, vy
uniform vec4 u_b[${MAX_SPLATS}];   // r, g, b, radius
uniform vec2 u_info;               // count, 0 velocity / 1 dye
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    float aspect = u_size.x / u_size.y;
    vec4 c = texture2D(u_src, uv);
    for (int i = 0; i < ${MAX_SPLATS}; i++) {
        if (float(i) >= u_info.x) break;
        vec2 d = (uv - u_a[i].xy) * vec2(aspect, 1.0);
        float w = exp(-dot(d, d) / max(u_b[i].w * u_b[i].w, 1e-6));
        if (u_info.y > 0.5) c.rgb += u_b[i].rgb * w;
        else c.xy += u_a[i].zw * u_size.y * w;
    }
    gl_FragColor = c;
}`;

// Reads at whole cells, edges clamped (the kernels' sim_clampi).
const CELL = `
vec4 cell(sampler2D t, vec2 i) {
    i = clamp(i, vec2(0.0), u_size - 1.0);
    return texture2D(t, (i + 0.5) / u_size);
}`;

const CURL = `${PRELUDE}
uniform sampler2D u_vel;
uniform vec2 u_size;
${CELL}
void main() {
    vec2 i = floor(gl_FragCoord.xy);
    float L = cell(u_vel, i - vec2(1.0, 0.0)).y;
    float R = cell(u_vel, i + vec2(1.0, 0.0)).y;
    float T = cell(u_vel, i - vec2(0.0, 1.0)).x;
    float B = cell(u_vel, i + vec2(0.0, 1.0)).x;
    gl_FragColor = vec4(0.5 * ((R - L) - (B - T)), 0.0, 0.0, 0.0);
}`;

const VORT = `${PRELUDE}
uniform sampler2D u_vel;
uniform sampler2D u_curl;
uniform vec2 u_size;
uniform vec2 u_p;   // dt, vorticity
${CELL}
void main() {
    vec2 i = floor(gl_FragCoord.xy);
    float L = abs(cell(u_curl, i - vec2(1.0, 0.0)).x);
    float R = abs(cell(u_curl, i + vec2(1.0, 0.0)).x);
    float T = abs(cell(u_curl, i - vec2(0.0, 1.0)).x);
    float B = abs(cell(u_curl, i + vec2(0.0, 1.0)).x);
    float C = cell(u_curl, i).x;
    vec2 f = 0.5 * vec2(B - T, R - L);
    f /= length(f) + 1e-5;
    f *= u_p.y * C * vec2(1.0, -1.0);
    vec4 v = cell(u_vel, i);
    gl_FragColor = vec4(v.xy + f * u_p.x, 0.0, 0.0);
}`;

const DIV = `${PRELUDE}
uniform sampler2D u_vel;
uniform vec2 u_size;
${CELL}
void main() {
    vec2 i = floor(gl_FragCoord.xy);
    vec2 C = cell(u_vel, i).xy;
    // Walls: the velocity across a wall is the mirror of the cell's own.
    float L = i.x > 0.5 ? cell(u_vel, i - vec2(1.0, 0.0)).x : -C.x;
    float R = i.x < u_size.x - 1.5 ? cell(u_vel, i + vec2(1.0, 0.0)).x : -C.x;
    float T = i.y > 0.5 ? cell(u_vel, i - vec2(0.0, 1.0)).y : -C.y;
    float B = i.y < u_size.y - 1.5 ? cell(u_vel, i + vec2(0.0, 1.0)).y : -C.y;
    gl_FragColor = vec4(0.5 * ((R - L) + (B - T)), 0.0, 0.0, 0.0);
}`;

const JACOBI = `${PRELUDE}
uniform sampler2D u_pr;
uniform sampler2D u_div;
uniform vec2 u_size;
${CELL}
void main() {
    vec2 i = floor(gl_FragCoord.xy);
    float L = cell(u_pr, i - vec2(1.0, 0.0)).x;
    float R = cell(u_pr, i + vec2(1.0, 0.0)).x;
    float T = cell(u_pr, i - vec2(0.0, 1.0)).x;
    float B = cell(u_pr, i + vec2(0.0, 1.0)).x;
    gl_FragColor = vec4((L + R + T + B - cell(u_div, i).x) * 0.25, 0.0, 0.0, 0.0);
}`;

const GRAD = `${PRELUDE}
uniform sampler2D u_pr;
uniform sampler2D u_vel;
uniform vec2 u_size;
${CELL}
void main() {
    vec2 i = floor(gl_FragCoord.xy);
    float L = cell(u_pr, i - vec2(1.0, 0.0)).x;
    float R = cell(u_pr, i + vec2(1.0, 0.0)).x;
    float T = cell(u_pr, i - vec2(0.0, 1.0)).x;
    float B = cell(u_pr, i + vec2(0.0, 1.0)).x;
    vec2 v = cell(u_vel, i).xy - 0.5 * vec2(R - L, B - T);
    gl_FragColor = vec4(v, 0.0, 0.0);
}`;

const ADVECT = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_vel;
uniform vec2 u_size;
uniform vec2 u_p;   // dt, keep
void main() {
    vec2 pos = floor(gl_FragCoord.xy) + 0.5;
    vec2 v = texture2D(u_vel, clamp(pos / u_size, 0.5 / u_size, 1.0 - 0.5 / u_size)).xy;
    gl_FragColor = texture2D(u_src, clamp((pos - v * u_p.x) / u_size, 0.5 / u_size, 1.0 - 0.5 / u_size)) * u_p.y;
}`;

/**
 * Fluid (SimEffects.h): grid scale, velocity and dye kept per second, vorticity,
 * force, dye, gain, mode (0 add, 1 replace), emitters, splat radius, hue, hue
 * spread, hue speed, orbit, layout (0 orbit the centre, 1 wander the frame).
 */
export class MscopesFluid extends MscopesEffect {
    public static componentName = "MscopesFluid";
    public static componentTag = "render";
    private time: number;
    private hits: number;
    private grids;
    private gridSize: string;

    protected setup() {
        this.time = 0;
        this.hits = 0;
        this.grids = null;
        this.gridSize = "";
    }

    protected teardown() {
        this.freeGrids();
    }

    private freeGrids() {
        if (this.grids) {
            for (const key of Object.keys(this.grids)) {
                for (const target of [].concat(this.grids[key])) {
                    target.destroy();
                }
            }
        }
        this.grids = null;
        this.gridSize = "";
    }

    /** The splats for one frame (FluidEffect::splatsFor). */
    private splats(audio: MscopesAudioFrame, aspect: number): number[][] {
        const out = [];
        const dt = Math.min(0.1, Math.max(0, this.host.dt));
        const { band } = audioLevels(audio);
        const E = Math.min(6, Math.max(1, Math.round(this.param("emitters", 3, 1, 6))));
        const hueSpread = this.param("hueSpread", 0.35, 0, 1);
        const baseHue = this.param("hue", 0.58, 0, 1) + this.param("hueSpeed", 0.02, 0, 0.5) * this.host.time;
        const force = this.param("force", 1, 0, 3);
        const dye = this.param("dye", 1, 0, 3);
        const radius = this.param("radius", 0.06, 0.01, 0.3);
        const orbit = this.param("orbit", 0.15, 0, 1);
        const wander = this.param("layout", 0, 0, 1) > 0.5;
        for (let k = 0; k < E; k++) {
            const en = band[k % 3];
            const push = force * (0.2 + 1.6 * en * en) * 6 * dt;
            let x, y, vx, vy;
            if (wander) {
                const path = (t) => {
                    const tt = t * (0.05 + 0.4 * orbit);
                    return [
                        Math.min(0.94, Math.max(0.06, 0.5 + 0.6 * simNoise(k * 7.13 + 0.5, tt, 3.1))),
                        Math.min(0.92, Math.max(0.08, 0.5 + 0.55 * simNoise(k * 3.71 + 40.5, tt, 7.7))),
                    ];
                };
                [x, y] = path(this.time);
                const [x2, y2] = path(this.time + 0.25);
                const dx = (x2 - x) * aspect, dy = y2 - y;
                const l = Math.sqrt(dx * dx + dy * dy) + 1e-6;
                vx = (dx / l) * push;
                vy = (dy / l) * push;
            } else {
                const th = 6.2831853 * (k / E + orbit * this.time);
                const ox = Math.cos(th), oy = Math.sin(th);
                x = 0.5 + (0.28 * ox) / aspect;
                y = 0.5 + 0.28 * oy;
                vx = -oy * push - ox * push * 0.15;
                vy = ox * push - oy * push * 0.15;
            }
            const rgb = simHsv(baseHue + (hueSpread * k) / E, 0.85, 1);
            const amount = dye * (0.15 + 1.5 * en * en) * dt * 4;
            out.push([x, y, vx, vy, rgb[0] * amount, rgb[1] * amount, rgb[2] * amount, radius]);
        }
        // A hit: a ring of outward pushes and a flash of pale dye near the middle.
        if (this.onBeat(audio)) {
            this.hits++;
            const h = hashu((Math.imul(this.hits, 2654435761) + 17) >>> 0);
            const cx = 0.3 + (0.4 * (h & 0xffff)) / 65535;
            const cy = 0.3 + (0.4 * (h >>> 16)) / 65535;
            const rgb = simHsv(baseHue + 0.5 * hueSpread, 0.3, 1);
            for (let j = 0; j < 6; j++) {
                const t = (6.2831853 * j) / 6;
                out.push([cx + (0.03 * Math.cos(t)) / aspect, cy + 0.03 * Math.sin(t), Math.cos(t) * 1.2 * force, Math.sin(t) * 1.2 * force,
                    rgb[0] * 0.5 * dye, rgb[1] * 0.5 * dye, rgb[2] * 0.5 * dye, radius * 0.7]);
            }
        }
        return out;
    }

    protected render(audio: MscopesAudioFrame) {
        const gl = this.gl;
        const caps = glCaps(gl);
        if (!caps.half) {
            return;
        }
        const W = this.width(), H = this.height();
        const dt = Math.min(0.1, Math.max(0, this.host.dt));
        this.time += dt;
        const splats = this.splats(audio, W / H);
        const sc = Math.min(1, Math.max(0.05, this.param("scale", 0.25, 0.1, 0.5)));
        const gw = Math.max(16, Math.round(W * sc)), gh = Math.max(9, Math.round(H * sc));
        let reset = false;
        if (this.gridSize !== `${gw}x${gh}`) {
            this.freeGrids();
            const half = caps.half;
            const exact = caps.float || caps.half;
            const make = (type) => new Target(gl, gw, gh, type);
            this.grids = {
                vel: [make(half), make(half)],
                dye: [make(half), make(half)],
                pr: [make(exact), make(exact)],
                div: make(exact),
                curl: make(exact),
            };
            this.vi = 0;
            this.di = 0;
            this.ri = 0;
            this.gridSize = `${gw}x${gh}`;
            reset = true;
        }
        const grids = this.grids;
        if (reset) {
            for (const target of [...grids.vel, ...grids.dye, ...grids.pr, grids.div, grids.curl]) {
                clearTarget(gl, target, 0, 0, 0, 0);
            }
        }
        // 1. splats: velocity, then dye
        if (splats.length) {
            const program = this.program("splat", SPLAT);
            for (let from = 0; from < Math.min(splats.length, 32); from += MAX_SPLATS) {
                const chunk = splats.slice(from, from + MAX_SPLATS);
                const a = new Float32Array(MAX_SPLATS * 4), b = new Float32Array(MAX_SPLATS * 4);
                chunk.forEach((s, i) => {
                    a.set([s[0], s[1], s[2], s[3]], i * 4);
                    b.set([s[4], s[5], s[6], s[7]], i * 4);
                });
                for (const [grid, index, kind] of [["vel", "vi", 0], ["dye", "di", 1]] as [string, string, number][]) {
                    const source = grids[grid][this[index]], target = grids[grid][this[index] ^ 1];
                    this.run(target, program, (p) => p.texture("u_src", source.texture).fv4("u_a", a).fv4("u_b", b).f("u_info", chunk.length, kind));
                    this[index] ^= 1;
                }
            }
        }
        // 2. vorticity confinement
        const vorticity = this.param("vorticity", 25, 0, 60);
        this.run(grids.curl, this.program("curl", CURL), (p) => p.texture("u_vel", grids.vel[this.vi].texture));
        this.run(grids.vel[this.vi ^ 1], this.program("vort", VORT),
            (p) => p.texture("u_vel", grids.vel[this.vi].texture).texture("u_curl", grids.curl.texture).f("u_p", dt, vorticity));
        this.vi ^= 1;
        // 3. pressure projection
        this.run(grids.div, this.program("div", DIV), (p) => p.texture("u_vel", grids.vel[this.vi].texture));
        const jacobi = this.program("jacobi", JACOBI);
        for (let it = 0; it < 20; it++) {
            this.run(grids.pr[this.ri ^ 1], jacobi, (p) => p.texture("u_pr", grids.pr[this.ri].texture).texture("u_div", grids.div.texture));
            this.ri ^= 1;
        }
        this.run(grids.vel[this.vi ^ 1], this.program("grad", GRAD),
            (p) => p.texture("u_pr", grids.pr[this.ri].texture).texture("u_vel", grids.vel[this.vi].texture));
        this.vi ^= 1;
        // 4. advection: velocity through itself, then dye
        const advect = this.program("advect", ADVECT);
        const velKeep = Math.pow(Math.min(1, Math.max(0, this.param("velKeep", 0.35, 0.05, 1))), dt);
        const dyeKeep = Math.pow(Math.min(1, Math.max(0, this.param("dyeKeep", 0.45, 0.05, 1))), dt);
        const velocity = grids.vel[this.vi];
        this.run(grids.vel[this.vi ^ 1], advect,
            (p) => p.texture("u_src", velocity.texture, true).texture("u_vel", velocity.texture, true).f("u_p", dt, velKeep));
        this.vi ^= 1;
        this.run(grids.dye[this.di ^ 1], advect,
            (p) => p.texture("u_src", grids.dye[this.di].texture, true).texture("u_vel", grids.vel[this.vi].texture, true).f("u_p", dt, dyeKeep));
        this.di ^= 1;
        // 5. into the frame
        composite(this, grids.dye[this.di].texture, this.param("gain", 1, 0, 3), Math.round(this.param("mode", 0, 0, 1)), true);
    }
}

// ---- Reaction Diffusion -------------------------------------------------------------

const MAX_SEEDS = 32;

const RD_COMMON = `
vec2 rdAt(sampler2D t, vec2 i) {
    i = mod(i, u_grid);
    return texture2D(t, (i + 0.5) / u_grid).xy;
}`;

const RD_STEP = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_grid;
uniform vec4 u_p;   // du, dv, feed, kill
${RD_COMMON}
void main() {
    vec2 i = floor(gl_FragCoord.xy);
    vec2 c = rdAt(u_src, i);
    vec2 lap = -c + 0.2 * (rdAt(u_src, i + vec2(-1.0, 0.0)) + rdAt(u_src, i + vec2(1.0, 0.0))
                         + rdAt(u_src, i + vec2(0.0, -1.0)) + rdAt(u_src, i + vec2(0.0, 1.0)))
                  + 0.05 * (rdAt(u_src, i + vec2(-1.0, -1.0)) + rdAt(u_src, i + vec2(1.0, -1.0))
                          + rdAt(u_src, i + vec2(-1.0, 1.0)) + rdAt(u_src, i + vec2(1.0, 1.0)));
    float uvv = c.x * c.y * c.y;
    vec2 r = c + vec2(u_p.x * lap.x - uvv + u_p.z * (1.0 - c.x),
                      u_p.y * lap.y + uvv - (u_p.z + u_p.w) * c.y);
    gl_FragColor = vec4(clamp(r, 0.0, 1.0), 0.0, 0.0);
}`;

const RD_SEED = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_grid;
uniform vec4 u_seeds[${MAX_SEEDS}];   // x, y, radius, index
uniform float u_count;
${HASH}
void main() {
    vec2 g = floor(gl_FragCoord.xy);
    vec2 uv = (g + 0.5) / u_grid;
    vec2 c = texture2D(u_src, uv).xy;
    for (int k = 0; k < ${MAX_SEEDS}; k++) {
        if (float(k) >= u_count) break;
        vec2 d = (uv - u_seeds[k].xy) * vec2(u_grid.x / u_grid.y, 1.0);
        // At least two cells across, or a seed can miss every cell.
        if (length(d) < max(u_seeds[k].z, 2.0 / u_grid.y)) {
            c = vec2(0.5, 0.25 + 0.1 * simRand(g.x * 7919.0 + g.y, u_seeds[k].w));
        }
    }
    gl_FragColor = vec4(c, 0.0, 0.0);
}`;

const RD_COMPOSITE = `${PRELUDE}
uniform sampler2D u_src;
uniform sampler2D u_rd;
uniform vec2 u_size;
uniform vec2 u_grid;
uniform vec3 u_colA;
uniform vec3 u_colB;
uniform vec2 u_p;   // emboss, mix
${RD_COMMON}
float rdV(vec2 q) {
    vec2 f = floor(q), w = q - f;
    float v00 = rdAt(u_rd, f).y, v10 = rdAt(u_rd, f + vec2(1.0, 0.0)).y;
    float v01 = rdAt(u_rd, f + vec2(0.0, 1.0)).y, v11 = rdAt(u_rd, f + vec2(1.0, 1.0)).y;
    return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
}
void main() {
    vec2 g = floor(gl_FragCoord.xy);
    vec2 p = (g + 0.5) / u_size * u_grid - 0.5;
    float v = rdV(p);
    float gx = rdV(p + vec2(1.0, 0.0)) - rdV(p - vec2(1.0, 0.0));
    float gy = rdV(p + vec2(0.0, 1.0)) - rdV(p - vec2(0.0, 1.0));
    float shade = 1.0 + u_p.x * 4.0 * (gy - gx);
    vec3 col = mix(u_colA, u_colB, smoothstep(0.1, 0.45, v)) * max(shade, 0.0);
    vec3 c = texture2D(u_src, (g + 0.5) / u_size).rgb;
    gl_FragColor = vec4(clamp(mix(c, col, u_p.y), 0.0, 1.0), 1.0);
}`;

/**
 * Reaction Diffusion (SimEffects.h): grid scale, feed, kill, speed (steps per frame,
 * with the loudness), how far the music leans the recipe, seed size, hue, mix, emboss,
 * pulse (how hard the music hits the picture).
 */
export class MscopesReactionDiffusion extends MscopesEffect {
    public static componentName = "MscopesReactionDiffusion";
    public static componentTag = "render";
    private started: boolean;
    private random: { rng: number };
    private feedNow: number;
    private killNow: number;
    private hit: number;
    private grids: Target[];
    private gridSize: string;
    private ri: number;
    private seedIndex: number;

    protected setup() {
        this.started = false;
        this.random = { rng: 0x2545f491 };
        this.feedNow = 0;
        this.killNow = 0;
        this.hit = 0;
        this.grids = null;
        this.gridSize = "";
        this.ri = 0;
        this.seedIndex = 0;
    }

    protected teardown() {
        for (const target of this.grids || []) {
            target.destroy();
        }
        this.grids = null;
    }

    protected render(audio: MscopesAudioFrame) {
        const gl = this.gl;
        const type = stateType(gl);
        if (!type) {
            return;
        }
        const W = this.width(), H = this.height();
        const dt = Math.min(0.1, Math.max(0, this.host.dt));
        const { band, level } = audioLevels(audio);
        const feed = this.param("feed", 0.037, 0.01, 0.1);
        const kill = this.param("kill", 0.06, 0.03, 0.075);
        const leaning = this.param("audio", 0.6, 0, 1);
        // The music leans the recipe: mids toward more feed, highs toward more kill.
        const targetFeed = feed + leaning * 0.012 * (band[1] - 0.5) * 2;
        const targetKill = kill + leaning * 0.003 * (band[2] - 0.5) * 2;
        if (!this.started) {
            this.feedNow = targetFeed;
            this.killNow = targetKill;
        }
        const k = 1 - Math.exp(-dt / 2);
        this.feedNow += (targetFeed - this.feedNow) * k;
        this.killNow += (targetKill - this.killNow) * k;
        const rnd = () => xorshift(this.random);
        const seedSize = this.param("seedSize", 0.03, 0.005, 0.1);
        const seeds = [];
        let reset = !this.started;
        if (reset) {
            for (let i = 0; i < 28; i++) {
                const x = rnd(), y = rnd(), r = seedSize * (0.5 + rnd());
                seeds.push([x, y, r]);
            }
        }
        // A hit plants new growth where it lands and flashes the picture.
        const hit = this.onBeat(audio);
        if (hit) {
            for (let i = 0; i < 3; i++) {
                const x = 0.1 + 0.8 * rnd(), y = 0.1 + 0.8 * rnd();
                seeds.push([x, y, seedSize * 1.5]);
            }
        }
        this.hit = hit ? 1 : this.hit * Math.exp(-dt / 0.25);
        this.started = true;

        const sc = Math.min(1, Math.max(0.1, this.param("scale", 0.5, 0.2, 1)));
        const gw = Math.max(16, Math.round(W * sc)), gh = Math.max(9, Math.round(H * sc));
        if (this.gridSize !== `${gw}x${gh}`) {
            for (const target of this.grids || []) {
                target.destroy();
            }
            this.grids = [new Target(gl, gw, gh, type), new Target(gl, gw, gh, type)];
            this.gridSize = `${gw}x${gh}`;
            this.ri = 0;
            reset = true;
        }
        if (reset) {
            clearTarget(gl, this.grids[this.ri], 1, 0, 0, 0);
        }
        if (seeds.length) {
            const data = new Float32Array(MAX_SEEDS * 4);
            seeds.slice(0, MAX_SEEDS).forEach((s, i) => data.set([s[0], s[1], s[2], (this.seedIndex + i) % 4093], i * 4));
            this.seedIndex = (this.seedIndex + seeds.length) % 4093;
            const source = this.grids[this.ri];
            this.run(this.grids[this.ri ^ 1], this.program("seed", RD_SEED),
                (p) => p.texture("u_src", source.texture).f("u_grid", gw, gh).fv4("u_seeds", data).f("u_count", Math.min(MAX_SEEDS, seeds.length)));
            this.ri ^= 1;
        }
        const iterations = Math.min(32, Math.max(1, Math.round(this.param("speed", 12, 1, 32) * (0.3 + 1.4 * level))));
        const stepProgram = this.program("step", RD_STEP);
        const pFeed = Math.min(0.1, Math.max(0.005, this.feedNow));
        const pKill = Math.min(0.075, Math.max(0.03, this.killNow));
        for (let it = 0; it < iterations; it++) {
            const source = this.grids[this.ri];
            this.run(this.grids[this.ri ^ 1], stepProgram, (p) => p.texture("u_src", source.texture).f("u_grid", gw, gh).f("u_p", 1, 0.5, pFeed, pKill));
            this.ri ^= 1;
        }
        // Colour: the bass swells the brightness, the mids lean the hue, a hit flashes it.
        const hue = this.param("hue", 0.08, 0, 1);
        const pulse = this.param("pulse", 1, 0, 2);
        const colorA = simHsv(hue, 0.7, 0.04);
        const glow = 0.7 + pulse * (0.3 * band[0] + 0.3 * this.hit);
        const colorB = simHsv(hue + 0.06 + 0.06 * pulse * (band[1] - 0.5), 0.65, glow);
        const emboss = this.param("emboss", 0.8, 0, 2) * (1 + 0.8 * pulse * this.hit);
        const grid = this.grids[this.ri];
        this.pass(this.program("composite", RD_COMPOSITE), (p) => p.texture("u_rd", grid.texture).f("u_grid", gw, gh)
            .f("u_colA", colorA[0], colorA[1], colorA[2]).f("u_colB", colorB[0], colorB[1], colorB[2])
            .f("u_p", emboss, this.param("mix", 1, 0, 1)), false);
    }
}
