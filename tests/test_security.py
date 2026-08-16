from __future__ import annotations

import pytest

from media_server.security import GrantItem, TokenError, open_grant, seal_grant


def _open(token: str, key: bytes, now: int = 100) -> object:
    return open_grant(
        token,
        key=key,
        max_ttl_seconds=900,
        clock_skew_seconds=0,
        max_token_bytes=65536,
        max_archive_entries=100,
        now=now,
    )


def test_round_trip_hides_plain_path(transfer_key: bytes) -> None:
    token = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="Artist/Album/secret.flac")],
        download_name="sekret.flac",
        disposition="inline",
        subject="7",
        ttl_seconds=300,
        now=100,
    )

    assert "Artist" not in token
    grant = _open(token, transfer_key)
    assert grant.kind == "file"
    assert grant.items[0].path == "Artist/Album/secret.flac"
    assert grant.disposition == "inline"
    assert grant.subject == "7"


def test_stream_limit_claim_round_trips_and_defaults_to_zero(transfer_key: bytes) -> None:
    limited = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="movies", path="film.mkv")],
        download_name="film.mkv",
        disposition="inline",
        subject="7",
        max_streams=3,
        now=100,
    )
    assert _open(limited, transfer_key).max_streams == 3

    unlimited = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="movies", path="film.mkv")],
        download_name="film.mkv",
        now=100,
    )
    assert _open(unlimited, transfer_key).max_streams == 0

    with pytest.raises(ValueError):
        seal_grant(
            key=transfer_key,
            kind="file",
            items=[GrantItem(root="movies", path="film.mkv")],
            download_name="film.mkv",
            max_streams=10001,
            now=100,
        )


def test_download_cap_claim_applies_to_attachments_only(transfer_key: bytes) -> None:
    capped = seal_grant(
        key=transfer_key,
        kind="archive",
        items=[GrantItem(root="music", path="a.flac"), GrantItem(root="music", path="b.flac")],
        download_name="album.zip",
        subject="7",
        max_downloads=4,
        now=100,
    )
    assert _open(capped, transfer_key).max_downloads == 4

    inline = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="a.flac")],
        download_name="a.flac",
        disposition="inline",
        subject="7",
        max_downloads=4,
        now=100,
    )
    # Playback never counts against the download cap, so the claim is not sealed.
    assert _open(inline, transfer_key).max_downloads == 0

    with pytest.raises(ValueError):
        seal_grant(
            key=transfer_key,
            kind="file",
            items=[GrantItem(root="music", path="a.flac")],
            download_name="a.flac",
            max_downloads=10001,
            now=100,
        )


def test_tampered_token_is_rejected(transfer_key: bytes) -> None:
    token = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="song.mp3")],
        download_name="song.mp3",
        now=100,
    )
    replacement = "A" if token[-1] != "A" else "B"
    with pytest.raises(TokenError):
        _open(token[:-1] + replacement, transfer_key)


def test_expired_and_excessive_ttl_are_rejected(transfer_key: bytes) -> None:
    expired = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="song.mp3")],
        download_name="song.mp3",
        ttl_seconds=10,
        now=100,
    )
    with pytest.raises(TokenError):
        _open(expired, transfer_key, now=111)

    long_lived = seal_grant(
        key=transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="song.mp3")],
        download_name="song.mp3",
        ttl_seconds=901,
        now=100,
    )
    with pytest.raises(TokenError):
        _open(long_lived, transfer_key)


def test_file_grant_requires_exactly_one_item(transfer_key: bytes) -> None:
    with pytest.raises(ValueError):
        seal_grant(
            key=transfer_key,
            kind="file",
            items=[GrantItem(root="music", path="one"), GrantItem(root="music", path="two")],
            download_name="bad",
            now=100,
        )
