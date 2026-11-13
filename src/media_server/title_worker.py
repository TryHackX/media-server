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
* **It will not stall on one work.** A lookup that fails — Filmweb down, or an
  answer the parser cannot read — fails for that row alone: it is recorded, the
  run goes on, and the row is asked again after a pause that grows with each
  failure (``RETRY_AFTER_SECONDS``). When Filmweb itself stops answering, the run
  stops instead of marking the rest of the queue as failed.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import pymysql

from .config import DatabaseConfig
from .database import connect_rows as _connect
from .filmweb import (
    Candidate,
    FilmwebClient,
    FilmwebError,
    FilmwebUnavailable,
    Match,
    best_match,
    candidates_from_stored,
)
from .naming import SearchSubject

LOGGER = logging.getLogger("media_server.title_worker")

__all__ = [
    "RECHECK_DAYS",
    "RETRY_AFTER_SECONDS",
    "TitleWorkerError",
    "enqueue_only",
    "enqueue_title_lookups",
    "prune_orphaned_lookups",
    "run_title_lookups",
    "run_title_worker",
    "reopen_stale_lookups",
]

_LOCK_NAME = "tryhackx:title-worker"


class TitleWorkerError(RuntimeError):
    pass


# How long an answer from Filmweb is trusted before it is asked again. Genres
# and years do get corrected there, and a home library is not re-read often
# enough to notice on its own. Long enough that a full sweep is rare; short
# enough that a correction lands within a season.
RECHECK_DAYS = 90

# How long a row that failed waits before it is asked again, by how many times in
# a row it has failed: an hour, six hours, a day, three days, a week, then a month
# for as long as it keeps failing. Short at first, because most failures are a
# dropped connection; long later, because a record that has failed five times is
# not going to be fixed by asking more often.
RETRY_AFTER_SECONDS: tuple[int, ...] = (3600, 6 * 3600, 24 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600)

# Failures in a row, from Filmweb not answering at all, after which a run stops.
# The works after them have done nothing wrong and stay pending, unpunished.
_UNAVAILABLE_STREAK = 3

# Database errors that mean the connection itself is gone: no later row would fare
# better, so these end the run instead of being pinned on one row.
_FATAL_DATABASE_ERRORS = (pymysql.err.OperationalError, pymysql.err.InterfaceError)


def retry_delay(attempts: int) -> int:
    """Seconds before a row that has now failed ``attempts`` times in a row is asked again."""
    return RETRY_AFTER_SECONDS[min(max(attempts, 1), len(RETRY_AFTER_SECONDS)) - 1]


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

    A row that failed comes back sooner, when its ``retry_at`` has passed — the
    back-off its failures earned (``retry_delay``). Rows that failed before there
    was a back-off have no ``retry_at`` and keep the 90-day recheck.
    """
    reopened = 0
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE media_title_lookups
            SET status = 'pending'
            WHERE root_id = %s
              AND status = 'failed'
              AND source <> 'manual'
              AND retry_at IS NOT NULL
              AND retry_at <= CURRENT_TIMESTAMP(6)
            """,
            (root_id,),
        )
        reopened += int(cursor.rowcount)
        if days < 1:
            return reopened
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
        reopened += int(cursor.rowcount)
    return reopened


def enqueue_title_lookups(connection: Any, *, root_id: int) -> int:
    """
    Open a lookup row for every work in this root that has none yet.

    Grouping is already done: the catalogue sweep wrote title_subject_hash, so
    one row per hash is one row per film or per series. query_title and
    query_year are stored rather than recomputed so that the panel can show what
    was actually asked when a match looks wrong.

    The subject is read with the library's numbered folders in view, as the
    sweep read it (``bare_episode_folders``), so a run of bare-numbered episodes
    is asked about as its series. The rows this leaves without a file — the
    numbered episodes' rows of their own — are ``prune_orphaned_lookups``'s.
    """
    from .naming import bare_episode_folders, search_subject_from_path

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
        numbered: frozenset[str] = frozenset()
        if rows:
            cursor.execute(
                "SELECT relative_path FROM media_items WHERE root_id = %s AND media_kind = 'video' AND deleted_at IS NULL",
                (root_id,),
            )
            numbered = bare_episode_folders(str(row["relative_path"]) for row in cursor.fetchall())

        pending = []
        for row in rows:
            subject = search_subject_from_path(str(row["sample_path"]), numbered_folders=numbered)
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


def prune_orphaned_lookups(connection: Any, *, root_id: int) -> int:
    """
    Drop the unanswered rows of works that no longer have a single file; how many.

    A row is a question about the files that share its subject hash. When the
    sweep regroups those files — ten numbered episodes become one series — or the
    files go, the row asks about nothing, and the panel would go on offering it
    for review with nowhere to apply the answer. Only rows nobody has answered
    are dropped: a match and a person's decision stay, files or not.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            DELETE mtl FROM media_title_lookups AS mtl
            LEFT JOIN media_items AS mi
              ON mi.root_id = mtl.root_id
             AND mi.title_subject_hash = mtl.subject_hash
             AND mi.media_kind = 'video'
             AND mi.deleted_at IS NULL
            WHERE mtl.root_id = %s
              AND mi.id IS NULL
              AND mtl.status IN ('pending', 'review', 'none', 'failed')
              AND mtl.source <> 'manual'
              AND mtl.decided_at IS NULL
            """,
            (root_id,),
        )
        return int(cursor.rowcount)


def _pending_lookups(connection: Any, limit: int, root_id: int | None = None) -> list[dict[str, Any]]:
    """
    The next works waiting to be looked up — in ``root_id`` when one is given.

    No per-row claim and no in-flight status: the worker holds an exclusive lock
    for its whole run, so there is never a second one to race with, and a row
    left untouched by a crash simply stays pending and is picked up next time —
    which is what should happen to it.

    The root used to be ignored here: a run started for one source drained the
    pending rows of every source, and the periodic pass, which asks root by root,
    spent its whole budget on whichever root came first.
    """
    where = "status = 'pending'" + ("" if root_id is None else " AND root_id = %s")
    params: tuple[Any, ...] = (limit,) if root_id is None else (root_id, limit)
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT id, root_id, subject_hash, subject_key, is_episode, query_title, query_year, attempts
            FROM media_title_lookups
            WHERE {where}
            ORDER BY id
            LIMIT %s
            """,
            params,
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
    """Write an outcome that is not a failure; it also clears the row's failure streak."""
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
                attempts = 0,
                retry_at = NULL,
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


def _record_failure(connection: Any, lookup: dict[str, Any], error: str) -> int:
    """Mark one row failed and set when it may be tried again; the delay chosen, in seconds."""
    attempts = int(lookup.get("attempts") or 0) + 1
    delay = retry_delay(attempts)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE media_title_lookups
            SET status = 'failed',
                last_error = %s,
                attempts = %s,
                retry_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL %s SECOND),
                checked_at = CURRENT_TIMESTAMP(6)
            WHERE id = %s
            """,
            (error[:4000], min(attempts, 65535), delay, int(lookup["id"])),
        )
    return delay


def rejudge_review(
    subject: SearchSubject,
    stored: Any,
    *,
    duration_ms: int | None,
) -> Match | None:
    """
    The current scorer's verdict on a row waiting for review, from what it stored.

    None when the stored list cannot be read. Pure, so it is tested without a
    database; `rescore_reviews` is the loop around it.
    """
    try:
        rows = json.loads(stored) if isinstance(stored, (str, bytes)) else stored
    except ValueError:
        return None
    if not isinstance(rows, list):
        return None
    candidates = candidates_from_stored([row for row in rows if isinstance(row, dict)])
    if not candidates:
        return None
    return best_match(subject, candidates, duration_ms=duration_ms)


def rescore_reviews(connection: Any, root_id: int | None = None) -> dict[str, int]:
    """
    Settle what the scorer can now settle among the rows waiting for review.

    Every candidate of such a row is kept in `candidates_json` with the facts it
    was judged on, so a better scorer can be applied to the backlog without a
    single request to Filmweb. A row that now clears both bars — the score and
    the margin over the runner-up — is written exactly as an unattended match
    would be; one whose best candidate is not even plausible moves to "nothing
    found". Everything else is left untouched, `checked_at` included, because the
    panel is in the middle of offering it. Only rows of ``root_id`` when given.
    """
    report = {"rescored": 0, "matched": 0, "dismissed": 0, "items_updated": 0}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, root_id, subject_hash, subject_key, is_episode, query_title, query_year, candidates_json
            FROM media_title_lookups
            WHERE status = 'review' AND decided_at IS NULL AND source <> 'manual'
            """
            + ("" if root_id is None else " AND root_id = %s")
            + " ORDER BY id",
            () if root_id is None else (root_id,),
        )
        rows = cursor.fetchall()
    for row in rows:
        report["rescored"] += 1
        root_id = int(row["root_id"])
        subject_hash = bytes(row["subject_hash"])
        subject = SearchSubject(
            title=str(row["query_title"]),
            year=int(row["query_year"]) if row["query_year"] else None,
            is_episode=bool(row["is_episode"]),
            group_key=str(row["subject_key"]),
        )
        match = rejudge_review(
            subject,
            row["candidates_json"],
            duration_ms=_longest_duration(connection, root_id, subject_hash),
        )
        if match is not None and match.candidate is None:
            # Nothing plausible among what it stored: it leaves the review list
            # for "nothing found", where a re-check can still turn something up.
            _record(connection, int(row["id"]), "none", match)
            report["dismissed"] += 1
            continue
        if match is None or not match.accepted or match.candidate is None:
            continue
        report["items_updated"] += apply_match(
            connection, root_id=root_id, subject_hash=subject_hash, candidate=match.candidate
        )
        _record(connection, int(row["id"]), "matched", match)
        report["matched"] += 1
    return report


def _look_up(connection: Any, client: FilmwebClient, lookup: dict[str, Any]) -> tuple[str, int]:
    """Look one work up and write the outcome; the outcome and how many files moved."""
    subject = SearchSubject(
        title=str(lookup["query_title"]),
        year=int(lookup["query_year"]) if lookup["query_year"] else None,
        is_episode=bool(lookup["is_episode"]),
        group_key=str(lookup["subject_key"]),
    )
    root_id = int(lookup["root_id"])
    subject_hash = bytes(lookup["subject_hash"])
    match = client.lookup(subject, duration_ms=_longest_duration(connection, root_id, subject_hash))
    if match.accepted and match.candidate is not None:
        updated = apply_match(connection, root_id=root_id, subject_hash=subject_hash, candidate=match.candidate)
        _record(connection, int(lookup["id"]), "matched", match)
        return "matched", updated
    if match.candidate is not None:
        _record(connection, int(lookup["id"]), "review", match)
        return "review", 0
    _record(connection, int(lookup["id"]), "none", match)
    return "none", 0


def enqueue_only(database: DatabaseConfig, root_slug: str) -> int:
    """Open the lookup rows and stop, so the queue can be sized before any request."""
    with _connect(database) as connection:
        root = _root_id(connection, root_slug)
        prune_orphaned_lookups(connection, root_id=root)
        return enqueue_title_lookups(connection, root_id=root)


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
        pruned = prune_orphaned_lookups(connection, root_id=root)
        opened = enqueue_title_lookups(connection, root_id=root)
        reopened = reopen_stale_lookups(connection, root_id=root, days=recheck_days)

    report = run_title_worker(
        database=database, cache_path=cache_path, limit=limit, min_interval=min_interval, root_id=root
    )
    report["pruned"] = pruned
    report["opened"] = opened
    report["reopened"] = reopened
    return report


def run_title_worker(
    *,
    database: DatabaseConfig,
    cache_path: Path,
    limit: int = 50,
    min_interval: float = 1.2,
    root_id: int | None = None,
    client: FilmwebClient | None = None,
) -> dict[str, Any]:
    """
    Drain part of the lookup queue and report what happened to each work.

    `limit` is deliberately small by default. There are around two thousand
    works in this library, and doing them in batches spread over time is both
    kinder to Filmweb and easier to stop when something looks wrong. With
    `root_id`, only that source's works are looked up.
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
        "rescored": 0,
        "settled_from_review": 0,
        "dismissed_from_review": 0,
    }
    client = client or FilmwebClient(cache_path=cache_path, min_interval=min_interval)
    try:
        with _connect(database) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK(%s, 0) AS acquired", (_LOCK_NAME,))
                row = cursor.fetchone()
            if not row or int(row["acquired"] or 0) != 1:
                raise TitleWorkerError("Another title lookup worker is already running")
            try:
                # The backlog first: free, local, and it may empty the review list
                # the owner would otherwise be reading row by row.
                settled = rescore_reviews(connection, root_id)
                report["rescored"] = settled["rescored"]
                report["settled_from_review"] = settled["matched"]
                report["dismissed_from_review"] = settled["dismissed"]
                report["items_updated"] += settled["items_updated"]
                report["status"] = "completed"
                unavailable = 0
                for lookup in _pending_lookups(connection, limit, root_id):
                    report["claimed"] += 1
                    try:
                        outcome, updated = _look_up(connection, client, lookup)
                    except _FATAL_DATABASE_ERRORS:
                        raise
                    except Exception as exc:  # noqa: BLE001 - one record must not stop the queue
                        # Anything at all: the parser choking on a record, a value
                        # the database refuses. It used to be only FilmwebError,
                        # and anything else ended the run — on the same row, the
                        # first in line, every run until its cached answer expired.
                        error = str(exc) if isinstance(exc, FilmwebError) else f"{type(exc).__name__}: {exc}"
                        delay = _record_failure(connection, lookup, error)
                        report["failed"] += 1
                        LOGGER.warning(
                            "title lookup failed",
                            extra={
                                "event": "title_lookup_failed",
                                "lookup": int(lookup["id"]),
                                "retry_seconds": delay,
                                "error": error[:500],
                            },
                        )
                        unavailable = unavailable + 1 if isinstance(exc, FilmwebUnavailable) else 0
                        if unavailable >= _UNAVAILABLE_STREAK:
                            report["status"] = "interrupted"
                            report["stopped"] = "Filmweb is not answering"
                            break
                        continue
                    unavailable = 0
                    report[outcome] += 1
                    report["items_updated"] += updated
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
