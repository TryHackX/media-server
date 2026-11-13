import { COMMON } from "../core/glsl";
import { Kit, type Double, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Oddychające ściany — Breathing Walls.
 *
 * The picture (the cover, the listener's image or video, or the painting drawn with none) lies
 * under a living membrane. One height field — slow swells that travel with the breath, a ring
 * from every kick, and a faint relief of form constants (honeycombs, funnels, spirals, cobwebs:
 * plane waves on the log-polar map) — bends the picture as a lens would, splits its colours a
 * little as a prism would, and catches a low light.
 *
 * The picture is shown as a poster under black light. Its tone is taken down where it is broad
 * and pale (paper, white grounds) and kept where it is small and bright, with a firm toe, so
 * the blacks are black; whatever has no colour of its own is given one — thin-film colours whose
 * thickness follows the tone near and far and a drifting band field, so greys and whites turn
 * into flowing bands that ring the picture's shapes. What has colour keeps it, turned in bands
 * and lifted.
 *
 * Over everything runs a grain of fine strands: noise drawn out along the picture's own contours
 * (a line integral along the tangent of its blurred gradient, handed over to a slow wandering
 * field where the picture is flat), with a ripple under the window so the strands creep along.
 * The picture's texture slides the same way. Every edge sends out glowing echoes of itself —
 * level lines of the blurred edge energy — and where nothing else is, the lattice surfaces, lit,
 * each of its cells a colour of its own. Everything drawn in light is copied a few times a
 * second; the copies drift outward, fade and turn colour: tracers, which only ever add light
 * and leave the dark between them dark.
 *
 * Bass and the breath phase set the depth of the swell, a kick sends a ring from the centre
 * (displacement, never brightness), mids set the speed of the crawl, highs the shimmer of the
 * echoes and the lattice, the level how far the hue drifts and how long the tracers last.
 */

interface Look {
  /** Depth of the breathing swell, and of the fine ripple on it. */
  swell: number;
  ripple: number;
  /** How far texture slides along the contours (of the picture's height), and how fast. */
  crawl: number;
  crawlSpeed: number;
  /** Sagging downward, in columns. */
  drip: number;
  /** How far the hue turns (radians at full level). */
  hue: number;
  /** How much of the film's colour the pale parts take, saturation, local contrast. */
  film: number;
  sat: number;
  clarity: number;
  /** How far broad light areas are brought down, where the toe sits, the gain after it. */
  compress: number;
  black: number;
  gain: number;
  /** The grain of strands along the contours. */
  strand: number;
  /** The prism: how far red and blue part where the membrane is steep. */
  disperse: number;
  /** The echoes the edges send out, the glow on the edges themselves, how bright any drawn line is. */
  aura: number;
  rim: number;
  line: number;
  /** Form constants: strength, whether they cover everything (1) or surface in flat patches (0), and which (-1: the seed's). */
  lattice: number;
  latticeAll: number;
  latticeKind: number;
  /** The honeycombs drawn as a net of lines (1) or as rings (0). */
  latticeNet: number;
  /** Tracers: seconds they last, how bright they begin, their drift outward and along the contours, how fast their hue turns. */
  trail: number;
  wake: number;
  trailZoom: number;
  trailAlong: number;
  trailHue: number;
  /** The kick's ring. */
  ring: number;
  shade: number;
  exposure: number;
  bloom: number;
}

const LOOKS: Record<string, Look> = {
  // Deep breathing, bands of colour, the lattice in patches.
  breath: {
    swell: 1.0, ripple: 0.1, crawl: 0.02, crawlSpeed: 1.0, drip: 0.0, hue: 0.6, film: 0.95, sat: 1.5, clarity: 0.5,
    compress: 1.0, black: 0.36, gain: 1.6, strand: 0.5, disperse: 0.4, aura: 0.8, rim: 0.2, line: 1.3,
    lattice: 0.6, latticeAll: 0.0, latticeKind: -1, latticeNet: 0, trail: 0.4, wake: 0.4, trailZoom: 0.02, trailAlong: 0.3, trailHue: 1.2,
    ring: 1.0, shade: 1.0, exposure: 1.25, bloom: 0.5
  },
  // The texture runs along its contours and sags; the strands are thick.
  melt: {
    swell: 0.8, ripple: 0.16, crawl: 0.06, crawlSpeed: 1.6, drip: 0.035, hue: 0.75, film: 0.95, sat: 1.5, clarity: 0.4,
    compress: 1.0, black: 0.36, gain: 1.6, strand: 0.7, disperse: 0.5, aura: 0.5, rim: 0.2, line: 1.2,
    lattice: 0.3, latticeAll: 0.0, latticeKind: -1, latticeNet: 0, trail: 0.6, wake: 0.45, trailZoom: 0.0, trailAlong: 1.0, trailHue: 1.0,
    ring: 0.9, shade: 1.0, exposure: 1.25, bloom: 0.5
  },
  // Long tracers that turn through the rainbow as they go.
  tracers: {
    swell: 1.0, ripple: 0.1, crawl: 0.025, crawlSpeed: 1.0, drip: 0.0, hue: 0.8, film: 0.95, sat: 1.5, clarity: 0.5,
    compress: 1.0, black: 0.36, gain: 1.6, strand: 0.4, disperse: 0.5, aura: 1.0, rim: 0.25, line: 1.4,
    lattice: 0.35, latticeAll: 0.0, latticeKind: -1, latticeNet: 0, trail: 1.1, wake: 0.65, trailZoom: 0.11, trailAlong: 0.4, trailHue: 2.4,
    ring: 1.3, shade: 1.0, exposure: 1.25, bloom: 0.55
  },
  // Form constants forward.
  geometry: {
    swell: 0.85, ripple: 0.08, crawl: 0.016, crawlSpeed: 1.0, drip: 0.0, hue: 0.6, film: 0.95, sat: 1.5, clarity: 0.5,
    compress: 1.0, black: 0.36, gain: 1.6, strand: 0.3, disperse: 0.4, aura: 0.5, rim: 0.2, line: 1.4,
    lattice: 1.0, latticeAll: 1.0, latticeKind: -1, latticeNet: 1, trail: 0.45, wake: 0.4, trailZoom: 0.02, trailAlong: 0.3, trailHue: 1.4,
    ring: 1.0, shade: 1.0, exposure: 1.25, bloom: 0.5
  }
};

const RINGS = 6;
/** The long side of the picture's analysis, and of the membrane: both are smooth, neither follows the frame's scale. */
const SENSE_LONG = 448;
const WARP_LONG = 256;
/** Steps of the strands' path, each way. */
const STRAND_STEPS = 10;
const GRAIN_SIZE = 512;

/** Thin-film colours by thickness, 0–1400 nm, seen straight on. */
const FILM_TABLE = COMMON + /* glsl */ `
void main() { fragColor = vec4(thinFilm(vUv.x * 1400.0, 1.0), 1.0); }
`;

/** White noise, four of them: what the strands are drawn out of. */
const GRAIN = COMMON + /* glsl */ `
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  fragColor = vec4(hash12(cell + 0.5), hash12(cell + 71.3), hash12(cell.yx + 233.7), hash12(cell * 1.3 + 419.2));
}
`;

/**
 * What the picture is made of, where it lies in the frame: xy the gradient of its tone (two
 * scales of Sobel, per texel), z the tone itself, w the gradient's length.
 */
const SENSE = COMMON + /* glsl */ `
uniform sampler2D uSrc;
uniform vec4 uFit;
uniform float uAspect;
uniform vec2 uTexel;
vec3 pick(vec2 p) { return min(texture(uSrc, p * uFit.xy + uFit.zw).rgb, vec3(2.0)); }
// Tone as the eye takes it, with a little of red against blue so that edges of colour count too.
float tone(vec2 p) { vec3 c = pick(p); return sqrt(max(luma(c), 0.0)) + 0.22 * (c.r - c.b); }
void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  vec2 g = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    float h = i == 0 ? 1.0 : 3.0;
    vec2 e = uTexel * h;
    float tl = tone(p + vec2(-e.x, e.y)), tc = tone(p + vec2(0.0, e.y)), tr = tone(p + e);
    float ml = tone(p - vec2(e.x, 0.0)), mr = tone(p + vec2(e.x, 0.0));
    float bl = tone(p - e), bc = tone(p - vec2(0.0, e.y)), br = tone(p + vec2(e.x, -e.y));
    g += vec2((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl), (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br)) / 8.0 * (i == 0 ? 0.6 : 1.0);
  }
  fragColor = vec4(g, sqrt(max(luma(pick(p)), 0.0)), length(g));
}
`;

const BLUR = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uDir;
void main() {
  vec4 sum = texture(uSource, vUv) * 0.2270270;
  sum += (texture(uSource, vUv + uDir * 1.3846154) + texture(uSource, vUv - uDir * 1.3846154)) * 0.3162162;
  sum += (texture(uSource, vUv + uDir * 3.2307692) + texture(uSource, vUv - uDir * 3.2307692)) * 0.0702703;
  fragColor = sum;
}
`;

/** Which way each edge's middle lies, as a share of a texel: the slope of the edge energy over the energy itself. */
const EDGE = /* glsl */ `
uniform sampler2D uField;
uniform vec2 uTexel;
void main() {
  float c = texture(uField, vUv).w;
  float l = texture(uField, vUv - vec2(uTexel.x, 0.0)).w, r = texture(uField, vUv + vec2(uTexel.x, 0.0)).w;
  float b = texture(uField, vUv - vec2(0.0, uTexel.y)).w, t = texture(uField, vUv + vec2(0.0, uTexel.y)).w;
  fragColor = vec4(vec2(r - l, t - b) * 0.5 / (c + 0.02), c, 1.0);
}
`;

/**
 * Which way the strands run: along the contours of the picture's tone, near and far, and where
 * the picture says nothing, along the contours of a slow wandering field. xy a unit vector.
 */
const DIRECTION = COMMON + /* glsl */ `
uniform sampler2D uField, uWide, uFar;
uniform float uAspect, uT, uWander;
uniform vec3 uSeed;
float wandering(vec2 p) {
  return snoise3(vec3(p * 1.5 + uSeed.xy, uT * 0.05)) + 0.45 * snoise3(vec3(p * 3.4 + uSeed.yz, uT * 0.08 + 7.0));
}
void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  vec2 g = texture(uField, vUv).xy + 3.0 * texture(uWide, vUv).xy + 9.0 * texture(uFar, vUv).xy;
  const float e = 0.012;
  g += uWander * vec2(wandering(p + vec2(e, 0.0)) - wandering(p - vec2(e, 0.0)), wandering(p + vec2(0.0, e)) - wandering(p - vec2(0.0, e))) / (2.0 * e);
  float len = length(g);
  fragColor = vec4(vec2(-g.y, g.x) / (len + 1e-5), len, 1.0);
}
`;

/**
 * The strands: noise summed along the path that follows the direction both ways. r and g two
 * fine grains, b a broad one, each spread back over 0–1.
 */
const STRANDS = /* glsl */ `
uniform sampler2D uDir, uNoise;
uniform float uAspect, uReach, uGrain, uPhase, uContrast;
const int N = ${STRAND_STEPS};
vec3 grain(vec2 uv) {
  vec2 p = vec2(uv.x * uAspect, uv.y) * uGrain;
  return vec3(texture(uNoise, p).rg, texture(uNoise, p * 0.29 + 0.37).b);
}
// A window over the path, and under it a ripple that runs along: the strands seem to creep.
float weight(float i) {
  float x = i / float(N);
  return (0.5 + 0.5 * cos(2.89 * x)) * (1.0 + 0.85 * cos(6.2831853 * (x - uPhase)));
}
void main() {
  float w = weight(0.0);
  vec3 sum = grain(vUv) * w;
  float total = w, squares = w * w;
  vec2 unit = vec2(1.0 / uAspect, 1.0) * uReach;
  for (int side = 0; side < 2; side++) {
    float way = side == 0 ? 1.0 : -1.0;
    vec2 uv = vUv;
    for (int i = 1; i <= N; i++) {
      uv += way * texture(uDir, uv).xy * unit;
      w = weight(way * float(i));
      sum += grain(uv) * w;
      total += w;
      squares += w * w;
    }
  }
  // A sum of many is narrow: brought back to the width of one, then bent into 0–1.
  vec3 s = (sum / total - 0.5) * (total / sqrt(squares)) * uContrast;
  fragColor = vec4(0.5 + 0.5 * s / sqrt(1.0 + s * s), 1.0);
}
`;

/**
 * The membrane: xy the gradient of its height (which is also how far it bends the picture),
 * z and w two broad drifting fields (the colour bands, and where the lattice surfaces).
 */
const WARP = COMMON + /* glsl */ `
uniform float uAspect, uBreath, uDepth, uZoom, uRipple, uT;
uniform vec2 uCentre;
uniform vec3 uSeedA, uSeedB;
uniform vec4 uRing[${RINGS}];
// Swells of three sizes; each breathes a little later than its neighbour, so the swell travels.
float height(vec2 p) {
  float lag = 2.2 * snoise(p * 0.5 + uSeedA.xy + uT * 0.03);
  float h = snoise3(vec3(p * 1.05 + uSeedA.yz, uT * 0.11)) * sin(uBreath - lag);
  h += 0.38 * snoise3(vec3(p * 2.2 + uSeedB.xy, uT * 0.17)) * sin(uBreath * 0.5 + 1.9 + 1.4 * lag);
  h += uRipple * snoise3(vec3(p * 5.3 + uSeedB.yz, uT * 0.4));
  return h;
}
void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  const float e = 0.02;
  vec2 d = vec2(height(p + vec2(e, 0.0)) - height(p - vec2(e, 0.0)), height(p + vec2(0.0, e)) - height(p - vec2(0.0, e))) / (2.0 * e) * uDepth;
  // The whole wall coming nearer and going back.
  d -= (p - uCentre) * uZoom;
  // The kicks' rings: a ridge that spreads from the centre, magnifying what it passes over.
  vec2 c = p - uCentre;
  float r = length(c);
  vec2 dir = c / (r + 1e-3);
  for (int i = 0; i < ${RINGS}; i++) {
    float x = (r - uRing[i].x) / uRing[i].y;
    d -= dir * uRing[i].z * x * exp(-x * x) * smoothstep(0.0, 0.06, r);
  }
  float band = snoise3(vec3(p * 0.75 + uSeedB.zx, uT * 0.09)) + 0.45 * snoise3(vec3(p * 1.7 + uSeedA.zx, uT * 0.13 + 4.0));
  float surfacing = snoise3(vec3(p * 1.1 + uSeedA.xy + 31.7, uT * 0.07));
  fragColor = vec4(d, band, surfacing);
}
`;

const COMPOSE = COMMON + /* glsl */ `
uniform sampler2D uSrc, uField, uWide, uFar, uEdge, uWarp, uStrands, uTrail, uFilm;
uniform vec2 uSenseSize, uWarpSize, uRes, uCentre, uLight, uLatShift, uSeed;
uniform vec4 uFit;
uniform vec3 uWave[3];
uniform float uAspect, uSoft, uSharpen, uSharpenMost, uT, uStep, uHasSrc;
uniform float uCrawlT, uCrawlLen, uDrip, uDisperse;
uniform float uHueAmp, uFilmAmt, uFilmBase, uSat, uClarity, uCompress, uBlack, uGain;
uniform float uStrand, uAura, uAuraT, uShimmer, uRim, uLine;
uniform float uLattice, uLatAll, uLogPolar, uLatLevel, uLatBend;
uniform float uShade, uSpec;
uniform float uTrailKeep, uTrailHue, uTrailZoom, uTrailAlong, uWake, uCapture;

// Bicubic (B-spline) from four bilinear taps of the top level: smooth from a coarse texture, and no seams from the mip chain.
vec4 cubic(sampler2D tex, vec2 uv, vec2 size) {
  vec2 st = uv * size - 0.5;
  vec2 f = fract(st), i = floor(st);
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 0.5 + i) / size, h1 = (w3 / g1 + 1.5 + i) / size;
  return g0.y * (g0.x * textureLod(tex, vec2(h0.x, h0.y), 0.0) + g1.x * textureLod(tex, vec2(h1.x, h0.y), 0.0))
       + g1.y * (g0.x * textureLod(tex, vec2(h0.x, h1.y), 0.0) + g1.x * textureLod(tex, vec2(h1.x, h1.y), 0.0));
}
// The picture at a place in the frame (height 1, centre 0): smooth where it is enlarged, plain where it is not.
vec3 source(vec2 p) {
  vec2 uv = p * uFit.xy + uFit.zw;
  if (uSoft < 0.002) return texture(uSrc, uv).rgb;
  vec3 soft = cubic(uSrc, uv, vec2(textureSize(uSrc, 0))).rgb;
  return uSoft > 0.998 ? soft : mix(textureLod(uSrc, uv, 0.0).rgb, soft, uSoft);
}
// Through the prism: red a little short of the place, blue a little past it.
vec3 split(vec2 p, vec2 spread) { return vec3(source(p - spread).r, source(p).g, source(p + spread).b); }
// A film colour as a light of its own: vivid, its strongest channel near one whatever the hue.
// The thickness is folded back and forth over the first orders, where a film's colours are purest.
vec3 iris(float nm) {
  float folded = 190.0 + 560.0 * abs(fract(nm / 1120.0) * 2.0 - 1.0);
  vec3 f = texture(uFilm, vec2(folded / 1400.0, 0.5)).rgb;
  float y = luma(f);
  vec3 vivid = max(mix(vec3(y), f, 2.1), 0.0);
  return vivid / (0.55 * max(vivid.r, max(vivid.g, vivid.b)) + 0.45 * luma(vivid) + 0.06);
}
// Deep colours for what has none: teal through blue, violet and magenta to ember, and back the
// same way; each as strong to the eye as the next, the warm end a little lighter.
vec3 stain(float t) {
  float x = abs(fract(t) * 2.0 - 1.0);
  x = x * x * (3.0 - 2.0 * x);
  vec3 colour = hsv(mix(0.47, 1.05, x), 0.92, 0.8 + 0.3 * smoothstep(0.7, 1.0, x));
  return colour / (0.45 * luma(colour) + 0.25) * (1.0 + 0.8 * smoothstep(0.75, 1.0, x));
}
// A line where a smooth quantity passes a half, as wide in pixels as asked, whatever the quantity's slope.
float contour(float t, float width) {
  float d = abs(fract(t) - 0.5) / max(fwidth(t), 1e-5);
  return 1.0 - smoothstep(width - 0.7, width + 0.7, d);
}
// Steps with soft risers: a smooth field turned into bands.
float stair(float x) { return floor(x) + smoothstep(0.3, 0.7, fract(x)); }

void main() {
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  vec4 wv = cubic(uWarp, vUv, uWarpSize);
  vec2 lift = wv.xy;
  // Where on the picture this pixel looks, through the membrane.
  vec2 q = p + lift;
  vec2 fuv = vec2(q.x / uAspect + 0.5, q.y + 0.5);
  vec4 fld = cubic(uField, fuv, uSenseSize);
  vec4 wide = cubic(uWide, fuv, uSenseSize);
  vec4 far = texture(uFar, fuv);
  vec4 edg = cubic(uEdge, fuv, uSenseSize);
  vec3 strands = texture(uStrands, fuv).rgb;
  float fine = strands.r * 2.0 - 1.0, broad = strands.b * 2.0 - 1.0;
  float yb = fld.z;
  float edge = 1.0 - exp(-fld.w * 9.0);
  vec2 gv = fld.xy;
  float gl = length(gv);
  vec2 along = vec2(-gv.y, gv.x) / (gl + 1e-5);
  float grip = edge * smoothstep(0.1, 0.5, gl / (fld.w + 1e-4));

  // Form constants: three plane waves, on the wall itself or on its log-polar map.
  vec2 cc = q - uCentre;
  float r = length(cc) + 1e-4;
  vec2 u, ex, ey;
  float cell;
  if (uLogPolar > 0.5) { u = vec2(atan(cc.y, cc.x), log(r)); ex = vec2(-cc.y, cc.x) / r; ey = cc / r; cell = r; }
  else { u = q; ex = vec2(1.0, 0.0); ey = vec2(0.0, 1.0); cell = 1.0; }
  // The picture's tone bends the lattice: it lies on the picture, not over it.
  u += uLatShift + uLatBend * (wide.z - 0.5) * vec2(0.35, 1.0);
  float f = 0.0, f2 = 0.0;
  vec2 gu = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    float a = dot(uWave[i].xy, u);
    f += uWave[i].z * cos(a);
    f2 += uWave[i].z * cos(2.0 * a + 1.3);
    gu -= uWave[i].z * sin(a) * uWave[i].xy;
  }
  float kmag = length(uWave[0].xy);
  gu /= kmag;
  vec2 gq = ex * gu.x + ey * gu.y;
  float radPerPx = kmag / (cell * uRes.y);
  // Where the picture leaves room: away from its edges, and (unless asked for everywhere) in drifting patches.
  float open = 1.0 - smoothstep(0.008, 0.03, far.w);
  float lat = uLattice * (1.0 - smoothstep(0.25, 0.7, radPerPx)) * mix(open * smoothstep(-0.25, 0.45, wv.w), max(open, 0.35), uLatAll);
  float web = 1.0 - smoothstep(0.4, 1.8, abs(f - uLatLevel) / max(fwidth(f), 1e-5));
  float web2 = (1.0 - smoothstep(0.3, 1.5, abs(f2 - uLatLevel) / max(fwidth(f2), 1e-5))) * (1.0 - smoothstep(0.12, 0.35, radPerPx));

  // A soft edge drawn tight: the picture is taken a little away from the middle of each edge.
  vec2 pinch = -edg.xy * uSharpen;
  pinch *= min(1.0, uSharpenMost / (length(pinch) + 1e-6));
  vec2 base = q + pinch + gq * lat * (cell / kmag) * 0.45;
  vec2 spread = lift * uDisperse + gq * lat * (cell / kmag) * 0.12;

  // The crawl: the picture taken twice, each slid along the contours by half a cycle of the
  // other, and cross-faded where either jumps back. It flows for ever and never moves away.
  float sag = 0.5 + 0.5 * snoise(vec2(q.x * 4.5 + uSeed.x, q.y * 0.7 - uT * 0.08));
  vec2 flow = along * grip * uCrawlLen + vec2(0.0, 1.0) * uDrip * sag * (0.35 + edge);
  float pn = vnoise(q * 2.7 + uSeed);
  float ph = fract(uCrawlT + pn * 1.3);
  float ph2 = fract(ph + 0.5);
  float second = abs(2.0 * ph - 1.0);
  vec3 c = mix(split(base - flow * (ph - 0.5), spread), split(base - flow * (ph2 - 0.5), spread), second);

  // The tone. Broad light areas are brought down to where colour can be deep, small lights are
  // left standing over them, and a firm toe makes the darks black.
  float y = luma(c);
  float tn = sqrt(max(y, 0.0));
  float sat = length(c - y) / (y + 0.04);
  float pale = exp(-3.0 * sat);
  float key = pow(max(mix(far.z, wide.z, 0.6) / 0.42, 1.0), uCompress * (0.65 + 0.35 * pale));
  float t1 = max(tn + uClarity * (tn - yb), 0.0) / key;
  float t4 = t1 * t1 * t1 * t1;
  float lit = t1 * t1 * t4 / (t4 + uBlack);
  c *= min(uGain * lit / (1.0 + 0.45 * lit) / max(y, 1e-4), 4.0);
  float y1 = luma(c);

  // What has colour keeps it: turned in drifting bands, and lifted.
  vec3 ch = c - y1;
  float theta = uHueAmp * (stair(1.6 * wv.z + 0.5 * sin(yb * 5.0 + uT * 0.6)) / 1.6 + 0.6 * broad * uStrand) + 0.22 * lat * f;
  ch = hueShift(ch, theta);
  ch -= luma(ch);
  ch *= uSat * (1.0 + 0.9 * pale);
  c = max(y1 + ch, 0.0);
  // The painting drawn with no picture keeps its bands and its light, and takes the deep colours:
  // each of its hues its own.
  if (uHasSrc < 0.5) {
    float hue = atan(dot(ch, vec3(0.0, 0.7071, -0.7071)), dot(ch, vec3(0.8165, -0.4082, -0.4082)));
    c = mix(c, 0.5 * y1 * (0.3 + 0.9 * smoothstep(0.05, 0.5, y1)) * stain(hue / TAU + 0.22 * wv.z + 0.008 * uT), 0.85 * smoothstep(0.04, 0.3, length(ch) / (y1 + 0.04)));
  }

  // What has none is given the film's: its thickness follows the tone here and all around and
  // the drifting bands, so greys turn into bands of colour that ring the picture's shapes.
  // Each band is a terrace: dark under the rim of the one before, rising to its own lit rim.
  // Under the lattice each cell takes a colour of its own.
  float thick = uFilmBase + 200.0 * wide.z + 340.0 * far.z + 210.0 * wv.z + 34.0 * lat * f;
  float layer = thick / 70.0;
  float across = fract(layer - 0.5);
  float terrace = 0.58 + 0.72 * across * (1.0 - smoothstep(0.95, 1.0, across));
  float colourless = uFilmAmt * smoothstep(0.2, 0.7, pale);
  c = mix(c, 0.85 * y1 * terrace * stain(mix(layer, stair(layer), 0.6) / 6.0), colourless);
  // Everything drawn in light is kept apart: it is what leaves tracers.
  vec3 light = iris(thick + 140.0) * contour(layer, 0.6) * colourless * smoothstep(0.6, 0.9, pale) * (1.0 - edge) * uLine * (0.12 + 0.3 * uShimmer);

  // The strands: a silk grain along the contours, its crests lit in the next colour along.
  c *= 1.0 + uStrand * (0.5 * fine + 0.3 * broad);
  float crest = smoothstep(0.62, 0.96, strands.g);
  c += iris(thick + 50.0) * crest * uStrand * (0.04 + 0.7 * y1);

  // The lattice: embossed, and its web lit.
  c *= 1.0 - 0.3 * lat * dot(gq, uLight);
  vec3 webColour = iris(thick + 260.0 + 120.0 * f);
  float webbed = saturate(lat * (0.85 * web + 0.4 * web2));
  c *= 1.0 - 0.45 * webbed;
  light += webColour * webbed * uLine * (0.5 + 0.9 * uShimmer) * (0.3 + 1.1 * smoothstep(0.0, 0.3, y1));

  // Every edge glows, and sends out echoes of itself: level lines of the edge energy, moving outward.
  float away = sqrt(max(0.0, -log(wide.w / 0.15 + 1e-5)));
  float beside = smoothstep(0.003, 0.012, wide.w) * (1.0 - smoothstep(0.05, 0.14, fld.w));
  float turn = away * 2.3 - uAuraT;
  float echo = contour(turn, 0.9) * smoothstep(0.012, 0.03, fwidth(turn)) * beside * exp(-0.9 * away);
  vec3 echoColour = iris(thick + 330.0 + 260.0 * away);
  light += echoColour * echo * uAura * uLine * (0.5 + 0.9 * uShimmer);
  c += iris(thick + 480.0) * edge * edge * uRim;

  // The membrane's own light: a low lamp across its slopes.
  float slope = -uShade * dot(lift, uLight);
  c *= 1.0 + 0.42 * slope / (1.0 + abs(slope));
  vec3 nrm = normalize(vec3(-(lift * 40.0 + gq * lat * 0.35), 1.0));
  float spec = pow(saturate(dot(nrm, normalize(vec3(uLight * 0.8, 0.6)))), 40.0);
  c += (0.4 + echoColour) * spec * uSpec;

  // Tracers: a few times a second the light, and the brightest of the picture, are copied; the
  // copies drift outward and along the contours, fade and turn colour, and show wherever they
  // have more than the present does. Copies, not a smear: the dark between them stays dark.
  vec2 centreUv = vec2(uCentre.x / uAspect + 0.5, uCentre.y + 0.5);
  vec2 drift = (vUv - centreUv) * uTrailZoom + vec2(along.x / uAspect, along.y) * grip * uTrailAlong * 0.02;
  vec3 prev = texture(uTrail, vUv - drift * uStep).rgb;
  vec3 bright = light + c * smoothstep(0.7, 1.4, max(c.r, max(c.g, c.b)));
  vec3 trail = min(max(bright * uWake * uCapture, max(hueShift(prev, uTrailHue * uStep), 0.0) * uTrailKeep), vec3(16.0));

  fragColor = vec4(min(c + light + max(trail - bright, 0.0), vec3(24.0)), 1.0);
  fragColor1 = vec4(trail, 1.0);
}
`;

function follow(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
}

interface Lattice {
  logPolar: boolean;
  /** Three waves: the wave vector (x, y) and the amplitude of each. */
  waves: Float32Array;
  /** The contour of the summed waves that is drawn as the web. */
  level: number;
}

/** The form constants: 0 a honeycomb on the wall, 1 a honeycomb funnel, 2 two families of spirals, 3 a cobweb. */
function lattice(kind: number, net: boolean, random: () => number): Lattice {
  const root3 = Math.sqrt(3);
  if (kind === 0) {
    const k = (9 + Math.floor(random() * 4)) * Math.PI * 2;
    const turn = random() * Math.PI;
    const waves = new Float32Array(9);
    for (let index = 0; index < 3; index += 1) {
      const angle = turn + index * Math.PI * 2 / 3;
      waves.set([Math.cos(angle) * k, Math.sin(angle) * k, 1], index * 3);
    }
    return { logPolar: false, waves, level: net ? -0.97 : -0.72 };
  }
  if (kind === 1) {
    // Around the centre the count must be whole, and even, for the three waves to close.
    const m = 2 * (12 + Math.floor(random() * 5));
    return { logPolar: true, waves: new Float32Array([m, 0, 1, -m / 2, m * root3 / 2, 1, -m / 2, -m * root3 / 2, 1]), level: net ? -0.97 : -0.72 };
  }
  if (kind === 2) {
    // Arms one way and the other (both odd or both even, so the pattern closes), at right angles.
    const pairs: [number, number][] = [[13, 21], [11, 19], [9, 15], [12, 20]];
    const [a, c] = pairs[Math.floor(random() * pairs.length)]!;
    const steep = 1.2 + random() * 0.5;
    const ka = [a, a * steep];
    const kb = [-c, c / steep];
    return {
      logPolar: true,
      waves: new Float32Array([(ka[0]! + kb[0]!) / 2, (ka[1]! + kb[1]!) / 2, 1, (ka[0]! - kb[0]!) / 2, (ka[1]! - kb[1]!) / 2, 1, 0, 0, 0]),
      level: 0
    };
  }
  const m = 14 + Math.floor(random() * 8);
  const rings = m * (0.7 + random() * 0.3);
  return { logPolar: true, waves: new Float32Array([m, rings, 1, m, -rings, 1, 0, 0, 0]), level: 0 };
}

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const look = LOOKS[preset] ?? LOOKS.breath!;
  const random = seededRandom(seed * 7919 + 601);
  const programs = {
    table: kit.program(FILM_TABLE), grain: kit.program(GRAIN), sense: kit.program(SENSE), blur: kit.program(BLUR), edge: kit.program(EDGE),
    direction: kit.program(DIRECTION), strands: kit.program(STRANDS), warp: kit.program(WARP), compose: kit.program(COMPOSE, { outputs: 2 })
  };
  const film = kit.target(512, 2, "rgba16f");
  const grain = kit.target(GRAIN_SIZE, GRAIN_SIZE, "rgba8", { wrap: "repeat" });
  let tablesDrawn = false;
  let sense: Target | null = null;
  let heldA: Target | null = null;
  let heldB: Target | null = null;
  let field: Target | null = null;
  let wide: Target | null = null;
  let far: Target | null = null;
  let edge: Target | null = null;
  let direction: Target | null = null;
  let strands: Target | null = null;
  let warp: Target | null = null;
  let picture: Double | null = null;

  // What the seed decides: the noise fields, where the centre is, where the lamp stands, the
  // film's first colour, which form constant, how the picture wanders under the frame.
  const seedA = [random() * 40, random() * 40, random() * 40];
  const seedB = [random() * 40, random() * 40, random() * 40];
  const centre = [(random() - 0.5) * 0.24, (random() - 0.5) * 0.14];
  const lightAngle = random() * Math.PI * 2;
  const light = [Math.cos(lightAngle), Math.sin(lightAngle)];
  const filmBase = random() * 1120;
  const form = lattice(look.latticeKind >= 0 ? look.latticeKind : Math.floor(random() * 4), look.latticeNet > 0.5, random);
  const kmag = Math.hypot(form.waves[0]!, form.waves[1]!);
  const latticeTurn = (random() < 0.5 ? -1 : 1) * (0.012 + random() * 0.012);
  const latticeRun = (random() < 0.5 ? -1 : 1) * (0.02 + random() * 0.02);
  const panPhase = [random() * Math.PI * 2, random() * Math.PI * 2];
  const crawlTurn = random() < 0.5 ? -1 : 1;

  const rings = new Float32Array(RINGS * 4);
  const ringAge = new Float32Array(RINGS).fill(99);
  const ringStrength = new Float32Array(RINGS);
  let nextRing = 0;
  let depth = 0.5;
  let level = 0.3;
  let shimmer = 0;
  let crawlTime = random() * 10;
  let strandTime = random();
  let slow = random() * 100;
  let latticeTime = 0;
  let auraTime = 0;
  let sinceCopy = 0;

  return {
    render(frame: FvFrame): void {
      if (!tablesDrawn) {
        // With the first frame, not at creation: nothing waits for a program still compiling.
        kit.draw(programs.table, film, {});
        kit.draw(programs.grain, grain, {});
        tablesDrawn = true;
      }
      const f = frame.audio.features;
      const gentle = frame.gentle;
      const aspect = frame.width / frame.height;
      const [workWidth, workHeight] = workSize(frame);
      const step = Math.min(1 / 30, Math.max(1e-4, frame.dt));
      const senseWidth = aspect >= 1 ? SENSE_LONG : Math.round(SENSE_LONG * aspect);
      const senseHeight = aspect >= 1 ? Math.round(SENSE_LONG / aspect) : SENSE_LONG;
      const warpWidth = aspect >= 1 ? WARP_LONG : Math.round(WARP_LONG * aspect);
      const warpHeight = aspect >= 1 ? Math.round(WARP_LONG / aspect) : WARP_LONG;
      sense = kit.fit(sense, senseWidth, senseHeight, "rgba16f");
      heldA = kit.fit(heldA, senseWidth, senseHeight, "rgba16f");
      heldB = kit.fit(heldB, senseWidth, senseHeight, "rgba16f");
      field = kit.fit(field, senseWidth, senseHeight, "rgba16f");
      wide = kit.fit(wide, senseWidth, senseHeight, "rgba16f");
      far = kit.fit(far, senseWidth, senseHeight, "rgba16f");
      edge = kit.fit(edge, senseWidth, senseHeight, "rgba16f");
      direction = kit.fit(direction, senseWidth, senseHeight, "rgba16f");
      strands = kit.fit(strands, workWidth, workHeight, "rgba8", { wrap: "mirror" });
      warp = kit.fit(warp, warpWidth, warpHeight, "rgba16f");
      picture = kit.fitDouble(picture, workWidth, workHeight, "rgba16f", { attachments: 2 });

      // The music, as slow as breathing needs it.
      depth = follow(depth, 0.42 + 0.8 * f.bass * f.presence, step, 0.35, 1.3);
      level = follow(level, f.level * f.presence, step, 0.8, 2.2);
      shimmer = follow(shimmer, Math.min(1, 0.7 * f.high + 0.8 * f.hat), step, gentle ? 0.3 : 0.05, gentle ? 0.7 : 0.25);
      crawlTime += step * crawlTurn * look.crawlSpeed * (0.07 + 0.32 * f.mid * f.presence) * (gentle ? 0.7 : 1);
      strandTime += step * crawlTurn * look.crawlSpeed * (0.3 + 0.9 * f.mid * f.presence) * (gentle ? 0.7 : 1);
      slow += step * (gentle ? 0.6 : 1) * (0.7 + 0.7 * level);
      latticeTime += step * (0.5 + 1.0 * level + 0.6 * shimmer) * (gentle ? 0.6 : 1);
      auraTime += step * (0.22 + 0.5 * level) * (gentle ? 0.7 : 1);
      const breath = Math.PI * 2 * f.breath / (gentle ? 8 : 4);
      // The tracers' copies: five a second, four in gentle mode.
      sinceCopy += step;
      const copyEvery = gentle ? 0.25 : 0.2;
      const copy = sinceCopy >= copyEvery;
      if (copy) sinceCopy = sinceCopy > 2 * copyEvery ? 0 : sinceCopy - copyEvery;

      // A kick sends a ring from the centre.
      if (f.onset) {
        ringAge[nextRing] = 0;
        ringStrength[nextRing] = 0.6 + 0.4 * f.bass;
        nextRing = (nextRing + 1) % RINGS;
      }
      const ringDepth = 0.02 * look.ring * (gentle ? 0.6 : 1);
      for (let index = 0; index < RINGS; index += 1) {
        const age = ringAge[index]! + step;
        ringAge[index] = age;
        const rise = Math.min(1, age / 0.09);
        rings.set([0.05 + 0.6 * age, 0.055 + 0.06 * age, ringStrength[index]! * ringDepth * rise * rise * (3 - 2 * rise) * Math.exp(-age / 0.8), 0], index * 4);
      }

      // The picture covers the frame, a little over it, and wanders slowly in whatever is hidden.
      const sourceUniforms = environment.source.uniforms();
      const sourceAspect = environment.source.aspect;
      const span = Math.max(1, aspect / sourceAspect) * 1.06;
      const fitX = 1 / (span * sourceAspect);
      const fitY = 1 / span;
      const panX = 0.5 * Math.max(0, 1 - aspect * fitX) * 0.14 * Math.sin(slow * 0.05 + panPhase[0]!);
      const panY = 0.5 * Math.max(0, 1 - fitY) * 0.14 * Math.sin(slow * 0.037 + panPhase[1]!);
      const fit = [fitX, fitY, 0.5 + panX, 0.5 + panY];
      const sourceHeight = environment.source.kind === "none" ? 1024 : environment.source.height;
      const enlarged = workHeight * span / Math.max(1, sourceHeight);
      // How much a soft, enlarged picture is drawn tight: not at all when it is as fine as the frame.
      const tighten = Math.min(1, Math.max(0, (frame.height * span / Math.max(1, sourceHeight) - 1.6) / 2.2));

      // The picture read: its tone and gradient, close, wide and far.
      const texel = [1 / senseWidth, 1 / senseHeight];
      kit.draw(programs.sense, sense, { ...sourceUniforms, uFit: fit, uAspect: aspect, uTexel: [aspect / senseWidth, 1 / senseHeight] });
      kit.draw(programs.blur, heldA, { uSource: sense, uDir: [1.4 * texel[0]!, 0] });
      kit.draw(programs.blur, field, { uSource: heldA, uDir: [0, 1.4 * texel[1]!] });
      kit.draw(programs.blur, heldA, { uSource: field, uDir: [2.2 * texel[0]!, 0] });
      kit.draw(programs.blur, heldB, { uSource: heldA, uDir: [0, 2.2 * texel[1]!] });
      kit.draw(programs.blur, heldA, { uSource: heldB, uDir: [3.4 * texel[0]!, 0] });
      kit.draw(programs.blur, wide, { uSource: heldA, uDir: [0, 3.4 * texel[1]!] });
      kit.draw(programs.blur, heldA, { uSource: wide, uDir: [6 * texel[0]!, 0] });
      kit.draw(programs.blur, heldB, { uSource: heldA, uDir: [0, 6 * texel[1]!] });
      kit.draw(programs.blur, heldA, { uSource: heldB, uDir: [10 * texel[0]!, 0] });
      kit.draw(programs.blur, far, { uSource: heldA, uDir: [0, 10 * texel[1]!] });
      kit.draw(programs.edge, edge, { uField: field, uTexel: texel });

      // The strands: as fine as the working picture allows, and no finer than a share of the frame.
      const short = Math.min(workWidth, workHeight) / 1080;
      const grainPixels = Math.max(1.8, 2.2 * short);
      const stepPixels = Math.max(2.2, 2.6 * short);
      kit.draw(programs.direction, direction, { uField: field, uWide: wide, uFar: far, uAspect: aspect, uT: slow, uWander: 0.012, uSeed: seedB });
      kit.draw(programs.strands, strands, {
        uDir: direction, uNoise: grain, uAspect: aspect, uReach: stepPixels / workHeight, uGrain: workHeight / (GRAIN_SIZE * grainPixels),
        uPhase: strandTime, uContrast: 3.2
      });

      kit.draw(programs.warp, warp, {
        uAspect: aspect, uBreath: breath, uDepth: 0.011 * look.swell * depth * (gentle ? 0.75 : 1),
        uZoom: 0.035 * look.swell * depth * Math.sin(breath - 0.7) * (gentle ? 0.75 : 1), uRipple: look.ripple, uT: slow,
        uCentre: centre, uSeedA: seedA, uSeedB: seedB, uRing: rings
      });

      kit.draw(programs.compose, picture.write, {
        ...sourceUniforms, uField: field, uWide: wide, uFar: far, uEdge: edge, uWarp: warp, uStrands: strands, uTrail: picture.read.textures[1], uFilm: film,
        uSenseSize: [senseWidth, senseHeight], uWarpSize: [warpWidth, warpHeight], uRes: [workWidth, workHeight],
        uCentre: centre, uLight: light, uSeed: [seedA[0]!, seedB[0]!], uFit: fit, uAspect: aspect,
        uSoft: Math.min(1, Math.max(0, enlarged - 1)), uSharpen: 7 * tighten / senseHeight, uSharpenMost: 2.5 / senseHeight, uT: slow, uStep: step,
        uCrawlT: crawlTime, uCrawlLen: look.crawl, uDrip: look.drip, uDisperse: look.disperse,
        uHueAmp: look.hue * (0.35 + 0.9 * level) * (gentle ? 0.8 : 1), uFilmAmt: look.film, uFilmBase: filmBase + 14 * slow,
        uSat: look.sat, uClarity: look.clarity, uCompress: look.compress, uBlack: look.black ** 4, uGain: look.gain,
        uStrand: look.strand, uAura: look.aura, uAuraT: auraTime, uShimmer: 0.35 + 0.65 * shimmer, uRim: look.rim, uLine: look.line,
        uWave: form.waves, uLattice: look.lattice, uLatAll: look.latticeAll, uLogPolar: form.logPolar ? 1 : 0, uLatLevel: form.level,
        uLatBend: 2.6 / kmag, uLatShift: form.logPolar ? [latticeTurn * latticeTime, latticeRun * latticeTime] : [latticeTurn * latticeTime * 0.3, latticeRun * latticeTime * 0.3],
        uShade: 10 * look.shade * (gentle ? 0.6 : 1), uSpec: gentle ? 0 : 0.5,
        uTrailKeep: Math.exp(-step / (look.trail * (0.5 + 1.0 * level))), uTrailHue: look.trailHue, uTrailZoom: look.trailZoom, uTrailAlong: look.trailAlong, uWake: look.wake, uCapture: copy ? 1 : 0
      });
      picture.swap();

      environment.post.render(picture.read, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom, threshold: 0.9, vignette: 0.35, contrast: 0.35, saturation: 1.1, gentle
      });
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "breathing-walls",
  order: 6,
  kind: "psychedelic",
  labelPl: "Oddychające ściany",
  labelEn: "Breathing Walls",
  descriptionPl: "Okładka żyje: faluje w rytm oddechu, jej faktury pełzną po własnych konturach, a w gładkich miejscach wypływają opalizujące plastry i spirale.",
  usesSource: true,
  gentleByDefault: true,
  presets: [
    { id: "breath", labelPl: "Oddech", labelEn: "Breath" },
    { id: "melt", labelPl: "Roztopy", labelEn: "Thaw" },
    { id: "tracers", labelPl: "Smugi", labelEn: "Tracers" },
    { id: "geometry", labelPl: "Geometria", labelEn: "Geometry" }
  ],
  create
};
