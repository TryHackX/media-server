import { BANDS, History } from "./audio";
import type { DotSettings, RingSettings } from "./catalog";
import { cameraView, HEADER, HISTORY, RAMP, rotation } from "./gl";
import type { Pipeline } from "./pipeline";
import { additive, type Scene } from "./scene";

/**
 * Kropki and Pierścienie, the two scenes made of dots alone.
 * - The dotted planet: a ball of dots, brightest along its outline, with the bass and the middle
 *   rolling over it in waves from one side (the further from there, the older the moment); the
 *   finish's trails leave fading, growing echoes of it behind.
 * - The rings: rings of dots round a centre, each a moment later than the one inside it, wobbling
 *   with the waveform and lit by the spectrum — dark in silence; the outer two are dashes.
 */

const PLANET_VERTEX = `${HEADER}${HISTORY(BANDS)}${RAMP}
uniform int uRingsN, uMeridians;
uniform mat4 uViewProj, uModel;
uniform vec3 uEye;
uniform float uAmp, uPoint, uPx, uMaxPoint;
out vec3 vColor;
void main() {
  int ring = gl_VertexID / uMeridians;
  int meridian = gl_VertexID - ring * uMeridians;
  float theta = (float(ring) + 0.5) / float(uRingsN) * PI;
  float phi = float(meridian) / float(uMeridians) * TAU;
  vec3 n = (uModel * vec4(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi), 0.0)).xyz;
  vec3 source = normalize(vec3(-0.85, 0.3, 0.45));
  float d = acos(clamp(dot(n, source), -1.0, 1.0)) / PI;
  float ages = float(uRows - 3);
  float low = hist(0.05, d * ages * 0.6).r;
  float middle = hist(0.4, d * ages * 0.6).r;
  float push = (low * 0.8 + middle * 0.35) * uAmp * (1.0 - 0.7 * d);
  vec3 world = n * (1.0 + push);
  gl_Position = uViewProj * vec4(world, 1.0);
  float facing = dot(n, normalize(uEye - world));
  float rim = pow(1.0 - abs(facing), 2.0);
  // Dots crowd together at the poles of the grid: there each one is dimmer.
  float bright = (0.1 + 0.9 * rim + push * 2.5) * (facing < 0.0 ? 0.3 : 1.0) * mix(0.25, 1.0, sin(theta));
  vColor = ramp(clamp(rim * 0.7 + push * 2.0, 0.0, 1.0)) * bright;
  gl_PointSize = clamp(uPoint * uPx * 6.4 / max(gl_Position.w, 0.5), 1.0, uMaxPoint);
}`;

const RING_VERTEX = `${HEADER}${HISTORY(BANDS)}${RAMP}
uniform int uRingsN, uDots;
uniform mat4 uViewProj, uModel;
uniform float uRadius, uGap, uStep, uTime, uPoint, uPx, uMaxPoint;
out vec3 vColor;
void main() {
  int ring = gl_InstanceID;
  int k = gl_VertexID / 3;
  int sub = gl_VertexID - k * 3;
  float th = float(k) / float(uDots) * TAU;
  float col = abs(fract(th / TAU + 0.25) * 2.0 - 1.0);
  vec2 v = hist(col * 0.85, float(ring) * uStep);
  float spectrum = v.r;
  float wave = v.g * 2.0 - 1.0;
  float base = uRadius + float(ring) * uGap;
  float r = base * (1.0 + 0.07 * wave + 0.08 * spectrum);
  bool dashed = ring >= uRingsN - 2;
  r += dashed ? float(sub) * (0.012 + 0.03 * spectrum) : 0.0;
  float turn = th + uTime * (ring % 2 == 0 ? 0.12 : -0.08);
  vec3 world = (uModel * vec4(cos(turn) * r, sin(turn) * r, 0.0, 1.0)).xyz;
  float bright = smoothstep(0.05, 0.45, spectrum) * (1.0 - float(ring) / float(uRingsN) * 0.6);
  if (!dashed && sub > 0) bright = 0.0;
  vColor = mix(ramp(fract(th / TAU + uTime * 0.03)), vec3(1.0), ring == 0 ? 0.45 : 0.0) * bright * 2.2;
  gl_Position = bright > 0.0 ? uViewProj * vec4(world, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = clamp(uPoint * uPx * 5.2 / max(gl_Position.w, 0.5), 1.0, uMaxPoint);
}`;

const DOT_FRAGMENT = `${HEADER}
in vec3 vColor;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  color = vec4(vColor * (1.0 - r2), 1.0);
}`;

export function createPlanet(pipeline: Pipeline, settings: DotSettings): Scene {
  const gl = pipeline.gl;
  const program = pipeline.program("planet", PLANET_VERTEX, DOT_FRAGMENT);
  const history = new History(gl, 64);
  return {
    draw(frame): void {
      history.push(frame.audio, frame.dt);
      const time = frame.time;
      const view = cameraView(settings.camera, frame.aspect, time, frame.audio.bass);
      gl.bindVertexArray(pipeline.vao);
      gl.disable(gl.DEPTH_TEST);
      additive(gl);
      program.use();
      history.bind(program, 0);
      program
        .m4("uViewProj", view.viewProjection)
        .m4("uModel", rotation(settings.spin[0] * time, settings.spin[1] * time, settings.spin[2] * time))
        .f3("uEye", view.eye[0], view.eye[1], view.eye[2])
        .i("uRingsN", settings.rings)
        .i("uMeridians", settings.meridians)
        .f("uAmp", settings.amplitude)
        .f("uPoint", settings.pointSize)
        .f("uPx", frame.px)
        .f("uMaxPoint", frame.maxPoint)
        .stops(settings.colors);
      gl.drawArrays(gl.POINTS, 0, settings.rings * settings.meridians);
      gl.disable(gl.BLEND);
    },
    dispose(): void {
      history.dispose();
    }
  };
}

export function createRings(pipeline: Pipeline, settings: RingSettings): Scene {
  const gl = pipeline.gl;
  const program = pipeline.program("rings", RING_VERTEX, DOT_FRAGMENT);
  const history = new History(gl, Math.max(16, settings.rings * settings.step + 8));
  return {
    draw(frame): void {
      history.push(frame.audio, frame.dt);
      const time = frame.time;
      const view = cameraView(settings.camera, frame.aspect, time, frame.audio.bass);
      // The rings' plane leans back and turns slowly, as if floating.
      const model = rotation(settings.tilt + 0.12 * Math.sin(time * 0.21), 0.35 * Math.sin(time * 0.13), time * 0.05);
      gl.bindVertexArray(pipeline.vao);
      gl.disable(gl.DEPTH_TEST);
      additive(gl);
      program.use();
      history.bind(program, 0);
      program
        .m4("uViewProj", view.viewProjection)
        .m4("uModel", model)
        .i("uRingsN", settings.rings)
        .i("uDots", settings.dots)
        .f("uRadius", settings.radius)
        .f("uGap", settings.gap)
        .f("uStep", settings.step)
        .f("uTime", time)
        .f("uPoint", settings.pointSize)
        .f("uPx", frame.px)
        .f("uMaxPoint", frame.maxPoint)
        .stops(settings.colors);
      gl.drawArraysInstanced(gl.POINTS, 0, settings.dots * 3, settings.rings);
      gl.disable(gl.BLEND);
    },
    dispose(): void {
      history.dispose();
    }
  };
}
