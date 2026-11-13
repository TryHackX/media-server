"""Guest links, playlist imports and the weekly digest against MySQL.

A guest link acts as its author; an import writes only what a person agreed to; a
digest tells an account only about what it may open. Each rule is checked from
both sides: what goes through, and what is refused.
"""
from __future__ import annotations

import json
import os
import subprocess

from bridge_harness import PHP_INTEGRATION, php_binary

MUSIC = [
    "Abba/Arrival/01 - Dancing Queen.mp3",
    "Abba/Arrival/02 - Money.mp3",
    "Queen/01 - Bohemian.mp3",
    "Other/01 - Bohemian.mp3",
    "Loose.mp3",
]
MOVIES = ["Dune (2021)/Dune (2021).mkv", "Alien (1979).mkv"]


def _catalogue(bridge_db, bridge_library) -> None:
    bridge_library.scan("music", "music", MUSIC)
    bridge_library.scan("movies", "movies", MOVIES)
    bridge_db.user("author")
    bridge_db.user("other")
    bridge_db.setting("guest_links_enabled", "1")


# -- guest links ------------------------------------------------------------------------------------


def test_a_guest_link_opens_its_folder_and_nothing_else(bridge_db, bridge_library, bridge_php) -> None:
    _catalogue(bridge_db, bridge_library)
    folder = bridge_db.directory_id("Abba", "music")
    inside = bridge_db.item_id("Abba/Arrival/02 - Money.mp3")
    outside = bridge_db.item_id("Loose.mp3")
    result = bridge_php.run(r"""
    $links = new GuestLinks($db);
    $gateway = new CatalogTransferGateway($db, $transferKey);
    $author = identity($db, 'author');
    $link = $links->issue($author, ['target_kind' => 'directory', 'target_id' => FOLDER, 'days' => 3, 'max_downloads' => 1], 'http://media.test');
    $token = $link['token'];
    $opened = $links->open($token);
    out([
        'url_names_the_token' => str_ends_with($link['url'], '/guest/?token=' . $token),
        'stored_plain' => (int) $db->query("SELECT COUNT(*) FROM guest_links WHERE HEX(token_hash) LIKE '%" . bin2hex($token) . "%'")->fetchColumn(),
        'titles' => array_column($opened['items'], 'title'),
        'keys' => array_keys($opened['items'][0]),
        'total' => $opened['total'],
        'play_inside' => attempt(fn () => $links->transfer($token, INSIDE, true, $gateway)['media_kind']),
        'play_outside' => attempt(fn () => $links->transfer($token, OUTSIDE, true, $gateway)),
        'download_once' => attempt(fn () => $links->transfer($token, INSIDE, false, $gateway)['name']),
        'download_twice' => attempt(fn () => $links->transfer($token, INSIDE, false, $gateway)),
        'wrong_token' => attempt(fn () => $links->open(str_repeat('x', 32))),
        'mine' => array_map(static fn (array $row): array => [$row['label'], $row['downloads_used'], $row['max_downloads']], $links->mine($author)['links']),
        'others_see' => $links->mine(identity($db, 'other'))['total'],
    ]);
    """.replace("FOLDER", str(folder)).replace("INSIDE", str(inside)).replace("OUTSIDE", str(outside)))
    assert result["url_names_the_token"] is True
    assert result["stored_plain"] == 0
    assert sorted(result["titles"]) == ["01 - Dancing Queen", "02 - Money"] and result["total"] == 2
    # Titles and lengths, never a path or an owner.
    assert sorted(result["keys"]) == ["artist", "duration_ms", "id", "media_kind", "title"]
    assert result["play_inside"] == {"ok": True, "value": "audio"}
    assert result["play_outside"]["error"] == "CatalogItemNotFoundException"
    assert result["download_once"] == {"ok": True, "value": "02 - Money.mp3"}
    assert result["download_twice"]["error"] == "BridgeAuthorizationException"
    assert result["wrong_token"]["error"] == "CatalogItemNotFoundException"
    assert result["mine"] == [["Abba", 1, 1]]
    assert result["others_see"] == 0


def test_a_link_dies_with_whatever_made_it_legal(bridge_db, bridge_library, bridge_php) -> None:
    """Rights are read on every visit: the switch, the expiry, the author's rights, the list's sharing."""
    _catalogue(bridge_db, bridge_library)
    folder = bridge_db.directory_id("Abba", "music")
    script = r"""
    $links = new GuestLinks($db);
    $author = identity($db, 'author');
    $step = getenv('STEP');
    if ($step === 'make') {
        $actions = new CatalogActions($db);
        $list = $actions->createCollection($author, ['name' => 'Shared', 'media_kind' => 'music'])['id'];
        $actions->setCollectionItem($author, ['collection_id' => $list, 'media_item_id' => ITEM]);
        out(['folder' => $links->issue($author, ['target_kind' => 'directory', 'target_id' => FOLDER], 'http://media.test')['token'],
             'list' => $links->issue($author, ['target_kind' => 'collection', 'target_id' => $list], 'http://media.test')['token'],
             'list_id' => $list]);
    } else {
        $tokens = json_decode((string) getenv('TOKENS'), true);
        out(['folder' => attempt(fn () => $links->open($tokens['folder'])['total']),
             'list' => attempt(fn () => $links->open($tokens['list'])['total'])]);
    }
    """.replace("FOLDER", str(folder)).replace("ITEM", str(bridge_db.item_id("Loose.mp3")))

    def run(step: str, tokens: dict | None = None) -> dict:
        bridge_php.environment["STEP"] = step
        bridge_php.environment["TOKENS"] = json.dumps(tokens or {})
        return bridge_php.run(script)

    tokens = run("make")
    gone = {"ok": False, "error": "CatalogItemNotFoundException", "message": "Ten link wygasł albo nie istnieje."}
    assert run("open", tokens) == {"folder": {"ok": True, "value": 2}, "list": {"ok": True, "value": 1}}

    bridge_db.setting("guest_links_enabled", "0")
    switched_off = run("open", tokens)
    assert switched_off["folder"]["error"] == "BridgeAuthorizationException"
    bridge_db.setting("guest_links_enabled", "1")

    user_group = bridge_db.group_id("user")
    bridge_db.execute("UPDATE permission_groups SET can_access_music = 0 WHERE id = %s", (user_group,))
    assert run("open", tokens) == {"folder": gone, "list": gone}
    bridge_db.execute("UPDATE permission_groups SET can_access_music = 1, can_share = 0 WHERE id = %s", (user_group,))
    assert run("open", tokens) == {"folder": gone, "list": gone}
    bridge_db.execute("UPDATE permission_groups SET can_share = 1 WHERE id = %s", (user_group,))
    assert run("open", tokens)["folder"] == {"ok": True, "value": 2}

    bridge_db.execute("UPDATE guest_links SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE target_kind = 'directory'")
    bridge_db.execute("DELETE FROM user_collection_items")
    after = run("open", tokens)
    assert after["folder"] == gone
    assert after["list"] == {"ok": True, "value": 0}
    bridge_db.execute("UPDATE users SET is_active = 0 WHERE username = 'author'")
    assert run("open", tokens)["list"] == gone


def test_who_may_make_a_link_and_to_what(bridge_db, bridge_library, bridge_php) -> None:
    _catalogue(bridge_db, bridge_library)
    bridge_db.user("noshare", group=bridge_db.group("noshare", can_access_music=1, can_browse_collections=1))
    bridge_db.user("nobrowse", group=bridge_db.group("nobrowse", can_access_music=1, can_share=1, can_create_collections=1))
    bridge_db.user("musiconly", group=bridge_db.group("musiconly", can_access_music=1, can_share=1))
    bridge_db.user("visitor", guest=True)
    result = bridge_php.run(r"""
    $links = new GuestLinks($db);
    $actions = new CatalogActions($db);
    $author = identity($db, 'author');
    $shared = $actions->createCollection($author, ['name' => 'Shared', 'media_kind' => 'music'])['id'];
    $actions->setCollectionShared($author, ['collection_id' => $shared, 'shared' => true]);
    $private = $actions->createCollection($author, ['name' => 'Private', 'media_kind' => 'music'])['id'];
    $own = $actions->createCollection(identity($db, 'nobrowse'), ['name' => 'Own', 'media_kind' => 'music'])['id'];
    $make = fn (string $who, string $kind, int $id, array $more = []) => attempt(fn () =>
        $links->issue(identity($db, $who), ['target_kind' => $kind, 'target_id' => $id] + $more, 'http://media.test')['label']);
    out([
        'guest_account' => $make('visitor', 'directory', MUSIC_FOLDER),
        'other_private_list' => $make('other', 'collection', $private),
        'other_shared_list' => $make('other', 'collection', $shared),
        'nobrowse_shared_list' => $make('nobrowse', 'collection', $shared),
        'nobrowse_own_list' => $make('nobrowse', 'collection', $own),
        'musiconly_film_folder' => $make('musiconly', 'directory', FILM_FOLDER),
        'musiconly_music_folder' => $make('musiconly', 'directory', MUSIC_FOLDER),
        'too_long' => $make('author', 'directory', MUSIC_FOLDER, ['days' => 91]),
        'bad_kind' => $make('author', 'file', MUSIC_FOLDER),
        'missing' => $make('author', 'directory', 999999),
        'cannot_share' => attempt(fn () => $actions->assertCanShare(identity($db, 'noshare'))),
        'links' => (int) $db->query('SELECT COUNT(*) FROM guest_links')->fetchColumn(),
    ]);
    """.replace("MUSIC_FOLDER", str(bridge_db.directory_id("Abba", "music")))
       .replace("FILM_FOLDER", str(bridge_db.directory_id("Dune (2021)", "movies"))))
    assert result["guest_account"]["error"] == "BridgeAuthorizationException"
    assert result["other_private_list"]["error"] == "CatalogItemNotFoundException"
    assert result["other_shared_list"] == {"ok": True, "value": "Shared"}
    # Without the right to browse other people's lists the link would be dead on its first visit (C-10).
    assert result["nobrowse_shared_list"]["error"] == "BridgeAuthorizationException"
    assert result["nobrowse_own_list"] == {"ok": True, "value": "Own"}
    assert result["musiconly_film_folder"]["error"] == "BridgeAuthorizationException"
    assert result["musiconly_music_folder"] == {"ok": True, "value": "Abba"}
    for key in ("too_long", "bad_kind"):
        assert result[key]["error"] == "BridgeRequestException", key
    assert result["missing"]["error"] == "CatalogItemNotFoundException"
    assert result["cannot_share"]["error"] == "BridgeAuthorizationException"
    assert result["links"] == 3


def test_the_guest_page_needs_no_session_and_is_given_none(bridge_http, bridge_db, bridge_library, bridge_php) -> None:
    _catalogue(bridge_db, bridge_library)
    token = bridge_php.run(r"""
    out((new GuestLinks($db))->issue(identity($db, 'author'), ['target_kind' => 'directory', 'target_id' => FOLDER, 'max_downloads' => 5], 'http://media.test')['token']);
    """.replace("FOLDER", str(bridge_db.directory_id("Abba", "music"))))
    visitor = bridge_http.client()
    opened = visitor.get("guest", token=token)
    assert opened.status == 200 and opened.json["guest"]["label"] == "Abba"
    assert visitor.cookie("TRYHACKXTESTSESSID") is None
    item = opened.json["guest"]["items"][0]["id"]
    grant = visitor.request("POST", "guest_file", {"token": token, "media_item_id": item, "inline": True},
                            {"X-CSRF-Token": ""})
    assert grant.status == 200 and grant.json["transfer"]["url"].startswith("/media-transfer/v1/files/")
    assert visitor.cookie("TRYHACKXTESTSESSID") is None
    assert visitor.get("guest", token="x" * 32).status == 404
    assert visitor.request("POST", "guest_file", {"token": token, "media_item_id": bridge_db.item_id("Loose.mp3")}).status == 404


# -- playlist imports ----------------------------------------------------------------------------------


IMPORT = r"""
$actions = new CatalogActions($db);
$importer = new PlaylistImporter($db, $actions);
$me = identity($db, 'author');
"""


def test_an_uploaded_playlist_waits_for_a_person_and_then_becomes_a_list(bridge_db, bridge_library, bridge_php) -> None:
    _catalogue(bridge_db, bridge_library)
    playlist = "\n".join([
        "#EXTM3U",
        "#EXTINF:210,Abba - Dancing Queen",
        "C:\\Music\\Abba\\Arrival\\01 - Dancing Queen.mp3",
        "#EXTINF:200,Queen - Bohemian",
        "/home/me/music/01 - Bohemian.mp3",
        "nowhere/Missing Track.mp3",
        f"tryhackx:item:{bridge_db.item_id('Loose.mp3')}",
        f"tryhackx:item:{bridge_db.item_id('Alien (1979).mkv')}",
    ])
    result = bridge_php.run(IMPORT + r"""
    $started = $importer->start($me, PLAYLIST, 'Wieczór.m3u', 'music');
    $id = $started['import_id'];
    $ambiguous = array_values(array_filter($started['entries'], static fn (array $e): bool => $e['state'] === 'ambiguous'))[0];
    $stranger = attempt(fn () => $importer->status(identity($db, 'other'), $id));
    $outside = attempt(fn () => $importer->resolve($me, ['entry_id' => $ambiguous['id'], 'media_item_id' => OUTSIDE]));
    $chosen = $importer->resolve($me, ['entry_id' => $ambiguous['id'], 'media_item_id' => $ambiguous['candidates'][1]['id']]);
    $applied = $importer->apply($me, $id, []);
    $again = $importer->apply($me, $id, []);
    $page = $actions->collectionPage($me, $applied['collection_id']);
    out(['counts' => $started['counts'], 'name' => $started['collection_name'], 'candidates' => count($ambiguous['candidates']),
         'candidate_keys' => array_keys($ambiguous['candidates'][0]), 'stranger' => $stranger, 'outside' => $outside,
         'chosen' => $chosen['state'], 'applied' => [$applied['kind'], $applied['written']],
         'again' => [$again['already_applied'] ?? false, $again['collection_id'] === $applied['collection_id']],
         'list' => [$page['collection']['name'], array_column($page['items'], 'relative_path')],
         'lists' => (int) $db->query('SELECT COUNT(*) FROM user_collections')->fetchColumn(),
         'pending' => $importer->pending($me)]);
    """.replace("PLAYLIST", json.dumps(playlist)).replace("OUTSIDE", str(bridge_db.item_id("Abba/Arrival/02 - Money.mp3"))))
    # One by file name, one named twice in the library, one nowhere, one by our own id; the film id is not music.
    assert result["counts"] == {"matched": 2, "ambiguous": 1, "missing": 2, "skipped": 0}
    assert result["name"] == "Wieczór" and result["candidates"] == 2
    assert sorted(result["candidate_keys"]) == ["artist", "folder", "id", "title"]
    assert result["stranger"]["error"] == "CatalogItemNotFoundException"
    assert result["outside"]["error"] == "BridgeRequestException"
    assert result["chosen"] == "matched" and result["applied"] == ["playlist", 3]
    assert result["again"] == [True, True] and result["lists"] == 1
    assert result["list"][0] == "Wieczór"
    assert result["list"][1][0] == "Abba/Arrival/01 - Dancing Queen.mp3" and result["list"][1][2] == "Loose.mp3"
    assert result["pending"] == []


def test_importing_ratings_adds_to_what_is_there_and_takes_nothing_away(bridge_db, bridge_library, bridge_php) -> None:
    """A file of ratings cleared favourites, a file of favourites nulled ratings (C-03)."""
    _catalogue(bridge_db, bridge_library)
    author = bridge_db.value("SELECT id FROM users WHERE username = 'author'")
    queen, money, loose = (bridge_db.item_id(path) for path in
                           ("Queen/01 - Bohemian.mp3", "Abba/Arrival/02 - Money.mp3", "Loose.mp3"))
    bridge_db.user("norate", group=bridge_db.group("norate", can_access_music=1, can_favorite=1))
    bridge_db.insert("user_ratings", user_id=author, media_item_id=queen, rating=None, favorite=1)
    bridge_db.insert("user_ratings", user_id=author, media_item_id=money, rating=4.5, favorite=0)
    ratings = "\n".join([
        "media_item_id,fingerprint,media_kind,title,artist,rating,favorite",
        f"{queen},,audio,Bohemian,Queen,3.5,0",
        f"{money},,audio,Money,Abba,,1",
        f"{loose},,audio,Loose,,5,1",
    ])
    result = bridge_php.run(IMPORT + r"""
    $started = $importer->start($me, RATINGS, 'oceny.csv', 'music');
    $applied = $importer->apply($me, $started['import_id'], []);
    $norate = attempt(fn () => $importer->start(identity($db, 'norate'), RATINGS, 'oceny.csv', 'music'));
    out(['kind' => $started['kind'], 'applied' => $applied['written'], 'norate' => $norate,
         'rows' => $db->query('SELECT media_item_id, rating, favorite FROM user_ratings WHERE user_id = ' . $me->userId . ' ORDER BY media_item_id')->fetchAll(PDO::FETCH_NUM),
         'other_rows' => (int) $db->query('SELECT COUNT(*) FROM user_ratings WHERE user_id <> ' . $me->userId)->fetchColumn()]);
    """.replace("RATINGS", json.dumps(ratings)))
    assert result["kind"] == "ratings" and result["applied"] == 3
    assert result["norate"]["error"] == "BridgeAuthorizationException"
    rows = {int(row[0]): (None if row[1] is None else float(row[1]), int(row[2])) for row in result["rows"]}
    assert rows == {queen: (3.5, 1), money: (4.5, 1), loose: (5.0, 1)}
    assert result["other_rows"] == 0


def test_finished_imports_are_forgotten_and_open_ones_are_capped(bridge_db, bridge_library, bridge_php) -> None:
    """Nothing ever deleted an import: up to 5000 rows per upload, for good (C-05)."""
    _catalogue(bridge_db, bridge_library)
    author = bridge_db.value("SELECT id FROM users WHERE username = 'author'")
    for status, age in (("applied", 31), ("discarded", 31), ("applied", 5), ("review", 91), ("review", 60)):
        import_id = bridge_db.insert("playlist_imports", user_id=author, kind="playlist", source_name=f"{status}-{age}",
                                     media_kind="music", status=status)
        bridge_db.insert("playlist_import_entries", import_id=import_id, raw_label="x", state="missing")
        bridge_db.execute("UPDATE playlist_imports SET updated_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s DAY) WHERE id = %s",
                          (age, import_id))
    result = bridge_php.run(IMPORT + r"""
    $upload = fn () => attempt(fn () => $importer->start($me, "Loose.mp3\n", 'x.m3u', 'music')['import_id']);
    $first = $upload();
    $left = $db->query('SELECT source_name FROM playlist_imports ORDER BY source_name')->fetchAll(PDO::FETCH_COLUMN);
    $entries = (int) $db->query('SELECT COUNT(*) FROM playlist_import_entries')->fetchColumn();
    $more = [];
    for ($i = 0; $i < 9; $i++) { $more[] = $upload()['ok']; }
    out(['first' => $first['ok'], 'left' => $left, 'entries' => $entries, 'more' => $more,
         'discard' => $importer->discard($me, $first['value'])['success'], 'after_discard' => $upload()['ok']]);
    """)
    assert result["first"] is True
    assert result["left"] == ["applied-5", "review-60", "x.m3u"]
    assert result["entries"] == 3
    # Ten may wait at once: the one from sixty days ago, the first upload, eight more — the ninth is refused.
    assert result["more"] == [True] * 8 + [False]
    assert result["discard"] is True and result["after_discard"] is True


# -- the weekly digest ------------------------------------------------------------------------------------


DIGEST = r"""
$digest = new LibraryDigest($db, $mailer, 'http://media.test/');
"""


def test_the_digest_reports_what_entered_the_catalogue_not_what_a_scan_touched(bridge_db, bridge_library, bridge_php) -> None:
    """Every scan rewrites indexed_at for every file; "new" was the whole library, every week (C-01)."""
    _catalogue(bridge_db, bridge_library)
    bridge_db.user("musiconly", group=bridge_db.group("musiconly", can_access_music=1))
    bridge_db.execute("UPDATE media_items SET created_at = '2026-01-01 00:00:00'")
    for path in ("Loose.mp3", "Alien (1979).mkv"):
        bridge_db.execute("UPDATE media_items SET created_at = CURRENT_TIMESTAMP(6) WHERE id = %s", (bridge_db.item_id(path),))
    # A scan that finds nothing new still stamps everything it saw.
    bridge_library.scan("music", "music", MUSIC)
    assert bridge_db.value("SELECT COUNT(*) FROM media_items WHERE indexed_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 HOUR)") >= 5
    for name in ("author", "musiconly", "other"):
        user = bridge_db.value("SELECT id FROM users WHERE username = %s", (name,))
        if name != "other":
            bridge_db.insert("user_digests", user_id=user, frequency="weekly")
    result = bridge_php.run(DIGEST + r"""
    $week = date('Y-m-d H:i:s', time() - 7 * 86400);
    $since = $db->query('SELECT DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 7 DAY)')->fetchColumn();
    $news = fn (string $who) => $digest->news(identity($db, $who)->userId, $since);
    $run = $digest->run();
    $second = $digest->run();
    $forced = $digest->run(true);
    out(['author' => $news('author'), 'musiconly' => $news('musiconly'), 'run' => $run, 'second' => $second, 'forced' => $forced]);
    """)
    author = {row["kind"]: (row["count"], row["titles"]) for row in result["author"]["libraries"]}
    assert author == {"music": (1, ["Loose"]), "movies": (1, ["Alien (1979)"])}
    assert result["author"]["total"] == 2
    # An account without the film library is not told about films.
    assert [row["kind"] for row in result["musiconly"]["libraries"]] == ["music"]
    assert result["run"]["sent"] == 2 and sorted(result["run"]["recipients"]) == ["author", "musiconly"]
    assert result["run"]["failed"] == 0 and result["run"]["deferred"] == 0
    assert result["second"]["sent"] == 0 and result["second"]["skipped"] == 2
    # "Send now" ignores the week — but not somebody who got the message a moment ago.
    assert result["forced"]["sent"] == 0
    mail = bridge_php.mail()
    assert len(mail) == 2
    film_mail = [message for message in mail if "Alien" in message]
    assert len(film_mail) == 1 and "To: <author@example.test>" in film_mail[0]
    assert all("Abba" not in message for message in mail), "what a scan merely saw again is not news"


def test_a_digest_run_inside_a_request_stops_at_its_budget(bridge_db, bridge_library, bridge_php) -> None:
    _catalogue(bridge_db, bridge_library)
    for name in ("author", "other"):
        bridge_db.insert("user_digests", user_id=bridge_db.value("SELECT id FROM users WHERE username = %s", (name,)),
                         frequency="weekly", covered_until="2026-01-01 00:00:00")
    result = bridge_php.run(DIGEST + r"""
    $first = $digest->run(true, null, -1.0);
    $second = $digest->run(true, null, 30.0);
    out(['first' => [$first['sent'], $first['deferred']], 'second' => [$second['sent'], $second['deferred']]]);
    """)
    assert result["first"] == [0, 2]
    assert result["second"] == [2, 0]


def test_the_digest_command_says_when_mail_could_not_be_sent(bridge_db, bridge_library, bridge_http, tmp_path) -> None:
    """It printed three numbers, left the failures out and exited 0 even when every send had failed (C-06)."""
    _catalogue(bridge_db, bridge_library)
    bridge_db.insert("user_digests", user_id=bridge_db.value("SELECT id FROM users WHERE username = 'author'"),
                     frequency="weekly", covered_until="2026-01-01 00:00:00")
    # Its error_log() goes to a file of the test's own, not to wherever php.ini points
    # (on WAMP that is the installation's PHP log, and with nothing set it is stderr).
    command = [php_binary(), "-d", "display_errors=stderr", "-d", "log_errors=1",
               "-d", f"error_log={tmp_path / 'php-error.log'}", str(PHP_INTEGRATION / "stage" / "digest.php")]
    good = dict(os.environ, TRYHACKX_BRIDGE_CONFIG=str(bridge_http.work / "bridge-config.php"))
    blocked = tmp_path / "spool-is-a-file"
    blocked.write_text("x", encoding="utf-8")
    # The same configuration, with a spool that cannot be written to.
    broken_config = tmp_path / "broken.php"
    broken_config.write_text(
        "<?php\n$config = require " + json.dumps(str(bridge_http.work / "bridge-config.php")) + ";\n"
        "$config['mail']['spool_path'] = " + json.dumps(str(blocked)) + ";\nreturn $config;\n",
        encoding="utf-8",
    )
    failed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=60,
                            env=dict(os.environ, TRYHACKX_BRIDGE_CONFIG=str(broken_config)))
    assert failed.returncode == 1
    assert "nie udało się: 1" in failed.stdout and "author" in failed.stderr
    sent = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=60, env=good)
    assert sent.returncode == 0 and "Wysłano: 1, nie udało się: 0" in sent.stdout
