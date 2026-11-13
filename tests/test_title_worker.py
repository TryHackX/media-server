"""The title queue: one work that fails must not stop the others, and must come back later."""
from __future__ import annotations

import json
import urllib.error
from pathlib import Path
from typing import Any

import pytest

from media_server import title_worker
from media_server.filmweb import Candidate, FilmwebClient, FilmwebError, FilmwebUnavailable, Match
from media_server.title_worker import retry_delay, run_title_worker


class _Cursor:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection
        self.rowcount = 0
        self._result: list[dict[str, Any]] = []

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def execute(self, sql: str, params: Any = None) -> None:
        flat = " ".join(sql.split())
        self.connection.statements.append((flat, params))
        self._result = [{"acquired": 1}] if "GET_LOCK" in flat else []

    def fetchone(self) -> dict[str, Any] | None:
        return self._result[0] if self._result else None

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._result)


class _Connection:
    def __init__(self) -> None:
        self.statements: list[tuple[str, Any]] = []

    def __enter__(self) -> _Connection:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def cursor(self) -> _Cursor:
        return _Cursor(self)

    def failures(self) -> list[tuple[Any, ...]]:
        return [params for sql, params in self.statements if sql.startswith("UPDATE media_title_lookups SET status = 'failed'")]


def _lookup(lookup_id: int, title: str, attempts: int = 0) -> dict[str, Any]:
    return {
        "id": lookup_id, "root_id": 1, "subject_hash": b"h" * 32, "subject_key": title.lower(),
        "is_episode": 0, "query_title": title, "query_year": 2001, "attempts": attempts,
    }


def _worker(monkeypatch, connection: _Connection, lookups: list[dict[str, Any]]) -> list[tuple[int, str]]:
    recorded: list[tuple[int, str]] = []
    monkeypatch.setattr(title_worker, "_connect", lambda _database: connection)
    monkeypatch.setattr(
        title_worker, "rescore_reviews",
        lambda _connection, _root_id=None: {"rescored": 0, "matched": 0, "dismissed": 0, "items_updated": 0},
    )
    monkeypatch.setattr(title_worker, "_pending_lookups", lambda _connection, _limit, _root_id=None: lookups)
    monkeypatch.setattr(title_worker, "_longest_duration", lambda *_args: None)
    monkeypatch.setattr(
        title_worker, "_record",
        lambda _connection, lookup_id, status, _match, _error=None: recorded.append((lookup_id, status)),
    )
    return recorded


class _Client:
    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.requests_made = 0
        self.asked: list[str] = []

    def lookup(self, subject, *, duration_ms=None) -> Match:
        self.asked.append(subject.title)
        answer = self.answers[subject.title]
        if isinstance(answer, BaseException):
            raise answer
        return answer


def test_one_bad_record_fails_alone_and_the_queue_goes_on(monkeypatch, tmp_path: Path) -> None:
    """Only FilmwebError was caught: anything else ended the run — on the same first row, every run."""
    connection = _Connection()
    lookups = [_lookup(1, "Broken"), _lookup(2, "Good"), _lookup(3, "Odd", attempts=2)]
    recorded = _worker(monkeypatch, connection, lookups)
    client = _Client({
        "Broken": ValueError("invalid literal for int() with base 10: '2006-2010'"),
        "Good": Match(candidate=None, confidence=0, reasons=["nothing found"]),
        "Odd": FilmwebError("Filmweb returned an unreadable record for 7"),
    })

    report = run_title_worker(database=None, cache_path=tmp_path, limit=50, client=client)

    assert client.asked == ["Broken", "Good", "Odd"]
    assert report["status"] == "completed"
    assert (report["claimed"], report["none"], report["failed"]) == (3, 1, 2)
    assert recorded == [(2, "none")]
    # Each failure is pinned on its row, with a pause that grows with the streak.
    failures = connection.failures()
    assert [(params[1], params[2], params[3]) for params in failures] == [(1, 3600, 1), (3, 24 * 3600, 3)]
    assert failures[0][0].startswith("ValueError: invalid literal")


def test_when_filmweb_stops_answering_the_run_stops(monkeypatch, tmp_path: Path) -> None:
    """A dead network is not five hundred bad records."""
    connection = _Connection()
    lookups = [_lookup(index, f"Title {index}") for index in range(1, 7)]
    _worker(monkeypatch, connection, lookups)
    down = FilmwebUnavailable("Filmweb request failed: HTTP 503")
    client = _Client({f"Title {index}": down for index in range(1, 7)})

    report = run_title_worker(database=None, cache_path=tmp_path, limit=50, client=client)

    assert report["status"] == "interrupted" and report["stopped"]
    assert report["claimed"] == 3 and report["failed"] == 3
    assert client.asked == ["Title 1", "Title 2", "Title 3"]


def test_a_database_that_is_gone_ends_the_run(monkeypatch, tmp_path: Path) -> None:
    import pymysql

    connection = _Connection()
    _worker(monkeypatch, connection, [_lookup(1, "One"), _lookup(2, "Two")])
    client = _Client({"One": pymysql.err.OperationalError(2013, "Lost connection"), "Two": None})

    with pytest.raises(title_worker.TitleWorkerError):
        run_title_worker(database=None, cache_path=tmp_path, limit=50, client=client)
    assert client.asked == ["One"]


def test_the_pause_grows_with_each_failure_in_a_row() -> None:
    hour, day = 3600, 24 * 3600
    assert [retry_delay(attempts) for attempts in range(1, 9)] == [
        hour, 6 * hour, day, 3 * day, 7 * day, 30 * day, 30 * day, 30 * day
    ]
    assert retry_delay(0) == hour


def test_a_failed_row_comes_back_when_its_pause_is_over() -> None:
    connection = _Connection()
    title_worker.reopen_stale_lookups(connection, root_id=3, days=90)
    first, second = connection.statements
    assert "status = 'failed'" in first[0] and "retry_at <= CURRENT_TIMESTAMP(6)" in first[0]
    assert first[1] == (3,)
    assert "INTERVAL %s DAY" in second[0] and second[1] == (3, 90)


def test_the_worker_looks_up_only_the_root_it_is_given(monkeypatch, tmp_path: Path) -> None:
    """A run for one source used to drain the pending rows of every source."""
    connection = _Connection()
    title_worker._pending_lookups(connection, 10, 7)
    title_worker._pending_lookups(connection, 10)
    (with_root, with_params), (without_root, without_params) = connection.statements
    assert "root_id = %s" in with_root and with_params == (7, 10)
    assert "root_id" not in without_root.split("FROM")[1] and without_params == (10,)

    seen: dict[str, Any] = {}
    monkeypatch.setattr(title_worker, "_connect", lambda _database: _Connection())
    monkeypatch.setattr(title_worker, "_root_id", lambda _connection, _slug: 7)
    monkeypatch.setattr(title_worker, "enqueue_title_lookups", lambda _connection, root_id: 0)
    monkeypatch.setattr(title_worker, "reopen_stale_lookups", lambda _connection, root_id, days: 0)
    monkeypatch.setattr(title_worker, "run_title_worker", lambda **kwargs: seen.update(kwargs) or {})
    title_worker.run_title_lookups(database=None, root_slug="movies", cache_path=tmp_path)
    assert seen["root_id"] == 7


class _Response:
    def __init__(self, body: Any) -> None:
        self.body = body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def read(self) -> bytes:
        return json.dumps(self.body).encode("utf-8")


def _client(tmp_path: Path, answers: list[Any]) -> tuple[FilmwebClient, list[float]]:
    pauses: list[float] = []
    queue = list(answers)

    def opener(_request, timeout):
        answer = queue.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return _Response(answer)

    return FilmwebClient(cache_path=tmp_path, min_interval=0, opener=opener, sleep=pauses.append), pauses


def _http(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://www.filmweb.pl/api/v1/x", code, "status", None, None)


def test_an_unreadable_record_fails_that_lookup_and_is_not_kept(tmp_path: Path) -> None:
    """Cached for 30 days, the same unreadable answer failed the same row for 30 days."""
    client, _ = _client(tmp_path, [{"year": "2006-2010", "title": {"title": "Seria"}}])
    with pytest.raises(FilmwebError) as failure:
        client.preview(7, "film")
    assert not isinstance(failure.value, FilmwebUnavailable)
    assert list(tmp_path.iterdir()) == []


def test_one_unreadable_candidate_is_one_candidate_fewer(tmp_path: Path) -> None:
    from media_server.naming import SearchSubject

    client, _ = _client(tmp_path, [
        {"searchHits": [{"id": 1, "type": "film", "matchedTitle": "Matrix"},
                        {"id": 2, "type": "film", "matchedTitle": "Matrix"}]},
        {"title": "not an object"},
        {"title": {"title": "Matrix"}, "year": 1999, "duration": 136, "genres": [{"id": 28}]},
    ])
    match = client.lookup(SearchSubject(title="Matrix", year=1999, is_episode=False, group_key="matrix"))
    assert isinstance(match.candidate, Candidate) and match.candidate.filmweb_id == 2


def test_a_dropped_connection_is_tried_once_more(tmp_path: Path) -> None:
    client, pauses = _client(tmp_path, [urllib.error.URLError("reset"), {"searchHits": []}])
    assert client.search("Matrix") == []
    assert client.requests_made == 2 and len(pauses) == 1


def test_filmweb_not_answering_is_told_apart_from_a_bad_record(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, [_http(503), _http(503)])
    with pytest.raises(FilmwebUnavailable):
        client.search("Matrix")

    missing, pauses = _client(tmp_path / "missing", [_http(404)])
    with pytest.raises(FilmwebError) as failure:
        missing.preview(9, "film")
    assert not isinstance(failure.value, FilmwebUnavailable)
    assert pauses == [] and missing.requests_made == 1


def test_a_cache_entry_with_a_broken_date_is_a_miss_not_a_crash(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, [{"searchHits": []}])
    client._cache_file("search-matrix").parent.mkdir(parents=True, exist_ok=True)
    client._cache_file("search-matrix").write_text(json.dumps({"stored_at": "yesterday", "body": {}}), encoding="utf-8")
    assert client.search("Matrix") == []
    assert client.requests_made == 1


class _ScriptedCursor(_Cursor):
    """Answers each read with the next scripted result and keeps what is inserted."""

    def __init__(self, connection: _ScriptedConnection) -> None:
        super().__init__(connection)  # type: ignore[arg-type]
        self.scripted = connection

    def execute(self, sql: str, params: Any = None) -> None:
        super().execute(sql, params)
        self._result = self.scripted.results.pop(0) if self.scripted.results else []

    def executemany(self, sql: str, rows: Any) -> int:
        self.scripted.inserted.extend(rows)
        return len(rows)


class _ScriptedConnection(_Connection):
    def __init__(self, results: list[list[dict[str, Any]]]) -> None:
        super().__init__()
        self.results = results
        self.inserted: list[tuple[Any, ...]] = []

    def cursor(self) -> _ScriptedCursor:  # type: ignore[override]
        return _ScriptedCursor(self)


def test_a_numbered_run_is_opened_as_its_series() -> None:
    """The sweep grouped Smerfy's episodes under the folder; the row asks about the folder too."""
    paths = ["Smerfy/1 - Astrosmerf.avi", "Smerfy/15 - Niesmerfny Raj.avi", "Smerfy/98 - Magiczna Grzechotka.avi"]
    connection = _ScriptedConnection([
        [{"subject_hash": b"s" * 32, "sample_path": paths[1], "item_count": 2, "duration_ms": None}],
        [{"relative_path": path} for path in paths],
    ])

    assert title_worker.enqueue_title_lookups(connection, root_id=3) == 1

    (root_id, _hash, subject_key, is_episode, query_title, query_year, count), = connection.inserted
    assert (root_id, subject_key, is_episode, query_title, query_year, count) == (3, "Smerfy", 1, "Smerfy", None, 2)


def test_only_unanswered_rows_without_a_file_are_dropped() -> None:
    """A regrouped run leaves its per-file rows asking about nothing; a decision or a match stays."""
    connection = _Connection()
    title_worker.prune_orphaned_lookups(connection, root_id=3)
    (sql, params), = connection.statements
    assert sql.startswith("DELETE mtl FROM media_title_lookups AS mtl LEFT JOIN media_items AS mi")
    assert "mi.id IS NULL" in sql and "mi.deleted_at IS NULL" in sql
    assert "mtl.status IN ('pending', 'review', 'none', 'failed')" in sql
    assert "mtl.source <> 'manual'" in sql and "mtl.decided_at IS NULL" in sql
    assert params == (3,)
