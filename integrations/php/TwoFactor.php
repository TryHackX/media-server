<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;
use RuntimeException;

/**
 * Two-factor sign-in for an account: its TOTP secret and recovery codes.
 *
 * The three ways 2FA goes wrong, and what this class does about them:
 *
 *  - locking yourself out while turning it on: the secret stays *pending*
 *    until a code made from it has been accepted (confirmSetup), and a pending
 *    secret nobody confirmed expires after a quarter of an hour;
 *  - losing the phone: ten single-use recovery codes, shown once, stored only
 *    as keyed digests; an operator can also reset 2FA for an account;
 *  - a code used twice: the last accepted step is kept and verification only
 *    accepts a later one, by a conditional UPDATE, so two requests racing with
 *    the same code cannot both win.
 *
 * The secret is a credential — whoever has it makes valid codes for ever — so
 * it is stored encrypted (AES-256-GCM, a key derived from the bridge's transfer
 * key, which lives in the private configuration, never in the repository or in
 * the database), bound to the account it belongs to as associated data.
 *
 * Times are unix seconds from PHP's clock.
 */
final class TwoFactor
{
    public const RECOVERY_COUNT = 10;
    public const SETUP_TTL_SECONDS = 900;
    private const CIPHER = 'aes-256-gcm';
    private const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

    /** @var \Closure(): int */
    private readonly \Closure $clock;

    /**
     * @param string $encryptionKey 32 raw bytes for the secrets
     * @param string $recoveryKey raw HMAC key for the recovery-code digests
     * @param (\Closure(): int)|null $clock
     */
    public function __construct(
        private readonly PDO $database,
        private readonly string $encryptionKey,
        private readonly string $recoveryKey,
        ?\Closure $clock = null
    ) {
        if (strlen($encryptionKey) !== 32) {
            throw new RuntimeException('Klucz szyfrowania 2FA musi mieć 32 bajty.');
        }
        $this->clock = $clock ?? static fn (): int => time();
    }

    /** @return array{enabled:bool,pending:bool,recovery_left:int} */
    public function status(int $userId): array
    {
        $row = $this->row($userId);
        if ($row === null) {
            return ['enabled' => false, 'pending' => false, 'recovery_left' => 0];
        }
        $enabled = $row['enabled_at'] !== null;
        return [
            'enabled' => $enabled,
            'pending' => !$enabled && !$this->pendingExpired($row),
            'recovery_left' => $enabled ? count($this->recoveryDigests($row)) : 0,
        ];
    }

    public function isEnabled(int $userId): bool
    {
        return $this->status($userId)['enabled'];
    }

    /**
     * Start (or restart) setting up: a new pending secret.
     *
     * @return array{secret:string,otpauth_uri:string}
     */
    public function beginSetup(int $userId, string $account, string $issuer): array
    {
        if ($this->isEnabled($userId)) {
            throw new BridgeRequestException('Weryfikacja dwuetapowa jest już włączona.');
        }
        $secret = Totp::generateSecret();
        $this->database->prepare('DELETE FROM user_two_factor WHERE user_id = :id')->execute(['id' => $userId]);
        $this->database->prepare(
            'INSERT INTO user_two_factor (user_id, secret_ciphertext, enabled_at, pending_since, last_step, recovery_codes)
             VALUES (:id, :secret, NULL, :now, NULL, NULL)'
        )->execute(['id' => $userId, 'secret' => $this->encrypt($userId, $secret), 'now' => ($this->clock)()]);
        return ['secret' => $secret, 'otpauth_uri' => Totp::uri($issuer, $account, $secret)];
    }

    /**
     * Turn 2FA on with the first code from the app; returns the recovery codes, shown once.
     *
     * @return list<string>
     */
    public function confirmSetup(int $userId, string $code): array
    {
        $row = $this->row($userId);
        if ($row === null || $row['enabled_at'] !== null || $this->pendingExpired($row)) {
            throw new BridgeRequestException('Konfiguracja weryfikacji dwuetapowej wygasła. Zacznij od nowa.');
        }
        $now = ($this->clock)();
        $step = Totp::verify($this->decrypt($userId, (string) $row['secret_ciphertext']), $code, $now);
        if ($step === null) {
            return [];
        }
        [$codes, $digests] = $this->freshRecoveryCodes();
        $statement = $this->database->prepare(
            'UPDATE user_two_factor SET enabled_at = :now, last_step = :step, recovery_codes = :codes
             WHERE user_id = :id AND enabled_at IS NULL'
        );
        $statement->execute([
            'now' => $now,
            'step' => $step,
            'codes' => json_encode($digests, JSON_THROW_ON_ERROR),
            'id' => $userId,
        ]);
        return $statement->rowCount() === 1 ? $codes : [];
    }

    /**
     * Check a second factor: a code from the app, or one of the recovery codes (spent on use).
     *
     * @return string|null 'totp' or 'recovery' for what was accepted, null when nothing was
     */
    public function verify(int $userId, string $code): ?string
    {
        $row = $this->row($userId);
        if ($row === null || $row['enabled_at'] === null) {
            return null;
        }
        $trimmed = trim($code);
        if (preg_match('/\A[0-9]{6}\z/D', preg_replace('/\s+/', '', $trimmed) ?? '') === 1) {
            $lastStep = $row['last_step'] === null ? null : (int) $row['last_step'];
            $step = Totp::verify($this->decrypt($userId, (string) $row['secret_ciphertext']), $trimmed, ($this->clock)(), $lastStep);
            if ($step === null) {
                return null;
            }
            // Only one request may move the step forward; the loser of a race is a replay.
            $statement = $this->database->prepare(
                'UPDATE user_two_factor SET last_step = :step
                 WHERE user_id = :id AND enabled_at IS NOT NULL AND (last_step IS NULL OR last_step < :step_again)'
            );
            $statement->execute(['step' => $step, 'step_again' => $step, 'id' => $userId]);
            return $statement->rowCount() === 1 ? 'totp' : null;
        }
        return $this->spendRecoveryCode($userId, $row, $trimmed) ? 'recovery' : null;
    }

    /** @return list<string> a new set, shown once; the old one stops working */
    public function regenerateRecovery(int $userId): array
    {
        if (!$this->isEnabled($userId)) {
            throw new BridgeRequestException('Weryfikacja dwuetapowa nie jest włączona.');
        }
        [$codes, $digests] = $this->freshRecoveryCodes();
        $this->database->prepare('UPDATE user_two_factor SET recovery_codes = :codes WHERE user_id = :id')
            ->execute(['codes' => json_encode($digests, JSON_THROW_ON_ERROR), 'id' => $userId]);
        return $codes;
    }

    /** Switch it off (the account's own request, or an operator's reset). */
    public function disable(int $userId): bool
    {
        $statement = $this->database->prepare('DELETE FROM user_two_factor WHERE user_id = :id');
        $statement->execute(['id' => $userId]);
        return $statement->rowCount() > 0;
    }

    /** @return list<int> accounts with 2FA switched on, for the panel's user list */
    public function enabledUserIds(): array
    {
        return array_map(
            'intval',
            $this->database->query('SELECT user_id FROM user_two_factor WHERE enabled_at IS NOT NULL')->fetchAll(PDO::FETCH_COLUMN)
        );
    }

    public function encrypt(int $userId, string $plain): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($plain, self::CIPHER, $this->encryptionKey, OPENSSL_RAW_DATA, $iv, $tag, self::aad($userId), 16);
        if (!is_string($cipher)) {
            throw new RuntimeException('Nie można zaszyfrować sekretu 2FA.');
        }
        return 'v1.' . base64_encode($iv . $tag . $cipher);
    }

    public function decrypt(int $userId, string $stored): string
    {
        $raw = str_starts_with($stored, 'v1.') ? base64_decode(substr($stored, 3), true) : false;
        if (!is_string($raw) || strlen($raw) < 29) {
            throw new RuntimeException('Uszkodzony sekret 2FA.');
        }
        $plain = openssl_decrypt(
            substr($raw, 28),
            self::CIPHER,
            $this->encryptionKey,
            OPENSSL_RAW_DATA,
            substr($raw, 0, 12),
            substr($raw, 12, 16),
            self::aad($userId)
        );
        if (!is_string($plain)) {
            // Wrong key (the transfer key was changed) or a secret moved to another account.
            throw new RuntimeException('Nie można odszyfrować sekretu 2FA.');
        }
        return $plain;
    }

    /** A recovery code as typed: case, spaces and dashes forgiven. */
    public static function normalizeRecoveryCode(string $code): string
    {
        return strtolower((string) preg_replace('/[^A-Za-z0-9]/', '', $code));
    }

    /** @param array<string, mixed> $row */
    private function spendRecoveryCode(int $userId, array $row, string $code): bool
    {
        $normalized = self::normalizeRecoveryCode($code);
        if (strlen($normalized) !== 10) {
            return false;
        }
        $digest = $this->recoveryDigest($normalized);
        $digests = $this->recoveryDigests($row);
        $match = null;
        foreach ($digests as $index => $candidate) {
            if (hash_equals($candidate, $digest)) {
                $match = $index;
            }
        }
        if ($match === null) {
            return false;
        }
        unset($digests[$match]);
        // Compare-and-swap on the stored list: two requests spending the same
        // code cannot both see it still there.
        $statement = $this->database->prepare(
            'UPDATE user_two_factor SET recovery_codes = :new WHERE user_id = :id AND recovery_codes = :old'
        );
        $statement->execute([
            'new' => json_encode(array_values($digests), JSON_THROW_ON_ERROR),
            'id' => $userId,
            'old' => (string) $row['recovery_codes'],
        ]);
        return $statement->rowCount() === 1;
    }

    /** @return array{0: list<string>, 1: list<string>} codes to show, digests to store */
    private function freshRecoveryCodes(): array
    {
        $codes = [];
        $digests = [];
        while (count($codes) < self::RECOVERY_COUNT) {
            $plain = '';
            for ($i = 0; $i < 10; $i++) {
                $plain .= self::RECOVERY_ALPHABET[random_int(0, strlen(self::RECOVERY_ALPHABET) - 1)];
            }
            if (in_array($plain, $codes, true)) {
                continue;
            }
            $codes[] = substr($plain, 0, 5) . '-' . substr($plain, 5);
            $digests[] = $this->recoveryDigest($plain);
        }
        return [$codes, $digests];
    }

    private function recoveryDigest(string $normalized): string
    {
        return hash_hmac('sha256', 'recovery|' . $normalized, $this->recoveryKey);
    }

    /**
     * @param array<string, mixed> $row
     * @return list<string>
     */
    private function recoveryDigests(array $row): array
    {
        $decoded = is_string($row['recovery_codes'] ?? null) ? json_decode($row['recovery_codes'], true) : null;
        return is_array($decoded) ? array_values(array_filter($decoded, 'is_string')) : [];
    }

    /** @param array<string, mixed> $row */
    private function pendingExpired(array $row): bool
    {
        return ($this->clock)() - (int) $row['pending_since'] > self::SETUP_TTL_SECONDS;
    }

    /** @return array<string, mixed>|null */
    private function row(int $userId): ?array
    {
        $statement = $this->database->prepare(
            'SELECT user_id, secret_ciphertext, enabled_at, pending_since, last_step, recovery_codes
             FROM user_two_factor WHERE user_id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private static function aad(int $userId): string
    {
        return 'tryhackx-totp|v1|' . $userId;
    }
}
