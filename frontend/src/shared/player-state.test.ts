import assert from "node:assert/strict";
import test from "node:test";

import { supportsThumbnail } from "./library-state.ts";
import {
  cycleRepeat,
  cycleShuffle,
  findInPages,
  nextTrackIndex,
  resumePoint,
  nextUnplayedIndex,
  queueSourceView,
  storedLevel,
  mergeQueueItems,
  resolveQueueDisplay,
  trimQueueItems,
  starFill
} from "./player-state.ts";

test("manual next always advances and wraps independently of repeat-one", () => {
  assert.equal(nextTrackIndex(4, 1, { automatic: false, repeat: "one" }), 2);
  assert.equal(nextTrackIndex(4, 3, { automatic: false, repeat: "off" }), 0);
});

test("automatic next respects all repeat modes", () => {
  assert.equal(nextTrackIndex(4, 1, { automatic: true, repeat: "one" }), 1);
  assert.equal(nextTrackIndex(4, 3, { automatic: true, repeat: "all" }), 0);
  assert.equal(nextTrackIndex(4, 3, { automatic: true, repeat: "off" }), -1);
});

test("window shuffle picks only tracks the pass has not played", () => {
  const ids = [10, 11, 12, 13, 14];
  assert.deepEqual(nextUnplayedIndex(ids, 2, new Set([12]), { automatic: false, repeat: "off", random: () => 0 }), { index: 0, restart: false });
  assert.deepEqual(nextUnplayedIndex(ids, 2, new Set([10, 12]), { automatic: false, repeat: "off", random: () => 0 }), { index: 1, restart: false });
  assert.deepEqual(nextUnplayedIndex(ids, 2, new Set([12]), { automatic: false, repeat: "off", random: () => 0.999 }), { index: 4, restart: false });
});

test("a whole pass of window shuffle deals every track exactly once", () => {
  const ids = Array.from({ length: 40 }, (_, position) => 100 + position);
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let current = 0;
  const played = new Set([ids[0]!]);
  const order = [ids[0]!];
  for (;;) {
    const choice = nextUnplayedIndex(ids, current, played, { automatic: true, repeat: "off", random });
    if (choice.index < 0) break;
    current = choice.index;
    played.add(ids[current]!);
    order.push(ids[current]!);
  }
  assert.equal(order.length, ids.length);
  assert.equal(new Set(order).size, ids.length);
});

test("the end of a window shuffle pass stops, or starts over when asked to", () => {
  const ids = [1, 2, 3];
  const all = new Set(ids);
  assert.deepEqual(nextUnplayedIndex(ids, 1, all, { automatic: true, repeat: "off", random: () => 0 }), { index: -1, restart: false });
  assert.deepEqual(nextUnplayedIndex(ids, 1, all, { automatic: true, repeat: "all", random: () => 0 }), { index: 0, restart: true });
  assert.deepEqual(nextUnplayedIndex(ids, 1, all, { automatic: false, repeat: "off", random: () => 0.999 }), { index: 2, restart: true });
  assert.deepEqual(nextUnplayedIndex([5], 0, new Set([5]), { automatic: true, repeat: "all" }), { index: 0, restart: true });
  assert.deepEqual(nextUnplayedIndex(ids, 1, new Set(), { automatic: true, repeat: "one" }), { index: 1, restart: false });
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

test("the dock names where the queue plays from", () => {
  assert.deepEqual(queueSourceView(null), null);
  assert.deepEqual(
    queueSourceView({ kind: "collection", id: 7, query: "", label: "Ulubione", smart: true }),
    { kind: "smart", name: "Ulubione", path: "music/?collection=7" }
  );
  assert.deepEqual(
    queueSourceView({ kind: "collection", id: 8, query: "", label: "Lato" }),
    { kind: "playlist", name: "Lato", path: "music/?collection=8" }
  );
  assert.deepEqual(
    queueSourceView({ kind: "directory", id: 3, query: "a&b", label: "a&b" }),
    { kind: "search", name: "a&b", path: "music/?directory=3&q=a%26b" }
  );
  assert.deepEqual(queueSourceView({ kind: "directory", id: 4, query: "", label: "Rock" }), { kind: "folder", name: "Rock", path: "music/?directory=4" });
  assert.deepEqual(queueSourceView({ kind: "directory", id: 1, query: "", label: "" }), { kind: "library", name: "", path: "music/" });
  // Stored by an older build: no label, so no claim that it is the whole library.
  assert.deepEqual(queueSourceView({ kind: "directory", id: 5, query: "" }), { kind: "folder", name: "", path: "music/?directory=5" });
});

/** A 300-track ordered listing served 100 rows a page, counting the requests. */
function pagedListing(total: number, size = 100): { fetch: (page: number) => Promise<{ items: { id: number }[]; has_more: boolean }>; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    fetch: async (page) => {
      asked.push(page);
      const start = (page - 1) * size;
      const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, row) => ({ id: 1000 + start + row }));
      return { items, has_more: start + size < total };
    }
  };
}

test("turning shuffle off finds track 150 of 300 past the loaded page", async () => {
  const listing = pagedListing(300);
  // Page 1 is already on screen; the track is the 150th, on page 2.
  const found = await findInPages(1000 + 149, 2, 10, listing.fetch);
  assert.equal(found.found, true);
  assert.deepEqual(listing.asked, [2]);
  assert.equal(found.items.length, 100);
  assert.equal(found.items[0]!.id, 1100);
  assert.equal(found.nextPage, 3);
  assert.equal(found.hasMore, true);
});

test("the search stops at the end of the list and at its page budget", async () => {
  const short = pagedListing(250);
  const missing = await findInPages(5, 2, 10, short.fetch);
  assert.equal(missing.found, false);
  assert.deepEqual(short.asked, [2, 3]);
  assert.equal(missing.hasMore, false);

  const long = pagedListing(5000);
  const far = await findInPages(1000 + 4999, 2, 3, long.fetch);
  assert.equal(far.found, false);
  assert.deepEqual(long.asked, [2, 3, 4]);
  assert.equal(far.nextPage, 5);
  assert.equal(far.hasMore, true);
});

test("a restored track resumes from the newer record of the same track", () => {
  const snapshot = { currentId: 7, savedAt: 1000, position: 12, playing: true, listenedSeconds: 10, playbackCounted: false };
  // Every few seconds of playback only the small record is written.
  assert.deepEqual(
    resumePoint(snapshot, { mediaItemId: 7, savedAt: 9000, position: 95.5, playing: false, listenedSeconds: 90, playbackCounted: true }),
    { position: 95.5, playing: false, listenedSeconds: 90, counted: true }
  );
  // A record about another track, or older than the snapshot, is ignored.
  const fromSnapshot = { position: 12, playing: true, listenedSeconds: 10, counted: false };
  assert.deepEqual(resumePoint(snapshot, { mediaItemId: 8, savedAt: 9000, position: 95 }), fromSnapshot);
  assert.deepEqual(resumePoint(snapshot, { mediaItemId: 7, savedAt: 500, position: 95 }), fromSnapshot);
  assert.deepEqual(resumePoint(snapshot, null), fromSnapshot);
  // A snapshot written by an older build has no timestamp; a record is newer than it.
  assert.equal(resumePoint({ currentId: 7, position: 3 }, { mediaItemId: 7, savedAt: 1, position: 40 }).position, 40);
  // Garbage in storage never becomes a negative or NaN second.
  assert.deepEqual(resumePoint({ currentId: null, position: "x", listenedSeconds: -4 }, null), { position: 0, playing: false, listenedSeconds: 0, counted: false });
});

test("a volume read from storage is a level the element will take, whatever was stored", () => {
  assert.equal(storedLevel("0.35", 0.9), 0.35);
  assert.equal(storedLevel("0", 0.9), 0);
  assert.equal(storedLevel("1", 0.9), 1);
  // Nothing stored, or nothing usable: the default — never NaN, which `media.volume` throws on.
  assert.equal(storedLevel(null, 0.9), 0.9);
  assert.equal(storedLevel(undefined, 0.8), 0.8);
  assert.equal(storedLevel("", 0.9), 0.9);
  assert.equal(storedLevel("abc", 0.9), 0.9);
  assert.equal(storedLevel("NaN", 0.9), 0.9);
  // Out of range is brought into it rather than thrown on.
  assert.equal(storedLevel("1.5", 0.9), 1);
  assert.equal(storedLevel("-2", 0.9), 0);
  assert.equal(storedLevel("Infinity", 0.9), 0.9);
});
