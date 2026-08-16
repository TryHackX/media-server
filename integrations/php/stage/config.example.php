<?php

declare(strict_types=1);

// Skopiuj poza publiczny DocumentRoot i ustaw TRYHACKX_BRIDGE_CONFIG na pełną ścieżkę kopii.
return [
    'database' => [
        'dsn' => 'mysql:host=127.0.0.1;port=3306;dbname=media_server_stage;charset=utf8mb4',
        'user' => 'media_server_stage',
        'password' => 'CHANGE_ME',
    ],
    'transfer' => [
        'key' => 'BASE64URL_32_BYTE_KEY',
        'base_url' => '/media-transfer',
        // Wyłącznie zaufany adres loopback używany przez PHP do zlecania skanów.
        'internal_url' => 'http://127.0.0.1:8765',
    ],
    'session' => [
        // Musi odpowiadać nazwie cookie obecnego portalu na czas migracji.
        'name' => 'PHPSESSID',
        // Na localhost można ustawić false. Dla dostępu sieciowego wymagane jest HTTPS.
        'require_https' => true,
    ],
    // Bez 'mail.host' wiadomości aktywacyjne trafiają do logs/mail/ jako pliki .eml.
    // 'mail' => [
    //     'host' => 'smtp.example.com',
    //     'port' => 587,
    //     'security' => 'starttls',
    //     'username' => 'noreply@example.com',
    //     'password' => 'CHANGE_ME',
    //     'from_address' => 'noreply@example.com',
    //     'from_name' => 'TryHackX Media',
    // ],
    // 'app' => ['base_url' => '/media-next/'],
];
