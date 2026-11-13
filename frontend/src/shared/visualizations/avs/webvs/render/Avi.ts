// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Render / AVI as r_avi.cpp (vis_avs 2.81d, BSD): a video clip from the AVS folder stretched over
 * the frame, one clip frame per rendered frame — AVIStreamGetFrame(index++ % length) — or, with
 * `speed` ms set, a new clip frame only once that many ms (GetTickCount) have passed, the last one
 * shown again meanwhile. Blending: additive with "blend", or with "adapt" on a beat and for
 * `persist` frames after it (a counter all AVI effects share: a static in render()); otherwise
 * 50/50 with "blendavg" or "adapt"; otherwise the clip replaces the frame.
 *
 * The clip comes from the build (scripts/avs-presets.mjs, `video`): its distinct frames tiled in
 * WebP pages and a map from the stream's frame index to a tile — the browser cannot step a <video>
 * by frame index. DrawDibDraw's stretch is taken as GDI's: the source pixel under the centre of
 * each frame pixel, ⌊(x + ½)·w / W⌋. A clip the packs did not carry draws nothing, as AVS did
 * when AVIStreamOpenFromFile failed.
 */
import Component from "../Component";
import ShaderProgram from "../webgl/ShaderProgram";
import { WebGLVarType } from "../utils";
import { HIGH_PRECISION } from "../avsSupport";

/** persistCount: one for every AVI effect (a static local of r_avi.cpp's render). */
let persistCount = 0;

interface AviVideo {
    pages: string[];
    width: number;
    height: number;
    length: number;
    cols: number;
    rows: number;
    map: [number, number][];
}

export default class Avi extends Component {
    public static componentName: string = "AVI";
    public static componentTag: string = "render";
    private program: ShaderProgram;
    // Fields without initializers: the base constructor runs init() before they would apply.
    private textures: (WebGLTexture | null)[];
    private sizes: { width: number; height: number }[];
    private frameIndex: number;
    private lastSpeed: number;
    private shown: [number, number] | null;

    public init() {
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    atlas: { name: "u_atlas", valueType: WebGLVarType.TEXTURE2D },
                    atlasSize: { name: "u_atlasSize", valueType: WebGLVarType._2FV },
                    cell: { name: "u_cell", valueType: WebGLVarType._2FV },
                    video: { name: "u_video", valueType: WebGLVarType._2FV },
                    mode: { name: "u_mode", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_atlas;
                uniform vec2 u_atlasSize;
                uniform vec2 u_cell;
                uniform vec2 u_video;
                uniform float u_mode;
                void main() {
                    float column = floor(gl_FragCoord.x);
                    float row = floor(u_resolution.y - gl_FragCoord.y);
                    vec2 source = floor((vec2(column, row) + 0.5) * u_video / u_resolution);
                    vec2 texel = u_cell + min(source, u_video - 1.0);
                    vec3 s = floor(texture2D(u_atlas, (texel + 0.5) / u_atlasSize).rgb * 255.0 + 0.5);
                    vec3 d = floor(getSrcColor().rgb * 255.0 + 0.5);
                    vec3 color = u_mode < 0.5 ? s : u_mode < 1.5 ? min(d + s, vec3(255.0)) : floor(d * 0.5) + floor(s * 0.5);
                    setFragColor(vec4(color / 255.0, 1.0));
                }
            `,
            swapFrame: true,
        });
        this.textures = [];
        this.sizes = [];
        this.frameIndex = 0;
        this.lastSpeed = 0;
        this.shown = null;
        const video = this.video();
        if (!video) {
            return;
        }
        // load_config opened the clip before the first frame: the frames wait for its pages.
        const rsrc = this.main.getRsrcMan();
        video.pages.forEach((url, page) => {
            const key = `avi:${url}`;
            rsrc.registerUri(key, url);
            try {
                rsrc.getImage(key, (image) => {
                    if (!this.program) {
                        return;
                    }
                    const gl = this.main.getRctx().getGl();
                    const texture = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    this.textures[page] = texture;
                    this.sizes[page] = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
                });
            } catch (missing) {
                // a page that cannot load: those frames draw nothing
            }
        });
    }

    private video(): AviVideo | null {
        const video = this.opts.video;
        if (!video || !Array.isArray(video.pages) || !video.pages.length || !(video.length > 0)) {
            return null;
        }
        return video;
    }

    public draw() {
        const opts = this.opts;
        const video = this.video();
        if (opts.enabled === false || !video) {
            return;
        }
        const now = typeof this.main.avsFrameTime === "number" ? this.main.avsFrameTime : performance.now();
        const speed = Math.max(0, Number(opts.speed) || 0);
        if (!this.shown || !(this.lastSpeed + speed > now)) {
            this.lastSpeed = now;
            this.frameIndex %= video.length;
            this.shown = video.map[this.frameIndex] || video.map[0];
            this.frameIndex++;
        }
        const beat = this.main.getAnalyser().isBeat();
        if (beat) {
            persistCount = Math.trunc(Number(opts.persist) || 0);
        } else if (persistCount > 0) {
            persistCount--;
        }
        const [page, cell] = this.shown;
        const texture = this.textures[page];
        const size = this.sizes[page];
        if (!texture || !size) {
            return;
        }
        const blend = Number(opts.blend) || 0;
        const blendAvg = Number(opts.blendavg) || 0;
        const adapt = Number(opts.adapt) || 0;
        const mode = blend || (adapt && (beat || persistCount)) ? 1 : blendAvg || adapt ? 2 : 0;
        this.program.run(this.parent.getTSM(), {
            atlas: texture,
            atlasSize: [size.width, size.height],
            cell: [(cell % video.cols) * video.width, Math.floor(cell / video.cols) * video.height],
            mode,
            video: [video.width, video.height],
        });
    }

    public destroy() {
        super.destroy();
        const gl = this.main.getRctx().getGl();
        for (const texture of this.textures) {
            if (texture) {
                gl.deleteTexture(texture);
            }
        }
        this.textures = [];
        if (this.program) {
            this.program.destroy();
            this.program = null;
        }
    }
}
