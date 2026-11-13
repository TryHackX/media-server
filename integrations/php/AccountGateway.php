<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;
use RuntimeException;

require_once __DIR__ . '/TrustedProxy.php';

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
    /**
     * Failed sign-ins one account may take inside the window from devices that
     * have never signed in to it. Devices that have (see deviceCookieFor) are
     * not counted here, so this soft limit cannot shut the owner out of a
     * browser they already use.
     */
    private const ACCOUNT_ATTEMPT_LIMIT = 20;
    /** Failures one device cookie may carry inside the window before it stops counting as known. */
    private const DEVICE_ATTEMPT_LIMIT = 10;
    /** How long a device stays known to an account after its last sign-in there. */
    public const DEVICE_COOKIE_TTL_SECONDS = 31536000;
    /** Wrong second-factor codes (or passwords in the 2FA settings) per client and per account in the window. */
    private const SECOND_FACTOR_LIMIT = 10;
    /** Sign-ups allowed from one client per day; deliberately strict. */
    private const REGISTER_ATTEMPT_LIMIT = 5;
    private const REGISTER_WINDOW_SECONDS = 86400;
    private const ACTIVATION_TTL_SECONDS = 86400;
    /** One password and username policy for every path that sets them (sign-up, self-service, admin panel). */
    public const MINIMUM_PASSWORD_LENGTH = 12;
    public const USERNAME_PATTERN = '/\A[A-Za-z0-9._-]{3,32}\z/D';
    public const USERNAME_RULE = 'Nazwa użytkownika może mieć 3-32 znaki: litery, cyfry, kropka, podkreślenie lub myślnik.';

    /**
     * @param string|null $deviceKey HMAC key for device cookies (raw bytes); without
     *   one no device is known and every failure counts towards the account limit.
     */
    public function __construct(
        private readonly PDO $database,
        private readonly Mailer $mailer,
        private readonly string $baseUrl = '/',
        private readonly ?string $deviceKey = null,
        private readonly int $resendFloorMilliseconds = 1200
    ) {
    }

    /**
     * The first step of signing in: limits, the password and the account's
     * state. Returns the account's row and touches no session, so the bridge
     * can ask for a second factor before anything is opened.
     *
     * Two limits apply before the password is checked: the per-address one, and
     * a per-account one that counts only devices which have never signed in to
     * that account (deviceCookieFor). The second is kept under the account the
     * typed name resolves to — or under the name, when there is no such account.
     *
     * @return array<string, mixed>
     */
    public function checkPassword(
        string $username,
        string $password,
        string $clientAddress,
        ?string $deviceCookie = null
    ): array {
        $client = self::clientHash($clientAddress);
        if ($this->recentAttempts('login', $client) >= self::LOGIN_ATTEMPT_LIMIT) {
            throw new BridgeRateLimitException('Zbyt wiele prób logowania. Spróbuj ponownie później.');
        }

        $statement = $this->database->prepare(
            'SELECT id, username, password_hash, role, is_guest, is_active, disabled_at, email, email_verified_at
             FROM users WHERE username = :username LIMIT 1'
        );
        $statement->execute(['username' => $username]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        $account = self::accountSubject($username, is_array($row) ? (int) $row['id'] : null);
        $device = $this->knownDevice($deviceCookie, is_array($row) ? (int) $row['id'] : null);
        if ($device !== null && $this->recentAttempts('login_device', $device) >= self::DEVICE_ATTEMPT_LIMIT) {
            $device = null;
        }
        if ($device === null && $this->recentAttempts('login_account', $account, true) >= self::ACCOUNT_ATTEMPT_LIMIT) {
            throw new BridgeRateLimitException(
                'Zbyt wiele nieudanych prób logowania na to konto. Spróbuj ponownie za kwadrans '
                . 'albo zaloguj się z urządzenia, na którym już się logowałeś.'
            );
        }

        $hash = is_array($row) ? (string) $row['password_hash'] : '';
        // Always run a verification so a missing account costs the same time as a
        // wrong password and cannot be told apart by timing.
        $verified = password_verify($password, $hash !== '' ? $hash : '$2y$12$'
            . str_repeat('.', 53));

        if (!is_array($row) || !$verified) {
            $this->recordLoginFailure($client, $username, $account, $device);
            throw new BridgeAuthenticationException('Nieprawidłowy login lub hasło.');
        }
        if ((int) $row['is_active'] !== 1 || $row['disabled_at'] !== null) {
            $this->recordLoginFailure($client, $username, $account, $device);
            throw new BridgeAuthenticationException('Konto jest nieaktywne.');
        }
        if ($this->activationRequired() && $row['email_verified_at'] === null) {
            $this->recordLoginFailure($client, $username, $account, $device);
            throw new BridgeAuthenticationException('Konto nie zostało jeszcze potwierdzone. Sprawdź pocztę.');
        }

        if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
            $rehash = $this->database->prepare('UPDATE users SET password_hash = :hash WHERE id = :id');
            $rehash->execute(['hash' => password_hash($password, PASSWORD_DEFAULT), 'id' => (int) $row['id']]);
        }

        $this->recordAttempt('login', $client, $username, true);
        return $row;
    }

    /**
     * The account row again, for the second step of a sign-in: the state may
     * have changed in the minutes between the password and the code.
     *
     * @return array<string, mixed>
     */
    public function signInRow(int $userId): array
    {
        $statement = $this->database->prepare(
            'SELECT id, username, role, is_guest, is_active, disabled_at, email, email_verified_at
             FROM users WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || (int) $row['is_active'] !== 1 || $row['disabled_at'] !== null
            || ($this->activationRequired() && $row['email_verified_at'] === null)) {
            throw new BridgeAuthenticationException('Konto jest nieaktywne.');
        }
        return $row;
    }

    /**
     * Establish the session for an account that has passed every step.
     *
     * @param array<string, mixed> $session
     * @param array<string, mixed> $row
     */
    public function openSession(array &$session, array $row): LegacyIdentity
    {
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
     * While sign-up needs activation the answer is the same whatever the name
     * and address were — same status, same fields, the password hashed either
     * way — and the specifics go to the mailbox of the address that was given:
     * the activation link, a note that the name is taken, or a note that the
     * address already has an account. Without activation the account is usable
     * at once and its existence shows at sign-in regardless, so there a taken
     * name is still reported directly.
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
            throw new BridgeRateLimitException('Zbyt wiele rejestracji z tego adresu. Spróbuj jutro.');
        }
        self::assertUsername($username);
        $email = trim($email);
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 254) {
            throw new BridgeRequestException('Nieprawidłowy adres e-mail.');
        }
        self::assertPassword($password);

        $this->recordAttempt('register', $client, $email, false);
        $requiresActivation = $this->activationRequired();
        $hash = password_hash($password, PASSWORD_DEFAULT);

        $nameTaken = $this->database->prepare('SELECT 1 FROM users WHERE username = :username LIMIT 1');
        $nameTaken->execute(['username' => $username]);
        $addressOwner = $this->database->prepare('SELECT username FROM users WHERE email = :email LIMIT 1');
        $addressOwner->execute(['email' => $email]);
        $owner = $addressOwner->fetchColumn();
        if ($nameTaken->fetchColumn() !== false || $owner !== false) {
            if (!$requiresActivation) {
                // Usable at once, so sign-in shows whether it exists anyway: the
                // answer says which of the two is taken. (A taken address used
                // to answer "active" although nothing had been created.)
                throw new BridgeRequestException($owner === false
                    ? 'Ta nazwa użytkownika jest już zajęta.'
                    : 'Ten adres e-mail ma już konto.');
            }
            $this->deliver(fn () => $owner !== false
                ? $this->sendAlreadyRegistered($email, (string) $owner)
                : $this->sendNameTaken($email, $username));
            return ['status' => 'pending', 'spooled' => $this->mailer->usesSpool()];
        }

        $role = $this->settingValue('registration_default_role', 'user');
        if (!in_array($role, ['user', 'admin', 'super_admin'], true)) {
            $role = 'user';
        }

        $this->database->beginTransaction();
        try {
            // Self-registered accounts join the system user group outright, so the
            // group — not a NULL fallback — is what governs their rights from day one.
            // The confirmation time comes from the database clock, like every
            // other timestamp it is later compared with.
            $insert = $this->database->prepare(
                'INSERT INTO users (username, email, password_hash, role, is_guest, is_active, permission_group_id, email_verified_at)
                 VALUES (:username, :email, :hash, :role, 0, :active,
                         (SELECT id FROM permission_groups WHERE slug = \'user\' AND is_system = 1 LIMIT 1),
                         IF(:verified = 1, CURRENT_TIMESTAMP(6), NULL))'
            );
            $insert->execute([
                'username' => $username,
                'email' => $email,
                'hash' => $hash,
                'role' => $role,
                'active' => $requiresActivation ? 0 : 1,
                'verified' => $requiresActivation ? 0 : 1,
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
        // The account exists from the commit above. A mail server that is down
        // must not turn that into "internal error" with the account left
        // behind and its name taken: the answer is the same "check your
        // mailbox", and "send the link again" works once mail does.
        $this->deliver(fn () => $this->sendActivation($email, $username, $token));
        return ['status' => 'pending', 'spooled' => $this->mailer->usesSpool()];
    }

    /**
     * Send one message of the sign-up flow; a failure is logged, never thrown.
     *
     * Every branch of sign-up sends something (the link, "that name is taken",
     * "that address has an account"), so letting a refused or unreachable mail
     * server decide the answer would make the three branches tell themselves
     * apart — and, on the branch that created the account, answer 500.
     */
    private function deliver(callable $send): bool
    {
        try {
            $send();
            return true;
        } catch (\Throwable $error) {
            error_log('TryHackX bridge: account mail not sent: ' . $error::class . ': ' . $error->getMessage());
            return false;
        }
    }

    /** Consume an activation token and open the account. */
    public function activate(string $token): string
    {
        if (preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $token) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy link aktywacyjny.');
        }
        // Expiry is decided by the database clock, the one that wrote it.
        $statement = $this->database->prepare(
            'SELECT t.id, t.user_id, t.consumed_at, t.expires_at > CURRENT_TIMESTAMP(6) AS is_current,
                    u.username, u.disabled_at
             FROM user_activation_tokens t
             INNER JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = :hash AND t.purpose = :purpose
             LIMIT 1'
        );
        $statement->execute(['hash' => hash('sha256', $token), 'purpose' => 'activation']);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        // A disabled account answers like an unknown link: switching an account
        // off is the operator's call, and a link from its mailbox does not undo it.
        if (!is_array($row) || $row['disabled_at'] !== null) {
            throw new CatalogItemNotFoundException('Link aktywacyjny jest nieprawidłowy.');
        }
        if ($row['consumed_at'] !== null) {
            throw new BridgeRequestException('Ten link został już wykorzystany.');
        }
        if ((int) $row['is_current'] !== 1) {
            throw new BridgeRequestException('Link aktywacyjny wygasł. Poproś o nowy.');
        }

        $this->database->beginTransaction();
        try {
            $this->database->prepare(
                'UPDATE users SET is_active = 1, email_verified_at = CURRENT_TIMESTAMP(6)
                  WHERE id = :id AND disabled_at IS NULL'
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
            throw new BridgeRateLimitException('Zbyt wiele żądań. Spróbuj później.');
        }
        $this->recordAttempt('resend', $client, $email, false);

        // The answer is the same success whether or not the address is waiting
        // for a link — and it has to take the same time, too: a link was sent
        // only for a pending account, synchronously, so "slow" said "there is
        // one". Mail cannot be sent after the answer here (no FPM), so the
        // answer waits out a fixed floor either way. A mail server slower than
        // the floor still shows; one that fails is logged, not reported.
        $started = hrtime(true);
        try {
            // Pending only: a disabled account gets no new link.
            $statement = $this->database->prepare(
                'SELECT id, username, email FROM users
                 WHERE email = :email AND email_verified_at IS NULL AND disabled_at IS NULL LIMIT 1'
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
            return $this->deliver(
                fn () => $this->sendActivation((string) $row['email'], (string) $row['username'], $token)
            );
        } finally {
            $remaining = $this->resendFloorMilliseconds * 1000 - intdiv(hrtime(true) - $started, 1000);
            if ($remaining > 0) {
                usleep($remaining);
            }
        }
    }

    /**
     * Change the caller's password after re-verifying the current one.
     *
     * Through verifyPassword(), so wrong guesses are counted like wrong codes:
     * ten per quarter of an hour, per client and per account. This form used to
     * count nothing — whoever held a session could try the current password as
     * often as they liked (administrators are exempt from the request ladder).
     *
     * @throws BridgeRateLimitException after too many wrong guesses
     */
    public function changePassword(int $userId, string $currentPassword, string $newPassword, string $clientAddress): void
    {
        if (!$this->verifyPassword($userId, $currentPassword, $clientAddress)) {
            throw new BridgeRequestException('Obecne hasło jest nieprawidłowe.');
        }
        self::assertPassword($newPassword);
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
            throw new BridgeRateLimitException('Zbyt wiele prób zmiany adresu. Spróbuj później.');
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
        $sent = $this->deliver(fn () => $this->mailer->send($newEmail, 'Potwierdź nowy adres e-mail', $body));
        // The address the account has now hears about it as well: if somebody
        // else is at the keyboard, this is the only message its owner gets
        // before the address — and with it every later "reset" — moves away.
        $oldEmail = is_string($row['email']) ? trim($row['email']) : '';
        if ($sent && $oldEmail !== '' && filter_var($oldEmail, FILTER_VALIDATE_EMAIL) !== false) {
            $notice = "Cześć {$row['username']},\n\n"
                . "Na Twoim koncie w bibliotece TryHackX Media poproszono o zmianę adresu e-mail.\n"
                . "Nowy adres zacznie obowiązywać dopiero po kliknięciu linku wysłanego na ten nowy adres.\n\n"
                . "Jeżeli to Ty — nic więcej nie trzeba robić.\n"
                . "Jeżeli to nie Ty, zmień hasło w zakładce „Moje konto” i zamknij pozostałe sesje:\n"
                . "ktoś zna Twoje obecne hasło.\n";
            $this->deliver(fn () => $this->mailer->send($oldEmail, 'Prośba o zmianę adresu e-mail', $notice));
        }
        return ['spooled' => $this->mailer->usesSpool(), 'sent' => $sent];
    }

    /** Consume an e-mail-change token and apply the new address. */
    public function confirmEmailChange(string $token): string
    {
        if (preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $token) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy link potwierdzający.');
        }
        $statement = $this->database->prepare(
            'SELECT t.id, t.user_id, t.payload, t.consumed_at, t.expires_at > CURRENT_TIMESTAMP(6) AS is_current,
                    u.username
             FROM user_activation_tokens t
             INNER JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = :hash AND t.purpose = :purpose
             LIMIT 1'
        );
        $statement->execute(['hash' => hash('sha256', $token), 'purpose' => 'email_change']);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !is_string($row['payload']) || $row['payload'] === '') {
            throw new CatalogItemNotFoundException('Link potwierdzający jest nieprawidłowy.');
        }
        if ($row['consumed_at'] !== null) {
            throw new BridgeRequestException('Ten link został już wykorzystany.');
        }
        if ((int) $row['is_current'] !== 1) {
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
            'SELECT id, username, email, email_verified_at, disabled_at FROM users WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Użytkownik nie istnieje.');
        }
        if ($row['email_verified_at'] !== null || $row['disabled_at'] !== null
            || !is_string($row['email']) || $row['email'] === '') {
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
     * The settings the security classes need (CaptchaGuard::settingKeys() and
     * friends), read in one query. A key with no row is absent, so each class
     * falls back to its own default rather than to an empty string.
     *
     * @param list<string> $keys
     * @return array<string, string>
     */
    public function securitySettings(array $keys): array
    {
        $values = [];
        if ($keys === []) {
            return $values;
        }
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
        $token = self::base64Url(random_bytes(32));
        // Dated by the database, which is also the clock activate() reads it
        // with; PHP's clock runs in another time zone on this machine.
        $this->database->prepare(
            'INSERT INTO user_activation_tokens (user_id, purpose, token_hash, payload, expires_at)
             VALUES (:user_id, :purpose, :hash, :payload, DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL :ttl SECOND))'
        )->execute([
            'user_id' => $userId,
            'purpose' => $purpose,
            'hash' => hash('sha256', $token),
            'payload' => $payload,
            'ttl' => self::ACTIVATION_TTL_SECONDS,
        ]);
        return $token;
    }

    /** A sign-up asked for a name that is already in use; the address it gave hears so. */
    private function sendNameTaken(string $email, string $username): void
    {
        $link = rtrim($this->baseUrl, '/') . '/login/';
        $body = "Cześć,\n\n"
            . "Ktoś (zapewne Ty) próbował założyć konto „{$username}” w bibliotece TryHackX Media z tym adresem e-mail.\n"
            . "Ta nazwa jest już zajęta, więc konto nie powstało. Wybierz inną nazwę i spróbuj ponownie:\n\n"
            . "{$link}\n\n"
            . "Jeżeli to nie Ty, zignoruj tę wiadomość — nic się nie stało.\n";
        $this->mailer->send($email, 'Ta nazwa użytkownika jest zajęta', $body);
    }

    /** A sign-up gave an address that already has an account; its owner hears so. */
    private function sendAlreadyRegistered(string $email, string $username): void
    {
        $link = rtrim($this->baseUrl, '/') . '/login/';
        $body = "Cześć {$username},\n\n"
            . "Ktoś próbował założyć nowe konto w bibliotece TryHackX Media z tym adresem e-mail,\n"
            . "ale ten adres należy już do Twojego konta, więc nic nie zostało założone. Zalogować się możesz tutaj:\n\n"
            . "{$link}\n\n"
            . "Jeżeli to nie Ty, zignoruj tę wiadomość — Twoje konto pozostaje bez zmian.\n";
        $this->mailer->send($email, 'Ten adres ma już konto', $body);
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

    /**
     * A cookie that marks this browser as one the account has signed in on.
     *
     * Signed, bound to the account and dated; it proves nothing about who is
     * typing, it only exempts the device from the per-account limit in login().
     * Null when the bridge was given no key.
     */
    public function deviceCookieFor(int $userId): ?string
    {
        if ($this->deviceKey === null || $userId < 1) {
            return null;
        }
        $issued = (string) time();
        $nonce = self::base64Url(random_bytes(16));
        return 'v1.' . $userId . '.' . $issued . '.' . $nonce . '.' . $this->deviceMac($userId, $issued, $nonce);
    }

    /** Digest of a valid device cookie for this account, or null. */
    private function knownDevice(?string $cookie, ?int $userId): ?string
    {
        if ($this->deviceKey === null || $cookie === null || $userId === null
            || preg_match('/\Av1\.([1-9][0-9]{0,18})\.([0-9]{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\z/D', $cookie, $parts) !== 1
            || (int) $parts[1] !== $userId) {
            return null;
        }
        $age = time() - (int) $parts[2];
        if ($age < -300 || $age > self::DEVICE_COOKIE_TTL_SECONDS
            || !hash_equals($this->deviceMac($userId, $parts[2], $parts[3]), $parts[4])) {
            return null;
        }
        return hash('sha256', 'device|' . $parts[3]);
    }

    private function deviceMac(int $userId, string $issued, string $nonce): string
    {
        return self::base64Url(hash_hmac('sha256', "device|v1|{$userId}|{$issued}|{$nonce}", (string) $this->deviceKey, true));
    }

    /** One failed sign-in: always per address, and per account or per device cookie. */
    private function recordLoginFailure(string $client, string $username, string $account, ?string $device): void
    {
        $this->recordAttempt('login', $client, $username, false);
        if ($device === null) {
            $this->recordAttempt('login_account', $client, $account, false);
        } else {
            $this->recordAttempt('login_device', $device, $username, false);
        }
    }

    /**
     * What the per-account limit is kept under.
     *
     * The account itself when the typed name resolves to one. The name column
     * compares without case, accents or trailing spaces, so `ádmin`, `ADMIN`
     * and `admin ` are all the row `admin` — and a key made from the spelling
     * gave each of them twenty guesses of its own at one password. A name that
     * matches no account keeps a counter under its folded spelling, so the
     * answer still does not say whether the account exists.
     */
    private static function accountSubject(string $username, ?int $userId): string
    {
        return $userId !== null
            ? 'user:' . $userId
            : mb_substr(mb_strtolower(trim($username), 'UTF-8'), 0, 191, 'UTF-8');
    }

    /** One password policy for every form that sets one (sign-up, "Moje konto", the panel). */
    public const MAXIMUM_PASSWORD_BYTES = 4096;

    /**
     * Length is measured in bytes, as PHP and the installer measure it. bcrypt
     * itself reads the first 72 bytes only; longer passwords are accepted (and
     * verified the same way), they are just no stronger for it. The ceiling is
     * there so a megabyte of "password" cannot be handed to the hash.
     */
    public static function assertPassword(string $password): void
    {
        if (strlen($password) < self::MINIMUM_PASSWORD_LENGTH) {
            throw new BridgeRequestException('Hasło musi mieć co najmniej ' . self::MINIMUM_PASSWORD_LENGTH . ' znaków.');
        }
        if (strlen($password) > self::MAXIMUM_PASSWORD_BYTES) {
            throw new BridgeRequestException('Hasło może mieć najwyżej ' . self::MAXIMUM_PASSWORD_BYTES . ' bajtów.');
        }
    }

    private static function base64Url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    /**
     * Recent failures of one kind, by client digest or — for the account
     * limit — by the identifier the attempt was recorded under.
     */
    private function recentAttempts(string $kind, string $clientHash, bool $byIdentifier = false): int
    {
        $window = str_starts_with($kind, 'login') ? self::LOGIN_WINDOW_SECONDS : self::REGISTER_WINDOW_SECONDS;
        $column = $byIdentifier ? 'identifier' : 'client_hash';
        $statement = $this->database->prepare(
            "SELECT COUNT(*) FROM auth_attempts
             WHERE kind = :kind AND {$column} = :client AND succeeded = 0
               AND created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :window SECOND)"
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

    /**
     * Second-factor codes and the password checks of the 2FA settings share one
     * limit, per client and per account, as tight as the sign-in itself: six
     * digits are a million guesses, which ten per quarter of an hour make years.
     *
     * @throws BridgeRateLimitException
     */
    public function assertSecondFactorAllowed(string $clientAddress, int $userId): void
    {
        if ($this->recentAttempts('login_2fa', self::clientHash($clientAddress)) >= self::SECOND_FACTOR_LIMIT
            || $this->recentAttempts('login_2fa', 'user:' . $userId, true) >= self::SECOND_FACTOR_LIMIT) {
            throw new BridgeRateLimitException('Zbyt wiele nieudanych prób. Spróbuj ponownie za kwadrans.');
        }
    }

    public function recordSecondFactor(string $clientAddress, int $userId, bool $succeeded): void
    {
        $this->recordAttempt('login_2fa', self::clientHash($clientAddress), 'user:' . $userId, $succeeded);
    }

    /** The account's own password, for changes that need it (2FA on and off); failures count as above. */
    public function verifyPassword(int $userId, string $password, string $clientAddress): bool
    {
        $this->assertSecondFactorAllowed($clientAddress, $userId);
        $statement = $this->database->prepare('SELECT password_hash FROM users WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $userId]);
        $hash = $statement->fetchColumn();
        $valid = is_string($hash) && $password !== '' && password_verify($password, $hash);
        if (!$valid) {
            $this->recordSecondFactor($clientAddress, $userId, false);
        }
        return $valid;
    }

    /**
     * The digest a client is known by everywhere (never the address itself):
     * of the IPv4 address, or of the IPv6 /64 the address belongs to
     * (TrustedProxy::limitKey says why).
     */
    public static function clientHash(string $address): string
    {
        return hash('sha256', 'auth|' . TrustedProxy::limitKey($address));
    }

    /**
     * The digest of a device cookie this installation issued and that is still
     * good, whichever account it is for; null for anything else. For counting a
     * browser before sign-in (StepUpGuard::subjects) — the cookie as it arrives
     * is the visitor's own choice of bytes.
     */
    public function deviceDigest(?string $cookie): ?string
    {
        if ($cookie === null || preg_match('/\Av1\.([1-9][0-9]{0,18})\./', $cookie, $parts) !== 1) {
            return null;
        }
        return $this->knownDevice($cookie, (int) $parts[1]);
    }

    /**
     * Whether a sign-in in "after N failures" mode must first prove a person is there.
     *
     * Failures from this client count; so do failures on the typed account,
     * except from a device that has signed in to it before — the same rule as
     * the per-account limit, so a stranger guessing at the owner's password
     * does not make the owner's own browser solve puzzles.
     */
    public function loginChallengeDue(string $username, string $clientAddress, ?string $deviceCookie, int $threshold): bool
    {
        if ($this->recentAttempts('login', self::clientHash($clientAddress)) >= $threshold) {
            return true;
        }
        $statement = $this->database->prepare('SELECT id FROM users WHERE username = :username LIMIT 1');
        $statement->execute(['username' => $username]);
        $userId = $statement->fetchColumn();
        $resolved = $userId === false ? null : (int) $userId;
        if ($this->knownDevice($deviceCookie, $resolved) !== null) {
            return false;
        }
        return $this->recentAttempts('login_account', self::accountSubject($username, $resolved), true) >= $threshold;
    }

    private static function assertUsername(string $username): void
    {
        if (preg_match(self::USERNAME_PATTERN, $username) !== 1) {
            throw new BridgeRequestException(self::USERNAME_RULE);
        }
    }
}
