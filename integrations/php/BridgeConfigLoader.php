<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use RuntimeException;

// Ładowane tutaj, a nie w punktach wejścia: konfigurację czyta też digest.php
// i testy, a klasa, której loader używa, nie może zależeć od tego, czy ktoś
// pamiętał ją dołączyć.
require_once __DIR__ . '/TrustedProxy.php';

final class BridgeConfigLoader
{
    /** @return array<string, array<string, mixed>> */
    public static function load(string $path): array
    {
        if ($path === '' || !is_file($path)) {
            throw new RuntimeException('Brak prywatnej konfiguracji mostu.');
        }

        if (strtolower((string) pathinfo($path, PATHINFO_EXTENSION)) === 'php') {
            $config = require $path;
            if (!is_array($config)) {
                throw new RuntimeException('Nieprawidłowa konfiguracja mostu.');
            }

            return self::withDefaults($config);
        }

        $source = file_get_contents($path);
        if (!is_string($source)) {
            throw new RuntimeException('Nie można odczytać konfiguracji TOML.');
        }
        $toml = self::parseToml($source);

        $host = self::stringValue($toml, 'database', 'host');
        if (preg_match('/^[A-Za-z0-9._:-]+$/D', $host) !== 1) {
            throw new RuntimeException('Nieprawidłowy host bazy danych.');
        }
        $port = self::portValue($toml['database']['port'] ?? null, 'Nieprawidłowy port bazy danych.');

        $databaseName = self::stringValue($toml, 'database', 'name');
        if (preg_match('/^[A-Za-z0-9_]+$/D', $databaseName) !== 1) {
            throw new RuntimeException('Nieprawidłowa nazwa bazy danych.');
        }

        $transferKey = self::stringValue($toml, 'security', 'transfer_key');
        if (strlen($transferKey) < 32) {
            throw new RuntimeException('Klucz transferowy jest zbyt krótki.');
        }
        $serverPort = self::portValue($toml['server']['port'] ?? 8765, 'Nieprawidłowy port serwera transferowego.');

        return self::withDefaults([
            'database' => [
                'dsn' => "mysql:host={$host};port={$port};dbname={$databaseName};charset=utf8mb4",
                'user' => self::stringValue($toml, 'database', 'user'),
                'password' => self::stringValue($toml, 'database', 'password'),
            ],
            'transfer' => [
                'key' => $transferKey,
                'base_url' => '/media-transfer',
                'internal_url' => "http://127.0.0.1:{$serverPort}",
            ],
            'session' => [
                // Nazwa i wymóg HTTPS są sprawdzane i domyślane w withDefaults(),
                // wspólnie dla obu formatów konfiguracji.
                'name' => $toml['session']['name'] ?? null,
                'require_https' => $toml['session']['require_https'] ?? null,
            ],
            'mail' => [
                'host' => self::optional($toml, 'mail', 'host'),
                'port' => self::optional($toml, 'mail', 'port'),
                'security' => self::optional($toml, 'mail', 'security'),
                'username' => self::optional($toml, 'mail', 'username'),
                'password' => self::optional($toml, 'mail', 'password'),
                'from_address' => self::optional($toml, 'mail', 'from_address'),
                'from_name' => self::optional($toml, 'mail', 'from_name'),
                'spool_path' => self::optional($toml, 'mail', 'spool_path'),
            ],
            'app' => [
                'base_url' => self::optional($toml, 'app', 'base_url'),
            ],
            'proxy' => [
                'trusted' => self::optional($toml, 'proxy', 'trusted'),
            ],
        ]);
    }

    /**
     * Fill in the optional sections identically for the TOML and the PHP-array
     * configuration, so activation mail spools to disk (and links point at the
     * right base URL) regardless of which file format the operator chose.
     *
     * @param array<string, mixed> $config
     * @return array<string, array<string, mixed>>
     */
    private static function withDefaults(array $config): array
    {
        $mail = is_array($config['mail'] ?? null) ? $config['mail'] : [];
        $app = is_array($config['app'] ?? null) ? $config['app'] : [];
        // Both formats end up here, so the cookie name is validated once and
        // defaults the same way whichever file the operator chose.
        $session = is_array($config['session'] ?? null) ? $config['session'] : [];
        $config['session'] = [
            'name' => self::sessionName($session['name'] ?? null),
            'require_https' => (bool) ($session['require_https'] ?? true),
        ];
        // Empty by default: without a named proxy in front of us, X-Forwarded-For
        // is the client's own claim and is never read.
        $proxy = is_array($config['proxy'] ?? null) ? $config['proxy'] : [];
        $config['proxy'] = ['trusted' => TrustedProxy::parseList($proxy['trusted'] ?? null)];
        $mailPort = $mail['port'] ?? null;
        $projectRoot = dirname(__DIR__, 2);
        $spoolPath = self::nonEmptyString($mail['spool_path'] ?? null);
        if ($spoolPath !== null && !self::isAbsolutePath($spoolPath)) {
            // Relative like the Python-side caches: anchored to the project tree, not CWD.
            $spoolPath = $projectRoot . DIRECTORY_SEPARATOR . $spoolPath;
        }
        $config['mail'] = [
            'host' => self::nonEmptyString($mail['host'] ?? null),
            'port' => is_int($mailPort) || (is_string($mailPort) && $mailPort !== '') ? (int) $mailPort : 587,
            'security' => self::nonEmptyString($mail['security'] ?? null) ?? 'starttls',
            'username' => self::nonEmptyString($mail['username'] ?? null),
            'password' => self::nonEmptyString($mail['password'] ?? null),
            'from_address' => self::nonEmptyString($mail['from_address'] ?? null) ?? 'no-reply@localhost',
            'from_name' => self::nonEmptyString($mail['from_name'] ?? null) ?? 'TryHackX Media',
            // Without a host the mailer writes messages to disk instead of sending
            // them, so account activation still works end to end before a mail
            // server is available.
            'spool_path' => $spoolPath ?? $projectRoot . '/logs/mail',
        ];
        // The root, because that is where the frontend is built to stand unless
        // somebody asks for a subdirectory (`MEDIA_APP_BASE=/media-next/`). The
        // default used to be that subdirectory, and an installation that never
        // set `[app] base_url` sent activation links to a path it does not serve.
        $config['app'] = [
            'base_url' => self::nonEmptyString($app['base_url'] ?? null) ?? '/',
        ];

        return $config;
    }

    /**
     * The name of our own session cookie.
     *
     * It used to be `PHPSESSID`, shared with the portal that lived in the same
     * DocumentRoot: one cookie, two applications, and whichever started the
     * session first decided what the other saw. That portal is gone, so the
     * sharing has nothing left to justify it — and a cookie of our own means a
     * session here can never be handed to, or taken over by, anything else that
     * happens to run on this host.
     *
     * Only letters and digits: PHP puts this straight into a Set-Cookie header,
     * and a name it cannot use turns into a warning at session_name() rather
     * than an error anybody would notice.
     */
    private static function sessionName(mixed $configured): string
    {
        $name = self::nonEmptyString(is_string($configured) ? $configured : null) ?? 'TRYHACKXSESSID';
        if (preg_match('/^[A-Za-z][A-Za-z0-9]{0,63}$/D', $name) !== 1) {
            throw new RuntimeException(
                'session.name może zawierać wyłącznie litery i cyfry, zaczynać się od litery i mieć najwyżej 64 znaki.'
            );
        }

        return $name;
    }

    private static function isAbsolutePath(string $path): bool
    {
        return str_starts_with($path, '/')
            || str_starts_with($path, '\\')
            || preg_match('/^[A-Za-z]:[\\\\\/]/', $path) === 1;
    }

    private static function nonEmptyString(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : null;
    }

    /** @param array<string, mixed> $config */
    private static function optional(array $config, string $section, string $key): ?string
    {
        $value = $config[$section][$key] ?? null;
        if (is_int($value)) {
            return (string) $value;
        }

        return self::nonEmptyString($value);
    }

    /** @param array<string, mixed> $config */
    private static function stringValue(array $config, string $section, string $key): string
    {
        $value = $config[$section][$key] ?? null;
        if (!is_string($value) || $value === '') {
            throw new RuntimeException("Brak konfiguracji: {$section}.{$key}");
        }

        return $value;
    }

    private static function portValue(mixed $raw, string $message): int
    {
        if (is_string($raw) && preg_match('/^[0-9]{1,5}$/D', $raw) === 1) {
            $raw = (int) $raw;
        }
        if (!is_int($raw) || $raw < 1 || $raw > 65535) {
            throw new RuntimeException($message);
        }

        return $raw;
    }

    /**
     * Parse the subset of TOML the shared configuration uses: comments, `[table]` and
     * `[dotted.table]` headers, bare or quoted keys, basic and literal strings,
     * integers, floats and booleans. Anything else (arrays, inline tables, multi-line
     * strings, dates) is rejected explicitly, so a file the Python `tomllib` side
     * accepts is never silently misread here — unlike `parse_ini_file`, which treated
     * `#` comments and quotes as data.
     *
     * @return array<string, mixed>
     */
    public static function parseToml(string $source): array
    {
        $root = [];
        $current = &$root;
        $tables = [];
        $lines = preg_split('/\r\n|\n|\r/', $source);
        if ($lines === false) {
            throw new RuntimeException('Nie można odczytać konfiguracji TOML.');
        }

        foreach ($lines as $index => $rawLine) {
            $number = $index + 1;
            $line = trim(self::stripComment($rawLine, $number));
            if ($line === '') {
                continue;
            }

            if ($line[0] === '[') {
                if (str_starts_with($line, '[[')) {
                    throw self::syntax($number, 'tablice tabel nie są obsługiwane');
                }
                if (!str_ends_with($line, ']')) {
                    throw self::syntax($number, 'niedomknięty nagłówek tabeli');
                }
                $path = self::parseKeyPath(substr($line, 1, -1), $number);
                $joined = implode("\0", $path);
                if (isset($tables[$joined])) {
                    throw self::syntax($number, 'tabela została zdefiniowana ponownie');
                }
                $tables[$joined] = true;
                unset($current);
                $current = &$root;
                foreach ($path as $segment) {
                    if (!array_key_exists($segment, $current)) {
                        $current[$segment] = [];
                    } elseif (!is_array($current[$segment])) {
                        throw self::syntax($number, 'klucz jest już wartością, nie tabelą');
                    }
                    $current = &$current[$segment];
                }
                continue;
            }

            $assignment = self::findAssignment($line, $number);
            $path = self::parseKeyPath(substr($line, 0, $assignment), $number);
            $value = self::parseValue(trim(substr($line, $assignment + 1)), $number);

            $target = &$current;
            $last = array_pop($path);
            foreach ($path as $segment) {
                if (!array_key_exists($segment, $target)) {
                    $target[$segment] = [];
                } elseif (!is_array($target[$segment])) {
                    throw self::syntax($number, 'klucz jest już wartością, nie tabelą');
                }
                $target = &$target[$segment];
            }
            if (array_key_exists($last, $target)) {
                throw self::syntax($number, 'klucz został zdefiniowany ponownie');
            }
            $target[$last] = $value;
            unset($target);
        }
        unset($current);

        return $root;
    }

    private static function syntax(int $line, string $reason): RuntimeException
    {
        return new RuntimeException("Błąd składni TOML w linii {$line}: {$reason}.");
    }

    /** Remove a trailing `#` comment while honouring quoted strings. */
    private static function stripComment(string $line, int $number): string
    {
        $length = strlen($line);
        $quote = null;
        for ($i = 0; $i < $length; $i++) {
            $char = $line[$i];
            if ($quote === null) {
                if ($char === '#') {
                    return substr($line, 0, $i);
                }
                if ($char === '"' || $char === "'") {
                    if (substr($line, $i, 3) === str_repeat($char, 3)) {
                        throw self::syntax($number, 'ciągi wieloliniowe nie są obsługiwane');
                    }
                    $quote = $char;
                }
                continue;
            }
            if ($quote === '"' && $char === '\\') {
                $i++;
                continue;
            }
            if ($char === $quote) {
                $quote = null;
            }
        }
        if ($quote !== null) {
            throw self::syntax($number, 'niedomknięty ciąg znaków');
        }

        return $line;
    }

    /** Position of the `=` that separates key and value, ignoring quoted keys. */
    private static function findAssignment(string $line, int $number): int
    {
        $length = strlen($line);
        $quote = null;
        for ($i = 0; $i < $length; $i++) {
            $char = $line[$i];
            if ($quote !== null) {
                if ($quote === '"' && $char === '\\') {
                    $i++;
                } elseif ($char === $quote) {
                    $quote = null;
                }
                continue;
            }
            if ($char === '"' || $char === "'") {
                $quote = $char;
            } elseif ($char === '=') {
                return $i;
            }
        }

        throw self::syntax($number, 'oczekiwano przypisania klucz = wartość');
    }

    /** @return list<string> */
    private static function parseKeyPath(string $raw, int $number): array
    {
        $segments = [];
        $length = strlen($raw);
        $i = 0;
        while (true) {
            while ($i < $length && ($raw[$i] === ' ' || $raw[$i] === "\t")) {
                $i++;
            }
            if ($i >= $length) {
                throw self::syntax($number, 'pusty klucz');
            }
            $char = $raw[$i];
            if ($char === '"' || $char === "'") {
                $end = strpos($raw, $char, $i + 1);
                while ($char === '"' && $end !== false && $raw[$end - 1] === '\\') {
                    $end = strpos($raw, $char, $end + 1);
                }
                if ($end === false) {
                    throw self::syntax($number, 'niedomknięty klucz w cudzysłowie');
                }
                $segment = substr($raw, $i + 1, $end - $i - 1);
                $segments[] = $char === '"' ? self::unescape($segment, $number) : $segment;
                $i = $end + 1;
            } else {
                if (preg_match('/[A-Za-z0-9_-]+/A', $raw, $match, 0, $i) !== 1) {
                    throw self::syntax($number, 'nieprawidłowy klucz');
                }
                $segments[] = $match[0];
                $i += strlen($match[0]);
            }
            while ($i < $length && ($raw[$i] === ' ' || $raw[$i] === "\t")) {
                $i++;
            }
            if ($i >= $length) {
                return $segments;
            }
            if ($raw[$i] !== '.') {
                throw self::syntax($number, 'nieoczekiwany znak w kluczu');
            }
            $i++;
        }
    }

    private static function parseValue(string $raw, int $number): string|int|float|bool
    {
        if ($raw === '') {
            throw self::syntax($number, 'brak wartości');
        }
        $first = $raw[0];
        if ($first === '"' || $first === "'") {
            if (strlen($raw) < 2 || $raw[-1] !== $first) {
                throw self::syntax($number, 'nieprawidłowy ciąg znaków');
            }
            $body = substr($raw, 1, -1);
            if ($first === "'") {
                if (str_contains($body, "'")) {
                    throw self::syntax($number, 'nieoczekiwane znaki po wartości');
                }

                return $body;
            }
            if (preg_match('/(?<!\\\\)(?:\\\\\\\\)*"/', $body) === 1) {
                throw self::syntax($number, 'nieoczekiwane znaki po wartości');
            }

            return self::unescape($body, $number);
        }
        if ($raw === 'true' || $raw === 'false') {
            return $raw === 'true';
        }
        if ($first === '[' || $first === '{') {
            throw self::syntax($number, 'tablice i tabele inline nie są obsługiwane');
        }
        if (preg_match('/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/D', $raw) === 1) {
            return (int) str_replace('_', '', $raw);
        }
        if (preg_match('/^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/D', $raw) === 1) {
            return (int) hexdec(str_replace('_', '', substr($raw, 2)));
        }
        if (preg_match('/^0o[0-7](?:_?[0-7])*$/D', $raw) === 1) {
            return (int) octdec(str_replace('_', '', substr($raw, 2)));
        }
        if (preg_match('/^0b[01](?:_?[01])*$/D', $raw) === 1) {
            return (int) bindec(str_replace('_', '', substr($raw, 2)));
        }
        if (preg_match('/^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/D', $raw) === 1) {
            return (float) str_replace('_', '', $raw);
        }

        throw self::syntax($number, 'nieobsługiwana wartość');
    }

    private static function unescape(string $body, int $number): string
    {
        $result = preg_replace_callback(
            '/\\\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/s',
            static function (array $match) use ($number): string {
                $code = $match[1];
                switch ($code) {
                    case 'b':
                        return "\x08";
                    case 't':
                        return "\t";
                    case 'n':
                        return "\n";
                    case 'f':
                        return "\f";
                    case 'r':
                        return "\r";
                    case '"':
                        return '"';
                    case '\\':
                        return '\\';
                }
                if ($code[0] === 'u' || $code[0] === 'U') {
                    $encoded = mb_chr((int) hexdec(substr($code, 1)), 'UTF-8');
                    if ($encoded === false) {
                        throw self::syntax($number, 'nieprawidłowy kod znaku');
                    }

                    return $encoded;
                }

                throw self::syntax($number, 'nieznana sekwencja ucieczki');
            },
            $body
        );
        if (!is_string($result)) {
            throw self::syntax($number, 'nieprawidłowy ciąg znaków');
        }

        return $result;
    }
}
