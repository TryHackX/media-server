import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_LENGTH, MESSAGES_KEY, messageText, readMessages, readSyncColour, SYNC_COLOUR_KEY, validMessage, writeMessages, writeSyncColour
} from "./geiss/messages.ts";
import {
  BAR, CHASERS, DOTS, drawTitle, GeissSim, gdiNearestIndex, GRID, NUCLIDE, SHADE, SOLAR, WINAMP_SAMPLES,
  type GeissDepth, type TitleMask, type WinampFrame
} from "./geiss/sim.ts";

// Geiss 4.30's custom messages (GEISS.INI [CUSTOM MESSAGES], the keys m##) and song titles as GDI
// drew them, and the wave colours from the music (g_bSyncColorToSound): the port against the
// original's frames, and the browser's store of messages.

/** The beating test signal of geiss.test.ts (integers only, so the reference run got the same bytes). */
function synthetic(frame: number, out: WinampFrame): void {
  const tri = (p: number): number => (p < 512 ? p : 1023 - p) - 256;
  const clamp = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v);
  const envelope = 20 + 6 * Math.max(0, 12 - (frame % 30));
  for (let i = 0; i < WINAMP_SAMPLES; i += 1) {
    out.wave[i] = clamp((tri(((frame * 576 + i) * 37) % 1024) * envelope) >> 7);
    out.wave[WINAMP_SAMPLES + i] = clamp((tri(((frame * 576 + i) * 53 + 300) % 1024) * envelope) >> 7);
    out.spectrum[i] = out.spectrum[WINAMP_SAMPLES + i] = Math.min(255, (envelope * (600 - i)) >> 8);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array, previous: number): number {
  let crc = ~previous >>> 0;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]!) & 255]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/**
 * The glyphs of the test's texts as GDI drew them in the plug-in's font (Arial Bold, 24 px cell,
 * no smoothing; read from the reference run): each a rectangle [x0, y0, x1, y1] from its pen
 * position, and its advance.
 */
const GLYPHS: Record<string, { advance: number; box: [number, number, number, number] | null }> = {
  "I": { advance: 5, box: [1, 4, 3, 18] },
  "-": { advance: 7, box: [1, 12, 6, 14] },
  "_": { advance: 11, box: [0, 21, 10, 22] },
  ".": { advance: 6, box: [1, 16, 3, 18] },
  "|": { advance: 6, box: [2, 4, 3, 22] },
  " ": { advance: 6, box: null }
};

/** A text of those glyphs as the plug-in's GDI drew it: its extent and pixels. */
function gdiText(text: string): TitleMask {
  if (text === "") return { width: 0, height: 0, left: 0, top: 0, maskWidth: 0, maskHeight: 0, mask: new Uint8Array(0) };
  const width = [...text].reduce((sum, char) => sum + GLYPHS[char]!.advance, 0);
  const mask = new Uint8Array(width * 24);
  let pen = 0;
  for (const char of text) {
    const glyph = GLYPHS[char]!;
    if (glyph.box) {
      const [x0, y0, x1, y1] = glyph.box;
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) mask[y * width + pen + x] = 1;
    }
    pen += glyph.advance;
  }
  return { width, height: 24, left: 0, top: 0, maskWidth: width, maskHeight: 24, mask };
}

/**
 * A run as the reference harness makes it (384 × 240, 60 frames a second, the signal above), its
 * screen — with the title over it as GDI drew it into the back buffer — CRC'd frame after frame
 * (at 8 bits with the palette), a mark every 60 frames. `script` is what happened before a frame.
 */
function run(depth: GeissDepth, frames: number, seed: number, script: (sim: GeissSim, frame: number) => void, options: { titles?: boolean; sync?: boolean; width?: number; height?: number } = {}): string[] {
  const width = options.width ?? 384;
  const height = options.height ?? 240;
  const sim = new GeissSim(width, height, seed, { depth, ...(options.titles ? { titles: gdiText } : {}) });
  sim.syncColorToSound = options.sync ?? false;
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  const surface = new Uint8Array(width * height * (depth / 8));
  const twice = (value: number): number => Math.min(255, value * 2);
  const marks: string[] = [];
  let crc = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    synthetic(frame, audio);
    script(sim, frame);
    sim.frame(Math.trunc((frame * 1000) / 60), audio);
    const { top, bottom } = sim.band;
    surface.fill(0);
    const vs = sim.vs1;
    if (depth === 8) {
      surface.set(vs.subarray(top * width, bottom * width), top * width);
    } else {
      for (let p = top * width; p < bottom * width; p += 1) {
        const q = p * 4;
        if (depth === 32) {
          for (let c = 0; c < 3; c += 1) surface[q + c] = twice(vs[q + c]!);
        } else {
          const word = ((twice(vs[q + 2]!) >> 3) << 11) | ((twice(vs[q + 1]!) >> 2) << 5) | (twice(vs[q]!) >> 3);
          surface[p * 2] = word & 255;
          surface[p * 2 + 1] = word >> 8;
        }
      }
    }
    drawTitle(sim, surface);
    crc = crc32(surface, crc);
    if (depth === 8) crc = crc32(sim.palette, crc);
    if ((frame + 1) % 60 === 0) marks.push(`0x${crc.toString(16).padStart(8, "0")}`);
  }
  return marks;
}

/** GEISS.INI of the reference run: MESSAGE 1 and 3; 2 is not there. */
const INI: Record<number, string> = { 1: "I_I-I", 3: "||  ||" };

/**
 * Winamp's title and the keys m##: a title pops up; message 1 over it; message 2 (none: an empty
 * popup); a new title while a message shows comes back without popping up; the next one pops up;
 * message 3 over it; message 1 again.
 */
function messages(sim: GeissSim, frame: number): void {
  const title: Record<number, string> = { 0: "I-I", 70: "II-II", 140: "I.I" };
  const message: Record<number, number> = { 15: 1, 40: 2, 160: 3, 230: 1 };
  if (title[frame] !== undefined) sim.announce(title[frame]!);
  if (message[frame] !== undefined) sim.showMessage(INI[message[frame]!] ?? "");
}

// The expected values are what Ryan Geiss's own code gives for the same input: main.cpp,
// proc_map.cpp, Effects.h and video.h compiled with MSVC for 32-bit x86, DirectDraw replaced by
// surfaces in memory whose GetDC() is a DIB section of the same format (so GDI draws the titles),
// Winamp by a host giving the window title and the keys (scratch/geiss-reference/harness_messages.cpp;
// the comparison runs are described in docs/FRONTEND.md). Above 8 bits the font was made without
// smoothing (NONANTIALIASED_QUALITY): at 8 bits GDI never smooths, and the port draws that way.
test("Geiss (Winamp) custom messages and song titles: the original's frames at 8, 16 and 32 bits", () => {
  assert.deepEqual(run(8, 300, 5, messages, { titles: true }), ["0x6b91fb42", "0x81066114", "0xa5fd2936", "0x0b12162c", "0xdaf27036"]);
  assert.deepEqual(run(16, 300, 5, messages, { titles: true }), ["0x09f6557c", "0x3872c29f", "0x61aa89c6", "0x3eabbab7", "0x2266e1ad"]);
  assert.deepEqual(run(32, 300, 5, messages, { titles: true }), ["0xf037bb93", "0x484a027e", "0x4cc7f84f", "0xc3716737", "0xdcbec50a"]);
});

/** Every map with its waveform and an effect forced, as in geiss.test.ts (keys "##", w, effects, p). */
function everyMap(sim: GeissSim, frame: number): void {
  const effects = [[CHASERS, 2], [BAR, 1], [DOTS, 1], [SOLAR, 1], [GRID, 1], [SHADE, 1], [NUCLIDE, 1]] as const;
  const mode = Math.floor(frame / 12) + 1;
  const at = frame % 12;
  if (at === 0) sim.selectMode(mode);
  if (at === 4) {
    const [effect, value] = effects[(mode - 1) % effects.length]!;
    sim.effect[effect] = value;
  }
  if (at === 6) sim.waveform = 1 + ((mode - 1) % 7);
  if (at === 8 && mode % 5 === 0) sim.randomPalette();
}

test("Geiss (Winamp) with the wave colours from the music: the original's frames, every map and waveform", () => {
  assert.deepEqual(run(32, 300, 5, everyMap, { sync: true }), ["0x8f60817b", "0x1fa48fe0", "0xde2b55d9", "0x901e0c3f", "0xaa077ac1"]);
  assert.deepEqual(run(16, 300, 5, everyMap, { sync: true }), ["0xbacd8ec7", "0x1c2f156c", "0x75965b19", "0x82e5754c", "0xa0355266"]);
  // Off (the default) it is the picture of geiss.test.ts.
  assert.deepEqual(run(32, 300, 5, everyMap), ["0x7a98f2cc", "0xe93cfbdd", "0xe5615e20", "0xd9c0f7fe", "0x43129157"]);
});

test("Geiss (Winamp) left to itself with the wave colours from the music, as the original", () => {
  const marks: string[] = [];
  const all = run(32, 900, 9, () => undefined, { sync: true, width: 320, height: 200 });
  for (let index = 4; index < all.length; index += 5) marks.push(all[index]!);
  assert.deepEqual(marks, ["0xcfa0ed90", "0x7b7641d2", "0xc0880cba"]);
});

test("a message is the title's popup: on at once, a frame longer, the title's colour, and no title after it", () => {
  const sim = new GeissSim(384, 240, 3, { depth: 32, titles: gdiText });
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  const frames = (count: number): void => {
    for (let frame = 0; frame < count; frame += 1) sim.frame(frame * 16, audio);
  };
  sim.announce("I-I");
  frames(1);
  const title = sim.titleOverlay();
  assert.equal(title?.text, "I-I");
  frames(40);
  assert.equal(sim.titleOverlay(), null);
  sim.showMessage("I.I");
  frames(1);
  assert.equal(sim.titleOverlay()?.text, "I.I");
  // A new title while the message shows: it comes back afterwards without popping up.
  sim.announce("II-II");
  frames(60);
  assert.equal(sim.titleOverlay(), null);
  frames(60);
  assert.equal(sim.titleOverlay(), null);
  // The one after does.
  sim.announce("I");
  frames(1);
  assert.equal(sim.titleOverlay()?.text, "I");
  // An empty message (none in that slot) still takes the title's place.
  sim.showMessage("");
  frames(1);
  assert.equal(sim.titleOverlay()?.text, "");
  // Without a rasteriser (popups off in the port) a message does nothing.
  const quiet = new GeissSim(384, 240, 3, { depth: 32 });
  quiet.showMessage("I");
  assert.equal(quiet.titleOverlay(), null);
});

test("GDI's colours: the palette's nearest, the first of equals; 8-bit burn-in of a palette without black at 0 or 1", () => {
  const ramp = new Uint8Array(768);
  for (let index = 0; index < 256; index += 1) ramp.set([index, index, index], index * 3);
  assert.equal(gdiNearestIndex(ramp, 225, 225, 225), 225);
  assert.equal(gdiNearestIndex(ramp, 20, 20, 20), 20);
  // Two at the same distance: the first. (GDI agreed on 22 000 palettes, Geiss's and made-up.)
  const ties = new Uint8Array(768).fill(100);
  ties.set([224, 226, 225], 3 * 3);
  ties.set([226, 224, 225], 4 * 3);
  ties.set([1, 0, 0], 7 * 3);
  ties.set([0, 1, 0], 9 * 3);
  assert.equal(gdiNearestIndex(ties, 225, 225, 225), 3);
  assert.equal(gdiNearestIndex(ties, 0, 0, 0), 7);
  // The white block: when black's nearest index is above 1 the whole box burns in.
  const sim = new GeissSim(384, 240, 7, { titles: gdiText });
  const audio: WinampFrame = { wave: new Int16Array(WINAMP_SAMPLES * 2), spectrum: new Uint8Array(WINAMP_SAMPLES * 2) };
  sim.announce("I.I");
  let burnt = -1;
  for (let frame = 0; frame < 60 && burnt < 0; frame += 1) {
    const overlay = sim.titleOverlay();
    if (overlay && frame > 0) {
      // Black only at index 2, the ink at 5: GDI's background lands above index 1 too.
      for (let index = 0; index < 256; index += 1) sim.palette.set(index === 2 ? [0, 0, 0] : index === 5 ? [225, 225, 225] : [200, 200, 200], index * 3);
    }
    sim.frame(frame * 16, audio);
    if (sim.titleOverlay() === null && overlay) {
      let count = 0;
      for (let y = 0; y < 24; y += 1) for (let x = 0; x < 16; x += 1) if (sim.vs1[(overlay.y + y) * 384 + overlay.x + x] === 225) count += 1;
      burnt = count;
    }
  }
  assert.equal(burnt, 16 * 24);
});

test("GEISS.INI's [CUSTOM MESSAGES] in the browser: values as Geiss read them, 100 slots, one key", () => {
  assert.equal(messageText("  Hello Dad - I'm in Jail!  "), "Hello Dad - I'm in Jail!");
  assert.equal(messageText("\"  quoted  \""), "  quoted  ");
  assert.equal(messageText("'single'"), "single");
  assert.equal(messageText("\"unbalanced"), "\"unbalanced");
  assert.equal([...messageText("x".repeat(400))].length, MESSAGE_LENGTH);
  assert.equal(validMessage("   "), null);
  assert.equal(validMessage("\"\""), null);
  assert.equal(validMessage("two\nlines"), null);
  assert.equal(validMessage(7), null);
  assert.equal(validMessage(" ok "), " ok ");

  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  };
  assert.equal(readMessages(storage).size, 0);
  assert.ok(writeMessages(storage, new Map([[99, " ---  Club Vinyl  --- "], [1, "Hello"]])));
  assert.equal(store.get(MESSAGES_KEY), JSON.stringify({ "01": "Hello", "99": " ---  Club Vinyl  --- " }));
  assert.deepEqual([...readMessages(storage)], [[1, "Hello"], [99, " ---  Club Vinyl  --- "]]);
  // What cannot be a message is left out; a broken value is no messages.
  store.set(MESSAGES_KEY, JSON.stringify({ "02": "", "03": 5, "100": "x", "04": "ok" }));
  assert.deepEqual([...readMessages(storage)], [[4, "ok"]]);
  store.set(MESSAGES_KEY, "{");
  assert.equal(readMessages(storage).size, 0);
  assert.ok(writeMessages(storage, new Map()));
  assert.equal(store.has(MESSAGES_KEY), false);
  assert.equal(writeMessages(null, new Map([[1, "x"]])), false);
  const refusing = { setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
  assert.equal(writeMessages(refusing, new Map([[1, "x"]])), false);

  // The wave colours' option: off unless kept on.
  assert.equal(readSyncColour(storage), false);
  assert.ok(writeSyncColour(storage, true));
  assert.equal(store.get(SYNC_COLOUR_KEY), "1");
  assert.equal(readSyncColour(storage), true);
  assert.ok(writeSyncColour(storage, false));
  assert.equal(store.has(SYNC_COLOUR_KEY), false);
  assert.equal(readSyncColour(null), false);
});
