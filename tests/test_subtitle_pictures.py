from __future__ import annotations

from pathlib import Path

from media_server.config import StereoConfig
from media_server.paths import ResolvedItem
from media_server.subtitle_pictures import (
    _Frame,
    plan_cues,
    subtitle_canvas,
    subtitle_frames_command,
)


def _resolved(path: Path) -> ResolvedItem:
    stat = path.stat()
    return ResolvedItem(path=path, archive_name=path.name, size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def test_one_picture_per_cue_not_one_per_frame_of_film(tmp_path: Path) -> None:
    """`-fps_mode passthrough` is what makes this a thousand images, not 145,000."""
    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    config = StereoConfig(ffmpeg_path="ffmpeg")

    command = subtitle_frames_command(_resolved(film), config, 2, tmp_path / "out")
    assert command[command.index("-fps_mode") + 1] == "passthrough"
    # Timestamps only: what a frame shows is read from its picture (identify_frames).
    assert command[command.index("-filter_complex") + 1] == "[0:s:2]showinfo=checksum=0[v]"
    assert command[command.index("-map") + 1] == "[v]"
    assert command[command.index("-f") + 1] == "image2"
    assert command[-1].endswith("%06d.png")


def test_the_subtitle_canvas_is_stated_rather_than_guessed(tmp_path: Path) -> None:
    """A cropped film keeps only the middle of the frame the subtitle was drawn on.

    Left to FFmpeg the canvas came out the size of the *picture*, so a line placed
    near the bottom of the disc's frame fell off it and arrived cut in half — and
    inconsistently, depending on where the render happened to start.
    """
    # A 2.35:1 rip: the disc's 16:9 frame is restored, so nothing is cut.
    assert subtitle_canvas({}, (1920, 808)) == (1920, 1080)
    assert subtitle_canvas({}, (1280, 536)) == (1280, 720)
    # An ordinary 16:9 or 4:3 file is left exactly as it was.
    assert subtitle_canvas({}, (1920, 1080)) == (1920, 1080)
    assert subtitle_canvas({}, (720, 480)) == (720, 480)
    # When the container states the subtitle's own frame, that is the answer.
    assert subtitle_canvas({"canvas_width": 1920, "canvas_height": 1080}, (1920, 808)) == (1920, 1080)
    assert subtitle_canvas({"canvas_width": 720, "canvas_height": 576}, (720, 304)) == (720, 576)
    assert subtitle_canvas({}, None) is None

    # And it reaches FFmpeg as an input option, before -i.
    film = tmp_path / "film.mkv"
    film.write_bytes(b"film")
    config = StereoConfig(ffmpeg_path="ffmpeg")
    command = subtitle_frames_command(
        _resolved(film), config, 0, tmp_path, (1920, 808), canvas=(1920, 1080)
    )
    assert command[command.index("-canvas_size") + 1] == "1920x1080"
    assert command.index("-canvas_size") < command.index("-i")
    assert command[command.index("-filter_complex") + 1] == (
        "[0:s:0]scale=1920:808:force_original_aspect_ratio=increase,crop=1920:808,showinfo=checksum=0[v]"
    )


def _showinfo(index: int, seconds: float, checksum: str, stdev: float) -> str:
    return (
        f"[Parsed_showinfo_0 @ 00] n:{index:4d} pts: {int(seconds * 1e6):9d} pts_time:{seconds} "
        f"duration: 0 duration_time:0 fmt:bgra s:1920x808 i:P iskey:0 type:? "
        f"checksum:{checksum} plane_checksum:[{checksum}] mean:[3] stdev:[{stdev}]\n"
    )


def test_blank_frames_are_the_ends_of_cues() -> None:
    """A cue's end is the moment its picture goes away — the next, empty frame."""
    frames = [
        _Frame(index=0, seconds=1.0, blank=False, checksum="AAAAAAAA"),
        _Frame(index=1, seconds=3.0, blank=True, checksum="00000000"),
        _Frame(index=2, seconds=4.5, blank=False, checksum="BBBBBBBB"),
        _Frame(index=3, seconds=7.0, blank=True, checksum="00000000"),
    ]
    # Only the drawn frames become cues, and each ends where the next frame begins.
    assert plan_cues(frames) == [(0, 1.0, 3.0), (2, 4.5, 7.0)]


def test_a_redrawn_picture_is_still_the_same_cue() -> None:
    """PGS clears and re-draws at the same instant, and re-sends before wiping.

    Read frame by frame that produced a cue overlapping the next by a millisecond
    and hundreds of cues too short to see. Grouped by what is on screen, it is one
    subtitle that stays up until something different arrives.
    """
    frames = [
        _Frame(index=0, seconds=49.165, blank=True, checksum="00000000"),     # clear, at the same instant as…
        _Frame(index=1, seconds=49.165, blank=False, checksum="79AD7E83"),    # …the picture that replaces it
        _Frame(index=2, seconds=51.584, blank=False, checksum="79AD7E83"),    # the very same picture, re-sent
        _Frame(index=3, seconds=51.585, blank=True, checksum="00000000"),     # and finally wiped
    ]
    assert plan_cues(frames) == [(1, 49.165, 51.585)]


def test_a_last_cue_with_no_blank_after_it_is_kept() -> None:
    """Some files simply stop; dropping that cue would lose a real line."""
    frames = [_Frame(index=0, seconds=10.0, blank=False, checksum="A")]
    assert plan_cues(frames) == [(0, 10.0, 14.0)]
    # And a cue that would run for an hour is clamped rather than believed.
    long_gap = [
        _Frame(index=0, seconds=0.0, blank=False, checksum="A"),
        _Frame(index=1, seconds=4000.0, blank=True, checksum="0"),
    ]
    assert plan_cues(long_gap) == [(0, 0.0, 30.0)]
    # A frame with nothing after it and nothing drawn is not a cue at all.
    assert plan_cues([_Frame(index=0, seconds=1.0, blank=True, checksum="0")]) == []
    # Nor is a flicker too short for anyone to read.
    flicker = [
        _Frame(index=0, seconds=1.0, blank=False, checksum="A"),
        _Frame(index=1, seconds=1.001, blank=True, checksum="0"),
    ]
    assert plan_cues(flicker) == []


def test_a_walk_record_from_before_this_render_version_is_walked_again(tmp_path: Path) -> None:
    """A "done" written before pictures were rendered must not hide them forever."""
    import json
    from types import SimpleNamespace

    from media_server import subtitle_jobs

    config = SimpleNamespace(stereo=SimpleNamespace(subtitle_cache_path=tmp_path))
    (tmp_path / "warm-state.json").write_text(
        json.dumps({"version": 1, "done": {"movies/Film.mkv": "10:20"}}), encoding="utf-8"
    )
    assert subtitle_jobs._load_state(config) == {}

    subtitle_jobs._save_state(config, {"movies/Film.mkv": "10:20"})
    assert subtitle_jobs._load_state(config) == {"movies/Film.mkv": "10:20"}
    # The record names the render it was made for, so the next bump re-walks too.
    saved = json.loads((tmp_path / "warm-state.json").read_text(encoding="utf-8"))
    assert subtitle_jobs._PICTURE_RENDER_VERSION in saved["version"]


# --- One read per film --------------------------------------------------------
#
# FFmpeg is stood in for at ``_run_ffmpeg``: the fake writes what FFmpeg would
# write (the copies, the PNGs) and prints what it would print (the closing packet
# counts, showinfo), so the pipeline around it runs for real.

import asyncio  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import struct  # noqa: E402
import time  # noqa: E402
import zlib  # noqa: E402
from types import SimpleNamespace  # noqa: E402

import pytest  # noqa: E402

from media_server import subtitle_jobs, subtitle_pictures  # noqa: E402
from media_server.stereo import StereoTranscodeError  # noqa: E402
from media_server.subtitle_pictures import (  # noqa: E402
    TrackRender,
    extract_command,
    extracted_frames_command,
    frame_times,
    identify_frames,
    picture_cache_dir,
    picture_render_version,
    png_is_blank,
    read_picture_manifest,
    render_film_pictures,
    render_subtitle_pictures,
    sweep_stale_work,
)


def _png(width: int, height: int, pixels: bytes, *, colour: int = 6) -> bytes:
    """A real PNG, the way FFmpeg's encoder writes one: 8-bit RGBA, no filter."""

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    stride = width * 4
    rows = b"".join(b"\x00" + pixels[row * stride : (row + 1) * stride] for row in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, colour, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def _picture(checksum: str) -> bytes:
    """The picture a fake frame shows: transparent for a clear, its checksum's bytes otherwise."""
    if set(checksum) == {"0"}:
        return _png(4, 2, bytes(32))
    return _png(4, 2, (checksum.encode("ascii") * 4)[:32])


def _cue(checksum: str, start: float = 1.0, end: float = 3.0) -> list[tuple[float, str, float]]:
    """What sub2video emits for one PGS cue: a clear, the picture, the re-sent picture, the wipe."""
    return [(start, "00000000", 0.0), (start, checksum, 14.7), (end, checksum, 14.7), (end, "00000000", 0.0)]


class _FakeFFmpeg:
    def __init__(
        self,
        frames: dict[int, list[tuple[float, str, float]]],
        *,
        packets: dict[int, int] | None = None,
        extraction_fails: bool = False,
        sup_refuses: bool = False,
        gate: asyncio.Event | None = None,
        authored: dict[int, tuple[int, int]] | None = None,
    ) -> None:
        self.frames = frames
        self.packets = packets or {}
        self.extraction_fails = extraction_fails
        # Raw .sup refusing a packet the way it did on a Blu-ray .m2ts.
        self.sup_refuses = sup_refuses
        # The size each copied track was drawn at, as `ffmpeg -i copy` reports it.
        self.authored = authored or {}
        self.gate = gate
        self.started = asyncio.Event() if gate is not None else None
        self.calls: list[tuple[str, list[str]]] = []

    async def __call__(self, command: list[str], *, timeout: float, background: bool, what: str) -> tuple[int, str]:
        self.calls.append((what, list(command)))
        if what == "Subtitle probe":
            inputs = [command[position + 1] for position, argument in enumerate(command) if argument == "-i"]
            lines = []
            for number, path in enumerate(inputs):
                size = self.authored.get(int(Path(path).stem))
                if size is not None:
                    lines.append(f"  Stream #{number}:0: Subtitle: hdmv_pgs_subtitle (pgssub), {size[0]}x{size[1]}")
            return 1, "\n".join(lines) + "\nAt least one output file must be specified\n"
        source = command[command.index("-i") + 1]
        if what == "Subtitle extraction":
            outputs = [position for position, argument in enumerate(command) if argument == "-f"]
            if self.extraction_fails or (self.sup_refuses and any(command[p + 1] == "sup" for p in outputs)):
                return 1, "[out#3/sup @ 0000] Error muxing a packet\n"
            lines = []
            for output, position in enumerate(outputs):
                muxer, target = command[position + 1], command[position + 2]
                if muxer == "null":
                    lines.append(f"[out#{output}/null @ 0000]   Total: 999 packets (1 bytes) muxed")
                    continue
                track = int(Path(target).stem)
                Path(target).write_bytes(b"copy")
                count = self.packets.get(track, 4)
                lines.append(f"[out#{output}/{muxer} @ 0000]   Total: {count} packets (10 bytes) muxed")
            return 0, "\n".join(lines) + "\n"
        graph = command[command.index("-filter_complex") + 1]
        if Path(source).parent.parent.name == "work":
            track = int(Path(source).stem)
        else:
            track = int(re.match(r"\[0:s:(\d+)\]", graph).group(1))
        if self.gate is not None:
            self.started.set()
            await self.gate.wait()
        directory = Path(command[-1]).parent
        stderr = ""
        for index, (seconds, checksum, stdev) in enumerate(self.frames[track]):
            (directory / f"{index + 1:06d}.png").write_bytes(_picture(checksum))
            stderr += _showinfo(index, seconds, checksum, stdev)
        return 0, stderr


def _media(tmp_path: Path, name: str) -> ResolvedItem:
    film = tmp_path / "media" / name
    film.parent.mkdir(parents=True, exist_ok=True)
    film.write_bytes(b"film")
    return _resolved(film)


def _pgs(*indices: int) -> list[dict]:
    return [{"index": index, "codec": "hdmv_pgs_subtitle", "image": True} for index in indices]


def _reads_of(item: ResolvedItem, fake: _FakeFFmpeg) -> list[str]:
    """Every FFmpeg run that opened the film itself, by what it was for."""
    return [what for what, command in fake.calls if command[command.index("-i") + 1] == str(item.path)]


def test_a_film_with_many_picture_tracks_is_read_once(tmp_path: Path, monkeypatch) -> None:
    """24.6 TB of reading for the library came from one full read of a film per track."""
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA"), 1: _cue("BBBBBBBB", 2.0, 5.5), 2: []}, packets={2: 0})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    results = asyncio.run(render_film_pictures(item, config, _pgs(0, 1, 2), (1920, 1080)))

    assert _reads_of(item, fake) == ["Subtitle extraction"], "the film was read more than once"
    extraction = fake.calls[0][1]
    maps = [extraction[position + 1] for position, argument in enumerate(extraction) if argument == "-map"]
    assert maps == ["0:s:0", "0:s:1", "0:s:2"]
    assert extraction.count("-output_ts_offset") == 3 and "null" not in extraction
    assert {index: result.state for index, result in results.items()} == {0: "rendered", 1: "rendered", 2: "empty"}
    drawn = [command for what, command in fake.calls if what == "Subtitle rendering"]
    # The slot without a single packet is empty without being drawn at all.
    assert len(drawn) == 2
    for command in drawn:
        assert "-copyts" in command and command[command.index("-itsoffset") + 1] == "-3600"
    assert read_picture_manifest(picture_cache_dir(item, config, 1))["cues"] == [
        {"start": 2.0, "end": 5.5, "frame": "000002"}
    ]
    # Only the picture a cue names is kept, and the copies do not outlive the pass.
    kept = sorted(path.name for path in picture_cache_dir(item, config, 0).iterdir())
    assert kept == ["000002.png", "manifest.json"]
    assert list((tmp_path / "cache" / "work").iterdir()) == []

    fake.calls.clear()
    again = asyncio.run(render_film_pictures(item, config, _pgs(0, 1), (1920, 1080)))
    assert {result.state for result in again.values()} == {"cached"} and fake.calls == []


def test_one_track_of_an_ordinary_file_is_drawn_straight_from_the_film(tmp_path: Path, monkeypatch) -> None:
    """One pass either way — and drawn while it is read, which a copy cannot be."""
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({3: _cue("CCCCCCCC")})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    manifest = asyncio.run(render_subtitle_pictures(item, config, 3, (1920, 1080), None, _pgs(3)[0]))

    assert manifest["cues"] == [{"start": 1.0, "end": 3.0, "frame": "000002"}]
    assert _reads_of(item, fake) == ["Subtitle rendering"]
    command = fake.calls[0][1]
    assert command[command.index("-filter_complex") + 1].startswith("[0:s:3]")
    assert "-copyts" not in command and "-nostats" in command


def test_a_transport_stream_is_copied_with_the_picture_setting_its_clock(tmp_path: Path, monkeypatch) -> None:
    """Decoded alone, a late-starting track of a .m2ts got its own zero — every cue early.

    With the picture copied along (into nothing) FFmpeg sets the zero from it, as
    it does for the compatibility stream. Such files render under their own key,
    so the early renders already on disk are not served again.
    """
    item = _media(tmp_path, "00141.m2ts")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA")})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    # Even a single track goes through the copy here.
    result = asyncio.run(render_film_pictures(item, config, _pgs(0), (1920, 1080)))[0]

    assert result.state == "rendered"
    extraction = fake.calls[0][1]
    anchor = extraction.index("0:v:0?")
    assert extraction[anchor - 1 : anchor + 6] == ["-map", "0:v:0?", "-c", "copy", "-f", "null", "-"]
    assert anchor < extraction.index("0:s:0")
    # A transport stream's PGS goes into a Blu-ray transport stream: raw .sup refuses packets
    # an .m2ts carries. With no mux delay the clock is the film's to the tick, and only Blu-ray
    # mode files PGS as PGS rather than as anonymous data.
    copy = extraction[extraction.index("0:s:0") :]
    assert copy[copy.index("-f") + 1] == "mpegts" and copy[copy.index("-f") + 2].endswith("0.m2ts")
    assert copy[copy.index("-muxdelay") + 1] == "0" and copy[copy.index("-muxpreload") + 1] == "0"
    assert copy[copy.index("-mpegts_m2ts_mode") + 1] == "1"
    assert picture_render_version(item) == "pictures-v3"
    assert picture_render_version(_media(tmp_path, "Film.mkv")) == "pictures-v2"

    # When the copy fails, the track drawn straight from the film is anchored on the picture
    # too — the fallback must not bring back the early cues the key says are gone.
    fallback = subtitle_pictures.subtitle_frames_command(item, config, 0, tmp_path / "out")
    assert fallback[-7:] == ["-map", "0:v:0?", "-c", "copy", "-f", "null", "-"]
    assert "0:v:0?" not in subtitle_pictures.subtitle_frames_command(
        _media(tmp_path, "Film.mkv"), config, 0, tmp_path / "out"
    )

    # The copied track is output 1 — output 0 is the picture — and its count is read there.
    empty = _media(tmp_path, "00142.m2ts")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA")}, packets={0: 0})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)
    assert asyncio.run(render_film_pictures(empty, config, _pgs(0), (1920, 1080)))[0].state == "empty"


def test_a_copy_that_fails_falls_back_to_a_pass_per_track(tmp_path: Path, monkeypatch) -> None:
    """Slower than one read, never worse than before — once the tolerant copy has failed too."""
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA"), 1: _cue("BBBBBBBB")}, extraction_fails=True)
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    results = asyncio.run(render_film_pictures(item, config, _pgs(0, 1), (1920, 1080)))

    assert {result.state for result in results.values()} == {"rendered"}
    assert _reads_of(item, fake) == [
        "Subtitle extraction", "Subtitle extraction", "Subtitle rendering", "Subtitle rendering"
    ]


def test_a_sup_that_refuses_a_packet_is_copied_again_as_a_transport_stream(tmp_path: Path, monkeypatch) -> None:
    """One cut-short PGS segment ended the copy of a 40 GB .m2ts, and every track read the film again."""
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA"), 1: _cue("BBBBBBBB", 2.0, 5.5)}, sup_refuses=True)
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    results = asyncio.run(render_film_pictures(item, config, _pgs(0, 1), (1920, 1080)))

    assert {index: result.state for index, result in results.items()} == {0: "rendered", 1: "rendered"}
    # Two reads of the film at most, and no track drawn straight from it.
    assert _reads_of(item, fake) == ["Subtitle extraction", "Subtitle extraction"]
    second = [command for what, command in fake.calls if what == "Subtitle extraction"][1]
    assert second.count("mpegts") == 2 and "sup" not in second
    drawn = [command[command.index("-i") + 1] for what, command in fake.calls if what == "Subtitle rendering"]
    assert sorted(Path(source).name for source in drawn) == ["0.m2ts", "1.m2ts"]
    assert read_picture_manifest(picture_cache_dir(item, config, 1))["cues"] == [
        {"start": 2.0, "end": 5.5, "frame": "000002"}
    ]


def test_what_cannot_be_copied_out_is_drawn_from_the_film(tmp_path: Path, monkeypatch) -> None:
    """XSUB has no file of its own to go into; a track with no known canvas needs the film's video."""
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA"), 1: _cue("BBBBBBBB"), 2: _cue("CCCCCCCC")})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)
    tracks = [*_pgs(0, 1), {"index": 2, "codec": "xsub", "image": True}]

    results = asyncio.run(render_film_pictures(item, config, tracks, (1920, 1080)))

    assert {result.state for result in results.values()} == {"rendered"}
    assert sorted(_reads_of(item, fake)) == ["Subtitle extraction", "Subtitle rendering"]
    extraction = next(command for what, command in fake.calls if what == "Subtitle extraction")
    assert "0:s:2" not in extraction


def test_a_viewer_waits_for_the_render_the_background_pass_is_already_doing(tmp_path: Path, monkeypatch) -> None:
    """Two renders of one track used to share one staging folder; one now waits for the other."""
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")

    async def scenario() -> tuple[dict, int]:
        fake = _FakeFFmpeg({0: _cue("AAAAAAAA"), 1: _cue("BBBBBBBB")}, gate=asyncio.Event())
        monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)
        background = asyncio.create_task(
            render_film_pictures(item, config, _pgs(0, 1), (1920, 1080), background=True)
        )
        await fake.started.wait()
        viewer = asyncio.create_task(
            render_subtitle_pictures(item, config, 0, (1920, 1080), asyncio.Semaphore(1), _pgs(0)[0])
        )
        await asyncio.sleep(0.05)
        assert not viewer.done()
        fake.gate.set()
        manifest = await viewer
        await background
        return manifest, len(fake.calls)

    manifest, runs = asyncio.run(scenario())
    assert manifest["cues"] == [{"start": 1.0, "end": 3.0, "frame": "000002"}]
    assert runs == 3, "the viewer started an FFmpeg of its own"


def test_the_copy_and_the_drawing_agree_on_the_offset(tmp_path: Path) -> None:
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg")
    copy = extract_command(item, config, [(4, "sup", tmp_path / "4.sup")])
    drawing = extracted_frames_command(config, tmp_path / "4.sup", tmp_path / "out", (1920, 808), canvas=(1920, 1080))
    assert copy[copy.index("-output_ts_offset") + 1] == "3600"
    assert drawing[drawing.index("-itsoffset") + 1] == "-3600"
    assert drawing.index("-copyts") < drawing.index("-i") and drawing.index("-canvas_size") < drawing.index("-i")
    assert drawing[drawing.index("-filter_complex") + 1] == (
        "[0:s:0]scale=1920:808:force_original_aspect_ratio=increase,crop=1920:808,showinfo=checksum=0[v]"
    )


def test_the_background_pass_draws_the_same_pixels_on_less_cpu(tmp_path: Path, monkeypatch) -> None:
    """Measured on a 4K and a letterboxed 1080p track: identical decoded RGBA, 2x and 3.8x less CPU.

    A UHD disc's 1080p PGS is upscaled to 3840x2160 by swscale, which spent 163 ms of
    CPU per frame on ten threads; one thread does the same arithmetic for less than
    half. PNG row prediction (paeth) cost a quarter of the rest and only made the
    lossless files bigger.
    """
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    for build in (
        lambda **kw: extracted_frames_command(config, tmp_path / "4.sup", tmp_path / "out", (3840, 2160), **kw),
        lambda **kw: subtitle_pictures.subtitle_frames_command(item, config, 4, tmp_path / "out", (3840, 2160), **kw),
    ):
        background, viewer = build(background=True), build()
        assert "force_original_aspect_ratio=increase:threads=1," in background[background.index("-filter_complex") + 1]
        assert "threads" not in viewer[viewer.index("-filter_complex") + 1]
        for command in (background, viewer):
            # Lossless whatever the setting: only the bytes change, never a pixel.
            assert command[command.index("-pred") + 1] == "none" and command.index("-pred") < command.index("image2")

    # The background pass hands its flag down to every drawing it starts.
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA"), 1: _cue("BBBBBBBB")})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)
    asyncio.run(render_film_pictures(item, config, _pgs(0, 1), (1920, 1080), background=True))
    drawn = [command for what, command in fake.calls if what == "Subtitle rendering"]
    assert len(drawn) == 2 and all(":threads=1," in command[command.index("-filter_complex") + 1] for command in drawn)


def test_copies_left_by_a_killed_process_are_swept_and_fresh_ones_kept(tmp_path: Path) -> None:
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path)
    old = tmp_path / "work" / "123-old"
    fresh = tmp_path / "work" / "456-fresh"
    old.mkdir(parents=True)
    fresh.mkdir()
    (old / "0.sup").write_bytes(b"x")
    stale = time.time() - 7 * 3600
    os.utime(old, (stale, stale))
    assert sweep_stale_work(config) == 1
    assert not old.exists() and fresh.exists()


def _warm_config(tmp_path: Path) -> SimpleNamespace:
    return SimpleNamespace(stereo=SimpleNamespace(subtitle_cache_path=tmp_path))


def test_one_track_that_renders_nothing_does_not_end_the_film(tmp_path: Path, monkeypatch) -> None:
    """An empty slot early in a Blu-ray remux used to leave every later track unrendered."""
    films = {name: _media(tmp_path, name) for name in ("A.mkv", "B.mkv", "C.mkv")}
    infos = {
        "A.mkv": {"duration_seconds": 10.0, "video_codec": "h264", "subtitle_tracks": [
            {"index": 0, "image": True}, {"index": 1, "image": True}, {"index": 2, "supported": True}]},
        "B.mkv": {"duration_seconds": 10.0, "video_codec": "h264", "subtitle_tracks": [{"index": 0, "image": True}]},
        # The probe failed: nothing embedded is known, so nothing may be called done.
        "C.mkv": {"duration_seconds": None, "video_codec": None, "subtitle_tracks": []},
    }
    problems = {"C.mkv": "FFmpeg did not describe the file within 60 s"}
    rendered: list[tuple[str, int]] = []
    saved: list[dict] = []

    async def render(item, _config, tracks, _size, **_kwargs):
        results = {}
        for track in tracks:
            index = int(track["index"])
            if (item.path.name, index) == ("A.mkv", 0):
                results[index] = TrackRender("empty", error="Subtitle track produced no pictures to show")
            elif item.path.name == "B.mkv":
                results[index] = TrackRender("failed", error="Subtitle rendering failed")
            else:
                rendered.append((item.path.name, index))
                results[index] = TrackRender("rendered", {"cues": []})
        return results

    async def probe(item, _config):
        return infos[item.path.name], problems.get(item.path.name)

    async def text(_item, _config, tracks, _semaphore, **_kwargs):
        return {track: ("generated", None) for track in tracks}

    monkeypatch.setattr(subtitle_jobs, "_catalog_videos", lambda *_args: [("movies", name) for name in films])
    monkeypatch.setattr(subtitle_jobs, "_resolved", lambda _config, _root, name: films[name])
    monkeypatch.setattr(subtitle_jobs, "_load_state", lambda _config: {})
    monkeypatch.setattr(subtitle_jobs, "_save_state", lambda _config, done: saved.append(dict(done)))
    monkeypatch.setattr(subtitle_jobs, "probe_media_info_patiently", probe)
    monkeypatch.setattr(subtitle_jobs, "render_film_pictures", render)
    monkeypatch.setattr(subtitle_jobs, "extract_film_webvtt", text)

    status: dict = {}
    asyncio.run(subtitle_jobs.warm_subtitle_cache(
        _warm_config(tmp_path), status, asyncio.Semaphore(1), root_slug=None, item_ids=[], refresh=False
    ))

    assert rendered == [("A.mkv", 1)], "the track after the empty one was never rendered"
    assert status["empty_tracks"] == 1 and status["picture_tracks"] == 1
    # B's track, and C's probe — which used to pass for a film with nothing in it.
    assert status["errors"] == 2
    assert sorted((failure["path"], failure["state"]) for failure in status["recent_failures"]) == [
        ("movies/B.mkv", "failed"), ("movies/C.mkv", "probe_failed")
    ]
    assert status["generated_tracks"] == 2  # A's picture track 1 and its text track 2
    # A went all the way through; B is tried again next run; C's probe found nothing.
    assert list(saved[-1]) == ["movies/A.mkv"]
    # What the panel reads is all still there.
    assert status["state"] == "completed" and status["finished"] is True and status["current_file"] == ""
    assert status["processed_files"] == status["total_files"] == 3 and status["skipped_files"] == 0


def test_every_failure_of_a_run_is_logged_with_its_film_track_and_reason(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """The first full run counted 48 errors and said nothing about any of them.

    One line per failed film or track — the film relative to its root, the track,
    its codec, what became of it and why — and the latest few in the status.
    """
    films = {name: _media(tmp_path, name) for name in ("Gone.mkv", "Mute.mkv", "Text.mkv", "Pgs.mkv", "Bug.mkv")}

    def resolved(_config, _root, name):
        return None if name == "Gone.mkv" else films[name]

    async def probe(item, _config):
        name = item.path.name
        if name == "Mute.mkv":
            nothing = {"duration_seconds": None, "video_codec": None, "subtitle_tracks": []}
            return nothing, "FFmpeg did not describe the file within 60 s"
        if name == "Bug.mkv":
            raise RuntimeError("something nobody expected")
        tracks = [{"index": 0, "codec": "subrip", "supported": True}] if name == "Text.mkv" else _pgs(0, 1)
        return {"duration_seconds": 10.0, "video_codec": "h264", "subtitle_tracks": tracks}, None

    async def text(_item, _config, tracks, _semaphore, **_kwargs):
        reason = "Subtitle conversion failed: Decode error rate 0.8 exceeds maximum 0.67"
        return {track: ("failed", reason) for track in tracks}

    async def render(_item, _config, tracks, _size, **_kwargs):
        return {
            0: TrackRender("rendered", {"cues": []}),
            1: TrackRender("failed", error="Subtitle rendering failed"),
        }

    monkeypatch.setattr(subtitle_jobs, "_catalog_videos", lambda *_args: [("movies", f"Dir/{name}") for name in films])
    monkeypatch.setattr(subtitle_jobs, "_resolved", lambda config, root, relative: resolved(config, root, relative[4:]))
    monkeypatch.setattr(subtitle_jobs, "_load_state", lambda _config: {})
    monkeypatch.setattr(subtitle_jobs, "_save_state", lambda _config, done: None)
    monkeypatch.setattr(subtitle_jobs, "probe_media_info_patiently", probe)
    monkeypatch.setattr(subtitle_jobs, "extract_film_webvtt", text)
    monkeypatch.setattr(subtitle_jobs, "render_film_pictures", render)
    monkeypatch.setattr(subtitle_jobs, "_RECENT_FAILURES", 3)

    status: dict = {}
    with caplog.at_level("WARNING", logger="media_server.subtitle_jobs"):
        asyncio.run(subtitle_jobs.warm_subtitle_cache(
            _warm_config(tmp_path), status, asyncio.Semaphore(1), root_slug=None, item_ids=[], refresh=False
        ))

    lines = {
        (record.path, record.track): (record.root, record.codec, record.state, record.reason)
        for record in caplog.records if getattr(record, "event", None) == "subtitle_cache_failure"
    }
    assert lines == {
        ("Dir/Gone.mkv", None): ("movies", None, "missing", "not on disk at its catalogued path"),
        ("Dir/Mute.mkv", None): ("movies", None, "probe_failed", "FFmpeg did not describe the file within 60 s"),
        ("Dir/Text.mkv", 0): (
            "movies", "subrip", "failed", "Subtitle conversion failed: Decode error rate 0.8 exceeds maximum 0.67"
        ),
        ("Dir/Pgs.mkv", 1): ("movies", "hdmv_pgs_subtitle", "failed", "Subtitle rendering failed"),
        ("Dir/Bug.mkv", None): ("movies", None, "error", "RuntimeError: something nobody expected"),
    }
    # The one nobody expected carries its traceback.
    assert [record.exc_info is not None for record in caplog.records if record.path == "Dir/Bug.mkv"] == [True]
    assert status["errors"] == 5 and status["picture_tracks"] == 1
    # Only the latest few stay in the status, in the order they happened.
    assert len(status["recent_failures"]) == 3
    assert status["recent_failures"][-1] in [
        {"path": "movies/Dir/Bug.mkv", "track": None, "codec": None, "state": "error",
         "reason": "RuntimeError: something nobody expected"},
        {"path": "movies/Dir/Pgs.mkv", "track": 1, "codec": "hdmv_pgs_subtitle", "state": "failed",
         "reason": "Subtitle rendering failed"},
    ]


def test_the_next_film_is_read_while_the_one_before_is_drawn(tmp_path: Path, monkeypatch) -> None:
    """Reading is the disk and drawing is the CPU; one film each, at the same time."""
    films = {name: _media(tmp_path, name) for name in ("A.mkv", "B.mkv")}
    started: list[str] = []

    async def scenario() -> None:
        release = asyncio.Event()

        async def render(item, _config, _tracks, _size, **_kwargs):
            started.append(item.path.name)
            if item.path.name == "A.mkv":
                await release.wait()
            return {0: TrackRender("rendered", {"cues": []})}

        async def probe(_item, _config):
            info = {"duration_seconds": 1.0, "video_codec": "h264", "subtitle_tracks": [{"index": 0, "image": True}]}
            return info, None

        monkeypatch.setattr(subtitle_jobs, "_catalog_videos", lambda *_args: [("movies", name) for name in films])
        monkeypatch.setattr(subtitle_jobs, "_resolved", lambda _config, _root, name: films[name])
        monkeypatch.setattr(subtitle_jobs, "_load_state", lambda _config: {})
        monkeypatch.setattr(subtitle_jobs, "_save_state", lambda _config, done: None)
        monkeypatch.setattr(subtitle_jobs, "probe_media_info_patiently", probe)
        monkeypatch.setattr(subtitle_jobs, "render_film_pictures", render)
        status: dict = {}
        job = asyncio.create_task(subtitle_jobs.warm_subtitle_cache(
            _warm_config(tmp_path), status, asyncio.Semaphore(1), root_slug=None, item_ids=[], refresh=False
        ))
        for _ in range(200):
            if sorted(started) == ["A.mkv", "B.mkv"]:
                break
            await asyncio.sleep(0.01)
        # A is still being drawn (it waits for the release), and B is already going.
        assert sorted(started) == ["A.mkv", "B.mkv"], "B waited for A to be drawn"
        release.set()
        await job
        assert status["picture_tracks"] == 2

    asyncio.run(scenario())


@pytest.mark.parametrize("suffix", [".m2ts", ".ts", ".mts", ".vob", ".mpg"])
def test_transport_and_program_streams_are_keyed_apart(tmp_path: Path, suffix: str) -> None:
    item = _media(tmp_path, f"Film{suffix}")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    assert picture_render_version(item) == "pictures-v3"
    assert picture_cache_dir(item, config, 0) != picture_cache_dir(
        _media(tmp_path, "Film.mkv"), config, 0
    )
    # Films already recorded as done under the old key are walked again.
    assert subtitle_jobs._STATE_VERSION.startswith("3/")


def test_what_a_frame_shows_is_read_from_its_picture(tmp_path: Path) -> None:
    """showinfo's checksum and deviation took 70 % of a render; the files say the same.

    Equal bytes are the same picture — the re-sent one merges into its cue — and
    the transparent one is the blank that ends it.
    """
    for index, checksum in enumerate(["00000000", "AAAAAAAA", "AAAAAAAA", "00000000", "BBBBBBBB", "00000000"]):
        (tmp_path / f"{index + 1:06d}.png").write_bytes(_picture(checksum))
    stderr = "".join(
        _showinfo(index, seconds, "ignored", 1.0)
        for index, seconds in enumerate([1.0, 1.0, 2.9, 3.0, 4.0, 6.5])
    )

    frames = identify_frames(tmp_path, frame_times(stderr))

    assert [frame.blank for frame in frames] == [True, False, False, True, False, True]
    assert frames[1].checksum == frames[2].checksum != frames[4].checksum
    assert plan_cues(frames) == [(1, 1.0, 3.0), (4, 4.0, 6.5)]


def test_a_blank_picture_is_one_with_every_pixel_zero(tmp_path: Path) -> None:
    blank, drawn, other = tmp_path / "blank.png", tmp_path / "drawn.png", tmp_path / "palette.png"
    blank.write_bytes(_png(3, 3, bytes(36)))
    pixels = bytearray(36)
    pixels[35] = 1  # one byte of alpha in the last pixel is enough to be seen
    drawn.write_bytes(_png(3, 3, bytes(pixels)))
    other.write_bytes(_png(3, 3, bytes(36), colour=3))
    assert png_is_blank(blank) is True
    assert png_is_blank(drawn) is False
    # Not what the encoder is handed: refused, not guessed at.
    with pytest.raises(StereoTranscodeError):
        png_is_blank(other)


def test_a_frame_without_its_picture_fails_the_track(tmp_path: Path) -> None:
    (tmp_path / "000001.png").write_bytes(_picture("AAAAAAAA"))
    with pytest.raises(StereoTranscodeError):
        identify_frames(tmp_path, [(0, 1.0), (1, 2.0)])


def test_a_track_drawn_smaller_than_the_film_is_stored_at_its_own_size() -> None:
    """A UHD disc's PGS is 1920x1080; cut to the film's shape at that size, never upscaled."""
    native = subtitle_pictures.native_picture_size
    assert native((3840, 2160), (1920, 1080)) == (1920, 1080)
    # A 2.40:1 4K film keeps the middle of the authored frame, as the cover and crop did at full size.
    assert native((3840, 1600), (1920, 1080)) == (1920, 800)
    # The film's size or larger is stored as it always was.
    assert native((1920, 1080), (1920, 1080)) is None
    assert native((1280, 720), (1920, 1080)) is None
    assert native((3840, 2160), None) is None and native(None, (1920, 1080)) is None
    assert subtitle_pictures.native_filter((1920, 800), background=True) == "crop=1920:800,scale=threads=1,"


def test_the_authored_size_is_read_from_every_copy_in_one_ffmpeg(tmp_path: Path, monkeypatch) -> None:
    config = StereoConfig(ffmpeg_path="ffmpeg")
    stderr = (
        "Input #0, sup, from '0.sup':\n  Stream #0:0: Subtitle: hdmv_pgs_subtitle (pgssub), 1920x1080, start 3673.19\n"
        "Input #1, mpegts, from '3.m2ts':\n  Stream #1:0[0x1200]: Subtitle: hdmv_pgs_subtitle (pgssub)"
        " ([144][0][0][0] / 0x0090), 3840x2160, start 3602.41\n"
        "Input #2, sup, from '5.sup':\n  Stream #2:0: Subtitle: hdmv_pgs_subtitle (pgssub)\n"
    )
    calls = []

    async def run(command, *, timeout, background, what):
        calls.append(command)
        return 1, stderr

    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", run)
    copies = {0: (tmp_path / "0.sup", 7), 3: (tmp_path / "3.m2ts", 4), 5: (tmp_path / "5.sup", 2), 6: (tmp_path / "6.sup", 0)}
    sizes = asyncio.run(subtitle_pictures._authored_sizes(config, copies, background=True))

    # A size FFmpeg does not report is not guessed, and an empty copy is not even opened.
    assert sizes == {0: (1920, 1080), 3: (3840, 2160)}
    assert len(calls) == 1 and calls[0].count("-i") == 3


def test_a_4k_film_with_1080p_pgs_is_rendered_native_and_scaled_by_the_player(tmp_path: Path, monkeypatch) -> None:
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA", 2.0, 5.5)}, authored={0: (1920, 1080)})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    # One track of an ordinary file, yet copied: the copy is where its size can be read.
    result = asyncio.run(render_film_pictures(item, config, _pgs(0), (3840, 1600), background=True))[0]

    assert [what for what, _ in fake.calls] == ["Subtitle extraction", "Subtitle probe", "Subtitle rendering"]
    drawing = fake.calls[-1][1]
    assert drawing[drawing.index("-canvas_size") + 1] == "1920x1080"
    assert drawing[drawing.index("-filter_complex") + 1] == "[0:s:0]crop=1920:800,scale=threads=1,showinfo=checksum=0[v]"
    # Cue times and the picture choice are exactly what they were; only the size and the key changed.
    assert result.manifest == {"width": 1920, "height": 800, "scale": 2.0, "cues": [
        {"start": 2.0, "end": 5.5, "frame": "000002"}
    ]}
    native = picture_cache_dir(item, config, 0, native=True)
    assert subtitle_pictures.find_picture_track(item, config, 0) == (native, result.manifest)
    assert read_picture_manifest(picture_cache_dir(item, config, 0)) is None


def test_an_upscaled_4k_track_already_rendered_is_still_served(tmp_path: Path, monkeypatch) -> None:
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    legacy = picture_cache_dir(item, config, 0)
    legacy.mkdir(parents=True)
    old = {"width": 3840, "height": 2160, "cues": [{"start": 1.0, "end": 3.0, "frame": "000002"}]}
    (legacy / "manifest.json").write_text(json.dumps(old), encoding="utf-8")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA")}, authored={0: (1920, 1080)})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    result = asyncio.run(render_film_pictures(item, config, _pgs(0), (3840, 2160)))[0]

    assert result.state == "cached" and result.manifest == old and fake.calls == []
    assert subtitle_pictures.find_picture_track(item, config, 0) == (legacy, old)


def test_pgs_drawn_at_the_films_own_4k_size_is_stored_as_before(tmp_path: Path, monkeypatch) -> None:
    item = _media(tmp_path, "Film.mkv")
    config = StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=tmp_path / "cache")
    fake = _FakeFFmpeg({0: _cue("AAAAAAAA")}, authored={0: (3840, 2160)})
    monkeypatch.setattr(subtitle_pictures, "_run_ffmpeg", fake)

    result = asyncio.run(render_film_pictures(item, config, _pgs(0), (3840, 2160)))[0]

    drawing = fake.calls[-1][1]
    assert "scale=3840:2160:force_original_aspect_ratio=increase" in drawing[drawing.index("-filter_complex") + 1]
    assert result.manifest["width"] == 3840 and "scale" not in result.manifest
    assert read_picture_manifest(picture_cache_dir(item, config, 0)) == result.manifest
