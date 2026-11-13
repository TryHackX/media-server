"""
Which files are what, and what to call them over HTTP: one table for the whole server.

Three lists used to answer the first question — the catalogue's, the
thumbnailer's and the subtitle finder's — and they had drifted: a ``.vob`` was a
film to the scanner and nothing at all to the thumbnailer, so 26 catalogued films
could never get a picture. The second question was put to the operating system
(``mimetypes``), which reads the Windows registry on one machine and
``/etc/mime.types`` on another: the same ``.flac`` was ``audio/x-flac`` here and
``audio/flac`` there, a transport stream was ``video/vnd.dlna.mpeg-tts``, a
``.vob`` had no type, and on some systems an ``.ass`` subtitle was ``audio/aac``.

Everything here is keyed by the lower-case extension with its dot, the way
``Path.suffix.lower()`` gives it.
"""

from __future__ import annotations

__all__ = [
    "AUDIO_EXTENSIONS",
    "AUXILIARY_EXTENSIONS",
    "IMAGE_EXTENSIONS",
    "VIDEO_EXTENSIONS",
    "mime_type_for",
]

_AUDIO_TYPES = {
    ".aac": "audio/aac",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".ape": "audio/x-ape",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".mka": "audio/x-matroska",
    ".mp3": "audio/mpeg",
    ".mpc": "audio/x-musepack",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".wma": "audio/x-ms-wma",
    ".wv": "audio/x-wavpack",
}
_VIDEO_TYPES = {
    ".3gp": "video/3gpp",
    ".asf": "video/x-ms-asf",
    ".avi": "video/x-msvideo",
    ".divx": "video/x-msvideo",
    ".flv": "video/x-flv",
    ".m2ts": "video/mp2t",
    ".m2v": "video/mpeg",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".mts": "video/mp2t",
    ".ogv": "video/ogg",
    ".rm": "application/vnd.rn-realmedia",
    ".rmvb": "application/vnd.rn-realmedia-vbr",
    ".ts": "video/mp2t",
    # A DVD's programme stream: MPEG-2 under another name.
    ".vob": "video/mpeg",
    ".webm": "video/webm",
    ".wmv": "video/x-ms-wmv",
}
_IMAGE_TYPES = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
# What may sit beside the media and be handed out with it: notes, subtitles,
# archives. Text stays text/plain, so a browser shows it instead of guessing.
_AUXILIARY_TYPES = {
    ".7z": "application/x-7z-compressed",
    ".ass": "text/plain",
    ".cue": "text/plain",
    ".nfo": "text/plain",
    ".pdf": "application/pdf",
    ".rar": "application/vnd.rar",
    ".srt": "text/plain",
    ".torrent": "application/x-bittorrent",
    ".txt": "text/plain",
    ".vtt": "text/vtt",
    ".zip": "application/zip",
}

AUDIO_EXTENSIONS = frozenset(_AUDIO_TYPES)
VIDEO_EXTENSIONS = frozenset(_VIDEO_TYPES)
IMAGE_EXTENSIONS = frozenset(_IMAGE_TYPES)
AUXILIARY_EXTENSIONS = frozenset(_AUXILIARY_TYPES)

_TYPES = {**_AUDIO_TYPES, **_VIDEO_TYPES, **_IMAGE_TYPES, **_AUXILIARY_TYPES}


def mime_type_for(extension: str) -> str | None:
    """The type of a file by its extension (``.mkv``, ``mkv`` or ``.MKV``), or None for one we do not serve by name."""
    suffix = extension.lower()
    if suffix and not suffix.startswith("."):
        suffix = "." + suffix
    return _TYPES.get(suffix)
