<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;
use RuntimeException;

/**
 * Owns sign-in, sign-up and activation for this application.
 *
 * Authentication no longer leans on the legacy portal: passwords are verified
 * here, against this schema, and the session this class establishes is the one
 * the rest of the bridge trusts.
 */
final class AccountGateway
{
    /** Sign-in attempts allowed from one client inside the window. */
    private const LOGIN_ATTEMPT_LIMIT = 10;
    private const LOGIN_WINDOW_SECONDS = 900;
    /** Sign-ups allowed from one client per day; deliberately strict. */
    private const REGISTER_ATTEMPT_LIMIT = 5;
    private const REGISTER_WINDOW_SECONDS = 86400;
    private const ACTIVATION_TTL_SECONDS = 86400;
    /** One password and username policy for every path that sets them (sign-up, self-service, admin panel). */
    public const MINIMUM_PASSWORD_LENGTH = 12;
    public const USERNAME_PATTERN = '/\A[A-Za-z0-9._-]{3,32}\z/D';
    public const USERNAME_RULE = 'Nazwa użytkownika może mieć 3-32 znaki: litery, cyfry, kropka, podkreślenie lub myślnik.';

    public function __construct(
        private readonly PDO $database,
        private readonly Mailer $mailer,
        private readonly string $baseUrl = '/media-next/'
    ) {
    }

    /**
     * Verify credentials and establish the session.
     *
     * @param array<string, mixed> $session
     */
    public function login(array &$session, string $username, string $password, string $clientAddress): LegacyIdentity
    {
        $client = self::clientHash($clientAddress);
        if ($this->recentAttempts('login', $client) >= self::LOGIN_ATTEMPT_LIMIT) {
            throw new BridgeAuthenticationException('Zbyt wiele prób logowania. Spróbuj ponownie później.');
        }

        $statement = $this->database->prepare(
            'SELECT id, username, password_hash, role, is_guest, is_active, email, email_verified_at
             FROM users WHERE username = :username LIMIT 1'
        );
        $statement->execute(['username' => $username]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        $hash = is_array($row) ? (string) $row['password_hash'] : '';
        // Always run a verification so a missing account costs the same time as a
        // wrong password and cannot be told apart by timing.
        $verified = password_verify($password, $hash !== '' ? $hash : '$2y$12$'
            . str_repeat('.', 53));

        if (!is_array($row) || !$verified) {
            $this->recordAttempt('login', $client, $username, false);
            throw new BridgeAuthenticationException('Nieprawidłowy login lub hasło.');
        }
        if ((int) $row['is_active'] !== 1) {
            $this->recordAttempt('login', $client, $username, false);
            throw new BridgeAuthenticationException('Konto jest nieaktywne.');
        }
        if ($this->activationRequired() && $row['email_verified_at'] === null) {
            $this->recordAttempt('login', $client, $username, false);
            throw new BridgeAuthenticationException('Konto nie zostało jeszcze potwierdzone. Sprawdź pocztę.');
        }

        if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
            $rehash = $this->database->prepare('UPDATE users SET password_hash = :hash WHERE id = :id');
            $rehash->execute(['hash' => password_hash($password, PASSWORD_DEFAULT), 'id' => (int) $row['id']]);
        }

        $this->recordAttempt('login', $client, $username, true);
        $this->database->prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP(6) WHERE id = :id')
            ->execute(['id' => (int) $row['id']]);

        // A fresh identifier for the new privilege level, before anything is bound.
        if (session_status() === PHP_SESSION_ACTIVE && !headers_sent()) {
            session_regenerate_id(true);
        }
        $session = [];
        $session['logged_in'] = true;
        $session['user_id'] = (int) $row['id'];
        $session['username'] = (string) $row['username'];
        $session['is_admin'] = in_array((string) $row['role'], ['admin', 'super_admin'], true);
        $session['is_super_admin'] = (string) $row['role'] === 'super_admin';
        $session['is_guest'] = (int) $row['is_guest'] === 1;

        return LegacyIdentity::fromDatabaseRow($row);
    }

    /**
     * Create an unconfirmed account and send its activation link.
     *
     * @return array{status: string, spooled: bool}
     */
    public function register(string $username, string $email, string $password, string $clientAddress): array
    {
        if (!$this->registrationEnabled()) {
            throw new BridgeRequestException('Rejestracja jest wyłączona.');
        }
        $client = self::clientHash($clientAddress);
        if ($this->recentAttempts('register', $client) >= self::REGISTER_ATTEMPT_LIMIT) {
            throw new BridgeRequestException('Zbyt wiele rejestracji z tego adresu. Spróbuj jutro.');
        }
        self::assertUsername($username);
        $email = trim($email);
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 254) {
            throw new BridgeRequestException('Nieprawidłowy adres e-mail.');
        }
        if (strlen($password) < self::MINIMUM_PASSWORD_LENGTH || strlen($password) > 4096) {
            throw new BridgeRequestException('Hasło musi mieć co najmniej ' . self::MINIMUM_PASSWORD_LENGTH . ' znaków.');
        }

        $this->recordAttempt('register', $client, $email, false);
        $requiresActivation = $this->activationRequired();

        $taken = $this->database->prepare(
            'SELECT username, email FROM users WHERE username = :username OR email = :email LIMIT 1'
        );
        $taken->execute(['username' => $username, 'email' => $email]);
        $existing = $taken->fetch(PDO::FETCH_ASSOC);
        if (is_array($existing)) {
            // A taken username is visible anyway when signing in, so saying so is
            // no leak. A taken address is not, so that case reports success and
            // simply sends nothing.
            if (strcasecmp((string) $existing['username'], $username) === 0) {
                throw new BridgeRequestException('Ta nazwa użytkownika jest już zajęta.');
            }
            return ['status' => $requiresActivation ? 'pending' : 'active', 'spooled' => false];
        }

        $role = $this->settingValue('registration_default_role', 'user');
        if (!in_array($role, ['user', 'admin', 'super_admin'], true)) {
            $role = 'user';
        }

        $this->database->beginTransaction();
        try {
            // Self-registered accounts join the system user group outright, so the
            // group — not a NULL fallback — is what governs their rights from day one.
            $insert = $this->database->prepare(
                'INSERT INTO users (username, email, password_hash, role, is_guest, is_active, permission_group_id, email_verified_at)
                 VALUES (:username, :email, :hash, :role, 0, :active,
                         (SELECT id FROM permission_groups WHERE slug = \'user\' AND is_system = 1 LIMIT 1), :verified)'
            );
            $insert->execute([
                'username' => $username,
                'email' => $email,
                'hash' => password_hash($password, PASSWORD_DEFAULT),
                'role' => $role,
                'active' => $requiresActivation ? 0 : 1,
                'verified' => $requiresActivation ? null : date('Y-m-d H:i:s'),
            ]);
            $userId = (int) $this->database->lastInsertId();
            $token = $requiresActivation ? $this->issueToken($userId, 'activation') : null;
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }

        if ($token === null) {
            return ['status' => 'active', 'spooled' => false];
        }
        $this->sendActivation($email, $username, $token);
        return ['status' => 'pending', 'spooled' => $this->mailer->usesSpool()];
    }

    /** Consume an activation token and open the account. */
    public function activate(string $token): string
    {
        if (preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $token) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy link aktywacyjny.');
        }
        $statement = $this->database->prepare(
            'SELECT t.id, t.user_id, t.consumed_at, t.expires_at, u.username
             FROM user_activation_tokens t
             INNER JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = :hash AND t.purpose = :purpose
             LIMIT 1'
        );
        $statement->execute(['hash' => hash('sha256', $token), 'purpose' => 'activation']);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new BridgeRequestException('Link aktywacyjny jest nieprawidłowy.');
        }
        if ($row['consumed_at'] !== null) {
            throw new BridgeRequestException('Ten link został już wykorzystany.');
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            throw new BridgeRequestException('Link aktywacyjny wygasł. Poproś o nowy.');
        }

        $this->database->beginTransaction();
        try {
            $this->database->prepare(
                'UPDATE users SET is_active = 1, email_verified_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
            )->execute(['id' => (int) $row['user_id']]);
            $this->database->prepare(
                'UPDATE user_activation_tokens SET consumed_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
            )->execute(['id' => (int) $row['id']]);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return (string) $row['username'];
    }

    /** Issue a fresh activation link, without revealing whether the address exists. */
    public function resendActivation(string $email, string $clientAddress): bool
    {
        $client = self::clientHash($clientAddress);
        if ($this->recentAttempts('resend', $client) >= self::REGISTER_ATTEMPT_LIMIT) {
            throw new BridgeRequestException('Zbyt wiele żądań. Spróbuj później.');
        }
        $this->recordAttempt('resend', $client, $email, false);

        $statement = $this->database->prepare(
            'SELECT id, username, email FROM users
             WHERE email = :email AND email_verified_at IS NULL LIMIT 1'
        );
        $statement->execute(['email' => trim($email)]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return false;
        }
        $this->database->prepare(
            'UPDATE user_activation_tokens SET consumed_at = CURRENT_TIMESTAMP(6)
             WHERE user_id = :id AND purpose = :purpose AND consumed_at IS NULL'
        )->execute(['id' => (int) $row['id'], 'purpose' => 'activation']);
        $token = $this->issueToken((int) $row['id'], 'activation');
        $this->sendActivation((string) $row['email'], (string) $row['username'], $token);
        return true;
    }

    /** Change the caller's password after re-verifying the current one. */
    public function changePassword(int $userId, string $currentPassword, string $newPassword): void
    {
        $statement = $this->database->prepare('SELECT password_hash FROM users WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $userId]);
        $hash = $statement->fetchColumn();
        if (!is_string($hash) || !password_verify($currentPassword, $hash)) {
            throw new BridgeRequestException('Obecne hasło jest nieprawidłowe.');
        }
        if (strlen($newPassword) < self::MINIMUM_PASSWORD_LENGTH || strlen($newPassword) > 4096) {
            throw new BridgeRequestException('Hasło musi mieć co najmniej ' . self::MINIMUM_PASSWORD_LENGTH . ' znaków.');
        }
        $this->database->prepare('UPDATE users SET password_hash = :hash WHERE id = :id')
            ->execute(['hash' => password_hash($newPassword, PASSWORD_DEFAULT), 'id' => $userId]);
    }

    /**
     * Start an e-mail change: the new address gets a one-time confirmation link.
     *
     * The address only changes after that link is opened, so a typo cannot lock
     * the account out and the new mailbox is proven to exist. A taken address
     * reports success without sending, the same non-leak rule as registration.
     *
     * @return array{spooled: bool, sent: bool}
     */
    public function requestEmailChange(int $userId, string $newEmail, string $currentPassword): array
    {
        // Throttle per account so this endpoint cannot be turned into a mail
        // relay firing confirmation messages at arbitrary addresses.
        $client = self::clientHash('user:' . $userId);
        if ($this->recentAttempts('email_change', $client) >= self::REGISTER_ATTEMPT_LIMIT) {
            throw new BridgeRequestException('Zbyt wiele prób zmiany adresu. Spróbuj później.');
        }
        $this->recordAttempt('email_change', $client, (string) $userId, false);
        $newEmail = trim($newEmail);
        if (filter_var($newEmail, FILTER_VALIDATE_EMAIL) === false || strlen($newEmail) > 254) {
            throw new BridgeRequestException('Nieprawidłowy adres e-mail.');
        }
        $statement = $this->database->prepare(
            'SELECT username, password_hash, email FROM users WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !password_verify($currentPassword, (string) $row['password_hash'])) {
            throw new BridgeRequestException('Obecne hasło jest nieprawidłowe.');
        }
        if (strcasecmp((string) $row['email'], $newEmail) === 0) {
            throw new BridgeRequestException('To jest już Twój obecny adres e-mail.');
        }
        $taken = $this->database->prepare('SELECT 1 FROM users WHERE email = :email LIMIT 1');
        $taken->execute(['email' => $newEmail]);
        if ($taken->fetchColumn() !== false) {
            return ['spooled' => false, 'sent' => false];
        }
        $this->database->prepare(
            'UPDATE user_activation_tokens SET consumed_at = CURRENT_TIMESTAMP(6)
             WHERE user_id = :id AND purpose = :purpose AND consumed_at IS NULL'
        )->execute(['id' => $userId, 'purpose' => 'email_change']);
        $token = $this->issueToken($userId, 'email_change', $newEmail);
        $link = rtrim($this->baseUrl, '/') . '/login/?email_change=' . rawurlencode($token);
        $hours = (int) (self::ACTIVATION_TTL_SECONDS / 3600);
        $body = "Cześć {$row['username']},\n\n"
            . "Aby potwierdzić zmianę adresu e-mail w bibliotece TryHackX Media, otwórz poniższy link:\n\n"
            . "{$link}\n\n"
            . "Link jest ważny {$hours} godziny i można go użyć jeden raz.\n"
            . "Jeżeli to nie Ty prosisz o zmianę, zignoruj tę wiadomość — adres pozostanie bez zmian.\n";
        $this->mailer->send($newEmail, 'Potwierdź nowy adres e-mail', $body);
        return ['spooled' => $this->mailer->usesSpool(), 'sent' => true];
    }

    /** Consume an e-mail-change token and apply the new address. */
    public function confirmEmailChange(string $token): string
    {
        if (preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $token) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy link potwierdzający.');
        }
        $statement = $this->database->prepare(
            'SELECT t.id, t.user_id, t.payload, t.consumed_at, t.expires_at, u.username
             FROM user_activation_tokens t
             INNER JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = :hash AND t.purpose = :purpose
             LIMIT 1'
        );
        $statement->execute(['hash' => hash('sha256', $token), 'purpose' => 'email_change']);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !is_string($row['payload']) || $row['payload'] === '') {
            throw new BridgeRequestException('Link potwierdzający jest nieprawidłowy.');
        }
        if ($row['consumed_at'] !== null) {
            throw new BridgeRequestException('Ten link został już wykorzystany.');
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            throw new BridgeRequestException('Link potwierdzający wygasł. Poproś o nowy.');
        }
        $taken = $this->database->prepare(
            'SELECT 1 FROM users WHERE email = :email AND id <> :id LIMIT 1'
        );
        $taken->execute(['email' => $row['payload'], 'id' => (int) $row['user_id']]);
        if ($taken->fetchColumn() !== false) {
            throw new BridgeRequestException('Ten adres e-mail jest już zajęty.');
        }

        $this->database->beginTransaction();
        try {
            $this->database->prepare(
                'UPDATE users SET email = :email, email_verified_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
            )->execute(['email' => $row['payload'], 'id' => (int) $row['user_id']]);
            $this->database->prepare(
                'UPDATE user_activation_tokens SET consumed_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
            )->execute(['id' => (int) $row['id']]);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return (string) $row['username'];
    }

    /**
     * Re-send an activation link for a specific pending account, on the
     * operator's request from the panel.
     */
    public function adminResendActivation(int $userId): bool
    {
        $statement = $this->database->prepare(
            'SELECT id, username, email FROM users
             WHERE id = :id AND email_verified_at IS NULL AND email IS NOT NULL LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !is_string($row['email']) || $row['email'] === '') {
            throw new BridgeRequestException('Konto nie oczekuje na aktywację albo nie ma adresu e-mail.');
        }
        $this->database->prepare(
            'UPDATE user_activation_tokens SET consumed_at = CURRENT_TIMESTAMP(6)
             WHERE user_id = :id AND purpose = :purpose AND consumed_at IS NULL'
        )->execute(['id' => (int) $row['id'], 'purpose' => 'activation']);
        $token = $this->issueToken((int) $row['id'], 'activation');
        $this->sendActivation((string) $row['email'], (string) $row['username'], $token);
        return $this->mailer->usesSpool();
    }

    /**
     * The settings the challenge guard needs, read in one query.
     *
     * @return array<string, string>
     */
    public function securitySettings(): array
    {
        $keys = ['captcha_provider', 'captcha_site_key', 'captcha_secret_key',
            'captcha_protect_login', 'captcha_protect_registration'];
        $values = array_fill_keys($keys, '');
        try {
            $placeholders = implode(',', array_fill(0, count($keys), '?'));
            $statement = $this->database->prepare(
                "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ({$placeholders})"
            );
            $statement->execute($keys);
            foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $values[(string) $row['setting_key']] = (string) $row['setting_value'];
            }
        } catch (\PDOException) {
            return $values;
        }
        return $values;
    }

    public function registrationEnabled(): bool
    {
        return $this->settingValue('registration_enabled', '0') === '1';
    }

    public function activationRequired(): bool
    {
        return $this->settingValue('registration_requires_activation', '1') === '1';
    }

    private function issueToken(int $userId, string $purpose, ?string $payload = null): string
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $this->database->prepare(
            'INSERT INTO user_activation_tokens (user_id, purpose, token_hash, payload, expires_at)
             VALUES (:user_id, :purpose, :hash, :payload, :expires)'
        )->execute([
            'user_id' => $userId,
            'purpose' => $purpose,
            'hash' => hash('sha256', $token),
            'payload' => $payload,
            'expires' => date('Y-m-d H:i:s', time() + self::ACTIVATION_TTL_SECONDS),
        ]);
        return $token;
    }

    private function sendActivation(string $email, string $username, string $token): void
    {
        $link = rtrim($this->baseUrl, '/') . '/login/?activate=' . rawurlencode($token);
        $hours = (int) (self::ACTIVATION_TTL_SECONDS / 3600);
        $body = "Cześć {$username},\n\n"
            . "Aby dokończyć zakładanie konta w bibliotece TryHackX Media, otwórz poniższy link:\n\n"
            . "{$link}\n\n"
            . "Link jest ważny {$hours} godziny i można go użyć jeden raz.\n"
            . "Jeżeli to nie Ty zakładałeś konto, zignoruj tę wiadomość — bez kliknięcia nic się nie stanie.\n";
        $this->mailer->send($email, 'Potwierdź swoje konto', $body);
    }

    private function settingValue(string $key, string $fallback): string
    {
        try {
            $statement = $this->database->prepare(
                'SELECT setting_value FROM app_settings WHERE setting_key = :key LIMIT 1'
            );
            $statement->execute(['key' => $key]);
            $value = $statement->fetchColumn();
        } catch (\PDOException) {
            return $fallback;
        }
        return is_string($value) && $value !== '' ? $value : $fallback;
    }

    private function recentAttempts(string $kind, string $clientHash): int
    {
        $window = $kind === 'login' ? self::LOGIN_WINDOW_SECONDS : self::REGISTER_WINDOW_SECONDS;
        $statement = $this->database->prepare(
            'SELECT COUNT(*) FROM auth_attempts
             WHERE kind = :kind AND client_hash = :client AND succeeded = 0
               AND created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :window SECOND)'
        );
        $statement->bindValue(':kind', $kind, PDO::PARAM_STR);
        $statement->bindValue(':client', $clientHash, PDO::PARAM_STR);
        $statement->bindValue(':window', $window, PDO::PARAM_INT);
        $statement->execute();
        return (int) $statement->fetchColumn();
    }

    private function recordAttempt(string $kind, string $clientHash, string $identifier, bool $succeeded): void
    {
        $this->database->prepare(
            'INSERT INTO auth_attempts (kind, client_hash, identifier, succeeded)
             VALUES (:kind, :client, :identifier, :succeeded)'
        )->execute([
            'kind' => $kind,
            'client' => $clientHash,
            'identifier' => substr($identifier, 0, 191),
            'succeeded' => $succeeded ? 1 : 0,
        ]);
        // Opportunistic cleanup keeps the table from growing without bound.
        if (random_int(1, 50) === 1) {
            $this->database->exec(
                'DELETE FROM auth_attempts WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 30 DAY)'
            );
        }
    }

    private static function clientHash(string $address): string
    {
        return hash('sha256', 'auth|' . $address);
    }

    private static function assertUsername(string $username): void
    {
        if (preg_match(self::USERNAME_PATTERN, $username) !== 1) {
            throw new BridgeRequestException(self::USERNAME_RULE);
        }
    }
}
