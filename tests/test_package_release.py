"""What goes into the release archives (``scripts/package-release.py``) — and what never may.

An archive is the one thing strangers download and run with administrator
rights, so its contents are decided by rules that can be read and are tested
here: what git would ship, plus the built frontend, minus developer tooling and
minus what belongs to the other system; nothing that looks like a secret; and
never a build that swallowed the owner's licensed or non-commercial material
from ``frontend/vendor/``. The same rules build the ZIP for Windows and the
``.tar.gz`` for Debian.
"""
from __future__ import annotations

import gzip
import hashlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tarfile
import time
import zipfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _load():
    spec = importlib.util.spec_from_file_location("package_release", PROJECT_ROOT / "scripts" / "package-release.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["package_release"] = module
    spec.loader.exec_module(module)
    return module


package = _load()


@pytest.mark.parametrize(
    "path",
    [
        "Zainstaluj.cmd", "installer/Setup.ps1", "installer/lang/pl.psd1", "installer/setup_helper/cli.py",
        "installer/templates/vps/INSTRUKCJA-VPS.md.tmpl", "scripts/install.py", "scripts/secret-backup.py",
        "scripts/run-maintenance-windows.ps1", "src/media_server/cli.py", "migrations/001_foundation.sql",
        "integrations/php/stage/bridge.php", "deploy/apache/media-next-stage-wamp.conf.example",
        "config/config.example.toml", "requirements.lock", "requirements.txt", "pyproject.toml", "README.md",
        "LICENSE", "NOTICE.md", "docs/INSTALL-WINDOWS.md", ".htaccess",
    ],
)
def test_what_a_running_installation_needs_goes_in(path: str) -> None:
    assert package.exclusion_reason(path) is None
    assert package.private_reason(path) is None


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_app.py", "installer/tests/SelfTest.ps1", ".github/workflows/ci.yml", "frontend/src/main.ts",
        "frontend/package-lock.json", "scripts/check.py", "scripts/lock-deps.py", "scripts/package-release.py",
        "scripts/release-debian.sh", "scripts/install-debian.sh", "deploy/systemd/tryhackx-media-transfer.service",
        "deploy/fail2ban/jail.d/tryhackx-media.conf.example", "requirements-dev.lock", "requirements-dev.txt",
        "requirements-build.txt", ".gitignore", ".gitattributes", ".editorconfig",
    ],
)
def test_what_only_a_developer_or_a_debian_server_needs_stays_out(path: str) -> None:
    assert package.exclusion_reason(path)


@pytest.mark.parametrize(
    "path",
    [
        "config/config.local.toml", "config/config.backup-20261112-103000.local.toml", "config/installer.local.json",
        "integrations/php/stage/config.local.php", "config/origin/origin-key.pem", "config/origin/origin-cert.pem",
        "deploy/apache/server.key", "deploy/apache/site.crt", ".env", ".env.production", "secrets.json",
        "docs/aws-credentials.txt", "runtime/vps-bundle/origin.crt", "runtime/thumbnails/aa/bb.jpg", "logs/media-server.jsonl",
        "backups/installer/20261112-101500/httpd.conf", "scratch/notes.md", "dump.sql.gz", "service.log", ".venv/pyvenv.cfg",
    ],
)
def test_private_and_working_files_are_refused_by_name(path: str) -> None:
    assert package.private_reason(path), path


def test_an_example_of_an_env_file_is_not_a_secret() -> None:
    assert package.private_reason(".env.example") is None
    assert package.private_reason("deploy/apache/media-vhost.conf.example") is None


def test_the_selection_is_git_minus_tooling_plus_the_build() -> None:
    included, excluded = package.select_files(
        ["README.md", "tests/test_app.py", "installer/Setup.ps1", "frontend/src/main.ts", "scripts/install.py", "README.md"],
        ["public/assets/build/index.html", "public/assets/build/assets/app-1234.js"],
    )
    assert included == [
        "README.md", "installer/Setup.ps1", "public/assets/build/assets/app-1234.js",
        "public/assets/build/index.html", "scripts/install.py",
    ]
    assert dict(excluded) == {"frontend/src/main.ts": "źródła frontu — w paczce jest gotowy build", "tests/test_app.py": "testy"}


def test_the_real_repository_selects_the_wizard_and_no_tooling() -> None:
    if shutil.which("git") is None or not (PROJECT_ROOT / ".git").exists():
        pytest.skip("potrzebne repozytorium git")
    tracked = package.git_visible_files(PROJECT_ROOT)
    included, excluded = package.select_files(tracked, [])
    assert {"Zainstaluj.cmd", "installer/Setup.ps1", "installer/helper.py", "scripts/install.py", "requirements.lock"} <= set(included)
    assert not [path for path in included if path.startswith(("tests/", "frontend/", ".github/", "installer/tests/"))]
    # Everything left out is left out for a stated reason, and nothing selected is private by name.
    assert all(reason for _path, reason in excluded)
    assert [path for path in included if package.private_reason(path)] == []
    # Only the build is missing from this list — it is added from disk, where it exists.
    assert package.required_files(included) == ["public/assets/build/index.html"]


# -- a small project to package --------------------------------------------------------------


def _tree(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    files = {
        "pyproject.toml": '[project]\nname = "x"\nversion = "1.2.3"\n',
        "README.md": "# x\n",
        "LICENSE": "MIT\n",
        "Zainstaluj.cmd": "@echo off\necho start\n",
        "installer/Setup.ps1": "\ufeff$x = 1\n",
        "installer/helper.py": "print('x')\n",
        "installer/lang/pl.psd1": "\ufeff@{\n    'a' = 'Zażółć'\n}\n",
        "scripts/install.py": "print('install')\n",
        "scripts/start-windows.bat": "@echo off\n",
        "requirements.lock": "x==1 --hash=sha256:00\n",
        "src/media_server/__init__.py": '__version__ = "1.2.3"\n',
        "integrations/php/stage/bridge.php": "<?php\n",
        "deploy/apache/media-next-stage-wamp.conf.example": "Define TRYHACKX_MEDIA_ROOT \"C:/x\"\n",
        "config/config.example.toml": "[server]\nport = 8765\n",
        "migrations/001_foundation.sql": "SELECT 1;\n",
        "tests/test_x.py": "def test(): pass\n",
        "frontend/src/main.ts": "export {};\n",
        "frontend/package.json": "{}\n",
        "public/assets/build/index.html": '<!doctype html><meta name="media-app-base" content="/">\n',
        "public/assets/build/assets/app-abc.js": "console.log(1);\n",
    }
    for name, text in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
    # The secret patterns come from the gate; the small project carries the same file.
    shutil.copy(PROJECT_ROOT / "scripts" / "check.py", root / "scripts" / "check.py")
    past = (root / "public/assets/build/index.html").stat().st_mtime - 3600
    for source in ("frontend/src/main.ts", "frontend/package.json"):
        os.utime(root / source, (past, past))
    return root


GIT_FILES = [
    "pyproject.toml", "README.md", "LICENSE", "Zainstaluj.cmd", "installer/Setup.ps1", "installer/helper.py",
    "installer/lang/pl.psd1", "scripts/install.py", "scripts/start-windows.bat", "scripts/check.py", "requirements.lock",
    "src/media_server/__init__.py", "integrations/php/stage/bridge.php", "deploy/apache/media-next-stage-wamp.conf.example",
    "config/config.example.toml", "migrations/001_foundation.sql", "tests/test_x.py", "frontend/src/main.ts", "frontend/package.json",
]


def test_windows_scripts_are_stored_with_windows_line_endings_whatever_git_did(tmp_path: Path) -> None:
    root = _tree(tmp_path)
    assert package.archive_bytes(root, "Zainstaluj.cmd") == b"@echo off\r\necho start\r\n"
    assert package.archive_bytes(root, "scripts/start-windows.bat") == b"@echo off\r\n"
    assert package.archive_bytes(root, "installer/Setup.ps1") == b"\xef\xbb\xbf$x = 1\r\n"
    # Already CRLF: not doubled.
    (root / "Zainstaluj.cmd").write_bytes(b"@echo off\r\necho start\r\n")
    assert package.archive_bytes(root, "Zainstaluj.cmd") == b"@echo off\r\necho start\r\n"
    # Everything else travels byte for byte — a Python file or a shell script must keep LF.
    assert package.archive_bytes(root, "scripts/install.py") == b"print('install')\n"


def test_a_wizard_script_without_a_byte_order_mark_is_not_shipped(tmp_path: Path) -> None:
    root = _tree(tmp_path)
    (root / "installer/lang/pl.psd1").write_bytes("@{ 'a' = 'Zażółć' }\n".encode("utf-8"))
    with pytest.raises(package.PackagingError, match="BOM"):
        package.archive_bytes(root, "installer/lang/pl.psd1")


def test_the_archive_is_one_folder_sorted_and_reproducible(tmp_path: Path) -> None:
    root = _tree(tmp_path)
    included, _excluded = package.select_files(GIT_FILES, package.build_files(root))
    first = package.write_archive(root, included, tmp_path / "out" / "a.zip", folder="X-1.2.3", timestamp=1_780_000_000)
    second = package.write_archive(root, included, tmp_path / "out" / "b.zip", folder="X-1.2.3", timestamp=1_780_000_000)
    assert first == second, "the same input must give the same archive, or a checksum proves nothing"

    with zipfile.ZipFile(tmp_path / "out" / "a.zip") as archive:
        names = archive.namelist()
        assert names == sorted(names) and all(name.startswith("X-1.2.3/") for name in names)
        assert "X-1.2.3/public/assets/build/index.html" in names and "X-1.2.3/Zainstaluj.cmd" in names
        assert not [name for name in names if "/tests/" in name or "/frontend/" in name or name.endswith("check.py")]
        assert archive.read("X-1.2.3/Zainstaluj.cmd") == b"@echo off\r\necho start\r\n"
        assert {info.date_time for info in archive.infolist()} == {time.gmtime(1_780_000_000)[:6]}
        assert archive.testzip() is None

    checksum = (tmp_path / "out" / "a.zip.sha256").read_text(encoding="ascii")
    assert checksum == f"{first}  a.zip\n"
    assert hashlib.sha256((tmp_path / "out" / "a.zip").read_bytes()).hexdigest() == first
    assert not (tmp_path / "out" / "a.zip.part").exists()


def test_a_build_for_another_address_is_refused(tmp_path: Path) -> None:
    root = _tree(tmp_path)
    package.check_frontend_build(root, GIT_FILES)
    (root / "public/assets/build/index.html").write_text('<meta name="media-app-base" content="/media-next/">', encoding="utf-8")
    with pytest.raises(package.PackagingError, match="innej ścieżki"):
        package.check_frontend_build(root, GIT_FILES, allow_stale=True)


def test_a_build_older_than_its_sources_is_refused_unless_said_so(tmp_path: Path) -> None:
    root = _tree(tmp_path)
    later = (root / "public/assets/build/index.html").stat().st_mtime + 600
    os.utime(root / "frontend/src/main.ts", (later, later))
    with pytest.raises(package.PackagingError, match="frontend/src/main.ts"):
        package.check_frontend_build(root, GIT_FILES)
    package.check_frontend_build(root, GIT_FILES, allow_stale=True)
    # A test file changing does not make the build stale.
    (root / "frontend/src/x.test.ts").write_text("x", encoding="utf-8")
    os.utime(root / "frontend/src/main.ts", (later - 7200, later - 7200))
    os.utime(root / "frontend/src/x.test.ts", (later, later))
    package.check_frontend_build(root, [*GIT_FILES, "frontend/src/x.test.ts"])


def test_without_a_build_there_is_nothing_to_release(tmp_path: Path) -> None:
    root = _tree(tmp_path)
    shutil.rmtree(root / "public")
    with pytest.raises(package.PackagingError, match="npm run build"):
        package.build_files(root)


def test_a_tree_with_vendor_material_is_never_packaged(tmp_path: Path) -> None:
    """The build bakes in whatever lies in frontend/vendor/: a licensed icon set, packs
    under non-commercial licences, the owner's logos. None of it may be published."""
    root = _tree(tmp_path)
    built = package.build_files(root)
    package.check_no_vendor_content(root, built)

    (root / "frontend/vendor").mkdir()
    package.check_no_vendor_content(root, built)  # an empty folder holds nothing
    (root / "frontend/vendor/fontawesome-pro").mkdir()
    with pytest.raises(package.PackagingError, match="czystego klona"):
        package.check_no_vendor_content(root, built)

    # And when the folder was removed after the build: the build itself gives it away.
    shutil.rmtree(root / "frontend/vendor")
    pro = root / "public/assets/build/assets/iconpacks/fontawesome-pro-7.3.1/webfonts/fa-light-300.woff2"
    pro.parent.mkdir(parents=True)
    pro.write_bytes(b"wOF2")
    with pytest.raises(package.PackagingError, match="Font Awesome Pro"):
        package.check_no_vendor_content(root, package.build_files(root))


def test_a_file_that_looks_like_a_secret_stops_the_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _tree(tmp_path)
    monkeypatch.setattr(package, "PROJECT_ROOT", root)
    included, _excluded = package.select_files(GIT_FILES, package.build_files(root))
    assert package.secret_findings(root, included) == []

    # By content: a key pasted into a file with an innocent name (split so this test is not one itself).
    (root / "README.md").write_text("-----BEGIN " + "PRIVATE KEY-----\nAAAA\n", encoding="utf-8")
    # By name: a certificate somebody added to git on purpose.
    (root / "deploy/apache/site.crt").write_text("x", encoding="utf-8")
    # By value: the installation's own password, copied into a script.
    (root / "config/config.local.toml").write_text(
        '[security]\ntransfer_key = "k"\n[database]\npassword = "the-real-database-password"\n', encoding="utf-8"
    )
    (root / "scripts/install.py").write_text('PASSWORD = "the-real-database-password"\n', encoding="utf-8")
    findings = package.secret_findings(root, [*included, "deploy/apache/site.crt"])

    assert any(line.startswith("README.md: ") for line in findings)
    assert any(line.startswith("deploy/apache/site.crt: ") for line in findings)
    assert "scripts/install.py: zawiera wartość database.password z config.local.toml" in findings
    assert "the-real-database-password" not in "\n".join(findings), "a finding names the file, never the value"


def test_the_command_builds_refuses_and_lists(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    git = shutil.which("git")
    if git is None:
        pytest.skip("potrzebny git")
    root = _tree(tmp_path)
    (root / ".gitignore").write_text("public/assets/build/\ndist/\nconfig/config.local.toml\n", encoding="utf-8")
    subprocess.run([git, "init", "--quiet", str(root)], check=True, capture_output=True)
    monkeypatch.setattr(package, "PROJECT_ROOT", root)
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1780000000")

    assert package.main(["--list"]) == 0
    listing = capsys.readouterr().out
    assert "+ Zainstaluj.cmd" in listing and "+ public/assets/build/index.html" in listing
    assert "- tests/test_x.py" in listing and "- .gitignore" in listing and not (root / "dist").exists()

    assert package.main([]) == 0
    out = capsys.readouterr().out
    archive = root / "dist" / "TryHackX-Media-Server-1.2.3-windows.zip"
    assert archive.is_file() and (root / "dist" / (archive.name + ".sha256")).is_file()
    assert hashlib.sha256(archive.read_bytes()).hexdigest() in out
    with zipfile.ZipFile(archive) as packed:
        assert "TryHackX-Media-Server-1.2.3/installer/Setup.ps1" in packed.namelist()

    # A private configuration in the tree is not in the archive (git ignores it) …
    (root / "config/config.local.toml").write_text('[database]\npassword = "local-secret-value"\n', encoding="utf-8")
    assert package.main([]) == 0
    with zipfile.ZipFile(archive) as packed:
        assert not [name for name in packed.namelist() if name.endswith("config.local.toml")]
    capsys.readouterr()
    # … and its value pasted into a shipped file stops everything.
    (root / "README.md").write_text("password is local-secret-value\n", encoding="utf-8")
    archive.unlink()
    assert package.main([]) == 1
    assert "README.md" in capsys.readouterr().err and not archive.exists()


# -- the archive for Debian --------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "zainstaluj-debian.sh", "installer/helper.py", "installer/setup_helper/cli.py", "installer/setup_helper/debian.py",
        "installer/debian/lib/steps.sh", "installer/debian/lang/en.sh", "installer/debian/examples/answers-lan.toml",
        "installer/templates/vps/vps-setup.sh.tmpl", "installer/templates/vps/site-https.conf.tmpl", "scripts/install.py",
        "scripts/release-debian.sh", "scripts/install-debian.sh", "scripts/secret-backup.py",
        "deploy/systemd/tryhackx-media-transfer.service", "deploy/systemd/tryhackx-media-maintenance.timer",
        "deploy/fail2ban/jail.d/tryhackx-media.conf.example", "deploy/apache/media-next.conf.example",
        "deploy/apache/media-transfer.conf.example", "deploy/apache/media-hardening.conf.example", "src/media_server/cli.py",
        "migrations/001_foundation.sql", "integrations/php/stage/bridge.php", "config/config.example.toml",
        "requirements.lock", "pyproject.toml", "README.md", "LICENSE", "NOTICE.md", "docs/INSTALL-DEBIAN.md", ".htaccess",
    ],
)
def test_what_a_debian_server_needs_goes_into_its_archive(path: str) -> None:
    assert package.exclusion_reason(path, "debian") is None
    assert package.private_reason(path) is None


@pytest.mark.parametrize(
    "path",
    [
        "Zainstaluj.cmd", "Install.cmd", "installer/Setup.ps1", "installer/lib/Steps.ps1", "installer/lang/pl.psd1",
        "installer/lang/en.psd1", "installer/examples/answers-vps.json", "installer/tests/SelfTest.ps1",
        "scripts/start-windows.ps1", "scripts/start-windows.bat", "scripts/run-maintenance-windows.ps1",
        "scripts/register-stage-task-windows.bat", "deploy/apache/media-next-stage-wamp.conf.example",
        # … and what no archive carries, whatever the system.
        "tests/test_app.py", "tests/debian_stubs/system-command.sh", ".github/workflows/ci.yml", "frontend/src/main.ts",
        "scripts/check.py", "scripts/package-release.py", "requirements-dev.lock", ".gitattributes",
    ],
)
def test_the_windows_wizard_and_the_tooling_stay_out_of_the_debian_archive(path: str) -> None:
    assert package.exclusion_reason(path, "debian")


@pytest.mark.parametrize(
    "path",
    ["zainstaluj-debian.sh", "installer/debian/lib/common.sh", "installer/debian/lang/pl.sh", "installer/debian/examples/answers-lan.toml"],
)
def test_the_debian_installer_stays_out_of_the_windows_archive(path: str) -> None:
    assert package.exclusion_reason(path, "windows") and package.exclusion_reason(path)
    assert package.exclusion_reason(path, "debian") is None


def test_both_archives_carry_the_shared_helper_and_the_vps_templates() -> None:
    """One module writes the VPS bundle on both systems: it must be in both archives."""
    for path in (
        "installer/helper.py", "installer/setup_helper/vpsbundle.py", "installer/setup_helper/apacheconf.py",
        "installer/templates/vps/INSTRUKCJA-VPS.md.tmpl", "installer/templates/vps/site-http.conf.tmpl", "scripts/install.py",
    ):
        for platform in package.PLATFORMS:
            assert package.exclusion_reason(path, platform) is None, (path, platform)


def test_the_real_repository_selects_the_debian_installer_and_nothing_of_windows() -> None:
    if shutil.which("git") is None or not (PROJECT_ROOT / ".git").exists():
        pytest.skip("potrzebne repozytorium git")
    tracked = package.git_visible_files(PROJECT_ROOT)
    included, excluded = package.select_files(tracked, [], "debian")
    chosen = set(included)
    assert {
        "zainstaluj-debian.sh", "installer/helper.py", "installer/debian/lib/flows.sh", "installer/debian/lang/pl.sh",
        "installer/debian/lang/en.sh", "installer/templates/vps/vps-setup.sh.tmpl", "scripts/release-debian.sh",
        "deploy/systemd/tryhackx-media-transfer.service", "deploy/fail2ban/filter.d/tryhackx-media-auth.conf.example",
    } <= chosen
    # Nothing a Debian machine cannot run: no PowerShell, no batch file — the wizard for Windows has its own archive.
    assert [path for path in included if path.lower().endswith((".ps1", ".psd1", ".cmd", ".bat"))] == []
    assert not [path for path in included if path.startswith(("tests/", "frontend/", ".github/", "installer/tests/", "installer/lib/"))]
    assert all(reason for _path, reason in excluded)
    assert [path for path in included if package.private_reason(path)] == []
    assert package.required_files(included, "debian") == ["public/assets/build/index.html"]
    # And the other way round: the archive for Windows has no shell script and no unit.
    windows, _left_out = package.select_files(tracked, [], "windows")
    assert [path for path in windows if path.endswith((".sh", ".service", ".timer")) or path.startswith("installer/debian/")] == []


DEBIAN_FILES = {
    "zainstaluj-debian.sh": "#!/usr/bin/env bash\necho start\n",
    "installer/setup_helper/cli.py": "print('helper')\n",
    "installer/debian/lib/common.sh": "# shellcheck shell=bash\nrun() { \"$@\"; }\n",
    "installer/debian/lang/pl.sh": "MSG=( [a.b]='Zażółć' )\n",
    "installer/templates/vps/vps-setup.sh.tmpl": "#!/usr/bin/env bash\necho vps\n",
    "scripts/release-debian.sh": "#!/usr/bin/env bash\necho release\n",
    "deploy/systemd/tryhackx-media-transfer.service": "[Unit]\nDescription=x\n\n[Service]\nExecStart=/opt/x\n",
    "deploy/apache/media-next.conf.example": "RewriteEngine On\n",
    "deploy/apache/media-transfer.conf.example": "ProxyPass /x http://127.0.0.1:8765/x\n",
    "deploy/fail2ban/jail.d/tryhackx-media.conf.example": "[tryhackx-media-auth]\nenabled = true\n",
    "docs/logo.png": None,
}
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\r\n"


def _debian_tree(tmp_path: Path) -> Path:
    """The small project of the Windows tests, with what a Debian release cannot work without."""
    root = _tree(tmp_path)
    for name, text in DEBIAN_FILES.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(PNG if text is None else text.encode("utf-8"))
    return root


DEBIAN_GIT_FILES = [*GIT_FILES, *DEBIAN_FILES]


def _members(archive: Path) -> dict[str, tarfile.TarInfo]:
    with tarfile.open(archive, "r:gz") as packed:
        return {member.name: member for member in packed.getmembers()}


def _content(archive: Path, name: str) -> bytes:
    with tarfile.open(archive, "r:gz") as packed:
        handle = packed.extractfile(name)
        assert handle is not None, name
        return handle.read()


def test_debian_files_are_stored_with_unix_line_endings_whatever_git_did(tmp_path: Path) -> None:
    """A checkout on Windows with core.autocrlf gives every text file CR LF. bash reads the CR
    as part of a command and systemd as part of a value, so the archive must not carry one."""
    root = _debian_tree(tmp_path)
    (root / "zainstaluj-debian.sh").write_bytes(b"#!/usr/bin/env bash\r\necho start\r\n")
    (root / "deploy/systemd/tryhackx-media-transfer.service").write_bytes(b"[Unit]\r\nDescription=x\r\n")
    (root / "config/config.example.toml").write_bytes(b"[server]\r\nport = 8765\r\n")
    assert package.archive_bytes(root, "zainstaluj-debian.sh", "debian") == b"#!/usr/bin/env bash\necho start\n"
    assert package.archive_bytes(root, "deploy/systemd/tryhackx-media-transfer.service", "debian") == b"[Unit]\nDescription=x\n"
    assert package.archive_bytes(root, "config/config.example.toml", "debian") == b"[server]\nport = 8765\n"
    # Already LF: untouched. Polish letters survive.
    assert package.archive_bytes(root, "installer/debian/lang/pl.sh", "debian") == "MSG=( [a.b]='Zażółć' )\n".encode("utf-8")
    # A picture has CR LF in its signature and keeps it; so does the build, which is nobody's checkout.
    assert package.archive_bytes(root, "docs/logo.png", "debian") == PNG
    (root / "public/assets/build/assets/app-abc.js").write_bytes(b"console.log(1);\r\n")
    assert package.archive_bytes(root, "public/assets/build/assets/app-abc.js", "debian") == b"console.log(1);\r\n"
    # The archive for Windows is not affected by any of this.
    assert package.archive_bytes(root, "config/config.example.toml") == b"[server]\r\nport = 8765\r\n"


def test_the_debian_archive_is_one_folder_sorted_executable_and_reproducible(tmp_path: Path) -> None:
    root = _debian_tree(tmp_path)
    (root / "zainstaluj-debian.sh").write_bytes(b"#!/usr/bin/env bash\r\necho start\r\n")
    included, excluded = package.select_files(DEBIAN_GIT_FILES, package.build_files(root), "debian")
    assert package.required_files(included, "debian") == []
    left_out = dict(excluded)
    assert left_out["Zainstaluj.cmd"] == left_out["installer/Setup.ps1"] == "kreator dla Windows"
    assert left_out["scripts/start-windows.bat"] == "tylko Windows" and left_out["tests/test_x.py"] == "testy"

    first = package.write_tarball(root, included, tmp_path / "out" / "a.tar.gz", folder="X-1.2.3", timestamp=1_780_000_000)
    # A different moment, a different name in the same folder: the bytes must not know.
    time.sleep(1.1)
    second = package.write_tarball(root, included, tmp_path / "out" / "b.tar.gz", folder="X-1.2.3", timestamp=1_780_000_000)
    assert first == second, "the same input must give the same archive, or a checksum proves nothing"
    assert (tmp_path / "out" / "a.tar.gz").read_bytes() == (tmp_path / "out" / "b.tar.gz").read_bytes()

    members = _members(tmp_path / "out" / "a.tar.gz")
    names = list(members)
    assert names == sorted(names) and all(name.startswith("X-1.2.3/") for name in names)
    assert {"X-1.2.3/zainstaluj-debian.sh", "X-1.2.3/public/assets/build/index.html", "X-1.2.3/installer/helper.py"} <= set(names)
    assert not [name for name in names if "/tests/" in name or "/frontend/" in name or name.endswith(("check.py", ".cmd", ".ps1", ".psd1", ".bat"))]
    for name, member in members.items():
        assert member.isfile(), name
        assert member.mode == (0o755 if name.endswith(".sh") else 0o644), name
        assert (member.uid, member.gid, member.uname, member.gname, member.mtime) == (0, 0, "root", "root", 1_780_000_000), name
    # `sudo bash zainstaluj-debian.sh` or `sudo ./zainstaluj-debian.sh`: both must work straight after unpacking.
    assert members["X-1.2.3/zainstaluj-debian.sh"].mode == 0o755 and members["X-1.2.3/scripts/release-debian.sh"].mode == 0o755
    assert members["X-1.2.3/installer/templates/vps/vps-setup.sh.tmpl"].mode == 0o644
    assert _content(tmp_path / "out" / "a.tar.gz", "X-1.2.3/zainstaluj-debian.sh") == b"#!/usr/bin/env bash\necho start\n"
    assert _content(tmp_path / "out" / "a.tar.gz", "X-1.2.3/docs/logo.png") == PNG

    # Nothing of the builder in the gzip header either: no file name, no time.
    raw = (tmp_path / "out" / "a.tar.gz").read_bytes()
    assert raw[:4] == b"\x1f\x8b\x08\x00" and raw[4:8] == b"\x00\x00\x00\x00"
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as plain:
        assert plain.read(262)[257:262] == b"ustar"

    checksum = (tmp_path / "out" / "a.tar.gz.sha256").read_text(encoding="ascii")
    assert checksum == f"{first}  a.tar.gz\n"
    assert hashlib.sha256(raw).hexdigest() == first
    assert not (tmp_path / "out" / "a.tar.gz.part").exists()


def test_a_debian_selection_without_its_installer_is_not_a_release(tmp_path: Path) -> None:
    root = _debian_tree(tmp_path)
    without = [path for path in DEBIAN_GIT_FILES if path not in {"zainstaluj-debian.sh", "scripts/release-debian.sh"}]
    included, _excluded = package.select_files(without, package.build_files(root), "debian")
    assert package.required_files(included, "debian") == ["zainstaluj-debian.sh", "scripts/release-debian.sh"]
    # The Windows selection from the very same files misses nothing: each system is judged by its own list.
    windows, _left_out = package.select_files(without, package.build_files(root), "windows")
    assert package.required_files(windows, "windows") == []


def test_the_command_builds_the_debian_archive_and_both_at_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    git = shutil.which("git")
    if git is None:
        pytest.skip("potrzebny git")
    root = _debian_tree(tmp_path)
    (root / ".gitignore").write_text("public/assets/build/\ndist/\nconfig/config.local.toml\n", encoding="utf-8")
    subprocess.run([git, "init", "--quiet", str(root)], check=True, capture_output=True)
    monkeypatch.setattr(package, "PROJECT_ROOT", root)
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1780000000")

    assert package.main(["--platform", "all", "--list"]) == 0
    listing = capsys.readouterr().out
    windows_part, debian_part = listing.split("== debian")
    assert windows_part.startswith("== windows")
    assert "+ Zainstaluj.cmd" in windows_part and "- zainstaluj-debian.sh    (instalator dla Debiana)" in windows_part
    assert "+ zainstaluj-debian.sh" in debian_part and "- Zainstaluj.cmd    (kreator dla Windows)" in debian_part
    assert "+ public/assets/build/index.html" in debian_part and not (root / "dist").exists()

    assert package.main(["--platform", "debian"]) == 0
    out = capsys.readouterr().out
    tarball = root / "dist" / "TryHackX-Media-Server-1.2.3-debian.tar.gz"
    zipped = root / "dist" / "TryHackX-Media-Server-1.2.3-windows.zip"
    assert tarball.is_file() and (root / "dist" / (tarball.name + ".sha256")).is_file() and not zipped.exists()
    assert hashlib.sha256(tarball.read_bytes()).hexdigest() in out
    members = _members(tarball)
    # The same top folder as in the ZIP: the documentation names one path for both systems.
    assert "TryHackX-Media-Server-1.2.3/zainstaluj-debian.sh" in members
    assert not [name for name in members if name.endswith(("Zainstaluj.cmd", "Setup.ps1", "config.local.toml"))]
    alone = tarball.read_bytes()

    assert package.main(["--platform", "all"]) == 0
    out = capsys.readouterr().out
    assert zipped.is_file() and tarball.read_bytes() == alone, "built alone or together, the archive is the same"
    assert out.count("SHA-256: ") == 2
    with zipfile.ZipFile(zipped) as packed:
        assert not [name for name in packed.namelist() if name.endswith(".sh") or "/installer/debian/" in name]

    # A Debian release that cannot work stops both archives: a release is all of its files or none.
    tarball.unlink()
    zipped.unlink()
    (root / "scripts/release-debian.sh").unlink()
    assert package.main(["--platform", "all"]) == 1
    assert "scripts/release-debian.sh" in capsys.readouterr().err
    assert not tarball.exists() and not zipped.exists()
    # The Windows archive alone does not depend on it.
    assert package.main([]) == 0 and zipped.is_file()
    capsys.readouterr()

    # The secret refusal is the same for both systems.
    (root / "scripts/release-debian.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (root / "config/config.local.toml").write_text('[database]\npassword = "local-secret-value"\n', encoding="utf-8")
    (root / "installer/debian/lib/common.sh").write_text("PASSWORD='local-secret-value'\n", encoding="utf-8")
    # … and a template is read like any other text: the VPS script is made from one.
    (root / "installer/templates/vps/vps-setup.sh.tmpl").write_text("-----BEGIN " + "PRIVATE KEY-----\nAAAA\n", encoding="utf-8")
    assert package.main(["--platform", "debian"]) == 1
    refused = capsys.readouterr().err
    assert "installer/debian/lib/common.sh: zawiera wartość database.password z config.local.toml" in refused
    assert "installer/templates/vps/vps-setup.sh.tmpl: klucz prywatny PEM" in refused
    assert "local-secret-value" not in refused and not tarball.exists()
