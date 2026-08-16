# Roadmapa TryHackX Media Server

Wyłącznie **otwarte** prace. Co zostało zamknięte i kiedy: `CHANGELOG.md`.

## Stan na 17.08.2026

System działa pod `/media-next/`, wyłącznie na localhost, i jest samodzielny: własne logowanie,
własna baza, cache i FFmpeg w `runtime/`. Kod leży w `C:\wamp64\media-server`, czyli **poza**
`DocumentRoot`, i jest w gicie (`github.com/TryHackX/media-server`, wydanie `v0.1.1`).
Migracje: do `038`.

**Starego systemu już nie ma.** Sprawdzone 17.08.2026: `www/movies`, `www/music`, `www/sources`
i `www/soucres` nie istnieją, w `www` zostały same ikony, żadnego pliku PHP, a w katalogu `alias`
tylko adminer, phpMyAdmin, phpSysInfo i nasz `media-next-stage.conf`. **Archiwum ZIP nie
powstało** — katalogi zostały usunięte, nie spakowane. To zamyka punkt „porządki" z M7
i **jednocześnie kasuje drogę powrotu**: nie ma już do czego wracać, więc M7 nie może obiecywać
„procedury powrotu do starych tras". Jedyne wycofanie, jakie zostało, to przywrócenie zrzutu SQL
i starszego wydania kodu z gita.

**Kopie zapasowe — co naprawdę gdzie leży.** GitHub trzyma **wyłącznie kod**; nie ma tam ani bazy,
ani mediów. Jedyną kopią danych (konta, oceny, kolekcje, kolejki, statystyki) jest
`C:\wamp64\backups\media-server-20260817-pre-clean-install.sql` obok żywej bazy. Odkąd znikł stary
system, ten jeden plik jest całą siatką bezpieczeństwa dla danych — warto go odświeżać przed
każdą serią zmian, tak jak dotąd.

| Etap | Stan |
|---|---|
| M1–M5.6 | gotowe |
| M6 Utwardzenie wydania | **gotowe** (17.08.2026) |
| M7 Kontrolowany cutover | **następny w kolejce** |

M6 zamknęły dwa przebiegi opisane w `CHANGELOG.md`: pełna instalacja na prawdziwym Debianie 13
i test czystej instalacji na Windows z klonu widzianego przez gita. Obie ścieżki przeszły od
pustego katalogu do działającej usługi wraz z migracjami, buildem frontu i bramką; obie zostawiły
po sobie poprawki, a maszyny wróciły do stanu sprzed testów.

## M7 — kontrolowany cutover (zaakceptowany przez właściciela)

Stan każdego punktu sprawdzony w kodzie i na dysku 17.08.2026, nie przyjęty na słowo.

- [x] **Świeża kopia SQL i plików** — para `media-server-20260817-pre-clean-install` w
      `C:\wamp64\backups`, bez katalogów multimedialnych. Uwaga wyżej: GitHub **nie** jest kopią
      bazy.
- [x] **Porządki po okresie obserwacji** — zrobione, choć inaczej niż planowano: katalogi
      usunięte zamiast spakowane. Skutek dla reszty M7 opisany wyżej.
- [ ] **HTTPS przez istniejący VPS-proxy dla `home.tryhackx.org`** — nietknięte. W działającej
      konfiguracji (`C:\wamp64\alias\media-next-stage.conf`, identyczna z szablonem w repo) do
      zdjęcia jest **pięć** wystąpień `Require local` (linie 22, 59, 71, 87, 99) oraz
      `SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL "1"` (linia 16). Do tego trasy `/media-next/`
      i `/media-next-api` za proxy i **zaufany proxy dla adresu klienta** — bez tego throttling
      i CAPTCHA liczyłyby wszystkich jako jeden adres, czyli przestałyby działać.
- [ ] **Rozcięcie mostu sesji legacy** — **nie jest zrobione**, wbrew wrażeniu. `bridge.php:174`
      czyta wprawdzie `$config['session']['name']`, ale `BridgeConfigLoader.php:62` wpisuje tam
      literał `'PHPSESSID'`, więc nazwy nie da się zmienić. Brakuje jednego: odczytu z TOML-a
      z sensowną wartością domyślną. **Zrobiło się przy tym tańsze** — starej aplikacji już nie
      ma, więc nie ma z czym współdzielić ciasteczka; koszt to jedna runda wylogowań, a tabela
      `user_sessions` (migracja 036) pokaże, które sesje wypadły. `LegacySessionBridge` zostaje:
      mimo nazwy to bieżąca warstwa sesji (CSRF, odciski, wylogowywanie), a nie pomost do
      czegokolwiek.
- [ ] **Smoke test po przełączeniu** — do zrobienia **po** cutoverze; testy z 17.08 dotyczyły
      instalacji i wydania, nie przełączenia tras. Punkt „procedura powrotu do starych tras"
      **odpada**: nie ma już starych tras.

## Długi techniczne

### Czeka na właściciela

- **Restart Apache podnosi nową konfigurację aliasu** — `deploy/apache/media-next-stage-wamp.conf.example`
  (skopiowany też do katalogu `alias` WAMP-a) dostał typ MIME dla `.webmanifest` i `no-cache`
  dla `sw.js`. `httpd -t` przechodzi. Aplikacja tego nie potrzebuje (manifest wystawiany jest
  jako `manifest.json`, worker rejestrowany z `updateViaCache: "none"`), więc to porządek.
- **Aktywacja service workera niesprawdzona** — przeglądarka narzędzi agenta odrzuca każdą
  rejestrację, więc powłoka offline była weryfikowana statycznie. Pierwsze wejście z telefonu
  albo z Chrome właściciela to potwierdzi.
- **Restart stagingu na tej maszynie** — bieżący proces (PID z 16.08) nie daje się zatrzymać
  skryptem: `Win32_Process.CommandLine` wraca pusty, więc kontrola tożsamości w
  `stop-stage-windows.ps1` słusznie odmawia. Usługa działa i odpowiada; zmiany w Pythonie
  z ostatnich serii są wyłącznie w CLI, więc bieżący proces ich nie widzi i nie potrzebuje.
- **Zadanie przebiegu okresowego nie jest zarejestrowane** — kod i rejestrator są gotowe
  (`scripts\register-maintenance-task-windows.ps1`, przetestowany przebieg zajmuje ok. 3 minut),
  ale założenie zadania w Harmonogramie wymaga podniesionego PowerShell/UAC, czyli kliknięcia
  właściciela. Do tego czasu skan, kolejka metadanych i gatunki nadal ruszają wyłącznie z panelu
  albo z ręki. Na Debianie odpowiednikiem są timery `tryhackx-media-maintenance.timer`
  i `tryhackx-media-digest.timer`.
- **Trzy kolejki do domielenia** (nic do programowania) — w panelu → Indeksowanie: gatunki
  filmów (~1000 dzieł, ok. 1,2 s na zapytanie do Filmwebu), tagi muzyki (~11 tys. plików) i cache
  napisów (1062 ścieżki obrazkowe). Odciski plików dopełniają się przy kolejnych skanach
  (~19,4 tys. plików, porcja po 2000).

### Do zrobienia, gdy zacznie przeszkadzać

- **1468 wierszy z importu legacy czeka na dopasowanie** (`legacy_import_orphans`: 106 ocen
  i 1362 odtworzenia ze starego systemu, których nie dało się przypisać do plików). Kod importera
  został usunięty jako zrobiony, ale te dane zostały — do dopasowania po odciskach plików, gdy
  kolumna `content_fingerprint` będzie kompletna. Jeśli nigdy nie będą potrzebne, wystarczy
  migracja kasująca obie tabele.
- **`media_artwork_overrides.updated_by` z `ON DELETE RESTRICT`** — konta, które kiedykolwiek
  zmieniło okładkę utworu, nie da się usunąć. Aplikacja kont nie kasuje (dezaktywuje), więc
  problem jest uśpiony; playlisty naprawiła migracja 025, ten sam zabieg dla okładek warto zrobić
  razem z pierwszą funkcją, która naprawdę kasuje konto.
- **Nazwa urządzenia bierze się z `user agent`** („Windows · Chrome") — przy trzech
  przeglądarkach na jednej maszynie robi się nieczytelna. Miejsce na własną nazwę jest gotowe
  (`media-device-label` w `localStorage` wygrywa z wyliczoną), brakuje pola w interfejsie.
- **Nieudane zadania metadanych są tylko licznikiem** — pięć wpisów (trzy uszkodzone MP3, dwa
  pliki bez ścieżki wideo); warto pokazać listę z powodem.
- **Worker metadanych jest wolny na Windows** — każdy plik audio czytany w osobnym procesie
  (`multiprocessing spawn`), ok. 1,5 godziny na 12 800 utworów. Izolacja chroni przed
  uszkodzonym plikiem; do rozważenia jeden proces potomny na porcję zamiast na plik.
- **`.sub` nadal pominięte** — bywa tekstowym MicroDVD albo binarną połową pary VobSub,
  a rozróżnia się je zaglądając do środka.
- **Odcinki numerowane samą liczbą trafiają do przeglądu** — `Smerfy/305 - …` wygląda jak
  `Looney Tunes/1 - …`, a pierwsze to odcinek, drugie osobna kreskówka. Do rozważenia reguła
  większości w obrębie folderu, tak jak w `EpisodeOrder`.

### Świadome decyzje projektowe (nie do naprawy)

- **Zamknięta sesja ginie przy swoim najbliższym żądaniu**, nie natychmiast. Natychmiastowe
  zabicie wymagałoby trzymania identyfikatorów sesji, czyli tego, czego celowo się nie
  przechowuje. Gdyby kiedyś było potrzebne: własny `SessionHandlerInterface` z sesjami w bazie,
  razem z rozcięciem mostu sesji w M7.
- **Przejęcie kolejki nie budzi urządzenia, które nie gra** — znacznik czeka na jego najbliższy
  zapis, a zapisuje w trakcie odtwarzania. Nic wtedy nie gra, więc nie ma czego przerywać.
- **Historia statystyk ma dziurę po każdym restarcie usługi** — dziennik pisze proces
  transferowy. Próbki są rysowane takie, jakie są, bez interpolacji: zmyślona minuta wygląda
  dokładnie tak samo jak prawdziwa.
- **Linki gościnne działają dziś tylko z tej maszyny** — Apache trzyma `Require local` do M7.
  Po wystawieniu przez proxy zaczną działać bez zmian w kodzie.
- **Strefy czasu PHP i MySQL są tu różne** (dwie godziny). Porównania dat robić w SQL; dziś
  w kodzie nie ma już żadnego porównania znacznika z bazy z zegarem PHP.
- **Ponowne sortowanie przy stronicowaniu shuffle** — wpisane w projekt losowania z ziarnem.
- **MediaInfo zamiast `ffprobe`** — rozważone i **odrzucone** 16.08.2026: te same wartości we
  wszystkim, co pokazuje panel. MediaInfo daje ponadto rozdziały i luminancję mastering display;
  gdyby były potrzebne, to argument za **drugim** źródłem, nie za wymianą.

## Poza zakresem

Nie ruszamy **globalnych limitów PHP ani globalnego `Timeout` Apache** — limity czasu ustawiamy
wyłącznie na własnej trasie (`ProxyPass … timeout=3600`), żeby nie zmieniać zachowania reszty
serwera. To jedyne, co z tej listy zostało: `sources`, `soucres`, `www/music`, `www/movies`
i stare logowanie zostały usunięte 17.08.2026 i nie ma ich już czym chronić.
