from __future__ import annotations

from pathlib import Path

from media_server.config import StereoConfig
from media_server.paths import ResolvedItem
from media_server.subtitle_pictures import (
    _Frame,
    parse_frames,
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
    assert command[command.index("-filter_complex") + 1] == "[0:s:2]showinfo[v]"
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
        "[0:s:0]scale=1920:808:force_original_aspect_ratio=increase,crop=1920:808,showinfo[v]"
    )


def _showinfo(index: int, seconds: float, checksum: str, stdev: float) -> str:
    return (
        f"[Parsed_showinfo_0 @ 00] n:{index:4d} pts: {int(seconds * 1e6):9d} pts_time:{seconds} "
        f"duration: 0 duration_time:0 fmt:bgra s:1920x808 i:P iskey:0 type:? "
        f"checksum:{checksum} plane_checksum:[{checksum}] mean:[3] stdev:[{stdev}]\n"
    )


def test_blank_frames_are_the_ends_of_cues() -> None:
    """A cue's end is the moment its picture goes away — the next, empty frame."""
    stderr = (
        _showinfo(0, 1.0, "AAAAAAAA", 14.7)
        + _showinfo(1, 3.0, "00000000", 0.0)
        + _showinfo(2, 4.5, "BBBBBBBB", 19.2)
        + _showinfo(3, 7.0, "00000000", 0.0)
    )
    frames = parse_frames(stderr)
    assert [(frame.index, frame.seconds, frame.blank, frame.checksum) for frame in frames] == [
        (0, 1.0, False, "AAAAAAAA"), (1, 3.0, True, "00000000"),
        (2, 4.5, False, "BBBBBBBB"), (3, 7.0, True, "00000000"),
    ]
    # Only the drawn frames become cues, and each ends where the next frame begins.
    assert plan_cues(frames) == [(0, 1.0, 3.0), (2, 4.5, 7.0)]


def test_a_redrawn_picture_is_still_the_same_cue() -> None:
    """PGS clears and re-draws at the same instant, and re-sends before wiping.

    Read frame by frame that produced a cue overlapping the next by a millisecond
    and hundreds of cues too short to see. Grouped by what is on screen, it is one
    subtitle that stays up until something different arrives.
    """
    stderr = (
        _showinfo(0, 49.165, "00000000", 0.0)      # clear, at the same instant as…
        + _showinfo(1, 49.165, "79AD7E83", 21.7)   # …the picture that replaces it
        + _showinfo(2, 51.584, "79AD7E83", 21.7)   # the very same picture, re-sent
        + _showinfo(3, 51.585, "00000000", 0.0)    # and finally wiped
    )
    assert plan_cues(parse_frames(stderr)) == [(1, 49.165, 51.585)]


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
