import { ApiError, createFileTransfer, createStereoTransfer, getUpNext, previewUrl, recordPlayback } from "./api";
import { el } from "./dom";
import { formatBytes, formatDuration } from "./format";
import { icon } from "./icons";
import { t } from "./i18n";
import { openModal } from "./modal";
import { can, canStreamCompat } from "./permissions";
import type { MediaItem, MediaProbeDetails, MediaProbeTrack, SessionResponse, UpNextEntry } from "./types";

const textExtensions = new Set(["ass", "cue", "nfo", "srt", "txt", "vtt"]);
const compatibilityExtensions = new Set(["avi", "m2ts", "mkv", "mts", "ts"]);

/** How long the credits panel waits before rolling into the next episode. */
const UP_NEXT_SECONDS = 12;
type VideoMode = "original" | "compatible";

/**
 * Markup for the centre playback overlay.
 *
 * These are module-level literals with no interpolation of user or media data,
 * and ``el()`` cannot build SVG nodes, so assigning them as HTML is safe here.
 * The flash keyframes run for 700 ms against the 720 ms timer in
 * ``showPlaybackState``; change one and the other has to follow.
 */
const PLAYBACK_STATE_MARKUP: Record<"play" | "pause" | "loading", string> = {
  play:
    '<span class="viewer__playback-state-halo" aria-hidden="true"></span>' +
    '<span class="viewer__playback-state-badge">' +
      '<span class="viewer__playback-state-sheen" aria-hidden="true"></span>' +
      '<svg class="viewer__playback-state-glyph viewer__playback-state-glyph--play" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path class="viewer__playback-state-tri" d="M9 6.1 L19.1 12 L9 17.9 Z"></path>' +
      "</svg>" +
    "</span>",
  pause:
    '<span class="viewer__playback-state-halo" aria-hidden="true"></span>' +
    '<span class="viewer__playback-state-badge">' +
      '<span class="viewer__playback-state-sheen" aria-hidden="true"></span>' +
      '<svg class="viewer__playback-state-glyph viewer__playback-state-glyph--pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<rect class="viewer__playback-state-bar viewer__playback-state-bar--a" x="7.9" y="4.8" width="3.3" height="14.4" rx="1.65"></rect>' +
        '<rect class="viewer__playback-state-bar viewer__playback-state-bar--b" x="12.8" y="4.8" width="3.3" height="14.4" rx="1.65"></rect>' +
      "</svg>" +
    "</span>",
  loading:
    '<span class="viewer__playback-state-halo" aria-hidden="true"></span>' +
    '<span class="viewer__playback-state-badge">' +
      '<span class="viewer__playback-state-sheen" aria-hidden="true"></span>' +
      '<svg class="viewer__playback-state-ring" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
        '<circle class="viewer__playback-state-track" cx="24" cy="24" r="18" pathLength="100"></circle>' +
        '<circle class="viewer__playback-state-rail" cx="24" cy="24" r="18" pathLength="100"></circle>' +
        '<g class="viewer__playback-state-orbit">' +
          '<circle class="viewer__playback-state-bloom" cx="24" cy="24" r="18" pathLength="100" stroke-dasharray="3 97"></circle>' +
          '<circle class="viewer__playback-state-arc" cx="24" cy="24" r="18" pathLength="100" stroke-dasharray="3 97"></circle>' +
        "</g>" +
      "</svg>" +
    "</span>"
};

/**
 * One selectable track as the transfer service found it.
 *
 * Facts, not a sentence: the service used to send a finished Polish label, which
 * was the one part of the interface the browser could not translate.
 */
interface CompatibleTrack {
  index: number;
  stream_index: number;
  language: string;
  codec: string;
  channel_layout?: string;
  bitrate_kbps?: number;
  default?: boolean;
  forced?: boolean;
  supported?: boolean;
  /** Subtitles only: "external" is a file lying next to the film, not a stream in it. */
  source?: "embedded" | "external";
  /** Subtitles only: whatever the sidecar's name said after the film's own name. */
  title?: string;
  /** Subtitles only: a picture of text (PGS/VobSub) rather than text. */
  image?: boolean;
}

interface CompatibleInfo {
  duration_seconds: number | null;
  video_codec?: string | null;
  video_transcoded?: boolean;
  audio_tracks: CompatibleTrack[];
  subtitle_tracks: CompatibleTrack[];
}

/**
 * What the catalogue knows about the file, from the ffprobe pass.
 *
 * Shown under the player rather than over it: this is reference material a
 * viewer looks up ("is this the 10-bit copy?"), not something to read while
 * watching. Films that have not been probed yet get nothing at all.
 */
function technicalDetails(item: MediaItem): HTMLElement | null {
  const probe = item.probe;
  if (!probe) return null;
  const seconds = (item.duration_ms ?? 0) / 1000;
  const megabits = (bits?: number): string | null =>
    typeof bits === "number" && bits > 0 ? `${(bits / 1_000_000).toFixed(1)} Mb/s` : null;
  // Polish counts in three forms: one, a few (2–4, but not 12–14), and many.
  // Polish counts in three forms: one, a few (2-4, but not 12-14), and many.
  // The form is chosen by Polish grammar and then translated, so English simply
  // maps two of the three onto its plural and the call sites stay unchanged.
  const plural = (count: number, one: string, few: string, many: string): string => {
    const tens = count % 100;
    const units = count % 10;
    if (count === 1) return `${count} ${t(one)}`;
    return `${count} ${t(units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many)}`;
  };
  const picture = [
    item.video_width && item.video_height ? `${item.video_width}×${item.video_height}` : null,
    resolutionClass(item),
    aspectRatio(item),
    probe.video_codec?.toUpperCase(),
    probe.video_profile,
    probe.bit_depth ? `${probe.bit_depth} bit` : null,
    probe.pixel_format,
    probe.color_space,
    item.is_hdr ? `HDR${probe.color_transfer ? ` (${probe.color_transfer})` : ""}` : null,
    probe.frame_rate ? `${probe.frame_rate} ${t("kl/s")}` : null,
    // The picture's own rate. The file's total is on the "Plik" row; a viewer
    // comparing two rips of the same film wants this one.
    megabits(probe.video_bitrate)
  ].filter(Boolean) as string[];
  const file = [
    probe.container ?? item.file_extension?.toUpperCase(),
    item.size_bytes ? formatBytes(item.size_bytes) : null,
    seconds > 0 ? clock(seconds) : null,
    // The declared bitrate when the file carries one, otherwise the honest
    // average from size and length — a number that is always available and
    // always means the same thing.
    megabits(probe.bitrate) ?? averageBitrate(item.size_bytes, seconds),
    item.mime_type
  ].filter(Boolean) as string[];
  const tags = [item.artist, item.album, item.year, item.genre].filter(Boolean) as string[];

  const row = (label: string, values: string[]): HTMLElement | null => values.length === 0
    ? null
    : el("div", { className: "viewer__technical-row" },
        el("dt", { text: label }),
        el("dd", { text: values.join(" · ") }));
  const sound = splitTracks(probe.audio_tracks, soundFallback(probe, plural), plural, t("Dźwięk"), true);
  const subtitles = splitTracks(probe.subtitle_tracks, subtitleFallback(probe, plural), plural, t("Napisy"), false);
  const open = [
    row(t("Plik"), file),
    row(t("Obraz"), picture),
    ...sound.open,
    ...subtitles.open
  ].filter(Boolean) as HTMLElement[];
  const rest = [
    ...sound.rest,
    ...subtitles.rest,
    row(t("Opis"), tags),
    pathRow(item.relative_path)
  ].filter(Boolean) as HTMLElement[];
  if (open.length === 0 && rest.length === 0) return null;
  const panel = el(
    "section",
    { className: "viewer__technical", attrs: { "aria-label": t("Szczegóły techniczne") } },
    el("h3", { className: "viewer__technical-heading" }, icon("info"), el("span", { text: t("Szczegóły techniczne") })),
    el("dl", { className: "viewer__technical-grid" }, ...open)
  );
  // What is left over folds away. A disc rip can carry a dozen dubs and twenty
  // subtitle tracks; listing them all by default buries the four lines anyone
  // actually reads — the file, the picture, and the sound and subtitles they
  // are going to pick.
  if (rest.length > 0) {
    panel.append(el(
      "details",
      { className: "viewer__technical-more" },
      el("summary", { text: t("Pozostałe szczegóły ({count})", { count: rest.length }) }),
      el("dl", { className: "viewer__technical-grid" }, ...rest)
    ));
  }
  return panel;
}

/** The full path, given the whole width so it does not wrap into four lines. */
function pathRow(relativePath: string): HTMLElement {
  return el("div", { className: "viewer__technical-row viewer__technical-row--path" },
    el("dt", { text: t("Ścieżka") }),
    el("dd", { text: relativePath }));
}

type Plural = (count: number, one: string, few: string, many: string) => string;

/** Languages a Polish household picks from first; the rest fold away. */
const PRIMARY_LANGUAGES = ["pol", "pl", "eng", "en"];

/**
 * Split a kind of track into "what the viewer will choose" and "the rest".
 *
 * Sound keeps its Polish and English tracks in full, because those are the two
 * anyone here is going to select. Subtitles get one summary line — a rip can
 * carry twenty of them and their per-track detail says nothing a language name
 * does not — with the full list behind the expander.
 */
function splitTracks(
  tracks: MediaProbeTrack[] | undefined,
  fallback: string[],
  plural: Plural,
  label: string,
  detailed: boolean
): { open: Array<HTMLElement | null>; rest: Array<HTMLElement | null> } {
  const row = (heading: string, values: string[]): HTMLElement | null => values.length === 0
    ? null
    : el("div", { className: "viewer__technical-row" },
        el("dt", { text: heading }),
        el("dd", { text: values.join(" · ") }));
  if (!tracks || tracks.length === 0) return { open: [row(label, fallback)], rest: [] };
  const languages = uniqueLanguages(tracks);
  if (!detailed) {
    // One line: how many, and in which languages.
    return {
      open: [row(label, [plural(tracks.length, "ścieżka", "ścieżki", "ścieżek"), ...languages])],
      rest: tracks.length > 1
        ? tracks.map((track, index) => row(`${label} ${index + 1}`, trackFacts(track, plural)))
        : []
    };
  }
  const primary = tracks.filter((track) => PRIMARY_LANGUAGES.includes((track.language ?? "").toLowerCase()));
  const chosen = primary.length > 0 ? primary : tracks.slice(0, 1);
  const remaining = tracks.filter((track) => !chosen.includes(track));
  const heading = (track: MediaProbeTrack): string =>
    tracks.length > 1 ? `${label} ${tracks.indexOf(track) + 1}` : label;
  return {
    open: [
      ...chosen.map((track) => row(heading(track), trackFacts(track, plural))),
      remaining.length > 0
        ? row(t("{label} — pozostałe", { label }), [
            plural(remaining.length, "ścieżka", "ścieżki", "ścieżek"),
            ...uniqueLanguages(remaining)
          ])
        : null
    ],
    rest: remaining.map((track) => row(heading(track), trackFacts(track, plural)))
  };
}

/** @param tracks tracks to name, in the order they appear in the file */
function uniqueLanguages(tracks: MediaProbeTrack[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const track of tracks) {
    const name = track.language ? languageName(track.language) : null;
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Everything worth saying about one track, in the order a chooser reads it. */
function trackFacts(track: MediaProbeTrack, plural: Plural): string[] {
  return [
    track.language ? languageName(track.language) : null,
    track.codec?.toUpperCase(),
    track.profile,
    track.channel_layout ?? (track.channels ? channelLayout(track.channels) : null),
    track.channels ? plural(track.channels, "kanał", "kanały", "kanałów") : null,
    track.sample_rate ? `${Math.round(track.sample_rate / 1000)} kHz` : null,
    track.bitrate ? kilobits(track.bitrate) : null,
    track.title,
    track.default ? t("domyślna") : null,
    track.forced ? t("wymuszone") : null
  ].filter(Boolean) as string[];
}

/** What a file probed before schema 2 can still say about its sound. */
function soundFallback(probe: MediaProbeDetails, plural: Plural): string[] {
  return [
    probe.audio_codec?.toUpperCase(),
    probe.audio_channels ? channelLayout(probe.audio_channels) : null,
    probe.audio_channels ? plural(probe.audio_channels, "kanał", "kanały", "kanałów") : null,
    probe.sample_rate ? `${Math.round(probe.sample_rate / 1000)} kHz` : null,
    probe.audio_streams && probe.audio_streams > 1
      ? plural(probe.audio_streams, "ścieżka", "ścieżki", "ścieżek")
      : null
  ].filter(Boolean) as string[];
}

function subtitleFallback(probe: MediaProbeDetails, plural: Plural): string[] {
  if (!probe.subtitle_streams) return [];
  return [
    plural(probe.subtitle_streams, "ścieżka", "ścieżki", "ścieżek"),
    ...(probe.subtitle_languages ?? []).map(languageName)
  ];
}

/**
 * Track rates are hundreds of kb/s, where megabits would read as "0.1".
 *
 * Below a kilobit the figure belongs to a subtitle stream — real containers
 * report tens of bits per second there — and "0 kb/s" tells nobody anything.
 */
function kilobits(bits: number): string | null {
  return bits >= 1000 ? `${Math.round(bits / 1000)} kb/s` : null;
}

/** Resolution class the card shows, by width so 2.35:1 cinema is not demoted. */
function resolutionClass(item: MediaItem): string | null {
  const width = item.video_width ?? 0;
  if (width >= 7000) return "8K";
  if (width >= 3500) return "4K";
  if (width >= 2500) return "2K";
  if (width >= 1800) return "1080p";
  if (width >= 1200) return "720p";
  return null;
}

/** "16:9", "2.35:1" — how the picture is shaped, which the pixel count hides. */
function aspectRatio(item: MediaItem): string | null {
  const width = item.video_width ?? 0;
  const height = item.video_height ?? 0;
  if (width <= 0 || height <= 0) return null;
  const ratio = width / height;
  const named: Array<[number, string]> = [
    [4 / 3, "4:3"], [16 / 9, "16:9"], [1.85, "1.85:1"], [2.35, "2.35:1"], [2.39, "2.39:1"]
  ];
  const match = named.find(([value]) => Math.abs(ratio - value) < 0.02);
  return match ? match[1] : `${ratio.toFixed(2)}:1`;
}

/** "5.1" reads faster than "6 kanałów" for anyone choosing a track. */
function channelLayout(channels: number): string | null {
  const layouts: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };
  return layouts[channels] ?? null;
}

function averageBitrate(sizeBytes: number | null, seconds: number): string | null {
  if (!sizeBytes || seconds <= 0) return null;
  return `~${((sizeBytes * 8) / seconds / 1_000_000).toFixed(1)} Mb/s`;
}

/**
 * Subtitle language codes spelled out.
 *
 * Mirrors _LANGUAGE_NAMES in src/media_server/stereo.py, which names the audio
 * and subtitle tracks in the selector right above this panel; the two must agree
 * or the same track reads as two different languages.
 */
function languageName(code: string): string {
  const names: Record<string, string> = {
    pol: "Polski", pl: "Polski", eng: "Angielski", en: "Angielski",
    ger: "Niemiecki", deu: "Niemiecki", de: "Niemiecki",
    fre: "Francuski", fra: "Francuski", fr: "Francuski",
    spa: "Hiszpański", es: "Hiszpański", ita: "Włoski", it: "Włoski",
    rus: "Rosyjski", ru: "Rosyjski", ukr: "Ukraiński", uk: "Ukraiński",
    cze: "Czeski", ces: "Czeski", slo: "Słowacki", slk: "Słowacki",
    hun: "Węgierski", jpn: "Japoński", kor: "Koreański",
    chi: "Chiński", zho: "Chiński", dut: "Niderlandzki", nld: "Niderlandzki",
    por: "Portugalski", swe: "Szwedzki", nor: "Norweski", dan: "Duński",
    fin: "Fiński", tur: "Turecki", ara: "Arabski", hin: "Hindi", heb: "Hebrajski"
  };
  // The table is keyed by ISO code and answers in Polish, which the dictionary
  // then turns into English like any other string.
  const name = names[code.toLowerCase()];
  return name === undefined ? code.toUpperCase() : t(name);
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const tail = (whole % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
}

function compatibleUrl(source: string, startSeconds: number, audioTrack: number, audioProfile: string, videoProfile: string, streamId: string): string {
  const url = new URL(source, window.location.origin);
  if (startSeconds > 0) url.searchParams.set("start_seconds", startSeconds.toFixed(3));
  else url.searchParams.delete("start_seconds");
  url.searchParams.set("audio_track", String(audioTrack));
  url.searchParams.delete("subtitle_track");
  url.searchParams.set("audio_profile", audioProfile);
  url.searchParams.set("video_profile", videoProfile);
  url.searchParams.set("stream_id", streamId);
  return url.href;
}

function compatibleKeyframeUrl(source: string, startSeconds: number, videoProfile: string): string {
  const url = new URL(source, window.location.origin);
  url.pathname = url.pathname.replace("/v1/stereo/", "/v1/stereo-keyframe/");
  url.search = "";
  url.searchParams.set("start_seconds", startSeconds.toFixed(3));
  url.searchParams.set("video_profile", videoProfile);
  return url.href;
}

function compatibleInfoUrl(source: string): string {
  const url = new URL(source, window.location.origin);
  url.pathname = url.pathname.replace("/v1/stereo/", "/v1/stereo-info/");
  url.search = "";
  return url.href;
}

function compatibleCancelUrl(source: string, streamId: string): string {
  const url = new URL(source, window.location.origin);
  url.search = "";
  url.searchParams.set("stream_id", streamId);
  return url.href;
}

function subtitleUrl(source: string, subtitleTrack: number, startSeconds: number): string {
  const url = new URL(source, window.location.origin);
  url.pathname = url.pathname.replace("/v1/stereo/", "/v1/subtitles/");
  url.search = "";
  url.searchParams.set("subtitle_track", String(subtitleTrack));
  if (startSeconds > 0) url.searchParams.set("start_seconds", startSeconds.toFixed(3));
  return url.href;
}

/** When each cue of a picture subtitle appears, and what to fetch for it. */
function subtitlePicturesUrl(source: string, subtitleTrack: number): string {
  const url = new URL(source, window.location.origin);
  url.pathname = url.pathname.replace("/v1/stereo/", "/v1/subtitle-pictures/");
  url.search = "";
  url.searchParams.set("subtitle_track", String(subtitleTrack));
  return url.href;
}

function subtitlePictureUrl(source: string, subtitleTrack: number, frame: string): string {
  const url = new URL(source, window.location.origin);
  url.pathname = url.pathname.replace("/v1/stereo/", "/v1/subtitle-picture/");
  url.search = "";
  url.searchParams.set("subtitle_track", String(subtitleTrack));
  url.searchParams.set("frame", frame);
  return url.href;
}

interface SubtitlePictureCue {
  start: number;
  end: number;
  frame: string;
}

/** Which cue covers this instant, or -1. Cues are ordered and do not overlap. */
function cueAt(cues: SubtitlePictureCue[], seconds: number): number {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cue = cues[middle]!;
    if (seconds < cue.start) high = middle - 1;
    else if (seconds >= cue.end) low = middle + 1;
    else return middle;
  }
  return -1;
}

/**
 * Name one selectable track the way somebody choosing between them reads it:
 * the language first, then how many channels, then how good it is.
 *
 * The transfer service sends the facts; the sentence is written here so it comes
 * out in whatever language the account chose. Anything ffmpeg did not report is
 * left out rather than guessed.
 */
/**
 * The line under the two selectors, which says only what is true of this film.
 *
 * Assembled rather than fixed, because a note about picture subtitles on a film
 * that has none is advice about a problem the viewer does not have.
 */
function subtitleNote(tracks: CompatibleTrack[]): string {
  const parts = [t("Napisy działają niezależnie od języka dźwięku.")];
  if (tracks.some((track) => track.source === "external")) {
    parts.push(t("Pliki .srt/.ass leżące obok filmu są na liście."));
  }
  if (tracks.some((track) => track.image === true)) {
    parts.push(t("Napisy obrazkowe (PGS/VobSub) pokazujemy jako obraz — pierwszy wybór przygotowuje je i chwilę trwa."));
  }
  return parts.join(" ");
}

function compatibleTrackLabel(track: CompatibleTrack, fallback: string): string {
  const parts = [
    track.language && track.language !== "und" ? languageName(track.language) : t("Nieznany język"),
    [track.codec?.toUpperCase(), track.channel_layout].filter(Boolean).join(" "),
    track.bitrate_kbps ? `${track.bitrate_kbps} kb/s` : null,
    // A sidecar whose name said nothing we recognise still said *something*;
    // without it two unrecognised files next to one film read identically.
    track.title && track.language === "und" ? track.title : null,
    track.default ? t("domyślna") : null,
    track.forced ? t("wymuszone") : null
  ].filter(Boolean) as string[];
  return parts.length > 1 ? parts.join(" · ") : fallback;
}


export class MediaViewer {
  private compatibleStreamId = window.crypto.randomUUID();
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly compatibilityButton: HTMLButtonElement;
  private readonly compatibilityLabel: HTMLElement;
  private activeVideo: HTMLVideoElement | null = null;
  private activeFrame: HTMLElement | null = null;
  private freezeFrame: HTMLCanvasElement | null = null;
  private activeStage: HTMLElement | null = null;
  private compatibilityStatus: HTMLElement | null = null;
  private current: MediaItem | null = null;
  private videoMode: VideoMode = "original";
  private videoRevision = 0;
  private compatibleOffset = 0;
  private compatibleSource = "";
  private compatibleInfo: CompatibleInfo | null = null;
  private audioTrack = 0;
  private subtitleTrack = -1;
  private lastProgressSent = 0;
  private playbackStarted = false;
  private listenedSeconds = 0;
  private playbackTick = 0;
  private playbackState: HTMLElement | null = null;
  private playbackStateName: "play" | "pause" | "loading" | null = null;
  private playbackStateTimer = 0;
  private frameRevealTimer = 0;
  private frameRevealGeneration = 0;
  private restartTimer = 0;
  private controlsTimer = 0;
  private compatibleRetries = 0;
  private forceH264Fallback = false;
  private restartInFlight = false;
  private desiredVideoPlaying = false;
  private pendingRestart: { item: MediaItem; targetSeconds: number } | null = null;
  private suppressVideoErrors = false;
  private subtitleObjectUrl = "";
  private subtitleRevision = 0;
  private subtitleAbortController: AbortController | null = null;
  /** Picture subtitles: the rendered cues, the overlay showing them, and its clock. */
  private pictureCues: SubtitlePictureCue[] | null = null;
  private pictureOverlay: HTMLImageElement | null = null;
  private pictureCueIndex = -1;
  private pictureTimer = 0;
  private picturePollTimer = 0;
  private releaseModal: (() => void) | null = null;
  private compatDeniedNote: string | null = null;
  private upNextPanel: HTMLElement | null = null;
  private upNextTimer = 0;

  public constructor(private readonly session: SessionResponse, private readonly onVideoOpen?: () => void) {
    this.title = el("h2", { text: t("Podgląd") });
    this.body = el("div", { className: "viewer__body" });
    const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij podgląd") } }, icon("close"));
    close.addEventListener("click", () => void this.close());
    const download = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("download"), el("span", { text: t("Pobierz") }));
    download.addEventListener("click", () => void this.download());
    download.classList.toggle("hidden", !this.canDownload());
    this.compatibilityLabel = el("span", { className: "button__label", text: t("Tryb zgodny") });
    this.compatibilityButton = el(
      "button",
      { className: "button button--secondary viewer__mode-button hidden", attrs: { type: "button" } },
      icon("volume"),
      this.compatibilityLabel
    );
    this.compatibilityButton.addEventListener("click", () => void this.toggleCompatibility());
    this.root = el(
      "div",
      { className: "viewer", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true" } },
      el("button", { className: "viewer__backdrop", attrs: { type: "button", "aria-label": t("Zamknij") } }),
      el(
        "section",
        { className: "viewer__panel" },
        el("header", { className: "viewer__header" }, this.title, el("div", { className: "viewer__actions" }, this.compatibilityButton, download, close)),
        this.body
      )
    );
    this.root.querySelector(".viewer__backdrop")?.addEventListener("click", () => void this.close());
    document.body.append(this.root);
  }

  /**
   * ``startSeconds`` resumes a film where it was left. Compatibility mode gets it
   * as the stream's starting point (the server cuts from there), while a natively
   * played file seeks once its metadata is known.
   */
  public async open(item: MediaItem, startSeconds = 0): Promise<void> {
    if (item.media_kind === "video") this.onVideoOpen?.();
    this.dismissUpNext();
    await this.stopVideo();
    this.compatibleStreamId = window.crypto.randomUUID();
    const revision = ++this.videoRevision;
    this.current = item;
    this.compatibleInfo = null;
    this.forceH264Fallback = false;
    this.audioTrack = 0;
    this.subtitleTrack = -1;
    this.playbackStarted = false;
    this.listenedSeconds = 0;
    this.playbackTick = 0;
    this.title.textContent = item.title;
    // Compatibility mode is a group right (it costs FFmpeg time on the server).
    const compatAllowed = canStreamCompat(this.session);
    this.compatibilityButton.classList.toggle("hidden", item.media_kind !== "video" || !compatAllowed);
    this.compatibilityButton.disabled = false;
    this.compatibilityStatus = null;
    this.compatDeniedNote = null;
    this.root.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-open-viewer");
    // Modal: background inert, focus inside, Escape closes (after leaving fullscreen).
    this.releaseModal?.();
    this.releaseModal = openModal(this.root, { onEscape: () => void this.close() });
    this.body.replaceChildren(el("div", { className: "viewer__loading", text: t("Przygotowywanie podglądu…") }));
    try {
      if (item.media_kind === "video") {
        const wantsCompat = compatibilityExtensions.has(item.file_extension ?? "");
        const mode: VideoMode = wantsCompat && compatAllowed ? "compatible" : "original";
        if (wantsCompat && !compatAllowed) {
          this.compatDeniedNote = t("Ten format zwykle wymaga trybu zgodnego, który jest wyłączony dla Twojej grupy — odtwarzanie może się nie udać.");
        }
        const transfer = mode === "compatible" ? await createStereoTransfer(item.id) : await createFileTransfer(item.id, true);
        if (revision !== this.videoRevision) return;
        // Never resume within the last stretch of a film: a request past the end
        // yields an empty stream, and three minutes left is not worth resuming.
        const duration = (item.duration_ms ?? 0) / 1000;
        const resume = duration > 0 ? Math.min(Math.max(0, startSeconds), Math.max(0, duration - 5)) : Math.max(0, startSeconds);
        this.mountVideo(item, transfer.url, mode, resume, true);
        return;
      }
      const transfer = await createFileTransfer(item.id, true);
      if (revision !== this.videoRevision) return;
      if (item.media_kind === "image") {
        this.body.replaceChildren(el("img", { className: "viewer__image", attrs: { src: transfer.url, alt: item.title } }));
        return;
      }
      if (textExtensions.has(item.file_extension ?? "") && (item.size_bytes ?? 0) <= 2 * 1024 * 1024) {
        const response = await fetch(transfer.url, { credentials: "same-origin" });
        if (!response.ok) throw new Error("preview failed");
        const text = await response.text();
        // The fetch and text read are slow for large files; if the viewer moved
        // on to another item meanwhile, this content must not overwrite it.
        if (revision !== this.videoRevision) return;
        this.body.replaceChildren(el("pre", { className: "viewer__text", text }));
        return;
      }
      this.body.replaceChildren(el("div", { className: "file-inspector" },
        icon(item.file_extension === "torrent" ? "magnet" : "file"),
        el("h3", { text: item.title }),
        el("p", { text: item.relative_path }),
        el("p", { text: `${(item.file_extension ?? "plik").toUpperCase()} · ${formatBytes(item.size_bytes)}` })
      ));
    } catch (error) {
      if (revision === this.videoRevision) {
        const reason = error instanceof ApiError ? ` ${error.message}` : "";
        this.body.replaceChildren(el("div", { className: "notice notice--error", text: t("Nie udało się otworzyć podglądu.{reason}", { reason }) }));
      }
    }
  }

  /**
   * The panel behind the credits: what follows, and what else there is.
   *
   * Only the next episode of a series counts down on its own — one film rolling
   * into another unasked is how a household loses an evening. Everything else
   * waits to be chosen. Any key, click or Escape cancels the countdown, and the
   * panel goes away with the film.
   */
  private async showUpNext(item: MediaItem, video: HTMLVideoElement): Promise<void> {
    const revision = this.videoRevision;
    let data;
    try {
      data = await getUpNext(item.id, 8);
    } catch {
      return;
    }
    if (revision !== this.videoRevision || this.activeVideo !== video || !this.activeStage) return;
    if (!data.next && data.suggestions.length === 0) return;

    this.dismissUpNext();
    const grid = el("div", { className: "viewer__up-next-grid" });
    const card = (entry: UpNextEntry, primary: boolean): HTMLElement => {
      const button = el(
        "button",
        {
          className: `viewer__up-next-card${primary ? " is-primary" : ""}`,
          attrs: { type: "button" }
        },
        el("span", { className: "viewer__up-next-thumb" },
          el("img", { attrs: { alt: "", loading: "lazy", decoding: "async", src: previewUrl(entry.item.id) } })),
        el("span", { className: "viewer__up-next-copy" },
          primary ? el("span", { className: "viewer__up-next-badge", text: t("Następny odcinek") }) : null,
          el("span", { className: "viewer__up-next-title", text: entry.item.title }),
          el("span", { className: "viewer__up-next-meta", text: formatDuration(entry.item.duration_ms) }))
      );
      button.addEventListener("click", () => {
        this.cancelUpNextCountdown();
        void this.open(entry.item);
      });
      return button;
    };
    if (data.next) grid.append(card(data.next, true));
    for (const entry of data.suggestions) grid.append(card(entry, false));

    const countdown = el("p", { className: "viewer__up-next-countdown" });
    const close = el(
      "button",
      { className: "button button--secondary", attrs: { type: "button" } },
      icon("close"),
      el("span", { text: t("Zamknij") })
    );
    close.addEventListener("click", () => this.dismissUpNext());
    const panel = el(
      "div",
      { className: "viewer__up-next", attrs: { role: "dialog", "aria-label": t("Co dalej") } },
      el("div", { className: "viewer__up-next-head" },
        el("h3", { text: data.next ? t("Za chwilę następny odcinek") : t("Co dalej") }),
        countdown,
        close),
      grid
    );
    this.upNextPanel = panel;
    this.activeStage.append(panel);

    if (!data.next) return;
    const target = data.next;
    let remaining = UP_NEXT_SECONDS;
    const paint = (): void => {
      countdown.textContent = t("Odtworzenie za {seconds} s — dotknij, aby zatrzymać", { seconds: remaining });
    };
    paint();
    this.upNextTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        paint();
        return;
      }
      this.cancelUpNextCountdown();
      void this.open(target.item);
    }, 1000);
    // Any sign of a person in the room stops the roll-on.
    const stop = (): void => {
      this.cancelUpNextCountdown();
      countdown.textContent = t("Odtwarzanie wstrzymane — wybierz sam");
    };
    panel.addEventListener("pointerdown", stop, { once: true });
    document.addEventListener("keydown", stop, { once: true });
  }

  private cancelUpNextCountdown(): void {
    window.clearInterval(this.upNextTimer);
    this.upNextTimer = 0;
  }

  private dismissUpNext(): void {
    this.cancelUpNextCountdown();
    this.upNextPanel?.remove();
    this.upNextPanel = null;
  }

  public async close(): Promise<void> {
    this.dismissUpNext();
    this.root.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("has-open-viewer");
    this.releaseModal?.();
    this.releaseModal = null;
    this.body.replaceChildren();
    await this.stopVideo();
  }

  public async destroy(): Promise<void> {
    await this.close();
    this.root.remove();
  }

  /**
   * ``startSeconds`` is where playback really begins and drives the timeline.
   * ``seekSeconds`` is the request that produces it, which for a copied stream is
   * a different number and must reach the server unchanged.
   */
  private mountVideo(
    item: MediaItem,
    source: string,
    mode: VideoMode,
    startSeconds: number,
    autoplay: boolean,
    seekSeconds: number = startSeconds
  ): void {
    const video = el("video", { className: "viewer__video", attrs: { controls: mode === "original", playsinline: true } });
    const playbackState = el("div", {
      className: "viewer__playback-state",
      attrs: { "aria-hidden": "true", "aria-live": "polite" }
    });
    this.playbackState = playbackState;
    this.videoMode = mode;
    this.compatibleOffset = mode === "compatible" ? Math.max(0, startSeconds) : 0;
    this.compatibleSource = mode === "compatible" ? source : "";
    video.src = mode === "compatible"
      ? compatibleUrl(source, Math.max(0, seekSeconds), this.audioTrack, this.session.settings.compatibility_audio_profile, this.activeVideoProfile(), this.compatibleStreamId)
      : source;
    video.preload = mode === "compatible" ? "auto" : "metadata";
    video.volume = Number(localStorage.getItem("media-video-volume") ?? "0.9");
    this.desiredVideoPlaying = autoplay;
    this.lastProgressSent = this.compatibleOffset;
    video.addEventListener("play", () => {
      if (!this.restartInFlight) this.desiredVideoPlaying = true;
      this.playbackTick = performance.now();
      if (!this.restartInFlight) this.showPlaybackState("play");
    });
    video.addEventListener("playing", () => {
      this.playbackTick = performance.now();
      if (!this.freezeFrame) this.clearBufferingState();
    });
    video.addEventListener("pause", () => {
      if (!this.restartInFlight) this.desiredVideoPlaying = false;
      this.playbackTick = 0;
      if (!this.restartInFlight && !video.ended) this.showPlaybackState("pause");
    });
    video.addEventListener("waiting", () => {
      this.playbackTick = 0;
      this.showPlaybackState("loading", true);
    });
    video.addEventListener("stalled", () => this.showPlaybackState("loading", true));
    video.addEventListener("seeking", () => {
      this.playbackTick = 0;
      this.showPlaybackState("loading", true);
    });
    video.addEventListener("seeked", () => {
      if (!this.restartInFlight && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) this.clearBufferingState();
    });
    video.addEventListener("timeupdate", () => {
      this.captureListenedTime(video, item);
      const position = this.globalVideoTime(video);
      if (position - this.lastProgressSent >= 20) {
        this.lastProgressSent = position;
        void recordPlayback(item.id, "progress", position * 1000).catch(() => undefined);
      }
    });
    video.addEventListener("ended", () => {
      this.captureListenedTime(video, item);
      this.qualifyPlayback(video, item);
      const duration = (item.duration_ms ?? 0) / 1000;
      if (duration === 0 || this.globalVideoTime(video) >= duration - 3) {
        void recordPlayback(item.id, "complete").catch(() => undefined);
      }
      void this.showUpNext(item, video);
    });
    this.compatibilityStatus = el(
      "div",
      { className: `viewer__compatibility${mode === "compatible" || this.compatDeniedNote ? " is-ready" : ""}` },
      icon("info"),
      el("p", { text: this.compatDeniedNote ?? this.modeDescription(mode) })
    );
    this.activeVideo = video;
    video.addEventListener("playing", () => {
      this.compatibleRetries = 0;
    });
    video.addEventListener("error", () => {
      if (this.suppressVideoErrors || this.restartInFlight || this.videoMode !== "compatible" || this.activeVideo !== video || this.compatibleRetries >= 2) return;
      this.compatibleRetries += 1;
      if (this.activeVideoProfile() === "native_copy") {
        this.forceH264Fallback = true;
      }
      this.scheduleCompatibleRestart(item, this.globalVideoTime(video), 650 * this.compatibleRetries);
    });
    this.updateCompatibilityButton();
    const frame = el("div", { className: "viewer__video-frame" }, video, playbackState);
    const stage = el("div", { className: "viewer__video-stage" }, frame);
    this.activeStage = stage;
    this.activeFrame = frame;
    if (mode === "compatible") {
      stage.append(this.compatibleControls(item, video, source, stage));
      const closeFullscreen = el("button", { className: "viewer__fullscreen-close icon-button", attrs: { type: "button", "aria-label": t("Zamknij pełny ekran") } }, icon("close"));
      closeFullscreen.addEventListener("click", () => void document.exitFullscreen().catch(() => undefined));
      stage.append(closeFullscreen);
    }
    // Facts first, then the note about how the film is being delivered: the note
    // explains the picture, so it reads last.
    const details = technicalDetails(item);
    if (details) stage.append(details);
    stage.append(this.compatibilityStatus);
    this.body.replaceChildren(stage);
    if (mode === "original" && startSeconds > 0) {
      video.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(video.duration)) video.currentTime = Math.min(startSeconds, Math.max(0, video.duration - 0.25));
      }, { once: true });
    }
    if (autoplay) {
      // A browser that refuses autoplay leaves the button claiming the film is
      // running, and the next press would then try to pause a paused video.
      void video.play().catch(() => {
        if (this.activeVideo === video) this.desiredVideoPlaying = false;
      });
    }
  }

  private compatibleControls(item: MediaItem, video: HTMLVideoElement, source: string, stage: HTMLElement): HTMLElement {
    let duration = Math.max(0, (item.duration_ms ?? 0) / 1000);
    const play = el("button", { className: "player-control player-control--primary", attrs: { type: "button", "aria-label": t("Odtwórz") } }, icon("play"));
    const progress = el("input", {
      className: "viewer-controls__progress",
      attrs: { type: "range", min: "0", max: String(duration || 1), step: "0.01", value: String(this.compatibleOffset), "aria-label": t("Pozycja filmu") }
    });
    const progressPreview = el("output", { className: "viewer-controls__seek-preview", text: clock(this.compatibleOffset) });
    const progressWrap = el("div", { className: "viewer-controls__progress-wrap" }, progress, progressPreview);
    const time = el("span", { className: "viewer-controls__time", text: `${clock(this.compatibleOffset)} / ${clock(duration)}` });
    let scrubbing = false;
    let requestedPosition: number | null = null;
    const volume = el("input", {
      className: "viewer-controls__volume",
      attrs: { type: "range", min: "0", max: "1", step: "0.01", value: String(video.volume), "aria-label": t("Głośność") }
    });
    const mute = el("button", { className: "player-control viewer-controls__mute", attrs: { type: "button", "aria-label": t("Wycisz film"), "aria-pressed": "false" } }, icon("volume"));
    const fullscreen = el("button", { className: "player-control viewer-controls__fullscreen", attrs: { type: "button", "aria-label": t("Pełny ekran") } }, icon("film"));
    const tracks = el("div", { className: "viewer-controls__tracks" });
    const paint = (): void => {
      const actualPosition = Math.min(duration || Number.MAX_SAFE_INTEGER, this.globalVideoTime(video));
      const position = scrubbing || requestedPosition !== null ? Number(progress.value) : actualPosition;
      if (!scrubbing && requestedPosition === null) progress.value = String(actualPosition);
      time.textContent = `${clock(position)} / ${clock(duration)}`;
      // Intent, not `video.paused`: the element still reports "paused" while the
      // promise from play() is in flight, and the play/pause listeners in
      // mountVideo write real state back into desiredVideoPlaying anyway.
      const paused = !this.desiredVideoPlaying;
      play.replaceChildren(icon(paused ? "play" : "pause"));
      play.setAttribute("aria-label", paused ? t("Odtwórz") : t("Pauza"));
    };
    const applyInfo = (info: CompatibleInfo): void => {
      if (typeof info.duration_seconds === "number" && info.duration_seconds > 0) {
        duration = info.duration_seconds;
        item.duration_ms = Math.round(duration * 1000);
        progress.max = String(duration);
      }
      this.renderTrackSelectors(tracks, item, info);
      this.setCompatibilityStatus("ready", this.modeDescription("compatible", info));
      paint();
    };
    if (this.compatibleInfo) applyInfo(this.compatibleInfo);
    else {
      tracks.replaceChildren(el("span", { className: "viewer-controls__track-status", text: t("Wykrywanie ścieżek…") }));
      void fetch(compatibleInfoUrl(source), { credentials: "same-origin", cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("media info failed");
          return response.json() as Promise<CompatibleInfo>;
        })
        .then((info) => {
          if (this.activeVideo !== video) return;
          this.compatibleInfo = info;
          applyInfo(info);
        })
        .catch(() => {
          if (this.activeVideo === video) tracks.replaceChildren(el("span", { className: "viewer-controls__track-status", text: t("Ścieżka domyślna") }));
        });
    }
    /**
     * Toggle against what the viewer asked for, not against `video.paused`.
     *
     * Right after a film starts, play() has been called but the element still
     * reports `paused === true` until the first frame is decoded. Reading that
     * flag made the first press of Pause ask the video to *play* again, so the
     * pause only took on the second press.
     */
    const togglePlayback = (): void => {
      const shouldPlay = !this.desiredVideoPlaying;
      this.desiredVideoPlaying = shouldPlay;
      paint();
      if (!shouldPlay) {
        // Pause reaches the element even mid-restart. It used to only record the
        // wish and wait for the new stream to apply it — which meant that during
        // the seconds a restart takes (opening a film at a resumed position is
        // one), the picture carried on playing while the button said "paused",
        // and whether the film actually stopped came down to how many times the
        // reader had pressed by the time the stream landed. The element making
        // the sound is this one; pausing it is never wrong.
        video.pause();
        return;
      }
      // Playing again is left to the restart when one is under way: the element
      // is being reloaded, and play() on a source mid-`load()` only aborts. The
      // restart reads the same intent when its stream is ready.
      if (!this.restartInFlight) void video.play().catch(() => undefined);
    };
    play.addEventListener("click", togglePlayback);
    video.addEventListener("play", paint);
    video.addEventListener("pause", paint);
    video.addEventListener("timeupdate", paint);
    progress.addEventListener("input", () => {
      scrubbing = true;
      const target = Number(progress.value);
      progressPreview.textContent = clock(target);
      progressPreview.style.setProperty("--seek-progress", String(duration > 0 ? target / duration : 0));
      progressWrap.classList.add("is-scrubbing");
      time.textContent = `${clock(target)} / ${clock(duration)}`;
    });
    progress.addEventListener("change", () => {
      const target = Number(progress.value);
      scrubbing = false;
      requestedPosition = target;
      progressWrap.classList.remove("is-scrubbing");
      progressWrap.classList.add("is-seeking");
      this.scheduleCompatibleRestart(item, target);
    });
    video.addEventListener("canplay", () => {
      if (this.pendingRestart) return;
      requestedPosition = null;
      progressWrap.classList.remove("is-seeking");
      paint();
    });
    volume.addEventListener("input", () => {
      video.volume = Number(volume.value);
      if (video.volume > 0) video.muted = false;
      localStorage.setItem("media-video-volume", volume.value);
    });
    const paintMute = (): void => {
      const muted = video.muted || video.volume === 0;
      mute.setAttribute("aria-pressed", String(muted));
      mute.setAttribute("aria-label", muted ? t("Włącz dźwięk filmu") : t("Wycisz film"));
      mute.replaceChildren(icon(muted ? "volume-muted" : "volume"));
    };
    mute.addEventListener("click", () => {
      video.muted = !video.muted;
      paintMute();
    });
    video.addEventListener("volumechange", paintMute);
    fullscreen.addEventListener("click", () => void stage.requestFullscreen().catch(() => undefined));
    video.addEventListener("click", togglePlayback);
    const revealControls = (): void => {
      stage.classList.add("is-controls-visible");
      window.clearTimeout(this.controlsTimer);
      this.controlsTimer = window.setTimeout(() => {
        if (!stage.classList.contains("is-seeking")) stage.classList.remove("is-controls-visible");
      }, 2800);
    };
    stage.addEventListener("pointermove", revealControls);
    stage.addEventListener("focusin", revealControls);
    stage.addEventListener("fullscreenchange", revealControls);
    paint();
    paintMute();
    const primary = el("div", { className: "viewer-controls__primary" }, play, progressWrap, time, mute, volume, fullscreen);
    return el("div", { className: "viewer-controls" }, primary, tracks);
  }

  private renderTrackSelectors(root: HTMLElement, item: MediaItem, info: CompatibleInfo): void {
    const audio = el("select", { className: "input input--compact", attrs: { "aria-label": t("Ścieżka dźwiękowa") } });
    for (const track of info.audio_tracks) {
      const option = el("option", { attrs: { value: String(track.index) }, text: compatibleTrackLabel(track, t("Ścieżka {number}", { number: track.index + 1 })) });
      option.selected = track.index === this.audioTrack;
      audio.append(option);
    }
    audio.disabled = info.audio_tracks.length <= 1;
    audio.addEventListener("change", () => {
      this.audioTrack = Number(audio.value);
      this.scheduleCompatibleRestart(item, this.activeVideo ? this.globalVideoTime(this.activeVideo) : this.compatibleOffset);
    });

    const subtitles = el("select", { className: "input input--compact", attrs: { "aria-label": t("Napisy") } });
    const off = el("option", { attrs: { value: "-1" }, text: t("Napisy: wyłączone") });
    off.selected = this.subtitleTrack < 0;
    subtitles.append(off);
    for (const track of info.subtitle_tracks) {
      // Every track is offered now: a picture subtitle is shown as the picture
      // it is, which needs nothing installed and cannot mis-read a letter.
      const base = compatibleTrackLabel(track, t("Napisy {number}", { number: track.index + 1 }));
      // A sidecar says so: two tracks in the same language are otherwise the same
      // line twice, and which one is the file matters when one of them is wrong.
      const named = track.source === "external" ? t("{label} — z pliku obok filmu", { label: base }) : base;
      const label = track.image ? t("{label} — napisy obrazkowe", { label: named }) : named;
      const option = el("option", { attrs: { value: String(track.index) }, text: label });
      option.selected = track.index === this.subtitleTrack;
      subtitles.append(option);
    }
    subtitles.disabled = subtitles.options.length <= 1;
    subtitles.addEventListener("change", () => {
      this.subtitleTrack = Number(subtitles.value);
      if (this.activeVideo) void this.applySubtitle(this.activeVideo);
    });
    root.replaceChildren(
      el("label", {}, icon("volume"), audio),
      el("label", {}, icon("file"), subtitles),
      el("p", {
        className: "viewer-tracks__note",
        text: subtitleNote(info.subtitle_tracks)
      })
    );
  }

  private clearSubtitles(video: HTMLVideoElement): void {
    this.subtitleAbortController?.abort();
    this.subtitleAbortController = null;
    for (const textTrack of Array.from(video.textTracks)) {
      textTrack.mode = "disabled";
      for (const cue of Array.from(textTrack.cues ?? [])) {
        try { textTrack.removeCue(cue); } catch { /* cue may already be detached */ }
      }
    }
    for (const track of Array.from(video.querySelectorAll("track[data-compatible-subtitle]"))) track.remove();
    if (this.subtitleObjectUrl) URL.revokeObjectURL(this.subtitleObjectUrl);
    this.subtitleObjectUrl = "";
    this.clearPictureSubtitles();
  }

  /** Take down the picture overlay and everything driving it. */
  private clearPictureSubtitles(): void {
    window.clearInterval(this.pictureTimer);
    window.clearTimeout(this.picturePollTimer);
    this.pictureTimer = 0;
    this.picturePollTimer = 0;
    this.pictureCues = null;
    this.pictureCueIndex = -1;
    this.pictureOverlay?.remove();
    this.pictureOverlay = null;
  }

  /**
   * Show a picture subtitle by showing the picture.
   *
   * PGS and VobSub hold no text — they hold the bitmap the author drew. Laying
   * that bitmap over the film is the exact thing, needs nothing installed, and
   * cannot mis-read a letter. The server renders each cue onto a canvas the size
   * of the picture, so the overlay obeys the same two CSS rules as the video
   * element and lines up without a single calculation here.
   */
  private async applyPictureSubtitle(video: HTMLVideoElement, revision: number): Promise<void> {
    if (!this.compatibleSource || !this.activeFrame) return;
    this.setCompatibilityStatus("working", t("Przygotowywanie napisów… Film odtwarza się dalej."));
    const source = this.compatibleSource;
    const track = this.subtitleTrack;
    const response = await fetch(subtitlePicturesUrl(source, track), {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (revision !== this.subtitleRevision || this.activeVideo !== video) return;
    // 202: the track is being rendered. Tens of seconds for a whole film, so the
    // film keeps playing and this asks again instead of blocking on it.
    if (response.status === 202) {
      this.setCompatibilityStatus("working", t("Przygotowywanie napisów obrazkowych… Film odtwarza się dalej."));
      this.picturePollTimer = window.setTimeout(() => {
        if (revision === this.subtitleRevision && this.activeVideo === video) {
          void this.applyPictureSubtitle(video, revision);
        }
      }, 4000);
      return;
    }
    if (!response.ok) throw new Error(`subtitle pictures ${response.status}`);
    const manifest = await response.json() as { cues?: SubtitlePictureCue[] };
    const cues = manifest.cues ?? [];
    if (revision !== this.subtitleRevision || this.activeVideo !== video || cues.length === 0) return;
    this.pictureCues = cues;
    this.pictureCueIndex = -1;
    const overlay = el("img", {
      className: "viewer__subtitle-picture",
      attrs: { alt: "", decoding: "async", "aria-hidden": "true" }
    }) as HTMLImageElement;
    this.pictureOverlay = overlay;
    this.activeFrame.append(overlay);
    // Ten times a second: finer than a viewer can notice, coarse enough to cost
    // nothing. A timer rather than the video's own events, because `timeupdate`
    // fires about four times a second and would show cues visibly late.
    this.pictureTimer = window.setInterval(() => this.drawPictureCue(video, source, track), 100);
    this.drawPictureCue(video, source, track);
    this.setCompatibilityStatus("ready", this.modeDescription("compatible", this.compatibleInfo));
  }

  /** Put the cue for this instant on screen, and warm the next few. */
  private drawPictureCue(video: HTMLVideoElement, source: string, track: number): void {
    const cues = this.pictureCues;
    const overlay = this.pictureOverlay;
    if (!cues || !overlay) return;
    const index = cueAt(cues, this.globalVideoTime(video));
    if (index === this.pictureCueIndex) return;
    this.pictureCueIndex = index;
    if (index < 0) {
      overlay.removeAttribute("src");
      overlay.classList.remove("is-visible");
      return;
    }
    overlay.src = subtitlePictureUrl(source, track, cues[index]!.frame);
    overlay.classList.add("is-visible");
    // Fetched before they are needed, so a cue appears the moment it should
    // rather than a network round trip afterwards.
    for (const ahead of cues.slice(index + 1, index + 4)) {
      new Image().src = subtitlePictureUrl(source, track, ahead.frame);
    }
  }

  private async applySubtitle(video: HTMLVideoElement): Promise<void> {
    const revision = ++this.subtitleRevision;
    this.clearSubtitles(video);
    if (this.subtitleTrack < 0 || !this.compatibleSource) return;
    const selectedTrack = this.compatibleInfo?.subtitle_tracks.find((candidate) => candidate.index === this.subtitleTrack);
    if (selectedTrack?.image) {
      try {
        await this.applyPictureSubtitle(video, revision);
      } catch {
        if (revision === this.subtitleRevision) {
          this.setCompatibilityStatus("error", t("Nie udało się wczytać wybranych napisów."));
        }
      }
      return;
    }
    const abortController = new AbortController();
    this.subtitleAbortController = abortController;
    this.setCompatibilityStatus("working", t("Przygotowywanie napisów… Film odtwarza się dalej."));
    try {
      const response = await fetch(subtitleUrl(this.compatibleSource, this.subtitleTrack, this.compatibleOffset), {
        credentials: "same-origin",
        cache: "no-store",
        signal: abortController.signal
      });
      if (!response.ok) throw new Error(`subtitle ${response.status}`);
      const content = await response.text();
      const selected = this.compatibleInfo?.subtitle_tracks.find((candidate) => candidate.index === this.subtitleTrack);
      if (!content.trimStart().startsWith("WEBVTT")) throw new Error("invalid WebVTT");
      if (revision !== this.subtitleRevision || this.activeVideo !== video) return;
      const objectUrl = URL.createObjectURL(new Blob([content], { type: "text/vtt;charset=utf-8" }));
      this.subtitleObjectUrl = objectUrl;
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = selected ? compatibleTrackLabel(selected, t("Wybrane napisy")) : t("Wybrane napisy");
      track.srclang = selected?.language || "und";
      track.default = true;
      track.dataset.compatibleSubtitle = "true";
      track.src = objectUrl;
      track.addEventListener("load", () => {
        track.track.mode = "showing";
        this.setCompatibilityStatus("ready", this.modeDescription("compatible", this.compatibleInfo));
      }, { once: true });
      track.addEventListener("error", () => this.setCompatibilityStatus("error", t("Nie udało się wczytać wybranych napisów.")), { once: true });
      video.append(track);
      window.setTimeout(() => { if (track.track) track.track.mode = "showing"; }, 0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (revision === this.subtitleRevision) this.setCompatibilityStatus("error", t("Nie udało się wczytać wybranych napisów."));
    } finally {
      if (this.subtitleAbortController === abortController) this.subtitleAbortController = null;
    }
  }

  /** Ask which seek request to send and where the picture will actually begin.
   *
   * The two differ. ``seek`` has to be replayed verbatim, because asking the
   * server for the resolved instant would step back to the previous index point
   * and desynchronise the timeline from the picture.
   */
  private async resolveCompatiblePlan(source: string, targetSeconds: number): Promise<{ seek: number; start: number }> {
    const fallback = { seek: targetSeconds, start: targetSeconds };
    if (targetSeconds <= 0) return { seek: 0, start: 0 };
    try {
      const response = await fetch(compatibleKeyframeUrl(source, targetSeconds, this.activeVideoProfile()), {
        credentials: "same-origin"
      });
      if (!response.ok) return fallback;
      const payload = (await response.json()) as { seek_seconds?: number; start_seconds?: number };
      const seek = Number(payload.seek_seconds);
      const start = Number(payload.start_seconds);
      if (!Number.isFinite(seek) || !Number.isFinite(start) || seek < 0 || start < 0) return fallback;
      return { seek, start };
    } catch {
      return fallback;
    }
  }

  private scheduleCompatibleRestart(item: MediaItem, targetSeconds: number, delay = 360): void {
    if (!Number.isFinite(targetSeconds)) return;
    this.pendingRestart = { item, targetSeconds };
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.frameRevealTimer);
    this.frameRevealGeneration += 1;
    this.activeStage?.classList.add("is-seeking", "is-controls-visible");
    this.showPlaybackState("loading", true);
    this.setCompatibilityStatus("working", t("Przewijanie do {time}…", { time: clock(targetSeconds) }));
    if (this.restartInFlight) return;
    this.restartTimer = window.setTimeout(() => void this.restartCompatible(), delay);
  }

  private async restartCompatible(): Promise<void> {
    if (this.restartInFlight) return;
    const request = this.pendingRestart;
    const video = this.activeVideo;
    if (!request || !video || this.videoMode !== "compatible") return;
    this.pendingRestart = null;
    this.restartInFlight = true;
    this.showPlaybackState("loading", true);
    const revision = this.videoRevision;
    this.desiredVideoPlaying = this.desiredVideoPlaying || !video.paused;
    try {
      const transfer = await createStereoTransfer(request.item.id);
      if (revision !== this.videoRevision || this.activeVideo !== video) return;
      this.suppressVideoErrors = true;
      this.captureFreezeFrame(video);
      this.subtitleRevision += 1;
      this.clearSubtitles(video);
      video.pause();
      const latest = this.pendingRestart ?? request;
      this.pendingRestart = null;
      const duration = Math.max(0, (latest.item.duration_ms ?? 0) / 1000);
      const requested = Math.max(0, Math.min(latest.targetSeconds, duration > 0 ? duration - 0.25 : latest.targetSeconds));
      const plan = await this.resolveCompatiblePlan(transfer.url, requested);
      if (revision !== this.videoRevision || this.activeVideo !== video) return;
      // The timeline follows where playback really starts; the stream request
      // carries the seek value that produces it.
      this.compatibleOffset = plan.start;
      this.compatibleSource = transfer.url;
      this.lastProgressSent = plan.start;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          video.removeEventListener("canplay", ready);
          video.removeEventListener("error", failed);
          if (error) reject(error);
          else resolve();
        };
        const ready = (): void => finish();
        const failed = (): void => finish(new Error("compatible stream failed"));
        const timeout = window.setTimeout(() => finish(new Error("compatible stream timeout")), 20000);
        video.addEventListener("canplay", ready, { once: true });
        video.addEventListener("error", failed, { once: true });
        video.src = compatibleUrl(transfer.url, plan.seek, this.audioTrack, this.session.settings.compatibility_audio_profile, this.activeVideoProfile(), this.compatibleStreamId);
        video.load();
      });
      if (revision !== this.videoRevision || this.activeVideo !== video) return;
      this.setCompatibilityStatus("ready", this.modeDescription("compatible", this.compatibleInfo));
      this.revealAfterVideoFrame(video, revision);
      void this.applySubtitle(video);
      if (this.desiredVideoPlaying) {
        await video.play().catch(() => undefined);
        if (!this.desiredVideoPlaying) video.pause();
      }
    } catch {
      if (revision === this.videoRevision) {
        this.removeFreezeFrame();
        this.hidePlaybackState();
        const streamLimit = this.session.permissions?.max_concurrent_streams ?? 0;
        this.setCompatibilityStatus(
          "error",
          streamLimit > 0
            ? t("Nie udało się uruchomić filmu. Twoje konto może mieć otwartych najwyżej {limit} strumieni naraz — zamknij inny odtwarzacz i spróbuj ponownie.", { limit: streamLimit })
            : t("Nie udało się uruchomić filmu od wybranego miejsca.")
        );
      }
    } finally {
      this.suppressVideoErrors = false;
      this.restartInFlight = false;
      if (this.pendingRestart && revision === this.videoRevision) {
        this.restartTimer = window.setTimeout(() => void this.restartCompatible(), 180);
      } else if (revision === this.videoRevision) {
        this.activeStage?.classList.remove("is-seeking");
      }
    }
  }

  private revealAfterVideoFrame(video: HTMLVideoElement, revision: number): void {
    const generation = ++this.frameRevealGeneration;
    window.clearTimeout(this.frameRevealTimer);
    const reveal = (): void => {
      if (generation !== this.frameRevealGeneration || revision !== this.videoRevision || this.activeVideo !== video) return;
      window.clearTimeout(this.frameRevealTimer);
      this.removeFreezeFrame();
      this.hidePlaybackState();
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      let frames = 0;
      let firstFrameAt = 0;
      const stableFrame = (now: number): void => {
        if (generation !== this.frameRevealGeneration || revision !== this.videoRevision || this.activeVideo !== video) return;
        if (firstFrameAt === 0) firstFrameAt = now;
        frames += 1;
        if (frames >= 4 && now - firstFrameAt >= 180) {
          reveal();
          return;
        }
        video.requestVideoFrameCallback(stableFrame);
      };
      video.requestVideoFrameCallback(stableFrame);
      this.frameRevealTimer = window.setTimeout(reveal, 5000);
      return;
    }
    window.requestAnimationFrame(reveal);
  }

  private async toggleCompatibility(): Promise<void> {
    const item = this.current;
    const video = this.activeVideo;
    if (!item || !video || item.media_kind !== "video") return;
    const revision = ++this.videoRevision;
    const nextMode: VideoMode = this.videoMode === "original" ? "compatible" : "original";
    const previousSource = this.compatibleSource;
    const previousStreamId = this.compatibleStreamId;
    if (nextMode === "compatible") this.compatibleStreamId = window.crypto.randomUUID();
    const position = this.globalVideoTime(video);
    const wasPaused = video.paused;
    this.compatibilityButton.disabled = true;
    this.compatibilityLabel.textContent = t("Przełączanie…");
    try {
      const transfer = nextMode === "compatible" ? await createStereoTransfer(item.id) : await createFileTransfer(item.id, true);
      if (revision !== this.videoRevision) return;
      const plan = nextMode === "compatible"
        ? await this.resolveCompatiblePlan(transfer.url, position)
        : { seek: position, start: position };
      if (revision !== this.videoRevision) return;
      this.suppressVideoErrors = true;
      this.captureFreezeFrame(video);
      this.releaseVideo(video);
      if (this.videoMode === "compatible") {
        await this.cancelCompatibleStream(previousSource, previousStreamId);
        if (revision !== this.videoRevision) return;
      }
      this.activeVideo = null;
      this.mountVideo(item, transfer.url, nextMode, plan.start, !wasPaused, plan.seek);
    } catch {
      if (revision === this.videoRevision) this.setCompatibilityStatus("error", t("Nie udało się uruchomić wybranego trybu."));
    } finally {
      this.suppressVideoErrors = false;
      if (revision === this.videoRevision) {
        this.compatibilityButton.disabled = false;
        this.updateCompatibilityButton();
      }
    }
  }

  private setCompatibilityStatus(state: "working" | "ready" | "error", message: string): void {
    if (!this.compatibilityStatus) return;
    this.compatibilityStatus.classList.remove("is-working", "is-ready", "is-error");
    this.compatibilityStatus.classList.add(`is-${state}`);
    const copy = this.compatibilityStatus.querySelector("p");
    if (copy) copy.textContent = message;
  }

  private captureListenedTime(video: HTMLVideoElement, item: MediaItem): void {
    const now = performance.now();
    if (this.playbackTick > 0 && !video.paused && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.listenedSeconds += Math.min(1, Math.max(0, (now - this.playbackTick) / 1000));
      this.qualifyPlayback(video, item);
    }
    this.playbackTick = !video.paused && !video.seeking ? now : 0;
  }

  private qualifyPlayback(video: HTMLVideoElement, item: MediaItem): void {
    if (this.playbackStarted) return;
    const itemDuration = Math.max(0, (item.duration_ms ?? 0) / 1000);
    const duration = itemDuration > 0
      ? itemDuration
      : Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration <= 0) return;
    const percent = Math.max(1, Math.min(100, Number(this.session.settings.playback_threshold_percent) || 15));
    if (this.listenedSeconds + 0.05 < duration * percent / 100) return;
    this.playbackStarted = true;
    void recordPlayback(item.id, "start").catch(() => undefined);
  }

  private globalVideoTime(video: HTMLVideoElement): number {
    return (this.videoMode === "compatible" ? this.compatibleOffset : 0) + (video.currentTime || 0);
  }

  private updateCompatibilityButton(): void {
    this.compatibilityLabel.textContent = this.videoMode === "compatible" ? t("Odtwórz oryginał") : t("Tryb zgodny");
  }

  private modeDescription(mode: VideoMode, info: CompatibleInfo | null = null): string {
    if (mode === "original") {
      return t("Odtwarzany jest oryginalny plik. Jeżeli film ma obraz, ale nie ma dźwięku, przełącz na tryb zgodny.");
    }
    const videoCopy = this.activeVideoProfile() === "native_copy" && ["hevc", "h265", "h264", "avc1", "av1", "av01", "vp9", "vp09"].includes(info?.video_codec ?? "")
      ? t("Obraz jest przesyłany bez ponownego kodowania.")
      : t("Obraz jest dekodowany sprzętowo i kodowany na bieżąco.");
    const audioCopy = {
      stereo_low: t("Dźwięk jest miksowany do AAC stereo 128 kb/s."),
      stereo_standard: t("Dźwięk jest miksowany do AAC stereo 192 kb/s."),
      stereo_high: t("Dźwięk jest miksowany do AAC stereo 320 kb/s."),
      surround_aac: t("Układ kanałów źródłowych jest zachowywany w wielokanałowym AAC do 512 kb/s (tryb eksperymentalny).")
    }[this.session.settings.compatibility_audio_profile]
      ?? t("Dźwięk jest miksowany do AAC stereo.");
    return `${videoCopy} ${audioCopy}`;
  }

  private activeVideoProfile(): string {
    return this.forceH264Fallback ? "h264_fallback" : this.session.settings.compatibility_video_profile;
  }
  private showPlaybackState(state: "play" | "pause" | "loading", persistent = false): void {
    const overlay = this.playbackState;
    if (!overlay) return;
    window.clearTimeout(this.playbackStateTimer);
    const labels = { play: "Odtwarzanie", pause: t("Pauza"), loading: "Buforowanie" } as const;
    this.playbackStateName = state;
    overlay.className = `viewer__playback-state is-${state} is-visible`;
    overlay.setAttribute("aria-hidden", "false");
    overlay.setAttribute("aria-label", labels[state]);
    // Fresh nodes on every call, so a repeated state restarts its keyframes.
    const stack = el("div", { className: "viewer__playback-state-stack" });
    stack.innerHTML = PLAYBACK_STATE_MARKUP[state];
    overlay.replaceChildren(stack);
    if (!persistent) this.playbackStateTimer = window.setTimeout(() => this.hidePlaybackState(), 720);
  }

  /** Clear a spinner once real frames arrive, without cutting a play/pause flash short. */
  private clearBufferingState(): void {
    if (this.playbackStateName === "loading") this.hidePlaybackState();
  }

  private hidePlaybackState(): void {
    window.clearTimeout(this.playbackStateTimer);
    this.playbackStateName = null;
    this.playbackState?.classList.remove("is-visible");
    this.playbackState?.setAttribute("aria-hidden", "true");
  }

  private captureFreezeFrame(video: HTMLVideoElement): void {
    if (!this.activeFrame || video.videoWidth < 1 || video.videoHeight < 1) return;
    this.removeFreezeFrame();
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    canvas.className = "viewer__freeze-frame";
    this.activeFrame.append(canvas);
    this.freezeFrame = canvas;
  }

  private removeFreezeFrame(): void {
    this.freezeFrame?.remove();
    this.freezeFrame = null;
  }

  private releaseVideo(video: HTMLVideoElement): void {
    this.subtitleRevision += 1;
    this.clearSubtitles(video);
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  private async cancelCompatibleStream(source = this.compatibleSource, streamId = this.compatibleStreamId): Promise<void> {
    if (!source || !streamId) return;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 4000);
    try {
      await fetch(compatibleCancelUrl(source, streamId), {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.signal
      });
    } catch {
      // A closed page or an already-ended stream needs no further client recovery.
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async stopVideo(): Promise<void> {
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.controlsTimer);
    window.clearTimeout(this.playbackStateTimer);
    window.clearTimeout(this.frameRevealTimer);
    this.frameRevealGeneration += 1;
    this.pendingRestart = null;
    this.restartInFlight = false;
    this.videoRevision += 1;
    const previousSource = this.compatibleSource;
    const previousStreamId = this.compatibleStreamId;
    const previousMode = this.videoMode;
    const previousVideo = this.activeVideo;
    if (document.fullscreenElement === this.activeStage) void document.exitFullscreen().catch(() => undefined);
    this.suppressVideoErrors = true;
    if (previousVideo) this.releaseVideo(previousVideo);
    this.suppressVideoErrors = false;
    this.activeVideo = null;
    this.activeStage = null;
    this.activeFrame = null;
    this.playbackState = null;
    this.removeFreezeFrame();
    this.compatibleSource = "";
    this.compatibleOffset = 0;
    if (previousMode === "compatible") await this.cancelCompatibleStream(previousSource, previousStreamId);
  }

  private async download(): Promise<void> {
    if (!this.current || !this.canDownload()) return;
    try {
      const transfer = await createFileTransfer(this.current.id, false);
      window.location.assign(transfer.url);
    } catch (error) {
      window.alert(error instanceof ApiError && (error.status === 429 || error.status === 403)
        ? error.message
        : t("Nie udało się przygotować pobierania."));
    }
  }

  private canDownload(): boolean {
    return can(this.session, "can_download_file");
  }
}
