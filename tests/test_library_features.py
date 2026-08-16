from __future__ import annotations

import hashlib
import time
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from media_server.app import create_app
from media_server.catalog import DiscoveredDirectory, DiscoveredFile, discover_catalog
from media_server.config import AppConfig, ThumbnailConfig
from media_server.security import GrantItem, seal_grant


def _file_token(config: AppConfig, path: str) -> str:
    return seal_grant(
        key=config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path=path)],
        download_name=Path(path).name,
        disposition="inline",
        ttl_seconds=300,
        now=int(time.time()),
    )


def test_catalog_discovers_directories_images_and_safe_auxiliary_files(tmp_path: Path) -> None:
    album = tmp_path / "Artist" / "Album"
    album.mkdir(parents=True)
    (album / "song.flac").write_bytes(b"audio")
    (album / "cover.jpg").write_bytes(b"image")
    (album / "notes.nfo").write_text("notes", encoding="utf-8")
    (album / "run.exe").write_bytes(b"unsafe")

    entries = list(discover_catalog("music", tmp_path, "music"))
    directories = [entry.relative_path for entry in entries if isinstance(entry, DiscoveredDirectory)]
    files = {
        entry.relative_path: entry.media_kind
        for entry in entries
        if isinstance(entry, DiscoveredFile)
    }

    assert set(directories) == {"", "Artist", "Artist/Album"}
    assert files == {
        "Artist/Album/song.flac": "audio",
        "Artist/Album/cover.jpg": "image",
        "Artist/Album/notes.nfo": "other",
    }


def test_thumbnail_endpoint_reuses_legacy_compatible_cache(
    app_config: AppConfig,
    media_root: Path,
    tmp_path: Path,
) -> None:
    video = media_root / "movie.mp4"
    video.write_bytes(b"not-a-real-video")
    cache = tmp_path / "thumbnails"
    cache.mkdir()
    digest = hashlib.sha1(f"{video.resolve()}120".encode("utf-8")).hexdigest()
    thumbnail = cache / f"thumb_{digest}.jpg"
    thumbnail.write_bytes(b"jpeg-thumbnail")
    config = replace(app_config, thumbnails=ThumbnailConfig(cache_path=cache, seek_seconds=120))
    token = _file_token(config, "movie.mp4")

    with TestClient(create_app(config)) as client:
        response = client.get(f"/v1/thumbnails/{token}")

    assert response.status_code == 200
    assert response.content == b"jpeg-thumbnail"
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.headers["cache-control"].startswith("private, max-age=3600")


def test_thumbnail_endpoint_returns_cacheable_204_without_available_thumbnail(
    app_config: AppConfig,
    media_root: Path,
) -> None:
    (media_root / "movie.mp4").write_bytes(b"video")
    token = _file_token(app_config, "movie.mp4")

    with TestClient(create_app(app_config)) as client:
        response = client.get(f"/v1/thumbnails/{token}")

    assert response.status_code == 204
    assert response.headers["x-thumbnail-available"] == "no"
    assert response.headers["cache-control"].startswith("private, max-age=86400")
