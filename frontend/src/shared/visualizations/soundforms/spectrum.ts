import { BANDS, History } from "./audio";
import type { SpectrumSettings, Stops } from "./catalog";
import { cameraView, HEADER, HISTORY, RAMP } from "./gl";
import type { Pipeline } from "./pipeline";
import { additive, type Scene } from "./scene";

/**
 * Widmo w przestrzeni: the spectrum and its recent past in three dimensions — translucent
 * sheets one behind another (each a moment, its top edge the spectrum in steps), or columns of lit
 * blocks: in rings round a centre, round a tube running into the distance, or as a city of
 * columns with the past behind the present.
 */

const MODES: Record<SpectrumSettings["mode"], number> = { slices: 0, ring: 1, tube: 2, city: 3 };

const SLICE_VERTEX = `${HEADER}${HISTORY(BANDS)}
uniform mat4 uViewProj;
uniform int uColumns, uRowStep;
uniform float uHeight;
out float vTop;
out float vRow;
void main() {
  int bar = gl_VertexID >> 2;
  int corner = gl_VertexID & 3;
  int edge = bar + (corner >> 1);
  bool top = (corner & 1) == 1;
  float c = (float(bar) + 0.5) / float(uColumns);
  float v = hist(c * 0.9, float(gl_InstanceID * uRowStep)).r;
  float x = (float(edge) / float(uColumns) - 0.5) * 3.4;
  float y = top ? 0.02 + v * uHeight : 0.0;
  gl_Position = uViewProj * vec4(x, y, -float(gl_InstanceID) * 0.34, 1.0);
  vTop = top ? 1.0 : 0.0;
  vRow = float(gl_InstanceID);
}`;

const SLICE_FRAGMENT = `${HEADER}${RAMP}
in float vTop;
in float vRow;
uniform float uAlpha, uFade, uRowsN;
out vec4 color;
void main() {
  float edge = smoothstep(0.93, 1.0, vTop);
  float a = (0.12 + 0.5 * vTop * vTop + edge * 0.9) * uAlpha * exp(-vRow / uRowsN * uFade * 2.5);
  color = vec4(ramp(vTop) * a, 1.0);
}`;

/** A box from y 0 to 1, x and z −0.5…0.5: position and normal of 36 vertices. */
function box(): Float32Array {
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [0.5, 0, 0.5]]],
    [[-1, 0, 0], [[-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5], [-0.5, 0, -0.5]]],
    [[0, 1, 0], [[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]]],
    [[0, -1, 0], [[-0.5, 0, 0.5], [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5]]],
    [[0, 0, 1], [[0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5], [-0.5, 0, 0.5]]],
    [[0, 0, -1], [[-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 0, -0.5]]]
  ];
  const out: number[] = [];
  for (const [normal, corners] of faces) {
    for (const index of [0, 1, 2, 0, 2, 3]) out.push(...corners[index]!, ...normal);
  }
  return new Float32Array(out);
}

const BAR_VERTEX = `${HEADER}${HISTORY(BANDS)}
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform int uMode, uColumns, uRowStep;
uniform float uHeight, uTime;
out vec3 vNormal;
out float vY;
out float vRow;
void main() {
  int column = gl_InstanceID % uColumns;
  int row = gl_InstanceID / uColumns;
  float c = (float(column) + 0.5) / float(uColumns);
  float v = hist(abs(c * 2.0 - 1.0) * 0.9, float(row * uRowStep)).r;
  float tall = 0.03 + v * uHeight;
  vec3 world;
  vec3 normal;
  if (uMode == 1) {
    // Rings round the centre: the newest inside, the older ones lower and wider.
    float radius = 1.2 + float(row) * 0.45;
    float angle = c * TAU;
    float w = TAU * radius / float(uColumns) * 0.7;
    float scale = 1.0 - 0.28 * float(row);
    vec3 q = vec3(aPosition.x * w, aPosition.y * tall * scale, aPosition.z * 0.22 + radius);
    float co = cos(angle), si = sin(angle);
    world = vec3(q.x * co + q.z * si, q.y, -q.x * si + q.z * co);
    normal = vec3(aNormal.x * co + aNormal.z * si, aNormal.y, -aNormal.x * si + aNormal.z * co);
    vY = q.y;
  } else if (uMode == 2) {
    // Round a tube along x: each ring of columns a moment, the newest in front.
    float angle = c * TAU + uTime * 0.05;
    vec3 radial = vec3(0.0, cos(angle), sin(angle));
    vec3 tangent = vec3(0.0, -sin(angle), cos(angle));
    float w = TAU * 0.62 / float(uColumns) * 0.72;
    world = vec3(-float(row) * 0.17 + aPosition.x * 0.12, 0.0, 0.0) + tangent * aPosition.z * w
      + radial * (0.62 + aPosition.y * tall);
    normal = vec3(aNormal.x, 0.0, 0.0) + tangent * aNormal.z + radial * aNormal.y;
    vY = aPosition.y * tall;
  } else {
    // A city: the spectrum across, the past behind.
    world = vec3((c - 0.5) * float(uColumns) * 0.16 + aPosition.x * 0.13, aPosition.y * tall, -float(row) * 0.2 + aPosition.z * 0.15);
    normal = aNormal;
    vY = world.y;
  }
  gl_Position = uViewProj * vec4(world, 1.0);
  vNormal = normal;
  vRow = float(row);
}`;

const BAR_FRAGMENT = `${HEADER}${RAMP}
in vec3 vNormal;
in float vY;
in float vRow;
uniform float uSegments, uHeight, uFade, uAlpha, uRowsN;
out vec4 color;
void main() {
  // Lit blocks with dark gaps, as on an LED meter.
  float lit = uSegments > 0.0 ? 0.18 + 0.82 * step(0.24, fract(vY * uSegments)) : 1.0;
  float light = 0.35 + 0.65 * max(dot(normalize(vNormal), normalize(vec3(0.35, 0.85, 0.45))), 0.0);
  float fade = exp(-vRow / uRowsN * uFade * 3.0);
  color = vec4(ramp(clamp(vY / uHeight * 1.1, 0.0, 1.0)) * light * lit * fade * uAlpha, 1.0);
}`;

/** The palette `amount` of the way from `from` to `to`, both read as four stops. */
function blendStops(from: Stops, to: Stops, amount: number): number[] {
  const at = (stops: Stops, t: number, shift: number): number => {
    const x = t * (stops.length - 1);
    const i = Math.min(stops.length - 1, Math.floor(x));
    const j = Math.min(stops.length - 1, i + 1);
    const f = x - i;
    return (((stops[i] ?? 0) >> shift) & 255) * (1 - f) + (((stops[j] ?? 0) >> shift) & 255) * f;
  };
  const out: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const t = index / 3;
    let hex = 0;
    for (const shift of [16, 8, 0]) {
      const value = at(from, t, shift) * (1 - amount) + at(to, t, shift) * amount;
      hex |= Math.round(Math.min(255, Math.max(0, value))) << shift;
    }
    out.push(hex);
  }
  return out;
}

export function createSpectrum(pipeline: Pipeline, settings: SpectrumSettings): Scene {
  const gl = pipeline.gl;
  const slices = settings.mode === "slices";
  const program = slices
    ? pipeline.program("spectrum-slices", SLICE_VERTEX, SLICE_FRAGMENT)
    : pipeline.program("spectrum-bars", BAR_VERTEX, BAR_FRAGMENT);
  const history = new History(gl, Math.max(8, settings.rows * settings.rowStep + 4));
  let vao: WebGLVertexArrayObject | null = null;
  let buffer: WebGLBuffer | null = null;
  if (!slices) {
    vao = gl.createVertexArray();
    buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, box(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }
  return {
    draw(frame): void {
      history.push(frame.audio, frame.dt);
      const view = cameraView(settings.camera, frame.aspect, frame.time, frame.audio.bass);
      let stops: Stops = settings.colors;
      if (settings.colorsAlt && settings.cycle) {
        const amount = 0.5 - 0.5 * Math.cos((frame.time / settings.cycle) * Math.PI * 2);
        stops = blendStops(settings.colors, settings.colorsAlt, amount);
      }
      program.use();
      history.bind(program, 0);
      program
        .m4("uViewProj", view.viewProjection)
        .i("uColumns", settings.columns)
        .i("uRowStep", settings.rowStep)
        .f("uHeight", settings.height)
        .f("uAlpha", settings.alpha)
        .f("uFade", settings.fade)
        .f("uRowsN", settings.rows)
        .stops(stops);
      if (slices) {
        gl.bindVertexArray(pipeline.vao);
        gl.disable(gl.DEPTH_TEST);
        additive(gl);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, settings.columns * 4, settings.rows);
      } else {
        gl.bindVertexArray(vao);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        program
          .i("uMode", MODES[settings.mode])
          .f("uTime", frame.time)
          .f("uSegments", settings.segments ?? 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, settings.columns * settings.rows);
        gl.disable(gl.DEPTH_TEST);
      }
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
    dispose(): void {
      history.dispose();
      if (buffer) gl.deleteBuffer(buffer);
      if (vao) gl.deleteVertexArray(vao);
    }
  };
}
