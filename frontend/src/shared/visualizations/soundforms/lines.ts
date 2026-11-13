import { BANDS, History } from "./audio";
import type { LineSettings, LineShape } from "./catalog";
import { cameraView, HEADER, HISTORY, NOISE, RAMP } from "./gl";
import type { Pipeline } from "./pipeline";
import { additive, type Scene } from "./scene";

/**
 * Fale z linii: many lines, each one a moment of the music (the newest first), its height the
 * spectrum or the waveform of that moment, bent into a shape — a field running to the horizon, a
 * tunnel, a twisted ribbon, a coil, a disc… Every line is a ribbon a pixel or two wide, built on
 * the screen from the line's direction, so it is as fine on a phone as on a 4K panel.
 */

const SHAPES: Record<LineShape, number> = {
  horizon: 0, tunnel: 1, thread: 2, twist: 3, corridor: 4, whirl: 5, wing: 6,
  coil: 7, disc: 8, crown: 9, rays: 10, silk: 11, braids: 12
};
const COLOR_BY: Record<LineSettings["colorBy"], number> = { along: 0, across: 1, height: 2, centre: 3, shape: 4 };
const HISTORY_ROWS = 128;

const VERTEX = `${HEADER}${NOISE}${HISTORY(BANDS)}${RAMP}
uniform mat4 uViewProj;
uniform vec2 uResolution;
uniform int uSamples, uLines, uShape, uColorBy;
uniform float uPoints, uTime, uWidth, uAmp, uAlpha, uLift, uSeam, uPx, uMaxPoint;
uniform vec2 uMix;
uniform vec4 uA, uB;
out vec3 vColor;
out float vSide;
out float vHalf;

float signal(float col, float age) {
  vec2 h = hist(col, age);
  return uMix.x * h.r + uMix.y * (h.g * 2.0 - 1.0);
}

// A point of line l (0 the newest ... 1) at s (0...1 along it): where it is, the music there (h),
// a colour coordinate of the shape's own (t) and how much of the line shows there (fade).
vec3 surface(float s, float l, out float h, out float t, out float fade) {
  float ages = float(uRows - 3);
  float mirrored = abs(s * 2.0 - 1.0);
  t = 0.0;
  fade = 1.0;
  vec3 p;
  if (uShape == 0) {
    h = signal(mirrored, l * ages);
    p = vec3((s - 0.5) * uA.x, h * uAmp, -l * uA.y + uA.z);
    fade = smoothstep(1.0, 0.82, l) * smoothstep(0.0, 0.04, s) * smoothstep(1.0, 0.96, s);
  } else if (uShape == 1) {
    h = signal(mirrored, l * ages);
    float angle = s * TAU + uTime * uA.z;
    float r = uA.x * (1.0 + h * uAmp);
    p = vec3(cos(angle) * r, sin(angle) * r, -l * uA.y - uA.w);
    fade = smoothstep(1.0, 0.7, l);
  } else if (uShape == 2) {
    float k = float(gl_InstanceID);
    h = signal(s, k * uA.z);
    float offset = k < 0.5 ? 0.0 : (k < 1.5 ? uA.y : -uA.y);
    p = vec3((s - 0.5) * uA.x, offset + h * uAmp + (s - 0.5) * uA.w, 0.0);
    fade = (k < 0.5 ? 1.0 : 0.22) * smoothstep(0.0, 0.05, s) * smoothstep(1.0, 0.95, s);
  } else if (uShape == 3 || uShape == 12) {
    float lane = l;
    float lift = 0.0;
    if (uShape == 12) {
      float k = min(floor(l * 3.0), 2.0);
      lane = clamp(l * 3.0 - k, 0.0, 1.0);
      lift = (1.0 - k) * uB.x;
    }
    h = signal(mirrored, lane * ages * 0.6);
    float angle = s * uA.z * PI + uTime * uA.w + lift * 0.8;
    float span = uA.y * (0.8 + 0.2 * sin(s * PI + uTime * 0.4));
    vec3 across = vec3(0.0, cos(angle), sin(angle));
    vec3 normal = vec3(0.0, -sin(angle), cos(angle));
    p = vec3((s - 0.5) * uA.x, lift, 0.0) + across * (lane - 0.5) * span + normal * h * uAmp;
    t = 0.5 + 0.5 * cos(angle);
    fade = smoothstep(0.0, 0.03, s) * smoothstep(1.0, 0.97, s);
  } else if (uShape == 4) {
    float sheet = l < 0.5 ? 1.0 : -1.0;
    float lateral = fract(l * 2.0);
    h = signal(abs(lateral * 2.0 - 1.0), s * ages);
    p = vec3((lateral - 0.5) * uA.x, sheet * (uA.z + h * uAmp), -s * uA.y - uA.w);
    t = lateral;
    fade = smoothstep(1.0, 0.55, s);
  } else if (uShape == 5) {
    // A whirlpool: rings going down, each turned and shifted a little more than the one above,
    // brighter along two arms so the turning shows as a spiral.
    h = signal(mirrored, l * ages);
    float angle = s * TAU;
    float swirl = l * uA.z + uTime * uA.w;
    float r = uA.x * (1.0 + h * uAmp) * (1.0 - 0.35 * l);
    vec2 drift = vec2(cos(swirl), sin(swirl)) * l * 0.45;
    p = vec3(cos(angle) * r + drift.x, sin(angle) * r + drift.y, -l * uA.y - 0.2);
    t = 0.5 + 0.5 * cos(angle * 2.0 - swirl * 1.5);
    fade = smoothstep(1.0, 0.75, l) * (0.12 + 0.88 * t * t);
  } else if (uShape == 6) {
    h = signal(mirrored, l * ages * 0.7);
    float x = (s - 0.5) * uA.x;
    float z = (l - 0.5) * uA.y;
    float curl = uA.z * x * x * (0.75 + 0.25 * sin(uTime * 0.35)) - 0.6;
    float sway = 0.35 * sin(x * 0.6 + uTime * 0.7) + 0.2 * sin(z * 2.0 - uTime * 0.5);
    p = vec3(x, curl + sway + h * uAmp, z);
    fade = smoothstep(0.0, 0.04, s) * smoothstep(1.0, 0.96, s) * smoothstep(0.0, 0.08, l) * smoothstep(1.0, 0.85, l);
  } else if (uShape == 7) {
    h = signal(abs(l * 2.0 - 1.0), 0.0);
    float angle = l * TAU * uA.x + uTime * uA.w;
    float r = uA.z + s * (uB.x + h * uAmp);
    p = vec3((l - 0.5) * uA.y, cos(angle) * r, sin(angle) * r);
    t = 0.5 + 0.5 * sin(angle);
    fade = smoothstep(0.0, 0.03, l) * smoothstep(1.0, 0.97, l);
  } else if (uShape == 8) {
    h = signal(mirrored, l * ages);
    // The seam (both ends of the gradient) at the back of the disc.
    float angle = s * TAU - 0.5 * PI + 0.6 * sin(uTime * uA.w);
    float r = uA.x + l * uA.y;
    p = vec3(cos(angle) * r, h * uAmp, sin(angle) * r);
    fade = smoothstep(1.0, 0.85, l);
  } else if (uShape == 9) {
    h = signal(mirrored, l * ages * 0.4);
    float angle = s * TAU + uTime * uA.w;
    float r = uA.x * (1.0 + h * uAmp * 0.18);
    p = vec3(cos(angle) * r, (l - 0.5) * uA.y + h * uAmp * l * uA.z, sin(angle) * r);
  } else if (uShape == 10) {
    float angle = l * TAU + uTime * uA.w;
    h = signal(abs(l * 2.0 - 1.0), s * ages);
    float r = uA.x * (1.0 + h * uAmp);
    p = vec3(cos(angle) * r, sin(angle) * r, -s * uA.y - uA.z);
    fade = smoothstep(1.0, 0.6, s) * smoothstep(0.0, 0.03, s);
  } else {
    h = signal(mirrored, l * ages);
    float x = (s - 0.5) * uA.x;
    float z = -l * uA.y;
    float fold = 1.4 * sin(x * 0.21 + uTime * 0.13) * cos(z * 0.12 - uTime * 0.09)
      + 0.8 * sin((x - z) * 0.16 + uTime * 0.17) + 0.35 * sin(x * 0.5 - uTime * 0.2);
    p = vec3(x, fold * uA.z + h * uAmp, z);
    t = clamp(0.5 + fold * 0.22 + h * 0.4, 0.0, 1.0);
    fade = smoothstep(1.0, 0.75, l);
  }
  return p;
}

void main() {
  bool dots = uPoints > 0.0;
  int index = dots ? gl_VertexID : gl_VertexID >> 1;
  float ds = 1.0 / float(uSamples - 1);
  float s = float(index) * ds;
  float l = float(gl_InstanceID) / float(max(uLines - 1, 1));
  float h, t, fade;
  vec3 p = surface(s, l, h, t, fade);
  vec4 clip = uViewProj * vec4(p, 1.0);
  float c = uColorBy == 0 ? s : uColorBy == 1 ? l : uColorBy == 2 ? clamp(abs(h) * 1.3, 0.0, 1.0)
    : uColorBy == 3 ? abs(s * 2.0 - 1.0) : t;
  float seam = uSeam * exp(-pow((s - 0.5) * 70.0, 2.0)) * (0.4 + clamp(abs(h) * 2.0, 0.0, 1.0));
  vColor = ramp(c) * (uAlpha * fade * (1.0 + uLift * clamp(abs(h), 0.0, 1.0)) + seam * fade);
  if (dots) {
    gl_Position = clip;
    gl_PointSize = clamp(uPoints * uPx * 4.0 / max(clip.w, 0.5), 1.0, uMaxPoint);
    vSide = 0.0;
    vHalf = 1.0;
    return;
  }
  // The ribbon: two vertices per sample, pushed apart across the line's direction on screen.
  float h2, t2, fade2;
  float s2 = s + ds <= 1.0 ? s + ds : s - ds;
  vec3 q = surface(s2, l, h2, t2, fade2);
  vec4 clip2 = uViewProj * vec4(q, 1.0);
  vec2 a = clip.xy / max(clip.w, 1e-3) * uResolution * 0.5;
  vec2 b = clip2.xy / max(clip2.w, 1e-3) * uResolution * 0.5;
  vec2 dir = (b - a) * (s2 > s ? 1.0 : -1.0);
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  float halfWidth = 0.5 * max(uWidth * uPx, 1.0) + 1.0;
  clip.xy += vec2(-dir.y, dir.x) * side * halfWidth * 2.0 / uResolution * clip.w;
  gl_Position = clip;
  vSide = side * halfWidth;
  vHalf = halfWidth;
  vColor *= min(uWidth * uPx, 1.0);
}`;

const FRAGMENT = `${HEADER}
in vec3 vColor;
in float vSide;
in float vHalf;
uniform float uPoints;
out vec4 color;
void main() {
  float a;
  if (uPoints > 0.0) {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    a = 1.0 - r2 * r2;
  } else {
    a = clamp(vHalf - 0.5 - abs(vSide), 0.0, 1.0);
  }
  color = vec4(vColor * a, 1.0);
}`;

/** Faint stars far behind the scene. */
const STAR_VERTEX = `${HEADER}${NOISE}
uniform mat4 uViewProj;
uniform float uPx, uTime;
out float vBright;
void main() {
  int i = gl_VertexID;
  vec3 dir = normalize(vec3(hashCell(ivec3(i, 1, 7)), hashCell(ivec3(i, 2, 7)), hashCell(ivec3(i, 3, 7))) - 0.5);
  gl_Position = uViewProj * vec4(dir * 60.0, 1.0);
  float size = hashCell(ivec3(i, 4, 7));
  gl_PointSize = max(1.0, (0.8 + size * 1.6) * uPx);
  vBright = (0.3 + 0.9 * size * size) * (0.75 + 0.25 * sin(uTime * (0.5 + size * 2.0) + float(i)));
}`;

const STAR_FRAGMENT = `${HEADER}
in float vBright;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = max(0.0, 1.0 - dot(c, c));
  color = vec4(vec3(0.85, 0.9, 1.0) * vBright * a, 1.0);
}`;

export function createLines(pipeline: Pipeline, settings: LineSettings): Scene {
  const gl = pipeline.gl;
  const program = pipeline.program("lines", VERTEX, FRAGMENT);
  const stars = settings.stars ? pipeline.program("stars", STAR_VERTEX, STAR_FRAGMENT) : null;
  const history = new History(gl, HISTORY_ROWS);
  const b = settings.b ?? [0, 0, 0, 0];
  return {
    draw(frame): void {
      history.push(frame.audio, frame.dt);
      const view = cameraView(settings.camera, frame.aspect, frame.time, frame.audio.bass);
      gl.bindVertexArray(pipeline.vao);
      additive(gl);
      if (stars) {
        stars.use().m4("uViewProj", view.viewProjection).f("uPx", frame.px).f("uTime", frame.time);
        gl.drawArrays(gl.POINTS, 0, settings.stars ?? 0);
      }
      program.use();
      history.bind(program, 0);
      program
        .m4("uViewProj", view.viewProjection)
        .f2("uResolution", frame.width, frame.height)
        .i("uSamples", settings.samples)
        .i("uLines", settings.lines)
        .i("uShape", SHAPES[settings.shape])
        .i("uColorBy", COLOR_BY[settings.colorBy])
        .f("uPoints", settings.points ?? 0)
        .f("uTime", frame.time)
        .f("uWidth", settings.width)
        .f("uAmp", settings.amplitude)
        .f("uAlpha", settings.alpha)
        .f("uLift", settings.lift)
        .f("uSeam", settings.seam ?? 0)
        .f("uPx", frame.px)
        .f("uMaxPoint", frame.maxPoint)
        .f2("uMix", settings.spectrum, settings.wave)
        .f4("uA", settings.a[0], settings.a[1], settings.a[2], settings.a[3])
        .f4("uB", b[0], b[1], b[2], b[3])
        .stops(settings.colors, (settings.hueSpeed ?? 0) * frame.time);
      if (settings.points) gl.drawArraysInstanced(gl.POINTS, 0, settings.samples, settings.lines);
      else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, settings.samples * 2, settings.lines);
      gl.disable(gl.BLEND);
    },
    dispose(): void {
      history.dispose();
    }
  };
}
