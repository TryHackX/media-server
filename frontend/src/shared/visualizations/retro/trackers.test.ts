import assert from "node:assert/strict";
import test from "node:test";

import { RetroAnalysis, WINDOW } from "./analysis.ts";
import { AMIGA, AMIGA_TINY, FT_NOTES, FT_SMALL, FT_UI, VGA } from "./trackers/fonts.ts";
import { clock, decimal, fieldText, hex, letterEffect, modEffect, noteText } from "./trackers/notation.ts";
import { TRACKER_PRESETS } from "./trackers/presets.ts";
import { measure, mix, printable, rgb, sheet, Surface } from "./trackers/raster.ts";
import {
  Biquad, chordOf, emptyCell, hash, NOTE_NONE, noteFromFrequency, peakNote, pitchOf, ROWS, Song,
  TempoTracker, type SongSpec
} from "./trackers/song.ts";

const RATE = 48000;

test("Trackers: every preset once, a program's own name, its code fetched on first use", () => {
  const ids = TRACKER_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "preset ids collide");
  for (const id of ids) assert.match(id, /^tracker-[a-z0-9]+(-[a-z0-9]+)*$/, id);
  const names = TRACKER_PRESETS.map((preset) => preset.name);
  assert.equal(new Set(names).size, names.length, "two presets share a name");
  for (const preset of TRACKER_PRESETS) {
    assert.equal(preset.translate, false, `${preset.id}: a proper name is not translated`);
    assert.equal(typeof preset.create, "function");
  }
  for (const program of ["ProTracker", "Scream Tracker", "Fasttracker", "Impulse Tracker"]) {
    assert.ok(names.some((name) => name.startsWith(program)), `no preset for ${program}`);
  }
});

test("the fonts decode: every glyph inside its cell, fixed ones as wide as the cell", () => {
  for (const [name, definition] of Object.entries({ AMIGA, AMIGA_TINY, VGA, FT_UI, FT_NOTES, FT_SMALL })) {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    assert.ok(font.glyphs.size > 10, `${name}: ${font.glyphs.size} glyphs`);
    for (const [char, glyph] of font.glyphs) {
      assert.equal(glyph.rows.length, definition.height, `${name} "${char}": rows`);
      assert.ok(glyph.width >= 1 && glyph.width <= definition.cell, `${name} "${char}": width ${glyph.width}`);
      if (definition.fixed) assert.equal(glyph.width, definition.cell, `${name} "${char}"`);
      for (const bits of glyph.rows) assert.ok(bits >= 0 && bits < 1 << glyph.width, `${name} "${char}": a pixel outside`);
      if (char !== " " && char !== "_") assert.ok(glyph.rows.some((bits) => bits !== 0), `${name} "${char}" is empty`);
    }
  }
});

test("each screen's fonts hold every character its fixed text needs", () => {
  const has = (definition: { sheet: string; cell: number; height: number; fixed: boolean }, text: string): void => {
    const font = sheet(definition.sheet, definition.cell, definition.height, definition.fixed);
    for (const char of text) assert.ok(font.glyphs.has(char), `"${char}" missing for "${text}"`);
  };
  for (const text of ["POS", "PATTERN", "FINETUNE", "SAMPLENAME:", "EDIT OP.", "DISK OP.", "PSET-ED", "QUADRASCOPE", "SPECTRUM ANALYZER", "C#3", "0123456789ABCDEF", "00:00", "ALL RIGHT"]) has(AMIGA, text);
  for (const text of ["PROTRACKER V2.3D", "NOXIOUS JANUARY 1993", "TEMPO", "STATUS:", "REC.", "BY TRITON PROD. 1996"]) has(AMIGA_TINY, text);
  let ascii = "";
  for (let code = 32; code < 127; code += 1) ascii += String.fromCharCode(code);
  has(VGA, `${ascii}·═`);
  for (const text of ["Songlen.", "Repstart", "BPM", "Spd.", "Add.", "Ptn.", "Ln.", "Expd.", "Srnk.", "Avail 31744k", "GUS 0000k", "Time", "About", "Nibbles", "Zap", "CD-Dump", "Extend", "Transps.", "I.E.Ext.", "S.E.Ext.", "Adv. Edit", "Add", "Sub", "Play sng.", "Play ptn.", "Stop", "Rec. sng.", "Rec. ptn.", "Disk op.", "Instr. Ed.", "Smp. Ed.", "Config", "Help", "Ins.", "Del.", "01-08", "Fasttracker", "II"]) has(FT_UI, text);
  has(FT_NOTES, "ABCDEFG#-0123456789");
  has(FT_SMALL, "0123456789ABCDEF");
});

test("a sheet reads glyphs side by side; text advances by the cell or by each glyph", () => {
  const fixed = sheet("\nA    B\n#.#. ##..\n.#.. ##..\n", 4, 2, true);
  assert.deepEqual(fixed.glyphs.get("A")!.rows, [0b1010, 0b0100]);
  assert.deepEqual(fixed.glyphs.get("B")!.rows, [0b1100, 0b1100]);
  assert.equal(measure(fixed, "AB"), 8);
  const proportional = sheet("\nA    B\n#.#. ##..\n.#.. ##..\n", 4, 2, false);
  assert.equal(proportional.glyphs.get("A")!.width, 3);
  assert.deepEqual(proportional.glyphs.get("A")!.rows, [0b101, 0b010]);
  assert.equal(proportional.glyphs.get("B")!.width, 2);
  assert.equal(measure(proportional, "AB"), 3 + 1 + 2);
  // Letters the font lacks are spaces; small ones are drawn as capitals where only those exist.
  assert.equal(printable("Ab", fixed, true), "AB");
  assert.equal(printable("ąBc", fixed), "AB ");
});

test("pixels are RGBA bytes in memory, drawing is clipped, text lands where it should", () => {
  const surface = new Surface(4, 3);
  surface.fill(-2, 1, 10, 1, rgb(0x102030));
  const bytes = new Uint8Array(surface.pixels.buffer);
  assert.deepEqual([...bytes.subarray(16, 20)], [0x10, 0x20, 0x30, 255]);
  assert.equal(surface.pixels[0], 0);
  assert.equal(surface.pixels[11], 0);
  const font = sheet("\nA \n##\n#.\n", 2, 2, true);
  const target = new Surface(6, 2);
  const end = target.text(font, 1, 0, "AA", 1);
  assert.equal(end, 5);
  assert.deepEqual([...target.pixels], [0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080);
});

test("notes, numbers and effects are spelled as each tracker spelled them", () => {
  assert.equal(noteText(57), "A-4");
  assert.equal(noteText(0), "C-0");
  assert.equal(noteText(30), "F#2");
  assert.equal(noteText(NOTE_NONE), "---");
  assert.equal(noteText(-1, "..."), "...");
  assert.equal(hex(0x7d, 2), "7D");
  assert.equal(hex(5, 4), "0005");
  assert.equal(decimal(46, 3), "046");
  assert.equal(modEffect("none", 0), "000");
  assert.equal(modEffect("arpeggio", 0x37), "037");
  assert.equal(modEffect("volume", 0x20), "C20");
  assert.equal(modEffect("speed", 6), "F06");
  assert.equal(modEffect("tempo", 125), "F7D");
  assert.equal(modEffect("volumeSlide", 4), "A04");
  assert.equal(letterEffect("arpeggio", 0x47), "J47");
  assert.equal(letterEffect("tempo", 125), "T7D");
  assert.equal(letterEffect("speed", 6), "A06");
  assert.equal(letterEffect("volumeSlide", 5), "D05");
  assert.equal(letterEffect("none", 0), null);
  assert.equal(fieldText("space debris", 20, true, "_"), "SPACE DEBRIS________");
  assert.equal(clock(67), "01:07");
  assert.equal(clock(3725, true), "1:02:05");
});

test("a frequency's note: A-4 is 440 Hz, an octave is twelve", () => {
  assert.equal(noteFromFrequency(440), 57);
  assert.ok(Math.abs(noteFromFrequency(220) - 45) < 1e-9);
  assert.ok(Number.isNaN(noteFromFrequency(0)));
  assert.equal(hash(1, 2, 3), hash(1, 2, 3));
  assert.notEqual(hash(1, 2, 3), hash(1, 2, 4));
});

test("the pitch of a tone is read within a few cents; noise has none", () => {
  const rate = 16000;
  for (const frequency of [196, 440, 659.26, 1046.5]) {
    const samples = Float32Array.from({ length: 480 }, (_, index) => (Math.sin((2 * Math.PI * frequency * index) / rate) > 0 ? 0.5 : -0.5));
    const found = pitchOf(samples, rate, 180, 1800, new Float32Array(482));
    assert.ok(Math.abs(noteFromFrequency(found.frequency) - noteFromFrequency(frequency)) < 0.15, `${frequency} Hz read as ${found.frequency}`);
    assert.ok(found.clarity > 0.8);
  }
  let state = 1;
  const noise = Float32Array.from({ length: 480 }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  });
  assert.equal(pitchOf(noise, rate, 180, 1800, new Float32Array(482)).frequency, 0);
});

test("a spectrum's chord: the triad its peaks fit, and its loudest new partial", () => {
  const binHz = RATE / 2048;
  const spectrum = new Float32Array(1024).fill(0.2);
  const peak = (frequency: number, height: number): void => {
    const bin = Math.round(frequency / binHz);
    spectrum[bin] = height;
    spectrum[bin - 1] = Math.max(spectrum[bin - 1]!, height - 0.2);
    spectrum[bin + 1] = Math.max(spectrum[bin + 1]!, height - 0.2);
  };
  // A minor: A, C, E in two octaves.
  for (const frequency of [220, 261.63, 329.63, 440, 523.25, 659.26]) peak(frequency, 0.8);
  const chord = chordOf(spectrum, binHz);
  assert.ok(chord);
  assert.equal(chord.root, 9);
  assert.equal(chord.minor, true);
  const before = Float32Array.from(spectrum);
  peak(987.77, 0.75);
  assert.equal(Math.round(peakNote(spectrum, binHz, 200, 2000, before)) % 12, 11);
  assert.equal(chordOf(new Float32Array(1024), binHz), null);
});

test("the tempo is the kicks' median spacing, folded into 80–180 BPM", () => {
  const tempo = new TempoTracker();
  assert.equal(tempo.bpm, 125);
  for (let beat = 0; beat < 24; beat += 1) tempo.beat(beat * 0.5);
  assert.ok(Math.abs(tempo.bpm - 120) < 1, `${tempo.bpm}`);
  // Kicks on every other beat at 150 BPM read as 150, not 75.
  const half = new TempoTracker();
  for (let beat = 0; beat < 24; beat += 1) half.beat(beat * 0.8);
  assert.ok(Math.abs(half.bpm - 150) < 1, `${half.bpm}`);
  // One stray kick does not shake it.
  const steady = new TempoTracker();
  for (let beat = 0; beat < 16; beat += 1) steady.beat(beat * 0.48);
  steady.beat(16 * 0.48 - 0.13);
  steady.beat(17 * 0.48);
  assert.ok(Math.abs(steady.bpm - 125) < 3, `${steady.bpm}`);
});

test("a low-pass filter keeps the bass and drops the treble", () => {
  const amplitude = (frequency: number): number => {
    const filter = new Biquad("lowpass", 200, RATE);
    let peak = 0;
    for (let index = 0; index < RATE / 10; index += 1) {
      const out = filter.step(Math.sin((2 * Math.PI * frequency * index) / RATE));
      if (index > RATE / 20) peak = Math.max(peak, Math.abs(out));
    }
    return peak;
  };
  assert.ok(amplitude(60) > 0.9);
  assert.ok(amplitude(4000) < 0.01);
});

/** Kicks on every beat, hats between, a bass note an eighth: test music at `bpm`. */
function music(seconds: number, bpm: number, silentFrom = Infinity): { left: Float32Array; right: Float32Array } {
  const length = Math.round(seconds * RATE);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const beat = 60 / bpm;
  const bass = [55, 55, 110, 55, 65.4, 65.4, 130.8, 49];
  for (let index = 0; index < length; index += 1) {
    const t = index / RATE;
    if (t >= silentFrom) break;
    const inBeat = t % beat;
    const kick = Math.sin(2 * Math.PI * (45 * inBeat + 4 * (1 - Math.exp(-inBeat * 18)))) * Math.exp(-inBeat * 14) * 0.8;
    const eighth = Math.floor((t / beat) * 2);
    const inEighth = t % (beat / 2);
    const hat = Math.sin(index * 2.7) * Math.sin(index * 1.31) * Math.exp(-inEighth * 60) * (eighth % 2 ? 0.25 : 0);
    const low = Math.sin(2 * Math.PI * bass[eighth % bass.length]! * t) * 0.3 * (0.6 + 0.4 * Math.exp(-inEighth * 6));
    left[index] = kick + hat + low;
    right[index] = kick + hat * 0.6 + low;
  }
  return { left, right };
}

const SPEC: SongSpec = {
  channels: [{ parts: ["kick", "snare"] }, { parts: ["bass"] }, { parts: ["lead"] }, { parts: ["snare", "hats", "chord"] }],
  low: 12,
  high: 47,
  drums: { kick: 36, snare: 38, hats: 42 },
  floors: { bass: 12, lead: 24, chord: 24 },
  instruments: { kick: 1, snare: 2, hats: 3, bass: 5, lead: 6, chord: 7, echo: 8 },
  positions: 128
};

/** Plays `left`/`right` into a Song at 60 frames a second; `each` sees every frame. */
function play(song: Song, left: Float32Array, right: Float32Array, title = "Test", each?: (time: number) => void): void {
  const analysis = new RetroAnalysis();
  const frame = RATE / 60;
  for (let index = 0; (index + 1) * frame <= left.length; index += 1) {
    const end = Math.round((index + 1) * frame);
    for (let sample = 0; sample < WINDOW; sample += 1) {
      const at = end - WINDOW + sample;
      analysis.left[sample] = at >= 0 ? left[at]! : 0;
      analysis.right[sample] = at >= 0 ? right[at]! : 0;
    }
    analysis.update(Math.round(frame), RATE, 1 / 60);
    song.update(analysis, { title, position: 0, duration: 0 }, 1 / 60);
    each?.((index + 1) / 60);
  }
}

test("the song keeps time with the kicks: tempo, four rows a beat, kicks on the beat rows", () => {
  const song = new Song(SPEC);
  const { left, right } = music(14, 140);
  const cell = emptyCell();
  let kicks = 0;
  let onBeat = 0;
  let last = -1;
  play(song, left, right, "Test", (time) => {
    // Once the tempo has settled, each row as it is settled two rows above the play row.
    const settled = song.current - 2;
    if (time < 6 || settled <= last || song.row < 2) return;
    last = settled;
    song.cell(0, song.row - 2, cell);
    if (cell.instrument !== 1) return;
    kicks += 1;
    if ((song.row - 2) % 4 === 0) onBeat += 1;
  });
  assert.ok(Math.abs(song.bpm - 140) <= 3, `tempo ${song.bpm}`);
  // 14 s at 140 BPM is some 130 rows: two patterns and more.
  assert.ok(song.position >= 1, `position ${song.position}`);
  assert.ok(kicks >= 8, `${kicks} kicks`);
  assert.ok(onBeat / kicks > 0.8, `${onBeat} of ${kicks} kicks on the beat rows`);
});

test("rows played keep what was written in them; the bass is read as notes", () => {
  const song = new Song(SPEC);
  const { left, right } = music(8, 125);
  const cell = emptyCell();
  const snapshot = new Map<number, string>();
  let checked = 0;
  play(song, left, right, "Test", () => {
    // Two rows above the play row, a row is settled: it must not change while it stays in view.
    const settled = song.row - 2;
    if (settled < 0) return;
    const key = song.current - 2;
    const text = [0, 1, 2, 3].map((channel) => {
      song.cell(channel, settled, cell);
      return `${cell.note}/${cell.instrument}/${cell.volume}/${cell.effect}/${cell.param}`;
    }).join("|");
    const seen = snapshot.get(key);
    if (seen === undefined) snapshot.set(key, text);
    else {
      assert.equal(text, seen, `row ${key} changed`);
      checked += 1;
    }
  });
  assert.ok(checked > 100);
  let bassNotes = 0;
  for (let row = 0; row < ROWS; row += 1) {
    song.cell(1, row, cell);
    if (cell.note >= SPEC.low && cell.note <= SPEC.high && cell.instrument === 5) bassNotes += 1;
  }
  assert.ok(bassNotes >= 4, `${bassNotes} bass notes`);
});

test("in silence the rows stop and the meters fall; a new track starts the song again", () => {
  const song = new Song(SPEC);
  const { left, right } = music(9, 125, 5);
  let rowAtSilence = -1;
  play(song, left, right, "One", (time) => {
    if (time > 5.6 && rowAtSilence < 0) rowAtSilence = song.current;
  });
  assert.equal(song.playing, false);
  assert.equal(song.current, rowAtSilence);
  for (let channel = 0; channel < 4; channel += 1) assert.ok(song.level(channel) < 0.05, `channel ${channel} still at ${song.level(channel)}`);
  const position = song.position;
  assert.ok(position >= 0);
  const fresh = music(1, 125);
  play(song, fresh.left, fresh.right, "Two");
  assert.ok(song.current < 20, `a new track restarts the rows (${song.current})`);
});

test("the scopes are flat before a channel's first note and within −1…1 after", () => {
  const song = new Song(SPEC);
  const wave = new Float32Array(40);
  song.scope(2, wave, 0.02, RATE);
  assert.ok(wave.every((value) => value === 0));
  const { left, right } = music(3, 125);
  play(song, left, right);
  song.scope(0, wave, 0.02, RATE);
  assert.ok(wave.some((value) => value !== 0));
  assert.ok(wave.every((value) => value >= -1 && value <= 1));
});
