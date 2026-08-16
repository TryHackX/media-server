from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from media_server import probe
from media_server.probe import ProbeError, ffprobe_for, parse_probe_output, read_media_probe


def _document(**overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "format": {"format_name": "matroska,webm", "duration": "1800.5", "bit_rate": "8000000"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "profile": "High",
                "width": 1920,
                "height": 1080,
                "pix_fmt": "yuv420p",
                "avg_frame_rate": "24000/1001",
            },
            {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000"},
        ],
    }
    document.update(overrides)
    return document


def test_probe_reads_the_fields_the_catalogue_stores() -> None:
    probe = parse_probe_output(_document())

    assert probe.duration_ms == 1800500
    assert (probe.width, probe.height) == (1920, 1080)
    assert probe.video_codec == "h264"
    assert probe.audio_codec == "aac"
    assert probe.frame_rate == 23.976
    assert probe.hdr is False
    assert probe.technical["container"] == "matroska,webm"
    assert probe.technical["schema"] >= 1


def test_frame_rate_of_an_unknown_stream_is_left_empty() -> None:
    document = _document()
    document["streams"][0]["avg_frame_rate"] = "0/0"
    document["streams"][0]["r_frame_rate"] = "0/0"

    assert parse_probe_output(document).frame_rate is None


@pytest.mark.parametrize(
    ("transfer", "primaries", "pixel_format", "expected"),
    [
        ("smpte2084", "bt2020", "yuv420p10le", True),
        ("arib-std-b67", "bt2020", "yuv420p10le", True),
        # bt2020 at 8 bit is a wide gamut, not HDR.
        ("bt709", "bt2020", "yuv420p", False),
        ("bt709", "bt709", "yuv420p", False),
        # A 10-bit bt2020 file without an HDR curve still counts.
        ("bt709", "bt2020", "yuv420p10le", True),
    ],
)
def test_hdr_detection(transfer: str, primaries: str, pixel_format: str, expected: bool) -> None:
    document = _document()
    document["streams"][0].update(
        color_transfer=transfer, color_primaries=primaries, pix_fmt=pixel_format
    )

    assert parse_probe_output(document).hdr is expected


def test_embedded_cover_is_not_mistaken_for_the_film() -> None:
    """An attached picture is a video stream; the real picture is the one after it."""
    document = _document()
    document["streams"].insert(0, {"codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600})

    probe = parse_probe_output(document)

    assert (probe.width, probe.height) == (1920, 1080)
    assert probe.video_codec == "h264"


def test_audio_only_file_reports_no_picture() -> None:
    document = {
        "format": {"format_name": "flac", "duration": "312.0"},
        "streams": [{"codec_type": "audio", "codec_name": "flac", "channels": 2, "sample_rate": "44100"}],
    }

    probe = parse_probe_output(document)

    assert (probe.width, probe.height, probe.video_codec) == (None, None, None)
    assert probe.audio_codec == "flac"
    assert probe.duration_ms == 312000


def test_subtitle_languages_are_collected_without_duplicates() -> None:
    document = _document()
    document["streams"].extend(
        [
            {"codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "pol"}},
            {"codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "pol"}},
            {"codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle", "tags": {"language": "eng"}},
        ]
    )

    technical = parse_probe_output(document).technical

    assert technical["subtitle_languages"] == ["pol", "eng"]
    assert technical["subtitle_streams"] == 3


def test_duration_falls_back_to_the_stream_when_the_container_has_none() -> None:
    document = _document(format={"format_name": "avi"})
    document["streams"][0]["duration"] = "42.5"

    assert parse_probe_output(document).duration_ms == 42500


def test_empty_document_yields_nothing_rather_than_failing() -> None:
    probe = parse_probe_output({})

    assert probe.duration_ms is None
    assert probe.video_codec is None
    assert probe.audio_codec is None


def test_missing_ffprobe_is_reported_clearly(tmp_path: Path) -> None:
    with pytest.raises(ProbeError, match="not available"):
        read_media_probe(tmp_path / "film.mkv", tmp_path / "no-such-ffprobe.exe")


def test_ffprobe_is_located_next_to_the_configured_ffmpeg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(probe.shutil, "which", lambda name: None)
    (tmp_path / "ffmpeg.exe").write_bytes(b"")
    assert ffprobe_for(tmp_path / "ffmpeg.exe") is None

    (tmp_path / "ffprobe.exe").write_bytes(b"")
    assert ffprobe_for(tmp_path / "ffmpeg.exe") == tmp_path / "ffprobe.exe"
    assert ffprobe_for(None) is None


def test_a_bare_command_name_is_looked_up_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """The installer's default is `ffmpeg` and Debian's system package wants the
    same. Asking the filesystem for it resolved `ffprobe` against the current
    directory, found nothing, and silently disabled every video probe on the
    most common configuration there is."""
    asked: list[str] = []
    monkeypatch.setattr(probe.shutil, "which", lambda name: asked.append(name) or "/usr/bin/ffprobe")

    assert ffprobe_for("ffmpeg") == Path("/usr/bin/ffprobe")
    assert asked == ["ffprobe"]


def test_a_missing_sibling_still_falls_back_to_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(probe.shutil, "which", lambda name: "/usr/bin/ffprobe")

    assert ffprobe_for(tmp_path / "ffmpeg") == Path("/usr/bin/ffprobe")


def test_the_windows_suffix_is_carried_into_the_path_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []
    monkeypatch.setattr(probe.shutil, "which", lambda name: asked.append(name) or None)

    assert ffprobe_for("ffmpeg.exe") is None
    assert asked[0] == "ffprobe.exe"


def test_every_audio_and_subtitle_track_is_described_not_only_the_first() -> None:
    """A film with a dub, an original and a commentary has three answers, not one."""
    document = _document(
        streams=[
            {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "bit_rate": "6200000"},
            {
                "codec_type": "audio",
                "codec_name": "ac3",
                "channels": 6,
                "channel_layout": "5.1",
                "sample_rate": "48000",
                "bit_rate": "640000",
                "tags": {"language": "pol", "title": "Lektor"},
                "disposition": {"default": 1},
            },
            {
                "codec_type": "audio",
                "codec_name": "dts",
                "channels": 8,
                "sample_rate": "48000",
                "tags": {"language": "eng", "BPS": "1509000"},
            },
            {
                "codec_type": "subtitle",
                "codec_name": "subrip",
                "tags": {"language": "pol"},
                "disposition": {"forced": 1},
            },
            {"codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle", "tags": {"language": "eng"}},
        ]
    )

    technical = parse_probe_output(document).technical

    assert technical["audio_streams"] == 2
    assert technical["audio_tracks"] == [
        {
            "index": 0,
            "codec": "ac3",
            "channels": 6,
            "channel_layout": "5.1",
            "sample_rate": 48000,
            "bitrate": 640000,
            "language": "pol",
            "title": "Lektor",
            "default": True,
        },
        {"index": 1, "codec": "dts", "channels": 8, "sample_rate": 48000, "bitrate": 1509000, "language": "eng"},
    ]
    assert technical["subtitle_tracks"] == [
        {"index": 0, "codec": "subrip", "language": "pol", "forced": True},
        {"index": 1, "codec": "hdmv_pgs_subtitle", "language": "eng"},
    ]
    # The picture's own rate, separate from the file total the container reports.
    assert technical["video_bitrate"] == 6200000
    assert technical["bitrate"] == 8000000


def test_matroska_keeps_its_bitrate_in_a_tag_rather_than_on_the_stream() -> None:
    """Almost no MKV fills in bit_rate; without the BPS tags every rip reads as unknown."""
    document = _document(
        streams=[
            {
                "codec_type": "video",
                "codec_name": "hevc",
                "width": 3840,
                "height": 2160,
                "tags": {"BPS-eng": "21400000"},
            },
            {"codec_type": "audio", "codec_name": "truehd", "channels": 8},
        ]
    )

    technical = parse_probe_output(document).technical

    assert technical["video_bitrate"] == 21400000


def test_a_single_track_file_still_describes_that_track() -> None:
    technical = parse_probe_output(_document()).technical

    assert "audio_streams" not in technical
    assert technical["audio_tracks"] == [{"index": 0, "codec": "aac", "channels": 2, "sample_rate": 48000}]
    assert "subtitle_tracks" not in technical
