#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import csv
import getpass
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import venv
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "config.local.toml"


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _absolute_directory(raw: str, label: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label} musi być ścieżką bezwzględną")
    return path


def _root_argument(raw: str) -> tuple[str, Path]:
    root_id, separator, path = raw.partition("=")
    if not separator or not root_id or not path:
        raise argparse.ArgumentTypeError("Źródło wymaga formatu ID=ŚCIEŻKA")
    if not root_id.replace("_", "a").replace("-", "a").isalnum() or not root_id[0].isalpha():
        raise argparse.ArgumentTypeError("ID źródła może zawierać litery, cyfry, _ i -")
    try:
        return root_id.lower(), _absolute_directory(path, f"Źródło {root_id}")
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _base_url_argument(raw: str) -> str:
    """The public address of the application, as activation mail will quote it.

    A relative path is legal and is what a localhost installation uses, but the
    link goes out by e-mail: there it has to be something a stranger can click,
    which means a scheme and a host. Both forms are accepted here, and the one
    that cannot work in mail is the one worth being deliberate about.
    """
    value = raw.strip()
    if value.startswith(("http://", "https://")):
        return value
    if value.startswith("/"):
        return value
    raise argparse.ArgumentTypeError(
        "base_url musi być pełnym adresem (https://twoj.host/) albo ścieżką zaczynającą się od /"
    )


def _proxy_trusted_argument(raw: str) -> str:
    """Addresses of the proxies allowed to say who the client is.

    Checked here rather than at first request, because the failure is silent:
    a typo means the header is ignored, every visitor arrives wearing the
    proxy's address, and login throttling and CAPTCHA quietly stop protecting
    anything. Names are refused on purpose — the bridge compares packed
    addresses and would never match one.
    """
    entries = [entry for entry in re.split(r"[\s,]+", raw.strip()) if entry]
    if not entries:
        raise argparse.ArgumentTypeError("Lista zaufanych proxy nie może być pusta")
    for entry in entries:
        try:
            ipaddress.ip_address(entry)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(
                f"„{entry}” nie jest adresem IP — most porównuje adresy, nie nazwy"
            ) from exc
    return ", ".join(entries)


def _python_in_venv(directory: Path) -> Path:
    return directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _portable_path(path: Path) -> str:
    """Store paths inside the project tree relative to it (POSIX form), so the private
    config keeps working when the whole tree is moved out of DocumentRoot; anything
    outside the tree stays absolute."""
    try:
        return path.resolve().relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return str(path)


def _ffmpeg_config_value(raw: str) -> str:
    # A bare executable name is looked up on PATH; a path is made portable like caches.
    if re.fullmatch(r"[A-Za-z0-9._-]+", raw):
        return raw
    return _portable_path(Path(raw).expanduser())


def _prompt_path(label: str, default: str) -> Path:
    value = input(f"{label} [{default}]: ").strip() or default
    return _absolute_directory(value, label)


def _build_config(
    args: argparse.Namespace,
    roots: dict[str, Path],
    password: str,
    thumbnail_cache: Path,
    subtitle_cache: Path,
) -> str:
    key = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    lines = [
        "[server]",
        'host = "127.0.0.1"',
        f"port = {args.port}",
        "allow_remote_bind = false",
        "",
        "[security]",
        f"transfer_key = {_toml_string(key)}",
        "max_token_ttl_seconds = 900",
        "clock_skew_seconds = 30",
        "max_token_bytes = 65536",
        "",
        "[transfer]",
        "chunk_size_kib = 512",
        "max_concurrent_transfers = 8",
        "queue_timeout_seconds = 10",
        "max_archive_entries = 1000",
        "",
        "# Ścieżki wewnątrz drzewa projektu są zapisywane względnie (rozwiązywane względem",
        "# katalogu projektu), więc przeniesienie całego katalogu nie wymaga edycji.",
        "[thumbnails]",
        f"cache_path = {_toml_string(_portable_path(thumbnail_cache))}",
        "seek_seconds = 120",
        "",
        "[stereo]",
        f"ffmpeg_path = {_toml_string(_ffmpeg_config_value(args.ffmpeg_path))}",
        "bitrate_kbps = 192",
        "video_encoder = \"libx264\"",
        "max_concurrent_jobs = 2",
        "timeout_seconds = 21600",
        f"subtitle_cache_path = {_toml_string(_portable_path(subtitle_cache))}",
        "",
        "[database]",
        f"host = {_toml_string(args.db_host)}",
        f"port = {args.db_port}",
        f"name = {_toml_string(args.db_name)}",
        f"user = {_toml_string(args.db_user)}",
        f"password = {_toml_string(password)}",
    ]
    # Both sections are read by the PHP bridge alone and both are empty by
    # default: the root, and no proxy in front of us. They are written only when
    # asked for, so a local installation keeps a file with nothing to explain.
    if args.base_url:
        lines.extend([
            "",
            "# Publiczny adres aplikacji — stąd biorą się linki aktywacyjne, gościnne",
            "# i przegląd nowości. Musi zgadzać się z bazą, dla której zbudowano front",
            "# (MEDIA_APP_BASE); rozjazd wskaże `media-server check`.",
            "[app]",
            f"base_url = {_toml_string(args.base_url)}",
        ])
    if args.proxy_trusted:
        lines.extend([
            "",
            "# Adresy proxy, którym wolno powiedzieć, kto jest klientem i czym przyszedł.",
            "# Bez tego wpisu limit prób logowania i CAPTCHA widzą wszystkich gości jako",
            "# jeden adres, a most odrzuca ruch z proxy kończącego TLS jako niezabezpieczony.",
            "[proxy]",
            f"trusted = {_toml_string(args.proxy_trusted)}",
        ])
    for root_id, path in sorted(roots.items()):
        lines.extend(["", f"[roots.{root_id}]", f"path = {_toml_string(str(path))}"])
    return "\n".join(lines) + "\n"


def _restrict_config_permissions(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)
        return

    identity = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        row = next(csv.reader([identity.stdout.strip()]))
        current_sid = row[1]
    except (IndexError, StopIteration) as exc:
        raise RuntimeError("Cannot determine the current Windows account SID") from exc
    if not current_sid.startswith("S-1-"):
        raise RuntimeError("Windows returned an invalid account SID")

    subprocess.run(
        [
            "icacls",
            str(path),
            "/inheritance:r",
            "/grant:r",
            f"*{current_sid}:(F)",
            "*S-1-5-18:(F)",
            "*S-1-5-32-544:(F)",
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _python_dependency_commands(python: Path, *, dev: bool, no_lock: bool) -> list[list[str]]:
    """Return the pip invocations that populate the private venv.

    The default path installs pinned, hash-verified dependencies from the universal
    lock (``requirements.lock`` / ``requirements-dev.lock``, generated by
    ``scripts/lock-deps.py``) and then installs the project itself in editable mode
    without build isolation, so the build backend also comes from the lock. ``--no-lock``
    falls back to the version ranges declared in ``pyproject.toml`` (for platforms
    without wheels); it is never chosen implicitly.
    """
    pip = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]
    if no_lock:
        return [pip + ["-e", ".[dev]" if dev else "."]]

    lock_name = "requirements-dev.lock" if dev else "requirements.lock"
    lock_path = PROJECT_ROOT / lock_name
    if not lock_path.is_file():
        raise RuntimeError(
            f"Brak {lock_name}; instalacja musi być reprodukowalna. "
            "Wygeneruj lock przez scripts/lock-deps.py albo użyj jawnie --no-lock."
        )
    return [
        pip + ["--require-hashes", "-r", str(lock_path)],
        pip + ["--no-deps", "--no-build-isolation", "-e", "."],
    ]


def _validate_existing_config(config_path: Path) -> str | None:
    """Read a configuration we are not going to rewrite, and say now if it is broken.

    Without this the file is taken on faith and only `media-server check` — the
    very last step, after the environment and the frontend are built — discovers
    that it still says GENERATE_WITH_INSTALLER, or points at a drive nobody
    mounted. Ten minutes of pip, then a traceback. The real loader is reused so
    the rules cannot drift; it needs nothing but the standard library, and if it
    ever does, validation steps aside rather than blocking the install.
    """
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    try:
        from media_server.config import ConfigError, load_config
    except ImportError:
        return None
    finally:
        sys.path.pop(0)
    try:
        load_config(config_path)
    except ConfigError as failure:
        return str(failure)
    return None


def _build_frontend() -> None:
    frontend = PROJECT_ROOT / "frontend"
    lockfile = frontend / "package-lock.json"
    if not lockfile.is_file():
        raise RuntimeError("Brak frontend/package-lock.json; build musi być reprodukowalny")

    npm = next((path for name in ("npm.cmd", "npm") if (path := shutil.which(name))), None)
    if npm is None:
        raise RuntimeError("Nie znaleziono npm; zainstaluj wspieraną wersję Node.js")

    subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=frontend, check=True)
    subprocess.run([npm, "run", "build"], cwd=frontend, check=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bezpieczny instalator TryHackX Media Server")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--root", action="append", type=_root_argument, default=[], metavar="ID=PATH")
    parser.add_argument("--music-root")
    parser.add_argument("--movies-root")
    parser.add_argument(
        "--thumbnail-cache",
        type=Path,
        help="Prywatny katalog cache miniaturek; domyślnie runtime/thumbnails",
    )
    parser.add_argument(
        "--subtitle-cache",
        type=Path,
        help="Prywatny katalog cache napisów WebVTT; domyślnie runtime/subtitles",
    )

    parser.add_argument("--ffmpeg-path", default="ffmpeg", help="Ścieżka do FFmpeg lub nazwa polecenia")
    parser.add_argument(
        "--base-url",
        type=_base_url_argument,
        help="Publiczny adres aplikacji, np. https://twoj.host/ (domyślnie katalog główny)",
    )
    parser.add_argument(
        "--proxy-trusted",
        type=_proxy_trusted_argument,
        metavar="ADRESY",
        help="Adresy reverse proxy przed serwerem, po przecinku (patrz docs/PUBLIC-EXPOSURE.md)",
    )
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db-host", default="127.0.0.1")
    parser.add_argument("--db-port", type=int, default=3306)
    parser.add_argument("--db-name", default="media_server")
    parser.add_argument("--db-user", default="media_server")
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--config-only", action="store_true")
    parser.add_argument(
        "--build-frontend",
        action="store_true",
        help="Wykonaj reprodukowalny npm ci i produkcyjny build frontendu",
    )
    parser.add_argument("--dev", action="store_true", help="Zainstaluj również zależności testowe")
    parser.add_argument(
        "--no-lock",
        action="store_true",
        help="Instaluj z zakresów pyproject.toml zamiast z requirements*.lock (bez weryfikacji hashy)",
    )
    parser.add_argument("--migrate", action="store_true", help="Zastosuj migracje po instalacji")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _allow_polish_output() -> None:
    """Keep the diagnostics printable on a console that predates Unicode.

    Windows hands a fresh process the system code page, and stdout is strict:
    on any Western-European installation the first sentence containing "ż" ends
    the installer with a UnicodeEncodeError, several steps before it does
    anything useful. stderr escapes such characters by itself, stdout does not.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def main(argv: list[str] | None = None) -> int:
    _allow_polish_output()
    args = _parser().parse_args(argv)
    if args.config_only and args.build_frontend:
        print("--config-only i --build-frontend nie mogą być użyte razem", file=sys.stderr)
        return 1
    if sys.version_info < (3, 11):
        print("Wymagany jest Python 3.11 lub nowszy", file=sys.stderr)
        return 1
    if not 1 <= args.port <= 65535 or not 1 <= args.db_port <= 65535:
        print("Port musi mieścić się w zakresie 1..65535", file=sys.stderr)
        return 1

    config_path = args.config.expanduser().resolve()
    config_exists = config_path.exists()

    roots = dict(args.root)
    if args.music_root:
        roots["music"] = _absolute_directory(args.music_root, "Music")
    if args.movies_root:
        roots["movies"] = _absolute_directory(args.movies_root, "Movies")
    password = os.environ.get("MEDIA_SERVER_DB_PASSWORD", "")
    if config_exists:
        # Re-runs (e.g. recreating .venv after moving the tree) never rewrite the private
        # config, so media roots and the database password are not demanded again —
        # but it is read now, so a placeholder or a stale path stops the run here
        # instead of after the environment and the frontend are already built.
        problem = _validate_existing_config(config_path)
        if problem is not None:
            print(f"Istniejąca konfiguracja jest nie do użycia: {problem}", file=sys.stderr)
            print(f"Popraw {config_path} albo usuń ją, żeby instalator utworzył nową.", file=sys.stderr)
            return 1
    else:
        if not roots and not args.non_interactive:
            if os.name == "nt":
                roots["music"] = _prompt_path("Katalog muzyki", "E:/Muzyka")
                roots["movies"] = _prompt_path("Katalog filmów", "E:/Filmy Video")
            else:
                roots["music"] = _prompt_path("Katalog muzyki", "/srv/media/music")
                roots["movies"] = _prompt_path("Katalog filmów", "/srv/media/movies")
        if not roots:
            print("Podaj przynajmniej jedno źródło przez --root, --music-root lub --movies-root", file=sys.stderr)
            return 1

        if not password and not args.non_interactive:
            password = getpass.getpass("Hasło użytkownika jednej bazy media_server: ")
        if not password:
            print("Ustaw MEDIA_SERVER_DB_PASSWORD; hasło nie jest przyjmowane jako argument CLI", file=sys.stderr)
            return 1

    missing = [f"{root_id}={path}" for root_id, path in roots.items() if not path.is_dir()]
    if missing:
        print("Nie istnieją katalogi źródłowe: " + ", ".join(missing), file=sys.stderr)
        return 1

    thumbnail_cache = (
        args.thumbnail_cache.expanduser().resolve()
        if args.thumbnail_cache is not None
        else (PROJECT_ROOT / "runtime" / "thumbnails").resolve()
    )
    subtitle_cache = (
        args.subtitle_cache.expanduser().resolve()
        if args.subtitle_cache is not None
        else (PROJECT_ROOT / "runtime" / "subtitles").resolve()
    )

    if config_exists:
        print(f"Konfiguracja już istnieje i nie zostanie nadpisana: {config_path}")
    else:
        print(f"Utworzenie prywatnej konfiguracji: {config_path}")
        if not args.dry_run:
            config_path.parent.mkdir(parents=True, exist_ok=True)
            thumbnail_cache.mkdir(parents=True, exist_ok=True)
            subtitle_cache.mkdir(parents=True, exist_ok=True)

            config_path.write_text(
                _build_config(args, roots, password, thumbnail_cache, subtitle_cache),
                encoding="utf-8", newline="\n"
            )
            _restrict_config_permissions(config_path)

    if args.config_only:
        print("Konfiguracja gotowa; pominięto tworzenie środowiska Python.")
        return 0

    venv_path = PROJECT_ROOT / ".venv"
    if not venv_path.exists():
        print(f"Tworzenie środowiska Python: {venv_path}")
        if not args.dry_run:
            venv.EnvBuilder(with_pip=True).create(venv_path)
    python = _python_in_venv(venv_path)
    try:
        commands = _python_dependency_commands(python, dev=args.dev, no_lock=args.no_lock)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.no_lock:
        print("Instalacja zależności w prywatnym venv z zakresów pyproject.toml (bez weryfikacji hashy)")
    else:
        print("Instalacja zależności w prywatnym venv z locka z hashami")
    if not args.dry_run:
        for command in commands:
            subprocess.run(command, cwd=PROJECT_ROOT, check=True)
        check_command = [str(python), "-m", "media_server", "--config", str(config_path), "check"]
        subprocess.run(check_command, cwd=PROJECT_ROOT, check=True)
        if args.migrate:
            subprocess.run(
                [str(python), "-m", "media_server", "--config", str(config_path), "migrate"],
                cwd=PROJECT_ROOT,
                check=True,
            )

    if args.build_frontend:
        print("Budowanie wspólnego frontendu z frontend/package-lock.json")
        if not args.dry_run:
            _build_frontend()

    print("Instalacja przygotowana. Migracje i konfiguracja Apache nie są wykonywane bez jawnych opcji.")
    print("Windows: scripts\\start-windows.bat")
    print("Debian:   zobacz docs/INSTALL-DEBIAN.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
