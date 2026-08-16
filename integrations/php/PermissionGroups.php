<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

/**
 * Named permission groups and the rights they grant.
 *
 * The two original sets, `user` and `guest`, are ordinary rows flagged as system
 * groups. Keeping them in the same table as operator-defined groups means the
 * settings screen and the group manager read and write one place, so they cannot
 * drift apart. The group is the single source of truth for an account's rights;
 * `users.is_guest` merely mirrors membership of the system guest group.
 */
final class PermissionGroups
{
    public const FLAGS = [
        // Downloading is four decisions, not one: a single track, a set the
        // listener ticked, a whole folder, and the library root as one archive.
        'can_download_file', 'can_download_selection', 'can_download_folder', 'can_download_library',
        'can_rate', 'can_favorite', 'can_create_collections',
        'can_browse_collections', 'can_browse_profiles', 'can_share',
        'can_access_music', 'can_access_movies', 'can_stream_compat', 'can_edit_metadata',
    ];
    /** limit => [min, max, default] */
    public const LIMITS = [
        'max_concurrent_streams' => [0, 10000, 0],
        'download_limit' => [0, 10000, 0],
        // Minutes; the quota above is counted inside this rolling window.
        'download_window_minutes' => [1, 10080, 60],
        'max_concurrent_downloads' => [0, 10000, 0],
    ];
    /** Free-text group settings; empty means "no restriction". */
    public const TEXTS = ['download_extensions'];
    public const GUEST_SLUG = 'guest';
    public const USER_SLUG = 'user';
    private const MAXIMUM_GROUPS = 40;

    public function __construct(private readonly PDO $database)
    {
    }

    /**
     * Tidy a hand-typed extension whitelist into one comparable form.
     *
     * The operator may type "MP3, .flac; mkv" — what gets stored is
     * "flac,mkv,mp3", which is what the download check compares against. An
     * empty list means no restriction at all.
     */
    public static function normalizeExtensions(mixed $raw): string
    {
        if (!is_string($raw)) {
            return '';
        }
        $found = [];
        foreach (preg_split('/[\s,;]+/', mb_strtolower($raw)) ?: [] as $candidate) {
            $candidate = ltrim(trim($candidate), '.');
            if ($candidate !== '' && preg_match('/^[a-z0-9]{1,10}$/D', $candidate) === 1) {
                $found[$candidate] = true;
            }
        }
        $extensions = array_keys($found);
        sort($extensions);
        // The column holds 255 characters; drop the tail rather than fail a save.
        $joined = '';
        foreach ($extensions as $extension) {
            $next = $joined === '' ? $extension : $joined . ',' . $extension;
            if (strlen($next) > 255) {
                break;
            }
            $joined = $next;
        }
        return $joined;
    }

    /**
     * Whether a group's whitelist admits a file.
     *
     * @param string $allowed comma-separated list, empty for "anything"
     */
    public static function allowsExtension(string $allowed, ?string $extension): bool
    {
        if ($allowed === '') {
            return true;
        }
        $extension = ltrim(mb_strtolower(trim((string) $extension)), '.');
        return $extension !== '' && in_array($extension, explode(',', $allowed), true);
    }

    /** @return array<int, array<string, mixed>> */
    public function all(): array
    {
        $rows = $this->database
            ->query('SELECT * FROM permission_groups ORDER BY sort_order, name')
            ->fetchAll(PDO::FETCH_ASSOC);
        $counts = $this->memberCounts();
        return array_map(static function (array $row) use ($counts): array {
            $group = [
                'id' => (int) $row['id'],
                'slug' => (string) $row['slug'],
                'name' => (string) $row['name'],
                'description' => (string) $row['description'],
                'is_system' => (int) $row['is_system'] === 1,
                'sort_order' => (int) $row['sort_order'],
                'members' => $counts[(int) $row['id']] ?? 0,
            ];
            foreach (self::FLAGS as $flag) {
                $group[$flag] = (int) $row[$flag] === 1;
            }
            foreach (self::LIMITS as $limit => [, , $default]) {
                $group[$limit] = (int) ($row[$limit] ?? $default);
            }
            foreach (self::TEXTS as $text) {
                $group[$text] = (string) ($row[$text] ?? '');
            }
            return $group;
        }, $rows);
    }

    /**
     * Rights that actually apply to one account.
     *
     * An account with no group, or one whose group was deleted, falls back to the
     * system group its guest flag implies, so nobody is ever left rightless.
     *
     * @return array<string, bool|int|string>
     */
    public function effective(int $userId): array
    {
        $statement = $this->database->prepare(
            'SELECT g.* FROM users u
             LEFT JOIN permission_groups g ON g.id = u.permission_group_id
             WHERE u.id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || $row['id'] === null) {
            $fallback = $this->database->prepare(
                'SELECT g.* FROM users u
                 INNER JOIN permission_groups g
                   ON g.slug = CASE WHEN u.is_guest = 1 THEN \'guest\' ELSE \'user\' END
                 WHERE u.id = :id LIMIT 1'
            );
            $fallback->execute(['id' => $userId]);
            $row = $fallback->fetch(PDO::FETCH_ASSOC);
        }
        $effective = [];
        foreach (self::FLAGS as $flag) {
            $effective[$flag] = is_array($row) && (int) $row[$flag] === 1;
        }
        foreach (self::LIMITS as $limit => [, , $default]) {
            $effective[$limit] = is_array($row) ? (int) ($row[$limit] ?? $default) : $default;
        }
        foreach (self::TEXTS as $text) {
            $effective[$text] = is_array($row) ? (string) ($row[$text] ?? '') : '';
        }
        $effective['group_slug'] = is_array($row) ? (string) $row['slug'] : '';
        $effective['group_name'] = is_array($row) ? (string) $row['name'] : '';
        return $effective;
    }

    /**
     * Create or update a group.
     *
     * @param array<string, mixed> $payload
     */
    public function save(array $payload): int
    {
        $id = isset($payload['id']) ? (int) $payload['id'] : 0;
        $name = trim((string) ($payload['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 64) {
            throw new BridgeRequestException('Nazwa grupy musi mieć od 1 do 64 znaków.');
        }
        $description = trim((string) ($payload['description'] ?? ''));
        if (mb_strlen($description) > 255) {
            throw new BridgeRequestException('Opis grupy jest zbyt długi.');
        }

        $values = [];
        foreach (self::FLAGS as $flag) {
            $values[$flag] = ($payload[$flag] ?? false) === true ? 1 : 0;
        }
        foreach (self::LIMITS as $limit => [$minimum, $maximum, $default]) {
            $number = filter_var(
                $payload[$limit] ?? $default,
                FILTER_VALIDATE_INT,
                ['options' => ['min_range' => $minimum, 'max_range' => $maximum]]
            );
            if ($number === false) {
                throw new BridgeRequestException("Limit {$limit} musi być liczbą od {$minimum} do {$maximum}.");
            }
            $values[$limit] = $number;
        }
        foreach (self::TEXTS as $text) {
            $values[$text] = self::normalizeExtensions($payload[$text] ?? '');
        }
        $sortOrder = filter_var($payload['sort_order'] ?? 100, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 9999]]);
        $values['sort_order'] = $sortOrder === false ? 100 : $sortOrder;

        if ($id > 0) {
            $existing = $this->requireGroup($id);
            // A system group may be renamed and re-scoped, but its slug is what
            // the fallback lookup keys on, so that stays put.
            $assignments = implode(', ', array_map(static fn (string $key): string => "{$key} = :{$key}", array_keys($values)));
            $statement = $this->database->prepare(
                "UPDATE permission_groups SET name = :name, description = :description, {$assignments} WHERE id = :id"
            );
            $statement->execute($values + ['name' => $name, 'description' => $description, 'id' => $id]);
            return (int) $existing['id'];
        }

        if (count($this->all()) >= self::MAXIMUM_GROUPS) {
            throw new BridgeRequestException('Osiągnięto limit liczby grup.');
        }
        $slug = self::slugify($payload['slug'] ?? $name);
        if ($this->slugTaken($slug)) {
            throw new BridgeRequestException('Grupa o takim identyfikatorze już istnieje.');
        }
        $columns = array_keys($values);
        $statement = $this->database->prepare(
            'INSERT INTO permission_groups (slug, name, description, is_system, ' . implode(', ', $columns) . ')
             VALUES (:slug, :name, :description, 0, :' . implode(', :', $columns) . ')'
        );
        $statement->execute($values + ['slug' => $slug, 'name' => $name, 'description' => $description]);
        return (int) $this->database->lastInsertId();
    }

    /**
     * Remove a group and move its members onto a replacement (the system user
     * group when none is given), so no account is ever left without a group.
     */
    public function delete(int $id, ?int $replacementId): void
    {
        $group = $this->requireGroup($id);
        if ((int) $group['is_system'] === 1) {
            throw new BridgeRequestException('Grupy systemowej nie można usunąć.');
        }
        $replacement = $replacementId !== null && $replacementId !== $id
            ? $this->requireGroup($replacementId)
            : $this->requireSystemGroup(self::USER_SLUG);

        $this->database->beginTransaction();
        try {
            // Without this the foreign key would blank the column and members
            // would silently drop to their fallback group.
            $move = $this->database->prepare(
                'UPDATE users SET permission_group_id = :target,
                        is_guest = :guest
                  WHERE permission_group_id = :source'
            );
            $move->execute([
                'target' => (int) $replacement['id'],
                'guest' => (string) $replacement['slug'] === self::GUEST_SLUG ? 1 : 0,
                'source' => $id,
            ]);
            $this->database->prepare('DELETE FROM permission_groups WHERE id = :id')->execute(['id' => $id]);
            $this->database->commit();
        } catch (\Throwable $error) {
            $this->database->rollBack();
            throw $error;
        }
    }

    public function exists(int $id): bool
    {
        return $this->slugOf($id) !== null;
    }

    /** Slug of a group, or null when it does not exist. */
    public function slugOf(int $id): ?string
    {
        $statement = $this->database->prepare('SELECT slug FROM permission_groups WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $id]);
        $slug = $statement->fetchColumn();
        return is_string($slug) ? $slug : null;
    }

    /** Identifier of a system group by slug. */
    public function systemGroupId(string $slug): int
    {
        return (int) $this->requireSystemGroup($slug)['id'];
    }

    /** @return array<int, int> */
    private function memberCounts(): array
    {
        $counts = [];
        $rows = $this->database
            ->query('SELECT permission_group_id, COUNT(*) AS total FROM users
                     WHERE permission_group_id IS NOT NULL GROUP BY permission_group_id')
            ->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            $counts[(int) $row['permission_group_id']] = (int) $row['total'];
        }
        return $counts;
    }

    /** @return array<string, mixed> */
    private function requireGroup(int $id): array
    {
        $statement = $this->database->prepare('SELECT * FROM permission_groups WHERE id = :id LIMIT 1');
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new BridgeRequestException('Grupa nie istnieje.');
        }
        return $row;
    }

    /** @return array<string, mixed> */
    private function requireSystemGroup(string $slug): array
    {
        $statement = $this->database->prepare(
            'SELECT * FROM permission_groups WHERE slug = :slug AND is_system = 1 LIMIT 1'
        );
        $statement->execute(['slug' => $slug]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new BridgeRequestException('Brak grupy systemowej.');
        }
        return $row;
    }

    private function slugTaken(string $slug): bool
    {
        $statement = $this->database->prepare('SELECT 1 FROM permission_groups WHERE slug = :slug LIMIT 1');
        $statement->execute(['slug' => $slug]);
        return $statement->fetchColumn() !== false;
    }

    private static function slugify(mixed $value): string
    {
        $text = is_string($value) ? $value : '';
        $ascii = @iconv('UTF-8', 'ASCII//TRANSLIT', $text);
        $text = strtolower(is_string($ascii) ? $ascii : $text);
        $text = (string) preg_replace('/[^a-z0-9]+/', '-', $text);
        $text = trim($text, '-');
        if ($text === '') {
            $text = 'grupa';
        }
        // Leave room for the suffix that keeps a collision from failing outright.
        $text = substr($text, 0, 24);
        return $text . '-' . substr(bin2hex(random_bytes(4)), 0, 6);
    }
}
