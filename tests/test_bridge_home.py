"""The start page (`GET ?action=home`, `POST ?action=home_dismiss`) against MySQL.

The library is real folders catalogued by the real scanner (tests/bridge_harness.py);
what an account has played, liked and declined is written straight into the tables
the bridge reads. Every shelf is checked for what it holds and in which order, for
whom it stays empty, and for what a dismissal takes away.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

MUSIC = [
    "Abba/Arrival/01 - Dancing Queen.mp3",
    "Abba/Arrival/02 - Money.mp3",
    "Abba/Arrival/03 - Tiger.mp3",
    "Abba/Arrival/cover.jpg",
    "Abba/Gold/01 - Waterloo.mp3",
    "Abba/Gold/02 - SOS.mp3",
    "Abba/Gold/03 - Fernando.mp3",
    "Mixes/Long Set.mp3",
    "Queen/Hits/01 - Bohemian.mp3",
    "Queen/Hits/02 - Radio.mp3",
    "Queen/Hits/03 - Champions.mp3",
    "Singles/Lone.mp3",
    "Loose.mp3",
]
MOVIES = [
    "Dune (2021)/Dune (2021).mkv",
    "Dune (2021)/poster.jpg",
    "Firefly/Firefly - 1x01 - Serenity.mkv",
    "Firefly/Firefly - 1x02 - The Train Job.mkv",
    "Firefly/Firefly - 1x03 - Bushwhacked.mkv",
    "Firefly/Firefly - 1x04 - Shindig.mkv",
    "Alien/Alien (1979).mkv",
    "Alien/Aliens (1986).mkv",
    "Heat (1995)/Heat (1995).mkv",
    "Loose Film (1999).mkv",
]
FILM = 2 * 60 * 60 * 1000
EPISODE = 44 * 60 * 1000
SONG = 3 * 60 * 1000
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00")


def _library(bridge_db, bridge_library) -> None:
    """Both libraries, with the lengths a tag reader would have found."""
    bridge_library.scan("music", "music", MUSIC)
    bridge_library.scan("movies", "movies", MOVIES)
    bridge_db.execute("UPDATE media_items SET duration_ms = %s WHERE media_kind = 'audio'", (SONG,))
    bridge_db.execute("UPDATE media_items SET duration_ms = %s WHERE media_kind = 'video'", (FILM,))
    bridge_db.execute(
        "UPDATE media_items SET duration_ms = %s WHERE media_kind = 'video' AND relative_path LIKE 'Firefly/%%'",
        (EPISODE,),
    )
    bridge_db.tag("Mixes/Long Set.mp3", duration_ms=45 * 60 * 1000)
    bridge_db.user("listener")


def _home(bridge_php, user: str = "listener", *, limit: int = 12, shelf: str | None = None,
          seed: str | None = None) -> dict[str, Any]:
    """The page as the bridge would answer it for that account (its own rights decide the libraries)."""
    return bridge_php.run(
        r"""
        $identity = identity($db, %s);
        $shelves = new HomeShelves($db, new LibraryBrowser($db), $identity,
            (new CatalogActions($db))->accessibleLibraries($identity));
        out(attempt(static fn () => $shelves->page(%d, %s, %s)));
        """ % (json.dumps(user), limit, json.dumps(shelf), json.dumps(seed))
    )


def _page(bridge_php, user: str = "listener", **options: Any) -> dict[str, Any]:
    result = _home(bridge_php, user, **options)
    assert result["ok"], result
    return result["value"]


def _dismiss(bridge_php, payload: dict[str, Any], user: str = "listener") -> dict[str, Any]:
    return bridge_php.run(
        r"""
        $identity = identity($db, %s);
        $shelves = new HomeShelves($db, new LibraryBrowser($db), $identity,
            (new CatalogActions($db))->accessibleLibraries($identity));
        out(attempt(static fn () => $shelves->dismiss(json_decode(%s, true))));
        """ % (json.dumps(user), json.dumps(json.dumps(payload)))
    )


def _user_id(bridge_db, username: str) -> int:
    return int(bridge_db.value("SELECT id FROM users WHERE username = %s", (username,)))


def _play(bridge_db, username: str, path: str, *, position: int = 0, plays: int = 1, ago: int = 60,
          hidden: bool = False) -> int:
    """One row of play history: where the file was left, and how long ago (seconds)."""
    item = bridge_db.item_id(path)
    bridge_db.execute(
        "INSERT INTO playback_stats (user_id, media_item_id, play_count, last_position_ms, last_played_at,"
        " continue_hidden_at) VALUES (%s, %s, %s, %s, DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s SECOND), "
        + ("CURRENT_TIMESTAMP(6)" if hidden else "NULL") + ")",
        (_user_id(bridge_db, username), item, plays, position, ago),
    )
    return item


def _like(bridge_db, username: str, path: str, *, rating: float | None = None, favorite: bool = True) -> int:
    item = bridge_db.item_id(path)
    bridge_db.insert("user_ratings", user_id=_user_id(bridge_db, username), media_item_id=item,
                     rating=rating, favorite=int(favorite))
    return item


def _added(bridge_db, pattern: str, days_ago: float) -> None:
    """Pretend the files matching a LIKE pattern were first catalogued that long ago."""
    bridge_db.execute(
        "UPDATE media_items SET created_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s SECOND)"
        " WHERE relative_path LIKE %s",
        (int(days_ago * 86400), pattern),
    )


def _work(bridge_db, pattern: str, title: str, *, episode: bool = False, status: str = "matched",
          genres: tuple[str, ...] = ()) -> None:
    """What the title worker leaves behind: one catalogued work for the files matching a LIKE pattern."""
    subject = hashlib.sha256(title.encode("utf-8")).digest()
    root = bridge_db.value("SELECT root_id FROM media_items WHERE relative_path LIKE %s LIMIT 1", (pattern,))
    bridge_db.execute("UPDATE media_items SET title_subject_hash = %s WHERE relative_path LIKE %s", (subject, pattern))
    bridge_db.insert("media_title_lookups", root_id=root, subject_hash=subject, subject_key=title.lower(),
                     is_episode=int(episode), query_title=title, status=status,
                     matched_title=title if status == "matched" else None)
    for slug in genres:
        bridge_db.execute(
            "INSERT INTO media_item_genres (media_item_id, genre_id)"
            " SELECT mi.id, mg.id FROM media_items mi INNER JOIN media_genres mg ON mg.slug = %s"
            " WHERE mi.relative_path LIKE %s AND mi.media_kind = 'video'",
            (slug, pattern),
        )


def _titles(shelf: dict[str, Any]) -> list[str]:
    return [card["item"]["relative_path"] for card in shelf["cards"]]


def _instant(bridge_db, sql: str, params: tuple = ()) -> datetime:
    """A stored timestamp as the instant it is, asked of the database that knows its own time zone."""
    return datetime.fromtimestamp(int(bridge_db.value(f"SELECT FLOOR(UNIX_TIMESTAMP(({sql})))", params)), timezone.utc)


# -- the page as a whole ------------------------------------------------------------------------

def test_a_new_account_gets_every_shelf_and_only_the_news_is_filled(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    home = _page(bridge_php)

    assert set(home) == {"generated_at", "can_dismiss", "dismissed_count", "libraries", "hero", "shelves", "surprise"}
    assert ISO.fullmatch(home["generated_at"])
    assert home["can_dismiss"] is True and home["dismissed_count"] == 0 and home["hero"] is None
    assert list(home["shelves"]) == [
        "continue_movies", "continue_music", "next_episodes", "recent_movies", "recent_music",
        "recommended_movies", "recommended_music", "popular",
        "random_films", "random_series", "random_tracks",
    ]
    for name in ("continue_movies", "continue_music", "next_episodes", "recommended_movies", "recommended_music",
                 "popular"):
        assert home["shelves"][name] == {"cards": [], "has_more": False}, name

    assert home["libraries"] == [
        {"kind": "music", "item_count": 12, "folder_count": 6, "film_count": 0, "series_count": 0,
         "episode_count": 0, "recent_count": 12},
        {"kind": "movies", "item_count": 9, "folder_count": 5, "film_count": 9, "series_count": 0,
         "episode_count": 0, "recent_count": 9},
    ]

    music = {card["key"]: card for card in home["shelves"]["recent_music"]["cards"]}
    arrival = bridge_db.directory_id("Abba/Arrival", "music")
    lone = bridge_db.item_id("Singles/Lone.mp3")
    loose = bridge_db.item_id("Loose.mp3")
    # An album is one card; a file alone in its folder, or loose at the top, is offered as itself.
    assert set(music) == {
        f"folder:{arrival}", f"folder:{bridge_db.directory_id('Abba/Gold', 'music')}",
        f"folder:{bridge_db.directory_id('Queen/Hits', 'music')}", f"item:{lone}", f"item:{loose}",
        f"item:{bridge_db.item_id('Mixes/Long Set.mp3')}",
    }
    album = music[f"folder:{arrival}"]
    assert album["type"] == "folder" and album["library"] == "music" and album["work"] is None
    assert album["item"]["relative_path"] == "Abba/Arrival/01 - Dancing Queen.mp3"
    assert album["directory_id"] == arrival and album["added_count"] == 3 and ISO.fullmatch(album["added_at"])
    assert album["folder"] == {"id": arrival, "name": "Arrival", "relative_path": "Abba/Arrival", "item_count": 3,
                               "duration_ms": 3 * SONG, "artist": None, "year": None}
    # The folder's own picture first, then the track: a card always has a second cover to try.
    assert album["preview_candidates"] == [
        {"id": bridge_db.item_id("Abba/Arrival/cover.jpg"), "kind": "image"},
        {"id": bridge_db.item_id("Abba/Arrival/01 - Dancing Queen.mp3"), "kind": "audio"},
    ]
    assert music[f"item:{lone}"]["type"] == "item" and music[f"item:{lone}"]["folder"] is None
    assert music[f"item:{loose}"]["added_count"] == 1

    movies = {card["key"]: card for card in home["shelves"]["recent_movies"]["cards"]}
    firefly = bridge_db.directory_id("Firefly", "movies")
    dune = bridge_db.item_id("Dune (2021)/Dune (2021).mkv")
    # A season that arrived together is one card, starting at its first episode; films stand alone,
    # two films that merely share a folder included.
    assert set(movies) == {
        f"folder:{firefly}", f"item:{dune}", f"item:{bridge_db.item_id('Alien/Alien (1979).mkv')}",
        f"item:{bridge_db.item_id('Alien/Aliens (1986).mkv')}",
        f"item:{bridge_db.item_id('Heat (1995)/Heat (1995).mkv')}", f"item:{bridge_db.item_id('Loose Film (1999).mkv')}",
    }
    season = movies[f"folder:{firefly}"]
    assert season["item"]["relative_path"] == "Firefly/Firefly - 1x01 - Serenity.mkv"
    assert season["added_count"] == 4 and season["folder"]["item_count"] == 4
    assert season["folder"]["duration_ms"] == 4 * EPISODE and season["folder"]["artist"] is None
    # No catalogued title yet, but "1x01" in a file name is a season and an episode all the same.
    assert season["work"] == {"title": None, "year": None, "is_series": True, "season": 1, "episode": 1, "genres": []}
    film = movies[f"item:{dune}"]
    assert film["work"]["is_series"] is False and film["work"]["year"] == 2021
    assert film["preview_candidates"] == [
        {"id": dune, "kind": "video"}, {"id": bridge_db.item_id("Dune (2021)/poster.jpg"), "kind": "image"},
    ]

    # "Surprise me": an album is a folder of three tracks or more, a film is feature length and no episode.
    surprise = home["surprise"]
    assert re.fullmatch(r"day-[0-9a-f]{8}", surprise["seed"])
    assert surprise["album"]["type"] == "folder" and surprise["album"]["folder"]["item_count"] == 3
    assert surprise["film"]["type"] == "item" and not surprise["film"]["item"]["relative_path"].startswith("Firefly/")


def test_one_shelf_or_the_surprise_alone_can_be_asked_for(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    one = _page(bridge_php, shelf="recent_music", limit=60)
    assert set(one) == {"generated_at", "can_dismiss", "dismissed_count", "shelves"}
    assert list(one["shelves"]) == ["recent_music"] and len(one["shelves"]["recent_music"]["cards"]) == 6

    short = _page(bridge_php, shelf="recent_music", limit=2)["shelves"]["recent_music"]
    assert len(short["cards"]) == 2 and short["has_more"] is True

    again = _page(bridge_php, shelf="surprise", seed="first-seed")
    assert set(again) == {"generated_at", "can_dismiss", "dismissed_count", "surprise"}
    assert again["surprise"]["seed"] == "first-seed"

    for arguments in ({"limit": 0}, {"limit": 25}, {"shelf": "recent_music", "limit": 61}, {"shelf": "everything"},
                      {"seed": "short"}, {"seed": "has spaces in it"}):
        refused = _home(bridge_php, **arguments)
        assert refused["ok"] is False and refused["error"] == "BridgeRequestException", arguments


# -- continue ------------------------------------------------------------------------------------

def test_continue_carries_progress_and_the_hero_is_the_latest_long_one(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    dune = _play(bridge_db, "listener", "Dune (2021)/Dune (2021).mkv", position=FILM * 3 // 10, ago=86400)
    long_set = _play(bridge_db, "listener", "Mixes/Long Set.mp3", position=15 * 60 * 1000, ago=3600)
    song = _play(bridge_db, "listener", "Queen/Hits/01 - Bohemian.mp3", position=SONG // 2, ago=10)
    _play(bridge_db, "listener", "Alien/Alien (1979).mkv", position=0, ago=20)                   # seen to the end
    _play(bridge_db, "listener", "Heat (1995)/Heat (1995).mkv", position=FILM * 99 // 100, ago=30)  # the credits
    _play(bridge_db, "listener", "Loose Film (1999).mkv", position=FILM // 100, ago=40)           # a glance
    _play(bridge_db, "listener", "Alien/Aliens (1986).mkv", position=FILM // 2, ago=50, hidden=True)  # "I am done"
    bridge_db.user("somebody")
    _play(bridge_db, "somebody", "Abba/Gold/01 - Waterloo.mp3", position=SONG // 2, ago=5)

    home = _page(bridge_php)
    films = home["shelves"]["continue_movies"]["cards"]
    assert [card["key"] for card in films] == [f"item:{dune}"]
    assert films[0]["position_ms"] == FILM * 3 // 10 and films[0]["progress"] == 0.3
    assert films[0]["remaining_ms"] == FILM - FILM * 3 // 10 and "long_form" not in films[0]
    played = _instant(bridge_db, "SELECT last_played_at FROM playback_stats WHERE media_item_id = %s", (dune,))
    assert datetime.fromisoformat(films[0]["last_played_at"]) == played

    # The long recording comes before the song although the song was played later.
    music = home["shelves"]["continue_music"]["cards"]
    assert [(card["key"], card["long_form"]) for card in music] == [(f"item:{long_set}", True), (f"item:{song}", False)]
    assert music[0]["progress"] == 0.333

    # The headline: the most recent unfinished film or long recording — never a song.
    assert home["hero"] == music[0]


def test_a_guest_account_gets_the_news_and_nothing_personal(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.user("visitor", guest=True)
    bridge_db.user("somebody")
    _play(bridge_db, "visitor", "Dune (2021)/Dune (2021).mkv", position=FILM // 2)
    _play(bridge_db, "somebody", "Abba/Gold/01 - Waterloo.mp3")
    home = _page(bridge_php, "visitor")
    assert home["can_dismiss"] is False and home["hero"] is None
    for name in ("continue_movies", "continue_music", "next_episodes", "recommended_movies", "recommended_music",
                 "popular"):
        assert home["shelves"][name]["cards"] == [], name
    assert len(home["shelves"]["recent_music"]["cards"]) == 6
    assert home["surprise"]["album"] is not None and [entry["kind"] for entry in home["libraries"]] == ["music", "movies"]

    refused = _dismiss(bridge_php, {"key": f"item:{bridge_db.item_id('Loose.mp3')}"}, "visitor")
    assert refused["ok"] is False and refused["error"] == "BridgeAuthorizationException"


def test_a_library_the_group_does_not_open_contributes_nothing(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.user("musician", group=bridge_db.group("music-only", can_access_music=1))
    bridge_db.user("somebody")
    _play(bridge_db, "somebody", "Dune (2021)/Dune (2021).mkv")
    _play(bridge_db, "somebody", "Abba/Gold/01 - Waterloo.mp3")
    _play(bridge_db, "musician", "Heat (1995)/Heat (1995).mkv", position=FILM // 2)   # from before the group changed

    home = _page(bridge_php, "musician")
    assert [entry["kind"] for entry in home["libraries"]] == ["music"]
    for name in ("continue_movies", "next_episodes", "recent_movies", "recommended_movies"):
        assert home["shelves"][name]["cards"] == [], name
    assert home["hero"] is None and home["surprise"]["film"] is None and home["surprise"]["album"] is not None
    assert _titles(home["shelves"]["popular"]) == ["Abba/Gold/01 - Waterloo.mp3"]

    # Nor can it be used to ask whether a film exists.
    film = _dismiss(bridge_php, {"key": f"item:{bridge_db.item_id('Dune (2021)/Dune (2021).mkv')}"}, "musician")
    folder = _dismiss(bridge_php, {"key": f"folder:{bridge_db.directory_id('Firefly', 'movies')}"}, "musician")
    assert film["ok"] is False and folder["ok"] is False
    assert film["error"] == folder["error"] == "BridgeRequestException"


# -- next episodes -------------------------------------------------------------------------------

def test_next_episodes_follow_what_was_finished(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    first = _play(bridge_db, "listener", "Firefly/Firefly - 1x01 - Serenity.mkv", ago=120)
    alien = _play(bridge_db, "listener", "Alien/Alien (1979).mkv", ago=60)
    bridge_db.tag("Firefly/Firefly - 1x01 - Serenity.mkv", title="Serenity")

    shelf = _page(bridge_php)["shelves"]["next_episodes"]
    assert shelf["has_more"] is False
    # Newest finished first: the other film of the folder, then the episode after the one seen.
    assert _titles(shelf) == ["Alien/Aliens (1986).mkv", "Firefly/Firefly - 1x02 - The Train Job.mkv"]
    other, episode = shelf["cards"]
    assert other["reason"] == "folder" and other["after"]["id"] == alien
    assert episode["reason"] == "episode" and episode["after"] == {"id": first, "title": "Serenity"}
    assert episode["type"] == "item" and episode["work"]["episode"] == 2
    finished = _instant(bridge_db, "SELECT last_played_at FROM playback_stats WHERE media_item_id = %s", (first,))
    assert datetime.fromisoformat(episode["last_played_at"]) == finished
    # What is offered here is not offered twice.
    assert _page(bridge_php)["shelves"]["next_episodes"] == shelf

    # "Not this one" about the next episode means the series: nothing more from that folder.
    assert _dismiss(bridge_php, {"key": episode["key"], "hidden": True})["value"] == {
        "success": True, "hidden": True, "dismissed_count": 1,
    }
    assert _titles(_page(bridge_php)["shelves"]["next_episodes"]) == ["Alien/Aliens (1986).mkv"]


# -- recently added ------------------------------------------------------------------------------

def test_recently_added_is_newest_first_inside_ninety_days(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    _added(bridge_db, "%", 200)                       # an old library…
    _added(bridge_db, "Queen/Hits/%", 3)              # …an album three days ago…
    _added(bridge_db, "Abba/Gold/02 - SOS.mp3", 1)    # …one more track for an album already there…
    _added(bridge_db, "Loose.mp3", 2)
    _added(bridge_db, "Firefly/Firefly - 1x03%", 5)   # …two episodes of a season…
    _added(bridge_db, "Firefly/Firefly - 1x04%", 4)
    _added(bridge_db, "Heat (1995)/%", 1)             # …and a film.
    bridge_db.execute("DELETE FROM bridge_cache")

    home = _page(bridge_php)
    music = home["shelves"]["recent_music"]["cards"]
    gold = bridge_db.directory_id("Abba/Gold", "music")
    assert [card["key"] for card in music] == [
        f"folder:{gold}", f"item:{bridge_db.item_id('Loose.mp3')}", f"folder:{bridge_db.directory_id('Queen/Hits', 'music')}",
    ]
    # One new track of three: the card is the album, and says how much of it is new.
    assert music[0]["added_count"] == 1 and music[0]["folder"]["item_count"] == 3
    assert music[0]["item"]["relative_path"] == "Abba/Gold/02 - SOS.mp3"
    assert music[2]["added_count"] == 3
    added = _instant(bridge_db, "SELECT MAX(created_at) FROM media_items WHERE relative_path LIKE 'Queen/Hits/%%'")
    assert datetime.fromisoformat(music[2]["added_at"]) == added

    movies = home["shelves"]["recent_movies"]["cards"]
    assert [card["key"] for card in movies] == [
        f"item:{bridge_db.item_id('Heat (1995)/Heat (1995).mkv')}", f"folder:{bridge_db.directory_id('Firefly', 'movies')}",
    ]
    # The season's card starts at the earliest of the *new* episodes and dates from the newest.
    assert movies[1]["item"]["relative_path"] == "Firefly/Firefly - 1x03 - Bushwhacked.mkv"
    assert movies[1]["added_count"] == 2 and movies[1]["folder"]["item_count"] == 4
    newest = _instant(bridge_db, "SELECT created_at FROM media_items WHERE relative_path LIKE 'Firefly/Firefly - 1x04%%'")
    assert datetime.fromisoformat(movies[1]["added_at"]) == newest
    assert [entry["recent_count"] for entry in home["libraries"]] == [5, 3]

    # Declined: the album as an album, the film as a film — the track and the season stay.
    for key in (f"folder:{gold}", movies[0]["key"]):
        assert _dismiss(bridge_php, {"key": key})["ok"] is True
    home = _page(bridge_php)
    assert home["dismissed_count"] == 2
    assert [card["key"] for card in home["shelves"]["recent_music"]["cards"]] == [music[1]["key"], music[2]["key"]]
    assert [card["key"] for card in home["shelves"]["recent_movies"]["cards"]] == [movies[1]["key"]]


# -- recommended ---------------------------------------------------------------------------------

def test_music_is_recommended_by_artist_then_by_genre(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    # One artist under two spellings, as tags come: the database calls them the same.
    bridge_db.execute("UPDATE media_items SET artist = 'ABBA' WHERE relative_path LIKE 'Abba/Arrival/%%'")
    bridge_db.execute("UPDATE media_items SET artist = 'Abba' WHERE relative_path LIKE 'Abba/Gold/%%'")
    bridge_db.execute("UPDATE media_items SET artist = 'Queen' WHERE relative_path LIKE 'Queen/%%'")
    rock = json.dumps({"audio": {"genre": "Rock"}})
    bridge_db.execute(
        "UPDATE media_items SET metadata_json = %s WHERE relative_path LIKE 'Queen/%%'"
        " OR relative_path IN ('Abba/Arrival/01 - Dancing Queen.mp3', 'Loose.mp3')",
        (rock,),
    )
    liked = _like(bridge_db, "listener", "Abba/Arrival/01 - Dancing Queen.mp3")
    _play(bridge_db, "listener", "Abba/Arrival/02 - Money.mp3")                  # heard already
    _like(bridge_db, "listener", "Abba/Gold/03 - Fernando.mp3", favorite=False, rating=2.0)  # heard, and not liked

    shelf = _page(bridge_php)["shelves"]["recommended_music"]
    cards = shelf["cards"]
    by_artist = [card for card in cards if card["because"]["type"] == "artist"]
    by_genre = [card for card in cards if card["because"]["type"] == "genre"]
    # At most two for one artist, never the liked track itself, nothing already played or rated.
    assert len(by_artist) == 2 and cards[:2] == by_artist
    assert {card["because"]["label"].lower() for card in by_artist} == {"abba"}
    assert {card["item"]["relative_path"] for card in by_artist} <= {
        "Abba/Arrival/03 - Tiger.mp3", "Abba/Gold/01 - Waterloo.mp3", "Abba/Gold/02 - SOS.mp3",
    }
    # Then what carries the liked track's genre tag.
    assert {card["because"]["label"] for card in by_genre} == {"Rock"}
    assert len(by_genre) == 3 and all(card["because"]["label_en"] is None for card in cards)
    assert {card["item"]["relative_path"] for card in by_genre} <= {
        "Queen/Hits/01 - Bohemian.mp3", "Queen/Hits/02 - Radio.mp3", "Queen/Hits/03 - Champions.mp3", "Loose.mp3",
    }
    assert liked not in {card["item"]["id"] for card in cards}
    # Still for the day: the same cards in the same order on the next visit.
    assert _page(bridge_php)["shelves"]["recommended_music"] == shelf

    # A declined suggestion is not made again; another takes its place.
    assert _dismiss(bridge_php, {"key": by_artist[0]["key"]})["ok"] is True
    after = _page(bridge_php)["shelves"]["recommended_music"]["cards"]
    assert by_artist[0]["key"] not in {card["key"] for card in after}
    assert len([card for card in after if card["because"]["type"] == "artist"]) == 2


def test_films_are_recommended_by_series_then_by_genre(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    _work(bridge_db, "Firefly/%", "Firefly", episode=True, genres=("sci-fi",))
    _work(bridge_db, "Dune (2021)/%", "Diuna", genres=("sci-fi", "adventure"))
    _work(bridge_db, "Alien/Alien (1979)%", "Obcy", genres=("sci-fi", "horror"))
    _work(bridge_db, "Alien/Aliens (1986)%", "Obcy 2", genres=("horror",))
    _work(bridge_db, "Heat (1995)/%", "Gorączka", genres=("drama",))
    _like(bridge_db, "listener", "Firefly/Firefly - 1x03 - Bushwhacked.mkv")
    _play(bridge_db, "listener", "Firefly/Firefly - 1x03 - Bushwhacked.mkv", ago=999999)
    _play(bridge_db, "listener", "Firefly/Firefly - 1x01 - Serenity.mkv", position=EPISODE // 2, ago=10)
    _like(bridge_db, "listener", "Dune (2021)/Dune (2021).mkv", favorite=False, rating=4.5)
    bridge_db.execute("DELETE FROM bridge_cache")

    home = _page(bridge_php)
    cards = home["shelves"]["recommended_movies"]["cards"]
    # A liked series first: its earliest episode never opened (1x01 is waiting under "continue").
    assert cards[0]["item"]["relative_path"] == "Firefly/Firefly - 1x02 - The Train Job.mkv"
    assert cards[0]["because"] == {"type": "series", "label": "Firefly", "label_en": None}
    assert cards[0]["work"]["title"] == "Firefly" and cards[0]["work"]["season"] == 1
    assert [genre["slug"] for genre in cards[0]["work"]["genres"]] == ["sci-fi"]
    # Then films sharing a genre with a liked film: by the genre's Polish name, with the English beside it.
    assert [card["item"]["relative_path"] for card in cards[1:]] == ["Alien/Alien (1979).mkv"]
    assert cards[1]["because"] == {"type": "genre", "label": "Sci-Fi", "label_en": "Sci-Fi"}
    assert cards[1]["work"]["title"] == "Obcy" and cards[1]["work"]["is_series"] is False
    assert home["libraries"][1]["series_count"] == 1 and home["libraries"][1]["episode_count"] == 4
    assert home["libraries"][1]["film_count"] == 5

    # Declining the suggested episode declines the series; the film stays.
    assert _dismiss(bridge_php, {"key": cards[0]["key"]})["ok"] is True
    after = _page(bridge_php)["shelves"]["recommended_movies"]["cards"]
    assert [card["item"]["relative_path"] for card in after] == ["Alien/Alien (1979).mkv"]


# -- popular -------------------------------------------------------------------------------------

def test_popular_is_what_others_play_and_this_account_has_not_opened(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.user("anna")
    bridge_db.user("bartek")
    for name in ("anna", "bartek"):
        _play(bridge_db, name, "Queen/Hits/02 - Radio.mp3")
    _play(bridge_db, "anna", "Dune (2021)/Dune (2021).mkv")
    _play(bridge_db, "anna", "Abba/Gold/01 - Waterloo.mp3")
    _play(bridge_db, "bartek", "Loose.mp3", ago=40 * 86400)           # longer ago than "lately"
    _play(bridge_db, "listener", "Abba/Gold/01 - Waterloo.mp3")       # already opened here
    _play(bridge_db, "listener", "Singles/Lone.mp3")                  # one's own plays do not make it popular

    shelf = _page(bridge_php)["shelves"]["popular"]
    assert [(card["item"]["relative_path"], card["listeners"], card["library"]) for card in shelf["cards"]] == [
        ("Queen/Hits/02 - Radio.mp3", 2, "music"), ("Dune (2021)/Dune (2021).mkv", 1, "movies"),
    ]
    assert _dismiss(bridge_php, {"key": shelf["cards"][0]["key"]})["ok"] is True
    assert _titles(_page(bridge_php)["shelves"]["popular"]) == ["Dune (2021)/Dune (2021).mkv"]


# -- surprise ------------------------------------------------------------------------------------

def test_surprise_is_decided_by_the_seed(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    albums = {bridge_db.directory_id(path, "music") for path in ("Abba/Arrival", "Abba/Gold", "Queen/Hits")}
    seeds = [f"seed-{number:04d}" for number in range(12)]
    drawn = {seed: _page(bridge_php, shelf="surprise", seed=seed)["surprise"] for seed in seeds}
    for seed, surprise in drawn.items():
        assert surprise["seed"] == seed
        # Never the folder with one track, never the long file alone in "Mixes".
        assert surprise["album"]["folder"]["id"] in albums
        assert surprise["album"]["item"]["relative_path"].split("/")[-1].startswith("01 - ")
        assert surprise["film"]["work"]["is_series"] is False
    assert len({surprise["album"]["key"] for surprise in drawn.values()}) > 1
    assert len({surprise["film"]["key"] for surprise in drawn.values()}) > 1
    # The same seed is the same pick.
    assert _page(bridge_php, shelf="surprise", seed=seeds[0])["surprise"] == drawn[seeds[0]]

    # A film seen to the end is no surprise, and neither is anything declined.
    for path in ("Dune (2021)/Dune (2021).mkv", "Alien/Alien (1979).mkv", "Alien/Aliens (1986).mkv",
                 "Loose Film (1999).mkv"):
        _play(bridge_db, "listener", path, position=0)
    arrival = bridge_db.directory_id("Abba/Arrival", "music")
    gold = bridge_db.directory_id("Abba/Gold", "music")
    for folder in (arrival, gold):
        assert _dismiss(bridge_php, {"key": f"folder:{folder}"})["ok"] is True
    for seed in seeds:
        surprise = _page(bridge_php, shelf="surprise", seed=seed)["surprise"]
        assert surprise["film"]["item"]["relative_path"] == "Heat (1995)/Heat (1995).mkv"
        assert surprise["album"]["folder"]["relative_path"] == "Queen/Hits"

    assert _dismiss(bridge_php, {"key": f"item:{bridge_db.item_id('Heat (1995)/Heat (1995).mkv')}"})["ok"] is True
    assert _dismiss(bridge_php, {"key": f"folder:{bridge_db.directory_id('Queen/Hits', 'music')}"})["ok"] is True
    assert _page(bridge_php, shelf="surprise", seed=seeds[0])["surprise"] == {
        "seed": seeds[0], "album": None, "film": None,
    }


# -- dismissals ----------------------------------------------------------------------------------

def test_a_dismissal_can_be_taken_back_and_all_of_them_forgotten(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    loose = bridge_db.item_id("Loose.mp3")
    hits = bridge_db.directory_id("Queen/Hits", "music")
    assert _dismiss(bridge_php, {"key": f"item:{loose}"})["value"]["dismissed_count"] == 1
    assert _dismiss(bridge_php, {"key": f"item:{loose}"})["value"]["dismissed_count"] == 1     # twice is once
    assert _dismiss(bridge_php, {"key": f"folder:{hits}", "hidden": True})["value"]["dismissed_count"] == 2
    keys = {card["key"] for card in _page(bridge_php)["shelves"]["recent_music"]["cards"]}
    assert f"item:{loose}" not in keys and f"folder:{hits}" not in keys and len(keys) == 4

    back = _dismiss(bridge_php, {"key": f"item:{loose}", "hidden": False})["value"]
    assert back == {"success": True, "hidden": False, "dismissed_count": 1}
    assert f"item:{loose}" in {card["key"] for card in _page(bridge_php)["shelves"]["recent_music"]["cards"]}

    assert _dismiss(bridge_php, {"reset": True})["value"] == {"success": True, "dismissed_count": 0}
    assert bridge_db.value("SELECT COUNT(*) FROM home_dismissals") == 0

    # Somebody else's dismissals are their own.
    bridge_db.user("somebody")
    assert _dismiss(bridge_php, {"key": f"item:{loose}"}, "somebody")["ok"] is True
    assert f"item:{loose}" in {card["key"] for card in _page(bridge_php)["shelves"]["recent_music"]["cards"]}

    cover = bridge_db.item_id("Abba/Arrival/cover.jpg")
    for payload in ({}, {"key": "item:0"}, {"key": "item:abc"}, {"key": "album:1"}, {"key": f"item:{loose}", "hidden": "yes"},
                    {"key": "item:999999999"}, {"key": "folder:999999999"}, {"key": 5}, {"reset": "yes"},
                    {"key": f"item:{cover}"}):
        refused = _dismiss(bridge_php, payload)
        assert refused["ok"] is False and refused["error"] == "BridgeRequestException", payload


def test_the_start_page_over_http(bridge_http, bridge_db, bridge_library) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.user("visitor", guest=True)
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200

    page = client.get("home")
    assert page.status == 200 and page.header_values("Cache-Control") == ["no-store, max-age=0"]
    home = page.json["home"]
    assert len(home["shelves"]) == 11 and len(home["shelves"]["recent_music"]["cards"]) == 6
    # The page's own timestamps are ISO 8601 already; they gain no second spelling.
    assert "generated_at_iso" not in home and "added_at_iso" not in home["shelves"]["recent_music"]["cards"][0]

    assert list(client.get("home", shelf="popular", limit=60).json["home"]["shelves"]) == ["popular"]
    assert set(client.get("home", shelf="surprise", seed="abcdefgh").json["home"]) == {
        "generated_at", "can_dismiss", "dismissed_count", "surprise",
    }
    for query in ({"limit": 25}, {"limit": "many"}, {"shelf": "nope"}, {"seed": "x"}):
        refused = client.get("home", **query)
        assert refused.status == 422 and refused.json["error"] == "invalid_request", query

    # „Losuj ponownie”: one shelf, drawn again with the seed the page made up.
    roll = client.get("home", shelf="random_tracks", seed="abcdefgh", limit=3).json["home"]
    assert set(roll) == {"generated_at", "can_dismiss", "dismissed_count", "shelves"}
    assert list(roll["shelves"]) == ["random_tracks"]
    assert roll["shelves"]["random_tracks"]["seed"] == "abcdefgh" and len(roll["shelves"]["random_tracks"]["cards"]) == 3
    assert roll == {**client.get("home", shelf="random_tracks", seed="abcdefgh", limit=3).json["home"],
                    "generated_at": roll["generated_at"]}
    assert client.get("home", shelf="random_films", seed="not a seed").status == 422

    key = home["shelves"]["recent_music"]["cards"][0]["key"]
    assert client.request("GET", "home_dismiss").status == 405
    hidden = client.post("home_dismiss", {"key": key, "hidden": True})
    assert hidden.status == 200 and hidden.json == {"success": True, "hidden": True, "dismissed_count": 1}
    assert key not in {card["key"] for card in client.get("home").json["home"]["shelves"]["recent_music"]["cards"]}
    assert client.post("home_dismiss", {"key": "nonsense"}).status == 422
    assert client.post("home_dismiss", {"reset": True}).json == {"success": True, "dismissed_count": 0}

    # The old shelf is still answered, in its old shape, for the page that has not moved yet.
    old = client.get("continue")
    assert old.status == 200 and set(old.json["continue"]) == {"movies", "music", "tracks", "next", "popular"}

    guest = bridge_http.client()
    assert guest.sign_in("visitor").status == 200
    assert guest.get("home").json["home"]["can_dismiss"] is False
    assert guest.post("home_dismiss", {"key": key}).status == 403


# -- chance --------------------------------------------------------------------------------------

RANDOM = ("random_films", "random_series", "random_tracks")
FILMS = {"Dune (2021)/Dune (2021).mkv", "Alien/Alien (1979).mkv", "Alien/Aliens (1986).mkv",
         "Heat (1995)/Heat (1995).mkv", "Loose Film (1999).mkv"}
TRACKS = {path for path in MUSIC if path.endswith(".mp3") and path != "Mixes/Long Set.mp3"}


def _shelf(bridge_php, name: str, user: str = "listener", **options: Any) -> dict[str, Any]:
    return _page(bridge_php, user, shelf=name, **options)["shelves"][name]


def test_random_shelves_hold_films_series_and_tracks_and_nothing_else(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.tag("Singles/Lone.mp3", duration_ms=20 * 1000)       # a skit, not a track
    _work(bridge_db, "Firefly/%", "Firefly", episode=True)
    home = _page(bridge_php)
    shelves = home["shelves"]
    day = home["surprise"]["seed"]
    # Drawn with the account's seed of the day, which each of them carries.
    assert re.fullmatch(r"day-[0-9a-f]{8}", day) and [shelves[name]["seed"] for name in RANDOM] == [day] * 3
    assert all("seed" not in shelves[name] for name in shelves if name not in RANDOM)

    # Five films — every film there is, each once; never an episode, whatever its length.
    films = shelves["random_films"]
    assert sorted(_titles(films)) == sorted(FILMS) and films["has_more"] is False
    for card in films["cards"]:
        assert (card["type"], card["library"], card["folder"]) == ("item", "movies", None)
        assert card["work"]["is_series"] is False and "series" not in card and "position_ms" not in card

    # Tracks: no long recording, no skit.
    tracks = shelves["random_tracks"]
    assert sorted(_titles(tracks)) == sorted(TRACKS - {"Singles/Lone.mp3"}) and tracks["has_more"] is False
    assert all((card["type"], card["library"], card["work"]) == ("item", "music", None) for card in tracks["cards"])

    # A series is one card: the episode to start from, and what the whole is.
    (card,) = shelves["random_series"]["cards"]
    first = bridge_db.item_id("Firefly/Firefly - 1x01 - Serenity.mkv")
    assert card["key"] == f"item:{first}" and card["type"] == "item" and card["library"] == "movies"
    assert card["series"] == {
        "id": bridge_db.value("SELECT id FROM media_title_lookups WHERE query_title = 'Firefly'"),
        "title": "Firefly", "year": None, "episode_count": 4, "season_count": 1, "start": "first", "resume_ms": None,
    }
    assert (card["work"]["title"], card["work"]["season"], card["work"]["episode"]) == ("Firefly", 1, 1)
    # Not a "continue" card, even when it resumes: the page tells them apart by this field.
    assert "position_ms" not in card and shelves["random_series"]["has_more"] is False


def test_a_series_starts_where_this_account_would(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    _work(bridge_db, "Firefly/%", "Firefly", episode=True)
    bridge_db.user("visitor", guest=True)
    episode = {number: f"Firefly/Firefly - 1x0{number} - {name}.mkv"
               for number, name in ((1, "Serenity"), (2, "The Train Job"), (3, "Bushwhacked"), (4, "Shindig"))}

    def start(user: str = "listener") -> tuple[str, str, int | None]:
        (card,) = _shelf(bridge_php, "random_series", user)["cards"]
        assert card["series"]["episode_count"] == 4
        return card["series"]["start"], card["item"]["relative_path"], card["series"]["resume_ms"]

    assert start() == ("first", episode[1], None)
    _play(bridge_db, "listener", episode[1], position=0, ago=500)                # seen to the end
    assert start() == ("next", episode[2], None)
    second = _play(bridge_db, "listener", episode[2], position=10 * 60 * 1000, ago=400)   # left ten minutes in
    assert start() == ("resume", episode[2], 10 * 60 * 1000)
    # The furthest episode opened decides, not the latest played: the third was skipped to and finished.
    _play(bridge_db, "listener", episode[4], position=EPISODE * 97 // 100, plays=0, ago=300)   # left in the credits
    assert start() == ("again", episode[1], None)
    bridge_db.execute("DELETE FROM playback_stats WHERE media_item_id = %s", (bridge_db.item_id(episode[4]),))
    _play(bridge_db, "listener", episode[3], position=0, ago=200)
    assert start() == ("next", episode[4], None)
    bridge_db.execute("UPDATE playback_stats SET last_position_ms = 0 WHERE media_item_id = %s", (second,))
    assert start() == ("next", episode[4], None)

    # A guest account's playback is not a history: it starts every series at its beginning.
    _play(bridge_db, "visitor", episode[2], position=10 * 60 * 1000)
    assert start("visitor") == ("first", episode[1], None)

    # A series the catalogue has only guessed at goes by the title read from its files.
    bridge_db.execute("UPDATE media_title_lookups SET status = 'review', matched_title = 'A Wrong Guess', matched_year = 1999,"
                      " query_year = 2002 WHERE query_title = 'Firefly'")
    (card,) = _shelf(bridge_php, "random_series")["cards"]
    assert (card["series"]["title"], card["series"]["year"], card["work"]["title"]) == ("Firefly", 2002, None)

    # Declining the card declines the series — for this account only.
    bridge_db.user("somebody")
    assert _dismiss(bridge_php, {"key": card["key"]})["ok"] is True
    assert _shelf(bridge_php, "random_series")["cards"] == []
    assert len(_shelf(bridge_php, "random_series", "somebody")["cards"]) == 1


def test_a_new_seed_is_a_new_draw_and_the_same_seed_the_same(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    _work(bridge_db, "Firefly/%", "Firefly", episode=True)

    first = _shelf(bridge_php, "random_films", seed="seed-one-1", limit=2)
    assert first == _shelf(bridge_php, "random_films", seed="seed-one-1", limit=2)
    assert first["seed"] == "seed-one-1" and len(first["cards"]) == 2 and first["has_more"] is True
    draws = [tuple(_titles(_shelf(bridge_php, "random_films", seed=f"seed-{number:04d}", limit=2))) for number in range(12)]
    # Seeds that differ by one digit are still different draws, and every film gets its turn.
    assert len(set(draws)) >= 6 and {path for draw in draws for path in draw} == FILMS
    orders = {tuple(_titles(_shelf(bridge_php, "random_tracks", seed=f"seed-{number:04d}"))) for number in range(4)}
    assert len(orders) == 4 and all(set(order) == TRACKS for order in orders)

    # A seed on the whole page seeds everything that is drawn, and a shelf drawn alone with it is the same shelf.
    page = _page(bridge_php, seed="whole-page-seed")
    assert [page["shelves"][name]["seed"] for name in RANDOM] == ["whole-page-seed"] * 3
    assert page["surprise"]["seed"] == "whole-page-seed"
    for name in RANDOM:
        assert page["shelves"][name] == _shelf(bridge_php, name, seed="whole-page-seed"), name
    assert page["surprise"] == _page(bridge_php, shelf="surprise", seed="whole-page-seed")["surprise"]


def test_random_shelves_respect_the_library_and_what_was_declined(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    _work(bridge_db, "Firefly/%", "Firefly", episode=True)
    bridge_db.user("musician", group=bridge_db.group("music-only", can_access_music=1))
    bridge_db.user("visitor", guest=True)
    bridge_db.user("somebody")

    # No film library: nothing of it is drawn, and the shelf still says what it would have been drawn with.
    home = _page(bridge_php, "musician", seed="any-seed-1")
    for name in ("random_films", "random_series"):
        assert home["shelves"][name] == {"cards": [], "has_more": False, "seed": "any-seed-1"}
    assert set(_titles(home["shelves"]["random_tracks"])) == TRACKS
    # A guest account gets all three: chance is nobody's history.
    guest = _page(bridge_php, "visitor")
    assert [len(guest["shelves"][name]["cards"]) for name in RANDOM] == [5, 1, 11] and guest["can_dismiss"] is False

    heat = bridge_db.item_id("Heat (1995)/Heat (1995).mkv")
    loose = bridge_db.item_id("Loose.mp3")
    for key in (f"item:{heat}", f"item:{loose}"):
        assert _dismiss(bridge_php, {"key": key})["ok"] is True
    for number in range(6):
        seed = f"declined-{number}"
        assert "Heat (1995)/Heat (1995).mkv" not in _titles(_shelf(bridge_php, "random_films", seed=seed))
        assert "Loose.mp3" not in _titles(_shelf(bridge_php, "random_tracks", seed=seed))
    assert len(_shelf(bridge_php, "random_films")["cards"]) == 4 and len(_shelf(bridge_php, "random_tracks")["cards"]) == 10
    assert len(_shelf(bridge_php, "random_films", "somebody")["cards"]) == 5

    # A film that left the catalogue since the list was remembered is simply not drawn.
    bridge_db.execute("UPDATE media_items SET deleted_at = CURRENT_TIMESTAMP(6), catalog_status = 'missing' WHERE id = %s",
                      (bridge_db.item_id("Loose Film (1999).mkv"),))
    assert "Loose Film (1999).mkv" not in _titles(_shelf(bridge_php, "random_films", "somebody"))
    assert len(_shelf(bridge_php, "random_films", "somebody")["cards"]) == 4


def test_a_large_music_library_is_probed_not_listed(bridge_db, bridge_library, bridge_php) -> None:
    """Tracks are too many to list or to sort: the seed names points on the index, each answered by one short read."""
    _library(bridge_db, bridge_library)
    bridge_library.scan("music2", "music", [f"Second/{number:02d} - Track.mp3" for number in range(1, 9)])
    bridge_db.execute("UPDATE media_items SET duration_ms = %s WHERE relative_path LIKE 'Second/%%'", (SONG,))
    bridge_db.tag("Singles/Lone.mp3", duration_ms=20 * 1000)
    # As a library of thousands of files in each source would have it (the top folder of a source says how many).
    bridge_db.execute("UPDATE media_directories SET descendant_file_count = 5000 WHERE parent_path_hash IS NULL")
    eligible = (TRACKS - {"Singles/Lone.mp3"}) | {f"Second/{number:02d} - Track.mp3" for number in range(1, 9)}

    seen: set[str] = set()
    orders = set()
    for number in range(8):
        shelf = _shelf(bridge_php, "random_tracks", seed=f"probe-seed-{number}", limit=4)
        titles = _titles(shelf)
        # Tracks only (no long recording, no skit, no cover), none twice, and the same for the same seed.
        # (Eighteen tracks stand in for thousands here, so two points often name one track; the spare
        # points are what still fills the shelf.)
        assert len(titles) == 4 and len(set(titles)) == 4 and set(titles) <= eligible, titles
        assert shelf["has_more"] is True and shelf["seed"] == f"probe-seed-{number}"
        assert shelf == _shelf(bridge_php, "random_tracks", seed=f"probe-seed-{number}", limit=4)
        seen |= set(titles)
        orders.add(tuple(titles))
    assert len(orders) == 8
    # Both sources are drawn from, and over a few seeds most of the library has had its turn.
    assert any(title.startswith("Second/") for title in seen) and any(not title.startswith("Second/") for title in seen)
    assert len(seen) >= 12

    declined = sorted(seen)[0]
    assert _dismiss(bridge_php, {"key": f"item:{bridge_db.item_id(declined)}"})["ok"] is True
    for number in range(8):
        assert declined not in _titles(_shelf(bridge_php, "random_tracks", seed=f"probe-seed-{number}", limit=4))
