from __future__ import annotations

import os
from pathlib import Path

import pytest

from media_server.paths import PathAccessError, resolve_item
from media_server.security import GrantItem


def test_resolves_regular_file_inside_root(media_root: Path) -> None:
    directory = media_root / "Artist"
    directory.mkdir()
    target = directory / "song.flac"
    target.write_bytes(b"audio")

    result = resolve_item(GrantItem(root="music", path="Artist/song.flac"), {"music": media_root})

    assert result.path == target.resolve()
    assert result.size == 5


@pytest.mark.parametrize("path", ["../secret", "folder/../../secret", "/absolute/file", "C:/secret"])
def test_rejects_traversal_and_absolute_paths(media_root: Path, path: str) -> None:
    with pytest.raises(PathAccessError):
        resolve_item(GrantItem(root="music", path=path), {"music": media_root})


def test_rejects_symlink_escaping_root(tmp_path: Path, media_root: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    link = media_root / "escape.txt"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("Tworzenie symlinków nie jest dostępne w tym środowisku")

    with pytest.raises(PathAccessError):
        resolve_item(GrantItem(root="music", path="escape.txt"), {"music": media_root})


@pytest.mark.skipif(os.name != "nt", reason="Windows junction test")
def test_rejects_windows_junction_escaping_root(tmp_path: Path, media_root: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")
    junction = media_root / "escape"
    result = __import__("subprocess").run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip("Windows junction creation is unavailable")

    with pytest.raises(PathAccessError):
        resolve_item(
            GrantItem(root="music", path="escape/secret.txt"),
            {"music": media_root},
        )
