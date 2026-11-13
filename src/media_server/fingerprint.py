"""
Recognising the same file again, cheaply.

The catalogue identifies a file by where it is: a row id that means nothing
outside this database, and a path that means nothing outside this disk. Neither
travels, and a path cannot be exported anyway because it draws a map of the
library for whoever receives the file.

This is the third answer. It hashes the file's **size together with its first
and last 64 KiB** — two reads, whatever the file weighs — so a forty-gigabyte
remux costs the same as a four-megabyte song.

Be clear about what that is and is not:

* It is **not** a checksum of the file. Reading every byte of this library would
  take hours, and the whole point is to be light enough to run during a scan.
* Two different files colliding by accident is not a thing that happens: they
  would have to share a byte length *and* both ends exactly.
* Two different files colliding **on purpose** is easy to arrange. So this may
  match a rating to a file; it may never authorise anything or stand in for an
  integrity check.
* Re-encoding a file changes its fingerprint, which is correct — that is a
  different file, even if a person would call it the same song.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

__all__ = ["CHUNK_BYTES", "fingerprint_file"]

# Enough of each end that two different files sharing both is not a coincidence
# anyone will meet, and small enough that reading it costs a seek, not a wait.
CHUNK_BYTES = 64 * 1024

# 16 bytes is 32 hex characters, which is what the column holds. A wider digest
# would buy collision resistance this is explicitly not claiming.
_DIGEST_BYTES = 16


def fingerprint_file(path: Path, size: int | None = None) -> str | None:
    """
    The fingerprint of one file, or None when it cannot be read.

    The size goes in first so that two files sharing both ends but differing in
    length — a truncated download next to its complete copy — never agree.
    """
    try:
        if size is None:
            size = path.stat().st_size
        digest = hashlib.blake2b(digest_size=_DIGEST_BYTES)
        digest.update(str(size).encode("ascii"))
        with path.open("rb") as handle:
            head = handle.read(CHUNK_BYTES)
            digest.update(head)
            # Only seek for a tail that is not already in the head; a file
            # smaller than one chunk has been read in full by the line above.
            if size > CHUNK_BYTES:
                handle.seek(max(CHUNK_BYTES, size - CHUNK_BYTES))
                digest.update(handle.read(CHUNK_BYTES))
        return digest.hexdigest()
    except OSError:
        # A file that cannot be read is left without a fingerprint rather than
        # given a wrong one; the next scan will try it again.
        return None
