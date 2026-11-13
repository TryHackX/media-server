import { BANDS, History } from "./audio";
import type { SphereSettings } from "./catalog";
import { cameraView, HEADER, HISTORY, NOISE, RAMP, rgb, rotation } from "./gl";
import type { Pipeline } from "./pipeline";
import { additive, type Scene } from "./scene";

/**
 * Kule z kolców: a sphere pushed out by noise — fine noise for spikes, slow noise for patches —
 * as far as the music of its patch allows (each patch listens to a band of its own). Drawn as a
 * wireframe of rings and meridians, as dots, or as triangle edges; with the near side hiding the
 * far one (a solid pass into the depth buffer first), with holes cut by slow noise, or seen from
 * the centre with the spikes growing towards the camera.
 */

const MODES = { wire: 0, points: 2, facets: 3 } as const;

const VERTEX = `${HEADER}${NOISE}${HISTORY(BANDS)}${RAMP}
uniform int uRingsN, uMeridians, uMode, uColorBy;
uniform mat4 uViewProj, uModel;
uniform float uTime, uFlow, uRadius, uSpikes, uSpikeScale, uSharp, uSwell, uIdle, uLevel, uBeat, uShade;
uniform float uHoleScale, uSpot, uInside, uPointSize, uAlpha, uPx, uMaxPoint;
uniform vec3 uSpotColor;
out vec3 vColor;
out float vCut;

ivec2 cell() {
  int id = gl_VertexID;
  if (uMode == 0) return ivec2(gl_InstanceID, id % uMeridians);
  if (uMode == 1) return ivec2(id, gl_InstanceID);
  if (uMode == 3) {
    int ring = gl_InstanceID / uMeridians;
    int meridian = gl_InstanceID - ring * uMeridians;
    int edge = id >> 1;
    ivec2 from = edge == 2 ? ivec2(0, 1) : ivec2(0, 0);
    ivec2 to = edge == 0 ? ivec2(0, 1) : ivec2(1, 0);
    ivec2 o = (id & 1) == 0 ? from : to;
    return ivec2(min(ring + o.x, uRingsN - 1), (meridian + o.y) % uMeridians);
  }
  return ivec2(id / uMeridians, id % uMeridians);
}

void main() {
  ivec2 c = cell();
  float theta = (float(c.x) + 0.5) / float(uRingsN) * PI;
  float phi = float(c.y) / float(uMeridians) * TAU;
  vec3 n = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
  // Patches, each listening to a band of its own, and the fine noise of the spikes.
  // uFlow runs with the music: in silence the surface barely drifts.
  float region = noise3(n * 1.6 + vec3(0.0, uFlow * 0.09, 0.0));
  float pick = clamp(noise3(n * 1.15 + vec3(7.3, 2.1, uTime * 0.04)) * 1.4 - 0.2, 0.0, 1.0);
  float band = hist(pick * 0.85, 0.0).r;
  float fine = noise3(n * uSpikeScale + vec3(uFlow * 0.21, -uFlow * 0.13, uFlow * 0.17));
  float spike = pow(fine, uSharp);
  float drive = clamp(uIdle + band * (0.7 + 0.6 * region) * 1.25 + uBeat * 0.2, 0.0, 1.8);
  float height = spike * drive;
  float swell = (region - 0.5) * uSwell * (0.5 + uLevel);
  // A bright patch wandering over the side facing the camera (+z), however the ball turns,
  // swelling a little with the music.
  float spot = 0.0;
  if (uSpot > 0.0) {
    vec3 facing = normalize((uModel * vec4(n, 0.0)).xyz);
    vec3 toward = normalize(vec3(0.8 * sin(uTime * 0.37), 0.55 * sin(uTime * 0.23 + 1.0), 0.6 + 0.4 * cos(uTime * 0.29)));
    spot = smoothstep(0.72, 0.9, dot(facing, toward)) * uSpot;
  }
  float d = swell + uSpikes * height + spot * (0.05 + 0.1 * uLevel);
  float r = uRadius * (uInside > 0.5 ? max(0.15, 1.0 - d) : 1.0 + d);
  vec3 world = (uModel * vec4(n * r, 1.0)).xyz;
  gl_Position = uViewProj * vec4(world, 1.0);
  float tone = uColorBy == 0 ? clamp(world.y / (uRadius * 1.5) * 0.5 + 0.5, 0.0, 1.0)
    : uColorBy == 1 ? clamp(height * 1.4, 0.0, 1.0) : region;
  vec3 color = mix(ramp(tone), uSpotColor, spot);
  float light = mix(1.0 - uShade, 1.0, clamp(height * 1.6 + 0.1, 0.0, 1.0)) + spot * (1.5 + 2.0 * uLevel);
  vColor = color * light * uAlpha;
  vCut = noise3(n * uHoleScale + vec3(uTime * 0.05, 3.7, -uTime * 0.04));
  gl_PointSize = clamp(uPointSize * (1.0 + spot) * uPx * 3.5 / max(gl_Position.w, 0.3), 1.0, uMaxPoint);
}`;

const FRAGMENT = `${HEADER}
in vec3 vColor;
in float vCut;
uniform int uMode;
uniform float uHoles;
out vec4 color;
void main() {
  float a = 1.0;
  if (uHoles > 0.0) {
    a = smoothstep(uHoles, uHoles + 0.05, vCut);
    if (a <= 0.001) discard;
  }
  if (uMode == 2) {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    a *= 1.0 - r2;
  }
  color = vec4(vColor * a, 1.0);
}`;

export function createSphere(pipeline: Pipeline, settings: SphereSettings): Scene {
  const gl = pipeline.gl;
  const program = pipeline.program("sphere", VERTEX, FRAGMENT);
  const history = new History(gl, 8);
  const rings = settings.rings;
  const meridians = settings.meridians;
  const occlude = settings.occlude && !settings.inside;

  // The solid surface (for hiding the far side): two triangles per cell of the grid.
  let indices: WebGLBuffer | null = null;
  let indexCount = 0;
  let indexType: number = gl.UNSIGNED_SHORT;
  const vao = gl.createVertexArray();
  if (occlude) {
    const wide = rings * meridians > 65535;
    const list = wide ? new Uint32Array((rings - 1) * meridians * 6) : new Uint16Array((rings - 1) * meridians * 6);
    let at = 0;
    for (let ring = 0; ring < rings - 1; ring += 1) {
      for (let meridian = 0; meridian < meridians; meridian += 1) {
        const next = (meridian + 1) % meridians;
        const a = ring * meridians + meridian;
        const b = (ring + 1) * meridians + meridian;
        const c = ring * meridians + next;
        const d = (ring + 1) * meridians + next;
        list[at++] = a; list[at++] = b; list[at++] = c;
        list[at++] = c; list[at++] = b; list[at++] = d;
      }
    }
    indexCount = at;
    indexType = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindVertexArray(vao);
    indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, list, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }
  const spot = rgb(settings.spotColor ?? 0xffffff);
  /** The noise's own clock: quick with loud music, a slow drift in silence. */
  let flow = 0;

  return {
    draw(frame): void {
      history.push(frame.audio, frame.dt);
      const time = frame.time;
      flow += frame.dt * (0.2 + 1.8 * frame.audio.level);
      const model = rotation(settings.spin[0] * time, settings.spin[1] * time, settings.spin[2] * time);
      const view = cameraView(settings.camera, frame.aspect, time, frame.audio.bass, 0.02, 60);
      const audio = frame.audio;
      gl.bindVertexArray(vao);
      program.use();
      history.bind(program, 0);
      program
        .m4("uViewProj", view.viewProjection)
        .m4("uModel", model)
        .i("uRingsN", rings)
        .i("uMeridians", meridians)
        .i("uColorBy", settings.colorBy)
        .f("uTime", time)
        .f("uFlow", flow)
        .f("uRadius", settings.radius)
        .f("uSpikes", settings.spikes)
        .f("uSpikeScale", settings.spikeScale)
        .f("uSharp", settings.sharpness)
        .f("uSwell", settings.swell)
        .f("uIdle", settings.idle)
        .f("uLevel", audio.level)
        .f("uBeat", audio.beat)
        .f("uShade", settings.shade)
        .f("uHoles", settings.holes ?? 0)
        .f("uHoleScale", settings.holeScale ?? 2)
        .f("uSpot", settings.spot ?? 0)
        .f3("uSpotColor", spot[0], spot[1], spot[2])
        .f("uInside", settings.inside ? 1 : 0)
        .f("uPointSize", settings.pointSize ?? 1.5)
        .f("uAlpha", settings.alpha)
        .f("uPx", frame.px)
        .f("uMaxPoint", frame.maxPoint)
        .stops(settings.colors, (settings.hueSpeed ?? 0) * time);
      if (occlude && indices) {
        // The near side hides the far one: the solid surface, a little behind, into depth only.
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.colorMask(false, false, false, false);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2, 4);
        program.i("uMode", 4);
        gl.drawElements(gl.TRIANGLES, indexCount, indexType, 0);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
      } else {
        gl.disable(gl.DEPTH_TEST);
      }
      additive(gl);
      if (settings.mode === "wire") {
        program.i("uMode", 0);
        gl.drawArraysInstanced(gl.LINE_STRIP, 0, meridians + 1, rings);
        program.i("uMode", 1);
        gl.drawArraysInstanced(gl.LINE_STRIP, 0, rings, meridians);
      } else if (settings.mode === "points") {
        program.i("uMode", MODES.points);
        gl.drawArrays(gl.POINTS, 0, rings * meridians);
      } else {
        program.i("uMode", MODES.facets);
        gl.drawArraysInstanced(gl.LINES, 0, 6, (rings - 1) * meridians);
      }
      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
    dispose(): void {
      history.dispose();
      if (indices) gl.deleteBuffer(indices);
      gl.deleteVertexArray(vao);
    }
  };
}
