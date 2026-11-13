from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any

from .config import AppConfig
from .database import connect_rows
from .paths import PathAccessError, ResolvedItem, resolve_item
from .security import GrantItem
from .stereo import (
    StereoTranscodeError,
    external_subtitle_path,
    extract_film_webvtt,
    extract_subtitle_webvtt,
    invalidate_subtitle_cache,
    probe_media_info_patiently,
    subtitle_cache_file,
)
from .subtitle_pictures import (
    _PICTURE_RENDER_VERSION,
    _RESTAMPED_RENDER_VERSION,
    RENDER_SLOTS,
    render_film_pictures,
    sweep_stale_work,
)

# Bumping this discards the record and walks everything again, which is what
# should happen if what "done" means ever changes. "Done" includes the picture
# subtitles, so their render versions are part of it: the record on this server was
# written before pictures were rendered at all, and 305 of the 392 films still
# missing pictures sat behind a "done" from then — a normal pass skipped them for
# good. Version 3: transport and program streams render under a new key (their
# cues were early), so a film recorded as done under the old one has to be walked
# again. Re-walking costs one probe per film; tracks already converted are found
# in the cache and left alone.
_STATE_VERSION = f"3/{_PICTURE_RENDER_VERSION}/{_RESTAMPED_RENDER_VERSION}"

# How often the record is written out. Often enough that a service restarted
# mid-run loses seconds of work rather than minutes; rarely enough that the walk
# is not one file write per film.
_STATE_EVERY = 25

# Films in flight at once: one being read while the one before it is drawn. The
# disk is held by one of them at a time (the semaphore), so the second is never a
# second read competing with the first — it is the CPU work of the first.
_FILMS_IN_FLIGHT = 2

# How many of a run's failures its status keeps: the latest few, enough to see
# what kind of trouble it is. Every one of them is in the service log.
_RECENT_FAILURES = 10

LOGGER = logging.getLogger("media_server.subtitle_jobs")


def _failed(
    status: MutableMapping[str, Any],
    film: str,
    state: str,
    reason: str | None,
    *,
    track: int | None = None,
    codec: str | None = None,
    exc_info: bool = False,
) -> None:
    """Count one failure, keep it among the latest, and log it: one line per film or track.

    The first full run counted 48 errors and wrote down none of them; finding out
    what they were took a census of the catalogue. ``film`` is ``root/relative
    path``; ``track`` and ``codec`` are absent when the film as a whole failed
    (not on disk, not described, an exception).
    """
    status["errors"] = int(status.get("errors", 0)) + 1
    root, _, relative_path = film.partition("/")
    entry = {
        "path": film, "track": track, "codec": codec, "state": state,
        "reason": (reason or "no reason given")[:300],
    }
    recent = status.setdefault("recent_failures", [])
    recent.append(entry)
    del recent[:-_RECENT_FAILURES]
    LOGGER.warning(
        "subtitle cache: %s failed",
        "film" if track is None else "track",
        extra={
            "event": "subtitle_cache_failure",
            "root": root,
            "path": relative_path,
            "track": track,
            "codec": codec,
            "state": state,
            "reason": entry["reason"],
        },
        exc_info=exc_info,
    )


def _catalog_videos(config: AppConfig, root_slug: str | None, item_ids: list[int]) -> list[tuple[str, str]]:
    connection = connect_rows(config.database)
    try:
        where = ["mi.media_kind = 'video'", "mi.deleted_at IS NULL", "mi.catalog_status = 'ready'"]
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
    """A catalogued film on the disk, by the same rules every transfer goes by (paths.resolve_item).

    This used to be a second reading of the path, with a habit of its own: it
    turned every backslash into a separator on every system, so on Linux — where
    a backslash is just a character — a film with one in its name was "not on
    disk" to the subtitle job and played fine everywhere else.
    """
    try:
        return resolve_item(GrantItem(root=root_slug, path=relative_path), config.roots)
    except PathAccessError:
        return None


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


async def _warm_text(
    item: ResolvedItem,
    info: dict[str, Any],
    config: AppConfig,
    status: MutableMapping[str, Any],
    semaphore: asyncio.Semaphore,
    refresh: bool,
    film: str = "",
) -> int:
    """Convert the film's text tracks; how many failed.

    The embedded ones go in one read of the film. Sidecar files are their own
    small files and are converted one by one, keyed by the sidecar itself.
    """
    failed = 0
    tracks = [track for track in info.get("subtitle_tracks", []) if track.get("supported") and not track.get("image")]
    embedded = [int(track["index"]) for track in tracks if track.get("source") != "external"]
    codecs = {int(track["index"]): str(track.get("codec")) for track in tracks}
    if embedded:
        outcomes = await extract_film_webvtt(item, config.stereo, embedded, semaphore, refresh=refresh)
        for index, (state, reason) in outcomes.items():
            if state == "cached":
                status["cached_tracks"] += 1
            elif state == "generated":
                status["generated_tracks"] += 1
            else:
                _failed(status, film, state, reason, track=index, codec=codecs.get(index))
                failed += 1
    # What a MicroDVD sidecar's frames are counted in, when it does not say itself.
    frame_rate = info.get("video_frame_rate")
    for track in tracks:
        if track.get("source") != "external":
            continue
        index = int(track["index"])
        try:
            sidecar = await asyncio.to_thread(external_subtitle_path, item, info, index)
            cache_path = await asyncio.to_thread(
                subtitle_cache_file, item, config.stereo, index, sidecar, frame_rate
            )
            if cache_path is not None and not refresh and await asyncio.to_thread(cache_path.is_file):
                status["cached_tracks"] += 1
                continue
            if refresh and cache_path is not None:
                await invalidate_subtitle_cache(item, config.stereo, index, sidecar, frame_rate)
            await extract_subtitle_webvtt(item, config.stereo, index, 0.0, semaphore, sidecar, frame_rate)
            status["generated_tracks"] += 1
        except StereoTranscodeError as exc:
            _failed(status, film, "failed", str(exc), track=index, codec=codecs.get(index))
            failed += 1
    return failed


async def _warm_pictures(
    item: ResolvedItem,
    info: dict[str, Any],
    config: AppConfig,
    status: MutableMapping[str, Any],
    semaphore: asyncio.Semaphore,
    renders: asyncio.Semaphore,
    refresh: bool,
    film: str = "",
) -> int:
    """Render the film's picture tracks — one read for all of them; how many failed.

    Text tracks and sidecars become WebVTT; picture tracks become the pictures
    the player lays over the film. Both are warmed here, because this pass is
    where the seconds are affordable — a film with a PGS track costs about half a
    minute to render, and a viewer who picks those subtitles afterwards waits for
    nothing.
    """
    pictures = [track for track in info.get("subtitle_tracks", []) if track.get("image")]
    if not pictures:
        return 0
    width, height = info.get("video_width"), info.get("video_height")
    video_size = (int(width), int(height)) if width and height else None
    results = await render_film_pictures(
        item, config.stereo, pictures, video_size,
        disk=semaphore, renders=renders, refresh=refresh, background=True,
    )
    codecs = {int(track["index"]): str(track.get("codec")) for track in pictures}
    failed = 0
    for index, result in results.items():
        if result.state == "cached":
            status["cached_tracks"] += 1
        elif result.state == "rendered":
            status["picture_tracks"] = status.get("picture_tracks", 0) + 1
            status["generated_tracks"] += 1
        elif result.state == "empty":
            # Nothing in it to draw — an empty slot, not a failure, so the film
            # can still be recorded as done.
            status["empty_tracks"] = status.get("empty_tracks", 0) + 1
        else:
            # One track that failed used to end the whole film: every track after
            # it went unrendered, run after run. It is counted and tried again
            # next run; the film goes on.
            _failed(status, film, result.state, result.error, track=index, codec=codecs.get(index))
            failed += 1
    return failed


async def warm_subtitle_cache(
    config: AppConfig,
    status: MutableMapping[str, Any],
    semaphore: asyncio.Semaphore,
    *,
    root_slug: str | None,
    item_ids: list[int],
    refresh: bool,
    renders: asyncio.Semaphore | None = None,
) -> None:
    """Walk the films and fill the subtitle cache, reading each film once.

    ``semaphore`` is this job's own hold on the disk — not the viewers': a run
    that takes hours must never be the reason somebody's subtitles wait.
    """
    rows = await asyncio.to_thread(_catalog_videos, config, root_slug, item_ids)
    # A refresh is a deliberate "do it all again", so it starts from an empty
    # record; anything else picks up where the last run stopped.
    done = {} if refresh else await asyncio.to_thread(_load_state, config)
    status.update(
        total_files=len(rows), processed_files=0, generated_tracks=0, cached_tracks=0, errors=0,
        skipped_files=0, picture_tracks=0, empty_tracks=0, recent_failures=[],
    )
    await asyncio.to_thread(sweep_stale_work, config.stereo)
    drawing = renders if renders is not None else asyncio.Semaphore(RENDER_SLOTS)
    since_save = 0

    async def one_film(root: str, relative_path: str) -> None:
        nonlocal since_save
        key = f"{root}/{relative_path}"
        try:
            item = await asyncio.to_thread(_resolved, config, root, relative_path)
            if item is None:
                # Catalogued, and gone from the disk since (or never a plain
                # file): a scan of its root retires it.
                _failed(status, key, "missing", "not on disk at its catalogued path")
                return
            if done.get(key) == _fingerprint(item):
                # Already walked, and the file has not moved since. No ffprobe.
                status["skipped_files"] += 1
                return
            status["current_file"] = item.archive_name
            try:
                async with semaphore:
                    info, problem = await probe_media_info_patiently(item, config.stereo)
                if problem is not None:
                    # Nothing embedded is known, so nothing embedded is converted
                    # — which used to pass for a film with nothing in it. Subtitle
                    # files beside the film are known regardless and still are.
                    _failed(status, key, "probe_failed", problem)
                failed = await _warm_text(item, info, config, status, semaphore, refresh, key)
                failed += await _warm_pictures(item, info, config, status, semaphore, drawing, refresh, key)
                # Only a film that got all the way through is recorded as done. One
                # with a failed track is left out so the next run tries it again,
                # and so is one whose probe failed: it listed no embedded track at
                # all, and "done" would hide them for good.
                if failed == 0 and problem is None:
                    done[key] = _fingerprint(item)
                    since_save += 1
                    if since_save >= _STATE_EVERY:
                        since_save = 0
                        # A copy: the other film in flight may add to the record
                        # while this one is being written out.
                        await asyncio.to_thread(_save_state, config, dict(done))
            except Exception as exc:
                _failed(status, key, "error", f"{type(exc).__name__}: {exc}", exc_info=True)
        finally:
            status["processed_files"] += 1

    in_flight = asyncio.Semaphore(_FILMS_IN_FLIGHT)
    running: set[asyncio.Task[None]] = set()
    try:
        for root, relative_path in rows:
            await in_flight.acquire()
            task = asyncio.create_task(one_film(root, relative_path))
            running.add(task)
            task.add_done_callback(running.discard)
            task.add_done_callback(lambda _finished: in_flight.release())
        if running:
            await asyncio.gather(*running)
    except BaseException:
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)
        raise
    await asyncio.to_thread(_save_state, config, dict(done))
    status.update(state="completed", current_file="", finished=True)
