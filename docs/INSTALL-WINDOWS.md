# Instalacja na Windows + WAMP

## Wymagania

- Python 3.11 lub nowszy (sprawdzone na 3.14.6);
- Node.js zgodny z wymaganiami Vite tylko przy budowaniu frontendu ze źródeł;
- PHP 8.1+ z OpenSSL dla mostu tokenów;
- MySQL 8.x lub MariaDB 10.4+;
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

## Baza

Utwórz jedną pustą bazę i dedykowanego użytkownika. Nie używaj konta `root` w aplikacji. Następnie:

```powershell
.venv\Scripts\python.exe -m media_server --config config\config.local.toml migrate
```

Migracje twórz i uruchamiaj przeciw własnej bazie serwera; nie mieszaj ich z żadną inną bazą
działającą na tej maszynie.

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

7. Smoke test: `health/ready`, `http://127.0.0.1/media-next/`, `?action=auth_state`, logowanie,
   odtworzenie utworu, miniatura, pobranie ZIP.

Rollback: przywróć starą wartość `Define` w aliasie i przeładuj Apache; stary katalog (jeśli
jeszcze nie usunięty) lub kopia z kroku 1 uruchamia się bez zmian.
