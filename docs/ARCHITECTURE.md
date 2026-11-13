# Architektura

System jest modularnym monolitem w trzech procesach: PHP odpowiada za sesję, konta i krótkie
API, Python za transfer/ZIP/miniatury/tryb zgodny, a TypeScript za wspólny interfejs.
Przeglądarka nigdy nie przekazuje ścieżki systemowej — każdy transfer zaczyna się od
`media_item_id` i krótkiego, zaszyfrowanego ticketu.

## Katalogi mediów są tylko do odczytu

**Nic w tym systemie nie zapisuje do plików multimedialnych.** To nie jest przypadek ani
uprzejmość — to warunek, na którym biblioteka może jednocześnie być zasiewem torrentów:
zmiana choćby jednego bajta albo czasu modyfikacji unieważniłaby seedowanie.

Wynika z tego kilka decyzji, które inaczej wyglądałyby dziwnie:

- **Edytor tagów zapisuje do bazy**, do `media_metadata_overrides`, a nie do pliku. Odczyt
  łączy jedno z drugim (`COALESCE(mo.title, mi.title)`), więc poprawka jest widoczna wszędzie,
  a plik zostaje nietknięty.
- **Okładki, napisy i tryb zgodny** produkują nowe pliki w `runtime/`, nigdy obok oryginału.
- **Odcisk pliku** (`content_fingerprint`) otwiera plik w trybie `rb` i czyta 128 KiB z dwóch
  końców. Odczyt nie zmienia ani zawartości, ani `mtime`.
- **Gatunek i rok** biorą się z nazwy pliku albo z sieci i lądują w kolumnach katalogu —
  właśnie dlatego, że dopisanie ich do pliku nie wchodzi w grę.

Sprawdzenie, gdyby kiedyś trzeba było to udowodnić: katalog trzyma `size_bytes` i `mtime_ns`
z chwili skanu, więc porównanie ich z `stat()` na dysku pokazuje każdą zmianę.

```text
Przeglądarka
  ├─ strony i krótkie API ──> most PHP (/media-next-api) ──> jedna baza media_server
  └─ audio/video/plik/ZIP ──> Apache proxy (/media-transfer) ──> Python transfer :8765
                                    └─ FFmpeg (tryb zgodny, miniatury, napisy) ──> cache w runtime/
```

## Procesy

1. **Most PHP** — logowanie (z weryfikacją dwuetapową) i rejestracja z aktywacją, wyzwania
   antybotowe i drabina kroku w górę (sekcja niżej), sesja z CSRF, biblioteka,
   kolekcje, oceny, panel administracyjny, grupy uprawnień oraz wystawianie krótkich tokenów
   transferowych. Egzekwuje uprawnienia i godzinowe limity pobierania przy wystawianiu ticketu.
2. **Transfer (Python/FastAPI)** — tylko bajty: Range, HEAD, ZIP64 STORE, miniatury, napisy
   WebVTT i strumienie trybu zgodnego. Nie renderuje HTML i nie przyjmuje ścieżek bez
   zaszyfrowanego uprawnienia; limit równoczesnych strumieni konta odczytuje z claima tokenu.
3. **Worker** — skanowanie przyrostowe katalogu, kolejka metadanych (mutagen w procesie
   potomnym z twardym limitem czasu na plik: jeden proces czyta całą porcję, a plik, który go
   zawiesi albo wywróci, kosztuje tylko ten proces — następne pliki idą do świeżego; wcześniej
   proces na plik, ok. 0,3 s startu każdy) i wygrzewanie cache napisów; zlecany z CLI albo z panelu przez
   wewnętrzne endpointy chronione kluczem. Skan zapisuje porcjami: jedna transakcja na porcję,
   nowe wiersze jednym wielowierszowym `INSERT`, niezmienione jednym `UPDATE … WHERE id IN (…)`
   (wcześniej każdy wiersz był osobnym poleceniem i osobnym commitem). Plik, któremu zmienił się
   rozmiar albo czas, traci odcisk w tym samym zapisie i dostaje nowy w tym samym skanie. Kolejka
   tytułów (Filmweb) traktuje błąd jako sprawę jednego wiersza: wiersz dostaje `failed`, licznik
   `attempts` i `retry_at` (migracja 043: godzina, 6 h, doba, 3 dni, tydzień, potem miesiąc),
   a przebieg idzie dalej; trzy błędy z rzędu „Filmweb nie odpowiada" kończą przebieg, zanim
   ukarze resztę kolejki. Przebieg obsługuje tylko wskazane źródło. Plik nazwany samą liczbą
   (`Smerfy/305 - Astrosmerf.avi`) jest odcinkiem serialu swojego folderu, gdy numeracja to
   zwyczaj folderu (reguła `EpisodeOrder`: co najmniej trzy różne numery na 60% plików, bez
   znaczników `S01E02`), a numerowane pliki nie mają własnego roku — półka sequeli i specjale
   kreskówek mają, więc zostają osobnymi dziełami. Reguła nie przenosi pliku do ani z dzieła,
   o którym zdecydował człowiek; wiersze kolejki bez żadnego pliku, na które nikt nie odpowiedział,
   znikają przed otwarciem nowych. Nieudane odczyty metadanych panel odsyła do kolejki
   (jeden plik albo wszystkie: `queued`, licznik prób od zera) i od razu uruchamia na nich
   worker z porcją ich rozmiaru — zachowują swoje id, więc idą przed tym, co skan dołożył później.
   Kolejka sama się sprząta (od 11.11.2026): każdy przebieg workera usuwa odczyty zakończone
   ponad 30 dni temu oraz nieudane odczyty, po których ten sam plik przeczytano poprawnie
   (najpierw te drugie, póki ich „done” jeszcze to potwierdza); plik, który wciąż się nie udaje,
   zostaje. Licznik „gotowe” w panelu znaczy więc „w ostatnich 30 dniach”.
   **`media_items.created_at`** (migracja 049) to chwila, w której katalog pierwszy raz zobaczył
   plik — ustawia ją baza przy wstawieniu wiersza i nic jej potem nie rusza (`indexed_at`
   przepisuje każdy skan). Czytają ją „ostatnio dodane” strony startowej, kolejność „najnowsze”
   list inteligentnych i przegląd nowości. Plik przemianowany albo przeniesiony w obrębie źródła
   to dla katalogu nowy wiersz obok starego; skan oddaje mu datę starego po odcisku treści
   (`content_fingerprint`) — tylko od wiersza, którego już nie ma (kopia istniejącego pliku jest
   nowością), tylko wstecz. Odciski liczone są od najnowszych wierszy, więc plik poznany w tym
   skanie dostaje odcisk w tym skanie (do `--fingerprint-limit`, domyślnie 2000 na przebieg;
   reszta w następnych). Typ MIME pochodzi z jednej tabeli serwera (`mediatypes.py`), nie
   z rejestru Windows ani `/etc/mime.types`; skan wyrównuje do niej wiersze zapisane wcześniej.

Rozdzielenie procesów nie oznacza trzech projektów. To jeden modularny monolit, jedna
konfiguracja (`config/config.local.toml` czytana przez Pythona przez `tomllib` i przez PHP
własnym parserem podzbioru TOML — komentarze, tabele, stringi, liczby, wartości logiczne),
jedne migracje i wspólny model danych, ale ciężka praca nie blokuje żądań interfejsu.
Ścieżki wewnątrz drzewa projektu (cache, dołączony FFmpeg, spool poczty) mogą być względne
i są rozwiązywane względem katalogu projektu; katalogi mediów są zawsze bezwzględne.

## Ochrona przed botami i konto (od 11.11.2026)

Wszystko egzekwuje most; strona tylko pokazuje wyzwanie. Pliki: `CaptchaGuard.php`,
`ProofOfWork.php`, `StepUpGuard.php`, `Totp.php`, `TwoFactor.php`; migracje 046–048.

- **Dostawcy wyzwań** (`captcha_provider`): reCAPTCHA v2, reCAPTCHA v3 (wynik ≥
  `captcha_v3_min_score`, akcja musi się zgadzać: `login`/`register`/`resend`/`step_up`),
  hCaptcha, Turnstile i własny **proof-of-work** (`pow`, schemat ALTCHA: `SHA-256(salt +
  liczba)` + HMAC wyzwania kluczem pochodnym klucza transferowego, wygaśnięcie w soli,
  zużyte wyzwania w `captcha_spent` do wygaśnięcia). Każdy dostawca ma własną parę
  `captcha_site_key_<p>`/`captcha_secret_key_<p>`; sekret nigdy nie wychodzi z serwera
  (migawka ustawień podaje tylko, czy jest). Weryfikacja zewnętrzna przez wstrzykiwalny
  transport (testy bez sieci); niedostępny dostawca to odmowa, niepełna konfiguracja —
  wyłączona ochrona formularzy (żeby nie zamknąć logowania).
- **Gdzie które wyzwanie**: formularze strony logowania („zawsze” przy logowaniu, chroniona
  rejestracja) — wybrany dostawca. Krok w górę: na stronie logowania wybrany dostawca, gdy jest
  skonfigurowany, inaczej proof-of-work; **w aplikacji zawsze proof-of-work**, bo CSP stron
  aplikacji nie wpuszcza skryptów z zewnątrz. Który dostawca obowiązuje przy `captcha_pass`,
  decyduje serwer (zalogowana sesja → `pow`), nie strona.
- **Drabina kroku w górę** (`StepUpGuard`): podmioty `u:<id>` (konto), `c:<sha256 adresu>`
  (ten sam skrót co `auth_attempts`, nigdy adres; adres IPv6 liczy się jako jego sieć `/64`,
  bo jeden abonent ma ich 2^64 — `TrustedProxy::limitKey`) i `d:<skrót ciasteczka urządzenia>`
  (skrót liczy most z podpisanego ciasteczka; surowa wartość z przeglądarki nie jest podmiotem).
  Konteksty z progami w `app_settings` (`stepup_<ctx>_soft/_hard/_window`, domyślnie):
  `request` 240/600 na 60 s, `download` 30/100 na godzinę, `compat` 120/400 na godzinę
  (każde dalekie przewinięcie trybu zgodnego to nowy token), `guest_link` 10/30 na godzinę,
  `register` i `resend` 2/5 na dobę. Od `soft` bez przepustki → `428 captcha_required`
  (żądanie nieliczone); przepustka (`captcha_pass`) w sesji, związana ze skrótem adresu,
  ważna `stepup_pass_minutes` (30). Od `hard` → `429` z `Retry-After` (do zsunięcia okna
  poniżej progu) i strike; `stepup_block_after` (5) strike'ów w 15 min → blokada na
  `stepup_block_minutes` (60) w całym moście. Liczniki w kubełkach po 10 s
  (`stepup_counters`), decyzje w `stepup_subjects` (lista w panelu, „Odblokuj” — konto
  zabiera ze sobą swoje adresy i urządzenia). Pauzy (raz na godzinę na podmiot), blokady
  i zdjęcia trafiają do `audit_log` (`stepup.*`). `stepup_staff_exempt` (domyślnie tak)
  zwalnia administratorów.
- **Kto jest liczony**: przed zalogowaniem adres i urządzenie (logowanie, rejestracja,
  ponowny link, wyzwania, linki gościnne); **po zalogowaniu tylko konto** — dom dzieli jeden
  adres i pobrania jednego domownika nie mogą wstrzymać pozostałych ani właściciela przy
  logowaniu (live 11.11: blokada skrótu `::1` wyrzucała administratora z tego samego adresu).
  Obrazki (`preview`) nie są liczone, ale blokada je obejmuje; `session`, `auth_state`
  i `logout` nie są liczone wcale; pobrania przez link (eksporty, strona gościa) dostają
  tylko pauzę, nigdy wyzwania (nie miałyby gdzie go pokazać).
- **Logowanie**: limity per adres/konto/urządzenie bez zmian; wyzwanie `captcha_login_mode`
  = `always` | `after` (od `captcha_login_after`, domyślnie 3, nieudanych prób z adresu albo —
  z nieznanego urządzenia — na wpisane konto) | `never`. Migracja 046 zamieniła dawne
  „Chroń logowanie” (wyłączone) na `after`. Odmowa limitu logowania to strike drabiny.
- **Sesja i formularze konta (audyt 11.11.2026)**: sesja PHP powstaje tylko dla przeglądarki,
  która przyniosła ciasteczko, i dla `auth_state` (wcześniej każde żądanie bez ciasteczka —
  także skaner — zostawiało plik sesji); po uwierzytelnieniu most zamyka zapis sesji
  (`session_write_close`), więc równoległe żądania jednej przeglądarki nie czekają w kolejce
  na blokadę pliku. Zalogowana sesja musi nosić znak konta, dla którego ją otwarto (`assertBound`)
  — sesji „z zewnątrz” most już nie adoptuje. Przepustka z wyzwania jest ważna tylko dla
  dostawcy, który ją wystawił (`provider`), więc proof-of-work nie otwiera formularza
  chronionego Turnstile. Zmiana hasła w „Moim koncie” liczy błędne hasła tym samym licznikiem
  co kody weryfikacji dwuetapowej (10 na 15 min na adres i na konto) — wcześniej nie liczył ich
  nikt; zmiana adresu ma własny limit prób na konto, a o zmianie dowiaduje się także stary adres.
  Ponowna wysyłka linku aktywacyjnego odpowiada po stałym czasie (1,2 s), niezależnie od tego,
  czy konto istnieje. Hasło ma jedną górną granicę — 4096 bajtów — we wszystkich formularzach
  (bcrypt i tak czyta 72). Administrator nie zmienia własnej roli ani nie wyłącza siebie,
  a kontami administratorów zarządza tylko superadministrator. Niedostępny dostawca wyzwań to
  `503 unavailable` z `Retry-After`, nie `500`. `X-Forwarded-Proto` czytany jest z ostatniego
  wpisu (tego, który dopisało zaufane proxy), nie z pierwszego.
- **Weryfikacja dwuetapowa**: TOTP (SHA-1, 30 s, 6 cyfr, ±1 krok), krok raz przyjęty nie
  przechodzi drugi raz (warunkowy `UPDATE last_step`), 10 kodów odzyskiwania (HMAC, zużycie
  przez compare-and-swap), sekret w `user_two_factor` jako AES-256-GCM kluczem pochodnym
  klucza transferowego (`tryhackx-totp-secret:v1`) z kontem jako AAD. Logowanie dwuetapowe:
  hasło → bilet w sesji (5 min, nowy identyfikator, bez konta) → `login_2fa` → sesja. Kody
  i hasła w ustawieniach 2FA liczy `auth_attempts` (`login_2fa`, 10 na 15 min na adres
  i na konto). `twofa_require_admins`: administrator bez 2FA konfiguruje ją przy logowaniu,
  zanim sesja powstanie. Reset przez administratora (super_admin dla kont administratorów)
  w karcie użytkownika; wszystko w `audit_log` (`user.twofa_*`).
- **Log dla fail2ban**: `tryhackx-auth event=login_failed|second_factor_failed|
  captcha_failed|login_limited|blocked|paused action=… client=<16 znaków skrótu>` przez
  `error_log()`; adres dopisuje Apache. Przykłady: `deploy/fail2ban/`.

## Tokeny transferowe

- AES-256-GCM, prefiks `v1.`, AAD `tryhackx-media-transfer:v1`, TTL ≤ 900 s;
- claimy: `kind` (file/archive), `items` (źródło + ścieżka względna), `name`, `disposition`,
  `purpose`, `sub` (id konta) oraz opcjonalnie `max_streams` (limit równoczesnych strumieni trybu
  zgodnego, tylko w `compat`) i `max_downloads` (limit równoczesnych pobrań — tylko dla
  `attachment`); oba pochodzą z grupy uprawnień konta i są egzekwowane przez Python bez dostępu
  do bazy;
- archiwum z listą większą niż 32 KiB JSON-u nie niesie `items`, tylko `manifest`: klucz wiersza
  `archive_manifests` (migracja 042), SHA-256 zapisanych tam bajtów i liczbę pozycji. Lista żyje
  tyle, co token (+60 s), Python czyta ją przy pobraniu — to jedyny odczyt bazy na drodze
  transferu — i buduje ZIP tylko wtedy, gdy skrót i liczba się zgadzają. Token z listą inline
  przestawał się mieścić w 64 KiB przy ok. 270 plikach; z manifestem ma kilkaset bajtów przy
  każdej liczbie plików;
- `purpose` mówi, po co token wydano, a każda trasa usługi obsługuje tylko swój cel:
  `download` (załącznik: `/v1/files`, `/v1/archives`), `play` (plik inline: `/v1/files`),
  `thumb` (`/v1/thumbnails`), `compat` (`/v1/stereo*`, `/v1/subtitles`,
  `/v1/subtitle-picture(s)`). Token bez `purpose` jest odrzucany (od 11.11.2026; reguła
  przejściowa dla tokenów sprzed 08.11 obowiązywała, dopóki mogły żyć — kwadrans);
- Python odrzuca ścieżki wychodzące poza skonfigurowane źródło: ścieżka jest rozwiązywana
  (`resolve`) i po rozwiązaniu musi leżeć w źródle, więc dowiązanie albo junction wskazujące
  **poza** źródło to odmowa, a wskazujące do jego środka — zwykły plik. Skaner dowiązań
  i punktów ponownej analizy nie odwiedza wcale, więc nie trafiają do katalogu.

## Uprawnienia

Grupa uprawnień jest jedynym źródłem praw konta (`permission_groups`): 14 flag (pobieranie
pliku, zaznaczenia, folderu i całej biblioteki, ocenianie, ulubione, tworzenie kolekcji,
przeglądanie kolekcji, przeglądanie profili, udostępnianie, dostęp do muzyki, dostęp do
filmów, tryb zgodny wideo, edycja tagów) i cztery limity (równoczesne
strumienie, liczba pobrań w oknie N minut, okno, równoczesne pobrania). Konto gościa to
członkostwo w systemowej grupie „Goście” (`users.is_guest` jest lustrem). Administratorzy
omijają prawa i limity. Limit globalny (`app_settings`) działa niezależnie od limitu grupy;
rezerwacja pobrania jest atomowa (blokada wiersza konta) i następuje dopiero po wydaniu tokenu,
więc nieudane żądanie nie zjada limitu.

Biblioteka to **źródło**: o dostępie do pozycji decyduje rodzaj jej źródła
(`media_roots.media_kind` — `music`, `movies`, a `mixed` z dowolnym z dwóch praw), tą samą regułą
w bramce transferu i w każdej akcji mostu przyjmującej identyfikator pozycji (ocena, odtwarzanie,
tagi, okładka, kolejka urządzeń, kolekcje). Listy biorą muzykę z muzyki (audio ze źródeł `music`
i `mixed`), a filmy z filmów. Link gościnny działa jako jego autor i sprawdza prawa autora
(udostępnianie, biblioteka, przeglądanie cudzych kolekcji) oraz dostęp do celu przy każdej wizycie
— także przy tworzeniu linku do cudzej udostępnionej listy.

Biblioteka może mieć **więcej niż jedno źródło**: drugie źródło tego samego rodzaju i źródło
`mixed` pojawiają się jako foldery na górze biblioteki (pierwsza strona, bez wyszukiwania),
a źródło `mixed` pokazuje każdej bibliotece swój rodzaj plików. Reguła „co otwiera źródło”
jest zapisana raz (`PermissionGroups::opensSource`), a „kto jest operatorem” — w
`LegacyIdentity::isOperator()`.

Konto jest aktywne, oczekuje na link aktywacyjny (`is_active = 0`) albo zostało wyłączone przez
operatora (`disabled_at`, migracja 041, ze sprawdzeniem `disabled_at IS NULL OR is_active = 0`).
Wyłączonego nie otwiera link z poczty ani ponowna wysyłka — tylko panel. Logowanie ogranicza limit
per adres i limit per konto; ten drugi liczy wyłącznie urządzenia bez podpisanego ciasteczka
urządzenia tego konta, więc cudze próby (także z rotowanych adresów IPv6) nie zablokują
właścicielowi przeglądarek, na których już się logował. Daty linków i przeglądu nowości liczy
zegar bazy, nie PHP.

Usunięcie konta (`CatalogActions::deleteUser`, panel → Konta, 12.11.2026) zabiera wszystko, co do
niego należy: oceny i ulubione (średnie liczą się z tego, co zostało, więc zmieniają się od razu),
playlisty z ich pozycjami, okładkami, głosami i linkami gościnnymi, historię i pozycje odtwarzania,
kolejki, sesje, 2FA, linki aktywacyjne, przegląd nowości, ulubione wizualizacje, odrzucone
podpowiedzi, historię pobrań, archiwa w przygotowaniu i importy. Większość idzie za kontem kluczami
obcymi (`ON DELETE CASCADE`); to, co nazywa konto bez klucza — link gościnny do jego playlisty
(`target_kind`/`target_id`), `stepup_counters`/`stepup_subjects` (`u:<id>`) i `auth_attempts`
(nazwa konta) — most kasuje w tej samej transakcji. Zostają ogólne liczniki odtworzeń
(`media_play_totals`, bez nazw kont), poprawki katalogu (autor `SET NULL`) i dziennik aktywności
(autor wpisów `SET NULL`, plus wpis `user.delete` z liczbami). Zasady jak przy zmianie konta: nie
własne, a konto administratora tylko superadministrator; nazwę konta trzeba wpisać (sprawdza ją też
most). Wyłączenie konta (`disabled_at`) nadal niczego nie kasuje i jego oceny liczą się dalej.

## Transfer

- Strumień pliku ma ograniczoną pamięć i obsługuje pojedynczy zakres bajtów.
- Nieobsługiwany multi-range skutkuje pełną odpowiedzią zamiast błędnej wieloczęściowej, a zakres
  w nieznanej jednostce (`items=…`) jest ignorowany, nie kończy się 416 (RFC 9110, 14.2).
- `If-Range` zapobiega łączeniu fragmentów różnych wersji pliku: ETag tylko silny, data tylko
  dokładnie równa `Last-Modified` (wcześniej „nie nowsza niż").
- ZIP korzysta z ZIP64 i STORE, ponieważ audio oraz wideo są już skompresowane.
- Zakres dłuższy niż jakakolwiek długość pliku (tysiące cyfr) jest czytany jako „za końcem”,
  bez parsowania liczby: Python odmawia zamiany ponad 4300 cyfr na liczbę i ta odmowa wychodziła
  jako 500.
- **Archiwum idzie dalej bez pliku, którego już nie ma.** Katalog bywa starszy niż dysk: plik
  skasowany albo przemianowany od ostatniego skanu jest pomijany, nagłówek `X-Archive-Missing`
  podaje, ile ich było, a w archiwum ląduje `_BRAKUJACE-PLIKI.txt` z ich nazwami (nazwami
  z archiwum, nie ścieżkami dysku). Tylko archiwum, w którym nie zostało nic, to nadal 404;
  ścieżka wychodząca poza źródło nadal odmawia całości.
- **Jedno konto nie zajmie wszystkich slotów.** Token odtwarzania jest ważny dla dowolnej liczby
  połączeń, więc pliki odtwarzane inline liczone są na konto: najwyżej
  `max(2, max_concurrent_transfers − 2)` naraz, kolejne dostają `429` z `Retry-After: 5`.
  Pobrania mają własny limit z grupy (`max_downloads`), jak dotąd.
- **Miniatury mają własną kolejkę wysyłki** (16 naraz), osobną od transferów: strona prosi
  o kilkadziesiąt okładek naraz i za ośmioma odtwarzanymi filmami czekały 10 s na `503`.
- Semafory ograniczają równoległe transfery, strumienie FFmpeg, ekstrakcję napisów
  i generowanie miniatur; oczekujący klient dostaje 503 po upływie czasu kolejki. Napisy dla
  widza i wygrzewanie cache w tle mają **osobne** semafory (2 i 1), więc wielogodzinny przebieg
  nigdy nie jest powodem, dla którego widz czeka. Krótkie sondy FFmpeg (`_seek_landing`,
  `_probe_stderr`) dzielą cztery sloty; sonda, która nie dostanie slotu w 15 s, odpowiada jak
  nieudana (przewinięcie ląduje na kliknięciu, „nic nie wiadomo"), zamiast startować kolejny FFmpeg.
- Operacje na plikach mediów — rozwiązanie ścieżek grantu (archiwum to setki), `stat` dla ETag,
  listowanie folderu z napisami obok filmu, sprawdzanie cache miniatur — idą w wątkach, nie
  w pętli zdarzeń: na udziale SMB/NFS każda to podróż przez sieć. `/health/ready` sprawdza każde
  źródło w wątku z limitem 5 s, a źródło, które wciąż nie odpowiedziało na poprzednie pytanie,
  nie jest pytane drugi raz (każde pytanie zostawiałoby kolejny zawieszony wątek).
- Napisy obok filmu muszą być zwykłymi plikami: dowiązanie albo junction o nazwie
  `Film.pl.srt` jest pomijane, bo FFmpeg poszedłby za nim dokądkolwiek.
- `.sub` obok filmu jest oferowany tylko wtedy, gdy jego początek to tekst MicroDVD
  (`{start}{koniec}tekst`); binarna połowa pary VobSub (pakiety MPEG-PS, zaczyna się od
  `00 00 01 BA`) i SubViewer są pomijane. MicroDVD liczy w klatkach: plik z linią `{1}{1}25`
  czyta FFmpeg w tym tempie, każdy inny — w tempie filmu z sondy (`video_frame_rate`, NTSC jako
  ułamek `24000/1001`, nie zaokrąglone `23.98`), które jest też częścią klucza cache tej ścieżki.
- Porzucone strumienie trybu zgodnego sprząta osobny obserwator rozłączenia, więc zamknięta
  karta nie blokuje slotu do końca limitu czasu.
- **Miniatury**: jedna tabela rozszerzeń dla skanera, miniatur i napisów (`mediatypes.py`;
  `.vob` było filmem dla skanera i niczym dla miniatur). Klatka filmu jest szukana w 120. sekundzie,
  potem w 12., 1. i 0. — klip krótszy niż dwie minuty nie miał klatki wcale. Nazwa pliku w cache to
  skrót ścieżki, miejsca klatki oraz **rozmiaru i czasu pliku**, więc film podmieniony pod tą samą
  nazwą dostaje własną miniaturę; miniatury zrobione wcześniej (nazwa bez rozmiaru i czasu) są
  ważne, dopóki są nowsze niż ich plik, i nie są robione od nowa.
- **Sprzątanie cache** (`media-server cache-prune`, `cacheprune.py`): wpisy nazwane są skrótem
  pliku, więc po zmianie, przeniesieniu albo skasowaniu pliku stary wpis zostawał na zawsze.
  Polecenie liczy nazwy, jakie miałby każdy skatalogowany plik (tymi samymi funkcjami, którymi
  serwer je podaje), i to, co leży pod inną nazwą, uznaje za zbędne: miniatury, napisy obrazkowe,
  WebVTT, a odpowiedzi Filmwebu po 45 dniach. **Domyślnie tylko raport**; `--apply` usuwa.
  Zabezpieczenia: tylko nazwy, które pisze ten serwer; wpis młodszy niż tydzień zostaje
  (`--grace-days`); gdy źródło nie jest zamontowane albo połowy katalogu nie ma na dysku —
  nic nie jest ruszane; cache, który straciłby ponad połowę wpisów, zostaje do potwierdzenia
  `--allow-mass-delete`. Przebieg okresowy sprząta tylko na życzenie
  (`maintenance --only scan,metadata,titles,prune`).

## Cache napisów

- **Ścieżka pusta albo nieudana jest zapamiętana.** Odtwarzacz pyta o napisy obrazkowe co 4 s;
  ścieżka bez żadnego obrazka (puste sloty Blu-ray) i ścieżka, której nie dało się narysować,
  odpowiadały `202` bez końca i każde pytanie czytało film od nowa. Teraz pierwsze pytanie po
  rysunku dostaje `422` z `{"status": "empty" | "failed", …}`; „pusta” obowiązuje, dopóki plik
  jest tym samym plikiem, „nieudana” przez 15 minut (potem wolno spróbować znowu).
- **Konwersja WebVTT ma sufit w trakcie czytania** (16 MB; wcześniej całość trafiała do pamięci
  i dopiero wtedy była mierzona), a blokada „jedna konwersja ścieżki naraz” znika ze słownika,
  gdy nikt na nią nie czeka.
- **Film czytany raz, nie raz na ścieżkę.** Ścieżki obrazkowe (PGS, VobSub, DVB) filmu, który ma
  ich dwie lub więcej, są w jednym przebiegu FFmpeg **kopiowane bez dekodowania**, każda do
  własnego małego pliku w `runtime/subtitles/work/` (PGS do `.sup` z zegarem 90 kHz, reszta do
  `.mks`; PGS ze strumienia transportowego do `.m2ts` w trybie Blu-ray, bez opóźnienia muksera,
  bo `.sup` odrzuca pakiet z uciętym segmentem, jakie `.m2ts` z Blu-ray ma, a jeden taki kończył
  kopię całego filmu; kopia `.sup`, która padnie gdziekolwiek indziej, jest raz ponawiana jako
  `.m2ts`, zanim film będzie czytany ścieżka po ścieżce), a potem rysowane z tej kopii dokładnie
  tak, jak z filmu: te same pakiety, te same
  znaczniki czasu, te same obrazki i czasy cue co bajt (sprawdzone ścieżka po ścieżce). Dekodowanie
  wszystkich ścieżek w jednym procesie odpadło: FFmpeg rozsyła „heartbeat" pakietów każdej
  dekodowanej ścieżki do wszystkich, więc każda zyskiwała klatki sąsiadek, w liczbie zależnej od
  wątków. Jedna ścieżka w zwykłym pliku jest rysowana wprost z filmu, jak przedtem.
- **Napisy 4K w rozmiarze autora.** PGS płyty UHD jest rysowany w 1920×1080; film szerszy niż 1920
  zawsze idzie przez kopię, a FFmpeg czyta z kopii rozmiar każdej ścieżki (jedno `ffmpeg -i kopia
  -i kopia …` na film — sonda samego filmu nie sięga pierwszego pakietu napisów). Ścieżka mniejsza
  niż film jest zapisywana w swoim rozmiarze, przycięta do proporcji filmu (1920×800 dla
  3840×1600), z `scale` w manifeście, pod osobnym kluczem (`native`); odtwarzacz skaluje ją tą samą
  regułą `object-fit: contain`, co obraz. Cue i czasy bez zmian, CPU 10× mniej, pliki 6× mniejsze.
  Ścieżki wyrenderowane wcześniej (przeskalowane) zostają ważne pod starym kluczem: odczyt szuka
  najpierw klucza `native`, potem starego. Wszystko inne — 1080p, DVD, PGS w rozmiarze filmu — bez
  zmian i pod dotychczasowym kluczem.
- **Numery klatek w manifeście są wewnętrzne.** Rysunek wprost z pliku Matroska dostaje dodatkowe
  puste klatki „heartbeat" od pakietów dźwięku i obrazu filmu, rysunek z kopii — nie, więc ta sama
  ścieżka może mieć inne nazwy plików PNG; czasy cue i obrazy są identyczne, a klucz cache
  (`pictures-v2`) się nie zmienił.
- **Strumienie transportowe i programowe** (`.m2ts`, `.ts`, `.mts`, `.vob`, `.mpg`) mają klucz
  `pictures-v3`: FFmpeg ustawia ich zero według używanych strumieni, więc ścieżka dekodowana sama
  dostawała zero od swojego pierwszego pakietu i każdy cue wychodził za wcześnie o to, ile
  ścieżka startuje po filmie (do 5 s; 84 z 341 takich ścieżek). Przebieg kopiujący kopiuje też
  pierwszy strumień obrazu „w nicość" (`-f null`), więc zero ustawia obraz — jak w trybie zgodnym.
  Rysunek wprost z takiego pliku (tylko gdy kopia zawiedzie) też mapuje obraz, inaczej wróciłyby
  za wczesne cue pod kluczem, który obiecuje, że ich nie ma; jest wolny, bo każdy pakiet obrazu
  to „heartbeat" i klatka PNG, ale to wyjątek.
- **Napisy tekstowe** filmu z dwiema lub więcej ścieżkami osadzonymi idą jednym przebiegiem
  z kilkoma wyjściami WebVTT (wynik jest identyczny jak dla ścieżki osobno — tekst nie ma
  heartbeatu); strumienie transportowe nadal ścieżka po ścieżce, z tego samego powodu co wyżej.
- **Przebieg w tle** trzyma dwa filmy naraz: jeden czytany (dysk, semafor zadania), drugi
  rysowany (CPU, do `RENDER_SLOTS` = ¼ wątków procesora, najwyżej 4 FFmpeg, z obniżonym
  priorytetem). Jego rysunki dają skalerowi jeden wątek: swscale na dziesięciu wątkach płacił
  za skalowanie dwa razy więcej CPU za te same piksele (zmierzone na skalowaniu PGS 1080p do 4K,
  zanim te napisy zaczęto zapisywać w rozmiarze autora — wyżej). PNG idzie bez predykcji wierszy
  (`-pred none`; bezstratny tak czy inaczej, pliki o kilka procent mniejsze). Widz czekający na
  ścieżkę dostaje skaler wielowątkowy, bo liczy się czas. Zapis postępu (`warm-state.json`, wersja 3) co 25 filmów; restart usługi
  przerywa przebieg, a następny zaczyna od miejsca, w którym stanął. Widz, który poprosi o ścieżkę
  rysowaną właśnie w tle, czeka na ten rysunek zamiast zaczynać drugi.
- **Każdy błąd przebiegu jest zapisany**: jedna linia w `logs/media-server.jsonl` na film albo
  ścieżkę (`event: subtitle_cache_failure`; `root`, `path` względem źródła, `track`, `codec`,
  `state`, `reason`) i 10 ostatnich w `recent_failures` statusu. `state`: `missing` (pozycja
  katalogu, której nie ma już na dysku — skan źródła ją wycofa), `probe_failed` (FFmpeg nie opisał
  pliku), `failed` (ścieżka; `reason` to ostatnie mówiące coś zdanie FFmpeg, bez adresów i ścieżki
  bezwzględnej), `error` (wyjątek, z tracebackiem). Formatter logu przepuszcza tylko wymienione
  pola, więc `root`, `error` i `reason` dopisane do niego 09.11 pojawiły się też w logach skanu
  i workera metadanych, które gubiły je od początku.
- **Sonda przebiegu w tle** ma minutę zamiast 12 s widza i jedno ponowienie po 10 s; film, którego
  FFmpeg nie opisał, jest błędem i nie trafia do zapisu postępu. Wcześniej przechodził jako „film
  bez ścieżek”: pierwszy pełny przebieg (09.11) ominął tak 23 filmy bez słowa, 16 z nich w ciągu
  trzech minut, a potem każdy dał się opisać (zmierzone: 0,0–0,1 s). Odpowiedź FFmpeg „nie umiem przeczytać pliku”
  nie jest ponawiana. Sonda widza się nie zmieniła. Plik, który FFmpeg otworzył i opisał (linia
  `Input #0`), jest opisany także bez obrazu i czasu trwania: klipy menu z folderów Blu-ray to 3 MB
  jednego strumienia grafiki interaktywnej (siedem w folderach 4K „Happy Death Day”) i nie ma w nich
  czego konwertować — to odpowiedź, nie błąd. Zdanie „At least one output file must be specified”,
  którym FFmpeg kończy każdy opis, nie bywa powodem błędu.
- **Sondy czytają z normalnym priorytetem I/O.** Usługa na Windows startuje z zadania Harmonogramu,
  a zadanie o domyślnym priorytecie 7 dostaje niski priorytet I/O — usługa zapisuje go przy starcie
  (`io_priority` w `service_starting`; na stagingu `low`) — i dziedziczy go każdy FFmpeg, którego
  uruchomi. Odczyt z niskim priorytetem czeka na każdego zwykłego czytelnika tego samego dysku: opis
  filmu za jednym czytającym sekwencyjnie trwał 4,7–26 s zamiast 0,2–1,2 s. Pełny przebieg 09.11 nie
  dostał tak w minutę opisu czterech filmów, które bez obciążenia opisują się w 0,1 s (probesize,
  analyzeduration ani indeks na końcu pliku nie grają tu roli). Sonda filmu i sonda miejsca, w które
  trafi przewinięcie, podnoszą więc swój FFmpeg do normalnego priorytetu zaraz po starcie
  (`priority.py`); długie odczyty przebiegu w tle zostają przy priorytecie usługi.
- **Tekst w innej stronie kodowej.** Ścieżka Matroska jest z definicji UTF-8, a niektóre wydania
  wkładają do niej CP1250 (7 z 8 polskich ścieżek „The Pacific”). FFmpeg odrzuca każdy pakiet
  nie-UTF-8 i poddaje się powyżej dwóch trzecich; poniżej konwertuje ścieżkę bez nich i nic nie
  mówi. Ścieżka, o której FFmpeg zgłosi „Invalid UTF-8” w co najmniej co dziesiątym pakiecie (albo
  z tego powodu odpadnie), jest czytana jeszcze raz jako CP1250 (`-sub_charenc:s`, tylko dekodery
  napisów) — ta sama reguła co dla plików obok filmu. UTF-8 z jednym uszkodzonym pakietem zostaje
  UTF-8 (CP1250 zepsułby w nim każdą literę). Przebieg jednym czytaniem, w którym FFmpeg to
  zgłosi, oddaje film przebiegowi ścieżka po ścieżce, bo nie mówi, której ścieżki to dotyczy.
  Spis z 09.11: z 1932 polskich ścieżek w cache żadna nie zgubiła po cichu cue z polskimi literami.

## Wspólna baza

Migracje `001`–`053` (stan 11.11.2026, 39 tabel). Pierwsze, `001`–`019`, obejmują użytkowników, sesje,
źródła, elementy mediów, hierarchię folderów, oceny, statystyki odtwarzania, kolekcje (ręczne
i inteligentne, z opisem i kolejnością), nadpisania metadanych i okładek, ustawienia aplikacji,
tokeny aktywacyjne, próby logowania, grupy uprawnień, rejestr pobrań, audit log oraz indeks
ścieżek względnych. Późniejsze dokładają m.in. odciski plików (`031`), kolejkę odtwarzania
i sesje urządzeń, przegląd nowości, linki gościnne, ulubione wizualizacje (`040`), stan konta
wyłączonego (`041`), manifesty dużych archiwów (`042`), ponowienia w kolejce tytułów (`043`)
i `ON DELETE SET NULL` dla autorów nadpisań (`044`) oraz sesję, która zapisała kolejkę urządzenia
(`045`: lista innych urządzeń idzie za „Aktywnymi sesjami”); `046`–`048` to ochrona przed botami
i weryfikacja dwuetapowa; `049` — `media_items.created_at` (z odtworzeniem dat z historii skanów);
`050` — `home_dismissals` (propozycje strony startowej, których konto nie chce); `051` — klucze
`audit_log` po akcji i dacie; `052` — usunięcie importu ze starego portalu (`legacy_checksum`
z indeksem, `legacy_import_runs`, `legacy_import_orphans`, status `legacy`; decyzja właściciela
z 11.11.2026); `053` — `search_text` (złożony tekst wyszukiwania jako kolumna generowana, zamiast
składania go w każdym zapytaniu), `bridge_cache` i klucz ocen pod zestawienia folderów. Opis
każdej — w samym pliku i w `CHANGELOG.md`.
Wszystkie tabele używają InnoDB i `utf8mb4`. Runner migracji prowadzi rejestr
`schema_migrations` z sumami kontrolnymi. Poprawki katalogu (tagi, okładki utworów, okładki
playlist) należą do katalogu, nie do autora: `updated_by` to tylko podpis i przy usunięciu konta
zostaje wyczyszczony (`ON DELETE SET NULL`, migracje 025 i 044), a poprawka zostaje.

## Strona startowa (most, od 11.11.2026)

`GET ?action=home` (`HomeShelves.php`) oddaje całą stronę jednym żądaniem: kontynuację filmów
i muzyki z postępem, następne odcinki, ostatnio dodane (`created_at`, okno 90 dni; nowe odcinki
jednego folderu to jedna karta, muzyka grupuje się w albumy), polecane (po serialach, artystach
i gatunkach tego, co konto oceniło wysoko albo polubiło — z powodem na karcie), popularne w domu
i „Zaskocz mnie” (album i film, deterministyczne dla ziarna), a do szybkiego puszczenia czegokolwiek
trzy półki losowe: filmy (40 minut i więcej, nie odcinki), seriale (jedna karta na serial, z odcinkiem,
od którego to konto by zaczęło: pierwszy, przerwany, następny albo — po całości — znów pierwszy)
i utwory (od minuty do dziesięciu). Losuje ziarno: to samo ziarno to te same karty, `shelf=random_…&seed=…`
losuje jedną półkę od nowa, a bez ziarna obowiązuje ziarno konta na dany dzień. **Nigdzie nie ma
`ORDER BY RAND()`**: filmy i seriale są losowane z list pamiętanych dla wszystkich (skrót MD5 z ziarna
i identyfikatora — nie CRC, które jest liniowe i dla sąsiednich ziaren dawało prawie tę samą dwunastkę),
a utworów jest za dużo na listę, więc ziarno wyznacza punkty na indeksie `(root_id, path_hash)` i każdy
punkt to jeden krótki odczyt pierwszego utworu od tego miejsca (0,34 ms; `ORDER BY RAND()` po tych samych
utworach — 30 ms i rośnie z biblioteką). Ceną jest nierówność: utwór po szerszej przerwie między skrótami
trafia się częściej; biblioteka do 2000 plików jest po prostu listowana i losowana równo. Każda półka najpierw **wybiera**
identyfikatory najwęższym indeksem, a potem wszystkie wybrane pliki czyta się **raz**. Propozycji
można nie chcieć (`POST ?action=home_dismiss`, `home_dismissals`); półki „kontynuuj” mają swój
starszy przełącznik (`continue_dismiss`). Konto gościa dostaje nowości i losowanie, nic osobistego.
Rzeczy takie same dla wszystkich — liczniki bibliotek oraz listy, z których się losuje (albumy, filmy,
seriale z pierwszym odcinkiem i liczbą odcinków) — są pamiętane
w `bridge_cache` do następnego zakończonego skanu, najwyżej 5 minut (tak samo jak opcje filtrów
biblioteki); nic, co zależy od konta, nie jest tam trzymane. Stare `?action=continue` działa bez
zmian. Kontrakt pól: `tests/test_bridge_home.py`.

Odpowiedzi mostu, na których opiera się front, zmienione w tym etapie (wszystkie przez dodanie):

- każde pole czasu (`*_at`, `covered_until`) ma bliźniaka `<nazwa>_iso` — ta sama chwila jako
  ISO 8601 w UTC z przesunięciem; stare pole (czas lokalny serwera, bez strefy) zostaje.
  Nowe odpowiedzi (`home`) niosą tylko ISO;
- `GET ?action=admin_indexing_status` → `{indexing: {catalog, scans, metadata,
  metadata_failures}}` — te same cztery klucze co w `admin`, do odświeżania zakładki co kilka sekund;
- `up_next`: w folderze serialu propozycje idą w kolejności odcinków (dalsze rosnąco, potem
  wcześniejsze, potem pliki bez numeru), folder filmów nadal losowo;
- zajęta nazwa playlisty → `422` z komunikatem „Masz już playlistę o tej nazwie. Wybierz inną nazwę.”;
- `digest_send` wysyła najwyżej przez 20 s jednego żądania i zwraca `deferred` (reszta przy
  następnym naciśnięciu albo z harmonogramu); `admin_title_folder_decide` zwraca `closed`.

## Jakość i wydanie

`python scripts/check.py` uruchamia tę samą bramkę co CI (`.github/workflows/ci.yml`): `ruff`,
`pytest`, `php -l`, `tsc`, produkcyjny build frontendu do katalogu tymczasowego, testy node,
`pip check` i skan sekretów (w tym porównanie z wartościami z prywatnego configu); `--audit`
dodaje `pip-audit` i `npm audit`. Zależności Pythona są przypięte w uniwersalnych lockach
z hashami (`requirements.lock`, `requirements-dev.lock`; odświeżanie `scripts/lock-deps.py`),
frontend w `package-lock.json`.

Klasy mostu mają testy na prawdziwym MySQL (`tests/test_bridge_*.py`, `tests/bridge_harness.py`):
osobna baza `media_server_test`, budowana z migracji raz na przebieg i opróżniana przed każdym
testem, biblioteka z prawdziwych plików katalogowanych prawdziwym skanerem, klasy PHP uruchamiane
jako podprocesy, a `stage/bridge.php` — za wbudowanym serwerem PHP. Bez MySQL albo tej bazy testy
się pomijają (szczegóły i konto bazy: `TESTING.md`). Reguła odcinka zapisana w dwóch językach
(`EpisodeOrder.php`, `naming.py`) dostaje w `tests/test_episode_rules_agree.py` te same nazwy.

## Frontend

Jeden projekt TypeScript/Vite ze wspólnym shellem dla wszystkich stron poza logowaniem.
CSS ma warstwy `tokens`, `reset`, `base`, `components`, `utilities`, `pages` i jeden zestaw
responsywnych breakpointów. Dynamiczne elementy używają klas i bezpiecznego DOM zamiast
`innerHTML` i indywidualnego `style.*`. Szczegóły w `FRONTEND.md`.

Od 12.11.2026: dwa motywy kolorów (tokeny pod `[data-theme]`), jeden system ruchu (tylko
`opacity`, `transform` i `clip-path`, nic pod `prefers-reduced-motion`), strona startowa na
`GET ?action=home`, odtwarzacz jako rdzeń bez rysowania plus trzy powierzchnie (`shared/player/`),
strona biblioteki podzielona na części (`pages/library/`).

## Świadome decyzje projektowe

Rzeczy, które wyglądają na błąd albo brak, a są wyborem. Zanim ktoś je „naprawi", niech
przeczyta powód.

- **Limit logowania per konto może zatrzymać nowe urządzenie właściciela** (od 08.11.2026).
  - Po 20 nieudanych próbach w 15 minut z urządzeń, na których konto się nie logowało, takie
    urządzenia dostają `429` do końca okna — także z poprawnym hasłem.
  - Przeglądarki, na których właściciel już się logował, mają podpisane ciasteczko urządzenia
    (`TRYHACKXDEVICE`) i limit ich nie dotyczy, więc cudze próby nie zamkną mu konta. Na nowym
    urządzeniu w trakcie takiej serii trzeba odczekać kwadrans.
  - Licznik idzie po wpisanej nazwie, więc nie zdradza, które konta istnieją. Limit per adres
    zostaje. Od 11.11.2026 po kilku nieudanych próbach logowanie prosi o wyzwanie (proof-of-work,
    gdy nie ma dostawcy) — z urządzenia właściciela tylko wtedy, gdy to jego adres się mylił.
- **Proof-of-work nie odróżnia człowieka od skryptu**, tylko każe zapłacić czasem procesora
  (domyślnie do 200 000 skrótów SHA-256, w przeglądarce ułamek sekundy). Skrypt w natywnym kodzie
  zapłaci szybciej — dlatego to wyzwanie kroku w górę w aplikacji, a nie zamiennik Turnstile
  na stronie logowania, i dlatego jedno rozwiązanie daje jedną przepustkę.
- **Liczniki drabiny nie są transakcyjne**: dwa równoczesne żądania mogą oba zobaczyć licznik
  tuż pod progiem. Progi to tempo, nie księga; księgą jest limit pobrań grupy
  (`reserveDownload`, z blokadą wiersza).
- **Rejestracja bez aktywacji mówi wprost, że nazwa jest zajęta.** Z aktywacją każda odpowiedź
  jest taka sama, a szczegóły idą do skrzynki podanego adresu. Bez aktywacji konto działa od
  razu, więc logowanie i tak pokazuje, czy powstało, a jawny komunikat przynajmniej pomaga.
- **Link gościnny pokazuje pierwsze 500 pozycji** (z liczbą wszystkich i informacją o ucięciu);
  odtwarzanie i pobieranie działa dla całego udostępnionego folderu albo playlisty.
- **Zamknięta sesja ginie przy swoim najbliższym żądaniu**, nie natychmiast. Natychmiastowe
  zabicie wymagałoby trzymania identyfikatorów sesji, a tych celowo się nie przechowuje —
  w bazie jest tylko ich skrót. Własne ciasteczko (`TRYHACKXSESSID`, od 17.08.2026) to inna
  nazwa, a nie inny magazyn sesji, więc tego nie zmieniło.
- **Przejęcie kolejki nie budzi urządzenia, które nie gra** — znacznik czeka na jego najbliższy
  zapis, a zapisuje ono w trakcie odtwarzania. Skoro nic nie gra, nie ma czego przerywać.
- **Historia statystyk ma dziurę po każdym restarcie usługi**, bo dziennik pisze proces
  transferowy. Próbki są rysowane takie, jakie są, bez interpolacji: zmyślona minuta wyglądałaby
  dokładnie tak samo jak prawdziwa. Pierwsza próbka po restarcie niesie `restarted: true`
  (wcześniej flaga nigdy się nie zapalała: próbkarz żyje tyle, co liczniki, które czyta).
- **Linki gościnne są domyślnie wyłączone** (`app_settings.guest_links_enabled`) i takie zostają.
  Działają także przy wystawieniu publicznym, ale włączenie ich to decyzja właściciela,
  a nie stan domyślny.
- **Strefy czasu PHP i MySQL mogą się różnić** (na pierwszej instalacji o dwie godziny).
  Porównania dat robi się w SQL, nigdy znacznikiem z bazy przeciw zegarowi PHP.
- **Bliźniak `_iso` liczy baza** (`UNIX_TIMESTAMP(tekst)`), bo to w jej strefie jest stary napis.
  W jedną godzinę roku, gdy zegary się cofają, czas lokalny występuje dwa razy i bliźniak może
  wskazać wcześniejszą z dwóch chwil; zapytania, którym na tym zależy, biorą
  `UNIX_TIMESTAMP(kolumna)` (strona startowa).
- **Limit pobrań grupy liczy pobrania, nie pliki.** Archiwum stu plików to jedno pobranie;
  `item_count` w rejestrze jest informacją, nie miarą. Liczenie plików karałoby pobranie albumu
  jak sto kliknięć.
- **„Wyślij przegląd teraz” wysyła najwyżej 20 sekund** poczty w jednym żądaniu i mówi, ilu
  kont nie zdążył (`deferred`); pomija konta, które dostały list w ostatnich 10 minutach, więc
  drugie naciśnięcie kończy, a nie dubluje. Pełny przebieg należy do harmonogramu (`digest.php`,
  który kończy się kodem 1, gdy cokolwiek się nie wysłało).
- **Data dodania wędruje za plikiem tylko w obrębie źródła** i tylko wtedy, gdy stary wiersz
  miał odcisk. Plik przeniesiony między źródłami widzą dwa skany, które nie znają swojej
  kolejności — w nowym źródle jest nowością.
- **Ponowna wysyłka linku aktywacyjnego nie zdradza czasem odpowiedzi, czy konto istnieje**
  (stałe 1,2 s) — kosztem tego, że uczciwy użytkownik czeka tę sekundę. PHP pod Apache nie ma
  jak odpowiedzieć i wysłać listu potem, więc czas jest wyrównywany, a nie odkładany.
- **Motyw jest preferencją konta, nie urządzenia** (od 12.11.2026). Wybór w „Moim koncie” idzie
  do `users.preferences_json` (`theme`: `emerald` albo `blue`) i wraca z sesją na każdym
  urządzeniu. `localStorage` trzyma tylko kopię, żeby strona nie mignęła innym motywem, zanim
  przyjdzie sesja; czyta ją `theme-boot.js` — osobny plik, bo CSP nie dopuszcza skryptu w HTML.
  Po wyczyszczeniu danych przeglądarki pierwszy widok jest w motywie domyślnym do odpowiedzi sesji.
- **Na telefonie odtwarzacz zawsze startuje jako minigracz.** Otwarty arkusz zasłania stronę, więc
  jest czymś, co człowiek otwiera, a nie czymś, co wraca po odświeżeniu; zwinięcie doku na tablecie
  i komputerze jest za to pamiętane (`media-dock-collapsed`).
- **Karta gra albo otwiera po naciśnięciu gdziekolwiek, a ścieżki pliku na niej nie ma.** Obszar
  przycisku obrazu jest rozciągnięty na całą kartę; ścieżka jest podpowiedzią. Gwiazdki są na karcie
  tylko tam, gdzie da się w nie trafić myszą — pod palcem stoją w menu „⋯”, w rozmiarze dla kciuka.
- **Rok utworu to rok, nie data wydania.** Tagi Vorbis niosą pod `date` pełne `1940-03-25`,
  ale pole nazywa się `year` i tak jest pokazywane i odpytywane. Zapisujemy sam rok; pełnej daty
  z tagu nie przechowujemy i nie jest to przeoczenie.
- **Losowanie z ziarnem sortuje od nowa przy każdej stronie** — tak działa stronicowany shuffle,
  który przy tym samym ziarnie daje tę samą kolejność.
- **`ffprobe`, nie MediaInfo** — porównane 16.08.2026: te same wartości we wszystkim, co pokazuje
  panel. MediaInfo daje ponadto rozdziały i luminancję mastering display; gdyby kiedyś były
  potrzebne, to argument za **drugim** źródłem, nie za wymianą.

## Poza zakresem

Nie ruszamy **globalnych limitów PHP ani globalnego `Timeout` Apache**. Limity czasu ustawiamy
wyłącznie na własnej trasie (`ProxyPass … timeout=3600`), żeby nie zmieniać zachowania reszty
serwera.
