import "../styles/index.css";

import { ApiError, dismissContinue, getContinueShelf, getQueuePage, previewUrl } from "../shared/api";
import type { AudioPlayer } from "../shared/audio-player";
import { appUrl } from "../shared/config";
import { el } from "../shared/dom";
import { formatDuration } from "../shared/format";
import { icon, type IconName } from "../shared/icons";
import { t } from "../shared/i18n";
import { supportsThumbnail } from "../shared/library-state";
import { MediaViewer } from "../shared/media-viewer";
import { mountShell } from "../shared/shell";
import type { ContinueEntry, MediaItem, NextUpEntry, PopularEntry } from "../shared/types";

function libraryCard(
  title: string,
  description: string,
  path: string,
  iconName: IconName
): HTMLAnchorElement {
  return el(
    "a",
    { className: "library-entry", attrs: { href: appUrl(path) } },
    el("span", { className: "library-entry__icon" }, icon(iconName)),
    el(
      "span",
      { className: "library-entry__copy" },
      el("span", { className: "status-pill", text: t("Katalog online") }),
      el("h2", { text: title }),
      el("p", { className: "muted", text: description })
    ),
    el(
      "span",
      { className: "library-entry__footer" },
      el("span", { text: t("Otwórz bibliotekę") }),
      icon("arrow")
    )
  );
}

/** "1 g 12 min" rather than "1:12:03" — this is a sentence, not a timeline. */
function remainingLabel(milliseconds: number): string {
  const totalMinutes = Math.round(Math.max(0, milliseconds) / 60000);
  if (totalMinutes < 1) return t("mniej niż minuta");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t("{minutes} min", { minutes });
  return minutes === 0 ? t("{hours} g", { hours }) : t("{hours} g {minutes} min", { hours, minutes });
}

/** The cover, falling back to the kind's icon when the file has no artwork. */
function poster(item: MediaItem): HTMLElement {
  const fallback: IconName = item.media_kind === "video" ? "film" : "music";
  const visual = el("div", { className: "continue-card__preview" }, icon(fallback));
  if (!supportsThumbnail(item.media_kind)) return visual;
  const image = el("img", {
    className: "continue-card__image",
    attrs: { alt: "", loading: "lazy", decoding: "async", src: previewUrl(item.id) }
  });
  image.addEventListener("load", () => visual.classList.add("has-image"), { once: true });
  image.addEventListener("error", () => image.remove(), { once: true });
  visual.append(image);
  return visual;
}

export async function mount(): Promise<void> {
  const shell = await mountShell("home", "Twoje media", "Panel główny");
  const { content, session, player } = shell;
  const viewer = new MediaViewer(session, () => player.pause());
  document.addEventListener("media:route-will-change", () => void viewer.destroy(), { once: true });

  const shelf = el("div", { className: "continue-shelf" });
  content.append(
    el(
      "section",
      { className: "welcome-grid", attrs: { "aria-label": t("Biblioteki") } },
      libraryCard(
        "Music",
        t("Lekka biblioteka audio, odtwarzanie z obsługą Range i wspólne dane użytkownika."),
        "music/",
        "music"
      ),
      libraryCard(
        "Movies",
        t("Responsywna biblioteka wideo z tym samym układem, nawigacją i serwerem transferowym."),
        "movies/",
        "film"
      )
    ),
    el(
      "section",
      { className: "stage-summary", attrs: { "aria-label": t("Stan nowej architektury") } },
      el(
        "div",
        { className: "stage-summary__item" },
        el("strong", { text: t("Jedna sesja") }),
        el("span", { text: t("Tożsamość ponownie sprawdzana w bazie") })
      ),
      el(
        "div",
        { className: "stage-summary__item" },
        el("strong", { text: t("Jeden katalog") }),
        el("span", { text: t("Music i Movies w media_server_stage") })
      ),
      el(
        "div",
        { className: "stage-summary__item" },
        el("strong", { text: t("Transfer Python") }),
        el("span", { text: t("Pliki, Range i ZIP poza workerem PHP") })
      )
    ),
    // Below the two library cards: those are the doors into the collection, the
    // shelves are what is already open.
    shelf
  );

  await renderShelf(shelf, viewer, player);
}

/**
 * Resume a film where it was left, or a track together with the folder it sits in.
 *
 * The queue starts as the one track so playback begins without waiting for the
 * folder listing; the pager then fills the rest in around it, exactly as the
 * library does when a card is clicked.
 */
async function resume(
  entry: ContinueEntry | NextUpEntry | PopularEntry,
  player: AudioPlayer,
  viewer: MediaViewer,
  context: string
): Promise<void> {
  const positionMs = "position_ms" in entry ? entry.position_ms : 0;
  const item = entry.item;
  if (item.media_kind !== "audio") {
    await viewer.open(item, positionMs / 1000);
    return;
  }
  await player.setQueue([item], item.id, true, {
    offset: 0,
    total: 1,
    context,
    resumeSeconds: positionMs / 1000
  });
  const directoryId = entry.directory_id;
  if (directoryId === null) return;
  player.setQueuePaging(
    (direction, cursor) => getQueuePage(directoryId, cursor, 160, direction),
    true,
    true
  );
  player.setQueueSource({ kind: "directory", id: directoryId, query: "", shuffleMode: "off", shuffleSeed: "" });
  void player.prefetchAfter();
}

function progressBar(percent: number): HTMLElement {
  const fill = el("span", { className: "continue-card__progress-fill" });
  fill.style.width = `${Math.min(100, Math.max(1, percent))}%`;
  return el("span", { className: "continue-card__progress", attrs: { "aria-hidden": "true" } }, fill);
}

/**
 * Draw the "continue" shelf, and keep it out of the way when there is nothing on
 * it: an empty section on the start page is noise, not information.
 */
async function renderShelf(host: HTMLElement, viewer: MediaViewer, player: AudioPlayer): Promise<void> {
  let data;
  try {
    data = await getContinueShelf(12);
  } catch (error) {
    // The shelf is a convenience; a bridge that refuses it must not take the
    // library cards down with it.
    if (!(error instanceof ApiError)) throw error;
    return;
  }
  if (!host.isConnected) return;

  const sections: HTMLElement[] = [];
  const rows: HTMLElement[] = [];
  const addSection = (title: string, hint: string, cards: HTMLElement[]): void => {
    if (cards.length === 0) return;
    const row = el("div", { className: "continue-row" }, ...cards);
    const section = el(
      "section",
      { className: "continue-section", attrs: { "aria-label": title } },
      el(
        "header",
        { className: "continue-section__header" },
        el("h2", { text: title }),
        el("p", { className: "muted", text: hint })
      ),
      row
    );
    // A row that empties as its last card is dismissed takes its heading with it.
    row.addEventListener("media:card-removed", () => {
      if (row.childElementCount === 0) section.remove();
      else capRows(row);
    });
    rows.push(row);
    sections.push(section);
  };

  addSection(
    t("Obejrzyj dalej"),
    t("Kolejne odcinki i pozycje z folderów, które masz już za sobą."),
    data.next.map((entry) => nextCard(entry, viewer, player))
  );
  addSection(
    t("Kontynuuj oglądanie"),
    t("Filmy zatrzymane w połowie — kliknięcie wraca do zapisanej sekundy."),
    data.movies.map((entry) => continueCard(entry, viewer, player, t("Kontynuuj oglądanie")))
  );
  addSection(
    t("Niedokończone utwory"),
    t("Krótsze nagrania przerwane w połowie."),
    data.tracks.map((entry) => continueCard(entry, viewer, player, t("Niedokończone utwory")))
  );
  addSection(
    t("Kontynuuj słuchanie"),
    t("Długie nagrania, których nie doprowadziłeś do końca."),
    data.music.map((entry) => continueCard(entry, viewer, player, t("Kontynuuj słuchanie")))
  );
  addSection(
    t("Popularne w domu"),
    t("Grane ostatnio przez domowników, a przez Ciebie jeszcze nie."),
    data.popular.map((entry) => popularCard(entry, viewer, player))
  );
  host.replaceChildren(...sections);
  for (const row of rows) capRows(row);
  // The column count comes from the viewport, so the cap has to be recomputed
  // whenever the shelf is re-laid out rather than decided once at render time.
  const observer = new ResizeObserver(() => {
    for (const row of rows) capRows(row);
  });
  observer.observe(host);
  document.addEventListener("media:route-will-change", () => observer.disconnect(), { once: true });
}

/** How many rows of cards a shelf may show before the rest is put away. */
const SHELF_ROWS = 2;

/**
 * Keep a shelf to two rows.
 *
 * The grid fits as many columns as the window allows, so "two rows" is a number
 * only the browser knows; it is read back from the resolved template and the
 * surplus cards are hidden outright rather than clipped, so nothing is cut in
 * half and nothing hidden stays in the tab order.
 */
function capRows(row: HTMLElement): void {
  const columns = getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean).length;
  if (columns < 1) return;
  const visible = columns * SHELF_ROWS;
  row.querySelectorAll<HTMLElement>(".continue-card").forEach((card, index) => {
    card.classList.toggle("is-beyond-shelf", index >= visible);
  });
}

function cardShell(
  item: MediaItem,
  overlay: HTMLElement | null,
  meta: HTMLElement,
  onOpen: () => void,
  extra: HTMLElement | null
): HTMLElement {
  const visual = poster(item);
  if (overlay) visual.append(overlay);
  visual.append(el("span", { className: "continue-card__play" }, icon("play")));
  const open = el(
    "button",
    { className: "continue-card__open", attrs: { type: "button", "aria-label": t("Odtwórz {title}", { title: item.title }) } },
    visual
  );
  open.addEventListener("click", onOpen);
  return el(
    "article",
    { className: "continue-card", dataset: { mediaId: item.id } },
    open,
    el(
      "div",
      { className: "continue-card__body" },
      el("h3", { className: "continue-card__title", text: item.title, attrs: { title: item.relative_path } }),
      meta
    ),
    extra
  );
}

function continueCard(
  entry: ContinueEntry,
  viewer: MediaViewer,
  player: AudioPlayer,
  context: string
): HTMLElement {
  const duration = entry.item.duration_ms ?? 0;
  const percent = duration > 0 ? (entry.position_ms / duration) * 100 : 0;
  const meta = el("p", {
    className: "continue-card__meta",
    text: duration > 0
      ? t("{percent}% · pozostało {remaining}", {
          percent: Math.round(percent),
          remaining: remainingLabel(duration - entry.position_ms)
        })
      : t("Zapisana pozycja")
  });
  const dismiss = el(
    "button",
    {
      className: "continue-card__dismiss icon-button",
      attrs: { type: "button", "aria-label": t("Usuń „{title}” z listy", { title: entry.item.title }) }
    },
    icon("close")
  );
  dismiss.dataset.tooltip = t("To już obejrzałem — ukryj (historia odtwarzania zostaje)");
  const card = cardShell(
    entry.item,
    progressBar(percent),
    meta,
    () => void resume(entry, player, viewer, context),
    dismiss
  );
  dismiss.addEventListener("click", () => {
    dismiss.disabled = true;
    void dismissContinue(entry.item.id)
      .then(() => {
        const row = card.parentElement;
        card.remove();
        row?.dispatchEvent(new CustomEvent("media:card-removed"));
      })
      .catch(() => {
        dismiss.disabled = false;
      });
  });
  return card;
}

/**
 * A title the household has been playing that this account has not opened.
 *
 * The badge counts people rather than plays: "two people" says more about whether
 * something is worth an evening than "forty plays", which one listener on repeat
 * can produce on their own.
 */
function popularCard(entry: PopularEntry, viewer: MediaViewer, player: AudioPlayer): HTMLElement {
  const meta = el(
    "p",
    { className: "continue-card__meta" },
    el("span", {
      className: "continue-card__badge",
      text: entry.listeners > 1
        ? t("{count} domowników", { count: entry.listeners })
        : t("Ktoś w domu")
    }),
    el("span", { text: formatDuration(entry.item.duration_ms) })
  );
  return cardShell(
    entry.item,
    null,
    meta,
    () => void resume({ ...entry, position_ms: 0, last_played_at: "" }, player, viewer, t("Popularne w domu")),
    null
  );
}

function nextCard(entry: NextUpEntry, viewer: MediaViewer, player: AudioPlayer): HTMLElement {
  const label = entry.reason === "episode" ? t("Następny odcinek") : t("Z tego samego folderu");
  const meta = el(
    "p",
    { className: "continue-card__meta" },
    el("span", { className: "continue-card__badge", text: label }),
    el("span", { text: t("po: {title}", { title: entry.after.title }), attrs: { title: entry.after.title } })
  );
  return cardShell(entry.item, null, meta, () => void resume(entry, player, viewer, t("Obejrzyj dalej")), null);
}
