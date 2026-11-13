import type { MediaKind } from "./types";

export function supportsThumbnail(kind: MediaKind | null): kind is "audio" | "image" | "video" {
  return kind === "audio" || kind === "image" || kind === "video";
}
