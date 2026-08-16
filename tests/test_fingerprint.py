"""What the fingerprint promises, and what it deliberately does not."""

from __future__ import annotations

from pathlib import Path

from media_server.fingerprint import CHUNK_BYTES, fingerprint_file


def _write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def test_the_same_bytes_give_the_same_fingerprint(tmp_path: Path) -> None:
    left = _write(tmp_path / "a.mp3", b"the same content" * 100)
    right = _write(tmp_path / "b.mp3", b"the same content" * 100)
    # The name is not part of it: one recording filed twice must be recognised.
    assert fingerprint_file(left) == fingerprint_file(right)


def test_a_different_length_is_a_different_file(tmp_path: Path) -> None:
    # A truncated download shares both ends with the complete copy, so the size
    # has to be in the hash or the two would agree.
    whole = _write(tmp_path / "whole.mp3", b"x" * (CHUNK_BYTES * 4))
    cut = _write(tmp_path / "cut.mp3", b"x" * (CHUNK_BYTES * 3))
    assert fingerprint_file(whole) != fingerprint_file(cut)


def test_a_changed_end_is_a_different_file(tmp_path: Path) -> None:
    body = bytearray(b"y" * (CHUNK_BYTES * 4))
    original = _write(tmp_path / "one.mkv", bytes(body))
    body[-1] = ord("z")
    changed = _write(tmp_path / "two.mkv", bytes(body))
    assert fingerprint_file(original) != fingerprint_file(changed)


def test_a_changed_start_is_a_different_file(tmp_path: Path) -> None:
    body = bytearray(b"y" * (CHUNK_BYTES * 4))
    original = _write(tmp_path / "one.mkv", bytes(body))
    body[0] = ord("z")
    changed = _write(tmp_path / "two.mkv", bytes(body))
    assert fingerprint_file(original) != fingerprint_file(changed)


def test_the_middle_is_not_read(tmp_path: Path) -> None:
    """
    The documented limit, pinned by a test so nobody mistakes this for a checksum.

    Two files identical at both ends and different in between agree. That is the
    price of two reads instead of forty gigabytes, and it is why a fingerprint
    may match a rating and may never authorise anything.
    """
    body = bytearray(b"m" * (CHUNK_BYTES * 4))
    original = _write(tmp_path / "one.mkv", bytes(body))
    body[CHUNK_BYTES * 2] = ord("!")
    middle_changed = _write(tmp_path / "two.mkv", bytes(body))
    assert fingerprint_file(original) == fingerprint_file(middle_changed)


def test_a_short_file_is_read_whole(tmp_path: Path) -> None:
    small = _write(tmp_path / "tiny.mp3", b"abc")
    other = _write(tmp_path / "tiny2.mp3", b"abd")
    assert fingerprint_file(small) is not None
    assert fingerprint_file(small) != fingerprint_file(other)


def test_an_empty_file_still_answers(tmp_path: Path) -> None:
    assert fingerprint_file(_write(tmp_path / "empty.mp3", b"")) is not None


def test_a_missing_file_gives_nothing_rather_than_a_wrong_answer(tmp_path: Path) -> None:
    assert fingerprint_file(tmp_path / "gone.mp3") is None


def test_the_digest_fits_the_column(tmp_path: Path) -> None:
    value = fingerprint_file(_write(tmp_path / "a.mp3", b"data"))
    assert value is not None
    assert len(value) == 32
    assert all(character in "0123456789abcdef" for character in value)
