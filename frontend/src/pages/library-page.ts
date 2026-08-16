import {
  ApiError,
  browseLibrary,
  collectionPreviewUrl,
  collectionExportUrl,
  createArchiveTransfer,
  createCollection,
  createCollectionArchive,
  createDirectoryArchive,
  createFileTransfer,
  createSearchArchive,
  getCollection,
  getCollections,
  getLibraryFilters,
  getQueuePage,
  moveCollectionItem as moveCollectionItemApi,
  previewUrl,
  rateCollection,
  saveCollectionArtwork,
  setCollectionItem,
  setCollectionShared,
  updateRating
} from "../shared/api";
import { copyShareLink } from "../shared/clipboard";
import { openGuestLinkDialog } from "../shared/guest-links";
import { appUrl } from "../shared/config";
import { CoverPicker } from "../shared/cover-picker";
import { el } from "../shared/dom";
import { formatBytes, formatDuration } from "../shared/format";
import { icon, type IconName } from "../shared/icons";
import { t } from "../shared/i18n";
import { MediaViewer } from "../shared/media-viewer";
import { supportsThumbnail } from "../shared/library-state";
import { openModal } from "../shared/modal";
import { can, canAccessLibrary, canEditMetadata } from "../shared/permissions";
import { ratingPicker, starVisual } from "../shared/rating";
import { mountShell, openMetadataEditor } from "../shared/shell";
import type { ArchiveTransfer, CollectionItemSort, CollectionPage, CollectionQueueFavorite, CollectionQueueRating, LibraryDirectory, LibraryFilters, LibraryKind, LibraryPage, LibrarySort, MediaItem, MediaKind, UserCollection } from "../shared/types";

export interface PageOptions {
  kind: LibraryKind;
  title: string;
  eyebrow: string;
  archiveName: string;
}

/** Download failures worth naming precisely: quota (429) and group rights (403). */
function downloadFailureText(error: unknown, fallback: string): string {
  return error instanceof ApiError && (error.status === 429 || error.status === 403) ? error.message : fallback;
}

function submitArchive(transfer: ArchiveTransfer): void {
  const form = el("form", { attrs: { method: "post", action: transfer.url, target: "_blank" } });
  form.append(el("input", { attrs: { type: "hidden", name: "token", value: transfer.form.token } }));
  document.body.append(form);
  form.submit();
  form.remove();
}

const LIBRARY_SORTS: LibrarySort[] =
  ["title_asc", "title_desc", "plays_desc", "rating_desc", "rating_count_desc", "size_desc", "duration_desc", "duration_asc", "random"];

/**
 * A function, not a constant: a module-level table would resolve its labels when
 * the bundle loads, which is before the shell has taken the account's language,
 * and the picture filter would then stay Polish whatever the account chose. The
 * same trap the audit-event and permission tables fell into.
 */
function resolutionLabels(): Array<[NonNullable<LibraryFilters["resolution"]>, string]> {
  return [
    ["uhd", t("4K i wyżej")],
    ["fhd", t("1080p i wyżej")],
    ["hd", t("720p i wyżej")]
  ];
}

/**
 * Orders offered inside a playlist.
 *
 * A playlist holds tracks, not folders, so the library's folder shuffle and
 * "largest first" are not offered here; the manual order is, but only on a list
 * the owner arranged by hand.
 */
const COLLECTION_SORTS: CollectionItemSort[] =
  ["position", "title_asc", "title_desc", "own_rating_desc", "rating_desc", "plays_desc", "added_desc", "random"];

/** Seed for the random folder order: stable while paging, replaced by "shuffle again". */
function freshRandomSeed(): string {
  return window.crypto.randomUUID().replaceAll("-", "");
}

/**
 * Everything building a playlist's queue needs, gathered in one value.
 *
 * Written out rather than read off the page state, because the queue can now be
 * built for a playlist that is not open: pressing "play" on a card starts the
 * list without walking into it, and at that moment the page is still showing a
 * folder. The display rules travel along for the same reason — they belong to
 * the list, and the dock has to keep obeying them after the page has moved on.
 */
interface CollectionQueueContext {
  id: number;
  name: string;
  ownerName: string;
  queueRating: CollectionQueueRating;
  queueFavorite: CollectionQueueFavorite;
  sort: CollectionItemSort;
  seed: string;
  items: MediaItem[];
  offset: number;
  total: number;
  hasMore: boolean;
  /** The page a sequential loader should ask for next; page 1 is already here. */
  nextPage: number;
}

/** Identifies a prepared queue: the order is part of it, so a re-sort rebuilds. */
function collectionQueueKey(id: number, sort: CollectionItemSort, seed: string): string {
  return "collection:" + id + "|" + sort + (sort === "random" ? ":" + seed : "");
}


/**
 * How a film's picture is worth naming on a card.
 *
 * The catalogue stores the exact height, but a viewer thinks in labels, and a
 * 2,35:1 film is 1920x800 rather than 1920x1080 — so the width decides the class
 * and the height only breaks ties.
 */
function resolutionLabel(item: MediaItem): string | null {
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

function itemIcon(item: MediaItem): IconName {
  if (item.media_kind === "audio") return "music";
  if (item.media_kind === "video") return "film";
  if (item.media_kind === "image") return "image";
  if (item.file_extension === "torrent") return "magnet";
  if (["zip", "rar", "7z"].includes(item.file_extension ?? "")) return "archive";
  return "file";
}

export async function mountLibraryPage(options: PageOptions): Promise<void> {
  const active = options.kind === "music" ? "music" : "movies";
  const shell = await mountShell(active, options.title, options.eyebrow);
  if (!canAccessLibrary(shell.session, options.kind)) {
    shell.content.append(el("div", { className: "notice notice--error", text: t("Ta biblioteka jest niedostępna dla Twojej grupy uprawnień.") }));
    return;
  }
  // Four separate rights: one file, a ticked set, a whole folder (a playlist
  // counts as one) and the library root as a single archive.
  const canDownloadFile = can(shell.session, "can_download_file");
  const canDownloadSelection = can(shell.session, "can_download_selection");
  const canDownloadFolder = can(shell.session, "can_download_folder");
  const canDownloadLibrary = can(shell.session, "can_download_library");
  const canRate = can(shell.session, "can_rate");
  const canFavorite = can(shell.session, "can_favorite");
  const canCreateCollections = can(shell.session, "can_create_collections");
  const canShare = can(shell.session, "can_share");
  // A server-wide switch, off by default: with it off the folder card
  // shows three actions, which is also what its footer was drawn for.
  const guestLinksOn = shell.session.settings.guest_links_enabled === true;
  const canEditTags = canEditMetadata(shell.session);
  const player = shell.player;
  const viewer = new MediaViewer(shell.session, () => player.pause());
  let previewObserver: IntersectionObserver | null = null;
  let windowObserver: IntersectionObserver | null = null;
  let slideshowTimer = 0;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    previewObserver?.disconnect();
    windowObserver?.disconnect();
    window.clearInterval(slideshowTimer);
    void viewer.destroy();
  };
  document.addEventListener("media:route-will-change", dispose, { once: true });
  const selected = new Set<number>();
  const route = new URLSearchParams(window.location.search);
  const requestedCollection = Number(route.get("collection"));
  let collectionId = Number.isSafeInteger(requestedCollection) && requestedCollection > 0 ? requestedCollection : null;
  const initialQuery = collectionId === null ? (route.get("q") ?? "").trim().slice(0, 200) : "";
  const requestedDirectory = Number(route.get("directory"));
  const initialDirectoryId = Number.isSafeInteger(requestedDirectory) && requestedDirectory > 0 ? requestedDirectory : null;
  const sharedPlayId = Number(route.get("play"));
  let consumedSharedPlay = false;
  let availableCollections: UserCollection[] = [];
  if (canCreateCollections || can(shell.session, "can_browse_collections")) {
    availableCollections = await getCollections(options.kind).catch(() => []);
  }
  let collectionTarget: MediaItem | null = null;
  const collectionSearch = el("input", {
    className: "input", attrs: { type: "search", placeholder: t("Szukaj playlisty…"), "aria-label": t("Szukaj playlisty") }
  });
  const collectionSelect = el("select", { className: "input", attrs: { "aria-label": t("Wybierz kolekcję") } });
  const collectionFeedback = el("span", { className: "form-status", attrs: { role: "status" } });
  const collectionClose = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
  const collectionConfirm = el(
    "button",
    { className: "button button--primary", attrs: { type: "button" } },
    icon("check"),
    t("Dodaj")
  );
  const collectionCreateName = el("input", {
    className: "input", attrs: { type: "text", minlength: "2", maxlength: "191", placeholder: t("Nazwa nowej playlisty"), "aria-label": t("Nazwa nowej playlisty") }
  });
  const collectionCreate = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("check"),
    t("Utwórz")
  );
  const collectionDialog = el(
    "div",
    { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true" } },
    el("button", { className: "dialog__backdrop", attrs: { type: "button", "aria-label": t("Zamknij") } }),
    el(
      "section",
      { className: "dialog__panel dialog__panel--compact" },
      el("header", { className: "dialog__header" }, el("h2", { text: t("Dodaj do kolekcji") }), collectionClose),
      el(
        "div",
        { className: "collection-picker" },
        el("p", { text: t("Wybierz ręczną listę. Inteligentne listy są wyliczane automatycznie.") }),
        collectionSearch,
        collectionSelect,
        el("div", { className: "collection-picker__divider" }, el("span", { text: t("lub utwórz nową") })),
        el("div", { className: "collection-picker__create" }, collectionCreateName, collectionCreate),
        collectionFeedback,
        el("div", { className: "collection-picker__actions" }, collectionConfirm)
      )
    )
  );
  let releaseCollectionModal: (() => void) | null = null;
  const closeCollectionDialog = (): void => {
    collectionDialog.setAttribute("aria-hidden", "true");
    releaseCollectionModal?.();
    releaseCollectionModal = null;
    collectionTarget = null;
    collectionFeedback.textContent = "";
  };
  collectionClose.addEventListener("click", closeCollectionDialog);
  collectionDialog.querySelector(".dialog__backdrop")?.addEventListener("click", closeCollectionDialog);
  collectionConfirm.addEventListener("click", () => {
    const collectionId = Number(collectionSelect.value);
    if (!collectionTarget || !Number.isSafeInteger(collectionId) || collectionId < 1) return;
    collectionConfirm.disabled = true;
    collectionFeedback.textContent = t("Dodawanie…");
    void setCollectionItem(collectionId, collectionTarget.id, true)
      .then(() => {
        collectionFeedback.textContent = t("Dodano do kolekcji.");
        window.setTimeout(closeCollectionDialog, 650);
      })
      .catch(() => { collectionFeedback.textContent = t("Nie udało się dodać. Migracja bazy może oczekiwać."); })
      .finally(() => { collectionConfirm.disabled = false; });
  });
  collectionCreate.addEventListener("click", () => {
    const name = collectionCreateName.value.trim();
    if (name.length < 2) {
      collectionFeedback.textContent = t("Nazwa playlisty musi mieć co najmniej 2 znaki.");
      collectionCreateName.focus();
      return;
    }
    collectionCreate.disabled = true;
    collectionFeedback.textContent = t("Tworzenie playlisty…");
    void createCollection({ name, media_kind: options.kind, rules: null })
      .then(async (createdId) => {
        availableCollections = await getCollections(options.kind);
        collectionSearch.value = name;
        renderCollectionOptions();
        collectionSelect.value = String(createdId);
        collectionCreateName.value = "";
        collectionFeedback.textContent = t("Playlista utworzona — możesz od razu dodać pozycję.");
      })
      .catch(() => { collectionFeedback.textContent = t("Nie udało się utworzyć playlisty."); })
      .finally(() => { collectionCreate.disabled = false; });
  });
  collectionCreateName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      collectionCreate.click();
    }
  });
  document.body.append(collectionDialog);
  document.addEventListener("media:route-will-change", () => { closeCollectionDialog(); collectionDialog.remove(); }, { once: true });

  const renderCollectionOptions = (): number => {
    const needle = collectionSearch.value.trim().toLocaleLowerCase("pl");
    const matching = availableCollections.filter((collection) =>
      !collection.is_smart && (!needle || collection.name.toLocaleLowerCase("pl").includes(needle))
    );
    collectionSelect.replaceChildren(...matching.map((collection) =>
      el("option", { text: collection.name, attrs: { value: collection.id } })
    ));
    collectionFeedback.textContent = matching.length ? "" : t("Nie znaleziono ręcznej playlisty.");
    collectionConfirm.disabled = matching.length === 0;
    return matching.length;
  };
  collectionSearch.addEventListener("input", renderCollectionOptions);
  const openCollectionDialog = (item: MediaItem): void => {
    collectionTarget = item;
    collectionSearch.value = "";
    const count = renderCollectionOptions();
    if (!count && availableCollections.length === 0) {
      collectionFeedback.textContent = t("Najpierw utwórz playlistę w zakładce Moje konto.");
    }
    collectionDialog.setAttribute("aria-hidden", "false");
    releaseCollectionModal?.();
    releaseCollectionModal = openModal(collectionDialog, { onEscape: closeCollectionDialog, initialFocus: collectionSearch });
  };
  player.setCollectionHandler(canCreateCollections ? openCollectionDialog : null);


  let directoryId: number | null = initialDirectoryId;
  let directory: LibraryDirectory | null = null;
  let pageNumber = 1;
  let searchText = initialQuery;
  const storedSort = localStorage.getItem(`media-${options.kind}-sort`) as LibrarySort | null;
  const configuredSort = options.kind === "music" ? shell.session.settings.music_sort : shell.session.settings.movies_sort;
  let librarySort: LibrarySort = storedSort && LIBRARY_SORTS.includes(storedSort) ? storedSort : configuredSort;
  let randomSeed = freshRandomSeed();
  const storedCollectionSort = localStorage.getItem("media-collection-sort") as CollectionItemSort | null;
  let collectionSort: CollectionItemSort =
    storedCollectionSort && COLLECTION_SORTS.includes(storedCollectionSort) ? storedCollectionSort : "position";
  let collectionSeed = freshRandomSeed();
  let collectionName = "";
  let collectionOwnerName = "";
  let collectionSmart = false;
  let collectionOwned = false;
  let collectionHasArtwork = false;
  // Display rules of the open playlist; 'inherit' until the server says otherwise.
  let collectionQueueRating: CollectionQueueRating = "inherit";
  let collectionQueueFavorite: CollectionQueueFavorite = "inherit";
  let collectionQueue: MediaItem[] = [];
  let collectionOffset = 0;
  let collectionTotal = 0;
  /**
   * The playlist whose queue is playing, which is not always the playlist on
   * screen: a card can start one without opening it. Kept so switching the
   * shuffle mode rebuilds from that list rather than from the browsed folder.
   */
  let activeQueueCollection: CollectionQueueContext | null = null;
  // Reordering is offered only on the caller's own manual lists.
  let collectionReorderable = false;
  let reorderBusy = false;
  let loading = false;
  let hasMore = false;
  let searchTimer = 0;
  let queueRequest = 0;
  let loadRequest = 0;
  let preparedQueueKey = "";
  let activeQueueDirectoryId: number | null = null;
  let activeQueueQuery = "";
  const gridWindowSize = 240;
  const gridWindowStep = 96;
  let gridCards: HTMLElement[] = [];
  let gridWindowStart = 0;
  let gridWindowBusy = false;
  let currentBreadcrumbs: LibraryPage["breadcrumbs"] = [];
  const directorySnapshots = new Map<number, {
    directory: LibraryDirectory;
    breadcrumbs: LibraryPage["breadcrumbs"];
    pageNumber: number;
    hasMore: boolean;
    searchText: string;
    gridCards: HTMLElement[];
    gridWindowStart: number;
    scrollY: number;
  }>();

  const search = el("input", {
    className: "topbar-search",
    attrs: { type: "search", placeholder: t("Szukaj w bibliotece…"), "aria-label": t("Szukaj") }
  });
  let preserveCollectionQueue = false;
  search.value = initialQuery;
  // A playlist is read whole, so the library search has nothing to act on there.
  const searchField = el("div", { className: "search-field" }, icon("search"), search);
  shell.actions.append(searchField);
  const breadcrumbs = el("nav", { className: "breadcrumbs", attrs: { "aria-label": t("Ścieżka folderu") } });
  const summary = el("span", { className: "library-toolbar__summary", text: t("Ładowanie biblioteki…") });
  const sortSelect = el(
    "select",
    { className: "input library-sort", attrs: { "aria-label": t("Sortowanie biblioteki") } },
    el("option", { text: t("A–Z"), attrs: { value: "title_asc" } }),
    el("option", { text: t("Z–A"), attrs: { value: "title_desc" } }),
    el("option", { text: t("Najwięcej odtworzeń"), attrs: { value: "plays_desc" } }),
    el("option", { text: t("Najwyższa średnia ocena"), attrs: { value: "rating_desc" } }),
    el("option", { text: t("Najwięcej ocen"), attrs: { value: "rating_count_desc" } }),
    el("option", { text: t("Największy rozmiar"), attrs: { value: "size_desc" } }),
    el("option", { text: t("Najdłuższe"), attrs: { value: "duration_desc" } }),
    el("option", { text: t("Najkrótsze"), attrs: { value: "duration_asc" } }),
    el("option", { text: t("Losowo (foldery)"), attrs: { value: "random" } })
  );
  sortSelect.value = librarySort;
  const collectionPositionOption = el("option", { text: t("Kolejność playlisty"), attrs: { value: "position" } });
  const collectionSortSelect = el(
    "select",
    { className: "input library-sort hidden", attrs: { "aria-label": t("Sortowanie playlisty") } },
    collectionPositionOption,
    el("option", { text: t("A–Z"), attrs: { value: "title_asc" } }),
    el("option", { text: t("Z–A"), attrs: { value: "title_desc" } }),
    el("option", { text: t("Moja ocena"), attrs: { value: "own_rating_desc" } }),
    el("option", { text: t("Średnia ocena"), attrs: { value: "rating_desc" } }),
    el("option", { text: t("Najwięcej odtworzeń"), attrs: { value: "plays_desc" } }),
    el("option", { text: t("Ostatnio dodane"), attrs: { value: "added_desc" } }),
    el("option", { text: t("Losowo"), attrs: { value: "random" } })
  );
  const reshuffleButton = el(
    "button",
    { className: "button button--secondary library-reshuffle", attrs: { type: "button", title: t("Wylosuj kolejność ponownie") } },
    icon("shuffle"),
    el("span", { className: "sr-only", text: t("Wylosuj ponownie") })
  );
  const randomOrderActive = (): boolean =>
    collectionId !== null ? collectionSort === "random" : librarySort === "random";
  reshuffleButton.classList.toggle("hidden", !randomOrderActive());
  reshuffleButton.addEventListener("click", () => {
    if (collectionId !== null) collectionSeed = freshRandomSeed();
    else randomSeed = freshRandomSeed();
    pageNumber = 1;
    void load(false);
  });
  sortSelect.addEventListener("change", () => {
    librarySort = sortSelect.value as LibrarySort;
    localStorage.setItem(`media-${options.kind}-sort`, librarySort);
    // A fresh seed each time random is picked, so re-selecting it reshuffles too.
    if (librarySort === "random") randomSeed = freshRandomSeed();
    reshuffleButton.classList.toggle("hidden", librarySort !== "random");
    pageNumber = 1;
    void load(false);
  });
  collectionSortSelect.addEventListener("change", () => {
    collectionSort = collectionSortSelect.value as CollectionItemSort;
    localStorage.setItem("media-collection-sort", collectionSort);
    if (collectionSort === "random") collectionSeed = freshRandomSeed();
    reshuffleButton.classList.toggle("hidden", collectionSort !== "random");
    pageNumber = 1;
    void load(false);
  });
  /**
   * Picture filters, offered only where they mean something: a film library that
   * has actually been through the ffprobe pass. Music has no resolution, and an
   * unprobed library would show empty selects.
   */
  const filterSelect = (label: string): HTMLSelectElement =>
    el("select", { className: "input library-filter__select", attrs: { "aria-label": label } });
  const resolutionFilter = filterSelect("Rozdzielczość");
  const hdrFilter = filterSelect("Zakres tonalny");
  const videoCodecFilter = filterSelect("Kodek wideo");
  const audioCodecFilter = filterSelect("Kodek audio");
  // What the film is about and when it came out. Unlike the four above, these do
  // not come from the file: they are what the title lookup found, so the selects
  // appear only once something has been looked up.
  const genreFilter = filterSelect("Gatunek");
  const decadeFilter = filterSelect("Dekada");
  // Music has no resolution and no HDR; what it does have is a format and whether
  // the file kept every sample. Genre would be the obvious third, but one track in
  // twelve thousand carries the tag, so the select would be a dead end.
  // Music genre is free text from the tag, not a dictionary slug, so it is a
  // separate control and a separate query key from the film one.
  const tagGenreFilter = filterSelect("Gatunek");
  const formatFilter = filterSelect("Format pliku");
  const qualityFilter = filterSelect("Jakość");
  const hiresFilter = filterSelect("Hi-res");
  const clearFilters = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("close"),
    el("span", { text: t("Wyczyść filtry") })
  );
  const filterBar = el(
    "div",
    { className: "library-filter hidden" },
    // Every field starts hidden; mountFilters reveals the ones this library has.
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Rozdzielczość") }), resolutionFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("HDR") }), hdrFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Kodek wideo") }), videoCodecFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Kodek audio") }), audioCodecFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Gatunek") }), genreFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Dekada") }), decadeFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Gatunek") }), tagGenreFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Format") }), formatFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Jakość") }), qualityFilter),
    el("label", { className: "library-filter__field hidden" }, el("span", { text: t("Hi-res") }), hiresFilter),
    clearFilters
  );
  const readFilters = (): LibraryFilters => ({
    ...(resolutionFilter.value ? { resolution: resolutionFilter.value as LibraryFilters["resolution"] } : {}),
    ...(hdrFilter.value ? { hdr: hdrFilter.value as LibraryFilters["hdr"] } : {}),
    ...(videoCodecFilter.value ? { video_codec: videoCodecFilter.value } : {}),
    ...(audioCodecFilter.value ? { audio_codec: audioCodecFilter.value } : {}),
    ...(genreFilter.value ? { genre: genreFilter.value } : {}),
    ...(decadeFilter.value ? { decade: decadeFilter.value } : {}),
    ...(tagGenreFilter.value ? { tag_genre: tagGenreFilter.value } : {}),
    ...(formatFilter.value ? { format: formatFilter.value } : {}),
    ...(qualityFilter.value ? { quality: qualityFilter.value as LibraryFilters["quality"] } : {}),
    ...(hiresFilter.value ? { hires: hiresFilter.value as LibraryFilters["hires"] } : {})
  });
  let filters: LibraryFilters = {};
  let filteredTotal: number | null = null;

  const feedback = el("div", { className: "hidden", attrs: { role: "status", "aria-live": "polite" } });
  const grid = el("section", {
    className: "media-grid " + (options.kind === "movies" ? "media-grid--movies" : "media-grid--music"),
    attrs: { "aria-label": options.title }
  });
  const loadMoreButton = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Załaduj więcej"));
  const loadMore = el("div", { className: "load-more hidden" }, loadMoreButton);
  // The label lives in its own span: querySelector("span") would find the icon
  // wrapper first and paint the text on top of the real label.
  const playLabel = el("span", { text: t("Odtwórz folder") });
  const playFolderButton = el(
    "button",
    { className: "button button--primary", attrs: { type: "button" } },
    icon("play"),
    playLabel
  );
  const archiveLabel = el("span", { text: t("Pobierz folder") });
  const archiveButton = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("archive"),
    archiveLabel
  );
  const selectedArchiveButton = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button", disabled: true } },
    icon("check"),
    el("span", { text: t("Pobierz wybrane") })
  );
  if (!canDownloadSelection) selectedArchiveButton.classList.add("hidden");
  const coverButton = el(
    "button",
    { className: "button button--secondary hidden", attrs: { type: "button" } },
    icon("image"),
    el("span", { text: t("Okładka playlisty") })
  );
  // A link, not a button: the browser saves the response itself. The file holds
  // item identifiers, so it restores into this server exactly and says nothing
  // about where anything sits on disk — and no other player will open it.
  const exportLink = el("a", {
    className: "button button--secondary hidden",
    attrs: { download: "", rel: "nofollow" }
  }) as HTMLAnchorElement;
  exportLink.append(icon("archive"), el("span", { text: t("Eksportuj playlistę") }));
  shell.content.append(
    breadcrumbs,
    el(
      "div",
      { className: "library-toolbar" },
      summary,
      el("div", { className: "library-toolbar__actions" }, sortSelect, collectionSortSelect, reshuffleButton, playFolderButton, coverButton, exportLink, archiveButton, selectedArchiveButton)
    ),
    filterBar,
    feedback,
    grid,
    loadMore
  );

  /**
   * Show the controls that belong to the view being looked at.
   *
   * Browsing folders and reading a playlist share one toolbar but not one set of
   * controls: a playlist has no folder sorting, no library search and no folder
   * archive, and only its owner may give it a cover.
   */
  const syncToolbar = (): void => {
    const inCollection = collectionId !== null;
    searchField.classList.toggle("hidden", inCollection);
    sortSelect.classList.toggle("hidden", inCollection);
    collectionSortSelect.classList.toggle("hidden", !inCollection);
    reshuffleButton.classList.toggle("hidden", !randomOrderActive());
    playFolderButton.classList.toggle("hidden", options.kind !== "music");
    playLabel.textContent = inCollection ? t("Odtwórz playlistę") : t("Odtwórz folder");
    // Downloading the library root is its own right; inside a folder or a
    // playlist the folder right decides.
    archiveButton.classList.toggle(
      "hidden",
      !(inCollection || directory?.relative_path !== "" ? canDownloadFolder : canDownloadLibrary)
    );
    archiveLabel.textContent = inCollection
      ? t("Pobierz playlistę")
      : searchText ? "Pobierz wyniki" : t("Pobierz folder");
    coverButton.classList.toggle("hidden", !(inCollection && collectionOwned && canCreateCollections));
    // Exporting is reading a list you can already see, so it needs no download
    // right: the file carries identifiers and titles, never the media.
    exportLink.classList.toggle("hidden", !inCollection || collectionId === null);
    if (inCollection && collectionId !== null) exportLink.href = collectionExportUrl(collectionId, "m3u");
    // A manual order exists only on a hand-arranged list.
    collectionPositionOption.classList.toggle("hidden", collectionSmart);
    collectionPositionOption.disabled = collectionSmart;
    collectionSortSelect.value = collectionSort;
  };
  syncToolbar();

  /**
   * Start the download and say what the group's whitelist left behind.
   *
   * Silently handing over a shorter archive than asked for is worse than saying
   * so: the listener would think files went missing from the library.
   */
  const reportArchive = (transfer: ArchiveTransfer): void => {
    submitArchive(transfer);
    if (transfer.skipped) {
      showMessage(
        t("Pobieranie {count} plików. Pominięto {skipped} — Twoja grupa nie może pobierać tych rozszerzeń.", {
          count: transfer.count.toLocaleString("pl-PL"),
          skipped: transfer.skipped.toLocaleString("pl-PL")
        })
      );
    }
  };

  const showMessage = (text: string, error = false): void => {
    feedback.className = error ? "notice notice--error" : "notice";
    feedback.textContent = text;
  };
  const clearMessage = (): void => {
    feedback.className = "hidden";
    feedback.textContent = "";
  };
  const updateSummary = (): void => {
    if (selected.size > 0) summary.textContent = t("Wybrano: ") + selected.size;
    else if (filteredTotal !== null) {
      // Counted by the server across the whole subtree, not by how many cards
      // happen to be loaded.
      summary.textContent = t("{count} pozycji pasuje do filtrów", { count: filteredTotal.toLocaleString("pl-PL") });
    } else if (collectionId !== null) {
      // The size of the playlist, counted by the server — not the length of the
      // window that happens to be loaded, which grew with every "load more".
      summary.textContent = collectionTotal.toLocaleString("pl-PL") + " pozycji"
        + (collectionSmart ? " · lista inteligentna" : "");
    } else if (directory) {
      summary.textContent = t("{count} plików · {size}", { count: directory.descendant_file_count.toLocaleString("pl-PL"), size: formatBytes(directory.total_size_bytes) });
    }
    selectedArchiveButton.disabled = selected.size === 0;
  };

  const navigate = async (nextDirectoryId: number): Promise<void> => {
    if (directory && collectionId === null && directory.id !== nextDirectoryId) {
      // Keep a bounded LRU of retained card DOM; a long browsing session would
      // otherwise pin every visited directory's nodes in memory for good.
      directorySnapshots.delete(directory.id);
      directorySnapshots.set(directory.id, {
        directory,
        breadcrumbs: [...currentBreadcrumbs],
        pageNumber,
        hasMore,
        searchText,
        gridCards: [...gridCards],
        gridWindowStart,
        scrollY: window.scrollY
      });
      while (directorySnapshots.size > 8) {
        directorySnapshots.delete(directorySnapshots.keys().next().value!);
      }
    }
    const snapshot = directorySnapshots.get(nextDirectoryId);
    if (snapshot) {
      directoryId = snapshot.directory.id;
      directory = snapshot.directory;
      pageNumber = snapshot.pageNumber;
      hasMore = snapshot.hasMore;
      searchText = snapshot.searchText;
      search.value = snapshot.searchText;
      syncToolbar();
      gridCards = [...snapshot.gridCards];
      gridWindowStart = snapshot.gridWindowStart;
      renderBreadcrumbs({ breadcrumbs: snapshot.breadcrumbs });
      drawGridWindow();
      loadMore.classList.toggle("hidden", !hasMore);
      updateSummary();
      window.requestAnimationFrame(() => window.scrollTo({ top: snapshot.scrollY, behavior: "auto" }));
      return;
    }
    directoryId = nextDirectoryId;
    pageNumber = 1;
    selected.clear();
    await load(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const renderBreadcrumbs = (page: Pick<LibraryPage, "breadcrumbs">): void => {
    currentBreadcrumbs = [...page.breadcrumbs];
    const fragment = document.createDocumentFragment();
    page.breadcrumbs.forEach((crumb, index) => {
      const button = el("button", { attrs: { type: "button" }, text: crumb.name });
      button.addEventListener("click", () => void navigate(crumb.id));
      fragment.append(button);
      if (index < page.breadcrumbs.length - 1) fragment.append(icon("chevron"));
    });
    breadcrumbs.replaceChildren(fragment);
  };

  /**
   * A playlist sits inside its library, under the person who made it:
   * Music > owner > playlist. The first crumb walks back to the library, the
   * second opens that person's profile.
   */
  const renderCollectionBreadcrumbs = (collection: CollectionPage["collection"]): void => {
    const library = el("button", { attrs: { type: "button" }, text: options.title });
    library.addEventListener("click", () => void leaveCollection());
    const fragment = document.createDocumentFragment();
    fragment.append(library, icon("chevron"));
    if (collection.owner_name) {
      fragment.append(
        el(
          "a",
          { attrs: { href: appUrl(`account/${encodeURIComponent(collection.owner_name)}/`) }, text: collection.owner_name },
        ),
        icon("chevron")
      );
    }
    fragment.append(el("span", { text: collection.name }));
    breadcrumbs.replaceChildren(fragment);
  };

  /** Open a playlist as a view of this library, without leaving the page. */
  const enterCollection = (collection: UserCollection): void => {
    collectionId = collection.id;
    collectionName = collection.name;
    collectionSmart = collection.is_smart;
    collectionOwned = collection.is_owned;
    collectionTotal = collection.item_count;
    if (collectionSmart && collectionSort === "position") collectionSort = "title_asc";
    pageNumber = 1;
    selected.clear();
    search.value = "";
    searchText = "";
    syncToolbar();
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("collection", String(collection.id));
    window.history.pushState({}, "", url);
    void load(false).then(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  };

  /** Back to browsing folders; whatever the playlist is playing keeps playing. */
  const leaveCollection = async (): Promise<void> => {
    if (collectionId === null) return;
    collectionId = null;
    collectionName = "";
    collectionSmart = false;
    collectionOwned = false;
    collectionQueue = [];
    collectionTotal = 0;
    preserveCollectionQueue = true;
    directoryId = initialDirectoryId;
    pageNumber = 1;
    selected.clear();
    searchText = "";
    search.value = "";
    syncToolbar();
    const url = new URL(window.location.href);
    url.search = "";
    window.history.pushState({}, "", url);
    await load(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /**
   * Give the open playlist an own cover, or take it away again.
   *
   * The picker is the same one the tag editor uses, so the cropping, the checks
   * and the 500x500 WebP result are identical; only the endpoint differs.
   */
  let coverPicker: CoverPicker | null = null;
  let coverDialog: HTMLElement | null = null;
  let releaseCoverModal: (() => void) | null = null;
  let coverStatus: HTMLElement | null = null;
  const closeCoverDialog = (): void => {
    coverPicker?.destroy();
    coverDialog?.setAttribute("aria-hidden", "true");
    releaseCoverModal?.();
    releaseCoverModal = null;
  };
  const openCoverDialog = (): void => {
    if (collectionId === null) return;
    if (!coverDialog) {
      const status = el("span", { className: "form-status", attrs: { role: "status" } });
      // One status line for the whole dialog, so the picker and the save button
      // never contradict each other.
      const picker = new CoverPicker({
        hint: t("Wybierz obraz, ustaw kadr 1:1 i zapisz. Bez własnej okładki playlista pokazuje okładki swoich utworów."),
        placeholder: "list",
        onMessage: (text) => { status.textContent = text; }
      });
      const close = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Zamknij") } }, icon("close"));
      const cancel = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Anuluj"));
      const save = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("check"), t("Zapisz okładkę"));
      close.addEventListener("click", closeCoverDialog);
      cancel.addEventListener("click", closeCoverDialog);
      save.addEventListener("click", () => {
        const change = picker.change();
        if (collectionId === null || change === undefined) {
          status.textContent = t("Najpierw wybierz nową okładkę albo ją usuń.");
          return;
        }
        save.disabled = true;
        status.textContent = t("Zapisywanie…");
        void saveCollectionArtwork(collectionId, change)
          .then(() => {
            picker.markSaved();
            status.textContent = change === null ? t("Okładka usunięta.") : t("Okładka zapisana.");
            // Reload so the card and the candidates match what was just stored.
            pageNumber = 1;
            return load(false);
          })
          .then(() => window.setTimeout(closeCoverDialog, 700))
          .catch((error: unknown) => {
            status.textContent = error instanceof ApiError && error.message ? error.message : t("Nie udało się zapisać okładki.");
          })
          .finally(() => { save.disabled = false; });
      });
      coverDialog = el(
        "div",
        { className: "dialog", attrs: { role: "dialog", "aria-modal": "true", "aria-hidden": "true" } },
        el("button", { className: "dialog__backdrop", attrs: { type: "button", "aria-label": t("Zamknij") } }),
        el(
          "section",
          { className: "dialog__panel dialog__panel--metadata" },
          el("header", { className: "dialog__header" },
            el("div", {}, el("span", { className: "eyebrow", text: t("Playlista") }), el("h2", { text: t("Okładka playlisty") })),
            close
          ),
          el("div", { className: "collection-cover" },
            picker.element,
            el("div", { className: "metadata-form__actions" }, status, cancel, save)
          )
        )
      );
      coverDialog.querySelector(".dialog__backdrop")?.addEventListener("click", closeCoverDialog);
      document.body.append(coverDialog);
      document.addEventListener("media:route-will-change", () => { closeCoverDialog(); coverDialog?.remove(); }, { once: true });
      coverPicker = picker;
      coverStatus = status;
    }
    coverStatus!.textContent = "";
    coverPicker!.reset(collectionHasArtwork ? collectionPreviewUrl(collectionId, String(Date.now())) : null);
    coverDialog.setAttribute("aria-hidden", "false");
    releaseCoverModal?.();
    releaseCoverModal = openModal(coverDialog, { onEscape: closeCoverDialog });
  };

  type SlidingPreview = {
    visual: HTMLElement;
    /** Image URLs to try, in order; a failing one hands over to the next. */
    candidates: string[];
    index: number;
    visible: boolean;
    busy: boolean;
    failures: number;
  };
  let slidingPreviews: SlidingPreview[] = [];
  const previewStates = new WeakMap<Element, SlidingPreview>();
  previewObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = previewStates.get(entry.target);
      if (state) state.visible = entry.isIntersecting;
    }
  }, { rootMargin: "240px" }) : null;

  const preview = (
    itemId: number | null,
    kind: MediaItem["media_kind"] | null,
    fallback: IconName,
    candidates: Array<{ id: number; kind: MediaKind }> = [],
    slideshow = false,
    /** Tried before the candidates; a 404 (no own cover) falls through to them. */
    leadUrl: string | null = null
  ): HTMLElement => {
    const visual = el("div", { className: "media-card__preview" }, icon(fallback));
    const usable = candidates.filter((candidate, index, all) =>
      supportsThumbnail(candidate.kind) && all.findIndex((other) => other.id === candidate.id) === index
    );
    if (usable.length === 0 && itemId !== null && supportsThumbnail(kind)) {
      usable.push({ id: itemId, kind: kind as MediaKind });
    }
    const sources = usable.map((candidate) => previewUrl(candidate.id));
    if (leadUrl !== null) sources.unshift(leadUrl);
    if (slideshow && sources.length > 1) {
      const entropy = crypto.getRandomValues(new Uint32Array(sources.length));
      for (let index = sources.length - 1; index > 0; index -= 1) {
        const target = (entropy[index] ?? 0) % (index + 1);
        const current = sources[index]!;
        sources[index] = sources[target]!;
        sources[target] = current;
      }
    }
    if (sources.length === 0) return visual;

    const state: SlidingPreview = { visual, candidates: sources, index: 0, visible: previewObserver === null, busy: false, failures: 0 };
    const load = (animate: boolean): void => {
      if (state.busy || !state.candidates[state.index]) return;
      state.busy = true;
      const image = el("img", {
        className: "media-preview__image",
        attrs: { alt: "", loading: "lazy", decoding: "async", src: state.candidates[state.index]! }
      });
      image.addEventListener("load", () => {
        state.busy = false;
        state.failures = 0;
        const previous = visual.querySelector<HTMLImageElement>(".media-preview__image.is-active");
        visual.classList.add("has-image");
        if (!animate || !previous) {
          image.classList.add("is-active");
          return;
        }
        window.requestAnimationFrame(() => {
          void image.offsetWidth;
          window.requestAnimationFrame(() => {
            image.classList.add("is-active");
            previous.classList.remove("is-active");
            previous.classList.add("is-leaving");
            window.setTimeout(() => previous.remove(), 1900);
          });
        });
      }, { once: true });
      image.addEventListener("error", () => {
        image.remove();
        state.busy = false;
        state.failures += 1;
        if (state.failures >= state.candidates.length) return;
        state.index = (state.index + 1) % state.candidates.length;
        load(false);
      }, { once: true });
      visual.append(image);
    };
    previewStates.set(visual, state);
    previewObserver?.observe(visual);
    load(false);
    if (slideshow && sources.length > 1) {
      visual.classList.add("is-slideshow");
      slidingPreviews.push(state);
    }
    return visual;
  };

  slideshowTimer = window.setInterval(() => {
    if (document.hidden) return;
    slidingPreviews = slidingPreviews.filter((state) => {
      if (!state.visual.isConnected) previewObserver?.unobserve(state.visual);
      return state.visual.isConnected;
    });
    for (const state of slidingPreviews) {
      if (!state.visible || state.busy) continue;
      state.index = (state.index + 1) % state.candidates.length;
      const image = state.visual.querySelector<HTMLImageElement>(".media-preview__image:not(.is-active)");
      image?.remove();
      state.busy = false;
      const candidate = state.candidates[state.index];
      if (!candidate) continue;
      const next = el("img", { className: "media-preview__image", attrs: { alt: "", decoding: "async", src: candidate } });
      state.busy = true;
      next.addEventListener("load", () => {
        state.busy = false;
        const previous = state.visual.querySelector<HTMLImageElement>(".media-preview__image.is-active");
        void next.offsetWidth;
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            next.classList.add("is-active");
            previous?.classList.remove("is-active");
            previous?.classList.add("is-leaving");
            if (previous) window.setTimeout(() => previous.remove(), 1900);
          });
        });
      }, { once: true });
      next.addEventListener("error", () => { state.busy = false; next.remove(); }, { once: true });
      state.visual.append(next);
    }
  }, 9500);
  const selectionControl = (item: MediaItem): HTMLElement => {
    const input = el("input", { attrs: { type: "checkbox", "aria-label": t("Wybierz {title}", { title: item.title }) } });
    input.checked = selected.has(item.id);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(item.id);
      else selected.delete(item.id);
      updateSummary();
    });
    const control = el("label", { className: "media-check" }, input, el("span", { className: "media-check__box" }, icon("check")));
    for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"] as const) {
      control.addEventListener(eventName, (event) => event.stopPropagation());
    }
    // Keep the card's own key handling out, but let global shortcuts (Escape,
    // Space for the player) reach the document.
    control.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" && event.key !== " ") event.stopPropagation();
    });
    return control;
  };

  const ratingControl = (item: MediaItem): HTMLElement => ratingPicker({
    value: item.rating ?? item.avg_rating,
    summary: `${item.avg_rating.toFixed(1)} (${item.rating_count})`,
    ariaLabel: `Ocena utworu ${item.title}`,
    disabled: !canRate,
    onSelect: async (value) => {
      const result = await updateRating(item.id, { rating: item.rating === value ? null : value });
      item.rating = result.user_rating;
      item.avg_rating = result.avg_rating;
      item.rating_count = result.rating_count;
      const card = grid.querySelector<HTMLElement>(`[data-media-id="${item.id}"]`);
      const existing = card?.querySelector<HTMLElement>(".rating-picker");
      if (existing) existing.replaceWith(ratingControl(item));
      player.applyItemUpdate({
        id: item.id,
        rating: item.rating,
        avg_rating: item.avg_rating,
        rating_count: item.rating_count
      });
    }
  });
  const folderRating = (folder: LibraryDirectory): HTMLElement | null => {
    if (folder.rating_count === 0) return null;
    const stars = el("div", { className: "rating-inline rating-inline--summary", attrs: { "aria-label": `Średnia ${folder.avg_rating.toFixed(1)} z ${folder.rating_count} ocen` } });
    for (let value = 1; value <= 5; value += 1) {
      stars.append(starVisual(folder.avg_rating, value));
    }
    stars.append(el("span", { text: folder.avg_rating.toFixed(1) + " (" + folder.rating_count + ")" }));
    return stars;
  };

  const downloadButton = (item: MediaItem): HTMLButtonElement => {
    const button = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Pobierz {title}", { title: item.title }) } }, icon("download"));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      button.disabled = true;
      void createFileTransfer(item.id, false)
        .then((transfer) => window.location.assign(transfer.url))
        .catch((error) => showMessage(downloadFailureText(error, t("Nie udało się przygotować pobierania.")), true))
        .finally(() => { button.disabled = false; });
    });
    return button;
  };

  const playDirectory = async (
    targetDirectoryId: number,
    startId?: number,
    immediateItem?: MediaItem,
    autoplay = true,
    queueQuery = searchText,
    directoryLabel?: string
  ): Promise<void> => {
    if (!player) return;
    const request = ++queueRequest;
    const shuffle = player.nextQueueShuffle();
    let shuffledOffset = 0;
    playFolderButton.disabled = true;
    preserveCollectionQueue = false;
    const context = queueQuery
      ? `Wyniki wyszukiwania: \u201e${queueQuery}\u201d`
      : directoryLabel
        ? `Folder: ${directoryLabel}`
        : directory?.relative_path
          ? `Folder: ${directory.name}`
          : t("Wszystkie utwory");
    const loader = async (direction: "before" | "after", cursor: number) => {
      if (shuffle.mode === "off") {
        const page = await getQueuePage(targetDirectoryId, cursor, 160, direction, queueQuery);
        if (request !== queueRequest) throw new Error("stale queue request");
        return page;
      }
      if (direction === "before") {
        return { items: [], next_cursor: null, has_more: false, offset: 0, total: 0 };
      }
      const page = await getQueuePage(targetDirectoryId, 0, 160, "after", queueQuery, {
        shuffleMode: shuffle.mode,
        shuffleSeed: shuffle.seed,
        offset: shuffledOffset
      });
      if (request !== queueRequest) throw new Error("stale queue request");
      shuffledOffset = page.next_cursor ?? shuffledOffset + page.items.length;
      return page;
    };
    const globalLoader = shuffle.mode !== "off"
      ? async (offset: number) => {
          const page = await getQueuePage(targetDirectoryId, 0, 160, "after", queueQuery, {
            shuffleMode: shuffle.mode,
            shuffleSeed: shuffle.seed,
            offset
          });
          if (request !== queueRequest) throw new Error("stale global queue request");
          return page;
        }
      : null;
    try {
      if (immediateItem && shuffle.mode === "off") {
        await player.setQueue([immediateItem], immediateItem.id, autoplay, { offset: 0, total: 1, context });
        if (request !== queueRequest) return;
        player.setQueuePaging(loader, true, true);
        void player.prefetchAfter();
        preparedQueueKey = String(targetDirectoryId) + "|" + queueQuery;
        clearMessage();
        activeQueueDirectoryId = targetDirectoryId;
        activeQueueQuery = queueQuery;
        activeQueueCollection = null;
        return;
      }

      const first = await loader("after", 0);
      const items = immediateItem
        ? [immediateItem, ...first.items.filter((item) => item.id !== immediateItem.id)]
        : first.items;
      if (items.length === 0) {
        showMessage(t("Ten folder nie zawiera utworów."), true);
        return;
      }
      await player.setQueue(items, startId ?? immediateItem?.id, autoplay, { offset: first.offset, total: first.total, context });
      if (request !== queueRequest) return;
      player.setGlobalQueueLoader(globalLoader);
      if (!globalLoader) player.setQueuePaging(loader, false, first.has_more);
      // Remembered so a page reload can rebuild these loaders; without it the
      // restored session could only shuffle inside the window it had cached.
      player.setQueueSource({
        kind: "directory",
        id: targetDirectoryId,
        query: queueQuery,
        shuffleMode: shuffle.mode,
        shuffleSeed: shuffle.seed
      });
      preparedQueueKey = String(targetDirectoryId) + "|" + queueQuery;
      // Remember which folder is actually playing so a later shuffle-mode change
      // rebuilds the queue from it, not from whatever folder is being browsed.
      activeQueueDirectoryId = targetDirectoryId;
      activeQueueQuery = queueQuery;
      activeQueueCollection = null;
      clearMessage();
    } catch {
      if (request === queueRequest) showMessage(t("Nie udało się pobrać playlisty."), true);
    } finally {
      if (request === queueRequest) playFolderButton.disabled = false;
    }
  };

  if (options.kind === "music") {
    player?.setQueueModeChangeHandler(async (preserveCurrent) => {
      if (collectionId !== null) {
        await playCollection(preserveCurrent ? player.currentItem()?.id : undefined, preserveCurrent ? player.isPlaying() : true);
        return;
      }
      // A playlist started from a card plays while the grid shows a folder;
      // re-shuffling has to rebuild that list, not whatever is on screen.
      if (activeQueueCollection) {
        await playCollectionQueue(
          activeQueueCollection,
          preserveCurrent ? player.currentItem()?.id : undefined,
          preserveCurrent ? player.isPlaying() : true
        );
        return;
      }
      const targetDirectoryId = activeQueueDirectoryId ?? directory?.id ?? null;
      if (targetDirectoryId === null) return;
      const current = preserveCurrent ? player.currentItem() : null;
      await playDirectory(targetDirectoryId, current?.id, current ?? undefined, preserveCurrent ? player.isPlaying() : true, activeQueueQuery);
    });
  }

  const createFolderCard = (folder: LibraryDirectory, allTracks = false): HTMLElement => {
    const open = el(
      "button",
      {
        className: "media-card__open",
        attrs: { type: "button", "aria-label": (allTracks ? t("Odtwórz {name}", { name: folder.name }) : t("Otwórz {name}", { name: folder.name })) }
      },
      preview(folder.preview_media_item_id, folder.preview_kind, allTracks ? "music" : "folder", folder.preview_candidates, true)
    );
    open.addEventListener("click", () => {
      if (allTracks) void playDirectory(folder.id, undefined, undefined, true, searchText, folder.name);
      else void navigate(folder.id);
    });
    const primary = el(
      "button",
      { className: "button button--primary", attrs: { type: "button" } },
      icon(options.kind === "music" ? "play" : "folder"),
      el("span", { text: options.kind === "music" ? t("Odtwórz") : t("Otwórz") })
    );
    primary.addEventListener("click", () => {
      if (options.kind === "music" || allTracks) void playDirectory(folder.id, undefined, undefined, true, searchText, folder.name);
      else void navigate(folder.id);
    });
    const folderFooter = el("div", { className: "media-card__footer" }, primary);
    if (canShare) {
      const share = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Udostępnij folder {name}", { name: folder.name }) } }, icon("share"));
      share.dataset.tooltip = t("Kopiuj link do folderu");
      share.addEventListener("click", () => {
        share.disabled = true;
        void copyShareLink({ directory: String(folder.id) })
          .then(() => { share.dataset.tooltip = t("Link skopiowany"); })
          .finally(() => { share.disabled = false; });
      });
      folderFooter.append(share);
      if (guestLinksOn) {
        const guest = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Link gościnny do {name}", { name: folder.name }) } }, icon("magnet"));
        guest.dataset.tooltip = t("Link dla osoby bez konta");
        guest.addEventListener("click", () => openGuestLinkDialog({ kind: "directory", id: folder.id, name: folder.name }));
        folderFooter.append(guest);
      }
    }
    if (canDownloadFolder) {
      const downloadFolder = el("button", {
        className: "icon-button",
        attrs: { type: "button", "aria-label": t("Pobierz folder {name}", { name: folder.name }) }
      }, icon("download"));
      downloadFolder.addEventListener("click", () => {
        downloadFolder.disabled = true;
        void createDirectoryArchive(options.kind, folder.id, folder.name + ".zip")
          .then(reportArchive)
          .catch((error) => showMessage(downloadFailureText(error, t("Nie udało się przygotować folderu ZIP.")), true))
          .finally(() => { downloadFolder.disabled = false; });
      });
      folderFooter.append(downloadFolder);
    }
    return el(
      "article",
      { className: `media-card media-card--folder${allTracks ? " media-card--all" : ""}` },
      open,
      el(
        "div",
        { className: "media-card__body" },
        el("h3", { className: "media-card__title", text: folder.name, attrs: { title: folder.name } }),
        el("p", { className: "media-card__meta", text: t("{count} plików", { count: folder.descendant_file_count.toLocaleString("pl-PL") }) }),
        el("p", { className: "media-card__path", text: formatBytes(folder.total_size_bytes) }),

        folderRating(folder)
      ),
      folderFooter
    );
  };

  /**
   * Stars for the list itself, on the card that carries it.
   *
   * The picker is the one the track cards use, so a vote is cast the same way
   * everywhere; only what is being voted on differs. Clicking the star already
   * given clears the vote. The answer redraws this card's picker in place —
   * the grid is windowed and a full redraw would lose the scroll position.
   */
  const collectionRatingControl = (collection: UserCollection): HTMLElement => ratingPicker({
    value: collection.rating ?? collection.avg_rating,
    summary: `${collection.avg_rating.toFixed(1)} (${collection.rating_count})`,
    ariaLabel: t("Ocena playlisty {name}", { name: collection.name }),
    disabled: !canRate,
    onSelect: async (value) => {
      const result = await rateCollection(collection.id, collection.rating === value ? null : value);
      collection.rating = result.user_rating;
      collection.avg_rating = result.avg_rating;
      collection.rating_count = result.rating_count;
      const card = grid.querySelector<HTMLElement>(`[data-collection-id="${collection.id}"]`);
      card?.querySelector<HTMLElement>(".rating-picker")?.replaceWith(collectionRatingControl(collection));
    }
  });

  /**
   * A playlist as an ordinary card.
   *
   * It used to be built like a folder — dark gradient, big glyph, a wide "open
   * playlist" button where a track card has "play". That said "this is a place
   * you walk into", and a playlist is not a place: it is a selection somebody
   * made, and the thing you usually want from it is to hear it. So the card is
   * shaped like every other card on the shelf: play, share, download, and stars
   * under the description.
   *
   * The two wishes are split accordingly. **Play plays** — it queues the list
   * and starts it, leaving the grid where it was; it used to walk into the list
   * on the way, which is fine the first time and an interruption every time
   * after. **Entering is the thumbnail**, exactly as on the folder card beside
   * it, which is also the one card whose picture opens something.
   *
   * The play button wears the playlist glyph rather than a play triangle: it
   * still plays, but what it plays is a list, and that is the one thing telling
   * this card apart from the track card beside it.
   */
  const createPlaylistCard = (collection: UserCollection): HTMLElement => {
    // Own cover if there is one, otherwise the artwork of what is on the list.
    const visual = preview(
      null,
      null,
      collection.media_kind === "music" ? "music" : "film",
      collection.preview_candidates,
      !collection.has_artwork,
      collection.has_artwork ? collectionPreviewUrl(collection.id, collection.artwork_revision) : null
    );
    const open = el(
      "button",
      { className: "media-card__open", attrs: { type: "button", "aria-label": t("Otwórz playlistę {name}", { name: collection.name }) } },
      visual
    );
    open.addEventListener("click", () => enterCollection(collection));
    const playable = options.kind === "music";
    const primary = el(
      "button",
      { className: "button button--primary", attrs: { type: "button" } },
      icon("list"),
      el("span", { text: playable ? t("Odtwórz") : t("Otwórz playlistę") })
    );
    primary.addEventListener("click", () => {
      if (!playable) {
        enterCollection(collection);
        return;
      }
      primary.disabled = true;
      void playCollectionCard(collection).finally(() => { primary.disabled = false; });
    });
    const footer = el("div", { className: "media-card__footer" }, primary);
    if (canShare) {
      // A link to a private list opens for nobody but its author, so sharing one
      // publishes it first — the same single meaning of "share" the collection
      // browser has. The tooltip says which of the two will happen.
      const share = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Udostępnij playlistę {name}", { name: collection.name }) } }, icon("share"));
      const shareTooltip = (): string => collection.is_owned && !collection.is_shared
        ? t("Udostępnij i skopiuj link")
        : t("Kopiuj link do playlisty");
      share.dataset.tooltip = shareTooltip();
      share.addEventListener("click", () => {
        share.disabled = true;
        void Promise.resolve(collection.is_owned && !collection.is_shared ? setCollectionShared(collection.id, true) : undefined)
          .then(() => {
            if (collection.is_owned) collection.is_shared = true;
            return copyShareLink({ collection: String(collection.id) });
          })
          .then(() => { share.dataset.tooltip = t("Link skopiowany"); })
          .catch(() => showMessage(t("Nie udało się udostępnić playlisty."), true))
          .finally(() => { share.disabled = false; });
      });
      footer.append(share);
    }
    if (canDownloadFolder) {
      const download = el("button", {
        className: "icon-button",
        attrs: { type: "button", "aria-label": t("Pobierz playlistę {name}", { name: collection.name }) }
      }, icon("download"));
      download.dataset.tooltip = t("Pobierz playlistę");
      download.addEventListener("click", () => {
        download.disabled = true;
        void createCollectionArchive(collection.id, collection.name + ".zip")
          .then(reportArchive)
          .catch((error) => showMessage(downloadFailureText(error, t("Nie udało się przygotować playlisty ZIP.")), true))
          .finally(() => { download.disabled = false; });
      });
      footer.append(download);
    }
    return el(
      "article",
      { className: "media-card media-card--playlist", dataset: { collectionId: collection.id } },
      open,
      el(
        "div",
        { className: "media-card__body" },
        el("span", { className: "eyebrow", text: collection.is_smart ? t("Inteligentna playlista") : t("Własna playlista") }),
        el("h3", { className: "media-card__title", text: collection.name, attrs: { title: collection.name } }),
        // The description is what its author wanted said about it; the count is
        // a fact anybody could work out. Both, in that order, when there is one.
        collection.description
          ? el("p", { className: "media-card__meta", text: collection.description, attrs: { title: collection.description } })
          : null,
        el("p", { className: "media-card__meta", text: t("{count} pozycji", { count: collection.item_count.toLocaleString("pl-PL") }) }),
        collection.is_owned ? null : el("p", { className: "media-card__path", text: collection.owner_name }),
        collection.is_shared
          ? el("p", { className: "media-card__stats" }, el("span", { className: "status-pill status-pill--success", text: t("Udostępniona") }))
          : null
      ),
      collectionRatingControl(collection),
      footer
    );
  };

  const createItemCard = (
    item: MediaItem,
    folderPreview: number | null,
    folderPreviewKind: MediaItem["media_kind"] | null
  ): HTMLElement => {
    const resolution = resolutionLabel(item);
    const ownPreview = ["audio", "video", "image"].includes(item.media_kind);
    const reusableFolderPreview = item.media_kind === "audio" && supportsThumbnail(folderPreviewKind);
    const previewId = ownPreview ? item.id : reusableFolderPreview ? folderPreview : null;
    const previewKind = ownPreview ? item.media_kind : reusableFolderPreview ? folderPreviewKind : null;
    const visual = preview(previewId, previewKind, itemIcon(item));
    if (canDownloadSelection) visual.append(selectionControl(item));
    const open = el("button", { className: "media-card__open", attrs: { type: "button", "aria-label": t("Otwórz {title}", { title: item.title }) } }, visual);
    open.addEventListener("click", () => {
      if (item.media_kind === "audio" && collectionId !== null) void playCollection(item.id, true);
      else if (item.media_kind === "audio" && directory) void playDirectory(directory.id, item.id, item);
      else void viewer.open(item);
    });
    const metadata = [item.artist, item.album].filter((value): value is string => Boolean(value)).join(" · ");
    const footer = el("div", { className: "media-card__footer" });
    const primary = el(
      "button",
      { className: "button button--primary", attrs: { type: "button" } },
      icon(item.media_kind === "audio" || item.media_kind === "video" ? "play" : "info"),
      el("span", { text: item.media_kind === "audio" || item.media_kind === "video" ? t("Odtwórz") : t("Podgląd") })
    );
    primary.addEventListener("click", () => open.click());
    if (["audio", "video"].includes(item.media_kind) && canEditTags) {
      const edit = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Edytuj metadane") } }, icon("edit"));
      edit.addEventListener("click", () => openMetadataEditor(item));
      footer.append(edit);
    }
    if (canFavorite && ["audio", "video"].includes(item.media_kind)) {
      const favorite = el(
        "button",
        { className: "icon-button" + (item.favorite ? " is-active" : ""), attrs: { type: "button", "aria-label": t("Ulubione") } },
        icon("heart")
      );
      favorite.addEventListener("click", () => {
        favorite.disabled = true;
        void updateRating(item.id, { favorite: !item.favorite }).then((result) => {
          item.favorite = result.user_favorite;
          favorite.classList.toggle("is-active", item.favorite);
          // The player holds its own copies of the track; keep them in step so the
          // open queue shows the heart immediately.
          player.applyItemUpdate({ id: item.id, favorite: item.favorite });
        }).finally(() => { favorite.disabled = false; });
      });
      footer.append(favorite);
    }
    if (canCreateCollections && ["audio", "video"].includes(item.media_kind)) {
      const addToCollection = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Dodaj do kolekcji") } }, icon("list"));
      addToCollection.addEventListener("click", () => openCollectionDialog(item));
      footer.append(addToCollection);
    }
    if (canShare) {
      const share = el("button", { className: "icon-button", attrs: { type: "button", "aria-label": t("Udostępnij {title}", { title: item.title }) } }, icon("share"));
      share.dataset.tooltip = t("Kopiuj link do tego utworu lub filmu");
      share.addEventListener("click", () => {
        share.disabled = true;
        const parameters: Record<string, string> = { q: item.title, play: String(item.id) };
        if (directory) parameters.directory = String(directory.id);
        void copyShareLink(parameters)
          .then(() => { share.dataset.tooltip = t("Link skopiowany"); })
          .finally(() => { share.disabled = false; });
      });
      footer.append(share);
    }
    if (canDownloadFile) footer.append(downloadButton(item));
    return el(
      "article",
      { className: "media-card", dataset: { mediaId: item.id } },
      open,
      el(
        "div",
        { className: "media-card__body" },
        el("h3", { className: "media-card__title", text: item.title, attrs: { title: item.title } }),
        metadata ? el("p", { className: "media-card__meta", text: metadata }) : null,
        el("p", {
          className: "media-card__filename",
          text: item.relative_path.split("/").pop() ?? item.relative_path,
          attrs: { title: item.relative_path.split("/").pop() ?? item.relative_path }
        }),
        el("p", { className: "media-card__path", text: item.relative_path, attrs: { title: item.relative_path } }),
        el(
          "div",
          { className: "media-card__stats" },
          el("span", { text: formatDuration(item.duration_ms) }),
          el("span", { text: formatBytes(item.size_bytes) }),
          resolution ? el("span", { className: "media-card__badge", text: resolution }) : null,
          item.is_hdr ? el("span", { className: "media-card__badge media-card__badge--hdr", text: t("HDR") }) : null
        ),
        // Plays get a line of their own: wrapping after the badges used to leave
        // one card with the count inline and its neighbour with it below.
        item.play_count > 0
          ? el(
              "p",
              {
                className: "media-card__plays",
                attrs: { title: `Odtworzono ${item.play_count}×` }
              },
              icon("eye"),
              el("span", { text: item.play_count.toLocaleString("pl-PL") + "×" })
            )
          : null
      ),
      ["audio", "video"].includes(item.media_kind) ? ratingControl(item) : null,
      primary,
      footer
    );
  };

  const setPreviewActivity = (card: HTMLElement, active: boolean): void => {
    for (const visual of Array.from(card.querySelectorAll(".media-card__preview"))) {
      const state = previewStates.get(visual);
      if (state) state.visible = active;
      if (active) previewObserver?.observe(visual);
      else previewObserver?.unobserve(visual);
    }
  };

  const cardKey = (card: HTMLElement, fallback: number): string => card.dataset.windowKey ?? `card:${fallback}`;
  windowObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    if (gridWindowBusy) return;
    const target = entries.find((entry) => entry.isIntersecting)?.target;
    if (target instanceof HTMLButtonElement) target.click();
  }, { rootMargin: "700px 0px" }) : null;

  const drawGridWindow = (preserveKey = "", preserveTop = 0): void => {
    windowObserver?.disconnect();
    for (const card of Array.from(grid.querySelectorAll<HTMLElement>(".media-card"))) setPreviewActivity(card, false);
    if (gridCards.length === 0) {
      grid.replaceChildren(el("div", { className: "empty-state" }, el("p", { text: collectionId !== null ? "Ta kolekcja jest pusta." : "Brak pozycji w tym folderze." })));
      return;
    }
    const maxStart = Math.max(0, gridCards.length - gridWindowSize);
    gridWindowStart = Math.max(0, Math.min(gridWindowStart, maxStart));
    const end = Math.min(gridCards.length, gridWindowStart + gridWindowSize);
    const fragment = document.createDocumentFragment();
    let topControl: HTMLButtonElement | null = null;
    let bottomControl: HTMLButtonElement | null = null;
    if (gridWindowStart > 0) {
      topControl = el("button", {
        className: "media-grid__window-control",
        attrs: { type: "button" },
        text: `Pokaż wcześniejsze pozycje (${gridWindowStart.toLocaleString("pl-PL")})`
      });
      topControl.addEventListener("click", () => shiftGridWindow(Math.max(0, gridWindowStart - gridWindowStep)));
      fragment.append(topControl);
    }
    gridCards.slice(gridWindowStart, end).forEach((card) => {
      setPreviewActivity(card, true);
      fragment.append(card);
    });
    if (end < gridCards.length || hasMore) {
      bottomControl = el("button", {
        className: "media-grid__window-control",
        attrs: { type: "button" },
        text: end < gridCards.length ? t("Pokaż kolejne pozycje") : t("Wczytaj kolejną część katalogu")
      });
      bottomControl.addEventListener("click", () => {
        if (gridWindowBusy) return;
        if (end < gridCards.length) {
          shiftGridWindow(Math.min(maxStart, gridWindowStart + gridWindowStep));
          return;
        }
        if (!hasMore) return;
        gridWindowBusy = true;
        pageNumber += 1;
        void load(true).then(() => {
          gridWindowBusy = false;
          shiftGridWindow(Math.min(Math.max(0, gridCards.length - gridWindowSize), gridWindowStart + gridWindowStep));
        }).finally(() => {
          gridWindowBusy = false;
        });
      });
      fragment.append(bottomControl);
    }
    grid.replaceChildren(fragment);
    if (preserveKey) {
      window.requestAnimationFrame(() => {
        const anchor = Array.from(grid.querySelectorAll<HTMLElement>(".media-card")).find((card, index) => cardKey(card, index) === preserveKey);
        if (anchor) window.scrollBy({ top: anchor.getBoundingClientRect().top - preserveTop });
      });
    }
    if (topControl) windowObserver?.observe(topControl);
    if (bottomControl) windowObserver?.observe(bottomControl);
  };

  const shiftGridWindow = (nextStart: number): void => {
    if (nextStart === gridWindowStart) return;
    const overlapIndex = Math.max(gridWindowStart, nextStart);
    const anchorCard = gridCards[overlapIndex];
    const key = anchorCard ? cardKey(anchorCard, overlapIndex) : "";
    const visibleAnchor = key
      ? Array.from(grid.querySelectorAll<HTMLElement>(".media-card")).find((card, index) => cardKey(card, index) === key)
      : null;
    const top = visibleAnchor?.getBoundingClientRect().top ?? 0;
    gridWindowStart = nextStart;
    drawGridWindow(key, top);
  };

  const markCard = (card: HTMLElement, key: string): HTMLElement => {
    card.dataset.windowKey = key;
    return card;
  };

  const render = (data: LibraryPage, append: boolean): void => {
    directory = data.directory;
    directoryId = data.directory.id;
    hasMore = data.has_more;
    renderBreadcrumbs(data);
    const nextCards: HTMLElement[] = [];
    // "Wszystkie utwory" plays the whole folder, which contradicts a filtered view:
    // the listing would show only the lossless files while the card played them all.
    const showAllTracks = options.kind === "music"
      && data.directory.relative_path === ""
      && data.page === 1
      && data.query === ""
      && Object.keys(filters).length === 0;
    if (showAllTracks) {
      nextCards.push(markCard(createFolderCard({ ...data.directory, name: t("Wszystkie utwory") }, true), `all:${data.directory.id}`));
      for (const collection of [...availableCollections].sort((left, right) => left.name.localeCompare(right.name, "pl"))) {
        nextCards.push(markCard(createPlaylistCard(collection), `playlist:${collection.id}`));
      }
    }
    data.directories.forEach((folder) => nextCards.push(markCard(createFolderCard(folder), `folder:${folder.id}`)));
    data.items.forEach((item) => nextCards.push(markCard(createItemCard(item, data.directory.preview_media_item_id, data.directory.preview_kind), `item:${item.id}`)));
    if (append) gridCards.push(...nextCards);
    else {
      gridCards = nextCards;
      gridWindowStart = 0;
      selected.clear();
    }
    drawGridWindow();
    loadMore.classList.toggle("hidden", !hasMore);
    updateSummary();
  };

  /** What the grid is showing, so the queue follows the order on screen. */
  const collectionSortOptions = (): { sort: CollectionItemSort; shuffleSeed?: string } =>
    collectionSort === "random" ? { sort: "random", shuffleSeed: collectionSeed } : { sort: collectionSort };

  /**
   * Build a playlist's queue and hand it to the dock.
   *
   * Takes everything it needs as an argument instead of reading the page, so the
   * same code serves the open playlist and a card that was told to play without
   * being opened.
   */
  const playCollectionQueue = async (
    collection: CollectionQueueContext,
    startId?: number,
    autoplay = true
  ): Promise<void> => {
    if (!player || collection.items.length === 0) return;
    const activeCollectionId = collection.id;
    const shuffle = player.nextQueueShuffle();
    const sortOptions: { sort: CollectionItemSort; shuffleSeed?: string } = collection.sort === "random"
      ? { sort: "random", shuffleSeed: collection.seed }
      : { sort: collection.sort };
    let nextPage = collection.nextPage;
    let shuffledOffset = 0;
    const request = ++queueRequest;
    const loader = async (direction: "before" | "after") => {
      if (direction === "before") return { items: [], next_cursor: null, has_more: false, offset: 0, total: collection.total };
      const data = shuffle.mode === "off"
        ? await getCollection(activeCollectionId, nextPage, 100, sortOptions)
        : await getCollection(activeCollectionId, 1, 100, { sort: "random", shuffleSeed: shuffle.seed, offset: shuffledOffset });
      if (request !== queueRequest) throw new Error("stale collection queue request");
      if (shuffle.mode === "off") nextPage += 1;
      else shuffledOffset += data.items.length;
      return {
        items: data.items,
        next_cursor: data.items.at(-1)?.id ?? null,
        has_more: data.has_more,
        offset: data.offset,
        total: data.total
      };
    };
    const collectionGlobalLoader = shuffle.mode !== "off"
      ? async (offset: number) => {
          const data = await getCollection(activeCollectionId, 1, 100, { sort: "random", shuffleSeed: shuffle.seed, offset });
          if (request !== queueRequest) throw new Error("stale global collection queue request");
          return {
            items: data.items,
            next_cursor: data.items.at(-1)?.id ?? null,
            has_more: data.has_more,
            offset: data.offset,
            total: data.total
          };
        }
      : null;
    try {
      if (shuffle.mode === "off") {
        await player.setQueue([...collection.items], startId, autoplay, { offset: collection.offset, total: collection.total, context: `Playlista: ${collection.name}` });
        if (request !== queueRequest) return;
        player.setQueuePaging(loader, false, collection.hasMore);
      } else {
        const first = await loader("after");
        const current = startId ? collection.items.find((item) => item.id === startId) : undefined;
        const items = current
          ? [current, ...first.items.filter((item) => item.id !== current.id)]
          : first.items;
        if (items.length === 0) return;
        await player.setQueue(items, current?.id, autoplay, { offset: first.offset, total: first.total, context: `Playlista: ${collection.name}` });
        if (request !== queueRequest) return;
        player.setGlobalQueueLoader(collectionGlobalLoader);
      }
      // The source must be recorded even when the playlist was never opened:
      // without it a reload cannot rebuild the loaders, and shuffling silently
      // narrows to the one window the browser happens to be holding. It also
      // carries the list's display rules, so the dock keeps showing what its
      // author chose after the page has moved elsewhere.
      player.setQueueSource({
        kind: "collection",
        id: activeCollectionId,
        query: "",
        shuffleMode: shuffle.mode,
        shuffleSeed: shuffle.seed,
        // The order the list was queued in, so paging past the first hundred
        // tracks — here or on the device this queue is handed to — repeats it.
        collectionSort: collection.sort,
        queueRating: collection.queueRating,
        queueFavorite: collection.queueFavorite,
        ownerName: collection.ownerName
      });
      activeQueueCollection = collection;
      preparedQueueKey = collectionQueueKey(activeCollectionId, collection.sort, collection.seed);
    } catch {
      if (request === queueRequest) showMessage(t("Nie udało się odtworzyć playlisty."), true);
    }
  };

  /** The open playlist, as the queue builder wants it. */
  const openCollectionContext = (): CollectionQueueContext | null =>
    collectionId === null
      ? null
      : {
          id: collectionId,
          name: collectionName,
          ownerName: collectionOwnerName,
          queueRating: collectionQueueRating,
          queueFavorite: collectionQueueFavorite,
          sort: collectionSort,
          seed: collectionSeed,
          items: collectionQueue,
          offset: collectionOffset,
          total: collectionTotal,
          hasMore,
          nextPage: pageNumber + 1
        };

  const playCollection = async (startId?: number, autoplay = true): Promise<void> => {
    const collection = openCollectionContext();
    if (collection) await playCollectionQueue(collection, startId, autoplay);
  };

  /**
   * "Play" on a playlist card: queue the list and start it, without going in.
   *
   * Opening a playlist and playing it are two different wishes, and the card had
   * been treating them as one — pressing play walked into the list, which is
   * fine once and irritating every time after. Entering is what the thumbnail is
   * for. The first page has to be fetched here because the grid is showing a
   * folder, not this list.
   */
  const playCollectionCard = async (collection: UserCollection): Promise<void> => {
    if (!player) return;
    try {
      const sort: CollectionItemSort = collection.is_smart ? "title_asc" : "position";
      const data = await getCollection(collection.id, 1, 100, { sort });
      if (data.items.length === 0) {
        showMessage(t("Ta playlista jest pusta."), true);
        return;
      }
      await playCollectionQueue({
        id: data.collection.id,
        name: data.collection.name,
        ownerName: data.collection.owner_name,
        queueRating: data.collection.queue_rating,
        queueFavorite: data.collection.queue_favorite,
        sort: data.sort,
        seed: "",
        items: data.items,
        offset: data.offset,
        total: data.total,
        hasMore: data.has_more,
        nextPage: 2
      }, undefined, true);
    } catch {
      showMessage(t("Nie udało się odtworzyć playlisty."), true);
    }
  };

  /**
   * Move one loaded item up or down. The server swaps it with its neighbour by
   * position in a single O(1) operation, so this scales to collections of any
   * size without loading the whole list into the browser.
   */
  const moveCollectionItem = async (itemId: number, delta: -1 | 1): Promise<void> => {
    if (collectionId === null || reorderBusy) return;
    const index = collectionQueue.findIndex((item) => item.id === itemId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= collectionQueue.length) return;
    reorderBusy = true;
    try {
      await moveCollectionItemApi(collectionId, itemId, delta < 0 ? "up" : "down");
      [collectionQueue[index], collectionQueue[target]] = [collectionQueue[target]!, collectionQueue[index]!];
      [gridCards[index], gridCards[target]] = [gridCards[target]!, gridCards[index]!];
      drawGridWindow();
      clearMessage();
    } catch {
      showMessage(t("Nie udało się zmienić kolejności playlisty."), true);
    } finally {
      reorderBusy = false;
    }
  };

  const decorateCollectionCard = (card: HTMLElement, item: MediaItem): HTMLElement => {
    if (!collectionReorderable) return card;
    const up = el("button", { className: "icon-button media-reorder__up", attrs: { type: "button", "aria-label": t("Przenieś wyżej: {title}", { title: item.title }) } }, icon("chevron"));
    const down = el("button", { className: "icon-button media-reorder__down", attrs: { type: "button", "aria-label": t("Przenieś niżej: {title}", { title: item.title }) } }, icon("chevron"));
    up.dataset.tooltip = t("Przenieś wyżej");
    down.dataset.tooltip = t("Przenieś niżej");
    up.addEventListener("click", (event) => { event.stopPropagation(); void moveCollectionItem(item.id, -1); });
    down.addEventListener("click", (event) => { event.stopPropagation(); void moveCollectionItem(item.id, 1); });
    const footer = card.querySelector(".media-card__footer");
    const controls = el("div", { className: "media-reorder" }, up, down);
    if (footer) footer.append(controls);
    else card.append(el("div", { className: "media-card__footer" }, controls));
    return card;
  };

  const renderCollection = (data: CollectionPage, append: boolean): void => {
    if (data.collection.media_kind !== options.kind) throw new Error("collection kind mismatch");
    directory = null;
    directoryId = null;
    collectionName = data.collection.name;
    collectionOwnerName = data.collection.owner_name;
    collectionSmart = data.collection.is_smart;
    collectionOwned = data.collection.is_owned;
    collectionHasArtwork = data.collection.has_artwork;
    collectionQueueRating = data.collection.queue_rating;
    collectionQueueFavorite = data.collection.queue_favorite;
    // Opened straight from a link, a rule-based list can arrive with the manual
    // order still selected; the server answers in title order, so say so.
    if (collectionSmart && collectionSort === "position") collectionSort = "title_asc";
    collectionOffset = data.offset;
    collectionTotal = data.total;
    // Swapping neighbours only makes sense while the manual order is on screen.
    collectionReorderable = data.collection.is_owned && !data.collection.is_smart
      && canCreateCollections && collectionSort === "position";
    hasMore = data.has_more;
    if (append) {
      const known = new Set(collectionQueue.map((item) => item.id));
      const added = data.items.filter((item) => !known.has(item.id));
      collectionQueue.push(...added);
      gridCards.push(...added.map((item) => decorateCollectionCard(markCard(createItemCard(item, null, null), `item:${item.id}`), item)));
    } else {
      collectionQueue = [...data.items];
      gridCards = data.items.map((item) => decorateCollectionCard(markCard(createItemCard(item, null, null), `item:${item.id}`), item));
      gridWindowStart = 0;
      selected.clear();
      renderCollectionBreadcrumbs(data.collection);
    }
    syncToolbar();
    drawGridWindow();
    loadMore.classList.toggle("hidden", !hasMore);
    updateSummary();
  };
  const load = async (append: boolean): Promise<void> => {
    if (append && loading) return;
    const request = ++loadRequest;
    loading = true;
    loadMoreButton.disabled = true;
    clearMessage();
    try {
      if (collectionId !== null) {
        const data = await getCollection(collectionId, pageNumber, 100, collectionSortOptions());
        if (request !== loadRequest) return;
        renderCollection(data, append);
        // Opening a playlist prepares its queue but never starts it: walking in
        // is a look, not a decision to listen. Playing is the card's own button.
        if (!append && options.kind === "music" && player && !player.hasQueue()) {
          await playCollection(undefined, false);
        }
      } else {
        const data = await browseLibrary(options.kind, directoryId, searchText, pageNumber, 48, librarySort, randomSeed, filters);
        if (request !== loadRequest) return;
        filteredTotal = data.filtered_total;
        render(data, append);
        if (!append && options.kind === "music" && player && !preserveCollectionQueue) {
          const deepLinkItem = !consumedSharedPlay && Number.isSafeInteger(sharedPlayId)
            ? data.items.find((item) => item.id === sharedPlayId)
            : undefined;
          if (deepLinkItem) {
            consumedSharedPlay = true;
            await playDirectory(data.directory.id, deepLinkItem.id, deepLinkItem, true, data.query);
          } else if (!player.hasQueue()) {
            await playDirectory(data.directory.id, undefined, undefined, false, data.query);
          }
        }
        if (!append && options.kind === "movies" && !consumedSharedPlay && Number.isSafeInteger(sharedPlayId)) {
          const sharedItem = data.items.find((item) => item.id === sharedPlayId);
          if (sharedItem) {
            consumedSharedPlay = true;
            void viewer.open(sharedItem);
          }
        }
      }
    } catch {
      if (request === loadRequest) {
        showMessage(t("Nie udało się pobrać biblioteki. Sprawdź sesję i usługę stagingową."), true);
      }
    } finally {
      if (request === loadRequest) {
        loading = false;
        loadMoreButton.disabled = false;
      }
    }
  };
  playFolderButton.addEventListener("click", () => {
    if (!player) return;
    const key = collectionId !== null
      ? collectionQueueKey(collectionId, collectionSort, collectionSeed)
      : directory ? String(directory.id) + "|" + searchText : "";
    if (key !== "" && preparedQueueKey === key && player.currentItem()) {
      void player.playPrepared();
    } else if (collectionId !== null) {
      void playCollection(undefined, true);
    } else if (directory) {
      void playDirectory(directory.id);
    }
  });
  archiveButton.addEventListener("click", () => {
    // One button, one label, one request — whichever of the two views is open.
    const archiveRequest = collectionId !== null
      ? createCollectionArchive(collectionId, collectionName + ".zip")
      : !directory
        ? null
        : searchText
          ? createSearchArchive(options.kind, directory.id, searchText, "wyniki-" + searchText + ".zip")
          : createDirectoryArchive(options.kind, directory.id, directory.name + ".zip");
    if (!archiveRequest) return;
    archiveButton.disabled = true;
    const failure = collectionId !== null
      ? t("Playlista jest pusta albo przekracza limit 1000 plików ZIP.")
      : t("Folder jest pusty albo przekracza limit 1000 plików ZIP.");
    void archiveRequest
      .then(reportArchive)
      .catch((error) => showMessage(downloadFailureText(error, failure), true))
      .finally(() => { archiveButton.disabled = false; });
  });
  coverButton.addEventListener("click", () => openCoverDialog());
  selectedArchiveButton.addEventListener("click", () => {
    if (!selected.size) return;
    selectedArchiveButton.disabled = true;
    void createArchiveTransfer([...selected], options.archiveName)
      .then(reportArchive)
      .catch((error) => showMessage(downloadFailureText(error, t("Nie udało się przygotować archiwum wybranych plików.")), true))
      .finally(updateSummary);
  });
  loadMoreButton.addEventListener("click", () => {
    if (!hasMore) return;
    pageNumber += 1;
    void load(true);
  });
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchText = search.value.trim();
      syncToolbar();
      pageNumber = 1;
      void load(false);
    }, 250);
  });

  /**
   * Fill the picture filters from what the catalogue actually holds, so a select
   * never offers a codec nobody owns. Films only, and only once the ffprobe pass
   * has produced something to filter on.
   */
  const mountFilters = async (): Promise<void> => {
    const available = await getLibraryFilters(options.kind).catch(() => null);
    if (!available || available.probed === 0 || disposed) return;
    const option = (value: string, label: string): HTMLOptionElement =>
      el("option", { text: label, attrs: { value } });
    const count = (value: number): string => value.toLocaleString("pl-PL");
    // Each library reveals its own controls; the others stay out of the bar.
    // Genre and decade join the film bar only when a lookup has actually filled
    // them in; on a library that has never run one they would be empty selects.
    const storyControls: HTMLSelectElement[] = [];
    const storyNames: string[] = [];
    if ((available.genres ?? []).length > 0) {
      storyControls.push(genreFilter);
      storyNames.push("genre");
    }
    if ((available.decades ?? []).length > 0) {
      storyControls.push(decadeFilter);
      storyNames.push("decade");
    }
    const musicStory = (available.tag_genres ?? []).length > 0 ? [tagGenreFilter] : [];
    const musicStoryNames = (available.tag_genres ?? []).length > 0 ? ["tag_genre"] : [];
    if ((available.decades ?? []).length > 0) {
      musicStory.push(decadeFilter);
      musicStoryNames.push("decade");
    }
    const controls = options.kind === "music"
      ? [formatFilter, qualityFilter, hiresFilter, ...musicStory]
      : [resolutionFilter, hdrFilter, videoCodecFilter, audioCodecFilter, ...storyControls];
    const names = options.kind === "music"
      ? ["format", "quality", "hires", ...musicStoryNames]
      : ["resolution", "hdr", "video_codec", "audio_codec", ...storyNames];
    for (const control of controls) control.closest(".library-filter__field")?.classList.remove("hidden");
    if (options.kind === "music") {
      formatFilter.replaceChildren(
        option("", t("Wszystkie")),
        ...(available.formats ?? []).map((format) =>
          option(format.value, `${format.value.toUpperCase()} (${count(format.count)})`))
      );
      const quality = available.quality ?? { lossless: 0, high: 0, standard: 0 };
      qualityFilter.replaceChildren(
        option("", t("Wszystkie")),
        ...(quality.lossless > 0 ? [option("lossless", `Bezstratne (${count(quality.lossless)})`)] : []),
        ...(quality.high > 0 ? [option("high", `Od 320 kb/s (${count(quality.high)})`)] : []),
        ...(quality.standard > 0 ? [option("standard", `Poniżej 320 kb/s (${count(quality.standard)})`)] : [])
      );
      hiresFilter.replaceChildren(
        option("", t("Wszystkie")),
        option("yes", `Od 88,2 kHz (${count(available.hires ?? 0)})`),
        option("no", t("Do 48 kHz"))
      );
      tagGenreFilter.replaceChildren(
        option("", t("Wszystkie")),
        // The tag's own spelling, so it is not put through t(): "Nu Metal" is
        // what somebody typed into the file, not a word this interface owns.
        ...(available.tag_genres ?? []).map((genre) => option(genre.value, `${genre.value} (${count(genre.count)})`)),
        ...(available.unidentified ? [option("none", `${t("Bez gatunku")} (${count(available.unidentified)})`)] : [])
      );
      decadeFilter.replaceChildren(
        option("", t("Wszystkie")),
        ...(available.decades ?? []).map((entry) => option(String(entry.decade), `${entry.decade}s (${count(entry.count)})`))
      );
      tagGenreFilter.value = route.get("tag_genre") ?? "";
      decadeFilter.value = route.get("decade") ?? "";
      for (const name of names) {
        const control = name === "format" ? formatFilter : name === "quality" ? qualityFilter : hiresFilter;
        control.value = route.get(name) ?? "";
      }
      filterBar.classList.remove("hidden");
      wireFilters(controls, names);
      return;
    }
    // The buckets the server counts are exclusive, the filter is "this or better",
    // so the numbers shown add up from the top.
    let atLeast = 0;
    resolutionFilter.replaceChildren(option("", t("Wszystkie")));
    for (const [value, label] of resolutionLabels()) {
      atLeast += available.resolutions[value] ?? 0;
      if (atLeast > 0) resolutionFilter.append(option(value, `${label} (${atLeast.toLocaleString("pl-PL")})`));
    }
    hdrFilter.replaceChildren(
      option("", t("Wszystkie")),
      option("yes", `Tylko HDR (${available.hdr.toLocaleString("pl-PL")})`),
      option("no", t("Bez HDR"))
    );
    videoCodecFilter.replaceChildren(
      option("", t("Wszystkie")),
      ...available.video_codecs.map((codec) => option(codec.value, `${codec.value} (${codec.count.toLocaleString("pl-PL")})`))
    );
    audioCodecFilter.replaceChildren(
      option("", t("Wszystkie")),
      ...available.audio_codecs.map((codec) => option(codec.value, `${codec.value} (${codec.count.toLocaleString("pl-PL")})`))
    );
    genreFilter.replaceChildren(
      option("", t("Wszystkie")),
      // The dictionary carries both spellings, so switching language does not
      // ask the server again.
      ...(available.genres ?? []).map((genre) =>
        option(genre.slug, `${t(genre.name_pl)} (${count(genre.count)})`)),
      // "What has the lookup not managed to identify?" — a real question with a
      // real answer, and the only way to see those files as a group.
      ...(available.unidentified ? [option("none", `${t("Bez gatunku")} (${count(available.unidentified)})`)] : [])
    );
    decadeFilter.replaceChildren(
      option("", t("Wszystkie")),
      ...(available.decades ?? []).map((entry) =>
        option(String(entry.decade), `${entry.decade}s (${count(entry.count)})`))
    );
    // A filtered address is shareable, like a search or a folder.
    resolutionFilter.value = route.get("resolution") ?? "";
    hdrFilter.value = route.get("hdr") ?? "";
    videoCodecFilter.value = route.get("video_codec") ?? "";
    audioCodecFilter.value = route.get("audio_codec") ?? "";
    genreFilter.value = route.get("genre") ?? "";
    decadeFilter.value = route.get("decade") ?? "";
    filterBar.classList.remove("hidden");
    wireFilters(controls, names);
  };

  /**
   * Hang the shared behaviour on whichever controls this library revealed:
   * changing one reloads the listing, the address carries the choice so a
   * filtered view can be sent on, and "clear" empties exactly these controls.
   */
  const wireFilters = (controls: HTMLSelectElement[], names: string[]): void => {
    const applyFilters = (): void => {
      filters = readFilters();
      const active = Object.keys(filters).length > 0;
      clearFilters.classList.toggle("hidden", !active);
      filterBar.classList.toggle("is-active", active);
      const url = new URL(window.location.href);
      for (const name of names) url.searchParams.delete(name);
      for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
      window.history.replaceState({}, "", url);
      pageNumber = 1;
      void load(false);
    };
    for (const control of controls) control.addEventListener("change", applyFilters);
    clearFilters.addEventListener("click", () => {
      for (const control of controls) control.value = "";
      applyFilters();
    });
    filters = readFilters();
    const active = Object.keys(filters).length > 0;
    clearFilters.classList.toggle("hidden", !active);
    filterBar.classList.toggle("is-active", active);
    if (active) void load(false);
  };

  await load(false);
  void mountFilters();
}
