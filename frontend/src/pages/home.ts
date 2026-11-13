import { dismissContinue, dismissHomeCard, failureText, getHome, getQueuePage, isAborted, previewUrl, restoreHomeCards } from "../shared/api";
import { appUrl } from "../shared/config";
import { arrive, el } from "../shared/dom";
import { formatCount, formatDuration } from "../shared/format";
import {
  cardLook, cardTitle, daysSince, dismissKind, episodeCode, expectedShelves, fileTitle, homeSignature, hoursAndMinutes, progressPercent,
  rowCapacity, visibleShelves, withShelf, withoutCard, type LibraryAccess, type ShelfDefinition, type VisibleShelf
} from "../shared/home-model";
import { icon, type IconName } from "../shared/icons";
import { currentLanguage, t, tn } from "../shared/i18n";
import { resolutionBadge } from "../shared/library-labels";
import { MediaViewer } from "../shared/media-viewer";
import { removeFromList, viewTransition } from "../shared/motion";
import { canAccessLibrary } from "../shared/permissions";
import { randomId } from "../shared/random-id";
import { mountShell } from "../shared/shell";
import { showToast } from "../shared/toast";
import type { HomeCard, HomeData, HomeLibrary, HomeSurprise, LibraryKind, MediaItem } from "../shared/types";

/**
 * The start page.
 *
 * It used to be two doors — "Muzyka", "Filmy" — and, under them, whatever had
 * been left unfinished. What somebody opening the application wants to know is
 * what to play now, so that is what the page answers, top to bottom:
 *
 * 1. the title to carry on with, large (or a greeting, when there is none);
 * 2. the libraries, as two small tiles with what is in them;
 * 3. shelves: what was begun, what follows it, something at random for a quick
 *    start, what is new, what is recommended and why, what the household plays;
 * 4. "Zaskocz mnie": one album and one film, drawn again on request.
 *
 * All of it comes in one answer (`GET ?action=home`, shared/home-model.ts says
 * which shelves there are). The last answer is kept for the life of the tab and
 * painted at once on the way back to this page; a fresh one is asked for behind
 * it and replaces it only if it would draw something different.
 */

/** The last answer, and whose it was: a tab can change accounts only by signing out, but nothing else may ever show. */
let remembered: { userId: number; data: HomeData } | null = null;

/** How many cards of a shelf "Zobacz wszystkie" asks for (the bridge's ceiling for one shelf). */
const FULL_SHELF = 60;

/** A new seed for a draw: 16 hex characters, which is what the bridge accepts (8–64 of [A-Za-z0-9_-]). */
function newSeed(): string {
  return randomId(8);
}

/** "1 g 12 min" rather than "1:12:03" — this is a sentence, not a timeline. */
function remainingLabel(milliseconds: number): string {
  const { hours, minutes } = hoursAndMinutes(milliseconds);
  if (hours === 0 && minutes < 1) return t("mniej niż minuta");
  if (hours === 0) return t("{minutes} min", { minutes });
  return minutes === 0 ? t("{hours} g", { hours }) : t("{hours} g {minutes} min", { hours, minutes });
}

function progressLabel(card: HomeCard): string {
  const percent = progressPercent(card);
  if (percent === null) return t("Zapisana pozycja");
  return typeof card.remaining_ms === "number"
    ? t("{percent}% · pozostało {remaining}", { percent, remaining: remainingLabel(card.remaining_ms) })
    : t("{percent}%", { percent });
}

function genreNames(card: HomeCard, limit: number): string[] {
  const english = currentLanguage() === "en";
  return (card.work?.genres ?? []).slice(0, limit).map((genre) => (english ? genre.name_en : genre.name_pl));
}

function addedLabel(card: HomeCard): string | null {
  const days = daysSince(card.added_at, Date.now());
  if (days === null) return null;
  if (days === 0) return t("Dodano dziś");
  if (days === 1) return t("Dodano wczoraj");
  return tn(days, { one: "Dodano {count} dzień temu", few: "Dodano {count} dni temu", many: "Dodano {count} dni temu" });
}

/** Where a series card starts, said as what will happen on a press. */
function seriesStartLabel(card: HomeCard): string {
  const code = episodeCode(card.work);
  switch (card.series?.start) {
    case "resume": return code ? t("Wznów {episode}", { episode: code }) : t("Wznów odcinek");
    case "next": return code ? t("Dalej: {episode}", { episode: code }) : t("Następny odcinek");
    case "again": return t("Obejrzany w całości — od początku");
    default: return code ? t("Zacznij od {episode}", { episode: code }) : t("Zacznij od początku");
  }
}

/** The lines under a card's title: what it is, and why it is on this shelf. */
function describe(card: HomeCard, shelf: ShelfDefinition | null): { lines: string[]; badge: string | null; reason: string | null } {
  const item = card.item;
  const film = cardLook(card) === "film";
  const lines: string[] = [];
  let badge: string | null = null;
  let reason: string | null = null;
  const code = episodeCode(card.work);
  const facts = (): string => (film
    ? [card.work?.year ? String(card.work.year) : "", ...genreNames(card, 2), item.duration_ms ? formatDuration(item.duration_ms) : ""]
    : [item.artist ?? card.folder?.artist ?? item.album ?? "", item.duration_ms && card.type === "item" ? formatDuration(item.duration_ms) : ""]
  ).filter(Boolean).join(" · ");

  if (card.series) {
    const series = card.series;
    lines.push([
      series.season_count > 0 ? tn(series.season_count, { one: "{count} sezon", few: "{count} sezony", many: "{count} sezonów" }) : "",
      tn(series.episode_count, { one: "{count} odcinek", few: "{count} odcinki", many: "{count} odcinków" })
    ].filter(Boolean).join(" · "));
    reason = seriesStartLabel(card);
  } else if (card.position_ms !== undefined) {
    if (film && code) lines.push(code);
    else if (!film && item.artist) lines.push(item.artist);
    lines.push(progressLabel(card));
  } else if (card.reason) {
    badge = card.reason === "episode" ? t("Następny odcinek") : t("Z tego samego folderu");
    lines.push([code ?? "", item.duration_ms ? formatDuration(item.duration_ms) : ""].filter(Boolean).join(" · "));
    if (card.after) reason = t("po: {title}", { title: fileTitle(card.after.title) });
  } else if (card.added_at !== undefined) {
    if (card.type === "folder" && card.folder) {
      const count = card.added_count ?? card.folder.item_count;
      if (film) {
        lines.push([
          card.work?.season ? t("Sezon {season}", { season: card.work.season }) : "",
          tn(count, { one: "{count} nowy odcinek", few: "{count} nowe odcinki", many: "{count} nowych odcinków" })
        ].filter(Boolean).join(" · "));
      } else {
        lines.push([
          card.folder.artist ?? "",
          tn(count, { one: "{count} nowy utwór", few: "{count} nowe utwory", many: "{count} nowych utworów" })
        ].filter(Boolean).join(" · "));
      }
    } else {
      lines.push([film ? code ?? "" : "", facts()].filter(Boolean).join(" · "));
    }
    reason = addedLabel(card);
  } else if (card.because) {
    lines.push([film ? code ?? "" : "", facts()].filter(Boolean).join(" · "));
    const label = currentLanguage() === "en" && card.because.label_en ? card.because.label_en : card.because.label;
    reason = card.because.type === "genre"
      ? t("Gatunek, który lubisz: {name}", { name: label })
      : card.because.type === "series"
        ? t("Bo oglądasz: {name}", { name: label })
        : t("Bo lubisz: {name}", { name: label });
  } else if (card.listeners !== undefined) {
    badge = card.listeners > 1 ? tn(card.listeners, { one: "{count} domownik", few: "{count} domowników", many: "{count} domowników" }) : t("Ktoś w domu");
    lines.push(facts());
  } else {
    lines.push([film ? code ?? "" : "", facts()].filter(Boolean).join(" · "));
    if (shelf?.id === "random_films" && item.play_count > 0) reason = t("Już oglądany");
  }
  return { lines: lines.filter(Boolean), badge, reason };
}

/**
 * A card's picture: the first of its candidate covers that loads, over the
 * kind's own glyph (which stays when none does — a track without artwork in a
 * folder without a cover).
 */
function cover(card: HomeCard, className: string, eager = false): HTMLElement {
  const fallback: IconName = card.type === "folder" && card.library === "music" ? "music" : cardLook(card) === "film" ? "film" : "music";
  const visual = el("span", { className: `${className} ${className}--${cardLook(card)}`, dataset: { tone: card.item.id % 5 } }, icon(fallback));
  const candidates = card.preview_candidates.filter((candidate) => ["audio", "image", "video"].includes(candidate.kind));
  let index = 0;
  const attempt = (): void => {
    const candidate = candidates[index];
    if (!candidate) return;
    const image = el("img", {
      className: `${className}-image`,
      attrs: { alt: "", loading: eager ? "eager" : "lazy", decoding: "async", src: previewUrl(candidate.id) }
    });
    image.addEventListener("load", () => visual.classList.add("has-image"), { once: true });
    image.addEventListener("error", () => {
      image.remove();
      index += 1;
      attempt();
    }, { once: true });
    visual.append(image);
  };
  attempt();
  return visual;
}

/** Resolution and HDR, on the picture — facts about a film that are read at a glance or not at all. */
function pictureBadges(item: MediaItem): HTMLElement | null {
  const resolution = resolutionBadge(item);
  if (!resolution && !item.is_hdr) return null;
  return el(
    "span",
    { className: "shelf-card__badges" },
    resolution ? el("span", { className: "picture-badge", text: resolution }) : null,
    item.is_hdr ? el("span", { className: "picture-badge picture-badge--hdr", text: t("HDR") }) : null
  );
}

function progressLine(card: HomeCard, className: string): HTMLElement | null {
  const percent = progressPercent(card);
  if (percent === null) return null;
  const fill = el("span", { className: `${className}-fill` });
  // A scale, not a width: the line is drawn once and never laid out again.
  fill.style.setProperty("--progress", String(percent / 100));
  return el("span", { className, attrs: { "aria-hidden": "true" } }, fill);
}

function libraryAddress(card: HomeCard): string | null {
  if (card.directory_id === null) return null;
  return appUrl(`${card.library === "music" ? "music" : "movies"}/?directory=${card.directory_id}`);
}

export async function mount(): Promise<void> {
  const shell = await mountShell("home", "Twoje media", "Panel główny");
  const { content, session, player } = shell;
  const viewer = new MediaViewer(session, () => player.pause());
  const leaving = new AbortController();
  document.addEventListener("media:route-will-change", () => {
    leaving.abort();
    void viewer.destroy();
  }, { once: true });

  const access: LibraryAccess = { music: canAccessLibrary(session, "music"), movies: canAccessLibrary(session, "movies") };
  const root = el("div", { className: "home" });
  content.append(root);
  let current: HomeData | null = null;
  let layoutObserver: ResizeObserver | null = null;
  leaving.signal.addEventListener("abort", () => layoutObserver?.disconnect());

  const remember = (data: HomeData): void => {
    current = data;
    remembered = { userId: session.user.id, data };
  };

  /**
   * Start what a card stands for.
   *
   * A film opens in the viewer, where it was left if it was. A track starts as a
   * queue of one so that playback begins at once, and the folder it sits in is
   * paged in around it, exactly as the library does when a card is pressed. On
   * the shelf of random tracks the shelf itself is the queue: the track pressed
   * and everything after it.
   */
  const start = async (card: HomeCard, shelf: VisibleShelf | null): Promise<void> => {
    const item = card.item;
    const positionMs = card.position_ms ?? card.series?.resume_ms ?? 0;
    if (item.media_kind !== "audio") {
      await viewer.open(item, positionMs / 1000);
      return;
    }
    const context = shelf ? t(shelf.definition.title) : t("Zaskocz mnie");
    if (shelf?.definition.id === "random_tracks") {
      const tracks = shelf.cards.map((entry) => entry.item).filter((entry) => entry.media_kind === "audio");
      await player.setQueue(tracks, item.id, true, { offset: 0, total: tracks.length, context });
      return;
    }
    await player.setQueue([item], item.id, true, { offset: 0, total: 1, context, resumeSeconds: positionMs / 1000 });
    const directoryId = card.directory_id;
    if (directoryId === null) return;
    player.setQueuePaging((direction, cursor) => getQueuePage(directoryId, cursor, 160, direction), true, true);
    // The folder's own name, so the dock can say what is playing.
    const folder = card.folder?.name ?? item.relative_path.split("/").slice(0, -1).at(-1) ?? "";
    player.setQueueSource({ kind: "directory", id: directoryId, query: "", shuffleMode: "off", shuffleSeed: "", label: folder });
    void player.prefetchAfter();
  };
  /** A card that was pressed and did nothing is the worst answer there is: a failure is said. */
  const play = (card: HomeCard, shelf: VisibleShelf | null): void => {
    void start(card, shelf).catch(() => {
      showToast(t("Nie udało się rozpocząć odtwarzania. Spróbuj ponownie."), "error");
    });
  };

  /** Take a card off the page for good: forget its position, or stop the suggestion. */
  const dismiss = async (card: HomeCard): Promise<void> => {
    const kind = dismissKind(card);
    if (kind === "continue") await dismissContinue(card.item.id);
    else {
      const count = await dismissHomeCard(card.key);
      if (current) current = { ...current, dismissed_count: count };
    }
    if (current) remember(withoutCard(current, card.key, kind));
  };

  // --- One card of a shelf ------------------------------------------------------
  const shelfCard = (card: HomeCard, shelf: VisibleShelf): HTMLElement => {
    const title = cardTitle(card);
    const { lines, badge, reason } = describe(card, shelf.definition);
    const visual = cover(card, "shelf-card__cover");
    const badges = cardLook(card) === "film" ? pictureBadges(card.item) : null;
    if (badges) visual.append(badges);
    if (card.type === "folder") {
      // A folder offered whole: a small mark in the corner, not a glyph across the picture.
      visual.append(el("span", { className: "shelf-card__folder", attrs: { "aria-hidden": "true" } }, icon("folder")));
    }
    const progress = progressLine(card, "shelf-card__progress");
    if (progress) visual.append(progress);
    visual.append(el("span", { className: "shelf-card__play", attrs: { "aria-hidden": "true" } }, icon("play")));
    const open = el(
      "button",
      { className: "shelf-card__open", attrs: { type: "button", "aria-label": t("Odtwórz {title}", { title }) } },
      visual
    );
    open.addEventListener("click", () => play(card, shelf));
    const address = libraryAddress(card);
    const heading = el("h3", { className: "shelf-card__title", attrs: { title: card.item.relative_path } },
      address
        ? el("a", { attrs: { href: address, title: t("Otwórz w bibliotece: {title}", { title }) }, text: title })
        : title);
    const node = el(
      "article",
      { className: `shelf-card shelf-card--${cardLook(card)}`, dataset: { key: card.key } },
      open,
      el(
        "div",
        { className: "shelf-card__body" },
        badge ? el("span", { className: "shelf-card__badge", text: badge }) : null,
        heading,
        ...lines.map((line) => el("p", { className: "shelf-card__meta", text: line, attrs: { title: line } })),
        reason ? el("p", { className: "shelf-card__reason", text: reason, attrs: { title: reason } }) : null
      )
    );
    if (current?.can_dismiss) {
      const forget = dismissKind(card) === "continue";
      const remove = el(
        "button",
        {
          className: "shelf-card__dismiss icon-button",
          attrs: {
            type: "button",
            "aria-label": forget ? t("Usuń „{title}” z listy", { title }) : t("Nie proponuj „{title}”", { title })
          }
        },
        icon("close")
      );
      remove.dataset.tooltip = forget ? t("To już obejrzałem — ukryj (historia odtwarzania zostaje)") : t("Nie proponuj");
      remove.addEventListener("click", () => {
        remove.disabled = true;
        void dismiss(card)
          .then(() => {
            const row = node.parentElement;
            // The same thing may stand on other shelves too; a suggestion declined leaves them all.
            const twins = forget ? [] : Array.from(root.querySelectorAll<HTMLElement>(".shelf-card")).filter((other) => other !== node && other.dataset.key === card.key && !other.closest('[data-dismiss="continue"]'));
            for (const twin of twins) {
              const twinRow = twin.parentElement;
              removeFromList(twin, () => twinRow?.dispatchEvent(new CustomEvent("media:card-removed")));
            }
            removeFromList(node, () => row?.dispatchEvent(new CustomEvent("media:card-removed")));
            renderFooter();
          })
          .catch((error: unknown) => {
            remove.disabled = false;
            showToast(failureText(error, t("Nie udało się ukryć tej pozycji.")), "error");
          });
      });
      node.append(remove);
    }
    return node;
  };

  // --- One shelf ----------------------------------------------------------------
  const shelves = el("div", { className: "home-shelves" });
  const shelfRows: Array<{ row: HTMLElement; sync: () => void }> = [];

  const shelfSection = (shelf: VisibleShelf, entering: boolean): HTMLElement => {
    const definition = shelf.definition;
    const headingId = `shelf-${definition.id}`;
    let shown = shelf;
    let expanded = false;
    let complete = !shelf.hasMore || definition.random;
    const row = el("div", { className: `shelf__row shelf__row--${definition.look}` });
    const more = el("button", { className: "button button--quiet shelf__more", attrs: { type: "button", "aria-expanded": "false" } });
    const moreLabel = el("span", {});
    more.append(moreLabel, icon("chevron"));
    const reroll = definition.random
      ? el("button", {
          className: "button button--secondary shelf__reroll",
          attrs: { type: "button", "aria-label": t("Wylosuj inne: {shelf}", { shelf: t(definition.title) }) }
        }, icon("dice"), el("span", { className: "shelf__reroll-label", text: t("Wylosuj inne") })) as HTMLButtonElement
      : null;
    const section = el(
      "section",
      { className: "shelf", attrs: { "aria-labelledby": headingId }, dataset: { shelf: definition.id, dismiss: definition.dismiss, ...(definition.random ? { quick: "true" } : {}) } },
      el(
        "header",
        { className: "shelf__header" },
        el("div", { className: "shelf__heading" },
          el("h2", { text: t(definition.title), attrs: { id: headingId } }),
          el("p", { className: "shelf__hint", text: t(definition.hint) })),
        el("div", { className: "shelf__actions" }, reroll, more)
      ),
      row
    );
    /** A phone scrolls the row sideways and shows every card; a wide screen shows one line of a grid. */
    const scrolls = (): boolean => getComputedStyle(row).gridAutoFlow.includes("column");
    const sync = (): void => {
      const cards = Array.from(row.querySelectorAll<HTMLElement>(".shelf-card"));
      if (scrolls()) {
        for (const node of cards) node.classList.remove("is-beyond-row");
        // Sideways everything loaded is reachable; the button is for what the bridge still holds.
        more.classList.toggle("hidden", complete);
        moreLabel.textContent = t("Więcej");
        return;
      }
      const columns = getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean).length;
      const capacity = rowCapacity(columns);
      cards.forEach((node, index) => node.classList.toggle("is-beyond-row", !expanded && capacity > 0 && index >= capacity));
      const hidden = !expanded && (cards.length > capacity || !complete);
      more.classList.toggle("hidden", !(hidden || expanded));
      moreLabel.textContent = expanded ? t("Zwiń") : t("Zobacz wszystkie");
      more.setAttribute("aria-expanded", String(expanded));
      row.dataset.expanded = String(expanded);
    };
    const fill = (cards: HomeCard[], arriving: boolean): void => {
      shown = { ...shown, cards };
      row.replaceChildren(...cards.map((card) => shelfCard(card, shown)));
      if (arriving) arrive(row);
      sync();
    };
    more.addEventListener("click", () => {
      const scroller = scrolls();
      if (complete) {
        if (scroller) return;
        expanded = !expanded;
        sync();
        return;
      }
      more.disabled = true;
      void getHome({ shelf: definition.id, limit: FULL_SHELF, signal: leaving.signal })
        .then((answer) => {
          const full = answer.shelves?.[definition.id];
          complete = true;
          expanded = !scroller;
          if (full && full.cards.length > 0) {
            const heroKey = current?.hero?.key ?? null;
            const known = new Set(shown.cards.map((card) => card.key));
            const fresh = full.cards.filter((card) => !known.has(card.key) && !(definition.dismiss === "continue" && card.key === heroKey));
            // What is on screen stays where it is; the rest is added after it.
            shown = { ...shown, cards: [...shown.cards, ...fresh] };
            const added = fresh.map((card) => shelfCard(card, shown));
            for (const node of added) node.dataset.appended = "true";
            row.append(...added);
          }
          sync();
        })
        .catch((error: unknown) => {
          if (!isAborted(error)) showToast(failureText(error, t("Nie udało się wczytać całej półki.")), "error");
        })
        .finally(() => { more.disabled = false; });
    });
    reroll?.addEventListener("click", () => {
      reroll.disabled = true;
      reroll.classList.add("is-rolling");
      void getHome({ shelf: definition.id, seed: newSeed(), signal: leaving.signal })
        .then((answer) => {
          const drawn = answer.shelves?.[definition.id];
          if (!drawn || drawn.cards.length === 0) {
            showToast(t("Nie ma z czego losować."), "info");
            return;
          }
          if (current) remember(withShelf(current, definition.id, drawn));
          expanded = false;
          row.scrollTo({ left: 0, behavior: "auto" });
          fill(drawn.cards, true);
          reroll.classList.toggle("hidden", drawn.has_more !== true);
        })
        .catch((error: unknown) => {
          if (!isAborted(error)) showToast(failureText(error, t("Nie udało się wylosować. Spróbuj ponownie.")), "error");
        })
        .finally(() => {
          reroll.disabled = false;
          reroll.classList.remove("is-rolling");
        });
    });
    // Nothing more to draw from than is shown: another roll would bring the same cards.
    reroll?.classList.toggle("hidden", !shelf.hasMore);
    // A row that empties as its last card is dismissed takes its heading with it.
    row.addEventListener("media:card-removed", () => {
      if (row.querySelector(".shelf-card") === null) section.remove();
      else sync();
    });
    shelfRows.push({ row, sync });
    fill(shelf.cards, entering);
    return section;
  };

  // --- The top: the title to carry on with, or a greeting -------------------------
  const top = el("div", { className: "home-top" });

  const heroSection = (card: HomeCard): HTMLElement => {
    const title = cardTitle(card);
    const film = cardLook(card) === "film";
    const code = episodeCode(card.work);
    const facts = film
      ? [code ?? "", card.work?.year ? String(card.work.year) : "", ...genreNames(card, 2)]
      : [card.item.artist ?? "", card.item.album ?? ""];
    const backdrop = cover(card, "home-hero__backdrop", true);
    backdrop.setAttribute("aria-hidden", "true");
    const picture = cover(card, "home-hero__cover", true);
    picture.append(el("span", { className: "home-hero__play", attrs: { "aria-hidden": "true" } }, icon("play")));
    const progress = progressLine(card, "home-hero__progress");
    const resume = el("button", { className: "button button--primary home-hero__resume", attrs: { type: "button" } }, icon("play"), t("Wznów"));
    resume.addEventListener("click", () => play(card, null));
    const open = el("button", { className: "home-hero__open", attrs: { type: "button", "aria-label": t("Wznów „{title}”", { title }) } }, picture);
    open.addEventListener("click", () => play(card, null));
    const actions = el("div", { className: "home-hero__actions" }, resume);
    if (current?.can_dismiss) {
      const remove = el("button", { className: "button button--quiet home-hero__dismiss", attrs: { type: "button" } }, t("Usuń z listy"));
      remove.dataset.tooltip = t("To już obejrzałem — ukryj (historia odtwarzania zostaje)");
      remove.addEventListener("click", () => {
        remove.disabled = true;
        void dismiss(card)
          // Whatever was second in line is the one to carry on with now; the bridge knows which.
          .then(() => refresh(true))
          .catch((error: unknown) => {
            remove.disabled = false;
            showToast(failureText(error, t("Nie udało się ukryć tej pozycji.")), "error");
          });
      });
      actions.append(remove);
    }
    const address = libraryAddress(card);
    return el(
      "section",
      { className: `home-hero home-hero--${cardLook(card)}`, attrs: { "aria-labelledby": "home-hero-title" } },
      backdrop,
      el(
        "div",
        { className: "home-hero__body" },
        el("span", { className: "eyebrow", text: film ? t("Kontynuuj oglądanie") : t("Kontynuuj słuchanie") }),
        el("h2", { className: "home-hero__title", attrs: { id: "home-hero-title", title: card.item.relative_path } },
          address ? el("a", { attrs: { href: address }, text: title }) : title),
        facts.filter(Boolean).length > 0 ? el("p", { className: "home-hero__facts", text: facts.filter(Boolean).join(" · ") }) : null,
        progress,
        el("p", { className: "home-hero__status", text: progressLabel(card) }),
        actions
      ),
      open
    );
  };

  const greeting = (): HTMLElement => {
    const hour = new Date().getHours();
    const words = hour >= 18 || hour < 5 ? t("Dobry wieczór, {name}", { name: session.user.username }) : t("Dzień dobry, {name}", { name: session.user.username });
    return el(
      "section",
      { className: "home-greeting" },
      el("span", { className: "eyebrow", text: t("Start") }),
      el("h2", { className: "home-greeting__title", text: words }),
      el("p", { className: "muted", text: t("Nic nie czeka na dokończenie. Wybierz bibliotekę albo coś z półek poniżej.") })
    );
  };

  // --- The libraries ---------------------------------------------------------------
  const libraries = el("nav", { className: "home-libraries", attrs: { "aria-label": t("Biblioteki") } });

  const libraryTile = (kind: LibraryKind, counts: HomeLibrary | null): HTMLElement => {
    const music = kind === "music";
    const facts = counts === null
      ? [music ? t("Albumy, wykonawcy i playlisty") : t("Filmy i seriale z napisami")]
      : music
        ? [
            tn(counts.item_count, { one: "{count} utwór", few: "{count} utwory", many: "{count} utworów" }),
            tn(counts.folder_count, { one: "{count} folder", few: "{count} foldery", many: "{count} folderów" })
          ]
        : [
            tn(counts.film_count, { one: "{count} film", few: "{count} filmy", many: "{count} filmów" }),
            counts.series_count > 0 ? tn(counts.series_count, { one: "{count} serial", few: "{count} seriale", many: "{count} seriali" }) : "",
            counts.episode_count > 0 ? tn(counts.episode_count, { one: "{count} odcinek", few: "{count} odcinki", many: "{count} odcinków" }) : ""
          ];
    return el(
      "a",
      { className: "home-library", attrs: { href: appUrl(music ? "music/" : "movies/") } },
      el("span", { className: "home-library__icon" }, icon(music ? "music" : "film")),
      el(
        "span",
        { className: "home-library__copy" },
        el("strong", { text: music ? t("Muzyka") : t("Filmy") }),
        // Each count is a word of its own: on a narrow tile they wrap whole, one under another.
        el("span", { className: "home-library__facts" }, ...facts.filter(Boolean).map((fact) => el("span", { text: fact })))
      ),
      counts !== null && counts.recent_count > 0
        ? el("span", {
            className: "home-library__new",
            text: `+${formatCount(counts.recent_count)}`,
            attrs: { title: tn(counts.recent_count, { one: "{count} nowy plik w ostatnich 30 dniach", few: "{count} nowe pliki w ostatnich 30 dniach", many: "{count} nowych plików w ostatnich 30 dniach" }) }
          })
        : null,
      icon("arrow")
    );
  };

  const renderLibraries = (data: HomeData | null): void => {
    const kinds: LibraryKind[] = [];
    if (access.music) kinds.push("music");
    if (access.movies) kinds.push("movies");
    libraries.replaceChildren(...kinds.map((kind) => libraryTile(kind, data?.libraries?.find((library) => library.kind === kind) ?? null)));
    libraries.classList.toggle("hidden", kinds.length === 0);
  };

  // --- "Zaskocz mnie" ---------------------------------------------------------------
  const surprise = el("section", { className: "home-surprise", attrs: { "aria-labelledby": "home-surprise-title" } });

  const pick = (card: HomeCard, label: string): HTMLElement => {
    const title = cardTitle(card);
    const film = cardLook(card) === "film";
    const facts = film
      ? [card.work?.year ? String(card.work.year) : "", ...genreNames(card, 2), card.item.duration_ms ? formatDuration(card.item.duration_ms) : ""]
      : [card.folder?.artist ?? card.item.artist ?? "", card.folder ? tn(card.folder.item_count, { one: "{count} utwór", few: "{count} utwory", many: "{count} utworów" }) : ""];
    const visual = cover(card, "home-pick__cover");
    const badges = film ? pictureBadges(card.item) : null;
    if (badges) visual.append(badges);
    visual.append(el("span", { className: "shelf-card__play", attrs: { "aria-hidden": "true" } }, icon("play")));
    const open = el("button", { className: "home-pick__open", attrs: { type: "button", "aria-label": t("Odtwórz {title}", { title }) } }, visual);
    open.addEventListener("click", () => play(card, null));
    const go = el("button", { className: "button button--primary", attrs: { type: "button" } }, icon("play"), t("Odtwórz"));
    go.addEventListener("click", () => play(card, null));
    const address = libraryAddress(card);
    return el(
      "article",
      { className: `home-pick home-pick--${cardLook(card)}`, dataset: { key: card.key } },
      open,
      el(
        "div",
        { className: "home-pick__body" },
        el("span", { className: "eyebrow", text: label }),
        el("h3", { className: "home-pick__title", attrs: { title: card.item.relative_path } }, address ? el("a", { attrs: { href: address }, text: title }) : title),
        facts.filter(Boolean).length > 0 ? el("p", { className: "muted home-pick__facts", text: facts.filter(Boolean).join(" · ") }) : null,
        go
      )
    );
  };

  const renderSurprise = (data: HomeSurprise | undefined, entering: boolean): void => {
    const picks: HTMLElement[] = [];
    if (data?.album && access.music) picks.push(pick(data.album, t("Album")));
    if (data?.film && access.movies) picks.push(pick(data.film, t("Film")));
    surprise.classList.toggle("hidden", picks.length === 0);
    if (picks.length === 0) {
      surprise.replaceChildren();
      return;
    }
    const again = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("dice"), t("Losuj ponownie"));
    again.addEventListener("click", () => {
      again.disabled = true;
      again.classList.add("is-rolling");
      void getHome({ shelf: "surprise", seed: newSeed(), signal: leaving.signal })
        .then((answer) => {
          if (!answer.surprise) return;
          if (current) remember({ ...current, surprise: answer.surprise });
          return viewTransition(() => renderSurprise(answer.surprise, false));
        })
        .catch((error: unknown) => {
          if (!isAborted(error)) showToast(failureText(error, t("Nie udało się wylosować. Spróbuj ponownie.")), "error");
        })
        .finally(() => {
          again.disabled = false;
          again.classList.remove("is-rolling");
        });
    });
    const row = el("div", { className: `home-surprise__picks${picks.length === 1 ? " home-surprise__picks--single" : ""}` }, ...picks);
    if (entering) arrive(row);
    surprise.replaceChildren(
      el(
        "header",
        { className: "shelf__header" },
        el("div", { className: "shelf__heading" },
          el("h2", { text: t("Zaskocz mnie"), attrs: { id: "home-surprise-title" } }),
          el("p", { className: "shelf__hint", text: t("Jeden album i jeden film — wybrane za Ciebie.") })),
        el("div", { className: "shelf__actions" }, again)
      ),
      row
    );
  };

  // --- What was hidden, and the way back -----------------------------------------------
  const footer = el("p", { className: "home-footer hidden" });
  function renderFooter(): void {
    const count = current?.can_dismiss ? current.dismissed_count : 0;
    footer.classList.toggle("hidden", count < 1);
    if (count < 1) {
      footer.replaceChildren();
      return;
    }
    const restore = el("button", { className: "button button--quiet", attrs: { type: "button" } }, t("Przywróć wszystkie"));
    restore.addEventListener("click", () => {
      restore.disabled = true;
      void restoreHomeCards()
        .then(() => refresh(true))
        .catch((error: unknown) => {
          restore.disabled = false;
          showToast(failureText(error, t("Nie udało się przywrócić propozycji.")), "error");
        });
    });
    footer.replaceChildren(
      el("span", { text: tn(count, { one: "Ukryta propozycja: {count}", few: "Ukryte propozycje: {count}", many: "Ukrytych propozycji: {count}" }) }),
      restore
    );
  }

  // --- The whole page ---------------------------------------------------------------------
  const paint = (data: HomeData, entering: boolean): void => {
    remember(data);
    root.removeAttribute("aria-busy");
    top.replaceChildren(data.hero ? heroSection(data.hero) : greeting());
    renderLibraries(data);
    shelfRows.length = 0;
    const visible = visibleShelves(data, access);
    shelves.replaceChildren(...visible.map((shelf) => shelfSection(shelf, entering)));
    renderSurprise(data.surprise, entering);
    renderFooter();
    const nothing = !data.hero && visible.length === 0 && surprise.classList.contains("hidden");
    const empty = nothing
      ? el("div", { className: "empty-state" }, el("p", {
          text: access.music || access.movies
            ? t("Biblioteka nie ma jeszcze nic do zaproponowania. Wróć po pierwszym skanie.")
            : t("To konto nie ma dostępu do żadnej biblioteki.")
        }))
      : null;
    root.replaceChildren(top, libraries, ...(empty ? [empty] : []), shelves, surprise, footer);
    // The number of columns is the window's to decide, so the one-line cap is
    // decided again whenever the shelves are laid out anew.
    layoutObserver?.disconnect();
    if ("ResizeObserver" in window) {
      layoutObserver = new ResizeObserver(() => { for (const entry of shelfRows) entry.sync(); });
      layoutObserver.observe(shelves);
    }
    for (const entry of shelfRows) entry.sync();
  };

  /** Placeholders in the shape of the page, for the moment before its first answer. */
  const paintSkeleton = (): void => {
    root.setAttribute("aria-busy", "true");
    const cards = (look: string): HTMLElement[] => Array.from({ length: 6 }, () => el(
      "div",
      { className: `shelf-card shelf-card--${look} shelf-card--skeleton` },
      el("span", { className: `shelf-card__cover shelf-card__cover--${look} skeleton` }),
      el("div", { className: "shelf-card__body" }, el("span", { className: "skeleton skeleton--line" }), el("span", { className: "skeleton skeleton--line skeleton--short" }))
    ));
    root.replaceChildren(el(
      "div",
      { className: "home-skeleton", attrs: { "aria-hidden": "true" } },
      el("div", { className: "home-hero home-hero--skeleton skeleton" }),
      el("div", { className: "home-libraries" }, ...Array.from({ length: Math.max(1, Number(access.music) + Number(access.movies)) }, () => el("span", { className: "home-library home-library--skeleton skeleton" }))),
      ...expectedShelves(access).slice(0, 3).map((definition) => el(
        "section",
        { className: "shelf" },
        el("header", { className: "shelf__header" }, el("span", { className: "skeleton skeleton--line shelf__title-skeleton" })),
        el("div", { className: `shelf__row shelf__row--${definition.look === "mixed" ? "music" : definition.look}` }, ...cards(definition.look === "mixed" ? "music" : definition.look))
      ))
    ), el("p", { className: "sr-only", attrs: { role: "status" }, text: t("Wczytywanie strony startowej…") }));
  };

  /** The page could not be read: the libraries are still doors, and the rest can be asked for again. */
  const paintFailure = (error: unknown): void => {
    root.removeAttribute("aria-busy");
    renderLibraries(null);
    const retry = el("button", { className: "button button--secondary", attrs: { type: "button" } }, icon("refresh"), t("Spróbuj ponownie"));
    retry.addEventListener("click", () => {
      retry.disabled = true;
      paintSkeleton();
      void load();
    });
    root.replaceChildren(
      greeting(),
      libraries,
      el("div", { className: "notice notice--error notice--action", attrs: { role: "alert" } },
        el("span", { text: failureText(error, t("Nie udało się wczytać propozycji na stronę startową.")) }), retry)
    );
  };

  /** The first answer of this visit. */
  async function load(): Promise<void> {
    try {
      const data = await getHome({ signal: leaving.signal });
      if (leaving.signal.aborted) return;
      // Over placeholders the page fades in; it does not need to arrive card by card as well.
      await viewTransition(() => paint(data, true));
    } catch (error) {
      if (isAborted(error) || leaving.signal.aborted) return;
      // Signed out: api.ts is already on its way to the sign-in page.
      if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401) throw error;
      paintFailure(error);
    }
  }

  /**
   * Ask again behind a page that is already drawn, and draw it again only when
   * the answer differs. What was drawn at random on this visit stays as it was
   * drawn: a re-roll is the reader's choice, and the page's own request would
   * bring back the draw of the day.
   */
  async function refresh(force = false): Promise<void> {
    try {
      const data = await getHome({ signal: leaving.signal });
      if (leaving.signal.aborted) return;
      const before = current;
      const merged: HomeData = { ...data };
      if (before && !force) {
        const kept = { ...(data.shelves ?? {}) };
        for (const [id, shelf] of Object.entries(before.shelves ?? {})) {
          if (shelf.seed !== undefined && kept[id] !== undefined) kept[id] = shelf;
        }
        merged.shelves = kept;
        if (before.surprise) merged.surprise = before.surprise;
      }
      if (before && !force && homeSignature(before) === homeSignature(merged)) {
        remember(merged);
        return;
      }
      await viewTransition(() => paint(merged, false));
    } catch (error) {
      // A page that is on screen stays on screen; the next visit asks again.
      if (!isAborted(error) && force) showToast(failureText(error, t("Nie udało się odświeżyć strony startowej.")), "error");
    }
  }

  const cached = remembered?.userId === session.user.id ? remembered.data : null;
  if (cached) {
    paint(cached, true);
    void refresh();
    return;
  }
  paintSkeleton();
  await load();
}
