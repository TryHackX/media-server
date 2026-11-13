<?php

declare(strict_types=1);

namespace TryHackX\Media\Integration;

use RuntimeException;

/**
 * Verifies a challenge token, whichever provider the operator picked.
 *
 * reCAPTCHA (v2 and v3), hCaptcha and Turnstile all take the same request —
 * secret, response and optionally the client address — and answer with a JSON
 * object carrying a "success" flag, so one client serves all of them; v3 adds a
 * score and the action name the page executed, and both are checked. `pow` is
 * our own proof of work (ProofOfWork), verified here without any network.
 *
 * Each provider keeps its own site key and secret (`captcha_site_key_<p>`,
 * `captcha_secret_key_<p>`), so switching the provider back and forth does not
 * lose the keys of the others. Secrets never leave the server.
 *
 * Where a challenge is shown: the forms of the sign-in page use the chosen
 * provider ("always" on sign-in, protected registration). The step-up ladder
 * (StepUpGuard) needs a challenge it can always ask for: on the sign-in page
 * that is the chosen provider when it is fully configured, proof of work
 * otherwise; inside the application it is always proof of work, because the
 * application pages' CSP admits no third-party script.
 */
final class CaptchaGuard
{
    public const PROVIDERS = ['none', 'recaptcha', 'recaptcha_v3', 'hcaptcha', 'turnstile', 'pow'];
    /** Providers that need a site key and a secret. */
    public const KEYED_PROVIDERS = ['recaptcha', 'recaptcha_v3', 'hcaptcha', 'turnstile'];
    public const LOGIN_MODES = ['always', 'after', 'never'];
    public const DEFAULT_LOGIN_AFTER = 3;
    public const DEFAULT_MIN_SCORE = 0.5;

    private const ENDPOINTS = [
        'recaptcha' => 'https://www.google.com/recaptcha/api/siteverify',
        'recaptcha_v3' => 'https://www.google.com/recaptcha/api/siteverify',
        'hcaptcha' => 'https://hcaptcha.com/siteverify',
        'turnstile' => 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    ];
    private const TIMEOUT_SECONDS = 8;

    /** @var \Closure(string, array<string, string>): ?array<string, mixed> */
    private readonly \Closure $transport;

    /**
     * @param array<string, string> $settings app_settings rows (see settingKeys())
     * @param (\Closure(string, array<string, string>): ?array<string, mixed>)|null $transport
     *   posts the verification form and returns the decoded answer, or null when the
     *   provider could not be reached; injectable so tests never touch the network
     */
    public function __construct(
        private readonly array $settings,
        private readonly ?ProofOfWork $pow = null,
        ?\Closure $transport = null
    ) {
        $this->transport = $transport ?? self::curlTransport(...);
    }

    public static function providers(): array
    {
        return self::PROVIDERS;
    }

    public static function siteKeySetting(string $provider): string
    {
        return 'captcha_site_key_' . $provider;
    }

    public static function secretSetting(string $provider): string
    {
        return 'captcha_secret_key_' . $provider;
    }

    /** @return list<string> every app_settings key this class reads */
    public static function settingKeys(): array
    {
        $keys = ['captcha_provider', 'captcha_protect_login', 'captcha_protect_registration',
            'captcha_login_mode', 'captcha_login_after', 'captcha_v3_min_score', 'captcha_pow_max_number'];
        foreach (self::KEYED_PROVIDERS as $provider) {
            $keys[] = self::siteKeySetting($provider);
            $keys[] = self::secretSetting($provider);
        }
        return $keys;
    }

    public function provider(): string
    {
        $provider = $this->settings['captcha_provider'] ?? 'none';
        return in_array($provider, self::PROVIDERS, true) ? $provider : 'none';
    }

    public function siteKey(?string $provider = null): string
    {
        $provider ??= $this->provider();
        return in_array($provider, self::KEYED_PROVIDERS, true)
            ? (string) ($this->settings[self::siteKeySetting($provider)] ?? '')
            : '';
    }

    private function secret(string $provider): string
    {
        return (string) ($this->settings[self::secretSetting($provider)] ?? '');
    }

    /**
     * Whether the chosen provider can actually be used.
     *
     * A provider with a missing key behaves as if it were off. Half-configured
     * protection that rejects everybody would lock the operator out of their
     * own sign-in form, so an incomplete setup fails open here and is surfaced
     * in the panel instead.
     */
    public function isConfigured(?string $provider = null): bool
    {
        $provider ??= $this->provider();
        if ($provider === 'pow') {
            return $this->pow !== null;
        }
        return in_array($provider, self::KEYED_PROVIDERS, true)
            && $this->siteKey($provider) !== '' && $this->secret($provider) !== '';
    }

    /** The challenge a step-up on the sign-in page uses: the chosen provider when ready, else proof of work. */
    public function signInProvider(): string
    {
        if ($this->isConfigured()) {
            return $this->provider();
        }
        return $this->pow !== null ? 'pow' : 'none';
    }

    /** "always" (every sign-in), "after" (after N failures) or "never". */
    public function loginMode(): string
    {
        $mode = $this->settings['captcha_login_mode'] ?? '';
        if (in_array($mode, self::LOGIN_MODES, true)) {
            return $mode;
        }
        // Before the mode existed there was only the "protect sign-in" box.
        return ($this->settings['captcha_protect_login'] ?? '0') === '1' ? 'always' : 'after';
    }

    public function loginAfter(): int
    {
        $value = $this->settings['captcha_login_after'] ?? '';
        return is_numeric($value) ? max(1, min(50, (int) $value)) : self::DEFAULT_LOGIN_AFTER;
    }

    public function minScore(): float
    {
        $value = $this->settings['captcha_v3_min_score'] ?? '';
        return is_numeric($value) ? max(0.0, min(1.0, (float) $value)) : self::DEFAULT_MIN_SCORE;
    }

    /**
     * Whether a form of the sign-in page asks for the chosen provider every time.
     *
     * Only with a configured provider: "none" (or a half-configured one) means
     * the forms carry no widget, and only the step-up ladder may still ask —
     * with proof of work.
     */
    public function protects(string $flow): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }
        return match ($flow) {
            'login' => $this->loginMode() === 'always',
            'register' => ($this->settings['captcha_protect_registration'] ?? '0') === '1',
            default => false,
        };
    }

    /** @return array{provider:string,site_key:string} what a page needs to show this provider */
    public function publicConfig(string $provider): array
    {
        return ['provider' => $provider, 'site_key' => $this->siteKey($provider)];
    }

    /**
     * Verify a token from the given provider.
     *
     * @throws BridgeUnavailableException when a third-party provider cannot be
     *   reached — an unreachable verifier must not become an open door, and is
     *   not an internal error either (the bridge answers 503 with the message)
     */
    public function verify(string $provider, string $token, string $clientAddress, string $action): bool
    {
        if ($token === '' || strlen($token) > 4096) {
            return false;
        }
        if ($provider === 'pow') {
            return $this->pow !== null && $this->pow->verify($token);
        }
        $endpoint = self::ENDPOINTS[$provider] ?? null;
        if ($endpoint === null || !$this->isConfigured($provider)) {
            return false;
        }
        $fields = ['secret' => $this->secret($provider), 'response' => $token];
        if (filter_var($clientAddress, FILTER_VALIDATE_IP) !== false) {
            $fields['remoteip'] = $clientAddress;
        }
        $answer = ($this->transport)($endpoint, $fields);
        if ($answer === null) {
            throw new BridgeUnavailableException(
                'Usługa weryfikacji antybotowej nie odpowiada. Spróbuj ponownie za chwilę.'
            );
        }
        if (($answer['success'] ?? false) !== true) {
            return false;
        }
        if ($provider !== 'recaptcha_v3') {
            return true;
        }
        // A v3 answer always carries a score; none means a v2 key was pasted
        // under v3. The action must be the one this request expected, so a
        // token minted for one form cannot be spent on another.
        $score = $answer['score'] ?? null;
        if (!is_int($score) && !is_float($score)) {
            return false;
        }
        return (float) $score >= $this->minScore()
            && is_string($answer['action'] ?? null) && $answer['action'] === $action;
    }

    /**
     * @param array<string, string> $fields
     * @return array<string, mixed>|null
     */
    private static function curlTransport(string $endpoint, array $fields): ?array
    {
        $handle = curl_init($endpoint);
        if ($handle === false) {
            return null;
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
        if (!is_string($response) || $status !== 200) {
            return null;
        }
        $decoded = json_decode($response, true);
        return is_array($decoded) ? $decoded : [];
    }
}
