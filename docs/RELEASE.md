# Wydanie wersji i pełna prywatna kopia

Dwie rzeczy, które robi się rzadko i przez to łatwo zrobić źle: **opublikować wersję** tak, żeby
obcy człowiek mógł ją pobrać i zainstalować, oraz **mieć kopię wszystkiego**, czego publikować
nie wolno — tak, żeby po awarii dysku odtworzyć serwer w godzinę, a nie w weekend.

Zasada wspólna dla obu: **kod jest publiczny, wartości są prywatne, sekrety są zaszyfrowane.**
Nic, co jest hasłem albo kluczem, nie trafia do żadnego repozytorium gita w czystej postaci —
także prywatnego.

## Co jest wydaniem

- tag `vX.Y.Z` w publicznym repozytorium;
- **GitHub Release** z czterema plikami: `TryHackX-Media-Server-X.Y.Z-windows.zip` (to, co użytkownik
  rozpakowuje i uruchamia przez `Zainstaluj.cmd`), `TryHackX-Media-Server-X.Y.Z-debian.tar.gz`
  (to samo dla Debiana: `sudo bash zainstaluj-debian.sh`) i ich sumy kontrolne (`….sha256`);
- wpis w `CHANGELOG.md`.

Paczka dla Debiana niesie zbudowany front, więc na serwerze nie trzeba Node.js. Wdrażanie z klona
(`git clone` i `scripts/release-debian.sh --build-frontend`) zostaje jako ścieżka ręczna
z `INSTALL-DEBIAN.md`.

## Wydanie krok po kroku

**1. Numer wersji — cztery miejsca, jedna liczba.**

```powershell
# pyproject.toml:               version = "X.Y.Z"
# src/media_server/__init__.py: __version__ = "X.Y.Z"
cd frontend
npm version X.Y.Z --no-git-tag-version      # package.json i oba wpisy w package-lock.json
cd ..
.venv\Scripts\python.exe -m pytest tests\test_version.py -q
```

`tests/test_version.py` nie przepuści wydania, w którym te miejsca się różnią (tak wyszło `v0.1.1`).

**2. `docs/CHANGELOG.md`** — wpis na górze, w stylu pozostałych: co się zmieniło dla
użytkownika, potem jak to jest zrobione.

**3. Bramka z audytem zależności:**

```powershell
.venv\Scripts\python.exe scripts\check.py --audit
```

**4. Commit i push** (robi je właściciel), potem **zielone CI** na tym commicie. Wydaje się
commit, który CI widziało, a nie stan katalogu roboczego.

**5. Czysty klon i build frontu.** To jest krok, którego nie wolno skrócić:

```powershell
git clone https://github.com/<konto>/media-server.git C:\wydanie\media-server
cd C:\wydanie\media-server
git checkout <commit z kroku 4>
cd frontend
npm ci
npm run build
cd ..
```

**Dlaczego nie z katalogu roboczego.** Build frontu bierze wszystko, co leży w
`frontend/vendor/`: licencjonowaną kopię Font Awesome Pro, paczki presetów i shadery na
licencjach niekomercyjnych, własne logo. Na własnym serwerze to jest w porządku; w publicznej
paczce byłoby naruszeniem licencji — a `public/assets/build` jest ignorowane przez gita, więc
żaden skan repozytorium tego nie zobaczy. W czystym klonie `frontend/vendor/` nie istnieje,
więc build zawiera wyłącznie to, co jest w repozytorium. `package-release.py` pilnuje tego sam:
**odmawia**, gdy w drzewie jest niepusty `frontend/vendor/` albo gdy w buildzie są czcionki
Pro (`assets/iconpacks/`).

**6. Paczka:**

```powershell
python scripts\package-release.py --platform all --list   # co wchodzi (+), co zostaje (-) i dlaczego, dla obu systemów
python scripts\package-release.py --platform all          # dist\…-windows.zip i dist\…-debian.tar.gz, każda z .sha256
```

Bez `--platform` powstaje sama paczka dla Windows; `--platform debian` — sama dla Debiana. Obie
są sprawdzane w całości (wymagane pliki, sekrety), zanim powstanie pierwsza.

Skrypt potrzebuje tylko biblioteki standardowej, więc w czystym klonie wystarczy systemowy
Python. Paczka jest powtarzalna: z tego samego commita i tego samego buildu frontu powstaje ten
sam plik i ta sama suma (wpisy są posortowane i noszą datę commita; skrypty Windows są
zapisywane z końcami linii CRLF niezależnie od ustawień gita, a w paczce dla Debiana każdy plik
tekstowy ma LF, skrypty `.sh` są wykonywalne i wszystko należy do roota).

**7. Sprawdzenie paczki — z rozpakowanego ZIP-a, nie z klona:**

```powershell
Expand-Archive dist\TryHackX-Media-Server-X.Y.Z-windows.zip C:\wydanie\proba
cd C:\wydanie\proba\TryHackX-Media-Server-X.Y.Z
.\Zainstaluj.cmd -Preview -ScreenshotDir C:\wydanie\zrzuty      # wszystkie strony kreatora jako PNG
.\Zainstaluj.cmd -DryRun                                        # cała ścieżka bez żadnej zmiany
certutil -hashfile ..\..\media-server\dist\TryHackX-Media-Server-X.Y.Z-windows.zip SHA256
```

Przed większym wydaniem: pełna instalacja kreatorem na czystej maszynie (albo maszynie
wirtualnej) z WampServerem — to jedyny test, który przechodzi przez UAC, pobieranie zależności
i prawdziwy restart Apache.

Paczka dla Debiana — na maszynie (wirtualnej) z Debianem 13, też z rozpakowanego archiwum:

```bash
sha256sum -c TryHackX-Media-Server-X.Y.Z-debian.tar.gz.sha256
tar xzf TryHackX-Media-Server-X.Y.Z-debian.tar.gz && cd TryHackX-Media-Server-X.Y.Z
bash zainstaluj-debian.sh --dry-run --answers installer/debian/examples/answers-standalone.toml   # nic nie zmienia, bez roota
sudo bash zainstaluj-debian.sh                                                                     # pełna instalacja
```

Na Windowsie tej paczki uruchomić się nie da; to, co da się sprawdzić bez Debiana (generatory,
tryb próbny na atrapach poleceń systemu), robi `tests/test_debian_installer.py`.

**8. Tag i wydanie** — w klonie repozytorium z kroku 5 (`C:\wydanie\media-server`), nie w folderze
rozpakowanej paczki z kroku 7 (tam nie ma `.git`):

```powershell
cd C:\wydanie\media-server
git tag -a vX.Y.Z -m "TryHackX Media Server X.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z `
    dist\TryHackX-Media-Server-X.Y.Z-windows.zip `
    dist\TryHackX-Media-Server-X.Y.Z-windows.zip.sha256 `
    dist\TryHackX-Media-Server-X.Y.Z-debian.tar.gz `
    dist\TryHackX-Media-Server-X.Y.Z-debian.tar.gz.sha256 `
    --title "TryHackX Media Server X.Y.Z" --notes-file notatki-wydania.md
```

Bez `gh`: strona repozytorium → Releases → „Draft a new release”, wybrać tag, przeciągnąć
wszystkie cztery pliki. W notatkach wydania warto podać sumę SHA-256 także tekstem.

**9. Po wydaniu:** pobrać ZIP ze strony wydania na inną maszynę, porównać sumę
(`certutil -hashfile … SHA256`), usunąć `C:\wydanie`.

**Suma to nie podpis.** Plik `.sha256` leży obok archiwum, więc ktoś, kto podmieni archiwum na
stronie wydania, podmieni i sumę — chroni przed uszkodzeniem, nie przed podmianą. Gdy wydania
mają trafiać do obcych: podpisany tag (`git tag -s`, klucz GPG albo SSH podpięty do konta GitHub
— strona tagu pokaże „Verified”) i podpis samej sumy, np. `ssh-keygen -Y sign -n file -f
~/.ssh/klucz-wydan …sha256` albo `minisign -S -m …sha256`, z kluczem publicznym opublikowanym
w README. Do tej pory sumę warto podawać także w notatkach wydania (krok 8): podmiana obu miejsc
naraz jest trudniejsza.

### Co trafia do paczki

To, co pokazałby git (`git ls-files --cached --others --exclude-standard`), **plus** zbudowany
front (`public/assets/build`), **minus**:

| Pominięte | Powód |
|---|---|
| `frontend/` | źródła frontu — w paczce jest gotowy build |
| `tests/`, `installer/tests/`, `.github/` | testy i CI |
| `scripts/check.py`, `scripts/lock-deps.py`, `scripts/package-release.py`, `requirements-dev.*`, `requirements-build.txt`, `.editorconfig`, `.gitattributes`, `.gitignore` | narzędzia programisty |
| `scripts/*-debian.sh`, `deploy/systemd/`, `deploy/fail2ban/`, `zainstaluj-debian.sh`, `installer/debian/` | należą do Debiana — są tylko w paczce `-debian.tar.gz` |
| `Zainstaluj.cmd`, `Install.cmd`, `installer/Setup.ps1`, `installer/lib/`, `installer/lang/`, `installer/examples/`, `scripts/*-windows.ps1`, `scripts/*-windows.bat`, przykład dla WAMP-a | należą do Windows — są tylko w paczce `-windows.zip` |

Części wspólne — sam serwer, pomocnik obu instalatorów (`installer/helper.py`,
`installer/setup_helper/`) i szablony paczki dla VPS (`installer/templates/vps/`) — są w obu
paczkach: ten sam commit daje ten sam serwer na obu systemach.

Prywatna konfiguracja, klucze, dzienniki, pamięć podręczna i notatki robocze są ignorowane
przez gita, więc nie wchodzą z definicji — a skrypt i tak sprawdza: odmawia zbudowania paczki,
gdy wybrany plik wygląda na sekret po nazwie (`*.local.toml`, `*.pem`, `*.key`…) albo po treści
(te same wzorce, co krok `secrets` bramki), albo zawiera wartość skopiowaną z
`config/config.local.toml` tej maszyny. **W czystym klonie z kroku 5 tego pliku nie ma**, więc
porównanie wartości nie ma z czym porównać i działają tylko wzorce. Dlatego krok 3 (bramka
z `secrets`) idzie w katalogu roboczym, gdzie prywatna konfiguracja jest — przed commitem.

## Pełna prywatna kopia

Do odtworzenia serwera potrzeba pięciu rzeczy, a każda ma swoje miejsce:

| Co | Gdzie | Dlaczego tam |
|---|---|---|
| kod | publiczne repozytorium (tag wydania) | jest publiczny i tak |
| paczki z `frontend/vendor`: presety, tekstury, shadery, Font Awesome Pro — wolno ich używać, nie wolno publikować | **prywatne repozytorium [media-server-vendor](https://github.com/TryHackX/media-server-vendor)**, sklonowane w `frontend/vendor` | instalatory budują z niego interfejs (`README.md`, *From a clone*); historia i kopia poza domem |
| to, co prywatne, ale nie tajne: notatki, prawdziwe wartości wdrożeniowe, paczka dla VPS, materiały robocze | **osobne prywatne repozytorium** | historia zmian i kopia poza domem |
| sekrety: `config.local.toml`, `config.local.php`, klucz certyfikatu domowego, zrzut bazy | **jeden zaszyfrowany plik** (`*.thxbak`) | repozytorium, nawet prywatne, to kopia na każdej maszynie, która je sklonowała, i historia na zawsze |
| pliki mediów | własna kopia dysków | za duże i nie do gita |

### Prywatne repozytorium

Osobny katalog obok projektu, do którego kopiuje się wybrane rzeczy — nie drugi `.git` w tym
samym drzewie, bo wtedy jedno pomylone `git add` wysyła notatki do publicznego repozytorium.

Jednorazowo:

```powershell
gh repo create <konto>/media-server-private --private --clone
Move-Item media-server-private C:\wamp64\media-server-private
```

i w nim plik `.gitignore`, który nie przepuści sekretu, nawet gdy trafi tam przez pomyłkę:

```gitignore
# W tym repozytorium sekrety istnieją wyłącznie zaszyfrowane (*.thxbak).
*.local.toml
*.local.php
*.pem
*.key
*.pfx
*.sql
*.sql.gz
*.dump
.env
.env.*
```

Kopia (ten sam zestaw poleceń za każdym razem; `robocopy /MIR` usuwa w kopii to, co zniknęło
ze źródła):

```powershell
$src = 'C:\wamp64\media-server'
$dst = 'C:\wamp64\media-server-private'

robocopy "$src\docs"                 "$dst\docs"       TESTING.md GIT.md /NJH /NJS
robocopy "$src\runtime\vps-bundle"   "$dst\vps-bundle" /MIR /NJH /NJS        # prawdziwe adresy; origin.crt to certyfikat, nie klucz
robocopy "$src\deploy\apache"        "$dst\deploy-apache" *.conf /NJH /NJS   # prawdziwe hosty, jeśli tu leżą
robocopy "$src\config"               "$dst\config"     installer.local.json /NJH /NJS
robocopy "$src\backups"              "$dst\sekrety"    *.thxbak /NJH /NJS    # zaszyfrowane kopie sekretów
robocopy "$src\scratch"              "$dst\scratch"    /MIR /XD renders installer-work node_modules /NJH /NJS
New-Item -ItemType Directory "$dst\wamp" -Force | Out-Null                 # Copy-Item nie zakłada folderu sam
Copy-Item C:\wamp64\alias\tryhackx-media-server.conf "$dst\wamp\" -Force     # plik aliasu (instalacja ręczna: jego własna nazwa); i httpd-vhosts.conf, jeśli zmieniany ręcznie

git -C $dst add -A
git -C $dst status --short
git -C $dst commit -m "kopia $(Get-Date -Format yyyy-MM-dd)"
git -C $dst push
```

Przed pierwszym `push` i po każdej zmianie zestawu warto sprawdzić, że nic jawnego się nie
prześlizgnęło — to polecenie ma nie wypisać niczego:

```powershell
git -C $dst ls-files | Select-String -Pattern '\.local\.(toml|php)$|\.pem$|\.key$|\.sql(\.gz)?$'
```

`frontend\vendor\` (paczki, których nie wolno publikować) nie trafia tutaj — ma własne prywatne
repozytorium, `media-server-vendor` (tabela wyżej). To jedyny drugi `.git` w drzewie projektu i jest
bezpieczny: publiczne repozytorium ignoruje cały `frontend/vendor/` (`.gitignore`), więc żadne
`git add` w projekcie go nie zobaczy. Pliki są tam jako zwykłe obiekty gita (1,1 GB, największy
23 MB — poniżej limitu GitHuba 100 MB), bez LFS; `.gitattributes` z `* -text` trzyma bajty bez
zmian, cokolwiek mówi `core.autocrlf`.

### Zaszyfrowana kopia sekretów

```powershell
.venv\Scripts\python.exe scripts\secret-backup.py encrypt
#   + config/config.local.toml
#   + config/installer.local.json
#   + config/origin/origin-cert.pem, origin-key.pem
#   + database/dump.sql
# Zaszyfrowana kopia: backups\secrets-20261112-221500.thxbak
```

Skrypt pyta o hasło dwa razy, bez echa (co najmniej 12 znaków). Do kopii wchodzą — jeśli
istnieją — `config/config.local.toml`, `integrations/php/stage/config.local.php`,
`config/installer.local.json`, `config/origin/`, `config/tls/`, wszystko wskazane przez
`--include` oraz **zrzut bazy**: `mysqldump` z poświadczeniami z prywatnej konfiguracji
(`--single-transaction --skip-lock-tables --no-tablespaces --skip-events --skip-triggers --hex-blob`;
konto aplikacji z samym DML to potrafi — wyzwalaczy, zdarzeń ani procedur baza nie ma, więc zrzut
jest pełny).
Zrzut idzie z `mysqldump` prosto do zaszyfrowanego archiwum — nigdy nie leży na dysku
w czystej postaci — a hasło bazy trafia do `mysqldump` przez tymczasowy plik opcji, nie przez
wiersz poleceń.

Format: jedna linia nagłówka (scrypt, sól, nonce), dalej AES-256-GCM na skompresowanym tarze;
nagłówek jest uwierzytelniany razem z danymi. Bez hasła nie widać nawet nazw plików.

```powershell
.venv\Scripts\python.exe scripts\secret-backup.py list    backups\secrets-….thxbak
.venv\Scripts\python.exe scripts\secret-backup.py decrypt backups\secrets-….thxbak --output-dir D:\odtworzone
```

- **Hasło kopii** trzymaj w menedżerze haseł i w jednym miejscu poza komputerem (kartka
  w szufladzie też jest miejscem). Nie w repozytorium i nie obok pliku. Bez hasła kopia jest
  nie do odczytania — także dla Ciebie.
- **Kiedy robić:** po każdej zmianie konfiguracji (tryb dostępu, poczta, nowy certyfikat
  domowy) i regularnie dla bazy — tyle tracisz ocen, kolekcji i kont, ile dni ma ostatnia kopia.
- **Gdzie trzymać:** w prywatnym repozytorium (`sekrety\`) i na nośniku, który nie jest
  podłączony na stałe. Stare kopie można kasować; jedna aktualna i jedna poprzednia wystarczą.
- `--no-database` robi kopię samej konfiguracji i kluczy; `--mysqldump ŚCIEŻKA` wskazuje
  narzędzie, gdy nie ma go w `PATH` ani w WampServerze.

### Odtworzenie wszystkiego

Nowy komputer albo dysk po awarii. Potrzebne: paczka wydania tej samej (albo nowszej) wersji,
plik `*.thxbak` i hasło do niego.

1. **WampServer, Python, FFmpeg** — jak przy pierwszej instalacji (`INSTALL-WINDOWS.md`).
2. **Kod.** Rozpakuj paczkę wydania do docelowego folderu, np. `C:\TryHackX\MediaServer`
   (bez kreatora — jeszcze nie teraz). Paczka wydania ma interfejs publiczny; z paczkami
   prywatnymi zamiast niej: klon `media-server` do tego folderu, klon `media-server-vendor` do
   jego `frontend\vendor` i jednorazowo, z Node.js LTS, `npm --prefix frontend ci` oraz
   `npm --prefix frontend run build` — „Napraw” w kroku 6 nie buduje interfejsu.
3. **Środowisko Pythona** — te same dwa polecenia, które wykonuje `scripts\install.py`:

   ```powershell
   cd C:\TryHackX\MediaServer
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install --disable-pip-version-check --require-hashes -r requirements.lock
   .venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-deps --no-build-isolation -e .
   ```

4. **Sekrety:**

   Najpierw folder na odszyfrowane pliki, zamknięty dla innych kont — będą w nim sekrety w czystej
   postaci (podniesiony PowerShell):

   ```powershell
   New-Item -ItemType Directory C:\odtworzone | Out-Null
   icacls C:\odtworzone /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
   .venv\Scripts\python.exe scripts\secret-backup.py decrypt D:\kopie\secrets-….thxbak --output-dir C:\odtworzone
   Copy-Item C:\odtworzone\config\* config\ -Recurse
   icacls config\config.local.toml /inheritance:r /grant:r "${env:USERNAME}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"
   if (Test-Path config\origin) { icacls config\origin /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T }
   ```

   `Copy-Item` przenosi pliki z prawami dziedziczonymi — stąd `icacls` dla konfiguracji i klucza
   domu (krok „Napraw” w kreatorze robi to samo jeszcze raz, dla wszystkich prywatnych plików).
   (`config.local.php`, jeśli był w kopii, wraca do `integrations\php\stage\`.) **Instalacja zrobiona
   ręcznie:** certyfikat domu może leżeć poza `config\origin\` (np. w `conf\` Apache'a), a plik aliasu
   nazywać się po swojemu — przy robieniu kopii podaj oba pliki certyfikatu przez `--include`, a przy
   odtwarzaniu wróć je na to samo miejsce z tymi samymi `icacls`; inaczej VPS, który przypina ten
   certyfikat, pokaże stronę przerwy.
5. **Baza** — jako administrator bazy; nazwę, konto i hasło bierzesz z odtworzonego
   `config.local.toml`, sekcja `[database]`:

   ```sql
   CREATE DATABASE media_server CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'media_server'@'localhost' IDENTIFIED BY '<hasło z config.local.toml>';
   CREATE USER 'media_server'@'127.0.0.1' IDENTIFIED BY '<to samo hasło>';
   GRANT SELECT, INSERT, UPDATE, DELETE ON media_server.* TO 'media_server'@'localhost', 'media_server'@'127.0.0.1';
   ```

   ```powershell
   cmd /c "C:\wamp64\bin\mysql\mysql8.x.y\bin\mysql.exe -u root media_server < C:\odtworzone\database\dump.sql"
   .venv\Scripts\python.exe -m media_server --config config\config.local.toml migrate --as-user root
   ```

   Drugie polecenie uzupełnia strukturę, gdy paczka jest nowsza niż kopia.
6. **Reszta — kreatorem.** `Zainstaluj.cmd` z tego folderu rozpozna instalację (jest
   `config.local.toml`) i pokaże jej stan. **„Napraw”** odtwarza plik Apache i reguły zapory
   w trybie zapisanym w `installer.local.json`, zakłada oba zadania w Harmonogramie
   i uruchamia usługę. Certyfikat domowy wrócił z kopii, więc **VPS nie wymaga żadnej
   zmiany** — nadal ufa temu samemu certyfikatowi (chyba że zmienił się adres łącza domowego:
   patrz `PUBLIC-EXPOSURE.md`). Bez `installer.local.json` (instalacja robiona ręcznie)
   plik Apache odtwarza „Sposób dostępu”.
7. **Foldery z mediami.** Jeśli leżą teraz gdzie indziej: „Foldery z mediami” → „Zmień
   ścieżkę…” — identyfikatory zostają, więc oceny i kolekcje pasują do plików.
8. **Sprzątanie:** usuń `C:\odtworzone` — to były sekrety w czystej postaci.

Sprawdzian, zanim będzie potrzebny: raz na jakiś czas odszyfruj najnowszą kopię (`list`
wystarczy) — kopia, której nikt nigdy nie otworzył, jest tylko nadzieją.
