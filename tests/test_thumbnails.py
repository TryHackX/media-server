"""Pictures for files: which files get one, where the frame is taken, and when a cached one is still right."""
from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pytest

from media_server import thumbnails
from media_server.config import ThumbnailConfig
from media_server.mediatypes import (
    AUDIO_EXTENSIONS,
    AUXILIARY_EXTENSIONS,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    mime_type_for,
)
from media_server.paths import ResolvedItem


def _item(path: Path) -> ResolvedItem:
    stat = path.stat()
    return ResolvedItem(path=path, archive_name=path.name, size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def _config(tmp_path: Path, seek_seconds: int = 120) -> ThumbnailConfig:
    cache = tmp_path / "cache"
    cache.mkdir(exist_ok=True)
    return ThumbnailConfig(cache_path=cache, seek_seconds=seek_seconds)


class _FakeFfmpeg:
    """Stands in for ``asyncio.create_subprocess_exec``: writes a frame only where the film has one."""

    def __init__(self, length_seconds: float, *, hangs: bool = False) -> None:
        self.length_seconds = length_seconds
        self.hangs = hangs
        self.seeks: list[int | None] = []
        self.killed = 0

    async def __call__(self, *command: str, **_: object) -> "_FakeFfmpeg":
        seek = int(command[command.index("-ss") + 1]) if "-ss" in command else None
        self.seeks.append(seek)
        if not self.hangs and (seek is None or seek < self.length_seconds):
            Path(command[-1]).write_bytes(b"jpeg")
        return self

    async def wait(self) -> int:
        if self.hangs:
            await asyncio.sleep(30)
        # FFmpeg asked for a frame past the end exits cleanly and writes nothing.
        return 0

    def kill(self) -> None:
        self.killed += 1
        self.hangs = False


def test_the_catalogue_and_the_thumbnailer_agree_on_what_a_film_is(tmp_path: Path) -> None:
    """A .vob was a film to the scanner and nothing to the thumbnailer: 26 films without a picture (T-08)."""
    config = _config(tmp_path)
    for suffix in sorted(VIDEO_EXTENSIONS):
        film = tmp_path / f"film{suffix}"
        film.write_bytes(b"x")
        assert thumbnails._seek_attempts(_item(film), config) == (120, 12, 1, 0), suffix
    for suffix in sorted(AUDIO_EXTENSIONS):
        track = tmp_path / f"track{suffix}"
        track.write_bytes(b"x")
        # A track has no frames to seek among: its picture is the cover stored in the file.
        assert thumbnails._seek_attempts(_item(track), config) == (None,), suffix
    note = tmp_path / "notes.nfo"
    note.write_bytes(b"x")
    assert thumbnails._seek_attempts(_item(note), config) == ()
    assert {".vob", ".mkv", ".divx"} <= VIDEO_EXTENSIONS and {".aif", ".flac", ".wv"} <= AUDIO_EXTENSIONS
    assert not (VIDEO_EXTENSIONS & AUDIO_EXTENSIONS) and not (IMAGE_EXTENSIONS & AUXILIARY_EXTENSIONS)
    # A short configured seek does not ask the same place twice.
    assert thumbnails._seek_attempts(_item(tmp_path / "film.mkv"), _config(tmp_path, 5)) == (5, 0, 1)
    assert thumbnails._seek_attempts(_item(tmp_path / "film.mkv"), _config(tmp_path, 0)) == (0, 1)


def test_types_come_from_one_table_not_from_the_machine() -> None:
    """The registry called a .flac audio/x-flac, a .ts video/vnd.dlna.mpeg-tts and a .vob nothing (T-07)."""
    assert mime_type_for(".flac") == "audio/flac"
    assert mime_type_for("FLAC") == mime_type_for(".Flac") == "audio/flac"
    assert mime_type_for(".ts") == mime_type_for(".m2ts") == mime_type_for(".mts") == "video/mp2t"
    assert mime_type_for(".vob") == "video/mpeg" and mime_type_for(".aac") == "audio/aac"
    assert mime_type_for(".mkv") == "video/x-matroska" and mime_type_for(".mp4") == "video/mp4"
    # A subtitle file is text, whatever /etc/mime.types thinks ".ass" stands for.
    assert mime_type_for(".ass") == mime_type_for(".srt") == "text/plain"
    assert mime_type_for(".exe") is None and mime_type_for("") is None
    for suffix in AUDIO_EXTENSIONS | VIDEO_EXTENSIONS | IMAGE_EXTENSIONS | AUXILIARY_EXTENSIONS:
        assert mime_type_for(suffix), suffix


def test_a_short_film_gets_its_frame_nearer_the_start(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two minutes in is beyond the end of a ninety-second clip; twenty such films had no picture."""
    film = tmp_path / "clip.mkv"
    film.write_bytes(b"ninety seconds")
    config = _config(tmp_path)
    ffmpeg = _FakeFfmpeg(length_seconds=90)
    monkeypatch.setattr(thumbnails.asyncio, "create_subprocess_exec", ffmpeg)

    made = asyncio.run(thumbnails.generate_thumbnail(_item(film), config, "ffmpeg", asyncio.Semaphore(1)))
    assert made is not None and made.path.read_bytes() == b"jpeg"
    assert ffmpeg.seeks == [120, 12]
    # Found in the cache from now on, without another run.
    assert thumbnails.cached_thumbnail(_item(film), config) == made
    asyncio.run(thumbnails.generate_thumbnail(_item(film), config, "ffmpeg", asyncio.Semaphore(1)))
    assert ffmpeg.seeks == [120, 12]
    assert [path.name for path in config.cache_path.iterdir()] == [made.path.name]


def test_a_file_without_any_picture_is_remembered_as_such(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    film = tmp_path / "broken.vob"
    film.write_bytes(b"not a film")
    config = _config(tmp_path)
    ffmpeg = _FakeFfmpeg(length_seconds=-1)
    monkeypatch.setattr(thumbnails.asyncio, "create_subprocess_exec", ffmpeg)

    assert asyncio.run(thumbnails.generate_thumbnail(_item(film), config, "ffmpeg", asyncio.Semaphore(1))) is None
    assert ffmpeg.seeks == [120, 12, 1, 0]
    markers = [path.name for path in config.cache_path.iterdir()]
    assert len(markers) == 1 and markers[0].endswith(".missing")
    # Not asked again while the marker is fresh.
    assert asyncio.run(thumbnails.generate_thumbnail(_item(film), config, "ffmpeg", asyncio.Semaphore(1))) is None
    assert ffmpeg.seeks == [120, 12, 1, 0]


def test_a_file_that_hangs_ffmpeg_is_not_tried_four_times(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    film = tmp_path / "stuck.mkv"
    film.write_bytes(b"on a share that stopped answering")
    config = _config(tmp_path)
    ffmpeg = _FakeFfmpeg(length_seconds=9999, hangs=True)
    monkeypatch.setattr(thumbnails.asyncio, "create_subprocess_exec", ffmpeg)
    monkeypatch.setattr(thumbnails, "_FFMPEG_TIMEOUT_SECONDS", 0.05)

    assert asyncio.run(thumbnails.generate_thumbnail(_item(film), config, "ffmpeg", asyncio.Semaphore(1))) is None
    assert ffmpeg.seeks == [120] and ffmpeg.killed == 1
    assert [path.suffix for path in config.cache_path.iterdir()] == [".missing"]


def test_a_replaced_file_does_not_wear_the_old_picture(tmp_path: Path) -> None:
    """The picture's name knew only the path: another film under the same name kept the first one's frame."""
    film = tmp_path / "film.mkv"
    film.write_bytes(b"first cut")
    config = _config(tmp_path)
    former = config.cache_path / ("thumb_" + hashlib.sha1(f"{film.resolve()}120".encode()).hexdigest() + ".jpg")
    former.write_bytes(b"old-frame")

    # Made after the file was last touched: still the right picture, under its former name.
    found = thumbnails.cached_thumbnail(_item(film), config)
    assert found is not None and found.path == former

    # The file is replaced (new size, later time): the old picture is not its picture.
    film.write_bytes(b"the director's cut, longer")
    later = former.stat().st_mtime + 3600
    os.utime(film, (later, later))
    assert thumbnails.cached_thumbnail(_item(film), config) is None

    # And the picture made for it now is found by its size and time.
    current, _, missing = thumbnails._cache_names(_item(film), config)
    (config.cache_path / current).write_bytes(b"new-frame")
    found = thumbnails.cached_thumbnail(_item(film), config)
    assert found is not None and found.path.name == current and current != former.name
    assert missing == current.removesuffix(".jpg") + ".missing"
    # Nothing is looked up by the bare file name any more (two films called "movie.mkv" shared one).
    assert all("simple" not in name for name in thumbnails._cache_names(_item(film), config))
