from __future__ import annotations

from email.utils import formatdate

import pytest

from media_server.ranges import ByteRangeError, if_range_matches, parse_single_range


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, None),
        ("bytes=0-9", (0, 9)),
        ("bytes=5-", (5, 99)),
        ("bytes=-10", (90, 99)),
        ("bytes=95-200", (95, 99)),
        ("bytes=0-1,5-6", None),
        # Range units are case-insensitive.
        ("Bytes=0-9", (0, 9)),
    ],
)
def test_range_forms(header: str | None, expected: tuple[int, int] | None) -> None:
    assert parse_single_range(header, 100) == expected


@pytest.mark.parametrize("header", ["bytes=", "bytes=100-", "bytes=10-5", "bytes=-0", "bytes=a-b"])
def test_invalid_range_returns_total_size(header: str) -> None:
    with pytest.raises(ByteRangeError) as error:
        parse_single_range(header, 100)
    assert error.value.content_range == "bytes */100"


@pytest.mark.parametrize("header", ["items=0-1", "seconds=0-10", "none", "bytes"])
def test_a_range_unit_the_server_does_not_know_is_ignored_not_refused(header: str) -> None:
    """RFC 9110, 14.2: an unknown unit is ignored and the whole file goes out — not a 416."""
    assert parse_single_range(header, 100) is None


def test_if_range_requires_strong_matching_etag() -> None:
    etag = '"abc"'
    assert if_range_matches(etag, etag, 0)
    assert not if_range_matches('W/"abc"', etag, 0)
    assert not if_range_matches('"different"', etag, 0)


def test_an_if_range_date_matches_only_the_exact_last_modified() -> None:
    """RFC 9110, 13.1.5: the date must be the representation's own, not merely later.

    "Not newer than" matched any later date — a client's clock, a Date header —
    and a client holding the start of the previous file got a range of the new
    one spliced onto it.
    """
    mtime_ns = 1_700_000_000_250_000_000  # a fraction past the second, as files have
    last_modified = formatdate(mtime_ns / 1_000_000_000, usegmt=True)
    assert if_range_matches(last_modified, '"etag"', mtime_ns)
    later = formatdate(1_700_000_000 + 3600, usegmt=True)
    earlier = formatdate(1_700_000_000 - 1, usegmt=True)
    assert not if_range_matches(later, '"etag"', mtime_ns)
    assert not if_range_matches(earlier, '"etag"', mtime_ns)
    assert not if_range_matches("not a date", '"etag"', mtime_ns)
