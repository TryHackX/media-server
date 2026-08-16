from __future__ import annotations

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
    ],
)
def test_range_forms(header: str | None, expected: tuple[int, int] | None) -> None:
    assert parse_single_range(header, 100) == expected


@pytest.mark.parametrize("header", ["bytes=", "bytes=100-", "bytes=10-5", "items=0-1", "bytes=-0"])
def test_invalid_range_returns_total_size(header: str) -> None:
    with pytest.raises(ByteRangeError) as error:
        parse_single_range(header, 100)
    assert error.value.content_range == "bytes */100"


def test_if_range_requires_strong_matching_etag() -> None:
    etag = '"abc"'
    assert if_range_matches(etag, etag, 0)
    assert not if_range_matches('W/"abc"', etag, 0)
    assert not if_range_matches('"different"', etag, 0)
