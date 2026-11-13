from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import time
import uuid
from pathlib import Path

from .config import ThumbnailConfig
from .mediatypes import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from .paths import ResolvedItem

_NEGATIVE_CACHE_SECONDS = 7 * 24 * 60 * 60
# One frame out of one file. A healthy disk answers in well under a second.
_FFMPEG_TIMEOUT_SECONDS = 45.0


def is_image(item: ResolvedItem) -> bool:
    return item.path.suffix.lower() in IMAGE_EXTENSIONS


def _cache_root(config: ThumbnailConfig) -> Path | None:
    if config.cache_path is None:
        return None
    try:
        cache_root = config.cache_path.expanduser().resolve(strict=True)
    except OSError:
        return None
    return cache_root if cache_root.is_dir() else None


def _cache_names(item: ResolvedItem, config: ThumbnailConfig) -> tuple[str, str, str]:
    """The picture's name, the name it had before, and the name of its "there is none" marker.

    The name is made of the file's path, the place the frame is taken from, and
    the file's size and time — so a film replaced by another under the same name
    gets a picture of its own instead of wearing the old one for ever. Before
    that the name knew only the path; pictures made then are still good while
    their file has not changed (see ``cached_thumbnail``), so nothing has to be
    made again.
    """
    canonical_media_path = str(item.path.resolve(strict=True))
    current = hashlib.sha1(
        f"{canonical_media_path}\0{config.seek_seconds}\0{item.size}\0{item.mtime_ns}".encode("utf-8")
    ).hexdigest()
    former = hashlib.sha1(f"{canonical_media_path}{config.seek_seconds}".encode("utf-8")).hexdigest()
    return f"thumb_{current}.jpg", f"thumb_{former}.jpg", f"thumb_{current}.missing"


def _resolved_cache_item(cache_root: Path, name: str) -> ResolvedItem | None:
    try:
        candidate = cache_root.joinpath(name).resolve(strict=True)
        if os.path.commonpath((str(cache_root), str(candidate))) != str(cache_root) or not candidate.is_file():
            return None
        stat = candidate.stat()
    except (OSError, ValueError):
        return None
    if stat.st_size <= 0:
        return None
    return ResolvedItem(
        path=Path(candidate),
        archive_name=name,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
    )


def cached_thumbnail(item: ResolvedItem, config: ThumbnailConfig) -> ResolvedItem | None:
    """The picture already made for this file, from the configured private cache."""
    cache_root = _cache_root(config)
    if cache_root is None:
        return None
    try:
        current, former, _ = _cache_names(item, config)
    except OSError:
        return None
    resolved = _resolved_cache_item(cache_root, current)
    if resolved is not None:
        return resolved
    # Made under the former name: right for as long as the file is the one it
    # was made from, which is to say not touched since.
    resolved = _resolved_cache_item(cache_root, former)
    if resolved is not None and resolved.mtime_ns >= item.mtime_ns:
        return resolved
    return None


def _negative_cache_is_fresh(cache_root: Path, name: str) -> bool:
    try:
        marker = cache_root.joinpath(name).resolve(strict=True)
        if os.path.commonpath((str(cache_root), str(marker))) != str(cache_root) or not marker.is_file():
            return False
        return time.time() - marker.stat().st_mtime <= _NEGATIVE_CACHE_SECONDS
    except (OSError, ValueError):
        return False


def _seek_attempts(item: ResolvedItem, config: ThumbnailConfig) -> tuple[int | None, ...]:
    """Where to look for a frame, in order; ``None`` is "no seeking" (a track's embedded cover).

    The configured place first — two minutes in is past the studio logos — and
    then nearer the start: a clip shorter than that has no frame there at all,
    and twenty catalogued videos never got a picture because the only place
    asked was beyond their end.
    """
    suffix = item.path.suffix.lower()
    if suffix in VIDEO_EXTENSIONS:
        attempts: list[int | None] = []
        for seconds in (config.seek_seconds, config.seek_seconds // 10, 1, 0):
            if seconds >= 0 and seconds not in attempts:
                attempts.append(seconds)
        return tuple(attempts)
    if suffix in AUDIO_EXTENSIONS:
        return (None,)
    return ()


def _thumbnail_command(item: ResolvedItem, ffmpeg_path: str, target: Path, seek_seconds: int | None) -> list[str]:
    command = [ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error"]
    if seek_seconds is not None:
        command.extend(["-ss", str(seek_seconds)])
    command.extend(["-i", str(item.path)])
    if seek_seconds is None:
        # A track: the picture is the cover stored in the file, if it has one.
        command.extend(["-map", "0:v:0"])
    command.extend([
        "-frames:v",
        "1",
        "-vf",
        "scale=960:960:force_original_aspect_ratio=decrease",
        "-q:v",
        "4",
        "-y",
        str(target),
    ])
    return command


async def _run(command: list[str]) -> bool:
    """Whether FFmpeg finished and said it succeeded. ``TimeoutError`` when it had to be stopped."""
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        return await asyncio.wait_for(process.wait(), timeout=_FFMPEG_TIMEOUT_SECONDS) == 0
    except TimeoutError:
        process.kill()
        await process.wait()
        raise


async def generate_thumbnail(
    item: ResolvedItem,
    config: ThumbnailConfig,
    ffmpeg_path: str | None,
    semaphore: asyncio.Semaphore,
) -> ResolvedItem | None:
    """Lazily extract embedded audio art or a video frame into the private cache.

    Nothing here ever removes a picture: the cache grows with the library, and
    what belongs to files that are gone is cleared by ``media-server
    cache-prune`` (maintenance.py).

    Every look at the cache resolves and stats paths — the film's among them — so
    it happens in a thread: on a network share each one is a round trip the event
    loop would otherwise sit through.
    """
    existing = await asyncio.to_thread(cached_thumbnail, item, config)
    if existing is not None or ffmpeg_path is None:
        return existing
    cache_root = await asyncio.to_thread(_cache_root, config)
    if cache_root is None:
        return None
    try:
        primary_name, _, negative_name = await asyncio.to_thread(_cache_names, item, config)
    except OSError:
        return None
    if await asyncio.to_thread(_negative_cache_is_fresh, cache_root, negative_name):
        return None
    attempts = _seek_attempts(item, config)
    if not attempts:
        return None

    async with semaphore:
        existing = await asyncio.to_thread(cached_thumbnail, item, config)
        if existing is not None:
            return existing
        if await asyncio.to_thread(_negative_cache_is_fresh, cache_root, negative_name):
            return None
        target = cache_root.joinpath(primary_name)
        temporary = cache_root.joinpath(f".{primary_name}.{uuid.uuid4().hex}.tmp.jpg")
        try:
            for seek_seconds in attempts:
                if await _run(_thumbnail_command(item, ffmpeg_path, temporary, seek_seconds)):
                    stored = await asyncio.to_thread(_store_thumbnail, cache_root, temporary, target, negative_name)
                    if stored is not None:
                        return stored
        except TimeoutError:
            # A file that could not give one frame in the time allowed will not
            # give it nearer the start either; the slot is wanted by the next.
            pass
        except OSError:
            pass
        finally:
            # Synchronous on purpose: the private cache is local, and a cleanup that
            # awaits can be cancelled before it runs.
            temporary.unlink(missing_ok=True)
        await asyncio.to_thread(_mark_missing, cache_root, negative_name)
        return None


def _store_thumbnail(cache_root: Path, temporary: Path, target: Path, negative_name: str) -> ResolvedItem | None:
    if not temporary.is_file() or temporary.stat().st_size <= 0:
        return None
    os.replace(temporary, target)
    cache_root.joinpath(negative_name).unlink(missing_ok=True)
    return _resolved_cache_item(cache_root, target.name)


def _mark_missing(cache_root: Path, negative_name: str) -> None:
    try:
        cache_root.joinpath(negative_name).touch(exist_ok=True)
    except OSError:
        pass
