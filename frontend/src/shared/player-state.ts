export type RepeatMode = "off" | "once" | "one" | "all";
export type ShuffleMode = "off" | "current" | "all" | "folders" | "mixed";

export function cycleRepeat(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "once";
  if (mode === "once") return "one";
  if (mode === "one") return "all";
  return "off";
}

export function cycleShuffle(mode: ShuffleMode): ShuffleMode {
  if (mode === "off") return "current";
  if (mode === "current") return "all";
  if (mode === "all") return "folders";
  if (mode === "folders") return "mixed";
  return "off";
}

/** The next position in order: the track itself on repeat, a wrap on "all", -1 at the end. */
export function nextTrackIndex(
  length: number,
  current: number,
  options: {
    automatic: boolean;
    repeat: RepeatMode;
  }
): number {
  if (length <= 0 || current < 0 || current >= length) return -1;
  if (options.automatic && (options.repeat === "one" || options.repeat === "once")) return current;
  if (current + 1 < length) return current + 1;
  if (options.repeat === "all" || !options.automatic) return 0;
  return -1;
}

/**
 * A random next track that this pass has not played yet.
 *
 * This replaced a pick from the whole window with replacement, which is what made
 * shuffle feel like it kept coming back to the same songs. Once every track has
 * had its turn the pass ends: a new one starts (`restart`) when the listener asked
 * for it — repeat "all", or a press of "next" — and playback stops otherwise,
 * exactly where an ordered list would have stopped.
 */
export function nextUnplayedIndex(
  ids: readonly number[],
  current: number,
  played: ReadonlySet<number>,
  options: { automatic: boolean; repeat: RepeatMode; random?: () => number }
): { index: number; restart: boolean } {
  const length = ids.length;
  if (length <= 0 || current < 0 || current >= length) return { index: -1, restart: false };
  if (options.automatic && (options.repeat === "one" || options.repeat === "once")) return { index: current, restart: false };
  const random = options.random ?? Math.random;
  const pick = (candidates: number[]): number =>
    candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, random()) * candidates.length))]!;
  const positions = ids.map((_, position) => position).filter((position) => position !== current);
  const fresh = positions.filter((position) => !played.has(ids[position]!));
  if (fresh.length > 0) return { index: pick(fresh), restart: false };
  if (options.automatic && options.repeat !== "all") return { index: -1, restart: false };
  return positions.length > 0 ? { index: pick(positions), restart: true } : { index: current, restart: true };
}

/**
 * Page through an ordered listing until one track turns up.
 *
 * A playlist page holds a hundred rows, and the page on screen holds however
 * many were scrolled into view; the track that is playing can be anywhere after
 * them. Turning shuffle off used to look for it among the rows already loaded
 * only, miss it on a long list, and start the list over from its first row — a
 * different song, mid-listen. The search is bounded: a track further down than
 * `maxPages` pages is not worth a burst of requests, and the caller keeps it
 * playing at the head of the queue instead.
 */
export async function findInPages<T extends { id: number }>(
  id: number,
  firstPage: number,
  maxPages: number,
  fetchPage: (page: number) => Promise<{ items: T[]; has_more: boolean }>
): Promise<{ items: T[]; found: boolean; nextPage: number; hasMore: boolean }> {
  const items: T[] = [];
  let page = firstPage;
  let hasMore = true;
  for (let fetched = 0; fetched < maxPages && hasMore; fetched += 1) {
    const data = await fetchPage(page);
    page += 1;
    hasMore = data.has_more;
    items.push(...data.items);
    if (data.items.some((item) => item.id === id)) return { items, found: true, nextPage: page, hasMore };
  }
  return { items, found: false, nextPage: page, hasMore };
}

/** Where a restored track picks up, and whether it was playing and already counted. */
export interface PlaybackPoint {
  position: number;
  playing: boolean;
  listenedSeconds: number;
  counted: boolean;
}

type StoredPoint = {
  savedAt?: unknown;
  position?: unknown;
  playing?: unknown;
  listenedSeconds?: unknown;
  playbackCounted?: unknown;
};

/**
 * The second the restored track resumes from.
 *
 * The queue snapshot is written when the queue or the track changes; the small
 * progress record every few seconds of playback. The record wins when it is about
 * the same track and no older than the snapshot — anything else is a record left
 * by a track that has since been replaced, and its second would land in the
 * middle of the wrong song.
 */
export function resumePoint(
  snapshot: StoredPoint & { currentId: number | null },
  progress: (StoredPoint & { mediaItemId?: unknown }) | null
): PlaybackPoint {
  const amount = (value: unknown): number => Math.max(0, Number(value) || 0);
  const fresher = progress !== null
    && snapshot.currentId !== null
    && progress.mediaItemId === snapshot.currentId
    && amount(progress.savedAt) >= amount(snapshot.savedAt);
  const source: StoredPoint = fresher ? progress : snapshot;
  return {
    position: amount(source.position),
    playing: source.playing === true,
    listenedSeconds: amount(source.listenedSeconds),
    counted: source.playbackCounted === true
  };
}

export function mergeQueueItems<T extends { id: number }>(
  current: T[],
  incoming: T[],
  direction: "before" | "after"
): T[] {
  const known = new Set(current.map((item) => item.id));
  const unique = incoming.filter((item) => !known.has(item.id));
  return direction === "before" ? [...unique, ...current] : [...current, ...unique];
}

export function trimQueueItems<T>(
  items: T[],
  direction: "before" | "after",
  limit: number
): { items: T[]; removedBefore: number; removedAfter: number } {
  const safeLimit = Math.max(0, Math.floor(limit));
  const overflow = Math.max(0, items.length - safeLimit);
  if (overflow === 0) return { items, removedBefore: 0, removedAfter: 0 };
  if (direction === "after") {
    return {
      items: items.slice(overflow),
      removedBefore: overflow,
      removedAfter: 0
    };
  }
  return {
    items: items.slice(0, items.length - overflow),
    removedBefore: 0,
    removedAfter: overflow
  };
}

export type QueueSourceKind = "smart" | "playlist" | "search" | "folder" | "library";

/**
 * What the dock says the queue is playing from, and where that lives.
 *
 * Only the queue panel used to say it, so with the panel closed nobody could
 * tell a smart playlist from a hand-made one, or a folder from a search. An
 * older stored source has no label at all; it is called a folder rather than
 * guessed to be the whole library.
 */
export function queueSourceView(
  source: { kind: "directory" | "collection"; id: number; query: string; label?: string; smart?: boolean } | null
): { kind: QueueSourceKind; name: string; path: string } | null {
  if (!source) return null;
  const name = (source.label ?? "").trim();
  if (source.kind === "collection") {
    return { kind: source.smart ? "smart" : "playlist", name, path: `music/?collection=${source.id}` };
  }
  const query = source.query.trim();
  if (query) {
    return { kind: "search", name: name || query, path: `music/?directory=${source.id}&q=${encodeURIComponent(query)}` };
  }
  if (name || source.label === undefined) return { kind: "folder", name, path: `music/?directory=${source.id}` };
  return { kind: "library", name: "", path: "music/" };
}

/**
 * A volume read back from storage: a number from 0 to 1, or `fallback`.
 *
 * Storage is text anybody can edit, and other things write to it. `"abc"`,
 * `"1.5"` or `"-1"` given to `media.volume` as they come is an exception thrown
 * while the player is being built (the element refuses anything outside 0–1,
 * NaN included) — the film viewer then never showed its picture.
 */
export function storedLevel(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export type StarFill = "empty" | "half" | "full";

export function starFill(rating: number, star: number): StarFill {
  if (rating >= star) return "full";
  if (rating >= star - 0.5) return "half";
  return "empty";
}

/**
 * Settle what the queue rows show: the account's choice, unless the playlist
 * being played overrode it.
 *
 * The account is the base — it is your queue — and each half is decided on its
 * own, so a playlist can hand out its author's favourites while the rating stays
 * whatever the listener asked for. `inherit` is not a value the rows ever see:
 * it is the word for "this half was not overridden", and it resolves here.
 *
 * The account's vocabulary says "own", which from the reader's chair means the
 * viewer; a list says "owner" or "viewer" precisely, because on a shared list
 * "own" would name a different person depending on who is reading.
 */
export function resolveQueueDisplay(
  account: { index: boolean; favorite: boolean; rating: "own" | "average" | "none" },
  list: {
    rating?: "inherit" | "owner" | "viewer" | "average" | "none";
    favorite?: "inherit" | "owner" | "viewer" | "none";
  } = {}
): {
  index: boolean;
  rating: "owner" | "viewer" | "average" | "none";
  favorite: "owner" | "viewer" | "none";
} {
  const listRating = list.rating ?? "inherit";
  const listFavorite = list.favorite ?? "inherit";
  return {
    index: account.index,
    rating: listRating === "inherit" ? (account.rating === "own" ? "viewer" : account.rating) : listRating,
    favorite: listFavorite === "inherit" ? (account.favorite ? "viewer" : "none") : listFavorite
  };
}
