# Instalacja na Windows + WAMP

## Instalacja kreatorem (zalecana)

Od wersji z 12.11.2026 instalację od zera robi **kreator**: okno, które sprawdza komputer, pyta
o kilka rzeczy, pokazuje listę wszystkich zmian i dopiero po zatwierdzeniu je wprowadza. Reszta
tego dokumentu („Instalacja ręczna”) opisuje te same kroki wykonywane poleceniami — dla kogoś,
kto chce wiedzieć, co kreator robi, albo woli zrobić to sam.

**Czego kreator nie robi:** nie instaluje WampServera (prowadzi do strony pobierania i sprawdza
ponownie), nie konfiguruje routera, DNS ani VPS (daje do tego gotową instrukcję i pliki) i nie
zdobywa certyfikatu Let's Encrypt.

### Zanim zaczniesz

1. **WampServer 64-bit** (Apache 2.4, PHP 8.1+, MySQL 8.0.19+ albo MariaDB 10.5.2+) razem z pakietami
   Visual C++, których wymaga — uruchomiony przynajmniej raz, z zieloną ikoną.
2. **Python 3.11+** (64-bit) i — dla miniatur, danych o filmach, napisów obrazkowych i trybu
   zgodnego — **FFmpeg**. Jeśli ich nie ma, kreator pokaże przycisk „Zainstaluj (winget)”,
   odnośnik do oficjalnej strony albo pozwoli wskazać istniejący `ffmpeg.exe`.
3. **Program — jedna z dwóch dróg** (wynik ten sam):
   - **Paczka wydania** `TryHackX-Media-Server-<wersja>-windows.zip` (strona *Releases* na
     GitHubie), rozpakowana w całości — przed rozpakowaniem: Właściwości pliku ZIP → „Odblokuj”,
     inaczej Windows zapyta o zgodę przy pierwszym uruchomieniu. Zawiera gotowy front: bez gita,
     bez budowania, bez Node.js. Uruchamiasz `Zainstaluj.cmd` z rozpakowanego folderu.
   - **Klon z GitHuba.** Kreator sam zbuduje front przed instalacją (`npm ci`, `npm run build`;
     kilka minut, pakiety z npm) — za każdym razem, także przy aktualizacji, więc po `git pull`
     instaluje się front pobranego kodu. Potrzebny jest **Node.js** 20.19+ albo 22.12+ (LTS);
     gdy go nie ma, strona wymagań pokaże „Zainstaluj (winget)” (`OpenJS.NodeJS.LTS`). W PowerShellu,
     w folderze, w którym ma leżeć klon (np. `C:\`):

     ```powershell
     winget install --id Git.Git -e
     git config --global core.longpaths true
     git clone https://github.com/TryHackX/media-server.git
     git clone https://github.com/TryHackX/media-server-vendor.git media-server/frontend/vendor
     .\media-server\Zainstaluj.cmd
     ```

     - pierwsze polecenie tylko wtedy, gdy nie ma gita; drugie raz na komputer — nazwy
       niektórych presetów MilkDropa mają do 210 znaków poniżej `frontend\vendor`, a bez tego klon
       w głębszym folderze kończy się „Filename too long”;
     - czwarte to paczki, których repozytorium nie ma (presety AVS i MilkDropa, tekstury, shadery,
       Font Awesome Pro — `FRONTEND.md`), z prywatnego repozytorium
       [media-server-vendor](https://github.com/TryHackX/media-server-vendor) — tylko z dostępem do
       niego; pierwsze klonowanie otworzy logowanie do GitHuba. Bez niego powstaje front
       publiczny. Zamiast gita: „Code → Download ZIP” i rozpakowanie tak, żeby foldery paczek
       (`avs-presets`, `fontawesome-pro`…) leżały wprost w `frontend\vendor`;
     - strona wymagań wymieni paczki z nazwy, a pierwszy krok instalacji to „Zbudowanie
       interfejsu”; do instalacji trafia gotowy front — folder `frontend\` (źródła, paczki,
       `node_modules`) zostaje w klonie.

     Aktualizacja z klonów: `git -C media-server pull` i `git -C media-server/frontend/vendor pull`,
     potem `Zainstaluj.cmd` z klona → **Aktualizacja**.

### Uruchomienie

Dwuklik **`Zainstaluj.cmd`** w rozpakowanym folderze. Kreator poprosi o uprawnienia
administratora (UAC): zmienia konfigurację Apache, zaporę i Harmonogram zadań. Polityka
wykonywania skryptów PowerShell jest pomijana wyłącznie dla tego jednego procesu.

**Konto, które zatwierdza UAC, staje się właścicielem instalacji.** Na nim działają oba zadania
w Harmonogramie i tylko ono (obok SYSTEM i administratorów) czyta prywatną konfigurację. Jeśli
na co dzień pracujesz na koncie bez praw administratora i w oknie UAC wpisujesz inne — foldery
z mediami muszą być czytelne dla tego drugiego.

| Polecenie | Co robi |
|---|---|
| `Zainstaluj.cmd` | kreator: instalacja albo — gdy serwer już jest — zmiana ustawień |
| `Zainstaluj.cmd -Language en` | to samo po angielsku (język można też przełączyć na pierwszej stronie) |
| `Zainstaluj.cmd -DryRun` | **tryb próbny**: cała ścieżka, ale każda zmiana jest tylko opisana w dzienniku; bez UAC |
| `Zainstaluj.cmd -DryRun -AnswerFile installer\examples\answers-vps.json` | tryb próbny bez okna: odpowiedzi z pliku JSON, zapis przebiegu na ekranie |
| `Zainstaluj.cmd -Preview -ScreenshotDir C:\zrzuty` | rysuje wszystkie strony z przykładowymi danymi do plików PNG; niczego nie czyta ani nie zmienia (`-Scale 1.5` — układ dla 150 %) |

Plik odpowiedzi działa **wyłącznie** z `-DryRun`: hasło w pliku nie jest sposobem na instalację.

### Strony kreatora

Nazwy zrzutów to pliki, które tworzy `-Preview` (u właściciela: `scratch\renders\installer\pl`
i `…\en`, w skali 150 % `pl-150` i `en-150`).

| Strona | O co pyta / co pokazuje | Zrzut |
|---|---|---|
| Powitanie | język; co się wydarzy | `01-welcome.png` |
| Wymagania | system, WampServer, Apache (moduły), PHP (rozszerzenia), baza, Python, FFmpeg, interfejs (gotowy albo — w klonie — do zbudowania, z Node.js i paczkami z `frontend\vendor`), porty 80/443/8765, miejsce na dysku — każde ze stanem, wyjaśnieniem i akcją; „Sprawdź ponownie” | `02-requirements.png`, `…-missing.png`, `…-no-wamp.png` |
| Miejsce instalacji | nowy folder (domyślnie `C:\TryHackX\MediaServer`, pliki są kopiowane) albo praca z bieżącego folderu | `03-location.png` |
| Baza danych | serwer (MySQL/MariaDB z WampServera), konto administratora z „Sprawdź połączenie”, nazwa bazy i konta aplikacji | `04-database.png`, `04-database-error.png` |
| Foldery z mediami | lista folderów z rodzajem (Muzyka / Filmy / Mieszane); co najmniej jeden | `05-media.png`, `05-media-problem.png` |
| Dostęp | jeden z czterech trybów (niżej) i tylko to, czego ten tryb potrzebuje | `06-access-local.png`, `…-lan.png`, `…-direct.png`, `…-vps.png` |
| Administrator | nazwa, e-mail (opcjonalny), hasło dwa razy (co najmniej 12 znaków) | `07-admin.png` |
| Podsumowanie | **każda zmiana**, która zostanie wprowadzona; opcje do odznaczenia | `08-summary.png` |
| Wykonanie | kroki ze stanem, dziennik na żywo (hasła zastąpione gwiazdkami), „Zapisz dziennik…”, przy błędzie „Spróbuj ponownie” | `09-progress-running.png`, `09-progress-failed.png` |
| Gotowe | adresy (lokalny, w sieci domowej, publiczny), „Otwórz w przeglądarce”, folder z plikami dla VPS | `10-finish.png` |

Wymagania czytane są z kodu, nie z pamięci: moduły Apache to dyrektywy z
`deploy/apache/media-next-stage-wamp.conf.example` (`alias`, `authz_core`, `authz_host`, `dir`,
`env`, `headers`, `mime`, `proxy`, `proxy_http`, a dla dwóch trybów z HTTPS także `ssl`
i `socache_shmcb`); rozszerzenia PHP to `pdo_mysql`, `openssl` i `mbstring` (bez `curl`,
`SimpleXML` i `iconv` nie działa CAPTCHA zewnętrznych dostawców i import playlist — kreator
ostrzega, ale nie blokuje). Moduł wyłączony w `httpd.conf` kreator włączy sam; brakującego
rozszerzenia PHP nie — włącza się je z menu WampServera.

### Cztery tryby dostępu

To kształty C, D, B i A z `PUBLIC-EXPOSURE.md`, w kolejności od najprostszego.

| Tryb | Apache (`Require` w pliku kreatora) | Prywatna konfiguracja | Zapora Windows | Poza tym |
|---|---|---|---|---|
| **Tylko ten komputer** | `Require local` | bez `[app]`, `[proxy]`, `[session]` | kreator jej nie dotyka | — |
| **Sieć domowa** (HTTP) | `Require local` + adresy prywatne | `[session] require_https = false` | TCP 80 tylko z `LocalSubnet` | ostrzeżenie: hasło leci tekstem; aplikacji nie da się zainstalować na telefonie (PWA wymaga HTTPS) |
| **Własna domena, wprost** | `Require all granted`; host `*:443` z Twoim certyfikatem i HSTS, host `*:80` z przekierowaniem | `[app] base_url = "https://domena/"` | TCP 80 i 443 dla wszystkich | certyfikat: wskazane pliki PEM (np. z win-acme) albo tymczasowy, podpisany samodzielnie; router: porty 80 i 443 |
| **Przez VPS** | `Require local` + adres(y) VPS (+ adresy prywatne na życzenie); host `*:443` z własnym certyfikatem domowym | `base_url` jak wyżej, `[proxy] trusted = "<adres VPS>"` | TCP 443 **tylko z adresu VPS** (+ `LocalSubnet` na życzenie); ogólne reguły „Apache HTTP Server” wyłączone | folder `runtime\vps-bundle` z dwoma hostami dla VPS, `origin.crt`, `maintenance.html`, instrukcją (także jako `.txt` do Notatnika) i `vps-setup.sh`, który robi na VPS-ie wszystkie kroki ze sprawdzeniem i cofaniem zmian; router: tylko port 443 |

W każdym trybie `http://localhost/` otwiera aplikację na tym komputerze.

### Co kreator zmienia na komputerze

Wszystko poniżej widać na stronie „Podsumowanie”, zanim cokolwiek się stanie.

- **Folder instalacji** — kopia paczki (bez plików prywatnych), a przy nowym folderze także
  uprawnienia: administratorzy, SYSTEM i konto instalujące (folder założony w `C:\` jest
  domyślnie zapisywalny dla każdego zalogowanego, a leży w nim kod wykonywany przez Apache
  z uprawnieniami systemu).
- **Środowisko i konfiguracja** — `scripts\install.py`: `.venv` z locka z sumami kontrolnymi
  (pobierane z internetu), `config\config.local.toml` z wylosowanym kluczem i hasłem bazy,
  widoczny tylko dla konta instalującego, SYSTEM i administratorów.
- **Baza** — `CREATE DATABASE`, konto aplikacji z samym DML (`SELECT, INSERT, UPDATE, DELETE`)
  dla `localhost` i `127.0.0.1`, hasło losowe (nigdzie niepokazywane). Migracje wykonuje konto
  administratora: `media-server migrate --as-user root --password-stdin`. Hasło administratora
  idzie do klienta `mysql` przez prywatny plik opcji i standardowe wejście — nigdy w wierszu
  poleceń — i nie jest nigdzie zapisywane.
- **Foldery** — `media-server roots sync` zapisuje rodzaj każdego folderu **bez skanowania**
  (niżej: „Pierwsze indeksowanie”).
- **Konto administratora** — `account-create --password-stdin --php <php.exe z WampServera>`.
- **WampServer** — trzy pliki, z każdego kopia w `backups\installer\<data>\`:
  1. własny plik `alias\tryhackx-media-server.conf`, generowany z
     `deploy/apache/media-next-stage-wamp.conf.example` (te same aliasy, nagłówki i zamknięte
     trasy wewnętrzne; inne są tylko reguły dostępu, port usługi i — w trybach z HTTPS —
     `Listen 443` z hostem `*:443`);
  2. w `conf\extra\httpd-vhosts.conf` **jedna linia**: `DocumentRoot` hosta `localhost`
     wskazuje `public\assets\build`; poprzednia wartość zostaje w linii `#TRYHACKX-PREVIOUS#`
     i wraca przy odinstalowaniu. Skutek, o którym kreator mówi już na pierwszej stronie: pod
     `http://localhost/` jest odtąd ten serwer — strona startowa WampServera i projekty z `www`
     przestają się tam otwierać, dopóki serwer nie zostanie odinstalowany;
  3. w `conf\httpd.conf` odkomentowane linie `LoadModule` brakujących modułów.

  W trybach publicznych (własna domena, VPS) dochodzi jeszcze „cisza”: `ServerTokens Prod` i
  `ServerSignature Off` w `httpd.conf` oraz `expose_php = Off` w `php.ini` — Apache i PHP przestają
  podawać swoje wersje w każdej odpowiedzi i na stronach błędów. Oba pliki mają kopię i wracają
  razem z resztą, gdy `httpd -t` albo restart się nie powiedzie.

  Potem `httpd -t`. **Przy błędzie składni wszystkie trzy pliki wracają do poprzedniej postaci,
  zanim cokolwiek zostanie przeładowane**; dopiero po poprawnym teście usługa Apache jest
  uruchamiana ponownie. Gdyby nie wstała — pliki wracają i startuje poprzednia konfiguracja.
- **Zapora** — reguły w grupie „TryHackX Media Server” (wyżej, w tabeli trybów). Reguła „z sieci
  domowej” (`LocalSubnet`) działa tylko w profilu **prywatnym**: laptop w hotelowym Wi-Fi nie
  wystawia serwera całej sali. Gdy Windows uważa domową sieć za publiczną, kreator to mówi —
  wtedy w Ustawieniach → Sieć i Internet zmień profil połączenia na „Prywatna”.
- **Harmonogram zadań** — `TryHackX Media Transfer Stage` (nadzorowany start usługi) i
  `TryHackX Media Maintenance` (codziennie 4:15), rejestrowane tymi samymi skryptami co ręcznie;
  zadanie okresowe dostaje `-PhpPath` (WampServer nie dodaje PHP do `PATH`, więc bez tego
  przegląd nowości nigdy by nie wyszedł) i `-MetadataLimit 5000`.
- **Usługi WampServera** (opcja) — Apache i baza startują razem z Windows. Domyślnie są
  „ręczne”: po restarcie komputera serwer milczy, dopóki ktoś nie kliknie ikony WampServera.
- **Stan instalacji** — `config\installer.local.json`: lista wszystkiego, co kreator ustawił
  (bez sekretów). Po niej kreator poznaje instalację i wie, co cofnąć.

### Pierwsze indeksowanie

Rodzaj źródła zapisywał dotąd dopiero pierwszy skan, a zadanie okresowe pomija źródła bez
rodzaju — na świeżej instalacji nic by się więc samo nie zaindeksowało, a skan dużej biblioteki
na wolnym dysku trwa na tyle długo, że kreator nie może na niego czekać. Dlatego:

1. `media-server roots sync --kind <id>=<rodzaj>` wpisuje do `media_roots` to samo, co wpisałby
   skan — i nic więcej (żadnego pliku nie czyta);
2. kreator uruchamia raz zadanie `TryHackX Media Maintenance` i kończy pracę; skan, kolejka
   metadanych i gatunki filmów idą w tle, tym samym zadaniem i z tą samą blokadą nakładania,
   co każdej nocy. Postęp: `logs\maintenance.log`.

### Zmiana ustawień, aktualizacja, naprawa

Uruchom `Zainstaluj.cmd` ponownie (z folderu instalacji albo z nowej paczki). Gdy serwer już
jest, kreator pokazuje **stan instalacji** (`20-status.png`: usługa, zadania, Apache, tryb
dostępu, wersja, foldery — a także ostrzeżenia: ogólna reguła zapory wpuszczająca każdego
w trybie VPS lub sieci domowej, prywatna konfiguracja czytelna dla innych kont, `.venv`, którego
Python nie startuje) i sześć działań. Kafelki obsługuje się też klawiaturą (Tab, Enter, spacja),
a czytnik ekranu słyszy ich nazwy, wybory trybów i znaczenie znaczków stanu. Każde działanie
najpierw pokazuje podsumowanie:

- **Foldery z mediami** (`21-folders.png`) — dodanie, usunięcie, zmiana rodzaju, „Zmień
  ścieżkę…” (biblioteka przeniesiona na inny dysk zachowuje identyfikator, a z nim oceny,
  kolekcje i historię). Zmienia tylko tabele `[roots.*]` w `config.local.toml` — reszta pliku
  zostaje co do znaku, a przed zapisem powstaje prywatna kopia
  `config\config.backup-<data>.local.toml`. Folder zdjęty z listy jest w katalogu **wyłączany**,
  nie kasowany. **Folderów nie da się zmienić z panelu w przeglądarce — celowo**: skradziona
  sesja administratora nie może wystawić całego dysku.
- **Sposób dostępu** (`22-access.png`) — nowy plik Apache, reguły zapory, wartości w konfiguracji
  i paczka dla VPS; „Wygeneruj certyfikat od nowa” wymienia certyfikat domowy.
- **Dodaj administratora** (`23-admin.png`) — także wyjście awaryjne po zapomnianym haśle.
- **Aktualizacja** (`24-update.png`) — z nowej paczki albo z klona po `git pull` (wtedy najpierw,
  przed zatrzymaniem usługi, zbudowanie frontu od nowa): zatrzymanie usługi, **pełna kopia bazy**
  (`mysqldump` kontem administratora do `backups\database\<baza>-<data>-before-<wersja>.sql`,
  folder dostępny tylko administratorom i SYSTEM; pole na stronie aktualizacji, domyślnie
  zaznaczone), podmiana plików programu (konfiguracja, baza i pamięć podręczna zostają), usunięcie
  plików, których nowa wersja już nie ma (według spisu `runtime\installer-files.txt` z poprzedniej
  instalacji lub aktualizacji — plik, który dodał ktoś inny, nigdy na nim nie był, więc zostaje),
  zależności, migracje kontem administratora, a dla instalacji zrobionej kreatorem także nowy plik
  Apache z szablonu nowej wersji i zapis stanu; zadania w Harmonogramie są rejestrowane od nowa
  (ręcznie zrobione zadanie okresowe zostaje, jak było), na końcu start. Uruchomiona z folderu
  instalacji nie kopiuje plików. Kopię bazy przywraca się poleceniem
  `mysql -u root <baza> < plik.sql`.
- **Napraw** (`25-repair-summary.png`) — uprawnienia prywatnych plików (konfiguracja, jej kopie,
  klucze), środowisko (`.venv`, którego Python nie startuje, powstaje od nowa), zadania, a dla
  instalacji zrobionej kreatorem także uprawnienia folderu (jeśli kreator je zakładał), plik Apache,
  reguły zapory i autostart usług WampServera.
- **Odinstaluj** (`26-uninstall.png`, `27-uninstall-summary.png`) — zadania, plik w `alias\`,
  przywrócenie `DocumentRoot`, reguły zapory (wyłączone wcześniej reguły ogólne wracają);
  opcjonalnie dane serwera (`.venv`, `logs`, pamięć podręczna w `runtime`), prywatna
  konfiguracja z kluczami, jej kopiami `config.backup-*` i starszymi kopiami kreatora
  w `backups\installer` oraz — po wpisaniu nazwy bazy — baza i konto (gdy bazy nie założył ten
  kreator, strona to mówi). **Pliki mediów nie są nigdy dotykane**; WampServer i włączone w nim
  moduły zostają.

Instalację zrobioną ręcznie (bez `installer.local.json`) kreator rozpoznaje po zadaniu
w Harmonogramie i po pliku w `alias\` z linią `Define TRYHACKX_MEDIA_ROOT`; tryb dostępu
odczytuje z konfiguracji. Niczego w niej nie zmienia, dopóki nie wybierzesz działania —
a przy pierwszej zmianie dostępu zastępuje ręczny plik w `alias\` własnym (z kopią) i pyta
o zgodę na wyłączenie istniejącego hosta `:443` w `httpd-vhosts.conf`.

### Gdy coś pójdzie nie tak

- Dziennik każdego uruchomienia: `%TEMP%\tryhackx-media-setup-<data>.log` (hasła zastąpione
  gwiazdkami). Na stronie „Wykonanie” jest „Zapisz dziennik…”.
- Każdy krok można powtórzyć: „Spróbuj ponownie” zaczyna plan od początku, a kroki już wykonane
  niczego nie psują.
- „Apache odrzucił nową konfigurację” — pliki WampServera wróciły do poprzedniej postaci;
  komunikat cytuje `httpd -t`. Najczęściej to błąd, który był w `httpd.conf` już wcześniej.
- Port 80 zajęty przez inny program (IIS, Skype, drugi serwer WWW) — kreator powie przez który
  i jak go zwolnić. Zajęty port 443 przeszkadza tylko trybom z HTTPS (własna domena, VPS):
  wymagania pokazują ostrzeżenie, a strona „Dostęp” zatrzymuje dopiero te dwa tryby.
- Błąd, zanim okno kreatora się otworzy — okno komunikatu z treścią błędu, kopia w
  `%TEMP%\tryhackx-media-setup-error-<data>.txt`.
- Dysk sieciowy (`Z:\`) jako folder z mediami — odmowa: zadanie działające w tle go nie widzi.

## Instalacja ręczna

Poniżej te same kroki wykonywane poleceniami — ścieżka zaawansowana i dokumentacja tego, co
kreator robi pod spodem.

## Wymagania

- Python 3.11 lub nowszy (sprawdzone na 3.14.6);
- Node.js zgodny z wymaganiami Vite tylko przy budowaniu frontendu ze źródeł;
- PHP 8.1+ z OpenSSL dla mostu tokenów;
- MySQL 8.0.19+ lub MariaDB 10.5.2+ (migracje używają `DROP CONSTRAINT` i `RENAME COLUMN`);
- Apache 2.4 z `proxy`, `proxy_http` i `headers` dopiero przy integracji;
- **FFmpeg** — Windows nie ma go z pudełka, a instalator go nie pobiera.

**Bez FFmpeg instalacja wygląda na udaną i po cichu traci połowę funkcji.**
`media-server check` przechodzi, usługa wstaje i odpowiada, front się buduje —
a nie ma czym zrobić miniatury, odczytać ścieżek wideo, wyrenderować napisów
obrazkowych ani puścić trybu zgodnego. Zmierzone na czystej instalacji bez
FFmpeg w `PATH`: przebieg okresowy raportuje `"claimed": 5, "failed": 5`.
Wystarczy rozpakować build gdziekolwiek i wskazać go przy instalacji
(`--ffmpeg-path`) albo dopisać do `PATH`; ścieżkę wewnątrz drzewa projektu
(np. `runtime\ffmpeg-…\bin\ffmpeg.exe`) instalator zapisze względnie.

## Przygotowanie

Uruchom PowerShell w katalogu projektu:

```powershell
$env:MEDIA_SERVER_DB_PASSWORD = 'silne-osobne-haslo'
python scripts\install.py --dev --build-frontend --music-root 'E:\Muzyka' --movies-root 'E:\Filmy Video'
```

Skrypt tworzy `.venv` i prywatny `config/config.local.toml`. Na Windows usuwa dziedziczone ACL
i pozostawia pełny dostęp tylko bieżącemu kontu, SYSTEM oraz administratorom. Nie nadpisuje
istniejącego pliku i nie zmienia WAMP. Zależności Pythona są instalowane z `requirements.lock`
(lub `requirements-dev.lock` przy `--dev`) z weryfikacją hashy; `--no-lock` wraca do zakresów z
`pyproject.toml` wyłącznie na platformach bez gotowych kół. Ponowne uruchomienie instalatora przy
istniejącym configu (np. odtworzenie `.venv`) nie pyta już o hasło bazy ani katalogi mediów.
Opcja `--build-frontend` wykonuje `npm ci` na podstawie lockfile i produkcyjny build. Można ją
pominąć, gdy wydanie zawiera już gotowe zasoby statyczne; instalator nigdy nie instaluje Node
automatycznie. Test konfiguracji:

```powershell
.venv\Scripts\python.exe -m media_server --config config\config.local.toml check
```

Ścieżki cache i dołączonego FFmpeg wewnątrz drzewa projektu instalator zapisuje względnie
(`runtime/thumbnails`); Python i PHP rozwiązują je względem katalogu projektu, więc przeniesienie
całego drzewa nie wymaga edycji configu. Katalogi mediów (`[roots.*]`) pozostają bezwzględne.

Bramka jakości (to samo, co CI): `python scripts\check.py` — ruff, pytest, `php -l`, `tsc`, build
frontendu do katalogu tymczasowego, testy node i skan sekretów; `--audit` dodaje `pip-audit`
oraz `npm audit`. Locki odświeża `python scripts\lock-deps.py` (wymaga `uv`).

Uruchomienie procesu w terminalu:

```powershell
scripts\start-windows.bat
```

`http://127.0.0.1:8765/health/ready` powinno zwrócić `ready`. Proces pozostaje na pierwszym
planie, co jest właściwe dla testu oraz późniejszego opakowania przez usługę Windows.

Dla lokalnego stagingu proces można uruchomić i zatrzymać w tle:

```powershell
scripts\start-stage-windows.bat
scripts\stop-stage-windows.bat
```

Skrypty czytają port z TOML, sprawdzają PID i odmawiają zatrzymania obcego procesu.

**Druga instalacja na tej samej maszynie: uważaj na nazwę zadania.**
`start-stage-windows.ps1` szuka zadania w Harmonogramie po **stałej nazwie**
(`TryHackX Media Transfer Stage`) i jeśli je znajdzie, uruchamia **jego** drzewo
— nie to, z którego skrypt odpalono. Przy dwóch kopiach na jednej maszynie
(np. przy teście czystej instalacji) podaj drugiej własną nazwę:
`-TaskName 'TryHackX Media Stage (test)'`. Nieistniejąca nazwa też jest
poprawna — skrypt startuje wtedy proces wprost.

Lokalny staging WAMP można włączyć dopiero po buildzie i healthchecku:

```powershell
Copy-Item deploy\apache\media-next-stage-wamp.conf.example C:\wamp64\alias\media-next-stage.conf
C:\wamp64\bin\apache\apache2.4.65\bin\httpd.exe -t
C:\wamp64\bin\apache\apache2.4.65\bin\httpd.exe -k restart -n wampapache64
```

Ostatnie polecenie wymaga podniesionego PowerShell/UAC. Szablon korzysta z tego samego prywatnego
`config.local.toml` dla PHP i Pythona, dopuszcza HTTP wyłącznie dla loopbacku i nie zmienia
globalnych limitów PHP ani globalnego `Timeout` Apache. Ścieżka drzewa projektu występuje w nim
tylko raz — w linii `Define TRYHACKX_MEDIA_ROOT`; dla innej lokalizacji zmień ją i zawsze wykonaj
`httpd -t`. Strona logowania ma osobną politykę CSP dopuszczającą skrypty i ramki dostawców
CAPTCHA (reCAPTCHA, hCaptcha, Turnstile); bez tego bloku włączenie CAPTCHA w panelu zablokowałoby
logowanie. Po aktualizacji szablonu skopiuj go ponownie do `alias\` i przeładuj Apache.

## Wystawienie poza tę maszynę

Szablon z `alias\` jest **fragmentem**: daje aliasy, nagłówki i trasę transferu,
ale nie mówi, pod jaką nazwą i na jakim porcie serwer odpowiada. Aplikacja stoi
pod `/`, a to `DocumentRoot` hosta wirtualnego — w WAMP-ie
`conf\extra\httpd-vhosts.conf`, wskazany na `public\assets\build`. Kompletny
przykład z TLS, HSTS i przekierowaniem z portu 80 jest w
`deploy/apache/media-vhost.conf.example`; wszystkie kształty wystawienia
(za proxy, wprost, tylko LAN, tylko localhost) opisuje `PUBLIC-EXPOSURE.md`.

Poza samą konfiguracją Apache domowa maszyna wymaga czterech rzeczy, których
Linux w tym miejscu nie potrzebuje inaczej:

- **reguła zapory** dla portów 80 i 443 (`New-NetFirewallRule`, wymaga UAC) —
  domyślnie Windows wpuszcza tylko sieć prywatną, więc bez tego z internetu nie
  wejdzie nic, a lokalnie wszystko wygląda dobrze;
- **przekierowanie portów na routerze** i **DNS dynamiczny**, bo adres łącza
  domowego zwykle się zmienia;
- **certyfikat** — na Windowsie najprościej `win-acme`; port 80 też musi być
  przekierowany, inaczej odnowienie nie ma jak dojść;
- **przeładowanie usługi Apache z UAC**, tak samo jak przy stagingu.

W sieci prywatnej bez TLS (telefon w domowym Wi-Fi, adres `192.168.x.x`) trzeba
świadomie ustawić `[session] require_https = false` — kształt **D**
w `PUBLIC-EXPOSURE.md`. Wyjątek `TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL` tego nie
załatwia: dotyczy wyłącznie pętli zwrotnej, czyli tej jednej maszyny.

### Ochrona przed botami na Windowsie

Drabina kroku w górę, wyzwania (Turnstile, reCAPTCHA, hCaptcha, wbudowany
proof-of-work) i weryfikacja dwuetapowa działają tak samo jak na Debianie — to
kod mostu. Różnice dotyczą warstw przed PHP (pełny opis: `INSTALL-DEBIAN.md`,
„Cloudflare, fail2ban i limity połączeń”):

- **Cloudflare** — te same zasady, łącznie z zastrzeżeniem o filmach: transfery
  nie mogą iść przez proxy Cloudflare, więc dziś nazwa strony zostaje „DNS only”.
- **fail2ban** na Windowsie nie działa. Linie `tryhackx-auth event=…` trafiają
  tu do `C:\wamp64\logs\php_error.log` (WAMP ustawia `error_log` w `php.ini`),
  czyli bez adresu klienta — banowanie po logu wymagałoby osobnego narzędzia;
  zostają blokady samej aplikacji (lista w panelu, z przyciskiem „Odblokuj”).
- **`RequestReadTimeout` i limity żądań** — `deploy/apache/media-hardening.conf.example`
  działa też w Apache z WAMP-a (`LoadModule reqtimeout_module` musi być włączony
  w `httpd.conf`); blok `mpm_event_module` Windows pomija (Apache używa tam
  `mpm_winnt`, liczbę wątków ustawia `ThreadsPerChild`). Przeładowanie z UAC.
- **Co serwer mówi o sobie** — WAMP wysyła w każdej odpowiedzi
  `Server: Apache/2.4.x (Win64) OpenSSL/… PHP/…`. W `httpd.conf` (globalnie, nie
  w aliasie) `ServerTokens Prod` i `ServerSignature Off`, w `php.ini` używanym przez
  Apache `expose_php = Off`; most zdejmuje `X-Powered-By` ze swoich odpowiedzi sam.
- **Nagłówek `Cache-Control` mostu** — w bloku `/media-next-api` musi być warunkowy
  (`Header always set Cache-Control "no-store" "expr=-z %{resp:Cache-Control}"`, jak
  w przykładzie): bezwarunkowy dokłada drugi nagłówek do okładek i przekierowań
  miniatur, a przeglądarka wtedy niczego nie trzyma.

## Baza

Utwórz jedną pustą bazę i dedykowanego użytkownika z samym DML (`GRANT SELECT, INSERT, UPDATE, DELETE`).
Nie używaj konta `root` w aplikacji. Migracje wymagają DDL, więc wykonuje je konto administratora —
wskazane dla tego jednego polecenia, bez zmiany konfiguracji:

```powershell
.venv\Scripts\python.exe -m media_server --config config\config.local.toml migrate --as-user root
```

Polecenie pyta o hasło bez echa (w świeżym WampServerze `root` nie ma hasła — sam Enter); do skryptu
służy `--password-stdin` (pierwsza linia wejścia, może być pusta). Bez `--as-user` migracje idą kontem
aplikacji, czyli działają tylko tam, gdzie dostało ono więcej niż DML.

Migracje twórz i uruchamiaj przeciw własnej bazie serwera; nie mieszaj ich z żadną inną bazą
działającą na tej maszynie.

## Pierwsze konto

Świeża instalacja nie ma żadnego konta, a rejestracja jest **domyślnie wyłączona**
(`registration_enabled = '0'`) — serwer przychodzi zamknięty. Pod adresem stoi więc strona
logowania, do której nikt nie ma jak wejść. Pierwsze konto zakłada się poleceniem, po migracjach:

```powershell
.venv\Scripts\python.exe -m media_server --config config\config.local.toml account-create --username twoja-nazwa --email ty@example.org
```

Polecenie pyta dwa razy o hasło (bez echa, co najmniej 12 znaków) i zakłada konto **aktywne,
potwierdzone, z rolą `super_admin`**, w systemowej grupie `user` — rejestracji nie trzeba
otwierać ani na chwilę. `--role admin|user` daje inną rolę, `--email` jest opcjonalny. Hasła
**nie da się** podać w wierszu polecenia (widziałby je każdy w liście procesów); do skryptu
służy `--password-stdin` — pierwsza linia wejścia. Z PowerShella 5.1 przekazuj tak tylko hasło
ASCII albo ustaw wcześniej `$OutputEncoding = [Text.UTF8Encoding]::new($false)`, bo domyślnie
polskie znaki zamieniają się w `?`.

Skrót hasła liczy PHP (`password_hash()`, tym samym, którym most je sprawdza), więc `php.exe`
musi być w `PATH` albo wskazany przez `--php C:\wamp64\bin\php\php8.x.y\php.exe`. To DML, więc
wystarczy konto aplikacji. Wpis trafia do dziennika aktywności panelu (`user.create`, bez
autora). `role` otwiera panel administracyjny; prawa do bibliotek i limity biorą się z grupy
uprawnień i ustawia się je już w panelu.

## Rollback lokalnego stagingu

1. Usuń wyłącznie `C:\wamp64\alias\media-next-stage.conf`.
2. Wykonaj `httpd -t`.
3. Przeładuj `wampapache64` z podniesionymi uprawnieniami.
4. Uruchom `scripts\stop-stage-windows.bat`; skrypt sam sprawdzi PID i linię polecenia.

Usunięcie aliasu natychmiast przywraca stan tras sprzed stagingu; nie wymaga cofania bazy ani
dotykania starych aplikacji. Przed aktywacją na tym środowisku wykonano snapshot:
`C:\wamp64\backups\media-server-stage-activation-20260808-194213`.

## Nadzorowany autostart

Rejestracja zadania wymaga jednorazowo podniesionego PowerShell/UAC:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\register-stage-task-windows.ps1 -Replace
Start-ScheduledTask -TaskName 'TryHackX Media Transfer Stage'
```

Zadanie działa jako bieżący użytkownik, S4U i z ograniczonymi uprawnieniami. Uruchamia
`run-stage-supervisor-windows.ps1`, który tworzy proces Pythona w stanie wstrzymanym, przypisuje go
do Windows Job Object z `kill-on-close` i dopiero wtedy go wznawia. Awaria dziecka powoduje restart
po trzech sekundach; pięć szybkich awarii w dziesięć minut kończy wrapper, aby uniknąć pętli.

Po rejestracji zwykłe skrypty korzystają z zadania zamiast tworzyć drugi proces:

```powershell
scripts\start-stage-windows.bat
scripts\stop-stage-windows.bat
```

Wyrejestrowanie jest jawne i nie usuwa kodu ani konfiguracji:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-stage-task-windows.ps1
```

## Przebieg okresowy

Drugie zadanie, obok nadzorcy usługi, robi wszystko, co ma się dziać samo: skan katalogu, porcję
kolejki metadanych, porcję gatunków filmów i cotygodniowy przegląd nowości pocztą. Rejestracja
również wymaga jednorazowo podniesionego PowerShell/UAC:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\register-maintenance-task-windows.ps1 -Replace
Start-ScheduledTask -TaskName 'TryHackX Media Maintenance'
Get-Content logs\maintenance.log -Tail 40
```

WampServer nie dodaje PHP do `PATH`, a przegląd nowości uruchamia `php` — bez wskazania go zadanie
co noc zapisuje `digest - SKIPPED: php is not on PATH`. Dlatego przy rejestracji warto podać
`-PhpPath C:\wamp64\bin\php\php8.x.y\php.exe`; `-MetadataLimit N` zmienia porcję kolejki metadanych
na jeden przebieg (domyślnie 500). Kreator podaje oba.

Źródło, którego nikt jeszcze nie skanował, zadanie pomija (nie zna jego rodzaju). Rodzaj można zapisać
bez skanowania: `media-server roots sync --kind music=music --kind movies=movies`; `roots list` pokazuje
źródła z konfiguracji i z katalogu obok siebie.

Zadanie chodzi codziennie o 4:15 z rozrzutem 15 minut, jako bieżący użytkownik (S4U, ograniczone
uprawnienia), z `-StartWhenAvailable` (przebieg opuszczony przy wyłączonej maszynie odbywa się po
starcie) i `-MultipleInstances IgnoreNew` — to **jedyne** zabezpieczenie przed nakładaniem się
przebiegów, bo kod nie trzyma własnej blokady. Zmierzone na tej instalacji: pełny przebieg
(20 323 pliki w dwóch bibliotekach, porcja metadanych, jedno zapytanie do Filmwebu, przegląd)
zajmuje **około trzech minut**.

Przebieg da się uruchomić także ręcznie, bez zadania:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run-maintenance-windows.ps1 -TitlesLimit 200
.venv\Scripts\python.exe -m media_server --config config\config.local.toml maintenance --only metadata
```

Zadanie nie ma dziennika systemd, więc wyjście obu kroków ląduje w `logs\maintenance.log`
(przycinany do 400 ostatnich linii po przekroczeniu 1 MiB). Krok pythonowy i przegląd są
niezależne: przegląd rusza nawet wtedy, gdy część pythonowa zwróciła błąd, a kod wyjścia zadania
niesie sumę obu. Wyrejestrowanie:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-maintenance-task-windows.ps1
```

Diagnostyka:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health/ready
Invoke-RestMethod http://127.0.0.1:8765/health/status
Get-ScheduledTask -TaskName 'TryHackX Media Transfer Stage'
Get-Content logs\media-server.jsonl -Tail 50
```

Log JSON rotuje przy 10 MiB i zachowuje pięć kopii. Pełne tokeny transferowe nie są logowane.

## Test czystej instalacji

Powtarzalna procedura sprawdzająca, że świeży klon instaluje się od zera —
obok działającego stagingu, na osobnym porcie i osobnej bazie, bez dotykania
niczego istniejącego. Wykonana 17.08.2026; wynik w `CHANGELOG.md`.

1. **Czyste drzewo to wyłącznie to, co widzi git.** Nie kopiuj katalogu roboczego —
   ma w sobie `.venv`, prywatny config, `runtime/` i zbudowany front, czyli
   dokładnie to, czego świeży klon nie ma:

   ```powershell
   git ls-files --cached --others --exclude-standard -z | ForEach-Object { }  # lista plików
   ```

   (w Git Bash: `git ls-files --cached --others --exclude-standard -z | xargs -0 -I{} cp --parents "{}" CEL/`)
2. Osobna baza i konto, potem instalator **dokładnie jak wyżej**, z własnym
   portem i nazwą bazy: `--port 8766 --db-name … --db-user …`.
3. Migracje jako `root@localhost`, start przez `start-stage-windows.ps1`
   z własną nazwą zadania, `health/ready` na nowym porcie.
4. Bramka **w czystym drzewie** (`python scripts\check.py`) — sprawdza też
   zapasową ścieżkę skanu sekretów, bo bez `.git` idzie on obchodem katalogu.
5. `httpd.exe -t -f` na własnym pliku testowym, który `Include`-uje przykład
   aliasu z podmienioną linią `Define`. **Nie wkładaj pliku do `alias\`** —
   wszedłby w życie przy najbliższym przeładowaniu Apache.
6. Na koniec: zatrzymaj usługę, skasuj bazę i konto, usuń drzewo i sprawdź, że
   staging na starym porcie nadal odpowiada.

## Przeniesienie poza DocumentRoot

Całe drzewo (kod, `config/`, `runtime/`, `logs/`) ma leżeć poza `C:\wamp64\www` — na tej maszynie
leży w `C:\wamp64\media-server` (przeniesione 17.08.2026). Ta instrukcja opisuje, jak przenieść je
gdzie indziej; `STARY` to bieżące położenie, `NOWY` — docelowe. Kod jest na to gotowy: config używa ścieżek względnych,
szablon aliasu ma jedną linię `Define TRYHACKX_MEDIA_ROOT`, a skrypty startowe wyprowadzają
ścieżki z własnego położenia. Dwa kroki wymagają podniesionego PowerShell/UAC (przeładowanie
Apache i ponowna rejestracja zadania). Poniżej `NOWY` oznacza docelowy katalog.

1. Backup plików (bez `.venv`, `node_modules`, `runtime`, `logs`) i `mysqldump` do `C:\wamp64\backups`.
2. Zatrzymaj staging i wyrejestruj zadanie (drugie polecenie z UAC):

   ```powershell
   scripts\stop-stage-windows.bat
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-stage-task-windows.ps1
   ```

3. Przenieś drzewo bez `.venv` i `node_modules` (zawierają ścieżki bezwzględne, zostaną odtworzone):

   ```powershell
   robocopy STARY NOWY /E /MOVE /XD STARY\.venv STARY\frontend\node_modules
   ```

   `robocopy /MOVE` pozostawia wykluczone katalogi w starym miejscu — po udanym przełączeniu
   usuń resztki `STARY` ręcznie. **Nie przenoś drzewa przez `Move-Item`**: przy pierwszej blokadzie
   (choćby powłoki z katalogiem roboczym w środku) przerywa w połowie, zostawiając część plików
   skasowanych w źródle i część skopiowanych — łącznie z `.git`.

   **`robocopy` bez `/COPYALL` nie przenosi uprawnień**: `config.local.toml` (hasło bazy, klucz
   transferów) dostaje w nowym miejscu prawa dziedziczone — zwykle „Użytkownicy: odczyt”. Zamknij
   go od razu (podniesiony PowerShell, w `NOWY`):

   ```powershell
   icacls config\config.local.toml /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" "${env:USERNAME}:(F)"
   ```

   To samo dla kopii `config\config.backup-*.local.toml` i kluczy w `config\origin\` / `config\tls\`,
   jeśli są — albo uruchom potem `Zainstaluj.cmd` → „Napraw”: krok „Uprawnienia prywatnych plików”
   robi to dla wszystkich naraz (dostęp: administratorzy, SYSTEM i konto, na którym działa usługa),
   a strona stanu ostrzega, dopóki któryś plik jest otwarty dla innych kont.
4. W `NOWY` odtwórz środowisko i build (config nie jest nadpisywany, hasło nie jest potrzebne):

   ```powershell
   python scripts\install.py --dev --build-frontend
   .venv\Scripts\python.exe -m media_server --config config\config.local.toml check
   ```

   Jeśli `config.local.toml` pochodzi sprzed tej wersji i ma bezwzględne `cache_path`,
   `subtitle_cache_path` lub `ffmpeg_path` wskazujące stary katalog, zamień je na względne
   `runtime/...`.
5. W `C:\wamp64\alias\media-next-stage.conf` zmień linię `Define TRYHACKX_MEDIA_ROOT` na `NOWY`
   (ukośniki `/`), potem `httpd -t` i restart `wampapache64` z UAC. Reguła `Require all denied` dla
   `/media-server` może zostać.
6. Zarejestruj zadanie z nowej lokalizacji i uruchom staging:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\register-stage-task-windows.ps1 -Replace
   scripts\start-stage-windows.bat
   ```

7. Smoke test: `health/ready`, `http://127.0.0.1/`, `?action=auth_state`, logowanie,
   odtworzenie utworu, miniatura, pobranie ZIP.

Rollback: przywróć starą wartość `Define` w aliasie i przeładuj Apache; stary katalog (jeśli
jeszcze nie usunięty) lub kopia z kroku 1 uruchamia się bez zmian.
