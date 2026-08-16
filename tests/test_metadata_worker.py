from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from media_server.metadata_worker import (
    MetadataWorkerError,
    _merged_metadata,
    _payload_item_id,
    _probe_video,
    _read_with_timeout,
    _tag_year,
)
from media_server.probe import parse_probe_output

_FFPROBE_DOCUMENT: dict[str, Any] = {
    "format": {"format_name": "matroska,webm", "duration": "5400.000", "bit_rate": "12000000"},
    "streams": [
        {
            "codec_type": "video",
            "codec_name": "hevc",
            "profile": "Main 10",
            "width": 3840,
            "height": 2160,
            "pix_fmt": "yuv420p10le",
            "avg_frame_rate": "24000/1001",
            "color_transfer": "smpte2084",
            "color_primaries": "bt2020",
        },
        {"codec_type": "audio", "codec_name": "eac3", "channels": 6, "sample_rate": "48000"},
        {"codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "pol"}},
    ],
}


def _fake_probe_reader(_path: Path, _ffprobe: Path, *, timeout_seconds: float) -> Any:
    assert timeout_seconds > 0
    return parse_probe_output(_FFPROBE_DOCUMENT)


def _slow_child(_path: str, _output: Any) -> None:
    time.sleep(10)


def test_metadata_parser_process_is_terminated_after_timeout(tmp_path: Path) -> None:
    target = tmp_path / "slow.mp3"
    target.write_bytes(b"data")
    started = time.monotonic()

    outcome, message = _read_with_timeout(
        target,
        0.1,
        child_target=_slow_child,
    )

    assert outcome == "timeout"
    assert "exceeded" in str(message)
    assert time.monotonic() - started < 5


def test_invalid_audio_returns_isolated_error(tmp_path: Path) -> None:
    target = tmp_path / "invalid.mp3"
    target.write_bytes(b"not audio")

    outcome, message = _read_with_timeout(target, 10)

    assert outcome == "error"
    assert isinstance(message, str)


def test_metadata_merge_preserves_legacy_fields() -> None:
    merged = json.loads(
        _merged_metadata(
            '{"legacy":{"source":"music"}}',
            "audio",
            {"parser": "mutagen", "bitrate": 320000},
        )
    )

    assert merged == {
        "legacy": {"source": "music"},
        "audio": {"parser": "mutagen", "bitrate": 320000},
    }


def test_probe_result_lands_beside_audio_tags_without_erasing_them() -> None:
    """A film's technical facts get their own section, so a re-read of one does not drop the other."""
    merged = json.loads(
        _merged_metadata(
            '{"audio":{"parser":"mutagen","schema":2}}',
            "video",
            {"parser": "ffprobe", "schema": 1, "height": 2160},
        )
    )

    assert merged == {
        "audio": {"parser": "mutagen", "schema": 2},
        "video": {"parser": "ffprobe", "schema": 1, "height": 2160},
    }


def test_video_job_reports_the_columns_the_catalogue_can_query(tmp_path: Path) -> None:
    probe = _probe_video(tmp_path / "film.mkv", Path("ffprobe"), 5.0, reader=_fake_probe_reader)

    assert probe["section"] == "video"
    assert probe["duration_ms"] == 5400000
    assert probe["columns"] == {
        "video_width": 3840,
        "video_height": 2160,
        "video_codec": "hevc",
        "audio_codec": "eac3",
        "frame_rate": 23.976,
        "is_hdr": 1,
    }
    # Tag columns are left to Mutagen; a probe must not blank them.
    assert probe["title"] is None and probe["artist"] is None and probe["album"] is None


def test_video_job_without_ffprobe_fails_with_a_usable_message(tmp_path: Path) -> None:
    with pytest.raises(MetadataWorkerError, match="ffprobe"):
        _probe_video(tmp_path / "film.mkv", None, 5.0)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"media_item_id": 7}, 7),
        ('{"media_item_id":8}', 8),
    ],
)
def test_payload_item_id(payload: object, expected: int) -> None:
    assert _payload_item_id(payload) == expected


@pytest.mark.parametrize("payload", [{}, {"media_item_id": 0}, "not-json"])
def test_payload_item_id_rejects_invalid_values(payload: object) -> None:
    with pytest.raises((KeyError, ValueError, json.JSONDecodeError)):
        _payload_item_id(payload)


@pytest.mark.parametrize(
    "tag, expected",
    [
        # Every shape a tagger actually writes a release date in.
        ("1996", 1996),
        ("2000-05-07", 2000),
        ("2017-06-23T00:00:00Z", 2017),
        ("1969/07/20", 1969),
        # Nothing usable, or nothing that can be a release year.
        ("", None),
        ("199", None),
        ("unknown", None),
        ("0000", None),
        ("9999-01-01", None),
    ],
)
def test_tag_year_reads_only_a_plausible_leading_year(tag: str, expected: int | None) -> None:
    assert _tag_year({"year": tag}) == expected


def test_tag_year_with_no_tag_at_all() -> None:
    assert _tag_year({}) is None
