from __future__ import annotations

import argparse
import dataclasses
import getpass
import json
import logging
import re
import shutil
import sys
import tomllib
from pathlib import Path
from urllib.parse import urlsplit

import pymysql
import uvicorn

from . import accounts
from .app import create_app
from .cacheprune import CACHES, PruneError, prune_caches
from .catalog import CatalogError, scan_catalog
from .config import PROJECT_ROOT, AppConfig, ConfigError, load_config
from .database import MigrationError, apply_migrations, check_database
from .maintenance import OPTIONAL_STEPS, STEPS, run_maintenance
from .metadata_worker import MetadataWorkerError, run_metadata_worker
from .observability import configure_logging, default_log_dir
from .priority import io_priority
from .probe import ProbeError, ffprobe_for
from .roots import list_roots, sync_roots
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
    migrate.add_argument(
        "--as-user",
        metavar="KONTO",
        help=(
            "Konto bazy z prawem DDL, którym wykonać migracje (np. root) — konto aplikacji ma tylko DML."
            " Hasło: pytanie bez echa albo --password-stdin"
        ),
    )
    migrate.add_argument(
        "--password-stdin",
        action="store_true",
        help="Czytaj hasło konta --as-user z pierwszej linii standardowego wejścia (może być puste)",
    )

    scan = commands.add_parser("scan", help="Analyze or update the media catalog")
    scan.add_argument("--root", required=True, help="Configured root identifier")
    scan.add_argument("--kind", required=True, choices=("music", "movies", "mixed"))
    scan.add_argument("--metadata", action="store_true", help="Queue audio tags for new and changed files")
    scan.add_argument("--batch-size", type=int, default=500)
    scan.add_argument("--apply", action="store_true", help="Write the analyzed changes")
    scan.add_argument("--allow-mass-missing", action="store_true", help="Confirm an unusually large removal")
    scan.add_argument(
        "--fingerprint-limit",
        type=int,
        default=2000,
        help="How many files without a content fingerprint to fill in this run (0..100000, default 2000)",
    )

    roots = commands.add_parser(
        "roots",
        help="Źródła mediów: lista oraz zapisanie rodzaju bez skanowania",
        description=(
            "Rodzaj źródła (music, movies, mixed) zapisuje zwykle pierwszy skan. `roots sync` zapisuje go"
            " bez skanowania — przebieg okresowy zajmie się resztą w tle — a z --disable-unconfigured"
            " wyłącza źródła, których nie ma już w konfiguracji (niczego nie usuwa)."
        ),
    )
    roots_commands = roots.add_subparsers(dest="roots_command", required=True)
    roots_commands.add_parser("list", help="Źródła z konfiguracji i z katalogu, z rodzajem")
    roots_sync = roots_commands.add_parser("sync", help="Zapisz rodzaj źródeł bez skanowania")
    roots_sync.add_argument("--kind", action="append", default=[], metavar="ID=RODZAJ")
    roots_sync.add_argument(
        "--disable-unconfigured",
        action="store_true",
        help="Wyłącz źródła zapisane w katalogu, których nie ma już w konfiguracji",
    )

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
        help=(
            f"Lista kroków rozdzielona przecinkami spośród: {', '.join(STEPS)}"
            f" (domyślnie wszystkie te) oraz na życzenie: {', '.join(OPTIONAL_STEPS)}"
        ),
    )
    maintenance.add_argument("--scan-batch", type=int, default=500)
    maintenance.add_argument("--metadata-limit", type=int, default=500)
    maintenance.add_argument("--metadata-timeout-seconds", type=float, default=15.0)
    maintenance.add_argument("--titles-limit", type=int, default=50)
    maintenance.add_argument(
        "--titles-min-interval", type=float, default=1.2, help="Odstęp między zapytaniami do Filmwebu"
    )

    prune = commands.add_parser(
        "cache-prune",
        help="Pokaż (a z --apply usuń) wpisy pamięci podręcznych, o które nie zapyta już żaden plik",
        description=(
            "Miniatury, napisy obrazkowe i napisy WebVTT są nazwane skrótem pliku, z którego powstały."
            " Po zmianie, przeniesieniu albo skasowaniu pliku stary wpis zostaje na zawsze. Bez --apply"
            " polecenie niczego nie usuwa: liczy i pokazuje przykłady."
        ),
    )
    prune.add_argument("--apply", action="store_true", help="Usuń zbędne wpisy (bez tego tylko raport)")
    prune.add_argument(
        "--grace-days", type=float, default=7.0, help="Wpisy młodsze niż tyle dni zostają (domyślnie 7)"
    )
    prune.add_argument("--only", help=f"Lista rozdzielona przecinkami spośród: {', '.join(CACHES)}")
    prune.add_argument(
        "--allow-mass-delete",
        action="store_true",
        help="Potwierdź usunięcie ponad połowy wpisów jednej pamięci podręcznej",
    )

    account = commands.add_parser(
        "account-create",
        help="Załóż konto — na świeżej instalacji pierwsze, z rolą super_admin",
        description=(
            "Zakłada aktywne, potwierdzone konto w systemowej grupie user. Hasło nigdy nie idzie"
            " w wierszu polecenia: pytanie bez echa albo --password-stdin (pierwsza linia wejścia)."
        ),
    )
    account.add_argument("--username", required=True, help="3-32 znaki: litery, cyfry, . _ -")
    account.add_argument("--email", help="Adres e-mail (opcjonalny)")
    account.add_argument("--role", choices=accounts.ROLES, default="super_admin")
    account.add_argument(
        "--password-stdin", action="store_true", help="Czytaj hasło z pierwszej linii standardowego wejścia"
    )
    account.add_argument("--php", help="Plik wykonywalny PHP, który liczy skrót hasła (domyślnie php z PATH)")

    token = commands.add_parser("token", help="Wygeneruj token diagnostyczny")
    token_commands = token.add_subparsers(dest="token_kind", required=True)
    file_token = token_commands.add_parser("file")
    file_token.add_argument("root")
    file_token.add_argument("path")
    file_token.add_argument("--name")
    file_token.add_argument("--ttl", type=int, default=300)
    file_token.add_argument("--inline", action="store_true")
    file_token.add_argument(
        "--purpose",
        choices=("play", "thumb", "compat"),
        help="Cel tokenu inline (domyślnie play); bez --inline token jest zawsze pobraniem (download)",
    )
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


def _normalised_base(value: str) -> str:
    """The path part of a base, always with one trailing slash: `/`, `/media-next/`."""
    path = urlsplit(value).path or "/"
    return path if path.endswith("/") else path + "/"


def _app_base_report(config: AppConfig) -> dict[str, str | bool | None]:
    """
    Whether the two halves of "where the application lives" still say the same thing.

    The frontend is built with a base (`MEDIA_APP_BASE`, the root unless asked
    otherwise) and the bridge builds activation, guest and digest links from
    `[app] base_url`. Nothing connects them, and a disagreement fails in the one
    place nobody is watching: the link inside an e-mail. The application looks
    perfect, and a stranger who tries to sign up lands on a 404 — a failure that
    only shows up as nobody ever registering.
    """
    built_page = PROJECT_ROOT / "public" / "assets" / "build" / "index.html"
    if not built_page.is_file():
        # No build here — a release that ships prebuilt assets, or a checkout
        # that has not run one yet. Nothing to compare, nothing to warn about.
        return {"built": None, "configured": None, "agree": None}
    match = re.search(r'name="media-app-base"\s+content="([^"]*)"', built_page.read_text(encoding="utf-8"))
    built = _normalised_base(match.group(1)) if match else None

    configured_raw: str | None = None
    try:
        raw = tomllib.loads(config.source_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        raw = {}
    section = raw.get("app")
    if isinstance(section, dict) and isinstance(section.get("base_url"), str):
        configured_raw = section["base_url"]
    # Matches the bridge's own default when the section is absent.
    configured = _normalised_base(configured_raw or "/")

    return {
        "built": built,
        "configured": configured_raw or "/",
        "agree": None if built is None else built == configured,
    }


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
    app_base = _app_base_report(config)
    print(json.dumps(
        {
            "config": str(config.source_path),
            "roots": roots,
            "database": database_status,
            "ffmpeg": ffmpeg,
            "app_base": app_base,
        },
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
    if app_base["agree"] is False:
        print(
            f"Uwaga: front zbudowany dla {app_base['built']}, a [app] base_url wskazuje\n"
            f"{app_base['configured']} — linki aktywacyjne i gościnne prowadzą obok aplikacji.\n"
            "Zbuduj front z tą samą ścieżką (MEDIA_APP_BASE) albo popraw base_url.",
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
        unknown = sorted(set(steps) - set(STEPS) - set(OPTIONAL_STEPS))
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


def _read_password(from_stdin: bool) -> str:
    """The new password, from a prompt without echo or from the first line of stdin."""
    if from_stdin:
        raw = sys.stdin.buffer.readline()
        try:
            # A pipe from PowerShell may open with a byte-order mark.
            password = raw.decode("utf-8").removeprefix("\ufeff").rstrip("\r\n")
        except UnicodeDecodeError as exc:
            raise accounts.AccountError("Hasło na wejściu nie jest poprawnym UTF-8.") from exc
        return accounts.validate_password(password)
    if not sys.stdin.isatty():
        raise accounts.AccountError("Brak terminala do zapytania o hasło — podaj je przez --password-stdin.")
    try:
        first = getpass.getpass(f"Hasło (co najmniej {accounts.MINIMUM_PASSWORD_LENGTH} znaków): ")
        accounts.validate_password(first)
        if getpass.getpass("Powtórz hasło: ") != first:
            raise accounts.AccountError("Hasła nie są identyczne.")
    except EOFError as exc:
        raise accounts.AccountError("Przerwano — konto nie zostało założone.") from exc
    return first


def _migration_account(args: argparse.Namespace, config: AppConfig):
    """The account migrations run as: the application's own, or the one named with --as-user.

    The application account holds data rights only, so on an installation set up
    the way the guides say, ``migrate`` as that account stops at the first
    ``CREATE TABLE``. The administrator's password is taken like every other
    password here: never from the command line.
    """
    if not args.as_user:
        if args.password_stdin:
            raise ValueError("--password-stdin dotyczy konta podanego przez --as-user")
        return config.database
    if args.password_stdin:
        raw = sys.stdin.buffer.readline()
        try:
            password = raw.decode("utf-8").removeprefix("\ufeff").rstrip("\r\n")
        except UnicodeDecodeError as exc:
            raise ValueError("Hasło na wejściu nie jest poprawnym UTF-8.") from exc
    elif sys.stdin.isatty():
        password = getpass.getpass(f"Hasło konta {args.as_user} (puste = brak hasła): ")
    else:
        raise ValueError("Brak terminala do zapytania o hasło — podaj je przez --password-stdin.")
    return dataclasses.replace(config.database, user=args.as_user, password=password)


def _roots(args: argparse.Namespace, config: AppConfig) -> int:
    if args.roots_command == "list":
        report = list_roots(config)
    else:
        kinds: dict[str, str] = {}
        for raw in args.kind:
            root_id, separator, kind = raw.partition("=")
            if not separator or not root_id or not kind:
                raise ValueError("--kind wymaga formatu ID=RODZAJ, np. music=music")
            kinds[root_id.strip().lower()] = kind.strip().lower()
        report = sync_roots(config, kinds, disable_unconfigured=args.disable_unconfigured)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _account_create(args: argparse.Namespace, config: AppConfig) -> int:
    username = accounts.validate_username(args.username)
    email = accounts.validate_email(args.email)
    php = accounts.resolve_php(args.php)
    password = _read_password(args.password_stdin)
    password_hash = accounts.php_password_hash(password, php)
    user_id = accounts.create_account(
        config.database, username=username, email=email, password_hash=password_hash, role=args.role
    )
    print(json.dumps({"status": "created", "id": user_id, "username": username, "role": args.role}, ensure_ascii=False))
    return 0


def _diagnostic_token(args: argparse.Namespace, config: AppConfig) -> int:
    purpose = None
    if args.token_kind == "file":
        items = [GrantItem(root=args.root, path=args.path)]
        name = args.name or Path(args.path.replace("\\", "/")).name or "media"
        kind = "file"
        disposition = "inline" if args.inline else "attachment"
        if args.purpose is not None:
            if not args.inline:
                raise ValueError("--purpose dotyczy tokenu inline; pobranie ma zawsze cel download")
            purpose = args.purpose
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
        purpose=purpose,
    )
    if len(token.encode("utf-8")) > config.security.max_token_bytes:
        raise ValueError("Token przekracza skonfigurowany limit; użyj mniejszego zestawu")
    print(token)
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        # Reports go out as JSON with ensure_ascii=False, so one Polish file
        # name — or one diagnostic — is enough to end the command with a
        # UnicodeEncodeError on a console still using the system code page.
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    parser = _parser()
    args = parser.parse_args(argv)
    command = args.command or "serve"
    try:
        config = _load(args.config)
        if command == "serve":
            configure_logging(default_log_dir(config.source_path))
            logging.getLogger("media_server").info(
                "service starting",
                # What it reads the disks at: a scheduled task's default starts it
                # below normal, which every FFmpeg it starts inherits (priority.py).
                extra={"event": "service_starting", "io_priority": io_priority()},
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
            applied = apply_migrations(_migration_account(args, config), migration_dir)
            print(json.dumps({"applied": applied, "status": "ok"}, indent=2))
            return 0
        if command == "scan":
            root_path = config.roots.get(args.root)
            if root_path is None:
                raise ValueError("The configured media root does not exist")
            # Two reads per file (the first and last 64 KiB), about 30 ms each on
            # a spinning disk: a backlog of thousands is minutes, not a night.
            _bounded(args.fingerprint_limit, "--fingerprint-limit", 0, 100000)
            report = scan_catalog(
                database=config.database,
                root_slug=args.root,
                root_path=root_path,
                root_kind=args.kind,
                apply=args.apply,
                metadata_enabled=args.metadata,
                batch_size=args.batch_size,
                allow_mass_missing=args.allow_mass_missing,
                fingerprint_limit=args.fingerprint_limit,
            )
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        if command == "roots":
            return _roots(args, config)
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
        if command == "cache-prune":
            only = CACHES
            if args.only:
                only = tuple(name.strip() for name in args.only.split(",") if name.strip())
            report = prune_caches(
                config=config,
                apply=args.apply,
                grace_days=args.grace_days,
                allow_mass_delete=args.allow_mass_delete,
                only=only,
            )
            print(json.dumps(report, ensure_ascii=False, indent=2))
            # "skipped" (a source is not mounted) and "partial" (a cache was left
            # alone because most of it looked stale) both want a person to look.
            return 0 if report["status"] == "ok" else 1
        if command == "token":
            return _diagnostic_token(args, config)
        if command == "account-create":
            return _account_create(args, config)
        parser.error("Nieznane polecenie")
    except (
        CatalogError,
        ConfigError,
        MetadataWorkerError,
        MigrationError,
        PruneError,
        TitleWorkerError,
        OSError,
        ProbeError,
        ValueError,
    ) as exc:
        print(f"Błąd: {exc}", file=sys.stderr)
        return 1
    except pymysql.MySQLError as exc:
        # A database that is down, or an account it refuses: said in one line.
        # It used to leave as a traceback, which reads like a bug in the program.
        print(f"Błąd bazy danych: {exc}", file=sys.stderr)
        return 1
    return 1


# `python -m media_server.cli …` runs this module as a script; without the guard it
# defined `main` and returned without doing anything (`python -m media_server`
# goes through __main__.py, which always had one).
if __name__ == "__main__":
    raise SystemExit(main())
