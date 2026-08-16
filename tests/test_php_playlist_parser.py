"""Uploaded playlists and ratings files (integrations/php/PlaylistParser.php).

An uploaded file is the one input to this server that a stranger could have
written, so these cases are as much about what the parser refuses as about what
it reads: an oversized upload, a million entries, and an XML file carrying an
external entity are all things a playlist can be.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

PHP_DIR = Path(__file__).resolve().parents[1] / "integrations" / "php"


def _php() -> str:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    return php


def _parse(body: str) -> dict:
    """
    Run the parser over one document and return its result, or the refusal.

    The document goes through a file rather than an environment variable: one of
    these cases is deliberately two megabytes, and Windows caps the whole
    environment block well below that.
    """
    environment = os.environ.copy()
    environment["MEDIA_PHP_DIR"] = str(PHP_DIR)
    with tempfile.TemporaryDirectory() as directory:
        document = Path(directory) / "upload.bin"
        # Bytes, not text: writing text on Windows turns a CRLF in a test
        # document into CR CRLF, which is not what is being tested.
        document.write_bytes(body.encode("utf-8"))
        environment["MEDIA_PARSER_FILE"] = str(document)
        code = (
            "require getenv('MEDIA_PHP_DIR') . '/BridgeException.php';"
            "require getenv('MEDIA_PHP_DIR') . '/PlaylistParser.php';"
            "$body = file_get_contents(getenv('MEDIA_PARSER_FILE'));"
            "try {"
            "  $r = TryHackX\Media\Integration\PlaylistParser::parse($body);"
            "  echo json_encode(['ok' => true] + $r, JSON_UNESCAPED_UNICODE);"
            "} catch (Throwable $e) {"
            "  echo json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);"
            "}"
        )
        result = subprocess.run(
            [_php(), "-r", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=environment,
            check=True,
        )
    return json.loads(result.stdout)


def test_our_own_m3u_round_trips() -> None:
    parsed = _parse(
        "#EXTM3U\n"
        "#EXTINF:245,Artist - Title\n"
        "#TRYHACKX-FINGERPRINT:0123456789abcdef0123456789abcdef\n"
        "tryhackx:item:42\n"
    )
    assert parsed["ok"] and parsed["kind"] == "playlist"
    entry = parsed["entries"][0]
    assert entry["item_id"] == 42
    assert entry["fingerprint"] == "0123456789abcdef0123456789abcdef"
    assert entry["label"] == "Artist - Title"


def test_a_foreign_playlist_keeps_the_name_and_drops_the_path() -> None:
    # Somebody else's path points into somebody else's library; only the name
    # travels, and storing the rest would be keeping a stranger's directory tree.
    parsed = _parse("#EXTM3U\nC:\\Music\\Album\\01 - Intro.mp3\n../rel/02 - Outro.flac\n")
    assert [entry["file_name"] for entry in parsed["entries"]] == ["01 - Intro.mp3", "02 - Outro.flac"]
    assert all(entry["item_id"] is None for entry in parsed["entries"])


def test_xspf_reads_identifier_and_fingerprint() -> None:
    parsed = _parse(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<playlist version="1" xmlns="http://xspf.org/ns/0/"><trackList>'
        "<track><identifier>tryhackx:item:7</identifier><title>Song</title><creator>Band</creator>"
        '<meta rel="urn:tryhackx:fingerprint">abcdefabcdefabcdefabcdefabcdefab</meta></track>'
        "</trackList></playlist>"
    )
    entry = parsed["entries"][0]
    assert entry["item_id"] == 7
    assert entry["fingerprint"] == "abcdefabcdefabcdefabcdefabcdefab"
    assert entry["label"] == "Band - Song"


def test_an_external_entity_reads_nothing_off_disk() -> None:
    """
    The reason XSPF is parsed as XML with entity substitution left off.

    An uploaded document the server parses is the classic place to smuggle an
    entity that opens a local file; refusing the document is as good an answer
    as ignoring the entity, so both are accepted here — leaking is not.
    """
    parsed = _parse(
        '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]>'
        '<playlist xmlns="http://xspf.org/ns/0/"><trackList><track><title>&x;</title></track>'
        "</trackList></playlist>"
    )
    labels = " ".join(str(entry["label"]) for entry in parsed.get("entries", []))
    assert "[fonts]" not in labels
    assert "16-bit app" not in labels


def test_csv_survives_the_bom_and_reads_columns_by_name() -> None:
    parsed = _parse(
        "\ufeffmedia_item_id,fingerprint,media_kind,title,artist,rating,favorite\r\n"
        '42,0123456789abcdef0123456789abcdef,audio,"Song, with comma","Band",4.5,1\r\n'
    )
    assert parsed["kind"] == "ratings"
    entry = parsed["entries"][0]
    # The BOM our own export writes for Excel must not become part of the first
    # column's name, or the id is never found.
    assert entry["item_id"] == 42
    assert "Song, with comma" in entry["label"]
    assert entry["rating"] == 4.5
    assert entry["favorite"] is True


def test_columns_in_a_foreign_order_are_still_read_correctly() -> None:
    # Reading the fourth field because ours happens to be the artist there is
    # how an import writes a rating of "Depeche Mode".
    parsed = _parse("favorite,rating,title,media_item_id\r\n1,3.5,Whatever,99\r\n")
    entry = parsed["entries"][0]
    assert entry["item_id"] == 99
    assert entry["rating"] == 3.5


def test_a_row_stating_neither_rating_nor_favourite_is_dropped() -> None:
    parsed = _parse("media_item_id,title,rating,favorite\r\n43,Other,,0\r\n")
    assert parsed["entries"] == []


def test_only_our_own_ratings_json_is_accepted() -> None:
    ours = json.dumps(
        {
            "format": "tryhackx-media-ratings",
            "version": 1,
            "entries": [{"media_item_id": 5, "title": "T", "rating": 5.0, "favorite": True}],
        }
    )
    assert _parse(ours)["entries"][0]["item_id"] == 5
    assert _parse('{"format":"something-else","entries":[]}')["ok"] is False


def test_an_empty_upload_is_refused() -> None:
    assert _parse("")["ok"] is False


def test_an_oversized_upload_is_refused_before_it_is_parsed() -> None:
    assert _parse("x" * (2 * 1024 * 1024 + 1))["ok"] is False


def test_too_many_entries_are_capped_and_said_so() -> None:
    # Silently keeping the first five thousand would look like a complete import.
    parsed = _parse("#EXTM3U\n" + "tryhackx:item:1\n" * 5050)
    assert len(parsed["entries"]) == 5000
    assert parsed["truncated"] is True
