<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

final class CatalogTransferGateway
{
    private const MAX_ARCHIVE_ITEMS = 1000;

    private ?PermissionGroups $groups = null;

    /** @var array<string, bool|int|string>|null */
    private ?array $effective = null;

    /** @var array<string, bool> */
    private array $knownTables = [];

    public function __construct(
        private readonly PDO $database,
        private readonly string $encodedTransferKey,
        private readonly string $transferBaseUrl = '/media-transfer'
    ) {
        if ($this->encodedTransferKey === '') {
            throw new BridgeRequestException('Brak klucza transferowego.');
        }
    }

    /** @return array{method:string,url:string,token:string,name:string,media_kind:string} */
    public function file(
        LegacyIdentity $identity,
        int $mediaItemId,
        bool $inline,
        int $ttlSeconds = 300,
        int $maxStreams = 0
    ): array {
        if ($mediaItemId < 1) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator pliku.');
        }
        $item = $this->findOne($mediaItemId);
        $this->assertLibraryAccess($identity, $item['root_kind']);
        $maxDownloads = 0;
        if (!$inline) {
            // Playing a track is not downloading it, so only a real transfer is
            // measured against the group's download rights and its whitelist.
            $this->assertDownloadScope($identity, 'file');
            $this->assertExtensionAllowed($identity, $item['file_extension']);
            $this->reserveDownload($identity, 'file', 1);
            $maxDownloads = $this->maxConcurrentDownloads($identity);
        }

        $name = self::fileName($item['relative_path']);
        $token = TransferToken::file(
            $this->encodedTransferKey,
            $item['root_slug'],
            $item['relative_path'],
            $name,
            $inline,
            $ttlSeconds,
            $identity->subject(),
            $maxStreams,
            $maxDownloads
        );

        return [
            'method' => 'GET',
            'url' => $this->baseUrl() . '/v1/files/' . rawurlencode($token),
            'token' => $token,
            'name' => $name,
            'media_kind' => $item['media_kind'],
        ];
    }

    /** @return array{method:string,url:string,token:string,name:string,media_kind:string} */
    public function stereo(LegacyIdentity $identity, int $mediaItemId): array
    {
        if (!$this->isPrivileged($identity) && ($this->effective($identity)['can_stream_compat'] ?? false) !== true) {
            throw new BridgeAuthorizationException('Tryb zgodny (transkodowanie) jest wyłączony dla Twojej grupy.');
        }
        // The per-group stream cap rides inside the token, so the transfer
        // service can enforce it without a database connection of its own.
        $transfer = $this->file($identity, $mediaItemId, true, 900, $this->maxConcurrentStreams($identity));
        if ($transfer['media_kind'] !== 'video') {
            throw new BridgeRequestException('Tryb zgodny jest dostępny wyłącznie dla filmu.');
        }
        $transfer['url'] = str_replace('/v1/files/', '/v1/stereo/', $transfer['url']);
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
        // gets what they may have, and is told what was left behind.
        $allowed = $this->allowedExtensions($identity);
        $grantItems = [];
        $skipped = 0;
        foreach ($ids as $id) {
            $item = $itemsById[$id];
            if (!PermissionGroups::allowsExtension($allowed, $item['file_extension'])) {
                $skipped += 1;
                continue;
            }
            $grantItems[] = [
                'root' => $item['root_slug'],
                'path' => $item['relative_path'],
                'archive_name' => $item['root_slug'] . '/' . str_replace('\\', '/', $item['relative_path']),
            ];
        }
        if ($grantItems === []) {
            throw new BridgeAuthorizationException(
                'Żaden z tych plików nie ma rozszerzenia dozwolonego dla Twojej grupy.'
            );
        }
        $this->reserveDownload($identity, 'archive', count($grantItems));

        $safeName = self::archiveName($downloadName);
        $token = TransferToken::archive(
            $this->encodedTransferKey,
            $grantItems,
            $safeName,
            300,
            $identity->subject(),
            $this->maxConcurrentDownloads($identity)
        );

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
        $effective = $this->effective($identity);
        $music = ($effective['can_access_music'] ?? false) === true;
        $movies = ($effective['can_access_movies'] ?? false) === true;
        $allowed = match ($rootKind) {
            'music' => $music,
            'movies' => $movies,
            default => $music || $movies,
        };
        if (!$allowed) {
            throw new BridgeAuthorizationException('Ta biblioteka jest niedostępna dla Twojej grupy.');
        }
    }

    /**
     * Gate a non-inline transfer on the caller's rights and quotas, and record it.
     *
     * Rights come from the account's permission group. Two independent quotas
     * apply: the group's own limit inside its window and the global limit inside
     * the global window; both must pass, zero means unlimited. Check and insert
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
        if (!$this->tableExists('download_events')) {
            return;
        }
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
        return in_array($identity->role, ['admin', 'super_admin'], true) && !$identity->isGuest;
    }

    /** @return array<string, bool|int|string> */
    private function effective(LegacyIdentity $identity): array
    {
        return $this->effective ??= $this->permissionGroups()->effective($identity->userId);
    }

    private function permissionGroups(): PermissionGroups
    {
        return $this->groups ??= new PermissionGroups($this->database);
    }

    private function tableExists(string $table): bool
    {
        if (isset($this->knownTables[$table])) {
            return $this->knownTables[$table];
        }
        $statement = $this->database->prepare(
            'SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = :table_name'
        );
        $statement->execute(['table_name' => $table]);
        return $this->knownTables[$table] = (int) $statement->fetchColumn() === 1;
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
               AND mi.catalog_status IN ('ready', 'legacy')
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
               AND mi.catalog_status IN ('ready', 'legacy')"
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
