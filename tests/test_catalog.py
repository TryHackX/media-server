from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

import pytest

from media_server.catalog import (
    CatalogError,
    DiscoveredFile,
    ExistingItem,
    _ensure_safe_missing,
    classify_item,
    discover_catalog,
)
from media_server.probe import PROBE_SCHEMA


def discover_media(root_slug: str, root_path: Path, root_kind: str) -> list[DiscoveredFile]:
    """List only playable media files, the way production consumers filter them."""
    return [
        entry
        for entry in discover_catalog(root_slug, root_path, root_kind)
        if isinstance(entry, DiscoveredFile) and entry.media_kind in {"audio", "video"}
    ]


def _candidate(*, size: int = 10, mtime_ns: int = 20) -> DiscoveredFile:
    return DiscoveredFile(
        path=Path("song.flac"),
        relative_path="Artist/song.flac",
        path_hash=b"x" * 32,
        media_kind="audio",
        mime_type="audio/flac",
        fallback_title="song",
        size_bytes=size,
        mtime_ns=mtime_ns,
    )


def _film(*, size: int = 10, mtime_ns: int = 20) -> DiscoveredFile:
    return DiscoveredFile(
        path=Path("film.mkv"),
        relative_path="Films/film.mkv",
        path_hash=b"y" * 32,
        media_kind="video",
        mime_type="video/x-matroska",
        fallback_title="film",
        size_bytes=size,
        mtime_ns=mtime_ns,
    )


def test_music_discovery_is_filtered_and_uses_stable_relative_hash(tmp_path: Path) -> None:
    album = tmp_path / "Artist" / "Album"
    album.mkdir(parents=True)
    (album / "track.FLAC").write_bytes(b"audio")
    (album / "video.mkv").write_bytes(b"video")
    (album / "cover.jpg").write_bytes(b"image")

    result = list(discover_media("music", tmp_path, "music"))

    assert [item.relative_path for item in result] == ["Artist/Album/track.FLAC"]
    expected = hashlib.sha256("music\0Artist/Album/track.FLAC".encode()).digest()
    assert result[0].path_hash == expected
    assert result[0].media_kind == "audio"


def test_mixed_discovery_includes_audio_and_video(tmp_path: Path) -> None:
    (tmp_path / "song.mp3").write_bytes(b"audio")
    (tmp_path / "movie.MP4").write_bytes(b"video")

    result = sorted(discover_media("library", tmp_path, "mixed"), key=lambda item: item.relative_path)

    assert [(item.relative_path, item.media_kind) for item in result] == [
        ("movie.MP4", "video"),
        ("song.mp3", "audio"),
    ]


@pytest.mark.parametrize(
    ("root_kind", "filename", "media_kind"),
    [
        ("music", "sample.aif", "audio"),
        ("music", "sample.aiff", "audio"),
        ("movies", "sample.m2ts", "video"),
        ("movies", "sample.mts", "video"),
        ("movies", "sample.vob", "video"),
    ],
)
def test_additional_standard_containers_are_discovered(
    tmp_path: Path,
    root_kind: str,
    filename: str,
    media_kind: str,
) -> None:
    (tmp_path / filename).write_bytes(b"media")

    result = list(discover_media("library", tmp_path, root_kind))

    assert [(item.relative_path, item.media_kind) for item in result] == [(filename, media_kind)]


def test_discovery_never_follows_symlink(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.flac").write_bytes(b"secret")
    link = root / "escape"
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("Symlink creation is unavailable")

    assert list(discover_media("music", root, "music")) == []


@pytest.mark.skipif(os.name != "nt", reason="Windows junction test")
def test_discovery_never_follows_windows_junction(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.flac").write_bytes(b"secret")
    junction = root / "escape"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip("Windows junction creation is unavailable")

    assert list(discover_media("music", root, "music")) == []


@pytest.mark.parametrize(
    ("existing", "metadata_enabled", "expected"),
    [
        (None, False, "new"),
        (ExistingItem(1, 10, 20, "ready", False), False, "unchanged"),
        (ExistingItem(1, 11, 20, "ready", False), False, "updated"),
        (ExistingItem(1, 10, 20, "missing", True), False, "updated"),
        (ExistingItem(1, 10, 20, "pending", False), False, "updated"),
        (ExistingItem(1, 10, 20, "error", False), False, "unchanged"),
        (ExistingItem(1, 10, 20, "error", False), True, "updated"),
        (ExistingItem(1, 10, 20, "ready", False, metadata_schema=0), True, "updated"),
        (ExistingItem(1, 10, 20, "ready", False, metadata_schema=2), True, "unchanged"),
    ],
)
def test_classification(
    existing: ExistingItem | None,
    metadata_enabled: bool,
    expected: str,
) -> None:
    assert classify_item(existing, _candidate(), metadata_enabled=metadata_enabled) == expected


@pytest.mark.parametrize(
    ("probe_schema", "expected"),
    [(0, "updated"), (PROBE_SCHEMA, "unchanged")],
)
def test_untouched_film_is_reprobed_only_until_it_matches_the_current_schema(
    probe_schema: int,
    expected: str,
) -> None:
    """Size and mtime say the file is the same; the schema says what we know about it is not."""
    existing = ExistingItem(1, 10, 20, "ready", False, probe_schema=probe_schema)

    assert classify_item(existing, _film(), metadata_enabled=True) == expected


def test_film_is_left_alone_when_the_scan_does_not_ask_for_metadata() -> None:
    existing = ExistingItem(1, 10, 20, "ready", False, probe_schema=0)

    assert classify_item(existing, _film(), metadata_enabled=False) == "unchanged"


@pytest.mark.parametrize(("active", "missing"), [(1, 1), (1000, 501)])
def test_missing_guard_rejects_empty_or_majority_loss(active: int, missing: int) -> None:
    with pytest.raises(CatalogError, match="allow-mass-missing"):
        _ensure_safe_missing(active, missing, allow_mass_missing=False)


def test_missing_guard_allows_small_delta_and_explicit_override() -> None:
    _ensure_safe_missing(1000, 500, allow_mass_missing=False)
    _ensure_safe_missing(1000, 999, allow_mass_missing=True)


def test_system_folders_at_a_mount_root_are_not_walked(tmp_path: Path) -> None:
    # `lost+found` on an ext4 mount point cannot be read by the service account,
    # and used to fail every scan of a library configured at that mount point.
    for name in ("lost+found", "System Volume Information", "$RECYCLE.BIN"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "stray.mp3").write_bytes(b"x")
    (tmp_path / "Album").mkdir()
    (tmp_path / "Album" / "song.mp3").write_bytes(b"x")

    found = [entry.relative_path for entry in discover_media("music", tmp_path, "music")]

    assert found == ["Album/song.mp3"]


def test_a_name_the_database_cannot_store_is_skipped_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # On Linux a CP1250 file name arrives with surrogate escapes and strict UTF-8
    # refuses it; one such file used to end the scan of the whole root.
    from media_server import catalog

    (tmp_path / "Album").mkdir()
    (tmp_path / "Album" / "good.mp3").write_bytes(b"x")
    (tmp_path / "Album" / "bad.mp3").write_bytes(b"x")
    original = catalog._path_hash

    def refusing_hash(root_slug: str, relative_path: str) -> bytes:
        if relative_path.endswith("bad.mp3"):
            raise UnicodeEncodeError("utf-8", relative_path, 0, 1, "surrogates not allowed")
        return original(root_slug, relative_path)

    monkeypatch.setattr(catalog, "_path_hash", refusing_hash)
    entries = list(catalog.discover_catalog("music", tmp_path, "music"))

    files = [entry.relative_path for entry in entries if isinstance(entry, catalog.DiscoveredFile)]
    skipped = [entry for entry in entries if isinstance(entry, catalog.SkippedEntry)]
    assert files == ["Album/good.mp3"]
    assert len(skipped) == 1 and "bad.mp3" in skipped[0].where


def test_a_folder_refused_for_permission_still_ends_the_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Skipping it would mark everything under it missing at the end of the run —
    # an unreadable disk would quietly empty part of the library.
    from media_server import catalog

    (tmp_path / "Locked").mkdir()
    real_scandir = os.scandir

    def refusing_scandir(path: object) -> object:
        if str(path).endswith("Locked"):
            raise PermissionError(13, "Permission denied", str(path))
        return real_scandir(path)  # type: ignore[arg-type]

    monkeypatch.setattr(catalog.os, "scandir", refusing_scandir)
    with pytest.raises(CatalogError):
        list(catalog.discover_catalog("music", tmp_path, "music"))


class _RecordingCursor:
    def __init__(self, connection: _RecordingConnection) -> None:
        self.connection = connection

    def __enter__(self) -> _RecordingCursor:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        self.connection.events.append(("execute", " ".join(sql.split()), params))

    def executemany(self, sql: str, rows: object) -> None:
        if self.connection.fail_on_write:
            raise RuntimeError("Data too long for column")
        self.connection.events.append(("executemany", " ".join(sql.split()), list(rows)))


class _RecordingConnection:
    def __init__(self, *, fail_on_write: bool = False) -> None:
        self.events: list[tuple] = []
        self.fail_on_write = fail_on_write

    def begin(self) -> None:
        self.events.append(("begin",))

    def commit(self) -> None:
        self.events.append(("commit",))

    def rollback(self) -> None:
        self.events.append(("rollback",))

    def cursor(self) -> _RecordingCursor:
        return _RecordingCursor(self)


def test_a_scan_batch_is_one_transaction_of_a_few_statements() -> None:
    """Every row used to be its own statement and, in autocommit, its own commit."""
    import pymysql.cursors

    from media_server import catalog

    connection = _RecordingConnection()
    upserts = [tuple(range(17)) for _ in range(3)]
    unchanged = [(7, item_id) for item_id in range(1, 601)]

    catalog._flush(connection, upserts, unchanged)

    assert [event[0] for event in connection.events] == ["begin", "executemany", "execute", "execute", "commit"]
    first, second = connection.events[2], connection.events[3]
    assert "WHERE id IN (" in first[1] and first[2][0] == 7 and len(first[2]) == 501
    assert len(second[2]) == 101
    assert upserts == [] and unchanged == []
    # Placeholders only in VALUES: PyMySQL then sends the batch as one multi-row INSERT.
    assert pymysql.cursors.RE_INSERT_VALUES.match(catalog._UPSERT_SQL)


def test_a_batch_that_fails_is_rolled_back_whole() -> None:
    from media_server import catalog

    connection = _RecordingConnection(fail_on_write=True)
    with pytest.raises(RuntimeError):
        catalog._flush(connection, [tuple(range(17))], [(7, 1)])
    assert connection.events == [("begin",), ("rollback",)]


def test_folder_rows_are_written_in_bulk_too() -> None:
    import hashlib as _hashlib
    from collections import Counter

    import pymysql.cursors

    from media_server import catalog

    connection = _RecordingConnection()
    folder = catalog.DiscoveredDirectory(
        relative_path="A", path_hash=_hashlib.sha256(b"a").digest(), parent_path_hash=None, name="A", depth=1
    )
    catalog._upsert_directories(
        connection, root_id=1, scan_id=2, directories={folder.path_hash: folder},
        direct_counts=Counter(), descendant_counts=Counter(), total_sizes=Counter(),
        preview_candidates={folder.path_hash: (0, b"x" * 32)},
    )
    kinds = [event[0] for event in connection.events]
    assert kinds == ["begin", "executemany", "executemany", "commit"]
    assert pymysql.cursors.RE_INSERT_VALUES.match(connection.events[1][1])


def test_a_replaced_file_loses_its_old_fingerprint_in_the_same_write() -> None:
    """The fingerprint survived a replacement: the new file claimed the old one's identity.

    MySQL and MariaDB run the assignments of ON DUPLICATE KEY UPDATE left to
    right, so the comparison has to come before size and time are overwritten.
    """
    from media_server import catalog

    sql = " ".join(catalog._UPSERT_SQL.split())
    reset = sql.index("content_fingerprint = IF(")
    assert reset < sql.index("size_bytes = VALUES(size_bytes)")
    assert reset < sql.index("mtime_ns = VALUES(mtime_ns)")
    assert (
        "media_items.size_bytes <=> VALUES(size_bytes) AND media_items.mtime_ns <=> VALUES(mtime_ns), "
        "media_items.content_fingerprint, NULL )"
    ) in sql


class _SweepCursor:
    """Answers the sweep's two reads from fixed rows and records what it writes."""

    def __init__(self, connection: _SweepConnection) -> None:
        self.connection = connection
        self._rows: list[dict] = []

    def __enter__(self) -> _SweepCursor:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        flat = " ".join(sql.split())
        self._rows = self.connection.items if "FROM media_items" in flat else self.connection.decided

    def executemany(self, _sql: str, rows: object) -> None:
        self.connection.writes.extend(rows)

    def fetchall(self) -> list[dict]:
        return list(self._rows)


class _SweepConnection(_RecordingConnection):
    def __init__(self, items: list[dict], decided: list[bytes]) -> None:
        super().__init__()
        self.items = items
        self.decided = [{"subject_hash": value} for value in decided]
        self.writes: list[tuple] = []

    def cursor(self) -> _SweepCursor:  # type: ignore[override]
        return _SweepCursor(self)


def test_a_numbered_run_becomes_its_series_except_where_a_person_decided() -> None:
    """The folder rule regroups Smerfy's episodes, but moves nothing into or out of a settled work."""
    from media_server import catalog
    from media_server.naming import search_subject_from_path

    paths = [
        "Smerfy/1 - Astrosmerf.avi",
        "Smerfy/15 - Niesmerfny Raj.avi",
        "Smerfy/98 - Magiczna Grzechotka.avi",
        "Smerfy/236 - Smerfociuchcia.avi",
    ]

    def own(path: str) -> bytes:
        return catalog._path_hash("movies", search_subject_from_path(path).group_key)

    def item(item_id: int, path: str, subject_hash: bytes | None) -> dict:
        return {"id": item_id, "relative_path": path, "release_year": None, "release_year_source": None,
                "title_subject_hash": subject_hash}

    series = catalog._path_hash("movies", "Smerfy")
    # The first file was decided by a person as a work of its own; the rest never got an answer.
    connection = _SweepConnection(
        [item(1, paths[0], own(paths[0])), item(2, paths[1], own(paths[1])), item(3, paths[2], None),
         item(4, paths[3], own(paths[3]))],
        decided=[own(paths[0])],
    )
    assert catalog._apply_name_derived_fields(connection, 3, "movies") == 3
    assert sorted(connection.writes, key=lambda row: row[3]) == [
        (None, None, series, 2), (None, None, series, 3), (None, None, series, 4)
    ]

    # The series itself is decided: a file already in it stays, and an unanswered one is not
    # hidden inside a decision whose genres it never got — it stays a question of its own.
    connection = _SweepConnection(
        [item(1, paths[0], series), item(2, paths[1], own(paths[1]))], decided=[series]
    )
    assert catalog._apply_name_derived_fields(connection, 3, "movies") == 0
    assert connection.writes == []
