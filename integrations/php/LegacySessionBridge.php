<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

final class LegacySessionBridge
{
    private const BOUND_USER_KEY = 'media_bridge_user_id';
    private const CSRF_KEY = 'media_bridge_csrf';
    /** When this session was last written to the database, kept in the session itself. */
    private const SEEN_KEY = 'media_bridge_seen_at';

    /**
     * How often an open session refreshes its row.
     *
     * The panel wants to know a session is alive, not what its owner clicked.
     * A write per request would put an UPDATE behind every single call to the
     * bridge to move a timestamp by two hundred milliseconds.
     */
    private const SEEN_INTERVAL_SECONDS = 60;

    public function __construct(private readonly PDO $database)
    {
    }

    /** @param array<string, mixed> $session */
    public function authenticate(array $session): LegacyIdentity
    {
        $legacy = LegacyIdentity::fromLegacySession($session);
        $statement = $this->database->prepare(
            'SELECT id, username, role, is_guest, is_active
             FROM users
             WHERE id = :id AND username = :username
             LIMIT 1'
        );
        $statement->execute(['id' => $legacy->userId, 'username' => $legacy->username]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (!is_array($row) || !self::flag($row['is_active'] ?? false)) {
            throw new BridgeAuthenticationException('Konto jest niedostępne.');
        }

        return LegacyIdentity::fromDatabaseRow($row);
    }

    /**
     * Regeneruje identyfikator dokładnie raz dla danej tożsamości mostu.
     *
     * @param array<string, mixed> $session
     */
    public function hardenActiveSession(array &$session, LegacyIdentity $identity): bool
    {
        if (($session[self::BOUND_USER_KEY] ?? null) === $identity->userId) {
            return false;
        }
        if (session_status() !== PHP_SESSION_ACTIVE || headers_sent()) {
            throw new BridgeAuthenticationException('Nie można utwardzić sesji.');
        }
        if (!session_regenerate_id(true)) {
            throw new BridgeAuthenticationException('Nie można odnowić sesji.');
        }

        unset($session[self::CSRF_KEY]);
        $session[self::BOUND_USER_KEY] = $identity->userId;
        return true;
    }

    /**
     * Mark a freshly signed-in session as already hardened.
     *
     * Sign-in regenerates the identifier itself, so without this the next
     * request would see an unbound session, harden it a second time and discard
     * the CSRF token that was just handed to the client.
     *
     * @param array<string, mixed> $session
     */
    public function bindSession(array &$session, int $userId): void
    {
        $session[self::BOUND_USER_KEY] = $userId;
    }

    /** @param array<string, mixed> $session */
    public function csrfToken(array &$session): string
    {
        $existing = $session[self::CSRF_KEY] ?? null;
        if (is_string($existing) && preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $existing) === 1) {
            return $existing;
        }

        $token = self::base64UrlEncode(random_bytes(32));
        $session[self::CSRF_KEY] = $token;
        return $token;
    }

    /** @param array<string, mixed> $session */
    public function assertCsrf(array $session, ?string $provided): void
    {
        $expected = $session[self::CSRF_KEY] ?? null;
        if (!is_string($expected) || !is_string($provided) || !hash_equals($expected, $provided)) {
            throw new BridgeAuthorizationException('Nieprawidłowy token CSRF.');
        }
    }

    /**
     * Record that this session is open, and refuse it if it was closed elsewhere.
     *
     * Called on every authenticated request, which is why it is one indexed read
     * and — at most once a minute — one write. A row whose `revoked_at` is set
     * means somebody pressed "sign out" for this session in the panel or on
     * their own account page: the session is destroyed here, on its next
     * request, because closing it any sooner would mean holding on to the
     * identifier that could reopen it.
     *
     * A session that predates this table (or one whose row was pruned) is
     * inserted rather than refused. Being unknown is not evidence of anything.
     *
     * @param array<string, mixed> $session
     */
    public function trackSession(
        array &$session,
        LegacyIdentity $identity,
        string $sessionId,
        string $userAgent,
        string $clientAddress
    ): void {
        if ($sessionId === '' || !$this->sessionsTableExists()) {
            return;
        }
        $hash = hash('sha256', 'session|' . $sessionId, true);
        $statement = $this->database->prepare(
            'SELECT id, user_id, revoked_at FROM user_sessions WHERE session_hash = :hash LIMIT 1'
        );
        $statement->bindValue(':hash', $hash, PDO::PARAM_LOB);
        $statement->execute();
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (is_array($row) && $row['revoked_at'] !== null) {
            $this->destroyCurrentSession($session);
            throw new BridgeAuthenticationException('Ta sesja została zamknięta.');
        }
        if (!is_array($row)) {
            $insert = $this->database->prepare(
                'INSERT INTO user_sessions (user_id, session_hash, device_label, client_hash)
                 VALUES (:user_id, :hash, :label, :client)
                 ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP(6)'
            );
            $insert->bindValue(':user_id', $identity->userId, PDO::PARAM_INT);
            $insert->bindValue(':hash', $hash, PDO::PARAM_LOB);
            $insert->bindValue(':label', self::deviceLabel($userAgent), PDO::PARAM_STR);
            $insert->bindValue(':client', hash('sha256', 'auth|' . $clientAddress, true), PDO::PARAM_LOB);
            $insert->execute();
            $session[self::SEEN_KEY] = time();
            $this->pruneSessions();
            return;
        }
        // A session identifier belongs to whoever it was issued to. If the row
        // says another account, this is not that session — refuse rather than
        // quietly hand the row over.
        if ((int) $row['user_id'] !== $identity->userId) {
            $this->destroyCurrentSession($session);
            throw new BridgeAuthenticationException('Ta sesja została zamknięta.');
        }
        $seenAt = $session[self::SEEN_KEY] ?? 0;
        if (is_int($seenAt) && time() - $seenAt < self::SEEN_INTERVAL_SECONDS) {
            return;
        }
        $touch = $this->database->prepare(
            'UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
        );
        $touch->execute(['id' => (int) $row['id']]);
        $session[self::SEEN_KEY] = time();
    }

    /** Close this session's own row on sign-out, so the panel stops listing it. */
    public function revokeCurrentSession(string $sessionId, int $userId): void
    {
        if ($sessionId === '' || !$this->sessionsTableExists()) {
            return;
        }
        $statement = $this->database->prepare(
            'UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP(6), revoked_by = :actor
              WHERE session_hash = :hash AND revoked_at IS NULL'
        );
        $statement->bindValue(':actor', $userId, PDO::PARAM_INT);
        $statement->bindValue(':hash', hash('sha256', 'session|' . $sessionId, true), PDO::PARAM_LOB);
        $statement->execute();
    }

    /** Identifies this session in a listing without revealing what it is. */
    public static function sessionFingerprint(string $sessionId): string
    {
        return $sessionId === '' ? '' : hash('sha256', 'session|' . $sessionId);
    }

    /**
     * A device name somebody will recognise: "Windows · Chrome".
     *
     * Coarse on purpose, and the same vocabulary the queue's device list uses,
     * so one account's phone is called the same thing in both places. The raw
     * user agent is not stored: it identifies a browser far more precisely than
     * anybody needs in order to say "that one, close it".
     */
    public static function deviceLabel(string $agent): string
    {
        $system = match (true) {
            (bool) preg_match('/Android/i', $agent) => 'Android',
            (bool) preg_match('/iPhone|iPad|iPod/i', $agent) => 'iOS',
            (bool) preg_match('/Windows/i', $agent) => 'Windows',
            (bool) preg_match('/Mac OS X/i', $agent) => 'macOS',
            (bool) preg_match('/Linux/i', $agent) => 'Linux',
            default => 'Nieznane urządzenie',
        };
        $browser = match (true) {
            (bool) preg_match('#Edg/#i', $agent) => 'Edge',
            (bool) preg_match('#OPR/#i', $agent) => 'Opera',
            (bool) preg_match('#Firefox/#i', $agent) => 'Firefox',
            (bool) preg_match('#Chrome/#i', $agent) => 'Chrome',
            (bool) preg_match('#Safari/#i', $agent) => 'Safari',
            default => '',
        };
        return substr($browser === '' ? $system : $system . ' · ' . $browser, 0, 64);
    }

    /** @param array<string, mixed> $session */
    private function destroyCurrentSession(array &$session): void
    {
        $session = [];
        if (session_status() === PHP_SESSION_ACTIVE) {
            @session_destroy();
        }
    }

    /**
     * Rows for sessions that expired on their own.
     *
     * A PHP session dies of inactivity long before anybody thinks to sign out,
     * and a table full of dead rows would make "active sessions" a lie. Pruned
     * opportunistically, like the audit trail, well past the point where the
     * session itself could still be used.
     */
    private function pruneSessions(): void
    {
        if (random_int(1, 50) !== 1) {
            return;
        }
        $this->database->exec(
            'DELETE FROM user_sessions
              WHERE last_seen_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 30 DAY)'
        );
    }

    private ?bool $sessionsTable = null;

    private function sessionsTableExists(): bool
    {
        if ($this->sessionsTable !== null) {
            return $this->sessionsTable;
        }
        $statement = $this->database->prepare(
            'SELECT COUNT(*) FROM information_schema.tables
              WHERE table_schema = DATABASE() AND table_name = :name'
        );
        $statement->execute(['name' => 'user_sessions']);
        return $this->sessionsTable = (int) $statement->fetchColumn() === 1;
    }

    private static function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function flag(mixed $value): bool
    {
        return $value === true || $value === 1 || $value === '1';
    }
}

