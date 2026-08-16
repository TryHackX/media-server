"""
Filling in genre and year from Filmweb, one work at a time.

The queue is `media_title_lookups` itself rather than a row in `background_jobs`
next to the metadata jobs. A metadata job has two outcomes — it worked or it
failed — so a plain queue fits it; a lookup has four, because "I found something
but I am not sure" and "I found nothing" are different answers and one of them
needs a person. Those states, the alternatives offered, and the decision an
administrator eventually makes all belong on one row, and keeping a second row
in another table in step with it would only be a way to let the two disagree.

What the worker will not do:

* **It will not overrule a person.** A year or a genre whose source says
  'manual' is left exactly as it is, however confident this run happens to be.
* **It will not guess.** Anything under the acceptance bar is parked with its
  alternatives for review instead of being written into the catalogue.
* **It will not hurry.** One request at a time with a pause between them, every
  answer cached, and a limit on each run. This is somebody else's server.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from .config import DatabaseConfig
from .filmweb import Candidate, FilmwebClient, FilmwebError, Match
from .naming import SearchSubject

__all__ = [
    "RECHECK_DAYS",
    "TitleWorkerError",
    "enqueue_only",
    "enqueue_title_lookups",
    "run_title_lookups",
    "run_title_worker",
    "reopen_stale_lookups",
]

_LOCK_NAME = "tryhackx:title-worker"


class TitleWorkerError(RuntimeError):
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


# How long an answer from Filmweb is trusted before it is asked again. Genres
# and years do get corrected there, and a home library is not re-read often
# enough to notice on its own. Long enough that a full sweep is rare; short
# enough that a correction lands within a season.
RECHECK_DAYS = 90


def reopen_stale_lookups(connection: Any, *, root_id: int, days: int = RECHECK_DAYS) -> int:
    """
    Put answers older than `days` back in the queue, and say how many.

    Two kinds of row are deliberately left alone. A decision somebody made by
    hand (`source = 'manual'`) is the whole point of the review queue and must
    never be quietly re-fetched. A row still waiting for review keeps its
    candidates, because those are what the panel is about to offer — refreshing
    it would throw away the list the owner was halfway through reading.

    Cached responses make a re-check nearly free for anything that has not
    changed, so this costs a request only where there is something new to learn.
    """
    if days < 1:
        return 0
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE media_title_lookups
            SET status = 'pending'
            WHERE root_id = %s
              AND status IN ('matched', 'none', 'failed')
              AND source <> 'manual'
              AND checked_at IS NOT NULL
              AND checked_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s DAY)
            """,
            (root_id, days),
        )
        return int(cursor.rowcount)


def enqueue_title_lookups(connection: Any, *, root_id: int) -> int:
    """
    Open a lookup row for every work in this root that has none yet.

    Grouping is already done: the catalogue sweep wrote title_subject_hash, so
    one row per hash is one row per film or per series. query_title and
    query_year are stored rather than recomputed so that the panel can show what
    was actually asked when a match looks wrong.
    """
    from .naming import search_subject_from_path

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT mi.title_subject_hash AS subject_hash,
                   MIN(mi.relative_path) AS sample_path,
                   COUNT(*) AS item_count,
                   MAX(mi.duration_ms) AS duration_ms
            FROM media_items AS mi
            LEFT JOIN media_title_lookups AS mtl
              ON mtl.root_id = mi.root_id AND mtl.subject_hash = mi.title_subject_hash
            WHERE mi.root_id = %s
              AND mi.media_kind = 'video'
              AND mi.deleted_at IS NULL
              AND mi.title_subject_hash IS NOT NULL
              AND mtl.id IS NULL
            GROUP BY mi.title_subject_hash
            """,
            (root_id,),
        )
        rows = cursor.fetchall()

        pending = []
        for row in rows:
            subject = search_subject_from_path(str(row["sample_path"]))
            if subject is None:
                continue
            pending.append(
                (
                    root_id,
                    bytes(row["subject_hash"]),
                    subject.group_key[:512],
                    int(subject.is_episode),
                    subject.title[:512],
                    subject.year,
                    int(row["item_count"]),
                )
            )
        if not pending:
            return 0
        return cursor.executemany(
            """
            INSERT IGNORE INTO media_title_lookups
              (root_id, subject_hash, subject_key, is_episode, query_title, query_year, item_count)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            pending,
        )


def _pending_lookups(connection: Any, limit: int) -> list[dict[str, Any]]:
    """
    The next works waiting to be looked up.

    No per-row claim and no in-flight status: the worker holds an exclusive lock
    for its whole run, so there is never a second one to race with, and a row
    left untouched by a crash simply stays pending and is picked up next time —
    which is what should happen to it.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, root_id, subject_hash, subject_key, is_episode, query_title, query_year
            FROM media_title_lookups
            WHERE status = 'pending'
            ORDER BY id
            LIMIT %s
            """,
            (limit,),
        )
        return list(cursor.fetchall())


def _longest_duration(connection: Any, root_id: int, subject_hash: bytes) -> int | None:
    """
    How long the main file of this work runs, in milliseconds.

    The longest one, because a film folder also holds trailers and making-ofs,
    and it is the feature that has to agree with the runtime Filmweb reports.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT MAX(duration_ms) AS duration_ms
            FROM media_items
            WHERE root_id = %s AND title_subject_hash = %s AND media_kind = 'video' AND deleted_at IS NULL
            """,
            (root_id, subject_hash),
        )
        row = cursor.fetchone()
    return int(row["duration_ms"]) if row and row["duration_ms"] else None


def _genre_ids_for(connection: Any, filmweb_ids: tuple[int, ...]) -> list[int]:
    """Filmweb's genre numbers translated into this catalogue's dictionary."""
    if not filmweb_ids:
        return []
    placeholders = ", ".join(["%s"] * len(filmweb_ids))
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT id FROM media_genres WHERE filmweb_id IN ({placeholders})",
            filmweb_ids,
        )
        return [int(row["id"]) for row in cursor.fetchall()]


def apply_match(
    connection: Any,
    *,
    root_id: int,
    subject_hash: bytes,
    candidate: Candidate,
    source: str = "filmweb",
) -> int:
    """
    Write one accepted match onto every file of the work, and say how many.

    A person's correction is never touched: only rows whose release_year_source
    is empty, 'filename' or this same source are moved, and only genre rows this
    source wrote itself are cleared before the new ones go in.
    """
    genre_ids = _genre_ids_for(connection, candidate.genre_ids)
    connection.begin()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id FROM media_items
                WHERE root_id = %s AND title_subject_hash = %s AND media_kind = 'video' AND deleted_at IS NULL
                """,
                (root_id, subject_hash),
            )
            item_ids = [int(row["id"]) for row in cursor.fetchall()]
            if not item_ids:
                connection.commit()
                return 0
            placeholders = ", ".join(["%s"] * len(item_ids))

            if candidate.year:
                cursor.execute(
                    f"""
                    UPDATE media_items
                    SET release_year = %s, release_year_source = %s
                    WHERE id IN ({placeholders})
                      AND (release_year_source IS NULL OR release_year_source IN ('filename', %s))
                    """,
                    (candidate.year, source, *item_ids, source),
                )

            cursor.execute(
                f"DELETE FROM media_item_genres WHERE source = %s AND media_item_id IN ({placeholders})",
                (source, *item_ids),
            )
            if genre_ids:
                cursor.executemany(
                    """
                    INSERT IGNORE INTO media_item_genres (media_item_id, genre_id, source)
                    VALUES (%s, %s, %s)
                    """,
                    [(item_id, genre_id, source) for item_id in item_ids for genre_id in genre_ids],
                )
        connection.commit()
        return len(item_ids)
    except BaseException:
        connection.rollback()
        raise


def _record(connection: Any, lookup_id: int, status: str, match: Match | None, error: str | None = None) -> None:
    candidate = match.candidate if match else None
    offered: list[dict[str, Any]] = []
    if match is not None and not match.accepted:
        # Only an unsettled row carries alternatives, and the best guess is the
        # first of them: the panel offers a list to choose from, and the one the
        # matcher liked most has no special standing until somebody agrees.
        if candidate is not None:
            offered.append({**candidate.as_dict(), "confidence": match.confidence})
        offered.extend({**other.as_dict(), "confidence": value} for other, value in match.alternatives)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE media_title_lookups
            SET status = %s,
                external_id = %s,
                external_url = %s,
                matched_title = %s,
                matched_year = %s,
                confidence = %s,
                reasons_json = %s,
                candidates_json = %s,
                last_error = %s,
                checked_at = CURRENT_TIMESTAMP(6)
            WHERE id = %s
            """,
            (
                status,
                str(candidate.filmweb_id) if candidate else None,
                candidate.url if candidate else None,
                candidate.title[:512] if candidate else None,
                candidate.year if candidate else None,
                match.confidence if match else 0,
                json.dumps(match.reasons, ensure_ascii=False) if match else None,
                json.dumps(offered, ensure_ascii=False) if offered else None,
                error[:4000] if error else None,
                lookup_id,
            ),
        )


def enqueue_only(database: DatabaseConfig, root_slug: str) -> int:
    """Open the lookup rows and stop, so the queue can be sized before any request."""
    with _connect(database) as connection:
        return enqueue_title_lookups(connection, root_id=_root_id(connection, root_slug))


def _root_id(connection: Any, root_slug: str) -> int:
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM media_roots WHERE slug = %s", (root_slug,))
        row = cursor.fetchone()
    if not row:
        raise TitleWorkerError(f"The media root {root_slug} has not been scanned yet")
    return int(row["id"])


def run_title_lookups(
    *,
    database: DatabaseConfig,
    root_slug: str,
    cache_path: Path,
    limit: int = 50,
    min_interval: float = 1.2,
    recheck_days: int = RECHECK_DAYS,
) -> dict[str, Any]:
    """
    Open lookup rows for one root and work through a batch of them.

    One entry point for two callers — the panel button and the command line —
    because "find out what these films are" is one intention, and a queue that
    only fills when somebody remembers a second command is a queue that stays
    empty.
    """
    with _connect(database) as connection:
        root = _root_id(connection, root_slug)
        opened = enqueue_title_lookups(connection, root_id=root)
        reopened = reopen_stale_lookups(connection, root_id=root, days=recheck_days)

    report = run_title_worker(database=database, cache_path=cache_path, limit=limit, min_interval=min_interval)
    report["opened"] = opened
    report["reopened"] = reopened
    return report


def run_title_worker(
    *,
    database: DatabaseConfig,
    cache_path: Path,
    limit: int = 50,
    min_interval: float = 1.2,
) -> dict[str, Any]:
    """
    Drain part of the lookup queue and report what happened to each work.

    `limit` is deliberately small by default. There are around two thousand
    works in this library, and doing them in batches spread over time is both
    kinder to Filmweb and easier to stop when something looks wrong.
    """
    if not 1 <= limit <= 5000:
        raise TitleWorkerError("Title worker limit must be in the range 1..5000")

    started = time.monotonic()
    report: dict[str, Any] = {
        "status": "running",
        "claimed": 0,
        "matched": 0,
        "review": 0,
        "none": 0,
        "failed": 0,
        "items_updated": 0,
        "requests": 0,
    }
    client = FilmwebClient(cache_path=cache_path, min_interval=min_interval)
    try:
        with _connect(database) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK(%s, 0) AS acquired", (_LOCK_NAME,))
                row = cursor.fetchone()
            if not row or int(row["acquired"] or 0) != 1:
                raise TitleWorkerError("Another title lookup worker is already running")
            try:
                for lookup in _pending_lookups(connection, limit):
                    report["claimed"] += 1
                    subject = SearchSubject(
                        title=str(lookup["query_title"]),
                        year=int(lookup["query_year"]) if lookup["query_year"] else None,
                        is_episode=bool(lookup["is_episode"]),
                        group_key=str(lookup["subject_key"]),
                    )
                    root_id = int(lookup["root_id"])
                    subject_hash = bytes(lookup["subject_hash"])
                    try:
                        match = client.lookup(
                            subject,
                            duration_ms=_longest_duration(connection, root_id, subject_hash),
                        )
                    except FilmwebError as exc:
                        _record(connection, int(lookup["id"]), "failed", None, str(exc))
                        report["failed"] += 1
                        continue

                    if match.accepted and match.candidate is not None:
                        report["items_updated"] += apply_match(
                            connection,
                            root_id=root_id,
                            subject_hash=subject_hash,
                            candidate=match.candidate,
                        )
                        _record(connection, int(lookup["id"]), "matched", match)
                        report["matched"] += 1
                    elif match.candidate is not None:
                        _record(connection, int(lookup["id"]), "review", match)
                        report["review"] += 1
                    else:
                        _record(connection, int(lookup["id"]), "none", match)
                        report["none"] += 1
                report["status"] = "completed"
            finally:
                report["requests"] = client.requests_made
                with connection.cursor() as cursor:
                    cursor.execute("SELECT RELEASE_LOCK(%s)", (_LOCK_NAME,))
    except TitleWorkerError:
        raise
    except pymysql.MySQLError as exc:
        raise TitleWorkerError(f"Title lookup database operation failed: {exc}") from exc
    finally:
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return report
