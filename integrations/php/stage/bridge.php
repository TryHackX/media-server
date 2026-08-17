<?php

declare(strict_types=1);

use TryHackX\Media\Integration\AccountGateway;
use TryHackX\Media\Integration\BridgeAuthenticationException;
use TryHackX\Media\Integration\BridgeAuthorizationException;
use TryHackX\Media\Integration\BridgeConfigLoader;
use TryHackX\Media\Integration\BridgeRateLimitException;
use TryHackX\Media\Integration\BridgeRequestException;
use TryHackX\Media\Integration\CatalogItemNotFoundException;
use TryHackX\Media\Integration\CatalogTransferGateway;
use TryHackX\Media\Integration\GuestLinks;
use TryHackX\Media\Integration\LegacySessionBridge;
use TryHackX\Media\Integration\LibraryBrowser;
use TryHackX\Media\Integration\LibraryDigest;
use TryHackX\Media\Integration\Mailer;
use TryHackX\Media\Integration\PermissionGroups;
use TryHackX\Media\Integration\CaptchaGuard;
use TryHackX\Media\Integration\CatalogActions;
use TryHackX\Media\Integration\PlaylistImporter;

require_once __DIR__ . '/../BridgeException.php';
require_once __DIR__ . '/../LegacyIdentity.php';
require_once __DIR__ . '/../LegacySessionBridge.php';
require_once __DIR__ . '/../TransferToken.php';
require_once __DIR__ . '/../CatalogTransferGateway.php';
require_once __DIR__ . '/../LibraryBrowser.php';
require_once __DIR__ . '/../CatalogActions.php';
require_once __DIR__ . '/../BridgeConfigLoader.php';
require_once __DIR__ . '/../Mailer.php';
require_once __DIR__ . '/../AccountGateway.php';
require_once __DIR__ . '/../CaptchaGuard.php';
require_once __DIR__ . '/../PermissionGroups.php';
require_once __DIR__ . '/../GuestLinks.php';
require_once __DIR__ . '/../LibraryDigest.php';
require_once __DIR__ . '/../PlaylistParser.php';
require_once __DIR__ . '/../PlaylistImporter.php';

ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('Referrer-Policy: no-referrer');

/** @param array<string, mixed> $payload */
function bridgeResponse(int $status, array $payload): never
{
    http_response_code($status);
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

/** @param array<string, mixed> $config */
function bridgeConfigValue(array $config, string $section, string $key): string
{
    $value = $config[$section][$key] ?? null;
    if (!is_string($value) || $value === '') {
        throw new RuntimeException("Brak konfiguracji: {$section}.{$key}");
    }
    return $value;
}
/** @param array<string, mixed> $payload
 *  @return array<string, mixed>
 */
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

    $isHttps = isset($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off';
    $requiresHttps = ($config['session']['require_https'] ?? true) === true;
    $remoteAddress = $_SERVER['REMOTE_ADDR'] ?? '';
    $allowsLocalHttp = getenv('TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL') === '1'
        && is_string($remoteAddress)
        && in_array($remoteAddress, ['127.0.0.1', '::1'], true);
    if ($requiresHttps && !$isHttps && !$allowsLocalHttp) {
        throw new BridgeRequestException('Ten endpoint wymaga HTTPS.');
    }

    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.cookie_httponly', '1');
    session_name((string) ($config['session']['name'] ?? 'TRYHACKXSESSID'));
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $isHttps,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    if (!session_start()) {
        throw new RuntimeException('Nie można uruchomić sesji.');
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
    $sessionBridge = new LegacySessionBridge($database);

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $action = $_GET['action'] ?? 'session';
    if (!is_string($action)) {
        throw new BridgeRequestException('Nieprawidłowa akcja.');
    }

    // Signing in, signing up and activating all happen before there is an
    // identity to authenticate, so they are dispatched ahead of the gate below.
    $accounts = new AccountGateway(
        $database,
        Mailer::fromConfig($config),
        (string) ($config['app']['base_url'] ?? '/media-next/')
    );
    $clientAddress = is_string($_SERVER['REMOTE_ADDR'] ?? null) ? $_SERVER['REMOTE_ADDR'] : '';

    $captcha = new CaptchaGuard($accounts->securitySettings());

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
            ],
            'csrf_token' => $sessionBridge->csrfToken($_SESSION),
        ]);
    }

    if ($action === 'login' || $action === 'register' || $action === 'activate'
        || $action === 'resend_activation' || $action === 'email_change_confirm') {
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

        if ($action === 'login') {
            $captcha->assertSolved('login', $text('captcha_token'), $clientAddress);
            $identity = $accounts->login($_SESSION, $text('username'), $text('password'), $clientAddress);
            $sessionBridge->bindSession($_SESSION, $identity->userId);
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
            ]);
        }
        if ($action === 'register') {
            $captcha->assertSolved('register', $text('captcha_token'), $clientAddress);
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
        $guestLibrary = new LibraryBrowser($database);
        if ($method === 'GET' && $action === 'guest') {
            $token = $_GET['token'] ?? '';
            bridgeResponse(200, ['guest' => $guests->open(is_string($token) ? $token : '', $guestLibrary)]);
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
            'transfer' => $guests->transfer($token, $itemId, $inline, $guestLibrary, $guestGateway),
        ]);
    }

    $identity = $sessionBridge->authenticate($_SESSION);
    $sessionBridge->hardenActiveSession($_SESSION, $identity);
    // After hardening, because that is what settles the identifier this session
    // will be known by. Refuses the request if the session was closed elsewhere.
    $sessionBridge->trackSession(
        $_SESSION,
        $identity,
        session_id() ?: '',
        is_string($_SERVER['HTTP_USER_AGENT'] ?? null) ? $_SERVER['HTTP_USER_AGENT'] : '',
        $clientAddress
    );

    if ($action === 'logout') {
        if ($method !== 'POST') {
            header('Allow: POST');
            bridgeResponse(405, ['error' => 'method_not_allowed']);
        }
        $sessionBridge->assertCsrf($_SESSION, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null);
        // Close the row before the session goes, otherwise the panel would keep
        // listing a browser that signed itself out until the row aged away.
        $sessionBridge->revokeCurrentSession(session_id() ?: '', $identity->userId);
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
        (string) ($config['app']['base_url'] ?? '/media-next/')
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
        header('Content-Type: ' . $artwork['mime_type']);
        header('Content-Length: ' . strlen($artwork['image_data']));
        header('Cache-Control: private, max-age=3600, must-revalidate');
        echo $artwork['image_data'];
        exit;
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
        header('Content-Disposition: attachment; filename="' . $export['filename'] . '"');
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
    if ($method === 'GET' && $action === 'admin') {
        bridgeResponse(200, [
            'admin' => $actions->adminOverview($identity) + ['groups' => $groups->all()],
        ]);
    }
    if ($method === 'GET' && $action === 'preview') {
        $mediaItemId = filter_var($_GET['media_item_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if (!is_int($mediaItemId)) {
            throw new BridgeRequestException('Invalid preview identifier.');
        }
        $artwork = $actions->artwork($mediaItemId);
        if ($artwork !== null) {
            header('Content-Type: ' . $artwork['mime_type']);
            header('Content-Length: ' . strlen($artwork['image_data']));
            header('Cache-Control: private, max-age=3600, must-revalidate');
            echo $artwork['image_data'];
            exit;
        }
        $transfer = $gateway->file($identity, $mediaItemId, true);
        // Images can be served immediately by every transfer-service version.
        // Video previews use the thumbnail endpoint added in M4.
        $location = $transfer['media_kind'] === 'image'
            ? $transfer['url']
            : str_replace('/v1/files/', '/v1/thumbnails/', $transfer['url']);
        header('Location: ' . $location, true, 302);
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
        bridgeResponse(200, ['links' => (new GuestLinks($database))->mine($identity)]);
    }
    if ($method === 'GET' && $action === 'digest') {
        // Two answers in one: what this account chose, and — for an operator —
        // how many accounts chose it and when a run last went out.
        $isAdmin = in_array($identity->role, ['admin', 'super_admin'], true) && !$identity->isGuest;
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
                LegacySessionBridge::sessionFingerprint(session_id() ?: ''),
                // What counts as open is what PHP itself would still accept.
                (int) ini_get('session.gc_maxlifetime')
            ),
        ]);
    }
    if ($method === 'GET' && $action === 'playback_queues') {
        // The asking device names itself so the answer can mark its own row;
        // matching identifiers is the server's job, not the client's.
        $device = $_GET['device_id'] ?? '';
        bridgeResponse(200, [
            'devices' => $actions->playbackQueues($identity, is_string($device) ? $device : ''),
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
        bridgeResponse(201, ['link' => (new GuestLinks($database))->issue(
            $identity,
            $payload,
            rtrim((string) ($config['app']['base_url'] ?? '/media-next/'), '/')
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
        if (!in_array($identity->role, ['admin', 'super_admin'], true) || $identity->isGuest) {
            throw new BridgeAuthorizationException('Ta operacja wymaga uprawnień administratora.');
        }
        bridgeResponse(200, $digest->run(true) + ['success' => true]);
    }
    if ($action === 'session_revoke') {
        // Closing "everywhere else" must not close the browser asking for it.
        $payload['keep_fingerprint'] = LegacySessionBridge::sessionFingerprint(session_id() ?: '');
        bridgeResponse(200, $actions->revokeSessions($identity, $payload));
    }
    if ($action === 'playback_queue_save') {
        bridgeResponse(200, $actions->savePlaybackQueue($identity, $payload));
    }
    if ($action === 'playback_queue_claim') {
        bridgeResponse(200, $actions->claimPlaybackQueue($identity, $payload));
    }
    if ($action === 'continue_dismiss') {
        bridgeResponse(200, $actions->dismissContinue($identity, $payload));
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
    if ($action === 'admin_user_resend_activation') {
        if (!in_array($identity->role, ['admin', 'super_admin'], true) || $identity->isGuest) {
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
        $accounts->changePassword($identity->userId, $current, $new);
        bridgeResponse(200, ['success' => true]);
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
        if (!in_array($identity->role, ['admin', 'super_admin'], true) || $identity->isGuest) {
            throw new BridgeAuthorizationException('Brak uprawnień administratora.');
        }
        $id = $groups->save($payload);
        bridgeResponse(200, ['success' => true, 'id' => $id, 'groups' => $groups->all()]);
    }
    if ($action === 'admin_group_delete') {
        if (!in_array($identity->role, ['admin', 'super_admin'], true) || $identity->isGuest) {
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
        || $action === 'admin_title_worker' || $action === 'admin_stats') {
        if (!in_array($identity->role, ['admin', 'super_admin'], true) || $identity->isGuest) {
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
        // many files" from the collector.
        $gateway->assertDownloadScope($identity, 'selection');
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
        $scope = $library->directoryScope($kind, $directoryId);
        $gateway->assertDownloadScope($identity, $scope);
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
        bridgeResponse(200, ['transfer' => $gateway->file($identity, $mediaItemId, $inline)]);
    }

    if ($action === 'stereo') {
        $mediaItemId = $payload['media_item_id'] ?? null;
        if (!is_int($mediaItemId)) {
            throw new BridgeRequestException('Nieprawidłowy identyfikator filmu.');
        }
        bridgeResponse(200, ['transfer' => $gateway->stereo($identity, $mediaItemId)]);
    }

    if ($action === 'archive') {
        $ids = $payload['media_item_ids'] ?? null;
        $name = $payload['download_name'] ?? 'media.zip';
        if (!is_array($ids) || !is_string($name)) {
            throw new BridgeRequestException('Nieprawidłowe dane archiwum.');
        }
        $gateway->assertDownloadScope($identity, 'selection');
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
    bridgeResponse(429, ['error' => 'rate_limited', 'message' => $error->getMessage()]);
} catch (BridgeRequestException $error) {
    bridgeResponse(422, ['error' => 'invalid_request', 'message' => $error->getMessage()]);
} catch (JsonException) {
    bridgeResponse(422, ['error' => 'invalid_request']);
} catch (Throwable $error) {
    error_log('TryHackX bridge failure: ' . $error::class . ': ' . $error->getMessage());
    bridgeResponse(500, ['error' => 'internal_error']);
}
