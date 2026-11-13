from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import re
import shutil
import stat
import subprocess
import time
import uuid
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

# Starlette's own concurrency layer, so it is installed wherever this runs.
import anyio

from .config import StereoConfig
from .mediatypes import VIDEO_EXTENSIONS
from .paths import ResolvedItem
from .priority import read_at_normal_priority

LOGGER = logging.getLogger("media_server.stereo")


class StereoTranscodeError(RuntimeError):
    pass


_DURATION_PATTERN = re.compile(rb"Duration:\s*(\d{1,3}):(\d{2}):(\d{2}(?:\.\d+)?)")
# FFmpeg puts the container's own stream id in brackets, and where it puts it
# depends on the container: Matroska writes `#0:1(pol):`, while MP4 and the
# transport streams write `#0:1[0x2](und):` — the id *before* the language.
# Accepting only the Matroska order meant an MP4 listed no audio and no subtitle
# streams at all, so its track selectors stood empty and every one of them played
# whatever stream FFmpeg picked. That is 407 films in this library.
_STREAM_PATTERN = re.compile(
    rb"Stream #\d+:(?P<stream>\d+)(?:\[[^]]+\])?(?:\((?P<language>[^)]+)\))?(?:\[[^]]+\])?: "
    rb"(?P<kind>Video|Audio|Subtitle): (?P<codec>[^,\s]+)(?P<details>[^\r\n]*)"
)
_TEXT_SUBTITLE_CODECS = {"ass", "mov_text", "ssa", "subrip", "text", "webvtt"}
# Subtitles that are pictures of text rather than text. FFmpeg converts none of
# these to WebVTT. What can be done with them lives in subtitle_pictures: show
# the picture over the film, or read it with OCR. Listed here so both modules
# agree on what "image" means.
IMAGE_SUBTITLE_CODECS = frozenset(
    {"hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "xsub", "dvb_subtitle"}
)
# Sidecar subtitles: text formats only. ``.sub`` is two different things under one
# name — MicroDVD text (``{start}{end}text``, counted in frames) or the binary half
# of a VobSub pair (MPEG program stream packets, read through the ``.idx`` beside
# it) — so a ``.sub`` is offered only once its first bytes say it is MicroDVD
# (``sidecar_format``). Anything else in a ``.sub`` (VobSub, SubViewer) is skipped.
_EXTERNAL_SUBTITLE_SUFFIXES = {".srt", ".ass", ".ssa", ".vtt", ".sub"}
# What a sidecar's codec is called, by suffix, where it is not the suffix itself.
_SIDECAR_CODECS = {".sub": "microdvd"}
# How much of a ``.sub`` is read to tell the two apart.
_SIDECAR_SNIFF_BYTES = 4096
# An MPEG program stream starts with a pack header; every VobSub ``.sub`` does.
_MPEG_PACK_HEADER = b"\x00\x00\x01\xba"
# A MicroDVD line, as FFmpeg's own probe accepts it: ``{start}{end}`` or
# ``{start}{}``, or the ``{DEFAULT}{}`` style line some files open with.
_MICRODVD_LINE = re.compile(rb"^\{(?:\d+\}\{\d*|DEFAULT\}\{)\}")
# Frame rates FFmpeg prints rounded ("23.98 fps") that are really NTSC fractions.
# A MicroDVD cue is a frame number, so 23.98 instead of 24000/1001 would put the
# last cue of a two-hour film 1.2 s early.
_NTSC_RATES = (24, 30, 48, 60, 120)
# Used to work out which film a sidecar belongs to when several sit in one
# folder: the names that can compete for a subtitle are the catalogue's videos.
_VIDEO_SUFFIXES = VIDEO_EXTENSIONS
_EXTERNAL_SUBTITLE_LIMIT = 8
_EXTERNAL_SUBTITLE_MAX_BYTES = 8 * 1024 * 1024
# Tokens a sidecar's name may carry as a language marker, each mapped to the
# three-letter code FFmpeg reports for an embedded track. Release groups write
# whichever spelling they like, and answering with one of them keeps a sidecar
# and an embedded track in the same language looking like the same language.
_EXTERNAL_LANGUAGE_TOKENS = {
    "pl": "pol", "pol": "pol", "polish": "pol", "polski": "pol",
    "en": "eng", "eng": "eng", "english": "eng",
    "de": "ger", "ger": "ger", "deu": "ger", "german": "ger",
    "fr": "fre", "fra": "fre", "fre": "fre", "french": "fre",
    "es": "spa", "spa": "spa", "spanish": "spa",
    "it": "ita", "ita": "ita", "italian": "ita",
    "ru": "rus", "rus": "rus", "russian": "rus",
    "uk": "ukr", "ukr": "ukr", "cz": "cze", "cze": "cze", "ces": "cze",
    "sk": "slo", "slo": "slo", "slk": "slo", "hu": "hun", "hun": "hun",
    "jp": "jpn", "jpn": "jpn", "ko": "kor", "kor": "kor",
    "zh": "chi", "chi": "chi", "zho": "chi", "nl": "dut", "dut": "dut", "nld": "dut",
    "pt": "por", "por": "por", "sv": "swe", "swe": "swe", "no": "nor", "nor": "nor",
    "da": "dan", "dan": "dan", "fi": "fin", "fin": "fin", "tr": "tur", "tur": "tur",
    "ar": "ara", "ara": "ara", "hi": "hin", "hin": "hin", "he": "heb", "heb": "heb",
}
_SUBTITLE_CACHE: dict[tuple[str, int, int, int], bytes] = {}
# One lock per track being converted, with how many are holding or waiting for
# it: the entry goes when the last of them is done (see _subtitle_lock).
_SUBTITLE_LOCKS: dict[tuple[str, int, int, int], list[Any]] = {}
# Tracks are named by number, 0..63, on every route that takes one.
MAX_SUBTITLE_TRACKS = 64
# Bound the in-memory subtitle cache by total bytes, not entry count: a plain
# count cap let 64 large tracks pin ~1 GiB resident. Oldest entries evict first.
_SUBTITLE_CACHE_BUDGET_BYTES = 32 * 1024 * 1024


@asynccontextmanager
async def _subtitle_lock(cache_key: tuple[str, int, int, int]) -> AsyncIterator[None]:
    """One conversion of a track at a time — and no trace of the lock afterwards.

    The lock used to stay in the dictionary for good: one for every track of
    every film anybody ever turned subtitles on for, for as long as the service
    ran.
    """
    entry = _SUBTITLE_LOCKS.get(cache_key)
    if entry is None:
        entry = _SUBTITLE_LOCKS[cache_key] = [asyncio.Lock(), 0]
    entry[1] += 1
    try:
        async with entry[0]:
            yield
    finally:
        entry[1] -= 1
        if entry[1] == 0 and _SUBTITLE_LOCKS.get(cache_key) is entry:
            del _SUBTITLE_LOCKS[cache_key]


def _cache_subtitle(cache_key: tuple[str, int, int, int], payload: bytes) -> None:
    _SUBTITLE_CACHE.pop(cache_key, None)
    total = sum(len(value) for value in _SUBTITLE_CACHE.values())
    while _SUBTITLE_CACHE and total + len(payload) > _SUBTITLE_CACHE_BUDGET_BYTES:
        oldest_key = next(iter(_SUBTITLE_CACHE))
        total -= len(_SUBTITLE_CACHE.pop(oldest_key))
    _SUBTITLE_CACHE[cache_key] = payload
_NATIVE_COPY_VIDEO_CODECS = {"h264", "avc1", "hevc", "h265", "av1", "av01", "vp9", "vp09"}
_MP4_VIDEO_TAGS = {"hevc": "hvc1", "h265": "hvc1", "av1": "av01", "av01": "av01", "vp9": "vp09", "vp09": "vp09"}
_PROBE_CACHE: dict[tuple[str, int, int, int], dict[str, Any]] = {}
_SEEK_PLAN_CACHE: dict[tuple[str, int, int, float], tuple[float, float]] = {}
AUDIO_PROFILE_NAMES = frozenset({"stereo_low", "stereo_standard", "stereo_high", "surround_aac"})
VIDEO_PROFILE_NAMES = frozenset({"native_copy", "h264_fallback"})
# FFmpeg is throttled by whatever the browser consumes, and the operating system
# pipe between them only holds tens of kilobytes. Read ahead into memory instead
# so a disk latency spike cannot starve the decoder mid-playback.
# A copied stream may start slightly past the click if that lands far closer than
# the previous index point, but never far enough to skip a scene.
_MAX_SEEK_OVERSHOOT_SECONDS = 4.0
_PIPE_LIMIT_BYTES = 4 * 1024 * 1024
_READAHEAD_BYTES = 48 * 1024 * 1024
_VTT_TIMING = re.compile(
    r"^(?P<start>(?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+"
    r"(?P<end>(?:\d{2}:)?\d{2}:\d{2}\.\d{3})(?P<settings>.*)$"
)
# The short FFmpeg runs that answer a question about a film — where a seek lands,
# what streams it has. Each request used to start its own, so a burst of
# ``stereo-keyframe`` requests from a scrubbing viewer started one FFmpeg per
# request, every one of them opening the film. They now share a few slots; a probe
# that cannot get one in time gives the answer it gives on any failure (land on
# the click, nothing known), which is a slower seek, not an error.
_PROBE_SLOTS = 4
_PROBE_QUEUE_SECONDS = 15.0
# How long FFmpeg gets to describe a film. A viewer is waiting for the answer, so
# a slow one is given up for "nothing known". The background pass is waiting for
# nobody, and "nothing known" made it pass over the film without a word: the
# first full run passed over 23 films that way, 16 of them within three minutes,
# and every one of them was described in a tenth of a second when asked again.
_PROBE_SECONDS = 12.0
_BACKGROUND_PROBE_SECONDS = 60.0
# One gate per event loop: an asyncio primitive belongs to the loop it first
# waited on, and the tests run many loops in one process.
_PROBE_GATES: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = weakref.WeakKeyDictionary()
# A WebVTT conversion bigger than this is not a subtitle.
_WEBVTT_MAX_BYTES = 16 * 1024 * 1024
# Transport and program streams. FFmpeg sets the zero of such a file by the
# streams in use rather than by the file, so what is decoded together with what
# changes where a subtitle lands (see subtitle_pictures).
RESTAMPED_SUFFIXES = frozenset({".ts", ".m2ts", ".mts", ".vob", ".mpg", ".mpeg"})


class _ProbeBusy(Exception):
    """Every probe slot stayed taken for longer than a probe is worth waiting."""


def _probe_gate() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    gate = _PROBE_GATES.get(loop)
    if gate is None:
        gate = _PROBE_GATES[loop] = asyncio.Semaphore(_PROBE_SLOTS)
    return gate


@asynccontextmanager
async def _probe_slot():
    gate = _probe_gate()
    try:
        await asyncio.wait_for(gate.acquire(), timeout=_PROBE_QUEUE_SECONDS)
    except TimeoutError as exc:
        raise _ProbeBusy from exc
    try:
        yield
    finally:
        gate.release()


class CompatibleProcessRegistry:
    """Own every cancellable resource used by one browser viewer generation.

    A browser may abandon a chunked response without letting Starlette finalize its
    generator. Keeping its lease here lets DELETE or the next seek reclaim the slot.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._generations: dict[str, int] = {}
        self._processes: dict[str, tuple[int, asyncio.subprocess.Process]] = {}
        self._leases: dict[str, tuple[int, Any]] = {}

    async def begin(self, stream_id: str) -> int:
        previous: asyncio.subprocess.Process | None = None
        previous_lease: Any | None = None
        async with self._lock:
            generation = self._generations.get(stream_id, 0) + 1
            self._generations[stream_id] = generation
            registered = self._processes.pop(stream_id, None)
            if registered is not None:
                previous = registered[1]
            registered_lease = self._leases.pop(stream_id, None)
            if registered_lease is not None:
                previous_lease = registered_lease[1]
        operations = []
        if previous is not None:
            operations.append(_stop_process(previous))
        if previous_lease is not None:
            operations.append(previous_lease.release())
        if operations:
            # Both entries are already out of the registry, so nobody else will
            # stop that FFmpeg or return that slot. A request abandoned while it
            # waits here must not abandon them too; the stop is bounded, so the
            # shield cannot hold anybody for long.
            with anyio.CancelScope(shield=True):
                await asyncio.gather(*operations, return_exceptions=True)
        return generation

    async def bind_lease(self, stream_id: str, generation: int, lease: Any) -> bool:
        async with self._lock:
            if self._generations.get(stream_id) != generation:
                return False
            self._leases[stream_id] = (generation, lease)
            return True

    async def discard_lease(self, stream_id: str, generation: int, lease: Any) -> None:
        async with self._lock:
            registered = self._leases.get(stream_id)
            if registered == (generation, lease):
                self._leases.pop(stream_id, None)
            self._prune(stream_id, generation)

    async def attach(self, stream_id: str, generation: int, process: asyncio.subprocess.Process) -> bool:
        async with self._lock:
            if self._generations.get(stream_id) != generation:
                return False
            self._processes[stream_id] = (generation, process)
            return True

    async def discard(self, stream_id: str, generation: int, process: asyncio.subprocess.Process) -> None:
        async with self._lock:
            registered = self._processes.get(stream_id)
            if registered == (generation, process):
                self._processes.pop(stream_id, None)
            self._prune(stream_id, generation)

    def _prune(self, stream_id: str, generation: int) -> None:
        """Drop the generation counter once no process or lease references it.

        Called under ``self._lock``. Without this every distinct stream_id ever
        seen would stay in ``_generations`` for the life of the service.

        Only the newest generation may drop it. The stream a seek just retired
        winds down while the seek is still between ``begin()`` and
        ``bind_lease()``; pruning from there dropped the seek's own counter, and
        the seek was refused with 409 as if something newer had superseded it.
        """
        if (
            self._generations.get(stream_id) == generation
            and stream_id not in self._processes
            and stream_id not in self._leases
        ):
            self._generations.pop(stream_id, None)

    async def is_current(self, stream_id: str, generation: int) -> bool:
        async with self._lock:
            return self._generations.get(stream_id) == generation

    async def close_all(self) -> None:
        async with self._lock:
            processes = [entry[1] for entry in self._processes.values()]
            leases = [entry[1] for entry in self._leases.values()]
            self._processes.clear()
            self._leases.clear()
            self._generations.clear()
        await asyncio.gather(
            *(_stop_process(process) for process in processes),
            *(lease.release() for lease in leases),
            return_exceptions=True,
        )


def _audio_profile(profile: str, config: StereoConfig) -> tuple[int | None, int]:
    profiles = {"stereo_low": (2, 128), "stereo_standard": (2, config.bitrate_kbps), "stereo_high": (2, 320), "surround_aac": (None, 512)}
    return profiles.get(profile, profiles["stereo_standard"])


def copies_video(video_codec: str | None, video_profile: str = "native_copy") -> bool:
    """Report whether the picture is passed through untouched rather than re-encoded."""
    normalized_codec = (video_codec or "").lower()
    force_h264 = video_profile == "h264_fallback" and normalized_codec not in {"h264", "avc1"}
    return video_codec is None or (normalized_codec in _NATIVE_COPY_VIDEO_CODECS and not force_h264)


async def _seek_landing(item: ResolvedItem, config: StereoConfig, seek_seconds: float) -> float | None:
    """Report the exact instant a copied stream begins for a given seek request.

    FFmpeg hands a copied stream to the muxer from whichever index point the
    demuxer reached, which can sit seconds before the requested time and is not
    one of the keyframes a packet listing reports. Decoding a single frame with
    the real seek flags and reading its timestamp is the only reliable answer.
    """
    if config.ffmpeg_path is None:
        return None
    command = [
        config.ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-noaccurate_seek", "-ss", f"{seek_seconds:.3f}", "-copyts",
        "-i", str(item.path),
        "-map", "0:v:0", "-c", "copy", "-frames:v", "1", "-f", "framemd5", "-",
    ]
    try:
        async with _probe_slot():
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            read_at_normal_priority(process.pid)
            stdout, _ = await _communicate_bounded(process, 20)
    except (OSError, TimeoutError, _ProbeBusy):
        return None
    if process.returncode != 0 or stdout is None:
        return None
    scale = 1.0
    for line in stdout.decode("ascii", errors="ignore").splitlines():
        stripped = line.strip()
        if stripped.startswith("#tb"):
            numerator, _, denominator = stripped.split()[-1].partition("/")
            try:
                scale = int(numerator) / int(denominator)
            except (ValueError, ZeroDivisionError):
                return None
            continue
        if stripped.startswith("#") or not stripped:
            continue
        fields = [field.strip() for field in stripped.split(",")]
        if len(fields) < 3:
            continue
        try:
            return int(fields[2]) * scale
        except ValueError:
            return None
    return None


async def resolve_seek_plan(
    item: ResolvedItem,
    config: StereoConfig,
    target_seconds: float,
    duration_seconds: float | None = None,
) -> tuple[float, float]:
    """Choose the seek request that starts a copied stream closest to the click.

    Returns the value to hand FFmpeg together with the instant playback will
    really begin. The two differ, and asking FFmpeg for the landing time is not
    the same as asking for the original target: seeking exactly onto an index
    point steps back to the one before it, so the request must be replayed
    verbatim rather than fed back in.
    """
    if target_seconds <= 0:
        return 0.0, 0.0
    try:
        # Off the event loop: on a network share one stat is a round trip.
        info = await asyncio.to_thread(item.path.stat)
        cache_key = (str(item.path), info.st_mtime_ns, info.st_size, round(target_seconds, 3))
    except OSError:
        cache_key = (str(item.path), 0, 0, round(target_seconds, 3))
    if (memoized := _SEEK_PLAN_CACHE.get(cache_key)) is not None:
        return memoized

    landing = await _seek_landing(item, config, target_seconds)
    if landing is None:
        return target_seconds, target_seconds
    plan = (target_seconds, landing)

    # Landing far behind the click means the index is sparse here. Asking just
    # past the gap usually reaches the next index point, which can sit much
    # closer to what was actually clicked.
    shortfall = target_seconds - landing
    if shortfall > 2.0:
        ceiling = None if duration_seconds is None else duration_seconds - 2.0
        probe = target_seconds + shortfall + 0.25
        if ceiling is None or probe <= ceiling:
            forward = await _seek_landing(item, config, probe)
            # Overshooting skips material the viewer asked to see, so a later
            # landing only wins when it is both closer and barely past the click.
            overshoot = 0.0 if forward is None else forward - target_seconds
            if (
                forward is not None
                and abs(forward - target_seconds) < shortfall
                and overshoot <= _MAX_SEEK_OVERSHOOT_SECONDS
            ):
                plan = (probe, forward)

    if len(_SEEK_PLAN_CACHE) >= 4096:
        _SEEK_PLAN_CACHE.pop(next(iter(_SEEK_PLAN_CACHE)))
    _SEEK_PLAN_CACHE[cache_key] = plan
    return plan



def compatible_stream_command(
    item: ResolvedItem,
    config: StereoConfig,
    start_seconds: float = 0.0,
    audio_track: int = 0,
    subtitle_track: int = -1,
    video_codec: str | None = None,
    audio_profile: str = "stereo_standard",
    video_profile: str = "native_copy",
) -> list[str]:
    """Build a shell-free FFmpeg command for an immediately playable fragmented MP4."""
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    command = [
        config.ffmpeg_path,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    normalized_codec = (video_codec or "").lower()
    copy_video = copies_video(video_codec, video_profile)
    transcode_video = not copy_video
    # Seek on the input only. Trimming a copied stream on the output side keeps
    # the preceding keyframe but drops every inter frame up to the cut, stranding
    # the browser on one still picture for a whole group of pictures.
    #
    # ``-noaccurate_seek`` is what holds sound and picture together. Copied video
    # has to begin wherever the demuxer landed; with accurate seeking the audio
    # would instead be decoded and trimmed to the exact request, so the two
    # streams would start at different moments of the film.
    if start_seconds > 0:
        command.extend(["-ss", f"{start_seconds:.3f}", "-noaccurate_seek"])
    cuda_decode = transcode_video and config.video_encoder == "h264_nvenc" and normalized_codec in {"hevc", "h265"}
    if cuda_decode:
        command.extend(["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"])
    command.extend(["-i", str(item.path)])
    command.extend(
        [
            "-map",
            "0:v:0",
            "-map",
            f"0:a:{audio_track}?",
            "-map_metadata",
            "-1",
        ]
    )
    if copy_video:
        command.extend(["-c:v", "copy"])
        if tag := _MP4_VIDEO_TAGS.get(normalized_codec):
            command.extend(["-tag:v", tag])
    else:
        if config.video_encoder == "h264_nvenc":
            if cuda_decode:
                command.extend(["-vf", "scale_cuda=format=nv12"])
            command.extend(["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll", "-rc", "constqp",
                            "-qp", "26", "-g", "48"])
        else:
            command.extend(
                ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "48"]
            )
    channels, audio_bitrate = _audio_profile(audio_profile, config)
    # No ``first_pts=0``: it pins the transcoded audio to timestamp zero. When the
    # demuxer lands earlier than requested the copied picture starts there while
    # the audio has been trimmed to the request, and pinning hides that gap
    # instead of preserving it, so the sound runs ahead of the picture by a whole
    # seek interval. Paired with ``-noaccurate_seek`` both streams now begin at
    # the same instant and stay together.
    audio_options = ["-c:a", "aac", *(["-ac", str(channels)] if channels is not None else []), "-af", "aresample=48000:async=1000", "-b:a", f"{audio_bitrate}k"]
    command.extend(
        [
            *audio_options,
            "-avoid_negative_ts",
            "make_zero",
            "-fps_mode:v",
            "passthrough",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration",
            "2000000",
            "-f",
            "mp4",
            "pipe:1",
        ]
    )
    return command


class ProbeFailed(Exception):
    """FFmpeg gave no description of a film; the message says why."""


async def _probe_header(item: ResolvedItem, config: StereoConfig, deadline: float) -> bytes:
    """What FFmpeg says about the film's container (its stderr for ``-i``), or ``ProbeFailed``."""
    if config.ffmpeg_path is None:
        raise ProbeFailed("FFmpeg is not configured")
    try:
        async with _probe_slot():
            process = await asyncio.create_subprocess_exec(
                config.ffmpeg_path,
                "-nostdin",
                "-hide_banner",
                "-i",
                str(item.path),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            # A few megabytes somebody is waiting for: not at the low I/O priority
            # a scheduled task gives the service, behind every other reader of
            # the disk (priority.py).
            read_at_normal_priority(process.pid)
            _, stderr = await _communicate_bounded(process, deadline)
    except _ProbeBusy as exc:
        raise ProbeFailed(f"no probe slot came free within {_PROBE_QUEUE_SECONDS:g} s") from exc
    except TimeoutError as exc:
        raise ProbeFailed(f"FFmpeg did not describe the file within {deadline:g} s") from exc
    except OSError as exc:
        raise ProbeFailed(f"FFmpeg could not be started: {exc}") from exc
    return stderr or b""


async def _probe_stderr(item: ResolvedItem, config: StereoConfig) -> bytes | None:
    try:
        return await _probe_header(item, config, _PROBE_SECONDS)
    except ProbeFailed:
        return None


# FFmpeg's log prefixes: which component spoke, at which address. Neither says
# anything to whoever reads why a film failed.
_FFMPEG_CONTEXT = re.compile(r"^(?:\[[^\]]*@\s*(?:0x)?[0-9A-Fa-f]+\]\s*)+")
# Lines FFmpeg ends every failure with, which repeat the line before them less
# precisely — and the one it ends every description with, since ``ffmpeg -i``
# is asked for no output.
_FFMPEG_GENERIC = (
    "Task finished with error",
    "Terminating thread with error",
    "Conversion failed!",
    "At least one output file must be specified",
)
# The line FFmpeg starts a description of a container it could open with.
_FFMPEG_INPUT = re.compile(rb"^Input #\d+, ", re.MULTILINE)


def ffmpeg_reason(stderr: bytes | None, path: Path | None = None) -> str:
    """FFmpeg's own words for what went wrong: its last line that says something.

    Without FFmpeg's internal addresses, and without the film's absolute path —
    whoever records the reason names the film already.
    """
    telling: list[str] = []
    for raw in (stderr or b"").decode("utf-8", errors="replace").splitlines():
        line = _FFMPEG_CONTEXT.sub("", raw.strip())
        if path is not None:
            line = line.replace(str(path), "").lstrip(": ").strip()
        if line and not line.startswith(_FFMPEG_GENERIC):
            telling.append(line)
    return telling[-1][:200] if telling else "FFmpeg said nothing"


def _duration(stderr: bytes) -> float | None:
    match = _DURATION_PATTERN.search(stderr)
    if match is None:
        return None
    hours, minutes, seconds = match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return duration if math.isfinite(duration) and 0 < duration <= 604800 else None



def _stream_facts(codec: str, details: str) -> dict[str, Any]:
    """
    What ffmpeg reported about one stream, as data rather than as a sentence.

    This used to return a finished Polish label ("Polski · AC3 5.1 · 384 kb/s ·
    domyślna"), which meant the one part of the interface the browser could not
    translate. The parts go out instead and the player writes the sentence in
    whichever language the account chose; nothing ffmpeg left out is guessed.
    """
    facts: dict[str, Any] = {"codec": codec.lower()}
    channel = re.search(r",\s*(mono|stereo|\d+\.\d+(?:\(side\))?)\b", details, re.IGNORECASE)
    if channel is not None:
        facts["channel_layout"] = channel.group(1).replace("(side)", "").lower()
    bitrate = re.search(r",\s*(\d+)\s*kb/s", details)
    if bitrate is not None:
        facts["bitrate_kbps"] = int(bitrate.group(1))
    if re.search(r"\(default\)", details):
        facts["default"] = True
    if re.search(r"\(forced\)", details):
        facts["forced"] = True
    return facts


def external_subtitle_files(item: ResolvedItem) -> list[Path]:
    """Subtitle files left next to the film, in a stable order.

    Only the film's own directory is searched, and only files whose name starts
    with the film's: ``Film (2019).pl.srt`` and ``Film (2019).srt`` belong to
    ``Film (2019).mkv`` and nothing else does. A ``Subs/`` folder is a common
    convention and is deliberately **not** followed — such a folder often sits
    next to a whole season, its files are numbered rather than named, and pairing
    them up is guesswork. A wrongly paired subtitle is not a visible failure; it
    is the wrong words, on time, looking exactly like the right ones.

    Where several films share a folder, a sidecar goes to the one with the
    **longest** matching name: ``Film 2.pl.srt`` starts with ``Film`` too, and
    handing it to ``Film.mkv`` would be a wrong subtitle offered as a right one.

    The order is by lower-cased name, because the position in this list is what
    a track index refers to and it must not depend on the filesystem's mood.

    Only plain files count. A symbolic link or a junction named ``Film.pl.srt``
    can point anywhere the service account can read, and FFmpeg would follow it
    and hand back whatever it found as "subtitles" — the catalogue scan refuses
    links for the same reason. Blocking: listing a folder on a network share is a
    round trip per call, so callers on the event loop run this in a thread.
    """
    try:
        directory = item.path.parent
        stem = item.path.stem
        entries = sorted(directory.iterdir(), key=lambda path: path.name.lower())
    except OSError:
        return []
    rivals = [
        entry.stem
        for entry in entries
        if entry.suffix.lower() in _VIDEO_SUFFIXES and len(entry.stem) > len(stem)
    ]
    found: list[Path] = []
    for candidate in entries:
        if candidate.suffix.lower() not in _EXTERNAL_SUBTITLE_SUFFIXES:
            continue
        if not _names_the_same_film(stem, candidate.stem):
            continue
        if any(_names_the_same_film(rival, candidate.stem) for rival in rivals):
            continue
        facts = _plain_file(candidate)
        if facts is None or facts.st_size > _EXTERNAL_SUBTITLE_MAX_BYTES:
            continue
        if candidate.suffix.lower() == ".sub" and sidecar_format(candidate) != "microdvd":
            continue
        found.append(candidate)
        if len(found) >= _EXTERNAL_SUBTITLE_LIMIT:
            break
    return found


def sidecar_format(path: Path) -> str | None:
    """What a ``.sub`` holds: ``"microdvd"``, ``"vobsub"`` or None for anything else.

    Decided by the first bytes, never by the name. VobSub's ``.sub`` is an MPEG
    program stream and opens with a pack header. MicroDVD is text whose every line
    starts ``{start}{end}`` (frames, not times); the first three lines that are not
    empty have to look like that, as FFmpeg's own probe requires. Blocking: reads
    the start of the file.
    """
    try:
        with path.open("rb") as handle:
            sample = handle.read(_SIDECAR_SNIFF_BYTES)
    except OSError:
        return None
    if sample.startswith(_MPEG_PACK_HEADER):
        return "vobsub"
    if sample.startswith(b"\xef\xbb\xbf"):
        sample = sample[3:]
    lines = [line.strip() for line in sample.splitlines() if line.strip()]
    # The last line of the sample may be cut short; it is not evidence either way.
    if len(sample) >= _SIDECAR_SNIFF_BYTES and len(lines) > 1:
        lines = lines[:-1]
    head = lines[:3]
    if head and all(_MICRODVD_LINE.match(line) for line in head):
        return "microdvd"
    return None


def stream_frame_rate(details: str) -> str | None:
    """The frame rate in FFmpeg's description of a video stream, as FFmpeg will read it back.

    FFmpeg prints it rounded to two decimals; the NTSC rates it rounds are given
    back as the fractions they are (``23.98`` is ``24000/1001``). ``tbr`` stands in
    when a stream states no ``fps``.
    """
    match = re.search(r"(\d+(?:\.\d+)?)\s+fps\b", details) or re.search(r"(\d+(?:\.\d+)?)\s+tbr\b", details)
    if match is None:
        return None
    value = float(match.group(1))
    if not 1.0 <= value <= 1000.0:
        return None
    for nominal in _NTSC_RATES:
        if abs(value - nominal * 1000 / 1001) < 0.006:
            return f"{nominal * 1000}/1001"
    if abs(value - round(value)) < 0.006:
        return str(round(value))
    return f"{value:g}"


def _plain_file(path: Path) -> os.stat_result | None:
    """The file's own facts if it is a regular file and no kind of link; None otherwise."""
    try:
        facts = path.lstat()
    except OSError:
        return None
    if stat.S_ISLNK(facts.st_mode) or not stat.S_ISREG(facts.st_mode):
        return None
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    if reparse and getattr(facts, "st_file_attributes", 0) & reparse:
        return None
    return facts


def _names_the_same_film(film_stem: str, candidate_stem: str) -> bool:
    """Whether a sidecar's name is the film's, optionally with a marker after it."""
    film = film_stem.casefold()
    candidate = candidate_stem.casefold()
    if candidate == film:
        return True
    return candidate.startswith(film) and candidate[len(film) :][:1] in {".", "-", "_", " "}


def _external_subtitle_track(item: ResolvedItem, path: Path, index: int) -> dict[str, Any]:
    """One sidecar described the way an embedded track is described.

    Only the marker after the film's name travels to the browser — never the file
    name and never the path. That is enough to tell two sidecars apart, and it
    says nothing about how the library is laid out, which is the same rule the
    playlist export follows.
    """
    marker = path.stem[len(item.path.stem) :].strip(" ._-")
    tokens = [token for token in re.split(r"[._\-\s]+", marker.casefold()) if token]
    language = "und"
    for token in tokens:
        resolved = _EXTERNAL_LANGUAGE_TOKENS.get(token)
        if resolved is not None:
            language = resolved
            break
    return {
        "index": index,
        "stream_index": -1,
        "language": language,
        "codec": _SIDECAR_CODECS.get(path.suffix.lower(), path.suffix.lstrip(".").lower()),
        "supported": True,
        "source": "external",
        "forced": "forced" in tokens or "wymuszone" in tokens,
        **({"title": marker} if marker else {}),
    }


def external_subtitle_path(
    item: ResolvedItem, media_info: dict[str, Any], subtitle_track: int
) -> Path | None:
    """The sidecar a track index means, or None when the track is inside the file.

    Resolved here rather than carried in the probe result, so no absolute path is
    ever part of what ``/v1/stereo-info`` hands the browser. The client only ever
    names a track by number.
    """
    tracks = media_info.get("subtitle_tracks", [])
    chosen = next((track for track in tracks if int(track.get("index", -1)) == subtitle_track), None)
    if chosen is None or chosen.get("source") != "external":
        return None
    ordinal = sum(
        1
        for track in tracks
        if track.get("source") == "external" and int(track.get("index", -1)) < subtitle_track
    )
    files = external_subtitle_files(item)
    return files[ordinal] if ordinal < len(files) else None


async def find_external_subtitle(
    item: ResolvedItem, media_info: dict[str, Any], subtitle_track: int
) -> Path | None:
    """``external_subtitle_path`` off the event loop: it lists the film's folder."""
    return await asyncio.to_thread(external_subtitle_path, item, media_info, subtitle_track)


def _probe_cache_key(item: ResolvedItem) -> tuple[str, int, int, int]:
    try:
        facts = item.path.stat()
        # The directory's own timestamp is part of the key because the answer now
        # includes what lies beside the film: a subtitle file dropped in next to
        # it changes nothing about the film, and without this the new track would
        # not appear until the service restarted.
        return (str(item.path), facts.st_mtime_ns, facts.st_size, item.path.parent.stat().st_mtime_ns)
    except OSError:
        return (str(item.path), 0, 0, 0)


async def probe_media_info(item: ResolvedItem, config: StereoConfig) -> dict[str, Any]:
    """Read duration and stream choices from the container header without decoding the movie."""
    # Two stats on what may be a network share: a thread, not the event loop.
    cache_key = await asyncio.to_thread(_probe_cache_key, item)
    cached = _PROBE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    external = await asyncio.to_thread(external_subtitle_files, item)
    stderr = await _probe_stderr(item, config)
    if stderr is None:
        return _unprobed_media_info(item, external)
    return _remember_probe(cache_key, _parsed_media_info(item, external, stderr))


def described(media_info: dict[str, Any]) -> bool:
    """Whether a probe learned anything about the container itself."""
    return media_info.get("duration_seconds") is not None or media_info.get("video_codec") is not None


async def probe_media_info_patiently(
    item: ResolvedItem,
    config: StereoConfig,
    *,
    attempts: int = 2,
    pause_seconds: float = 10.0,
) -> tuple[dict[str, Any], str | None]:
    """``probe_media_info`` for the background pass: the same answer, or why there is none.

    The pass is waiting for nobody, so FFmpeg gets a minute rather than a viewer's
    twelve seconds, a probe that failed is asked once more after a pause, and what
    is still not known comes back with its reason, for the pass to count and log —
    it used to take "nothing known" for a film with nothing in it.
    """
    cache_key = await asyncio.to_thread(_probe_cache_key, item)
    cached = _PROBE_CACHE.get(cache_key)
    if cached is not None and described(cached):
        return cached, None
    external = await asyncio.to_thread(external_subtitle_files, item)
    reason = "FFmpeg was not asked"
    for attempt in range(max(1, attempts)):
        if attempt:
            await asyncio.sleep(pause_seconds)
        try:
            stderr = await _probe_header(item, config, _BACKGROUND_PROBE_SECONDS)
        except ProbeFailed as exc:
            reason = str(exc)
            continue
        media_info = _parsed_media_info(item, external, stderr)
        if not described(media_info) and _FFMPEG_INPUT.search(stderr) is None:
            # FFmpeg answered, and the answer was that it cannot read the file:
            # asking again gets the same answer.
            return media_info, ffmpeg_reason(stderr, item.path)
        # Opened and listed — even with no picture and no duration. A Blu-ray
        # folder's menu clips are 3 MB of one interactive-graphics stream (seven
        # of them in Happy Death Day's 4K folders); there is nothing in them to
        # convert, which is an answer, not a failure.
        return _remember_probe(cache_key, media_info), None
    return _unprobed_media_info(item, external), reason


def _remember_probe(cache_key: tuple[str, int, int, int], media_info: dict[str, Any]) -> dict[str, Any]:
    if len(_PROBE_CACHE) >= 256:
        _PROBE_CACHE.pop(next(iter(_PROBE_CACHE)))
    _PROBE_CACHE[cache_key] = media_info
    return media_info


def _unprobed_media_info(item: ResolvedItem, external: list[Path]) -> dict[str, Any]:
    # No FFmpeg answer means nothing is known about the container — but a
    # subtitle lying next to the film is known regardless, so it is still
    # offered rather than withheld because a different question failed.
    return {
        "duration_seconds": None,
        "video_codec": None,
        "video_width": None,
        "video_height": None,
        "video_frame_rate": None,
        "video_transcoded": False,
        "audio_tracks": [],
        "subtitle_tracks": [
            _external_subtitle_track(item, path, index) for index, path in enumerate(external)
        ],
    }


def _parsed_media_info(item: ResolvedItem, external: list[Path], stderr: bytes) -> dict[str, Any]:
    video_codec: str | None = None
    video_width: int | None = None
    video_height: int | None = None
    video_frame_rate: str | None = None
    audio_tracks: list[dict[str, Any]] = []
    subtitle_tracks: list[dict[str, Any]] = []
    for match in _STREAM_PATTERN.finditer(stderr):
        kind = match.group("kind").decode("ascii", errors="ignore")
        codec = match.group("codec").decode("ascii", errors="ignore").lower()
        language = (match.group("language") or b"und").decode("ascii", errors="ignore").lower()
        details = match.group("details").decode("utf-8", errors="replace")
        if kind == "Video":
            video_codec = codec
            # The picture's size, which a subtitle drawn on its own canvas has to
            # be mapped onto. First WxH in the line is the resolution; the ratios
            # after it are written with colons and cannot be confused for it.
            size = re.search(r"\b(\d{2,5})x(\d{2,5})\b", details)
            if size is not None and video_width is None:
                video_width, video_height = int(size.group(1)), int(size.group(2))
            # What a MicroDVD sidecar's frame numbers are counted in, unless the
            # file says so itself on its first line.
            if video_frame_rate is None:
                video_frame_rate = stream_frame_rate(details)
            continue
        target = audio_tracks if kind == "Audio" else subtitle_tracks
        ordinal = len(target)
        entry = {
            "index": ordinal,
            "stream_index": int(match.group("stream")),
            "language": language,
            "codec": codec,
            **_stream_facts(codec, details),
        }
        if kind == "Subtitle":
            entry["supported"] = codec in _TEXT_SUBTITLE_CODECS
            entry["source"] = "embedded"
            # The frame a picture subtitle was drawn for, when the container says
            # so. VobSub states it; PGS does not, and guessing wrong clips the
            # words off the bottom — see subtitle_pictures.subtitle_canvas.
            canvas = re.search(r"\b(\d{2,5})x(\d{2,5})\b", details)
            if canvas is not None:
                entry["canvas_width"] = int(canvas.group(1))
                entry["canvas_height"] = int(canvas.group(2))
            # A picture of text is flagged rather than called "supported": the
            # answer to a request for it is "not yet", not "here it is".
            #
            # Whether anything can *read* that picture is deliberately not
            # recorded here. This result is cached against the file, and whether
            # OCR is installed is a fact about the installation, not about the
            # film — cached together, the two would go out of step the moment
            # the configuration changed.
            if codec in IMAGE_SUBTITLE_CODECS:
                entry["image"] = True
        target.append(entry)
    # Sidecars continue the same numbering, so a track is still named by one
    # integer everywhere: in the selector, in the request, and in the cache key.
    for path in external:
        subtitle_tracks.append(_external_subtitle_track(item, path, len(subtitle_tracks)))
    return {
        "duration_seconds": _duration(stderr),
        "video_codec": video_codec,
        "video_width": video_width,
        "video_height": video_height,
        "video_frame_rate": video_frame_rate,
        "video_transcoded": video_codec is not None and video_codec not in _NATIVE_COPY_VIDEO_CODECS,
        "audio_tracks": audio_tracks,
        "subtitle_tracks": subtitle_tracks,
    }


# How long a stopped FFmpeg gets to leave by itself, and how long it is waited for
# after the kill. Neither may be open-ended: whoever stops a stream is usually a
# viewer's seek, waiting for its own answer.
_STOP_GRACE_SECONDS = 3.0
_REAP_SECONDS = 5.0


def _release_pipes(process: asyncio.subprocess.Process) -> None:
    """Close our ends of the child's stdout and stderr.

    Since Python 3.12 ``Process.wait()`` resolves only once the child has exited
    **and** every pipe to it has reached its end. A pipe the event loop stopped
    reading — the read-ahead buffer is full because the viewer paused, or its
    reader was cancelled — never reaches it, so a wait that began before the child
    died was never answered: the seek that stopped FFmpeg hung with it, up to the
    proxy's hour-long timeout. Closing our ends answers that wait, and it also ends
    an FFmpeg blocked writing into the full pipe, which SIGTERM does not.

    ``Process`` offers no public way to its pipes; ``get_pipe_transport`` is public
    on the transport, and the attribute holding the transport is the one private
    step. Without it (another event loop implementation) nothing is closed, and the
    bounded waits in ``_stop_process`` still keep the caller from hanging forever.
    """
    transport = getattr(process, "_transport", None)
    get_pipe = getattr(transport, "get_pipe_transport", None)
    if get_pipe is None:
        return
    for fd in (1, 2):
        pipe = get_pipe(fd)
        if pipe is not None and not pipe.is_closing():
            pipe.close()


async def _exited_within(process: asyncio.subprocess.Process, seconds: float) -> bool:
    try:
        await asyncio.wait_for(process.wait(), timeout=seconds)
    except TimeoutError:
        return False
    return True


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    """Stop a child for good and wait for it: boundedly, and all the way through.

    Shielded, because every caller is a cleanup — the ``finally`` of a response
    Starlette is cancelling, or a seek retiring the stream before it — and a stop
    cancelled halfway left FFmpeg running and its slot taken. It takes at most
    ``_STOP_GRACE_SECONDS + _REAP_SECONDS``, so the shield cannot hold anyone long.
    """
    with anyio.CancelScope(shield=True):
        if process.returncode is None:
            with suppress(OSError):
                process.terminate()
        _release_pipes(process)
        if await _exited_within(process, _STOP_GRACE_SECONDS):
            return
        with suppress(OSError):
            process.kill()
        if not await _exited_within(process, _REAP_SECONDS):
            LOGGER.warning(
                "ffmpeg did not exit after kill",
                extra={"event": "ffmpeg_stop_timeout", "pid": process.pid},
            )


async def _communicate_bounded(
    process: asyncio.subprocess.Process, seconds: float
) -> tuple[bytes | None, bytes | None]:
    """``communicate()`` with a deadline that never leaves the child behind.

    A probe past its deadline used to be abandoned rather than stopped, so it went
    on reading the film in the background — and so did one whose request was
    cancelled. Either way it is stopped here before the caller moves on.
    """
    try:
        return await asyncio.wait_for(process.communicate(), timeout=seconds)
    except BaseException:
        await _stop_process(process)
        raise


async def compatible_media_chunks(
    item: ResolvedItem,
    config: StereoConfig,
    chunk_size: int,
    start_seconds: float = 0.0,
    audio_track: int = 0,
    subtitle_track: int = -1,
    video_codec: str | None = None,
    audio_profile: str = "stereo_standard",
    video_profile: str = "native_copy",
    stream_id: str = "",
    stream_generation: int = 0,
    process_registry: CompatibleProcessRegistry | None = None,
) -> AsyncIterator[bytes]:
    """Remux or transcode video and downmix selected audio while the response is consumed."""
    command = compatible_stream_command(
        item, config, start_seconds, audio_track, subtitle_track, video_codec, audio_profile, video_profile
    )
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_PIPE_LIMIT_BYTES,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        raise StereoTranscodeError("FFmpeg compatibility stream could not start") from exc
    if stream_id and process_registry is not None:
        attached = await process_registry.attach(stream_id, stream_generation, process)
        if not attached:
            await _stop_process(process)
            raise StereoTranscodeError("Compatibility stream was superseded by a newer seek")

    if process.stdout is None:
        await _stop_process(process)
        raise StereoTranscodeError("FFmpeg did not expose its output stream")

    deadline = time.monotonic() + config.timeout_seconds
    stderr_task = asyncio.create_task(process.stderr.read()) if process.stderr is not None else None
    stderr = b""
    # Let FFmpeg run ahead of the browser instead of being throttled by the small
    # operating system pipe. Without this the encoder only advances when the
    # player asks for more, so any disk stall reaches the decoder as a stutter.
    stdout = process.stdout
    buffer: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=max(4, _READAHEAD_BYTES // max(1, chunk_size)))

    async def fill() -> None:
        try:
            while True:
                block = await stdout.read(chunk_size)
                if not block:
                    break
                await buffer.put(block)
        finally:
            # The reader may already be gone, so never block on handing over the
            # end marker; a cancelled pump must be able to finish unwinding.
            with suppress(asyncio.QueueFull):
                buffer.put_nowait(None)

    fill_task = asyncio.create_task(fill())
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StereoTranscodeError("FFmpeg compatibility stream timed out")
            try:
                chunk = await asyncio.wait_for(buffer.get(), timeout=remaining)
            except TimeoutError as exc:
                raise StereoTranscodeError("FFmpeg compatibility stream timed out") from exc
            if chunk is None:
                break
            yield chunk
        await fill_task
        return_code = await process.wait()
        if stderr_task is not None:
            stderr = await stderr_task
        if return_code != 0:
            if stream_id and process_registry is not None and not await process_registry.is_current(stream_id, stream_generation):
                return
            detail = stderr.decode("utf-8", errors="replace").replace(str(item.path), "<media>").strip()
            if len(detail) > 1200:
                detail = detail[-1200:]
            suffix = f": {detail}" if detail else ""
            raise StereoTranscodeError(f"FFmpeg compatibility stream failed (exit {return_code}){suffix}")
    finally:
        # A viewer who leaves mid-stream gets this body cancelled through an anyio
        # cancel scope, and anyio cancels every later ``await`` in that scope too —
        # this one included. Unshielded, the cleanup stopped at its first line and
        # FFmpeg ran on with nobody reading it.
        with anyio.CancelScope(shield=True):
            if not fill_task.done():
                fill_task.cancel()
            await asyncio.gather(fill_task, return_exceptions=True)
            await _stop_process(process)
            if stream_id and process_registry is not None:
                await process_registry.discard(stream_id, stream_generation, process)
            if stderr_task is not None and not stderr_task.done():
                stderr_task.cancel()


def subtitle_charset(sample: bytes) -> str | None:
    """Which encoding to tell FFmpeg a sidecar is in, or None for UTF-8.

    A subtitle file carries no declaration of its encoding, and Polish releases
    are routinely CP1250 — read as UTF-8 they either fail outright or come out as
    replacement characters where every accented letter used to be. UTF-8 is
    self-checking enough that a file which decodes cleanly as UTF-8 practically
    always is UTF-8, so that is tried first; anything else is assumed to be the
    Central-European codepage, which is the one this library meets.

    It is a guess, and worth being explicit about what a wrong one costs: wrong
    glyphs in a few words, with the timings and the meaning intact. Refusing the
    file instead costs the whole subtitle.
    """
    if sample.startswith(b"\xef\xbb\xbf"):
        return None
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError as error:
        # A truncated multi-byte character at the end of the sample is an artefact
        # of where we stopped reading, not evidence about the file.
        if error.start < len(sample) - 4:
            return _LEGACY_SUBTITLE_CHARSET
        return None
    return None


# The code page a subtitle that is not UTF-8 is read in — see subtitle_charset.
_LEGACY_SUBTITLE_CHARSET = "cp1250"
# What FFmpeg says, once per packet, about subtitle text that is not UTF-8.
_INVALID_UTF8 = b"Invalid UTF-8 in decoded subtitles text"


def _in_another_codepage(returncode: int, stdout: bytes, stderr: bytes) -> bool:
    """Whether a conversion read as UTF-8 says the text was in another code page.

    A Matroska text track is UTF-8 by definition, and some releases put CP1250 in
    one anyway (seven of The Pacific's eight Polish tracks). FFmpeg drops each packet it
    cannot read as UTF-8 — the cues with Polish letters — and gives up past two
    thirds of them; below that it says nothing and the track is converted
    without them. A tenth of the packets unreadable is no longer UTF-8 with a
    scratch in it, it is another code page; a UTF-8 track with one broken packet
    is not read again in CP1250, which would mangle every letter of it.
    """
    unreadable = stderr.count(_INVALID_UTF8)
    if unreadable == 0:
        return False
    return returncode != 0 or unreadable * 10 >= unreadable + stdout.count(b"-->")


class _OutputTooLarge(Exception):
    """A child wrote more than its ceiling."""


# What FFmpeg says while converting is read for one thing (_in_another_codepage);
# past this much of it the rest is let go.
_FFMPEG_NOTES_MAX_BYTES = 4 * 1024 * 1024


async def _read_capped(stream: asyncio.StreamReader | None, limit: int, *, strict: bool) -> bytes:
    """What a pipe says, up to ``limit`` bytes.

    ``strict`` stops at the first byte beyond it (``_OutputTooLarge``); otherwise
    the rest is read and dropped, so the child never blocks on a full pipe.
    """
    if stream is None:
        return b""
    kept: list[bytes] = []
    size = 0
    while chunk := await stream.read(64 * 1024):
        if size < limit:
            kept.append(chunk[: limit - size])
        size += len(chunk)
        if strict and size > limit:
            raise _OutputTooLarge
    return b"".join(kept)


def _read_bounded(path: Path, limit: int) -> bytes:
    """A file's bytes, or nothing when it is larger than ``limit`` — decided before it is read."""
    try:
        return path.read_bytes() if path.stat().st_size <= limit else b""
    except OSError:
        return b""


async def _run_webvtt(command: list[str], config: StereoConfig) -> tuple[int, bytes, bytes]:
    """One FFmpeg conversion to WebVTT on stdout: its return code, the output, what it said.

    The output is read with its ceiling in force. It used to be collected whole
    and measured afterwards, so a track that never ended was a process that
    never stopped growing.
    """
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        timeout = max(180.0, min(float(config.timeout_seconds), 600.0))
        running = process

        async def collect() -> tuple[bytes, bytes]:
            said = asyncio.ensure_future(_read_capped(running.stderr, _FFMPEG_NOTES_MAX_BYTES, strict=False))
            try:
                output = await _read_capped(running.stdout, _WEBVTT_MAX_BYTES, strict=True)
                notes = await said
            except BaseException:
                said.cancel()
                await asyncio.gather(said, return_exceptions=True)
                raise
            await running.wait()
            return output, notes

        stdout, stderr = await asyncio.wait_for(collect(), timeout=timeout)
    except _OutputTooLarge as exc:
        if process is not None:
            await _stop_process(process)
        raise StereoTranscodeError("Subtitle conversion failed: the track is implausibly large") from exc
    except TimeoutError as exc:
        if process is not None:
            await _stop_process(process)
        raise StereoTranscodeError("Subtitle conversion timed out") from exc
    except asyncio.CancelledError:
        if process is not None:
            await _stop_process(process)
        raise
    except OSError as exc:
        if process is not None:
            await _stop_process(process)
        raise StereoTranscodeError(f"Subtitle conversion failed: FFmpeg could not be started: {exc}") from exc
    returncode = -1 if process.returncode is None else process.returncode
    return returncode, stdout or b"", stderr or b""


def subtitle_webvtt_command(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    start_seconds: float = 0.0,
    source: Path | None = None,
    charset: str | None = None,
    frame_rate: str | None = None,
) -> list[str]:
    """Convert one subtitle track to WebVTT.

    ``source`` names a sidecar file; without it the track is read out of the film
    itself. A sidecar holds exactly one subtitle stream, so the track number does
    not travel into the mapping — the file *is* the track.

    A MicroDVD sidecar (``.sub``, offered only after ``sidecar_format`` said so)
    counts in frames. A file that names its rate on the first line (``{1}{1}25``)
    is read at that rate — FFmpeg's demuxer honours the line over anything given
    here — and any other at the film's own ``frame_rate``, not FFmpeg's 23.976
    default. The demuxer is named outright: FFmpeg's probe wants three MicroDVD
    lines, and a short file is still a subtitle.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    command = [config.ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error"]
    if start_seconds > 0:
        command.extend(["-ss", f"{start_seconds:.3f}"])
    if source is not None and charset is not None:
        command.extend(["-sub_charenc", charset])
    elif charset is not None:
        # An embedded track whose text is in another code page: the subtitle
        # decoders only, the film's video and audio have no text to convert.
        command.extend(["-sub_charenc:s", charset])
    if source is not None and _is_microdvd_sidecar(source):
        command.extend(["-f", "microdvd"])
        if frame_rate is not None:
            command.extend(["-subfps", frame_rate])
    command.extend(
        [
            "-i",
            str(source if source is not None else item.path),
            "-map",
            "0:s:0" if source is not None else f"0:s:{subtitle_track}",
            "-map_metadata",
            "-1",
            "-c:s",
            "webvtt",
            "-f",
            "webvtt",
            "pipe:1",
        ]
    )
    return command


def sanitize_webvtt(payload: bytes) -> bytes:
    """Drop trailing numeric SRT counters accidentally embedded in converted cue text."""
    text = payload.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    blocks = text.split("\n\n")
    sanitized: list[str] = []
    for block in blocks:
        lines = block.split("\n")
        timestamp_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timestamp_index >= 0:
            prefix = lines[: timestamp_index + 1]
            cue_text = lines[timestamp_index + 1 :]
            while cue_text and not cue_text[-1].strip():
                cue_text.pop()
            while len([line for line in cue_text if line.strip()]) > 1 and cue_text[-1].strip().isdigit():
                cue_text.pop()
            lines = [*prefix, *cue_text]
        sanitized.append("\n".join(lines).rstrip())
    return ("\n\n".join(sanitized).rstrip() + "\n").encode("utf-8")


def _parse_vtt_time(value: str) -> float:
    parts = value.split(":")
    if len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    else:
        hours, minutes, seconds = parts
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _format_vtt_time(value: float) -> str:
    milliseconds = max(0, round(value * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def shift_webvtt(payload: bytes, start_seconds: float) -> bytes:
    """Shift a cached full-track WebVTT to the local timeline of a seeked MP4 stream."""
    if start_seconds <= 0:
        return payload
    text = payload.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    shifted: list[str] = []
    for block in text.split("\n\n"):
        lines = block.split("\n")
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            if block.strip():
                shifted.append(block.rstrip())
            continue
        match = _VTT_TIMING.match(lines[timing_index].strip())
        if match is None:
            continue
        cue_start = _parse_vtt_time(match.group("start"))
        cue_end = _parse_vtt_time(match.group("end"))
        if cue_end <= start_seconds:
            continue
        lines[timing_index] = (
            f"{_format_vtt_time(max(0.0, cue_start - start_seconds))} --> "
            f"{_format_vtt_time(cue_end - start_seconds)}{match.group('settings')}"
        )
        shifted.append("\n".join(lines).rstrip())
    return ("\n\n".join(shifted).rstrip() + "\n").encode("utf-8")


def _is_microdvd_sidecar(source: Path) -> bool:
    # Only a MicroDVD .sub is ever offered as a sidecar (external_subtitle_files).
    return source.suffix.lower() == ".sub"


def _subtitle_cache_key(
    item: ResolvedItem, subtitle_track: int, source: Path | None = None, frame_rate: str | None = None
) -> tuple[str, int, int, int]:
    # A sidecar is keyed by its own size and timestamp, not the film's: editing
    # the .srt has to invalidate what was cached from it, and re-muxing the film
    # must not throw away a conversion that had nothing to do with the film.
    target = source if source is not None else item.path
    name = str(target)
    if source is not None and _is_microdvd_sidecar(source):
        # A MicroDVD conversion does depend on the film when the file does not
        # name its own rate: the frames are counted at the film's rate.
        name = f"{name}\0subfps={frame_rate or ''}"
    try:
        facts = target.stat()
        return name, facts.st_mtime_ns, facts.st_size, subtitle_track
    except OSError:
        return name, 0, 0, subtitle_track


def _subtitle_cache_digest(key: tuple[str, int, int, int]) -> str:
    return hashlib.sha256("\0".join(map(str, key)).encode("utf-8", errors="surrogatepass")).hexdigest()


def embedded_subtitle_cache_name(item: ResolvedItem, subtitle_track: int) -> str:
    """The name (without ``.vtt``) one embedded track's conversion is kept under.

    From what ``item`` already says about the film, without asking the disk
    again: cache pruning computes this for every track a film could have.
    """
    return _subtitle_cache_digest((str(item.path), item.mtime_ns, item.size, subtitle_track))


def _subtitle_cache_place(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    source: Path | None = None,
    frame_rate: str | None = None,
) -> tuple[tuple[str, int, int, int], Path | None]:
    """The in-memory key and the file of one track's conversion: one stat, in a thread."""
    key = _subtitle_cache_key(item, subtitle_track, source, frame_rate)
    if config.subtitle_cache_path is None:
        return key, None
    digest = _subtitle_cache_digest(key)
    return key, config.subtitle_cache_path / digest[:2] / f"{digest}.vtt"


def subtitle_cache_file(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    source: Path | None = None,
    frame_rate: str | None = None,
) -> Path | None:
    """Where one track's WebVTT is kept. Stats the source: blocking, so mind the event loop."""
    return _subtitle_cache_place(item, config, subtitle_track, source, frame_rate)[1]


async def invalidate_subtitle_cache(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    source: Path | None = None,
    frame_rate: str | None = None,
) -> None:
    key, path = await asyncio.to_thread(_subtitle_cache_place, item, config, subtitle_track, source, frame_rate)
    _SUBTITLE_CACHE.pop(key, None)
    if path is not None:
        await asyncio.to_thread(path.unlink, missing_ok=True)


async def _read_cached_subtitle(path: Path | None) -> bytes | None:
    if path is None:
        return None
    try:
        payload = await asyncio.to_thread(path.read_bytes)
    except OSError:
        return None
    return payload if payload.startswith(b"WEBVTT") else None


def _sidecar_charset(path: Path) -> str | None:
    """Read enough of a sidecar to decide its encoding; unreadable means UTF-8."""
    try:
        with path.open("rb") as handle:
            sample = handle.read(64 * 1024)
    except OSError:
        return None
    return subtitle_charset(sample)


async def _write_cached_subtitle(path: Path | None, payload: bytes) -> None:
    if path is None:
        return
    def write() -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{time.time_ns()}.tmp")
        temporary.write_bytes(payload)
        temporary.replace(path)
    await asyncio.to_thread(write)


async def extract_subtitle_webvtt(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    start_seconds: float = 0.0,
    semaphore: asyncio.Semaphore | None = None,
    source: Path | None = None,
    frame_rate: str | None = None,
) -> bytes:
    """One track as WebVTT, from the cache or converted now.

    ``frame_rate`` is the film's (``probe_media_info``'s ``video_frame_rate``); only
    a MicroDVD sidecar uses it.
    """
    cache_key, cache_path = await asyncio.to_thread(
        _subtitle_cache_place, item, config, subtitle_track, source, frame_rate
    )
    cached = _SUBTITLE_CACHE.get(cache_key)
    if cached is None:
        cached = await _read_cached_subtitle(cache_path)
    if cached is not None:
        _cache_subtitle(cache_key, cached)
        return shift_webvtt(cached, start_seconds)

    async with _subtitle_lock(cache_key):
        cached = _SUBTITLE_CACHE.get(cache_key)
        if cached is None:
            cached = await _read_cached_subtitle(cache_path)
        if cached is not None:
            _cache_subtitle(cache_key, cached)
            return shift_webvtt(cached, start_seconds)
        charset = await asyncio.to_thread(_sidecar_charset, source) if source is not None else None
        acquired = False
        try:
            if semaphore is not None:
                await semaphore.acquire()
                acquired = True
            returncode, stdout, stderr = await _run_webvtt(
                subtitle_webvtt_command(item, config, subtitle_track, 0.0, source, charset, frame_rate), config
            )
            if charset is None and _in_another_codepage(returncode, stdout, stderr):
                returncode, stdout, stderr = await _run_webvtt(
                    subtitle_webvtt_command(
                        item, config, subtitle_track, 0.0, source, _LEGACY_SUBTITLE_CHARSET, frame_rate
                    ),
                    config,
                )
        finally:
            if acquired and semaphore is not None:
                semaphore.release()
        if returncode != 0 or not stdout.startswith(b"WEBVTT"):
            raise StereoTranscodeError(
                f"Subtitle conversion failed: {ffmpeg_reason(stderr, source if source is not None else item.path)}"
            )
        stdout = sanitize_webvtt(stdout)
        _cache_subtitle(cache_key, stdout)
        # Keyed exactly as it is read back above. This used to leave ``source``
        # out, so a sidecar's conversion was written under the film's own key: the
        # disk cache never hit for sidecars, and when a probe timed out (sidecars
        # then number from 0) it landed on the film's embedded track 0, which later
        # served the wrong subtitles.
        await _write_cached_subtitle(cache_path, stdout)
        return shift_webvtt(stdout, start_seconds)


def film_webvtt_command(
    item: ResolvedItem, config: StereoConfig, tracks: list[tuple[int, Path]]
) -> list[str]:
    """Convert several embedded text tracks of one film in one read.

    Each output is exactly the one ``subtitle_webvtt_command`` produces for its
    track alone: text subtitles are converted packet by packet, nothing travels
    between them. Only for files whose zero FFmpeg does not move — see
    ``extract_film_webvtt``.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    command = [config.ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(item.path)]
    for track, target in tracks:
        command.extend([
            "-map", f"0:s:{track}", "-map_metadata", "-1", "-c:s", "webvtt", "-f", "webvtt", str(target),
        ])
    return command


async def extract_film_webvtt(
    item: ResolvedItem,
    config: StereoConfig,
    tracks: list[int],
    semaphore: asyncio.Semaphore | None = None,
    *,
    refresh: bool = False,
    background: bool = True,
) -> dict[int, tuple[str, str | None]]:
    """Warm the WebVTT cache for several embedded text tracks of one film at once.

    The background pass used to convert each track with its own read of the whole
    film — 1484 tracks, 3.74 TB. One read per film is 2.61 TB. Returns, per track,
    ``("cached", None)``, ``("generated", None)`` or ``("failed", reason)``.
    ``semaphore`` is held while the film is read.

    A transport or program stream is converted a track at a time, as before:
    FFmpeg sets the zero of such a file by the streams in use, so tracks starting
    at different moments would get a different zero together than alone. A failed
    multi-track pass also falls back to one pass per track, so one track nothing
    can convert costs only itself.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    if config.subtitle_cache_path is None:
        raise StereoTranscodeError("Subtitle cache is not configured")
    outcome: dict[int, tuple[str, str | None]] = {}
    wanted: list[tuple[int, tuple[str, int, int, int], Path]] = []
    for track in tracks:
        key, path = await asyncio.to_thread(_subtitle_cache_place, item, config, track)
        if path is None:
            raise StereoTranscodeError("Subtitle cache is not configured")
        if not refresh and await asyncio.to_thread(path.is_file):
            outcome[track] = ("cached", None)
            continue
        wanted.append((track, key, path))
    if not wanted:
        return outcome

    async def one_by_one(entries: list[tuple[int, tuple[str, int, int, int], Path]]) -> None:
        for track, key, path in entries:
            if refresh:
                _SUBTITLE_CACHE.pop(key, None)
                await asyncio.to_thread(path.unlink, missing_ok=True)
            try:
                await extract_subtitle_webvtt(item, config, track, 0.0, semaphore)
                outcome[track] = ("generated", None)
            except StereoTranscodeError as exc:
                outcome[track] = ("failed", str(exc))

    if len(wanted) < 2 or item.path.suffix.lower() in RESTAMPED_SUFFIXES:
        await one_by_one(wanted)
        return outcome

    work = config.subtitle_cache_path / "work" / f"{os.getpid()}-{uuid.uuid4().hex[:12]}"
    targets = [(track, work / f"{track}.vtt") for track, _, _ in wanted]
    process: asyncio.subprocess.Process | None = None
    failed = False
    acquired = False
    try:
        if semaphore is not None:
            await semaphore.acquire()
            acquired = True
        await asyncio.to_thread(work.mkdir, parents=True, exist_ok=True)
        try:
            process = await asyncio.create_subprocess_exec(
                *film_webvtt_command(item, config, targets),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | (getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0) if background else 0),
            )
            # The ceiling one track had, for a film that is now read once.
            _, stderr = await asyncio.wait_for(
                process.communicate(), timeout=max(180.0, min(float(config.timeout_seconds), 600.0))
            )
            # A track in another code page comes out of this pass without its
            # unreadable cues, and FFmpeg does not say which track it was. Track
            # by track, the one that is not UTF-8 is found and read again in
            # CP1250 (see _in_another_codepage); the others come out as they would.
            failed = process.returncode != 0 or _INVALID_UTF8 in (stderr or b"")
        except TimeoutError:
            if process is not None:
                await _stop_process(process)
            failed = True
        except asyncio.CancelledError:
            if process is not None:
                await _stop_process(process)
            raise
        except OSError:
            failed = True
        if not failed:
            for (track, key, path), (_, target) in zip(wanted, targets, strict=True):
                # Measured before it is read: empty for a file past the ceiling.
                payload = await asyncio.to_thread(_read_bounded, target, _WEBVTT_MAX_BYTES)
                if not payload.startswith(b"WEBVTT"):
                    outcome[track] = ("failed", "Subtitle conversion failed")
                    continue
                _SUBTITLE_CACHE.pop(key, None)
                await _write_cached_subtitle(path, sanitize_webvtt(payload))
                outcome[track] = ("generated", None)
    finally:
        if acquired and semaphore is not None:
            semaphore.release()
        await asyncio.to_thread(shutil.rmtree, work, True)
    if failed:
        await one_by_one(wanted)
    return outcome
