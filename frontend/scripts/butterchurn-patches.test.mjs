import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { BUTTERCHURN_VERSION, eelCompilerModule, engineHelpers, PATCHES, patchButterchurn, patchedButterchurnSource } from "./butterchurn-patches.mjs";

const require = createRequire(import.meta.url);
let source = null;
try {
  source = patchedButterchurnSource(require);
} catch (error) {
  // Not installed (no node_modules): the tests below say so. A patch that does not fit throws its own message.
  if (!/Cannot find module|ENOENT/.test(String(error?.message))) throw error;
}
const skip = !source && "butterchurn is not installed";

test("every patch fits the installed butterchurn exactly as often as it expects", { skip }, () => {
  assert.equal(require("butterchurn/package.json").version, BUTTERCHURN_VERSION);
  // patchButterchurn throws naming the patch that does not fit; the result is a module that parses.
  assert.ok(source.includes("const __md = (function engineHelpers()"));
  assert.ok(PATCHES.every((patch) => patch.id && patch.why && typeof patch.find === "string"));
  assert.equal(new Set(PATCHES.map((patch) => patch.id)).size, PATCHES.length);
  assert.throws(() => patchButterchurn("not butterchurn"), /does not fit butterchurn/);
});

async function compiler() {
  const module = await import(`data:text/javascript;base64,${Buffer.from(eelCompilerModule(source)).toString("base64")}`);
  return module.default;
}

/** Runs EEL code once on fresh variables and returns their values afterwards. */
async function run(eel, code, names) {
  const pool = Object.fromEntries(names.map((name) => [name, new WebAssembly.Global({ value: "f64", mutable: true }, 0)]));
  const module = await eel.loadModule({ pools: { p: pool }, functions: { f: { pool: "p", code } }, eelVersion: 2 });
  module.exports.f();
  return Object.fromEntries(names.map((name) => [name, pool[name].value]));
}

test("the equations compile and run as in MilkDrop: loop counts, %, NaN stores and big indices", { skip }, async () => {
  const eel = await compiler();
  // loop(0) runs nothing and does not end the block it stands in.
  assert.deepEqual(await run(eel, "a = 1; loop(0, b = 5); c = 2;", ["a", "b", "c"]), { a: 1, b: 0, c: 2 });
  assert.deepEqual(await run(eel, "loop(2.9, a += 1);", ["a"]), { a: 2 });
  // |a| mod |b| on integers, 0 for b = 0 (`-7 % 3` would be -(7 % 3), in MilkDrop as here).
  assert.deepEqual(await run(eel, "x = -7; a = x % 3; b = 7 % 0;", ["x", "a", "b"]), { x: -7, a: 1, b: 0 });
  // An assignment of NaN or infinity stores 0 (sqrt takes |x| first, as ns-eel2's does).
  assert.deepEqual(await run(eel, "a = log(-1); b = exp(1000); c = sqrt(-4);", ["a", "b", "c"]), { a: 0, b: 0, c: 2 });
  // A buffer index far outside reads 0 and does not trap.
  assert.deepEqual(await run(eel, "a = megabuf(1000000000000) + megabuf(log(-1)) + 3;", ["a"]), { a: 3 });
});

const md = engineHelpers();
const seeded = (values) => {
  let at = 0;
  return { random: () => values[at++ % values.length] };
};

test("MilkDrop 2's rot_* matrices: a rotation with its translation, as the shader's float4x3", () => {
  const found = { q: [], rot: [{}], rand: [], mouse: null, sysTime: null, sysDate: null, any: true };
  const uploaded = [];
  const gl = { uniformMatrix3x4fv: (_location, _transpose, data) => uploaded.push([...data]), uniform4f: () => undefined };
  // No rotation, a translation (0.25, -0.5, 1): rows 0–2 the identity, row 3 the translation.
  const rotation = [{ base: [0, 0, 0], speed: [0, 0, 0], xlate: [0.25, -0.5, 1] }];
  md.uniforms(gl, found, { md_rot: rotation, time: 10 }, {}, seeded([0.5]));
  const columns = uploaded[0];
  // Column-major mat3x4: column c holds rows 0–3 of column c.
  assert.deepEqual(columns.map((value) => Math.round(value * 1e6) / 1e6), [1, 0, 0, 0.25, 0, 1, 0, -0.5, 0, 0, 1, 1]);
  // A preset's 20 draws: the static ones barely turn, the ultra-fast ones fast.
  const drawn = md.rotations(seeded([0.9, 0.1, 0.7]));
  assert.equal(drawn.length, 20);
  assert.equal(drawn[0].speed.every((value) => value === 0), true);
  assert.ok(Math.abs(drawn[19].speed[0]) > Math.abs(drawn[4].speed[0]));
});

test("BeatDrop's waveforms 8–17 give vertices in range; 9–11 draw two lines", () => {
  const wave = Array.from({ length: 512 }, (_, index) => Math.sin(index / 9) * 0.3);
  const basic = { aspectx: 1, aspecty: 0.5625, texsizeX: 960, texsizeY: 540, mdAudio: { freqArrayL: new Float32Array(512).fill(4), freqArrayR: new Float32Array(512).fill(4) } };
  const frame = { time: 3.2, wave_x: 0.5, wave_y: 0.5, wave_a: 0.8, bass: 1, mid: 1, modwavealphabyvolume: 0 };
  for (let mode = 8; mode <= 17; mode += 1) {
    const positions = new Float32Array(512 * 3);
    const second = new Float32Array(512 * 3);
    const { numVert, alpha } = md.beatdropWave(basic, mode, wave, wave, frame, 0, 1, false, positions, second);
    assert.ok(numVert > 0 && numVert <= 512, `mode ${mode}: ${numVert} vertices`);
    assert.ok(alpha >= 0 && alpha <= 1, `mode ${mode}: alpha ${alpha}`);
    assert.ok([...positions.slice(0, numVert * 3)].every(Number.isFinite), `mode ${mode}: finite vertices`);
  }
  assert.deepEqual([7, 8, 9, 10, 11, 12].map(md.twoLines), [true, false, true, true, true, false]);
});

test("MilkDrop 3's double-preset patterns: a crossfade, a moving edge, a normalised plasma", () => {
  const make = () => ({ mesh_width: 8, mesh_height: 6, aspectx: 1, aspecty: 0.75, vertInfoA: new Float32Array(63), vertInfoC: new Float32Array(63), createBlendPattern() {} });
  const renderer = { blendPattern: make() };
  md.blendFor(renderer, { md: { blend: { pattern: "zoom", progress: 0.4, randoms: [] } } });
  assert.equal(renderer.mdFrozen, 0.4);
  assert.ok([...renderer.blendPattern.vertInfoA].every((value) => value === 1) && [...renderer.blendPattern.vertInfoC].every((value) => value === 0));
  // side: a straight edge — the mix along it is monotonic, and at p = 0.5 part of the screen is each preset.
  md.blendFor(renderer, { md: { blend: { pattern: "side", progress: 0.5, randoms: [0, 0.5] } } });
  const mix = [...renderer.blendPattern.vertInfoA].map((a, index) => Math.min(1, Math.max(0, a * 0.5 + renderer.blendPattern.vertInfoC[index])));
  assert.ok(mix.some((value) => value === 0) && mix.some((value) => value === 1));
  const firstRow = mix.slice(0, 9);
  assert.deepEqual(firstRow, [...firstRow].sort((a, b) => a - b));
  // plasma: the same randoms give the same pattern, and t spans 0–1 before the band is applied.
  md.blendFor(renderer, { md: { blend: { pattern: "plasma", progress: 0.47, randoms: [0.205, 0.112, 0.841, 0.01, 0.694] } } });
  const once = [...renderer.blendPattern.vertInfoC];
  md.blendFor(renderer, { md: { blend: { pattern: "plasma", progress: 0.47, randoms: [0.205, 0.112, 0.841, 0.01, 0.694] } } });
  assert.deepEqual([...renderer.blendPattern.vertInfoC], once);
  const band = 0.12 + 0.13 * 0.205;
  // Normalised over MilkDrop 3's own 64×48 mesh (MeshSize's default), which butterchurn's mesh samples.
  const field = { mesh_width: 64, mesh_height: 48, aspectx: 1, aspecty: 0.75, vertInfoA: new Float32Array(65 * 49), vertInfoC: new Float32Array(65 * 49) };
  md.md3Field(field, { pattern: "plasma", progress: 0.47, randoms: [0.205, 0.112, 0.841, 0.01, 0.694] });
  const shares = [...field.vertInfoC].map((c) => c * band + 1);
  assert.ok(Math.abs(Math.min(...shares)) < 1e-6 && Math.abs(Math.max(...shares) - 1) < 1e-6);
  const sampled = once.map((c) => c * band + 1);
  assert.ok(Math.min(...sampled) >= -1e-6 && Math.max(...sampled) <= 1 + 1e-6);
  // The corners of both meshes are the same points.
  assert.ok(Math.abs(once[0] - field.vertInfoC[0]) < 1e-6 && Math.abs(once[62] - field.vertInfoC[65 * 49 - 1]) < 1e-6);
  // Without a blend, MilkDrop 2's own transition, nothing frozen.
  let drawn = false;
  renderer.blendPattern.createBlendPattern = () => { drawn = true; };
  md.blendFor(renderer, {});
  assert.equal(drawn, true);
  assert.equal(renderer.mdFrozen, null);
});

test("a double preset blends in to its progress, holds it, and when released runs on to its second half", () => {
  const renderer = { blendPattern: { createBlendPattern() {} }, time: 10, blendStartTime: 10, blendDuration: 2, blending: true };
  md.blendFor(renderer, { md: { blend: { pattern: "zoom", progress: 0.6, randoms: [] } } });
  renderer.blendPattern = { createBlendPattern() {} };
  // Coming in at the load's blend speed: 0.5 after a second of a 2 s blend, then held at 0.6.
  renderer.time = 11;
  assert.equal(md.frozenProgress(renderer), 0.5);
  renderer.time = 20;
  assert.equal(md.frozenProgress(renderer), 0.6);
  // Loaded without a blend time: at once.
  assert.equal(md.frozenProgress({ ...renderer, blendDuration: 0 }), 0.6);
  // Released: the remaining 0.4 of a 2 s blend, from where it is.
  renderer.blendProgress = 0.6;
  assert.ok(Math.abs(md.releaseDouble(renderer, 2) - 0.8) < 1e-9);
  renderer.time += 0.4;
  assert.ok(Math.abs(md.frozenProgress(renderer) - 0.8) < 1e-9);
  renderer.time += 5;
  assert.equal(md.frozenProgress(renderer), 1);
  // Nothing held: nothing to release.
  assert.equal(md.releaseDouble({ mdFrozen: null, blending: false }, 2), 0);
});

test("the simple waveform's dots are one-pixel points, drawn four times only from a 512-wide texture", { skip }, () => {
  const basic = source.slice(source.indexOf("class BasicWaveform"), source.indexOf("class CustomWaveform"));
  // Without gl_PointSize WebGL leaves the size undefined, and ANGLE draws no points at all.
  assert.match(basic, /gl_PointSize = 1\.0;\s*gl_Position = vec4\(aPos \+ vec3\(thickOffset, 0\.0\), 1\.0\);/);
  assert.match(basic, /\(mdVSFrame\.wave_thick !== 0 \|\| mdVSFrame\.wave_dots !== 0\) && this\.texsizeX >= 512/);
  // The custom waves already sized their dots as MilkDrop does (uSize): untouched.
  const custom = source.slice(source.indexOf("class CustomWaveform"));
  assert.match(custom, /gl_PointSize = uSize;/);
});

test("MilkDrop's shader time, roam values, vol and BeatDrop's mono waves", () => {
  // Since the preset started, wrapped at 10 000 s; without a start, and in BeatDrop, since start.
  assert.equal(md.shaderTime({ time: 500, md_preset_time: 12.5 }), 12.5);
  assert.equal(md.shaderTime({ time: 500, md_preset_time: 10012.5 }), 12.5);
  assert.equal(md.shaderTime({ time: 500 }), 500);
  assert.equal(md.shaderTime({ time: 500, md_preset_time: 12.5, md_beatdrop: true }), 500);
  // vol: MilkDrop 2's and 3's comma leaves 0.3333 × treb; BeatDrop's the mean.
  const bands = { bass: 0.9, mid: 0.6, treb: 0.3, bass_att: 1, mid_att: 1, treb_att: 1.5 };
  assert.ok(Math.abs(md.shaderVol(bands, "") - 0.09999) < 1e-9);
  assert.ok(Math.abs(md.shaderVol({ ...bands, md_beatdrop: true }, "") - 0.6) < 1e-9);
  assert.ok(Math.abs(md.shaderVol(bands, "_att") - 0.49995) < 1e-9);
  // roam_cos at time 0 is 0.5 + 0.5·cos(phase): MilkDrop's phases (1.2, 3.9, 2.5, 5.4).
  const set = {};
  const gl = { uniform4fv: (location, values) => { set[location] = values; } };
  md.roam(gl, { roamCosLoc: "roam_cos", roamSinLoc: "roam_sin", slowRoamCosLoc: "slow_cos", slowRoamSinLoc: "slow_sin" }, 0);
  assert.deepEqual(set.roam_cos.map((value) => Math.round(value * 1e6) / 1e6), [1.2, 3.9, 2.5, 5.4].map((phase) => Math.round((0.5 + 0.5 * Math.cos(phase)) * 1e6) / 1e6));
  assert.equal(set.slow_sin[0], 0.5 + 0.5 * Math.sin(2.7));
  // BeatDrop's waves 0 and 6: the mean of the channels; MilkDrop 2's: its own channel (null here).
  assert.equal(md.mono([1, 0.5], [0, 0.25], 1, { md_beatdrop: true }), 0.375);
  assert.equal(md.mono([1], [0], 0, {}), null);
});

test("MilkDrop's progress reaches every pool of a preset that reads it, and the keys stay 0", () => {
  const pools = { perFrame: {}, perVertex: {}, shapePerFrame0: {}, wavePerFrame3: {} };
  const preset = { md: { engine: ["progress", "ctrllt"] } };
  md.engineVars(preset, pools);
  assert.ok(Object.values(pools).every((pool) => pool.progress === preset.mdEngine.progress));
  assert.equal(pools.perVertex.ctrllt, preset.mdEngine.ctrllt);
  md.setProgress(0.25);
  md.setEngineVars(preset);
  assert.equal(preset.mdEngine.progress.value, 0.25);
  assert.equal(preset.mdEngine.ctrllt.value, 0);
  md.setProgress(Number.NaN);
  md.setEngineVars(preset);
  assert.equal(preset.mdEngine.progress.value, 0);
});

test("MilkDrop 3's preset sprite: its quad, turn, burn-in aspect and vertex colour as MilkDrop 3.37 builds them", () => {
  const vars = { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0, flipx: 0, flipy: 0, repeatx: 1, repeaty: 1, r: 1, g: 1, b: 1, a: 1 };
  const sprite = { x: 0, y: 0, sx: -0.5, sy: -0.5, rot: 0, speed: 0, repeatX: 1, repeatY: 1, alpha: 1, blend: 4 };
  const round = (quad) => quad.points.map((point) => point.map((value) => Math.round(value * 1e4) / 1e4));
  // The block's defaults: SX/SY −0.5 on the code's 1, a square image centred, stretched to a 4:3 screen.
  const quad = md.spriteQuad(vars, sprite, { width: 100, height: 100 }, { width: 800, height: 600 }, 0);
  assert.deepEqual(round(quad), [[-0.5, -0.6667, 0, 0], [0.5, -0.6667, 1, 0], [-0.5, 0.6667, 0, 1], [0.5, 0.6667, 1, 1]]);
  assert.deepEqual(quad.color, [1, 1, 1, 1]);
  // A wide image is flattened; SpriteX/Y move it in −1…1 (y down the screen); flipx swaps the columns.
  const wide = md.spriteQuad({ ...vars, flipx: 1 }, { ...sprite, x: 0.25, y: -0.5 }, { width: 200, height: 100 }, { width: 600, height: 600 }, 0);
  assert.deepEqual(round(wide), [[0.75, -0.75, 0, 0], [-0.25, -0.75, 1, 0], [0.75, -0.25, 0, 1], [-0.25, -0.25, 1, 1]]);
  // SpriteRot 1 turns by time × SpriteSpeed (2 s × 0.25 = 0.5 rad), 2 the other way.
  const turned = md.spriteQuad(vars, { ...sprite, rot: 1, speed: 0.25 }, { width: 100, height: 100 }, { width: 600, height: 600 }, 2);
  const back = md.spriteQuad({ ...vars, rot: 1 }, { ...sprite, rot: 2, speed: 0.25 }, { width: 100, height: 100 }, { width: 600, height: 600 }, 2);
  assert.deepEqual(round(turned), round(back));
  assert.deepEqual(round(turned)[1].slice(0, 2), [Math.round((0.5 * Math.cos(0.5) + 0.5 * Math.sin(0.5)) * 1e4) / 1e4, Math.round((0.5 * Math.sin(0.5) - 0.5 * Math.cos(0.5)) * 1e4) / 1e4]);
  // Burnt in as it dies: fitted to a 4:3 picture (a 2:1 screen doubles y, then 1.5 divides it); the repeat scales the uv about the centre.
  const burnt = md.spriteQuad({ ...vars, repeatx: 2 }, sprite, { width: 100, height: 100 }, { width: 1600, height: 800 }, 0, true);
  assert.deepEqual(round(burnt), [[-0.5, -0.6667, -0.5, 0], [0.5, -0.6667, 1.5, 0], [-0.5, 0.6667, -0.5, 1], [0.5, 0.6667, 1.5, 1]]);
  // Vertex colours: decal and additive premultiply and keep alpha 1, srccolor is white, mode 8 folds above 0.5; 8 bits each.
  const tint = { ...vars, r: 0.8, g: 0.4, b: 1, a: 0.5 };
  const color = (blend) => md.spriteQuad(tint, { ...sprite, blend, alpha: 0.5 }, { width: 1, height: 1 }, { width: 1, height: 1 }, 0).color;
  const byte = (value) => Math.trunc(value * 255) / 255;
  assert.deepEqual(color(1), [byte(0.2), byte(0.1), byte(0.25), 1]);
  assert.deepEqual(color(2), color(1));
  assert.deepEqual(color(3), [1, 1, 1, 1]);
  assert.deepEqual(color(8), [byte(1 - 0.8), byte(0.4), 0, byte(0.25)]);
  assert.deepEqual(color(4), [byte(0.8), byte(0.4), 1, byte(0.25)]);
  assert.deepEqual(color(0), color(4));
});

test("MilkDrop 3's sprite wraps or clamps as the frame left D3D's stage 0 where it is drawn", () => {
  const shader = "shader_body { ret = texture(sampler_main, uv).xyz; }";
  const blur = "shader_body { ret = texture(sampler_blur2, uv).xyz; }";
  const renderer = (preset, previous) => ({ preset, prevPreset: previous ?? null, blending: Boolean(previous) });
  const plain = { warp: shader, comp: shader };
  // Layer 0, after a composite shader: RestoreShaderParams' wrap, even when the blur passes ran.
  assert.equal(md.spriteWraps(renderer({ warp: blur, comp: blur }), 0, { wrap: 0 }), true);
  // Layers 1–4: the blur passes clamp; without them a warp shader leaves the wrap.
  assert.equal(md.spriteWraps(renderer({ warp: shader, comp: blur }), 1, { wrap: 1 }), false);
  assert.equal(md.spriteWraps(renderer(plain), 1, { wrap: 0 }), true);
  // In a blend the blur passes run for either preset's shaders.
  assert.equal(md.spriteWraps(renderer(plain, { warp: blur, comp: shader }), 2, { wrap: 1 }), false);
  assert.equal(md.spriteWraps(renderer(plain, { warp: blur, comp: shader }), 0, { wrap: 1 }), true);
  // No warp shader (PSVERSION_WARP 0): the fixed-function warp sets the preset's own wrap (> 0.5).
  assert.equal(md.spriteWraps(renderer({ warp: "", comp: shader }), 1, { wrap: 0 }), false);
  assert.equal(md.spriteWraps(renderer({ warp: "", comp: shader }), 1, { wrap: 0.4 }), false);
  assert.equal(md.spriteWraps(renderer({ warp: "", comp: shader }), 1, { wrap: 1 }), true);
  // Neither shader: layer 0 keeps what the warp left.
  assert.equal(md.spriteWraps(renderer({}), 0, { wrap: 0 }), false);
  assert.equal(md.spriteWraps(renderer({}), 0, { wrap: 1 }), true);
});

test("MilkDrop 3's sprite reads the blend's progress in its code: unclamped, 0 after a cut", () => {
  const preset = { md: { sprite: {} } };
  const at = (blendTime) => {
    md.spriteStart({ time: 3, frameNum: 7 }, preset, blendTime);
    return preset.mdSpriteState;
  };
  assert.deepEqual(at(2.7), { start: 3, frame: 7, dead: false, cut: false });
  assert.equal(at(0).cut, true);
  // Blending: where the blend is; after it, its last value (past 1), as m_fBlendProgress stays.
  assert.equal(md.spriteProgress({ blending: true, blendProgress: 0.25 }, at(2.7)), 0.25);
  assert.equal(md.spriteProgress({ blending: false, blendProgress: 1.004 }, at(2.7)), 1.004);
  // A cut: the 0 LoadPreset wrote (butterchurn's own progress is Infinity then); a held double-preset blend: where it is held.
  assert.equal(md.spriteProgress({ blending: false, blendProgress: Infinity }, at(0)), 0);
  assert.equal(md.spriteProgress({ blending: true, blendProgress: 0.5 }, at(0)), 0.5);
  // A preset without a sprite gets no state.
  const none = { md: {} };
  md.spriteStart({ time: 0, frameNum: 0 }, none, 1);
  assert.equal(none.mdSpriteState, undefined);
});

test("a blended load is applied after eight more frames of the old preset, its sprite drawn from the first", async () => {
  const md = engineHelpers();
  const applied = [];
  // The patched Renderer.loadPreset starts the sprite (spriteStart) and makes the preset current.
  const renderer = {
    time: 10, frameNum: 100, mdStageLoads: true, preset: { name: "old" },
    loadPreset(preset, blendTime) {
      applied.push([preset.name, blendTime, this.frameNum]);
      md.spriteStart(this, preset, blendTime);
      this.preset = preset;
    }
  };
  const frame = () => {
    renderer.frameNum += 1;
    renderer.time += 1 / 60;
    md.stageTick(renderer);
  };
  const next = { name: "new", md: { sprite: { layer: 0 } } };
  const loaded = md.stagedLoad(renderer, next, 2.7);
  // Read at once: the new sprite starts now (drawSprites draws mdStaged's), the old preset still draws.
  assert.equal(next.mdSpriteState.start, 10);
  assert.equal(renderer.mdStaged.preset, next);
  assert.equal(renderer.preset.name, "old");
  for (let count = 1; count < md.STAGED_FRAMES; count += 1) frame();
  assert.deepEqual(applied, []);
  frame();
  // After the eighth frame (LoadPresetTick at m_nLoadingPreset 8) it is applied and its blend starts.
  assert.deepEqual(applied, [["new", 2.7, 108]]);
  assert.equal(renderer.mdStaged, null);
  assert.equal(await loaded, true);
  // Applying it kept the sprite's start, rather than starting it again.
  assert.equal(next.mdSpriteState.start, 10);

  // No blend, a page that did not ask, or a part of a file already read: at once.
  await md.stagedLoad(renderer, { name: "cut" }, 0);
  await md.stagedLoad(renderer, { name: "half", mdLoadAtOnce: true }, 2.7);
  await md.stagedLoad({ ...renderer, mdStageLoads: false, loadPreset: renderer.loadPreset }, { name: "plain" }, 2.7);
  assert.deepEqual(applied.slice(1).map(([name]) => name), ["cut", "half", "plain"]);

  // A load during the eight frames takes the staged one's place, which never comes in.
  const first = md.stagedLoad(renderer, { name: "first" }, 1);
  frame();
  const second = md.stagedLoad(renderer, { name: "second" }, 1);
  assert.equal(await first, false);
  for (let count = 0; count < md.STAGED_FRAMES; count += 1) frame();
  assert.equal(await second, true);
  assert.deepEqual(applied.slice(4).map(([name]) => name), ["second"]);
});
