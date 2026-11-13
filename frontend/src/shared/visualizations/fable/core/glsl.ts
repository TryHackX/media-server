/**
 * GLSL the visualizations share, as text to put at the top of a fragment body.
 * Everything here is this project's own writing of textbook constructions (hashes, value and
 * simplex noise, cosine palettes, thin-film interference).
 */

export const MATH = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
#define saturate(x) clamp(x, 0.0, 1.0)
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sq(float x) { return x * x; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
`;

export const HASH = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec2 hash21(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
`;

export const NOISE = /* glsl */ `
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
// Simplex noise in two dimensions, -1..1.
float snoise(vec2 p) {
  const float K1 = 0.366025404, K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  float m = step(a.y, a.x);
  vec2 o = vec2(m, 1.0 - m);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hash22(i) * 2.0 - 1.0), dot(b, hash22(i + o) * 2.0 - 1.0), dot(c, hash22(i + 1.0) * 2.0 - 1.0));
  return dot(n, vec3(70.0));
}
// Simplex noise in three dimensions, -1..1.
float snoise3(vec3 p) {
  const float F3 = 0.3333333, G3 = 0.1666667;
  vec3 s = floor(p + dot(p, vec3(F3)));
  vec3 x = p - s + dot(s, vec3(G3));
  vec3 e = step(vec3(0.0), x - x.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 x1 = x - i1 + G3;
  vec3 x2 = x - i2 + 2.0 * G3;
  vec3 x3 = x - 1.0 + 3.0 * G3;
  vec4 w = max(0.6 - vec4(dot(x, x), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  w *= w; w *= w;
  vec4 d = vec4(dot(hash33(s) - 0.5, x), dot(hash33(s + i1) - 0.5, x1), dot(hash33(s + i2) - 0.5, x2), dot(hash33(s + 1.0) - 0.5, x3));
  return dot(d, w) * 52.0;
}
float fbm(vec2 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) { sum += amp * snoise(p); p = rot(0.5) * p * 2.03 + 17.7; amp *= 0.5; }
  return sum;
}
float fbm3(vec3 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 4; i++) { sum += amp * snoise3(p); p = p.yzx * 2.02 + vec3(13.1, 7.7, 3.3); amp *= 0.5; }
  return sum;
}
`;

export const COLOR = /* glsl */ `
// A cosine palette: a + b * cos(TAU * (c * t + d)).
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
// The hue turned by an angle, about the grey axis.
vec3 hueShift(vec3 color, float angle) {
  const vec3 k = vec3(0.57735);
  float c = cos(angle), s = sin(angle);
  return color * c + cross(k, color) * s + k * dot(k, color) * (1.0 - c);
}
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
// The visible spectrum as linear RGB, x = 0 (violet, 400 nm) … 1 (red, 700 nm): a bump per
// channel, and red's second one at the violet end.
vec3 spectrum(float x) {
  float r = max(0.0, 1.0 - sq(3.3 * (x - 0.72))) + 0.3 * max(0.0, 1.0 - sq(7.0 * (x - 0.1)));
  float g = max(0.0, 1.0 - sq(3.0 * (x - 0.47)));
  float b = max(0.0, 1.0 - sq(3.6 * (x - 0.2)));
  return vec3(r, g, b);
}
// Reflectance colour of a thin film: thickness in nm, cosine of the angle inside the film.
// Sixteen wavelengths summed, so high orders wash out to pastel as real films do.
vec3 thinFilm(float thickness, float cosTheta) {
  float opd = 2.0 * 1.38 * thickness * cosTheta;
  vec3 sum = vec3(0.0), norm = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float x = (float(i) + 0.5) / 16.0;
    float lambda = mix(400.0, 700.0, x);
    float refl = 0.5 - 0.5 * cos(TAU * opd / lambda);
    vec3 w = spectrum(x);
    sum += w * refl; norm += w;
  }
  return sum / norm;
}
`;

/** Bicubic (B-spline) sampling from four bilinear taps: smooth gradients from a coarse texture. */
export const BICUBIC = /* glsl */ `
vec4 bicubic(sampler2D tex, vec2 uv, vec2 size) {
  vec2 st = uv * size - 0.5;
  vec2 f = fract(st), i = floor(st);
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 0.5 + i) / size, h1 = (w3 / g1 + 1.5 + i) / size;
  return g0.y * (g0.x * texture(tex, vec2(h0.x, h0.y)) + g1.x * texture(tex, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(tex, vec2(h0.x, h1.y)) + g1.x * texture(tex, vec2(h1.x, h1.y)));
}
`;

/**
 * The music as every visualization may read it. `uSpec` is 128 × 2: row 0 the spectrum in 128
 * log-spaced bands (30 Hz – 16 kHz, 0–1, smoothed), row 1 the waveform (-1…1).
 */
export const AUDIO = /* glsl */ `
uniform float uTime, uDt, uFlow, uBass, uLowMid, uMid, uHigh, uAir, uLevel, uKick, uHat, uBeat, uBeatPhase, uBreath, uPresence;
uniform sampler2D uSpec;
float spec(float x) { return texture(uSpec, vec2(clamp(x, 0.004, 0.996), 0.25)).r; }
float wave(float x) { return texture(uSpec, vec2(clamp(x, 0.004, 0.996), 0.75)).r; }
`;

export const COMMON = MATH + HASH + NOISE + COLOR;
