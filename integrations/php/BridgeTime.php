<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

/**
 * Database timestamps, said so that a browser cannot misread them.
 *
 * The bridge has always handed out timestamps the way MySQL prints them:
 * `2026-11-11 19:59:38.139391`, in the database session's own time zone, with
 * no word about which zone that is. A page that parses such a string takes it
 * for the *viewer's* local time — right only while the viewer sits in the
 * server's zone, and wrong by the difference everywhere else ("expires in two
 * hours" for a link that has just expired).
 *
 * Every such field keeps its old value, and gains a sibling: `<name>_iso`, the
 * same instant as ISO 8601 with an offset (`2026-11-11T18:59:38+00:00`, always
 * UTC), or null where the field is null. New answers (the start page) carry
 * ISO 8601 only.
 *
 * The conversion is asked of the database, whose zone the string is in — PHP's
 * clock runs in a different one on the first installation. A string is turned
 * back into an instant with `UNIX_TIMESTAMP()`, which is exact except for
 * timestamps written during the one hour a year that the clocks go back and a
 * local time occurs twice: those may come out an hour early. Queries that want
 * that hour right select `UNIX_TIMESTAMP(column)` themselves and use
 * {@see iso()}.
 */
final class BridgeTime
{
    /** `YYYY-MM-DD HH:MM:SS`, with or without microseconds: how MySQL prints a TIMESTAMP. */
    private const DATABASE_SHAPE = '/\A\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\z/D';

    /** Fields that hold a timestamp without saying so in their name. */
    private const NAMED = ['covered_until' => true];

    /** A unix time (seconds, as the database returns it) as ISO 8601 in UTC; null stays null. */
    public static function iso(int|float|string|null $unixSeconds): ?string
    {
        if ($unixSeconds === null || $unixSeconds === '' || !is_numeric($unixSeconds)) {
            return null;
        }
        return gmdate('Y-m-d\TH:i:s', (int) floor((float) $unixSeconds)) . '+00:00';
    }

    /** The current moment, the same way. */
    public static function now(): string
    {
        return gmdate('Y-m-d\TH:i:s') . '+00:00';
    }

    /**
     * Add `<name>_iso` beside every timestamp field of an answer.
     *
     * One pass to collect the distinct values, one statement to convert them,
     * one pass to write them in. An answer without timestamps costs the walk
     * and no query.
     *
     * @param array<mixed> $payload
     * @return array<mixed>
     */
    public static function withIso(PDO $database, array $payload): array
    {
        $found = [];
        self::collect($payload, $found);
        if ($found === []) {
            return $payload;
        }
        $values = array_keys($found);
        $converted = [];
        foreach (array_chunk($values, 200) as $chunk) {
            $statement = $database->prepare(
                'SELECT ' . implode(', ', array_fill(0, count($chunk), 'UNIX_TIMESTAMP(?)'))
            );
            $statement->execute($chunk);
            $row = $statement->fetch(PDO::FETCH_NUM) ?: [];
            foreach ($chunk as $index => $value) {
                $converted[$value] = self::iso($row[$index] ?? null);
            }
        }
        return self::annotate($payload, $converted);
    }

    private static function isTimestampKey(int|string $key): bool
    {
        return is_string($key) && (str_ends_with($key, '_at') || isset(self::NAMED[$key]));
    }

    /**
     * @param array<mixed> $node
     * @param array<string, true> $found
     */
    private static function collect(array $node, array &$found): void
    {
        foreach ($node as $key => $value) {
            if (is_array($value)) {
                self::collect($value, $found);
            } elseif (is_string($value) && self::isTimestampKey($key) && preg_match(self::DATABASE_SHAPE, $value) === 1) {
                $found[$value] = true;
            }
        }
    }

    /**
     * @param array<mixed> $node
     * @param array<string, string|null> $converted
     * @return array<mixed>
     */
    private static function annotate(array $node, array $converted): array
    {
        $added = [];
        foreach ($node as $key => $value) {
            if (is_array($value)) {
                $node[$key] = self::annotate($value, $converted);
            } elseif (self::isTimestampKey($key) && !array_key_exists($key . '_iso', $node)) {
                if ($value === null) {
                    $added[$key . '_iso'] = null;
                } elseif (is_string($value) && array_key_exists($value, $converted)) {
                    $added[$key . '_iso'] = $converted[$value];
                }
            }
        }
        return $added === [] ? $node : $node + $added;
    }
}
