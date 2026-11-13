import assert from "node:assert/strict";
import test from "node:test";

import {
  SHELVES, cardLook, cardTitle, daysSince, dismissKind, episodeCode, expectedShelves, fileTitle, homeSignature, hoursAndMinutes,
  progressPercent, rowCapacity, shelfDefinition, visibleShelves, withShelf, withoutCard
} from "./home-model.ts";
import type { HomeCard, HomeData, MediaItem } from "./types.ts";

function item(id: number, title: string, kind: "audio" | "video" = "video"): MediaItem {
  return {
    id, relative_path: `x/${title}`, media_kind: kind, mime_type: null, file_extension: kind === "video" ? "mkv" : "mp3", title,
    artist: null, album: null, year: null, genre: null, duration_ms: 3_600_000, size_bytes: 1, bitrate: null, sample_rate: null,
    channels: null, favorite: false, rating: null, play_count: 0, avg_rating: 0, rating_count: 0, favorite_count: 0
  };
}

function card(id: number, title: string, extra: Partial<HomeCard> = {}): HomeCard {
  const library = extra.library ?? "movies";
  return {
    key: `item:${id}`, type: "item", library, item: item(id, title, library === "movies" ? "video" : "audio"), directory_id: 1,
    folder: null, work: null, preview_candidates: [], ...extra
  };
}

function home(overrides: Partial<HomeData> = {}): HomeData {
  return {
    generated_at: "2026-11-11T20:00:00+00:00", can_dismiss: true, dismissed_count: 0, libraries: [], hero: null,
    shelves: Object.fromEntries(SHELVES.map((shelf) => [shelf.id, { cards: [], has_more: false }])),
    surprise: { seed: "day-1", album: null, film: null },
    ...overrides
  };
}

const both = { music: true, movies: true };

test("the page's shelves are the bridge's shelves, each once", () => {
  const ids = SHELVES.map((shelf) => shelf.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["continue_movies", "continue_music", "next_episodes", "recent_movies", "recent_music", "recommended_movies",
    "recommended_music", "popular", "random_films", "random_series", "random_tracks"]) {
    assert.ok(shelfDefinition(id), `the page knows the shelf ${id}`);
  }
  // What was begun comes before anything that is only offered.
  assert.deepEqual(ids.slice(0, 3), ["continue_movies", "continue_music", "next_episodes"]);
  // Only the two "continue" shelves forget a position; every other card is a suggestion.
  assert.deepEqual(SHELVES.filter((shelf) => shelf.dismiss === "continue").map((shelf) => shelf.id), ["continue_movies", "continue_music"]);
  assert.deepEqual(SHELVES.filter((shelf) => shelf.random).map((shelf) => shelf.id), ["random_films", "random_series", "random_tracks"]);
});

test("an empty shelf is not drawn, and the rest keep the page's order", () => {
  const data = home();
  data.shelves!.popular = { cards: [card(1, "A"), card(2, "B", { library: "music" })], has_more: true };
  data.shelves!.continue_movies = { cards: [card(3, "C", { position_ms: 5, progress: 0.4 })], has_more: false };
  data.shelves!.random_tracks = { cards: [card(4, "D", { library: "music" })], has_more: true, seed: "day-abc" };
  const shown = visibleShelves(data, both);
  assert.deepEqual(shown.map((shelf) => shelf.definition.id), ["continue_movies", "random_tracks", "popular"]);
  assert.equal(shown[1]!.seed, "day-abc");
  assert.equal(shown[1]!.hasMore, true);
  assert.equal(shown[0]!.seed, null);
});

test("the hero is left out of the row it also stands in", () => {
  const hero = card(7, "Film", { position_ms: 100, progress: 0.42 });
  const data = home({ hero });
  data.shelves!.continue_movies = { cards: [hero, card(8, "Inny", { position_ms: 5, progress: 0.1 })], has_more: false };
  const shown = visibleShelves(data, both);
  assert.deepEqual(shown[0]!.cards.map((entry) => entry.key), ["item:8"]);
  // A shelf whose only card is the hero is not drawn at all.
  data.shelves!.continue_movies = { cards: [hero], has_more: false };
  assert.deepEqual(visibleShelves(data, both), []);
  // The same key on a suggestion shelf is another matter: it stays.
  data.shelves!.popular = { cards: [card(7, "Film")], has_more: false };
  assert.deepEqual(visibleShelves(data, both).map((shelf) => shelf.definition.id), ["popular"]);
});

test("a library the account cannot open contributes no shelf and no card", () => {
  const data = home();
  data.shelves!.recent_movies = { cards: [card(1, "Film")], has_more: false };
  data.shelves!.recent_music = { cards: [card(2, "Album", { library: "music" })], has_more: false };
  data.shelves!.popular = { cards: [card(3, "Film 2"), card(4, "Utwór", { library: "music" })], has_more: false };
  const musicOnly = visibleShelves(data, { music: true, movies: false });
  assert.deepEqual(musicOnly.map((shelf) => shelf.definition.id), ["recent_music", "popular"]);
  assert.deepEqual(musicOnly[1]!.cards.map((entry) => entry.key), ["item:4"]);
  assert.deepEqual(expectedShelves({ music: true, movies: false }).map((shelf) => shelf.id),
    ["continue_music", "random_tracks", "recent_music", "recommended_music", "popular"]);
  assert.deepEqual(expectedShelves({ music: false, movies: false }), []);
});

test("an older bridge without the random shelves draws the page without them", () => {
  const data = home();
  delete data.shelves!.random_films;
  delete data.shelves!.random_series;
  delete data.shelves!.random_tracks;
  data.shelves!.popular = { cards: [card(1, "A")], has_more: false };
  assert.deepEqual(visibleShelves(data, both).map((shelf) => shelf.definition.id), ["popular"]);
  assert.deepEqual(visibleShelves({ generated_at: "", can_dismiss: true, dismissed_count: 0 }, both), []);
});

test("a card is called by what the catalogue knows, not by its file name", () => {
  const work = { title: "Matrix Reaktywacja", year: 2003, is_series: false, season: null, episode: null, genres: [] };
  assert.equal(cardTitle(card(1, "The Matrix Reloaded (2003) [1080p] [HEVC]", { work })), "Matrix Reaktywacja");
  // No matched title: the file's own, with the underscores of a release name read as spaces.
  assert.equal(cardTitle(card(2, "Outer Banks_S01E01_Pilot", { work: { ...work, title: null, is_series: true, season: 1, episode: 1 } })), "Outer Banks S01E01 Pilot");
  assert.equal(fileTitle("Gumisie_S03E02_Na twoim miejscu__Nie wszystko złoto"), "Gumisie S03E02 Na twoim miejscu Nie wszystko złoto");
  assert.equal(fileTitle("Zielona mila (1999)"), "Zielona mila (1999)");
  assert.equal(fileTitle("___"), "___");
  // A track keeps its title as tagged, underscores and all.
  assert.equal(cardTitle(card(20, "snake_case_song", { library: "music" })), "snake_case_song");
  // A season offered whole is called after its series; a folder named "S01" says nothing.
  const season = card(3, "Outer Banks_S01E01_Pilot", {
    key: "folder:9", type: "folder", work: { ...work, title: "Outer Banks", is_series: true, season: 1, episode: 1 },
    folder: { id: 9, name: "S01", relative_path: "Outer Banks/S01", item_count: 10, duration_ms: null, artist: null, year: null }
  });
  assert.equal(cardTitle(season), "Outer Banks");
  // An album is called what its folder is called.
  const album = card(4, "Battlefield 3 Main Theme", {
    key: "folder:5", type: "folder", library: "music",
    folder: { id: 5, name: "2010 - 2013", relative_path: "2010 - 2013", item_count: 12, duration_ms: null, artist: null, year: null }
  });
  assert.equal(cardTitle(album), "2010 - 2013");
  assert.equal(cardTitle(card(5, "Czarna Perła", { library: "music" })), "Czarna Perła");
  // A series card says the series, whatever episode it starts from.
  assert.equal(cardTitle(card(6, "Peaky Blinders_S06E02_Czarna koszula", {
    series: { id: 1, title: "Peaky Blinders", year: 2013, episode_count: 36, season_count: 6, start: "next", resume_ms: null }
  })), "Peaky Blinders");
});

test("an episode has a code only when the file names an episode", () => {
  assert.equal(episodeCode({ season: 3, episode: 2 }), "S03E02");
  assert.equal(episodeCode({ season: 12, episode: 104 }), "S12E104");
  assert.equal(episodeCode({ season: null, episode: 7 }), "E07");
  assert.equal(episodeCode({ season: 1, episode: null }), null);
  assert.equal(episodeCode(null), null);
});

test("a picture is a film still or a record cover by the card's library", () => {
  assert.equal(cardLook(card(1, "A")), "film");
  assert.equal(cardLook(card(2, "B", { library: "music" })), "music");
});

test("a card with a saved position forgets it; every other card declines a suggestion", () => {
  assert.equal(dismissKind(card(1, "A", { position_ms: 0 })), "continue");
  assert.equal(dismissKind(card(1, "A", { position_ms: 90_000 })), "continue");
  assert.equal(dismissKind(card(1, "A")), "home");
  // A series card carries where to resume and deliberately no position of its own.
  assert.equal(dismissKind(card(1, "A", { series: { id: 1, title: "S", year: null, episode_count: 3, season_count: 1, start: "resume", resume_ms: 5000 } })), "home");
});

test("progress is a whole percent that never reads as not begun or as finished", () => {
  assert.equal(progressPercent({ progress: 0.42 }), 42);
  assert.equal(progressPercent({ progress: 0.004 }), 1);
  assert.equal(progressPercent({ progress: 0.999 }), 99);
  assert.equal(progressPercent({}), null);
  assert.equal(progressPercent({ progress: Number.NaN }), null);
});

test("time left is said in hours and minutes", () => {
  assert.deepEqual(hoursAndMinutes(4_812_552), { hours: 1, minutes: 20 });
  assert.deepEqual(hoursAndMinutes(59_000), { hours: 0, minutes: 1 });
  assert.deepEqual(hoursAndMinutes(20_000), { hours: 0, minutes: 0 });
  assert.deepEqual(hoursAndMinutes(-5), { hours: 0, minutes: 0 });
  assert.deepEqual(hoursAndMinutes(7_200_000), { hours: 2, minutes: 0 });
});

test("an addition is dated in whole days", () => {
  const now = Date.parse("2026-11-11T20:00:00+00:00");
  assert.equal(daysSince("2026-11-11T08:00:00+00:00", now), 0);
  assert.equal(daysSince("2026-11-08T16:31:37+00:00", now), 3);
  assert.equal(daysSince("2026-11-12T08:00:00+00:00", now), 0);
  assert.equal(daysSince(undefined, now), null);
  assert.equal(daysSince("soon", now), null);
});

test("a row shows as many cards as it has columns", () => {
  assert.equal(rowCapacity(6), 6);
  assert.equal(rowCapacity(4, 2), 8);
  assert.equal(rowCapacity(0), 0);
});

test("forgetting a position takes the card off the continue shelves and the hero, and nowhere else", () => {
  const hero = card(7, "Film", { position_ms: 100, progress: 0.42 });
  const data = home({ hero });
  data.shelves!.continue_movies = { cards: [hero, card(8, "Inny", { position_ms: 5 })], has_more: false };
  data.shelves!.popular = { cards: [card(7, "Film")], has_more: false };
  const after = withoutCard(data, "item:7", "continue");
  assert.equal(after.hero, null);
  assert.deepEqual(after.shelves!.continue_movies!.cards.map((entry) => entry.key), ["item:8"]);
  assert.deepEqual(after.shelves!.popular!.cards.map((entry) => entry.key), ["item:7"]);
  // Nothing of the answer that was kept is changed.
  assert.equal(data.hero, hero);
  assert.equal(data.shelves!.continue_movies!.cards.length, 2);
});

test("declining a suggestion takes it off every suggestion shelf and the surprise, never off continue", () => {
  const data = home({ surprise: { seed: "s", album: null, film: card(9, "Zielona mila") } });
  data.shelves!.continue_movies = { cards: [card(9, "Zielona mila", { position_ms: 5 })], has_more: false };
  data.shelves!.popular = { cards: [card(9, "Zielona mila"), card(10, "Inny")], has_more: false };
  data.shelves!.random_films = { cards: [card(9, "Zielona mila")], has_more: true, seed: "x" };
  const after = withoutCard(data, "item:9", "home");
  assert.deepEqual(after.shelves!.popular!.cards.map((entry) => entry.key), ["item:10"]);
  assert.deepEqual(after.shelves!.random_films!.cards, []);
  assert.equal(after.shelves!.random_films!.seed, "x");
  assert.equal(after.surprise!.film, null);
  assert.equal(after.shelves!.continue_movies!.cards.length, 1);
});

test("one shelf can be replaced without touching the others", () => {
  const data = home();
  data.shelves!.popular = { cards: [card(1, "A")], has_more: false };
  const after = withShelf(data, "random_films", { cards: [card(2, "B")], has_more: true, seed: "new" });
  assert.equal(after.shelves!.random_films!.seed, "new");
  assert.equal(after.shelves!.popular, data.shelves!.popular);
  assert.deepEqual(data.shelves!.random_films!.cards, []);
});

test("two answers that would draw the same page have the same signature", () => {
  const build = (generated: string): HomeData => {
    const data = home({ generated_at: generated, hero: card(7, "Film", { position_ms: 100, progress: 0.42 }) });
    data.shelves!.popular = { cards: [card(1, "A", { listeners: 2 })], has_more: true };
    return data;
  };
  assert.equal(homeSignature(build("2026-11-11T20:00:00+00:00")), homeSignature(build("2026-11-11T20:05:00+00:00")));
});

test("anything the page would draw differently changes the signature", () => {
  const base = (): HomeData => {
    const data = home({ hero: card(7, "Film", { position_ms: 100, progress: 0.42 }) });
    data.shelves!.popular = { cards: [card(1, "A", { listeners: 2 }), card(2, "B")], has_more: true };
    data.shelves!.random_films = { cards: [card(3, "C")], has_more: true, seed: "day-1" };
    return data;
  };
  const signature = homeSignature(base());
  const changed: Array<[string, (data: HomeData) => void]> = [
    ["further into the film", (data) => { data.hero!.progress = 0.5; }],
    ["another hero", (data) => { data.hero = card(8, "Inny", { position_ms: 1, progress: 0.1 }); }],
    ["no hero", (data) => { data.hero = null; }],
    ["a card gone", (data) => { data.shelves!.popular!.cards.pop(); }],
    ["cards in another order", (data) => { data.shelves!.popular!.cards.reverse(); }],
    ["more listeners", (data) => { data.shelves!.popular!.cards[0]!.listeners = 3; }],
    ["nothing more to show", (data) => { data.shelves!.popular!.has_more = false; }],
    ["another draw", (data) => { data.shelves!.random_films!.seed = "day-2"; }],
    ["a dismissal", (data) => { data.dismissed_count = 1; }],
    ["a guest", (data) => { data.can_dismiss = false; }],
    ["a favourite", (data) => { data.shelves!.popular!.cards[0]!.item.favorite = true; }],
    ["a new library count", (data) => { data.libraries = [{ kind: "music", item_count: 5, folder_count: 1, film_count: 0, series_count: 0, episode_count: 0, recent_count: 1 }]; }],
    ["another surprise", (data) => { data.surprise = { seed: "other", album: null, film: card(9, "Z") }; }]
  ];
  for (const [what, change] of changed) {
    const data = base();
    change(data);
    assert.notEqual(homeSignature(data), signature, what);
  }
});
