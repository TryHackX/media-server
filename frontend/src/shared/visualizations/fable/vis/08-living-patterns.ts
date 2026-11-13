import { BICUBIC, COMMON } from "../core/glsl";
import { Kit, type Double, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Żywe wzory — Living Patterns.
 *
 * A Gray–Scott reaction–diffusion system grows over the picture like coral under a glaze. The
 * picture decides what grows where: how lively a place is (its light and its colour) picks the
 * regime — bare, beads, worms, labyrinth — and the picture's contours steer the growth, because
 * the substances diffuse faster along a contour than across it (the structure tensor of the
 * picture gives the direction), so the stripes run with the shapes.
 *
 * Nothing is allowed to settle: the state is carried by a slow flow that stretches it (stripes
 * split, beads divide), a weather of dry and fertile patches wanders over the regimes, kicks sow
 * dotted rings of seed, push the growth outward and send a swell through the glaze, and the
 * simulation's clock runs with the music.
 *
 * The picture is the relief of the inhibitor lit as wet enamel: the ridges wear the picture's
 * colour and hold light inside, their flanks carry thin-film colours, the valleys are the picture
 * seen deep under dark water, and whatever has just grown glows.
 */

interface Look {
  /** Simulation cells across the picture's short side: the scale of the pattern. */
  cells: number;
  /** Feed and kill where the picture is dull, and where it is lively. */
  dull: [number, number];
  lively: [number, number];
  /** What a contour of the picture adds to feed and kill. */
  edgeFeed: number;
  edgeKill: number;
  /** How much faster the substances travel along a contour than across it, 0–0.6. */
  grain: number;
  /** How far the weather moves a place along the dull–lively line. */
  weather: number;
  /** What a dry patch adds to the kill rate. */
  drought: number;
  /** What a kick's wave adds to the kill rate as it passes. */
  waveKill: number;
  /** Simulation steps a frame (at 60 a second): in silence, and at full level. */
  quiet: number;
  loud: number;
  /** What the bass level and a kick add to the feed rate. */
  bassFeed: number;
  kickFeed: number;
  /** Speed of the flow that carries the state (short sides a second), and its outward part. */
  flow: number;
  zoom: number;
  /** The relief: its steepness, and how much the glaze bends the picture under it. */
  bump: number;
  refract: number;
  /** The scale of the pattern where the picture is busy, against 1 where it is plain. */
  fine: number;
  /** How steep the land under the pattern is. */
  dome: number;
  /** The oil on the water of the valleys: how bright, and how many nm a drunk substrate adds. */
  oil: number;
  rings: number;
  /** How much of the reflections is thin-film colour, and the film's thickness in nm. */
  film: number;
  thick: number;
  /** Light held inside the ridges. */
  inner: number;
  /** How far the hue of a growth swings with the time it grew at (radians). */
  hueSwing: number;
  exposure: number;
  bloom: number;
}

const LOOKS: Record<string, Look> = {
  // Beads on the dull ground, brain coral on the lively.
  coral: {
    cells: 300, dull: [0.036, 0.0648], lively: [0.04, 0.0606], edgeFeed: 0.004, edgeKill: -0.0003, grain: 0.5, weather: 0.22, drought: 0.007, waveKill: 0.007,
    quiet: 6, loud: 14, bassFeed: 0.003, kickFeed: 0.003, flow: 0.028, zoom: 0.03,
    bump: 2.2, refract: 0.012, fine: 0.62, dome: 9, oil: 0.9, rings: 1000, film: 0.8, thick: 260, inner: 1.0, hueSwing: 0.6, exposure: 1.0, bloom: 0.5
  },
  // Beads only, bold ones: they divide where the picture is lively and stand apart where it is dull.
  pearls: {
    cells: 250, dull: [0.035, 0.0648], lively: [0.044, 0.0638], edgeFeed: 0.003, edgeKill: -0.0003, grain: 0.3, weather: 0.3, drought: 0.005, waveKill: 0.0042,
    quiet: 6, loud: 14, bassFeed: 0.003, kickFeed: 0.003, flow: 0.034, zoom: 0.036,
    bump: 2.4, refract: 0.016, fine: 0.7, dome: 8, oil: 1.1, rings: 1100, film: 0.7, thick: 300, inner: 1.25, hueSwing: 0.8, exposure: 1.0, bloom: 0.55
  },
  // Fine stripes that run with the picture's contours, breaking into dots where it is plain.
  filigree: {
    cells: 380, dull: [0.05, 0.0648], lively: [0.06, 0.0622], edgeFeed: 0.003, edgeKill: -0.0005, grain: 0.6, weather: 0.25, drought: 0.007, waveKill: 0.007,
    quiet: 7, loud: 15, bassFeed: 0.004, kickFeed: 0.003, flow: 0.026, zoom: 0.028,
    bump: 2.6, refract: 0.01, fine: 0.72, dome: 10, oil: 0.8, rings: 900, film: 1.0, thick: 330, inner: 0.9, hueSwing: 0.45, exposure: 1.0, bloom: 0.5
  },
  // The other side of the plane: the lively parts close into a sheet pierced with holes, the dull stay a maze.
  lace: {
    cells: 300, dull: [0.034, 0.0612], lively: [0.04, 0.0584], edgeFeed: 0.002, edgeKill: -0.0004, grain: 0.4, weather: 0.25, drought: 0.007, waveKill: 0.0056,
    quiet: 6, loud: 14, bassFeed: 0.002, kickFeed: 0.002, flow: 0.026, zoom: 0.028,
    bump: 2.2, refract: 0.012, fine: 0.7, dome: 9, oil: 1.0, rings: 1000, film: 0.8, thick: 280, inner: 1.0, hueSwing: 0.7, exposure: 1.0, bloom: 0.5
  }
};

/** A map of the whole feed–kill plane instead of the picture: for choosing regimes. Not listed. */
const CHART = false;

const DIFFUSION: [number, number] = [0.2, 0.1];

/** Where the picture lies in the frame. `q` is in short sides of the frame, the origin at its centre. */
const PLACE = /* glsl */ `
uniform sampler2D uSrc;
uniform float uSrcAspect;
uniform vec2 uSpan;
uniform vec4 uPlace;
vec2 inFrame(vec2 uv) { return (uv - 0.5) * uSpan; }
vec2 srcUv(vec2 q) {
  vec2 d = rot(uPlace.w) * (q - uPlace.xy);
  return d / (uPlace.z * vec2(uSrcAspect, 1.0)) + 0.5;
}
`;

/** The picture as the growth reads it: small, soft, and slow to change (a video does not jerk the regimes). */
const GUIDE = COMMON + PLACE + /* glsl */ `
uniform sampler2D uPrev;
uniform float uBlend;
void main() {
  vec2 uv = srcUv(inFrame(vUv));
  vec2 du = dFdx(uv), dv = dFdy(uv);
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) + 0.5) * 0.25 - 0.5;
    sum += min(texture(uSrc, uv + du * o.x + dv * o.y).rgb, vec3(2.0));
  }
  fragColor = vec4(mix(texture(uPrev, vUv).rgb, sum / 16.0, uBlend), 1.0);
}
`;

/**
 * The picture's structure tensor over its three channels (xy: its anisotropic part as a
 * double angle, z: its trace) and, in a, how lively the place is.
 */
const TENSOR = COMMON + /* glsl */ `
uniform sampler2D uGuide;
uniform vec2 uTexel;
vec3 tone(vec2 o) { return sqrt(max(texture(uGuide, vUv + o * uTexel).rgb, 0.0)); }
void main() {
  vec3 a = tone(vec2(-1.0, 1.0)), b = tone(vec2(0.0, 1.0)), c = tone(vec2(1.0, 1.0));
  vec3 d = tone(vec2(-1.0, 0.0)), e = tone(vec2(0.0)), f = tone(vec2(1.0, 0.0));
  vec3 g = tone(vec2(-1.0, -1.0)), h = tone(vec2(0.0, -1.0)), i = tone(vec2(1.0, -1.0));
  vec3 gx = (c + 2.0 * f + i - a - 2.0 * d - g) * 0.125;
  vec3 gy = (a + 2.0 * b + c - g - 2.0 * h - i) * 0.125;
  vec3 colour = e * e;
  float top = max(colour.r, max(colour.g, colour.b)), low = min(colour.r, min(colour.g, colour.b));
  float chroma = (top - low) / (top + 0.02);
  // Colour is livelier than white, white than grey, grey than black.
  float lively = sqrt(saturate(luma(colour))) * (0.45 + 0.55 * smoothstep(0.05, 0.6, chroma));
  fragColor = vec4(dot(gx, gx) - dot(gy, gy), 2.0 * dot(gx, gy), dot(gx, gx) + dot(gy, gy), lively);
}
`;

/**
 * The frame's picture in four numbers: the mean and the spread of the liveliness (any picture
 * uses the whole range of regimes) and the hue that dominates it, as a vector.
 */
const STATS = /* glsl */ `
uniform sampler2D uTensor, uGuide, uPrev;
uniform float uBlend;
void main() {
  float sum = 0.0, squares = 0.0;
  vec2 hue = vec2(0.0);
  for (int j = 0; j < 8; j++) for (int i = 0; i < 12; i++) {
    vec2 at = (vec2(float(i), float(j)) + 0.5) / vec2(12.0, 8.0);
    float v = texture(uTensor, at).a;
    sum += v; squares += v * v;
    vec3 c = sqrt(max(texture(uGuide, at).rgb, 0.0));
    hue += vec2(c.r - 0.5 * (c.g + c.b), 0.8660254 * (c.g - c.b));
  }
  float mean = sum / 96.0;
  vec4 now = vec4(mean, sqrt(max(squares / 96.0 - mean * mean, 0.0)), hue / 96.0);
  fragColor = mix(texture(uPrev, vec2(0.5)), now, uBlend);
}
`;

const DRY = 3;
const WAVES = 3;

/**
 * What the picture and the weather make of every place. Target 0 — r: feed, g: kill, ba: the
 * grain of the diffusion (its strength times the contour's double angle). Target 1 — r: the
 * scale of the pattern (a factor on both diffusions), g: how much of a contour is here, ba: the
 * slope of the land the pattern lies on (the picture's lively parts stand higher).
 */
const PARAMS = COMMON + BICUBIC + /* glsl */ `
uniform sampler2D uTensor, uStats;
uniform vec2 uTexel, uSpan, uDull, uLively, uWeatherShift;
uniform float uEdgeFeed, uEdgeKill, uGrain, uWeather, uDrought, uFeedBias, uWeatherT, uFine, uWaveKill, uChart;
uniform vec3 uDry[${DRY}];
uniform vec4 uWave[${WAVES}];
float land(vec2 o) { return bicubic(uTensor, vUv + o * uTexel, 1.0 / uTexel).a; }
void main() {
  vec2 q = (vUv - 0.5) * uSpan;
  vec4 t = vec4(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float w = (2.0 - abs(float(i))) * (2.0 - abs(float(j)));
    t += w * texture(uTensor, vUv + vec2(float(i), float(j)) * uTexel * 1.5);
  }
  t /= 16.0;
  float along = length(t.xy);
  float strength = sqrt(max(t.z, 0.0));
  float edge = smoothstep(0.015, 0.2, strength);
  vec2 grain = -t.xy / (along + 1e-6) * uGrain * (along / (t.z + 1e-5)) * smoothstep(0.004, 0.05, strength);
  vec2 stats = texture(uStats, vec2(0.5)).rg;
  float spread = max(stats.y * 1.6, 0.09);
  float lively = saturate((t.a - stats.x) / (2.0 * spread) + 0.5);
  // The weather: slow fronts that move every place along its line, and dry patches where nothing lasts.
  float front = snoise3(vec3(q * 1.15 + uWeatherShift, uWeatherT));
  lively = saturate(lively + uWeather * front);
  lively = lively * lively * (3.0 - 2.0 * lively);
  float dry = smoothstep(0.5, 0.85, snoise3(vec3(q * 0.8 - uWeatherShift.yx * 1.3, uWeatherT * 0.7 + 7.0)));
  for (int i = 0; i < ${DRY}; i++) {
    vec2 d = q - uDry[i].xy;
    dry = max(dry, exp(-dot(d, d) / (uDry[i].z * uDry[i].z)));
  }
  float feed = mix(uDull.x, uLively.x, lively) + uEdgeFeed * edge + uFeedBias;
  float kill = mix(uDull.y, uLively.y, lively) + uEdgeKill * edge + uDrought * dry;
  // A kick's wave: a ring of hunger that runs outward — the growth thins as it passes and comes back glowing.
  for (int i = 0; i < ${WAVES}; i++) kill += uWaveKill * uWave[i].w * exp(-sq((length(q - uWave[i].xy) - uWave[i].z) / 0.04));
  // Fine work where the picture is busy, bold forms where it is plain; the weather shifts the border.
  float fine = saturate(0.75 * smoothstep(0.01, 0.12, strength) + 0.5 * snoise3(vec3(q * 0.7 + uWeatherShift.yx, uWeatherT * 0.8 + 3.0)) + 0.15);
  float scale = mix(1.0, uFine, fine * fine * (3.0 - 2.0 * fine));
  if (uChart > 0.5) {
    feed = mix(0.008, 0.092, vUv.y);
    kill = mix(0.044, 0.07, vUv.x);
    grain = vec2(0.0);
    scale = 1.0;
  }
  vec2 slope = vec2(land(vec2(1.5, 0.0)) - land(vec2(-1.5, 0.0)), land(vec2(0.0, 1.5)) - land(vec2(0.0, -1.5))) / 9.0;
  fragColor = vec4(feed, kill, grain);
  fragColor1 = vec4(scale * scale, edge, slope / max(2.0 * spread, 0.2));
}
`;

/** The state: r the substrate U, g the inhibitor V, b a slow follower of V, a the hue clock at the growth's birth. */
const INIT = COMMON + /* glsl */ `
uniform float uSeed;
void main() {
  vec2 at = gl_FragCoord.xy / 13.0;
  vec2 cell = floor(at);
  float v = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    vec2 d = at - c - 0.5 - (hash22(c + uSeed * 17.3) - 0.5) * 0.8;
    v += step(0.62, hash12(c + uSeed * 31.7)) * exp(-dot(d, d) * 14.0);
  }
  v = min(v, 1.0);
  fragColor = vec4(1.0 - 0.5 * v, 0.45 * v, 0.0, vnoise(gl_FragCoord.xy / 90.0 + uSeed * 3.0));
}
`;

const RINGS = 2;
const SPORES = 4;

/** Once a frame: the state carried by the flow, the follower moved on, seed sown. */
const EVENTS = COMMON + /* glsl */ `
uniform sampler2D uState;
uniform vec2 uSize, uSpan, uCentre, uFlowShift;
uniform float uStep, uZoom, uSwirl, uCurl, uFlowT, uFollow, uClock;
uniform vec4 uRing[${RINGS}];
uniform vec4 uDots[${RINGS}];
uniform vec4 uSpore[${SPORES}];
vec4 carried(vec2 uv) {
  vec2 st = uv * uSize - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 a = (i + 0.5) / uSize, b = (i + 1.5) / uSize;
  return mix(mix(texture(uState, a), texture(uState, vec2(b.x, a.y)), f.x), mix(texture(uState, vec2(a.x, b.y)), texture(uState, b), f.x), f.y);
}
void main() {
  vec2 q = (vUv - 0.5) * uSpan;
  vec2 c = q - uCentre;
  // Outward from a wandering centre, turning about it, and the eddies of a drifting noise.
  vec2 v = c * uZoom + vec2(-c.y, c.x) * uSwirl * exp(-dot(c, c) * 1.2);
  vec2 s = q * 1.3 + uFlowShift;
  const float e = 0.04;
  float n0 = snoise3(vec3(s, uFlowT)), nx = snoise3(vec3(s + vec2(e, 0.0), uFlowT)), ny = snoise3(vec3(s + vec2(0.0, e), uFlowT));
  v += vec2(ny - n0, -(nx - n0)) / e * uCurl;
  vec4 state = carried(vUv - v * uStep / uSpan);
  state.b += (state.g - state.b) * uFollow;
  // Bare ground keeps the time: what grows over it later is of that hour.
  state.a = mix(state.a, uClock, (1.0 - smoothstep(0.02, 0.09, state.g)) * 0.2);
  float sown = 0.0;
  for (int i = 0; i < ${RINGS}; i++) {
    vec2 d = q - uRing[i].xy;
    float r = length(d);
    float dots = smoothstep(0.35, 0.9, cos(atan(d.y, d.x) * uDots[i].x + uDots[i].y));
    sown += uRing[i].w * exp(-sq((r - uRing[i].z) / uDots[i].z)) * dots;
  }
  for (int i = 0; i < ${SPORES}; i++) {
    vec2 d = q - uSpore[i].xy;
    sown += uSpore[i].w * exp(-dot(d, d) / (uSpore[i].z * uSpore[i].z));
  }
  sown = saturate(sown);
  state.r = mix(state.r, min(state.r, 0.5), sown);
  state.g = mix(state.g, max(state.g, 0.42), sown);
  fragColor = state;
}
`;

/** A step of Gray–Scott, the diffusion with a grain: faster along the picture's contours. */
const REACT = /* glsl */ `
uniform sampler2D uState, uParam, uLand;
uniform vec2 uTexel, uDiffusion;
void main() {
  vec4 c = texture(uState, vUv);
  vec2 l = texture(uState, vUv + vec2(-uTexel.x, 0.0)).rg, r = texture(uState, vUv + vec2(uTexel.x, 0.0)).rg;
  vec2 b = texture(uState, vUv + vec2(0.0, -uTexel.y)).rg, t = texture(uState, vUv + vec2(0.0, uTexel.y)).rg;
  vec2 bl = texture(uState, vUv - uTexel).rg, tr = texture(uState, vUv + uTexel).rg;
  vec2 br = texture(uState, vUv + vec2(uTexel.x, -uTexel.y)).rg, tl = texture(uState, vUv + vec2(-uTexel.x, uTexel.y)).rg;
  vec4 p = texture(uParam, vUv);
  vec2 lap = (4.0 * (l + r + b + t) + bl + br + tl + tr - 20.0 * c.rg) / 6.0;
  lap += p.z * ((l + r) - (b + t)) + p.w * 0.5 * (tr + bl - tl - br);
  lap *= texture(uLand, vUv).r;
  float reaction = c.r * c.g * c.g;
  float u = c.r + uDiffusion.x * lap.x - reaction + p.x * (1.0 - c.r);
  float v = c.g + uDiffusion.y * lap.y + reaction - (p.x + p.y) * c.g;
  fragColor = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), c.b, c.a);
}
`;

/**
 * The relief the light falls on. Target 0 — r: height, gb: its gradient, a: how near the
 * ridges are (a wide blur). Target 1 — r: fresh growth, g: what has just died, b: the hue
 * clock of the growth, a: the substrate.
 */
const RELIEF = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uTexel;
float height(vec2 o) { return smoothstep(0.015, 0.36, texture(uState, vUv + o * uTexel).g); }
void main() {
  float a = height(vec2(-1.0, 1.0)), b = height(vec2(0.0, 1.0)), c = height(vec2(1.0, 1.0));
  float d = height(vec2(-1.0, 0.0)), e = height(vec2(0.0)), f = height(vec2(1.0, 0.0));
  float g = height(vec2(-1.0, -1.0)), h = height(vec2(0.0, -1.0)), i = height(vec2(1.0, -1.0));
  float smoothed = (4.0 * e + 2.0 * (b + d + f + h) + a + c + g + i) / 16.0;
  vec2 gradient = vec2(c + 2.0 * f + i - a - 2.0 * d - g, a + 2.0 * b + c - g - 2.0 * h - i) * 0.125;
  float wide = 0.0;
  for (int k = 0; k < 8; k++) {
    float angle = float(k) * 0.7853982;
    wide += height(vec2(cos(angle), sin(angle)) * (k % 2 == 0 ? 3.0 : 5.0));
  }
  vec4 state = texture(uState, vUv);
  fragColor = vec4(smoothed, gradient, 0.5 * smoothed + 0.5 * wide / 8.0);
  fragColor1 = vec4(smoothstep(0.03, 0.2, state.g - state.b), smoothstep(0.03, 0.2, state.b - state.g), state.a, state.r);
}
`;

/** Interference colours by thickness (x, 0–1400 nm) and the cosine of the angle in the film (y). */
const FILM_TABLE = COMMON + /* glsl */ `
void main() { fragColor = vec4(thinFilm(vUv.x * 1400.0, vUv.y), 1.0); }
`;

const SHADE = COMMON + BICUBIC + PLACE + /* glsl */ `
uniform sampler2D uRelief, uAux, uLand, uFilm, uStats;
uniform vec2 uSimSize;
uniform float uT, uBump, uDome, uRefract, uHue, uDream, uHueSwing, uSparkle, uGrowth, uFilmAmount, uThick, uInner, uOil, uRings, uClock;
uniform vec3 uKeyPos, uFillDir, uKey, uFill, uEnvLow, uEnvHigh;
uniform vec4 uWave[${WAVES}];
uniform float uRipple, uSwell;
vec3 environment(vec3 r, vec3 keyDir) {
  vec3 sky = mix(uEnvLow, uEnvHigh, smoothstep(-0.6, 0.9, r.y * 0.8 + r.z * 0.4));
  sky += uKey * 0.9 * pow(saturate(dot(r, keyDir)), 16.0);
  sky += uFill * 0.8 * pow(saturate(dot(r, uFillDir)), 6.0);
  return sky;
}
vec3 filmColour(float thickness, float cosine) {
  vec3 film = texture(uFilm, vec2(thickness / 1400.0, cosine)).rgb;
  return max(mix(vec3(luma(film)), film, 1.9), 0.0);
}
void main() {
  vec2 q = inFrame(vUv);
  // The kicks' waves run through the glaze too: a swell that carries the relief outward as it
  // passes, and a ripple the reflections ride.
  vec2 ripple = vec2(0.0), swell = vec2(0.0);
  for (int i = 0; i < ${WAVES}; i++) {
    vec2 d = q - uWave[i].xy;
    float x = (length(d) - uWave[i].z) / 0.035;
    vec2 away = normalize(d + 1e-5) * uWave[i].w;
    ripple += away * x * exp(-x * x);
    swell += away * exp(-0.2 * x * x);
  }
  q -= swell * uSwell;
  vec2 at = q / uSpan + 0.5;
  vec4 relief = bicubic(uRelief, at, uSimSize);
  vec4 aux = bicubic(uAux, at, uSimSize);
  vec4 land = bicubic(uLand, at, uSimSize);
  float h = saturate(relief.r);
  vec3 n = normalize(vec3(-relief.gb * uBump - land.ba * uDome - ripple * uRipple, 1.0));
  vec3 view = normalize(vec3(-q * 0.4, 1.0));
  vec3 keyDir = normalize(uKeyPos - vec3(q, 0.0));
  float cosV = saturate(dot(n, view));
  float ridge = smoothstep(0.06, 0.42, h);
  float core = smoothstep(0.55, 0.97, h);
  float near = saturate(relief.a);
  float age = aux.b - uClock;

  // The picture under the glaze, bent by the relief as by a lens.
  vec3 src = min(texture(uSrc, srcUv(q - n.xy * uRefract * (0.4 + h))).rgb, vec3(2.0));
  float top = max(src.r, max(src.g, src.b)), low = min(src.r, min(src.g, src.b));
  float y = luma(src);
  float coloured = smoothstep(0.1, 0.42, (top - low) / (top + 0.02)) * smoothstep(0.015, 0.1, top);
  vec3 vivid = max(mix(vec3(y), src, 1.7), 0.0);
  vivid *= (0.08 + pow(top, 0.75)) / (max(vivid.r, max(vivid.g, vivid.b)) + 0.08);
  // Where the picture has no colour or no light of its own the growth dreams one: across the wheel from
  // the picture's own hue, wandering with the place and with the hour the growth is of.
  vec2 own = texture(uStats, vec2(0.5)).ba;
  vec2 seeded = vec2(cos(TAU * uHue), sin(TAU * uHue));
  vec2 base = mix(seeded, own / (length(own) + 1e-5), smoothstep(0.01, 0.05, length(own)));
  float hue = atan(base.y, base.x) / TAU + uDream + 0.13 * snoise(q * 0.8 + uT * 0.011) + 0.45 * age + 0.07 * h;
  vec3 dream = toLinear(hsv(fract(hue), 0.86, 0.78 + 0.22 * sqrt(saturate(y))));
  vec3 pigment = mix(dream, vivid, coloured);
  pigment = max(hueShift(pigment, uHueSwing * sin(TAU * age)), 0.0);

  // Light: a lamp over one side of the frame, a coloured fill from across.
  float towardKey = texture(uRelief, at + keyDir.xy * 2.5 / uSimSize).r;
  float shadow = 1.0 - 0.8 * saturate((towardKey - h) * 2.0);
  float diffuse = saturate(dot(n, keyDir) * 0.6 + 0.4);
  // The ridges are glass over the pigment: lit on the lamp's side, and the light that went in
  // gathers on the far flank and in the core.
  float gathered = pow(saturate(0.2 - dot(n.xy, keyDir.xy) * 1.5), 1.6);
  vec3 held = mix(pigment, pigment * pigment * 1.5, 0.45);
  vec3 body = pigment * (0.07 + 0.4 * diffuse * shadow) + held * uInner * (0.9 * gathered + 0.16 * h + 0.75 * core);

  // The valleys: the picture deep under dark water, and on the water a film of oil whose
  // thickness follows the substrate the ridges have drunk: colours ring every shore.
  vec3 r = reflect(-view, n);
  vec3 room = environment(r, keyDir);
  float fresnel = 0.035 + 0.965 * pow(1.0 - cosV, 5.0);
  float cosFilm = sqrt(1.0 - (1.0 - cosV * cosV) / (1.38 * 1.38));
  float drunk = saturate(1.0 - aux.a);
  float oilThick = 30.0 + uRings * drunk + 260.0 * h + 60.0 * sin(TAU * age);
  vec3 oil = filmColour(oilThick, cosFilm) * mix(0.04, 1.0, smoothstep(90.0, 260.0, oilThick));
  float shore = smoothstep(0.0, 0.1, h) * (1.0 - ridge);
  vec3 deep = mix(dream * 0.012, vivid * vivid * 0.09, coloured) * (1.0 - 0.7 * near);
  deep += oil * uOil * (0.05 + 0.55 * shore) * (0.25 + luma(room)) + held * 0.035 * near;
  vec3 color = mix(deep * shadow, body, ridge);

  // The glaze: reflections of the room, in thin-film colours on the flanks.
  float slope = saturate(1.0 - n.z);
  vec3 film = filmColour(uThick + 380.0 * h + 190.0 * sin(TAU * age), cosFilm);
  float flank = uFilmAmount * smoothstep(0.03, 0.3, slope) * ridge;
  vec3 tint = mix(vec3(1.0), film * 2.4, flank);
  // Open water far from any ridge lies deep and still, and mirrors little.
  tint *= mix(0.14, 1.0, saturate(near * 3.0 + ridge));
  color += room * tint * (fresnel * 1.3 + 0.06 * flank);
  color += film * held * flank * 0.6;
  vec3 halfKey = normalize(keyDir + view), halfFill = normalize(uFillDir + view);
  float nk = saturate(dot(n, halfKey)), nf = saturate(dot(n, halfFill));
  color += uKey * tint * (pow(nk, 320.0) * 9.0 * (0.35 + uSparkle) + pow(nk, 36.0) * 0.2) * shadow;
  color += uFill * tint * (pow(nf, 120.0) * 2.5 * (0.35 + uSparkle) + pow(nf, 14.0) * 0.1);

  // Whatever has just grown glows; what has just died leaves an ember.
  color += (held * 1.7 + 0.15) * aux.r * uGrowth;
  color += held * 0.25 * aux.g * (1.0 - ridge);
  fragColor = vec4(max(color, 0.0), 1.0);
}
`;

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const kit = new Kit(environment.gl);
  const look = LOOKS[preset] ?? LOOKS.coral!;
  const random = seededRandom(seed * 9173 + 29);
  const programs = {
    guide: kit.program(GUIDE), tensor: kit.program(TENSOR), stats: kit.program(STATS), params: kit.program(PARAMS, { outputs: 2 }), init: kit.program(INIT),
    events: kit.program(EVENTS), react: kit.program(REACT), relief: kit.program(RELIEF, { outputs: 2 }), table: kit.program(FILM_TABLE),
    shade: kit.program(SHADE)
  };
  const film = kit.target(512, 64, "rgba16f");
  let tablesDrawn = false;
  const stats = kit.double(1, 1, "rgba16f", { filter: "nearest" });
  let guide: Double | null = null;
  let tensor: Target | null = null;
  let params: Target | null = null;
  let state: Double | null = null;
  let relief: Target | null = null;
  let scene: Target | null = null;
  let frames = 0;
  let pending = 0;

  // What the seed decides: how the picture floats, where the flow turns, the paths of the dry
  // patches and of the rings' hearts, the hue the growth dreams in, where the light stands.
  const floatPhase = [random() * 6.283, random() * 6.283, random() * 6.283, random() * 6.283];
  const tilt = (random() - 0.5) * 0.5;
  const turn = random() < 0.5 ? -1 : 1;
  const flowShift = [random() * 40, random() * 40];
  const weatherShift = [random() * 40, random() * 40];
  const centrePhase = [random() * 6.283, random() * 6.283];
  const dryPaths = Array.from({ length: DRY }, () => [random() * 6.283, random() * 6.283, 0.6 + random() * 0.8, 0.6 + random() * 0.8, 0.13 + random() * 0.09] as const);
  const heartPhase = [random() * 6.283, random() * 6.283];
  const hue = random();
  const dream = 0.36 + random() * 0.28;
  const keyAngle = random() * 6.283;
  // The lamp hangs outside the frame: its mirror image never lies on the picture.
  const keyDir = [Math.cos(keyAngle), Math.sin(keyAngle), 0.75];
  const fillDir = [-Math.cos(keyAngle + 0.5) * 0.9, -Math.sin(keyAngle + 0.5) * 0.9, 0.42];
  const dry = new Float32Array(DRY * 3);
  const ring = new Float32Array(RINGS * 4);
  const dots = new Float32Array(RINGS * 4);
  const spore = new Float32Array(SPORES * 4);
  const wave = new Float32Array(WAVES * 4);
  const waveBorn = new Float32Array(WAVES).fill(-10);
  const waveAt = new Float32Array(WAVES * 2);
  let nextRing = 0;
  let sporeDue = 0;
  let feedPush = 0;

  return {
    render(frame: FvFrame): void {
      if (!tablesDrawn) {
        // With the first frame, not at creation: nothing waits for a program still compiling.
        kit.draw(programs.table, film, {});
        tablesDrawn = true;
      }
      const f = frame.audio.features;
      const aspect = frame.width / frame.height;
      const span = aspect >= 1 ? [aspect, 1] : [1, 1 / aspect];
      const [workWidth, workHeight] = workSize(frame);
      const short = Math.round(look.cells * Math.min(1, Math.max(0.6, frame.scale)));
      const simWidth = Math.round(short * span[0]!);
      const simHeight = Math.round(short * span[1]!);
      const guideWidth = Math.max(8, Math.round(simWidth / 3));
      const guideHeight = Math.max(8, Math.round(simHeight / 3));
      const fresh = !state;
      guide = kit.fitDouble(guide, guideWidth, guideHeight, "rgba16f", { wrap: "mirror" }, true);
      tensor = kit.fit(tensor, guideWidth, guideHeight, "rgba16f", { wrap: "mirror" });
      params = kit.fit(params, simWidth, simHeight, "rgba16f", { wrap: "mirror", attachments: 2 });
      state = kit.fitDouble(state, simWidth, simHeight, kit.stateFormat, { filter: "nearest", wrap: "mirror" }, true);
      relief = kit.fit(relief, simWidth, simHeight, "rgba16f", { wrap: "mirror", attachments: 2 });
      scene = kit.fit(scene, workWidth, workHeight, "rgba16f");
      if (fresh) {
        kit.draw(programs.init, state.read, { uSeed: seed % 97 });
      }
      const step = Math.min(1 / 30, Math.max(1e-4, frame.dt));
      const energy = f.level * f.presence;
      const gentle = frame.gentle;

      // The picture floats: it leans, breathes and wanders a little, so the regimes never lie still.
      const source = environment.source.uniforms();
      const sourceAspect = Number(source.uSrcAspect) || 1;
      const hasPicture = Number(source.uHasSrc) > 0.5;
      const contain = Math.min(span[1]!, span[0]! / sourceAspect);
      const cover = Math.max(span[1]!, span[0]! / sourceAspect);
      const size = (contain + (cover - contain) * (hasPicture ? 0.4 : 1)) * (1.1 + 0.05 * Math.sin(f.flow * 0.043 + floatPhase[0]!));
      const place = [
        0.035 * Math.sin(f.flow * 0.031 + floatPhase[1]!), 0.035 * Math.sin(f.flow * 0.037 + floatPhase[2]!), size,
        tilt * 0.3 + 0.06 * Math.sin(f.flow * 0.023 + floatPhase[3]!)
      ];
      const placed = { ...source, uSpan: span, uPlace: place };

      kit.draw(programs.guide, guide.write, { ...placed, uPrev: guide.read, uBlend: frames === 0 ? 1 : 1 - Math.exp(-step / 0.25) });
      guide.swap();
      kit.draw(programs.tensor, tensor, { uGuide: guide.read, uTexel: [1 / guideWidth, 1 / guideHeight] });
      kit.draw(programs.stats, stats.write, { uTensor: tensor, uGuide: guide.read, uPrev: stats.read, uBlend: frames === 0 ? 1 : 1 - Math.exp(-step / 1.5) });
      stats.swap();

      // The weather and the dry patches.
      for (let index = 0; index < DRY; index += 1) {
        const path = dryPaths[index]!;
        dry.set([
          0.46 * span[0]! * Math.sin(f.flow * 0.09 * path[2] + path[0]), 0.46 * span[1]! * Math.sin(f.flow * 0.09 * path[3] + path[1]),
          path[4] * (0.8 + 0.3 * Math.sin(f.flow * 0.11 + index * 2.1))
        ], index * 3);
      }
      // A kick is a spurt of growth: the feed rate up for a moment, more slowly in gentle mode.
      feedPush += (f.kick - feedPush) * Math.min(1, step / (gentle ? 0.22 : 0.05));
      const feedBias = look.bassFeed * (f.bass * f.presence - 0.35) + look.kickFeed * feedPush * (gentle ? 0.6 : 1);
      kit.draw(programs.params, params, {
        uTensor: tensor, uStats: stats.read, uTexel: [1 / guideWidth, 1 / guideHeight], uSpan: span, uDull: look.dull, uLively: look.lively,
        uEdgeFeed: look.edgeFeed, uEdgeKill: look.edgeKill, uGrain: look.grain, uWeather: look.weather, uDrought: look.drought, uFine: look.fine,
        uFeedBias: feedBias, uWeatherT: f.flow * 0.055, uWeatherShift: [weatherShift[0]! + f.flow * 0.022 * turn, weatherShift[1]! + f.flow * 0.017],
        uDry: dry, uWave: wave, uWaveKill: CHART ? 0 : look.waveKill, uChart: CHART ? 1 : 0
      });

      // Seed: a dotted ring on every kick, wider with each beat of the bar about a heart that
      // moves on with every bar; and a spore now and then, so no fertile ground stays empty.
      ring.fill(0);
      spore.fill(0);
      if (f.onset) {
        const bar = Math.floor(f.beat / 4);
        const heartX = 0.3 * span[0]! * Math.sin(bar * 2.4 + heartPhase[0]!);
        const heartY = 0.3 * span[1]! * Math.sin(bar * 1.7 + heartPhase[1]!);
        const radius = 0.07 + 0.085 * (f.beat % 4);
        const count = Math.max(5, Math.round(radius * 6.283 * short / 17));
        ring.set([heartX, heartY, radius, 1], nextRing * 4);
        dots.set([count, random() * 6.283, 2.6 / short, 0], nextRing * 4);
        nextRing = (nextRing + 1) % RINGS;
        const slot = f.beat % WAVES;
        waveBorn[slot] = f.time;
        waveAt.set([heartX, heartY], slot * 2);
      }
      // The waves run outward from the heart and fade as they go.
      for (let index = 0; index < WAVES; index += 1) {
        const age = f.time - waveBorn[index]!;
        const left = Math.max(0, 1 - age / 1.5);
        wave.set([waveAt[index * 2]!, waveAt[index * 2 + 1]!, 0.03 + 0.62 * age, left * left * Math.min(1, age / 0.06)], index * 4);
      }
      sporeDue -= step * (1 + 2 * energy);
      if (sporeDue <= 0) {
        sporeDue = CHART ? 0.15 : 0.3 + random() * 0.3;
        for (let index = 0; index < (CHART ? SPORES : 2); index += 1) {
          spore.set([(random() - 0.5) * span[0]!, (random() - 0.5) * span[1]!, 3.2 / short, 1], index * 4);
        }
      }
      const centre = [0.22 * span[0]! * Math.sin(f.flow * 0.021 + centrePhase[0]!), 0.22 * span[1]! * Math.sin(f.flow * 0.027 + centrePhase[1]!)];
      const still = CHART ? 0 : 1;
      kit.draw(programs.events, state.write, {
        uState: state.read, uSize: [simWidth, simHeight], uSpan: span, uCentre: centre, uFlowShift: flowShift, uStep: step,
        uZoom: still * look.zoom * (0.5 + 1.2 * energy + 4 * f.kick), uSwirl: still * turn * look.flow * (0.8 + 1.5 * f.lowMid * f.presence),
        uCurl: still * look.flow * (0.7 + 1.6 * f.mid * f.presence), uFlowT: f.flow * 0.06, uFollow: 1 - Math.exp(-step / (gentle ? 0.9 : 0.55)),
        uClock: f.flow * 0.02, uRing: ring, uDots: dots, uSpore: spore
      });
      state.swap();

      // The simulation's clock runs with the music: it creeps in silence and boils at full level.
      const most = frame.scale < 0.6 ? 9 : 16;
      pending = Math.min(pending + (look.quiet + (look.loud - look.quiet) * energy + (gentle ? 1 : 2) * feedPush) * step * 60, most + 1);
      let steps = Math.floor(pending);
      pending -= steps;
      if (frame.time < 1.5) steps = most;
      steps = Math.min(steps, most);
      for (let index = 0; index < steps; index += 1) {
        kit.draw(programs.react, state.write, { uState: state.read, uParam: params, uLand: params.textures[1], uTexel: [1 / simWidth, 1 / simHeight], uDiffusion: DIFFUSION });
        state.swap();
      }

      kit.draw(programs.relief, relief, { uState: state.read, uTexel: [1 / simWidth, 1 / simHeight] });
      const sparkle = 0.25 + 0.9 * f.high + 0.8 * f.hat;
      kit.draw(programs.shade, scene, {
        ...placed, uRelief: relief, uAux: relief.textures[1], uLand: params.textures[1], uFilm: film, uStats: stats.read,
        uSimSize: [simWidth, simHeight], uT: f.time, uBump: look.bump, uDome: CHART ? 0 : look.dome, uRefract: look.refract, uHue: hue, uDream: dream,
        uHueSwing: look.hueSwing, uSparkle: sparkle, uGrowth: gentle ? 0.55 : 1, uFilmAmount: look.film,
        uThick: look.thick + 70 * Math.sin(f.flow * 0.05), uInner: look.inner, uOil: look.oil, uRings: look.rings, uClock: f.flow * 0.02, uWave: wave, uRipple: 0.9, uSwell: 0.016,
        uKeyPos: [keyDir[0]! * (0.5 * span[0]! + 0.4), keyDir[1]! * (0.5 * span[1]! + 0.4), keyDir[2]!], uFillDir: normalized(fillDir), uKey: [1.0, 0.95, 0.86],
        uFill: [0.45, 0.7, 1.0], uEnvLow: [0.05, 0.06, 0.1], uEnvHigh: [0.5, 0.6, 0.8]
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: look.exposure, bloom: look.bloom, threshold: 1.0, vignette: 0.3, contrast: 0.4, saturation: 1.1, gentle: frame.gentle
      });
      frames += 1;
    },
    destroy(): void {
      kit.destroy();
    }
  };
}

function normalized(vector: readonly number[]): number[] {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

export const definition: FvDefinition = {
  id: "living-patterns",
  order: 8,
  kind: "psychedelic",
  labelPl: "Żywe wzory",
  labelEn: "Living Patterns",
  descriptionPl: "Obraz porasta żywym koralem z mokrej emalii — wzór płynie po jego kształtach, karmi się muzyką i nigdy nie zastyga.",
  usesSource: true,
  gentleByDefault: true,
  presets: [
    { id: "coral", labelPl: "Koral", labelEn: "Coral" },
    { id: "pearls", labelPl: "Perły", labelEn: "Pearls" },
    { id: "filigree", labelPl: "Filigran", labelEn: "Filigree" },
    { id: "lace", labelPl: "Koronka", labelEn: "Lace" }
  ],
  create
};
