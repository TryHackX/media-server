# Instalacja i aktualizacja na Debianie 13

Natywnie: Python, Apache i systemd. Docker nie jest potrzebny i nie jest wspierany.
Ta instrukcja opisuje **środowisko produkcyjne** — z jednym katalogiem na wersję
i dowiązaniem `current`, które przełącza się dopiero po udanym smoke teście.
Instalacja robocza na własnym koncie (bez systemd, bez `/opt`) to `scripts/install-debian.sh`.

## Pakiety

```bash
sudo apt update
sudo apt install python3 python3-venv apache2 libapache2-mod-php \
    php-cli php-mysql php-mbstring php-curl php-xml \
    default-mysql-server default-mysql-client ffmpeg curl rsync
sudo a2enmod proxy proxy_http headers
```

Trzy rozszerzenia PHP z tej listy są **obowiązkowe, a łatwo je przeoczyć**,
bo `php -l` przechodzi bez nich: most używa `mb_*` w każdej ścieżce katalogu
i logowania, `curl_*` w wywołaniach do usługi transferowej i w CAPTCHA-y, a
`simplexml_load_string` w imporcie playlist XSPF. Bez nich instalacja wygląda
na udaną, a most wywala się na pierwszym żądaniu. `php-cli` jest osobno, bo
`libapache2-mod-php` daje tylko moduł Apache, a jednostka przeglądu nowości
uruchamia `/usr/bin/php`. Sprawdzenie: `php -r 'foreach (["mbstring","curl",
"simplexml","pdo_mysql"] as $e) printf("%s=%s\n", $e, extension_loaded($e) ? "OK" : "BRAK");'`

Node i npm są potrzebne **wyłącznie** do budowania frontendu ze źródeł
(`--build-frontend`); wydanie może przyjechać z gotowym `public/assets/build`.
FFmpeg jest tu pakietem systemowym — na Debianie nie pobieramy własnego buildu,
więc w konfiguracji zostaje `ffmpeg_path = "ffmpeg"` (wyszukiwane w PATH).

**Brak `ffmpeg` nie blokuje instalacji, tylko po cichu wyłącza połowę funkcji.**
`media-server check` przechodzi, usługa wstaje i odpowiada, a kolejka metadanych
kończy każde zadanie błędem: nie ma czym odczytać ani czasu trwania filmu, ani
miniatury, ani napisów. Zmierzone na maszynie bez FFmpeg: przebieg okresowy
raportuje `"claimed": 5, "failed": 5`. Sam pakiet trzeba więc mieć **przed**
pierwszym przebiegiem, a nie „kiedyś".

## Układ katalogów

| Ścieżka | Co tam leży |
|---|---|
| `/opt/tryhackx-media-server/releases/RRRRMMDD-GGMMSS` | jedno wydanie = jedno drzewo, tylko do odczytu |
| `/opt/tryhackx-media-server/current` | dowiązanie do aktywnego wydania — to czyta usługa i Apache |
| `/opt/tryhackx-media-server/previous` | poprzednie wydanie, cel `--rollback` |
| `/etc/tryhackx-media-server/config.local.toml` | prywatna konfiguracja, `root:www-data`, tryb `0640` |
| `/var/lib/tryhackx-media-server` | cache miniatur i napisów, cache Filmwebu, dziennik statystyk |
| `/var/log/tryhackx-media-server` | `media-server.jsonl` i spool poczty |
| `/srv/media/...` | biblioteki, montowane **tylko do odczytu** |

**Biblioteki nie mogą leżeć w `/home` ani w `/root`.** Jednostka ma
`ProtectHome=true`, więc usługa tych katalogów po prostu **nie widzi**. Objaw
jest mylący: `systemctl status` pokazuje „active (running)", a `/health/ready`
oddaje **503** z `{"unavailable_roots":["movies","music"]}` — i skrypt wydania
słusznie cofa każde kolejne wydanie, bo smoke test nigdy nie przechodzi.
Sprawdzone na żywo: `sudo -u www-data ls` widzi katalog w `/home`, a ten sam
`ls` w namespace jednostki dostaje „Permission denied".

Wewnątrz każdego wydania `runtime/` i `logs/` są **dowiązaniami** do dwóch
ostatnich katalogów. Nie jest to ozdoba: `media_server.config.PROJECT_ROOT`
rozwiązuje dowiązania, więc widzi katalog wersji, a nie `current`. Bez tych
dwóch dowiązań każda aktualizacja zaczynałaby z pustym cache miniatur i gubiła
historię statystyk, a `ProtectSystem=strict` i tak nie pozwoliłby w to miejsce
zapisać. Ścieżki względne z konfiguracji (`runtime/thumbnails`) trafiają dzięki
temu zawsze do `/var/lib/tryhackx-media-server`.

Spool poczty idzie domyślnie do `logs/mail`, czyli
`/var/log/tryhackx-media-server/mail` — tam lądują listy aktywacyjne i
cotygodniowy przegląd, dopóki nie skonfigurowano SMTP. Własne miejsce ustawia
`mail.spool_path` (ścieżka bezwzględna).

## Pierwsza instalacja

Kod może stać gdziekolwiek — skrypt wydania kopiuje z niego drzewo. Poniżej
`~/src/media-server` to klon repozytorium, a nie miejsce, z którego coś działa.

**1. Katalogi i konfiguracja.** Biblioteki muszą być już zamontowane: instalator
sprawdza, czy istnieją.

```bash
sudo install -d -m 0750 -o root -g www-data /etc/tryhackx-media-server
cd ~/src/media-server
sudo MEDIA_SERVER_DB_PASSWORD='silne-osobne-haslo' python3 scripts/install.py --config-only \
    --config /etc/tryhackx-media-server/config.local.toml \
    --music-root /srv/media/music --movies-root /srv/media/movies
sudo chown root:www-data /etc/tryhackx-media-server/config.local.toml
sudo chmod 0640 /etc/tryhackx-media-server/config.local.toml
```

Instalator zapisuje plik jako `0600` dla roota — bez tych dwóch poleceń usługa
i most PHP go nie przeczytają. `--config-only` tworzy samą konfigurację (klucz
transferowy jest losowany na miejscu) i nie buduje środowiska Pythona; zrobi to
za chwilę skrypt wydania, osobno dla każdej wersji.

Dwie wartości warto sprawdzić w wygenerowanym pliku: `ffmpeg_path` ma być
`"ffmpeg"`, a `video_encoder` — `"libx264"`. **`h264_nvenc` na tej jednostce nie
zadziała**: `PrivateDevices=true` ukrywa `/dev/nvidia*`, i jest to świadomy
wybór — kodowanie sprzętowe nie jest wart otwierania usłudze dostępu do urządzeń.

**2. Baza.** Jedna pusta baza i dedykowane konto; aplikacja nigdy nie łączy się
jako `root`.

```sql
CREATE DATABASE media_server CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'media_server'@'localhost' IDENTIFIED BY 'silne-osobne-haslo';
GRANT SELECT, INSERT, UPDATE, DELETE ON media_server.* TO 'media_server'@'localhost';
```

Konto aplikacji dostaje wyłącznie DML. **Migracje wymagają DDL** i uruchamia się
je osobnym kontem — tak samo jak na Windows, gdzie robi to `root@localhost`.
Najprościej: druga konfiguracja tylko dla migracji, wskazywana przez
`--migrate-config` (ten sam plik z innym `[database].user` i hasłem, prawa
`0600` dla roota).

**3. Pierwsze wydanie.** Jednostki systemd jeszcze nie ma, więc nie ma czego
restartować ani odpytywać:

```bash
sudo scripts/release-debian.sh --build-frontend --migrate \
    --migrate-config /etc/tryhackx-media-server/config.migrate.toml \
    --no-service --no-health
```

Skrypt tworzy `releases/…`, kopiuje drzewo bez `.git`, `.venv`, `node_modules`
i prywatnych plików, zakłada dowiązania stanu, buduje `.venv` z
`requirements.lock` **z weryfikacją hashy**, uruchamia `media-server check`,
stosuje migracje i przełącza `current`.

**4. Usługa.**

```bash
sudo cp deploy/systemd/tryhackx-media-transfer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tryhackx-media-transfer
curl --fail http://127.0.0.1:8765/health/ready
```

Jednostka tworzy `/var/lib/tryhackx-media-server` i `/var/log/tryhackx-media-server`
(`StateDirectory` i `LogsDirectory`) z właścicielem `www-data` i sama dokłada je
do `ReadWritePaths` — to jedyny powód, dla którego zapis przez dowiązania działa
przy `ProtectSystem=strict`. Jeśli cache zostały wyprowadzone gdzie indziej
opcjami `--thumbnail-cache` / `--subtitle-cache`, dopisz tamte katalogi do
`ReadWritePaths=` w jednostce.

**5. Pierwszy skan — trzeba go zrobić z ręki.** To on decyduje, czym jest każde
źródło (muzyka, filmy, mieszane), i zapisuje tę decyzję w `media_roots`.

```bash
sudo -u www-data /opt/tryhackx-media-server/current/.venv/bin/python -m media_server \
    --config /etc/tryhackx-media-server/config.local.toml scan --root music --kind music --apply
sudo -u www-data /opt/tryhackx-media-server/current/.venv/bin/python -m media_server \
    --config /etc/tryhackx-media-server/config.local.toml scan --root movies --kind movies --apply
```

**Bez tego przebieg okresowy nie robi nic — i nigdy nie zacznie.** Rodzaju
źródła nie da się zgadnąć z nazwy katalogu, więc źródło bez wpisu w
`media_roots` jest pomijane z powodem (przebieg wypisuje wtedy dokładnie to
polecenie). Zmierzone na świeżej instalacji: przed pierwszym skanem przebieg
kończy się w 0,06 s ze wszystkimi źródłami pominiętymi.

**6. Przebieg okresowy.** Dopiero teraz serwer sam zauważy nowy film.

```bash
sudo cp deploy/systemd/tryhackx-media-maintenance.{service,timer} /etc/systemd/system/
sudo cp deploy/systemd/tryhackx-media-digest.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tryhackx-media-maintenance.timer tryhackx-media-digest.timer
systemctl list-timers 'tryhackx-*'
sudo systemctl start tryhackx-media-maintenance.service   # pierwszy przebieg od ręki
```

Przebieg okresowy (04:15) robi skan każdego źródła, porcję kolejki metadanych i porcję gatunków
filmów. Przegląd nowości (05:10) jest **osobną jednostką**, a nie drugą linią tej samej: zerwane
połączenie z Filmwebem nie ma prawa wstrzymać poczty, a poczta nie ma prawa przesłonić błędu
skanu. Codzienne uruchomienie przeglądu jest bezpieczne — tygodniowy odstęp pilnuje on sam, w SQL.

Dwie rzeczy w jednostce przebiegu są tam z konkretnego powodu. `TimeoutStartSec=6h`, bo
`Type=oneshot` domyślnie poddaje się po **90 sekundach**, a sam skan zajmuje tu ponad dwie minuty
przy niezmienionej bibliotece — bez tej linii nocna robota ginęłaby w połowie, co noc. `Nice=10`
i `IOSchedulingClass=idle`, bo gdyby ktoś oglądał film o czwartej rano, ma to być jego film,
a nie skan. Nakładania się przebiegów pilnuje systemd: jednostka nie uruchomi się drugi raz obok
siebie.

**7. Apache.**

```bash
sudo cp deploy/apache/media-next.conf.example /etc/apache2/conf-available/media-next.conf
sudo cp deploy/apache/media-transfer.conf.example /etc/apache2/conf-available/media-transfer.conf
# odkomentuj i ustaw obie linie Define w media-next.conf:
#   Define TRYHACKX_MEDIA_ROOT "/opt/tryhackx-media-server/current"
#   Define TRYHACKX_BRIDGE_CONFIG "/etc/tryhackx-media-server/config.local.toml"
sudo a2enconf media-next media-transfer
sudo apache2ctl configtest
sudo systemctl reload apache2
```

**Kolejność nie jest kosmetyczna.** `apache2.conf` Debiana wciąga wyłącznie
`conf-enabled/*.conf`, więc `configtest` uruchomiony **przed** `a2enconf`
sprawdza wszystko oprócz tych dwóch plików i mówi „Syntax OK" o konfiguracji,
której nie przeczytał. Gdy test po włączeniu nie przejdzie, wyłącz je
(`sudo a2disconf media-next media-transfer`) i dopiero wtedy przeładuj — reload
z błędną konfiguracją zatrzymuje **cały** serwer, a nie tylko te trasy.

`configtest` łapie brak `mod_headers` („Invalid command 'Header'"), `mod_env`
(„Invalid command 'SetEnv'") i `mod_alias` („Invalid command 'RedirectMatch'"),
natomiast **brak `mod_proxy_http` przechodzi jako „Syntax OK"** i odzywa się
dopiero przy pierwszym pobraniu pliku. `a2enmod proxy_http` nie jest więc
opcjonalny, tylko niewidoczny — sprawdzone: obie konfiguracje przechodzą
`apache2 -t` na Debianie 13 z modułami z listy wyżej.

Apache patrzy na `current`, więc **aktualizacja aplikacji nie wymaga dotykania
Apache** — ani przeładowania, ani zmiany ścieżki. Trasa `/media-transfer/` ma
własny `timeout=3600`: bez niego film albo ZIP przerywałby się po domyślnym
`Timeout` (60 s), bo to jedno długie żądanie. Globalne limity PHP i Apache
zostają nietknięte. Po pełnym cutover bezpośredni dostęp do katalogów
multimedialnych musi być niemożliwy.

## Aktualizacja

```bash
cd ~/src/media-server && git pull
sudo scripts/release-debian.sh --build-frontend --migrate \
    --migrate-config /etc/tryhackx-media-server/config.migrate.toml
```

Kolejność jest tu całą treścią: nowe wydanie powstaje **obok** działającego,
dostaje własne `.venv`, przechodzi `media-server check`, dostaje migracje —
i dopiero wtedy `current` przełącza się jednym `rename()`, usługa restartuje,
a skrypt czeka na `health/ready`. Gdy nowe wydanie nie odpowie w zadanym czasie
(`--timeout`, domyślnie 60 s), skrypt **sam wraca na poprzednie**, restartuje je
i kończy się błędem. Odrzucony katalog zostaje do wglądu.

Na dysku zostaje tyle wydań, ile mówi `--keep` (domyślnie 3, minimum 2):
aktywne, poprzednie i jedno zapasowe. `current` i `previous` liczą się do tej
liczby i nigdy nie są usuwane. Usuwane są wyłącznie katalogi o nazwie, którą
skrypt sam wygenerował — nic obcego, co ktoś odłożył w `releases/`, nie zniknie.

## Rollback

```bash
scripts/release-debian.sh --list
sudo scripts/release-debian.sh --rollback
sudo scripts/release-debian.sh --switch 20260815-201500
```

`--rollback` wraca do wydania spod `previous`; po powrocie `previous` wskazuje
to, z którego wróciliśmy, więc drugie `--rollback` idzie z powrotem do przodu.
Wybór dowolnego wydania z listy to `--switch`.

**Rollback kodu nie cofa migracji.** Przed wydaniem robi się kopię SQL, a
migracje pisze się tak, by starsze wydanie nadal na nich działało. To jedyny
element, którego dowiązanie nie załatwia.

## Czego skrypt wydania nie robi

Nie instaluje pakietów, nie tworzy bazy ani konta, nie konfiguruje Apache i nie
zakłada jednostki systemd. Wszystkie te kroki są jednorazowe, wymagają decyzji
i są wypisane wyżej. `--dry-run` wypisuje cały plan bez zmieniania czegokolwiek.

## Logi i diagnostyka

```bash
curl --fail http://127.0.0.1:8765/health/ready
curl --fail http://127.0.0.1:8765/health/status
sudo journalctl -u tryhackx-media-transfer --since today
sudo journalctl -u tryhackx-media-maintenance --since yesterday
sudo tail -n 50 /var/log/tryhackx-media-server/media-server.jsonl
ls -l /opt/tryhackx-media-server/
systemctl list-timers 'tryhackx-*'
```

Aplikacja zapisuje JSON Lines z rotacją 10 MiB i pięcioma kopiami; dziennik
systemd nadal pokazuje cykl życia jednostki. `/health/status` nie zawiera
sekretów ani ścieżek, a pełne tokeny są redagowane w nazwie trasy.
