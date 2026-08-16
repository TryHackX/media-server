from __future__ import annotations

import asyncio
import json
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from .config import AppConfig
from .paths import ResolvedItem
from .stereo import (
    external_subtitle_path,
    extract_subtitle_webvtt,
    invalidate_subtitle_cache,
    probe_media_info,
    subtitle_cache_file,
)
from .subtitle_pictures import picture_cache_dir, read_picture_manifest, render_subtitle_pictures

# Bumping this discards the record and walks everything again, which is what
# should happen if what "done" means ever changes.
_STATE_VERSION = 1

# How often the record is written out. Often enough that a service restarted
# mid-run loses seconds of work rather than minutes; rarely enough that the walk
# is not one file write per film.
_STATE_EVERY = 25


def _catalog_videos(config: AppConfig, root_slug: str | None, item_ids: list[int]) -> list[tuple[str, str]]:
    connection = pymysql.connect(
        host=config.database.host,
        port=config.database.port,
        user=config.database.user,
        password=config.database.password,
        database=config.database.name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=True,
    )
    try:
        where = ["mi.media_kind = 'video'", "mi.deleted_at IS NULL", "mi.catalog_status IN ('ready', 'legacy')"]
        params: list[Any] = []
        if root_slug is not None:
            where.append("mr.slug = %s")
            params.append(root_slug)
        if item_ids:
            where.append("mi.id IN (" + ",".join(["%s"] * len(item_ids)) + ")")
            params.extend(item_ids)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT mr.slug, mi.relative_path FROM media_items mi "
                "INNER JOIN media_roots mr ON mr.id = mi.root_id WHERE " + " AND ".join(where) + " ORDER BY mi.id",
                params,
            )
            return [(str(row["slug"]), str(row["relative_path"])) for row in cursor.fetchall()]
    finally:
        connection.close()


def _resolved(config: AppConfig, root_slug: str, relative_path: str) -> ResolvedItem | None:
    root = config.roots.get(root_slug)
    if root is None:
        return None
    try:
        canonical_root = root.resolve(strict=True)
        path = canonical_root.joinpath(*relative_path.replace("\\", "/").split("/")).resolve(strict=True)
        if path == canonical_root or canonical_root not in path.parents or not path.is_file():
            return None
        stat = path.stat()
    except (OSError, ValueError):
        return None
    return ResolvedItem(path=path, archive_name=path.name, size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def _state_path(config: AppConfig) -> Path:
    return Path(config.stereo.subtitle_cache_path) / "warm-state.json"


def _load_state(config: AppConfig) -> dict[str, str]:
    """
    Which films have already been walked, and what they looked like at the time.

    Without this the job re-probed every film on every run: finding out whether
    a film's subtitles are cached costs an ffprobe, and paying it 6,617 times to
    learn that the answer is "yes, all of them" is most of what made a second
    pass slow. A restart used to start from the beginning for the same reason.
    """
    try:
        raw = json.loads(_state_path(config).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict) or raw.get("version") != _STATE_VERSION:
        return {}
    done = raw.get("done")
    return {str(k): str(v) for k, v in done.items()} if isinstance(done, dict) else {}


def _save_state(config: AppConfig, done: dict[str, str]) -> None:
    path = _state_path(config)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written beside the target and moved into place, so a service killed
        # mid-write leaves the previous record rather than half of a new one.
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps({"version": _STATE_VERSION, "done": done}, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(path)
    except OSError:
        # A record that cannot be written costs time on the next run, nothing more.
        pass


def _fingerprint(item: ResolvedItem) -> str:
    """Enough of a film's identity to notice it was replaced or re-muxed."""
    return f"{item.size}:{item.mtime_ns}"


async def warm_subtitle_cache(
    config: AppConfig,
    status: MutableMapping[str, Any],
    semaphore: asyncio.Semaphore,
    *,
    root_slug: str | None,
    item_ids: list[int],
    refresh: bool,
) -> None:
    rows = await asyncio.to_thread(_catalog_videos, config, root_slug, item_ids)
    # A refresh is a deliberate "do it all again", so it starts from an empty
    # record; anything else picks up where the last run stopped.
    done = {} if refresh else await asyncio.to_thread(_load_state, config)
    status.update(
        total_files=len(rows), processed_files=0, generated_tracks=0, cached_tracks=0, errors=0,
        skipped_files=0, picture_tracks=0,
    )
    since_save = 0
    for root, relative_path in rows:
        item = _resolved(config, root, relative_path)
        if item is None:
            status["errors"] += 1
            status["processed_files"] += 1
            continue
        key = f"{root}/{relative_path}"
        if done.get(key) == _fingerprint(item):
            # Already walked, and the file has not moved since. No ffprobe.
            status["skipped_files"] += 1
            status["processed_files"] += 1
            continue
        status["current_file"] = item.archive_name
        try:
            async with semaphore:
                info = await probe_media_info(item, config.stereo)
            # Text tracks and sidecars become WebVTT; picture tracks become the
            # pictures the player lays over the film. Both are warmed here,
            # because this pass is where the seconds are affordable — a film with
            # a PGS track costs about half a minute to render, and a viewer who
            # picks those subtitles afterwards waits for nothing.
            width, height = info.get("video_width"), info.get("video_height")
            video_size = (int(width), int(height)) if width and height else None
            for track in info.get("subtitle_tracks", []):
                track_index = int(track["index"])
                if track.get("image"):
                    if await asyncio.to_thread(
                        read_picture_manifest, picture_cache_dir(item, config.stereo, track_index)
                    ) is not None and not refresh:
                        status["cached_tracks"] += 1
                        continue
                    await render_subtitle_pictures(
                        item, config.stereo, track_index, video_size, semaphore, track
                    )
                    status["picture_tracks"] = status.get("picture_tracks", 0) + 1
                    status["generated_tracks"] += 1
                    continue
                if not track.get("supported"):
                    continue
                # Sidecar tracks are converted and cached like embedded ones, and
                # keyed by the sidecar's own file, so the pass warms both kinds.
                sidecar = external_subtitle_path(item, info, track_index)
                cache_path = subtitle_cache_file(item, config.stereo, track_index, sidecar)
                if cache_path is not None and cache_path.is_file() and not refresh:
                    status["cached_tracks"] += 1
                    continue
                if refresh and cache_path is not None:
                    await invalidate_subtitle_cache(item, config.stereo, track_index, sidecar)
                await extract_subtitle_webvtt(item, config.stereo, track_index, 0.0, semaphore, sidecar)
                status["generated_tracks"] += 1
            # Only a file that got all the way through is recorded as done; one
            # that raised is left out so the next run tries it again.
            done[key] = _fingerprint(item)
            since_save += 1
            if since_save >= _STATE_EVERY:
                since_save = 0
                await asyncio.to_thread(_save_state, config, done)
        except Exception:
            status["errors"] += 1
        status["processed_files"] += 1
        await asyncio.sleep(0)
    await asyncio.to_thread(_save_state, config, done)
    status.update(state="completed", current_file="", finished=True)
