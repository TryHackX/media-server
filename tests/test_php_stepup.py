"""The step-up ladder (StepUpGuard): soft threshold, human pass, pause, block, release.

Runs the class against SQLite with an injected clock, so windows and blocks
can be walked through without waiting.
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
foreach (['BridgeException.php', 'StepUpGuard.php'] as $file) {
    require __INTEGRATION__ . '/' . $file;
}
use TryHackX\Media\Integration\StepUpGuard;
use TryHackX\Media\Integration\BridgeRateLimitException;
if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) { echo json_encode(['skip' => true]); exit; }
$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
$db->exec("INSERT INTO users (id, username) VALUES (7, 'listener')");
$db->exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor_user_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, details_json TEXT)');
$db->exec('CREATE TABLE stepup_counters (context TEXT, subject TEXT, bucket INTEGER, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (context, subject, bucket))');
$db->exec('CREATE TABLE stepup_subjects (subject TEXT PRIMARY KEY, user_id INTEGER, context TEXT, state TEXT, until_at INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, audited_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
$now = 1800000000;
$clock = function () use (&$now): int { return $now; };
$settings = [
    'stepup_download_soft' => '3', 'stepup_download_hard' => '5', 'stepup_download_window' => '600',
    'stepup_block_after' => '3', 'stepup_block_minutes' => '30',
];
$guard = new StepUpGuard($db, $settings, $clock);
$client = str_repeat('a', 64);
$subjects = StepUpGuard::subjects(7, $client);
/** admit() as a word: 'ok', 'challenge', or 'pause:<seconds>' / 'block:<seconds>'. */
function attempt(StepUpGuard $guard, array $subjects, bool $pass, bool $challengeable = true): string {
    try {
        return $guard->admit('download', $subjects, 7, $pass, $challengeable) ? 'ok' : 'challenge';
    } catch (BridgeRateLimitException $e) {
        return (str_contains($e->getMessage(), 'zablokowany') ? 'block:' : 'pause:') . $e->retryAfter;
    }
}
function audits(PDO $db): array {
    return $db->query('SELECT action, target_id FROM audit_log ORDER BY id')->fetchAll(PDO::FETCH_NUM);
}
"""


def _php(tmp_path: Path, body: str) -> dict:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    script = tmp_path / "case.php"
    script.write_text(PRELUDE.replace("__INTEGRATION__", json.dumps(str(PHP_INTEGRATION))) + body, encoding="utf-8")
    result = subprocess.run([php, str(script)], capture_output=True, text=True, check=True, timeout=60)
    decoded = json.loads(result.stdout)
    if decoded.get("skip"):
        pytest.skip("pdo_sqlite nie jest dostępne w PHP CLI")
    return decoded


def test_the_ladder_asks_then_pauses_then_blocks(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $steps = [];
        for ($i = 0; $i < 3; $i++) { $steps[] = attempt($guard, $subjects, false); $now += 5; }
        $steps[] = attempt($guard, $subjects, false);            // at soft, no pass: asked
        $steps[] = attempt($guard, $subjects, false);            // still asked, still not counted
        $steps[] = attempt($guard, $subjects, true);             // with a pass: goes on
        $steps[] = attempt($guard, $subjects, true);             // 5th counted
        $steps[] = attempt($guard, $subjects, true);             // at hard: paused (strike 1)
        $steps[] = attempt($guard, $subjects, true);             // strike 2
        $steps[] = attempt($guard, $subjects, true);             // strike 3: blocked
        $blockedSoon = attempt($guard, $subjects, true);
        $now += 29 * 60;
        $blockedLater = attempt($guard, $subjects, true);
        $now += 2 * 60;                                          // block over, window (10 min) slid by too
        $after = attempt($guard, $subjects, false);
        echo json_encode(['steps' => $steps, 'blocked_soon' => $blockedSoon, 'blocked_later' => $blockedLater,
            'after' => $after, 'audits' => audits($db)]);
        """,
    )
    steps = result["steps"]
    assert steps[:3] == ["ok", "ok", "ok"]
    assert steps[3:5] == ["challenge", "challenge"]
    assert steps[5:7] == ["ok", "ok"]
    assert steps[7].startswith("pause:") and steps[8].startswith("pause:")
    # The pause lasts until the window has slid below the hard threshold. Counts
    # are kept in 10-second buckets: the oldest bucket (two hits) began 15 s
    # before, and leaving it is enough, so 600 - 15 + 1 seconds remain.
    assert steps[7] == "pause:586"
    assert steps[9] == "block:1800"
    assert result["blocked_soon"] == "block:1800"
    assert result["blocked_later"] == "block:60"
    assert result["after"] == "ok"
    # One pause entry per subject (not one per refusal) and one block each: the
    # account and its client were counted alike, so both are stopped.
    client = "c:" + "a" * 64
    assert result["audits"] == [
        ["stepup.pause", "u:7"], ["stepup.pause", client], ["stepup.block", "u:7"], ["stepup.block", client],
    ]


def test_a_request_that_cannot_show_a_challenge_is_only_paused(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $steps = [];
        for ($i = 0; $i < 6; $i++) { $steps[] = attempt($guard, $subjects, false, false); }
        echo json_encode(['steps' => $steps]);
        """,
    )
    assert result["steps"][:5] == ["ok"] * 5
    assert result["steps"][5].startswith("pause:")


def test_the_busiest_subject_decides_and_blocks_reach_every_context(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        // Another account from the same client: the client's count is shared.
        $other = StepUpGuard::subjects(8, $client);
        for ($i = 0; $i < 3; $i++) { attempt($guard, $subjects, false); }
        $otherAccount = attempt($guard, $other, false);
        // Strikes from elsewhere (the sign-in limits) block too.
        // The device is the digest of a cookie its caller verified, never the raw cookie.
        $device = StepUpGuard::subjects(null, str_repeat('b', 64), str_repeat('d', 64));
        $unverified = StepUpGuard::subjects(null, str_repeat('b', 64), 'cookie-value');
        for ($i = 0; $i < 3; $i++) { $guard->strike('login', $device, null); }
        try { $guard->assertNotBlocked([$device[1]]); $deviceBlocked = false; }
        catch (BridgeRateLimitException $e) { $deviceBlocked = $e->retryAfter; }
        try { $guard->admit('request', $device, null, true); $requestBlocked = false; }
        catch (BridgeRateLimitException $e) { $requestBlocked = true; }
        echo json_encode(['subjects' => $device, 'other_account' => $otherAccount, 'unverified' => $unverified,
            'device_blocked' => $deviceBlocked, 'request_blocked' => $requestBlocked]);
        """,
    )
    assert result["other_account"] == "challenge", "the shared client is over soft"
    assert result["subjects"] == ["c:" + "b" * 64, "d:" + "d" * 64]
    assert result["unverified"] == ["c:" + "b" * 64], "anything that is not a digest names no device"
    assert result["device_blocked"] == 1800
    assert result["request_blocked"] is True


def test_release_lifts_the_block_and_forgets_the_counts(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        for ($i = 0; $i < 9; $i++) { attempt($guard, $subjects, true); }
        $before = $guard->recentSubjects();
        // Releasing the account lets its client go too; otherwise the client,
        // counted alike, would stop the next request.
        $released = $guard->release('u:7', 1);
        $afterRelease = attempt($guard, $subjects, false);
        try { $guard->release("u:7' OR 1=1", 1); $bad = 'accepted'; } catch (Throwable) { $bad = 'refused'; }
        echo json_encode(['before' => $before, 'released' => $released, 'after' => $afterRelease,
            'bad' => $bad, 'audits' => audits($db), 'left' => $guard->recentSubjects()]);
        """,
    )
    blocked = {row["subject"]: row for row in result["before"] if row["state"] == "blocked"}
    assert set(blocked) == {"u:7", "c:" + "a" * 64}
    assert blocked["u:7"]["username"] == "listener" and blocked["u:7"]["seconds_left"] == 1800
    assert result["released"] is True
    assert result["after"] == "ok"
    assert result["bad"] == "refused"
    assert ["stepup.release", "u:7"] in result["audits"]
    assert result["left"] == []


def test_thresholds_are_clamped_and_hard_never_below_soft(tmp_path: Path) -> None:
    result = _php(
        tmp_path,
        r"""
        $odd = new StepUpGuard($db, ['stepup_request_soft' => '50', 'stepup_request_hard' => '10',
            'stepup_request_window' => '1', 'stepup_pass_minutes' => '0', 'stepup_enabled' => '1'], $clock);
        $off = new StepUpGuard($db, ['stepup_enabled' => '0'], $clock);
        $offResult = [];
        for ($i = 0; $i < 1000; $i++) { $offResult[] = $off->admit('download', $subjects, 7, false); }
        echo json_encode(['request' => $odd->thresholds('request'), 'pass' => $odd->passSeconds(),
            'defaults' => (new StepUpGuard($db, []))->thresholds('download'),
            'off_all_ok' => !in_array(false, $offResult, true),
            'keys' => count(StepUpGuard::settingKeys())]);
        """,
    )
    assert result["request"] == {"soft": 50, "hard": 50, "window": 10}
    assert result["pass"] == 60
    assert result["defaults"] == {"soft": 30, "hard": 100, "window": 3600}
    assert result["off_all_ok"] is True
    assert result["keys"] == 5 + 3 * 6
