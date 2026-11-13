import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyConversions } from "./shader-glsl-types.mjs";
import { cleanSource, esIdentifiers, rewriteDeclarations, twoDimensional } from "./shader-glsl.mjs";
import {
  buildCatalog, buildMusicVisualizer, buildVolts, bylineAuthors, geometryToVertex, geometryTriangles, missingTextures,
  parseConf, parseLooseJson, parseUniforms, prettyName
} from "./shader-visualizers.mjs";

// Everything below is made up for the tests; none of it is the vendored content.

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "shader-visualizers-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const converted = (body) => applyConversions(`#version 300 es\nprecision highp float;\n${body}`).code;

test("a .conf reads as Monkey Hi Hat reads it: sections, keys in lowercase, # comments, numbered lines", () => {
  const conf = parseConf("# heading\n[Shader]\nDescription=Fire! #'\nFragmentShaderFilename=a.frag\n\n[audiotextures]\neyecandyShadertoy\n[fx-blacklist]\nboxed\nsparkle # too much\n");
  assert.equal(conf.value("shader", "description"), "Fire!");
  assert.equal(conf.value("shader", "fragmentshaderfilename"), "a.frag");
  assert.deepEqual(conf.list("audiotextures"), ["eyecandyShadertoy"]);
  assert.deepEqual(conf.list("fx-blacklist"), ["boxed", "sparkle"]);
  assert.equal(conf.value("shader", "missing", "*"), "*");
});

test("uniforms are numbers or ranges drawn from at start", () => {
  assert.deepEqual(parseUniforms(new Map([["a", "0.5"], ["b", "2:0.1"], ["c", "x"]])), { a: 0.5, b: [0.1, 2], c: 0 });
});

test("names and credits come from the files", () => {
  assert.equal(prettyName("apollonian_twist"), "Apollonian Twist");
  assert.equal(prettyName("fft_and_wave"), "FFT And Wave");
  assert.deepEqual(bylineAuthors("Original by Shane and aiekick @Shadertoy"), ["Shane", "aiekick"]);
  assert.deepEqual(bylineAuthors("Adapted from Renard_VRC @X by Elsio @Shadertoy"), ["Renard_VRC", "Elsio"]);
  assert.deepEqual(bylineAuthors("Author unknown"), []);
});

test("integers become floats where desktop GLSL would convert them, and nowhere else", () => {
  const code = converted([
    "uniform float level;",
    "uniform sampler2D tex;",
    "#define SIZE textureSize(tex, 0)",
    "float f(float x) { return 0; }",
    "void main() {",
    "  float a = 1;",
    "  float b = level * 2 + f(3);",
    "  vec2 c = gl_FragCoord.xy / SIZE;",
    "  float d = pow(a, 2) + min(a, 0) + clamp(b, 0, 1);",
    "  int i = min(3, 4);",
    "  for (float k = 0; k < 3; k++) { a += k; }",
    "  if (level == 0) a = -1;",
    "  uint u = floatBitsToUint(a) / 3u + 1u;",
    "  float back = uintBitsToFloat(u);",
    "  vec3 v = vec3(1, 2, 3) * 2;",
    "}"
  ].join("\n"));
  assert.match(code, /return 0\.0;/);
  assert.match(code, /float a = 1\.0;/);
  assert.match(code, /level \* 2\.0 \+ f\(3\.0\)/);
  assert.match(code, /gl_FragCoord\.xy \/ vec2\(SIZE\)/);
  assert.match(code, /pow\(a, 2\.0\) \+ min\(a, 0\.0\) \+ clamp\(b, 0\.0, 1\.0\)/);
  assert.match(code, /int i = min\(3, 4\);/);
  assert.match(code, /for \(float k = 0\.0; k < 3\.0; k\+\+\)/);
  assert.match(code, /if \(level == 0\.0\) a = -1\.0;/);
  assert.match(code, /uintBitsToFloat\(u\)/);
  assert.match(code, /vec3\(1, 2, 3\) \* 2\.0/);
});

test("a literal inside a function-like macro is fixed in the macro", () => {
  const code = converted("#define S(x) smoothstep(0, 1, x)\nvoid main() { float a = S(0.5); }");
  assert.match(code, /#define S\(x\) smoothstep\(0\.0, 1\.0, x\)/);
});

test("uniform initial values go to the caller; non-constant globals are set when main begins", () => {
  const { code, defaults, moved } = rewriteDeclarations(cleanSource([
    "#version 450",
    "uniform float option_mode = 1;",
    "uniform vec2 resolution;",
    "uniform float randomrun;",
    "in vec2 fragCoord;",
    "const float PI = 3.14159;",
    "float direction = step(0.5, randomrun) * 2.0 - 1.0;",
    "vec2 uv = fragCoord * resolution, still = vec2(PI);",
    "#define FOO 1",
    "void main() {",
    "  const float t = randomrun * 2.0;",
    "  const float k = PI * 2.0;",
    "}"
  ].join("\n")));
  assert.deepEqual(defaults, { option_mode: 1 });
  assert.equal(moved, 2);
  assert.match(code, /uniform float option_mode;/);
  assert.match(code, /^float direction;$/m);
  assert.match(code, /vec2 uv, still = vec2 \( PI \);/);
  assert.match(code, /\nvoid sl_initGlobals\(\);\n/);
  assert.match(code, /void main\(\) \{ sl_initGlobals\(\);/);
  assert.match(code, /direction = step \( 0\.5 , randomrun \) \* 2\.0 - 1\.0;\n  uv = fragCoord \* resolution;/);
  assert.match(code, / float t = randomrun \* 2\.0;/);
  assert.match(code, /const float k = PI \* 2\.0;/);
  assert.ok(!code.includes("#version"));
});

test("reserved double underscores are renamed; 1D textures read as N×1 2D ones", () => {
  assert.equal(esIdentifiers("float __to_srgb(float x); int v = __VERSION__;"), "float _u2_to_srgb(float x); int v = __VERSION__;");
  const code = twoDimensional("float f(sampler1D s, float x) { return texture(s, x).r + texture(iSoundL, x).r; }", ["iSoundL"]);
  assert.equal(code, "float f(sampler2D s, float x) { return sl_texture1D(s, x).r + sl_texture1D(iSoundL, x).r; }");
});

test("a geometry shader runs as an instanced vertex shader, sized by what it emits", () => {
  const geometry = [
    "layout(triangle_strip, max_vertices=24) out;",
    "out float shade;",
    "void quad(vec2 a, vec2 b) {",
    "  shade = 1; gl_Position = vec4(a, 0., 1.); EmitVertex();",
    "  gl_Position = vec4(b, 0., 1.); EmitVertex();",
    "  gl_Position = vec4(a + b, 0., 1.); EmitVertex(); EndPrimitive();",
    "  gl_Position = vec4(a - b, 0., 1.); EmitVertex();",
    "  gl_Position = vec4(b, 0., 1.); EmitVertex();",
    "  gl_Position = vec4(-b, 0., 1.); EmitVertex(); EndPrimitive();",
    "}",
    "void main() { float t = iGeomIter / 4.; quad(vec2(t), vec2(1.)); if (t < 1.) quad(vec2(0.), vec2(t)); }"
  ].join("\n");
  assert.equal(geometryTriangles(geometry, 24), 4);
  assert.equal(geometryTriangles("layout(triangle_strip, max_vertices=12) out;\nvoid main() { for (int i = 0; i < 3; i++) EmitVertex(); }", 12), 10);
  const { code, vertices } = geometryToVertex(geometry, "");
  assert.equal(vertices, 12);
  assert.match(code, /^out float shade;$/m);
  assert.match(code, /sl_g_shade = 1\.0;/);
  assert.match(code, /#define iGeomIter \(float\(gl_InstanceID\)\)/);
  assert.match(code, /void sl_geometry\(\)/);
  assert.ok(!/EmitVertex|EndPrimitive|max_vertices/.test(code));
});

test("shader.json may have comments and trailing commas", () => {
  assert.deepEqual(parseLooseJson('{ // a comment\n "a": [1, 2,], /* b */ "c": "x // not a comment" , }'), { a: [1, 2], c: "x // not a comment" });
});

test("without the folders there is nothing to offer", () => {
  const root = fixture({});
  try {
    const result = buildCatalog({ directory: join(root, "missing"), prefix: "assets/shaders/", base: "/" });
    assert.equal(result.info, null);
    assert.equal(result.files.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multipass visualizer, an effect and a crossfade become programs with their buffers", () => {
  const frag = "#version 450\nprecision highp float;\nin vec2 fragCoord;\nuniform sampler2D input0;\nuniform sampler2D inputA;\nout vec4 fragColor;\nvoid main() { fragColor = texture(input0, fragCoord) + texture(inputA, fragCoord); }\n";
  const root = fixture({
    "volts-laboratory/shaders/feedback.conf": "[shader]\nDescription=Test\nByline=Original by Someone @Shadertoy\nVertexSourceTypeName=VertexQuad\nFragmentShaderFilename=feedback.frag\nRenderResolutionLimit=1024\n[audiotextures]\neyecandyShadertoy\n[textures]\nnoise : Shadertoy RGBA Noise Medium 256x256.png\n[multipass]\n0 A * *\n1 0 * feedback1\n[fx-blacklist]\nglow\n[fx-uniforms:glow]\nstrength = 0.5:1.0\n",
    "volts-laboratory/shaders/feedback.frag": frag,
    "volts-laboratory/shaders/feedback1.frag": frag,
    "volts-laboratory/fx/glow.conf": "[fx]\nDescription=Glow\n[multipass]\n1 0,B glow\n",
    "volts-laboratory/fx/glow.frag": frag.replace("inputA", "inputB"),
    "volts-laboratory/fx/ghost.conf": "[fx]\nRandomTextureSync=true\n[videos]\nvideo : ghost.mp4\n[multipass]\n1 0 glow\n",
    "volts-laboratory/crossfades/simple.frag": "#version 450\nprecision highp float;\nin vec2 fragCoord;\nuniform sampler2D oldBuffer;\nuniform sampler2D newBuffer;\nuniform float fadeLevel;\nout vec4 fragColor;\nvoid main() { fragColor = mix(texture(oldBuffer, fragCoord), texture(newBuffer, fragCoord), fadeLevel); }\n"
  });
  try {
    const { presets, crossfades, failed } = buildVolts(join(root, "volts-laboratory"));
    assert.deepEqual(failed, []);
    assert.equal(crossfades.length, 1);
    const viz = presets.find((preset) => preset.id === "volts/feedback");
    assert.equal(viz.group, "volts-audio");
    assert.deepEqual(viz.authors, ["Someone"]);
    assert.deepEqual(viz.blacklist, ["glow"]);
    assert.equal(viz.program.passes.length, 2);
    assert.deepEqual(viz.program.passes[0].inputs, [{ uniform: "inputA", buffer: 0, previous: true }]);
    assert.deepEqual(viz.program.passes[1].inputs, [{ uniform: "input0", buffer: 0, previous: false }]);
    assert.deepEqual(viz.program.previous, [0]);
    assert.equal(viz.program.output, 1);
    assert.equal(viz.program.limit, 1024);
    assert.deepEqual(viz.program.fxUniforms, { glow: { strength: [0.5, 1] } });
    assert.match(viz.program.passes[0].fragment, /^#version 300 es\n/);
    const fx = presets.find((preset) => preset.id === "volts-fx/glow");
    assert.equal(fx.kind, "fx");
    assert.equal(fx.program.passes[0].primary, true);
    assert.deepEqual(fx.program.passes[1].inputs, [{ uniform: "input0", buffer: 0, previous: false }, { uniform: "inputB", buffer: 1, previous: true }]);
    assert.equal(missingTextures(viz.program, {}), null);
    const ghost = presets.find((preset) => preset.id === "volts-fx/ghost").program;
    assert.equal(missingTextures(ghost, {}), "a video");
    assert.equal(missingTextures(ghost, { "ghost.mp4": "/assets/shaders/textures/0123.mp4" }), null);
    assert.equal(ghost.textureSync, true);
    const result = buildCatalog({ directory: root, prefix: "assets/shaders/", base: "/media/" });
    assert.equal(result.info.count, 3);
    assert.match(result.info.index, /^\/media\/assets\/shaders\/index-[0-9a-f]{12}\.json$/);
    const index = JSON.parse(result.files.get(result.info.index.slice("/media/".length)));
    assert.equal(index.presets.find((entry) => entry.id === "volts-fx/ghost").missing, "a video");
    assert.ok(index.crossfades);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("music_visualizer folders become buffers in their render order, the image last", () => {
  const root = fixture({
    "music_visualizer/src/shaders/scope/shader.json": '{ "shader_mode": "advanced", "buffers": { "A": { "geom_iters": 64 }, "B": {} }, "render_order": ["A", "B"], "blend": true, "audio_options": { "wave_smooth": 0.5 } }',
    "music_visualizer/src/shaders/scope/A.geom": "layout(triangle_strip, max_vertices=3) out;\nvoid main() { gl_Position = vec4(texture(iSoundR, iGeomIter / iNumGeomIters).r); EmitVertex(); EmitVertex(); EmitVertex(); }\n",
    "music_visualizer/src/shaders/scope/A.frag": "out vec4 c;\nvoid main() { c = vec4(1); }\n",
    "music_visualizer/src/shaders/scope/B.frag": "in vec2 geom_p;\nout vec4 c;\nvoid main() { c = texture(iA, geom_p) + texture(iB, geom_p) * .5; }\n",
    "music_visualizer/src/shaders/scope/image.frag": "in vec2 geom_p;\nout vec4 c;\nvoid main() { c = texture(iB, geom_p); }\n"
  });
  try {
    const { presets, failed } = buildMusicVisualizer(join(root, "music_visualizer"));
    assert.deepEqual(failed, []);
    assert.equal(presets.length, 1);
    const { program } = presets[0];
    assert.equal(program.swap, "draw");
    assert.equal(program.blend, true);
    assert.equal(program.passes.length, 3);
    assert.deepEqual(program.passes[0].geometry, { type: "instanced", mode: "Triangles", vertices: 3, instances: 64 });
    assert.deepEqual(program.passes[2].geometry, { type: "instanced", mode: "TriangleStrip", vertices: 4, instances: 1 });
    assert.equal(program.output, 2);
    assert.equal(program.mvAudio.waveSmooth, 0.5);
    assert.match(program.passes[0].vertex, /sl_texture1D\(iSoundR, iGeomIter \/ iNumGeomIters\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
