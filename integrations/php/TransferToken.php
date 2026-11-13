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
     * What a grant is for; the transfer service serves each route only for its
     * own purpose (src/media_server/security.py, PURPOSES):
     * `download` — an attachment (files, archives); `play` — the file inline for
     * the player; `thumb` — a preview picture; `compat` — compatibility mode
     * (transcoding, track probing, subtitles). Before this, any playback grant —
     * a thumbnail's, a guest link's — also opened transcoding.
     */
    public const PURPOSE_DOWNLOAD = 'download';
    public const PURPOSE_PLAY = 'play';
    public const PURPOSE_THUMB = 'thumb';
    public const PURPOSE_COMPAT = 'compat';

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
            'purpose' => self::PURPOSE_DOWNLOAD,
            'items' => array_values($items),
            'sub' => $subject,
        ];
        self::applyDownloadCap($payload, $maxDownloads);

        return self::seal($encodedKey, $payload);
    }

    /**
     * An archive whose file list waits in `archive_manifests` instead of riding
     * in the token (migration 042).
     *
     * The token names the stored list — its key, the SHA-256 of the exact bytes
     * stored and how many entries it holds — and the transfer service builds
     * the archive from that row only if all three agree. The token stays a few
     * hundred bytes whatever the archive holds; a list of paths sealed inline
     * stopped fitting under MAX_TOKEN_BYTES at about 270 files.
     */
    public static function archiveManifest(
        string $encodedKey,
        string $manifestId,
        string $manifestSha256,
        int $count,
        string $downloadName = 'media.zip',
        int $ttlSeconds = 300,
        ?string $subject = null,
        int $maxDownloads = 0
    ): string {
        if (preg_match('/\A[0-9a-f]{64}\z/D', $manifestId) !== 1
            || preg_match('/\A[0-9a-f]{64}\z/D', $manifestSha256) !== 1
            || $count < 1 || $count > 10000) {
            throw new InvalidArgumentException('Niepoprawna lista plików archiwum.');
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
            'purpose' => self::PURPOSE_DOWNLOAD,
            'manifest' => ['id' => $manifestId, 'sha256' => $manifestSha256, 'count' => $count],
            'sub' => $subject,
        ];
        self::applyDownloadCap($payload, $maxDownloads);

        return self::seal($encodedKey, $payload);
    }

    /**
     * Whether an archive entry passes the same checks the token applies to it,
     * so a caller can leave out the one file that would sink the whole archive.
     *
     * @param array<string, mixed> $item
     */
    public static function sealableItem(array $item): bool
    {
        try {
            self::assertItem($item);
            return true;
        } catch (InvalidArgumentException) {
            return false;
        }
    }

    /**
     * One file. `$purpose` defaults to `play` inline and is always `download` as
     * an attachment; `thumb` and `compat` must be asked for by name, and only
     * `compat` may carry a stream cap.
     */
    public static function file(
        string $encodedKey,
        string $root,
        string $relativePath,
        string $downloadName,
        bool $inline = false,
        int $ttlSeconds = 300,
        ?string $subject = null,
        int $maxStreams = 0,
        int $maxDownloads = 0,
        ?string $purpose = null
    ): string {
        $item = ['root' => $root, 'path' => $relativePath];
        self::assertItem($item);
        if ($maxStreams < 0 || $maxStreams > 10000) {
            throw new InvalidArgumentException('Limit strumieni musi mieścić się w zakresie 0..10000.');
        }
        $purpose ??= $inline ? self::PURPOSE_PLAY : self::PURPOSE_DOWNLOAD;
        $inlinePurposes = [self::PURPOSE_PLAY, self::PURPOSE_THUMB, self::PURPOSE_COMPAT];
        if ($inline ? !in_array($purpose, $inlinePurposes, true) : $purpose !== self::PURPOSE_DOWNLOAD) {
            throw new InvalidArgumentException('Cel tokenu nie pasuje do sposobu wydania pliku.');
        }
        if ($maxStreams > 0 && $purpose !== self::PURPOSE_COMPAT) {
            // Only the compatibility routes enforce it; anywhere else the cap
            // would read as a limit while limiting nothing.
            throw new InvalidArgumentException('Limit strumieni dotyczy wyłącznie trybu zgodnego.');
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
            'purpose' => $purpose,
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
