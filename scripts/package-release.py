#!/usr/bin/env python3
"""Build the release archives: what an end user unpacks and runs.

    python scripts/package-release.py                     # dist/TryHackX-Media-Server-<version>-windows.zip (+ .sha256)
    python scripts/package-release.py --platform debian   # dist/TryHackX-Media-Server-<version>-debian.tar.gz (+ .sha256)
    python scripts/package-release.py --platform all      # both
    python scripts/package-release.py --list              # what would go in and what stays out, and why
    python scripts/package-release.py --allow-stale-build # skip the "is the frontend build current" check

An archive is **what git would ship** (``git ls-files --cached --others
--exclude-standard``: tracked files and new files not ignored), **plus the built
frontend** (``public/assets/build`` — git-ignored, and something an end user
cannot produce: there is no Node.js on a home machine or a small server),
**minus what only a developer needs**:

* ``frontend/`` (sources; the build is what runs), ``tests/``, ``installer/tests/``,
  ``.github/``;
* developer tooling: ``scripts/check.py``, ``scripts/lock-deps.py``, this script,
  ``requirements-dev.*``, ``requirements-build.txt``, ``.editorconfig``,
  ``.gitattributes``, ``.gitignore``;

**minus what belongs to the other system**: the Windows archive leaves out the
Debian installer, the release script, the units and the fail2ban files; the
Debian archive leaves out the Windows wizard, its scripts and the WAMP example.
The two archives are built by the same rules from the same tree, so the same
commit gives the same server on both systems.

Nothing private can get in by construction — the private configuration, keys,
logs, caches and working notes are git-ignored — and the script checks anyway:
it refuses to build when a selected file looks like a secret by name or by
content, or contains a value copied from this machine's ``config.local.toml``.

**The built frontend is the one place where "git-ignored" is not enough.** The
build takes whatever lies in ``frontend/vendor/`` — a licensed Font Awesome Pro,
preset packs and shaders under non-commercial licences, the owner's own logos —
and bakes it into ``public/assets/build``. That is fine on the owner's server and
must never be published. So the script refuses to package from a tree that has
anything in ``frontend/vendor/``, and refuses a build that carries the Pro icon
fonts: **a release is built from a clean clone**, where the build can contain
only what the repository itself holds (see docs/RELEASE.md).

The archives are reproducible: entries are sorted and carry one timestamp (the
last commit's, or ``SOURCE_DATE_EPOCH``). Line endings are the target system's
whatever the builder's git settings are: Windows scripts are stored with CRLF,
and in the Debian archive every text file is stored with LF — a systemd unit or a
shell script checked out on Windows with ``core.autocrlf`` would otherwise arrive
with carriage returns that systemd and bash read as part of the text.
"""
from __future__ import annotations

import argparse
import fnmatch
import gzip
import hashlib
import importlib.util
import io
import os
import re
import subprocess
import sys
import tarfile
import time
import tomllib
import zipfile
from collections.abc import Iterable, Sequence
from pathlib import Path, PurePosixPath

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = "public/assets/build"
PLATFORMS = ("windows", "debian")
ARCHIVE_NAME = "TryHackX-Media-Server-{version}-windows"
ARCHIVE_NAMES = {"windows": ARCHIVE_NAME + ".zip", "debian": "TryHackX-Media-Server-{version}-debian.tar.gz"}

# Developer-only: (pattern, why it stays out). Patterns are matched against POSIX paths
# relative to the project root; a trailing slash means "everything under", and a `*`
# matches within one name.
EXCLUDED: tuple[tuple[str, str], ...] = (
    (".github/", "CI"),
    ("tests/", "testy"),
    ("installer/tests/", "testy kreatora"),
    ("frontend/", "źródła frontu — w paczce jest gotowy build"),
    ("scripts/check.py", "bramka jakości dla programistów"),
    ("scripts/lock-deps.py", "narzędzie programisty"),
    ("scripts/package-release.py", "narzędzie programisty"),
    ("requirements-dev.txt", "zależności testowe"),
    ("requirements-dev.lock", "zależności testowe"),
    ("requirements-build.txt", "plik pomocniczy locka"),
    (".editorconfig", "ustawienia edytora"),
    (".gitattributes", "ustawienia gita"),
    (".gitignore", "ustawienia gita"),
)

# What belongs to the other system. The shared parts — the server itself, the Python
# helper of both installers (installer/helper.py, installer/setup_helper/), the VPS
# templates, the Apache examples the Debian sites are generated from — go into both.
PLATFORM_EXCLUDED: dict[str, tuple[tuple[str, str], ...]] = {
    "windows": (
        ("deploy/systemd/", "tylko Debian"),
        ("deploy/fail2ban/", "tylko Debian"),
        ("scripts/install-debian.sh", "tylko Debian"),
        ("scripts/release-debian.sh", "tylko Debian"),
        ("zainstaluj-debian.sh", "instalator dla Debiana"),
        ("installer/debian/", "instalator dla Debiana"),
    ),
    "debian": (
        ("Zainstaluj.cmd", "kreator dla Windows"),
        ("Install.cmd", "kreator dla Windows"),
        ("installer/Setup.ps1", "kreator dla Windows"),
        ("installer/lib/", "kreator dla Windows"),
        ("installer/lang/", "kreator dla Windows"),
        ("installer/examples/", "pliki odpowiedzi kreatora dla Windows"),
        ("scripts/*-windows.ps1", "tylko Windows"),
        ("scripts/*-windows.bat", "tylko Windows"),
        ("deploy/apache/media-next-stage-wamp.conf.example", "tylko WAMP"),
    ),
}

# Names that must never be in a release, whatever git thinks of them.
PRIVATE_NAMES: tuple[str, ...] = (
    "*.local.toml", "*.local.php", "*.local.json", ".env", ".env.*", "*.pem", "*.key", "*.crt", "*.pfx", "*.p12",
    "*.jks", "*.keystore", "secrets.*", "*credentials*", "*.htpasswd", "*.sql.gz", "*.dump", "*.log", "*.pid",
)
PRIVATE_ALLOWED: tuple[str, ...] = (".env.example",)
PRIVATE_DIRS: tuple[str, ...] = ("runtime/", "logs/", "backups/", "scratch/", ".venv/", "node_modules/", ".git/", "dist/")

# Stored with CRLF: cmd.exe and Windows PowerShell both read LF, but a batch file
# with labels does not survive it, and a user who opens one in Notepad should see lines.
CRLF_SUFFIXES = frozenset({".cmd", ".bat", ".ps1", ".psd1"})
BOM = b"\xef\xbb\xbf"
# Read for secrets although the gate's own list of text files does not name them: the
# templates the VPS bundle is made from (one of them is a whole shell script) and the timers.
ALSO_SCANNED = frozenset({".tmpl", ".timer"})


class PackagingError(RuntimeError):
    """The archive must not be built; the message says what to fix."""


def _check_module():
    """``scripts/check.py`` already knows what a secret looks like; one definition for the gate and for this."""
    spec = importlib.util.spec_from_file_location("tryhackx_check", PROJECT_ROOT / "scripts" / "check.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolve annotations through sys.modules while the module is being executed.
    sys.modules["tryhackx_check"] = module
    spec.loader.exec_module(module)
    return module


def project_version(root: Path = PROJECT_ROOT) -> str:
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+_-]*", version):
        raise PackagingError(f"Wersja z pyproject.toml nie nadaje się na nazwę pliku: {version!r}")
    return version


def exclusion_reason(path: str, platform: str = "windows") -> str | None:
    """Why a git-visible file stays out of the archive for ``platform``, or ``None`` when it goes in."""
    for pattern, reason in (*EXCLUDED, *PLATFORM_EXCLUDED[platform]):
        if pattern.endswith("/"):
            if path.startswith(pattern):
                return reason
        elif path == pattern or ("*" in pattern and fnmatch.fnmatchcase(path, pattern)):
            return reason
    return None


def private_reason(path: str) -> str | None:
    """Why a path must never be published — checked on everything that was selected."""
    name = PurePosixPath(path).name
    for prefix in PRIVATE_DIRS:
        if path.startswith(prefix) or f"/{prefix}" in f"/{path}":
            return f"katalog prywatny lub roboczy ({prefix})"
    if name in PRIVATE_ALLOWED:
        return None
    for pattern in PRIVATE_NAMES:
        if fnmatch.fnmatchcase(name.lower(), pattern):
            return f"nazwa wygląda na sekret albo dane robocze ({pattern})"
    return None


def select_files(
    git_files: Iterable[str], build_files: Iterable[str], platform: str = "windows"
) -> tuple[list[str], list[tuple[str, str]]]:
    """Split what git would ship, plus the built frontend, into "in the archive" and "left out, because"."""
    included: list[str] = []
    excluded: list[tuple[str, str]] = []
    for path in sorted(set(git_files)):
        reason = exclusion_reason(path, platform)
        if reason is None:
            included.append(path)
        else:
            excluded.append((path, reason))
    included.extend(sorted(set(build_files)))
    return sorted(set(included)), excluded


def git_visible_files(root: Path = PROJECT_ROOT) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root, capture_output=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise PackagingError("Paczkę buduje się z repozytorium git: lista plików pochodzi z `git ls-files`.") from exc
    files = [part.decode("utf-8") for part in result.stdout.split(b"\0") if part]
    # A file deleted in the working tree but not yet committed is still listed; it is not there to pack.
    return [path for path in files if (root / path).is_file()]


def build_files(root: Path = PROJECT_ROOT) -> list[str]:
    build = root / BUILD_DIR
    if not (build / "index.html").is_file():
        raise PackagingError(
            f"Brak zbudowanego frontu ({BUILD_DIR}/index.html). Zbuduj go: w katalogu frontend `npm ci`, potem `npm run build`."
        )
    return sorted(path.relative_to(root).as_posix() for path in build.rglob("*") if path.is_file())


# Paths inside the build that exist only when the build took something from frontend/vendor/.
VENDOR_BUILD_MARKERS: tuple[str, ...] = (f"{BUILD_DIR}/assets/iconpacks/",)


def check_no_vendor_content(root: Path, built: Sequence[str]) -> None:
    """Refuse a build that may carry content the project has no right to redistribute."""
    vendor = root / "frontend" / "vendor"
    if vendor.is_dir() and any(vendor.iterdir()):
        raise PackagingError(
            "W tym drzewie leży frontend/vendor/ (ikony Pro, paczki presetów, shadery na licencjach niekomercyjnych) — "
            "build frontu mógł je wchłonąć, a ich nie wolno publikować. Zbuduj wydanie z czystego klona: "
            "`git clone`, w nim `npm ci && npm run build`, i dopiero tam ten skrypt (docs/RELEASE.md)."
        )
    tainted = sorted(path for path in built if path.startswith(VENDOR_BUILD_MARKERS))
    if tainted:
        raise PackagingError(
            "Build frontu zawiera czcionki Font Awesome Pro (" + tainted[0] + " …) — to licencjonowana kopia, której "
            "nie wolno publikować. Zbuduj front w czystym klonie, bez frontend/vendor/."
        )


def check_frontend_build(root: Path, git_files: Sequence[str], *, allow_stale: bool = False) -> None:
    """The build must be for the root address and must not be older than the sources it was made from."""
    page = (root / BUILD_DIR / "index.html").read_text(encoding="utf-8", errors="replace")
    base = re.search(r'name="media-app-base"\s+content="([^"]*)"', page)
    if base is None or base.group(1) not in {"/", ""}:
        found = base.group(1) if base else "brak znacznika media-app-base"
        raise PackagingError(
            f"Front zbudowano dla innej ścieżki niż „/” ({found}). Kreator stawia aplikację pod głównym adresem — "
            "zbuduj front bez MEDIA_APP_BASE."
        )
    if allow_stale:
        return
    built = (root / BUILD_DIR / "index.html").stat().st_mtime
    sources = [
        path for path in git_files
        if path.startswith("frontend/") and not path.endswith((".test.ts", ".test.mjs", ".md"))
        and not path.startswith(("frontend/tests/", "frontend/scripts/tests/"))
    ]
    newer = sorted(
        (path for path in sources if (root / path).stat().st_mtime > built + 2),
        key=lambda path: (root / path).stat().st_mtime, reverse=True,
    )
    if newer:
        shown = ", ".join(newer[:5]) + (f" … (+{len(newer) - 5})" if len(newer) > 5 else "")
        raise PackagingError(
            "Zbudowany front jest starszy niż jego źródła: " + shown + ". Uruchom `npm run build` w katalogu frontend "
            "(albo, świadomie, --allow-stale-build)."
        )


def secret_findings(root: Path, files: Sequence[str]) -> list[str]:
    """Everything in the selection that looks like something nobody should publish."""
    check = _check_module()
    private_values = check._private_values()
    findings: list[str] = []
    for path in files:
        reason = private_reason(path)
        if reason is not None:
            findings.append(f"{path}: {reason}")
            continue
        file = root / path
        suffix = file.suffix.lower()
        if suffix not in check.TEXT_SUFFIXES and file.name not in check.TEXT_SUFFIXES and suffix not in CRLF_SUFFIXES | ALSO_SCANNED:
            continue
        try:
            text = file.read_text(encoding="utf-8-sig")
        except (UnicodeDecodeError, OSError):
            continue
        for label, pattern in check.SECRET_PATTERNS:
            if pattern.search(text):
                findings.append(f"{path}: {label}")
        for label, value in private_values:
            if value in text:
                findings.append(f"{path}: zawiera wartość {label} z config.local.toml")
    return findings


def _is_text(data: bytes) -> bool:
    if b"\0" in data[:8192]:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def archive_bytes(root: Path, path: str, platform: str = "windows") -> bytes:
    """A file as it is stored: with the line endings of the system it is going to.

    Windows: scripts with CRLF, everything else byte for byte. Debian: every text
    file with LF — except the built frontend, which travels byte for byte on both
    (it is the build's output, not a checkout of anything).
    """
    data = (root / path).read_bytes()
    if platform == "debian":
        if path.startswith(BUILD_DIR + "/") or not _is_text(data):
            return data
        return data.replace(b"\r\n", b"\n")
    suffix = PurePosixPath(path).suffix.lower()
    if suffix not in CRLF_SUFFIXES:
        return data
    if suffix in {".ps1", ".psd1"} and path.startswith("installer/") and not data.startswith(BOM):
        raise PackagingError(f"{path}: brak BOM — Windows PowerShell 5.1 przeczytałby polskie znaki w stronie kodowej systemu.")
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def source_timestamp(root: Path = PROJECT_ROOT) -> int:
    """One date for every entry: ``SOURCE_DATE_EPOCH``, else the last commit, else now."""
    declared = os.environ.get("SOURCE_DATE_EPOCH", "")
    if declared.isdigit():
        return int(declared)
    try:
        result = subprocess.run(["git", "log", "-1", "--format=%ct"], cwd=root, capture_output=True, text=True, check=True)
        return int(result.stdout.strip())
    except (OSError, subprocess.CalledProcessError, ValueError):
        return int(time.time())


def write_archive(root: Path, files: Sequence[str], target: Path, *, folder: str, timestamp: int) -> str:
    """Write the ZIP (one top folder, sorted entries, one timestamp) and return its SHA-256."""
    moment = time.gmtime(max(timestamp, 315532800))[:6]  # ZIP cannot say anything before 1980
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(files):
            info = zipfile.ZipInfo(f"{folder}/{path}", date_time=moment)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, archive_bytes(root, path))
    temporary.replace(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    # The format `sha256sum -c` and `certutil -hashfile` users both recognise.
    target.with_name(target.name + ".sha256").write_text(f"{digest}  {target.name}\n", encoding="ascii", newline="\n")
    return digest


def write_tarball(root: Path, files: Sequence[str], target: Path, *, folder: str, timestamp: int) -> str:
    """Write the ``.tar.gz`` for Debian (one top folder, sorted entries, one timestamp) and return its SHA-256.

    Shell scripts are stored executable; everything belongs to root, as it will on
    the machine it is unpacked on with ``sudo``. Nothing of the builder's machine —
    its user, its clock, its umask — reaches the archive.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part")
    with open(temporary, "wb") as raw:
        # mtime=0 and no file name: the gzip header would otherwise date and name the build.
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(files):
                    data = archive_bytes(root, path, "debian")
                    info = tarfile.TarInfo(f"{folder}/{path}")
                    info.size = len(data)
                    info.mtime = timestamp
                    info.mode = 0o755 if path.endswith(".sh") else 0o644
                    info.uid = info.gid = 0
                    info.uname = info.gname = "root"
                    archive.addfile(info, io.BytesIO(data))
    temporary.replace(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_name(target.name + ".sha256").write_text(f"{digest}  {target.name}\n", encoding="ascii", newline="\n")
    return digest


REQUIRED: dict[str, tuple[str, ...]] = {
    "windows": (
        "Zainstaluj.cmd", "installer/Setup.ps1", "installer/helper.py", "installer/lang/pl.psd1", "scripts/install.py",
        "requirements.lock", "pyproject.toml", "README.md", "LICENSE", "src/media_server/__init__.py",
        "integrations/php/stage/bridge.php", "deploy/apache/media-next-stage-wamp.conf.example",
        "config/config.example.toml", f"{BUILD_DIR}/index.html", "migrations/001_foundation.sql",
    ),
    "debian": (
        "zainstaluj-debian.sh", "installer/helper.py", "installer/setup_helper/cli.py", "installer/debian/lib/common.sh",
        "installer/debian/lang/pl.sh", "installer/templates/vps/vps-setup.sh.tmpl", "scripts/install.py",
        "scripts/release-debian.sh", "deploy/systemd/tryhackx-media-transfer.service",
        "deploy/apache/media-next.conf.example", "deploy/apache/media-transfer.conf.example",
        "deploy/fail2ban/jail.d/tryhackx-media.conf.example", "requirements.lock", "pyproject.toml", "README.md",
        "LICENSE", "src/media_server/__init__.py", "integrations/php/stage/bridge.php", "config/config.example.toml",
        f"{BUILD_DIR}/index.html", "migrations/001_foundation.sql",
    ),
}


def required_files(files: Sequence[str], platform: str = "windows") -> list[str]:
    """What a release cannot work without: if one of these is missing, the selection rules broke."""
    present = set(files)
    return [path for path in REQUIRED[platform] if path not in present]


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    root = PROJECT_ROOT
    parser = argparse.ArgumentParser(description="Zbuduj paczkę wydania: ZIP dla Windows, tar.gz dla Debiana (+ sumy SHA-256)")
    parser.add_argument("--output-dir", type=Path, default=root / "dist")
    parser.add_argument("--platform", choices=(*PLATFORMS, "all"), default="windows",
                        help="Dla którego systemu (domyślnie windows; all buduje obie paczki)")
    parser.add_argument("--list", action="store_true", help="Wypisz, co trafi do paczki, a co zostaje — i nic nie buduj")
    parser.add_argument("--allow-stale-build", action="store_true", help="Nie sprawdzaj, czy build frontu jest świeższy od źródeł")
    args = parser.parse_args(argv)
    platforms = PLATFORMS if args.platform == "all" else (args.platform,)
    results: list[tuple[Path, int, str]] = []
    try:
        version = project_version(root)
        tracked = git_visible_files(root)
        built = build_files(root)
        check_no_vendor_content(root, built)
        check_frontend_build(root, tracked, allow_stale=args.allow_stale_build)
        folder = ARCHIVE_NAME.format(version=version).removesuffix("-windows")
        selections = {}
        # Everything is checked for every requested system before the first archive is written:
        # a release is either all of its files or none.
        for platform in platforms:
            included, excluded = select_files(tracked, built, platform)
            missing = required_files(included, platform)
            if missing:
                raise PackagingError(
                    f"W wyborze ({platform}) brakuje plików, bez których wydanie nie działa: " + ", ".join(missing)
                )
            findings = secret_findings(root, included)
            if findings:
                raise PackagingError("Możliwe sekrety w paczce — nic nie zbudowano:\n  " + "\n  ".join(findings))
            selections[platform] = (included, excluded)
        if args.list:
            for platform in platforms:
                included, excluded = selections[platform]
                if len(platforms) > 1:
                    print(f"== {platform}")
                for path in included:
                    print(f"+ {path}")
                for path, reason in excluded:
                    print(f"- {path}    ({reason})")
                print(f"\nW paczce: {len(included)} plików; pominięto: {len(excluded)}.")
            return 0
        timestamp = source_timestamp(root)
        for platform in platforms:
            included, _excluded = selections[platform]
            target = args.output_dir / ARCHIVE_NAMES[platform].format(version=version)
            if platform == "windows":
                digest = write_archive(root, included, target, folder=folder, timestamp=timestamp)
            else:
                digest = write_tarball(root, included, target, folder=folder, timestamp=timestamp)
            results.append((target, len(included), digest))
    except PackagingError as failure:
        print(f"Błąd: {failure}", file=sys.stderr)
        return 1
    for target, count, digest in results:
        size = target.stat().st_size / (1024 * 1024)
        print(f"{target}  ({count} plików, {size:.1f} MiB)")
        print(f"SHA-256: {digest}")
        print(f"Suma zapisana w: {target.name}.sha256")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
