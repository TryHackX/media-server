import { Kit, type Program, type Target } from "./kit";

/**
 * From a visualization's linear HDR picture to the screen: bloom over six octaves, a tone curve
 * that keeps hue, the luminance governor, grading, grain and dither.
 *
 * The governor is the photosensitivity guard every visualization passes through. It measures
 * the mean relative luminance of the finished frame and holds what is shown to a limited rate
 * of change: the picture may brighten quickly but darkens no faster than `fall` per second
 * (0.3 by default), so a pair of opposing changes of 10 % of full luminance — WCAG 2.3.1's
 * "flash" — cannot complete more than three times a second. In gentle mode the rise is held
 * as well. It works by a gain on the frame, so it reads as the eye adapting, never as a cut.
 */

export interface PostOptions {
  /** Linear gain before the tone curve. */
  exposure?: number;
  /** How much of the bloom is added. */
  bloom?: number;
  /** How far the bloom spreads, 0–1 (the weight of each wider octave). */
  bloomRadius?: number;
  /** Luminance under which nothing blooms (soft knee). */
  threshold?: number;
  /** Radial colour fringing at the frame's edge, as a fraction of the picture. */
  aberration?: number;
  vignette?: number;
  /** Film grain, in 8-bit steps. */
  grain?: number;
  saturation?: number;
  contrast?: number;
  /** How far highlights wash toward white, 0–1. */
  whiten?: number;
  /** Photosensitive mode: brightness may not rise quickly either. */
  gentle?: boolean;
}

const OCTAVES = 6;

const PREFILTER = /* glsl */ `
uniform sampler2D uScene;
uniform vec2 uTexel;
// Half size, four taps weighted against their own brightness: one hot pixel does not flicker the bloom.
void main() {
  vec3 a = texture(uScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uScene, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(uScene, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture(uScene, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec4 w = 1.0 / (1.0 + vec4(max(a.r, max(a.g, a.b)), max(b.r, max(b.g, b.b)), max(c.r, max(c.g, c.b)), max(d.r, max(d.g, d.b))));
  vec3 sum = (a * w.x + b * w.y + c * w.z + d * w.w) / (w.x + w.y + w.z + w.w);
  fragColor = vec4(min(max(sum, 0.0), vec3(64.0)), 1.0);
}
`;

const DOWN = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uThreshold;
vec3 tap(vec2 offset) { return texture(uSource, vUv + uTexel * offset).rgb; }
// Thirteen taps: a wide, round kernel that does not shimmer as the picture moves.
void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 sum = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uThreshold > 0.0) {
    float peak = max(sum.r, max(sum.g, sum.b));
    float knee = uThreshold * 0.6;
    float soft = clamp(peak - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    sum *= max(soft, peak - uThreshold) / max(peak, 1e-5);
  }
  fragColor = vec4(sum, 1.0);
}
`;

const UP = /* glsl */ `
uniform sampler2D uWide;
uniform sampler2D uNarrow;
uniform vec2 uTexel;
uniform float uRadius;
// A 3 × 3 tent over the wider octave, laid over the narrower one.
void main() {
  vec3 sum = texture(uWide, vUv).rgb * 4.0;
  sum += (texture(uWide, vUv + uTexel * vec2(1, 0)).rgb + texture(uWide, vUv + uTexel * vec2(-1, 0)).rgb
        + texture(uWide, vUv + uTexel * vec2(0, 1)).rgb + texture(uWide, vUv + uTexel * vec2(0, -1)).rgb) * 2.0;
  sum += texture(uWide, vUv + uTexel * vec2(1, 1)).rgb + texture(uWide, vUv + uTexel * vec2(-1, 1)).rgb
       + texture(uWide, vUv + uTexel * vec2(1, -1)).rgb + texture(uWide, vUv + uTexel * vec2(-1, -1)).rgb;
  fragColor = vec4(texture(uNarrow, vUv).rgb + sum / 16.0 * uRadius, 1.0);
}
`;

/** The picture as it will be shown, before the governor's gain: shared by the meter and the final pass. */
const GRADE = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uExposure, uBloomAmount, uSaturation, uContrast, uWhiten, uVignette, uAberration;
uniform vec2 uAspect;
vec3 tonemap(vec3 c) {
  c = max(c, 0.0);
  float peak = max(c.r, max(c.g, c.b));
  if (peak < 1e-6) return vec3(0.0);
  // The brightest channel takes the curve, the others keep their ratio to it: hue holds as
  // light is added; far into the highlights the colour washes toward white, as a hot core does.
  float mapped = 1.0 - exp(-peak);
  vec3 hue = c / peak;
  float hot = smoothstep(1.2, 9.0, peak) * uWhiten;
  return mix(hue, vec3(1.0), hot) * mapped;
}
vec3 graded(vec2 uv, bool fringe) {
  vec2 centred = (uv - 0.5) * uAspect;
  float r2 = dot(centred, centred);
  vec3 scene;
  if (fringe && uAberration > 0.0) {
    vec2 shift = (uv - 0.5) * r2 * uAberration * 4.0;
    scene = vec3(texture(uScene, uv - shift).r, texture(uScene, uv).g, texture(uScene, uv + shift).b);
  } else scene = texture(uScene, uv).rgb;
  vec3 c = (scene + texture(uBloom, uv).rgb * uBloomAmount) * uExposure;
  c = tonemap(c);
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(y), c, uSaturation);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  c *= 1.0 - uVignette * smoothstep(0.15, 1.1, r2 * 1.6);
  return clamp(c, 0.0, 1.0);
}
`;

const METER = GRADE + /* glsl */ `
// A quarter size, read from the half-size picture: each pixel the luminance of the 4 × 4 it stands for.
void main() {
  fragColor = vec4(dot(graded(vUv, false), vec3(0.2126, 0.7152, 0.0722)), 0.0, 0.0, 1.0);
}
`;

const METER_DOWN = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
void main() {
  float sum = texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).r + texture(uSource, vUv + uTexel * vec2(1.0, -1.0)).r
            + texture(uSource, vUv + uTexel * vec2(-1.0, 1.0)).r + texture(uSource, vUv + uTexel * vec2(1.0, 1.0)).r;
  fragColor = vec4(sum * 0.25, 0.0, 0.0, 1.0);
}
`;

const GOVERN = /* glsl */ `
uniform sampler2D uMeter;
uniform sampler2D uState;
uniform ivec2 uMeterSize;
uniform float uRise, uFall, uFirst;
// r: the luminance shown, g: the gain that gives it, b: the luminance measured.
void main() {
  float sum = 0.0;
  for (int y = 0; y < uMeterSize.y; y++) for (int x = 0; x < uMeterSize.x; x++) sum += texelFetch(uMeter, ivec2(x, y), 0).r;
  float measured = sum / float(uMeterSize.x * uMeterSize.y);
  float shown = texelFetch(uState, ivec2(0), 0).r;
  float next = uFirst > 0.5 ? measured : clamp(measured, shown - uFall, shown + uRise);
  float gain = clamp(next / max(measured, 1e-4), 0.45, 2.2);
  fragColor = vec4(measured * gain, gain, measured, 1.0);
}
`;

const FINAL = GRADE + /* glsl */ `
uniform sampler2D uState;
uniform float uGrain, uSeed;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 c = graded(vUv, true);
  float gain = texelFetch(uState, ivec2(0), 0).g;
  // The gain bends rather than clips where it lifts the picture.
  c = gain <= 1.0 ? c * gain : 1.0 - pow(1.0 - c, vec3(gain));
  c = encode(clamp(c, 0.0, 1.0));
  // Grain and a triangular dither: no banding in the dark gradients.
  vec2 p = gl_FragCoord.xy + uSeed * 61.7;
  float n = hash(p) + hash(p + 17.31) - 1.0;
  c += n * (1.0 + uGrain) / 255.0;
  fragColor = vec4(c, 1.0);
}
`;

export class Post {
  private readonly kit: Kit;
  private readonly prefilter: Program;
  private readonly down: Program;
  private readonly up: Program;
  private readonly meter: Program;
  private readonly meterDown: Program;
  private readonly govern: Program;
  private readonly final: Program;
  private downs: Target[] = [];
  private ups: Target[] = [];
  private meters: Target[] = [];
  private state: [Target, Target];
  private first = true;
  private frame = 0;

  public constructor(gl: WebGL2RenderingContext) {
    this.kit = new Kit(gl);
    this.prefilter = this.kit.program(PREFILTER);
    this.down = this.kit.program(DOWN);
    this.up = this.kit.program(UP);
    this.meter = this.kit.program(METER);
    this.meterDown = this.kit.program(METER_DOWN);
    this.govern = this.kit.program(GOVERN);
    this.final = this.kit.program(FINAL);
    this.state = [this.kit.target(1, 1, "rgba16f", { filter: "nearest" }), this.kit.target(1, 1, "rgba16f", { filter: "nearest" })];
  }

  /** Forget the luminance shown so far: a new visualization starts from its own first frame. */
  public reset(): void {
    this.first = true;
  }

  private fit(width: number, height: number): void {
    const first = this.downs[0];
    const w = Math.max(2, Math.round(width / 2));
    const h = Math.max(2, Math.round(height / 2));
    if (first && first.width === w && first.height === h) return;
    for (const target of [...this.downs, ...this.ups, ...this.meters]) this.kit.deleteTarget(target);
    this.downs = [];
    this.ups = [];
    this.meters = [];
    let cw = w;
    let ch = h;
    for (let octave = 0; octave < OCTAVES; octave += 1) {
      this.downs.push(this.kit.target(cw, ch, "rgba16f"));
      if (octave < OCTAVES - 1) this.ups.push(this.kit.target(cw, ch, "rgba16f"));
      cw = Math.max(2, Math.round(cw / 2));
      ch = Math.max(2, Math.round(ch / 2));
    }
    // The meter: a quarter, a sixteenth, a sixty-fourth of the picture.
    let mw = Math.max(2, Math.round(width / 4));
    let mh = Math.max(2, Math.round(height / 4));
    for (let level = 0; level < 3; level += 1) {
      this.meters.push(this.kit.target(mw, mh, "r16f"));
      mw = Math.max(2, Math.round(mw / 4));
      mh = Math.max(2, Math.round(mh / 4));
    }
  }

  /**
   * `scene` (linear, HDR, any size) graded into `out` (null: the canvas). `dt` in seconds.
   */
  public render(scene: Target, out: Target | null, dt: number, options: PostOptions = {}): void {
    const kit = this.kit;
    this.fit(scene.width, scene.height);
    const downs = this.downs;
    const ups = this.ups;
    kit.draw(this.prefilter, downs[0]!, { uScene: scene, uTexel: [0.5 / scene.width, 0.5 / scene.height] });
    for (let octave = 1; octave < OCTAVES; octave += 1) {
      const source = downs[octave - 1]!;
      kit.draw(this.down, downs[octave]!, {
        uSource: source, uTexel: [1 / source.width, 1 / source.height], uThreshold: octave === 1 ? options.threshold ?? 0.55 : 0
      });
    }
    // The first octave is the picture itself at half size: the bloom starts at the second.
    const radius = options.bloomRadius ?? 0.75;
    let wide = downs[OCTAVES - 1]!;
    for (let octave = OCTAVES - 2; octave >= 1; octave -= 1) {
      const target = ups[octave]!;
      kit.draw(this.up, target, { uWide: wide, uNarrow: downs[octave]!, uTexel: [1 / wide.width, 1 / wide.height], uRadius: radius });
      wide = target;
    }
    const bloom = wide;
    const aspect = scene.width / scene.height;
    const grade = {
      uScene: scene, uBloom: bloom, uExposure: options.exposure ?? 1, uBloomAmount: options.bloom ?? 0.5,
      uSaturation: options.saturation ?? 1, uContrast: options.contrast ?? 0.25, uWhiten: options.whiten ?? 0.7,
      uVignette: options.vignette ?? 0.25, uAberration: options.aberration ?? 0,
      uAspect: aspect >= 1 ? [1, 1 / aspect] : [aspect, 1]
    };
    const meters = this.meters;
    kit.draw(this.meter, meters[0]!, { ...grade, uScene: downs[0]! });
    for (let level = 1; level < meters.length; level += 1) {
      const source = meters[level - 1]!;
      kit.draw(this.meterDown, meters[level]!, { uSource: source, uTexel: [1 / source.width, 1 / source.height] });
    }
    const smallest = meters[meters.length - 1]!;
    const step = Math.min(0.1, Math.max(0.001, dt));
    kit.draw(this.govern, this.state[1], {
      uMeter: smallest, uState: this.state[0], uMeterSize: [smallest.width, smallest.height],
      uRise: (options.gentle ? 0.45 : 6) * step, uFall: (options.gentle ? 0.22 : 0.3) * step, uFirst: this.first ? 1 : 0
    });
    this.state = [this.state[1], this.state[0]];
    this.first = false;
    this.frame += 1;
    kit.draw(this.final, out, { ...grade, uState: this.state[0], uGrain: options.grain ?? 0.6, uSeed: this.frame % 251 });
  }

  public destroy(): void {
    this.kit.destroy();
  }
}
