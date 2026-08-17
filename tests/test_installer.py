from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import install


def test_frontend_build_uses_lockfile_and_npm_ci(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package-lock.json").write_text("{}", encoding="utf-8")
    calls: list[tuple[list[str], Path]] = []

    monkeypatch.setattr(install, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(install.shutil, "which", lambda name: "C:/node/npm.cmd" if name == "npm.cmd" else None)

    def record(command: list[str], *, cwd: Path, check: bool) -> subprocess.CompletedProcess[str]:
        assert check is True
        calls.append((command, cwd))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(install.subprocess, "run", record)
    install._build_frontend()

    assert calls == [
        (["C:/node/npm.cmd", "ci", "--no-audit", "--no-fund"], frontend),
        (["C:/node/npm.cmd", "run", "build"], frontend),
    ]


def test_frontend_build_requires_lockfile(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "frontend").mkdir()
    monkeypatch.setattr(install, "PROJECT_ROOT", tmp_path)

    with pytest.raises(RuntimeError, match="package-lock"):
        install._build_frontend()


def _install_args(**overrides: object) -> argparse.Namespace:
    defaults: dict[str, object] = {
        "port": 8765,
        "db_host": "127.0.0.1",
        "db_port": 3306,
        "db_name": "media_server",
        "db_user": "media_server",
        "ffmpeg_path": "ffmpeg",
        "base_url": None,
        "proxy_trusted": None,
    }
    return argparse.Namespace(**{**defaults, **overrides})


def test_generated_config_contains_private_thumbnail_cache(tmp_path: Path) -> None:
    args = _install_args()
    config = install._build_config(
        args,
        {"music": tmp_path / "music"},
        "database-secret",
        tmp_path / "runtime" / "thumbnails",
        tmp_path / "runtime" / "subtitles",
    )

    assert "[thumbnails]" in config
    assert 'cache_path = ' in config
    assert "runtime" in config
    assert "seek_seconds = 120" in config
    assert "[stereo]" in config
    assert 'ffmpeg_path = "ffmpeg"' in config
    assert "bitrate_kbps = 192" in config
    assert 'video_encoder = "libx264"' in config
    assert "max_concurrent_jobs = 2" in config
    assert "subtitle_cache_path = " in config


def test_a_local_install_gets_a_config_with_nothing_to_explain(tmp_path: Path) -> None:
    """Both public-facing sections are absent unless asked for: the application
    stands at the root and nothing sits in front of it."""
    config = install._build_config(
        _install_args(), {"music": tmp_path / "music"}, "secret",
        tmp_path / "thumbnails", tmp_path / "subtitles",
    )

    assert "[app]" not in config
    assert "[proxy]" not in config


def test_a_public_install_can_be_configured_without_editing_the_file(tmp_path: Path) -> None:
    """The two values a networked installation must change are the two the
    generated file never had, so every guide ended with "now open the TOML"."""
    config = install._build_config(
        _install_args(base_url="https://example.test/", proxy_trusted="203.0.113.10, 2001:db8::10"),
        {"music": tmp_path / "music"}, "secret",
        tmp_path / "thumbnails", tmp_path / "subtitles",
    )

    assert '[app]\nbase_url = "https://example.test/"' in config
    assert '[proxy]\ntrusted = "203.0.113.10, 2001:db8::10"' in config


@pytest.mark.parametrize("value", ["twoj.host", "ftp://twoj.host/", "media-next/"])
def test_a_base_url_that_cannot_be_clicked_in_mail_is_refused(value: str) -> None:
    with pytest.raises(argparse.ArgumentTypeError):
        install._base_url_argument(value)


@pytest.mark.parametrize("value", ["/", "/media-next/", "https://twoj.host/", "http://127.0.0.1/"])
def test_both_shapes_of_base_url_are_accepted(value: str) -> None:
    assert install._base_url_argument(value) == value


def test_a_mistyped_proxy_address_is_caught_at_install_time() -> None:
    """The failure it prevents is silent: an address nobody can match means the
    header is ignored and every visitor arrives wearing the proxy's address."""
    with pytest.raises(argparse.ArgumentTypeError, match="nie jest adresem IP"):
        install._proxy_trusted_argument("proxy.example.test")
    with pytest.raises(argparse.ArgumentTypeError, match="nie jest adresem IP"):
        install._proxy_trusted_argument("203.0.113.300")


def test_proxy_addresses_are_normalised_to_one_comma_separated_list() -> None:
    assert install._proxy_trusted_argument(" 203.0.113.10 ,2001:db8::10 ") == "203.0.113.10, 2001:db8::10"


def test_installer_rejects_config_only_with_frontend_build() -> None:
    assert install.main(["--config-only", "--build-frontend"]) == 1


def test_the_installer_runs_on_a_console_that_cannot_encode_polish(tmp_path: Path) -> None:
    """Windows hands a fresh process the system code page and stdout is strict,
    so on any Western-European installation the first Polish sentence used to
    end the installer with a UnicodeEncodeError — which is exactly why the CI
    job "Installer dry run (windows-latest)" had been failing from the start.
    This is the CI command, with the encoding pinned to reproduce it."""
    music = tmp_path / "music"
    music.mkdir()
    result = subprocess.run(
        [
            sys.executable, str(Path(install.__file__)),
            "--dev", "--non-interactive", "--dry-run",
            "--config", str(tmp_path / "config.local.toml"),
            "--music-root", str(music),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONIOENCODING": "cp1252", "MEDIA_SERVER_DB_PASSWORD": "test-only"},
    )

    assert "UnicodeEncodeError" not in result.stderr, result.stderr
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_placeholder_config_stops_the_install_before_the_environment_is_built(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Copying config.example.toml and running the installer used to look fine
    all the way through pip and the frontend build, and only then raise from the
    final check. The file is read first now."""
    config = tmp_path / "config.local.toml"
    config.write_text(
        '[security]\ntransfer_key = "GENERATE_WITH_INSTALLER"\n'
        '[database]\nname = "m"\nuser = "m"\npassword = "CHANGE_ME"\n'
        f'[roots.music]\npath = "{tmp_path.as_posix()}"\n',
        encoding="utf-8",
    )

    assert install.main(["--config", str(config), "--dry-run"]) == 1
    assert "Klucz transferowy" in capsys.readouterr().err


def test_a_usable_config_is_accepted_without_being_rewritten(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    key = base64.urlsafe_b64encode(bytes(range(32))).rstrip(b"=").decode("ascii")
    config = tmp_path / "config.local.toml"
    config.write_text(
        f'[security]\ntransfer_key = "{key}"\n'
        '[database]\nname = "m"\nuser = "m"\npassword = "s"\n'
        f'[roots.music]\npath = "{tmp_path.as_posix()}"\n',
        encoding="utf-8",
    )
    before = config.read_text(encoding="utf-8")

    assert install.main(["--config", str(config), "--config-only", "--dry-run"]) == 0
    assert config.read_text(encoding="utf-8") == before
    assert "nie zostanie nadpisana" in capsys.readouterr().out


def test_generated_config_stores_in_tree_paths_relative_to_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    project_root.mkdir()
    monkeypatch.setattr(install, "PROJECT_ROOT", project_root)
    args = _install_args(ffmpeg_path=str(project_root / "runtime" / "ffmpeg" / "bin" / "ffmpeg.exe"))

    config = install._build_config(
        args,
        {"music": tmp_path / "music"},
        "database-secret",
        project_root / "runtime" / "thumbnails",
        tmp_path / "elsewhere" / "subtitles",
    )

    assert 'cache_path = "runtime/thumbnails"' in config
    assert 'ffmpeg_path = "runtime/ffmpeg/bin/ffmpeg.exe"' in config
    # Paths outside the tree stay absolute; media roots always do.
    assert f"subtitle_cache_path = {json.dumps(str(tmp_path / 'elsewhere' / 'subtitles'))}" in config
    assert f"path = {json.dumps(str(tmp_path / 'music'))}" in config
    assert install._ffmpeg_config_value("ffmpeg") == "ffmpeg"


def test_python_dependencies_install_from_hashed_lock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "requirements.lock").write_text("aiofiles==25.1.0 --hash=sha256:00\n", encoding="utf-8")
    (tmp_path / "requirements-dev.lock").write_text("pytest==9.1.1 --hash=sha256:00\n", encoding="utf-8")
    monkeypatch.setattr(install, "PROJECT_ROOT", tmp_path)
    python = tmp_path / ".venv" / "bin" / "python"
    pip = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]

    assert install._python_dependency_commands(python, dev=False, no_lock=False) == [
        pip + ["--require-hashes", "-r", str(tmp_path / "requirements.lock")],
        pip + ["--no-deps", "--no-build-isolation", "-e", "."],
    ]
    assert install._python_dependency_commands(python, dev=True, no_lock=False) == [
        pip + ["--require-hashes", "-r", str(tmp_path / "requirements-dev.lock")],
        pip + ["--no-deps", "--no-build-isolation", "-e", "."],
    ]


def test_python_dependencies_refuse_missing_lock_unless_explicit(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(install, "PROJECT_ROOT", tmp_path)
    python = tmp_path / ".venv" / "bin" / "python"

    with pytest.raises(RuntimeError, match="requirements-dev.lock"):
        install._python_dependency_commands(python, dev=True, no_lock=False)

    assert install._python_dependency_commands(python, dev=True, no_lock=True) == [
        [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-e", ".[dev]"],
    ]


def test_lock_files_pin_runtime_dependencies_with_hashes() -> None:
    project_root = Path(install.PROJECT_ROOT)
    runtime = (project_root / "requirements.lock").read_text(encoding="utf-8")
    dev = (project_root / "requirements-dev.lock").read_text(encoding="utf-8")

    for name in ("cryptography==", "fastapi==", "uvicorn==", "setuptools=="):
        assert name in runtime
        assert name in dev
    assert "pytest==" in dev and "pytest==" not in runtime
    assert "--hash=sha256:" in runtime and "--hash=sha256:" in dev
    # Universal resolution keeps platform-specific pins behind environment markers.
    assert "sys_platform" in runtime
