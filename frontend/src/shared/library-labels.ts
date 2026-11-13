/**
 * The library page's small answers that need no page: what an address
 * parameter means, how a decade or a picture is named, which queue is which.
 * No DOM and no translation in here, so Node can test it as it stands.
 */

/** A positive whole number out of an address parameter, or null. */
export function positiveId(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** "1990–1999": a decade needs no word, and so no translation ("1990s" was English in every language). */
export function decadeLabel(decade: number | string): string {
  const start = Number(decade);
  return Number.isFinite(start) && String(decade).trim() !== "" ? `${start}–${start + 9}` : String(decade);
}

/** Identifies a prepared playlist queue: the order is part of it, so a re-sort rebuilds. */
export function collectionQueueKey(id: number, sort: string, seed: string): string {
  return "collection:" + id + "|" + sort + (sort === "random" ? ":" + seed : "");
}

/**
 * How a film's picture is worth naming on a card.
 *
 * The catalogue stores the exact height, but a viewer thinks in labels, and a
 * 2,35:1 film is 1920x800 rather than 1920x1080 — so the width decides the class
 * and the height only breaks ties.
 */
export function resolutionLabel(item: { video_width?: number | null; video_height?: number | null }): string | null {
  const width = item.video_width ?? 0;
  const height = item.video_height ?? 0;
  if (width <= 0 || height <= 0) return null;
  if (width >= 7000 || height >= 4000) return "8K";
  if (width >= 3400 || height >= 1800) return "4K";
  if (width >= 2400 || height >= 1300) return "2K";
  if (width >= 1800 || height >= 1000) return "1080p";
  if (width >= 1200 || height >= 700) return "720p";
  return `${width}×${height}`;
}

/**
 * The same, for a mark laid on the picture itself: only a class with a name
 * ("4K", "1080p"). A picture below 720p has none — "640×480" over a still is a
 * measurement, not something a viewer chooses a film by; the exact size stays
 * in the film's details.
 */
export function resolutionBadge(item: { video_width?: number | null; video_height?: number | null }): string | null {
  const label = resolutionLabel(item);
  return label !== null && !label.includes("×") ? label : null;
}

/** The icon a file is shown with (a name from shared/icons.ts). */
export function itemIconName(item: { media_kind: string; file_extension?: string | null }): "music" | "film" | "image" | "magnet" | "archive" | "file" {
  if (item.media_kind === "audio") return "music";
  if (item.media_kind === "video") return "film";
  if (item.media_kind === "image") return "image";
  if (item.file_extension === "torrent") return "magnet";
  if (["zip", "rar", "7z"].includes(item.file_extension ?? "")) return "archive";
  return "file";
}
