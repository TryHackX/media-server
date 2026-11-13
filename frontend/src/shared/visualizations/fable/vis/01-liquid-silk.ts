import { BICUBIC, COMMON } from "../core/glsl";
import { Kit, type Double, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Płynny jedwab — Liquid Silk.
 *
 * A stable-fluids solver (Stam's scheme: advect, force, project) carries a film whose
 * thickness the music lays down in stripes; the picture is that film lit as a surface. Colour
 * is thin-film interference of the thickness (summed over the spectrum, so high orders turn
 * pastel as oil and silk do), the folds are its gradient, the sheen follows the flow.
 *
 * Bass kicks fire the emitters (a push and a thick, glowing stripe), the bass level turns the
 * whole pool, mids stir small eddies, highs sharpen the glints.
 */

interface Look {
  /** Film thickness in nm at dye 0, and what dye 1 adds. */
  thickBase: number;
  thickRange: number;
  /** The dye the film settles to where nothing stirs it, and how uneven that is. */
  rest: number;
  restVariance: number;
  /** How quickly it settles there, per second. */
  settle: number;
  /** The least and most dye an emitter lays down. */
  inkLow: number;
  inkHigh: number;
  /** Colour under the film, linear. */
  base: [number, number, number];
  /** How much of the surface is film colour (the rest is the base, lit). */
  film: number;
  /** What is left of the first-order silver (1: all of it). */
  thinDim: number;
  /** Saturation of the interference colours. */
  vivid: number;
  bump: number;
  glow: [number, number, number];
  envLow: [number, number, number];
  envHigh: [number, number, number];
  key: [number, number, number];
  exposure: number;
  bloom: number;
}

const LOOKS: Record<string, Look> = {
  // First and second order colours on Newton's black: where the film is thin the water is dark.
  oil: {
    thickBase: -75, thickRange: 760, rest: 0.04, restVariance: 0.07, settle: 0.28, inkLow: 0.3, inkHigh: 1.0,
    base: [0.012, 0.02, 0.05], film: 0.96, thinDim: 0.1, vivid: 1.7, bump: 1.0,
    glow: [1.0, 0.75, 0.5], envLow: [0.2, 0.26, 0.42], envHigh: [0.8, 0.9, 1.0], key: [1.0, 0.96, 0.9], exposure: 1.0, bloom: 0.5
  },
  // The whole pool under film, every order at once: opal.
  opal: {
    thickBase: -20, thickRange: 760, rest: 0.45, restVariance: 0.42, settle: 0.07, inkLow: 0.08, inkHigh: 1.0,
    base: [0.012, 0.02, 0.05], film: 0.96, thinDim: 0.55, vivid: 1.75, bump: 1.2,
    glow: [1.0, 0.8, 0.9], envLow: [0.2, 0.24, 0.4], envHigh: [0.8, 0.88, 1.0], key: [1.0, 0.96, 0.9], exposure: 0.95, bloom: 0.4
  },
  // The gold-to-magenta stretch of the first order only.
  ember: {
    thickBase: -62, thickRange: 352, rest: 0.04, restVariance: 0.07, settle: 0.25, inkLow: 0.48, inkHigh: 1.0,
    base: [0.05, 0.008, 0.004], film: 0.95, thinDim: 0.12, vivid: 1.9, bump: 1.1,
    glow: [1.0, 0.45, 0.12], envLow: [0.22, 0.05, 0.03], envHigh: [0.95, 0.42, 0.16], key: [1.0, 0.8, 0.5], exposure: 1.3, bloom: 0.65
  },
  // Blue through green, deep.
  abyss: {
    thickBase: -72, thickRange: 560, rest: 0.04, restVariance: 0.07, settle: 0.25, inkLow: 0.64, inkHigh: 1.0,
    base: [0.0, 0.02, 0.04], film: 0.96, thinDim: 0.1, vivid: 1.9, bump: 0.9,
    glow: [0.4, 0.9, 1.0], envLow: [0.12, 0.3, 0.4], envHigh: [0.6, 0.95, 1.0], key: [0.8, 1.0, 1.0], exposure: 1.25, bloom: 0.55
  }
};

const EMITTERS = 6;

const ADVECT_VELOCITY = /* glsl */ `
uniform sampler2D uVel;
uniform float uStep, uAspect, uKeep;
void main() {
  vec2 v = texture(uVel, vUv).xy;
  fragColor = vec4(texture(uVel, vUv - uStep * v * vec2(1.0 / uAspect, 1.0)).xy * uKeep, 0.0, 1.0);
}
`;

const CURL = /* glsl */ `
uniform sampler2D uVel;
uniform vec2 uTexel;
void main() {
  float l = texture(uVel, vUv - vec2(uTexel.x, 0.0)).y, r = texture(uVel, vUv + vec2(uTexel.x, 0.0)).y;
  float b = texture(uVel, vUv - vec2(0.0, uTexel.y)).x, t = texture(uVel, vUv + vec2(0.0, uTexel.y)).x;
  fragColor = vec4(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0);
}
`;

const FORCE = COMMON + /* glsl */ `
uniform sampler2D uVel, uCurl;
uniform vec2 uTexel;
uniform float uStep, uAspect, uT, uTurbulence, uConfine, uSwirl, uRadius;
uniform vec4 uEmit[${EMITTERS}];
void main() {
  vec2 v = texture(uVel, vUv).xy;
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  // Vorticity confinement: what the grid smears, pushed back into the eddies.
  float cl = abs(texture(uCurl, vUv - vec2(uTexel.x, 0.0)).r), cr = abs(texture(uCurl, vUv + vec2(uTexel.x, 0.0)).r);
  float cb = abs(texture(uCurl, vUv - vec2(0.0, uTexel.y)).r), ct = abs(texture(uCurl, vUv + vec2(0.0, uTexel.y)).r);
  float c = texture(uCurl, vUv).r;
  vec2 grad = vec2(cr - cl, ct - cb);
  grad /= length(grad) + 1e-4;
  v += uConfine * uStep * c * vec2(grad.y, -grad.x);
  // The emitters' pushes.
  for (int i = 0; i < ${EMITTERS}; i++) {
    vec2 d = p - uEmit[i].xy;
    v += uEmit[i].zw * exp(-dot(d, d) / (uRadius * uRadius)) * uStep;
  }
  // Small eddies: the curl of a drifting noise field.
  vec2 q = p * 3.2 + vec2(0.0, uT * 0.13);
  float e = 0.02;
  float n0 = snoise3(vec3(q, uT * 0.21)), nx = snoise3(vec3(q + vec2(e, 0.0), uT * 0.21)), ny = snoise3(vec3(q + vec2(0.0, e), uT * 0.21));
  v += vec2(ny - n0, -(nx - n0)) / e * uTurbulence * uStep;
  // The whole pool turning, strongest at mid radius.
  float r = length(p);
  v += vec2(-p.y, p.x) * uSwirl * exp(-r * r * 3.0) * uStep;
  fragColor = vec4(v, 0.0, 1.0);
}
`;

const DIVERGENCE = /* glsl */ `
uniform sampler2D uVel;
uniform vec2 uTexel;
void main() {
  vec2 c = texture(uVel, vUv).xy;
  float l = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x, r = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uVel, vUv - vec2(0.0, uTexel.y)).y, t = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
  // Walls: nothing flows through the frame's edge.
  if (vUv.x - uTexel.x < 0.0) l = -c.x;
  if (vUv.x + uTexel.x > 1.0) r = -c.x;
  if (vUv.y - uTexel.y < 0.0) b = -c.y;
  if (vUv.y + uTexel.y > 1.0) t = -c.y;
  fragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}
`;

const PRESSURE = /* glsl */ `
uniform sampler2D uPressure, uDivergence;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r, r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).r, t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).r;
  fragColor = vec4((l + r + b + t - texture(uDivergence, vUv).r) * 0.25, 0.0, 0.0, 1.0);
}
`;

const SCALE = /* glsl */ `
uniform sampler2D uSource;
uniform float uKeep;
void main() { fragColor = texture(uSource, vUv) * uKeep; }
`;

const PROJECT = /* glsl */ `
uniform sampler2D uVel, uPressure;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r, r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).r, t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).r;
  fragColor = vec4(texture(uVel, vUv).xy - 0.5 * vec2(r - l, t - b), 0.0, 1.0);
}
`;

/** The film: r thickness (0–1), g tint, b glow. Carried by the flow, fed by the emitters. */
const DYE = COMMON + BICUBIC + /* glsl */ `
uniform sampler2D uDye, uVel;
uniform vec2 uVelSize;
uniform float uStep, uAspect, uT, uRadius, uSeed, uRest, uRestVariance, uSettle;
uniform vec4 uEmit[${EMITTERS}];
uniform vec4 uInk[${EMITTERS}];
void main() {
  vec2 v = bicubic(uVel, vUv, uVelSize).xy;
  vec4 d = texture(uDye, vUv - uStep * v * vec2(1.0 / uAspect, 1.0));
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  // The film at rest is never flat: it settles toward a slow, uneven depth.
  float rest = max(0.0, uRest + uRestVariance * fbm(p * 1.6 + vec2(uSeed * 7.0, uT * 0.02)));
  d.r = mix(d.r, rest, 1.0 - exp(-uStep * uSettle));
  d.g = mix(d.g, 0.5, 1.0 - exp(-uStep * 0.08));
  d.b *= exp(-uStep / 0.85);
  for (int i = 0; i < ${EMITTERS}; i++) {
    vec2 e = p - uEmit[i].xy;
    float w = exp(-dot(e, e) / (uRadius * uRadius * 0.55));
    float lay = saturate(w * uInk[i].w * uStep);
    d.r = mix(d.r, uInk[i].x, lay);
    d.g = mix(d.g, uInk[i].y, lay);
    d.b += w * uInk[i].z * uStep;
  }
  fragColor = vec4(d.rgb, 1.0);
}
`;

/** Interference colours by thickness (x, 0–1400 nm) and the cosine of the angle in the film (y). */
const FILM_TABLE = COMMON + /* glsl */ `
void main() { fragColor = vec4(thinFilm(vUv.x * 1400.0, vUv.y), 1.0); }
`;

const SHADE = COMMON + BICUBIC + /* glsl */ `
uniform sampler2D uDye, uVel, uFilm;
uniform vec2 uDyeSize, uVelSize;
uniform float uAspect, uThickBase, uThickRange, uFilmAmount, uVivid, uBump, uSparkle, uT, uPulse, uThinDim;
uniform vec3 uBase, uGlow, uEnvLow, uEnvHigh, uKey, uKeyDir;
vec3 environment(vec3 r) {
  vec3 sky = mix(uEnvLow, uEnvHigh, smoothstep(-0.5, 0.7, r.y));
  // A soft box overhead, seen where the surface tilts toward it.
  sky += uKey * 1.4 * pow(saturate(dot(r, uKeyDir)), 18.0);
  return sky;
}
void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  vec4 d = bicubic(uDye, vUv, uDyeSize);
  vec2 texel = 1.5 / uDyeSize;
  float hl = texture(uDye, vUv - vec2(texel.x, 0.0)).r, hr = texture(uDye, vUv + vec2(texel.x, 0.0)).r;
  float hb = texture(uDye, vUv - vec2(0.0, texel.y)).r, ht = texture(uDye, vUv + vec2(0.0, texel.y)).r;
  vec2 grad = vec2(hr - hl, ht - hb) * uDyeSize.y / 3.0;
  // Fine weave along the flow: what makes it cloth rather than glass.
  vec2 flow = bicubic(uVel, vUv, uVelSize).xy;
  float speed = length(flow);
  vec2 along = flow / (speed + 1e-4);
  vec2 across = vec2(-along.y, along.x);
  float weave = snoise(vec2(dot(p, across) * 150.0, dot(p, along) * 9.0) + d.r * 14.0);
  grad += across * weave * 0.9 * smoothstep(0.0, 0.25, speed) * uSparkle;
  vec3 n = normalize(vec3(-grad * 0.012 * uBump, 1.0));
  vec3 view = normalize(vec3(-p * 0.55, 1.0));
  float cosV = saturate(dot(n, view));
  float cosFilm = sqrt(1.0 - (1.0 - cosV * cosV) / (1.38 * 1.38));
  float thickness = max(0.0, uThickBase + uThickRange * d.r + 110.0 * (d.g - 0.5) * smoothstep(0.0, 0.3, d.r));
  vec3 film = texture(uFilm, vec2(thickness / 1400.0, cosFilm)).rgb;
  film = max(mix(vec3(luma(film)), film, uVivid), 0.0);
  // The first order's silver is held down, so thin film reads as dark water and the colours stand on it.
  float body = smoothstep(60.0, 250.0, thickness);
  film *= mix(uThinDim, 1.0, body);
  vec3 r = reflect(-view, n);
  vec3 env = environment(r);
  float fresnel = 0.03 + 0.97 * pow(1.0 - cosV, 5.0);
  vec3 lit = mix(uEnvLow, uEnvHigh, 0.5 + 0.5 * n.y) + uKey * 0.5 * saturate(dot(n, uKeyDir));
  vec3 color = mix(uBase * lit, film * (0.45 + 0.75 * env), uFilmAmount * mix(0.55, 1.0, body));
  color += env * fresnel * 0.35;
  // Glints: a tight highlight of the key light, and a silk sheen stretched across the flow.
  vec3 halfway = normalize(uKeyDir + view);
  float nh = saturate(dot(n, halfway));
  color += uKey * (pow(nh, 260.0) * 6.0 + pow(nh, 30.0) * 0.12) * (0.5 + uSparkle) * (0.3 + film);
  float th = dot(normalize(vec3(along, 0.0) - n * dot(n, vec3(along, 0.0)) + 1e-5), halfway);
  color += film * uKey * pow(sqrt(saturate(1.0 - th * th)), 90.0) * 0.5 * smoothstep(0.02, 0.4, speed);
  // The kicks' light, carried and thinned by the flow.
  color += (uGlow * 0.18 + film * 1.1) * d.b * (1.0 + uPulse);
  fragColor = vec4(max(color, 0.0), 1.0);
}
`;

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const look = LOOKS[preset] ?? LOOKS.oil!;
  const random = seededRandom(seed * 7919 + 13);
  const programs = {
    advect: kit.program(ADVECT_VELOCITY), curl: kit.program(CURL), force: kit.program(FORCE), divergence: kit.program(DIVERGENCE),
    pressure: kit.program(PRESSURE), scale: kit.program(SCALE), project: kit.program(PROJECT), dye: kit.program(DYE),
    table: kit.program(FILM_TABLE), shade: kit.program(SHADE)
  };
  const film = kit.target(512, 64, "rgba16f");
  let filmDrawn = false;
  let velocity: Double | null = null;
  let pressure: Double | null = null;
  let curl: Target | null = null;
  let divergence: Target | null = null;
  let dye: Double | null = null;
  let scene: Target | null = null;

  // What the seed decides: how the emitters stand and turn, where the light is, the film's offset.
  const turn = random() < 0.5 ? -1 : 1;
  const phase = random() * Math.PI * 2;
  const ring = 0.27 + random() * 0.08;
  const squash = 0.75 + random() * 0.2;
  const lean = 0.7 + random() * 0.5;
  const thickShift = (random() - 0.5) * 90;
  const keyAngle = random() * Math.PI * 2;
  // The key light is low: the surface at rest sends none of it to the eye, a fold facing it glints.
  const keyDir = [Math.cos(keyAngle) * 0.9, Math.sin(keyAngle) * 0.9, 0.42];
  const keyLength = Math.hypot(keyDir[0]!, keyDir[1]!, keyDir[2]!);
  const emit = new Float32Array(EMITTERS * 4);
  const ink = new Float32Array(EMITTERS * 4);
  const fired = new Float32Array(EMITTERS);
  let stripe = random() * 10;

  return {
    render(frame: FvFrame): void {
      const { audio } = frame;
      const f = audio.features;
      if (!filmDrawn) {
        // With the first frame, not at creation: nothing waits for a program still compiling.
        kit.draw(programs.table, film, {});
        filmDrawn = true;
      }
      const aspect = frame.width / frame.height;
      const [workWidth, workHeight] = workSize(frame);
      const simHeight = Math.round(192 * Math.max(0.6, frame.scale));
      const simWidth = Math.round(simHeight * aspect);
      velocity = kit.fitDouble(velocity, simWidth, simHeight, "rg16f", {}, true);
      pressure = kit.fitDouble(pressure, simWidth, simHeight, "r16f", {}, true);
      curl = kit.fit(curl, simWidth, simHeight, "r16f");
      divergence = kit.fit(divergence, simWidth, simHeight, "r16f");
      const fresh = !dye;
      dye = kit.fitDouble(dye, workWidth, workHeight, "rgba16f", {}, true);
      scene = kit.fit(scene, workWidth, workHeight, "rgba16f");
      if (fresh) kit.clear(dye.read, look.rest, 0.5, 0, 1);
      const step = Math.min(1 / 30, frame.dt);
      const texel = [1 / simWidth, 1 / simHeight];

      // The emitters: on a ring that turns with the music, each pushing inward and aside.
      // A kick fires two of them (which two moves on with every beat); all of them trickle.
      stripe += step * (1.1 + 2.4 * f.level);
      const reach = Math.min(aspect * 0.5 - 0.08, ring * Math.max(1, aspect * 0.72));
      for (let index = 0; index < EMITTERS; index += 1) {
        const chosen = (f.beat + index * 2) % EMITTERS < 2 ? 1 : 0;
        fired[index] = fired[index]! + (chosen * f.kick - fired[index]!) * Math.min(1, step * 30);
        const angle = phase + index * (Math.PI * 2 / EMITTERS) + turn * f.flow * 0.11 + 0.35 * Math.sin(f.time * 0.23 + index * 1.7);
        const x = Math.cos(angle) * reach;
        const y = Math.sin(angle) * ring * squash;
        const aim = angle + Math.PI + turn * lean * (index % 2 ? 1 : -0.6);
        const push = 0.5 + 1.4 * f.bass * f.presence + 9.5 * fired[index]!;
        emit.set([x, y, Math.cos(aim) * push, Math.sin(aim) * push], index * 4);
        // Ink: the thickness laid down swings as the music goes, so each jet is striped.
        const swing = 0.5 + 0.5 * Math.sin(stripe * 2.3 + index * 2.1) * (0.6 + 0.4 * f.mid);
        const thickness = look.inkLow + (look.inkHigh - look.inkLow) * swing;
        const tint = 0.5 + 0.5 * Math.sin(index * 2.4 + f.flow * 0.07 + phase);
        ink.set([thickness, tint, 2.4 * fired[index]! + 0.1 * f.high, 0.9 + 16 * fired[index]! + 2.5 * f.bass * f.presence], index * 4);
      }

      const common = { uStep: step, uAspect: aspect, uTexel: texel, uT: f.time, uRadius: 0.075 + 0.02 * f.bass };
      kit.draw(programs.advect, velocity.write, { ...common, uVel: velocity.read, uKeep: Math.exp(-step * 0.35) });
      velocity.swap();
      kit.draw(programs.curl, curl, { ...common, uVel: velocity.read });
      kit.draw(programs.force, velocity.write, {
        ...common, uVel: velocity.read, uCurl: curl, uEmit: emit, uTurbulence: 0.16 + 0.75 * f.mid * f.presence,
        uConfine: 5.5, uSwirl: turn * (0.25 + 1.3 * f.bass * f.presence)
      });
      velocity.swap();
      kit.draw(programs.divergence, divergence, { ...common, uVel: velocity.read });
      kit.draw(programs.scale, pressure.write, { uSource: pressure.read, uKeep: 0.8 });
      pressure.swap();
      for (let iteration = 0; iteration < 22; iteration += 1) {
        kit.draw(programs.pressure, pressure.write, { ...common, uPressure: pressure.read, uDivergence: divergence });
        pressure.swap();
      }
      kit.draw(programs.project, velocity.write, { ...common, uVel: velocity.read, uPressure: pressure.read });
      velocity.swap();

      kit.draw(programs.dye, dye.write, {
        ...common, uDye: dye.read, uVel: velocity.read, uVelSize: [simWidth, simHeight], uEmit: emit, uInk: ink, uSeed: seed % 17,
        uRest: look.rest, uRestVariance: look.restVariance, uSettle: look.settle
      });
      dye.swap();

      kit.draw(programs.shade, scene, {
        uDye: dye.read, uVel: velocity.read, uFilm: film, uDyeSize: [workWidth, workHeight], uVelSize: [simWidth, simHeight],
        uAspect: aspect, uThickBase: look.thickBase + thickShift + 60 * Math.sin(f.flow * 0.05), uThickRange: look.thickRange,
        uFilmAmount: look.film, uVivid: look.vivid, uBump: look.bump * (0.85 + 0.5 * f.bass), uSparkle: 0.35 + 0.9 * f.high + 0.6 * f.hat,
        uT: f.time, uPulse: frame.gentle ? 0 : f.kick, uBase: look.base, uGlow: look.glow, uEnvLow: look.envLow, uEnvHigh: look.envHigh,
        uThinDim: look.thinDim, uKey: look.key, uKeyDir: keyDir.map((value) => value / keyLength)
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom * 0.7, bloomRadius: 0.55, threshold: 1.0, vignette: 0.35, contrast: 0.45,
        saturation: 1.12, gentle: frame.gentle
      });
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "liquid-silk",
  order: 1,
  kind: "vivid",
  labelPl: "Płynny jedwab",
  labelEn: "Liquid Silk",
  descriptionPl: "Ciecz, którą muzyka maluje opalizującym filmem — bas wstrzykuje pasma, a światło ślizga się po fałdach jak po jedwabiu.",
  usesSource: false,
  gentleByDefault: false,
  presets: [
    { id: "oil", labelPl: "Oliwa na wodzie", labelEn: "Oil on Water" },
    { id: "opal", labelPl: "Opal", labelEn: "Opal" },
    { id: "ember", labelPl: "Żar", labelEn: "Ember" },
    { id: "abyss", labelPl: "Głębia", labelEn: "Abyss" }
  ],
  create
};
