from __future__ import annotations

import base64
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_AAD = b"tryhackx-media-transfer:v1"
_TOKEN_PREFIX = "v1."


class TokenError(ValueError):
    """A deliberately non-specific transfer-token error."""


@dataclass(frozen=True, slots=True)
class GrantItem:
    root: str
    path: str
    archive_name: str | None = None


@dataclass(frozen=True, slots=True)
class TransferGrant:
    kind: str
    issued_at: int
    expires_at: int
    download_name: str
    disposition: str
    items: tuple[GrantItem, ...]
    subject: str | None = None
    # Per-subject cap on simultaneous compatibility streams; 0 means unlimited.
    max_streams: int = 0
    # Per-subject cap on simultaneous downloads (attachment files, archives); 0 = unlimited.
    max_downloads: int = 0


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
    now: int | None = None,
) -> str:
    if len(key) != 32:
        raise ValueError("Klucz transferowy musi mieć 32 bajty")
    if kind not in {"file", "archive"}:
        raise ValueError("Nieznany rodzaj transferu")
    if disposition not in {"attachment", "inline"}:
        raise ValueError("Niepoprawny Content-Disposition")
    if not 1 <= ttl_seconds <= 86400:
        raise ValueError("TTL musi mieścić się w zakresie 1..86400")

    issued_at = int(time.time() if now is None else now)
    serialized_items = []
    for item in items:
        row: dict[str, str] = {"root": item.root, "path": item.path}
        if item.archive_name is not None:
            row["archive_name"] = item.archive_name
        serialized_items.append(row)
    if not serialized_items or (kind == "file" and len(serialized_items) != 1):
        raise ValueError("Transfer pliku wymaga jednej pozycji, archiwum co najmniej jednej")

    payload: dict[str, Any] = {
        "v": 1,
        "aud": "transfer",
        "kind": kind,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "name": download_name,
        "disposition": disposition,
        "items": serialized_items,
    }
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

    item_rows = raw.get("items")
    if not isinstance(item_rows, list) or not item_rows:
        raise TokenError("Niepoprawny token")
    if kind == "file" and len(item_rows) != 1:
        raise TokenError("Niepoprawny token")
    if len(item_rows) > max_archive_entries:
        raise TokenError("Niepoprawny token")

    items: list[GrantItem] = []
    for row in item_rows:
        if not isinstance(row, dict):
            raise TokenError("Niepoprawny token")
        root = _clean_text(row.get("root"), "root", 32)
        path = _clean_text(row.get("path"), "path", 4096)
        archive_raw = row.get("archive_name")
        archive_name = None if archive_raw is None else _clean_text(archive_raw, "archive_name", 1024)
        items.append(GrantItem(root=root, path=path, archive_name=archive_name))

    return TransferGrant(
        kind=kind,
        issued_at=issued_at,
        expires_at=expires_at,
        download_name=name,
        disposition=disposition,
        items=tuple(items),
        subject=subject,
        max_streams=max_streams_raw,
        max_downloads=max_downloads_raw,
    )
