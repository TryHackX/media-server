import assert from "node:assert/strict";
import test from "node:test";

import { initSegmentEnd, mp4Codecs, mp4MimeType } from "./mp4-codecs.ts";

/** A box: 32-bit size, four-letter type, then the payloads. */
function box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const size = 8 + body.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const part of body) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const zeros = (count: number): number[] => new Array<number>(count).fill(0);
/** A track whose stsd holds one sample entry. */
const track = (entry: Uint8Array): Uint8Array =>
  box("trak", box("mdia", box("minf", box("stbl", box("stsd", [0, 0, 0, 0, 0, 0, 0, 1], entry)))));
const video = (type: string, config: Uint8Array): Uint8Array => box(type, zeros(78), config);
const audio = (esds: Uint8Array): Uint8Array => box("mp4a", zeros(28), esds);
/** esds as FFmpeg writes it: ES_Descriptor → DecoderConfigDescriptor (MPEG-4 audio) → AudioSpecificConfig. */
const esds = (specific: number[]): Uint8Array =>
  box("esds", [0, 0, 0, 0, 0x03, 22 + specific.length, 0, 1, 0, 0x04, 15 + specific.length, 0x40, 0x15, ...zeros(11), 0x05, specific.length, ...specific]);
const header = (...tracks: Uint8Array[]): Uint8Array => {
  const ftyp = box("ftyp", [...Array.from("isom", (c) => c.charCodeAt(0)), 0, 0, 2, 0]);
  const moov = box("moov", box("mvhd", zeros(100)), ...tracks);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp);
  out.set(moov, ftyp.length);
  return out;
};

test("H.264 with AAC: the avcC profile, constraints and level, and AAC LC", () => {
  const init = header(
    track(video("avc1", box("avcC", [1, 0x64, 0x00, 0x28, 0xff, 0xe1]))),
    track(audio(esds([0x12, 0x10])))
  );
  assert.deepEqual(mp4Codecs(init), ["avc1.640028", "mp4a.40.2"]);
  assert.equal(mp4MimeType(init), 'video/mp4; codecs="avc1.640028,mp4a.40.2"');
});

test("HEVC: reversed compatibility flags, tier and level, trailing zero constraints dropped", () => {
  const main = box("hvcC", [1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93]);
  assert.deepEqual(mp4Codecs(header(track(video("hvc1", main)))), ["hvc1.1.6.L93.B0"]);
  const main10 = box("hvcC", [1, 0x22, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 153]);
  assert.deepEqual(mp4Codecs(header(track(video("hev1", main10)))), ["hev1.2.4.H153.90"]);
});

test("AV1 and VP9: profile, level, tier and bit depth", () => {
  assert.deepEqual(mp4Codecs(header(track(video("av01", box("av1C", [0x81, 0x08, 0x00, 0]))))), ["av01.0.08M.08"]);
  assert.deepEqual(mp4Codecs(header(track(video("av01", box("av1C", [0x81, 0x0d, 0xc0, 0]))))), ["av01.0.13H.10"]);
  assert.deepEqual(mp4Codecs(header(track(video("vp09", box("vpcC", [1, 0, 0, 0, 0, 31, 0x80, 0]))))), ["vp09.00.31.08"]);
});

test("HE-AAC is named by its audio object type", () => {
  assert.deepEqual(mp4Codecs(header(track(audio(esds([0x2b, 0x92, 0x08, 0x00]))))), ["mp4a.40.5"]);
});

test("the header ends with moov; before it is complete there is no end", () => {
  const init = header(track(video("avc1", box("avcC", [1, 0x42, 0xc0, 0x1e]))));
  assert.equal(initSegmentEnd(init), init.length);
  assert.equal(initSegmentEnd(init.subarray(0, init.length - 1)), -1);
  const withFragment = new Uint8Array(init.length + 16);
  withFragment.set(init);
  withFragment.set(box("moof", zeros(8)), init.length);
  assert.equal(initSegmentEnd(withFragment), init.length);
  assert.deepEqual(mp4Codecs(init.subarray(0, 20)), []);
  assert.equal(mp4MimeType(new Uint8Array(0)), null);
});

test("an unknown sample entry names nothing", () => {
  assert.deepEqual(mp4Codecs(header(track(video("mp4v", box("esds", zeros(8)))))), []);
});
