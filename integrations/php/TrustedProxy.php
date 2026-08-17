<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

/**
 * Who the request is really from, when something sits in front of us.
 *
 * Behind a reverse proxy `REMOTE_ADDR` is the proxy, so every visitor arrives
 * wearing the same address — and the two things that count by address, login
 * throttling and CAPTCHA, stop distinguishing anybody. The fix is not to trust
 * `X-Forwarded-For`: that header is written by the client and can say anything.
 * It is to trust it **only** when the peer that delivered it is one we named,
 * and then to walk it from the right, skipping hops that are also ours, until
 * the first address nobody vouches for. That one is the visitor.
 *
 * Trust is exact addresses, not ranges. One proxy in front of a home server is
 * one or two addresses, and range matching in both IP families is a lot of
 * arithmetic to get subtly wrong for a list that never grows.
 *
 * With no proxy configured — the default — this returns `REMOTE_ADDR` and the
 * header is never read at all.
 */
final class TrustedProxy
{
    /**
     * Parse the configured list: addresses separated by commas or whitespace.
     * The shared TOML parser rejects arrays on purpose, so a list is a string.
     *
     * @return list<string> normalised addresses, invalid entries dropped
     */
    public static function parseList(mixed $configured): array
    {
        if (!is_string($configured) || trim($configured) === '') {
            return [];
        }
        $parsed = [];
        foreach (preg_split('/[\s,]+/', trim($configured)) ?: [] as $entry) {
            $packed = self::normalise($entry);
            if ($packed !== null && !in_array($packed, $parsed, true)) {
                $parsed[] = $packed;
            }
        }

        return $parsed;
    }

    /**
     * @param list<string> $trusted packed addresses from parseList()
     */
    public static function clientAddress(string $remoteAddress, ?string $forwardedFor, array $trusted): string
    {
        if ($trusted === []) {
            return $remoteAddress;
        }
        $peer = self::normalise($remoteAddress);
        if ($peer === null || !in_array($peer, $trusted, true)) {
            // The request did not come through a proxy we know, so whatever the
            // header says about earlier hops is the client's own claim.
            return $remoteAddress;
        }

        $hops = preg_split('/\s*,\s*/', trim((string) $forwardedFor)) ?: [];
        for ($index = count($hops) - 1; $index >= 0; $index--) {
            $packed = self::normalise($hops[$index]);
            if ($packed === null) {
                // A hop we cannot read means the chain stops being evidence;
                // everything to its left could have been invented.
                break;
            }
            if (!in_array($packed, $trusted, true)) {
                return self::present($hops[$index]);
            }
        }

        return $remoteAddress;
    }

    /**
     * Was the request HTTPS before it reached us?
     *
     * A proxy that terminates TLS speaks plain HTTP to the origin, so
     * `$_SERVER['HTTPS']` is unset here even though the visitor is on HTTPS.
     * Taken at face value that means two wrong answers at once: the bridge
     * rejects every request as insecure, and the session cookie loses its
     * `Secure` attribute — a cookie promised to HTTPS handed out over plain
     * HTTP. As with the address, the header counts only when the peer that
     * delivered it is one we named; otherwise the visitor could claim their
     * own plaintext connection is secure.
     *
     * @param list<string> $trusted packed addresses from parseList()
     */
    public static function isHttps(
        string $remoteAddress,
        bool $directlyHttps,
        ?string $forwardedProto,
        array $trusted
    ): bool {
        if ($directlyHttps) {
            return true;
        }
        if ($trusted === []) {
            return false;
        }
        $peer = self::normalise($remoteAddress);
        if ($peer === null || !in_array($peer, $trusted, true)) {
            return false;
        }
        // A chain of proxies may append; the first entry is what the visitor spoke.
        $first = preg_split('/\s*,\s*/', trim((string) $forwardedProto))[0] ?? '';

        return strtolower(trim($first)) === 'https';
    }

    /** Packed form, so ::1 and 0:0:0:0:0:0:0:1 are the same address. */
    private static function normalise(string $address): ?string
    {
        $cleaned = self::present($address);
        if ($cleaned === '') {
            return null;
        }
        $packed = @inet_pton($cleaned);

        return $packed === false ? null : $packed;
    }

    /** Strip what proxies add around an address: spaces, quotes, [brackets]. */
    private static function present(string $address): string
    {
        $cleaned = trim($address, " \t\n\r\0\x0B\"'");
        if (str_starts_with($cleaned, '[')) {
            $end = strpos($cleaned, ']');
            if ($end !== false) {
                return substr($cleaned, 1, $end - 1);
            }
        }

        return $cleaned;
    }
}
