/**
 * The listener's Geiss messages, GEISS.INI per browser: Geiss 4.30 showed message ## of section
 * [CUSTOM MESSAGES] (`MESSAGE 7=Hello Dad - I'm in Jail!`) on the keys `m##`, the way it popped up
 * a song title (sim.ts showMessage). Here the 100 slots (00–99) live in the browser's storage under
 * one key, each slot the value as GEISS.INI would hold it; messageText() is what Geiss read of it.
 * Also the wave colours' option ("Don't base the wave colors on the music", unticked), kept the same
 * way.
 *
 * Pure functions over a Storage-like object, so the tests run them without a browser. No imports.
 */

/** Where the messages are kept: {"07": "Hello Dad - I'm in Jail!", …}. */
export const MESSAGES_KEY = "media-visualizer-geiss-messages";
/** The wave colours from the music: "1" on, anything else (or nothing) off, the plug-in's default. */
export const SYNC_COLOUR_KEY = "media-visualizer-geiss-sync-colour";
/** Slots 00–99, as Geiss's `m##`. */
export const MESSAGE_SLOTS = 100;
/** g_song_title[256]: the longest message Geiss could show. */
export const MESSAGE_LENGTH = 255;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem" | "removeItem">;

/**
 * What GetPrivateProfileString() gave Geiss for a GEISS.INI value: without the spaces around it,
 * then without one pair of quotes around it (so `"  hi  "` keeps its spaces), at most 255 characters.
 */
export function messageText(value: string): string {
  let text = value.trim();
  if (text.length >= 2 && (text[0] === "\"" || text[0] === "'") && text[text.length - 1] === text[0]) text = text.slice(1, -1);
  return [...text].slice(0, MESSAGE_LENGTH).join("");
}

/** A value that can be kept: a string of one line that shows something. */
export function validMessage(value: unknown): string | null {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return null;
  return messageText(value) === "" ? null : value;
}

/** The saved messages by slot (the GEISS.INI values), in slot order; what cannot be read is left out. */
export function readMessages(storage: ReadStorage | null): Map<number, string> {
  const messages = new Map<number, string>();
  let stored: unknown = null;
  try {
    stored = JSON.parse(storage?.getItem(MESSAGES_KEY) ?? "null");
  } catch {
    return messages;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return messages;
  const slots = Object.entries(stored as Record<string, unknown>)
    .filter(([name]) => /^\d\d$/.test(name))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of slots) {
    const message = validMessage(value);
    if (message !== null) messages.set(Number(name), message);
  }
  return messages;
}

/** All the slots written back (none left: the key goes). False when the storage refused. */
export function writeMessages(storage: WriteStorage | null, messages: ReadonlyMap<number, string>): boolean {
  if (!storage) return false;
  try {
    if (!messages.size) {
      storage.removeItem(MESSAGES_KEY);
      return true;
    }
    const slots: Record<string, string> = {};
    for (const slot of [...messages.keys()].sort((left, right) => left - right)) slots[String(slot).padStart(2, "0")] = messages.get(slot)!;
    storage.setItem(MESSAGES_KEY, JSON.stringify(slots));
    return true;
  } catch {
    return false;
  }
}

/** The wave colours' option as kept; off where nothing is. */
export function readSyncColour(storage: ReadStorage | null): boolean {
  try {
    return storage?.getItem(SYNC_COLOUR_KEY) === "1";
  } catch {
    return false;
  }
}

/** The option kept (off removes the key: the default). False when the storage refused. */
export function writeSyncColour(storage: WriteStorage | null, on: boolean): boolean {
  if (!storage) return false;
  try {
    if (on) storage.setItem(SYNC_COLOUR_KEY, "1");
    else storage.removeItem(SYNC_COLOUR_KEY);
    return true;
  } catch {
    return false;
  }
}
