import { COMMON } from "./glsl";
import { Kit, type Program, type Target, type Uniforms } from "./kit";

/**
 * The picture the psychedelic visualizations work on: the track's cover, or an image or a
 * video the listener picked (it never leaves the browser), or — with neither — a painting
 * drawn here, so every one of them has something alive to work on.
 *
 * Shaders read `uSrc` (linear colour, uv 0–1 with the origin at the bottom left, mirrored
 * beyond the edges), `uSrcAspect` (width / height) and `uHasSrc` (1: a real picture).
 */

const PAINTING = COMMON + /* glsl */ `
uniform float uT, uSeed, uEnergy;
// Agate: broad bands of a twice-warped field in a turning palette, their rims lit, over a slow rosette.
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float a = atan(p.y, p.x), r = length(p);
  vec2 q = p * 0.62 + vec2(uSeed * 3.1, uSeed * 1.7);
  vec2 w = vec2(snoise(q + vec2(0.0, uT * 0.05)), snoise(q + vec2(5.2, 1.3) - uT * 0.04));
  vec2 w2 = vec2(snoise(q * 1.4 + 1.1 * w + vec2(1.7, 9.2) + uT * 0.03), snoise(q * 1.4 + 1.1 * w + vec2(8.3, 2.8)));
  float f = snoise(q * 0.9 + 0.8 * w2) + 0.25 * snoise(q * 2.6 + 1.5 * w);
  float petals = 3.0 + floor(hash11(uSeed * 17.0 + 2.0) * 4.0);
  float rosette = cos(a * petals + sin(r * 3.0 - uT * 0.15) * 1.2) * exp(-r * 1.4);
  float t = f * 0.8 + rosette * 0.45 + r * 0.3;
  float bands = t * 3.2 + uT * 0.04;
  float cell = floor(bands), along = fract(bands);
  // Orange, rose, violet, azure, teal, gold: green is held back so no seed turns the whole painting lime.
  vec3 phase = vec3(0.0, 0.2, 0.55) + uSeed;
  vec3 here = palette(cell * 0.211 + 0.3 * f, vec3(0.5, 0.38, 0.55), vec3(0.5, 0.38, 0.45), vec3(1.0, 1.0, 1.0), phase);
  vec3 there = palette((cell + 1.0) * 0.211 + 0.3 * f, vec3(0.5, 0.38, 0.55), vec3(0.5, 0.38, 0.45), vec3(1.0, 1.0, 1.0), phase);
  vec3 c = toLinear(mix(here, there, smoothstep(0.82, 1.0, along)));
  // Each band is shaded across its width, and its rim glows.
  c *= 0.45 + 0.75 * smoothstep(0.0, 0.7, along) * (1.0 - 0.6 * smoothstep(0.7, 1.0, along));
  float rim = exp(-abs(along - 0.9) * 22.0);
  c += vec3(1.0, 0.88, 0.7) * rim * (0.6 + 1.2 * uEnergy);
  fragColor = vec4(max(c, 0.0), 1.0);
}
`;

const PAINTING_SIZE = 1024;

export class Source {
  public kind: "none" | "image" | "video" = "none";
  public width = 1;
  public height = 1;
  private readonly kit: Kit;
  private readonly picture: WebGLTexture;
  private video: HTMLVideoElement | null = null;
  private painting: Target | null = null;
  private readonly program: Program;
  private seed = 0.37;

  public constructor(gl: WebGL2RenderingContext) {
    this.kit = new Kit(gl);
    this.picture = this.kit.imageTexture("mirror");
    // Compiled from the start, in the background where the browser can: the first frame that
    // needs the painting does not wait for it.
    this.program = this.kit.program(PAINTING);
  }

  private upload(source: TexImageSource, mipmaps: boolean): void {
    const gl = this.kit.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.picture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // sRGB storage: the sampler hands shaders linear colour, and filters it as light.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** A cover or a picture the listener picked. */
  public setImage(image: HTMLImageElement | ImageBitmap | HTMLCanvasElement): void {
    this.video = null;
    this.width = "naturalWidth" in image ? image.naturalWidth : image.width;
    this.height = "naturalHeight" in image ? image.naturalHeight : image.height;
    if (!this.width || !this.height) {
      this.clear();
      return;
    }
    this.upload(image, true);
    this.kind = "image";
  }

  /** A video the listener picked: the caller plays (or seeks) it, `update` reads its frames. */
  public setVideo(video: HTMLVideoElement): void {
    this.video = video;
    this.kind = "video";
    this.update();
  }

  /** Back to the painting. */
  public clear(): void {
    this.video = null;
    this.kind = "none";
  }

  /** The seed of the painting shown with no picture. */
  public reseed(seed: number): void {
    this.seed = seed % 1;
  }

  /** Once a frame: the video's current frame, or the painting drawn anew. */
  public update(time = 0, energy = 0): void {
    if (this.kind === "video" && this.video) {
      if (this.video.readyState >= 2 && this.video.videoWidth) {
        this.width = this.video.videoWidth;
        this.height = this.video.videoHeight;
        this.upload(this.video, false);
      }
      return;
    }
    if (this.kind === "none") {
      this.painting ??= this.kit.target(PAINTING_SIZE, PAINTING_SIZE, "rgba16f", { wrap: "mirror" });
      // Still compiling: the painting stays as it was (black before its first frame) for now.
      if (this.kit.usable(this.program)) this.kit.draw(this.program, this.painting, { uT: time, uSeed: this.seed, uEnergy: energy });
    }
  }

  public get texture(): WebGLTexture {
    return this.kind === "none" && this.painting ? this.painting.texture : this.picture;
  }

  public get aspect(): number {
    return this.kind === "none" ? 1 : this.width / Math.max(1, this.height);
  }

  public uniforms(): Uniforms {
    return { uSrc: this.texture, uSrcAspect: this.aspect, uHasSrc: this.kind === "none" ? 0 : 1 };
  }

  public destroy(): void {
    this.kit.destroy();
  }
}
