import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const util = require("./webvsc/lib/util.js");

/** AVS's saved strings, one after another: a 32-bit length (with the NUL), then the bytes. */
function savedStrings(...texts) {
  const parts = texts.map((text) => {
    const bytes = new Uint8Array(4 + text.length + 1);
    new DataView(bytes.buffer).setUint32(0, text.length + 1, true);
    for (let index = 0; index < text.length; index += 1) bytes[4 + index] = text.charCodeAt(index);
    return bytes;
  });
  const blob = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    blob.set(part, at);
    at += part.length;
  }
  return blob;
}

test("Bump's code: per frame first, on beat second, init third, as r_bump.cpp saves it", () => {
  const blob = savedStrings("x=0.5+cos(t)*0.3; y=0.5+sin(t)*0.3; t=t+0.1;", "x=rand(100)/100;", "t=0;");
  const [code, size] = util.getCodeFBI(blob, 0);
  assert.equal(code.perFrame, "x=0.5+cos(t)*0.3; y=0.5+sin(t)*0.3; t=t+0.1;");
  assert.equal(code.onBeat, "x=rand(100)/100;");
  assert.equal(code.init, "t=0;");
  assert.equal(size, blob.length);
});

test("Dynamic Shift's code stays init, per frame, on beat (r_shift.cpp)", () => {
  const [code] = util.getCodeIFB(savedStrings("d=0;", "x=sin(d)*1.4; y=1.4*cos(d); d=d+0.01;", "d=d+2.0"), 0);
  assert.deepEqual([code.init, code.perFrame, code.onBeat], ["d=0;", "x=sin(d)*1.4; y=1.4*cos(d); d=d+0.01;", "d=d+2.0"]);
});

test("an effect list's code block is known by its name, whatever effect number it was saved with", () => {
  const { convertBlob } = require("./webvsc/browser.js");
  const int = (value) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  };
  const join = (...parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const name = new Uint8Array(32);
  name.set([..."AVS 2.8+ Effect List Config"].map((letter) => letter.charCodeAt(0)));
  const code = join(int(1), savedStrings("n=0;", "n=n+1;"));
  // The list's settings as AVS 2.8 saves them (extended, 36 bytes), then the code block under
  // the effect number one of the VISBOT presets has (20374860) instead of 16384.
  const settings = join(new Uint8Array([0x80, 0, 0, 0, 0x24]), int(0x80), int(0x80), new Uint8Array(24));
  const list = join(settings, int(20374860), name, int(code.length), code);
  const header = join(new Uint8Array([..."Nullsoft AVS Preset 0.2\x1a"].map((letter) => letter.charCodeAt(0))), new Uint8Array([0]));
  const preset = convertBlob(join(header, int(0xfffffffe), int(list.length), list), "list", undefined, { quiet: true });
  const [effectList] = preset.components;
  assert.equal(effectList.type, "EffectList");
  assert.deepEqual(effectList.components, []);
  assert.deepEqual([effectList.code.enabled, effectList.code.init, effectList.code.perFrame], [true, "n=0;", "n=n+1;"]);
});

test("Text's shifts are signed, as r_text.cpp keeps them", () => {
  const { convertBlob } = require("./webvsc/browser.js");
  const bytes = [];
  const int = (value) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value, true); bytes.push(...b); };
  const text = (value, size) => { const b = new Uint8Array(size); b.set([...value].map((c) => c.charCodeAt(0))); bytes.push(...b); };
  // enabled, color, blend and its 50/50 flag, onbeat, insertBlanks, randomPos, valign, halign, speeds
  for (const value of [1, 0xffffff, 1, 0, 0, 0, 0, 4, 1, 15, 15]) int(value);
  bytes.push(...new Uint8Array(60)); // the CHOOSEFONT block AVS keeps
  // LOGFONT: height, width, escapement, orientation, weight, italic/underline/strikeout/charset, 4 bytes, name
  for (const value of [-15, 0, 0, 0, 400]) int(value);
  bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  text("Arial", 32);
  int(2); text("A", 2); // the text: its length with the NUL, then the letters
  int(0); int(0); // outline, outline colour
  int(-8); int(-4); // x and y shift
  int(1); int(0); int(0);
  const component = Uint8Array.from(bytes);
  const header = [..."Nullsoft AVS Preset 0.2\x1a"].map((c) => c.charCodeAt(0));
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, component.length, true);
  const blob = Uint8Array.from([...header, 0, 0x1c, 0, 0, 0, ...size, ...component]);
  const [textEffect] = convertBlob(blob, "text", undefined, { quiet: true }).components;
  assert.equal(textEffect.type, "Text");
  assert.equal(textEffect.text, "A");
  assert.deepEqual([textEffect.shiftX, textEffect.shiftY], [-8, -4]);
});

/** A preset of top-level effects: [code][size][config], an APE with its 32-byte id after the code. */
function presetOf(...effects) {
  const int = (value) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  };
  const parts = [new Uint8Array([..."Nullsoft AVS Preset 0.2\x1a"].map((letter) => letter.charCodeAt(0))), new Uint8Array([0])];
  for (const { code, id, config } of effects) {
    parts.push(int(code));
    if (id !== undefined) {
      const name = new Uint8Array(32);
      name.set([...id].map((letter) => letter.charCodeAt(0)));
      parts.push(name);
    }
    parts.push(int(config.length), config);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const ints = (...values) => new Uint8Array(new Int32Array(values).buffer);

test("plug-in ids AVS ran as its own effects (rlib.cpp) convert as those effects", () => {
  const { convertBlob } = require("./webvsc/browser.js");
  // Winamp Mosaic v1 is the built-in Mosaic: enabled, quality, quality2, blend, blendavg, onbeat, durFrames.
  const preset = convertBlob(presetOf({ code: 16384, id: "Winamp Mosaic v1", config: ints(1, 30, 50, 0, 1, 0, 15) }), "m", undefined, { quiet: true });
  assert.equal(preset.components[0].type, "Mosaic");
});

test("plug-ins the engine runs through its host keep their id and config bytes", () => {
  const { convertBlob } = require("./webvsc/browser.js");
  const preset = convertBlob(presetOf(
    { code: 16385, id: "Misc: Buffer blend", config: ints(1, 0, 8, 5) },
    { code: 16386, id: "Some Unknown APE", config: new Uint8Array([7, 8, 9]) },
    { code: 16387, id: "Holden05: Multi Delay", config: ints(2, 4) },
    { code: 16388, id: "FunkyFX FyrewurX v1", config: ints(0, 0xff0000) }
  ), "p", undefined, { quiet: true });
  const [blend, unknown, delay, fyrewurx] = preset.components;
  assert.deepEqual(blend, { type: "Ape", group: "Misc", apeId: "Misc: Buffer blend", config: Buffer.from(ints(1, 0, 8, 5)).toString("base64") });
  assert.deepEqual([unknown.type, unknown.apeId, unknown.config], ["Ape", "Some Unknown APE", "BwgJ"]);
  assert.deepEqual([delay.type, delay.config], ["MultiDelay", Buffer.from(ints(2, 4)).toString("base64")]);
  // FyrewurX: the engine's look-alike type, with the bytes for a port of the plug-in (vendor/avs-apes).
  assert.deepEqual(fyrewurx, { type: "FyrewurX", group: "Misc", apeId: "FunkyFX FyrewurX v1", config: Buffer.from(ints(0, 0xff0000)).toString("base64") });
});

test("AVI as r_avi.cpp loads it: each int only while bytes remain, AVS's defaults otherwise", () => {
  const { convertBlob } = require("./webvsc/browser.js");
  const name = new Uint8Array([..."FIREBOTTOM.AVI\0"].map((letter) => letter.charCodeAt(0)));
  const full = new Uint8Array([...ints(1, 0, 1), ...name, ...ints(1, 12, 40)]);
  const [avi] = convertBlob(presetOf({ code: 0x20, config: full }), "a", undefined, { quiet: true }).components;
  assert.deepEqual(avi, { type: "AVI", group: "Render", enabled: true, blend: 0, blendavg: 1, file: "FIREBOTTOM.AVI", adapt: 1, persist: 12, speed: 40 });
  const short = new Uint8Array([...ints(1, 1, 0), ...name]);
  const [old] = convertBlob(presetOf({ code: 0x20, config: short }), "b", undefined, { quiet: true }).components;
  assert.deepEqual([old.blend, old.blendavg, old.adapt, old.persist, old.speed], [1, 0, 0, 6, 0]);
});

test("an effect list's settings as r_list.cpp reads them: the effects start right after what fits", () => {
  const { convertBlob } = require("./webvsc/browser.js");
  const fadeout = [...ints(3), ...ints(8), ...ints(1, 0x101010)]; // Fadeout: code 3, 8 bytes
  // No extended settings (mode bit, size byte 0): the effects start at byte 5 (lone — Shirka's eye).
  const bare = new Uint8Array([0x80, 0, 0, 0, 0, ...fadeout]);
  const [list] = convertBlob(presetOf({ code: 0xfffffffe, config: bare }), "l", undefined, { quiet: true }).components;
  assert.equal(list.type, "EffectList");
  assert.deepEqual(list.components.map((c) => c.type), ["FadeOut"]);
  assert.equal(list.enableOnBeat, undefined);
  // 28 bytes (six settings): "enable on beat" is not read; the first effect's number is not it.
  const dotPlane = [...ints(1), ...ints(0)];
  const short = new Uint8Array([0x80, 0, 0, 1, 28, ...ints(128, 128, 0, 0, 0, 0), ...dotPlane, ...fadeout]);
  const [old] = convertBlob(presetOf({ code: 0xfffffffe, config: short }), "o", undefined, { quiet: true }).components;
  assert.equal(old.enableOnBeat, undefined);
  assert.equal(old.components.length, 2);
  // 36 bytes: all eight.
  const full = new Uint8Array([0x80, 0, 0, 1, 36, ...ints(128, 128, 0, 0, 0, 0, 1, 12), ...fadeout]);
  const [modern] = convertBlob(presetOf({ code: 0xfffffffe, config: full }), "m", undefined, { quiet: true }).components;
  assert.deepEqual([modern.enableOnBeat, modern.enableOnBeatFor, modern.components.length], [true, 12, 1]);
});
