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

export function nextTrackIndex(
  length: number,
  current: number,
  options: {
    automatic: boolean;
    repeat: RepeatMode;
    shuffle: boolean;
    random?: () => number;
  }
): number {
  if (length <= 0 || current < 0 || current >= length) return -1;
  if (options.automatic && (options.repeat === "one" || options.repeat === "once")) return current;
  if (options.shuffle && length > 1) {
    const random = options.random ?? Math.random;
    const offset = 1 + Math.floor(Math.min(0.999999, Math.max(0, random())) * (length - 1));
    return (current + offset) % length;
  }
  if (current + 1 < length) return current + 1;
  if (options.repeat === "all" || !options.automatic) return 0;
  return -1;
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
