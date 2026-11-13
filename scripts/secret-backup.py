#!/usr/bin/env python3
"""An encrypted copy of everything a server cannot be rebuilt without — and git must never hold.

    .venv\\Scripts\\python.exe scripts\\secret-backup.py encrypt            # → backups\\secrets-<date>.thxbak
    .venv\\Scripts\\python.exe scripts\\secret-backup.py list   backups\\secrets-….thxbak
    .venv\\Scripts\\python.exe scripts\\secret-backup.py decrypt backups\\secrets-….thxbak --output-dir D:\\odtworzone

The code is public and the catalogue can be scanned again; what cannot be
recreated is small: the private configuration (database password, the key every
transfer token is sealed with, the mail password), the origin certificate's
private key, the wizard's record of what it set up — and the database itself,
with the accounts, ratings, collections and history in it.

None of that belongs in a git repository, **private or not**: a repository is
copied to every machine that clones it, keeps every version for ever and is one
leaked token away from being public. One encrypted file can live anywhere — in
the private repository, on a pendrive, in a cloud folder — because without the
passphrase it is noise.

What goes in by default (each only if it exists): ``config/config.local.toml``,
``integrations/php/stage/config.local.php``, ``config/installer.local.json``,
``config/origin/`` and ``config/tls/``, anything named with ``--include``, and a
dump of the database made with ``mysqldump`` using the credentials from the
private configuration. The dump goes from ``mysqldump`` straight into the
encrypted archive; it never exists on disk in the clear.

The format is deliberately plain: a one-line JSON header (algorithm, scrypt
parameters, salt, nonce), then AES-256-GCM over a gzip-compressed tar. The header
is authenticated together with the data, so a changed parameter is a failed
decryption, not a weaker one. The passphrase is asked without echo (twice when
encrypting), or read from the file named by ``--passphrase-file`` or from the
``SECRET_BACKUP_PASSPHRASE`` environment variable; it is never an argument.

Needs the ``cryptography`` package — it is in the project's environment, so run
this with ``.venv``'s Python.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import gzip
import io
import json
import os
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
from collections.abc import Sequence
from pathlib import Path, PurePosixPath

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAGIC = b"THXBAK1\n"
MINIMUM_PASSPHRASE = 12
# 64 MiB of memory per guess: comfortable on any machine that runs the server,
# expensive for somebody trying a dictionary against a stolen file.
SCRYPT = {"n": 2**16, "r": 8, "p": 1}
DEFAULT_FILES = (
    "config/config.local.toml",
    "integrations/php/stage/config.local.php",
    "config/installer.local.json",
)
DEFAULT_DIRECTORIES = ("config/origin", "config/tls")
DUMP_NAME = "database/dump.sql"
# What the application's own account (data rights only) is able to dump.
DUMP_OPTIONS = ("--single-transaction", "--skip-lock-tables", "--no-tablespaces", "--skip-events", "--skip-triggers",
                "--default-character-set=utf8mb4", "--hex-blob")


class BackupError(RuntimeError):
    """Nothing was written (or nothing was restored); the message says why."""


def _crypto():
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    except ImportError as exc:
        raise BackupError(
            "Brak pakietu cryptography — uruchom ten skrypt Pythonem z .venv (np. .venv\\Scripts\\python.exe)."
        ) from exc
    return AESGCM, Scrypt, InvalidTag


def _derive(passphrase: str, salt: bytes, parameters: dict[str, int]) -> bytes:
    _aesgcm, scrypt, _invalid = _crypto()
    n, r, p = int(parameters["n"]), int(parameters["r"]), int(parameters["p"])
    # Parameters come from the file being opened: refuse ones that would exhaust memory or protect nothing.
    if n < 2**14 or n > 2**20 or n & (n - 1) or not 1 <= r <= 16 or not 1 <= p <= 4:
        raise BackupError("Plik ma nieprawidłowe parametry wyprowadzania klucza.")
    return scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(passphrase.encode("utf-8"))


def encrypt_bytes(plaintext: bytes, passphrase: str) -> bytes:
    """Seal ``plaintext`` under ``passphrase``: header line, then AES-256-GCM ciphertext."""
    if len(passphrase) < MINIMUM_PASSPHRASE:
        raise BackupError(f"Hasło kopii musi mieć co najmniej {MINIMUM_PASSPHRASE} znaków.")
    aesgcm, _scrypt, _invalid = _crypto()
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    header = json.dumps(
        {
            "format": 1,
            "cipher": "AES-256-GCM",
            "kdf": "scrypt",
            **SCRYPT,
            "salt": base64.b64encode(salt).decode("ascii"),
            "nonce": base64.b64encode(nonce).decode("ascii"),
        },
        sort_keys=True,
    ).encode("ascii") + b"\n"
    key = _derive(passphrase, salt, SCRYPT)
    return MAGIC + header + aesgcm(key).encrypt(nonce, plaintext, MAGIC + header)


def decrypt_bytes(blob: bytes, passphrase: str) -> bytes:
    if not blob.startswith(MAGIC):
        raise BackupError("To nie jest plik kopii sekretów (brak nagłówka THXBAK1).")
    header_end = blob.find(b"\n", len(MAGIC))
    if header_end < 0 or header_end > 4096:
        raise BackupError("Plik kopii jest uszkodzony (nagłówek).")
    header_line = blob[len(MAGIC):header_end + 1]
    try:
        header = json.loads(header_line)
        if header.get("format") != 1 or header.get("cipher") != "AES-256-GCM" or header.get("kdf") != "scrypt":
            raise BackupError("Nieobsługiwana wersja formatu kopii.")
        salt, nonce = base64.b64decode(header["salt"]), base64.b64decode(header["nonce"])
        parameters = {name: int(header[name]) for name in ("n", "r", "p")}
    except (ValueError, KeyError, TypeError) as exc:
        raise BackupError("Plik kopii jest uszkodzony (nagłówek).") from exc
    aesgcm, _scrypt, invalid = _crypto()
    key = _derive(passphrase, salt, parameters)
    try:
        return aesgcm(key).decrypt(nonce, blob[header_end + 1:], MAGIC + header_line)
    except invalid as exc:
        raise BackupError("Nie udało się odszyfrować: złe hasło albo plik został zmieniony.") from exc


# -- what goes in ---------------------------------------------------------------------------


def collect_files(root: Path, extra: Sequence[str] = ()) -> list[tuple[str, Path]]:
    """``(name in the archive, file on disk)`` for everything that exists; names are project-relative."""
    found: dict[str, Path] = {}

    def add(path: Path) -> None:
        resolved = path.resolve()
        try:
            name = resolved.relative_to(root.resolve()).as_posix()
        except ValueError:
            # Something outside the tree keeps its own name under a folder that says where it came from.
            name = "external/" + resolved.name
        found[name] = resolved

    for relative in DEFAULT_FILES:
        if (root / relative).is_file():
            add(root / relative)
    for relative in (*DEFAULT_DIRECTORIES, *extra):
        candidate = Path(relative) if Path(relative).is_absolute() else root / relative
        if candidate.is_file():
            add(candidate)
        elif candidate.is_dir():
            for file in sorted(candidate.rglob("*")):
                if file.is_file():
                    add(file)
        elif relative in extra:
            raise BackupError(f"Nie ma takiego pliku ani katalogu: {relative}")
    return sorted(found.items())


def find_mysqldump(explicit: str | None = None) -> str | None:
    if explicit:
        if Path(explicit).is_file():
            return explicit
        raise BackupError(f"Nie znaleziono mysqldump: {explicit}")
    for name in ("mysqldump", "mariadb-dump"):
        found = shutil.which(name)
        if found:
            return found
    # WampServer does not put its tools on PATH; the newest version it has is the one it runs.
    for pattern in ("bin/mysql/mysql*/bin/mysqldump.exe", "bin/mariadb/mariadb*/bin/mysqldump.exe"):
        for base in (Path("C:/wamp64"), Path("D:/wamp64"), PROJECT_ROOT.parent):
            matches = sorted(base.glob(pattern), reverse=True)
            if matches:
                return str(matches[0])
    return None


def dump_command(mysqldump: str, options_file: Path, database: str) -> list[str]:
    # --defaults-extra-file must come first; the password is in that file, never here.
    return [mysqldump, f"--defaults-extra-file={options_file}", *DUMP_OPTIONS, database]


def dump_database(config_path: Path, mysqldump: str) -> bytes:
    """The whole database as SQL text, taken with the credentials of the private configuration."""
    try:
        database = tomllib.loads(config_path.read_text(encoding="utf-8")).get("database", {})
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise BackupError(f"Nie można odczytać {config_path}: {exc}") from exc
    name, user = str(database.get("name", "")), str(database.get("user", ""))
    if not name or not user:
        raise BackupError("W konfiguracji brakuje [database] name albo user — nie ma czego zrzucać.")

    def quoted(value: object) -> str:
        return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'

    options = (
        "[client]\n"
        f"user={quoted(user)}\npassword={quoted(database.get('password', ''))}\n"
        f"host={database.get('host', '127.0.0.1')}\nport={int(database.get('port', 3306))}\nprotocol=tcp\n"
    )
    descriptor, raw_path = tempfile.mkstemp(prefix="thx-dump-", suffix=".cnf")
    options_file = Path(raw_path)
    try:
        # mkstemp gives a file only this account can read; filled, used once and removed.
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(options)
        result = subprocess.run(dump_command(mysqldump, options_file, name), capture_output=True, check=False, timeout=3600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupError(f"Nie udało się uruchomić mysqldump: {exc}") from exc
    finally:
        options_file.unlink(missing_ok=True)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip().splitlines()[-1:] or ["brak komunikatu"]
        raise BackupError(f"mysqldump zakończył się kodem {result.returncode}: {detail[0]}")
    return result.stdout


def build_archive(files: Sequence[tuple[str, Path]], dump: bytes | None, *, moment: float | None = None) -> bytes:
    """A gzip-compressed tar of the files (and the dump), built in memory."""
    buffer = io.BytesIO()
    stamp = int(moment if moment is not None else time.time())
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=stamp) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            def add(name: str, data: bytes) -> None:
                info = tarfile.TarInfo(name)
                info.size, info.mtime, info.mode = len(data), stamp, 0o600
                archive.addfile(info, io.BytesIO(data))

            for name, path in files:
                add(name, path.read_bytes())
            if dump is not None:
                add(DUMP_NAME, dump)
    return buffer.getvalue()


def _safe_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = []
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        if not member.isfile() or name.is_absolute() or ".." in name.parts or ":" in member.name or "\\" in member.name:
            raise BackupError(f"Kopia zawiera niedozwolony wpis: {member.name!r}")
        members.append(member)
    return members


def list_archive(payload: bytes) -> list[tuple[str, int]]:
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(payload)), mode="r") as archive:
        return [(member.name, member.size) for member in _safe_members(archive)]


def extract_archive(payload: bytes, output_dir: Path) -> list[Path]:
    """Write the files under ``output_dir``; never over an existing file, never outside the folder."""
    written: list[Path] = []
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(payload)), mode="r") as archive:
        members = _safe_members(archive)
        clashes = [member.name for member in members if (output_dir / member.name).exists()]
        if clashes:
            raise BackupError("Katalog docelowy ma już takie pliki (nic nie zostało nadpisane): " + ", ".join(clashes[:5]))
        for member in members:
            target = output_dir / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            assert source is not None
            # Created private where the system has a mode to create with; on Windows the
            # folder chosen for the restore decides who can read it.
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                shutil.copyfileobj(source, handle)
            written.append(target)
    return written


# -- the command line -----------------------------------------------------------------------


def read_passphrase(args: argparse.Namespace, *, confirm: bool) -> str:
    if args.passphrase_file:
        try:
            lines = Path(args.passphrase_file).read_text(encoding="utf-8-sig").splitlines()
        except OSError as exc:
            raise BackupError(f"Nie można odczytać pliku z hasłem: {exc}") from exc
        return lines[0] if lines else ""
    from_environment = os.environ.get("SECRET_BACKUP_PASSPHRASE")
    if from_environment is not None:
        return from_environment
    if not sys.stdin.isatty():
        raise BackupError("Brak terminala do zapytania o hasło — użyj --passphrase-file albo SECRET_BACKUP_PASSPHRASE.")
    first = getpass.getpass("Hasło kopii (co najmniej 12 znaków): ")
    if confirm and getpass.getpass("Powtórz hasło: ") != first:
        raise BackupError("Hasła nie są identyczne.")
    return first


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Zaszyfrowana kopia sekretów instalacji (konfiguracja, klucze, zrzut bazy)")
    commands = parser.add_subparsers(dest="command", required=True)

    def passphrase_options(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--passphrase-file", help="Plik, którego pierwsza linia jest hasłem (zamiast pytania)")

    encrypt = commands.add_parser("encrypt", help="Zrób zaszyfrowaną kopię")
    encrypt.add_argument("--output", type=Path, help="Plik wynikowy (domyślnie backups/secrets-<data>.thxbak)")
    encrypt.add_argument("--include", action="append", default=[], metavar="ŚCIEŻKA", help="Dodatkowy plik lub katalog")
    encrypt.add_argument("--no-database", action="store_true", help="Bez zrzutu bazy danych")
    encrypt.add_argument("--mysqldump", help="Ścieżka do mysqldump (domyślnie PATH, potem WampServer)")
    passphrase_options(encrypt)

    for name, text in (("list", "Pokaż, co jest w kopii"), ("decrypt", "Odtwórz pliki z kopii")):
        sub = commands.add_parser(name, help=text)
        sub.add_argument("file", type=Path)
        passphrase_options(sub)
        if name == "decrypt":
            sub.add_argument("--output-dir", type=Path, required=True, help="Katalog, do którego trafią pliki (pusty albo nowy)")
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    args = _parser().parse_args(argv)
    root = PROJECT_ROOT
    try:
        if args.command == "encrypt":
            files = collect_files(root, args.include)
            dump: bytes | None = None
            config = root / "config" / "config.local.toml"
            if not args.no_database:
                if not config.is_file():
                    raise BackupError("Brak config/config.local.toml — nie wiadomo, którą bazę zrzucić (albo użyj --no-database).")
                mysqldump = find_mysqldump(args.mysqldump)
                if mysqldump is None:
                    raise BackupError("Nie znaleziono mysqldump — wskaż go przez --mysqldump albo użyj --no-database.")
                dump = dump_database(config, mysqldump)
            if not files and dump is None:
                raise BackupError("Nie ma czego kopiować: brak prywatnej konfiguracji i brak zrzutu bazy.")
            passphrase = read_passphrase(args, confirm=True)
            sealed = encrypt_bytes(build_archive(files, dump), passphrase)
            target = args.output or (root / "backups" / f"secrets-{time.strftime('%Y%m%d-%H%M%S')}.thxbak")
            if target.exists():
                raise BackupError(f"Plik już istnieje i nie zostanie nadpisany: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(sealed)
            for name, _path in files:
                print(f"  + {name}")
            if dump is not None:
                print(f"  + {DUMP_NAME}  ({len(dump) / 1048576:.1f} MiB przed kompresją)")
            print(f"Zaszyfrowana kopia: {target}  ({len(sealed) / 1048576:.2f} MiB)")
            print("Bez hasła tego pliku nie da się odczytać — i bez hasła nie odczytasz go także Ty.")
            return 0
        blob = args.file.read_bytes()
        payload = decrypt_bytes(blob, read_passphrase(args, confirm=False))
        if args.command == "list":
            for name, size in list_archive(payload):
                print(f"{size:>12}  {name}")
            return 0
        written = extract_archive(payload, args.output_dir)
        for path in written:
            print(f"  {path}")
        print(f"Odtworzono {len(written)} plików do {args.output_dir}. To są sekrety w czystej postaci — usuń je po użyciu.")
        return 0
    except BackupError as failure:
        print(f"Błąd: {failure}", file=sys.stderr)
        return 1
    except OSError as failure:
        print(f"Błąd: {failure}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
