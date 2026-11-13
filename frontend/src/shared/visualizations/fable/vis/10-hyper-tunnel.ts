import { COMMON } from "../core/glsl";
import { Kit, type Double, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Tunel hiperprzestrzeni — Hyperspace Tunnel.
 *
 * A flight down a tunnel whose walls are a true tiling of the hyperbolic plane. Each wall
 * strip between two seams is the band model of that plane (the strip |Im z| < π/2): depth
 * runs along the band, where a translation is an exact isometry, so the flight is endless and
 * the tiling is geometrically right everywhere; toward the seams the tiles crowd without limit
 * and melt into a line of light.
 *
 * A point of the band goes to the Poincaré disk (tanh z/2), is laid on a translation axis of
 * the tiling's symmetry group (found here, per tiling, as the shortest hyperbolic words of the
 * three mirrors) and is folded into the fundamental triangle by reflections. The fold also
 * carries a tangent vector, which lets the shader walk back from the triangle to the tile's
 * own centre and vertices in tunnel coordinates: every tile and every vertex has an identity
 * that stays with it as it flies past.
 *
 * Kicks push the flight and send a band of light down the tunnel; bass breathes the radius;
 * mids twist it; highs light the vertices; every few bars a gate sweeps up from the vanishing
 * point and leaves another cut of the tiling behind it.
 */

interface Axis {
  /** The translation's length along the axis. */
  length: number;
  /** The axis's nearest point to the disk's centre, and its direction there. */
  c: [number, number];
  tau: [number, number];
}

interface Tiling {
  /** The second mirror through the origin (its unit normal); the first is y = 0. */
  nB: [number, number];
  /** The third mirror: a circle about (d, 0) of radius rho, orthogonal to the unit circle. */
  d: number;
  rho: number;
  /** The tile's centre and a vertex of it, in the fundamental triangle. */
  centre: [number, number];
  vertex: [number, number];
  /** The tile's centre is at infinity (apeirogons). */
  ideal: boolean;
  /** How far the fundamental triangle reaches from the origin (Euclidean). */
  reach: number;
  axes: Axis[];
}

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function multiply(a: Matrix, b: Matrix): Matrix {
  const out: Matrix = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let index = 0; index < 3; index += 1) sum += a[row * 3 + index]! * b[index * 3 + column]!;
      out.push(sum);
    }
  }
  return out;
}

/** The reflection of the hyperboloid model in the geodesic with Minkowski normal `n`. */
function reflection(n: [number, number, number]): Matrix {
  const dual = [n[0], n[1], -n[2]];
  const out: Matrix = [];
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) out.push((row === column ? 1 : 0) - 2 * n[row]! * dual[column]!);
  return out;
}

/**
 * The triangle group (2, n, k) as the shader folds by it: mirrors y = 0, the line at π/n, and
 * a circle meeting them at π/2 and π/k. With `ideal` the tiles are the apeirogons about the
 * ideal corner; otherwise the n-gons about the origin.
 */
function buildTiling(n: number, k: number): Tiling {
  const sinN = Math.sin(Math.PI / n);
  const cosN = Math.cos(Math.PI / n);
  const ideal = !Number.isFinite(k);
  const cosK = ideal ? 1 : Math.cos(Math.PI / k);
  const root = Math.sqrt(cosK * cosK - sinN * sinN);
  const d = cosK / root;
  const rho = sinN / root;
  const along = d * cosN - Math.sqrt(Math.max(0, d * d * cosN * cosN - 1));
  const corner: [number, number] = [along * cosN, along * sinN];
  const mirrors = [reflection([0, 1, 0]), reflection([-sinN, cosN, 0]), reflection([d / rho, 0, 1 / rho])];
  // Translations of the group: even words of the mirrors with a trace over 3. Each has an
  // axis; the band is laid along it, so a step of the translation's length changes nothing.
  const found: Axis[] = [];
  const walk = (matrix: Matrix, last: number, length: number): void => {
    if (length > 0 && length % 2 === 0) {
      const trace = matrix[0]! + matrix[4]! + matrix[8]!;
      if (trace > 3.0005) {
        const span = Math.acosh((trace - 1) / 2);
        const lambda = Math.exp(span);
        const minusOne = matrix.map((value, index) => value - IDENTITY[index]!);
        const forward = multiply(minusOne, matrix.map((value, index) => value - IDENTITY[index]! / lambda));
        const backward = multiply(minusOne, matrix.map((value, index) => value - IDENTITY[index]! * lambda));
        const probe = [0.31, 0.17, 1.4];
        const end = (m: Matrix): [number, number] => {
          const x = m[0]! * probe[0]! + m[1]! * probe[1]! + m[2]! * probe[2]!;
          const y = m[3]! * probe[0]! + m[4]! * probe[1]! + m[5]! * probe[2]!;
          const t = m[6]! * probe[0]! + m[7]! * probe[1]! + m[8]! * probe[2]!;
          return [x / t, y / t];
        };
        const ahead = end(forward);
        const behind = end(backward);
        const sumX = ahead[0] + behind[0];
        const sumY = ahead[1] + behind[1];
        const sum = Math.hypot(sumX, sumY);
        if (sum < 1e-7) found.push({ length: span, c: [0, 0], tau: ahead });
        else {
          const bx = sumX / sum;
          const by = sumY / sum;
          const cosB = ahead[0] * bx + ahead[1] * by;
          const reach = (1 - Math.sqrt(Math.max(0, 1 - cosB * cosB))) / cosB;
          const sign = -by * ahead[0] + bx * ahead[1] < 0 ? -1 : 1;
          found.push({ length: span, c: [bx * reach, by * reach], tau: [-by * sign, bx * sign] });
        }
      }
    }
    if (length >= 10) return;
    for (let mirror = 0; mirror < 3; mirror += 1) if (mirror !== last) walk(multiply(mirrors[mirror]!, matrix), mirror, length + 1);
  };
  walk(IDENTITY, -1, 0);
  // One axis per length (conjugate axes carry the same row of tiles): the one nearest the centre.
  found.sort((a, b) => a.length - b.length || Math.hypot(a.c[0], a.c[1]) - Math.hypot(b.c[0], b.c[1]));
  const axes: Axis[] = [];
  for (const axis of found) if (!axes.some((kept) => Math.abs(kept.length - axis.length) < 1e-4) && axis.length < 3.6) axes.push(axis);
  return {
    nB: [-sinN, cosN], d, rho, centre: ideal ? corner : [0, 0], vertex: ideal ? [0, 0] : corner, ideal,
    reach: ideal ? d - rho : Math.hypot(corner[0], corner[1]), axes: axes.slice(0, 5)
  };
}

interface Look {
  n: number;
  k: number;
  /** How bright each family of mirrors is drawn: y = 0, the line at π/n, the circle. */
  edges: [number, number, number];
  /** Half the width of a full-weight line, in hyperbolic units. */
  lineWidth: number;
  /** Light of the lines (HDR), and how much of them is dark leading instead. */
  lineGain: number;
  lead: number;
  /** Light of the faces: the designed ones, and a picture's; and how evenly a face is lit (0: only beside its lines). */
  faceGain: number;
  picGain: number;
  fill: number;
  /** The hue's step between a tile's two kinds of triangle. */
  parity: number;
  /** Film thickness (0–1 of the table) at a tile: base, spread between tiles, rings inside one, alternate facets. */
  film: [number, number, number, number];
  /** Sector pairs to choose from. */
  sectors: number[];
  /** Flat walls (1) or a round bore (0). */
  poly: number;
  focal: number;
  alpha: number;
  /** The lines' colours, a ring of five (linear), and how fast they turn along depth. */
  stops: number[];
  paletteRate: number;
  /** The light at the vanishing point. */
  core: [number, number, number];
  sparkle: number;
  echo: number;
  exposure: number;
  bloom: number;
}

const LOOKS: Record<string, Look> = {
  neon: {
    n: 7, k: 3, edges: [0.14, 0.0, 1.0], lineWidth: 0.014, lineGain: 1.0, lead: 0, faceGain: 0.22, picGain: 0.4, fill: 0, parity: 0, film: [0.26, 0.3, 0.22, 0.07],
    sectors: [3, 4], poly: 0, focal: 0.7, alpha: 0.8, stops: [0.0, 0.75, 1.0, 0.08, 0.2, 1.0, 0.5, 0.1, 1.0, 1.0, 0.05, 0.5, 1.0, 0.4, 0.05], paletteRate: 0.22,
    core: [0.6, 0.85, 1.0], sparkle: 1, echo: 0.55, exposure: 1.1, bloom: 0.4
  },
  glass: {
    n: 5, k: 4, edges: [0.5, 0.42, 1.0], lineWidth: 0.024, lineGain: 0.9, lead: 1, faceGain: 0.65, picGain: 0.8, fill: 1, parity: 0.14, film: [0.24, 0.42, 0.16, 0.1],
    sectors: [3, 4], poly: 0, focal: 0.7, alpha: 0.8, stops: [1.0, 0.7, 0.25, 1.0, 0.45, 0.2, 0.9, 0.3, 0.5, 0.5, 0.4, 1.0, 0.3, 0.8, 0.9], paletteRate: 0.2,
    core: [1.0, 0.85, 0.6], sparkle: 0.6, echo: 0.3, exposure: 1.0, bloom: 0.35
  },
  apeirogon: {
    n: 3, k: Infinity, edges: [1.0, 0.0, 0.3], lineWidth: 0.016, lineGain: 1.1, lead: 0, faceGain: 0.25, picGain: 0.6, fill: 0.1, parity: 0, film: [0.2, 0.25, 0.5, 0.0],
    sectors: [3, 4], poly: 0, focal: 0.7, alpha: 0.8, stops: [1.0, 0.6, 0.1, 1.0, 0.15, 0.4, 0.55, 0.15, 1.0, 0.1, 0.5, 1.0, 0.1, 0.9, 0.7], paletteRate: 0.25,
    core: [1.0, 0.7, 0.9], sparkle: 0.8, echo: 0.45, exposure: 1.0, bloom: 0.5
  },
  crystal: {
    n: 4, k: 5, edges: [0.22, 0.3, 1.0], lineWidth: 0.012, lineGain: 0.9, lead: 0, faceGain: 0.2, picGain: 0.6, fill: 0.12, parity: 0.1, film: [0.3, 0.2, 0.1, 0.16],
    sectors: [3, 4], poly: 1, focal: 0.7, alpha: 0.8, stops: [0.15, 0.75, 1.0, 0.1, 0.3, 1.0, 0.5, 0.25, 1.0, 0.95, 0.35, 0.85, 0.2, 1.0, 0.75], paletteRate: 0.18,
    core: [0.8, 0.95, 1.0], sparkle: 1.2, echo: 0.4, exposure: 1.0, bloom: 0.4
  }
};

/** Interference colours by film thickness, 0–1000 nm across: the iridescent fills' palette. */
const FILM_TABLE = COMMON + /* glsl */ `
void main() {
  vec3 c = thinFilm(vUv.x * 1000.0, 1.0);
  c = max(mix(vec3(luma(c)), c, 1.9), 0.0);
  fragColor = vec4(c, 1.0);
}
`;

/** The listener's picture into a square of our own with a full mip chain (a video frame has none). */
const COPY = /* glsl */ `
uniform sampler2D uSrc;
void main() { fragColor = vec4(texture(uSrc, vUv).rgb, 1.0); }
`;

const PULSES = 4;

const SCENE = COMMON + /* glsl */ `
#define ITER 44
uniform sampler2D uPrev, uPic, uFilm;
uniform vec2 uSize;
uniform float uUnit, uT, uHasPic, uIdeal, uGateLr, uGateGlow, uFocal, uAlpha, uRadius;
uniform vec4 uGeo[2], uAxis[2], uBand[2], uPts[2], uShape[2], uEdge[2], uTone[2];
uniform vec4 uPulse[${PULSES}];
uniform vec4 uLine;      // half width, gain, leading, rate of the palette along depth
uniform vec4 uFace;      // gain, sparkle, how evenly a face is lit, gain of a picture
uniform vec4 uPane;      // how far the hue steps between the two kinds of triangle in a tile
uniform vec4 uGain;      // what a pulse adds to the lines and to the faces, its own haze, how far it goes by tiles
uniform vec4 uDepth;     // the fog's power and its light, the vanishing point's light and its halo
uniform vec4 uFilmSet;   // base, spread between tiles, rings, facets
uniform vec4 uEcho;      // zoom, turn, threshold, amount
uniform vec4 uPicMap;    // the picture's turn and scale (a complex factor), and its drift
uniform vec3 uStops[5];
uniform vec3 uCore;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b); }
vec2 cconj(vec2 a) { return vec2(a.x, -a.y); }

// Depth along the bore at a screen radius: 1 at the unit circle, rising toward the centre.
// uAlpha 1 is true perspective, toward 0 the self-similar logarithm.
float depthOf(float x) { return (pow(x, -uAlpha) - 1.0) / uAlpha + 1.0; }
// And back: the log of the screen radius at a depth.
float radiusLog(float d) { return -log(max(uAlpha * (d - 1.0) + 1.0, 1e-3)) / uAlpha; }

struct Wall {
  vec2 zb;     // the band coordinate, before the flight is added
  float lr;    // log of the screen radius
  float k;     // which side of the gate
  float foot;  // a pixel's size in band units
};

Wall wallAt(vec2 p) {
  Wall wl;
  float r = max(length(p), 1e-4) / uRadius;
  wl.lr = log(r);
  wl.k = wl.lr < uGateLr ? 1.0 : 0.0;
  int k = int(wl.k);
  vec4 band = uBand[k], shape = uShape[k];
  float m = band.x;
  // The angle, rolled, and twisted more the deeper it lies; then mirrored into sectors.
  float th = atan(p.y, p.x) + shape.y - shape.x * wl.lr;
  float u = fract(th * m / TAU);
  float y = 1.0 - 2.0 * abs(2.0 * u - 1.0);
  float span = PI / (2.0 * m);
  float tp = y * span;
  float xw = r * mix(1.0, cos(tp), shape.z);
  float yw = mix(y, tan(tp) / tan(span), shape.z);
  float sc = band.y / mix(span, tan(span), shape.z);
  wl.zb = vec2(sc * uFocal * depthOf(xw), band.y * yw);
  // From the mapping itself rather than screen derivatives, which break at the gate: the
  // greater of the steps along the bore and around it.
  wl.foot = 1.15 * sc / (max(length(p), 1e-4) * uUnit) * max(uFocal * pow(xw, -uAlpha), mix(1.0, 1.0 / sq(cos(tp)), shape.z)) * sqrt(1.0 + sq(shape.x));
  return wl;
}

// A point of the placed disk back in band coordinates.
vec2 bandOf(vec2 zp, vec4 axis) {
  vec2 zq = cmul(cconj(axis.zw), cdiv(zp - axis.xy, vec2(1.0, 0.0) - cmul(cconj(axis.xy), zp)));
  vec2 a = vec2(1.0 + zq.x, zq.y), b = vec2(1.0 - zq.x, -zq.y);
  return vec2(0.5 * log(max(dot(a, a), 1e-12) / max(dot(b, b), 1e-12)), atan(a.y, a.x) - atan(b.y, b.x));
}

// Where the point P of the fundamental triangle lies in the placed disk, for the copy of the
// triangle that z0 folded into: along the geodesic from z0 whose direction the fold's carried
// tangent v gives.
vec2 unfold(vec2 P, vec2 w, vec2 v, float odd, vec2 z0) {
  vec2 mm = cdiv(P - w, vec2(1.0, 0.0) - cmul(cconj(w), P));
  float t = length(mm);
  vec2 g = mm / max(t, 1e-7);
  vec2 u = odd > 0.5 ? cmul(cconj(g), v) : cmul(g, cconj(v));
  vec2 s = t * u;
  return cdiv(z0 + s, vec2(1.0, 0.0) + cmul(cconj(z0), s));
}

// The film table read back and forth, so any thickness lands in its vivid orders.
vec3 film(float t) { return texture(uFilm, vec2(0.17 + 0.5 * (0.5 - 0.5 * cos(PI * t)), 0.5)).rgb; }
// The look's own colours, in a ring. Between two stops the grey that mixing them makes is
// taken out again, so the way from one to the next runs through pure colours (orange to cyan
// by way of green, not by way of grey).
vec3 neon(float t) {
  t = fract(t) * 5.0;
  int i = min(int(t), 4);
  float f = t - float(i);
  f = f * f * (3.0 - 2.0 * f);
  vec3 a = uStops[i], b = uStops[(i + 1) % 5];
  vec3 c = mix(a, b, f);
  float grey = min(c.r, min(c.g, c.b)) - mix(min(a.r, min(a.g, a.b)), min(b.r, min(b.g, b.b)), f);
  c -= 0.94 * grey;
  return c * mix(max(a.r, max(a.g, a.b)), max(b.r, max(b.g, b.b)), f) / max(max(c.r, max(c.g, c.b)), 1e-4);
}

// How much of a pixel a line of half width w covers at distance d, the pixel being e across.
// A line never gets thinner than the pixel: where tiles crowd, the lines close into a seam.
float lineCover(float d, float w, float e) {
  float wide = max(w, 0.6 * e);
  return saturate((wide - d) / e + 0.5) * mix(1.0, w / wide, 0.35);
}

vec3 shade(Wall wl) {
  int k = int(wl.k);
  vec4 geo = uGeo[k], axis = uAxis[k], band = uBand[k], pts = uPts[k], shape = uShape[k], edge = uEdge[k], tone = uTone[k];
  float L = band.z;
  float re = wl.zb.x + band.w;
  float n = floor(re / L + 0.5);
  re -= n * L;
  float im = wl.zb.y;
  // A pixel's size in hyperbolic units: what decides how much of the tiling it can still show.
  float eps = wl.foot / max(cos(im), 0.002);
  float res = 1.0 - smoothstep(0.1, 0.45, eps);

  // Band -> disk -> onto the translation axis.
  vec2 zd = vec2(sinh(re), sin(im)) / (cosh(re) + cos(im));
  vec2 tz = cmul(axis.zw, zd);
  vec2 z0 = cdiv(tz + axis.xy, vec2(1.0, 0.0) + cmul(cconj(axis.xy), tz));

  // The fold: reflect in whichever mirror the point is on the wrong side of, until none.
  vec2 w = z0, v = vec2(1.0, 0.0);
  vec2 nB = geo.xy;
  float cd = geo.z, cr2 = geo.w * geo.w, flips = 0.0;
  int iterations = eps > 0.6 ? 0 : ITER;
  for (int i = 0; i < iterations; i++) {
    bool moved = false;
    if (w.y < 0.0) { w.y = -w.y; v.y = -v.y; flips += 1.0; moved = true; }
    float sB = dot(w, nB);
    if (sB > 0.0) { w -= 2.0 * sB * nB; v -= 2.0 * dot(v, nB) * nB; flips += 1.0; moved = true; }
    vec2 q = vec2(w.x - cd, w.y);
    float qq = dot(q, q);
    if (qq < cr2) { w = vec2(cd, 0.0) + q * (cr2 / qq); v -= 2.0 * dot(v, q) / qq * q; flips += 1.0; moved = true; }
    if (!moved) break;
  }
  float odd = mod(flips, 2.0);
  float om = max(1.0 - dot(w, w), 1e-5);
  // Hyperbolic distances to the three mirrors.
  float dA = asinh(2.0 * max(w.y, 0.0) / om);
  float dB = asinh(2.0 * max(-dot(w, nB), 0.0) / om);
  vec2 qc = vec2(w.x - cd, w.y);
  float dC = asinh(max(dot(qc, qc) - cr2, 0.0) / (geo.w * om));

  // The tile this is: its centre in tunnel coordinates, and how far from it we are (for an
  // apeirogon, whose centre is at infinity, the height over its horocycles).
  vec2 cen = bandOf(unfold(pts.xy, w, v, odd, z0), axis);
  // How deep the tile's centre lies, as the log of a screen radius, and this point the same way.
  float span = PI / (2.0 * band.x);
  float perDepth = uFocal * band.y / mix(span, tan(span), shape.z);
  float deepTile = radiusLog((cen.x + n * L - band.w) / perDepth);
  float deepHere = radiusLog(wl.zb.x / perDepth);
  cen.x += (n + shape.w) * L;
  float ring;
  if (uIdeal > 0.5) {
    vec2 dd = pts.xy - w;
    ring = -log(max(dot(dd, dd), 1e-9) / om);
  } else {
    vec2 mm = cdiv(pts.xy - w, vec2(1.0, 0.0) - cmul(cconj(w), pts.xy));
    ring = 2.0 * atanh(min(length(mm), 0.9999));
  }
  float id = cen.x * 1.31 + cen.y * 2.17;
  float tone1 = 0.5 + 0.5 * sin(id + 1.7 * sin(cen.x * 0.47 + cen.y));
  float tone2 = 0.5 + 0.5 * sin(id * 0.63 + 2.1);

  // The kicks' light, each a band in depth on its way down the tunnel. It runs half by the
  // point's own depth and half by its tile's, so its front steps from tile to tile.
  float deep = mix(deepHere, deepTile, uGain.w * res);
  float pulse = 0.0;
  for (int i = 0; i < ${PULSES}; i++) pulse += uPulse[i].y * exp(-sq((deep - uPulse[i].x) / uPulse[i].z));

  // Faces: glass lit from behind. A deep colour of the look's own per tile with an interference
  // sheen over it, brightest where the tubes beside it shine through; or the picture, folded.
  float hue = tone.x - uLine.w * wl.lr + 0.14 * tone2 + 0.02 * uT + 0.035 * pulse;
  vec3 glow = neon(hue);
  float thickness = uFilmSet.x + tone.y + uFilmSet.y * tone1 + uFilmSet.z * ring - uT * 0.06 + 0.05 * pulse;
  vec3 sheen = film(thickness);
  float nearest = min(min(edge.x > 0.4 ? dA : 9.0, edge.y > 0.4 ? dB : 9.0), edge.z > 0.4 ? dC : 9.0);
  float crease = min(edge.x > 0.4 ? 9.0 : dA, edge.y > 0.4 ? 9.0 : dB);
  float facet = (1.0 + uFilmSet.w * (2.0 * odd - 1.0) * smoothstep(0.0, 2.5 * eps + 0.004, crease));
  vec3 tint = neon(hue - 0.035 * pulse + 0.3 + 0.45 * tone1 + uPane.x * (odd - 0.5));
  tint = tint * tint * (0.7 + 0.6 * sheen);
  // Lit by the tubes beside it, or (leaded glass) by the day behind it: brightest in the middle.
  float light = mix(0.1 + 0.9 * exp(-nearest * 6.0), 0.22 + 0.78 * (1.0 - exp(-nearest * 5.0)), uFace.z);
  vec3 face = tint * light * (1.0 + uGain.y * (1.0 - 0.5 * uFace.z) * pulse) * facet;
  vec2 uv = 0.5 + cmul(w, uPicMap.xy) + uPicMap.zw;
  // The picture's level of detail from the pixel's own size in the disk: no seams where the fold turns.
  float lod = log2(max(eps * om * 0.5 * length(uPicMap.xy) * 512.0, 1.0)) + 3.0 * (1.0 - res);
  vec3 pic = textureLod(uPic, uv, lod).rgb;
  pic = max(mix(vec3(luma(pic)), pic, 1.35), 0.0);
  vec3 pane = pic * (0.5 + 1.0 * sheen) * (0.3 + 0.7 * (1.0 - exp(-nearest * 7.0))) * (0.5 + 0.5 * facet);
  face = mix(face * uFace.x, pane * uFace.w * (1.0 + 0.3 * uGain.y * pulse), uHasPic);

  // Lines of constant hyperbolic width along the mirrors: a hot core, the tube, its halo.
  float wide = uLine.x;
  float la = edge.x * lineCover(dA, wide * (0.4 + 0.6 * edge.x), eps);
  float lb = edge.y * lineCover(dB, wide * (0.4 + 0.6 * edge.y), eps);
  float lc = edge.z * lineCover(dC, wide * (0.4 + 0.6 * edge.z), eps);
  float lines = 1.0 - (1.0 - la) * (1.0 - lb) * (1.0 - lc);
  float hot = max(max(edge.x * lineCover(dA, wide * 0.3, eps), edge.y * lineCover(dB, wide * 0.3, eps)), edge.z * lineCover(dC, wide * 0.3, eps));
  float halo = max(max(edge.x * exp(-dA / 0.035), edge.y * exp(-dB / 0.035)), edge.z * exp(-dC / 0.035));
  halo += 0.18 * max(max(edge.x * exp(-dA / 0.16), edge.y * exp(-dB / 0.16)), edge.z * exp(-dC / 0.16));
  float lit = uLine.y * (1.0 + uGain.x * pulse);
  vec3 col = face * (1.0 - uLine.z * lines);
  col += glow * lit * (lines + 0.16 * halo) * (1.0 - uLine.z);
  col += mix(glow, vec3(1.0), 0.3) * lit * 1.4 * hot * (1.0 - uLine.z);
  col += glow * pulse * uGain.z;

  // Vertices: sparks that the highs light, each on its own beat.
  vec2 mv = cdiv(pts.zw - w, vec2(1.0, 0.0) - cmul(cconj(w), pts.zw));
  float dV = 2.0 * length(mv);
  if (dV < 0.5 && uFace.y > 0.0) {
    vec2 vid = bandOf(unfold(pts.zw, w, v, odd, z0), axis);
    vid.x += (n + shape.w) * L;
    float twinkle = pow(0.5 + 0.5 * sin(dot(vid, vec2(7.31, 11.17)) + uT * 2.3), 6.0);
    float size = max(0.03, 1.2 * eps);
    col += (0.5 + 0.5 * glow) * uFace.y * twinkle * exp(-sq(dV / size)) * 9.0 * sq(0.03 / size);
  }

  // Where a pixel holds many tiles there is only their light: the seam.
  // Nothing of it comes from the fold, which has nothing to say there.
  float pulseFar = 0.0;
  for (int i = 0; i < ${PULSES}; i++) pulseFar += uPulse[i].y * exp(-sq((deepHere - uPulse[i].x) / uPulse[i].z));
  float hueFar = tone.x - uLine.w * wl.lr + 0.07 + 0.02 * uT + 0.035 * pulseFar;
  vec3 pale = neon(hueFar + 0.52);
  // Between two walls it is a rail of light; down the bore, only what little the far tiles give.
  float rail = 1.0 - smoothstep(0.0, 0.1, cos(im));
  vec3 seam = neon(hueFar) * uLine.y * (1.0 + uGain.x * pulseFar) * (0.2 + 0.4 * rail) * (1.0 - 0.92 * uLine.z);
  seam += mix(pale * pale * 0.25 * uFace.x, textureLod(uPic, vec2(0.5), 8.0).rgb * 0.45 * uFace.w, uHasPic) * (1.0 + 0.5 * uGain.y * pulseFar);
  col = mix(seam, col, res);

  // The gate between two sections of the tunnel.
  float gd = wl.lr - uGateLr;
  col *= 1.0 - 0.6 * exp(-sq(gd / 0.04));

  // Depth: the far wall sinks into a dark haze, and at the end of it stands the light.
  float rr = exp(wl.lr);
  float fog = pow(min(rr, 1.0), uDepth.x);
  col = col * fog + uCore * uDepth.y * (1.0 - fog);
  col += neon(uTone[1].x + 0.08) * (2.5 * exp(-sq(gd / 0.014)) + 0.3 * exp(-abs(gd) / 0.07)) * uGateGlow * smoothstep(0.0, 0.25, rr);
  col += uCore * (uDepth.z / (1.0 + sq(rr / 0.012)) + uDepth.w * exp(-rr / 0.1));
  return col;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uSize) / uUnit;
  Wall wl = wallAt(p);
  vec3 col = shade(wl);
  // Echoes: the last frame, a little nearer and a little turned, where it was bright.
  vec2 q = rot(uEcho.y) * p * (1.0 - uEcho.x);
  vec3 prev = texture(uPrev, q * uUnit / uSize + 0.5).rgb;
  col += max(prev - uEcho.z, 0.0) * uEcho.w;
  fragColor = vec4(min(col, vec3(40.0)), 1.0);
}
`;

interface Section {
  axis: Axis;
  /** Mirrored pairs of sectors about the bore. */
  sectors: number;
  /** Which way it twists and rolls. */
  turn: number;
  hue: number;
  filmShift: number;
}

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const gl = kit.gl;
  const look = LOOKS[preset] ?? LOOKS.neon!;
  const random = seededRandom(seed * 6151 + 29);
  const tiling = buildTiling(look.n, look.k);
  const programs = { scene: kit.program(SCENE), table: kit.program(FILM_TABLE), copy: kit.program(COPY) };
  const film = kit.target(512, 1, "rgba16f");
  let tablesDrawn = false;

  // The picture, copied into a texture with a mip chain: tiles of every size sample it cleanly.
  const PICTURE = 512;
  const pictureTexture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, pictureTexture);
  gl.texStorage2D(gl.TEXTURE_2D, 10, gl.RGBA16F, PICTURE, PICTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  const pictureFramebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, pictureFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pictureTexture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const picture: Target = { texture: pictureTexture, textures: [pictureTexture], framebuffer: pictureFramebuffer, width: PICTURE, height: PICTURE, format: "rgba16f" };
  let pictureAge = 1e9;

  let scene: Double | null = null;

  // What the seed decides: the cut of the tiling, the sector count, the turn, the colours.
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length) % list.length]!;
  const section = (previous: Section | null): Section => {
    let axis = pick(tiling.axes);
    let sectors = pick(look.sectors);
    // A new section differs from the last in the cut or in the sector count.
    for (let attempt = 0; attempt < 6 && previous && axis === previous.axis && sectors === previous.sectors; attempt += 1) {
      axis = pick(tiling.axes);
      sectors = pick(look.sectors);
    }
    return {
      axis, sectors, turn: previous ? -previous.turn : random() < 0.5 ? -1 : 1,
      hue: (previous ? previous.hue + 0.17 + 0.3 * random() : random()) % 1, filmShift: random() * 2
    };
  };
  const first = section(null);
  const sections: [Section, Section] = [first, first];
  const band = 0.995 * Math.PI / 2;
  const geo = new Float32Array(8);
  const axes = new Float32Array(8);
  const bands = new Float32Array(8);
  const points = new Float32Array(8);
  const shapes = new Float32Array(8);
  const edges = new Float32Array(8);
  const tones = new Float32Array(8);
  const pulses = new Float32Array(PULSES * 4);
  for (let index = 0; index < PULSES; index += 1) pulses.set([9, 0, 0.2, 0], index * 4);
  let nextPulse = 0;
  let depth = random() * 40;
  let roll = random() * Math.PI * 2;
  let surge = 0;
  let bass = 0;
  let mid = 0;
  let gate = -100;
  let sinceGate = 0;
  let beatsAtGate = 0;
  const pictureTurn = random() * Math.PI * 2;

  return {
    render(frame: FvFrame): void {
      if (!tablesDrawn) {
        // With the first frame, not at creation: nothing waits for a program still compiling.
        kit.draw(programs.table, film, {});
        tablesDrawn = true;
      }
      const f = frame.audio.features;
      const dt = Math.min(0.1, frame.dt);
      const gentle = frame.gentle;
      const [width, height] = workSize(frame);
      scene = kit.fitDouble(scene, width, height, "rgba16f", {}, true);

      const hasPicture = environment.source.kind !== "none";
      if (hasPicture) {
        pictureAge += 1;
        if (environment.source.kind === "video" || pictureAge > 20) {
          kit.draw(programs.copy, picture, { uSrc: environment.source.texture });
          gl.bindTexture(gl.TEXTURE_2D, pictureTexture);
          gl.generateMipmap(gl.TEXTURE_2D);
          pictureAge = 0;
        }
      }

      // The music's part.
      const ease = (current: number, target: number, seconds: number): number => current + (target - current) * (1 - Math.exp(-dt / seconds));
      bass = ease(bass, f.bass * f.presence, 0.22);
      mid = ease(mid, f.mid * f.presence, 0.7);
      surge = ease(surge, f.kick, f.kick > surge ? (gentle ? 0.2 : 0.09) : 0.5);
      const speed = 0.32 + 0.5 * f.level * f.presence + surge * (gentle ? 0.7 : 1.3);
      depth += speed * dt;
      roll += dt * 0.025 * sections[0].turn;
      if (f.onset) {
        pulses.set([Math.log(1.9), gentle ? 0.7 : 0.9, gentle ? 0.12 : 0.09, 0], nextPulse * 4);
        nextPulse = (nextPulse + 1) % PULSES;
      }
      for (let index = 0; index < PULSES; index += 1) {
        pulses[index * 4] = pulses[index * 4]! - dt * (gentle ? 1.6 : 2.2);
        pulses[index * 4 + 1] = pulses[index * 4 + 1]! * Math.exp(-dt / 1.1);
      }

      // Gates: after so many beats (or so long without any) the next section sweeps up.
      sinceGate += dt;
      if (gate < -50) {
        const beats = f.beat - beatsAtGate;
        if (sinceGate > 6 && (beats >= (gentle ? 32 : 16) || sinceGate > (gentle ? 34 : 22))) {
          sections[1] = section(sections[0]);
          gate = Math.log(0.012);
        }
      } else {
        gate += dt * (gentle ? 0.6 : 0.95);
        if (gate > Math.log(1.9)) {
          sections[0] = sections[1];
          gate = -100;
          sinceGate = 0;
          beatsAtGate = f.beat;
        }
      }

      for (let index = 0; index < 2; index += 1) {
        const part = sections[index]!;
        const span = Math.PI / (2 * part.sectors);
        const perUnit = band / (span + (Math.tan(span) - span) * look.poly);
        const flight = perUnit * look.focal * depth;
        const periods = Math.floor(flight / part.axis.length);
        geo.set([tiling.nB[0], tiling.nB[1], tiling.d, tiling.rho], index * 4);
        axes.set([part.axis.c[0], part.axis.c[1], part.axis.tau[0], part.axis.tau[1]], index * 4);
        bands.set([part.sectors, band, part.axis.length, flight - periods * part.axis.length], index * 4);
        points.set([tiling.centre[0], tiling.centre[1], tiling.vertex[0], tiling.vertex[1]], index * 4);
        shapes.set([part.turn * (0.1 + (gentle ? 0.22 : 0.4) * mid), roll, look.poly, periods % 8192], index * 4);
        edges.set([look.edges[0], look.edges[1], look.edges[2], 0], index * 4);
        tones.set([part.hue, part.filmShift, 0, 0], index * 4);
      }

      const unit = Math.sqrt(width * height) / 2;
      const pictureScale = 0.42 / tiling.reach;
      const pictureAngle = pictureTurn + f.flow * 0.03;
      kit.draw(programs.scene, scene.write, {
        uPrev: scene.read, uPic: pictureTexture, uFilm: film, uSize: [width, height], uUnit: unit, uT: f.flow,
        uHasPic: hasPicture ? 1 : 0, uIdeal: tiling.ideal ? 1 : 0, uGateLr: gate, uGateGlow: gentle ? 0.5 : 1.0,
        uFocal: look.focal, uAlpha: look.alpha, uRadius: 1 + 0.07 * bass,
        uGeo: geo, uAxis: axes, uBand: bands, uPts: points, uShape: shapes, uEdge: edges, uTone: tones, uPulse: pulses,
        uLine: [look.lineWidth, look.lineGain, look.lead, look.paletteRate],
        uFace: [look.faceGain, look.sparkle * (0.12 + 0.9 * f.high + 0.8 * f.hat), look.fill, look.picGain],
        uGain: gentle ? [2.6, 4.0, 0.03, 0.55] : [3.6, 4.6, 0.04, 0.55], uDepth: [1.1, 0.01, 5, 0.18],
        uFilmSet: look.film, uPane: [look.parity, 0, 0, 0], uEcho: [0.012 + 0.02 * surge, 0.004 * sections[0].turn, 0.7, look.echo],
        uPicMap: [Math.cos(pictureAngle) * pictureScale, Math.sin(pictureAngle) * pictureScale, 0.12 * Math.sin(f.flow * 0.041), 0.12 * Math.cos(f.flow * 0.033)],
        uStops: look.stops, uCore: look.core
      });
      scene.swap();
      environment.post.render(scene.read, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom, bloomRadius: 0.6, threshold: 1.0, vignette: 0.3, contrast: 0.4, saturation: 1.1, aberration: 0.0035 + 0.005 * surge, gentle
      });
    },
    destroy(): void {
      gl.deleteFramebuffer(pictureFramebuffer);
      gl.deleteTexture(pictureTexture);
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "hyper-tunnel",
  order: 10,
  kind: "psychedelic",
  labelPl: "Tunel hiperprzestrzeni",
  labelEn: "Hyperspace Tunnel",
  descriptionPl: "Lot tunelem, którego ściany są prawdziwą mozaiką hiperboliczną — kafle gęstnieją w nieskończoność ku świetlistym szwom.",
  usesSource: true,
  gentleByDefault: true,
  presets: [
    { id: "neon", labelPl: "Neon {7,3}", labelEn: "Neon {7,3}" },
    { id: "glass", labelPl: "Witraż {5,4}", labelEn: "Stained Glass {5,4}" },
    { id: "apeirogon", labelPl: "Apeirogon {∞,3}", labelEn: "Apeirogon {∞,3}" },
    { id: "crystal", labelPl: "Kryształ {4,5}", labelEn: "Crystal {4,5}" }
  ],
  create
};
