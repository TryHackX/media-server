import { AUDIO, COMMON } from "../core/glsl";
import { Kit, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Kryształowa katedra — Crystal Cathedral.
 *
 * An endless flight down the nave of a cathedral grown from crystal. The building is one
 * distance field, sphere-traced: a bay folded onto itself along the nave and across it, a
 * pointed vault cut from two crossing barrels whose arcs are polygons, not circles — so the
 * vault is facets — diamond-section ribs along every line where they meet, piers that are
 * clusters of six-sided crystals of uneven length, crowns and feet of crystal points, a
 * lantern under every boss, and window tracery made by an iterated fold (mirror, scale by two,
 * drop: every arch holds two smaller arches and an oculus). The walls between the piers are
 * stained glass, the floor is a mirror of tilted slabs.
 *
 * Nothing is marched twice. The crystal is dark where it finds no light: it shows the glass
 * around it by reflection and, bent a little differently for each colour, by refraction —
 * edges of the glass split into prismatic fringes — and it carries needles of light inside:
 * the orbit traps of a second iterated fold, seen through the surface at two depths.
 *
 * Kicks push the camera forward and send a wave of light down the nave; the bass feeds the
 * needles, mids bank the camera and let the crystal points grow and shrink a little, highs
 * strike glints off the edges.
 */

interface Look {
  /** Four colours of glass, linear. */
  glass: number[];
  /** The light at the far end. */
  glow: [number, number, number];
  /** The haze itself, away from that light. */
  haze: [number, number, number];
  /** What the crystal's body does to light passing through it. */
  tint: [number, number, number];
  /** The needles inside: at rest, and where a wave of light passes. */
  vein: [number, number, number];
  veinHot: [number, number, number];
  /** The fold of the inner lattice. */
  fold: [number, number, number];
  /** How finely the arches are cut (1: four and a half facets to a half arch). */
  facets: number;
  /** How long the crystal points grow, and how slender they are. */
  growth: number;
  slender: number;
  /** The depth of the diamond cut on the vault. */
  cut: number;
  light: number;
  shaft: number;
  exposure: number;
  bloom: number;
}

const LOOKS: Record<string, Look> = {
  amethyst: {
    glass: [0.36, 0.07, 1.0, 1.0, 0.1, 0.42, 0.06, 0.22, 1.0, 1.0, 0.66, 0.22],
    glow: [1.0, 0.8, 0.92], haze: [0.1, 0.03, 0.26], tint: [0.72, 0.5, 1.0], vein: [0.8, 0.25, 1.0], veinHot: [1.0, 0.72, 0.88],
    fold: [0.62, 0.8, 0.5], facets: 1.0, growth: 1.0, slender: 1.0, cut: 0.03, light: 1.7, shaft: 0.012, exposure: 1.1, bloom: 0.42
  },
  emerald: {
    glass: [0.02, 0.85, 0.32, 0.0, 0.5, 0.72, 1.0, 0.68, 0.1, 0.92, 0.05, 0.1],
    glow: [1.0, 0.93, 0.68], haze: [0.015, 0.16, 0.1], tint: [0.45, 1.0, 0.68], vein: [0.25, 1.0, 0.5], veinHot: [1.0, 0.9, 0.5],
    fold: [0.56, 0.86, 0.56], facets: 0.67, growth: 1.25, slender: 1.0, cut: 0.02, light: 1.7, shaft: 0.012, exposure: 1.0, bloom: 0.42
  },
  ice: {
    glass: [0.2, 0.55, 1.0, 0.65, 0.95, 1.0, 0.04, 0.14, 0.9, 0.55, 0.42, 1.0],
    glow: [0.84, 0.95, 1.0], haze: [0.03, 0.1, 0.26], tint: [0.66, 0.88, 1.0], vein: [0.4, 0.85, 1.0], veinHot: [0.9, 1.0, 1.0],
    fold: [0.68, 0.74, 0.46], facets: 1.0, growth: 1.45, slender: 0.78, cut: 0.04, light: 1.7, shaft: 0.012, exposure: 1.1, bloom: 0.42
  },
  amber: {
    glass: [1.0, 0.5, 0.04, 1.0, 0.16, 0.03, 1.0, 0.78, 0.28, 0.04, 0.66, 0.72],
    glow: [1.0, 0.86, 0.62], haze: [0.24, 0.07, 0.015], tint: [1.0, 0.68, 0.34], vein: [1.0, 0.45, 0.08], veinHot: [1.0, 0.9, 0.6],
    fold: [0.58, 0.82, 0.54], facets: 1.5, growth: 0.85, slender: 1.15, cut: 0.045, light: 1.7, shaft: 0.012, exposure: 0.95, bloom: 0.42
  }
};

const WAVES = 5;
const STEPS = 70;
/**
 * The camera's z is kept under this, so the shader's arithmetic stays exact however long the
 * flight: a whole number of bays, of the inner lattice's cells (2.5) and of floor slabs.
 */
const WRAP = 40;
const SHARDS = 6;
/** Each crystal point's lean from upright and its bearing about the pier (radians), before the seed moves them. */
const SHARD_AIMS: readonly (readonly [number, number])[] = [[0.75, 0.45], [0.95, 1.25], [0.95, 0.35], [0.6, 1.05], [0.7, 0.95], [0.5, 0]];

const SCENE = COMMON + AUDIO + /* glsl */ `
uniform vec2 uScale;
uniform vec3 uCam;
uniform mat3 uView;
uniform float uFocal, uSeed, uBay, uSpark, uVeinGain, uGrow, uSlender, uFacet, uCut, uLight, uShaft, uFlare;
uniform vec3 uGlass[4];
uniform vec3 uGlow, uHaze, uTint, uVein, uVeinHot, uSun, uFold;
uniform vec3 uShardA[${SHARDS}];
uniform vec3 uShardE[${SHARDS}];
uniform vec4 uWave[${WAVES}];

// The building, in its own units. A bay is L along the nave; the nave is 2 XP across. The
// camera's z stays small (the nave is folded every WRAP of it); uBay says which bay z = 0 is.
const float L = 2.0;
const float HL = 1.0;
// Across the nave: the piers' axis, the wall under the windows, the tracery's plane, the glass.
const float XP = 1.3;
const float XD = 2.06;
const float XT = 2.16;
const float XW = 2.3;
// Up: the window sill, where the vault springs, its crown.
const float YS = 0.6;
const float YV = 3.0;
const float YTOP = 4.95;
// Pointed arches, each an arc about a centre beyond the middle: the nave's (half span XP) and
// a bay's (half span HL), of one rise so their crowns meet.
const float CN = 0.78;
const float RN = 2.08;
const float CB = 1.3585;
const float RB = 2.3585;
const float FAR = 56.0;
const float FOG = 0.042;
const float ROSE = 0.095;

// The waves of light the kicks send down the nave, at a place along it. x: the front, a
// narrow hoop of light; y: what it leaves alight behind it, fading toward the eye.
vec2 pulse(float z) {
  vec2 sum = vec2(0.0);
  for (int i = 0; i < ${WAVES}; i++) {
    float u = z - uWave[i].x;
    float w = 0.1 + 0.32 * (uWave[i].z - 0.9);
    float front = exp(-u * u / (w * w));
    sum += uWave[i].y * vec2(front, u > 0.0 ? front : exp(u / uWave[i].z));
  }
  return sum;
}

// A bar of diamond section about the line a = b = 0: crystal, so every moulding is faceted.
float diamond(float a, float b, float r) { return (abs(a) + abs(b)) * 0.70711 - r; }
// A six-sided measure of v.
float hexLen(vec2 v) { v = abs(v); return max(v.x * 0.86603 + v.y * 0.5, v.y); }
// The length of v as a cut stone has it: to the side of a polygon of n facets a radian.
float facet(vec2 v, float n) {
  float a = atan(v.y, v.x) * n;
  return length(v) * cos((fract(a + 0.5) - 0.5) / n);
}
// A crystal point: a six-sided spike of length l along a from the origin, r across at its root.
float shard(vec3 q, vec3 a, vec3 e, float l, float r) {
  float h = dot(q, a);
  return max((hexLen(vec2(dot(q, e), dot(q, cross(a, e)))) + (h - l) * (r / l)) * 0.97, -h);
}

// The distance to the building.
float map(vec3 p) {
  float xf = abs(p.x);
  float zf = HL - abs(mod(p.z, L) - HL);
  float y = p.y;
  float yy = max(y - YV, 0.0);
  // Two pointed barrels: the nave's, and the one each bay sends across it to the windows.
  float d1 = facet(vec2(xf + CN, yy), 3.7927 * uFacet) - RN;
  float d2 = facet(vec2(HL + CB - zf, yy), 3.6576 * uFacet) - RB;
  // The mass over them, cut in diamonds as lead crystal is.
  float cut = uCut * (abs(fract(p.z * 2.0) - 0.5) + abs(fract((xf + y) * 1.4) - 0.5));
  float s = max(max(-d1, -d2), YV - y) + cut;
  // Ribs: the arch over each pair of piers, the groins where the barrels cross, the ridges,
  // the arch each bay opens to the nave with.
  s = min(s, diamond(d1, zf, 0.06));
  s = min(s, diamond(d1, d2, 0.045));
  s = min(s, diamond(min(xf, HL - zf), y - YTOP, 0.045));
  s = min(s, diamond(d2, xf - XP, 0.075));
  // A lantern of crystal under every crossing of the ridges: long under a bay's, short under an arch's.
  float big = step(0.5, zf);
  float py = y - YTOP + mix(0.3, 0.6, big);
  s = min(s, (hexLen(vec2(xf, min(zf, HL - zf))) + abs(py) * (py > 0.0 ? 0.4 : mix(0.3, 0.19, big)) - mix(0.07, 0.115, big)) * 0.93);
  // The pier: a six-sided shaft on a spreading foot, four lesser crystals grown against it,
  // each ending in a point at its own height.
  vec2 u = vec2(xf - XP, zf);
  vec2 rnd = hash21(floor(p.z / L + 0.5) + uBay + (p.x < 0.0 ? 57.0 : 0.0) + uSeed);
  float inner = step(u.x, 0.0);
  s = min(s, max(hexLen(u) - 0.15, y - YV - 0.4));
  s = min(s, (hexLen(u.yx) + y * 0.5 - 0.36) * 0.89);
  float top = mix(0.9 + 1.7 * rnd.x, 1.2 + 1.5 * rnd.y, inner);
  s = min(s, (hexLen(vec2(u.y - 0.1, abs(u.x) - 0.155)) + max(y - top, 0.0) * 0.3 - 0.075) * 0.95);
  // Its crown and its foot: crystal points, leaning out.
  float grow = uGrow * (0.75 + 0.5 * mix(rnd.y, rnd.x, inner));
  vec3 q = vec3(abs(u.x), y - YV + 0.2, u.y);
  s = min(s, shard(q, uShardA[0], uShardE[0], 0.85 * grow, 0.1 * uSlender));
  s = min(s, shard(q, uShardA[1], uShardE[1], 0.7 * grow, 0.085 * uSlender));
  q.y = y - 0.05;
  s = min(s, shard(q, uShardA[2], uShardE[2], 0.6 * grow, 0.1 * uSlender));
  s = min(s, shard(q, uShardA[3], uShardE[3], 0.8 * grow, 0.09 * uSlender));
  // Tracery: the window's arch, then the fold — each arch holds an oculus and two arches of
  // half its size, standing lower.
  float a = xf - XT;
  float tr = diamond(d2, a, 0.06);
  vec2 w = vec2(zf, y - YV);
  float sc = 1.0;
  for (int k = 0; k < 2; k++) {
    float r = k == 0 ? 0.04 : 0.028;
    float oc = length(w - vec2(1.0, 1.02)) - 0.44;
    tr = min(tr, diamond(oc, a * sc, r * sc) / sc);
    w.x = 0.5 - abs(w.x - 0.5);
    w = w * 2.0 + vec2(0.0, 0.5);
    sc *= 2.0;
    float rho = length(vec2(HL + CB - w.x, max(w.y, 0.0))) - RB;
    tr = min(tr, diamond(rho, a * sc, r * sc) / sc);
  }
  s = min(s, max(tr, YS - 0.02 - y));
  // The wall under the windows, its sill, and the crystals that have grown against it.
  s = min(s, max(XD - xf + cut, y - YS));
  s = min(s, diamond(xf - XD, y - YS, 0.05));
  float grown = uGrow * (0.7 + 0.6 * hash11((floor(p.z / L) + uBay) * 1.7 + (p.x < 0.0 ? 9.0 : 0.0) + uSeed));
  q = vec3(XD + 0.1 - xf, y + 0.05, HL - zf);
  s = min(s, shard(q, uShardA[4], uShardE[4], 0.95 * grown, 0.12 * uSlender));
  s = min(s, shard(q, uShardA[5], uShardE[5], 1.3 * grown, 0.14 * uSlender));
  return s * 0.9;
}

// Needles and veils inside the crystal: an iterated fold (mirror, turn twice, grow), and how
// near its orbit came to an axis (x) and to a plane (y).
const mat2 TURN_A = mat2(0.8, -0.6, 0.6, 0.8);
const mat2 TURN_B = mat2(0.6, -0.8, 0.8, 0.6);
vec2 lattice(vec3 p) {
  vec3 q = abs(fract(p * 0.4 + 0.25) - 0.5) * 2.4;
  float s = 0.96;
  vec2 trap = vec2(1e3);
  for (int i = 0; i < 4; i++) {
    q = abs(q) - uFold;
    q.xy = TURN_A * q.xy;
    q.yz = TURN_B * q.yz;
    q *= 1.55;
    s *= 1.55;
    trap = min(trap, vec2(length(q.xy), abs(q.z)) / s);
  }
  return trap;
}

// The rose at the end of the nave: a boss, twelve lancets radiating from it, each glazed in
// bands, and a wreath of roundels, great and small, on a darker ground.
vec3 rose(vec2 a) {
  float r = length(a) / ROSE;
  if (r > 1.0) return vec3(0.0);
  float th = atan(a.y, a.x) / TAU + 0.5;
  float id = floor(th * 12.0);
  float f = fract(th * 12.0) - 0.5;
  float across = f * r * TAU / 12.0;
  vec3 hue = uGlass[int(mod(id, 4.0))];
  vec3 other = uGlass[int(mod(id * 3.0 + 2.0, 4.0))];
  vec3 col;
  float lead;
  if (r < 0.13) {
    col = uGlow * 2.6;
    lead = 0.13 - r;
  } else if (r < 0.66) {
    float inLancet = r < 0.5 ? r * TAU / 24.0 - abs(across) : 0.128 - length(vec2(across, r - 0.5));
    float band = fract(r * 9.0 + 0.5 * mod(id, 2.0));
    vec3 pane = mix(hue, other, step(0.78, hash12(vec2(id, floor(r * 9.0 + 0.5 * mod(id, 2.0)))))) * (2.3 - 2.0 * r);
    col = inLancet > 0.0 ? pane : other * 0.3;
    lead = min(min(abs(inLancet), r - 0.13), inLancet > 0.0 ? min(band, 1.0 - band) * 0.11 : 1.0);
    lead = min(lead, 0.66 - r);
  } else {
    float big = 0.115 - length(vec2(across, r - 0.83));
    float small = 0.05 - length(vec2((0.5 - abs(f)) * r * TAU / 12.0, r - 0.8));
    col = big > 0.0 ? other * 2.2 : small > 0.0 ? uGlow * 1.6 : hue * 0.32;
    lead = min(min(abs(big), abs(small)), min(r - 0.66, 1.0 - r));
  }
  return col * smoothstep(0.004, 0.03, lead);
}

// What stands at the end of the nave, and the haze before it: the light a ray would end in.
vec3 beyond(vec3 d) {
  float fwd = smoothstep(-0.05, 0.3, d.z);
  vec2 a = d.xy / (abs(d.z) + 0.2);
  float r2 = dot(a, a);
  float r = sqrt(r2);
  vec2 u = a / (r + 1e-4);
  float rays = sq(vnoise(u * 4.0 + uTime * 0.06)) * (0.4 + 1.6 * vnoise(u * 11.0 - uTime * 0.09 + 3.7));
  vec3 col = uGlow * fwd * (0.3 * exp(-r2 * 90.0) + (0.05 + 2.2 * rays) * exp(-r * 3.4) * (0.42 + 0.3 * uLevel + 0.3 * uKick));
  col += uHaze * (0.1 + 0.9 * fwd * exp(-r2 * 1.5));
  if (d.z > 0.3) col += rose(d.xy / d.z);
  return col;
}

// The two colours a bay's windows are glazed in.
void scheme(float bid, out vec3 ground, out vec3 accent) {
  float gi = floor(hash11(bid * 1.37 + 3.1) * 3.999);
  ground = uGlass[int(gi)];
  accent = uGlass[int(mod(gi + 1.0 + floor(hash11(bid * 2.3 + 1.7) * 2.999), 4.0))];
}

// The daylight behind the glass: never even.
float sky(vec2 zy, float side) {
  float v = 0.55 + 0.9 * vnoise(vec2((zy.x + uBay * L) * 0.23 + side * 11.0 + uTime * 0.04, zy.y * 0.35 - uTime * 0.025));
  return v * (0.5 + 0.7 * smoothstep(YS, 4.2, zy.y)) * uLight;
}

// The colour a wall's glass throws into the nave near z: each bay's own, running into the next.
vec3 bayGlow(float z, float side) {
  float at = z / L - 0.5;
  float bay = floor(at);
  vec3 g0, a0, g1, a1;
  scheme(bay + uBay + side * 31.0 + uSeed * 7.0, g0, a0);
  scheme(bay + uBay + 1.0 + side * 31.0 + uSeed * 7.0, g1, a1);
  return mix(g0 * 0.5 + a0 * 0.15, g1 * 0.5 + a1 * 0.15, smoothstep(0.15, 0.85, at - bay)) * sky(vec2(z, 2.4), side);
}

// The stained glass of a side wall as light toward an eye looking along d, at a point of the
// wall (x: along the nave, y: up). soft 0: every pane and lead; 1: only each bay's colour.
vec3 glassAt(vec2 zy, float side, float soft, vec3 d) {
  float bay = floor(zy.x / L);
  float zl = zy.x - bay * L;
  float zf = HL - abs(zl - HL);
  float head = facet(vec2(HL + CB - zf, max(zy.y - YV, 0.0)), 3.6576 * uFacet) - RB;
  float open = smoothstep(0.0, -0.04 - 0.3 * soft, head) * smoothstep(YS, YS + 0.04 + 0.3 * soft, zy.y);
  if (open <= 0.0) return vec3(0.0);
  float bid = bay + uBay + side * 31.0 + uSeed * 7.0;
  vec3 ground, accent;
  scheme(bid, ground, accent);
  float lan = floor(zl * 2.0);
  float zc = zl - (lan + 0.5) * 0.5;
  float lid = bid * 4.0 + lan;
  vec3 mean = ground * 0.5 + accent * 0.15;
  vec3 col = mean;
  if (soft < 0.98) {
    // Quarries: a lattice of diamond panes, each its own depth of the ground colour, each cut
    // a little off the wall's plane — it flashes as the eye crosses its line.
    vec2 q = vec2(zc + zy.y, zc - zy.y) * 7.5;
    vec2 qi = floor(q), qf = fract(q);
    vec3 rnd = hash33(vec3(qi, lid * 0.61 + 2.0));
    vec3 pane = rnd.x > 0.86 ? accent * 1.15 : ground * (0.1 + 1.15 * rnd.x * rnd.x);
    float lead = min(min(qf.x, 1.0 - qf.x), min(qf.y, 1.0 - qf.y));
    vec2 off = d.zy - (rnd.yz - 0.5) * 1.7;
    pane *= 0.45 + 2.4 * exp(-dot(off, off) * 7.0);
    // Medallions down the middle of each light.
    float my = zy.y / 0.8 + hash11(lid) * 3.0;
    vec2 m = vec2(zc, (fract(my) - 0.5) * 0.8);
    float dm = length(m);
    float petal = 0.5 + 0.5 * cos(8.0 * atan(m.y, m.x));
    vec3 medal = accent * (0.35 + 1.3 * petal * smoothstep(0.02, 0.16, dm));
    pane = mix(pane, medal, smoothstep(0.175, 0.165, dm));
    lead = min(lead, abs(dm - 0.17) * 7.0);
    pane *= smoothstep(0.01, 0.1, lead);
    col = mix(pane, mean, soft);
  }
  return col * open * sky(zy, side);
}

// The glass a ray from p along d would meet, were nothing in its way; the floor mirrors it.
vec3 glassLight(vec3 p, vec3 d, float soft) {
  float side = d.x < 0.0 ? -1.0 : 1.0;
  vec3 h = p + d * ((XW - side * p.x) / max(abs(d.x), 0.02));
  return glassAt(vec2(h.z, abs(h.y)), side, soft, d) * (h.y < 0.0 ? 0.5 : 1.0);
}

// The light a ray from p along d would find, were the crystal not in its way: the glass, the
// sun's own disc where it stands behind the glass, and through the haze what lies beyond
// (given, so three rays a hair apart can share it).
vec3 env(vec3 p, vec3 d, float soft, vec3 far) {
  float side = d.x < 0.0 ? -1.0 : 1.0;
  float tx = (XW - side * p.x) / max(abs(d.x), 0.02);
  vec3 h = p + d * tx;
  vec3 g = glassAt(vec2(h.z, abs(h.y)), side, soft, d) * (h.y < 0.0 ? 0.5 : 1.0);
  g *= (1.0 + uFlare * pulse(h.z).y) * (1.0 + 30.0 * pow(saturate(dot(d, -uSun)), 500.0));
  return mix(far, g, exp(-FOG * tx));
}

vec3 shade(vec3 p, vec3 rd, float dist, float d0) {
  // The normal, and from the same four taps how the surface bends: ridges and creases.
  float e = 0.002 + 0.0021 * dist;
  vec2 k = vec2(1.0, -1.0);
  float m0 = map(p + k.xyy * e), m1 = map(p + k.yyx * e), m2 = map(p + k.yxy * e), m3 = map(p + k.xxx * e);
  vec3 n = normalize(k.xyy * m0 + k.yyx * m1 + k.yxy * m2 + k.xxx * m3);
  float bend = (m0 + m1 + m2 + m3 - 4.0 * d0) / e;
  float edge = smoothstep(0.03, 0.5, bend);
  float crease = smoothstep(0.05, 0.5, -bend);
  float ndv = saturate(dot(n, -rd));
  float fres = 0.08 + 0.92 * pow(1.0 - ndv, 5.0);
  float soft = smoothstep(4.0, 14.0, dist);
  float side = p.x < 0.0 ? -1.0 : 1.0;
  // Occlusion, and how thick the crystal is behind the surface.
  float ao = saturate(0.5 * map(p + n * 0.1) / 0.09 + 0.5 * map(p + n * 0.4) / 0.36);
  float thick = 0.45 * saturate(-map(p - n * 0.1) / 0.09) + 0.55 * saturate(-map(p - n * 0.36) / 0.3);
  // Reflection; and refraction a colour at a time, the glass behind seen as colour, not as panes.
  vec3 r = reflect(rd, n);
  vec3 refl = env(p, r, max(soft, 0.4), beyond(r));
  float ghost = max(soft, mix(0.3, 0.85, saturate(thick * 2.5)));
  vec3 out0 = p - n * 0.1;
  vec3 inside = refract(rd, n, 0.66);
  vec3 far = beyond(inside);
  vec3 through = vec3(env(out0, refract(rd, n, 0.74), ghost, far).r, env(out0, inside, ghost, far).g, env(out0, refract(rd, n, 0.58), ghost, far).b);
  vec3 body = through * pow(uTint, vec3(0.8 + 3.0 * thick)) * exp(-2.6 * thick) * 0.85;
  // The sun through the glass, thrown onto the crystal as it is onto the floor.
  vec3 amb = bayGlow(p.z + n.z * 0.3, side);
  body += glassLight(p, -uSun, max(soft, 0.3)) * saturate(dot(n, -uSun)) * mix(vec3(1.0), uTint, 0.5) * 0.25;
  vec3 col = body * (1.0 - fres) * mix(0.25, 1.0, ao) + refl * fres * mix(0.5, 1.0, ao);
  // The far end's light, glancing off whatever turns to it: the building is lit from behind.
  float back = saturate(dot(r, vec3(0.0, 0.05, 0.9987)));
  col += uGlow * pow(back, 12.0) * (0.12 + 0.88 * fres) * 0.7 * mix(0.5, 1.0, ao);
  // The needles inside, seen through the surface at two depths.
  vec2 wave = pulse(p.z);
  float wd = 0.003 + 0.0013 * dist;
  float threads = 0.0, veils = 0.0;
  for (int i = 0; i < 2; i++) {
    vec2 trap = lattice(p + inside * (0.03 + 0.09 * float(i)));
    float fade = 1.0 - 0.45 * float(i);
    threads += fade * (exp(-sq(trap.x / wd)) + 0.3 * exp(-trap.x * 70.0));
    veils += fade * exp(-sq(trap.y / wd) * 3.0);
  }
  float nearness = 1.0 / (1.0 + 0.12 * dist);
  vec3 veinColor = mix(uVein, uVeinHot, saturate(wave.y));
  vec3 hot = mix(uVein, uVeinHot, 0.7);
  col += veinColor * (threads + 0.12 * veils) * (0.3 + 0.7 * thick) * nearness * 1.25 * uVeinGain * (1.0 + 3.0 * wave.y) * mix(0.5, 1.0, ao);
  col *= 1.0 - 0.7 * crease;
  // Edges: each a small prism. They take the far end's light and their own bay's glass by how
  // they turn to them; glints run along them as the eye moves.
  vec3 fringe = mix(vec3(1.0), spectrum(fract(dot(n, vec3(1.7, 2.9, 1.3)) + ndv * 1.5)) * 1.6, 0.6);
  vec3 edgeLight = uGlow * (0.05 + 1.1 * pow(back, 3.0)) + amb * (0.15 + 0.9 * sq(saturate(r.x * side)));
  col += edgeLight * fringe * edge * (0.16 + 0.4 * uSpark);
  vec3 cell = floor(p * 26.0);
  float g = hash13(cell + vec3(0.0, 0.0, 52.0 * mod(uBay, 500.0)));
  float twinkle = pow(saturate(sin(g * 40.0 + dot(cell / 26.0 - uCam, vec3(2.3, 3.1, 1.9)) * 2.2 + uTime * 1.1)), 24.0);
  vec3 inCell = fract(p * 26.0) - 0.5;
  col += (uGlow * 0.5 + edgeLight) * fringe * edge * twinkle * step(0.88, g) * exp(-dot(inCell, inCell) * 14.0) * uSpark * 26.0;
  // The wave's own light on what it passes.
  col += hot * (wave.x * (0.75 + 1.2 * edge + 0.6 * fres) + wave.y * (0.02 + 0.4 * edge + 0.15 * fres)) * mix(0.5, 1.0, ao);
  return col;
}

// The glass's light caught by the haze along a ray: beams slanting down from the sun's side.
vec3 beams(vec3 ro, vec3 rd, float reach, float jitter) {
  vec3 sum = vec3(0.0);
  float span = min(reach, 16.0);
  for (int i = 0; i < 6; i++) {
    float t = span * (float(i) + jitter) / 6.0;
    sum += glassLight(ro + rd * t, -uSun, 1.0) * exp(-FOG * t);
  }
  return sum * span / 6.0;
}

float erfApprox(float x) {
  float t = 1.0 / (1.0 + 0.47047 * abs(x));
  return sign(x) * (1.0 - t * (0.3480242 + t * (-0.0958798 + t * 0.7478556)) * exp(-x * x));
}

// The waves' light caught by the haze along a ray: each a sheet across the nave, summed exactly.
float waveHaze(vec3 ro, vec3 rd, float reach) {
  float rz = abs(rd.z) < 0.06 ? 0.06 : abs(rd.z);
  float sum = 0.0;
  for (int i = 0; i < ${WAVES}; i++) {
    float u0 = (ro.z - uWave[i].x) / 0.5;
    float u1 = u0 + rd.z * reach / 0.5;
    sum += uWave[i].w * 0.4431 / rz * abs(erfApprox(u1) - erfApprox(u0));
  }
  return sum;
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * uScale;
  vec3 eye = normalize(uView * vec3(uv, uFocal));
  vec3 ro = uCam;
  vec3 rd = eye;
  vec3 col = vec3(0.0);
  vec3 carry = vec3(1.0);
  float travelled = 0.0;
  bool bounced = false;
  float tWall = (XW - (rd.x < 0.0 ? -ro.x : ro.x)) / max(abs(rd.x), 1e-4);
  float tFloor = rd.y < 0.0 ? ro.y / -rd.y : 1e5;
  float tEnd = min(min(tWall, tFloor), FAR);
  float t = 0.0, d = 1.0;
  float firstLeg = -1.0;
  bool hit = false;
  vec3 p = ro;
  for (int i = 0; i < ${STEPS}; i++) {
    p = ro + rd * t;
    d = map(p);
    if (d < 0.0012 + 0.0011 * (travelled + t)) { hit = true; break; }
    t += d;
    if (t >= tEnd) {
      if (tFloor <= tEnd && !bounced) {
        // The floor is a mirror of crystal slabs, none quite level: the ray goes on from it.
        bounced = true;
        firstLeg = tFloor;
        vec3 fp = ro + rd * tFloor;
        vec2 tc = vec2(fp.x + fp.z, fp.x - fp.z) * 0.9;
        vec2 tf = fract(tc);
        vec3 slab = hash33(vec3(floor(tc) + vec2(1.8, -1.8) * mod(uBay, 2000.0), 7.0));
        float joint = min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y));
        float wj = 0.01 + 0.004 * tFloor;
        float line = smoothstep(wj, 0.0, joint) * min(1.0, 0.02 / wj);
        float graze = pow(1.0 - saturate(-rd.y), 4.0);
        float seen = exp(-FOG * tFloor);
        // Pools of the windows' light on the stone, the joints alight, the wave passing over.
        vec2 wave = pulse(fp.z);
        vec3 stone = glassLight(fp, -uSun, 0.5) * 0.1 + uVein * line * (0.04 * uVeinGain + 0.5 * wave.y) + mix(uVein, uVeinHot, 0.7) * (wave.x * 0.9 + wave.y * 0.03);
        col += carry * (beyond(rd) * (1.0 - seen) + stone * seen * (1.0 - 0.7 * graze));
        carry *= seen * mix(0.1, 0.8, graze) * (0.7 + 0.3 * slab.z) * mix(uTint, vec3(1.0), 0.35);
        travelled += tFloor;
        ro = fp + vec3(0.0, 1e-3, 0.0);
        rd = reflect(rd, normalize(vec3((slab.x - 0.5) * 0.06, 1.0, (slab.y - 0.5) * 0.06)));
        rd.y = abs(rd.y) + 1e-3;
        rd = normalize(rd);
        t = 0.0;
        tWall = (XW - (rd.x < 0.0 ? -ro.x : ro.x)) / max(abs(rd.x), 1e-4);
        tFloor = 1e5;
        tEnd = min(tWall, FAR);
      } else {
        t = tEnd;
        break;
      }
    }
  }
  float dist = travelled + t;
  p = ro + rd * t;
  vec3 c;
  if (hit || (t < tEnd && d < 0.08)) c = shade(p, rd, dist, d);
  else if (tWall <= t + 1e-3 && tWall < FAR) {
    float side = rd.x < 0.0 ? -1.0 : 1.0;
    float soften = max(smoothstep(4.0, 14.0, dist), smoothstep(0.25, 1.1, dist * 0.012 / max(abs(rd.x), 0.01)));
    c = glassAt(p.zy, side, soften, rd) * (1.0 + uFlare * pulse(p.z).y) * (1.0 + 30.0 * pow(saturate(dot(rd, -uSun)), 500.0));
    c += beyond(reflect(rd, vec3(-side, 0.0, 0.0))) * (0.04 + 0.96 * pow(1.0 - abs(rd.x), 5.0)) * 0.6;
  } else c = beyond(rd);
  col += carry * mix(beyond(rd), c, exp(-FOG * t));
  float reach = firstLeg > 0.0 ? firstLeg : t;
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  col += beams(uCam, eye, reach, jitter) * uShaft;
  col += mix(uVein, uVeinHot, 0.6) * waveHaze(uCam, eye, reach);
  fragColor = vec4(max(col, 0.0), 1.0);
}
`;

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const look = LOOKS[preset] ?? LOOKS.amethyst!;
  const random = seededRandom(seed * 6151 + 29);
  const program = kit.program(SCENE);
  let scene: Target | null = null;

  // What the seed decides: where the flight starts and how it wanders, which side the sun is
  // on, which glass each window gets, how the crystal points lean, how the inner lattice is folded.
  let travel = random() * 400;
  const bayStart = Math.floor(random() * 1000);
  const swayPhase = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2];
  const swayReach = 0.26 + random() * 0.14;
  const sunSide = random() < 0.5 ? -1 : 1;
  const sun = [sunSide * (0.5 + random() * 0.2), -0.72, 0.18 + random() * 0.3];
  const sunLength = Math.hypot(sun[0]!, sun[1]!, sun[2]!);
  const fold = look.fold.map((value) => value + (random() - 0.5) * 0.06);
  const glassSeed = random() * 50;
  const shardAxis = new Float32Array(SHARDS * 3);
  const shardAcross = new Float32Array(SHARDS * 3);
  SHARD_AIMS.forEach(([lean, bearing], index) => {
    const tilt = lean + (random() - 0.5) * 0.24;
    const turn = bearing === 0 ? 0 : bearing + (random() - 0.5) * 0.4;
    const axis = [Math.sin(tilt) * Math.cos(turn), Math.cos(tilt), Math.sin(tilt) * Math.sin(turn)];
    const flat = Math.hypot(axis[0]!, axis[2]!);
    shardAxis.set(axis, index * 3);
    shardAcross.set([-axis[2]! / flat, 0, axis[0]! / flat], index * 3);
  });
  const waves = new Float32Array(WAVES * 4);
  const waveAge = new Float32Array(WAVES).fill(100);
  const waveZ = new Float64Array(WAVES);
  const wavePower = new Float32Array(WAVES);
  let nextWave = 0;
  let sinceKick = 10;
  let lastBreath = 0;
  let mid = 0;
  let high = 0;
  let bass = 0;
  let speed = 0.7;
  const view = new Float32Array(9);

  const pathX = (z: number): number => swayReach * Math.sin(z * 0.083 + swayPhase[0]!) + 0.08 * Math.sin(z * 0.21 + swayPhase[1]!);
  const pathY = (z: number): number => 1.5 + 0.3 * Math.sin(z * 0.057 + swayPhase[2]!) + 0.06 * Math.sin(z * 0.17 + swayPhase[3]!);

  return {
    render(frame: FvFrame): void {
      const f = frame.audio.features;
      const dt = Math.min(0.05, frame.dt);
      const [width, height] = workSize(frame, 0.66);
      scene = kit.fit(scene, width, height, "rgba16f");
      const ease = (tau: number): number => 1 - Math.exp(-dt / tau);
      const smooth = (value: number): number => {
        const x = Math.min(1, Math.max(0, value));
        return x * x * (3 - 2 * x);
      };
      mid += (f.mid - mid) * ease(0.5);
      high += (f.high - high) * ease(0.12);
      bass += (f.bass * f.presence - bass) * ease(0.15);

      // The flight: a glide the music quickens, and a push from every kick (a speed, so the
      // camera surges but never jumps).
      const surge = frame.gentle ? 1.3 : 3;
      const target = 0.7 + 1.0 * f.level * f.presence + surge * f.kick;
      speed += (target - speed) * ease(target > speed ? 0.05 : 0.25);
      travel += speed * dt;
      const wrapBase = Math.floor(travel / WRAP) * WRAP;
      const camZ = travel - wrapBase;

      // Waves of light: one from every kick, and a faint one per breath while there are none.
      sinceKick += dt;
      const breath = Math.floor(f.breath * 0.5);
      let power = 0;
      if (f.onset) {
        power = frame.gentle ? 0.5 : 1;
        sinceKick = 0;
      } else if (breath !== lastBreath && sinceKick > 1.5) power = 0.3;
      lastBreath = breath;
      if (power > 0) {
        waveAge[nextWave] = 0;
        waveZ[nextWave] = travel + 0.5;
        wavePower[nextWave] = power;
        nextWave = (nextWave + 1) % WAVES;
      }
      for (let index = 0; index < WAVES; index += 1) {
        const age = waveAge[index]! + dt;
        waveAge[index] = age;
        waveZ[index] = waveZ[index]! + (speed + 10) * dt;
        // A wave kindles a little way ahead of the camera and runs from it: a hoop in the
        // distance, never a band across the whole frame.
        const reach = waveZ[index]! - travel;
        const kindled = smooth((reach - 1.8) / 3.4);
        const strength = wavePower[index]! * kindled * Math.exp(-age / 1.3);
        waves.set([waveZ[index]! - wrapBase, strength, 0.9 + 0.5 * age, strength * smooth((reach - 2) / 6) * 0.12], index * 4);
      }

      // The camera: on its wandering line, turned a little into it, banked by the mids.
      const x = pathX(travel);
      const y = pathY(travel);
      const ahead = 1.5;
      const dx = (pathX(travel + ahead) - x) / ahead;
      const dy = (pathY(travel + ahead) - y) / ahead;
      const yaw = dx * 0.9 + 0.05 * Math.sin(f.time * 0.11 + swayPhase[1]!);
      const pitch = 0.1 + dy * 0.8 + 0.04 * Math.sin(f.time * 0.07 + swayPhase[2]!);
      const roll = -dx * 2.2 + (0.05 + 0.1 * mid) * Math.sin(f.flow * 0.21 + swayPhase[3]!);
      const fx = Math.cos(pitch) * Math.sin(yaw);
      const fy = Math.sin(pitch);
      const fz = Math.cos(pitch) * Math.cos(yaw);
      const rl = Math.hypot(fz, fx);
      const r0 = [fz / rl, 0, -fx / rl];
      const u0 = [fy * r0[2]! - fz * r0[1]!, fz * r0[0]! - fx * r0[2]!, fx * r0[1]! - fy * r0[0]!];
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      view.set([
        r0[0]! * cr + u0[0]! * sr, r0[1]! * cr + u0[1]! * sr, r0[2]! * cr + u0[2]! * sr,
        u0[0]! * cr - r0[0]! * sr, u0[1]! * cr - r0[1]! * sr, u0[2]! * cr - r0[2]! * sr,
        fx, fy, fz
      ]);

      const aspect = frame.width / frame.height;
      kit.draw(program, scene, {
        ...frame.audio.uniforms(kit),
        uScale: [Math.sqrt(aspect), 1 / Math.sqrt(aspect)], uCam: [x, y, camZ], uView: view,
        // A kick opens the lens a little: the surge is felt at the frame's edge.
        uFocal: 1.3 * (1 - (frame.gentle ? 0 : 0.06) * f.kick), uSeed: glassSeed, uBay: (bayStart + wrapBase / 2) % 65536,
        uSpark: 0.35 + 1.1 * high + 1.4 * f.hat, uVeinGain: 0.25 + 1.15 * bass,
        uGrow: look.growth * (1 + 0.07 * Math.sin(f.breath * Math.PI * 0.25) * (0.3 + mid)), uSlender: look.slender,
        uFacet: look.facets, uCut: look.cut, uLight: look.light, uShaft: look.shaft, uFlare: frame.gentle ? 0.4 : 1,
        uGlass: look.glass, uGlow: look.glow, uHaze: look.haze, uTint: look.tint, uVein: look.vein, uVeinHot: look.veinHot,
        uSun: sun.map((value) => value / sunLength), uFold: fold, uShardA: shardAxis, uShardE: shardAcross, uWave: waves
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom, threshold: 1.0, vignette: 0.35, contrast: 0.5, saturation: 1.12, gentle: frame.gentle
      });
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "crystal-cathedral",
  order: 4,
  kind: "vivid",
  labelPl: "Kryształowa katedra",
  labelEn: "Crystal Cathedral",
  descriptionPl: "Niekończący się lot nawą katedry wyrosłej z kryształu — witraże płoną kolorem, a każde uderzenie basu posyła falę światła w głąb.",
  usesSource: false,
  gentleByDefault: false,
  presets: [
    { id: "amethyst", labelPl: "Ametyst", labelEn: "Amethyst" },
    { id: "emerald", labelPl: "Szmaragd", labelEn: "Emerald" },
    { id: "ice", labelPl: "Lód", labelEn: "Ice" },
    { id: "amber", labelPl: "Bursztyn", labelEn: "Amber" }
  ],
  create
};
