from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import media_server.app as app_module
from media_server.app import create_app
from media_server.config import AppConfig, StereoConfig
from media_server.paths import ResolvedItem
from media_server.security import GrantItem, seal_grant
from media_server.stereo import (
    CompatibleProcessRegistry,
    _external_subtitle_track,
    compatible_stream_command,
    external_subtitle_files,
    external_subtitle_path,
    sanitize_webvtt,
    shift_webvtt,
    subtitle_charset,
    subtitle_webvtt_command,
)


class _FakeLease:
    def __init__(self) -> None:
        self.releases = 0

    async def release(self) -> None:
        self.releases += 1


def _token(config: AppConfig, path: str) -> str:
    return seal_grant(
        key=config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path=path)],
        download_name=Path(path).name,
        disposition="inline",
        ttl_seconds=300,
        purpose="compat",
    )


def _resolved(path: Path) -> ResolvedItem:
    stat = path.stat()
    return ResolvedItem(path.resolve(), path.name, stat.st_size, stat.st_mtime_ns)


def test_new_compatible_generation_reclaims_abandoned_response_lease() -> None:
    async def scenario() -> None:
        registry = CompatibleProcessRegistry()
        lease = _FakeLease()
        first = await registry.begin("browser-viewer-1")
        assert await registry.bind_lease("browser-viewer-1", first, lease)
        second = await registry.begin("browser-viewer-1")
        assert second == first + 1
        assert lease.releases == 1
        assert not await registry.bind_lease("browser-viewer-1", first, _FakeLease())

    asyncio.run(scenario())


def test_compatible_command_copies_video_and_downmixes_audio(tmp_path: Path) -> None:
    source_path = tmp_path / "movie.mkv"
    source_path.write_bytes(b"movie")
    command = compatible_stream_command(
        _resolved(source_path),
        StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192),
    )

    assert command[command.index("-c:v") + 1] == "copy"
    assert command[command.index("-c:a") + 1] == "aac"
    assert command[command.index("-ac") + 1] == "2"
    assert command[command.index("-f") + 1] == "mp4"
    # No first_pts: pinning the transcoded audio to zero hides the gap that opens
    # when the demuxer lands before the request, and the sound then runs ahead of
    # the picture by a whole seek interval.
    assert command[command.index("-af") + 1] == "aresample=48000:async=1000"
    assert command[command.index("-fps_mode:v") + 1] == "passthrough"
    assert command[command.index("-avoid_negative_ts") + 1] == "make_zero"
    assert command[-1] == "pipe:1"
    assert "empty_moov" in command[command.index("-movflags") + 1]
    surround = compatible_stream_command(
        _resolved(source_path), StereoConfig(ffmpeg_path="ffmpeg"), audio_profile="surround_aac"
    )
    assert "-ac" not in surround
    assert surround[surround.index("-b:a") + 1] == "512k"

    seek_command = compatible_stream_command(
        _resolved(source_path),
        StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192),
        321.25,
    )
    # Seeking must stay on the input side. Trimming a copied picture at the output
    # keeps only the preceding keyframe and drops every inter frame up to the cut,
    # which freezes the browser on one still image for a whole group of pictures.
    seek_positions = [index for index, argument in enumerate(seek_command) if argument == "-ss"]
    assert len(seek_positions) == 1
    assert seek_command[seek_positions[0] + 1] == "321.250"
    assert seek_positions[0] < seek_command.index("-i")
    # Sound and picture must begin at the same instant. Accurate seeking would trim
    # the decoded audio to the exact request while the copied picture still starts
    # at whichever index point the demuxer reached.
    assert "-noaccurate_seek" in seek_command
    assert seek_command.index("-noaccurate_seek") < seek_command.index("-i")
    assert "-noaccurate_seek" not in command  # nothing to align when starting at zero
    transcoded_seek = compatible_stream_command(
        _resolved(source_path),
        StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192),
        321.25,
        video_codec="mpeg4",
    )
    transcode_positions = [index for index, argument in enumerate(transcoded_seek) if argument == "-ss"]
    assert len(transcode_positions) == 1
    assert transcoded_seek[transcode_positions[0] + 1] == "321.250"
    assert transcode_positions[0] < transcoded_seek.index("-i")


def test_compatible_command_transcodes_legacy_video_and_builds_webvtt(tmp_path: Path) -> None:
    source_path = tmp_path / "legacy.mts"
    source_path.write_bytes(b"avi-xvid")
    resolved = _resolved(source_path)
    config = StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192)

    command = compatible_stream_command(resolved, config, video_codec="mpeg4")
    assert command[command.index("-c:v") + 1] == "libx264"
    assert command[command.index("-pix_fmt") + 1] == "yuv420p"
    native_hevc = compatible_stream_command(
        resolved,
        StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192, video_encoder="h264_nvenc"),
        video_codec="hevc",
        video_profile="native_copy",
    )
    assert native_hevc[native_hevc.index("-c:v") + 1] == "copy"
    assert native_hevc[native_hevc.index("-tag:v") + 1] == "hvc1"
    assert "-hwaccel" not in native_hevc
    native_av1 = compatible_stream_command(resolved, config, video_codec="av1", video_profile="native_copy")
    assert native_av1[native_av1.index("-c:v") + 1] == "copy"
    assert native_av1[native_av1.index("-tag:v") + 1] == "av01"
    native_vp9 = compatible_stream_command(resolved, config, video_codec="vp9", video_profile="native_copy")
    assert native_vp9[native_vp9.index("-c:v") + 1] == "copy"
    assert native_vp9[native_vp9.index("-tag:v") + 1] == "vp09"
    vp9_fallback = compatible_stream_command(resolved, config, video_codec="vp9", video_profile="h264_fallback")
    assert vp9_fallback[vp9_fallback.index("-c:v") + 1] == "libx264"
    hardware_fallback = compatible_stream_command(
        resolved,
        StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192, video_encoder="h264_nvenc"),
        video_codec="hevc",
        video_profile="h264_fallback",
    )
    assert hardware_fallback[hardware_fallback.index("-c:v") + 1] == "h264_nvenc"
    assert hardware_fallback[hardware_fallback.index("-preset") + 1] == "p1"
    assert hardware_fallback[hardware_fallback.index("-hwaccel") + 1] == "cuda"
    assert hardware_fallback[hardware_fallback.index("-vf") + 1] == "scale_cuda=format=nv12"
    assert "-pix_fmt" not in hardware_fallback
    subtitle = subtitle_webvtt_command(resolved, config, subtitle_track=1, start_seconds=12.5)
    assert subtitle[subtitle.index("-map") + 1] == "0:s:1"
    assert subtitle[subtitle.index("-f") + 1] == "webvtt"


def test_webvtt_sanitizer_removes_only_trailing_embedded_counters() -> None:
    source = (
        b"WEBVTT\n\n"
        b"00:00.000 --> 00:01.000\nPierwsza linia\n48\n\n"
        b"00:01.000 --> 00:02.000\n295\n\n"
        b"cue-id\n00:02.000 --> 00:03.000\nDruga linia\n348\n"
    )
    result = sanitize_webvtt(source)
    assert b"Pierwsza linia\n48" not in result
    assert b"Druga linia\n348" not in result
    assert b"00:01.000 --> 00:02.000\n295" in result
    assert result.startswith(b"WEBVTT")


def test_webvtt_cache_payload_is_shifted_without_running_ffmpeg_again() -> None:
    source = (
        b"WEBVTT\n\n"
        b"00:00:08.000 --> 00:00:11.000\nToo early\n\n"
        b"cue-two\n00:00:12.500 --> 00:00:15.000 position:50%\nVisible\n"
    )
    result = shift_webvtt(source, 10.0)
    assert b"Too early" in result
    assert b"00:00:00.000 --> 00:00:01.000" in result
    assert b"00:00:02.500 --> 00:00:05.000 position:50%" in result


def test_stereo_endpoint_streams_one_compatible_media_response(
    app_config: AppConfig,
    media_root: Path,
    monkeypatch,
) -> None:
    movie = media_root / "movie.mkv"
    movie.write_bytes(b"video-source")
    config = replace(app_config, stereo=StereoConfig(ffmpeg_path="ffmpeg"))
    token = _token(config, "movie.mkv")
    calls = 0
    starts: list[float] = []

    async def fake_chunks(
        _source: ResolvedItem,
        _selected: StereoConfig,
        _chunk_size: int,
        start_seconds: float = 0.0,
        audio_track: int = 0,
        subtitle_track: int = -1,
        video_codec: str | None = None,
        audio_profile: str = "stereo_standard",
        video_profile: str = "native_copy",
        stream_id: str = "",
        stream_generation: int = 0,
        process_registry=None,
    ):
        nonlocal calls
        calls += 1
        starts.append(start_seconds)
        yield b"fragment-one"
        yield b"fragment-two"

    async def fake_info(_source: ResolvedItem, _selected: StereoConfig) -> dict[str, object]:
        return {
            "duration_seconds": 5432.25,
            "video_codec": "h264",
            "video_transcoded": False,
            "audio_tracks": [{"index": 0, "codec": "ac3", "channel_layout": "5.1"}],
            "subtitle_tracks": [{"index": 0, "codec": "subrip", "supported": True}],
        }

    async def fake_subtitles(*_args, **_kwargs) -> bytes:
        return b"WEBVTT\n\n00:00.000 --> 00:01.000\nTest\n"

    monkeypatch.setattr(app_module, "compatible_media_chunks", fake_chunks)
    monkeypatch.setattr(app_module, "probe_media_info", fake_info)
    monkeypatch.setattr(app_module, "extract_subtitle_webvtt", fake_subtitles)
    with TestClient(create_app(config)) as client:
        info = client.get(f"/v1/stereo-info/{token}")
        head = client.head(f"/v1/stereo/{token}")
        response = client.get(f"/v1/stereo/{token}?start_seconds=120.5&audio_track=0")
        cancelled = client.delete(f"/v1/stereo/{token}?stream_id=test-viewer-123")
        subtitles = client.get(f"/v1/subtitles/{token}?subtitle_track=0&start_seconds=120.5")

    assert info.status_code == 200
    assert info.json()["audio_tracks"][0]["channel_layout"] == "5.1"
    assert head.status_code == 200
    assert head.headers["x-media-duration-seconds"] == "5432.250"
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("video/mp4")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-compatible-start-seconds"] == "120.500"
    assert response.headers["x-compatible-audio-track"] == "0"
    assert response.headers["x-compatible-audio-profile"] == "stereo_standard"
    assert response.headers["x-compatible-video-profile"] == "native_copy"
    assert response.content == b"fragment-onefragment-two"
    assert cancelled.status_code == 204
    assert subtitles.status_code == 200
    assert subtitles.headers["content-type"].startswith("text/vtt")
    assert subtitles.content.startswith(b"WEBVTT")
    assert calls == 1
    assert starts == [120.5]


def test_stereo_endpoint_reports_startup_failure_before_sending_200(
    app_config: AppConfig,
    media_root: Path,
    monkeypatch,
) -> None:
    movie = media_root / "broken.mkv"
    movie.write_bytes(b"video-source")
    config = replace(app_config, stereo=StereoConfig(ffmpeg_path="ffmpeg"))
    token = _token(config, "broken.mkv")

    async def broken_chunks(*_args, **_kwargs):
        if False:
            yield b""
        raise app_module.StereoTranscodeError("invalid ffmpeg command")

    async def fake_info(*_args, **_kwargs) -> dict[str, object]:
        return {
            "duration_seconds": 60.0,
            "video_codec": "h264",
            "video_transcoded": False,
            "audio_tracks": [],
            "subtitle_tracks": [],
        }

    monkeypatch.setattr(app_module, "compatible_media_chunks", broken_chunks)
    monkeypatch.setattr(app_module, "probe_media_info", fake_info)
    with TestClient(create_app(config), raise_server_exceptions=False) as client:
        response = client.get(f"/v1/stereo/{token}")

    assert response.status_code == 503

def test_stereo_endpoint_is_disabled_without_ffmpeg(
    app_config: AppConfig,
    media_root: Path,
) -> None:
    (media_root / "movie.mkv").write_bytes(b"movie")
    token = _token(app_config, "movie.mkv")

    with TestClient(create_app(app_config)) as client:
        response = client.head(f"/v1/stereo/{token}")

    assert response.status_code == 503


def test_sidecar_subtitles_belong_to_the_film_they_are_named_after(tmp_path: Path) -> None:
    """Only files named after this film, in its own folder, and in a stable order."""
    film = tmp_path / "Film (2019).mkv"
    film.write_bytes(b"film")
    for name in (
        "Film (2019).srt",
        "Film (2019).pl.srt",
        "Film (2019).en.forced.ass",
        "Film (2019) - polish.vtt",
    ):
        (tmp_path / name).write_text("1\n", encoding="utf-8")
    # Everything below belongs to something else, or is not a subtitle at all.
    (tmp_path / "Inny film (2020).pl.srt").write_text("1\n", encoding="utf-8")
    (tmp_path / "Film (2019).nfo").write_text("1\n", encoding="utf-8")
    (tmp_path / "Film (2019).sub").write_text("1\n", encoding="utf-8")
    (tmp_path / "Film (2019) Extras.mkv").write_bytes(b"film")

    found = [path.name for path in external_subtitle_files(_resolved(film))]
    assert found == [
        "Film (2019) - polish.vtt",
        "Film (2019).en.forced.ass",
        "Film (2019).pl.srt",
        "Film (2019).srt",
    ]

    # A sidecar's name is read for a language, and never sent on as a path.
    tracks = [_external_subtitle_track(_resolved(film), path, index)
              for index, path in enumerate(external_subtitle_files(_resolved(film)))]
    assert [track["language"] for track in tracks] == ["pol", "eng", "pol", "und"]
    assert tracks[1]["forced"] is True
    assert tracks[3].get("title") is None
    assert all(track["supported"] and track["source"] == "external" for track in tracks)
    assert all("path" not in track and str(tmp_path) not in repr(track) for track in tracks)


def test_a_sidecar_goes_to_the_film_whose_name_matches_furthest(tmp_path: Path) -> None:
    """`Film 2.pl.srt` starts with `Film` too, and belongs to neither by accident."""
    short = tmp_path / "Film.mkv"
    long = tmp_path / "Film 2.mkv"
    for film in (short, long):
        film.write_bytes(b"film")
    (tmp_path / "Film.pl.srt").write_text("1\n", encoding="utf-8")
    (tmp_path / "Film 2.pl.srt").write_text("1\n", encoding="utf-8")

    assert [path.name for path in external_subtitle_files(_resolved(short))] == ["Film.pl.srt"]
    assert [path.name for path in external_subtitle_files(_resolved(long))] == ["Film 2.pl.srt"]

    # Two containers of the same film share the subtitle, which is right: it
    # belongs to both of them equally.
    twin = tmp_path / "Film.avi"
    twin.write_bytes(b"film")
    assert [path.name for path in external_subtitle_files(_resolved(twin))] == ["Film.pl.srt"]


def test_sidecar_track_numbers_continue_after_the_embedded_ones(tmp_path: Path) -> None:
    """One integer names a track everywhere, and it resolves back to one file."""
    film = tmp_path / "Serial S01E02.mkv"
    film.write_bytes(b"film")
    (tmp_path / "Serial S01E02.pl.srt").write_text("1\n", encoding="utf-8")
    (tmp_path / "Serial S01E02.en.srt").write_text("1\n", encoding="utf-8")
    resolved = _resolved(film)
    info = {
        "subtitle_tracks": [
            {"index": 0, "source": "embedded", "supported": True},
            {"index": 1, "source": "external", "supported": True},
            {"index": 2, "source": "external", "supported": True},
        ]
    }

    assert external_subtitle_path(resolved, info, 0) is None
    assert external_subtitle_path(resolved, info, 1).name == "Serial S01E02.en.srt"
    assert external_subtitle_path(resolved, info, 2).name == "Serial S01E02.pl.srt"
    assert external_subtitle_path(resolved, info, 9) is None

    config = StereoConfig(ffmpeg_path="ffmpeg", bitrate_kbps=192)
    sidecar = external_subtitle_path(resolved, info, 1)
    command = subtitle_webvtt_command(resolved, config, 1, 0.0, sidecar, "cp1250")
    # The file is the track, so the film is not even opened and the number is
    # not carried into the mapping.
    assert command[command.index("-i") + 1] == str(sidecar)
    assert command[command.index("-map") + 1] == "0:s:0"
    assert command[command.index("-sub_charenc") + 1] == "cp1250"
    assert str(film) not in command
    # An embedded track is unchanged by any of this.
    embedded = subtitle_webvtt_command(resolved, config, 1)
    assert embedded[embedded.index("-i") + 1] == str(film)
    assert embedded[embedded.index("-map") + 1] == "0:s:1"
    assert "-sub_charenc" not in embedded


def test_subtitle_encoding_is_guessed_only_when_utf8_is_impossible() -> None:
    """A guess is made because refusing costs the whole subtitle; it is stated as one."""
    assert subtitle_charset("Zażółć gęślą jaźń".encode("utf-8")) is None
    assert subtitle_charset(b"\xef\xbb\xbfZa" + "żółć".encode("utf-8")) is None
    assert subtitle_charset(b"plain ascii cue text") is None
    assert subtitle_charset("Zażółć gęślą jaźń".encode("cp1250")) == "cp1250"
    # A multi-byte character cut in half by the end of the sample is where we
    # stopped reading, not evidence about the file.
    assert subtitle_charset("aaaaaaaaaaż".encode("utf-8")[:-1]) is None


def test_stream_lines_are_read_whichever_order_the_container_prints() -> None:
    """Matroska writes `#0:1(pol):`, MP4 writes `#0:1[0x2](und):` — both are streams."""
    from media_server.stereo import _STREAM_PATTERN

    matroska = (
        b"  Stream #0:1(pol): Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s (default)\n"
        b"  Stream #0:3(eng): Subtitle: subrip (srt)\n"
    )
    mp4 = (
        b"  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1128x480, 476 kb/s, 25 fps (default)\n"
        b"  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s\n"
    )
    found = [
        (match.group("kind"), match.group("language"), match.group("codec"))
        for match in _STREAM_PATTERN.finditer(matroska + mp4)
    ]
    assert found == [
        (b"Audio", b"pol", b"ac3"),
        (b"Subtitle", b"eng", b"subrip"),
        (b"Video", b"und", b"h264"),
        (b"Audio", b"und", b"aac"),
    ]


def test_stream_facts_are_data_not_a_sentence() -> None:
    """The label is written in the browser now, so the service sends the parts."""
    from media_server.stereo import _stream_facts

    assert _stream_facts("ac3", ", 48000 Hz, 5.1(side), fltp, 640 kb/s (default)") == {
        "codec": "ac3",
        "channel_layout": "5.1",
        "bitrate_kbps": 640,
        "default": True,
    }
    assert _stream_facts("truehd", ", 48000 Hz, 7.1, s32 (24 bit)") == {
        "codec": "truehd",
        "channel_layout": "7.1",
    }
    assert _stream_facts("aac", ", 44100 Hz, stereo") == {"codec": "aac", "channel_layout": "stereo"}
    # Nothing ffmpeg left out is invented.
    assert _stream_facts("dts", "") == {"codec": "dts"}
    assert _stream_facts("subrip", " (forced)") == {"codec": "subrip", "forced": True}


def test_a_sidecar_conversion_is_cached_under_the_sidecar_not_the_film(tmp_path: Path, monkeypatch) -> None:
    """Written under the key it is read back with, and never on an embedded track's."""
    import sys

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    sidecar = tmp_path / "Film.pl.srt"
    sidecar.write_text("1\n00:00:00,000 --> 00:00:01,000\nHej\n", encoding="utf-8")
    cache = tmp_path / "cache"
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=cache)
    item = _resolved(film)
    converted = "print('WEBVTT\\n\\n00:00.000 --> 00:01.000\\nHej')"
    monkeypatch.setattr(stereo, "subtitle_webvtt_command", lambda *_args, **_kwargs: [sys.executable, "-c", converted])

    payload = asyncio.run(stereo.extract_subtitle_webvtt(item, config, 0, 0.0, None, sidecar))
    assert payload.startswith(b"WEBVTT")
    assert stereo.subtitle_cache_file(item, config, 0, sidecar).is_file()
    # Track 0 of the film itself is a different subtitle and must stay unwritten.
    assert not stereo.subtitle_cache_file(item, config, 0).exists()

    # The disk cache now answers on its own: no FFmpeg, nothing in memory.
    stereo._SUBTITLE_CACHE.clear()
    failing = [sys.executable, "-c", "raise SystemExit(3)"]
    monkeypatch.setattr(stereo, "subtitle_webvtt_command", lambda *_args, **_kwargs: failing)
    assert asyncio.run(stereo.extract_subtitle_webvtt(item, config, 0, 0.0, None, sidecar)).startswith(b"WEBVTT")


class _CountingProcess:
    """A probe that takes a moment and remembers how many of its kind ran at once."""

    running = 0
    peak = 0

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.pid = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        type(self).running += 1
        type(self).peak = max(type(self).peak, type(self).running)
        try:
            await asyncio.sleep(0.02)
        finally:
            type(self).running -= 1
        self.returncode = 0
        return b"", b""


def test_a_burst_of_probes_shares_a_few_slots(tmp_path: Path, monkeypatch) -> None:
    """A scrubbing viewer's stereo-keyframe burst used to start one FFmpeg per request."""
    from media_server import stereo

    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg")
    _CountingProcess.running = _CountingProcess.peak = 0

    async def spawn(*_args, **_kwargs):
        return _CountingProcess()

    monkeypatch.setattr(stereo.asyncio, "create_subprocess_exec", spawn)

    async def burst() -> None:
        # Landing probes and stream probes draw from the same slots.
        await asyncio.gather(
            *(stereo._seek_landing(item, config, 10.0 + second) for second in range(12)),
            *(stereo._probe_stderr(item, config) for _ in range(6)),
        )

    asyncio.run(burst())
    assert _CountingProcess.peak == stereo._PROBE_SLOTS


def test_a_probe_that_cannot_get_a_slot_answers_as_a_failed_probe(tmp_path: Path, monkeypatch) -> None:
    """Landing on the click is a slower seek, not an error — and no FFmpeg is started for it."""
    from media_server import stereo

    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    started: list[object] = []

    async def spawn(*_args, **_kwargs):
        started.append(object())
        return _CountingProcess()

    monkeypatch.setattr(stereo.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(stereo, "_PROBE_QUEUE_SECONDS", 0.05)

    async def scenario() -> tuple[object, object]:
        gate = stereo._probe_gate()
        for _ in range(stereo._PROBE_SLOTS):
            await gate.acquire()
        try:
            return (
                await stereo._seek_landing(item, StereoConfig(ffmpeg_path="ffmpeg"), 10.0),
                await stereo._probe_stderr(item, StereoConfig(ffmpeg_path="ffmpeg")),
            )
        finally:
            for _ in range(stereo._PROBE_SLOTS):
                gate.release()

    assert asyncio.run(scenario()) == (None, None)
    assert started == []


def test_a_sidecar_that_is_a_link_is_not_offered(tmp_path: Path, monkeypatch) -> None:
    """A link named Film.pl.srt could point anywhere the service can read."""
    import os
    import stat as stat_module

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    (tmp_path / "Film.en.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nHi\n", encoding="utf-8")
    secret = tmp_path / "outside.txt"
    secret.write_text("not a subtitle", encoding="utf-8")
    link = tmp_path / "Film.pl.srt"
    try:
        os.symlink(secret, link)
    except (OSError, NotImplementedError):
        # No symlinks for this account (Windows without the privilege): pretend
        # the file is one, which is all the check looks at.
        link.write_text("1\n00:00:00,000 --> 00:00:01,000\nX\n", encoding="utf-8")
        real_lstat = Path.lstat

        def lstat(self: Path, *args, **kwargs):
            facts = real_lstat(self, *args, **kwargs)
            if self.name != link.name:
                return facts
            fields = list(facts[:10])
            fields[0] = stat_module.S_IFLNK | 0o777
            return os.stat_result(fields)

        monkeypatch.setattr(Path, "lstat", lstat)

    assert [path.name for path in external_subtitle_files(_resolved(film))] == ["Film.en.srt"]


def test_text_tracks_of_one_film_are_converted_in_one_read(tmp_path: Path, monkeypatch) -> None:
    """1484 text tracks were 3.74 TB of reading, one read of the film per track."""
    import sys

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    runs: list[list[str]] = []
    writer = (
        "import sys\n"
        "for target in sys.argv[1:]:\n"
        "    open(target, 'wb').write(b'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nCue ' + target[-5:-4].encode() + b'\\n')\n"
    )

    def command(_item, _config, tracks):
        runs.append([str(target) for _, target in tracks])
        return [sys.executable, "-c", writer, *(str(target) for _, target in tracks)]

    monkeypatch.setattr(stereo, "film_webvtt_command", command)

    outcome = asyncio.run(stereo.extract_film_webvtt(item, config, [2, 5, 7], None))

    assert outcome == {2: ("generated", None), 5: ("generated", None), 7: ("generated", None)}
    assert len(runs) == 1, "the film was read more than once"
    assert stereo.subtitle_cache_file(item, config, 5).read_bytes().endswith(b"Cue 5\n")
    assert not (tmp_path / "cache" / "work").exists() or not any((tmp_path / "cache" / "work").iterdir())
    # Already converted: nothing runs.
    assert asyncio.run(stereo.extract_film_webvtt(item, config, [2, 5, 7], None)) == {
        2: ("cached", None), 5: ("cached", None), 7: ("cached", None)
    }
    assert len(runs) == 1


def test_a_failed_one_read_conversion_falls_back_track_by_track(tmp_path: Path, monkeypatch) -> None:
    """One track nothing can convert must cost only itself."""
    import sys

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    monkeypatch.setattr(
        stereo, "film_webvtt_command", lambda *_args: [sys.executable, "-c", "raise SystemExit(1)"]
    )
    alone: list[int] = []

    async def one(_item, _config, track, _start, _semaphore, *_args):
        alone.append(track)
        if track == 5:
            raise stereo.StereoTranscodeError("Subtitle conversion failed")
        return b"WEBVTT\n"

    monkeypatch.setattr(stereo, "extract_subtitle_webvtt", one)

    outcome = asyncio.run(stereo.extract_film_webvtt(item, config, [2, 5], None))

    assert alone == [2, 5]
    assert outcome == {2: ("generated", None), 5: ("failed", "Subtitle conversion failed")}


def test_text_tracks_of_a_transport_stream_are_still_converted_one_by_one(tmp_path: Path, monkeypatch) -> None:
    """Converted together they would share a zero they do not have alone."""
    from media_server import stereo

    film = tmp_path / "00001.m2ts"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    alone: list[int] = []

    async def one(_item, _config, track, *_args):
        alone.append(track)
        return b"WEBVTT\n"

    def never(*_args):
        raise AssertionError("a transport stream went through the one-read conversion")

    monkeypatch.setattr(stereo, "extract_subtitle_webvtt", one)
    monkeypatch.setattr(stereo, "film_webvtt_command", never)
    assert asyncio.run(stereo.extract_film_webvtt(item, config, [0, 1], None)) == {
        0: ("generated", None), 1: ("generated", None)
    }
    assert alone == [0, 1]


def test_the_one_read_conversion_writes_what_one_track_alone_would(tmp_path: Path) -> None:
    """Same options per output as the single-track command; only the target differs."""
    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg")
    alone = subtitle_webvtt_command(item, config, 3)
    together = stereo.film_webvtt_command(item, config, [(3, tmp_path / "3.vtt"), (4, tmp_path / "4.vtt")])
    per_output = alone[alone.index("-map") : alone.index("pipe:1")]
    assert together[together.index("-map") : together.index(str(tmp_path / "3.vtt"))] == per_output


def test_a_sub_file_is_offered_only_when_it_is_microdvd_text(tmp_path: Path) -> None:
    """`.sub` is MicroDVD text or the binary half of a VobSub pair; the bytes decide, not the name."""
    from media_server.stereo import sidecar_format

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    (tmp_path / "Film.pl.sub").write_bytes(
        b"\xef\xbb\xbf{1}{1}23.976\r\n{24}{72}Cze\xc5\x9b\xc4\x87|druga linia\r\n{100}{150}{y:i}Kursywa\r\n"
    )
    # VobSub: MPEG program stream packets, read through the .idx beside them.
    (tmp_path / "Film.sub").write_bytes(b"\x00\x00\x01\xba" + bytes(2044))
    (tmp_path / "Film.idx").write_text("# VobSub index file, v7\nsize: 720x576\n", encoding="ascii")
    # SubViewer calls itself .sub as well.
    (tmp_path / "Film.en.sub").write_text("[INFORMATION]\n00:00:01.00,00:00:03.00\nHello\n", encoding="ascii")

    assert sidecar_format(tmp_path / "Film.pl.sub") == "microdvd"
    assert sidecar_format(tmp_path / "Film.sub") == "vobsub"
    assert sidecar_format(tmp_path / "Film.en.sub") is None
    found = external_subtitle_files(_resolved(film))
    assert [path.name for path in found] == ["Film.pl.sub"]
    track = _external_subtitle_track(_resolved(film), found[0], 0)
    assert (track["codec"], track["language"], track["supported"]) == ("microdvd", "pol", True)


def test_a_microdvd_sidecar_is_read_at_the_films_frame_rate(tmp_path: Path) -> None:
    """Frames, not times: counted at the rate the file names, else at the film's own."""
    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    sidecar = tmp_path / "Film.pl.sub"
    sidecar.write_text("{24}{72}Hej\n", encoding="utf-8")
    srt = tmp_path / "Film.pl.srt"
    srt.write_text("1\n", encoding="utf-8")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")

    command = subtitle_webvtt_command(item, config, 2, 0.0, sidecar, None, "24000/1001")
    # The demuxer is named (FFmpeg's probe wants three lines), the fallback rate given, both before the input.
    assert command[command.index("-f") + 1] == "microdvd" and command.index("-f") < command.index("-i")
    assert command[command.index("-subfps") + 1] == "24000/1001" and command.index("-subfps") < command.index("-i")
    # Without a known rate FFmpeg's own default stands, and other sidecars are untouched.
    assert "-subfps" not in subtitle_webvtt_command(item, config, 2, 0.0, sidecar)
    plain = subtitle_webvtt_command(item, config, 2, 0.0, srt, None, "24000/1001")
    assert "-subfps" not in plain and "microdvd" not in plain
    # The rate is part of what a MicroDVD conversion is cached under, and of nothing else's.
    assert stereo.subtitle_cache_file(item, config, 2, sidecar, "25") != stereo.subtitle_cache_file(
        item, config, 2, sidecar, "24000/1001"
    )
    assert stereo.subtitle_cache_file(item, config, 2, srt, "25") == stereo.subtitle_cache_file(item, config, 2, srt)


def test_the_films_frame_rate_is_read_back_the_way_ffmpeg_means_it() -> None:
    """FFmpeg prints 23.976 as "23.98 fps"; read as 23.98, a two-hour film's last cue lands 1.2 s early."""
    from media_server.stereo import stream_frame_rate

    assert stream_frame_rate(", yuv420p, 1920x800 [SAR 1:1 DAR 12:5], 23.98 fps, 23.98 tbr, 1k tbn") == "24000/1001"
    assert stream_frame_rate(", yuv420p, 720x576 [SAR 16:15 DAR 4:3], 25 fps, 25 tbr, 1k tbn") == "25"
    assert stream_frame_rate(", 1280x720, 29.97 fps, 29.97 tbr, 90k tbn") == "30000/1001"
    assert stream_frame_rate(", 1920x1080, 59.94 tbr, 90k tbn") == "60000/1001"
    assert stream_frame_rate(", 640x480, 12.5 fps, 12.5 tbr") == "12.5"
    assert stream_frame_rate(", 1920x1080, 1k tbn") is None


def test_the_probe_offers_a_microdvd_sidecar_with_the_films_rate(tmp_path: Path, monkeypatch) -> None:
    from media_server import stereo

    film = tmp_path / "Film.avi"
    film.write_bytes(b"film")
    (tmp_path / "Film.pl.sub").write_text("{24}{72}Hej\n{100}{150}Druga\n", encoding="utf-8")
    stderr = (
        b"Input #0, avi, from 'Film.avi':\n  Duration: 01:30:00.00, start: 0.000000, bitrate: 1200 kb/s\n"
        b"  Stream #0:0: Video: mpeg4 (Advanced Simple Profile) (XVID / 0x44495658), yuv420p, 720x304"
        b" [SAR 1:1 DAR 45:19], 1000 kb/s, 23.98 fps, 23.98 tbr, 23.98 tbn\n"
        b"  Stream #0:1: Audio: mp3 (U[0][0][0] / 0x0055), 48000 Hz, stereo, fltp, 128 kb/s\n"
    )

    async def probe(_item, _config):
        return stderr

    monkeypatch.setattr(stereo, "_probe_stderr", probe)
    stereo._PROBE_CACHE.clear()
    info = asyncio.run(stereo.probe_media_info(_resolved(film), StereoConfig(ffmpeg_path="ffmpeg")))

    assert info["video_frame_rate"] == "24000/1001"
    assert [(track["codec"], track["source"]) for track in info["subtitle_tracks"]] == [("microdvd", "external")]


def test_the_background_pass_converts_a_microdvd_sidecar_at_the_films_rate(tmp_path: Path, monkeypatch) -> None:
    from media_server import subtitle_jobs

    film = tmp_path / "Film.avi"
    film.write_bytes(b"film")
    sidecar = tmp_path / "Film.pl.sub"
    sidecar.write_text("{24}{72}Hej\n", encoding="utf-8")
    item = _resolved(film)
    from types import SimpleNamespace

    config = SimpleNamespace(stereo=StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache"))
    info = {
        "video_frame_rate": "25",
        "subtitle_tracks": [{"index": 0, "source": "external", "supported": True, "codec": "microdvd"}],
    }
    seen: list[tuple] = []

    async def convert(_item, _config, track, _start, _semaphore, source, frame_rate=None):
        seen.append((track, source.name, frame_rate))
        return b"WEBVTT\n"

    monkeypatch.setattr(subtitle_jobs, "extract_subtitle_webvtt", convert)
    status = {"cached_tracks": 0, "generated_tracks": 0, "errors": 0}
    failed = asyncio.run(subtitle_jobs._warm_text(item, info, config, status, asyncio.Semaphore(1), False))

    assert failed == 0 and status["generated_tracks"] == 1
    assert seen == [(0, "Film.pl.sub", "25")]


def _real_ffmpeg() -> str | None:
    import shutil

    from media_server.config import PROJECT_ROOT

    bundled = sorted(PROJECT_ROOT.joinpath("runtime").glob("ffmpeg-*/bin/ffmpeg*"))
    return str(bundled[-1]) if bundled else shutil.which("ffmpeg")


def test_a_microdvd_sidecar_converts_with_the_real_ffmpeg(tmp_path: Path) -> None:
    """End to end with FFmpeg itself: the fallback rate, the file's own rate winning, a two-line file."""
    import pytest

    from media_server import stereo

    ffmpeg = _real_ffmpeg()
    if ffmpeg is None:
        pytest.skip("FFmpeg is not installed here")
    film = tmp_path / "Film.avi"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path=ffmpeg, subtitle_cache_path=tmp_path / "cache")
    bare = tmp_path / "Film.pl.sub"
    bare.write_bytes(b"{24}{72}Pierwsza|druga linia\r\n{240}{288}{y:i}Kursywa\r\n")
    named = tmp_path / "Film.en.sub"
    named.write_bytes(b"{1}{1}25.000\r\n{25}{75}One\r\n{250}{300}Two\r\n")

    at_film_rate = asyncio.run(stereo.extract_subtitle_webvtt(item, config, 0, 0.0, None, bare, "24000/1001"))
    at_pal = asyncio.run(stereo.extract_subtitle_webvtt(item, config, 0, 0.0, None, bare, "25"))
    own_rate = asyncio.run(stereo.extract_subtitle_webvtt(item, config, 1, 0.0, None, named, "24000/1001"))

    assert at_film_rate.startswith(b"WEBVTT")
    assert b"00:01.001 --> 00:03.003\nPierwsza\ndruga linia" in at_film_rate
    assert b"00:10.010 --> 00:12.012\n<i>Kursywa</i>" in at_film_rate
    assert b"00:00.960 --> 00:02.880" in at_pal
    # The file's own {1}{1}25 line wins over the film's rate, and is not a cue itself.
    assert b"00:01.000 --> 00:03.000\nOne" in own_rate and b"25.000" not in own_rate


def test_the_background_probe_asks_again_and_says_why_when_it_cannot(tmp_path: Path, monkeypatch) -> None:
    """The pass had a viewer's twelve seconds, and took a slow answer for a film with nothing in it.

    23 films of the first full run were passed over that way without a word; asked
    again, every one of them was described in a tenth of a second.
    """
    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    (tmp_path / "Film.pl.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nHej\n", encoding="utf-8")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg")
    header = (
        b"Input #0, matroska,webm, from 'Film.mkv':\n  Duration: 01:30:00.00, start: 0.000000, bitrate: 1200 kb/s\n"
        b"  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 23.98 fps, 23.98 tbr, 1k tbn\n"
        b"  Stream #0:1(pol): Subtitle: hdmv_pgs_subtitle (pgssub), 1920x1080\n"
    )
    slow = stereo.ProbeFailed("FFmpeg did not describe the file within 60 s")
    answers: list[object] = []
    deadlines: list[float] = []

    async def header_read(_item, _config, deadline):
        deadlines.append(deadline)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(stereo, "_probe_header", header_read)

    def probe():
        stereo._PROBE_CACHE.clear()
        return asyncio.run(stereo.probe_media_info_patiently(item, config, pause_seconds=0))

    answers[:] = [slow, header]
    info, problem = probe()
    assert problem is None and info["duration_seconds"] == 5400.0
    assert [(track["codec"], track["source"]) for track in info["subtitle_tracks"]] == [
        ("hdmv_pgs_subtitle", "embedded"), ("srt", "external")
    ]
    assert deadlines == [stereo._BACKGROUND_PROBE_SECONDS] * 2
    assert stereo._BACKGROUND_PROBE_SECONDS > stereo._PROBE_SECONDS

    # Never described: the reason comes back, the sidecar is still offered, and
    # nothing is remembered for the next asker.
    answers[:] = [slow, slow]
    info, problem = probe()
    assert problem == "FFmpeg did not describe the file within 60 s"
    assert not stereo.described(info)
    assert [track["source"] for track in info["subtitle_tracks"]] == ["external"]
    assert not stereo._PROBE_CACHE

    # FFmpeg's own verdict on the file is not asked for twice, and is passed on
    # without the film's absolute path.
    answers[:] = [f"{film}: Invalid data found when processing input\n".encode()]
    info, problem = probe()
    assert problem == "Invalid data found when processing input" and answers == []


def test_a_failed_probe_says_why(tmp_path: Path, monkeypatch) -> None:
    import pytest

    from media_server import stereo

    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg")

    async def cannot_start(*_args, **_kwargs):
        raise OSError("[WinError 1455] The paging file is too small")

    monkeypatch.setattr(stereo.asyncio, "create_subprocess_exec", cannot_start)
    with pytest.raises(stereo.ProbeFailed, match="could not be started: .*paging file"):
        asyncio.run(stereo._probe_header(item, config, 1.0))

    async def spawn(*_args, **_kwargs):
        return _CountingProcess()

    async def too_slow(_process, _seconds):
        raise TimeoutError

    monkeypatch.setattr(stereo.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(stereo, "_communicate_bounded", too_slow)
    with pytest.raises(stereo.ProbeFailed, match="did not describe the file within 1 s"):
        asyncio.run(stereo._probe_header(item, config, 1.0))

    monkeypatch.setattr(stereo, "_PROBE_QUEUE_SECONDS", 0.05)

    async def busy() -> None:
        gate = stereo._probe_gate()
        for _ in range(stereo._PROBE_SLOTS):
            await gate.acquire()
        try:
            await stereo._probe_header(item, config, 1.0)
        finally:
            for _ in range(stereo._PROBE_SLOTS):
                gate.release()

    with pytest.raises(stereo.ProbeFailed, match="no probe slot came free within 0.05 s"):
        asyncio.run(busy())
    # The viewer's probe still answers every one of these with "nothing known".
    assert asyncio.run(stereo._probe_stderr(item, StereoConfig(ffmpeg_path=None))) is None


def test_ffmpegs_reason_is_its_last_telling_line_without_addresses_or_paths(tmp_path: Path) -> None:
    from media_server.stereo import ffmpeg_reason

    film = tmp_path / "Film.mkv"
    stderr = (
        b"[srt @ 000001fbc8720c40] Invalid UTF-8 in decoded subtitles text; maybe missing -sub_charenc option\n"
        b"[sist#0:4/subrip @ 000001fbc8720440] [dec:srt @ 000001fbc68ecd00] "
        b"Decode error rate 0.805492 exceeds maximum 0.666667\n"
        b"[sist#0:4/subrip @ 000001fbc8720440] [dec:srt @ 000001fbc68ecd00] "
        b"Task finished with error: Error number -1145393733 occurred\n"
        b"[sist#0:4/subrip @ 0x55d5c1e0] [dec:srt @ 0x55d5c1f0] "
        b"Terminating thread with error: Error number -1145393733 occurred\n"
        b"Conversion failed!\n"
    )
    assert ffmpeg_reason(stderr) == "Decode error rate 0.805492 exceeds maximum 0.666667"
    assert ffmpeg_reason(f"{film}: Permission denied\n".encode(), film) == "Permission denied"
    assert ffmpeg_reason(b"") == ffmpeg_reason(None) == "FFmpeg said nothing"


def _fake_converter(tmp_path: Path, name: str, cues: list[str], unreadable: int, code: int = 0) -> list[str]:
    """A stand-in FFmpeg: prints ``cues`` as WebVTT, and one "Invalid UTF-8" per unreadable packet."""
    import sys

    script = tmp_path / f"{name}.py"
    body = "".join(f"00:{index:02d}.000 --> 00:{index:02d}.500\n{cue}\n\n" for index, cue in enumerate(cues))
    script.write_text(
        "import sys\n"
        f"sys.stdout.buffer.write(('WEBVTT\\n\\n' + {body!r}).encode('utf-8'))\n"
        f"sys.stderr.write('[srt @ 000001fbc8720c40] Invalid UTF-8 in decoded subtitles text\\n' * {unreadable})\n"
        + (
            "sys.stderr.write('[sist#0:2/subrip @ 000001fb] [dec:srt @ 000001fc] "
            "Decode error rate 0.75 exceeds maximum 0.666667\\n')\n"
            if code else ""
        )
        + f"raise SystemExit({code})\n",
        encoding="utf-8",
    )
    return [sys.executable, str(script)]


def test_an_embedded_track_that_is_not_utf8_is_read_again_in_cp1250(tmp_path: Path, monkeypatch) -> None:
    """Seven of The Pacific's eight Polish tracks are CP1250 in a track Matroska calls UTF-8.

    FFmpeg gave up on them ("Decode error rate 0.805 exceeds maximum 0.667"), the
    viewer got no subtitles and the background pass seven errors.
    """
    import pytest

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    read_as_utf8 = _fake_converter(tmp_path, "utf8", ["Pearl Harbor"], unreadable=3, code=69)
    read_as_cp1250 = _fake_converter(tmp_path, "cp1250", ["Pearl Harbor", "Japończycy zbombardowali"], 0)
    asked: list[str | None] = []

    def command(_item, _config, _track, _start, _source, charset, _rate):
        asked.append(charset)
        return read_as_cp1250 if charset == "cp1250" else read_as_utf8

    monkeypatch.setattr(stereo, "subtitle_webvtt_command", command)
    payload = asyncio.run(stereo.extract_subtitle_webvtt(item, config, 1))
    assert asked == [None, "cp1250"]
    assert "Japończycy zbombardowali" in payload.decode("utf-8")
    assert "Japończycy zbombardowali" in stereo.subtitle_cache_file(item, config, 1).read_text(encoding="utf-8")

    # Unreadable in CP1250 as well: the failure says what FFmpeg said.
    monkeypatch.setattr(stereo, "subtitle_webvtt_command", lambda *_args: read_as_utf8)
    with pytest.raises(stereo.StereoTranscodeError, match="Decode error rate 0.75 exceeds maximum"):
        asyncio.run(stereo.extract_subtitle_webvtt(item, config, 2))

    # Only the subtitle decoders are told; the film's video and audio have no text.
    told = subtitle_webvtt_command(item, config, 1, 0.0, None, "cp1250")
    assert told[told.index("-sub_charenc:s") + 1] == "cp1250" and told.index("-sub_charenc:s") < told.index("-i")


def test_a_utf8_track_with_one_broken_packet_is_not_read_in_cp1250(tmp_path: Path, monkeypatch) -> None:
    """Read in CP1250, every Polish letter of a UTF-8 track would come out mangled."""
    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    cues = [f"Zażółć gęślą jaźń {index}" for index in range(30)]
    asked: list[str | None] = []

    def command(_item, _config, _track, _start, _source, charset, _rate):
        asked.append(charset)
        return _fake_converter(tmp_path, "scratched", cues, unreadable=1)

    monkeypatch.setattr(stereo, "subtitle_webvtt_command", command)
    payload = asyncio.run(stereo.extract_subtitle_webvtt(item, config, 0)).decode("utf-8")
    assert asked == [None]
    assert "Zażółć gęślą jaźń 29" in payload


def test_the_one_read_pass_hands_a_track_in_another_codepage_to_the_one_by_one_pass(
    tmp_path: Path, monkeypatch
) -> None:
    """FFmpeg finishes the pass without the unreadable cues and does not say which track they were in."""
    import sys

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    writer = (
        "import sys\n"
        "for target in sys.argv[1:]:\n"
        "    open(target, 'wb').write(b'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nCue\\n')\n"
        "sys.stderr.write('[srt @ 000001fbc8720c40] Invalid UTF-8 in decoded subtitles text\\n')\n"
    )
    monkeypatch.setattr(
        stereo, "film_webvtt_command",
        lambda _item, _config, tracks: [sys.executable, "-c", writer, *(str(target) for _, target in tracks)],
    )
    alone: list[int] = []

    async def one(_item, _config, track, *_args):
        alone.append(track)
        return b"WEBVTT\n"

    monkeypatch.setattr(stereo, "extract_subtitle_webvtt", one)
    assert asyncio.run(stereo.extract_film_webvtt(item, config, [2, 5], None)) == {
        2: ("generated", None), 5: ("generated", None)
    }
    assert alone == [2, 5]


def test_a_cp1250_track_inside_matroska_converts_with_the_real_ffmpeg(tmp_path: Path) -> None:
    """End to end: the bytes The Pacific has, in a Matroska file FFmpeg itself wrote."""
    import subprocess

    import pytest

    from media_server import stereo

    ffmpeg = _real_ffmpeg()
    if ffmpeg is None:
        pytest.skip("FFmpeg is not installed here")
    config = StereoConfig(ffmpeg_path=ffmpeg, subtitle_cache_path=tmp_path / "cache")
    polish = ["Japończycy zbombardowali", "Nie znamy szczegółów ataku.", "Żółć gęślą jaźń"]
    plain = ["Pearl Harbor", "Roosevelt", "Hawaje"]

    def film(name: str, encoding: str, cues: list[str]) -> ResolvedItem:
        srt = tmp_path / f"{name}.srt"
        srt.write_bytes("".join(
            f"{index + 1}\r\n00:00:{index:02d},000 --> 00:00:{index:02d},500\r\n{cue}\r\n\r\n"
            for index, cue in enumerate(cues)
        ).encode(encoding))
        target = tmp_path / f"{name}.mkv"
        subprocess.run(
            [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(srt),
             "-c:s", "copy", "-f", "matroska", str(target)],
            check=True, capture_output=True,
        )
        return _resolved(target)

    def converted(item: ResolvedItem) -> str:
        return asyncio.run(stereo.extract_subtitle_webvtt(item, config, 0)).decode("utf-8")

    # Every cue unreadable as UTF-8: FFmpeg gave up on the track.
    assert all(cue in converted(film("all", "cp1250", polish)) for cue in polish)
    # Half of them: FFmpeg converted the track without those and said nothing.
    assert all(cue in converted(film("half", "cp1250", polish + plain)) for cue in polish + plain)
    # A UTF-8 track comes out as it always did.
    assert all(cue in converted(film("utf8", "utf-8", polish + plain)) for cue in polish + plain)


def test_a_blu_ray_menu_clip_is_described_with_nothing_in_it(tmp_path: Path, monkeypatch) -> None:
    """Seven 3 MB clips in Happy Death Day's 4K folders: one interactive-graphics stream, no picture, no duration.

    The full run of 09.11 counted each of them as a film FFmpeg could not describe,
    with FFmpeg's closing line for a reason — "At least one output file must be
    specified", which it prints after every ``ffmpeg -i``.
    """
    from media_server import stereo

    clip = tmp_path / "00005.m2ts"
    clip.write_bytes(b"clip")
    item = _resolved(clip)
    header = (
        b"[in#0/mpegts @ 0000026d78b13600] Could not find codec parameters for stream 0 (Unknown: none "
        b"([145][0][0][0] / 0x0091)): unknown codec\n"
        b"Consider increasing the value for the 'analyzeduration' (0) and 'probesize' (5000000) options\n"
        + f"Input #0, mpegts, from '{clip}':\n".encode()
        + b"  Duration: N/A, start: 600.000000, bitrate: N/A\n  Program 1 \n"
        b"  Stream #0:0[0x1400]: Unknown: none ([145][0][0][0] / 0x0091), start 600.000000\n"
        b"At least one output file must be specified\n"
    )

    async def header_read(_item, _config, _deadline):
        return header

    monkeypatch.setattr(stereo, "_probe_header", header_read)
    stereo._PROBE_CACHE.clear()
    info, problem = asyncio.run(
        stereo.probe_media_info_patiently(item, StereoConfig(ffmpeg_path="ffmpeg"), pause_seconds=0)
    )
    assert problem is None
    assert info["subtitle_tracks"] == [] and info["video_codec"] is None and info["duration_seconds"] is None
    # What FFmpeg says after every description is never the reason for anything.
    complaint = b"[in#0 @ 000001] Some real complaint\nAt least one output file must be specified\n"
    assert stereo.ffmpeg_reason(complaint) == "Some real complaint"


def test_a_probe_reads_at_normal_io_priority(tmp_path: Path, monkeypatch) -> None:
    """The service inherits low I/O priority from its scheduled task, and so did every probe.

    Behind one ordinary reader of the media disk a description took 4.7–26 s
    instead of 0.2–1.2 s; four films of the full run of 09.11 never got theirs.
    """
    from media_server import stereo

    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    item = _resolved(film)
    config = StereoConfig(ffmpeg_path="ffmpeg")
    lifted: list[int] = []

    class _Started(_CountingProcess):
        def __init__(self) -> None:
            super().__init__()
            self.pid = 4242

    async def spawn(*_args, **_kwargs):
        return _Started()

    monkeypatch.setattr(stereo.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(stereo, "read_at_normal_priority", lambda pid: lifted.append(pid) or True)

    async def both() -> None:
        await stereo._probe_header(item, config, 5.0)
        await stereo._seek_landing(item, config, 10.0)

    asyncio.run(both())
    assert lifted == [4242, 4242]


def test_a_conversion_leaves_no_lock_behind(tmp_path: Path, monkeypatch) -> None:
    """One lock per track ever converted stayed in memory for as long as the service ran (T-12)."""
    import sys

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    item = _resolved(film)
    started = tmp_path / "started.txt"
    converted = (
        "import time; open(%r, 'a').write('x'); time.sleep(0.2); "
        "print('WEBVTT\\n\\n00:00.000 --> 00:01.000\\nHej')" % str(started)
    )
    monkeypatch.setattr(stereo, "subtitle_webvtt_command", lambda *_args, **_kwargs: [sys.executable, "-c", converted])
    stereo._SUBTITLE_CACHE.clear()
    stereo._SUBTITLE_LOCKS.clear()

    async def three_viewers() -> list[bytes]:
        return await asyncio.gather(*(stereo.extract_subtitle_webvtt(item, config, 0) for _ in range(3)))

    answers = asyncio.run(three_viewers())
    assert all(answer.startswith(b"WEBVTT") for answer in answers)
    # Converted once for the three of them, and nothing is left holding the key.
    assert started.read_text() == "x"
    assert stereo._SUBTITLE_LOCKS == {}

    failing = [sys.executable, "-c", "raise SystemExit(3)"]
    monkeypatch.setattr(stereo, "subtitle_webvtt_command", lambda *_args, **_kwargs: failing)
    with pytest.raises(stereo.StereoTranscodeError):
        asyncio.run(stereo.extract_subtitle_webvtt(item, config, 1))
    assert stereo._SUBTITLE_LOCKS == {}


def test_a_track_that_never_ends_is_stopped_at_the_ceiling(tmp_path: Path, monkeypatch) -> None:
    """The output was collected whole and measured afterwards: an endless track was endless memory (T-12)."""
    import sys
    import time

    from media_server import stereo

    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    endless = (
        "import sys\n"
        "sys.stdout.write('WEBVTT\\n\\n')\n"
        "while True:\n"
        "    sys.stdout.write('00:00.000 --> 00:01.000\\nagain\\n\\n' * 1000)\n"
        "    sys.stdout.flush()\n"
    )
    monkeypatch.setattr(stereo, "subtitle_webvtt_command", lambda *_args, **_kwargs: [sys.executable, "-c", endless])
    monkeypatch.setattr(stereo, "_WEBVTT_MAX_BYTES", 256 * 1024)
    stereo._SUBTITLE_CACHE.clear()

    began = time.monotonic()
    with pytest.raises(stereo.StereoTranscodeError, match="implausibly large"):
        asyncio.run(stereo.extract_subtitle_webvtt(_resolved(film), config, 0))
    assert time.monotonic() - began < 30
    assert stereo._SUBTITLE_LOCKS == {} and not list((tmp_path / "cache").rglob("*.vtt"))


def test_a_converted_file_past_the_ceiling_is_not_read(tmp_path: Path) -> None:
    from media_server import stereo

    small = tmp_path / "small.vtt"
    small.write_bytes(b"WEBVTT\n")
    large = tmp_path / "large.vtt"
    large.write_bytes(b"WEBVTT\n" + b"x" * 100)
    assert stereo._read_bounded(small, 64) == b"WEBVTT\n"
    assert stereo._read_bounded(large, 64) == b""
    assert stereo._read_bounded(tmp_path / "missing.vtt", 64) == b""
    # The name pruning computes for an embedded track is the name the conversion is kept under.
    film = tmp_path / "Film.mkv"
    film.write_bytes(b"film")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    item = _resolved(film)
    for track in (0, 7, stereo.MAX_SUBTITLE_TRACKS - 1):
        assert stereo.subtitle_cache_file(item, config, track).stem == stereo.embedded_subtitle_cache_name(item, track)
