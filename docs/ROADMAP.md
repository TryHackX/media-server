# Roadmapa TryHackX Media Server

Wyłącznie **otwarte** prace. Co zostało zamknięte i kiedy: `CHANGELOG.md`.

## Stan na 17.08.2026

System działa pod `/media-next/`, wyłącznie na localhost, i jest samodzielny: własne logowanie,
własna baza, cache i FFmpeg w `runtime/`. Kod leży w `C:\wamp64\media-server`, czyli **poza**
`DocumentRoot`, i jest w gicie (`github.com/TryHackX/media-server`). Migracje: do `038`.
Jedyna kopia zapasowa: `C:\wamp64\backups\media-server-20260816-pre-debian` (pliki) i
`…-pre-debian.sql` (baza) — historia kodu jest w gicie, więc starsze kopie nie są już do
niczego potrzebne.

Stare katalogi `www/music`, `www/movies` i stare logowanie zostają wyłącznie jako rollback do
zakończenia M7 — można je już ukryć (`Require all denied` albo przeniesienie poza `DocumentRoot`),
ale nie usuwać.

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

- świeża kopia SQL i plików aplikacji bez katalogów multimedialnych;
- **HTTPS przez istniejący VPS-proxy dla `home.tryhackx.org`** (dziś nie działa; operator
  właściciela blokuje zwykły HTTP): trasy `/media-next/` i `/media-next-api` za proxy, usunięcie
  `Require local` i wyjątku `TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL`, ustawienie zaufanego proxy dla
  adresu klienta (throttling i CAPTCHA liczą po IP);
- rozcięcie mostu sesji legacy: własna nazwa ciasteczka zamiast współdzielonego `PHPSESSID`.
  Konta, oceny i ulubione są w bazie i nie są ruszane, a tabela `user_sessions` (migracja 036)
  pokaże wprost, które sesje po zmianie wypadły;
- smoke test po przełączeniu i gotowa procedura powrotu do starych tras;
- **porządki po okresie obserwacji**: `C:\wamp64\www\movies` i `C:\wamp64\www\music` spakować do
  ZIP na pulpicie **bez podążania za dowiązaniami** (katalogi zawierają dowiązania do dysku `E:`,
  inaczej archiwum urośnie do terabajtów). Samo drzewo aplikacji jest już poza `www`.

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

Nie usuwamy `sources`/`soucres`, plików Music/Movies, starego logowania, globalnych limitów PHP
ani globalnego `Timeout` Apache przed zakończeniem M7.
