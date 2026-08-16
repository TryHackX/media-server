from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

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
