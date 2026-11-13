/**
 * BlobTracker's shaders in GLSL ES 3.00, for WebGL 2 where the browser has no WebGPU (lib/webgl2.ts).
 *
 * Translated from the WGSL in ../BlobTracker.ts (voltviz 0.35.1, MIT, VoltViz Contributors; see
 * ../../../LICENSE-voltviz.txt), declaration for declaration and function for function, comments
 * included. What differs is GLSL's own: types written out, select() as ?:, round() as roundEven()
 * (WGSL rounds halves to even), atan2() as atan(), textureSampleLevel() as textureLod(), a uniform
 * buffer as a std140 block named B<binding>, a switch case ending in break. Each WGSL entry point
 * has its main() under #if defined(ENTRY_<name>); the vertex ones flip y, so that rows lie in
 * memory as WebGPU lays them (lib/webgl2.ts).
 */
import type { GlslModules } from '../../lib/webgl2';

const PRELUDE = /* glsl */ `
struct Plane { vec4 c; vec4 u; vec4 v; vec4 rect; };
struct Blob { vec4 p; vec4 c; vec4 s; };
struct Ring { vec4 p; vec4 c; vec4 s; };
struct U {
  vec4 res;   // w, h, 1/w, 1/h (render px)
  vec4 time;  // time, pulse, kick, snare
  vec4 cam;   // focal, focus distance, dof, exposure
  vec4 bg;    // rgb, -
  vec4 tint;  // rgb, led mask amount
  vec4 fx;    // trail decay, warp zoom, chromatic aberration, glitch
  vec4 fx2;   // warp x, warp y, led cell (px), flash
  Plane planes[2];
  Blob blobs[8];
  Ring ring;
  vec4 duoLo; // palette grade: shadow rgb, grade amount
  vec4 duoHi; // palette grade: highlight rgb, desaturation (build-ups)
  vec4 fx3;   // drop, mirror fold, invert flash, hat shimmer
  vec4 fx4;   // colour wash rgb (premultiplied), tracking tear
  vec4 fx5;   // bloom gain, halo scale, -, -
  vec4 eq;    // equalizer: amount, baseline y, max height, half width
  vec4 eqCol; // equalizer colour, peak-cap brightness
  vec4 spec[8];  // 32 bar heights 0..1
  vec4 peaks[8]; // 32 peak caps 0..1
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

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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

const SCENE_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
// (binding 1: sampler samp, applied to the textures of the group)
uniform highp sampler2D atlas;

struct Hit { vec2 uv; float t; };
#ifdef FRAGMENT

Hit hitPlane(Plane pl, vec3 d) {
  vec3 n = cross(pl.u.xyz, pl.v.xyz);
  float dn = dot(d, n);
  float t = dot(pl.c.xyz, n) / ((abs(dn) < 1e-4) ? 1e-4 : dn);
  vec3 p = d * t - pl.c.xyz;
  vec2 l = vec2(dot(p, pl.u.xyz) / pl.u.w, dot(p, pl.v.xyz) / pl.v.w);
  Hit h;
  h.t = t;
  h.uv = pl.rect.xy + (vec2(l.x, -l.y) * 0.5 + 0.5) * pl.rect.zw;
  return h;
}

// Text on a plane with depth of field: a mip level for the blur size plus a small disc of taps.
float shadePlane(Plane pl, Hit h, float footprint) {
  if (pl.c.w <= 0.0 || h.t < 0.05) { return 0.0; }
  vec2 ts = vec2(uvec2(textureSize(atlas, 0)));
  float coc = u.cam.z * abs(h.t - u.cam.y) / max(h.t, 0.1);
  float blurUv = coc * (h.t / u.cam.x) / pl.u.w * 0.5 * pl.rect.z;
  float lod = clamp(log2(max(footprint * ts.x, blurUv * ts.x * 0.35) + 1e-4) - 0.5, 0.0, 6.5);
  vec2 lo = pl.rect.xy + 0.5 / ts;
  vec2 hi = pl.rect.xy + pl.rect.zw - 0.5 / ts;
  float a = 0.0;
  for (int k = 0; k < 8; k++) {
    float ang = float(k) * 2.39996;
    float r = sqrt((float(k) + 0.5) / 8.0);
    vec2 o = vec2(cos(ang), sin(ang) * ts.x / ts.y) * r * blurUv;
    a += textureLod(atlas, clamp(h.uv + o, lo, hi), lod).r;
  }
  return a / 8.0 * pl.c.w;
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Blobs (rounded squares / circles with a hot core and a halo) and the outline shape.
vec3 shapes(vec2 sp) {
  vec3 col = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    Blob b = u.blobs[k];
    if (b.c.w <= 0.0) { continue; }
    float cs = cos(b.s.z);
    float sn = sin(b.s.z);
    vec2 q = sp - b.p.xy;
    q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y) / b.p.zw;
    float rr = b.s.x;
    float dd = length(max(abs(q) - vec2(1.0 - rr), vec2(0.0))) - rr;
    float hard = b.s.y;
    float core = 1.0 - smoothstep(-mix(0.9, 0.04, hard), 0.03, dd);
    float halo = exp(-max(dd, 0.0) * mix(3.0, 8.0, hard) / u.fx5.y);
    vec3 c = mix(b.c.rgb, vec3(1.0), core * 0.65);
    col += c * (core * 2.4 + halo * 0.32) * b.c.w;
  }
  Ring rg = u.ring;
  if (rg.c.w > 0.0) {
    float rd = sdRoundBox(sp - rg.p.xy, rg.p.zw, rg.s.x);
    float line = exp(-pow(abs(rd) / rg.s.y, 2.0));
    float glow = exp(-abs(rd) / (rg.s.y * 9.0));
    col += rg.c.rgb * (line * 1.6 + glow * 0.22) * rg.c.w;
  }
  return col;
}

vec4 fs(VSOut i) {
  vec2 res = u.res.xy;
  vec2 sp = (i.pos.xy - 0.5 * res) / res.y * vec2(2.0, -2.0);
  vec3 d = normalize(vec3(sp, -u.cam.x));

  Hit h0 = hitPlane(u.planes[0], d);
  Hit h1 = hitPlane(u.planes[1], d);
  float f0 = length(fwidth(h0.uv));
  float f1 = length(fwidth(h1.uv));

  // Background: the scene colour, a soft falloff to the corners.
  vec3 col = u.bg.rgb * (1.15 - 0.45 * length(sp * vec2(0.6, 0.9)));

  // Far plane first (dimmer, usually out of focus), then the main one.
  col += vec3(1.0) * shadePlane(u.planes[1], h1, f1) * 1.6;
  col += vec3(1.0) * shadePlane(u.planes[0], h0, f0) * 1.7;

  // Shapes; in drops they fold onto their mirror image (the type is left alone, so it reads).
  vec3 sh = shapes(sp);
  if (u.fx3.y > 0.0) { sh = max(sh, shapes(vec2(-sp.x, sp.y)) * u.fx3.y); }
  col += sh;

  // LED equalizer: 32 segmented bars with a dim reflection and slowly falling peak caps.
  if (u.eq.x > 0.0) {
    float hw = u.eq.w;
    float fx = (sp.x + hw) / (2.0 * hw) * 32.0;
    if (fx >= 0.0 && fx < 32.0) {
      uint bi = uint(fx);
      float fr = fract(fx);
      float hgt = u.spec[bi / 4u][bi % 4u] * u.eq.z;
      float pk = u.peaks[bi / 4u][bi % 4u] * u.eq.z;
      float y = sp.y - u.eq.y;
      float segH = u.eq.z / 24.0;
      float seg = fract(y / segH);
      float colMask = smoothstep(0.08, 0.16, fr) * (1.0 - smoothstep(0.84, 0.92, fr));
      float segMask = smoothstep(0.1, 0.22, seg) * (1.0 - smoothstep(0.78, 0.9, seg));
      float lit = ((y >= 0.0 && y <= hgt) ? 1.0 : 0.0);
      float refl = ((y < 0.0 && -y <= hgt * 0.5) ? 0.2 * exp(y / (segH * 3.0)) : 0.0);
      float cap = ((pk > segH && abs(y - pk - segH * 0.5) < segH * 0.35) ? 1.0 : 0.0);
      float top = clamp(y / max(u.eq.z, 1e-3), 0.0, 1.0);
      vec3 c = mix(u.eqCol.rgb, vec3(1.0), top * 0.7);
      col += c * colMask * (segMask * (lit + refl) * 1.6 + cap * u.eqCol.w) * u.eq.x;
    }
  }

  return vec4(col, 1.0);
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
  vec3 s = textureLod(cur, i.uv, 0.0).rgb;
  vec2 w = (i.uv - 0.5) * u.fx.y + 0.5 + u.fx2.xy;
  vec3 p = min(textureLod(prev, w, 0.0).rgb, vec3(0.9)) * u.fx.x;
  return vec4(max(s, p), 1.0);
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
uniform highp sampler2D hud;
#ifdef FRAGMENT

vec3 tap(vec2 uv) { return textureLod(src, uv, 0.0).rgb; }

vec3 box4(vec2 uv) {
  vec2 px = 1.0 / vec2(uvec2(textureSize(src, 0)));
  return (tap(uv + px * vec2(-1.0, -1.0)) + tap(uv + px * vec2(1.0, -1.0))
        + tap(uv + px * vec2(-1.0, 1.0)) + tap(uv + px * vec2(1.0, 1.0))) * 0.25;
}

// First level: frame + HUD lines, with a soft knee so only the bright parts bloom.
vec4 fsDown1(VSOut i) {
  vec3 c = box4(i.uv) + vec3(textureLod(hud, i.uv, 0.0).r * 0.45);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec4(c * smoothstep(0.25, 1.6, l), 1.0);
}

vec4 fsDown(VSOut i) { return vec4(box4(i.uv), 1.0); }

vec4 blur(vec2 uv, vec2 dir) {
  vec2 px = dir / vec2(uvec2(textureSize(src, 0))) * 1.25;
  vec3 c = tap(uv) * 0.2270;
  c += (tap(uv + px * 1.3846) + tap(uv - px * 1.3846)) * 0.3162;
  c += (tap(uv + px * 3.2308) + tap(uv - px * 3.2308)) * 0.0703;
  return vec4(c, 1.0);
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
uniform highp sampler2D frameT;
uniform highp sampler2D hudT;
uniform highp sampler2D bloom1;
uniform highp sampler2D bloom2;
#ifdef FRAGMENT

vec3 hdr(vec2 uv) {
  return textureLod(frameT, uv, 0.0).rgb
       + (textureLod(bloom1, uv, 0.0).rgb * 0.4
       + textureLod(bloom2, uv, 0.0).rgb * 0.75) * u.fx5.x;
}

vec4 fs(VSOut i) {
  float t = u.time.x;
  vec2 uv = i.uv;

  // Glitch: on a hard snare, slices jump sideways and smear into blocks for a few frames.
  float g = u.fx.w;
  float r = hash21(vec2(floor(uv.y * 30.0), floor(t * 24.0)));
  if (r > 1.0 - 0.4 * g) {
    uv.x += (r - 0.5) * 0.1 * g;
    uv.y = mix(uv.y, (floor(uv.y * 18.0) + 0.5) / 18.0, g * 0.8);
  }

  // Tracking tear: a band rolling up the screen during build-ups.
  float band = fract(uv.y + t * 0.23);
  float inBand = smoothstep(0.0, 0.015, band) * (1.0 - smoothstep(0.04, 0.07, band)) * u.fx4.w;
  uv.x += inBand * (hash21(vec2(floor(uv.y * 240.0), floor(t * 30.0))) - 0.5) * 0.05;

  vec2 dir = uv - 0.5;
  float ca = u.fx.z * (0.35 + dot(dir, dir) * 3.0);
  vec3 col = vec3(hdr(uv + dir * ca).r, hdr(uv).g, hdr(uv - dir * ca).b);

  // Grade before the tone curve so highlights still burn out to white.
  col = 1.0 - exp(-col * u.tint.rgb * u.cam.w);

  // Palette grade (a duotone cast, like a filmed LED wall) and desaturation in build-ups.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(u.duoLo.rgb, u.duoHi.rgb, smoothstep(0.0, 1.0, luma)), u.duoLo.w);
  col = mix(col, vec3(luma), u.duoHi.w);
  col += vec3(inBand * 0.12);

  // Downbeats: a short inverted frame or a wash of the palette colour.
  col = mix(col, vec3(1.0) - col, u.fx3.z);
  col += u.fx4.rgb;

  // HUD: green = hatch that inverts what is under it, red = lines and labels (palette-tinted white).
  vec4 hud = textureLod(hudT, uv, 0.0);
  col = mix(col, vec3(1.0) - col, clamp(hud.g, 0.0, 1.0) * 0.8);
  col += hud.r * 0.95 * mix(vec3(1.0), u.duoHi.rgb, 0.3);
  col += vec3(u.fx2.w * 0.3);

  // LED wall: RGB sub-pixel columns and dark gaps between cells.
  float cell = u.fx2.z;
  vec2 local = i.pos.xy - floor(i.pos.xy / cell) * cell;
  float ph = local.x / cell;
  vec3 sub = vec3(0.5 + 0.5 * cos(6.2831853 * (ph - 0.1667)),
    0.5 + 0.5 * cos(6.2831853 * (ph - 0.5)),
    0.5 + 0.5 * cos(6.2831853 * (ph - 0.8333)));
  vec2 e = min(local, vec2(cell) - local) / cell;
  float gap = smoothstep(0.0, 0.2, min(e.x, e.y));
  vec3 mask = mix(vec3(0.42), vec3(1.0), sub) * mix(0.3, 1.0, gap) * 1.55;
  // hi-hats make single LED cells flicker
  float shimmer = 1.0 + u.fx3.w * (hash21(floor(i.pos.xy / cell) + vec2(floor(t * 30.0) * 13.0, 0.0)) - 0.5);
  col = mix(col, col * mask * shimmer, u.tint.w);

  // Camera: vignette, a slow rolling refresh band, grain.
  float vig = smoothstep(1.25, 0.25, length(dir * vec2(1.6, 1.9)));
  col *= mix(0.45, 1.0, vig);
  col *= 1.0 - 0.06 * (0.5 + 0.5 * sin(uv.y * 5.0 - t * 1.3));
  col += vec3((hash21(i.pos.xy + vec2(fract(t * 7.13) * 911.0, 0.0)) - 0.5) * 0.04);
  return vec4(clamp(col, vec3(0.0), vec3(1.0)), 1.0);
}
#endif
#if defined(FRAGMENT) && defined(ENTRY_fs)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fs(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

const MIP_GLSL = PRELUDE + /* glsl */ `
// (binding 0: sampler samp, applied to the textures of the group)
uniform highp sampler2D src;
#ifdef FRAGMENT
vec4 fs(VSOut i) { return textureLod(src, i.uv, 0.0); }
#endif
#if defined(FRAGMENT) && defined(ENTRY_fs)
in vec2 v_uv;
layout(location = 0) out vec4 o_color;
void main() { o_color = fs(VSOut(gl_FragCoord, v_uv)); }
#endif
`;

// A compute shader in WGSL; here a fragment pass whose pixel e (row by row, as wide as the
// dispatch: outputWidth) is outBuf[e] (lib/webgl2.ts).
const DETECT_GLSL = /* glsl */ `
uniform highp sampler2D src;
layout(std140) uniform B2 { uvec4 grid; }; // cols, rows, cell px, -
uniform uint outputWidth;

#if defined(COMPUTE) && defined(ENTRY_main)
layout(location = 0) out uvec4 o_value;
void main() {
  uint e = uint(gl_FragCoord.y) * outputWidth + uint(gl_FragCoord.x);
  uvec3 id = uvec3(e % grid.x, e / grid.x, 0u);
  o_value = uvec4(0u);
  if (id.x >= grid.x || id.y >= grid.y) { return; }
  uvec2 dims = uvec2(textureSize(src, 0));
  uint c = grid.z;
  float s = 0.0;
  for (uint j = 0u; j < 4u; j++) {
    for (uint i = 0u; i < 4u; i++) {
      uvec2 p = uvec2(id.x * c + (i * c) / 4u + c / 8u, id.y * c + (j * c) / 4u + c / 8u);
      s += dot(texelFetch(src, ivec2(min(p, dims - 1u)), 0).rgb, vec3(0.2126, 0.7152, 0.0722));
    }
  }
  o_value.x = uint(clamp(s / 16.0, 0.0, 60.0) * 1000.0); // outBuf[id.y * grid.x + id.x]
}
#endif
`;

export default {
  "blobtracker-scene": { bindings: ["B0", "", "atlas"], code: SCENE_GLSL },
  "blobtracker-feedback": { bindings: ["B0", "", "cur", "prev"], code: FEEDBACK_GLSL },
  "blobtracker-bloom": { bindings: ["", "src", "hud"], code: BLOOM_GLSL },
  "blobtracker-final": { bindings: ["B0", "", "frameT", "hudT", "bloom1", "bloom2"], code: FINAL_GLSL },
  "blobtracker-mip": { bindings: ["", "src"], code: MIP_GLSL },
  "blobtracker-detect": { bindings: ["src", { output: { workgroup: [8, 8] } }, "B2"], code: DETECT_GLSL },
} satisfies GlslModules;
