import assert from "node:assert/strict";
import test from "node:test";

import { collectionQueueKey, decadeLabel, itemIconName, positiveId, resolutionLabel } from "./library-labels.ts";

test("an id from an address is a positive whole number or nothing", () => {
  assert.equal(positiveId("42"), 42);
  assert.equal(positiveId("0"), null);
  assert.equal(positiveId("-3"), null);
  assert.equal(positiveId("4.5"), null);
  assert.equal(positiveId("12abc"), null);
  assert.equal(positiveId(""), null);
  assert.equal(positiveId("  "), null);
  assert.equal(positiveId(null), null);
  assert.equal(positiveId("9007199254740993"), null);
});

test("a decade is its years, in every language", () => {
  assert.equal(decadeLabel(1990), "1990–1999");
  assert.equal(decadeLabel("2010"), "2010–2019");
  assert.equal(decadeLabel("nieznana"), "nieznana");
  assert.equal(decadeLabel(""), "");
});

test("a playlist queue is told apart by its order, and a shuffled one by its seed too", () => {
  assert.equal(collectionQueueKey(7, "title_asc", "abc"), "collection:7|title_asc");
  assert.equal(collectionQueueKey(7, "random", "abc"), "collection:7|random:abc");
  assert.notEqual(collectionQueueKey(7, "random", "abc"), collectionQueueKey(7, "random", "abd"));
});

test("the width names the picture, the height only breaks ties", () => {
  assert.equal(resolutionLabel({ video_width: 1920, video_height: 800 }), "1080p");
  assert.equal(resolutionLabel({ video_width: 1920, video_height: 1080 }), "1080p");
  assert.equal(resolutionLabel({ video_width: 3840, video_height: 1600 }), "4K");
  assert.equal(resolutionLabel({ video_width: 1280, video_height: 720 }), "720p");
  assert.equal(resolutionLabel({ video_width: 1440, video_height: 1080 }), "1080p");
  assert.equal(resolutionLabel({ video_width: 7680, video_height: 4320 }), "8K");
  assert.equal(resolutionLabel({ video_width: 720, video_height: 576 }), "720×576");
  assert.equal(resolutionLabel({ video_width: 0, video_height: 1080 }), null);
  assert.equal(resolutionLabel({}), null);
});

test("a file is shown with the icon of what it is", () => {
  assert.equal(itemIconName({ media_kind: "audio" }), "music");
  assert.equal(itemIconName({ media_kind: "video" }), "film");
  assert.equal(itemIconName({ media_kind: "image" }), "image");
  assert.equal(itemIconName({ media_kind: "other", file_extension: "torrent" }), "magnet");
  assert.equal(itemIconName({ media_kind: "other", file_extension: "7z" }), "archive");
  assert.equal(itemIconName({ media_kind: "other", file_extension: "nfo" }), "file");
  assert.equal(itemIconName({ media_kind: "other" }), "file");
});

test("a mark on the picture names a class, never a measurement", async () => {
  const { resolutionBadge } = await import("./library-labels.ts");
  assert.equal(resolutionBadge({ video_width: 3840, video_height: 2160 }), "4K");
  assert.equal(resolutionBadge({ video_width: 1920, video_height: 800 }), "1080p");
  assert.equal(resolutionBadge({ video_width: 1280, video_height: 720 }), "720p");
  assert.equal(resolutionBadge({ video_width: 640, video_height: 480 }), null);
  assert.equal(resolutionBadge({ video_width: 720, video_height: 576 }), null);
  assert.equal(resolutionBadge({ video_width: null, video_height: null }), null);
});
