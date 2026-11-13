"""LibraryBrowser against MySQL: what a folder holds, by listing, search, queue and archive.

The library is real folders of empty files catalogued by the real scanner
(tests/bridge_harness.py), including the names that used to leak between folders:
`_` and `%` in a folder name (LIKE wildcards) and two folders that differ only by
an accent (the column's collation calls them equal).
"""
from __future__ import annotations

import json

MUSIC = [
    "Abba/Arrival/01 - Dancing Queen.mp3",
    "Abba/Arrival/02 - Money.mp3",
    "Abba/Arrival/cover.jpg",
    "Abba/Gold/01 - Waterloo.mp3",
    "Cafe/01 - Plain.mp3",
    "Café/01 - Accent.mp3",
    "Space_Sessions/a_b.mp3",
    "Space Sessions/a b.mp3",
    "100%/percent.mp3",
    "100x/letter.mp3",
    "Loose.mp3",
]
MOVIES = [
    "Dune (2021)/Dune (2021).mkv",
    "Dune (2021)/poster.jpg",
    "Firefly/Firefly - 1x01 - Serenity.mkv",
    "Firefly/Firefly - 1x02 - The Train Job.mkv",
    "Firefly/Firefly - 1x03 - Bushwhacked.mkv",
    "Loose Film (1999).mkv",
]

SETUP = r"""
$browser = new LibraryBrowser($db);
$me = identity($db, 'listener');
$titles = static fn (array $items): array => array_map(static fn (array $item): string => $item['relative_path'], $items);
"""


def _paths(bridge_db, ids: list[int]) -> list[str]:
    if not ids:
        return []
    marks = ", ".join(["%s"] * len(ids))
    rows = bridge_db.rows(f"SELECT relative_path FROM media_items WHERE id IN ({marks})", ids)
    # Sorted here, by code point: the database's collation files "Café" with "Cafe".
    return sorted(row["relative_path"] for row in rows)


def _library(bridge_db, bridge_library) -> None:
    bridge_library.scan("music", "music", MUSIC)
    bridge_library.scan("movies", "movies", MOVIES)
    bridge_db.user("listener")


def test_browse_lists_folders_then_the_folders_own_files(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    result = bridge_php.run(SETUP + r"""
    $root = $browser->browse($me, 'music', null);
    $abba = $browser->browse($me, 'music', (int) getenv('ABBA'));
    out(['root_dirs' => array_column($root['directories'], 'name'), 'root_items' => $titles($root['items']),
         'abba_dirs' => array_column($abba['directories'], 'name'), 'abba_items' => $titles($abba['items']),
         'crumbs' => array_column($abba['breadcrumbs'], 'name'),
         'previews' => array_map(static fn (array $d): int => count($d['preview_candidates']), $root['directories'])]);
    """.replace("getenv('ABBA')", str(bridge_db.directory_id("Abba", "music"))))
    assert result["root_dirs"] == ["100%", "100x", "Abba", "Cafe", "Café", "Space Sessions", "Space_Sessions"]
    assert result["root_items"] == ["Loose.mp3"]
    assert result["abba_dirs"] == ["Arrival", "Gold"]
    assert result["abba_items"] == []
    assert result["crumbs"] == ["Music", "Abba"]
    # Every folder card is offered its own tracks as covers, and no neighbour's: one each,
    # and Abba's three with the cover picture that is the folder's own preview.
    assert result["previews"] == [1, 1, 4, 1, 1, 1, 1]


def test_a_folders_queue_archive_and_search_stay_inside_it(bridge_db, bridge_library, bridge_php) -> None:
    """`Cafe` is not `Café`, `Space_Sessions` is not `Space Sessions`, `100%` is not `100x`."""
    _library(bridge_db, bridge_library)
    folders = {name: bridge_db.directory_id(name, "music") for name in
               ("Cafe", "Café", "Space_Sessions", "Space Sessions", "100%", "100x", "Abba")}
    result = bridge_php.run(SETUP + r"""
    $folders = json_decode((string) getenv('FOLDERS'), true);
    $answer = [];
    foreach ($folders as $name => $id) {
        $queue = $browser->queue($me, 'music', $id, 0, 100);
        $shuffled = $browser->queue($me, 'music', $id, 0, 100, 'after', '', 'current', 'seed1234');
        $answer[$name] = [
            'queue' => $titles($queue['items']), 'total' => $queue['total'],
            'shuffled' => count($shuffled['items']),
            'archive' => $browser->archiveItemIds('music', $id),
            'previews' => array_column($browser->browse($me, 'music', $id)['directory']['preview_candidates'], 'id'),
            'filtered' => $titles($browser->browse($me, 'music', $id, '', 1, 48, 'title_asc', '', ['format' => 'mp3'])['items']),
            'searched' => $titles($browser->browse($me, 'music', $id, 'mp3')['items']),
        ];
    }
    out($answer);
    """.replace("getenv('FOLDERS')", "'" + json.dumps(folders).replace("\\", "\\\\").replace("'", "\\'") + "'"))

    expected = {
        "Cafe": ["Cafe/01 - Plain.mp3"],
        "Café": ["Café/01 - Accent.mp3"],
        "Space_Sessions": ["Space_Sessions/a_b.mp3"],
        "Space Sessions": ["Space Sessions/a b.mp3"],
        "100%": ["100%/percent.mp3"],
        "100x": ["100x/letter.mp3"],
        "Abba": ["Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Arrival/02 - Money.mp3", "Abba/Gold/01 - Waterloo.mp3"],
    }
    for name, paths in expected.items():
        answer = result[name]
        # The queue runs in catalogue order (by id), listings by title: compared as sets.
        assert sorted(answer["queue"]) == paths, name
        assert answer["total"] == len(paths), name
        assert answer["shuffled"] == len(paths), name
        assert sorted(answer["filtered"]) == paths, name
        assert sorted(answer["searched"]) == paths, name
        # Cover candidates: the folder's tracks (and its own picture, where it has one).
        assert [path for path in _paths(bridge_db, answer["previews"]) if path.endswith(".mp3")] == paths, name
        archived = _paths(bridge_db, answer["archive"])
        # The archive takes every catalogued file of the folder, the cover included.
        assert [path for path in archived if path.endswith(".mp3")] == paths, name
    assert "Abba/Arrival/cover.jpg" in _paths(bridge_db, result["Abba"]["archive"])


def test_the_root_reaches_the_whole_library_and_a_search_archive_follows_matching_folders(
    bridge_db, bridge_library, bridge_php
) -> None:
    _library(bridge_db, bridge_library)
    root = bridge_db.directory_id("", "music")
    result = bridge_php.run(SETUP + r"""
    $root = (int) getenv('ROOT');
    $queue = $browser->queue($me, 'music', $root, 0, 100);
    out(['queue' => count($queue['items']), 'total' => $queue['total'],
         'scope' => [$browser->directoryScope('music', $root), $browser->directoryScope('music', (int) getenv('ABBA'))],
         'search_arrival' => $browser->archiveSearchItemIds('music', $root, 'arrival'),
         'search_cafe' => $browser->archiveSearchItemIds('music', $root, 'cafe'),
         'search_none' => attempt(fn () => $browser->archiveSearchItemIds('music', $root, 'no such thing'))]);
    """.replace("getenv('ROOT')", str(root)).replace("getenv('ABBA')", str(bridge_db.directory_id("Abba", "music"))))
    assert result["queue"] == 10 and result["total"] == 10
    assert result["scope"] == ["library", "folder"]
    assert _paths(bridge_db, result["search_arrival"]) == [
        "Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Arrival/02 - Money.mp3", "Abba/Arrival/cover.jpg",
    ]
    # A search is a search: it folds accents the way the listing's search box does,
    # so both cafés answer — but each folder brings only its own files.
    assert _paths(bridge_db, result["search_cafe"]) == ["Cafe/01 - Plain.mp3", "Café/01 - Accent.mp3"]
    assert result["search_none"]["error"] == "BridgeRequestException"


def test_a_library_the_group_cannot_open_is_refused_everywhere(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.user("musiconly", group=bridge_db.group("musiconly", can_access_music=1, can_download_file=1))
    film = bridge_db.item_id("Dune (2021)/Dune (2021).mkv")
    track = bridge_db.item_id("Loose.mp3")
    result = bridge_php.run(r"""
    $actions = new CatalogActions($db);
    $gateway = new CatalogTransferGateway($db, $transferKey);
    $me = identity($db, 'musiconly');
    out([
        'browse_movies' => attempt(fn () => $actions->assertLibraryAccess($me, 'movies')),
        'browse_music' => attempt(fn () => $actions->assertLibraryAccess($me, 'music')),
        'libraries' => $actions->accessibleLibraries($me),
        'rate_film' => attempt(fn () => $actions->rate($me, ['media_item_id' => FILM, 'favorite' => true])),
        'play_film' => attempt(fn () => $actions->playback($me, ['media_item_id' => FILM, 'event' => 'start'])),
        'file_film' => attempt(fn () => $gateway->file($me, FILM, true)),
        'thumb_film' => attempt(fn () => $gateway->thumbnail($me, FILM)),
        'file_track' => attempt(fn () => $gateway->file($me, TRACK, true)['media_kind']),
        'archive_mixed' => attempt(fn () => $gateway->archive($me, [TRACK, FILM])),
    ]);
    """.replace("FILM", str(film)).replace("TRACK", str(track)))
    assert result["browse_movies"]["error"] == "BridgeAuthorizationException"
    assert result["browse_music"]["ok"] is True
    assert result["libraries"] == {"music": True, "movies": False}
    for key in ("rate_film", "play_film", "file_film", "thumb_film", "archive_mixed"):
        assert result[key]["ok"] is False, key
    assert result["file_track"] == {"ok": True, "value": "audio"}


def test_folder_ratings_and_the_orders_built_on_them(bridge_db, bridge_library, bridge_php) -> None:
    """A folder's rating and plays are those of everything below it, for music and for films alike."""
    _library(bridge_db, bridge_library)
    listener = bridge_db.value("SELECT id FROM users WHERE username = 'listener'")
    other = bridge_db.user("other")
    ratings = {
        "Abba/Arrival/01 - Dancing Queen.mp3": [(listener, 5.0), (other, 4.0)],
        "Abba/Gold/01 - Waterloo.mp3": [(listener, 3.0)],
        "Cafe/01 - Plain.mp3": [(listener, 2.0)],
        "Dune (2021)/Dune (2021).mkv": [(other, 4.5)],
    }
    for path, votes in ratings.items():
        for user, rating in votes:
            bridge_db.insert("user_ratings", user_id=user, media_item_id=bridge_db.item_id(path), rating=rating)
    # A favourite without stars is not a rating.
    bridge_db.insert("user_ratings", user_id=other, media_item_id=bridge_db.item_id("Café/01 - Accent.mp3"), favorite=1)
    for path, plays in {"Space_Sessions/a_b.mp3": 7, "Abba/Arrival/02 - Money.mp3": 2,
                        "Abba/Gold/01 - Waterloo.mp3": 3, "Firefly/Firefly - 1x02 - The Train Job.mkv": 4}.items():
        bridge_db.insert("media_play_totals", media_item_id=bridge_db.item_id(path), play_count=plays)

    result = bridge_php.run(SETUP + r"""
    $card = static fn (array $d): array => [$d['name'], $d['avg_rating'], $d['rating_count']];
    $names = static fn (array $listing): array => array_column($listing['directories'], 'name');
    $abba = (int) getenv('ABBA');
    out([
        'music' => array_map($card, $browser->browse($me, 'music', null)['directories']),
        'abba' => array_map($card, $browser->browse($me, 'music', $abba)['directories']),
        'abba_itself' => $card($browser->browse($me, 'music', $abba)['directory']),
        'movies' => array_map($card, $browser->browse($me, 'movies', null)['directories']),
        'by_rating' => $names($browser->browse($me, 'music', null, '', 1, 48, 'rating_desc')),
        'by_rating_count' => $names($browser->browse($me, 'music', null, '', 1, 48, 'rating_count_desc')),
        'by_plays' => $names($browser->browse($me, 'music', null, '', 1, 48, 'plays_desc')),
        'by_plays_page_2' => $names($browser->browse($me, 'music', null, '', 2, 3, 'plays_desc')),
        'by_plays_in_abba' => $names($browser->browse($me, 'music', $abba, '', 1, 48, 'plays_desc')),
        'movies_by_plays' => $names($browser->browse($me, 'movies', null, '', 1, 48, 'plays_desc')),
        'movies_by_rating' => $names($browser->browse($me, 'movies', null, '', 1, 48, 'rating_desc')),
        'searched_by_rating' => $names($browser->browse($me, 'music', null, 'a', 1, 48, 'rating_desc')),
    ]);
    """.replace("getenv('ABBA')", str(bridge_db.directory_id("Abba", "music"))))

    assert result["music"] == [
        ["100%", 0, 0], ["100x", 0, 0], ["Abba", 4, 3], ["Cafe", 2, 1], ["Café", 0, 0],
        ["Space Sessions", 0, 0], ["Space_Sessions", 0, 0],
    ]
    assert result["abba"] == [["Arrival", 4.5, 2], ["Gold", 3, 1]]
    assert result["abba_itself"] == ["Abba", 4, 3]
    # Film folders carry their films' ratings (they used to count tracks only, so always none).
    assert result["movies"] == [["Dune (2021)", 4.5, 1], ["Firefly", 0, 0]]
    assert result["by_rating"] == ["Abba", "Cafe", "100%", "100x", "Café", "Space Sessions", "Space_Sessions"]
    assert result["by_rating_count"] == ["Abba", "Cafe", "100%", "100x", "Café", "Space Sessions", "Space_Sessions"]
    assert result["by_plays"] == ["Space_Sessions", "Abba", "100%", "100x", "Cafe", "Café", "Space Sessions"]
    assert result["by_plays_page_2"] == ["100x", "Cafe", "Café"]
    assert result["by_plays_in_abba"] == ["Gold", "Arrival"]
    assert result["movies_by_plays"] == ["Firefly", "Dune (2021)"]
    assert result["movies_by_rating"] == ["Dune (2021)", "Firefly"]
    # A search lists matching folders from every depth; each still carries its own subtree's rating.
    assert result["searched_by_rating"][:4] == ["Arrival", "Abba", "Gold", "Cafe"]


def test_search_finds_a_file_by_name_path_tags_and_corrected_tags(bridge_db, bridge_library, bridge_php) -> None:
    _library(bridge_db, bridge_library)
    loose = bridge_db.tag(
        "Loose.mp3", title="Bohemian Rhapsody", artist="Queen", album="A Night at the Opera",
        metadata_json=json.dumps({"audio": {"genre": "Rock", "year": "1975"}}),
    )
    corrected = bridge_db.item_id("Cafe/01 - Plain.mp3")
    bridge_db.insert("media_metadata_overrides", media_item_id=corrected, title="Poprawiony Tytuł", artist="Ktoś")
    queries = ["bohemian", "queen opera", "opera queen", "rock", "1975", "dancing queen", "space sessions", "space_sessions",
               "poprawiony", "ktoś", "plain", "accent", "100%", "nothing like this", "BOHEMIAN  rhapsody"]
    result = bridge_php.run(SETUP + r"""
    $answers = [];
    foreach (json_decode((string) getenv('QUERIES'), true) as $query) {
        $listing = $browser->browse($me, 'music', null, $query);
        $answers[$query] = ['items' => $titles($listing['items']), 'queue' => $browser->queue($me, 'music', ROOT, 0, 100, 'after', $query)['total']];
    }
    out($answers);
    """.replace("getenv('QUERIES')", "'" + json.dumps(queries) + "'").replace("ROOT", str(bridge_db.directory_id("", "music"))))
    expected = {
        "bohemian": ["Loose.mp3"],
        "queen opera": ["Loose.mp3"],
        "opera queen": ["Loose.mp3"],
        "rock": ["Loose.mp3"],
        "1975": ["Loose.mp3"],
        "dancing queen": ["Abba/Arrival/01 - Dancing Queen.mp3"],
        "space sessions": ["Space Sessions/a b.mp3", "Space_Sessions/a_b.mp3"],
        "space_sessions": ["Space Sessions/a b.mp3", "Space_Sessions/a_b.mp3"],
        "poprawiony": ["Cafe/01 - Plain.mp3"],
        "ktoś": ["Cafe/01 - Plain.mp3"],
        # Found by what the file itself says too, not only by the correction.
        "plain": ["Cafe/01 - Plain.mp3"],
        "accent": ["Café/01 - Accent.mp3"],
        "100%": ["100%/percent.mp3"],
        "nothing like this": [],
        "BOHEMIAN  rhapsody": ["Loose.mp3"],
    }
    for query, paths in expected.items():
        assert sorted(result[query]["items"]) == paths, query
        assert result[query]["queue"] == len(paths), query
    assert loose > 0


def test_filter_options_are_counted_from_the_catalogue_and_remembered_until_the_next_scan(
    bridge_db, bridge_library, bridge_php
) -> None:
    _library(bridge_db, bridge_library)
    bridge_db.tag("Dune (2021)/Dune (2021).mkv", video_height=2160, video_codec="hevc", audio_codec="eac3", is_hdr=1)
    for episode in ("1x01 - Serenity", "1x02 - The Train Job", "1x03 - Bushwhacked"):
        bridge_db.tag(f"Firefly/Firefly - {episode}.mkv", video_height=1080, video_codec="h264", audio_codec="aac")
    bridge_db.tag("Loose Film (1999).mkv", video_height=720, video_codec="h264", audio_codec="ac3", release_year=1999)
    script = SETUP + r"""out(['movies' => $browser->filterOptions('movies'), 'music' => $browser->filterOptions('music')]);"""
    first = bridge_php.run(script)
    movies = first["movies"]
    assert movies["probed"] == 5 and movies["hdr"] == 1
    assert movies["resolutions"] == {"uhd": 1, "fhd": 3, "hd": 1}
    assert movies["video_codecs"] == [{"value": "h264", "count": 4}, {"value": "hevc", "count": 1}]
    assert movies["audio_codecs"] == [
        {"value": "aac", "count": 3}, {"value": "ac3", "count": 1}, {"value": "eac3", "count": 1},
    ]
    assert movies["decades"] == [{"decade": 2020, "count": 1}, {"decade": 1990, "count": 1}]
    assert movies["unidentified"] == 5
    music = first["music"]
    assert music["formats"] == [{"value": "mp3", "count": 10}]
    assert music["quality"] == {"lossless": 0, "high": 0, "standard": 10}

    # The catalogue moves on; the answer is kept until a scan completes (or five minutes pass).
    bridge_db.tag("Loose Film (1999).mkv", video_height=2160)
    assert bridge_php.run(script) == first
    bridge_library.scan("movies", "movies", MOVIES)
    after_scan = bridge_php.run(script)
    assert after_scan["movies"]["resolutions"] == {"uhd": 2, "fhd": 3}


def test_a_second_source_and_a_mixed_one_are_reachable_from_the_top_of_the_library(
    bridge_db, bridge_library, bridge_php
) -> None:
    """A library opened on its first source only; a second disk of films had no way in at all (C-08)."""
    _library(bridge_db, bridge_library)
    bridge_library.scan("music2", "music", ["Second/01 - Track.mp3"])
    bridge_library.scan("shared", "mixed", ["Both/song.mp3", "Both/film.mkv", "Both/cover.jpg"])
    result = bridge_php.run(SETUP + r"""
    $top = static fn (string $kind): array => array_slice(array_column($browser->browse($me, $kind, null)['directories'], 'name'), 0, 3);
    $music = $browser->browse($me, 'music', null);
    $ids = array_column($music['directories'], 'id', 'name');
    $second = $browser->browse($me, 'music', $ids['Music2']);
    $both = static fn (string $kind): array => $titles($browser->browse($me, $kind, BOTH)['items']);
    out([
        'music_top' => $top('music'), 'movies_top' => $top('movies'),
        'second' => [array_column($second['directories'], 'name'), array_column($second['breadcrumbs'], 'name')],
        'second_queue' => $titles($browser->queue($me, 'music', SECOND, 0, 10)['items']),
        'both_as_music' => $both('music'), 'both_as_movies' => $both('movies'),
        'first_page_only' => array_column($browser->browse($me, 'music', null, '', 2, 3)['directories'], 'name'),
        'not_in_a_search' => in_array('Music2', array_column($browser->browse($me, 'music', null, 'abba')['directories'], 'name'), true),
        'wrong_library' => attempt(fn () => $browser->browse($me, 'movies', SECOND)),
    ]);
    """.replace("BOTH", str(bridge_db.directory_id("Both", "shared"))).replace("SECOND", str(bridge_db.directory_id("Second", "music2"))))
    assert result["music_top"] == ["Music2", "Shared", "100%"]
    assert result["movies_top"] == ["Shared", "Dune (2021)", "Firefly"]
    assert result["second"] == [["Second"], ["Music2"]]
    assert result["second_queue"] == ["Second/01 - Track.mp3"]
    # A mixed source shows each library its own kind of file (and the pictures beside them).
    assert sorted(result["both_as_music"]) == ["Both/cover.jpg", "Both/song.mp3"]
    assert sorted(result["both_as_movies"]) == ["Both/cover.jpg", "Both/film.mkv"]
    assert "Music2" not in result["first_page_only"] and result["not_in_a_search"] is False
    assert result["wrong_library"]["error"] == "CatalogItemNotFoundException"


def test_behind_the_credits_a_series_is_offered_in_order(bridge_db, bridge_library, bridge_php) -> None:
    """After S01E01 the panel read E05, E03, E04, E07 — the folder was shuffled like a folder of films (VID-13)."""
    bridge_library.scan("movies", "movies", [
        *(f"Show/Show S01E{number:02d}.mkv" for number in range(1, 8)),
        "Show/Show - making of.mkv",
        "Films/Alpha (2001).mkv", "Films/Beta (2002).mkv", "Films/Gamma (2003).mkv",
    ])
    bridge_db.user("listener")
    ids = {number: bridge_db.item_id(f"Show/Show S01E{number:02d}.mkv") for number in range(1, 8)}
    extra = bridge_db.item_id("Show/Show - making of.mkv")
    result = bridge_php.run(SETUP + r"""
    $after = static function (int $id, int $limit = 8) use ($browser, $me): array {
        $answer = $browser->upNext($me, $id, $limit);
        return ['next' => $answer['next']['item']['id'] ?? null,
                'suggestions' => array_map(static fn (array $entry): int => $entry['item']['id'], $answer['suggestions'])];
    };
    out(['first' => $after(FIRST), 'fourth' => $after(FOURTH), 'last' => $after(LAST), 'short' => $after(FIRST, 3),
         'extra' => $after(EXTRA), 'film' => $after(FILM)]);
    """.replace("FIRST", str(ids[1])).replace("FOURTH", str(ids[4])).replace("LAST", str(ids[7]))
        .replace("EXTRA", str(extra)).replace("FILM", str(bridge_db.item_id("Films/Alpha (2001).mkv"))))
    # The episode right after is the one the player may roll into; the rest follow in running order.
    assert result["first"] == {"next": ids[2], "suggestions": [ids[3], ids[4], ids[5], ids[6], ids[7], extra]}
    assert result["short"] == {"next": ids[2], "suggestions": [ids[3], ids[4], ids[5]]}
    # From the middle: what is ahead first, then what is behind, then whatever carries no number.
    assert result["fourth"] == {"next": ids[5], "suggestions": [ids[6], ids[7], ids[1], ids[2], ids[3], extra]}
    assert result["last"] == {"next": None, "suggestions": [ids[1], ids[2], ids[3], ids[4], ids[5], ids[6], extra]}
    # Asked about the file without a number: the whole season, from its start.
    assert result["extra"] == {"next": None, "suggestions": [ids[number] for number in range(1, 8)]}
    # A folder of films has no order to keep: the other two, either way round, and never rolled into.
    assert result["film"]["next"] is None
    assert sorted(result["film"]["suggestions"]) == sorted(
        bridge_db.item_id(path) for path in ("Films/Beta (2002).mkv", "Films/Gamma (2003).mkv")
    )


def test_a_listing_says_where_this_account_left_each_film(bridge_db, bridge_library, bridge_php) -> None:
    # The line on a film's card (LibraryBrowser::withSavedPositions): only films this account
    # left between 2 % and 95 % of their length; nothing for the others, and nothing for a guest.
    _library(bridge_db, bridge_library)
    other = bridge_db.user("someone-else")
    me = bridge_db.value("SELECT id FROM users WHERE username = 'listener'")
    ids = {name: bridge_db.item_id(f"Firefly/Firefly - {name}.mkv", "movies") for name in ("1x01 - Serenity", "1x02 - The Train Job", "1x03 - Bushwhacked")}
    for item_id in ids.values():
        bridge_db.execute("UPDATE media_items SET duration_ms = 2600000 WHERE id = %s", (item_id,))
    for name, position in (("1x01 - Serenity", 910000), ("1x02 - The Train Job", 26000), ("1x03 - Bushwhacked", 2550000)):
        bridge_db.insert("playback_stats", user_id=me, media_item_id=ids[name], last_position_ms=position, play_count=1)
    bridge_db.insert("playback_stats", user_id=other, media_item_id=ids["1x02 - The Train Job"], last_position_ms=1300000, play_count=1)
    firefly = bridge_db.directory_id("Firefly", "movies")
    result = bridge_php.run(SETUP + f"""
    $items = $browser->browse($me, 'movies', {firefly})['items'];
    out(array_map(static fn (array $item): array => [
        'path' => $item['relative_path'],
        'position_ms' => $item['position_ms'] ?? null,
        'progress' => $item['progress'] ?? null,
    ], $items));
    """)
    by_path = {row["path"].split(" - ", 1)[1]: row for row in result}
    assert by_path["1x01 - Serenity.mkv"] == {"path": "Firefly/Firefly - 1x01 - Serenity.mkv", "position_ms": 910000, "progress": 0.35}
    # Under 2 % (just opened) and over 95 % (finished) draw no line; another account's position is not mine.
    assert by_path["1x02 - The Train Job.mkv"]["progress"] is None
    assert by_path["1x03 - Bushwhacked.mkv"]["progress"] is None
