import type { ParticleSettings } from "./catalog";
import { cameraView, HEADER, NOISE, RAMP } from "./gl";
import type { Pipeline } from "./pipeline";
import { additive, type Scene } from "./scene";

/**
 * Roje cząstek: the camera flies through a swarm filling a tube around its path. Each particle is
 * where its random numbers and the distance flown put it, so nothing is kept per particle; the
 * music sets the speed (and a kick a burst of it), and speed stretches the near ones into streaks
 * pointing away from the centre. The lens and colour fringes of the finish do the rest.
 */

const VERTEX = `${HEADER}${NOISE}${RAMP}
uniform mat4 uViewProj;
uniform vec2 uResolution;
uniform int uMode;
uniform float uTravel, uTime, uDepth, uInner, uOuter, uSize, uStreak, uSpeed, uBass, uLevel, uFocal;
out vec2 vLocal;
out vec3 vColor;
float random(int i, int k) {
  return hashCell(ivec3(i, k, 4242));
}
void main() {
  int i = gl_InstanceID;
  float angle = random(i, 1) * TAU + uTime * 0.05 * (random(i, 4) - 0.5);
  // The iris crowds its particles at the inner edge, a bright ring round the dark centre.
  float spread = uMode == 0 ? pow(random(i, 2), 2.2) : sqrt(random(i, 2));
  float radius = mix(uInner, uOuter, spread) * (1.0 + uBass * 0.22);
  float z = -(fract(random(i, 3) - uTravel) * uDepth + 0.25);
  vec4 clip = uViewProj * vec4(cos(angle) * radius, sin(angle) * radius, z, 1.0);
  float grain = random(i, 5);
  // Its size on screen through the camera's lens (narrower on a phone held upright, as all is).
  float size = uSize * (0.35 + 1.3 * grain * grain) * uFocal / max(clip.w, 0.25) * uResolution.y * 0.5;
  vec2 screen = clip.xy / max(clip.w, 1e-3) * vec2(uResolution.x / uResolution.y, 1.0);
  float away = length(screen);
  vec2 dir = away > 1e-4 ? screen / away : vec2(1.0, 0.0);
  float stretch = 1.0 + uStreak * uSpeed * away * 1.5;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 offset = (dir * corner.x * stretch + vec2(-dir.y, dir.x) * corner.y) * max(size, 1.5) * 0.5;
  clip.xy += offset * 2.0 / uResolution * clip.w;
  gl_Position = clip;
  vLocal = corner;
  float appear = smoothstep(uDepth, uDepth * (uMode == 0 ? 0.88 : 0.65), -z) * smoothstep(0.25, 0.8, -z);
  float shine = uMode == 0 ? 0.55 + 0.45 * uLevel : 0.7 + 0.3 * uLevel;
  // Small ones are dim, as far-off lights are.
  vColor = ramp(random(i, 6)) * appear * shine * (0.35 + 0.65 * grain) / max(1.0, stretch * 0.6);
}`;

const FRAGMENT = `${HEADER}
in vec2 vLocal;
in vec3 vColor;
uniform int uMode;
out vec4 color;
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  float a = uMode == 0
    ? exp(-r * r * 4.0) * 1.2
    : (1.0 - smoothstep(0.78, 1.0, r)) * (0.7 + 0.5 * smoothstep(0.45, 0.92, r)) + exp(-r * r * 6.0) * 0.6;
  color = vec4(vColor * a, 1.0);
}`;

export function createParticles(pipeline: Pipeline, settings: ParticleSettings): Scene {
  const gl = pipeline.gl;
  const program = pipeline.program("particles", VERTEX, FRAGMENT);
  let travel = 0;
  let speed = settings.speed;
  return {
    draw(frame): void {
      const audio = frame.audio;
      // Faster with the music, a burst on a kick; slow drifting in silence.
      const wanted = settings.speed + settings.boost * (audio.level * 0.7 + audio.bass * 0.5) + settings.boost * 0.8 * audio.beat;
      speed += (wanted - speed) * (1 - Math.exp(-frame.dt / 0.25));
      travel = (travel + (speed * frame.dt) / settings.depth) % 1000;
      const view = cameraView(settings.camera, frame.aspect, frame.time, audio.bass);
      gl.bindVertexArray(pipeline.vao);
      gl.disable(gl.DEPTH_TEST);
      additive(gl);
      program.use()
        .m4("uViewProj", view.viewProjection)
        .f2("uResolution", frame.width, frame.height)
        .f("uFocal", view.projection[5] ?? 1)
        .i("uMode", settings.mode === "iris" ? 0 : 1)
        .f("uTravel", travel)
        .f("uTime", frame.time)
        .f("uDepth", settings.depth)
        .f("uInner", settings.radius[0])
        .f("uOuter", settings.radius[1])
        .f("uSize", settings.size)
        .f("uStreak", settings.streak)
        .f("uSpeed", Math.min(2, speed / (settings.speed + settings.boost * 0.6)))
        .f("uBass", audio.bass)
        .f("uLevel", audio.level)
        .stops(settings.colors);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, settings.count);
      gl.disable(gl.BLEND);
    },
    dispose(): void {
      /* nothing of its own: the program is shared */
    }
  };
}
