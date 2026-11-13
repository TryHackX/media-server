import {
  collectionPreviewUrl,
  createCollectionArchive,
  createDirectoryArchive,
  createFileTransfer,
  rateCollection,
  setCollectionShared,
  updateRating
} from "../../shared/api";
import { attachActionMenu, type MenuAction } from "../../shared/action-menu";
import type { AudioPlayer } from "../../shared/audio-player";
import { copyShareLink } from "../../shared/clipboard";
import { el } from "../../shared/dom";
import { formatBytes, formatCount, formatDuration } from "../../shared/format";
import { openGuestLinkDialog } from "../../shared/guest-links";
import { fileTitle } from "../../shared/home-model";
import { icon, type IconName } from "../../shared/icons";
import { t, tn } from "../../shared/i18n";
import { itemIconName, resolutionBadge } from "../../shared/library-labels";
import { supportsThumbnail } from "../../shared/library-state";
import { pulse } from "../../shared/motion";
import { ratingPicker, starVisual } from "../../shared/rating";
import { showToast } from "../../shared/toast";
import type { ArchiveTransfer, LibraryDirectory, LibraryKind, MediaItem, UserCollection } from "../../shared/types";
import type { Previews } from "./previews";
import { downloadFailureText } from "./transfers";

/** What the account's group may do, as far as a card is concerned. */
export interface CardRights {
  downloadFile: boolean;
  downloadSelection: boolean;
  downloadFolder: boolean;
  rate: boolean;
  favorite: boolean;
  collections: boolean;
  share: boolean;
  editTags: boolean;
  /** A server-wide switch: links for people without an account. */
  guestLinks: boolean;
}

/** What a card needs of the page it stands on. */
export interface CardContext {
  kind: LibraryKind;
  rights: CardRights;
  previews: Previews;
  player: AudioPlayer;
  /** The files ticked for one download; a card's tick reads and writes it. */
  selected: Set<number>;
  selectionChanged(): void;
  showMessage(text: string, error?: boolean): void;
  /** Start a prepared archive and say what the group's whitelist left out of it. */
  reportArchive(transfer: ArchiveTransfer): void;
  openFolder(folder: LibraryDirectory): void;
  playFolder(folder: LibraryDirectory): void;
  enterCollection(collection: UserCollection): void;
  /** Queue the playlist and start it, without walking into it. */
  playCollection(collection: UserCollection): Promise<void>;
  /** A track or a film was pressed: play it in the queue of where it stands, or open it. */
  openItem(item: MediaItem): void;
  addToCollection(item: MediaItem): void;
  editTags(item: MediaItem): void;
  /** The folder on screen, for a link that should open in it; null inside a playlist. */
  currentDirectoryId(): number | null;
  /** Swap a playlist's item with its neighbour (the caller's own hand-arranged list only). */
  moveItem(item: MediaItem, delta: -1 | 1): void;
}

/** Whether an element is drawn at all — a stylesheet may have put it away (a card too small for its stars). */
function shown(element: HTMLElement | null): boolean {
  return element !== null && element.isConnected && getComputedStyle(element).display !== "none";
}

/** A quiet square button of a card's footer. */
function footerButton(name: IconName, label: string): HTMLButtonElement {
  return el("button", { className: "icon-button media-card__action", attrs: { type: "button", "aria-label": label } }, icon(name)) as HTMLButtonElement;
}

/**
 * The end of a card's footer: what else can be done with it.
 *
 * One thing is a button of its own; several stand behind a "⋯" (shared/action-menu.ts),
 * so a card of 150 px does not grow a row of five squares. `header` is asked
 * for when the menu opens — the stars, on a card whose own row has no room for
 * them.
 */
function moreControl(name: string, actions: () => MenuAction[], header?: () => HTMLElement | null): HTMLElement | null {
  const available = actions();
  if (available.length === 0 && !header) return null;
  if (available.length === 1 && !header) {
    const only = available[0]!;
    const button = footerButton(only.icon, only.label);
    button.dataset.tooltip = only.label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      // Asked for again, so the one action is the one that is true now.
      actions()[0]?.run();
    });
    return button;
  }
  const button = footerButton("more", `${t("Więcej działań")}: ${name}`);
  button.classList.add("media-card__more");
  // Nothing behind it but the stars: it is there only where the card's own row
  // has no room for them (styles/cards.css shows it under the same conditions).
  if (available.length === 0) button.dataset.onlyStars = "true";
  attachActionMenu(button, () => ({ label: `${t("Więcej działań")}: ${name}`, actions: actions(), header: header?.() ?? null }));
  return button;
}

/** The disc that says "this plays": part of the picture's own button, or a button of its own. */
function playDisc(label: string | null): HTMLElement {
  return label === null
    ? el("span", { className: "media-card__play", attrs: { "aria-hidden": "true" } }, icon("play"))
    : el("button", { className: "media-card__play", attrs: { type: "button", "aria-label": label } }, icon("play"));
}

/** Three bars over the cover of the track that is playing (styles/player.css moves them). */
function playingMark(): HTMLElement {
  return el("span", { className: "playing-bars media-card__playing", attrs: { role: "img", "aria-label": t("Teraz odtwarzane") } }, el("i"), el("i"), el("i"));
}

function playsFact(item: MediaItem): HTMLElement | null {
  if (item.play_count <= 0) return null;
  return el(
    "span",
    { className: "media-card__plays", attrs: { title: t("Odtworzono {count}×", { count: formatCount(item.play_count) }) } },
    icon("eye"),
    el("span", { text: formatCount(item.play_count) + "×" })
  );
}

/** The short facts under a card's names, in one line; empty ones leave no gap. */
function facts(...parts: Array<HTMLElement | string | null>): HTMLElement {
  const line = el("p", { className: "media-card__facts" });
  for (const part of parts) {
    if (part === null || part === "") continue;
    line.append(typeof part === "string" ? el("span", { text: part }) : part);
  }
  return line;
}

// --- Folders ---------------------------------------------------------------------------

/** What a folder's tracks were given, on average: five stars and the number; how many voted is said when asked. */
function folderRating(folder: LibraryDirectory): HTMLElement | null {
  if (folder.rating_count === 0) return null;
  const summary = tn(folder.rating_count, {
    one: "Średnia {value} z {count} oceny",
    few: "Średnia {value} z {count} ocen",
    many: "Średnia {value} z {count} ocen"
  }, { value: folder.avg_rating.toFixed(1) });
  const stars = el("div", { className: "rating-inline rating-inline--summary", attrs: { role: "img", "aria-label": summary, title: summary } });
  for (let value = 1; value <= 5; value += 1) stars.append(starVisual(folder.avg_rating, value));
  stars.append(el("span", { text: folder.avg_rating.toFixed(1) }));
  return stars;
}

/**
 * A folder: its pictures turning over, a small folder mark in the corner, and —
 * in the music library — a disc that plays it without walking in.
 *
 * `allTracks` is the card that stands for the whole library ("Wszystkie
 * utwory"): there is nothing to walk into, so pressing it anywhere plays.
 */
export function folderCard(context: CardContext, folder: LibraryDirectory, allTracks = false): HTMLElement {
  const { kind, rights } = context;
  const plays = kind === "music";
  const open = el(
    "button",
    {
      className: "media-card__open",
      attrs: { type: "button", "aria-label": allTracks ? t("Odtwórz {name}", { name: folder.name }) : t("Otwórz {name}", { name: folder.name }) }
    },
    context.previews.create({
      itemId: folder.preview_media_item_id,
      kind: folder.preview_kind,
      fallback: allTracks ? "music" : "folder",
      candidates: folder.preview_candidates,
      slideshow: true
    }),
    allTracks ? playDisc(null) : null
  );
  open.addEventListener("click", () => {
    if (allTracks) context.playFolder(folder);
    else context.openFolder(folder);
  });
  const picture = el("div", { className: "media-card__picture" }, open,
    el("span", { className: "media-card__kind", attrs: { "aria-hidden": "true" } }, icon(allTracks ? "music" : "folder")));
  if (plays && !allTracks) {
    const play = playDisc(t("Odtwórz {name}", { name: folder.name }));
    play.addEventListener("click", () => context.playFolder(folder));
    picture.append(play);
  }

  const actions = (): MenuAction[] => {
    const list: MenuAction[] = [];
    if (rights.share) {
      list.push({
        label: t("Kopiuj link do folderu"),
        icon: "share",
        run: () => void copyShareLink({ directory: String(folder.id) }).then(() => showToast(t("Link skopiowany"), "success")).catch(() => undefined)
      });
      if (rights.guestLinks) {
        list.push({
          label: t("Link dla osoby bez konta"),
          icon: "link",
          run: () => openGuestLinkDialog({ kind: "directory", id: folder.id, name: folder.name })
        });
      }
    }
    if (rights.downloadFolder) {
      list.push({
        label: t("Pobierz folder"),
        icon: "download",
        run: () => void createDirectoryArchive(kind, folder.id, folder.name + ".zip")
          .then(context.reportArchive)
          .catch((error) => context.showMessage(downloadFailureText(error, t("Nie udało się przygotować folderu ZIP.")), true))
      });
    }
    return list;
  };

  return el(
    "article",
    { className: `media-card media-card--folder${allTracks ? " media-card--all" : ""}` },
    picture,
    el(
      "div",
      { className: "media-card__body" },
      el("h3", { className: "media-card__title", text: folder.name }),
      facts(
        tn(folder.descendant_file_count, { one: "{count} plik", few: "{count} pliki", many: "{count} plików" }),
        formatBytes(folder.total_size_bytes)
      )
    ),
    el("div", { className: "media-card__footer" }, folderRating(folder), moreControl(folder.name, actions))
  );
}

// --- Playlists -------------------------------------------------------------------------

/**
 * Stars for the list itself, on the card that carries it.
 *
 * The picker is the one the track cards use, so a vote is cast the same way
 * everywhere; only what is being voted on differs. Pressing the star already
 * given clears the vote. The answer redraws the stars in place — every copy of
 * them, the card's own and the one in its open menu.
 */
function collectionRating(context: CardContext, collection: UserCollection): HTMLElement {
  const key = `collection:${collection.id}`;
  const build = (): HTMLElement => {
    const picker = ratingPicker({
      value: collection.rating ?? collection.avg_rating,
      summary: `${collection.avg_rating.toFixed(1)} (${collection.rating_count})`,
      ariaLabel: t("Ocena playlisty {name}", { name: collection.name }),
      disabled: !context.rights.rate,
      onSelect: async (value) => {
        const result = await rateCollection(collection.id, collection.rating === value ? null : value);
        collection.rating = result.user_rating;
        collection.avg_rating = result.avg_rating;
        collection.rating_count = result.rating_count;
        for (const copy of Array.from(document.querySelectorAll<HTMLElement>(`.rating-picker[data-rating-of="${key}"]`))) copy.replaceWith(build());
      }
    });
    picker.dataset.ratingOf = key;
    picker.classList.add("media-card__rating");
    return picker;
  };
  return build();
}

/**
 * A playlist as a card of the shelf it stands on.
 *
 * Two wishes, two places to press. **The disc plays** — it queues the list and
 * starts it, leaving the grid where it was. **The card enters**, exactly as the
 * folder card beside it does. The mark in the corner says which kind of list it
 * is: put together by hand, or computed from rules.
 */
export function playlistCard(context: CardContext, collection: UserCollection): HTMLElement {
  const { rights } = context;
  const open = el(
    "button",
    { className: "media-card__open", attrs: { type: "button", "aria-label": t("Otwórz playlistę {name}", { name: collection.name }) } },
    // Own cover if there is one, otherwise the artwork of what is on the list.
    context.previews.create({
      itemId: null,
      kind: null,
      fallback: collection.media_kind === "music" ? "music" : "film",
      candidates: collection.preview_candidates,
      slideshow: !collection.has_artwork,
      leadUrl: collection.has_artwork ? collectionPreviewUrl(collection.id, collection.artwork_revision) : null
    })
  );
  open.addEventListener("click", () => context.enterCollection(collection));
  const kindLabel = collection.is_smart ? t("Inteligentna playlista") : t("Własna playlista");
  const picture = el("div", { className: "media-card__picture" }, open,
    el("span", { className: "media-card__kind", attrs: { role: "img", "aria-label": kindLabel, title: kindLabel } }, icon(collection.is_smart ? "smart" : "list")));
  if (context.kind === "music") {
    const play = playDisc(t("Odtwórz {name}", { name: collection.name })) as HTMLButtonElement;
    play.addEventListener("click", () => {
      play.disabled = true;
      void context.playCollection(collection).finally(() => { play.disabled = false; });
    });
    picture.append(play);
  }

  const actions = (): MenuAction[] => {
    const list: MenuAction[] = [];
    if (rights.share) {
      // A link to a private list opens for nobody but its author, so sharing one
      // publishes it first — the same single meaning of "share" the collection
      // browser has. The entry says which of the two will happen.
      const publishes = collection.is_owned && !collection.is_shared;
      list.push({
        label: publishes ? t("Udostępnij i skopiuj link") : t("Kopiuj link do playlisty"),
        icon: "share",
        run: () => void Promise.resolve(publishes ? setCollectionShared(collection.id, true) : undefined)
          .then(() => {
            if (collection.is_owned) collection.is_shared = true;
            return copyShareLink({ collection: String(collection.id) });
          })
          .then(() => showToast(t("Link skopiowany"), "success"))
          .catch(() => context.showMessage(t("Nie udało się udostępnić playlisty."), true))
      });
    }
    if (rights.downloadFolder) {
      list.push({
        label: t("Pobierz playlistę"),
        icon: "download",
        run: () => void createCollectionArchive(collection.id, collection.name + ".zip")
          .then(context.reportArchive)
          .catch((error) => context.showMessage(downloadFailureText(error, t("Nie udało się przygotować playlisty ZIP.")), true))
      });
    }
    return list;
  };
  const footer = el("div", { className: "media-card__footer" }, collectionRating(context, collection));
  // The stars are redrawn after a vote, so the row is asked for them each time.
  const more = moreControl(collection.name, actions, () =>
    (shown(footer.querySelector<HTMLElement>(".media-card__rating")) ? null : collectionRating(context, collection)));
  if (more) footer.append(more);

  return el(
    "article",
    { className: "media-card media-card--playlist", dataset: { collectionId: collection.id } },
    picture,
    el(
      "div",
      { className: "media-card__body" },
      el("h3", { className: "media-card__title", text: collection.name }),
      // The description is what its author wanted said about it; the name of an
      // author who is somebody else stands in when there is none.
      collection.description
        ? el("p", { className: "media-card__meta", text: collection.description, attrs: { title: collection.description } })
        : collection.is_owned ? null : el("p", { className: "media-card__meta", text: collection.owner_name }),
      facts(
        tn(collection.item_count, { one: "{count} pozycja", few: "{count} pozycje", many: "{count} pozycji" }),
        collection.description && !collection.is_owned ? collection.owner_name : null,
        collection.is_shared ? el("span", { className: "status-pill status-pill--success", text: t("Udostępniona") }) : null
      )
    ),
    footer
  );
}

// --- Tracks, films and other files ---------------------------------------------------------

function selectionControl(context: CardContext, item: MediaItem): HTMLElement {
  const input = el("input", { attrs: { type: "checkbox", "aria-label": t("Wybierz {title}", { title: item.title }) } });
  input.checked = context.selected.has(item.id);
  input.addEventListener("change", () => {
    if (input.checked) context.selected.add(item.id);
    else context.selected.delete(item.id);
    context.selectionChanged();
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
}

/** What a rating or a heart given somewhere else (the film viewer) carries to the cards on the page. */
interface ItemRated {
  id: number;
  rating: number | null;
  avg_rating: number;
  rating_count: number;
  favorite: boolean;
}

/**
 * The cards' answer to `media:item-rated`: the viewer rates the film it shows,
 * and the card of the same film on the page redraws its stars and heart from
 * the event at once. Weak, so a card the grid window drops takes its entry with it.
 */
const ratedUpdaters = new WeakMap<HTMLElement, (rated: ItemRated) => void>();
let ratedListening = false;

function listenForRatings(): void {
  if (ratedListening) return;
  ratedListening = true;
  document.addEventListener("media:item-rated", (event) => {
    const rated = (event as CustomEvent<ItemRated>).detail;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[data-rating-of="item:${rated.id}"], [data-favorite-of="item:${rated.id}"]`))) {
      ratedUpdaters.get(element)?.(rated);
    }
  });
}

function itemRating(context: CardContext, item: MediaItem): HTMLElement {
  const key = `item:${item.id}`;
  listenForRatings();
  const build = (): HTMLElement => {
    const picker = ratingPicker({
      value: item.rating ?? item.avg_rating,
      summary: `${item.avg_rating.toFixed(1)} (${item.rating_count})`,
      ariaLabel: t(item.media_kind === "video" ? "Ocena filmu {title}" : "Ocena utworu {title}", { title: item.title }),
      disabled: !context.rights.rate,
      onSelect: async (value) => {
        const result = await updateRating(item.id, { rating: item.rating === value ? null : value });
        item.rating = result.user_rating;
        item.avg_rating = result.avg_rating;
        item.rating_count = result.rating_count;
        // Every copy of these stars on the page: the card's own row and the one in its open menu.
        for (const copy of Array.from(document.querySelectorAll<HTMLElement>(`.rating-picker[data-rating-of="${key}"]`))) copy.replaceWith(build());
        context.player.applyItemUpdate({
          id: item.id,
          rating: item.rating,
          avg_rating: item.avg_rating,
          rating_count: item.rating_count
        });
      }
    });
    picker.dataset.ratingOf = key;
    picker.classList.add("media-card__rating");
    ratedUpdaters.set(picker, (rated) => {
      item.rating = rated.rating;
      item.avg_rating = rated.avg_rating;
      item.rating_count = rated.rating_count;
      picker.replaceWith(build());
    });
    // The numbers the card has no room to print: what everybody gave it, and how many they were.
    if (item.rating_count > 0) {
      picker.title = tn(item.rating_count, {
        one: "Średnia {value} z {count} oceny",
        few: "Średnia {value} z {count} ocen",
        many: "Średnia {value} z {count} ocen"
      }, { value: item.avg_rating.toFixed(1) });
    }
    return picker;
  };
  return build();
}

export interface ItemCardOptions {
  /** The folder's own cover, for a track that has none of its own. */
  folderPreview: number | null;
  folderPreviewKind: MediaItem["media_kind"] | null;
  /** In the caller's own hand-arranged playlist: the card can be moved up and down. */
  reorder?: boolean;
}

/**
 * A track, a film, or any other file.
 *
 * The picture is the thing: a track's cover whole and square, a film's still in
 * 16:9 with what the picture is (4K, HDR) and how long it runs laid on it.
 * Pressing the card plays or opens. Under it stand the names and one line of
 * facts — the path, which used to be printed in full on every card, is what the
 * card says when pointed at. The footer holds the stars and the heart; edit,
 * add to a playlist, share and download stand behind "⋯".
 */
export function itemCard(context: CardContext, item: MediaItem, options: ItemCardOptions): HTMLElement {
  const { rights } = context;
  const audio = item.media_kind === "audio";
  const video = item.media_kind === "video";
  const media = audio || video;
  const title = video ? fileTitle(item.title) : item.title;
  const ownPreview = ["audio", "video", "image"].includes(item.media_kind);
  const reusableFolderPreview = audio && supportsThumbnail(options.folderPreviewKind);
  const open = el(
    "button",
    {
      className: "media-card__open",
      attrs: {
        type: "button",
        "aria-label": media ? t("Odtwórz {title}", { title }) : t("Otwórz {title}", { title }),
        // Where the file is, for whoever asks by pointing: it used to be printed on every card.
        title: item.relative_path
      }
    },
    context.previews.create({
      itemId: ownPreview ? item.id : reusableFolderPreview ? options.folderPreview : null,
      kind: ownPreview ? item.media_kind : reusableFolderPreview ? options.folderPreviewKind : null,
      fallback: itemIconName(item)
    }),
    media ? playDisc(null) : null
  );
  open.addEventListener("click", () => context.openItem(item));
  const picture = el("div", { className: "media-card__picture" }, open);
  if (rights.downloadSelection) picture.append(selectionControl(context, item));
  if (audio) picture.append(playingMark());
  if (video) {
    const resolution = resolutionBadge(item);
    const marks = el("span", { className: "media-card__marks" },
      resolution ? el("span", { className: "picture-badge", text: resolution }) : null,
      item.is_hdr ? el("span", { className: "picture-badge picture-badge--hdr", text: t("HDR") }) : null
    );
    if (marks.childElementCount > 0) picture.append(marks);
    if (item.duration_ms) picture.append(el("span", { className: "media-card__length", text: formatDuration(item.duration_ms) }));
    // Where this account left it (the bridge sends `progress` only between 2 % and 95 %).
    if (typeof item.progress === "number" && item.progress > 0) {
      const fill = el("span", { className: "media-card__progress-fill" });
      fill.style.setProperty("--progress", String(Math.min(1, item.progress)));
      picture.append(el("span", { className: "media-card__progress", attrs: { "aria-hidden": "true" } }, fill));
    }
  }

  const footer = el("div", { className: "media-card__footer" });
  const rating = media ? itemRating(context, item) : null;
  if (rating) footer.append(rating);
  if (rights.favorite && media) {
    const favorite = footerButton("heart", t("Ulubione"));
    favorite.classList.add("media-card__favorite");
    favorite.classList.toggle("is-active", item.favorite);
    favorite.setAttribute("aria-pressed", String(item.favorite));
    favorite.dataset.favoriteOf = `item:${item.id}`;
    listenForRatings();
    ratedUpdaters.set(favorite, (rated) => {
      item.favorite = rated.favorite;
      favorite.classList.toggle("is-active", item.favorite);
      favorite.setAttribute("aria-pressed", String(item.favorite));
    });
    favorite.addEventListener("click", () => {
      favorite.disabled = true;
      void updateRating(item.id, { favorite: !item.favorite }).then((result) => {
        item.favorite = result.user_favorite;
        favorite.classList.toggle("is-active", item.favorite);
        favorite.setAttribute("aria-pressed", String(item.favorite));
        // The heart answers the press that made it one (styles/motion.css).
        if (item.favorite) pulse(favorite, "is-popping", 420);
        // The player holds its own copies of the track; keep them in step so the
        // open queue shows the heart immediately.
        context.player.applyItemUpdate({ id: item.id, favorite: item.favorite });
      }).catch(() => {
        context.showMessage(t("Nie udało się zmienić ulubionych."), true);
      }).finally(() => { favorite.disabled = false; });
    });
    footer.append(favorite);
  }
  let reorder: HTMLElement | null = null;
  if (options.reorder) {
    const up = footerButton("chevron", t("Przenieś wyżej: {title}", { title: item.title }));
    const down = footerButton("chevron", t("Przenieś niżej: {title}", { title: item.title }));
    up.classList.add("media-reorder__up");
    down.classList.add("media-reorder__down");
    up.dataset.tooltip = t("Przenieś wyżej");
    down.dataset.tooltip = t("Przenieś niżej");
    up.addEventListener("click", (event) => { event.stopPropagation(); context.moveItem(item, -1); });
    down.addEventListener("click", (event) => { event.stopPropagation(); context.moveItem(item, 1); });
    reorder = el("div", { className: "media-reorder" }, up, down);
    footer.append(reorder);
  }

  const actions = (): MenuAction[] => {
    const list: MenuAction[] = [];
    // A phone's card has no room for the two arrows: there they are entries.
    if (reorder && !shown(reorder)) {
      list.push({ label: t("Przenieś wyżej"), icon: "chevron", turn: "up", run: () => context.moveItem(item, -1) });
      list.push({ label: t("Przenieś niżej"), icon: "chevron", turn: "down", run: () => context.moveItem(item, 1) });
    }
    if (media && rights.editTags) list.push({ label: t("Edytuj metadane"), icon: "edit", run: () => context.editTags(item) });
    if (media && rights.collections) list.push({ label: t("Dodaj do kolekcji"), icon: "list", run: () => context.addToCollection(item) });
    if (rights.share) {
      list.push({
        label: t("Kopiuj link"),
        icon: "share",
        run: () => {
          const parameters: Record<string, string> = { q: item.title, play: String(item.id) };
          const directory = context.currentDirectoryId();
          if (directory !== null) parameters.directory = String(directory);
          void copyShareLink(parameters).then(() => showToast(t("Link skopiowany"), "success")).catch(() => undefined);
        }
      });
    }
    if (rights.downloadFile) {
      list.push({
        label: t("Pobierz"),
        icon: "download",
        run: () => void createFileTransfer(item.id, false)
          .then((transfer) => window.location.assign(transfer.url))
          .catch((error) => context.showMessage(downloadFailureText(error, t("Nie udało się przygotować pobierania.")), true))
      });
    }
    return list;
  };
  // The stars stand in the card's own row where it has room for them; where it
  // has not (a phone, a playlist being arranged) the menu carries them.
  // (They are redrawn after a vote, so the row is asked for them each time.)
  const more = moreControl(title, actions, rating
    ? () => (shown(footer.querySelector<HTMLElement>(".media-card__rating")) ? null : itemRating(context, item))
    : undefined);
  if (more) footer.append(more);

  const names = [item.artist, item.album].filter((value): value is string => Boolean(value)).join(" · ");
  const fileName = item.relative_path.split("/").pop() ?? item.relative_path;
  const kindClass = audio ? " media-card--track" : video ? " media-card--film" : " media-card--file";
  return el(
    "article",
    {
      className: "media-card" + kindClass + (options.reorder ? " is-reorderable" : "") + (context.player.currentItem()?.id === item.id ? " is-playing" : ""),
      dataset: { mediaId: item.id }
    },
    picture,
    el(
      "div",
      { className: "media-card__body" },
      el("h3", { className: "media-card__title", text: title }),
      // A track says who and on what; a file that says neither is told apart by its name.
      audio ? el("p", { className: "media-card__meta", text: names || fileName }) : null,
      audio
        ? facts(formatDuration(item.duration_ms), playsFact(item))
        : video
          ? facts(item.year, formatBytes(item.size_bytes), playsFact(item))
          : facts(item.file_extension?.toUpperCase() ?? null, formatBytes(item.size_bytes))
    ),
    footer.childElementCount > 0 ? footer : null
  );
}
