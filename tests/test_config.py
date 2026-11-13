from __future__ import annotations

import base64
from pathlib import Path

import pytest

from media_server import config as config_module
from media_server.config import ConfigError, load_config

KEY = base64.urlsafe_b64encode(bytes(range(32))).rstrip(b"=").decode("ascii")


def _write(tmp_path: Path, body: str, media_root: Path) -> Path:
    path = tmp_path / "config.local.toml"
    path.write_text(
        "[security]\n"
        f'transfer_key = "{KEY}"\n'
        "[database]\n"
        'name = "media_server"\n'
        'user = "media"\n'
        'password = "secret"\n'
        f"{body}\n"
        "[roots.music]\n"
        f"path = {str(media_root)!r}\n".replace("'", '"'),
        encoding="utf-8",
    )
    return path


def test_relative_project_paths_resolve_against_project_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project_root = tmp_path / "project"
    (project_root / "runtime").mkdir(parents=True)
    monkeypatch.setattr(config_module, "PROJECT_ROOT", project_root)
    media = tmp_path / "media"
    media.mkdir()

    loaded = load_config(
        _write(
            tmp_path,
            "[thumbnails]\n"
            'cache_path = "runtime/thumbnails"\n'
            "[stereo]\n"
            'ffmpeg_path = "runtime/ffmpeg/bin/ffmpeg.exe"\n'
            'subtitle_cache_path = "runtime/subtitles"\n',
            media,
        )
    )

    assert loaded.thumbnails.cache_path == (project_root / "runtime" / "thumbnails").resolve()
    assert loaded.stereo.subtitle_cache_path == (project_root / "runtime" / "subtitles").resolve()
    assert loaded.stereo.ffmpeg_path == str((project_root / "runtime" / "ffmpeg" / "bin" / "ffmpeg.exe").resolve())
    assert loaded.roots["music"] == media


def test_absolute_paths_and_bare_ffmpeg_name_are_kept(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    cache = tmp_path / "cache"

    loaded = load_config(
        _write(
            tmp_path,
            "[thumbnails]\n"
            f'cache_path = "{cache.as_posix()}"\n'
            "[stereo]\n"
            'ffmpeg_path = "ffmpeg"\n',
            media,
        )
    )

    assert loaded.thumbnails.cache_path == cache
    assert loaded.stereo.ffmpeg_path == "ffmpeg"
    assert loaded.stereo.subtitle_cache_path is None


def test_media_roots_must_stay_absolute(tmp_path: Path) -> None:
    path = tmp_path / "config.local.toml"
    path.write_text(
        f'[security]\ntransfer_key = "{KEY}"\n[database]\nuser = "m"\n[roots.music]\npath = "media/music"\n',
        encoding="utf-8",
    )

    with pytest.raises(ConfigError, match="roots.music.path"):
        load_config(path)


def test_environment_overrides_secrets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    media = tmp_path / "media"
    media.mkdir()
    other_key = base64.urlsafe_b64encode(bytes(range(32, 64))).rstrip(b"=").decode("ascii")
    monkeypatch.setenv("MEDIA_SERVER_DB_PASSWORD", "from-env")
    monkeypatch.setenv("MEDIA_SERVER_TRANSFER_KEY", other_key)

    loaded = load_config(_write(tmp_path, "", media))

    assert loaded.database.password == "from-env"
    assert loaded.security.transfer_key == bytes(range(32, 64))


def test_remote_bind_requires_explicit_opt_in(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()

    with pytest.raises(ConfigError, match="allow_remote_bind"):
        load_config(_write(tmp_path, '[server]\nhost = "0.0.0.0"\n', media))


def test_placeholder_transfer_key_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "config.local.toml"
    path.write_text(
        '[security]\ntransfer_key = "GENERATE_WITH_INSTALLER"\n[database]\nuser = "m"\n'
        f'[roots.music]\npath = "{tmp_path.as_posix()}"\n',
        encoding="utf-8",
    )

    with pytest.raises(ConfigError, match="transfer"):
        load_config(path)
