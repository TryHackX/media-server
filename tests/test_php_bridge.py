from __future__ import annotations

import base64
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from media_server.security import open_grant


def test_php_bridge_token_is_compatible(transfer_key: bytes) -> None:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    bridge = Path(__file__).resolve().parents[1] / "integrations" / "php" / "TransferToken.php"
    encoded_key = base64.urlsafe_b64encode(transfer_key).rstrip(b"=").decode("ascii")
    code = (
        "require getenv('MEDIA_BRIDGE');"
        "echo TryHackX\\Media\\Integration\\TransferToken::file("
        "getenv('MEDIA_KEY'),'music','Artist/Album/song.flac','song.flac',true,300,'7');"
    )
    environment = os.environ.copy()
    environment["MEDIA_BRIDGE"] = str(bridge)
    environment["MEDIA_KEY"] = encoded_key
    result = subprocess.run([php, "-r", code], capture_output=True, text=True, env=environment, check=True)

    grant = open_grant(
        result.stdout,
        key=transfer_key,
        max_ttl_seconds=900,
        clock_skew_seconds=5,
        max_token_bytes=65536,
        max_archive_entries=100,
        now=int(time.time()),
    )
    assert grant.items[0].path == "Artist/Album/song.flac"
    assert grant.disposition == "inline"
    assert grant.subject == "7"


def test_php_bridge_seals_stream_and_download_caps(transfer_key: bytes) -> None:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    bridge = Path(__file__).resolve().parents[1] / "integrations" / "php" / "TransferToken.php"
    encoded_key = base64.urlsafe_b64encode(transfer_key).rstrip(b"=").decode("ascii")
    code = (
        "require getenv('MEDIA_BRIDGE');"
        "$k=getenv('MEDIA_KEY');"
        "echo TryHackX\\Media\\Integration\\TransferToken::file($k,'movies','film.mkv','film.mkv',true,300,'7',3,4), PHP_EOL;"
        "echo TryHackX\\Media\\Integration\\TransferToken::file($k,'music','a.flac','a.flac',false,300,'7',0,4), PHP_EOL;"
        "echo TryHackX\\Media\\Integration\\TransferToken::archive($k,[['root'=>'music','path'=>'a.flac']],'x.zip',300,'7',2);"
    )
    environment = os.environ.copy()
    environment["MEDIA_BRIDGE"] = str(bridge)
    environment["MEDIA_KEY"] = encoded_key
    result = subprocess.run([php, "-r", code], capture_output=True, text=True, env=environment, check=True)
    inline_video, attachment, archive = result.stdout.split()

    def opened(token: str):
        return open_grant(
            token,
            key=transfer_key,
            max_ttl_seconds=900,
            clock_skew_seconds=5,
            max_token_bytes=65536,
            max_archive_entries=100,
            now=int(time.time()),
        )

    # Inline playback carries the stream cap but never the download cap.
    assert opened(inline_video).max_streams == 3
    assert opened(inline_video).max_downloads == 0
    assert opened(attachment).max_downloads == 4
    assert opened(attachment).max_streams == 0
    assert opened(archive).kind == "archive"
    assert opened(archive).max_downloads == 2
