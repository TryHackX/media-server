import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  beatdropWaveModes, beyondMilkdrop2, builtinSamplers, compactEel, compactGlsl, convertPreset, deferInitializers, engineVariables, FALLBACK_SHADERS,
  fitButterchurn, flatTex3D, loadTools, mendGlsl, milkdropShaderFault, writtenUniforms
} from "./milkdrop-convert.mjs";
import { buildPacks, collectTextures, findPacks, packAssets, packEngine, planChunks, sortPresets } from "./milkdrop-presets.mjs";
import { fillTexsizes, findTextures, imageSize, randomSlot, requestedTextures, samplerRoot, textureAssets } from "./milkdrop-textures.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "milkdrop-presets-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("no folder, no packs: a fresh clone builds as it did", () => {
  const root = fixture({});
  try {
    assert.deepEqual(findPacks(join(root, "missing")), []);
    assert.deepEqual(findPacks(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every folder is a pack; its folders are categories and groups", () => {
  const root = fixture({
    "Cream of the Crop/Dancer/Aurora/a.milk": "",
    "Cream of the Crop/Dancer/b.milk": "",
    "Cream of the Crop/Fractal/Deep/Deeper/c.milk": "",
    "Cream of the Crop/README.md": "",
    "presets-milkdrop-original/Milkdrop-Original/x.milk": "",
    "presets-milkdrop-original/Milkdrop-Original/y.MILK": "",
    ".git/objects/z.milk": "",
    "empty/notes.txt": ""
  });
  try {
    const packs = findPacks(root);
    assert.deepEqual(packs.map((pack) => [pack.id, pack.name]), [["cream-of-the-crop", "Cream of the Crop"], ["presets-milkdrop-original", "presets-milkdrop-original"]]);
    const cream = packs[0].presets.map(({ name, category, group, folder }) => ({ name, category, group, folder }));
    assert.deepEqual(cream, [
      { name: "a", category: "Dancer", group: "Aurora", folder: "Dancer/Aurora" },
      { name: "b", category: "Dancer", group: "", folder: "Dancer" },
      { name: "c", category: "Fractal", group: "Deep / Deeper", folder: "Fractal/Deep/Deeper" }
    ]);
    // A folder that holds everything is a wrapper, not a category.
    assert.deepEqual(packs[1].presets.map(({ name, category, folder }) => [name, category, folder]), [["x", "", ""], ["y", "", ""]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presets are listed by category, group and name, numbers counted as numbers", () => {
  const presets = [
    { name: "Mashup (155)", category: "B", group: "", folder: "B" },
    { name: "Mashup (47)", category: "B", group: "", folder: "B" },
    { name: "z", category: "A", group: "Two", folder: "A/Two" },
    { name: "y", category: "A", group: "One", folder: "A/One" }
  ];
  assert.deepEqual(sortPresets(presets).map((preset) => preset.name), ["y", "z", "Mashup (47)", "Mashup (155)"]);
});

test("chunks never mix groups and stay within their limits", () => {
  const presets = [
    ...Array.from({ length: 5 }, (_, index) => ({ name: `a${index}`, folder: "A", size: 10 })),
    ...Array.from({ length: 2 }, (_, index) => ({ name: `b${index}`, folder: "B", size: 100 }))
  ];
  const chunks = planChunks(presets, (preset) => preset.size, { maxPresets: 2, maxBytes: 150 });
  assert.deepEqual(chunks.map((chunk) => chunk.map((preset) => preset.name)), [["a0", "a1"], ["a2", "a3"], ["a4"], ["b0"], ["b1"]]);
  // One preset larger than the limit still gets a chunk of its own.
  assert.equal(planChunks([{ name: "big", folder: "", size: 999 }], (preset) => preset.size, { maxBytes: 10 }).length, 1);
});

test("a pack's index points every preset at the chunk that holds it", () => {
  const presets = [
    { name: "one", category: "Dancer", group: "Aurora", folder: "Dancer/Aurora" },
    { name: "two", category: "Dancer", group: "Aurora", folder: "Dancer/Aurora" },
    { name: "three", category: "Fractal", group: "", folder: "Fractal" },
    { name: "broken", category: "Fractal", group: "", folder: "Fractal" }
  ];
  const converted = new Map(presets.filter((preset) => preset.name !== "broken").map((preset) => [preset, { frame_eqs_eel: preset.name }]));
  const { files, indexName, count, categories } = packAssets(presets, converted, "assets/milkdrop/test/", { maxPresets: 1 });
  assert.equal(count, 3);
  assert.deepEqual(categories, [{ name: "Dancer", count: 2 }, { name: "Fractal", count: 1 }]);
  assert.match(indexName, /^assets\/milkdrop\/test\/index-[0-9a-f]{12}\.json$/);
  const index = JSON.parse(files.get(indexName));
  assert.equal(index.chunks.length, 3);
  for (const group of index.groups) {
    for (const [name, chunk] of group.presets) {
      const data = JSON.parse(files.get(`assets/milkdrop/test/${index.chunks[chunk]}`));
      assert.deepEqual(data[`${group.folder}/${name}`], { frame_eqs_eel: name });
    }
  }
  assert.ok(!files.get(indexName).includes("broken"), "a preset that failed is not listed");
});

test("equations lose comments and blank lines, and GLSL the helpers nobody calls", () => {
  assert.equal(compactEel("a = 1; // one\n\n  // nothing\nb = a*2;  "), "a = 1;\nb = a*2;");
  const glsl = [
    "vec2 m_scalar_swizzle20(float x) { return  vec2(x, x); }",
    "vec3 bvecTernary0(bvec3 c, vec3 t, vec3 f) { return t; }",
    "vec4 matrix_row0(mat4 m, int i) { return vec4( m[0][i], m[1][i], m[2][i], m[3][i] ); }",
    "vec4 main_shader_sentinel(vec2 uv) {",
    "    vec3 ret = bvecTernary0(bvec3(true), vec3(1.0), vec3(0.0));",
    "    return vec4(ret, 1.0);",
    "}"
  ].join("\n");
  const compact = compactGlsl(glsl);
  assert.doesNotMatch(compact, /m_scalar_swizzle20|matrix_row0/);
  assert.match(compact, /^vec3 bvecTernary0/m);
  assert.match(compact, /^vec3 ret = bvecTernary0/m);
});

const TRANSLATED = [
  "sampler2D sampler_clouds;",
  "vec2 hor = vec2( ((texsize).zw * vec2(1, 0)) );",
  "const float k = 2.0;",
  "vec3 tint(vec2 p) {",
  "vec2 local = vec2( p );",
  "return vec3(local, 1.0);",
  "}",
  "vec4 main_shader_sentinel(vec2 uv) {",
  "vec3 ret;",
  "(q25 = 1.0);",
  "float time = 2.0;",
  "(ret = (tint(uv) * vec3 ((rad + ang))));",
  "return vec4(ret, 1.000000);",
  "}",
  "shader_body {",
  "vec4 result = main_shader_sentinel(uv);",
  "ret = result.rgb;",
  "}"
].join("\n");

test("translated GLSL is fitted into butterchurn's template", () => {
  const glsl = fitButterchurn(TRANSLATED, "comp");
  // rad, ang, uv_orig and hue_shader live in butterchurn's main(): they are handed over.
  assert.match(glsl, /vec4 main_shader_sentinel\(vec2 uv, vec2 uv_orig, float rad, float ang, vec3 hue_shader\) \{/);
  assert.match(glsl, /main_shader_sentinel\(uv, uv_orig, rad, ang, hue_shader\);/);
  // q25 is _qg.x, a uniform: the shader writes to a copy of its own.
  assert.match(glsl, /\{\nvec4 _qg = _qg;\nhor = vec2\( \(\(texsize\)\.zw \* vec2\(1, 0\)\) \);\n\{\nvec3 ret;/);
  // The global keeps its declaration and gets its value in the function; a const stays.
  assert.match(glsl, /^vec2 hor;$/m);
  assert.match(glsl, /^const float k = 2\.0;$/m);
  assert.match(glsl, /^uniform sampler2D sampler_clouds;$/m);
  // `time` is declared by the preset, not written to: no copy, the preset's own declaration still legal.
  assert.doesNotMatch(glsl, /float time = time/);
  assert.equal(glsl.split("{").length, glsl.split("}").length);
  // The warp shader has no hue_shader.
  assert.match(fitButterchurn(TRANSLATED, "warp"), /main_shader_sentinel\(vec2 uv, vec2 uv_orig, float rad, float ang\)/);
  assert.throws(() => fitButterchurn("shader_body { ret = vec3(1.0); }", "warp"), /unexpected/);
});

test("what counts as writing to a uniform, and what does not", () => {
  assert.deepEqual(writtenUniforms("(q1 = 2.0); (q32 += 1.0);", "warp"), ["_qa", "_qh"]);
  assert.deepEqual(writtenUniforms("(texsize.zw = vec2(1.0)); (decay = 0.5);", "comp"), ["texsize"]);
  // hlslparser writes a swizzled assignment as `(name).xy =`.
  assert.deepEqual(writtenUniforms("((aspect).xy = ((texsize).zw * vec2 (3)));", "warp"), ["aspect"]);
  assert.deepEqual(writtenUniforms("float x = (q1 == 2.0) ? q10 : time; if (q2 <= bass) {}", "warp"), []);
  const { header, deferred } = deferInitializers("float a = 1.0, b, c = f(x, 2);\nvec2 d = vec2(1, 0);\nfloat e[2] = float[](fract(_qa).x, 2.0);\nfloat g, h;\n"
    + "vec4 s[2] = vec4[](vec4(-1.0, 0.0, 0, 0.25), vec4(1.0e1, 0.0, 0, 0.25));\nconst float k[2] = float[](1.0, 2.0);");
  assert.deepEqual(deferred, ["a = 1.0;", "c = f(x, 2);", "d = vec2(1, 0);", "e = float[](fract(_qa).x, 2.0);"]);
  // An array computed from a uniform keeps its size; declarations without values, arrays of
  // constants and const ones are left as they were.
  assert.equal(header, "float a, b, c;\nvec2 d;\nfloat e[2];\nfloat g, h;\nvec4 s[2] = vec4[](vec4(-1.0, 0.0, 0, 0.25), vec4(1.0e1, 0.0, 0, 0.25));\n"
    + "const float k[2] = float[](1.0, 2.0);");
});

test("GLSL ES's objections to hlslparser's output, mended", () => {
  // A function that never returns (never called: D3DX compiles only what a shader calls).
  assert.equal(mendGlsl("vec2 rsp(vec2 uv_in) {\n}\nfloat ok(float x) { return x; }\nvoid v() {\n}"),
    "vec2 rsp(vec2 uv_in) {\nreturn vec2(0);\n}\nfloat ok(float x) { return x; }\nvoid v() {\n}");
  // saturate(!x): clamp() of a bool.
  assert.equal(mendGlsl("x = (a * clamp((!bool (mask)), 0.0, 1.0));"), "x = (a * clamp(float(!bool (mask)), 0.0, 1.0));");
  // An out argument of sincos inside a conversion.
  assert.equal(mendGlsl("sincos0(rot, float (s), c);"), "sincos0(rot, s, c);");
  // A matrix row assigned to, element by element: HLSL's row i is (m[0][i], m[1][i], …) here.
  assert.equal(mendGlsl("mat2 rot;\n(matrix_row0(rot,0) = vec2(cos(a), (-sin(a))));"),
    "mat2 rot;\n{ vec2 md_row = vec2(cos(a), (-sin(a))); rot[0][0] = md_row.x; rot[1][0] = md_row.y; }");
});

test("a sampler_state texture becomes the uniform it is", () => {
  const glsl = fitButterchurn(TRANSLATED.replace("sampler2D sampler_clouds;", "sampler2D sampler_grad = sampler2D( <unknown expression> );"), "comp");
  assert.match(glsl, /^uniform sampler2D sampler_grad;$/m);
});

test("a float % compared with a number is compared as the int it became", () => {
  const glsl = fitButterchurn(TRANSLATED.replace("(q25 = 1.0);", "if (((int (n) % 3) == float (0))) { ret = vec3(1.0); }"), "warp");
  assert.match(glsl, /\(\(int \(n\) % 3\) == 0\)/);
});

let tools = null;
try {
  // The translator's parts and the patched butterchurn: the equations are compiled by the eel-wasm it ships.
  tools = loadTools();
} catch { /* hlslparser-js not installed: the conversion tests are skipped */ }

test("a global int survives the translator's clean-up, which drops every line beginning with \"in\"",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const { hlslToGlsl } = await import("./milkdrop-convert.mjs");
    const quiet = console.log;
    console.log = () => undefined;
    try {
      const glsl = await hlslToGlsl("static const int anz = 27;\nshader_body {\nret = float3(1,1,1) * anz;\n}", tools);
      // hlslparser writes it `int anz = int( 27 );`.
      assert.match(glsl, /^int anz = int\( 27 \);$/m);
      assert.doesNotMatch(glsl, /\u0001/);
    } finally {
      console.log = quiet;
    }
  });

const MILK2 = [
  "MILKDROP_PRESET_VERSION=201",
  "PSVERSION=2",
  "[preset00]",
  "fRating=4.000",
  "fDecay=0.980000",
  "zoom=1.020000",
  "shapecode_0_enabled=1",
  "shapecode_0_sides=6",
  "shape_0_per_frame1=ang = time*0.4; // spin",
  "wavecode_1_enabled=0",
  "per_frame_1=q1 = bass + mid + treb;",
  "per_frame_2=// a comment line",
  "per_pixel_1=rot = rot + 0.1*rad;",
  "warp_1=`shader_body",
  "warp_2=`{",
  "warp_3=`    ret = GetBlur1(uv)*2 - GetPixel(uv) + q1*q2*q3;",
  "warp_4=`}"
].join("\r\n");

test("a MilkDrop 2 preset becomes butterchurn's WebAssembly form, its shader translated faithfully",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const quiet = console.log;
    console.log = () => undefined;
    try {
      const preset = await convertPreset(MILK2, tools);
      assert.equal(preset.version, 2);
      // Defaults are left out (decay 0.98 is one), and so is the rating.
      assert.deepEqual(preset.baseVals, { zoom: 1.02 });
      // The equations as MilkDrop reads them, written fully bracketed for eel-wasm (milkdrop-eel.ts).
      assert.equal(preset.frame_eqs_eel, "(q1 = ((bass + mid) + treb));");
      assert.equal(preset.pixel_eqs_eel, "(rot = (rot + (0.1 * rad)));");
      assert.equal(preset.init_eqs_eel, undefined);
      assert.deepEqual(preset.shapes, [{ baseVals: { enabled: 1, sides: 6 }, frame_eqs_eel: "(ang = (time * 0.4));" }]);
      assert.equal(preset.md, undefined);
      assert.equal(preset.waves, undefined);
      assert.ok(!preset.warp.includes("&&"), preset.warp);
      assert.match(preset.warp, /shader_body \{/);
      assert.equal(preset.comp, undefined);
    } finally {
      console.log = quiet;
    }
  });

test("a preset without [preset00], or with a shader the translator cannot read, is refused",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const quiet = console.log;
    console.log = () => undefined;
    try {
      await assert.rejects(convertPreset("fDecay=0.9\n", tools), /\[preset00\]/);
      // A function nobody defines; hlslparser's own message is collected only in a worker.
      await assert.rejects(convertPreset("[preset00]\nwarp_1=`shader_body { ret = nowhere_defined(uv.x); }", tools));
    } finally {
      console.log = quiet;
    }
  });

function fakePng(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function fakeJpeg(width, height) {
  // SOI, an APP0 segment to skip, then SOF0 with the size.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

test("a texture's size comes from its file's header, whatever the format", () => {
  assert.deepEqual(imageSize(fakePng(500, 400)), { width: 500, height: 400 });
  assert.deepEqual(imageSize(fakeJpeg(1920, 1080)), { width: 1920, height: 1080 });
  const gif = Buffer.alloc(24);
  gif.write("GIF89a", 0, "latin1");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(240, 8);
  assert.deepEqual(imageSize(gif), { width: 320, height: 240 });
  const bmp = Buffer.alloc(54);
  bmp.write("BM", 0, "latin1");
  bmp.writeInt32LE(64, 18);
  bmp.writeInt32LE(-32, 22);
  assert.deepEqual(imageSize(bmp), { width: 64, height: 32 });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBPVP8X", 8, "latin1");
  webp.writeUIntLE(255, 24, 3);
  webp.writeUIntLE(127, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 256, height: 128 });
  assert.equal(imageSize(Buffer.from("not an image at all, really")), null);
});

test("textures are found by MilkDrop name, case ignored; the first of a name wins, .tga is reported", () => {
  const root = fixture({});
  try {
    for (const [path, data] of [
      ["projectm/textures/Worms.jpg", fakeJpeg(512, 512)],
      ["projectm/textures/OIbeans1.JPEG", fakeJpeg(321, 320)],
      // MilkDrop 3's Pattern_047 is a JPEG named .jfif: served as .jpg.
      ["projectm/textures/Pattern_047.jfif", fakeJpeg(64, 32)],
      ["projectm/textures/Tux.tga", Buffer.from("TGA")],
      ["zz-later/worms.png", fakePng(8, 8)],
      ["projectm/.git/objects/x.jpg", fakeJpeg(1, 1)]
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), data);
    }
    const { textures, skipped } = findTextures(root);
    assert.deepEqual(textures.map(({ key, name, extension, pool }) => [key, name, extension, pool]), [
      ["oibeans1", "OIbeans1", ".jpg", true],
      ["pattern_047", "Pattern_047", ".jpg", true],
      ["worms", "Worms", ".jpg", true]
    ]);
    assert.deepEqual(skipped.map((entry) => entry.reason).sort(), [".tga cannot be shown by a browser", "a texture named worms came first"]);
    const { files, list, bytes } = textureAssets(textures, "assets/milkdrop/textures/");
    assert.deepEqual(list.map(([key, file, width, height, pool]) => [key, /^[a-z0-9-]+-[0-9a-f]{10}\.jpg$/.test(file), width, height, pool]), [
      ["oibeans1", true, 321, 320, 1],
      ["pattern_047", true, 64, 32, 1],
      ["worms", true, 512, 512, 1]
    ]);
    assert.equal(files.size, 3);
    assert.equal(bytes, [...files.values()].reduce((total, data) => total + data.length, 0));
    assert.deepEqual(findTextures(join(root, "missing")), { textures: [], skipped: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sampler's texture is its name without MilkDrop's two-letter prefix; rand00–rand15 are random slots", () => {
  assert.equal(samplerRoot("fw_Worms"), "worms");
  assert.equal(samplerRoot("pc_sunrise"), "sunrise");
  assert.equal(samplerRoot("lichen"), "lichen");
  assert.deepEqual(randomSlot("rand03_smalltiled"), { slot: 3, prefix: "smalltiled" });
  assert.deepEqual(randomSlot("rand15"), { slot: 15, prefix: "" });
  assert.equal(randomSlot("rand16"), null);
  assert.equal(randomSlot("random"), null);
  const preset = {
    warp: "uniform sampler2D sampler_fw_worms;\nuniform sampler2D sampler_main;\nuniform sampler2D sampler_clouds2;\nshader_body {\nret = texture(sampler_fw_worms, uv).xyz;\n}",
    comp: "uniform sampler2D sampler_rand02;\nuniform sampler2D sampler_pw_noise_lq;\nuniform sampler2D sampler_unused;\nshader_body {\nret = texture(sampler_rand02, uv).xyz;\n}"
  };
  // A texture declared and never sampled asks for nothing.
  assert.deepEqual([...requestedTextures(preset)], ["worms", "rand02"]);
});

test("texsize_<name> is filled with the size of the texture it describes; random slots and noise are left alone", () => {
  const glsl = [
    "uniform sampler2D sampler_lichen;",
    "vec4 texsize_lichen;",
    "vec4 texsize_rand02;",
    "vec4 texsize_noise_lq;",
    "vec4 texsize_pic, texsize_Sky;",
    "float helper(float x) {",
    "vec4 texsize_local;",
    "return x;",
    "}",
    "shader_body {",
    "ret = texture(sampler_lichen, uv * texsize.xy * texsize_lichen.zw).xyz;",
    "}"
  ].join("\n");
  const sizes = new Map([["lichen", { width: 256, height: 256 }], ["sky", { width: 512, height: 256 }]]);
  const filled = fillTexsizes(glsl, (root) => sizes.get(root) ?? { width: 128, height: 128 });
  assert.match(filled, /^vec4 texsize_lichen = vec4\(256\.0, 256\.0, 0\.00390625, 0\.00390625\);$/m);
  assert.match(filled, /^vec4 texsize_rand02;$/m);
  assert.match(filled, /^vec4 texsize_noise_lq;$/m);
  // A name there is no texture of gets clouds2's size: that is what butterchurn draws for it.
  assert.match(filled, /^vec4 texsize_pic = vec4\(128\.0, 128\.0, 0\.0078125, 0\.0078125\);$/m);
  assert.match(filled, /^vec4 texsize_Sky = vec4\(512\.0, 256\.0, 0\.001953125, 0\.00390625\);$/m);
  assert.match(filled, /^vec4 texsize_local;$/m);
  assert.equal(fillTexsizes("shader_body { ret = vec3(1.0); }", () => null), "shader_body { ret = vec3(1.0); }");
});

test("a pack's own images are shipped only when a preset asks for them, and never drawn at random", () => {
  const root = fixture({ "presets/en-d/Episode/a.milk": "" });
  try {
    for (const [path, data] of [
      ["textures/cells.jpg", fakeJpeg(256, 256)],
      ["presets/en-d/Episode/Textures/houscat.jpg", fakeJpeg(1200, 1200)],
      ["presets/en-d/Episode/COVER.jpg", fakeJpeg(800, 800)],
      ["presets/en-d/Episode/cells.jpg", fakePng(4, 4)]
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), data);
    }
    const packs = findPacks(join(root, "presets"));
    const textures = collectTextures(join(root, "textures"), packs, new Map([["houscat", 1], ["cells", 3], ["rand00_smalltiled", 1]]), "assets/milkdrop/textures/");
    assert.deepEqual(textures.list.map(([key, , width, height, pool]) => [key, width, height, pool]), [["cells", 256, 256, 1], ["houscat", 1200, 1200, 0]]);
    assert.equal(textures.fromPacks, 1);
    assert.ok(textures.has("houscat") && textures.has("cells") && textures.has("clouds2"));
    // butterchurn-presets carries lichen; a random slot draws from the texture folder, by prefix.
    assert.ok(textures.has("lichen"));
    assert.ok(textures.has("rand01") && !textures.has("rand00_smalltiled") && !textures.has("cover"));
    assert.deepEqual(textures.sizeOf("houscat"), { width: 1200, height: 1200 });
    assert.deepEqual(textures.sizeOf("pic"), { width: 128, height: 128 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build with textures and no packs still lists the textures", async () => {
  const root = fixture({});
  try {
    mkdirSync(join(root, "textures"), { recursive: true });
    writeFileSync(join(root, "textures", "worms.jpg"), fakeJpeg(512, 512));
    const logged = [];
    const logger = { info: (text) => logged.push(text), warn: (text) => logged.push(text) };
    const { info, files } = await buildPacks({
      directory: join(root, "presets"),
      textureDirectory: join(root, "textures"),
      cacheDirectory: join(root, "cache"),
      prefix: "assets/milkdrop/",
      base: "/",
      logger
    });
    assert.deepEqual(info.packs, []);
    assert.equal(info.textures.base, "/assets/milkdrop/textures/");
    assert.deepEqual(info.textures.list.map(([key, file, width, height, pool]) => [key, file.startsWith("worms-"), width, height, pool]), [["worms", true, 512, 512, 1]]);
    assert.ok([...files.keys()].every((name) => name.startsWith("assets/milkdrop/textures/worms-")));
    assert.match(logged.join("\n"), /MilkDrop textures: 1 /);
    // Neither presets nor textures: nothing at all, as before.
    assert.deepEqual(await buildPacks({ directory: join(root, "none"), textureDirectory: join(root, "none"), cacheDirectory: join(root, "cache"), prefix: "a/", base: "/", logger }), { info: null, files: new Map() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MilkDrop's textures under a prefix butterchurn does not declare are read from butterchurn's own", () => {
  const source = "sampler sampler_fw_noise_hq;\nsampler2D sampler_pw_noisevol_hq;\nsampler sampler_pw_noise_lq;\nshader_body {\nret = tex2D(sampler_fw_noise_hq, uv).xyz + tex3D(sampler_pw_noisevol_hq, float3(uv, 0)).xyz + tex2D(sampler_cf_main, uv).xyz + tex2D(sampler_pw_noise_lq, uv).xyz;\n}";
  const fixed = builtinSamplers(source);
  assert.doesNotMatch(fixed, /sampler_fw_noise_hq|sampler_pw_noisevol_hq|sampler_cf_main/);
  assert.match(fixed, /tex2D\(sampler_noise_hq, uv\)/);
  assert.match(fixed, /tex3D\(sampler_noisevol_hq, float3\(uv, 0\)\)/);
  assert.match(fixed, /tex2D\(sampler_fc_main, uv\)/);
  // butterchurn declares pw_noise_lq itself: it stays, declaration and all.
  assert.match(fixed, /^sampler sampler_pw_noise_lq;$/m);
  assert.match(fixed, /tex2D\(sampler_pw_noise_lq, uv\)/);
  // A texture of the preset's own is not touched.
  assert.equal(builtinSamplers("sampler sampler_fw_worms;"), "sampler sampler_fw_worms;");
});

const parts = (overrides = {}) => ({ baseVals: {}, presetInit: "", perFrame: "", perVertex: "", shapes: [], waves: [], warp: "", comp: "", ...overrides });

test("only custom shapes or waves past 16 are left out: what BeatDrop and MilkDrop 3 add plays", () => {
  assert.deepEqual(beyondMilkdrop2("shapecode_3_enabled=1\nwavecode_4_enabled=0\n"), []);
  assert.deepEqual(beyondMilkdrop2("shapecode_4_enabled=1\nwavecode_15_enabled=1\n"), []);
  assert.deepEqual(beyondMilkdrop2("shapecode_16_enabled=1\nwavecode_16_enabled=0\n"), ["more than 16 custom shapes"]);
});

test("simple waveforms count the BeatDrop way in a BeatDrop pack, or from mode 9 on; MilkDrop 2's way otherwise", () => {
  assert.equal(beatdropWaveModes(parts({ baseVals: { wave_mode: 8 } })), false);
  assert.equal(beatdropWaveModes(parts({ baseVals: { wave_mode: 8 } }), "beatdrop"), true);
  assert.equal(beatdropWaveModes(parts({ baseVals: { wave_mode: 15 } })), true);
  assert.equal(beatdropWaveModes(parts({ perFrame: "wave_mode = 12;" })), true);
  assert.equal(beatdropWaveModes(parts({ perFrame: "wave_mode = 7;" })), false);
  assert.equal(beatdropWaveModes(parts({ baseVals: { wave_mode: 8 } }), "milkdrop3"), true);
  assert.equal(packEngine("beatdrop"), "beatdrop");
  assert.equal(packEngine("MilkDrop 3 presets"), "milkdrop3");
  assert.equal(packEngine("md3"), "milkdrop3");
  assert.equal(packEngine("cream-of-the-crop"), undefined);
});

test("BeatDrop's clock and mouse are the engine's when a preset reads them and never assigns them", () => {
  assert.deepEqual(engineVariables({ frame: "(rot = ((hour * 0.1) + minute));" }), ["hour", "minute"]);
  // A preset's own `second` is assigned, and stays its own.
  assert.deepEqual(engineVariables({ frame: "(second = (time * 2));\n(rot = second);" }), []);
  // The per-vertex code gets the mouse and the keys, not the clock (BeatDrop's state.cpp).
  assert.deepEqual(engineVariables({ pixel: "(zoom = (mousex + hour));" }), ["mousex"]);
  assert.deepEqual(engineVariables({ init: "(q1 = totalseconds);", frame: "(x = if(ctrllt, 1, 0));" }), ["ctrllt", "totalseconds"]);
  // MilkDrop 2's progress, read anywhere — assigned or not, MilkDrop sets it before each block.
  assert.deepEqual(engineVariables({ objects: "(a = (progress * 2));" }), ["progress"]);
  assert.deepEqual(engineVariables({ frame: "(progress = 0.5);\n(zoom = progress);" }), ["progress"]);
});

test("a shader MilkDrop cannot compile either gets its fallback shader, as in MilkDrop", () => {
  // A } left from code commented out closes shader_body before the end (MilkDrop takes the last }).
  assert.match(milkdropShaderFault("shader_body {\n//for(;;){\n ret = 1;\n}\nret = 2;\n}") ?? "", /closes shader_body/);
  assert.equal(milkdropShaderFault("float f(float x) { return x; }\nshader_body { if (a) { ret = f(1); } }"), null);
  assert.match(FALLBACK_SHADERS.comp, /ret = tex2D\(sampler_main, uv\)\.xyz;/);
  // tex3D on a 2D texture of the preset's reads it at (u, v); the noise volumes keep tex3D.
  assert.equal(flatTex3D("n = tex3D(sampler_rand00, float3(a, b, c)).b;"), "n = tex2D(sampler_rand00, (+(float3(a, b, c))).xy).b;");
  assert.equal(flatTex3D("n = tex3D(sampler_noisevol_hq, p);"), "n = tex3D(sampler_noisevol_hq, p);");
});

test("round(), tanh() and log10(), which hlslparser lacks, become functions of the shader's own",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const quiet = console.log;
    console.log = () => undefined;
    try {
      const preset = await convertPreset("[preset00]\nwarp_1=`shader_body { ret = round(GetPixel(uv) * 4) / 4 + tanh(q1) + log10(uv.x); }", tools);
      assert.match(preset.warp, /^vec3 hlsl_round\(vec3 x\) \{$/m);
      assert.match(preset.warp, /hlsl_round\(/);
      assert.match(preset.warp, /hlsl_tanh\(q1\)/);
      assert.match(preset.warp, /hlsl_log10\(/);
      // A sixth shape (BeatDrop, MilkDrop 3) is kept; a seventeenth is past what any MilkDrop reads.
      const six = await convertPreset("[preset00]\nshapecode_5_enabled=1\nshapecode_5_sides=5\nwarp_1=`shader_body { ret = 1; }", tools);
      assert.equal(six.shapes.length, 6);
      assert.deepEqual(six.shapes[5].baseVals, { enabled: 1, sides: 5 });
      await assert.rejects(convertPreset("[preset00]\nshapecode_16_enabled=1\nwarp_1=`shader_body { ret = 1; }", tools), /more than 16 custom shapes/);
    } finally {
      console.log = quiet;
    }
  });

test("a folder's SOURCE.txt keeps its textures out of plain random slots, or out of all of them", () => {
  const root = fixture({
    "classic/a.jpg": "",
    "beatdrop/SOURCE.txt": "From BeatDrop.\nrandom-pool: prefixed\n",
    "beatdrop/Chelsea1.jpg": "",
    "beatdrop/sub/Chelsea2.jpg": "",
    "named/SOURCE.txt": "random-pool: no\n",
    "named/portal1.jpg": ""
  });
  try {
    const pools = Object.fromEntries(findTextures(root).textures.map((texture) => [texture.key, texture.pool]));
    assert.deepEqual(pools, { a: true, chelsea1: "prefixed", chelsea2: "prefixed", portal1: false });
    const { list } = textureAssets(findTextures(root).textures, "t/", () => fakeJpeg(4, 4));
    assert.deepEqual(list.map((entry) => [entry[0], entry[4]]), [["chelsea1", 2], ["chelsea2", 2], ["a", 1], ["portal1", 0]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MilkDrop's sampler names: the sampler_ prefix is optional, and a preset's own PI is its own", async () => {
  const { prefixedSamplers, ownPi } = await import("./milkdrop-convert.mjs");
  assert.equal(prefixedSamplers("sampler rand00;\nshader_body { ret = tex2D(rand00, uv).xyz + texsize_rand00.x; }"),
    "sampler sampler_rand00;\nshader_body { ret = tex2D(sampler_rand00, uv).xyz + texsize_rand00.x; }");
  assert.equal(prefixedSamplers("sampler sampler_worms;"), "sampler sampler_worms;");
  assert.equal(ownPi("static const float PI = M_PI;\nshader_body { ret = PI * M_PI; }"), "static const float PI_md = M_PI;\nshader_body { ret = PI_md * M_PI; }");
  assert.equal(ownPi("shader_body { ret = PI; }"), "shader_body { ret = PI; }");
});

test("textures declared as MilkDrop reads them: several at once, through a #define, or butterchurn's own",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const quiet = console.log;
    console.log = () => undefined;
    try {
      const preset = await convertPreset([
        "[preset00]",
        "warp_1=`#define bg ibts_bg",
        "warp_2=`sampler bg, noise_lq;",
        "warp_3=`shader_body { ret = tex2D(bg, uv).xyz + tex2D(noise_lq, uv).xyz + rot_f3[0]; }"
      ].join("\n"), tools);
      assert.match(preset.warp, /^uniform sampler2D sampler_ibts_bg;$/m);
      // butterchurn's template declares its noise texture: the preset's declaration goes, its reads stay.
      assert.doesNotMatch(preset.warp, /^uniform sampler2D sampler_noise_lq;$/m);
      assert.match(preset.warp, /texture\(sampler_noise_lq,/);
      // A row of a rot_* matrix (float4x3, GLSL mat3x4), which hlslparser's helper lacks.
      assert.match(preset.warp, /^vec3 matrix_row0\(mat3x4 m, int i\)/m);
      assert.match(preset.warp, /^uniform mat3x4 rot_f3;$/m);
      // `sampler main;` — the previous frame — which hlslparser renames main0.
      const main = await convertPreset("[preset00]\nwarp_1=`#define base main\nwarp_2=`sampler base;\nwarp_3=`shader_body { ret = tex2D(base, uv).xyz; }", tools);
      assert.doesNotMatch(main.warp, /main0/);
      assert.match(main.warp, /texture\(sampler_main,/);
    } finally {
      console.log = quiet;
    }
  });

const MILK2_FILE = [
  "Created with MILKDROP 3.33 on 03/03/2026",
  "blending_pattern=side",
  "blending_progress=0.55",
  "blending_direction=1",
  "random_1=0.25", "random_2=0.5", "random_3=0.75", "random_4=1", "random_5=0",
  "sprite=1",
  "[PRESET1_BEGIN]",
  "NAME=first",
  "MILKDROP_PRESET_VERSION=201",
  "[preset00]",
  "fVideoEchoZoom=100.000",
  "per_frame_1=zoom = 1.01;",
  "[PRESET1_END]",
  "[PRESET2_BEGIN]",
  "NAME=second",
  "MILKDROP_PRESET_VERSION=201",
  "[preset00]",
  "nWaveMode=8",
  "wavecode_6_enabled=1",
  "[PRESET2_END]",
  "[SPRITE1_BEGIN]",
  "SpriteName=sprites\\Mandala1.png",
  "[SPRITE1_END]"
].join("\r\n");

test("a MilkDrop 3 double preset (.milk2): two presets and the blend between them", async () => {
  const { splitMilk2 } = await import("./milkdrop-convert.mjs");
  const double = splitMilk2(MILK2_FILE);
  assert.deepEqual(double.blend, { pattern: "side", progress: 0.55, direction: 1, randoms: [0.25, 0.5, 0.75, 1, 0] });
  assert.match(double.first, /NAME=first[\s\S]*zoom = 1\.01/);
  assert.match(double.second, /NAME=second/);
  assert.equal(double.sprites, 1);
  // An unknown pattern is a plain crossfade; text without the markers is no double preset.
  assert.equal(splitMilk2(MILK2_FILE.replace("side", "swirl")).blend.pattern, "zoom");
  assert.equal(splitMilk2("[preset00]\nzoom=1"), null);
});

test("a .milk2 converts to both halves, as MilkDrop 3 presets with the file's randoms",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const notes = [];
    const preset = await convertPreset(MILK2_FILE, tools, notes);
    const { first, second, blend } = preset.double;
    assert.equal(blend.pattern, "side");
    // MilkDrop 3's echo zoom of 100 (its menu's scale) is 2; wave modes counted the BeatDrop way.
    assert.equal(first.baseVals.echo_zoom, 2);
    assert.deepEqual(first.md, { waveModes: 18, randPreset: [0.25, 0.5, 0.75, 1] });
    assert.equal(second.md.waveModes, 18);
    assert.equal(second.waves.length, 7);
    // The file's sprite block is drawn with the second (current) preset, MilkDrop 3.37's defaults filled in.
    assert.deepEqual(notes, []);
    assert.equal(first.md.sprite, undefined);
    assert.deepEqual(second.md.sprite, {
      colorKey: 0, layer: 0, blend: 4, alpha: 1, burn: 1, x: 0, y: 0, sx: -0.5, sy: -0.5, rot: 0, speed: 0, repeatX: 1, repeatY: 1,
      image: "sprites\\Mandala1.png", texture: "sprite_mandala1", code: ""
    });
    // Without sprite=1 in its header MilkDrop 3 does not read it; one inside the first preset never.
    const unflagged = [];
    const none = await convertPreset(MILK2_FILE.replace("sprite=1", ""), tools, unflagged);
    assert.equal(none.double.second.md.sprite, undefined);
    assert.deepEqual(unflagged, ["sprite block not read by MilkDrop 3 (no sprite=1 in the header), not drawn"]);
    const inFirst = [];
    const ownBlock = "[SPRITE1_BEGIN]\nSpriteName=sprites\\x1.png\n[SPRITE1_END]\n[PRESET1_END]";
    const withFirst = await convertPreset(MILK2_FILE.replace("[PRESET1_END]", ownBlock), tools, inFirst);
    assert.equal(withFirst.double.first.md.sprite, undefined);
    assert.equal(withFirst.double.second.md.sprite.texture, "sprite_mandala1");
    assert.deepEqual(inFirst, ["preset 1's sprite block is not read (MilkDrop 3 reads the sprite with the second preset)"]);
    // A .milk of MilkDrop 3.25+ may carry a sprite block too, read when the preset is of version 300
    // (what MilkDrop 3 saves one with a sprite as): the engine's, its keys kept out of the preset's values.
    const single = [];
    const half = MILK2_FILE.slice(MILK2_FILE.indexOf("[PRESET1_BEGIN]") + 15, MILK2_FILE.indexOf("[PRESET1_END]"))
      .replace("MILKDROP_PRESET_VERSION=201", "MILKDROP_PRESET_VERSION=300");
    const sprite = "[SPRITE1_BEGIN]\nSpriteName=sprites\\cross2.png\nSpriteX=0.5\nSpriteSX=3.58\ncode_1=sx=1.2;\n[SPRITE1_END]";
    const plain = await convertPreset(`${half}\n${sprite}\n`, tools, single);
    assert.deepEqual(single, []);
    assert.ok(!Object.keys(plain.baseVals).some((key) => key.startsWith("sprite")));
    assert.equal(plain.md.sprite.texture, "sprite_cross2");
    assert.equal(plain.md.sprite.x, 0.5);
    assert.equal(plain.md.sprite.sx, 3.58);
    assert.equal(plain.md.sprite.code, "(sx = 1.2);");
    // Opened [SPRITE1] rather than [SPRITE1_BEGIN] (one file of MilkDrop 3's is): the same block.
    const opened = await convertPreset(`${half}\n${sprite.replace("[SPRITE1_BEGIN]", "[SPRITE1]")}\n`, tools, []);
    assert.equal(opened.md.sprite.texture, "sprite_cross2");
    assert.ok(!Object.keys(opened.baseVals).some((key) => key.startsWith("sprite")));
    // In a preset of another version MilkDrop 3 does not read it.
    const older = [];
    const old = await convertPreset(`${half.replace("=300", "=201")}\n${sprite}\n`, tools, older);
    assert.equal(old.md?.sprite, undefined);
    assert.deepEqual(older, ["sprite block of a version 201 preset: MilkDrop 3 reads one only in a version 300 preset, not drawn"]);
    // Code that does not compile is left out, with a note; the sprite is still drawn.
    const broken = [];
    const left = await convertPreset(`${half}\n${sprite.replace("sx=1.2;", "sx=(1.2;")}\n`, tools, broken);
    assert.equal(left.md.sprite.code, "");
    assert.ok(broken.some((note) => /sprite code/.test(note)));
  });

test("a MilkDrop 3 sprite block: its keys, MilkDrop 3.37's defaults and its image", async () => {
  const { parseSprite } = await import("./milkdrop-convert.mjs");
  const sprite = parseSprite([
    "SpriteName=sprites\\Jello1.png", "SpriteColorKey=0x00FF00", "SpriteLayer=1", "SpriteBlend=9", "SpriteAlpha=0.500000",
    "SpriteBurn=1", "SpriteRot=2.000000", "SpriteSpeed=0.300000", "SpriteRepeatX=0.950000",
    "init_1=never=1;", "code_2=sy=new_scale;", "code_1=new_scale=1.0+0.02*bass_att;"
  ].join("\r\n"));
  assert.equal(sprite.texture, "sprite_jello1");
  assert.equal(sprite.colorKey, 0x00ff00);
  assert.deepEqual(
    [sprite.layer, sprite.blend, sprite.alpha, sprite.burn, sprite.rot, sprite.speed, sprite.repeatX, sprite.repeatY],
    [1, 9, 0.5, 1, 2, 0.3, 0.95, 1]
  );
  // code_N in its order; init_N is never run (MilkDrop 3 loads the sprite with no init code).
  assert.equal(sprite.code, "new_scale=1.0+0.02*bass_att;\nsy=new_scale;");
  // code_1, code_2 … up to the first one missing, as MilkDrop 2's ReadCode.
  assert.equal(parseSprite("code_1=a=1;\ncode_2=b=2;\ncode_4=c=3;").code, "a=1;\nb=2;");
  // An image from the textures folder is that texture; none at all, nothing to draw.
  assert.equal(parseSprite("SpriteName=textures\\Pattern_008.jpg").texture, "pattern_008");
  assert.equal(parseSprite("SpriteX=0.1").texture, "");
});

test("a preset's own round() — a function or a macro — is left to the preset", async () => {
  const { hlslIntrinsics } = await import("./milkdrop-convert.mjs");
  const own = "float round(float x) { return floor(x); }\nshader_body { ret = round(uv.x); }";
  assert.equal(hlslIntrinsics(own), own);
  const macro = "#define round(x) floor((x)+0.5)\nshader_body { ret = round(uv.x); }";
  assert.equal(hlslIntrinsics(macro), macro);
  const mapped = hlslIntrinsics("shader_body { ret = round(uv.x) + background(uv); } // round(1)");
  assert.match(mapped, /^float hlsl_round\(float x\)/);
  assert.match(mapped, /ret = hlsl_round\(uv\.x\) \+ background\(uv\);/);
});
