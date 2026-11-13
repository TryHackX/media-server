/**
 * Names for things a file says about itself in machine words.
 *
 * No imports on purpose, so `node --test` can load it as it is.
 */

/** ffprobe's name of a container family, as the three letters people call it. */
const FAMILY: Record<string, string> = {
  matroska: "MKV", webm: "WEBM", mov: "MP4", mp4: "MP4", mpegts: "TS", mpeg: "MPG", avi: "AVI",
  asf: "WMV", flv: "FLV", ogg: "OGG", wav: "WAV", flac: "FLAC", mp3: "MP3", rm: "RM"
};

/** File extensions that belong to a family ffprobe names differently. */
const EXTENSIONS: Record<string, readonly string[]> = {
  matroska: ["mkv", "mka", "mks"],
  mov: ["mp4", "m4v", "m4a", "mov", "3gp", "3g2"],
  mpegts: ["ts", "m2ts", "mts"],
  mpeg: ["mpg", "mpeg", "vob"],
  asf: ["wmv", "wma", "asf"],
  ogg: ["ogg", "ogv", "oga", "opus"]
};

/**
 * What to call a file's container.
 *
 * ffprobe names the demuxer, and one demuxer reads several formats, so it
 * answers with the whole list: `matroska,webm`, `mov,mp4,m4a,3gp,3g2,mj2`. That
 * list was printed as it came. The file's own extension settles which member of
 * the family this is ("MKV", "MP4"); without a usable extension the family's
 * usual name does.
 */
export function containerLabel(container: string | null | undefined, extension: string | null | undefined): string | null {
  const ext = (extension ?? "").trim().toLowerCase().replace(/^\./, "");
  const names = (container ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return ext ? ext.toUpperCase() : null;
  if (ext && (names.includes(ext) || names.some((name) => EXTENSIONS[name]?.includes(ext)))) return ext.toUpperCase();
  const first = names[0]!;
  return FAMILY[first] ?? first.toUpperCase();
}
