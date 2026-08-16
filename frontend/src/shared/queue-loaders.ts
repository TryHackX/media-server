import { getCollection, getQueuePage } from "./api";
import type { AudioPlayer, QueueSource } from "./audio-player";
import type { CollectionItemSort, MediaItem, QueuePage } from "./types";

/** A playlist page is 100 rows at most, whatever the player's window is. */
const COLLECTION_PAGE = 100;

function collectionSortOf(source: QueueSource): CollectionItemSort {
  return source.shuffleMode !== "off" ? "random" : (source.collectionSort ?? "position");
}

function emptyPage(total: number): QueuePage {
  return { items: [], next_cursor: null, has_more: false, offset: 0, total };
}

/**
 * Rebuilding the queue's loaders from the source it remembers.
 *
 * A restored session gets its tracks back out of storage but not its loaders —
 * those are functions, and a function does not survive `localStorage`. Without
 * them the player still plays, and still says it is shuffling, but every random
 * jump lands inside the one window it happens to be holding: a playlist of two
 * thousand tracks quietly narrows to the hundred and sixty around wherever it
 * was when the page last loaded.
 *
 * This used to live inside the music library page, behind
 * `if (options.kind === "music")`. That is one page out of six. Reload on
 * Collections, on Movies, on the start page — or simply open the playlist and
 * then walk to another tab — and nothing ever put the loaders back, because the
 * shell and the player survive navigation while the page that repaired them
 * does not. It is the same shape as the navigation that stopped responding
 * after a session expired: something long-lived depending on something
 * short-lived to keep it whole.
 *
 * So it runs from the shell, on every mount, for every page.
 */
export function restoreQueueLoaders(player: AudioPlayer): void {
  if (!player.hasQueue()) return;
  const source = player.queueSourceInfo();
  if (!source) return;

  if (source.kind === "directory") {
    player.setGlobalQueueLoader(
      source.shuffleMode === "off"
        ? null
        : async (offset: number) =>
            getQueuePage(source.id, 0, 160, "after", source.query, {
              shuffleMode: source.shuffleMode,
              shuffleSeed: source.shuffleSeed,
              offset
            })
    );
    if (source.shuffleMode === "off") {
      player.setQueuePaging(
        async (direction, cursor) => getQueuePage(source.id, cursor, 160, direction, source.query),
        true,
        true
      );
    }
    return;
  }

  if (source.shuffleMode !== "off") {
    player.setGlobalQueueLoader(async (offset: number) => {
      // 100 is the most collectionPage will serve in one request, so a
      // collection window is smaller than the player's 160 and it pages across
      // the difference. That costs a request, not correctness: the jump target
      // is an absolute position and `total` is the whole playlist either way.
      const data = await getCollection(source.id, 1, COLLECTION_PAGE, {
        sort: "random",
        shuffleSeed: source.shuffleSeed,
        offset
      });
      return {
        items: data.items,
        next_cursor: data.items.at(-1)?.id ?? null,
        has_more: data.has_more,
        offset: data.offset,
        total: data.total
      };
    });
    return;
  }

  // A playlist played in its own order pages forward from where the window
  // ends. Until the order was part of the source there was nothing to page
  // with, so a restored playlist stopped at the hundred tracks it woke up
  // holding — silently, in the middle of a list somebody had queued on purpose.
  const window = player.queueWindow();
  let nextOffset = window.offset + window.length;
  player.setQueuePaging(
    async (direction) => {
      if (direction === "before") return emptyPage(window.total);
      const data = await getCollection(source.id, 1, COLLECTION_PAGE, {
        sort: collectionSortOf(source),
        offset: nextOffset
      });
      nextOffset = data.offset + data.items.length;
      return {
        items: data.items,
        next_cursor: data.items.at(-1)?.id ?? null,
        has_more: data.has_more,
        offset: data.offset,
        total: data.total
      };
    },
    false,
    nextOffset < window.total
  );
}

/**
 * Build a queue from a source alone — the shape a handover arrives in.
 *
 * Another device stores where its queue came from and how far in it had got;
 * nothing else crosses. That is enough, because a folder plus a shuffle seed
 * plus an offset names the same list of tracks on every device, and the window
 * around a given position can always be fetched again.
 *
 * The one place it cannot be exact is a folder played in file order: that queue
 * pages by track identifier rather than by position, so the window is fetched
 * from the track that was playing rather than from an offset. The listener ends
 * up in the same place in the same order — with the tracks before it a page
 * away instead of already loaded.
 */
export async function startQueueFromSource(
  player: AudioPlayer,
  source: QueueSource,
  options: {
    offset: number;
    mediaItemId: number | null;
    positionSeconds: number;
    context: string;
    autoplay: boolean;
    /**
     * A track to put at the head of the rebuilt window and keep playing.
     *
     * Re-shuffling is the case: the new ordering has no idea where the current
     * track landed, and starting the fresh window at whatever came first would
     * cut off the song somebody is listening to.
     */
    leadItem?: MediaItem | null;
  }
): Promise<boolean> {
  const offset = Math.max(0, options.offset);
  const page = source.kind === "directory"
    ? await getQueuePage(
        source.id,
        // Identifiers order this listing, so "everything from the track that was
        // playing" is everything above the one before it.
        source.shuffleMode === "off" && options.mediaItemId ? options.mediaItemId - 1 : 0,
        160,
        "after",
        source.query,
        source.shuffleMode === "off"
          ? {}
          : { shuffleMode: source.shuffleMode, shuffleSeed: source.shuffleSeed, offset }
      )
    : await (async () => {
        const data = await getCollection(source.id, 1, COLLECTION_PAGE, {
          sort: collectionSortOf(source),
          shuffleSeed: source.shuffleSeed || undefined,
          offset
        });
        return {
          items: data.items,
          next_cursor: data.items.at(-1)?.id ?? null,
          has_more: data.has_more,
          offset: data.offset,
          total: data.total
        };
      })();
  const lead = options.leadItem ?? null;
  const items = lead
    ? [lead, ...page.items.filter((item) => item.id !== lead.id)]
    : page.items;
  if (items.length === 0) return false;
  const startId = lead
    ? lead.id
    : options.mediaItemId !== null && page.items.some((item) => item.id === options.mediaItemId)
      ? options.mediaItemId
      : undefined;
  // A cursor-paged folder answers with offset 0 whatever it was asked for — that
  // listing counts in identifiers, not positions. The position is known here, so
  // the queue keeps it: it is what "track 41 of 12 807" is drawn from, and what
  // the next device is told when this queue is handed on.
  const windowOffset = page.offset > 0 ? page.offset : offset;
  await player.setQueue(items, startId, options.autoplay, {
    offset: windowOffset,
    total: page.total,
    context: options.context,
    // Only the track that was playing resumes mid-way; anything else starts at
    // its beginning, exactly as the "continue" shelf behaves.
    resumeSeconds: startId === undefined ? 0 : Math.max(0, options.positionSeconds)
  });
  player.setQueueSource(source);
  restoreQueueLoaders(player);
  return true;
}

/**
 * Re-ordering the queue from wherever the reader happens to be standing.
 *
 * The shuffle button lives in the dock, and the dock is on every page; the code
 * that rebuilt the queue for a new mode lived on the music library. Press it
 * anywhere else and the mode changed while the queue did not — so "random over
 * the whole library" went on drawing from the hundred and sixty tracks already
 * loaded, and the end of that window was the end of the music.
 *
 * The library page still installs its own richer version while it is mounted
 * (it knows about the folder being browsed, the search box and the open
 * playlist); this is what everybody else gets.
 */
export function queueModeFallback(player: AudioPlayer): (preserveCurrent: boolean) => Promise<void> {
  return async (preserveCurrent: boolean): Promise<void> => {
    const source = player.queueSourceInfo();
    if (!source) return;
    const current = preserveCurrent ? player.currentItem() : null;
    await startQueueFromSource(player, source, {
      // A new ordering starts at its own beginning; the track being listened to
      // is carried across on top of it.
      offset: 0,
      mediaItemId: current?.id ?? null,
      leadItem: current,
      positionSeconds: preserveCurrent ? player.playbackPosition() : 0,
      context: player.queueContextLabel(),
      autoplay: preserveCurrent ? player.isPlaying() : true
    });
  };
}
