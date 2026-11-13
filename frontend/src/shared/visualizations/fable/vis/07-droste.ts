import { AUDIO, BICUBIC, COMMON } from "../core/glsl";
import { Kit, type Target } from "../core/kit";
import { seededRandom, workSize, type FvDefinition, type FvEnvironment, type FvFrame, type FvInstance } from "../core/types";

/**
 * Spirala Droste — Droste Spiral.
 *
 * The picture contains itself. The screen is read as a complex number z, taken to log-polar
 * space (w = log z), multiplied there by a complex α and shifted by the running zoom, and
 * brought back: a conformal map, so every copy keeps its shapes. The picture's own symmetry is
 * "the same again, R times smaller and turned by φ" — in log space a lattice spanned by
 * (log R, φ) and (0, 2π). With α = 1 the copies nest; with α chosen so that one turn around the
 * centre lands on the lattice p levels further in, they join into p spiral arms (the
 * construction of Escher's Print Gallery, as Lenstra and de Smit worked it out).
 *
 * What is ours: the frame is a superellipse with a lit iridescent rim on the seam between
 * levels; the angle may be folded into mirrors before the map (then α is free, and the bass
 * bends rings into petals); a change of mirrors is born at the vanishing point and travels
 * outward as a soft front; every copy lies in the shadow of the frame around it; the turn φ
 * breathes with the bass about the frame at the screen's edge.
 *
 * Nothing here is sampled blind: the map is analytic, so the size of a pixel in the picture is
 * known exactly (|α| · |z'| / |z|) and picks the mip level, widens the rims' filter and fades
 * what is finer than a pixel into its mean. The picture is first laid on a plate of its own
 * with a full mip chain, every frame — a video or the painting has none.
 */

interface Look {
  /** The scale between a picture and the copy inside it: the least and the most a seed picks. */
  ratio: [number, number];
  /** Spiral arms: the levels one turn around the centre climbs (0: plain nesting). */
  arms: number;
  /** The mirror counts the music steps through; empty for no mirrors. */
  mirrors: readonly (readonly number[])[];
  /** How far each copy is turned against the one around it (radians): at rest, and what full bass adds. */
  turnRest: number;
  turnBass: number;
  /** With mirrors: the share of a level a seam climbs across one mirror sector, at rest and with full bass. */
  climbRest: number;
  climbBass: number;
  /** The frame's superellipse exponent: 2 a circle, 8 almost a square. */
  power: [number, number];
  /** The glide into the picture, in levels per second, and the turning of the whole, in radians per second. */
  zoom: number;
  spin: number;
}

const LOOKS: Record<string, Look> = {
  spiral: {
    ratio: [2.5, 3.1], arms: 1, mirrors: [], turnRest: 0.0, turnBass: 0.3, climbRest: 0, climbBass: 0,
    power: [4, 7], zoom: 1, spin: 0.05
  },
  kaleidoscope: {
    ratio: [2.8, 3.6], arms: 0, mirrors: [[3, 4, 6, 8], [4, 6, 3, 5], [6, 4, 8, 3]], turnRest: 0, turnBass: 0, climbRest: 0.12, climbBass: 0.62,
    power: [3, 6], zoom: 0.9, spin: 0.045
  },
  helix: {
    ratio: [2.3, 2.9], arms: 2, mirrors: [], turnRest: 0.0, turnBass: 0.25, climbRest: 0, climbBass: 0,
    power: [2.6, 5], zoom: 1.15, spin: 0.04
  },
  window: {
    ratio: [2.0, 2.5], arms: 0, mirrors: [], turnRest: 0.1, turnBass: 0.5, climbRest: 0, climbBass: 0,
    power: [6, 10], zoom: 1.1, spin: 0.03
  }
};

const PLATE_SIZE = 1024;

/** The picture laid on the plate: cropped to the frame's shape, small ones enlarged smoothly. */
const PLATE = BICUBIC + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform float uFit, uSmooth, uDeepen;
void main() {
  vec2 uv = vUv - 0.5;
  if (uFit > 1.0) uv.x /= uFit; else uv.y *= uFit;
  uv += 0.5;
  vec3 c = uSmooth > 0.5 ? bicubic(uSrc, uv, uSrcSize).rgb : texture(uSrc, uv).rgb;
  c = max(c, 0.0);
  // The core's own painting is bright all over: under the rims' glow it turns milky. A steeper
  // curve gives it darks to fall into, and deepens its colours.
  if (uDeepen > 0.5) c = pow(c, vec3(1.55)) * 0.95;
  fragColor = vec4(c, 1.0);
}
`;

/** Interference colours by film thickness (0–1400 nm), seen straight on. */
const FILM_TABLE = COMMON + /* glsl */ `
void main() { fragColor = vec4(thinFilm(vUv.x * 1400.0, 1.0), 1.0); }
`;

const DROSTE = COMMON + AUDIO + /* glsl */ `
uniform sampler2D uPlate, uFilm;
uniform vec2 uRes, uShift, uFrame, uMorph, uOffset;
uniform vec3 uFoldA, uFoldB, uLight;
uniform float uUnit, uL, uR, uPhi, uTurn, uPower, uPlateTexels, uPlateLods, uChroma;
uniform float uBorder, uSparkle, uFilmBase, uFilmSpan, uShade, uCore, uDepth, uRim, uGain;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 conj(vec2 a) { return vec2(a.x, -a.y); }
vec2 spin(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }

// The frame as a norm (a superellipse): 1 on the frame itself.
float gauge(vec2 q) {
  q = abs(q) / uFrame;
  float m = max(max(q.x, q.y), 1e-9);
  vec2 t = q / m;
  return m * pow(pow(t.x, uPower) + pow(t.y, uPower), 1.0 / uPower);
}
// The direction in which that norm grows.
vec2 gaugeNormal(vec2 q) {
  vec2 t = abs(q) / uFrame;
  t /= max(max(t.x, t.y), 1e-9);
  return normalize(sign(q) * pow(t, vec2(uPower - 1.0)) / uFrame + 1e-9);
}

vec3 film(float x) { return texture(uFilm, vec2(uFilmBase + uFilmSpan * x, 0.5)).rgb; }

// The picture through one folding: z the screen, w the screen in log-polar, pixel a pixel's size there.
vec3 look(vec2 z, vec2 w, float pixel, vec3 fold) {
  float v = w.y;
  bool mirrored = false;
  if (fold.x > 0.5) {
    float sector = TAU / fold.x;
    float d = mod(v, sector) - 0.5 * sector;
    mirrored = d < 0.0;
    v = abs(d);
  }
  vec2 alpha = fold.yz;
  vec2 wp = cmul(alpha, vec2(w.x, v)) - uShift;
  float fp = pixel * length(alpha);
  // The level by radius first, then by the frames' own shape. Each level is turned by uPhi
  // against the one around it, about the level at the unit circle — so the turn can breathe
  // without the zoom's wrap throwing the deep levels around.
  float k = floor(wp.x / uL);
  float a = wp.y - (k + uShift.x / uL) * uPhi;
  vec2 p = exp(wp.x - k * uL) * vec2(cos(a), sin(a));
  // q0: against the hole in this picture; q1: against this picture's own frame, where the picture lies square.
  vec2 q0 = p - uOffset, q1 = spin(p, -uPhi) / uR - uOffset;
  float g0 = gauge(q0), g1 = gauge(q1);
  for (int i = 0; i < 5; i++) {
    if (g0 < 1.0) p = spin(p, uPhi) * uR;
    else if (g1 >= 1.0) p = spin(p, -uPhi) / uR;
    else break;
    q0 = p - uOffset; q1 = spin(p, -uPhi) / uR - uOffset;
    g0 = gauge(q0); g1 = gauge(q1);
  }
  // Across a seam: s0 ≥ 0 out from the hole's edge, s1 ≤ 0 in from the frame's.
  float s0 = log(max(g0, 1.0)), s1 = log(min(g1, 1.0));
  float coarse = smoothstep(0.03, 0.35, fp / uL);

  // The picture, at the mip level of the pixel's true footprint; red and blue a little apart in scale.
  vec2 uv = q1 / (2.0 * uFrame) + 0.5;
  float lod = clamp(log2(max(fp * length(p) * uPlateTexels, 1e-6)), 0.0, uPlateLods);
  vec2 fringe = (uv - 0.5) * uChroma;
  vec3 c = vec3(textureLod(uPlate, uv + fringe, lod).r, textureLod(uPlate, uv, lod).g, textureLod(uPlate, uv - fringe, lod).b) * uGain;

  // The seams' normals on the screen: the map is conformal, so a direction in the picture is
  // turned by the argument of its derivative α p / z (and mirrored where the angle was folded).
  vec2 n0 = gaugeNormal(q0), n1 = spin(gaugeNormal(q1), uPhi);
  vec2 turnP = cmul(conj(alpha), cmul(conj(p), z)), turnM = cmul(alpha, cmul(p, z));
  vec2 out0 = normalize(mirrored ? cmul(turnM, conj(n0)) : cmul(turnP, n0));
  vec2 out1 = normalize(mirrored ? cmul(turnM, conj(n1)) : cmul(turnP, n1));

  // A copy lies deeper than the picture around it: it stands in the shadow of that picture's
  // frame, longest on the side the light comes from.
  float reach = uL * (0.035 + 0.2 * max(0.0, dot(out1, uLight.xy)));
  float shadow = 0.55 * exp(s1 / (0.045 * uL)) + 0.8 * smoothstep(-reach, 0.0, s1) * smoothstep(-0.02, 0.25, dot(out1, uLight.xy));
  c *= 1.0 - uShade * mix(min(shadow, 1.0), 0.14, coarse);

  // The seam itself: a tube of soap film lying on it, lit by the lamp and from within by the music.
  bool inner = s0 < -s1;
  float s = inner ? s0 : s1;
  vec2 outward = inner ? out0 : out1;
  float halfBand = 0.5 * uBorder, h = max(0.7 * fp, 1e-5);
  float band = max(0.0, min(s + h, halfBand) - max(s - h, -halfBand)) / (2.0 * h);
  band = mix(band, uBorder / uL, coarse);
  float across = clamp(s / halfBand, -1.0, 1.0) * (1.0 - smoothstep(0.25, 1.2, h / halfBand));
  vec3 normal = vec3(outward * across, sqrt(max(1.0 - across * across, 0.0)));
  float ap = atan(q1.y, q1.x);
  float tone = 0.5 + 0.5 * sin(2.0 * ap + 1.7 * w.x + 0.23 * uFlow);
  vec3 iris = film(tone * (0.72 + 0.28 * normal.z));
  // The spectrum lies once around the frame, bass at one side and the treble opposite; it lifts
  // the rim's glow without burning the film's colours out to white.
  float song = spec(0.03 + 0.8 * abs(ap) / PI);
  float lit = uRim * (0.3 + 0.7 * song * song);
  float diffuse = max(dot(normal, uLight), 0.0);
  float glint = pow(max(dot(normal, normalize(uLight + vec3(0.0, 0.0, 1.0))), 0.0), 70.0);
  // Beads of light running both ways along the rim, while they are wider than a pixel.
  float fine = 1.0 - smoothstep(0.004, 0.012, fp);
  float beads = pow(0.5 + 0.5 * cos(17.0 * ap - 2.1 * uFlow + 3.0 * w.x), 40.0) + pow(0.5 + 0.5 * cos(29.0 * ap + 2.9 * uFlow - 5.0 * w.x), 40.0);
  vec3 tube = iris * (0.25 + 0.9 * diffuse + 1.6 * lit) + vec3(1.0, 0.96, 0.9) * glint * 5.0 + (iris + 0.5) * beads * fine * uSparkle;
  float spill = mix(exp(-s0 / (0.06 * uL)) + 0.6 * exp(s1 / (0.03 * uL)), 0.08, coarse);
  c = c * (1.0 - band) + tube * band + iris * spill * lit * 0.3;
  return c;
}

void main() {
  vec2 z = (gl_FragCoord.xy - 0.5 * uRes) / uUnit;
  float r = max(length(z), 1e-5);
  vec2 w = vec2(log(r), atan(z.y, z.x) - uTurn);
  float pixel = 1.0 / (uUnit * r);
  // A change of mirrors: the new folding inside a front that leaves the centre, the old one outside it.
  float m = uMorph.x > 0.0 ? 1.0 - smoothstep(-uMorph.y, uMorph.y, w.x - log(uMorph.x)) : 0.0;
  vec3 col;
  if (m < 0.002) col = look(z, w, pixel, uFoldA);
  else if (m > 0.998) col = look(z, w, pixel, uFoldB);
  else col = mix(look(z, w, pixel, uFoldA), look(z, w, pixel, uFoldB), m);
  // The fall cools and dims with depth; at its end the light of all the copies gathers.
  float depth = saturate(-w.x / 5.0);
  col *= mix(vec3(1.0), vec3(0.5, 0.66, 1.0), uDepth * depth);
  vec3 mean = textureLod(uPlate, vec2(0.5), uPlateLods).rgb;
  col += (mean + film(0.5 + 0.5 * sin(0.31 * uFlow))) * uCore * exp(-r / 0.04);
  fragColor = vec4(max(col, 0.0), 1.0);
}
`;

/** A texture with a full mip chain to draw into: the kit's targets have one level. */
function makePlate(gl: WebGL2RenderingContext, size: number, float: boolean): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(size)) + 1, float ? gl.RGBA16F : gl.RGBA8, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, textures: [texture], framebuffer, width: size, height: size, format: float ? "rgba16f" : "rgba8" };
}

function create(environment: FvEnvironment, preset: string, seed: number): FvInstance {
  const gl = environment.gl;
  const kit = new Kit(gl);
  const look = LOOKS[preset] ?? LOOKS.spiral!;
  const random = seededRandom(seed * 6151 + 71);
  const programs = { plate: kit.program(PLATE), table: kit.program(FILM_TABLE), droste: kit.program(DROSTE) };
  const film = kit.target(512, 1, "rgba16f");
  let tablesDrawn = false;
  const plate = makePlate(gl, PLATE_SIZE, kit.hdr);
  let scene: Target | null = null;

  // What the seed decides: the ratio, the hand of every turn, the frame's shape, the rim's colours, the mirrors' order.
  const ratio = look.ratio[0] + random() * (look.ratio[1] - look.ratio[0]);
  const logRatio = Math.log(ratio);
  const hand = random() < 0.5 ? -1 : 1;
  const power = look.power[0] + random() * (look.power[1] - look.power[0]);
  const filmBase = 0.14 + random() * 0.2;
  const filmSpan = 0.22 + random() * 0.2;
  const sequence = look.mirrors.length ? look.mirrors[Math.floor(random() * look.mirrors.length)]! : [];
  let step = Math.floor(random() * Math.max(1, sequence.length));
  let foldNow = sequence[step] ?? 0;
  let foldNext = foldNow;
  let morph = 0;
  let changedAt = 0;
  let changedBeat = 0;

  let zoom = random() * logRatio;
  let turn = random() * Math.PI * 2;
  let drift = random() * Math.PI * 2;
  let lastFlow = -1;
  let bass = 0;
  let mid = 0;
  let surge = 0;
  let punch = 0;
  let sway = 1;
  // The fixed point of the fall is not the picture's middle: the frames lean, as on the cocoa tin.
  const lean = 0.2 + 0.2 * random();
  let leanAngle = random() * Math.PI * 2;
  let lamp = random() * Math.PI * 2;

  return {
    render(frame: FvFrame): void {
      if (!tablesDrawn) {
        // With the first frame, not at creation: nothing waits for a program still compiling.
        kit.draw(programs.table, film, {});
        tablesDrawn = true;
      }
      const { audio, gentle } = frame;
      const f = audio.features;
      const dt = Math.min(0.05, Math.max(1e-4, frame.dt));
      const [workWidth, workHeight] = workSize(frame);
      scene = kit.fit(scene, workWidth, workHeight, "rgba16f");

      // The picture onto the plate, and its mip chain.
      const source = environment.source;
      const real = source.kind !== "none";
      const sourceAspect = real ? source.width / Math.max(1, source.height) : 1;
      const frameAspect = Math.min(1.4, Math.max(0.75, sourceAspect));
      const sourceSize = real ? [source.width, source.height] : [1024, 1024];
      kit.draw(programs.plate, plate, {
        ...source.uniforms(), uSrcSize: sourceSize, uFit: sourceAspect / frameAspect,
        uSmooth: Math.max(sourceSize[0]!, sourceSize[1]!) < PLATE_SIZE * 0.8 ? 1 : 0, uDeepen: real ? 0 : 1
      });
      gl.bindTexture(gl.TEXTURE_2D, plate.texture);
      gl.generateMipmap(gl.TEXTURE_2D);

      // Envelopes of our own, slower than the analysis gives: nothing here may twitch.
      const ease = (tau: number): number => 1 - Math.exp(-dt / tau);
      bass += (f.bass * (0.35 + 0.65 * f.presence) - bass) * ease(0.32);
      mid += (f.mid * f.presence - mid) * ease(0.5);
      // A kick's push, on an envelope of our own: shorter than the analysis gives, so that at 150
      // beats a minute every kick still stands apart, and rounded, so that the picture never jerks.
      if (f.onset) punch = 1;
      punch *= Math.exp(-dt / (gentle ? 0.14 : 0.12));
      surge += (punch - surge) * ease(gentle ? 0.06 : 0.04);
      const flowRate = lastFlow < 0 ? 0.4 : Math.min(3, (f.flow - lastFlow) / dt);
      lastFlow = f.flow;

      // The fall: a steady glide that the music quickens, and a smooth push from every kick.
      const speed = logRatio * look.zoom * (0.09 + 0.1 * flowRate + (gentle ? 0.55 : 0.9) * surge);
      // The turn of each copy against the next breathes with the bass.
      const phi = hand * sway * (look.turnRest + look.turnBass * bass);
      zoom += speed * dt;
      // A level's turn is pinned to the copy, not to its place on the screen: the drift takes the zoom's share out.
      drift -= phi * speed * dt / logRatio;
      if (zoom >= logRatio) zoom -= logRatio;
      turn += hand * look.spin * (0.45 + 2.2 * mid) * dt;
      if (sequence.length) drift += hand * 0.035 * (0.5 + 1.5 * mid) * dt;
      drift %= Math.PI * 2;
      leanAngle += hand * 0.02 * flowRate * dt;
      lamp += 0.11 * flowRate * dt;
      turn %= Math.PI * 2;

      // The mirrors: a step on a bar's first beat, rarely in gentle mode; by the clock where there is no beat.
      const since = f.time - changedAt;
      const corner = Math.hypot(workWidth, workHeight) / 2;
      const unit = corner / 2;
      const frontWidth = gentle ? 0.75 : 0.5;
      if (morph > 0) {
        morph += dt / (gentle ? 2.6 : 1.1);
        if (morph >= 1) {
          morph = 0;
          foldNow = foldNext;
        }
      } else if (sequence.length > 1) {
        const bars = f.beatConfidence > 0.3 && f.beat - changedBeat >= (gentle ? 16 : 8) && since > (gentle ? 6 : 2.5) && f.onset;
        if (bars || since > (gentle ? 22 : 13)) {
          step = (step + 1) % sequence.length;
          foldNext = sequence[step]!;
          morph = 1e-4;
          changedAt = f.time;
          changedBeat = f.beat;
        }
      } else if (since > 9 && bass < 0.12) {
        // Without mirrors the bars turn the breathing's hand instead, while the bass is away.
        sway = -sway;
        changedAt = f.time;
      }
      const front = morph > 0 ? 2 * Math.exp(frontWidth) * 1.05 * Math.pow(morph, 1.6) : 0;

      // α: with mirrors it is free; without, one turn must land on the lattice `arms` levels on.
      const arms = hand * look.arms;
      const climb = look.climbRest + look.climbBass * bass;
      const alpha = (count: number): [number, number, number] => count > 0
        ? [count, 1, -hand * Math.min(1.7, climb * logRatio * count / Math.PI)]
        : [0, 1 + arms * phi / (2 * Math.PI), -arms * logRatio / (2 * Math.PI)];

      const squareness = 0.86 + 0.28 / power;
      const frameHalf = [Math.sqrt(frameAspect) * squareness, squareness / Math.sqrt(frameAspect)];
      kit.draw(programs.droste, scene, {
        ...audio.uniforms(kit), uPlate: plate, uFilm: film, uRes: [workWidth, workHeight], uUnit: unit,
        uShift: [zoom, drift], uFrame: frameHalf, uOffset: [Math.cos(leanAngle) * lean * frameHalf[0]!, Math.sin(leanAngle) * lean * frameHalf[1]!],
        uLight: [Math.cos(lamp) * 0.72, Math.sin(lamp) * 0.72, 0.694], uGain: 0.85, uMorph: [front, frontWidth], uFoldA: alpha(foldNow), uFoldB: alpha(foldNext),
        uL: logRatio, uR: ratio, uPhi: phi, uTurn: turn, uPower: power,
        uPlateTexels: PLATE_SIZE / (2 * ratio * Math.min(frameHalf[0]!, frameHalf[1]!)), uPlateLods: Math.log2(PLATE_SIZE),
        uChroma: 0.006 + 0.012 * surge, uBorder: 0.05, uSparkle: 2.5 * f.hat + 1.2 * f.high * f.presence,
        uFilmBase: filmBase, uFilmSpan: filmSpan, uShade: 0.6, uCore: 1.2 + 0.8 * bass, uDepth: 0.7, uRim: 0.8 + 0.5 * f.level * f.presence
      });
      environment.post.render(scene, frame.out, frame.dt, {
        exposure: 1.3, bloom: 0.5, threshold: 0.9, vignette: 0.3, contrast: 0.35, saturation: 1.12, gentle
      });
    },
    destroy(): void {
      gl.deleteFramebuffer(plate.framebuffer);
      gl.deleteTexture(plate.texture);
      kit.destroy();
    }
  };
}

export const definition: FvDefinition = {
  id: "droste",
  order: 7,
  kind: "psychedelic",
  labelPl: "Spirala Droste",
  labelEn: "Droste Spiral",
  descriptionPl: "Nieskończony upadek w obraz: okładka zawiera samą siebie, skręca się w spiralę Eschera i odbija w lustrach kalejdoskopu, a opalizujące ramy świecą z muzyką.",
  usesSource: true,
  gentleByDefault: true,
  presets: [
    { id: "spiral", labelPl: "Spirala", labelEn: "Spiral" },
    { id: "kaleidoscope", labelPl: "Kalejdoskop", labelEn: "Kaleidoscope" },
    { id: "helix", labelPl: "Podwójna helisa", labelEn: "Double Helix" },
    { id: "window", labelPl: "Okno w oknie", labelEn: "Window in a Window" }
  ],
  create
};
