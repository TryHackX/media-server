import assert from "node:assert/strict";
import test from "node:test";

import { containerLabel } from "./media-labels.ts";

test("the demuxer's list becomes the name of this file's format", () => {
  assert.equal(containerLabel("matroska,webm", "mkv"), "MKV");
  assert.equal(containerLabel("matroska,webm", "webm"), "WEBM");
  assert.equal(containerLabel("mov,mp4,m4a,3gp,3g2,mj2", "mp4"), "MP4");
  assert.equal(containerLabel("mov,mp4,m4a,3gp,3g2,mj2", "m4v"), "M4V");
  assert.equal(containerLabel("mpegts", "m2ts"), "M2TS");
  assert.equal(containerLabel("mpegts", "ts"), "TS");
  assert.equal(containerLabel("avi", "avi"), "AVI");
});

test("an extension that says nothing about the format leaves the family's usual name", () => {
  assert.equal(containerLabel("matroska,webm", ""), "MKV");
  assert.equal(containerLabel("matroska,webm", null), "MKV");
  assert.equal(containerLabel("mov,mp4,m4a,3gp,3g2,mj2", "bin"), "MP4");
  assert.equal(containerLabel("mpegts", undefined), "TS");
});

test("a container ffprobe names in one unknown word is shown in capitals, never as a list", () => {
  assert.equal(containerLabel("nut", "nut"), "NUT");
  assert.equal(containerLabel("somethingnew,other", "xyz"), "SOMETHINGNEW");
});

test("no container at all falls back to the extension, and to nothing", () => {
  assert.equal(containerLabel(null, "mkv"), "MKV");
  assert.equal(containerLabel("", ".MP4"), "MP4");
  assert.equal(containerLabel(undefined, undefined), null);
  assert.equal(containerLabel(" , ", ""), null);
});
