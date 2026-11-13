"""Playlists (CatalogActions) against MySQL: hand-made and rule-based lists, and who may read them.

A rule-based list is one SQL filter read five ways — its page, its count, its
statistics, its cover candidates and its archive — and all five must agree for
every kind of rule. The joins behind them come and go with what the rule
mentions, so each rule is checked through all five.
"""
from __future__ import annotations

import json

import pytest

MUSIC = [
    "Abba/Arrival/01 - Dancing Queen.mp3",
    "Abba/Arrival/02 - Money.mp3",
    "Abba/Gold/01 - Waterloo.mp3",
    "Cafe/01 - Plain.mp3",
    "Queen/01 - Bohemian.mp3",
    "Queen/02 - Radio Ga Ga.mp3",
]
MOVIES = ["Dune (2021)/Dune (2021).mkv", "Alien (1979).mkv", "Heat (1995).mkv"]

SETUP = r"""
$actions = new CatalogActions($db);
$me = identity($db, 'listener');
$other = identity($db, 'other');
/** One smart list read every way the bridge reads it; all five must describe the same files. */
function readings(CatalogActions $actions, LegacyIdentity $who, int $id): array {
    $page = $actions->collectionPage($who, $id, 1, 100);
    $listed = null;
    foreach ($actions->collections($who, null, 'all', 'all', false) as $row) {
        if ($row['id'] === $id) { $listed = $row; }
    }
    $archive = attempt(fn () => $actions->archiveCollectionItemIds($who, $id));
    return [
        'paths' => array_map(static fn (array $i): string => $i['relative_path'], $page['items']),
        'total' => $page['total'],
        'listed_count' => $listed['item_count'] ?? null,
        'plays' => $listed['total_play_count'] ?? null,
        'items_rating' => [$listed['items_avg_rating'] ?? null, $listed['items_rating_count'] ?? null],
        'covers' => array_column($listed['preview_candidates'] ?? [], 'id'),
        'archive' => $archive['ok'] ? $archive['value'] : [],
        'guest_total' => $actions->guestCollection($who, $id, 500)['total'],
    ];
}
"""


@pytest.fixture
def catalogue(bridge_db, bridge_library):
    bridge_library.scan("music", "music", MUSIC)
    bridge_library.scan("movies", "movies", MOVIES)
    listener = bridge_db.user("listener")
    other = bridge_db.user("other")
    item = bridge_db.item_id
    # listener: two favourites, three ratings; other: one rating, one favourite.
    for path, rating, favourite in (
        ("Abba/Arrival/01 - Dancing Queen.mp3", 5.0, 1),
        ("Abba/Gold/01 - Waterloo.mp3", 3.0, 0),
        ("Queen/01 - Bohemian.mp3", None, 1),
        ("Cafe/01 - Plain.mp3", 1.5, 0),
    ):
        bridge_db.insert("user_ratings", user_id=listener, media_item_id=item(path), rating=rating, favorite=favourite)
    bridge_db.insert("user_ratings", user_id=other, media_item_id=item("Abba/Arrival/01 - Dancing Queen.mp3"),
                     rating=4.0, favorite=0)
    bridge_db.insert("user_ratings", user_id=other, media_item_id=item("Queen/02 - Radio Ga Ga.mp3"),
                     rating=None, favorite=1)
    # plays: listener 3 x Dancing Queen, 1 x Money; other 2 x Money, 5 x Radio Ga Ga (last week).
    for user, path, plays, when in (
        (listener, "Abba/Arrival/01 - Dancing Queen.mp3", 3, "2026-10-01 12:00:00"),
        (listener, "Abba/Arrival/02 - Money.mp3", 1, "2026-10-02 12:00:00"),
        (other, "Abba/Arrival/02 - Money.mp3", 2, "2026-11-05 12:00:00"),
        (other, "Queen/02 - Radio Ga Ga.mp3", 5, "2026-11-06 12:00:00"),
    ):
        bridge_db.insert("playback_stats", user_id=user, media_item_id=item(path), play_count=plays, last_played_at=when)
    for path, plays, when in (
        ("Abba/Arrival/01 - Dancing Queen.mp3", 3, "2026-10-01 12:00:00"),
        ("Abba/Arrival/02 - Money.mp3", 3, "2026-11-05 12:00:00"),
        ("Queen/02 - Radio Ga Ga.mp3", 5, "2026-11-06 12:00:00"),
    ):
        bridge_db.insert("media_play_totals", media_item_id=item(path), play_count=plays, last_played_at=when)
    bridge_db.tag("Abba/Arrival/01 - Dancing Queen.mp3", artist="ABBA", album="Arrival")
    bridge_db.execute("UPDATE media_items SET release_year = 1979 WHERE relative_path = 'Alien (1979).mkv'")
    return bridge_db


RULES = {
    "everything": ({}, MUSIC),
    "favourites": ({"favorite": "yes"}, ["Abba/Arrival/01 - Dancing Queen.mp3", "Queen/01 - Bohemian.mp3"]),
    "not favourites": ({"favorite": "no"}, [
        "Abba/Arrival/02 - Money.mp3", "Abba/Gold/01 - Waterloo.mp3", "Cafe/01 - Plain.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "rated": ({"rating_status": "rated"}, [
        "Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Gold/01 - Waterloo.mp3", "Cafe/01 - Plain.mp3",
    ]),
    "unrated": ({"rating_status": "unrated"}, [
        "Abba/Arrival/02 - Money.mp3", "Queen/01 - Bohemian.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "own rating from 3": ({"rating_scope": "own", "min_user_rating": 3}, [
        "Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Gold/01 - Waterloo.mp3",
    ]),
    "own rating up to 2 (unrated count as none)": ({"rating_scope": "own", "max_user_rating": 2}, [
        "Abba/Arrival/02 - Money.mp3", "Cafe/01 - Plain.mp3", "Queen/01 - Bohemian.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "average from 4": ({"rating_scope": "community", "min_rating": 4}, ["Abba/Arrival/01 - Dancing Queen.mp3"]),
    "average up to 2": ({"rating_scope": "community", "max_rating": 2}, [
        "Abba/Arrival/02 - Money.mp3", "Cafe/01 - Plain.mp3", "Queen/01 - Bohemian.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "both ratings": ({"rating_scope": "both", "min_user_rating": 3, "min_rating": 4}, [
        "Abba/Arrival/01 - Dancing Queen.mp3",
    ]),
    "rated by two": ({"min_rating_count": 2}, ["Abba/Arrival/01 - Dancing Queen.mp3"]),
    "rated by at most one": ({"max_rating_count": 1}, [path for path in MUSIC if "Dancing" not in path]),
    "played at all": ({"play_scope": "total", "min_plays": 1}, [
        "Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Arrival/02 - Money.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "played at most 3 times": ({"play_scope": "total", "max_plays": 3}, [path for path in MUSIC if "Radio" not in path]),
    "played by me twice": ({"play_scope": "own", "min_plays": 2}, ["Abba/Arrival/01 - Dancing Queen.mp3"]),
    "never played by me": ({"play_scope": "unplayed"}, [
        "Abba/Gold/01 - Waterloo.mp3", "Cafe/01 - Plain.mp3", "Queen/01 - Bohemian.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "played by others": ({"play_scope": "others", "min_plays": 1}, [
        "Abba/Arrival/02 - Money.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "played by others in November": ({"date_scope": "others", "played_from": "2026-11-01", "played_to": "2026-11-05"}, [
        "Abba/Arrival/02 - Money.mp3",
    ]),
    "played by me in October": ({"date_scope": "own", "played_from": "2026-10-01", "played_to": "2026-10-01"}, [
        "Abba/Arrival/01 - Dancing Queen.mp3",
    ]),
    "played by anyone since November": ({"date_scope": "total", "played_from": "2026-11-01"}, [
        "Abba/Arrival/02 - Money.mp3", "Queen/02 - Radio Ga Ga.mp3",
    ]),
    "by name": ({"query": "abba arrival"}, ["Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Arrival/02 - Money.mp3"]),
    "favourite and played": ({"favorite": "yes", "play_scope": "total", "min_plays": 1}, [
        "Abba/Arrival/01 - Dancing Queen.mp3",
    ]),
}


@pytest.mark.parametrize("name", list(RULES))
def test_a_rule_reads_the_same_through_every_door(catalogue, bridge_php, name: str) -> None:
    rules, expected = RULES[name]
    result = bridge_php.run(SETUP + r"""
    $created = $actions->createCollection($me, ['name' => 'Smart', 'media_kind' => 'music',
        'rules' => json_decode('RULES', true) ?: (object) []]);
    out(readings($actions, $me, $created['id']));
    """.replace("(object) []", "['favorite' => 'any']").replace("RULES", json.dumps(rules)))
    assert sorted(result["paths"]) == sorted(expected)
    assert result["total"] == len(expected)
    assert result["listed_count"] == len(expected)
    assert result["guest_total"] == len(expected)
    expected_ids = sorted(catalogue.item_id(path) for path in expected)
    assert sorted(result["archive"]) == expected_ids
    assert sorted(result["covers"]) == expected_ids[:16]
    plays = {"Abba/Arrival/01 - Dancing Queen.mp3": 3, "Abba/Arrival/02 - Money.mp3": 3, "Queen/02 - Radio Ga Ga.mp3": 5}
    assert result["plays"] == sum(plays.get(path, 0) for path in expected)


def test_film_rules_by_year_and_genre(catalogue, bridge_php) -> None:
    genre = catalogue.value("SELECT id FROM media_genres ORDER BY id LIMIT 1")
    catalogue.insert("media_item_genres", media_item_id=catalogue.item_id("Heat (1995).mkv"), genre_id=genre)
    result = bridge_php.run(SETUP + r"""
    $make = fn (array $rules) => readings($actions, $me, $actions->createCollection($me,
        ['name' => 'Films ' . json_encode($rules), 'media_kind' => 'movies', 'rules' => $rules])['id'])['paths'];
    out(['seventies' => $make(['min_year' => 1970, 'max_year' => 1979]),
         'genre' => $make(['genres' => [GENRE]]),
         'all' => $make(['favorite' => 'any'])]);
    """.replace("GENRE", str(genre)))
    assert result["seventies"] == ["Alien (1979).mkv"]
    assert result["genre"] == ["Heat (1995).mkv"]
    assert sorted(result["all"]) == sorted(MOVIES)


def test_a_hand_made_list_keeps_its_order_and_its_statistics(catalogue, bridge_php) -> None:
    ids = [catalogue.item_id(path) for path in ("Queen/02 - Radio Ga Ga.mp3", "Abba/Arrival/01 - Dancing Queen.mp3",
                                                "Cafe/01 - Plain.mp3")]
    result = bridge_php.run(SETUP + r"""
    $id = $actions->createCollection($me, ['name' => 'Mine', 'media_kind' => 'music'])['id'];
    foreach (IDS as $item) { $actions->setCollectionItem($me, ['collection_id' => $id, 'media_item_id' => $item]); }
    $first = readings($actions, $me, $id);
    $actions->setCollectionItem($me, ['collection_id' => $id, 'media_item_id' => IDS[1], 'included' => false]);
    $by_added = array_column($actions->collectionPage($me, $id, 1, 100, '', 0, 'added_desc')['items'], 'id');
    out(['first' => $first, 'after_removal' => readings($actions, $me, $id)['paths'], 'by_added' => $by_added,
         'film_refused' => attempt(fn () => $actions->setCollectionItem($me, ['collection_id' => $id, 'media_item_id' => FILM])),
         'smart_refused' => attempt(fn () => $actions->setCollectionItem($me, [
             'collection_id' => $actions->createCollection($me, ['name' => 'S', 'media_kind' => 'music', 'rules' => ['favorite' => 'yes']])['id'],
             'media_item_id' => IDS[0]]))]);
    """.replace("IDS", json.dumps(ids)).replace("FILM", str(catalogue.item_id("Alien (1979).mkv"))))
    first = result["first"]
    assert first["paths"] == ["Queen/02 - Radio Ga Ga.mp3", "Abba/Arrival/01 - Dancing Queen.mp3", "Cafe/01 - Plain.mp3"]
    assert first["total"] == 3 and first["listed_count"] == 3 and first["guest_total"] == 3
    assert first["plays"] == 8
    # Three ratings on its tracks: 5 and 4 for one, 1.5 for another.
    assert first["items_rating"] == [3.5, 3]
    assert first["covers"] == ids and first["archive"] == ids
    assert result["after_removal"] == ["Queen/02 - Radio Ga Ga.mp3", "Cafe/01 - Plain.mp3"]
    assert result["by_added"] == [ids[2], ids[0]]
    assert result["film_refused"]["ok"] is False
    assert result["smart_refused"]["error"] == "BridgeRequestException"


def test_added_order_of_a_rule_based_list_is_when_the_file_entered_the_catalogue(catalogue, bridge_php) -> None:
    """Not when it was last scanned: every scan rewrites indexed_at for every file (C-01)."""
    catalogue.execute("UPDATE media_items SET created_at = '2026-01-01 00:00:00', indexed_at = CURRENT_TIMESTAMP(6)")
    newest = catalogue.item_id("Cafe/01 - Plain.mp3")
    newer = catalogue.item_id("Queen/01 - Bohemian.mp3")
    catalogue.execute("UPDATE media_items SET created_at = '2026-11-10 00:00:00' WHERE id = %s", (newest,))
    catalogue.execute("UPDATE media_items SET created_at = '2026-11-01 00:00:00', indexed_at = '2027-01-01' WHERE id = %s", (newer,))
    result = bridge_php.run(SETUP + r"""
    $id = $actions->createCollection($me, ['name' => 'All', 'media_kind' => 'music', 'rules' => ['favorite' => 'any']])['id'];
    out(array_slice(array_column($actions->collectionPage($me, $id, 1, 100, '', 0, 'added_desc')['items'], 'id'), 0, 2));
    """)
    assert result == [newest, newer]


def test_who_may_read_and_change_a_list(catalogue, bridge_php) -> None:
    catalogue.user("nolists", group=catalogue.group("nolists", can_access_music=1))
    catalogue.user("musiconly", group=catalogue.group("musiconly", can_access_music=1, can_create_collections=1,
                                                      can_browse_collections=1))
    result = bridge_php.run(SETUP + r"""
    $private = $actions->createCollection($me, ['name' => 'Private', 'media_kind' => 'music'])['id'];
    $shared = $actions->createCollection($me, ['name' => 'Shared', 'media_kind' => 'music'])['id'];
    $films = $actions->createCollection($me, ['name' => 'Films', 'media_kind' => 'movies'])['id'];
    $actions->setCollectionShared($me, ['collection_id' => $shared, 'shared' => true]);
    $actions->setCollectionShared($me, ['collection_id' => $films, 'shared' => true]);
    $nolists = identity($db, 'nolists');
    $musiconly = identity($db, 'musiconly');
    $names = static fn (array $rows): array => array_column($rows, 'name');
    out([
        'other_reads_private' => attempt(fn () => $actions->collectionPage($other, $private)),
        'other_reads_shared' => attempt(fn () => $actions->collectionPage($other, $shared)['collection']['is_owned']),
        'other_lists_others' => $names($actions->collections($other, null, 'others')),
        'other_lists_mine' => $names($actions->collections($other, null, 'mine')),
        'other_changes_shared' => attempt(fn () => $actions->updateCollection($other, ['collection_id' => $shared, 'name' => 'Stolen'])),
        'other_adds_to_shared' => attempt(fn () => $actions->setCollectionItem($other, ['collection_id' => $shared, 'media_item_id' => ITEM])),
        'other_deletes_shared' => attempt(fn () => $actions->deleteCollection($other, ['collection_id' => $shared])),
        'nolists_creates' => attempt(fn () => $actions->createCollection($nolists, ['name' => 'Nope', 'media_kind' => 'music'])),
        'nolists_browses_others' => attempt(fn () => $actions->collections($nolists, null, 'others')),
        'musiconly_lists_others' => $names($actions->collections($musiconly, null, 'others')),
        'musiconly_reads_films' => attempt(fn () => $actions->collectionPage($musiconly, $films)),
        'musiconly_film_archive' => attempt(fn () => $actions->archiveCollectionItemIds($musiconly, $films)),
        'musiconly_makes_film_list' => attempt(fn () => $actions->createCollection($musiconly, ['name' => 'F', 'media_kind' => 'movies'])),
        'owner_lists' => $names($actions->collections($me, null, 'mine', 'all', true, 'name_asc')),
    ]);
    """.replace("ITEM", str(catalogue.item_id("Cafe/01 - Plain.mp3"))))
    assert result["other_reads_private"]["error"] == "CatalogItemNotFoundException"
    assert result["other_reads_shared"] == {"ok": True, "value": False}
    assert sorted(result["other_lists_others"]) == ["Films", "Shared"]
    assert result["other_lists_mine"] == []
    for key in ("other_changes_shared", "other_adds_to_shared", "other_deletes_shared"):
        assert result[key]["error"] == "CatalogItemNotFoundException", key
    assert result["nolists_creates"]["error"] == "BridgeAuthorizationException"
    assert result["nolists_browses_others"]["error"] == "BridgeAuthorizationException"
    # A group without the film library is shown music lists only, and cannot open a film list by its number.
    assert result["musiconly_lists_others"] == ["Shared"]
    assert result["musiconly_reads_films"]["error"] == "BridgeAuthorizationException"
    assert result["musiconly_film_archive"]["error"] == "BridgeAuthorizationException"
    assert result["owner_lists"] == ["Films", "Private", "Shared"]


def test_a_second_list_of_the_same_name_is_refused_in_words(catalogue, bridge_php) -> None:
    """The unique key used to answer for us — as a 500 the page explained with a migration (ACC-03)."""
    result = bridge_php.run(SETUP + r"""
    $first = $actions->createCollection($me, ['name' => 'Wieczór', 'media_kind' => 'music'])['id'];
    $second = $actions->createCollection($me, ['name' => 'Inna', 'media_kind' => 'music'])['id'];
    out([
        'same' => attempt(fn () => $actions->createCollection($me, ['name' => 'Wieczór', 'media_kind' => 'music'])),
        'same_other_case' => attempt(fn () => $actions->createCollection($me, ['name' => 'WIECZÓR', 'media_kind' => 'music'])),
        'smart_same' => attempt(fn () => $actions->createCollection($me, ['name' => 'Wieczór', 'media_kind' => 'music', 'rules' => ['favorite' => 'yes']])),
        'other_library' => attempt(fn () => $actions->createCollection($me, ['name' => 'Wieczór', 'media_kind' => 'movies'])['success']),
        'other_account' => attempt(fn () => $actions->createCollection($other, ['name' => 'Wieczór', 'media_kind' => 'music'])['success']),
        'rename_onto' => attempt(fn () => $actions->updateCollection($me, ['collection_id' => $second, 'name' => 'Wieczór'])),
        'rename_itself' => attempt(fn () => $actions->updateCollection($me, ['collection_id' => $first, 'name' => 'Wieczór', 'description' => 'x'])['success']),
    ]);
    """)
    for key in ("same", "same_other_case", "smart_same", "rename_onto"):
        assert result[key]["error"] == "BridgeRequestException", key
        assert result[key]["message"] == "Masz już playlistę o tej nazwie. Wybierz inną nazwę.", key
    assert result["other_library"] == {"ok": True, "value": True}
    assert result["other_account"] == {"ok": True, "value": True}
    assert result["rename_itself"] == {"ok": True, "value": True}


def test_a_film_on_a_playlist_carries_the_same_details_as_in_the_library(catalogue, bridge_php) -> None:
    """The playlist side had its own copy of the projection, and it had fallen behind (C-02)."""
    probe = {"video": {"schema": 2, "container": "matroska,webm", "video_codec": "hevc", "video_bitrate": 12000000,
                       "pixel_format": "yuv420p10le", "color_space": "bt2020nc", "color_transfer": "smpte2084",
                       "audio_tracks": [{"index": 1, "language": "pol"}], "subtitle_tracks": [{"index": 2, "language": "eng"}]}}
    film = catalogue.tag("Heat (1995).mkv", metadata_json=json.dumps(probe), video_height=2160, is_hdr=1)
    result = bridge_php.run(SETUP + r"""
    $browser = new LibraryBrowser($db);
    $id = $actions->createCollection($me, ['name' => 'Films', 'media_kind' => 'movies'])['id'];
    $actions->setCollectionItem($me, ['collection_id' => $id, 'media_item_id' => FILM]);
    $onList = $actions->collectionPage($me, $id)['items'][0];
    $inLibrary = array_values(array_filter($browser->browse($me, 'movies', null)['items'], static fn (array $i): bool => $i['id'] === FILM))[0];
    out(['same' => $onList === $inLibrary, 'probe' => $onList['probe']]);
    """.replace("FILM", str(film)))
    assert result["same"] is True
    assert result["probe"]["audio_tracks"] == [{"index": 1, "language": "pol"}]
    assert result["probe"]["video_bitrate"] == 12000000 and result["probe"]["color_transfer"] == "smpte2084"
    assert result["probe"]["bit_depth"] == 10


def test_years_alone_leave_a_folders_genres_and_its_place_in_the_queue(catalogue, bridge_php) -> None:
    """A decision carrying only years wiped the folder's genres and closed every work as settled (C-04)."""
    catalogue.user("operator", role="admin")
    genre, other_genre = (row["id"] for row in catalogue.rows("SELECT id FROM media_genres ORDER BY id LIMIT 2"))
    film = catalogue.item_id("Dune (2021)/Dune (2021).mkv")
    root_id, subject = (catalogue.row("SELECT root_id, title_subject_hash FROM media_items WHERE id = %s", (film,))[key]
                        for key in ("root_id", "title_subject_hash"))
    lookup = catalogue.insert("media_title_lookups", root_id=root_id, subject_hash=subject, subject_key="Dune",
                              query_title="Dune", status="review")
    catalogue.insert("media_item_genres", media_item_id=film, genre_id=genre)
    result = bridge_php.run(SETUP + r"""
    $operator = identity($db, 'operator');
    $state = fn (): array => [
        (int) $db->query('SELECT release_year FROM media_items WHERE id = FILM')->fetchColumn(),
        array_map('intval', $db->query('SELECT genre_id FROM media_item_genres WHERE media_item_id = FILM ORDER BY genre_id')->fetchAll(PDO::FETCH_COLUMN)),
        $db->query('SELECT status FROM media_title_lookups WHERE id = LOOKUP')->fetchColumn(),
    ];
    $years = $actions->decideTitleLookupFolder($operator, ['folder' => 'Dune (2021)', 'status' => 'review', 'year' => 1984]);
    $afterYears = $state();
    $genres = $actions->decideTitleLookupFolder($operator, ['folder' => 'Dune (2021)', 'status' => 'review', 'genres' => [OTHER]]);
    out(['years' => $years, 'after_years' => $afterYears, 'genres' => $genres, 'after_genres' => $state(),
         'nothing' => attempt(fn () => $actions->decideTitleLookupFolder($operator, ['folder' => 'Dune (2021)', 'status' => 'review'])),
         'not_an_operator' => attempt(fn () => $actions->decideTitleLookupFolder($me, ['folder' => 'Dune (2021)', 'year' => 1984]))]);
    """.replace("FILM", str(film)).replace("LOOKUP", str(lookup)).replace("OTHER", str(other_genre)))
    assert result["years"] == {"success": True, "works": 1, "files": 1, "closed": False}
    assert result["after_years"] == [1984, [genre], "review"]
    assert result["genres"]["closed"] is True
    assert result["after_genres"] == [1984, [other_genre], "matched"]
    assert result["nothing"]["error"] == "BridgeRequestException"
    assert result["not_an_operator"]["error"] == "BridgeAuthorizationException"
