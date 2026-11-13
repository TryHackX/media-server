"""Accounts, limits and the step-up ladder against MySQL (AccountGateway, StepUpGuard, CatalogActions).

The sign-in limits and the rules about who may change whose account are only
as good as the keys they count under and the cases they refuse — both are
checked here against the real schema and its collations.
"""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import time
import zlib

from bridge_harness import TEST_PASSWORD

GATEWAY = r"""
$deviceKey = str_repeat('k', 32);
$gateway = new AccountGateway($db, $mailer, 'http://media.test/', $deviceKey, 0);
$attempts = static fn (PDO $db, string $kind): array => $db
    ->query("SELECT identifier, COUNT(*) AS failures FROM auth_attempts WHERE kind = '{$kind}' AND succeeded = 0 GROUP BY identifier ORDER BY identifier")
    ->fetchAll(PDO::FETCH_KEY_PAIR);
"""


def _png(width: int = 64, height: int = 64) -> bytes:
    """A real picture of the smallest kind: one grey PNG."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + b"\x80" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def test_every_spelling_of_a_name_counts_towards_the_same_account(bridge_db, bridge_php) -> None:
    """`ádmin`, `ADMIN` and `admin ` are the row `admin` to the database, and one account to the limit (S-01)."""
    user = bridge_db.user("admin")
    result = bridge_php.run(GATEWAY + r"""
    $spellings = ['admin', 'ADMIN', 'ádmin', 'Àdmin', 'admin '];
    $answers = [];
    foreach ($spellings as $index => $name) {
        // A different address each time: the per-address limit is another test.
        $answers[] = attempt(fn () => $gateway->checkPassword($name, 'wrong password', '192.0.2.' . ($index + 1)))['error'];
    }
    $answers[] = attempt(fn () => $gateway->checkPassword('nobody', 'wrong password', '192.0.2.40'))['error'];
    $counted = $attempts($db, 'login_account');
    // Fifteen more from elsewhere bring the account to its limit of twenty …
    for ($i = 0; $i < 15; $i++) {
        $db->prepare("INSERT INTO auth_attempts (kind, client_hash, identifier, succeeded) VALUES ('login_account', :c, :i, 0)")
           ->execute(['c' => hash('sha256', 'x' . $i), 'i' => 'user:' . USER]);
    }
    // … and then no spelling gets another guess, not even with the right password.
    $closed = [];
    foreach (['admin', 'ádmin', 'ADMIN '] as $index => $name) {
        $closed[] = attempt(fn () => $gateway->checkPassword($name, PASSWORD, '198.51.100.' . ($index + 1)));
    }
    $due = $gateway->loginChallengeDue('ÁDMIN', '203.0.113.9', null, 3);
    out(['answers' => $answers, 'counted' => $counted, 'closed' => $closed, 'due' => $due]);
    """.replace("USER", str(user)).replace("PASSWORD", json.dumps(TEST_PASSWORD)))
    assert result["answers"] == ["BridgeAuthenticationException"] * 6
    assert result["counted"] == {"nobody": 1, f"user:{user}": 5}
    for refusal in result["closed"]:
        assert refusal["error"] == "BridgeRateLimitException"
    assert result["due"] is True


def test_an_ipv6_client_is_counted_by_its_network_not_by_one_of_its_addresses(bridge_db, bridge_php) -> None:
    """A line gets a /64 and may use a new address from it per request (S-06)."""
    bridge_db.user("listener")
    result = bridge_php.run(GATEWAY + r"""
    $hash = fn (string $address): string => AccountGateway::clientHash($address);
    $refusals = [];
    for ($i = 1; $i <= 11; $i++) {
        $refusals[] = attempt(fn () => $gateway->checkPassword('listener', 'wrong password', '2001:db8:1:2:' . dechex($i * 1111) . '::' . dechex($i)))['error'];
    }
    out([
        'same_network' => $hash('2001:db8:1:2::1') === $hash('2001:db8:1:2:aaaa:bbbb:cccc:dddd'),
        'other_network' => $hash('2001:db8:1:2::1') === $hash('2001:db8:1:3::1'),
        'mapped_is_ipv4' => $hash('::ffff:192.0.2.7') === $hash('192.0.2.7'),
        'ipv4_as_ever' => $hash('192.0.2.7') === hash('sha256', 'auth|192.0.2.7'),
        'ipv4_neighbours' => $hash('192.0.2.7') === $hash('192.0.2.8'),
        'bracketed' => $hash('[2001:db8:1:2::9]') === $hash('2001:db8:1:2::1'),
        'not_an_address' => $hash('user:7') === hash('sha256', 'auth|user:7'),
        'keys' => [TrustedProxy::limitKey('2001:db8:1:2::9'), TrustedProxy::limitKey('::1'), TrustedProxy::limitKey('::ffff:10.0.0.1')],
        'refusals' => $refusals,
    ]);
    """)
    assert result["same_network"] is True and result["bracketed"] is True
    assert result["other_network"] is False and result["ipv4_neighbours"] is False
    assert result["mapped_is_ipv4"] is True and result["ipv4_as_ever"] is True and result["not_an_address"] is True
    assert result["keys"] == ["2001:db8:1:2::/64", "::/64", "10.0.0.1"]
    # Ten wrong guesses from ten addresses of one /64: the eleventh is refused by the per-address limit.
    assert result["refusals"][:10] == ["BridgeAuthenticationException"] * 10
    assert result["refusals"][10] == "BridgeRateLimitException"


def test_only_a_signed_device_cookie_is_counted_and_old_counts_are_pruned(bridge_db, bridge_php) -> None:
    """The cookie as it arrives is the visitor's choice of bytes (S-05)."""
    user = bridge_db.user("listener")
    result = bridge_php.run(GATEWAY + r"""
    $cookie = $gateway->deviceCookieFor(USER);
    $digest = $gateway->deviceDigest($cookie);
    $subjects = static fn (?string $value): array => StepUpGuard::subjects(null, str_repeat('a', 64), $gateway->deviceDigest($value));
    $now = 1800000000;
    $guard = new StepUpGuard($db, ['stepup_download_window' => '3600'], function () use (&$now): int { return $now; });
    foreach (['request' => 700, 'download' => 700, 'strike' => 1000, 'download ' => 4300, 'unknown' => 4300] as $context => $age) {
        $db->prepare('INSERT INTO stepup_counters (context, subject, bucket, hits) VALUES (:c, :s, :b, 1)')
           ->execute(['c' => trim($context), 's' => 'c:' . md5($context . $age), 'b' => $now - $age]);
    }
    $guard->prune();
    out([
        'signed' => $subjects($cookie),
        'digest_shape' => preg_match('/^[0-9a-f]{64}$/', (string) $digest),
        'garbage' => $subjects('anything-the-visitor-likes'),
        'tampered' => $subjects(substr($cookie, 0, -2) . 'xx'),
        'none' => $subjects(null),
        'left' => $db->query('SELECT context, bucket FROM stepup_counters ORDER BY context, bucket')->fetchAll(PDO::FETCH_NUM),
    ]);
    """.replace("USER", str(user)))
    client = "c:" + "a" * 64
    assert result["digest_shape"] == 1
    assert result["signed"][0] == client and result["signed"][1].startswith("d:") and len(result["signed"]) == 2
    assert result["garbage"] == [client] and result["tampered"] == [client] and result["none"] == [client]
    # A request bucket lives a minute, a strike a quarter of an hour, a download an hour (+10 min each):
    # 700 s is too old for a request, not for a download; 4300 s is too old for both.
    now = 1800000000
    assert result["left"] == [["download", now - 700], ["strike", now - 1000], ["unknown", now - 4300]]


def test_sign_up_answers_and_mail(bridge_db, bridge_php) -> None:
    """With activation every answer is the same and the mailbox hears the rest; without, the taken thing is named."""
    bridge_db.setting("registration_enabled", "1")
    bridge_db.user("taken", email="owner@example.test")
    script = GATEWAY + r"""
    $try = fn (string $name, string $email, string $address) => attempt(fn () => $gateway->register($name, $email, 'a long enough password', $address));
    out(['fresh' => $try('newcomer', 'new@example.test', '192.0.2.1'),
         'name_taken' => $try('taken', 'other@example.test', '192.0.2.2'),
         'address_taken' => $try('another', 'owner@example.test', '192.0.2.3')]);
    """
    with_activation = bridge_php.run(script)
    for answer in with_activation.values():
        assert answer == {"ok": True, "value": {"status": "pending", "spooled": True}}
    mail = bridge_php.mail()
    assert len(mail) == 3
    assert sum("login/?activate=" in message for message in mail) == 1
    assert bridge_db.value("SELECT COUNT(*) FROM users") == 2

    bridge_db.setting("registration_requires_activation", "0")
    bridge_db.execute("DELETE FROM users WHERE username = 'newcomer'")
    bridge_db.execute("DELETE FROM auth_attempts")
    bridge_php.clear_mail()
    without = bridge_php.run(script)
    assert without["fresh"] == {"ok": True, "value": {"status": "active", "spooled": False}}
    assert without["name_taken"]["message"] == "Ta nazwa użytkownika jest już zajęta."
    # It used to answer {"status": "active"} although nothing had been created (S-08).
    assert without["address_taken"]["message"] == "Ten adres e-mail ma już konto."
    assert bridge_php.mail() == []


def test_a_mail_server_that_fails_does_not_decide_the_answer(bridge_db, bridge_php, tmp_path) -> None:
    """The account is committed before the mail goes out; a failed send used to answer 500 and leave it behind (S-14)."""
    bridge_db.setting("registration_enabled", "1")
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("a file where the spool directory should be", encoding="utf-8")
    result = bridge_php.run(r"""
    $gateway = new AccountGateway($db, new Mailer(['spool_path' => SPOOL]), 'http://media.test/', null, 0);
    $registered = attempt(fn () => $gateway->register('newcomer', 'new@example.test', 'a long enough password', '192.0.2.1'));
    $resent = attempt(fn () => $gateway->resendActivation('new@example.test', '192.0.2.1'));
    out(['registered' => $registered, 'resent' => $resent]);
    """.replace("SPOOL", json.dumps(str(blocked))))
    assert result["registered"] == {"ok": True, "value": {"status": "pending", "spooled": True}}
    assert result["resent"] == {"ok": True, "value": False}
    assert bridge_db.value("SELECT is_active FROM users WHERE username = 'newcomer'") == 0


def test_resending_a_link_takes_as_long_for_an_unknown_address_as_for_a_waiting_one(bridge_db, bridge_php) -> None:
    bridge_db.user("pending", email="pending@example.test", active=False, verified=False)
    result = bridge_php.run(r"""
    $gateway = new AccountGateway($db, $mailer, 'http://media.test/', null, 300);
    $timed = function (string $email, string $address) use ($gateway): array {
        $started = hrtime(true);
        $sent = $gateway->resendActivation($email, $address);
        return [$sent, (hrtime(true) - $started) / 1e6];
    };
    out(['waiting' => $timed('pending@example.test', '192.0.2.1'), 'unknown' => $timed('nobody@example.test', '192.0.2.2')]);
    """)
    assert result["waiting"][0] is True and result["unknown"][0] is False
    assert 295 <= result["waiting"][1] < 900 and 295 <= result["unknown"][1] < 900
    assert len(bridge_php.mail()) == 1


def test_the_current_password_may_not_be_guessed_without_end(bridge_db, bridge_php) -> None:
    """`account_password` counted nothing: twelve wrong guesses were twelve 422s (S-04)."""
    user = bridge_db.user("listener")
    result = bridge_php.run(GATEWAY + r"""
    $try = fn (string $current) => attempt(fn () => $gateway->changePassword(USER, $current, 'a brand new password', '192.0.2.1'));
    $first = $try('wrong');
    for ($i = 0; $i < 8; $i++) {
        $db->prepare("INSERT INTO auth_attempts (kind, client_hash, identifier, succeeded) VALUES ('login_2fa', :c, :i, 0)")
           ->execute(['c' => hash('sha256', 'elsewhere' . $i), 'i' => 'user:' . USER]);
    }
    $tenth = $try('wrong again');
    $closed = $try(PASSWORD);
    $db->exec('DELETE FROM auth_attempts');
    $short = $try(PASSWORD . 'x');
    $changed = $try(PASSWORD);
    out(['first' => $first, 'tenth' => $tenth, 'closed' => $closed, 'changed' => $changed,
         'too_short' => attempt(fn () => $gateway->changePassword(USER, 'a brand new password', 'short', '192.0.2.1')),
         'too_long' => attempt(fn () => $gateway->changePassword(USER, 'a brand new password', str_repeat('x', 4097), '192.0.2.1')),
         'signs_in' => attempt(fn () => (int) $gateway->checkPassword('listener', 'a brand new password', '192.0.2.9')['id'])]);
    """.replace("USER", str(user)).replace("PASSWORD", json.dumps(TEST_PASSWORD)))
    assert result["first"]["message"] == "Obecne hasło jest nieprawidłowe."
    assert result["tenth"]["message"] == "Obecne hasło jest nieprawidłowe."
    assert result["closed"]["error"] == "BridgeRateLimitException"
    assert result["changed"] == {"ok": True, "value": None}
    assert result["too_short"]["error"] == "BridgeRequestException"
    assert result["too_long"]["error"] == "BridgeRequestException"
    assert result["signs_in"] == {"ok": True, "value": user}


def test_an_address_change_tells_the_address_it_is_leaving(bridge_db, bridge_php) -> None:
    user = bridge_db.user("listener", email="old@example.test")
    result = bridge_php.run(GATEWAY + r"""
    out(['asked' => $gateway->requestEmailChange(USER, 'new@example.test', PASSWORD),
         'again' => $gateway->requestEmailChange(USER, 'listener2@example.test', PASSWORD)]);
    """.replace("USER", str(user)).replace("PASSWORD", json.dumps(TEST_PASSWORD)))
    assert result["asked"] == {"spooled": True, "sent": True}
    mail = bridge_php.mail()
    to = sorted(line for message in mail for line in message.splitlines() if line.startswith("To: "))
    assert to == ["To: <listener2@example.test>", "To: <new@example.test>", "To: <old@example.test>", "To: <old@example.test>"]
    notice = next(message for message in mail if "To: <old@example.test>" in message)
    assert "email_change=" not in notice, "the link goes to the new address only"


def test_what_an_operator_may_not_do_to_their_own_account(bridge_db, bridge_php) -> None:
    """Own second factor, own password and own role are not the panel's to change (S-03, S-12)."""
    root = bridge_db.user("root", role="super_admin")
    second = bridge_db.user("second", role="super_admin")
    admin = bridge_db.user("admin", role="admin")
    user = bridge_db.user("listener")
    result = bridge_php.run(r"""
    $actions = new CatalogActions($db);
    $root = identity($db, 'root');
    $admin = identity($db, 'admin');
    $pair = ['password' => 'a long enough password', 'password_confirm' => 'a long enough password'];
    out([
        'own_twofa_root' => attempt(fn () => $actions->assertManageableUser($root, ROOT)),
        'own_twofa_admin' => attempt(fn () => $actions->assertManageableUser($admin, ADMIN)),
        'admin_resets_root' => attempt(fn () => $actions->assertManageableUser($admin, ROOT)),
        'admin_resets_user' => attempt(fn () => $actions->assertManageableUser($admin, USER)),
        'root_resets_admin' => attempt(fn () => $actions->assertManageableUser($root, ADMIN)),
        'user_resets_user' => attempt(fn () => $actions->assertManageableUser(identity($db, 'listener'), USER)),
        'own_password' => attempt(fn () => $actions->updateUser($root, ['user_id' => ROOT] + $pair)),
        'own_role' => attempt(fn () => $actions->updateUser($root, ['user_id' => ROOT, 'role' => 'user'])),
        'own_other_fields' => attempt(fn () => $actions->updateUser($root, ['user_id' => ROOT, 'role' => 'super_admin'])['success']),
        'others_password' => attempt(fn () => $actions->updateUser($root, ['user_id' => USER] + $pair)['success']),
        'demote_other_super' => attempt(fn () => $actions->updateUser($root, ['user_id' => SECOND, 'role' => 'admin'])['success']),
        'admin_edits_admin_password' => attempt(fn () => $actions->updateUser($admin, ['user_id' => ADMIN] + $pair)),
        'admin_promotes_user' => attempt(fn () => $actions->updateUser($admin, ['user_id' => USER, 'role' => 'admin'])),
        'long_password' => attempt(fn () => $actions->updateUser($root, ['user_id' => USER,
            'password' => str_repeat('p', 2000), 'password_confirm' => str_repeat('p', 2000)])['success']),
        'roles' => $db->query('SELECT username, role FROM users ORDER BY username')->fetchAll(PDO::FETCH_KEY_PAIR),
    ]);
    """.replace("ROOT", str(root)).replace("SECOND", str(second)).replace("ADMIN", str(admin)).replace("USER", str(user)))
    for key in ("own_twofa_root", "own_twofa_admin", "own_password", "own_role"):
        assert result[key]["error"] == "BridgeRequestException", key
    assert result["admin_resets_root"]["error"] == "BridgeAuthorizationException"
    assert result["user_resets_user"]["error"] == "BridgeAuthorizationException"
    assert result["admin_resets_user"]["ok"] is True and result["root_resets_admin"]["ok"] is True
    assert result["own_other_fields"] == {"ok": True, "value": True}
    assert result["others_password"] == {"ok": True, "value": True}
    assert result["demote_other_super"] == {"ok": True, "value": True}
    assert result["admin_edits_admin_password"]["error"] == "BridgeAuthorizationException"
    assert result["admin_promotes_user"]["error"] == "BridgeAuthorizationException"
    # One ceiling for every form that sets a password: what sign-up accepts, the panel accepts (C-13).
    assert result["long_password"] == {"ok": True, "value": True}
    assert result["roles"] == {"admin": "admin", "listener": "user", "root": "super_admin", "second": "admin"}


def test_closing_a_session_by_its_fingerprint_follows_the_account_rules(bridge_db, bridge_php) -> None:
    """A plain administrator could close a superadministrator's session; the audit entry named nobody (S-11)."""
    ids = {name: bridge_db.user(name, role=role) for name, role in
           (("root", "super_admin"), ("admin", "admin"), ("listener", "user"), ("other", "user"))}
    prints = {}
    for name, user in ids.items():
        prints[name] = hashlib.sha256(f"session|{name}".encode()).hexdigest()
        bridge_db.insert("user_sessions", user_id=user, session_hash=bytes.fromhex(prints[name]), device_label=name)
    result = bridge_php.run(r"""
    $actions = new CatalogActions($db);
    $prints = json_decode('PRINTS', true);
    $close = fn (string $who, string $whose) => attempt(fn () => $actions->revokeSessions(identity($db, $who), ['fingerprint' => $prints[$whose]])['closed']);
    out([
        'user_closes_other' => $close('listener', 'other'),
        'admin_closes_root' => $close('admin', 'root'),
        'admin_closes_user' => $close('admin', 'other'),
        'user_closes_own' => $close('listener', 'listener'),
        'again' => $close('listener', 'listener'),
        'admin_closes_all_of_root' => attempt(fn () => $actions->revokeSessions(identity($db, 'admin'), ['others' => true, 'user_id' => ROOT])),
        'root_closes_admin' => $close('root', 'admin'),
        'open' => $db->query('SELECT device_label FROM user_sessions WHERE revoked_at IS NULL ORDER BY device_label')->fetchAll(PDO::FETCH_COLUMN),
        'audit' => $db->query("SELECT actor_user_id, target_id FROM audit_log WHERE action = 'session.revoke' ORDER BY id")->fetchAll(PDO::FETCH_NUM),
    ]);
    """.replace("PRINTS", json.dumps(prints)).replace("ROOT", str(ids["root"])))
    assert result["user_closes_other"] == {"ok": True, "value": 0}
    assert result["admin_closes_root"]["error"] == "BridgeAuthorizationException"
    assert result["admin_closes_all_of_root"]["error"] == "BridgeAuthorizationException"
    assert result["admin_closes_user"] == {"ok": True, "value": 1}
    assert result["user_closes_own"] == {"ok": True, "value": 1}
    assert result["again"] == {"ok": True, "value": 0}
    assert result["root_closes_admin"] == {"ok": True, "value": 1}
    assert result["open"] == ["root"]
    assert result["audit"] == [
        [ids["admin"], str(ids["other"])], [ids["listener"], str(ids["listener"])], [ids["root"], str(ids["admin"])],
    ]


def test_a_cover_is_stored_as_what_it_is_and_an_export_cannot_carry_a_formula(bridge_db, bridge_library, bridge_php) -> None:
    """The claimed type was stored; a title beginning with `=` was a formula in a spreadsheet (S-10)."""
    bridge_library.scan("music", "music", ["=cmd.mp3", "Plain.mp3"])
    user = bridge_db.user("editor", role="admin")
    item = bridge_db.tag("=cmd.mp3", title="=HYPERLINK(\"http://x\")", artist="+Plus")
    bridge_db.insert("user_ratings", user_id=user, media_item_id=item, rating=4.0, favorite=1)
    picture = base64.b64encode(_png()).decode("ascii")
    result = bridge_php.run(r"""
    $actions = new CatalogActions($db);
    $me = identity($db, 'editor');
    $saved = attempt(fn () => $actions->saveArtwork($me, ['media_item_id' => ITEM, 'data_url' => 'data:image/jpeg;base64,PICTURE'])['success']);
    $export = $actions->exportRatings($me, 'csv');
    $parsed = PlaylistParser::parse($export['body']);
    out(['saved' => $saved,
         'stored' => $db->query('SELECT mime_type FROM media_artwork_overrides')->fetchColumn(),
         'served' => $actions->artwork($me, ITEM)['mime_type'],
         'not_a_picture' => attempt(fn () => $actions->saveArtwork($me, ['media_item_id' => ITEM,
             'data_url' => 'data:image/png;base64,' . base64_encode(str_repeat('not a picture ', 20))])),
         'csv' => $export['body'], 'label' => $parsed['entries'][0]['label'] ?? null]);
    """.replace("ITEM", str(item)).replace("PICTURE", picture))
    assert result["saved"] == {"ok": True, "value": True}
    assert result["stored"] == "image/png" and result["served"] == "image/png"
    assert result["not_a_picture"]["error"] == "BridgeRequestException"
    row = [line for line in result["csv"].splitlines() if "HYPERLINK" in line][0]
    assert '"\'=HYPERLINK(""http://x"")"' in row and '"\'+Plus"' in row
    # Coming home, the apostrophe is not part of the name.
    assert result["label"] == '+Plus - =HYPERLINK("http://x")'


def _solve(challenge: dict) -> str:
    """The page's side of the proof of work: try numbers until the digest matches."""
    for number in range(challenge["maxnumber"] + 1):
        if hashlib.sha256(f"{challenge['salt']}{number}".encode()).hexdigest() == challenge["challenge"]:
            payload = {key: challenge[key] for key in ("algorithm", "challenge", "salt", "signature")} | {"number": number}
            return base64.b64encode(json.dumps(payload).encode()).decode("ascii")
    raise AssertionError("no solution below maxnumber")


def test_a_pass_earned_with_a_puzzle_does_not_open_a_form_the_operator_gave_another_lock(bridge_http, bridge_db) -> None:
    """In the application every pass is proof of work; the sign-in forms want the provider chosen for them (S-02)."""
    bridge_db.user("listener")
    bridge_db.user("victim")
    bridge_db.setting("captcha_pow_max_number", "1000")
    for key, value in (("captcha_provider", "turnstile"), ("captcha_site_key_turnstile", "site-key"),
                       ("captcha_secret_key_turnstile", "secret-key"), ("captcha_login_mode", "always")):
        bridge_db.setting(key, value)
    client = bridge_http.client()
    client.get("auth_state")
    # Signing in itself is behind the provider now; open the session the way a browser with a session has it.
    bridge_db.setting("captcha_login_mode", "never")
    assert client.post("login", {"username": "listener", "password": TEST_PASSWORD}).status == 200
    bridge_db.setting("captcha_login_mode", "always")

    challenge = client.get("captcha_challenge").json["challenge"]
    earned = client.post("captcha_pass", {"token": _solve(challenge)})
    assert earned.status == 200 and earned.json["success"] is True

    refused = client.post("login", {"username": "victim", "password": TEST_PASSWORD})
    assert refused.status == 428, "a puzzle solved inside the application is not the sign-in page's challenge"
    assert refused.json["captcha"]["provider"] == "turnstile"
    # The pass is still good for what it was earned for.
    assert client.get("session").status == 200


def test_the_bridge_says_nothing_about_what_runs_it(bridge_http) -> None:
    response = bridge_http.client().get("auth_state")
    assert response.header_values("X-Powered-By") == []


def test_wrong_current_passwords_are_limited_over_http_too(bridge_http, bridge_db) -> None:
    bridge_db.user("listener")
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200
    payload = {"current_password": "definitely wrong", "new_password": "x" * 16, "new_password_confirm": "x" * 16}
    statuses = [client.post("account_password", payload).status for _ in range(11)]
    assert statuses == [422] * 10 + [429]
    started = time.monotonic()
    assert client.post("account_password", payload | {"current_password": TEST_PASSWORD}).status == 429
    assert time.monotonic() - started < 5


def test_interface_preferences_are_kept_with_the_account(bridge_http, bridge_db) -> None:
    """Language, colours and what the queue shows follow the person from one device to the next."""
    bridge_db.user("listener")
    bridge_db.user("somebody")
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200
    # An account that never chose anything: the original in every respect.
    untouched = {"language": "pl", "theme": "emerald", "queue": {"index": True, "favorite": True, "rating": "own"}}
    assert client.get("session").json["preferences"] == untouched

    chosen = {"language": "en", "theme": "blue", "queue": {"index": False, "favorite": True, "rating": "average"}}
    saved = client.post("account_preferences", {"preferences": chosen})
    assert saved.status == 200 and saved.json == {"success": True, "preferences": chosen}
    assert json.loads(bridge_db.value("SELECT preferences_json FROM users WHERE username = 'listener'")) == chosen

    # Another browser of the same account gets the same choice with its session.
    elsewhere = bridge_http.client()
    assert elsewhere.sign_in("listener").status == 200
    assert elsewhere.get("session").json["preferences"] == chosen
    # And another account is not touched by it.
    other = bridge_http.client()
    assert other.sign_in("somebody").status == 200
    assert other.get("session").json["preferences"] == untouched

    # Only the two names are colours; anything else is the original, and an unknown key is dropped.
    for unknown in ("pink", "BLUE", 7, None, ["blue"], {"name": "blue"}, True):
        answer = client.post("account_preferences", {"preferences": {**chosen, "theme": unknown, "wallpaper": "x"}})
        assert answer.status == 200 and answer.json["preferences"] == {**chosen, "theme": "emerald"}, unknown
    # Leaving the key out is "never chose", and the other keys stay what was sent.
    without = client.post("account_preferences", {"preferences": {"language": "en", "queue": chosen["queue"]}})
    assert without.json["preferences"] == {**chosen, "theme": "emerald"}
    assert client.post("account_preferences", {"preferences": chosen}).json["preferences"]["theme"] == "blue"
    assert client.get("session").json["preferences"] == chosen

    # A value written to the column by hand, or by an older version, is read by the same rule.
    bridge_db.execute("UPDATE users SET preferences_json = %s WHERE username = 'listener'",
                      (json.dumps({"language": "en", "theme": "neon"}),))
    assert client.get("session").json["preferences"] == {**untouched, "language": "en"}
    bridge_db.execute("UPDATE users SET preferences_json = NULL WHERE username = 'listener'")
    assert client.get("session").json["preferences"] == untouched


def test_deleting_an_account_takes_everything_that_is_its_own(bridge_db, bridge_library, bridge_php) -> None:
    """The owner's "Usuń konto" (12.11.2026): one account's ratings leave the averages with it.

    What is the account's own goes — by its foreign keys, and by hand where a row names the
    account without one (a guest link to its playlist, step-up and sign-in counters). What
    is somebody else's stays, and so do the catalogue's play totals and the audit trail.
    """
    bridge_library.scan("music", "music", ["Abba/Waterloo.mp3", "Abba/SOS.mp3"])
    root = bridge_db.user("root", role="super_admin")
    admin = bridge_db.user("admin", role="admin")
    listener = bridge_db.user("listener")
    other = bridge_db.user("other")
    waterloo = bridge_db.item_id("Abba/Waterloo.mp3", "music")
    sos = bridge_db.item_id("Abba/SOS.mp3", "music")
    bridge_db.insert("user_ratings", user_id=listener, media_item_id=waterloo, rating=5, favorite=1)
    bridge_db.insert("user_ratings", user_id=listener, media_item_id=sos, rating=1, favorite=0)
    bridge_db.insert("user_ratings", user_id=other, media_item_id=waterloo, rating=2, favorite=0)
    mine = bridge_db.insert("user_collections", user_id=listener, name="Moja", media_kind="music")
    theirs = bridge_db.insert("user_collections", user_id=other, name="Cudza", media_kind="music")
    bridge_db.insert("user_collection_items", collection_id=mine, media_item_id=waterloo, position=1)
    bridge_db.insert("user_collection_ratings", user_id=other, collection_id=mine, rating=4)
    bridge_db.insert("user_collection_ratings", user_id=listener, collection_id=theirs, rating=3)
    bridge_db.insert("guest_links", token_hash=hashlib.sha256(b"to-mine").digest(), created_by=other,
                     target_kind="collection", target_id=mine, expires_at="2099-01-01 00:00:00")
    bridge_db.insert("guest_links", token_hash=hashlib.sha256(b"to-theirs").digest(), created_by=other,
                     target_kind="collection", target_id=theirs, expires_at="2099-01-01 00:00:00")
    bridge_db.insert("guest_links", token_hash=hashlib.sha256(b"by-listener").digest(), created_by=listener,
                     target_kind="collection", target_id=theirs, expires_at="2099-01-01 00:00:00")
    bridge_db.insert("playback_stats", user_id=listener, media_item_id=waterloo, last_position_ms=1000, play_count=3)
    bridge_db.insert("playback_queues", user_id=listener, device_id="phone")
    bridge_db.insert("user_sessions", user_id=listener, session_hash=hashlib.sha256(b"listener").digest())
    bridge_db.insert("stepup_counters", context="request", subject=f"u:{listener}", bucket=1)
    bridge_db.insert("stepup_subjects", subject=f"u:{listener}", context="request", state="paused", updated_at=1)
    bridge_db.insert("auth_attempts", kind="login", client_hash="0" * 64, identifier="listener")
    bridge_db.insert("media_play_totals", media_item_id=waterloo, play_count=7)
    bridge_db.insert("audit_log", actor_user_id=listener, action="collection.create", target_type="collection",
                     target_id=str(mine))
    result = bridge_php.run(r"""
    $actions = new CatalogActions($db);
    $admin = identity($db, 'admin');
    $root = identity($db, 'root');
    $count = fn (string $sql) => (int) $db->query($sql)->fetchColumn();
    out([
        'preview' => attempt(fn () => $actions->deleteUser($admin, ['user_id' => LISTENER, 'dry_run' => true])),
        'unconfirmed' => attempt(fn () => $actions->deleteUser($admin, ['user_id' => LISTENER])),
        'misspelt' => attempt(fn () => $actions->deleteUser($admin, ['user_id' => LISTENER, 'confirm_username' => 'Listener'])),
        'by_a_user' => attempt(fn () => $actions->deleteUser(identity($db, 'other'), ['user_id' => LISTENER, 'confirm_username' => 'listener'])),
        'admin_deletes_root' => attempt(fn () => $actions->deleteUser($admin, ['user_id' => ROOT, 'confirm_username' => 'root'])),
        'own' => attempt(fn () => $actions->deleteUser($root, ['user_id' => ROOT, 'confirm_username' => 'root'])),
        'deleted' => attempt(fn () => $actions->deleteUser($admin, ['user_id' => LISTENER, 'confirm_username' => ' listener '])['removed']),
        'again' => attempt(fn () => $actions->deleteUser($admin, ['user_id' => LISTENER, 'confirm_username' => 'listener'])),
        'left' => [
            'account' => $count('SELECT COUNT(*) FROM users WHERE id = LISTENER'),
            'ratings' => $count('SELECT COUNT(*) FROM user_ratings WHERE user_id = LISTENER'),
            'collections' => $count('SELECT COUNT(*) FROM user_collections WHERE user_id = LISTENER'),
            'items_of_mine' => $count('SELECT COUNT(*) FROM user_collection_items WHERE collection_id = MINE'),
            'votes_on_mine' => $count('SELECT COUNT(*) FROM user_collection_ratings WHERE collection_id = MINE'),
            'my_votes' => $count('SELECT COUNT(*) FROM user_collection_ratings WHERE user_id = LISTENER'),
            'links' => $db->query('SELECT target_id FROM guest_links ORDER BY id')->fetchAll(PDO::FETCH_COLUMN),
            'history' => $count('SELECT COUNT(*) FROM playback_stats WHERE user_id = LISTENER'),
            'queues' => $count('SELECT COUNT(*) FROM playback_queues WHERE user_id = LISTENER'),
            'sessions' => $count('SELECT COUNT(*) FROM user_sessions WHERE user_id = LISTENER'),
            'stepup' => $count("SELECT COUNT(*) FROM stepup_counters WHERE subject = 'u:LISTENER'")
                + $count("SELECT COUNT(*) FROM stepup_subjects WHERE subject = 'u:LISTENER'"),
            'attempts' => $count("SELECT COUNT(*) FROM auth_attempts WHERE identifier = 'listener'"),
            'average' => (float) $db->query('SELECT AVG(rating) FROM user_ratings WHERE media_item_id = WATERLOO')->fetchColumn(),
            'totals' => $count('SELECT play_count FROM media_play_totals WHERE media_item_id = WATERLOO'),
            'others_collection' => $count('SELECT COUNT(*) FROM user_collections WHERE id = THEIRS'),
            'orphaned_audit' => $count("SELECT COUNT(*) FROM audit_log WHERE action = 'collection.create' AND actor_user_id IS NULL"),
            'audit' => $db->query("SELECT actor_user_id, target_id FROM audit_log WHERE action = 'user.delete'")->fetchAll(PDO::FETCH_NUM),
        ],
    ]);
    """.replace("LISTENER", str(listener)).replace("ROOT", str(root)).replace("MINE", str(mine))
        .replace("THEIRS", str(theirs)).replace("WATERLOO", str(waterloo)))
    assert result["preview"]["ok"] is True
    assert result["preview"]["value"]["removes"] == {
        "ratings": 2, "favorites": 1, "collections": 1, "collection_votes": 1, "history": 1, "guest_links": 1, "sessions": 1,
    }
    for key in ("unconfirmed", "misspelt", "own"):
        assert result[key]["error"] == "BridgeRequestException", key
    assert result["by_a_user"]["error"] == "BridgeAuthorizationException"
    assert result["admin_deletes_root"]["error"] == "BridgeAuthorizationException"
    assert result["deleted"]["ok"] is True and result["deleted"]["value"]["ratings"] == 2
    assert result["again"]["error"] == "CatalogItemNotFoundException"
    left = result["left"]
    for key in ("account", "ratings", "collections", "items_of_mine", "votes_on_mine", "my_votes", "history",
                "queues", "sessions", "stepup", "attempts"):
        assert left[key] == 0, key
    # The link another account made to the deleted playlist went with it; its link to its own stays.
    assert left["links"] == [theirs]
    assert left["average"] == 2.0
    assert left["totals"] == 7
    assert left["others_collection"] == 1
    assert left["orphaned_audit"] == 1
    assert left["audit"] == [[admin, str(listener)]]
