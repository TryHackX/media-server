/**
 * Daybreak's shaders in GLSL ES 3.00, for WebGL 2 where the browser has no WebGPU (lib/webgl2.ts).
 *
 * Translated from the WGSL in ../Daybreak.ts (voltviz 0.35.1, MIT, VoltViz Contributors; see
 * ../../../LICENSE-voltviz.txt), declaration for declaration and function for function, comments
 * included. What differs is GLSL's own: types written out, select() as ?:, round() as roundEven()
 * (WGSL rounds halves to even), atan2() as atan(), textureSampleLevel() as textureLod(), a uniform
 * buffer as a std140 block named B<binding>, a switch case ending in break. Each WGSL entry point
 * has its main() under #if defined(ENTRY_<name>); the vertex ones flip y, so that rows lie in
 * memory as WebGPU lays them (lib/webgl2.ts).
 */
import type { GlslModules } from '../../lib/webgl2';

const PRELUDE = /* glsl */ `
struct U {
  vec4 res;   // render w, h, aspect, world units per render px
  vec4 fres;  // field w, h, world units per field px, -
  vec4 a;     // time, phase, kick, snare
  vec4 b;     // hat, bass, mid, treble
  vec4 cam;   // world point at the frame centre (x, y), zoom, roll
  vec4 sc;    // scene id, seed, defocus, flare
  vec4 fx;    // exposure, chromatic aberration, feedback blend, light-trail ghost
  vec4 fx2;   // feedback zoom, black (inserts), grain, gate weave
  vec4 fx3;   // overlays in screen space (inserts), overlay glow (world), stars, twinkle
  vec4 fx4;   // bloom gain, fog, energy, drop
  vec4 ramp[6]; // gradient map stops: rgb, position
  vec4 ovCol; // overlay colour, primitive count
  vec4 sp[16];  // scene parameters
  vec4 spec[8]; // 32 spectrum bars 0..1
  vec4 ov[24];  // 12 overlay primitives: (type, x, y, size), (p1, p2, p3, alpha)
};
struct VSOut { vec4 pos; vec2 uv; };
#ifdef VERTEX

VSOut vs(uint i) {
  vec2 p[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  VSOut o;
  o.pos = vec4(p[i], 0.0, 1.0);
  o.uv = vec2(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}
#endif

const float TAU = 6.2831853;

mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
float h11(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// coverage of a shape with signed distance d and edge softness w (blur)
float cover(float d, float w) { return smoothstep(w, -w, d); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a; vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}
#if defined(VERTEX) && defined(ENTRY_vs)
out vec2 v_uv;
void main() {
  VSOut o = vs(uint(gl_VertexID));
  gl_Position = o.pos;
  // WebGPU's framebuffer rows run from the top: the same rows in memory here (lib/webgl2.ts)
  gl_Position.y = -gl_Position.y;
  v_uv = o.uv;
}
#endif
`;

const FIELD_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
#ifdef FRAGMENT

vec2 screenPos(vec2 uv) { return vec2((uv.x - 0.5) * 2.0 * u.res.z, (0.5 - uv.y) * 2.0); }
vec2 world(vec2 uv) { return rot2(u.cam.w) * screenPos(uv) / u.cam.z + u.cam.xy; }

float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), w.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), w.x), w.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5; vec2 q = p;
  for (int i = 0; i < 4; i++) { v += a * vnoise(q); q = rot2(0.6) * q * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
float spec(int i) { int k = clamp(i, 0, 31); return u.spec[k / 4][k % 4]; }

// Haze behind everything: dark navy with lighter, slowly drifting patches.
float fog(vec2 p) {
  float t = u.a.x * 0.025;
  float n = fbm(p * 0.85 + vec2(t, -t * 0.7) + u.sc.y * 10.0);
  return u.fx4.y * (0.25 + 2.2 * n * n * n);
}

// soft glows (out-of-focus lights): sp[first..last) = (x, y, radius, intensity)
float glows(vec2 p, int first, int last) {
  float L = 0.0;
  for (int k = first; k < last; k++) {
    vec4 b = u.sp[k];
    if (b.w <= 0.0) { continue; }
    float d = length(p - b.xy) / b.z;
    L += b.w * exp(-d * d * 2.2);
  }
  return L;
}

// A wedge of light from the origin along angle ang (half-angle hw), fading out towards len.
float wedge(vec2 q, float ang, float hw, float len, float w) {
  float r = length(q);
  float da = atan(q.y, q.x) - ang;
  da -= TAU * roundEven(da / TAU);
  if (abs(da) > 1.4) { return 0.0; }
  float d = r * sin(abs(da)) - sin(hw) * r;
  return cover(d, w + r * 0.015) * (1.0 - smoothstep(len * 0.4, len, r)) / (1.0 + r * 0.9);
}

// 0 burst: rays from a sun (lengths follow the spectrum), a folded ribbon, a moon.
float hairpin(vec2 q, float R, float tail) {
  if (q.x > 0.0) { return max(abs(abs(q.y) - R), q.x - tail); }
  return abs(length(q) - R);
}
float sceneBurst(vec2 p, float px) {
  vec2 c = u.sp[0].xy;
  vec2 q = p - c;
  float r = length(q);
  float a = atan(q.y, q.x);
  int n = int(u.sp[1].x);
  float blur = u.sc.z;
  float L = 0.0;
  for (int i = 0; i < n; i++) {
    float fi = float(i) + u.sc.y * 31.0;
    float h1 = h11(fi * 1.37 + 0.1);
    float h2 = h11(fi * 2.71 + 0.3);
    float h3 = h11(fi * 3.93 + 0.7);
    float ang = u.sp[1].y + (float(i) + (h1 - 0.5) * 0.7) * TAU / float(n);
    float da = a - ang;
    da -= TAU * roundEven(da / TAU);
    if (abs(da) > 1.0) { continue; }
    float thin = ((h2 > 0.8) ? 1.0 : 0.0); // a few hair-thin threads of light
    float hw = mix(u.sp[1].w * (0.45 + 0.9 * h3), 0.0035, thin);
    float len = u.sp[1].z * (0.5 + 0.8 * h1) * (0.55 + 0.8 * spec(i * 32 / n)) * (1.0 + 0.6 * thin);
    float d = r * sin(abs(da)) - hw * r - 0.003;
    float w = px + blur + r * 0.02;
    float along = 1.0 - smoothstep(len * 0.3, len, r);
    float fib = 0.7 + 0.3 * vnoise(vec2(da * 70.0 + fi * 5.0, r * 5.0 - u.a.y * 2.0));
    L += cover(d, w) * along * fib * mix(0.8 + 0.6 * h3, 2.0, thin) * 1.5 / (1.0 + r * 1.3);
  }
  float core = u.sp[0].z;
  L += u.sc.w * (6.0 * exp(-r * r / (core * core)) + 0.5 / (1.0 + r * r * 40.0));
  vec4 hp = u.sp[2];
  vec4 hq = u.sp[3];
  if (hq.x > 0.0) {
    vec2 qh = rot2(-hq.z) * (p - hp.xy);
    float d = hairpin(qh, hp.z, hq.y) - hp.w;
    L += hq.x * cover(d, px + blur + hq.w) * (0.75 + 0.45 * vnoise(qh * 7.0));
  }
  vec4 m = u.sp[4];
  if (m.w > 0.0) {
    vec2 qm = p - m.xy;
    float dm = length(qm) - m.z;
    float lit = smoothstep(-m.z, m.z * 0.6, dot(qm, normalize(c - m.xy)));
    L += m.w * (cover(dm, px * 1.5 + blur * 0.3) * (0.2 + 1.3 * lit) + 0.12 * exp(-max(dm, 0.0) * 30.0));
  }
  return L;
}

// 1 stars: concave stars with uneven spikes at different depths, glows, out-of-focus slabs.
float starSd(vec2 q, float size, float ra, int n, float seed) {
  float d = length(q) - size * 0.27;
  for (int j = 0; j < n; j++) {
    float h = h11(seed * 17.0 + float(j) * 3.1);
    float ang = ra + (float(j) + (h - 0.5) * 0.4) * TAU / float(n);
    vec2 dir = vec2(cos(ang), sin(ang));
    float len = size * (0.75 + 0.9 * h) * ((j == 0) ? 1.8 : 1.0);
    float t = dot(q, dir);
    if (t > 0.0) {
      // beyond the tip: the distance to the tip, so blurred spikes fade out instead of ending flat
      float perp = abs(q.x * dir.y - q.y * dir.x);
      d = min(d, ((t >= len) ? length(q - dir * len) : perp - size * 0.28 * pow(1.0 - t / len, 2.0)));
    }
  }
  return d;
}
float sceneStars(vec2 p, float px) {
  float L = glows(p, 10, 14);
  for (int k = 14; k < 16; k++) {
    vec4 s = u.sp[k];
    if (s.w <= 0.0) { continue; }
    vec2 qq = rot2(-s.z) * (p - s.xy);
    L += s.w * cover(sdBox(qq, vec2(1.6, 0.13)), 0.09 + u.sc.z);
  }
  for (int k = 0; k < 5; k++) {
    vec4 A = u.sp[k * 2];
    vec4 B = u.sp[k * 2 + 1];
    if (B.w <= 0.0) { continue; }
    vec2 q = p - A.xy;
    float d = starSd(q, A.z, A.w, int(B.x), B.y);
    L += B.w * cover(d, px + B.z + u.sc.z) * (0.8 + 0.8 * exp(-length(q) / (A.z * 0.35)));
  }
  return L;
}

// 2 ribbons: twisting bands (thin where they turn edge-on) sweeping through the frame.
float sceneRibbons(vec2 p, float px) {
  float L = glows(p, 12, 16);
  for (int i = 0; i < 4; i++) {
    vec4 A = u.sp[i * 3];
    vec4 B = u.sp[i * 3 + 1];
    vec4 C = u.sp[i * 3 + 2];
    if (C.z <= 0.0) { continue; }
    vec2 q = rot2(-C.w) * p;
    float arg = A.z * q.x + A.w;
    float yc = A.x + A.y * sin(arg);
    float slope = A.y * A.z * cos(arg);
    float dy = (q.y - yc) / sqrt(1.0 + slope * slope);
    float tw = cos(B.y * q.x + B.z);
    float th = B.x * (0.1 + 0.9 * abs(tw));
    float d = max(abs(dy) - th, max(C.x - q.x, q.x - C.y));
    float shade = 0.5 + 0.5 * abs(tw) + 0.3 * smoothstep(-th, th, dy * sign(tw));
    L += C.z * cover(d, px + B.w + u.sc.z) * shade;
  }
  return L;
}

// 3 beacon: cones of light from one bright point, a broad beam from off-frame, lens ghosts.
float sceneBeacon(vec2 p, float px) {
  vec4 ap = u.sp[0];
  vec2 q = p - ap.xy;
  float r = length(q);
  float L = 0.0;
  for (int k = 1; k < 5; k++) {
    vec4 c = u.sp[k];
    if (c.w > 0.0) { L += c.w * wedge(q, c.x, c.y, c.z, px + u.sc.z); }
  }
  vec4 bm = u.sp[5];
  vec4 bm2 = u.sp[6];
  if (bm2.y > 0.0) { L += bm2.y * wedge(p - bm.xy, bm.z, bm.w, bm2.x, px + bm2.z + u.sc.z); }
  vec2 toC = u.cam.xy - ap.xy;
  for (int g = 0; g < 4; g++) {
    float hg = h11(float(g) + u.sc.y * 3.0);
    float tg = 1.3 + float(g) * 0.45 + hg * 0.3;
    float gr = 0.03 + 0.12 * hg;
    float d = length(p - (ap.xy + toC * tg)) - gr;
    L += 0.07 * ap.z * cover(d, 0.01 + 0.25 * gr);
  }
  L += ap.z * (5.0 * exp(-r * r / (ap.w * ap.w)) + 0.4 / (1.0 + r * r * 50.0));
  return L;
}

// 4 fan: blades turning around a hub (twisted with the radius), floating discs.
float sceneFan(vec2 p, float px) {
  vec4 c = u.sp[0];
  vec2 q = p - c.xy;
  float r = length(q);
  int n = int(u.sp[1].x);
  float L = 0.0;
  float a = atan(q.y, q.x) - c.w * r;
  for (int i = 0; i < n; i++) {
    float h = h11(float(i) * 5.3 + u.sc.y * 17.0);
    float da = a - (c.z + float(i) * TAU / float(n));
    da -= TAU * roundEven(da / TAU);
    if (abs(da) > 1.4) { continue; }
    float l = u.sp[1].z * (0.6 + 0.6 * h);
    float d = r * sin(abs(da)) - sin(u.sp[1].y * (0.6 + 0.6 * h)) * r * (1.0 - 0.35 * r / l);
    L += u.sp[1].w * cover(max(d, max(r - l, 0.035 - r)), px + u.sc.z + 0.004 + r * 0.012) * (1.35 - 0.7 * r / l);
  }
  for (int k = 2; k < 6; k += 2) {
    vec4 E = u.sp[k];
    vec4 F = u.sp[k + 1];
    if (F.y <= 0.0) { continue; }
    vec2 qe = rot2(-F.x) * (p - E.xy);
    float d = (length(qe / E.zw) - 1.0) * min(E.z, E.w);
    L += F.y * cover(d, px + F.z + u.sc.z) * (0.65 + 0.5 * qe.y / E.w);
  }
  L += u.sc.w * (4.0 * exp(-r * r / 0.0016) + 0.3 / (1.0 + r * r * 60.0));
  return L;
}

// 5 nebula: slow clouds (calm passages), glows that bloom on soft kicks.
float sceneNebula(vec2 p, float px) {
  float t = u.a.y * 0.12 + u.a.x * 0.015;
  vec2 w = vec2(fbm(p * 0.8 + vec2(t, 1.3)), fbm(p * 0.8 + vec2(4.1, -t)));
  float n = fbm(p * 1.3 + w * 1.7 + u.sc.y * 7.0);
  float L = 0.08 + u.sp[1].x * pow(n, 2.6);
  for (int k = 2; k < 5; k++) {
    vec4 g = u.sp[k];
    float d = length(p - g.xy) / g.z;
    L += g.w * exp(-d * d * 2.0) * (0.4 + n);
  }
  return L;
}

// 6 horizon: a white plain under a low sun with a cross-shaped flare, a house on the horizon.
float sceneHorizon(vec2 p, float px) {
  vec4 H = u.sp[0];
  vec4 S = u.sp[1];
  float hy = H.x;
  vec2 sun = H.yz;
  float dy = p.y - hy;
  float sky = 0.1 + 0.9 * exp(-max(dy, 0.0) * 3.0) * (0.6 + 0.4 * exp(-abs(p.x - sun.x) * 1.5));
  float z = 0.35 / max(-dy, 0.004);
  float stripe = 0.5 + 0.5 * sin(z * 2.2 - S.y);
  float track = abs(abs((p.x - sun.x * 0.6) * z) - 0.9);
  float ground = (0.55 + 0.9 * exp(dy * 2.5)) * (0.75 + 0.25 * stripe * smoothstep(40.0, 4.0, z));
  ground *= 1.0 - 0.4 * cover(track - 0.05, 0.03 + px * z) * smoothstep(60.0, 8.0, z);
  float L = mix(sky, ground, cover(dy, px + u.sc.z * 0.5));
  float ds = length(p - sun);
  L += S.x * (5.0 * exp(-ds * ds / (H.w * H.w)) + 0.6 / (1.0 + ds * ds * 25.0));
  L += S.x * (0.9 * exp(-abs(p.y - sun.y) * 90.0) * exp(-abs(p.x - sun.x) * 1.0)
            + 0.7 * exp(-abs(p.x - sun.x) * 110.0) * exp(-abs(p.y - sun.y) * 2.2));
  // the house: a dark silhouette with one lit window
  vec2 hq = (p - vec2(S.z, hy)) / S.w;
  float body = sdBox(hq - vec2(0.0, 0.5), vec2(0.6, 0.5));
  float roof = max((hq.y - 1.6 + 0.8 * abs(hq.x)) * 0.78, 1.0 - hq.y);
  L = mix(L, 0.04, 0.95 * cover(min(body, roof) * S.w, px));
  L += 2.5 * cover(sdBox(hq - vec2(0.18, 0.45), vec2(0.13, 0.13)) * S.w, px);
  return L;
}

vec4 fs(VSOut i) {
  vec2 p = world(i.uv);
  float px = u.fres.z / u.cam.z;
  float L = fog(p);
  switch (int(u.sc.x)) {
    case 0: { L += sceneBurst(p, px); break; }
    case 1: { L += sceneStars(p, px); break; }
    case 2: { L += sceneRibbons(p, px); break; }
    case 3: { L += sceneBeacon(p, px); break; }
    case 4: { L += sceneFan(p, px); break; }
    case 5: { L += sceneNebula(p, px); break; }
    case 6: { L = sceneHorizon(p, px) + L * 0.3; break; }
    default: { break;}
  }
  return vec4(L, 0.0, 0.0, 1.0);
}
#endif
#if defined(FRAGMENT) && defined(ENTRY_fs)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fs(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

const FEEDBACK_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
// (binding 1: sampler samp, applied to the textures of the group)
uniform highp sampler2D cur;
uniform highp sampler2D prev;
#ifdef FRAGMENT

vec4 fs(VSOut i) {
  float s = textureLod(cur, i.uv, 0.0).r;
  float pr = textureLod(prev, (i.uv - 0.5) * u.fx2.x + 0.5, 0.0).r;
  return vec4(max(mix(s, pr, u.fx.z), min(pr, 3.0) * u.fx.w), 0.0, 0.0, 1.0);
}
#endif
#if defined(FRAGMENT) && defined(ENTRY_fs)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fs(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

const BLOOM_GLSL = PRELUDE + /* glsl */ `
// (binding 0: sampler samp, applied to the textures of the group)
uniform highp sampler2D src;
#ifdef FRAGMENT

float tap(vec2 uv) { return textureLod(src, uv, 0.0).r; }
float box4(vec2 uv) {
  vec2 px = 1.0 / vec2(uvec2(textureSize(src, 0)));
  return (tap(uv + px * vec2(-1.0, -1.0)) + tap(uv + px * vec2(1.0, -1.0))
        + tap(uv + px * vec2(-1.0, 1.0)) + tap(uv + px * vec2(1.0, 1.0))) * 0.25;
}
// soft knee: only the bright light blooms
vec4 fsDown1(VSOut i) { float c = box4(i.uv); return vec4(c * smoothstep(0.45, 2.0, c), 0.0, 0.0, 1.0); }
vec4 fsDown(VSOut i) { return vec4(box4(i.uv), 0.0, 0.0, 1.0); }
vec4 blur(vec2 uv, vec2 dir) {
  vec2 px = dir / vec2(uvec2(textureSize(src, 0))) * 1.3;
  float c = tap(uv) * 0.2270;
  c += (tap(uv + px * 1.3846) + tap(uv - px * 1.3846)) * 0.3162;
  c += (tap(uv + px * 3.2308) + tap(uv - px * 3.2308)) * 0.0703;
  return vec4(c, 0.0, 0.0, 1.0);
}
vec4 fsBlurH(VSOut i) { return blur(i.uv, vec2(1.0, 0.0)); }
vec4 fsBlurV(VSOut i) { return blur(i.uv, vec2(0.0, 1.0)); }
#endif
#if defined(FRAGMENT) && defined(ENTRY_fsDown1)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsDown1(VSOut(gl_FragCoord, v_uv)); }
#endif
#if defined(FRAGMENT) && defined(ENTRY_fsDown)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsDown(VSOut(gl_FragCoord, v_uv)); }
#endif
#if defined(FRAGMENT) && defined(ENTRY_fsBlurH)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsBlurH(VSOut(gl_FragCoord, v_uv)); }
#endif
#if defined(FRAGMENT) && defined(ENTRY_fsBlurV)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsBlurV(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

const FINAL_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
// (binding 1: sampler samp, applied to the textures of the group)
uniform highp sampler2D fieldT;
uniform highp sampler2D bloom1;
uniform highp sampler2D bloom2;
#ifdef FRAGMENT

vec2 screenPos(vec2 uv) { return vec2((uv.x - 0.5) * 2.0 * u.res.z, (0.5 - uv.y) * 2.0); }
vec2 world(vec2 uv) { return rot2(u.cam.w) * screenPos(uv) / u.cam.z + u.cam.xy; }

float light(vec2 uv) {
  return textureLod(fieldT, uv, 0.0).r
       + (textureLod(bloom1, uv, 0.0).r * 0.5
       + textureLod(bloom2, uv, 0.0).r * 0.85) * u.fx4.x;
}
float tone(float L) { return 1.0 - exp(-max(L, 0.0) * u.fx.x); }
// the gradient map: light 0..1 through the palette stops
vec3 ramp(float v) {
  vec3 c = u.ramp[0].rgb;
  for (int k = 1; k < 6; k++) { c = mix(c, u.ramp[k].rgb, smoothstep(u.ramp[k - 1].w, u.ramp[k].w, v)); }
  return c;
}

// Thin line work. Returns (core coverage, glow).
vec2 overlays(vec2 p, float px) {
  float core = 0.0;
  float glow = 0.0;
  int n = int(u.ovCol.w);
  for (int k = 0; k < n; k++) {
    vec4 A = u.ov[k * 2];
    vec4 B = u.ov[k * 2 + 1];
    vec2 q = p - A.yz;
    float s = A.w;
    float d = 1e3;
    float wmul = 1.0;
    float lit = 1.0;
    switch (int(A.x)) {
      case 1: { // arc: radius s, start angle p1, length p2, width p3
        float t = atan(q.y, q.x) - B.x;
        t -= TAU * floor(t / TAU);
        if (B.y >= TAU || t <= B.y) { d = abs(length(q) - s); }
        else {
          vec2 e0 = s * vec2(cos(B.x), sin(B.x));
          vec2 e1 = s * vec2(cos(B.x + B.y), sin(B.x + B.y));
          d = min(length(q - e0), length(q - e1));
        }
        wmul = B.z;
        break;
      }
      case 2: { // plus: size s, rotation p1
        vec2 a = abs(rot2(-B.x) * q);
        d = min(max(a.x - s, a.y), max(a.y - s, a.x));
        break;
      }
      case 3: { // arrow pointing along p1
        vec2 a = rot2(-B.x) * q;
        d = min(sdSeg(a, vec2(-s, 0.0), vec2(s, 0.0)),
            min(sdSeg(a, vec2(s, 0.0), vec2(s * 0.4, s * 0.45)), sdSeg(a, vec2(s, 0.0), vec2(s * 0.4, -s * 0.45))));
        break;
      }
      case 4: { // row of p1 squares, square p2 filled
        float spc = s * 1.75;
        float kk = clamp(roundEven(q.x / spc), 0.0, B.x - 1.0);
        float bx = sdBox(q - vec2(kk * spc, 0.0), vec2(s * 0.5));
        d = ((kk == B.y) ? bx : abs(bx));
        break;
      }
      case 5: { // four-point sparkle
        vec2 a = abs(rot2(-B.x) * q) / s;
        d = (pow(a.x, 0.6667) + pow(a.y, 0.6667) - 1.0) * s * 0.45;
        break;
      }
      case 6: { // segment to (p1, p2), width p3
        d = sdSeg(p, A.yz, B.xy);
        wmul = B.z;
        break;
      }
      case 7: { // row of p1 rings, the first p2 lit
        float spc = s * 3.4;
        float kk = clamp(roundEven(q.x / spc), 0.0, B.x - 1.0);
        d = abs(length(q - vec2(kk * spc, 0.0)) - s);
        lit = ((kk < B.y) ? 1.0 : 0.1);
        wmul = B.z;
        break;
      }
      default: { break;}
    }
    float a = B.w * lit;
    float hw = px * 0.7 * wmul;
    core += a * clamp((hw - d) / px + 0.5, 0.0, 1.0);
    glow += a * exp(-max(d - hw, 0.0) / u.fx3.y) * 0.55;
  }
  return vec2(min(core, 1.0), glow);
}

// A sparse starfield (crisp, at full resolution), twinkling, faster on hi-hats.
float stars(vec2 p, float px) {
  float g = 0.05;
  vec2 cell = floor(p / g);
  float h = hash21(cell + 3.1);
  if (h < 0.84) { return 0.0; }
  vec2 o = (vec2(hash21(cell + 7.7), hash21(cell + 1.9)) * 0.7 + 0.15) * g;
  float d = length(p - cell * g - o);
  float tw = 0.6 + 0.4 * sin(u.a.x * (1.3 + 4.0 * h) + h * 50.0) + u.fx3.w * (hash21(cell + floor(u.a.x * 20.0)) - 0.3);
  return smoothstep(px * 1.6, 0.0, d) * max(tw, 0.0) * (0.35 + 3.5 * (h - 0.84));
}

vec4 fs(VSOut i) {
  float t = u.a.x;
  vec2 uv = i.uv + vec2(0.0, u.fx2.w);
  vec2 dir = uv - 0.5;
  float ca = u.fx.y * (0.25 + dot(dir, dir) * 2.0);
  float lr = tone(light(uv + dir * ca));
  float lg = tone(light(uv));
  float lb = tone(light(uv - dir * ca));
  vec3 col = vec3(ramp(lr).r, ramp(lg).g, ramp(lb).b);

  vec2 p = world(uv);
  float px = u.res.w / u.cam.z;
  col += u.ovCol.rgb * stars(p, px) * u.fx3.z * (1.0 - smoothstep(0.2, 0.5, lg));
  col *= 1.0 - u.fx2.y; // inserts: a black frame
  vec2 ov;
  if (u.fx3.x > 0.5) { ov = overlays(screenPos(uv), u.res.w); } else { ov = overlays(p, px); }
  col += u.ovCol.rgb * (ov.x + ov.y);

  // The film gate: rounded corners, a soft dark edge, vignette.
  float asp = u.res.z;
  vec2 fq = abs(dir) * 2.0 * vec2(asp, 1.0);
  float rr = 0.12;
  float fd = length(max(fq - vec2(asp, 1.0) + rr + 0.012, vec2(0.0))) - rr;
  col *= smoothstep(0.0, -0.035, fd);
  col *= mix(0.4, 1.0, smoothstep(1.75, 0.35, length(dir * vec2(1.45, 1.85))));

  // grain (24 fps, strongest in the mid-tones) and a little dither against banding
  vec2 gs = i.pos.xy + vec2(floor(t * 24.0) * 37.0, 0.0);
  float l = dot(col, vec3(0.3, 0.55, 0.15));
  col += (hash21(gs) - 0.5) * u.fx2.z * (0.35 + 0.65 * (1.0 - abs(l * 2.0 - 1.0)));
  col += (hash21(gs + 17.0) - 0.5) / 255.0;
  return vec4(clamp(col, vec3(0.0), vec3(1.0)), 1.0);
}
#endif
#if defined(FRAGMENT) && defined(ENTRY_fs)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fs(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

export default {
  "daybreak-field": { bindings: ["B0"], code: FIELD_GLSL },
  "daybreak-feedback": { bindings: ["B0", "", "cur", "prev"], code: FEEDBACK_GLSL },
  "daybreak-bloom": { bindings: ["", "src"], code: BLOOM_GLSL },
  "daybreak-final": { bindings: ["B0", "", "fieldT", "bloom1", "bloom2"], code: FINAL_GLSL },
} satisfies GlslModules;
