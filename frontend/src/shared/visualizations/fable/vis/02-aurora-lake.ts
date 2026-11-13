import { COMMON } from "../core/glsl";
import { Kit, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Zorza nad jeziorem — Aurora over a Mirror Lake.
 *
 * A polar night seen from a lake shore. The aurora is a set of thin luminous sheets standing on
 * curves in the ground plane, a hundred kilometres up, all running toward one vanishing point
 * on the horizon. A view ray is walked across the strip of ground each curve can occupy; between
 * two samples the sheet's density is integrated in closed form (a sech² profile across the
 * sheet, whose integral is a tanh), so a sheet a pixel thin never bands, and where the line of
 * sight runs along a fold the light piles up as it does in the sky. What a sheet emits at the
 * crossing is a vertical profile (a hard bright hem, a long fringe above it) times fine rays
 * laid along the curve.
 *
 * The sky (aurora, stars, the Milky Way, mountains, the far shore) is drawn once into an HDR
 * target; the lake is that target looked up through a mirrored ray bent by the water's slopes,
 * spread along the vertical the way water draws lights into streaks.
 *
 * The spectrum plays along the ribbons (each band has its place on every curtain), a kick sends
 * a wave of light up from the hems and a ring across the lake, mids set how fast the curtains
 * sway, highs make the fine rays shimmer and the stars twinkle.
 */

interface Look {
  /** The hem, the body (two tints the ribbons wander between), the high fringe; linear. */
  low: [number, number, number];
  body: [number, number, number];
  body2: [number, number, number];
  top: [number, number, number];
  /** What a kick lights at the hem. */
  flare: [number, number, number];
  /** How far the rays and the fringe reach up (in units of the hem's altitude). */
  bodyScale: number;
  topScale: number;
  topGain: number;
  zenith: [number, number, number];
  horizon: [number, number, number];
  exposure: number;
  bloom: number;
}

const LOOKS: Record<string, Look> = {
  // Oxygen green with the violet fringe; kicks light the pink lower border.
  polar: {
    low: [0.5, 1.0, 0.42], body: [0.06, 1.0, 0.3], body2: [0.02, 0.9, 0.55], top: [0.5, 0.12, 0.95], flare: [1.0, 0.22, 0.6],
    bodyScale: 0.42, topScale: 1.05, topGain: 0.55, zenith: [0.0022, 0.0036, 0.0105], horizon: [0.005, 0.012, 0.024], exposure: 1.0, bloom: 0.5
  },
  violet: {
    low: [1.0, 0.32, 0.7], body: [0.5, 0.14, 1.0], body2: [0.95, 0.12, 0.55], top: [0.12, 0.22, 1.0], flare: [1.0, 0.75, 0.9],
    bodyScale: 0.46, topScale: 1.15, topGain: 0.7, zenith: [0.003, 0.003, 0.011], horizon: [0.008, 0.009, 0.026], exposure: 1.05, bloom: 0.5
  },
  ice: {
    low: [0.55, 1.0, 0.95], body: [0.04, 0.62, 1.0], body2: [0.06, 0.95, 0.7], top: [0.2, 0.18, 1.0], flare: [0.85, 0.95, 1.0],
    bodyScale: 0.44, topScale: 1.0, topGain: 0.6, zenith: [0.002, 0.0035, 0.012], horizon: [0.004, 0.012, 0.028], exposure: 1.05, bloom: 0.5
  },
  // The rare one: a tall blood-red crown over a thin green hem.
  crown: {
    low: [0.7, 1.0, 0.3], body: [0.12, 1.0, 0.22], body2: [0.45, 0.95, 0.1], top: [1.0, 0.05, 0.09], flare: [1.0, 0.55, 0.2],
    bodyScale: 0.3, topScale: 1.7, topGain: 1.25, zenith: [0.0034, 0.0028, 0.009], horizon: [0.009, 0.009, 0.02], exposure: 1.0, bloom: 0.5
  }
};

const CURTAINS = 6;
const PULSES = 4;
const RINGS = 6;
/** The aurora is drawn at this share of the picture's size: it is soft, and bloom is laid over it. */
const AURORA_SCALE = 0.7;

/** The camera both passes share: a wide lens, pitched up so the horizon lies at 40 % of the height. */
const CAMERA = /* glsl */ `
uniform float uAspect, uTanV, uPitch;
vec3 viewRay(vec2 uv) {
  vec2 n = (uv * 2.0 - 1.0) * vec2(uAspect * uTanV, uTanV);
  float c = cos(uPitch), s = sin(uPitch);
  return normalize(vec3(n.x, n.y * c + s, c - n.y * s));
}
vec2 project(vec3 d) {
  float c = cos(uPitch), s = sin(uPitch);
  float z = max(d.y * s + d.z * c, 1e-3);
  return vec2(d.x, d.y * c - d.z * s) / z / vec2(uAspect * uTanV, uTanV) * 0.5 + 0.5;
}
`;

const AURORA = COMMON + CAMERA + /* glsl */ `
#define CURTAINS ${CURTAINS}
#define PULSES ${PULSES}
#define STEPS 18
// Half of the strip of ground a curtain's curve stays within.
#define BAND 0.68
// The sheet's thickness.
#define WIDTH 0.02
// Earth's curvature, in units of the hem's altitude (100 km): far curtains sink to the horizon.
#define CURVE (1.0 / (2.0 * 63.7))
uniform sampler2D uSpec;
uniform vec2 uRes;
uniform float uFrame;
uniform vec2 uDir, uNrm, uTilt;
uniform vec4 uCurtain[CURTAINS];
uniform vec4 uPulse[PULSES];
uniform float uSway, uShimmer, uQuiet, uGain, uCurl, uFlare, uBodyScale, uTopScale, uTopGain;
uniform vec3 uColLow, uColBody, uColBody2, uColTop, uColFlare;

float band(float x) { return textureLod(uSpec, vec2(clamp(x, 0.004, 0.996), 0.25), 0.0).r; }
float sech2(float x) { float e = exp(-min(abs(x), 20.0)); float c = 2.0 * e / (1.0 + e * e); return c * c; }
float tanhs(float x) { float e = exp(-2.0 * min(abs(x), 20.0)); return sign(x) * (1.0 - e) / (1.0 + e); }
// The mean of sech²(g / w) along a stretch over which g runs from g0 to g1.
float sheet(float g0, float g1, float w) {
  float d = g1 - g0;
  if (abs(d) < 1e-3 * w) return sech2(0.5 * (g0 + g1) / w);
  return w * (tanhs(g1 / w) - tanhs(g0 / w)) / d;
}
// How much of a wave survives when a step along the ray advances its phase by x.
float lod(float x) { return smoothstep(1.9, 0.7, x); }

// A curtain's line on the ground: where it stands across (v) as a function of along (u).
// A wide meander, folds that travel along it, and small curls the bass tightens.
float curve(float u, float p, float lodFold, float lodCurl) {
  float a = uSway;
  float w = 0.40 * sin(0.85 * u + 0.30 * a + p + 1.2 * sin(0.33 * u - 0.17 * a + p * 1.7));
  w += lodFold * 0.15 * sin(3.1 * u - 0.75 * a + p * 3.3 + 1.5 * sin(0.9 * u + 0.4 * a + p * 0.6));
  w += lodCurl * uCurl * sin(7.3 * u + 1.9 * a + p * 7.7 + 2.2 * sin(1.9 * u - 0.8 * a + p));
  return w;
}

// What the sheet emits at a place along it (u) and an altitude (y; the hem is near 1).
vec3 emission(float u, float y, vec4 ca, float t, float foot) {
  float k = ca.y;
  // The music's place along the ribbon: the spectrum folded back and forth over the sweep.
  float sweep = atan(u, abs(ca.x)) / PI;
  float at = abs(fract(sweep * 1.25 + ca.w) * 2.0 - 1.0) * 0.9 + 0.03;
  float sp = 0.5 * (band(at - 0.008) + band(at + 0.008));
  // The loud bands tower, the middling ones stay low: the ribbon keeps the spectrum's outline.
  sp *= 0.3 + 0.7 * sp;
  // Stretches of the ribbon brighten and fade on their own, music or none.
  float env = 0.5 + 0.5 * sin(0.55 * u + k * 2.0 + 0.11 * uSway + 1.4 * sin(0.21 * u - 0.07 * uSway + k));
  float act = uQuiet * (0.3 + 0.7 * env) + uGain * sp * (0.55 + 0.45 * env);
  float hem = 1.0 + 0.06 * sin(0.7 * u + k * 4.1 + 0.15 * uSway) - 0.05 * sp;
  float h = y - hem;
  if (h < -0.012) return vec3(0.0);
  // Rays: bundles and fine threads, each fading to its mean before a pixel can hold two of them.
  float ra = vnoise(vec2(u * 7.0 + k * 31.7, uShimmer * 0.3 + k));
  float rb = vnoise(vec2(u * 26.0 - k * 17.3, uShimmer * 0.8 - k * 3.0));
  ra = mix(0.5, ra, saturate(1.7 - foot * 7.0 * 3.0));
  rb = mix(0.5, rb, saturate(1.7 - foot * 26.0 * 3.0));
  float reach = (0.4 + 1.25 * ra * ra) * (0.5 + 0.9 * act);
  float fine = 0.5 + 1.0 * rb * mix(1.0, 0.45, saturate(h * 1.3));
  float edge = smoothstep(-0.008, 0.028, h);
  float low = edge * exp(-h / 0.075);
  float body = edge * exp(-h / (uBodyScale * reach));
  float top = smoothstep(0.05, 0.75, h) * exp(-h / (uTopScale * (0.55 + 0.8 * act)));
  // Kicks: waves of light that climb from the hem.
  // The crest is the wave's front: sharp above, a trail below it.
  float pulse = 0.0, crest = 0.0;
  for (int i = 0; i < PULSES; i++) {
    // Each bundle of rays carries it at its own pace: the front is ragged, not a ruled line.
    float hp = uPulse[i].x * (0.82 + 0.36 * ra);
    float d = h - hp;
    pulse += uPulse[i].y * exp(-sq(d / (0.09 + 0.3 * hp)));
    crest += uPulse[i].y * (d > 0.0 ? exp(-sq(d / (0.05 + 0.13 * hp))) : exp(d / (0.07 + 0.16 * hp)));
  }
  vec3 bodyCol = mix(uColBody, uColBody2, 0.5 + 0.5 * sin(0.4 * u + k * 5.0 + 0.05 * uSway));
  vec3 c = uColLow * low * 1.5 * (0.35 + act)
         + bodyCol * body * fine * (0.3 + 1.3 * ra) * (0.4 + act)
         + uColTop * top * uTopGain * (0.45 + 0.9 * ra) * (0.3 + act);
  c *= 1.0 + 1.1 * pulse;
  c += uColFlare * low * (uFlare + 1.2 * pulse) * (0.4 + act);
  // The front lights the rays where they have already faded, so it is seen all the way up.
  c += mix(bodyCol, uColFlare, 0.3) * crest * edge * fine * (0.3 + 1.3 * ra) * (0.35 + 0.65 * act) * exp(-h / (uBodyScale * 2.6)) * 1.5;
  // Far ribbons: dimmer and bluer through the air.
  c *= exp(-t * 0.1) * mix(vec3(1.0), vec3(0.6, 0.9, 1.3), saturate(t / 13.0));
  return c * ca.z;
}

vec3 curtain(vec4 ca, vec3 rd, float tLow, float tHigh, float pix, float dither) {
  // The sheet leans with altitude (the field lines are not quite vertical).
  float du = dot(rd.xz, uDir) - uTilt.x * rd.y;
  float dv = dot(rd.xz, uNrm) - uTilt.y * rd.y;
  float u0 = uTilt.x, v0 = uTilt.y - ca.x;
  float inv = 1.0 / (abs(dv) < 1e-4 ? 1e-4 : dv);
  float ta = (-BAND - v0) * inv, tb = (BAND - v0) * inv;
  float tn = max(min(ta, tb), tLow), tf = min(max(ta, tb), tHigh);
  if (tf <= tn) return vec3(0.0);
  // Steps even in 1 / t: as fine near as they are coarse far, like the picture itself. They
  // start at a different depth in every pixel and frame, so what the straight stretches miss
  // (a sheet seen edge-on) shows as grain, not as facets.
  float in0 = 1.0 / tn;
  float dInv = (in0 - 1.0 / tf) / float(STEPS);
  float su = abs(du) * tn * tn * dInv;
  float tPrev = tn;
  float gPrev = dv * tn + v0 - curve(du * tn + u0, ca.y, lod(3.1 * su), lod(7.3 * su));
  vec3 sum = vec3(0.0);
  for (int i = 0; i <= STEPS; i++) {
    float t = 1.0 / (in0 - dInv * min(float(i) + dither, float(STEPS)));
    float dt = t - tPrev;
    su = abs(du) * dt;
    float lodFold = lod(3.1 * su), lodCurl = lod(7.3 * su);
    float g = dv * t + v0 - curve(du * t + u0, ca.y, lodFold, lodCurl);
    float weight = 0.0, tc = t, rate = 1.0;
    if (gPrev * g < 0.0) {
      // The ray passes through the sheet here: one more sample where a straight line says the
      // crossing is, and the stretch is two straight pieces — the hem stays where it belongs.
      float tm = mix(tPrev, t, gPrev / (gPrev - g));
      float gm = dv * tm + v0 - curve(du * tm + u0, ca.y, lodFold, lodCurl);
      weight = sheet(gPrev, gm, WIDTH) * (tm - tPrev) + sheet(gm, g, WIDTH) * (t - tm);
      bool first = gPrev * gm <= 0.0;
      float ga = first ? gPrev : gm, gb = first ? gm : g;
      float t0 = first ? tPrev : tm, t1 = first ? tm : t;
      float dg = gb - ga;
      tc = mix(t0, t1, clamp(-ga / (abs(dg) < 1e-7 ? 1e-7 : dg), 0.0, 1.0));
      rate = abs(dg) / max(t1 - t0, 1e-5);
    } else if (min(abs(gPrev), abs(g)) < 8.0 * WIDTH) {
      // Alongside the sheet without passing through: what the nearer end sees of it.
      weight = sheet(gPrev, g, WIDTH) * dt;
      tc = abs(gPrev) < abs(g) ? tPrev : t;
      rate = abs(g - gPrev) / max(dt, 1e-5);
    }
    if (weight > 3e-4) {
      float y = rd.y * tc + CURVE * tc * tc;
      float foot = pix * tc / max(rate, 0.04);
      sum += weight * emission(du * tc + u0, y, ca, tc, foot);
    }
    tPrev = t;
    gPrev = g;
  }
  return sum;
}

// Where a ray reaches an altitude over the curved ground.
float reachAltitude(float y, float b) { return 2.0 * y / (b + sqrt(b * b + 4.0 * CURVE * y)); }

void main() {
  vec3 rd = viewRay(vUv);
  vec3 glow = vec3(0.0);
  if (rd.y > -0.004) {
    float pix = 2.0 * uTanV / uRes.y;
    float tLow = reachAltitude(0.86, rd.y);
    float tHigh = min(reachAltitude(4.6, rd.y), 15.0);
    float dither = hash12(gl_FragCoord.xy + uFrame * vec2(17.0, 31.0));
    for (int k = 0; k < CURTAINS; k++) glow += curtain(uCurtain[k], rd, tLow, tHigh, pix, fract(dither + float(k) * 0.618));
    // The air near the horizon takes its share.
    glow *= 11.0 * exp(-0.03 / (max(rd.y, 0.0) + 0.03));
  }
  fragColor = vec4(glow, 1.0);
}
`;

const SKY = COMMON + CAMERA + /* glsl */ `
uniform sampler2D uAurora;
uniform vec2 uRes;
uniform float uSeed, uTime, uTwinkle, uTurn, uSide;
uniform vec3 uAmbient, uZenith, uHorizonCol, uMilky, uPole;

vec3 turn(vec3 v, vec3 axis, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}
// The sky as a flat chart (stereographic about the middle of the view): stars keep their shapes.
vec2 chart(vec3 d) {
  const vec3 mid = vec3(0.0, 0.4104, 0.9119);
  return vec2(d.x, d.y * mid.z - d.z * mid.y) * 2.0 / (1.0 + dot(d, mid));
}
// One star at most per cell of the chart, drawn round on the screen whatever the lens does.
vec3 starLayer(vec2 q, mat2 toPixels, float cell, float seed, float density, float gain, float sharp, float flicker) {
  vec2 id = floor(q / cell);
  vec3 h = hash33(vec3(id, seed));
  if (h.z > density) return vec3(0.0);
  vec2 centre = (id + 0.22 + 0.56 * h.xy) * cell;
  vec2 px = toPixels * (q - centre);
  float m = hash12(id + seed * 17.3);
  float power = gain * (0.12 + pow(m, sharp));
  float radius = 0.72 + 0.5 * saturate(power * 0.25);
  float core = exp(-dot(px, px) / (2.0 * radius * radius));
  float twinkle = 1.0 + flicker * (0.6 * sin(uTime * (2.0 + 5.0 * h.x) + h.y * TAU) + 0.4 * sin(uTime * (5.0 + 8.0 * h.y) + h.x * TAU));
  vec3 tint = mix(vec3(1.0, 0.7, 0.45), vec3(0.62, 0.76, 1.0), smoothstep(0.1, 0.75, hash12(id * 1.7 + seed)));
  tint = mix(tint, vec3(1.0), 0.35);
  return tint * power * core * max(twinkle, 0.0);
}

// Crests: folded noise, summed.
float ridge(float x, float seed) {
  float sum = 0.0, amp = 0.5, f = 1.0;
  for (int i = 0; i < 6; i++) {
    float n = snoise(vec2(x * f + seed * 13.1, seed * 7.7 + float(i) * 3.3));
    sum += amp * (1.0 - abs(n));
    f *= 2.13;
    amp *= 0.5;
  }
  return sum;
}
// A stand of spruces: x in tree widths, y in tree heights above the ground; 1 inside a tree.
float grove(float x, float y, float seed, float aa) {
  float i = floor(x);
  float cover = 0.0;
  for (int j = -1; j <= 1; j++) {
    float id = i + float(j);
    vec2 h = hash21(id * 1.31 + seed);
    float c = id + 0.5 + (h.x - 0.5) * 0.8;
    float tall = 0.4 + 0.6 * h.y;
    float s = y / tall;
    float tiers = 6.0 + 5.0 * h.x;
    float saw = fract(s * tiers + h.y);
    float span = 0.46 * (1.0 - s) * (0.5 + 0.5 * (1.0 - saw)) + 0.015;
    cover = max(cover, smoothstep(span + aa, span - aa, abs(x - c)) * step(s, 1.0));
  }
  return cover;
}

void main() {
  vec3 rd = viewRay(vUv);
  if (rd.y < -0.006) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); fragColor1 = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float pix = 2.0 * uTanV / uRes.y;
  float up = max(rd.y, 0.0);
  float tanEl = rd.y / length(rd.xz);
  float az = atan(rd.x, rd.z);

  // The night itself: near black overhead, a little lighter and greener toward the horizon.
  vec3 col = mix(uHorizonCol, uZenith, pow(saturate(up * 1.7), 0.55));
  col += (vec3(0.004, 0.011, 0.008) + uAmbient * 0.012) * exp(-up / 0.07);

  // Stars and the Milky Way, turning slowly about the pole.
  vec3 sd = turn(rd, uPole, uTurn);
  vec2 q = chart(sd);
  vec2 qx = chart(turn(viewRay(vUv + vec2(1.0 / uRes.x, 0.0)), uPole, uTurn)) - q;
  vec2 qy = chart(turn(viewRay(vUv + vec2(0.0, 1.0 / uRes.y)), uPole, uTurn)) - q;
  mat2 toPixels = inverse(mat2(qx, qy));
  float air = exp(-0.05 / (up + 0.035));
  float flicker = uTwinkle * (0.25 + 0.75 * saturate(1.0 - up * 2.2));
  float mwd = dot(sd, uMilky);
  float milky = exp(-sq(mwd / 0.19));
  vec2 qs = q + uSeed * 3.7;
  vec3 stars = starLayer(qs, toPixels, 0.105, 1.0, 0.55, 5.0, 5.0, flicker);
  stars += starLayer(qs, toPixels, 0.041, 2.0, 0.6, 1.3, 4.0, flicker);
  stars += starLayer(qs, toPixels, 0.0155, 3.0, 0.3 + 0.6 * milky, 0.34, 3.0, flicker * 0.7);
  if (milky > 0.01) {
    float clouds = saturate(0.55 + 0.75 * fbm(qs * 2.3 + 3.0));
    float lanes = smoothstep(-0.25, 0.3, fbm(qs * 4.6 - 11.0) + abs(mwd) * 4.5);
    float core = exp(-sq(mwd / 0.07));
    stars += mix(vec3(0.5, 0.62, 0.95), vec3(1.0, 0.82, 0.62), core) * (0.012 + 0.03 * core) * milky * clouds * mix(0.25, 1.0, lanes);
  }
  stars *= air;

  // The aurora, drawn smaller: it is soft, and by far the dearest thing here.
  col += textureLod(uAurora, vUv, 0.0).rgb;

  float open = 1.0;
  if (tanEl < 0.25) {
    // The land: a far range in haze, nearer hills, the far shore's forest, a wooded headland.
    float aa = pix * 1.1;
    float lift = 0.55 + 0.45 * snoise(vec2(az * 0.9 + uSeed * 5.0, 3.0));
    float crest = saturate((ridge(az * 1.4, uSeed) - 0.42) / 0.5);
    float farRange = 0.018 + 0.2 * lift * pow(crest, 1.4);
    float farMask = smoothstep(farRange + aa, farRange - aa, tanEl);
    // Snow fields catch the aurora; the rock between them stays dark.
    float faces = 0.6 * snoise(vec2(az * 34.0 + tanEl * 85.0, tanEl * 120.0 + uSeed)) + 0.4 * snoise(vec2(az * 90.0 - tanEl * 150.0, tanEl * 260.0));
    float snow = smoothstep(-0.25, 0.5, faces) * smoothstep(0.025, 0.08, tanEl) * (0.3 + 0.7 * exp(-(farRange - tanEl) * 30.0));
    vec3 farCol = uHorizonCol * 0.4 + (uAmbient * 0.03 + vec3(0.0015, 0.0025, 0.004)) * snow;
    col = mix(col, farCol, farMask);
    // Mist in the valleys at their feet.
    col = mix(col, uHorizonCol * 0.8 + uAmbient * 0.012, 0.75 * exp(-max(tanEl, 0.0) / 0.014) * farMask);
    float nearRange = 0.008 + 0.05 * pow(ridge(az * 2.6 + 4.0, uSeed + 3.0), 1.5) * (0.5 + 0.5 * snoise(vec2(az * 1.3 - uSeed, 9.0)));
    float nearMask = smoothstep(nearRange + aa, nearRange - aa, tanEl);
    col = mix(col, uHorizonCol * 0.16, nearMask);
    float comb = 0.0045 + 0.004 * vnoise(vec2(az * 9.0, uSeed));
    float forest = grove(az * 230.0, (tanEl - 0.002) / comb, uSeed + 5.0, aa * 230.0);
    forest = max(forest, smoothstep(0.0028 + aa, 0.0028 - aa, tanEl));
    col = mix(col, uHorizonCol * 0.05, forest);
    // The headland comes in from the side away from the curtains' vanishing point.
    float reachIn = -uSide * az - 0.08 + 0.1 * snoise(vec2(az * 2.0, uSeed + 7.0));
    float ground = 0.014 * smoothstep(0.0, 0.4, reachIn) * (0.7 + 0.3 * snoise(vec2(az * 7.0, uSeed)));
    float wood = 0.034 + 0.05 * smoothstep(0.02, 0.5, reachIn);
    float above = tanEl - ground * 0.7;
    float head = max(grove(az * 31.0, above / wood, uSeed + 9.0, aa * 31.0), grove(az * 49.0 + 0.4, above / (wood * 0.7), uSeed + 13.0, aa * 49.0));
    float brush = ground + wood * (0.1 + 0.12 * vnoise(vec2(az * 260.0, uSeed)));
    head = max(head, smoothstep(brush + aa, brush - aa, tanEl)) * step(0.0, reachIn);
    col = mix(col, vec3(0.0004, 0.0007, 0.001), head);
    open = (1.0 - farMask) * (1.0 - nearMask) * (1.0 - forest) * (1.0 - head);
  }

  // The second picture is the sky without its stars: the lake smears that one and mirrors the stars as points.
  fragColor = vec4(max(col + stars * open, 0.0), 1.0);
  fragColor1 = vec4(max(col, 0.0), 1.0);
}
`;

const LAKE = COMMON + CAMERA + /* glsl */ `
#define RINGS ${RINGS}
#define TAPS 10
uniform sampler2D uSkyTex, uSkyBare;
uniform vec2 uRes;
uniform float uSeed, uWater, uWindAngle, uRuffle;
uniform vec4 uRing[RINGS];
uniform vec3 uAmbient, uDeep;

// How much of a wave survives when a pixel spans x of its phase.
float lod(float x) { return smoothstep(1.9, 0.7, x); }

void main() {
  vec3 rd = viewRay(vUv);
  if (rd.y > -0.0005) { fragColor = vec4(textureLod(uSkyTex, vUv, 0.0).rgb, 1.0); return; }
  // The water, in camera heights: where the ray meets it, and what one pixel covers there.
  float dist = -1.0 / rd.y;
  vec2 P = rd.xz * dist;
  float range = length(P);
  vec2 toward = P / range, across = vec2(-toward.y, toward.x);
  float pix = 2.0 * uTanV / uRes.y;
  float footAlong = pix * dist * dist, footAcross = pix * dist;

  // A breeze ruffles the lake in patches; between them it is glass.
  vec2 wind = vec2(cos(uWindAngle), sin(uWindAngle));
  float patches = vnoise(P * 0.11 + wind * uWater * 0.07 + uSeed);
  patches = mix(0.5, patches, lod(footAlong * 0.11 * 3.0));
  float ruffle = uRuffle * (0.3 + 0.9 * smoothstep(0.3, 0.75, patches));

  // Wave trains about the wind; what a pixel cannot hold is spread as roughness instead.
  vec2 slope = vec2(0.0);
  float lost = 0.0;
  float k = 1.5, amp = 1.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float ang = uWindAngle + (hash11(fi * 7.3 + uSeed) - 0.5) * 2.6;
    vec2 d = vec2(cos(ang), sin(ang));
    float kk = k * (0.85 + 0.3 * hash11(fi * 3.1 + 1.0 + uSeed));
    float steep = 0.0045 * amp * ruffle;
    float keep = lod(kk * (abs(dot(d, toward)) * footAlong + abs(dot(d, across)) * footAcross) * 1.2);
    slope += d * steep * cos(kk * dot(d, P) - sqrt(5.8 * kk) * uWater + fi * 2.1) * keep;
    lost += steep * steep * 0.5 * (1.0 - keep * keep);
    k *= 1.6;
    amp *= 0.9;
  }
  // The kicks' rings.
  for (int i = 0; i < RINGS; i++) {
    vec4 ring = uRing[i];
    if (ring.w <= 0.0) continue;
    vec2 away = P - ring.xy;
    float radius = length(away);
    float front = radius - 2.3 * ring.z;
    float packet = exp(-sq(front / (0.55 + 0.3 * ring.z)));
    float steep = 0.04 * ring.w * packet / (1.0 + 0.5 * ring.z);
    float keep = lod(7.0 * (abs(dot(away / max(radius, 1e-3), toward)) * footAlong + footAcross) * 1.2);
    slope += away / max(radius, 1e-3) * steep * cos(7.0 * front) * keep;
    lost += steep * steep * 0.5 * (1.0 - keep * keep);
  }

  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 r0 = reflect(rd, n);
  float sigma = sqrt(sq(0.0035) + lost);
  // The sky above the mirrored ray, gathered along the vertical: lights become streaks.
  float jitter = hash12(gl_FragCoord.xy + uSeed) - 0.5;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float x = (float(i) + 0.5 + jitter) / float(TAPS) * 2.0 - 1.0;
    float o = 2.7 * (0.3 * x + 0.7 * x * x * x);
    float w = exp(-0.5 * o * o) * (0.3 + 2.1 * x * x);
    vec3 r = r0;
    r.y = max(r.y + 2.0 * sigma * o, 0.0035);
    vec2 uv = project(normalize(r));
    sum += textureLod(uSkyBare, uv, 0.0).rgb * w;
    total += w;
  }
  vec3 mirror = sum / total;
  // Stars are too small to smear: each is mirrored once, and rides the ripples.
  vec2 uv0 = project(normalize(vec3(r0.x, max(r0.y, 0.0035), r0.z)));
  mirror += max(textureLod(uSkyTex, uv0, 0.0).rgb - textureLod(uSkyBare, uv0, 0.0).rgb, 0.0) * 0.85;
  float cosI = saturate(dot(-rd, n));
  float fresnel = 0.1 + 0.9 * pow(1.0 - cosI, 3.2);
  vec3 col = mirror * fresnel * vec3(0.9, 0.97, 1.0) + uDeep * (1.0 - fresnel);
  fragColor = vec4(max(col, 0.0), 1.0);
}
`;

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const look = LOOKS[preset] ?? LOOKS.polar!;
  const random = seededRandom(seed * 6151 + 29);
  const programs = { aurora: kit.program(AURORA), sky: kit.program(SKY, { outputs: 2 }), lake: kit.program(LAKE) };
  let aurora: Target | null = null;
  let sky: Target | null = null;
  let scene: Target | null = null;

  // What the seed decides: where the curtains run to and how they are spaced, which way the
  // folds travel and the field leans, the mountains, the stars, the wind on the water.
  const side = random() < 0.5 ? -1 : 1;
  const vanish = side * (0.62 + 0.5 * random());
  const wind = random() < 0.5 ? -1 : 1;
  const tilt = [(random() - 0.5) * 0.3, 0.08 + 0.12 * random()];
  const curtains = new Float32Array(CURTAINS * 4);
  const offsets = [0.55, 1.3, 2.4, 4.0, 6.2, -0.85];
  for (let index = 0; index < CURTAINS; index += 1) {
    const offset = offsets[index % offsets.length]! * (0.85 + 0.3 * random());
    curtains.set([offset, random() * 6.283, 1, random()], index * 4);
  }
  const milkyAngle = (random() - 0.5) * 1.6;
  const milkyLift = 0.25 + 0.3 * random();
  const milky = [Math.cos(milkyAngle) * Math.cos(milkyLift), -Math.sin(milkyLift), Math.sin(milkyAngle) * Math.cos(milkyLift)];
  // The celestial pole: north, 66° up — outside the picture, so the stars drift in shallow arcs.
  const pole = [0, Math.sin(1.15), Math.cos(1.15)];
  const windAngle = random() * Math.PI * 2;
  const shaderSeed = Math.floor(random() * 1000) / 10;

  let sway = random() * 40;
  let shimmer = random() * 40;
  let water = random() * 40;
  let sinceRing = 0;
  let nextPulse = 0;
  let nextRing = 0;
  let count = 0;
  const pulseAge = new Float32Array(PULSES).fill(10);
  const pulseStrength = new Float32Array(PULSES);
  const pulses = new Float32Array(PULSES * 4);
  const ringAge = new Float32Array(RINGS).fill(100);
  const ringPlace = new Float32Array(RINGS * 2);
  const ringStrength = new Float32Array(RINGS);
  const rings = new Float32Array(RINGS * 4);

  return {
    render(frame: FvFrame): void {
      const f = frame.audio.features;
      const dt = Math.min(0.1, frame.dt);
      count += 1;
      const aspect = frame.width / frame.height;
      const [width, height] = workSize(frame);
      const [auroraWidth, auroraHeight] = workSize(frame, AURORA_SCALE);
      aurora = kit.fit(aurora, auroraWidth, auroraHeight, "rgba16f");
      sky = kit.fit(sky, width, height, "rgba16f", { attachments: 2 });
      scene = kit.fit(scene, width, height, "rgba16f");

      // The lens widens as the picture gets taller, so a phone held upright sees the curtains tower.
      const tanV = Math.min(1.05, Math.max(0.56, 0.6 * Math.pow(16 / 9 / aspect, 0.4)));
      const pitch = Math.atan(0.2 * tanV);
      const azimuth = Math.atan(vanish * aspect * tanV);
      const dir = [Math.sin(azimuth), Math.cos(azimuth)];
      const nrm = [-dir[1]! * side, dir[0]! * side];

      const loud = f.level * (0.35 + 0.65 * f.presence);
      sway += dt * wind * (0.3 + 1.5 * f.mid * f.presence + 0.4 * loud);
      shimmer += dt * (0.5 + 2.6 * f.high + 1.6 * f.hat);
      water += dt * (0.8 + 0.5 * f.lowMid);

      // A kick: a wave of light up the curtains, a ring on the lake.
      const soften = frame.gentle ? 0.4 : 1;
      for (let index = 0; index < PULSES; index += 1) pulseAge[index] = pulseAge[index]! + dt;
      for (let index = 0; index < RINGS; index += 1) ringAge[index] = ringAge[index]! + dt;
      sinceRing += dt;
      const ring = (strength: number): void => {
        const depth = 3.5 + 11 * random() * random();
        const reach = Math.atan(aspect * tanV) * 0.85;
        ringAge[nextRing] = 0;
        ringStrength[nextRing] = strength;
        ringPlace.set([Math.tan((random() * 2 - 1) * reach) * depth, depth], nextRing * 2);
        nextRing = (nextRing + 1) % RINGS;
        sinceRing = 0;
      };
      if (f.onset) {
        pulseAge[nextPulse] = 0;
        pulseStrength[nextPulse] = soften * (0.55 + 0.45 * f.bass);
        nextPulse = (nextPulse + 1) % PULSES;
        ring(soften * (0.7 + 0.3 * f.bass));
      } else if (sinceRing > 2.6 + 2 * random()) ring(0.4);
      for (let index = 0; index < PULSES; index += 1) {
        const age = pulseAge[index]!;
        // It climbs fast and thins as it goes.
        pulses.set([age * (frame.gentle ? 1.5 : 2.0), pulseStrength[index]! * Math.exp(-age / 0.42) * Math.min(1, age / 0.05), 0, 0], index * 4);
      }
      for (let index = 0; index < RINGS; index += 1) {
        const age = ringAge[index]!;
        const life = Math.max(0, 1 - age / 3.4);
        rings.set([ringPlace[index * 2]!, ringPlace[index * 2 + 1]!, age, ringStrength[index]! * life * Math.sqrt(life) * Math.min(1, age / 0.12)], index * 4);
      }

      const ambient = look.body.map((value, index) => (0.6 * value + 0.4 * look.top[index]!) * (0.45 + 0.75 * loud));
      const camera = { uAspect: aspect, uTanV: tanV, uPitch: pitch, uSeed: shaderSeed };
      kit.draw(programs.aurora, aurora, {
        ...frame.audio.uniforms(kit), ...camera, uRes: [auroraWidth, auroraHeight], uDir: dir, uNrm: nrm, uTilt: tilt, uCurtain: curtains,
        uPulse: pulses, uSway: sway, uShimmer: shimmer, uQuiet: 0.5, uGain: 0.4 + 0.9 * loud, uCurl: 0.014 + 0.03 * f.bass * f.presence,
        uFlare: soften * 0.9 * f.kick, uFrame: count % 256, uBodyScale: look.bodyScale, uTopScale: look.topScale, uTopGain: look.topGain,
        uColLow: look.low, uColBody: look.body, uColBody2: look.body2, uColTop: look.top, uColFlare: look.flare
      });
      kit.draw(programs.sky, sky, {
        ...camera, uRes: [width, height], uAurora: aurora, uTime: f.time, uSide: side,
        uTwinkle: (frame.gentle ? 0.5 : 1) * (0.22 + 0.5 * f.air + 0.6 * f.hat), uTurn: frame.time * 0.0035,
        uAmbient: ambient, uZenith: look.zenith, uHorizonCol: look.horizon, uMilky: milky, uPole: pole
      });
      kit.draw(programs.lake, scene, {
        ...camera, uRes: [width, height], uSkyTex: sky, uSkyBare: sky.textures[1], uWater: water, uWindAngle: windAngle, uRuffle: 0.75 + 0.6 * f.lowMid * f.presence + 0.3 * f.bass * f.presence,
        uRing: rings, uAmbient: ambient, uDeep: look.zenith.map((value, index) => value * 0.6 + ambient[index]! * 0.003)
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom, bloomRadius: 0.7, threshold: 0.7, vignette: 0.3, contrast: 0.3, saturation: 1.1,
        whiten: 0.45, grain: 0.5, gentle: frame.gentle
      });
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "aurora-lake",
  order: 2,
  kind: "vivid",
  labelPl: "Zorza nad jeziorem",
  labelEn: "Aurora over a Mirror Lake",
  descriptionPl: "Polarna noc nad lustrem jeziora: kurtyny zorzy grają widmem muzyki, a każde uderzenie basu wspina się po nich falą światła.",
  usesSource: false,
  gentleByDefault: false,
  presets: [
    { id: "polar", labelPl: "Zieleń polarna", labelEn: "Polar Green" },
    { id: "violet", labelPl: "Fiolet i róż", labelEn: "Violet and Rose" },
    { id: "ice", labelPl: "Lodowy błękit", labelEn: "Ice Blue" },
    { id: "crown", labelPl: "Czerwona korona", labelEn: "Red Crown" }
  ],
  create
};
