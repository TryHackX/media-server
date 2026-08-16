# Most PHP → Python

`TransferToken.php` tworzy krótko żyjące, szyfrowane tokeny AES-256-GCM zgodne z usługą Python.
Token powstaje dopiero po sprawdzeniu istniejącej sesji i uprawnień przez PHP. Klient nie otrzymuje
ścieżki systemowej ani klucza. PHP kończy żądanie natychmiast; zawartość przesyła wyłącznie Python.

Warstwa jest podzielona na małe moduły:

- `AccountGateway.php` obsługuje logowanie, rejestrację z aktywacją mailową, ponowną wysyłkę
  linków oraz samoobsługową zmianę hasła i adresu e-mail;
- `CaptchaGuard.php` weryfikuje wyzwanie antybotowe (reCAPTCHA/hCaptcha/Turnstile) przed
  logowaniem i rejestracją; `Mailer.php` wysyła SMTP albo zapisuje `.eml` do `logs/mail/`;
- `LegacyIdentity.php` to niemutowalny obiekt tożsamości budowany z sesji lub wiersza `users`;
- `LegacySessionBridge.php` ponownie sprawdza aktywne konto w jednej bazie, regeneruje
  identyfikator sesji przy pierwszym użyciu i dostarcza ochronę CSRF;
- `PermissionGroups.php` przechowuje nazwane grupy uprawnień z limitami strumieni i pobrań
  oraz rozwiązuje prawa skuteczne konta;
- `CatalogTransferGateway.php` zamienia serwerowy identyfikator `media_items` na token,
  egzekwując uprawnienie pobierania i godzinowy limit z grupy/ustawień; nie przyjmuje
  od przeglądarki ścieżki systemowej ani nazwy źródła;
- `CatalogActions.php` i `LibraryBrowser.php` realizują bibliotekę, kolekcje, oceny,
  odtwarzanie, profile i panel administracyjny;
- `BridgeConfigLoader.php` parsuje wspólny prywatny TOML Pythona własnym, ścisłym parserem
  podzbioru (komentarze, tabele, stringi z escape, liczby, wartości logiczne; tablice, tabele
  inline i ciągi wieloliniowe są odrzucane), mapuje go na bezpieczny DSN PHP i blokuje
  wstrzyknięcie parametrów połączenia; opcjonalne sekcje `[mail]` i `[app]` dostają te same
  wartości domyślne niezależnie od formatu configu;
- `stage/bridge.php` jest cienkim kontrolerem opublikowanym wyłącznie w lokalnym stagingu.

Przykład po pomyślnej autoryzacji:

```php
use TryHackX\Media\Integration\TransferToken;

$token = TransferToken::file(
    $privateTransferKey,
    'music',
    'Artist/Album/song.flac',
    'song.flac',
    inline: true,
    subject: (string) $_SESSION['user_id']
);

$url = '/media-transfer/v1/files/' . rawurlencode($token);
```

Dla dużych archiwów należy wysłać token formularzem `POST /media-transfer/v1/archives`, aby nie
ograniczała go długość URL.

## Endpoint stagingowy

1. Wskaż wspólny prywatny `config.local.toml` Pythona albo osobny `stage/config.example.php`.
2. Ustaw `TRYHACKX_BRIDGE_CONFIG` na pełną ścieżkę tego pliku.
3. Opublikuj wyłącznie `stage/bridge.php` pod osobną trasą i pozostaw obecne UI bez zmian.
   Dla lokalnego HTTP ustaw `TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL=1`; kod nadal wymaga loopbacku.
4. Najpierw wykonaj `GET ?action=session`, aby pobrać profil i token CSRF.
5. Dla `POST ?action=file` wyślij nagłówek `X-CSRF-Token` i JSON
   `{"media_item_id": 123, "inline": true}`.
6. Dla `POST ?action=archive` wyślij JSON
   `{"media_item_ids": [123, 456], "download_name": "wybrane.zip"}`.

Sesję zakłada własne logowanie mostu (`?action=login`); role, aktywność konta i uprawnienia są
odczytywane z jednej bazy przy każdym żądaniu. Pobieranie i ZIP wymagają uprawnienia
`can_download` grupy konta i podlegają limitom pobrań (grupa: liczba w oknie N minut; globalny:
osobny limit i okno; oba sprawdzane atomowo) — odpowiedź `429` z polem `message`. Dostęp do
biblioteki (`can_access_music`/`can_access_movies`), tryb zgodny (`can_stream_compat`) i edycja
tagów (`can_edit_metadata`) także pochodzą z grupy; odmowa to `403` z `message`. Limity
równoczesnych strumieni i pobrań grupy trafiają do tokenu (`max_streams`, `max_downloads`) i są
egzekwowane przez serwis Python. Konfiguracja przykładowa domyślnie wymaga HTTPS; wyjątek dla
lokalnego HTTP należy włączyć świadomie wyłącznie na `localhost`.
