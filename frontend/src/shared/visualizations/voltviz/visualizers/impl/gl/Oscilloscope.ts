/**
 * Oscilloscope's shaders in GLSL ES 3.00, for WebGL 2 where the browser has no WebGPU (lib/webgl2.ts).
 *
 * Translated from the WGSL in ../Oscilloscope.ts (voltviz 0.35.1, MIT, VoltViz Contributors; see
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
  vec4 res;  // render w, h, aspect, px per scope unit
  vec4 scr;  // screen half width, half height (clip units, x times aspect), corner radius, curvature
  vec4 gr;   // scope unit in clip units, graticule half width, half height (units), time
  vec4 ph;   // fluorescence decay, afterglow decay, afterglow weight, glass scatter
  vec4 colF; // fluorescence rgb, exposure
  vec4 colS; // afterglow rgb, bloom gain
  vec4 colG; // graticule rgb, graticule level
  vec4 fx;   // bezel reflection, readout level, grain, -
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

const BEAM_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
// binding 1, segs: array<vec4f>, two to a segment, read here as the attributes of each instance
#ifdef VERTEX
in vec4 seg0;
in vec4 seg1;
#endif

struct BOut { vec4 pos; vec2 lc; vec2 k; };
#ifdef VERTEX

BOut vsBeam(uint vi, uint ii) {
  vec4 s0 = seg0; // segs[ii * 2u]
  vec4 s1 = seg1; // segs[ii * 2u + 1u]
  vec2 a = s0.xy;
  vec2 d = s0.zw - a;
  float sig = max(s1.y, 0.7 / u.res.w); // at least 0.7 px, so thin traces stay antialiased
  float L = length(d);
  vec2 dir = vec2(1.0, 0.0);
  if (L > 1e-6) { dir = d / L; }
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = sig * 3.6;
  vec2 cs[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(0.0, -1.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  vec2 c = cs[vi];
  float along = mix(-r, L + r, c.x);
  float across = c.y * r;
  vec2 p = (a + dir * along + nrm * across) * u.gr.x;
  BOut o;
  o.pos = vec4(p.x / u.res.z, p.y, 0.0, 1.0);
  o.lc = vec2(along, across) / sig;
  o.k = vec2(L / sig, s1.x / sig);
  return o;
}
#endif
#ifdef FRAGMENT

float erf(float x) { // Abramowitz-Stegun 7.1.26
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return sign(x) * y;
}

// The spot integrated along the segment: a line's core is energy / length, a dot's peak
// energy / (sqrt(2 pi) sigma).
vec4 fsBeam(BOut v) {
  float x = v.lc.x;
  float y = v.lc.y;
  float len = v.k.x;
  float I;
  if (len < 0.02) { I = 0.39894 * exp(-0.5 * (x * x + y * y)); }
  else { I = exp(-0.5 * y * y) * 0.5 * (erf(x * 0.70711) - erf((x - len) * 0.70711)) / len; }
  return vec4(I * v.k.y, 0.0, 0.0, 1.0);
}
#endif
#if defined(VERTEX) && defined(ENTRY_vsBeam)
out vec2 v_lc;
out vec2 v_k;
void main() {
  BOut o = vsBeam(uint(gl_VertexID), uint(gl_InstanceID));
  gl_Position = o.pos;
  // WebGPU's framebuffer rows run from the top: the same rows in memory here (lib/webgl2.ts)
  gl_Position.y = -gl_Position.y;
  v_lc = o.lc;
  v_k = o.k;
}
#endif
#if defined(FRAGMENT) && defined(ENTRY_fsBeam)
in vec2 v_lc;
in vec2 v_k;
layout(location = 0) out vec4 o_color;
void main() { o_color = fsBeam(BOut(gl_FragCoord, v_lc, v_k)); }
#endif
`;

const PHOSPHOR_GLSL = PRELUDE + /* glsl */ `
layout(std140) uniform B0 { U u; };
uniform highp sampler2D beam;
uniform highp sampler2D prev;
#ifdef FRAGMENT

vec4 fs(VSOut i) {
  ivec2 ip = ivec2(i.pos.xy);
  float b = texelFetch(beam, ip, 0).r;
  vec2 p = texelFetch(prev, ip, 0).rg;
  float f = p.x * u.ph.x + b * (1.0 - u.ph.x);
  float s = min(p.y * u.ph.y + b * (1.0 - u.ph.y), 60.0);
  return vec4(f, s, 0.0, 1.0);
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

vec2 tap(vec2 uv) { return textureLod(src, uv, 0.0).rg; }
vec2 box4(vec2 uv) {
  vec2 px = 1.0 / vec2(uvec2(textureSize(src, 0)));
  return (tap(uv + px * vec2(-1.0, -1.0)) + tap(uv + px * vec2(1.0, -1.0))
        + tap(uv + px * vec2(-1.0, 1.0)) + tap(uv + px * vec2(1.0, 1.0))) * 0.25;
}
vec4 fsDown(VSOut i) { return vec4(box4(i.uv), 0.0, 1.0); }
vec4 blur(vec2 uv, vec2 dir) {
  vec2 px = dir / vec2(uvec2(textureSize(src, 0))) * 1.4;
  vec2 c = tap(uv) * 0.2270;
  c += (tap(uv + px * 1.3846) + tap(uv - px * 1.3846)) * 0.3162;
  c += (tap(uv + px * 3.2308) + tap(uv - px * 3.2308)) * 0.0703;
  return vec4(c, 0.0, 1.0);
}
vec4 fsBlurH(VSOut i) { return blur(i.uv, vec2(1.0, 0.0)); }
vec4 fsBlurV(VSOut i) { return blur(i.uv, vec2(0.0, 1.0)); }
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
uniform highp sampler2D acc;
uniform highp sampler2D bloom1;
uniform highp sampler2D bloom2;
uniform highp sampler2D hud;
#ifdef FRAGMENT

// clip position (x times aspect) -> texture uv
vec2 toUv(vec2 c) { return vec2(c.x / u.res.z * 0.5 + 0.5, 0.5 - c.y * 0.5); }
vec2 glow(vec2 uv) {
  return textureLod(bloom1, uv, 0.0).rg * 0.55 + textureLod(bloom2, uv, 0.0).rg * 0.9;
}
float rrect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
float lineCov(float d, float hw, float px) { return 1.0 - smoothstep(hw - px * 0.5, hw + px * 0.5, d); }

// The graticule in scope units (one division = 0.25): a frame, division lines, and the centre
// axes with minor ticks. px = one pixel in units.
float graticule(vec2 g, float px) {
  vec2 ext = u.gr.yz;
  vec2 e = abs(g) - ext;
  if (e.x > px * 2.0 || e.y > px * 2.0) { return 0.0; }
  float hw = px * 0.55;
  vec2 m = abs(fract(g / 0.25 + 0.5) - 0.5) * 0.25;
  // division lines are dotted, like an etched Tek graticule
  vec2 dots = abs(fract(g / 0.05 + 0.5) - 0.5) * 0.05;
  float L = max(lineCov(m.x, hw, px) * lineCov(dots.y, px * 1.1, px), lineCov(m.y, hw, px) * lineCov(dots.x, px * 1.1, px)) * 0.7;
  L = max(L, max(lineCov(abs(g.x), hw, px), lineCov(abs(g.y), hw, px)) * 0.75);
  float tick = 0.022;
  vec2 t = abs(fract(g / 0.05 + 0.5) - 0.5) * 0.05;
  if (abs(g.y) < tick) { L = max(L, lineCov(t.x, hw, px)); }
  if (abs(g.x) < tick) { L = max(L, lineCov(t.y, hw, px)); }
  L = max(L, max(lineCov(abs(e.x), hw * 1.4, px) * step(e.y, 0.0), lineCov(abs(e.y), hw * 1.4, px) * step(e.x, 0.0)));
  return L;
}

vec4 fs(VSOut i) {
  float asp = u.res.z;
  vec2 p = vec2((i.uv.x - 0.5) * 2.0 * asp, (0.5 - i.uv.y) * 2.0);
  vec2 hs = u.scr.xy;
  float pxc = 2.0 / u.res.y;
  float sd = rrect(p, hs, u.scr.z);
  vec2 n = p / hs;
  float r2 = dot(n, n) * 0.5;
  // the faceplate bulges a little: the middle of the picture is magnified
  vec2 c = p * (1.0 - u.scr.w * (1.0 - r2));
  vec2 uv = toUv(c);

  // phosphor light: the coating is grainy, which shows in the bright parts
  float grain = 0.88 + 0.24 * hash21(floor(i.pos.xy / 1.5) + 0.37);
  vec2 L = textureLod(acc, uv, 0.0).rg;
  vec2 G = glow(uv) * u.colS.w;
  float txt = textureLod(hud, uv, 0.0).r * u.fx.y;
  float fast = (L.x + G.x * 0.45) * grain + txt;
  float slow = (L.y * grain + G.y) * u.ph.z;
  vec3 col = u.colF.rgb * fast + u.colS.rgb * slow;
  // the graticule, edge-lit and lit by the glow of the trace
  float gl = graticule(c / u.gr.x, pxc / u.gr.x);
  col += u.colG.rgb * gl * (u.colG.w + 0.9 * (G.x + G.y));
  // light scattered in the glass: the whole screen glows faintly with what is on it
  col += u.colS.rgb * u.ph.w * (1.0 - 0.55 * r2);
  // the unlit faceplate
  col += vec3(0.006, 0.009, 0.008) * (1.0 - 0.5 * r2);
  col = vec3(1.0) - exp(-col * u.colF.w);
  // a soft sheen of the room on the glass
  vec2 sh = n - vec2(-0.5, 0.62);
  col += vec3(0.018, 0.02, 0.022) * exp(-dot(sh, sh) * 2.2);
  col *= mix(0.72, 1.0, smoothstep(1.15, 0.25, r2));

  // the bezel: dark plastic, lit a little from above, with the screen reflected in its lip
  vec2 q = abs(p) - hs;
  vec2 m = p;
  if (q.y > q.x) { m.y = sign(p.y) * (hs.y - (abs(p.y) - hs.y) * 2.6); }
  else { m.x = sign(p.x) * (hs.x - (abs(p.x) - hs.x) * 2.6); }
  float dist = max(sd, 0.0);
  vec2 R = glow(toUv(m)) * u.colS.w;
  vec3 bez = vec3(0.018, 0.019, 0.021) * (0.75 + 0.5 * (1.0 - i.uv.y));
  bez += (u.colF.rgb * R.x + u.colS.rgb * R.y * u.ph.z) * u.fx.x * exp(-dist / 0.022);
  bez += vec3(0.06) * exp(-abs(sd - pxc * 2.0) / (pxc * 1.2)) * (0.35 + 0.65 * (1.0 - i.uv.y));
  bez = vec3(1.0) - exp(-bez * 1.3);
  float inside = smoothstep(pxc, -pxc, sd);
  col = mix(bez, col, inside);

  // grain (camera noise) and a little dither against banding
  vec2 gs = i.pos.xy + vec2(floor(u.gr.w * 30.0) * 37.0, 0.0);
  col += (hash21(gs) - 0.5) * u.fx.z;
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
  "oscilloscope-beam": { bindings: ["B0", { instance: { stride: 32, attributes: { seg0: 0, seg1: 16 } } }], code: BEAM_GLSL },
  "oscilloscope-phosphor": { bindings: ["B0", "beam", "prev"], code: PHOSPHOR_GLSL },
  "oscilloscope-bloom": { bindings: ["", "src"], code: BLOOM_GLSL },
  "oscilloscope-final": { bindings: ["B0", "", "acc", "bloom1", "bloom2", "hud"], code: FINAL_GLSL },
} satisfies GlslModules;
