<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;
use PDOStatement;

require_once __DIR__ . '/BridgeTime.php';
require_once __DIR__ . '/EpisodeOrder.php';

final class LibraryBrowser
{
    /** Token slots reserved in every search statement; extras fold into the phrase. */
    private const SEARCH_TOKEN_SLOTS = 4;

    /**
     * What every listing selects of a file — a folder's, a queue's, a shelf's
     * and a playlist's alike — and what {@see publicItem()} turns into the item
     * the interface draws. Kept in one place: the playlist side used to carry
     * a copy of both, and the copy had fallen behind (a film opened from a
     * playlist had no track list, bitrate or colour data in its details).
     *
     * Expects the aliases mi, mo, ur, ps, mpt and ra.
     */
    public const ITEM_COLUMNS = "mi.id, mi.relative_path, mi.media_kind, mi.mime_type, mi.file_extension,
                       COALESCE(mo.title, mi.title) AS title,
                       COALESCE(mo.artist, mi.artist) AS artist,
                       COALESCE(mo.album, mi.album) AS album,
                       COALESCE(
                           mo.year,
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.year')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.year'))
                       ) AS year,
                       COALESCE(
                           mo.genre,
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.genre')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.genre'))
                       ) AS genre,
                       mi.duration_ms, mi.size_bytes,
                       COALESCE(
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.bitrate')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.bitrate'))
                       ) AS bitrate,
                       COALESCE(
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.sample_rate')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.sample_rate'))
                       ) AS sample_rate,
                       COALESCE(
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.channels')),
                           JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.channels'))
                       ) AS channels,
                       mi.video_width, mi.video_height, mi.video_codec, mi.audio_codec, mi.is_hdr,
                       mi.metadata_json,
                       COALESCE(ur.favorite, 0) AS favorite, ur.rating,
                       COALESCE(ps.play_count, 0) AS play_count,
                       COALESCE(mpt.play_count, 0) AS total_play_count,
                       COALESCE(ra.avg_rating, 0) AS avg_rating,
                       COALESCE(ra.rating_count, 0) AS rating_count,
                       COALESCE(ra.favorite_count, 0) AS favorite_count";
    /** Accepted listing orders; must match CatalogActions::LIBRARY_SORTS. */
    public const SORTS = [
        'title_asc', 'title_desc', 'plays_desc', 'rating_desc', 'rating_count_desc',
        'size_desc', 'duration_desc', 'duration_asc', 'random',
    ];

    /**
     * Picture filters, from what ffprobe wrote into the catalogue.
     *
     * A folder has no resolution, so a filtered listing is a list of files: the
     * folders step aside and the files are gathered from the whole subtree, the
     * same way a search behaves. Without that, filtering from the library root
     * would find nothing at all.
     *
     * @var array<int, int> label -> minimum height in pixels
     */
    public const RESOLUTION_FLOORS = ['uhd' => 1800, 'fhd' => 1000, 'hd' => 700];

    /**
     * Containers that keep every sample. Read from the extension rather than from
     * a codec column, because the audio side of the catalogue is filled by Mutagen
     * (tags), not by ffprobe — there is no codec name to compare against.
     */
    public const LOSSLESS_EXTENSIONS = ['flac', 'wav', 'aif', 'aiff', 'alac', 'ape', 'wv'];

    /** Where "high bitrate" starts for a lossy file, in bits per second. */
    private const HIGH_BITRATE = 320000;

    /** Sample rate above CD and studio-standard 48 kHz, i.e. an actual hi-res master. */
    private const HIRES_SAMPLE_RATE = 88200;

    public function __construct(private readonly PDO $database)
    {
    }

    /** @return array<string, mixed> */
    public function browse(
        LegacyIdentity $identity,
        string $kind,
        ?int $directoryId,
        string $query = '',
        int $page = 1,
        int $limit = 48,
        string $sort = 'title_asc',
        string $randomSeed = '',
        array $filters = []
    ): array {
        self::assertKind($kind);
        if ($page < 1 || $page > 10000 || $limit < 1 || $limit > 100) {
            throw new BridgeRequestException('Nieprawidłowa paginacja.');
        }
        $query = self::cleanQuery($query);
        $filters = self::normalizeFilters($filters);
        if (!in_array($sort, self::SORTS, true)) {
            throw new BridgeRequestException('Invalid library sort.');
        }
        // "random" shuffles the folder order with a client-chosen seed, so paging
        // through the same listing stays consistent; files keep their title order
        // (an album is still an album). Any seed works but must be well formed.
        if ($sort === 'random' && preg_match('/^[A-Za-z0-9_-]{8,64}$/D', $randomSeed) !== 1) {
            throw new BridgeRequestException('Invalid library seed.');
        }
        $directory = $this->directory($kind, $directoryId);
        $offset = ($page - 1) * $limit;

        // A filter asks about pictures, which folders do not have: filtering turns
        // the listing into a flat list of matching files from the whole subtree.
        $filtered = $filters !== [];
        $directoryCount = $filtered ? 0 : $this->directoryCount($directory, $query);
        $directories = !$filtered && $offset < $directoryCount
            ? $this->directoriesPage($directory, $query, $offset, $limit + 1, $sort, $randomSeed)
            : [];
        $remaining = max(0, $limit + 1 - count($directories));
        $itemOffset = max(0, $offset - $directoryCount);
        $items = $remaining > 0
            ? $this->items($identity, $directory, $query, $itemOffset, $remaining, $sort === 'random' ? 'title_asc' : $sort, $filters)
            : [];
        $hasMore = count($directories) + count($items) > $limit;
        if ($hasMore) {
            if (count($directories) > $limit) {
                $directories = array_slice($directories, 0, $limit);
                $items = [];
            } else {
                $items = array_slice($items, 0, $limit - count($directories));
            }
        }
        if ($directoryId === null && $page === 1 && $query === '' && !$filtered) {
            $directories = array_merge($this->otherSources($kind, $directory), $directories);
        }
        $ratedDirectories = $this->withDirectoryRatings(array_merge([$directory], $directories));
        $previewDirectories = $this->withDirectoryPreviews($ratedDirectories);
        $directory = array_shift($previewDirectories) ?? $directory;
        $directories = $previewDirectories;

        return [
            'directory' => self::publicDirectory($directory),
            'breadcrumbs' => $this->breadcrumbs($directory),
            'directories' => array_map([self::class, 'publicDirectory'], $directories),
            'items' => self::withSavedPositions($this->database, $identity, array_map([self::class, 'publicItem'], $items)),
            'page' => $page,
            'has_more' => $hasMore,
            'query' => $query,
            'filters' => $filters,
            'filtered_total' => $filtered ? $this->itemCount($directory, $query, $filters) : null,
        ];
    }

    /**
     * Which picture filters are worth offering for this library.
     *
     * Read from what is actually catalogued, so the selects never list a codec
     * nobody owns — and stay empty until the ffprobe pass has run.
     *
     * @return array<string, mixed>
     */
    public function filterOptions(string $kind): array
    {
        self::assertKind($kind);
        // The same for every account, a pass over the whole library to work
        // out (three for music, each digging tags out of JSON), and asked for
        // on every visit to a library page: remembered until the next scan, or
        // five minutes, so tags the reader fills in after a scan show up soon.
        return $this->remembered(
            "filters:v1:{$kind}",
            300,
            fn (): array => $kind === 'music' ? $this->audioFilterOptions($kind) : $this->videoFilterOptions($kind)
        );
    }

    /**
     * An answer that takes a pass over a library to compute and changes only
     * when the catalogue does, kept in `bridge_cache` (migration 053).
     *
     * It is good while the newest completed scan is the one it was computed
     * after and it is younger than `$seconds`. Never for anything that depends
     * on who is asking: the table is one shelf for everybody.
     *
     * @param callable(): array<string, mixed> $build
     * @return array<string, mixed>
     */
    public function remembered(string $key, int $seconds, callable $build): array
    {
        $marker = (string) $this->database
            ->query("SELECT COALESCE(MAX(id), 0) FROM catalog_scans WHERE status = 'completed'")
            ->fetchColumn();
        $read = $this->database->prepare(
            'SELECT payload_json FROM bridge_cache
              WHERE cache_key = :cache_key AND marker = :marker
                AND stored_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :seconds SECOND)'
        );
        $read->bindValue(':cache_key', $key, PDO::PARAM_STR);
        $read->bindValue(':marker', $marker, PDO::PARAM_STR);
        $read->bindValue(':seconds', $seconds, PDO::PARAM_INT);
        $read->execute();
        $stored = $read->fetchColumn();
        if (is_string($stored)) {
            $decoded = json_decode($stored, true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }
        $value = $build();
        $this->database->prepare(
            'INSERT INTO bridge_cache (cache_key, marker, payload_json)
             VALUES (:cache_key, :marker, :payload)
             ON DUPLICATE KEY UPDATE marker = VALUES(marker), payload_json = VALUES(payload_json),
                                     stored_at = CURRENT_TIMESTAMP(6)'
        )->execute([
            'cache_key' => $key,
            'marker' => $marker,
            'payload' => json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        return $value;
    }

    /**
     * The film library's filters, counted by the database.
     *
     * (Every probed film used to be fetched into PHP to be counted there:
     * 6620 rows to produce four numbers and two short lists.)
     *
     * @return array<string, mixed>
     */
    private function videoFilterOptions(string $kind): array
    {
        $scope = "FROM media_items mi
                  INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                 WHERE mi.media_kind = 'video'
                   AND mi.deleted_at IS NULL
                   AND mi.catalog_status = 'ready'
                   AND mi.video_height IS NOT NULL
                   AND mr.media_kind IN (:root_kind, 'mixed')";
        // Each film falls into the highest band its height reaches.
        $bands = [];
        $ceiling = null;
        foreach (self::RESOLUTION_FLOORS as $label => $floor) {
            $bands[] = 'SUM(mi.video_height >= ' . $floor
                . ($ceiling === null ? '' : ' AND mi.video_height < ' . $ceiling) . ") AS band_{$label}";
            $ceiling = $floor;
        }
        $totals = $this->database->prepare(
            'SELECT COUNT(*) AS probed, SUM(mi.is_hdr = 1) AS hdr, ' . implode(', ', $bands) . ' ' . $scope
        );
        $totals->bindValue(':root_kind', $kind, PDO::PARAM_STR);
        $totals->execute();
        $row = $totals->fetch(PDO::FETCH_ASSOC) ?: [];
        $resolutions = [];
        foreach (array_keys(self::RESOLUTION_FLOORS) as $label) {
            if ((int) ($row["band_{$label}"] ?? 0) > 0) {
                $resolutions[$label] = (int) $row["band_{$label}"];
            }
        }
        $codecs = function (string $column) use ($scope, $kind): array {
            $statement = $this->database->prepare(
                "SELECT mi.{$column} AS codec, COUNT(*) AS films {$scope}
                    AND mi.{$column} IS NOT NULL AND mi.{$column} <> ''
                  GROUP BY mi.{$column}
                  ORDER BY films DESC, codec ASC"
            );
            $statement->bindValue(':root_kind', $kind, PDO::PARAM_STR);
            $statement->execute();
            return array_map(
                static fn (array $codec): array => ['value' => (string) $codec['codec'], 'count' => (int) $codec['films']],
                $statement->fetchAll(PDO::FETCH_ASSOC)
            );
        };
        return [
            'probed' => (int) ($row['probed'] ?? 0),
            'video_codecs' => $codecs('video_codec'),
            'audio_codecs' => $codecs('audio_codec'),
            'resolutions' => $resolutions,
            'hdr' => (int) ($row['hdr'] ?? 0),
            'genres' => $this->genreOptions($kind),
            'decades' => $this->decadeOptions($kind),
            'unidentified' => $this->unidentifiedCount($kind, 'video'),
            // Absent for films; kept so both libraries answer with one shape.
            'formats' => [],
            'tag_genres' => [],
            'quality' => ['lossless' => 0, 'high' => 0, 'standard' => 0],
        ];
    }

    /**
     * Genres present in this library, with how many films carry each.
     *
     * Counted from the catalogue like every other filter, so a genre nobody owns
     * never reaches the select — and while no lookup has run there is nothing to
     * count, so the control does not appear at all rather than appearing empty.
     *
     * Both spellings travel together: the interface switches between Polish and
     * English without asking the server again, and one row already holds both.
     *
     * @return list<array{id:int,slug:string,name_pl:string,name_en:string,count:int}>
     */
    private function genreOptions(string $kind): array
    {
        // Counted per genre id and named afterwards. (film, genre) is the
        // table's key, so a film is in a genre once and needs no DISTINCT —
        // which, with a GROUP BY over four dictionary columns, made this the
        // slowest part of the film filters (145 ms of 224).
        $statement = $this->database->prepare(
            "SELECT mg.id, mg.slug, mg.name_pl, mg.name_en, counted.films
             FROM (
               SELECT mig.genre_id, COUNT(*) AS films
               FROM media_item_genres mig
               INNER JOIN media_items mi ON mi.id = mig.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               WHERE mi.media_kind = 'video'
                 AND mi.deleted_at IS NULL
                 AND mi.catalog_status = 'ready'
                 AND mr.media_kind IN (:root_kind, 'mixed')
               GROUP BY mig.genre_id
             ) counted
             INNER JOIN media_genres mg ON mg.id = counted.genre_id
             ORDER BY counted.films DESC, mg.name_pl ASC"
        );
        $statement->bindValue(':root_kind', $kind, PDO::PARAM_STR);
        $statement->execute();
        return array_map(
            static fn (array $row): array => [
                'id' => (int) $row['id'],
                'slug' => (string) $row['slug'],
                'name_pl' => (string) $row['name_pl'],
                'name_en' => (string) $row['name_en'],
                'count' => (int) $row['films'],
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * How many files carry no genre at all.
     *
     * Offered as an option of its own, because "what has the lookup not managed
     * to identify?" is a question with a useful answer and no other way to ask
     * it: without this the unidentified files are simply missing from every
     * genre the select offers, and nothing says how many there are.
     */
    private function unidentifiedCount(string $kind, string $mediaKind): int
    {
        $missing = $mediaKind === 'video'
            ? 'NOT EXISTS (SELECT 1 FROM media_item_genres mig WHERE mig.media_item_id = mi.id)'
            : '(' . self::audioText('genre') . " IS NULL OR " . self::audioText('genre') . " = '')";
        $statement = $this->database->prepare(
            "SELECT COUNT(*)
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             WHERE mi.media_kind = :media_kind
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND mr.media_kind IN (:root_kind, 'mixed')
               AND {$missing}"
        );
        $statement->bindValue(':media_kind', $mediaKind, PDO::PARAM_STR);
        $statement->bindValue(':root_kind', $kind, PDO::PARAM_STR);
        $statement->execute();
        return (int) $statement->fetchColumn();
    }

    /**
     * Genres the music library carries, read from the tags themselves.
     *
     * Free text, not a dictionary: a track's genre is whatever the person who
     * tagged the file typed, so the values are counted from the catalogue the
     * same way file formats are, and the long tail of one-off spellings is cut
     * off rather than filling a select nobody can read.
     *
     * @return list<array{value:string,count:int}>
     */
    private function tagGenreOptions(string $kind): array
    {
        $tag = self::audioText('genre');
        $statement = $this->database->prepare(
            "SELECT {$tag} AS genre, COUNT(*) AS tracks
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             WHERE mi.media_kind = 'audio'
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND mr.media_kind IN (:root_kind, 'mixed')
               AND {$tag} IS NOT NULL AND {$tag} <> ''
             GROUP BY genre
             HAVING tracks >= 3
             ORDER BY tracks DESC, genre ASC
             LIMIT 60"
        );
        $statement->bindValue(':root_kind', $kind, PDO::PARAM_STR);
        $statement->execute();
        return array_map(
            static fn (array $row): array => ['value' => (string) $row['genre'], 'count' => (int) $row['tracks']],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Decades the library covers, with a count each.
     *
     * A decade rather than a year: 85 distinct years is a select nobody reads,
     * and "the nineties" is how people actually ask.
     *
     * @return list<array{decade:int,count:int}>
     */
    private function decadeOptions(string $kind, string $mediaKind = 'video'): array
    {
        $statement = $this->database->prepare(
            "SELECT FLOOR(mi.release_year / 10) * 10 AS decade, COUNT(*) AS films
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             WHERE mi.media_kind = :media_kind
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND mi.release_year IS NOT NULL
               AND mr.media_kind IN (:root_kind, 'mixed')
             GROUP BY decade
             ORDER BY decade DESC"
        );
        $statement->bindValue(':media_kind', $mediaKind, PDO::PARAM_STR);
        $statement->bindValue(':root_kind', $kind, PDO::PARAM_STR);
        $statement->execute();
        return array_map(
            static fn (array $row): array => ['decade' => (int) $row['decade'], 'count' => (int) $row['films']],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * What is worth offering in the music library, counted from the catalogue.
     *
     * The same rule as the film filters: a control appears only when the library
     * actually holds something it could narrow down. Genre is deliberately absent —
     * one track in twelve thousand carries a genre tag, so the select would be a
     * dead end. What people really sort by here is the format and whether the file
     * kept every sample.
     *
     * @return array<string, mixed>
     */
    private function audioFilterOptions(string $kind): array
    {
        $lossless = self::losslessCondition();
        $bitrate = self::audioTag('bitrate');
        $rate = self::audioTag('sample_rate');
        $statement = $this->database->prepare(
            "SELECT LOWER(mi.file_extension) AS format, COUNT(*) AS files,
                    SUM({$lossless}) AS lossless,
                    SUM(NOT {$lossless} AND {$bitrate} >= " . self::HIGH_BITRATE . ") AS high,
                    SUM({$rate} >= " . self::HIRES_SAMPLE_RATE . ") AS hires
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             WHERE mi.media_kind = 'audio'
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND mi.file_extension IS NOT NULL
               AND mr.media_kind IN ('music', 'mixed')
             GROUP BY LOWER(mi.file_extension)
             ORDER BY files DESC"
        );
        $statement->execute();
        $formats = [];
        $total = 0;
        $losslessCount = 0;
        $highCount = 0;
        $hiresCount = 0;
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $formats[] = ['value' => (string) $row['format'], 'count' => (int) $row['files']];
            $total += (int) $row['files'];
            $losslessCount += (int) $row['lossless'];
            $highCount += (int) $row['high'];
            $hiresCount += (int) $row['hires'];
        }
        return [
            'probed' => $total,
            'formats' => $formats,
            'quality' => [
                'lossless' => $losslessCount,
                'high' => $highCount,
                'standard' => max(0, $total - $losslessCount - $highCount),
            ],
            'hires' => $hiresCount,
            // Genre was left out of this library until the tags were actually
            // read: a single track in 12,807 carried one, which made the select
            // a dead end. That number was the extractor's, not the library's —
            // the files had the tags all along — so it is offered now, as free
            // text from the tag rather than from the film dictionary.
            'tag_genres' => $this->tagGenreOptions($kind),
            'decades' => $this->decadeOptions($kind, 'audio'),
            'unidentified' => $this->unidentifiedCount($kind, 'audio'),
            // Absent for music, but the shape has to match what the film library
            // sends or the client would need two response types.
            'video_codecs' => [],
            'audio_codecs' => [],
            'resolutions' => [],
            'genres' => [],
        ];
    }

    /**
     * @param array<string, mixed> $raw
     * @return array<string, string|int> only the filters that were actually set
     */
    private static function normalizeFilters(array $raw): array
    {
        $filters = [];
        $resolution = $raw['resolution'] ?? '';
        if (is_string($resolution) && $resolution !== '' && $resolution !== 'any') {
            if (!array_key_exists($resolution, self::RESOLUTION_FLOORS)) {
                throw new BridgeRequestException('Nieprawidłowy filtr rozdzielczości.');
            }
            $filters['resolution'] = $resolution;
        }
        $hdr = $raw['hdr'] ?? '';
        if (is_string($hdr) && $hdr !== '' && $hdr !== 'any') {
            if (!in_array($hdr, ['yes', 'no'], true)) {
                throw new BridgeRequestException('Nieprawidłowy filtr HDR.');
            }
            $filters['hdr'] = $hdr;
        }
        foreach (['video_codec', 'audio_codec'] as $key) {
            $codec = $raw[$key] ?? '';
            if (is_string($codec) && $codec !== '' && $codec !== 'any') {
                if (preg_match('/^[a-z0-9_.-]{1,32}$/D', $codec) !== 1) {
                    throw new BridgeRequestException('Nieprawidłowy filtr kodeka.');
                }
                $filters[$key] = $codec;
            }
        }
        // What a film is about rather than what it is made of. Both are only ever
        // known for videos, and only for those a lookup has reached, so both
        // narrow to files that carry the fact instead of assuming a default.
        //
        // Two genre filters, because they are two different facts. A film's
        // genre is a row in a catalogued dictionary that a lookup or a person
        // put there; a track's is whatever the person who tagged the file
        // typed, and there are hundreds of spellings of it. Sharing one key
        // would mean one SQL condition guessing which of the two it is.
        //
        // Both accept 'none', which is how the library answers "and what about
        // everything you could not identify?" — on a real disk that is never a
        // small pile, and without it those files are invisible to the filter.
        $genre = $raw['genre'] ?? '';
        if (is_string($genre) && $genre !== '' && $genre !== 'any') {
            if (preg_match('/^[a-z0-9-]{1,48}$/D', $genre) !== 1) {
                throw new BridgeRequestException('Nieprawidłowy filtr gatunku.');
            }
            $filters['genre'] = $genre;
        }
        $tagGenre = $raw['tag_genre'] ?? '';
        if (is_string($tagGenre) && $tagGenre !== '' && $tagGenre !== 'any') {
            if (mb_strlen($tagGenre) > 64) {
                throw new BridgeRequestException('Nieprawidłowy filtr gatunku.');
            }
            $filters['tag_genre'] = $tagGenre;
        }
        $decade = $raw['decade'] ?? '';
        if (is_string($decade) && $decade !== '' && $decade !== 'any') {
            if (preg_match('/^(1[89]|20)\d0$/D', $decade) !== 1) {
                throw new BridgeRequestException('Nieprawidłowy filtr dekady.');
            }
            $filters['decade'] = (int) $decade;
        }
        // Music filters. The audio side has no probe columns, so these read the
        // tags Mutagen stored; the file's own extension answers "lossless?".
        $format = $raw['format'] ?? '';
        if (is_string($format) && $format !== '' && $format !== 'any') {
            if (preg_match('/^[a-z0-9]{1,8}$/D', $format) !== 1) {
                throw new BridgeRequestException('Nieprawidłowy filtr formatu.');
            }
            $filters['format'] = $format;
        }
        $quality = $raw['quality'] ?? '';
        if (is_string($quality) && $quality !== '' && $quality !== 'any') {
            if (!in_array($quality, ['lossless', 'high', 'standard'], true)) {
                throw new BridgeRequestException('Nieprawidłowy filtr jakości.');
            }
            $filters['quality'] = $quality;
        }
        $hires = $raw['hires'] ?? '';
        if (is_string($hires) && $hires !== '' && $hires !== 'any') {
            if (!in_array($hires, ['yes', 'no'], true)) {
                throw new BridgeRequestException('Nieprawidłowy filtr hi-res.');
            }
            $filters['hires'] = $hires;
        }
        return $filters;
    }

    /** SQL for a numeric audio tag Mutagen wrote into metadata_json. */
    private static function audioTag(string $name): string
    {
        return "CAST(JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.{$name}')) AS UNSIGNED)";
    }

    /** SQL for a textual audio tag (genre and friends), as written by the tagger. */
    private static function audioText(string $name): string
    {
        return "JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.{$name}'))";
    }

    private static function losslessCondition(): string
    {
        $quoted = implode(', ', array_map(static fn (string $ext): string => "'{$ext}'", self::LOSSLESS_EXTENSIONS));
        return "LOWER(mi.file_extension) IN ({$quoted})";
    }

    /**
     * @param array<string, string|int> $filters
     * @return array<int, string> SQL conditions; parameters are bound by bindFilters
     */
    private static function filterConditions(array $filters): array
    {
        $conditions = [];
        if (isset($filters['resolution'])) {
            $conditions[] = 'mi.video_height >= :filter_min_height';
        }
        if (isset($filters['hdr'])) {
            $conditions[] = $filters['hdr'] === 'yes' ? 'mi.is_hdr = 1' : 'mi.is_hdr = 0';
        }
        if (isset($filters['video_codec'])) {
            $conditions[] = 'mi.video_codec = :filter_video_codec';
        }
        if (isset($filters['audio_codec'])) {
            $conditions[] = 'mi.audio_codec = :filter_audio_codec';
        }
        if (isset($filters['genre'])) {
            $carries = 'EXISTS (SELECT 1 FROM media_item_genres mig'
                . ' INNER JOIN media_genres mg ON mg.id = mig.genre_id'
                . ' WHERE mig.media_item_id = mi.id AND mg.slug = :filter_genre)';
            $conditions[] = $filters['genre'] === 'none'
                ? "mi.media_kind = 'video' AND NOT EXISTS (SELECT 1 FROM media_item_genres mig"
                    . ' WHERE mig.media_item_id = mi.id)'
                : $carries;
        }
        if (isset($filters['tag_genre'])) {
            $tag = self::audioText('genre');
            $conditions[] = $filters['tag_genre'] === 'none'
                ? "mi.media_kind = 'audio' AND ({$tag} IS NULL OR {$tag} = '')"
                : "{$tag} = :filter_tag_genre";
        }
        if (isset($filters['decade'])) {
            $conditions[] = 'mi.release_year BETWEEN :filter_decade_from AND :filter_decade_to';
        }
        // A music folder also holds covers and .nfo files. Without this they fell
        // into "below 320 kb/s" (no bitrate tag, no lossless extension) and the
        // count disagreed with the number the select had just offered.
        if (isset($filters['format']) || isset($filters['quality']) || isset($filters['hires'])) {
            $conditions[] = "mi.media_kind = 'audio'";
        }
        if (isset($filters['format'])) {
            $conditions[] = 'LOWER(mi.file_extension) = :filter_format';
        }
        if (isset($filters['quality'])) {
            $lossless = self::losslessCondition();
            $bitrate = self::audioTag('bitrate');
            $conditions[] = match ($filters['quality']) {
                'lossless' => $lossless,
                // A lossy file at 320 kb/s and up; lossless has its own answer above.
                'high' => "NOT {$lossless} AND {$bitrate} >= " . self::HIGH_BITRATE,
                default => "NOT {$lossless} AND ({$bitrate} IS NULL OR {$bitrate} < " . self::HIGH_BITRATE . ')',
            };
        }
        if (isset($filters['hires'])) {
            $rate = self::audioTag('sample_rate');
            $conditions[] = $filters['hires'] === 'yes'
                ? "{$rate} >= " . self::HIRES_SAMPLE_RATE
                : "({$rate} IS NULL OR {$rate} < " . self::HIRES_SAMPLE_RATE . ')';
        }
        return $conditions;
    }

    /**
     * The WHERE that selects the files a listing is about.
     *
     * Searching or filtering both look through the whole subtree; plain browsing
     * stays in the folder the caller opened. Shared by the page query and by the
     * count behind it, so the two can never disagree.
     *
     * @param array<string, string|int> $filters
     * @return array{0:string,1:bool} condition and whether the subtree is in scope
     */
    private static function itemScopeSql(string $query, array $filters): array
    {
        $subtree = $query !== '' || $filters !== [];
        $where = $subtree ? self::subtreeSql() : 'mi.directory_hash = :directory_hash';
        if ($query !== '') {
            $where .= ' AND ' . self::itemSearchCondition();
        }
        foreach (self::filterConditions($filters) as $condition) {
            $where .= ' AND ' . $condition;
        }
        return [$where, $subtree];
    }

    /**
     * How many files a filtered listing holds in total.
     *
     * Only asked for while a filter is on: a filtered view has no folders to
     * count against, and naming the real size beats a counter that grows as more
     * pages load.
     *
     * @param array<string, mixed> $directory
     * @param array<string, string|int> $filters
     */
    private function itemCount(array $directory, string $query, array $filters): int
    {
        [$where, $subtree] = self::itemScopeSql($query, $filters);
        $where .= self::mixedSourceSql($directory);
        $statement = $this->database->prepare(
            "SELECT COUNT(*)
             FROM media_items mi
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             WHERE mi.root_id = :root_id
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND {$where}"
        );
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        self::bindItemScope($statement, $directory, $subtree);
        if ($query !== '') {
            self::bindSearch($statement, $query);
        }
        self::bindFilters($statement, $filters);
        $statement->execute();
        return (int) $statement->fetchColumn();
    }

    /** @param array<string, string|int> $filters */
    private static function bindFilters(PDOStatement $statement, array $filters): void
    {
        if (isset($filters['resolution'])) {
            $statement->bindValue(':filter_min_height', self::RESOLUTION_FLOORS[$filters['resolution']], PDO::PARAM_INT);
        }
        if (isset($filters['video_codec'])) {
            $statement->bindValue(':filter_video_codec', $filters['video_codec'], PDO::PARAM_STR);
        }
        if (isset($filters['audio_codec'])) {
            $statement->bindValue(':filter_audio_codec', $filters['audio_codec'], PDO::PARAM_STR);
        }
        if (isset($filters['format'])) {
            $statement->bindValue(':filter_format', $filters['format'], PDO::PARAM_STR);
        }
        if (isset($filters['genre']) && $filters['genre'] !== 'none') {
            $statement->bindValue(':filter_genre', $filters['genre'], PDO::PARAM_STR);
        }
        if (isset($filters['tag_genre']) && $filters['tag_genre'] !== 'none') {
            $statement->bindValue(':filter_tag_genre', $filters['tag_genre'], PDO::PARAM_STR);
        }
        if (isset($filters['decade'])) {
            $decade = (int) $filters['decade'];
            $statement->bindValue(':filter_decade_from', $decade, PDO::PARAM_INT);
            $statement->bindValue(':filter_decade_to', $decade + 9, PDO::PARAM_INT);
        }
    }

    /** @return array{items:array<int, array<string, mixed>>,next_cursor:int|null,has_more:bool} */
    public function queue(
        LegacyIdentity $identity,
        string $kind,
        int $directoryId,
        int $cursorId = 0,
        int $limit = 500,
        string $direction = 'after',
        string $query = '',
        string $shuffleMode = 'off',
        string $shuffleSeed = '',
        int $offset = 0
    ): array {
        self::assertKind($kind);
        $shuffleModes = ['off', 'current', 'all', 'folders', 'mixed'];
        if (
            $kind !== 'music'
            || $cursorId < 0
            || $limit < 1
            || $limit > 1000
            || !in_array($direction, ['before', 'after'], true)
            || !in_array($shuffleMode, $shuffleModes, true)
            || $offset < 0
            || $offset > 1000000
            || ($shuffleMode === 'off' && $direction === 'before' && $cursorId === 0)
            || ($shuffleMode !== 'off' && ($direction !== 'after'
                || preg_match('/^[A-Za-z0-9_-]{8,64}$/D', $shuffleSeed) !== 1))
        ) {
            throw new BridgeRequestException('Nieprawidłowa kolejka.');
        }
        $query = self::cleanQuery($query);
        $directory = $this->directory($kind, $directoryId);
        $prefix = (string) $directory['relative_path'];
        $allTracks = $shuffleMode === 'all';
        $total = $this->queueTotal($directory, $query, $allTracks);

        if ($shuffleMode === 'off') {
            $comparison = $direction === 'before' ? '<' : '>';
            $order = $direction === 'before' ? 'DESC' : 'ASC';
            $statement = $this->database->prepare(
                self::itemSelect() .
                " WHERE mi.root_id = :root_id
                    AND mi.media_kind = 'audio'
                    AND mi.id {$comparison} :cursor_id
                    AND mi.deleted_at IS NULL
                    AND mi.catalog_status = 'ready'
                    AND " . self::subtreeSql() . "
                    AND " . self::itemSearchCondition() . "
                  ORDER BY mi.id {$order}
                  LIMIT :row_limit"
            );
            self::bindIdentity($statement, $identity);
            $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
            $statement->bindValue(':cursor_id', $cursorId, PDO::PARAM_INT);
            self::bindSubtree($statement, $prefix);
            self::bindSearch($statement, $query);
            $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
            $statement->execute();
            $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
            $hasMore = count($rows) > $limit;
            if ($hasMore) {
                array_pop($rows);
            }
            if ($direction === 'before') {
                $rows = array_reverse($rows);
            }
            $items = array_map([self::class, 'publicItem'], $rows);
            $cursor = $items === []
                ? null
                : (int) $items[$direction === 'before' ? 0 : array_key_last($items)]['id'];
            return ['items' => $items, 'next_cursor' => $hasMore ? $cursor : null, 'has_more' => $hasMore, 'offset' => 0, 'total' => $total];
        }

        $scopeSql = $allTracks ? '1 = 1' : self::subtreeSql();
        $searchSql = $allTracks
            ? '1 = 1'
            : self::itemSearchCondition();
        $orderSql = match ($shuffleMode) {
            'folders' => "CRC32(CONCAT(:seed_folder, '-folder-', HEX(mi.directory_hash))), mi.relative_path, mi.id",
            'mixed' => "CRC32(CONCAT(:seed_item, '-item-', mi.id)), mi.id",
            default => "CRC32(CONCAT(:seed_item, '-item-', mi.id)), mi.id",
        };
        $statement = $this->database->prepare(
            self::itemSelect() .
            " WHERE mi.root_id = :root_id
                AND mi.media_kind = 'audio'
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND {$scopeSql}
                AND {$searchSql}
              ORDER BY {$orderSql}
              LIMIT :row_limit OFFSET :row_offset"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        if (!$allTracks) {
            self::bindSubtree($statement, $prefix);
            self::bindSearch($statement, $query);
        }
        if ($shuffleMode === 'folders') {
            $statement->bindValue(':seed_folder', $shuffleSeed, PDO::PARAM_STR);
        }
        if (in_array($shuffleMode, ['current', 'all', 'mixed'], true)) {
            $statement->bindValue(':seed_item', $shuffleSeed, PDO::PARAM_STR);
        }
        $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', $offset, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        if ($hasMore) {
            array_pop($rows);
        }
        $items = array_map([self::class, 'publicItem'], $rows);
        return [
            'items' => $items,
            'next_cursor' => $hasMore ? $offset + count($items) : null,
            'has_more' => $hasMore,
            'offset' => $offset,
            'total' => $total,
        ];
    }

    /** @param array<string, mixed> $directory */
    private function queueTotal(array $directory, string $query, bool $allTracks): int
    {
        $prefix = (string) $directory['relative_path'];
        $scopeSql = $allTracks ? '1 = 1' : self::subtreeSql();
        $searchSql = $allTracks
            ? '1 = 1'
            : self::itemSearchCondition();
        $statement = $this->database->prepare(
            "SELECT COUNT(*) FROM media_items mi
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             WHERE mi.root_id = :root_id
               AND mi.media_kind = 'audio'
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND {$scopeSql}
               AND {$searchSql}"
        );
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        if (!$allTracks) {
            self::bindSubtree($statement, $prefix);
            self::bindSearch($statement, $query);
        }
        $statement->execute();
        return (int) $statement->fetchColumn();
    }

    /**
     * Where a file has to sit to count as "started, not finished".
     *
     * Below the floor the viewer barely opened it, above the ceiling they have
     * effectively seen it — a film with two minutes left is not an invitation.
     * The ceiling doubles as the definition of "watched" for {@see nextUp()},
     * because a player that is closed before the last frame never sends the
     * `complete` event that would zero the position.
     */
    private const CONTINUE_FLOOR = 0.02;
    private const CONTINUE_CEILING = 0.95;

    /**
     * Shortest audio worth resuming: ten minutes.
     *
     * A three-minute song stopped halfway is not unfinished business, and the
     * dock already restores the last queue by itself. What belongs on a shelf is
     * long-form audio — a set, a radio show, an audiobook, an album kept in one
     * file. Without this the list was 152 songs deep and 8 of them meant it.
     */
    private const CONTINUE_MIN_AUDIO_MS = 600000;

    /** How many finished films a "what next" pass looks back over. */
    private const CONTINUE_HISTORY = 40;

    /** How many folders that pass may open, and how much of each it reads. */
    private const CONTINUE_FOLDER_BUDGET = 8;
    private const CONTINUE_FOLDER_FILES = 400;

    /**
     * How short a neighbour may be and still be offered, against the file just
     * finished.
     *
     * Film folders are full of things that are not the film: a 28-minute bonus
     * feature next to a 133-minute rip, a sample, a trailer, a leftover Blu-ray
     * stream. A sequel or the next episode always runs to a comparable length,
     * so one ratio separates "watch this next" from "this was in the box".
     */
    private const CONTINUE_LENGTH_RATIO = 0.5;

    /**
     * The start page's shelf: what the account began and has not finished, plus
     * what naturally follows what it did finish.
     *
     * One call answers both libraries because the start page shows them side by
     * side; a library the caller's group cannot reach is simply absent, the same
     * rule the navigation follows.
     *
     * @param array{music:bool,movies:bool} $access libraries the caller may see
     * @return array{movies:array<int,array<string,mixed>>,music:array<int,array<string,mixed>>,tracks:array<int,array<string,mixed>>,next:array<int,array<string,mixed>>}
     */
    public function continueWatching(LegacyIdentity $identity, array $access, int $limit = 12): array
    {
        if ($limit < 1 || $limit > 50) {
            throw new BridgeRequestException('Nieprawidłowy limit listy „Kontynuuj”.');
        }
        // A guest has nothing to continue: playback() stops before writing history.
        if ($identity->isGuest) {
            return ['movies' => [], 'music' => [], 'tracks' => [], 'next' => [], 'popular' => []];
        }
        $music = $access['music'] ?? false;
        return [
            'movies' => ($access['movies'] ?? false) ? $this->unfinished($identity, 'movies', $limit, 1) : [],
            'popular' => $this->popular($identity, $access, $limit),
            // Long-form audio and ordinary songs answer different questions — "where
            // was I in that set" against "what was I listening to" — so they are two
            // shelves rather than one list where the long ones drown.
            'music' => $music ? $this->unfinished($identity, 'music', $limit, self::CONTINUE_MIN_AUDIO_MS) : [],
            'tracks' => $music ? $this->unfinished($identity, 'music', $limit, 1, self::CONTINUE_MIN_AUDIO_MS - 1) : [],
            // "Next episode" is a video idea. Music has no episodes, and a random
            // track after every song played would bury the shelf in noise.
            'next' => ($access['movies'] ?? false) ? $this->nextUp($identity, $limit) : [],
        ];
    }

    /** How far back "lately" reaches when counting what the house is playing. */
    private const POPULAR_WINDOW_DAYS = 30;

    /**
     * What to offer when a film reaches its end.
     *
     * The same folder reading as the start page's "watch next", but asked about a
     * named file rather than about the history: the viewer is sitting in front of
     * the credits, so the question is "what follows *this*", not "what follows
     * whatever they finished lately".
     *
     * `next` is the one the player may roll into on its own, so it is only ever
     * the following episode of a series — a film is never auto-played after
     * another film. Everything else is a suggestion the viewer has to choose.
     *
     * @return array{next:array<string,mixed>|null,suggestions:array<int,array<string,mixed>>}
     */
    public function upNext(LegacyIdentity $identity, int $mediaItemId, int $limit = 8): array
    {
        if ($mediaItemId < 1 || $limit < 1 || $limit > 24) {
            throw new BridgeRequestException('Nieprawidłowe parametry sugestii.');
        }
        $statement = $this->database->prepare(
            "SELECT mi.id, mi.root_id, mi.directory_hash, mi.duration_ms, mr.media_kind AS root_kind
             FROM media_items mi
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             WHERE mi.id = :id AND mi.deleted_at IS NULL AND mi.media_kind = 'video'
               AND mi.catalog_status = 'ready'
               AND mr.media_kind IN ('movies', 'mixed')
             LIMIT 1"
        );
        $statement->execute(['id' => $mediaItemId]);
        $current = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($current) || $current['directory_hash'] === null) {
            return ['next' => null, 'suggestions' => []];
        }
        $access = ['music' => false, 'movies' => true];
        $siblings = $this->folderFiles($identity, (int) $current['root_id'], (string) $current['directory_hash']);
        $ordered = self::seriesOrder($siblings);
        $next = null;
        if ($ordered !== null) {
            $position = array_search($mediaItemId, array_column($ordered, 'id'), true);
            if ($position !== false && isset($ordered[$position + 1])) {
                $next = (int) $ordered[$position + 1]['id'];
            }
        }
        // Suggestions: the rest of this folder first (it is what the viewer is
        // already in), then whatever the household has been playing.
        if ($ordered !== null) {
            // A series is watched in order, so it is offered in order: what is
            // still ahead, ascending (the episode right after this one is
            // `next`, above), then the episodes behind, then whatever in the
            // folder carries no number. Shuffled like a folder of films, the
            // panel behind S01E01 read E05, E03, E04, E07, E08, E06.
            $position = array_search($mediaItemId, array_column($ordered, 'id'), true);
            $numbered = array_fill_keys(array_map(static fn (array $row): int => (int) $row['id'], $ordered), true);
            $fromFolder = array_merge(
                $position === false ? $ordered : array_slice($ordered, $position + 1),
                $position === false ? [] : array_slice($ordered, 0, $position),
                array_values(array_filter($siblings, static fn (array $row): bool => !isset($numbered[(int) $row['id']])))
            );
        } else {
            $fromFolder = $siblings;
            shuffle($fromFolder);
        }
        $fromFolder = array_values(array_filter(
            $fromFolder,
            static fn (array $row): bool => (int) $row['id'] !== $mediaItemId && (int) $row['id'] !== $next
        ));
        $ids = array_slice(array_map(static fn (array $row): int => (int) $row['id'], $fromFolder), 0, $limit);
        $fill = static function (array $entries) use (&$ids, $limit, $mediaItemId, $next): void {
            foreach ($entries as $entry) {
                $id = (int) $entry['item']['id'];
                if ($id !== $mediaItemId && $id !== $next && !in_array($id, $ids, true)) {
                    $ids[] = $id;
                }
                if (count($ids) >= $limit) {
                    return;
                }
            }
        };
        if (count($ids) < $limit) {
            $fill($this->popular($identity, $access, $limit));
        }
        // A film alone in its folder, on an account that has already played what
        // the house is playing, would otherwise end on an empty screen.
        if (count($ids) < $limit) {
            $fill($this->wellRatedUnseen($identity, $limit));
        }
        $wanted = $next === null ? $ids : array_merge([$next], $ids);
        $items = $wanted === [] ? [] : $this->itemsById($identity, $wanted);
        return [
            'next' => $next === null ? null : ($items[$next] ?? null),
            'suggestions' => array_values(array_filter(array_map(
                static fn (int $id): ?array => $items[$id] ?? null,
                $ids
            ))),
        ];
    }

    /**
     * Films nobody in the house has rated badly and this account has not opened.
     *
     * The last resort behind the credits. Rated first, then simply long enough to
     * be a feature — which keeps trailers and disc extras out of the panel.
     *
     * @return array<int, array<string, mixed>>
     */
    private function wellRatedUnseen(LegacyIdentity $identity, int $limit): array
    {
        $statement = $this->database->prepare(
            self::itemSelect('md.id AS directory_id') . "
                INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                LEFT JOIN media_directories md
                       ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND mi.media_kind = 'video'
                AND mr.media_kind IN ('movies', 'mixed')
                AND mi.duration_ms >= 2400000
                AND ps.last_played_at IS NULL
              ORDER BY COALESCE(ra.avg_rating, 0) DESC, COALESCE(mpt.play_count, 0) DESC, mi.id
              LIMIT :row_limit"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':row_limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        return array_map(
            static fn (array $row): array => [
                'item' => self::publicItem($row),
                'directory_id' => $row['directory_id'] === null ? null : (int) $row['directory_id'],
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * The folder's files in running order, or null when it is not a series.
     *
     * @param array<int, array<string, mixed>> $siblings
     * @return array<int, array<string, mixed>>|null
     */
    private static function seriesOrder(array $siblings): ?array
    {
        $names = array_map(static fn (array $row): string => (string) $row['relative_path'], $siblings);
        if (EpisodeOrder::scheme($names) === null) {
            return null;
        }
        $ranked = [];
        foreach ($siblings as $row) {
            $parsed = EpisodeOrder::parse((string) $row['relative_path']);
            if ($parsed !== null) {
                $ranked[] = $row + ['rank' => EpisodeOrder::rank($parsed)];
            }
        }
        usort($ranked, static fn (array $a, array $b): int => $a['rank'] <=> $b['rank']);
        return $ranked;
    }

    /**
     * Full cards for a set of ids, keyed by id so callers keep their own order.
     *
     * @param array<int, int> $ids
     * @return array<int, array<string, mixed>>
     */
    private function itemsById(LegacyIdentity $identity, array $ids): array
    {
        $ids = array_values(array_unique($ids));
        $placeholders = implode(', ', array_map(static fn (int $i): string => ':pick' . $i, range(0, count($ids) - 1)));
        $statement = $this->database->prepare(
            self::itemSelect('md.id AS directory_id') . "
                LEFT JOIN media_directories md
                       ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE mi.id IN ({$placeholders})"
        );
        self::bindIdentity($statement, $identity);
        foreach ($ids as $index => $id) {
            $statement->bindValue(':pick' . $index, $id, PDO::PARAM_INT);
        }
        $statement->execute();
        $items = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $items[(int) $row['id']] = [
                'item' => self::publicItem($row),
                'directory_id' => $row['directory_id'] === null ? null : (int) $row['directory_id'],
            ];
        }
        return $items;
    }

    /**
     * What the household has been playing lately, that this account has not.
     *
     * Counted across everyone, not per account: on a home server the interesting
     * signal is "somebody here keeps going back to this", and an all-time chart
     * would show the same five files for ever. Anything the caller has already
     * opened is left out — this shelf is for discovering, not for repeating, and
     * the four shelves above already cover what they have started.
     *
     * @param array{music:bool,movies:bool} $access
     * @return array<int, array<string, mixed>>
     */
    private function popular(LegacyIdentity $identity, array $access, int $limit): array
    {
        // By source, like every list: a music right reaches audio from music
        // (or mixed) roots, not every audio file — a soundtrack filed with the
        // films is the film library's.
        $libraries = [];
        if ($access['music'] ?? false) {
            $libraries[] = "(mi.media_kind = 'audio' AND mr.media_kind IN ('music', 'mixed'))";
        }
        if ($access['movies'] ?? false) {
            $libraries[] = "(mi.media_kind = 'video' AND mr.media_kind IN ('movies', 'mixed'))";
        }
        if ($libraries === []) {
            return [];
        }
        $librarySql = '(' . implode(' OR ', $libraries) . ')';
        $statement = $this->database->prepare(
            self::itemSelect('recent.listeners, md.id AS directory_id') . "
                INNER JOIN (
                  SELECT ps.media_item_id, COUNT(DISTINCT ps.user_id) AS listeners
                  FROM playback_stats ps
                  WHERE ps.last_played_at >= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL :window_days DAY)
                    AND ps.user_id <> :excluded_user_id
                  GROUP BY ps.media_item_id
                ) recent ON recent.media_item_id = mi.id
                INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                LEFT JOIN media_directories md
                       ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND {$librarySql}
                AND ps.last_played_at IS NULL
              ORDER BY recent.listeners DESC, COALESCE(mpt.play_count, 0) DESC, mi.id
              LIMIT :row_limit"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':window_days', self::POPULAR_WINDOW_DAYS, PDO::PARAM_INT);
        $statement->bindValue(':excluded_user_id', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':row_limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        return array_map(
            static fn (array $row): array => [
                'item' => self::publicItem($row),
                'listeners' => (int) $row['listeners'],
                'directory_id' => $row['directory_id'] === null ? null : (int) $row['directory_id'],
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * Files of one library the account left part-way through, newest first.
     *
     * @param int $minimumDuration shortest file worth offering, in milliseconds
     * @param int|null $maximumDuration longest one, so a shelf can take only the short files
     * @return array<int, array<string, mixed>>
     */
    private function unfinished(
        LegacyIdentity $identity,
        string $kind,
        int $limit,
        int $minimumDuration,
        ?int $maximumDuration = null
    ): array {
        $mediaKind = $kind === 'music' ? 'audio' : 'video';
        $statement = $this->database->prepare(
            self::itemSelect('ps.last_position_ms, ps.last_played_at, md.id AS directory_id') . "
                INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                LEFT JOIN media_directories md
                       ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND mi.media_kind = :media_kind
                AND mr.media_kind IN (:root_kind, 'mixed')
                AND ps.last_played_at IS NOT NULL
                AND ps.continue_hidden_at IS NULL
                -- Said again below by the 2 % floor; said here because this
                -- half needs no look at the catalogue, and nine plays in ten
                -- were heard to the end (position 0).
                AND ps.last_position_ms > 0
                AND mi.duration_ms >= :minimum_duration
                " . ($maximumDuration === null ? '' : 'AND mi.duration_ms <= :maximum_duration') . "
                AND ps.last_position_ms >= mi.duration_ms * :position_floor
                AND ps.last_position_ms <= mi.duration_ms * :position_ceiling
              ORDER BY ps.last_played_at DESC
              LIMIT :row_limit"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':media_kind', $mediaKind, PDO::PARAM_STR);
        $statement->bindValue(':root_kind', $kind, PDO::PARAM_STR);
        $statement->bindValue(':minimum_duration', $minimumDuration, PDO::PARAM_INT);
        if ($maximumDuration !== null) {
            $statement->bindValue(':maximum_duration', $maximumDuration, PDO::PARAM_INT);
        }
        $statement->bindValue(':position_floor', self::CONTINUE_FLOOR);
        $statement->bindValue(':position_ceiling', self::CONTINUE_CEILING);
        $statement->bindValue(':row_limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        return array_map(
            static fn (array $row): array => [
                'item' => self::publicItem($row),
                'position_ms' => (int) $row['last_position_ms'],
                'last_played_at' => (string) $row['last_played_at'],
                // Lets the start page build the same folder queue the library would.
                'directory_id' => $row['directory_id'] === null ? null : (int) $row['directory_id'],
            ],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * What to watch after the films the account finished.
     *
     * Two shapes of answer, decided per folder by {@see EpisodeOrder::scheme()}:
     * a series gets the next episode nobody has opened yet, and anything else
     * gets another untouched file from the same folder. A folder is answered
     * once, by its most recent finished file, so a binge-watched season proposes
     * one episode instead of ten.
     *
     * @return array<int, array<string, mixed>>
     */
    private function nextUp(LegacyIdentity $identity, int $limit): array
    {
        $picks = $this->nextPicks($identity, $limit);
        return $picks === [] ? [] : $this->decorateNext($identity, $picks);
    }

    /**
     * The same choice, for the new start page (HomeShelves), which draws its
     * own cards: the picks themselves, in the order they were made.
     *
     * Two things differ from the old shelf. "Another film from this folder" is
     * decided by `$seed` instead of by chance — the page keeps its suggestions
     * still for a day, and a different film on every visit is not still. And
     * a folder the account declined a suggestion from is passed over: "not
     * this one" about the next episode means the series, not the episode.
     *
     * @param array<int, true> $declined ids of the files the account asked not to be offered
     * @return list<array{id:int,reason:string,after:array{id:int,title:string},last_played_at:string|null}>
     */
    public function nextEpisodePicks(LegacyIdentity $identity, int $limit, array $declined, string $seed): array
    {
        $picks = [];
        foreach ($this->nextPicks($identity, $limit, $declined, $seed) as $id => $pick) {
            $picks[] = [
                'id' => $id,
                'reason' => $pick['reason'],
                'after' => $pick['after'],
                'last_played_at' => BridgeTime::iso($pick['played_unix']),
            ];
        }
        return $picks;
    }

    /**
     * @param array<int, true> $declined
     * @return array<int, array<string, mixed>> chosen id => reason and source
     */
    private function nextPicks(LegacyIdentity $identity, int $limit, array $declined = [], ?string $seed = null): array
    {
        $picks = [];
        $seenFolders = [];
        foreach ($this->recentlyFinished($identity) as $row) {
            if (count($seenFolders) >= self::CONTINUE_FOLDER_BUDGET || count($picks) >= $limit) {
                break;
            }
            // A folder is its source and its path: two sources may both keep a
            // "Season 1", and the hash is of the path alone.
            $folderKey = (int) $row['root_id'] . ':' . $row['directory_hash'];
            if (isset($seenFolders[$folderKey])) {
                continue;
            }
            $seenFolders[$folderKey] = true;
            $siblings = $this->folderFiles($identity, (int) $row['root_id'], (string) $row['directory_hash']);
            foreach ($siblings as $sibling) {
                if (isset($declined[(int) $sibling['id']])) {
                    continue 2;
                }
            }
            $pick = self::chooseNext(
                $siblings,
                (int) $row['id'],
                $row['duration_ms'] === null ? null : (int) $row['duration_ms'],
                $seed
            );
            if ($pick === null) {
                continue;
            }
            $picks[$pick['id']] = [
                'after' => ['id' => (int) $row['id'], 'title' => (string) $row['title']],
                'reason' => $pick['reason'],
                'last_played_at' => (string) $row['last_played_at'],
                'played_unix' => $row['played_unix'],
            ];
        }
        return $picks;
    }

    /**
     * Films the account has seen through: either the player reported `complete`
     * (which zeroes the position) or it was left past the ceiling.
     *
     * @return array<int, array<string, mixed>>
     */
    private function recentlyFinished(LegacyIdentity $identity): array
    {
        $statement = $this->database->prepare(
            "SELECT mi.id, mi.root_id, mi.directory_hash, mi.duration_ms,
                    COALESCE(mo.title, mi.title) AS title, ps.last_played_at,
                    UNIX_TIMESTAMP(ps.last_played_at) AS played_unix
             FROM playback_stats ps
             INNER JOIN media_items mi ON mi.id = ps.media_item_id
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
             WHERE ps.user_id = :user_id
               AND ps.last_played_at IS NOT NULL
               AND ps.continue_hidden_at IS NULL
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND mi.media_kind = 'video'
               AND mi.directory_hash IS NOT NULL
               AND mr.media_kind IN ('movies', 'mixed')
               AND (
                     (ps.play_count > 0 AND ps.last_position_ms = 0)
                     OR (mi.duration_ms > 0 AND ps.last_position_ms > mi.duration_ms * :position_ceiling)
                   )
             ORDER BY ps.last_played_at DESC
             LIMIT :row_limit"
        );
        $statement->bindValue(':user_id', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':position_ceiling', self::CONTINUE_CEILING);
        $statement->bindValue(':row_limit', self::CONTINUE_HISTORY, PDO::PARAM_INT);
        $statement->execute();
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Every film in one folder, with what this account has done with each.
     *
     * @return array<int, array<string, mixed>>
     */
    private function folderFiles(LegacyIdentity $identity, int $rootId, string $directoryHash): array
    {
        $statement = $this->database->prepare(
            "SELECT mi.id, mi.relative_path, mi.duration_ms, ps.last_played_at
             FROM media_items mi
             LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = :user_id
             WHERE mi.root_id = :root_id
               AND mi.directory_hash = :directory_hash
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND mi.media_kind = 'video'
             ORDER BY mi.relative_path
             LIMIT :row_limit"
        );
        $statement->bindValue(':user_id', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':root_id', $rootId, PDO::PARAM_INT);
        $statement->bindValue(':directory_hash', $directoryHash, PDO::PARAM_LOB);
        $statement->bindValue(':row_limit', self::CONTINUE_FOLDER_FILES, PDO::PARAM_INT);
        $statement->execute();
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * The one file worth offering next out of a folder, or null when there is none.
     *
     * Only files nobody has opened qualify: proposing an episode already seen, or
     * one waiting in the "continue" list right above, would be worse than silence.
     *
     * @param array<int, array<string, mixed>> $siblings
     * @param int|null $watchedDuration length of the file just finished, when known
     * @param string|null $seed makes "another film from this folder" the same film for the same seed
     * @return array{id:int,reason:string}|null
     */
    private static function chooseNext(array $siblings, int $currentId, ?int $watchedDuration, ?string $seed = null): ?array
    {
        $untouched = array_values(array_filter(
            $siblings,
            static fn (array $row): bool => (int) $row['id'] !== $currentId && $row['last_played_at'] === null
        ));
        if ($untouched === []) {
            return null;
        }
        $isSeries = EpisodeOrder::scheme(array_map(
            static fn (array $row): string => (string) $row['relative_path'],
            $siblings
        )) !== null;
        if ($isSeries) {
            $current = null;
            foreach ($siblings as $row) {
                if ((int) $row['id'] === $currentId) {
                    $parsed = EpisodeOrder::parse((string) $row['relative_path']);
                    $current = $parsed === null ? null : EpisodeOrder::rank($parsed);
                }
            }
            $best = null;
            $bestRank = PHP_INT_MAX;
            foreach ($untouched as $row) {
                $parsed = EpisodeOrder::parse((string) $row['relative_path']);
                if ($parsed === null) {
                    continue;
                }
                $rank = EpisodeOrder::rank($parsed);
                if (($current !== null && $rank <= $current) || $rank >= $bestRank) {
                    continue;
                }
                $bestRank = $rank;
                $best = (int) $row['id'];
            }
            if ($best !== null) {
                return ['id' => $best, 'reason' => 'episode'];
            }
            // Season finished, or the watched file carries no number: fall through
            // to "something else from here" rather than offering nothing.
        }
        // No running order to follow, so length is the only thing that separates a
        // sequel from the bonus feature sitting beside it. Episode order never
        // needs this — a short episode is still the episode that comes next.
        $floor = $watchedDuration === null ? 0 : (int) ($watchedDuration * self::CONTINUE_LENGTH_RATIO);
        $comparable = array_values(array_filter(
            $untouched,
            static fn (array $row): bool => $floor === 0
                || ($row['duration_ms'] !== null && (int) $row['duration_ms'] >= $floor)
        ));
        if ($comparable === []) {
            return null;
        }
        if ($seed === null) {
            return ['id' => (int) $comparable[random_int(0, count($comparable) - 1)]['id'], 'reason' => 'folder'];
        }
        $chosen = null;
        $lowest = null;
        foreach ($comparable as $row) {
            $weight = [crc32($seed . '-' . $row['id']), (int) $row['id']];
            if ($lowest === null || $weight < $lowest) {
                $lowest = $weight;
                $chosen = (int) $row['id'];
            }
        }
        return ['id' => (int) $chosen, 'reason' => 'folder'];
    }

    /**
     * Turn the chosen ids into cards, keeping the order the picks were made in.
     *
     * @param array<int, array<string, mixed>> $picks id => reason and source
     * @return array<int, array<string, mixed>>
     */
    private function decorateNext(LegacyIdentity $identity, array $picks): array
    {
        $ids = array_keys($picks);
        $placeholders = implode(', ', array_map(static fn (int $index): string => ':next_id' . $index, range(0, count($ids) - 1)));
        $statement = $this->database->prepare(
            self::itemSelect('md.id AS directory_id') . "
                LEFT JOIN media_directories md
                       ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE mi.id IN ({$placeholders})"
        );
        self::bindIdentity($statement, $identity);
        foreach ($ids as $index => $id) {
            $statement->bindValue(':next_id' . $index, $id, PDO::PARAM_INT);
        }
        $statement->execute();
        $rows = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rows[(int) $row['id']] = $row;
        }
        $entries = [];
        foreach ($picks as $id => $pick) {
            if (!isset($rows[$id])) {
                continue;
            }
            $entries[] = [
                'item' => self::publicItem($rows[$id]),
                'reason' => $pick['reason'],
                'after' => $pick['after'],
                'last_played_at' => $pick['last_played_at'],
                'directory_id' => $rows[$id]['directory_id'] === null ? null : (int) $rows[$id]['directory_id'],
            ];
        }
        return $entries;
    }

    /** @return array<int, int> */
    public function archiveSearchItemIds(
        string $kind,
        int $directoryId,
        string $query,
        int $maximum = 1000
    ): array {
        self::assertKind($kind);
        $query = self::cleanQuery($query);
        if ($query === '' || $maximum < 1 || $maximum > 1000) {
            throw new BridgeRequestException('Nieprawidłowe wyniki wyszukiwania.');
        }
        $directory = $this->directory($kind, $directoryId);
        $rootId = (int) $directory['root_id'];
        $prefix = (string) $directory['relative_path'];
        $scope = $prefix === '' ? '%' : self::escapeLike($prefix) . '/%';
        // What a search shows is files that match and folders that match, and a
        // folder that matches brings everything under it. That used to be one
        // statement asking, for every file in scope, whether any matching folder
        // contained it — files times folders, with no index able to help.
        // Asked in the order the answer is built instead, it is three cheap
        // questions: which files match by themselves, which folders match, and
        // what lies under those folders, read as indexed path ranges.
        $found = [];
        $collect = function (\PDOStatement $statement) use (&$found, $maximum): void {
            $statement->execute();
            foreach ($statement->fetchAll(PDO::FETCH_COLUMN) as $id) {
                $found[(int) $id] = true;
            }
            if (count($found) > $maximum) {
                throw new BridgeRequestException('Wyniki są puste albo przekraczają limit 1000 plików na archiwum.');
            }
        };

        $own = $this->database->prepare(
            "SELECT mi.id
             FROM media_items mi
             LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
             WHERE mi.root_id = :root_id
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND " . self::subtreeSql() . "
               AND " . self::itemSearchCondition() . "
             ORDER BY mi.id
             LIMIT :row_limit"
        );
        $own->bindValue(':root_id', $rootId, PDO::PARAM_INT);
        self::bindSubtree($own, $prefix);
        self::bindSearch($own, $query);
        $own->bindValue(':row_limit', $maximum + 1, PDO::PARAM_INT);
        $collect($own);

        $folders = $this->database->prepare(
            "SELECT smd.relative_path, smd.path_hash
             FROM media_directories smd
             WHERE smd.root_id = :root_id
               AND smd.deleted_at IS NULL
               AND smd.id <> :current_directory_id
               AND smd.relative_path LIKE :directory_scope ESCAPE '\\\\'
               AND " . self::directorySearchCondition('smd') . "
             ORDER BY smd.relative_path"
        );
        $folders->bindValue(':root_id', $rootId, PDO::PARAM_INT);
        $folders->bindValue(':current_directory_id', (int) $directory['id'], PDO::PARAM_INT);
        $folders->bindValue(':directory_scope', $scope, PDO::PARAM_STR);
        self::bindSearch($folders, $query);
        $folders->execute();
        // A matching folder inside a matching folder adds nothing the outer one
        // has not brought already, so only the outermost are read.
        $outermost = [];
        foreach ($folders->fetchAll(PDO::FETCH_ASSOC) as $folder) {
            $path = (string) $folder['relative_path'];
            $covered = false;
            foreach ($outermost as $kept) {
                if (str_starts_with($path, $kept['relative_path'] . '/')) {
                    $covered = true;
                    break;
                }
            }
            if (!$covered) {
                $outermost[] = $folder;
            }
        }
        foreach (array_chunk($outermost, 40) as $chunk) {
            $ranges = [];
            foreach (array_keys($chunk) as $index) {
                $ranges[] = self::subtreeSql('mi', "_folder_{$index}");
            }
            $under = $this->database->prepare(
                "SELECT mi.id
                 FROM media_items mi
                 WHERE mi.root_id = :root_id
                   AND mi.deleted_at IS NULL
                   AND mi.catalog_status = 'ready'
                   AND (" . implode(' OR ', $ranges) . ")
                 ORDER BY mi.id
                 LIMIT :row_limit"
            );
            $under->bindValue(':root_id', $rootId, PDO::PARAM_INT);
            foreach ($chunk as $index => $folder) {
                self::bindSubtree($under, (string) $folder['relative_path'], "_folder_{$index}");
            }
            $under->bindValue(':row_limit', $maximum + 1, PDO::PARAM_INT);
            $collect($under);
        }

        $ids = array_keys($found);
        if ($ids === []) {
            throw new BridgeRequestException('Wyniki są puste albo przekraczają limit 1000 plików na archiwum.');
        }
        sort($ids, SORT_NUMERIC);
        return $ids;
    }

    /**
     * Whether pulling this folder means pulling the whole library.
     *
     * The root of a library is not "a folder" to an operator handing out rights:
     * it is everything at once, so it answers to its own permission.
     */
    public function directoryScope(string $kind, int $directoryId): string
    {
        self::assertKind($kind);
        return (string) $this->directory($kind, $directoryId)['relative_path'] === '' ? 'library' : 'folder';
    }

    /** @return array<int, int> */
    public function archiveItemIds(string $kind, int $directoryId, int $maximum = 1000): array
    {
        self::assertKind($kind);
        if ($maximum < 1 || $maximum > 1000) {
            throw new BridgeRequestException('Nieprawidłowy limit archiwum.');
        }
        $directory = $this->directory($kind, $directoryId);
        $statement = $this->database->prepare(
            "SELECT mi.id
             FROM media_items mi
             WHERE mi.root_id = :root_id
               AND mi.deleted_at IS NULL
               AND mi.catalog_status = 'ready'
               AND " . self::subtreeSql() . "
             ORDER BY mi.relative_path
             LIMIT :row_limit"
        );
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        self::bindSubtree($statement, (string) $directory['relative_path']);
        $statement->bindValue(':row_limit', $maximum + 1, PDO::PARAM_INT);
        $statement->execute();
        $ids = array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN));
        if ($ids === [] || count($ids) > $maximum) {
            throw new BridgeRequestException('Folder jest pusty albo przekracza limit 1000 plików na archiwum.');
        }
        return $ids;
    }

    /** @return array<string, mixed> */
    private function directory(string $kind, ?int $directoryId): array
    {
        if ($directoryId !== null && $directoryId < 1) {
            throw new BridgeRequestException('Nieprawidłowy folder.');
        }
        $where = $directoryId === null ? "md.relative_path = ''" : 'md.id = :directory_id';
        $statement = $this->database->prepare(
            "SELECT md.*, mr.slug AS root_slug, mr.display_name AS root_name, mr.media_kind AS root_kind,
                    pmi.media_kind AS preview_kind
             FROM media_directories md
             INNER JOIN media_roots mr ON mr.id = md.root_id
             LEFT JOIN media_items pmi ON pmi.id = md.preview_media_item_id AND pmi.deleted_at IS NULL
             WHERE {$where}
               AND mr.media_kind IN (:kind, 'mixed')
               AND mr.is_enabled = 1
               AND md.deleted_at IS NULL
             ORDER BY (mr.media_kind = :own_kind) DESC, mr.id
             LIMIT 1"
        );
        if ($directoryId !== null) {
            $statement->bindValue(':directory_id', $directoryId, PDO::PARAM_INT);
        }
        $statement->bindValue(':kind', $kind, PDO::PARAM_STR);
        $statement->bindValue(':own_kind', $kind, PDO::PARAM_STR);
        $statement->execute();
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new CatalogItemNotFoundException('Folder jest niedostępny.');
        }
        // Which library the folder was opened as: a mixed root holds both kinds
        // of file and shows each library its own.
        $row['library_kind'] = $kind;
        return $row;
    }

    /**
     * The other sources of this library, as folders of its top level.
     *
     * A library opens on its first source. A second one of the same kind — a
     * second disk of films — and every mixed source had no way in at all: no
     * listing named them, and a folder inside them was refused by number. They
     * are listed beside the first source's own folders, each under its name.
     *
     * @param array<string, mixed> $top the library's first source's root folder
     * @return array<int, array<string, mixed>>
     */
    private function otherSources(string $kind, array $top): array
    {
        $statement = $this->database->prepare(
            "SELECT md.*, mr.slug AS root_slug, mr.display_name AS root_name, mr.media_kind AS root_kind,
                    pmi.media_kind AS preview_kind
             FROM media_directories md
             INNER JOIN media_roots mr ON mr.id = md.root_id
             LEFT JOIN media_items pmi ON pmi.id = md.preview_media_item_id AND pmi.deleted_at IS NULL
             WHERE md.relative_path = ''
               AND md.root_id <> :first_root
               AND mr.media_kind IN (:kind, 'mixed')
               AND mr.is_enabled = 1
               AND md.deleted_at IS NULL
             ORDER BY mr.display_name, mr.id"
        );
        $statement->bindValue(':first_root', (int) $top['root_id'], PDO::PARAM_INT);
        $statement->bindValue(':kind', $kind, PDO::PARAM_STR);
        $statement->execute();
        return array_map(
            static fn (array $row): array => $row + ['library_kind' => $kind],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /** In a mixed source, the files of the library it was opened as (and the pictures and notes beside them). */
    private static function mixedSourceSql(array $directory): string
    {
        if (($directory['root_kind'] ?? null) !== 'mixed') {
            return '';
        }
        return ($directory['library_kind'] ?? null) === 'music'
            ? " AND mi.media_kind <> 'video'"
            : " AND mi.media_kind <> 'audio'";
    }

    /** The kind a folder's covers and totals are read as: the source's, or for a mixed source the library's. */
    private static function effectiveKind(array $directory): string
    {
        $rootKind = (string) ($directory['root_kind'] ?? 'mixed');
        return $rootKind === 'mixed' && isset($directory['library_kind']) ? (string) $directory['library_kind'] : $rootKind;
    }

    /** @param array<string, mixed> $directory */
    private function directoryCount(array $directory, string $query): int
    {
        $recursive = $query !== '';
        $scope = $recursive
            ? "(md.relative_path LIKE :scope_prefix ESCAPE '\\\\')"
            : 'md.parent_path_hash = :parent_hash';
        $statement = $this->database->prepare(
            "SELECT COUNT(*)
             FROM media_directories md
             WHERE md.root_id = :root_id
               AND md.id <> :current_id
               AND {$scope}
               AND md.deleted_at IS NULL
               AND " . self::directorySearchCondition()
        );
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        $statement->bindValue(':current_id', (int) $directory['id'], PDO::PARAM_INT);
        if ($recursive) {
            $prefix = (string) $directory['relative_path'];
            $statement->bindValue(
                ':scope_prefix',
                $prefix === '' ? '%' : self::escapeLike($prefix) . '/%',
                PDO::PARAM_STR
            );
        } else {
            $statement->bindValue(':parent_hash', (string) $directory['path_hash'], PDO::PARAM_LOB);
        }
        self::bindSearch($statement, $query);
        $statement->execute();
        return (int) $statement->fetchColumn();
    }

    /** @param array<string, mixed> $directory
     * @return array<int, array<string, mixed>>
     */
    private function directoriesPage(
        array $directory,
        string $query,
        int $offset,
        int $limit,
        string $sort,
        string $randomSeed = ''
    ): array {
        if ($limit < 1) {
            return [];
        }
        $recursive = $query !== '';
        $scope = $recursive
            ? "(md.relative_path LIKE :scope_prefix ESCAPE '\\\\')"
            : 'md.parent_path_hash = :parent_hash';
        // A folder's rating and plays are those of everything below it. They
        // used to be a sub-query per folder in ORDER BY, each walking the whole
        // root (3 s for a page sorted by plays); now the totals of every folder
        // are worked out once per listing (folderTotalsSql) and joined.
        $byTotals = in_array($sort, ['rating_desc', 'rating_count_desc', 'plays_desc'], true);
        $order = match ($sort) {
            'random' => "CRC32(CONCAT(:random_seed, '-dir-', md.id)), md.id",
            'title_desc' => 'md.name DESC, md.relative_path DESC',
            'size_desc' => 'md.total_size_bytes DESC, md.name',
            // A folder nobody rated or played has no row here: NULL, last.
            'rating_desc' => 'totals.amount / NULLIF(totals.entries, 0) DESC, md.name',
            'rating_count_desc' => 'COALESCE(totals.entries, 0) DESC, md.name',
            'plays_desc' => 'totals.amount DESC, md.name',
            default => 'md.name, md.relative_path',
        };
        $statement = $this->database->prepare(
            ($byTotals ? self::folderTotalsSql(self::effectiveKind($directory), $sort === 'plays_desc') : '') .
            "SELECT md.*, mr.slug AS root_slug, mr.display_name AS root_name, mr.media_kind AS root_kind,
                    pmi.media_kind AS preview_kind
             FROM media_directories md
             INNER JOIN media_roots mr ON mr.id = md.root_id
             LEFT JOIN media_items pmi ON pmi.id = md.preview_media_item_id AND pmi.deleted_at IS NULL
             " . ($byTotals ? 'LEFT JOIN folder_totals totals ON totals.path_hash = md.path_hash' : '') . "
             WHERE md.root_id = :root_id
               AND md.id <> :current_id
               AND {$scope}
               AND md.deleted_at IS NULL
               AND " . self::directorySearchCondition() . "
             ORDER BY {$order}
             LIMIT :row_limit OFFSET :row_offset"
        );
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        $statement->bindValue(':current_id', (int) $directory['id'], PDO::PARAM_INT);
        if ($recursive) {
            $prefix = (string) $directory['relative_path'];
            $statement->bindValue(
                ':scope_prefix',
                $prefix === '' ? '%' : self::escapeLike($prefix) . '/%',
                PDO::PARAM_STR
            );
        } else {
            $statement->bindValue(':parent_hash', (string) $directory['path_hash'], PDO::PARAM_LOB);
        }
        if ($sort === 'random') {
            $statement->bindValue(':random_seed', $randomSeed, PDO::PARAM_STR);
        }
        if ($byTotals) {
            $statement->bindValue(':totals_root', (int) $directory['root_id'], PDO::PARAM_INT);
        }
        self::bindSearch($statement, $query);
        $statement->bindValue(':row_limit', $limit, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', $offset, PDO::PARAM_INT);
        $statement->execute();
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Which files a folder's rating and plays are counted over: what the
     * library is about — tracks under a music root, films under a film root,
     * both under a mixed one. (The cards counted tracks only, so every film
     * folder showed no rating while the sort beside it ordered by one.)
     */
    private static function libraryKindSql(string $rootKind, string $alias = 'mi'): string
    {
        return match ($rootKind) {
            'music' => "{$alias}.media_kind = 'audio'",
            'movies' => "{$alias}.media_kind = 'video'",
            default => "{$alias}.media_kind IN ('audio', 'video')",
        };
    }

    /**
     * `WITH … folder_totals (path_hash, amount, entries)`: for every folder of
     * one root that has any, the ratings (sum and count) or the plays (sum) of
     * the files in it and in every folder below it.
     *
     * Counted where the facts are and carried upwards: the ratings (or play
     * totals) are grouped by the folder their file sits in, and each of those
     * rows then climbs `parent_path_hash` to the root — a few indexed look-ups
     * per folder that has anything, instead of a walk of the root per folder
     * on the page. Hashes all the way, so no folder name is compared and none
     * can be mistaken for its neighbour. Binds `:totals_root`.
     */
    private static function folderTotalsSql(string $rootKind, bool $plays): string
    {
        $kinds = self::libraryKindSql($rootKind);
        $facts = $plays
            ? "SELECT mi.root_id, mi.directory_hash AS path_hash,
                      SUM(mpt.play_count) AS amount, COUNT(*) AS entries
                 FROM media_play_totals mpt
                 INNER JOIN media_items mi ON mi.id = mpt.media_item_id"
            : "SELECT mi.root_id, mi.directory_hash AS path_hash,
                      SUM(ur.rating) AS amount, COUNT(ur.rating) AS entries
                 FROM user_ratings ur
                 INNER JOIN media_items mi ON mi.id = ur.media_item_id AND ur.rating IS NOT NULL";
        return "WITH RECURSIVE folder_direct AS (
                  {$facts}
                  WHERE mi.root_id = :totals_root
                    AND mi.deleted_at IS NULL
                    AND mi.catalog_status = 'ready'
                    AND mi.directory_hash IS NOT NULL
                    AND {$kinds}
                  GROUP BY mi.root_id, mi.directory_hash
                ),
                folder_climb (root_id, path_hash, amount, entries, steps) AS (
                  SELECT root_id, path_hash, amount, entries, 0 FROM folder_direct
                  UNION ALL
                  SELECT climb.root_id, parent.parent_path_hash, climb.amount, climb.entries, climb.steps + 1
                    FROM folder_climb climb
                    INNER JOIN media_directories parent
                            ON parent.root_id = climb.root_id AND parent.path_hash = climb.path_hash
                   WHERE parent.parent_path_hash IS NOT NULL AND climb.steps < 64
                ),
                folder_totals AS (
                  SELECT path_hash, SUM(amount) AS amount, SUM(entries) AS entries
                    FROM folder_climb
                   GROUP BY path_hash
                )
                ";
    }

    /** @param array<int, array<string, mixed>> $directories
     * @return array<int, array<string, mixed>>
     */
    private function withDirectoryPreviews(array $directories): array
    {
        if ($directories === []) {
            return [];
        }
        $selects = [];
        foreach ($directories as $index => $directory) {
            $kindFilter = self::effectiveKind($directory) === 'music'
                ? "mi.media_kind = 'audio'"
                : "mi.media_kind IN ('image', 'video')";
            $kindOrder = self::effectiveKind($directory) === 'movies'
                ? "CASE mi.media_kind WHEN 'image' THEN 0 ELSE 1 END,"
                : '';
            $selects[] =
                "(SELECT :candidate_directory_{$index} AS directory_id,
                         mi.id AS media_item_id,
                         mi.media_kind
                  FROM media_items mi
                  WHERE mi.root_id = :candidate_root_{$index}
                    AND {$kindFilter}
                    AND mi.deleted_at IS NULL
                    AND mi.catalog_status = 'ready'
                    AND " . self::subtreeSql('mi', "_candidate_{$index}") . "
                  ORDER BY {$kindOrder} mi.id
                  LIMIT 16)";
        }
        $statement = $this->database->prepare(implode(' UNION ALL ', $selects));
        foreach ($directories as $index => $directory) {
            $statement->bindValue(":candidate_directory_{$index}", (int) $directory['id'], PDO::PARAM_INT);
            $statement->bindValue(":candidate_root_{$index}", (int) $directory['root_id'], PDO::PARAM_INT);
            self::bindSubtree($statement, (string) $directory['relative_path'], "_candidate_{$index}");
        }
        $statement->execute();
        $candidates = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $directoryId = (int) $row['directory_id'];
            $candidates[$directoryId][] = [
                'id' => (int) $row['media_item_id'],
                'kind' => (string) $row['media_kind'],
            ];
        }
        foreach ($directories as &$directory) {
            $directoryId = (int) $directory['id'];
            $directory['preview_candidates'] = $candidates[$directoryId] ?? [];
            $fallbackId = $directory['preview_media_item_id'] === null
                ? null
                : (int) $directory['preview_media_item_id'];
            $fallbackKind = is_string($directory['preview_kind'] ?? null)
                ? $directory['preview_kind']
                : null;
            if ($fallbackId !== null && $fallbackKind !== null) {
                $known = array_column($directory['preview_candidates'], 'id');
                if (!in_array($fallbackId, $known, true)) {
                    $directory['preview_candidates'][] = ['id' => $fallbackId, 'kind' => $fallbackKind];
                }
            }
        }
        unset($directory);
        return $directories;
    }
    private function withDirectoryRatings(array $directories): array
    {
        if ($directories === []) {
            return [];
        }
        // One listing is one root: the folder that is open and what it holds.
        // The same totals the "by rating" order reads, so a card and its place
        // in the order can never disagree.
        $first = $directories[array_key_first($directories)];
        $statement = $this->database->prepare(
            self::folderTotalsSql(self::effectiveKind($first), false)
            . 'SELECT path_hash, amount, entries FROM folder_totals'
        );
        $statement->bindValue(':totals_root', (int) $first['root_id'], PDO::PARAM_INT);
        $statement->execute();
        $ratings = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $entries = (int) $row['entries'];
            $ratings[(string) $row['path_hash']] = [
                'avg_rating' => $entries > 0 ? round((float) $row['amount'] / $entries, 1) : 0.0,
                'rating_count' => $entries,
            ];
        }
        foreach ($directories as &$directory) {
            $rating = $ratings[(string) $directory['path_hash']] ?? ['avg_rating' => 0.0, 'rating_count' => 0];
            $directory['avg_rating'] = $rating['avg_rating'];
            $directory['rating_count'] = $rating['rating_count'];
        }
        unset($directory);
        return $directories;
    }

    /** @param array<string, mixed> $directory
     * @return array<int, array<string, mixed>>
     */
    private function items(
        LegacyIdentity $identity,
        array $directory,
        string $query,
        int $offset,
        int $limit,
        string $sort,
        array $filters = []
    ): array {
        [$where, $subtree] = self::itemScopeSql($query, $filters);
        $where .= self::mixedSourceSql($directory);
        $kindOrder = self::effectiveKind($directory) === 'movies'
            ? "CASE mi.media_kind WHEN 'video' THEN 0 WHEN 'image' THEN 1 WHEN 'audio' THEN 2 ELSE 3 END"
            : "CASE mi.media_kind WHEN 'audio' THEN 0 WHEN 'video' THEN 1 WHEN 'image' THEN 2 ELSE 3 END";
        $itemOrder = match ($sort) {
            'title_desc' => 'COALESCE(mo.title, mi.title) DESC, mi.relative_path DESC',
            'plays_desc' => 'COALESCE(mpt.play_count, 0) DESC, COALESCE(mo.title, mi.title)',
            'rating_desc' => 'COALESCE(ra.avg_rating, 0) DESC, COALESCE(mo.title, mi.title)',
            'rating_count_desc' => 'COALESCE(ra.rating_count, 0) DESC, COALESCE(mo.title, mi.title)',
            'size_desc' => 'mi.size_bytes DESC, COALESCE(mo.title, mi.title)',
            // Files with no known length go last either way, so an unprobed film
            // never claims to be the shortest in the library.
            'duration_desc' => 'mi.duration_ms IS NULL, mi.duration_ms DESC, COALESCE(mo.title, mi.title)',
            'duration_asc' => 'mi.duration_ms IS NULL, mi.duration_ms ASC, COALESCE(mo.title, mi.title)',
            default => 'COALESCE(mo.title, mi.title), mi.relative_path',
        };
        $statement = $this->database->prepare(
            self::itemSelect() .
            " WHERE mi.root_id = :root_id
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND {$where}
              ORDER BY {$kindOrder}, {$itemOrder}
              LIMIT :row_limit OFFSET :row_offset"
        );
        self::bindIdentity($statement, $identity);
        $statement->bindValue(':root_id', (int) $directory['root_id'], PDO::PARAM_INT);
        self::bindItemScope($statement, $directory, $subtree);
        if ($query !== '') {
            self::bindSearch($statement, $query);
        }
        self::bindFilters($statement, $filters);
        $statement->bindValue(':row_limit', $limit, PDO::PARAM_INT);
        $statement->bindValue(':row_offset', $offset, PDO::PARAM_INT);
        $statement->execute();
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * @param string $extraColumns further expressions to select alongside the item,
     *                             for callers that carry a per-row fact of their own
     */
    private static function itemSelect(string $extraColumns = ''): string
    {
        $extra = $extraColumns === '' ? '' : ",\n                       " . $extraColumns;
        return 'SELECT ' . self::ITEM_COLUMNS . "{$extra}
                FROM media_items mi
                LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                LEFT JOIN user_ratings ur ON ur.media_item_id = mi.id AND ur.user_id = :rating_user_id
                LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = :playback_user_id
                LEFT JOIN media_play_totals mpt ON mpt.media_item_id = mi.id
                LEFT JOIN (
                  SELECT media_item_id, AVG(rating) AS avg_rating, COUNT(rating) AS rating_count,
                         SUM(favorite) AS favorite_count
                  FROM user_ratings
                  GROUP BY media_item_id
                ) ra ON ra.media_item_id = mi.id";
    }

    private static function bindIdentity(\PDOStatement $statement, LegacyIdentity $identity): void
    {
        $statement->bindValue(':rating_user_id', $identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':playback_user_id', $identity->userId, PDO::PARAM_INT);
    }

    /** @param array<string, mixed> $directory
     * @return array<int, array<string, int|string>>
     */
    private function breadcrumbs(array $directory): array
    {
        $rows = [];
        $current = $directory;
        for ($guard = 0; $guard < 64; $guard++) {
            $rows[] = [
                'id' => (int) $current['id'],
                'name' => (string) (($current['relative_path'] ?? '') === '' ? $current['root_name'] : $current['name']),
            ];
            if ($current['parent_path_hash'] === null) {
                break;
            }
            $statement = $this->database->prepare(
                'SELECT md.*, mr.display_name AS root_name
                 FROM media_directories md
                 INNER JOIN media_roots mr ON mr.id = md.root_id
                 WHERE md.root_id = :root_id AND md.path_hash = :path_hash AND md.deleted_at IS NULL
                 LIMIT 1'
            );
            $statement->bindValue(':root_id', (int) $current['root_id'], PDO::PARAM_INT);
            $statement->bindValue(':path_hash', (string) $current['parent_path_hash'], PDO::PARAM_LOB);
            $statement->execute();
            $parent = $statement->fetch(PDO::FETCH_ASSOC);
            if (!is_array($parent)) {
                break;
            }
            $current = $parent;
        }
        return array_reverse($rows);
    }

    /** @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function publicDirectory(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'name' => (string) (($row['relative_path'] ?? '') === '' ? ($row['root_name'] ?? $row['name']) : $row['name']),
            'relative_path' => (string) $row['relative_path'],
            'direct_file_count' => (int) $row['direct_file_count'],
            'descendant_file_count' => (int) $row['descendant_file_count'],
            'total_size_bytes' => (int) $row['total_size_bytes'],
            'preview_media_item_id' => $row['preview_media_item_id'] === null ? null : (int) $row['preview_media_item_id'],
            'preview_kind' => is_string($row['preview_kind'] ?? null) ? $row['preview_kind'] : null,
            'preview_candidates' => is_array($row['preview_candidates'] ?? null) ? $row['preview_candidates'] : [],
            'avg_rating' => round((float) ($row['avg_rating'] ?? 0), 1),
            'rating_count' => (int) ($row['rating_count'] ?? 0),
        ];
    }

    /** A saved position counts from 2 % to 95 % of the film — the start page's "Kontynuuj" rule (HomeShelves). */
    public const PROGRESS_FLOOR = 0.02;
    public const PROGRESS_CEILING = 0.95;

    /**
     * Where this account left each film of a listing, for the line on its card.
     *
     * The video items it has a saved position for, between PROGRESS_FLOOR and
     * PROGRESS_CEILING of their length, gain `position_ms` and `progress` (0–1,
     * rounded as the start page rounds it); every other item is left as it was
     * — absent, not null, so the card draws a line only where there is one.
     * One primary-key lookup for the page's films; a guest has no positions.
     *
     * @param list<array<string, mixed>> $items items as publicItem() draws them
     * @return list<array<string, mixed>>
     */
    public static function withSavedPositions(PDO $database, LegacyIdentity $identity, array $items): array
    {
        if ($identity->isGuest) {
            return $items;
        }
        $ids = [];
        foreach ($items as $item) {
            if (($item['media_kind'] ?? '') === 'video' && (int) ($item['duration_ms'] ?? 0) > 0) {
                $ids[] = (int) $item['id'];
            }
        }
        if ($ids === []) {
            return $items;
        }
        $statement = $database->prepare(
            'SELECT media_item_id, last_position_ms FROM playback_stats
              WHERE user_id = ? AND media_item_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')
                AND last_position_ms > 0'
        );
        $statement->execute([$identity->userId, ...$ids]);
        $positions = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $positions[(int) $row['media_item_id']] = (int) $row['last_position_ms'];
        }
        foreach ($items as $index => $item) {
            $position = $positions[(int) ($item['id'] ?? 0)] ?? 0;
            $duration = (int) ($item['duration_ms'] ?? 0);
            if ($position <= 0 || $duration <= 0
                || $position < $duration * self::PROGRESS_FLOOR || $position > $duration * self::PROGRESS_CEILING) {
                continue;
            }
            $items[$index]['position_ms'] = $position;
            $items[$index]['progress'] = round($position / $duration, 3);
        }
        return $items;
    }

    /**
     * A row selected with ITEM_COLUMNS as the item the interface draws.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function publicItem(array $row): array
    {
        $path = is_string($row['relative_path'] ?? null) ? $row['relative_path'] : '';
        $title = is_string($row['title'] ?? null) && trim($row['title']) !== ''
            ? trim($row['title'])
            : basename(str_replace('\\', '/', $path));
        return [
            'id' => (int) $row['id'],
            'relative_path' => $path,
            'media_kind' => (string) $row['media_kind'],
            'mime_type' => is_string($row['mime_type'] ?? null) ? $row['mime_type'] : null,
            'file_extension' => is_string($row['file_extension'] ?? null) ? $row['file_extension'] : null,
            'title' => $title,
            'artist' => self::optionalString($row['artist'] ?? null),
            'album' => self::optionalString($row['album'] ?? null),
            'year' => self::optionalString($row['year'] ?? null),
            'genre' => self::optionalString($row['genre'] ?? null),
            'duration_ms' => $row['duration_ms'] === null ? null : (int) $row['duration_ms'],
            'size_bytes' => $row['size_bytes'] === null ? null : (int) $row['size_bytes'],
            'bitrate' => $row['bitrate'] === null ? null : (int) $row['bitrate'],
            'sample_rate' => $row['sample_rate'] === null ? null : (int) $row['sample_rate'],
            'channels' => $row['channels'] === null ? null : (int) $row['channels'],
            'favorite' => (int) ($row['favorite'] ?? 0) === 1,
            'rating' => $row['rating'] === null ? null : (float) $row['rating'],
            'play_count' => (int) ($row['play_count'] ?? 0),
            'avg_rating' => round((float) ($row['avg_rating'] ?? 0), 1),
            'rating_count' => (int) ($row['rating_count'] ?? 0),
            'favorite_count' => (int) ($row['favorite_count'] ?? 0),
            // Filled by the ffprobe pass; null until a film has been probed.
            'video_width' => isset($row['video_width']) ? (int) $row['video_width'] : null,
            'video_height' => isset($row['video_height']) ? (int) $row['video_height'] : null,
            'video_codec' => self::optionalString($row['video_codec'] ?? null),
            'audio_codec' => self::optionalString($row['audio_codec'] ?? null),
            'is_hdr' => (int) ($row['is_hdr'] ?? 0) === 1,
            // Everything ffprobe found, for the "technical details" panel; the
            // columns above are the part worth querying and sorting on.
            'probe' => self::probeDetails($row['metadata_json'] ?? null),
        ];
    }

    /**
     * The ffprobe result, trimmed to what a viewer panel can show.
     *
     * Bit depth is read off the pixel format (yuv420p10le is ten bits) because
     * ffprobe reports it nowhere else; anything missing is simply absent rather
     * than guessed.
     *
     * @return array<string, mixed>|null
     */
    private static function probeDetails(mixed $metadataJson): ?array
    {
        if (!is_string($metadataJson) || $metadataJson === '') {
            return null;
        }
        $decoded = json_decode($metadataJson, true);
        $video = is_array($decoded) ? ($decoded['video'] ?? null) : null;
        if (!is_array($video)) {
            return null;
        }
        $details = [];
        foreach (
            ['container', 'video_codec', 'video_profile', 'video_bitrate', 'pixel_format',
             'color_space', 'color_transfer', 'frame_rate',
             'audio_codec', 'audio_channels', 'sample_rate', 'bitrate', 'hdr',
             'subtitle_languages', 'subtitle_streams', 'audio_streams',
             // Probe schema 2 and later: every selectable track, not only the first.
             'audio_tracks', 'subtitle_tracks'] as $key
        ) {
            if (array_key_exists($key, $video)) {
                $details[$key] = $video[$key];
            }
        }
        $pixelFormat = is_string($video['pixel_format'] ?? null) ? $video['pixel_format'] : '';
        if (preg_match('/(\d{1,2})(?:le|be)$/D', $pixelFormat, $matches) === 1) {
            $details['bit_depth'] = (int) $matches[1];
        } elseif ($pixelFormat !== '') {
            $details['bit_depth'] = 8;
        }
        return $details === [] ? null : $details;
    }

    private static function assertKind(string $kind): void
    {
        if (!in_array($kind, ['music', 'movies'], true)) {
            throw new BridgeRequestException('Nieprawidłowy rodzaj biblioteki.');
        }
    }

    private static function cleanQuery(string $query): string
    {
        $query = trim($query);
        if (strlen($query) > 191 || preg_match('//u', $query) !== 1 || preg_match('/[\x00-\x1F\x7F]/u', $query) === 1) {
            throw new BridgeRequestException('Nieprawidłowe wyszukiwanie.');
        }
        return $query;
    }

    private static function escapeLike(string $value): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);
    }

    /**
     * The files of a folder and of everything below it, as one index range.
     *
     * A file directly in `Dir` has the path `Dir/name`, so the prefix `Dir/%`
     * covers the folder's own files together with its subfolders' (the root's
     * prefix is `%`). The condition used to read `directory_hash = ? OR
     * relative_path LIKE ?`: the first arm added nothing, and the OR kept MySQL
     * off the (root_id, relative_path) index — it walked the primary key or the
     * whole root instead, once per folder card of a listing (a page of 100
     * folders: 0.9–1.4 s against 30 ms for the prefix alone, same rows).
     *
     * The second comparison is the same pattern read byte for byte. The
     * column's collation ignores case and accents, which is right for a search
     * and wrong for a path: `Cafe/%` also matched what lies in `Café`, so one
     * folder's queue, archive and guest link reached into its neighbour. The
     * first comparison finds the range, the second keeps what is really there.
     */
    private static function subtreeSql(string $alias = 'mi', string $suffix = ''): string
    {
        return "({$alias}.relative_path LIKE :path_prefix{$suffix} ESCAPE '\\\\'"
            . " AND {$alias}.relative_path LIKE :path_exact{$suffix} COLLATE utf8mb4_bin ESCAPE '\\\\')";
    }

    private static function bindSubtree(PDOStatement $statement, string $relativePath, string $suffix = ''): void
    {
        $pattern = $relativePath === '' ? '%' : self::escapeLike($relativePath) . '/%';
        $statement->bindValue(":path_prefix{$suffix}", $pattern, PDO::PARAM_STR);
        $statement->bindValue(":path_exact{$suffix}", $pattern, PDO::PARAM_STR);
    }

    /**
     * What {@see itemScopeSql()} asked for: the subtree, or the folder's own files.
     *
     * @param array<string, mixed> $directory
     */
    private static function bindItemScope(PDOStatement $statement, array $directory, bool $subtree): void
    {
        if ($subtree) {
            self::bindSubtree($statement, (string) $directory['relative_path']);
            return;
        }
        $statement->bindValue(':directory_hash', (string) $directory['path_hash'], PDO::PARAM_LOB);
    }

    /**
     * Fold the separators that file names use into plain spaces.
     *
     * Library names mix "_", "-" and "." where a person types a space, so a
     * literal match for "You Are" never reaches "104-atomic_kitten-you_are".
     * Both the column and the typed query pass through the same folding, which
     * also keeps "_" from acting as a single-character LIKE wildcard.
     */
    private static function searchable(string $expression): string
    {
        return "LOWER(REPLACE(REPLACE(REPLACE(REPLACE({$expression}, '_', ' '), '-', ' '), '.', ' '), '/', ' '))";
    }

    private static function normalisedQuery(string $query): string
    {
        $folded = str_replace(['_', '-', '.', '/'], ' ', mb_strtolower($query, 'UTF-8'));
        return trim((string) preg_replace('/\s+/u', ' ', $folded));
    }

    /** @return array<int, string> */
    private static function queryTokens(string $query): array
    {
        $normalised = self::normalisedQuery($query);
        if ($normalised === '') {
            return [];
        }
        return array_slice(array_values(array_filter(explode(' ', $normalised), static fn (string $t): bool => $t !== '')), 0, self::SEARCH_TOKEN_SLOTS);
    }

    /**
     * Match the whole phrase, or every token in any order for looser queries.
     * Unused token slots are bound to "%" so one prepared statement serves any
     * query length. Native prepared statements forbid reusing a placeholder,
     * so a statement that searches two tables gives each condition its own
     * `$suffix`. `$folded` says the expression is already lower-cased with its
     * separators turned into spaces (a stored `search_text`).
     */
    private static function searchCondition(string $haystackExpression, string $suffix = '', bool $folded = false): string
    {
        $haystack = $folded ? $haystackExpression : self::searchable($haystackExpression);
        $tokens = [];
        for ($slot = 0; $slot < self::SEARCH_TOKEN_SLOTS; $slot++) {
            $tokens[] = "{$haystack} LIKE :search{$suffix}_tok{$slot} ESCAPE '\\\\'";
        }
        return "(:search{$suffix}_empty = 1
                 OR {$haystack} LIKE :search{$suffix}_phrase ESCAPE '\\\\'
                 OR (" . implode(' AND ', $tokens) . '))';
    }

    /**
     * Everything a media row can be found by: name, folder path and tags.
     *
     * Both halves are stored already folded (`search_text`, migration 053): the
     * file's own title, path, artist, album, genre and year, and — where a
     * person corrected them — the corrected ones. Reading both means a file is
     * found by its corrected tags and still by the ones it came with. The
     * statement must join `media_metadata_overrides mo`.
     */
    private static function itemSearchCondition(string $suffix = ''): string
    {
        return self::searchCondition("CONCAT_WS(' ', mi.search_text, mo.search_text)", $suffix, true);
    }

    private static function directorySearchCondition(string $alias = 'md', string $suffix = ''): string
    {
        return self::searchCondition("CONCAT_WS(' ', {$alias}.name, {$alias}.relative_path)", $suffix);
    }

    private static function bindSearch(PDOStatement $statement, string $query, string $suffix = ''): void
    {
        $tokens = self::queryTokens($query);
        $normalised = self::normalisedQuery($query);
        $statement->bindValue(":search{$suffix}_empty", $normalised === '' ? 1 : 0, PDO::PARAM_INT);
        $statement->bindValue(
            ":search{$suffix}_phrase",
            $normalised === '' ? '%' : '%' . self::escapeLike($normalised) . '%',
            PDO::PARAM_STR
        );
        for ($slot = 0; $slot < self::SEARCH_TOKEN_SLOTS; $slot++) {
            $token = $tokens[$slot] ?? null;
            $statement->bindValue(
                ":search{$suffix}_tok" . $slot,
                $token === null ? '%' : '%' . self::escapeLike($token) . '%',
                PDO::PARAM_STR
            );
        }
    }

    private static function optionalString(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : null;
    }
}
