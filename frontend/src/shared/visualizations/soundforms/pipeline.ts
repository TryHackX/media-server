import type { PostSettings, Stops } from "./catalog";
import { createTarget, deleteTarget, FULLSCREEN_VERTEX, HEADER, Program, rgb, type Target } from "./gl";

/**
 * Formy dźwięku draws every scene into one off-screen picture (with depth, in half floats where
 * the GPU can, so added light can go above white), then finishes it into the scene's own output:
 * lens and colour fringes, zoom blur, a mirror floor, glow or soft focus, trails, vignette. Two
 * outputs are kept per scene so a trail can read the last frame. The screen shows one output, or
 * two crossfading while a new preset comes in.
 */

const BACKDROP = `${HEADER}
in vec2 vUv;
out vec4 color;
uniform vec3 uBottom, uTop;
uniform float uPattern, uPx;
void main() {
  vec3 c = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
  if (uPattern > 0.0) {
    // A faint dot matrix, like a screen seen up close.
    vec2 cell = fract(gl_FragCoord.xy / (4.0 * uPx)) - 0.5;
    c += vec3(0.045) * (1.0 - smoothstep(0.16, 0.26, length(cell))) * uPattern;
  }
  color = vec4(c, 1.0);
}`;

/** The bright part of the picture at a quarter of its size (all of it for soft focus). */
const BRIGHT = `${HEADER}
in vec2 vUv;
out vec4 color;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec3 c = (texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSource, vUv + uTexel * vec2(1.0, -1.0)).rgb
    + texture(uSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSource, vUv + uTexel * vec2(1.0, 1.0)).rgb) * 0.25;
  float brightness = max(c.r, max(c.g, c.b));
  float keep = uThreshold <= 0.0 ? 1.0 : smoothstep(uThreshold, uThreshold * 1.6 + 0.05, brightness);
  color = vec4(c * keep, 1.0);
}`;

/** One direction of a Gaussian blur, nine taps folded into five bilinear reads. */
const BLUR = `${HEADER}
in vec2 vUv;
out vec4 color;
uniform sampler2D uSource;
uniform vec2 uStep;
void main() {
  vec3 c = texture(uSource, vUv).rgb * 0.2270270;
  c += texture(uSource, vUv + uStep * 1.3846154).rgb * 0.3162162;
  c += texture(uSource, vUv - uStep * 1.3846154).rgb * 0.3162162;
  c += texture(uSource, vUv + uStep * 3.2307692).rgb * 0.0702703;
  c += texture(uSource, vUv - uStep * 3.2307692).rgb * 0.0702703;
  color = vec4(c, 1.0);
}`;

const FINISH = `${HEADER}
in vec2 vUv;
out vec4 color;
uniform sampler2D uScene, uGlow, uPrevious;
uniform float uAspect, uLens, uAberration, uZoom, uHorizon, uReflection, uReflectOnly;
uniform float uBloom, uSoft, uTrails, uTrailZoom, uVignette, uExposure;
uniform vec3 uBackground;

vec2 bend(vec2 uv, float k) {
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(c, c);
  // A fisheye: the edges show more, squeezed; normalised so the middle keeps its size.
  c *= (1.0 + k * r2) / (1.0 + k * 0.25);
  return c / vec2(uAspect, 1.0) + 0.5;
}

vec3 picture(vec2 uv) {
  // Beyond the picture (a lens shows more than there is) the backdrop, reached softly.
  vec2 margin = min(uv, 1.0 - uv);
  float inside = smoothstep(-0.005, 0.035, min(margin.x, margin.y));
  return mix(uBackground, texture(uScene, clamp(uv, 0.0, 1.0)).rgb, inside);
}

vec3 look(vec2 uv) {
  if (uZoom > 0.0) {
    vec3 sum = vec3(0.0);
    float weights = 0.0;
    for (int i = 0; i < 14; i++) {
      float f = float(i) / 13.0;
      float w = 1.0 - 0.75 * f;
      sum += picture(0.5 + (uv - 0.5) * (1.0 - uZoom * f)) * w;
      weights += w;
    }
    return sum / weights;
  }
  if (uAberration > 0.0 || uLens != 0.0) {
    float spread = uAberration * 0.06;
    return vec3(picture(bend(uv, uLens + spread)).r, picture(bend(uv, uLens)).g, picture(bend(uv, uLens - spread)).b);
  }
  return picture(uv);
}

void main() {
  vec2 uv = vUv;
  vec3 c;
  if (uHorizon > 0.0 && uv.y < uHorizon) {
    // A mirror floor: the picture above the horizon, upside down, blurred with distance.
    float below = (uHorizon - uv.y) / uHorizon;
    vec2 m = vec2(uv.x, 2.0 * uHorizon - uv.y);
    float spread = 0.004 + below * 0.03;
    vec3 mirrored = (look(m) * 0.4 + look(m + vec2(spread, 0.0)) * 0.3 + look(m - vec2(spread, 0.0)) * 0.3);
    mirrored *= uReflection * (1.0 - 0.75 * below);
    c = uReflectOnly > 0.5 ? mirrored + uBackground * 0.5 : look(uv) + mirrored;
    c += vec3(0.08, 0.1, 0.16) * exp(-abs(uv.y - uHorizon) * 900.0) * uReflection;
  } else {
    c = look(uv);
  }
  if (uSoft > 0.0) c = mix(c, texture(uGlow, uv).rgb * 1.1, uSoft);
  if (uBloom > 0.0) c += texture(uGlow, uv).rgb * uBloom;
  if (uExposure > 0.0) c = vec3(1.0) - exp(-c * uExposure);
  if (uVignette > 0.0) {
    vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
    c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(d));
  }
  if (uTrails > 0.0) {
    vec3 earlier = texture(uPrevious, 0.5 + (uv - 0.5) / uTrailZoom).rgb * uTrails;
    c = max(c, earlier - 1.5 / 255.0);
  }
  color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const COMPOSITE = `${HEADER}
in vec2 vUv;
out vec4 color;
uniform sampler2D uBase, uIncoming;
uniform float uFade;
void main() {
  vec3 c = texture(uBase, vUv).rgb;
  if (uFade > 0.0) c = mix(c, texture(uIncoming, vUv).rgb, uFade);
  color = vec4(c, 1.0);
}`;

/** The two pictures a scene finishes into, alternately (the trail reads the other one). */
export interface Outputs {
  targets: [Target, Target];
  /** The one written last. */
  current: 0 | 1;
}

export class Pipeline {
  /** Scenes may draw light above white (half-float picture). */
  readonly hdr: boolean;
  /** An empty vertex array: the scenes draw from gl_VertexID and gl_InstanceID. */
  readonly vao: WebGLVertexArrayObject;
  width = 1;
  height = 1;
  private scene: Target | null = null;
  private glowA: Target | null = null;
  private glowB: Target | null = null;
  private readonly backdrop: Program;
  private readonly bright: Program;
  private readonly blur: Program;
  private readonly finishing: Program;
  private readonly composite: Program;
  private readonly programs = new Map<string, Program>();

  constructor(readonly gl: WebGL2RenderingContext) {
    this.hdr = Boolean(gl.getExtension("EXT_color_buffer_float"));
    this.vao = gl.createVertexArray();
    this.backdrop = new Program(gl, FULLSCREEN_VERTEX, BACKDROP);
    this.bright = new Program(gl, FULLSCREEN_VERTEX, BRIGHT);
    this.blur = new Program(gl, FULLSCREEN_VERTEX, BLUR);
    this.finishing = new Program(gl, FULLSCREEN_VERTEX, FINISH);
    this.composite = new Program(gl, FULLSCREEN_VERTEX, COMPOSITE);
  }

  /** A program shared by every scene of a kind, compiled once per visit. */
  program(key: string, vertex: string, fragment: string): Program {
    let program = this.programs.get(key);
    if (!program) {
      program = new Program(this.gl, vertex, fragment);
      this.programs.set(key, program);
    }
    return program;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.scene) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;
    deleteTarget(gl, this.scene);
    deleteTarget(gl, this.glowA);
    deleteTarget(gl, this.glowB);
    this.scene = createTarget(gl, width, height, { depth: true, hdr: this.hdr });
    const quarterWidth = Math.max(1, Math.round(width / 4));
    const quarterHeight = Math.max(1, Math.round(height / 4));
    this.glowA = createTarget(gl, quarterWidth, quarterHeight, { hdr: this.hdr });
    this.glowB = createTarget(gl, quarterWidth, quarterHeight, { hdr: this.hdr });
  }

  createOutputs(): Outputs {
    const gl = this.gl;
    return {
      targets: [createTarget(gl, this.width, this.height), createTarget(gl, this.width, this.height)],
      current: 0
    };
  }

  resizeOutputs(outputs: Outputs): void {
    const [first, second] = outputs.targets;
    if (first.width === this.width && first.height === this.height) return;
    deleteTarget(this.gl, first);
    deleteTarget(this.gl, second);
    outputs.targets = [createTarget(this.gl, this.width, this.height), createTarget(this.gl, this.width, this.height)];
  }

  deleteOutputs(outputs: Outputs): void {
    deleteTarget(this.gl, outputs.targets[0]);
    deleteTarget(this.gl, outputs.targets[1]);
  }

  /** Bind the scene picture, clear it and paint the backdrop. */
  begin(background: Stops, pattern: boolean, px: number): void {
    const gl = this.gl;
    const scene = this.scene;
    if (!scene) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const bottom = rgb(background[0] ?? 0);
    const top = rgb(background[background.length - 1] ?? 0);
    gl.bindVertexArray(this.vao);
    this.backdrop.use()
      .f3("uBottom", bottom[0], bottom[1], bottom[2])
      .f3("uTop", top[0], top[1], top[2])
      .f("uPattern", pattern ? 1 : 0)
      .f("uPx", px);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Finish the scene picture into the next of `outputs`. */
  finish(post: PostSettings, background: Stops, outputs: Outputs): void {
    const gl = this.gl;
    const scene = this.scene;
    const glowA = this.glowA;
    const glowB = this.glowB;
    if (!scene || !glowA || !glowB) return;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const glow = (post.bloom ?? 0) > 0 || (post.soft ?? 0) > 0;
    if (glow) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, glowA.framebuffer);
      gl.viewport(0, 0, glowA.width, glowA.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.texture);
      this.bright.use().i("uSource", 0)
        .f2("uTexel", 1 / scene.width, 1 / scene.height)
        .f("uThreshold", (post.soft ?? 0) > 0 ? 0 : post.threshold ?? 0.8);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // Two rounds of blur: wide enough to read as glow at a quarter of the size.
      for (let round = 0; round < 2; round += 1) {
        const spread = round + 1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, glowB.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, glowA.texture);
        this.blur.use().i("uSource", 0).f2("uStep", spread / glowA.width, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, glowA.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, glowB.texture);
        this.blur.use().i("uSource", 0).f2("uStep", 0, spread / glowA.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    const previous = outputs.targets[outputs.current];
    const next: 0 | 1 = outputs.current === 0 ? 1 : 0;
    const target = outputs.targets[next];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, glowA.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, previous.texture);
    const back = rgb(background[0] ?? 0);
    this.finishing.use()
      .i("uScene", 0).i("uGlow", 1).i("uPrevious", 2)
      .f("uAspect", scene.width / scene.height)
      .f("uLens", post.lens ?? 0)
      .f("uAberration", post.aberration ?? 0)
      .f("uZoom", post.zoomBlur ?? 0)
      .f("uHorizon", post.horizon ?? 0)
      .f("uReflection", post.reflection ?? 0.5)
      .f("uReflectOnly", post.reflectOnly ? 1 : 0)
      .f("uBloom", glow ? post.bloom ?? 0 : 0)
      .f("uSoft", glow ? post.soft ?? 0 : 0)
      .f("uTrails", post.trails ?? 0)
      .f("uTrailZoom", post.trailZoom ?? 1)
      .f("uVignette", post.vignette ?? 0)
      .f("uExposure", post.exposure ?? 0)
      .f3("uBackground", back[0], back[1], back[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    outputs.current = next;
  }

  /** The screen: one output, or two with the second faded in by `fade` (0–1). */
  present(base: Outputs | null, incoming: Outputs | null, fade: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    const first = base ?? incoming;
    if (!first) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const second = base && incoming ? incoming : first;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, first.targets[first.current].texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, second.targets[second.current].texture);
    this.composite.use().i("uBase", 0).i("uIncoming", 1).f("uFade", base && incoming ? fade : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The scene picture, for a scene that reads what it drew (none yet). */
  sceneTarget(): Target | null {
    return this.scene;
  }

  dispose(): void {
    const gl = this.gl;
    for (const program of this.programs.values()) program.dispose();
    this.programs.clear();
    for (const program of [this.backdrop, this.bright, this.blur, this.finishing, this.composite]) program.dispose();
    deleteTarget(gl, this.scene);
    deleteTarget(gl, this.glowA);
    deleteTarget(gl, this.glowB);
    this.scene = null;
    this.glowA = null;
    this.glowB = null;
    gl.deleteVertexArray(this.vao);
  }
}
