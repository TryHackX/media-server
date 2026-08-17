from __future__ import annotations

import json
import multiprocessing
import queue
import time
from pathlib import Path
from typing import Any, Mapping

import pymysql
from pymysql.cursors import DictCursor

from .config import DatabaseConfig
from .metadata import read_audio_metadata, release_year
from .paths import PathAccessError, resolve_item
from .probe import ProbeError, read_media_probe
from .security import GrantItem


class MetadataWorkerError(RuntimeError):
    pass


def _connect(config: DatabaseConfig):
    return pymysql.connect(
        host=config.host,
        port=config.port,
        user=config.user,
        password=config.password,
        database=config.name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=True,
        connect_timeout=5,
        read_timeout=120,
        write_timeout=120,
    )


def _read_metadata_child(path: str, output: Any) -> None:
    try:
        metadata = read_audio_metadata(Path(path))
        output.put(
            (
                "ok",
                {
                    "title": metadata.title,
                    "artist": metadata.artist,
                    "album": metadata.album,
                    "duration_ms": metadata.duration_ms,
                    "technical": metadata.technical,
                },
            )
        )
    except BaseException as exc:
        output.put(("error", f"{type(exc).__name__}: {exc}"[:4000]))


def _read_with_timeout(
    path: Path,
    timeout_seconds: float,
    *,
    child_target: Any = _read_metadata_child,
) -> tuple[str, dict[str, Any] | str]:
    context = multiprocessing.get_context("spawn")
    output = context.Queue(maxsize=1)
    process = context.Process(target=child_target, args=(str(path), output), daemon=True)
    process.start()
    process.join(timeout_seconds)
    if process.is_alive():
        process.terminate()
        process.join(5)
        output.close()
        output.join_thread()
        return "timeout", f"Metadata parsing exceeded {timeout_seconds:g} seconds"

    try:
        result = output.get(timeout=1)
    except queue.Empty:
        result = ("error", f"Metadata parser exited without a result (exit code {process.exitcode})")
    finally:
        output.close()
        output.join_thread()
    return result


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
    whatever is waiting.
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
    }
    lock_name = "tryhackx:metadata-worker"
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
                        outcome, value = _read_with_timeout(resolved.path, timeout_seconds)
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
                report["status"] = "completed"
            finally:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT RELEASE_LOCK(%s)", (lock_name,))
    except MetadataWorkerError:
        raise
    except pymysql.MySQLError as exc:
        raise MetadataWorkerError(f"Metadata database operation failed: {exc}") from exc
    finally:
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000)

    return report
