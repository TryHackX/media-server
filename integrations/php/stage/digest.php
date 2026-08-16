<?php

declare(strict_types=1);

/**
 * Weekly library digest, from the command line.
 *
 * Run by hand or from a scheduler:
 *
 *     php integrations/php/stage/digest.php            # send what is due
 *     php integrations/php/stage/digest.php --force    # ignore the weekly wait
 *
 * The configuration comes from TRYHACKX_BRIDGE_CONFIG, exactly as the bridge
 * reads it, so there is one set of credentials and one mail configuration
 * rather than a second copy that drifts. Refuses to run over the web: this is a
 * CLI entry point, and a scheduled job is not a request.
 */

use TryHackX\Media\Integration\BridgeConfigLoader;
use TryHackX\Media\Integration\LibraryDigest;
use TryHackX\Media\Integration\Mailer;

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../BridgeException.php';
require_once __DIR__ . '/../BridgeConfigLoader.php';
require_once __DIR__ . '/../PermissionGroups.php';
require_once __DIR__ . '/../Mailer.php';
require_once __DIR__ . '/../LibraryDigest.php';

$configPath = getenv('TRYHACKX_BRIDGE_CONFIG');
if (!is_string($configPath) || $configPath === '') {
    $fallback = dirname(__DIR__, 3) . '/config/config.local.toml';
    $configPath = is_file($fallback) ? $fallback : '';
}
if ($configPath === '') {
    fwrite(STDERR, "Brak konfiguracji: ustaw TRYHACKX_BRIDGE_CONFIG.\n");
    exit(2);
}

$config = BridgeConfigLoader::load($configPath);
$database = new PDO(
    (string) $config['database']['dsn'],
    (string) $config['database']['user'],
    (string) $config['database']['password'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false]
);

$digest = new LibraryDigest(
    $database,
    Mailer::fromConfig($config),
    (string) ($config['app']['base_url'] ?? '/media-next/')
);

$force = in_array('--force', $argv ?? [], true);
$result = $digest->run($force);
printf(
    "Wysłano: %d, pominięto (za wcześnie): %d, bez nowości: %d%s\n",
    $result['sent'],
    $result['skipped'],
    $result['empty'],
    $result['spooled'] ? ' — tryb spool (logs/mail)' : ''
);
exit(0);
