<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use InvalidArgumentException;
use RuntimeException;

final class TransferToken
{
    private const AAD = 'tryhackx-media-transfer:v1';
    private const MAX_TTL = 900;
    private const MAX_TOKEN_BYTES = 65536;

    /**
     * @param array<int, array{root:string,path:string,archive_name?:string}> $items
     */
    public static function archive(
        string $encodedKey,
        array $items,
        string $downloadName = 'media.zip',
        int $ttlSeconds = 300,
        ?string $subject = null,
        int $maxDownloads = 0
    ): string {
        if ($items === []) {
            throw new InvalidArgumentException('Archiwum wymaga co najmniej jednego pliku.');
        }
        foreach ($items as $item) {
            self::assertItem($item);
        }
        $now = time();

        $payload = [
            'v' => 1,
            'aud' => 'transfer',
            'kind' => 'archive',
            'iat' => $now,
            'exp' => $now + self::ttl($ttlSeconds),
            'name' => self::cleanText($downloadName, 512),
            'disposition' => 'attachment',
            'items' => array_values($items),
            'sub' => $subject,
        ];
        self::applyDownloadCap($payload, $maxDownloads);

        return self::seal($encodedKey, $payload);
    }

    public static function file(
        string $encodedKey,
        string $root,
        string $relativePath,
        string $downloadName,
        bool $inline = false,
        int $ttlSeconds = 300,
        ?string $subject = null,
        int $maxStreams = 0,
        int $maxDownloads = 0
    ): string {
        $item = ['root' => $root, 'path' => $relativePath];
        self::assertItem($item);
        if ($maxStreams < 0 || $maxStreams > 10000) {
            throw new InvalidArgumentException('Limit strumieni musi mieścić się w zakresie 0..10000.');
        }
        $now = time();

        $payload = [
            'v' => 1,
            'aud' => 'transfer',
            'kind' => 'file',
            'iat' => $now,
            'exp' => $now + self::ttl($ttlSeconds),
            'name' => self::cleanText($downloadName, 512),
            'disposition' => $inline ? 'inline' : 'attachment',
            'items' => [$item],
            'sub' => $subject,
        ];
        if ($maxStreams > 0) {
            // Sealed into the grant so the transfer service enforces the cap
            // without needing its own view of accounts and groups.
            $payload['max_streams'] = $maxStreams;
        }
        if (!$inline) {
            self::applyDownloadCap($payload, $maxDownloads);
        }

        return self::seal($encodedKey, $payload);
    }

    /**
     * Cap on simultaneous downloads (attachment files and archives) per subject;
     * like max_streams it travels inside the grant. Zero leaves it unlimited.
     *
     * @param array<string, mixed> $payload
     */
    private static function applyDownloadCap(array &$payload, int $maxDownloads): void
    {
        if ($maxDownloads < 0 || $maxDownloads > 10000) {
            throw new InvalidArgumentException('Limit równoczesnych pobrań musi mieścić się w zakresie 0..10000.');
        }
        if ($maxDownloads > 0) {
            $payload['max_downloads'] = $maxDownloads;
        }
    }

    /** @param array<string, mixed> $payload */
    private static function seal(string $encodedKey, array $payload): string
    {
        if ($payload['sub'] === null) {
            unset($payload['sub']);
        } else {
            $payload['sub'] = self::cleanText((string) $payload['sub'], 191);
        }
        $key = self::base64UrlDecode($encodedKey);
        if (strlen($key) !== 32) {
            throw new InvalidArgumentException('Klucz transferowy musi mieć 32 bajty.');
        }
        $plaintext = json_encode(
            $payload,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        );
        $nonce = random_bytes(12);
        $tag = '';
        $ciphertext = openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            $key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            self::AAD,
            16
        );
        if ($ciphertext === false || strlen($tag) !== 16) {
            throw new RuntimeException('Nie udało się utworzyć tokenu transferowego.');
        }
        $token = 'v1.' . self::base64UrlEncode($nonce . $ciphertext . $tag);
        if (strlen($token) > self::MAX_TOKEN_BYTES) {
            throw new InvalidArgumentException('Token jest zbyt duży; zmniejsz liczbę plików.');
        }
        return $token;
    }

    /** @param array<string, mixed> $item */
    private static function assertItem(array $item): void
    {
        self::cleanText((string) ($item['root'] ?? ''), 32);
        self::cleanText((string) ($item['path'] ?? ''), 4096);
        if (isset($item['archive_name'])) {
            self::cleanText((string) $item['archive_name'], 1024);
        }
    }

    private static function cleanText(string $value, int $maximum): string
    {
        if ($value === '' || strlen($value) > $maximum || strpbrk($value, "\0\r\n") !== false) {
            throw new InvalidArgumentException('Niepoprawna wartość tokenu.');
        }
        return $value;
    }

    private static function ttl(int $ttl): int
    {
        if ($ttl < 1 || $ttl > self::MAX_TTL) {
            throw new InvalidArgumentException('TTL tokenu musi mieścić się w zakresie 1..900 sekund.');
        }
        return $ttl;
    }

    private static function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $value): string
    {
        $decoded = base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4), true);
        if ($decoded === false) {
            throw new InvalidArgumentException('Niepoprawny klucz base64url.');
        }
        return $decoded;
    }
}
