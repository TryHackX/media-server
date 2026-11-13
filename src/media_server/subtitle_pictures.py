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

One track is one FFmpeg pass:

  1. FFmpeg decodes the subtitle stream into a filtergraph. A bitmap subtitle
     becomes a video frame there, and with ``-fps_mode passthrough`` exactly one
     frame is emitted per subtitle event — not one per frame of film. A cue that
     appears produces a picture; the moment it disappears produces a blank one,
     which is how the end of each cue is known.
  2. The canvas is stated rather than guessed (see ``subtitle_canvas``) and then
     mapped onto the picture's own size. Doing it here rather than in the browser
     means the image the browser receives is always exactly the size of the video
     frame, and laying one over the other needs no arithmetic at all.
  3. ``showinfo`` prints each frame's number and timestamp; the picture FFmpeg
     wrote for it says the rest. PNG is lossless and the encoder deterministic,
     so two frames are the same picture exactly when their files are the same
     bytes — a cue the format merely re-drew — and a blank frame is the one whose
     pixels all decompress to zero, which is how the end of each cue is known.
     ``showinfo`` could say both itself, but its checksum and its mean and
     deviation are worked out over every byte of every frame: 70 % of the time of
     a render at 1080p, more at 4K, for frames three quarters of which are thrown
     away. Asked for timestamps only, it costs nothing; the identity read from
     the files is the same, frame for frame (checked on 1080p and 4K tracks).

**A film with many picture tracks is read once, not once per track.** A Blu-ray
remux carries up to 46 of them, and decoding each straight out of the film meant
reading the whole film again for every one: 24.6 TB to warm this library, about
34 hours. Decoding them all in one process is not the answer — FFmpeg sends every
packet of every decoded subtitle stream to all of them as a "heartbeat", so each
track gains frames from its neighbours, and how many depends on thread timing
(measured: 225 frames alone, 258 and 260 in two multi-output runs). So the one
pass decodes nothing. It copies each track, untouched, into its own small file —
a few megabytes — and each is then drawn from that file as it would be from the
film: same packets, same timestamps, the same cues at the same times with the
same pictures, byte for byte (checked track by track on Blu-ray remuxes, a 4K
remux and DVD rips). Reading drops to one pass per film, 2.4 TB for the library.

Only the frame *numbers* may differ, and they are names, nothing more. Drawn
straight from a Matroska film, a track also gets the heartbeat of the film's own
sound and picture packets — blank or repeated frames that are thrown away — so
the same cue's picture can carry a different number drawn from the copy
(Final Destination 4: 3377 frames from the film, 3089 from the copy, the same
772 cues). The cache key does not change: a track rendered either way is
complete, and shows the same.

Deliberately **not** a parser for the .sup and VobSub formats. FFmpeg already
decodes both — and DVB subtitles, and anything it learns next — so the work here
is the same for every one of them, and there is no second RLE decoder to get
subtly wrong.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import uuid
import zlib
from contextlib import AbstractAsyncContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import StereoConfig
from .paths import ResolvedItem
from .stereo import RESTAMPED_SUFFIXES, StereoTranscodeError, _stop_process

# What ``showinfo=checksum=0`` prints: which frame, and when.
_SHOWINFO_TIMES = re.compile(r"n:\s*(?P<n>\d+)\s+pts:\s*\S+\s+pts_time:(?P<time>[0-9.]+)")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Below this a cue is an artefact of how the format re-draws itself, not
# something anybody could read.
_MIN_CUE_SECONDS = 0.05
# Bumped when a render changes shape, so stale output is not served forever.
_PICTURE_RENDER_VERSION = "pictures-v2"
# Transport and program streams (Blu-ray .m2ts, DVD .vob, broadcast .ts) are keyed
# apart, because their renders did change. Decoded alone, a track there was put
# on its *own* timeline: FFmpeg moves the zero of such a file to the earliest of
# the streams in use, and with one subtitle stream in use that was the subtitle's
# first packet. Every cue came out early by however late the track starts —
# 5.3 s on one American Sniper extra, up to 5 s on the Looney Tunes DVDs, 84 of
# 341 tracks in this library. The picture anchors the timeline now (see
# ``extract_command``), the way the compatibility stream plays it.
_RESTAMPED_RENDER_VERSION = "pictures-v3"
# A film has on the order of a thousand cues. Ten thousand means something other
# than a subtitle track was handed to us, and grinding it would take hours.
_MAX_CUES = 10000
_MAX_CUE_SECONDS = 30.0

# What one pass can copy out of a film untouched, and into what — out of a
# transport stream, a transport stream instead (``copy_format``). PGS goes into
# its own raw format, which keeps a 90 kHz clock: Matroska keeps milliseconds, and
# a Blu-ray timestamp of 5.5055 s came back as 5.506 instead of the 5.505 a render
# straight from the film reports. VobSub and DVB have no raw format of their own,
# and in Matroska they keep the palette and the frame size they need. Anything
# else is drawn straight from the film, a pass per track as before.
_EXTRACT_FORMATS = {
    "hdmv_pgs_subtitle": ("sup", ".sup"),
    "pgssub": ("sup", ".sup"),
    "dvd_subtitle": ("matroska", ".mks"),
    "dvdsub": ("matroska", ".mks"),
    "dvb_subtitle": ("matroska", ".mks"),
    "dvbsub": ("matroska", ".mks"),
}
# From a transport stream a PGS copy is a Blu-ray transport stream too. Raw .sup
# is strict: it splits each packet into PGS segments and refuses one whose segment
# runs past its end — and a Blu-ray .m2ts has such packets (FFmpeg has no PGS
# parser there to reassemble them). One of them on one track of The Return of the
# King ended the whole copy two minutes in, and every track then went back to a
# full read of the 40 GB film each. M2TS takes every packet as it is, at the same
# 90 kHz clock (with no mux delay), so the copy decodes exactly as the film does:
# the decoder skips such a segment in both. M2TS rather than plain MPEG-TS, which
# files PGS as anonymous private data that no longer reads back as a subtitle. A
# .sup copy that fails anywhere else is tried once this way too, before the film is
# read track by track.
_TRANSPORT_SUFFIXES = frozenset({".ts", ".m2ts", ".mts"})
_TOLERANT_FORMAT = ("mpegts", ".m2ts")
_TOLERANT_CODECS = frozenset({"hdmv_pgs_subtitle", "pgssub"})
# A picture wider than this may carry PGS drawn smaller than itself (Blu-ray and
# UHD Blu-ray PGS are at most 1920 wide), so its tracks always go through the copy:
# the copy is where the authored size can be read (``_authored_sizes``).
_NATIVE_FROM_WIDTH = 1920
# Marks the cache key of a track stored at its authored size (``picture_cache_dir``).
_NATIVE_KEY = "native"
# FFmpeg naming a subtitle stream's size, per input, as `ffmpeg -i copy -i copy …`
# prints it once it has decoded the first presentation of each.
_INPUT_SUBTITLE_SIZE = re.compile(
    r"Stream #(?P<input>\d+):\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Subtitle: [^\n]*?\b(?P<width>\d{2,5})x(?P<height>\d{2,5})\b"
)
# Added to every copied timestamp and taken off again when the copy is drawn. A
# subtitle packet a few milliseconds before the film's zero is negative, and a
# muxer handed a negative timestamp shifts the *whole* track to make it positive.
# Raw PGS stores 32 bits of a 90 kHz clock, so an hour leaves 12 hours of film.
_EXTRACT_OFFSET_SECONDS = 3600
# FFmpeg's own count of what each output received, printed at -loglevel verbose.
_MUXED_PACKETS = re.compile(r"\[out#(?P<output>\d+)/[^\]]*\]\s+Total:\s+(?P<packets>\d+) packets")
# How many tracks are drawn at once from their copies. Drawing is CPU work — a
# PNG per subtitle event, ~10 ms each — and each FFmpeg keeps about two threads
# busy, so a quarter of the machine's threads stays out of everybody's way.
RENDER_SLOTS = max(1, min(4, (os.cpu_count() or 4) // 4))
# Copies left behind by a process that was killed mid-film.
_STALE_WORK_SECONDS = 6 * 3600


class EmptySubtitleTrack(StereoTranscodeError):
    """The track holds nothing to show: no event in it ever draws a picture.

    Not rare: Blu-ray remuxes carry empty slots — 14 of the 27 picture tracks of
    one film in this library. Told apart from a render that failed, because the
    walk over the library has to know which of the two it is looking at.
    """


@dataclass(frozen=True, slots=True)
class _Frame:
    index: int
    seconds: float
    blank: bool
    # What identifies the picture: the digest of its PNG (``identify_frames``).
    # Two frames carrying the same one are the same picture, which is how a
    # re-drawn subtitle is recognised as still being the one already on screen.
    checksum: str = ""


@dataclass(frozen=True, slots=True)
class TrackRender:
    """What became of one picture track: ``rendered``, ``cached``, ``empty`` or ``failed``."""

    state: str
    manifest: dict[str, Any] | None = None
    error: str | None = None

    @property
    def usable(self) -> bool:
        return self.state in {"rendered", "cached"}


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


def canvas_filter(video_size: tuple[int, int] | None, *, background: bool = False) -> str:
    """Map the subtitle's own canvas onto the picture, without distorting it.

    A PGS track usually already carries the film's dimensions and this is a no-op.
    A VobSub track carries the whole 1920x1080 frame even when the film was cropped
    to 1920x808, and stretching that to fit would squash every letter by a quarter.
    Scaling to *cover* and cropping the middle keeps the shapes and drops exactly
    what the film itself dropped: the letterbox bars.

    Not a no-op on a 4K film: a UHD disc's PGS is drawn at 1920x1080, sub2video
    hands over frames that size whatever ``-canvas_size`` says, and this upscales
    each one to 3840x2160 — 163 ms of CPU per frame on ten swscale threads, most of
    a 4K drawing. The background pass gives the scaler one thread: the same pixels
    (checked frame by frame on 4K and letterboxed 1080p tracks) for less than half
    the CPU, because four drawings at once already fill the machine. A viewer
    waiting for a track keeps all the threads, for the time.
    """
    if video_size is None:
        return ""
    width, height = video_size
    threads = ":threads=1" if background else ""
    return f"scale={width}:{height}:force_original_aspect_ratio=increase{threads},crop={width}:{height},"


# How each picture is written. PNG is lossless whatever the setting; these change
# the file's bytes and size, never a pixel. FFmpeg's default row prediction
# (paeth) cost a quarter of a 4K drawing's CPU on rows that are nearly all
# transparent, and saved nothing: files come out a few percent *smaller* without
# it (67 MB -> 64 MB on 713 4K frames). The zlib level stays at its default — level
# 1 was no faster and four times bigger.
_PNG_OPTIONS = ("-pred", "none")


def restamped(item: ResolvedItem) -> bool:
    """A transport or program stream, whose zero FFmpeg moves to the streams in use."""
    return item.path.suffix.lower() in RESTAMPED_SUFFIXES


def picture_render_version(item: ResolvedItem) -> str:
    return _RESTAMPED_RENDER_VERSION if restamped(item) else _PICTURE_RENDER_VERSION


def subtitle_frames_command(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    directory: Path,
    video_size: tuple[int, int] | None = None,
    *,
    canvas: tuple[int, int] | None = None,
    background: bool = False,
) -> list[str]:
    """Render every cue of one bitmap subtitle track as an image, straight from the film.

    ``canvas`` states the frame the subtitle was drawn for, which FFmpeg would
    otherwise guess — and guess differently depending on where it started.
    ``-nostats``: the progress line is written from another thread and can land
    in the middle of a ``showinfo`` line, and a line that no longer parses is a
    cue that ends in the wrong place.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    shape = canvas_filter(video_size, background=background)
    return [
        config.ffmpeg_path,
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-y",
        # Before -i: it tells the decoder how big the subtitle's own frame is.
        *(["-canvas_size", f"{canvas[0]}x{canvas[1]}"] if canvas is not None else []),
        "-i",
        str(item.path),
        "-filter_complex",
        # Timestamps only: what each frame shows is read from its picture.
        f"[0:s:{subtitle_track}]{shape}showinfo=checksum=0[v]",
        "-map",
        "[v]",
        # One image per subtitle event. Without this FFmpeg invents a frame rate
        # and writes one picture per frame of film — 145,000 of them for a
        # ninety-minute film, all but a thousand of them blank.
        "-fps_mode",
        "passthrough",
        *_PNG_OPTIONS,
        "-f",
        "image2",
        str(directory / "%06d.png"),
        # A transport or program stream is drawn on the picture's timeline, as its
        # copy is (``extract_command``): only the fallback when the copy failed
        # comes here, and without the picture it would put every cue of a track
        # that starts late too early — under the key that promises they are not.
        *(["-map", "0:v:0?", "-c", "copy", "-f", "null", "-"] if restamped(item) else []),
    ]


def extract_command(
    item: ResolvedItem,
    config: StereoConfig,
    plan: list[tuple[int, str, Path]],
) -> list[str]:
    """One read of the film: each planned track copied, untouched, into its own file.

    ``plan`` lists (track, muxer, target). Nothing is decoded, so no track can
    hear another one's packets. In a transport or program stream the first video
    stream is copied too, into nothing: FFmpeg sets such a file's zero by the
    streams in use, and with the picture among them the subtitles land on the
    timeline the picture — and the compatibility stream — has.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    command = [
        config.ffmpeg_path, "-nostdin", "-hide_banner", "-nostats",
        # Verbose for the closing count of packets per output: a track with none
        # is an empty slot, and Matroska with nothing in it cannot even be opened.
        "-loglevel", "verbose", "-y", "-i", str(item.path),
    ]
    if restamped(item):
        command.extend(["-map", "0:v:0?", "-c", "copy", "-f", "null", "-"])
    for track, muxer, target in plan:
        command.extend([
            "-map", f"0:s:{track}", "-c", "copy",
            # Every packet, including any before the first one flagged as a key.
            "-copyinkf",
            "-output_ts_offset", str(_EXTRACT_OFFSET_SECONDS),
            # The TS muxer delays every timestamp by 0.7 s unless told not to, and
            # only in Blu-ray mode does it file PGS as PGS (stream type 0x90).
            *(["-muxdelay", "0", "-muxpreload", "0", "-mpegts_m2ts_mode", "1"] if muxer == "mpegts" else []),
            "-f", muxer, str(target),
        ])
    return command


def copy_format(item: ResolvedItem, codec: str, *, tolerant: bool = False) -> tuple[str, str]:
    """The muxer and suffix one track is copied into (see ``_TRANSPORT_SUFFIXES``)."""
    codec = codec.lower()
    if codec in _TOLERANT_CODECS and (tolerant or item.path.suffix.lower() in _TRANSPORT_SUFFIXES):
        return _TOLERANT_FORMAT
    return _EXTRACT_FORMATS[codec]


def extracted_frames_command(
    config: StereoConfig,
    source: Path,
    directory: Path,
    video_size: tuple[int, int] | None = None,
    *,
    canvas: tuple[int, int] | None = None,
    background: bool = False,
    picture: tuple[int, int] | None = None,
) -> list[str]:
    """Draw one copied track exactly as ``subtitle_frames_command`` draws it from the film.

    ``-copyts`` with the copy's offset taken back off puts every packet at the
    instant it had in the film, with nothing else of FFmpeg's start-time logic
    in between. With ``picture`` the track is kept at its authored size
    (``canvas``) and only cut to that picture (``native_picture_size``).
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    shape = (
        native_filter(picture, background=background)
        if picture is not None
        else canvas_filter(video_size, background=background)
    )
    return [
        config.ffmpeg_path, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y",
        "-copyts", "-itsoffset", f"-{_EXTRACT_OFFSET_SECONDS}",
        *(["-canvas_size", f"{canvas[0]}x{canvas[1]}"] if canvas is not None else []),
        "-i", str(source),
        "-filter_complex", f"[0:s:0]{shape}showinfo=checksum=0[v]",
        "-map", "[v]",
        "-fps_mode", "passthrough",
        *_PNG_OPTIONS,
        "-f", "image2", str(directory / "%06d.png"),
    ]


def frame_times(stderr: str) -> list[tuple[int, float]]:
    """Each emitted frame's number and timestamp, in order, from ``showinfo=checksum=0``.

    The numbering is FFmpeg's own frame counter, and image2 writes files from 1
    in the same order, so frame n is file n+1.
    """
    return sorted((int(match.group("n")), float(match.group("time"))) for match in _SHOWINFO_TIMES.finditer(stderr))


def png_is_blank(path: Path) -> bool:
    """Whether a rendered picture is fully transparent: every pixel byte zero.

    A filtered PNG row of an all-zero image is all zeros whatever the filter, so
    after inflating, every byte but the one filter-type byte opening each row has
    to be zero. Only 8-bit RGBA is expected — it is what the encoder is handed —
    and anything else is refused rather than guessed at.
    """
    data = path.read_bytes()
    if not data.startswith(_PNG_SIGNATURE):
        raise StereoTranscodeError("Subtitle rendering wrote something that is not a PNG")
    position = len(_PNG_SIGNATURE)
    width = height = 0
    header: bytes = b""
    image = bytearray()
    while position + 8 <= len(data):
        length = int.from_bytes(data[position : position + 4], "big")
        kind = data[position + 4 : position + 8]
        body = data[position + 8 : position + 8 + length]
        if kind == b"IHDR":
            header = body
            width, height = int.from_bytes(body[0:4], "big"), int.from_bytes(body[4:8], "big")
        elif kind == b"IDAT":
            image += body
        elif kind == b"IEND":
            break
        position += 12 + length
    if len(header) < 13 or header[8] != 8 or header[9] != 6 or header[12] != 0:
        raise StereoTranscodeError("Subtitle rendering wrote a picture in an unexpected format")
    try:
        raw = zlib.decompress(bytes(image))
    except zlib.error as exc:
        raise StereoTranscodeError("Subtitle rendering wrote a damaged picture") from exc
    stride = 1 + width * 4
    if len(raw) != stride * height:
        raise StereoTranscodeError("Subtitle rendering wrote a damaged picture")
    filters_set = height - raw[0::stride].count(0)
    return raw.count(0) == len(raw) - filters_set


def identify_frames(directory: Path, times: list[tuple[int, float]]) -> list[_Frame]:
    """Frames with what they show, read from the pictures FFmpeg wrote for them.

    Equal bytes are the same picture. All blank frames of one render are equal
    too — the same transparent canvas — so at most one picture is the blank one,
    and it is the smallest file there is: only the few smallest are opened to
    find it. Blocking: every picture of the track is read.
    """
    digests: dict[int, str] = {}
    smallest: dict[str, tuple[int, int]] = {}
    for index, _ in times:
        try:
            data = (directory / f"{index + 1:06d}.png").read_bytes()
        except OSError as exc:
            raise StereoTranscodeError("Subtitle rendering left a picture out") from exc
        digest = hashlib.blake2b(data, digest_size=16).hexdigest()
        digests[index] = digest
        smallest.setdefault(digest, (len(data), index))
    blank: str | None = None
    for digest, (_, index) in sorted(smallest.items(), key=lambda entry: entry[1])[:3]:
        if png_is_blank(directory / f"{index + 1:06d}.png"):
            blank = digest
            break
    return [
        _Frame(index=index, seconds=seconds, blank=digests[index] == blank, checksum=digests[index])
        for index, seconds in times
    ]


def plan_cues(frames: list[_Frame]) -> list[tuple[int, float, float]]:
    """Turn the stream of frames into cues: which picture, from when, until when.

    Frames are grouped by what they show rather than counted, because the formats
    re-draw. A PGS track emits a clear and its replacement **at the same
    timestamp**, and then re-sends the very same picture again just before wiping
    it. Treating each frame as a cue produced pairs that overlapped by a
    millisecond and hundreds of cues nobody could see. Consecutive frames showing
    the same picture (``_Frame.checksum``) are one picture, and it stays up until
    something different arrives — which is what the viewer's eye sees anyway.

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


def picture_cache_dir(
    item: ResolvedItem, config: StereoConfig, subtitle_track: int, *, native: bool = False
) -> Path | None:
    """Where one track's rendered cues live; keyed like the WebVTT cache.

    The render version is part of the key. Without it a fix to how a track is
    drawn would never reach anybody who already has the broken version on disk —
    which is exactly what happened when the canvas was wrong.

    ``native`` is the key of a track stored at its own authored size rather than
    the picture's (``native_picture_size``): only those renders differ, so only
    they get a key of their own, and everything already rendered keeps its own.
    """
    if config.subtitle_cache_path is None:
        return None
    parts = [picture_render_version(item), str(item.path), str(item.mtime_ns), str(item.size), str(subtitle_track)]
    if native:
        parts.append(_NATIVE_KEY)
    identity = "\0".join(parts).encode("utf-8", errors="surrogatepass")
    return config.subtitle_cache_path / "pictures" / hashlib.sha256(identity).hexdigest()


def find_picture_track(
    item: ResolvedItem, config: StereoConfig, subtitle_track: int
) -> tuple[Path | None, dict[str, Any] | None]:
    """The rendered track and its manifest: stored at its own size if it was, else as before.

    A 4K film's track rendered before 09.11 is upscaled and still right, so it
    is still served; a new render goes under the native key. Blocking.
    """
    for native in (True, False):
        directory = picture_cache_dir(item, config, subtitle_track, native=native)
        manifest = read_picture_manifest(directory)
        if manifest is not None:
            return directory, manifest
    return picture_cache_dir(item, config, subtitle_track), None


def native_picture_size(
    video_size: tuple[int, int] | None, authored: tuple[int, int] | None
) -> tuple[int, int] | None:
    """The picture to store for a track authored smaller than the film, or None to store it as before.

    A UHD disc's PGS is drawn at 1920x1080 and was upscaled to 3840x2160 before it
    was saved — CPU for pixels that hold no more detail than the bitmap the author
    drew. Kept at that size instead, cut to the film's shape the way the cover and
    crop cut it at full size, and the player scales it as a Blu-ray player does:
    the overlay is fitted to the video's box (``object-fit: contain``), and the
    picture has the video's proportions. Only a track smaller than the film is
    stored this way; one the film's size or larger is stored as it always was.
    """
    if video_size is None or authored is None:
        return None
    (width, height), (authored_width, authored_height) = video_size, authored
    if authored_width <= 0 or authored_height <= 0 or authored_width >= width:
        return None
    if width * authored_height >= height * authored_width:
        # Wider than the authored frame: the full width, and the middle of its height.
        return authored_width, max(2, round(height * authored_width / width))
    return max(2, round(width * authored_height / height)), authored_height


def native_filter(picture: tuple[int, int], *, background: bool = False) -> str:
    """Cut the authored frame to the stored picture; no scaling, only sub2video's BGRA turned to RGBA."""
    threads = "=threads=1" if background else ""
    return f"crop={picture[0]}:{picture[1]},scale{threads},"


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


# Tracks being drawn right now, by any job in this process. A viewer who asks for
# the track a background pass is already drawing waits for that render instead of
# starting a second one into the same staging directory.
_IN_FLIGHT: dict[str, asyncio.Future[TrackRender]] = {}


def _claim(directory: Path) -> asyncio.Future[TrackRender] | None:
    """Our own future if the track is now ours; None while somebody else draws it."""
    key = str(directory)
    running = asyncio.get_running_loop()
    held = _IN_FLIGHT.get(key)
    if held is not None and not held.done() and held.get_loop() is running:
        return None
    future: asyncio.Future[TrackRender] = running.create_future()
    _IN_FLIGHT[key] = future
    return future


def _settle(directory: Path, future: asyncio.Future[TrackRender], result: TrackRender) -> None:
    if not future.done():
        future.set_result(result)
    if _IN_FLIGHT.get(str(directory)) is future:
        del _IN_FLIGHT[str(directory)]


async def _await_other(directory: Path, native: Path | None = None) -> TrackRender:
    future = _IN_FLIGHT.get(str(directory))
    if future is None or future.get_loop() is not asyncio.get_running_loop():
        for candidate in (native, directory):
            manifest = await asyncio.to_thread(read_picture_manifest, candidate) if candidate is not None else None
            if manifest is not None:
                return TrackRender("cached", manifest)
        return TrackRender("failed", error="Not rendered")
    # Shielded: a viewer who gives up waiting must not cancel the render itself.
    result = await asyncio.shield(future)
    return TrackRender("cached", result.manifest) if result.usable else result


def _creation_flags(background: bool) -> int:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if background:
        # Below the viewers: a background pass draws thousands of PNGs, and a film
        # being transcoded for somebody must not stutter because of it.
        flags |= getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
    return flags


async def _run_ffmpeg(
    command: list[str], *, timeout: float, background: bool, what: str
) -> tuple[int, str]:
    """Run one FFmpeg to the end and hand back its exit code and log."""
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            limit=8 * 1024 * 1024,
            creationflags=_creation_flags(background),
        )
        if background and hasattr(os, "setpriority"):
            try:
                os.setpriority(os.PRIO_PROCESS, process.pid, 10)
            except OSError:
                pass
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError as exc:
        if process is not None:
            await _stop_process(process)
        raise StereoTranscodeError(f"{what} timed out") from exc
    except asyncio.CancelledError:
        if process is not None:
            await _stop_process(process)
        raise
    except OSError as exc:
        raise StereoTranscodeError(f"{what} could not start") from exc
    return int(process.returncode or 0), stderr.decode("utf-8", errors="replace")


def _write_track(
    staging: Path,
    directory: Path,
    planned: list[tuple[int, float, float]],
    video_size: tuple[int, int] | None,
    scale: float | None = None,
) -> dict[str, Any]:
    """Keep the pictures the cues name, write the manifest, and move it all into place.

    Blank frames are deleted once their timestamps have been read: they exist to
    say when a cue ends, and keeping a thousand transparent rectangles on disk
    would double the cache for nothing. Moved into place only once every image is
    written and the blanks are gone, so a reader either sees a complete track or
    sees nothing.

    ``width`` and ``height`` are the stored picture's; ``scale``, when there is
    one, is how much larger the film's picture is (2 for 1080p PGS on a 4K film).
    """
    wanted = {index for index, _, _ in planned}
    cues = [{"start": round(start, 3), "end": round(end, 3), "frame": f"{index + 1:06d}"} for index, start, end in planned]
    for image in staging.glob("*.png"):
        if int(image.stem) - 1 not in wanted:
            image.unlink(missing_ok=True)
    manifest: dict[str, Any] = {
        "width": video_size[0] if video_size else None,
        "height": video_size[1] if video_size else None,
        **({"scale": scale} if scale is not None else {}),
        "cues": cues,
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    shutil.rmtree(directory, ignore_errors=True)
    staging.replace(directory)
    return read_picture_manifest(directory) or manifest


async def _draw(
    command: list[str],
    staging: Path,
    directory: Path,
    video_size: tuple[int, int] | None,
    config: StereoConfig,
    *,
    background: bool,
    scale: float | None = None,
) -> TrackRender:
    """Run one drawing command into ``staging`` and turn what it printed into a track."""
    await asyncio.to_thread(shutil.rmtree, staging, True)
    await asyncio.to_thread(staging.mkdir, parents=True, exist_ok=True)
    try:
        returncode, stderr = await _run_ffmpeg(
            command,
            timeout=float(config.subtitle_render_timeout_seconds),
            background=background,
            what="Subtitle rendering",
        )
        if returncode != 0:
            raise StereoTranscodeError("Subtitle rendering failed")
        frames = await asyncio.to_thread(identify_frames, staging, frame_times(stderr))
        planned = plan_cues(frames)
        if not planned:
            raise EmptySubtitleTrack("Subtitle track produced no pictures to show")
        if len(planned) > _MAX_CUES:
            raise StereoTranscodeError("Subtitle track has implausibly many cues")
        manifest = await asyncio.to_thread(_write_track, staging, directory, planned, video_size, scale)
        return TrackRender("rendered", manifest)
    except EmptySubtitleTrack as exc:
        await asyncio.to_thread(shutil.rmtree, staging, True)
        return TrackRender("empty", error=str(exc))
    except (StereoTranscodeError, OSError) as exc:
        # A full disk or a vanished folder is this track's failure, not the film's:
        # its neighbours may be drawing from their copies at this very moment.
        await asyncio.to_thread(shutil.rmtree, staging, True)
        return TrackRender("failed", error=str(exc))
    except BaseException:
        await asyncio.to_thread(shutil.rmtree, staging, True)
        raise


def _work_root(config: StereoConfig) -> Path:
    if config.subtitle_cache_path is None:
        raise StereoTranscodeError("Subtitle cache is not configured")
    return config.subtitle_cache_path / "work"


def sweep_stale_work(config: StereoConfig, *, now: float | None = None) -> int:
    """Remove copies a killed process left behind; ones still in use are recent."""
    if config.subtitle_cache_path is None:
        return 0
    root = config.subtitle_cache_path / "work"
    removed = 0
    cutoff = (now if now is not None else time.time()) - _STALE_WORK_SECONDS
    try:
        entries = list(root.iterdir())
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


def _extractable(track: dict[str, Any], video_size: tuple[int, int] | None) -> bool:
    """Whether a track can be copied out and drawn from the copy exactly as from the film.

    Not when the canvas is unknown: FFmpeg then sizes it from the film's video
    stream, which a copy does not have.
    """
    return str(track.get("codec", "")).lower() in _EXTRACT_FORMATS and subtitle_canvas(track, video_size) is not None


async def _extract(
    item: ResolvedItem,
    config: StereoConfig,
    tracks: list[dict[str, Any]],
    work: Path,
    *,
    background: bool,
    tolerant: bool = False,
) -> dict[int, tuple[Path, int]]:
    """Copy the tracks out in one read; each track's file and how many packets it got."""
    plan: list[tuple[int, str, Path]] = []
    for track in tracks:
        index = int(track["index"])
        muxer, suffix = copy_format(item, str(track.get("codec", "")), tolerant=tolerant)
        plan.append((index, muxer, work / f"{index}{suffix}"))
    await asyncio.to_thread(work.mkdir, parents=True, exist_ok=True)
    returncode, stderr = await _run_ffmpeg(
        extract_command(item, config, plan),
        timeout=float(config.subtitle_render_timeout_seconds),
        background=background,
        what="Subtitle extraction",
    )
    if returncode != 0:
        raise StereoTranscodeError("Subtitle extraction failed")
    counts = {int(match["output"]): int(match["packets"]) for match in _MUXED_PACKETS.finditer(stderr)}
    first_output = 1 if restamped(item) else 0
    return {
        index: (target, counts.get(first_output + position, -1))
        for position, (index, _, target) in enumerate(plan)
    }


async def _authored_sizes(
    config: StereoConfig, copies: dict[int, tuple[Path, int]], *, background: bool
) -> dict[int, tuple[int, int]]:
    """How large each copied track was drawn, read by FFmpeg from the copies themselves.

    The film's own probe stops before the first subtitle packet and cannot say;
    a copy holds nothing else, so FFmpeg decodes its first presentation at once.
    One FFmpeg for every copy of the film. A size it does not report is not
    guessed: that track is stored as before.
    """
    ordered = [(index, path) for index, (path, packets) in copies.items() if packets != 0]
    if not ordered or config.ffmpeg_path is None:
        return {}
    command = [config.ffmpeg_path, "-nostdin", "-hide_banner"]
    for _, path in ordered:
        command.extend(["-i", str(path)])
    try:
        # No output is named, so FFmpeg exits with an error after describing the inputs.
        _returncode, stderr = await _run_ffmpeg(command, timeout=120.0, background=background, what="Subtitle probe")
    except StereoTranscodeError:
        return {}
    sizes: dict[int, tuple[int, int]] = {}
    for match in _INPUT_SUBTITLE_SIZE.finditer(stderr):
        position = int(match["input"])
        if position < len(ordered):
            sizes.setdefault(ordered[position][0], (int(match["width"]), int(match["height"])))
    return sizes


async def render_film_pictures(
    item: ResolvedItem,
    config: StereoConfig,
    tracks: list[dict[str, Any]],
    video_size: tuple[int, int] | None,
    *,
    disk: asyncio.Semaphore | None = None,
    renders: asyncio.Semaphore | None = None,
    refresh: bool = False,
    background: bool = False,
) -> dict[int, TrackRender]:
    """Render picture tracks of one film, reading the film as few times as possible.

    ``disk`` is held while the film itself is read; ``renders`` bounds how many
    tracks are drawn from their copies at once, after the disk is free again — so
    a walk over the library draws one film while it reads the next.

    Two or more tracks that can be copied out are, in one pass; a single one in
    an ordinary file is drawn straight from the film, where reading and drawing
    overlap. Transport and program streams always go through the copy, which is
    what puts their cues on the picture's timeline, and so does a picture wider
    than 1080p PGS: the copy says how large the track was drawn, and a smaller one
    is stored at that size (``native_picture_size``). When the copy fails, each
    track falls back to its own pass — slower, never worse than before.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    results: dict[int, TrackRender] = {}
    pending: list[tuple[int, dict[str, Any], Path]] = []
    for track in tracks:
        index = int(track["index"])
        directory = picture_cache_dir(item, config, index)
        if directory is None:
            raise StereoTranscodeError("Subtitle cache is not configured")
        if not refresh:
            _found, manifest = await asyncio.to_thread(find_picture_track, item, config, index)
            if manifest is not None:
                results[index] = TrackRender("cached", manifest)
                continue
        pending.append((index, track, directory))
    if not pending:
        return results

    claimed: list[tuple[int, dict[str, Any], Path, asyncio.Future[TrackRender]]] = []
    elsewhere: list[tuple[int, Path]] = []
    copies: dict[int, tuple[Path, int]] = {}
    authored: dict[int, tuple[int, int]] = {}
    work: Path | None = None
    slot: AbstractAsyncContextManager[Any] = disk if disk is not None else nullcontext()
    try:
        async with slot:
            for index, track, directory in pending:
                if not refresh:
                    _found, manifest = await asyncio.to_thread(find_picture_track, item, config, index)
                    if manifest is not None:
                        results[index] = TrackRender("cached", manifest)
                        continue
                future = _claim(directory)
                if future is None:
                    elsewhere.append((index, directory))
                else:
                    claimed.append((index, track, directory, future))

            wide = video_size is not None and video_size[0] > _NATIVE_FROM_WIDTH
            copyable = [entry for entry in claimed if _extractable(entry[1], video_size)]
            if not (restamped(item) or wide or len(copyable) >= 2):
                copyable = []
            direct = [entry for entry in claimed if entry not in copyable]
            if copyable:
                work = _work_root(config) / f"{os.getpid()}-{uuid.uuid4().hex[:12]}"
                described = [entry[1] for entry in copyable]
                try:
                    copies = await _extract(item, config, described, work, background=background)
                except StereoTranscodeError:
                    copies = {}
                    stricter = any(
                        copy_format(item, str(track.get("codec", ""))) != copy_format(
                            item, str(track.get("codec", "")), tolerant=True
                        )
                        for track in described
                    )
                    if stricter:
                        # A raw .sup refuses a packet a transport stream keeps.
                        try:
                            copies = await _extract(
                                item, config, described, work, background=background, tolerant=True
                            )
                        except StereoTranscodeError:
                            copies = {}
                if not copies:
                    direct.extend(copyable)
                    copyable = []
                elif wide:
                    authored = await _authored_sizes(config, copies, background=background)
            for index, track, directory, future in direct:
                canvas = subtitle_canvas(track, video_size)
                result = await _draw(
                    subtitle_frames_command(
                        item, config, index, Path(f"{directory}.partial"), video_size,
                        canvas=canvas, background=background,
                    ),
                    Path(f"{directory}.partial"), directory, video_size, config, background=background,
                )
                results[index] = result
                _settle(directory, future, result)

        async def from_copy(index: int, track: dict[str, Any], directory: Path, future: asyncio.Future[TrackRender]) -> None:
            source, packets = copies[index]
            if packets == 0:
                # Not one packet: an empty slot, exactly what drawing it from the
                # film reported — and Matroska with nothing in it does not open.
                result = TrackRender("empty", error="Subtitle track produced no pictures to show")
            else:
                picture = native_picture_size(video_size, authored.get(index))
                if picture is None:
                    target, canvas, size, scale = directory, subtitle_canvas(track, video_size), video_size, None
                else:
                    # Drawn at the size its author drew it, and scaled by the player.
                    target = picture_cache_dir(item, config, index, native=True) or directory
                    canvas, size = authored[index], picture
                    scale = round(video_size[0] / picture[0], 4) if video_size else None
                staging = Path(f"{target}.partial")
                command = extracted_frames_command(
                    config, source, staging, video_size, canvas=canvas, background=background, picture=picture,
                )
                async with renders if renders is not None else nullcontext():
                    result = await _draw(command, staging, target, size, config, background=background, scale=scale)
            results[index] = result
            _settle(directory, future, result)

        if copyable:
            await asyncio.gather(*(from_copy(*entry) for entry in copyable))
    finally:
        for index, _track, directory, future in claimed:
            # Anything not settled above was interrupted; whoever waits for it
            # hears so instead of waiting for ever.
            _settle(directory, future, results.get(index) or TrackRender("failed", error="Render interrupted"))
        if work is not None:
            await asyncio.to_thread(shutil.rmtree, work, True)

    for index, directory in elsewhere:
        results[index] = await _await_other(directory, picture_cache_dir(item, config, index, native=True))
    return results


async def render_subtitle_pictures(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    video_size: tuple[int, int] | None,
    semaphore: asyncio.Semaphore | None = None,
    track: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render one bitmap track to a directory of cues plus a manifest.

    The viewer's path: one track, now. It shares the film-wide machinery, so a
    track already being drawn by the background pass is waited for, not drawn
    twice.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    if config.subtitle_cache_path is None:
        raise StereoTranscodeError("Subtitle cache is not configured")
    described = dict(track or {})
    described["index"] = subtitle_track
    result = (await render_film_pictures(item, config, [described], video_size, disk=semaphore))[subtitle_track]
    if result.usable and result.manifest is not None:
        return result.manifest
    if result.state == "empty":
        raise EmptySubtitleTrack(result.error or "Subtitle track produced no pictures to show")
    raise StereoTranscodeError(result.error or "Subtitle rendering failed")
