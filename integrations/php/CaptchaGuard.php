<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use RuntimeException;

/**
 * Verifies a challenge token in front of the account forms.
 *
 * reCAPTCHA, hCaptcha and Turnstile all take the same request — secret, response
 * and optionally the client address — and answer with a JSON object carrying a
 * "success" flag, so one client serves all three and the operator picks the
 * provider from the panel.
 */
final class CaptchaGuard
{
    private const ENDPOINTS = [
        'recaptcha' => 'https://www.google.com/recaptcha/api/siteverify',
        'hcaptcha' => 'https://hcaptcha.com/siteverify',
        'turnstile' => 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    ];
    private const TIMEOUT_SECONDS = 8;

    /** @param array<string, string> $settings */
    public function __construct(private readonly array $settings)
    {
    }

    public static function providers(): array
    {
        return ['none', ...array_keys(self::ENDPOINTS)];
    }

    public function provider(): string
    {
        $provider = $this->settings['captcha_provider'] ?? 'none';
        return isset(self::ENDPOINTS[$provider]) ? $provider : 'none';
    }

    public function siteKey(): string
    {
        return (string) ($this->settings['captcha_site_key'] ?? '');
    }

    /**
     * A provider with no keys behaves as if it were off.
     *
     * Half-configured protection that rejects everybody would lock the operator
     * out of their own sign-in form, so an incomplete setup fails open here and
     * is surfaced in the panel instead.
     */
    public function isConfigured(): bool
    {
        return $this->provider() !== 'none'
            && $this->siteKey() !== ''
            && (string) ($this->settings['captcha_secret_key'] ?? '') !== '';
    }

    public function protects(string $flow): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }
        return match ($flow) {
            'login' => ($this->settings['captcha_protect_login'] ?? '0') === '1',
            'register' => ($this->settings['captcha_protect_registration'] ?? '0') === '1',
            default => false,
        };
    }

    /** Reject the request unless the challenge was solved. */
    public function assertSolved(string $flow, ?string $token, string $clientAddress): void
    {
        if (!$this->protects($flow)) {
            return;
        }
        if (!is_string($token) || $token === '' || strlen($token) > 4096) {
            throw new BridgeRequestException('Potwierdź, że nie jesteś robotem.');
        }
        if (!$this->verify($token, $clientAddress)) {
            throw new BridgeRequestException('Weryfikacja antybotowa nie powiodła się. Spróbuj ponownie.');
        }
    }

    private function verify(string $token, string $clientAddress): bool
    {
        $endpoint = self::ENDPOINTS[$this->provider()] ?? null;
        if ($endpoint === null) {
            return false;
        }
        $fields = [
            'secret' => (string) ($this->settings['captcha_secret_key'] ?? ''),
            'response' => $token,
        ];
        if (filter_var($clientAddress, FILTER_VALIDATE_IP) !== false) {
            $fields['remoteip'] = $clientAddress;
        }

        $handle = curl_init($endpoint);
        if ($handle === false) {
            throw new RuntimeException('Nie można zweryfikować wyzwania antybotowego.');
        }
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query($fields),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $response = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if (!is_string($response) || $status !== 200) {
            // An unreachable provider must not become an open door.
            throw new RuntimeException('Usługa antybotowa jest niedostępna.');
        }
        $decoded = json_decode($response, true);
        return is_array($decoded) && ($decoded['success'] ?? false) === true;
    }
}
