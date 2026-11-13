/**
 * The codecs of a fragmented MP4's header, named the way Media Source wants them.
 *
 * Compatibility mode sends a film as fragmented MP4 (stereo.py: FFmpeg with an
 * empty moov first, then a moof/mdat fragment every 2 s). Before a SourceBuffer
 * takes such a stream it has to be told the exact codecs —
 * `video/mp4; codecs="avc1.640028,mp4a.40.2"` — and the header (moov) carries
 * them: avcC, hvcC, av1C and vpcC in the video sample entry, esds in the audio
 * one. The names follow RFC 6381, ISO/IEC 14496-15 annex E (HEVC) and the AV1
 * and VP9 ISOBMFF bindings. Pure functions, tested on handmade boxes.
 */

interface Box {
  type: string;
  /** The box's own first byte, its first byte after the header, and the byte after it. */
  start: number;
  body: number;
  end: number;
}

/** The boxes between `start` and `end`; stops at one that has not fully arrived. */
function readBoxes(data: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) break;
    boxes.push({ type: String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!), start: at, body, end: at + size });
    at += size;
  }
  return boxes;
}

function child(data: Uint8Array, parent: Box, type: string, offset = 0): Box | undefined {
  return readBoxes(data, parent.body + offset, parent.end).find((box) => box.type === type);
}

/** Where the header (ftyp + moov) ends in the bytes so far, or -1 until moov is complete. */
export function initSegmentEnd(data: Uint8Array): number {
  for (const box of readBoxes(data, 0, data.length)) {
    if (box.type === "moov") return box.end;
    if (box.type === "moof" || box.type === "mdat") return -1;
  }
  return -1;
}

const hex = (value: number, digits = 2): string => value.toString(16).toUpperCase().padStart(digits, "0");
const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Sample entries put their child boxes after fixed fields: 78 bytes for video, 28 for audio. */
const VISUAL_FIELDS = 78;
const AUDIO_FIELDS = 28;

function avcCodec(type: string, data: Uint8Array, avcC: Box): string {
  const at = avcC.body;
  return `${type}.${hex(data[at + 1]!)}${hex(data[at + 2]!)}${hex(data[at + 3]!)}`;
}

function hevcCodec(type: string, data: Uint8Array, hvcC: Box): string {
  const at = hvcC.body;
  const first = data[at + 1]!;
  const space = first >> 6;
  const tier = (first >> 5) & 1;
  const profile = first & 0x1f;
  // The compatibility flags are written in reverse bit order (annex E).
  let flags = ((data[at + 2]! << 24) | (data[at + 3]! << 16) | (data[at + 4]! << 8) | data[at + 5]!) >>> 0;
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    reversed = ((reversed << 1) | (flags & 1)) >>> 0;
    flags >>>= 1;
  }
  const constraints = Array.from(data.subarray(at + 6, at + 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = data[at + 12]!;
  return [
    type,
    `${["", "A", "B", "C"][space]}${profile}`,
    reversed.toString(16).toUpperCase(),
    `${tier ? "H" : "L"}${level}`,
    ...constraints.map((byte) => byte.toString(16).toUpperCase())
  ].join(".");
}

function av1Codec(data: Uint8Array, av1C: Box): string {
  const at = av1C.body;
  const profile = data[at + 1]! >> 5;
  const level = data[at + 1]! & 0x1f;
  const tier = data[at + 2]! >> 7;
  const high = (data[at + 2]! >> 6) & 1;
  const twelve = (data[at + 2]! >> 5) & 1;
  const depth = profile === 2 && high ? (twelve ? 12 : 10) : high ? 10 : 8;
  return `av01.${profile}.${pad2(level)}${tier ? "H" : "M"}.${pad2(depth)}`;
}

function vp9Codec(data: Uint8Array, vpcC: Box): string {
  // A full box: version and flags first.
  const at = vpcC.body + 4;
  return `vp09.${pad2(data[at]!)}.${pad2(data[at + 1]!)}.${pad2(data[at + 2]! >> 4)}`;
}

/** esds: the object type (0x40, MPEG-4 audio) and the audio object type (2, AAC LC). */
function mp4aCodec(data: Uint8Array, esds: Box | undefined): string {
  if (!esds) return "mp4a.40.2";
  let at = esds.body + 4;
  const end = esds.end;
  let objectType = 0x40;
  let audioType = 2;
  // Descriptors: a tag byte, then a length in up to four 7-bit bytes.
  while (at < end) {
    const tag = data[at]!;
    let length = 0;
    let lengthBytes = 0;
    do {
      lengthBytes += 1;
      length = (length << 7) | (data[at + lengthBytes]! & 0x7f);
    } while (lengthBytes < 4 && (data[at + lengthBytes]! & 0x80) !== 0);
    const body = at + 1 + lengthBytes;
    if (tag === 0x03) {
      // ES_Descriptor: id (2), flags (1), then the optional fields its flags announce.
      const flags = data[body + 2]!;
      let next = body + 3;
      if (flags & 0x80) next += 2;
      if (flags & 0x40) next += 1 + data[next]!;
      if (flags & 0x20) next += 2;
      at = next;
      continue;
    }
    if (tag === 0x04) {
      objectType = data[body]!;
      at = body + 13;
      continue;
    }
    if (tag === 0x05) {
      audioType = data[body]! >> 3;
      if (audioType === 31) audioType = 32 + (((data[body]! & 0x07) << 3) | (data[body + 1]! >> 5));
      break;
    }
    at = body + length;
  }
  return `mp4a.${objectType.toString(16)}.${audioType}`;
}

/** The codec name of one sample entry, or null for one Media Source would not know. */
function sampleEntryCodec(data: Uint8Array, entry: Box): string | null {
  switch (entry.type) {
    case "avc1":
    case "avc3": {
      const avcC = child(data, entry, "avcC", VISUAL_FIELDS);
      return avcC ? avcCodec(entry.type, data, avcC) : null;
    }
    case "hvc1":
    case "hev1": {
      const hvcC = child(data, entry, "hvcC", VISUAL_FIELDS);
      return hvcC ? hevcCodec(entry.type, data, hvcC) : null;
    }
    case "av01": {
      const av1C = child(data, entry, "av1C", VISUAL_FIELDS);
      return av1C ? av1Codec(data, av1C) : null;
    }
    case "vp09": {
      const vpcC = child(data, entry, "vpcC", VISUAL_FIELDS);
      return vpcC ? vp9Codec(data, vpcC) : null;
    }
    case "mp4a":
      return mp4aCodec(data, child(data, entry, "esds", AUDIO_FIELDS));
    case "Opus":
      return "opus";
    case "ac-3":
    case "ec-3":
      return entry.type;
    case "fLaC":
      return "flac";
    default:
      return null;
  }
}

/**
 * Every track's codec in the header, video before audio as the tracks come.
 * An empty list: no moov yet, or nothing recognisable in it.
 */
export function mp4Codecs(init: Uint8Array): string[] {
  const moov = readBoxes(init, 0, init.length).find((box) => box.type === "moov");
  if (!moov) return [];
  const codecs: string[] = [];
  for (const trak of readBoxes(init, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    let box: Box | undefined = trak;
    for (const type of ["mdia", "minf", "stbl", "stsd"]) {
      box = box ? child(init, box, type) : undefined;
    }
    if (!box) continue;
    // stsd is a full box with an entry count: 8 bytes before its entries.
    for (const entry of readBoxes(init, box.body + 8, box.end)) {
      const codec = sampleEntryCodec(init, entry);
      if (codec) codecs.push(codec);
    }
  }
  return codecs;
}

/** `video/mp4; codecs="…"` for the header, or null when it names no codec. */
export function mp4MimeType(init: Uint8Array): string | null {
  const codecs = mp4Codecs(init);
  return codecs.length > 0 ? `video/mp4; codecs="${codecs.join(",")}"` : null;
}
