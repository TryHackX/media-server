from __future__ import annotations

import asyncio
import hashlib
import math
import re
import subprocess
import time
from collections.abc import AsyncIterator
from contextlib import suppress
from pathlib import Path
from typing import Any

from .config import StereoConfig
from .paths import ResolvedItem


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
# Sidecar subtitles: text formats only. ``.sub`` is deliberately absent — it is
# MicroDVD text about half the time and the binary half of a VobSub pair the
# other half, and the two are told apart by looking inside, which is the kind of
# guess that ends with the wrong file offered as if it were right.
_EXTERNAL_SUBTITLE_SUFFIXES = {".srt", ".ass", ".ssa", ".vtt"}
# Only used to work out which film a sidecar belongs to when several sit in one
# folder; it does not have to be the catalogue's idea of a video, just the set of
# names that can compete for a subtitle.
_VIDEO_SUFFIXES = {
    ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".flv", ".webm",
    ".m2ts", ".mts", ".ts", ".vob", ".mpg", ".mpeg", ".m2v", ".divx", ".ogv",
}
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
_SUBTITLE_LOCKS: dict[tuple[str, int, int, int], asyncio.Lock] = {}
# Bound the in-memory subtitle cache by total bytes, not entry count: a plain
# count cap let 64 large tracks pin ~1 GiB resident. Oldest entries evict first.
_SUBTITLE_CACHE_BUDGET_BYTES = 32 * 1024 * 1024


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
            self._prune(stream_id)

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
            self._prune(stream_id)

    def _prune(self, stream_id: str) -> None:
        """Drop the generation counter once no process or lease references it.

        Called under ``self._lock``. Without this every distinct stream_id ever
        seen would stay in ``_generations`` for the life of the service.
        """
        if stream_id not in self._processes and stream_id not in self._leases:
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
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=20)
    except (OSError, TimeoutError):
        return None
    if process.returncode != 0:
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
        stat = item.path.stat()
        cache_key = (str(item.path), stat.st_mtime_ns, stat.st_size, round(target_seconds, 3))
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


async def _probe_stderr(item: ResolvedItem, config: StereoConfig) -> bytes | None:
    if config.ffmpeg_path is None:
        return None
    try:
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
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=12)
    except (OSError, TimeoutError):
        return None
    return stderr


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
        try:
            if not candidate.is_file() or candidate.stat().st_size > _EXTERNAL_SUBTITLE_MAX_BYTES:
                continue
        except OSError:
            continue
        found.append(candidate)
        if len(found) >= _EXTERNAL_SUBTITLE_LIMIT:
            break
    return found


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
        "codec": path.suffix.lstrip(".").lower(),
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


async def probe_media_info(item: ResolvedItem, config: StereoConfig) -> dict[str, Any]:
    """Read duration and stream choices from the container header without decoding the movie."""
    try:
        stat = item.path.stat()
        # The directory's own timestamp is part of the key because the answer now
        # includes what lies beside the film: a subtitle file dropped in next to
        # it changes nothing about the film, and without this the new track would
        # not appear until the service restarted.
        cache_key = (str(item.path), stat.st_mtime_ns, stat.st_size, item.path.parent.stat().st_mtime_ns)
    except OSError:
        cache_key = (str(item.path), 0, 0, 0)
    cached = _PROBE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    external = await asyncio.to_thread(external_subtitle_files, item)
    stderr = await _probe_stderr(item, config)
    if stderr is None:
        # No FFmpeg answer means nothing is known about the container — but a
        # subtitle lying next to the film is known regardless, so it is still
        # offered rather than withheld because a different question failed.
        return {
            "duration_seconds": None,
            "video_codec": None,
            "video_width": None,
            "video_height": None,
            "video_transcoded": False,
            "audio_tracks": [],
            "subtitle_tracks": [
                _external_subtitle_track(item, path, index) for index, path in enumerate(external)
            ],
        }
    video_codec: str | None = None
    video_width: int | None = None
    video_height: int | None = None
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
    result = {
        "duration_seconds": _duration(stderr),
        "video_codec": video_codec,
        "video_width": video_width,
        "video_height": video_height,
        "video_transcoded": video_codec is not None and video_codec not in _NATIVE_COPY_VIDEO_CODECS,
        "audio_tracks": audio_tracks,
        "subtitle_tracks": subtitle_tracks,
    }
    if len(_PROBE_CACHE) >= 256:
        _PROBE_CACHE.pop(next(iter(_PROBE_CACHE)))
    _PROBE_CACHE[cache_key] = result
    return result


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except TimeoutError:
        process.kill()
        await process.wait()


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
            return "cp1250"
        return None
    return None


def subtitle_webvtt_command(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    start_seconds: float = 0.0,
    source: Path | None = None,
    charset: str | None = None,
) -> list[str]:
    """Convert one subtitle track to WebVTT.

    ``source`` names a sidecar file; without it the track is read out of the film
    itself. A sidecar holds exactly one subtitle stream, so the track number does
    not travel into the mapping — the file *is* the track.
    """
    if config.ffmpeg_path is None:
        raise StereoTranscodeError("FFmpeg compatibility mode is not configured")
    command = [config.ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error"]
    if start_seconds > 0:
        command.extend(["-ss", f"{start_seconds:.3f}"])
    if source is not None and charset is not None:
        command.extend(["-sub_charenc", charset])
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


def _subtitle_cache_key(
    item: ResolvedItem, subtitle_track: int, source: Path | None = None
) -> tuple[str, int, int, int]:
    # A sidecar is keyed by its own size and timestamp, not the film's: editing
    # the .srt has to invalidate what was cached from it, and re-muxing the film
    # must not throw away a conversion that had nothing to do with the film.
    target = source if source is not None else item.path
    try:
        stat = target.stat()
        return str(target), stat.st_mtime_ns, stat.st_size, subtitle_track
    except OSError:
        return str(target), 0, 0, subtitle_track


def subtitle_cache_file(
    item: ResolvedItem, config: StereoConfig, subtitle_track: int, source: Path | None = None
) -> Path | None:
    if config.subtitle_cache_path is None:
        return None
    identity = "\0".join(
        map(str, _subtitle_cache_key(item, subtitle_track, source))
    ).encode("utf-8", errors="surrogatepass")
    digest = hashlib.sha256(identity).hexdigest()
    return config.subtitle_cache_path / digest[:2] / f"{digest}.vtt"


async def invalidate_subtitle_cache(
    item: ResolvedItem, config: StereoConfig, subtitle_track: int, source: Path | None = None
) -> None:
    _SUBTITLE_CACHE.pop(_subtitle_cache_key(item, subtitle_track, source), None)
    path = subtitle_cache_file(item, config, subtitle_track, source)
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


async def cached_subtitle_webvtt(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    start_seconds: float = 0.0,
    source: Path | None = None,
) -> bytes | None:
    """What is already converted, or None — never runs FFmpeg.

    The way a track nobody can convert on demand is served: an OCR pass writes
    its result into the same cache, and until it has, the honest answer is that
    there is nothing yet.
    """
    cache_key = _subtitle_cache_key(item, subtitle_track, source)
    cached = _SUBTITLE_CACHE.get(cache_key)
    if cached is None:
        cached = await _read_cached_subtitle(subtitle_cache_file(item, config, subtitle_track, source))
    if cached is None:
        return None
    _cache_subtitle(cache_key, cached)
    return shift_webvtt(cached, start_seconds)


async def store_subtitle_webvtt(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    payload: bytes,
    source: Path | None = None,
) -> None:
    """Put a conversion made elsewhere — an OCR pass — where the player looks."""
    _cache_subtitle(_subtitle_cache_key(item, subtitle_track, source), payload)
    await _write_cached_subtitle(subtitle_cache_file(item, config, subtitle_track, source), payload)


async def extract_subtitle_webvtt(
    item: ResolvedItem,
    config: StereoConfig,
    subtitle_track: int,
    start_seconds: float = 0.0,
    semaphore: asyncio.Semaphore | None = None,
    source: Path | None = None,
) -> bytes:
    cache_key = _subtitle_cache_key(item, subtitle_track, source)
    cached = _SUBTITLE_CACHE.get(cache_key)
    if cached is None:
        cached = await _read_cached_subtitle(subtitle_cache_file(item, config, subtitle_track, source))
    if cached is not None:
        _cache_subtitle(cache_key, cached)
        return shift_webvtt(cached, start_seconds)

    lock = _SUBTITLE_LOCKS.setdefault(cache_key, asyncio.Lock())
    async with lock:
        cached = _SUBTITLE_CACHE.get(cache_key)
        if cached is None:
            cached = await _read_cached_subtitle(subtitle_cache_file(item, config, subtitle_track, source))
        if cached is not None:
            _cache_subtitle(cache_key, cached)
            return shift_webvtt(cached, start_seconds)
        charset = await asyncio.to_thread(_sidecar_charset, source) if source is not None else None
        command = subtitle_webvtt_command(item, config, subtitle_track, 0.0, source, charset)

        process: asyncio.subprocess.Process | None = None
        acquired = False
        try:
            if semaphore is not None:
                await semaphore.acquire()
                acquired = True
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            timeout = max(180.0, min(float(config.timeout_seconds), 600.0))
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
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
            raise StereoTranscodeError("Subtitle conversion failed") from exc
        finally:
            if acquired and semaphore is not None:
                semaphore.release()
        if process.returncode != 0 or not stdout.startswith(b"WEBVTT") or len(stdout) > 16 * 1024 * 1024:
            raise StereoTranscodeError("Subtitle conversion failed")
        stdout = sanitize_webvtt(stdout)
        _cache_subtitle(cache_key, stdout)
        await _write_cached_subtitle(subtitle_cache_file(item, config, subtitle_track), stdout)
        return shift_webvtt(stdout, start_seconds)
