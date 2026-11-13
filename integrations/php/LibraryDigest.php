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

    /** How far back a first digest looks. */
    private const FIRST_LOOKBACK_DAYS = 7;

    /**
     * How far back any digest looks, however long ago the last one went out.
     *
     * The window normally runs from what the previous message covered, which
     * is right week to week. After a long silence — a subscription switched
     * off for months, an account disabled for a season, a mail server down for
     * a month — it was months wide, and the message was the whole library
     * delivered at once. Two weeks still covers one missed run.
     */
    private const MAX_LOOKBACK_DAYS = 14;

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
     * `budgetSeconds` is for a run inside a web request (the panel's button):
     * every message is a conversation with a mail server, a slow or dead one
     * takes its timeout per recipient, and the request must still end. Past
     * the budget the remaining accounts are left for the next run and counted
     * as `deferred`. So that pressing the button again carries on instead of
     * starting over, a forced run skips whoever got a message in the last ten
     * minutes. The scheduled run from the command line has no budget.
     *
     * @return array{sent:int,skipped:int,empty:int,failed:int,deferred:int,failed_recipients:array<int,string>,spooled:bool,recipients:array<int,string>}
     */
    public function run(bool $force = false, ?int $onlyUserId = null, ?float $budgetSeconds = null): array
    {
        $started = microtime(true);
        // Where each message starts is worked out by the database, whose clock
        // wrote covered_until: a first digest looks back a week, every digest
        // at most MAX_LOOKBACK_DAYS.
        $sql =
            'SELECT d.user_id, d.covered_until, d.last_sent_at, u.username, u.email,
                    u.permission_group_id, u.role, u.is_guest, u.is_active,
                    GREATEST(
                        COALESCE(d.covered_until, DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :first_days DAY)),
                        DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :max_days DAY)
                    ) AS since
               FROM user_digests d
               INNER JOIN users u ON u.id = d.user_id
              WHERE d.frequency = :frequency AND u.is_active = 1 AND u.email IS NOT NULL';
        $params = [
            'frequency' => 'weekly',
            'first_days' => self::FIRST_LOOKBACK_DAYS,
            'max_days' => self::MAX_LOOKBACK_DAYS,
        ];
        if (!$force) {
            // "Not more often than weekly" is asked of the database, whose clock
            // wrote the timestamp. Parsing it in PHP compares it against a
            // different clock — the two run in different time zones on this
            // machine, and a week measured across them is a week plus two hours.
            $sql .= ' AND (d.last_sent_at IS NULL
                           OR d.last_sent_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :interval DAY))';
            $params['interval'] = self::MIN_INTERVAL_DAYS;
        } else {
            $sql .= ' AND (d.last_sent_at IS NULL
                           OR d.last_sent_at < DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 10 MINUTE))';
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
        $failed = [];
        $deferred = 0;
        foreach ($due as $index => $row) {
            if ($budgetSeconds !== null && microtime(true) - $started > $budgetSeconds) {
                $deferred = count($due) - $index;
                break;
            }
            $userId = (int) $row['user_id'];
            $news = $this->news($userId, (string) $row['since']);
            if ($news['total'] === 0) {
                // Nothing arrived. Silence is the honest report, and the window
                // stays open so next week's message covers this week too.
                $empty++;
                continue;
            }
            // One recipient at a time, each on its own. A deleted mailbox or one
            // refusing address used to throw out of this loop, so everybody after
            // it got nothing — and the failed row stays due, so the same address
            // stopped the whole run again the next week, and the week after.
            try {
                $this->mailer->send(
                    (string) $row['email'],
                    'Nowości w bibliotece TryHackX Media',
                    $this->compose((string) $row['username'], $news)
                );
            } catch (\Throwable $error) {
                // Left due on purpose: a mail server that is down today may not
                // be tomorrow, and the next run will cover this week as well.
                error_log(sprintf('[digest] sending to user %d failed: %s', $userId, $error->getMessage()));
                $failed[] = (string) $row['username'];
                continue;
            }
            $this->markSent($userId, $news['newest']);
            $sent++;
            $recipients[] = (string) $row['username'];
        }
        return [
            'sent' => $sent,
            'skipped' => $skipped,
            'empty' => $empty,
            'failed' => count($failed),
            'deferred' => $deferred,
            'failed_recipients' => $failed,
            'spooled' => $this->mailer->usesSpool(),
            'recipients' => $recipients,
        ];
    }

    /**
     * What one account is allowed to be told about, since a given moment.
     *
     * "New" is when the file entered the catalogue (`created_at`), not when a
     * scan last saw it: every scan rewrites `indexed_at` for every file, so the
     * first digest after a scan would have announced the whole library.
     *
     * @return array{total:int,newest:string,libraries:array<int, array{kind:string,count:int,titles:array<int,string>}>}
     */
    public function news(int $userId, string $since): array
    {
        $access = (new PermissionGroups($this->database))->effective($userId);
        // A library is a source: the music side's audio, the film side's video,
        // and a mixed root's files split by what they are — the same rule the
        // catalogue's own lists follow, so an account is told about exactly
        // what it could open.
        $kinds = [];
        if (($access['can_access_music'] ?? false) === true) {
            $kinds['music'] = "mi.media_kind = 'audio' AND mr.media_kind IN ('music', 'mixed')";
        }
        if (($access['can_access_movies'] ?? false) === true) {
            $kinds['movies'] = "mi.media_kind = 'video' AND mr.media_kind IN ('movies', 'mixed')";
        }
        $libraries = [];
        $total = 0;
        $newest = $since;
        $scope = " FROM media_items mi
                   INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                   LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                  WHERE %s
                    AND mi.deleted_at IS NULL
                    AND mi.catalog_status = 'ready'
                    AND mi.created_at > :since";
        foreach ($kinds as $kind => $library) {
            // Counted, not listed: the count used to be the length of a list cut
            // at 500, so a big scan was reported as "500 new items".
            $count = $this->database->prepare(
                'SELECT COUNT(*) AS items, MAX(mi.created_at) AS newest' . sprintf($scope, $library)
            );
            $count->execute(['since' => $since]);
            $summary = $count->fetch(PDO::FETCH_ASSOC);
            $items = (int) ($summary['items'] ?? 0);
            if ($items === 0) {
                continue;
            }
            $stamp = (string) $summary['newest'];
            if (strcmp($stamp, $newest) > 0) {
                $newest = $stamp;
            }
            $titles = $this->database->prepare(
                'SELECT COALESCE(mo.title, mi.title) AS title' . sprintf($scope, $library)
                . ' ORDER BY mi.created_at DESC, mi.id DESC LIMIT ' . self::SAMPLE
            );
            $titles->execute(['since' => $since]);
            $total += $items;
            $libraries[] = [
                'kind' => $kind,
                'count' => $items,
                'titles' => array_map(
                    static fn (array $row): string => (string) $row['title'],
                    $titles->fetchAll(PDO::FETCH_ASSOC)
                ),
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
     * the box is asking for. That holds for switching it back on as well — the
     * window used to stay where the last message had left it, months back.
     */
    public function subscribe(int $userId, string $frequency): void
    {
        if (!in_array($frequency, ['off', 'weekly'], true)) {
            throw new BridgeRequestException('Nieprawidłowa częstotliwość powiadomień.');
        }
        $statement = $this->database->prepare(
            'INSERT INTO user_digests (user_id, frequency, covered_until)
             VALUES (:user_id, :frequency, CURRENT_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE
               covered_until = IF(frequency = \'off\' AND VALUES(frequency) <> \'off\', CURRENT_TIMESTAMP(6), covered_until),
               frequency = VALUES(frequency)'
        );
        $statement->execute(['user_id' => $userId, 'frequency' => $frequency]);
    }

    /**
     * How many accounts asked for the digest, and when one last went out.
     *
     * @return array{subscribers:int,last_sent_at:string|null,spooled:bool}
     */
    public function status(): array
    {
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
}
