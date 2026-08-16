from __future__ import annotations

import json
from typing import Any, Iterable

from .metadata import TAG_SCHEMA
from .probe import PROBE_SCHEMA


def _chunks(values: list[bytes], size: int = 500) -> Iterable[list[bytes]]:
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def _job_key(item_id: int, mtime_ns: int, media_kind: str) -> str:
    """
    What makes a queued reading distinct.

    The key used to be the file and its mtime alone, which is right for "the file
    changed" but wrong for "we changed what we read out of it": after a schema
    bump the scan correctly classified every film as updated, and then the
    INSERT IGNORE matched the job that had already run and queued nothing at all.
    Naming the extraction version makes a bump a new job for the same bytes.
    """
    version = PROBE_SCHEMA if media_kind == "video" else TAG_SCHEMA
    return f"metadata:{item_id}:{mtime_ns}:{media_kind[0]}{version}"


def enqueue_metadata_jobs(
    connection: Any,
    *,
    root_id: int,
    path_hashes: list[bytes],
) -> int:
    unique_hashes = list(dict.fromkeys(path_hashes))
    if not unique_hashes:
        return 0

    inserted = 0
    with connection.cursor() as cursor:
        for group in _chunks(unique_hashes):
            placeholders = ", ".join(["%s"] * len(group))
            cursor.execute(
                f"""
                SELECT id, mtime_ns, media_kind
                FROM media_items
                WHERE root_id = %s AND path_hash IN ({placeholders})
                """,
                (root_id, *group),
            )
            jobs = []
            for row in cursor.fetchall():
                item_id = int(row["id"])
                mtime_ns = int(row["mtime_ns"] or 0)
                jobs.append(
                    (
                        "metadata",
                        _job_key(item_id, mtime_ns, str(row["media_kind"])),
                        json.dumps({"media_item_id": item_id}, separators=(",", ":")),
                    )
                )
            if jobs:
                inserted += cursor.executemany(
                    """
                    INSERT IGNORE INTO background_jobs (job_type, job_key, payload_json)
                    VALUES (%s, %s, %s)
                    """,
                    jobs,
                )
    return inserted
