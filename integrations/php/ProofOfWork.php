<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;
use PDOException;

/**
 * Our own challenge: a proof of work the browser solves, nobody else involved.
 *
 * The scheme is ALTCHA's. The server picks a secret number below `maxnumber`
 * and publishes `challenge = SHA-256(salt . number)` together with an HMAC of
 * that challenge; the page tries numbers until the digest matches and sends the
 * number back. Finding it costs the page, on average, half of `maxnumber`
 * digests; checking it costs the server one. The expiry sits inside the salt,
 * so it is covered by the challenge and the HMAC and cannot be moved.
 *
 * What it buys is cost, not identity: a script pays it too, only faster. That
 * is why this is the provider the step-up ladder uses inside the application
 * (no third-party script is allowed there by the CSP) and the fallback on the
 * sign-in page when no third-party provider is configured, and why a solved
 * challenge is accepted exactly once — spent challenges are kept until they
 * expire, so one solution cannot be replayed into many passes.
 *
 * Times are unix seconds from PHP's clock on both ends (issue and check),
 * which no time zone can reinterpret.
 */
final class ProofOfWork
{
    public const ALGORITHM = 'SHA-256';
    public const DEFAULT_MAX_NUMBER = 200000;
    public const MIN_MAX_NUMBER = 1000;
    public const MAX_MAX_NUMBER = 10000000;
    /** How long a challenge may take to be solved and used. */
    public const TTL_SECONDS = 600;

    /** @var \Closure(): int */
    private readonly \Closure $clock;

    /**
     * @param string $key raw HMAC key, derived for this purpose only
     * @param (\Closure(): int)|null $clock unix seconds; injectable for tests
     */
    public function __construct(
        private readonly PDO $database,
        private readonly string $key,
        private readonly int $maxNumber = self::DEFAULT_MAX_NUMBER,
        ?\Closure $clock = null
    ) {
        $this->clock = $clock ?? static fn (): int => time();
    }

    public static function clampMaxNumber(mixed $value): int
    {
        $number = is_numeric($value) ? (int) $value : self::DEFAULT_MAX_NUMBER;
        return max(self::MIN_MAX_NUMBER, min(self::MAX_MAX_NUMBER, $number));
    }

    /**
     * A fresh challenge for the page.
     *
     * @return array{algorithm:string,challenge:string,salt:string,maxnumber:int,signature:string}
     */
    public function challenge(): array
    {
        $expires = ($this->clock)() + self::TTL_SECONDS;
        // Ends in a separator, so no digit can move between the expiry and the number.
        $salt = bin2hex(random_bytes(12)) . '.' . $expires . '.';
        $challenge = hash('sha256', $salt . random_int(0, $this->maxNumber));
        return [
            'algorithm' => self::ALGORITHM,
            'challenge' => $challenge,
            'salt' => $salt,
            'maxnumber' => $this->maxNumber,
            'signature' => hash_hmac('sha256', $challenge, $this->key),
        ];
    }

    /**
     * Check a solution and spend it.
     *
     * The payload is what the page sends: base64 of a JSON object carrying the
     * challenge's fields and the number found. True once per challenge — a
     * second presentation of the same solution is a replay and answers false.
     */
    public function verify(string $payload): bool
    {
        if ($payload === '' || strlen($payload) > 2048) {
            return false;
        }
        $json = base64_decode($payload, true);
        $decoded = is_string($json) ? json_decode($json, true) : null;
        if (!is_array($decoded)) {
            return false;
        }
        $challenge = $decoded['challenge'] ?? null;
        $salt = $decoded['salt'] ?? null;
        $signature = $decoded['signature'] ?? null;
        $number = $decoded['number'] ?? null;
        if (($decoded['algorithm'] ?? null) !== self::ALGORITHM
            || !is_string($challenge) || preg_match('/\A[0-9a-f]{64}\z/D', $challenge) !== 1
            || !is_string($signature) || preg_match('/\A[0-9a-f]{64}\z/D', $signature) !== 1
            || !is_string($salt) || preg_match('/\A[0-9a-f]{24}\.([0-9]{1,12})\.\z/D', $salt, $parts) !== 1
            || !is_int($number) || $number < 0 || $number > self::MAX_MAX_NUMBER) {
            return false;
        }
        $now = ($this->clock)();
        $expires = (int) $parts[1];
        // Expired, or dated further ahead than this server ever issues.
        if ($expires < $now || $expires > $now + self::TTL_SECONDS + 60) {
            return false;
        }
        if (!hash_equals(hash_hmac('sha256', $challenge, $this->key), $signature)
            || !hash_equals($challenge, hash('sha256', $salt . $number))) {
            return false;
        }
        return $this->spend($challenge, $expires, $now);
    }

    /** Record the challenge as used; false when it already was. */
    private function spend(string $challenge, int $expires, int $now): bool
    {
        try {
            $this->database->prepare('INSERT INTO captcha_spent (challenge, expires_at) VALUES (:challenge, :expires)')
                ->execute(['challenge' => $challenge, 'expires' => $expires]);
        } catch (PDOException $error) {
            // Integrity constraint: the primary key says it was spent already.
            if (str_starts_with((string) $error->getCode(), '23')) {
                return false;
            }
            throw $error;
        }
        if (random_int(1, 50) === 1) {
            $this->database->prepare('DELETE FROM captcha_spent WHERE expires_at < :now')->execute(['now' => $now]);
        }
        return true;
    }
}
