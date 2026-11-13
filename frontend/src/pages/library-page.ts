import {
  isAborted,
  browseLibrary,
  collectionExportUrl,
  createArchiveTransfer,
  createCollectionArchive,
  createDirectoryArchive,
  createSearchArchive,
  getCollection,
  getCollections,
  getQueuePage,
  moveCollectionItem as moveCollectionItemApi
} from "../shared/api";
import { appUrl } from "../shared/config";
import { arrive, el } from "../shared/dom";
import { formatBytes, formatCount } from "../shared/format";
import { icon } from "../shared/icons";
import { t, tn } from "../shared/i18n";
import { MediaViewer } from "../shared/media-viewer";
import { collectionQueueKey, positiveId } from "../shared/library-labels";
import { can, canAccessLibrary, canEditMetadata } from "../shared/permissions";
import { findInPages } from "../shared/player-state";
import { queueModeFallback } from "../shared/queue-loaders";
import { randomId } from "../shared/random-id";
import { mountShell, openMetadataEditor } from "../shared/shell";
import type { ArchiveTransfer, CollectionItemSort, CollectionPage, CollectionQueueFavorite, CollectionQueueRating, LibraryDirectory, LibraryKind, LibraryPage, LibrarySort, MediaItem, UserCollection } from "../shared/types";
import { folderCard, itemCard, playlistCard, type CardContext } from "./library/cards";
import { createCollectionPicker } from "./library/collection-picker";
import { createCoverDialog } from "./library/cover-dialog";
import { createLibraryFilters } from "./library/filters";
import { createGridWindow, markCard } from "./library/grid-window";
import { createPreviews } from "./library/previews";
import { downloadFailureText, submitArchive } from "./library/transfers";

export interface PageOptions {
  kind: LibraryKind;
  title: string;
  eyebrow: string;
  archiveName: string;
}

const LIBRARY_SORTS: LibrarySort[] =
  ["title_asc", "title_desc", "plays_desc", "rating_desc", "rating_count_desc", "size_desc", "duration_desc", "duration_asc", "random"];

/**
 * Orders offered inside a playlist.
 *
 * A playlist holds tracks, not folders, so the library's folder shuffle and
 * "largest first" are not offered here; the manual order is, but only on a list
 * the owner arranged by hand.
 */
const COLLECTION_SORTS: CollectionItemSort[] =
  ["position", "title_asc", "title_desc", "own_rating_desc", "rating_desc", "plays_desc", "added_desc", "random"];

/**
 * How many playlist pages (100 rows each) turning shuffle off reads to find the
 * track that is playing. Past that the track stays at the head of the queue.
 */
const LOCATE_PAGES = 10;

/** Seed for the random folder order: stable while paging, replaced by "shuffle again". */
function freshRandomSeed(): string {
  return randomId();
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
  /** Computed from rules rather than put together by hand — the dock says which. */
  smart: boolean;
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
  let disposed = false;
  /** The listing request in flight; a newer one, or leaving the page, gives it up. */
  let loadAbort: AbortController | null = null;
  /** Everything this page hangs on the document; gone with the page. */
  const pageEvents = new AbortController();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    previews.dispose();
    gridWindow.dispose();
    collectionPicker.dispose();
    coverDialog.dispose();
    loadAbort?.abort();
    pageEvents.abort();
    void viewer.destroy();
  };
  document.addEventListener("media:route-will-change", dispose, { once: true });
  const selected = new Set<number>();
  const route = new URLSearchParams(window.location.search);
  /** This library's own address; history entries under it are the page's to answer (see the popstate handler). */
  const libraryPath = window.location.pathname;
  let collectionId = positiveId(route.get("collection"));
  const initialQuery = collectionId === null ? (route.get("q") ?? "").trim().slice(0, 200) : "";
  const initialDirectoryId = positiveId(route.get("directory"));
  const sharedPlayId = Number(route.get("play"));
  let consumedSharedPlay = false;
  let availableCollections: UserCollection[] = [];
  // Asked for at once and waited for by the first listing, so the two requests
  // travel together. It used to be awaited here, alone, before the listing was
  // even asked for: one round trip of blank page on every visit.
  const collectionsReady: Promise<void> = canCreateCollections || can(shell.session, "can_browse_collections")
    ? getCollections(options.kind).then((list) => { availableCollections = list; }).catch(() => undefined)
    : Promise.resolve();
  // "Add to a playlist": the dialog a card, or the dock, opens (library/collection-picker.ts).
  const collectionPicker = createCollectionPicker({
    kind: options.kind,
    collections: () => availableCollections,
    onCollections: (list) => { availableCollections = list; },
    ready: collectionsReady
  });
  player.setCollectionHandler(canCreateCollections ? (item) => collectionPicker.open(item) : null);


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
  /** The library's top folder, learned from the first listing: what "back to the library" opens. */
  let rootDirectoryId: number | null = null;
  /**
   * The next listing is a new place (the first paint, a folder walked into, a
   * playlist opened) rather than the same place drawn again (a search, a sort,
   * a filter): it gets placeholders while it loads and arrives with the stagger.
   */
  let newPlace = true;
  /**
   * Two tokens, because a queue build has two moments that can go stale.
   *
   * `queueRequest` is the latest build asked for: a build still waiting for its
   * first page gives up when a newer one starts. `installedQueue` is the build
   * whose queue the player holds, and its loaders stay good until another build
   * *replaces* it. One token used to do both jobs, so starting a build killed the
   * loaders of the queue that was still playing: if the new build then failed or
   * found an empty folder, the old queue played out its loaded window and stopped,
   * and even a build that succeeded left a gap in which the current track could
   * not move on.
   */
  let queueRequest = 0;
  let installedQueue = 0;
  const queueIsLive = (request: number): boolean => request === installedQueue || request === queueRequest;
  /** Builds under way. The play button waits for all of them, not for whichever started last. */
  let queueBuilds = 0;
  let loadRequest = 0;
  let preparedQueueKey = "";
  let activeQueueDirectoryId: number | null = null;
  let activeQueueQuery = "";
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
  // The row of selects above the grid (library/filters.ts): which ones, filled
  // with what, and the address that carries the choice.
  const filterBar = createLibraryFilters({
    kind: options.kind,
    route,
    holdRoom: collectionId === null,
    shouldRemember: () => collectionId === null,
    onChange: () => {
      pageNumber = 1;
      void load(false);
    },
    isGone: () => disposed
  });
  let filteredTotal: number | null = null;

  const feedback = el("div", { className: "hidden", attrs: { role: "status", "aria-live": "polite" } });
  const grid = el("section", {
    className: "media-grid " + (options.kind === "movies" ? "media-grid--movies" : "media-grid--music"),
    attrs: { "aria-label": t(options.title) }
  });
  const loadMoreButton = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("Załaduj więcej"));
  const loadMore = el("div", { className: "load-more hidden" }, loadMoreButton);
  // The label lives in its own span: querySelector("span") would find the icon
  // wrapper first and paint the text on top of the real label.
  const playLabel = el("span", { className: "library-toolbar__play-label", text: t("Odtwórz folder") });
  const playFolderButton = el(
    "button",
    { className: "button button--primary", attrs: { type: "button" } },
    icon("play"),
    playLabel,
    // What a narrow phone shows instead of the whole phrase (styles/pages.css); the
    // button's name, for a screen reader, stays the phrase.
    el("span", { className: "library-toolbar__play-short", text: t("Odtwórz"), attrs: { "aria-hidden": "true" } })
  );
  // Every build that disables the button gives it back in its own `finally`.
  // Re-enabling it only when the finishing build was the latest left it disabled
  // for good whenever a playlist build overtook a folder build: the playlist
  // never touched the button, and the folder build was no longer the latest.
  const queueBuildStarted = (): void => {
    queueBuilds += 1;
    playFolderButton.disabled = true;
  };
  const queueBuildEnded = (): void => {
    queueBuilds = Math.max(0, queueBuilds - 1);
    playFolderButton.disabled = queueBuilds > 0;
  };
  const archiveLabel = el("span", { text: t("Pobierz folder") });
  const archiveButton = el(
    "button",
    { className: "button button--secondary", attrs: { type: "button" } },
    icon("archive"),
    archiveLabel
  );
  const selectedArchiveButton = el(
    "button",
    { className: "button button--secondary library-toolbar__selected", attrs: { type: "button", disabled: true } },
    icon("check"),
    el("span", { text: t("Pobierz wybrane") })
  );
  // Shown once something is ticked (updateSummary); until then it is not in the row at all.
  selectedArchiveButton.classList.add("hidden");
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
  // What is done to the whole folder or playlist, and rarely: on a wide screen
  // these sit in the row, on a phone behind one "more" button. Spread out they
  // made four rows of buttons there — the first card of a library began past the
  // middle of the screen.
  const moreMenu = el("div", { className: "library-toolbar__more", attrs: { id: `library-more-${options.kind}` } },
    coverButton, exportLink, archiveButton);
  const moreToggle = el(
    "button",
    {
      className: "icon-button library-toolbar__more-toggle",
      attrs: { type: "button", "aria-label": t("Więcej działań"), "aria-expanded": "false", "aria-controls": moreMenu.id }
    },
    icon("more")
  );
  const setMoreMenu = (open: boolean): void => {
    moreMenu.dataset.open = String(open);
    moreToggle.setAttribute("aria-expanded", String(open));
  };
  moreToggle.addEventListener("click", () => setMoreMenu(moreMenu.dataset.open !== "true"));
  // Chosen, or anything else pressed: the menu has done its job.
  moreMenu.addEventListener("click", () => setMoreMenu(false));
  document.addEventListener("pointerdown", (event) => {
    if (moreMenu.dataset.open !== "true" || !(event.target instanceof Node)) return;
    if (!moreMenu.contains(event.target) && !moreToggle.contains(event.target)) setMoreMenu(false);
  }, { signal: pageEvents.signal });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || moreMenu.dataset.open !== "true") return;
    setMoreMenu(false);
    moreToggle.focus();
  }, { signal: pageEvents.signal });
  shell.content.append(
    breadcrumbs,
    el(
      "div",
      { className: "library-toolbar" },
      summary,
      el("div", { className: "library-toolbar__actions" }, sortSelect, filterBar.toggle, collectionSortSelect, reshuffleButton, playFolderButton, selectedArchiveButton, moreToggle, moreMenu)
    ),
    filterBar.wrapper,
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
      : searchText ? t("Pobierz wyniki") : t("Pobierz folder");
    coverButton.classList.toggle("hidden", !(inCollection && collectionOwned && canCreateCollections));
    // Exporting is reading a list you can already see, so it needs no download
    // right: the file carries identifiers and titles, never the media.
    exportLink.classList.toggle("hidden", !inCollection || collectionId === null);
    if (inCollection && collectionId !== null) exportLink.href = collectionExportUrl(collectionId, "m3u");
    // A manual order exists only on a hand-arranged list.
    collectionPositionOption.classList.toggle("hidden", collectionSmart);
    collectionPositionOption.disabled = collectionSmart;
    collectionSortSelect.value = collectionSort;
    // "More" is offered only while it has something in it.
    const anyMore = [coverButton, exportLink, archiveButton].some((control) => !control.classList.contains("hidden"));
    moreToggle.classList.toggle("hidden", !anyMore);
    if (!anyMore) setMoreMenu(false);
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
        tn(transfer.count, {
          one: "Pobieranie {count} pliku. Pominięto {skipped} — Twoja grupa nie może pobierać tych rozszerzeń.",
          few: "Pobieranie {count} plików. Pominięto {skipped} — Twoja grupa nie może pobierać tych rozszerzeń.",
          many: "Pobieranie {count} plików. Pominięto {skipped} — Twoja grupa nie może pobierać tych rozszerzeń."
        }, { skipped: formatCount(transfer.skipped) })
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
  /** A listing that did not come: say so, and offer the one thing that helps. */
  const showLoadFailure = (): void => {
    const retry = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("refresh"), t("Spróbuj ponownie"));
    retry.addEventListener("click", () => void load(false));
    feedback.className = "notice notice--error notice--action";
    feedback.replaceChildren(el("span", { text: t("Nie udało się pobrać biblioteki.") }), retry);
  };
  /** Placeholders in the shape of what is coming, so the page does not jump when it does. */
  const drawSkeleton = (): void => {
    grid.setAttribute("aria-busy", "true");
    grid.replaceChildren(...Array.from({ length: 12 }, () => el(
      "div",
      { className: "media-card media-card--skeleton", attrs: { "aria-hidden": "true" } },
      el("div", { className: "media-card__preview skeleton" }),
      el("div", { className: "media-card__body" }, el("span", { className: "skeleton skeleton--line" }), el("span", { className: "skeleton skeleton--line skeleton--short" }))
    )));
  };
  const updateSummary = (): void => {
    if (selected.size > 0) summary.textContent = t("Wybrano: ") + selected.size;
    else if (filteredTotal !== null) {
      // Counted by the server across the whole subtree, not by how many cards
      // happen to be loaded.
      summary.textContent = tn(filteredTotal, {
        one: "{count} pozycja pasuje do filtrów",
        few: "{count} pozycje pasują do filtrów",
        many: "{count} pozycji pasuje do filtrów"
      });
    } else if (collectionId !== null) {
      // The size of the playlist, counted by the server — not the length of the
      // window that happens to be loaded, which grew with every "load more".
      summary.textContent = tn(collectionTotal, { one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji" })
        + (collectionSmart ? " · " + t("lista inteligentna") : "");
    } else if (directory) {
      summary.textContent = tn(directory.descendant_file_count, {
        one: "{count} plik · {size}",
        few: "{count} pliki · {size}",
        many: "{count} plików · {size}"
      }, { size: formatBytes(directory.total_size_bytes) });
    }
    selectedArchiveButton.disabled = selected.size === 0;
    // There when there is something to download, out of the row when there is not.
    selectedArchiveButton.classList.toggle("hidden", !canDownloadSelection || selected.size === 0);
  };

  /**
   * Put the folder on screen away for later (a bounded LRU of retained card DOM;
   * a long browsing session would otherwise pin every visited directory's nodes
   * in memory for good). Coming back to it — by the breadcrumbs or the browser's
   * Back — then costs nothing and lands on the same scroll position.
   */
  const rememberDirectory = (): void => {
    if (!directory || collectionId !== null) return;
    directorySnapshots.delete(directory.id);
    directorySnapshots.set(directory.id, {
      directory,
      breadcrumbs: [...currentBreadcrumbs],
      pageNumber,
      hasMore,
      searchText,
      gridCards: [...gridWindow.cards],
      gridWindowStart: gridWindow.start,
      scrollY: window.scrollY
    });
    while (directorySnapshots.size > 8) {
      directorySnapshots.delete(directorySnapshots.keys().next().value!);
    }
  };

  /**
   * Write the place on screen into the address, as a new history entry.
   *
   * Folders had none: walking three folders deep and pressing Back left the
   * library altogether, and a reload returned to its top. A playlist already
   * pushed its own entry; folders now do the same. The filters stay in the
   * address of a folder (they are part of that view) and are dropped from a
   * playlist's (they do not apply there).
   */
  const recordPlace = (place: { directory?: number | null; collection?: number }): void => {
    const url = new URL(window.location.href);
    if (place.collection) url.search = "";
    for (const name of ["directory", "collection", "q", "play"]) url.searchParams.delete(name);
    if (place.collection) url.searchParams.set("collection", String(place.collection));
    else if (place.directory && place.directory !== rootDirectoryId) url.searchParams.set("directory", String(place.directory));
    url.hash = "";
    if (url.href !== window.location.href) window.history.pushState({}, "", url);
  };

  const navigate = async (nextDirectoryId: number, record = true): Promise<void> => {
    if (directory && directory.id !== nextDirectoryId) rememberDirectory();
    if (record) recordPlace({ directory: nextDirectoryId });
    const snapshot = directorySnapshots.get(nextDirectoryId);
    if (snapshot) {
      // Whatever is still loading belongs to the folder being left. Without this
      // its answer could arrive after the snapshot was drawn and replace it: open
      // a folder, click back up the breadcrumbs while it loads, and land in the
      // folder you just left.
      loadRequest += 1;
      loading = false;
      directoryId = snapshot.directory.id;
      directory = snapshot.directory;
      pageNumber = snapshot.pageNumber;
      hasMore = snapshot.hasMore;
      searchText = snapshot.searchText;
      search.value = snapshot.searchText;
      syncToolbar();
      gridWindow.cards = [...snapshot.gridCards];
      gridWindow.start = snapshot.gridWindowStart;
      renderBreadcrumbs({ breadcrumbs: snapshot.breadcrumbs });
      // Kept from before: what is playing may have changed since.
      markPlaying(player.currentItem()?.id ?? null);
      gridWindow.draw();
      loadMore.classList.toggle("hidden", !hasMore);
      updateSummary();
      window.requestAnimationFrame(() => window.scrollTo({ top: snapshot.scrollY, behavior: "auto" }));
      return;
    }
    directoryId = nextDirectoryId;
    pageNumber = 1;
    selected.clear();
    newPlace = true;
    await load(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const renderBreadcrumbs = (page: Pick<LibraryPage, "breadcrumbs">): void => {
    currentBreadcrumbs = [...page.breadcrumbs];
    rootDirectoryId = page.breadcrumbs[0]?.id ?? rootDirectoryId;
    const fragment = document.createDocumentFragment();
    page.breadcrumbs.forEach((crumb, index) => {
      // The first crumb is the library itself, and it has a name in the reader's
      // language; the folder on disk is called whatever it was called ("Music").
      const button = el("button", { attrs: { type: "button" }, text: index === 0 ? t(options.title) : crumb.name });
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
    const library = el("button", { attrs: { type: "button" }, text: t(options.title) });
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

  /**
   * Open a playlist as a view of this library, without leaving the page.
   * `known` is what a card already says about it; the listing fills in the rest
   * (and all of it when the playlist is reached by the browser's Back or Forward).
   */
  const openCollection = (id: number, known: UserCollection | null, record: boolean): void => {
    rememberDirectory();
    collectionId = id;
    collectionName = known?.name ?? "";
    collectionSmart = known?.is_smart ?? false;
    collectionOwned = known?.is_owned ?? false;
    collectionTotal = known?.item_count ?? 0;
    if (collectionSmart && collectionSort === "position") collectionSort = "title_asc";
    pageNumber = 1;
    selected.clear();
    search.value = "";
    searchText = "";
    newPlace = true;
    syncToolbar();
    if (record) recordPlace({ collection: id });
    void load(false).then(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  };
  const enterCollection = (collection: UserCollection): void => openCollection(collection.id, collection, true);

  /**
   * Back to browsing folders; whatever the playlist is playing keeps playing.
   * `target` is the folder to show — the library's top unless Back named one.
   */
  const leaveCollection = async (target: number | null = null, record = true): Promise<void> => {
    if (collectionId === null) return;
    collectionId = null;
    collectionName = "";
    collectionSmart = false;
    collectionOwned = false;
    collectionQueue = [];
    collectionTotal = 0;
    selected.clear();
    searchText = "";
    search.value = "";
    syncToolbar();
    const folder = target ?? rootDirectoryId;
    if (folder !== null) {
      await navigate(folder, record);
      return;
    }
    // Opened straight on a playlist: the library's top folder is not known yet.
    if (record) recordPlace({});
    directoryId = null;
    pageNumber = 1;
    newPlace = true;
    await load(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Back and Forward inside this library. The router asks first
  // (`media:popstate`); an address under this page's own path is answered here,
  // by showing the folder or playlist it names — out of the retained cards when
  // they are still held — instead of mounting the whole page again.
  document.addEventListener("media:popstate", (event) => {
    if (window.location.pathname !== libraryPath) return;
    event.preventDefault();
    const address = new URLSearchParams(window.location.search);
    const wantedCollection = positiveId(address.get("collection"));
    const wantedDirectory = positiveId(address.get("directory"));
    if (wantedCollection !== null) {
      if (collectionId !== wantedCollection) openCollection(wantedCollection, null, false);
      return;
    }
    if (collectionId !== null) {
      void leaveCollection(wantedDirectory, false);
      return;
    }
    const folder = wantedDirectory ?? rootDirectoryId;
    if (folder !== null && directory?.id !== folder) void navigate(folder, false);
  }, { signal: pageEvents.signal });

  // The open playlist's own cover (library/cover-dialog.ts); saved, the listing is drawn again.
  const coverDialog = createCoverDialog(() => {
    pageNumber = 1;
    return load(false);
  });

  // The pictures on the cards: lazy, falling back along their candidates, a folder's turning over.
  const previews = createPreviews();

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
    queueBuildStarted();
    // What the dock names as the source: the query, the folder, or nothing for
    // the library root (which it calls the whole library).
    const sourceLabel = queueQuery || directoryLabel || (directory?.relative_path ? directory.name : "");
    const context = queueQuery
      ? t("Wyniki wyszukiwania: \u201e{query}\u201d", { query: queueQuery })
      : sourceLabel
        ? t("Folder: {name}", { name: sourceLabel })
        : t("Wszystkie utwory");
    const loader = async (direction: "before" | "after", cursor: number) => {
      if (shuffle.mode === "off") {
        const page = await getQueuePage(targetDirectoryId, cursor, 160, direction, queueQuery);
        if (!queueIsLive(request)) throw new Error("stale queue request");
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
      if (!queueIsLive(request)) throw new Error("stale queue request");
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
          if (!queueIsLive(request)) throw new Error("stale global queue request");
          return page;
        }
      : null;
    try {
      if (immediateItem && shuffle.mode === "off") {
        // The queue changes hands here, synchronously, inside setQueue: from now
        // on this build's loaders are the live ones.
        installedQueue = request;
        await player.setQueue([immediateItem], immediateItem.id, autoplay, { offset: 0, total: 1, context });
        if (installedQueue !== request) return;
        player.setQueuePaging(loader, true, true);
        player.setQueueSource({
          kind: "directory",
          id: targetDirectoryId,
          query: queueQuery,
          shuffleMode: "off",
          shuffleSeed: "",
          label: sourceLabel
        });
        void player.prefetchAfter();
        preparedQueueKey = String(targetDirectoryId) + "|" + queueQuery;
        clearMessage();
        activeQueueDirectoryId = targetDirectoryId;
        activeQueueQuery = queueQuery;
        activeQueueCollection = null;
        return;
      }

      const first = await loader("after", 0);
      if (request !== queueRequest) return;
      const items = immediateItem
        ? [immediateItem, ...first.items.filter((item) => item.id !== immediateItem.id)]
        : first.items;
      if (items.length === 0) {
        // Nothing replaced the queue that is playing, so its loaders stay live.
        showMessage(t("Ten folder nie zawiera utworów."), true);
        return;
      }
      installedQueue = request;
      await player.setQueue(items, startId ?? immediateItem?.id, autoplay, { offset: first.offset, total: first.total, context });
      // A newer build that is still fetching does not stop this one: the player
      // holds this queue now, and a queue without its loaders and source is the
      // narrowing this code exists to prevent. Only a queue installed after it does.
      if (installedQueue !== request) return;
      player.setGlobalQueueLoader(globalLoader);
      if (!globalLoader) player.setQueuePaging(loader, false, first.has_more);
      // Remembered so a page reload can rebuild these loaders; without it the
      // restored session could only shuffle inside the window it had cached.
      player.setQueueSource({
        kind: "directory",
        id: targetDirectoryId,
        query: queueQuery,
        shuffleMode: shuffle.mode,
        shuffleSeed: shuffle.seed,
        label: sourceLabel
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
      queueBuildEnded();
    }
  };

  if (options.kind === "music") {
    // Rebuilds what is *playing*, never just what is on screen. The open playlist
    // used to win: browse list B while list A played, press shuffle — or let A
    // reach its end — and B started. A queue this page did not build (it was
    // restored after a reload, or started elsewhere) is rebuilt from the source
    // the player remembers.
    const rebuildFromSource = queueModeFallback(player);
    player?.setQueueModeChangeHandler(async (preserveCurrent) => {
      const resumeId = preserveCurrent ? player.currentItem()?.id : undefined;
      const autoplay = preserveCurrent ? player.isPlaying() : true;
      if (activeQueueCollection) {
        await playCollectionQueue(activeQueueCollection, resumeId, autoplay);
        return;
      }
      if (activeQueueDirectoryId !== null) {
        const current = preserveCurrent ? player.currentItem() : null;
        await playDirectory(activeQueueDirectoryId, current?.id, current ?? undefined, autoplay, activeQueueQuery);
        return;
      }
      if (player.queueSourceInfo()) {
        await rebuildFromSource(preserveCurrent);
        return;
      }
      if (collectionId !== null) {
        await playCollection(resumeId, autoplay);
        return;
      }
      if (directory) await playDirectory(directory.id, undefined, undefined, autoplay, activeQueueQuery);
    });
  }

  /** What the cards (library/cards.ts) need of this page: its rights, its state and what a press means here. */
  const cards: CardContext = {
    kind: options.kind,
    rights: {
      downloadFile: canDownloadFile,
      downloadSelection: canDownloadSelection,
      downloadFolder: canDownloadFolder,
      rate: canRate,
      favorite: canFavorite,
      collections: canCreateCollections,
      share: canShare,
      editTags: canEditTags,
      guestLinks: guestLinksOn
    },
    previews,
    player,
    selected,
    selectionChanged: () => updateSummary(),
    showMessage: (text, error) => showMessage(text, error),
    reportArchive: (transfer) => reportArchive(transfer),
    openFolder: (folder) => void navigate(folder.id),
    playFolder: (folder) => void playDirectory(folder.id, undefined, undefined, true, searchText, folder.name),
    enterCollection: (collection) => enterCollection(collection),
    playCollection: (collection) => playCollectionCard(collection),
    openItem: (item) => {
      if (item.media_kind === "audio" && collectionId !== null) void playCollection(item.id, true);
      else if (item.media_kind === "audio" && directory) void playDirectory(directory.id, item.id, item);
      else void viewer.open(item);
    },
    addToCollection: (item) => collectionPicker.open(item),
    editTags: (item) => openMetadataEditor(item),
    currentDirectoryId: () => directory?.id ?? null,
    moveItem: (item, delta) => void moveCollectionItem(item.id, delta)
  };

  // Which of the listing's cards are on the page (library/grid-window.ts).
  const gridWindow = createGridWindow({
    grid,
    previews,
    emptyText: () => (collectionId !== null ? t("Ta kolekcja jest pusta.") : t("Brak pozycji w tym folderze.")),
    hasMore: () => hasMore,
    loadNextPage: () => {
      pageNumber += 1;
      return load(true);
    }
  });

  /** The card of the track that is playing says so: three bars over its cover (styles/cards.css). */
  const markPlaying = (id: number | null): void => {
    for (const card of gridWindow.cards) card.classList.toggle("is-playing", id !== null && card.dataset.mediaId === String(id));
  };
  document.addEventListener("media:track-changed", (event) => {
    markPlaying((event as CustomEvent<{ id?: number }>).detail?.id ?? null);
  }, { signal: pageEvents.signal });

  /**
   * Cards that joined a listing already on screen ("load more", the window
   * reaching its end) fade in and nothing more: the stagger is for a new place.
   */
  const markAppended = (added: HTMLElement[]): void => {
    for (const card of added) card.dataset.appended = "true";
    window.setTimeout(() => { for (const card of added) delete card.dataset.appended; }, 400);
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
      && Object.keys(filterBar.current()).length === 0;
    if (showAllTracks) {
      nextCards.push(markCard(folderCard(cards, { ...data.directory, name: t("Wszystkie utwory") }, true), `all:${data.directory.id}`));
      for (const collection of [...availableCollections].sort((left, right) => left.name.localeCompare(right.name, "pl"))) {
        nextCards.push(markCard(playlistCard(cards, collection), `playlist:${collection.id}`));
      }
    }
    data.directories.forEach((folder) => nextCards.push(markCard(folderCard(cards, folder), `folder:${folder.id}`)));
    const folderCover = { folderPreview: data.directory.preview_media_item_id, folderPreviewKind: data.directory.preview_kind };
    data.items.forEach((item) => nextCards.push(markCard(itemCard(cards, item, folderCover), `item:${item.id}`)));
    if (append) {
      markAppended(nextCards);
      gridWindow.cards.push(...nextCards);
    } else {
      gridWindow.cards = nextCards;
      gridWindow.start = 0;
      selected.clear();
    }
    gridWindow.draw();
    if (!append) settleListing();
    loadMore.classList.toggle("hidden", !hasMore);
    updateSummary();
  };

  /** A listing is on screen: the placeholders' busy mark goes, and a new place arrives. */
  const settleListing = (): void => {
    grid.removeAttribute("aria-busy");
    if (!newPlace) return;
    newPlace = false;
    arrive(grid);
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
      if (!queueIsLive(request)) throw new Error("stale collection queue request");
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
          if (!queueIsLive(request)) throw new Error("stale global collection queue request");
          return {
            items: data.items,
            next_cursor: data.items.at(-1)?.id ?? null,
            has_more: data.has_more,
            offset: data.offset,
            total: data.total
          };
        }
      : null;
    queueBuildStarted();
    try {
      const context = collection.smart
        ? t("Playlista inteligentna: {name}", { name: collection.name })
        : t("Playlista: {name}", { name: collection.name });
      if (shuffle.mode === "off") {
        let items = [...collection.items];
        let hasMore = collection.hasMore;
        let startAt = startId;
        // The track to keep playing — shuffle switched off on track 150 of 300 —
        // is usually past the rows this page has loaded. It used to be looked for
        // among those only, missed, and the queue started over from row one: a
        // different song, mid-listen. The list in its own order is read on until
        // the track turns up, and the queue continues from where it stands.
        if (startId !== undefined && !items.some((item) => item.id === startId)) {
          const playing = player.currentItem();
          const found = hasMore
            ? await findInPages(startId, nextPage, LOCATE_PAGES, (page) => getCollection(activeCollectionId, page, 100, sortOptions))
            : null;
          if (request !== queueRequest) return;
          if (found?.found) {
            const known = new Set(items.map((item) => item.id));
            items.push(...found.items.filter((item) => !known.has(item.id)));
            nextPage = found.nextPage;
            hasMore = found.hasMore;
          } else if (playing?.id === startId) {
            // Further down a very long list than is worth reading, or no longer on
            // it: the track keeps playing at the head, the list in order after it.
            items = [playing, ...items.filter((item) => item.id !== playing.id)];
          } else {
            startAt = undefined;
          }
        }
        installedQueue = request;
        await player.setQueue(items, startAt, autoplay, { offset: collection.offset, total: collection.total, context });
        if (installedQueue !== request) return;
        player.setQueuePaging(loader, false, hasMore);
      } else {
        const first = await loader("after");
        if (request !== queueRequest) return;
        // The track that keeps playing across a re-shuffle is usually past the
        // hundred rows this page holds; the player still has it.
        const playing = player.currentItem();
        const current = startId
          ? collection.items.find((item) => item.id === startId) ?? (playing?.id === startId ? playing : undefined)
          : undefined;
        const items = current
          ? [current, ...first.items.filter((item) => item.id !== current.id)]
          : first.items;
        if (items.length === 0) return;
        installedQueue = request;
        await player.setQueue(items, current?.id, autoplay, { offset: first.offset, total: first.total, context });
        if (installedQueue !== request) return;
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
        ownerName: collection.ownerName,
        label: collection.name,
        smart: collection.smart
      });
      activeQueueCollection = collection;
      preparedQueueKey = collectionQueueKey(activeCollectionId, collection.sort, collection.seed);
    } catch {
      if (request === queueRequest) showMessage(t("Nie udało się odtworzyć playlisty."), true);
    } finally {
      queueBuildEnded();
    }
  };

  /** The open playlist, as the queue builder wants it. */
  const openCollectionContext = (): CollectionQueueContext | null =>
    collectionId === null
      ? null
      : {
          id: collectionId,
          name: collectionName,
          smart: collectionSmart,
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
        smart: data.collection.is_smart,
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
      const drawn = gridWindow.cards;
      [drawn[index], drawn[target]] = [drawn[target]!, drawn[index]!];
      gridWindow.draw();
      clearMessage();
    } catch {
      showMessage(t("Nie udało się zmienić kolejności playlisty."), true);
    } finally {
      reorderBusy = false;
    }
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
    // In the caller's own hand-arranged list every card can be moved up and down.
    const listCard = (item: MediaItem): HTMLElement =>
      markCard(itemCard(cards, item, { folderPreview: null, folderPreviewKind: null, reorder: collectionReorderable }), `item:${item.id}`);
    if (append) {
      const known = new Set(collectionQueue.map((item) => item.id));
      const added = data.items.filter((item) => !known.has(item.id));
      collectionQueue.push(...added);
      const addedCards = added.map(listCard);
      markAppended(addedCards);
      gridWindow.cards.push(...addedCards);
    } else {
      collectionQueue = [...data.items];
      gridWindow.cards = data.items.map(listCard);
      gridWindow.start = 0;
      selected.clear();
      renderCollectionBreadcrumbs(data.collection);
    }
    syncToolbar();
    gridWindow.draw();
    if (!append) settleListing();
    loadMore.classList.toggle("hidden", !hasMore);
    updateSummary();
  };
  const load = async (append: boolean): Promise<void> => {
    if (append && loading) return;
    const request = ++loadRequest;
    loading = true;
    loadMoreButton.disabled = true;
    clearMessage();
    // The listing asked for before this one is nobody's any more: every letter
    // typed into the search used to leave a request running to its end on the
    // server, its answer thrown away on arrival.
    loadAbort?.abort();
    const abort = new AbortController();
    loadAbort = abort;
    // A new place shows the shape of what is coming once the wait is long enough
    // to notice; the same place redrawn keeps its cards until the new ones are in.
    const placeholder = !append && newPlace
      ? window.setTimeout(() => { if (request === loadRequest && loading) drawSkeleton(); }, 150)
      : 0;
    try {
      if (collectionId !== null) {
        const data = await getCollection(collectionId, pageNumber, 100, { ...collectionSortOptions(), signal: abort.signal });
        if (request !== loadRequest) return;
        // Opening a playlist is a look, not a decision to listen: nothing is
        // queued until "play" is pressed (the toolbar's button, or a track).
        renderCollection(data, append);
      } else {
        const [data] = await Promise.all([
          browseLibrary(options.kind, directoryId, searchText, pageNumber, 48, librarySort, randomSeed, filterBar.current(), abort.signal),
          collectionsReady
        ]);
        if (request !== loadRequest) return;
        filteredTotal = data.filtered_total;
        render(data, append);
        // A shared link names one title (`?play=`): the first listing is where
        // it is, and the only one that looks for it. Nothing else starts by
        // itself — opening the library used to build a queue of 160 tracks and
        // raise the player for an account that had never pressed play.
        if (!append && !consumedSharedPlay) {
          consumedSharedPlay = true;
          const shared = Number.isSafeInteger(sharedPlayId) ? data.items.find((item) => item.id === sharedPlayId) : undefined;
          if (shared && options.kind === "music") await playDirectory(data.directory.id, shared.id, shared, true, data.query);
          else if (shared) void viewer.open(shared);
        }
      }
    } catch (error) {
      if (isAborted(error)) return;
      if (request === loadRequest) {
        // The page number was advanced before asking; a page that never arrived
        // must be asked for again, not skipped by the next "load more".
        if (append) pageNumber = Math.max(1, pageNumber - 1);
        grid.removeAttribute("aria-busy");
        if (grid.querySelector(".media-card--skeleton")) grid.replaceChildren();
        showLoadFailure();
      }
    } finally {
      window.clearTimeout(placeholder);
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
          ? createSearchArchive(options.kind, directory.id, searchText, t("wyniki") + "-" + searchText + ".zip")
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
  coverButton.addEventListener("click", () => {
    if (collectionId !== null) coverDialog.open(collectionId, collectionHasArtwork);
  });
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

  // An address that carries filters is a filtered view: the first listing waits
  // for the controls, so it is asked for once, with them — not once without and
  // then again.
  if (collectionId === null && filterBar.inAddress) await filterBar.mounted;
  await load(false);
}
