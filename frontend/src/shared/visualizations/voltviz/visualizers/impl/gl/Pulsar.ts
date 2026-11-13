/**
 * Pulsar's shaders in GLSL ES 3.00, for WebGL 2 where the browser has no WebGPU (lib/webgl2.ts).
 *
 * Translated from the WGSL in ../Pulsar.ts (voltviz 0.35.1, MIT, VoltViz Contributors; see
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
  vec4 fres;  // scene w, h, world units per scene px, -
  vec4 a;     // time, shot time, kick, snare
  vec4 b;     // hat, bass, mid, treble
  vec4 cam;   // world point at the frame centre (x, y), zoom, roll
  vec4 sc;    // shot id, seed, energy, pulse
  vec4 fx;    // exposure, bloom gain, streak gain, grain
  vec4 fx2;   // -, white flash, vignette, mirror (-1/1)
  vec4 ramp[6]; // gradient map stops: rgb, position
  vec4 sp[8];   // shot parameters
  vec4 spec[8]; // 32 spectrum bars 0..1
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

const float PI = 3.14159265;

mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
float h11(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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

const SCENE_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
#ifdef FRAGMENT

// World coordinates: y up, the frame is 2 units high; the camera pushes in, drifts and rolls.
vec2 world(vec2 uv) {
  vec2 s = vec2((uv.x - 0.5) * 2.0 * u.res.z * u.fx2.w, (0.5 - uv.y) * 2.0);
  return rot2(u.cam.w) * s / u.cam.z + u.cam.xy;
}
float fpx() { return u.fres.z / u.cam.z; }

vec2 h22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), w.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), w.x), w.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5; vec2 q = p;
  for (int i = 0; i < 5; i++) { v += a * vnoise(q); q = rot2(0.6) * q * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
// sharp creases: filaments of gas
float ridged(vec2 p) {
  float v = 0.0; float a = 0.55; vec2 q = p;
  for (int i = 0; i < 5; i++) { float n = 1.0 - abs(2.0 * vnoise(q) - 1.0); v += a * n * n; q = rot2(0.7) * q * 2.1 + vec2(3.1, 1.7); a *= 0.5; }
  return v;
}
vec2 voronoi(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float d1 = 8.0; float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float d = length(g + h22(i + g) - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2(d1, d2);
}
float specBar(int i) { int k = clamp(i, 0, 31); return u.spec[k / 4][k % 4]; }
float disc(float r, float R, float px) { return smoothstep(R + px, R - px, r); }

// Point stars: soft dots (they are photographed, not drawn), twinkling faster on hi-hats.
float starLayer(vec2 p, float cell, float dens, float seed) {
  vec2 g = p / cell;
  vec2 id = floor(g) + seed;
  float h = hash21(id);
  vec2 pos = h22(id + 3.1) * 0.8 + 0.1;
  float d = length(fract(g) - pos) * cell / fpx();
  float tw = 0.75 + 0.25 * sin(u.a.x * (0.8 + 3.0 * h) * (1.0 + 1.5 * u.b.x) + h * 50.0);
  float b = pow(hash21(id + 1.3), 2.5);
  return step(1.0 - dens, h) * b * tw * (exp(-d * d / 0.9) + 0.15 * exp(-d / 2.5) * b);
}
float starfield(vec2 p, float dens) {
  return 1.6 * starLayer(p, 0.11, min(0.9, dens * 0.18), 0.0)
       + 0.8 * starLayer(p, 0.05, min(0.9, dens * 0.22), 7.0)
       + 0.45 * starLayer(p, 0.024, min(0.9, dens * 0.26), 13.0);
}

// A beam of light from c along d: (thin core, soft sheath, distance along); it widens with the distance.
vec3 beam(vec2 p, vec2 c, vec2 d, float w0, float grow) {
  vec2 q = p - c;
  float along = dot(q, d);
  float perp = abs(q.x * d.y - q.y * d.x);
  float w = w0 + grow * abs(along) + fpx() * 0.6;
  return vec3(exp(-perp * perp / (w * w)), exp(-perp / (w * 6.0 + 0.01)), along);
}

// 0 pulsar: the white star, two thin beams through it, a soft halo, faint stars.
float shotPulsar(vec2 p) {
  vec4 P = u.sp[0]; // beam angle, star radius, beam intensity, glow
  float R = P.y;
  float r = length(p);
  float px = fpx();
  float L = 0.05 + 0.07 * fbm(p * 1.1 + vec2(u.a.x * 0.01, 4.0)) + starfield(p, 0.7);
  float x = max(r - R, 0.0);
  L += P.w * (1.1 * exp(-x / (R * 0.16)) + 0.3 * exp(-x / (R * 0.9)) + 0.13 * exp(-r / (R * 5.0)));
  vec3 b = beam(p, vec2(0.0), vec2(cos(P.x), sin(P.x)), 0.0022, 0.0028);
  float s = abs(b.z);
  float shimmer = 0.85 + 0.3 * vnoise(vec2(b.z * 9.0 - u.a.y * 6.0, 3.0));
  L += P.z * (2.2 * b.x + 0.16 * b.y) * shimmer / (1.0 + 0.2 * s) * smoothstep(R * 0.5, R * 1.2, s);
  return mix(L, 3.2 + 0.6 * (1.0 - r / R), disc(r, R, px * 1.3));
}

// 1 magnetosphere: dipole loops in planes through the magnetic axis (beaded, like the field
// lines of a simulation), cones of light streaming out along the axis, the star in the middle.
float shotMagneto(vec2 p) {
  vec3 M = u.sp[0].xyz;
  float R = u.sp[0].w;
  vec3 E1 = u.sp[1].xyz;
  vec3 E2 = u.sp[2].xyz;
  float r = length(p);
  float px = fpx();
  float L = 0.02 + 0.04 * fbm(p * 1.4 + 2.0) + 0.8 * starfield(p, 0.4);
  vec2 A = M.xy;
  float al = max(length(A), 1e-3);
  vec2 d = A / al;
  float along = dot(p, d);
  float perp = abs(p.x * d.y - p.y * d.x);
  float s = abs(along);
  float streaks = 0.68 + 0.32 * vnoise(vec2(atan(perp, s) * 70.0, sign(along) * 9.0 + u.a.x * 0.15));
  L += u.sp[2].w * exp(-pow(perp / max(s * 0.42, 1e-3), 2.0)) * smoothstep(R, R * 4.0, s) * 0.9 / (1.0 + 0.5 * s) * streaks * (0.3 + 0.7 * al);
  for (int i = 0; i < 6; i++) {
    float phi = float(i) * PI / 6.0 + u.sp[3].x;
    vec3 e = cos(phi) * E1 + sin(phi) * E2;
    vec2 E = e.xy;
    float det0 = A.x * E.y - A.y * E.x;
    float det = ((abs(det0) < 1e-3) ? 1e-3 : det0);
    float x = (p.x * E.y - p.y * E.x) / det;
    float y = (A.x * p.y - A.y * p.x) / det;
    float rr = max(length(vec2(x, y)), 1e-4);
    float s2 = y * y / (rr * rr);
    float th = atan(y, x);
    float behind = ((x * M.z + y * e.z < 0.0) ? 1.0 - disc(r, R, px) : 1.0);
    float edgeOn = smoothstep(0.04, 0.16, abs(det0));
    for (int j = 0; j < 2; j++) {
      int k = i * 2 + j;
      float Lj = R * (3.2 + 4.2 * float(j) + 2.6 * h11(float(k) * 3.7 + u.sc.y * 11.0));
      float f = rr - Lj * s2;
      float dd = abs(f) / max(fwidth(f), 1e-6);
      float bead = 0.35 + 0.9 * smoothstep(0.3, 0.9, vnoise(vec2(th * 30.0 + u.a.y * 2.5 * ((j == 0) ? 1.0 : -1.0), float(k) * 5.0)));
      float line = exp(-dd * dd / 1.6) + 0.22 * exp(-dd / 5.0);
      L += u.sp[1].w * line * bead * behind * edgeOn * (0.45 + 0.9 * specBar(k * 2 + 2));
    }
  }
  return mix(L, 2.2 + 0.4 * (1.0 - r / R), disc(r, R, px * 1.3));
}

// 2 limb: a sunrise over a dark planet: the star just behind the limb with rays and a plume,
// the thin bright atmosphere, a faintly lit surface.
float shotLimb(vec2 p) {
  vec2 C = u.sp[0].xy; float Rp = u.sp[0].z; float sa = u.sp[0].w;
  float flare = u.sp[1].x; float rays = u.sp[1].y;
  float px = fpx();
  vec2 q = p - C;
  float r = length(q);
  vec2 n = vec2(cos(sa), sin(sa));
  vec2 S = C + n * (Rp + 0.015);
  float bg = 0.04 + 0.14 * fbm(p * 0.8 + 3.0) * smoothstep(-1.2, 1.0, p.y) + 0.6 * starfield(p, 0.3);
  vec2 ds = p - S;
  float rs = length(ds);
  float sun = flare * (3.5 * exp(-rs / 0.05) + 0.9 * exp(-rs / 0.22) + 0.3 * exp(-rs / 0.8));
  float ra = atan(ds.y, ds.x);
  float spikes = 0.0;
  for (int k = 0; k < 3; k++) {
    spikes += pow(abs(cos(ra * float(3 + k * 2) + float(k) * 1.3 + u.sp[1].z)), 50.0 + 40.0 * float(k));
  }
  sun += rays * spikes * 0.4 / (1.0 + rs * 9.0);
  float pa = dot(ds, n);
  float pt = dot(ds, vec2(-n.y, n.x));
  float plume = exp(-pow(pt / (0.05 + 0.3 * max(pa, 0.0)), 2.0)) * exp(-max(pa, 0.0) / 0.8) * smoothstep(-0.05, 0.05, pa)
            * (0.7 + 0.6 * fbm(vec2(pt * 5.0, pa * 2.5 - u.a.x * 0.25)));
  float near = exp(-pow(acos(clamp(dot(q / max(r, 1e-4), n), -1.0, 1.0)), 2.0) / 0.3);
  float rimW = 0.005 + 0.012 * near;
  float rim = exp(-pow((r - Rp) / rimW, 2.0)) * (1.0 + 3.0 * near)
          + exp(-max(r - Rp, 0.0) / 0.05) * step(Rp, r) * (0.2 + 0.9 * near);
  float surf = 0.03 + 0.2 * fbm(q * 2.6 + 7.0) * (0.3 + 0.7 * exp(-(Rp - r) / 0.5)) * (0.5 + near) + 0.6 * near * exp(-(Rp - r) / 0.05);
  return mix(bg + sun + flare * plume * 1.4, surf, disc(r, Rp, px)) + rim;
}

// 3 ring: a dark hazy disc with a bright rim, a flare inside its lower edge and a jet leaving it,
// horizontal streaks of light behind.
float shotRing(vec2 p) {
  vec2 C = u.sp[0].xy; float R = u.sp[0].z; float ja = u.sp[0].w;
  float fl = u.sp[1].x;
  float px = fpx();
  vec2 q = p - C;
  float r = length(q);
  float L = 0.1 + 0.2 * fbm(p * 1.1 + vec2(u.a.x * 0.02, 5.0));
  for (int k = 0; k < 5; k++) {
    float hk = h11(float(k) * 7.3 + u.sc.y * 3.0);
    float yk = C.y - R * 0.35 + (hk - 0.5) * 1.1;
    L += 0.3 * exp(-pow((p.y - yk) / (0.012 + 0.04 * hk), 2.0)) * (0.3 + fbm(vec2(p.x * 1.4, float(k) * 4.0))) * exp(-abs(p.x - C.x) / 1.6);
  }
  vec2 F = C + vec2(0.15 * R, -0.45 * R);
  vec2 df = p - F;
  float inner = 0.08 + 0.35 * exp(-length(df) / (0.5 * R)) + 0.12 * fbm(q * 3.0);
  L = mix(L, inner, disc(r, R, px) * 0.85);
  float bottom = smoothstep(0.3, -0.9, q.y / max(r, 1e-4));
  L += exp(-pow((r - R) / 0.009, 2.0)) * (1.6 + 1.6 * bottom) + exp(-abs(r - R) / 0.06) * 0.35;
  L += fl * (4.0 * exp(-length(df) / 0.035) + 1.6 * exp(-pow(df.x / 0.5, 2.0) - pow(df.y / 0.022, 2.0)) + 0.6 * exp(-length(df) / 0.25));
  vec3 b = beam(p, F, vec2(cos(ja), sin(ja)), 0.02, 0.07);
  L += fl * (1.5 * b.x + 0.2 * b.y) * smoothstep(0.0, 0.08, b.z) / (1.0 + 0.4 * max(b.z, 0.0));
  return L;
}

// 4 eclipse: a black disc against a flare on its limb, plasma filaments swept around it.
float shotEclipse(vec2 p) {
  vec2 C = u.sp[0].xy; float R = u.sp[0].z; float fa = u.sp[0].w;
  float fl = u.sp[1].x; float fil = u.sp[1].y;
  float px = fpx();
  vec2 q = p - C;
  float r = length(q);
  vec2 F = C + vec2(cos(fa), sin(fa)) * R * 0.97;
  vec2 df = p - F;
  float dfl = length(df);
  float t = u.a.x;
  vec2 w = p + 0.3 * vec2(fbm(p * 1.2 + vec2(t * 0.04, 0.0)), fbm(p * 1.2 + vec2(4.0, -t * 0.03)));
  float filaments = pow(ridged(w * vec2(1.4, 2.2) + vec2(t * 0.05, 0.0)), 3.0) * 1.6;
  float L = 0.04 + 0.1 * fbm(p * 0.7) + filaments * fil * (0.07 + 1.5 * exp(-dfl / 0.7));
  float x = max(r - R, 0.0);
  L += step(R, r) * (0.9 * exp(-x / 0.05) + 0.3 * exp(-x / 0.35)) * (0.7 + 0.6 * fbm(vec2(atan(q.y, q.x) * 4.0, x * 3.0 - t * 0.1)));
  float inside = 0.025 + 0.06 * fbm(q * 4.0) * smoothstep(R, R * 0.4, r);
  L = mix(L, inside, disc(r, R, px));
  L += exp(-pow((r - R) / 0.007, 2.0)) * 1.2;
  // a prominence: a bright thread from the flare across the disc
  vec2 pd = vec2(-cos(fa + 0.12), -sin(fa + 0.12));
  vec3 b = beam(p, F, pd, 0.004, 0.006);
  L += fl * 1.4 * b.x * step(0.0, b.z) * exp(-max(b.z, 0.0) / (R * 0.9)) * (0.6 + 0.6 * vnoise(vec2(b.z * 18.0, t)));
  L += fl * (6.0 * exp(-dfl / 0.045) + 1.2 * exp(-dfl / 0.22) + 1.3 * exp(-pow(df.x / 0.9, 2.0) - pow(df.y / 0.02, 2.0)));
  return L;
}

// 5 wide: a distant pulsar, a broad mottled beam sweeping a dense field of stars.
float shotWide(vec2 p) {
  vec2 C = u.sp[0].xy; float ang = u.sp[0].z; float R = u.sp[0].w;
  float bi = u.sp[1].x;
  float px = fpx();
  float clusters = smoothstep(0.45, 0.75, fbm(p * 1.3 + 9.0));
  float L = 0.025 + 0.08 * fbm(p * 0.9 + 1.0) + 1.1 * starfield(p, 0.8 + 2.5 * clusters);
  vec2 d = vec2(cos(ang), sin(ang));
  vec3 b = beam(p, C, d, 0.05, 0.09);
  float mott = 0.6 + 0.6 * fbm(vec2(b.z * 2.5 - u.a.x * 0.4, dot(p - C, vec2(-d.y, d.x)) * 9.0));
  float end = 1.0 + 3.0 * smoothstep(0.4, 2.2, -b.z);
  L += bi * (0.42 * b.x * mott * end + 0.12 * b.y);
  vec3 core = beam(p, C, d, 0.004, 0.006);
  L += bi * 0.5 * core.x / (1.0 + abs(core.z));
  float r = length(p - C);
  L += 0.6 * exp(-max(r - R, 0.0) / 0.015) + 0.2 * exp(-r / 0.15);
  return mix(L, 2.6, disc(r, R, px));
}

// 6 wings: a beam and its star crossing curtains of gas that rise in a V.
float shotWings(vec2 p) {
  vec2 C = u.sp[0].xy; float ang = u.sp[0].z; float bi = u.sp[0].w;
  vec2 W = u.sp[1].xy; float gas = u.sp[1].z;
  float t = u.a.x;
  float L = 0.025 + 0.06 * fbm(p * 1.2) + 0.5 * starfield(p, 0.3);
  float h = p.y - W.y;
  float m = 0.0;
  for (int k = 0; k < 2; k++) {
    float sg = float(k) * 2.0 - 1.0;
    float cx = W.x + sg * (0.12 + 0.55 * max(h, 0.0)) + 0.08 * sin(h * 3.0 + float(k) * 2.0);
    m += exp(-pow((p.x - cx) / (0.1 + 0.22 * max(h, 0.0)), 2.0)) * smoothstep(-0.35, 0.05, h);
  }
  vec2 w = p + 0.2 * vec2(fbm(p * 1.5 + vec2(0.0, t * 0.05)), fbm(p * 1.5 + 6.0));
  float fils = pow(ridged(w * vec2(4.0, 1.3) + vec2(0.0, -t * 0.06)), 3.0);
  L += gas * m * (0.1 + 1.6 * fils);
  vec2 d = vec2(cos(ang), sin(ang));
  vec3 b = beam(p, C, d, 0.003, 0.004);
  L += bi * (1.8 * b.x + 0.25 * b.y) * (1.0 + 0.8 * smoothstep(0.0, 1.5, b.z));
  float r = length(p - C);
  return L + bi * (3.0 * exp(-r / 0.012) + 0.6 * exp(-r / 0.08));
}

// 7 cell star: an overexposed star with a cellular surface, the Milky Way behind it.
float shotCell(vec2 p) {
  vec2 S = u.sp[0].xy; float R = u.sp[0].z; float ba = u.sp[0].w;
  vec2 O = u.sp[1].xy; float glow = u.sp[1].z;
  float px = fpx();
  vec2 bd = vec2(cos(ba), sin(ba));
  float dist = abs((p.x - O.x) * bd.y - (p.y - O.y) * bd.x);
  float band = exp(-pow(dist / 0.42, 2.0));
  float clouds = fbm(p * 2.2 + 11.0);
  float dust = fbm(p * 4.5 + vec2(3.0, 1.0));
  float L = 0.02 + band * (0.06 + 0.75 * clouds * clouds) * (1.0 - 0.85 * smoothstep(0.48, 0.7, dust));
  L += 1.1 * starfield(p, 0.5 + 3.5 * band);
  vec2 q = (p - S) / R;
  float r = length(q);
  float x = max(r - 1.0, 0.0) * R;
  L += glow * (0.9 * exp(-x / 0.03) + 0.25 * exp(-x / 0.25) + 0.08 * exp(-x / 1.0));
  float z = sqrt(max(1.0 - r * r, 0.0));
  vec2 sc0 = q / (0.35 + z) * 3.2 + vec2(u.a.x * 0.03, 0.0);
  vec2 sc = sc0 + 0.18 * vec2(vnoise(sc0 * 2.5), vnoise(sc0 * 2.5 + 5.0));
  vec2 v = voronoi(sc);
  float edge = smoothstep(0.01, 0.2, v.y - v.x);
  float surf = glow * mix(0.3, 1.7, edge) * (0.8 + 0.35 * vnoise(sc * 3.0 + u.a.x * 0.2)) * (0.8 + 0.4 * (1.0 - z));
  return mix(L, surf, disc(r * R, R, px));
}

vec4 fs(VSOut i) {
  vec2 p = world(i.uv);
  float L = 0.0;
  switch (int(u.sc.x)) {
    case 1: { L = shotMagneto(p); break; }
    case 2: { L = shotLimb(p); break; }
    case 3: { L = shotRing(p); break; }
    case 4: { L = shotEclipse(p); break; }
    case 5: { L = shotWide(p); break; }
    case 6: { L = shotWings(p); break; }
    case 7: { L = shotCell(p); break; }
    default: { L = shotPulsar(p); break; }
  }
  return vec4(max(L, 0.0), 0.0, 0.0, 1.0);
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
vec4 fsDown1(VSOut i) { float c = box4(i.uv); return vec4(c * smoothstep(0.8, 2.6, c), 0.0, 0.0, 1.0); }
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
// anamorphic lens streaks: very wide horizontal blurs of the brightest light
vec4 streak(vec2 uv, float spread) {
  vec2 px = vec2(spread / float(uvec2(textureSize(src, 0)).x), 0.0);
  float c = tap(uv);
  float ws = 1.0;
  for (int k = 1; k <= 7; k++) {
    float w = exp(-float(k * k) / 16.0);
    c += (tap(uv + px * float(k)) + tap(uv - px * float(k))) * w;
    ws += 2.0 * w;
  }
  return vec4(c / ws, 0.0, 0.0, 1.0);
}
vec4 fsStreak1(VSOut i) { return streak(i.uv, 3.0); }
vec4 fsStreak2(VSOut i) { return streak(i.uv, 11.0); }
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
#if defined(FRAGMENT) && defined(ENTRY_fsStreak1)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsStreak1(VSOut(gl_FragCoord, v_uv)); }
#endif
#if defined(FRAGMENT) && defined(ENTRY_fsStreak2)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsStreak2(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

const FINAL_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
// (binding 1: sampler samp, applied to the textures of the group)
uniform highp sampler2D sceneT;
uniform highp sampler2D bloom1;
uniform highp sampler2D bloom2;
uniform highp sampler2D streakT;
#ifdef FRAGMENT

vec3 ramp(float v) {
  vec3 c = u.ramp[0].rgb;
  for (int k = 1; k < 6; k++) { c = mix(c, u.ramp[k].rgb, smoothstep(u.ramp[k - 1].w, u.ramp[k].w, v)); }
  return c;
}

vec4 fs(VSOut i) {
  vec2 sp = vec2((i.uv.x - 0.5) * 2.0 * u.res.z, (0.5 - i.uv.y) * 2.0);
  float L = textureLod(sceneT, i.uv, 0.0).r
        + u.fx.y * (textureLod(bloom1, i.uv, 0.0).r * 0.55 + textureLod(bloom2, i.uv, 0.0).r * 0.9)
        + u.fx.z * textureLod(streakT, i.uv, 0.0).r;
  float v = 1.0 - exp(-max(L, 0.0) * u.fx.x);
  v = mix(v, v * v * (3.0 - 2.0 * v), 0.4);
  v *= 1.0 - u.fx2.z * smoothstep(0.5, 1.9, length(sp * vec2(0.72, 1.0)));
  // film grain, a little coarser than a pixel, strongest in the mid tones
  float g = hash21(floor(i.uv * u.res.xy * 0.7) + fract(u.a.x * 7.13) * 917.0) - 0.5;
  v += g * u.fx.w * (0.4 + 1.8 * v * (1.0 - v));
  v += u.fx2.y;
  return vec4(ramp(clamp(v, 0.0, 1.0)), 1.0);
}
#endif
#if defined(FRAGMENT) && defined(ENTRY_fs)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fs(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

export default {
  "pulsar-scene": { bindings: ["B0"], code: SCENE_GLSL },
  "pulsar-bloom": { bindings: ["", "src"], code: BLOOM_GLSL },
  "pulsar-final": { bindings: ["B0", "", "sceneT", "bloom1", "bloom2", "streakT"], code: FINAL_GLSL },
} satisfies GlslModules;
