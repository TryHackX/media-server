from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

"""
Technical facts about a media file, read with ffprobe.

The catalogue scan deliberately never opens a file: it compares size and mtime
only, so a full pass stays cheap. Anything that needs the file's contents —
duration, resolution, codecs — is therefore a separate, queued job, exactly like
audio tags. The bump below invalidates every stored probe at once when the shape
of what is extracted changes.
"""

PROBE_SCHEMA = 2

# Transfer curves that mean HDR; bt2020 primaries alone are treated as a hint.
_HDR_TRANSFERS = frozenset({"smpte2084", "smpte428", "arib-std-b67"})

# A film can carry a dozen dubs and twice as many subtitle tracks; these caps keep
# one pathological container from writing an unbounded document into the catalogue.
_MAX_AUDIO_TRACKS = 16
_MAX_SUBTITLE_TRACKS = 24


class ProbeError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class MediaProbe:
    duration_ms: int | None
    width: int | None
    height: int | None
    video_codec: str | None
    audio_codec: str | None
    frame_rate: float | None
    hdr: bool
    """Everything worth keeping, stored under metadata_json.video."""
    technical: dict[str, Any]


def ffprobe_for(ffmpeg_path: str | Path | None) -> Path | None:
    """
    Locate ffprobe from whatever the configuration says about ffmpeg.

    A bundled build keeps both binaries side by side, so the sibling is checked
    first. But `stereo.ffmpeg_path` may also be a bare command name — that is
    the installer's default and what Debian's system package wants — and a bare
    name means "look it up on PATH", exactly as the process starts ffmpeg
    itself. Testing the filesystem for it would resolve `ffprobe` against the
    current directory, find nothing, and silently disable every video probe on
    the most common configuration there is.
    """
    if ffmpeg_path is None:
        return None
    executable = Path(ffmpeg_path)
    if executable.is_absolute():
        candidate = executable.with_name("ffprobe" + executable.suffix)
        if candidate.exists():
            return candidate
    found = shutil.which("ffprobe" + executable.suffix) or shutil.which("ffprobe")
    return Path(found) if found else None


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _text(value: Any, limit: int = 32) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned[:limit] if cleaned else None


def _ratio(value: Any) -> float | None:
    """ffprobe reports frame rates as "24000/1001"; 0/0 means "unknown"."""
    if isinstance(value, (int, float)):
        return round(float(value), 3) if value > 0 else None
    if not isinstance(value, str) or "/" not in value:
        return None
    numerator, _, denominator = value.partition("/")
    try:
        top = float(numerator)
        bottom = float(denominator)
    except ValueError:
        return None
    if top <= 0 or bottom <= 0:
        return None
    return round(top / bottom, 3)


def _duration_ms(*candidates: Any) -> int | None:
    for candidate in candidates:
        try:
            seconds = float(candidate)
        except (TypeError, ValueError):
            continue
        if seconds > 0:
            return round(seconds * 1000)
    return None


def _stream_bitrate(stream: dict[str, Any]) -> int | None:
    """
    A stream's own bitrate, wherever the container happens to keep it.

    MP4 answers with ``bit_rate`` on the stream. Matroska almost never does — it
    writes the figure into a ``BPS`` tag instead, sometimes suffixed with the
    track language (``BPS-eng``). Without reading both, every MKV in the library
    reports the whole file's rate and nothing about the picture itself.
    """
    direct = _positive_int(stream.get("bit_rate"))
    if direct is not None:
        return direct
    tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
    for key, value in tags.items():
        if isinstance(key, str) and key.upper().startswith("BPS"):
            tagged = _positive_int(value)
            if tagged is not None:
                return tagged
    return None


def _track(stream: dict[str, Any], index: int) -> dict[str, Any]:
    """One selectable track, described the way the details panel reads it out."""
    tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
    disposition = stream.get("disposition") if isinstance(stream.get("disposition"), dict) else {}
    track: dict[str, Any] = {"index": index}
    for key, value in (
        ("codec", _text(stream.get("codec_name"))),
        ("profile", _text(stream.get("profile"), 64)),
        ("channels", _positive_int(stream.get("channels"))),
        ("channel_layout", _text(stream.get("channel_layout"))),
        ("sample_rate", _positive_int(stream.get("sample_rate"))),
        ("bitrate", _stream_bitrate(stream)),
        ("language", _text(tags.get("language"), 8)),
        ("title", _text(tags.get("title"), 96)),
    ):
        if value is not None:
            track[key] = value
    if disposition.get("default"):
        track["default"] = True
    if disposition.get("forced"):
        track["forced"] = True
    return track


def _is_hdr(stream: dict[str, Any]) -> bool:
    transfer = (stream.get("color_transfer") or "").lower()
    primaries = (stream.get("color_primaries") or "").lower()
    pixel_format = (stream.get("pix_fmt") or "").lower()
    if transfer in _HDR_TRANSFERS:
        return True
    # bt2020 on its own is only HDR when the file is also deeper than 8 bit.
    return primaries.startswith("bt2020") and ("10" in pixel_format or "12" in pixel_format)


def parse_probe_output(payload: dict[str, Any]) -> MediaProbe:
    """Turn one ffprobe JSON document into the fields the catalogue stores."""
    if not isinstance(payload, dict):
        raise ProbeError("ffprobe returned an unexpected document")
    container = payload.get("format") if isinstance(payload.get("format"), dict) else {}
    streams = payload.get("streams")
    streams = [stream for stream in streams if isinstance(stream, dict)] if isinstance(streams, list) else []

    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    # A cover embedded in an audio file is a video stream with a still-image codec.
    if video is not None and video.get("codec_name") in {"mjpeg", "png", "bmp", "gif"}:
        video = next(
            (
                stream
                for stream in streams
                if stream.get("codec_type") == "video" and stream.get("codec_name") not in {"mjpeg", "png", "bmp", "gif"}
            ),
            None,
        )
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    audio = audio_streams[0] if audio_streams else None
    subtitles = [stream for stream in streams if stream.get("codec_type") == "subtitle"]

    duration = _duration_ms(
        container.get("duration"),
        (video or {}).get("duration"),
        (audio or {}).get("duration"),
    )
    width = _positive_int((video or {}).get("width"))
    height = _positive_int((video or {}).get("height"))
    frame_rate = _ratio((video or {}).get("avg_frame_rate")) or _ratio((video or {}).get("r_frame_rate"))
    hdr = bool(video is not None and _is_hdr(video))

    technical: dict[str, Any] = {"parser": "ffprobe", "schema": PROBE_SCHEMA}
    for key, value in (
        ("container", _text(container.get("format_name"), 64)),
        ("bitrate", _positive_int(container.get("bit_rate"))),
        ("video_codec", _text((video or {}).get("codec_name"))),
        ("video_profile", _text((video or {}).get("profile"), 64)),
        # The picture's own rate, which is what a viewer comparing two rips wants;
        # "bitrate" above is the whole file, sound and subtitles included.
        ("video_bitrate", _stream_bitrate(video) if video is not None else None),
        ("pixel_format", _text((video or {}).get("pix_fmt"))),
        ("color_space", _text((video or {}).get("color_space"))),
        ("color_transfer", _text((video or {}).get("color_transfer"))),
        ("width", width),
        ("height", height),
        ("frame_rate", frame_rate),
        ("audio_codec", _text((audio or {}).get("codec_name"))),
        ("audio_channels", _positive_int((audio or {}).get("channels"))),
        ("sample_rate", _positive_int((audio or {}).get("sample_rate"))),
    ):
        if value is not None:
            technical[key] = value
    if hdr:
        technical["hdr"] = True
    languages = []
    for stream in subtitles:
        tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
        language = _text(tags.get("language"), 8)
        if language and language not in languages:
            languages.append(language)
    if languages:
        technical["subtitle_languages"] = languages[:16]
    if subtitles:
        technical["subtitle_streams"] = len(subtitles)
    if len(audio_streams) > 1:
        technical["audio_streams"] = len(audio_streams)
    # Every track, not just the first one. A film with a dub, an original and a
    # commentary described only its dub, which said nothing about the other two.
    if audio_streams:
        technical["audio_tracks"] = [
            _track(stream, index) for index, stream in enumerate(audio_streams[:_MAX_AUDIO_TRACKS])
        ]
    if subtitles:
        technical["subtitle_tracks"] = [
            _track(stream, index) for index, stream in enumerate(subtitles[:_MAX_SUBTITLE_TRACKS])
        ]

    return MediaProbe(
        duration_ms=duration,
        width=width,
        height=height,
        video_codec=_text((video or {}).get("codec_name")),
        audio_codec=_text((audio or {}).get("codec_name")),
        frame_rate=frame_rate,
        hdr=hdr,
        technical=technical,
    )


def read_media_probe(path: Path, ffprobe: Path, *, timeout_seconds: float = 30.0) -> MediaProbe:
    """
    Ask ffprobe about one file.

    ffprobe is its own process, so a damaged container cannot take the worker
    down with it; the timeout bounds a file that makes the parser spin.
    """
    command = [
        str(ffprobe),
        "-v",
        "error",
        "-hide_banner",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-i",
        str(path),
    ]
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argument list, no shell
            command,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        raise ProbeError(f"ffprobe is not available at {ffprobe}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"ffprobe exceeded {timeout_seconds:g} seconds") from exc
    except OSError as exc:
        raise ProbeError(f"Cannot run ffprobe: {exc}") from exc

    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ProbeError(f"ffprobe failed: {detail[-1] if detail else completed.returncode}")
    try:
        payload = json.loads(completed.stdout.decode("utf-8", "replace") or "{}")
    except ValueError as exc:
        raise ProbeError("ffprobe returned malformed JSON") from exc
    probe = parse_probe_output(payload)
    if probe.duration_ms is None and probe.video_codec is None and probe.audio_codec is None:
        raise ProbeError("ffprobe found no playable stream")
    return probe
