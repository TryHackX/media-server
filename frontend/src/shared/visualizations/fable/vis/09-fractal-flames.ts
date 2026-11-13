import { BICUBIC, COMMON } from "../core/glsl";
import { Kit, type Double, type Format, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Fraktalne płomienie — Fractal Flames.
 *
 * The chaos game of an iterated function system with nonlinear variations (Draves' fractal
 * flame algorithm), played on the GPU by over three million points at once: each frame every
 * point takes one transform, picked at random by weight, and is counted into a histogram that
 * remembers the last half second or so. The picture is that histogram developed as a flame is:
 * a density estimate (sparse counts pooled over wider neighbourhoods, dense ones left sharp),
 * brightness by the logarithm of the density, colour by the average of what landed.
 *
 * The transforms — the genome — move all the time: along the keyframes of the preset's family,
 * with the mids swinging the affine parts, and every kick an impulse that makes the shape bloom
 * and settle. The histogram remembers longer while the genome is calm (silk) and less while it
 * moves fast (no smear). Colour comes from the listener's picture when there is one (a palette
 * read off it along a slow loop), from the preset's own palettes otherwise.
 */

const TRANSFORMS = 3;

/**
 * The variations a transform may blend, each as GLSL of the point `p`, its radius `r`, `r2`
 * (the radius squared), its angle `th` and `turn` (the angle on the root's branch). Textbook
 * definitions (Draves & Reckase), written out here.
 */
const VARIATION = {
  linear: "p",
  sinusoidal: "sin(p)",
  spherical: "p / r2",
  swirl: "vec2(p.x * sin(r2) - p.y * cos(r2), p.x * cos(r2) + p.y * sin(r2))",
  horseshoe: "vec2((p.x - p.y) * (p.x + p.y), 2.0 * p.x * p.y) / r",
  polar: "vec2(th / PI, r - 1.0)",
  handkerchief: "r * vec2(sin(th + r), cos(th - r))",
  heart: "r * vec2(sin(th * r), -cos(th * r))",
  disc: "(th / PI) * vec2(sin(PI * r), cos(PI * r))",
  root: "pow(r, 1.0 / uRoot) * vec2(cos(turn), sin(turn))",
  bubble: "p * 4.0 / (r2 + 4.0)",
  spiral: "vec2(cos(th) + sin(r), sin(th) - cos(r)) / r",
  hyperbolic: "vec2(sin(th) / r, r * cos(th))",
  diamond: "vec2(sin(th) * cos(r), cos(th) * sin(r))",
  eyefish: "p * 2.0 / (r + 1.0)"
} as const;
type Variation = keyof typeof VARIATION;

/** Numbers per transform in a flattened genome before its variations: weight, turn, ln scale, ln stretch, skew, x, y, colour. */
const HEAD = 8;
/** Iterations a re-seeded point makes before it is counted. */
const FUSE = 8;
const STOPS = 8;
const PALETTE_SIZE = 256;
const BINS = 128;

interface Transform {
  /** How often it is picked. */
  weight: number;
  /** The affine part: R(turn) · diag(scale · stretch, scale / stretch) · R(skew), then the offset. */
  turn: number;
  scale: number;
  stretch: number;
  skew: number;
  x: number;
  y: number;
  /** Where on the palette it pulls a point's colour. */
  colour: number;
  blend: Partial<Record<Variation, number>>;
}

type Key = readonly Transform[];

interface Family {
  /** Genomes found by eye, relatives of one another; the flame travels through them in a closed loop. */
  keys: readonly Key[];
  /** Orders of rotational symmetry the seed chooses among. */
  symmetry: readonly number[];
  mirror: boolean;
  /** The power of the root variation. */
  root: number;
  /** How far the mids swing each transform's affine part, radians. */
  swing: readonly number[];
  /** What a kick does to one transform: a variation of it swells, it turns, and it grows (a share of its scale). */
  impulse: { transform: number; variation: Variation; amount: number; turn: number; grow: number };
  /** Palettes used with no picture: eight sRGB stops each, cyclic. */
  palettes: readonly (readonly string[])[];
  /** Keys per second of musical time. */
  morph: number;
  /** The development: the exponent on the logarithm of the density, and the light of the densest parts. */
  curve: number;
  gain: number;
}

const FAMILIES: Record<string, Family> = {
  gossamer: {
    keys: [
      [
        { weight: 0.24, turn: 0.01, scale: 0.839, stretch: 1.155, skew: 5.624, x: -0.164, y: -0.491, colour: 0.1, blend: { horseshoe: 0.844, linear: 0.468 } },
        { weight: 0.222, turn: 1.205, scale: 0.864, stretch: 0.76, skew: 5.351, x: -0.154, y: -0.517, colour: 0.5, blend: { root: 0.521, bubble: 0.301 } },
        { weight: 0.599, turn: 2.909, scale: 0.811, stretch: 1.059, skew: 1.048, x: -0.187, y: 0.386, colour: 0.9, blend: { hyperbolic: 0.605, eyefish: 0.208 } }
      ],
      [
        { weight: 0.23, turn: 0.11, scale: 0.893, stretch: 1.197, skew: 5.862, x: -0.172, y: -0.564, colour: 0.1, blend: { horseshoe: 0.951, linear: 0.481 } },
        { weight: 0.217, turn: 1.112, scale: 0.941, stretch: 0.743, skew: 5.692, x: -0.284, y: -0.564, colour: 0.5, blend: { root: 0.517, bubble: 0.306 } },
        { weight: 0.674, turn: 3.192, scale: 0.746, stretch: 0.996, skew: 1.062, x: -0.141, y: 0.283, colour: 0.9, blend: { hyperbolic: 0.704, eyefish: 0.175 } }
      ],
      [
        { weight: 0.223, turn: -0.387, scale: 0.774, stretch: 1.098, skew: 5.764, x: -0.197, y: -0.43, colour: 0.1, blend: { horseshoe: 0.874, linear: 0.562 } },
        { weight: 0.189, turn: 1.522, scale: 0.782, stretch: 0.743, skew: 5.293, x: -0.119, y: -0.573, colour: 0.5, blend: { root: 0.579, bubble: 0.348 } },
        { weight: 0.565, turn: 2.758, scale: 0.745, stretch: 1.063, skew: 0.85, x: -0.188, y: 0.517, colour: 0.9, blend: { hyperbolic: 0.71, eyefish: 0.178 } }
      ],
      [
        { weight: 0.245, turn: 0.359, scale: 0.858, stretch: 1.098, skew: 5.669, x: -0.156, y: -0.44, colour: 0.1, blend: { horseshoe: 0.749, linear: 0.524 } },
        { weight: 0.214, turn: 1.543, scale: 0.814, stretch: 0.764, skew: 5.409, x: -0.024, y: -0.425, colour: 0.5, blend: { root: 0.463, bubble: 0.304 } },
        { weight: 0.552, turn: 2.579, scale: 0.825, stretch: 1.089, skew: 1.011, x: -0.055, y: 0.366, colour: 0.9, blend: { hyperbolic: 0.673, eyefish: 0.178 } }
      ]
    ],
    symmetry: [4, 5, 3], mirror: false, root: 4, swing: [0.2, 0.2, 0.15],
    impulse: { transform: 2, variation: "hyperbolic", amount: 0.2, turn: 0.3, grow: 0.15 },
    palettes: [
      ["#ffd23f", "#9dff3d", "#1fffc0", "#00b7ff", "#4d4dff", "#b83dff", "#ff3da6", "#ff8a2d"],
      ["#00e0ff", "#1f8fff", "#5a3dff", "#c02dff", "#ff3d9e", "#ff7a3d", "#ffd23f", "#3dffb0"]
    ],
    morph: 0.1, curve: 1.25, gain: 3.3
  },
  mandala: {
    keys: [
      [
        { weight: 0.291, turn: 5.965, scale: 1.078, stretch: 0.789, skew: 4.387, x: -0.087, y: -0.521, colour: 0.1, blend: { swirl: 0.942 } },
        { weight: 0.484, turn: 5.92, scale: 0.653, stretch: 0.926, skew: 4.765, x: -0.487, y: -0.726, colour: 0.5, blend: { spherical: 0.896, linear: 0.662 } },
        { weight: 0.595, turn: 5.534, scale: 0.51, stretch: 1.278, skew: 2.531, x: 0.333, y: -0.269, colour: 0.9, blend: { hyperbolic: 0.839, linear: 0.15 } }
      ],
      [
        { weight: 0.274, turn: 5.907, scale: 1.084, stretch: 0.813, skew: 4.618, x: -0.072, y: -0.571, colour: 0.1, blend: { swirl: 0.837 } },
        { weight: 0.451, turn: 5.753, scale: 0.696, stretch: 0.962, skew: 5, x: -0.5, y: -0.852, colour: 0.5, blend: { spherical: 0.933, linear: 0.589 } },
        { weight: 0.639, turn: 5.828, scale: 0.496, stretch: 1.196, skew: 2.856, x: 0.334, y: -0.31, colour: 0.9, blend: { hyperbolic: 0.687, linear: 0.157 } }
      ],
      [
        { weight: 0.278, turn: 5.669, scale: 1.008, stretch: 0.837, skew: 4.306, x: -0.026, y: -0.425, colour: 0.1, blend: { swirl: 0.949 } },
        { weight: 0.528, turn: 5.864, scale: 0.67, stretch: 0.946, skew: 4.889, x: -0.353, y: -0.782, colour: 0.5, blend: { spherical: 1.072, linear: 0.599 } },
        { weight: 0.628, turn: 5.256, scale: 0.502, stretch: 1.27, skew: 2.675, x: 0.316, y: -0.365, colour: 0.9, blend: { hyperbolic: 0.804, linear: 0.132 } }
      ],
      [
        { weight: 0.291, turn: 5.687, scale: 1.013, stretch: 0.76, skew: 4.701, x: -0.22, y: -0.626, colour: 0.1, blend: { swirl: 1.012 } },
        { weight: 0.516, turn: 5.898, scale: 0.678, stretch: 0.979, skew: 4.625, x: -0.48, y: -0.732, colour: 0.5, blend: { spherical: 1.058, linear: 0.684 } },
        { weight: 0.53, turn: 5.146, scale: 0.528, stretch: 1.255, skew: 2.482, x: 0.453, y: -0.363, colour: 0.9, blend: { hyperbolic: 0.831, linear: 0.175 } }
      ]
    ],
    symmetry: [6, 7, 4, 5], mirror: true, root: 2, swing: [0.2, 0.2, 0.15],
    impulse: { transform: 1, variation: "linear", amount: 0.25, turn: 0.25, grow: 0.13 },
    palettes: [
      ["#ff2f92", "#ff5fbf", "#ffa01f", "#ffd633", "#ff7a1a", "#a033ff", "#4d3dff", "#d12bff"],
      ["#ff2d6f", "#ff6a1a", "#ffc21f", "#d9ff3d", "#2dffa6", "#16b7ff", "#4d4dff", "#c02dff"]
    ],
    morph: 0.1, curve: 1.25, gain: 3.3
  },
  galaxy: {
    keys: [
      [
        { weight: 0.539, turn: 0.608, scale: 0.67, stretch: 0.803, skew: 4.858, x: 0.574, y: -0.727, colour: 0.1, blend: { spherical: 0.583, hyperbolic: 0.447, linear: 0.423 } },
        { weight: 0.471, turn: 3.698, scale: 0.865, stretch: 0.915, skew: 3.456, x: -0.464, y: 0.388, colour: 0.9, blend: { heart: 0.814, swirl: 0.238 } }
      ],
      [
        { weight: 0.56, turn: 0.997, scale: 0.725, stretch: 0.829, skew: 4.943, x: 0.628, y: -0.67, colour: 0.1, blend: { spherical: 0.619, hyperbolic: 0.397, linear: 0.476 } },
        { weight: 0.472, turn: 3.955, scale: 0.793, stretch: 0.899, skew: 3.414, x: -0.337, y: 0.407, colour: 0.9, blend: { heart: 0.684, swirl: 0.255 } }
      ],
      [
        { weight: 0.46, turn: 0.812, scale: 0.619, stretch: 0.798, skew: 4.844, x: 0.647, y: -0.615, colour: 0.1, blend: { spherical: 0.591, hyperbolic: 0.349, linear: 0.345 } },
        { weight: 0.456, turn: 3.777, scale: 0.813, stretch: 0.911, skew: 3.682, x: -0.378, y: 0.497, colour: 0.9, blend: { heart: 0.85, swirl: 0.219 } }
      ],
      [
        { weight: 0.596, turn: 0.839, scale: 0.677, stretch: 0.816, skew: 4.767, x: 0.615, y: -0.842, colour: 0.1, blend: { spherical: 0.471, hyperbolic: 0.42, linear: 0.486 } },
        { weight: 0.539, turn: 3.32, scale: 0.833, stretch: 0.936, skew: 3.785, x: -0.381, y: 0.519, colour: 0.9, blend: { heart: 0.937, swirl: 0.227 } }
      ]
    ],
    symmetry: [6, 4, 7, 5], mirror: false, root: 2, swing: [0.2, 0.25, 0],
    impulse: { transform: 1, variation: "swirl", amount: 0.3, turn: 0.3, grow: 0.13 },
    palettes: [
      ["#1b3bff", "#00a6ff", "#14e8d2", "#3dff8a", "#ffd633", "#ff7d26", "#ff2e7e", "#8f33ff"],
      ["#3a1cff", "#8a2dff", "#e02dff", "#ff3da6", "#ff6a3d", "#ffc233", "#2ee6ff", "#1f7bff"]
    ],
    morph: 0.1, curve: 1.25, gain: 3.3
  },
  wings: {
    keys: [
      [
        { weight: 0.216, turn: 5.3, scale: 0.813, stretch: 0.964, skew: 5.861, x: -0.245, y: -0.067, colour: 0.1, blend: { hyperbolic: 0.764, linear: 0.159 } },
        { weight: 0.395, turn: 0.222, scale: 0.487, stretch: 0.934, skew: 3.996, x: 0.908, y: -0.132, colour: 0.5, blend: { hyperbolic: 0.54, linear: 0.308 } },
        { weight: 0.34, turn: 6.07, scale: 0.616, stretch: 1.17, skew: 2.725, x: 0.41, y: -0.151, colour: 0.9, blend: { handkerchief: 0.933, linear: 0.17 } }
      ],
      [
        { weight: 0.223, turn: 5.385, scale: 0.825, stretch: 0.979, skew: 6.051, x: -0.338, y: -0.038, colour: 0.1, blend: { hyperbolic: 0.661, linear: 0.141 } },
        { weight: 0.432, turn: 0.077, scale: 0.501, stretch: 0.967, skew: 4.192, x: 1.038, y: -0.1, colour: 0.5, blend: { hyperbolic: 0.541, linear: 0.35 } },
        { weight: 0.35, turn: 6.238, scale: 0.591, stretch: 1.23, skew: 3.039, x: 0.548, y: -0.162, colour: 0.9, blend: { handkerchief: 0.792, linear: 0.166 } }
      ],
      [
        { weight: 0.194, turn: 5.362, scale: 0.854, stretch: 0.927, skew: 5.62, x: -0.343, y: -0.17, colour: 0.1, blend: { hyperbolic: 0.751, linear: 0.154 } },
        { weight: 0.393, turn: -0.202, scale: 0.521, stretch: 0.921, skew: 4.273, x: 0.962, y: -0.039, colour: 0.5, blend: { hyperbolic: 0.621, linear: 0.359 } },
        { weight: 0.371, turn: 6.377, scale: 0.561, stretch: 1.122, skew: 2.553, x: 0.522, y: -0.142, colour: 0.9, blend: { handkerchief: 0.809, linear: 0.138 } }
      ],
      [
        { weight: 0.205, turn: 5.455, scale: 0.815, stretch: 1.03, skew: 6.173, x: -0.327, y: -0.111, colour: 0.1, blend: { hyperbolic: 0.782, linear: 0.173 } },
        { weight: 0.415, turn: 0.117, scale: 0.463, stretch: 0.885, skew: 3.812, x: 0.789, y: -0.156, colour: 0.5, blend: { hyperbolic: 0.553, linear: 0.32 } },
        { weight: 0.325, turn: 6.154, scale: 0.633, stretch: 1.164, skew: 2.396, x: 0.363, y: -0.063, colour: 0.9, blend: { handkerchief: 0.94, linear: 0.205 } }
      ]
    ],
    symmetry: [5, 4, 3], mirror: true, root: 2, swing: [0.2, 0.15, 0.2],
    impulse: { transform: 2, variation: "handkerchief", amount: 0.25, turn: 0.25, grow: 0.13 },
    palettes: [
      ["#00e5c3", "#0aa0ff", "#3d3bff", "#b04dff", "#ff4fb0", "#ff9a3d", "#ffe04d", "#3df29b"],
      ["#ff3d2e", "#ff8a1f", "#ffd24a", "#ff5fbf", "#e0218a", "#8a2fe0", "#2f6bff", "#1fd3ff"]
    ],
    morph: 0.1, curve: 1.25, gain: 3.3
  }
};

function flatten(key: Key, used: readonly Variation[]): Float32Array {
  const stride = HEAD + used.length;
  const vector = new Float32Array(TRANSFORMS * stride);
  for (let index = 0; index < TRANSFORMS; index += 1) {
    const transform = key[index];
    const at = index * stride;
    if (!transform) continue;
    vector[at] = transform.weight;
    vector[at + 1] = transform.turn;
    vector[at + 2] = Math.log(transform.scale);
    vector[at + 3] = Math.log(transform.stretch);
    vector[at + 4] = transform.skew;
    vector[at + 5] = transform.x;
    vector[at + 6] = transform.y;
    vector[at + 7] = transform.colour;
    for (const [slot, name] of used.entries()) vector[at + HEAD + slot] = transform.blend[name] ?? 0;
  }
  return vector;
}

/** Integer hashing (PCG, three in three out): the chaos game needs better dice than a float hash gives. */
const DICE = /* glsl */ `
uvec3 pcg(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 dice(uvec3 v) { return vec3(pcg(v) >> 8u) * (1.0 / 16777216.0); }
`;

/**
 * One step of the chaos game for every point, with the variations this family blends compiled
 * in (and no others). State: xy the point, z its colour coordinate, w its age.
 */
function iterateSource(used: readonly Variation[]): string {
  const terms = used.map((name, slot) => `  o += uBlend[base + ${slot}] * (${VARIATION[name]});`).join("\n");
  return COMMON + DICE + /* glsl */ `
uniform sampler2D uState;
uniform float uTick, uSymmetry, uMirror, uRoot, uReseed;
uniform vec4 uMat[${TRANSFORMS}];
uniform vec4 uOff[${TRANSFORMS}];
uniform float uBlend[${TRANSFORMS * used.length}];
uniform vec2 uPick;
vec2 vary(vec2 p, int base, float branch) {
  float r2 = dot(p, p) + 1e-9;
  float r = sqrt(r2);
  float th = atan(p.y, p.x);
  float turn = (th + TAU * floor(branch * uRoot)) / uRoot;
  vec2 o = vec2(0.0);
${terms}
  return o;
}
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, id, 0);
  uint tick = uint(uTick);
  vec3 u = dice(uvec3(id, tick * 2u));
  vec3 v = dice(uvec3(id, tick * 2u + 1u));
  int i = u.x < uPick.x ? 0 : u.x < uPick.y ? 1 : 2;
  vec2 q = vec2(dot(uMat[i].xy, s.xy), dot(uMat[i].zw, s.xy)) + uOff[i].xy;
  vec2 o = vary(q, i * ${used.length}, u.y);
  // The symmetry is part of the system: every image is one of its own rotations (and mirrors).
  o = rot(TAU * floor(u.z * uSymmetry) / uSymmetry) * o;
  if (uMirror > 0.5 && v.x < 0.5) o.x = -o.x;
  float colour = mix(s.z, uOff[i].z, uOff[i].w);
  float age = s.w + 1.0;
  // A point that left for infinity (or was never anywhere) starts again, uncounted for a few steps.
  if (!(dot(o, o) < 1e6) || v.y < uReseed) {
    o = sqrt(v.z) * vec2(cos(TAU * u.y), sin(TAU * u.y));
    colour = v.x;
    age = 0.0;
  }
  fragColor = vec4(o, colour, age);
}
`;
}

/**
 * From flame coordinates to the frame: the camera the fit pass found. The flame is fitted
 * between "all of it inside" and "the frame covered", nearer the first: a round flame fills a
 * wide frame and a tall one alike.
 */
const VIEW = /* glsl */ `
uniform sampler2D uFit;
uniform float uAspect, uMargin, uFlip;
vec2 project(vec2 p) {
  vec4 fit = texelFetch(uFit, ivec2(0), 0);
  vec2 room = vec2(uAspect, 1.0) / max(fit.zw, vec2(1e-3));
  float inside = min(room.x, room.y), cover = max(room.x, room.y);
  float zoom = uMargin * inside * pow(min(cover / inside, 2.5), 0.4);
  return (p - fit.xy) * vec2(uFlip, 1.0) * zoom * vec2(1.0 / uAspect, 1.0);
}
`;

const SPLAT_VERTEX = VIEW + /* glsl */ `
uniform sampler2D uState, uPalette;
uniform int uWidth;
uniform float uPhase, uWeight;
uniform vec2 uGrid;
out vec4 vColor;
out vec2 vUv;
// A point is a line that covers the centre of one histogram pixel and no other: points proper
// are slow where the browser has to build them (Direct3D has none wider than a pixel).
void main() {
  int point = gl_VertexID >> 1;
  ivec2 id = ivec2(point % uWidth, point / uWidth);
  vec4 s = texelFetch(uState, id, 0);
  vec2 pixel = floor((project(s.xy) * 0.5 + 0.5) * uGrid);
  vec2 corner = vec2((gl_VertexID & 1) == 1 ? 1.5 : 0.5, 0.5);
  vColor = vec4(textureLod(uPalette, vec2(s.z + uPhase, 0.5), 0.0).rgb, 1.0) * uWeight;
  vUv = vec2(0.0);
  gl_Position = s.w < ${FUSE}.0 ? vec4(4.0, 4.0, 0.0, 1.0) : vec4((pixel + corner) / uGrid * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPLAT = /* glsl */ `
in vec4 vColor;
void main() { fragColor = vColor; }
`;

/** Where the points are, per axis: every chosen point drawn into a bin of x (row 0) and a bin of y (row 1). */
const EXTENT = /* glsl */ `
float binOf(float v) { return 0.5 + 0.5 * asinh(v / 0.25) / asinh(160.0); }
float valueOf(float u) { return 0.25 * sinh((2.0 * u - 1.0) * asinh(160.0)); }
`;

const MEASURE_VERTEX = EXTENT + /* glsl */ `
uniform sampler2D uState;
uniform int uWidth, uStride;
out vec2 vUv;
void main() {
  int index = (gl_VertexID >> 1) * uStride;
  ivec2 id = ivec2(index % uWidth, index / uWidth);
  vec4 s = texelFetch(uState, id, 0);
  bool vertical = (gl_VertexID & 1) == 1;
  float u = clamp(binOf(vertical ? s.y : s.x), 0.004, 0.996);
  vUv = vec2(0.0);
  gl_Position = s.w < ${FUSE}.0 ? vec4(4.0, 4.0, 0.0, 1.0) : vec4(u * 2.0 - 1.0, vertical ? 0.5 : -0.5, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const MEASURE = /* glsl */ `
void main() { fragColor = vec4(1.0); }
`;

/** The camera: centre and half-extent per axis, between the 6th and 94th percentile, followed slowly. */
const FIT = EXTENT + /* glsl */ `
uniform sampler2D uBins, uPrev;
uniform float uRate, uFirst;
vec2 span(int row) {
  float total = 0.0;
  for (int i = 0; i < ${BINS}; i++) total += texelFetch(uBins, ivec2(i, row), 0).r;
  if (total < 8.0) return vec2(-1.5, 1.5);
  float lowAt = total * 0.06, highAt = total * 0.94, run = 0.0, low = 0.0, high = float(${BINS});
  for (int i = 0; i < ${BINS}; i++) {
    float c = texelFetch(uBins, ivec2(i, row), 0).r;
    if (run < lowAt && run + c >= lowAt) low = float(i) + (lowAt - run) / max(c, 1e-6);
    if (run < highAt && run + c >= highAt) high = float(i) + (highAt - run) / max(c, 1e-6);
    run += c;
  }
  return vec2(valueOf(low / float(${BINS})), valueOf(high / float(${BINS})));
}
void main() {
  vec2 sx = span(0), sy = span(1);
  vec4 now = vec4(0.5 * (sx.x + sx.y), 0.5 * (sy.x + sy.y), max(0.5 * (sx.y - sx.x), 0.05), max(0.5 * (sy.y - sy.x), 0.05));
  vec4 before = texelFetch(uPrev, ivec2(0), 0);
  fragColor = uFirst > 0.5 ? now : mix(before, now, uRate);
}
`;

const FADE = /* glsl */ `
uniform sampler2D uHist;
uniform float uKeep;
void main() { fragColor = texelFetch(uHist, ivec2(gl_FragCoord.xy), 0) * uKeep; }
`;

/** The histogram at half size: plain 2 × 2 means. */
const HALVE = /* glsl */ `
uniform sampler2D uHist;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 2;
  ivec2 limit = textureSize(uHist, 0) - 1;
  fragColor = 0.25 * (texelFetch(uHist, min(base, limit), 0) + texelFetch(uHist, min(base + ivec2(1, 0), limit), 0)
                    + texelFetch(uHist, min(base + ivec2(0, 1), limit), 0) + texelFetch(uHist, min(base + ivec2(1, 1), limit), 0));
}
`;

/** Half size again: a (1 3 3 1) tent from four taps. */
const REDUCE = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
void main() {
  fragColor = 0.25 * (texture(uSource, vUv + uTexel * vec2(-0.75, -0.75)) + texture(uSource, vUv + uTexel * vec2(0.75, -0.75))
                    + texture(uSource, vUv + uTexel * vec2(-0.75, 0.75)) + texture(uSource, vUv + uTexel * vec2(0.75, 0.75)));
}
`;

/**
 * Density estimation, first level. A pixel keeps its count where its neighbourhood holds enough
 * hits to be believed; what it does not keep goes down to a texel four times its size, which
 * decides the same way, and so on (SPLIT). Sparse regions are thus pooled until they are smooth,
 * and nothing of a dense filament leaks into the dark beside it.
 */
const SPLIT_FIRST = /* glsl */ `
uniform sampler2D uHist, uMean, uNext;
uniform float uLo, uHi, uScale;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 2;
  ivec2 size = textureSize(uHist, 0);
  vec4 rest = vec4(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    ivec2 at = min(base + ivec2(i, j), size - 1);
    float kept = smoothstep(uLo, uHi, texture(uMean, (vec2(at) + 0.5) / vec2(size)).a);
    rest += texelFetch(uHist, at, 0) * (1.0 - kept);
  }
  rest *= 0.25;
  float keep = smoothstep(uLo, uHi, texture(uNext, vUv).a * uScale);
  fragColor = rest * keep;
  fragColor1 = rest * (1.0 - keep);
}
`;

const SPLIT = /* glsl */ `
uniform sampler2D uRest, uNext;
uniform vec2 uTexel;
uniform float uLo, uHi, uScale, uLast;
void main() {
  vec4 rest = 0.25 * (texture(uRest, vUv + uTexel * vec2(-0.75, -0.75)) + texture(uRest, vUv + uTexel * vec2(0.75, -0.75))
                    + texture(uRest, vUv + uTexel * vec2(-0.75, 0.75)) + texture(uRest, vUv + uTexel * vec2(0.75, 0.75)));
  float keep = max(uLast, smoothstep(uLo, uHi, texture(uNext, vUv).a * uScale));
  fragColor = rest * keep;
  fragColor1 = rest * (1.0 - keep);
}
`;

/** The density a typical hit sits in (the hits' own mean of it), followed slowly: what the exposure is set by. */
const METER = /* glsl */ `
uniform sampler2D uMean, uPrev;
uniform float uRate, uFirst;
void main() {
  ivec2 size = textureSize(uMean, 0);
  float sum = 0.0, squares = 0.0;
  for (int y = 0; y < size.y; y++) for (int x = 0; x < size.x; x++) {
    float a = texelFetch(uMean, ivec2(x, y), 0).a;
    sum += a;
    squares += a * a;
  }
  float typical = squares / max(sum, 1e-9);
  float before = texelFetch(uPrev, ivec2(0), 0).r;
  fragColor = vec4(uFirst > 0.5 || before <= 0.0 ? typical : mix(before, typical, uRate));
}
`;

/**
 * The histogram developed: the density estimate, the logarithm of it as light, the mean colour
 * of what landed — and, with the hats, glints along the finest filaments.
 */
const DEVELOP = COMMON + BICUBIC + /* glsl */ `
uniform sampler2D uHist, uMean, uWide, uK1, uK2, uK3, uK4, uMeter;
uniform vec2 uSize1, uSize2, uSize3, uSize4, uGlints;
uniform float uLo, uHi, uDensity, uCurve, uGain, uVivid, uZoom, uSparkle, uTwinkle;
void main() {
  vec2 uv = 0.5 + (vUv - 0.5) / uZoom;
  vec4 sharp = texture(uHist, uv) * smoothstep(uLo, uHi, texture(uMean, uv).a);
  vec4 sum = sharp + bicubic(uK1, uv, uSize1) + bicubic(uK2, uv, uSize2) + bicubic(uK3, uv, uSize3) + bicubic(uK4, uv, uSize4);
  float rho = sum.a / max(texelFetch(uMeter, ivec2(0), 0).r, 1e-7);
  // Light by the logarithm of the density, as a flame is developed: five decades of counts in two of light.
  float light = uGain * pow(log(1.0 + uDensity * rho) / log(1.0 + uDensity * 64.0), uCurve);
  vec3 colour = sum.rgb / max(sum.a, 1e-9);
  // Many colours landing on one pixel average toward grey: the chroma is deepened again, the hue kept.
  float top = max(colour.r, max(colour.g, colour.b)), chroma = (top - min(colour.r, min(colour.g, colour.b))) / max(top, 1e-6);
  colour = max(top - (top - colour) * min(pow(chroma, uVivid) / max(chroma, 1e-4), 3.0), 0.0);
  // A filament is where the pixel holds far more than its surroundings do.
  float wide = texture(uWide, uv).a;
  float ridge = saturate(1.5 * (sum.a - wide) / (sum.a + wide + 1e-9));
  vec2 cell = floor(uv * uGlints);
  float phase = uTwinkle + hash12(cell * 1.7 + 5.0);
  float glint = mix(hash12(cell + 31.0 * floor(phase)), hash12(cell + 31.0 * (floor(phase) + 1.0)), smoothstep(0.0, 1.0, fract(phase)));
  light *= 1.0 + uSparkle * ridge * pow(glint, 14.0);
  fragColor = vec4(colour * light, 1.0);
}
`;

/**
 * The palette: the preset's own stops, or — with a picture — the picture's colours laid out
 * around the hue circle. Samples are read off the picture along a closed loop that drifts;
 * each of the eight stops stands for a hue and takes the colourful samples nearest to it, so
 * neighbours blend through colour, not through grey, and a picture of many colours gives a
 * palette of many. All of it is brought up to light: a flame is made of light.
 */
const PALETTE = COMMON + /* glsl */ `
uniform sampler2D uSrc, uPrev;
uniform float uHasSrc, uDrift, uRate, uFirst;
uniform vec3 uStops[${STOPS}];
vec3 along(vec3 n[${STOPS}], float t) {
  t = fract(t) * float(${STOPS});
  int i = int(floor(t));
  float f = t - floor(t);
  vec3 a = n[(i + ${STOPS - 1}) % ${STOPS}], b = n[i % ${STOPS}], c = n[(i + 1) % ${STOPS}], d = n[(i + 2) % ${STOPS}];
  return max(b + 0.5 * f * (c - a + f * (2.0 * a - 5.0 * b + 4.0 * c - d + f * (3.0 * (b - c) + d - a))), 0.0);
}
float top3(vec3 c) { return max(c.r, max(c.g, c.b)); }
vec2 path(float t) {
  float a = TAU * t;
  return 0.5 + 0.4 * rot(uDrift * 0.37) * vec2(cos(a + uDrift), sin(2.0 * a + 0.6 * uDrift));
}
void main() {
  vec3 c = along(uStops, vUv.x);
  if (uHasSrc > 0.5) {
    vec4 bins[${STOPS}];
    float lights[${STOPS}];
    for (int k = 0; k < ${STOPS}; k++) { bins[k] = vec4(0.0); lights[k] = 0.0; }
    float top = 0.0, colourful = 0.0, total = 0.0;
    for (int i = 0; i < 48; i++) {
      float a = 2.39996 * float(i);
      vec2 uv = path((float(i) + 0.5) / 48.0) + 0.06 * fract(float(i) * 0.618) * vec2(cos(a), sin(a));
      vec3 s = textureLod(uSrc, uv, 2.0).rgb;
      float m = top3(s), chroma = (m - min(s.r, min(s.g, s.b))) / max(m, 1e-3);
      float score = chroma * sqrt(m) + 0.02;
      top = max(top, m);
      colourful += chroma * m;
      total += m;
      float hue = fract(atan(1.7320508 * (s.g - s.b), 2.0 * s.r - s.g - s.b) / TAU);
      for (int k = 0; k < ${STOPS}; k++) {
        float d = abs(fract(hue - (float(k) + 0.5) / float(${STOPS}) + 0.5) - 0.5);
        float w = score * score * score / sq(d * d + 0.003);
        bins[k] += vec4(s / max(m, 1e-3), 1.0) * w;
        lights[k] += m * w;
      }
    }
    vec3 n[${STOPS}];
    vec3 light[${STOPS}];
    for (int k = 0; k < ${STOPS}; k++) {
      vec3 s = bins[k].rgb / max(bins[k].a, 1e-9);
      s /= max(top3(s), 1e-3);
      // The chroma deepened; the picture's darker colours stay a little darker.
      float chroma = 1.0 - min(s.r, min(s.g, s.b));
      n[k] = max(1.0 - (1.0 - s) * min(pow(chroma, 0.55) / max(chroma, 1e-3), 3.0), 0.0);
      light[k] = vec3(mix(0.45, 1.0, sqrt(saturate(lights[k] / max(bins[k].a, 1e-9) / max(top, 0.04)))));
    }
    float value = along(light, vUv.x).r;
    vec3 own = along(n, vUv.x);
    own *= value / max(top3(own), 1e-3);
    // A picture without colour gets the preset's own, in the picture's light.
    c = mix(c * value, own, smoothstep(0.05, 0.2, colourful / max(total, 1e-4)));
  }
  vec3 before = texture(uPrev, vUv).rgb;
  fragColor = vec4(uFirst > 0.5 ? c : mix(before, c, uRate), 1.0);
}
`;

function linearFromHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (byte: number): number => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [channel((value >> 16) & 255), channel((value >> 8) & 255), channel(value & 255)];
}

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const gl = environment.gl;
  const family = FAMILIES[preset] ?? FAMILIES.gossamer!;
  const random = seededRandom(seed * 6151 + 29);

  // The variations this family blends, and its keys as vectors over them.
  const names = new Set<Variation>([family.impulse.variation]);
  for (const key of family.keys) for (const transform of key) for (const name of Object.keys(transform.blend) as Variation[]) names.add(name);
  const used = [...names];
  const stride = HEAD + used.length;
  const keys = family.keys.map((key) => flatten(key, used));
  const impulseSlot = used.indexOf(family.impulse.variation);

  const programs = {
    iterate: kit.program(iterateSource(used)), splat: kit.program(SPLAT, { vertex: SPLAT_VERTEX }),
    measure: kit.program(MEASURE, { vertex: MEASURE_VERTEX }), fit: kit.program(FIT), fade: kit.program(FADE), halve: kit.program(HALVE),
    reduce: kit.program(REDUCE), splitFirst: kit.program(SPLIT_FIRST, { outputs: 2 }), split: kit.program(SPLIT, { outputs: 2 }),
    develop: kit.program(DEVELOP), palette: kit.program(PALETTE), meter: kit.program(METER)
  };
  // Counts are added a little at a time: only 32-bit floats keep adding to a dense pixel.
  const counting: Format = kit.floatColor && gl.getExtension("EXT_float_blend") ? "rgba32f" : "rgba16f";

  let state: Double | null = null;
  let histogram: Double | null = null;
  let scene: Target | null = null;
  const means: (Target | null)[] = [null, null, null, null, null];
  const splits: (Target | null)[] = [null, null, null, null];
  const bins = kit.target(BINS, 2, counting, { filter: "nearest" });
  const fit = kit.double(1, 1, kit.stateFormat, { filter: "nearest" });
  const meter = kit.double(1, 1, kit.stateFormat, { filter: "nearest" });
  const palette = kit.double(PALETTE_SIZE, 1, "rgba16f", { wrap: "repeat" });

  // What the seed decides.
  const symmetry = family.symmetry[Math.floor(random() * family.symmetry.length)] ?? 3;
  const direction = random() < 0.5 ? -1 : 1;
  const stops = new Float32Array(STOPS * 3);
  const chosen = family.palettes[(Math.max(0, Math.floor(seed)) + 1) % family.palettes.length] ?? family.palettes[0]!;
  const paletteDrift = 0.04 + 0.05 * random();
  for (const [index, hex] of chosen.entries()) stops.set(linearFromHex(hex), index * 3);
  const palettePhase = random();
  let clock = Math.floor(random() * keys.length) + random() * 0.5;
  const swings = new Float32Array(TRANSFORMS);
  for (let index = 0; index < TRANSFORMS; index += 1) swings[index] = random() * Math.PI * 2;

  const genome = new Float32Array(TRANSFORMS * stride);
  const mat = new Float32Array(TRANSFORMS * 4);
  const off = new Float32Array(TRANSFORMS * 4);
  const blend = new Float32Array(TRANSFORMS * used.length);
  const before = new Float32Array(TRANSFORMS * (6 + used.length));
  const now = new Float32Array(before.length);
  let tick = 0;
  let first = true;
  let lastFlow = 0;
  let bloom = 0;
  let bloomSpeed = 0;
  let breath = 0;
  let memory = 0.4;
  let variance = 1;
  let twinkle = random() * 10;

  return {
    render(frame: FvFrame): void {
      const f = frame.audio.features;
      const aspect = frame.width / frame.height;
      const [width, height] = workSize(frame);
      const dt = Math.min(0.05, Math.max(1e-3, frame.dt));

      // As many points as the histogram can make a picture of: 3.7 million for 1920 × 1080.
      const side = Math.min(1920, Math.max(256, Math.round(Math.sqrt(width * height / (1920 * 1080)) * 30) * 64));
      state = kit.fitDouble(state, side, side, kit.stateFormat, { filter: "nearest" }, true);
      histogram = kit.fitDouble(histogram, width, height, counting, {}, true);
      scene = kit.fit(scene, width, height, "rgba16f");
      let w = width;
      let h = height;
      for (let level = 0; level < means.length; level += 1) {
        w = Math.max(2, Math.ceil(w / 2));
        h = Math.max(2, Math.ceil(h / 2));
        means[level] = kit.fit(means[level] ?? null, w, h, "rgba16f");
        if (level < splits.length) {
          const held = splits[level];
          if (!held || held.width !== w || held.height !== h) {
            kit.deleteTarget(held);
            splits[level] = kit.target(w, h, "rgba16f", { attachments: 2 });
          }
        }
      }

      // The genome now: along the keys, a closed Catmull–Rom loop, by musical time.
      if (first) lastFlow = f.flow;
      clock += (0.03 * dt + Math.min(0.2, Math.max(0, f.flow - lastFlow)) * family.morph) * (frame.gentle ? 0.75 : 1);
      lastFlow = f.flow;
      const whole = Math.floor(clock);
      const t = clock - whole;
      const k0 = keys[(whole + keys.length - 1) % keys.length]!;
      const k1 = keys[whole % keys.length]!;
      const k2 = keys[(whole + 1) % keys.length]!;
      const k3 = keys[(whole + 2) % keys.length]!;
      for (let index = 0; index < genome.length; index += 1) {
        const a = k0[index]!;
        const b = k1[index]!;
        const c = k2[index]!;
        const d = k3[index]!;
        genome[index] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
      }

      // A kick: a spring pulled toward the kick's envelope, so the shape swells and settles.
      const stiffness = frame.gentle ? 15 : 21;
      const damping = frame.gentle ? 0.75 : 0.45;
      bloomSpeed += (stiffness * stiffness * (f.kick - bloom) - 2 * damping * stiffness * bloomSpeed) * dt;
      bloom += bloomSpeed * dt;
      const swell = bloom * (frame.gentle ? 0.7 : 1);
      // The bass: the whole flame breathes.
      breath += (f.bass * f.presence - breath) * (1 - Math.exp(-dt / 0.18));

      let total = 0;
      for (let index = 0; index < TRANSFORMS; index += 1) total += Math.max(0, genome[index * stride]!);
      let run = 0;
      const pick = [1, 1];
      for (let index = 0; index < TRANSFORMS; index += 1) {
        const at = index * stride;
        run += Math.max(0, genome[at]!) / Math.max(1e-6, total);
        if (index < TRANSFORMS - 1) pick[index] = run;
        // The mids swing the affine parts: each transform about its own place in the key.
        swings[index] = swings[index]! + dt * (0.16 + 0.1 * index) * (0.45 + 1.2 * f.mid * f.presence);
        const swing = (family.swing[index] ?? 0) * Math.sin(swings[index]!) * direction;
        const turn = genome[at + 1]! + swing + (index === family.impulse.transform ? swell * family.impulse.turn : 0);
        const scale = Math.exp(genome[at + 2]! + (index === family.impulse.transform ? swell * family.impulse.grow : 0));
        const stretch = Math.exp(genome[at + 3]!);
        const skew = genome[at + 4]!;
        const sx = scale * stretch;
        const sy = scale / stretch;
        const ct = Math.cos(turn);
        const st = Math.sin(turn);
        const cs = Math.cos(skew);
        const ss = Math.sin(skew);
        mat.set([ct * sx * cs - st * sy * ss, -ct * sx * ss - st * sy * cs, st * sx * cs + ct * sy * ss, -st * sx * ss + ct * sy * cs], index * 4);
        off.set([genome[at + 5]!, genome[at + 6]!, genome[at + 7]!, 0.5], index * 4);
        for (let slot = 0; slot < used.length; slot += 1) blend[index * used.length + slot] = genome[at + HEAD + slot]!;
        if (index === family.impulse.transform) {
          blend[index * used.length + impulseSlot] = blend[index * used.length + impulseSlot]! + swell * family.impulse.amount;
        }
      }

      // How fast the system itself is moving: what the histogram may remember without smearing.
      let moved = 0;
      for (let index = 0; index < TRANSFORMS; index += 1) {
        const at = index * (6 + used.length);
        for (let slot = 0; slot < 4; slot += 1) now[at + slot] = mat[index * 4 + slot]!;
        now[at + 4] = off[index * 4]!;
        now[at + 5] = off[index * 4 + 1]!;
        for (let slot = 0; slot < used.length; slot += 1) now[at + 6 + slot] = blend[index * used.length + slot]!;
      }
      for (let index = 0; index < now.length; index += 1) moved += Math.abs(now[index]! - before[index]!);
      before.set(now);
      const wanted = first ? 0.4 : Math.min(0.75, Math.max(0.14, 0.13 / (moved / dt + 1e-4)));
      memory += (wanted - memory) * (1 - Math.exp(-dt / (wanted < memory ? 0.06 : 0.6)));
      const keep = Math.exp(-dt / memory);
      // The histogram is a running mean of the frames; this is how many frames' worth of hits stand behind it.
      variance = keep * keep * variance + (1 - keep) * (1 - keep);
      const frames = 1 / variance;

      // The palette.
      const source = environment.source.uniforms();
      kit.draw(programs.palette, palette.write, {
        ...source, uPrev: palette.read, uDrift: f.time * 0.05 + palettePhase * 6, uRate: 1 - Math.exp(-dt / 0.8), uFirst: first ? 1 : 0, uStops: stops
      });
      palette.swap();

      // The chaos game.
      kit.draw(programs.iterate, state.write, {
        uState: state.read, uTick: tick % 8388608, uSymmetry: symmetry, uMirror: family.mirror ? 1 : 0, uRoot: family.root,
        uReseed: first ? 2 : 0.001, uMat: mat, uOff: off, uBlend: blend, uPick: pick
      });
      state.swap();
      tick += 1;

      // The camera.
      const count = side * side;
      const sparse = Math.max(1, Math.floor(count / 16384));
      kit.clear(bins);
      kit.points(programs.measure, bins, Math.floor(count / sparse) * 2, { uState: state.read, uWidth: side, uStride: sparse });
      kit.draw(programs.fit, fit.write, { uBins: bins, uPrev: fit.read, uRate: 1 - Math.exp(-dt / 1.2), uFirst: tick < FUSE + 3 ? 1 : 0 });
      fit.swap();

      // The histogram: what it held fades, this frame's points are counted in.
      kit.draw(programs.fade, histogram.write, { uHist: histogram.read, uKeep: keep });
      kit.points(programs.splat, histogram.write, 0, {
        uState: state.read, uPalette: palette.read, uFit: fit.read, uWidth: side, uAspect: aspect, uMargin: 0.86, uFlip: direction,
        uPhase: palettePhase + clock * paletteDrift, uWeight: 1 - keep, uGrid: [width, height]
      });
      gl.drawArrays(gl.LINES, 0, count * 2);
      histogram.swap();

      // Density estimation down the pyramid: a texel is believed from `lo` hits, wholly from `hi`.
      const lo = 40 / frames;
      const hi = 200 / frames;
      kit.draw(programs.halve, means[0]!, { uHist: histogram.read });
      for (let level = 1; level < means.length; level += 1) {
        const from = means[level - 1]!;
        kit.draw(programs.reduce, means[level]!, { uSource: from, uTexel: [1 / from.width, 1 / from.height] });
      }
      kit.draw(programs.splitFirst, splits[0]!, { uHist: histogram.read, uMean: means[0]!, uNext: means[1]!, uLo: lo, uHi: hi, uScale: 4 });
      for (let level = 1; level < splits.length; level += 1) {
        const from = splits[level - 1]!;
        kit.draw(programs.split, splits[level]!, {
          uRest: from.textures[1]!, uNext: means[level + 1]!, uTexel: [1 / from.width, 1 / from.height], uLo: lo, uHi: hi,
          uScale: Math.pow(4, level + 1), uLast: level === splits.length - 1 ? 1 : 0
        });
      }

      kit.draw(programs.meter, meter.write, { uMean: means[4]!, uPrev: meter.read, uRate: 1 - Math.exp(-dt / 1.5), uFirst: tick < FUSE + 3 ? 1 : 0 });
      meter.swap();

      // The hats: glints that come and go along the filaments, a few at a time.
      twinkle += dt * (frame.gentle ? 4 : 7);
      const sparkle = (frame.gentle ? 5 : 9) * Math.min(1, f.hat + 0.35 * f.high * f.presence);
      kit.draw(programs.develop, scene, {
        uMeter: meter.read,
        uHist: histogram.read, uMean: means[0]!, uWide: means[2]!, uK1: splits[0]!, uK2: splits[1]!, uK3: splits[2]!, uK4: splits[3]!,
        uSize1: [splits[0]!.width, splits[0]!.height], uSize2: [splits[1]!.width, splits[1]!.height],
        uSize3: [splits[2]!.width, splits[2]!.height], uSize4: [splits[3]!.width, splits[3]!.height],
        uLo: lo, uHi: hi, uDensity: 4, uCurve: family.curve, uGain: family.gain, uVivid: 0.6,
        uZoom: 1.02 + 0.05 * breath + 0.07 * Math.max(0, swell), uSparkle: sparkle, uTwinkle: twinkle,
        uGlints: [width / 2, height / 2]
      });
      first = false;
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: 1, bloom: 0.55 + (frame.gentle ? 0 : 0.15 * Math.max(0, swell)), threshold: 0.8, vignette: 0.2, contrast: 0.3,
        saturation: 1.08, whiten: 0.4, gentle: frame.gentle
      });
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "fractal-flames",
  order: 9,
  kind: "psychedelic",
  labelPl: "Fraktalne płomienie",
  labelEn: "Fractal Flames",
  descriptionPl: "Miliony punktów grają w chaos i kreślą świetliste, jedwabne struktury, które kwitną w rytm muzyki — w barwach okładki.",
  usesSource: true,
  gentleByDefault: true,
  presets: [
    { id: "gossamer", labelPl: "Pajęczyna", labelEn: "Gossamer" },
    { id: "mandala", labelPl: "Mandala", labelEn: "Mandala" },
    { id: "galaxy", labelPl: "Galaktyka", labelEn: "Galaxy" },
    { id: "wings", labelPl: "Skrzydła", labelEn: "Wings" }
  ],
  create
};
