from __future__ import annotations

import json
import os
import time
import wave
from pathlib import Path
from typing import Any

import pytest

from media_server.metadata import read_audio_metadata
from media_server.metadata_worker import (
    MetadataWorkerError,
    _merged_metadata,
    _MetadataReader,
    _payload_item_id,
    _probe_video,
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


def _child_that_hangs_or_dies(connection: Any) -> None:
    """A parser that hangs on ``hang*``, dies on ``crash*`` and answers anything else with its pid."""
    connection.send(("ready", None))
    while True:
        path = connection.recv()
        if path is None:
            return
        name = Path(path).name
        if name.startswith("hang"):
            time.sleep(60)
        if name.startswith("crash"):
            os._exit(3)
        connection.send(("ok", {"name": name, "pid": os.getpid()}))


def _child_that_never_starts(_connection: Any) -> None:
    time.sleep(60)


def test_one_parser_process_reads_the_whole_batch(tmp_path: Path) -> None:
    """A process per file cost ~0.3 s each: 1.5 hours for this library's 12,800 tracks on Windows."""
    with _MetadataReader(10, child_target=_child_that_hangs_or_dies) as reader:
        answers = [reader.read(tmp_path / f"track{index}.mp3") for index in range(6)]

    assert [outcome for outcome, _ in answers] == ["ok"] * 6
    assert [value["name"] for _, value in answers] == [f"track{index}.mp3" for index in range(6)]
    assert len({value["pid"] for _, value in answers}) == 1
    assert reader.processes_started == 1


def test_a_file_that_hangs_or_kills_the_parser_costs_only_itself(tmp_path: Path) -> None:
    """The isolation a process per file gave: the file fails, the batch goes on in a fresh child."""
    names = ["a.mp3", "hang.mp3", "b.mp3", "crash.mp3", "c.mp3"]
    started = time.monotonic()

    with _MetadataReader(1.0, child_target=_child_that_hangs_or_dies) as reader:
        answers = {name: reader.read(tmp_path / name) for name in names}

    outcome, message = answers["hang.mp3"]
    assert outcome == "timeout" and "exceeded 1 seconds" in str(message)
    assert answers["crash.mp3"] == ("error", "Metadata parser exited without a result (exit code 3)")
    survivors = [answers[name] for name in ("a.mp3", "b.mp3", "c.mp3")]
    assert [outcome for outcome, _ in survivors] == ["ok", "ok", "ok"]
    # The hang and the crash each cost the child that met them, nothing more.
    assert len({value["pid"] for _, value in survivors}) == 3
    assert reader.processes_started == 3
    assert time.monotonic() - started < 30


def test_a_parser_is_replaced_after_its_share_of_files(tmp_path: Path) -> None:
    with _MetadataReader(10, child_target=_child_that_hangs_or_dies, files_per_process=2) as reader:
        pids = [reader.read(tmp_path / f"t{index}.mp3")[1]["pid"] for index in range(3)]

    assert pids[0] == pids[1] != pids[2]
    assert reader.processes_started == 2


def test_a_parser_that_never_starts_fails_the_file_not_the_run(tmp_path: Path) -> None:
    started = time.monotonic()
    with _MetadataReader(10, child_target=_child_that_never_starts, start_seconds=1.0) as reader:
        outcome, message = reader.read(tmp_path / "a.mp3")

    assert outcome == "error" and "did not start" in str(message)
    assert time.monotonic() - started < 15


def test_real_files_and_a_damaged_one_share_one_parser(tmp_path: Path) -> None:
    good = tmp_path / "tone.wav"
    with wave.open(str(good), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\x00\x00" * 8000)
    damaged = tmp_path / "invalid.mp3"
    damaged.write_bytes(b"not audio")

    with _MetadataReader(30) as reader:
        first, broken, again = reader.read(good), reader.read(damaged), reader.read(good)

    assert first[0] == "ok" and first[1]["duration_ms"] == 1000
    assert first[1]["technical"]["sample_rate"] == 8000
    assert broken[0] == "error" and "Cannot read audio metadata" in str(broken[1])
    assert again == first
    assert reader.processes_started == 1


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
        # The shapes this library actually turned out to hold.
        ("1940-03-25", 1940),
        ("1957-03", 1957),
        ("1904-01-01 00:00:00", 1904),
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


def _fake_audio(monkeypatch: pytest.MonkeyPatch, tags: dict[str, list[str]]) -> None:
    import mutagen

    class _Info:
        length = 240.0
        bitrate = 320000
        sample_rate = 44100
        channels = 2

    class _File:
        info = _Info()

    handle = _File()
    handle.tags = tags  # type: ignore[attr-defined]
    monkeypatch.setattr(mutagen, "File", lambda path, easy=False: handle)


@pytest.mark.parametrize(
    "tag, stored",
    [
        # Vorbis comments — most of this FLAC library — carry the full date under
        # `date`, and the card next to genre and format has room for a year.
        ("1940-03-25", "1940"),
        ("1957-03", "1957"),
        ("1904-01-01 00:00:00", "1904"),
        ("1959", "1959"),
        # Not a year, so not ours to reinterpret: kept exactly as written.
        ("unknown", "unknown"),
        ("MCMXCVI", "MCMXCVI"),
    ],
)
def test_a_date_tag_is_stored_as_the_year_it_states(
    tag: str, stored: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_audio(monkeypatch, {"date": [tag], "title": ["Utwór"], "genre": ["Rock"]})

    result = read_audio_metadata(tmp_path / "track.flac")

    assert result.technical["year"] == stored
    assert result.technical["genre"] == "Rock"


def test_a_track_with_no_date_tag_stores_no_year(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_audio(monkeypatch, {"title": ["Utwór"]})

    assert "year" not in read_audio_metadata(tmp_path / "track.flac").technical
