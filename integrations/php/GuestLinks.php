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

    /** How many links the author's own list shows, newest first. */
    private const MINE_LIMIT = 50;

    /** What a visitor is told for every refusal, whatever its reason. */
    private const GONE = 'Ten link wygasł albo nie istnieje.';

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

    /**
     * Links this account has handed out, newest first, and how many there are.
     *
     * The list stops at MINE_LIMIT; `total` is there so the page can say so
     * instead of showing fifty links as if they were all of them.
     *
     * @return array{links: array<int, array<string, mixed>>, total: int, limit: int}
     */
    public function mine(LegacyIdentity $identity): array
    {
        $count = $this->database->prepare('SELECT COUNT(*) FROM guest_links WHERE created_by = :author');
        $count->execute(['author' => $identity->userId]);
        $statement = $this->database->prepare(
            'SELECT id, target_kind, target_id, label, max_downloads, downloads_used,
                    expires_at, last_used_at, revoked_at, created_at
               FROM guest_links WHERE created_by = :author
              ORDER BY created_at DESC LIMIT ' . self::MINE_LIMIT
        );
        $statement->execute(['author' => $identity->userId]);
        $links = array_map(static fn (array $row): array => [
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
        return ['links' => $links, 'total' => (int) $count->fetchColumn(), 'limit' => self::MINE_LIMIT];
    }

    /** Stop a link working. Kept as a row so the list still shows what happened. */
    public function revoke(LegacyIdentity $identity, array $payload): array
    {
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
    public function open(string $token): array
    {
        [$link, $identity] = $this->resolve($token);
        ['items' => $items, 'total' => $total] = $this->listing($link, $identity, self::LISTING_LIMIT);
        return [
            'label' => (string) $link['label'],
            'target_kind' => (string) $link['target_kind'],
            'expires_at' => (string) $link['expires_at'],
            'max_downloads' => (int) $link['max_downloads'],
            'downloads_used' => (int) $link['downloads_used'],
            'items' => $items,
            // The listing stops at LISTING_LIMIT; a visitor is told how much
            // more there is instead of taking five hundred for everything.
            'total' => $total,
            'truncated' => $total > count($items),
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
        CatalogTransferGateway $gateway
    ): array {
        [$link, $identity] = $this->resolve($token);
        // Asked of the target itself, through the same rules as the listing,
        // rather than looked up in the first page of it: a file past the
        // listing's limit is still part of what was shared.
        if ($this->listing($link, $identity, 1, $mediaItemId)['items'] === []) {
            throw new CatalogItemNotFoundException('Ten plik nie należy do udostępnienia.');
        }
        if (!$inline) {
            // `max_downloads` is how many downloads the link allows, and **zero
            // means none** — a link handed out for listening should not quietly
            // double as a way to take the files away. "No limit" is expressed as
            // the largest budget the validator accepts rather than as a magic
            // zero, so every value in the column reads the same way.
            //
            // Claimed in one conditional UPDATE, not read and then incremented:
            // between the read and the write, twenty parallel requests against a
            // one-download link all saw "0 used" and all got a token.
            $claim = $this->database->prepare(
                'UPDATE guest_links
                    SET downloads_used = downloads_used + 1, last_used_at = CURRENT_TIMESTAMP(6)
                  WHERE id = :id AND downloads_used < max_downloads'
            );
            $claim->execute(['id' => (int) $link['id']]);
            if ($claim->rowCount() !== 1) {
                throw new BridgeAuthorizationException('Ten link nie pozwala na pobieranie.');
            }
            try {
                return $gateway->file($identity, $mediaItemId, false);
            } catch (\Throwable $error) {
                // No token, no download: the claimed slot goes back.
                $this->database->prepare(
                    'UPDATE guest_links SET downloads_used = GREATEST(downloads_used - 1, 0) WHERE id = :id'
                )->execute(['id' => (int) $link['id']]);
                throw $error;
            }
        }
        $transfer = $gateway->file($identity, $mediaItemId, true);
        $this->database->prepare(
            'UPDATE guest_links SET last_used_at = CURRENT_TIMESTAMP(6) WHERE id = :id'
        )->execute(['id' => (int) $link['id']]);
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
        if (preg_match('/^[A-Za-z0-9_-]{16,64}$/D', $token) !== 1) {
            throw new CatalogItemNotFoundException('Ten link wygasł albo nie istnieje.');
        }
        // Expiry is decided in the database, not in PHP. The timestamp is
        // written by MySQL's clock and read back as a bare local string; parsing
        // it here compares it against PHP's clock, and the two run in different
        // time zones on this machine — a link "expired a minute ago" looked two
        // hours fresh. One clock, one comparison, no arithmetic.
        $statement = $this->database->prepare(
            'SELECT g.*, u.id AS author_id, u.username, u.role, u.is_guest, u.is_active, u.disabled_at
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
        if (!is_array($row) || (int) $row['is_active'] !== 1 || $row['disabled_at'] !== null) {
            throw new CatalogItemNotFoundException(self::GONE);
        }
        $identity = new LegacyIdentity(
            (int) $row['author_id'],
            (string) $row['username'],
            (string) $row['role'],
            (int) $row['is_guest'] === 1
        );
        // What made the link legal when it was issued has to still hold: an
        // author who may no longer share, or who is now a guest account, has
        // no links. The target is checked by the listing itself (below).
        try {
            if ($identity->isGuest) {
                throw new BridgeAuthorizationException('Konto gościa nie może udostępniać.');
            }
            (new CatalogActions($this->database))->assertCanShare($identity);
        } catch (BridgeAuthorizationException) {
            throw new CatalogItemNotFoundException(self::GONE);
        }
        return [$row, $identity];
    }

    /**
     * The files behind the link as its author may see them now, as titles and
     * durations and nothing else, plus how many there are in all.
     *
     * Rights are read here, on every visit, not only when the link was made.
     * Checked once, a link outlived every reason it had been allowed: a
     * playlist its owner had stopped sharing stayed readable to anybody holding
     * a link to it, and so did a folder of a library the author had lost.
     * Whatever the reason a check fails for, the visitor hears the same thing
     * as for an expired link.
     *
     * With `$onlyItem` the answer is that one item or nothing — the question a
     * transfer asks — read through the very same rules.
     *
     * @param array<string, mixed> $link
     * @return array{items: array<int, array{id:int,title:string,artist:string|null,media_kind:string,duration_ms:int}>, total: int}
     */
    private function listing(array $link, LegacyIdentity $identity, int $limit, ?int $onlyItem = null): array
    {
        try {
            if ((string) $link['target_kind'] === 'collection') {
                $read = (new CatalogActions($this->database))
                    ->guestCollection($identity, (int) $link['target_id'], $limit, $onlyItem);
                $rows = $read['items'];
                $total = $read['total'];
            } else {
                [$rows, $total] = $this->folderListing($identity, (int) $link['target_id'], $limit, $onlyItem);
            }
        } catch (BridgeAuthorizationException | CatalogItemNotFoundException) {
            throw new CatalogItemNotFoundException(self::GONE);
        }
        return [
            'items' => array_map(static fn (array $row): array => [
                'id' => (int) $row['id'],
                'title' => (string) $row['title'],
                'artist' => $row['artist'] === null ? null : (string) $row['artist'],
                'media_kind' => (string) $row['media_kind'],
                'duration_ms' => (int) ($row['duration_ms'] ?? 0),
            ], $rows),
            'total' => $total,
        ];
    }

    /**
     * A shared folder's playable files, after checking the folder is still
     * there and still in a library its author can reach.
     *
     * @return array{0: list<array<string, mixed>>, 1: int}
     */
    private function folderListing(LegacyIdentity $identity, int $directoryId, int $limit, ?int $onlyItem): array
    {
        $folder = $this->database->prepare(
            'SELECT md.root_id, md.path_hash, md.relative_path, mr.media_kind
               FROM media_directories md
               INNER JOIN media_roots mr ON mr.id = md.root_id AND mr.is_enabled = 1
              WHERE md.id = :id AND md.deleted_at IS NULL LIMIT 1'
        );
        $folder->execute(['id' => $directoryId]);
        $row = $folder->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !in_array((string) $row['media_kind'], ['music', 'movies'], true)) {
            throw new CatalogItemNotFoundException(self::GONE);
        }
        (new CatalogActions($this->database))->assertLibraryAccess($identity, (string) $row['media_kind']);

        // One arm, not `directory_hash = ? OR relative_path LIKE ?`: the OR kept
        // MySQL off both indexes (LibraryBrowser::subtreeSql has the numbers).
        // A folder is its path prefix, compared byte for byte as well so that a
        // link to `Cafe` never opens what lies in `Café`; the root is its own
        // files only — a link to the root folder shares those, as it always
        // has, not the whole library.
        $isRoot = (string) $row['relative_path'] === '';
        $pattern = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], (string) $row['relative_path']) . '/%';
        $scope = 'mi.root_id = :root_id AND '
            . ($isRoot
                ? 'mi.directory_hash = :path_hash'
                : "mi.relative_path LIKE :path_prefix ESCAPE '\\\\'"
                    . " AND mi.relative_path LIKE :path_exact COLLATE utf8mb4_bin ESCAPE '\\\\'")
            . " AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready'
                    AND mi.media_kind IN ('audio', 'video')"
            . ($onlyItem !== null ? ' AND mi.id = :only_item' : '');
        $bind = static function (\PDOStatement $statement) use ($row, $isRoot, $pattern, $onlyItem): void {
            $statement->bindValue(':root_id', (int) $row['root_id'], PDO::PARAM_INT);
            if ($isRoot) {
                $statement->bindValue(':path_hash', (string) $row['path_hash'], PDO::PARAM_LOB);
            } else {
                $statement->bindValue(':path_prefix', $pattern, PDO::PARAM_STR);
                $statement->bindValue(':path_exact', $pattern, PDO::PARAM_STR);
            }
            if ($onlyItem !== null) {
                $statement->bindValue(':only_item', $onlyItem, PDO::PARAM_INT);
            }
        };
        $statement = $this->database->prepare(
            "SELECT mi.id, COALESCE(mo.title, mi.title) AS title,
                    COALESCE(mo.artist, mi.artist) AS artist, mi.media_kind, mi.duration_ms
               FROM media_items mi
               LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
              WHERE {$scope}
              ORDER BY mi.relative_path, mi.id
              LIMIT :row_limit"
        );
        $bind($statement);
        $statement->bindValue(':row_limit', max(1, $limit), PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        if ($onlyItem !== null) {
            return [$rows, count($rows)];
        }
        $count = $this->database->prepare("SELECT COUNT(*) FROM media_items mi WHERE {$scope}");
        $bind($count);
        $count->execute();
        return [$rows, (int) $count->fetchColumn()];
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
            // Read once the way every visit will read it (guestCollection): the
            // library, and for somebody else's list the right to browse other
            // people's. Without the second check an account lacking that right
            // could make a link to a shared list — a link that was dead on its
            // first visit, and every one after.
            (new CatalogActions($this->database))->guestCollection($identity, $targetId, 1);
            return (string) $row['name'];
        }
        $statement = $this->database->prepare(
            'SELECT md.name, mr.media_kind FROM media_directories md
               INNER JOIN media_roots mr ON mr.id = md.root_id AND mr.is_enabled = 1
              WHERE md.id = :id AND md.deleted_at IS NULL LIMIT 1'
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
}
