"""A record of what the server actually did, minute by minute.

``/health/status`` has always answered "right now": how many transfers are open,
how many bytes have gone out since the process started. That is the wrong tense
for most questions an operator has. "Was anything streaming at three in the
morning", "did the cache stop growing", "is today busier than last Tuesday" all
need yesterday's numbers, and yesterday's numbers were gone the moment the
service restarted.

So one line a minute goes to ``runtime/stats/history.jsonl``. It is deliberately
a file rather than a table: this is the service's own diary, it is written even
when the database is unreachable, and a week of it is about a megabyte.

Two details are worth stating outright.

**Samples carry deltas, not the running totals.** The counters in
:class:`RuntimeMetrics` reset when the process does, so a chart drawn from them
would show a cliff at every restart. The sampler subtracts the previous reading
and, when it sees the counters go *backwards*, treats that as a restart and
starts again from zero rather than emitting a negative minute.

**The cache is measured rarely.** Walking ~18 000 thumbnails takes seconds, and
doing it every minute would make the diary the most expensive thing the server
does. It is measured every ``CACHE_EVERY`` samples and carried forward in
between, which is honest at the resolution anybody reads it: a cache that grows
by megabytes an hour does not need a per-minute figure.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# One line a minute for a week. Trimming happens well past that so a busy file
# is rewritten occasionally rather than on nearly every append.
RETENTION_SAMPLES = 7 * 24 * 60
TRIM_AT = int(RETENTION_SAMPLES * 1.5)

#: How many samples pass between two walks of the cache directories.
CACHE_EVERY = 30


def directory_size(path: Path | None) -> tuple[int, int]:
    """Bytes and file count under ``path``; zeros for anything unreadable.

    A cache directory is a cache: files disappear underneath the walk, and that
    is not an error worth failing a measurement over.
    """
    if path is None:
        return (0, 0)
    total = 0
    files = 0
    try:
        for root, _, names in os.walk(path):
            for name in names:
                try:
                    total += (Path(root) / name).stat().st_size
                    files += 1
                except OSError:
                    continue
    except OSError:
        return (0, 0)
    return (total, files)


@dataclass(slots=True)
class StatsSampler:
    """Turns the live counters into a diary of one-minute differences."""

    path: Path
    caches: Mapping[str, Path | None] = field(default_factory=dict)
    interval_seconds: int = 60
    _previous: dict[str, int] = field(default_factory=dict, init=False)
    _cache_sizes: dict[str, dict[str, int]] = field(default_factory=dict, init=False)
    _samples_taken: int = field(default=0, init=False)

    def sample(self, snapshot: Mapping[str, object], *, now: datetime | None = None) -> dict[str, object]:
        """One row of the diary, from one reading of the counters."""
        counters = {
            "requests": int(snapshot.get("requests_total", 0) or 0),
            "transfers": int(snapshot.get("transfers_started", 0) or 0),
            "bytes": int(snapshot.get("bytes_streamed", 0) or 0),
            "errors": int(snapshot.get("responses_5xx", 0) or 0),
        }
        # A counter that went backwards means the process restarted between two
        # samples. The minute in between is unknowable, so it is reported as
        # nothing happening rather than as a spike or a negative.
        restarted = bool(self._previous) and any(
            counters[name] < self._previous.get(name, 0) for name in counters
        )
        deltas = {
            name: 0 if restarted or not self._previous else max(0, value - self._previous.get(name, 0))
            for name, value in counters.items()
        }
        self._previous = counters
        if self._samples_taken % CACHE_EVERY == 0:
            self._cache_sizes = {
                name: dict(zip(("bytes", "files"), directory_size(path), strict=True))
                for name, path in self.caches.items()
            }
        self._samples_taken += 1
        return {
            "at": (now or datetime.now(UTC)).isoformat(timespec="seconds"),
            "active": int(snapshot.get("transfers_active", 0) or 0),
            "requests": deltas["requests"],
            "transfers": deltas["transfers"],
            "bytes": deltas["bytes"],
            "errors": deltas["errors"],
            "restarted": restarted,
            "cache": dict(self._cache_sizes),
        }

    def append(self, row: Mapping[str, object]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._trim()

    def history(self, hours: int = 24, *, now: float | None = None) -> list[dict[str, object]]:
        """Samples from the last ``hours``, oldest first."""
        cutoff = (now if now is not None else time.time()) - max(1, hours) * 3600
        rows: list[dict[str, object]] = []
        for row in self._read():
            stamp = _timestamp(row.get("at"))
            if stamp is not None and stamp >= cutoff:
                rows.append(row)
        return rows

    def _read(self) -> Iterable[dict[str, object]]:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(row, dict):
                        yield row
        except OSError:
            return

    def _trim(self) -> None:
        """Keep the file bounded without rewriting it on every append."""
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                lines = handle.readlines()
        except OSError:
            return
        if len(lines) <= TRIM_AT:
            return
        keep = lines[-RETENTION_SAMPLES:]
        temporary = self.path.with_suffix(".tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                handle.writelines(keep)
            temporary.replace(self.path)
        except OSError:
            temporary.unlink(missing_ok=True)


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def summarise(rows: list[dict[str, object]]) -> dict[str, object]:
    """Totals for the window, so the panel does not add up hundreds of rows."""
    return {
        "samples": len(rows),
        "bytes": sum(int(row.get("bytes", 0) or 0) for row in rows),
        "transfers": sum(int(row.get("transfers", 0) or 0) for row in rows),
        "requests": sum(int(row.get("requests", 0) or 0) for row in rows),
        "errors": sum(int(row.get("errors", 0) or 0) for row in rows),
        "peak_active": max((int(row.get("active", 0) or 0) for row in rows), default=0),
        "restarts": sum(1 for row in rows if row.get("restarted") is True),
    }
