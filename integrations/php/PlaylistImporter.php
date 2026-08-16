<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

/**
 * Turning a parsed upload into catalogue entries a person has agreed to.
 *
 * Nothing an upload says reaches user_collection_items or user_ratings on its
 * own. It lands in playlist_imports first, matched as far as it can be matched,
 * and what could not be settled waits with its candidates until somebody picks
 * one. That is the same rule the genre lookup follows and for the same reason:
 * a wrong pick here is silent — the playlist simply plays the wrong recording,
 * and nothing on screen ever explains why.
 *
 * Three ways an entry finds its item, tried in this order because that is the
 * order of how much they prove:
 *
 *   1. **fingerprint** — the file itself. Works between installations and is
 *      the only one that does. Several items sharing one fingerprint means the
 *      same file is filed twice, which is an answer, not an ambiguity.
 *   2. **item id** — our own export coming home. Checked against the catalogue
 *      rather than trusted, because an id in an uploaded file is a number a
 *      stranger typed.
 *   3. **file name** — somebody else's playlist. One hit is a match, several
 *      are a question, none is a miss.
 */
final class PlaylistImporter
{
    /** Candidates offered per ambiguous entry; more than this is not a choice, it is a list. */
    private const MAX_CANDIDATES = 8;

    public function __construct(private readonly PDO $database, private readonly CatalogActions $actions)
    {
    }

    /**
     * Read an upload, match what it names, and park it for review.
     *
     * @return array<string, mixed>
     */
    public function start(LegacyIdentity $identity, string $body, string $sourceName, string $mediaKind): array
    {
        $mediaKind = in_array($mediaKind, ['music', 'movies'], true) ? $mediaKind : 'music';
        $this->actions->assertLibraryAccess($identity, $mediaKind);

        $parsed = PlaylistParser::parse($body, $sourceName);
        if ($parsed['entries'] === []) {
            throw new BridgeRequestException('W pliku nie ma żadnych pozycji.');
        }
        if ($parsed['kind'] === 'playlist') {
            // Only a playlist needs this; importing your own ratings is an
            // ordinary thing an account does to its own rows.
            $this->actions->assertCanCreateCollections($identity);
        }
        $resolved = $this->match($parsed['entries'], $mediaKind);

        $matched = 0;
        foreach ($resolved as $entry) {
            if ($entry['state'] === 'matched') {
                $matched++;
            }
        }

        $this->database->beginTransaction();
        try {
            $insert = $this->database->prepare(
                'INSERT INTO playlist_imports
                   (user_id, kind, source_name, media_kind, collection_name, total_entries, matched_entries)
                 VALUES (:user_id, :kind, :source_name, :media_kind, :collection_name, :total, :matched)'
            );
            $insert->execute([
                'user_id' => $identity->userId,
                'kind' => $parsed['kind'],
                'source_name' => mb_substr($sourceName, 0, 255),
                'media_kind' => $mediaKind,
                'collection_name' => $parsed['kind'] === 'playlist' ? self::collectionName($sourceName) : null,
                'total' => count($resolved),
                'matched' => $matched,
            ]);
            $importId = (int) $this->database->lastInsertId();

            $entryInsert = $this->database->prepare(
                'INSERT INTO playlist_import_entries
                   (import_id, position, raw_label, raw_fingerprint, media_item_id, matched_by, state,
                    candidates_json, rating, favorite)
                 VALUES (:import_id, :position, :raw_label, :raw_fingerprint, :media_item_id, :matched_by, :state,
                         :candidates_json, :rating, :favorite)'
            );
            foreach ($resolved as $position => $entry) {
                $entryInsert->execute([
                    'import_id' => $importId,
                    'position' => $position,
                    'raw_label' => mb_substr((string) $entry['label'], 0, 512),
                    'raw_fingerprint' => $entry['fingerprint'],
                    'media_item_id' => $entry['media_item_id'],
                    'matched_by' => $entry['matched_by'],
                    'state' => $entry['state'],
                    'candidates_json' => $entry['candidates'] === []
                        ? null
                        : json_encode($entry['candidates'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
                    'rating' => $entry['rating'],
                    'favorite' => $entry['favorite'] ? 1 : 0,
                ]);
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }

        return ['import_id' => $importId, 'truncated' => $parsed['truncated']] + $this->status($identity, $importId);
    }

    /**
     * Match every parsed entry against the catalogue.
     *
     * The file-name lookup is one query for the whole upload rather than one per
     * entry: matching by name means comparing the last path segment, which no
     * index can help with, so it is paid once for five thousand entries instead
     * of five thousand times.
     *
     * @param list<array<string, mixed>> $entries
     * @return list<array<string, mixed>>
     */
    private function match(array $entries, string $mediaKind): array
    {
        $byFingerprint = $this->itemsByFingerprint(
            array_values(array_filter(array_map(static fn (array $e): ?string => $e['fingerprint'], $entries)))
        );
        $byName = $this->itemsByFileName(
            array_values(array_filter(array_map(static fn (array $e): string => (string) $e['file_name'], $entries))),
            $mediaKind
        );
        $ids = $this->existingIds(
            array_values(array_filter(array_map(static fn (array $e): ?int => $e['item_id'], $entries))),
            $mediaKind
        );

        $resolved = [];
        foreach ($entries as $entry) {
            $state = 'missing';
            $itemId = null;
            $matchedBy = null;
            $candidates = [];

            $fingerprint = $entry['fingerprint'];
            $name = mb_strtolower((string) $entry['file_name']);
            if ($fingerprint !== null && isset($byFingerprint[$fingerprint])) {
                // Several rows here means one file catalogued twice — the same
                // answer, not a question. Take the first and move on.
                $itemId = $byFingerprint[$fingerprint][0]['id'];
                $state = 'matched';
                $matchedBy = 'fingerprint';
            } elseif ($entry['item_id'] !== null && isset($ids[$entry['item_id']])) {
                $itemId = $entry['item_id'];
                $state = 'matched';
                $matchedBy = 'item_id';
            } elseif ($name !== '' && isset($byName[$name])) {
                $hits = $byName[$name];
                if (count($hits) === 1) {
                    $itemId = $hits[0]['id'];
                    $state = 'matched';
                    $matchedBy = 'file_name';
                } else {
                    // The case this whole table exists for.
                    $state = 'ambiguous';
                    $candidates = array_slice($hits, 0, self::MAX_CANDIDATES);
                }
            }

            $resolved[] = [
                'label' => $entry['label'],
                'fingerprint' => $fingerprint,
                'media_item_id' => $itemId,
                'matched_by' => $matchedBy,
                'state' => $state,
                'candidates' => $candidates,
                'rating' => $entry['rating'],
                'favorite' => (bool) $entry['favorite'],
            ];
        }
        return $resolved;
    }

    /**
     * @param list<string> $fingerprints
     * @return array<string, list<array<string, mixed>>>
     */
    private function itemsByFingerprint(array $fingerprints): array
    {
        $fingerprints = array_values(array_unique($fingerprints));
        if ($fingerprints === []) {
            return [];
        }
        $found = [];
        foreach (array_chunk($fingerprints, 500) as $chunk) {
            $placeholders = implode(', ', array_fill(0, count($chunk), '?'));
            $statement = $this->database->prepare(
                "SELECT mi.id, mi.content_fingerprint, COALESCE(mo.title, mi.title, '') AS title,
                        COALESCE(mo.artist, mi.artist, '') AS artist, mi.relative_path
                 FROM media_items mi
                 LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                 WHERE mi.deleted_at IS NULL AND mi.content_fingerprint IN ({$placeholders})
                 ORDER BY mi.id"
            );
            $statement->execute($chunk);
            foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $found[(string) $row['content_fingerprint']][] = self::candidate($row);
            }
        }
        return $found;
    }

    /**
     * @param list<string> $names
     * @return array<string, list<array<string, mixed>>>
     */
    private function itemsByFileName(array $names, string $mediaKind): array
    {
        $wanted = [];
        foreach ($names as $name) {
            $wanted[mb_strtolower($name)] = true;
        }
        if ($wanted === []) {
            return [];
        }
        // One pass over the library. Comparing the last path segment cannot use
        // an index, so it is done once and the result grouped in PHP.
        $statement = $this->database->prepare(
            "SELECT mi.id, mi.relative_path, COALESCE(mo.title, mi.title, '') AS title,
                    COALESCE(mo.artist, mi.artist, '') AS artist
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             WHERE mi.deleted_at IS NULL
               AND mi.media_kind = :media_kind
               AND mr.media_kind IN (:root_kind, 'mixed')
             ORDER BY mi.id"
        );
        $statement->bindValue(':media_kind', $mediaKind === 'music' ? 'audio' : 'video', PDO::PARAM_STR);
        $statement->bindValue(':root_kind', $mediaKind, PDO::PARAM_STR);
        $statement->execute();

        $found = [];
        while (($row = $statement->fetch(PDO::FETCH_ASSOC)) !== false) {
            $path = str_replace('\\', '/', (string) $row['relative_path']);
            $position = strrpos($path, '/');
            $fileName = mb_strtolower($position === false ? $path : substr($path, $position + 1));
            if (isset($wanted[$fileName])) {
                $found[$fileName][] = self::candidate($row);
            }
        }
        return $found;
    }

    /**
     * @param list<int> $ids
     * @return array<int, true>
     */
    private function existingIds(array $ids, string $mediaKind): array
    {
        $ids = array_values(array_unique(array_filter($ids, static fn (int $id): bool => $id > 0)));
        if ($ids === []) {
            return [];
        }
        $found = [];
        foreach (array_chunk($ids, 1000) as $chunk) {
            $placeholders = implode(', ', array_fill(0, count($chunk), '?'));
            $statement = $this->database->prepare(
                "SELECT mi.id FROM media_items mi
                 INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                 WHERE mi.deleted_at IS NULL AND mi.media_kind = ?
                   AND mr.media_kind IN (?, 'mixed')
                   AND mi.id IN ({$placeholders})"
            );
            $statement->execute([$mediaKind === 'music' ? 'audio' : 'video', $mediaKind, ...$chunk]);
            foreach ($statement->fetchAll(PDO::FETCH_COLUMN) as $id) {
                $found[(int) $id] = true;
            }
        }
        return $found;
    }

    /** @param array<string, mixed> $row */
    private static function candidate(array $row): array
    {
        // The folder, not the full path: enough for a person to tell two files
        // with the same name apart, without printing the library's layout.
        $path = str_replace('\\', '/', (string) ($row['relative_path'] ?? ''));
        $position = strrpos($path, '/');
        return [
            'id' => (int) $row['id'],
            'title' => (string) $row['title'],
            'artist' => (string) $row['artist'],
            'folder' => $position === false ? '' : mb_substr(substr($path, 0, $position), -80),
        ];
    }

    /**
     * What the review screen shows for one import.
     *
     * @return array<string, mixed>
     */
    public function status(LegacyIdentity $identity, int $importId): array
    {
        $import = $this->ownImport($identity, $importId);
        $statement = $this->database->prepare(
            'SELECT id, position, raw_label, media_item_id, matched_by, state, candidates_json, rating, favorite
             FROM playlist_import_entries
             WHERE import_id = :import_id
             ORDER BY FIELD(state, "ambiguous", "missing", "matched", "skipped"), position
             LIMIT 500'
        );
        $statement->execute(['import_id' => $importId]);
        $entries = array_map(
            static function (array $row): array {
                $candidates = $row['candidates_json'] === null
                    ? []
                    : (json_decode((string) $row['candidates_json'], true) ?: []);
                return [
                    'id' => (int) $row['id'],
                    'position' => (int) $row['position'],
                    'label' => (string) $row['raw_label'],
                    'media_item_id' => $row['media_item_id'] === null ? null : (int) $row['media_item_id'],
                    'matched_by' => $row['matched_by'],
                    'state' => (string) $row['state'],
                    'candidates' => is_array($candidates) ? $candidates : [],
                    'rating' => $row['rating'] === null ? null : (float) $row['rating'],
                    'favorite' => (int) $row['favorite'] === 1,
                ];
            },
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );

        $counts = ['matched' => 0, 'ambiguous' => 0, 'missing' => 0, 'skipped' => 0];
        $totals = $this->database->prepare(
            'SELECT state, COUNT(*) AS entries FROM playlist_import_entries WHERE import_id = :import_id GROUP BY state'
        );
        $totals->execute(['import_id' => $importId]);
        foreach ($totals->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $counts[(string) $row['state']] = (int) $row['entries'];
        }

        return [
            'id' => (int) $import['id'],
            'kind' => (string) $import['kind'],
            'media_kind' => (string) $import['media_kind'],
            'source_name' => (string) $import['source_name'],
            'collection_name' => $import['collection_name'],
            'status' => (string) $import['status'],
            'total_entries' => (int) $import['total_entries'],
            'counts' => $counts,
            'entries' => $entries,
        ];
    }

    /**
     * Settle one entry by hand: take a candidate, or leave it out.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function resolve(LegacyIdentity $identity, array $payload): array
    {
        $entryId = filter_var($payload['entry_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($entryId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator pozycji.');
        }
        $statement = $this->database->prepare(
            'SELECT e.id, e.import_id, e.candidates_json, i.user_id, i.status
             FROM playlist_import_entries e
             INNER JOIN playlist_imports i ON i.id = e.import_id
             WHERE e.id = :entry_id LIMIT 1'
        );
        $statement->execute(['entry_id' => $entryId]);
        $entry = $statement->fetch(PDO::FETCH_ASSOC);
        if ($entry === false || (int) $entry['user_id'] !== $identity->userId) {
            throw new BridgeRequestException('Nie znaleziono takiej pozycji.');
        }
        if ((string) $entry['status'] !== 'review') {
            throw new BridgeRequestException('Ten import został już zamknięty.');
        }

        if (($payload['decision'] ?? 'choose') === 'skip') {
            $this->database
                ->prepare("UPDATE playlist_import_entries SET state = 'skipped', media_item_id = NULL WHERE id = :id")
                ->execute(['id' => $entryId]);
            return ['success' => true, 'state' => 'skipped'];
        }

        $chosen = filter_var($payload['media_item_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $candidates = $entry['candidates_json'] === null
            ? []
            : (json_decode((string) $entry['candidates_json'], true) ?: []);
        $allowed = [];
        foreach (is_array($candidates) ? $candidates : [] as $candidate) {
            if (is_array($candidate) && isset($candidate['id'])) {
                $allowed[(int) $candidate['id']] = true;
            }
        }
        // Only one of the candidates the server itself offered. Accepting any id
        // the client sends would let an upload reach a file it never named.
        if (!is_int($chosen) || !isset($allowed[$chosen])) {
            throw new BridgeRequestException('Ta pozycja nie była wśród propozycji.');
        }
        $this->database
            ->prepare("UPDATE playlist_import_entries
                       SET state = 'matched', media_item_id = :item_id, matched_by = 'manual'
                       WHERE id = :id")
            ->execute(['item_id' => $chosen, 'id' => $entryId]);
        return ['success' => true, 'state' => 'matched'];
    }

    /**
     * Write what was agreed: a new playlist, or this account's ratings.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function apply(LegacyIdentity $identity, int $importId, array $payload): array
    {
        $import = $this->ownImport($identity, $importId);
        if ((string) $import['status'] !== 'review') {
            throw new BridgeRequestException('Ten import został już zamknięty.');
        }
        $statement = $this->database->prepare(
            "SELECT media_item_id, rating, favorite FROM playlist_import_entries
             WHERE import_id = :import_id AND state = 'matched' AND media_item_id IS NOT NULL
             ORDER BY position"
        );
        $statement->execute(['import_id' => $importId]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) {
            throw new BridgeRequestException('Nie ma czego zapisać — żadna pozycja nie została dopasowana.');
        }

        if ((string) $import['kind'] === 'ratings') {
            $written = $this->applyRatings($identity, $rows);
            $this->closeImport($importId, null);
            return ['success' => true, 'kind' => 'ratings', 'written' => $written];
        }

        $name = self::optionalName($payload['name'] ?? null) ?? (string) ($import['collection_name'] ?? 'Import');
        $collectionId = $this->applyPlaylist($identity, $name, (string) $import['media_kind'], $rows);
        $this->closeImport($importId, $collectionId);
        return ['success' => true, 'kind' => 'playlist', 'collection_id' => $collectionId, 'written' => count($rows)];
    }

    /** @param list<array<string, mixed>> $rows */
    private function applyRatings(LegacyIdentity $identity, array $rows): int
    {
        // This account's ratings and nobody else's. Writing an imported file
        // onto another account would be a way to speak in their name, which is
        // not a setting anybody should be able to turn on.
        $statement = $this->database->prepare(
            'INSERT INTO user_ratings (user_id, media_item_id, rating, favorite)
             VALUES (:user_id, :item_id, :rating, :favorite)
             ON DUPLICATE KEY UPDATE rating = VALUES(rating), favorite = VALUES(favorite)'
        );
        $written = 0;
        $this->database->beginTransaction();
        try {
            foreach ($rows as $row) {
                $statement->execute([
                    'user_id' => $identity->userId,
                    'item_id' => (int) $row['media_item_id'],
                    'rating' => $row['rating'] === null ? null : (float) $row['rating'],
                    'favorite' => (int) $row['favorite'] === 1 ? 1 : 0,
                ]);
                $written++;
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return $written;
    }

    /** @param list<array<string, mixed>> $rows */
    private function applyPlaylist(LegacyIdentity $identity, string $name, string $mediaKind, array $rows): int
    {
        // A hand-arranged list, never a smart one: a smart list's contents are
        // computed from a rule, so there would be nowhere to put these.
        $created = $this->actions->createCollection($identity, [
            'name' => $name,
            'description' => '',
            'media_kind' => $mediaKind,
            'rules' => null,
        ]);
        $collectionId = (int) ($created['id'] ?? 0);
        if ($collectionId < 1) {
            throw new BridgeRequestException('Nie udało się utworzyć playlisty.');
        }
        $insert = $this->database->prepare(
            'INSERT IGNORE INTO user_collection_items (collection_id, media_item_id, position)
             VALUES (:collection_id, :item_id, :position)'
        );
        $this->database->beginTransaction();
        try {
            foreach (array_values($rows) as $position => $row) {
                $insert->execute([
                    'collection_id' => $collectionId,
                    'item_id' => (int) $row['media_item_id'],
                    'position' => $position,
                ]);
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return $collectionId;
    }

    /** Throw the whole thing away without writing anything. */
    public function discard(LegacyIdentity $identity, int $importId): array
    {
        $this->ownImport($identity, $importId);
        $this->database
            ->prepare("UPDATE playlist_imports SET status = 'discarded' WHERE id = :id")
            ->execute(['id' => $importId]);
        return ['success' => true];
    }

    /**
     * Imports this account still has open.
     *
     * @return list<array<string, mixed>>
     */
    public function pending(LegacyIdentity $identity): array
    {
        $statement = $this->database->prepare(
            "SELECT id, kind, source_name, media_kind, total_entries, matched_entries, created_at
             FROM playlist_imports
             WHERE user_id = :user_id AND status = 'review'
             ORDER BY id DESC LIMIT 20"
        );
        $statement->execute(['user_id' => $identity->userId]);
        return array_map(
            static fn (array $row): array => [
                'id' => (int) $row['id'],
                'kind' => (string) $row['kind'],
                'source_name' => (string) $row['source_name'],
                'media_kind' => (string) $row['media_kind'],
                'total_entries' => (int) $row['total_entries'],
                'matched_entries' => (int) $row['matched_entries'],
                'created_at' => (string) $row['created_at'],
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /** @return array<string, mixed> */
    private function ownImport(LegacyIdentity $identity, int $importId): array
    {
        $statement = $this->database->prepare('SELECT * FROM playlist_imports WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $importId]);
        $import = $statement->fetch(PDO::FETCH_ASSOC);
        // An import belongs to whoever uploaded it. Not an administrator's
        // business either: it holds their ratings.
        if ($import === false || (int) $import['user_id'] !== $identity->userId) {
            throw new BridgeRequestException('Nie znaleziono takiego importu.');
        }
        return $import;
    }

    private function closeImport(int $importId, ?int $collectionId): void
    {
        $this->database
            ->prepare("UPDATE playlist_imports SET status = 'applied', collection_id = :collection_id WHERE id = :id")
            ->execute(['collection_id' => $collectionId, 'id' => $importId]);
    }

    private static function optionalName(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $name = trim(preg_replace('/\s+/u', ' ', $value) ?? '');
        return $name === '' ? null : mb_substr($name, 0, 191);
    }

    /** A playlist name taken from the uploaded file's name, minus its extension. */
    private static function collectionName(string $sourceName): string
    {
        $base = preg_replace('/\.[A-Za-z0-9]{1,5}$/D', '', $sourceName) ?? $sourceName;
        $base = trim(preg_replace('/[^\p{L}\p{N} _-]+/u', ' ', $base) ?? '');
        $base = trim((string) preg_replace('/\s+/u', ' ', $base));
        return $base === '' ? 'Import' : mb_substr($base, 0, 191);
    }
}
