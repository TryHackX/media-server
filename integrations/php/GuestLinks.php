<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

/**
 * One folder or one playlist, handed to somebody who has no account here.
 *
 * The whole design rests on a single decision: a guest link does not create a
 * visitor with rights of their own. It **acts as its author**. Opening a link
 * resolves it to the account that made it, and every listing and every transfer
 * then runs through the ordinary gateway with that identity — same library
 * access, same extension whitelist, same download accounting. A guest can never
 * reach anything its author could not, and there is no second permission system
 * to keep in step with the first.
 *
 * On top of that the link adds its own three limits, which are the only things
 * it knows how to say no about: it names one target, it expires, and it counts
 * downloads against a budget. Playing something inline is not a download and is
 * not counted — a link meant for listening should not run out because somebody
 * listened.
 *
 * The token is generated here, shown once, and stored only as a SHA-256. What is
 * in the database cannot be turned back into a working link.
 */
final class GuestLinks
{
    /** Longest life a link may be given, and the default when none is asked for. */
    private const MAX_TTL_DAYS = 90;
    private const DEFAULT_TTL_DAYS = 7;

    /** Nothing personal travels to a guest: no paths, no owners, no accounts. */
    private const LISTING_LIMIT = 500;

    public function __construct(private readonly PDO $database)
    {
    }

    /**
     * The whole feature behind one switch, off until an operator says otherwise.
     *
     * It is checked on **every** path, not only when a link is made: turning it
     * off has to stop the links that are already out there, otherwise the switch
     * is a suggestion. A link the owner regrets is exactly the case this exists
     * for, and telling them "the new ones will not work" would be no answer.
     */
    public function enabled(): bool
    {
        $statement = $this->database->prepare(
            "SELECT setting_value FROM app_settings WHERE setting_key = 'guest_links_enabled' LIMIT 1"
        );
        try {
            $statement->execute();
        } catch (\Throwable) {
            return false;
        }
        return (string) $statement->fetchColumn() === '1';
    }

    private function assertEnabled(): void
    {
        if (!$this->enabled()) {
            throw new BridgeAuthorizationException('Linki gościnne są wyłączone na tym serwerze.');
        }
    }

    /**
     * Create a link and return it — this is the only moment the token exists.
     *
     * @param array<string, mixed> $payload
     * @return array{token:string,url:string,expires_at:string,max_downloads:int,label:string}
     */
    public function issue(LegacyIdentity $identity, array $payload, string $baseUrl): array
    {
        $this->assertEnabled();
        $this->assertTable();
        if ($identity->isGuest) {
            throw new BridgeAuthorizationException('Konto gościa nie może udostępniać.');
        }
        $kind = $payload['target_kind'] ?? '';
        if (!is_string($kind) || !in_array($kind, ['directory', 'collection'], true)) {
            throw new BridgeRequestException('Nieprawidłowy rodzaj udostępnienia.');
        }
        $targetId = $payload['target_id'] ?? null;
        if (!is_int($targetId) || $targetId < 1) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator udostępnienia.');
        }
        $days = $payload['days'] ?? self::DEFAULT_TTL_DAYS;
        if (!is_int($days) || $days < 1 || $days > self::MAX_TTL_DAYS) {
            throw new BridgeRequestException('Czas ważności musi mieścić się w zakresie 1–90 dni.');
        }
        $maxDownloads = $payload['max_downloads'] ?? 0;
        if (!is_int($maxDownloads) || $maxDownloads < 0 || $maxDownloads > 10000) {
            throw new BridgeRequestException('Limit pobrań musi mieścić się w zakresie 0–10000.');
        }
        // Checked as the author, now, rather than when a guest arrives: a link to
        // something you cannot reach should fail while you are still looking at
        // the button, not silently a week later in somebody else's browser.
        $label = $this->assertTarget($identity, $kind, $targetId);

        $token = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
        $statement = $this->database->prepare(
            'INSERT INTO guest_links (token_hash, created_by, target_kind, target_id, label,
                                      max_downloads, expires_at)
             VALUES (:hash, :author, :kind, :target, :label, :max_downloads,
                     DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL :days DAY))'
        );
        $statement->bindValue(':hash', hash('sha256', 'guest|' . $token, true), PDO::PARAM_LOB);
        $statement->bindValue(':author', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':kind', $kind, PDO::PARAM_STR);
        $statement->bindValue(':target', $targetId, PDO::PARAM_INT);
        $statement->bindValue(':label', $label, PDO::PARAM_STR);
        $statement->bindValue(':max_downloads', $maxDownloads, PDO::PARAM_INT);
        $statement->bindValue(':days', $days, PDO::PARAM_INT);
        $statement->execute();

        $row = $this->database->prepare('SELECT expires_at FROM guest_links WHERE id = :id');
        $row->execute(['id' => (int) $this->database->lastInsertId()]);
        return [
            'token' => $token,
            'url' => rtrim($baseUrl, '/') . '/guest/?token=' . rawurlencode($token),
            'expires_at' => (string) $row->fetchColumn(),
            'max_downloads' => $maxDownloads,
            'label' => $label,
        ];
    }

    /** Links this account has handed out, newest first. @return array<int, array<string, mixed>> */
    public function mine(LegacyIdentity $identity): array
    {
        if (!$this->tableExists()) {
            return [];
        }
        $statement = $this->database->prepare(
            'SELECT id, target_kind, target_id, label, max_downloads, downloads_used,
                    expires_at, last_used_at, revoked_at, created_at
               FROM guest_links WHERE created_by = :author
              ORDER BY created_at DESC LIMIT 50'
        );
        $statement->execute(['author' => $identity->userId]);
        return array_map(static fn (array $row): array => [
            'id' => (int) $row['id'],
            'target_kind' => (string) $row['target_kind'],
            'target_id' => (int) $row['target_id'],
            'label' => (string) $row['label'],
            'max_downloads' => (int) $row['max_downloads'],
            'downloads_used' => (int) $row['downloads_used'],
            'expires_at' => (string) $row['expires_at'],
            'last_used_at' => $row['last_used_at'] === null ? null : (string) $row['last_used_at'],
            'revoked_at' => $row['revoked_at'] === null ? null : (string) $row['revoked_at'],
            'created_at' => (string) $row['created_at'],
        ], $statement->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Stop a link working. Kept as a row so the list still shows what happened. */
    public function revoke(LegacyIdentity $identity, array $payload): array
    {
        $this->assertTable();
        $id = $payload['link_id'] ?? null;
        if (!is_int($id) || $id < 1) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator linku.');
        }
        $statement = $this->database->prepare(
            'UPDATE guest_links SET revoked_at = CURRENT_TIMESTAMP(6)
              WHERE id = :id AND created_by = :author AND revoked_at IS NULL'
        );
        $statement->execute(['id' => $id, 'author' => $identity->userId]);
        return ['success' => true, 'revoked' => $statement->rowCount()];
    }

    /**
     * What a visitor sees: the name, what is on the list, and what is left.
     *
     * @return array<string, mixed>
     */
    public function open(string $token, LibraryBrowser $library): array
    {
        [$link, $identity] = $this->resolve($token);
        $items = $this->items($link, $identity, $library);
        return [
            'label' => (string) $link['label'],
            'target_kind' => (string) $link['target_kind'],
            'expires_at' => (string) $link['expires_at'],
            'max_downloads' => (int) $link['max_downloads'],
            'downloads_used' => (int) $link['downloads_used'],
            'items' => $items,
        ];
    }

    /**
     * A transfer for one item of the link, as the link's author.
     *
     * The item is checked against the link's own contents first: a token for one
     * folder must not become a key to the catalogue by way of an identifier
     * typed into the request.
     *
     * @return array<string, mixed>
     */
    public function transfer(
        string $token,
        int $mediaItemId,
        bool $inline,
        LibraryBrowser $library,
        CatalogTransferGateway $gateway
    ): array {
        [$link, $identity] = $this->resolve($token);
        $allowed = array_column($this->items($link, $identity, $library), 'id');
        if (!in_array($mediaItemId, $allowed, true)) {
            throw new CatalogItemNotFoundException('Ten plik nie należy do udostępnienia.');
        }
        if (!$inline) {
            // `max_downloads` is how many downloads the link allows, and **zero
            // means none** — a link handed out for listening should not quietly
            // double as a way to take the files away. "No limit" is expressed as
            // the largest budget the validator accepts rather than as a magic
            // zero, so every value in the column reads the same way.
            if ((int) $link['downloads_used'] >= (int) $link['max_downloads']) {
                throw new BridgeAuthorizationException('Ten link nie pozwala na pobieranie.');
            }
        }
        $transfer = $gateway->file($identity, $mediaItemId, $inline);
        $this->database->prepare(
            'UPDATE guest_links
                SET downloads_used = downloads_used + :increment, last_used_at = CURRENT_TIMESTAMP(6)
              WHERE id = :id'
        )->execute(['increment' => $inline ? 0 : 1, 'id' => (int) $link['id']]);
        return $transfer;
    }

    /**
     * Token to link and author, or a refusal that says nothing useful.
     *
     * Expired, revoked and unknown all answer the same way on purpose: a visitor
     * fishing for valid tokens learns nothing from the difference.
     *
     * @return array{0: array<string, mixed>, 1: LegacyIdentity}
     */
    private function resolve(string $token): array
    {
        $this->assertEnabled();
        $this->assertTable();
        if (preg_match('/^[A-Za-z0-9_-]{16,64}$/D', $token) !== 1) {
            throw new CatalogItemNotFoundException('Ten link wygasł albo nie istnieje.');
        }
        // Expiry is decided in the database, not in PHP. The timestamp is
        // written by MySQL's clock and read back as a bare local string; parsing
        // it here compares it against PHP's clock, and the two run in different
        // time zones on this machine — a link "expired a minute ago" looked two
        // hours fresh. One clock, one comparison, no arithmetic.
        $statement = $this->database->prepare(
            'SELECT g.*, u.id AS author_id, u.username, u.role, u.is_guest, u.is_active
               FROM guest_links g
               INNER JOIN users u ON u.id = g.created_by
              WHERE g.token_hash = :hash
                AND g.revoked_at IS NULL
                AND g.expires_at > CURRENT_TIMESTAMP(6)
              LIMIT 1'
        );
        $statement->bindValue(':hash', hash('sha256', 'guest|' . $token, true), PDO::PARAM_LOB);
        $statement->execute();
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || (int) $row['is_active'] !== 1) {
            throw new CatalogItemNotFoundException('Ten link wygasł albo nie istnieje.');
        }
        return [$row, new LegacyIdentity(
            (int) $row['author_id'],
            (string) $row['username'],
            (string) $row['role'],
            (int) $row['is_guest'] === 1
        )];
    }

    /**
     * The files behind the link, as titles and durations and nothing else.
     *
     * @param array<string, mixed> $link
     * @return array<int, array{id:int,title:string,artist:string|null,media_kind:string,duration_ms:int}>
     */
    private function items(array $link, LegacyIdentity $identity, LibraryBrowser $library): array
    {
        if ((string) $link['target_kind'] === 'collection') {
            $statement = $this->database->prepare(
                "SELECT mi.id, COALESCE(mo.title, mi.title) AS title,
                        COALESCE(mo.artist, mi.artist) AS artist, mi.media_kind, mi.duration_ms
                   FROM user_collection_items uci
                   INNER JOIN media_items mi ON mi.id = uci.media_item_id
                   LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                  WHERE uci.collection_id = :target
                    AND mi.deleted_at IS NULL AND mi.catalog_status IN ('ready', 'legacy')
                  ORDER BY uci.position, mi.id
                  LIMIT " . self::LISTING_LIMIT
            );
        } else {
            $statement = $this->database->prepare(
                "SELECT mi.id, COALESCE(mo.title, mi.title) AS title,
                        COALESCE(mo.artist, mi.artist) AS artist, mi.media_kind, mi.duration_ms
                   FROM media_items mi
                   INNER JOIN media_directories md ON md.id = :target
                   LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                  WHERE mi.root_id = md.root_id
                    AND (mi.directory_hash = md.path_hash
                         OR mi.relative_path LIKE CONCAT(REPLACE(REPLACE(md.relative_path, '\\\\', '\\\\\\\\'), '%', '\\\\%'), '/%'))
                    AND mi.deleted_at IS NULL AND mi.catalog_status IN ('ready', 'legacy')
                    AND mi.media_kind IN ('audio', 'video')
                  ORDER BY mi.relative_path, mi.id
                  LIMIT " . self::LISTING_LIMIT
            );
        }
        $statement->execute(['target' => (int) $link['target_id']]);
        return array_map(static fn (array $row): array => [
            'id' => (int) $row['id'],
            'title' => (string) $row['title'],
            'artist' => $row['artist'] === null ? null : (string) $row['artist'],
            'media_kind' => (string) $row['media_kind'],
            'duration_ms' => (int) ($row['duration_ms'] ?? 0),
        ], $statement->fetchAll(PDO::FETCH_ASSOC));
    }

    /** The target must exist and belong to (or be readable by) the author. */
    private function assertTarget(LegacyIdentity $identity, string $kind, int $targetId): string
    {
        if ($kind === 'collection') {
            $statement = $this->database->prepare(
                'SELECT name, media_kind FROM user_collections
                  WHERE id = :id AND (user_id = :author OR is_shared = 1) LIMIT 1'
            );
            $statement->execute(['id' => $targetId, 'author' => $identity->userId]);
            $row = $statement->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                throw new CatalogItemNotFoundException('Playlista nie istnieje.');
            }
            (new CatalogActions($this->database))->assertLibraryAccess($identity, (string) $row['media_kind']);
            return (string) $row['name'];
        }
        $statement = $this->database->prepare(
            'SELECT md.name, mr.media_kind FROM media_directories md
               INNER JOIN media_roots mr ON mr.id = md.root_id
              WHERE md.id = :id LIMIT 1'
        );
        $statement->execute(['id' => $targetId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Folder nie istnieje.');
        }
        // A root declares itself 'music' or 'movies' (or 'mixed', which no
        // library right covers and which therefore cannot be handed to a guest).
        $rootKind = (string) $row['media_kind'];
        if (!in_array($rootKind, ['music', 'movies'], true)) {
            throw new BridgeRequestException('Tego katalogu nie można udostępnić linkiem.');
        }
        (new CatalogActions($this->database))->assertLibraryAccess($identity, $rootKind);
        return (string) $row['name'];
    }

    private ?bool $table = null;

    private function tableExists(): bool
    {
        if ($this->table !== null) {
            return $this->table;
        }
        $statement = $this->database->prepare(
            'SELECT COUNT(*) FROM information_schema.tables
              WHERE table_schema = DATABASE() AND table_name = :name'
        );
        $statement->execute(['name' => 'guest_links']);
        return $this->table = (int) $statement->fetchColumn() === 1;
    }

    private function assertTable(): void
    {
        if (!$this->tableExists()) {
            throw new BridgeRequestException('Funkcja oczekuje na migrację bazy danych.');
        }
    }
}
