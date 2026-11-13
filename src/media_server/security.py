from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_AAD = b"tryhackx-media-transfer:v1"
_TOKEN_PREFIX = "v1."

# What a grant was issued for. The bridge seals exactly one of these and every
# route of the transfer service names the ones it serves, so a token handed out
# for one job cannot be spent on another:
#
# * ``download`` — the file or archive as an attachment (``/v1/files``, ``/v1/archives``);
# * ``play``     — the file inline, for the player (``/v1/files``);
# * ``thumb``    — a preview picture of the file (``/v1/thumbnails``);
# * ``compat``   — compatibility mode: transcoding, track probing, subtitles
#   (``/v1/stereo*``, ``/v1/subtitles``, ``/v1/subtitle-picture(s)``).
#
# Before this, the only check was ``kind == "file"``, so any playback token —
# a thumbnail's, a guest link's — opened transcoding, also for an account whose
# group has compatibility mode switched off, and with no stream cap at all.
#
# A token that names no purpose is refused. (For as long as tokens sealed before
# 08.11.2026 could still be alive — fifteen minutes — they were read by what the
# bridge of that time could have meant by them; none of them exists any more.)
PURPOSES = frozenset({"download", "play", "thumb", "compat"})


class TokenError(ValueError):
    """A deliberately non-specific transfer-token error."""


@dataclass(frozen=True, slots=True)
class GrantItem:
    root: str
    path: str
    archive_name: str | None = None


_MANIFEST_HEX = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True, slots=True)
class ManifestRef:
    """An archive's file list kept in ``archive_manifests`` rather than in its token.

    The bridge seals the row's key, the SHA-256 of the exact bytes it stored and
    the number of entries; ``manifest_items`` accepts a stored list only if all
    three agree, so the archive is built from the list the bridge sealed.
    """

    id: str
    sha256: str
    count: int


@dataclass(frozen=True, slots=True)
class TransferGrant:
    kind: str
    issued_at: int
    expires_at: int
    download_name: str
    disposition: str
    items: tuple[GrantItem, ...]
    # The uses this grant may be spent on: its one sealed purpose.
    uses: frozenset[str]
    subject: str | None = None
    # Per-subject cap on simultaneous compatibility streams; 0 means unlimited.
    max_streams: int = 0
    # Per-subject cap on simultaneous downloads (attachment files, archives); 0 = unlimited.
    max_downloads: int = 0
    # Set for an archive whose list is stored server-side; ``items`` is then
    # empty until the list has been loaded and checked (``manifest_items``).
    manifest: ManifestRef | None = None

    def allows(self, *uses: str) -> bool:
        """Whether this grant was issued for any of these uses."""
        return any(use in self.uses for use in uses)


def default_purpose(kind: str, disposition: str) -> str:
    """The purpose a grant has when the issuer names none: a download or playback."""
    return "download" if kind == "archive" or disposition == "attachment" else "play"


def _purpose_fits(purpose: str, kind: str, disposition: str) -> bool:
    """A download is an attachment; everything else is shown inline from one file."""
    if purpose == "download":
        return disposition == "attachment"
    return kind == "file" and disposition == "inline"


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as exc:
        raise TokenError("Niepoprawny token") from exc
    if _b64encode(decoded) != value:
        raise TokenError("Niepoprawny token")
    return decoded


def _clean_text(value: Any, name: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise TokenError("Niepoprawny token")
    if not allow_empty and not value:
        raise TokenError("Niepoprawny token")
    if len(value) > maximum or "\x00" in value or "\r" in value or "\n" in value:
        raise TokenError("Niepoprawny token")
    return value


def seal_grant(
    *,
    key: bytes,
    kind: str,
    items: Iterable[GrantItem],
    download_name: str,
    ttl_seconds: int = 300,
    disposition: str = "attachment",
    subject: str | None = None,
    max_streams: int = 0,
    max_downloads: int = 0,
    purpose: str | None = None,
    now: int | None = None,
    manifest: ManifestRef | None = None,
) -> str:
    if len(key) != 32:
        raise ValueError("Klucz transferowy musi mieć 32 bajty")
    if kind not in {"file", "archive"}:
        raise ValueError("Nieznany rodzaj transferu")
    if disposition not in {"attachment", "inline"}:
        raise ValueError("Niepoprawny Content-Disposition")
    if not 1 <= ttl_seconds <= 86400:
        raise ValueError("TTL musi mieścić się w zakresie 1..86400")
    purpose = default_purpose(kind, disposition) if purpose is None else purpose
    if purpose not in PURPOSES or not _purpose_fits(purpose, kind, disposition):
        raise ValueError("Cel transferu nie pasuje do jego rodzaju")
    if max_streams > 0 and purpose != "compat":
        # The cap is enforced by the compatibility routes only; on any other
        # grant it would read as a limit while limiting nothing.
        raise ValueError("Limit strumieni dotyczy wyłącznie trybu zgodnego")

    issued_at = int(time.time() if now is None else now)
    serialized_items = []
    for item in items:
        row: dict[str, str] = {"root": item.root, "path": item.path}
        if item.archive_name is not None:
            row["archive_name"] = item.archive_name
        serialized_items.append(row)
    if manifest is not None:
        if kind != "archive" or serialized_items:
            raise ValueError("Lista w bazie zastępuje pozycje archiwum, nie pliku")
    elif not serialized_items or (kind == "file" and len(serialized_items) != 1):
        raise ValueError("Transfer pliku wymaga jednej pozycji, archiwum co najmniej jednej")

    payload: dict[str, Any] = {
        "v": 1,
        "aud": "transfer",
        "kind": kind,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "name": download_name,
        "disposition": disposition,
        "purpose": purpose,
    }
    if manifest is None:
        payload["items"] = serialized_items
    else:
        payload["manifest"] = {"id": manifest.id, "sha256": manifest.sha256, "count": manifest.count}
    if subject is not None:
        payload["sub"] = subject
    if not 0 <= max_streams <= 10000:
        raise ValueError("Limit strumieni musi mieścić się w zakresie 0..10000")
    if max_streams > 0:
        payload["max_streams"] = max_streams
    if not 0 <= max_downloads <= 10000:
        raise ValueError("Limit równoczesnych pobrań musi mieścić się w zakresie 0..10000")
    if max_downloads > 0 and disposition == "attachment":
        payload["max_downloads"] = max_downloads

    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    nonce = secrets.token_bytes(12)
    encrypted = AESGCM(key).encrypt(nonce, plaintext, _AAD)
    return _TOKEN_PREFIX + _b64encode(nonce + encrypted)


def open_grant(
    token: str,
    *,
    key: bytes,
    max_ttl_seconds: int,
    clock_skew_seconds: int,
    max_token_bytes: int,
    max_archive_entries: int,
    now: int | None = None,
) -> TransferGrant:
    if not isinstance(token, str) or not token.startswith(_TOKEN_PREFIX):
        raise TokenError("Niepoprawny token")
    if len(token.encode("utf-8")) > max_token_bytes:
        raise TokenError("Niepoprawny token")
    packed = _b64decode(token[len(_TOKEN_PREFIX) :])
    if len(packed) < 12 + 16:
        raise TokenError("Niepoprawny token")
    nonce, ciphertext = packed[:12], packed[12:]
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, _AAD)
        raw = json.loads(plaintext)
    except (InvalidTag, UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
        raise TokenError("Niepoprawny token") from exc
    if not isinstance(raw, dict) or raw.get("v") != 1 or raw.get("aud") != "transfer":
        raise TokenError("Niepoprawny token")

    kind = raw.get("kind")
    if kind not in {"file", "archive"}:
        raise TokenError("Niepoprawny token")
    try:
        issued_at = int(raw["iat"])
        expires_at = int(raw["exp"])
    except (KeyError, TypeError, ValueError) as exc:
        raise TokenError("Niepoprawny token") from exc
    current = int(time.time() if now is None else now)
    if issued_at > current + clock_skew_seconds:
        raise TokenError("Niepoprawny token")
    if expires_at < current - clock_skew_seconds:
        raise TokenError("Token wygasł")
    if expires_at <= issued_at or expires_at - issued_at > max_ttl_seconds:
        raise TokenError("Niepoprawny token")

    disposition = raw.get("disposition", "attachment")
    if disposition not in {"attachment", "inline"}:
        raise TokenError("Niepoprawny token")
    purpose = raw.get("purpose")
    if not (isinstance(purpose, str) and purpose in PURPOSES and _purpose_fits(purpose, kind, disposition)):
        raise TokenError("Niepoprawny token")
    uses = frozenset({purpose})
    name = _clean_text(raw.get("name"), "name", 512)
    subject_raw = raw.get("sub")
    subject = None if subject_raw is None else _clean_text(subject_raw, "sub", 191)
    max_streams_raw = raw.get("max_streams", 0)
    if not isinstance(max_streams_raw, int) or isinstance(max_streams_raw, bool) or not 0 <= max_streams_raw <= 10000:
        raise TokenError("Niepoprawny token")
    max_downloads_raw = raw.get("max_downloads", 0)
    if (
        not isinstance(max_downloads_raw, int)
        or isinstance(max_downloads_raw, bool)
        or not 0 <= max_downloads_raw <= 10000
    ):
        raise TokenError("Niepoprawny token")

    manifest_raw = raw.get("manifest")
    item_rows = raw.get("items")
    manifest: ManifestRef | None = None
    if manifest_raw is not None:
        # An archive whose list waits in the database: the token names it and
        # carries no items of its own (see manifest_items).
        if kind != "archive" or item_rows is not None:
            raise TokenError("Niepoprawny token")
        manifest = _manifest_ref(manifest_raw, max_archive_entries)
        items: tuple[GrantItem, ...] = ()
    else:
        items = _grant_items(item_rows, max_archive_entries)
        if kind == "file" and len(items) != 1:
            raise TokenError("Niepoprawny token")

    return TransferGrant(
        kind=kind,
        issued_at=issued_at,
        expires_at=expires_at,
        download_name=name,
        disposition=disposition,
        items=items,
        uses=uses,
        subject=subject,
        max_streams=max_streams_raw,
        max_downloads=max_downloads_raw,
        manifest=manifest,
    )


def _grant_items(rows: Any, max_archive_entries: int) -> tuple[GrantItem, ...]:
    """Entries of a grant, inline or from a stored list, checked one rule for both."""
    if not isinstance(rows, list) or not rows or len(rows) > max_archive_entries:
        raise TokenError("Niepoprawny token")
    items: list[GrantItem] = []
    for row in rows:
        if not isinstance(row, dict):
            raise TokenError("Niepoprawny token")
        root = _clean_text(row.get("root"), "root", 32)
        path = _clean_text(row.get("path"), "path", 4096)
        archive_raw = row.get("archive_name")
        archive_name = None if archive_raw is None else _clean_text(archive_raw, "archive_name", 1024)
        items.append(GrantItem(root=root, path=path, archive_name=archive_name))
    return tuple(items)


def _manifest_ref(raw: Any, max_archive_entries: int) -> ManifestRef:
    if not isinstance(raw, dict):
        raise TokenError("Niepoprawny token")
    manifest_id = raw.get("id")
    digest = raw.get("sha256")
    count = raw.get("count")
    if (
        not isinstance(manifest_id, str)
        or not _MANIFEST_HEX.fullmatch(manifest_id)
        or not isinstance(digest, str)
        or not _MANIFEST_HEX.fullmatch(digest)
        or not isinstance(count, int)
        or isinstance(count, bool)
        or not 1 <= count <= max_archive_entries
    ):
        raise TokenError("Niepoprawny token")
    return ManifestRef(id=manifest_id, sha256=digest, count=count)


def manifest_items(data: bytes, manifest: ManifestRef, *, max_archive_entries: int) -> tuple[GrantItem, ...]:
    """The entries of a stored archive list, if it is the list the token sealed.

    The digest covers the exact stored bytes and the count must agree too, so a
    row that was changed, swapped or cut short is refused rather than served.
    """
    if not hmac.compare_digest(hashlib.sha256(data).hexdigest(), manifest.sha256):
        raise TokenError("Niepoprawny token")
    try:
        rows = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TokenError("Niepoprawny token") from exc
    items = _grant_items(rows, max_archive_entries)
    if len(items) != manifest.count:
        raise TokenError("Niepoprawny token")
    return items
