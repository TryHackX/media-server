<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;
use PDOStatement;

require_once __DIR__ . '/PermissionGroups.php';
require_once __DIR__ . '/AccountGateway.php';

final class CatalogActions
{
    /**
     * Every visualiser the server knows, in running order.
     *
     * Must match defaultVisualizerOrder in
     * frontend/src/shared/visualizations/registry.ts. This list used to be
     * written out twice — once to validate a save and once to read settings back
     * — and the reader silently discarded any stored value containing an
     * identifier it did not recognise. A newly added plugin was therefore saved
     * correctly and then dropped on the way out, so it never reached the client.
     */
    private const VISUALIZER_IDS = [
        'snow-spectrum', 'poweramp', 'solar-flare', 'flow-field',
        'warp-tunnel', 'kaleidoscope',
        'ring-warp', 'orbit-analyzer', 'glitch-spectrum', 'prism-tunnel',
        'chromatic-cathedral', 'quantum-ribbon', 'milkdrop-pulse', 'neon-metropolis',
        // Kept from the set that used to be unreachable from the panel; the rest
        // were withdrawn. Existing installs get them disabled (visualizer_enabled
        // keeps only what was stored), so the operator opts in.
        'particle-spectrum', 'vortex',
    ];

    /** Library listing orders accepted as defaults and by the browser (mirrors LibraryBrowser). */
    public const LIBRARY_SORTS = [
        'title_asc', 'title_desc', 'plays_desc', 'rating_desc', 'rating_count_desc',
        'size_desc', 'duration_desc', 'duration_asc', 'random',
    ];

    /**
     * Orders a playlist (collection) can be read in.
     *
     * These are item orders, not folder orders: a playlist has no folders, so the
     * library's 'random (folders)' and 'size' have no meaning here. 'position' is
     * the order the owner arranged manually; on a rule-based list, where there is
     * no manual order, it reads as title ascending. 'random' needs a seed, so the
     * order stays stable while paging.
     */
    public const COLLECTION_SORTS = [
        'position', 'title_asc', 'title_desc', 'own_rating_desc',
        'rating_desc', 'plays_desc', 'added_desc', 'random',
    ];

    /** How many tracks a playlist card may draw its fallback cover from. */
    private const PREVIEW_CANDIDATES = 16;

    /** How long the audit trail is kept; older entries are pruned as new ones arrive. */
    private const AUDIT_RETENTION_DAYS = 365;

    /** @var array<string, bool> Per-request cache: table name -> exists. */
    private array $featureTableCache = [];

    /** @var array<string, bool|int|string>|null Per-request effective permissions of the caller. */
    private ?array $effectivePermissions = null;

    public function __construct(private readonly PDO $database)
    {
    }

    /**
     * Half a star to five, or null for "no opinion".
     *
     * The same scale everywhere a rating is given — a track, and now a playlist —
     * so the rule lives in one place instead of being restated per action.
     */
    private static function ratingValue(mixed $value): ?float
    {
        if ($value === null) {
            return null;
        }
        if (!is_int($value) && !is_float($value)) {
            throw new BridgeRequestException('Nieprawidłowa ocena.');
        }
        $rating = (float) $value;
        if ($rating < 0.5 || $rating > 5 || abs($rating * 2 - round($rating * 2)) > 0.0001) {
            throw new BridgeRequestException('Ocena musi mieścić się w zakresie 0.5–5 co pół gwiazdki.');
        }
        return $rating;
    }

    /** @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function rate(LegacyIdentity $identity, array $payload): array
    {
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        $hasRating = array_key_exists('rating', $payload);
        $hasFavorite = array_key_exists('favorite', $payload);
        if ($hasRating) {
            $this->assertPermission($identity, 'can_rate');
        }
        if ($hasFavorite) {
            $this->assertPermission($identity, 'can_favorite');
        }
        if (!$hasRating && !$hasFavorite) {
            throw new BridgeRequestException('Brak oceny lub ulubionego.');
        }
        $rating = $hasRating ? self::ratingValue($payload['rating']) : null;
        $favorite = $hasFavorite ? $payload['favorite'] : null;
        if ($hasFavorite && !is_bool($favorite)) {
            throw new BridgeRequestException('Nieprawidłowa wartość ulubionego.');
        }
        $this->assertItem($itemId);

        $this->database->beginTransaction();
        try {
            $statement = $this->database->prepare(
                'SELECT rating, favorite FROM user_ratings
                 WHERE user_id = :user_id AND media_item_id = :item_id FOR UPDATE'
            );
            $statement->execute(['user_id' => $identity->userId, 'item_id' => $itemId]);
            $existing = $statement->fetch(PDO::FETCH_ASSOC) ?: ['rating' => null, 'favorite' => 0];
            $nextRating = $hasRating ? $rating : ($existing['rating'] === null ? null : (float) $existing['rating']);
            $nextFavorite = $hasFavorite ? (int) $favorite : (int) $existing['favorite'];
            $statement = $this->database->prepare(
                'INSERT INTO user_ratings (user_id, media_item_id, rating, favorite)
                 VALUES (:user_id, :item_id, :rating, :favorite)
                 ON DUPLICATE KEY UPDATE rating = VALUES(rating), favorite = VALUES(favorite)'
            );
            $statement->execute([
                'user_id' => $identity->userId,
                'item_id' => $itemId,
                'rating' => $nextRating,
                'favorite' => $nextFavorite,
            ]);
            $this->audit($identity->userId, 'media.rating', 'media_item', (string) $itemId, [
                'rating' => $nextRating,
                'favorite' => (bool) $nextFavorite,
            ]);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return $this->ratingSummary($identity->userId, $itemId);
    }

    /** @param array<string, mixed> $payload */
    public function playback(LegacyIdentity $identity, array $payload): array
    {
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        $event = $payload['event'] ?? null;
        $position = $payload['position_ms'] ?? 0;
        if (!is_string($event) || !in_array($event, ['start', 'progress', 'complete'], true)) {
            throw new BridgeRequestException('Nieprawidłowe zdarzenie odtwarzania.');
        }
        if (!is_int($position) || $position < 0 || $position > 31_536_000_000) {
            throw new BridgeRequestException('Nieprawidłowa pozycja odtwarzania.');
        }
        $this->assertItem($itemId);
        if ($identity->isGuest) {
            return ['success' => true];
        }

        $increment = $event === 'start' ? 1 : 0;
        $storedPosition = $event === 'complete' ? 0 : $position;
        $this->database->beginTransaction();
        try {
            // A 'start' clears an earlier dismissal: hiding a film from the shelf
            // says "not now", and sitting down to watch it again answers that.
            // Progress alone must not, or an accidental click would undo the choice.
            $statement = $this->database->prepare(
                'INSERT INTO playback_stats (user_id, media_item_id, play_count, last_position_ms, last_played_at)
                 VALUES (:user_id, :item_id, :increment, :position, CURRENT_TIMESTAMP(6))
                 ON DUPLICATE KEY UPDATE
                   play_count = play_count + VALUES(play_count),
                   last_position_ms = VALUES(last_position_ms),
                   last_played_at = IF(VALUES(play_count) > 0, CURRENT_TIMESTAMP(6), last_played_at),
                   continue_hidden_at = IF(VALUES(play_count) > 0, NULL, continue_hidden_at)'
            );
            $statement->execute([
                'user_id' => $identity->userId,
                'item_id' => $itemId,
                'increment' => $increment,
                'position' => $storedPosition,
            ]);
            if ($increment === 1) {
                $statement = $this->database->prepare(
                    'INSERT INTO media_play_totals (media_item_id, play_count, last_played_at)
                     VALUES (:item_id, 1, CURRENT_TIMESTAMP(6))
                     ON DUPLICATE KEY UPDATE play_count = play_count + 1, last_played_at = CURRENT_TIMESTAMP(6)'
                );
                $statement->execute(['item_id' => $itemId]);
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return ['success' => true];
    }

    /**
     * Take one title off the "continue" shelf without touching its history.
     *
     * "I am done with this" and "I never played this" are different statements.
     * Deleting the playback row would erase the play count and the date as well,
     * so the row stays and only stops being offered; playing the file again
     * clears the flag (see playback()).
     *
     * @param array<string, mixed> $payload
     * @return array{success:true,hidden:bool}
     */
    public function dismissContinue(LegacyIdentity $identity, array $payload): array
    {
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        $hidden = $payload['hidden'] ?? true;
        if (!is_bool($hidden)) {
            throw new BridgeRequestException('Nieprawidłowa wartość ukrycia.');
        }
        $this->assertItem($itemId);
        if ($identity->isGuest) {
            // A guest keeps no history, so there is nothing to hide.
            return ['success' => true, 'hidden' => false];
        }
        $statement = $this->database->prepare(
            'UPDATE playback_stats
                SET continue_hidden_at = ' . ($hidden ? 'CURRENT_TIMESTAMP(6)' : 'NULL') . '
              WHERE user_id = :user_id AND media_item_id = :item_id'
        );
        $statement->execute(['user_id' => $identity->userId, 'item_id' => $itemId]);
        return ['success' => true, 'hidden' => $hidden];
    }

    /**
     * Every device of this account and what it was playing.
     *
     * The listing is what makes "hand playback over" possible at all: until the
     * queue was on the server, one browser could not know another existed. Rows
     * are returned newest first and the caller's own device is marked rather
     * than removed, so a client can tell "my queue" from "the other room"
     * without matching identifiers itself.
     *
     * @return array<int, array<string, mixed>>
     */
    public function playbackQueues(LegacyIdentity $identity, string $deviceId = ''): array
    {
        if ($identity->isGuest || !$this->featureTableExists('playback_queues')) {
            return [];
        }
        $statement = $this->database->prepare(
            'SELECT pq.device_id, pq.device_label, pq.source_json, pq.queue_offset, pq.queue_total,
                    pq.media_item_id, pq.position_ms, pq.is_playing, pq.repeat_mode, pq.context,
                    pq.updated_at,
                    COALESCE(mo.title, mi.title) AS track_title,
                    COALESCE(mo.artist, mi.artist) AS track_artist,
                    mi.duration_ms AS track_duration_ms
               FROM playback_queues pq
               LEFT JOIN media_items mi ON mi.id = pq.media_item_id AND mi.deleted_at IS NULL
               LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
              WHERE pq.user_id = :user_id
              ORDER BY pq.updated_at DESC
              LIMIT 12'
        );
        $statement->execute(['user_id' => $identity->userId]);
        return array_map(
            static fn (array $row): array => self::publicPlaybackQueue($row, $deviceId),
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Store what this device is playing, and answer whether it was taken over.
     *
     * The answer is the whole handover mechanism: a playing device saves every
     * few seconds anyway, so it learns from its own next save that another
     * device claimed the queue, and pauses. Reading the mark clears it — one
     * handover, one pause.
     *
     * @param array<string, mixed> $payload
     * @return array{success:true,yielded_to:string|null}
     */
    public function savePlaybackQueue(LegacyIdentity $identity, array $payload): array
    {
        $this->assertFeatureTable('playback_queues');
        $deviceId = self::deviceIdentifier($payload['device_id'] ?? null);
        if ($identity->isGuest) {
            // A guest is not an account anybody hands playback to.
            return ['success' => true, 'yielded_to' => null];
        }
        $itemId = $payload['media_item_id'] ?? null;
        $itemId = $itemId === null ? null : self::positiveId($itemId);
        $source = self::queueSourcePayload($payload['source'] ?? null);
        $row = [
            'user_id' => $identity->userId,
            'device_id' => $deviceId,
            'device_label' => self::optionalText($payload['device_label'] ?? null, 64) ?? '',
            'source_json' => $source === null ? null : json_encode($source, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
            'queue_offset' => self::boundedNumber($payload['offset'] ?? 0, 0, 100000000, true),
            'queue_total' => self::boundedNumber($payload['total'] ?? 0, 0, 100000000, true),
            'media_item_id' => $itemId,
            'position_ms' => self::boundedNumber($payload['position_ms'] ?? 0, 0, 31536000000, true),
            'is_playing' => ($payload['is_playing'] ?? false) === true ? 1 : 0,
            'repeat_mode' => self::enumValue($payload['repeat'] ?? 'off', ['off', 'once', 'one', 'all']),
            'context' => self::optionalText($payload['context'] ?? null, 191) ?? '',
        ];
        // A track that has since been removed from the catalogue must not take
        // the whole save down with a foreign key error.
        if ($itemId !== null) {
            $exists = $this->database->prepare('SELECT 1 FROM media_items WHERE id = :id LIMIT 1');
            $exists->execute(['id' => $itemId]);
            if ($exists->fetchColumn() === false) {
                $row['media_item_id'] = null;
            }
        }
        $this->database->beginTransaction();
        try {
            $claim = $this->database->prepare(
                'SELECT yielded_to FROM playback_queues
                  WHERE user_id = :user_id AND device_id = :device_id FOR UPDATE'
            );
            $claim->execute(['user_id' => $identity->userId, 'device_id' => $deviceId]);
            $stored = $claim->fetch(PDO::FETCH_ASSOC);
            $yieldedTo = is_array($stored) && $stored['yielded_to'] !== null ? (string) $stored['yielded_to'] : null;
            $statement = $this->database->prepare(
                'INSERT INTO playback_queues
                    (user_id, device_id, device_label, source_json, queue_offset, queue_total,
                     media_item_id, position_ms, is_playing, repeat_mode, context, yielded_to)
                 VALUES
                    (:user_id, :device_id, :device_label, :source_json, :queue_offset, :queue_total,
                     :media_item_id, :position_ms, :is_playing, :repeat_mode, :context, NULL)
                 ON DUPLICATE KEY UPDATE
                    device_label = VALUES(device_label), source_json = VALUES(source_json),
                    queue_offset = VALUES(queue_offset), queue_total = VALUES(queue_total),
                    media_item_id = VALUES(media_item_id), position_ms = VALUES(position_ms),
                    is_playing = VALUES(is_playing), repeat_mode = VALUES(repeat_mode),
                    context = VALUES(context), yielded_to = NULL'
            );
            $statement->execute($row);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        // Rows nobody has touched for a month describe a browser that is not
        // coming back. Pruned the way audit_log is, without a scheduled job.
        if (random_int(1, 100) === 1) {
            $this->database->exec(
                'DELETE FROM playback_queues WHERE updated_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 30 DAY)'
            );
        }
        return ['success' => true, 'yielded_to' => $yieldedTo];
    }

    /**
     * Take another device's queue over.
     *
     * The state comes back from the same statement that marks the other device,
     * so what gets rebuilt here is what was stored at the moment of the claim —
     * not whatever the listing said a minute ago. Claiming a device's own queue
     * is refused: a device cannot hand anything to itself, and letting it would
     * stamp a pause on the only player that is running.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function claimPlaybackQueue(LegacyIdentity $identity, array $payload): array
    {
        $this->assertFeatureTable('playback_queues');
        $deviceId = self::deviceIdentifier($payload['device_id'] ?? null);
        $from = self::deviceIdentifier($payload['from_device_id'] ?? null);
        if ($identity->isGuest || $deviceId === $from) {
            throw new BridgeRequestException('Nie można przejąć własnej kolejki.');
        }
        $label = self::optionalText($payload['device_label'] ?? null, 64) ?? '';
        $this->database->beginTransaction();
        try {
            $statement = $this->database->prepare(
                'SELECT device_id, device_label, source_json, queue_offset, queue_total, media_item_id,
                        position_ms, is_playing, repeat_mode, context, updated_at
                   FROM playback_queues
                  WHERE user_id = :user_id AND device_id = :device_id FOR UPDATE'
            );
            $statement->execute(['user_id' => $identity->userId, 'device_id' => $from]);
            $row = $statement->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new CatalogItemNotFoundException('To urządzenie nie ma już kolejki.');
            }
            $mark = $this->database->prepare(
                'UPDATE playback_queues SET yielded_to = :label, is_playing = 0
                  WHERE user_id = :user_id AND device_id = :device_id'
            );
            $mark->execute([
                'label' => $label === '' ? 'inne urządzenie' : $label,
                'user_id' => $identity->userId,
                'device_id' => $from,
            ]);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return ['queue' => self::publicPlaybackQueue($row, $deviceId)];
    }

    /** A device names itself; the server only insists it is a short, plain token. */
    private static function deviceIdentifier(mixed $value): string
    {
        if (!is_string($value) || preg_match('/^[A-Za-z0-9_-]{8,64}$/D', $value) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator urządzenia.');
        }
        return $value;
    }

    /**
     * The client's description of its queue, filtered key by key.
     *
     * Kept as one JSON column because the server never reasons about it — but
     * "never reasons about it" is not "accepts anything": every key is known
     * here, so what lands in the column is a shape this code chose.
     *
     * @return array<string, mixed>|null
     */
    private static function queueSourcePayload(mixed $value): ?array
    {
        if (!is_array($value)) {
            return null;
        }
        $kind = self::enumValue($value['kind'] ?? '', ['directory', 'collection']);
        $source = [
            'kind' => $kind,
            'id' => self::positiveId($value['id'] ?? null),
            'query' => self::optionalText($value['query'] ?? null, 200) ?? '',
            'shuffleMode' => self::enumValue($value['shuffleMode'] ?? 'off', ['off', 'current', 'all', 'folders', 'mixed']),
            'shuffleSeed' => self::optionalText($value['shuffleSeed'] ?? null, 64) ?? '',
        ];
        if ($kind === 'collection') {
            $source['collectionSort'] = self::enumValue(
                $value['collectionSort'] ?? 'position',
                self::COLLECTION_SORTS
            );
            $source['queueRating'] = self::queueRatingMode($value['queueRating'] ?? null);
            $source['queueFavorite'] = self::queueFavoriteMode($value['queueFavorite'] ?? null);
            $owner = self::optionalText($value['ownerName'] ?? null, 191);
            if ($owner !== null) {
                $source['ownerName'] = $owner;
            }
        }
        return $source;
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function publicPlaybackQueue(array $row, string $deviceId): array
    {
        $source = $row['source_json'] === null
            ? null
            : json_decode((string) $row['source_json'], true, 8, JSON_THROW_ON_ERROR);
        return [
            'device_id' => (string) $row['device_id'],
            'device_label' => (string) ($row['device_label'] ?? ''),
            'is_current' => (string) $row['device_id'] === $deviceId,
            'source' => is_array($source) ? $source : null,
            'offset' => (int) $row['queue_offset'],
            'total' => (int) $row['queue_total'],
            'media_item_id' => $row['media_item_id'] === null ? null : (int) $row['media_item_id'],
            'position_ms' => (int) $row['position_ms'],
            'is_playing' => (int) $row['is_playing'] === 1,
            'repeat' => (string) ($row['repeat_mode'] ?? 'off'),
            'context' => (string) ($row['context'] ?? ''),
            'updated_at' => (string) $row['updated_at'],
            'track' => array_key_exists('track_title', $row) && $row['track_title'] !== null
                ? [
                    'title' => (string) $row['track_title'],
                    'artist' => $row['track_artist'] === null ? null : (string) $row['track_artist'],
                    'duration_ms' => (int) ($row['track_duration_ms'] ?? 0),
                ]
                : null,
        ];
    }

    /**
     * Sessions that are open right now.
     *
     * "Open" is measured, not assumed: a PHP session dies of inactivity, so a
     * row is only listed while it has been seen inside that lifetime. Without
     * that, the panel would show a browser somebody closed last week and offer
     * to sign it out.
     *
     * An administrator sees every account's sessions, anybody else sees their
     * own — the same rule the activity log follows. The identifier the client
     * gets back is the session's fingerprint, never the session itself; it is
     * what "close this one" refers to.
     *
     * @return array<int, array<string, mixed>>
     */
    public function activeSessions(
        LegacyIdentity $identity,
        ?int $userId = null,
        string $currentFingerprint = '',
        int $lifetimeSeconds = 1440
    ): array {
        if (!$this->featureTableExists('user_sessions')) {
            return [];
        }
        $isAdmin = in_array($identity->role, ['admin', 'super_admin'], true) && !$identity->isGuest;
        $subject = $isAdmin ? $userId : $identity->userId;
        $lifetime = max(300, min(30 * 24 * 3600, $lifetimeSeconds));
        $sql =
            'SELECT LOWER(HEX(us.session_hash)) AS fingerprint, us.user_id, u.username,
                    us.device_label, us.created_at, us.last_seen_at
               FROM user_sessions us
               INNER JOIN users u ON u.id = us.user_id
              WHERE us.revoked_at IS NULL
                AND us.last_seen_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :lifetime SECOND)';
        $params = ['lifetime' => $lifetime];
        if ($subject !== null) {
            $sql .= ' AND us.user_id = :subject';
            $params['subject'] = $subject;
        }
        $sql .= ' ORDER BY us.last_seen_at DESC LIMIT 100';
        $statement = $this->database->prepare($sql);
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, PDO::PARAM_INT);
        }
        $statement->execute();
        return array_map(static fn (array $row): array => [
            'fingerprint' => (string) $row['fingerprint'],
            'user_id' => (int) $row['user_id'],
            'username' => (string) $row['username'],
            'device_label' => (string) ($row['device_label'] ?? ''),
            'is_current' => $currentFingerprint !== '' && hash_equals($currentFingerprint, (string) $row['fingerprint']),
            'created_at' => (string) $row['created_at'],
            'last_seen_at' => (string) $row['last_seen_at'],
        ], $statement->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Close one session, or every session but the one asking.
     *
     * Takes effect on the closed session's next request — the bridge checks the
     * row on every authenticated call. There is no way to reach into another
     * browser and end it sooner, and the alternative (keeping session
     * identifiers so they could be deleted directly) would be a far worse trade
     * than a few seconds' delay.
     *
     * An administrator may close anybody's session; anybody else may close their
     * own. Signing another account out is the kind of thing that should leave a
     * trace, so it is audited either way.
     *
     * @param array<string, mixed> $payload
     * @return array{success:true,closed:int}
     */
    public function revokeSessions(LegacyIdentity $identity, array $payload): array
    {
        $this->assertFeatureTable('user_sessions');
        $fingerprint = self::optionalText($payload['fingerprint'] ?? null, 64);
        $keep = self::optionalText($payload['keep_fingerprint'] ?? null, 64);
        $all = ($payload['others'] ?? false) === true;
        if (($fingerprint === null && !$all) || ($fingerprint !== null && $all)) {
            throw new BridgeRequestException('Wskaż jedną sesję albo poproś o pozostałe.');
        }
        foreach ([$fingerprint, $keep] as $value) {
            if ($value !== null && preg_match('/^[0-9a-f]{64}$/D', $value) !== 1) {
                throw new BridgeRequestException('Nieprawidłowy identyfikator sesji.');
            }
        }
        $isAdmin = in_array($identity->role, ['admin', 'super_admin'], true) && !$identity->isGuest;
        $sql = 'UPDATE user_sessions
                   SET revoked_at = CURRENT_TIMESTAMP(6), revoked_by = :actor
                 WHERE revoked_at IS NULL';
        $params = ['actor' => $identity->userId];
        if ($fingerprint !== null) {
            $sql .= ' AND session_hash = UNHEX(:fingerprint)';
            $params['fingerprint'] = $fingerprint;
        } else {
            // "Everywhere else" is about one account — the caller's own, or the
            // one an administrator named.
            $subject = $isAdmin && isset($payload['user_id'])
                ? self::positiveId($payload['user_id'])
                : $identity->userId;
            $sql .= ' AND user_id = :subject';
            $params['subject'] = $subject;
            if ($keep !== null) {
                $sql .= ' AND session_hash <> UNHEX(:keep)';
                $params['keep'] = $keep;
            }
        }
        if (!$isAdmin) {
            $sql .= ' AND user_id = :owner';
            $params['owner'] = $identity->userId;
        }
        $statement = $this->database->prepare($sql);
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $statement->execute();
        $closed = $statement->rowCount();
        if ($closed > 0) {
            $this->audit($identity->userId, 'session.revoke', 'user', (string) ($params['subject'] ?? ''), [
                'closed' => $closed,
                'scope' => $fingerprint !== null ? 'one' : 'others',
            ]);
        }
        return ['success' => true, 'closed' => $closed];
    }

    /**
     * Which libraries the caller's group may see, for callers that need both
     * answers at once rather than a refusal for one of them.
     *
     * @return array{music:bool,movies:bool}
     */
    public function accessibleLibraries(LegacyIdentity $identity): array
    {
        return $this->libraryAccess($identity);
    }

    /** @return array<string, mixed> */
    public function account(LegacyIdentity $identity, ?string $username = null): array
    {
        $profile = $this->profileSubject($identity, $username);
        $subjectId = (int) $profile['id'];
        $summary = $this->database->prepare(
            'SELECT
               (SELECT COUNT(*) FROM user_ratings WHERE user_id = :user_ratings AND rating IS NOT NULL) AS ratings,
               (SELECT COUNT(*) FROM user_ratings WHERE user_id = :user_favorites AND favorite = 1) AS favorites,
               (SELECT COALESCE(SUM(play_count), 0) FROM playback_stats WHERE user_id = :user_plays) AS plays'
        );
        $summary->execute([
            'user_ratings' => $subjectId,
            'user_favorites' => $subjectId,
            'user_plays' => $subjectId,
        ]);
        $counts = $summary->fetch(PDO::FETCH_ASSOC) ?: [];

        $recent = $this->database->prepare(
            "SELECT mi.id, COALESCE(mo.title, mi.title) AS title, mi.media_kind,
                    ps.play_count, ps.last_position_ms, ps.last_played_at,
                    ur.rating, COALESCE(ur.favorite, 0) AS favorite
             FROM playback_stats ps
             INNER JOIN media_items mi ON mi.id = ps.media_item_id AND mi.deleted_at IS NULL
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             LEFT JOIN user_ratings ur ON ur.user_id = ps.user_id AND ur.media_item_id = ps.media_item_id
             WHERE ps.user_id = :user_id
             ORDER BY ps.last_played_at DESC
             LIMIT 30"
        );
        $recent->execute(['user_id' => $subjectId]);
        $favorites = $this->database->prepare(
            "SELECT mi.id, COALESCE(mo.title, mi.title) AS title, mi.media_kind,
                    ur.rating, ur.updated_at
             FROM user_ratings ur
             INNER JOIN media_items mi ON mi.id = ur.media_item_id AND mi.deleted_at IS NULL
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             WHERE ur.user_id = :user_id AND ur.favorite = 1
             ORDER BY ur.updated_at DESC
             LIMIT 50"
        );
        $favorites->execute(['user_id' => $subjectId]);
        $collections = $subjectId === $identity->userId
            ? $this->collections($identity, null, 'mine', 'all', false)
            : array_values(array_filter(
                $this->collections($identity, null, 'all', 'public', false),
                static fn (array $collection): bool => (int) $collection['owner_id'] === $subjectId
            ));
        return [
            'profile' => [
                'id' => $subjectId,
                'username' => (string) $profile['username'],
                'is_own' => $subjectId === $identity->userId,
                'is_public' => (bool) $profile['profile_public'],
            ],
            'summary' => [
                'ratings' => (int) ($counts['ratings'] ?? 0),
                'favorites' => (int) ($counts['favorites'] ?? 0),
                'plays' => (int) ($counts['plays'] ?? 0),
                'collections' => count($collections),
            ],
            'recent' => $recent->fetchAll(PDO::FETCH_ASSOC),
            'favorites' => $favorites->fetchAll(PDO::FETCH_ASSOC),
            'collections' => $collections,
        ];
    }

    /** @return array<string, mixed> */
    public function accountEntries(
        LegacyIdentity $identity,
        string $section,
        string $kind,
        string $sort,
        int $page,
        int $limit,
        ?string $username = null,
        string $randomSeed = ''
    ): array {
        $profile = $this->profileSubject($identity, $username);
        $subjectId = (int) $profile['id'];
        $sections = ['recent', 'favorites', 'rated'];
        $kinds = ['all', 'music', 'movies'];
        $sorts = [
            'newest' => $section === 'recent' ? 'ps.last_played_at DESC' : 'ur.updated_at DESC',
            'oldest' => $section === 'recent' ? 'ps.last_played_at ASC' : 'ur.updated_at ASC',
            'title_asc' => 'COALESCE(mo.title, mi.title) ASC, mi.id ASC',
            'own_rating_desc' => 'COALESCE(ur.rating, 0) DESC, COALESCE(mo.title, mi.title) ASC',
            'average_rating_desc' => 'COALESCE(ra.avg_rating, 0) DESC, COALESCE(ra.rating_count, 0) DESC',
            'own_plays_desc' => 'COALESCE(ps.play_count, 0) DESC, ps.last_played_at DESC',
            'all_plays_desc' => 'COALESCE(mpt.play_count, 0) DESC, COALESCE(mo.title, mi.title) ASC',
            'random' => "SHA2(CONCAT(:random_seed, ':', mi.id), 256)",
        ];
        if (!in_array($section, $sections, true) || !in_array($kind, $kinds, true)
            || !isset($sorts[$sort]) || $page < 1 || $page > 10000 || $limit < 1 || $limit > 100
            || ($sort === 'random' && preg_match('/^[A-Za-z0-9_-]{8,64}$/D', $randomSeed) !== 1)) {
            throw new BridgeRequestException('Invalid account list parameters.');
        }
        $kind = $this->narrowLibraryKind($identity, $kind === 'all' ? null : $kind) ?? 'all';
        if ($kind === '') {
            return ['items' => [], 'page' => $page, 'has_more' => false];
        }
        $mediaKind = $kind === 'music' ? 'audio' : ($kind === 'movies' ? 'video' : null);
        $where = match ($section) {
            'favorites' => 'COALESCE(ur.favorite, 0) = 1',
            'rated' => 'ur.rating IS NOT NULL',
            default => 'ps.last_played_at IS NOT NULL',
        };
        if ($mediaKind !== null) {
            $where .= ' AND mi.media_kind = :media_kind';
        }
        $statement = $this->database->prepare(
            "SELECT mi.id, COALESCE(mo.title, mi.title) AS title,
                    COALESCE(mo.artist, mi.artist) AS artist, mi.media_kind,
                    COALESCE(ps.play_count, 0) AS play_count, ps.last_position_ms, ps.last_played_at,
                    ur.rating, COALESCE(ur.favorite, 0) AS favorite, ur.updated_at,
                    COALESCE(ra.avg_rating, 0) AS avg_rating,
                    COALESCE(ra.rating_count, 0) AS rating_count,
                    COALESCE(mpt.play_count, 0) AS total_play_count
             FROM media_items mi
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             LEFT JOIN user_ratings ur ON ur.media_item_id = mi.id AND ur.user_id = :rating_user_id
             LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = :playback_user_id
             LEFT JOIN media_play_totals mpt ON mpt.media_item_id = mi.id
             LEFT JOIN (
               SELECT media_item_id, AVG(rating) AS avg_rating, COUNT(rating) AS rating_count
               FROM user_ratings GROUP BY media_item_id
             ) ra ON ra.media_item_id = mi.id
             WHERE mi.deleted_at IS NULL
               AND mi.catalog_status IN ('ready', 'legacy')
               AND {$where}
             ORDER BY {$sorts[$sort]}
             LIMIT :row_limit OFFSET :row_offset"
        );
        $statement->bindValue(':rating_user_id', $subjectId, PDO::PARAM_INT);
        $statement->bindValue(':playback_user_id', $subjectId, PDO::PARAM_INT);
        if ($sort === 'random') {
            $statement->bindValue(':random_seed', $randomSeed, PDO::PARAM_STR);
        }
        if ($mediaKind !== null) {
            $statement->bindValue(':media_kind', $mediaKind, PDO::PARAM_STR);
        }
        $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', ($page - 1) * $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            array_pop($rows);
        }
        return ['items' => $rows, 'page' => $page, 'has_more' => $hasMore];
    }

    /** @return array<int, array{id:int,username:string,is_public:bool}> */
    public function profileSearch(LegacyIdentity $identity, string $query): array
    {
        $this->assertPermission($identity, 'can_browse_profiles');
        $query = trim($query);
        if ($query === '' || mb_strlen($query) > 80) {
            return [];
        }
        $isAdministrator = in_array($identity->role, ['admin', 'super_admin'], true);
        $visibility = $isAdministrator ? '' : 'AND (profile_public = 1 OR id = :own_user_id)';
        $statement = $this->database->prepare(
            "SELECT id, username, profile_public FROM users
             WHERE is_active = 1 AND is_guest = 0
               {$visibility}
               AND username LIKE :query
             ORDER BY CASE WHEN username LIKE :prefix THEN 0 ELSE 1 END, username LIMIT 10"
        );
        $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $query);
        $params = [
            'query' => '%' . $escaped . '%',
            'prefix' => $escaped . '%',
        ];
        if (!$isAdministrator) {
            $params['own_user_id'] = $identity->userId;
        }
        $statement->execute($params);
        return array_map(
            static fn (array $row): array => [
                'id' => (int) $row['id'],
                'username' => (string) $row['username'],
                'is_public' => (bool) $row['profile_public'],
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /** @return array{id:int,username:string,profile_public:bool|int} */
    private function profileSubject(LegacyIdentity $identity, ?string $username): array
    {
        if ($username === null || trim($username) === '' || strcasecmp($identity->username, trim($username)) === 0) {
            $statement = $this->database->prepare('SELECT profile_public FROM users WHERE id = :id LIMIT 1');
            $statement->execute(['id' => $identity->userId]);
            return [
                'id' => $identity->userId,
                'username' => $identity->username,
                'profile_public' => (bool) $statement->fetchColumn(),
            ];
        }
        $this->assertPermission($identity, 'can_browse_profiles');
        if (mb_strlen($username) > 191 || preg_match('/[\x00-\x1F\x7F\\\/]/u', $username) === 1) {
            throw new BridgeRequestException('Invalid profile name.');
        }
        $isAdministrator = in_array($identity->role, ['admin', 'super_admin'], true);
        $statement = $this->database->prepare(
            'SELECT id, username, profile_public FROM users
             WHERE username = :username AND is_active = 1 AND is_guest = 0'
             . ($isAdministrator ? '' : ' AND profile_public = 1') . ' LIMIT 1'
        );
        $statement->execute(['username' => $username]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Profile not found.');
        }
        return [
            'id' => (int) $row['id'],
            'username' => (string) $row['username'],
            'profile_public' => (bool) $row['profile_public'],
        ];
    }

    /** @param array<string, mixed> $payload @return array{success:true,is_public:bool} */
    /**
     * Interface preferences that belong to the person, not the installation.
     *
     * Unknown keys are dropped and every value is clamped to the allowed set, so a
     * stored preference can never make the interface render something unexpected.
     *
     * @return array<string, mixed>
     */
    public static function normalizePreferences(mixed $raw): array
    {
        $stored = is_string($raw) ? json_decode($raw, true) : $raw;
        $queue = is_array($stored) && is_array($stored['queue'] ?? null) ? $stored['queue'] : [];
        $rating = $queue['rating'] ?? 'own';
        $language = is_array($stored) ? ($stored['language'] ?? null) : null;
        return [
            // Polish stays the default for accounts that never chose: reading the
            // browser's language instead would quietly switch the interface for
            // everyone who has been using it in Polish all along.
            'language' => in_array($language, ['pl', 'en'], true) ? $language : 'pl',
            'queue' => [
                'index' => ($queue['index'] ?? true) === true,
                'favorite' => ($queue['favorite'] ?? true) === true,
                'rating' => in_array($rating, ['own', 'average', 'none'], true) ? $rating : 'own',
            ],
        ];
    }

    /** @return array<string, mixed> */
    public function preferences(LegacyIdentity $identity): array
    {
        $statement = $this->database->prepare('SELECT preferences_json FROM users WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $identity->userId]);
        return self::normalizePreferences($statement->fetchColumn());
    }

    /** @param array<string, mixed> $payload */
    public function savePreferences(LegacyIdentity $identity, array $payload): array
    {
        $preferences = self::normalizePreferences($payload['preferences'] ?? null);
        $statement = $this->database->prepare(
            'UPDATE users SET preferences_json = :preferences WHERE id = :user_id AND is_active = 1'
        );
        $statement->execute([
            'preferences' => json_encode($preferences, JSON_THROW_ON_ERROR),
            'user_id' => $identity->userId,
        ]);
        return ['success' => true, 'preferences' => $preferences];
    }

    public function setProfileVisibility(LegacyIdentity $identity, array $payload): array
    {
        $isPublic = $payload['is_public'] ?? null;
        if (!is_bool($isPublic)) {
            throw new BridgeRequestException('Invalid profile visibility.');
        }
        $statement = $this->database->prepare(
            'UPDATE users SET profile_public = :profile_public WHERE id = :user_id AND is_active = 1'
        );
        $statement->execute([
            'profile_public' => $isPublic ? 1 : 0,
            'user_id' => $identity->userId,
        ]);
        if ($statement->rowCount() > 0) {
            $this->audit($identity->userId, 'profile.visibility', 'user', (string) $identity->userId, [
                'public' => $isPublic,
            ]);
        }
        return ['success' => true, 'is_public' => $isPublic];
    }

    /** @return array<int, array<string, mixed>> */
    public function collections(
        LegacyIdentity $identity,
        ?string $kind = null,
        string $owner = 'mine',
        string $visibility = 'all',
        bool $enforcePermission = true,
        string $sort = 'updated_desc'
    ): array
    {
        if (!$this->featureTableExists('user_collections')) {
            return [];
        }
        if ($kind !== null && !in_array($kind, ['music', 'movies'], true)) {
            throw new BridgeRequestException('Nieprawidłowy rodzaj kolekcji.');
        }
        // A group without one library sees only the other library's collections.
        $kind = $this->narrowLibraryKind($identity, $kind);
        if ($kind === '') {
            return [];
        }
        if (!in_array($owner, ['mine', 'others', 'all'], true)
            || !in_array($visibility, ['private', 'public', 'all'], true)) {
            throw new BridgeRequestException('Nieprawidłowe filtry kolekcji.');
        }
        if (!in_array($sort, ['updated_desc', 'name_asc', 'name_desc', 'rating_desc', 'plays_desc', 'items_desc'], true)) {
            throw new BridgeRequestException('Nieprawidłowe sortowanie kolekcji.');
        }
        if ($enforcePermission && $owner !== 'mine') {
            $this->assertPermission($identity, 'can_browse_collections');
        }
        $where = ['(uc.user_id = :access_user OR uc.is_shared = 1)'];
        $params = ['access_user' => $identity->userId];
        if ($owner === 'mine') {
            $where[] = 'uc.user_id = :mine_user';
            $params['mine_user'] = $identity->userId;
        } elseif ($owner === 'others') {
            $where[] = 'uc.user_id <> :others_user';
            $where[] = 'uc.is_shared = 1';
            $params['others_user'] = $identity->userId;
        }
        if ($visibility === 'private') {
            $where[] = 'uc.user_id = :private_user';
            $where[] = 'uc.is_shared = 0';
            $params['private_user'] = $identity->userId;
        } elseif ($visibility === 'public') {
            $where[] = 'uc.is_shared = 1';
        }
        $sql =
            'SELECT uc.id, uc.user_id, u.username AS owner_name, uc.name, uc.description, uc.media_kind, uc.rules_json,
                    uc.is_shared, uc.queue_rating, uc.queue_favorite, uc.created_at, uc.updated_at,
                    COUNT(uci.media_item_id) AS item_count
             FROM user_collections uc
             INNER JOIN users u ON u.id = uc.user_id
             LEFT JOIN user_collection_items uci ON uci.collection_id = uc.id
             WHERE ' . implode(' AND ', $where);
        if ($kind !== null) {
            $sql .= ' AND uc.media_kind = :media_kind';
            $params['media_kind'] = $kind;
        }
        $sql .= ' GROUP BY uc.id, u.username ORDER BY uc.updated_at DESC, uc.name';
        $statement = $this->database->prepare($sql);
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $statement->execute();
        $collections = array_map(static function (array $row) use ($identity): array {
            $rules = $row['rules_json'] === null ? null : json_decode((string) $row['rules_json'], true);
            return [
                'id' => (int) $row['id'],
                'owner_id' => (int) $row['user_id'],
                'owner_name' => (string) $row['owner_name'],
                'is_owned' => (int) $row['user_id'] === $identity->userId,
                'name' => (string) $row['name'],
                'description' => (string) ($row['description'] ?? ''),
                'media_kind' => (string) $row['media_kind'],
                'is_smart' => is_array($rules),
                'rules' => is_array($rules) ? $rules : null,
                'is_shared' => (int) ($row['is_shared'] ?? 0) === 1,
                // How this list wants its queue drawn; 'inherit' defers to the
                // account reading it, which is what every list starts out as.
                'queue_rating' => (string) ($row['queue_rating'] ?? 'inherit'),
                'queue_favorite' => (string) ($row['queue_favorite'] ?? 'inherit'),
                'item_count' => (int) $row['item_count'],
                // Two different facts, and the names say which is which: the
                // list's own stars, and the average of the stars its tracks got.
                'rating' => null,
                'avg_rating' => 0.0,
                'rating_count' => 0,
                'items_avg_rating' => 0.0,
                'items_rating_count' => 0,
                'total_play_count' => 0,
                'has_artwork' => false,
                'artwork_revision' => '',
                'preview_candidates' => [],
                'created_at' => (string) $row['created_at'],
                'updated_at' => (string) $row['updated_at'],
            ];
        }, $statement->fetchAll(PDO::FETCH_ASSOC));
        // Manual lists share one shape, so their statistics and cover candidates
        // come from a single grouped query instead of one query per list.
        // Rule-based (smart) lists each carry their own filter and still need an
        // individual pass.
        $manualIds = array_values(array_map(
            static fn (array $row): int => (int) $row['id'],
            array_filter($collections, static fn (array $row): bool => $row['is_smart'] !== true)
        ));
        $batched = $this->manualCollectionStatistics($manualIds);
        $artwork = $this->collectionsWithArtwork(array_map(
            static fn (array $row): int => (int) $row['id'],
            $collections
        ));
        $manualCandidates = $this->manualCollectionPreviewCandidates(
            array_values(array_filter($manualIds, static fn (int $id): bool => !isset($artwork[$id])))
        );
        $votes = $this->collectionRatings($identity->userId, array_map(
            static fn (array $row): int => (int) $row['id'],
            $collections
        ));
        foreach ($collections as &$collection) {
            $id = (int) $collection['id'];
            $statistics = $collection['is_smart'] === true
                ? $this->collectionStatistics($identity, $collection)
                : ($batched[$id] ?? self::emptyCollectionStatistics());
            $collection = array_merge($collection, $statistics);
            $vote = $votes[$id] ?? null;
            $collection['rating'] = $vote['user_rating'] ?? null;
            $collection['avg_rating'] = $vote['avg_rating'] ?? 0.0;
            $collection['rating_count'] = $vote['rating_count'] ?? 0;
            $collection['has_artwork'] = isset($artwork[$id]);
            $collection['artwork_revision'] = $artwork[$id] ?? '';
            // A card without an own cover borrows one from its contents, so the
            // candidates are only worth fetching when there is no own cover.
            if (!$collection['has_artwork']) {
                $collection['preview_candidates'] = $collection['is_smart'] === true
                    ? $this->collectionPreviewCandidates($identity, $collection, $collection['rules'])
                    : ($manualCandidates[$id] ?? []);
            }
        }
        unset($collection);
        usort($collections, static function (array $left, array $right) use ($sort): int {
            $result = match ($sort) {
                'name_asc' => strnatcasecmp((string) $left['name'], (string) $right['name']),
                'name_desc' => strnatcasecmp((string) $right['name'], (string) $left['name']),
                // "Best rated" means the list people rated best, not the list
                // whose songs happen to be well rated — that is what the stars
                // on its card say, and a sort must agree with what it sorts.
                'rating_desc' => ((float) $right['avg_rating'] <=> (float) $left['avg_rating'])
                    ?: ((int) $right['rating_count'] <=> (int) $left['rating_count']),
                'plays_desc' => ((int) $right['total_play_count'] <=> (int) $left['total_play_count']),
                'items_desc' => ((int) $right['item_count'] <=> (int) $left['item_count']),
                default => strcmp((string) $right['updated_at'], (string) $left['updated_at']),
            };
            return $result !== 0 ? $result : ((int) $left['id'] <=> (int) $right['id']);
        });
        return $collections;
    }

    /** @param array<string, mixed> $payload */
    public function createCollection(LegacyIdentity $identity, array $payload): array
    {
        $this->assertFeatureTable('user_collections');
        $this->assertPermission($identity, 'can_create_collections');
        $name = self::optionalText($payload['name'] ?? null, 191);
        if ($name === null || strlen($name) < 2) {
            throw new BridgeRequestException('Nazwa kolekcji musi mieć co najmniej 2 znaki.');
        }
        $kind = $payload['media_kind'] ?? null;
        if (!is_string($kind) || !in_array($kind, ['music', 'movies'], true)) {
            throw new BridgeRequestException('Nieprawidłowy rodzaj kolekcji.');
        }
        $rules = self::collectionRules($payload['rules'] ?? null);
        $description = self::optionalText($payload['description'] ?? null, 500) ?? '';
        $queueRating = self::queueRatingMode($payload['queue_rating'] ?? null);
        $queueFavorite = self::queueFavoriteMode($payload['queue_favorite'] ?? null);
        $statement = $this->database->prepare(
            'INSERT INTO user_collections
                (user_id, name, description, media_kind, rules_json, is_shared, queue_rating, queue_favorite)
             VALUES (:user_id, :name, :description, :media_kind, :rules_json, 0, :queue_rating, :queue_favorite)'
        );
        $statement->execute([
            'user_id' => $identity->userId,
            'name' => $name,
            'description' => $description,
            'media_kind' => $kind,
            'rules_json' => $rules === null ? null : json_encode($rules, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
            'queue_rating' => $queueRating,
            'queue_favorite' => $queueFavorite,
        ]);
        $id = (int) $this->database->lastInsertId();
        $this->audit($identity->userId, 'collection.create', 'collection', (string) $id, [
            'name' => $name, 'media_kind' => $kind, 'smart' => $rules !== null,
        ]);
        return ['success' => true, 'id' => $id];
    }

    /**
     * Rename an owned collection or change its description.
     *
     * @param array<string, mixed> $payload
     */
    public function updateCollection(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_create_collections');
        $id = self::positiveId($payload['collection_id'] ?? null);
        $this->ownedCollection($identity, $id);
        $assignments = [];
        $params = ['id' => $id, 'user_id' => $identity->userId];
        $changes = [];
        if (array_key_exists('name', $payload)) {
            $name = self::optionalText($payload['name'], 191);
            if ($name === null || strlen($name) < 2) {
                throw new BridgeRequestException('Nazwa kolekcji musi mieć co najmniej 2 znaki.');
            }
            $assignments[] = 'name = :name';
            $params['name'] = $name;
            $changes['name'] = $name;
        }
        if (array_key_exists('description', $payload)) {
            $description = self::optionalText($payload['description'], 500) ?? '';
            $assignments[] = 'description = :description';
            $params['description'] = $description;
            $changes['description'] = $description;
        }
        // Display settings for the queue this list builds. Recorded in the audit
        // trail like everything else here, because switching to 'owner' makes the
        // author's ratings and favourites visible to everyone who plays the list.
        if (array_key_exists('queue_rating', $payload)) {
            $queueRating = self::queueRatingMode($payload['queue_rating']);
            $assignments[] = 'queue_rating = :queue_rating';
            $params['queue_rating'] = $queueRating;
            $changes['queue_rating'] = $queueRating;
        }
        if (array_key_exists('queue_favorite', $payload)) {
            $queueFavorite = self::queueFavoriteMode($payload['queue_favorite']);
            $assignments[] = 'queue_favorite = :queue_favorite';
            $params['queue_favorite'] = $queueFavorite;
            $changes['queue_favorite'] = $queueFavorite;
        }
        if ($assignments === []) {
            throw new BridgeRequestException('Brak zmian do zapisania.');
        }
        $this->database->prepare(
            'UPDATE user_collections SET ' . implode(', ', $assignments) . ', updated_at = CURRENT_TIMESTAMP(6)
             WHERE id = :id AND user_id = :user_id'
        )->execute($params);
        $this->audit($identity->userId, 'collection.update', 'collection', (string) $id, $changes);
        return ['success' => true];
    }

    /**
     * Rewrite the manual order of an owned collection.
     *
     * The client sends the complete new order; items it omits keep their spot
     * relative to each other after the reordered block.
     *
     * @param array<string, mixed> $payload
     */
    public function reorderCollection(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_create_collections');
        $id = self::positiveId($payload['collection_id'] ?? null);
        $collection = $this->ownedCollection($identity, $id);
        if ($collection['rules_json'] !== null) {
            throw new BridgeRequestException('Inteligentna kolekcja jest wyliczana z reguł.');
        }
        $order = $payload['media_item_ids'] ?? null;
        if (!is_array($order) || !array_is_list($order) || $order === [] || count($order) > 1000) {
            throw new BridgeRequestException('Nieprawidłowa kolejność kolekcji.');
        }
        $ids = [];
        foreach ($order as $value) {
            if (!is_int($value) || $value < 1 || isset($ids[$value])) {
                throw new BridgeRequestException('Nieprawidłowa kolejność kolekcji.');
            }
            $ids[$value] = $value;
        }
        $this->database->beginTransaction();
        try {
            $statement = $this->database->prepare(
                'UPDATE user_collection_items SET position = :position
                 WHERE collection_id = :collection_id AND media_item_id = :item_id'
            );
            $position = 0;
            foreach ($ids as $itemId) {
                $position += 1;
                $statement->execute(['position' => $position, 'collection_id' => $id, 'item_id' => $itemId]);
            }
            // Anything the client did not mention keeps its relative order,
            // shifted after the reordered block.
            $rest = $this->database->prepare(
                'SELECT media_item_id FROM user_collection_items
                 WHERE collection_id = :collection_id ORDER BY position, media_item_id'
            );
            $rest->execute(['collection_id' => $id]);
            foreach ($rest->fetchAll(PDO::FETCH_COLUMN) as $existingId) {
                $existingId = (int) $existingId;
                if (!isset($ids[$existingId])) {
                    $position += 1;
                    $statement->execute(['position' => $position, 'collection_id' => $id, 'item_id' => $existingId]);
                }
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        $this->audit($identity->userId, 'collection.reorder', 'collection', (string) $id, ['items' => count($ids)]);
        return ['success' => true];
    }

    /**
     * Swap one item with its position-neighbour in an owned manual collection.
     *
     * This is O(1) regardless of collection size — no full-order rewrite and no
     * client-side prefetch of the whole list — so reordering scales past the
     * 1000-item cap of reorderCollection.
     *
     * @param array<string, mixed> $payload
     */
    public function moveCollectionItem(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_create_collections');
        $id = self::positiveId($payload['collection_id'] ?? null);
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        $direction = $payload['direction'] ?? null;
        if (!in_array($direction, ['up', 'down'], true)) {
            throw new BridgeRequestException('Nieprawidłowy kierunek przeniesienia.');
        }
        $collection = $this->ownedCollection($identity, $id);
        if ($collection['rules_json'] !== null) {
            throw new BridgeRequestException('Inteligentna kolekcja jest wyliczana z reguł.');
        }
        $this->database->beginTransaction();
        try {
            $current = $this->database->prepare(
                'SELECT position FROM user_collection_items
                 WHERE collection_id = :collection_id AND media_item_id = :item_id FOR UPDATE'
            );
            $current->execute(['collection_id' => $id, 'item_id' => $itemId]);
            $position = $current->fetchColumn();
            if ($position === false) {
                throw new CatalogItemNotFoundException('Pozycja nie istnieje w kolekcji.');
            }
            $position = (int) $position;
            // The adjacent item is the one with the next-lower (up) or next-higher
            // (down) position; ties on equal positions break deterministically.
            $neighbour = $this->database->prepare(
                $direction === 'up'
                    ? 'SELECT media_item_id, position FROM user_collection_items
                       WHERE collection_id = :collection_id AND position < :position
                       ORDER BY position DESC, media_item_id DESC LIMIT 1 FOR UPDATE'
                    : 'SELECT media_item_id, position FROM user_collection_items
                       WHERE collection_id = :collection_id AND position > :position
                       ORDER BY position ASC, media_item_id ASC LIMIT 1 FOR UPDATE'
            );
            $neighbour->execute(['collection_id' => $id, 'position' => $position]);
            $other = $neighbour->fetch(PDO::FETCH_ASSOC);
            if (is_array($other)) {
                $swap = $this->database->prepare(
                    'UPDATE user_collection_items SET position = :position
                     WHERE collection_id = :collection_id AND media_item_id = :item_id'
                );
                $swap->execute(['position' => (int) $other['position'], 'collection_id' => $id, 'item_id' => $itemId]);
                $swap->execute(['position' => $position, 'collection_id' => $id, 'item_id' => (int) $other['media_item_id']]);
            }
            $this->database->prepare(
                'UPDATE user_collections SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
            )->execute(['id' => $id]);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return ['success' => true];
    }

    /** @param array<string, mixed> $payload */
    public function deleteCollection(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_create_collections');
        $id = self::positiveId($payload['collection_id'] ?? null);
        $statement = $this->database->prepare(
            'DELETE FROM user_collections WHERE id = :id AND user_id = :user_id'
        );
        $statement->execute(['id' => $id, 'user_id' => $identity->userId]);
        if ($statement->rowCount() !== 1) {
            throw new CatalogItemNotFoundException('Kolekcja nie istnieje.');
        }
        $this->audit($identity->userId, 'collection.delete', 'collection', (string) $id, null);
        return ['success' => true];
    }

    /** @param array<string, mixed> $payload */
    public function setCollectionShared(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_share');
        $id = self::positiveId($payload['collection_id'] ?? null);
        $shared = $payload['shared'] ?? null;
        if (!is_bool($shared)) {
            throw new BridgeRequestException('Nieprawidłowy stan udostępnienia.');
        }
        $statement = $this->database->prepare(
            'UPDATE user_collections SET is_shared = :shared, updated_at = CURRENT_TIMESTAMP(6)
             WHERE id = :id AND user_id = :user_id'
        );
        $statement->execute([
            'shared' => (int) $shared,
            'id' => $id,
            'user_id' => $identity->userId,
        ]);
        if ($statement->rowCount() !== 1) {
            $this->ownedCollection($identity, $id);
        }
        $this->audit($identity->userId, 'collection.share', 'collection', (string) $id, ['shared' => $shared]);
        return ['success' => true, 'shared' => $shared];
    }

    /**
     * A vote on the playlist itself.
     *
     * Rating a list is not rating its music. The tracks already carry their own
     * stars, and averaging them says how good the songs are — a question their
     * own ratings answered. What a playlist adds is the choosing: an order, a
     * mood, twelve tracks out of twelve thousand. That is what this rates.
     *
     * Anyone who can open the list can rate it, its author included: on a home
     * server the author is usually the only listener, and a feature that shut
     * them out would rate nothing at all. Passing null clears the vote, exactly
     * as clicking the same star twice does for a track.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function rateCollection(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_rate');
        $this->assertFeatureTable('user_collection_ratings');
        $collectionId = self::positiveId($payload['collection_id'] ?? null);
        if (!array_key_exists('rating', $payload)) {
            throw new BridgeRequestException('Brak oceny.');
        }
        $rating = self::ratingValue($payload['rating']);
        // Reading the row is the access check: an own list, or one shared with us.
        $collection = $this->accessibleCollection($identity, $collectionId);
        $this->assertLibraryAccess($identity, (string) $collection['media_kind']);
        if ($rating === null) {
            $statement = $this->database->prepare(
                'DELETE FROM user_collection_ratings
                 WHERE user_id = :user_id AND collection_id = :collection_id'
            );
            $statement->execute(['user_id' => $identity->userId, 'collection_id' => $collectionId]);
        } else {
            $statement = $this->database->prepare(
                'INSERT INTO user_collection_ratings (user_id, collection_id, rating)
                 VALUES (:user_id, :collection_id, :rating)
                 ON DUPLICATE KEY UPDATE rating = VALUES(rating)'
            );
            $statement->execute([
                'user_id' => $identity->userId,
                'collection_id' => $collectionId,
                'rating' => $rating,
            ]);
        }
        $this->audit($identity->userId, 'collection.rating', 'collection', (string) $collectionId, [
            'rating' => $rating,
        ]);
        return $this->collectionRatingSummary($identity->userId, $collectionId);
    }

    /** @param array<string, mixed> $payload */
    public function setCollectionItem(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_create_collections');
        $collectionId = self::positiveId($payload['collection_id'] ?? null);
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        $included = $payload['included'] ?? true;
        if (!is_bool($included)) {
            throw new BridgeRequestException('Nieprawidłowy stan elementu kolekcji.');
        }
        $statement = $this->database->prepare(
            'SELECT media_kind, rules_json FROM user_collections
             WHERE id = :id AND user_id = :user_id LIMIT 1'
        );
        $statement->execute(['id' => $collectionId, 'user_id' => $identity->userId]);
        $collection = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($collection)) {
            throw new CatalogItemNotFoundException('Kolekcja nie istnieje.');
        }
        if ($collection['rules_json'] !== null) {
            throw new BridgeRequestException('Inteligentna kolekcja jest wyliczana z reguł.');
        }
        $expectedKind = $collection['media_kind'] === 'music' ? 'audio' : 'video';
        $this->assertItem($itemId, $expectedKind);
        if (!$included) {
            $this->database->prepare(
                'DELETE FROM user_collection_items WHERE collection_id = :collection_id AND media_item_id = :item_id'
            )->execute(['collection_id' => $collectionId, 'item_id' => $itemId]);
        } else {
            $statement = $this->database->prepare(
                'INSERT INTO user_collection_items (collection_id, media_item_id, position)
                 SELECT :collection_id, :item_id, COALESCE(MAX(position), 0) + 1
                 FROM user_collection_items WHERE collection_id = :position_collection
                 ON DUPLICATE KEY UPDATE media_item_id = VALUES(media_item_id)'
            );
            $statement->execute([
                'collection_id' => $collectionId,
                'item_id' => $itemId,
                'position_collection' => $collectionId,
            ]);
        }
        $this->audit($identity->userId, 'collection.item', 'collection', (string) $collectionId, [
            'media_item_id' => $itemId, 'included' => $included,
        ]);
        return ['success' => true];
    }

    /**
     * One page of a playlist, in the order the caller asked for.
     *
     * Paging has two callers with different needs: the grid pages by `page`,
     * while the player walks a shuffled queue by absolute `offset`. A non-zero
     * offset therefore wins over the page number. `total` is the size of the
     * whole playlist, not of the window that was returned, so the interface can
     * name it before everything is loaded.
     *
     * @return array<string, mixed>
     */
    public function collectionPage(
        LegacyIdentity $identity,
        int $collectionId,
        int $page = 1,
        int $limit = 100,
        string $shuffleSeed = '',
        int $shuffleOffset = 0,
        string $sort = 'position'
    ): array {
        if (
            $page < 1 || $page > 10000 || $limit < 1 || $limit > 100
            || $shuffleOffset < 0 || $shuffleOffset > 1000000
            || !in_array($sort, self::COLLECTION_SORTS, true)
            || ($shuffleSeed !== '' && preg_match('/^[A-Za-z0-9_-]{8,64}$/D', $shuffleSeed) !== 1)
            || ($sort === 'random' && $shuffleSeed === '')
        ) {
            throw new BridgeRequestException('Nieprawidłowa paginacja playlisty.');
        }
        $collection = $this->accessibleCollection($identity, $collectionId);
        $this->assertLibraryAccess($identity, (string) $collection['media_kind']);
        $rules = $collection['rules_json'] === null
            ? null
            : json_decode((string) $collection['rules_json'], true, 32, JSON_THROW_ON_ERROR);
        $params = [];
        $where = '';
        $join = '';
        if (is_array($rules)) {
            [$where, $params] = self::collectionRuleSql($rules);
        } else {
            $join = ' INNER JOIN user_collection_items uci
                       ON uci.media_item_id = mi.id AND uci.collection_id = :collection_id';
            $params['collection_id'] = $collectionId;
        }
        $order = self::collectionOrderSql($sort, is_array($rules));
        $mediaKind = $collection['media_kind'] === 'music' ? 'audio' : 'video';
        $offset = $shuffleOffset > 0 ? $shuffleOffset : ($page - 1) * $limit;
        $queueRating = (string) ($collection['queue_rating'] ?? 'inherit');
        $queueFavorite = (string) ($collection['queue_favorite'] ?? 'inherit');
        // The author's stars are a second set of columns, not a replacement for
        // the reader's: a list can show "the owner's rating" while the reader
        // still rates from the same rows, and both are wanted at once. Joined
        // only when this list actually asks for them.
        $ownerId = (int) $collection['user_id'];
        $withOwner = $queueRating === 'owner' || $queueFavorite === 'owner';
        $filter = " WHERE mi.media_kind = :media_kind
                      AND mi.deleted_at IS NULL
                      AND mi.catalog_status IN ('ready', 'legacy')
                      {$where}";
        $countStatement = $this->database->prepare(
            'SELECT COUNT(*) FROM (' . self::collectionItemSelect($join) . $filter . ') counted_collection_items'
        );
        self::bindIdentity($countStatement, $identity);
        $countStatement->bindValue(':media_kind', $mediaKind, PDO::PARAM_STR);
        foreach ($params as $key => $value) {
            $countStatement->bindValue(
                ':' . $key,
                $value,
                is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR
            );
        }
        $countStatement->execute();
        $total = (int) $countStatement->fetchColumn();
        $statement = $this->database->prepare(
            self::collectionItemSelect($join, $withOwner) . $filter .
            " ORDER BY {$order}
              LIMIT :row_limit OFFSET :row_offset"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':media_kind', $mediaKind, PDO::PARAM_STR);
        if ($withOwner) {
            $statement->bindValue(':owner_rating_user_id', $ownerId, PDO::PARAM_INT);
        }
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        if ($sort === 'random') {
            $statement->bindValue(':collection_shuffle_seed', $shuffleSeed, PDO::PARAM_STR);
        }
        $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', $offset, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            array_pop($rows);
        }
        $artwork = $this->collectionsWithArtwork([$collectionId]);
        return [
            'collection' => [
                'id' => (int) $collection['id'],
                'owner_id' => (int) $collection['user_id'],
                'owner_name' => (string) ($collection['owner_name'] ?? ''),
                'name' => (string) $collection['name'],
                'description' => (string) ($collection['description'] ?? ''),
                'media_kind' => (string) $collection['media_kind'],
                'is_smart' => is_array($rules),
                'rules' => is_array($rules) ? $rules : null,
                'is_shared' => (int) ($collection['is_shared'] ?? 0) === 1,
                'is_owned' => (int) ($collection['user_id'] ?? $identity->userId) === $identity->userId,
                'queue_rating' => $queueRating,
                'queue_favorite' => $queueFavorite,
                'has_artwork' => $artwork !== [],
                'artwork_revision' => $artwork[$collectionId] ?? '',
            ],
            'items' => array_map([self::class, 'publicCollectionItem'], $rows),
            'page' => $page,
            'has_more' => $hasMore,
            'offset' => $offset,
            'total' => $total,
            'sort' => $sort,
        ];
    }

    /**
     * ORDER BY for one playlist order.
     *
     * A rule-based list has no manual order, so 'position' falls back to the
     * title; 'added_desc' means "when it was put on the list" for a manual list
     * and "when it entered the catalogue" for a rule-based one.
     */
    private static function collectionOrderSql(string $sort, bool $isSmart): string
    {
        $title = 'COALESCE(mo.title, mi.title)';
        return match ($sort) {
            'title_asc' => "{$title}, mi.id",
            'title_desc' => "{$title} DESC, mi.id DESC",
            'own_rating_desc' => "COALESCE(ur.rating, 0) DESC, {$title}, mi.id",
            'rating_desc' => "COALESCE(ra.avg_rating, 0) DESC, COALESCE(ra.rating_count, 0) DESC, {$title}, mi.id",
            'plays_desc' => "COALESCE(mpt.play_count, 0) DESC, {$title}, mi.id",
            'added_desc' => $isSmart ? 'mi.indexed_at DESC, mi.id DESC' : 'uci.added_at DESC, uci.position DESC, mi.id DESC',
            'random' => "SHA2(CONCAT(:collection_shuffle_seed, ':', mi.id), 256), mi.id",
            default => $isSmart ? "{$title}, mi.id" : 'uci.position, mi.id',
        };
    }

    /**
     * Up to PREVIEW_CANDIDATES tracks a playlist can borrow a cover from.
     *
     * Same idea as LibraryBrowser::withDirectoryPreviews for folders: without an
     * own cover the card cycles through the artwork of what is on the list.
     *
     * @param array<string, mixed> $collection
     * @param array<string, mixed>|null $rules
     * @return array<int, array{id:int,kind:string}>
     */
    private function collectionPreviewCandidates(LegacyIdentity $identity, array $collection, ?array $rules): array
    {
        $params = [];
        $where = '';
        $join = '';
        if (is_array($rules)) {
            [$where, $params] = self::collectionRuleSql($rules);
            $order = 'mi.id';
        } else {
            $join = ' INNER JOIN user_collection_items uci
                       ON uci.media_item_id = mi.id AND uci.collection_id = :collection_id';
            $params['collection_id'] = (int) $collection['id'];
            $order = 'uci.position, mi.id';
        }
        $statement = $this->database->prepare(
            'SELECT mi.id, mi.media_kind' . self::collectionItemFrom($join) .
            " WHERE mi.media_kind = :media_kind
                AND mi.deleted_at IS NULL
                AND mi.catalog_status IN ('ready', 'legacy')
                {$where}
              ORDER BY {$order}
              LIMIT " . self::PREVIEW_CANDIDATES
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':media_kind', $collection['media_kind'] === 'music' ? 'audio' : 'video', PDO::PARAM_STR);
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $statement->execute();
        return array_map(
            static fn (array $row): array => ['id' => (int) $row['id'], 'kind' => (string) $row['media_kind']],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Media item identifiers of a whole playlist, for a ZIP transfer.
     *
     * @return array<int, int>
     */
    public function archiveCollectionItemIds(LegacyIdentity $identity, int $collectionId, int $maximum = 1000): array
    {
        if ($maximum < 1 || $maximum > 1000) {
            throw new BridgeRequestException('Nieprawidłowy limit archiwum.');
        }
        $collection = $this->accessibleCollection($identity, $collectionId);
        $this->assertLibraryAccess($identity, (string) $collection['media_kind']);
        $rules = $collection['rules_json'] === null
            ? null
            : json_decode((string) $collection['rules_json'], true, 32, JSON_THROW_ON_ERROR);
        $params = [];
        $where = '';
        $join = '';
        if (is_array($rules)) {
            [$where, $params] = self::collectionRuleSql($rules);
            $order = 'mi.id';
        } else {
            $join = ' INNER JOIN user_collection_items uci
                       ON uci.media_item_id = mi.id AND uci.collection_id = :collection_id';
            $params['collection_id'] = $collectionId;
            $order = 'uci.position, mi.id';
        }
        $statement = $this->database->prepare(
            'SELECT mi.id' . self::collectionItemFrom($join) .
            " WHERE mi.media_kind = :media_kind
                AND mi.deleted_at IS NULL
                AND mi.catalog_status IN ('ready', 'legacy')
                {$where}
              ORDER BY {$order}
              LIMIT :row_limit"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':media_kind', $collection['media_kind'] === 'music' ? 'audio' : 'video', PDO::PARAM_STR);
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $statement->bindValue(':row_limit', $maximum + 1, PDO::PARAM_INT);
        $statement->execute();
        $ids = array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN));
        if ($ids === [] || count($ids) > $maximum) {
            throw new BridgeRequestException('Playlista jest pusta albo przekracza limit 1000 plików na archiwum.');
        }
        return $ids;
    }

    /** @return array{mime_type:string,image_data:string}|null */
    public function collectionArtwork(LegacyIdentity $identity, int $collectionId): ?array
    {
        $this->accessibleCollection($identity, $collectionId);
        if (!$this->featureTableExists('user_collection_artwork')) {
            return null;
        }
        $statement = $this->database->prepare(
            'SELECT mime_type, image_data FROM user_collection_artwork WHERE collection_id = :id LIMIT 1'
        );
        $statement->execute(['id' => $collectionId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !is_string($row['image_data'] ?? null)) {
            return null;
        }
        return ['mime_type' => (string) $row['mime_type'], 'image_data' => $row['image_data']];
    }

    /**
     * Set or clear the own cover of a playlist. Only its owner may do so.
     *
     * @param array<string, mixed> $payload
     */
    public function saveCollectionArtwork(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_create_collections');
        $this->assertFeatureTable('user_collection_artwork');
        $collectionId = self::positiveId($payload['collection_id'] ?? null);
        $this->ownedCollection($identity, $collectionId);
        $dataUrl = $payload['data_url'] ?? null;
        if ($dataUrl === null) {
            $this->database->prepare(
                'DELETE FROM user_collection_artwork WHERE collection_id = :id'
            )->execute(['id' => $collectionId]);
            $this->audit($identity->userId, 'collection.artwork_remove', 'collection', (string) $collectionId, null);
            return ['success' => true, 'removed' => true];
        }
        [$mimeType, $image] = self::decodeArtwork($dataUrl);
        $statement = $this->database->prepare(
            'INSERT INTO user_collection_artwork (collection_id, mime_type, image_data, content_hash, updated_by)
             VALUES (:id, :mime_type, :image_data, :content_hash, :updated_by)
             ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), image_data = VALUES(image_data),
               content_hash = VALUES(content_hash), updated_by = VALUES(updated_by)'
        );
        $statement->bindValue(':id', $collectionId, PDO::PARAM_INT);
        $statement->bindValue(':mime_type', $mimeType, PDO::PARAM_STR);
        $statement->bindValue(':image_data', $image, PDO::PARAM_LOB);
        $statement->bindValue(':content_hash', hash('sha256', $image, true), PDO::PARAM_LOB);
        $statement->bindValue(':updated_by', $identity->userId, PDO::PARAM_INT);
        $statement->execute();
        $this->audit($identity->userId, 'collection.artwork', 'collection', (string) $collectionId, [
            'mime_type' => $mimeType, 'bytes' => strlen($image),
        ]);
        return ['success' => true, 'removed' => false];
    }

    /**
     * Which of the given playlists have an own cover, and at what revision.
     *
     * The revision follows the stored image, so a replaced cover reaches the
     * browser instead of the hour-long cached copy of the previous one.
     *
     * @param array<int, int> $collectionIds
     * @return array<int, string> collection id -> revision token
     */
    private function collectionsWithArtwork(array $collectionIds): array
    {
        if ($collectionIds === [] || !$this->featureTableExists('user_collection_artwork')) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($collectionIds), '?'));
        $statement = $this->database->prepare(
            "SELECT collection_id, LEFT(HEX(content_hash), 16) AS revision
               FROM user_collection_artwork WHERE collection_id IN ({$placeholders})"
        );
        $statement->execute($collectionIds);
        $found = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $found[(int) $row['collection_id']] = (string) $row['revision'];
        }
        return $found;
    }

    /** @return array{mime_type:string,image_data:string}|null */
    public function artwork(int $itemId): ?array
    {
        $this->assertItem($itemId);
        if (!$this->featureTableExists('media_artwork_overrides')) {
            return null;
        }
        $statement = $this->database->prepare(
            'SELECT mime_type, image_data FROM media_artwork_overrides WHERE media_item_id = :item_id LIMIT 1'
        );
        $statement->execute(['item_id' => $itemId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !is_string($row['image_data'] ?? null)) {
            return null;
        }
        return ['mime_type' => (string) $row['mime_type'], 'image_data' => $row['image_data']];
    }

    /** @param array<string, mixed> $payload */
    public function saveArtwork(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_edit_metadata');
        $this->assertFeatureTable('media_artwork_overrides');
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        $this->assertItem($itemId, 'audio');
        $dataUrl = $payload['data_url'] ?? null;
        if ($dataUrl === null) {
            $this->database->prepare(
                'DELETE FROM media_artwork_overrides WHERE media_item_id = :item_id'
            )->execute(['item_id' => $itemId]);
            $this->audit($identity->userId, 'media.artwork_remove', 'media_item', (string) $itemId, null);
            return ['success' => true, 'removed' => true];
        }
        [$mimeType, $image] = self::decodeArtwork($dataUrl);
        $statement = $this->database->prepare(
            'INSERT INTO media_artwork_overrides (media_item_id, mime_type, image_data, content_hash, updated_by)
             VALUES (:item_id, :mime_type, :image_data, :content_hash, :updated_by)
             ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), image_data = VALUES(image_data),
               content_hash = VALUES(content_hash), updated_by = VALUES(updated_by)'
        );
        $statement->bindValue(':item_id', $itemId, PDO::PARAM_INT);
        $statement->bindValue(':mime_type', $mimeType, PDO::PARAM_STR);
        $statement->bindValue(':image_data', $image, PDO::PARAM_LOB);
        $statement->bindValue(':content_hash', hash('sha256', $image, true), PDO::PARAM_LOB);
        $statement->bindValue(':updated_by', $identity->userId, PDO::PARAM_INT);
        $statement->execute();
        $this->audit($identity->userId, 'media.artwork_override', 'media_item', (string) $itemId, [
            'mime_type' => $mimeType, 'bytes' => strlen($image),
        ]);
        return ['success' => true, 'removed' => false];
    }

    /**
     * Validate an uploaded cover and return its type and bytes.
     *
     * The same rules apply to a track cover and to a playlist cover: a data URL
     * of one of three image types, decoding to a bounded, plausibly sized image.
     *
     * @return array{0:string,1:string} mime type and raw image bytes
     */
    private static function decodeArtwork(mixed $dataUrl): array
    {
        if (!is_string($dataUrl) || strlen($dataUrl) > 900000
            || preg_match('#\Adata:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)\z#D', $dataUrl, $matches) !== 1) {
            throw new BridgeRequestException('Nieprawidłowa okładka.');
        }
        $image = base64_decode($matches[2], true);
        if (!is_string($image) || $image === '' || strlen($image) > 650000) {
            throw new BridgeRequestException('Okładka jest zbyt duża.');
        }
        $info = @getimagesizefromstring($image);
        if (!is_array($info) || ($info[0] ?? 0) < 64 || ($info[1] ?? 0) < 64
            || ($info[0] ?? 0) > 2000 || ($info[1] ?? 0) > 2000) {
            throw new BridgeRequestException('Nieprawidłowe wymiary okładki.');
        }
        return [$matches[1], $image];
    }


    /** @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function saveMetadata(LegacyIdentity $identity, array $payload): array
    {
        $this->assertPermission($identity, 'can_edit_metadata');
        $itemId = self::positiveId($payload['media_item_id'] ?? null);
        // Films need this as much as tracks do — a rip is named by whoever ripped
        // it, and the catalogue is the only place a better name can live, because
        // the file itself is never written to. Same five fields either way; what
        // they are called on screen is the interface's business, not this table's.
        $this->assertItem($itemId, ['audio', 'video']);
        $values = [];
        foreach (['title' => 512, 'artist' => 512, 'album' => 512, 'year' => 16, 'genre' => 191] as $key => $max) {
            $values[$key] = self::optionalText($payload[$key] ?? null, $max);
        }
        $statement = $this->database->prepare(
            'INSERT INTO media_metadata_overrides
               (media_item_id, title, artist, album, year, genre, updated_by)
             VALUES (:item_id, :title, :artist, :album, :year, :genre, :updated_by)
             ON DUPLICATE KEY UPDATE title = VALUES(title), artist = VALUES(artist), album = VALUES(album),
               year = VALUES(year), genre = VALUES(genre), updated_by = VALUES(updated_by)'
        );
        $statement->execute($values + ['item_id' => $itemId, 'updated_by' => $identity->userId]);
        $this->audit($identity->userId, 'media.metadata_override', 'media_item', (string) $itemId, $values);
        return ['success' => true, 'metadata' => $values];
    }

    /** @return array<string, mixed> */
    public function adminOverview(LegacyIdentity $identity): array
    {
        self::assertAdmin($identity);
        $users = $this->database->query(
            'SELECT id, username, email, role, is_guest, is_active, permission_group_id,
                    email_verified_at, last_login_at, created_at, updated_at
             FROM users ORDER BY username'
        )->fetchAll(PDO::FETCH_ASSOC);
        $catalog = $this->database->query(
            "SELECT mr.slug, mr.display_name, mr.media_kind,
                    COUNT(mi.id) AS items,
                    SUM(mi.media_kind = 'audio') AS audio,
                    SUM(mi.media_kind = 'video') AS video,
                    SUM(mi.media_kind = 'image') AS images,
                    SUM(mi.media_kind = 'other') AS auxiliary
             FROM media_roots mr
             LEFT JOIN media_items mi ON mi.root_id = mr.id AND mi.deleted_at IS NULL
             GROUP BY mr.id ORDER BY mr.id"
        )->fetchAll(PDO::FETCH_ASSOC);
        $scans = $this->database->query(
            'SELECT cs.id, mr.slug, cs.status, cs.discovered_count, cs.error_count, cs.started_at, cs.finished_at
             FROM catalog_scans cs INNER JOIN media_roots mr ON mr.id = cs.root_id
             ORDER BY cs.id DESC LIMIT 12'
        )->fetchAll(PDO::FETCH_ASSOC);
        // What the metadata worker still has to read. Without this the operator
        // had no way of knowing a scan had queued thousands of files.
        $metadata = ['queued' => 0, 'running' => 0, 'failed' => 0, 'done' => 0];
        foreach ($this->database->query(
            'SELECT status, COUNT(*) AS jobs FROM background_jobs GROUP BY status'
        )->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $status = (string) $row['status'];
            if (array_key_exists($status, $metadata)) {
                $metadata[$status] = (int) $row['jobs'];
            }
        }
        return [
            'users' => $users,
            'catalog' => $catalog,
            'scans' => $scans,
            'metadata' => $metadata,
            'settings' => $this->settingsSnapshot(),
        ];
    }

    /** How many entries one exported file may carry, playlist or ratings alike. */
    private const EXPORT_MAX_ENTRIES = 50000;

    /**
     * One playlist as a file, carrying identifiers rather than paths.
     *
     * The owner chose identifiers over paths, and the reason is what an exported
     * playlist would otherwise give away: `relative_path` is relative to a media
     * root, but it still spells out how the library is arranged, folder by
     * folder, to anybody the file is ever sent to. An identifier says nothing
     * about the disk and comes back exactly, which is what a backup is for.
     *
     * The trade is deliberate and worth stating plainly: **these files are for
     * this server**. VLC will not play them, because `tryhackx:item:9` is not a
     * location on anybody's disk. Titles and durations travel alongside so the
     * file is still readable by a person.
     *
     * @return array{filename:string,mime_type:string,body:string,count:int}
     */
    public function exportCollection(LegacyIdentity $identity, int $collectionId, string $format): array
    {
        $format = self::enumValue($format, ['m3u', 'xspf']);
        $collection = $this->accessibleCollection($identity, $collectionId);
        $this->assertLibraryAccess($identity, (string) $collection['media_kind']);

        $rows = [];
        $page = 1;
        // Read through the same paged reader the interface uses, so a smart list
        // exports exactly what it shows and the rules are evaluated once, here.
        while (count($rows) < self::EXPORT_MAX_ENTRIES) {
            $chunk = $this->collectionPage($identity, $collectionId, $page, 100);
            $items = $chunk['items'] ?? [];
            if ($items === []) {
                break;
            }
            foreach ($items as $item) {
                $rows[] = $item;
                if (count($rows) >= self::EXPORT_MAX_ENTRIES) {
                    break;
                }
            }
            if (!($chunk['has_more'] ?? false)) {
                break;
            }
            $page++;
        }

        // One query for the whole list rather than one per entry: this is the
        // only thing in an exported playlist that means anything in another
        // installation, so it is worth carrying, but not at N round trips.
        $fingerprints = $this->fingerprintsFor(array_map(static fn (array $row): int => (int) $row['id'], $rows));
        $name = self::exportFileName((string) $collection['name'], $format);
        $body = $format === 'xspf'
            ? self::renderXspf((string) $collection['name'], $rows, $fingerprints)
            : self::renderM3u($rows, $fingerprints);
        $this->audit($identity->userId, 'collection.export', 'user_collection', (string) $collectionId, [
            'format' => $format,
            'entries' => count($rows),
        ]);
        return [
            'filename' => $name,
            'mime_type' => $format === 'xspf' ? 'application/xspf+xml' : 'audio/x-mpegurl',
            'body' => $body,
            'count' => count($rows),
        ];
    }

    /**
     * This account's ratings and favourites as CSV.
     *
     * Its own, and only its own: an export that could name another account's
     * ratings would be a way to read them. media_item_id is what the import
     * reads back; the title and artist columns are there so the file can be
     * opened by a person and still mean something.
     *
     * @return array{filename:string,mime_type:string,body:string,count:int}
     */
    public function exportRatings(LegacyIdentity $identity, string $format = 'csv'): array
    {
        $format = self::enumValue($format, ['csv', 'json']);
        $statement = $this->database->prepare(
            "SELECT ur.media_item_id, ur.rating, ur.favorite, mi.content_fingerprint,
                    COALESCE(mo.title, mi.title, '') AS title,
                    COALESCE(mo.artist, mi.artist, '') AS artist,
                    mi.media_kind
             FROM user_ratings ur
             INNER JOIN media_items mi ON mi.id = ur.media_item_id AND mi.deleted_at IS NULL
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             WHERE ur.user_id = :user_id AND (ur.rating IS NOT NULL OR ur.favorite = 1)
             ORDER BY ur.media_item_id
             LIMIT " . self::EXPORT_MAX_ENTRIES
        );
        $statement->execute(['user_id' => $identity->userId]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        $this->audit($identity->userId, 'ratings.export', 'user', (string) $identity->userId, [
            'entries' => count($rows),
            'format' => $format,
        ]);

        if ($format === 'json') {
            // JSON keeps the types the data actually has — a rating is a number
            // and a favourite is a boolean — where CSV flattens everything to
            // text and leaves the reader to guess. It is the better format to
            // read back; CSV is the better one to open in a spreadsheet, which
            // is why both are offered rather than one replacing the other.
            $entries = array_map(
                static fn (array $row): array => [
                    'media_item_id' => (int) $row['media_item_id'],
                    // Identifies the file itself, so this row still means
                    // something in an installation that never saw our ids.
                    'fingerprint' => $row['content_fingerprint'] === null ? null : (string) $row['content_fingerprint'],
                    'media_kind' => (string) $row['media_kind'],
                    'title' => (string) $row['title'],
                    'artist' => ((string) $row['artist']) === '' ? null : (string) $row['artist'],
                    'rating' => $row['rating'] === null ? null : (float) $row['rating'],
                    'favorite' => (int) $row['favorite'] === 1,
                ],
                $rows
            );
            $document = [
                // Named and versioned, so an importer can tell this file apart
                // from any other JSON somebody drops on it.
                'format' => 'tryhackx-media-ratings',
                'version' => 1,
                'exported_at' => gmdate('c'),
                'count' => count($entries),
                'entries' => $entries,
            ];
            return [
                'filename' => 'oceny-' . date('Y-m-d') . '.json',
                'mime_type' => 'application/json; charset=utf-8',
                'body' => json_encode($document, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n",
                'count' => count($entries),
            ];
        }

        $lines = ['media_item_id,fingerprint,media_kind,title,artist,rating,favorite'];
        foreach ($rows as $row) {
            $lines[] = implode(',', [
                (int) $row['media_item_id'],
                self::csvField((string) ($row['content_fingerprint'] ?? '')),
                self::csvField((string) $row['media_kind']),
                self::csvField((string) $row['title']),
                self::csvField((string) $row['artist']),
                $row['rating'] === null ? '' : number_format((float) $row['rating'], 1, '.', ''),
                (int) $row['favorite'] === 1 ? '1' : '0',
            ]);
        }
        return [
            'filename' => 'oceny-' . date('Y-m-d') . '.csv',
            'mime_type' => 'text/csv; charset=utf-8',
            // A BOM, because this file is opened in Excel more often than not and
            // without one every Polish character in it arrives broken.
            'body' => "\xEF\xBB\xBF" . implode("\r\n", $lines) . "\r\n",
            'count' => count($rows),
        ];
    }

    /**
     * Fingerprints for a set of items, keyed by id.
     *
     * @param list<int> $itemIds
     * @return array<int, string>
     */
    private function fingerprintsFor(array $itemIds): array
    {
        if ($itemIds === []) {
            return [];
        }
        $placeholders = implode(', ', array_fill(0, count($itemIds), '?'));
        $statement = $this->database->prepare(
            "SELECT id, content_fingerprint FROM media_items
             WHERE id IN ({$placeholders}) AND content_fingerprint IS NOT NULL"
        );
        $statement->execute($itemIds);
        $found = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $found[(int) $row['id']] = (string) $row['content_fingerprint'];
        }
        return $found;
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @param array<int, string> $fingerprints
     */
    private static function renderM3u(array $rows, array $fingerprints = []): string
    {
        $lines = ['#EXTM3U'];
        foreach ($rows as $row) {
            $seconds = (int) round(((int) ($row['duration_ms'] ?? 0)) / 1000);
            $label = trim((string) ($row['artist'] ?? '')) !== ''
                ? $row['artist'] . ' - ' . $row['title']
                : (string) $row['title'];
            // Newlines in a title would forge extra entries; nothing else in an
            // EXTINF line can hurt a parser.
            $lines[] = '#EXTINF:' . ($seconds > 0 ? $seconds : -1) . ',' . str_replace(["\r", "\n"], ' ', $label);
            // A comment, so every M3U reader ignores it and ours can use it to
            // find the same file in a library that has never seen our ids.
            if (isset($fingerprints[(int) $row['id']])) {
                $lines[] = '#TRYHACKX-FINGERPRINT:' . $fingerprints[(int) $row['id']];
            }
            $lines[] = 'tryhackx:item:' . (int) $row['id'];
        }
        return implode("\n", $lines) . "\n";
    }

    /**
     * @param array<int, array<string, mixed>> $rows
     * @param array<int, string> $fingerprints
     */
    private static function renderXspf(string $title, array $rows, array $fingerprints = []): string
    {
        $escape = static fn (string $value): string => htmlspecialchars($value, ENT_XML1 | ENT_QUOTES, 'UTF-8');
        $parts = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
            '  <title>' . $escape($title) . '</title>',
            '  <trackList>',
        ];
        foreach ($rows as $row) {
            $parts[] = '    <track>';
            // <identifier> is exactly what XSPF has for "the sender's own id";
            // <location> is deliberately absent, because that is the field that
            // would carry a path.
            $parts[] = '      <identifier>tryhackx:item:' . (int) $row['id'] . '</identifier>';
            // <meta> is XSPF's own slot for "something the sender knows"; it is
            // the fingerprint that makes this file mean anything elsewhere.
            if (isset($fingerprints[(int) $row['id']])) {
                $parts[] = '      <meta rel="urn:tryhackx:fingerprint">' . $fingerprints[(int) $row['id']] . '</meta>';
            }
            $parts[] = '      <title>' . $escape((string) $row['title']) . '</title>';
            if (trim((string) ($row['artist'] ?? '')) !== '') {
                $parts[] = '      <creator>' . $escape((string) $row['artist']) . '</creator>';
            }
            if ((int) ($row['duration_ms'] ?? 0) > 0) {
                $parts[] = '      <duration>' . (int) $row['duration_ms'] . '</duration>';
            }
            $parts[] = '    </track>';
        }
        $parts[] = '  </trackList>';
        $parts[] = '</playlist>';
        return implode("\n", $parts) . "\n";
    }

    /** A CSV field, quoted the way every spreadsheet expects. */
    private static function csvField(string $value): string
    {
        $clean = str_replace(["\r", "\n"], ' ', $value);
        return '"' . str_replace('"', '""', $clean) . '"';
    }

    /** A download name that survives every filesystem and reveals no path. */
    private static function exportFileName(string $collectionName, string $format): string
    {
        $safe = preg_replace('/[^\p{L}\p{N} _-]+/u', '', $collectionName) ?? '';
        $safe = trim((string) preg_replace('/\s+/u', ' ', $safe));
        if ($safe === '') {
            $safe = 'playlista';
        }
        return mb_substr($safe, 0, 60) . '.' . $format;
    }

    /**
     * The review queue folded up by the folder each work sits in.
     *
     * A cartoon anthology is 515 separate works and a cartoon series is 303, and
     * every one of them is the same decision: they are all Looney Tunes, they
     * are all Smerfy. Clicking that through one card at a time is not review,
     * it is data entry — so the same queue can be read as folders, and a genre
     * set on a folder lands on everything in it.
     *
     * Grouping is by the **top** folder, because that is the level a person
     * thinks in ("this whole shelf is Smerfy"), and the sample titles are there
     * so the choice is made against something concrete rather than a count.
     *
     * @return array<string, mixed>
     */
    public function titleLookupFolders(LegacyIdentity $identity, string $status = 'review'): array
    {
        self::assertAdmin($identity);
        $status = self::enumValue($status, ['review', 'none', 'failed', 'pending', 'all']);
        $where = $status === 'all' ? "mtl.status IN ('review', 'none', 'failed', 'pending')" : 'mtl.status = :status';
        $statement = $this->database->prepare(
            "SELECT SUBSTRING_INDEX(mi.relative_path, '/', 1) AS folder,
                    COUNT(DISTINCT mtl.id) AS works,
                    COUNT(DISTINCT mi.id) AS files,
                    SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT mtl.query_title ORDER BY mtl.id SEPARATOR '\n'), '\n', 4) AS samples
             FROM media_title_lookups mtl
             INNER JOIN media_items mi
               ON mi.root_id = mtl.root_id AND mi.title_subject_hash = mtl.subject_hash
              AND mi.media_kind = 'video' AND mi.deleted_at IS NULL
             WHERE {$where}
             GROUP BY folder
             HAVING works > 1
             ORDER BY works DESC
             LIMIT 60"
        );
        if ($status !== 'all') {
            $statement->bindValue(':status', $status, PDO::PARAM_STR);
        }
        $statement->execute();
        $folders = array_map(
            static fn (array $row): array => [
                'folder' => (string) $row['folder'],
                'works' => (int) $row['works'],
                'files' => (int) $row['files'],
                'samples' => array_slice(array_filter(explode("\n", (string) ($row['samples'] ?? ''))), 0, 4),
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
        return ['folders' => $folders, 'genres' => $this->genreDictionary()];
    }

    /**
     * The individual works inside one folder, so years can differ per episode.
     *
     * A shelf shares its genre — every Smerfy episode is animation — but not its
     * year, and a cartoon run spans decades. So the folder sets the genre once
     * and this is what lets a year be typed against the episode it belongs to,
     * without leaving the folder view to find it.
     *
     * @return array<string, mixed>
     */
    public function titleLookupFolderWorks(
        LegacyIdentity $identity,
        string $folder,
        string $status = 'review'
    ): array {
        self::assertAdmin($identity);
        if (trim($folder) === '' || mb_strlen($folder) > 512) {
            throw new BridgeRequestException('Nieprawidłowy folder.');
        }
        $status = self::enumValue($status, ['review', 'none', 'failed', 'pending']);
        $statement = $this->database->prepare(
            "SELECT mtl.id, mtl.query_title, mtl.query_year, mtl.item_count,
                    MIN(mi.relative_path) AS sample_path,
                    MAX(mi.release_year) AS current_year
             FROM media_title_lookups mtl
             INNER JOIN media_items mi
               ON mi.root_id = mtl.root_id AND mi.title_subject_hash = mtl.subject_hash
              AND mi.media_kind = 'video' AND mi.deleted_at IS NULL
             WHERE mtl.status = :status
               AND SUBSTRING_INDEX(mi.relative_path, '/', 1) = :folder
             GROUP BY mtl.id, mtl.query_title, mtl.query_year, mtl.item_count
             ORDER BY sample_path
             LIMIT 500"
        );
        $statement->execute(['status' => $status, 'folder' => $folder]);
        return [
            'folder' => $folder,
            'works' => array_map(
                static fn (array $row): array => [
                    'id' => (int) $row['id'],
                    'title' => (string) $row['query_title'],
                    'path' => (string) $row['sample_path'],
                    'item_count' => (int) $row['item_count'],
                    'year' => $row['current_year'] === null ? null : (int) $row['current_year'],
                ],
                $statement->fetchAll(PDO::FETCH_ASSOC)
            ),
        ];
    }

    /**
     * Set one genre and year across every unsettled work in a folder.
     *
     * Only the works still waiting are touched: a decision already made by hand
     * is not overruled by a sweep, and neither is a confident automatic match
     * unless it is in the status being swept. Everything written says 'manual',
     * which is what stops the next lookup run from undoing it.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function decideTitleLookupFolder(LegacyIdentity $identity, array $payload): array
    {
        self::assertAdmin($identity);
        $folder = $payload['folder'] ?? null;
        if (!is_string($folder) || trim($folder) === '' || mb_strlen($folder) > 512) {
            throw new BridgeRequestException('Nieprawidłowy folder.');
        }
        $status = self::enumValue($payload['status'] ?? 'review', ['review', 'none', 'failed', 'pending']);
        $genreIds = self::genreIdList($payload['genres'] ?? null);
        $year = filter_var(
            $payload['year'] ?? null,
            FILTER_VALIDATE_INT,
            ['options' => ['min_range' => 1888, 'max_range' => 2049]]
        );
        // Years typed against individual works, as {lookup_id: year}. The genre
        // is the folder's; the year usually is not, because a cartoon run spans
        // decades and every episode of it is still animation.
        $perWork = [];
        foreach ((array) ($payload['years'] ?? []) as $lookupId => $value) {
            $id = (int) $lookupId;
            $parsed = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1888, 'max_range' => 2049]]);
            if ($id > 0 && is_int($parsed)) {
                $perWork[$id] = $parsed;
            }
        }
        if ($genreIds === [] && !is_int($year) && $perWork === []) {
            throw new BridgeRequestException('Wybierz gatunek albo podaj rok.');
        }

        // Which works, and which files under them. One query each rather than a
        // round trip per work: this runs over five hundred of them at a time.
        $statement = $this->database->prepare(
            "SELECT DISTINCT mtl.id AS lookup_id, mi.id AS item_id
             FROM media_title_lookups mtl
             INNER JOIN media_items mi
               ON mi.root_id = mtl.root_id AND mi.title_subject_hash = mtl.subject_hash
              AND mi.media_kind = 'video' AND mi.deleted_at IS NULL
             WHERE mtl.status = :status
               AND mtl.source <> 'manual'
               AND SUBSTRING_INDEX(mi.relative_path, '/', 1) = :folder"
        );
        $statement->execute(['status' => $status, 'folder' => $folder]);
        $lookupIds = [];
        $itemIds = [];
        $itemsByLookup = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $lookupIds[(int) $row['lookup_id']] = true;
            $itemIds[(int) $row['item_id']] = true;
            $itemsByLookup[(int) $row['lookup_id']][] = (int) $row['item_id'];
        }
        if ($itemIds === []) {
            throw new BridgeRequestException('W tym folderze nie ma nic do ustawienia.');
        }
        $lookupIds = array_keys($lookupIds);
        $itemIds = array_keys($itemIds);

        $this->database->beginTransaction();
        try {
            foreach (array_chunk($itemIds, 500) as $chunk) {
                $placeholders = implode(', ', array_fill(0, count($chunk), '?'));
                if (is_int($year)) {
                    $this->database
                        ->prepare("UPDATE media_items SET release_year = ?, release_year_source = 'manual'
                                   WHERE id IN ({$placeholders})")
                        ->execute([$year, ...$chunk]);
                }
                $this->database
                    ->prepare("DELETE FROM media_item_genres WHERE media_item_id IN ({$placeholders})")
                    ->execute($chunk);
                if ($genreIds !== []) {
                    $values = [];
                    $parameters = [];
                    foreach ($chunk as $itemId) {
                        foreach ($genreIds as $genreId) {
                            $values[] = '(?, ?, ' . "'manual'" . ')';
                            $parameters[] = $itemId;
                            $parameters[] = $genreId;
                        }
                    }
                    $this->database
                        ->prepare('INSERT IGNORE INTO media_item_genres (media_item_id, genre_id, source) VALUES '
                            . implode(', ', $values))
                        ->execute($parameters);
                }
            }
            // A year typed against one work wins over the folder's, because it
            // was typed later and about something narrower.
            foreach ($perWork as $lookupId => $workYear) {
                $items = $itemsByLookup[$lookupId] ?? [];
                if ($items === []) {
                    continue;
                }
                $placeholders = implode(', ', array_fill(0, count($items), '?'));
                $this->database
                    ->prepare("UPDATE media_items SET release_year = ?, release_year_source = 'manual'
                               WHERE id IN ({$placeholders})")
                    ->execute([$workYear, ...$items]);
            }
            foreach (array_chunk($lookupIds, 500) as $chunk) {
                $placeholders = implode(', ', array_fill(0, count($chunk), '?'));
                $this->database
                    ->prepare("UPDATE media_title_lookups
                               SET status = 'matched', source = 'manual', confidence = 100,
                                   decided_by = ?, decided_at = CURRENT_TIMESTAMP(6)
                               WHERE id IN ({$placeholders})")
                    ->execute([$identity->userId, ...$chunk]);
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }

        $this->audit($identity->userId, 'catalog.title_lookup_folder', 'media_title_lookup', null, [
            'folder' => $folder,
            'works' => count($lookupIds),
            'files' => count($itemIds),
        ]);
        return ['success' => true, 'works' => count($lookupIds), 'files' => count($itemIds)];
    }

    /**
     * Works whose genre the lookup could not settle, with what it did find.
     *
     * This is the queue the owner asked for: the matcher writes a genre down by
     * itself only when title, year and runtime agree, and everything short of
     * that lands here instead — with the alternatives it weighed, so that
     * confirming one is a click rather than a search.
     *
     * @return array<string, mixed>
     */
    public function titleLookups(
        LegacyIdentity $identity,
        string $status = 'review',
        int $page = 1,
        int $limit = 25
    ): array {
        self::assertAdmin($identity);
        if ($page < 1 || $page > 10000 || $limit < 1 || $limit > 100) {
            throw new BridgeRequestException('Nieprawidłowa paginacja.');
        }
        $status = self::enumValue($status, ['review', 'none', 'failed', 'matched', 'pending', 'skipped', 'all']);
        $where = $status === 'all' ? '1 = 1' : 'mtl.status = :status';
        $params = $status === 'all' ? [] : ['status' => $status];

        $totals = $this->database->query(
            'SELECT status, COUNT(*) AS entries FROM media_title_lookups GROUP BY status'
        )->fetchAll(PDO::FETCH_ASSOC);
        $counts = [];
        foreach ($totals as $row) {
            $counts[(string) $row['status']] = (int) $row['entries'];
        }

        $countStatement = $this->database->prepare(
            "SELECT COUNT(*) FROM media_title_lookups mtl WHERE {$where}"
        );
        $countStatement->execute($params);
        $total = (int) $countStatement->fetchColumn();

        $statement = $this->database->prepare(
            "SELECT mtl.id, mtl.subject_key, mtl.is_episode, mtl.query_title, mtl.query_year,
                    mtl.status, mtl.external_id, mtl.external_url, mtl.matched_title, mtl.matched_year,
                    mtl.confidence, mtl.item_count, mtl.reasons_json, mtl.candidates_json,
                    mtl.last_error, mtl.checked_at, mtl.decided_at, u.username AS decided_by,
                    -- Where the work actually sits. The subject key alone is a
                    -- bare file name, which nobody can find on a disk once the
                    -- library is a few hundred folders deep.
                    (SELECT MIN(mi.relative_path) FROM media_items mi
                      WHERE mi.root_id = mtl.root_id AND mi.title_subject_hash = mtl.subject_hash
                        AND mi.media_kind = 'video' AND mi.deleted_at IS NULL) AS sample_path
             FROM media_title_lookups mtl
             LEFT JOIN users u ON u.id = mtl.decided_by
             WHERE {$where}
             ORDER BY mtl.confidence DESC, mtl.id ASC
             LIMIT :row_limit OFFSET :row_offset"
        );
        foreach ($params as $name => $value) {
            $statement->bindValue(':' . $name, $value, PDO::PARAM_STR);
        }
        $statement->bindValue(':row_limit', $limit, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', ($page - 1) * $limit, PDO::PARAM_INT);
        $statement->execute();

        // Filmweb's genre numbers and this catalogue's are two different
        // numberings that happen to overlap, and telling them apart is not
        // something a client should be trusted with: read as ours, Filmweb's
        // "Horror" (12) is "Dokumentalny" and its "Dramat" (6) is "Biblijny",
        // which is exactly how the review screen used to mislabel every
        // candidate. So the names are resolved here, once, and what leaves this
        // method carries no foreign identifier to be misread.
        $byFilmweb = [];
        foreach ($this->genreDictionary() as $genre) {
            if ($genre['filmweb_id'] !== null) {
                $byFilmweb[(int) $genre['filmweb_id']] = $genre;
            }
        }

        $entries = array_map(
            static function (array $row) use ($byFilmweb): array {
                $candidates = $row['candidates_json'] === null
                    ? []
                    : (json_decode((string) $row['candidates_json'], true) ?: []);
                foreach ($candidates as $index => $candidate) {
                    if (!is_array($candidate)) {
                        continue;
                    }
                    $named = [];
                    foreach ((array) ($candidate['genre_ids'] ?? []) as $filmwebId) {
                        $match = $byFilmweb[(int) $filmwebId] ?? null;
                        if ($match !== null) {
                            $named[] = ['slug' => $match['slug'], 'name_pl' => $match['name_pl'], 'name_en' => $match['name_en']];
                        }
                    }
                    $candidates[$index]['genres'] = $named;
                }
                $reasons = $row['reasons_json'] === null
                    ? []
                    : (json_decode((string) $row['reasons_json'], true) ?: []);
                return [
                    'id' => (int) $row['id'],
                    'subject' => (string) $row['subject_key'],
                    'path' => (string) ($row['sample_path'] ?? ''),
                    'is_episode' => (int) $row['is_episode'] === 1,
                    'query_title' => (string) $row['query_title'],
                    'query_year' => $row['query_year'] === null ? null : (int) $row['query_year'],
                    'status' => (string) $row['status'],
                    'external_url' => $row['external_url'],
                    'matched_title' => $row['matched_title'],
                    'matched_year' => $row['matched_year'] === null ? null : (int) $row['matched_year'],
                    'confidence' => (int) $row['confidence'],
                    'item_count' => (int) $row['item_count'],
                    'reasons' => is_array($reasons) ? $reasons : [],
                    'candidates' => is_array($candidates) ? $candidates : [],
                    'last_error' => $row['last_error'],
                    'checked_at' => $row['checked_at'],
                    'decided_at' => $row['decided_at'],
                    'decided_by' => $row['decided_by'],
                ];
            },
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );

        return [
            'entries' => $entries,
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'counts' => $counts,
            'genres' => $this->genreDictionary(),
        ];
    }

    /**
     * Settle one uncertain lookup by hand.
     *
     * Nothing here goes back to Filmweb. Every candidate the matcher weighed was
     * stored with its genres when the lookup ran, so confirming one is a local
     * write — which also means the panel answers instantly and works with the
     * network unplugged.
     *
     * Three decisions are possible: take one of the candidates, clear the work
     * of any external genre ('skipped', for home video and things Filmweb has
     * never heard of), or set the genres by hand.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function decideTitleLookup(LegacyIdentity $identity, array $payload): array
    {
        self::assertAdmin($identity);
        $id = filter_var($payload['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($id)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator dopasowania.');
        }
        $decision = self::enumValue($payload['decision'] ?? 'confirm', ['confirm', 'skip', 'manual']);

        $statement = $this->database->prepare(
            'SELECT id, root_id, subject_hash, candidates_json FROM media_title_lookups WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $lookup = $statement->fetch(PDO::FETCH_ASSOC);
        if ($lookup === false) {
            throw new BridgeRequestException('Nie znaleziono takiego dopasowania.');
        }

        if ($decision === 'skip') {
            $this->writeItemGenres((int) $lookup['root_id'], (string) $lookup['subject_hash'], [], null);
            $this->closeLookup($id, 'skipped', $identity, null);
            return ['success' => true, 'status' => 'skipped'];
        }

        if ($decision === 'manual') {
            $genreIds = self::genreIdList($payload['genres'] ?? null);
            $year = filter_var($payload['year'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1888, 'max_range' => 2049]]);
            $this->writeItemGenres(
                (int) $lookup['root_id'],
                (string) $lookup['subject_hash'],
                $genreIds,
                is_int($year) ? $year : null
            );
            $this->closeLookup($id, 'matched', $identity, null);
            return ['success' => true, 'status' => 'matched'];
        }

        $filmwebId = filter_var($payload['filmweb_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $candidates = $lookup['candidates_json'] === null
            ? []
            : (json_decode((string) $lookup['candidates_json'], true) ?: []);
        $chosen = null;
        foreach (is_array($candidates) ? $candidates : [] as $candidate) {
            if (is_array($candidate) && (int) ($candidate['filmweb_id'] ?? 0) === $filmwebId) {
                $chosen = $candidate;
                break;
            }
        }
        if ($chosen === null) {
            throw new BridgeRequestException('Ta pozycja nie była wśród propozycji.');
        }
        $genreIds = $this->genreIdsForFilmweb(array_map('intval', (array) ($chosen['genre_ids'] ?? [])));
        $year = isset($chosen['year']) ? (int) $chosen['year'] : null;
        $this->writeItemGenres(
            (int) $lookup['root_id'],
            (string) $lookup['subject_hash'],
            $genreIds,
            $year > 0 ? $year : null
        );
        $this->closeLookup($id, 'matched', $identity, $chosen);
        return ['success' => true, 'status' => 'matched'];
    }

    /** @return list<array{id:int,slug:string,name_pl:string,name_en:string}> */
    private function genreDictionary(): array
    {
        $rows = $this->database
            ->query('SELECT id, slug, name_pl, name_en, filmweb_id FROM media_genres ORDER BY name_pl ASC')
            ->fetchAll(PDO::FETCH_ASSOC);
        return array_map(
            static fn (array $row): array => [
                'id' => (int) $row['id'],
                'slug' => (string) $row['slug'],
                'name_pl' => (string) $row['name_pl'],
                'name_en' => (string) $row['name_en'],
                'filmweb_id' => $row['filmweb_id'] === null ? null : (int) $row['filmweb_id'],
            ],
            $rows
        );
    }

    /**
     * @param list<int> $filmwebIds
     * @return list<int>
     */
    private function genreIdsForFilmweb(array $filmwebIds): array
    {
        $filmwebIds = array_values(array_filter($filmwebIds, static fn (int $id): bool => $id > 0));
        if ($filmwebIds === []) {
            return [];
        }
        $placeholders = implode(', ', array_fill(0, count($filmwebIds), '?'));
        $statement = $this->database->prepare(
            "SELECT id FROM media_genres WHERE filmweb_id IN ({$placeholders})"
        );
        $statement->execute($filmwebIds);
        return array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN));
    }

    /**
     * Put a decided genre set and year onto every file of one work.
     *
     * Written with source 'manual', which is what makes it stick: neither a
     * rescan nor a later lookup may touch a row whose source says a person put
     * it there.
     *
     * @param list<int> $genreIds
     */
    private function writeItemGenres(int $rootId, string $subjectHash, array $genreIds, ?int $year): void
    {
        $statement = $this->database->prepare(
            "SELECT id FROM media_items
             WHERE root_id = :root_id AND title_subject_hash = :subject_hash
               AND media_kind = 'video' AND deleted_at IS NULL"
        );
        $statement->bindValue(':root_id', $rootId, PDO::PARAM_INT);
        $statement->bindValue(':subject_hash', $subjectHash, PDO::PARAM_LOB);
        $statement->execute();
        $itemIds = array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN));
        if ($itemIds === []) {
            return;
        }
        $placeholders = implode(', ', array_fill(0, count($itemIds), '?'));

        $this->database->beginTransaction();
        try {
            if ($year !== null) {
                $update = $this->database->prepare(
                    "UPDATE media_items SET release_year = ?, release_year_source = 'manual'
                     WHERE id IN ({$placeholders})"
                );
                $update->execute([$year, ...$itemIds]);
            }
            $this->database
                ->prepare("DELETE FROM media_item_genres WHERE media_item_id IN ({$placeholders})")
                ->execute($itemIds);
            if ($genreIds !== []) {
                $insert = $this->database->prepare(
                    "INSERT IGNORE INTO media_item_genres (media_item_id, genre_id, source) VALUES (?, ?, 'manual')"
                );
                foreach ($itemIds as $itemId) {
                    foreach ($genreIds as $genreId) {
                        $insert->execute([$itemId, $genreId]);
                    }
                }
            }
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
    }

    /** @param array<string, mixed>|null $chosen */
    private function closeLookup(int $id, string $status, LegacyIdentity $identity, ?array $chosen): void
    {
        $statement = $this->database->prepare(
            'UPDATE media_title_lookups
             SET status = :status, source = :source, confidence = 100,
                 external_id = :external_id, external_url = :external_url,
                 matched_title = :matched_title, matched_year = :matched_year,
                 decided_by = :decided_by, decided_at = CURRENT_TIMESTAMP(6)
             WHERE id = :id'
        );
        $statement->execute([
            'status' => $status,
            'source' => 'manual',
            'external_id' => $chosen === null ? null : (string) ($chosen['filmweb_id'] ?? ''),
            'external_url' => $chosen === null ? null : (string) ($chosen['url'] ?? ''),
            'matched_title' => $chosen === null ? null : (string) ($chosen['title'] ?? ''),
            'matched_year' => $chosen === null ? null : ((int) ($chosen['year'] ?? 0) ?: null),
            'decided_by' => $identity->userId,
            'id' => $id,
        ]);
        $this->audit($identity->userId, 'catalog.title_lookup', 'media_title_lookup', (string) $id, ['status' => $status]);
    }

    /**
     * The audit trail, page by page: who did what, to what, and when.
     *
     * The log has been written since the first milestone but had no reader, so
     * the only way to see it was a SQL client. Filtering happens on indexed
     * columns (actor, then time); the action list is small enough to gather with
     * one grouped query, which also gives the filter its counts.
     *
     * @return array<string, mixed>
     */
    public function activityLog(
        LegacyIdentity $identity,
        string $action = '',
        ?int $actorId = null,
        int $page = 1,
        int $limit = 25
    ): array {
        self::assertAdmin($identity);
        if ($page < 1 || $page > 10000 || $limit < 1 || $limit > 100) {
            throw new BridgeRequestException('Nieprawidłowa paginacja dziennika.');
        }
        if ($action !== '' && preg_match('/^[a-z_]+\.[a-z_]+$/D', $action) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy rodzaj zdarzenia.');
        }
        $where = [];
        $params = [];
        if ($action !== '') {
            $where[] = 'al.action = :action';
            $params['action'] = $action;
        }
        if ($actorId !== null) {
            if ($actorId < 1) {
                throw new BridgeRequestException('Nieprawidłowe konto w filtrze.');
            }
            $where[] = 'al.actor_user_id = :actor_id';
            $params['actor_id'] = $actorId;
        }
        $filter = $where === [] ? '' : ' WHERE ' . implode(' AND ', $where);
        $statement = $this->database->prepare(
            'SELECT al.id, al.actor_user_id, u.username AS actor_name, al.action, al.target_type,
                    al.target_id, al.details_json, al.created_at
             FROM audit_log al
             LEFT JOIN users u ON u.id = al.actor_user_id' . $filter .
            ' ORDER BY al.id DESC
              LIMIT :row_limit OFFSET :row_offset'
        );
        foreach ($params as $key => $value) {
            $statement->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', ($page - 1) * $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            array_pop($rows);
        }
        $counted = $this->database->prepare(
            'SELECT COUNT(*) FROM audit_log al' . $filter
        );
        foreach ($params as $key => $value) {
            $counted->bindValue(':' . $key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $counted->execute();
        return [
            'entries' => array_map(static function (array $row): array {
                $details = $row['details_json'] === null
                    ? null
                    : json_decode((string) $row['details_json'], true);
                return [
                    'id' => (int) $row['id'],
                    'actor_id' => $row['actor_user_id'] === null ? null : (int) $row['actor_user_id'],
                    // Null once the account is gone: the entry stays, the name does not.
                    'actor_name' => is_string($row['actor_name']) ? $row['actor_name'] : null,
                    'action' => (string) $row['action'],
                    'target_type' => (string) $row['target_type'],
                    'target_id' => $row['target_id'] === null ? null : (string) $row['target_id'],
                    'details' => is_array($details) ? $details : null,
                    'created_at' => (string) $row['created_at'],
                ];
            }, $rows),
            'page' => $page,
            'has_more' => $hasMore,
            'total' => (int) $counted->fetchColumn(),
            'actions' => array_map(
                static fn (array $row): array => ['value' => (string) $row['action'], 'count' => (int) $row['entries']],
                $this->database->query(
                    'SELECT action, COUNT(*) AS entries FROM audit_log GROUP BY action ORDER BY entries DESC'
                )->fetchAll(PDO::FETCH_ASSOC)
            ),
            'retention_days' => self::AUDIT_RETENTION_DAYS,
        ];
    }

    /** @param array<string, mixed> $payload */
    public function saveAdminSettings(LegacyIdentity $identity, array $payload): array
    {
        self::assertAdmin($identity);
        $this->assertFeatureTable('app_settings');
        $sorts = self::LIBRARY_SORTS;
        $musicSort = self::enumValue($payload['music_sort'] ?? null, $sorts);
        $moviesSort = self::enumValue($payload['movies_sort'] ?? null, $sorts);
        $pageSize = self::boundedNumber($payload['account_page_size'] ?? null, 10, 100, true);
        $audioProfiles = ['stereo_low', 'stereo_standard', 'stereo_high', 'surround_aac'];
        $audioProfile = self::enumValue($payload['compatibility_audio_profile'] ?? null, $audioProfiles);
        $videoProfiles = ['native_copy', 'h264_fallback'];
        $videoProfile = self::enumValue($payload['compatibility_video_profile'] ?? null, $videoProfiles);
        $playbackThreshold = self::boundedNumber($payload['playback_threshold_percent'] ?? null, 1, 100, true);
        $visualizerIds = self::VISUALIZER_IDS;
        // Accept any subset and fill the rest in canonical order rather than
        // demanding an exact-length list. A browser still running a cached bundle
        // knows fewer plugins than the server does, and an exact match turned that
        // into a save that failed for reasons the operator could not see.
        $visualizerOrder = $payload['visualizer_order'] ?? null;
        if (!is_array($visualizerOrder) || !array_is_list($visualizerOrder)
            || count(array_unique($visualizerOrder)) !== count($visualizerOrder)
            || array_diff($visualizerOrder, $visualizerIds) !== []) {
            throw new BridgeRequestException('Invalid visualizer order.');
        }
        foreach ($visualizerIds as $knownId) {
            if (!in_array($knownId, $visualizerOrder, true)) {
                $visualizerOrder[] = $knownId;
            }
        }
        $visualizerEnabled = $payload['visualizer_enabled'] ?? null;
        if (!is_array($visualizerEnabled) || !array_is_list($visualizerEnabled)
            || count(array_unique($visualizerEnabled)) !== count($visualizerEnabled)
            || array_diff($visualizerEnabled, $visualizerIds) !== []) {
            throw new BridgeRequestException('Invalid enabled visualizers.');
        }
        // A plugin the client never heard of stays enabled instead of being
        // switched off by an older panel that simply could not list it.
        $clientKnew = is_array($payload['visualizer_order'] ?? null) ? $payload['visualizer_order'] : [];
        foreach (array_diff($visualizerIds, $clientKnew) as $missingId) {
            if (!in_array($missingId, $visualizerEnabled, true)) {
                $visualizerEnabled[] = $missingId;
            }
        }
        // Absent means "leave unchanged", not "off". A panel that predates these
        // fields must not silently switch registration and the captcha back off
        // every time somebody saves an unrelated setting.
        $securityUpdates = [];
        foreach (['registration_enabled', 'registration_requires_activation',
            'captcha_protect_login', 'captcha_protect_registration', 'dock_collapse_desktop',
            'guest_links_enabled'] as $key) {
            if (array_key_exists($key, $payload)) {
                if (!is_bool($payload[$key])) {
                    throw new BridgeRequestException("Invalid flag: {$key}.");
                }
                $securityUpdates[$key] = $payload[$key] ? '1' : '0';
            }
        }
        if (array_key_exists('registration_default_role', $payload)) {
            if (!in_array($payload['registration_default_role'], ['user', 'admin', 'super_admin'], true)) {
                throw new BridgeRequestException('Invalid registration role.');
            }
            // Minting privileged accounts is a super_admin-only capability
            // (see createUser). Registration would otherwise let a plain admin
            // set the default role to super_admin and self-register into it.
            if ($payload['registration_default_role'] !== 'user' && $identity->role !== 'super_admin') {
                throw new BridgeAuthorizationException('Tylko superadministrator może ustawić rolę wyższą niż użytkownik.');
            }
            $securityUpdates['registration_default_role'] = (string) $payload['registration_default_role'];
        }
        if (array_key_exists('captcha_provider', $payload)) {
            if (!in_array($payload['captcha_provider'], CaptchaGuard::providers(), true)) {
                throw new BridgeRequestException('Invalid captcha provider.');
            }
            $securityUpdates['captcha_provider'] = (string) $payload['captcha_provider'];
        }
        if (array_key_exists('captcha_site_key', $payload)) {
            if (!is_string($payload['captcha_site_key']) || strlen($payload['captcha_site_key']) > 191) {
                throw new BridgeRequestException('Invalid captcha site key.');
            }
            $securityUpdates['captcha_site_key'] = $payload['captcha_site_key'];
        }
        // Absent means "leave as is" and empty string means "clear it", so an
        // admin can save the form without retyping a secret they cannot read.
        if (array_key_exists('captcha_secret_key', $payload)) {
            if (!is_string($payload['captcha_secret_key']) || strlen($payload['captcha_secret_key']) > 191) {
                throw new BridgeRequestException('Invalid captcha secret.');
            }
            $securityUpdates['captcha_secret_key'] = $payload['captcha_secret_key'];
        }
        // Global download quota: a count inside a rolling window of N minutes.
        // The legacy per-hour key is accepted from older panels and mapped over.
        if (array_key_exists('download_rate_limit', $payload)) {
            $securityUpdates['download_rate_limit'] = (string) self::boundedNumber(
                $payload['download_rate_limit'], 0, 10000, true
            );
        } elseif (array_key_exists('download_rate_limit_per_hour', $payload)) {
            $securityUpdates['download_rate_limit'] = (string) self::boundedNumber(
                $payload['download_rate_limit_per_hour'], 0, 10000, true
            );
        }
        if (array_key_exists('download_rate_window_minutes', $payload)) {
            $securityUpdates['download_rate_window_minutes'] = (string) self::boundedNumber(
                $payload['download_rate_window_minutes'], 1, 10080, true
            );
        }
        // Rights of the built-in groups are edited in the group manager only; the
        // old user/guest matrix here duplicated it, so a legacy payload is ignored.

        $this->database->beginTransaction();
        try {
            $setting = $this->database->prepare(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (:setting_key, :setting_value)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
            );
            foreach ([
                'music_sort' => $musicSort,
                'movies_sort' => $moviesSort,
                'account_page_size' => (string) $pageSize,
                'compatibility_audio_profile' => $audioProfile,
                'compatibility_video_profile' => $videoProfile,
                'playback_threshold_percent' => (string) $playbackThreshold,
                'visualizer_order' => implode(',', $visualizerOrder),
                'visualizer_enabled' => implode(',', $visualizerEnabled),
            ] + $securityUpdates as $key => $value) {
                $setting->execute(['setting_key' => $key, 'setting_value' => $value]);
            }
            // Never record the raw captcha secret: the ledger would keep it in
            // cleartext even though every read path only reports whether one is set.
            $audited = $payload;
            if (array_key_exists('captcha_secret_key', $audited)) {
                $audited['captcha_secret_key'] = $audited['captcha_secret_key'] === '' ? '' : '[redacted]';
            }
            $this->audit($identity->userId, 'settings.update', 'application', 'media-server', $audited);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        return ['success' => true, 'settings' => $this->settingsSnapshot()];
    }

    /**
     * Parse a stored comma separated list into recognised identifiers only.
     *
     * @return array<int, string>
     */
    private static function knownVisualizers(string $stored): array
    {
        if ($stored === '') {
            return [];
        }
        $seen = [];
        foreach (explode(',', $stored) as $candidate) {
            $candidate = trim($candidate);
            if ($candidate !== '' && in_array($candidate, self::VISUALIZER_IDS, true) && !in_array($candidate, $seen, true)) {
                $seen[] = $candidate;
            }
        }
        return $seen;
    }

    /** @return array<string, mixed> */
    public function settingsSnapshot(): array
    {
        $defaultVisualizerOrder = self::VISUALIZER_IDS;
        $settings = ['music_sort' => 'title_asc', 'movies_sort' => 'title_asc', 'account_page_size' => 20,
            'compatibility_audio_profile' => 'stereo_standard', 'compatibility_video_profile' => 'native_copy',
            'playback_threshold_percent' => 15, 'visualizer_order' => $defaultVisualizerOrder,
            'visualizer_enabled' => $defaultVisualizerOrder,
            'registration_enabled' => false, 'registration_requires_activation' => true,
            'registration_default_role' => 'user',
            'captcha_provider' => 'none', 'captcha_site_key' => '',
            'captcha_protect_login' => false, 'captcha_protect_registration' => true,
            // Never the secret itself: every signed-in client can read this.
            'captcha_secret_configured' => false,
            'download_rate_limit' => 0, 'download_rate_window_minutes' => 60,
            // The player's collapse control is a phone affordance by default.
            'dock_collapse_desktop' => false,
            // Links that work without an account are off until somebody turns
            // them on: the safe default for anything that reaches outside the
            // house is "not yet".
            'guest_links_enabled' => false];
        if ($this->featureTableExists('app_settings')) {
            foreach ($this->database->query('SELECT setting_key, setting_value FROM app_settings')->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $key = (string) ($row['setting_key'] ?? '');
                if ($key === 'music_sort' || $key === 'movies_sort') {
                    $candidate = (string) $row['setting_value'];
                    if (in_array($candidate, self::LIBRARY_SORTS, true)) {
                        $settings[$key] = $candidate;
                    }
                } elseif ($key === 'account_page_size') {
                    $settings[$key] = max(10, min(100, (int) $row['setting_value']));
                } elseif ($key === 'playback_threshold_percent') {
                    $settings[$key] = max(1, min(100, (int) $row['setting_value']));
                } elseif ($key === 'compatibility_audio_profile') {
                    $candidate = (string) $row['setting_value'];
                    if (in_array($candidate, ['stereo_low', 'stereo_standard', 'stereo_high', 'surround_aac'], true)) {
                        $settings[$key] = $candidate;
                    }
                } elseif ($key === 'compatibility_video_profile') {
                    $candidate = (string) $row['setting_value'];
                    if (in_array($candidate, ['native_copy', 'h264_fallback'], true)) {
                        $settings[$key] = $candidate;
                    }
                } elseif ($key === 'visualizer_order') {
                    // Keep what is recognised, drop what is not and append anything
                    // missing. Rejecting the whole value over one unknown entry is
                    // what hid newly added plugins from the client.
                    $candidate = self::knownVisualizers((string) $row['setting_value']);
                    foreach ($defaultVisualizerOrder as $knownId) {
                        if (!in_array($knownId, $candidate, true)) {
                            $candidate[] = $knownId;
                        }
                    }
                    $settings[$key] = $candidate;
                } elseif ($key === 'visualizer_enabled') {
                    $settings[$key] = self::knownVisualizers((string) $row['setting_value']);
                } elseif ($key === 'captcha_secret_key') {
                    // Report only that a secret exists. Sending it back would hand
                    // it to every signed-in client that reads their session.
                    $settings['captcha_secret_configured'] = (string) $row['setting_value'] !== '';
                } elseif (in_array($key, ['registration_enabled', 'registration_requires_activation',
                    'captcha_protect_login', 'captcha_protect_registration', 'dock_collapse_desktop',
                    'guest_links_enabled'], true)) {
                    $settings[$key] = (string) $row['setting_value'] === '1';
                } elseif ($key === 'download_rate_limit') {
                    $settings[$key] = max(0, min(10000, (int) $row['setting_value']));
                } elseif ($key === 'download_rate_window_minutes') {
                    $settings[$key] = max(1, min(10080, (int) $row['setting_value']));
                } elseif ($key === 'captcha_provider') {
                    $candidate = (string) $row['setting_value'];
                    if (in_array($candidate, CaptchaGuard::providers(), true)) {
                        $settings[$key] = $candidate;
                    }
                } elseif ($key === 'registration_default_role') {
                    $candidate = (string) $row['setting_value'];
                    if (in_array($candidate, ['user', 'admin', 'super_admin'], true)) {
                        $settings[$key] = $candidate;
                    }
                } elseif (array_key_exists($key, $settings)) {
                    $settings[$key] = (string) $row['setting_value'];
                }
            }
        }
        return $settings;
    }

    /** @param array<string, mixed> $payload */
    public function createUser(LegacyIdentity $identity, array $payload): array
    {
        self::assertAdmin($identity);
        $username = self::username($payload['username'] ?? null);
        $password = self::password($payload['password'] ?? null);
        $passwordConfirm = $payload['password_confirm'] ?? null;
        if (!is_string($passwordConfirm) || !hash_equals($password, $passwordConfirm)) {
            throw new BridgeRequestException('Password confirmation does not match.');
        }
        $role = self::role($payload['role'] ?? 'user');
        if ($role !== 'user' && $identity->role !== 'super_admin') {
            throw new BridgeAuthorizationException('Tylko superadministrator może tworzyć administratorów.');
        }
        $groups = new PermissionGroups($this->database);
        // The group is the single source of truth; the guest flag mirrors it. A
        // legacy panel sending only is_guest still lands in the right system group.
        $groupId = $this->requestedGroupId($groups, $payload, null);
        if ($groupId === null) {
            $groupId = $groups->systemGroupId(
                ($payload['is_guest'] ?? false) === true ? PermissionGroups::GUEST_SLUG : PermissionGroups::USER_SLUG
            );
        }
        $isGuest = $this->guardGuestGroup($groups, $groupId, $role);
        // An account created by hand from the panel has no e-mail to confirm and the
        // operator vouches for it, so it is opened outright — otherwise login() would
        // refuse it under registration_requires_activation until a second manual step.
        $statement = $this->database->prepare(
            'INSERT INTO users (username, password_hash, role, is_guest, is_active, permission_group_id, email_verified_at)
             VALUES (:username, :password_hash, :role, :is_guest, 1, :permission_group_id, CURRENT_TIMESTAMP(6))'
        );
        $statement->execute([
            'username' => $username,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'role' => $role,
            'is_guest' => (int) $isGuest,
            'permission_group_id' => $groupId,
        ]);
        $id = (int) $this->database->lastInsertId();
        $this->audit($identity->userId, 'user.create', 'user', (string) $id, [
            'username' => $username, 'role' => $role, 'permission_group_id' => $groupId,
        ]);
        return ['success' => true, 'id' => $id];
    }

    /**
     * Group id from a payload, validated; null when absent or explicitly cleared.
     *
     * @param array<string, mixed> $payload
     */
    private function requestedGroupId(PermissionGroups $groups, array $payload, ?int $fallback): ?int
    {
        if (!array_key_exists('permission_group_id', $payload)) {
            return $fallback;
        }
        $groupId = $payload['permission_group_id'];
        if ($groupId === null || $groupId === '') {
            return null;
        }
        $groupId = filter_var($groupId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($groupId) || !$groups->exists($groupId)) {
            throw new BridgeRequestException('Nieprawidłowa grupa uprawnień.');
        }
        return $groupId;
    }

    /**
     * Guest flag implied by a group; privileged roles may not join the guest group,
     * because the flag would silently strip their administrative rights.
     */
    private function guardGuestGroup(PermissionGroups $groups, ?int $groupId, string $role): bool
    {
        $isGuest = $groupId !== null && $groups->slugOf($groupId) === PermissionGroups::GUEST_SLUG;
        if ($isGuest && in_array($role, ['admin', 'super_admin'], true)) {
            throw new BridgeRequestException('Administrator nie może należeć do grupy gości.');
        }
        return $isGuest;
    }

    /**
     * Open a pending account by hand, from the panel.
     *
     * Sets both flags login() checks — is_active and email_verified_at — and
     * consumes any outstanding activation links so a stale mail cannot be
     * replayed after the operator already vouched for the account.
     *
     * @param array<string, mixed> $payload
     */
    public function activateUser(LegacyIdentity $identity, array $payload): array
    {
        self::assertAdmin($identity);
        $userId = self::positiveId($payload['user_id'] ?? null);
        $statement = $this->database->prepare(
            'SELECT id, email_verified_at FROM users WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $target = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($target)) {
            throw new CatalogItemNotFoundException('Użytkownik nie istnieje.');
        }
        $this->database->beginTransaction();
        try {
            $this->database->prepare(
                'UPDATE users SET is_active = 1,
                        email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP(6))
                 WHERE id = :id'
            )->execute(['id' => $userId]);
            $this->database->prepare(
                'UPDATE user_activation_tokens SET consumed_at = CURRENT_TIMESTAMP(6)
                 WHERE user_id = :id AND purpose = :purpose AND consumed_at IS NULL'
            )->execute(['id' => $userId, 'purpose' => 'activation']);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
        $this->audit($identity->userId, 'user.activate', 'user', (string) $userId, [
            'was_pending' => $target['email_verified_at'] === null,
        ]);
        return ['success' => true];
    }

    /** @param array<string, mixed> $payload */
    public function updateUser(LegacyIdentity $identity, array $payload): array
    {
        self::assertAdmin($identity);
        $userId = self::positiveId($payload['user_id'] ?? null);
        $statement = $this->database->prepare('SELECT id, role, permission_group_id FROM users WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $userId]);
        $target = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($target)) {
            throw new CatalogItemNotFoundException('Użytkownik nie istnieje.');
        }
        // Any privileged account may only be edited by a super_admin. Checking
        // the TARGET's current role (not just the submitted one) stops a plain
        // admin from demoting a peer to 'user' and resetting their password —
        // the account-takeover path the previous guard missed.
        $currentRole = (string) ($target['role'] ?? 'user');
        if (in_array($currentRole, ['admin', 'super_admin'], true) && $identity->role !== 'super_admin') {
            throw new BridgeAuthorizationException('Tylko superadministrator może modyfikować konta administratorów.');
        }
        $role = self::role($payload['role'] ?? $currentRole);
        // Enforce the super_admin requirement only when the role actually
        // changes, so a non-super admin can still save unrelated edits.
        if ($role !== $currentRole && $identity->role !== 'super_admin') {
            throw new BridgeAuthorizationException('Tylko superadministrator może zmieniać role administratorów.');
        }
        $active = $payload['is_active'] ?? true;
        if (!is_bool($active)) {
            throw new BridgeRequestException('Nieprawidłowy stan konta.');
        }
        if ($userId === $identity->userId && !$active) {
            throw new BridgeRequestException('Nie można wyłączyć własnego konta.');
        }
        $password = $payload['password'] ?? null;
        if ($password !== null) {
            $password = self::password($password);
            $passwordConfirm = $payload['password_confirm'] ?? null;
            if (!is_string($passwordConfirm) || !hash_equals($password, $passwordConfirm)) {
                throw new BridgeRequestException('Password confirmation does not match.');
            }
        }
        $groups = new PermissionGroups($this->database);
        // Absent leaves the assignment alone; an explicit null puts the account
        // back into the system user group. The guest flag always mirrors the group.
        $currentGroupId = $target['permission_group_id'] === null ? null : (int) $target['permission_group_id'];
        $groupId = $this->requestedGroupId($groups, $payload, $currentGroupId)
            ?? $groups->systemGroupId(PermissionGroups::USER_SLUG);
        $guest = $this->guardGuestGroup($groups, $groupId, $role);
        $sql = 'UPDATE users SET role = :role, is_active = :active, is_guest = :guest,
                permission_group_id = :permission_group_id';
        $params = [
            'role' => $role,
            'active' => (int) $active,
            'guest' => (int) $guest,
            'permission_group_id' => $groupId,
            'id' => $userId,
        ];
        if ($password !== null) {
            $sql .= ', password_hash = :password_hash';
            $params['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
        }
        $sql .= ' WHERE id = :id';
        $this->database->prepare($sql)->execute($params);
        $this->audit($identity->userId, 'user.update', 'user', (string) $userId, [
            'role' => $role, 'is_active' => $active, 'permission_group_id' => $groupId,
            'password_changed' => $password !== null,
        ]);
        return ['success' => true];
    }

    /** @return array<string, mixed> */
    private function ownedCollection(LegacyIdentity $identity, int $collectionId): array
    {
        $this->assertFeatureTable('user_collections');
        $statement = $this->database->prepare(
            'SELECT id, name, description, media_kind, rules_json, is_shared, queue_rating, queue_favorite
             FROM user_collections WHERE id = :id AND user_id = :user_id LIMIT 1'
        );
        $statement->execute(['id' => $collectionId, 'user_id' => $identity->userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Kolekcja nie istnieje.');
        }
        return $row;
    }

    /** @return array<string, mixed> */
    private function accessibleCollection(LegacyIdentity $identity, int $collectionId): array
    {
        $this->assertFeatureTable('user_collections');
        $statement = $this->database->prepare(
            'SELECT uc.id, uc.user_id, u.username AS owner_name, uc.name, uc.description,
                    uc.media_kind, uc.rules_json, uc.is_shared, uc.queue_rating, uc.queue_favorite
             FROM user_collections uc
             INNER JOIN users u ON u.id = uc.user_id
             WHERE uc.id = :id AND (uc.user_id = :user_id OR uc.is_shared = 1)
             LIMIT 1'
        );
        $statement->execute(['id' => $collectionId, 'user_id' => $identity->userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Playlista nie istnieje albo nie została udostępniona.');
        }
        if ((int) $row['user_id'] !== $identity->userId) {
            $this->assertPermission($identity, 'can_browse_collections');
        }
        return $row;
    }

    /** @return array{item_count:int,items_avg_rating:float,items_rating_count:int,total_play_count:int} */
    private static function emptyCollectionStatistics(): array
    {
        return ['item_count' => 0, 'items_avg_rating' => 0.0, 'items_rating_count' => 0, 'total_play_count' => 0];
    }

    /**
     * Statistics for every manual list in one grouped query.
     *
     * Counts, plays and the rating average do not depend on who is asking, so this
     * skips the per-item projection the single-list query needs and reads only the
     * aggregates. The kind filter follows each list's own media_kind. The average
     * here is over the *tracks* — the list's own stars come from
     * collectionRatings and are nobody's average but the voters'.
     *
     * @param array<int, int> $collectionIds
     * @return array<int, array{item_count:int,items_avg_rating:float,items_rating_count:int,total_play_count:int}>
     */
    private function manualCollectionStatistics(array $collectionIds): array
    {
        if ($collectionIds === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($collectionIds), '?'));
        $statement = $this->database->prepare(
            "SELECT uci.collection_id,
                    COUNT(*) AS item_count,
                    COALESCE(SUM(mpt.play_count), 0) AS total_play_count,
                    COALESCE(SUM(ra.rating_count), 0) AS items_rating_count,
                    CASE WHEN COALESCE(SUM(ra.rating_count), 0) = 0 THEN 0
                         ELSE SUM(ra.avg_rating * ra.rating_count) / SUM(ra.rating_count)
                    END AS items_avg_rating
               FROM user_collection_items uci
               INNER JOIN user_collections uc ON uc.id = uci.collection_id
               INNER JOIN media_items mi
                       ON mi.id = uci.media_item_id
                      AND mi.deleted_at IS NULL
                      AND mi.catalog_status IN ('ready', 'legacy')
                      AND mi.media_kind = CASE WHEN uc.media_kind = 'music' THEN 'audio' ELSE 'video' END
               LEFT JOIN media_play_totals mpt ON mpt.media_item_id = mi.id
               LEFT JOIN (
                    SELECT media_item_id, AVG(rating) AS avg_rating, COUNT(rating) AS rating_count
                      FROM user_ratings
                     WHERE rating IS NOT NULL
                     GROUP BY media_item_id
               ) ra ON ra.media_item_id = mi.id
              WHERE uci.collection_id IN ({$placeholders})
              GROUP BY uci.collection_id"
        );
        $statement->execute($collectionIds);
        $statistics = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $statistics[(int) $row['collection_id']] = [
                'item_count' => (int) $row['item_count'],
                'items_avg_rating' => round((float) $row['items_avg_rating'], 2),
                'items_rating_count' => (int) $row['items_rating_count'],
                'total_play_count' => (int) $row['total_play_count'],
            ];
        }
        return $statistics;
    }

    /**
     * Cover candidates for every manual list in one query.
     *
     * A rule-based list needs its own filter and is handled one at a time by
     * collectionPreviewCandidates; a manual list only needs its own rows, so all
     * of them are ranked together and cut at PREVIEW_CANDIDATES per list.
     *
     * @param array<int, int> $collectionIds
     * @return array<int, array<int, array{id:int,kind:string}>>
     */
    private function manualCollectionPreviewCandidates(array $collectionIds): array
    {
        if ($collectionIds === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($collectionIds), '?'));
        $statement = $this->database->prepare(
            "SELECT collection_id, media_item_id, media_kind FROM (
                SELECT uci.collection_id, mi.id AS media_item_id, mi.media_kind,
                       ROW_NUMBER() OVER (
                           PARTITION BY uci.collection_id ORDER BY uci.position, mi.id
                       ) AS candidate_rank
                  FROM user_collection_items uci
                  INNER JOIN user_collections uc ON uc.id = uci.collection_id
                  INNER JOIN media_items mi
                          ON mi.id = uci.media_item_id
                         AND mi.deleted_at IS NULL
                         AND mi.catalog_status IN ('ready', 'legacy')
                         AND mi.media_kind = CASE WHEN uc.media_kind = 'music' THEN 'audio' ELSE 'video' END
                 WHERE uci.collection_id IN ({$placeholders})
             ) ranked
             WHERE candidate_rank <= " . self::PREVIEW_CANDIDATES
        );
        $statement->execute($collectionIds);
        $candidates = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $candidates[(int) $row['collection_id']][] = [
                'id' => (int) $row['media_item_id'],
                'kind' => (string) $row['media_kind'],
            ];
        }
        return $candidates;
    }

    private function collectionStatistics(LegacyIdentity $identity, array $collection): array
    {
        $rules = $collection['rules'] ?? null;
        $params = [];
        $where = '';
        $join = '';
        if (is_array($rules)) {
            [$where, $params] = self::collectionRuleSql($rules);
        } else {
            $join = ' INNER JOIN user_collection_items uci
                       ON uci.media_item_id = mi.id AND uci.collection_id = :collection_id';
            $params['collection_id'] = (int) $collection['id'];
        }
        $mediaKind = $collection['media_kind'] === 'music' ? 'audio' : 'video';
        $sql = 'SELECT COUNT(*) AS item_count,
                       COALESCE(SUM(items.total_play_count), 0) AS total_play_count,
                       COALESCE(SUM(items.rating_count), 0) AS items_rating_count,
                       CASE WHEN COALESCE(SUM(items.rating_count), 0) = 0 THEN 0
                            ELSE SUM(items.avg_rating * items.rating_count) / SUM(items.rating_count)
                       END AS items_avg_rating
                FROM (' . self::collectionItemSelect($join) .
               " WHERE mi.media_kind = :statistics_media_kind
                   AND mi.deleted_at IS NULL
                   AND mi.catalog_status IN ('ready', 'legacy')
                   {$where}
                ) items";
        $statement = $this->database->prepare($sql);
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':statistics_media_kind', $mediaKind, PDO::PARAM_STR);
        foreach ($params as $key => $value) {
            $statement->bindValue(
                ':' . $key,
                $value,
                is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR
            );
        }
        $statement->execute();
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return self::emptyCollectionStatistics();
        }
        return [
            'item_count' => (int) ($row['item_count'] ?? 0),
            'items_avg_rating' => round((float) ($row['items_avg_rating'] ?? 0), 2),
            'items_rating_count' => (int) ($row['items_rating_count'] ?? 0),
            'total_play_count' => (int) ($row['total_play_count'] ?? 0),
        ];
    }

    /**
     * Whose rating a playlist's queue shows.
     *
     * Not a smart-list rule: a rule says which items are on the list, this says
     * how the list is drawn, so it lives in its own column and applies to manual
     * lists too. `owner` is the author, `viewer` is whoever is listening — two
     * values rather than one "own", because "own" would name a different person
     * depending on who is reading, and both readings are wanted. Anything absent
     * stays `inherit`, which is "do what the listening account has set".
     */
    private static function queueRatingMode(mixed $value): string
    {
        return $value === null
            ? 'inherit'
            : self::enumValue($value, ['inherit', 'owner', 'viewer', 'average', 'none']);
    }

    /** Whose favourite marks a playlist's queue shows; see queueRatingMode. */
    private static function queueFavoriteMode(mixed $value): string
    {
        return $value === null
            ? 'inherit'
            : self::enumValue($value, ['inherit', 'owner', 'viewer', 'none']);
    }

    /** @return array<string, mixed>|null */
    private static function collectionRules(mixed $value): ?array
    {
        if ($value === null) {
            return null;
        }
        if (!is_array($value) || array_is_list($value)) {
            throw new BridgeRequestException('Nieprawidłowe reguły playlisty.');
        }
        $rules = [
            'query' => self::optionalText($value['query'] ?? null, 191),
            'favorite' => self::enumValue($value['favorite'] ?? 'any', ['any', 'yes', 'no']),
            'rating_status' => self::enumValue($value['rating_status'] ?? 'all', ['all', 'rated', 'unrated']),
            'play_scope' => self::enumValue($value['play_scope'] ?? 'total', ['own', 'total', 'others', 'unplayed']),
            'date_scope' => self::enumValue($value['date_scope'] ?? 'any', ['any', 'own', 'total', 'others']),
            'played_from' => self::optionalDate($value['played_from'] ?? null),
            'played_to' => self::optionalDate($value['played_to'] ?? null),
            'rating_scope' => self::enumValue($value['rating_scope'] ?? 'community', ['own', 'community', 'both']),
            'min_plays' => self::boundedNumber($value['min_plays'] ?? 0, 0, 1000000000, true),
            'max_plays' => self::boundedNumber($value['max_plays'] ?? 0, 0, 1000000000, true),
            'min_user_rating' => self::boundedNumber($value['min_user_rating'] ?? 0, 0, 5, false),
            'max_user_rating' => self::boundedNumber($value['max_user_rating'] ?? 0, 0, 5, false),
            'min_rating' => self::boundedNumber($value['min_rating'] ?? 0, 0, 5, false),
            'max_rating' => self::boundedNumber($value['max_rating'] ?? 0, 0, 5, false),
            'min_rating_count' => self::boundedNumber($value['min_rating_count'] ?? 0, 0, 1000000000, true),
            'max_rating_count' => self::boundedNumber($value['max_rating_count'] ?? 0, 0, 1000000000, true),
            // 0 means "no bound" here, exactly as it does for plays and ratings,
            // so a list can ask for "before 1980" without inventing a floor.
            'min_year' => self::boundedNumber($value['min_year'] ?? 0, 0, 2049, true),
            'max_year' => self::boundedNumber($value['max_year'] ?? 0, 0, 2049, true),
            'genres' => self::genreIdList($value['genres'] ?? null),
        ];
        if (($rules['max_plays'] > 0 && $rules['min_plays'] > $rules['max_plays'])
            || ($rules['max_user_rating'] > 0 && $rules['min_user_rating'] > $rules['max_user_rating'])
            || ($rules['max_rating'] > 0 && $rules['min_rating'] > $rules['max_rating'])
            || ($rules['max_rating_count'] > 0 && $rules['min_rating_count'] > $rules['max_rating_count'])
            || ($rules['max_year'] > 0 && $rules['min_year'] > $rules['max_year'])
            || ($rules['played_from'] !== null && $rules['played_to'] !== null
                && $rules['played_from'] > $rules['played_to'])) {
            throw new BridgeRequestException('Minimalna wartość nie może przekraczać maksymalnej.');
        }
        return $rules;
    }

    /**
     * Genre identifiers a rule selects, cleaned to a short list of positive ints.
     *
     * The dictionary is closed (migration 029 seeds it), so an id that is not in
     * it simply collects nothing — there is no need to reject it and no way for
     * one to reach the SQL as anything but an integer.
     *
     * @return list<int>
     */
    private static function genreIdList(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $ids = [];
        foreach ($value as $entry) {
            $id = (int) (is_scalar($entry) ? $entry : 0);
            if ($id > 0 && !in_array($id, $ids, true)) {
                $ids[] = $id;
            }
            if (count($ids) >= 30) {
                break;
            }
        }
        return $ids;
    }

    /** @param array<string, mixed> $rules
     * @return array{0:string,1:array<string, int|float|string>}
     */
    private static function collectionRuleSql(array $rules): array
    {
        $conditions = [];
        $params = [];
        $query = is_string($rules['query'] ?? null) ? trim($rules['query']) : '';
        if ($query !== '') {
            // Fold "_", "-" and "." to spaces on both sides so a rule typed as
            // "You Are" still collects "104-atomic_kitten-you_are".
            $haystack = "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(CONCAT_WS(' ',"
                . " COALESCE(mo.title, mi.title, ''), mi.relative_path,"
                . " COALESCE(mo.artist, mi.artist, ''), COALESCE(mo.album, mi.album, '')"
                . "), '_', ' '), '-', ' '), '.', ' '), '/', ' '))";
            $conditions[] = "({$haystack} LIKE :rule_query ESCAPE '\\\\')";
            $folded = trim((string) preg_replace(
                '/\s+/u',
                ' ',
                str_replace(['_', '-', '.', '/'], ' ', mb_strtolower($query, 'UTF-8'))
            ));
            $params['rule_query'] = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $folded) . '%';
        }
        if (($rules['favorite'] ?? 'any') === 'yes') {
            $conditions[] = 'COALESCE(ur.favorite, 0) = 1';
        } elseif (($rules['favorite'] ?? 'any') === 'no') {
            $conditions[] = 'COALESCE(ur.favorite, 0) = 0';
        }
        if (($rules['rating_status'] ?? 'all') === 'rated') {
            $conditions[] = 'ur.rating IS NOT NULL';
        } elseif (($rules['rating_status'] ?? 'all') === 'unrated') {
            $conditions[] = 'ur.rating IS NULL';
        }
        $playScope = $rules['play_scope'] ?? 'total';
        $playColumn = match ($playScope) {
            'own', 'unplayed' => 'COALESCE(ps.play_count, 0)',
            'others' => 'GREATEST(COALESCE(mpt.play_count, 0) - COALESCE(ps.play_count, 0), 0)',
            default => 'COALESCE(mpt.play_count, 0)',
        };
        if ($playScope === 'unplayed') {
            $conditions[] = 'COALESCE(ps.play_count, 0) = 0';
        }
        $conditions[] = "{$playColumn} BETWEEN :rule_min_plays AND :rule_max_plays";
        // Only the bounds whose condition is actually emitted may be bound: the
        // driver rejects a statement carrying a parameter the SQL never mentions,
        // which is what a list scoped to one rating source used to do.
        $ratingScope = $rules['rating_scope'] ?? 'community';
        if (in_array($ratingScope, ['own', 'both'], true)) {
            $conditions[] = 'COALESCE(ur.rating, 0) BETWEEN :rule_min_user_rating AND :rule_max_user_rating';
            $params['rule_min_user_rating'] = (float) ($rules['min_user_rating'] ?? 0);
            $params['rule_max_user_rating'] = self::unboundedMaximum($rules['max_user_rating'] ?? 0, 5);
        }
        if (in_array($ratingScope, ['community', 'both'], true)) {
            $conditions[] = 'COALESCE(ra.avg_rating, 0) BETWEEN :rule_min_rating AND :rule_max_rating';
            $params['rule_min_rating'] = (float) ($rules['min_rating'] ?? 0);
            $params['rule_max_rating'] = self::unboundedMaximum($rules['max_rating'] ?? 0, 5);
        }
        $conditions[] = 'COALESCE(ra.rating_count, 0) BETWEEN :rule_min_rating_count AND :rule_max_rating_count';
        $dateScope = $rules['date_scope'] ?? 'any';
        $dateColumn = match ($dateScope) {
            'own' => 'ps.last_played_at',
            'total' => 'mpt.last_played_at',
            'others' => 'opa.last_played_at',
            default => null,
        };
        if ($dateColumn !== null && is_string($rules['played_from'] ?? null)) {
            $conditions[] = "{$dateColumn} >= :rule_played_from";
            $params['rule_played_from'] = $rules['played_from'] . ' 00:00:00';
        }
        if ($dateColumn !== null && is_string($rules['played_to'] ?? null)) {
            $conditions[] = "{$dateColumn} < DATE_ADD(:rule_played_to, INTERVAL 1 DAY)";
            $params['rule_played_to'] = $rules['played_to'] . ' 00:00:00';
        }
        // A release year and a genre are known for films, and only for those a
        // lookup has reached; a file with neither must drop out of a list that
        // asks for them rather than sneak in on a COALESCE to zero, which is why
        // these read the column directly instead of defaulting it.
        $minYear = (int) ($rules['min_year'] ?? 0);
        $maxYear = (int) ($rules['max_year'] ?? 0);
        if ($minYear > 0) {
            $conditions[] = 'mi.release_year >= :rule_min_year';
            $params['rule_min_year'] = $minYear;
        }
        if ($maxYear > 0) {
            $conditions[] = 'mi.release_year <= :rule_max_year';
            $params['rule_max_year'] = $maxYear;
        }
        $genres = is_array($rules['genres'] ?? null) ? $rules['genres'] : [];
        if ($genres !== []) {
            // Any of them, not all: "sci-fi or fantasy" is what a person means
            // by ticking two boxes, and "sci-fi and fantasy" collects almost
            // nothing on a real library.
            $placeholders = [];
            foreach (array_values($genres) as $index => $genreId) {
                $name = 'rule_genre_' . $index;
                $placeholders[] = ':' . $name;
                $params[$name] = (int) $genreId;
            }
            $conditions[] = 'EXISTS (SELECT 1 FROM media_item_genres mig'
                . ' WHERE mig.media_item_id = mi.id AND mig.genre_id IN (' . implode(', ', $placeholders) . '))';
        }
        $params += [
            'rule_min_plays' => (int) ($rules['min_plays'] ?? 0),
            'rule_max_plays' => self::unboundedMaximum($rules['max_plays'] ?? 0, 1000000000),
            'rule_min_rating_count' => (int) ($rules['min_rating_count'] ?? 0),
            'rule_max_rating_count' => self::unboundedMaximum($rules['max_rating_count'] ?? 0, 1000000000),
        ];
        return [' AND ' . implode(' AND ', $conditions), $params];
    }

    /**
     * @param bool $withOwner Also project the playlist owner's own rating and
     *   favourite mark, for a list that chose to show them. Requires the caller
     *   to bind :owner_rating_user_id.
     */
    private static function collectionItemSelect(string $extraJoin, bool $withOwner = false): string
    {
        return "SELECT mi.id, mi.relative_path, mi.media_kind, mi.mime_type, mi.file_extension,
                       COALESCE(mo.title, mi.title) AS title,
                       COALESCE(mo.artist, mi.artist) AS artist,
                       COALESCE(mo.album, mi.album) AS album,
                       COALESCE(
                           mo.year,
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.year')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.year'))
                       ) AS year,
                       COALESCE(
                           mo.genre,
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.genre')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.genre'))
                       ) AS genre,
                       mi.duration_ms, mi.size_bytes,
                       COALESCE(
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.bitrate')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.bitrate'))
                       ) AS bitrate,
                       COALESCE(
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.sample_rate')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.sample_rate'))
                       ) AS sample_rate,
                       COALESCE(
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.channels')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.channels'))
                       ) AS channels,
                       mi.video_width, mi.video_height, mi.video_codec, mi.audio_codec, mi.is_hdr,
                       mi.metadata_json,
                       COALESCE(ur.favorite, 0) AS favorite, ur.rating,
                       COALESCE(ps.play_count, 0) AS play_count,
                       COALESCE(mpt.play_count, 0) AS total_play_count,
                       COALESCE(ra.avg_rating, 0) AS avg_rating,
                       COALESCE(ra.rating_count, 0) AS rating_count,
                       COALESCE(ra.favorite_count, 0) AS favorite_count"
                . ($withOwner ? ', uro.rating AS owner_rating, COALESCE(uro.favorite, 0) AS owner_favorite' : '')
                . self::collectionItemFrom($extraJoin, $withOwner);
    }

    /**
     * The FROM/JOIN half of a collection item query.
     *
     * Split out so a query that only needs identifiers (cover candidates, the ZIP
     * list) can reuse the joins the rule filter refers to without carrying the
     * full projection.
     */
    private static function collectionItemFrom(string $extraJoin, bool $withOwner = false): string
    {
        // A second pass over user_ratings, for the playlist's owner rather than
        // for whoever is reading. Separate from `ur` on purpose: the reader's
        // own stars stay available, so rating a track from a list that shows the
        // author's opinion still works and still edits the right row.
        $owner = $withOwner
            ? ' LEFT JOIN user_ratings uro ON uro.media_item_id = mi.id AND uro.user_id = :owner_rating_user_id'
            : '';
        return " FROM media_items mi
                {$extraJoin}
                LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                LEFT JOIN user_ratings ur ON ur.media_item_id = mi.id AND ur.user_id = :rating_user_id
                LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = :playback_user_id
                LEFT JOIN media_play_totals mpt ON mpt.media_item_id = mi.id
                LEFT JOIN (
                  SELECT media_item_id, MAX(last_played_at) AS last_played_at
                  FROM playback_stats WHERE user_id <> :other_playback_user_id GROUP BY media_item_id
                ) opa ON opa.media_item_id = mi.id
                LEFT JOIN (
                  SELECT media_item_id, AVG(rating) AS avg_rating, COUNT(rating) AS rating_count,
                         SUM(favorite) AS favorite_count
                  FROM user_ratings GROUP BY media_item_id
                ) ra ON ra.media_item_id = mi.id" . $owner;
    }

    private static function bindIdentity(PDOStatement $statement, LegacyIdentity $identity): void
    {
        $statement->bindValue(':rating_user_id', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':playback_user_id', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':other_playback_user_id', $identity->userId, PDO::PARAM_INT);
    }

    /** @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function publicCollectionItem(array $row): array
    {
        $path = is_string($row['relative_path'] ?? null) ? $row['relative_path'] : '';
        $title = is_string($row['title'] ?? null) && trim($row['title']) !== ''
            ? trim($row['title'])
            : basename(str_replace('\\', '/', $path));
        // Present only when the playlist asked for its author's opinion; absent
        // rather than null, so "the owner has not rated this" and "nobody asked
        // for the owner's rating" stay distinguishable on the client.
        $owner = array_key_exists('owner_rating', $row)
            ? [
                'owner_rating' => $row['owner_rating'] === null ? null : (float) $row['owner_rating'],
                'owner_favorite' => (int) ($row['owner_favorite'] ?? 0) === 1,
            ]
            : [];
        return [
            'id' => (int) $row['id'],
            'relative_path' => $path,
            'media_kind' => (string) $row['media_kind'],
            'mime_type' => is_string($row['mime_type'] ?? null) ? $row['mime_type'] : null,
            'file_extension' => is_string($row['file_extension'] ?? null) ? $row['file_extension'] : null,
            'title' => $title,
            'artist' => self::optionalString($row['artist'] ?? null),
            'album' => self::optionalString($row['album'] ?? null),
            'year' => self::optionalString($row['year'] ?? null),
            'genre' => self::optionalString($row['genre'] ?? null),
            'duration_ms' => $row['duration_ms'] === null ? null : (int) $row['duration_ms'],
            'size_bytes' => $row['size_bytes'] === null ? null : (int) $row['size_bytes'],
            'bitrate' => $row['bitrate'] === null ? null : (int) $row['bitrate'],
            'sample_rate' => $row['sample_rate'] === null ? null : (int) $row['sample_rate'],
            'channels' => $row['channels'] === null ? null : (int) $row['channels'],
            'favorite' => (int) ($row['favorite'] ?? 0) === 1,
            'rating' => $row['rating'] === null ? null : (float) $row['rating'],
            'play_count' => (int) ($row['play_count'] ?? 0),
            'avg_rating' => round((float) ($row['avg_rating'] ?? 0), 1),
            'rating_count' => (int) ($row['rating_count'] ?? 0),
            'favorite_count' => (int) ($row['favorite_count'] ?? 0),
            // Filled by the ffprobe pass; null until a film has been probed.
            'video_width' => isset($row['video_width']) ? (int) $row['video_width'] : null,
            'video_height' => isset($row['video_height']) ? (int) $row['video_height'] : null,
            'video_codec' => self::optionalString($row['video_codec'] ?? null),
            'audio_codec' => self::optionalString($row['audio_codec'] ?? null),
            'is_hdr' => (int) ($row['is_hdr'] ?? 0) === 1,
            // Everything ffprobe found, for the "technical details" panel; the
            // columns above are the part worth querying and sorting on.
            'probe' => self::probeDetails($row['metadata_json'] ?? null),
        ] + $owner;
    }

    /**
     * The ffprobe result, trimmed to what a viewer panel can show.
     *
     * Bit depth is read off the pixel format (yuv420p10le is ten bits) because
     * ffprobe reports it nowhere else; anything missing is simply absent rather
     * than guessed.
     *
     * @return array<string, mixed>|null
     */
    private static function probeDetails(mixed $metadataJson): ?array
    {
        if (!is_string($metadataJson) || $metadataJson === '') {
            return null;
        }
        $decoded = json_decode($metadataJson, true);
        $video = is_array($decoded) ? ($decoded['video'] ?? null) : null;
        if (!is_array($video)) {
            return null;
        }
        $details = [];
        foreach (
            ['container', 'video_codec', 'video_profile', 'pixel_format', 'frame_rate',
             'audio_codec', 'audio_channels', 'sample_rate', 'bitrate', 'hdr',
             'subtitle_languages', 'subtitle_streams', 'audio_streams'] as $key
        ) {
            if (array_key_exists($key, $video)) {
                $details[$key] = $video[$key];
            }
        }
        $pixelFormat = is_string($video['pixel_format'] ?? null) ? $video['pixel_format'] : '';
        if (preg_match('/(\d{1,2})(?:le|be)$/D', $pixelFormat, $matches) === 1) {
            $details['bit_depth'] = (int) $matches[1];
        } elseif ($pixelFormat !== '') {
            $details['bit_depth'] = 8;
        }
        return $details === [] ? null : $details;
    }

    private static function optionalString(mixed $value): ?string
    {
        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }

    /** @param array<int, string> $allowed */
    private static function enumValue(mixed $value, array $allowed): string
    {
        if (!is_string($value) || !in_array($value, $allowed, true)) {
            throw new BridgeRequestException('Nieprawidłowa wartość reguły.');
        }
        return $value;
    }

    private static function boundedNumber(mixed $value, float $minimum, float $maximum, bool $integer): int|float
    {
        if (!is_int($value) && !is_float($value)) {
            throw new BridgeRequestException('Nieprawidłowa wartość liczbowa reguły.');
        }
        $number = (float) $value;
        if (!is_finite($number) || $number < $minimum || $number > $maximum || ($integer && floor($number) !== $number)) {
            throw new BridgeRequestException('Wartość reguły jest poza zakresem.');
        }
        return $integer ? (int) $number : $number;
    }

    private static function optionalDate(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || preg_match('/\A(\d{4})-(\d{2})-(\d{2})\z/D', $value, $parts) !== 1
            || !checkdate((int) $parts[2], (int) $parts[3], (int) $parts[1])) {
            throw new BridgeRequestException('Invalid rule date.');
        }
        return $value;
    }

    private static function unboundedMaximum(mixed $value, int|float $fallback): int|float
    {
        $number = is_int($value) || is_float($value) ? $value : 0;
        return $number == 0 ? $fallback : $number;
    }


    private function featureTableExists(string $table): bool
    {
        if (!in_array($table, ['user_collections', 'user_collection_artwork', 'user_collection_ratings', 'media_artwork_overrides', 'app_settings', 'playback_queues', 'user_sessions'], true)) {
            return false;
        }
        if (array_key_exists($table, $this->featureTableCache)) {
            return $this->featureTableCache[$table];
        }
        $statement = $this->database->prepare(
            'SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = :table_name'
        );
        $statement->execute(['table_name' => $table]);
        return $this->featureTableCache[$table] = (int) $statement->fetchColumn() === 1;
    }

    private function assertFeatureTable(string $table): void
    {
        if (!$this->featureTableExists($table)) {
            throw new BridgeRequestException('Funkcja oczekuje na migrację bazy danych.');
        }
    }

    private function ratingSummary(int $userId, int $itemId): array
    {
        $statement = $this->database->prepare(
            'SELECT AVG(rating) AS avg_rating, COUNT(rating) AS rating_count, SUM(favorite) AS favorite_count,
                    MAX(CASE WHEN user_id = :user_id THEN rating END) AS user_rating,
                    MAX(CASE WHEN user_id = :favorite_user THEN favorite ELSE 0 END) AS user_favorite
             FROM user_ratings WHERE media_item_id = :item_id'
        );
        $statement->execute(['user_id' => $userId, 'favorite_user' => $userId, 'item_id' => $itemId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];
        return [
            'user_rating' => $row['user_rating'] === null ? null : (float) $row['user_rating'],
            'user_favorite' => (int) ($row['user_favorite'] ?? 0) === 1,
            'avg_rating' => round((float) ($row['avg_rating'] ?? 0), 1),
            'rating_count' => (int) ($row['rating_count'] ?? 0),
            'favorite_count' => (int) ($row['favorite_count'] ?? 0),
        ];
    }

    /**
     * How one playlist stands after a vote.
     *
     * Shaped like ratingSummary so the card can swap one for the other: the
     * viewer's own stars, the average and how many people cast one.
     *
     * @return array{user_rating: float|null, avg_rating: float, rating_count: int}
     */
    private function collectionRatingSummary(int $userId, int $collectionId): array
    {
        $summary = $this->collectionRatings($userId, [$collectionId]);
        return $summary[$collectionId] ?? ['user_rating' => null, 'avg_rating' => 0.0, 'rating_count' => 0];
    }

    /**
     * The same for a whole shelf of playlists, in one query.
     *
     * A listing draws dozens of cards and each needs three numbers; asking per
     * card would be dozens of round trips for one grouped read.
     *
     * @param array<int, int> $collectionIds
     * @return array<int, array{user_rating: float|null, avg_rating: float, rating_count: int}>
     */
    private function collectionRatings(int $userId, array $collectionIds): array
    {
        if ($collectionIds === [] || !$this->featureTableExists('user_collection_ratings')) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($collectionIds), '?'));
        $statement = $this->database->prepare(
            "SELECT collection_id,
                    AVG(rating) AS avg_rating,
                    COUNT(*) AS rating_count,
                    MAX(CASE WHEN user_id = ? THEN rating END) AS user_rating
               FROM user_collection_ratings
              WHERE collection_id IN ({$placeholders})
              GROUP BY collection_id"
        );
        $statement->execute(array_merge([$userId], array_values($collectionIds)));
        $ratings = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $ratings[(int) $row['collection_id']] = [
                'user_rating' => $row['user_rating'] === null ? null : (float) $row['user_rating'],
                'avg_rating' => round((float) $row['avg_rating'], 1),
                'rating_count' => (int) $row['rating_count'],
            ];
        }
        return $ratings;
    }

    /** @param string|list<string>|null $kind One kind, several, or any. */
    private function assertItem(int $itemId, string|array|null $kind = null): void
    {
        $kinds = $kind === null ? [] : (is_array($kind) ? array_values($kind) : [$kind]);
        $sql = "SELECT 1 FROM media_items WHERE id = :id AND deleted_at IS NULL
                AND catalog_status IN ('ready', 'legacy')";
        $params = ['id' => $itemId];
        if ($kinds !== []) {
            $placeholders = [];
            foreach ($kinds as $position => $value) {
                $placeholders[] = ':kind' . $position;
                $params['kind' . $position] = $value;
            }
            $sql .= ' AND media_kind IN (' . implode(', ', $placeholders) . ')';
        }
        $statement = $this->database->prepare($sql . ' LIMIT 1');
        $statement->execute($params);
        if ($statement->fetchColumn() === false) {
            throw new CatalogItemNotFoundException('Plik jest niedostępny.');
        }
    }

    /** @param array<string, mixed>|null $details */
    private function audit(?int $actor, string $action, string $targetType, ?string $targetId, ?array $details): void
    {
        $statement = $this->database->prepare(
            'INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details_json)
             VALUES (:actor, :action, :target_type, :target_id, :details)'
        );
        $statement->execute([
            'actor' => $actor,
            'action' => $action,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'details' => $details === null ? null : json_encode($details, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
        ]);
        // Occasional pruning keeps the trail from growing for ever without a
        // scheduled job — the same trick download_events uses. One entry in two
        // hundred pays for it, and only rows past the retention window go.
        if (random_int(1, 200) === 1) {
            $this->database->prepare(
                'DELETE FROM audit_log WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :days DAY)'
            )->execute(['days' => self::AUDIT_RETENTION_DAYS]);
        }
    }

    private function assertPermission(LegacyIdentity $identity, string $permission): void
    {
        if (in_array($identity->role, ['admin', 'super_admin'], true) && !$identity->isGuest) {
            return;
        }
        if (!in_array($permission, PermissionGroups::FLAGS, true)) {
            throw new BridgeAuthorizationException('Nieprawidłowe uprawnienie.');
        }
        // Resolve rights from the account's permission group — the same source
        // the session and the download gateway use — so an operator-defined
        // group actually governs these actions instead of only hiding buttons.
        if (($this->effectivePermissionsFor($identity)[$permission] ?? false) !== true) {
            throw new BridgeAuthorizationException('Ta operacja jest wyłączona dla Twojej grupy.');
        }
    }

    /** @return array<string, bool|int|string> */
    private function effectivePermissionsFor(LegacyIdentity $identity): array
    {
        return $this->effectivePermissions ??= (new PermissionGroups($this->database))->effective($identity->userId);
    }

    /** @return array{music:bool,movies:bool} */
    private function libraryAccess(LegacyIdentity $identity): array
    {
        if (in_array($identity->role, ['admin', 'super_admin'], true) && !$identity->isGuest) {
            return ['music' => true, 'movies' => true];
        }
        $effective = $this->effectivePermissionsFor($identity);
        return [
            'music' => ($effective['can_access_music'] ?? false) === true,
            'movies' => ($effective['can_access_movies'] ?? false) === true,
        ];
    }

    /** Refuse a library (music/movies) the caller's group does not cover. */
    /**
     * Public so an import can refuse an upload it would never be allowed to apply.
     *
     * Finding out at the end — after a file has been read, matched and reviewed —
     * that the account may not create a playlist is a waste of somebody's
     * afternoon, so the same right is checked at the start too.
     */
    public function assertCanCreateCollections(LegacyIdentity $identity): void
    {
        $this->assertPermission($identity, 'can_create_collections');
    }

    /**
     * Public for the same reason: handing out a guest link is sharing, and the
     * rule for who may share already lives here rather than in the router.
     */
    public function assertCanShare(LegacyIdentity $identity): void
    {
        $this->assertPermission($identity, 'can_share');
    }

    public function assertLibraryAccess(LegacyIdentity $identity, string $kind): void
    {
        $access = $this->libraryAccess($identity);
        if (($kind === 'music' && !$access['music']) || ($kind === 'movies' && !$access['movies'])) {
            throw new BridgeAuthorizationException('Ta biblioteka jest niedostępna dla Twojej grupy.');
        }
    }

    /**
     * Restrict an optional kind filter to the libraries the caller may see:
     * a requested kind must be accessible, "both" narrows to the accessible one,
     * and '' means nothing at all is accessible.
     */
    private function narrowLibraryKind(LegacyIdentity $identity, ?string $kind): ?string
    {
        $access = $this->libraryAccess($identity);
        if ($kind !== null) {
            $this->assertLibraryAccess($identity, $kind);
            return $kind;
        }
        if ($access['music'] && $access['movies']) {
            return null;
        }
        if ($access['music']) {
            return 'music';
        }
        return $access['movies'] ? 'movies' : '';
    }

    private static function assertAdmin(LegacyIdentity $identity): void
    {
        if (!in_array($identity->role, ['admin', 'super_admin'], true) || $identity->isGuest) {
            throw new BridgeAuthorizationException('Wymagane są uprawnienia administratora.');
        }
    }

    private static function positiveId(mixed $value): int
    {
        if (is_int($value) && $value > 0) {
            return $value;
        }
        throw new BridgeRequestException('Nieprawidłowy identyfikator.');
    }

    private static function optionalText(mixed $value, int $maximum): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_string($value)) {
            throw new BridgeRequestException('Nieprawidłowe dane tekstowe.');
        }
        $value = trim($value);
        if (strlen($value) > $maximum || preg_match('//u', $value) !== 1 || preg_match('/[\x00-\x1F\x7F]/u', $value) === 1) {
            throw new BridgeRequestException('Nieprawidłowe dane tekstowe.');
        }
        return $value === '' ? null : $value;
    }

    /** Same rules as self-registration, so an operator cannot mint a name the sign-in form would reject. */
    private static function username(mixed $value): string
    {
        $username = self::optionalText($value, 191);
        if ($username === null || preg_match(AccountGateway::USERNAME_PATTERN, $username) !== 1) {
            throw new BridgeRequestException(AccountGateway::USERNAME_RULE);
        }
        return $username;
    }

    private static function password(mixed $value): string
    {
        $minimum = AccountGateway::MINIMUM_PASSWORD_LENGTH;
        if (!is_string($value) || strlen($value) < $minimum || strlen($value) > 1024) {
            throw new BridgeRequestException("Hasło musi mieć co najmniej {$minimum} znaków.");
        }
        return $value;
    }

    private static function role(mixed $value): string
    {
        if (!is_string($value) || !in_array($value, ['user', 'admin', 'super_admin'], true)) {
            throw new BridgeRequestException('Nieprawidłowa rola.');
        }
        return $value;
    }
}
