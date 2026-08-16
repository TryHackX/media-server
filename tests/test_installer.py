from __future__ import annotations

import argparse
import base64
import json
import subprocess
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


def test_generated_config_contains_private_thumbnail_cache(tmp_path: Path) -> None:
    args = argparse.Namespace(
        port=8765,
        db_host="127.0.0.1",
        db_port=3306,
        db_name="media_server",
        db_user="media_server",
        ffmpeg_path="ffmpeg",
    )
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


def test_installer_rejects_config_only_with_frontend_build() -> None:
    assert install.main(["--config-only", "--build-frontend"]) == 1


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
    args = argparse.Namespace(
        port=8765,
        db_host="127.0.0.1",
        db_port=3306,
        db_name="media_server",
        db_user="media_server",
        ffmpeg_path=str(project_root / "runtime" / "ffmpeg" / "bin" / "ffmpeg.exe"),
    )

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
