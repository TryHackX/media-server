"""Who the request is from, once a reverse proxy stands in front of the bridge.

Login throttling and CAPTCHA both count by address. Behind a proxy every visitor
arrives wearing the proxy's address, so unless the forwarded chain is read they
stop telling anybody apart — and if it is read without checking who delivered it,
a header anyone can write decides who gets throttled.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"


def _client_address(remote: str, forwarded: str | None, trusted: str) -> str:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    body = (
        f"require {json.dumps(str(PHP_INTEGRATION / 'TrustedProxy.php'))};"
        "$t = TryHackX\\Media\\Integration\\TrustedProxy::parseList(" + json.dumps(trusted) + ");"
        "echo TryHackX\\Media\\Integration\\TrustedProxy::clientAddress("
        + json.dumps(remote)
        + ", "
        + ("null" if forwarded is None else json.dumps(forwarded))
        + ", $t);"
    )
    return subprocess.run([php, "-r", body], capture_output=True, text=True, check=True).stdout


def test_with_no_proxy_configured_the_header_is_never_read() -> None:
    # The default. Anyone can send X-Forwarded-For; nobody asked us to believe it.
    assert _client_address("203.0.113.9", "1.2.3.4", "") == "203.0.113.9"


def test_a_header_from_an_untrusted_peer_is_ignored() -> None:
    assert _client_address("203.0.113.9", "1.2.3.4", "198.51.100.7") == "203.0.113.9"


def test_the_client_is_taken_from_a_trusted_proxy() -> None:
    assert _client_address("198.51.100.7", "203.0.113.9", "198.51.100.7") == "203.0.113.9"


def test_our_own_hops_are_skipped_from_the_right() -> None:
    """Two proxies of ours in the chain; the visitor is the first address to
    their left that nobody vouches for."""
    chain = "203.0.113.9, 198.51.100.7, 198.51.100.8"
    assert _client_address("198.51.100.8", chain, "198.51.100.7 198.51.100.8") == "203.0.113.9"


def test_a_spoofed_prefix_cannot_reach_past_a_hop_we_cannot_read() -> None:
    """Everything left of an unreadable hop could have been invented by the
    client, so the chain stops being evidence there."""
    assert _client_address("198.51.100.7", "1.2.3.4, nonsense", "198.51.100.7") == "198.51.100.7"


def test_an_empty_or_absent_header_leaves_the_peer() -> None:
    assert _client_address("198.51.100.7", None, "198.51.100.7") == "198.51.100.7"
    assert _client_address("198.51.100.7", "", "198.51.100.7") == "198.51.100.7"


def test_ipv6_is_compared_by_value_not_by_spelling() -> None:
    # ::1 and 0:0:0:0:0:0:0:1 are the same address written two ways.
    assert _client_address("0:0:0:0:0:0:0:1", "203.0.113.9", "::1") == "203.0.113.9"


def test_brackets_and_padding_a_proxy_adds_are_stripped() -> None:
    assert _client_address("198.51.100.7", " [2001:db8::5] ", "198.51.100.7") == "2001:db8::5"


def _is_https(remote: str, direct: bool, proto: str | None, trusted: str) -> bool:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    body = (
        f"require {json.dumps(str(PHP_INTEGRATION / 'TrustedProxy.php'))};"
        "$t = TryHackX\\Media\\Integration\\TrustedProxy::parseList(" + json.dumps(trusted) + ");"
        "var_export(TryHackX\\Media\\Integration\\TrustedProxy::isHttps("
        + json.dumps(remote)
        + ", "
        + ("true" if direct else "false")
        + ", "
        + ("null" if proto is None else json.dumps(proto))
        + ", $t));"
    )
    return subprocess.run([php, "-r", body], capture_output=True, text=True, check=True).stdout == "true"


def test_our_own_tls_always_counts() -> None:
    assert _is_https("203.0.113.9", True, None, "") is True


def test_without_a_trusted_proxy_the_header_cannot_claim_tls() -> None:
    """Otherwise any visitor could assert their plaintext connection is secure,
    and the session cookie would go out with Secure over plain HTTP."""
    assert _is_https("203.0.113.9", False, "https", "") is False
    assert _is_https("203.0.113.9", False, "https", "198.51.100.7") is False


def test_a_trusted_proxy_may_report_the_visitor_spoke_https() -> None:
    assert _is_https("198.51.100.7", False, "https", "198.51.100.7") is True
    assert _is_https("198.51.100.7", False, "HTTPS", "198.51.100.7") is True


def test_a_trusted_proxy_reporting_plain_http_is_believed_too() -> None:
    assert _is_https("198.51.100.7", False, "http", "198.51.100.7") is False
    assert _is_https("198.51.100.7", False, None, "198.51.100.7") is False


def test_a_chain_is_read_from_the_left_where_the_visitor_is() -> None:
    # proxy appends, so the first entry is the scheme the browser spoke.
    assert _is_https("198.51.100.7", False, "https, http", "198.51.100.7") is True
