<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use PDO;

require_once __DIR__ . '/BridgeException.php';
require_once __DIR__ . '/BridgeTime.php';
require_once __DIR__ . '/EpisodeOrder.php';
require_once __DIR__ . '/LegacyIdentity.php';
require_once __DIR__ . '/LibraryBrowser.php';

/**
 * The start page: what to carry on with, what is new, and what might be worth
 * an evening.
 *
 * One answer for the whole page (`GET ?action=home`), because the page draws
 * all of it at once and the shelves lean on each other — a recommendation that
 * is already waiting under "continue" is noise, so the later shelves leave out
 * what the earlier ones show.
 *
 * Every shelf is built in two steps. First it *picks*: a short list of file
 * ids with the one fact the shelf is about (where it was left, when it
 * arrived, why it is suggested), read through the narrowest index that
 * answers the question. Then every picked file of every shelf is read **once**
 * (cards()) into the item the rest of the interface draws, together with what
 * a card needs beyond it — its folder, a second cover to fall back on, and for
 * a film the title and genres the catalogue matched.
 *
 * What the account may open decides what it is shown: a library its group
 * lacks contributes no card, no count and no "surprise".
 *
 * Suggestions can be declined (`home_dismissals`, migration 050): a dismissed
 * file or folder is left out of every shelf of suggestions from then on. The
 * "continue" shelves keep their own, older switch
 * (`playback_stats.continue_hidden_at`), because "I am done with this" is a
 * statement about a title, not about a suggestion.
 *
 * Three shelves are simply chance, for somebody who wants to press play and not
 * choose: a dozen films, a dozen series (each with the episode this account
 * would start from) and a dozen tracks. They are decided by a seed — the
 * account's seed of the day unless the page sends another — so the same seed
 * shows the same dozen, and a new seed is a new draw. Nothing sorts a library
 * by a random number to produce them: films and series are drawn from lists
 * remembered for everybody (pools()), and tracks, which are too many to list,
 * by probing an index at points the seed names (randomTrackPicks()).
 */
final class HomeShelves
{
    public const SHELVES = [
        'continue_movies', 'continue_music', 'next_episodes', 'recent_movies', 'recent_music',
        'recommended_movies', 'recommended_music', 'popular',
        'random_films', 'random_series', 'random_tracks',
    ];
    /** The shelves that are a draw: they carry the seed they were drawn with. */
    public const RANDOM_SHELVES = ['random_films', 'random_series', 'random_tracks'];
    public const DEFAULT_LIMIT = 12;
    public const MAX_LIMIT = 24;
    public const MAX_SHELF_LIMIT = 60;

    /** The same bounds the old "continue" shelf uses (LibraryBrowser). */
    private const CONTINUE_FLOOR = 0.02;
    private const CONTINUE_CEILING = 0.95;
    private const LONG_FORM_MS = 600000;
    /** A film, as opposed to a clip, a trailer or an extra from the disc. */
    private const FEATURE_MS = 2400000;
    private const RECENT_DAYS = 90;
    private const RECENT_COUNT_DAYS = 30;
    /** How many of the newest files "recently added" reads before it groups them. */
    private const RECENT_SCAN_ROWS = 3000;
    private const POPULAR_DAYS = 30;
    /** A folder that reads as an album: enough tracks to be one, few enough not to be a dump. */
    private const ALBUM_MIN_TRACKS = 3;
    private const ALBUM_MAX_TRACKS = 80;
    private const GENRES_PER_CARD = 3;
    /** A track, as opposed to a skit or a jingle; anything from LONG_FORM_MS up is a recording, not a track. */
    private const TRACK_MIN_MS = 60000;
    /** Drawn beyond what is shown, for what the remembered lists still name and the catalogue no longer has. */
    private const RANDOM_SPARE = 3;
    /** The most index probes one draw of tracks makes. */
    private const TRACK_PROBES = 200;
    /** Up to this many files, a music library's tracks are simply listed and drawn from evenly. */
    private const TRACK_LISTING = 2000;
    /** Nobody declines this many suggestions by hand; past it, "reset" is the answer. */
    private const MAX_DISMISSALS = 2000;

    /** @var array{music:bool,movies:bool} */
    private array $access;
    private string $daySeed;
    /** @var array<string, array<int, true>> what the account declined, by kind (read once) */
    private array $dismissed = [];
    /** @var array{albums:list<int>,films:list<int>,series:array<int,array{0:int,1:int,2:int}>,tracks:array<int,int>}|null */
    private ?array $pools = null;

    /**
     * @param array{music:bool,movies:bool} $access libraries the caller may open
     *        (CatalogActions::accessibleLibraries)
     */
    public function __construct(
        private readonly PDO $database,
        private readonly LibraryBrowser $library,
        private readonly LegacyIdentity $identity,
        array $access
    ) {
        $this->access = [
            'music' => ($access['music'] ?? false) === true,
            'movies' => ($access['movies'] ?? false) === true,
        ];
        // Suggestions keep still for a day: going back to the start page must
        // not reshuffle it, and tomorrow may offer something else.
        $this->daySeed = hash('crc32b', $identity->userId . '|' . gmdate('Y-m-d'));
    }

    /**
     * The whole page, one shelf of it, or a re-rolled "surprise".
     *
     * @return array<string, mixed>
     */
    public function page(int $limit, ?string $shelf, ?string $seed): array
    {
        $ceiling = $shelf === null ? self::MAX_LIMIT : self::MAX_SHELF_LIMIT;
        if ($limit < 1 || $limit > $ceiling) {
            throw new BridgeRequestException('Nieprawidłowy limit półki.');
        }
        if ($shelf !== null && $shelf !== 'surprise' && !in_array($shelf, self::SHELVES, true)) {
            throw new BridgeRequestException('Nieznana półka.');
        }
        if ($seed !== null && preg_match('/\A[A-Za-z0-9_-]{8,64}\z/D', $seed) !== 1) {
            throw new BridgeRequestException('Nieprawidłowe ziarno losowania.');
        }
        $home = [
            'generated_at' => BridgeTime::now(),
            'can_dismiss' => !$this->identity->isGuest,
            'dismissed_count' => $this->dismissedCount(),
        ];
        $wanted = match ($shelf) {
            null => self::SHELVES,
            'surprise' => [],
            default => [$shelf],
        };
        // One seed for everything that is drawn: the page's own, or the account's for the day.
        $drawSeed = $seed ?? 'day-' . $this->daySeed;
        $picks = $this->picks($wanted, $limit, $drawSeed);
        $surprise = $shelf === null || $shelf === 'surprise' ? $this->surprisePicks($drawSeed) : null;

        // Every file of every shelf, read once.
        $ids = [];
        foreach ($picks as $shelfPicks) {
            foreach ($shelfPicks as $pick) {
                $ids[$pick['id']] = true;
            }
        }
        foreach (['album', 'film'] as $slot) {
            if (isset($surprise[$slot])) {
                $ids[$surprise[$slot]['id']] = true;
            }
        }
        $cards = $this->cards(array_keys($ids));

        if ($shelf !== 'surprise') {
            $shelves = [];
            foreach ($wanted as $name) {
                $built = [];
                foreach ($picks[$name] as $pick) {
                    $card = self::card($pick, $cards);
                    if ($card !== null) {
                        $built[] = $card;
                    }
                }
                $shelves[$name] = ['cards' => array_slice($built, 0, $limit), 'has_more' => count($built) > $limit]
                    + (in_array($name, self::RANDOM_SHELVES, true) ? ['seed' => $drawSeed] : []);
            }
            $home['shelves'] = $shelves;
            if ($shelf === null) {
                $home['libraries'] = $this->libraries();
                $home['hero'] = self::hero($shelves);
            }
        }
        if ($surprise !== null) {
            $home['surprise'] = [
                'seed' => $drawSeed,
                'album' => isset($surprise['album']) ? self::card($surprise['album'], $cards) : null,
                'film' => isset($surprise['film']) ? self::card($surprise['film'], $cards) : null,
            ];
        }
        return $home;
    }

    /**
     * "Nie proponuj" — and its undo, and forgetting all of them.
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function dismiss(array $payload): array
    {
        if ($this->identity->isGuest) {
            // A guest account is one login shared by many: what one visitor
            // declines must not disappear for the next.
            throw new BridgeAuthorizationException('Konto gościa nie zapisuje ukrytych propozycji.');
        }
        if (($payload['reset'] ?? false) === true) {
            $this->database->prepare('DELETE FROM home_dismissals WHERE user_id = :user_id')
                ->execute(['user_id' => $this->identity->userId]);
            return ['success' => true, 'dismissed_count' => 0];
        }
        $key = $payload['key'] ?? null;
        $hidden = $payload['hidden'] ?? true;
        if (!is_string($key) || !is_bool($hidden)
            || preg_match('/\A(item|folder):([1-9][0-9]{0,17})\z/D', $key, $parts) !== 1) {
            throw new BridgeRequestException('Nieprawidłowa propozycja.');
        }
        $kind = $parts[1];
        $id = (int) $parts[2];
        // Only something the account could have been shown: otherwise this
        // would be a way to ask "does file 123 exist?" about a library the
        // group does not open.
        if (!$this->reachable($kind, $id)) {
            throw new BridgeRequestException('Nieprawidłowa propozycja.');
        }
        if ($hidden) {
            if ($this->dismissedCount() >= self::MAX_DISMISSALS) {
                throw new BridgeRequestException('Lista ukrytych propozycji jest pełna. Przywróć ukryte propozycje i spróbuj ponownie.');
            }
            $this->database->prepare(
                'INSERT IGNORE INTO home_dismissals (user_id, subject_kind, subject_id)
                 VALUES (:user_id, :kind, :id)'
            )->execute(['user_id' => $this->identity->userId, 'kind' => $kind, 'id' => $id]);
        } else {
            $this->database->prepare(
                'DELETE FROM home_dismissals WHERE user_id = :user_id AND subject_kind = :kind AND subject_id = :id'
            )->execute(['user_id' => $this->identity->userId, 'kind' => $kind, 'id' => $id]);
        }
        $this->dismissed = [];
        return ['success' => true, 'hidden' => $hidden, 'dismissed_count' => $this->dismissedCount()];
    }

    /** Whether a file or a folder is one this account's libraries hold. */
    private function reachable(string $kind, int $id): bool
    {
        if ($kind === 'item') {
            $statement = $this->database->prepare(
                "SELECT mr.media_kind AS root_kind, mi.media_kind
                   FROM media_items mi
                   INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                  WHERE mi.id = :id AND mi.deleted_at IS NULL
                  LIMIT 1"
            );
            $statement->execute(['id' => $id]);
            $row = $statement->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                return false;
            }
            // The same reading as librarySql(): a library is a source's audio or its video.
            return match ($row['media_kind']) {
                'audio' => $this->access['music'] && in_array($row['root_kind'], ['music', 'mixed'], true),
                'video' => $this->access['movies'] && in_array($row['root_kind'], ['movies', 'mixed'], true),
                default => false,
            };
        }
        $statement = $this->database->prepare(
            'SELECT mr.media_kind
               FROM media_directories md
               INNER JOIN media_roots mr ON mr.id = md.root_id AND mr.is_enabled = 1
              WHERE md.id = :id AND md.deleted_at IS NULL
              LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        return match ($statement->fetchColumn()) {
            'music' => $this->access['music'],
            'movies' => $this->access['movies'],
            'mixed' => $this->access['music'] || $this->access['movies'],
            default => false,
        };
    }

    // -- picking -------------------------------------------------------------------------------

    /**
     * What goes on each wanted shelf, as picks (`id` and the shelf's own facts).
     * One more than `limit` where there may be more, so `has_more` is known.
     *
     * @param list<string> $wanted
     * @return array<string, list<array<string, mixed>>>
     */
    private function picks(array $wanted, int $limit, string $drawSeed): array
    {
        $guest = $this->identity->isGuest;
        $picks = array_fill_keys($wanted, []);
        $want = static fn (string $name): bool => in_array($name, $wanted, true);
        // A guest's playback is not recorded, so there is nothing to continue,
        // nothing to learn from and nobody to compare with.
        if (!$guest) {
            if ($want('continue_movies') && $this->access['movies']) {
                $picks['continue_movies'] = $this->continuePicks('movies', $limit);
            }
            if ($want('continue_music') && $this->access['music']) {
                $picks['continue_music'] = $this->continuePicks('music', $limit);
            }
            if ($want('next_episodes') && $this->access['movies']) {
                $picks['next_episodes'] = $this->library->nextEpisodePicks(
                    $this->identity,
                    $limit,
                    $this->dismissedIds('item'),
                    $this->daySeed
                );
            }
        }
        if ($want('recent_movies') && $this->access['movies']) {
            $picks['recent_movies'] = $this->recentMoviePicks($limit);
        }
        if ($want('recent_music') && $this->access['music']) {
            $picks['recent_music'] = $this->recentMusicPicks($limit);
        }
        if (!$guest) {
            // What is already waiting above is not suggested again below. (Asked
            // for alone, a shelf of suggestions has nothing above it to compare
            // with; what the account has begun is left out of it either way,
            // because a suggestion is by definition something never played.)
            $shown = [];
            foreach (['continue_movies', 'continue_music', 'next_episodes'] as $earlier) {
                foreach ($picks[$earlier] ?? [] as $pick) {
                    $shown[$pick['id']] = true;
                }
            }
            if ($want('recommended_movies') && $this->access['movies']) {
                $picks['recommended_movies'] = $this->recommendedMoviePicks($limit, $shown);
            }
            if ($want('recommended_music') && $this->access['music']) {
                $picks['recommended_music'] = $this->recommendedMusicPicks($limit, $shown);
            }
            if ($want('popular')) {
                $picks['popular'] = $this->popularPicks($limit);
            }
        }
        // Chance is nobody's history, so a guest account gets these too.
        if ($want('random_films') && $this->access['movies']) {
            $picks['random_films'] = $this->randomFilmPicks($limit, $drawSeed);
        }
        if ($want('random_series') && $this->access['movies']) {
            $picks['random_series'] = $this->randomSeriesPicks($limit, $drawSeed);
        }
        if ($want('random_tracks') && $this->access['music']) {
            $picks['random_tracks'] = $this->randomTrackPicks($limit, $drawSeed);
        }
        return $picks;
    }

    // -- chance --------------------------------------------------------------------------------

    /**
     * Films as the seed draws them: every film has the same chance.
     *
     * A film the account has watched is not left out — the item says how often
     * it was played — but one it declined is.
     *
     * @return list<array<string, mixed>>
     */
    private function randomFilmPicks(int $limit, string $seed): array
    {
        $order = self::drawOrder($this->pools()['films'], $seed . '-films-', $this->dismissedIds('item'));
        return array_map(
            static fn (int $id): array => ['id' => $id],
            array_slice($order, 0, $limit + 1 + self::RANDOM_SPARE)
        );
    }

    /**
     * Series as the seed draws them, each with the episode this account would start from.
     *
     * A series is a work the catalogue files episodes under, matched or not.
     * Where the account starts is a walk along the running order: nothing
     * opened — the first episode; the furthest one opened left unfinished —
     * that one, from where it was left; finished — the one after it; and after
     * the last episode, the first again.
     *
     * Most series drawn are ones the account has never opened, and for those
     * everything is already known: the first episode and the counts are kept
     * with the list (pools()). Which of the drawn series it *has* opened is
     * asked of the index alone, and only those have their episodes read — a
     * series of twelve hundred episodes was otherwise read whole for one card.
     *
     * @return list<array<string, mixed>>
     */
    private function randomSeriesPicks(int $limit, string $seed): array
    {
        $known = $this->pools()['series'];
        $order = self::drawOrder(array_keys($known), $seed . '-series-', $this->declinedSeries());
        $drawn = array_slice($order, 0, $limit + 1 + self::RANDOM_SPARE);
        if ($drawn === []) {
            return [];
        }
        $marks = implode(', ', array_fill(0, count($drawn), '?'));
        $works = $this->database->prepare(
            "SELECT tl.id, tl.root_id, tl.subject_hash, tl.status, tl.matched_title, tl.query_title,
                    tl.matched_year, tl.query_year
               FROM media_title_lookups tl
               INNER JOIN media_roots mr
                       ON mr.id = tl.root_id AND mr.is_enabled = 1 AND mr.media_kind IN ('movies', 'mixed')
              WHERE tl.is_episode = 1 AND tl.id IN ({$marks})"
        );
        $works->execute($drawn);
        $series = [];
        foreach ($works->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $series[(int) $row['id']] = $row + ['episodes' => []];
        }
        if ($series === []) {
            return [];
        }
        // A guest's playback is not recorded: every series starts at its beginning.
        $opened = $this->identity->isGuest ? [] : $this->openedAmong($series);
        if ($opened !== []) {
            $conditions = [];
            $bySubject = [];
            foreach ($opened as $id) {
                $bySubject[(int) $series[$id]['root_id'] . ':' . $series[$id]['subject_hash']] = $id;
                $conditions[] = '(mi.root_id = ? AND mi.title_subject_hash = ?)';
            }
            $episodes = $this->database->prepare(
                "SELECT mi.id, mi.root_id, mi.title_subject_hash, mi.relative_path, mi.duration_ms,
                        ps.play_count, ps.last_position_ms, ps.last_played_at
                   FROM media_items mi
                   LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = ?
                  WHERE mi.media_kind = 'video' AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready'
                    AND (" . implode(' OR ', $conditions) . ')'
            );
            $position = 1;
            $episodes->bindValue($position++, $this->identity->userId, PDO::PARAM_INT);
            foreach ($opened as $id) {
                $episodes->bindValue($position++, (int) $series[$id]['root_id'], PDO::PARAM_INT);
                $episodes->bindValue($position++, (string) $series[$id]['subject_hash'], PDO::PARAM_LOB);
            }
            $episodes->execute();
            foreach ($episodes->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $id = $bySubject[(int) $row['root_id'] . ':' . $row['title_subject_hash']] ?? null;
                if ($id !== null) {
                    $series[$id]['episodes'][] = $row;
                }
            }
        }
        $picks = [];
        foreach ($drawn as $id) {
            if (!isset($series[$id])) {
                continue;
            }
            if ($series[$id]['episodes'] !== []) {
                $pick = self::seriesStart($series[$id]);
            } else {
                [$first, $episodeCount, $seasonCount] = $known[$id];
                $pick = [
                    'id' => $first,
                    'series' => self::seriesFacts($series[$id], $episodeCount, $seasonCount, 'first', null),
                ];
            }
            if ($pick !== null) {
                $picks[] = $pick;
            }
        }
        return $picks;
    }

    /**
     * Which of these series the account has opened an episode of.
     *
     * Asked of the index alone — the series' file ids against the account's
     * play history — so nothing of the wide catalogue rows is read. A file that
     * has left the catalogue since counts too; the worst that does is a full
     * reading of a series that turns out to start at its beginning.
     *
     * @param array<int, array<string, mixed>> $series rows of `media_title_lookups` by id
     * @return list<int> their ids
     */
    private function openedAmong(array $series): array
    {
        $bySubject = [];
        $conditions = [];
        foreach ($series as $id => $row) {
            $bySubject[(int) $row['root_id'] . ':' . $row['subject_hash']] = $id;
            $conditions[] = '(mi.root_id = ? AND mi.title_subject_hash = ?)';
        }
        $statement = $this->database->prepare(
            'SELECT mi.root_id, mi.title_subject_hash
               FROM media_items mi
               INNER JOIN playback_stats ps
                       ON ps.media_item_id = mi.id AND ps.user_id = ? AND ps.last_played_at IS NOT NULL
              WHERE ' . implode(' OR ', $conditions) . '
              GROUP BY mi.root_id, mi.title_subject_hash'
        );
        $position = 1;
        $statement->bindValue($position++, $this->identity->userId, PDO::PARAM_INT);
        foreach ($series as $row) {
            $statement->bindValue($position++, (int) $row['root_id'], PDO::PARAM_INT);
            $statement->bindValue($position++, (string) $row['subject_hash'], PDO::PARAM_LOB);
        }
        $statement->execute();
        $opened = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $id = $bySubject[(int) $row['root_id'] . ':' . $row['title_subject_hash']] ?? null;
            if ($id !== null) {
                $opened[] = $id;
            }
        }
        return $opened;
    }

    /**
     * One drawn series as a pick: its episode to start from, and what the card says about the whole.
     *
     * @param array<string, mixed> $series a row of `media_title_lookups` with its `episodes`
     * @return array<string, mixed>|null null for a series that has no playable episode left
     */
    private static function seriesStart(array $series): ?array
    {
        if ($series['episodes'] === []) {
            return null;
        }
        [$episodes, $seasonCount] = self::runningOrder($series['episodes']);
        // The furthest episode the account has opened, if any.
        $furthest = null;
        foreach ($episodes as $index => $episode) {
            if ($episode['last_played_at'] !== null) {
                $furthest = $index;
            }
        }
        $start = 'first';
        $chosen = 0;
        $resume = null;
        if ($furthest !== null) {
            $episode = $episodes[$furthest];
            $position = (int) ($episode['last_position_ms'] ?? 0);
            $duration = (int) ($episode['duration_ms'] ?? 0);
            // Finished as everywhere: reported complete (which zeroes the position) or left in the credits.
            $finished = ((int) ($episode['play_count'] ?? 0) > 0 && $position === 0)
                || ($duration > 0 && $position > $duration * self::CONTINUE_CEILING);
            if (!$finished) {
                [$start, $chosen, $resume] = ['resume', $furthest, $position];
            } elseif (isset($episodes[$furthest + 1])) {
                [$start, $chosen] = ['next', $furthest + 1];
            } else {
                $start = 'again';
            }
        }
        return [
            'id' => (int) $episodes[$chosen]['id'],
            'series' => self::seriesFacts($series, count($episodes), $seasonCount, $start, $resume),
        ];
    }

    /**
     * Episodes in the order they are watched, and how many seasons their names speak of.
     *
     * The order is the player's own (EpisodeOrder), so the episode a card starts
     * from is the one the "next episode" panel would have led to.
     *
     * @param list<array<string, mixed>> $episodes rows carrying `relative_path`
     * @return array{0:list<array<string, mixed>>,1:int}
     */
    private static function runningOrder(array $episodes): array
    {
        $seasons = [];
        foreach ($episodes as $index => $episode) {
            $parsed = EpisodeOrder::parse((string) $episode['relative_path']);
            $episodes[$index]['rank'] = $parsed === null ? PHP_INT_MAX : EpisodeOrder::rank($parsed);
            if ($parsed !== null && $parsed['season'] > 0) {
                $seasons[$parsed['season']] = true;
            }
        }
        usort($episodes, static fn (array $a, array $b): int => [$a['rank'], (string) $a['relative_path']]
            <=> [$b['rank'], (string) $b['relative_path']]);
        return [$episodes, count($seasons)];
    }

    /**
     * What a card says about the series as a whole.
     *
     * @param array<string, mixed> $series a row of `media_title_lookups`
     * @return array<string, mixed>
     */
    private static function seriesFacts(array $series, int $episodes, int $seasons, string $start, ?int $resume): array
    {
        $matched = $series['status'] === 'matched';
        $title = $matched && is_string($series['matched_title']) && $series['matched_title'] !== ''
            ? $series['matched_title']
            : (string) $series['query_title'];
        $year = $matched && $series['matched_year'] !== null ? $series['matched_year'] : $series['query_year'];
        return [
            'id' => (int) $series['id'],
            'title' => $title,
            'year' => $year === null ? null : (int) $year,
            'episode_count' => $episodes,
            'season_count' => $seasons,
            'start' => $start,
            'resume_ms' => $resume,
        ];
    }

    /**
     * The series the account declined: those an episode of which it dismissed.
     *
     * @return array<int, true> lookup ids
     */
    private function declinedSeries(): array
    {
        if ($this->dismissedIds('item') === []) {
            return [];
        }
        $statement = $this->database->prepare(
            "SELECT DISTINCT tl.id
               FROM home_dismissals hd
               INNER JOIN media_items mi ON mi.id = hd.subject_id
               INNER JOIN media_title_lookups tl
                       ON tl.root_id = mi.root_id AND tl.subject_hash = mi.title_subject_hash AND tl.is_episode = 1
              WHERE hd.user_id = :user_id AND hd.subject_kind = 'item'"
        );
        $statement->execute(['user_id' => $this->identity->userId]);
        return array_fill_keys(array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN)), true);
    }

    /**
     * Tracks as the seed draws them — without listing the tracks.
     *
     * A library holds too many to keep a list of, and sorting them all by a
     * random number for a dozen rows is the one thing a start page must not do.
     * Every file already has a number that is as good as random: the hash of its
     * path, which the catalogue keeps indexed per source. So the seed names a
     * few dozen points on that line, and each point is answered by the first
     * track at or after it — one short index range per point, whatever the size
     * of the library. Sources share the points by how many files each holds.
     *
     * Not perfectly even: a track after a wide gap between hashes is likelier
     * than one after a narrow gap. Which tracks those are is itself chance, and
     * none is left out — a fair price for a draw that costs the same in a
     * library of ten thousand tracks and of a million.
     *
     * A small library does not pay that price: where a few points would keep
     * naming the same handful of tracks, the tracks are simply listed (a short
     * read) and drawn from like films, every one with the same chance.
     *
     * @return list<array<string, mixed>>
     */
    private function randomTrackPicks(int $limit, string $seed): array
    {
        $sources = $this->pools()['tracks'];
        $total = array_sum($sources);
        if ($total < 1) {
            return [];
        }
        $declined = $this->dismissedIds('item');
        $wanted = $limit + 1 + self::RANDOM_SPARE;
        if ($total <= self::TRACK_LISTING) {
            $marks = implode(', ', array_fill(0, count($sources), '?'));
            $listing = $this->database->prepare(
                "SELECT mi.id
                   FROM media_items mi
                  WHERE mi.root_id IN ({$marks})
                    AND mi.media_kind = 'audio' AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready'
                    AND mi.duration_ms >= " . self::TRACK_MIN_MS . ' AND mi.duration_ms < ' . self::LONG_FORM_MS . '
                  ORDER BY mi.id'
            );
            $listing->execute(array_keys($sources));
            $order = self::drawOrder(
                array_map('intval', $listing->fetchAll(PDO::FETCH_COLUMN)),
                $seed . '-tracks-',
                $declined
            );
            return array_map(static fn (int $id): array => ['id' => $id], array_slice($order, 0, $wanted));
        }
        // A quarter more than is wanted: two points may fall into one gap and name the same track.
        $probes = min(self::TRACK_PROBES, $wanted + max(4, intdiv($wanted, 4)));
        $selects = [];
        $binds = [];
        for ($probe = 0; $probe < $probes; $probe++) {
            $share = unpack('N', md5($seed . '-source-' . $probe, true))[1] % $total;
            $sourceId = 0;
            foreach ($sources as $sourceId => $count) {
                if ($share < $count) {
                    break;
                }
                $share -= $count;
            }
            // The index is named: left to choose, the optimiser may prefer a plan
            // that sorts every track of the source to find the first one.
            $selects[] = "(SELECT {$probe} AS probe, mi.id
                             FROM media_items mi FORCE INDEX (uq_media_items_root_path)
                            WHERE mi.root_id = ? AND mi.path_hash >= ?
                              AND mi.media_kind = 'audio' AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready'
                              AND mi.duration_ms >= " . self::TRACK_MIN_MS . ' AND mi.duration_ms < ' . self::LONG_FORM_MS . '
                            ORDER BY mi.path_hash
                            LIMIT 1)';
            $binds[] = [(int) $sourceId, hash('sha256', $seed . '-track-' . $probe, true)];
        }
        $statement = $this->database->prepare(implode(' UNION ALL ', $selects));
        $position = 1;
        foreach ($binds as [$sourceId, $point]) {
            $statement->bindValue($position++, $sourceId, PDO::PARAM_INT);
            $statement->bindValue($position++, $point, PDO::PARAM_LOB);
        }
        $statement->execute();
        $found = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $found[(int) $row['probe']] = (int) $row['id'];
        }
        ksort($found);
        $picks = [];
        $taken = [];
        foreach ($found as $id) {
            if (isset($taken[$id]) || isset($declined[$id])) {
                continue;
            }
            $taken[$id] = true;
            $picks[] = ['id' => $id];
            if (count($picks) >= $wanted) {
                break;
            }
        }
        return $picks;
    }

    /**
     * Files of one library left part-way, newest first; for music the long
     * recordings come before the songs (a set stopped half-way is unfinished
     * business, a song stopped half-way mostly is not).
     *
     * @return list<array<string, mixed>>
     */
    private function continuePicks(string $library, int $limit): array
    {
        $order = $library === 'music'
            ? '(mi.duration_ms >= ' . self::LONG_FORM_MS . ') DESC, ps.last_played_at DESC'
            : 'ps.last_played_at DESC';
        $statement = $this->database->prepare(
            "SELECT mi.id, mi.duration_ms, ps.last_position_ms, UNIX_TIMESTAMP(ps.last_played_at) AS played_unix
               FROM playback_stats ps
               INNER JOIN media_items mi ON mi.id = ps.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
              WHERE ps.user_id = :user_id
                AND ps.last_played_at IS NOT NULL
                AND ps.continue_hidden_at IS NULL
                -- Said again below by the 2 % floor; said here because this
                -- half needs no look at the catalogue, and nine plays in ten
                -- were heard to the end (position 0).
                AND ps.last_position_ms > 0
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND " . self::librarySql($library) . "
                AND mi.duration_ms > 0
                AND ps.last_position_ms >= mi.duration_ms * :floor
                AND ps.last_position_ms <= mi.duration_ms * :ceiling
              ORDER BY {$order}, mi.id DESC
              LIMIT :row_limit"
        );
        $statement->bindValue(':user_id', $this->identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':floor', self::CONTINUE_FLOOR);
        $statement->bindValue(':ceiling', self::CONTINUE_CEILING);
        $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
        $statement->execute();
        return array_map(static function (array $row) use ($library): array {
            $duration = (int) $row['duration_ms'];
            $position = (int) $row['last_position_ms'];
            return [
                'id' => (int) $row['id'],
                'position_ms' => $position,
                'progress' => round($position / $duration, 3),
                'remaining_ms' => max(0, $duration - $position),
                'last_played_at' => BridgeTime::iso($row['played_unix']),
            ] + ($library === 'music' ? ['long_form' => $duration >= self::LONG_FORM_MS] : []);
        }, $statement->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Music that arrived lately, an album (a folder) at a time. A file loose
     * at the top of the library is nobody's album and is offered as itself.
     *
     * @return list<array<string, mixed>>
     */
    private function recentMusicPicks(int $limit): array
    {
        $declinedFolders = $this->dismissedIds('folder');
        $declinedItems = $this->dismissedIds('item');
        $statement = $this->database->prepare(
            "SELECT mi.root_id, mi.directory_hash, (md.parent_path_hash IS NULL) AS at_top,
                    COUNT(*) AS added_count,
                    UNIX_TIMESTAMP(MAX(mi.created_at)) AS added_unix,
                    SUBSTRING_INDEX(GROUP_CONCAT(mi.id ORDER BY mi.relative_path SEPARATOR ','), ',', 1) AS first_id
               FROM media_items mi
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               LEFT JOIN media_directories md
                      ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE " . self::librarySql('music') . "
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND mi.created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL " . self::RECENT_DAYS . " DAY)
              GROUP BY mi.root_id, mi.directory_hash, md.parent_path_hash,
                       CASE WHEN md.parent_path_hash IS NULL THEN mi.id ELSE 0 END
              ORDER BY MAX(mi.created_at) DESC, MAX(mi.id) DESC
              LIMIT :row_limit"
        );
        // Enough to fill the shelf even if everything declined so far were at the front.
        $statement->bindValue(
            ':row_limit',
            $limit + 1 + min(400, count($declinedFolders) + count($declinedItems)),
            PDO::PARAM_INT
        );
        $statement->execute();
        $picks = [];
        // The folders are looked up a batch at a time, and only as far as the
        // shelf still has room: usually that is the first batch.
        foreach (array_chunk($statement->fetchAll(PDO::FETCH_ASSOC), 30) as $batch) {
            $pairs = [];
            foreach ($batch as $row) {
                if ((int) $row['at_top'] === 0) {
                    $pairs[] = [(int) $row['root_id'], (string) $row['directory_hash']];
                }
            }
            $folders = [];
            foreach ($this->folderFacts($pairs, 'music') as $folder) {
                $folders[$folder['pair']] = $folder;
            }
            foreach ($batch as $row) {
                $itemId = (int) $row['first_id'];
                $folder = (int) $row['at_top'] === 0
                    ? ($folders[(int) $row['root_id'] . ':' . $row['directory_hash']] ?? null)
                    : null;
                // One file in a folder of its own is offered as itself too.
                $asFolder = $folder !== null && $folder['item_count'] > 1;
                if ($asFolder ? isset($declinedFolders[$folder['id']]) : isset($declinedItems[$itemId])) {
                    continue;
                }
                $picks[] = [
                    'id' => $itemId,
                    'added_at' => BridgeTime::iso($row['added_unix']),
                    'added_count' => (int) $row['added_count'],
                ] + ($asFolder ? ['folder' => $folder] : []);
                if (count($picks) > $limit) {
                    break 2;
                }
            }
        }
        return $picks;
    }

    /**
     * Films that arrived lately. Several new episodes in one folder are one
     * card — a season that came together is one piece of news, not ten.
     *
     * @return list<array<string, mixed>>
     */
    private function recentMoviePicks(int $limit): array
    {
        $declinedFolders = $this->dismissedIds('folder');
        $declinedItems = $this->dismissedIds('item');
        $statement = $this->database->prepare(
            "SELECT mi.id, mi.root_id, mi.directory_hash, mi.relative_path,
                    md.id AS directory_id, (md.parent_path_hash IS NULL) AS at_top,
                    UNIX_TIMESTAMP(mi.created_at) AS added_unix
               FROM media_items mi
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               LEFT JOIN media_directories md
                      ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
              WHERE " . self::librarySql('movies') . "
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND mi.created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL " . self::RECENT_DAYS . ' DAY)
              ORDER BY mi.created_at DESC, mi.id DESC
              LIMIT ' . self::RECENT_SCAN_ROWS
        );
        $statement->execute();
        // By folder. Films loose at the top of the library share no folder
        // worth the name, so each of those stands alone.
        $byFolder = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $alone = $row['directory_id'] === null || (int) $row['at_top'] === 1;
            $byFolder[$alone ? 'item:' . $row['id'] : 'folder:' . $row['directory_id']][] = $row;
        }
        $picks = [];
        foreach ($byFolder as $rows) {
            $names = array_map(static fn (array $row): string => (string) $row['relative_path'], $rows);
            if (count($rows) < 2 || EpisodeOrder::scheme($names) === null) {
                foreach ($rows as $row) {
                    $picks[] = [
                        'id' => (int) $row['id'],
                        'added_unix' => (float) $row['added_unix'],
                        'newest_id' => (int) $row['id'],
                        'added_count' => 1,
                    ];
                }
                continue;
            }
            // The card starts where the viewer would: at the earliest of the new episodes.
            $first = null;
            $firstKey = null;
            foreach ($rows as $row) {
                $parsed = EpisodeOrder::parse((string) $row['relative_path']);
                $key = [$parsed === null ? PHP_INT_MAX : EpisodeOrder::rank($parsed), (string) $row['relative_path']];
                if ($firstKey === null || $key < $firstKey) {
                    $firstKey = $key;
                    $first = $row;
                }
            }
            $picks[] = [
                'id' => (int) $first['id'],
                'added_unix' => max(array_map(static fn (array $row): float => (float) $row['added_unix'], $rows)),
                'newest_id' => max(array_map(static fn (array $row): int => (int) $row['id'], $rows)),
                'added_count' => count($rows),
                'directory' => [(int) $first['directory_id'], (int) $first['root_id'], (string) $first['directory_hash']],
            ];
        }
        usort($picks, static fn (array $a, array $b): int => [$b['added_unix'], $b['newest_id']] <=> [$a['added_unix'], $a['newest_id']]);
        $kept = [];
        foreach ($picks as $pick) {
            $declined = isset($pick['directory'])
                ? isset($declinedFolders[$pick['directory'][0]])
                : isset($declinedItems[$pick['id']]);
            if ($declined) {
                continue;
            }
            $kept[] = $pick;
            if (count($kept) > $limit) {
                break;
            }
        }
        $folders = [];
        $pairs = [];
        foreach ($kept as $pick) {
            if (isset($pick['directory'])) {
                $pairs[] = [$pick['directory'][1], $pick['directory'][2]];
            }
        }
        foreach ($this->folderFacts($pairs, 'movies') as $folder) {
            $folders[$folder['id']] = $folder;
        }
        return array_map(static function (array $pick) use ($folders): array {
            $folder = isset($pick['directory']) ? ($folders[$pick['directory'][0]] ?? null) : null;
            return [
                'id' => $pick['id'],
                'added_at' => BridgeTime::iso($pick['added_unix']),
                'added_count' => $pick['added_count'],
            ] + ($folder !== null ? ['folder' => $folder] : []);
        }, $kept);
    }

    /**
     * Unplayed tracks by the artists — then in the genres — of what the
     * account marked favourite or rated four stars and up.
     *
     * @param array<int, true> $shown ids already on an earlier shelf
     * @return list<array<string, mixed>>
     */
    private function recommendedMusicPicks(int $limit, array $shown): array
    {
        $liked = $this->database->prepare(
            "SELECT mi.artist AS label, COUNT(*) AS liked
               FROM user_ratings ur
               INNER JOIN media_items mi ON mi.id = ur.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
              WHERE ur.user_id = :user_id
                AND (ur.favorite = 1 OR ur.rating >= 4)
                AND " . self::librarySql('music') . "
                AND mi.deleted_at IS NULL
                AND mi.artist IS NOT NULL AND mi.artist <> ''
              GROUP BY mi.artist
              ORDER BY liked DESC, mi.artist
              LIMIT 40"
        );
        $liked->execute(['user_id' => $this->identity->userId]);
        $artists = array_map(static fn (array $row): string => (string) $row['label'], $liked->fetchAll(PDO::FETCH_ASSOC));
        $picks = [];
        if ($artists !== []) {
            // Which liked artist a track answers is the database's call
            // (FIELD), by the same collation that grouped them above: to it
            // "Abba" and "ABBA" are one artist, to PHP two.
            $marks = implode(', ', array_fill(0, count($artists), '?'));
            $candidates = $this->database->prepare(
                "SELECT mi.id, FIELD(mi.artist, {$marks}) AS slot" . self::unheardFrom('music') . "
                    AND mi.artist IN ({$marks})
                  ORDER BY MD5(CONCAT(?, '-', mi.id)), mi.id
                  LIMIT 600"
            );
            $candidates->execute([
                ...$artists,
                $this->identity->userId, $this->identity->userId, $this->identity->userId,
                ...$artists, $this->daySeed,
            ]);
            foreach (self::roundRobin($candidates->fetchAll(PDO::FETCH_ASSOC), count($artists), 2, $limit + 1, $shown) as $pick) {
                $picks[] = [
                    'id' => $pick['id'],
                    'because' => ['type' => 'artist', 'label' => $artists[$pick['slot']], 'label_en' => null],
                ];
            }
        }
        if (count($picks) > $limit) {
            return $picks;
        }
        // Not enough by artist: the genres the liked tracks are tagged with.
        $tag = "JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.genre'))";
        $likedGenres = $this->database->prepare(
            "SELECT {$tag} AS label, COUNT(*) AS liked
               FROM user_ratings ur
               INNER JOIN media_items mi ON mi.id = ur.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
              WHERE ur.user_id = :user_id
                AND (ur.favorite = 1 OR ur.rating >= 4)
                AND " . self::librarySql('music') . "
                AND mi.deleted_at IS NULL
                AND {$tag} IS NOT NULL AND {$tag} <> ''
              GROUP BY label
              ORDER BY liked DESC, label
              LIMIT 5"
        );
        $likedGenres->execute(['user_id' => $this->identity->userId]);
        $genres = array_map(static fn (array $row): string => (string) $row['label'], $likedGenres->fetchAll(PDO::FETCH_ASSOC));
        if ($genres === []) {
            return $picks;
        }
        $marks = implode(', ', array_fill(0, count($genres), '?'));
        $candidates = $this->database->prepare(
            "SELECT mi.id, FIELD({$tag}, {$marks}) AS slot" . self::unheardFrom('music') . "
                AND {$tag} IN ({$marks})
              ORDER BY MD5(CONCAT(?, '-', mi.id)), mi.id
              LIMIT 300"
        );
        $candidates->execute([
            ...$genres,
            $this->identity->userId, $this->identity->userId, $this->identity->userId,
            ...$genres, $this->daySeed,
        ]);
        foreach ($picks as $pick) {
            $shown[$pick['id']] = true;
        }
        $byGenre = self::roundRobin($candidates->fetchAll(PDO::FETCH_ASSOC), count($genres), 3, $limit + 1 - count($picks), $shown);
        foreach ($byGenre as $pick) {
            $picks[] = [
                'id' => $pick['id'],
                'because' => ['type' => 'genre', 'label' => $genres[$pick['slot']], 'label_en' => null],
            ];
        }
        return $picks;
    }

    /**
     * The first unseen episode of a series the account liked an episode of,
     * then unseen films in the genres of the films it liked.
     *
     * @param array<int, true> $shown ids already on an earlier shelf
     * @return list<array<string, mixed>>
     */
    private function recommendedMoviePicks(int $limit, array $shown): array
    {
        $picks = [];
        $series = $this->database->prepare(
            "SELECT mi.root_id, mi.title_subject_hash, COUNT(*) AS liked,
                    MAX(CASE WHEN tl.status = 'matched' AND tl.matched_title IS NOT NULL AND tl.matched_title <> ''
                             THEN tl.matched_title ELSE tl.query_title END) AS label
               FROM user_ratings ur
               INNER JOIN media_items mi ON mi.id = ur.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               INNER JOIN media_title_lookups tl
                       ON tl.root_id = mi.root_id AND tl.subject_hash = mi.title_subject_hash AND tl.is_episode = 1
              WHERE ur.user_id = :user_id
                AND (ur.favorite = 1 OR ur.rating >= 4)
                AND " . self::librarySql('movies') . "
                AND mi.deleted_at IS NULL
                -- declining one suggested episode declines the series
                AND NOT EXISTS (
                      SELECT 1 FROM home_dismissals hd
                       INNER JOIN media_items declined ON declined.id = hd.subject_id
                       WHERE hd.user_id = :declining_user AND hd.subject_kind = 'item'
                         AND declined.root_id = mi.root_id AND declined.title_subject_hash = mi.title_subject_hash)
              GROUP BY mi.root_id, mi.title_subject_hash
              ORDER BY liked DESC, label, mi.root_id, mi.title_subject_hash
              LIMIT 12"
        );
        $series->execute(['user_id' => $this->identity->userId, 'declining_user' => $this->identity->userId]);
        foreach ($series->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $unseen = $this->database->prepare(
                "SELECT mi.id, mi.relative_path
                   FROM media_items mi
                   LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = :user_id
                  WHERE mi.root_id = :root_id AND mi.title_subject_hash = :subject
                    AND mi.media_kind = 'video' AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready'
                    AND ps.media_item_id IS NULL
                  LIMIT 2000"
            );
            $unseen->bindValue(':user_id', $this->identity->userId, PDO::PARAM_INT);
            $unseen->bindValue(':root_id', (int) $row['root_id'], PDO::PARAM_INT);
            $unseen->bindValue(':subject', (string) $row['title_subject_hash'], PDO::PARAM_LOB);
            $unseen->execute();
            $first = null;
            $firstKey = null;
            foreach ($unseen->fetchAll(PDO::FETCH_ASSOC) as $episode) {
                $parsed = EpisodeOrder::parse((string) $episode['relative_path']);
                $key = [$parsed === null ? PHP_INT_MAX : EpisodeOrder::rank($parsed), (string) $episode['relative_path']];
                if ($firstKey === null || $key < $firstKey) {
                    $firstKey = $key;
                    $first = (int) $episode['id'];
                }
            }
            if ($first !== null && !isset($shown[$first])) {
                $shown[$first] = true;
                $picks[] = ['id' => $first, 'because' => ['type' => 'series', 'label' => (string) $row['label'], 'label_en' => null]];
            }
            if (count($picks) > $limit) {
                return $picks;
            }
        }

        $liked = $this->database->prepare(
            "SELECT mg.id, mg.name_pl, mg.name_en, COUNT(*) AS liked
               FROM user_ratings ur
               INNER JOIN media_items mi ON mi.id = ur.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               INNER JOIN media_item_genres mig ON mig.media_item_id = mi.id
               INNER JOIN media_genres mg ON mg.id = mig.genre_id
              WHERE ur.user_id = :user_id
                AND (ur.favorite = 1 OR ur.rating >= 4)
                AND " . self::librarySql('movies') . "
                AND mi.deleted_at IS NULL
              GROUP BY mg.id, mg.name_pl, mg.name_en
              ORDER BY liked DESC, mg.name_pl, mg.id
              LIMIT 6"
        );
        $liked->execute(['user_id' => $this->identity->userId]);
        $genres = [];
        $genreIds = [];
        foreach ($liked->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $genreIds[] = (int) $row['id'];
            $genres[] = ['label' => (string) $row['name_pl'], 'label_en' => (string) $row['name_en']];
        }
        if ($genres === []) {
            return $picks;
        }
        // Whole numbers of our own reading, so they are written into the
        // statement: the same list is needed twice, and FIELD() compares
        // bound parameters as text.
        $idList = implode(', ', $genreIds);
        $candidates = $this->database->prepare(
            "SELECT mi.id, FIELD(mig.genre_id, {$idList}) AS slot" . self::unheardFrom(
                'movies',
                'INNER JOIN media_item_genres mig ON mig.media_item_id = mi.id
                 LEFT JOIN media_title_lookups tl ON tl.root_id = mi.root_id AND tl.subject_hash = mi.title_subject_hash'
            ) . "
                AND mig.genre_id IN ({$idList})
                AND mi.duration_ms >= " . self::FEATURE_MS . "
                AND COALESCE(tl.is_episode, 0) = 0
              ORDER BY MD5(CONCAT(?, '-', mi.id)), mi.id
              LIMIT 400"
        );
        $candidates->execute([
            $this->identity->userId, $this->identity->userId, $this->identity->userId, $this->daySeed,
        ]);
        $byGenre = self::roundRobin($candidates->fetchAll(PDO::FETCH_ASSOC), count($genres), 3, $limit + 1 - count($picks), $shown);
        foreach ($byGenre as $pick) {
            $picks[] = ['id' => $pick['id'], 'because' => ['type' => 'genre'] + $genres[$pick['slot']]];
        }
        return $picks;
    }

    /**
     * What other accounts played lately and this one never opened.
     *
     * @return list<array<string, mixed>>
     */
    private function popularPicks(int $limit): array
    {
        $libraries = [];
        foreach (['music', 'movies'] as $library) {
            if ($this->access[$library]) {
                $libraries[] = self::librarySql($library);
            }
        }
        if ($libraries === []) {
            return [];
        }
        $statement = $this->database->prepare(
            'SELECT mi.id, recent.listeners
               FROM (
                 SELECT ps.media_item_id, COUNT(DISTINCT ps.user_id) AS listeners
                   FROM playback_stats ps
                  WHERE ps.last_played_at >= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL ' . self::POPULAR_DAYS . ' DAY)
                    AND ps.user_id <> :other_than
                  GROUP BY ps.media_item_id
               ) recent
               INNER JOIN media_items mi ON mi.id = recent.media_item_id
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               LEFT JOIN playback_stats own ON own.media_item_id = mi.id AND own.user_id = :user_id
               LEFT JOIN media_play_totals mpt ON mpt.media_item_id = mi.id
               LEFT JOIN home_dismissals hd
                      ON hd.user_id = :declining_user AND hd.subject_kind = \'item\' AND hd.subject_id = mi.id
              WHERE mi.deleted_at IS NULL
                AND mi.catalog_status = \'ready\'
                AND (' . implode(' OR ', $libraries) . ')
                AND own.last_played_at IS NULL
                AND hd.user_id IS NULL
              ORDER BY recent.listeners DESC, COALESCE(mpt.play_count, 0) DESC, mi.id
              LIMIT :row_limit'
        );
        $statement->bindValue(':other_than', $this->identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':user_id', $this->identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':declining_user', $this->identity->userId, PDO::PARAM_INT);
        $statement->bindValue(':row_limit', $limit + 1, PDO::PARAM_INT);
        $statement->execute();
        return array_map(
            static fn (array $row): array => ['id' => (int) $row['id'], 'listeners' => (int) $row['listeners']],
            $statement->fetchAll(PDO::FETCH_ASSOC)
        );
    }

    /**
     * "Zaskocz mnie": one album and one film, the same for the same seed.
     *
     * Drawn from the lists every account shares (pools()); who is asking
     * decides only what is left out — what they declined, and for the film
     * what they have already seen to the end.
     *
     * @return array{album?:array<string,mixed>,film?:array<string,mixed>}
     */
    private function surprisePicks(string $seed): array
    {
        $picks = [];
        $pool = $this->pools();
        if ($this->access['music']) {
            $order = self::drawOrder($pool['albums'], $seed . '-album-', $this->dismissedIds('folder'));
            // The pool may be a few minutes old: the first few drawn are
            // checked against the catalogue as it is now.
            foreach (array_slice(array_chunk($order, 4), 0, 3) as $drawn) {
                $folders = [];
                foreach ($this->folderFacts($drawn, 'music', true) as $folder) {
                    $folders[$folder['id']] = $folder;
                }
                foreach ($drawn as $id) {
                    $folder = $folders[$id] ?? null;
                    if ($folder !== null && $folder['first_item_id'] !== null
                        && $folder['item_count'] >= self::ALBUM_MIN_TRACKS
                        && $folder['item_count'] <= self::ALBUM_MAX_TRACKS) {
                        $picks['album'] = ['id' => $folder['first_item_id'], 'folder' => $folder];
                        break 2;
                    }
                }
            }
        }
        if ($this->access['movies']) {
            $order = self::drawOrder($pool['films'], $seed . '-film-', $this->dismissedIds('item'));
            foreach (array_slice(array_chunk($order, 24), 0, 3) as $drawn) {
                $marks = implode(', ', array_fill(0, count($drawn), '?'));
                $open = $this->database->prepare(
                    "SELECT mi.id
                       FROM media_items mi
                       INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                       LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = ?
                      WHERE mi.id IN ({$marks})
                        AND mi.deleted_at IS NULL
                        AND mi.catalog_status = 'ready'
                        AND (ps.media_item_id IS NULL OR NOT (
                              (ps.play_count > 0 AND ps.last_position_ms = 0)
                              OR ps.last_position_ms > mi.duration_ms * " . self::CONTINUE_CEILING . '))'
                );
                $open->execute([$this->identity->userId, ...$drawn]);
                $unfinished = array_fill_keys(array_map('intval', $open->fetchAll(PDO::FETCH_COLUMN)), true);
                foreach ($drawn as $id) {
                    if (isset($unfinished[$id])) {
                        $picks['film'] = ['id' => $id];
                        break 2;
                    }
                }
            }
        }
        return $picks;
    }

    /**
     * What chance draws from: every folder that reads as an album, every film
     * of feature length, every series with where it begins and how long it is
     * (`id => [first episode, episodes, seasons]`) — and, for tracks, only how
     * many files each source of the music library holds (the tracks themselves
     * are found by probing, see randomTrackPicks()).
     *
     * The same for every account, and a pass over the whole library to list —
     * so it is listed once and kept until the next scan (remembered()), and
     * read once per request however many shelves draw from it.
     *
     * @return array{albums:list<int>,films:list<int>,series:array<int,array{0:int,1:int,2:int}>,tracks:array<int,int>}
     */
    private function pools(): array
    {
        if ($this->pools !== null) {
            return $this->pools;
        }
        $pool = $this->library->remembered('home:pools:v3', 300, function (): array {
            $albums = $this->database->query(
                "SELECT md.id
                   FROM media_directories md
                   INNER JOIN media_roots mr
                           ON mr.id = md.root_id AND mr.is_enabled = 1 AND mr.media_kind IN ('music', 'mixed')
                   INNER JOIN media_items mi
                           ON mi.root_id = md.root_id AND mi.directory_hash = md.path_hash
                          AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready' AND mi.media_kind = 'audio'
                  WHERE md.deleted_at IS NULL
                    AND md.parent_path_hash IS NOT NULL
                  GROUP BY md.id
                 HAVING COUNT(*) BETWEEN " . self::ALBUM_MIN_TRACKS . ' AND ' . self::ALBUM_MAX_TRACKS . '
                  ORDER BY md.id'
            )->fetchAll(PDO::FETCH_COLUMN);
            $films = [];
            $rows = $this->database->query(
                'SELECT mi.id, mi.relative_path
                   FROM media_items mi
                   INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                   LEFT JOIN media_title_lookups tl
                          ON tl.root_id = mi.root_id AND tl.subject_hash = mi.title_subject_hash
                  WHERE ' . self::librarySql('movies') . "
                    AND mi.deleted_at IS NULL
                    AND mi.catalog_status = 'ready'
                    AND mi.duration_ms >= " . self::FEATURE_MS . '
                    AND COALESCE(tl.is_episode, 0) = 0
                  ORDER BY mi.id'
            );
            foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
                // An episode the catalogue has not recognised as one still says so in its name.
                if (!self::namedEpisode((string) $row['relative_path'])) {
                    $films[] = (int) $row['id'];
                }
            }
            // A series is a work with at least one episode that can be played. Its
            // episodes are put in running order here, once, so that a card for a
            // series nobody has opened needs none of them read again.
            $episodes = $this->database->query(
                "SELECT tl.id AS series_id, mi.id, mi.relative_path
                   FROM media_title_lookups tl
                   INNER JOIN media_roots mr
                           ON mr.id = tl.root_id AND mr.is_enabled = 1 AND mr.media_kind IN ('movies', 'mixed')
                   INNER JOIN media_items mi
                           ON mi.root_id = tl.root_id AND mi.title_subject_hash = tl.subject_hash
                          AND mi.media_kind = 'video' AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready'
                  WHERE tl.is_episode = 1
                  ORDER BY tl.id, mi.id"
            );
            $bySeries = [];
            foreach ($episodes->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $bySeries[(int) $row['series_id']][] = $row;
            }
            $series = [];
            foreach ($bySeries as $id => $rows) {
                [$ordered, $seasons] = self::runningOrder($rows);
                $series[$id] = [(int) $ordered[0]['id'], count($ordered), $seasons];
            }
            // How many files each source of the music library holds, read off its
            // top folder: the share of the track probes each source gets. (Counting
            // the tracks themselves is a pass over every one of them — 129 ms here —
            // for a number that only has to be roughly right.)
            $tracks = [];
            $sources = $this->database->query(
                "SELECT md.root_id, md.descendant_file_count
                   FROM media_directories md
                   INNER JOIN media_roots mr
                           ON mr.id = md.root_id AND mr.is_enabled = 1 AND mr.media_kind IN ('music', 'mixed')
                  WHERE md.parent_path_hash IS NULL AND md.deleted_at IS NULL
                  ORDER BY md.root_id"
            );
            foreach ($sources->fetchAll(PDO::FETCH_ASSOC) as $row) {
                if ((int) $row['descendant_file_count'] > 0) {
                    $tracks[(int) $row['root_id']] = (int) $row['descendant_file_count'];
                }
            }
            return ['albums' => array_map('intval', $albums), 'films' => $films, 'series' => $series, 'tracks' => $tracks];
        });
        $series = [];
        foreach ((array) ($pool['series'] ?? []) as $id => $facts) {
            if (is_array($facts) && count($facts) === 3 && array_is_list($facts) && $facts === array_filter($facts, 'is_int')) {
                $series[(int) $id] = $facts;
            }
        }
        $tracks = [];
        foreach ((array) ($pool['tracks'] ?? []) as $sourceId => $count) {
            if (is_int($count) && $count > 0) {
                $tracks[(int) $sourceId] = $count;
            }
        }
        return $this->pools = [
            'albums' => array_values(array_filter((array) ($pool['albums'] ?? []), 'is_int')),
            'films' => array_values(array_filter((array) ($pool['films'] ?? []), 'is_int')),
            'series' => $series,
            'tracks' => $tracks,
        ];
    }

    /**
     * The ids in the order a seed draws them, without the declined ones.
     *
     * Ordered by a digest of seed and id — not by their CRC, which was the first
     * choice and a wrong one. CRC is linear: the CRC of "seed, id" is a constant
     * of the seed XORed with a function of the id, so every seed orders the ids
     * the same way up to one XOR, and the first dozen under two seeds were
     * either nearly the same dozen or shared nothing (two seeds a character
     * apart shared ten series of twelve). A digest has no such memory: each
     * seed's order is its own.
     *
     * @param list<int> $ids
     * @param array<int, true> $declined
     * @return list<int>
     */
    private static function drawOrder(array $ids, string $salt, array $declined): array
    {
        $weights = [];
        foreach ($ids as $id) {
            if (!isset($declined[$id])) {
                $weights[$id] = md5($salt . $id, true);
            }
        }
        asort($weights, SORT_STRING);
        return array_keys($weights);
    }

    // -- cards ---------------------------------------------------------------------------------

    /**
     * Everything a card shows about a file, for a set of ids, in two statements.
     *
     * @param list<int> $ids
     * @return array<int, array<string, mixed>> by item id
     */
    private function cards(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(', ', array_fill(0, count($ids), '?'));
        $statement = $this->database->prepare(
            'SELECT ' . LibraryBrowser::ITEM_COLUMNS . ",
                    mi.release_year,
                    md.id AS directory_id, md.preview_media_item_id, pmi.media_kind AS preview_kind,
                    tl.status AS lookup_status, tl.matched_title, tl.matched_year, tl.is_episode
               FROM media_items mi
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               LEFT JOIN media_directories md
                      ON md.root_id = mi.root_id AND md.path_hash = mi.directory_hash AND md.deleted_at IS NULL
               LEFT JOIN media_items pmi ON pmi.id = md.preview_media_item_id AND pmi.deleted_at IS NULL
               LEFT JOIN media_title_lookups tl
                      ON tl.root_id = mi.root_id AND tl.subject_hash = mi.title_subject_hash
               LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
               LEFT JOIN user_ratings ur ON ur.media_item_id = mi.id AND ur.user_id = ?
               LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = ?
               LEFT JOIN media_play_totals mpt ON mpt.media_item_id = mi.id
               LEFT JOIN (
                 SELECT media_item_id, AVG(rating) AS avg_rating, COUNT(rating) AS rating_count,
                        SUM(favorite) AS favorite_count
                   FROM user_ratings WHERE media_item_id IN ({$marks}) GROUP BY media_item_id
               ) ra ON ra.media_item_id = mi.id
              WHERE mi.id IN ({$marks})
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'"
        );
        $statement->execute([$this->identity->userId, $this->identity->userId, ...$ids, ...$ids]);
        $rows = [];
        $videos = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rows[(int) $row['id']] = $row;
            if ($row['media_kind'] === 'video') {
                $videos[] = (int) $row['id'];
            }
        }
        $genres = [];
        if ($videos !== []) {
            $videoMarks = implode(', ', array_fill(0, count($videos), '?'));
            $read = $this->database->prepare(
                "SELECT mig.media_item_id, mg.slug, mg.name_pl, mg.name_en
                   FROM media_item_genres mig
                   INNER JOIN media_genres mg ON mg.id = mig.genre_id
                  WHERE mig.media_item_id IN ({$videoMarks})
                  ORDER BY mig.media_item_id, mg.name_pl, mg.id"
            );
            $read->execute($videos);
            foreach ($read->fetchAll(PDO::FETCH_ASSOC) as $genre) {
                $itemId = (int) $genre['media_item_id'];
                if (count($genres[$itemId] ?? []) < self::GENRES_PER_CARD) {
                    $genres[$itemId][] = [
                        'slug' => (string) $genre['slug'],
                        'name_pl' => (string) $genre['name_pl'],
                        'name_en' => (string) $genre['name_en'],
                    ];
                }
            }
        }
        $cards = [];
        foreach ($rows as $id => $row) {
            $isVideo = $row['media_kind'] === 'video';
            $work = null;
            if ($isVideo) {
                // A series is what the catalogue matched as one — or what the
                // file name says outright (S01E02, 1x02), which no film's does
                // by accident, so an unmatched series still reads as a series.
                $isSeries = (int) ($row['is_episode'] ?? 0) === 1 || self::namedEpisode((string) $row['relative_path']);
                $parsed = $isSeries ? EpisodeOrder::parse((string) $row['relative_path']) : null;
                $work = [
                    'title' => $row['lookup_status'] === 'matched' && is_string($row['matched_title']) && $row['matched_title'] !== ''
                        ? $row['matched_title']
                        : null,
                    'year' => $row['release_year'] !== null
                        ? (int) $row['release_year']
                        : ($row['lookup_status'] === 'matched' && $row['matched_year'] !== null ? (int) $row['matched_year'] : null),
                    'is_series' => $isSeries,
                    // Season 0 is how a bare episode number is read: no season is named.
                    'season' => $parsed !== null && $parsed['season'] > 0 ? $parsed['season'] : null,
                    'episode' => $parsed !== null ? $parsed['episode'] : null,
                    'genres' => $genres[$id] ?? [],
                ];
            }
            $covers = [];
            if (in_array($row['media_kind'], ['audio', 'image', 'video'], true)) {
                $covers[] = ['id' => $id, 'kind' => (string) $row['media_kind']];
            }
            if ($row['preview_media_item_id'] !== null && is_string($row['preview_kind'])
                && in_array($row['preview_kind'], ['audio', 'image', 'video'], true)
                && (int) $row['preview_media_item_id'] !== $id) {
                $covers[] = ['id' => (int) $row['preview_media_item_id'], 'kind' => $row['preview_kind']];
            }
            $cards[$id] = [
                'library' => $isVideo ? 'movies' : 'music',
                'item' => LibraryBrowser::publicItem($row),
                'directory_id' => $row['directory_id'] === null ? null : (int) $row['directory_id'],
                'work' => $work,
                'preview_candidates' => $covers,
            ];
        }
        return $cards;
    }

    /** "S01E02" or "1x02" in the file's own name: a season and an episode, spelt out. */
    private static function namedEpisode(string $relativePath): bool
    {
        $parsed = EpisodeOrder::parse($relativePath);
        return $parsed !== null && $parsed['scheme'] === 'explicit' && $parsed['season'] > 0;
    }

    /**
     * One pick as the card the contract describes, or null when its file is
     * gone since it was picked.
     *
     * @param array<string, mixed> $pick
     * @param array<int, array<string, mixed>> $cards
     * @return array<string, mixed>|null
     */
    private static function card(array $pick, array $cards): ?array
    {
        $base = $cards[(int) $pick['id']] ?? null;
        if ($base === null) {
            return null;
        }
        $folder = $pick['folder'] ?? null;
        unset($pick['folder'], $pick['id']);
        $covers = $base['preview_candidates'];
        if ($folder !== null) {
            // An album is drawn with the folder's own picture first.
            $covers = array_reverse($covers);
            unset($folder['first_item_id'], $folder['pair']);
        }
        return [
            'key' => $folder !== null ? 'folder:' . $folder['id'] : 'item:' . $base['item']['id'],
            'type' => $folder !== null ? 'folder' : 'item',
            'library' => $base['library'],
            'item' => $base['item'],
            'directory_id' => $base['directory_id'],
            'folder' => $folder,
            'work' => $base['work'],
            'preview_candidates' => $covers,
        ] + $pick;
    }

    /**
     * What a folder card says about the album or the season: how many files
     * of the library's kind sit directly in it, how long they run together,
     * and — for music — the artist and the year when its tagged tracks agree.
     *
     * @param list<array{0:int,1:string}>|list<int> $folders (source, path hash) pairs, or directory ids
     * @param bool $byId how `$folders` names them
     * @return list<array<string, mixed>> each also carrying `pair` ("source:hash") and `first_item_id`
     */
    private function folderFacts(array $folders, string $library, bool $byId = false): array
    {
        $kind = $library === 'music' ? 'audio' : 'video';
        $artist = "NULLIF(COALESCE(mo.artist, mi.artist), '')";
        $year = "NULLIF(COALESCE(
                    mo.year,
                    JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.audio.year')),
                    JSON_UNQUOTE(JSON_EXTRACT(mi.metadata_json, '$.year'))
                ), '')";
        $facts = [];
        foreach (array_chunk($folders, 40) as $chunk) {
            $condition = $byId
                ? 'md.id IN (' . implode(', ', array_fill(0, count($chunk), '?')) . ')'
                : implode(' OR ', array_fill(0, count($chunk), '(md.root_id = ? AND md.path_hash = ?)'));
            $statement = $this->database->prepare(
                "SELECT md.id, md.root_id, md.path_hash, md.name, md.relative_path, mr.display_name AS root_name,
                        COUNT(mi.id) AS item_count,
                        SUM(mi.duration_ms) AS duration_ms,
                        SUM(mi.id IS NOT NULL AND mi.duration_ms IS NULL) AS unknown_lengths,
                        COUNT(DISTINCT {$artist}) AS artists, MIN({$artist}) AS artist,
                        COUNT(DISTINCT {$year}) AS years, MIN({$year}) AS year,
                        SUBSTRING_INDEX(GROUP_CONCAT(mi.id ORDER BY mi.relative_path SEPARATOR ','), ',', 1) AS first_item_id
                   FROM media_directories md
                   INNER JOIN media_roots mr ON mr.id = md.root_id AND mr.is_enabled = 1
                   LEFT JOIN media_items mi
                          ON mi.root_id = md.root_id AND mi.directory_hash = md.path_hash
                         AND mi.deleted_at IS NULL AND mi.catalog_status = 'ready' AND mi.media_kind = '{$kind}'
                   LEFT JOIN media_metadata_overrides mo ON mo.media_item_id = mi.id
                  WHERE md.deleted_at IS NULL AND ({$condition})
                  GROUP BY md.id, md.root_id, md.path_hash, md.name, md.relative_path, mr.display_name"
            );
            $position = 1;
            foreach ($chunk as $folder) {
                if ($byId) {
                    $statement->bindValue($position++, (int) $folder, PDO::PARAM_INT);
                } else {
                    $statement->bindValue($position++, (int) $folder[0], PDO::PARAM_INT);
                    $statement->bindValue($position++, (string) $folder[1], PDO::PARAM_LOB);
                }
            }
            $statement->execute();
            foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $count = (int) $row['item_count'];
                $facts[] = [
                    'id' => (int) $row['id'],
                    // The top of a source is shown under the source's name, as in browsing.
                    'name' => (string) ($row['relative_path'] === '' ? $row['root_name'] : $row['name']),
                    'relative_path' => (string) $row['relative_path'],
                    'item_count' => $count,
                    'duration_ms' => $count > 0 && (int) $row['unknown_lengths'] === 0 && $row['duration_ms'] !== null
                        ? (int) $row['duration_ms']
                        : null,
                    'artist' => $library === 'music' && (int) $row['artists'] === 1 ? (string) $row['artist'] : null,
                    'year' => $library === 'music' && (int) $row['years'] === 1 ? (string) $row['year'] : null,
                    'first_item_id' => $row['first_item_id'] === null ? null : (int) $row['first_item_id'],
                    'pair' => (int) $row['root_id'] . ':' . $row['path_hash'],
                ];
            }
        }
        return $facts;
    }

    /**
     * How much each library the account may open holds — for the tiles drawn
     * when there is nothing to continue. The same for everybody, so kept
     * (LibraryBrowser::remembered) rather than counted on every visit.
     *
     * @return list<array<string, mixed>>
     */
    private function libraries(): array
    {
        $counted = $this->library->remembered('home:libraries:v1', 300, function (): array {
            $counts = [];
            foreach (['music', 'movies'] as $library) {
                $statement = $this->database->prepare(
                    'SELECT COUNT(*) AS item_count,
                            COUNT(DISTINCT mi.root_id, mi.directory_hash) AS folder_count,
                            SUM(mi.created_at > DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL ' . self::RECENT_COUNT_DAYS . ' DAY)) AS recent_count,
                            SUM(COALESCE(tl.is_episode, 0) = 1) AS episode_count,
                            COUNT(DISTINCT CASE WHEN tl.is_episode = 1 THEN tl.id END) AS series_count
                       FROM media_items mi
                       INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
                       LEFT JOIN media_title_lookups tl
                              ON tl.root_id = mi.root_id AND tl.subject_hash = mi.title_subject_hash
                      WHERE ' . self::librarySql($library) . "
                        AND mi.deleted_at IS NULL
                        AND mi.catalog_status = 'ready'"
                );
                $statement->execute();
                $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];
                $items = (int) ($row['item_count'] ?? 0);
                $episodes = $library === 'movies' ? (int) ($row['episode_count'] ?? 0) : 0;
                $counts[$library] = [
                    'kind' => $library,
                    'item_count' => $items,
                    'folder_count' => (int) ($row['folder_count'] ?? 0),
                    'film_count' => $library === 'movies' ? $items - $episodes : 0,
                    'series_count' => $library === 'movies' ? (int) ($row['series_count'] ?? 0) : 0,
                    'episode_count' => $episodes,
                    'recent_count' => (int) ($row['recent_count'] ?? 0),
                ];
            }
            return $counts;
        });
        $libraries = [];
        foreach (['music', 'movies'] as $library) {
            if ($this->access[$library] && is_array($counted[$library] ?? null)) {
                $libraries[] = $counted[$library];
            }
        }
        return $libraries;
    }

    /**
     * The most recent unfinished film or long recording: the page's headline.
     *
     * @param array<string, array{cards:list<array<string,mixed>>,has_more:bool}> $shelves
     * @return array<string, mixed>|null
     */
    private static function hero(array $shelves): ?array
    {
        $hero = null;
        $candidates = $shelves['continue_movies']['cards'] ?? [];
        foreach ($shelves['continue_music']['cards'] ?? [] as $card) {
            if (($card['long_form'] ?? false) === true) {
                $candidates[] = $card;
            }
        }
        foreach ($candidates as $card) {
            // Both are UTC in one spelling, so the later instant is the later string.
            if ($hero === null || strcmp((string) $card['last_played_at'], (string) $hero['last_played_at']) > 0) {
                $hero = $card;
            }
        }
        return $hero;
    }

    // -- small pieces --------------------------------------------------------------------------

    /**
     * One card per label per round, strongest label first, at most `$perLabel`
     * of each: twelve suggestions "because you like X" for one X is one
     * suggestion made twelve times.
     *
     * @param list<array<string, mixed>> $candidates rows of `id` and `slot`: which label
     *        the row answers, counted from 1 in the labels' order of weight (SQL `FIELD()`)
     * @param int $labels how many labels there are
     * @param array<int, true> $shown ids to leave out
     * @return list<array{id:int,slot:int}> `slot` counted from 0
     */
    private static function roundRobin(array $candidates, int $labels, int $perLabel, int $wanted, array $shown): array
    {
        if ($wanted < 1 || $labels < 1) {
            return [];
        }
        $waiting = array_fill(0, $labels, []);
        foreach ($candidates as $row) {
            $slot = (int) $row['slot'] - 1;
            if (isset($waiting[$slot])) {
                $waiting[$slot][] = (int) $row['id'];
            }
        }
        $picks = [];
        for ($round = 0; $round < $perLabel; $round++) {
            for ($slot = 0; $slot < $labels; $slot++) {
                while ($waiting[$slot] !== []) {
                    $id = array_shift($waiting[$slot]);
                    if (!isset($shown[$id])) {
                        $shown[$id] = true;
                        $picks[] = ['id' => $id, 'slot' => $slot];
                        break;
                    }
                }
                if (count($picks) >= $wanted) {
                    return $picks;
                }
            }
        }
        return $picks;
    }

    /**
     * FROM … WHERE for "files of this library the account has never played,
     * not rated and not declined". Positional: binds the account three times.
     */
    private static function unheardFrom(string $library, string $joins = ''): string
    {
        return "
               FROM media_items mi
               INNER JOIN media_roots mr ON mr.id = mi.root_id AND mr.is_enabled = 1
               {$joins}
               LEFT JOIN playback_stats ps ON ps.media_item_id = mi.id AND ps.user_id = ?
               LEFT JOIN user_ratings own ON own.media_item_id = mi.id AND own.user_id = ?
               LEFT JOIN home_dismissals hd ON hd.user_id = ? AND hd.subject_kind = 'item' AND hd.subject_id = mi.id
              WHERE " . self::librarySql($library) . "
                AND mi.deleted_at IS NULL
                AND mi.catalog_status = 'ready'
                AND ps.media_item_id IS NULL
                AND own.media_item_id IS NULL
                AND hd.user_id IS NULL";
    }

    /** A library is a source: the music side's audio, the film side's video (a mixed source counts for both). */
    private static function librarySql(string $library): string
    {
        return $library === 'movies'
            ? "(mr.media_kind IN ('movies', 'mixed') AND mi.media_kind = 'video')"
            : "(mr.media_kind IN ('music', 'mixed') AND mi.media_kind = 'audio')";
    }

    /** @return array<int, true> ids the account declined, of one kind */
    private function dismissedIds(string $kind): array
    {
        if (!isset($this->dismissed[$kind])) {
            $statement = $this->database->prepare(
                'SELECT subject_id FROM home_dismissals WHERE user_id = :user_id AND subject_kind = :kind'
            );
            $statement->execute(['user_id' => $this->identity->userId, 'kind' => $kind]);
            $this->dismissed[$kind] = array_fill_keys(array_map('intval', $statement->fetchAll(PDO::FETCH_COLUMN)), true);
        }
        return $this->dismissed[$kind];
    }

    private function dismissedCount(): int
    {
        return count($this->dismissedIds('item')) + count($this->dismissedIds('folder'));
    }
}
