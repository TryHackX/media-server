"""The device cookie behind the per-account sign-in limit (AccountGateway::login).

A browser that has signed in to an account gets a signed, dated cookie bound to
that account; it is what exempts the owner's devices from the per-account limit,
so it must not be forgeable, transferable to another account or immortal.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"


def _php(body: str) -> dict:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    requires = "".join(
        f"require {json.dumps(str(PHP_INTEGRATION / name))};"
        for name in ("BridgeException.php", "LegacyIdentity.php", "Mailer.php", "AccountGateway.php")
    )
    prelude = (
        "use TryHackX\\Media\\Integration\\AccountGateway as A; use TryHackX\\Media\\Integration\\Mailer as M;"
        "if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) { echo json_encode(['skip' => true]); exit; }"
        "$key = str_repeat('k', 32);"
        "$gate = new A(new PDO('sqlite::memory:'), new M([]), '/', $key);"
        "$known = new ReflectionMethod(A::class, 'knownDevice');"
        "$check = fn (?string $cookie, ?int $user) => $known->invoke($gate, $cookie, $user);"
    )
    result = subprocess.run([php, "-r", requires + prelude + body], capture_output=True, text=True, check=True)
    decoded = json.loads(result.stdout)
    if decoded.get("skip"):
        pytest.skip("pdo_sqlite nie jest dostępne w PHP CLI")
    return decoded


def test_a_cookie_is_known_only_to_its_own_account() -> None:
    result = _php(
        "$cookie = $gate->deviceCookieFor(7);"
        "echo json_encode(['shape' => (bool) preg_match('/\\\\Av1\\\\.7\\\\.[0-9]+\\\\.[A-Za-z0-9_-]{22}\\\\.[A-Za-z0-9_-]{43}\\\\z/', $cookie),"
        " 'own' => $check($cookie, 7), 'other' => $check($cookie, 8), 'unknown_user' => $check($cookie, null),"
        " 'none' => $check(null, 7), 'two' => $gate->deviceCookieFor(7) !== $cookie]);"
    )
    assert result["shape"] is True
    assert isinstance(result["own"], str) and len(result["own"]) == 64
    assert result["other"] is None and result["unknown_user"] is None and result["none"] is None
    assert result["two"] is True, "every sign-in gets a fresh cookie"


def test_a_forged_or_expired_cookie_is_not_known() -> None:
    result = _php(
        "$cookie = $gate->deviceCookieFor(7);"
        "[$v, $user, $issued, $nonce, $mac] = explode('.', $cookie);"
        "$mac2 = fn (string $i) => rtrim(strtr(base64_encode(hash_hmac('sha256', \"device|v1|7|{$i}|{$nonce}\", $key, true)), '+/', '-_'), '=');"
        "$old = (string) (time() - A::DEVICE_COOKIE_TTL_SECONDS - 10);"
        "$future = (string) (time() + 3600);"
        "echo json_encode(["
        " 'mac' => $check(\"v1.7.{$issued}.{$nonce}.\" . str_repeat('A', 43), 7),"
        " 'redated' => $check(\"v1.7.{$old}.{$nonce}.{$mac}\", 7),"
        " 'expired' => $check(\"v1.7.{$old}.{$nonce}.\" . $mac2($old), 7),"
        " 'future' => $check(\"v1.7.{$future}.{$nonce}.\" . $mac2($future), 7),"
        " 'fresh' => $check(\"v1.7.{$issued}.{$nonce}.\" . $mac2($issued), 7) !== null,"
        " 'other_key' => (new ReflectionMethod(A::class, 'knownDevice'))->invoke(new A(new PDO('sqlite::memory:'), new M([]), '/', str_repeat('x', 32)), $cookie, 7),"
        " 'no_key' => (new A(new PDO('sqlite::memory:'), new M([]), '/'))->deviceCookieFor(7),"
        "]);"
    )
    assert result["mac"] is None
    assert result["redated"] is None, "the date is covered by the signature"
    assert result["expired"] is None and result["future"] is None
    assert result["fresh"] is True
    assert result["other_key"] is None
    assert result["no_key"] is None, "without a key the bridge trusts no device"
