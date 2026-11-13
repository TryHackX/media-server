import assert from "node:assert/strict";
import test from "node:test";

import { decodeGif, gifFrameAt } from "./milkdrop-gif.ts";
import {
  buildCatalog,
  d3dxTextureSize,
  declaredSamplers,
  imageDataTextures,
  keyOutPixels,
  planTextures,
  randomSlot,
  requestedTextures,
  samplerRoot,
  texturesToRelease,
  type TexturesInfo
} from "./milkdrop-textures.ts";

const info: TexturesInfo = {
  base: "/assets/milkdrop/textures/",
  list: [
    ["worms", "worms-abc.jpg", 512, 512, 1],
    ["smalltiled_lizard_scales", "smalltiled-lizard-scales-def.jpg", 256, 256, 1],
    ["smalltiled_electric_nebula", "smalltiled-electric-nebula-123.jpg", 256, 256, 1],
    ["sky", "sky-456.jpg", 256, 128, 1],
    // From a pack's own folder: found by name, never drawn at random.
    ["houscat", "houscat-789.jpg", 1200, 1200, 0]
  ]
};

/** Always the same draw, so that a test can say which texture it got. */
const first = (): number => 0;
const last = (): number => 0.999;

/** A shader declaring `header` and, unless told otherwise, sampling every texture it declares. */
const shader = (header: string[], body?: string): string => {
  const uses = header.flatMap((line) => [...line.matchAll(/sampler2D sampler_(\w+);/g)].map((match) => `texture(sampler_${match[1]}, uv).xyz`));
  return [...header, "shader_body {", body ?? `ret = ${uses.join(" + ") || "vec3(0.0)"};`, "}"].join("\n");
};

test("a sampler's texture is its name without MilkDrop's two-letter prefix, which says how it is sampled", () => {
  assert.deepEqual(samplerRoot("worms"), { root: "worms", bilinear: true, wrap: true });
  assert.deepEqual(samplerRoot("fc_Worms"), { root: "worms", bilinear: true, wrap: false });
  assert.deepEqual(samplerRoot("pw_sky"), { root: "sky", bilinear: false, wrap: true });
  assert.deepEqual(samplerRoot("CP_sky"), { root: "sky", bilinear: false, wrap: false });
  // MilkDrop peels off any two letters and an underscore, reading the unknown ones as the default.
  assert.deepEqual(samplerRoot("xy_sky"), { root: "sky", bilinear: true, wrap: true });
  assert.deepEqual(randomSlot("rand07_smalltiled"), { slot: 7, prefix: "smalltiled" });
  assert.deepEqual(randomSlot("rand00"), { slot: 0, prefix: "" });
  assert.equal(randomSlot("rand16"), null);
  assert.equal(randomSlot("random"), null);
});

test("only what a shader declares before shader_body and samples counts, as butterchurn reads it", () => {
  const warp = shader(
    ["uniform sampler2D sampler_worms;", "uniform sampler2D sampler_main;", "uniform sampler3D sampler_noisevol_hq;", "uniform sampler2D sampler_sky;"],
    "ret = texture(sampler_worms, uv).xyz + texture(sampler_main, uv).xyz;\nuniform sampler2D sampler_not_here; ret += texture(sampler_not_here, uv).xyz;"
  );
  // sky is declared and never sampled: the translation keeps such declarations, and nothing is fetched for them.
  assert.deepEqual(declaredSamplers(warp), ["worms", "main"]);
  assert.deepEqual(requestedTextures({ warp, comp: shader(["uniform sampler2D sampler_clouds2;", "uniform sampler2D sampler_rand03;"]) }), { roots: ["worms"], random: true });
  assert.deepEqual(requestedTextures({ warp: "", comp: "" }), { roots: [], random: false });
});

test("a preset is given its textures by the names it uses, case and prefix ignored", () => {
  const catalog = buildCatalog(info);
  const preset = {
    warp: shader(["uniform sampler2D sampler_Worms;", "uniform sampler2D sampler_pc_sky;", "uniform sampler2D sampler_pic;", "uniform sampler2D sampler_blur1;"]),
    comp: shader(["uniform sampler2D sampler_houscat;", "uniform sampler2D sampler_clouds2;"])
  };
  const { preset: ready, bindings } = planTextures(preset, catalog, first);
  // Nothing to rewrite: the very same object.
  assert.equal(ready, preset);
  assert.deepEqual(bindings.map(({ sampler, texture, bilinear, wrap }) => [sampler, texture.url, bilinear, wrap]), [
    ["Worms", "/assets/milkdrop/textures/worms-abc.jpg", true, true],
    ["pc_sky", "/assets/milkdrop/textures/sky-456.jpg", false, false],
    ["houscat", "/assets/milkdrop/textures/houscat-789.jpg", true, true]
  ]);
});

test("a random slot draws one texture per load, the same in both shaders, under a name of its own", () => {
  const catalog = buildCatalog(info);
  const preset = {
    warp: shader(["uniform sampler2D sampler_rand00;", "vec4 texsize_rand00;"], "ret = texture(sampler_rand00, uv * texsize_rand00.zw).xyz;"),
    comp: shader(["uniform sampler2D sampler_fw_rand00;"], "ret = texture(sampler_fw_rand00, uv).xyz;")
  };
  const { preset: ready, bindings } = planTextures(preset, catalog, first) as { preset: { warp: string; comp: string }; bindings: { sampler: string; texture: { key: string } }[] };
  assert.notEqual(ready, preset);
  assert.deepEqual(bindings.map(({ sampler, texture }) => [sampler, texture.key]), [["rand00_pick0", "worms"], ["fw_rand00_pick0", "worms"]]);
  assert.match(ready.warp, /^uniform sampler2D sampler_rand00_pick0;$/m);
  assert.match(ready.warp, /texture\(sampler_rand00_pick0, uv \* texsize_rand00\.zw\)/);
  assert.match(ready.warp, /^vec4 texsize_rand00 = vec4\(512\.0, 512\.0, 0\.001953125, 0\.001953125\);$/m);
  assert.match(ready.comp, /texture\(sampler_fw_rand00_pick0, uv\)/);
  // The preset itself is left as it was: the next load draws again.
  assert.match(preset.warp, /^uniform sampler2D sampler_rand00;$/m);
  const again = planTextures(preset, catalog, last).bindings.map((binding) => binding.texture.key);
  // houscat came from a pack's folder: it is never drawn.
  assert.deepEqual(again, ["sky", "sky"]);
});

test("a slot with a prefix draws only among the textures named so; with none there, clouds2 stays", () => {
  const catalog = buildCatalog(info);
  const preset = {
    warp: shader(["uniform sampler2D sampler_rand02_smalltiled;", "vec4 texsize_rand02_smalltiled;", "uniform sampler2D sampler_rand05_chelsea;", "vec4 texsize_rand05;"]),
    comp: ""
  };
  const { preset: ready, bindings } = planTextures(preset, catalog, last) as { preset: { warp: string }; bindings: { sampler: string; texture: { key: string } }[] };
  assert.deepEqual(bindings.map(({ sampler, texture }) => [sampler, texture.key]), [["rand02_smalltiled_pick2", "smalltiled_electric_nebula"]]);
  assert.match(ready.warp, /^vec4 texsize_rand02_smalltiled = vec4\(256\.0, 256\.0, 0\.00390625, 0\.00390625\);$/m);
  // Nothing starts with "chelsea": butterchurn's clouds2, and its size.
  assert.match(ready.warp, /^uniform sampler2D sampler_rand05_chelsea;$/m);
  assert.match(ready.warp, /^vec4 texsize_rand05 = vec4\(128\.0, 128\.0, 0\.0078125, 0\.0078125\);$/m);
});

test("without textures of the build's own, butterchurn-presets' stand in, and are what a slot draws", () => {
  const module = { default: { default: { cells: { data: "data:image/jpeg;base64,AA", width: 256, height: 256 }, cloudsImage: { data: "data:image/jpeg;base64,BB", width: 128, height: 128 }, broken: { data: 3 } } } };
  const fallback = imageDataTextures(module);
  assert.deepEqual(fallback.map((texture) => texture.key), ["cells", "clouds"]);
  const bare = buildCatalog(null, fallback);
  assert.equal(bare.find("clouds")?.url, "data:image/jpeg;base64,BB");
  assert.deepEqual(bare.pool.map((texture) => texture.key), ["cells", "clouds"]);
  // With a build's textures, those come first and alone make the pool.
  const both = buildCatalog(info, fallback);
  assert.equal(both.find("cells")?.width, 256);
  assert.equal(both.find("worms")?.width, 512);
  assert.ok(both.pool.every((texture) => texture.url.startsWith("/assets/")));
  assert.deepEqual(buildCatalog(null).pool, []);
});

test("past the budget the least recently used textures go, never the current or the previous preset's", () => {
  const entries = [
    { id: "old", bytes: 40, used: 1 },
    { id: "older", bytes: 40, used: 0 },
    { id: "previous", bytes: 40, used: 4 },
    { id: "current", bytes: 40, used: 5 }
  ];
  assert.deepEqual(texturesToRelease(entries, 200, 5), []);
  assert.deepEqual(texturesToRelease(entries, 120, 5).map((entry) => entry.id), ["older"]);
  assert.deepEqual(texturesToRelease(entries, 10, 5).map((entry) => entry.id), ["older", "old"]);
});

test("a set kept for prefixed slots is drawn by a slot naming it, never by a plain one", () => {
  const catalog = buildCatalog({
    base: "/t/",
    list: [
      ["worms", "worms.jpg", 512, 512, 1],
      ["chelsea1", "chelsea1.png", 640, 480, 2],
      ["chelsea2", "chelsea2.png", 640, 480, 2]
    ]
  });
  assert.deepEqual(catalog.pool.map((texture) => texture.key), ["worms"]);
  assert.deepEqual(catalog.prefixed.map((texture) => texture.key), ["worms", "chelsea1", "chelsea2"]);
  const named = planTextures({ warp: shader(["uniform sampler2D sampler_rand00_chelsea;"]), comp: "" }, catalog, last);
  assert.deepEqual(named.bindings.map((binding) => [binding.sampler, binding.texture.key]), [["rand00_chelsea_pick2", "chelsea2"]]);
  const plain = planTextures({ warp: shader(["uniform sampler2D sampler_rand00;"]), comp: "" }, catalog, last);
  assert.deepEqual(plain.bindings.map((binding) => binding.texture.key), ["worms"]);
});

test("the engine's FFT and waveform textures are no textures to fetch", () => {
  assert.deepEqual(requestedTextures({ warp: shader(["uniform sampler2D sampler_fft;", "uniform sampler2D sampler_wave;"]), comp: "" }), { roots: [], random: false });
});

test("a MilkDrop 3 sprite gets its image under a sampler of its own, colour-keyed at a power-of-two size, or every frame of a GIF", () => {
  const catalog = buildCatalog({
    base: "/t/",
    list: [["sprite_jello1", "jello1-1.png", 400, 300, 0], ["sprite_dmt", "dmt-2.gif", 450, 500, 0]]
  });
  const still = { md: { sprite: { texture: "sprite_jello1", colorKey: 0, layer: 1 } } };
  assert.deepEqual(requestedTextures(still).roots, ["sprite_jello1"]);
  const { preset, bindings } = planTextures(still, catalog, first);
  assert.deepEqual(bindings, [{
    sampler: "md_sprite_sprite_jello1", texture: catalog.find("sprite_jello1"), bilinear: true, wrap: true, colorKey: 0, powerOfTwo: true
  }]);
  // The engine learns where the image is and its size (the quad's aspect); the preset given is left as it was.
  assert.deepEqual((preset as { md: { sprite: object } }).md.sprite, { texture: "sprite_jello1", colorKey: 0, layer: 1, sampler: "md_sprite_sprite_jello1", width: 400, height: 300 });
  assert.equal((still.md.sprite as { sampler?: string }).sampler, undefined);
  // A GIF: its frames, without the colour key (MilkDrop 3 loads it through GDI+).
  const gif = planTextures({ md: { sprite: { texture: "sprite_dmt", colorKey: 0 } } }, catalog, first);
  assert.deepEqual(gif.bindings, [{ sampler: "md_sprite_sprite_dmt", texture: catalog.find("sprite_dmt"), bilinear: true, wrap: true, frames: true }]);
  // An image there is none of: nothing to draw.
  assert.deepEqual(planTextures({ md: { sprite: { texture: "sprite_none" } } }, catalog, first).bindings, []);
});

test("D3DX's colour key: opaque texels of exactly that colour become transparent black, no other", () => {
  // MilkDrop 3 keys with 0xFF000000 | SpriteColorKey and D3DX compares the alpha too: half-transparent black stays.
  const pixels = new Uint8ClampedArray([0, 0, 0, 255, 1, 0, 0, 255, 255, 0, 255, 255, 0, 0, 0, 128]);
  keyOutPixels(pixels, 0x000000);
  assert.deepEqual([...pixels], [0, 0, 0, 0, 1, 0, 0, 255, 255, 0, 255, 255, 0, 0, 0, 128]);
  const magenta = new Uint8ClampedArray([255, 0, 255, 255, 255, 0, 254, 255]);
  keyOutPixels(magenta, 0xff00ff);
  assert.deepEqual([...magenta], [0, 0, 0, 0, 255, 0, 254, 255]);
});

test("D3DX_DEFAULT size: each side of a sprite image rounded up to a power of two, no larger than the GPU takes", () => {
  assert.deepEqual(d3dxTextureSize(1920, 1080, 16384), { width: 2048, height: 2048 });
  assert.deepEqual(d3dxTextureSize(808, 808, 16384), { width: 1024, height: 1024 });
  assert.deepEqual(d3dxTextureSize(512, 512, 16384), { width: 512, height: 512 });
  assert.deepEqual(d3dxTextureSize(2560, 1600, 16384), { width: 4096, height: 2048 });
  assert.deepEqual(d3dxTextureSize(1, 3, 16384), { width: 1, height: 4 });
  // Past the GPU's limit: the largest power of two it takes (D3DX clamps to the device's maximum).
  assert.deepEqual(d3dxTextureSize(3000, 3000, 4096), { width: 4096, height: 4096 });
  assert.deepEqual(d3dxTextureSize(5000, 300, 4096), { width: 4096, height: 512 });
  assert.deepEqual(d3dxTextureSize(5000, 300, 6000), { width: 4096, height: 512 });
});

/** A GIF89a of 2×2 frames: a global table (black, red, green, blue), each frame's control block and LZW data. */
function gifFile(frames: { indices: number[]; delay: number; transparent?: number; disposal?: number; left?: number; top?: number; w?: number; h?: number }[]): Uint8Array {
  const bytes: number[] = [...new TextEncoder().encode("GIF89a"), 2, 0, 2, 0, 0x81, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
  for (const frame of frames) {
    const packed = ((frame.disposal ?? 0) << 2) | (frame.transparent === undefined ? 0 : 1);
    bytes.push(0x21, 0xf9, 4, packed, frame.delay & 255, frame.delay >> 8, frame.transparent ?? 0, 0);
    const w = frame.w ?? 2;
    const h = frame.h ?? 2;
    bytes.push(0x2c, frame.left ?? 0, 0, frame.top ?? 0, 0, w, 0, h, 0, 0);
    // Minimum code size 2: clear (4), then each index as a 3-bit code (the table grows past 7 only after 4 codes), end (5).
    const codes = [4, ...frame.indices, 5];
    let datum = 0;
    let bits = 0;
    let size = 3;
    let available = 6;
    const data: number[] = [];
    codes.forEach((code, index) => {
      datum |= code << bits;
      bits += size;
      while (bits >= 8) {
        data.push(datum & 255);
        datum >>= 8;
        bits -= 8;
      }
      // The decoder adds an entry for every code after the first, and widens the codes at 8.
      if (index >= 2 && code !== 5) {
        available += 1;
        if (available === 1 << size && size < 12) size += 1;
      }
    });
    if (bits > 0) data.push(datum & 255);
    bytes.push(2, data.length, ...data, 0);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

test("a GIF sprite's frames: composed as GDI+ composes them, with MilkDrop 3's delays and loop", () => {
  const file = gifFile([
    { indices: [1, 2, 3, 0], delay: 3 },
    // Transparent index 0 keeps what was there; the frame then asks to be cleared (disposal 2).
    { indices: [0, 0, 0, 1], delay: 0, transparent: 0, disposal: 2 },
    { indices: [2], delay: 10, left: 1, top: 1, w: 1, h: 1 }
  ]);
  const gif = decodeGif(file)!;
  assert.equal(gif.width, 2);
  assert.equal(gif.height, 2);
  assert.equal(gif.frames.length, 3);
  const pixel = (frame: number, index: number): number[] => [...gif.frames[frame]!.subarray(index * 4, index * 4 + 4)];
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(0, index)), [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 255]]);
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(1, index)), [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255]]);
  // Frame 1's area cleared to transparent, then frame 2 drawn in one corner.
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(2, index)), [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 255, 0, 255]]);
  // Hundredths of a second; none (or 0) is a tenth.
  assert.deepEqual(gif.delays, [0.03, 0.1, 0.1]);
  // The frame a time falls in, looped over the total (0.23 s).
  assert.deepEqual([0, 0.029, 0.031, 0.129, 0.131, 0.229, 0.231, 0.26].map((time) => gifFrameAt(gif.delays, time)), [0, 0, 1, 1, 2, 2, 0, 1]);
  assert.equal(gifFrameAt([0.5], 3), 0);
  assert.equal(decodeGif(new TextEncoder().encode("not a gif at all")), null);
});
