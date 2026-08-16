<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

final class LegacyIdentity
{
    private const ROLES = ['user', 'admin', 'super_admin'];

    public function __construct(
        public readonly int $userId,
        public readonly string $username,
        public readonly string $role,
        public readonly bool $isGuest
    ) {
        if ($this->userId < 1) {
            throw new BridgeAuthenticationException('Nieprawidłowa sesja.');
        }
        self::assertUsername($this->username);
        if (!in_array($this->role, self::ROLES, true)) {
            throw new BridgeAuthenticationException('Nieprawidłowa sesja.');
        }
    }

    /** @param array<string, mixed> $session */
    public static function fromLegacySession(array $session): self
    {
        if (($session['logged_in'] ?? null) !== true) {
            throw new BridgeAuthenticationException('Wymagane jest logowanie.');
        }

        $userId = self::positiveInteger($session['user_id'] ?? null);
        $username = $session['username'] ?? null;
        if (!is_string($username)) {
            throw new BridgeAuthenticationException('Nieprawidłowa sesja.');
        }
        self::assertUsername($username);

        $role = self::flag($session['is_super_admin'] ?? false)
            ? 'super_admin'
            : (self::flag($session['is_admin'] ?? false) ? 'admin' : 'user');

        return new self($userId, $username, $role, self::flag($session['is_guest'] ?? false));
    }

    /** @param array<string, mixed> $row */
    public static function fromDatabaseRow(array $row): self
    {
        $userId = self::positiveInteger($row['id'] ?? null);
        $username = $row['username'] ?? null;
        $role = $row['role'] ?? null;
        if (!is_string($username) || !is_string($role)) {
            throw new BridgeAuthenticationException('Nieprawidłowy rekord użytkownika.');
        }

        return new self($userId, $username, $role, self::flag($row['is_guest'] ?? false));
    }

    public function subject(): string
    {
        return (string) $this->userId;
    }

    /** @return array{id:int,username:string,role:string,is_guest:bool} */
    public function publicProfile(): array
    {
        return [
            'id' => $this->userId,
            'username' => $this->username,
            'role' => $this->role,
            'is_guest' => $this->isGuest,
        ];
    }

    private static function positiveInteger(mixed $value): int
    {
        if (is_int($value) && $value > 0) {
            return $value;
        }
        if (is_string($value) && preg_match('/\A[1-9][0-9]*\z/D', $value) === 1) {
            $parsed = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if (is_int($parsed)) {
                return $parsed;
            }
        }
        throw new BridgeAuthenticationException('Nieprawidłowa sesja.');
    }

    private static function assertUsername(string $username): void
    {
        if (
            $username === ''
            || strlen($username) > 191
            || preg_match('//u', $username) !== 1
            || preg_match('/[\x00-\x1F\x7F]/u', $username) === 1
        ) {
            throw new BridgeAuthenticationException('Nieprawidłowa sesja.');
        }
    }

    private static function flag(mixed $value): bool
    {
        return $value === true || $value === 1 || $value === '1';
    }
}

