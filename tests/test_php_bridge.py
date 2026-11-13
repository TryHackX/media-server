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
        "echo TryHackX\\Media\\Integration\\TransferToken::file($k,'movies','film.mkv','film.mkv',true,900,'7',3,4,'compat'), PHP_EOL;"
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

    # A compatibility grant carries the stream cap but never the download cap.
    assert opened(inline_video).max_streams == 3
    assert opened(inline_video).max_downloads == 0
    assert opened(attachment).max_downloads == 4
    assert opened(attachment).max_streams == 0
    assert opened(archive).kind == "archive"
    assert opened(archive).max_downloads == 2


def test_php_bridge_seals_the_purpose_python_enforces(transfer_key: bytes) -> None:
    """The bridge names what each grant is for, and refuses a purpose that does not fit."""
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    bridge = Path(__file__).resolve().parents[1] / "integrations" / "php" / "TransferToken.php"
    encoded_key = base64.urlsafe_b64encode(transfer_key).rstrip(b"=").decode("ascii")
    code = (
        "require getenv('MEDIA_BRIDGE');"
        "use TryHackX\\Media\\Integration\\TransferToken as T;"
        "$k=getenv('MEDIA_KEY');"
        "echo T::file($k,'music','a.flac','a.flac',true), PHP_EOL;"
        "echo T::file($k,'music','a.flac','a.flac',false), PHP_EOL;"
        "echo T::file($k,'music','a.flac','a.flac',true,300,'7',0,0,'thumb'), PHP_EOL;"
        "echo T::file($k,'movies','f.mkv','f.mkv',true,900,'7',2,0,'compat'), PHP_EOL;"
        "echo T::archive($k,[['root'=>'music','path'=>'a.flac']],'x.zip'), PHP_EOL;"
        # Each of these must be refused before a token exists.
        "foreach ([[true,0,'download'],[false,0,'play'],[false,0,'compat'],[true,2,'play'],[true,0,'nope']] as [$i,$s,$p]) {"
        "  try { T::file($k,'music','a.flac','a.flac',$i,300,'7',$s,0,$p); echo 'issued', PHP_EOL; }"
        "  catch (InvalidArgumentException $e) { echo 'refused', PHP_EOL; } }"
    )
    environment = os.environ.copy()
    environment["MEDIA_BRIDGE"] = str(bridge)
    environment["MEDIA_KEY"] = encoded_key
    result = subprocess.run([php, "-r", code], capture_output=True, text=True, env=environment, check=True)
    lines = result.stdout.split()
    play, download, thumb, compat, archive = lines[:5]

    def uses(token: str) -> frozenset[str]:
        return open_grant(
            token,
            key=transfer_key,
            max_ttl_seconds=900,
            clock_skew_seconds=5,
            max_token_bytes=65536,
            max_archive_entries=100,
            now=int(time.time()),
        ).uses

    assert uses(play) == {"play"}
    assert uses(download) == {"download"}
    assert uses(thumb) == {"thumb"}
    assert uses(compat) == {"compat"}
    assert uses(archive) == {"download"}
    assert lines[5:] == ["refused"] * 5
