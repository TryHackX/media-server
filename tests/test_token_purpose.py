"""A transfer token opens only the routes it was issued for.

Before purposes, the only check was ``kind == "file"``: a thumbnail's token or a
guest link's opened transcoding and subtitle rendering, also for an account whose
group has compatibility mode switched off, and without the stream cap that only a
compatibility grant carries.
"""
from __future__ import annotations

import base64
import json
import secrets
import time
from dataclasses import replace
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

import media_server.app as app_module
from media_server.app import create_app
from media_server.config import AppConfig, StereoConfig
from media_server.security import GrantItem, TokenError, open_grant, seal_grant


def _open(token: str, key: bytes, now: int = 100):
    return open_grant(
        token,
        key=key,
        max_ttl_seconds=900,
        clock_skew_seconds=5,
        max_token_bytes=65536,
        max_archive_entries=100,
        now=now,
    )


def _seal_raw(key: bytes, payload: dict) -> str:
    """Seal a payload by hand — the shape an older bridge, or a forger, would send."""
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(nonce, json.dumps(payload).encode("utf-8"), b"tryhackx-media-transfer:v1")
    return "v1." + base64.urlsafe_b64encode(nonce + sealed).rstrip(b"=").decode("ascii")


def _legacy_payload(*, kind: str = "file", disposition: str = "inline", ttl: int = 300, issued: int = 100) -> dict:
    return {
        "v": 1,
        "aud": "transfer",
        "kind": kind,
        "iat": issued,
        "exp": issued + ttl,
        "name": "song.flac",
        "disposition": disposition,
        "items": [{"root": "music", "path": "song.flac"}],
    }


def _file(key: bytes, *, disposition: str = "inline", purpose: str | None = None, **extra) -> str:
    return seal_grant(
        key=key,
        kind="file",
        items=[GrantItem(root="music", path="song.flac")],
        download_name="song.flac",
        disposition=disposition,
        purpose=purpose,
        now=100,
        **extra,
    )


def test_every_purpose_round_trips_and_names_one_use(transfer_key: bytes) -> None:
    assert _open(_file(transfer_key, disposition="attachment"), transfer_key).uses == {"download"}
    assert _open(_file(transfer_key), transfer_key).uses == {"play"}
    assert _open(_file(transfer_key, purpose="thumb"), transfer_key).uses == {"thumb"}
    compat = _open(_file(transfer_key, purpose="compat", subject="7", max_streams=2), transfer_key)
    assert compat.uses == {"compat"} and compat.max_streams == 2
    archive = seal_grant(
        key=transfer_key, kind="archive", items=[GrantItem(root="music", path="a.flac")],
        download_name="a.zip", now=100,
    )
    assert _open(archive, transfer_key).uses == {"download"}


@pytest.mark.parametrize(
    ("disposition", "purpose"),
    [("inline", "download"), ("attachment", "play"), ("attachment", "thumb"), ("attachment", "compat"), ("inline", "x")],
)
def test_a_purpose_that_does_not_fit_the_grant_is_never_sealed(
    transfer_key: bytes, disposition: str, purpose: str
) -> None:
    with pytest.raises(ValueError):
        _file(transfer_key, disposition=disposition, purpose=purpose)


def test_the_stream_cap_is_sealed_only_into_a_compatibility_grant(transfer_key: bytes) -> None:
    with pytest.raises(ValueError):
        _file(transfer_key, purpose="play", subject="7", max_streams=2)


@pytest.mark.parametrize("purpose", ["transcode", "", "COMPAT", 1, ["compat"], {"use": "compat"}])
def test_an_unknown_purpose_is_refused_when_opened(transfer_key: bytes, purpose: object) -> None:
    payload = _legacy_payload()
    payload["purpose"] = purpose
    with pytest.raises(TokenError):
        _open(_seal_raw(transfer_key, payload), transfer_key)


@pytest.mark.parametrize(
    ("kind", "disposition", "purpose"),
    [("file", "inline", "download"), ("file", "attachment", "compat"), ("archive", "attachment", "play")],
)
def test_a_purpose_contradicting_the_grant_is_refused_when_opened(
    transfer_key: bytes, kind: str, disposition: str, purpose: str
) -> None:
    payload = _legacy_payload(kind=kind, disposition=disposition)
    payload["purpose"] = purpose
    with pytest.raises(TokenError):
        _open(_seal_raw(transfer_key, payload), transfer_key)


@pytest.mark.parametrize(
    ("kind", "disposition", "ttl"),
    [("file", "inline", 300), ("file", "inline", 900), ("file", "attachment", 300), ("archive", "attachment", 300)],
)
def test_a_token_that_names_no_purpose_is_refused(transfer_key: bytes, kind: str, disposition: str, ttl: int) -> None:
    """Tokens sealed before purposes (08.11.2026) lived fifteen minutes; reading them by guesswork is over."""
    payload = _legacy_payload(kind=kind, disposition=disposition, ttl=ttl)
    with pytest.raises(TokenError):
        _open(_seal_raw(transfer_key, payload), transfer_key)
    # The same payload with its purpose named is what the bridge seals today.
    payload["purpose"] = "download" if disposition == "attachment" else "play"
    assert _open(_seal_raw(transfer_key, payload), transfer_key).uses == {payload["purpose"]}


# --- every route against every purpose -------------------------------------------------

_COMPAT_ROUTES = (
    ("GET", "/v1/stereo-info/{token}"),
    ("GET", "/v1/stereo-keyframe/{token}"),
    ("GET", "/v1/subtitles/{token}?subtitle_track=0"),
    ("GET", "/v1/subtitle-pictures/{token}?subtitle_track=0"),
    ("GET", "/v1/subtitle-picture/{token}?subtitle_track=0&frame=000001"),
    ("GET", "/v1/stereo/{token}?stream_id=viewer-123456"),
    ("HEAD", "/v1/stereo/{token}"),
    ("DELETE", "/v1/stereo/{token}?stream_id=viewer-123456"),
)


def _grant(config: AppConfig, purpose: str | None, *, legacy_ttl: int | None = None) -> str:
    if legacy_ttl is not None:
        payload = _legacy_payload(ttl=legacy_ttl, issued=int(time.time()))
        payload["items"] = [{"root": "music", "path": "movie.mkv"}]
        return _seal_raw(config.security.transfer_key, payload)
    return seal_grant(
        key=config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="movie.mkv")],
        download_name="movie.mkv",
        disposition="attachment" if purpose == "download" else "inline",
        ttl_seconds=900 if purpose == "compat" else 300,
        purpose=purpose,
    )


@pytest.fixture
def compat_config(app_config: AppConfig, media_root: Path, monkeypatch) -> AppConfig:
    (media_root / "movie.mkv").write_bytes(b"video-source")

    async def fake_info(*_args, **_kwargs) -> dict[str, object]:
        return {
            "duration_seconds": 60.0,
            "video_codec": "h264",
            "video_width": 1920,
            "video_height": 1080,
            "audio_tracks": [],
            "subtitle_tracks": [{"index": 0, "codec": "subrip", "supported": True}],
        }

    async def fake_chunks(*_args, **_kwargs):
        yield b"fragment"

    async def fake_subtitles(*_args, **_kwargs) -> bytes:
        return b"WEBVTT\n"

    monkeypatch.setattr(app_module, "probe_media_info", fake_info)
    monkeypatch.setattr(app_module, "compatible_media_chunks", fake_chunks)
    monkeypatch.setattr(app_module, "extract_subtitle_webvtt", fake_subtitles)
    return replace(app_config, stereo=StereoConfig(ffmpeg_path="ffmpeg"))


@pytest.mark.parametrize("purpose", ["play", "thumb", "download"])
def test_playback_preview_and_download_tokens_never_open_compatibility_mode(
    compat_config: AppConfig, purpose: str
) -> None:
    token = _grant(compat_config, purpose)
    with TestClient(create_app(compat_config)) as client:
        for method, route in _COMPAT_ROUTES:
            response = client.request(method, route.format(token=token))
            assert response.status_code == 403, (purpose, method, route)


def test_a_compatibility_token_opens_compatibility_mode_and_nothing_else(compat_config: AppConfig) -> None:
    token = _grant(compat_config, "compat")
    with TestClient(create_app(compat_config)) as client:
        for method, route in _COMPAT_ROUTES:
            response = client.request(method, route.format(token=token))
            # Past the purpose check: whatever the route answers next, it is not 403.
            assert response.status_code != 403, (method, route, response.status_code)
        assert client.get(f"/v1/files/{token}").status_code == 403
        assert client.get(f"/v1/thumbnails/{token}").status_code == 403


def test_files_serve_downloads_and_playback_only(compat_config: AppConfig) -> None:
    with TestClient(create_app(compat_config)) as client:
        played = client.get(f"/v1/files/{_grant(compat_config, 'play')}")
        assert played.status_code == 200 and "inline" in played.headers["content-disposition"]
        downloaded = client.get(f"/v1/files/{_grant(compat_config, 'download')}")
        assert downloaded.status_code == 200 and "attachment" in downloaded.headers["content-disposition"]
        assert client.get(f"/v1/files/{_grant(compat_config, 'thumb')}").status_code == 403


def test_thumbnails_serve_preview_tokens_only(compat_config: AppConfig) -> None:
    with TestClient(create_app(compat_config)) as client:
        # No thumbnail cache is configured here, so a served preview is "204, none".
        assert client.head(f"/v1/thumbnails/{_grant(compat_config, 'thumb')}").status_code in {200, 204}
        assert client.head(f"/v1/thumbnails/{_grant(compat_config, 'play')}").status_code == 403
        assert client.head(f"/v1/thumbnails/{_grant(compat_config, 'download')}").status_code == 403


def test_an_archive_token_opens_archives_only(compat_config: AppConfig, media_root: Path) -> None:
    archive = seal_grant(
        key=compat_config.security.transfer_key,
        kind="archive",
        items=[GrantItem(root="music", path="movie.mkv", archive_name="movie.mkv")],
        download_name="movie.zip",
    )
    with TestClient(create_app(compat_config)) as client:
        assert client.head(f"/v1/archives/{archive}").status_code == 200
        assert client.get(f"/v1/files/{archive}").status_code == 403
        assert client.get(f"/v1/stereo-info/{archive}").status_code == 403


def test_a_token_that_names_no_purpose_opens_no_route(compat_config: AppConfig) -> None:
    playback = _grant(compat_config, None, legacy_ttl=300)
    compat = _grant(compat_config, None, legacy_ttl=900)
    with TestClient(create_app(compat_config)) as client:
        for token in (playback, compat):
            assert client.get(f"/v1/files/{token}").status_code == 403
            assert client.head(f"/v1/thumbnails/{token}").status_code == 403
            assert client.get(f"/v1/stereo-info/{token}").status_code == 403
