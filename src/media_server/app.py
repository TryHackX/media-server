from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import math
import mimetypes
import re
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__
from .catalog import scan_catalog
from .config import PROJECT_ROOT, AppConfig, load_config
from .metadata_worker import run_metadata_worker
from .observability import RuntimeMetrics, sanitize_route
from .paths import PathAccessError, ResolvedItem, resolve_grant
from .probe import ffprobe_for
from .ranges import ByteRangeError, if_range_matches, make_etag, parse_single_range
from .security import TokenError, TransferGrant, open_grant
from .stats import StatsSampler, summarise
from .stereo import (
    AUDIO_PROFILE_NAMES,
    VIDEO_PROFILE_NAMES,
    CompatibleProcessRegistry,
    StereoTranscodeError,
    compatible_media_chunks,
    copies_video,
    external_subtitle_path,
    extract_subtitle_webvtt,
    probe_media_info,
    resolve_seek_plan,
)
from .streaming import content_disposition, file_chunks, last_modified
from .subtitle_jobs import warm_subtitle_cache
from .subtitle_pictures import (
    picture_cache_dir,
    picture_frame_file,
    read_picture_manifest,
    render_subtitle_pictures,
)
from .thumbnails import cached_thumbnail, generate_thumbnail, is_image
from .title_worker import run_title_lookups
from .zipstream import async_zip_chunks

LOGGER = logging.getLogger("media_server.transfer")
_SECURITY_HEADERS = (
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
)


class _SecurityAndMetricsMiddleware:
    """Pure ASGI middleware that preserves disconnect events for streamed responses."""

    def __init__(self, app: ASGIApp, metrics: RuntimeMetrics) -> None:
        self.app = app
        self.metrics = metrics

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.monotonic()
        route = sanitize_route(str(scope.get("path", "")))
        method = str(scope.get("method", "GET"))
        status = 500

        async def send_with_headers(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
                headers = list(message.get("headers", []))
                present = {name.lower() for name, _ in headers}
                headers.extend((name, value) for name, value in _SECURITY_HEADERS if name not in present)
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        except asyncio.CancelledError:
            self.metrics.record_request(499)
            LOGGER.warning(
                "request cancelled",
                extra={"event": "request_cancelled", "method": method, "route": route, "status": 499},
            )
            raise
        except Exception:
            self.metrics.record_request(500)
            LOGGER.exception(
                "request failed",
                extra={"event": "request_failed", "method": method, "route": route, "status": 500},
            )
            raise
        self.metrics.record_request(status)
        LOGGER.info(
            "request complete",
            extra={
                "event": "request_complete",
                "method": method,
                "route": route,
                "status": status,
                "duration_ms": round((time.monotonic() - started) * 1000, 3),
            },
        )




class _SubjectStreamRegistry:
    """Track distinct compatibility streams per token subject.

    A stream is one player session identified by its client-chosen stream_id;
    a seek re-uses the same stream_id and must not count twice. Entries are
    pruned lazily against the process registry, so an abandoned stream frees
    its slot as soon as its generation is superseded or reaped.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._streams: dict[str, dict[str, int]] = {}

    async def try_claim(
        self,
        subject: str,
        stream_id: str,
        generation: int,
        limit: int,
        process_registry,
    ) -> bool:
        async with self._lock:
            streams = self._streams.setdefault(subject, {})
            for other_id, other_generation in list(streams.items()):
                if other_id == stream_id:
                    continue
                if not await process_registry.is_current(other_id, other_generation):
                    del streams[other_id]
            others = sum(1 for other_id in streams if other_id != stream_id)
            if limit > 0 and others >= limit:
                if not streams:
                    del self._streams[subject]
                return False
            streams[stream_id] = generation
            return True

    async def release(self, subject: str, stream_id: str, generation: int) -> None:
        async with self._lock:
            streams = self._streams.get(subject)
            if streams is not None and streams.get(stream_id) == generation:
                del streams[stream_id]
                if not streams:
                    del self._streams[subject]


class _SubjectDownloadRegistry:
    """Count in-flight downloads (attachment files and archives) per token subject.

    The cap travels in the grant (``max_downloads``), so the transfer service can
    enforce a per-account ceiling on simultaneous downloads — protecting the
    uplink from download managers opening many segments — without a database.
    Inline playback is deliberately not counted. Single-threaded asyncio, no
    awaits inside, so no lock is needed.
    """

    def __init__(self) -> None:
        self._active: dict[str, int] = {}

    def try_acquire(self, subject: str, limit: int) -> bool:
        current = self._active.get(subject, 0)
        if limit > 0 and current >= limit:
            return False
        self._active[subject] = current + 1
        return True

    def release(self, subject: str) -> None:
        current = self._active.get(subject, 0)
        if current <= 1:
            self._active.pop(subject, None)
        else:
            self._active[subject] = current - 1

    def active(self, subject: str) -> int:
        return self._active.get(subject, 0)


class _TransferLease:
    def __init__(self, semaphore: asyncio.Semaphore, on_release: Callable[[], None] | None = None) -> None:
        self._semaphore = semaphore
        self._on_release = on_release
        self._released = False
        self._lock = asyncio.Lock()

    async def release(self) -> None:
        async with self._lock:
            if not self._released:
                self._released = True
                self._semaphore.release()
                if self._on_release is not None:
                    self._on_release()


async def _lease(
    semaphore: asyncio.Semaphore,
    timeout: float,
    on_release: Callable[[], None] | None = None,
) -> _TransferLease:
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=timeout)
    except TimeoutError as exc:
        if on_release is not None:
            on_release()
        raise HTTPException(status_code=503, detail="Serwer transferowy jest zajęty") from exc
    return _TransferLease(semaphore, on_release)


def _download_slot(
    registry: _SubjectDownloadRegistry, grant: TransferGrant
) -> Callable[[], None] | None:
    """Claim a per-subject download slot for an attachment grant, or raise 429.

    Returns the release callback to attach to the transfer lease, or None when the
    grant carries no cap (inline playback, uncapped groups, diagnostic tokens).
    """
    if grant.disposition != "attachment" or grant.max_downloads <= 0 or not grant.subject:
        return None
    subject = grant.subject
    if not registry.try_acquire(subject, grant.max_downloads):
        raise HTTPException(
            status_code=429,
            detail="Przekroczono limit równoczesnych pobrań dla tego konta",
            headers={"Retry-After": "30"},
        )
    return lambda: registry.release(subject)


def _internal_api_key(config: AppConfig) -> str:
    """Bearer secret for the internal job endpoints.

    Derived from the transfer key rather than being the key itself, so a leak of
    the ``x-media-internal-key`` header (a proxy debug log, a captured request)
    never yields the ability to forge transfer tokens. The PHP bridge derives it
    identically.
    """
    return hashlib.sha256(b"tryhackx-internal-api:" + config.security.transfer_key).hexdigest()


def _open_token(token: str, config: AppConfig) -> TransferGrant:
    try:
        return open_grant(
            token,
            key=config.security.transfer_key,
            max_ttl_seconds=config.security.max_token_ttl_seconds,
            clock_skew_seconds=config.security.clock_skew_seconds,
            max_token_bytes=config.security.max_token_bytes,
            max_archive_entries=config.transfer.max_archive_entries,
        )
    except TokenError as exc:
        raise HTTPException(status_code=403, detail="Nieprawidłowe lub wygasłe uprawnienie") from exc


def _resolve(grant: TransferGrant, config: AppConfig) -> tuple[ResolvedItem, ...]:
    try:
        return resolve_grant(grant, config.roots)
    except PathAccessError as exc:
        raise HTTPException(status_code=404, detail="Plik jest niedostępny") from exc


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    values = {part.strip() for part in header.split(",")}
    return "*" in values or etag in values


async def _leased_file_body(
    item: ResolvedItem,
    start: int,
    end: int,
    chunk_size: int,
    lease: _TransferLease,
    metrics: RuntimeMetrics,
):
    outcome = "cancelled"
    bytes_streamed = 0
    metrics.start_transfer()
    try:
        async for chunk in file_chunks(item.path, start=start, end=end, chunk_size=chunk_size):
            bytes_streamed += len(chunk)
            yield chunk
        outcome = "completed"
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except BaseException:
        outcome = "failed"
        LOGGER.exception(
            "file transfer failed",
            extra={"event": "transfer_failed", "transfer_kind": "file", "bytes_streamed": bytes_streamed},
        )
        raise
    finally:
        metrics.finish_transfer(outcome, bytes_streamed)
        LOGGER.info(
            "file transfer finished",
            extra={
                "event": "transfer_finished",
                "transfer_kind": "file",
                "outcome": outcome,
                "bytes_streamed": bytes_streamed,
            },
        )
        await lease.release()


async def _leased_zip_body(
    entries: tuple[ResolvedItem, ...],
    lease: _TransferLease,
    metrics: RuntimeMetrics,
):
    outcome = "cancelled"
    bytes_streamed = 0
    metrics.start_transfer()
    try:
        async for chunk in async_zip_chunks(entries):
            bytes_streamed += len(chunk)
            yield chunk
        outcome = "completed"
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except BaseException:
        outcome = "failed"
        LOGGER.exception(
            "archive transfer failed",
            extra={"event": "transfer_failed", "transfer_kind": "archive", "bytes_streamed": bytes_streamed},
        )
        raise
    finally:
        metrics.finish_transfer(outcome, bytes_streamed)
        LOGGER.info(
            "archive transfer finished",
            extra={
                "event": "transfer_finished",
                "transfer_kind": "archive",
                "outcome": outcome,
                "bytes_streamed": bytes_streamed,
            },
        )
        await lease.release()


async def _watch_compatible_disconnect(
    request: Request,
    process_registry: CompatibleProcessRegistry,
    stream_id: str,
    stream_generation: int,
) -> None:
    """Reap a compatibility stream whose viewer vanished.

    The body generator spends most of its life suspended inside ``yield`` while
    the server drains the socket, so it cannot notice a disconnect by itself. If
    nobody reclaims the slot here, an abandoned tab keeps FFmpeg and its transfer
    lease alive until the multi-hour timeout and later viewers are refused.
    """
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            if stream_id and await process_registry.is_current(stream_id, stream_generation):
                await process_registry.begin(stream_id)
            return


async def _leased_compatible_body(
    body,
    lease: _TransferLease,
    metrics: RuntimeMetrics,
    request: Request,
    process_registry: CompatibleProcessRegistry,
    stream_id: str,
    stream_generation: int,
    subject_streams: _SubjectStreamRegistry | None = None,
    subject: str = "",
):
    outcome = "cancelled"
    bytes_streamed = 0
    metrics.start_transfer()
    # A single reader owns ``receive`` for the life of the response.
    watchdog = asyncio.create_task(
        _watch_compatible_disconnect(request, process_registry, stream_id, stream_generation)
    )
    try:
        async for chunk in body:
            bytes_streamed += len(chunk)
            yield chunk
        else:
            outcome = "completed"
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except StereoTranscodeError:
        outcome = "failed"
        LOGGER.exception(
            "compatible media stream ended after response start",
            extra={"event": "transfer_failed", "transfer_kind": "compatible", "bytes_streamed": bytes_streamed},
        )
        if bytes_streamed == 0:
            raise
    except BaseException:
        outcome = "failed"
        LOGGER.exception(
            "compatible media stream failed",
            extra={"event": "transfer_failed", "transfer_kind": "compatible", "bytes_streamed": bytes_streamed},
        )
        raise
    finally:
        if not watchdog.done():
            watchdog.cancel()
        await asyncio.gather(watchdog, return_exceptions=True)
        close = getattr(body, "aclose", None)
        if close is not None:
            await close()
        if stream_id:
            await process_registry.discard_lease(stream_id, stream_generation, lease)
        if subject_streams is not None:
            await subject_streams.release(subject, stream_id, stream_generation)
        metrics.finish_transfer(outcome, bytes_streamed)
        LOGGER.info(
            "compatible media stream finished",
            extra={
                "event": "transfer_finished",
                "transfer_kind": "compatible",
                "outcome": outcome,
                "bytes_streamed": bytes_streamed,
            },
        )
        await lease.release()

def create_app(config: AppConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        # The diary starts with the service and stops with it. Sampling happens
        # off the event loop: one walk of the thumbnail cache takes seconds, and
        # a request being served must not wait behind it.
        async def record_stats() -> None:
            sampler = application.state.stats_sampler
            while True:
                await asyncio.sleep(sampler.interval_seconds)
                try:
                    snapshot = application.state.metrics.snapshot(
                        max_concurrent_transfers=config.transfer.max_concurrent_transfers
                    )
                    row = await asyncio.to_thread(sampler.sample, snapshot)
                    await asyncio.to_thread(sampler.append, row)
                except Exception:  # noqa: BLE001 - a diary must not stop the server
                    LOGGER.warning("stats sample failed", exc_info=True)

        stats_task = asyncio.create_task(record_stats(), name="stats-sampler")
        application.state.stats_task = stats_task
        yield
        stats_task.cancel()
        await asyncio.gather(stats_task, return_exceptions=True)
        subtitle_task = application.state.subtitle_cache_task
        if subtitle_task is not None and not subtitle_task.done():
            subtitle_task.cancel()
            await asyncio.gather(subtitle_task, return_exceptions=True)
        # A render owns an FFmpeg process and a directory of pictures; left to
        # itself on shutdown it would leave both behind.
        reading = [task for task in application.state.picture_jobs.values() if not task.done()]
        for task in reading:
            task.cancel()
        if reading:
            await asyncio.gather(*reading, return_exceptions=True)
        await application.state.compatible_processes.close_all()

    app = FastAPI(
        title="TryHackX Media Transfer",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.transfer_semaphore = asyncio.Semaphore(config.transfer.max_concurrent_transfers)
    app.state.stereo_semaphore = asyncio.Semaphore(config.stereo.max_concurrent_jobs)
    app.state.subtitle_semaphore = asyncio.Semaphore(1)
    app.state.compatible_processes = CompatibleProcessRegistry()
    app.state.subject_streams = _SubjectStreamRegistry()
    app.state.subject_downloads = _SubjectDownloadRegistry()
    app.state.thumbnail_semaphore = asyncio.Semaphore(2)
    app.state.metrics = RuntimeMetrics()
    # One line a minute about what the server did, kept beside the caches it
    # measures. The service is the only thing that knows these numbers and the
    # only thing running all the time, so it is the only thing that can.
    app.state.stats_sampler = StatsSampler(
        path=PROJECT_ROOT / "runtime" / "stats" / "history.jsonl",
        caches={
            "thumbnails": config.thumbnails.cache_path,
            "subtitles": config.stereo.subtitle_cache_path,
            "filmweb": PROJECT_ROOT / "runtime" / "filmweb-cache",
        },
    )
    app.state.stats_task = None
    app.state.catalog_scan_tasks = {}
    app.state.metadata_worker_task = None
    app.state.title_worker_task = None
    app.state.subtitle_cache_task = None
    # One render per track at a time, keyed by film and track: a viewer who
    # clicks the same subtitles twice must not start the work twice.
    app.state.picture_jobs = {}
    app.state.subtitle_cache_status = {
        "state": "idle", "finished": True, "total_files": 0, "processed_files": 0,
        "generated_tracks": 0, "cached_tracks": 0, "skipped_files": 0, "errors": 0, "current_file": "",
        "picture_tracks": 0,
    }

    app.add_middleware(_SecurityAndMetricsMiddleware, metrics=app.state.metrics)

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready() -> Response:
        failed: list[str] = []
        for root_id, path in config.roots.items():
            try:
                if not path.resolve(strict=True).is_dir():
                    failed.append(root_id)
            except OSError:
                failed.append(root_id)
        status = 200 if not failed else 503
        return JSONResponse({"status": "ready" if not failed else "not_ready", "unavailable_roots": failed}, status)

    @app.get("/health/status")
    async def operational_status() -> Response:
        return JSONResponse(
            app.state.metrics.snapshot(max_concurrent_transfers=config.transfer.max_concurrent_transfers),
            headers={"Cache-Control": "no-store"},
        )
    def finish_catalog_scan(root_slug: str, task: asyncio.Task) -> None:
        active = app.state.catalog_scan_tasks.get(root_slug)
        if active is task:
            app.state.catalog_scan_tasks.pop(root_slug, None)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            LOGGER.error(
                "catalog scan failed",
                extra={"event": "catalog_scan_failed", "root": root_slug, "error": str(error)},
            )

    def finish_metadata_worker(task: asyncio.Task) -> None:
        if app.state.metadata_worker_task is task:
            app.state.metadata_worker_task = None

    def finish_title_worker(task: asyncio.Task) -> None:
        if app.state.title_worker_task is task:
            app.state.title_worker_task = None
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            LOGGER.error(
                "metadata worker failed",
                extra={"event": "metadata_worker_failed", "error": str(error)},
            )

    @app.post("/v1/catalog-scan")
    async def start_catalog_scan(request: Request) -> Response:
        supplied_key = request.headers.get("x-media-internal-key", "")
        if not hmac.compare_digest(supplied_key, _internal_api_key(config)):
            raise HTTPException(status_code=403, detail="Forbidden")
        content_length = request.headers.get("content-length")
        if content_length and (not content_length.isdigit() or int(content_length) > 1024):
            raise HTTPException(status_code=413, detail="Request too large")
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid request") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="Invalid request")
        root_slug = payload.get("root")
        root_kind = payload.get("kind")
        if not isinstance(root_slug, str) or root_slug not in config.roots:
            raise HTTPException(status_code=422, detail="Unknown catalog root")
        if root_kind not in {"music", "movies", "mixed"}:
            raise HTTPException(status_code=422, detail="Invalid catalog kind")
        # Optional tuning mirrors the CLI flags; mass-missing override stays CLI-only
        # on purpose (it needs a human looking at the dry-run report first).
        batch_size = payload.get("batch_size", 500)
        if not isinstance(batch_size, int) or isinstance(batch_size, bool) or not 10 <= batch_size <= 5000:
            raise HTTPException(status_code=422, detail="Invalid batch size")
        # Film roots used to opt out because nothing could read a video; ffprobe
        # now fills duration, resolution and codecs, so both kinds queue by default.
        metadata_enabled = payload.get("metadata", True)
        if not isinstance(metadata_enabled, bool):
            raise HTTPException(status_code=422, detail="Invalid metadata flag")
        current = app.state.catalog_scan_tasks.get(root_slug)
        if current is not None and not current.done():
            return JSONResponse({"status": "already_running", "root": root_slug}, status_code=409)

        async def run() -> None:
            await asyncio.to_thread(
                scan_catalog,
                database=config.database,
                root_slug=root_slug,
                root_path=config.roots[root_slug],
                root_kind=root_kind,
                apply=True,
                metadata_enabled=metadata_enabled,
                batch_size=batch_size,
                allow_mass_missing=False,
            )

        task = asyncio.create_task(run(), name=f"catalog-scan:{root_slug}")
        app.state.catalog_scan_tasks[root_slug] = task
        task.add_done_callback(lambda completed: finish_catalog_scan(root_slug, completed))
        return JSONResponse({"status": "started", "root": root_slug}, status_code=202)

    @app.post("/v1/metadata-worker")
    async def start_metadata_worker(request: Request) -> Response:
        """
        Drain a batch of the metadata queue.

        The worker used to be reachable only from a shell, so files queued by a
        scan sat there until somebody remembered. It runs in a thread and takes
        one batch per call; the panel repeats the call while the queue shrinks.
        """
        supplied_key = request.headers.get("x-media-internal-key", "")
        if not hmac.compare_digest(supplied_key, _internal_api_key(config)):
            raise HTTPException(status_code=403, detail="Forbidden")
        content_length = request.headers.get("content-length")
        if content_length and (not content_length.isdigit() or int(content_length) > 1024):
            raise HTTPException(status_code=413, detail="Request too large")
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid request") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="Invalid request")
        limit = payload.get("limit", 200)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5000:
            raise HTTPException(status_code=422, detail="Invalid batch size")
        current = app.state.metadata_worker_task
        if current is not None and not current.done():
            return JSONResponse({"status": "already_running"}, status_code=409)

        async def run() -> None:
            await asyncio.to_thread(
                run_metadata_worker,
                database=config.database,
                roots=config.roots,
                limit=limit,
                timeout_seconds=30.0,
                ffprobe_path=ffprobe_for(config.stereo.ffmpeg_path),
            )

        task = asyncio.create_task(run(), name="metadata-worker")
        app.state.metadata_worker_task = task
        task.add_done_callback(finish_metadata_worker)
        return JSONResponse({"status": "started", "limit": limit}, status_code=202)

    @app.post("/v1/title-worker")
    async def start_title_worker(request: Request) -> Response:
        """
        Look up genre and release year for a batch of films and series.

        A batch at a time, from the panel, for the same reason the metadata
        worker works that way: the queue is a couple of thousand works long, it
        talks to somebody else's server one request at a time, and an operator
        who can see it move can also decide to stop it.
        """
        supplied_key = request.headers.get("x-media-internal-key", "")
        if not hmac.compare_digest(supplied_key, _internal_api_key(config)):
            raise HTTPException(status_code=403, detail="Forbidden")
        content_length = request.headers.get("content-length")
        if content_length and (not content_length.isdigit() or int(content_length) > 1024):
            raise HTTPException(status_code=413, detail="Request too large")
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid request") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="Invalid request")
        limit = payload.get("limit", 50)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5000:
            raise HTTPException(status_code=422, detail="Invalid batch size")
        root_slug = payload.get("root", "movies")
        if not isinstance(root_slug, str) or root_slug not in config.roots:
            raise HTTPException(status_code=422, detail="Unknown root")
        current = app.state.title_worker_task
        if current is not None and not current.done():
            return JSONResponse({"status": "already_running"}, status_code=409)

        async def run() -> None:
            await asyncio.to_thread(
                run_title_lookups,
                database=config.database,
                root_slug=root_slug,
                cache_path=PROJECT_ROOT / "runtime" / "filmweb-cache",
                limit=limit,
            )

        task = asyncio.create_task(run(), name="title-worker")
        app.state.title_worker_task = task
        task.add_done_callback(finish_title_worker)
        return JSONResponse({"status": "started", "limit": limit}, status_code=202)

    @app.post("/v1/stats")
    async def operational_history(request: Request) -> Response:
        """The diary, for the panel that draws it.

        Behind the internal key like every other job route: the file says when
        the house was busy and how much went out of it, which is nobody's
        business but the operator's. Reading it is I/O over a megabyte, so it
        happens off the event loop.
        """
        supplied_key = request.headers.get("x-media-internal-key", "")
        if not hmac.compare_digest(supplied_key, _internal_api_key(config)):
            raise HTTPException(status_code=403, detail="Forbidden")
        try:
            payload = await request.json()
        except ValueError:
            payload = {}
        hours_raw = payload.get("hours", 24) if isinstance(payload, dict) else 24
        hours = hours_raw if isinstance(hours_raw, int) and not isinstance(hours_raw, bool) else 24
        hours = max(1, min(24 * 30, hours))
        sampler = app.state.stats_sampler
        samples = await asyncio.to_thread(sampler.history, hours)
        return JSONResponse(
            {
                "hours": hours,
                "interval_seconds": sampler.interval_seconds,
                "current": app.state.metrics.snapshot(
                    max_concurrent_transfers=config.transfer.max_concurrent_transfers
                ),
                # The newest sample carries the last cache measurement; the panel
                # should not have to dig through the series to find it.
                "cache": samples[-1].get("cache", {}) if samples else {},
                "totals": summarise(samples),
                "samples": samples,
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/v1/subtitle-cache")
    async def subtitle_cache_job(request: Request) -> Response:
        supplied_key = request.headers.get("x-media-internal-key", "")
        if not hmac.compare_digest(supplied_key, _internal_api_key(config)):
            raise HTTPException(status_code=403, detail="Forbidden")
        content_length = request.headers.get("content-length")
        if content_length and (not content_length.isdigit() or int(content_length) > 16384):
            raise HTTPException(status_code=413, detail="Request too large")
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid request") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="Invalid request")
        operation = payload.get("operation", "status")
        if operation == "status":
            return JSONResponse(dict(app.state.subtitle_cache_status), headers={"Cache-Control": "no-store"})
        if operation != "start":
            raise HTTPException(status_code=422, detail="Invalid operation")
        root_raw = payload.get("root", "all")
        mode = payload.get("mode", "missing")
        item_ids_raw = payload.get("media_item_ids", [])
        if root_raw != "all" and (not isinstance(root_raw, str) or root_raw not in config.roots):
            raise HTTPException(status_code=422, detail="Unknown catalog root")
        if mode not in {"missing", "refresh"}:
            raise HTTPException(status_code=422, detail="Invalid cache mode")
        if not isinstance(item_ids_raw, list) or len(item_ids_raw) > 500 or any(
            not isinstance(item_id, int) or isinstance(item_id, bool) or item_id < 1 for item_id in item_ids_raw
        ):
            raise HTTPException(status_code=422, detail="Invalid media item identifiers")
        running = app.state.subtitle_cache_task
        if running is not None and not running.done():
            return JSONResponse(dict(app.state.subtitle_cache_status), status_code=409)
        status = {
            "state": "running", "finished": False, "total_files": 0, "processed_files": 0,
            "generated_tracks": 0, "cached_tracks": 0, "skipped_files": 0, "errors": 0, "current_file": "",
            "picture_tracks": 0, "root": root_raw, "mode": mode,
        }
        app.state.subtitle_cache_status = status

        async def run() -> None:
            try:
                await warm_subtitle_cache(
                    config, status, app.state.subtitle_semaphore,
                    root_slug=None if root_raw == "all" else root_raw,
                    item_ids=list(dict.fromkeys(item_ids_raw)),
                    refresh=mode == "refresh",
                )
            except asyncio.CancelledError:
                status.update(state="cancelled", finished=True, current_file="")
                raise
            except Exception:
                status.update(state="failed", finished=True, current_file="", errors=int(status["errors"]) + 1)
                LOGGER.exception("subtitle cache job failed", extra={"event": "subtitle_cache_failed"})

        task = asyncio.create_task(run(), name="subtitle-cache")
        app.state.subtitle_cache_task = task
        return JSONResponse(dict(status), status_code=202)



    async def resolved_file_response(
        item: ResolvedItem,
        request: Request,
        *,
        disposition: str,
        download_name: str,
        cache_control: str = "private, max-age=0, must-revalidate",
        grant: TransferGrant | None = None,
    ) -> Response:
        etag = make_etag(item.path, item.size, item.mtime_ns)
        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": cache_control,
            "Content-Disposition": content_disposition(disposition, download_name),
            "ETag": etag,
            "Last-Modified": last_modified(item.mtime_ns),
        }
        if _etag_matches(request.headers.get("if-none-match"), etag) and not request.headers.get("range"):
            return Response(status_code=304, headers=headers)

        range_header = request.headers.get("range")
        if range_header and not if_range_matches(request.headers.get("if-range"), etag, item.mtime_ns):
            range_header = None
        try:
            selected_range = parse_single_range(range_header, item.size)
        except ByteRangeError as exc:
            return Response(status_code=416, headers={**headers, "Content-Range": exc.content_range})

        start, end = (0, item.size - 1) if selected_range is None else selected_range
        status = 200 if selected_range is None else 206
        headers["Content-Length"] = str(max(0, end - start + 1))
        if selected_range is not None:
            headers["Content-Range"] = f"bytes {start}-{end}/{item.size}"
        media_type = mimetypes.guess_type(item.path.name)[0] or "application/octet-stream"
        if request.method == "HEAD":
            return Response(status_code=status, headers=headers, media_type=media_type)

        # The per-account download slot is claimed before the global semaphore, so a
        # caller over its own cap is refused at once instead of queueing for a slot.
        release_slot = None if grant is None else _download_slot(app.state.subject_downloads, grant)
        lease = await _lease(app.state.transfer_semaphore, config.transfer.queue_timeout_seconds, release_slot)
        return StreamingResponse(
            _leased_file_body(item, start, end, config.transfer.chunk_size, lease, app.state.metrics),
            status_code=status,
            headers=headers,
            media_type=media_type,
            background=BackgroundTask(lease.release),
        )

    async def file_response(token: str, request: Request) -> Response:
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        item = _resolve(grant, config)[0]
        return await resolved_file_response(
            item,
            request,
            disposition=grant.disposition,
            download_name=grant.download_name,
            grant=grant,
        )
    @app.api_route("/v1/files/{token}", methods=["GET", "HEAD"])
    async def download_file(token: str, request: Request) -> Response:
        return await file_response(token, request)

    @app.api_route("/v1/thumbnails/{token}", methods=["GET", "HEAD"])
    async def download_thumbnail(token: str, request: Request) -> Response:
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        target = source if is_image(source) else cached_thumbnail(source, config.thumbnails)
        if target is None and request.method != "HEAD":
            target = await generate_thumbnail(
                source,
                config.thumbnails,
                config.stereo.ffmpeg_path,
                app.state.thumbnail_semaphore,
            )
        if target is None:
            return Response(
                status_code=204,
                headers={"Cache-Control": "private, max-age=86400", "X-Thumbnail-Available": "no"},
            )
        return await resolved_file_response(
            target,
            request,
            disposition="inline",
            download_name=target.path.name,
            cache_control="private, max-age=3600, must-revalidate",
        )

    @app.get("/v1/stereo-info/{token}")
    async def compatible_stereo_info(token: str) -> Response:
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        if config.stereo.ffmpeg_path is None:
            raise HTTPException(status_code=503, detail="Compatibility mode is not configured")
        return JSONResponse(
            await probe_media_info(source, config.stereo),
            headers={"Cache-Control": "private, no-store"},
        )

    @app.get("/v1/stereo-keyframe/{token}")
    async def compatible_keyframe(token: str, request: Request) -> Response:
        """Tell the player where a copied picture can actually start.

        The browser cannot read response headers from a media element, so it asks
        here first and then requests that exact position.
        """
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        if config.stereo.ffmpeg_path is None:
            raise HTTPException(status_code=503, detail="Compatibility mode is not configured")
        video_profile = request.query_params.get("video_profile", "native_copy")
        if video_profile not in VIDEO_PROFILE_NAMES:
            raise HTTPException(status_code=422, detail="Invalid video profile")
        try:
            start_seconds = float(request.query_params.get("start_seconds", "0"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid start position") from exc
        if not math.isfinite(start_seconds) or not 0 <= start_seconds <= 604800:
            raise HTTPException(status_code=422, detail="Invalid start position")
        media_info = await probe_media_info(source, config.stereo)
        video_codec = media_info.get("video_codec")
        seek_seconds = start_seconds
        resolved = start_seconds
        if start_seconds > 0 and copies_video(video_codec if isinstance(video_codec, str) else None, video_profile):
            seek_seconds, resolved = await resolve_seek_plan(
                source, config.stereo, start_seconds, media_info.get("duration_seconds")
            )
        # ``seek_seconds`` must be replayed verbatim on the stream request. Seeking
        # to ``start_seconds`` instead would step back to the previous index point.
        return JSONResponse(
            {
                "requested_seconds": start_seconds,
                "seek_seconds": seek_seconds,
                "start_seconds": resolved,
            },
            headers={"Cache-Control": "private, max-age=300"},
        )

    def _picture_track(media_info: dict[str, Any], subtitle_track: int) -> dict[str, Any] | None:
        return next(
            (
                track
                for track in media_info.get("subtitle_tracks", [])
                if int(track.get("index", -1)) == subtitle_track and track.get("image")
            ),
            None,
        )

    def _video_size(media_info: dict[str, Any]) -> tuple[int, int] | None:
        width, height = media_info.get("video_width"), media_info.get("video_height")
        return (int(width), int(height)) if width and height else None

    @app.get("/v1/subtitle-pictures/{token}")
    async def compatible_subtitle_pictures(token: str, request: Request) -> Response:
        """When each cue of a picture subtitle appears, and what to fetch for it.

        The pictures are the subtitle — no reading, no guessing, nothing to
        install. Rendering a whole track takes tens of seconds, so the first
        request answers 202 and starts it; the player asks again.
        """
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        if config.stereo.ffmpeg_path is None:
            raise HTTPException(status_code=503, detail="Compatibility mode is not configured")
        try:
            subtitle_track = int(request.query_params.get("subtitle_track", "-1"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid subtitle track") from exc
        if not 0 <= subtitle_track <= 63:
            raise HTTPException(status_code=422, detail="Invalid subtitle track")
        media_info = await probe_media_info(source, config.stereo)
        track = _picture_track(media_info, subtitle_track)
        if track is None:
            raise HTTPException(status_code=422, detail="Subtitle track is not a picture track")
        directory = picture_cache_dir(source, config.stereo, subtitle_track)
        manifest = await asyncio.to_thread(read_picture_manifest, directory)
        if manifest is not None:
            return JSONResponse(manifest, headers={"Cache-Control": "private, max-age=3600"})
        key = f"pictures\0{source.path}\0{source.mtime_ns}\0{subtitle_track}"
        running = app.state.picture_jobs.get(key)
        if running is None or running.done():
            size = _video_size(media_info)

            async def render() -> None:
                try:
                    await render_subtitle_pictures(
                        source, config.stereo, subtitle_track, size, app.state.subtitle_semaphore, track
                    )
                except (StereoTranscodeError, OSError):
                    LOGGER.warning(
                        "subtitle picture render failed",
                        extra={"event": "subtitle_pictures_failed", "track": subtitle_track},
                    )
                finally:
                    app.state.picture_jobs.pop(key, None)

            app.state.picture_jobs[key] = asyncio.create_task(render(), name="subtitle-pictures")
        return JSONResponse(
            {"status": "rendering", "subtitle_track": subtitle_track},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/v1/subtitle-picture/{token}")
    async def compatible_subtitle_picture(token: str, request: Request) -> Response:
        """One rendered cue. Named by the manifest, never by the caller's spelling."""
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        try:
            subtitle_track = int(request.query_params.get("subtitle_track", "-1"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid subtitle track") from exc
        frame = request.query_params.get("frame", "")
        if not 0 <= subtitle_track <= 63 or re.fullmatch(r"\d{6}", frame) is None:
            raise HTTPException(status_code=422, detail="Invalid subtitle picture")
        directory = picture_cache_dir(source, config.stereo, subtitle_track)
        manifest = await asyncio.to_thread(read_picture_manifest, directory)
        if manifest is None:
            raise HTTPException(status_code=404, detail="Subtitle pictures are not rendered")
        image = picture_frame_file(directory, manifest, frame)
        if image is None:
            raise HTTPException(status_code=404, detail="No such subtitle picture")
        payload = await asyncio.to_thread(image.read_bytes)
        return Response(
            payload,
            media_type="image/png",
            # The picture belongs to one rendered track and never changes; the
            # cache key already carries the film's own timestamp.
            headers={"Cache-Control": "private, max-age=86400, immutable"},
        )

    @app.get("/v1/subtitles/{token}")
    async def compatible_subtitles(token: str, request: Request) -> Response:
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        if config.stereo.ffmpeg_path is None:
            raise HTTPException(status_code=503, detail="Compatibility mode is not configured")
        track_raw = request.query_params.get("subtitle_track", "-1")
        start_raw = request.query_params.get("start_seconds", "0")
        try:
            subtitle_track = int(track_raw)
            start_seconds = float(start_raw)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid subtitle parameters") from exc
        if not 0 <= subtitle_track <= 63:
            raise HTTPException(status_code=422, detail="Invalid subtitle track")
        if not math.isfinite(start_seconds) or not 0 <= start_seconds <= 604800:
            raise HTTPException(status_code=422, detail="Invalid start position")
        media_info = await probe_media_info(source, config.stereo)
        tracks = media_info.get("subtitle_tracks", [])
        # A picture subtitle is a different question, answered by
        # /v1/subtitle-pictures: there is no text here to hand over.
        if subtitle_track not in {int(track["index"]) for track in tracks if track.get("supported")}:
            raise HTTPException(status_code=422, detail="Subtitle track cannot be converted")
        # A sidecar file is found by the server from the film's own directory; the
        # client only ever names a track by number, so no request can point this
        # at a file of its choosing.
        sidecar = external_subtitle_path(source, media_info, subtitle_track)
        try:
            payload = await extract_subtitle_webvtt(
                source, config.stereo, subtitle_track, start_seconds, app.state.subtitle_semaphore, sidecar
            )
        except StereoTranscodeError as exc:
            raise HTTPException(status_code=422, detail="Subtitle conversion failed") from exc
        return Response(
            payload,
            media_type="text/vtt",
            headers={"Cache-Control": "private, max-age=3600, must-revalidate"},
        )

    @app.api_route("/v1/stereo/{token}", methods=["GET", "HEAD", "DELETE"])
    async def compatible_stereo(token: str, request: Request) -> Response:
        grant = _open_token(token, config)
        if grant.kind != "file":
            raise HTTPException(status_code=403, detail="Invalid grant type")
        source = _resolve(grant, config)[0]
        if config.stereo.ffmpeg_path is None:
            raise HTTPException(status_code=503, detail="Compatibility mode is not configured")
        start_raw = request.query_params.get("start_seconds", "0")
        audio_raw = request.query_params.get("audio_track", "0")
        subtitle_raw = request.query_params.get("subtitle_track", "-1")
        audio_profile = request.query_params.get("audio_profile", "stereo_standard")
        video_profile = request.query_params.get("video_profile", "native_copy")
        stream_id = request.query_params.get("stream_id", "")
        try:
            start_seconds = float(start_raw)
            audio_track = int(audio_raw)
            subtitle_track = int(subtitle_raw)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid compatibility stream parameters") from exc
        if not math.isfinite(start_seconds) or not 0 <= start_seconds <= 604800:
            raise HTTPException(status_code=422, detail="Invalid start position")
        if not 0 <= audio_track <= 31 or not -1 <= subtitle_track <= 63:
            raise HTTPException(status_code=422, detail="Invalid media track")
        if audio_profile not in AUDIO_PROFILE_NAMES:
            raise HTTPException(status_code=422, detail="Invalid audio profile")
        if video_profile not in VIDEO_PROFILE_NAMES:
            raise HTTPException(status_code=422, detail="Invalid video profile")
        if stream_id and re.fullmatch(r"[A-Za-z0-9_-]{8,80}", stream_id) is None:
            raise HTTPException(status_code=422, detail="Invalid stream identifier")
        # A subject-capped grant must carry a stream_id, otherwise the per-account
        # limit below is silently skipped and the cap is trivially bypassed.
        if request.method != "DELETE" and grant.subject and grant.max_streams > 0 and not stream_id:
            raise HTTPException(status_code=422, detail="Stream identifier is required")
        # Namespace the id the process registry keys on by the token subject, so a
        # DELETE (or a superseding seek) can only ever reach the caller's own
        # streams even though the client chooses the raw stream_id. The separator
        # cannot occur in a validated stream_id, so the mapping stays unique.
        if stream_id and grant.subject:
            stream_id = f"{grant.subject}\x1f{stream_id}"
        if request.method == "DELETE":
            if not stream_id:
                raise HTTPException(status_code=422, detail="Stream identifier is required")
            await app.state.compatible_processes.begin(stream_id)
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        headers = {
            "Cache-Control": "no-store",
            "Content-Disposition": content_disposition("inline", f"{source.path.stem}.compatible.mp4"),
            "X-Compatible-Requested-Seconds": f"{start_seconds:.3f}",
            "X-Compatible-Audio-Track": str(audio_track),
            "X-Compatible-Subtitle-Track": str(subtitle_track),
            "X-Compatible-Audio-Profile": audio_profile,
            "X-Compatible-Video-Profile": video_profile,
        }
        media_info = await probe_media_info(source, config.stereo)
        if request.method == "HEAD":
            duration = media_info["duration_seconds"]
            if duration is not None:
                headers["X-Media-Duration-Seconds"] = f"{duration:.3f}"
            headers["X-Compatible-Start-Seconds"] = f"{start_seconds:.3f}"
            return Response(status_code=200, headers=headers, media_type="video/mp4")
        video_codec = media_info.get("video_codec")
        # ``start_seconds`` is the seek request itself and is passed to FFmpeg
        # untouched; the player already asked where it lands. Re-snapping here
        # would move the picture without the player's timeline following it.
        landing = start_seconds
        if start_seconds > 0 and copies_video(video_codec if isinstance(video_codec, str) else None, video_profile):
            _, landing = await resolve_seek_plan(
                source, config.stereo, start_seconds, media_info.get("duration_seconds")
            )
        headers["X-Compatible-Start-Seconds"] = f"{landing:.3f}"
        headers["Access-Control-Expose-Headers"] = "X-Compatible-Start-Seconds, X-Compatible-Requested-Seconds"
        stream_generation = await app.state.compatible_processes.begin(stream_id) if stream_id else 0
        # The per-group cap sealed into the token counts distinct player
        # sessions per account; a seek re-uses its stream_id and stays free.
        enforce_subject_limit = bool(grant.subject) and grant.max_streams > 0 and bool(stream_id)
        if enforce_subject_limit and not await app.state.subject_streams.try_claim(
            grant.subject or "",
            stream_id,
            stream_generation,
            grant.max_streams,
            app.state.compatible_processes,
        ):
            raise HTTPException(
                status_code=429,
                detail="Przekroczono limit równoczesnych strumieni dla konta",
            )
        try:
            lease = await _lease(app.state.stereo_semaphore, config.transfer.queue_timeout_seconds)
        except HTTPException:
            if enforce_subject_limit:
                await app.state.subject_streams.release(grant.subject or "", stream_id, stream_generation)
            raise
        if stream_id and not await app.state.compatible_processes.bind_lease(stream_id, stream_generation, lease):
            await lease.release()
            if enforce_subject_limit:
                await app.state.subject_streams.release(grant.subject or "", stream_id, stream_generation)
            raise HTTPException(status_code=409, detail="Compatibility stream was superseded")
        raw_body = compatible_media_chunks(
            source,
            config.stereo,
            config.transfer.chunk_size,
            start_seconds,
            audio_track,
            subtitle_track,
            video_codec if isinstance(video_codec, str) else None,
            audio_profile,
            video_profile,
            stream_id,
            stream_generation,
            app.state.compatible_processes,
        )
        try:
            first_chunk = await anext(raw_body)
        except (StopAsyncIteration, StereoTranscodeError) as exc:
            await raw_body.aclose()
            if stream_id:
                await app.state.compatible_processes.discard_lease(stream_id, stream_generation, lease)
            await lease.release()
            if enforce_subject_limit:
                await app.state.subject_streams.release(grant.subject or "", stream_id, stream_generation)
            LOGGER.exception(
                "compatible media stream failed before response start",
                extra={"event": "transfer_failed", "transfer_kind": "compatible", "bytes_streamed": 0},
            )
            raise HTTPException(status_code=503, detail="Compatibility stream could not start") from exc

        async def prepared_body():
            try:
                yield first_chunk
                async for chunk in raw_body:
                    yield chunk
            finally:
                await raw_body.aclose()

        return StreamingResponse(
            _leased_compatible_body(
                prepared_body(),
                lease,
                app.state.metrics,
                request,
                app.state.compatible_processes,
                stream_id,
                stream_generation,
                app.state.subject_streams if enforce_subject_limit else None,
                grant.subject or "",
            ),
            status_code=200,
            headers=headers,
            media_type="video/mp4",
        )
    async def archive_response(token: str, request: Request) -> Response:
        grant = _open_token(token, config)
        if grant.kind != "archive":
            raise HTTPException(status_code=403, detail="Nieprawidłowy rodzaj uprawnienia")
        entries = _resolve(grant, config)
        headers = {
            "Accept-Ranges": "none",
            "Cache-Control": "private, no-store",
            "Content-Disposition": content_disposition("attachment", grant.download_name),
            "X-Archive-Entries": str(len(entries)),
        }
        if request.method == "HEAD":
            return Response(status_code=200, headers=headers, media_type="application/zip")
        release_slot = _download_slot(app.state.subject_downloads, grant)
        lease = await _lease(app.state.transfer_semaphore, config.transfer.queue_timeout_seconds, release_slot)
        return StreamingResponse(
            _leased_zip_body(entries, lease, app.state.metrics),
            headers=headers,
            media_type="application/zip",
            background=BackgroundTask(lease.release),
        )

    @app.api_route("/v1/archives/{token}", methods=["GET", "HEAD"])
    async def download_archive(token: str, request: Request) -> Response:
        return await archive_response(token, request)

    @app.post("/v1/archives")
    async def download_archive_form(request: Request) -> Response:
        limit = config.security.max_token_bytes + 1024
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > limit:
                    raise HTTPException(status_code=413, detail="Żądanie jest zbyt duże")
            except ValueError as exc:
                raise HTTPException(status_code=413, detail="Żądanie jest zbyt duże") from exc
        # Read the body incrementally and abort as soon as the cap is exceeded,
        # so a chunked request with no Content-Length (which the header check
        # cannot bound) cannot buffer unbounded bytes into memory before the check.
        chunks: list[bytes] = []
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > limit:
                raise HTTPException(status_code=413, detail="Żądanie jest zbyt duże")
            chunks.append(chunk)
        body = b"".join(chunks)
        try:
            values = parse_qs(body.decode("ascii"), keep_blank_values=True, strict_parsing=True)
            token = values["token"][0]
        except (UnicodeDecodeError, ValueError, KeyError, IndexError) as exc:
            raise HTTPException(status_code=400, detail="Brak uprawnienia transferowego") from exc
        return await archive_response(token, request)

    return app


def application_factory() -> FastAPI:
    return create_app(load_config())
