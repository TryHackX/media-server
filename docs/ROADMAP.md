# Roadmapa TryHackX Media Server

Wyłącznie **otwarte** prace. Co zostało zamknięte i kiedy: `CHANGELOG.md`.

## Stan na 17.08.2026

System działa pod **głównym adresem** (`/`, nie pod podkatalogiem) i od 17.08.2026 jest
**wystawiony publicznie** przez reverse proxy. Jest samodzielny: własne logowanie, własna baza,
cache i FFmpeg w `runtime/`. Kod leży w `C:\wamp64\media-server`, czyli **poza** `DocumentRoot`,
i jest w gicie (`github.com/TryHackX/media-server`, wydanie `v0.2.0`). Migracje: do `039`.

| Etap | Stan |
|---|---|
| M1–M5.6 | gotowe |
| M6 Utwardzenie wydania | gotowe (17.08.2026) |
| M7 Kontrolowany cutover | **przełączone (17.08.2026)** — zostało przeładowanie po poprawce reguły zdrowia |

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
- [x] **Kod pod wystawienie publiczne** — zrobione 17.08.2026 i opisane w `PUBLIC-EXPOSURE.md`.
      `[proxy] trusted` włącza naraz rozpoznanie **kto** jest gościem (`X-Forwarded-For`)
      i **czym** przyszedł (`X-Forwarded-Proto`) — oba wyłącznie od wypisanego hosta, puste
      domyślnie, więc instalacja wprost (i cudza, z GitHuba) działa bez żadnych sztuczek.
      `session.require_https` czytane też z TOML-a. Konfiguracje Apache mają wariant lokalny
      i publiczny, `/media-transfer/` da się otworzyć (inaczej nic nie zagra), a zdrowie
      i zlecenia zadań są zamknięte osobną regułą. Brakujące `Define` wywalają teraz `configtest`
      zamiast cicho przechodzić.
- [x] **Konfiguracja cutoveru przygotowana** (17.08.2026) — pięć `Require local` zamienionych na
      `Require all granted`, dołożona **osobna** reguła zamykająca zdrowie i zlecenia zadań
      usługi transferowej, wejście pod gołym `/` prowadzi do biblioteki, a `[proxy] trusted`
      ma adresy VPS-a. Plik jest w `C:\wamp64\alias\media-next-stage.conf`, `httpd -t` przechodzi.
      **`SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL` zostaje** — wbrew temu, co tu wcześniej stało:
      dopuszcza zwykłe HTTP **wyłącznie z pętli zwrotnej**, więc bez niej zepsułby się localhost,
      a gość z zewnątrz (peer = VPS) i tak musi mieć HTTPS.
- [x] **Przeładowanie Apache** — zrobione przez właściciela 17.08.2026. Dostęp jest otwarty.
- [x] **Smoke test po przełączeniu** — wykonany na żywo przez publiczny adres, na koncie
      tymczasowym skasowanym po `username` (stan kont przed i po: 3). Przeszły: logowanie po
      HTTPS, wydanie tokenu transferowego i odtworzenie zakresu bajtów (`206`, 2048 B),
      przekierowanie z `http://` (`301`) oraz ignorowanie podrobionego `X-Forwarded-For`
      (dwa różne nagłówki → ten sam `client_hash`). **Padł jeden punkt** — zdrowie usługi
      transferowej odpowiadało publicznie; przyczyna i poprawka niżej.
      Punkt „procedura powrotu do starych tras" odpada: nie ma już starych tras, a jedyne
      wycofanie to zrzut SQL plus starsze wydanie z gita.

Zostały trzy rzeczy, których nie da się sprawdzić z powłoki agenta:

- [ ] **Przeładowanie Apache po poprawce reguły zdrowia** — żywa konfiguracja stagingu jest już
      poprawiona i przechodzi `httpd -t`, ale do przeładowania `/media-transfer/health/ready`
      nadal odpowiada `200`. Że po przeładowaniu odda `403`, jest **zmierzone**: ten sam plik
      wciągnięty do osobnego `httpd` na wolnym porcie oddaje `403` na zdrowiu i na
      `v1/catalog-scan`, przy niezmienionym `403` na trasie transferu i `200` na aplikacji.
- [ ] **Rejestracja mailem** — link buduje się z `[app] base_url`, które jest pełnym adresem
      publicznym i zgadza się z bazą frontu (`media-server check`: `agree: true`). Samej
      **dostarczalności** nie sprawdzono: wymaga prawdziwej skrzynki, a rejestracja na adres
      zmyślony to odbita wiadomość i zepsuta reputacja nadawcy.
- [ ] **Instalacja PWA z telefonu i powłoka offline** — jedyny sposób sprawdzenia service
      workera; przeglądarka narzędzi agenta odrzuca każdą rejestrację.

**Topologia sprawdzona empirycznie 17.08.2026**, bo różni się od pierwotnego założenia: TLS
kończy się **na tej maszynie** (`_default_:443`, `fullchain.pem`), a VPS jest proxy HTTP —
`HTTPS=on`, `X-Forwarded-For` i `X-Forwarded-Proto` ustawione, przekierowanie z portu 80 na
HTTPS robi już samo proxy. Adresy proxy stoją w `[proxy] trusted` w prywatnej konfiguracji
i nie są tu przepisywane. DNS `home.tryhackx.org` wskazuje na VPS, łącze domowe ma inny adres.

## Długi techniczne

### Czeka na właściciela

- **Aktywacja service workera niesprawdzona w prawdziwej przeglądarce** — przeglądarka
  narzędzi agenta odrzuca każdą rejestrację. 17.08 przegląd wykazał, że worker miał wpisaną
  na sztywno bazę `/media-next/` i po przeprowadzce pod `/` ignorował każde żądanie; baza
  bierze się teraz z jego własnego adresu, a test node sprawdza obie ścieżki. **Czego test
  nie sprawdzi**: czy przeglądarka rzeczywiście go zarejestruje i czy ikona z ekranu
  telefonu otwiera się bez paska adresu. Pierwsze wejście z telefonu po HTTPS to potwierdzi
  — i ono jedno pokaże, czy powłoka offline działa naprawdę.
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

- **Pierwsze konto zakłada się SQL-em** — świeża instalacja nie ma żadnego konta, a rejestracja
  jest domyślnie wyłączona, więc jedyne wejście prowadzi przez `UPDATE app_settings`, rejestrację
  i `UPDATE users SET role = 'super_admin'`. Od 17.08 jest to opisane w obu instrukcjach jako
  osobny krok, ale właściwym rozwiązaniem byłoby polecenie (`media-server account-create`
  albo skrypt PHP obok `digest.php` — hasła liczy `password_hash()`, więc naturalniej po stronie
  PHP). Dopóki instalacja jest jedna, kosztuje to raz w życiu serwera.

- **Poczta wychodząca przedstawia się nazwą serwera** — `Mailer::heloName()` bierze
  `SERVER_NAME` na komendę `HELO`. Trafia to do serwera SMTP i nagłówków wiadomości, nie do
  przeglądarki gościa, ale przy wystawieniu przez proxy warto, żeby dało się to ustawić
  w konfiguracji zamiast zgadywać z żądania.

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
- **Linki gościnne są domyślnie wyłączone** (`app_settings.guest_links_enabled`) i takie zostają:
  wystawienie publiczne (17.08.2026) zdjęło z nich `Require local`, więc działają już bez zmian
  w kodzie, ale włączenie ich to świadoma decyzja właściciela, a nie stan domyślny.
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
