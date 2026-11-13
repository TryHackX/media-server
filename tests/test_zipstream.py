from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from media_server.paths import ResolvedItem
from media_server.zipstream import zip_chunks


def _entry(path: Path, archive_name: str) -> ResolvedItem:
    stat = path.stat()
    return ResolvedItem(path=path, archive_name=archive_name, size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def test_streamed_zip_is_valid_store_zip64_and_sanitized(tmp_path: Path) -> None:
    first = tmp_path / "one.txt"
    second = tmp_path / "two.txt"
    first.write_bytes(b"one")
    second.write_bytes(b"two")

    archive = b"".join(
        zip_chunks(
            (
                _entry(first, "../../album/track.txt"),
                _entry(second, "../../album/track.txt"),
            ),
            chunk_size=2,
        )
    )

    with zipfile.ZipFile(io.BytesIO(archive)) as opened:
        assert opened.namelist() == ["album/track.txt", "album/track (1).txt"]
        assert opened.read("album/track.txt") == b"one"
        assert opened.read("album/track (1).txt") == b"two"
        assert all(info.compress_type == zipfile.ZIP_STORED for info in opened.infolist())


def test_single_large_entry_forces_zip64_without_buffering(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    large = tmp_path / "large.bin"
    large.write_bytes(b"0123456789")
    monkeypatch.setattr(zipfile, "ZIP64_LIMIT", 5)

    archive = b"".join(zip_chunks((_entry(large, "duży/plik.bin"),), chunk_size=3))

    assert b"PK\x06\x06" in archive
    with zipfile.ZipFile(io.BytesIO(archive)) as opened:
        assert opened.read("duży/plik.bin") == b"0123456789"


def test_a_file_dated_before_1970_does_not_abort_the_archive(tmp_path: Path) -> None:
    # Windows cannot convert a time before 1970 at all; the clamp to 1980 used to
    # come after the conversion, so one such file broke the download mid-way.
    old = tmp_path / "old.txt"
    old.write_bytes(b"old")
    entry = ResolvedItem(path=old, archive_name="old.txt", size=3, mtime_ns=-2_000_000_000_000_000_000)

    archive = b"".join(zip_chunks((entry,)))

    with zipfile.ZipFile(io.BytesIO(archive)) as opened:
        info = opened.getinfo("old.txt")
        assert info.date_time[0] == 1980
        assert opened.read("old.txt") == b"old"
