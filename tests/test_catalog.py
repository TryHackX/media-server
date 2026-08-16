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
        (ExistingItem(1, 10, 20, "legacy", False), False, "updated"),
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
