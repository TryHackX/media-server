"""One command for everything that has to happen regularly.

Until now the catalogue scan, the metadata queue and the film lookups were three
buttons in the panel and three commands in a shell — which means they ran when
somebody remembered. A scheduler needs a single entry point, and this is it.

Three rules shape it. **Every step is bounded**: a run takes a batch, not the
whole queue, so a nightly job finishes in minutes and the next one continues
where this one stopped. **A failing step does not cancel the rest**: a Filmweb
outage must not stop the metadata queue, so each step is caught, recorded and
the run goes on. And **nothing here decides what a library is**: the kind of a
root (music, movies, mixed) comes from ``media_roots``, written by the first
scan; a root nobody has scanned yet is reported as skipped rather than guessed
from its name, because ``archiwum`` says nothing about what is inside.

Overlapping runs are the scheduler's job, not this module's: a systemd unit
cannot run twice at once, and the Windows task is registered with
``-MultipleInstances IgnoreNew``.
"""
from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

import pymysql

from .catalog import CatalogError, scan_catalog
from .config import PROJECT_ROOT, AppConfig
from .database import _connect
from .metadata_worker import MetadataWorkerError, run_metadata_worker
from .probe import ProbeError, ffprobe_for
from .title_worker import TitleWorkerError, run_title_lookups

STEPS: tuple[str, ...] = ("scan", "metadata", "titles")

# Everything a step may legitimately fail with. Anything else is a bug and has
# to reach the operator as a traceback rather than as a tidy JSON line.
_STEP_FAILURES = (
    CatalogError,
    MetadataWorkerError,
    TitleWorkerError,
    ProbeError,
    pymysql.MySQLError,
    OSError,
    ValueError,
)

# Film lookups only make sense where films are.
_TITLE_KINDS = frozenset({"movies", "mixed"})


def _root_kinds(config: AppConfig) -> dict[str, str]:
    """What each enabled root holds, according to the catalogue itself."""
    with _connect(config.database) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT slug, media_kind FROM media_roots WHERE is_enabled = 1")
            return {str(row[0]): str(row[1]) for row in cursor.fetchall()}


def run_maintenance(
    *,
    config: AppConfig,
    steps: tuple[str, ...] = STEPS,
    scan_batch_size: int = 500,
    metadata_limit: int = 500,
    metadata_timeout_seconds: float = 15.0,
    titles_limit: int = 50,
    titles_min_interval: float = 1.2,
) -> dict[str, Any]:
    started = time.monotonic()
    entries: list[dict[str, Any]] = []
    kinds: dict[str, str] = {}

    def record(step: str, status: str, **fields: Any) -> None:
        entries.append({"step": step, "status": status, **fields})

    needs_kinds = "scan" in steps or "titles" in steps
    if needs_kinds:
        try:
            kinds = _root_kinds(config)
        except _STEP_FAILURES as failure:
            record("roots", "failed", error=str(failure))

    if "scan" in steps:
        for root_slug, root_path in sorted(config.roots.items()):
            kind = kinds.get(root_slug)
            if kind is None:
                # Naming the command matters: on a fresh installation every root
                # lands here, so a run that only says "skipped" looks like the
                # scheduler works while nothing is ever indexed.
                record(
                    "scan",
                    "skipped",
                    root=root_slug,
                    reason=(
                        "rodzaj źródła nie jest znany — pierwszy skan wybiera go raz: "
                        f"media-server scan --root {root_slug} --kind music|movies|mixed --apply"
                    ),
                )
                continue
            try:
                report = scan_catalog(
                    database=config.database,
                    root_slug=root_slug,
                    root_path=root_path,
                    root_kind=kind,
                    apply=True,
                    metadata_enabled=True,
                    batch_size=scan_batch_size,
                    # A scheduled job never confirms a mass removal: an unmounted
                    # drive looks exactly like a library somebody emptied.
                    allow_mass_missing=False,
                )
            except _STEP_FAILURES as failure:
                record("scan", "failed", root=root_slug, error=str(failure))
            else:
                record("scan", "ok", root=root_slug, report=report)

    if "metadata" in steps:
        try:
            report = run_metadata_worker(
                database=config.database,
                roots=config.roots,
                limit=metadata_limit,
                timeout_seconds=metadata_timeout_seconds,
                ffprobe_path=ffprobe_for(config.stereo.ffmpeg_path),
            )
        except _STEP_FAILURES as failure:
            record("metadata", "failed", error=str(failure))
        else:
            record("metadata", "ok", report=report)

    if "titles" in steps:
        cache_path = PROJECT_ROOT / "runtime" / "filmweb-cache"
        for root_slug in sorted(config.roots):
            if kinds.get(root_slug) not in _TITLE_KINDS:
                continue
            try:
                report = run_title_lookups(
                    database=config.database,
                    root_slug=root_slug,
                    cache_path=cache_path,
                    limit=titles_limit,
                    min_interval=titles_min_interval,
                )
            except _STEP_FAILURES as failure:
                record("titles", "failed", root=root_slug, error=str(failure))
            else:
                record("titles", "ok", root=root_slug, report=report)

    failed = sum(1 for entry in entries if entry["status"] == "failed")
    return {
        "status": "partial" if failed else "ok",
        "finished_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "seconds": round(time.monotonic() - started, 3),
        "failed": failed,
        "steps": entries,
    }
