import type { HomeCard, HomeData, HomeShelf, HomeWork, LibraryKind } from "./types";

/**
 * The start page's shelves as data: which there are, in what order, and what
 * the answer of `home` turns into before anything is drawn.
 *
 * Kept apart from the page (pages/home.ts) so that it needs no browser: the
 * page asks these questions and builds elements from the answers, and the
 * answers are tested in Node. Types are the only import.
 */

/** The shape of a shelf's cards: a 16:9 still, a square cover, or whichever each card's own library says. */
export type ShelfLook = "film" | "music" | "mixed";

export interface ShelfDefinition {
  /** The key of the shelf in the bridge's answer. */
  id: string;
  /** The library the account must be able to open for the shelf to exist; null for one that holds both. */
  library: LibraryKind | null;
  look: ShelfLook;
  /** Polish source text of the heading and of the line under it (translated where they are drawn). */
  title: string;
  hint: string;
  /** Drawn at random: the shelf can be drawn again ("Wylosuj inne"). */
  random: boolean;
  /** How its cards are taken off: "continue" forgets a saved position, "home" stops a suggestion. */
  dismiss: "continue" | "home";
}

/**
 * Every shelf, in the order of the page.
 *
 * What was begun comes first, then what follows it; then the quick ways to play
 * something without choosing (the random shelves); then what is new, what is
 * recommended and why, and what the household plays. A shelf the bridge does
 * not send (an older bridge has no random ones) is simply not drawn.
 */
export const SHELVES: readonly ShelfDefinition[] = [
  { id: "continue_movies", library: "movies", look: "film", title: "Kontynuuj oglądanie", hint: "Filmy i odcinki zatrzymane w połowie — wracają do zapisanej sekundy.", random: false, dismiss: "continue" },
  { id: "continue_music", library: "music", look: "music", title: "Kontynuuj słuchanie", hint: "Długie nagrania i utwory przerwane w połowie.", random: false, dismiss: "continue" },
  { id: "next_episodes", library: "movies", look: "film", title: "Następne odcinki", hint: "Ciąg dalszy tego, co masz już za sobą.", random: false, dismiss: "home" },
  { id: "random_films", library: "movies", look: "film", title: "Losowe filmy", hint: "Na szybki seans — bez wybierania.", random: true, dismiss: "home" },
  { id: "random_series", library: "movies", look: "film", title: "Losowe seriale", hint: "Każdy zaczyna się tam, gdzie go zostawiłeś.", random: true, dismiss: "home" },
  { id: "random_tracks", library: "music", look: "music", title: "Losowe utwory", hint: "Jedno naciśnięcie i gra cała półka.", random: true, dismiss: "home" },
  { id: "recent_movies", library: "movies", look: "film", title: "Ostatnio dodane filmy", hint: "Nowe filmy i odcinki w bibliotece.", random: false, dismiss: "home" },
  { id: "recent_music", library: "music", look: "music", title: "Ostatnio dodana muzyka", hint: "Nowe albumy i utwory w bibliotece.", random: false, dismiss: "home" },
  { id: "recommended_movies", library: "movies", look: "film", title: "Polecane filmy i seriale", hint: "Dobrane do tego, co lubisz i wysoko oceniasz.", random: false, dismiss: "home" },
  { id: "recommended_music", library: "music", look: "music", title: "Polecana muzyka", hint: "Wykonawcy i gatunki z Twoich ulubionych.", random: false, dismiss: "home" },
  { id: "popular", library: null, look: "mixed", title: "Popularne w domu", hint: "Grane ostatnio przez domowników, a przez Ciebie jeszcze nie.", random: false, dismiss: "home" }
];

export function shelfDefinition(id: string): ShelfDefinition | undefined {
  return SHELVES.find((shelf) => shelf.id === id);
}

export interface LibraryAccess {
  music: boolean;
  movies: boolean;
}

export interface VisibleShelf {
  definition: ShelfDefinition;
  cards: HomeCard[];
  hasMore: boolean;
  seed: string | null;
}

/**
 * The shelves to draw, in order, each with the cards it shows.
 *
 * - The hero is also a card of a "continue" shelf; drawn large at the top, it
 *   is left out of the row.
 * - A shelf with nothing on it is not drawn at all: an empty section on the
 *   start page is noise, not information.
 * - A shelf of a library the account cannot open is not drawn even if the
 *   answer carried it.
 */
export function visibleShelves(home: HomeData, access: LibraryAccess): VisibleShelf[] {
  const heroKey = home.hero?.key ?? null;
  const visible: VisibleShelf[] = [];
  for (const definition of SHELVES) {
    if (definition.library !== null && !access[definition.library]) continue;
    const shelf = home.shelves?.[definition.id];
    if (!shelf || !Array.isArray(shelf.cards)) continue;
    const cards = definition.dismiss === "continue" && heroKey !== null
      ? shelf.cards.filter((card) => card.key !== heroKey)
      : shelf.cards.filter((card) => definition.library !== null || access[card.library]);
    if (cards.length === 0) continue;
    visible.push({ definition, cards, hasMore: shelf.has_more === true, seed: typeof shelf.seed === "string" ? shelf.seed : null });
  }
  return visible;
}

/** The shelves a page of this account can have at all — one placeholder row each while the answer is on its way. */
export function expectedShelves(access: LibraryAccess): ShelfDefinition[] {
  return SHELVES.filter((shelf) => (shelf.library === null ? access.music || access.movies : access[shelf.library]));
}

/** A film still or a record cover: what shape the card's picture has. */
export function cardLook(card: Pick<HomeCard, "library">): "film" | "music" {
  return card.library === "movies" ? "film" : "music";
}

/** "S03E02", "E07" when the file names carry no season, or null for anything that is not an episode. */
export function episodeCode(work: Pick<HomeWork, "season" | "episode"> | null | undefined): string | null {
  if (!work || work.episode === null || work.episode === undefined) return null;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return work.season !== null && work.season !== undefined ? `S${pad(work.season)}E${pad(work.episode)}` : `E${pad(work.episode)}`;
}

/**
 * What a card is called.
 *
 * A folder offered whole is called what the folder is called — except a season,
 * which is called after its series (a folder named "S01" says nothing by
 * itself). A video is called by the catalogue's matched title when there is
 * one: the file's own title is its file name, brackets and codecs included. A
 * series card is called after the series. Everything else has its own title.
 */
export function cardTitle(card: HomeCard): string {
  if (card.series?.title) return card.series.title;
  if (card.type === "folder" && card.folder) {
    if (card.library === "movies" && card.work?.title) return card.work.title;
    return card.folder.name || card.item.title;
  }
  if (card.library === "movies") return card.work?.title ?? fileTitle(card.item.title);
  return card.item.title;
}

/**
 * A film's title as read from its file name, made readable: release names join
 * their words with underscores ("Gumisie_S03E02_Na twoim miejscu"), which a
 * heading can neither wrap at nor read aloud. Nothing else is touched — the
 * name is still the file's.
 */
export function fileTitle(title: string): string {
  return title.includes("_") ? title.replace(/_+/g, " ").replace(/\s{2,}/g, " ").trim() || title : title;
}

/** How a card is taken off the page: a saved position is forgotten, a suggestion is declined. */
export function dismissKind(card: HomeCard): "continue" | "home" {
  return card.position_ms !== undefined ? "continue" : "home";
}

/** Whole percent of the way through, 1–99 for anything on a "continue" shelf; null when the card carries no progress. */
export function progressPercent(card: Pick<HomeCard, "progress">): number | null {
  if (typeof card.progress !== "number" || !Number.isFinite(card.progress)) return null;
  return Math.min(99, Math.max(1, Math.round(card.progress * 100)));
}

/** A length of time as whole hours and minutes, for a sentence ("1 g 12 min"), not a timeline. */
export function hoursAndMinutes(milliseconds: number): { hours: number; minutes: number } {
  const total = Math.round(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 60000);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** Whole days between an instant and now; 0 for today, null when the instant cannot be read. */
export function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86400000));
}

/** How many cards one row of a grid with this many columns shows. */
export function rowCapacity(columns: number, rows = 1): number {
  return columns >= 1 && rows >= 1 ? Math.floor(columns) * Math.floor(rows) : 0;
}

/**
 * The answer with one card taken out, as the bridge will answer from now on.
 *
 * "continue" forgets a saved position: the card leaves the "continue" shelves,
 * and the hero if it was the hero. "home" declines a suggestion: the card leaves
 * every other shelf and the surprise — the same key is the same thing wherever
 * it stands. Nothing is mutated; the cache keeps a new object.
 */
export function withoutCard(home: HomeData, key: string, kind: "continue" | "home"): HomeData {
  const shelves: Record<string, HomeShelf> = {};
  for (const [id, shelf] of Object.entries(home.shelves ?? {})) {
    const own = (shelfDefinition(id)?.dismiss ?? "home") === kind;
    shelves[id] = own ? { ...shelf, cards: shelf.cards.filter((card) => card.key !== key) } : shelf;
  }
  const next: HomeData = { ...home, shelves };
  if (kind === "continue" && home.hero?.key === key) next.hero = null;
  if (kind === "home" && home.surprise) {
    next.surprise = {
      ...home.surprise,
      album: home.surprise.album?.key === key ? null : home.surprise.album,
      film: home.surprise.film?.key === key ? null : home.surprise.film
    };
  }
  return next;
}

/** The answer with one shelf replaced (a re-roll, "Zobacz wszystkie"). */
export function withShelf(home: HomeData, id: string, shelf: HomeShelf): HomeData {
  return { ...home, shelves: { ...(home.shelves ?? {}), [id]: shelf } };
}

/**
 * What of the answer the page shows, as one string: two answers with the same
 * signature draw the same page.
 *
 * The page keeps its last answer and paints it at once when the reader comes
 * back, then asks again; `generated_at` differs on every answer, so comparing
 * that would redraw the page every time for nothing. This compares what would
 * actually be drawn: which cards stand where, how far each has got, the counts.
 */
export function homeSignature(home: HomeData): string {
  const card = (entry: HomeCard | null | undefined): string => entry
    ? [entry.key, entry.progress ?? "", entry.added_count ?? "", entry.listeners ?? "", entry.because?.label ?? "", entry.series?.start ?? "", entry.item.favorite ? 1 : 0, entry.item.rating ?? ""].join(":")
    : "-";
  const parts: string[] = [
    `d${home.can_dismiss ? 1 : 0}`,
    `n${home.dismissed_count}`,
    `h${card(home.hero)}`,
    ...(home.libraries ?? []).map((library) => `l${library.kind}:${library.item_count}:${library.folder_count}:${library.recent_count}:${library.series_count}`)
  ];
  for (const definition of SHELVES) {
    const shelf = home.shelves?.[definition.id];
    if (!shelf) continue;
    parts.push(`${definition.id}[${shelf.has_more ? "+" : ""}${shelf.seed ?? ""}]${shelf.cards.map(card).join(",")}`);
  }
  parts.push(`s${home.surprise?.seed ?? ""}:${card(home.surprise?.album)}:${card(home.surprise?.film)}`);
  return parts.join("|");
}
