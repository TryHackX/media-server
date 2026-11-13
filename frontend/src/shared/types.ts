import { DEFAULT_LANGUAGE, type Language } from "./i18n";
import type { RepeatMode, ShuffleMode } from "./player-state";
import type { Theme } from "./theme";

export type UserRole = "user" | "admin" | "super_admin";
export type LibraryKind = "music" | "movies";
export type MediaKind = "audio" | "video" | "image" | "other";

interface UserProfile {
  id: number;
  username: string;
  role: UserRole;
  is_guest: boolean;
}

export interface SessionResponse {
  authenticated: true;
  user: UserProfile;
  csrf_token: string;
  settings: AdminSettings;
  permissions: EffectivePermissions;
  preferences: UserPreferences;
}

/** What the playback queue shows; chosen per account, not per browser. */
interface QueueColumnPreferences {
  index: boolean;
  favorite: boolean;
  rating: "own" | "average" | "none";
}

/**
 * What a playlist wants its queue to show, overriding the listening account.
 *
 * `owner` is the person who made the list, `viewer` is whoever is playing it —
 * two values rather than one "own", because "own" names a different person
 * depending on who reads it. `inherit` is the default and means "leave it to the
 * account", which is what every list already existing does.
 */
export type CollectionQueueRating = "inherit" | "owner" | "viewer" | "average" | "none";
export type CollectionQueueFavorite = "inherit" | "owner" | "viewer" | "none";

/** The two settings resolved against the account: no `inherit` left to decide. */
export interface QueueDisplay {
  index: boolean;
  favorite: Exclude<CollectionQueueFavorite, "inherit">;
  rating: Exclude<CollectionQueueRating, "inherit">;
  /** Named in the row's tooltip when the stars belong to somebody else. */
  ownerName: string;
}

export interface UserPreferences {
  /** Interface language; Polish for accounts that never chose. */
  language: Language;
  /**
   * The colour theme (shared/theme.ts). Absent from a bridge that does not store
   * it — then the choice lives in the browser alone, per device.
   */
  theme?: Theme;
  queue: QueueColumnPreferences;
}

export const defaultUserPreferences: UserPreferences = {
  language: DEFAULT_LANGUAGE,
  queue: { index: true, favorite: true, rating: "own" }
};

export interface MediaItem {
  id: number;
  /**
   * Films in a listing (browse, a playlist): where this account left it — between 2 % and 95 % of
   * its length, the start page's "Kontynuuj" rule (LibraryBrowser::withSavedPositions); absent
   * otherwise. Drawn as a line along the foot of the card's picture.
   */
  position_ms?: number;
  progress?: number;
  relative_path: string;
  media_kind: MediaKind;
  mime_type: string | null;
  file_extension: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  year: string | null;
  genre: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  bitrate: number | null;
  sample_rate: number | null;
  channels: number | null;
  favorite: boolean;
  rating: number | null;
  play_count: number;
  avg_rating: number;
  rating_count: number;
  favorite_count: number;
  /**
   * The playlist owner's own rating and favourite mark, sent only by a playlist
   * that asked to show them. Absent — not null — when nobody asked, so "the
   * owner has not rated this" stays distinguishable from "we never looked".
   */
  owner_rating?: number | null;
  owner_favorite?: boolean;
  /** Read from the file by ffprobe; null until the film has been probed. */
  video_width?: number | null;
  video_height?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  is_hdr?: boolean;
  /** The rest of what ffprobe found, for the technical details panel. */
  probe?: MediaProbeDetails | null;
}

/** One selectable track inside a container, as ffprobe described it. */
export interface MediaProbeTrack {
  index: number;
  codec?: string;
  profile?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: number;
  bitrate?: number;
  language?: string;
  title?: string;
  default?: boolean;
  forced?: boolean;
}

/** Everything ffprobe reported that is worth showing but not worth querying on. */
export interface MediaProbeDetails {
  container?: string;
  video_codec?: string;
  video_profile?: string;
  /** The picture's own rate; `bitrate` below is the whole file. */
  video_bitrate?: number;
  pixel_format?: string;
  color_space?: string;
  color_transfer?: string;
  /** Derived from the pixel format: yuv420p10le is ten bits. */
  bit_depth?: number;
  frame_rate?: number;
  bitrate?: number;
  audio_codec?: string;
  audio_channels?: number;
  sample_rate?: number;
  audio_streams?: number;
  subtitle_streams?: number;
  subtitle_languages?: string[];
  hdr?: boolean;
  /** Probe schema 2 and later: every track, not only the first of each kind. */
  audio_tracks?: MediaProbeTrack[];
  subtitle_tracks?: MediaProbeTrack[];
}

export interface LibraryDirectory {
  id: number;
  name: string;
  relative_path: string;
  direct_file_count: number;
  descendant_file_count: number;
  total_size_bytes: number;
  preview_media_item_id: number | null;
  preview_kind: MediaKind | null;
  preview_candidates: Array<{ id: number; kind: MediaKind }>;
  avg_rating: number;
  rating_count: number;
}

interface LibraryBreadcrumb {
  id: number;
  name: string;
}

export interface LibraryPage {
  directory: LibraryDirectory;
  breadcrumbs: LibraryBreadcrumb[];
  directories: LibraryDirectory[];
  items: MediaItem[];
  page: number;
  has_more: boolean;
  query: string;
  /** Echoed back: only the filters the server accepted and applied. */
  filters: LibraryFilters;
  /** How many files match while filtering; null when nothing is filtered. */
  filtered_total: number | null;
}

/**
 * Picture filters, from what ffprobe wrote into the catalogue.
 *
 * A folder has no resolution, so a filtered listing is a flat list of files
 * gathered from the whole subtree — the same shape a search produces.
 */
export interface LibraryFilters {
  resolution?: "uhd" | "fhd" | "hd";
  hdr?: "yes" | "no";
  video_codec?: string;
  audio_codec?: string;
  /**
   * Films: what the story is and when it came out. Neither is in the file —
   * both come from the title lookup, so both are absent until one has run.
   */
  genre?: string;
  /** Music: the genre its tag states, which is free text rather than a slug. */
  tag_genre?: string;
  decade?: string;
  /** Music: file format, whether every sample was kept, and hi-res masters. */
  format?: string;
  quality?: "lossless" | "high" | "standard";
  hires?: "yes" | "no";
}

/** One genre from the catalogue dictionary, in both interface languages. */
export interface GenreOption {
  id: number;
  slug: string;
  name_pl: string;
  name_en: string;
  count: number;
}

export interface LibraryFilterOptions {
  /** Files there is anything to filter on; zero means "nothing to offer yet". */
  probed: number;
  video_codecs: Array<{ value: string; count: number }>;
  audio_codecs: Array<{ value: string; count: number }>;
  resolutions: Partial<Record<"uhd" | "fhd" | "hd", number>>;
  /** Films: how many carry HDR. Music: how many are 88.2 kHz or better. */
  hdr: number;
  formats: Array<{ value: string; count: number }>;
  quality: { lossless: number; high: number; standard: number };
  hires?: number;
  /** Films only, and only once a title lookup has filled them in. */
  genres?: GenreOption[];
  /** Music only: genres as the taggers spelled them, commonest first. */
  tag_genres?: Array<{ value: string; count: number }>;
  decades?: Array<{ decade: number; count: number }>;
  /** How many files in this library carry no genre at all. */
  unidentified?: number;
}

export interface QueuePage {
  items: MediaItem[];
  next_cursor: number | null;
  has_more: boolean;
  offset: number;
  total: number;
}

export type LibrarySort =
  | "title_asc"
  | "title_desc"
  | "plays_desc"
  | "rating_desc"
  | "rating_count_desc"
  | "size_desc"
  | "duration_desc"
  | "duration_asc"
  | "random";

export interface FileTransfer {
  method: "GET";
  /** Carries the sealed ticket in its path; the browser never sees the file path. */
  url: string;
  name: string;
  media_kind: string;
}

export interface ArchiveTransfer {
  method: "POST";
  url: string;
  form: { token: string };
  name: string;
  count: number;
  /** Left out because the group's extension whitelist does not admit them. */
  skipped?: number;
}

export interface RatingSummary {
  user_rating: number | null;
  user_favorite: boolean;
  avg_rating: number;
  rating_count: number;
  favorite_count: number;
}

/**
 * One minute of server history: what happened *during* that minute.
 *
 * The counters behind these are cumulative and reset with the process, so the
 * service stores differences instead — and marks the sample where it noticed a
 * restart, because the minute across a restart is unknowable rather than zero.
 */
interface ServerStatsSample {
  at: string;
  active: number;
  requests: number;
  transfers: number;
  bytes: number;
  errors: number;
  restarted: boolean;
  cache: Record<string, { bytes: number; files: number }>;
}

export interface ServerStats {
  hours: number;
  interval_seconds: number;
  current: Record<string, number | string>;
  cache: Record<string, { bytes: number; files: number }>;
  totals: {
    samples: number;
    bytes: number;
    transfers: number;
    requests: number;
    errors: number;
    peak_active: number;
    restarts: number;
  };
  samples: ServerStatsSample[];
}

/** A freshly issued guest link — the only time the token is ever readable. */
export interface GuestLink {
  token: string;
  url: string;
  expires_at: string;
  max_downloads: number;
  label: string;
}

/** One link this account handed out, as its author sees it afterwards. */
export interface GuestLinkRow {
  id: number;
  target_kind: "directory" | "collection";
  target_id: number;
  label: string;
  max_downloads: number;
  downloads_used: number;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type DigestFrequency = "off" | "weekly";

/**
 * Whether this account wants "what is new in the library" by mail.
 *
 * `covered_until` is the point the last message reported up to — not when it was
 * sent, so a scan running while the mail went out is still reported next time.
 * `server` is filled in for administrators only.
 */
export interface DigestSubscription {
  frequency: DigestFrequency;
  last_sent_at: string | null;
  covered_until: string | null;
  /** Without an address there is nowhere to send it, and the control says so. */
  has_email: boolean;
  server?: { subscribers: number; last_sent_at: string | null; spooled: boolean };
}

/**
 * One session that is open right now.
 *
 * `fingerprint` is a hash of the session, never the session itself: it is what
 * "close this one" points at, and it cannot be turned back into a cookie.
 */
export interface ActiveSession {
  fingerprint: string;
  user_id: number;
  username: string;
  device_label: string;
  /** The browser that asked — the one row that must not offer "sign out". */
  is_current: boolean;
  created_at: string;
  last_seen_at: string;
}

/**
 * What one device of this account has in its player.
 *
 * The queue itself is not carried: `source` says where it came from and
 * `offset` how far in it had got, which is enough for any device to rebuild the
 * same list — the same values a page reload already uses. `track` is filled in
 * by the server so a listing can say what is playing without fetching the item.
 */
export interface PlaybackQueueDevice {
  device_id: string;
  device_label: string;
  /** True for the device that asked; the server matches, not the client. */
  is_current: boolean;
  source: QueueSourceState | null;
  offset: number;
  total: number;
  media_item_id: number | null;
  position_ms: number;
  is_playing: boolean;
  repeat: RepeatMode;
  context: string;
  updated_at: string;
  /**
   * Somebody is signed in on that device now (its session is open, as in "Aktywne sesje");
   * false: only used recently — its session ended by itself. Devices signed out are not listed.
   */
  is_live: boolean;
  track: { title: string; artist: string | null; duration_ms: number } | null;
}

/**
 * The queue's origin: a folder or a playlist, in an order, at a seed.
 *
 * Enough to rebuild the same list anywhere — which is why a reload restores the
 * loaders from it and why it is the only thing a handover carries. The player
 * knows it as `QueueSource`; both names are this type.
 */
export interface QueueSourceState {
  kind: "directory" | "collection";
  id: number;
  query: string;
  shuffleMode: ShuffleMode;
  shuffleSeed: string;
  /**
   * A playlist's order, when the queue came from one and is not shuffled.
   * Without it a rebuilt queue can fetch the first page and nothing after it:
   * the rows are there, but "what comes next" has no order to ask for.
   */
  collectionSort?: CollectionItemSort;
  /**
   * A playlist's own display rules, when the queue came from one. Carried with
   * the source rather than looked up again because the queue outlives the page
   * that built it: reopen the dock on the start page and there is nobody left to
   * ask what the playlist wanted, so the rows would quietly fall back to the
   * reader's stars instead of the author's.
   */
  queueRating?: CollectionQueueRating;
  queueFavorite?: CollectionQueueFavorite;
  ownerName?: string;
  /**
   * The playlist's or folder's own name, or the search query — what the dock
   * shows as "playing from". Empty for the library root.
   */
  label?: string;
  /** A playlist computed from rules rather than put together by hand. */
  smart?: boolean;
}

export interface AccountEntry {
  id: number;
  title: string;
  artist?: string | null;
  media_kind: MediaKind;
  play_count?: number;
  last_position_ms?: number;
  last_played_at?: string;
  rating: number | null;
  favorite?: boolean | number;
  updated_at?: string;
  avg_rating?: number;
  rating_count?: number;
  total_play_count?: number;
}

/**
 * The start page, as `GET ?action=home` describes it (HomeShelves.php; the
 * field-by-field contract is tests/test_bridge_home.py on the server's side).
 *
 * One request answers the whole page: the libraries with their counts, the
 * title to carry on with, and every shelf. A shelf is a list of cards and every
 * card has one shape, with a few fields that only some shelves fill in.
 */
export interface HomeLibrary {
  kind: LibraryKind;
  /** Playable files: tracks, or videos. */
  item_count: number;
  /** Folders that hold such files directly — albums, film and season folders. */
  folder_count: number;
  film_count: number;
  series_count: number;
  episode_count: number;
  /** Files added in the last 30 days. */
  recent_count: number;
}

/** What the catalogue knows about the work behind a video file; null for audio. */
export interface HomeWork {
  /** The matched title of the film or series; null means "show the file's own title". */
  title: string | null;
  year: number | null;
  is_series: boolean;
  season: number | null;
  episode: number | null;
  genres: Array<{ slug: string; name_pl: string; name_en: string }>;
}

export interface HomeFolder {
  id: number;
  name: string;
  relative_path: string;
  item_count: number;
  duration_ms: number | null;
  /** Music: the artist when every tagged track agrees. */
  artist: string | null;
  year: string | null;
}

/** A whole series behind one card of "Losowe seriale". */
export interface HomeSeries {
  id: number;
  title: string;
  year: number | null;
  episode_count: number;
  season_count: number;
  /** Why the card's file is this episode: never opened, left part-way, the one after the last finished, or seen through. */
  start: "first" | "resume" | "next" | "again";
  resume_ms: number | null;
}

export interface HomeCard {
  /** "item:<id>" or "folder:<id>": the same thing has the same key on every shelf. */
  key: string;
  /** One file, or a folder offered as a whole (an album, a season). */
  type: "item" | "folder";
  library: LibraryKind;
  /** The file playback starts from; for a folder card its first (new) one. */
  item: MediaItem;
  directory_id: number | null;
  folder: HomeFolder | null;
  work: HomeWork | null;
  /** Covers to try in order; the first that loads wins. */
  preview_candidates: Array<{ id: number; kind: MediaKind }>;

  // Unfinished titles (the "continue" shelves and the hero).
  position_ms?: number;
  /** 0–1. */
  progress?: number;
  remaining_ms?: number;
  last_played_at?: string;
  long_form?: boolean;

  // What follows something finished.
  reason?: "episode" | "folder";
  after?: { id: number; title: string };

  // Recently added.
  added_at?: string;
  added_count?: number;

  // Recommended, and why.
  because?: { type: "series" | "artist" | "genre"; label: string; label_en: string | null };

  // Played by the household.
  listeners?: number;

  // "Losowe seriale".
  series?: HomeSeries;
}

export interface HomeShelf {
  cards: HomeCard[];
  has_more: boolean;
  /** The random shelves only: the seed this draw was made with. */
  seed?: string;
}

export interface HomeSurprise {
  seed: string;
  album: HomeCard | null;
  film: HomeCard | null;
}

/**
 * The answer of `home`. Whole when the page asks for everything; with one shelf
 * (or the surprise) asked for, only that and the three counters come back —
 * hence the optional parts.
 */
export interface HomeData {
  generated_at: string;
  /** False for a guest account: nothing is remembered for it. */
  can_dismiss: boolean;
  dismissed_count: number;
  libraries?: HomeLibrary[];
  hero?: HomeCard | null;
  shelves?: Record<string, HomeShelf>;
  surprise?: HomeSurprise;
}

/** One card offered behind the credits. */
export interface UpNextEntry {
  item: MediaItem;
  directory_id: number | null;
}

export interface UpNext {
  /** The following episode of a series; the only thing the player auto-plays. */
  next: UpNextEntry | null;
  suggestions: UpNextEntry[];
}

export type AccountEntrySort =
  | "newest"
  | "oldest"
  | "title_asc"
  | "own_rating_desc"
  | "average_rating_desc"
  | "own_plays_desc"
  | "all_plays_desc"
  | "random";

export interface AccountEntryPage {
  items: AccountEntry[];
  page: number;
  has_more: boolean;
}

export interface CollectionRules {
  query: string | null;
  favorite: "any" | "yes" | "no";
  rating_status: "all" | "rated" | "unrated";
  play_scope: "own" | "total" | "others" | "unplayed";
  date_scope: "any" | "own" | "total" | "others";
  played_from: string | null;
  played_to: string | null;
  rating_scope: "own" | "community" | "both";
  min_plays: number;
  max_plays: number;
  min_rating: number;
  min_user_rating: number;
  max_user_rating: number;
  max_rating: number;
  min_rating_count: number;
  max_rating_count: number;
  /**
   * Films: release year bounds (0 means "no bound", as everywhere else here)
   * and the genres a work may carry — any of them, not all of them.
   */
  min_year: number;
  max_year: number;
  genres: number[];
}
export type CollectionSort = "updated_desc" | "name_asc" | "name_desc" | "rating_desc" | "plays_desc" | "items_desc";

/**
 * Orders a playlist's contents can be read in (server: CatalogActions::COLLECTION_SORTS).
 *
 * These are item orders, not the folder orders of the library: "position" is the
 * order the owner arranged by hand and "random" needs a seed to stay stable
 * while paging.
 */
export type CollectionItemSort =
  | "position"
  | "title_asc"
  | "title_desc"
  | "own_rating_desc"
  | "rating_desc"
  | "plays_desc"
  | "added_desc"
  | "random";

export interface UserCollection {
  id: number;
  owner_id: number;
  owner_name: string;
  is_owned: boolean;
  name: string;
  description: string;
  media_kind: LibraryKind;
  is_smart: boolean;
  is_shared: boolean;
  rules: CollectionRules | null;
  /** How this list wants its playback queue drawn, for everyone who plays it. */
  queue_rating: CollectionQueueRating;
  queue_favorite: CollectionQueueFavorite;
  item_count: number;
  /**
   * Stars given to the list itself: what this viewer gave it, what everyone
   * gave it on average, and how many people gave one. Not the same fact as
   * `items_avg_rating`, which is the average of the tracks on it — a list of
   * well-rated songs is not yet a well-made list.
   */
  rating: number | null;
  avg_rating: number;
  rating_count: number;
  items_avg_rating: number;
  items_rating_count: number;
  total_play_count: number;
  /** An own cover was uploaded; otherwise the card borrows one from its tracks. */
  has_artwork: boolean;
  /** Changes with the stored image, so a replaced cover is not served from cache. */
  artwork_revision: string;
  preview_candidates: Array<{ id: number; kind: MediaKind }>;
  created_at: string;
  updated_at: string;
}

/** One playlist's stars after a vote; shaped like RatingSummary, minus favourites. */
export interface CollectionRatingSummary {
  user_rating: number | null;
  avg_rating: number;
  rating_count: number;
}

export interface CollectionPage {
  /** Cover candidates are a card concern, so the page itself does not carry them. */
  collection: Omit<
    UserCollection,
    "item_count" | "rating" | "avg_rating" | "rating_count" | "items_avg_rating" | "items_rating_count"
    | "total_play_count" | "created_at" | "updated_at" | "preview_candidates"
  >;
  items: MediaItem[];
  page: number;
  has_more: boolean;
  offset: number;
  /** Size of the whole playlist, not of the window that was loaded. */
  total: number;
  sort: CollectionItemSort;
}

export interface AccountData {
  profile: { id: number; username: string; is_own: boolean; is_public: boolean };
  summary: { ratings: number; favorites: number; plays: number; collections: number };
  recent: AccountEntry[];
  favorites: AccountEntry[];
  collections: UserCollection[];
}
export interface ProfileSuggestion { id: number; username: string; is_public: boolean }

export interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  role: UserRole;
  is_guest: number | boolean;
  is_active: number | boolean;
  permission_group_id: number | null;
  /** Null while the account still waits for its activation link. */
  email_verified_at: string | null;
  /** Set when an operator switched the account off; a disabled account is not pending. */
  disabled_at?: string | null;
  /** Two-factor sign-in switched on (panel only). */
  two_factor?: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AdminCatalogRow {
  slug: string;
  display_name: string;
  media_kind: string;
  /** Where the source is on the server's disk: shown, never edited from the panel. */
  filesystem_path?: string;
  items: number;
  audio: number;
  video: number;
  images: number;
  auxiliary: number;
}

interface AdminScanRow {
  id: number;
  slug: string;
  status: string;
  discovered_count: number;
  error_count: number;
  started_at: string;
  finished_at: string | null;
}

/** One line of the audit trail: who did what, to what, and when. */
export interface ActivityEntry {
  id: number;
  actor_id: number | null;
  /** Null once the account is gone — the entry stays, the name does not. */
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  page: number;
  has_more: boolean;
  total: number;
  actions: Array<{ value: string; count: number }>;
  /** How long entries are kept before they are pruned. */
  retention_days: number;
}

/**
 * One work the genre lookup could not settle by itself.
 *
 * A candidate carries its genres as well as its name, so confirming one is a
 * local write — the panel never has to go back to Filmweb to apply a choice.
 */
export interface TitleLookupCandidate {
  filmweb_id: number;
  entity: string;
  title: string;
  original_title: string;
  year: number | null;
  duration_minutes: number | null;
  /**
   * Filmweb's own genre numbers. Kept because the confirm action looks the
   * chosen candidate up by them, and deliberately NOT used for display: they
   * are not this catalogue's ids, and reading them as such mislabels every
   * genre. Use `genres` below, which the server has already resolved.
   */
  genre_ids: number[];
  genres?: Array<{ slug: string; name_pl: string; name_en: string }>;
  url: string;
  confidence: number;
}

export interface TitleLookupEntry {
  id: number;
  /** The file or folder this is about, as it appears on disk. */
  subject: string;
  /** Where it actually sits, so a person can find it without searching. */
  path: string;
  is_episode: boolean;
  query_title: string;
  query_year: number | null;
  status: "pending" | "matched" | "review" | "none" | "failed" | "skipped";
  external_url: string | null;
  matched_title: string | null;
  matched_year: number | null;
  confidence: number;
  /** How many files share this answer — one film, or a whole series. */
  item_count: number;
  reasons: string[];
  candidates: TitleLookupCandidate[];
  last_error: string | null;
  checked_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
}

/** One folder's worth of unsettled works, for deciding them in one go. */
export interface TitleLookupFolder {
  folder: string;
  works: number;
  files: number;
  /** A few real titles from inside, so the choice is made against something. */
  samples: string[];
}

/** One work inside a folder, with whatever year it already carries. */
export interface TitleLookupFolderWork {
  id: number;
  title: string;
  path: string;
  item_count: number;
  year: number | null;
}

export interface TitleLookupFolderPage {
  folders: TitleLookupFolder[];
  genres: Array<{ id: number; slug: string; name_pl: string; name_en: string }>;
}

export interface TitleLookupPage {
  entries: TitleLookupEntry[];
  page: number;
  limit: number;
  total: number;
  counts: Partial<Record<TitleLookupEntry["status"], number>>;
  genres: Array<{ id: number; slug: string; name_pl: string; name_en: string }>;
}

/** One line of an uploaded playlist or ratings file, once matched. */
interface ImportEntry {
  id: number;
  position: number;
  /** What the file said, kept verbatim so a decision is about a visible line. */
  label: string;
  media_item_id: number | null;
  matched_by: "fingerprint" | "item_id" | "file_name" | "manual" | null;
  state: "matched" | "ambiguous" | "missing" | "skipped";
  candidates: Array<{ id: number; title: string; artist: string; folder: string }>;
  rating: number | null;
  favorite: boolean;
}

export interface ImportStatus {
  id: number;
  kind: "playlist" | "ratings";
  media_kind: LibraryKind;
  source_name: string;
  collection_name: string | null;
  status: "review" | "applied" | "discarded";
  total_entries: number;
  counts: Record<"matched" | "ambiguous" | "missing" | "skipped", number>;
  entries: ImportEntry[];
  /** Present only on the response that created the import. */
  import_id?: number;
  truncated?: boolean;
  /** The review list stops at `entries_limit` entries (unresolved first); `counts` cover them all. */
  entries_truncated?: boolean;
  entries_limit?: number;
}

/** What the metadata worker still has to read, by job state. */
interface AdminMetadataQueue {
  queued: number;
  running: number;
  failed: number;
  done: number;
}

/** One file behind the "failed" counter of the metadata queue, with its last reason. */
export interface AdminMetadataFailure {
  media_item_id: number;
  root: string | null;
  path: string | null;
  media_kind: string | null;
  /** Gone from the catalogue since; nothing is left to read again. */
  missing: boolean;
  reason: string;
  /** Failed jobs for this file — a file is queued again whenever it changes. */
  failures: number;
  failed_at: string;
  /** A later reading of the same file went through; the counter still counts the old failure. */
  resolved: boolean;
}

export interface AdminData {
  groups: PermissionGroup[];
  users: AdminUser[];
  catalog: AdminCatalogRow[];
  scans: AdminScanRow[];
  metadata: AdminMetadataQueue;
  /** Up to 50 files, newest failure first; empty when nothing failed. */
  metadata_failures?: AdminMetadataFailure[];
  settings: AdminSettings;
  /** Who the step-up ladder asked, paused or blocked in the last day. */
  stepup?: StepUpSubject[];

}
export interface SubtitleCacheStatus {
  state: "idle" | "running" | "completed" | "failed" | "cancelled";
  finished: boolean;
  total_files: number;
  processed_files: number;
  generated_tracks: number;
  cached_tracks: number;
  /** Films the run did not have to touch: already done and unchanged. */
  skipped_files?: number;
  /** Of the generated tracks, how many were picture subtitles rendered to images. */
  picture_tracks?: number;
  errors: number;
  current_file: string;
  root?: string;
  mode?: string;
}
export type CompatibilityAudioProfile = "stereo_low" | "stereo_standard" | "stereo_high" | "surround_aac";
export type CompatibilityVideoProfile = "native_copy" | "h264_fallback";

/** Boolean rights of a permission group; the server (PermissionGroups::FLAGS) is authoritative. */
export interface RolePermissions {
  /** Downloading is four decisions, not one. A playlist counts as a folder. */
  can_download_file: boolean;
  can_download_selection: boolean;
  can_download_folder: boolean;
  can_download_library: boolean;
  can_rate: boolean;
  can_favorite: boolean;
  can_create_collections: boolean;
  can_browse_collections: boolean;
  can_browse_profiles: boolean;
  can_share: boolean;
  /** Which libraries the group may browse, play and download from. */
  can_access_music: boolean;
  can_access_movies: boolean;
  /** FFmpeg compatibility mode (transcoding) for video. */
  can_stream_compat: boolean;
  /** Editing tags and cover art of audio items. */
  can_edit_metadata: boolean;
}

/** Free-text group settings. */
interface GroupTexts {
  /** Comma-separated extensions a group may download; empty means anything. */
  download_extensions: string;
}

/** Numeric limits of a permission group; zero means unlimited unless noted. */
interface GroupLimits {
  max_concurrent_streams: number;
  /** Non-inline transfers allowed inside download_window_minutes. */
  download_limit: number;
  /** Rolling window (minutes) for download_limit; never zero. */
  download_window_minutes: number;
  /** Simultaneous downloads (files and archives) per account. */
  max_concurrent_downloads: number;
}

export interface AdminSettings {
  music_sort: LibrarySort;
  movies_sort: LibrarySort;
  account_page_size: number;
  compatibility_audio_profile: CompatibilityAudioProfile;
  compatibility_video_profile: CompatibilityVideoProfile;
  playback_threshold_percent: number;
  /**
   * How many seconds of a film the player loads ahead in compatibility mode (Media Source,
   * stream-buffer.ts); 0 leaves it to the browser, which keeps some 2–3 seconds of such a stream.
   */
  video_buffer_seconds: number;
  visualizer_order: string[];
  visualizer_enabled: string[];
  registration_enabled: boolean;
  registration_requires_activation: boolean;
  registration_default_role: UserRole;
  captcha_provider: CaptchaProvider;
  captcha_site_key: string;
  captcha_protect_login: boolean;
  captcha_protect_registration: boolean;
  /** The secret itself never leaves the server; this only reports that one is set. */
  captcha_secret_configured: boolean;
  /** "always", "after" N failures, or "never" — the sign-in form's challenge. */
  captcha_login_mode?: CaptchaLoginMode;
  captcha_login_after?: number;
  /** Panel only (admin overview): every keyed provider's public key and whether its secret is set. */
  captcha_site_keys?: Partial<Record<KeyedCaptchaProvider, string>>;
  captcha_secrets_configured?: Partial<Record<KeyedCaptchaProvider, boolean>>;
  /** Panel only: reCAPTCHA v3's minimum score (0–1). */
  captcha_v3_min_score?: number;
  /** Panel only: proof-of-work difficulty — the largest number the page may have to try. */
  captcha_pow_max_number?: number;
  /** Panel only: the step-up ladder (integrations/php/StepUpGuard.php). */
  stepup_enabled?: boolean;
  stepup_staff_exempt?: boolean;
  stepup_pass_minutes?: number;
  stepup_block_after?: number;
  stepup_block_minutes?: number;
  stepup_thresholds?: Partial<Record<StepUpContext, StepUpThreshold>>;
  /** Panel only: administrators without 2FA set it up at their next sign-in. */
  twofa_require_admins?: boolean;
  /** Global download quota inside download_rate_window_minutes; 0 disables it. */
  download_rate_limit: number;
  download_rate_window_minutes: number;
  /** Offer the player's collapse control on desktop too (phones always have it). */
  dock_collapse_desktop: boolean;
  /** Links that work without an account. Off until an operator turns them on. */
  guest_links_enabled: boolean;
  /**
   * Font Awesome Free (the default, in every build) or an installed Pro package.
   * Older servers do not send these, hence optional; see shared/icon-styles.ts.
   */
  icon_pack?: "free" | "pro";
  /** A Pro style id such as "classic-light"; read only when icon_pack is "pro". */
  icon_style?: string;
}

/** What the first step of signing in answered (shared/api.ts signIn). */
export interface SignInStep {
  success?: boolean;
  /** Present when a second step is needed: a code, or a setup the operator requires. */
  two_factor?: "code" | "setup";
  /** With "setup": the secret (base32) and its otpauth:// address, for the QR code. */
  secret?: string;
  otpauth_uri?: string;
}

export interface TwoFactorSetup {
  secret: string;
  otpauth_uri: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  /** Set up but not confirmed with a code yet (expires after a quarter of an hour). */
  pending: boolean;
  recovery_left: number;
  /** The operator requires it of administrators, and this account is one. */
  required?: boolean;
}

export type StepUpContext = "request" | "download" | "compat" | "guest_link" | "register" | "resend";

interface StepUpThreshold {
  soft: number;
  hard: number;
  /** Seconds. */
  window: number;
}

/** One account, client or device the ladder asked, paused or blocked lately (newest decision). */
export interface StepUpSubject {
  /** `u:<id>`, `c:<sha256>` (a client — never its address) or `d:<sha256>` (a device cookie). */
  subject: string;
  kind: "u" | "c" | "d";
  user_id: number | null;
  username: string | null;
  context: string;
  state: "blocked" | "paused" | "challenged" | "expired";
  seconds_left: number;
  hits: number;
  seconds_ago: number;
}

export type KeyedCaptchaProvider = "recaptcha" | "recaptcha_v3" | "hcaptcha" | "turnstile";
type CaptchaProvider = "none" | KeyedCaptchaProvider | "pow";
export type CaptchaLoginMode = "always" | "after" | "never";

export interface PermissionGroup extends RolePermissions, GroupLimits, GroupTexts {
  id: number;
  slug: string;
  name: string;
  description: string;
  /** The fallback groups for signed-in and guest accounts; cannot be deleted. */
  is_system: boolean;
  sort_order: number;
  members: number;
}

/** Rights that actually apply to the signed-in account, resolved from its group. */
export interface EffectivePermissions extends RolePermissions, GroupLimits, GroupTexts {
  group_slug: string;
  group_name: string;
}
