"""Captcha providers (CaptchaGuard) and our own proof of work (ProofOfWork).

No network: third-party verification goes through an injected transport that
records what it was sent and answers like the provider would.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"

PRELUDE = r"""<?php
declare(strict_types=1);
foreach (['BridgeException.php', 'ProofOfWork.php', 'CaptchaGuard.php'] as $file) {
    require __INTEGRATION__ . '/' . $file;
}
use TryHackX\Media\Integration\CaptchaGuard;
use TryHackX\Media\Integration\ProofOfWork;
use TryHackX\Media\Integration\BridgeCaptchaRequiredException;
use TryHackX\Media\Integration\BridgeRequestException;
if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) { echo json_encode(['skip' => true]); exit; }
$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('CREATE TABLE captcha_spent (challenge CHAR(64) PRIMARY KEY, expires_at INTEGER NOT NULL)');
$now = 1800000000;
$clock = function () use (&$now): int { return $now; };
$pow = new ProofOfWork($db, str_repeat('k', 32), 2000, $clock);
function solve(array $c): string {
    for ($n = 0; $n <= $c['maxnumber']; $n++) {
        if (hash('sha256', $c['salt'] . $n) === $c['challenge']) {
            return base64_encode(json_encode(['algorithm' => $c['algorithm'], 'challenge' => $c['challenge'],
                'number' => $n, 'salt' => $c['salt'], 'signature' => $c['signature']]));
        }
    }
    throw new RuntimeException('unsolved');
}
"""


def _php(tmp_path: Path, body: str) -> dict:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    script = tmp_path / "case.php"
    script.write_text(
        PRELUDE.replace("__INTEGRATION__", json.dumps(str(PHP_INTEGRATION))) + body, encoding="utf-8"
    )
    result = subprocess.run([php, str(script)], capture_output=True, text=True, check=True, timeout=60)
    decoded = json.loads(result.stdout)
    if decoded.get("skip"):
        pytest.skip("pdo_sqlite nie jest dostępne w PHP CLI")
    return decoded


def test_pow_solution_is_accepted_once(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $c = $pow->challenge();
        $token = solve($c);
        echo json_encode(['shape' => array_keys($c), 'max' => $c['maxnumber'],
            'first' => $pow->verify($token), 'replay' => $pow->verify($token)]);
        """,
    )
    assert result["shape"] == ["algorithm", "challenge", "salt", "maxnumber", "signature"]
    assert result["max"] == 2000
    assert result["first"] is True
    assert result["replay"] is False, "a spent challenge must not be accepted again"


def test_pow_rejects_expired_forged_and_wrong_answers(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $c = $pow->challenge();
        $token = solve($c);
        $decoded = json_decode(base64_decode($token), true);
        $wrong = base64_encode(json_encode(['number' => $decoded['number'] + 1] + $decoded));
        $forged = base64_encode(json_encode(['signature' => hash_hmac('sha256', $c['challenge'], 'other')] + $decoded));
        // A challenge of its own making: right answer, but not signed by us.
        $salt = bin2hex(random_bytes(12)) . '.' . ($now + 60) . '.';
        $own = ['algorithm' => 'SHA-256', 'challenge' => hash('sha256', $salt . 5), 'salt' => $salt,
            'maxnumber' => 10, 'signature' => str_repeat('0', 64)];
        $other = new ProofOfWork($db, str_repeat('x', 32), 2000, $clock);
        $fresh = $pow->challenge();
        $freshToken = solve($fresh);
        $now += ProofOfWork::TTL_SECONDS + 1;
        echo json_encode([
            'wrong' => $pow->verify($wrong),
            'forged' => $pow->verify($forged),
            'own' => $pow->verify(solve($own)),
            'other_key' => $other->verify($token),
            'expired' => $pow->verify($freshToken),
            'garbage' => $pow->verify('not base64 json'),
            'empty' => $pow->verify(''),
        ]);
        """,
    )
    assert result == {
        "wrong": False, "forged": False, "own": False, "other_key": False,
        "expired": False, "garbage": False, "empty": False,
    }


def test_pow_rejects_an_expiry_pushed_into_the_future(tmp_path: Path) -> None:
    # The expiry sits in the salt; a client that moves it must also change the
    # challenge, which the signature then no longer covers.
    result = _php(
        tmp_path,
        r"""
        $c = $pow->challenge();
        $d = json_decode(base64_decode(solve($c)), true);
        $parts = explode('.', $d['salt']);
        $d['salt'] = $parts[0] . '.' . ((int) $parts[1] + 86400) . '.';
        echo json_encode(['moved' => $pow->verify(base64_encode(json_encode($d)))]);
        """,
    )
    assert result["moved"] is False


def test_pow_difficulty_is_clamped() -> None:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    script = (
        f"require {json.dumps(str(PHP_INTEGRATION / 'ProofOfWork.php'))};"
        "use TryHackX\\Media\\Integration\\ProofOfWork as P;"
        "echo json_encode([P::clampMaxNumber('5'), P::clampMaxNumber('99999999'), P::clampMaxNumber(null), P::clampMaxNumber('300000')]);"
    )
    result = subprocess.run([php, "-r", script], capture_output=True, text=True, check=True, timeout=30)
    assert json.loads(result.stdout) == [1000, 10000000, 200000, 300000]


def _guard_case(settings: dict, body: str) -> str:
    return (
        "$sent = [];"
        "$answer = null;"
        "$transport = function (string $url, array $fields) use (&$sent, &$answer): ?array {"
        "    $sent[] = ['url' => $url, 'fields' => $fields]; return $answer; };"
        f"$guard = new CaptchaGuard(json_decode({json.dumps(json.dumps(settings))}, true), $pow, $transport);"
        + body
    )


V3 = {
    "captcha_provider": "recaptcha_v3",
    "captcha_site_key_recaptcha_v3": "site-v3",
    "captcha_secret_key_recaptcha_v3": "secret-v3",
    "captcha_site_key_turnstile": "site-ts",
    "captcha_secret_key_turnstile": "secret-ts",
    "captcha_v3_min_score": "0.7",
}


def test_recaptcha_v3_checks_score_and_action(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        _guard_case(
            V3,
            r"""
            $results = [];
            foreach ([
                'good' => ['success' => true, 'score' => 0.9, 'action' => 'login'],
                'edge' => ['success' => true, 'score' => 0.7, 'action' => 'login'],
                'low' => ['success' => true, 'score' => 0.3, 'action' => 'login'],
                'other_action' => ['success' => true, 'score' => 0.9, 'action' => 'register'],
                'no_score' => ['success' => true, 'action' => 'login'],
                'failed' => ['success' => false, 'score' => 0.9, 'action' => 'login'],
            ] as $name => $reply) {
                $answer = $reply;
                $results[$name] = $guard->verify('recaptcha_v3', 'token', '203.0.113.9', 'login');
            }
            $answer = null;
            try { $guard->verify('recaptcha_v3', 'token', '::1', 'login'); $results['down'] = 'accepted'; }
            catch (RuntimeException) { $results['down'] = 'refused'; }
            echo json_encode($results + ['sent' => $sent[0], 'min' => $guard->minScore()]);
            """,
        ),
    )
    assert result["good"] is True and result["edge"] is True
    assert result["low"] is False, "below the minimum score"
    assert result["other_action"] is False, "a token minted for another form"
    assert result["no_score"] is False, "a v2 key pasted under v3 answers without a score"
    assert result["failed"] is False
    assert result["down"] == "refused", "an unreachable provider must not let the request through"
    assert result["min"] == 0.7
    assert result["sent"]["url"] == "https://www.google.com/recaptcha/api/siteverify"
    assert result["sent"]["fields"] == {"secret": "secret-v3", "response": "token", "remoteip": "203.0.113.9"}


def test_each_provider_keeps_its_own_keys(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        _guard_case(
            V3,
            r"""
            $answer = ['success' => true];
            $ok = $guard->verify('turnstile', 'tok', 'not-an-ip', 'login');
            echo json_encode([
                'provider' => $guard->provider(),
                'site' => $guard->siteKey(),
                'turnstile_site' => $guard->siteKey('turnstile'),
                'turnstile_ok' => $ok,
                'turnstile_sent' => $sent[0],
                'unconfigured' => $guard->verify('hcaptcha', 'tok', '::1', 'login'),
            ]);
            """,
        ),
    )
    assert result["provider"] == "recaptcha_v3"
    assert result["site"] == "site-v3" and result["turnstile_site"] == "site-ts"
    assert result["turnstile_ok"] is True
    assert result["turnstile_sent"]["url"].startswith("https://challenges.cloudflare.com/")
    assert result["turnstile_sent"]["fields"] == {"secret": "secret-ts", "response": "tok"}
    assert result["unconfigured"] is False, "a provider without keys verifies nothing"


def test_sign_in_falls_back_to_proof_of_work(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        _guard_case(
            {"captcha_provider": "hcaptcha", "captcha_site_key_hcaptcha": "only-site",
             "captcha_protect_registration": "1", "captcha_protect_login": "1"},
            r"""
            $none = new CaptchaGuard(['captcha_provider' => 'none'], $pow, $transport);
            $powOnly = new CaptchaGuard(['captcha_provider' => 'pow', 'captcha_login_mode' => 'always'], $pow, $transport);
            $token = solve($pow->challenge());
            echo json_encode([
                'half_configured' => $guard->isConfigured(),
                'half_protects' => $guard->protects('register'),
                'half_step_up' => $guard->signInProvider(),
                'legacy_mode' => $guard->loginMode(),
                'none_step_up' => $none->signInProvider(),
                'none_mode' => $none->loginMode(),
                'pow_protects_login' => $powOnly->protects('login'),
                'pow_verifies' => $powOnly->verify('pow', $token, '::1', 'login'),
                'no_network' => count($sent),
            ]);
            """,
        ),
    )
    assert result["half_configured"] is False
    assert result["half_protects"] is False, "half-configured protection fails open"
    assert result["half_step_up"] == "pow"
    assert result["legacy_mode"] == "always", "the old 'protect sign-in' box reads as 'always'"
    assert result["none_step_up"] == "pow"
    assert result["none_mode"] == "after"
    assert result["pow_protects_login"] is True
    assert result["pow_verifies"] is True
    assert result["no_network"] == 0


def test_an_unreachable_provider_is_a_refusal_the_bridge_can_explain(tmp_path: Path) -> None:
    """Not an open door, and not "internal error" either: the bridge answers 503 with the message (S-13)."""
    result = _php(
        tmp_path,
        _guard_case(
            {"captcha_provider": "turnstile", "captcha_site_key_turnstile": "site-ts",
             "captcha_secret_key_turnstile": "secret-ts", "captcha_protect_registration": "1"},
            r"""
            $answer = null;
            try { $guard->verify('turnstile', 'token', '::1', 'register'); $out = ['passed' => true]; }
            catch (\TryHackX\Media\Integration\BridgeUnavailableException $e) { $out = ['unavailable' => $e->getMessage()]; }
            echo json_encode($out);
            """,
        ),
    )
    assert result == {"unavailable": "Usługa weryfikacji antybotowej nie odpowiada. Spróbuj ponownie za chwilę."}
