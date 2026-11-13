// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * What mscopes' EffectHost gave its effects, for one webvs engine:
 *
 * - the frame clock (EffectContext): time, dt (the frame's, kept within
 *   1/240…1/20 s as mscopes did) and a frame counter;
 * - the audio frame (audio.ts);
 * - `prev`, the previous frame's final picture. mscopes kept a copy of the frame at
 *   the end of every frame for the effects that read it (Feedback Warp, Trails); here
 *   the list's current texture is copied when a frame starts — before any effect has
 *   drawn on it, it still is the last frame's final picture. The copy is taken only
 *   for lists that have such an effect.
 */
import { mscopesAudio } from "./audio";
import { clearTarget, drawQuad, into, PRELUDE, Program, Target } from "./gl";

const COPY = `${PRELUDE}
uniform sampler2D u_src;
void main() { gl_FragColor = texture2D(u_src, v_uv); }`;

interface Snapshot {
    target: Target;
    users: number;
}

export class MscopesHost {
    public time: number;
    public dt: number;
    public frame: number;
    public readonly audio;
    private readonly main;
    private readonly gl: WebGLRenderingContext;
    private readonly snapshots: Map<any, Snapshot>;
    private copy: Program | null;

    constructor(main) {
        this.main = main;
        this.gl = main.getRctx().getGl();
        this.time = 0;
        this.dt = 1 / 60;
        this.frame = 0;
        this.snapshots = new Map();
        this.copy = null;
        this.audio = mscopesAudio(main.getAnalyser());
        // The engine's frame time (index.ts sets it before each frame), else the clock.
        this.audio.timeSource = () => (typeof main.avsFrameTime === "number" ? main.avsFrameTime : performance.now());
        this.audio.onFrameStart(() => this.frameStart());
        main.on("resize", () => {
            for (const snapshot of this.snapshots.values()) {
                if (snapshot.target.resize(this.gl.drawingBufferWidth, this.gl.drawingBufferHeight)) {
                    clearTarget(this.gl, snapshot.target);
                }
            }
        });
    }

    /** The previous frame of `tsm`'s list, kept from now on (until released). */
    public watchPrevious(tsm): Snapshot {
        let snapshot = this.snapshots.get(tsm);
        if (!snapshot) {
            const gl = this.gl;
            const type = tsm.getTextureType ? tsm.getTextureType() : gl.UNSIGNED_BYTE;
            const target = new Target(gl, gl.drawingBufferWidth, gl.drawingBufferHeight, type);
            // Black, as mscopes' frames start.
            clearTarget(gl, target);
            snapshot = { target, users: 0 };
            this.snapshots.set(tsm, snapshot);
        }
        snapshot.users++;
        return snapshot;
    }

    public releasePrevious(tsm): void {
        const snapshot = this.snapshots.get(tsm);
        if (snapshot && --snapshot.users <= 0) {
            snapshot.target.destroy();
            this.snapshots.delete(tsm);
        }
    }

    private frameStart(): void {
        this.dt = Math.max(1 / 240, Math.min(1 / 20, this.audio.dt || 1 / 60));
        this.time += this.dt;
        this.frame++;
        if (!this.snapshots.size) {
            return;
        }
        const gl = this.gl;
        if (!this.copy) {
            this.copy = new Program(gl, COPY);
        }
        for (const [tsm, snapshot] of this.snapshots) {
            let source;
            try {
                source = tsm.getCurrentTexture();
            } catch (gone) {
                continue;
            }
            if (!source) {
                continue;
            }
            snapshot.target.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);
            into(gl, snapshot.target, () => {
                gl.disable(gl.BLEND);
                this.copy.use().texture("u_src", source);
                drawQuad(gl, this.copy);
            });
        }
    }
}

const hosts = new WeakMap();

export function mscopesHost(main): MscopesHost {
    let host = hosts.get(main);
    if (!host) {
        host = new MscopesHost(main);
        hosts.set(main, host);
    }
    return host;
}
