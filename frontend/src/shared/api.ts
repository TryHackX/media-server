import { apiBase, appUrl } from "./config";
import { t } from "./i18n";
import type { RepeatMode, ShuffleMode } from "./player-state";
import type {
  AccountData,
  AccountEntryPage,
  AccountEntrySort,
  ActiveSession,
  ActivityPage,
  SubtitleCacheStatus,
  AdminSettings,
  AdminData,
  ArchiveTransfer,
  CollectionItemSort,
  CollectionPage,
  CollectionQueueFavorite,
  CollectionQueueRating,
  CollectionRatingSummary,
  CollectionRules,
  CollectionSort,
  ContinueShelf,
  DigestFrequency,
  DigestSubscription,
  FileTransfer,
  GuestLink,
  GuestLinkRow,
  ImportStatus,
  LibraryFilterOptions,
  LibraryFilters,
  LibraryKind,
  LibraryPage,
  LibrarySort,
  PermissionGroup,
  PlaybackQueueDevice,
  QueuePage,
  QueueSourceState,
  ProfileSuggestion,
  RatingSummary,
  ServerStats,
  SessionResponse,
  TitleLookupFolderPage,
  TitleLookupFolderWork,
  TitleLookupPage,
  UpNext,
  UserCollection,
  UserPreferences,
  UserRole
} from "./types";

export class ApiError extends Error {
  public constructor(public readonly status: number, message?: string) {
    // The bridge writes its `message` in Polish, so it goes through the same
    // dictionary as everything else: the Polish text is the key, and an English
    // interface gets English for the sentences we have translated. A message the
    // dictionary does not know still shows, in Polish, rather than disappearing.
    super(
      message
        ? t(message)
        : status === 429
          ? t("Przekroczono limit pobierania dla Twojego konta. Spróbuj ponownie później.")
          : status === 403
            ? t("Ta operacja jest niedostępna dla Twojego konta.")
            : t("Błąd komunikacji z serwerem")
    );
  }
}

let csrfToken: string | null = null;

/**
 * The bridge answers client errors (403/404/422/429) with a short, operator-written
 * Polish `message` naming the limit or right that was hit; anything else is opaque.
 */
async function errorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message.trim() ? body.message.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send the browser back to sign-in once the session behind it is gone.
 *
 * A PHP session outlives nobody's lunch break, and when it ends every call from
 * a page that is already open answers 401. Until this existed the page simply
 * stopped responding: the shell was still mounted, so navigation reused it
 * without revalidating anything, each page's own fetches failed, the router
 * logged the rejection and swallowed it, and the menu looked broken until
 * somebody pressed F5. Now the first 401 says so and goes where it has to.
 *
 * Only 401. A 403 is "you may not do that", which is a real answer to a real
 * question and must not throw anybody out of the application.
 */
let redirectingToLogin = false;
function sessionExpired(): void {
  const login = appUrl("login/");
  if (redirectingToLogin || window.location.pathname === login) return;
  redirectingToLogin = true;
  // Come back to the page they were on once they are signed in again.
  const next = window.location.pathname + window.location.search;
  window.location.assign(`${login}?next=${encodeURIComponent(next)}`);
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    if (response.status === 401) sessionExpired();
    throw new ApiError(response.status, response.status < 500 ? await errorMessage(response) : undefined);
  }
  return (await response.json()) as T;
}

export async function getSession(): Promise<SessionResponse> {
  const session = await request<SessionResponse>(`${apiBase}?action=session`);
  csrfToken = session.csrf_token;
  return session;
}

export interface AuthState {
  authenticated: boolean;
  registration_enabled: boolean;
  requires_activation: boolean;
  captcha: { provider: string; site_key: string; login: boolean; register: boolean };
  csrf_token: string;
}

/**
 * Read the public sign-in state.
 *
 * This is the one endpoint that answers before an account exists in the
 * session, so it also supplies the CSRF token the sign-in and sign-up forms
 * post with.
 */
export async function getAuthState(): Promise<AuthState> {
  const state = await request<AuthState>(`${apiBase}?action=auth_state`);
  csrfToken = state.csrf_token;
  return state;
}

export async function signIn(username: string, password: string, captchaToken?: string): Promise<void> {
  const response = await post<{ csrf_token?: string }>("login", {
    username,
    password,
    captcha_token: captchaToken ?? ""
  });
  // Signing in rotates the session, so adopt the token issued with it.
  if (typeof response.csrf_token === "string") csrfToken = response.csrf_token;
}

export async function signUp(
  username: string,
  email: string,
  password: string,
  captchaToken?: string
): Promise<{ status: string; spooled: boolean }> {
  return post<{ status: string; spooled: boolean }>("register", {
    username,
    email,
    password,
    captcha_token: captchaToken ?? ""
  });
}

export async function activateAccount(token: string): Promise<{ username: string }> {
  return post<{ username: string }>("activate", { token });
}

export async function resendActivation(email: string): Promise<void> {
  await post<{ success: boolean }>("resend_activation", { email });
}

export async function browseLibrary(
  kind: LibraryKind,
  directoryId: number | null,
  queryText = "",
  page = 1,
  limit = 48,
  sort: LibrarySort = "title_asc",
  randomSeed = "",
  filters: LibraryFilters = {}
): Promise<LibraryPage> {
  const query = new URLSearchParams({
    action: "browse",
    kind,
    page: String(page),
    limit: String(limit),
    sort
  });
  for (const [name, value] of Object.entries(filters)) {
    if (value) query.set(name, value);
  }
  // The seed keeps a random folder order stable while paging; a new seed reshuffles.
  if (sort === "random") {
    query.set("random_seed", randomSeed);
  }
  if (directoryId !== null) {
    query.set("directory_id", String(directoryId));
  }
  if (queryText.trim()) {
    query.set("query", queryText.trim());
  }
  const response = await request<{ library: LibraryPage }>(`${apiBase}?${query}`);
  return response.library;
}

export async function getQueuePage(
  directoryId: number,
  cursor = 0,
  limit = 160,
  direction: "before" | "after" = "after",
  queryText = "",
  options: { shuffleMode?: ShuffleMode; shuffleSeed?: string; offset?: number } = {}
): Promise<QueuePage> {
  const shuffleMode = options.shuffleMode ?? "off";
  const query = new URLSearchParams({
    action: "queue",
    kind: "music",
    directory_id: String(directoryId),
    after: String(cursor),
    limit: String(limit),
    direction,
    shuffle_mode: shuffleMode,
    shuffle_seed: shuffleMode === "off" ? "" : (options.shuffleSeed ?? ""),
    offset: String(options.offset ?? 0)
  });
  if (queryText.trim()) query.set("query", queryText.trim());
  const response = await request<{ queue: QueuePage }>(apiBase + "?" + query);
  return response.queue;
}

/**
 * What follows a film that has just reached its end.
 *
 * `next` is only ever the following episode of a series — the one the player may
 * roll into on its own. Everything else is a suggestion the viewer picks.
 */
export async function getUpNext(mediaItemId: number, limit = 8): Promise<UpNext> {
  const query = new URLSearchParams({ action: "up_next", media_item_id: String(mediaItemId), limit: String(limit) });
  const response = await request<{ up_next: UpNext }>(`${apiBase}?${query}`);
  return response.up_next;
}

/** Which picture filters this library can offer, counted from the catalogue. */
export async function getLibraryFilters(kind: LibraryKind): Promise<LibraryFilterOptions> {
  const query = new URLSearchParams({ action: "library_filters", kind });
  const response = await request<{ filters: LibraryFilterOptions }>(`${apiBase}?${query}`);
  return response.filters;
}

export function previewUrl(mediaItemId: number): string {
  const query = new URLSearchParams({ action: "preview", media_item_id: String(mediaItemId) });
  return `${apiBase}?${query}`;
}

/**
 * `keepalive` lets a request outlive the page that started it — the browser
 * finishes it after the tab is gone. Used for the last queue save on `pagehide`,
 * which is the one save that matters most and the one a normal fetch drops.
 */
async function post<T>(action: string, payload: unknown, options: { keepalive?: boolean } = {}): Promise<T> {
  if (!csrfToken) {
    await getSession();
  }
  return request<T>(`${apiBase}?action=${encodeURIComponent(action)}`, {
    method: "POST",
    ...(options.keepalive ? { keepalive: true } : {}),
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken ?? ""
    },
    body: JSON.stringify(payload)
  });
}

export async function createFileTransfer(mediaItemId: number, inline: boolean): Promise<FileTransfer> {
  const response = await post<{ transfer: FileTransfer }>("file", {
    media_item_id: mediaItemId,
    inline
  });
  return response.transfer;
}

export async function createStereoTransfer(mediaItemId: number): Promise<FileTransfer> {
  const response = await post<{ transfer: FileTransfer }>("stereo", {
    media_item_id: mediaItemId
  });
  return response.transfer;
}

export async function createArchiveTransfer(
  mediaItemIds: number[],
  downloadName: string
): Promise<ArchiveTransfer> {
  const response = await post<{ transfer: ArchiveTransfer }>("archive", {
    media_item_ids: mediaItemIds,
    download_name: downloadName
  });
  return response.transfer;
}

export async function createSearchArchive(
  kind: LibraryKind,
  directoryId: number,
  query: string,
  downloadName: string
): Promise<ArchiveTransfer> {
  const response = await post<{ transfer: ArchiveTransfer }>("search_archive", {
    kind, directory_id: directoryId, query, download_name: downloadName
  });
  return response.transfer;
}

export async function createDirectoryArchive(
  kind: LibraryKind,
  directoryId: number,
  downloadName: string
): Promise<ArchiveTransfer> {
  const response = await post<{ transfer: ArchiveTransfer }>("directory_archive", {
    kind,
    directory_id: directoryId,
    download_name: downloadName
  });
  return response.transfer;
}

export async function updateRating(
  mediaItemId: number,
  changes: { rating?: number | null; favorite?: boolean }
): Promise<RatingSummary> {
  const response = await post<{ rating: RatingSummary }>("rating", {
    media_item_id: mediaItemId,
    ...changes
  });
  return response.rating;
}

/**
 * Stars for the playlist itself — the choosing, not the songs.
 *
 * Passing null clears the vote, the way clicking the same star twice does for
 * a track. What comes back is the list as it stands afterwards, so the card can
 * redraw from the answer instead of guessing at the new average.
 */
export async function rateCollection(
  collectionId: number,
  rating: number | null
): Promise<CollectionRatingSummary> {
  const response = await post<{ rating: CollectionRatingSummary }>("collection_rating", {
    collection_id: collectionId,
    rating
  });
  return response.rating;
}

/**
 * Hand one folder or one playlist to somebody without an account.
 *
 * The token comes back exactly once — it is stored only as a hash, so a link
 * that is not copied now cannot be recovered later, only reissued.
 */
export async function createGuestLink(request: {
  target_kind: "directory" | "collection";
  target_id: number;
  days: number;
  max_downloads: number;
}): Promise<GuestLink> {
  const response = await post<{ link: GuestLink }>("guest_link_create", request);
  return response.link;
}

export async function getGuestLinks(): Promise<GuestLinkRow[]> {
  const response = await request<{ links: GuestLinkRow[] }>(apiBase + "?action=guest_links");
  return response.links;
}

export async function revokeGuestLink(linkId: number): Promise<void> {
  await post<{ success: true }>("guest_link_revoke", { link_id: linkId });
}

/**
 * The weekly "what is new in the library" subscription.
 *
 * Reading it is how the account page and the panel find out whether anybody
 * asked for the digest; an administrator also gets the server-wide `server`
 * half (how many subscribers, when a run last went out).
 */
export async function getDigest(): Promise<DigestSubscription> {
  const response = await request<{ digest: DigestSubscription }>(apiBase + "?action=digest");
  return response.digest;
}

export async function setDigestFrequency(frequency: DigestFrequency): Promise<DigestSubscription> {
  const response = await post<{ success: true; digest: DigestSubscription }>("digest_subscribe", { frequency });
  return response.digest;
}

/** Run the digest now (administrators): ignores the weekly wait, not the choice. */
export async function sendDigestNow(): Promise<{ sent: number; skipped: number; empty: number; spooled: boolean }> {
  return post<{ sent: number; skipped: number; empty: number; spooled: boolean }>("digest_send", {});
}

/**
 * Sessions that are open right now.
 *
 * An administrator may name an account; anybody else gets their own, whatever
 * they ask for. "Open" is decided by the server from the session lifetime, so a
 * browser closed last week is not listed as if it could still be signed out.
 */
export async function getActiveSessions(userId?: number): Promise<ActiveSession[]> {
  const query = new URLSearchParams({ action: "sessions" });
  if (userId) query.set("user_id", String(userId));
  const response = await request<{ sessions: ActiveSession[] }>(apiBase + "?" + query);
  return response.sessions;
}

/**
 * Close one session, or every session of an account except this browser.
 *
 * It takes effect on the closed session's next request to the server — there is
 * no way to reach into another browser and end it sooner.
 */
export async function revokeSession(
  target: { fingerprint: string } | { others: true; userId?: number }
): Promise<number> {
  const response = await post<{ success: true; closed: number }>("session_revoke",
    "fingerprint" in target
      ? { fingerprint: target.fingerprint }
      : { others: true, ...(target.userId ? { user_id: target.userId } : {}) });
  return response.closed;
}

/** Every device of this account and what it has in its player. */
export async function getPlaybackQueues(deviceId: string): Promise<PlaybackQueueDevice[]> {
  const query = new URLSearchParams({ action: "playback_queues", device_id: deviceId });
  const response = await request<{ devices: PlaybackQueueDevice[] }>(apiBase + "?" + query);
  return response.devices;
}

/**
 * Tell the server what this device is playing.
 *
 * The answer names the device that took this queue over, when one did — that is
 * how a handover reaches a player that has no socket to listen on: it finds out
 * from the save it was making anyway.
 */
export async function savePlaybackQueue(
  state: {
    device_id: string;
    device_label: string;
    source: QueueSourceState | null;
    offset: number;
    total: number;
    media_item_id: number | null;
    position_ms: number;
    is_playing: boolean;
    repeat: RepeatMode;
    context: string;
  },
  options: { keepalive?: boolean } = {}
): Promise<{ success: true; yielded_to: string | null }> {
  return post<{ success: true; yielded_to: string | null }>("playback_queue_save", state, options);
}

/** Take another device's queue over; the state comes back as it was claimed. */
export async function claimPlaybackQueue(
  deviceId: string,
  deviceLabel: string,
  fromDeviceId: string
): Promise<PlaybackQueueDevice> {
  const response = await post<{ queue: PlaybackQueueDevice }>("playback_queue_claim", {
    device_id: deviceId,
    device_label: deviceLabel,
    from_device_id: fromDeviceId
  });
  return response.queue;
}

export async function recordPlayback(
  mediaItemId: number,
  event: "start" | "progress" | "complete",
  positionMs = 0
): Promise<void> {
  await post<{ success: true }>("playback", {
    media_item_id: mediaItemId,
    event,
    position_ms: Math.max(0, Math.round(positionMs))
  });
}

export async function saveMetadata(
  mediaItemId: number,
  metadata: { title: string; artist: string; album: string; year: string; genre: string }
): Promise<void> {
  await post<{ success: true }>("metadata", { media_item_id: mediaItemId, ...metadata });
}

export async function getAccount(username?: string): Promise<AccountData> {
  const query = new URLSearchParams({ action: "account" });
  if (username) query.set("username", username);
  const response = await request<{ account: AccountData }>(`${apiBase}?${query}`);
  return response.account;
}

export async function searchProfiles(queryText: string): Promise<ProfileSuggestion[]> {
  const query = new URLSearchParams({ action: "profile_search", query: queryText });
  const response = await request<{ profiles: ProfileSuggestion[] }>(`${apiBase}?${query}`);
  return response.profiles;
}

export async function setProfileVisibility(isPublic: boolean): Promise<{ success: true; is_public: boolean }> {
  return post<{ success: true; is_public: boolean }>("profile_visibility", { is_public: isPublic });
}

/** Interface choices stored with the account, so they follow the listener across devices. */
export async function saveUserPreferences(preferences: UserPreferences): Promise<UserPreferences> {
  const response = await post<{ success: true; preferences: UserPreferences }>("account_preferences", { preferences });
  return response.preferences;
}

export async function getAccountEntries(
  section: "recent" | "favorites" | "rated",
  kind: "all" | LibraryKind,
  sort: AccountEntrySort,
  page = 1,
  limit = 20,
  username?: string,
  randomSeed = ""
): Promise<AccountEntryPage> {
  const query = new URLSearchParams({
    action: "account_entries",
    section,
    kind,
    sort,
    page: String(page),
    limit: String(limit)
  });
  if (username) query.set("username", username);
  if (sort === "random") query.set("random_seed", randomSeed);
  const response = await request<{ entries: AccountEntryPage }>(`${apiBase}?${query}`);
  return response.entries;
}

/**
 * The start page's shelf: unfinished music, unfinished films, and what follows
 * what was finished. One request, because the page shows all three at once.
 */
export async function getContinueShelf(limit = 12): Promise<ContinueShelf> {
  const query = new URLSearchParams({ action: "continue", limit: String(limit) });
  const response = await request<{ continue: ContinueShelf }>(`${apiBase}?${query}`);
  return response.continue;
}

/** Take a title off the shelf (or put it back) without touching its play history. */
export async function dismissContinue(mediaItemId: number, hidden = true): Promise<void> {
  await post<{ success: true; hidden: boolean }>("continue_dismiss", {
    media_item_id: mediaItemId,
    hidden
  });
}

export async function getCollections(
  kind?: LibraryKind,
  options: { owner?: "mine" | "others" | "all"; visibility?: "private" | "public" | "all"; sort?: CollectionSort } = {}
): Promise<UserCollection[]> {
  const query = new URLSearchParams({ action: "collections" });
  if (kind) query.set("kind", kind);
  query.set("owner", options.owner ?? "mine");
  query.set("visibility", options.visibility ?? "all");
  query.set("sort", options.sort ?? "updated_desc");
  const response = await request<{ collections: UserCollection[] }>(apiBase + "?" + query);
  return response.collections;
}

/**
 * One page of a playlist.
 *
 * `sort` orders the whole playlist server-side; "random" carries a seed so the
 * order survives paging. The player pages a shuffled queue by absolute `offset`,
 * which then wins over `page`.
 */
export async function getCollection(
  collectionId: number,
  page = 1,
  limit = 100,
  options: { sort?: CollectionItemSort; shuffleSeed?: string; offset?: number } = {}
): Promise<CollectionPage> {
  const sort = options.sort ?? (options.shuffleSeed ? "random" : "position");
  const query = new URLSearchParams({
    action: "collection",
    collection_id: String(collectionId),
    page: String(page),
    limit: String(limit),
    sort,
    shuffle_seed: sort === "random" ? (options.shuffleSeed ?? "") : "",
    offset: String(options.offset ?? 0)
  });
  const response = await request<{ collection: CollectionPage }>(apiBase + "?" + query);
  return response.collection;
}

/** The playlist's own cover; 404 when it has none, which the card treats as "try the next". */
export function collectionPreviewUrl(collectionId: number, revision = ""): string {
  const query = new URLSearchParams({ action: "collection_preview", collection_id: String(collectionId) });
  if (revision) query.set("revision", revision);
  return `${apiBase}?${query}`;
}

/** Passing null removes the own cover and restores the one drawn from the tracks. */
export async function saveCollectionArtwork(collectionId: number, dataUrl: string | null): Promise<void> {
  await post<{ success: true }>("collection_artwork", { collection_id: collectionId, data_url: dataUrl });
}

export async function createCollectionArchive(
  collectionId: number,
  downloadName: string
): Promise<ArchiveTransfer> {
  const response = await post<{ transfer: ArchiveTransfer }>("collection_archive", {
    collection_id: collectionId,
    download_name: downloadName
  });
  return response.transfer;
}

export async function createCollection(payload: {
  name: string;
  description?: string;
  media_kind: LibraryKind;
  rules: CollectionRules | null;
  queue_rating?: CollectionQueueRating;
  queue_favorite?: CollectionQueueFavorite;
}): Promise<number> {
  const response = await post<{ success: true; id: number }>("collection_create", payload);
  return response.id;
}

export async function updateCollection(
  collectionId: number,
  changes: {
    name?: string;
    description?: string;
    queue_rating?: CollectionQueueRating;
    queue_favorite?: CollectionQueueFavorite;
  }
): Promise<void> {
  await post<{ success: true }>("collection_update", { collection_id: collectionId, ...changes });
}

/** Swap one item with its neighbour — O(1) server-side, no full-list rewrite. */
export async function moveCollectionItem(
  collectionId: number,
  mediaItemId: number,
  direction: "up" | "down"
): Promise<void> {
  await post<{ success: true }>("collection_move", {
    collection_id: collectionId,
    media_item_id: mediaItemId,
    direction
  });
}

export async function deleteCollection(collectionId: number): Promise<void> {
  await post<{ success: true }>("collection_delete", { collection_id: collectionId });
}

export async function setCollectionItem(collectionId: number, mediaItemId: number, included = true): Promise<void> {
  await post<{ success: true }>("collection_item", {
    collection_id: collectionId, media_item_id: mediaItemId, included
  });
}
export async function setCollectionShared(collectionId: number, shared: boolean): Promise<void> {
  await post<{ success: true }>("collection_share", { collection_id: collectionId, shared });
}

export async function saveArtwork(mediaItemId: number, dataUrl: string | null): Promise<void> {
  await post<{ success: true }>("artwork", { media_item_id: mediaItemId, data_url: dataUrl });
}

/** One page of the audit trail, newest first. */
export async function getActivity(
  options: { event?: string; actor?: number | null; page?: number; limit?: number } = {}
): Promise<ActivityPage> {
  const query = new URLSearchParams({
    action: "admin_activity",
    page: String(options.page ?? 1),
    limit: String(options.limit ?? 25)
  });
  if (options.event) query.set("event", options.event);
  if (options.actor) query.set("actor", String(options.actor));
  const response = await request<{ activity: ActivityPage }>(`${apiBase}?${query}`);
  return response.activity;
}

/**
 * Addresses of the two export downloads.
 *
 * Plain links rather than fetch-and-save: the browser writes the file itself,
 * so nothing has to hold a whole playlist in memory to hand it over, and the
 * response is a normal attachment with a name on it.
 *
 * Both files carry item identifiers rather than paths — they restore into this
 * server exactly and tell nobody how the library is arranged on disk. The cost
 * is that no other player will open them.
 */
export function collectionExportUrl(collectionId: number, format: "m3u" | "xspf"): string {
  return `${apiBase}?action=collection_export&collection_id=${collectionId}&format=${format}`;
}

export function ratingsExportUrl(format: "csv" | "json" = "csv"): string {
  return `${apiBase}?action=ratings_export&format=${format}`;
}

/**
 * Hand an uploaded playlist or ratings file to the server.
 *
 * The document travels base64-encoded inside the usual JSON body rather than as
 * a multipart upload: the bridge speaks JSON on every other route, and one
 * request shape is one thing to guard instead of two.
 */
export async function startImport(
  file: File,
  mediaKind: LibraryKind
): Promise<ImportStatus> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunked, because spreading a two-megabyte array into String.fromCharCode
  // overflows the argument list.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const response = await post<{ import: ImportStatus }>("import_start", {
    content: btoa(binary),
    source_name: file.name,
    media_kind: mediaKind
  });
  return response.import;
}

export async function resolveImportEntry(
  entryId: number,
  decision: "choose" | "skip",
  mediaItemId?: number
): Promise<{ success: boolean; state: string }> {
  return post<{ success: boolean; state: string }>("import_resolve", {
    entry_id: entryId,
    decision,
    ...(mediaItemId === undefined ? {} : { media_item_id: mediaItemId })
  });
}

export async function applyImport(
  importId: number,
  name?: string
): Promise<{ success: boolean; kind: string; collection_id?: number; written: number }> {
  return post("import_apply", { import_id: importId, ...(name ? { name } : {}) });
}

export async function discardImport(importId: number): Promise<{ success: boolean }> {
  return post("import_discard", { import_id: importId });
}

/**
 * The same queue read as folders instead of as works.
 *
 * A cartoon anthology is five hundred separate works and one decision; this is
 * what turns that into one click.
 */
export async function getTitleFolders(status = "review"): Promise<TitleLookupFolderPage> {
  const response = await request<{ folders: TitleLookupFolderPage }>(
    `${apiBase}?action=admin_title_folders&status=${encodeURIComponent(status)}`
  );
  return response.folders;
}

/** The individual works inside a folder, so a year can be typed per episode. */
export async function getTitleFolderWorks(
  folder: string,
  status = "review"
): Promise<{ folder: string; works: TitleLookupFolderWork[] }> {
  const query = new URLSearchParams({
    action: "admin_title_folder_works",
    folder,
    status
  });
  const response = await request<{ works: { folder: string; works: TitleLookupFolderWork[] } }>(
    `${apiBase}?${query}`
  );
  return response.works;
}

export async function decideTitleFolder(payload: {
  folder: string;
  status?: string;
  genres?: number[];
  year?: number | null;
  /** Years typed against individual works, keyed by lookup id. */
  years?: Record<number, number>;
}): Promise<{ success: boolean; works: number; files: number }> {
  return post("admin_title_folder_decide", payload);
}

export async function getTitleLookups(
  options: { status?: string; page?: number; limit?: number } = {}
): Promise<TitleLookupPage> {
  const query = new URLSearchParams({
    action: "admin_title_lookups",
    status: options.status ?? "review",
    page: String(options.page ?? 1),
    limit: String(options.limit ?? 25)
  });
  const response = await request<{ lookups: TitleLookupPage }>(`${apiBase}?${query}`);
  return response.lookups;
}

/**
 * Settle one uncertain lookup.
 *
 * "confirm" takes one of the candidates the matcher weighed, "manual" sets the
 * genres and year by hand, and "skip" says this work has no external genre —
 * all three write 'manual' as the source, which is what stops a later run from
 * quietly undoing the decision.
 */
export async function decideTitleLookup(payload: {
  id: number;
  decision: "confirm" | "skip" | "manual";
  filmweb_id?: number;
  genres?: number[];
  year?: number | null;
}): Promise<{ success: boolean; status: string }> {
  // Through post(), not request(): post() is what carries the CSRF header, and
  // a write that goes without it is refused with a 403.
  return post<{ success: boolean; status: string }>("admin_title_lookup_decide", payload);
}

export async function getAdmin(): Promise<AdminData> {
  const response = await request<{ admin: AdminData }>(`${apiBase}?action=admin`);
  return response.admin;
}

export async function savePermissionGroup(group: Partial<PermissionGroup>): Promise<PermissionGroup[]> {
  const response = await post<{ groups: PermissionGroup[] }>("admin_group_save", group);
  return response.groups;
}

export async function deletePermissionGroup(id: number, replacementId: number | null): Promise<PermissionGroup[]> {
  const response = await post<{ groups: PermissionGroup[] }>("admin_group_delete", {
    id,
    replacement_id: replacementId
  });
  return response.groups;
}

/** Returns the settings as stored, so callers adopt what the server decided. */
export async function saveAdminSettings(settings: AdminSettings): Promise<AdminSettings> {
  const response = await post<{ success: true; settings: AdminSettings }>("admin_settings", settings);
  return response.settings;
}

export async function startCatalogScan(root: string, kind: string): Promise<void> {
  await post<{ scan: { status: string; root: string } }>("admin_scan", { root, kind });
}

/** Read one batch of the metadata queue; the panel repeats the call while it shrinks. */
export async function startMetadataWorker(limit = 200): Promise<{ status: string }> {
  const response = await post<{ metadata: { status: string } }>("admin_metadata", { limit });
  return response.metadata;
}

/** Look up genre and release year for the next batch of films and series. */
export async function startTitleWorker(limit = 50, root = "movies"): Promise<{ status: string }> {
  const response = await post<{ title_worker: { status: string } }>("admin_title_worker", { limit, root });
  return response.title_worker;
}

/**
 * What the server did over the last `hours`, one sample a minute.
 *
 * The series comes from the transfer service's own diary — it is the only
 * process that both knows these numbers and runs all the time.
 */
export async function serverStats(hours: number): Promise<ServerStats> {
  const response = await post<{ stats: ServerStats }>("admin_stats", { hours });
  return response.stats;
}

export async function subtitleCacheStatus(): Promise<SubtitleCacheStatus> {
  const response = await post<{ subtitles: SubtitleCacheStatus }>("admin_subtitles", { operation: "status" });
  return response.subtitles;
}

export async function startSubtitleCache(payload: {
  root: string;
  mode: "missing" | "refresh";
  media_item_ids: number[];
}): Promise<SubtitleCacheStatus> {
  const response = await post<{ subtitles: SubtitleCacheStatus }>("admin_subtitles", { operation: "start", ...payload });
  return response.subtitles;
}

/**
 * The permission group is the single source of truth for an account's rights;
 * the "guest" nature of an account is simply membership of the system guest group.
 */
export async function createUser(payload: {
  username: string;
  password: string;
  password_confirm: string;
  role: UserRole;
  permission_group_id: number;
}): Promise<number> {
  const response = await post<{ success: true; id: number }>("admin_user_create", payload);
  return response.id;
}

export async function updateUser(payload: {
  user_id: number;
  role: UserRole;
  is_active: boolean;
  permission_group_id: number;
  password?: string;
  password_confirm?: string;
}): Promise<void> {
  await post<{ success: true }>("admin_user_update", payload);
}

export async function activateUser(userId: number): Promise<void> {
  await post<{ success: true }>("admin_user_activate", { user_id: userId });
}

export async function resendUserActivation(userId: number): Promise<{ spooled: boolean }> {
  return post<{ success: true; spooled: boolean }>("admin_user_resend_activation", { user_id: userId });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  newPasswordConfirm: string
): Promise<void> {
  await post<{ success: true }>("account_password", {
    current_password: currentPassword,
    new_password: newPassword,
    new_password_confirm: newPasswordConfirm
  });
}

/** Success only means the request was accepted; the address changes after the mailed link is opened. */
export async function requestEmailChange(
  email: string,
  currentPassword: string
): Promise<{ spooled: boolean }> {
  return post<{ success: true; spooled: boolean }>("account_email_request", {
    email,
    current_password: currentPassword
  });
}

export async function confirmEmailChange(token: string): Promise<{ username: string }> {
  return post<{ success: true; username: string }>("email_change_confirm", { token });
}

export async function logout(): Promise<void> {
  await post<{ success: true }>("logout", {});
  csrfToken = null;
}