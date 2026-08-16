"""Subtitles that are pictures: PGS (Blu-ray) and VobSub (DVD).

These formats hold no text at all — they hold bitmaps of text, so the honest
thing to do with them is to show the bitmap. The browser lays each one over the
video at the right moment: exact, needs nothing installed, and it cannot mis-read
a letter.

Reading them instead, with OCR, was built and then removed. Not because it did
not work, but because it answers a worse question. A disc author moves a line to
the top of the frame when the bottom is busy — Die Hard does it under its opening
credits — and text alone loses that, landing back over the credits it was moved
away from. The picture carries the decision along with the words.

The pipeline is one FFmpeg pass:

  1. FFmpeg decodes the subtitle stream into a filtergraph. A bitmap subtitle
     becomes a video frame there, and with ``-fps_mode passthrough`` exactly one
     frame is emitted per subtitle event — not one per frame of film. A cue that
     appears produces a picture; the moment it disappears produces a blank one,
     which is how the end of each cue is known.
  2. The canvas is stated rather than guessed (see ``subtitle_canvas``) and then
     mapped onto the picture's own size. Doing it here rather than in the browser
     means the image the browser receives is always exactly the size of the video
     frame, and laying one over the other needs no arithmetic at all.
  3. ``showinfo`` prints each frame's timestamp, checksum and standard deviation.
     A blank frame has a deviation of exactly zero, so the ends of cues are found
     without opening a single image, and frames sharing a checksum are one cue
     that the format merely re-drew.

Deliberately **not** a parser for the .sup and VobSub formats. FFmpeg already
decodes both — and DVB subtitles, and anything it learns next — so the work here
is the same for every one of them, and there is no second RLE decoder to get
subtly wrong.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import StereoConfig
from .paths import ResolvedItem
from .stereo import StereoTranscodeError

_SHOWINFO = re.compile(
    r"n:\s*(?P<n>\d+)\s+pts:\s*\S+\s+pts_time:(?P<time>[0-9.]+)"
    r".*?\schecksum:(?P<checksum>[0-9A-Fa-f]+).*?stdev:\[(?P<stdev>[0-9.]+)"
)
# Below this a cue is an artefact of how the format re-draws itself, not
# something anybody could read.
_MIN_CUE_SECONDS = 0.05
# Bumped when a render changes shape, so stale output is not served forever.
_PICTURE_RENDER_VERSION = "pictures-v2"
# A film has on the order of a thousand cues. Ten thousand means something other
# than a subtitle track was handed to us, and grinding it would take hours.
_MAX_CUES = 10000
_MAX_CUE_SECONDS = 30.0


@dataclass(frozen=True, slots=True)
class _Frame:
    index: int
    seconds: float
    blank: bool
    # FFmpeg's own checksum of the picture. Two frames carrying the same one are
    # the same picture, which is how a re-drawn subtitle is recognised as still
    # being the subtitle that is already on screen.
    checksum: str = ""


def subtitle_canvas(track: dict[str, Any], video_size: tuple[int, int] | None) -> tuple[int, int] | None:
    """The frame a picture subtitle was drawn for, which is not the film's frame.

    A disc subtitle is authored against the disc's full 16:9 frame. A rip of a
    2.35:1 film keeps only the middle of that frame — 1920x808 out of 1920x1080 —
    but the subtitle still carries its original coordinates.

    Left to itself FFmpeg builds the canvas from whatever it knows when the
    filtergraph is wired up, which for PGS is usually the *video* size. A line
    placed at y=900 then falls off the bottom of an 808-tall canvas and arrives
    with its words sliced in half. Worse, it is not even consistent: the same
    track rendered from a different starting point came out 1080 tall, because by
    then the decoder had learned the real size. Measured on Die Hard: 808 from
    the start of the film, 1080 from fifty minutes in.

    So the canvas is stated rather than left to chance. VobSub declares its own
    size and that is used; PGS declares none, so the 16:9 frame for this width is
    restored — never smaller than the picture itself, which keeps an ordinary
    16:9 or 4:3 file exactly as it was.
    """
    declared = track.get("canvas_width"), track.get("canvas_height")
    if declared[0] and declared[1]:
        return int(declared[0]), int(declared[1])
    if video_size is None:
        return None
    width, height = video_size
    return width, max(height, round(width * 9 / 16))


def canvas_filter(video_size: tuple[int, int] | None) -> str:
    """Map the subtitle's own canvas onto the picture, without distorting it.

    A PGS track usually already carries the film's dimensions and this is a no-op.
    A VobSub track carries the whole 1920x1080 frame even when the film was cropped
    to 1920x808, and stretching that to fit would squash every letter by a quarter.
    Scaling to *cover* and cropping the middle keeps the shapes and drops exactly
    what the film itself dropped: the letterbox bars.
    """
    if video_size is None:
        return ""
    width, height = video_size
    return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},"


def subtitle_frames_command(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    directory: Path,
    video_size: tuple[int, int] | None = None,
    *,
    canvas: tuple[int, int] | None = None,
) -> list[str]:
    """Render every cue of one bitmap subtitle track as an image.

    ``canvas`` states the frame the subtitle was drawn for, which FFmpeg would
    otherwise guess — and guess differently depending on where it started.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    shape = canvas_filter(video_size)
    return [
        config.ffmpeg_path,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "info",
        "-y",
        # Before -i: it tells the decoder how big the subtitle's own frame is.
        *(["-canvas_size", f"{canvas[0]}x{canvas[1]}"] if canvas is not None else []),
        "-i",
        str(item.path),
        "-filter_complex",
        f"[0:s:{subtitle_track}]{shape}showinfo[v]",
        "-map",
        "[v]",
        # One image per subtitle event. Without this FFmpeg invents a frame rate
        # and writes one picture per frame of film — 145,000 of them for a
        # ninety-minute film, all but a thousand of them blank.
        "-fps_mode",
        "passthrough",
        "-f",
        "image2",
        str(directory / "%06d.png"),
    ]


def parse_frames(stderr: str) -> list[_Frame]:
    """Turn showinfo's output into one entry per emitted image, in order.

    The numbering is FFmpeg's own frame counter, and image2 writes files from 1
    in the same order, so index n corresponds to file n+1. A blank frame is one
    whose pixels do not vary at all — a fully transparent rectangle — and means
    "the previous cue ends here".
    """
    frames: list[_Frame] = []
    for match in _SHOWINFO.finditer(stderr):
        frames.append(
            _Frame(
                index=int(match.group("n")),
                seconds=float(match.group("time")),
                blank=float(match.group("stdev")) == 0.0,
                checksum=match.group("checksum").upper(),
            )
        )
    frames.sort(key=lambda frame: frame.index)
    return frames


def plan_cues(frames: list[_Frame]) -> list[tuple[int, float, float]]:
    """Turn the stream of frames into cues: which picture, from when, until when.

    Frames are grouped by what they show rather than counted, because the formats
    re-draw. A PGS track emits a clear and its replacement **at the same
    timestamp**, and then re-sends the very same picture again just before wiping
    it. Treating each frame as a cue produced pairs that overlapped by a
    millisecond and hundreds of cues nobody could see. Consecutive frames sharing
    FFmpeg's checksum are one picture, and it stays up until something different
    arrives — which is what the viewer's eye sees anyway.

    The last cue of a film has no clear after it in some files, so it is given a
    sensible length rather than being dropped: a subtitle nobody can read for the
    right number of seconds is better than a missing one.
    """
    planned: list[tuple[int, float, float]] = []
    position = 0
    while position < len(frames):
        frame = frames[position]
        run_end = position + 1
        while run_end < len(frames) and frames[run_end].checksum == frame.checksum:
            run_end += 1
        if not frame.blank:
            end = frames[run_end].seconds if run_end < len(frames) else frame.seconds + 4.0
            end = min(end, frame.seconds + _MAX_CUE_SECONDS)
            if end - frame.seconds >= _MIN_CUE_SECONDS:
                planned.append((frame.index, frame.seconds, end))
        position = run_end
    return planned

def picture_cache_dir(item: ResolvedItem, config: StereoConfig, subtitle_track: int) -> Path | None:
    """Where one track's rendered cues live; keyed like the WebVTT cache.

    The render version is part of the key. Without it a fix to how a track is
    drawn would never reach anybody who already has the broken version on disk —
    which is exactly what happened when the canvas was wrong.
    """
    if config.subtitle_cache_path is None:
        return None
    identity = "\0".join(
        [_PICTURE_RENDER_VERSION, str(item.path), str(item.mtime_ns), str(item.size), str(subtitle_track)]
    ).encode("utf-8", errors="surrogatepass")
    return config.subtitle_cache_path / "pictures" / hashlib.sha256(identity).hexdigest()


def read_picture_manifest(directory: Path | None) -> dict[str, Any] | None:
    """The finished manifest, or None while a render is unfinished or absent.

    Written last and atomically, so its presence is the signal that every image
    it names is on disk — a half-rendered track is simply not there yet.
    """
    if directory is None:
        return None
    try:
        payload = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) and isinstance(payload.get("cues"), list) else None


async def render_subtitle_pictures(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    video_size: tuple[int, int] | None,
    semaphore: asyncio.Semaphore | None = None,
    track: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render one bitmap track to a directory of cues plus a manifest.

    Blank frames are deleted once their timestamps have been read: they exist to
    say when a cue ends, and keeping a thousand transparent rectangles on disk
    would double the cache for nothing.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    directory = picture_cache_dir(item, config, subtitle_track)
    if directory is None:
        raise StereoTranscodeError("Subtitle cache is not configured")
    existing = read_picture_manifest(directory)
    if existing is not None:
        return existing
    acquired = False
    staging = Path(f"{directory}.partial")
    try:
        if semaphore is not None:
            await semaphore.acquire()
            acquired = True
        await asyncio.to_thread(shutil.rmtree, staging, True)
        await asyncio.to_thread(staging.mkdir, parents=True, exist_ok=True)
        canvas = subtitle_canvas(track or {}, video_size)
        frames = await _render_frames(item, config, subtitle_track, staging, video_size, canvas=canvas)
        planned = plan_cues(frames)
        if not planned:
            raise StereoTranscodeError("Subtitle track produced no pictures to show")
        if len(planned) > _MAX_CUES:
            raise StereoTranscodeError("Subtitle track has implausibly many cues")
        wanted = {index for index, _, _ in planned}
        cues: list[dict[str, Any]] = []
        for index, start, end in planned:
            cues.append({"start": round(start, 3), "end": round(end, 3), "frame": f"{index + 1:06d}"})

        def finish() -> None:
            for image in staging.glob("*.png"):
                if int(image.stem) - 1 not in wanted:
                    image.unlink(missing_ok=True)
            manifest = {
                "width": video_size[0] if video_size else None,
                "height": video_size[1] if video_size else None,
                "cues": cues,
            }
            (staging / "manifest.json").write_text(
                json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
            )
            shutil.rmtree(directory, ignore_errors=True)
            staging.replace(directory)

        # Moved into place only once every image is written and the blanks are
        # gone, so a reader either sees a complete track or sees nothing.
        await asyncio.to_thread(finish)
        return read_picture_manifest(directory) or {"cues": cues}
    except BaseException:
        await asyncio.to_thread(shutil.rmtree, staging, True)
        raise
    finally:
        if acquired and semaphore is not None:
            semaphore.release()


def picture_frame_file(directory: Path | None, manifest: dict[str, Any], frame: str) -> Path | None:
    """One cue's image, and only if the manifest itself named it.

    The frame is checked against the manifest rather than sanitised, so the only
    files this can ever serve are the ones the server itself just rendered.
    """
    if directory is None:
        return None
    if not any(str(cue.get("frame")) == frame for cue in manifest.get("cues", [])):
        return None
    candidate = directory / f"{frame}.png"
    return candidate if candidate.is_file() else None


async def _render_frames(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    directory: Path,
    video_size: tuple[int, int] | None = None,
    *,
    canvas: tuple[int, int] | None = None,
) -> list[_Frame]:
    command = subtitle_frames_command(item, config, subtitle_track, directory, video_size, canvas=canvas)
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            limit=8 * 1024 * 1024,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        _, stderr = await asyncio.wait_for(
            process.communicate(), timeout=float(config.subtitle_render_timeout_seconds)
        )
    except TimeoutError as exc:
        if process is not None:
            await _stop(process)
        raise StereoTranscodeError("Subtitle rendering timed out") from exc
    except asyncio.CancelledError:
        if process is not None:
            await _stop(process)
        raise
    except OSError as exc:
        raise StereoTranscodeError("Subtitle rendering could not start") from exc
    if process.returncode != 0:
        raise StereoTranscodeError("Subtitle rendering failed")
    return parse_frames(stderr.decode("utf-8", errors="replace"))

async def _stop(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except TimeoutError:
        process.kill()
        await process.wait()
