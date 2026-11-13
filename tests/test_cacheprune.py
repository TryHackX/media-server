"""`media-server cache-prune`: what is stale, what is never touched, and when nothing is deleted at all.

Against MySQL (tests/bridge_harness.py): the names a cache entry may have are
computed from the catalogue, so the catalogue is a real one, written by the real
scanner.
"""
from __future__ import annotations

import os
import time
from dataclasses import replace
from pathlib import Path

import pytest

from media_server import cacheprune, cli, maintenance, thumbnails
from media_server.cacheprune import PruneError, prune_caches
from media_server.config import AppConfig, StereoConfig, ThumbnailConfig
from media_server.paths import resolve_item
from media_server.security import GrantItem
from media_server.stereo import subtitle_cache_file
from media_server.subtitle_pictures import picture_cache_dir

FILES = ["Album/01 - One.mp3", "Album/02 - Two.mp3", "Film (2001)/Film (2001).mkv", "Series/Show S01E01.mkv"]
DAY = 86400.0
OLD = 30 * DAY


@pytest.fixture
def library(app_config: AppConfig, bridge_db, bridge_library, tmp_path: Path, monkeypatch) -> AppConfig:
    """A scanned mixed source and empty caches of every kind."""
    bridge_library.scan("media", "mixed", FILES)
    caches = tmp_path / "caches"
    (caches / "thumbnails").mkdir(parents=True)
    (caches / "subtitles" / "pictures").mkdir(parents=True)
    (caches / "project" / "runtime" / "filmweb-cache").mkdir(parents=True)
    monkeypatch.setattr(cacheprune, "PROJECT_ROOT", caches / "project")
    return replace(
        app_config,
        database=bridge_db.config,
        roots={"media": bridge_library.root_path("media")},
        thumbnails=ThumbnailConfig(cache_path=caches / "thumbnails", seek_seconds=120),
        stereo=StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=caches / "subtitles"),
    )


def _aged(path: Path, seconds: float, *, content: bytes = b"x", folder: bool = False) -> Path:
    """Create a file — or a folder holding a rendered track — last touched that long ago."""
    if folder:
        path.mkdir(parents=True, exist_ok=True)
        (path / "000001.png").write_bytes(content)
        (path / "manifest.json").write_bytes(b"{}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))
    return path


def _item(config: AppConfig, path: str):
    return resolve_item(GrantItem(root="media", path=path), config.roots)


def _fill(config: AppConfig) -> dict[str, Path]:
    """Entries a catalogued file still asks for, stale ones, fresh ones, and things that are not ours."""
    thumbs = config.thumbnails.cache_path
    subtitles = config.stereo.subtitle_cache_path
    track = _item(config, "Album/01 - One.mp3")
    film = _item(config, "Film (2001)/Film (2001).mkv")
    current, former, missing = thumbnails._cache_names(track, config.thumbnails)
    film_current, film_former, _ = thumbnails._cache_names(film, config.thumbnails)
    return {
        # thumbnails
        "thumb_current": _aged(thumbs / current, OLD),
        "thumb_former": _aged(thumbs / film_former, OLD),
        "thumb_no_picture": _aged(thumbs / missing, OLD),
        "thumb_stale": _aged(thumbs / ("thumb_" + "a" * 40 + ".jpg"), OLD),
        "thumb_stale_marker": _aged(thumbs / ("thumb_" + "b" * 40 + ".missing"), OLD),
        "thumb_by_name": _aged(thumbs / ("thumb_simple_" + "c" * 32 + "_120.jpg"), OLD),
        "thumb_fresh": _aged(thumbs / ("thumb_" + "d" * 40 + ".jpg"), DAY),
        "thumb_half_written": _aged(thumbs / (".thumb_" + "e" * 40 + ".jpg." + "f" * 32 + ".tmp.jpg"), 2 * DAY),
        "thumb_foreign": _aged(thumbs / "holiday.jpg", OLD),
        "thumb_film_current_absent": thumbs / film_current,
        # picture subtitles
        "pictures_live": _aged(picture_cache_dir(film, config.stereo, 3), OLD, folder=True),
        "pictures_live_native": _aged(picture_cache_dir(film, config.stereo, 0, native=True), OLD, folder=True),
        "pictures_stale": _aged(subtitles / "pictures" / ("1" * 64), OLD, folder=True),
        "pictures_fresh": _aged(subtitles / "pictures" / ("2" * 64), DAY, folder=True),
        "pictures_killed_render": _aged(subtitles / "pictures" / ("3" * 64 + ".partial"), 2 * DAY, folder=True),
        "pictures_foreign": _aged(subtitles / "pictures" / "notes", OLD, folder=True),
        # WebVTT
        "vtt_live": _aged(subtitle_cache_file(film, config.stereo, 2), 90 * DAY, content=b"WEBVTT\n"),
        "vtt_stale": _aged(subtitles / "ab" / ("ab" + "4" * 62 + ".vtt"), 90 * DAY, content=b"WEBVTT\n"),
        # Not the film's own track — a subtitle file beside a film, perhaps. Kept for a month.
        "vtt_sidecar_recent": _aged(subtitles / "cd" / ("cd" + "5" * 62 + ".vtt"), 10 * DAY, content=b"WEBVTT\n"),
        "vtt_half_written": _aged(subtitles / "ef" / ("ef" + "6" * 62 + ".1700000000.tmp"), 2 * DAY),
        "warm_state": _aged(subtitles / "warm-state.json", OLD, content=b"{}"),
        # Filmweb answers
        "filmweb_old": _aged(cacheprune.PROJECT_ROOT / "runtime" / "filmweb-cache" / "search-matrix-0123.json", 60 * DAY),
        "filmweb_recent": _aged(cacheprune.PROJECT_ROOT / "runtime" / "filmweb-cache" / "film-603-4567.json", 5 * DAY),
    }


STALE = {"thumb_stale", "thumb_stale_marker", "thumb_by_name", "thumb_half_written", "pictures_stale",
         "pictures_killed_render", "vtt_stale", "vtt_half_written", "filmweb_old"}


def test_a_report_names_what_is_stale_and_deletes_nothing(library: AppConfig) -> None:
    placed = _fill(library)
    report = prune_caches(config=library)
    assert report["mode"] == "dry-run" and report["status"] == "ok"
    assert report["catalogue_files"] == 4 and report["not_on_disk"] == 0
    caches = report["caches"]
    assert (caches["thumbnails"]["entries"], caches["thumbnails"]["stale"], caches["thumbnails"]["kept_as_recent"]) == (7, 4, 1)
    assert (caches["pictures"]["entries"], caches["pictures"]["stale"], caches["pictures"]["kept_as_recent"]) == (4, 2, 1)
    assert (caches["subtitles"]["entries"], caches["subtitles"]["stale"], caches["subtitles"]["kept_as_recent"]) == (3, 2, 1)
    assert (caches["filmweb"]["entries"], caches["filmweb"]["stale"]) == (2, 1)
    assert all(cache["removed"] == 0 for cache in caches.values())
    assert caches["pictures"]["stale_bytes"] == 6 and caches["thumbnails"]["stale_bytes"] == 4
    assert placed["thumb_stale"].name in caches["thumbnails"]["examples"]
    assert all(path.exists() for name, path in placed.items() if name != "thumb_film_current_absent")


def test_applied_it_removes_exactly_the_stale_entries(library: AppConfig) -> None:
    placed = _fill(library)
    report = prune_caches(config=library, apply=True)
    assert report["mode"] == "apply" and report["status"] == "ok"
    assert {name: cache["removed"] for name, cache in report["caches"].items()} == {
        "thumbnails": 4, "pictures": 2, "subtitles": 2, "filmweb": 1,
    }
    gone = {name for name, path in placed.items() if not path.exists()} - {"thumb_film_current_absent"}
    assert gone == STALE
    # What a catalogued file would ask for is still there — under its current name, its former name
    # and as a "there is no picture" marker — and so is everything that is not this server's.
    for kept in ("thumb_current", "thumb_former", "thumb_no_picture", "thumb_fresh", "thumb_foreign", "pictures_live",
                 "pictures_live_native", "pictures_fresh", "pictures_foreign", "vtt_live", "vtt_sidecar_recent",
                 "warm_state", "filmweb_recent"):
        assert placed[kept].exists(), kept
    assert (placed["pictures_live"] / "000001.png").is_file()
    # A second run has nothing left to do.
    again = prune_caches(config=library, apply=True)
    assert all(cache["stale"] == 0 for cache in again["caches"].values())


def test_one_cache_can_be_chosen_and_the_grace_period_set(library: AppConfig) -> None:
    placed = _fill(library)
    report = prune_caches(config=library, apply=True, only=("thumbnails",), grace_days=0.5)
    assert list(report["caches"]) == ["thumbnails"]
    # Half a day of grace: the day-old unknown picture goes too.
    assert not placed["thumb_fresh"].exists() and not placed["thumb_stale"].exists()
    assert placed["pictures_stale"].exists() and placed["vtt_stale"].exists() and placed["filmweb_old"].exists()
    with pytest.raises(PruneError):
        prune_caches(config=library, only=("thumbnails", "everything"))
    with pytest.raises(PruneError):
        prune_caches(config=library, grace_days=-1)


def test_a_file_replaced_since_its_picture_was_made_no_longer_keeps_it(library: AppConfig, bridge_library) -> None:
    track = bridge_library.root_path("media") / "Album" / "01 - One.mp3"
    before = _item(library, "Album/01 - One.mp3")
    current, _, _ = thumbnails._cache_names(before, library.thumbnails)
    picture = _aged(library.thumbnails.cache_path / current, OLD)
    track.write_bytes(b"another recording altogether")
    report = prune_caches(config=library, apply=True, only=("thumbnails",))
    assert report["caches"]["thumbnails"]["removed"] == 1 and not picture.exists()


def test_nothing_is_pruned_while_a_source_is_away(library: AppConfig, bridge_library, tmp_path: Path) -> None:
    """An unplugged drive looks exactly like a library somebody emptied."""
    placed = _fill(library)
    unplugged = replace(library, roots={"media": tmp_path / "not-mounted"})
    report = prune_caches(config=unplugged, apply=True)
    assert report["status"] == "skipped" and "media" in report["reason"] and "caches" not in report
    forgotten = replace(library, roots={})
    assert prune_caches(config=forgotten, apply=True)["status"] == "skipped"
    assert all(path.exists() for name, path in placed.items() if name != "thumb_film_current_absent")

    # Mounted, but most of what the catalogue lists is not there: the same caution.
    root = bridge_library.root_path("media")
    for relative in FILES[:3]:
        (root / relative).unlink()
    report = prune_caches(config=library, apply=True)
    assert report["status"] == "skipped" and report["not_on_disk"] == 3
    assert placed["thumb_stale"].exists()


def test_a_cache_that_would_lose_most_of_itself_is_left_alone_until_confirmed(library: AppConfig) -> None:
    thumbs = library.thumbnails.cache_path
    stale = [_aged(thumbs / f"thumb_{index:040x}.jpg", OLD) for index in range(150)]
    kept = _aged(thumbs / thumbnails._cache_names(_item(library, "Album/02 - Two.mp3"), library.thumbnails)[0], OLD)

    report = prune_caches(config=library, apply=True, only=("thumbnails",))
    assert report["status"] == "partial"
    assert report["caches"]["thumbnails"]["removed"] == 0 and "allow-mass-delete" in report["caches"]["thumbnails"]["refused"]
    assert all(path.exists() for path in stale)

    confirmed = prune_caches(config=library, apply=True, only=("thumbnails",), allow_mass_delete=True)
    assert confirmed["status"] == "ok" and confirmed["caches"]["thumbnails"]["removed"] == 150
    assert kept.exists() and not any(path.exists() for path in stale)


def test_the_command_and_the_optional_maintenance_step(library: AppConfig, monkeypatch, capsys) -> None:
    placed = _fill(library)
    monkeypatch.setattr(cli, "_load", lambda _path: library)

    assert cli.main(["cache-prune"]) == 0
    assert '"mode": "dry-run"' in capsys.readouterr().out and placed["thumb_stale"].exists()
    assert cli.main(["cache-prune", "--only", "nonsense"]) == 1
    assert "Nieznane pamięci podręczne" in capsys.readouterr().err
    assert cli.main(["cache-prune", "--apply", "--only", "filmweb"]) == 0
    capsys.readouterr()
    assert not placed["filmweb_old"].exists() and placed["thumb_stale"].exists()

    # Maintenance prunes only when the step is named; a default run never deletes.
    assert "prune" not in maintenance.STEPS and maintenance.OPTIONAL_STEPS == ("prune",)
    report = maintenance.run_maintenance(config=library, steps=("prune",))
    assert [(step["step"], step["status"]) for step in report["steps"]] == [("prune", "ok")]
    assert not placed["thumb_stale"].exists() and placed["thumb_current"].exists()
    assert cli.main(["maintenance", "--only", "prune"]) == 0
    assert cli.main(["maintenance", "--only", "prune,polish"]) == 1


def test_a_database_that_is_down_is_one_line_not_a_traceback(app_config: AppConfig, monkeypatch, capsys) -> None:
    """`check --database` and `migrate` with MySQL stopped ended in a traceback (T-11)."""
    import pymysql

    def refused(*_args: object, **_kwargs: object) -> None:
        raise pymysql.err.OperationalError(2003, "Can't connect to MySQL server on '127.0.0.1'")

    monkeypatch.setattr(cli, "_load", lambda _path: app_config)
    monkeypatch.setattr(cli, "check_database", refused)
    monkeypatch.setattr(cli, "apply_migrations", refused)
    monkeypatch.setattr(cacheprune, "connect_rows", refused)
    for command in (["check", "--database"], ["migrate"], ["cache-prune"]):
        assert cli.main(command) == 1, command
        captured = capsys.readouterr()
        assert captured.err.startswith("Błąd bazy danych:") and "2003" in captured.err
        assert "Traceback" not in captured.err
