/**
 * butterchurn 3.0.0-beta.5 (MIT), patched at build time so that it plays MilkDrop presets as
 * MilkDrop does.
 *
 * butterchurn stays an npm dependency at that exact version. This Vite plugin rewrites
 * `node_modules/butterchurn/dist/butterchurn.js` as it is loaded: every patch below replaces an
 * exact piece of its text, and a patch whose text is not there exactly as often as expected
 * stops the build — after an upgrade the list has to be looked at again, it cannot silently
 * stop applying. `npm run test:ui` applies them to the installed copy (butterchurn-patches.test.mjs).
 *
 * Why patches rather than a fork: butterchurn's own presets and engine are what they were; the
 * changes are a short, reviewed list, each with the reason next to it.
 *
 * The first group fixes the copy of eel-wasm 0.0.16 bundled inside butterchurn, the compiler of
 * the preset equations, against ns-eel2 (MilkDrop 2's own compiler; nseel-compiler.c,
 * asm-nseel-x86-msvc.c, nseel-cfunc.c):
 *   - `loop(n, …)` jumped out of the enclosing block when n < 1 (`br_if 1` for `br_if 0`): at
 *     the top of a block it ended the whole block, inside another loop it skipped to that loop's
 *     next turn, inside an if() the module did not compile at all. MilkDrop runs it zero times;
 *     it also truncates n, runs nothing for n ≥ 2³¹ and at most 1 048 576 times.
 *   - float-to-integer conversions trapped ("float unrepresentable in integer range") on huge
 *     values and NaN — the WebAssembly errors that left presets black; x87 never traps.
 *   - `%` is |a| mod |b| on integers in MilkDrop (0 for b = 0); eel-wasm kept the sign of a.
 *   - an assignment `=` stores 0 instead of NaN, ±∞ or a denormal in MilkDrop
 *     (nseel_asm_assign); eel-wasm stored them, and NaN spread through the preset.
 *   - rand(x) draws from [0, ⌊x⌋] with x at least 1 (eel1: an integer below ⌊x⌋).
 *
 * The second group (ENGINE_PATCHES, with engineHelpers injected as `__md`) adds what MilkDrop 2,
 * BeatDrop and MilkDrop 3 draw and butterchurn did not: MilkDrop 2's rot_* shader matrices;
 * BeatDrop's and MilkDrop 3's q33–q64, 16 custom shapes and waves, simple waveforms 8–17, the
 * get_fft()/get_wave() textures, clock, date and mouse; and MilkDrop 3's double presets (.milk2),
 * a transition frozen in one of its 30 patterns. Each patch says why next to it.
 *
 * engineHelpers ports code of MilkDrop 2 (vis_milk2, BSD-3, Copyright 2005-2013 Nullsoft, Inc.)
 * and BeatDrop (BSD-3, Copyright (c) 2018 Maxim Volskiy and individual contributors): their
 * notices are in LICENSE-milkdrop2-beatdrop.txt beside this file. MilkDrop 3's pattern formulas
 * are written anew from MDropDX12's description of them (engine_presets.cpp), not copied.
 */
import { readFileSync } from "node:fs";

export const BUTTERCHURN_VERSION = "3.0.0-beta.5";

/** An f64 → i32 helper: MilkDrop's loop count. */
const LOOP_COUNT = `_loopCount: {
	        args: [encoding_1.VAL_TYPE.f64],
	        returns: [encoding_1.VAL_TYPE.i32],
	        localVariables: [encoding_1.VAL_TYPE.f64],
	        // MilkDrop (nseel_asm_repeat): fistp with truncation, nothing below 1 nor at 2^31 and
	        // above (x87's "integer indefinite" is negative), at most NSEEL_LOOPFUNC_SUPPORT_MAXLEN.
	        binary: [
	            ...encoding_1.op.local_get(0),
	            0x9d, // f64.trunc
	            ...encoding_1.op.local_tee(1),
	            ...encoding_1.op.f64_const(1),
	            encoding_1.op.f64_ge,
	            ...encoding_1.op.local_get(1),
	            ...encoding_1.op.f64_const(2147483648),
	            encoding_1.op.f64_lt,
	            encoding_1.op.i32_and,
	            ...encoding_1.op.if(encoding_1.VAL_TYPE.i32),
	            ...encoding_1.op.local_get(1),
	            ...encoding_1.op.f64_const(constants_1.MAX_LOOP_COUNT),
	            0xa4, // f64.min
	            encoding_1.op.i32_trunc_f64_s,
	            encoding_1.op.else,
	            ...encoding_1.op.i32_const(0),
	            encoding_1.op.end,
	        ],
	    },
	    // MilkDrop's nseel_asm_assign: what is stored is 0 unless the value is a normal, finite number.
	    _sanitize: {
	        args: [encoding_1.VAL_TYPE.f64],
	        returns: [encoding_1.VAL_TYPE.f64],
	        binary: [
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.f64_abs,
	            ...encoding_1.op.f64_const(2.2250738585072014e-308),
	            encoding_1.op.f64_ge,
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.f64_abs,
	            ...encoding_1.op.f64_const(Infinity),
	            encoding_1.op.f64_lt,
	            encoding_1.op.i32_and,
	            ...encoding_1.op.if(encoding_1.BLOCK.f64),
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.else,
	            ...encoding_1.op.f64_const(0),
	            encoding_1.op.end,
	        ],
	    },
	    mod: {`;

/**
 * The eel-wasm patches: `find` must occur exactly `count` times (default 1); every occurrence
 * becomes `replace`.
 */
export const EEL_PATCHES = [
  {
    id: "eel-loop-count",
    why: "loop(n) with n < 1 left the enclosing block (br_if 1); MilkDrop's count rules",
    find: `	        ...emit(count, context),
	        encoding_1.op.i32_trunc_f64_s,
	        ...encoding_1.op.local_tee(localIndex),
	        ...encoding_1.op.i32_const(0),
	        encoding_1.op.i32_le_s,
	        ...encoding_1.op.br_if(1),`,
    replace: `	        ...emit(count, context),
	        ...context.resolveFunc("_loopCount"),
	        ...encoding_1.op.local_tee(localIndex),
	        ...encoding_1.op.i32_const(0),
	        encoding_1.op.i32_le_s,
	        ...encoding_1.op.br_if(0),`
  },
  {
    id: "eel-helpers",
    why: "the loop count and assignment helpers, beside eel-wasm's own",
    find: "	    mod: {",
    replace: LOOP_COUNT
  },
  {
    id: "eel-mod",
    why: "MilkDrop's % is |a| mod |b| on unsigned integers, 0 for b = 0, and never traps",
    find: `	            ...encoding_1.op.local_get(1),
	            encoding_1.op.i32_trunc_f64_s,
	            ...encoding_1.op.local_tee(2),
	            ...encoding_1.op.i32_const(0),
	            encoding_1.op.i32_ne,
	            ...encoding_1.op.if(encoding_1.BLOCK.f64),
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.i32_trunc_f64_s,
	            ...encoding_1.op.local_get(2),
	            encoding_1.op.i32_rem_s,
	            encoding_1.op.f64_convert_i32_s,`,
    replace: `	            ...encoding_1.op.local_get(1),
	            encoding_1.op.f64_abs,
	            0xfc, 0x03, // i32.trunc_sat_f64_u
	            ...encoding_1.op.local_tee(2),
	            ...encoding_1.op.i32_const(0),
	            encoding_1.op.i32_ne,
	            ...encoding_1.op.if(encoding_1.BLOCK.f64),
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.f64_abs,
	            0xfc, 0x03, // i32.trunc_sat_f64_u
	            ...encoding_1.op.local_get(2),
	            0x70, // i32.rem_u
	            0xb8, // f64.convert_i32_u`
  },
  {
    id: "eel-bitwise",
    why: "| and & truncated to 64-bit integers with a trap on huge values and NaN",
    find: "	            encoding_1.op.i64_trunc_s_f64,",
    count: 4,
    replace: "	            0xfc, 0x06, // i64.trunc_sat_f64_s"
  },
  {
    id: "eel-buffer-index",
    why: "megabuf(NaN) or megabuf(1e12) trapped; out of range (as NaN is in MilkDrop) reads 0",
    find: `	        binary: [
	            ...encoding_1.op.f64_const(encoding_1.EPSILON),
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.f64_add,
	            // STACK: [$i + EPSILON]
	            ...encoding_1.op.local_tee(1),
	            encoding_1.op.i32_trunc_f64_s,`,
    replace: `	        binary: [
	            ...encoding_1.op.f64_const(encoding_1.EPSILON),
	            ...encoding_1.op.local_get(0),
	            encoding_1.op.f64_add,
	            // STACK: [$i + EPSILON]
	            ...encoding_1.op.local_tee(1),
	            // NaN and anything outside the buffer become -1 before the (then exact) truncation.
	            ...encoding_1.op.f64_const(-1),
	            encoding_1.op.f64_gt,
	            ...encoding_1.op.local_get(1),
	            ...encoding_1.op.f64_const(constants_1.BUFFER_SIZE),
	            encoding_1.op.f64_lt,
	            encoding_1.op.i32_and,
	            ...encoding_1.op.if(encoding_1.BLOCK.f64),
	            ...encoding_1.op.local_get(1),
	            encoding_1.op.else,
	            ...encoding_1.op.f64_const(-1),
	            encoding_1.op.end,
	            encoding_1.op.i32_trunc_f64_s,`
  },
  {
    id: "eel-assign-variable",
    why: "x = NaN stores 0 in MilkDrop",
    find: `	                if (mutationCode === null) {
	                    return [...rightCode, ...set, ...get];
	                }`,
    replace: `	                if (mutationCode === null) {
	                    return [...rightCode, ...context.resolveFunc("_sanitize"), ...set, ...get];
	                }`
  },
  {
    id: "eel-assign-buffer",
    why: "megabuf(i) = NaN stores 0 in MilkDrop",
    find: `	                return [
	                    // Emit the right hand side unconditionally to ensure it always runs.
	                    ...rightCode,
	                    ...encoding_1.op.local_set(rightValue),`,
    replace: `	                return [
	                    // Emit the right hand side unconditionally to ensure it always runs.
	                    ...rightCode,
	                    ...context.resolveFunc("_sanitize"),
	                    ...encoding_1.op.local_set(rightValue),`
  },
  {
    id: "eel-assign-function",
    why: "assign(x, NaN) stores 0 in MilkDrop",
    find: `	                    return [
	                        ...emit(ast.arguments[1], context),
	                        ...encoding_1.op.global_set(resolvedName),`,
    replace: `	                    return [
	                        ...emit(ast.arguments[1], context),
	                        ...context.resolveFunc("_sanitize"),
	                        ...encoding_1.op.global_set(resolvedName),`
  },
  {
    id: "eel-rand",
    why: "MilkDrop's rand(x): x floored and at least 1",
    find: "	    rand: a => Math.random() * a,",
    replace: "	    rand: a => Math.random() * Math.max(1, Math.floor(a)),"
  }
];

/**
 * The engine's additions, injected into butterchurn's module scope (before `class Renderer`)
 * as `__md`; the patches below call them. They are what MilkDrop 2 (rot_* matrices), BeatDrop
 * and MilkDrop 3 (q33–q64, 16 shapes and waves, the shader FFT and waveform textures, the clock
 * and the mouse) do and butterchurn does not. Written as a function so that it is checked as
 * code; it runs inside the bundle, where CustomShape$1 and CustomWaveform are butterchurn's.
 */
/* global CustomShape$1, CustomWaveform */
export function engineHelpers() {
  const MAX_CUSTOM = 16;
  const EXTRA_Q = Array.from({ length: 32 }, (_, index) => `q${index + 33}`);
  const Q_BANKS = ["_qi", "_qj", "_qk", "_ql", "_qm", "_qn", "_qo", "_qp"];
  const ROTATIONS = ["s", "d", "f", "vf", "uf"].flatMap((speed) => [1, 2, 3, 4].map((index) => `rot_${speed}${index}`));
  const RANDOM_ROTATIONS = [1, 2, 3, 4].map((index) => `rot_rand${index}`);
  // BeatDrop's per-vertex code gets the mouse and the keys, not the clock (state.cpp).
  const VERTEX_ENGINE = new Set(["mousex", "mousey", "mousedown", "mouseclick", "ctrllt", "ctrlrt", "ctrldn", "ctrlup"]);
  // BeatDrop with the pointer outside its window: -1, -1, nothing held or clicked.
  const OUTSIDE = Object.freeze({ x: -1, y: -1, down: false, clicked: false, lastX: 0, lastY: 0 });
  let pointer = OUTSIDE;
  // MilkDrop's `progress`, this frame (the page's renderer.mdProgress()).
  let progress = 0;

  /**
   * MilkDrop's shader `time` (_c2.x, ApplyShaderParams): seconds since this preset started,
   * wrapped at 10 000 — butterchurn gave every shader the time since the visualizer started, which
   * is what BeatDrop gives (GetTime()) and keeps for its presets.
   */
  function shaderTime(frame) {
    const since = frame.md_preset_time;
    if (frame.md_beatdrop || !Number.isFinite(since)) return frame.time;
    return since - Math.trunc(since / 10000) * 10000;
  }

  /**
   * The shaders' vol and vol_att: 0.3333 × treb in MilkDrop 2 and 3 — a comma in ApplyShaderParams,
   * `0.3333f*(bass, mid, treb)`, leaves treb alone — and the mean of the bands in BeatDrop, which
   * wrote `+` there.
   */
  function shaderVol(frame, suffix) {
    const treb = frame[`treb${suffix}`];
    return frame.md_beatdrop ? (frame[`bass${suffix}`] + frame[`mid${suffix}`] + treb) / 3 : 0.3333 * treb;
  }

  /**
   * roam_cos, roam_sin, slow_roam_cos and slow_roam_sin as ApplyShaderParams sets them (time since
   * MilkDrop started, frequencies and phases as written there); butterchurn's had other
   * frequencies and no phases.
   */
  const ROAM = [[0.329, 1.2], [1.293, 3.9], [5.07, 2.5], [20.051, 5.4]];
  const SLOW_ROAM = [[0.005, 2.7], [0.0085, 5.3], [0.0133, 4.5], [0.0217, 3.8]];
  function roam(gl, shader, time) {
    const wave = (table, f) => table.map(([speed, phase]) => 0.5 + 0.5 * f(time * speed + phase));
    gl.uniform4fv(shader.slowRoamCosLoc, wave(SLOW_ROAM, Math.cos));
    gl.uniform4fv(shader.roamCosLoc, wave(ROAM, Math.cos));
    gl.uniform4fv(shader.slowRoamSinLoc, wave(SLOW_ROAM, Math.sin));
    gl.uniform4fv(shader.roamSinLoc, wave(ROAM, Math.sin));
  }

  /** BeatDrop draws simple waves 0 and 6 from the mean of the channels (milkdropfs.cpp DrawWave). */
  function mono(left, right, index, frame) {
    return frame.md_beatdrop ? (left[index] + right[index]) * 0.5 : null;
  }

  // D3DX's row-vector 4×4 matrices (D3DXMatrixRotationX/Y/Z, D3DXMatrixTranslation), row-major.
  const rotationX = (a) => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
  const rotationY = (a) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
  const rotationZ = (a) => [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const multiply = (a, b) => {
    const out = new Array(16);
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        let sum = 0;
        for (let k = 0; k < 4; k += 1) sum += a[row * 4 + k] * b[k * 4 + column];
        out[row * 4 + column] = sum;
      }
    }
    return out;
  };
  /**
   * MilkDrop's rot_* matrix (milkdropfs.cpp ApplyShaderParams): RotX · Translate · RotZ · RotY,
   * as the shader's float4x3 sees it — rows 0–3, columns 0–2 — which hlslparser writes as a
   * GLSL mat3x4 of the same layout: uploaded column by column.
   */
  const matrix = (ax, ay, az, tx, ty, tz, out) => {
    const m = multiply(multiply(multiply(rotationX(ax), translation(tx, ty, tz)), rotationZ(az)), rotationY(ay));
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 4; row += 1) out[column * 4 + row] = m[row * 4 + column];
    }
    return out;
  };

  /** A preset's 20 rotations, drawn when it loads (state.cpp RandomizePresetVars). */
  function rotations(rng) {
    const random = () => rng.random();
    return Array.from({ length: 20 }, (_, k) => {
      const speed = 0.9 * Math.pow(k / 8, 3.2);
      return {
        xlate: [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1],
        base: [random() * 6.28, random() * 6.28, random() * 6.28],
        speed: [(random() * 2 - 1) * speed, (random() * 2 - 1) * speed, (random() * 2 - 1) * speed]
      };
    });
  }

  function locations(gl, program) {
    const at = (name) => gl.getUniformLocation(program, name);
    const found = {
      q: Q_BANKS.map(at), rot: ROTATIONS.map(at), rand: RANDOM_ROTATIONS.map(at),
      mouse: at("mouse"), sysTime: at("sysTime"), sysDate: at("sysDate"), progress: at("progress")
    };
    found.any = [...found.q, ...found.rot, ...found.rand, found.mouse, found.sysTime, found.sysDate, found.progress].some(Boolean);
    return found;
  }

  const scratch = new Float32Array(12);
  function uniforms(gl, found, frame, qs, rng) {
    if (!found?.any) return;
    found.q.forEach((location, bank) => {
      if (!location) return;
      const first = 33 + bank * 4;
      gl.uniform4f(location, qs[`q${first}`] || 0, qs[`q${first + 1}`] || 0, qs[`q${first + 2}`] || 0, qs[`q${first + 3}`] || 0);
    });
    const rot = frame.md_rot;
    found.rot.forEach((location, k) => {
      if (!location || !rot) return;
      const { base, speed, xlate } = rot[k];
      const time = frame.time;
      matrix(base[0] + speed[0] * time, base[1] + speed[1] * time, base[2] + speed[2] * time, xlate[0], xlate[1], xlate[2], scratch);
      gl.uniformMatrix3x4fv(location, false, scratch);
    });
    // The last four are new every time a shader is drawn.
    found.rand.forEach((location) => {
      if (!location) return;
      const random = () => rng.random();
      matrix(random() * 6.28, random() * 6.28, random() * 6.28, random(), random(), random(), scratch);
      gl.uniformMatrix3x4fv(location, false, scratch);
    });
    if (found.mouse) {
      // BeatDrop's _c14: y from the top, the last position inside signed by held / clicked.
      gl.uniform4f(found.mouse, pointer.x !== -1 ? pointer.x : -1, pointer.y !== -1 ? 1 - pointer.y : -1,
        pointer.down ? pointer.lastX : -pointer.lastX, pointer.clicked ? pointer.lastY : -pointer.lastY);
    }
    if (found.sysTime || found.sysDate) {
      const now = clock();
      if (found.sysTime) gl.uniform4f(found.sysTime, now.hour, now.minute, now.second, now.totalseconds);
      if (found.sysDate) gl.uniform4f(found.sysDate, now.year, now.month, now.day, now.weekday);
    }
    if (found.progress) gl.uniform1f(found.progress, progress);
  }

  /** BeatDrop's clock (plugin.cpp: GetLocalTime): weekday 1 = Monday … 7 = Sunday. */
  function clock() {
    const date = new Date();
    const hour = date.getHours();
    const minute = date.getMinutes();
    const second = date.getSeconds();
    const milliseconds = date.getMilliseconds();
    return {
      year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), weekday: date.getDay() || 7,
      hour, minute, second, milliseconds, totalseconds: hour * 3600 + minute * 60 + second + milliseconds * 0.001
    };
  }

  /**
   * The engine's variables a preset reads (the converter lists them in `md.engine`), shared by the
   * pools that have them in BeatDrop; `progress` by every pool, as MilkDrop gives it to the per-frame
   * and per-vertex code and to each shape and wave (milkdropfs.cpp).
   */
  function engineVars(preset, pools) {
    const names = preset.md?.engine ?? [];
    if (!names.length) return;
    preset.mdEngine = {};
    for (const name of names) {
      const global = new WebAssembly.Global({ value: "f64", mutable: true }, 0);
      preset.mdEngine[name] = global;
      pools.perFrame[name] = global;
      if (VERTEX_ENGINE.has(name)) pools.perVertex[name] = global;
      if (name === "progress") for (const pool of Object.values(pools)) pool[name] = global;
    }
  }

  /** Keyboard keys (ctrllt …) stay 0: the visualizer has no keyboard of its own, by design. */
  function setEngineVars(preset) {
    const globals = preset.mdEngine;
    if (!globals) return;
    const now = clock();
    const values = {
      ...now, mousex: pointer.x, mousey: pointer.y, mousedown: pointer.down ? 1 : 0, mouseclick: pointer.clicked ? 1 : 0,
      ctrllt: 0, ctrlrt: 0, ctrldn: 0, ctrlup: 0, progress
    };
    for (const name of Object.keys(globals)) globals[name].value = values[name] ?? 0;
  }

  /** q33–q64 kept and restored with q1–q32 (butterchurn's helper module knows those only), when the preset uses them. */
  function extendQs(preset, qVars) {
    const code = [preset.init_eqs_eel, preset.frame_eqs_eel, preset.pixel_eqs_eel,
      ...(preset.shapes ?? []).flatMap((shape) => [shape.init_eqs_eel, shape.frame_eqs_eel]),
      ...(preset.waves ?? []).flatMap((wave) => [wave.init_eqs_eel, wave.frame_eqs_eel, wave.point_eqs_eel])].join("\n");
    if (!/\bq(?:3[3-9]|[45]\d|6[0-4])\b/i.test(code)) return;
    const globals = EXTRA_Q.map((name) => qVars[name]);
    const saved = new Float64Array(globals.length);
    const save = preset.save_qs;
    const restore = preset.restore_qs;
    preset.save_qs = () => {
      save();
      for (let index = 0; index < globals.length; index += 1) saved[index] = globals[index].value;
    };
    preset.restore_qs = () => {
      restore();
      for (let index = 0; index < globals.length; index += 1) globals[index].value = saved[index];
    };
  }

  /** A shape's per-instance save and restore: butterchurn's helper module has shapes 0–3, the rest are kept here. */
  function shapeSaving(exports, pool, names, index) {
    if (index < 4) {
      return { frame_eqs_save: () => exports[`shape${index}_save`](), frame_eqs_restore: () => exports[`shape${index}_restore`]() };
    }
    const globals = names.map((name) => pool[name]);
    const saved = new Float64Array(globals.length);
    return {
      frame_eqs_save: () => {
        for (let at = 0; at < globals.length; at += 1) saved[at] = globals[at].value;
      },
      frame_eqs_restore: () => {
        for (let at = 0; at < globals.length; at += 1) globals[at].value = saved[at];
      }
    };
  }

  const paramsOf = (renderer) => ({
    pixelRatio: renderer.pixelRatio, textureRatio: renderer.textureRatio, texsizeX: renderer.texsizeX, texsizeY: renderer.texsizeY,
    mesh_width: renderer.mesh_width, mesh_height: renderer.mesh_height, aspectx: renderer.aspectx, aspecty: renderer.aspecty
  });

  /** As many custom shapes or waves (up to 16) as the preset has — made when a preset first needs them. */
  function grow(renderer, key, list) {
    const objects = renderer[key];
    const wanted = Math.min(list.length, MAX_CUSTOM);
    const Kind = /Shapes$/.test(key) ? CustomShape$1 : CustomWaveform;
    while (objects.length < wanted) objects.push(new Kind(objects.length, renderer.gl, paramsOf(renderer)));
    return objects.length > wanted ? objects.slice(0, wanted) : objects;
  }

  // The shader FFT and waveform textures (BeatDrop plugin.cpp, as MilkDrop 3's get_fft()).
  const FFT_WINDOW = 2048;
  const FFT_BINS = 1024;
  const WAVE_SAMPLES = 480;
  let fftTables = null;
  function fftTablesFor() {
    if (fftTables) return fftTables;
    const bitrev = new Uint16Array(FFT_WINDOW);
    for (let i = 0, j = 0; i < FFT_WINDOW; i += 1) {
      bitrev[i] = j;
      let bit = FFT_WINDOW >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j |= bit;
    }
    // FFT::InitEnvelopeTable(1.0): a Hann window over the samples.
    const envelope = new Float32Array(FFT_WINDOW);
    for (let i = 0; i < FFT_WINDOW; i += 1) envelope[i] = 0.5 + 0.5 * Math.sin((i / FFT_WINDOW) * 6.2831853 - 1.5707963268);
    fftTables = { bitrev, envelope, real: new Float64Array(FFT_WINDOW), imag: new Float64Array(FFT_WINDOW) };
    return fftTables;
  }

  /** |FFT| of `samples` (FFT_WINDOW of them) into `out` (FFT_BINS), as BeatDrop's FFT class computes it. */
  function spectrum(samples, out) {
    const { bitrev, envelope, real, imag } = fftTablesFor();
    for (let i = 0; i < FFT_WINDOW; i += 1) {
      const index = bitrev[i];
      real[i] = samples[index] * envelope[index];
      imag[i] = 0;
    }
    for (let size = 2; size <= FFT_WINDOW; size <<= 1) {
      const half = size >> 1;
      const theta = (-2 * Math.PI) / size;
      const wpr = Math.cos(theta);
      const wpi = Math.sin(theta);
      let wr = 1;
      let wi = 0;
      for (let m = 0; m < half; m += 1) {
        for (let i = m; i < FFT_WINDOW; i += size) {
          const j = i + half;
          const tr = wr * real[j] - wi * imag[j];
          const ti = wr * imag[j] + wi * real[j];
          real[j] = real[i] - tr;
          imag[j] = imag[i] - ti;
          real[i] += tr;
          imag[i] += ti;
        }
        const t = wr;
        wr = t * wpr - wi * wpi;
        wi = wi * wpr + t * wpi;
      }
    }
    for (let i = 0; i < FFT_BINS; i += 1) out[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }

  const uses = (preset, name) => [preset?.warp, preset?.comp].some((text) => typeof text === "string" && text.includes(`sampler_${name}`));

  /** Which of the two textures the shaders now loaded read (the blended-from preset's too). */
  function audioTexturesFor(renderer) {
    renderer.mdAudio = {
      fft: uses(renderer.preset, "fft") || uses(renderer.prevPreset, "fft"),
      wave: uses(renderer.preset, "wave") || uses(renderer.prevPreset, "wave")
    };
    const fft = renderer.preset?.md?.fft ?? {};
    renderer.mdFftParams = { attack: Number.isFinite(fft.attack) ? fft.attack : 0.5, decay: Number.isFinite(fft.decay) ? fft.decay : 0.7 };
  }

  function texture(renderer, name, width) {
    const gl = renderer.gl;
    let entry = renderer.mdTextures?.[name];
    if (!entry) {
      const handle = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, handle);
      // R16F filters in WebGL 2 without an extension; BeatDrop's R32F does not need to.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, 2, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { handle, data: new Float32Array(width * 2), width };
      renderer.mdTextures = { ...renderer.mdTextures, [name]: entry };
      renderer.image.samplers[name] = handle;
    }
    return entry;
  }

  function upload(renderer, entry) {
    const gl = renderer.gl;
    gl.bindTexture(gl.TEXTURE_2D, entry.handle);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, entry.width, 2, gl.RED, gl.FLOAT, entry.data);
  }

  /**
   * The audio, newest last, as BeatDrop's shader FFT reads it: FFT_WINDOW float samples a
   * channel from `renderer.mdShaderAudio()` when the page provides them, otherwise
   * butterchurn's own 1024 (8-bit) at the end of the window.
   */
  function shaderAudio(renderer) {
    const provided = typeof renderer.mdShaderAudio === "function" ? renderer.mdShaderAudio() : null;
    if (provided?.left?.length >= FFT_WINDOW && provided.right?.length >= FFT_WINDOW) return provided;
    renderer.mdOwnAudio ??= { left: new Float32Array(FFT_WINDOW), right: new Float32Array(FFT_WINDOW) };
    const { left, right } = renderer.mdOwnAudio;
    const sourceLeft = renderer.audio.timeByteArraySignedL;
    const sourceRight = renderer.audio.timeByteArraySignedR;
    const offset = FFT_WINDOW - sourceLeft.length;
    for (let i = 0; i < sourceLeft.length; i += 1) {
      left[offset + i] = sourceLeft[i] / 128;
      right[offset + i] = sourceRight[i] / 128;
    }
    return renderer.mdOwnAudio;
  }

  function updateAudioTextures(renderer) {
    const wanted = renderer.mdAudio;
    if (!wanted || (!wanted.fft && !wanted.wave)) return;
    const audio = shaderAudio(renderer);
    const fps = Math.max(renderer.fps, 1e-8);
    if (wanted.fft) {
      const entry = texture(renderer, "fft", FFT_BINS);
      const state = (renderer.mdFft ??= {
        left: new Float32Array(FFT_BINS), right: new Float32Array(FFT_BINS), smoothed: new Float32Array(FFT_BINS),
        peak: new Float32Array(FFT_BINS), hold: new Int32Array(FFT_BINS), rms: 0.1
      });
      spectrum(audio.left.subarray(audio.left.length - FFT_WINDOW), state.left);
      spectrum(audio.right.subarray(audio.right.length - FFT_WINDOW), state.right);
      let sum = 0;
      for (let i = 0; i < FFT_BINS; i += 1) {
        const mono = (state.left[i] + state.right[i]) * 0.5;
        sum += mono * mono;
      }
      const rms = Math.max(Math.sqrt(sum / FFT_BINS), 1e-5);
      // The level follows quickly upwards (2 s), slowly downwards (5 s).
      const rmsDecay = Math.exp(-1 / fps / (rms > state.rms ? 2 : 5));
      state.rms = state.rms * rmsDecay + rms * (1 - rmsDecay);
      const { attack, decay } = renderer.mdFftParams ?? { attack: 0.5, decay: 0.7 };
      const decayFactor = (1 - decay) * (1 - decay);
      const attackPerFrame = 1 - Math.pow(1 - attack, 60 / fps);
      const decayPerFrame = 1 - Math.pow(1 - decayFactor, 60 / fps);
      for (let i = 0; i < FFT_BINS; i += 1) {
        // m_nFFTShaderScaling .175, m_nFFTShaderNoiseFloor .03; the lowest 24 bins (to ~2 kHz) attenuated.
        let mono = (((state.left[i] + state.right[i]) * 0.5) / state.rms) * 0.175 - 0.03;
        if (mono < 0) mono = 0;
        if (i < 24) mono *= 0.15 + 0.85 * (i / 24) * (i / 24);
        state.smoothed[i] += (mono - state.smoothed[i]) * (mono > state.smoothed[i] ? attackPerFrame : decayPerFrame);
        if (state.smoothed[i] < 5e-8) state.smoothed[i] = 0;
        if (state.smoothed[i] >= state.peak[i]) {
          state.peak[i] = state.smoothed[i];
          state.hold[i] = Math.trunc(fps * (0.25 + decay * 0.75));
        } else if (state.hold[i] > 0) {
          state.hold[i] -= 1;
        } else {
          state.peak[i] = Math.max(0, state.peak[i] * Math.exp(-1 / fps / 0.3));
        }
        entry.data[i] = state.smoothed[i];
        entry.data[FFT_BINS + i] = state.peak[i];
      }
      upload(renderer, entry);
    }
    if (wanted.wave) {
      const entry = texture(renderer, "wave", WAVE_SAMPLES);
      const start = audio.left.length - WAVE_SAMPLES;
      for (let i = 0; i < WAVE_SAMPLES; i += 1) {
        entry.data[i] = audio.left[start + i];
        entry.data[WAVE_SAMPLES + i] = audio.right[start + i];
      }
      upload(renderer, entry);
    }
  }

  // BeatDrop's simple waveforms 8–17 (milkdropfs.cpp DrawWave, NUM_WAVES 18), with its constants.
  /** The two lines a mode draws (BeatDrop's nBreak): 7 as in MilkDrop 2, 9–11 BeatDrop's. */
  const twoLines = (mode) => mode === 7 || mode === 9 || mode === 10 || mode === 11;

  /** A line through the screen at `ang`, moved by wavePosX across it and clipped at ±1.1 (modes 6–11). */
  function edgeLine(ang, posX, count) {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const ex = [posX * Math.cos(ang + 1.57) - dx * 3, posX * Math.cos(ang + 1.57) + dx * 3];
    const ey = [posX * Math.sin(ang + 1.57) - dy * 3, posX * Math.sin(ang + 1.57) + dy * 3];
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        let t = 0;
        let clip = false;
        if (j === 0 && ex[i] > 1.1) { t = (1.1 - ex[1 - i]) / (ex[i] - ex[1 - i]); clip = true; }
        else if (j === 1 && ex[i] < -1.1) { t = (-1.1 - ex[1 - i]) / (ex[i] - ex[1 - i]); clip = true; }
        else if (j === 2 && ey[i] > 1.1) { t = (1.1 - ey[1 - i]) / (ey[i] - ey[1 - i]); clip = true; }
        else if (j === 3 && ey[i] < -1.1) { t = (-1.1 - ey[1 - i]) / (ey[i] - ey[1 - i]); clip = true; }
        if (clip) {
          const ddx = ex[i] - ex[1 - i];
          const ddy = ey[i] - ey[1 - i];
          ex[i] = ex[1 - i] + ddx * t;
          ey[i] = ey[1 - i] + ddy * t;
        }
      }
    }
    const stepX = (ex[1] - ex[0]) / count;
    const stepY = (ey[1] - ey[0]) / count;
    const ang2 = Math.atan2(stepY, stepX);
    return { x0: ex[0], y0: ey[0], stepX, stepY, perpX: Math.cos(ang2 + 1.57), perpY: Math.sin(ang2 + 1.57) };
  }

  /**
   * The vertices of BeatDrop's waveform `mode` (8–17) into `positions` (and `positions2` for a
   * second line), as butterchurn's BasicWaveform holds MilkDrop 2's; its blending, smoothing and
   * drawing take it from there. fL/fR are butterchurn's processed waveform (512 samples, where
   * BeatDrop has 480); a sample index past the end wraps (BeatDrop's star and flower read past
   * their array there).
   */
  function beatdropWave(basic, mode, fL, fR, frame, param, vol, blending, positions, positions2) {
    const count = fL.length;
    const at = (wave, index) => wave[((index % count) + count) % count];
    const mono = (index) => (at(fL, index) + at(fR, index)) * 0.5;
    const time = frame.time;
    const posX = frame.wave_x * 2 - 1;
    const posY = frame.wave_y * 2 - 1;
    const ax = basic.aspectx;
    const ay = basic.aspecty;
    let alpha = frame.wave_a;
    const finishAlpha = () => {
      if (frame.modwavealphabyvolume > 0) alpha *= (vol - frame.modwavealphastart) / (frame.modwavealphaend - frame.modwavealphastart);
      alpha = Math.min(1, Math.max(0, alpha));
    };
    const put = (list, index, x, y) => {
      list[index * 3] = x;
      list[index * 3 + 1] = y;
      list[index * 3 + 2] = 0;
    };
    // "dupe last vertex to connect the lines; skip if blending"
    const close = (n) => {
      if (blending) return n;
      put(positions, n, positions[0], positions[1]);
      return n + 1;
    };
    let n = count;
    if (mode >= 8 && mode <= 11) {
      n = Math.floor(n / 2);
      if (n > basic.texsizeX / 3) n = Math.floor(basic.texsizeX / 3);
      if (mode === 8) n = 256;
      const offset = Math.floor((count - n) / 2);
      finishAlpha();
      if (mode === 8) {
        const line = edgeLine(1.57 * param, posX, n);
        const left = basic.mdAudio?.freqArrayL ?? [];
        const right = basic.mdAudio?.freqArrayR ?? [];
        for (let i = 0; i < n; i += 1) {
          const sum = (left[i * 2] ?? 0) + (left[i * 2 + 1] ?? 0) + (right[i * 2] ?? 0) + (right[i * 2 + 1] ?? 0);
          const f = 0.1 * Math.log(sum * 0.5);
          put(positions, i, line.x0 + line.stepX * i + line.perpX * f, line.y0 + line.stepY * i + line.perpY * f);
        }
        return { numVert: n, alpha };
      }
      if (mode === 9) {
        // A large wave; its second half stays at the centre, as BeatDrop leaves it zeroed.
        const line = edgeLine(1.57 * param, posX, n);
        for (let i = 0; i < n; i += 1) {
          const s = mono(i + offset);
          put(positions, i, line.x0 + line.stepX * i + line.perpX * s, line.y0 + line.stepY * i + line.perpY * s);
          put(positions2, i, 0, 0);
        }
        return { numVert: n, alpha };
      }
      const [first, second, shift] = mode === 10 ? [-0.75 + param * 3.15, 0.75 + param * 3.15, 0] : [1.57, 1.57, 0.45];
      const a = edgeLine(first, posX, n);
      const b = edgeLine(second, posX, n);
      for (let i = 0; i < n; i += 1) {
        const l = 0.35 * at(fL, i + offset);
        const r = 0.35 * at(fR, i + offset);
        put(positions, i, a.x0 - shift + a.stepX * i + a.perpX * l, a.y0 + a.stepY * i + a.perpY * l);
        put(positions2, i, b.x0 + shift + b.stepX * i + b.perpX * r, b.y0 + b.stepY * i + b.perpY * r);
      }
      return { numVert: n, alpha };
    }
    if (mode === 12) {
      // A skewed spiral: the alpha, once clamped, turns the angle.
      alpha *= 1.25;
      finishAlpha();
      n = Math.floor(n / 2);
      for (let i = 0; i < n; i += 1) {
        const rad = 0.63 + 0.23 * at(fR, i) + param;
        const ang = at(fL, i + 32) * 0.9 + time * 3.3;
        put(positions, i, rad * Math.cos(ang + alpha) * ay + posX, rad * Math.sin(ang) * ax + posY);
      }
      return { numVert: n, alpha };
    }
    if (mode === 13 || mode === 14) {
      n = Math.floor(n / 2);
      const offset = Math.floor((count - n) / 2);
      finishAlpha();
      const inv = 1 / (n - 1);
      const depth = mode === 13 ? 0.4 : 0.7;
      for (let i = 0; i < n; i += 1) {
        let rad = 0.7 + depth * mono(i + offset) + param;
        const ang = i * inv * 6.28 + time * 0.2;
        if (i < n / rad) {
          const raw = i / (n * 0.1);
          if (mode === 13) {
            const mix = 0.5 - 0.5 * Math.cos(raw * 3.1416);
            const rad2 = 0.5 + 0.4 * mono(i + n + offset) + param;
            rad = rad2 * (1 - mix) + rad * mix;
          } else {
            const mix = 0.7 - 0.7 * Math.cos(raw * 3.1416);
            const rad2 = 0.7 + 0.7 * mono(i + n + offset) + param;
            rad = rad2 * (1 - mix) + (rad * (mix * 2)) / 8;
          }
        }
        if (mode === 13) put(positions, i, rad * Math.cos(ang) * ay + posX, rad * Math.sin(ang) * ax + posY);
        else put(positions, i, (rad * Math.cos(ang * 3.1416) * ay) / 1.5 + posX * Math.cos(3.1416), (rad * Math.sin(ang - time / 3) * ax) / 1.5 + posY * Math.cos(3.1416));
      }
      return { numVert: close(n), alpha };
    }
    if (mode === 15) {
      // The lasso: no aspect and no wave_x across.
      alpha *= 1.25;
      finishAlpha();
      n = Math.floor(n / 2);
      for (let i = 0; i < n; i += 1) {
        let ang = 0.5 * (at(fL, i + 32) + at(fR, i + 32)) * 1.57 + time * 2;
        if (Math.abs(ang) < 0.001) ang = ang < 0 ? -0.001 : 0.001;
        const t = time / ang;
        put(positions, i, Math.cos(time) / 2 + Math.cos(ang * 2 + Math.tan(t)), (Math.sin(time) * 2 * Math.sin(ang * 3.14) * ax) / 2.8 + posY);
      }
      return { numVert: n, alpha };
    }
    if (mode === 16) {
      // The triangle (DeepSeek and Kai Blaschke's, in BeatDrop).
      finishAlpha();
      n = Math.floor(n / 2);
      const inv = 1 / n;
      const offset = time * 0.2;
      for (let i = 0; i < n; i += 1) {
        const progress = i * inv;
        const phi0 = ((Math.floor(progress * 3) + 0.5) / 3) * 6.28 + offset;
        const angle = progress * 6.28 + offset;
        let edge = Math.cos(angle - phi0);
        if (Math.abs(edge) < 0.02) edge = edge < 0 ? -0.02 : 0.02;
        const radius = Math.min(2, Math.max(-2, (0.7 + edge * mono(i) + param) / (2 * edge)));
        put(positions, i, radius * Math.cos(angle) * ay + posX, radius * Math.sin(angle) * ax + posY);
      }
      return { numVert: close(n), alpha };
    }
    // 17: fireworks — a burst every 1 - wave_mystery seconds; the alpha fades once per particle, as BeatDrop's does.
    n = 256;
    finishAlpha();
    const frequency = 1 - param + 0.001;
    const phase = (time % frequency) / frequency;
    const seed = Math.trunc(time / frequency) * 10;
    let baseX = (seed * 0.1345 - Math.floor(seed * 0.1345)) * 2 - 1;
    let baseY = (seed * 0.2783 - Math.floor(seed * 0.2783)) * 2 - 1;
    if (seed % 1 > 0.3) {
      baseX *= 0.3;
      baseY *= 0.3;
    }
    const size = Math.min(1, phase * 4);
    const fade = 1 - Math.pow(phase, 3);
    const boost = 1 + 2 * (frame.bass + frame.mid) * 0.5;
    for (let i = 0; i < n; i += 1) {
      const ang = (i / n) * 6.283185;
      const spread = 0.7 + 0.3 * ((seed + i * 0.1) % 1);
      const dist = size * spread * (0.5 + 0.5 * mono((i * 3) % count)) * boost;
      const swirl = time * 3 + ang;
      const x = baseX + Math.cos(ang) * dist + Math.cos(swirl) * size * 0.1;
      const y = baseY + Math.sin(ang) * dist + Math.sin(swirl) * size * 0.1;
      put(positions, i, x * ay + posX, y * ax + posY);
      alpha *= fade;
    }
    return { numVert: close(n), alpha };
  }

  /**
   * MilkDrop 3's blend patterns for a double preset (`.milk2`), from the formulas MDropDX12
   * documents (engine_presets.cpp, its decompilation of MilkDrop 3 PRO; written anew here, not
   * copied): each vertex of the warp mesh gets `t`, a constant K and a band, and blends to the
   * second preset as clamp(a·p + c, 0, 1) with a = (band + K) / band, c = (t − 1) / band —
   * MilkDrop 2's transition form. Row 0 is the bottom of the screen, as in MilkDrop.
   */
  /**
   * MilkDrop 3's pattern on its own mesh — 64 × 48 in MilkDrop 3.37 (the constructor's default; a
   * "MeshSize" setting may change the width, the height being 3/4 of it), where butterchurn has
   * MilkDrop 2's 48 × 36 — sampled bilinearly at butterchurn's vertices. plasma and horizontal
   * depend on the mesh itself; the others are the same field either way.
   */
  const MD3_MESH = [64, 48];
  function md3Pattern(pattern, blend) {
    const [W, H] = MD3_MESH;
    const grid = {
      mesh_width: W, mesh_height: H, aspectx: pattern.aspectx, aspecty: pattern.aspecty,
      vertInfoA: new Float32Array((W + 1) * (H + 1)), vertInfoC: new Float32Array((W + 1) * (H + 1))
    };
    md3Field(grid, blend);
    const w = pattern.mesh_width;
    const h = pattern.mesh_height;
    for (let y = 0; y <= h; y += 1) {
      const fy = (y / h) * H;
      const y0 = Math.min(H - 1, Math.floor(fy));
      const ty = fy - y0;
      for (let x = 0; x <= w; x += 1) {
        const fx = (x / w) * W;
        const x0 = Math.min(W - 1, Math.floor(fx));
        const tx = fx - x0;
        const at = (array) => {
          const i = y0 * (W + 1) + x0;
          const top = array[i] * (1 - tx) + array[i + 1] * tx;
          const bottom = array[i + W + 1] * (1 - tx) + array[i + W + 2] * tx;
          return top * (1 - ty) + bottom * ty;
        };
        pattern.vertInfoA[y * (w + 1) + x] = at(grid.vertInfoA);
        pattern.vertInfoC[y * (w + 1) + x] = at(grid.vertInfoC);
      }
    }
  }

  function md3Field(pattern, { pattern: name, direction = 1, randoms = [] }) {
    const W = pattern.mesh_width;
    const H = pattern.mesh_height;
    const ax = pattern.aspectx;
    const ay = pattern.aspecty;
    const [r1, r2, r3, r4, r5] = [0, 1, 2, 3, 4].map((index) => (Number.isFinite(randoms[index]) ? randoms[index] : 0.5));
    const A = pattern.vertInfoA;
    const C = pattern.vertInfoC;
    const B = 0.02 + 0.14 * r1 + 0.34 * r2;
    const flip = direction === -1 && ["cercle", "triangle", "corner", "patches"].includes(name);
    const fromT = (index, t, K, band) => {
      const value = flip ? 1 - t : t;
      A[index] = (band + K) / band;
      C[index] = (value - 1) / band;
    };
    if (name === "plasma" || name === "plasma2" || name === "plasma3") {
      // MilkDrop 2's midpoint displacement, the saved randoms in place of fresh ones at every level.
      const row = W + 1;
      C.fill(0);
      C[0] = r2;
      C[W] = r3;
      C[H * row] = r4;
      C[H * row + W] = r5;
      const plasma = (x0, x1, y0, y1, dt) => {
        const midx = Math.floor((x0 + x1) / 2);
        const midy = Math.floor((y0 + y1) / 2);
        let t00 = C[y0 * row + x0];
        let t01 = C[y0 * row + x1];
        let t10 = C[y1 * row + x0];
        let t11 = C[y1 * row + x1];
        if (y1 - y0 >= 2) {
          if (x0 === 0) C[midy * row + x0] = 0.5 * (t00 + t10) + (r1 * 2 - 1) * dt * ay;
          C[midy * row + x1] = 0.5 * (t01 + t11) + (r2 * 2 - 1) * dt * ay;
        }
        if (x1 - x0 >= 2) {
          if (y0 === 0) C[y0 * row + midx] = 0.5 * (t00 + t01) + (r3 * 2 - 1) * dt * ax;
          C[y1 * row + midx] = 0.5 * (t10 + t11) + (r4 * 2 - 1) * dt * ax;
        }
        if (y1 - y0 >= 2 && x1 - x0 >= 2) {
          t00 = C[midy * row + x0];
          t01 = C[midy * row + x1];
          t10 = C[y0 * row + midx];
          t11 = C[y1 * row + midx];
          C[midy * row + midx] = 0.25 * (t10 + t11 + t00 + t01) + (r5 * 2 - 1) * dt;
          plasma(x0, midx, y0, midy, dt * 0.5);
          plasma(midx, x1, y0, midy, dt * 0.5);
          plasma(x0, midx, midy, y1, dt * 0.5);
          plasma(midx, x1, midy, y1, dt * 0.5);
        }
      };
      plasma(0, W, 0, H, name === "plasma3" ? 0.75 : 0.25);
      let low = name === "plasma3" ? C[0] / 2 : C[0];
      let high = C[0];
      for (let index = 0; index < row * (H + 1); index += 1) {
        low = Math.min(low, C[index]);
        high = Math.max(high, C[index]);
      }
      const span = high - low || 1;
      const band = name === "plasma" ? 0.12 + 0.13 * r1 : 0.25 + 0.15 * r1;
      for (let index = 0; index < row * (H + 1); index += 1) {
        const share = (C[index] - low) / span;
        fromT(index, name === "plasma" ? share : Math.sin(2 * share), 1, band);
      }
      return;
    }
    let index = 0;
    for (let y = 0; y <= H; y += 1) {
      for (let x = 0; x <= W; x += 1, index += 1) {
        let u = x / W;
        let v = y / H;
        if (name === "horizontal") {
          // MilkDrop 3 evaluates vertical's formula at a transposed index (MDropDX12 keeps that bug).
          const n = y * (W + 1) + x;
          u = Math.floor(n / (H + 1)) / W;
          v = (n % (H + 1)) / H;
        }
        const px = (u - 0.5) * ax;
        const py = (v - 0.5) * ay;
        const rad = Math.sqrt(px * px + py * py);
        const ang = Math.atan2(py, px);
        const ex = Math.abs(px);
        const ey = Math.abs(py);
        const cx = (u - 1) * ax;
        const cy = v * ay;
        const line = (theta) => ((u * ax - 0.5) * Math.cos(theta) + (v * ay - 0.5) * Math.sin(theta)) / Math.SQRT2 + 0.5;
        const stripes = (s) => {
          A[index] = 7;
          C[index] = 2 * s - 2;
        };
        switch (name) {
          case "side": fromT(index, line(6.28 * r1), 1, 0.1 + 0.2 * r2); break;
          case "vertical": case "horizontal": fromT(index, line(6.28), 1, 0.2); break;
          case "curtain": {
            const q = (u * ax - 0.5) * Math.cos(6.28) + (v * ay - 0.5) * Math.sin(6.28);
            fromT(index, 0.5 * Math.sin((q + 0.5) * Math.PI) + 0.5, 1, 0.3);
            break;
          }
          case "linesvertical": stripes(Math.sin((u - 0.5) * ax * r1 * 60)); break;
          case "lineshorizontal": stripes(Math.sin((v - 0.5) * ay * r1 * 60)); break;
          case "bubbles": stripes(Math.sin((u - 10 * r1) * ax * 10 + 0.5 * r3) * Math.cos(0.5 * r4 + (v - 0.5) * ay * 10)); break;
          case "cercle": fromT(index, 1.41421 * rad, 1, B); break;
          case "square": fromT(index, 1.41421 * Math.max(ex, ey), 1, B); break;
          case "triangle": fromT(index, ex + ey, 1, B); break;
          case "corner": fromT(index, Math.min(1, Math.max(0, 1.41421 * Math.hypot((u - 0.25) * ax, (v - 0.15) * ay))), 1, B); break;
          case "patches": fromT(index, 0.25 * (Math.cos(10 * py) + Math.sin(10 * px)) + 0.5, 1, B); break;
          case "donuts": fromT(index, Math.sin(10 * rad + 90), 3, B); break;
          case "clock": fromT(index, Math.sin(ang), 3, B); break;
          case "nuclear": fromT(index, Math.sin(3 * ang), 3, B); break;
          case "stars": fromT(index, Math.sin(5 * ang + 90), 3, B); break;
          case "stars2": fromT(index, Math.sin(10 * ang + 90), 3, B); break;
          case "cisor": fromT(index, Math.sin(5 * Math.atan2(cy, cx) + 90), 3, B); break;
          case "wave": fromT(index, Math.sin(10 * Math.hypot(cx, cy) + 90), 3, B); break;
          case "cross": fromT(index, Math.min(2 * ex, 2 * ey), 1, B); break;
          case "cross2": {
            const t = Math.min(2 * ex, 2 * ey);
            if (t >= 0.3) {
              A[index] = 0;
              C[index] = 0;
            } else {
              fromT(index, t, 1, B);
            }
            break;
          }
          case "snail": fromT(index, rad * Math.cos(ang + 10 * rad - 0.2), 2, B); break;
          case "snail2": fromT(index, rad * Math.cos(ang + 25 * rad - 0.2), 2, B); break;
          case "snail3": fromT(index, rad * Math.sin(ang + 50 * rad + 0.5), 2, B); break;
          case "checkerboard": fromT(index, Math.sin(10 * cx + 90) * Math.cos(10 * cy + 90), 3, B); break;
          case "arrow": {
            const clampedX = Math.min(0.999, Math.max(-0.999, px));
            const clampedY = Math.min(0.999, Math.max(-0.999, py));
            fromT(index, 0.5 * Math.sin(Math.atanh(clampedX) + Math.cos(4 * Math.atanh(clampedY))) + 0.5, 1, B);
            break;
          }
          default:
            // zoom, and any other: the whole picture crossfades (mix = p).
            A[index] = 1;
            C[index] = 0;
        }
      }
    }
  }

  /** A preset's transition: MilkDrop 3's frozen double-preset blend when it has one (md.blend), else MilkDrop 2's own. */
  /**
   * A double preset's second half: its pattern, and the progress the blend moves to and stays at
   * (`mdFrozen`), from 0 at the speed of the load's blend time — at once when that is 0.
   */
  function blendFor(renderer, preset) {
    const blend = preset?.md?.blend;
    if (blend) {
      md3Pattern(renderer.blendPattern, blend);
      renderer.mdFrozen = Math.min(1, Math.max(0, Number(blend.progress) || 0));
      renderer.mdFrozenFrom = 0;
    } else {
      renderer.blendPattern.createBlendPattern();
      renderer.mdFrozen = null;
    }
  }

  /** Where a held blend is this frame: from `mdFrozenFrom` toward `mdFrozen`, a full blend time from 0 to 1. */
  function frozenProgress(renderer) {
    const to = renderer.mdFrozen;
    const from = Number.isFinite(renderer.mdFrozenFrom) ? renderer.mdFrozenFrom : to;
    if (!(renderer.blendDuration > 0)) return to;
    const step = (renderer.time - renderer.blendStartTime) / renderer.blendDuration;
    return to >= from ? Math.min(to, from + step) : Math.max(to, from - step);
  }

  /**
   * Leaving a double preset as MilkDrop 3 does since its 3.3x (README: "smooth transitions are now
   * supported for double-presets"): the held blend runs on to its second half, the first half going
   * out in its pattern, and then the next preset blends in as usual. Seconds until the first half is
   * gone; 0 when no double preset is showing.
   */
  function releaseDouble(renderer, seconds) {
    if (renderer.mdFrozen == null || !renderer.blending) return 0;
    const from = renderer.blendProgress;
    renderer.mdFrozenFrom = from;
    renderer.mdFrozen = 1;
    renderer.blendStartTime = renderer.time;
    renderer.blendDuration = Math.max(0, seconds);
    return seconds > 0 ? (1 - from) * seconds : 0;
  }

  // ---- MilkDrop 3's preset sprite (md.sprite), as MilkDrop 3.37's own code draws it ----------------
  //
  // Read from its 32-bit binary (static analysis only): a [SPRITE1] block fills one set of values,
  // its image is loaded as MilkDrop 2's sprite slot 63 with the block's code_N lines as per-frame code
  // (texmgr: x, y, sx, sy, rot, flip, r, g, b, a, repeat, done, burn …), and each frame that sprite is
  // drawn at the point in the frame its SpriteLayer names (0 on top of the final image, after the
  // composite; 1 after the warp and blur, before custom shapes; 2 before custom waves; 3 before the
  // simple waveform; 4 after the borders). The block's values are added to the code's — X, Y to
  // 2x − 1 and 2y − 1, SX, SY to sx, sy — and multiply it — Alpha a, RepeatX/Y repeatx/y —, SpriteRot 1
  // or 2 turns it by ± time × SpriteSpeed, SpriteBlend (0–10) replaces its blendmode, and
  // SpriteBurn 1 / 0 / other draws it into the feedback picture always / never / as `burn` says.
  // Sampled trilinearly, wrapping or clamped as the frame left D3D's stage 0 (spriteWraps); the image
  // itself is loaded as D3DX loads it (milkdrop-textures.ts: power-of-two size, full mip chain).
  const SPRITE_VARIABLES = ["x", "y", "sx", "sy", "rot", "flipx", "flipy", "r", "g", "b", "a", "blendmode", "done", "burn",
    "repeatx", "repeaty", "time", "frame", "fps", "progress", "bass", "mid", "treb", "bass_att", "mid_att", "treb_att"];
  const SPRITE_START = { x: 0.5, y: 0.5, sx: 1, sy: 1, repeatx: 1, repeaty: 1, r: 1, g: 1, b: 1, a: 1, burn: 1 };

  /** The sprite's variables, a pool of their own in the preset's module, and its code a function there. */
  function spritePool(preset, pools, functions) {
    const sprite = preset.md?.sprite;
    if (!sprite) return;
    const pool = {};
    for (const name of SPRITE_VARIABLES) pool[name] = new WebAssembly.Global({ value: "f64", mutable: true }, SPRITE_START[name] ?? 0);
    pools.mdSprite = pool;
    preset.mdSpritePool = pool;
    if (sprite.code) functions.mdSprite = { pool: "mdSprite", code: sprite.code };
  }

  /**
   * A preset's sprite starts when the preset is read: MilkDrop 3.37's LoadPreset kills the sprite
   * shown (slot 63) and the new preset's file brings its own, before the blend even starts — so a
   * transition shows the new sprite at once, never the old one, and neither is faded by the blend.
   * `cut`: loaded with no blend (MilkDrop 3: blend time 0).
   */
  function spriteStart(renderer, preset, blendTime) {
    if (!preset?.md?.sprite) return;
    // A staged load (stagedLoad) started it when the load was asked for; applying the preset keeps that.
    if (preset.mdSpriteStaged) {
      preset.mdSpriteStaged = false;
      return;
    }
    preset.mdSpriteState = { start: renderer.time, frame: renderer.frameNum, dead: false, cut: !(blendTime > 0) };
  }

  /** Frames MilkDrop draws with the old preset alone before a blended load is applied (LoadPresetTick). */
  const STAGED_FRAMES = 8;

  /**
   * MilkDrop 2 and 3 load a preset with a blend over eight frames: LoadPreset reads the file and sets
   * m_nLoadingPreset to 1, LoadPresetTick after each frame counts it up — compiling the warp shader
   * at 2 and the composite at 5 — and at 8 swaps the states and starts the blend. So the preset before
   * keeps drawing alone for eight frames and the blend starts after the eighth. The file is read at
   * once: MilkDrop 3's sprite of the new preset is drawn from the first of them, over the old picture,
   * and the old preset's sprite is gone. A load with no blend happens at once ("do it all NOW!"), and
   * so do loads the page marks `mdLoadAtOnce` (a double preset's second half, part of the file read).
   * Resolves when the preset is applied — or `false` when a newer load took its place, as a second
   * LoadPreset during the eight frames does. Only when the page asks for it (renderer.mdStageLoads).
   */
  function stagedLoad(renderer, preset, blendTime) {
    const pending = renderer.mdStaged;
    renderer.mdStaged = null;
    if (pending) pending.done(false);
    if (!(blendTime > 0) || !renderer.mdStageLoads || preset.mdLoadAtOnce) {
      renderer.loadPreset(preset, blendTime);
      return Promise.resolve(true);
    }
    spriteStart(renderer, preset, blendTime);
    preset.mdSpriteStaged = Boolean(preset.md?.sprite);
    return new Promise((done) => {
      renderer.mdStaged = { preset, blendTime, frames: 0, done };
    });
  }

  /** After each frame drawn: the eighth applies the staged preset and starts its blend. */
  function stageTick(renderer) {
    const staged = renderer.mdStaged;
    if (!staged) return;
    staged.frames += 1;
    if (staged.frames < STAGED_FRAMES) return;
    renderer.mdStaged = null;
    renderer.loadPreset(staged.preset, staged.blendTime);
    staged.done(true);
  }

  /**
   * The sprite code's `progress`: MilkDrop 3's m_fBlendProgress of the current preset, which nothing
   * clamps — 0 → 1 over the blend, then its last value (just past 1); a preset that came in with no
   * blend keeps the 0 its load wrote. A double preset's held blend reads where it is held.
   */
  function spriteProgress(renderer, state) {
    if (renderer.blending || !state?.cut) return Number.isFinite(renderer.blendProgress) ? renderer.blendProgress : 1;
    return 0;
  }

  /** butterchurn's own test for a shader reading the blur textures (Renderer.getHighestBlur). */
  const blurred = (preset) => /sampler_blur[123]/.test(`${preset?.warp ?? ""}\n${preset?.comp ?? ""}`);
  const shaded = (text) => typeof text === "string" && text.trim().length > 0;

  /**
   * Whether the sprite's texture wraps (D3DTADDRESS_WRAP) or clamps where MilkDrop 3.37 draws it at
   * `layer`. Its DrawUserSprites sets no sampler state: stage 0 keeps what the frame left there —
   * RestoreShaderParams' wrap after a warp or composite shader, the blur passes' clamp (they run only
   * when a shader drawn reads a blur texture: the preset's, and in a blend the previous one's too),
   * and a preset without a warp shader (WarpedBlit_NoShaders) its own `wrap` (> 0.5). Layer 0 comes
   * after the composite; the fixed-function composite (no comp shader) leaves the address alone.
   */
  function spriteWraps(renderer, layer, frame) {
    const drawn = renderer.blending && renderer.prevPreset ? [renderer.preset, renderer.prevPreset] : [renderer.preset];
    if (layer === 0 && drawn.some((preset) => shaded(preset?.comp))) return true;
    if (drawn.some(blurred)) return false;
    if (shaded(renderer.preset?.warp)) return true;
    return Number(frame?.wrap ?? 1) > 0.5;
  }

  /**
   * Stage 0's filters for the sprite: MilkDrop 3.37 leaves MIN, MAG and MIP at LINEAR everywhere a
   * sprite is drawn (the frame's start, RestoreShaderParams, the blur passes, the fixed-function warp
   * and composite all set them so) — trilinear over D3DX's mip chain, never anisotropic. One sampler
   * object per address mode; a GIF frame has one level (its MAX_LEVEL 0), so the mip filter has
   * nothing to blend, as in D3D9.
   */
  function spriteSampler(renderer, wraps) {
    const gl = renderer.gl;
    if (!renderer.mdSpriteSamplers) {
      const make = (mode) => {
        const sampler = gl.createSampler();
        gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, mode);
        gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, mode);
        return sampler;
      };
      renderer.mdSpriteSamplers = { wrap: make(gl.REPEAT), clamp: make(gl.CLAMP_TO_EDGE) };
    }
    return wraps ? renderer.mdSpriteSamplers.wrap : renderer.mdSpriteSamplers.clamp;
  }

  const clampTo = (value, low, high) => Math.min(high, Math.max(low, value));

  /**
   * The quad MilkDrop 3 draws, in its own 2D space (y down the screen; the caller flips as its target
   * needs): vertices in triangle-strip order, uv and the vertex colour, as DrawUserSprites builds them.
   */
  function spriteQuad(vars, sprite, image, screen, time, burnKilled = false) {
    const x = clampTo(vars.x * 2 - 1, -1000, 1000) + sprite.x;
    const y = clampTo(vars.y * 2 - 1, -1000, 1000) + sprite.y;
    const sx = clampTo(vars.sx, -1000, 1000) + sprite.sx;
    const sy = clampTo(vars.sy, -1000, 1000) + sprite.sy;
    let rot = vars.rot;
    if (sprite.rot === 1) rot += time * sprite.speed;
    else if (sprite.rot === 2) rot -= time * sprite.speed;
    const flipx = vars.flipx !== 0 ? 1 : 0;
    const flipy = vars.flipy !== 0 ? 1 : 0;
    const repeatx = clampTo(vars.repeatx, 0.01, 100) * sprite.repeatX;
    const repeaty = clampTo(vars.repeaty, 0.01, 100) * sprite.repeatY;
    const v = [{}, {}, {}, {}];
    v[0 + flipx].x = -sx; v[1 - flipx].x = sx; v[2 + flipx].x = -sx; v[3 - flipx].x = sx;
    v[0 + flipy * 2].y = -sy; v[1 + flipy * 2].y = -sy; v[2 - flipy * 2].y = sy; v[3 - flipy * 2].y = sy;
    const aspect = image.height / image.width;
    for (const p of v) {
      if (aspect < 1) p.y *= aspect;
      else p.x /= aspect;
    }
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const screenAspect = screen.width / screen.height;
    const burnAspect = screen.width / (screen.height * 4 / 3);
    const tu = [-0.5, 0.5, -0.5, 0.5];
    const tv = [-0.5, -0.5, 0.5, 0.5];
    const points = v.map((p, k) => {
      let px = p.x * cos - p.y * sin + x;
      let py = p.x * sin + p.y * cos + y;
      if (screenAspect > 1) py *= screenAspect;
      else px /= screenAspect;
      if (burnKilled) {
        if (burnAspect < 1) px *= burnAspect;
        else py /= burnAspect;
      }
      return [px, py, tu[k] * repeatx + 0.5, tv[k] * repeaty + 0.5];
    });
    const r = clampTo(vars.r, 0, 1);
    const g = clampTo(vars.g, 0, 1);
    const b = clampTo(vars.b, 0, 1);
    const a = clampTo(vars.a, 0, 1) * sprite.alpha;
    const mode = sprite.blend;
    // Mode 8 folds each channel above one half back down (c > 0.5 ? 1 − c : c).
    const fold = (c) => (c > 0.5 ? 1 - c : c);
    const color = mode === 1 || mode === 2 ? [r * a, g * a, b * a, 1]
      : mode === 3 ? [1, 1, 1, 1]
      : mode === 8 ? [fold(r), fold(g), fold(b), a]
      : [r, g, b, a];
    // A D3DCOLOR: each channel truncated to 8 bits.
    return { points, color: color.map((c) => Math.trunc(clampTo(c, 0, 1) * 255) / 255), mode };
  }

  const SPRITE_VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform vec4 uColor;
out vec2 vUv;
out vec4 vColor;
void main() { vUv = aUv; vColor = uColor; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  // D3D9 texture stages of each blend mode, per pixel (MilkDrop 3.37's switch on SpriteBlend).
  const SPRITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform int uMode;
in vec2 vUv;
in vec4 vColor;
out vec4 fragColor;
void main() {
  vec4 t = texture(uTex, vUv);
  vec3 rgb = t.rgb * vColor.rgb;
  float a = vColor.a;
  if (uMode == 3) rgb = t.rgb;
  else if (uMode == 4 || uMode == 8) a = t.a * vColor.a;
  else if (uMode == 7) { rgb = vec3(1.0) - t.rgb; a = t.a * vColor.a; }
  else if (uMode == 9) rgb = clamp(t.rgb + vColor.rgb - 0.5, 0.0, 1.0);
  else if (uMode == 10) rgb = clamp(2.0 * t.rgb * vColor.rgb, 0.0, 1.0);
  fragColor = vec4(rgb, a);
}`;

  /** The render states of each blend mode: [source, destination] factors, or null for no blending. */
  function spriteBlend(gl, mode) {
    switch (mode) {
      case 1: return null;
      case 2: case 10: return [gl.ONE, gl.ONE];
      case 3: return [gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR];
      case 5: return [gl.DST_COLOR, gl.ZERO];
      case 6: return [gl.ZERO, gl.ONE_MINUS_SRC_COLOR];
      case 9: return [gl.ZERO, gl.SRC_COLOR];
      default: return [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA];
    }
  }

  function spriteProgram(renderer) {
    if (renderer.mdSpriteGL !== undefined) return renderer.mdSpriteGL;
    const gl = renderer.gl;
    const compile = (type, text) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(gl.VERTEX_SHADER, SPRITE_VS);
    const fs = compile(gl.FRAGMENT_SHADER, SPRITE_FS);
    const program = vs && fs ? gl.createProgram() : null;
    if (program) {
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
    }
    if (!program || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
      renderer.mdSpriteGL = null;
      return null;
    }
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    renderer.mdSpriteGL = {
      program, vao, buffer,
      pos: gl.getAttribLocation(program, "aPos"), uv: gl.getAttribLocation(program, "aUv"),
      color: gl.getUniformLocation(program, "uColor"), tex: gl.getUniformLocation(program, "uTex"), mode: gl.getUniformLocation(program, "uMode")
    };
    return renderer.mdSpriteGL;
  }

  /**
   * One draw of the quad into what is bound; `flip` for butterchurn's feedback textures, upside down
   * to the screen; `sampler` how the texture is filtered and addressed there (spriteSampler).
   */
  function drawSpriteQuad(renderer, quad, texture, flip, sampler) {
    const gl = renderer.gl;
    const sp = spriteProgram(renderer);
    if (!sp) return;
    const data = new Float32Array(16);
    quad.points.forEach(([px, py, u, v], k) => data.set([px, flip ? py : -py, u, v], k * 4));
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), active: gl.getParameter(gl.ACTIVE_TEXTURE),
      blend: gl.isEnabled(gl.BLEND), src: gl.getParameter(gl.BLEND_SRC_RGB), dst: gl.getParameter(gl.BLEND_DST_RGB),
      srcA: gl.getParameter(gl.BLEND_SRC_ALPHA), dstA: gl.getParameter(gl.BLEND_DST_ALPHA),
      equation: gl.getParameter(gl.BLEND_EQUATION_RGB), equationA: gl.getParameter(gl.BLEND_EQUATION_ALPHA)
    };
    gl.activeTexture(gl.TEXTURE0);
    const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const boundSampler = gl.getParameter(gl.SAMPLER_BINDING);
    gl.useProgram(sp.program);
    gl.bindVertexArray(sp.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, sp.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(sp.pos);
    gl.vertexAttribPointer(sp.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(sp.uv);
    gl.vertexAttribPointer(sp.uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniform4fv(sp.color, quad.color);
    gl.uniform1i(sp.mode, quad.mode);
    gl.uniform1i(sp.tex, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindSampler(0, sampler ?? null);
    const factors = spriteBlend(gl, quad.mode);
    if (factors) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(factors[0], factors[1]);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindSampler(0, boundSampler);
    gl.bindTexture(gl.TEXTURE_2D, boundTexture);
    gl.bindVertexArray(saved.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, saved.buffer);
    gl.useProgram(saved.program);
    gl.activeTexture(saved.active);
    if (saved.blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    gl.blendFuncSeparate(saved.src, saved.dst, saved.srcA, saved.dstA);
    gl.blendEquationSeparate(saved.equation, saved.equationA);
  }

  /**
   * The current preset's sprite, if it is drawn at this layer: its code run once, then drawn (and
   * burnt). `frame`: this frame's mixed per-frame values (its `wrap`, for spriteWraps).
   */
  function drawSprites(renderer, layer, frame) {
    // During a staged load MilkDrop 3 draws the new preset's sprite already, and the old one's no more.
    const preset = renderer.mdStaged ? renderer.mdStaged.preset : renderer.preset;
    const sprite = preset?.md?.sprite;
    const state = preset?.mdSpriteState;
    if (!sprite || sprite.layer !== layer || !state || state.dead || !sprite.sampler || !(sprite.width > 0)) return;
    let texture = renderer.image?.samplers?.[sprite.sampler];
    if (!texture) return;
    // A GIF sprite (milkdrop-textures.ts): the frame its time falls in, looped over the frames' delays.
    if (texture.mdFrames) texture = texture.mdFrames.pick(renderer.time - state.start);
    const pool = preset.mdSpritePool;
    const vars = { ...SPRITE_START };
    if (pool) {
      const levels = renderer.audioLevels;
      pool.time.value = renderer.time - state.start;
      pool.frame.value = renderer.frameNum - state.frame;
      pool.fps.value = renderer.fps;
      pool.progress.value = spriteProgress(renderer, state);
      for (const band of ["bass", "mid", "treb", "bass_att", "mid_att", "treb_att"]) pool[band].value = levels?.[band] ?? 0;
      if (typeof preset.md_sprite_eqs === "function") preset.md_sprite_eqs();
      for (const name of SPRITE_VARIABLES) vars[name] = pool[name].value;
    }
    const done = (vars.done ?? 0) !== 0;
    const burn = sprite.burn === 1 ? true : sprite.burn === 0 ? false : (vars.burn ?? 0) !== 0;
    const gl = renderer.gl;
    const screen = { width: renderer.width, height: renderer.height };
    const image = { width: sprite.width, height: sprite.height };
    // MilkDrop's time since it started (GetTime()), which SpriteSpeed turns the sprite by.
    const quad = spriteQuad(vars, sprite, image, screen, renderer.time, done && burn);
    const sampler = spriteSampler(renderer, spriteWraps(renderer, layer, frame));
    if (burn) {
      // Into the feedback picture (MilkDrop's VS[1]), then — the same quad — where the frame was being drawn.
      const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const viewport = gl.getParameter(gl.VIEWPORT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.targetFrameBuffer);
      gl.viewport(0, 0, renderer.texsizeX, renderer.texsizeY);
      drawSpriteQuad(renderer, quad, texture, true, sampler);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    }
    drawSpriteQuad(renderer, quad, texture, layer !== 0, sampler);
    if (done) state.dead = true;
  }

  return {
    spritePool, spriteStart, spriteProgress, spriteWraps, spriteQuad, drawSprites, md3Field, stagedLoad, stageTick, STAGED_FRAMES,
    rotations, locations, uniforms, engineVars, setEngineVars, extendQs, shapeSaving, grow, audioTexturesFor, updateAudioTextures,
    twoLines, beatdropWave, blendFor, frozenProgress, releaseDouble, shaderTime, shaderVol, roam, mono,
    setPointer(next) {
      pointer = next ?? OUTSIDE;
    },
    setProgress(value) {
      progress = Number.isFinite(value) ? value : 0;
    }
  };
}

/** The engine patches; each needs engineHelpers() in scope as `__md` (the last one puts it there). */
export const ENGINE_PATCHES = [
  {
    id: "q-64",
    why: "BeatDrop and MilkDrop 3 have q1–q64 (NUM_Q_VAR 64); butterchurn's pools and copies had q1–q32",
    find: "this.qs = Utils.range(1, 33).map((x) => `q${x}`);",
    count: 4,
    replace: "this.qs = Utils.range(1, 65).map((x) => `q${x}`);"
  },
  {
    id: "q-64-save",
    why: "butterchurn's helper module saves and restores q1–q32 only",
    find: `    preset.save_qs = presetFunctionsMod.exports.saveQs;
    preset.restore_qs = presetFunctionsMod.exports.restoreQs;`,
    replace: `    preset.save_qs = presetFunctionsMod.exports.saveQs;
    preset.restore_qs = presetFunctionsMod.exports.restoreQs;
    __md.extendQs(preset, qWasmVars);`
  },
  {
    id: "shapes-16-save",
    why: "the helper module has per-instance save/restore for shapes 0–3; 4–15 (BeatDrop, MilkDrop 3) are kept in JS",
    find: `        preset.shapes[i].frame_eqs_save = () =>
          presetFunctionsMod.exports[\`shape\${i}_save\`]();
        preset.shapes[i].frame_eqs_restore = () =>
          presetFunctionsMod.exports[\`shape\${i}_restore\`]();`,
    replace: `        Object.assign(preset.shapes[i], __md.shapeSaving(presetFunctionsMod.exports, wasmVarPools[\`shapePerFrame\${i}\`], this.shapeBaseVars, i));`
  },
  {
    id: "engine-variables",
    why: "BeatDrop's clock and mouse in the equations (year … totalseconds, mousex …) and MilkDrop's progress, for presets that read them",
    find: `    const mod = await srcExports.loadModule({
      pools: wasmVarPools,`,
    replace: `    __md.engineVars(preset, wasmVarPools);
    __md.spritePool(preset, wasmVarPools, wasmFunctions);
    const mod = await srcExports.loadModule({
      pools: wasmVarPools,`
  },
  {
    id: "sprite-code",
    why: "a MilkDrop 3 sprite's per-frame code, compiled with the preset's equations",
    find: `    const handleEmptyFunction = (f) => {
      return f ? f : () => {};
    };`,
    replace: `    const handleEmptyFunction = (f) => {
      return f ? f : () => {};
    };
    preset.md_sprite_eqs = mod.exports.mdSprite || null;`
  },
  {
    id: "engine-variables-init",
    why: "their values before the init code",
    find: `    this.preset.init_eqs();

    // qs need to be initialized to there init values every frame
    this.mdVSQInit = this.getQVars("perFrame");`,
    replace: `    __md.setEngineVars(this.preset);
    this.preset.init_eqs();

    // qs need to be initialized to there init values every frame
    this.mdVSQInit = this.getQVars("perFrame");`
  },
  {
    id: "engine-variables-frame",
    why: "and every frame before the per-frame code",
    find: `  runFrameEquations(globalVars) {
    Utils.setWasm(this.preset.globalPools.perFrame, this.mdVS, this.frameKeys);`,
    replace: `  runFrameEquations(globalVars) {
    __md.setEngineVars(this.preset);
    Utils.setWasm(this.preset.globalPools.perFrame, this.mdVS, this.frameKeys);`
  },
  {
    id: "rot-matrices",
    why: "MilkDrop 2's rot_* shader matrices, drawn per preset (RandomizePresetVars)",
    find: `    mdVSFrame.rand_preset = this.rand_preset;
    mdVSFrame.rand_start = this.rand_start;`,
    replace: `    mdVSFrame.rand_preset = this.rand_preset;
    mdVSFrame.rand_start = this.rand_start;
    mdVSFrame.md_rot = this.mdRot ??= __md.rotations(this.rng);
    mdVSFrame.md_wave_modes = this.preset.md?.waveModes;
    mdVSFrame.md_beatdrop = this.preset.md?.beatdrop;
    mdVSFrame.md_preset_time = globalVars.time - (this.mdStartTime ?? globalVars.time);`
  },
  {
    id: "shader-time",
    why: "MilkDrop 2's and 3's shader time is the time since the preset started, wrapped at 10 000 s (ApplyShaderParams); butterchurn gave the time since it started, as BeatDrop does",
    find: "    this.gl.uniform1f(this.timeLoc, mdVSFrame.time);",
    count: 2,
    replace: "    this.gl.uniform1f(this.timeLoc, __md.shaderTime(mdVSFrame));"
  },
  {
    id: "shader-roam",
    why: "roam_cos, roam_sin, slow_roam_cos, slow_roam_sin with MilkDrop's frequencies and phases (ApplyShaderParams)",
    find: `    this.gl.uniform4fv(this.slowRoamCosLoc, [
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 0.005),
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 0.008),
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 0.013),
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 0.022),
    ]);
    this.gl.uniform4fv(this.roamCosLoc, [
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 0.3),
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 1.3),
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 5.0),
      0.5 + 0.5 * Math.cos(mdVSFrame.time * 20.0),
    ]);
    this.gl.uniform4fv(this.slowRoamSinLoc, [
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 0.005),
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 0.008),
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 0.013),
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 0.022),
    ]);
    this.gl.uniform4fv(this.roamSinLoc, [
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 0.3),
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 1.3),
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 5.0),
      0.5 + 0.5 * Math.sin(mdVSFrame.time * 20.0),
    ]);`,
    count: 2,
    replace: "    __md.roam(this.gl, this, mdVSFrame.time);"
  },
  ...[["volLoc", ""], ["volAttLoc", "_att"]].map(([location, suffix]) => ({
    id: `shader-${location === "volLoc" ? "vol" : "vol-att"}`,
    why: "MilkDrop 2's and 3's shader vol is 0.3333 × treb (a comma in ApplyShaderParams: 0.3333f*(bass, mid, treb)); BeatDrop's the mean",
    find: `    this.gl.uniform1f(
      this.${location},
      (mdVSFrame.bass${suffix} + mdVSFrame.mid${suffix} + mdVSFrame.treb${suffix}) / 3
    );`,
    count: 2,
    replace: `    this.gl.uniform1f(this.${location}, __md.shaderVol(mdVSFrame, "${suffix}"));`
  })),
  {
    id: "mono-wave-0",
    why: "BeatDrop's simple wave 0 follows the mean of both channels (MilkDrop 2 and 3: the right one)",
    find: "            let rad = 0.5 + 0.4 * waveR[i + sampleOffset] + fWaveParam2;",
    replace: "            let rad = 0.5 + 0.4 * (__md.mono(waveL, waveR, i + sampleOffset, mdVSFrame) ?? waveR[i + sampleOffset]) + fWaveParam2;"
  },
  {
    id: "mono-wave-0-start",
    why: "and so does the start it blends into",
    find: `              const rad2 =
                0.5 + 0.4 * waveR[i + numVert + sampleOffset] + fWaveParam2;`,
    replace: `              const rad2 =
                0.5 + 0.4 * (__md.mono(waveL, waveR, i + numVert + sampleOffset, mdVSFrame) ?? waveR[i + numVert + sampleOffset]) + fWaveParam2;`
  },
  {
    id: "mono-wave-6",
    why: "BeatDrop's simple wave 6 follows the mean of both channels (MilkDrop 2 and 3: the left one)",
    find: `          if (waveMode === 6) {
            for (let i = 0; i < numVert; i++) {
              const sample = waveL[i + sampleOffset];`,
    replace: `          if (waveMode === 6) {
            for (let i = 0; i < numVert; i++) {
              const sample = __md.mono(waveL, waveR, i + sampleOffset, mdVSFrame) ?? waveL[i + sampleOffset];`
  },
  {
    id: "basic-wave-dots",
    why: "MilkDrop draws the simple waveform's dots as Direct3D points of the default size, one pixel (DrawWave sets no D3DRS_POINTSIZE); butterchurn's shader wrote no gl_PointSize, which WebGL leaves undefined, and Chrome (ANGLE) drew no dots at all — the wave of every preset with bWaveDots=1 was missing, and Geiss's Game of Life 3, seeded only by it, stayed black",
    find: `      uniform vec2 thickOffset;
      void main(void) {
        gl_Position = vec4(aPos + vec3(thickOffset, 0.0), 1.0);
      }`,
    replace: `      uniform vec2 thickOffset;
      void main(void) {
        gl_PointSize = 1.0;
        gl_Position = vec4(aPos + vec3(thickOffset, 0.0), 1.0);
      }`
  },
  {
    id: "basic-wave-fat-dots",
    why: "MilkDrop draws the simple waveform four times, one pixel apart (2×2 dots, thick lines), only when the texture is at least 512 wide (DrawWave's drawing_its); butterchurn did at every size",
    find: `      let instances = 1;
      if (mdVSFrame.wave_thick !== 0 || mdVSFrame.wave_dots !== 0) {
        instances = 4;
      }`,
    replace: `      let instances = 1;
      if ((mdVSFrame.wave_thick !== 0 || mdVSFrame.wave_dots !== 0) && this.texsizeX >= 512) {
        instances = 4;
      }`
  },
  {
    id: "wave-modes",
    why: "BeatDrop's and MilkDrop 3's presets count simple waveforms modulo 18 (NUM_WAVES), MilkDrop 2's modulo 8",
    find: `      const newWaveMode = Math.floor(mdVSFrame.wave_mode) % 8;
      const oldWaveMode = Math.floor(mdVSFrame.old_wave_mode) % 8;`,
    replace: `      const newWaveMode = Math.floor(mdVSFrame.wave_mode) % (mdVSFrame.md_wave_modes || 8);
      const oldWaveMode = Math.floor(mdVSFrame.old_wave_mode) % (mdVSFrame.md_wave_modes || 8);`
  },
  {
    id: "wave-modes-beatdrop",
    why: "BeatDrop's waveforms 8–17, drawn into BasicWaveform's vertex arrays",
    find: `        if (it === 0) {
          this.positions = positions;
          this.positions2 = positions2;
          this.numVert = numVert;
          this.alpha = alpha;`,
    replace: `        if (waveMode >= 8) {
          const drawn = __md.beatdropWave(this, waveMode, waveL, waveR, mdVSFrame, fWaveParam2, vol, blending, positions, positions2);
          numVert = drawn.numVert;
          alpha = drawn.alpha;
        }

        if (it === 0) {
          this.positions = positions;
          this.positions2 = positions2;
          this.numVert = numVert;
          this.alpha = alpha;`
  },
  ...[["        if (newWaveMode === 7) {", "        if (__md.twoLines(newWaveMode)) {"],
    ["        } else if (oldWaveMode === 7) {", "        } else if (__md.twoLines(oldWaveMode)) {"],
    ["      if (newWaveMode === 7 || oldWaveMode === 7) {", "      if (__md.twoLines(newWaveMode) || __md.twoLines(oldWaveMode)) {"],
    [`      const waveMode = Math.floor(mdVSFrame.wave_mode) % 8;
      if (waveMode === 7) {`, `      const waveMode = Math.floor(mdVSFrame.wave_mode) % (mdVSFrame.md_wave_modes || 8);
      if (__md.twoLines(waveMode)) {`]].map(([find, replace], index) => ({
    id: `wave-modes-two-lines-${index + 1}`,
    why: "BeatDrop's 9–11 draw two lines, as mode 7 does",
    find,
    replace
  })),
  {
    id: "wave-modes-spectrum",
    why: "BeatDrop's mode 8 draws the spectrum: the basic waveform gets the audio",
    find: "    this.basicWaveform.drawBasicWaveform(",
    replace: `    this.basicWaveform.mdAudio = this.audio;
    this.basicWaveform.drawBasicWaveform(`
  },
  {
    id: "shader-uniform-locations",
    why: "where the warp and comp shaders read q33–q64, rot_*, mouse, sysTime and sysDate",
    find: `    this.qhLoc = this.gl.getUniformLocation(this.shaderProgram, "_qh");`,
    count: 2,
    replace: `    this.qhLoc = this.gl.getUniformLocation(this.shaderProgram, "_qh");
    this.mdLocs = __md.locations(this.gl, this.shaderProgram);`
  },
  {
    id: "shader-uniforms",
    why: "their values, each time a warp or comp shader is drawn",
    find: `    this.gl.uniform4fv(
      this.qhLoc,
      new Float32Array([
        mdVSQs.q29 || 0,
        mdVSQs.q30 || 0,
        mdVSQs.q31 || 0,
        mdVSQs.q32 || 0,
      ])
    );`,
    count: 2,
    replace: `    this.gl.uniform4fv(
      this.qhLoc,
      new Float32Array([
        mdVSQs.q29 || 0,
        mdVSQs.q30 || 0,
        mdVSQs.q31 || 0,
        mdVSQs.q32 || 0,
      ])
    );
    __md.uniforms(this.gl, this.mdLocs, mdVSFrame, mdVSQs, this.rng);`
  },
  ...[["customShapes", "this.preset.shapes", "shape", "      "], ["customWaveforms", "this.preset.waves", "waveform", "      "],
    ["prevCustomShapes", "this.prevPreset.shapes", "shape", "        "], ["prevCustomWaveforms", "this.prevPreset.waves", "waveform", "        "]]
    .map(([key, list, item, indent]) => ({
      id: `custom-16-${key}`,
      why: "up to 16 custom shapes and waves (BeatDrop, MilkDrop 3), made when a preset first has more than 4",
      find: `${indent}this.${key}.forEach((${item}, i) => {`,
      replace: `${indent}__md.grow(this, "${key}", ${list}).forEach((${item}, i) => {`
    })),
  {
    id: "audio-textures-load",
    why: "whether the loaded shaders read the FFT or the waveform texture (get_fft(), get_wave())",
    find: `    this.warpShader.updateShader(warpText);
    this.compShader.updateShader(compText);`,
    replace: `    this.warpShader.updateShader(warpText);
    this.compShader.updateShader(compText);
    __md.audioTexturesFor(this);`
  },
  {
    id: "double-preset-pattern",
    why: "a MilkDrop 3 double preset (.milk2) is a transition frozen at its progress, in one of MD3's patterns",
    find: `  loadPreset(preset, blendTime) {
    this.blendPattern.createBlendPattern();`,
    replace: `  // A double preset going out: its first half blends into the second (seconds until done).
  mdReleaseDouble(seconds) {
    return __md.releaseDouble(this, seconds);
  }

  loadPreset(preset, blendTime) {
    __md.blendFor(this, preset);
    __md.spriteStart(this, preset, blendTime);`
  },
  {
    id: "double-preset-progress",
    why: "and moves to that progress at the load's blend speed, and stays there; released, it runs on to the second half",
    find: `    if (this.blending) {
      this.blendProgress =
        (this.time - this.blendStartTime) / this.blendDuration;
      if (this.blendProgress > 1.0) {
        this.blending = false;
      }
    }`,
    replace: `    if (this.blending && this.mdFrozen != null) {
      this.blendProgress = __md.frozenProgress(this);
      if (this.mdFrozen >= 1 && this.blendProgress >= 1) {
        this.blending = false;
        this.mdFrozen = null;
      }
    } else if (this.blending) {
      this.blendProgress =
        (this.time - this.blendStartTime) / this.blendDuration;
      if (this.blendProgress > 1.0) {
        this.blending = false;
      }
    }`
  },
  {
    id: "double-preset-randoms",
    why: "both halves of a double preset read the file's randoms as rand_preset (MDropDX12, of MilkDrop 3)",
    find: `    this.rand_preset = new Float32Array([
      this.rng.random(),
      this.rng.random(),
      this.rng.random(),
      this.rng.random(),
    ]);`,
    replace: `    this.rand_preset = new Float32Array([
      this.rng.random(),
      this.rng.random(),
      this.rng.random(),
      this.rng.random(),
    ]);
    if (this.preset.md?.randPreset) this.rand_preset = new Float32Array(this.preset.md.randPreset);
    // When this preset started, for MilkDrop's shader time (CState::m_fPresetStartTime).
    this.mdStartTime = globalVars.time;`
  },
  {
    id: "pointer",
    why: "BeatDrop's mouse and MilkDrop's progress: the page sets renderer.mdPointer ({ x, y, down, clicked, lastX, lastY }; none, the pointer is outside) and renderer.mdProgress()",
    find: `  render({ audioLevels, elapsedTime } = {}) {
    this.calcTimeAndFPS(elapsedTime);`,
    replace: `  render({ audioLevels, elapsedTime } = {}) {
    __md.setPointer(this.mdPointer);
    __md.setProgress(typeof this.mdProgress === "function" ? this.mdProgress() : 0);
    this.calcTimeAndFPS(elapsedTime);`
  },
  {
    id: "audio-textures-frame",
    why: "the two textures filled every frame, as BeatDrop fills them",
    find: "    this.audioLevels.updateAudioLevels(this.fps, this.frameNum);",
    replace: `    this.audioLevels.updateAudioLevels(this.fps, this.frameNum);
    __md.updateAudioTextures(this);`
  },
  ...[
    ["sprite-layer-1", "after the warp and the blur, before anything is drawn on the new frame",
      "    this.motionVectors.drawMotionVectors(mdVSFrameMixed, this.warpUVs);", "before", 1],
    ["sprite-layer-2", "after the custom shapes, before the custom waves",
      `    if (this.preset.waves && this.preset.waves.length > 0) {
      __md.grow(this, "customWaveforms", this.preset.waves).forEach((waveform, i) => {`, "before", 2],
    ["sprite-layer-3", "after the custom waves, before the simple waveform",
      "    this.basicWaveform.mdAudio = this.audio;", "before", 3],
    ["sprite-layer-4", "after the borders, before the composite",
      `    this.innerBorder.drawBorder(
      innerColor,
      mdVSFrameMixed.ib_size,
      mdVSFrameMixed.ob_size
    );`, "after", 4],
    ["sprite-layer-0", "on the final picture, after the composite and the song title",
      `    if (this.outputFXAA) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.compTexture);`, "before", 0]
  ].map(([id, where, find, side, layer]) => {
    // Layers 1–4 are drawn in render(), with this frame's mixed values at hand; layer 0 in renderToScreen().
    const draw = `    __md.drawSprites(this, ${layer}, ${layer === 0 ? "this.mdVSFrameMixed" : "mdVSFrameMixed"});`;
    return {
      id,
      why: `MilkDrop 3's preset sprite at SpriteLayer ${layer}: ${where} (MilkDrop 3.37's RenderFrame)`,
      find,
      replace: side === "before" ? `${draw}\n${find}` : `${find}\n${draw}`
    };
  }),
  {
    id: "staged-load",
    why: "MilkDrop 2 and 3 apply a preset loaded with a blend after eight more frames of the old one (LoadPresetTick), its sprite already drawn; loadPreset resolves when it is applied (stagedLoad)",
    find: `    this.renderer.loadPreset(preset, blendTime);
  }

  loadJSPreset(preset, blendTime) {`,
    replace: `    await __md.stagedLoad(this.renderer, preset, blendTime);
  }

  loadJSPreset(preset, blendTime) {`
  },
  {
    id: "staged-load-tick",
    why: "and counts those frames after each one is drawn, as MilkDrop calls LoadPresetTick after RenderFrame",
    find: `    this.mdVSFrameMixed = mdVSFrameMixed;

    this.renderToScreen();
  }`,
    replace: `    this.mdVSFrameMixed = mdVSFrameMixed;

    this.renderToScreen();
    __md.stageTick(this);
  }`
  },
  {
    id: "engine-helpers",
    why: "the helpers above, in butterchurn's module scope",
    find: "class Renderer {",
    replace: `// TryHackX: MilkDrop 2 / BeatDrop / MilkDrop 3 additions (frontend/scripts/butterchurn-patches.mjs).
const __md = (${engineHelpers.toString()})();

class Renderer {`
  }
];

/** Every patch, in the order they are applied. */
export const PATCHES = [...EEL_PATCHES, ...ENGINE_PATCHES];

function occurrences(text, part) {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
}

/** butterchurn's dist/butterchurn.js with every patch applied; throws naming a patch that does not fit. */
export function patchButterchurn(source) {
  let text = String(source).replace(/\r\n/g, "\n");
  for (const patch of PATCHES) {
    const found = occurrences(text, patch.find);
    if (found !== (patch.count ?? 1)) {
      throw new Error(`butterchurn patch "${patch.id}" does not fit butterchurn ${BUTTERCHURN_VERSION}'s text (found ${found}×, expected ${patch.count ?? 1}) — see scripts/butterchurn-patches.mjs`);
    }
    text = text.split(patch.find).join(patch.replace);
  }
  return text;
}

/**
 * The eel-wasm inside a (patched) butterchurn as a module of its own, exporting
 * `{ compileModule, loadModule, parse }`: the build checks preset equations with the compiler
 * that ships, patches included.
 */
export function eelCompilerModule(butterchurnSource) {
  const text = String(butterchurnSource);
  const start = text.indexOf("var src = {};");
  const endMark = "var srcExports = requireSrc();";
  const end = text.indexOf(endMark);
  if (start < 0 || end < start) throw new Error("eel-wasm not found inside butterchurn");
  return `${text.slice(start, end + endMark.length)}\nexport default srcExports;\n`;
}

const BUTTERCHURN_FILE = /[\\/]node_modules[\\/]butterchurn[\\/]dist[\\/]butterchurn\.js$/;

/** Reads the installed butterchurn, patched. */
export function patchedButterchurnSource(require) {
  return patchButterchurn(readFileSync(require.resolve("butterchurn/dist/butterchurn.js"), "utf8"));
}

export function butterchurnPatches() {
  return {
    name: "tryhackx-butterchurn-patches",
    enforce: "pre",
    // The dev server would otherwise pre-bundle butterchurn without these transforms.
    config: () => ({ optimizeDeps: { exclude: ["butterchurn"] } }),
    transform(code, id) {
      if (!BUTTERCHURN_FILE.test(id.split("?")[0])) return null;
      return { code: patchButterchurn(code), map: null };
    }
  };
}
