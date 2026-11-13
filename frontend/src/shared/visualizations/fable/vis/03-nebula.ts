import { BICUBIC, COMMON } from "../core/glsl";
import { Kit, type Double, type Program, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Mgławica miliona iskier — Million-Spark Nebula.
 *
 * A million particles whose positions and velocities live in float textures. Each frame they
 * take the velocity of a flow made of three things: the form's own large motion (a galaxy's
 * rotation, a nebula's wind, a vortex ring, the lines of a dipole), eddies read from a baked
 * 3D texture of divergence-free noise (the curl of a periodic potential), and a pull toward
 * the ridges of a second noise, which is what gathers them into veils and filaments. They are
 * born into the form's shape, live some seconds and are born again, so the shape renews.
 *
 * They are drawn as additive points through a thin lens: energy is conserved, so a point out
 * of focus is a wide, faint disc and a dense place glows without clipping. A short temporal
 * average lays silk over the motion and takes the shimmer out of a million small points.
 *
 * Kicks send a shell out from the core: a ripple of displacement that travels through the
 * cloud and lights the particles it passes. Bass turns the whole, mids stir the eddies, highs
 * make single sparks flare.
 */

type Rgb = readonly [number, number, number];

/** One kind of particle in a form: where it is born is the form's GLSL, the rest is here. */
interface Family {
  /** Its share of the particles. */
  share: number;
  /** The light a particle gives the gas (the soft layer every particle is drawn into) and its puff's size in world units. */
  glow: number;
  puff: number;
  /** The light of it as a spark (the sharp layer the brighter half is drawn into). */
  spark: number;
  /** How far the eddies carry it, and how strongly it gathers on the ridges. */
  turb: number;
  gather: number;
  /** Seconds it lives (about), and seconds it takes to pick up the flow's velocity. */
  life: number;
  drag: number;
  /** The share of it that flares on the highs, and how much a passing shell lights it. */
  sparkle: number;
  heat: number;
  cold: Rgb;
  warm: Rgb;
}

/** What a form's GLSL reads as uA and uB, worked out each frame. */
interface Pulse {
  /** The swirl's angle so far. */
  turned: number;
  kick: number;
  bass: number;
}

interface Form {
  /** GLSL of the simulation: `vec3 birth(int fam, vec4 tr, inout uint s)` and `vec3 drift(vec3 p, int fam, vec4 tr)`. */
  sim: string;
  /** GLSL of the drawing: `vec2 tone(vec3 p, int fam, vec4 tr, float age)` — x: cold to warm, y: light. */
  tone: string;
  families: readonly [Family, Family, Family, Family, Family];
  /** What `seed` decides, and from it the form's two parameter vectors for a frame. */
  shape(random: () => number): (pulse: Pulse) => { a: readonly number[]; b: readonly number[] };
  /** The colour of a particle a shell has just passed. */
  hot: Rgb;
  hazeA: Rgb;
  hazeB: Rgb;
  /** Where the camera looks, where the shells start. */
  centre: Rgb;
  core: Rgb;
  distance: number;
  elevation: number;
  swing: number;
  /** The camera's roll in a wide frame and in a tall one. */
  rollWide: number;
  rollTall: number;
  swirl: number;
  turbulence: number;
  gather: number;
  inflow: number;
  /** How much of the swirl the eddies turn with, and how fine they are (1: cells about the cloud's own size). */
  spin: number;
  grain: number;
  /** Particles nearer the core than this are born again (0: none). */
  inner: number;
  shellSpeed: number;
  /** A shell's displacement, its net push, its light, and the radius it has faded by. */
  ripple: number;
  push: number;
  flash: number;
  reach: number;
  /** The far limit of the circle of confusion, as a tangent. */
  lens: number;
  exposure: number;
  bloom: number;
}

const SIDE = 1024;
const TOTAL = SIDE * SIDE;
const FIELD = 64;
const SHELLS = 4;
/** Particles per pixel of the working picture: a million at 1920 × 1080. */
const DENSITY = TOTAL / (1920 * 1080);
const TAN = 0.4;
/** How far the cloud's colour is deepened where it is composed (1: as summed). */
const VIVID = 1.25;

/** Hashes on integers (float hashes band at a million ids), the particle's traits, its family. */
const PARTICLE = /* glsl */ `
uniform float uCum[5];
uint mixBits(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(inout uint s) { s = mixBits(s + 0x9e3779b9u); return float(s >> 8) * (1.0 / 16777216.0); }
vec2 gauss(inout uint s) {
  float a = rnd(s) * TAU;
  float r = sqrt(-2.0 * log(max(rnd(s), 1e-6)));
  return r * vec2(cos(a), sin(a));
}
// Four numbers a particle keeps for life: x its family, y its brightness and tint, z its sparkle, w its pace.
vec4 traits(uint id) {
  uint s = id * 2654435761u + 0x51ed270bu;
  float a = rnd(s); float b = rnd(s); float c = rnd(s); float d = rnd(s);
  return vec4(a, b, c, d);
}
int familyOf(float x) {
  int f = 0;
  for (int i = 0; i < 4; i++) { if (x >= uCum[i]) f = i + 1; }
  return f;
}
`;

/**
 * The two fields, one layer of the 3D textures at a time. Periodic gradient noise (the lattice
 * wraps), so the textures repeat without a seam; the curl of a three-part potential has no
 * divergence, and the second noise is kept with its gradient, to pull particles toward a level of it.
 */
const BAKE = COMMON + /* glsl */ `
uniform float uLayer, uSalt;
float lattice(vec3 p, float period, float salt) {
  vec3 i = floor(p), f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float sum = 0.0;
  for (int c = 0; c < 8; c++) {
    vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float(c >> 2));
    vec3 g = hash33(mod(i + o, period) + salt) * 2.0 - 1.0;
    vec3 w = mix(1.0 - u, u, o);
    sum += dot(g, f - o) * w.x * w.y * w.z;
  }
  return sum;
}
vec3 potential(vec3 q) {
  return vec3(lattice(q * 4.0, 4.0, uSalt + 11.0), lattice(q * 4.0, 4.0, uSalt + 23.0), lattice(q * 4.0, 4.0, uSalt + 37.0))
       + 0.5 * vec3(lattice(q * 8.0, 8.0, uSalt + 41.0), lattice(q * 8.0, 8.0, uSalt + 53.0), lattice(q * 8.0, 8.0, uSalt + 67.0));
}
float ridge(vec3 q) { return lattice(q * 3.0, 3.0, uSalt + 71.0) + 0.5 * lattice(q * 6.0, 6.0, uSalt + 83.0); }
void main() {
  vec3 q = vec3(vUv, uLayer);
  vec2 e = vec2(0.5 / ${FIELD}.0, 0.0);
  vec3 dx = potential(q + e.xyy) - potential(q - e.xyy);
  vec3 dy = potential(q + e.yxy) - potential(q - e.yxy);
  vec3 dz = potential(q + e.yyx) - potential(q - e.yyx);
  vec3 curl = vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) / (2.0 * e.x);
  float s = ridge(q);
  vec3 grad = vec3(ridge(q + e.xyy) - ridge(q - e.xyy), ridge(q + e.yxy) - ridge(q - e.yxy), ridge(q + e.yyx) - ridge(q - e.yyx)) / (2.0 * e.x);
  fragColor = vec4(curl * 0.11, 1.0);
  fragColor1 = vec4(grad * 0.25, s * 1.6);
}
`;

/** One step of every particle: position and age in the first texture, velocity and heat in the second. */
function updateSource(form: Form): string {
  return COMMON + /* glsl */ `
precision highp sampler3D;
uniform sampler2D uPos, uVel;
uniform sampler3D uCurl, uRidge;
uniform float uStep, uInit, uSwirl, uTurb, uGather, uInflow, uSpin, uGrain, uBound, uInner, uShellSpeed, uPush, uHalf;
uniform int uNonce;
uniform vec3 uCore, uDriftA, uDriftB;
uniform vec4 uA, uB;
uniform vec4 uShell[${SHELLS}];
uniform vec4 uFam[5];
${PARTICLE}
// The eddies (no divergence: they stir and never thin or thicken the cloud) and the pull toward the ridges (which does).
vec3 field(vec3 p, float band, out vec3 pull) {
  float c = cos(uSpin), s = sin(uSpin);
  vec3 q = vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x) * uGrain;
  vec3 big = texture(uCurl, q * 0.17 + uDriftA).xyz;
  vec3 fine = texture(uCurl, q.yzx * 0.43 + uDriftB).xyz.zxy;
  // Each particle is drawn to a level of its own near zero: a veil with a bright spine, not a razor.
  vec4 wide = texture(uRidge, q.zxy * 0.29 - uDriftA);
  vec4 narrow = texture(uRidge, q * 0.61 + uDriftB.zxy);
  vec3 g = (band - wide.w) * wide.xyz.yzx + 0.6 * (-band - narrow.w) * narrow.xyz;
  vec3 v = big + 0.6 * fine;
  pull = vec3(c * g.x - s * g.z, g.y, s * g.x + c * g.z);
  return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
}
${form.sim}
void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  uint id = uint(texel.y * ${SIDE} + texel.x);
  vec4 P = texelFetch(uPos, texel, 0);
  vec4 V = texelFetch(uVel, texel, 0);
  vec4 tr = traits(id);
  int fam = familyOf(tr.x);
  vec4 law = uFam[fam];
  vec3 p = P.xyz, v = V.xyz;
  float age = P.w + uStep / (law.z * (0.55 + 0.9 * tr.w));
  float heat = V.w;
  vec3 rel = p - uCore;
  float r = length(rel);
  if (uInit > 0.5 || age >= 1.0 || r > uBound || r < uInner || isnan(r)) {
    uint s = mixBits(id ^ (uint(uNonce) * 0x9e3779b1u));
    p = birth(fam, tr, s);
    v = drift(p, fam, tr);
    age = uInit > 0.5 ? rnd(s) : fract(age);
    heat = 0.0;
    rel = p - uCore;
    r = length(rel);
  }
  vec3 pull;
  float band = tr.w - 0.5;
  vec3 eddy = field(p, 5.0 * band * band * band, pull);
  vec3 want = drift(p, fam, tr) + eddy * (uTurb * law.x) + pull * (uGather * law.y);
  v += (want - v) * (1.0 - exp(-uStep / law.w));
  // The shells: each a bump of outward displacement travelling outward, so what it passes
  // moves out and back and the cloud is denser on its leading side; and a small net push.
  vec3 away = rel / max(r, 1e-4);
  vec3 shock = vec3(0.0);
  float lit = 0.0;
  for (int i = 0; i < ${SHELLS}; i++) {
    float d = (r - uShell[i].x) * uShell[i].z;
    float g = exp(-d * d);
    shock += away * (uShell[i].y * g * (2.0 * d * uShellSpeed * uShell[i].z + uPush));
    lit += uShell[i].w * g;
  }
  p += (v + shock) * uStep;
  // The light a shell leaves dies in a sixth of a second: a band travelling with it, not a cloud lit from kick to kick.
  heat = min(1.5, heat * exp(-uStep / 0.16) + lit * uStep * 12.0);
  if (uHalf > 0.5) {
    // Half-float state: a slow particle's step is under the format's grain, so it is rounded
    // up or down by chance and on average the step is taken.
    uint s = mixBits(id * 31u + uint(uNonce));
    vec3 grain = exp2(floor(log2(max(abs(p), 1e-4))) - 10.0);
    float a = rnd(s); float b = rnd(s); float c = rnd(s);
    p += (vec3(a, b, c) - 0.5) * grain;
  }
  fragColor = vec4(p, age);
  fragColor1 = vec4(v, heat);
}
`;
}

/**
 * A particle as a point: where the lens puts it, how wide, how bright. Drawn twice: every
 * particle as a soft puff into the gas (a smaller picture, so the glow is smooth), and the
 * brighter half as sparks into the sharp one.
 */
function pointVertex(form: Form): string {
  return COMMON + /* glsl */ `
uniform sampler2D uPos, uVel;
uniform mat3 uCam;
uniform vec3 uEye, uHot, uCore;
uniform vec2 uProj;
uniform float uGas, uFocus, uLens, uScalePx, uMinSize, uMaxSize, uGain, uTime, uSparkle, uShimmer;
uniform vec4 uA, uB;
uniform vec4 uLook[5];
uniform float uSpark[5];
uniform vec3 uCold[5];
uniform vec3 uWarm[5];
out vec4 vColor;
out vec2 vUv;
${PARTICLE}
${form.tone}
void main() {
  int index = gl_VertexID;
  ivec2 texel = ivec2(index & ${SIDE - 1}, index >> 10);
  vec4 tr = traits(uint(index));
  vUv = vec2(0.0);
  vColor = vec4(0.0);
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  // The sparks are the brighter half.
  float pick = tr.y * 2.0 - 1.0;
  if (uGas < 0.5 && pick <= 0.0) return;
  vec4 P = texelFetch(uPos, texel, 0);
  vec4 V = texelFetch(uVel, texel, 0);
  int fam = familyOf(tr.x);
  vec4 look = uLook[fam];
  vec3 view = (P.xyz - uEye) * uCam;
  float z = view.z;
  float age = P.w;
  // Born and gone softly.
  float envelope = smoothstep(0.0, 0.07, age) * (1.0 - smoothstep(0.72, 1.0, age));
  if (z < 0.12 || envelope <= 0.0) return;
  vec2 ndc = view.xy * uProj / z;
  float edge = max(abs(ndc.x), abs(ndc.y));
  if (edge > 1.0) return;
  vec2 shade = tone(P.xyz, fam, tr, age);
  float heat = V.w * look.w;
  vec3 colour = mix(uCold[fam], uWarm[fam], saturate(shade.x));
  // The thin lens: away from the focal plane a point is a disc.
  float coc = uLens * abs(z - uFocus) / z;
  float energy, want;
  if (uGas > 0.5) {
    energy = look.x;
    want = sqrt(uMinSize * uMinSize + coc * coc + sq(look.y * uScalePx / z));
  } else {
    // A share of each family flares for a moment, each spark at its own pace; how hard is the music's.
    float phase = fract(tr.z * 61.0 + uTime * (0.12 + 0.2 * tr.w));
    float flare = tr.z < look.z ? smoothstep(0.0, 0.015, phase) * exp(-phase * 24.0) : 0.0;
    // Few bright, many faint, as stars are.
    float p3 = pick * pick * pick;
    energy = uSpark[fam] * (0.012 + 6.2 * p3 * p3) * (1.0 + flare * uSparkle);
    energy *= 1.0 + uShimmer * sin(uTime * (4.0 + 9.0 * tr.w) + tr.z * 90.0);
    want = sqrt(uMinSize * uMinSize + coc * coc + sq(3.0 * flare));
    // A spark is whiter than the gas it sits in.
    colour = mix(colour, vec3(dot(colour, vec3(0.4))), 0.08);
    colour = mix(colour, uHot, 0.35 * flare);
  }
  // A point source's light falls with the square of its distance; the cloud's surface brightness does not.
  energy *= shade.y * envelope * (1.0 + 2.2 * heat) * uGain * sq(uFocus / z) * (1.0 - smoothstep(0.985, 1.0, edge));
  colour = mix(colour, uHot, 0.22 * saturate(heat));
  float radius = 0.5 * want;
  vec3 light = colour * energy / (radius * radius);
  if (max(light.r, max(light.g, light.b)) < 3e-4) return;
  vColor = vec4(light, uGas > 0.5 ? 0.0 : smoothstep(4.5, 10.0, coc));
  gl_PointSize = min(want, uMaxSize);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;
}

/**
 * A point's footprint: a Gaussian wide enough to be sampled without shimmer in focus, a disc
 * with a slightly brighter rim out of it. Both hold the same light over their area.
 */
const POINT_FRAGMENT = /* glsl */ `
in vec4 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float soft = max(0.0, exp(-2.5 * r2) - 0.0821) / 0.8956;
  float disc = smoothstep(1.0, 0.74, sqrt(r2)) * (0.72 + 0.5 * r2) / 2.25;
  fragColor = vec4(vColor.rgb * mix(soft, disc, vColor.a), 1.0);
}
`;

const FADE = /* glsl */ `
uniform sampler2D uPrev;
uniform float uKeep;
void main() { fragColor = vec4(texture(uPrev, vUv).rgb * uKeep, 1.0); }
`;

/** The cloud over space: far stars on a cube of cells and a faint haze, both turning with the camera. */
const COMPOSE = COMMON + BICUBIC + /* glsl */ `
precision highp sampler3D;
uniform sampler2D uCloud, uGasLayer;
uniform vec2 uGasSize;
uniform sampler3D uRidge;
uniform mat3 uCam;
uniform vec2 uLensXY;
uniform float uPixel, uTime, uShimmer, uSalt, uVivid;
uniform vec3 uHazeA, uHazeB;
vec3 stars(vec3 dir, float cells, float salt, float size) {
  vec3 a = abs(dir);
  float m = max(a.x, max(a.y, a.z));
  vec2 uv;
  float face;
  if (a.x == m) { uv = dir.yz / a.x; face = dir.x > 0.0 ? 1.0 : 2.0; }
  else if (a.y == m) { uv = dir.zx / a.y; face = dir.y > 0.0 ? 3.0 : 4.0; }
  else { uv = dir.xy / a.z; face = dir.z > 0.0 ? 5.0 : 6.0; }
  vec2 cell = floor(uv * cells);
  vec3 h = hash33(vec3(cell + 200.0, face * 13.0 + salt));
  vec2 at = (cell + 0.25 + 0.5 * h.xy) / cells;
  // The cube's stretch taken out, near enough: a star is as wide at a face's corner as at its middle.
  float d = length(uv - at) / pow(1.0 + dot(uv, uv), 0.75);
  float sigma = uPixel * size;
  float tint = fract(h.z * 91.7);
  vec3 colour = mix(vec3(0.62, 0.75, 1.0), vec3(1.0, 0.8, 0.6), smoothstep(0.35, 0.95, tint));
  float twinkle = 1.0 + uShimmer * sin(uTime * (3.0 + 6.0 * h.x) + h.y * 40.0);
  return colour * pow(h.z, 14.0) * exp(-d * d / (sigma * sigma)) * twinkle;
}
void main() {
  vec3 dir = normalize(uCam * vec3((vUv * 2.0 - 1.0) * uLensXY, 1.0));
  vec3 sky = stars(dir, 64.0, uSalt, 0.85) * 1.6 + stars(dir, 23.0, uSalt + 5.0, 1.25) * 5.0;
  float n1 = texture(uRidge, dir * 0.27 + uSalt * 0.13).w;
  float n2 = texture(uRidge, dir.zxy * 0.63 + 0.41).w;
  sky += uHazeA * sq(smoothstep(-0.5, 1.1, n1 + 0.5 * n2)) + uHazeB * sq(smoothstep(-0.4, 1.2, n2 - 0.6 * n1));
  // The cloud's colour deepened: each channel's ratio to the brightest raised to a power, so
  // where many colours lie over one another the sum keeps a hue and does not go to chalk.
  vec3 lit = max(bicubic(uGasLayer, vUv, uGasSize).rgb, 0.0) + texture(uCloud, vUv).rgb;
  float peak = max(lit.r, max(lit.g, lit.b));
  if (peak > 1e-6) lit = pow(lit / peak, vec3(uVivid)) * peak;
  fragColor = vec4(sky + lit, 1.0);
}
`;

/* ── The forms ───────────────────────────────────────────────────────────────────────────── */

/**
 * A spiral galaxy: a warm bulge, a disc of stars, blue gas born along logarithmic arms that
 * turn as a pattern while the matter turns faster inside and slower outside, and pink knots.
 * uA: arms, winding, the pattern's angle, the turning sense. uB: the knots' salt, how oval the
 * streamlines are, where on them the crest lies.
 */
const GALAXY: Form = {
  sim: /* glsl */ `
float armAngle(float r, float arm) { return uA.z + uA.y * log(r / 0.25) + uB.z + TAU * arm / uA.x; }
vec3 birth(int fam, vec4 tr, inout uint s) {
  float u1 = rnd(s); float u2 = rnd(s); float u3 = rnd(s);
  vec2 g1 = gauss(s); vec2 g2 = gauss(s);
  if (fam == 0) return vec3(g1.x, g1.y * 0.7, g2.x) * 0.12 * (0.35 + 1.7 * u1 * u1);
  if (fam == 4) return normalize(vec3(g1, g2.x) + 1e-5) * vec3(1.0, 0.34, 1.0) * (0.7 + 2.0 * sqrt(u1));
  if (fam == 3) {
    float k = floor(u1 * 72.0);
    vec3 hk = hash31(k * 7.31 + uB.x);
    float r = 0.36 + 1.25 * hk.x;
    float a = armAngle(r, floor(hk.y * uA.x)) + (hk.z - 0.5) * 0.08 / r;
    float spread = 0.014 + 0.04 * fract(hk.z * 13.7);
    return vec3(cos(a) * r, 0.0, sin(a) * r) + vec3(g1.x, g1.y * 0.6, g2.x) * spread;
  }
  float r = fam == 1 ? 0.1 + 1.75 * pow(u1, 1.5) : 0.22 + 1.55 * pow(u1, 1.1);
  // The gas is born on the arms' crests; the stars anywhere, and the flow crowds them there.
  float a = fam == 1 ? TAU * u2 : armAngle(r, floor(u2 * uA.x)) + g2.x * (0.04 + 0.05 * r) / r;
  float h = g2.y * (fam == 1 ? 0.03 + 0.02 * r : 0.012 + 0.016 * r);
  return vec3(cos(a) * r, h, sin(a) * r);
}
vec3 drift(vec3 p, int fam, vec4 tr) {
  float R = length(p.xz) + 1e-4;
  vec2 er = p.xz / R, et = vec2(-er.y, er.x);
  // Streamlines are ovals whose long axis turns with radius: where they crowd is a spiral arm
  // that stays put while everything flows through it (the kinematics of a density wave).
  // The curve S = R (1 + e cos(m alpha)) is one of them; the flow runs along it.
  float alpha = uA.x * (atan(p.z, p.x) - uA.z - uA.y * log(R / 0.25));
  float oval = fam == 0 || fam == 4 ? 0.0 : uB.y * smoothstep(0.12, 0.55, R);
  float along = 1.0 + oval * (cos(alpha) + uA.x * uA.y * sin(alpha));
  float across = oval * uA.x * sin(alpha);
  vec2 tangent = normalize(et * along + er * across) * uA.w;
  // A rotation curve that rises and then stays flat: the inside laps the outside.
  float speed = uSwirl * 1.25 * R / (R + 0.2) * (fam == 0 ? 0.6 : 1.0);
  vec3 v = vec3(tangent.x * speed, 0.0, tangent.y * speed);
  v.y -= p.y * (fam == 0 || fam == 4 ? 0.0 : 2.4);
  v.xz -= er * uInflow * smoothstep(0.1, 0.6, R);
  return v;
}
`,
  tone: /* glsl */ `
vec2 tone(vec3 p, int fam, vec4 tr, float age) {
  float R = length(p.xz);
  // How far onto an arm's crest a place is: the lanes between the arms are left dark.
  float arm = 0.5 + 0.5 * cos(uA.x * (atan(p.z, p.x) - uA.z - uB.z - uA.y * log(max(R, 1e-3) / 0.25)));
  float lane = smoothstep(0.22, 0.5, R);
  // A star is gold or blue, not something between: which is likelier turns with radius.
  if (fam == 1) return vec2((0.42 - R + 0.4 * (fract(tr.y * 17.0) - 0.5)) * 8.0 + 0.5, mix(1.0, 0.1 + 1.3 * arm * arm, lane) * (0.4 + 1.2 * exp(-R * R / 0.03)));
  if (fam == 2) return vec2(1.3 - 1.05 * R + 0.2 * (tr.w - 0.5), mix(1.0, 0.3 + 0.9 * arm, lane));
  if (fam == 3) return vec2(tr.w * tr.w, 1.0);
  if (fam == 4) return vec2(tr.w, 0.45 + 0.75 * arm);
  return vec2(tr.w, 1.0);
}
`,
  families: [
    { share: 0.12, glow: 0.16, puff: 0.02, spark: 0.08, turb: 0.25, gather: 0, life: 9, drag: 0.5, sparkle: 0.03, heat: 1.2, cold: [1.0, 0.46, 0.07], warm: [1.0, 0.72, 0.24] },
    { share: 0.14, glow: 0.06, puff: 0.02, spark: 0.4, turb: 0.3, gather: 0.15, life: 14, drag: 0.4, sparkle: 0.1, heat: 0.8, cold: [0.08, 0.26, 1.0], warm: [1.0, 0.64, 0.2] },
    { share: 0.5, glow: 0.36, puff: 0.014, spark: 0.13, turb: 1.0, gather: 1.0, life: 10, drag: 0.25, sparkle: 0.02, heat: 1.0, cold: [0.16, 0.04, 1.0], warm: [0.0, 0.7, 0.78] },
    { share: 0.12, glow: 0.5, puff: 0.01, spark: 0.36, turb: 0.6, gather: 0.5, life: 7, drag: 0.3, sparkle: 0.08, heat: 0.8, cold: [1.0, 0.02, 0.4], warm: [1.0, 0.1, 0.12] },
    { share: 0.12, glow: 0.14, puff: 0.03, spark: 0.16, turb: 0.8, gather: 1.0, life: 16, drag: 0.5, sparkle: 0.15, heat: 0.5, cold: [0.3, 0.06, 0.95], warm: [0.03, 0.32, 0.95] }
  ],
  shape(random) {
    const arms = [2, 2, 3, 4][Math.floor(random() * 4)] ?? 2;
    const sense = random() < 0.5 ? -1 : 1;
    const winding = (2.0 + random() * 0.9) * (arms > 2 ? 0.8 : 1) * sense;
    const salt = random() * 50;
    // As oval as the streamlines can be and still nest; the crest is where they crowd most.
    const oval = 0.55 / (1 + arms * Math.abs(winding));
    const crest = Math.atan2(arms * winding, 1) / arms;
    // The matter turns against the winding, so the arms trail; the pattern creeps after it.
    return (pulse) => ({ a: [arms, winding, -sense * 0.12 * pulse.turned, -sense], b: [salt, oval, crest, 0] });
  },
  hot: [1.0, 0.85, 0.62], hazeA: [0.012, 0.016, 0.04], hazeB: [0.03, 0.008, 0.02],
  centre: [0, 0, 0], core: [0, 0, 0], distance: 2.95, elevation: 0.56, swing: 0.1, rollWide: -0.3, rollTall: 1.1,
  swirl: 0.24, turbulence: 0.06, gather: 0.05, inflow: 0.012, spin: 0.15, grain: 2.2, inner: 0,
  shellSpeed: 2.0, ripple: 0.07, push: 0.1, flash: 0.9, reach: 1.9, lens: 0.0035, exposure: 1.0, bloom: 0.45
};

/**
 * An emission nebula: a cavity blown by a cluster, its ragged wall, pillars standing in from
 * the wall toward the stars, and the wind that leaves them.
 * uA: pillars. uB: the wall's salt, its radius.
 */
const EMISSION: Form = {
  sim: /* glsl */ `
float wall(vec3 d) {
  return uB.y * (1.0 + 0.5 * texture(uRidge, d * 0.23 + uB.x).w + 0.22 * texture(uRidge, d.zxy * 0.52 + uB.x * 1.7).w);
}
vec3 birth(int fam, vec4 tr, inout uint s) {
  float u1 = rnd(s); float u2 = rnd(s);
  vec2 g1 = gauss(s); vec2 g2 = gauss(s);
  vec3 g = vec3(g1, g2.x);
  vec3 d = normalize(g + 1e-5);
  if (fam == 0) return g * 0.06 * (0.3 + 1.7 * u1 * u1);
  if (fam == 4) return d * (0.04 + 0.12 * u1);
  if (fam == 3) {
    float k = floor(u2 * uA.x);
    vec3 axis = normalize(hash31(k * 5.17 + uB.x * 31.0 + 3.0) * 2.0 - 1.0 + 1e-4);
    float base = wall(axis);
    float along = pow(u1, 1.7);
    float radius = mix(base * (0.36 + 0.2 * hash11(k + 9.0)), base * 1.02, along);
    vec3 side = normalize(cross(axis, vec3(0.31, 0.83, 0.46)));
    vec3 over = cross(axis, side);
    float width = 0.01 + 0.05 * along * along;
    return axis * radius + side * (g1.x * width + 0.1 * sin(along * 2.6 + k) * along) + over * g1.y * width;
  }
  float w = wall(d);
  if (fam == 1) return d * w * (1.0 + 0.03 * g2.y + 0.55 * u1 * u1 * u1);
  return d * w * (0.97 - 0.16 * u1 * u1);
}
vec3 drift(vec3 p, int fam, vec4 tr) {
  float r = length(p) + 1e-4;
  vec3 d = p / r;
  if (fam == 4) return d * uSwirl * 0.9 / (0.35 + r);
  if (fam == 0) return cross(vec3(0.3, 0.9, 0.3), p) * 4.0 * uSwirl;
  return cross(vec3(0.17, 0.97, 0.17), p) * 0.3 * uSwirl + d * uInflow * (fam == 2 ? -0.5 : 1.0);
}
`,
  tone: /* glsl */ `
vec2 tone(vec3 p, int fam, vec4 tr, float age) {
  float r = length(p);
  if (fam == 3) return vec2(1.35 - 1.3 * r, 1.0 + 0.5 * saturate(1.0 - 1.5 * r));
  if (fam == 4) return vec2(r * 1.2, 1.0);
  return vec2(tr.w + 0.35 * sin(p.x * 3.0 + p.y * 2.3 + p.z * 2.6), 1.0);
}
`,
  families: [
    { share: 0.03, glow: 0.8, puff: 0.012, spark: 0.8, turb: 0.3, gather: 0, life: 20, drag: 0.5, sparkle: 0.5, heat: 0.6, cold: [0.3, 0.55, 1.0], warm: [1.0, 0.8, 0.55] },
    { share: 0.42, glow: 0.34, puff: 0.012, spark: 0.26, turb: 1.0, gather: 1.0, life: 12, drag: 0.3, sparkle: 0.03, heat: 1.0, cold: [1.0, 0.02, 0.3], warm: [1.0, 0.16, 0.03] },
    { share: 0.25, glow: 0.34, puff: 0.012, spark: 0.26, turb: 0.8, gather: 1.0, life: 10, drag: 0.3, sparkle: 0.04, heat: 1.0, cold: [0.0, 0.6, 0.85], warm: [0.22, 0.06, 1.0] },
    { share: 0.13, glow: 0.13, puff: 0.012, spark: 0.3, turb: 0.5, gather: 0.7, life: 9, drag: 0.4, sparkle: 0.05, heat: 0.8, cold: [1.0, 0.34, 0.05], warm: [1.0, 0.62, 0.16] },
    { share: 0.14, glow: 0.2, puff: 0.012, spark: 0.16, turb: 0.7, gather: 0.2, life: 5, drag: 0.3, sparkle: 0.06, heat: 1.2, cold: [0.0, 0.7, 0.8], warm: [0.3, 0.2, 1.0] }
  ],
  shape(random) {
    const pillars = 5 + Math.floor(random() * 4);
    const salt = random();
    return () => ({ a: [pillars, 0, 0, 0], b: [salt, 1.0, 0, 0] });
  },
  hot: [0.85, 0.95, 1.0], hazeA: [0.03, 0.006, 0.014], hazeB: [0.006, 0.02, 0.03],
  centre: [0, 0, 0], core: [0, 0, 0], distance: 3.7, elevation: 0.2, swing: 0.25, rollWide: 0.2, rollTall: 0.5,
  swirl: 0.25, turbulence: 0.13, gather: 0.16, inflow: 0.03, spin: 0, grain: 1, inner: 0,
  shellSpeed: 1.9, ripple: 0.05, push: 0.12, flash: 0.9, reach: 1.5, lens: 0.0035, exposure: 1.0, bloom: 0.45
};

/**
 * A medusa: Hill's spherical vortex is the bell (up the axis, out under the crown, down the
 * skin), and the water going by outside it draws the rim's threads into tentacles.
 * uB: salt, the bell's radius, its ribs, its tentacles. uCore: the bell's centre.
 */
const MEDUSA: Form = {
  sim: /* glsl */ `
vec3 hill(vec3 q, float a, float U) {
  float rho2 = dot(q.xz, q.xz), r2 = rho2 + q.y * q.y;
  if (r2 < a * a) {
    float k = 1.5 * U / (a * a);
    return vec3(k * q.y * q.x, 1.5 * U - k * (2.0 * rho2 + q.y * q.y), k * q.y * q.z);
  }
  float a3 = a * a * a, r3 = r2 * sqrt(r2);
  float k = 1.5 * U * a3 / (r3 * r2);
  return vec3(k * q.y * q.x, -U * (1.0 - a3 / r3) - k * rho2, k * q.y * q.z);
}
vec3 birth(int fam, vec4 tr, inout uint s) {
  float u1 = rnd(s); float u2 = rnd(s); float u3 = rnd(s); float u4 = rnd(s);
  vec2 g1 = gauss(s); vec2 g2 = gauss(s);
  float a = uB.y;
  vec3 q;
  if (fam == 0) {
    q = vec3(g1.x * 0.09 * a, a * (-0.85 + 0.75 * u1), g1.y * 0.09 * a);
  } else if (fam == 1) {
    float phi = u3 < 0.6 ? TAU * (floor(u2 * uB.z) + 0.5 + 0.07 * g2.x) / uB.z : TAU * u2;
    float ct = 1.0 - 1.2 * u1;
    float st = sqrt(max(0.0, 1.0 - ct * ct));
    q = a * (0.985 - 0.08 * u4 * u4) * vec3(st * cos(phi), ct, st * sin(phi));
  } else if (fam == 2) {
    float n = floor(u2 * uB.w);
    float phi = TAU * (n + 0.5) / uB.w + 0.012 * g2.x;
    float r = a * (1.02 + 0.1 * hash11(n * 3.7 + uB.x) + 0.012 * g2.y);
    q = vec3(r * cos(phi), a * (-0.1 + 0.03 * g1.x), r * sin(phi));
  } else if (fam == 3) {
    float n = floor(u2 * 5.0);
    float phi = TAU * (n + 0.5) / 5.0 + 0.4 * g2.x;
    float rho = a * (0.08 + 0.22 * u1);
    q = vec3(rho * cos(phi), -a * (1.01 + 0.25 * u3), rho * sin(phi));
  } else {
    q = vec3((u1 * 2.0 - 1.0) * 2.8, (u2 * 2.0 - 1.0) * 2.5, (u3 * 2.0 - 1.0) * 2.8);
  }
  return uCore + q;
}
vec3 drift(vec3 p, int fam, vec4 tr) {
  vec3 q = p - uCore;
  vec3 v = hill(q, uB.y, uSwirl);
  v.xz += vec2(-q.z, q.x) * uInflow;
  return fam == 4 ? v * 0.6 : v;
}
`,
  tone: /* glsl */ `
vec2 tone(vec3 p, int fam, vec4 tr, float age) {
  vec3 q = p - uCore;
  if (fam == 1) return vec2(0.45 - 0.75 * q.y / uB.y + 0.3 * (tr.w - 0.5), 1.0);
  if (fam == 2) return vec2(-0.45 * q.y - 0.1, 1.0);
  if (fam == 0) return vec2(0.5 + 0.6 * q.y / uB.y, 1.0);
  return vec2(tr.w, 1.0);
}
`,
  families: [
    { share: 0.12, glow: 0.3, puff: 0.012, spark: 0.3, turb: 0.3, gather: 0.2, life: 5, drag: 0.25, sparkle: 0.06, heat: 1.2, cold: [1.0, 0.3, 0.05], warm: [1.0, 0.6, 0.16] },
    { share: 0.36, glow: 0.3, puff: 0.012, spark: 0.24, turb: 0.35, gather: 0.5, life: 5, drag: 0.25, sparkle: 0.03, heat: 1.0, cold: [0.0, 0.62, 1.0], warm: [0.4, 0.06, 1.0] },
    { share: 0.24, glow: 0.34, puff: 0.012, spark: 0.28, turb: 1.0, gather: 0.5, life: 9, drag: 0.3, sparkle: 0.05, heat: 1.0, cold: [0.45, 0.08, 1.0], warm: [1.0, 0.04, 0.42] },
    { share: 0.12, glow: 0.34, puff: 0.012, spark: 0.28, turb: 0.8, gather: 0.8, life: 7, drag: 0.3, sparkle: 0.05, heat: 1.0, cold: [1.0, 0.08, 0.4], warm: [1.0, 0.42, 0.06] },
    { share: 0.18, glow: 0.7, puff: 0.03, spark: 0.12, turb: 0.9, gather: 2.2, life: 14, drag: 0.5, sparkle: 0.2, heat: 0.4, cold: [0.04, 0.22, 1.0], warm: [0.0, 0.65, 0.6] }
  ],
  shape(random) {
    const ribs = 12 + Math.floor(random() * 9);
    const tentacles = 9 + Math.floor(random() * 8);
    const salt = random() * 10;
    // A kick draws the bell in.
    return (pulse) => ({ a: [0, 0, 0, 0], b: [salt, 0.62 * (1 - 0.06 * pulse.kick), ribs, tentacles] });
  },
  hot: [0.9, 1.0, 1.0], hazeA: [0.006, 0.018, 0.035], hazeB: [0.02, 0.008, 0.03],
  centre: [0, 0.05, 0], core: [0, 0.55, 0], distance: 2.8, elevation: 0.1, swing: 0.2, rollWide: 0.95, rollTall: 0.12,
  swirl: 0.24, turbulence: 0.1, gather: 0.1, inflow: 0.1, spin: 0, grain: 1, inner: 0,
  shellSpeed: 1.8, ripple: 0.04, push: 0.05, flash: 0.9, reach: 1.6, lens: 0.0035, exposure: 1.0, bloom: 0.45
};

/**
 * Twin vortices: particles run the lines of a dipole from pole to pole, both ways, while the
 * two halves turn against each other; jets leave along the axis, a disc turns at the waist.
 * uA: the jets' steady pace. uB: salt, strands.
 */
const TWIN: Form = {
  sim: /* glsl */ `
vec3 lineDir(vec3 p) { return normalize(3.0 * p * p.y / (dot(p, p) + 1e-5) - vec3(0.0, 1.0, 0.0)); }
vec3 birth(int fam, vec4 tr, inout uint s) {
  float u1 = rnd(s); float u2 = rnd(s); float u3 = rnd(s);
  vec2 g1 = gauss(s); vec2 g2 = gauss(s);
  if (fam == 0) {
    float r = 0.1 + 0.42 * u1 * u1, a = TAU * u2;
    return vec3(r * cos(a), 0.012 * g1.x, r * sin(a));
  }
  if (fam == 3) return vec3(0.02 * g1.x, (u3 < 0.5 ? 1.0 : -1.0) * (0.06 + 0.1 * u1), 0.02 * g1.y);
  if (fam == 4) return normalize(vec3(g1, g2.x) + 1e-5) * (0.7 + 1.6 * u1);
  // Leaving a pole along the line that crosses the waist at L.
  // Most leave in bundles: a strand's few loops, each with a waist and a bearing of its own.
  float n = floor(u2 * uB.y);
  float loop = n * 3.0 + floor(u1 * 3.0) + (fam == 1 ? 0.0 : 91.0);
  vec3 hl = hash31(loop * 1.37 + uB.x);
  bool bundled = u3 < 0.8;
  float lu = bundled ? hl.x : u1;
  float L = fam == 1 ? 0.42 + 0.55 * lu : 0.95 + 1.05 * lu * lu;
  if (bundled) L *= 1.0 + 0.012 * g2.y;
  float phi = bundled ? TAU * (n + 0.5 + 0.8 * (hl.y - 0.5)) / uB.y + 0.035 * g2.x : TAU * u2;
  float st = sqrt(0.17 / L), ct = sqrt(1.0 - 0.17 / L);
  // A step aside at the pole is many at the waist: the bundles start thin.
  vec3 p = 0.17 * vec3(st * cos(phi), ct, st * sin(phi)) + (bundled ? 0.0012 : 0.006) * vec3(g1, g2.y);
  return tr.z < 0.5 ? p : vec3(p.x, -p.y, p.z);
}
vec3 drift(vec3 p, int fam, vec4 tr) {
  float rho = length(p.xz) + 1e-4;
  vec3 around = vec3(-p.z, 0.0, p.x) / rho;
  if (fam == 0) return around * uSwirl * 0.8 / sqrt(rho + 0.05) - vec3(p.x, 8.0 * p.y, p.z) * 0.15;
  if (fam == 3) {
    float side = p.y < 0.0 ? -1.0 : 1.0;
    // Mostly a steady pace, each particle's own: were the jets to take the bass whole, every kick
    // would leave a hard-edged slab in them.
    float pace = (0.6 * uA.x + 0.4 * uSwirl) * (0.7 + 0.6 * tr.w);
    return vec3(p.x * 0.25, side * pace * 2.6 / (1.0 + 0.6 * abs(p.y)), p.z * 0.25) + around * side * 0.3 * uSwirl;
  }
  if (fam == 4) return around * 0.1 * uSwirl;
  vec3 v = lineDir(p) * (tr.z < 0.5 ? 1.0 : -1.0) * uSwirl * (1.0 + 0.1 * tr.y);
  // The twist goes with the swirl, so the lines keep their shape while the music changes their speed.
  return v + around * uSwirl * tanh(p.y * 2.2) * rho / (0.35 + rho);
}
`,
  tone: /* glsl */ `
vec2 tone(vec3 p, int fam, vec4 tr, float age) {
  if (fam == 1 || fam == 2) return vec2(0.5 - 0.5 * tanh(p.y * 3.5) + 0.2 * (tr.w - 0.5), 1.0);
  if (fam == 3) return vec2(abs(p.y) * 0.7, 1.0);
  return vec2(tr.w, 1.0);
}
`,
  families: [
    { share: 0.1, glow: 0.2, puff: 0.012, spark: 0.2, turb: 0.2, gather: 0, life: 8, drag: 0.3, sparkle: 0.05, heat: 1.2, cold: [1.0, 0.4, 0.05], warm: [1.0, 0.66, 0.2] },
    { share: 0.3, glow: 0.32, puff: 0.012, spark: 0.24, turb: 0.5, gather: 0.3, life: 9, drag: 0.04, sparkle: 0.04, heat: 1.0, cold: [0.0, 0.8, 0.55], warm: [1.0, 0.04, 0.45] },
    { share: 0.38, glow: 0.36, puff: 0.012, spark: 0.24, turb: 0.8, gather: 0.5, life: 14, drag: 0.04, sparkle: 0.04, heat: 1.0, cold: [0.04, 0.24, 1.0], warm: [0.5, 0.06, 1.0] },
    { share: 0.12, glow: 0.3, puff: 0.012, spark: 0.24, turb: 0.4, gather: 0, life: 4, drag: 0.2, sparkle: 0.1, heat: 1.0, cold: [1.0, 0.62, 0.2], warm: [1.0, 0.2, 0.08] },
    { share: 0.1, glow: 0.2, puff: 0.02, spark: 0.12, turb: 0.8, gather: 1.2, life: 16, drag: 0.6, sparkle: 0.2, heat: 0.4, cold: [0.0, 0.5, 0.8], warm: [0.4, 0.12, 1.0] }
  ],
  shape(random) {
    const strands = 5 + Math.floor(random() * 6);
    const salt = random() * 10;
    return () => ({ a: [0.4, 0, 0, 0], b: [salt, strands, 0, 0] });
  },
  hot: [1.0, 1.0, 0.9], hazeA: [0.008, 0.02, 0.03], hazeB: [0.025, 0.008, 0.03],
  centre: [0, 0, 0], core: [0, 0, 0], distance: 3.9, elevation: 0.3, swing: 0.2, rollWide: 1.05, rollTall: 0.15,
  swirl: 0.45, turbulence: 0.03, gather: 0.03, inflow: 0, spin: 0, grain: 1, inner: 0.15,
  shellSpeed: 2.0, ripple: 0.05, push: 0.08, flash: 0.9, reach: 1.6, lens: 0.0035, exposure: 1.0, bloom: 0.45
};

const FORMS: Record<string, Form> = { galaxy: GALAXY, emission: EMISSION, medusa: MEDUSA, twin: TWIN };

/* ── The instance ────────────────────────────────────────────────────────────────────────── */

/** The hue turned about the grey axis, as glsl.ts's hueShift does; nothing under zero. */
function turnHue(color: Rgb, angle: number): Rgb {
  const k = 0.57735;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = k * (color[0] + color[1] + color[2]);
  const cross: Rgb = [k * (color[2] - color[1]), k * (color[0] - color[2]), k * (color[1] - color[0])];
  const turn = (value: number, across: number): number => Math.max(0, value * c + across * s + k * dot * (1 - c));
  return [turn(color[0], cross[0]), turn(color[1], cross[1]), turn(color[2], cross[2])];
}

function normalize(v: readonly number[]): [number, number, number] {
  const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return [(v[0] ?? 0) / length, (v[1] ?? 0) / length, (v[2] ?? 0) / length];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [(a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0), (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];
}

/** The two baked fields as 3D textures: the eddies' velocity, and the pull toward the ridges (w: the ridge noise itself). */
function bakeFields(kit: Kit, program: Program, salt: number): { curl: WebGLTexture; ridge: WebGLTexture } {
  const gl = kit.gl;
  const make = (): WebGLTexture => {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, FIELD, FIELD, FIELD);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    return texture;
  };
  const curl = make();
  const ridge = make();
  gl.bindTexture(gl.TEXTURE_3D, null);
  const framebuffer = gl.createFramebuffer()!;
  // The kit draws into anything shaped like a target: here one layer of the two textures at a time.
  const layerTarget: Target = { texture: curl, textures: [curl], framebuffer, width: FIELD, height: FIELD, format: "rgba16f" };
  // One output at a time, as the kit draws every program of several (kit.ts says why).
  [curl, ridge].forEach((texture, output) => {
    for (let layer = 0; layer < FIELD; layer += 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
      kit.drawOutput(program, output, layerTarget, { uLayer: (layer + 0.5) / FIELD, uSalt: salt });
    }
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return { curl, ridge };
}

const CURL_UNIT = 6;
const RIDGE_UNIT = 7;

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const gl = kit.gl;
  const form = FORMS[preset] ?? GALAXY;
  const random = seededRandom(seed * 6113 + 71);
  const shape = form.shape(random);

  // What the seed decides beyond the form's own: where the camera starts and which way it goes,
  // how it leans, the palette's phase, the weather of the eddies.
  const azimuth = random() * Math.PI * 2;
  const orbit = random() < 0.5 ? -1 : 1;
  const swingPhase = random() * Math.PI * 2;
  const rollSide = random() < 0.5 ? -1 : 1;
  const rollJitter = (random() - 0.5) * 0.24;
  const elevation = form.elevation * (0.85 + 0.3 * random());
  const hue = (random() - 0.5) * 0.3;
  const weather = [random(), random(), random()];
  const salt = Math.floor(random() * 40);
  // The fields are baked with the first frame, not here: nothing waits for a program still compiling.
  const bake = kit.program(BAKE, { outputs: 2 });
  let fields: { curl: WebGLTexture; ridge: WebGLTexture } | null = null;

  const programs = {
    update: kit.program(updateSource(form), { outputs: 2 }),
    point: kit.program(POINT_FRAGMENT, { vertex: pointVertex(form) }),
    fade: kit.program(FADE),
    compose: kit.program(COMPOSE)
  };
  // The kit knows 2D samplers only: the 3D ones get units of their own, bound by hand.
  const wire = (program: Program): void => {
    for (const each of [program, ...program.others]) {
      gl.useProgram(each.program);
      const curlAt = gl.getUniformLocation(each.program, "uCurl");
      if (curlAt) gl.uniform1i(curlAt, CURL_UNIT);
      const ridgeAt = gl.getUniformLocation(each.program, "uRidge");
      if (ridgeAt) gl.uniform1i(ridgeAt, RIDGE_UNIT);
    }
  };
  const bindFields = (): void => {
    if (!fields) {
      fields = bakeFields(kit, bake, salt);
      wire(programs.update);
      wire(programs.compose);
    }
    gl.activeTexture(gl.TEXTURE0 + CURL_UNIT);
    gl.bindTexture(gl.TEXTURE_3D, fields.curl);
    gl.activeTexture(gl.TEXTURE0 + RIDGE_UNIT);
    gl.bindTexture(gl.TEXTURE_3D, fields.ridge);
    gl.activeTexture(gl.TEXTURE0);
  };

  // Per-family tables, as the shaders read them.
  const cumulative = new Float32Array(5);
  const laws = new Float32Array(20);
  const looks = new Float32Array(20);
  const sparks = new Float32Array(5);
  const cold = new Float32Array(15);
  const warm = new Float32Array(15);
  let sum = 0;
  const whole = form.families.reduce((total, family) => total + family.share, 0);
  form.families.forEach((family, index) => {
    sum += family.share / whole;
    cumulative[index] = sum;
    laws.set([family.turb, family.gather, family.life, family.drag], index * 4);
    looks.set([family.glow, family.puff, family.sparkle, family.heat], index * 4);
    sparks[index] = family.spark;
    cold.set(turnHue(family.cold, hue), index * 3);
    warm.set(turnHue(family.warm, hue), index * 3);
  });
  const hot = turnHue(form.hot, hue);
  const hazeA = turnHue(form.hazeA, hue);
  const hazeB = turnHue(form.hazeB, hue);

  const stateFormat = kit.stateFormat;
  const state: Double = kit.double(SIDE, SIDE, stateFormat, { filter: "nearest", attachments: 2 });
  let cloud: Double | null = null;
  let gas: Target | null = null;
  let scene: Target | null = null;
  let started = false;
  let nonce = 1;
  let turned = 0;
  let weatherTime = random() * 40;
  const shells = Array.from({ length: SHELLS }, () => ({ age: 99, power: 0 }));
  let nextShell = 0;
  const shellData = new Float32Array(SHELLS * 4);

  return {
    render(frame: FvFrame): void {
      const f = frame.audio.features;
      const step = Math.min(1 / 30, Math.max(1 / 240, frame.dt));
      const aspect = frame.width / frame.height;
      const [width, height] = workSize(frame);
      cloud = kit.fitDouble(cloud, width, height, "rgba16f", {}, true);
      gas = kit.fit(gas, width / 2, height / 2, "rgba16f");
      scene = kit.fit(scene, width, height, "rgba16f");
      const loud = f.level * f.presence;
      const gentle = frame.gentle;

      // The music's hold on the flow.
      const swirl = form.swirl * (0.55 + 0.95 * f.bass * f.presence);
      turned += step * swirl;
      weatherTime += step * (0.35 + 0.9 * loud);
      const pulse = shape({ turned, kick: gentle ? f.kick * 0.5 : f.kick, bass: f.bass });

      // The shells: one from every kick.
      if (f.onset) {
        shells[nextShell] = { age: 0, power: 0.7 + 0.3 * Math.min(1, f.bass * 1.3) };
        nextShell = (nextShell + 1) % SHELLS;
      }
      shells.forEach((shell, index) => {
        shell.age += step;
        const radius = form.shellSpeed * shell.age;
        const fade = shell.power * Math.min(1, radius / 0.12) * Math.exp(-((radius / form.reach) ** 2));
        const thickness = 0.09 + 0.1 * radius;
        shellData.set([radius, form.ripple * fade * (gentle ? 0.7 : 1), 1 / thickness, form.flash * fade * (gentle ? 0.4 : 1)], index * 4);
      });

      // How many particles this frame can carry: a million for a full 1080p picture, fewer for a smaller one.
      const count = Math.min(TOTAL, Math.max(120000, Math.round(width * height * DENSITY)));
      const rows = Math.ceil(count / SIDE);

      bindFields();
      const update = {
        uStep: step, uSwirl: swirl, uTurb: form.turbulence * (0.45 + 1.4 * f.mid * f.presence), uGather: form.gather * (0.7 + 0.6 * f.lowMid),
        uInflow: form.inflow * (0.4 + 1.2 * f.bass), uSpin: form.spin * turned * (pulse.a[3] ?? 1), uGrain: form.grain, uBound: 3.6, uInner: form.inner,
        uShellSpeed: form.shellSpeed, uPush: form.push, uHalf: stateFormat === "rgba32f" ? 0 : 1, uCore: form.core,
        uDriftA: [weather[0]! + weatherTime * 0.011, weather[1]! + weatherTime * 0.006, weather[2]! - weatherTime * 0.008],
        uDriftB: [weather[1]! - weatherTime * 0.017, weather[2]! + weatherTime * 0.023, weather[0]! + weatherTime * 0.013],
        uA: pulse.a, uB: pulse.b, uShell: shellData, uFam: laws, uCum: cumulative
      };
      if (!started) {
        // Every particle is born at once, into both textures, at an age of its own.
        for (let pass = 0; pass < 2; pass += 1) {
          kit.draw(programs.update, state.write, { ...update, uInit: 1, uNonce: nonce++, uPos: state.read, uVel: state.read.textures[1] });
          state.swap();
        }
        started = true;
      }
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, SIDE, rows);
      kit.draw(programs.update, state.write, { ...update, uInit: 0, uNonce: nonce++, uPos: state.read, uVel: state.read.textures[1] });
      gl.disable(gl.SCISSOR_TEST);
      state.swap();

      // The camera: a slow orbit that the music hurries, a slower nod, a lean that suits the frame.
      const tall = aspect < 1;
      const tan = TAN * (tall ? 1 + (1 / aspect - 1) * 0.55 : 1);
      const angle = azimuth + orbit * (0.028 * f.flow + 0.01 * f.time);
      const lift = elevation + form.swing * Math.sin(0.021 * f.flow + swingPhase);
      const distance = form.distance * (1 - (gentle ? 0 : 0.012) * f.kick);
      const eye = [
        form.centre[0] + distance * Math.cos(lift) * Math.cos(angle), form.centre[1] + distance * Math.sin(lift),
        form.centre[2] + distance * Math.cos(lift) * Math.sin(angle)
      ];
      const forward = normalize([form.centre[0] - eye[0]!, form.centre[1] - eye[1]!, form.centre[2] - eye[2]!]);
      const flatRight = normalize(cross(forward, [0, 1, 0]));
      const flatUp = cross(flatRight, forward);
      const roll = rollSide * (tall ? form.rollTall : form.rollWide) + rollJitter + 0.04 * Math.sin(0.013 * f.flow + swingPhase * 2);
      const rc = Math.cos(roll);
      const rs = Math.sin(roll);
      const right = [flatRight[0] * rc + flatUp[0] * rs, flatRight[1] * rc + flatUp[1] * rs, flatRight[2] * rc + flatUp[2] * rs];
      const up = [flatUp[0] * rc - flatRight[0] * rs, flatUp[1] * rc - flatRight[1] * rs, flatUp[2] * rc - flatRight[2] * rs];
      const camera = [...right, ...up, ...forward];
      const scalePx = height / (2 * tan);

      const lens = {
        uPos: state.read, uVel: state.read.textures[1], uCam: camera, uEye: eye, uHot: hot, uCore: form.core,
        uProj: [1 / (tan * aspect), 1 / tan], uFocus: form.distance, uTime: f.time,
        uA: pulse.a, uB: pulse.b, uLook: looks, uSpark: sparks, uCold: cold, uWarm: warm, uCum: cumulative
      };
      // Light per particle so that the picture is as bright whatever its size, the particle count and the lens.
      const gainOf = (pixels: number): number => (pixels / 1080) ** 2 * (TOTAL / count) * (TAN / tan) ** 2;
      // The gas: every particle, soft, at half size.
      kit.clear(gas);
      kit.points(programs.point, gas, count, {
        ...lens, uGas: 1, uLens: form.lens * scalePx * 0.5, uScalePx: scalePx * 0.5, uMinSize: 3.2,
        uMaxSize: Math.max(10, 30 * gas.height / 540), uGain: gainOf(gas.height), uSparkle: 0, uShimmer: 0
      }, "add");
      // The sparks: what was there fades, the particles are added to it.
      const keep = Math.exp(-step / 0.028);
      kit.draw(programs.fade, cloud.write, { uPrev: cloud.read, uKeep: keep });
      kit.points(programs.point, cloud.write, count, {
        ...lens, uGas: 0, uLens: form.lens * scalePx, uScalePx: scalePx, uMinSize: 3,
        uMaxSize: Math.max(12, 36 * height / 1080), uGain: (1 - keep) * gainOf(height),
        uSparkle: (gentle ? 0.5 : 1) * (5 + 16 * f.high * f.presence + 34 * f.hat), uShimmer: 0.45 * f.air * f.presence
      }, "add");
      cloud.swap();

      bindFields();
      kit.draw(programs.compose, scene, {
        uCloud: cloud.read, uGasLayer: gas, uGasSize: [gas.width, gas.height], uCam: camera, uLensXY: [tan * aspect, tan], uPixel: 2 * tan / height, uTime: f.time,
        uShimmer: 0.2 + 0.5 * f.air * f.presence, uSalt: seed % 31, uHazeA: hazeA, uHazeB: hazeB, uVivid: VIVID
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: form.exposure, bloom: form.bloom, bloomRadius: 0.72, threshold: 0.85, vignette: 0.32, contrast: 0.4, saturation: 1.2,
        whiten: 0.2, aberration: 0.0012, gentle
      });
    },
    destroy(): void {
      if (fields) {
        gl.deleteTexture(fields.curl);
        gl.deleteTexture(fields.ridge);
      }
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "nebula",
  order: 3,
  kind: "vivid",
  labelPl: "Mgławica miliona iskier",
  labelEn: "Million-Spark Nebula",
  descriptionPl: "Milion świecących drobin w wirze 3D układa się w galaktykę i mgławice — stopa wysyła przez nie falę uderzeniową, a wysokie tony zapalają pojedyncze iskry.",
  usesSource: false,
  gentleByDefault: false,
  presets: [
    { id: "galaxy", labelPl: "Galaktyka spiralna", labelEn: "Spiral Galaxy" },
    { id: "emission", labelPl: "Mgławica emisyjna", labelEn: "Emission Nebula" },
    { id: "medusa", labelPl: "Meduza", labelEn: "Medusa" },
    { id: "twin", labelPl: "Bliźniacze wiry", labelEn: "Twin Vortices" }
  ],
  create
};
