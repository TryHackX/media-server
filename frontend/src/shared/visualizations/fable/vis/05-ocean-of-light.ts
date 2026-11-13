import { AUDIO, COMMON } from "../core/glsl";
import { Kit, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Ocean światła — Ocean of Light.
 *
 * A camera low over clear, shallow water. Near it the eye goes through the surface to a sand
 * floor under a net of caustics; toward the horizon the water turns to a mirror of the sky
 * with a path of sparkles under the sun.
 *
 * The sea is a sum of twelve directional waves with peaked crests, exp(s (sin θ - 1)), whose
 * height, slope and curvature are all written out, so nothing is differenced. Each wave's
 * amplitude follows its own part of the spectrum: bass raises the swell, the top raises the
 * ripples. A kick drops a ring wave that spreads from a point ahead.
 *
 * Caustics are not traced. Light refracted at the surface lands on the floor displaced by
 * depth × slope, so its brightness is 1 / |det(I + c d H)|, H the surface's Hessian: bright
 * lines exactly where the surface focuses. The determinant is a quadratic in c, and c grows
 * with the refractive index, so eight wavelengths cost eight quadratics and every line of
 * the net opens into a small spectrum.
 */

type Rgb = [number, number, number];

interface Look {
  zenith: Rgb;
  horizon: Rgb;
  /** A glow lying on the horizon, strongest under the sun. */
  belt: Rgb;
  /** How quickly the horizon colour gives way to the zenith's (an exponent on the sine of elevation). */
  skyCurve: number;
  sun: Rgb;
  /** Degrees above the horizon, and how far either side of the view the seed may put it. */
  sunElevation: number;
  sunSpread: number;
  /** The disc: its radius in degrees and its brightness. */
  sunRadius: number;
  disc: number;
  /** The glow about the sun: wide, middle, tight. */
  glow: Rgb;
  cloud: number;
  /** Where in the noise the clouds begin: higher is a clearer sky. */
  cloudEdge: number;
  cloudScale: number;
  cloudLit: Rgb;
  cloudDark: Rgb;
  /** A bank of cumulus standing on the horizon: how solid, and how high it reaches (sine of elevation). */
  bank: number;
  bankTop: number;
  stars: number;
  /** The spectral halo about the sun, its rings read from the music. */
  halo: number;
  /** How much the spectrum lights the clouds, by elevation. */
  bands: number;
  /** Water: absorption per metre, the colour light scatters back, how soon that fills in. */
  absorb: Rgb;
  scatter: Rgb;
  turbid: number;
  sand: Rgb;
  reef: Rgb;
  ambient: Rgb;
  /** The colour of the water where the floor has fallen away, far out. */
  deep: Rgb;
  depth: number;
  /** Focal strength of the surface: the c of det(I + c d H). */
  focus: number;
  /** How far c differs between violet and red, as a fraction; and the saturation of the fringes that gives. */
  dispersion: number;
  fringe: number;
  caustic: number;
  /** Over 1 darkens the cells between the lines; the cut takes that much light away from all of it. */
  causticGamma: number;
  causticCut: number;
  swell: number;
  chop: number;
  glitter: number;
  /** Slope spread of what is too fine to draw: the width of a glint. */
  rough: number;
  sparkle: number;
  /** How far the three channels' glints stand apart. */
  prism: number;
  /** Light through thin crests. */
  sss: number;
  /** Plankton light. */
  bio: Rgb;
  /** The light a kick's ring carries. */
  ring: Rgb;
  haze: number;
  height: number;
  pitch: number;
  exposure: number;
  bloom: number;
  threshold: number;
  saturation: number;
  contrast: number;
}

const LOOKS: Record<string, Look> = {
  // Noon over white sand: the caustics are the picture.
  lagoon: {
    zenith: [0.01, 0.09, 0.5], horizon: [0.28, 0.6, 0.95], belt: [0.3, 0.36, 0.36], skyCurve: 0.42,
    sun: [1.9, 1.75, 1.5], sunElevation: 27, sunSpread: 36, sunRadius: 1.2, disc: 40, glow: [0.12, 0.3, 1.0],
    cloud: 0.85, cloudEdge: 0.2, cloudScale: 0.32, cloudLit: [1.6, 1.55, 1.5], cloudDark: [0.36, 0.46, 0.7],
    bank: 1, bankTop: 0.13, stars: 0, halo: 0, bands: 0.25,
    absorb: [0.26, 0.055, 0.035], scatter: [0.01, 0.3, 0.34], turbid: 0.12, sand: [0.95, 0.9, 0.78], reef: [0.1, 0.22, 0.16],
    ambient: [0.1, 0.17, 0.2], deep: [0.0, 0.07, 0.3], depth: 1.7, focus: 0.4, dispersion: 0.25, fringe: 1.9, caustic: 0.5, causticGamma: 1.55, causticCut: 0,
    swell: 0.85, chop: 1.0, glitter: 0.08, rough: 0.05, sparkle: 30, prism: 0.6, sss: 0.3, bio: [0, 0, 0], ring: [0.14, 0.38, 0.34], haze: 0.0025,
    height: 1.7, pitch: -15, exposure: 1.0, bloom: 0.4, threshold: 1.1, saturation: 1.2, contrast: 0.42
  },
  // A low sun in the picture: gold and magenta, a long path of sparkles.
  golden: {
    zenith: [0.04, 0.05, 0.3], horizon: [0.7, 0.15, 0.32], belt: [1.6, 0.5, 0.05], skyCurve: 0.55,
    sun: [3.2, 1.7, 0.55], sunElevation: 5.5, sunSpread: 9, sunRadius: 1.6, disc: 30, glow: [0.06, 0.4, 2.0],
    cloud: 0.95, cloudEdge: -0.05, cloudScale: 0.5, cloudLit: [2.0, 0.6, 0.35], cloudDark: [0.22, 0.08, 0.26],
    bank: 1, bankTop: 0.09, stars: 0, halo: 0, bands: 0.4,
    absorb: [0.07, 0.11, 0.13], scatter: [0.07, 0.03, 0.09], turbid: 0.12, sand: [0.95, 0.8, 0.62], reef: [0.1, 0.04, 0.1],
    ambient: [0.14, 0.06, 0.16], deep: [0.02, 0.03, 0.1], depth: 1.8, focus: 0.4, dispersion: 0.25, fringe: 1.5, caustic: 0.8, causticGamma: 1.5, causticCut: 0.5,
    swell: 1.0, chop: 1.0, glitter: 0.06, rough: 0.06, sparkle: 40, prism: 0.8, sss: 0.25, bio: [0, 0, 0], ring: [0.5, 0.22, 0.05], haze: 0.004,
    height: 1.6, pitch: -11, exposure: 0.85, bloom: 0.5, threshold: 1.0, saturation: 1.15, contrast: 0.35
  },
  // Night: a moon, stars, and plankton lit by the crests and the kicks.
  plankton: {
    zenith: [0.007, 0.005, 0.045], horizon: [0.0, 0.05, 0.085], belt: [0.0, 0.07, 0.09], skyCurve: 0.45,
    sun: [0.55, 0.7, 0.9], sunElevation: 13, sunSpread: 16, sunRadius: 1.5, disc: 5, glow: [0.03, 0.15, 0.8],
    cloud: 0.7, cloudEdge: 0.2, cloudScale: 0.4, cloudLit: [0.1, 0.16, 0.32], cloudDark: [0.006, 0.01, 0.03],
    bank: 0.9, bankTop: 0.07, stars: 1, halo: 0, bands: 0.3,
    absorb: [0.5, 0.14, 0.07], scatter: [0.0, 0.015, 0.03], turbid: 0.12, sand: [0.5, 0.55, 0.6], reef: [0.05, 0.08, 0.1],
    ambient: [0.01, 0.02, 0.04], deep: [0.0, 0.006, 0.02], depth: 1.5, focus: 0.4, dispersion: 0.22, fringe: 1.4, caustic: 1.0, causticGamma: 1.3, causticCut: 0,
    swell: 0.85, chop: 1.0, glitter: 0.08, rough: 0.05, sparkle: 30, prism: 0.6, sss: 0.2, bio: [0.06, 0.7, 1.4], ring: [0.05, 0.7, 1.4], haze: 0.003,
    height: 1.5, pitch: -12, exposure: 1.1, bloom: 0.6, threshold: 0.7, saturation: 1.15, contrast: 0.4
  },
  // Abstract: a white sun in a spectral halo, the dispersion far beyond water's.
  prism: {
    zenith: [0.006, 0.0, 0.03], horizon: [0.05, 0.012, 0.11], belt: [0.1, 0.02, 0.16], skyCurve: 0.5,
    sun: [2.2, 2.2, 2.2], sunElevation: 9, sunSpread: 10, sunRadius: 1.1, disc: 30, glow: [0.03, 0.12, 0.8],
    cloud: 0, cloudEdge: 0.2, cloudScale: 0.4, cloudLit: [0, 0, 0], cloudDark: [0, 0, 0],
    bank: 0, bankTop: 0.1, stars: 0.5, halo: 1, bands: 0,
    absorb: [0.08, 0.07, 0.05], scatter: [0.004, 0.006, 0.014], turbid: 0.1, sand: [0.55, 0.55, 0.62], reef: [0.2, 0.2, 0.26],
    ambient: [0.004, 0.004, 0.01], deep: [0.01, 0.0, 0.04], depth: 1.6, focus: 0.42, dispersion: 0.55, fringe: 1.8, caustic: 0.4, causticGamma: 2.0, causticCut: 0.3,
    swell: 0.75, chop: 1.0, glitter: 0.05, rough: 0.05, sparkle: 40, prism: 1.5, sss: 0.1, bio: [0, 0, 0], ring: [0.3, 0.25, 0.45], haze: 0.002,
    height: 1.6, pitch: -8, exposure: 1.0, bloom: 0.45, threshold: 0.8, saturation: 1.2, contrast: 0.4
  }
};

const WAVES = 12;
/** The waves long enough to shape the silhouette: the ones the ray is marched against. */
const BIG = 5;
const RINGS = 5;
/**
 * The steepest slope of each wave, longest first. The ripples grow gentler as they shorten, so
 * the curvature that makes the caustics comes mostly from waves of 0.4–1 m: a net with cells
 * that size, not a fizz.
 */
const SLOPES = [0.105, 0.105, 0.105, 0.1, 0.09, 0.062, 0.056, 0.05, 0.042, 0.032, 0.02, 0.011];

const SCENE = COMMON + AUDIO + /* glsl */ `
#define WAVES ${WAVES}
#define BIG ${BIG}
#define RINGS ${RINGS}
uniform vec2 uRes;
uniform vec3 uEye, uRight, uUp, uFwd;
uniform float uFocal, uFit, uPix, uClock;
// A wave: k.x, k.z, its phase now, its sharpness — and its amplitude, the mean of its profile,
// its wavelength, its slope variance.
uniform vec4 uWaveK[WAVES];
uniform vec4 uWaveA[WAVES];
// A ring: its centre, its radius now, its amplitude now — and 1 / width², its wavenumber, its light.
uniform vec4 uRing[RINGS];
uniform vec4 uRingB[RINGS];
uniform float uTop, uSlope;
uniform vec3 uSun, uSunCol, uZenith, uHorizon, uBelt, uGlow, uCloudLit, uCloudDark, uGalaxy;
uniform vec2 uSunFlat, uCloudDrift;
uniform float uSkyCurve, uSunCos, uDisc, uCloud, uCloudEdge, uCloudScale, uStars, uHalo, uBands, uBank, uBankTop;
uniform vec3 uAbsorb, uScatter, uSand, uReef, uAmbient, uBio, uSunWet, uDeep, uRingCol;
uniform vec2 uFloorOff, uSunShift, uRipple, uPrismDir;
uniform float uTurbid, uDepth, uFocus, uDisp, uCausticGamma, uCausticCut, uSunPath, uSurge, uFringe;
uniform float uGlitter, uRough, uSparkle, uDensity, uPrism, uSss, uHaze, uEyeLevel, uTwinkle;

// The spectrum by x = 0 (bass) … 1 (top). The texture is as wide as the waveform in its second
// row, and the 128 bands lie in the first part of the first: spec() alone reads past them.
float band(float x) { return spec(clamp(x, 0.0, 1.0) * 127.0 / float(textureSize(uSpec, 0).x) + 0.002); }

// ---- the sky ----

float cloudNoise(vec2 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 4; i++) { sum += amp * snoise(p); p = rot(0.6) * p * 2.07 + 11.3; amp *= 0.5; }
  return sum;
}

// The gradient, the glow on the horizon and the glow about the sun: what the haze takes its colour from.
vec3 skyBase(vec3 d) {
  float e = max(d.y, 0.0);
  float mu = max(dot(d, uSun), 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(e, uSkyCurve));
  float side = sq(0.5 + 0.5 * dot(normalize(d.xz + 1e-5), uSunFlat));
  c += uBelt * exp(-e * 9.0) * (0.3 + 0.7 * side);
  float m8 = sq(sq(sq(mu)));
  float m64 = sq(sq(sq(m8)));
  c += uSunCol * (uGlow.x * m8 + uGlow.y * m64 + uGlow.z * sq(sq(sq(m64))));
  return c;
}

vec3 stars(vec3 d) {
  vec2 a = vec2(atan(d.x, d.z), asin(clamp(d.y, -1.0, 1.0))) * 90.0;
  vec2 id = floor(a), l = fract(a) - 0.5;
  vec2 h = hash22(id), h2 = hash22(id + 37.0);
  float radius = max(0.11, 110.0 * uPix);
  float m = smoothstep(radius, 0.0, length(l - (h2 - 0.5) * 0.6)) * sq(0.11 / radius);
  float twinkle = 0.75 + 0.25 * sin(uClock * (2.0 + 5.0 * h2.x) + h.y * 40.0);
  vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.65, 0.82, 1.0), h2.y);
  // A band of the galaxy across the sky: more stars in it, and its own faint light.
  float band = exp(-sq(dot(d, uGalaxy)) * 10.0);
  float dust = vnoise(d.xz * 9.0 + d.y * 5.0) * vnoise(d.zy * 21.0 + 3.0);
  vec3 glow = band * (vec3(0.012, 0.018, 0.05) + vec3(0.1, 0.05, 0.16) * dust);
  return tint * step(0.74 - 0.3 * band, h.x) * (0.008 + pow(h.y, 6.0)) * m * twinkle * 24.0 + glow;
}

// The prism's sky. About the sun a halo: one pass through the spectrum between 3 and 18 degrees,
// red inside, in five rings. Above it a fan: the spectrum laid out by bearing about the sun, bass
// to the left, each ray reaching as far as its part of the music is loud. Both are combed into
// fibres, like an iris.
vec3 halo(vec3 d, float mu) {
  float angle = acos(clamp(mu, -1.0, 1.0));
  vec3 side = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
  vec2 about = normalize(vec2(dot(d, side), dot(d, cross(side, uSun))) + 1e-5);
  float fibre = 0.55 + 0.9 * vnoise(about * 15.0 + vec2(angle * 2.5, uClock * 0.04)) * (0.5 + vnoise(about * 4.0 + 9.0 - angle * 2.0));
  float u = atan(about.x, about.y) / PI + 0.5;
  float level = (band(u - 0.02) + band(u) + band(u + 0.02)) / 3.0;
  float reach = 0.14 + 0.7 * level;
  vec3 c = spectrum(1.0 - u) * smoothstep(-0.03, 0.08, u) * smoothstep(1.03, 0.92, u) * exp(-2.2 * angle / reach)
    * smoothstep(0.02, 0.1, angle) * (0.3 + 0.7 * fibre) * 1.6;
  float x = (angle - 0.05) / 0.26;
  if (x > 0.0 && x < 1.0) {
    float loud = band(x);
    float rings = 0.3 + 0.7 * pow(0.5 + 0.5 * cos(x * 31.4 - 0.6), 3.0);
    c += spectrum(1.0 - x) * smoothstep(0.0, 0.1, x) * smoothstep(1.0, 0.8, x) * (0.06 + 1.1 * loud * loud) * rings * fibre;
  }
  return c;
}

// soft widens the clouds' edges: the mirror of a sea too rough to draw is a blurred one.
vec3 sky(vec3 d, float direct, float soft) {
  vec3 c = skyBase(d);
  float e = max(d.y, 0.0);
  float mu = dot(d, uSun);
  if (uHalo > 0.0) c += halo(d, mu) * uHalo;
  if (uStars > 0.0) c += stars(d) * uStars * smoothstep(0.0, 0.12, e);
  float limb = (1.0 - uSunCos) * 0.2;
  c += direct * uSunCol * uDisc * smoothstep(uSunCos - limb, uSunCos + limb, mu);
  if (uCloud > 0.0) {
    // A layer overhead, seen in perspective: it closes up toward the horizon.
    vec2 cuv = d.xz / (e + 0.1) * uCloudScale * vec2(0.45, 1.0) + uCloudDrift;
    float n = cloudNoise(cuv);
    float density = smoothstep(uCloudEdge - soft, uCloudEdge + 0.22 + soft, n) * (1.0 - exp(-e * 16.0));
    float toward = max(mu, 0.0);
    float lit = saturate(0.2 + 0.9 * toward * toward * toward + 0.5 * (1.0 - density));
    vec3 cc = mix(uCloudDark, uCloudLit, lit);
    cc *= 1.0 + uBands * (band(0.1 + 0.8 * saturate(e * 3.0)) - 0.3);
    cc += uSunCol * 0.5 * pow(toward, 24.0) * (1.0 - density);
    c = mix(c, cc, density * uCloud);
  }
  if (uBank > 0.0) {
    // Cumulus on the horizon: noise over bearing and elevation, let through less the higher it stands.
    vec2 buv = vec2(atan(d.x, d.z) * 4.0 + uCloudDrift.x * 0.6, e * 13.0);
    float n = cloudNoise(buv + 40.0);
    float x = n + 0.45 - e / uBankTop;
    float density = smoothstep(-soft, 0.22 + soft, x);
    float toward = max(mu, 0.0);
    float lit = saturate(0.25 + 0.8 * e / uBankTop - 0.55 * x + 0.7 * toward * toward);
    vec3 cc = mix(uCloudDark, uCloudLit, lit);
    cc *= 1.0 + uBands * (band(0.6 * saturate(e / uBankTop)) - 0.3);
    cc += uSunCol * 0.7 * pow(toward, 16.0) * (1.0 - smoothstep(0.0, 0.5, x));
    c = mix(c, cc, density * uBank);
  }
  return c;
}

// ---- the sea ----

// What a pixel cannot resolve is faded out: 1 while a wavelength covers eight of its footprints, 0 under two and a half.
float lod(float lambda, float invFoot) { return smoothstep(2.5, 8.0, lambda * invFoot); }

// The height of the long waves and the rings: what the ray is marched against.
float heightBig(vec2 p, float invFoot) {
  float h = 0.0;
  for (int i = 0; i < BIG; i++) {
    vec4 k = uWaveK[i], a = uWaveA[i];
    h += a.x * lod(a.z, invFoot) * (exp(k.w * (sin(dot(k.xy, p) + k.z) - 1.0)) - a.y);
  }
  for (int i = 0; i < RINGS; i++) {
    vec4 r = uRing[i], b = uRingB[i];
    float x = length(p - r.xy) - r.z;
    h += r.w * exp(-x * x * b.x) * cos(b.y * x);
  }
  return h;
}

struct Field {
  float h;
  vec2 g;
  // The Hessian: xx, xz, zz.
  vec3 H;
  // Slope variance of what was faded out.
  float lost;
  // The rings' light here.
  float ring;
};

// The whole surface at p: height, slope and curvature, in closed form.
Field field(vec2 p, float invFoot) {
  Field f = Field(0.0, vec2(0.0), vec3(0.0), 0.0, 0.0);
  for (int i = 0; i < WAVES; i++) {
    vec4 k = uWaveK[i], a = uWaveA[i];
    float w = lod(a.z, invFoot);
    float th = dot(k.xy, p) + k.z;
    float s = sin(th), c = cos(th);
    float e = a.x * w * exp(k.w * (s - 1.0));
    f.h += e - a.x * w * a.y;
    f.g += e * k.w * c * k.xy;
    f.H += e * k.w * (k.w * c * c - s) * vec3(k.x * k.x, k.x * k.y, k.y * k.y);
    f.lost += a.w * (1.0 - w * w);
  }
  for (int i = 0; i < RINGS; i++) {
    vec4 r = uRing[i], b = uRingB[i];
    vec2 d = p - r.xy;
    float rr = max(length(d), 1e-3);
    vec2 n = d / rr;
    float x = rr - r.z;
    float envelope = exp(-x * x * b.x);
    float G = r.w * envelope;
    float cs = cos(b.y * x), sn = sin(b.y * x);
    float q = -2.0 * x * b.x;
    float f1 = G * (q * cs - b.y * sn);
    float f2 = G * ((q * q - 2.0 * b.x - b.y * b.y) * cs - 2.0 * q * b.y * sn);
    float around = f1 / max(rr, 0.2);
    f.h += G * cs;
    f.g += f1 * n;
    f.H += vec3(f2 * n.x * n.x + around * n.y * n.y, (f2 - around) * n.x * n.y, f2 * n.y * n.y + around * n.x * n.x);
    // The light keeps to the crest, with a little spilled about it.
    f.ring += b.z * envelope * (0.12 + 0.88 * sq(envelope * envelope));
  }
  return f;
}

// The floor: dunes, and a shelf that falls away beyond a dozen metres from the camera.
float shelfAt(vec2 rel) { return 0.012 * sq(max(length(rel) - 12.0, 0.0)); }
float depthAt(vec2 rel) { return uDepth * (0.5 + vnoise((rel + uFloorOff) * 0.11)) + shelfAt(rel); }

vec3 floorAlbedo(vec2 q, float invFoot) {
  float n1 = vnoise(q * 0.6), n2 = vnoise(q * 0.6 + 31.7);
  // Ripple marks in the sand, and darker beds of weed.
  float phase = dot(q + 0.5 * vec2(n1, n2), uRipple) + 3.0 * n2;
  float ripple = 1.0 - 2.0 * abs(sin(0.5 * phase)) + 0.3 * sin(2.0 * phase + 1.0);
  float fine = lod(0.3, invFoot);
  float bedNoise = 0.7 * vnoise(q * 0.21 + 5.3) + 0.3 * vnoise(q * 1.1);
  float beds = smoothstep(0.54, 0.6, bedNoise + 0.05 * (n1 - 0.5) * fine);
  vec3 sand = uSand * (0.84 + (0.17 * ripple + 0.22 * (vnoise(q * 17.0) - 0.5)) * fine + 0.16 * (vnoise(q * 53.0) - 0.5) * lod(0.08, invFoot));
  // Stones lying about on the sand, more of them toward the weed.
  vec2 cell = q * 2.6, id = floor(cell);
  vec2 h = hash22(id), h2 = hash22(id + 19.4);
  float stone = smoothstep(1.0, 0.75, length(fract(cell) - 0.5 - (h - 0.5) * 0.55) / (0.05 + 0.17 * h2.x));
  stone *= step(0.88 - 0.9 * smoothstep(0.4, 0.56, bedNoise), h2.y) * lod(0.25, invFoot);
  sand = mix(sand, uReef * (0.6 + 0.8 * h2.x), stone);
  vec3 reef = uReef * (0.35 + 1.3 * vnoise(q * 3.1) * (0.6 + 0.8 * n2));
  return mix(sand, reef, beds);
}

// Points of light that stand still on the screen's own grid of the sea (bearing × 1 / distance
// about the camera), each with its own slow beat, hurried along by the slope passing under it:
// they come and go smoothly and never jump.
vec3 sparkles(vec2 rel, vec2 slope, float density, float shift) {
  float cell = max(3.6 * uPix, 0.0045);
  vec2 g = vec2(atan(rel.x, rel.y) * 0.7, uEyeLevel / max(length(rel), 0.5)) / cell + shift;
  vec2 id = floor(g), l = fract(g) - 0.5;
  vec2 h1 = hash22(id), h2 = hash22(id + 71.3), h3 = hash22(id + 113.1);
  float m = smoothstep(0.3, 0.04, length(l - (h2 - 0.5) * 0.4)) * step(1.0 - density, h1.x);
  float phase = h1.y * TAU + uClock * uTwinkle * (2.0 + 4.0 * h3.x) + 18.0 * dot(slope, h2 * 2.0 - 1.0);
  // The channels peak one after another: a glint passes through the spectrum as it flashes.
  vec3 beat = 0.5 + 0.5 * sin(phase + vec3(-0.2, 0.0, 0.2) * uPrism);
  beat *= beat; beat *= beat; beat *= beat;
  // A few are far brighter than the rest.
  float power = 0.12 + 5.0 * sq(sq(h3.y)) * h3.y;
  return m * beat * beat * power;
}

vec3 water(vec3 rd, float sinE) {
  // To the surface: steps that cannot pass a crest, from the plane no crest reaches.
  float t = max((uEye.y - uTop) / sinE, 0.05);
  float footScale = sqrt(max(sinE, 0.004)) / uPix;
  for (int i = 0; i < 14; i++) {
    vec3 p = uEye + rd * t;
    float d = p.y - heightBig(p.xz, footScale / t);
    t += d / (sinE + uSlope);
    if (d < 0.0015 * t) break;
  }
  float invFoot = footScale / t;
  vec3 P = uEye + rd * t;
  Field s = field(P.xz, invFoot);
  // One Newton step onto the whole surface, ripples included.
  float newton = (P.y - s.h) / max(sinE + dot(s.g, rd.xz), 0.08);
  t += clamp(newton, -0.1 * t, 0.1 * t);
  P = uEye + rd * t;

  vec3 V = -rd;
  vec3 N = normalize(vec3(-s.g.x, 1.0, -s.g.y));
  float nv = dot(N, V);
  if (nv < 0.03) { N = normalize(N + V * (0.03 - nv)); nv = dot(N, V); }
  float fresnel = 0.02 + 0.98 * pow(1.0 - saturate(nv), 5.0);

  // Above: the sky in the mirror.
  vec3 R = reflect(rd, N);
  // Slopes too fine to draw face the eye more often than not: the far sea mirrors the sky higher up.
  R.y = abs(R.y) + 0.003 + 1.6 * sqrt(0.5 * s.lost);
  vec3 above = sky(normalize(R), 0.0, min(0.6, 5.0 * sqrt(s.lost) + 0.25 * smoothstep(4.0, 30.0, t)));

  // Below: the refracted ray to the floor.
  vec3 T = refract(rd, N, 0.752);
  float depth = depthAt(P.xz);
  float tf = (P.y + depth) / -T.y;
  vec2 Q = P.xz + T.xz * tf;
  depth = depthAt(Q);
  tf = (P.y + depth) / -T.y;
  Q = P.xz + T.xz * tf;

  // Caustics. Sunlight reaching Q crossed the surface at p with Q = p + shift + c d grad h(p);
  // p is found by two steps back, and the light there is 1 / |det(I + c d H(p))|.
  float cd = uFocus * depth;
  vec2 src = Q - uSunShift * depth;
  Field a = field(src, invFoot);
  Field b = field(src - cd * a.g, invFoot);
  float tr = b.H.x + b.H.z;
  float dt = b.H.x * b.H.z - b.H.y * b.H.y;
  // How far the trace and the determinant move from this pixel to the next: a line is drawn no
  // thinner than that.
  float trStep = fwidth(tr), dtStep = fwidth(dt);
  vec3 light = vec3(0.0), norm = vec3(0.0);
  for (int j = 0; j < 8; j++) {
    float x = (float(j) + 0.5) / 8.0;
    // Violet (x = 0) bends most.
    float c = cd * (1.0 + uDisp * (1.0 - 2.0 * x));
    float det = 1.0 + c * tr + c * c * dt;
    // The line is as wide as the step to the next wavelength, so the eight make one spectrum.
    float spread = (tr + 2.0 * c * dt) * cd * uDisp * 0.25;
    float pixel = 0.9 * (c * trStep + c * c * dtStep);
    float intensity = inversesqrt(det * det + spread * spread + pixel * pixel + 0.0008);
    // Past the fold three sheets of light overlap.
    intensity *= 1.0 + 0.45 * smoothstep(0.05, -0.05, det);
    vec3 w = spectrum(x);
    light += w * intensity;
    norm += w;
  }
  light /= norm;
  // The fringes a little purer than the eight samples leave them.
  light = max(mix(vec3(dot(light, vec3(0.3333))), light, uFringe), 0.0);
  light = pow(light, vec3(uCausticGamma));
  // A low sun lights the floor only where the surface gathers it.
  light = max(light - uCausticCut, 0.0);
  light *= 1.0 + uSurge * b.ring;
  vec3 through = exp(-uAbsorb * (tf + depth * uSunPath));
  vec3 below = floorAlbedo(Q + uFloorOff, invFoot) * (uSunWet * light + uAmbient) * through;
  below += uScatter * (1.0 - exp(-uTurbid * tf * 3.0));
  below = mix(below, uDeep, 1.0 - exp(-shelfAt(Q) * 0.3));
  // The ring a kick left carries light in the water under it.
  below += uRingCol * s.ring;

  vec3 col = mix(below, above, fresnel);

  // The sun on the water: the share of slopes that send it to the eye, from the slope drawn
  // here and the spread of the slopes too fine to draw.
  vec3 Hh = normalize(uSun + V);
  vec2 off = (-Hh.xz / max(Hh.y, 0.05)) - s.g;
  float var = uRough * uRough + 0.5 * s.lost;
  vec2 fringe = uPrismDir * uPrism * sqrt(var);
  vec3 lobe = exp(-vec3(dot(off - fringe, off - fringe), dot(off, off), dot(off + fringe, off + fringe)) / (2.0 * var)) / (2.0 * var);
  float fh = 0.02 + 0.98 * pow(1.0 - saturate(dot(V, Hh)), 5.0);
  vec3 glint = uSunCol * uGlitter * fh * lobe / (4.0 * sq(sq(Hh.y)) * max(nv, 0.08));
  glint = min(glint, vec3(60.0));
  col += glint * (0.35 + uSparkle * smoothstep(2.5, 9.0, t) * sparkles(P.xz, s.g, uDensity, 0.0));

  // Light through the crests, toward the sun.
  float lift = saturate(s.h / uTop * 0.6 + 0.4);
  float back = sq(saturate(dot(normalize(rd.xz), uSunFlat) * 0.5 + 0.5));
  col += uScatter * uSunCol * uSss * lift * lift * (0.25 + back) * (1.0 - fresnel) * (1.0 + 2.0 * s.ring);

  // Plankton: light along the lines where the surface is bent hardest, where the sea is stirred.
  if (uBio.b > 0.0) {
    float bent = saturate(-(s.H.x + s.H.z) * 0.3 - 0.1);
    float stirred = sq(saturate(s.h / uTop + 0.15)) + 2.5 * s.ring + 0.05;
    vec3 motes = sparkles(P.xz, s.g, 0.5, 19.7);
    col += uBio * stirred * (bent * bent * 2.0 + (motes.r + motes.g + motes.b) * 3.0);
  }

  // Distance takes the colour of the sky it lies under.
  vec3 far = skyBase(normalize(vec3(rd.x, 0.02, rd.z)));
  return mix(col, far, 1.0 - exp(-t * uHaze));
}

void main() {
  vec2 sp = (vUv * 2.0 - 1.0) * vec2(uRes.x / uRes.y, 1.0) * uFit;
  vec3 rd = normalize(uFwd * uFocal + uRight * sp.x + uUp * sp.y);
  float sinE = -rd.y;
  // The horizon is drawn across a pixel and a half.
  float edge = 1.5 * uPix;
  vec3 col = vec3(0.0);
  if (sinE < edge) col = sky(sinE < 0.0 ? rd : normalize(vec3(rd.x, 0.0, rd.z)), 1.0, 0.0);
  if (sinE > 0.0) {
    vec3 sea = water(rd, max(sinE, 1e-5));
    col = sinE < edge ? mix(col, sea, sinE / edge) : sea;
  }
  fragColor = vec4(max(col, 0.0), 1.0);
}
`;

interface Wave {
  kx: number;
  kz: number;
  omega: number;
  phase: number;
  sharp: number;
  /** The mean of exp(s (sin θ - 1)): taken off, so a wave growing does not lift the sea. */
  mean: number;
  amp: number;
  lambda: number;
  /** Its greatest slope and its slope variance, at gain 1. */
  slope: number;
  variance: number;
}

interface Ring {
  x: number;
  z: number;
  age: number;
  strength: number;
}

/** The profile exp(s (sin θ - 1)): its mean, its steepest slope, its mean square slope. */
function profile(sharp: number): { mean: number; slopeMax: number; slopeVariance: number } {
  let mean = 0;
  let slopeMax = 0;
  let slopeVariance = 0;
  const count = 96;
  for (let index = 0; index < count; index += 1) {
    const theta = (index + 0.5) / count * Math.PI * 2;
    const value = Math.exp(sharp * (Math.sin(theta) - 1));
    const slope = sharp * Math.cos(theta) * value;
    mean += value / count;
    slopeMax = Math.max(slopeMax, Math.abs(slope));
    slopeVariance += slope * slope / count;
  }
  return { mean, slopeMax, slopeVariance };
}

function follow(current: number, target: number, dt: number, attack: number, release: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / (target > current ? attack : release)));
}

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const look = LOOKS[preset] ?? LOOKS.lagoon!;
  const random = seededRandom(seed * 7919 + 13);
  const program = kit.program(SCENE);
  let scene: Target | null = null;

  // What the seed decides: where the waves come from, where the sun stands, the floor under
  // the camera, how high the camera hangs.
  const windward = Math.PI + (random() - 0.5) * 1.5;
  const waves: Wave[] = [];
  for (let index = 0; index < WAVES; index += 1) {
    const u = index / (WAVES - 1);
    const lambda = 11 * Math.pow(0.02, u) * (0.88 + 0.24 * random());
    const k = Math.PI * 2 / lambda;
    const direction = windward + (0.3 + 1.25 * u) * (random() * 2 - 1);
    const sharp = 1.9 - 1.1 * u;
    const shape = profile(sharp);
    const slope = SLOPES[index] ?? 0.02;
    const amp = slope / (k * shape.slopeMax);
    waves.push({
      kx: k * Math.sin(direction), kz: k * Math.cos(direction),
      // Deep-water waves, the ripples held back so the net on the floor does not flicker.
      omega: Math.sqrt(9.81 * k) * (0.3 + 0.7 * Math.min(1, lambda / 4)),
      phase: random() * Math.PI * 2, sharp, mean: shape.mean, amp, lambda, slope,
      variance: amp * amp * k * k * shape.slopeVariance
    });
  }
  const sunBearing = (random() * 2 - 1) * look.sunSpread * Math.PI / 180;
  const sunElevation = look.sunElevation * (0.9 + 0.2 * random()) * Math.PI / 180;
  // The sun's ray under water (Snell, into n = 1.33): how far it runs sideways per metre of depth.
  const under = Math.sqrt(1 - 0.752 * 0.752 * Math.cos(sunElevation) * Math.cos(sunElevation));
  const sunWet = 1 - (0.02 + 0.98 * Math.pow(1 - Math.sin(sunElevation), 5));
  const eyeLevel = look.height * (0.88 + 0.3 * random());
  const floorSeed = [random() * 900, random() * 900];
  const rippleAngle = random() * Math.PI;
  const ripple = [Math.cos(rippleAngle) * 21, Math.sin(rippleAngle) * 21];
  const prismAngle = random() * Math.PI * 2;
  const cloudSeed = [random() * 50, random() * 50];
  const swayPhase = random() * Math.PI * 2;
  const galaxyAngle = (random() - 0.5) * 1.2;
  const galaxy = [Math.cos(galaxyAngle) * 0.9, -0.3, Math.sin(galaxyAngle) * 0.9].map((value) => value / Math.hypot(0.9, 0.3));

  const waveK = new Float32Array(WAVES * 4);
  const waveA = new Float32Array(WAVES * 4);
  const ringA = new Float32Array(RINGS * 4);
  const ringB = new Float32Array(RINGS * 4);
  const envelope = new Float32Array(WAVES);
  const rings: Ring[] = [];
  for (let index = 0; index < RINGS; index += 1) rings.push({ x: 0, z: 8, age: 100, strength: 0 });
  let nextRing = 0;
  let impactX = 0;
  let impactZ = 8;
  let impactKicks = 0;
  let clock = random() * 40;
  let travel = 0;
  let cloudDrift = 0;
  let ride = 0;
  let swell = 0.4;
  let energy = 0.4;

  return {
    render(frame: FvFrame): void {
      const f = frame.audio.features;
      const spectrum = frame.audio.spectrum;
      const dt = Math.min(0.1, frame.dt);
      const aspect = frame.width / frame.height;
      const [width, height] = workSize(frame);
      scene = kit.fit(scene, width, height, "rgba16f");
      const loud = f.level * f.presence;
      // An upright picture sees less to either side: the sun keeps inside it.
      const sunAzimuth = sunBearing * Math.min(1, 0.4 + 0.6 * aspect);
      const sun = [Math.sin(sunAzimuth) * Math.cos(sunElevation), Math.sin(sunElevation), Math.cos(sunAzimuth) * Math.cos(sunElevation)];
      const sunFlat = [Math.sin(sunAzimuth), Math.cos(sunAzimuth)];
      const sunShift = sunFlat.map((value) => -value * 0.752 * Math.cos(sunElevation) / under);

      // The sea's own clock runs a little faster with the music; the camera drifts forward.
      clock += dt * (0.75 + 0.45 * loud);
      const speed = 0.45 + 0.6 * loud;
      travel += dt * speed;
      cloudDrift += dt * (0.004 + 0.006 * loud);
      swell = follow(swell, f.bass * f.presence, dt, 0.5, 1.4);
      energy = follow(energy, loud, dt, 2.5, 4);

      // Every wave follows its own part of the spectrum: the long ones the bass, the ripples the top.
      let top = 0;
      let steep = 0;
      let rideNow = 0;
      for (let index = 0; index < WAVES; index += 1) {
        const wave = waves[index]!;
        const big = index < BIG;
        const centre = Math.round(4 + index / (WAVES - 1) * 100);
        let band = 0;
        for (let offset = -4; offset <= 4; offset += 1) band += (spectrum[centre + offset] ?? 0) / 9;
        const slow = frame.gentle ? 2 : 1;
        envelope[index] = follow(envelope[index]!, band, dt, (big ? 0.3 : 0.12) * slow, (big ? 1.2 : 0.55) * slow);
        const gain = big ? look.swell * (0.5 + 0.55 * envelope[index]! + 0.4 * swell) : look.chop * (0.5 + 0.9 * envelope[index]!);
        const phase = (wave.phase + wave.kz * travel - wave.omega * clock) % (Math.PI * 2);
        waveK.set([wave.kx, wave.kz, phase, wave.sharp], index * 4);
        waveA.set([wave.amp * gain, wave.mean, wave.lambda, wave.variance * gain * gain], index * 4);
        if (big) {
          top += wave.amp * gain * (1 - wave.mean);
          steep += wave.slope * gain;
          rideNow += wave.amp * gain * (Math.exp(wave.sharp * (Math.sin(phase) - 1)) - wave.mean);
        }
      }

      // A kick drops a ring. Eight kicks fall on one spot, so the rings leave it as a train.
      if (f.onset) {
        if (impactKicks % 8 === 0 || impactZ < 3.5) {
          const reach = 4.5 + 5.5 * random();
          const bearing = (random() * 2 - 1) * Math.min(0.4, 0.4 * aspect);
          impactX = reach * Math.sin(bearing);
          impactZ = reach * Math.cos(bearing);
        }
        impactKicks += 1;
        const ring = rings[nextRing]!;
        nextRing = (nextRing + 1) % RINGS;
        ring.x = impactX;
        ring.z = impactZ;
        ring.age = 0;
        ring.strength = 0.55 + 0.45 * Math.min(1, f.bass + 0.3);
      }
      impactZ -= dt * speed;
      let ringSteep = 0;
      for (let index = 0; index < RINGS; index += 1) {
        const ring = rings[index]!;
        ring.age += dt;
        ring.z -= dt * speed;
        const radius = 0.25 + 3.2 * ring.age;
        const ringWidth = 0.5 + 0.15 * ring.age;
        const amplitude = (frame.gentle ? 0.05 : 0.09) * ring.strength * Math.min(1, ring.age / 0.1) * Math.exp(-ring.age / 1.4) / Math.sqrt(1 + 0.5 * radius);
        const lit = ring.strength * Math.min(1, ring.age / 0.08) * Math.exp(-ring.age / 1.1);
        ringA.set([ring.x, ring.z, radius, amplitude], index * 4);
        ringB.set([1 / (ringWidth * ringWidth), 5.0, lit, 0], index * 4);
        top += amplitude;
        ringSteep = Math.max(ringSteep, amplitude * 5.0);
      }

      // The camera rides a part of the swell under it, and looks about slowly.
      ride = follow(ride, rideNow, dt, 0.35, 0.35);
      // It hangs higher and looks further down while the music is loud, and sinks to the water when it is quiet.
      const eye = eyeLevel * (0.86 + 0.12 * Math.sin(f.time * 0.097 + swayPhase * 1.7) + 0.32 * energy) + 0.45 * ride;
      const yaw = 0.12 * Math.sin(f.time * 0.083 + swayPhase) + 0.03 * Math.sin(f.time * 0.27);
      const pitch = (look.pitch + 1.8 * Math.sin(f.time * 0.13 + swayPhase * 2) + 2 - 4 * energy) * Math.PI / 180 - 0.05 * ride;
      const roll = 0.02 * Math.sin(f.time * 0.23 + swayPhase * 3);
      const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const level = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const over = [
        forward[1]! * level[2]! - forward[2]! * level[1]!,
        forward[2]! * level[0]! - forward[0]! * level[2]!,
        forward[0]! * level[1]! - forward[1]! * level[0]!
      ];
      const right = level.map((value, index) => value * Math.cos(roll) + over[index]! * Math.sin(roll));
      const up = over.map((value, index) => value * Math.cos(roll) - level[index]! * Math.sin(roll));
      const focal = 1.7;
      // Upright, the picture keeps its width of view and gains height.
      const fit = Math.max(1, 0.62 / aspect);

      kit.draw(program, scene, {
        ...frame.audio.uniforms(kit),
        uRes: [width, height], uEye: [0, eye, 0], uRight: right, uUp: up, uFwd: forward, uFocal: focal, uFit: fit,
        uPix: 2 * fit / (focal * height), uClock: clock,
        uWaveK: waveK, uWaveA: waveA, uRing: ringA, uRingB: ringB,
        uTop: Math.max(0.05, top), uSlope: 0.75 * steep + 0.5 * ringSteep + 0.04,
        uSun: sun, uSunCol: look.sun, uSunFlat: sunFlat, uZenith: look.zenith, uHorizon: look.horizon, uBelt: look.belt,
        uGlow: look.glow, uSkyCurve: look.skyCurve, uSunCos: Math.cos(look.sunRadius * Math.PI / 180), uDisc: look.disc,
        uCloud: look.cloud, uCloudEdge: look.cloudEdge, uCloudScale: look.cloudScale, uCloudLit: look.cloudLit, uCloudDark: look.cloudDark,
        uCloudDrift: [cloudSeed[0]! + cloudDrift, cloudSeed[1]! - travel * 0.002],
        uStars: look.stars, uGalaxy: galaxy, uHalo: look.halo, uBands: look.bands, uBank: look.bank, uBankTop: look.bankTop, uDeep: look.deep,
        uAbsorb: look.absorb, uScatter: look.scatter, uTurbid: look.turbid, uSand: look.sand, uReef: look.reef, uAmbient: look.ambient,
        uBio: look.bio, uRingCol: look.ring.map((value) => value * (frame.gentle ? 0.5 : 1)), uSunWet: look.sun.map((value) => value * sunWet * look.caustic),
        uFloorOff: [floorSeed[0]!, floorSeed[1]! + travel % 8192], uSunShift: sunShift, uRipple: ripple,
        uPrismDir: [Math.cos(prismAngle), Math.sin(prismAngle)],
        uDepth: look.depth, uFocus: look.focus, uDisp: look.dispersion, uFringe: look.fringe, uCausticGamma: look.causticGamma, uCausticCut: look.causticCut, uSunPath: 1 / under,
        uSurge: frame.gentle ? 0 : 2,
        uGlitter: look.glitter, uRough: look.rough, uSparkle: look.sparkle * (0.5 + 0.7 * f.high + 0.6 * f.hat) * (frame.gentle ? 0.6 : 1),
        uDensity: 0.3 + 0.45 * f.high + 0.25 * f.air, uPrism: look.prism, uSss: look.sss, uHaze: look.haze, uEyeLevel: eyeLevel,
        uTwinkle: frame.gentle ? 0.5 : 1
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom, threshold: look.threshold, vignette: 0.3, contrast: look.contrast,
        saturation: look.saturation, gentle: frame.gentle
      });
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "ocean-of-light",
  order: 5,
  kind: "vivid",
  labelPl: "Ocean światła",
  labelEn: "Ocean of Light",
  descriptionPl: "Krystaliczne morze, którego fale są muzyką — na dnie tańczy tęczowa sieć kaustyk, a ku horyzontowi woda staje się lustrem nieba z drogą iskier.",
  usesSource: false,
  gentleByDefault: false,
  presets: [
    { id: "lagoon", labelPl: "Laguna", labelEn: "Lagoon" },
    { id: "golden", labelPl: "Złota godzina", labelEn: "Golden Hour" },
    { id: "plankton", labelPl: "Bioluminescencja", labelEn: "Bioluminescence" },
    { id: "prism", labelPl: "Pryzmat", labelEn: "Prism" }
  ],
  create
};
