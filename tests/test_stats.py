from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from media_server.stats import RETENTION_SAMPLES, TRIM_AT, StatsSampler, directory_size, summarise


def snapshot(**counters: int) -> dict[str, int]:
    base = {
        "requests_total": 0,
        "transfers_started": 0,
        "bytes_streamed": 0,
        "responses_5xx": 0,
        "transfers_active": 0,
    }
    return base | counters


def test_first_sample_reports_nothing_rather_than_everything(tmp_path: Path) -> None:
    """A server that has been up for a week must not report that week as one minute."""
    sampler = StatsSampler(path=tmp_path / "history.jsonl")
    row = sampler.sample(snapshot(requests_total=98_000, bytes_streamed=5 * 1024**3))
    assert row["requests"] == 0
    assert row["bytes"] == 0


def test_sample_reports_the_difference_between_readings(tmp_path: Path) -> None:
    sampler = StatsSampler(path=tmp_path / "history.jsonl")
    sampler.sample(snapshot(requests_total=100, bytes_streamed=1000, transfers_started=2))
    row = sampler.sample(snapshot(requests_total=140, bytes_streamed=4000, transfers_started=3, transfers_active=1))
    assert row["requests"] == 40
    assert row["bytes"] == 3000
    assert row["transfers"] == 1
    assert row["active"] == 1
    assert row["restarted"] is False


def test_a_restart_is_a_gap_not_a_negative_minute(tmp_path: Path) -> None:
    """Counters reset with the process; the minute across that is unknowable."""
    sampler = StatsSampler(path=tmp_path / "history.jsonl")
    sampler.sample(snapshot(requests_total=5000, bytes_streamed=9_000_000))
    row = sampler.sample(snapshot(requests_total=12, bytes_streamed=4096))
    assert row["restarted"] is True
    assert row["requests"] == 0
    assert row["bytes"] == 0
    # And the reading after the restart measures from the new baseline.
    following = sampler.sample(snapshot(requests_total=30, bytes_streamed=8192))
    assert following["restarted"] is False
    assert following["requests"] == 18
    assert following["bytes"] == 4096


def test_cache_is_measured_rarely_and_carried_forward(tmp_path: Path) -> None:
    """Walking 18 000 thumbnails every minute would cost more than it tells."""
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "a.bin").write_bytes(b"x" * 10)
    sampler = StatsSampler(path=tmp_path / "history.jsonl", caches={"thumbnails": cache})
    first = sampler.sample(snapshot())
    assert first["cache"] == {"thumbnails": {"bytes": 10, "files": 1}}
    (cache / "b.bin").write_bytes(b"x" * 90)
    second = sampler.sample(snapshot())
    # Same figure, not a fresh walk: the next measurement is 30 samples away.
    assert second["cache"] == {"thumbnails": {"bytes": 10, "files": 1}}


def test_history_returns_only_the_window_asked_for(tmp_path: Path) -> None:
    path = tmp_path / "history.jsonl"
    sampler = StatsSampler(path=path)
    now = datetime.now(UTC)
    for minutes, marker in ((5, "fresh"), (90, "old"), (60 * 30, "ancient")):
        sampler.append({"at": (now - timedelta(minutes=minutes)).isoformat(timespec="seconds"), "marker": marker})
    recent = sampler.history(hours=1)
    assert [row["marker"] for row in recent] == ["fresh"]
    assert [row["marker"] for row in sampler.history(hours=24)] == ["fresh", "old"]


def test_history_survives_a_half_written_line(tmp_path: Path) -> None:
    """A diary written by a process that can be killed must still read back."""
    path = tmp_path / "history.jsonl"
    sampler = StatsSampler(path=path)
    sampler.append({"at": datetime.now(UTC).isoformat(timespec="seconds"), "bytes": 7})
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"at": "2026-08-16T20:0')
    assert [row["bytes"] for row in sampler.history(hours=1)] == [7]


def test_the_file_is_trimmed_but_only_when_it_grows_past_the_slack(tmp_path: Path) -> None:
    path = tmp_path / "history.jsonl"
    sampler = StatsSampler(path=path)
    stamp = datetime.now(UTC).isoformat(timespec="seconds")
    lines = [json.dumps({"at": stamp, "n": index}) + "\n" for index in range(TRIM_AT + 5)]
    path.write_text("".join(lines), encoding="utf-8")
    sampler.append({"at": stamp, "n": -1})
    kept = path.read_text(encoding="utf-8").splitlines()
    assert len(kept) == RETENTION_SAMPLES
    # The newest lines are the ones that survive.
    assert json.loads(kept[-1])["n"] == -1


def test_directory_size_shrugs_at_what_it_cannot_read(tmp_path: Path) -> None:
    assert directory_size(None) == (0, 0)
    assert directory_size(tmp_path / "not-here") == (0, 0)


def test_summarise_adds_up_the_window(tmp_path: Path) -> None:
    rows = [
        {"bytes": 10, "transfers": 1, "requests": 5, "errors": 0, "active": 2, "restarted": False},
        {"bytes": 30, "transfers": 2, "requests": 7, "errors": 1, "active": 5, "restarted": True},
    ]
    assert summarise(rows) == {
        "samples": 2, "bytes": 40, "transfers": 3, "requests": 12,
        "errors": 1, "peak_active": 5, "restarts": 1,
    }
