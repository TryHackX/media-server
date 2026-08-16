import assert from "node:assert/strict";
import test from "node:test";

import { supportsThumbnail } from "./library-state.ts";
import {
  cycleRepeat,
  cycleShuffle,
  nextTrackIndex,
  mergeQueueItems,
  resolveQueueDisplay,
  trimQueueItems,
  starFill
} from "./player-state.ts";

test("manual next always advances and wraps independently of repeat-one", () => {
  assert.equal(nextTrackIndex(4, 1, { automatic: false, repeat: "one", shuffle: false }), 2);
  assert.equal(nextTrackIndex(4, 3, { automatic: false, repeat: "off", shuffle: false }), 0);
});

test("automatic next respects all repeat modes", () => {
  assert.equal(nextTrackIndex(4, 1, { automatic: true, repeat: "one", shuffle: false }), 1);
  assert.equal(nextTrackIndex(4, 3, { automatic: true, repeat: "all", shuffle: false }), 0);
  assert.equal(nextTrackIndex(4, 3, { automatic: true, repeat: "off", shuffle: false }), -1);
});

test("shuffle selects a different deterministic item", () => {
  assert.equal(nextTrackIndex(5, 2, { automatic: false, repeat: "off", shuffle: true, random: () => 0 }), 3);
  assert.equal(nextTrackIndex(5, 2, { automatic: false, repeat: "off", shuffle: true, random: () => 0.999 }), 1);
});

test("repeat modes form a stable Poweramp-style cycle", () => {
  assert.equal(cycleRepeat("off"), "once");
  assert.equal(cycleRepeat("once"), "one");
  assert.equal(cycleRepeat("one"), "all");
  assert.equal(cycleRepeat("all"), "off");
});

test("shuffle modes cover current scope, whole library and folders", () => {
  assert.equal(cycleShuffle("off"), "current");
  assert.equal(cycleShuffle("current"), "all");
  assert.equal(cycleShuffle("all"), "folders");
  assert.equal(cycleShuffle("folders"), "mixed");
  assert.equal(cycleShuffle("mixed"), "off");
});

test("queue pages merge in both directions without duplicates", () => {
  const current = [{ id: 3 }, { id: 4 }];
  assert.deepEqual(mergeQueueItems(current, [{ id: 1 }, { id: 2 }, { id: 3 }], "before"), [
    { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }
  ]);
  assert.deepEqual(mergeQueueItems(current, [{ id: 4 }, { id: 5 }, { id: 6 }], "after"), [
    { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }
  ]);
});

test("thumbnail requests support lazy audio artwork", () => {
  assert.equal(supportsThumbnail("audio"), true);
  assert.equal(supportsThumbnail("other"), false);
  assert.equal(supportsThumbnail(null), false);
  assert.equal(supportsThumbnail("image"), true);
  assert.equal(supportsThumbnail("video"), true);
});

test("queue memory window drops only the opposite edge", () => {
  const items = Array.from({ length: 12 }, (_, id) => ({ id }));
  assert.deepEqual(trimQueueItems(items, "after", 5), {
    items: [{ id: 7 }, { id: 8 }, { id: 9 }, { id: 10 }, { id: 11 }],
    removedBefore: 7,
    removedAfter: 0
  });
  assert.deepEqual(trimQueueItems(items, "before", 5), {
    items: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    removedBefore: 0,
    removedAfter: 7
  });
  const short = items.slice(0, 3);
  assert.equal(trimQueueItems(short, "after", 5).items, short);
});

test("half stars remain exact", () => {
  assert.equal(starFill(3.5, 4), "half");
  assert.equal(starFill(3.4, 4), "empty");
  assert.equal(starFill(4, 4), "full");
});

test("a playlist without display rules leaves the account's queue alone", () => {
  const account = { index: true, favorite: true, rating: "own" } as const;
  assert.deepEqual(resolveQueueDisplay(account), { index: true, rating: "viewer", favorite: "viewer" });
  assert.deepEqual(resolveQueueDisplay(account, { rating: "inherit", favorite: "inherit" }),
    { index: true, rating: "viewer", favorite: "viewer" });
  assert.deepEqual(resolveQueueDisplay({ index: false, favorite: false, rating: "none" }),
    { index: false, rating: "none", favorite: "none" });
  assert.deepEqual(resolveQueueDisplay({ index: true, favorite: true, rating: "average" }).rating, "average");
});

test("a playlist overrides each half of the queue display on its own", () => {
  const account = { index: true, favorite: true, rating: "own" } as const;
  // The author's stars, the listener's hearts: two independent decisions.
  assert.deepEqual(resolveQueueDisplay(account, { rating: "owner" }),
    { index: true, rating: "owner", favorite: "viewer" });
  assert.deepEqual(resolveQueueDisplay(account, { favorite: "owner" }),
    { index: true, rating: "viewer", favorite: "owner" });
  // A list may also ask for less than the account wanted, or for more.
  assert.deepEqual(resolveQueueDisplay(account, { rating: "none", favorite: "none" }),
    { index: true, rating: "none", favorite: "none" });
  assert.deepEqual(resolveQueueDisplay({ index: true, favorite: false, rating: "none" }, { rating: "owner", favorite: "owner" }),
    { index: true, rating: "owner", favorite: "owner" });
  // The row numbers belong to the reader; no list has an opinion about them.
  assert.equal(resolveQueueDisplay({ index: false, favorite: true, rating: "own" }, { rating: "owner" }).index, false);
});
