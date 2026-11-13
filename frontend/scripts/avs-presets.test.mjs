import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAvsPacks, convertPreset, findAllImages, findAvsPacks, findVideos, imageOverrides, presetId, videoResolver } from "./avs-presets.mjs";

/** An AVS preset with no effects: the 24-byte magic and the "clear every frame" byte. */
const EMPTY = Buffer.concat([Buffer.from("Nullsoft AVS Preset 0.2\x1a", "latin1"), Buffer.from([1])]);

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "avs-presets-"));
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), data);
  }
  return root;
}

test("every folder is a pack: an author's packs are its categories, deeper folders its groups", () => {
  const root = fixture({
    "Anthology/01 - Mirror Us CD1/Intro.avs": EMPTY,
    "Anthology/SOURCE.txt": "",
    "8_ronin/Ronin.AVS": EMPTY,
    "tuggummi/One2Pack/Tuggummi - strobotonic II/Twist.avs": EMPTY,
    "empty/notes.txt": "",
    ".git/x.avs": EMPTY,
    "8_ronin/.DS_Store": "",
    "8_ronin/... and what become.avs": EMPTY
  });
  try {
    const packs = findAvsPacks(root);
    assert.deepEqual(packs.map((pack) => [pack.id, pack.name]), [["8-ronin", "8_ronin"], ["anthology", "Anthology"], ["tuggummi", "tuggummi"]]);
    const shape = (pack) => pack.presets.map(({ name, category, group, folder }) => ({ name, category, group, folder }));
    // A name that starts with dots is a preset, not a hidden file.
    assert.deepEqual(shape(packs[0]), [{ name: "... and what become", category: "", group: "", folder: "" }, { name: "Ronin", category: "", group: "", folder: "" }]);
    assert.deepEqual(shape(packs[2]), [{ name: "Twist", category: "One2Pack", group: "Tuggummi - strobotonic II", folder: "One2Pack/Tuggummi - strobotonic II" }]);
    // The name every preset had in the single list: name — folders.
    assert.equal(presetId("Intro", "Anthology", "01 - Mirror Us CD1"), "Intro — Anthology / 01 - Mirror Us CD1");
    assert.equal(presetId("Ronin", "8_ronin", ""), "Ronin — 8_ronin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file webvsc cannot read fails that preset alone", () => {
  assert.deepEqual(convertPreset(EMPTY, "Empty").components, []);
  assert.throws(() => convertPreset(Buffer.from("not a preset at all, no"), "Junk"), /preset/i);
});

test("one index for every pack, chunks beside it, and conversions kept for the next build", () => {
  const root = fixture({
    "vendor/Anthology/01 - Mirror Us CD1/Intro.avs": EMPTY,
    // Different bytes, each converted on its own: not cleared every frame, and trailing bytes AVS ignores.
    "vendor/Anthology/01 - Mirror Us CD1/Outro.avs": Buffer.concat([EMPTY.subarray(0, 24), Buffer.from([0])]),
    "vendor/tuggummi/One2Pack/Twist.avs": Buffer.concat([EMPTY, Buffer.alloc(4)]),
    "vendor/tuggummi/One2Pack/broken.avs": Buffer.from("garbage, not AVS"),
    "vendor/tuggummi/One2Pack/sprite.bmp": Buffer.from("BM"),
    "resources/avsres_texer_circle_sharp_09x09.bmp": Buffer.from("BM")
  });
  const messages = [];
  const settings = {
    directory: join(root, "vendor"),
    resourceDirectory: join(root, "resources"),
    cacheDirectory: join(root, "cache"),
    prefix: "assets/avs/",
    base: "/",
    logger: { info: (message) => messages.push(message), warn: (message) => messages.push(message) }
  };
  try {
    const built = buildAvsPacks(settings);
    assert.deepEqual(built.info.packs.map((pack) => [pack.id, pack.count, pack.categories.map((category) => category.name)]), [
      ["anthology", 2, ["01 - Mirror Us CD1"]],
      ["tuggummi", 1, ["One2Pack"]],
      ["mscopes", built.info.packs.at(-1).count, []]
    ]);
    assert.equal(built.info.count, 3 + built.info.packs.at(-1).count);
    assert.match(built.info.index, /^\/assets\/avs\/index-[0-9a-f]{12}\.json$/);
    const index = JSON.parse(built.files.get(built.info.index.slice(1)));
    const anthology = index.packs.anthology;
    assert.deepEqual(anthology.groups.map((group) => [group.category, group.folder, group.presets.map(([name]) => name)]), [
      ["01 - Mirror Us CD1", "01 - Mirror Us CD1", ["Intro", "Outro"]]
    ]);
    // Chunks sit in the pack's folder beside the index; a preset is found by its folder and name.
    const chunk = JSON.parse(built.files.get(`assets/avs/${anthology.chunks[0]}`));
    assert.deepEqual(Object.keys(chunk), ["01 - Mirror Us CD1/Intro", "01 - Mirror Us CD1/Outro"]);
    assert.deepEqual(chunk["01 - Mirror Us CD1/Intro"].components, []);
    // The unreadable file is listed, not fatal; images are served by name beside webvs's own.
    assert.match(readFileSync(join(root, "cache", "failed.txt"), "utf8"), /tuggummi\/One2Pack\/broken\.avs/);
    assert.deepEqual(built.imageNames, ["sprite.bmp"]);
    assert.ok(built.images.has("assets/avs/resources/sprite.bmp"));
    assert.ok(built.images.has("assets/avs/resources/avsres_texer_circle_sharp_09x09.bmp"));
    assert.match(messages.at(-1), /4 converted now, 0 from cache/);
    assert.ok(existsSync(join(root, "cache", "presets.json")));
    // The next build converts nothing: same index, same chunks.
    const again = buildAvsPacks(settings);
    assert.match(messages.at(-1), /0 converted now, 4 from cache/);
    assert.equal(again.info.index, built.info.index);
    assert.deepEqual([...again.files.keys()], [...built.files.keys()]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no folder: mscopes' presets alone, as every build has them", () => {
  const root = fixture({});
  try {
    const built = buildAvsPacks({
      directory: join(root, "missing"),
      resourceDirectory: join(root, "missing-resources"),
      cacheDirectory: join(root, "cache"),
      prefix: "assets/avs/",
      base: "/app/",
      logger: { info: () => {}, warn: () => {} }
    });
    assert.deepEqual(built.info.packs.map((pack) => pack.id), ["mscopes"]);
    assert.match(built.info.index, /^\/app\/assets\/avs\/index-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bitmap name two packs use for different pictures: each preset gets its own pack's copy", () => {
  const root = fixture({
    "danjoe/AMIGAN fx/acid.bmp": Buffer.from("BM big acid"),
    "danjoe/AMIGAN fx/DeepBlueSea.avs": EMPTY,
    "darkmatter/dark_avs1/Acid.bmp": Buffer.from("BM small acid"),
    "darkmatter/dark_avs1/Transform.avs": EMPTY,
    "darkmatter/dark_avs2/Other.avs": EMPTY,
    "vflorelo/sprite.bmp": Buffer.from("BM same"),
    "zeta/sprite.bmp": Buffer.from("BM same")
  });
  try {
    const all = findAllImages(root);
    assert.deepEqual(all.map((image) => image.name), ["acid.bmp", "Acid.bmp", "sprite.bmp", "sprite.bmp"]);
    const overrides = imageOverrides(all, "assets/avs/", "/");
    const uses = (name) => ({ components: [{ type: "Texer", imageSrc: name }, { type: "EffectList", components: [{ type: "Picture", src: "sprite.bmp" }] }] });
    // The first copy found is the one served under the name: its own pack needs nothing more.
    assert.equal(overrides.uris(join(root, "danjoe/AMIGAN fx/DeepBlueSea.avs"), uses("acid.bmp")), null);
    // Dark Matter's preset gets Dark Matter's picture, under the name as the preset writes it.
    const uris = overrides.uris(join(root, "darkmatter/dark_avs1/Transform.avs"), uses("ACID.BMP"));
    assert.deepEqual(Object.keys(uris), ["ACID.BMP"]);
    assert.match(uris["ACID.BMP"], /^\/assets\/avs\/resources\/[0-9a-f]{10}\/Acid\.bmp$/);
    assert.deepEqual([...overrides.served.values()], [join(root, "darkmatter/dark_avs1/Acid.bmp")]);
    // No copy near the preset, or copies that are the same picture: the shared name as before.
    assert.equal(overrides.uris(join(root, "darkmatter/dark_avs2/Other.avs"), uses("acid.bmp")), null);
    assert.equal(overrides.uris(join(root, "zeta/x.avs"), uses("none.bmp")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an AVI effect gets the nearest copy of its clip, and the names no pack has are counted", () => {
  const meta = (file) => JSON.stringify({ file, width: 4, height: 2, length: 3, cols: 2, rows: 1, pages: [`${file}.webp`], map: [[0, 0], [0, 1], [0, 1]] });
  const root = fixture({
    "presets/el-vis/Plasma/a.avs": EMPTY,
    "presets/fsk/dim2/b.avs": EMPTY,
    "videos/el-vis/Plasma/elvis_germanTV.avi.json": meta("elvis_germanTV.avi"),
    "videos/el-vis/Plasma/elvis_germanTV.avi.webp": "page a",
    "videos/fsk/dim2/elvis_germanTV.avi.json": meta("elvis_germanTV.avi"),
    "videos/fsk/dim2/elvis_germanTV.avi.webp": "page b"
  });
  try {
    const videos = findVideos(join(root, "videos"));
    assert.equal(videos.length, 2);
    const resolver = videoResolver(videos, join(root, "presets"), join(root, "videos"), "assets/avs/", "/");
    const preset = { components: [{ type: "EffectList", components: [{ type: "AVI", file: "ELVIS_GERMANTV.AVI" }, { type: "AVI", file: "FLOWERS.AVI" }] }] };
    const a = resolver.resolve(join(root, "presets", "el-vis", "Plasma", "a.avs"), preset);
    const b = resolver.resolve(join(root, "presets", "fsk", "dim2", "b.avs"), preset);
    const [clipA] = a.components[0].components;
    const [clipB] = b.components[0].components;
    assert.notEqual(clipA.video.pages[0], clipB.video.pages[0], "each pack's own copy");
    assert.deepEqual(clipA.video.map, [[0, 0], [0, 1], [0, 1]]);
    assert.equal(preset.components[0].components[0].video, undefined, "the cached preset is not changed");
    assert.equal(resolver.missing.get("flowers.avi"), 2);
    assert.equal(resolver.served.size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
