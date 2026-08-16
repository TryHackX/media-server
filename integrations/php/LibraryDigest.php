<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

/**
 * "What is new in the library", once a week, to whoever asked for it.
 *
 * A home server fills up quietly: somebody drops twenty albums into a folder,
 * the scanner picks them up at three in the morning, and nobody else finds out
 * until they happen to scroll past. This is the one message that says so.
 *
 * Three rules shape it.
 *
 * **Nobody is subscribed by default.** A row in `user_digests` exists because a
 * person chose it. Mail that starts arriving because an update was installed is
 * mail people stop trusting.
 *
 * **It reports what the reader may actually see.** The same library rights the
 * catalogue enforces are applied here, so an account without the film library is
 * not told about films it cannot open. Getting this wrong would turn a courtesy
 * into a leak.
 *
 * **It says less than it knows.** Titles and counts go out; paths, folders and
 * identifiers do not. The message leaves the building, and nothing in it should
 * describe how the disk is arranged.
 */
final class LibraryDigest
{
    /** How many titles are named per library before the message just counts. */
    private const SAMPLE = 8;

    /** A weekly digest is not sent again within this many days. */
    private const MIN_INTERVAL_DAYS = 6;

    public function __construct(
        private readonly PDO $database,
        private readonly Mailer $mailer,
        private readonly string $baseUrl
    ) {
    }

    /**
     * Send whatever is due, and report what happened.
     *
     * `force` is the panel's "send now": it ignores the weekly interval but not
     * the subscription — an operator may want to see the message today, and
     * still may not sign anybody up for it.
     *
     * @return array{sent:int,skipped:int,empty:int,spooled:bool,recipients:array<int,string>}
     */
    public function run(bool $force = false, ?int $onlyUserId = null): array
    {
        if (!$this->tableExists()) {
            return ['sent' => 0, 'skipped' => 0, 'empty' => 0, 'spooled' => $this->mailer->usesSpool(), 'recipients' => []];
        }
        $sql =
            'SELECT d.user_id, d.covered_until, d.last_sent_at, u.username, u.email,
                    u.permission_group_id, u.role, u.is_guest, u.is_active
               FROM user_digests d
               INNER JOIN users u ON u.id = d.user_id
              WHERE d.frequency = :frequency AND u.is_active = 1 AND u.email IS NOT NULL';
        $params = ['frequency' => 'weekly'];
        if (!$force) {
            // "Not more often than weekly" is asked of the database, whose clock
            // wrote the timestamp. Parsing it in PHP compares it against a
            // different clock — the two run in different time zones on this
            // machine, and a week measured across them is a week plus two hours.
            $sql .= ' AND (d.last_sent_at IS NULL
                           OR d.last_sent_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :interval DAY))';
            $params['interval'] = self::MIN_INTERVAL_DAYS;
        }
        if ($onlyUserId !== null) {
            $sql .= ' AND d.user_id = :only_user';
            $params['only_user'] = $onlyUserId;
        }
        $statement = $this->database->prepare($sql);
        $statement->execute($params);
        $due = $statement->fetchAll(PDO::FETCH_ASSOC);

        $sent = 0;
        $empty = 0;
        // Everybody subscribed, minus those this run is going to consider: the
        // difference is exactly the accounts whose week is not up yet.
        $subscribers = (int) $this->database
            ->query("SELECT COUNT(*) FROM user_digests d INNER JOIN users u ON u.id = d.user_id
                      WHERE d.frequency = 'weekly' AND u.is_active = 1 AND u.email IS NOT NULL")
            ->fetchColumn();
        $skipped = $onlyUserId === null ? max(0, $subscribers - count($due)) : 0;
        $recipients = [];
        foreach ($due as $row) {
            $userId = (int) $row['user_id'];
            $since = is_string($row['covered_until']) && $row['covered_until'] !== ''
                ? $row['covered_until']
                // A first digest looks back a week rather than over the whole
                // history: "new" means new, not "everything you own".
                : date('Y-m-d H:i:s', time() - 7 * 24 * 3600);
            $news = $this->news($userId, $since);
            if ($news['total'] === 0) {
                // Nothing arrived. Silence is the honest report, and the window
                // stays open so next week's message covers this week too.
                $empty++;
                continue;
            }
            $this->mailer->send(
                (string) $row['email'],
                'Nowości w bibliotece TryHackX Media',
                $this->compose((string) $row['username'], $news)
            );
            $this->markSent($userId, $news['newest']);
            $sent++;
            $recipients[] = (string) $row['username'];
        }
        return [
            'sent' => $sent,
            'skipped' => $skipped,
            'empty' => $empty,
            'spooled' => $this->mailer->usesSpool(),
            'recipients' => $recipients,
        ];
    }

    /** What one account is allowed to be told about, since a given moment.
     *
     * @return array{total:int,newest:string,libraries:array<int, array{kind:string,count:int,titles:array<int,string>}>}
     */
    public function news(int $userId, string $since): array
    {
        $access = (new PermissionGroups($this->database))->effective($userId);
        $kinds = [];
        if (($access['can_access_music'] ?? false) === true) {
            $kinds['music'] = 'audio';
        }
        if (($access['can_access_movies'] ?? false) === true) {
            $kinds['movies'] = 'video';
        }
        $libraries = [];
        $total = 0;
        $newest = $since;
        foreach ($kinds as $kind => $mediaKind) {
            $statement = $this->database->prepare(
                "SELECT COALESCE(mo.title, mi.title) AS title, mi.indexed_at
                   FROM media_items mi
                   LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                  WHERE mi.media_kind = :media_kind
                    AND mi.deleted_at IS NULL
                    AND mi.catalog_status IN ('ready', 'legacy')
                    AND mi.indexed_at > :since
                  ORDER BY mi.indexed_at DESC, mi.id DESC
                  LIMIT 500"
            );
            $statement->execute(['media_kind' => $mediaKind, 'since' => $since]);
            $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
            if ($rows === []) {
                continue;
            }
            foreach ($rows as $row) {
                $stamp = (string) $row['indexed_at'];
                if (strcmp($stamp, $newest) > 0) {
                    $newest = $stamp;
                }
            }
            $total += count($rows);
            $libraries[] = [
                'kind' => $kind,
                'count' => count($rows),
                'titles' => array_slice(array_map(
                    static fn (array $row): string => (string) $row['title'],
                    $rows
                ), 0, self::SAMPLE),
            ];
        }
        return ['total' => $total, 'newest' => $newest, 'libraries' => $libraries];
    }

    /**
     * The subscription as the account sees it.
     *
     * @return array{frequency:string,last_sent_at:string|null,covered_until:string|null,has_email:bool}
     */
    public function subscription(int $userId): array
    {
        $email = $this->database->prepare('SELECT email FROM users WHERE id = :id LIMIT 1');
        $email->execute(['id' => $userId]);
        $address = $email->fetchColumn();
        $default = [
            'frequency' => 'off',
            'last_sent_at' => null,
            'covered_until' => null,
            'has_email' => is_string($address) && $address !== '',
        ];
        if (!$this->tableExists()) {
            return $default;
        }
        $statement = $this->database->prepare(
            'SELECT frequency, last_sent_at, covered_until FROM user_digests WHERE user_id = :id LIMIT 1'
        );
        $statement->execute(['id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return $default;
        }
        return [
            'frequency' => (string) $row['frequency'],
            'last_sent_at' => $row['last_sent_at'] === null ? null : (string) $row['last_sent_at'],
            'covered_until' => $row['covered_until'] === null ? null : (string) $row['covered_until'],
            'has_email' => $default['has_email'],
        ];
    }

    /**
     * Subscribe or unsubscribe.
     *
     * Subscribing starts the window now rather than in the past: the first
     * message reports what arrives from here on, which is what somebody ticking
     * the box is asking for.
     */
    public function subscribe(int $userId, string $frequency): void
    {
        if (!in_array($frequency, ['off', 'weekly'], true)) {
            throw new BridgeRequestException('Nieprawidłowa częstotliwość powiadomień.');
        }
        $this->assertTable();
        $statement = $this->database->prepare(
            'INSERT INTO user_digests (user_id, frequency, covered_until)
             VALUES (:user_id, :frequency, CURRENT_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE frequency = VALUES(frequency)'
        );
        $statement->execute(['user_id' => $userId, 'frequency' => $frequency]);
    }

    /** How many accounts asked for the digest, and when one last went out. */
    /** @return array{subscribers:int,last_sent_at:string|null,spooled:bool} */
    public function status(): array
    {
        if (!$this->tableExists()) {
            return ['subscribers' => 0, 'last_sent_at' => null, 'spooled' => $this->mailer->usesSpool()];
        }
        $row = $this->database
            ->query("SELECT COUNT(*) AS subscribers, MAX(last_sent_at) AS last_sent_at
                       FROM user_digests WHERE frequency = 'weekly'")
            ->fetch(PDO::FETCH_ASSOC);
        return [
            'subscribers' => (int) ($row['subscribers'] ?? 0),
            'last_sent_at' => $row['last_sent_at'] === null ? null : (string) $row['last_sent_at'],
            'spooled' => $this->mailer->usesSpool(),
        ];
    }

    /** @param array{total:int,newest:string,libraries:array<int, array{kind:string,count:int,titles:array<int,string>}>} $news */
    private function compose(string $username, array $news): string
    {
        $names = ['music' => 'Muzyka', 'movies' => 'Filmy'];
        $lines = ["Cześć {$username},", '', "W bibliotece pojawiło się {$news['total']} nowych pozycji:", ''];
        foreach ($news['libraries'] as $library) {
            $lines[] = ($names[$library['kind']] ?? $library['kind']) . ' — ' . $library['count'] . ':';
            foreach ($library['titles'] as $title) {
                $lines[] = '  · ' . $title;
            }
            if ($library['count'] > count($library['titles'])) {
                $lines[] = '  … i ' . ($library['count'] - count($library['titles'])) . ' więcej';
            }
            $lines[] = '';
        }
        $lines[] = 'Cała biblioteka: ' . rtrim($this->baseUrl, '/') . '/';
        $lines[] = '';
        $lines[] = 'Ten przegląd wysyłamy raz w tygodniu, bo tak ustawiono to na koncie.';
        $lines[] = 'Można go wyłączyć w zakładce „Moje konto”.';
        return implode("\n", $lines) . "\n";
    }

    private function markSent(int $userId, string $newest): void
    {
        $statement = $this->database->prepare(
            'UPDATE user_digests
                SET last_sent_at = CURRENT_TIMESTAMP(6), covered_until = :covered
              WHERE user_id = :user_id'
        );
        $statement->execute(['covered' => $newest, 'user_id' => $userId]);
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
        $statement->execute(['name' => 'user_digests']);
        return $this->table = (int) $statement->fetchColumn() === 1;
    }

    private function assertTable(): void
    {
        if (!$this->tableExists()) {
            throw new BridgeRequestException('Funkcja oczekuje na migrację bazy danych.');
        }
    }
}
