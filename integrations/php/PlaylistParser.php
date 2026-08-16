<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

/**
 * Reading an uploaded playlist or ratings file into plain entries.
 *
 * Nothing here touches the database or decides what an entry means — it only
 * turns bytes into a list of "this is what the file said", so that the matching
 * that follows has one shape to work with whether the upload was an M3U, an
 * XSPF or a spreadsheet.
 *
 * Every format is bounded twice, by bytes and by entries. A playlist is a file
 * somebody hands the server, and both a hundred-megabyte upload and a
 * million-line one are ways to make it hurt.
 */
final class PlaylistParser
{
    /** Largest upload accepted, before any of it is parsed. */
    public const MAX_BYTES = 2 * 1024 * 1024;

    /** Most entries read out of one file; the rest is reported, never silently cut. */
    public const MAX_ENTRIES = 5000;

    /** Our own export writes this in front of an item id. */
    private const ITEM_PREFIX = 'tryhackx:item:';

    /**
     * Entries from whatever this file turns out to be.
     *
     * The format is decided by looking at the content rather than at the file
     * name, because a name is whatever the person renamed it to.
     *
     * @return array{kind:string,entries:list<array<string,mixed>>,truncated:bool}
     */
    public static function parse(string $body, string $sourceName = ''): array
    {
        if ($body === '') {
            throw new BridgeRequestException('Plik jest pusty.');
        }
        if (strlen($body) > self::MAX_BYTES) {
            throw new BridgeRequestException('Plik jest zbyt duży (limit 2 MB).');
        }
        // A UTF-8 BOM is what our own CSV export writes for Excel's sake, and
        // left in place it becomes part of the first column's name.
        $body = preg_replace('/^\xEF\xBB\xBF/', '', $body) ?? $body;
        if (!mb_check_encoding($body, 'UTF-8')) {
            // Windows playlists are routinely CP-1250 around here.
            $converted = @mb_convert_encoding($body, 'UTF-8', 'Windows-1250');
            $body = is_string($converted) ? $converted : $body;
        }

        $head = ltrim(substr($body, 0, 400));
        if (str_starts_with($head, '<?xml') || stripos($head, '<playlist') !== false) {
            return self::parseXspf($body);
        }
        if (str_starts_with($head, '{')) {
            return self::parseJsonRatings($body);
        }
        if (self::looksLikeCsv($head)) {
            return self::parseCsvRatings($body);
        }
        return self::parseM3u($body);
    }

    private static function looksLikeCsv(string $head): bool
    {
        $firstLine = strtok($head, "\r\n");
        return is_string($firstLine)
            && str_contains($firstLine, ',')
            && (stripos($firstLine, 'media_item_id') !== false || stripos($firstLine, 'rating') !== false);
    }

    /**
     * M3U, ours or anybody else's.
     *
     * Ours writes `tryhackx:item:9` with a `#TRYHACKX-FINGERPRINT:` comment above
     * it; theirs writes a path. Both are read the same way — a comment carries
     * context for the line that follows, and a non-comment line is an entry.
     *
     * @return array{kind:string,entries:list<array<string,mixed>>,truncated:bool}
     */
    private static function parseM3u(string $body): array
    {
        $entries = [];
        $label = '';
        $fingerprint = null;
        $truncated = false;
        foreach (preg_split('/\r\n|\r|\n/', $body) ?: [] as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            if (str_starts_with($line, '#')) {
                if (stripos($line, '#EXTINF:') === 0) {
                    $comma = strpos($line, ',');
                    $label = $comma === false ? '' : trim(substr($line, $comma + 1));
                } elseif (stripos($line, '#TRYHACKX-FINGERPRINT:') === 0) {
                    $value = strtolower(trim(substr($line, strlen('#TRYHACKX-FINGERPRINT:'))));
                    $fingerprint = preg_match('/^[0-9a-f]{32}$/D', $value) === 1 ? $value : null;
                }
                continue;
            }
            if (count($entries) >= self::MAX_ENTRIES) {
                $truncated = true;
                break;
            }
            $entries[] = self::entry($line, $label, $fingerprint);
            $label = '';
            $fingerprint = null;
        }
        return ['kind' => 'playlist', 'entries' => $entries, 'truncated' => $truncated];
    }

    /**
     * XSPF, parsed as XML.
     *
     * With entity loading off, and not with a regex. An uploaded XML file that
     * the server parses is the textbook place for an external entity to read
     * something off disk, and "it is only a playlist" is exactly what that
     * attack counts on.
     *
     * @return array{kind:string,entries:list<array<string,mixed>>,truncated:bool}
     */
    private static function parseXspf(string $body): array
    {
        $previous = libxml_use_internal_errors(true);
        // LIBXML_NONET refuses every network fetch. Note what is *not* here:
        // LIBXML_NOENT (which would substitute entities, the actual XXE foot-gun)
        // and LIBXML_DTDLOAD. Both are off by default and must stay off — an
        // uploaded XML file the server parses is the textbook place to smuggle
        // an entity that reads a file off disk.
        $document = simplexml_load_string($body, 'SimpleXMLElement', LIBXML_NONET);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        if ($document === false) {
            throw new BridgeRequestException('Nie udało się odczytać pliku XSPF.');
        }

        $entries = [];
        $truncated = false;
        foreach ($document->xpath('//*[local-name()="track"]') ?: [] as $track) {
            if (count($entries) >= self::MAX_ENTRIES) {
                $truncated = true;
                break;
            }
            $child = static function (string $name) use ($track): string {
                $found = $track->xpath('./*[local-name()="' . $name . '"]');
                return is_array($found) && $found !== [] ? trim((string) $found[0]) : '';
            };
            $fingerprint = null;
            foreach ($track->xpath('./*[local-name()="meta"]') ?: [] as $meta) {
                if ((string) ($meta['rel'] ?? '') === 'urn:tryhackx:fingerprint') {
                    $value = strtolower(trim((string) $meta));
                    $fingerprint = preg_match('/^[0-9a-f]{32}$/D', $value) === 1 ? $value : null;
                }
            }
            $reference = $child('identifier') !== '' ? $child('identifier') : $child('location');
            $title = trim($child('creator') . ' - ' . $child('title'), ' -');
            if ($reference === '' && $title === '' && $fingerprint === null) {
                continue;
            }
            $entries[] = self::entry($reference, $title, $fingerprint);
        }
        return ['kind' => 'playlist', 'entries' => $entries, 'truncated' => $truncated];
    }

    /**
     * The ratings CSV, read by header name rather than by column position.
     *
     * Somebody else's export will not put the columns in our order, and reading
     * the fourth field because ours happens to be the artist there is how an
     * import writes a rating of "Depeche Mode".
     *
     * @return array{kind:string,entries:list<array<string,mixed>>,truncated:bool}
     */
    private static function parseCsvRatings(string $body): array
    {
        $handle = fopen('php://temp', 'r+');
        if ($handle === false) {
            throw new BridgeRequestException('Nie udało się odczytać pliku CSV.');
        }
        fwrite($handle, $body);
        rewind($handle);

        // Every argument spelled out, including $escape: PHP 8.4 deprecates
        // relying on the default because it is about to change, and the empty
        // string is the standards-correct value — real CSV has no escape
        // character, so a backslash in a title is a backslash.
        $header = fgetcsv($handle, 0, ',', '"', '');
        if (!is_array($header)) {
            fclose($handle);
            throw new BridgeRequestException('Plik CSV nie ma nagłówka.');
        }
        $column = [];
        foreach ($header as $index => $name) {
            $column[strtolower(trim((string) $name))] = $index;
        }
        $field = static function (array $row, string $name) use ($column): string {
            $index = $column[$name] ?? null;
            return $index === null ? '' : trim((string) ($row[$index] ?? ''));
        };

        $entries = [];
        $truncated = false;
        while (($row = fgetcsv($handle, 0, ',', '"', '')) !== false) {
            if (!is_array($row) || $row === [null]) {
                continue;
            }
            if (count($entries) >= self::MAX_ENTRIES) {
                $truncated = true;
                break;
            }
            $label = trim($field($row, 'artist') . ' - ' . $field($row, 'title'), ' -');
            $entry = self::entry(
                $field($row, 'media_item_id') !== '' ? self::ITEM_PREFIX . $field($row, 'media_item_id') : '',
                $label !== '' ? $label : $field($row, 'title'),
                self::cleanFingerprint($field($row, 'fingerprint'))
            );
            $entry['rating'] = self::cleanRating($field($row, 'rating'));
            $entry['favorite'] = in_array(strtolower($field($row, 'favorite')), ['1', 'true', 'yes', 'tak'], true);
            if ($entry['rating'] === null && !$entry['favorite']) {
                continue;
            }
            $entries[] = $entry;
        }
        fclose($handle);
        return ['kind' => 'ratings', 'entries' => $entries, 'truncated' => $truncated];
    }

    /**
     * Our own ratings JSON, recognised by the name it writes into itself.
     *
     * @return array{kind:string,entries:list<array<string,mixed>>,truncated:bool}
     */
    private static function parseJsonRatings(string $body): array
    {
        try {
            $document = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new BridgeRequestException('Nie udało się odczytać pliku JSON.');
        }
        if (!is_array($document) || ($document['format'] ?? '') !== 'tryhackx-media-ratings') {
            throw new BridgeRequestException('To nie jest plik ocen z tego serwera.');
        }
        $entries = [];
        $truncated = false;
        foreach ((array) ($document['entries'] ?? []) as $row) {
            if (!is_array($row)) {
                continue;
            }
            if (count($entries) >= self::MAX_ENTRIES) {
                $truncated = true;
                break;
            }
            $label = trim(((string) ($row['artist'] ?? '')) . ' - ' . ((string) ($row['title'] ?? '')), ' -');
            $entry = self::entry(
                isset($row['media_item_id']) ? self::ITEM_PREFIX . (int) $row['media_item_id'] : '',
                $label,
                self::cleanFingerprint((string) ($row['fingerprint'] ?? ''))
            );
            $entry['rating'] = $row['rating'] === null ? null : self::cleanRating((string) $row['rating']);
            $entry['favorite'] = ($row['favorite'] ?? false) === true;
            if ($entry['rating'] === null && !$entry['favorite']) {
                continue;
            }
            $entries[] = $entry;
        }
        return ['kind' => 'ratings', 'entries' => $entries, 'truncated' => $truncated];
    }

    /**
     * One entry, reduced to the three things matching can use.
     *
     * `file_name` is the last segment of whatever the reference was, because a
     * foreign playlist's path is useless as a path here — the library it points
     * into is somebody else's — and the name is the only part that travels.
     *
     * @return array<string, mixed>
     */
    private static function entry(string $reference, string $label, ?string $fingerprint): array
    {
        $reference = trim($reference);
        $itemId = null;
        if (stripos($reference, self::ITEM_PREFIX) === 0) {
            $digits = substr($reference, strlen(self::ITEM_PREFIX));
            $itemId = ctype_digit($digits) ? (int) $digits : null;
        }
        $fileName = '';
        if ($itemId === null && $reference !== '') {
            $normalised = str_replace('\\', '/', $reference);
            $normalised = explode('?', $normalised)[0];
            $fileName = rawurldecode((string) substr(strrchr('/' . $normalised, '/') ?: '', 1));
        }
        return [
            'label' => mb_substr($label !== '' ? $label : ($fileName !== '' ? $fileName : $reference), 0, 512),
            'item_id' => $itemId,
            'file_name' => $fileName,
            'fingerprint' => $fingerprint,
            'rating' => null,
            'favorite' => false,
        ];
    }

    private static function cleanFingerprint(string $value): ?string
    {
        $value = strtolower(trim($value));
        return preg_match('/^[0-9a-f]{32}$/D', $value) === 1 ? $value : null;
    }

    /** A rating between 0.5 and 5, rounded to the half stars the interface uses. */
    private static function cleanRating(string $value): ?float
    {
        $value = str_replace(',', '.', trim($value));
        if ($value === '' || !is_numeric($value)) {
            return null;
        }
        $rating = round(((float) $value) * 2) / 2;
        if ($rating < 0.5 || $rating > 5.0) {
            return null;
        }
        return $rating;
    }
}
