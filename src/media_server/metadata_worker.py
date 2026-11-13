from __future__ import annotations

import json
import multiprocessing
import time
from pathlib import Path
from typing import Any, Mapping

import pymysql

from .config import DatabaseConfig
from .database import connect_rows as _connect
from .metadata import read_audio_metadata, release_year
from .paths import PathAccessError, resolve_item
from .probe import ProbeError, read_media_probe
from .security import GrantItem


class MetadataWorkerError(RuntimeError):
    pass


# Files one parser process reads before a fresh one takes over. A process per file
# cost a Python start and ~0.3 s of imports for every track — about 1.5 hours for
# this library's 12,800 tracks on Windows, where a child is started, not forked —
# while reading the tags themselves takes milliseconds. A fresh process now and
# then keeps anything a parser leaks from piling up.
_FILES_PER_PARSER = 2000
# How long a fresh parser may take to say it is ready. Not charged to any file: on a
# busy machine a Python start alone can take seconds, and the file waiting for it
# has done nothing wrong.
_PARSER_START_SECONDS = 60.0
# How often a wait for an answer also checks that the parser is still alive.
_PARSER_POLL_SECONDS = 0.25
_TIMED_OUT = object()
_GONE = object()


def _read_one(path: str) -> tuple[str, dict[str, Any] | str]:
    try:
        metadata = read_audio_metadata(Path(path))
    except Exception as exc:  # noqa: BLE001 - whatever a damaged file makes the parser raise is that file's error
        return "error", f"{type(exc).__name__}: {exc}"[:4000]
    return "ok", {
        "title": metadata.title,
        "artist": metadata.artist,
        "album": metadata.album,
        "duration_ms": metadata.duration_ms,
        "technical": metadata.technical,
    }


def _metadata_child(connection: Any) -> None:
    """The parser process: read each path it is sent, one at a time, until told to stop."""
    connection.send(("ready", None))
    while True:
        try:
            path = connection.recv()
        except EOFError:
            return
        if path is None:
            return
        connection.send(_read_one(path))


class _MetadataReader:
    """Audio tags read in a child process that serves a whole batch, not one file.

    The child is there for isolation: a damaged file that sends the parser into a
    loop, or takes the interpreter down with it, takes only that child. The file
    is reported — a timeout, or an error with the exit code — and the next file
    goes to a fresh child, so the rest of the batch goes on as before.
    """

    def __init__(
        self,
        timeout_seconds: float,
        *,
        child_target: Any = _metadata_child,
        files_per_process: int = _FILES_PER_PARSER,
        start_seconds: float = _PARSER_START_SECONDS,
    ) -> None:
        self._timeout = timeout_seconds
        self._target = child_target
        self._files_per_process = max(1, files_per_process)
        self._start_seconds = start_seconds
        self._process: Any = None
        self._connection: Any = None
        self._served = 0
        self.processes_started = 0

    def __enter__(self) -> _MetadataReader:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._stop(grace=5.0, ask=True)

    def read(self, path: Path) -> tuple[str, dict[str, Any] | str]:
        if self._process is not None and (self._served >= self._files_per_process or not self._process.is_alive()):
            self._stop(grace=5.0, ask=True)
        # A child that died between two files would take the next one down with it
        # for nothing it did: such a send is retried once, in a fresh child.
        for _attempt in range(2):
            if self._process is None:
                failure = self._start()
                if failure is not None:
                    return "error", failure
            try:
                self._connection.send(str(path))
                break
            except OSError:
                self._stop(grace=1.0)
        else:
            return "error", "Metadata parser could not be reached"
        answer = self._wait(self._timeout)
        if answer is _TIMED_OUT:
            self._stop(grace=0.0)
            return "timeout", f"Metadata parsing exceeded {self._timeout:g} seconds"
        if answer is _GONE or not isinstance(answer, tuple) or len(answer) != 2:
            code = self._stop(grace=2.0)
            return "error", f"Metadata parser exited without a result (exit code {code})"
        self._served += 1
        return answer

    def _start(self) -> str | None:
        context = multiprocessing.get_context("spawn")
        connection, child_end = context.Pipe(duplex=True)
        process = context.Process(target=self._target, args=(child_end,), daemon=True)
        try:
            process.start()
        except OSError as exc:
            connection.close()
            child_end.close()
            return f"Metadata parser could not start: {exc}"
        # Only the child holds its end now, so a child that dies is a closed pipe
        # here instead of a silence that lasts until the timeout.
        child_end.close()
        self._process, self._connection, self._served = process, connection, 0
        self.processes_started += 1
        ready = self._wait(self._start_seconds)
        if not (isinstance(ready, tuple) and ready[:1] == ("ready",)):
            code = self._stop(grace=0.0 if ready is _TIMED_OUT else 2.0)
            return f"Metadata parser did not start (exit code {code})"
        return None

    def _wait(self, seconds: float) -> Any:
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return _TIMED_OUT
            try:
                if self._connection.poll(min(remaining, _PARSER_POLL_SECONDS)):
                    return self._connection.recv()
            except (EOFError, OSError):
                return _GONE
            if not self._process.is_alive():
                # Whatever it managed to send before it went is still read first.
                try:
                    return self._connection.recv() if self._connection.poll(0) else _GONE
                except (EOFError, OSError):
                    return _GONE

    def _stop(self, *, grace: float, ask: bool = False) -> int | None:
        """End the current child; its exit code. ``ask`` lets it finish on its own first."""
        process, connection = self._process, self._connection
        self._process = self._connection = None
        if process is None:
            return None
        if ask:
            try:
                connection.send(None)
            except OSError:
                pass
        if grace > 0:
            process.join(grace)
        if process.is_alive():
            process.terminate()
            process.join(5)
        if process.is_alive():
            process.kill()
            process.join(5)
        connection.close()
        return process.exitcode


def _validate_schema(connection: Any, database_name: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COUNT(*) AS column_count
            FROM information_schema.columns
            WHERE table_schema = %s
              AND table_name = 'background_jobs'
              AND column_name = 'job_key'
            """,
            (database_name,),
        )
        row = cursor.fetchone()
    if not row or int(row["column_count"]) != 1:
        raise MetadataWorkerError("Metadata queue schema is not migrated")


# How long a finished reading is kept. The row has no reader once the file's
# tags are in the catalogue; it only stops the same reading being queued twice,
# and a file that old is not queued again unless it changes — under a new key.
_DONE_KEEP_DAYS = 30
_PRUNE_BATCH = 5000
_PRUNE_BATCHES = 20


def _prune_finished_jobs(connection: Any) -> int:
    """Remove readings finished long ago, and failures a later reading made good; say how many rows went.

    Nothing ever deleted a row of the queue: 38 949 finished readings for a
    library of 20 000 files, growing with every changed file and every bump of
    what is read. A failure followed by a successful reading of the same file
    goes first — while its "done" row is still there to show that it was made
    good, and before that row goes the same way. A file that keeps failing keeps
    its row: that one is still being asked about.

    Bounded, like everything a scheduled run does: a first run on an old queue
    takes a few batches and leaves the rest to the next.
    """
    removed = 0
    with connection.cursor() as cursor:
        cursor.execute(
            """
            DELETE failed FROM background_jobs failed
            INNER JOIN background_jobs made_good
                    ON made_good.job_type = 'metadata'
                   AND made_good.status = 'done'
                   AND made_good.id > failed.id
                   AND made_good.job_key LIKE CONCAT(SUBSTRING_INDEX(failed.job_key, ':', 2), ':%%')
            WHERE failed.job_type = 'metadata'
              AND failed.status = 'failed'
              AND failed.updated_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s DAY)
            """,
            (_DONE_KEEP_DAYS,),
        )
        removed += int(cursor.rowcount)
        for _ in range(_PRUNE_BATCHES):
            cursor.execute(
                """
                DELETE FROM background_jobs
                WHERE job_type = 'metadata'
                  AND status = 'done'
                  AND updated_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s DAY)
                LIMIT %s
                """,
                (_DONE_KEEP_DAYS, _PRUNE_BATCH),
            )
            removed += int(cursor.rowcount)
            if cursor.rowcount < _PRUNE_BATCH:
                break
    return removed


def _claim_job(connection: Any, lease_seconds: int) -> dict[str, Any] | None:
    connection.begin()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, payload_json
                FROM background_jobs
                WHERE job_type = 'metadata'
                  AND status = 'queued'
                  AND available_at <= CURRENT_TIMESTAMP(6)
                ORDER BY id
                LIMIT 1
                FOR UPDATE
                """
            )
            job = cursor.fetchone()
            if not job:
                connection.commit()
                return None
            cursor.execute(
                """
                UPDATE background_jobs
                SET status = 'running',
                    attempts = attempts + 1,
                    leased_until = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL %s SECOND)
                WHERE id = %s AND status = 'queued'
                """,
                (lease_seconds, job["id"]),
            )
            if cursor.rowcount != 1:
                raise MetadataWorkerError("Metadata job claim changed unexpectedly")
        connection.commit()
        return job
    except BaseException:
        connection.rollback()
        raise


def _payload_item_id(raw: Any) -> int:
    payload = raw if isinstance(raw, dict) else json.loads(str(raw))
    item_id = int(payload["media_item_id"])
    if item_id <= 0:
        raise ValueError("Invalid media item id")
    return item_id


def _load_item(connection: Any, item_id: int) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT mi.id, mi.relative_path, mi.metadata_json, mi.media_kind, mi.deleted_at, mr.slug
            FROM media_items AS mi
            INNER JOIN media_roots AS mr ON mr.id = mi.root_id
            WHERE mi.id = %s
            """,
            (item_id,),
        )
        row = cursor.fetchone()
    if not row:
        raise MetadataWorkerError("Metadata job references a missing media item")
    if row["deleted_at"] is not None:
        raise MetadataWorkerError("Metadata job references a deleted media item")
    return row


def _merged_metadata(raw: Any, section: str, technical: dict[str, Any]) -> str:
    if isinstance(raw, dict):
        result = dict(raw)
    elif raw:
        try:
            parsed = json.loads(str(raw))
            result = dict(parsed) if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            result = {}
    else:
        result = {}
    result[section] = technical
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def _probe_video(
    path: Path,
    ffprobe: Path | None,
    timeout_seconds: float,
    *,
    reader: Any = read_media_probe,
) -> dict[str, Any]:
    """One video's technical facts, in the shape _complete_job stores."""
    if ffprobe is None:
        raise MetadataWorkerError("ffprobe is not configured; set stereo.ffmpeg_path")
    probe = reader(path, ffprobe, timeout_seconds=timeout_seconds)
    return {
        "section": "video",
        "title": None,
        "artist": None,
        "album": None,
        "duration_ms": probe.duration_ms,
        "technical": probe.technical,
        "columns": {
            "video_width": probe.width,
            "video_height": probe.height,
            "video_codec": probe.video_codec,
            "audio_codec": probe.audio_codec,
            "frame_rate": probe.frame_rate,
            "is_hdr": int(probe.hdr),
        },
    }


def _tag_year(technical: dict[str, Any]) -> int | None:
    """The queryable year, read with the same rule the tag reader stores by."""
    return release_year(str(technical.get("year") or ""))


def _complete_job(connection: Any, job_id: int, item: dict[str, Any], metadata: dict[str, Any]) -> None:
    merged = _merged_metadata(item["metadata_json"], metadata.get("section", "audio"), metadata["technical"])
    # A probe fills the queryable columns as well; audio tags leave them alone,
    # so COALESCE keeps whatever a previous probe of the same file established.
    columns = metadata.get("columns") or {}
    # A track's year comes from its tag, a film's from its name or a lookup, and
    # both land in the same column so that one rule in a smart collection covers
    # both libraries. 'tag' marks the ones a re-read may overwrite; a year a
    # person set says 'manual' and is left alone.
    tag_year = _tag_year(metadata.get("technical") or {}) if metadata.get("section", "audio") == "audio" else None
    connection.begin()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE media_items
                SET title = COALESCE(%s, title),
                    artist = COALESCE(%s, artist),
                    album = COALESCE(%s, album),
                    duration_ms = COALESCE(%s, duration_ms),
                    video_width = COALESCE(%s, video_width),
                    video_height = COALESCE(%s, video_height),
                    video_codec = COALESCE(%s, video_codec),
                    audio_codec = COALESCE(%s, audio_codec),
                    frame_rate = COALESCE(%s, frame_rate),
                    is_hdr = COALESCE(%s, is_hdr),
                    release_year = CASE
                      WHEN %s IS NULL THEN release_year
                      WHEN release_year_source IS NULL OR release_year_source = 'tag' THEN %s
                      ELSE release_year
                    END,
                    release_year_source = CASE
                      WHEN %s IS NULL THEN release_year_source
                      WHEN release_year_source IS NULL OR release_year_source = 'tag' THEN 'tag'
                      ELSE release_year_source
                    END,
                    metadata_json = %s,
                    last_error = NULL,
                    indexed_at = CURRENT_TIMESTAMP(6)
                WHERE id = %s
                """,
                (
                    metadata["title"],
                    metadata["artist"],
                    metadata["album"],
                    metadata["duration_ms"],
                    columns.get("video_width"),
                    columns.get("video_height"),
                    columns.get("video_codec"),
                    columns.get("audio_codec"),
                    columns.get("frame_rate"),
                    columns.get("is_hdr"),
                    tag_year,
                    tag_year,
                    tag_year,
                    merged,
                    item["id"],
                ),
            )
            cursor.execute(
                """
                UPDATE background_jobs
                SET status = 'done', leased_until = NULL, last_error = NULL
                WHERE id = %s AND status = 'running'
                """,
                (job_id,),
            )
            if cursor.rowcount != 1:
                raise MetadataWorkerError("Metadata job completion changed unexpectedly")
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def _fail_job(connection: Any, job_id: int, item_id: int | None, error: str) -> None:
    message = error[:4000]
    connection.begin()
    try:
        with connection.cursor() as cursor:
            if item_id is not None:
                cursor.execute(
                    "UPDATE media_items SET last_error = %s WHERE id = %s",
                    (f"metadata: {message}", item_id),
                )
            cursor.execute(
                """
                UPDATE background_jobs
                SET status = 'failed', leased_until = NULL, last_error = %s
                WHERE id = %s AND status = 'running'
                """,
                (message, job_id),
            )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def run_metadata_worker(
    *,
    database: DatabaseConfig,
    roots: Mapping[str, Path],
    limit: int = 100,
    timeout_seconds: float = 15.0,
    ffprobe_path: Path | None = None,
) -> dict[str, int | float | str]:
    """
    Drain the metadata queue.

    Audio and video need different readers — tags come from Mutagen, technical
    facts about a film come from ffprobe — but they share one queue, one lease
    and one lock, so a scan can enqueue both and a single scheduled run handles
    whatever is waiting. Tags are read in one child process for the whole run
    (``_MetadataReader``), replaced only when a file hangs it or brings it down.
    """
    if not 1 <= limit <= 100000:
        raise MetadataWorkerError("Metadata worker limit must be in the range 1..100000")
    if not 0.1 <= timeout_seconds <= 300:
        raise MetadataWorkerError("Metadata timeout must be in the range 0.1..300 seconds")

    started = time.monotonic()
    report: dict[str, int | float | str] = {
        "status": "running",
        "claimed": 0,
        "completed": 0,
        "failed": 0,
        "timed_out": 0,
        "probed": 0,
        "parser_processes": 0,
        "pruned": 0,
    }
    lock_name = "tryhackx:metadata-worker"
    reader = _MetadataReader(timeout_seconds)
    try:
        with _connect(database) as connection:
            _validate_schema(connection, database.name)
            with connection.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK(%s, 0) AS acquired", (lock_name,))
                row = cursor.fetchone()
            if not row or int(row["acquired"] or 0) != 1:
                raise MetadataWorkerError("Another metadata worker is already running")
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE background_jobs
                        SET status = 'queued', leased_until = NULL
                        WHERE job_type = 'metadata'
                          AND status = 'running'
                          AND leased_until < CURRENT_TIMESTAMP(6)
                        """
                    )

                lease_seconds = max(60, int(timeout_seconds * 2) + 10)
                for _ in range(limit):
                    job = _claim_job(connection, lease_seconds)
                    if job is None:
                        break
                    report["claimed"] = int(report["claimed"]) + 1
                    item_id: int | None = None
                    try:
                        item_id = _payload_item_id(job["payload_json"])
                        item = _load_item(connection, item_id)
                        root_slug = str(item["slug"])
                        root_path = roots.get(root_slug)
                        if root_path is None:
                            raise MetadataWorkerError(f"Root {root_slug} is not configured")
                        resolved = resolve_item(
                            GrantItem(root=root_slug, path=str(item["relative_path"])),
                            roots,
                        )
                        if str(item["media_kind"]) == "video":
                            # ffprobe is already its own process, so it needs no
                            # extra child: its own timeout bounds the work.
                            _complete_job(
                                connection,
                                int(job["id"]),
                                item,
                                _probe_video(resolved.path, ffprobe_path, timeout_seconds),
                            )
                            report["completed"] = int(report["completed"]) + 1
                            report["probed"] = int(report["probed"]) + 1
                            continue
                        outcome, value = reader.read(resolved.path)
                        if outcome == "ok":
                            _complete_job(connection, int(job["id"]), item, value)
                            report["completed"] = int(report["completed"]) + 1
                        else:
                            if outcome == "timeout":
                                report["timed_out"] = int(report["timed_out"]) + 1
                            _fail_job(connection, int(job["id"]), item_id, str(value))
                            report["failed"] = int(report["failed"]) + 1
                    except (MetadataWorkerError, PathAccessError, ProbeError, OSError, ValueError) as exc:
                        if isinstance(exc, ProbeError) and "exceeded" in str(exc):
                            report["timed_out"] = int(report["timed_out"]) + 1
                        _fail_job(connection, int(job["id"]), item_id, str(exc))
                        report["failed"] = int(report["failed"]) + 1
                report["pruned"] = _prune_finished_jobs(connection)
                report["status"] = "completed"
            finally:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT RELEASE_LOCK(%s)", (lock_name,))
    except MetadataWorkerError:
        raise
    except pymysql.MySQLError as exc:
        raise MetadataWorkerError(f"Metadata database operation failed: {exc}") from exc
    finally:
        reader.close()
        report["parser_processes"] = reader.processes_started
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000)

    return report
