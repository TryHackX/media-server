"""
Clearing what the caches keep for files that are gone.

Three caches grow with the library and none of them ever shrank: a picture per
file (``thumbnails``), the picture subtitles of every film that has them
(``subtitles/pictures`` — a million files, twenty-one gigabytes on the first
installation) and the text subtitles converted to WebVTT. Each entry is named by
a digest of the file it was made from — its path, its size, its time — so
replacing, renaming or deleting a film leaves the old entry behind for ever,
under a name nothing will ask for again.

A digest cannot be turned back into a path, so "is this entry still wanted" is
answered the other way round: the names every catalogued file *would* have are
computed — with the very functions the server uses when it serves them — and
what is on disk under any other name is stale.

Deleting is the dangerous half, so it is hedged four ways:

* **Nothing is deleted unless asked** (``apply``); the default is a report.
* **Only names this server writes** are ever candidates: a file somebody else
  put in a cache folder is not ours to judge.
* **A grace period**: an entry younger than a week is left alone, because the
  file it belongs to may simply not have been scanned yet.
* **No source, no pruning**: if a catalogued source is not mounted, or half the
  catalogue cannot be found on disk, the run stops before it looks at a cache —
  an unplugged drive looks exactly like a library somebody emptied. And a cache
  that would lose more than half of its entries is left as it is unless that is
  confirmed (``allow_mass_delete``).
"""

from __future__ import annotations

import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import thumbnails
from .config import PROJECT_ROOT, AppConfig
from .database import connect_rows
from .paths import PathAccessError, resolve_item
from .security import GrantItem
from .stats import directory_size
from .stereo import MAX_SUBTITLE_TRACKS, embedded_subtitle_cache_name
from .subtitle_pictures import picture_cache_dir

__all__ = ["CACHES", "PruneError", "prune_caches"]

CACHES: tuple[str, ...] = ("thumbnails", "pictures", "subtitles", "filmweb")


class PruneError(RuntimeError):
    pass


_THUMBNAIL = re.compile(r"thumb_[0-9a-f]{40}\.(?:jpg|missing)")
# Named by the bare file name, before 2026: no reader is left (thumbnails.py).
_THUMBNAIL_BY_NAME = re.compile(r"thumb_simple_[0-9a-f]{32}_\d+\.jpg")
_THUMBNAIL_TEMPORARY = re.compile(r"\.thumb_[0-9a-f]{40}\.jpg\.[0-9a-f]{32}\.tmp\.jpg")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_PICTURE_STAGING = re.compile(r"[0-9a-f]{64}\.partial")
_WEBVTT = re.compile(r"[0-9a-f]{64}\.vtt")
_WEBVTT_TEMPORARY = re.compile(r"[0-9a-f]{64}\.\d+\.tmp")
_SHARD = re.compile(r"[0-9a-f]{2}")

# A conversion of a subtitle file lying beside a film is keyed by that file, which
# the catalogue does not list — so it cannot be told from a stale entry by name.
# It costs a second to make again, and is let go once it is this old.
_SIDECAR_KEEP_DAYS = 30.0
# Answers from Filmweb are trusted for thirty days (filmweb.py); after that the
# file is only taking up a name.
_FILMWEB_KEEP_DAYS = 45.0
# Something a killed process left half-written.
_TEMPORARY_KEEP_DAYS = 1.0
_EXAMPLES = 5


@dataclass(slots=True)
class _Wanted:
    """The names every catalogued file would have in each cache."""

    thumbnails: set[str] = field(default_factory=set)
    pictures: set[str] = field(default_factory=set)
    subtitles: set[str] = field(default_factory=set)
    files: int = 0
    unavailable: int = 0


@dataclass(slots=True)
class _Tally:
    entries: int = 0
    stale: list[tuple[Path, bool]] = field(default_factory=list)
    recent: int = 0


def _catalogue(config: AppConfig) -> list[tuple[str, str, str]]:
    with connect_rows(config.database) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT mr.slug, mi.relative_path, mi.media_kind FROM media_items mi "
                "INNER JOIN media_roots mr ON mr.id = mi.root_id "
                "WHERE mi.deleted_at IS NULL AND mi.media_kind IN ('audio', 'video') ORDER BY mi.id"
            )
            return [(str(row["slug"]), str(row["relative_path"]), str(row["media_kind"])) for row in cursor.fetchall()]


def _wanted(config: AppConfig, rows: list[tuple[str, str, str]]) -> _Wanted:
    wanted = _Wanted(files=len(rows))
    pictures = config.stereo.subtitle_cache_path is not None
    for root, relative_path, kind in rows:
        try:
            item = resolve_item(GrantItem(root=root, path=relative_path), config.roots)
        except PathAccessError:
            wanted.unavailable += 1
            continue
        try:
            wanted.thumbnails.update(thumbnails._cache_names(item, config.thumbnails))
        except OSError:
            wanted.unavailable += 1
            continue
        if kind != "video" or not pictures:
            continue
        for track in range(MAX_SUBTITLE_TRACKS):
            wanted.subtitles.add(embedded_subtitle_cache_name(item, track))
            for native in (False, True):
                directory = picture_cache_dir(item, config.stereo, track, native=native)
                if directory is not None:
                    wanted.pictures.add(directory.name)
    return wanted


def _age_days(entry: os.DirEntry[str], now: float) -> float:
    return (now - entry.stat(follow_symlinks=False).st_mtime) / 86400.0


def _scan_thumbnails(root: Path, wanted: set[str], grace_days: float, now: float) -> _Tally:
    tally = _Tally()
    with os.scandir(root) as listing:
        for entry in listing:
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
                age = _age_days(entry, now)
            except OSError:
                continue
            if _THUMBNAIL.fullmatch(entry.name):
                tally.entries += 1
                if entry.name in wanted:
                    continue
                keep = grace_days
            elif _THUMBNAIL_BY_NAME.fullmatch(entry.name):
                tally.entries += 1
                keep = grace_days
            elif _THUMBNAIL_TEMPORARY.fullmatch(entry.name):
                keep = _TEMPORARY_KEEP_DAYS
            else:
                continue
            if age > keep:
                tally.stale.append((Path(entry.path), False))
            else:
                tally.recent += 1
    return tally


def _scan_pictures(root: Path, wanted: set[str], grace_days: float, now: float) -> _Tally:
    tally = _Tally()
    with os.scandir(root) as listing:
        for entry in listing:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                age = _age_days(entry, now)
            except OSError:
                continue
            if _DIGEST.fullmatch(entry.name):
                tally.entries += 1
                if entry.name in wanted:
                    continue
                keep = grace_days
            elif _PICTURE_STAGING.fullmatch(entry.name):
                # A render in progress lives here for minutes; one this old was killed.
                keep = _TEMPORARY_KEEP_DAYS
            else:
                continue
            if age > keep:
                tally.stale.append((Path(entry.path), True))
            else:
                tally.recent += 1
    return tally


def _scan_subtitles(root: Path, wanted: set[str], grace_days: float, now: float) -> _Tally:
    tally = _Tally()
    with os.scandir(root) as shards:
        for shard in shards:
            try:
                if not shard.is_dir(follow_symlinks=False) or not _SHARD.fullmatch(shard.name):
                    continue
                with os.scandir(shard.path) as listing:
                    for entry in listing:
                        try:
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            age = _age_days(entry, now)
                        except OSError:
                            continue
                        if _WEBVTT.fullmatch(entry.name):
                            tally.entries += 1
                            if entry.name.removesuffix(".vtt") in wanted:
                                continue
                            keep = max(grace_days, _SIDECAR_KEEP_DAYS)
                        elif _WEBVTT_TEMPORARY.fullmatch(entry.name):
                            keep = _TEMPORARY_KEEP_DAYS
                        else:
                            continue
                        if age > keep:
                            tally.stale.append((Path(entry.path), False))
                        else:
                            tally.recent += 1
            except OSError:
                continue
    return tally


def _scan_filmweb(root: Path, now: float) -> _Tally:
    tally = _Tally()
    with os.scandir(root) as listing:
        for entry in listing:
            try:
                if not entry.is_file(follow_symlinks=False) or not entry.name.endswith(".json"):
                    continue
                tally.entries += 1
                if _age_days(entry, now) > _FILMWEB_KEEP_DAYS:
                    tally.stale.append((Path(entry.path), False))
            except OSError:
                continue
    return tally


def _settle(tally: _Tally, *, apply: bool, allow_mass_delete: bool, guarded: bool = True) -> dict[str, Any]:
    """Count what is stale, and remove it if that was asked for and is not most of the cache."""
    size = 0
    for path, is_directory in tally.stale:
        try:
            size += directory_size(path)[0] if is_directory else path.stat().st_size
        except OSError:
            continue
    report: dict[str, Any] = {
        "entries": tally.entries,
        "stale": len(tally.stale),
        "stale_bytes": size,
        "kept_as_recent": tally.recent,
        "removed": 0,
        "examples": [path.name for path, _ in tally.stale[:_EXAMPLES]],
    }
    if not apply or not tally.stale:
        return report
    if guarded and not allow_mass_delete and len(tally.stale) > 100 and len(tally.stale) * 2 > tally.entries:
        report["refused"] = (
            "ponad połowa wpisów wygląda na zbędne — sprawdź katalog i źródła, "
            "a jeśli to zamierzone, powtórz z --allow-mass-delete"
        )
        return report
    for path, is_directory in tally.stale:
        try:
            if is_directory:
                shutil.rmtree(path)
            else:
                path.unlink()
            report["removed"] += 1
        except FileNotFoundError:
            report["removed"] += 1
        except OSError:
            continue
    return report


def _directory(path: Path | None) -> Path | None:
    if path is None:
        return None
    try:
        resolved = path.expanduser().resolve(strict=True)
    except OSError:
        return None
    return resolved if resolved.is_dir() else None


def prune_caches(
    *,
    config: AppConfig,
    apply: bool = False,
    grace_days: float = 7.0,
    allow_mass_delete: bool = False,
    only: tuple[str, ...] = CACHES,
    now: float | None = None,
) -> dict[str, Any]:
    """Report — and with ``apply`` remove — cache entries no catalogued file would ask for."""
    unknown = sorted(set(only) - set(CACHES))
    if unknown:
        raise PruneError("Nieznane pamięci podręczne: " + ", ".join(unknown))
    if not 0 <= grace_days <= 3650:
        raise PruneError("Okres karencji musi mieścić się w zakresie 0..3650 dni")
    started = time.monotonic()
    moment = time.time() if now is None else now
    report: dict[str, Any] = {"mode": "apply" if apply else "dry-run", "status": "ok", "grace_days": grace_days}

    rows = _catalogue(config)
    missing_roots = sorted({root for root, _, _ in rows if _directory(config.roots.get(root)) is None})
    if missing_roots:
        # Without the source there is no telling a deleted file from an unplugged disk.
        report.update(
            status="skipped",
            reason="źródło jest niedostępne albo nie ma go w konfiguracji: " + ", ".join(missing_roots),
        )
        return report
    wanted = _wanted(config, rows)
    report.update(catalogue_files=wanted.files, not_on_disk=wanted.unavailable)
    if wanted.files and wanted.unavailable * 2 > wanted.files:
        report.update(
            status="skipped",
            reason="ponad połowy skatalogowanych plików nie ma na dysku — najpierw skan albo sprawdzenie dysków",
        )
        return report

    caches: dict[str, Any] = {}
    thumbnail_root = _directory(config.thumbnails.cache_path)
    subtitle_root = _directory(config.stereo.subtitle_cache_path)
    picture_root = _directory(subtitle_root / "pictures") if subtitle_root is not None else None
    filmweb_root = _directory(PROJECT_ROOT / "runtime" / "filmweb-cache")
    if "thumbnails" in only and thumbnail_root is not None:
        caches["thumbnails"] = _settle(
            _scan_thumbnails(thumbnail_root, wanted.thumbnails, grace_days, moment),
            apply=apply, allow_mass_delete=allow_mass_delete,
        )
    if "pictures" in only and picture_root is not None:
        caches["pictures"] = _settle(
            _scan_pictures(picture_root, wanted.pictures, grace_days, moment),
            apply=apply, allow_mass_delete=allow_mass_delete,
        )
    if "subtitles" in only and subtitle_root is not None:
        caches["subtitles"] = _settle(
            _scan_subtitles(subtitle_root, wanted.subtitles, grace_days, moment),
            apply=apply, allow_mass_delete=allow_mass_delete,
        )
    if "filmweb" in only and filmweb_root is not None:
        # Decided by age alone, so there is no catalogue to be wrong about.
        caches["filmweb"] = _settle(_scan_filmweb(filmweb_root, moment), apply=apply, allow_mass_delete=True, guarded=False)
    report["caches"] = caches
    if any("refused" in cache for cache in caches.values()):
        report["status"] = "partial"
    report["seconds"] = round(time.monotonic() - started, 3)
    return report
