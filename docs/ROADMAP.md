# Roadmapa TryHackX Media Server

Wyłącznie **otwarte** prace. Co zostało zamknięte i kiedy: `CHANGELOG.md`.

## Stan na 17.08.2026

System działa pod `/media-next/`, wyłącznie na localhost, i jest samodzielny: własne logowanie,
własna baza, cache i FFmpeg w `runtime/`. Kod leży w `C:\wamp64\media-server`, czyli **poza**
`DocumentRoot`, i jest w gicie (`github.com/TryHackX/media-server`, wydanie `v0.1.1`).
Migracje: do `039`.

| Etap | Stan |
|---|---|
| M1–M5.6 | gotowe |
| M6 Utwardzenie wydania | gotowe (17.08.2026) |
| M7 Kontrolowany cutover | **w toku** — zostały dwa punkty |

## M7 — kontrolowany cutover

Stan każdego punktu sprawdzony w kodzie i na dysku, nie przyjęty na słowo.

- [x] **Świeża kopia SQL i plików** — para `media-server-20260817-pre-clean-install`
      w `C:\wamp64\backups`, bez katalogów multimedialnych.
- [x] **Porządki po okresie obserwacji** — stare katalogi i logowanie usunięte.
- [x] **Rozcięcie mostu sesji legacy** — zrobione 17.08.2026. Ciasteczko nazywa się teraz
      `TRYHACKXSESSID` (`[session] name` w konfiguracji, walidowane: same litery i cyfry),
      a nie współdzielone `PHPSESSID`. Sprawdzone na żywo w nagłówku `Set-Cookie`; kosztowało
      **jedną** sesję, bo tyle było w `user_sessions`. `LegacySessionBridge` zostaje — mimo nazwy
      to bieżąca warstwa sesji (CSRF, odciski, wylogowywanie), a nie pomost do czegokolwiek.
- [ ] **HTTPS przez istniejący VPS-proxy dla `home.tryhackx.org`** — nietknięte i wymaga
      infrastruktury właściciela. W działającej konfiguracji
      (`C:\wamp64\alias\media-next-stage.conf`, identycznej z szablonem w repo) do zdjęcia jest
      **pięć** wystąpień `Require local` (linie 22, 59, 71, 87, 99) oraz
      `SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL "1"` (linia 16). Do dołożenia: trasy
      `/media-next/` i `/media-next-api` za proxy oraz **zaufany proxy dla adresu klienta** —
      bez tego throttling i CAPTCHA policzyłyby wszystkich jako jeden adres, czyli przestałyby
      chronić.
- [ ] **Smoke test po przełączeniu** — do zrobienia **po** cutoverze. Punkt „procedura powrotu
      do starych tras" odpada: nie ma już starych tras, a jedyne wycofanie to zrzut SQL plus
      starsze wydanie z gita.

## Długi techniczne

### Czeka na właściciela

- **Aktywacja service workera niesprawdzona** — przeglądarka narzędzi agenta odrzuca każdą
  rejestrację, więc powłoka offline była weryfikowana statycznie. Pierwsze wejście z telefonu
  albo z Chrome właściciela to potwierdzi.
- **Restart stagingu** — bieżący proces (PID z 16.08) nie daje się zatrzymać skryptem:
  `Win32_Process.CommandLine` wraca pusty, więc kontrola tożsamości w `stop-stage-windows.ps1`
  słusznie odmawia. **Od 17.08 to nie jest już tylko porządek**: poprawka roku w tagach siedzi
  w `metadata.py`, a usługa uruchamia workera metadanych u siebie — dopóki nie wstanie na nowo,
  przebiegi zlecane z panelu czytają tagi starym kodem. Dane już zapisane naprawiła migracja 039,
  więc karty pokazują rok poprawnie niezależnie od restartu.
- **Zadanie przebiegu okresowego nie jest zarejestrowane** — kod i rejestrator gotowe
  (`scripts\register-maintenance-task-windows.ps1`, przebieg zajmuje ok. 3 minut), ale założenie
  zadania w Harmonogramie wymaga podniesionego PowerShell/UAC. Na Debianie odpowiednikiem są
  timery `tryhackx-media-maintenance.timer` i `tryhackx-media-digest.timer`.
- **Dwie kolejki do domielenia** (nic do programowania), stan zmierzony 17.08:
  - **cache napisów obrazkowych — pusty**: 0 wyrenderowanych katalogów z 1062 ścieżek. To
    najdroższa z kolejek (minuty na ścieżkę), więc warto ją puścić nocą.
  - **odciski plików: 7706 z 20 323 pozycji nadal bez odcisku**; dopełniają się przy kolejnych
    skanach, porcja po 2000.
  - Gatunki filmów i tagi muzyki **są zrobione**: 1645 dzieł dopasowanych, kolejka metadanych
    pusta. Zostało 138 dzieł w przeglądzie — to praca człowieka, nie maszyny.

### Do zrobienia, gdy zacznie przeszkadzać

- **1468 wierszy z importu legacy czeka na dopasowanie** (`legacy_import_orphans`: 106 ocen
  i 1362 odtworzenia ze starego systemu). Do dopasowania po odciskach, gdy `content_fingerprint`
  będzie kompletne — dziś brakuje go 7706 pozycjom. Jeśli nigdy nie będą potrzebne, wystarczy
  migracja kasująca obie tabele.
- **`media_artwork_overrides.updated_by` z `ON DELETE RESTRICT`** (sprawdzone: więz
  `fk_artwork_overrides_user` nadal `RESTRICT`) — konta, które kiedykolwiek zmieniło okładkę
  utworu, nie da się usunąć. Aplikacja kont nie kasuje, tylko dezaktywuje, więc problem jest
  uśpiony; playlisty naprawiła migracja 025, ten sam zabieg dla okładek warto zrobić razem
  z pierwszą funkcją, która naprawdę kasuje konto.
- **Nazwa urządzenia bierze się z `user agent`** („Windows · Chrome") — przy trzech
  przeglądarkach na jednej maszynie robi się nieczytelna. Miejsce na własną nazwę jest gotowe
  (`media-device-label` w `localStorage` wygrywa z wyliczoną, czytane w `queue-sync.ts`),
  brakuje wyłącznie pola w interfejsie.
- **Nieudane zadania metadanych są tylko licznikiem** — dziś **10** wpisów; warto pokazać listę
  z powodem, bo licznik nie mówi, czy to uszkodzone pliki, czy błąd konfiguracji.
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
  przechowuje — w bazie jest tylko ich skrót. Rozcięcie mostu sesji (M7) tego nie zmieniło
  i nie miało zmieniać: własne ciasteczko to inna nazwa, a nie inny magazyn sesji.
- **Przejęcie kolejki nie budzi urządzenia, które nie gra** — znacznik czeka na jego najbliższy
  zapis, a zapisuje w trakcie odtwarzania. Nic wtedy nie gra, więc nie ma czego przerywać.
- **Historia statystyk ma dziurę po każdym restarcie usługi** — dziennik pisze proces
  transferowy. Próbki są rysowane takie, jakie są, bez interpolacji: zmyślona minuta wygląda
  dokładnie tak samo jak prawdziwa.
- **Linki gościnne działają dziś tylko z tej maszyny** — Apache trzyma `Require local` do końca
  M7. Po wystawieniu przez proxy zaczną działać bez zmian w kodzie.
- **Strefy czasu PHP i MySQL są tu różne** (dwie godziny). Porównania dat robić w SQL; dziś
  w kodzie nie ma już żadnego porównania znacznika z bazy z zegarem PHP.
- **Rok utworu to rok, nie data wydania** — tagi Vorbis niosą pod `date` pełne `1940-03-25`,
  a pole nazywa się `year`, jest tak pokazywane i tak odpytywane. Zapisujemy sam rok; pełna data
  z tagu nie jest nigdzie przechowywana i **nie jest** to przeoczenie.
- **Ponowne sortowanie przy stronicowaniu shuffle** — wpisane w projekt losowania z ziarnem.
- **MediaInfo zamiast `ffprobe`** — rozważone i **odrzucone** 16.08.2026: te same wartości we
  wszystkim, co pokazuje panel. MediaInfo daje ponadto rozdziały i luminancję mastering display;
  gdyby były potrzebne, to argument za **drugim** źródłem, nie za wymianą.

## Poza zakresem

Nie ruszamy **globalnych limitów PHP ani globalnego `Timeout` Apache** — limity czasu ustawiamy
wyłącznie na własnej trasie (`ProxyPass … timeout=3600`), żeby nie zmieniać zachowania reszty
serwera.
