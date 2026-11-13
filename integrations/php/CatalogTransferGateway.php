<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

final class CatalogTransferGateway
{
    private const MAX_ARCHIVE_ITEMS = 1000;

    /** Largest file list sealed into an archive token itself; past it the list goes to archive_manifests. */
    private const INLINE_ARCHIVE_BYTES = 32768;

    private const ARCHIVE_TTL_SECONDS = 300;

    /**
     * How long a preview grant lives, and for how long the bridge lets a browser
     * keep the redirect that carries it: the grant's life less two minutes, so a
     * kept redirect never points at a grant that has run out (the two clocks may
     * differ, and the picture has to be fetched after the redirect was).
     */
    private const THUMBNAIL_TTL_SECONDS = 900;
    public const THUMBNAIL_REDIRECT_SECONDS = 780;

    private ?PermissionGroups $groups = null;

    /** @var array<int, array<string, bool|int|string>> effective rights by account, for this request */
    private array $effective = [];

    public function __construct(
        private readonly PDO $database,
        private readonly string $encodedTransferKey,
        private readonly string $transferBaseUrl = '/media-transfer'
    ) {
        if ($this->encodedTransferKey === '') {
            throw new BridgeRequestException('Brak klucza transferowego.');
        }
    }

    /**
     * A file to play inline or to download — the two things a listener asks for
     * directly, and all a guest link ever hands out. Previews and compatibility
     * mode have their own methods below, because each is a different grant: the
     * transfer service opens a route only for the purpose sealed into the token.
     *
     * @return array{method:string,url:string,token:string,name:string,media_kind:string}
     */
    public function file(LegacyIdentity $identity, int $mediaItemId, bool $inline): array
    {
        return $this->issue(
            $identity,
            $mediaItemId,
            $inline ? TransferToken::PURPOSE_PLAY : TransferToken::PURPOSE_DOWNLOAD,
            '/v1/files/'
        );
    }

    /**
     * A preview picture: a frame of a film, the cover art inside a track, or an
     * image itself (the thumbnail route serves those as they are). The grant
     * opens nothing else — a preview's address ends up in an `<img>`, and it must
     * not double as a way to stream the whole file or to start a transcode.
     *
     * @return array{method:string,url:string,token:string,name:string,media_kind:string}
     */
    public function thumbnail(LegacyIdentity $identity, int $mediaItemId): array
    {
        return $this->issue(
            $identity,
            $mediaItemId,
            TransferToken::PURPOSE_THUMB,
            '/v1/thumbnails/',
            self::THUMBNAIL_TTL_SECONDS
        );
    }

    /**
     * @return array{method:string,url:string,token:string,name:string,media_kind:string}
     */
    private function issue(
        LegacyIdentity $identity,
        int $mediaItemId,
        string $purpose,
        string $route,
        int $ttlSeconds = 300,
        int $maxStreams = 0
    ): array {
        if ($mediaItemId < 1) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator pliku.');
        }
        $inline = $purpose !== TransferToken::PURPOSE_DOWNLOAD;
        $item = $this->findOne($mediaItemId);
        $this->assertLibraryAccess($identity, $item['root_kind']);
        $maxDownloads = 0;
        if (!$inline) {
            // Playing a track is not downloading it, so only a real transfer is
            // measured against the group's download rights and its whitelist.
            $this->assertDownloadScope($identity, 'file');
            $this->assertExtensionAllowed($identity, $item['file_extension']);
            $maxDownloads = $this->maxConcurrentDownloads($identity);
        }

        $name = self::fileName($item['relative_path']);
        try {
            $token = TransferToken::file(
                $this->encodedTransferKey,
                $item['root_slug'],
                $item['relative_path'],
                $name,
                $inline,
                $ttlSeconds,
                $identity->subject(),
                $maxStreams,
                $maxDownloads,
                $purpose
            );
        } catch (\InvalidArgumentException) {
            throw new BridgeRequestException('Tego pliku nie da się wydać (niedozwolony znak w nazwie).');
        }
        // Counted only once the token exists: a request that fails above has
        // downloaded nothing and must not use up the limit.
        if (!$inline) {
            $this->reserveDownload($identity, 'file', 1);
        }

        return [
            'method' => 'GET',
            'url' => $this->baseUrl() . $route . rawurlencode($token),
            'token' => $token,
            'name' => $name,
            'media_kind' => $item['media_kind'],
        ];
    }

    /**
     * Compatibility mode: the one grant that opens transcoding, track probing
     * and subtitles. Issued only to a group with `can_stream_compat`, and it
     * carries that group's stream cap — which is why no other grant may open it.
     *
     * @return array{method:string,url:string,token:string,name:string,media_kind:string}
     */
    public function stereo(LegacyIdentity $identity, int $mediaItemId): array
    {
        if (!$this->isPrivileged($identity) && ($this->effective($identity)['can_stream_compat'] ?? false) !== true) {
            throw new BridgeAuthorizationException('Tryb zgodny (transkodowanie) jest wyłączony dla Twojej grupy.');
        }
        // The per-group stream cap rides inside the token, so the transfer
        // service can enforce it without a database connection of its own.
        $transfer = $this->issue(
            $identity,
            $mediaItemId,
            TransferToken::PURPOSE_COMPAT,
            '/v1/stereo/',
            900,
            $this->maxConcurrentStreams($identity)
        );
        if ($transfer['media_kind'] !== 'video') {
            throw new BridgeRequestException('Tryb zgodny jest dostępny wyłącznie dla filmu.');
        }
        $base = (string) pathinfo($transfer['name'], PATHINFO_FILENAME);
        $transfer['name'] = ($base === '' ? 'movie' : $base) . '.compatible.mp4';
        return $transfer;
    }

    /**
     * @param array<int, mixed> $mediaItemIds
     * @return array{method:string,url:string,form:array{token:string},name:string,count:int}
     */
    public function archive(
        LegacyIdentity $identity,
        array $mediaItemIds,
        string $downloadName = 'media.zip',
        string $scope = 'selection'
    ): array {
        $ids = self::normalizeIds($mediaItemIds);
        $itemsById = $this->findMany($ids);
        if (count($itemsById) !== count($ids)) {
            throw new CatalogItemNotFoundException('Co najmniej jeden plik jest niedostępny.');
        }
        foreach ($itemsById as $item) {
            $this->assertLibraryAccess($identity, $item['root_kind']);
        }
        $this->assertDownloadScope($identity, $scope);

        // A whitelist filters the archive rather than refusing it: the listener
        // gets what they may have, and is told what was left behind. So does a
        // name no token may carry (a line break in a file name), which used to
        // take the whole archive down with it.
        $allowed = $this->allowedExtensions($identity);
        $grantItems = [];
        $skipped = 0;
        foreach ($ids as $id) {
            $item = $itemsById[$id];
            $entry = [
                'root' => $item['root_slug'],
                'path' => $item['relative_path'],
                'archive_name' => $item['root_slug'] . '/' . str_replace('\\', '/', $item['relative_path']),
            ];
            if (!PermissionGroups::allowsExtension($allowed, $item['file_extension'])
                || !TransferToken::sealableItem($entry)) {
                $skipped += 1;
                continue;
            }
            $grantItems[] = $entry;
        }
        if ($grantItems === []) {
            throw new BridgeAuthorizationException(
                'Żaden z tych plików nie ma rozszerzenia dozwolonego dla Twojej grupy.'
            );
        }

        $safeName = self::archiveName($downloadName);
        // The token first, the download count second: everything that can
        // still fail does so before anything is counted against the limit.
        $token = $this->sealArchive($identity, $grantItems, $safeName, $this->maxConcurrentDownloads($identity));
        $this->reserveDownload($identity, 'archive', count($grantItems));

        return [
            'method' => 'POST',
            'url' => $this->baseUrl() . '/v1/archives',
            'form' => ['token' => $token],
            'name' => $safeName,
            'count' => count($grantItems),
            'skipped' => $skipped,
        ];
    }

    /**
     * The token for an archive: its file list sealed inline while that stays
     * small, kept in `archive_manifests` and named by the token past that.
     *
     * Inline lists are what the transfer service has always read. Past
     * INLINE_ARCHIVE_BYTES of list the token would outgrow its 64 KiB cap
     * somewhere around 270 files, so the list is stored for the token's
     * lifetime and the token carries its key, digest and length instead.
     *
     * @param list<array{root:string,path:string,archive_name:string}> $items
     */
    private function sealArchive(LegacyIdentity $identity, array $items, string $name, int $maxDownloads): string
    {
        $list = json_encode($items, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (strlen($list) <= self::INLINE_ARCHIVE_BYTES) {
            return TransferToken::archive(
                $this->encodedTransferKey,
                $items,
                $name,
                self::ARCHIVE_TTL_SECONDS,
                $identity->subject(),
                $maxDownloads
            );
        }
        $key = random_bytes(32);
        // Expired lists go as new ones arrive; the index keeps this a range delete.
        $this->database->exec('DELETE FROM archive_manifests WHERE expires_at < CURRENT_TIMESTAMP(6)');
        $insert = $this->database->prepare(
            'INSERT INTO archive_manifests (manifest_key, user_id, item_count, items_json, expires_at)
             VALUES (:manifest_key, :user_id, :item_count, :items_json,
                     DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL :ttl SECOND))'
        );
        $insert->bindValue(':manifest_key', $key, PDO::PARAM_LOB);
        $insert->bindValue(':user_id', $identity->userId, PDO::PARAM_INT);
        $insert->bindValue(':item_count', count($items), PDO::PARAM_INT);
        $insert->bindValue(':items_json', $list, PDO::PARAM_LOB);
        // A minute past the token, so a clock a little ahead of the other
        // never finds the list gone while the token still opens.
        $insert->bindValue(':ttl', self::ARCHIVE_TTL_SECONDS + 60, PDO::PARAM_INT);
        $insert->execute();
        return TransferToken::archiveManifest(
            $this->encodedTransferKey,
            bin2hex($key),
            hash('sha256', $list),
            count($items),
            $name,
            self::ARCHIVE_TTL_SECONDS,
            $identity->subject(),
            $maxDownloads
        );
    }

    /**
     * Gate one kind of download on the caller's group.
     *
     * The four kinds are separate decisions: a single file, a set the listener
     * ticked, a whole folder (a playlist counts as one), and the library root as
     * a single archive.
     *
     * Public so a caller can ask before doing the work of collecting file
     * identifiers: "your group may not do this" is a better answer than "that is
     * too many files", and the root of a large library hits the archive cap long
     * before it reaches the rights check.
     */
    public function assertDownloadScope(LegacyIdentity $identity, string $scope): void
    {
        if ($this->isPrivileged($identity)) {
            return;
        }
        $flag = match ($scope) {
            'file' => 'can_download_file',
            'selection' => 'can_download_selection',
            'folder' => 'can_download_folder',
            'library' => 'can_download_library',
            default => throw new BridgeRequestException('Nieznany rodzaj pobierania.'),
        };
        if (($this->effective($identity)[$flag] ?? false) !== true) {
            throw new BridgeAuthorizationException(match ($scope) {
                'file' => 'Pobieranie pojedynczych plików jest wyłączone dla Twojej grupy.',
                'selection' => 'Pobieranie zaznaczonych plików jest wyłączone dla Twojej grupy.',
                'folder' => 'Pobieranie folderów jest wyłączone dla Twojej grupy.',
                default => 'Pobieranie całej biblioteki jest wyłączone dla Twojej grupy.',
            });
        }
    }

    private function allowedExtensions(LegacyIdentity $identity): string
    {
        if ($this->isPrivileged($identity)) {
            return '';
        }
        return (string) ($this->effective($identity)['download_extensions'] ?? '');
    }

    private function assertExtensionAllowed(LegacyIdentity $identity, ?string $extension): void
    {
        if (!PermissionGroups::allowsExtension($this->allowedExtensions($identity), $extension)) {
            throw new BridgeAuthorizationException(
                'Twoja grupa nie może pobierać plików z rozszerzeniem .' . ($extension ?? '?') . '.'
            );
        }
    }

    /**
     * Refuse access to a library the caller's group does not cover.
     *
     * Roots are music, movies or mixed; a mixed root is reachable with either right.
     */
    public function assertLibraryAccess(LegacyIdentity $identity, string $rootKind): void
    {
        if ($this->isPrivileged($identity)) {
            return;
        }
        if (!PermissionGroups::opensSource($this->effective($identity), $rootKind)) {
            throw new BridgeAuthorizationException('Ta biblioteka jest niedostępna dla Twojej grupy.');
        }
    }

    /**
     * Gate a non-inline transfer on the caller's rights and quotas, and record it.
     *
     * Rights come from the account's permission group. Two independent quotas
     * apply: the group's own limit inside its window and the global limit inside
     * the global window; both must pass, zero means unlimited. A quota counts
     * **downloads**, not files: one file is one, and so is one archive, whatever
     * it holds (the archive's own size is capped separately, at 1000 files).
     * `item_count` records how many files a download carried — for whoever
     * reads the ledger, not for the limit. Check and insert
     * happen inside one transaction that locks the caller's user row, so two
     * concurrent requests (two sessions, download managers) cannot both slip
     * under the quota.
     */
    private function reserveDownload(LegacyIdentity $identity, string $kind, int $itemCount): void
    {
        if ($this->isPrivileged($identity)) {
            return;
        }
        $effective = $this->effective($identity);
        $quotas = [];
        $groupLimit = max(0, (int) ($effective['download_limit'] ?? 0));
        if ($groupLimit > 0) {
            $quotas[] = [$groupLimit, max(1, (int) ($effective['download_window_minutes'] ?? 60))];
        }
        [$globalLimit, $globalWindow] = $this->globalQuota();
        if ($globalLimit > 0) {
            $quotas[] = [$globalLimit, $globalWindow];
        }

        $this->database->beginTransaction();
        try {
            if ($quotas !== []) {
                $lock = $this->database->prepare('SELECT id FROM users WHERE id = :id FOR UPDATE');
                $lock->execute(['id' => $identity->userId]);
                $count = $this->database->prepare(
                    'SELECT COUNT(*) FROM download_events
                     WHERE user_id = :user_id
                       AND created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :minutes MINUTE)'
                );
                foreach ($quotas as [$limit, $windowMinutes]) {
                    $count->execute(['user_id' => $identity->userId, 'minutes' => $windowMinutes]);
                    if ((int) $count->fetchColumn() >= $limit) {
                        $this->database->rollBack();
                        throw new BridgeRateLimitException('Przekroczono limit pobierania.');
                    }
                }
            }
            $this->database->prepare(
                'INSERT INTO download_events (user_id, kind, item_count) VALUES (:user_id, :kind, :item_count)'
            )->execute(['user_id' => $identity->userId, 'kind' => $kind, 'item_count' => $itemCount]);
            $this->database->commit();
        } catch (BridgeRateLimitException $limited) {
            throw $limited;
        } catch (\Throwable $error) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $error;
        }
        // Opportunistic cleanup keeps the ledger from growing without bound.
        if (random_int(1, 100) === 1) {
            $this->database->exec(
                'DELETE FROM download_events WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 8 DAY)'
            );
        }
    }

    private function maxConcurrentStreams(LegacyIdentity $identity): int
    {
        if ($this->isPrivileged($identity)) {
            return 0;
        }
        return max(0, (int) ($this->effective($identity)['max_concurrent_streams'] ?? 0));
    }

    private function maxConcurrentDownloads(LegacyIdentity $identity): int
    {
        if ($this->isPrivileged($identity)) {
            return 0;
        }
        return max(0, (int) ($this->effective($identity)['max_concurrent_downloads'] ?? 0));
    }

    /** @return array{0:int,1:int} limit and window in minutes; limit 0 disables */
    private function globalQuota(): array
    {
        $limit = 0;
        $window = 60;
        try {
            $statement = $this->database->prepare(
                'SELECT setting_key, setting_value FROM app_settings
                 WHERE setting_key IN (\'download_rate_limit\', \'download_rate_window_minutes\')'
            );
            $statement->execute();
            foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
                if ($row['setting_key'] === 'download_rate_limit') {
                    $limit = max(0, min(10000, (int) $row['setting_value']));
                } elseif ($row['setting_key'] === 'download_rate_window_minutes') {
                    $window = max(1, min(10080, (int) $row['setting_value']));
                }
            }
        } catch (\PDOException) {
            return [0, 60];
        }
        return [$limit, $window];
    }

    private function isPrivileged(LegacyIdentity $identity): bool
    {
        return $identity->isOperator();
    }

    /** @return array<string, bool|int|string> */
    private function effective(LegacyIdentity $identity): array
    {
        return $this->effective[$identity->userId] ??= $this->permissionGroups()->effective($identity->userId);
    }

    private function permissionGroups(): PermissionGroups
    {
        return $this->groups ??= new PermissionGroups($this->database);
    }

    /** @return array{root_slug:string,root_kind:string,relative_path:string,media_kind:string,file_extension:?string} */
    private function findOne(int $id): array
    {
        $statement = $this->database->prepare(
            "SELECT mr.slug AS root_slug, mr.media_kind AS root_kind, mi.relative_path, mi.media_kind, mi.file_extension
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id
             WHERE mi.id = :id
               AND mi.deleted_at IS NULL
               AND mr.is_enabled = 1
               AND mi.catalog_status = 'ready'
             LIMIT 1"
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Plik jest niedostępny.');
        }
        return self::catalogRow($row);
    }

    /**
     * @param array<int, int> $ids
     * @return array<int, array{root_slug:string,root_kind:string,relative_path:string,media_kind:string,file_extension:?string}>
     */
    private function findMany(array $ids): array
    {
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $statement = $this->database->prepare(
            "SELECT mi.id, mr.slug AS root_slug, mr.media_kind AS root_kind, mi.relative_path, mi.media_kind, mi.file_extension
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id
             WHERE mi.id IN ($placeholders)
               AND mi.deleted_at IS NULL
               AND mr.is_enabled = 1
               AND mi.catalog_status = 'ready'"
        );
        $statement->execute($ids);

        $rows = [];
        while (($row = $statement->fetch(PDO::FETCH_ASSOC)) !== false) {
            $id = (int) ($row['id'] ?? 0);
            if ($id > 0) {
                $rows[$id] = self::catalogRow($row);
            }
        }
        return $rows;
    }

    /** @param array<string, mixed> $row
     * @return array{root_slug:string,root_kind:string,relative_path:string,media_kind:string,file_extension:?string}
     */
    private static function catalogRow(array $row): array
    {
        $root = $row['root_slug'] ?? null;
        $rootKind = $row['root_kind'] ?? null;
        $path = $row['relative_path'] ?? null;
        $kind = $row['media_kind'] ?? null;
        if (!is_string($root) || !is_string($path) || !is_string($kind) || $root === '' || $path === '') {
            throw new CatalogItemNotFoundException('Plik jest niedostępny.');
        }
        return [
            'root_slug' => $root,
            'root_kind' => is_string($rootKind) ? $rootKind : 'mixed',
            'relative_path' => $path,
            'media_kind' => $kind,
            'file_extension' => is_string($row['file_extension'] ?? null) ? $row['file_extension'] : null,
        ];
    }

    /** @param array<int, mixed> $values
     * @return array<int, int>
     */
    private static function normalizeIds(array $values): array
    {
        if ($values === [] || count($values) > self::MAX_ARCHIVE_ITEMS) {
            throw new BridgeRequestException('Nieprawidłowa liczba plików.');
        }
        $ids = [];
        foreach ($values as $value) {
            if (is_int($value) && $value > 0) {
                $id = $value;
            } elseif (is_string($value) && preg_match('/\A[1-9][0-9]*\z/D', $value) === 1) {
                $id = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
                if (!is_int($id)) {
                    throw new BridgeRequestException('Nieprawidłowy identyfikator pliku.');
                }
            } else {
                throw new BridgeRequestException('Nieprawidłowy identyfikator pliku.');
            }
            $ids[$id] = $id;
        }
        return array_values($ids);
    }

    private static function fileName(string $relativePath): string
    {
        $normalized = str_replace('\\', '/', $relativePath);
        $name = basename($normalized);
        return $name !== '' && $name !== '.' ? $name : 'media.bin';
    }

    private static function archiveName(string $name): string
    {
        $name = trim($name);
        if ($name === '' || strlen($name) > 512 || strpbrk($name, "\0\r\n") !== false) {
            throw new BridgeRequestException('Nieprawidłowa nazwa archiwum.');
        }
        return str_ends_with(strtolower($name), '.zip') ? $name : $name . '.zip';
    }

    private function baseUrl(): string
    {
        return rtrim($this->transferBaseUrl, '/');
    }
}
