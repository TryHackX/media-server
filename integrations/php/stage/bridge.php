<?php

declare(strict_types=1);

use TryHackX\Media\Integration\AccountGateway;
use TryHackX\Media\Integration\BridgeAuthenticationException;
use TryHackX\Media\Integration\BridgeAuthorizationException;
use TryHackX\Media\Integration\BridgeCaptchaRequiredException;
use TryHackX\Media\Integration\BridgeConfigLoader;
use TryHackX\Media\Integration\ProofOfWork;
use TryHackX\Media\Integration\StepUpGuard;
use TryHackX\Media\Integration\TwoFactor;
use TryHackX\Media\Integration\LegacyIdentity;
use TryHackX\Media\Integration\BridgeRateLimitException;
use TryHackX\Media\Integration\BridgeRequestException;
use TryHackX\Media\Integration\BridgeTime;
use TryHackX\Media\Integration\BridgeUnavailableException;
use TryHackX\Media\Integration\CatalogItemNotFoundException;
use TryHackX\Media\Integration\CatalogTransferGateway;
use TryHackX\Media\Integration\GuestLinks;
use TryHackX\Media\Integration\HomeShelves;
use TryHackX\Media\Integration\LegacySessionBridge;
use TryHackX\Media\Integration\LibraryBrowser;
use TryHackX\Media\Integration\LibraryDigest;
use TryHackX\Media\Integration\Mailer;
use TryHackX\Media\Integration\PermissionGroups;
use TryHackX\Media\Integration\CaptchaGuard;
use TryHackX\Media\Integration\CatalogActions;
use TryHackX\Media\Integration\PlaylistImporter;
use TryHackX\Media\Integration\TrustedProxy;

require_once __DIR__ . '/../BridgeException.php';
require_once __DIR__ . '/../BridgeTime.php';
require_once __DIR__ . '/../LegacyIdentity.php';
require_once __DIR__ . '/../LegacySessionBridge.php';
require_once __DIR__ . '/../TransferToken.php';
require_once __DIR__ . '/../TrustedProxy.php';
require_once __DIR__ . '/../CatalogTransferGateway.php';
require_once __DIR__ . '/../LibraryBrowser.php';
require_once __DIR__ . '/../CatalogActions.php';
require_once __DIR__ . '/../HomeShelves.php';
require_once __DIR__ . '/../BridgeConfigLoader.php';
require_once __DIR__ . '/../Mailer.php';
require_once __DIR__ . '/../AccountGateway.php';
require_once __DIR__ . '/../ProofOfWork.php';
require_once __DIR__ . '/../CaptchaGuard.php';
require_once __DIR__ . '/../StepUpGuard.php';
require_once __DIR__ . '/../Totp.php';
require_once __DIR__ . '/../TwoFactor.php';
require_once __DIR__ . '/../PermissionGroups.php';
require_once __DIR__ . '/../GuestLinks.php';
require_once __DIR__ . '/../LibraryDigest.php';
require_once __DIR__ . '/../PlaylistParser.php';
require_once __DIR__ . '/../PlaylistImporter.php';

ini_set('display_errors', '0');
// "X-Powered-By: PHP/8.x" tells a stranger which advisories to read first.
header_remove('X-Powered-By');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('Referrer-Policy: no-referrer');

/**
 * The connection timestamps are converted through, once there is one.
 *
 * Answers sent before the database is open (no HTTPS, no configuration) carry
 * no timestamps, so they lose nothing by going out as they are.
 */
function bridgeClock(?PDO $database = null): ?PDO
{
    static $connection = null;
    if ($database !== null) {
        $connection = $database;
    }
    return $connection;
}

/**
 * Every JSON answer of the bridge leaves through here.
 *
 * On the way out each timestamp field (`*_at`, `covered_until`) gains a
 * sibling `<name>_iso`: the same instant as ISO 8601 with an offset, which a
 * browser cannot misread the way it misreads the database's own local-time
 * string (BridgeTime). The old field keeps its value.
 *
 * @param array<string, mixed> $payload
 */
function bridgeResponse(int $status, array $payload): never
{
    http_response_code($status);
    $database = bridgeClock();
    if ($database !== null) {
        try {
            $payload = BridgeTime::withIso($database, $payload);
        } catch (PDOException $error) {
            // The answer is worth more than its second spelling of the time.
            error_log('tryhackx-bridge iso timestamps skipped: ' . $error->getMessage());
        }
    }
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/** @return array<string, mixed> */
function bridgeJsonBody(int $maximumBytes = 65536): array
{
    $length = filter_input(INPUT_SERVER, 'CONTENT_LENGTH', FILTER_VALIDATE_INT);
    if (is_int($length) && $length > $maximumBytes) {
        throw new BridgeRequestException('Żądanie jest zbyt duże.');
    }
    $contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($contentType !== 'application/json') {
        throw new BridgeRequestException('Wymagany jest application/json.');
    }
    $body = file_get_contents('php://input', false, null, 0, $maximumBytes + 1);
    if (!is_string($body) || strlen($body) > $maximumBytes) {
        throw new BridgeRequestException('Żądanie jest zbyt duże.');
    }
    $decoded = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
    // A JSON array is not a request body here — every action reads named fields.
    // `{}` is, though, and PHP decodes it to the same empty array as `[]`, which
    // `array_is_list()` calls a list: an action that takes no arguments (run the
    // digest now) was refused as malformed. Empty is allowed through and the
    // action's own validation decides whether that is enough.
    if (!is_array($decoded) || ($decoded !== [] && array_is_list($decoded))) {
        throw new BridgeRequestException('Nieprawidłowe dane JSON.');
    }
    return $decoded;
}

/**
 * A cover kept in the database (a track's own, a playlist's), which a browser
 * may hold for an hour: the headers that say so replace the "never store" every
 * other answer of the bridge carries.
 */
function bridgeImageResponse(string $mimeType, string $bytes): never
{
    header('Content-Type: ' . $mimeType);
    header('Content-Length: ' . strlen($bytes));
    header('Cache-Control: private, max-age=3600, must-revalidate');
    header_remove('Pragma');
    echo $bytes;
    exit;
}

/**
 * `Content-Disposition` for a file the bridge itself hands out (a playlist or
 * ratings export). The name is already reduced to letters, digits, spaces, "-"
 * and "_" — but the letters may be Polish, and a bare `filename="Wieczór.m3u"`
 * is read as Latin-1 by half the browsers. So: an ASCII stand-in for those, and
 * the real name in `filename*` (RFC 6266) for everybody else.
 */
function bridgeAttachmentHeader(string $name): string
{
    $ascii = preg_replace('/[^A-Za-z0-9 ._-]/', '_', $name) ?? 'export';
    return 'attachment; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($name);
}

/** @param array<string, mixed> $config */
function bridgeConfigValue(array $config, string $section, string $key): string
{
    $value = $config[$section][$key] ?? null;
    if (!is_string($value) || $value === '') {
        throw new RuntimeException("Brak konfiguracji: {$section}.{$key}");
    }
    return $value;
}

/**
 * Bearer secret for the loopback job endpoints, derived from — never equal to —
 * the token-sealing key, so leaking this header cannot forge transfer tokens.
 * Must match _internal_api_key() in the Python service.
 */
function bridgeInternalApiKey(string $encodedTransferKey): string
{
    $raw = base64_decode(
        strtr($encodedTransferKey, '-_', '+/') . str_repeat('=', (4 - strlen($encodedTransferKey) % 4) % 4),
        true
    );
    if ($raw === false) {
        throw new RuntimeException('Nieprawidłowy klucz transferowy.');
    }
    return hash('sha256', 'tryhackx-internal-api:' . $raw);
}

/**
 * A key for one purpose of the bridge's own, derived from the transfer key the
 * way the internal API key is, so neither can be turned back into the other.
 */
function bridgeDerivedKey(string $encodedTransferKey, string $purpose): string
{
    $raw = base64_decode(
        strtr($encodedTransferKey, '-_', '+/') . str_repeat('=', (4 - strlen($encodedTransferKey) % 4) % 4),
        true
    );
    if ($raw === false) {
        throw new RuntimeException('Nieprawidłowy klucz transferowy.');
    }
    return hash_hmac('sha256', $purpose, $raw, true);
}

/**
 * One line in the web server's error log for a refused sign-in, code or
 * challenge, and for a step-up pause or block — what a fail2ban jail reads
 * (deploy/fail2ban/). Only the event, the action and the first 16 hex digits
 * of the client digest the bridge keeps anyway: no name, no password, no
 * address of ours — the web server writes the peer address itself, in front
 * of the message (`[client …]`), which is what the jail bans.
 */
function bridgeAuthLog(string $event, string $clientDigest, string $action): void
{
    error_log(sprintf(
        'tryhackx-auth event=%s action=%s client=%s',
        $event,
        preg_replace('/[^a-z0-9_]/', '', strtolower($action)) ?: '-',
        substr($clientDigest, 0, 16)
    ));
}

/**
 * Hand a job to the local indexing service.
 *
 * A 409 is not a failure here and must not be reported as one: every one of
 * these jobs answers it to mean "I am already doing that", which is the most
 * useful thing it can say. Treating it as an error turned "the genre worker is
 * already running" into "internal_error" — the operator was told the server was
 * broken while it was busy doing exactly what they had asked for.
 */
function bridgeInternalPost(string $url, string $key, array $payload): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('Rozszerzenie PHP cURL jest wymagane do ręcznego indeksowania.');
    }
    $handle = curl_init($url);
    if ($handle === false) {
        throw new RuntimeException('Nie można uruchomić połączenia z usługą indeksowania.');
    }
    curl_setopt_array($handle, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Media-Internal-Key: ' . $key],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
    ]);
    $response = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    $error = curl_error($handle);
    curl_close($handle);
    if (!is_string($response) || (($status < 200 || $status >= 300) && $status !== 409)) {
        throw new RuntimeException('Usługa indeksowania odrzuciła zlecenie: ' . ($error !== '' ? $error : (string) $status));
    }
    $decoded = json_decode($response, true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($decoded) || array_is_list($decoded)) {
        throw new RuntimeException('Usługa indeksowania zwróciła nieprawidłową odpowiedź.');
    }
    return $decoded;
}


try {
    $configPath = getenv('TRYHACKX_BRIDGE_CONFIG');
    if (!is_string($configPath)) {
        throw new RuntimeException('Brak prywatnej konfiguracji mostu.');
    }
    $config = BridgeConfigLoader::load($configPath);

    $remoteAddress = is_string($_SERVER['REMOTE_ADDR'] ?? null) ? $_SERVER['REMOTE_ADDR'] : '';
    $trustedProxies = is_array($config['proxy']['trusted'] ?? null) ? $config['proxy']['trusted'] : [];
    // Proxy kończące TLS rozmawia z nami zwykłym HTTP, więc bez tego most
    // odrzucałby każde żądanie jako niezabezpieczone, a ciasteczko sesji
    // traciłoby atrybut Secure. Nagłówek liczy się wyłącznie od hosta z
    // `[proxy] trusted`; bez wpisu (domyślnie) liczy się tylko własne TLS.
    $isHttps = TrustedProxy::isHttps(
        $remoteAddress,
        isset($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off',
        is_string($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? null) ? $_SERVER['HTTP_X_FORWARDED_PROTO'] : null,
        $trustedProxies
    );
    $requiresHttps = ($config['session']['require_https'] ?? true) === true;
    $allowsLocalHttp = getenv('TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL') === '1'
        && in_array($remoteAddress, ['127.0.0.1', '::1'], true);
    if ($requiresHttps && !$isHttps && !$allowsLocalHttp) {
        throw new BridgeRequestException('Ten endpoint wymaga HTTPS.');
    }

    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.cookie_httponly', '1');
    $sessionName = (string) ($config['session']['name'] ?? 'TRYHACKXSESSID');
    session_name($sessionName);
    // The browser's standing with the accounts it has signed in to (see
    // AccountGateway::login); named after the session cookie, so two
    // installations on one host keep theirs apart the same way.
    $deviceCookieName = ((string) preg_replace('/SESSID$/D', '', $sessionName) ?: $sessionName) . 'DEVICE';
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $isHttps,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    // Caching is named by this script alone: "no-store" for every JSON answer
    // (above), an hour for a cover, a few minutes for the redirect to a
    // thumbnail. PHP's own limiter would add "no-store, no-cache,
    // must-revalidate", "Pragma: no-cache" and an Expires in the past to all of
    // them, so a cover was fetched and read from the database on every view.
    session_cache_limiter('');

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $action = $_GET['action'] ?? 'session';
    if (!is_string($action)) {
        throw new BridgeRequestException('Nieprawidłowa akcja.');
    }

    // A session is opened for a browser that brings one, and for the sign-in
    // page's first call, which is where one begins. Anything else arriving
    // without the cookie has no session to read — it is refused as signed out
    // further down — and used to be given a new session file all the same, one
    // per request, for every probe and every crawler. A guest link carries its
    // own key and never touches a session at all.
    $carriesSession = is_string($_COOKIE[$sessionName] ?? null) && $_COOKIE[$sessionName] !== '';
    if (!in_array($action, ['guest', 'guest_file'], true) && ($carriesSession || $action === 'auth_state')) {
        if (!session_start()) {
            throw new RuntimeException('Nie można uruchomić sesji.');
        }
    } else {
        $_SESSION = [];
    }

    $database = new PDO(
        bridgeConfigValue($config, 'database', 'dsn'),
        bridgeConfigValue($config, 'database', 'user'),
        bridgeConfigValue($config, 'database', 'password'),
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
    bridgeClock($database);
    $sessionBridge = new LegacySessionBridge($database);

    // Signing in, signing up and activating all happen before there is an
    // identity to authenticate, so they are dispatched ahead of the gate below.
    $accounts = new AccountGateway(
        $database,
        Mailer::fromConfig($config),
        (string) ($config['app']['base_url'] ?? '/'),
        bridgeDerivedKey(bridgeConfigValue($config, 'transfer', 'key'), 'tryhackx-device-cookie:v1')
    );
    // Throttling i CAPTCHA liczą po adresie, a za proxy REMOTE_ADDR jest adresem
    // proxy — wszyscy staliby się jednym gościem. Nagłówek jest czytany wyłącznie
    // wtedy, gdy przyniósł go host wypisany w `[proxy] trusted`; bez tego wpisu
    // (domyślnie) zostaje dokładnie to, co było.
    $clientAddress = TrustedProxy::clientAddress(
        $remoteAddress,
        is_string($_SERVER['HTTP_X_FORWARDED_FOR'] ?? null) ? $_SERVER['HTTP_X_FORWARDED_FOR'] : null,
        $trustedProxies
    );

    $securitySettings = $accounts->securitySettings([...CaptchaGuard::settingKeys(), ...StepUpGuard::settingKeys(), 'twofa_require_admins']);
    $proofOfWork = new ProofOfWork(
        $database,
        bridgeDerivedKey(bridgeConfigValue($config, 'transfer', 'key'), 'tryhackx-captcha-pow:v1'),
        ProofOfWork::clampMaxNumber($securitySettings['captcha_pow_max_number'] ?? null)
    );
    $captcha = new CaptchaGuard($securitySettings, $proofOfWork);

    // The step-up ladder (StepUpGuard): how much one account, client or device
    // may do before it is asked to prove it is a person, and before it is
    // paused or blocked. The proof is a "human pass" kept in this session and
    // bound to this client: granted by `captcha_pass`, good for a while.
    $stepUp = new StepUpGuard($database, $securitySettings);
    $clientDigest = AccountGateway::clientHash($clientAddress);
    $deviceCookieValue = is_string($_COOKIE[$deviceCookieName] ?? null) ? $_COOKIE[$deviceCookieName] : null;
    // A device counts only by a cookie this installation signed (deviceDigest):
    // the cookie as it arrives is whatever the visitor typed.
    $preAuthSubjects = StepUpGuard::subjects(null, $clientDigest, $accounts->deviceDigest($deviceCookieValue));
    // A pass remembers which challenge earned it. The ladder takes any; a form
    // of the sign-in page takes only one earned with the page's own provider.
    $hasHumanPass = static function (?string $earnedWith = null) use ($clientDigest): bool {
        $pass = $_SESSION['stepup_pass'] ?? null;
        return is_array($pass) && ($pass['client'] ?? null) === $clientDigest && (int) ($pass['until'] ?? 0) > time()
            && ($earnedWith === null || ($pass['provider'] ?? null) === $earnedWith);
    };
    // Inside the application only proof of work can be shown (the CSP admits
    // no third-party script there); on the sign-in page, the chosen provider.
    $stepUpChallenge = static function (bool $inApp) use ($captcha): BridgeCaptchaRequiredException {
        return new BridgeCaptchaRequiredException(
            'Potwierdź, że nie jesteś robotem.',
            $captcha->publicConfig($inApp ? 'pow' : $captcha->signInProvider()) + ['action' => 'step_up']
        );
    };
    /**
     * A sign-in page form that must come from a person: its own widget's token
     * (verified now), or a pass from an earlier challenge (spent by this form).
     */
    $requireHuman = static function (string $flow, string $inlineToken) use ($captcha, $clientAddress, $hasHumanPass, $stepUpChallenge): void {
        if ($inlineToken !== '') {
            if (!$captcha->verify($captcha->signInProvider(), $inlineToken, $clientAddress, $flow)) {
                bridgeAuthLog('captcha_failed', AccountGateway::clientHash($clientAddress), $flow);
                throw new BridgeRequestException('Weryfikacja antybotowa nie powiodła się. Spróbuj ponownie.');
            }
            return;
        }
        // Only a pass earned with the sign-in page's provider. A signed-in
        // session earns its passes with proof of work (the application can show
        // nothing else), and these forms answer a signed-in session too — so
        // "any pass" let a cheap puzzle stand in for the provider the operator
        // chose for exactly these forms.
        if ($hasHumanPass($captcha->signInProvider())) {
            unset($_SESSION['stepup_pass']);
            return;
        }
        throw $stepUpChallenge(false);
    };
    // Two-factor sign-in (TwoFactor): the TOTP secrets are encrypted under a key
    // derived from the transfer key, which lives in the private configuration.
    $twoFactor = new TwoFactor(
        $database,
        bridgeDerivedKey(bridgeConfigValue($config, 'transfer', 'key'), 'tryhackx-totp-secret:v1'),
        bridgeDerivedKey(bridgeConfigValue($config, 'transfer', 'key'), 'tryhackx-totp-recovery:v1')
    );
    $twoFactorIssuer = 'TryHackX Media';
    // The last part of every sign-in, after the password and (when it is on)
    // the second factor: bind the session, remember the device, list the session.
    $finishSignIn = static function (LegacyIdentity $identity, array $extra = []) use ($sessionBridge, $accounts, $deviceCookieName, $isHttps, $clientAddress): never {
        $sessionBridge->bindSession($_SESSION, $identity->userId);
        $deviceCookie = $accounts->deviceCookieFor($identity->userId);
        if ($deviceCookie !== null) {
            setcookie($deviceCookieName, $deviceCookie, [
                'expires' => time() + AccountGateway::DEVICE_COOKIE_TTL_SECONDS,
                'path' => '/',
                'secure' => $isHttps,
                'httponly' => true,
                'samesite' => 'Strict',
            ]);
        }
        // Recorded at sign-in rather than on the next call, so a browser that
        // signs in and sits idle is still visible in "active sessions".
        $sessionBridge->trackSession(
            $_SESSION,
            $identity,
            session_id() ?: '',
            is_string($_SERVER['HTTP_USER_AGENT'] ?? null) ? $_SERVER['HTTP_USER_AGENT'] : '',
            $clientAddress
        );
        bridgeResponse(200, [
            'success' => true,
            'user' => ['username' => $identity->username, 'role' => $identity->role],
            'csrf_token' => $sessionBridge->csrfToken($_SESSION),
        ] + $extra);
    };

    // Reads with no cost worth pacing (the session, the sign-in page's state,
    // signing out) and pictures, which come by the dozen with every page.
    $stepUpUncounted = ['auth_state', 'session', 'logout', 'preview', 'collection_preview'];
    // Counted, but never answered with a challenge: the page could not show it
    // (a download link, a guest page with no session) or it is the way out.
    $stepUpUnchallengeable = ['captcha_challenge', 'captcha_pass', 'guest', 'guest_file', 'collection_export', 'ratings_export'];
    $preAuthActions = ['auth_state', 'captcha_challenge', 'captcha_pass', 'login', 'login_2fa', 'register', 'activate',
        'resend_activation', 'email_change_confirm', 'guest', 'guest_file'];
    if (in_array($action, $preAuthActions, true) && !in_array($action, $stepUpUncounted, true)
        && !$stepUp->admit('request', $preAuthSubjects, null, $hasHumanPass(), !in_array($action, $stepUpUnchallengeable, true))) {
        throw $stepUpChallenge(false);
    }

    if ($method === 'GET' && $action === 'auth_state') {
        // Hands the sign-in page a CSRF token before any account exists in the
        // session, tells it whether to offer a sign-up link, and passes the
        // public captcha key so the widget can render. The secret stays here.
        bridgeResponse(200, [
            'authenticated' => ($_SESSION['logged_in'] ?? null) === true,
            'registration_enabled' => $accounts->registrationEnabled(),
            'requires_activation' => $accounts->activationRequired(),
            'captcha' => [
                'provider' => $captcha->provider(),
                'site_key' => $captcha->siteKey(),
                'login' => $captcha->protects('login'),
                'register' => $captcha->protects('register'),
                'login_mode' => $captcha->loginMode(),
            ],
            'csrf_token' => $sessionBridge->csrfToken($_SESSION),
        ]);
    }

    if ($method === 'GET' && $action === 'captcha_challenge') {
        // A fresh proof-of-work puzzle. Open before sign-in (the sign-in page
        // may need one) and harmless: issuing costs one HMAC, and a puzzle is
        // only worth anything once solved and presented.
        bridgeResponse(200, ['challenge' => $proofOfWork->challenge()]);
    }

    if ($action === 'login' || $action === 'register' || $action === 'activate'
        || $action === 'resend_activation' || $action === 'email_change_confirm' || $action === 'captcha_pass'
        || $action === 'login_2fa') {
        if ($method !== 'POST') {
            header('Allow: POST');
            bridgeResponse(405, ['error' => 'method_not_allowed']);
        }
        $sessionBridge->assertCsrf($_SESSION, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null);
        $payload = bridgeJsonBody(8192);
        $text = static function (string $key) use ($payload): string {
            $value = $payload[$key] ?? '';
            return is_string($value) ? $value : '';
        };

        if ($action === 'captcha_pass') {
            // Trade a solved challenge for a human pass. Which challenge counts is
            // decided here, not by the page: proof of work for a signed-in session
            // (the application pages can show nothing else), the sign-in page's
            // provider otherwise — so a cheap puzzle cannot stand in for the
            // provider the operator chose for the sign-in page.
            $inApp = ($_SESSION['logged_in'] ?? null) === true;
            $provider = $inApp ? 'pow' : $captcha->signInProvider();
            if (!$captcha->verify($provider, $text('token'), $clientAddress, 'step_up')) {
                bridgeAuthLog('captcha_failed', $clientDigest, $action);
                throw new BridgeRequestException('Weryfikacja antybotowa nie powiodła się. Spróbuj ponownie.');
            }
            $_SESSION['stepup_pass'] = [
                'until' => time() + $stepUp->passSeconds(),
                'client' => $clientDigest,
                'provider' => $provider,
            ];
            bridgeResponse(200, ['success' => true, 'expires_in' => $stepUp->passSeconds()]);
        }
        if ($action === 'login') {
            // "always": the form's own widget; "after N failures": asked only once
            // this client (or, from an unknown device, this account) has failed N times.
            if ($captcha->protects('login')
                || ($captcha->loginMode() === 'after'
                    && $accounts->loginChallengeDue($text('username'), $clientAddress, $deviceCookieValue, $captcha->loginAfter()))) {
                $requireHuman('login', $text('captcha_token'));
            }
            try {
                $row = $accounts->checkPassword($text('username'), $text('password'), $clientAddress, $deviceCookieValue);
            } catch (BridgeRateLimitException $limited) {
                // Hammering a closed door is a strike; enough of them block the client.
                $stepUp->strike('login', $preAuthSubjects, null);
                bridgeAuthLog('login_limited', $clientDigest, $action);
                throw $limited;
            } catch (BridgeAuthenticationException $refused) {
                bridgeAuthLog('login_failed', $clientDigest, $action);
                throw $refused;
            }
            $userId = (int) $row['id'];
            $isOperator = in_array((string) $row['role'], ['admin', 'super_admin'], true) && (int) $row['is_guest'] !== 1;
            $hasSecondFactor = $twoFactor->isEnabled($userId);
            $mustSetUp = !$hasSecondFactor && $isOperator && ($securitySettings['twofa_require_admins'] ?? '0') === '1';
            if ($hasSecondFactor || $mustSetUp) {
                // The password was right; the session opens only after the code.
                // Between the two steps there is a ticket in this session — no
                // account, a few minutes, a fresh identifier — and nothing else.
                if (session_status() === PHP_SESSION_ACTIVE && !headers_sent()) {
                    session_regenerate_id(true);
                }
                unset($_SESSION['stepup_pass']);
                $_SESSION['twofa_ticket'] = ['user_id' => $userId, 'expires' => time() + 300, 'setup' => $mustSetUp];
                bridgeResponse(200, [
                    'success' => false,
                    'two_factor' => $mustSetUp ? 'setup' : 'code',
                    'csrf_token' => $sessionBridge->csrfToken($_SESSION),
                ] + ($mustSetUp ? $twoFactor->beginSetup($userId, (string) $row['username'], $twoFactorIssuer) : []));
            }
            $finishSignIn($accounts->openSession($_SESSION, $row));
        }
        if ($action === 'login_2fa') {
            $ticket = $_SESSION['twofa_ticket'] ?? null;
            if (!is_array($ticket) || (int) ($ticket['expires'] ?? 0) < time()) {
                unset($_SESSION['twofa_ticket']);
                throw new BridgeRequestException('Logowanie wygasło. Zaloguj się ponownie.');
            }
            $userId = (int) $ticket['user_id'];
            try {
                $accounts->assertSecondFactorAllowed($clientAddress, $userId);
            } catch (BridgeRateLimitException $limited) {
                // Too many wrong codes: back to the password, and a strike.
                unset($_SESSION['twofa_ticket']);
                $stepUp->strike('login', $preAuthSubjects, $userId);
                bridgeAuthLog('login_limited', $clientDigest, $action);
                throw $limited;
            }
            $setup = ($ticket['setup'] ?? false) === true;
            $recoveryCodes = $setup ? $twoFactor->confirmSetup($userId, $text('code')) : [];
            $accepted = $setup ? ($recoveryCodes !== [] ? 'totp' : null) : $twoFactor->verify($userId, $text('code'));
            if ($accepted === null) {
                $accounts->recordSecondFactor($clientAddress, $userId, false);
                bridgeAuthLog('second_factor_failed', $clientDigest, $action);
                throw new BridgeRequestException('Nieprawidłowy kod.');
            }
            $accounts->recordSecondFactor($clientAddress, $userId, true);
            unset($_SESSION['twofa_ticket']);
            $identity = $accounts->openSession($_SESSION, $accounts->signInRow($userId));
            $audit = new CatalogActions($database);
            if ($setup) {
                $audit->auditEvent($userId, 'user.twofa_enable', 'user', (string) $userId, ['at_sign_in' => true]);
            } elseif ($accepted === 'recovery') {
                $audit->auditEvent($userId, 'user.twofa_recovery_used', 'user', (string) $userId, [
                    'left' => $twoFactor->status($userId)['recovery_left'],
                ]);
            }
            $finishSignIn($identity, $recoveryCodes !== [] ? ['recovery_codes' => $recoveryCodes] : []);
        }
        if ($action === 'register') {
            // Over the ladder's soft threshold, or always when the operator protects
            // registration: a person must be there. Counted once it may go on.
            if (!$stepUp->admit('register', $preAuthSubjects, null, false)) {
                $requireHuman('register', $text('captcha_token'));
                $stepUp->admit('register', $preAuthSubjects, null, true);
            } elseif ($captcha->protects('register')) {
                $requireHuman('register', $text('captcha_token'));
            }
            $result = $accounts->register($text('username'), $text('email'), $text('password'), $clientAddress);
            bridgeResponse(201, ['success' => true] + $result);
        }
        if ($action === 'activate') {
            bridgeResponse(200, ['success' => true, 'username' => $accounts->activate($text('token'))]);
        }
        if ($action === 'email_change_confirm') {
            // Pre-auth like activation: the link from the mailbox must work in a
            // browser that has no signed-in session.
            bridgeResponse(200, ['success' => true, 'username' => $accounts->confirmEmailChange($text('token'))]);
        }
        // Always reports success: whether an address is registered must not leak.
        if (!$stepUp->admit('resend', $preAuthSubjects, null, false)) {
            $requireHuman('resend', $text('captcha_token'));
            $stepUp->admit('resend', $preAuthSubjects, null, true);
        }
        $accounts->resendActivation($text('email'), $clientAddress);
        bridgeResponse(200, ['success' => true]);
    }

    // A guest link is the one door that opens without an account, so it is
    // dispatched here, ahead of the gate. It carries its own key in the request
    // and touches no session: there is nothing for CSRF to protect, because
    // there is no session to ride on. What it may reach is decided entirely by
    // the link (see GuestLinks), never by who is asking.
    if ($action === 'guest' || $action === 'guest_file') {
        $guests = new GuestLinks($database);
        if ($method === 'GET' && $action === 'guest') {
            $token = $_GET['token'] ?? '';
            bridgeResponse(200, ['guest' => $guests->open(is_string($token) ? $token : '')]);
        }
        if ($method !== 'POST') {
            header('Allow: GET, POST');
            bridgeResponse(405, ['error' => 'method_not_allowed']);
        }
        $guestPayload = bridgeJsonBody(4096);
        $token = $guestPayload['token'] ?? '';
        $itemId = $guestPayload['media_item_id'] ?? null;
        $inline = $guestPayload['inline'] ?? true;
        if (!is_string($token) || !is_int($itemId) || !is_bool($inline)) {
            throw new BridgeRequestException('Nieprawidłowe żądanie gościa.');
        }
        $guestGateway = new CatalogTransferGateway(
            $database,
            bridgeConfigValue($config, 'transfer', 'key'),
            (string) ($config['transfer']['base_url'] ?? '/media-transfer')
        );
        bridgeResponse(200, [
            'transfer' => $guests->transfer($token, $itemId, $inline, $guestGateway),
        ]);
    }

    $identity = $sessionBridge->authenticate($_SESSION);
    $sessionBridge->assertBound($_SESSION, $identity);
    // Refuses the request if the session was closed elsewhere.
    $sessionBridge->trackSession(
        $_SESSION,
        $identity,
        session_id() ?: '',
        is_string($_SERVER['HTTP_USER_AGENT'] ?? null) ? $_SERVER['HTTP_USER_AGENT'] : '',
        $clientAddress
    );

    // The ladder for a signed-in account: every request, the heavy ones also
    // under their own context ($appStepUp in the actions below). Counted by the
    // account alone — a household shares one address, and one member's
    // downloads must not pause the others, nor keep the owner from signing in
    // to lift it; the address counts before sign-in, where there is no account.
    // Staff may be exempt (stepup_staff_exempt).
    $appSubjects = ['u:' . $identity->userId];
    $stepUpExempt = $identity->isOperator() && $stepUp->staffExempt();
    $appStepUp = static function (string $context, bool $challengeable = true) use ($stepUp, $appSubjects, $identity, $stepUpExempt, $hasHumanPass, $stepUpChallenge): void {
        if (!$stepUpExempt && !$stepUp->admit($context, $appSubjects, $identity->userId, $hasHumanPass(), $challengeable)) {
            throw $stepUpChallenge(true);
        }
    };
    if (!in_array($action, $stepUpUncounted, true)) {
        $appStepUp('request', !in_array($action, $stepUpUnchallengeable, true));
    } elseif (!$stepUpExempt && ($action === 'preview' || $action === 'collection_preview')) {
        // Pictures are not counted, but a blocked subject gets none.
        $stepUp->assertNotBlocked($appSubjects);
    }

    // PHP keeps the session file locked from session_start() to the end of the
    // request, so every call of one browser waited for the one before it: a
    // slow listing held up the previews, the queue save and the progress report
    // behind it (measured: a 40 ms call took 4 s behind a 4 s one). Nothing
    // below writes the session — sign-in, the second factor and the human pass
    // are dispatched above, and signing out is the one exception — so it is
    // written and released here. `$_SESSION` stays readable, and the identifier
    // is kept for the actions that name this session (its fingerprint).
    $sessionId = session_id() ?: '';
    if ($action !== 'logout') {
        // Stored before the lock goes, so `session` and a later challenge only read it.
        $sessionBridge->csrfToken($_SESSION);
        session_write_close();
    }

    if ($action === 'logout') {
        if ($method !== 'POST') {
            header('Allow: POST');
            bridgeResponse(405, ['error' => 'method_not_allowed']);
        }
        $sessionBridge->assertCsrf($_SESSION, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null);
        // Close the row before the session goes, otherwise the panel would keep
        // listing a browser that signed itself out until the row aged away.
        $sessionBridge->revokeCurrentSession($sessionId, $identity->userId);
        $_SESSION = [];
        $cookie = session_get_cookie_params();
        $cookieOptions = [
            'expires' => time() - 42000,
            'path' => (string) ($cookie['path'] ?: '/'),
            'secure' => (bool) $cookie['secure'],
            'httponly' => true,
            'samesite' => (string) ($cookie['samesite'] ?? 'Strict'),
        ];
        if (is_string($cookie['domain']) && $cookie['domain'] !== '') {
            $cookieOptions['domain'] = $cookie['domain'];
        }
        setcookie(session_name(), '', $cookieOptions);
        if (!session_destroy()) {
            throw new RuntimeException('Nie można zakończyć sesji.');
        }
        bridgeResponse(200, ['success' => true]);
    }

    $gateway = new CatalogTransferGateway(
        $database,
        bridgeConfigValue($config, 'transfer', 'key'),
        (string) ($config['transfer']['base_url'] ?? '/media-transfer')
    );
    $library = new LibraryBrowser($database);
    $actions = new CatalogActions($database);
    $groups = new PermissionGroups($database);
    $digest = new LibraryDigest(
        $database,
        Mailer::fromConfig($config),
        (string) ($config['app']['base_url'] ?? '/')
    );

    if ($method === 'GET' && $action === 'browse') {
        $kind = $_GET['kind'] ?? '';
        $directoryRaw = $_GET['directory_id'] ?? null;
        $directoryId = $directoryRaw === null || $directoryRaw === ''
            ? null
            : filter_var($directoryRaw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 10000]]);
        $limit = filter_var($_GET['limit'] ?? '48', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
        $query = $_GET['query'] ?? '';
        $sort = $_GET['sort'] ?? 'title_asc';
        $randomSeed = $_GET['random_seed'] ?? '';
        if (!is_string($kind) || ($directoryRaw !== null && $directoryRaw !== '' && !is_int($directoryId))
            || !is_int($page) || !is_int($limit) || !is_string($query) || !is_string($sort) || !is_string($randomSeed)) {
            throw new BridgeRequestException('Invalid library parameters.');
        }
        $filters = [
            'resolution' => $_GET['resolution'] ?? '',
            'hdr' => $_GET['hdr'] ?? '',
            'video_codec' => $_GET['video_codec'] ?? '',
            'audio_codec' => $_GET['audio_codec'] ?? '',
            // What the work is about and when it came out. Films carry a
            // catalogued genre, tracks carry whatever their tag says.
            'genre' => $_GET['genre'] ?? '',
            'tag_genre' => $_GET['tag_genre'] ?? '',
            'decade' => $_GET['decade'] ?? '',
            // Music: file format, whether every sample was kept, and hi-res masters.
            'format' => $_GET['format'] ?? '',
            'quality' => $_GET['quality'] ?? '',
            'hires' => $_GET['hires'] ?? '',
        ];
        foreach ($filters as $value) {
            if (!is_string($value)) {
                throw new BridgeRequestException('Invalid library filter.');
            }
        }
        $actions->assertLibraryAccess($identity, $kind);
        bridgeResponse(200, [
            'library' => $library->browse($identity, $kind, $directoryId, $query, $page, $limit, $sort, $randomSeed, $filters),
        ]);
    }
    if ($method === 'GET' && $action === 'library_filters') {
        $kind = $_GET['kind'] ?? '';
        if (!is_string($kind)) {
            throw new BridgeRequestException('Invalid library parameters.');
        }
        $actions->assertLibraryAccess($identity, $kind);
        bridgeResponse(200, ['filters' => $library->filterOptions($kind)]);
    }
    if ($method === 'GET' && $action === 'queue') {
        $kind = $_GET['kind'] ?? '';
        $directoryId = filter_var($_GET['directory_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $cursor = filter_var($_GET['after'] ?? '0', FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
        $limit = filter_var($_GET['limit'] ?? '160', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 1000]]);
        $direction = $_GET['direction'] ?? 'after';
        $query = $_GET['query'] ?? '';
        $shuffleMode = $_GET['shuffle_mode'] ?? 'off';
        $shuffleSeed = $_GET['shuffle_seed'] ?? '';
        $offset = filter_var($_GET['offset'] ?? '0', FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 1000000]]);
        if (
            !is_string($kind)
            || !is_int($directoryId)
            || !is_int($cursor)
            || !is_int($limit)
            || !is_string($direction)
            || !is_string($query)
            || !is_string($shuffleMode)
            || !is_string($shuffleSeed)
            || !is_int($offset)
            || !in_array($direction, ['before', 'after'], true)
        ) {
            throw new BridgeRequestException('Invalid queue parameters.');
        }
        $actions->assertLibraryAccess($identity, $kind);
        bridgeResponse(200, [
            'queue' => $library->queue(
                $identity,
                $kind,
                $directoryId,
                $cursor,
                $limit,
                $direction,
                $query,
                $shuffleMode,
                $shuffleSeed,
                $offset
            ),
        ]);
    }
    if ($method === 'GET' && $action === 'continue') {
        $limit = filter_var($_GET['limit'] ?? '12', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 50]]);
        if (!is_int($limit)) {
            throw new BridgeRequestException('Invalid continue parameters.');
        }
        // Both libraries in one answer, each filtered by what the group may reach —
        // the start page shows them side by side and must not ask twice.
        bridgeResponse(200, [
            'continue' => $library->continueWatching($identity, $actions->accessibleLibraries($identity), $limit),
        ]);
    }
    if ($method === 'GET' && $action === 'home') {
        // The whole start page in one answer; `shelf` asks for one shelf of it
        // ("show all") or for another roll of "surprise me" (`seed`).
        $limit = filter_var($_GET['limit'] ?? (string) HomeShelves::DEFAULT_LIMIT, FILTER_VALIDATE_INT);
        $shelf = $_GET['shelf'] ?? null;
        $seed = $_GET['seed'] ?? null;
        if (!is_int($limit) || ($shelf !== null && !is_string($shelf)) || ($seed !== null && !is_string($seed))) {
            throw new BridgeRequestException('Invalid home parameters.');
        }
        bridgeResponse(200, [
            'home' => (new HomeShelves($database, $library, $identity, $actions->accessibleLibraries($identity)))
                ->page($limit, $shelf === '' ? null : $shelf, $seed === '' ? null : $seed),
        ]);
    }
    if ($method === 'GET' && $action === 'up_next') {
        $mediaItemId = filter_var($_GET['media_item_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $limit = filter_var($_GET['limit'] ?? '8', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 24]]);
        if (!is_int($mediaItemId) || !is_int($limit)) {
            throw new BridgeRequestException('Invalid up-next parameters.');
        }
        $actions->assertLibraryAccess($identity, 'movies');
        bridgeResponse(200, ['up_next' => $library->upNext($identity, $mediaItemId, $limit)]);
    }
    if ($method === 'GET' && $action === 'account') {
        $username = $_GET['username'] ?? null;
        if ($username !== null && !is_string($username)) {
            throw new BridgeRequestException('Invalid profile name.');
        }
        bridgeResponse(200, ['account' => $actions->account($identity, $username)]);
    }
    if ($method === 'GET' && $action === 'profile_search') {
        $query = $_GET['query'] ?? '';
        if (!is_string($query)) {
            throw new BridgeRequestException('Invalid profile query.');
        }
        bridgeResponse(200, ['profiles' => $actions->profileSearch($identity, $query)]);
    }
    if ($method === 'GET' && $action === 'account_entries') {
        $section = $_GET['section'] ?? 'recent';
        $kind = $_GET['kind'] ?? 'all';
        $sort = $_GET['sort'] ?? 'newest';
        $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 10000]]);
        $limit = filter_var($_GET['limit'] ?? '20', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
        $username = $_GET['username'] ?? null;
        $randomSeed = $_GET['random_seed'] ?? '';
        if (!is_string($section) || !is_string($kind) || !is_string($sort) || !is_int($page) || !is_int($limit)
            || ($username !== null && !is_string($username)) || !is_string($randomSeed)) {
            throw new BridgeRequestException('Invalid account entries parameters.');
        }
        bridgeResponse(200, [
            'entries' => $actions->accountEntries($identity, $section, $kind, $sort, $page, $limit, $username, $randomSeed),
        ]);
    }
    if ($method === 'GET' && $action === 'collections') {
        $kind = $_GET['kind'] ?? null;
        $owner = $_GET['owner'] ?? 'mine';
        $visibility = $_GET['visibility'] ?? 'all';
        $sort = $_GET['sort'] ?? 'updated_desc';
        if (($kind !== null && !is_string($kind)) || !is_string($owner) || !is_string($visibility) || !is_string($sort)) {
            throw new BridgeRequestException('Invalid collection kind.');
        }
        bridgeResponse(200, [
            'collections' => $actions->collections($identity, $kind, $owner, $visibility, true, $sort),
        ]);
    }
    if ($method === 'GET' && $action === 'collection') {
        $collectionId = filter_var($_GET['collection_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 10000]]);
        $limit = filter_var($_GET['limit'] ?? '100', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
        $shuffleSeed = $_GET['shuffle_seed'] ?? '';
        $offset = filter_var($_GET['offset'] ?? '0', FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 1000000]]);
        $sort = $_GET['sort'] ?? 'position';
        if (!is_int($collectionId) || !is_int($page) || !is_int($limit) || !is_string($shuffleSeed)
            || !is_int($offset) || !is_string($sort)) {
            throw new BridgeRequestException('Invalid collection parameters.');
        }
        bridgeResponse(200, [
            'collection' => $actions->collectionPage($identity, $collectionId, $page, $limit, $shuffleSeed, $offset, $sort),
        ]);
    }
    if ($method === 'GET' && $action === 'collection_preview') {
        $collectionId = filter_var($_GET['collection_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($collectionId)) {
            throw new BridgeRequestException('Invalid playlist identifier.');
        }
        // No own cover: the card falls back to the artwork of what is on the
        // list, which it already has as preview candidates.
        $artwork = $actions->collectionArtwork($identity, $collectionId);
        if ($artwork === null) {
            bridgeResponse(404, ['error' => 'artwork_not_found']);
        }
        bridgeImageResponse($artwork['mime_type'], $artwork['image_data']);
    }
    if ($method === 'GET' && $action === 'admin_activity') {
        $event = $_GET['event'] ?? '';
        $actorRaw = $_GET['actor'] ?? '';
        $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 10000]]);
        $limit = filter_var($_GET['limit'] ?? '25', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
        $actor = $actorRaw === '' ? null : filter_var($actorRaw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_string($event) || !is_int($page) || !is_int($limit) || ($actorRaw !== '' && !is_int($actor))) {
            throw new BridgeRequestException('Invalid activity parameters.');
        }
        bridgeResponse(200, ['activity' => $actions->activityLog($identity, $event, $actor, $page, $limit)]);
    }
    if ($method === 'GET' && ($action === 'collection_export' || $action === 'ratings_export')) {
        // Sent as a download rather than as JSON: the browser saves the file
        // straight from the response, so nothing has to build a data: URL or
        // hold a whole playlist in memory on the client.
        if ($action === 'collection_export') {
            $collectionId = filter_var($_GET['collection_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            $format = $_GET['format'] ?? 'm3u';
            if (!is_int($collectionId) || !is_string($format)) {
                throw new BridgeRequestException('Invalid export parameters.');
            }
            $export = $actions->exportCollection($identity, $collectionId, $format);
        } else {
            $ratingsFormat = $_GET['format'] ?? 'csv';
            if (!is_string($ratingsFormat)) {
                throw new BridgeRequestException('Invalid export parameters.');
            }
            $export = $actions->exportRatings($identity, $ratingsFormat);
        }
        header('Content-Type: ' . $export['mime_type']);
        header('Content-Length: ' . strlen($export['body']));
        // The name is already stripped of anything but letters, digits, spaces,
        // "-" and "_", so it cannot break out of the header.
        header('Content-Disposition: ' . bridgeAttachmentHeader($export['filename']));
        header('Cache-Control: private, no-store');
        echo $export['body'];
        exit;
    }
    if ($method === 'GET' && $action === 'imports') {
        $importer = new PlaylistImporter($database, $actions);
        $idRaw = $_GET['import_id'] ?? '';
        $importId = $idRaw === '' ? null : filter_var($idRaw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($idRaw !== '' && !is_int($importId)) {
            throw new BridgeRequestException('Invalid import identifier.');
        }
        bridgeResponse(200, [
            'imports' => $importId === null
                ? ['pending' => $importer->pending($identity)]
                : $importer->status($identity, $importId),
        ]);
    }
    if ($method === 'GET' && $action === 'admin_title_folder_works') {
        $folder = $_GET['folder'] ?? '';
        $status = $_GET['status'] ?? 'review';
        if (!is_string($folder) || !is_string($status)) {
            throw new BridgeRequestException('Invalid folder parameters.');
        }
        bridgeResponse(200, ['works' => $actions->titleLookupFolderWorks($identity, $folder, $status)]);
    }
    if ($method === 'GET' && $action === 'admin_title_folders') {
        $status = $_GET['status'] ?? 'review';
        if (!is_string($status)) {
            throw new BridgeRequestException('Invalid lookup parameters.');
        }
        bridgeResponse(200, ['folders' => $actions->titleLookupFolders($identity, $status)]);
    }
    if ($method === 'GET' && $action === 'admin_title_lookups') {
        $status = $_GET['status'] ?? 'review';
        $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 10000]]);
        $limit = filter_var($_GET['limit'] ?? '25', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
        if (!is_string($status) || !is_int($page) || !is_int($limit)) {
            throw new BridgeRequestException('Invalid lookup parameters.');
        }
        bridgeResponse(200, ['lookups' => $actions->titleLookups($identity, $status, $page, $limit)]);
    }
    if ($method === 'GET' && $action === 'admin_indexing_status') {
        // What the "Indeksowanie" tab redraws while it is open: the same four
        // keys, in the same shapes, as in `admin` — and nothing else of it.
        bridgeResponse(200, ['indexing' => $actions->indexingStatus($identity)]);
    }
    if ($method === 'GET' && $action === 'admin') {
        bridgeResponse(200, [
            // Who the step-up ladder is asking, pausing or blocking (admins only:
            // adminOverview refuses anybody else before this list is read).
            'admin' => (static function (array $overview) use ($twoFactor): array {
                // Which accounts have 2FA on, for the user cards ("reset 2FA").
                $withTwoFactor = array_flip($twoFactor->enabledUserIds());
                $overview['users'] = array_map(
                    static fn (array $user): array => $user + ['two_factor' => isset($withTwoFactor[(int) $user['id']])],
                    $overview['users']
                );
                return $overview;
            })($actions->adminOverview($identity)) + ['groups' => $groups->all(), 'stepup' => $stepUp->recentSubjects()],
        ]);
    }
    if ($method === 'GET' && $action === 'preview') {
        $mediaItemId = filter_var($_GET['media_item_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($mediaItemId)) {
            throw new BridgeRequestException('Invalid preview identifier.');
        }
        $artwork = $actions->artwork($identity, $mediaItemId);
        if ($artwork !== null) {
            bridgeImageResponse($artwork['mime_type'], $artwork['image_data']);
        }
        // A preview grant opens /v1/thumbnails and nothing else; that route also
        // serves an image file as it is, so images need no door of their own.
        $transfer = $gateway->thumbnail($identity, $mediaItemId);
        // The browser may keep this answer for as long as the grant it points
        // at is good, less a margin: a cover drawn again inside that time costs
        // no request at all — not this one, and not the picture, which the
        // transfer service lets a browser keep for an hour under that address.
        // Uncached, every card of every listing was a PHP request and a new
        // address for the same picture.
        header('Cache-Control: private, max-age=' . CatalogTransferGateway::THUMBNAIL_REDIRECT_SECONDS);
        header_remove('Pragma');
        header('Location: ' . $transfer['url'], true, 302);
        exit;
    }
    if ($method === 'GET' && $action === 'session') {
        bridgeResponse(200, [
            'authenticated' => true,
            'user' => $identity->publicProfile(),
            'csrf_token' => $sessionBridge->csrfToken($_SESSION),
            'settings' => $actions->settingsSnapshot(),
            // Resolved from the caller's group rather than looked up by role, so
            // an operator-defined group applies without the client knowing how
            // groups are arranged.
            'permissions' => $groups->effective($identity->userId),
            // Per-account interface choices (what the queue shows, …).
            'preferences' => $actions->preferences($identity),
        ]);
    }
    if ($method === 'GET' && $action === 'guest_links') {
        // `links` stays a plain list for the page that reads it; `total` and
        // `limit` say when that list is only the newest part of it.
        $mine = (new GuestLinks($database))->mine($identity);
        bridgeResponse(200, [
            'links' => $mine['links'],
            'total' => $mine['total'],
            'limit' => $mine['limit'],
            'truncated' => $mine['total'] > count($mine['links']),
        ]);
    }
    if ($method === 'GET' && $action === 'digest') {
        // Two answers in one: what this account chose, and — for an operator —
        // how many accounts chose it and when a run last went out.
        $isAdmin = $identity->isOperator();
        bridgeResponse(200, [
            'digest' => $digest->subscription($identity->userId)
                + ($isAdmin ? ['server' => $digest->status()] : []),
        ]);
    }
    if ($method === 'GET' && $action === 'sessions') {
        $subject = filter_var($_GET['user_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        bridgeResponse(200, [
            'sessions' => $actions->activeSessions(
                $identity,
                is_int($subject) ? $subject : null,
                LegacySessionBridge::sessionFingerprint($sessionId),
                // What counts as open is what PHP itself would still accept.
                (int) ini_get('session.gc_maxlifetime')
            ),
        ]);
    }
    if ($method === 'GET' && $action === 'twofa') {
        $isOperator = $identity->isOperator();
        bridgeResponse(200, ['twofa' => $twoFactor->status($identity->userId) + [
            'required' => $isOperator && ($securitySettings['twofa_require_admins'] ?? '0') === '1',
        ]]);
    }
    if ($method === 'GET' && $action === 'visualizer_favorites') {
        bridgeResponse(200, $actions->visualizerFavorites($identity));
    }
    if ($method === 'GET' && $action === 'playback_queues') {
        // The asking device names itself so the answer can mark its own row;
        // matching identifiers is the server's job, not the client's.
        $device = $_GET['device_id'] ?? '';
        bridgeResponse(200, [
            'devices' => $actions->playbackQueues(
                $identity,
                is_string($device) ? $device : '',
                // "Live" is what the session panel calls open (see 'sessions').
                (int) ini_get('session.gc_maxlifetime')
            ),
        ]);
    }
    if ($method !== 'POST') {
        header('Allow: GET, POST');
        bridgeResponse(405, ['error' => 'method_not_allowed']);
    }

    $sessionBridge->assertCsrf($_SESSION, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null);
    $payload = bridgeJsonBody(match (true) {
        in_array($action, ['artwork', 'collection_artwork'], true) => 1000000,
        // A 2 MB document is roughly 2.7 MB once base64-encoded.
        $action === 'import_start' => 3000000,
        default => 65536,
    });


    if ($action === 'rating') {
        bridgeResponse(200, ['rating' => $actions->rate($identity, $payload)]);
    }
    if ($action === 'playback') {
        bridgeResponse(200, $actions->playback($identity, $payload));
    }
    if ($action === 'guest_link_create') {
        $actions->assertCanShare($identity);
        $appStepUp('guest_link');
        bridgeResponse(201, ['link' => (new GuestLinks($database))->issue(
            $identity,
            $payload,
            rtrim((string) ($config['app']['base_url'] ?? '/'), '/')
        )]);
    }
    if ($action === 'guest_link_revoke') {
        bridgeResponse(200, (new GuestLinks($database))->revoke($identity, $payload));
    }
    if ($action === 'digest_subscribe') {
        $frequency = $payload['frequency'] ?? 'off';
        if (!is_string($frequency)) {
            throw new BridgeRequestException('Nieprawidłowa częstotliwość powiadomień.');
        }
        $digest->subscribe($identity->userId, $frequency);
        bridgeResponse(200, ['success' => true, 'digest' => $digest->subscription($identity->userId)]);
    }
    if ($action === 'digest_send') {
        // The panel's "send now": ignores the weekly wait, never the choice.
        if (!$identity->isOperator()) {
            throw new BridgeAuthorizationException('Ta operacja wymaga uprawnień administratora.');
        }
        // Twenty seconds of mail at most inside this request; whoever is left
        // is reported as `deferred` and goes out when the button is pressed
        // again (or with the scheduled run).
        bridgeResponse(200, $digest->run(true, null, 20.0) + ['success' => true]);
    }
    if ($action === 'session_revoke') {
        // Closing "everywhere else" must not close the browser asking for it.
        $payload['keep_fingerprint'] = LegacySessionBridge::sessionFingerprint($sessionId);
        bridgeResponse(200, $actions->revokeSessions($identity, $payload));
    }
    if ($action === 'visualizer_favorites_save') {
        bridgeResponse(200, $actions->saveVisualizerFavorites($identity, $payload));
    }
    if ($action === 'playback_queue_save') {
        // The row remembers the session saving it, so the device list can follow
        // sign-outs; the session's fingerprint, never its identifier.
        bridgeResponse(200, $actions->savePlaybackQueue(
            $identity,
            $payload,
            LegacySessionBridge::sessionFingerprint($sessionId)
        ));
    }
    if ($action === 'playback_queue_forget') {
        bridgeResponse(200, $actions->forgetPlaybackQueue($identity, $payload));
    }
    if ($action === 'playback_queue_claim') {
        bridgeResponse(200, $actions->claimPlaybackQueue($identity, $payload));
    }
    if ($action === 'continue_dismiss') {
        bridgeResponse(200, $actions->dismissContinue($identity, $payload));
    }
    if ($action === 'home_dismiss') {
        // "Nie proponuj" on a suggestion of the start page, its undo, and
        // `{"reset": true}` to forget every one of them.
        bridgeResponse(200, (new HomeShelves(
            $database,
            $library,
            $identity,
            $actions->accessibleLibraries($identity)
        ))->dismiss($payload));
    }
    if ($action === 'profile_visibility') {
        bridgeResponse(200, $actions->setProfileVisibility($identity, $payload));
    }
    if ($action === 'account_preferences') {
        bridgeResponse(200, $actions->savePreferences($identity, $payload));
    }
    if ($action === 'metadata') {
        bridgeResponse(200, $actions->saveMetadata($identity, $payload));
    }
    if ($action === 'artwork') {
        bridgeResponse(200, $actions->saveArtwork($identity, $payload));
    }
    if ($action === 'collection_create') {
        bridgeResponse(201, $actions->createCollection($identity, $payload));
    }
    if ($action === 'collection_update') {
        bridgeResponse(200, $actions->updateCollection($identity, $payload));
    }
    if ($action === 'collection_reorder') {
        bridgeResponse(200, $actions->reorderCollection($identity, $payload));
    }
    if ($action === 'collection_move') {
        bridgeResponse(200, $actions->moveCollectionItem($identity, $payload));
    }
    if ($action === 'collection_delete') {
        bridgeResponse(200, $actions->deleteCollection($identity, $payload));
    }
    if ($action === 'collection_share') {
        bridgeResponse(200, $actions->setCollectionShared($identity, $payload));
    }
    if ($action === 'collection_item') {
        bridgeResponse(200, $actions->setCollectionItem($identity, $payload));
    }
    if ($action === 'collection_rating') {
        bridgeResponse(200, ['rating' => $actions->rateCollection($identity, $payload)]);
    }
    if ($action === 'collection_artwork') {
        bridgeResponse(200, $actions->saveCollectionArtwork($identity, $payload));
    }
    if ($action === 'collection_archive') {
        $collectionId = $payload['collection_id'] ?? null;
        $name = $payload['download_name'] ?? 'playlista.zip';
        if (!is_int($collectionId) || !is_string($name)) {
            throw new BridgeRequestException('Invalid playlist archive request.');
        }
        $gateway->assertDownloadScope($identity, 'folder');
        $appStepUp('download');
        $ids = $actions->archiveCollectionItemIds($identity, $collectionId);
        // A playlist is a named collection of tracks, like a folder.
        bridgeResponse(200, ['transfer' => $gateway->archive($identity, $ids, $name, 'folder')]);
    }
    if ($action === 'admin_user_create') {
        bridgeResponse(201, $actions->createUser($identity, $payload));
    }
    if ($action === 'admin_user_update') {
        bridgeResponse(200, $actions->updateUser($identity, $payload));
    }
    if ($action === 'admin_user_activate') {
        bridgeResponse(200, $actions->activateUser($identity, $payload));
    }
    if ($action === 'admin_user_delete') {
        bridgeResponse(200, $actions->deleteUser($identity, $payload));
    }
    if ($action === 'admin_user_resend_activation') {
        if (!$identity->isOperator()) {
            throw new BridgeAuthorizationException('Wymagane są uprawnienia administratora.');
        }
        $userId = filter_var($payload['user_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($userId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator konta.');
        }
        bridgeResponse(200, ['success' => true, 'spooled' => $accounts->adminResendActivation($userId)]);
    }
    if ($action === 'account_password') {
        $current = $payload['current_password'] ?? '';
        $new = $payload['new_password'] ?? '';
        $confirm = $payload['new_password_confirm'] ?? '';
        if (!is_string($current) || !is_string($new) || !is_string($confirm) || !hash_equals($new, $confirm)) {
            throw new BridgeRequestException('Potwierdzenie hasła nie pasuje.');
        }
        $accounts->changePassword($identity->userId, $current, $new, $clientAddress);
        // Everywhere else signs out; this browser stays.
        $sessionBridge->revokeOtherSessions($sessionId, $identity->userId, $identity->userId);
        bridgeResponse(200, ['success' => true]);
    }
    if ($action === 'twofa_begin' || $action === 'twofa_confirm' || $action === 'twofa_disable' || $action === 'twofa_recovery') {
        // Turning 2FA on starts with the password (a borrowed session must not
        // lock the owner out with a phone the owner has never seen); off, and a
        // new set of recovery codes, take the password and a code.
        $password = is_string($payload['current_password'] ?? null) ? $payload['current_password'] : '';
        $code = is_string($payload['code'] ?? null) ? $payload['code'] : '';
        if ($action === 'twofa_confirm') {
            $accounts->assertSecondFactorAllowed($clientAddress, $identity->userId);
            $codes = $twoFactor->confirmSetup($identity->userId, $code);
            if ($codes === []) {
                $accounts->recordSecondFactor($clientAddress, $identity->userId, false);
                throw new BridgeRequestException('Nieprawidłowy kod.');
            }
            $actions->auditEvent($identity->userId, 'user.twofa_enable', 'user', (string) $identity->userId);
            bridgeResponse(200, ['recovery_codes' => $codes, 'twofa' => $twoFactor->status($identity->userId)]);
        }
        if (!$accounts->verifyPassword($identity->userId, $password, $clientAddress)) {
            throw new BridgeRequestException('Obecne hasło jest nieprawidłowe.');
        }
        if ($action === 'twofa_begin') {
            bridgeResponse(200, $twoFactor->beginSetup($identity->userId, $identity->username, $twoFactorIssuer));
        }
        $accepted = $twoFactor->verify($identity->userId, $code);
        if ($accepted === null) {
            $accounts->recordSecondFactor($clientAddress, $identity->userId, false);
            throw new BridgeRequestException('Nieprawidłowy kod.');
        }
        if ($action === 'twofa_disable') {
            $twoFactor->disable($identity->userId);
            $actions->auditEvent($identity->userId, 'user.twofa_disable', 'user', (string) $identity->userId, ['with' => $accepted]);
            bridgeResponse(200, ['twofa' => $twoFactor->status($identity->userId)]);
        }
        $codes = $twoFactor->regenerateRecovery($identity->userId);
        $actions->auditEvent($identity->userId, 'user.twofa_recovery', 'user', (string) $identity->userId);
        bridgeResponse(200, ['recovery_codes' => $codes, 'twofa' => $twoFactor->status($identity->userId)]);
    }
    if ($action === 'admin_user_twofa_reset') {
        $userId = filter_var($payload['user_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($userId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator konta.');
        }
        $actions->assertManageableUser($identity, $userId);
        $removed = $twoFactor->disable($userId);
        $actions->auditEvent($identity->userId, 'user.twofa_reset', 'user', (string) $userId, ['had_two_factor' => $removed]);
        bridgeResponse(200, ['success' => true, 'removed' => $removed]);
    }
    if ($action === 'account_email_request') {
        $email = $payload['email'] ?? '';
        $password = $payload['current_password'] ?? '';
        if (!is_string($email) || !is_string($password)) {
            throw new BridgeRequestException('Nieprawidłowe dane żądania.');
        }
        // Reports success whether or not the address was free, so this endpoint
        // cannot be used to probe which mailboxes have accounts.
        $result = $accounts->requestEmailChange($identity->userId, $email, $password);
        bridgeResponse(200, ['success' => true, 'spooled' => $result['spooled']]);
    }
    if ($action === 'admin_group_save') {
        if (!$identity->isOperator()) {
            throw new BridgeAuthorizationException('Brak uprawnień administratora.');
        }
        $id = $groups->save($payload);
        bridgeResponse(200, ['success' => true, 'id' => $id, 'groups' => $groups->all()]);
    }
    if ($action === 'admin_group_delete') {
        if (!$identity->isOperator()) {
            throw new BridgeAuthorizationException('Brak uprawnień administratora.');
        }
        $id = filter_var($payload['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($id)) {
            throw new BridgeRequestException('Invalid group identifier.');
        }
        $replacement = filter_var($payload['replacement_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $groups->delete($id, is_int($replacement) ? $replacement : null);
        bridgeResponse(200, ['success' => true, 'groups' => $groups->all()]);
    }
    if ($action === 'admin_stepup_release') {
        if (!$identity->isOperator()) {
            throw new BridgeAuthorizationException('Ta operacja wymaga uprawnień administratora.');
        }
        $subject = $payload['subject'] ?? null;
        if (!is_string($subject)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator.');
        }
        $stepUp->release($subject, $identity->userId);
        bridgeResponse(200, ['success' => true, 'stepup' => $stepUp->recentSubjects()]);
    }
    if ($action === 'admin_settings') {
        bridgeResponse(200, $actions->saveAdminSettings($identity, $payload));
    }
    if ($action === 'import_start' || $action === 'import_resolve'
        || $action === 'import_apply' || $action === 'import_discard') {
        $importer = new PlaylistImporter($database, $actions);
        if ($action === 'import_start') {
            // The document arrives base64-encoded inside the JSON body: the
            // bridge speaks JSON everywhere else, and a multipart upload here
            // would be a second request shape to guard. 2 MB of file is about
            // 2.7 MB encoded, which is what bridgeJsonBody was told to allow.
            $encoded = $payload['content'] ?? '';
            $sourceName = $payload['source_name'] ?? 'playlist';
            $mediaKind = $payload['media_kind'] ?? 'music';
            if (!is_string($encoded) || !is_string($sourceName) || !is_string($mediaKind)) {
                throw new BridgeRequestException('Nieprawidłowe dane importu.');
            }
            $document = base64_decode($encoded, true);
            if ($document === false) {
                throw new BridgeRequestException('Nie udało się odczytać przesłanego pliku.');
            }
            bridgeResponse(200, ['import' => $importer->start($identity, $document, $sourceName, $mediaKind)]);
        }
        $importId = filter_var($payload['import_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($action === 'import_resolve') {
            bridgeResponse(200, $importer->resolve($identity, $payload));
        }
        if (!is_int($importId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator importu.');
        }
        if ($action === 'import_apply') {
            bridgeResponse(200, $importer->apply($identity, $importId, $payload));
        }
        bridgeResponse(200, $importer->discard($identity, $importId));
    }
    if ($action === 'admin_title_folder_decide') {
        bridgeResponse(200, $actions->decideTitleLookupFolder($identity, $payload));
    }
    if ($action === 'admin_title_lookup_decide') {
        bridgeResponse(200, $actions->decideTitleLookup($identity, $payload));
    }
    if ($action === 'admin_scan' || $action === 'admin_subtitles' || $action === 'admin_metadata'
        || $action === 'admin_metadata_retry' || $action === 'admin_title_worker' || $action === 'admin_stats') {
        if (!$identity->isOperator()) {
            throw new BridgeAuthorizationException('Brak uprawnień administratora.');
        }
        $internalUrl = rtrim((string) ($config['transfer']['internal_url'] ?? 'http://127.0.0.1:8765'), '/');
        if (preg_match('#^http://(?:127\.0\.0\.1|\[::1\]|localhost):[0-9]{1,5}$#D', $internalUrl) !== 1) {
            throw new RuntimeException('Wewnętrzny adres usługi musi wskazywać loopback.');
        }
        if ($action === 'admin_stats') {
            // The service keeps the diary; the panel draws it. Nothing here
            // interprets the numbers — they pass through as they were written.
            $hours = filter_var($payload['hours'] ?? 24, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 720]]);
            if (!is_int($hours)) {
                throw new BridgeRequestException('Nieprawidłowy zakres statystyk.');
            }
            $result = bridgeInternalPost($internalUrl . '/v1/stats', bridgeInternalApiKey(bridgeConfigValue($config, 'transfer', 'key')), ['hours' => $hours]);
            bridgeResponse(200, ['stats' => $result]);
        }
        if ($action === 'admin_subtitles') {
            $result = bridgeInternalPost($internalUrl . '/v1/subtitle-cache', bridgeInternalApiKey(bridgeConfigValue($config, 'transfer', 'key')), $payload);
            $started = ($payload['operation'] ?? 'status') === 'start' && ($result['state'] ?? '') !== 'running';
            bridgeResponse($started ? 202 : 200, ['subtitles' => $result]);
        }
        if ($action === 'admin_metadata') {
            $limit = filter_var($payload['limit'] ?? 200, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 5000]]);
            if (!is_int($limit)) {
                throw new BridgeRequestException('Nieprawidłowy rozmiar porcji.');
            }
            $result = bridgeInternalPost($internalUrl . '/v1/metadata-worker', bridgeInternalApiKey(bridgeConfigValue($config, 'transfer', 'key')), ['limit' => $limit]);
            bridgeResponse(($result['status'] ?? '') === 'already_running' ? 200 : 202, ['metadata' => $result]);
        }
        if ($action === 'admin_metadata_retry') {
            // One file (`media_item_id`) or every failed reading (no id). The
            // worker is then started the way the panel's own button starts it,
            // with a batch the size of what went back: the retried jobs keep
            // their old ids, so they are the ones it takes, and whatever a scan
            // queued later waits for an ordinary run.
            $itemRaw = $payload['media_item_id'] ?? null;
            $itemId = $itemRaw === null ? null : filter_var($itemRaw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if ($itemRaw !== null && !is_int($itemId)) {
                throw new BridgeRequestException('Nieprawidłowy identyfikator pliku.');
            }
            $requeued = $actions->retryMetadataJobs($identity, $itemId);
            if ($requeued === 0) {
                bridgeResponse(200, ['requeued' => 0, 'metadata' => null]);
            }
            try {
                $result = bridgeInternalPost(
                    $internalUrl . '/v1/metadata-worker',
                    bridgeInternalApiKey(bridgeConfigValue($config, 'transfer', 'key')),
                    ['limit' => min(5000, $requeued)]
                );
            } catch (RuntimeException $error) {
                // Queued all the same: the next run, scheduled or by hand, reads them.
                error_log('TryHackX bridge: metadata worker not started after retry: ' . $error->getMessage());
                bridgeResponse(200, ['requeued' => $requeued, 'metadata' => ['status' => 'not_started']]);
            }
            bridgeResponse(($result['status'] ?? '') === 'already_running' ? 200 : 202, [
                'requeued' => $requeued,
                'metadata' => $result,
            ]);
        }
        if ($action === 'admin_title_worker') {
            $limit = filter_var($payload['limit'] ?? 50, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 5000]]);
            $root = $payload['root'] ?? 'movies';
            if (!is_int($limit) || !is_string($root) || preg_match('/^[a-z][a-z0-9_-]{0,31}$/D', $root) !== 1) {
                throw new BridgeRequestException('Nieprawidłowe parametry wyszukiwania gatunków.');
            }
            $result = bridgeInternalPost($internalUrl . '/v1/title-worker', bridgeInternalApiKey(bridgeConfigValue($config, 'transfer', 'key')), ['limit' => $limit, 'root' => $root]);
            bridgeResponse(($result['status'] ?? '') === 'already_running' ? 200 : 202, ['title_worker' => $result]);
        }
        $root = $payload['root'] ?? null;
        $kind = $payload['kind'] ?? null;
        if (!is_string($root) || preg_match('/^[a-z][a-z0-9_-]{0,31}$/D', $root) !== 1
            || !is_string($kind) || !in_array($kind, ['music', 'movies', 'mixed'], true)) {
            throw new BridgeRequestException('Nieprawidłowe parametry skanu.');
        }
        $result = bridgeInternalPost($internalUrl . '/v1/catalog-scan', bridgeInternalApiKey(bridgeConfigValue($config, 'transfer', 'key')), ['root' => $root, 'kind' => $kind]);
        bridgeResponse(202, ['scan' => $result]);
    }
    if ($action === 'search_archive') {
        $directoryId = $payload['directory_id'] ?? null;
        $kind = $payload['kind'] ?? null;
        $query = $payload['query'] ?? null;
        $name = $payload['download_name'] ?? 'wyniki-wyszukiwania.zip';
        if (!is_int($directoryId) || !is_string($kind) || !is_string($query) || !is_string($name)) {
            throw new BridgeRequestException('Invalid search archive request.');
        }
        // Rights first: a group that may not do this should hear so, not "too
        // many files" from the collector — and a library it cannot open should
        // not even be searched.
        $actions->assertLibraryAccess($identity, $kind);
        $gateway->assertDownloadScope($identity, 'selection');
        $appStepUp('download');
        $ids = $library->archiveSearchItemIds($kind, $directoryId, $query);
        // Results the caller narrowed down themselves: the same decision as
        // ticking files by hand.
        bridgeResponse(200, ['transfer' => $gateway->archive($identity, $ids, $name, 'selection')]);
    }
    if ($action === 'directory_archive') {
        $directoryId = $payload['directory_id'] ?? null;
        $kind = $payload['kind'] ?? null;
        $name = $payload['download_name'] ?? 'folder.zip';
        if (!is_int($directoryId) || !is_string($kind) || !is_string($name)) {
            throw new BridgeRequestException('Invalid folder archive request.');
        }
        $actions->assertLibraryAccess($identity, $kind);
        $scope = $library->directoryScope($kind, $directoryId);
        $gateway->assertDownloadScope($identity, $scope);
        $appStepUp('download');
        $ids = $library->archiveItemIds($kind, $directoryId);
        // Taking the root is taking the library, which is its own decision.
        bridgeResponse(200, ['transfer' => $gateway->archive($identity, $ids, $name, $scope)]);
    }
    if ($action === 'file') {
        $mediaItemId = $payload['media_item_id'] ?? null;
        if (!is_int($mediaItemId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator pliku.');
        }
        $inline = $payload['inline'] ?? true;
        if (!is_bool($inline)) {
            throw new BridgeRequestException('Nieprawidłowy tryb transferu.');
        }
        if (!$inline) {
            // Playing is not downloading; only a real download climbs this ladder.
            $appStepUp('download');
        }
        bridgeResponse(200, ['transfer' => $gateway->file($identity, $mediaItemId, $inline)]);
    }

    if ($action === 'stereo') {
        $mediaItemId = $payload['media_item_id'] ?? null;
        if (!is_int($mediaItemId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator filmu.');
        }
        $appStepUp('compat');
        bridgeResponse(200, ['transfer' => $gateway->stereo($identity, $mediaItemId)]);
    }

    if ($action === 'archive') {
        $ids = $payload['media_item_ids'] ?? null;
        $name = $payload['download_name'] ?? 'media.zip';
        if (!is_array($ids) || !is_string($name)) {
            throw new BridgeRequestException('Nieprawidłowe dane archiwum.');
        }
        $gateway->assertDownloadScope($identity, 'selection');
        $appStepUp('download');
        bridgeResponse(200, ['transfer' => $gateway->archive($identity, $ids, $name)]);
    }

    bridgeResponse(404, ['error' => 'not_found']);
} catch (BridgeAuthenticationException) {
    bridgeResponse(401, ['error' => 'authentication_required']);
// The four client-error classes carry operator-written, user-facing messages
// (which library/limit/right was hit), so the interface can show the reason
// instead of a generic status; anything else stays opaque below.
} catch (BridgeAuthorizationException $error) {
    bridgeResponse(403, ['error' => 'forbidden', 'message' => $error->getMessage()]);
} catch (CatalogItemNotFoundException $error) {
    bridgeResponse(404, ['error' => 'media_not_found', 'message' => $error->getMessage()]);
} catch (BridgeRateLimitException $error) {
    if ($error->reason !== '' && isset($clientDigest, $action) && is_string($action)) {
        bridgeAuthLog($error->reason === 'blocked' ? 'blocked' : 'paused', $clientDigest, $action);
    }
    if ($error->retryAfter > 0) {
        header('Retry-After: ' . $error->retryAfter);
    }
    bridgeResponse(429, ['error' => 'rate_limited', 'message' => $error->getMessage()]
        + ($error->retryAfter > 0 ? ['retry_after' => $error->retryAfter] : []));
} catch (BridgeCaptchaRequiredException $error) {
    // 428 Precondition Required: nothing is wrong with the request, it may go on
    // once a person proves to be there. The page shows the challenge named here,
    // trades the solution for a pass (`captcha_pass`) and repeats the request.
    // The CSRF token rides along so even a page that has none yet can do that.
    // An open session may still be given one; a session already written and
    // released (every signed-in action) hands out the one it has.
    $challengeToken = null;
    if (isset($sessionBridge)) {
        $challengeToken = session_status() === PHP_SESSION_ACTIVE
            ? $sessionBridge->csrfToken($_SESSION)
            : $sessionBridge->storedCsrfToken($_SESSION ?? []);
    }
    bridgeResponse(428, [
        'error' => 'captcha_required',
        'message' => $error->getMessage(),
        'captcha' => $error->challenge,
    ] + ($challengeToken !== null ? ['csrf_token' => $challengeToken] : []));
} catch (BridgeUnavailableException $error) {
    // Something the request depends on is not answering (a captcha provider):
    // worth a retry, and worth saying so rather than "internal error".
    header('Retry-After: 30');
    bridgeResponse(503, ['error' => 'unavailable', 'message' => $error->getMessage()]);
} catch (BridgeRequestException $error) {
    bridgeResponse(422, ['error' => 'invalid_request', 'message' => $error->getMessage()]);
} catch (JsonException) {
    bridgeResponse(422, ['error' => 'invalid_request']);
} catch (Throwable $error) {
    error_log('TryHackX bridge failure: ' . $error::class . ': ' . $error->getMessage());
    bridgeResponse(500, ['error' => 'internal_error']);
}
