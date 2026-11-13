"""The scanner against MySQL (tests/bridge_harness.py): what it writes that only a real database shows.

`media_items.created_at` — when the catalogue first met a file (migration 049).
"Recently added", the "newest first" order of smart lists and the weekly digest all
read it (C-01): it must not move when a scan sees the file again, and a file that was
only renamed or moved must keep the date it had. And the stored MIME type, which
comes from the server's own table (T-07) and is brought in line by every scan.
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from media_server.catalog import CatalogError, _validate_schema
from media_server.metadata_worker import run_metadata_worker

FILES = ["Album/01 - One.mp3", "Album/02 - Two.mp3", "Other/Keep.mp3"]


def _dates(bridge_db) -> dict[str, object]:
    rows = bridge_db.rows("SELECT relative_path, created_at FROM media_items WHERE deleted_at IS NULL")
    return {str(row["relative_path"]): row["created_at"] for row in rows}


def test_a_rescan_leaves_the_date_alone(bridge_db, bridge_library) -> None:
    bridge_library.scan("music", "music", FILES)
    bridge_db.execute(
        "UPDATE media_items SET created_at = DATE_SUB(created_at, INTERVAL 30 DAY),"
        " indexed_at = DATE_SUB(indexed_at, INTERVAL 30 DAY)"
    )
    before = _dates(bridge_db)
    indexed = bridge_db.value("SELECT MAX(indexed_at) FROM media_items")
    report = bridge_library.scan("music", "music")
    assert report["unchanged"] == 3 and report["new"] == 0
    assert _dates(bridge_db) == before
    # `indexed_at` is the other thing: when a scan last saw the file. That one moves every time.
    assert bridge_db.value("SELECT MIN(indexed_at) FROM media_items") > indexed


def test_a_renamed_file_keeps_the_date_it_was_first_catalogued(bridge_db, bridge_library) -> None:
    bridge_library.scan("music", "music", FILES)
    bridge_db.execute("UPDATE media_items SET created_at = DATE_SUB(created_at, INTERVAL 30 DAY)")
    before = _dates(bridge_db)
    root = bridge_library.root_path("music")
    (root / "Album").rename(root / "Album (1999)")                                             # tidied
    (root / "Other" / "Copy.mp3").write_bytes((root / "Other" / "Keep.mp3").read_bytes())     # a second copy
    (root / "Other" / "New.mp3").write_bytes(b"never seen before")                             # news

    report = bridge_library.scan("music", "music")
    assert (report["new"], report["missing"], report["fingerprints"]) == (4, 2, 4)
    after = _dates(bridge_db)
    assert set(after) == {"Album (1999)/01 - One.mp3", "Album (1999)/02 - Two.mp3", "Other/Keep.mp3",
                          "Other/Copy.mp3", "Other/New.mp3"}
    # The same files under a new name: not news.
    assert after["Album (1999)/01 - One.mp3"] == before["Album/01 - One.mp3"]
    assert after["Album (1999)/02 - Two.mp3"] == before["Album/02 - Two.mp3"]
    assert after["Other/Keep.mp3"] == before["Other/Keep.mp3"]
    # A copy of a file that is still where it was is a new file, like any other.
    month = timedelta(days=29)
    assert after["Other/Copy.mp3"] - before["Other/Keep.mp3"] > month
    assert after["Other/New.mp3"] - before["Other/Keep.mp3"] > month

    # Moved back: the date travels with the file again, and never forwards.
    (root / "Album (1999)").rename(root / "Album")
    bridge_library.scan("music", "music")
    again = _dates(bridge_db)
    assert again["Album/01 - One.mp3"] == before["Album/01 - One.mp3"]
    assert again["Other/Copy.mp3"] == after["Other/Copy.mp3"]


class _Columns:
    """A connection that answers the scanner's one question about the schema with the rows it is given."""

    def __init__(self, rows: list[dict[str, str]]) -> None:
        self.rows = rows

    def cursor(self) -> "_Columns":
        return self

    def __enter__(self) -> "_Columns":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, *_: object) -> None:
        return None

    def fetchall(self) -> list[dict[str, str]]:
        return self.rows


def test_a_catalogue_from_before_the_column_is_refused_by_name(bridge_db) -> None:
    """A scan against a database that stops at migration 048 says what is missing instead of failing on SQL."""
    migrated = bridge_db.rows(
        "SELECT table_name AS table_key, column_name AS column_key FROM information_schema.columns"
        " WHERE table_schema = DATABASE()"
        " AND table_name IN ('catalog_scans', 'media_directories', 'media_items', 'media_roots')"
    )
    _validate_schema(_Columns(migrated), "any")
    older = [row for row in migrated if (row["table_key"], row["column_key"]) != ("media_items", "created_at")]
    with pytest.raises(CatalogError, match="media_items: created_at"):
        _validate_schema(_Columns(older), "any")


def test_stored_types_are_brought_in_line_with_the_table(bridge_db, bridge_library) -> None:
    """Rows written when the type came from the machine's registry say audio/x-flac, or nothing at all (T-07)."""
    bridge_library.scan("movies", "mixed", ["a.flac", "b.ts", "c.vob", "d.mkv", "notes.ass", "cover.jpg"])

    def types() -> dict[str, str | None]:
        rows = bridge_db.rows("SELECT relative_path, mime_type FROM media_items")
        return {str(row["relative_path"]): row["mime_type"] for row in rows}

    expected = {"a.flac": "audio/flac", "b.ts": "video/mp2t", "c.vob": "video/mpeg", "d.mkv": "video/x-matroska",
                "notes.ass": "text/plain", "cover.jpg": "image/jpeg"}
    assert types() == expected

    # As an older scan on Windows left them.
    for path, stored in (("a.flac", "audio/x-flac"), ("b.ts", "video/vnd.dlna.mpeg-tts"), ("c.vob", None),
                         ("notes.ass", "audio/aac")):
        bridge_db.execute("UPDATE media_items SET mime_type = %s WHERE relative_path = %s", (stored, path))
    report = bridge_library.scan("movies", "mixed")
    # Nothing about the files changed, so the upsert never saw them; the sweep did.
    assert report["unchanged"] == 6 and types() == expected


def test_finished_readings_leave_the_queue_and_live_failures_stay(bridge_db) -> None:
    """Nothing ever deleted a row of the metadata queue: 38 949 finished readings for 20 000 files (D-01)."""

    def job(item: int, status: str, days_ago: int, *, later: bool = False) -> int:
        row = bridge_db.insert(
            "background_jobs", job_type="metadata", job_key=f"metadata:{item}:{days_ago}:a2", status=status,
            payload_json='{"media_item_id":%d}' % item,
        )
        bridge_db.execute(
            "UPDATE background_jobs SET updated_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL %s DAY),"
            " available_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL %s DAY) WHERE id = %s",
            (days_ago, 1 if later else 0, row),
        )
        return row

    old_done = job(1, "done", 40)
    recent_done = job(2, "done", 5)
    made_good = job(3, "failed", 41)
    made_good_by = job(3, "done", 35)
    still_failing = job(4, "failed", 40)
    made_good_lately = job(5, "failed", 42)
    made_good_lately_by = job(5, "done", 2)
    done_before = job(6, "done", 45)
    failed_after = job(6, "failed", 39)
    recent_failure = job(7, "failed", 3)
    recent_failure_fixed = job(7, "done", 1)
    another_file = job(11, "failed", 44)      # "metadata:11:…" is not made good by a reading of file 111
    its_neighbour = job(111, "done", 4)
    waiting = job(8, "queued", 60, later=True)

    report = run_metadata_worker(database=bridge_db.config, roots={}, limit=5, timeout_seconds=1.0, ffprobe_path=None)
    assert report["status"] == "completed" and report["claimed"] == 0
    left = {int(row["id"]) for row in bridge_db.rows("SELECT id FROM background_jobs")}
    assert left == {recent_done, still_failing, made_good_lately_by, failed_after, recent_failure,
                    recent_failure_fixed, another_file, its_neighbour, waiting}
    gone = {old_done, made_good, made_good_by, made_good_lately, done_before}
    assert report["pruned"] == len(gone) and not (left & gone)
    # A second run finds nothing more to remove.
    again = run_metadata_worker(database=bridge_db.config, roots={}, limit=5, timeout_seconds=1.0, ffprobe_path=None)
    assert again["pruned"] == 0
