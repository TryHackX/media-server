from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import time
import uuid
from pathlib import Path

from .config import ThumbnailConfig
from .paths import ResolvedItem

_IMAGE_SUFFIXES = frozenset({".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"})
_AUDIO_SUFFIXES = frozenset({".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"})
_VIDEO_SUFFIXES = frozenset({".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".mts", ".ts", ".webm", ".wmv"})
_NEGATIVE_CACHE_SECONDS = 7 * 24 * 60 * 60


def is_image(item: ResolvedItem) -> bool:
    return item.path.suffix.lower() in _IMAGE_SUFFIXES


def _cache_root(config: ThumbnailConfig) -> Path | None:
    if config.cache_path is None:
        return None
    try:
        cache_root = config.cache_path.expanduser().resolve(strict=True)
    except OSError:
        return None
    return cache_root if cache_root.is_dir() else None


def _cache_names(item: ResolvedItem, config: ThumbnailConfig) -> tuple[str, str, str]:
    canonical_media_path = str(item.path.resolve(strict=True))
    full_hash = hashlib.sha1(f"{canonical_media_path}{config.seek_seconds}".encode("utf-8")).hexdigest()
    simple_hash = hashlib.md5(item.path.name.encode("utf-8"), usedforsecurity=False).hexdigest()
    return (
        f"thumb_{full_hash}.jpg",
        f"thumb_simple_{simple_hash}_{config.seek_seconds}.jpg",
        f"thumb_{full_hash}.missing",
    )


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
    """Resolve a generated or legacy thumbnail from the configured private cache."""
    cache_root = _cache_root(config)
    if cache_root is None:
        return None
    try:
        names = _cache_names(item, config)
    except OSError:
        return None
    for name in names[:2]:
        resolved = _resolved_cache_item(cache_root, name)
        if resolved is not None:
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


def _thumbnail_command(
    item: ResolvedItem,
    config: ThumbnailConfig,
    ffmpeg_path: str,
    target: Path,
) -> list[str] | None:
    suffix = item.path.suffix.lower()
    if suffix not in _AUDIO_SUFFIXES and suffix not in _VIDEO_SUFFIXES:
        return None
    command = [ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error"]
    if suffix in _VIDEO_SUFFIXES:
        command.extend(["-ss", str(config.seek_seconds)])
    command.extend(["-i", str(item.path)])
    if suffix in _AUDIO_SUFFIXES:
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


async def generate_thumbnail(
    item: ResolvedItem,
    config: ThumbnailConfig,
    ffmpeg_path: str | None,
    semaphore: asyncio.Semaphore,
) -> ResolvedItem | None:
    """Lazily extract embedded audio art or a video frame into a bounded private cache."""
    existing = cached_thumbnail(item, config)
    if existing is not None or ffmpeg_path is None:
        return existing
    cache_root = _cache_root(config)
    if cache_root is None:
        return None
    try:
        primary_name, _, negative_name = _cache_names(item, config)
    except OSError:
        return None
    if _negative_cache_is_fresh(cache_root, negative_name):
        return None

    async with semaphore:
        existing = cached_thumbnail(item, config)
        if existing is not None:
            return existing
        if _negative_cache_is_fresh(cache_root, negative_name):
            return None
        target = cache_root.joinpath(primary_name)
        temporary = cache_root.joinpath(f".{primary_name}.{uuid.uuid4().hex}.tmp.jpg")
        command = _thumbnail_command(item, config, ffmpeg_path, temporary)
        if command is None:
            return None
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            try:
                return_code = await asyncio.wait_for(process.wait(), timeout=45)
            except TimeoutError:
                process.kill()
                await process.wait()
                return_code = -1
            if return_code == 0 and temporary.is_file() and temporary.stat().st_size > 0:
                os.replace(temporary, target)
                cache_root.joinpath(negative_name).unlink(missing_ok=True)
                return _resolved_cache_item(cache_root, primary_name)
        except OSError:
            pass
        finally:
            temporary.unlink(missing_ok=True)
        try:
            cache_root.joinpath(negative_name).touch(exist_ok=True)
        except OSError:
            pass
        return None
