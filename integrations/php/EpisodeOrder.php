<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

/**
 * Reading episode order out of file names.
 *
 * Nothing in the catalogue says "this folder is a series" — `ffprobe` does not
 * know and nobody types it in. What a real library does have is a naming habit,
 * and three spellings cover almost everything on disk:
 *
 *   Dr.House.S01E02 1080p.AVC.DTS.Lektor PL.mkv     S01E02, also "[S03E03]", "S1.E2"
 *   Firefly - 1x02 - The Train Job.mkv              1x02
 *   03 - Jurodiwyj.mkv                              a bare number, folder is the season
 *
 * The first two are unambiguous: no film title carries "S01E02" by accident. The
 * bare number is the dangerous one, because a year, a resolution, a bit depth
 * and a bitrate all look exactly like it — so it is read only after those have
 * been struck out, and {@see scheme()} accepts it only when most of the folder
 * agrees on it. A folder that does not convince us is simply not a series, and
 * the caller falls back to "something else from here".
 */
final class EpisodeOrder
{
    /** Explicit marker (S01E02, 1x02): two files are enough to call it a series. */
    private const EXPLICIT_MINIMUM = 2;

    /** Bare numbering: needs more files and a clear majority before we believe it. */
    private const BARE_MINIMUM = 3;
    private const BARE_MAJORITY = 0.6;

    /**
     * The season and episode a file name claims.
     *
     * @return array{season:int,episode:int,scheme:string}|null
     */
    public static function parse(string $fileName): ?array
    {
        $name = self::withoutExtension(self::baseName($fileName));
        // "S01E02", "s1.e2", "[S03E03]" — a season and an episode in one token.
        if (preg_match('/(?<![A-Za-z0-9])s\s*(\d{1,2})\s*[._\- ]?\s*e\s*(\d{1,3})(?![0-9])/i', $name, $match) === 1) {
            return ['season' => (int) $match[1], 'episode' => (int) $match[2], 'scheme' => 'explicit'];
        }
        // "1x02". The lookarounds keep "1920x1080" and "x264" out of it.
        if (preg_match('/(?<![A-Za-z0-9])(\d{1,2})\s*x\s*(\d{1,3})(?![0-9])/i', $name, $match) === 1) {
            return ['season' => (int) $match[1], 'episode' => (int) $match[2], 'scheme' => 'explicit'];
        }
        // "E02" / "Ep02" / "Episode 2" with the season living in the folder name.
        if (preg_match('/(?<![A-Za-z0-9])e(?:p|pisode)?\s*[._\- ]?(\d{1,3})(?![0-9])/i', $name, $match) === 1) {
            return ['season' => 0, 'episode' => (int) $match[1], 'scheme' => 'explicit'];
        }
        $bare = self::bareNumber($name);
        return $bare === null ? null : ['season' => 0, 'episode' => $bare, 'scheme' => 'bare'];
    }

    /**
     * Which numbering, if any, the folder as a whole follows.
     *
     * @param array<int, string> $fileNames every file in the folder
     * @return string|null 'explicit', 'bare', or null when this is not a series
     */
    public static function scheme(array $fileNames): ?string
    {
        $explicit = [];
        $bare = [];
        foreach ($fileNames as $fileName) {
            $parsed = self::parse($fileName);
            if ($parsed === null) {
                continue;
            }
            $key = $parsed['season'] . ':' . $parsed['episode'];
            if ($parsed['scheme'] === 'explicit') {
                $explicit[$key] = true;
            } else {
                $bare[$key] = true;
            }
        }
        if (count($explicit) >= self::EXPLICIT_MINIMUM) {
            return 'explicit';
        }
        // A bare number is only believable when it is the folder's habit rather
        // than a coincidence in one or two names.
        $total = count($fileNames);
        if (count($bare) >= self::BARE_MINIMUM && $total > 0 && count($bare) >= $total * self::BARE_MAJORITY) {
            return 'bare';
        }
        return null;
    }

    /**
     * Sort key for a parsed position; larger means later.
     *
     * @param array{season:int,episode:int,scheme:string} $parsed
     */
    public static function rank(array $parsed): int
    {
        return $parsed['season'] * 1000 + $parsed['episode'];
    }

    private static function baseName(string $path): string
    {
        $normalised = str_replace('\\', '/', $path);
        $position = strrpos($normalised, '/');
        return $position === false ? $normalised : substr($normalised, $position + 1);
    }

    private static function withoutExtension(string $fileName): string
    {
        return (string) preg_replace('/\.[A-Za-z0-9]{1,5}$/D', '', $fileName);
    }

    /**
     * The last plain number left once everything that only looks like one is gone.
     *
     * Bracketed groups hold the technical description in this library
     * ("[1080p 8 bits] [AVC 10.6 Mbs]"), and the release year sits in parentheses,
     * so both go first; what survives is the part a person reads.
     */
    private static function bareNumber(string $name): ?int
    {
        $patterns = [
            '/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/u',                 // bracketed technical tags and years
            '/(?<![A-Za-z0-9])(?:19|20)\d{2}(?![0-9])/',          // a bare release year
            '/(?<![A-Za-z0-9])\d{3,4}[pi](?![A-Za-z0-9])/i',      // 1080p, 2160p, 576i
            '/(?<![A-Za-z0-9])[xh]\s?26[45](?![0-9])/i',          // x264, h265
            '/(?<![A-Za-z0-9])\d{1,2}\s?bits?(?![A-Za-z])/i',     // 8 bit, 10bits
            '/(?<![A-Za-z0-9])[2457]\.[01](?![0-9])/',            // 5.1, 7.1, 2.0 channel layouts
            '/(?<![A-Za-z0-9])\d{2,5}\s?k(?:b|bps|bit)?s?(?![A-Za-z])/i', // 640 kbs, 7705 kbs
        ];
        $stripped = $name;
        foreach ($patterns as $pattern) {
            $stripped = (string) preg_replace($pattern, ' ', $stripped);
        }
        if (preg_match_all('/(?<![A-Za-z0-9])(\d{1,3})(?![0-9])/', $stripped, $matches) < 1) {
            return null;
        }
        // The episode number is normally the first number a reader meets
        // ("03 - Jurodiwyj"); anything after it tends to be part of the title.
        return (int) $matches[1][0];
    }
}
