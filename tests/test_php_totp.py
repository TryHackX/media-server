"""Two-factor sign-in: TOTP (RFC 6238 / RFC 4226 vectors), replay, recovery codes, encryption at rest."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"

PRELUDE = r"""<?php
declare(strict_types=1);
foreach (['BridgeException.php', 'Totp.php', 'TwoFactor.php'] as $file) {
    require __INTEGRATION__ . '/' . $file;
}
use TryHackX\Media\Integration\Totp;
use TryHackX\Media\Integration\TwoFactor;
if (!in_array('sqlite', PDO::getAvailableDrivers(), true) || !extension_loaded('openssl')) { echo json_encode(['skip' => true]); exit; }
$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('CREATE TABLE user_two_factor (user_id INTEGER PRIMARY KEY, secret_ciphertext TEXT NOT NULL, enabled_at INTEGER, pending_since INTEGER NOT NULL, last_step INTEGER, recovery_codes TEXT)');
$now = 1800000000;
$clock = function () use (&$now): int { return $now; };
$twoFactor = new TwoFactor($db, str_repeat('e', 32), str_repeat('r', 32), $clock);
"""

# RFC 6238 appendix B, SHA-1, 8 digits; the seed is the ASCII "12345678901234567890".
RFC6238 = {59: "94287082", 1111111109: "07081804", 1111111111: "14050471",
           1234567890: "89005924", 2000000000: "69279037", 20000000000: "65353130"}
# RFC 4226 appendix D, counters 0-9.
RFC4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]


def _php(tmp_path: Path, body: str) -> dict:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    script = tmp_path / "case.php"
    script.write_text(PRELUDE.replace("__INTEGRATION__", json.dumps(str(PHP_INTEGRATION))) + body, encoding="utf-8")
    result = subprocess.run([php, str(script)], capture_output=True, text=True, check=True, timeout=60)
    decoded = json.loads(result.stdout)
    if decoded.get("skip"):
        pytest.skip("pdo_sqlite albo openssl niedostępne w PHP CLI")
    return decoded


def test_rfc_vectors(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $seed = '12345678901234567890';
        $secret = Totp::base32Encode($seed);
        $totp = [];
        foreach ([59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000] as $t) {
            $totp[(string) $t] = Totp::codeAt($secret, $t, 8);
        }
        $hotp = [];
        for ($c = 0; $c < 10; $c++) { $hotp[] = Totp::hotp($seed, $c); }
        echo json_encode(['secret' => $secret, 'totp' => $totp, 'hotp' => $hotp,
            'roundtrip' => Totp::base32Decode(strtolower(chunk_split($secret, 4, ' '))) === $seed,
            'bad' => Totp::base32Decode('not base32!'), 'generated' => strlen(Totp::generateSecret())]);
        """,
    )
    assert result["secret"] == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert result["totp"] == {str(k): v for k, v in RFC6238.items()}
    assert result["hotp"] == RFC4226
    assert result["roundtrip"] is True and result["bad"] is None
    assert result["generated"] == 32


def test_verify_window_and_replay(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $secret = Totp::base32Encode('12345678901234567890');
        $t = 1111111111;
        $step = Totp::step($t);
        $code = fn (int $s) => Totp::codeAt($secret, $s * 30);
        echo json_encode([
            'now' => Totp::verify($secret, $code($step), $t) === $step,
            'previous' => Totp::verify($secret, $code($step - 1), $t) === $step - 1,
            'next' => Totp::verify($secret, $code($step + 1), $t) === $step + 1,
            'two_back' => Totp::verify($secret, $code($step - 2), $t),
            'two_ahead' => Totp::verify($secret, $code($step + 2), $t),
            'replay' => Totp::verify($secret, $code($step), $t, $step),
            'older_than_last' => Totp::verify($secret, $code($step - 1), $t, $step),
            'spaces' => Totp::verify($secret, substr($code($step), 0, 3) . ' ' . substr($code($step), 3), $t) === $step,
            'letters' => Totp::verify($secret, 'abcdef', $t),
            'short' => Totp::verify($secret, '12345', $t),
            'uri' => Totp::uri('TryHackX Media', 'listener', $secret),
        ]);
        """,
    )
    assert result["now"] and result["previous"] and result["next"] and result["spaces"]
    assert result["two_back"] is None and result["two_ahead"] is None
    assert result["replay"] is None, "a code of the step already used must not work again"
    assert result["older_than_last"] is None
    assert result["letters"] is None and result["short"] is None
    assert result["uri"] == (
        "otpauth://totp/TryHackX%20Media:listener?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # gitleaks:allow - RFC 6238 test secret
        "&issuer=TryHackX%20Media&algorithm=SHA1&digits=6&period=30"
    )


def test_setup_codes_recovery_and_replay(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $setup = $twoFactor->beginSetup(7, 'listener', 'TryHackX Media');
        $pending = $twoFactor->status(7);
        $wrong = $twoFactor->confirmSetup(7, '000000' === Totp::codeAt($setup['secret'], $now) ? '111111' : '000000');
        $codes = $twoFactor->confirmSetup(7, Totp::codeAt($setup['secret'], $now));
        $enabled = $twoFactor->status(7);
        $sameCode = $twoFactor->verify(7, Totp::codeAt($setup['secret'], $now));
        $now += 30;
        $nextCode = $twoFactor->verify(7, Totp::codeAt($setup['secret'], $now));
        $recoveryOnce = $twoFactor->verify(7, strtoupper(str_replace('-', ' ', $codes[3])));
        $recoveryTwice = $twoFactor->verify(7, $codes[3]);
        $left = $twoFactor->status(7)['recovery_left'];
        $fresh = $twoFactor->regenerateRecovery(7);
        $oldAfterRegenerate = $twoFactor->verify(7, $codes[4]);
        $newWorks = $twoFactor->verify(7, $fresh[0]);
        try { $twoFactor->beginSetup(7, 'listener', 'TryHackX Media'); $again = 'allowed'; } catch (Throwable) { $again = 'refused'; }
        $disabled = $twoFactor->disable(7);
        echo json_encode(['uri' => $setup['otpauth_uri'], 'pending' => $pending, 'wrong' => $wrong, 'codes' => $codes,
            'enabled' => $enabled, 'same_code' => $sameCode, 'next_code' => $nextCode,
            'recovery_once' => $recoveryOnce, 'recovery_twice' => $recoveryTwice, 'left' => $left,
            'old_after_regenerate' => $oldAfterRegenerate, 'new_works' => $newWorks, 'again' => $again,
            'disabled' => $disabled, 'after_disable' => $twoFactor->status(7), 'ids' => $twoFactor->enabledUserIds()]);
        """,
    )
    assert result["uri"].startswith("otpauth://totp/TryHackX%20Media:listener?secret=")
    assert result["pending"] == {"enabled": False, "pending": True, "recovery_left": 0}
    assert result["wrong"] == []
    codes = result["codes"]
    assert len(codes) == 10 and len(set(codes)) == 10
    assert all(len(code) == 11 and code[5] == "-" for code in codes)
    assert result["enabled"] == {"enabled": True, "pending": False, "recovery_left": 10}
    assert result["same_code"] is None, "the code that confirmed the setup is spent"
    assert result["next_code"] == "totp"
    assert result["recovery_once"] == "recovery" and result["recovery_twice"] is None
    assert result["left"] == 9
    assert result["old_after_regenerate"] is None and result["new_works"] == "recovery"
    assert result["again"] == "refused"
    assert result["disabled"] is True
    assert result["after_disable"] == {"enabled": False, "pending": False, "recovery_left": 0}
    assert result["ids"] == []


def test_the_secret_is_encrypted_and_bound_to_its_account(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $setup = $twoFactor->beginSetup(7, 'listener', 'TryHackX Media');
        $stored = $db->query('SELECT secret_ciphertext FROM user_two_factor WHERE user_id = 7')->fetchColumn();
        $otherKey = new TwoFactor($db, str_repeat('x', 32), str_repeat('r', 32), $clock);
        try { $otherKey->decrypt(7, $stored); $wrongKey = 'decrypted'; } catch (RuntimeException) { $wrongKey = 'refused'; }
        try { $twoFactor->decrypt(8, $stored); $moved = 'decrypted'; } catch (RuntimeException) { $moved = 'refused'; }
        $now += TwoFactor::SETUP_TTL_SECONDS + 1;
        $expired = $twoFactor->status(7);
        try { $twoFactor->confirmSetup(7, Totp::codeAt($setup['secret'], $now)); $late = 'accepted'; } catch (Throwable) { $late = 'refused'; }
        echo json_encode(['plain_in_db' => str_contains($stored, $setup['secret']), 'prefix' => substr($stored, 0, 3),
            'decrypts' => $twoFactor->decrypt(7, $stored) === $setup['secret'], 'wrong_key' => $wrongKey,
            'moved' => $moved, 'expired' => $expired, 'late' => $late]);
        """,
    )
    assert result["plain_in_db"] is False and result["prefix"] == "v1."
    assert result["decrypts"] is True
    assert result["wrong_key"] == "refused"
    assert result["moved"] == "refused", "a secret copied to another account must not decrypt"
    assert result["expired"]["pending"] is False
    assert result["late"] == "refused"
