from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from pathlib import Path

import uvicorn

from .app import create_app
from .catalog import CatalogError, scan_catalog
from .config import PROJECT_ROOT, AppConfig, ConfigError, load_config
from .database import MigrationError, apply_migrations, check_database
from .maintenance import STEPS, run_maintenance
from .metadata_worker import MetadataWorkerError, run_metadata_worker
from .observability import configure_logging, default_log_dir
from .probe import ProbeError, ffprobe_for
from .security import GrantItem, seal_grant
from .title_worker import TitleWorkerError, enqueue_only, run_title_lookups


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="media-server", description="TryHackX Media Server")
    parser.add_argument("--config", help="Ścieżka do config.local.toml")
    commands = parser.add_subparsers(dest="command")

    commands.add_parser("serve", help="Uruchom usługę transferową")
    check = commands.add_parser("check", help="Sprawdź konfigurację i źródła")
    check.add_argument("--database", action="store_true", help="Sprawdź również połączenie z bazą")

    migrate = commands.add_parser("migrate", help="Zastosuj oczekujące migracje jednej bazy")
    migrate.add_argument("--dir", type=Path, help="Katalog migracji")

    scan = commands.add_parser("scan", help="Analyze or update the media catalog")
    scan.add_argument("--root", required=True, help="Configured root identifier")
    scan.add_argument("--kind", required=True, choices=("music", "movies", "mixed"))
    scan.add_argument("--metadata", action="store_true", help="Queue audio tags for new and changed files")
    scan.add_argument("--batch-size", type=int, default=500)
    scan.add_argument("--apply", action="store_true", help="Write the analyzed changes")
    scan.add_argument("--allow-mass-missing", action="store_true", help="Confirm an unusually large removal")

    metadata_worker = commands.add_parser(
        "metadata-worker", help="Process queued audio tags and video probes safely"
    )
    metadata_worker.add_argument("--limit", type=int, default=100)
    metadata_worker.add_argument("--timeout-seconds", type=float, default=15.0)

    title_worker = commands.add_parser(
        "title-worker", help="Look up genre and release year for films and series"
    )
    title_worker.add_argument("--root", required=True, help="Configured root identifier")
    title_worker.add_argument("--limit", type=int, default=50, help="How many works to look up in this run")
    title_worker.add_argument(
        "--min-interval", type=float, default=1.2, help="Seconds to wait between requests"
    )
    title_worker.add_argument("--enqueue-only", action="store_true", help="Open lookup rows and stop")

    maintenance = commands.add_parser(
        "maintenance", help="Jeden przebieg okresowy: skan, kolejka metadanych, gatunki filmów"
    )
    maintenance.add_argument(
        "--only",
        help=f"Lista kroków rozdzielona przecinkami spośród: {', '.join(STEPS)}",
    )
    maintenance.add_argument("--scan-batch", type=int, default=500)
    maintenance.add_argument("--metadata-limit", type=int, default=500)
    maintenance.add_argument("--metadata-timeout-seconds", type=float, default=15.0)
    maintenance.add_argument("--titles-limit", type=int, default=50)
    maintenance.add_argument(
        "--titles-min-interval", type=float, default=1.2, help="Odstęp między zapytaniami do Filmwebu"
    )

    token = commands.add_parser("token", help="Wygeneruj token diagnostyczny")
    token_commands = token.add_subparsers(dest="token_kind", required=True)
    file_token = token_commands.add_parser("file")
    file_token.add_argument("root")
    file_token.add_argument("path")
    file_token.add_argument("--name")
    file_token.add_argument("--ttl", type=int, default=300)
    file_token.add_argument("--inline", action="store_true")
    file_token.add_argument("--subject")
    file_token.add_argument("--max-streams", type=int, default=0, help="Limit równoczesnych strumieni trybu zgodnego")
    file_token.add_argument("--max-downloads", type=int, default=0, help="Limit równoczesnych pobrań konta")

    archive_token = token_commands.add_parser("archive")
    archive_token.add_argument("--item", action="append", required=True, metavar="ROOT=RELATIVE_PATH")
    archive_token.add_argument("--name", default="media.zip")
    archive_token.add_argument("--ttl", type=int, default=300)
    archive_token.add_argument("--subject")
    archive_token.add_argument("--max-downloads", type=int, default=0, help="Limit równoczesnych pobrań konta")
    return parser


def _load(selected: str | None) -> AppConfig:
    return load_config(selected)


def _ffmpeg_report(config: AppConfig) -> dict[str, str | bool | None]:
    """
    Whether the two binaries the media features stand on are actually reachable.

    Without them the installation still passes every other check — the service
    starts, the catalogue scans, the frontend builds — and then quietly produces
    no thumbnails, no video facts, no picture subtitles and no compatibility
    streams. That is worth one line of output rather than a discovery weeks later.
    """
    configured = config.stereo.ffmpeg_path
    if configured is None:
        return {"configured": None, "ffmpeg": None, "ffprobe": None}
    executable = Path(configured)
    resolved = str(executable) if executable.is_absolute() and executable.exists() else shutil.which(configured)
    probe = ffprobe_for(configured)
    return {"configured": configured, "ffmpeg": resolved, "ffprobe": str(probe) if probe else None}


def _check(config: AppConfig, with_database: bool) -> int:
    roots = {}
    ready = True
    for root_id, path in config.roots.items():
        exists = path.exists() and path.is_dir()
        roots[root_id] = {"ready": exists}
        ready = ready and exists
    database_status = "not_checked"
    if with_database:
        check_database(config.database)
        database_status = "ready"
    ffmpeg = _ffmpeg_report(config)
    print(json.dumps(
        {"config": str(config.source_path), "roots": roots, "database": database_status, "ffmpeg": ffmpeg},
        indent=2,
    ))
    # A warning, not a failure: a catalogue-only installation is a legitimate
    # state, and refusing to start over a missing optional binary would be worse
    # than saying plainly what stops working.
    if ffmpeg["ffmpeg"] is None or ffmpeg["ffprobe"] is None:
        print(
            "Uwaga: nie znaleziono FFmpeg/ffprobe — bez nich nie ma miniatur, danych o ścieżkach\n"
            "wideo, napisów obrazkowych ani trybu zgodnego. Wskaż je przez stereo.ffmpeg_path\n"
            "albo dopisz do PATH.",
            file=sys.stderr,
        )
    return 0 if ready else 2


def _title_worker(args: argparse.Namespace, config: AppConfig) -> int:
    """
    Open lookup rows for a root, then work through some of them.

    Enqueueing and looking up are one command because they are one intention —
    "find out what these films are" — but --enqueue-only exists so the size of
    the queue can be seen before a single request leaves the machine.
    """
    cache_path = PROJECT_ROOT / "runtime" / "filmweb-cache"
    if args.enqueue_only:
        report = {"status": "queued", "opened": enqueue_only(config.database, args.root)}
    else:
        report = run_title_lookups(
            database=config.database,
            root_slug=args.root,
            cache_path=cache_path,
            limit=args.limit,
            min_interval=args.min_interval,
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _bounded(value: float, name: str, minimum: float, maximum: float) -> None:
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} musi mieścić się w zakresie {minimum:g}..{maximum:g}")


def _maintenance(args: argparse.Namespace, config: AppConfig) -> int:
    """
    One scheduled run of everything that has to happen regularly.

    Exits non-zero when any step failed, so a systemd timer or a scheduled task
    reports it instead of quietly succeeding every night; the report still lists
    what did work, because a failed lookup does not undo a finished scan.
    """
    steps = STEPS
    if args.only:
        steps = tuple(name.strip() for name in args.only.split(",") if name.strip())
        unknown = sorted(set(steps) - set(STEPS))
        if unknown:
            raise ValueError("Nieznane kroki: " + ", ".join(unknown))
    # Sprawdzane tutaj, a nie w środku przebiegu: workery mają własne zakresy
    # i odrzucają złą wartość dopiero, gdy do nich dojdzie — czyli po skanie
    # i kolejce metadanych, które zdążyły już zrobić swoje. Pominięcie kroku
    # to `--only`, a nie limit zero.
    _bounded(args.scan_batch, "--scan-batch", 10, 5000)
    _bounded(args.metadata_limit, "--metadata-limit", 1, 100000)
    _bounded(args.metadata_timeout_seconds, "--metadata-timeout-seconds", 1, 600)
    _bounded(args.titles_limit, "--titles-limit", 1, 5000)
    _bounded(args.titles_min_interval, "--titles-min-interval", 0, 60)
    report = run_maintenance(
        config=config,
        steps=steps,
        scan_batch_size=args.scan_batch,
        metadata_limit=args.metadata_limit,
        metadata_timeout_seconds=args.metadata_timeout_seconds,
        titles_limit=args.titles_limit,
        titles_min_interval=args.titles_min_interval,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "ok" else 1


def _diagnostic_token(args: argparse.Namespace, config: AppConfig) -> int:
    if args.token_kind == "file":
        items = [GrantItem(root=args.root, path=args.path)]
        name = args.name or Path(args.path.replace("\\", "/")).name or "media"
        kind = "file"
        disposition = "inline" if args.inline else "attachment"
    else:
        items = []
        for raw in args.item:
            root, separator, relative = raw.partition("=")
            if not separator or not root or not relative:
                raise ValueError("--item wymaga formatu ROOT=RELATIVE_PATH")
            items.append(GrantItem(root=root, path=relative))
        name = args.name
        kind = "archive"
        disposition = "attachment"
    token = seal_grant(
        key=config.security.transfer_key,
        kind=kind,
        items=items,
        download_name=name,
        ttl_seconds=args.ttl,
        disposition=disposition,
        subject=args.subject,
        max_streams=getattr(args, "max_streams", 0),
        max_downloads=args.max_downloads,
    )
    if len(token.encode("utf-8")) > config.security.max_token_bytes:
        raise ValueError("Token przekracza skonfigurowany limit; użyj mniejszego zestawu")
    print(token)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    command = args.command or "serve"
    try:
        config = _load(args.config)
        if command == "serve":
            configure_logging(default_log_dir(config.source_path))
            logging.getLogger("media_server").info(
                "service starting",
                extra={"event": "service_starting"},
            )
            uvicorn.run(
                create_app(config),
                host=config.server.host,
                port=config.server.port,
                access_log=False,
                server_header=False,
                proxy_headers=False,
                log_config=None,
            )
            logging.getLogger("media_server").info(
                "service stopped",
                extra={"event": "service_stopped"},
            )
            return 0
        if command == "check":
            return _check(config, args.database)
        if command == "migrate":
            migration_dir = args.dir or Path(__file__).resolve().parents[2] / "migrations"
            applied = apply_migrations(config.database, migration_dir)
            print(json.dumps({"applied": applied, "status": "ok"}, indent=2))
            return 0
        if command == "scan":
            root_path = config.roots.get(args.root)
            if root_path is None:
                raise ValueError("The configured media root does not exist")
            report = scan_catalog(
                database=config.database,
                root_slug=args.root,
                root_path=root_path,
                root_kind=args.kind,
                apply=args.apply,
                metadata_enabled=args.metadata,
                batch_size=args.batch_size,
                allow_mass_missing=args.allow_mass_missing,
            )
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        if command == "metadata-worker":
            report = run_metadata_worker(
                database=config.database,
                roots=config.roots,
                limit=args.limit,
                timeout_seconds=args.timeout_seconds,
                ffprobe_path=ffprobe_for(config.stereo.ffmpeg_path),
            )
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        if command == "title-worker":
            return _title_worker(args, config)
        if command == "maintenance":
            return _maintenance(args, config)
        if command == "token":
            return _diagnostic_token(args, config)
        parser.error("Nieznane polecenie")
    except (
        CatalogError,
        ConfigError,
        MetadataWorkerError,
        MigrationError,
        TitleWorkerError,
        OSError,
        ProbeError,
        ValueError,
    ) as exc:
        print(f"Błąd: {exc}", file=sys.stderr)
        return 1
    return 1
