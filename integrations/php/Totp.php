<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

/**
 * Time-based one-time passwords, RFC 6238 with the parameters every
 * authenticator app assumes: HMAC-SHA1, 30-second steps, 6 digits.
 *
 * Pure functions only; where the secret lives and which step was last used is
 * TwoFactor's business. verify() accepts one step either side of now for clock
 * drift — any wider and a code somebody saw stays good for minutes — and never
 * a step at or before the last one accepted, so a code cannot be used twice.
 */
final class Totp
{
    public const PERIOD = 30;
    public const DIGITS = 6;
    public const WINDOW = 1;
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** 160 random bits, the size RFC 4226 recommends for SHA-1, as base32. */
    public static function generateSecret(): string
    {
        return self::base32Encode(random_bytes(20));
    }

    public static function base32Encode(string $binary): string
    {
        $bits = '';
        foreach (str_split($binary) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0'))];
        }
        return $out;
    }

    /** Null when the text is not base32 (spaces, dashes, case and padding are forgiven). */
    public static function base32Decode(string $text): ?string
    {
        $clean = strtoupper(str_replace([' ', '-', '='], '', $text));
        if ($clean === '' || strspn($clean, self::ALPHABET) !== strlen($clean)) {
            return null;
        }
        $bits = '';
        foreach (str_split($clean) as $char) {
            $bits .= str_pad(decbin(strpos(self::ALPHABET, $char)), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $chunk) {
            if (strlen($chunk) === 8) {
                $out .= chr(bindec($chunk));
            }
        }
        return $out;
    }

    /** RFC 4226 HOTP: the dynamically truncated HMAC-SHA1 of the counter. */
    public static function hotp(string $key, int $counter, int $digits = self::DIGITS): string
    {
        $hash = hash_hmac('sha1', pack('J', $counter), $key, true);
        $offset = ord($hash[19]) & 0x0f;
        $value = ((ord($hash[$offset]) & 0x7f) << 24)
            | (ord($hash[$offset + 1]) << 16)
            | (ord($hash[$offset + 2]) << 8)
            | ord($hash[$offset + 3]);
        return str_pad((string) ($value % (10 ** $digits)), $digits, '0', STR_PAD_LEFT);
    }

    public static function step(int $time): int
    {
        return intdiv($time, self::PERIOD);
    }

    public static function codeAt(string $secret, int $time, int $digits = self::DIGITS): string
    {
        $key = self::base32Decode($secret);
        if ($key === null) {
            throw new \InvalidArgumentException('Invalid base32 secret.');
        }
        return self::hotp($key, self::step($time), $digits);
    }

    /**
     * The step the code belongs to, or null when it matches none that may still be used.
     *
     * Steps are tried newest first, so a code valid for two steps (impossible
     * in practice) resolves to the later one and leaves nothing to replay.
     */
    public static function verify(string $secret, string $code, int $time, ?int $lastStep = null): ?int
    {
        $code = preg_replace('/\s+/', '', $code) ?? '';
        if (preg_match('/\A[0-9]{' . self::DIGITS . '}\z/D', $code) !== 1) {
            return null;
        }
        $key = self::base32Decode($secret);
        if ($key === null) {
            return null;
        }
        $now = self::step($time);
        $found = null;
        for ($offset = self::WINDOW; $offset >= -self::WINDOW; $offset--) {
            $step = $now + $offset;
            if ($step < 0 || ($lastStep !== null && $step <= $lastStep)) {
                continue;
            }
            // Every candidate is computed and compared, whatever matched first.
            if (hash_equals(self::hotp($key, $step), $code) && $found === null) {
                $found = $step;
            }
        }
        return $found;
    }

    /** The otpauth:// address an authenticator app reads from the QR code (or a tap on a phone). */
    public static function uri(string $issuer, string $account, string $secret): string
    {
        $label = rawurlencode($issuer) . ':' . rawurlencode($account);
        return 'otpauth://totp/' . $label . '?' . http_build_query([
            'secret' => $secret,
            'issuer' => $issuer,
            'algorithm' => 'SHA1',
            'digits' => self::DIGITS,
            'period' => self::PERIOD,
        ], '', '&', PHP_QUERY_RFC3986);
    }
}
