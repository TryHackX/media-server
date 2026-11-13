<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

/**
 * The step-up ladder: how much one subject may do before it has to prove it is
 * a person, and before it has to stop.
 *
 * A subject is an account (`u:<id>`), a client (`c:<sha256 of the address>`,
 * the digest auth_attempts uses) or a device cookie (`d:<sha256>`); a request is
 * counted under every subject it carries, and the busiest one decides. Per
 * context (downloads, compatibility streams, guest links, sign-ups, activation
 * resends, and every request to the bridge) there are three numbers:
 *
 *   - below `soft` inside the window nothing happens;
 *   - from `soft` on, a request without a valid human pass is answered with
 *     "captcha_required" and is not counted — the page solves a challenge,
 *     receives a short-lived pass and repeats the request (one place for that:
 *     the request layer of frontend/src/shared/api.ts);
 *   - from `hard` on, with or without a pass, the request is refused with a
 *     pause (429 and Retry-After: until the window has slid below `hard`), and
 *     every such refusal is a strike. `block_after` strikes within fifteen
 *     minutes turn the pause into a block of `block_minutes` for that subject,
 *     everywhere in the bridge, until it runs out or an operator lifts it.
 *
 * Counting is bucketed (ten seconds per row and subject), so a busy subject
 * costs one upsert per request rather than one row. It is not transactional:
 * two simultaneous requests may both see the count just below a threshold —
 * the thresholds are a pace, not a ledger, and the download quota that is a
 * ledger (CatalogTransferGateway::reserveDownload) stays where it was.
 *
 * Times are unix seconds from PHP's clock, which no time zone reinterprets
 * (the PHP and MySQL clocks of this installation run in different zones).
 * Pauses, blocks and their release are written to audit_log; a pause at most
 * once an hour per subject, so a script hammering the bridge cannot flood it.
 */
final class StepUpGuard
{
    /** [soft, hard, window seconds] per context; the operator may change each one. */
    public const DEFAULTS = [
        'request' => [240, 600, 60],
        'download' => [30, 100, 3600],
        'compat' => [120, 400, 3600],
        'guest_link' => [10, 30, 3600],
        'register' => [2, 5, 86400],
        'resend' => [2, 5, 86400],
    ];
    public const DEFAULT_PASS_MINUTES = 30;
    public const DEFAULT_BLOCK_AFTER = 5;
    public const DEFAULT_BLOCK_MINUTES = 60;
    public const MAX_THRESHOLD = 100000;
    public const MIN_WINDOW = 10;
    public const MAX_WINDOW = 604800;
    private const BUCKET_SECONDS = 10;
    private const STRIKE_WINDOW = 900;
    private const AUDIT_EVERY = 3600;
    private const KEEP_SECONDS = 691200;
    /** How long past its window a context's counters are kept before pruning. */
    private const PRUNE_MARGIN = 600;

    /** @var \Closure(): int */
    private readonly \Closure $clock;

    /**
     * @param array<string, string> $settings app_settings rows (see settingKeys())
     * @param (\Closure(): int)|null $clock unix seconds; injectable for tests
     */
    public function __construct(
        private readonly PDO $database,
        private readonly array $settings,
        ?\Closure $clock = null
    ) {
        $this->clock = $clock ?? static fn (): int => time();
    }

    /** @return list<string> */
    public static function settingKeys(): array
    {
        $keys = ['stepup_enabled', 'stepup_staff_exempt', 'stepup_pass_minutes', 'stepup_block_after', 'stepup_block_minutes'];
        foreach (array_keys(self::DEFAULTS) as $context) {
            array_push($keys, "stepup_{$context}_soft", "stepup_{$context}_hard", "stepup_{$context}_window");
        }
        return $keys;
    }

    /**
     * The account, client and device subjects of one request.
     *
     * The device is the digest of a device cookie the caller has **verified**
     * (AccountGateway::deviceDigest), never the cookie as it arrived: that is
     * a value the visitor chooses, so hashing it made every request with a new
     * value a new subject — a counter row each, kept for days, counting nobody.
     */
    public static function subjects(?int $userId, string $clientHash, ?string $deviceDigest = null): array
    {
        $subjects = [];
        if ($userId !== null && $userId > 0) {
            $subjects[] = 'u:' . $userId;
        }
        $subjects[] = 'c:' . $clientHash;
        if (is_string($deviceDigest) && preg_match('/\A[0-9a-f]{64}\z/D', $deviceDigest) === 1) {
            $subjects[] = 'd:' . $deviceDigest;
        }
        return $subjects;
    }

    public function enabled(): bool
    {
        return ($this->settings['stepup_enabled'] ?? '1') !== '0';
    }

    public function staffExempt(): bool
    {
        return ($this->settings['stepup_staff_exempt'] ?? '1') !== '0';
    }

    public function passSeconds(): int
    {
        return 60 * self::bounded($this->settings['stepup_pass_minutes'] ?? null, 1, 1440, self::DEFAULT_PASS_MINUTES);
    }

    public function blockAfter(): int
    {
        return self::bounded($this->settings['stepup_block_after'] ?? null, 1, 100, self::DEFAULT_BLOCK_AFTER);
    }

    public function blockMinutes(): int
    {
        return self::bounded($this->settings['stepup_block_minutes'] ?? null, 1, 10080, self::DEFAULT_BLOCK_MINUTES);
    }

    /** @return array{soft:int,hard:int,window:int} */
    public function thresholds(string $context): array
    {
        [$soft, $hard, $window] = self::DEFAULTS[$context] ?? self::DEFAULTS['request'];
        $soft = self::bounded($this->settings["stepup_{$context}_soft"] ?? null, 1, self::MAX_THRESHOLD, $soft);
        $hard = self::bounded($this->settings["stepup_{$context}_hard"] ?? null, 1, self::MAX_THRESHOLD, $hard);
        $window = self::bounded($this->settings["stepup_{$context}_window"] ?? null, self::MIN_WINDOW, self::MAX_WINDOW, $window);
        return ['soft' => $soft, 'hard' => max($soft, $hard), 'window' => $window];
    }

    /**
     * Decide one request and count it when it goes on.
     *
     * @param list<string> $subjects
     * @param bool $challengeable whether the caller can show a challenge (an image or a
     *   download link cannot): one that cannot is only ever paused, never asked
     * @return bool true when the request may go on (it has been counted), false when a
     *   person has to prove to be there first (it has not)
     * @throws BridgeRateLimitException over the hard threshold, or while blocked
     */
    public function admit(string $context, array $subjects, ?int $userId, bool $hasPass, bool $challengeable = true): bool
    {
        if (!$this->enabled() || $subjects === []) {
            return true;
        }
        $now = ($this->clock)();
        $this->assertNotBlocked($subjects, $now);
        $limits = $this->thresholds($context);
        $counts = $this->counts($context, $subjects, $now - $limits['window']);
        $hits = max($counts);

        if ($hits >= $limits['hard']) {
            $this->refuse($context, $counts, $userId, $limits, $now);
        }
        if ($hits >= $limits['soft'] && !$hasPass && $challengeable) {
            foreach ($counts as $subject => $count) {
                if ($count >= $limits['soft']) {
                    $this->remember((string) $subject, $userId, $context, 'challenged', 0, $count, $now);
                }
            }
            return false;
        }
        $this->record($context, $subjects, $now);
        return true;
    }

    /**
     * A refusal decided elsewhere (the sign-in limits of AccountGateway) counts
     * as a strike too, so whoever keeps hammering a closed door is blocked.
     *
     * @param list<string> $subjects
     */
    public function strike(string $context, array $subjects, ?int $userId): void
    {
        if (!$this->enabled() || $subjects === []) {
            return;
        }
        $now = ($this->clock)();
        $this->record('strike', $subjects, $now);
        $strikes = $this->counts('strike', $subjects, $now - self::STRIKE_WINDOW);
        foreach ($strikes as $subject => $count) {
            if ($count >= $this->blockAfter()) {
                $this->block((string) $subject, $userId, $context, $count, $now);
            }
        }
    }

    /**
     * @param list<string> $subjects
     * @throws BridgeRateLimitException while any of them is blocked
     */
    public function assertNotBlocked(array $subjects, ?int $now = null): void
    {
        if (!$this->enabled() || $subjects === []) {
            return;
        }
        $now ??= ($this->clock)();
        $placeholders = implode(',', array_fill(0, count($subjects), '?'));
        $statement = $this->database->prepare(
            "SELECT MAX(until_at) FROM stepup_subjects
             WHERE state = 'blocked' AND until_at > ? AND subject IN ({$placeholders})"
        );
        $statement->execute([$now, ...$subjects]);
        $until = $statement->fetchColumn();
        if ($until !== false && $until !== null) {
            throw new BridgeRateLimitException(
                'Zbyt wiele żądań — dostęp jest czasowo zablokowany. Spróbuj później.',
                max(1, (int) $until - $now),
                'blocked'
            );
        }
    }

    /**
     * Who is being asked, paused or blocked now, or was in the last day — for the panel.
     *
     * @return list<array<string, mixed>>
     */
    public function recentSubjects(int $limit = 50): array
    {
        $now = ($this->clock)();
        $statement = $this->database->prepare(
            'SELECT s.subject, s.user_id, u.username, s.context, s.state, s.until_at, s.hits, s.updated_at
             FROM stepup_subjects s LEFT JOIN users u ON u.id = s.user_id
             WHERE s.updated_at > :recent OR s.until_at > :now
             ORDER BY s.updated_at DESC
             LIMIT ' . max(1, min(200, $limit))
        );
        $statement->execute(['recent' => $now - 86400, 'now' => $now]);
        $rows = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $until = (int) $row['until_at'];
            $state = (string) $row['state'];
            $active = $state === 'challenged' || $until > $now;
            $rows[] = [
                'subject' => (string) $row['subject'],
                'kind' => substr((string) $row['subject'], 0, 1),
                'user_id' => $row['user_id'] === null ? null : (int) $row['user_id'],
                'username' => $row['username'] === null ? null : (string) $row['username'],
                'context' => (string) $row['context'],
                'state' => $active ? $state : 'expired',
                'seconds_left' => max(0, $until - $now),
                'hits' => (int) $row['hits'],
                'seconds_ago' => max(0, $now - (int) $row['updated_at']),
            ];
        }
        // Blocks first, then pauses, then the rest by recency.
        $rank = ['blocked' => 0, 'paused' => 1, 'challenged' => 2, 'expired' => 3];
        usort($rows, static fn (array $a, array $b): int => [$rank[$a['state']] ?? 4, $a['seconds_ago']] <=> [$rank[$b['state']] ?? 4, $b['seconds_ago']]);
        return $rows;
    }

    /**
     * Lift whatever stands against a subject and forget its counts.
     *
     * An account takes along the clients and devices last seen with it: "let
     * this person work again" is what the operator means, and the client digest
     * counted beside the account would otherwise stay paused or blocked.
     */
    public function release(string $subject, ?int $actorUserId): bool
    {
        if (preg_match('/\A(?:u:([1-9][0-9]{0,19})|[cd]:[0-9a-f]{64})\z/D', $subject, $parts) !== 1) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator.');
        }
        $released = [$subject];
        if (isset($parts[1]) && $parts[1] !== '') {
            $linked = $this->database->prepare('SELECT subject FROM stepup_subjects WHERE user_id = :user');
            $linked->execute(['user' => (int) $parts[1]]);
            $released = array_values(array_unique([...$released, ...array_map('strval', $linked->fetchAll(PDO::FETCH_COLUMN))]));
        }
        $placeholders = implode(',', array_fill(0, count($released), '?'));
        $statement = $this->database->prepare("DELETE FROM stepup_subjects WHERE subject IN ({$placeholders})");
        $statement->execute($released);
        $this->database->prepare("DELETE FROM stepup_counters WHERE subject IN ({$placeholders})")->execute($released);
        $this->audit($actorUserId, 'stepup.release', $subject, ['released_by' => $actorUserId, 'subjects' => count($released)]);
        return $statement->rowCount() > 0;
    }

    /**
     * Every subject at or over the hard threshold is paused and takes a strike;
     * one with enough strikes is blocked. All of them, not only the busiest: an
     * account and its client are usually counted alike, and releasing one while
     * the other stays over the line would only move the block along.
     *
     * @param array<string, int> $counts hits per subject inside the window
     * @param array{soft:int,hard:int,window:int} $limits
     */
    private function refuse(string $context, array $counts, ?int $userId, array $limits, int $now): never
    {
        $over = array_map('strval', array_keys(array_filter($counts, static fn (int $count): bool => $count >= $limits['hard'])));
        $this->record('strike', $over, $now);
        $strikes = $this->counts('strike', $over, $now - self::STRIKE_WINDOW);
        $blockedUntil = 0;
        foreach ($over as $subject) {
            if ($strikes[$subject] >= $this->blockAfter()) {
                $blockedUntil = max($blockedUntil, $this->block($subject, $userId, $context, $counts[$subject], $now));
            }
        }
        if ($blockedUntil > 0) {
            throw new BridgeRateLimitException(
                'Zbyt wiele żądań — dostęp jest czasowo zablokowany. Spróbuj później.',
                max(1, $blockedUntil - $now),
                'blocked'
            );
        }
        $retry = 1;
        foreach ($over as $subject) {
            $retry = max($retry, $this->secondsUntilBelow($context, $subject, $limits['hard'], $limits['window'], $now));
        }
        foreach ($over as $subject) {
            $previous = $this->stateOf($subject);
            $this->remember($subject, $userId, $context, 'paused', $now + $retry, $counts[$subject], $now);
            if ($previous === null || $now - (int) $previous['audited_at'] >= self::AUDIT_EVERY) {
                $this->audit($userId, 'stepup.pause', $subject, [
                    'context' => $context, 'count' => $counts[$subject], 'hard' => $limits['hard'],
                    'window_seconds' => $limits['window'], 'retry_after' => $retry,
                ]);
                $this->database->prepare('UPDATE stepup_subjects SET audited_at = :now WHERE subject = :subject')
                    ->execute(['now' => $now, 'subject' => $subject]);
            }
        }
        throw new BridgeRateLimitException('Zbyt wiele żądań. Odczekaj chwilę i spróbuj ponownie.', $retry, 'paused');
    }

    private function block(string $subject, ?int $userId, string $context, int $hits, int $now): int
    {
        $until = $now + 60 * $this->blockMinutes();
        $this->remember($subject, $userId, $context, 'blocked', $until, $hits, $now);
        $this->audit($userId, 'stepup.block', $subject, [
            'context' => $context, 'count' => $hits, 'minutes' => $this->blockMinutes(),
        ]);
        return $until;
    }

    /** Seconds until the window has slid far enough for the count to fall below `hard`. */
    private function secondsUntilBelow(string $context, string $subject, int $hard, int $window, int $now): int
    {
        $statement = $this->database->prepare(
            'SELECT bucket, hits FROM stepup_counters
             WHERE context = :context AND subject = :subject AND bucket >= :since ORDER BY bucket'
        );
        $statement->execute(['context' => $context, 'subject' => $subject, 'since' => $now - $window]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $total = array_sum(array_map(static fn (array $row): int => (int) $row['hits'], $rows));
        foreach ($rows as $row) {
            $total -= (int) $row['hits'];
            if ($total < $hard) {
                return max(1, (int) $row['bucket'] + $window + 1 - $now);
            }
        }
        return max(1, min($window, self::BUCKET_SECONDS));
    }

    /**
     * @param list<string> $subjects
     * @return array<string, int> hits per subject inside the window
     */
    private function counts(string $context, array $subjects, int $since): array
    {
        $placeholders = implode(',', array_fill(0, count($subjects), '?'));
        $statement = $this->database->prepare(
            "SELECT subject, SUM(hits) AS hits FROM stepup_counters
             WHERE context = ? AND bucket >= ? AND subject IN ({$placeholders})
             GROUP BY subject"
        );
        $statement->execute([$context, $since, ...$subjects]);
        $counts = array_fill_keys($subjects, 0);
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $counts[(string) $row['subject']] = (int) $row['hits'];
        }
        return $counts;
    }

    /** @param list<string> $subjects */
    private function record(string $context, array $subjects, int $now): void
    {
        $bucket = intdiv($now, self::BUCKET_SECONDS) * self::BUCKET_SECONDS;
        $statement = $this->database->prepare(
            'INSERT INTO stepup_counters (context, subject, bucket, hits) VALUES (:context, :subject, :bucket, 1) '
            . ($this->isSqlite()
                ? 'ON CONFLICT(context, subject, bucket) DO UPDATE SET hits = hits + 1'
                : 'ON DUPLICATE KEY UPDATE hits = hits + 1')
        );
        foreach ($subjects as $subject) {
            $statement->execute(['context' => $context, 'subject' => $subject, 'bucket' => $bucket]);
        }
        if (random_int(1, 200) === 1) {
            $this->prune($now);
        }
    }

    /**
     * Forget counts nothing reads any more.
     *
     * A bucket matters for as long as its context's window: a minute for
     * requests, an hour for downloads, a quarter of an hour for strikes.
     * Everything used to be kept eight days — the longest window an operator
     * may set — whatever it counted. Each context goes at its own window plus
     * a margin; a context nobody knows (a row from an older version) at the
     * old limit.
     */
    public function prune(?int $now = null): void
    {
        $now ??= ($this->clock)();
        $windows = ['strike' => self::STRIKE_WINDOW];
        foreach (array_keys(self::DEFAULTS) as $context) {
            $windows[$context] = $this->thresholds($context)['window'];
        }
        $delete = $this->database->prepare('DELETE FROM stepup_counters WHERE context = :context AND bucket < :before');
        foreach ($windows as $context => $window) {
            $delete->execute(['context' => $context, 'before' => $now - $window - self::PRUNE_MARGIN]);
        }
        $this->database->prepare('DELETE FROM stepup_counters WHERE bucket < :before')
            ->execute(['before' => $now - self::KEEP_SECONDS]);
        $this->database->prepare('DELETE FROM stepup_subjects WHERE updated_at < :before AND until_at < :now')
            ->execute(['before' => $now - self::KEEP_SECONDS, 'now' => $now]);
    }

    private function remember(string $subject, ?int $userId, string $context, string $state, int $until, int $hits, int $now): void
    {
        $this->database->prepare(
            'INSERT INTO stepup_subjects (subject, user_id, context, state, until_at, hits, audited_at, updated_at)
             VALUES (:subject, :user_id, :context, :state, :until_at, :hits, 0, :now) '
            . ($this->isSqlite()
                ? 'ON CONFLICT(subject) DO UPDATE SET user_id = COALESCE(excluded.user_id, user_id),
                   context = excluded.context, state = excluded.state, until_at = excluded.until_at,
                   hits = excluded.hits, updated_at = excluded.updated_at'
                : 'ON DUPLICATE KEY UPDATE user_id = COALESCE(VALUES(user_id), user_id),
                   context = VALUES(context), state = VALUES(state), until_at = VALUES(until_at),
                   hits = VALUES(hits), updated_at = VALUES(updated_at)')
        )->execute([
            'subject' => $subject,
            'user_id' => $userId,
            'context' => $context,
            'state' => $state,
            'until_at' => $until,
            'hits' => $hits,
            'now' => $now,
        ]);
    }

    /** @return array<string, mixed>|null */
    private function stateOf(string $subject): ?array
    {
        $statement = $this->database->prepare('SELECT state, until_at, audited_at FROM stepup_subjects WHERE subject = :subject');
        $statement->execute(['subject' => $subject]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /** @param array<string, mixed> $details */
    private function audit(?int $actor, string $action, string $subject, array $details): void
    {
        $this->database->prepare(
            'INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details_json)
             VALUES (:actor, :action, :target_type, :target_id, :details)'
        )->execute([
            'actor' => $actor,
            'action' => $action,
            'target_type' => 'stepup',
            'target_id' => $subject,
            'details' => json_encode($details, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
        ]);
    }

    private function isSqlite(): bool
    {
        return $this->database->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
    }

    private static function bounded(mixed $value, int $minimum, int $maximum, int $fallback): int
    {
        if (!is_numeric($value)) {
            return $fallback;
        }
        return max($minimum, min($maximum, (int) $value));
    }
}
