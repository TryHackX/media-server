# Most PHP → Python

`TransferToken.php` tworzy krótko żyjące, szyfrowane tokeny AES-256-GCM zgodne z usługą Python.
Token powstaje dopiero po sprawdzeniu istniejącej sesji i uprawnień przez PHP. Klient nie otrzymuje
ścieżki systemowej ani klucza. PHP kończy żądanie natychmiast; zawartość przesyła wyłącznie Python.

Warstwa jest podzielona na małe moduły:

- `AccountGateway.php` obsługuje logowanie, rejestrację z aktywacją mailową, ponowną wysyłkę
  linków oraz samoobsługową zmianę hasła i adresu e-mail;
- `CaptchaGuard.php` weryfikuje wyzwanie antybotowe (reCAPTCHA v2/v3, hCaptcha, Turnstile albo
  własny proof-of-work z `ProofOfWork.php`); `StepUpGuard.php` to drabina kroku w górę (wyzwanie,
  pauza, blokada per konto, adres i urządzenie); `Totp.php` i `TwoFactor.php` to weryfikacja
  dwuetapowa (TOTP, kody odzyskiwania, sekret szyfrowany); `Mailer.php` wysyła SMTP albo zapisuje
  `.eml` do `logs/mail/`;
- `LegacyIdentity.php` to niemutowalny obiekt tożsamości budowany z sesji lub wiersza `users`;
- `LegacySessionBridge.php` ponownie sprawdza aktywne konto w jednej bazie, wymaga, żeby
  zalogowana sesja nosiła znak konta, dla którego ją otwarto (`assertBound` — sesji „z zewnątrz”
  most nie adoptuje), i dostarcza ochronę CSRF;
- `PermissionGroups.php` przechowuje nazwane grupy uprawnień z limitami strumieni i pobrań
  oraz rozwiązuje prawa skuteczne konta;
- `CatalogTransferGateway.php` zamienia serwerowy identyfikator `media_items` na token,
  egzekwując uprawnienie pobierania i godzinowy limit z grupy/ustawień; nie przyjmuje
  od przeglądarki ścieżki systemowej ani nazwy źródła;
- `CatalogActions.php` i `LibraryBrowser.php` realizują bibliotekę, kolekcje, oceny,
  odtwarzanie, profile i panel administracyjny; `HomeShelves.php` składa stronę startową
  (`home`, `home_dismiss`); `BridgeTime.php` dokłada do każdej odpowiedzi bliźniaki `…_iso`
  pól czasu (ta sama chwila jako ISO 8601 z przesunięciem);
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

Każdy token niesie **cel** (`purpose`), a usługa Python otwiera trasę wyłącznie dla jej celu:
`download` (załącznik: `/v1/files`, `/v1/archives`), `play` (plik inline: `/v1/files`), `thumb`
(miniatura: `/v1/thumbnails`) i `compat` (tryb zgodny: `/v1/stereo*`, `/v1/subtitles`,
`/v1/subtitle-picture(s)`). Bez `purpose` token inline jest `play`, a załącznik `download`;
`thumb` i `compat` trzeba nazwać wprost, a limit strumieni (`max_streams`) wolno włożyć tylko do
`compat`. W bramce odpowiadają im `file()`, `thumbnail()` i `stereo()` — tylko ta ostatnia
sprawdza `can_stream_compat`, więc żaden inny token (także z linku gościnnego) nie uruchomi
transkodowania.

Dla dużych archiwów należy wysłać token formularzem `POST /media-transfer/v1/archives`, aby nie
ograniczała go długość URL. Lista plików archiwum jedzie w tokenie tylko do 32 KiB JSON-u; większa
(token z listą przestawał się mieścić w 64 KiB przy ok. 270 plikach) czeka w `archive_manifests`
(migracja 042) przez czas życia tokenu, a token niesie `manifest` — klucz wiersza, SHA-256
zapisanych bajtów i liczbę pozycji. Usługa Python czyta wiersz i buduje ZIP tylko wtedy, gdy
wszystkie trzy się zgadzają (`TransferToken::archiveManifest()`, `security.manifest_items`).
Pobranie jest liczone do limitu dopiero po wydaniu tokenu, więc żądanie, które się nie powiodło,
limitu nie zjada.

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

Biblioteka to **źródło**, nie typ pliku: o tym, czy konto sięga po pozycję, decyduje rodzaj jej
źródła (`media_roots.media_kind`; `mixed` — dowolne z dwóch praw), tą samą regułą w bramce
transferu i w każdej akcji przyjmującej identyfikator pozycji (`CatalogActions::assertItem()`).
Listy (kolekcje, konto, „popularne”, przegląd nowości) biorą muzykę z muzyki, a filmy z filmów.
Link gościnny sprawdza prawa autora i dostęp do celu przy każdej wizycie, nie tylko przy
tworzeniu.

Konto ma trzy stany: aktywne, oczekujące na link (`is_active = 0`) i wyłączone przez operatora
(`disabled_at`, migracja 041). Wyłączonego nie otworzy link aktywacyjny ani „wyślij ponownie” —
tylko panel. Logowanie ma dwa limity: per adres (10 nieudanych w 15 min) i per konto (20 w 15 min),
przy czym ten drugi liczy wyłącznie urządzenia, na których konto nigdy się nie logowało —
przeglądarka, która się logowała, ma podpisane ciasteczko `…DEVICE` i nie da się jej zablokować
cudzymi próbami. Przekroczenie limitu to `429`.
