import { BANDS, History } from "./audio";
import type { MeshSettings } from "./catalog";
import { cameraView, HEADER, HISTORY, NOISE, RAMP } from "./gl";
import type { Pipeline } from "./pipeline";
import { additive, type Scene } from "./scene";

/**
 * Siatki punktów: a grid of points or wires.
 * - bokeh: a field of points to the horizon, its waves the spectrum's recent past rolling away,
 *   out-of-focus points opening into soft discs (a thin-lens circle of confusion per point);
 * - spiral: points seen from above with spiral arms raised by the music, which travels outwards
 *   along them, the colours turning slowly round the wheel;
 * - flower: a wire grid seen from above, its rim lobed by the bass, middle and treble, its height
 *   the spectrum from the centre (bass) to the rim (treble) in a six-fold pattern.
 */

const POINT_VERTEX = `${HEADER}${NOISE}${HISTORY(BANDS)}${RAMP}
uniform int uMode, uCols, uRowsN;
uniform vec2 uSize;
uniform mat4 uView, uProjection;
uniform float uTime, uAmp, uPoint, uFocus, uBlur, uPx, uMaxPoint, uLevel;
out vec3 vColor;
out float vSoft;
void main() {
  int cx = gl_VertexID % uCols;
  int cz = gl_VertexID / uCols;
  float u = float(cx) / float(uCols - 1);
  float w = float(cz) / float(uRowsN - 1);
  float ages = float(uRows - 3);
  vec3 p;
  float glow;
  float tone;
  if (uMode == 0) {
    p = vec3((u - 0.5) * uSize.x, 0.0, -0.5 - w * uSize.y);
    float music = hist(abs(u * 2.0 - 1.0) * 0.85, w * ages).r;
    float swell = noise3(vec3(p.x * 0.11, p.z * 0.11 + uTime * 0.12, uTime * 0.04)) - 0.5;
    p.y = music * uAmp + swell * (0.7 + 0.9 * uLevel);
    glow = 0.12 + 3.2 * music * music + 0.3 * max(swell, 0.0);
    tone = clamp(music * 1.3 + 0.15, 0.0, 1.0);
  } else {
    vec2 g = (vec2(u, w) - 0.5) * uSize;
    float r = length(g);
    float reach = uSize.x * 0.5;
    float th = atan(g.y, g.x);
    float music = hist(clamp(r / reach, 0.0, 1.0) * 0.5, r / reach * ages * 0.8).r;
    float arm = pow(0.5 + 0.5 * cos(th + r * 3.1 - uTime * 0.45), 5.0);
    float height = arm * (0.06 + music * uAmp) + music * 0.06;
    p = vec3(g.x, height, g.y);
    float edge = 1.0 - smoothstep(reach * 0.85, reach, r);
    glow = (0.2 + arm * (1.6 + 4.0 * music)) * edge;
    tone = clamp(arm * (0.4 + music), 0.0, 1.0);
  }
  vec4 viewPosition = uView * vec4(p, 1.0);
  float depth = max(-viewPosition.z, 0.1);
  gl_Position = uProjection * viewPosition;
  // Thin lens: the farther a point is from the focus, the wider (and fainter) its disc.
  float sharp = uPoint * uPx * 6.0 / depth;
  float circle = abs(depth - uFocus) / depth * uBlur * uPx;
  float size = clamp(sharp + circle, 1.0, uMaxPoint);
  gl_PointSize = size;
  float spread = clamp(pow(max(sharp, 1.0) / size, 1.1), 0.14, 1.0);
  vSoft = 1.0 - spread;
  vColor = ramp(tone) * glow * spread * exp(-depth * 0.045) * 1.4;
}`;

const POINT_FRAGMENT = `${HEADER}
in vec3 vColor;
in float vSoft;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  // A sharp point is a soft dot; a blurred one a flat disc with a slightly brighter rim.
  float speck = exp(-r * r * 3.5);
  float disc = (1.0 - smoothstep(0.82, 1.0, r)) * (0.85 + 0.25 * smoothstep(0.5, 0.95, r));
  color = vec4(vColor * mix(speck, disc, vSoft), 1.0);
}`;

const WIRE_VERTEX = `${HEADER}${HISTORY(BANDS)}${RAMP}
uniform int uGrid, uDirection;
uniform mat4 uViewProj;
uniform vec2 uSize;
uniform float uTime, uAmp, uBass, uMid, uTreble;
out vec3 vColor;
void main() {
  ivec2 g = uDirection == 0 ? ivec2(gl_VertexID, gl_InstanceID) : ivec2(gl_InstanceID, gl_VertexID);
  vec2 q = vec2(g) / float(uGrid - 1) * 2.0 - 1.0;
  float r = length(q);
  float th = atan(q.y, q.x);
  float lobes = 0.55 * cos(10.0 * th + uTime * 0.35) * (0.25 + uBass)
    + 0.3 * cos(6.0 * th - uTime * 0.27) * (0.2 + uMid)
    + 0.15 * cos(16.0 * th + uTime * 0.5) * uTreble;
  float rim = 0.66 + 0.16 * lobes;
  float inside = 1.0 - smoothstep(rim - 0.05, rim, r);
  float music = hist(clamp(r / rim, 0.0, 1.0) * 0.8, 0.0).r;
  float pattern = 0.6 + 0.4 * cos(th * 6.0 + uTime * 0.3) * cos(r * 10.0 - uTime * 1.1);
  float y = music * pattern * uAmp * inside;
  vec2 pushed = q * (1.0 + 0.35 * y);
  gl_Position = uViewProj * vec4(pushed.x * uSize.x * 0.5, y, pushed.y * uSize.y * 0.5, 1.0);
  float level = clamp(y / uAmp * 1.3, 0.0, 1.0);
  vColor = ramp(level) * (0.6 + 1.4 * level) * inside;
}`;

const WIRE_FRAGMENT = `${HEADER}
in vec3 vColor;
out vec4 color;
void main() {
  color = vec4(vColor, 1.0);
}`;

export function createMesh(pipeline: Pipeline, settings: MeshSettings): Scene {
  const gl = pipeline.gl;
  const wires = settings.mode === "flower";
  const program = wires
    ? pipeline.program("mesh-wires", WIRE_VERTEX, WIRE_FRAGMENT)
    : pipeline.program("mesh-points", POINT_VERTEX, POINT_FRAGMENT);
  const history = new History(gl, 96);
  const [columns, rows] = settings.grid;
  return {
    draw(frame): void {
      history.push(frame.audio, frame.dt);
      const audio = frame.audio;
      const view = cameraView(settings.camera, frame.aspect, frame.time, audio.bass);
      gl.bindVertexArray(pipeline.vao);
      gl.disable(gl.DEPTH_TEST);
      additive(gl);
      program.use();
      history.bind(program, 0);
      program
        .f2("uSize", settings.size[0], settings.size[1])
        .f("uTime", frame.time)
        .f("uAmp", settings.amplitude)
        .stops(settings.colors, (settings.hueSpeed ?? 0) * frame.time);
      if (wires) {
        program
          .m4("uViewProj", view.viewProjection)
          .i("uGrid", columns)
          .f("uBass", audio.bass)
          .f("uMid", audio.mid)
          .f("uTreble", audio.treble);
        for (const direction of [0, 1]) {
          program.i("uDirection", direction);
          gl.drawArraysInstanced(gl.LINE_STRIP, 0, columns, columns);
        }
      } else {
        program
          .m4("uView", view.view)
          .m4("uProjection", view.projection)
          .i("uMode", settings.mode === "bokeh" ? 0 : 1)
          .i("uCols", columns)
          .i("uRowsN", rows)
          .f("uPoint", settings.pointSize)
          .f("uFocus", settings.focus ?? 8)
          .f("uBlur", settings.blur ?? 0)
          .f("uPx", frame.px)
          .f("uMaxPoint", frame.maxPoint)
          .f("uLevel", audio.level);
        gl.drawArrays(gl.POINTS, 0, columns * rows);
      }
      gl.disable(gl.BLEND);
    },
    dispose(): void {
      history.dispose();
    }
  };
}
