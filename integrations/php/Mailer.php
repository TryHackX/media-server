<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use RuntimeException;

/**
 * Delivers account mail over SMTP, or writes it to a spool directory when no
 * mail server is configured.
 *
 * The spool is not a stub: activation links are written in full, so the whole
 * sign-up flow can be exercised and an operator can complete an activation by
 * hand before any credentials exist.
 */
final class Mailer
{
    private const TIMEOUT_SECONDS = 12;

    /** @param array<string, mixed> $mail */
    public function __construct(private readonly array $mail)
    {
    }

    /** @param array<string, array<string, mixed>> $config */
    public static function fromConfig(array $config): self
    {
        return new self(is_array($config['mail'] ?? null) ? $config['mail'] : []);
    }

    public function usesSpool(): bool
    {
        return !is_string($this->mail['host'] ?? null) || $this->mail['host'] === '';
    }

    public function send(string $recipient, string $subject, string $body): void
    {
        if (filter_var($recipient, FILTER_VALIDATE_EMAIL) === false) {
            throw new RuntimeException('Nieprawidłowy adres odbiorcy.');
        }
        $message = $this->compose($recipient, $subject, $body);
        if ($this->usesSpool()) {
            $this->spool($recipient, $message);
            return;
        }
        $this->transmit($recipient, $message);
    }

    private function compose(string $recipient, string $subject, string $body): string
    {
        $fromAddress = (string) ($this->mail['from_address'] ?? 'no-reply@localhost');
        $fromName = (string) ($this->mail['from_name'] ?? 'TryHackX Media');
        // Encoded so non-ASCII subjects survive; the body goes out as UTF-8 text.
        $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
        $encodedName = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
        $headers = [
            "From: {$encodedName} <{$fromAddress}>",
            "To: <{$recipient}>",
            "Subject: {$encodedSubject}",
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            'Date: ' . date(DATE_RFC2822),
            'Message-ID: <' . bin2hex(random_bytes(16)) . '@tryhackx.local>',
        ];
        return implode("\r\n", $headers) . "\r\n\r\n" . str_replace("\n", "\r\n", $body) . "\r\n";
    }

    private function spool(string $recipient, string $message): void
    {
        $directory = (string) ($this->mail['spool_path'] ?? '');
        if ($directory === '') {
            throw new RuntimeException('Brak katalogu na wiadomości.');
        }
        if (!is_dir($directory) && !mkdir($directory, 0770, true) && !is_dir($directory)) {
            throw new RuntimeException('Nie można utworzyć katalogu wiadomości.');
        }
        $safeRecipient = preg_replace('/[^A-Za-z0-9._@-]/', '_', $recipient) ?? 'odbiorca';
        // The name carried a timestamp to the second and the address, so two
        // messages to the same person inside one second overwrote each other and
        // one simply vanished. Rare while the only mail was an activation link;
        // ordinary once a digest run can be repeated. The suffix ends that.
        $path = sprintf(
            '%s/%s-%s-%s.eml',
            rtrim($directory, '/\\'),
            date('Ymd-His'),
            $safeRecipient,
            bin2hex(random_bytes(3))
        );
        if (file_put_contents($path, $message, LOCK_EX) === false) {
            throw new RuntimeException('Nie można zapisać wiadomości.');
        }
    }

    private function transmit(string $recipient, string $message): void
    {
        $host = (string) $this->mail['host'];
        $port = (int) ($this->mail['port'] ?? 587);
        $security = strtolower((string) ($this->mail['security'] ?? 'starttls'));
        $endpoint = $security === 'tls' ? "ssl://{$host}:{$port}" : "tcp://{$host}:{$port}";

        $socket = @stream_socket_client($endpoint, $errorCode, $errorMessage, self::TIMEOUT_SECONDS);
        if ($socket === false) {
            throw new RuntimeException("Nie można połączyć się z serwerem poczty: {$errorMessage}");
        }
        stream_set_timeout($socket, self::TIMEOUT_SECONDS);
        try {
            $this->expect($socket, 220);
            $this->command($socket, 'EHLO ' . $this->heloName(), 250);
            if ($security === 'starttls') {
                $this->command($socket, 'STARTTLS', 220);
                if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                    throw new RuntimeException('Nie można zestawić szyfrowania STARTTLS.');
                }
                // The server advertises a different feature set once encrypted.
                $this->command($socket, 'EHLO ' . $this->heloName(), 250);
            }
            $username = $this->mail['username'] ?? null;
            $password = $this->mail['password'] ?? null;
            if (is_string($username) && $username !== '' && is_string($password)) {
                $this->command($socket, 'AUTH LOGIN', 334);
                $this->command($socket, base64_encode($username), 334);
                $this->command($socket, base64_encode($password), 235);
            }
            $this->command($socket, 'MAIL FROM:<' . (string) $this->mail['from_address'] . '>', 250);
            $this->command($socket, "RCPT TO:<{$recipient}>", [250, 251]);
            $this->command($socket, 'DATA', 354);
            // A lone dot would end the message early, so escape it per RFC 5321.
            $escaped = preg_replace('/^\./m', '..', $message) ?? $message;
            fwrite($socket, $escaped . "\r\n.\r\n");
            $this->expect($socket, 250);
            $this->command($socket, 'QUIT', [221, 250]);
        } finally {
            fclose($socket);
        }
    }

    private function heloName(): string
    {
        $host = (string) ($_SERVER['SERVER_NAME'] ?? 'localhost');
        return preg_match('/^[A-Za-z0-9.-]+$/D', $host) === 1 ? $host : 'localhost';
    }

    /** @param resource $socket @param int|array<int, int> $expected */
    private function command($socket, string $line, int|array $expected): void
    {
        fwrite($socket, $line . "\r\n");
        $this->expect($socket, $expected);
    }

    /** @param resource $socket @param int|array<int, int> $expected */
    private function expect($socket, int|array $expected): void
    {
        $codes = is_array($expected) ? $expected : [$expected];
        $reply = '';
        while (($line = fgets($socket, 1024)) !== false) {
            $reply .= $line;
            // Continuation lines carry a dash after the code; the last one a space.
            if (strlen($line) >= 4 && $line[3] === ' ') {
                break;
            }
        }
        $code = (int) substr(trim($reply), 0, 3);
        if (!in_array($code, $codes, true)) {
            throw new RuntimeException('Serwer poczty odrzucił polecenie: ' . trim($reply));
        }
    }
}
