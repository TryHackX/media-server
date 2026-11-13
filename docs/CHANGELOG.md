# Dziennik zmian

Zamknięte etapy i serie zmian. Roadmapy już nie ma (wycofana 09.11.2026, gdy wszystko z niej było
zrobione): świadome decyzje projektowe opisuje `ARCHITECTURE.md`, a rzeczy niemożliwe do zrobienia
wiernie — z powodem — `FRONTEND.md`.

## 13.11.2026 (7) — Poradniki: instalacja z paczki albo z GitHuba krok po kroku

Tylko dokumentacja, po wydaniu 1.0.0. W `INSTALL-WINDOWS.md` (punkt 3) i `INSTALL-DEBIAN.md`
(punkt 2) jeden długi akapit zastąpiły dwie drogi: paczka wydania (bez gita, budowania i Node.js)
albo klon z GitHuba z gotowymi poleceniami — klon kodu, klon paczek do
`media-server/frontend/vendor`, instalator, który sam buduje interfejs — i z tym, co każde polecenie
robi, kiedy jest potrzebne i jak potem aktualizować.

## 13.11.2026 (6) — **1.0.0**: pierwsze wydanie w nowym repozytorium; z klona interfejs buduje się przy każdej instalacji i aktualizacji

Wersja **1.0.0** (`pyproject.toml`, `media_server.__version__`, `frontend/package.json` i oba wpisy
w `package-lock.json`). Publiczne repozytorium zakładane od nowa, z jednym commitem: razem ze starym
znikają osierocone commity, które GitHub serwował po SHA mimo przepisania historii (17.08.2026).
Paczki, których nie wolno publikować, mają własne prywatne repozytorium,
[media-server-vendor](https://github.com/TryHackX/media-server-vendor), klonowane w `frontend/vendor`.
Bez migracji.

- **Aktualizacja z klona instalowała stary interfejs albo nie szła wcale.** Kreator Windows budował
  w klonie, a przy następnym uruchomieniu (po `git pull`) brał ten build za gotowy. Instalator Debiana
  odmawiał aktualizacji z klona („brak zbudowanego interfejsu”), bo buduje w katalogu wydania, nie
  w klonie. Teraz z klona (jest `frontend/package-lock.json`) interfejs buduje się przy każdej
  instalacji i aktualizacji. Windows: wiersz „Interfejs” i krok budowania także wtedy, gdy w klonie
  leży build. Debian: pytanie o budowanie także wtedy, a „aktualizacja” z klona doinstalowuje
  Node.js i npm z Debiana (gdy ich brak) i woła skrypt wydania z `--build-frontend`. Plik odpowiedzi
  bez `build_frontend` przy klonie ze starym buildem dostaje ostrzeżenie `plan.stale_build`.
- **Brak Node.js nie blokuje czynności, które nie budują.** Na instalacji zrobionej z klona kreator
  bez okien (zmiana folderów, sposobu dostępu, naprawa) dostaje ostrzeżenie zamiast błędu. Krok
  budowania i tak sprawdza Node.js sam.
- **Node.js z NodeSource:** jego `nodejs` niesie npm i gryzie się z debianowym pakietem `npm`. Gdy
  `node` i `npm` już są, instalator Debiana niczego obok nich nie instaluje.
- **Wydanie na Debianie bez budowania nie kopiuje `frontend/`.** Z klona ze zbudowanym interfejsem
  każde z trzech trzymanych wydań niosło dotąd źródła i 1 GB paczek.
- **Testy instalatora Debiana nie zależą od buildu na maszynie.** Uruchamiają instalator wprost
  z repozytorium, a ten sprawdzał `public/assets/build`. U właściciela build był, w CI (czysty
  checkout) nie, więc tam pełne przebiegi trafiłyby na „brak interfejsu”. `TRYHACKX_SOURCE_LAYOUT`
  (tylko dla testów, jak `TRYHACKX_SYSROOT`) mówi, czym ma być drzewo: paczką (domyślnie), klonem
  albo klonem ze starym buildem.
- **Szablony paczki dla VPS-a z LF także w checkoucie na Windows.** `*.sh eol=lf` nie łapało
  `vps-setup.sh.tmpl`: przy `core.autocrlf=true` (Git for Windows, także runnery CI z Windows) plik
  dostawał CR LF i test końców linii padał. Teraz `*.tmpl text eol=lf`. Sam wygenerowany
  `vps-setup.sh` był i tak w porządku — generator czyta szablon z uniwersalnymi końcami linii
  i zapisuje LF.
- **Gitleaks w CI: dwa fałszywe alarmy w testach.** Pierwszy push nowego repozytorium skanuje całe
  drzewo, a reguła `generic-api-key` wzięła za klucze nazwę presetu w polu `key`
  (`milkdrop-packs.test.ts`) i publiczny wektor testowy TOTP z RFC 6238 (`test_php_totp.py`).
  Oba oznaczone komentarzem `gitleaks:allow` w tej samej linii.
- **Kreator uruchomiony z PowerShell 7.** `Zainstaluj.cmd` i `Install.cmd` startowane z PowerShell 7
  (Windows Terminal; tak samo kroki CI na Windows) przekazywały Windows PowerShell 5.1 zmienną
  `PSModulePath` z modułami 7 na początku. 5.1 brał wtedy nie swój `Microsoft.PowerShell.Utility`,
  więc `Get-FileHash` i podobne polecenia były „nierozpoznane”. W CI padał na tym samotest kreatora,
  jedyny błąd na 1081 testów. Oba pliki `.cmd` czyszczą teraz tę zmienną przed startem PowerShella
  (5.1 składa wtedy własną, domyślną); test kreatora też. Odtworzone fałszywym modułem w stylu PS 7:
  bez poprawki ten sam błąd, z poprawką działa.
- **Dokumentacja:**
  - README: repozytorium z paczkami — klon, token na Debianie, ZIP bez gita,
    `core.longpaths` na Windows (nazwy presetów MilkDropa do 210 znaków poniżej `frontend\vendor`),
    aktualizacja z klonów;
  - `INSTALL-WINDOWS.md` i `INSTALL-DEBIAN.md`: to samo po polsku;
  - `RELEASE.md`: paczki jako piąta rzecz do odtworzenia serwera, odtworzenie z paczkami prywatnymi;
  - `FRONTEND.md`: licencja Pro a repozytorium prywatne.

Testy:
- **Instalator Debiana:**
  - plan z klonem: build mimo starego buildu, ostrzeżenie bez `build_frontend`, Node.js już
    zainstalowany;
  - aktualizacja z klona i z klona ze starym buildem: Node.js i npm z Debiana przed wydaniem,
    `--build-frontend`;
  - aktualizacja z Node.js na miejscu: bez `apt-get`;
  - aktualizacja z paczki: nic się nie buduje.
- **Samotest kreatora:** klon ze starym buildem budowany od nowa; brak Node.js w trybie konserwacji
  tylko ostrzega.
- **Skrypt wydania:** bez budowania `frontend/` nie trafia do wydania. Test działa tylko na POSIX,
  więc wykluczenia sprawdzone dodatkowo ręcznie na `tar` z Git Basha.
- **Wyniki:**
  - instalator Debiana, kreator i skrypt wydania: 284 zaliczone, 13 pominiętych (tylko POSIX);
  - bramka z audytem: 10/10, pip-audit i npm audit bez podatności;
  - czysty klon jak w CI (bez buildu, bez paczek, checkout z `autocrlf=true`): backend 1100
    zaliczonych, 0 błędów; front `npm ci`, build i 583 testy (582 zaliczone, 1 pominięty).
- **Przy okazji:** `\M` w `test_php_playlist_parser.py` (SyntaxWarning od Pythona 3.12) zapisane
  jako surowy napis.

## 13.11.2026 (5) — Instalacja prosto z GitHuba: klon, paczki w `frontend/vendor`, instalator buduje interfejs

Cel: z dwóch repozytoriów — publicznego z kodem i (u właściciela) prywatnego z paczkami, które
wolno mu używać — da się w każdej chwili odbudować i zainstalować wszystko, bez gotowej paczki.
Bez migracji. Pliki: `.gitignore`, `README.md`, `installer/lib/{Detect,Steps,PagesInstall,Preview}.ps1`,
`installer/lang/{pl,en}.psd1`, `installer/tests/SelfTest.ps1`, `installer/debian/lib/{detect,wizard}.sh`,
`installer/debian/lang/{pl,en}.sh`, `scripts/release-debian.sh`, `docs/INSTALL-WINDOWS.md`,
`docs/INSTALL-DEBIAN.md` oraz brakujący dotąd
`frontend/src/shared/visualizations/voltviz/visualizers/runtime/types.ts`.

- **Czysty klon się nie budował.** Reguła `runtime/` w `.gitignore` (bez ukośnika na początku)
  pomijała każdy folder tej nazwy, także kod VoltViz — `types.ts` nigdy nie trafił do
  repozytorium, a `tsc` w klonie i w CI kończył się TS2307. Teraz `/runtime/`, `/logs/`,
  `/backups/` (tylko katalog główny) i plik jest w repozytorium. Sprawdzone: czysty klon + paczki
  w `frontend/vendor` → `npm ci` i `npm run build` bez pamięci podręcznej (2 min) dają te same
  3861 plików co build z katalogu roboczego, wizualizacje bajt w bajt.
- **Kreator Windows buduje interfejs z klona.** Strona wymagań ma wiersz „Interfejs”: gotowy
  (paczka wydania), do zbudowania (klon — z Node.js i wymienionymi z nazwy paczkami z
  `frontend\vendor`), brak Node.js albo za stary (błąd z „Zainstaluj (winget)”:
  `OpenJS.NodeJS.LTS`, i stroną pobierania). Nowy krok „Zbudowanie interfejsu” idzie pierwszy
  (w aktualizacji — przed zatrzymaniem usługi): `node npm-cli.js ci` i `run build` w `frontend\`
  klona, bez `cmd.exe` po drodze, z katalogiem tego Node.js na początku `PATH` (zainstalowany przed
  chwilą przez winget nie jest jeszcze w `PATH` kreatora). Kopiowanie pomija `frontend\` w
  katalogu głównym (pełna ścieżka w `/XD` — folder tej nazwy głębiej zostaje) — do instalacji trafia
  gotowy interfejs, nie 1 GB źródeł i paczek. Wcześniej kreator uruchomiony z klona instalował
  serwer bez interfejsu. Krok sprawdzony naprawdę na klonie z dziesięcioma paczkami: 135 s, wynik
  = build z paczki.
- **Instalator Debiana** wymienia w pytaniu o budowanie paczki znalezione w `frontend/vendor`
  (albo mówi, że powstanie interfejs publiczny), a skrypt wydania po zbudowaniu usuwa z wydania
  `frontend/node_modules` i `frontend/vendor` — każde z trzech trzymanych wydań niosłoby je od nowa.
- **README** przepisany: wsparcie projektu na górze, obie instalacje krok po kroku, instalacja z
  klona, co zawiera interfejs publiczny, a co dochodzi z `frontend/vendor`.

Testy: samotest kreatora — wiersz wymagań we wszystkich stanach, wersje Node.js (20.19+, 22.12+,
nie 21), wykrycie paczek bez `.git`, spis kopiowanych plików bez `frontend\` u góry, próba na
sucho instalacji z klona (budowanie pierwsze, `ci` przed `run build`, paczki z nazwy, `/XD` z pełną
ścieżką, nic nie zapisane) i kolejność w aktualizacji; testy instalatora Debiana i skryptu wydania
bez zmian w wynikach (234 zaliczone).

## 13.11.2026 (4) — Instalator Debiana na prawdziwym Debianie 13: cudza zapora, PHP-FPM, serwer, który już coś obsługuje

Pierwsze przebiegi poza atrapami: na działającym serwerze z Debianem 13 (Python 3.13.5, bash 5.2,
systemd 257, PHP 8.5 przez PHP-FPM, własne reguły nftables, kilka stron w Apache'u, fail2ban). To
serwer produkcyjny, więc wyłącznie próby na sucho i odczyty, a po nich sprzątanie: dwa puste foldery
testowe, katalog roboczy i dwa dzienniki z `/var/log` usunięte; żadnej bazy ani konta. Bez migracji.
Pliki: `zainstaluj-debian.sh`, `installer/debian/lib/{common,detect,steps,wizard,flows}.sh`,
`installer/debian/lang/{pl,en}.sh`, `installer/setup_helper/debian.py`,
`installer/templates/vps/vps-setup.sh.tmpl`, testy `tests/test_debian_installer.py`,
`tests/debian_harness.py`, `tests/debian_stubs/system-command.sh`, `docs/INSTALL-DEBIAN.md`.

**Co sprawdzono na prawdziwym systemie:**
- próby na sucho S, P, D i C jako zwykły użytkownik i jako root, po angielsku, `--status`, `--zmien`,
  `--odnow` i `--odinstaluj` bez instalacji;
- `vps-setup.sh --dry-run` z paczką wygenerowaną z testowymi wartościami (odcisk zgodny);
- `apache2 -t` wszystkich wygenerowanych stron (S, P, D, C i obie strony VPS-a) z modułami
  i `conf-enabled` tego serwera, przez osobny plik konfiguracji: „Syntax OK”;
- `systemd-analyze verify` pięciu jednostek bez uwag, `php -l` 27 plików na PHP 8.5 bez błędów
  i bez ostrzeżeń o przestarzałych konstrukcjach, `compileall` na Pythonie 3.13 z `-W error`;
- wykrywanie: porty TCP i UDP, strony na 80 i 443, port SSH z `sshd -T`, połączenia SSH.

**Co wyszło i co poprawiono:**
- **Cudza zapora.** Plan instalował i włączał `ufw` na serwerze z własnymi regułami nftables.
  Jego „odrzuć resztę” działałoby obok tamtej zapory, a pakiet musi przejść obie, więc usługi
  wpuszczane przez nftables przestałyby odpowiadać (plan wymieniał ponad 20 takich portów).
  Teraz `firewalld` albo zestaw reguł nftables (tabela z regułami albo z polityką `drop`) zostaje
  nietknięty: bez `ufw`, bez reguł, bez pytania o zaporę. Plan mówi, które porty otworzyć w tamtej
  zaporze. Domyślny `nftables.conf` Debiana i tabela fail2bana zaporą nie są.
- **PHP-FPM.** Plan instalował `libapache2-mod-php`, który na Debianie przełącza Apache'a na
  prefork i zmieniłby działanie pozostałych stron. Prawdziwy przebieg próbowałby też
  `a2enmod php8.5` obok FPM. Teraz Apache z `conf-enabled/php8.x-fpm.conf` zostaje przy FPM:
  - pakiety `php8.x-*` tej samej wersji;
  - moduły `proxy_fcgi` i `setenvif` (bez nich most zostałby wysłany jako tekst);
  - przeładowanie `php8.x-fpm` po doinstalowaniu rozszerzeń;
  - sprawdzenie rozszerzeń tą wersją PHP.
- **Porty, które zamknie `ufw`**, plan wymieniał tylko w S. Teraz we wszystkich wersjach: w P i D
  z zaufaną siecią domową jako „tylko z sieci domowej”. Klient DHCP (68 i 546 UDP) i porty
  z `extra_ports` nie są już na tej liście.
- **Bez terminala** (`ssh serwer 'sudo bash …'`) instalator nie znał adresu sesji SSH: `sudo` gubi
  `SSH_CONNECTION`, a `who am i` nic nie zwraca. W P i D następne logowanie spoza sieci domowej
  byłoby zamknięte. Teraz regułę SSH dostają adresy połączone w tej chwili przez SSH, a plan
  je wymienia. Adres `::ffff:a.b.c.d` z gniazda dwustosowego idzie do reguły jako zwykły IPv4.
- **fail2ban, który już działał**, był restartowany. Teraz jest przeładowywany: jego bany i inne
  jaile zostają.
- **`vps-setup.sh`** zawsze wywoływał `apt-get install apache2 certbot …`. Na VPS-ie z innymi
  stronami podniósłby wersję zainstalowanego Apache'a i OpenSSL i zrestartował Apache'a w trakcie
  skryptu. Teraz instaluje tylko brakujące, a gdy niczego nie brakuje, nie woła `apt` wcale.
- **`--odinstaluj` bez instalacji** zaczynał zadawać pytania. Teraz mówi, że nie ma czego
  odinstalować, i kończy się kodem 0.
- **Root zostawiał `__pycache__` w rozpakowanej paczce**, także w próbie na sucho. Takiego
  folderu zwykły użytkownik nie usunie bez `sudo`. Pomocnik i `install.py --config-only` działają
  teraz z `-B` — tak samo pomocnik kreatora Windows (`Common.ps1`), który zostawiał ten sam
  katalog także przy `-DryRun`.
- **`--status`** zakładał dziennik w `/var/log` i brał blokadę. Teraz nie robi ani jednego,
  ani drugiego.
- Drobne:
  - port SSH podany przez `sshd -T` dwa razy liczy się raz;
  - żadna wartość z wykrywania nie przenosi już znaku nowego wiersza do żądania dla pomocnika;
  - podsumowanie i krok zapory przy cudzej zaporze nie mówią „tak wybrano”.

**Sprawdzone.** Każda poprawka ma test na podstawionym systemie; nowe atrapy to `nft list ruleset`
i `ss … state established`, plus przełączniki „bez terminala” i „bez modułu PHP”. Poprawki dla
cudzej zapory, PHP-FPM, `vps-setup.sh`, odinstalowania bez instalacji, `__pycache__` i wykrywania
połączeń SSH sprawdzone ponownie na tym samym serwerze, na sucho.

**Na prawdziwym Debianie wciąż czeka** prawdziwa instalacja na czystym systemie: `apt`, konta
MariaDB, `ufw enable`, certbot, start jaila, `whiptail`, `ssh`/`scp` do VPS-a, `--odnow` na żywym
`mod_ssl`, koła Pythona i usługa pod nowymi ograniczeniami systemd (lista w `docs/TESTING.md`).

## 13.11.2026 (3) — Instalator Debiana po audycie: zapora po odinstalowaniu, klucz VPS-a, kopia bazy przed aktualizacją

Audyt instalatora dla Debiana (1 × P0, 9 × P2, 21 × P3) i poprawki. Bez migracji. Pliki:
`zainstaluj-debian.sh`, `installer/debian/lib/{common,detect,steps,wizard,flows}.sh`, `installer/debian/lang/{pl,en}.sh`,
`installer/debian/examples/answers-private-vps.toml`, `installer/setup_helper/{cli,debian}.py`,
`installer/templates/vps/vps-setup.sh.tmpl`, `deploy/systemd/*.service`, nagłówki w `deploy/fail2ban/`, testy
`tests/test_debian_installer.py`, `tests/debian_harness.py`, `tests/debian_stubs/system-command.sh`, dokumenty
`docs/{INSTALL-DEBIAN,RELEASE}.md`, `README.md`.

**P0: odinstalowanie odcinało serwer.** Usuwało wszystkie reguły zapory zapisane przez instalator, także
te, które wpuszczają SSH i sieć domową, a zaporę domyślnie zostawiało włączoną. Po wylogowaniu nie dało
się wrócić na serwer. Teraz reguły dostępu mają własny komentarz `tryhackx-media-reach`. Jeśli zaporę
włączył instalator, kreator pyta o jej wyłączenie z domyślnym „tak”. Gdy zapora zostaje (odpowiedź „nie”
albo plik odpowiedzi bez `disable_firewall`), zostają z nią reguły dostępu, a podsumowanie mówi o tym
przed potwierdzeniem.

**P2.**
- Adres z `who am i` trafia do reguły zapory tylko wtedy, gdy jest adresem IP. Wpisy `(:0)`, `tmux(…)`
  czy `mosh […]` wywracały instalację na kroku zapory, także przy każdym wznowieniu. Plan ostrzega, gdy
  klienta SSH nie da się ustalić i gdy SSH z zewnątrz będzie otwarte tylko dla obecnego adresu.
- Klucz hosta VPS-a: skanowany jest tylko ED25519, a `ssh`/`scp` przyjmują wyłącznie `ssh-ed25519`.
  Wcześniej po potwierdzeniu jednego odcisku do `vps_known_hosts` trafiały wszystkie zeskanowane klucze,
  więc ktoś pośrodku mógł dorzucić własny ECDSA albo RSA. Przy porcie innym niż 22 liczy się tylko
  wpis `[host]:port`.
- `PATH` dostaje `/usr/local/sbin:/usr/sbin:/sbin` w `zainstaluj-debian.sh` i w `vps-setup.sh`. Po
  zwykłym `su` (bez `-`) nie było `a2enmod`, a `ufw` uchodził za wyłączony.
- Stan zapory zapisuje się od razu: reguły przed dodaniem, `firewall.enabled_by_installer` zaraz po
  włączeniu. Przerwana instalacja nie gubi już tego, co dodała.
- Nieudane `--odnow` przywraca paczkę dla VPS-a z certyfikatem, którego dom używa. Komunikat nie mówi
  już, że nic się nie zmieniło.
- `--zmien aktualizacja` po nowym wydaniu odświeża wygenerowane pliki: strony Apache, pliki `fail2ban`,
  hak odnowienia certyfikatu. Podmienia tylko pliki ze znacznikiem, które naprawdę się różnią (linia
  z datą się nie liczy), z `configtest` i cofnięciem. Gdy zmieniły się pliki dla VPS-a, mówi, żeby
  wysłać je jeszcze raz.
- Kopia bazy przed migracjami (`aktualizacja`, `migracje`): `mariadb-dump --single-transaction` przez
  gniazdo do `/var/backups/tryhackx-media-server/database/`, plik 0600, zostaje pięć najnowszych.
  Nieudana kopia zatrzymuje przebieg przed wydaniem i migracjami, a niepełny plik kopii jest usuwany.
  Dokumentacja obiecywała tę kopię, a jej nie było.
- Ponowna instalacja po odinstalowaniu (konfiguracja zachowana, plik stanu usunięty) nie jest już
  odrzucana. Instalator przejmuje zachowaną konfigurację i klucze. Konto administratora, które już jest
  w bazie, zostawia z dotychczasowym hasłem.
- Cofanie zmian w Apache'u (nieudana zmiana dostępu, nieudane `--odnow`) podnosi także zatrzymany
  Apache: `configtest`, `reload` albo `restart`, potem sprawdzenie, czy działa. Własne pliki
  certyfikatu: klucz nie może być zaszyfrowany i musi pasować do certyfikatu.

**P3.**
- Ręczna ścieżka do VPS-a podaje `sudo scp`, bo folder paczki należy do roota.
- Zapora: przed włączeniem `ufw` instalator widzi też usługi UDP, np. WireGuard. Przewodnik VPS nie
  twierdzi, że dom wpuszcza tylko VPS, gdy `ufw` już przepuszcza 443 wszystkim (np. „Apache Full”).
- W trybach publicznych (VPS, własna domena) Apache przestaje podawać wersję:
  - plik `tryhackx-media-quiet.conf` ze znacznikiem, włączany przez `a2enconf`;
  - w nim `ServerTokens Prod`, `ServerSignature Off`, `Header unset X-Powered-By`;
  - zdejmują go przejście na „tylko sieć domową” albo „tylko ten komputer” i odinstalowanie;
  - dokumentacja nie twierdzi już, że `ServerSignature` działa tylko globalnie.
- Podsumowanie mówi, że pakiet `fail2ban` włącza też debianowy jail `sshd`. Nagłówki plików
  w `deploy/fail2ban/` mówią, że instaluje je instalator Debiana.
- Kopia pliku sprzed zmian nie jest nadpisywana w tym samym przebiegu. Strona portu 80, zapisywana przy
  Let's Encrypt dwa razy, traciła kopię oryginału. `--log` dopisuje do pliku zamiast go czyścić.
- Odinstalowanie mówi przed potwierdzeniem, co zostaje:
  - baza z obydwoma kontami;
  - konfiguracja proxy na VPS-ie (`vps-setup.sh --usun`);
  - certyfikat Let's Encrypt, który certbot będzie próbował odnawiać (`certbot delete --cert-name …`).

  Pytanie o dane wymienia `/var/backups/tryhackx-media-server`, gdzie leżą kopie kluczy. Odinstalowanie
  usuwa też stare dzienniki instalatora z `/var/log`.
- `TRYHACKX_ADMIN_PASSWORD` znika ze środowiska zaraz po odczytaniu i nie dziedziczą go procesy
  potomne. Dokumentacja podaje hasło przez `read -rs` i radzi usunąć plik z hasłem po instalacji.
- Przykład odpowiedzi dla P opisuje `disable_existing_https` i `regenerate_certificate`.
- Identyfikator usuniętej biblioteki nie wraca. Instalator bierze listę z katalogu, a gdy
  `roots list` zawiedzie, z bazy (`media_roots.slug`). Gdy nie da się jej ustalić, mówi o tym.
- Kreator sprawdza użytkownika i port SSH VPS-a od razu przy wpisywaniu.
- Kod 255 z `ssh` to „nie udało się połączyć”, a nie „zmiany na VPS-ie cofnięte”. Dokumentacja mówi,
  jak usunąć stary klucz po postawieniu VPS-a od nowa.
- Blokada przed dwoma równoczesnymi przebiegami: `flock` na `/run/lock/tryhackx-media-setup.lock`.
- Dokumentacja: próba na sucho bez roota nie widzi `ufw`, właścicieli portów ani portów `sshd`, więc
  jej plan może się różnić (w bezpieczną stronę).
- `install.py --config-only` z rozpakowanej paczki nie zostawia pustego `runtime/` należącego do roota.
- Jednostki systemd dostały `CapabilityBoundingSet=`, `AmbientCapabilities=`, `RestrictNamespaces`,
  `RestrictRealtime`, `ProtectClock`, `ProtectHostname`, `ProtectKernelLogs`, `ProtectProc=invisible`
  i `SystemCallArchitectures=native`.
- `installer.json` (z adresem domu) ma `root:root 0600`.
- README i dokumentacja:
  - polecenia wydania mają `--migrate-config` i idą przez `bash`, bo klon z gita nie ma bitu
    wykonywania;
  - ręczna ścieżka podaje hasło bazy przez zmienną, nie w linii poleceń;
  - ręczna ścieżka zakłada oba konta (`localhost` i `127.0.0.1`).
- Tryb P sprawdza, czy wolny jest port 80, nie tylko 443: Apache Debiana słucha na nim domyślną
  stroną i bez niego nie wstanie. W trybach D i C plan ostrzega, gdy inna strona na porcie 80 jest
  czytana przed naszą.
- Nieudane `--zmien dostep` zapisuje reguły zapory, które zdążyło dodać. `--zmien vps` na instalacji
  bez znanego adresu domu mówi to zrozumiale.
- `RELEASE.md`: suma SHA-256 to nie podpis. Doszła rada o podpisanym tagu i podpisie sumy.
- `INSTALL-DEBIAN.md`, nowa sekcja „Świadome ograniczenia”:
  - usługa i PHP dzielą konto `www-data`;
  - `check`, migracje i `npm ci` uruchamia root;
  - jednostki nie mają filtra wywołań systemowych.

**Świadomie nie zrobione.**
- `SystemCallFilter` i `IPAddressAllow` w jednostkach: usługa pobiera metadane z sieci i uruchamia
  FFmpeg, a filtra nie da się sprawdzić bez prawdziwego Debiana.
- Globalne adresy IPv6 sieci domowej nie są uznawane za sieć domową, tylko `fc00::/7` (opisane).
- Zajęte porty i inne strony HTTPS wychodzą dopiero w planie, po pytaniach. To wciąż przed
  jakąkolwiek zmianą.
- Osobne konto dla usługi i dla PHP wymagałoby PHP-FPM zamiast `mod_php`; opisane jako ograniczenie.

**Sprawdzone.** 192 testy w `tests/test_debian_installer.py` (przy audycie 181). Pełny cykl P obejmuje
teraz także nieudane `--odnow`, aktualizację i ponowną instalację. Nowe atrapy: `mariadb-dump`,
`a2enconf`/`a2disconf`, `ss -uln`, reguły `ufw status`. Bramka `scripts/check.py --audit`: 10 z 10
kroków, pytest 1188 zaliczonych i 15 pominiętych; po niej doszedł jeszcze test nieudanej kopii bazy.

## 13.11.2026 (2) — Instalator dla Debiana 13: samodzielny serwer i dom za VPS-em

Bez migracji. Pliki: `zainstaluj-debian.sh`, `installer/debian/` (`lib/{common,ui,detect,steps,wizard,flows}.sh`,
`lang/{pl,en}.sh`, `examples/answers-*.toml`), `installer/setup_helper/{answers,debian,flat}.py` i zmiany
w `cli.py`, `naming.py`, `vpsbundle.py`, szablony `installer/templates/vps/` (nowy `vps-setup.sh.tmpl`),
`scripts/package-release.py` (paczka `-debian.tar.gz`), testy `tests/test_debian_installer.py`,
`tests/debian_harness.py`, `tests/debian_stubs/`, dokumenty `docs/{INSTALL-DEBIAN,PUBLIC-EXPOSURE,RELEASE}.md`,
`README.md`.

**Jeden skrypt, cztery kształty.** `sudo bash zainstaluj-debian.sh` robi na Debianie to, co kreator robi na
Windows. Zna cztery kształty:
- **S**: samodzielny serwer publiczny z Let's Encrypt;
- **P**: serwer domowy za publicznym VPS-em;
- **D**: sieć domowa po HTTP;
- **C**: tylko ten komputer.

Sprawdza system, pyta w oknach `whiptail` albo zwykłymi pytaniami, pokazuje listę wszystkich zmian
i dopiero po zatwierdzeniu instaluje pakiety, bazę MariaDB i konfigurację. Konto aplikacji dostaje
same prawa do danych, migracje idą osobnym kontem przez `config.migrate.toml`. Dalej idą wydanie przez
`release-debian.sh`, usługa i timery systemd, strony Apache wygenerowane z przykładów `deploy/apache/`,
certyfikat, zapora `ufw`, `fail2ban`, konto administratora i foldery z mediami. Pierwszy skan rusza
w tle. Język: polski, `--lang en`.

**Tryby.** `--dry-run` wypisuje każde polecenie i każdy plik razem z treścią, bez roota i bez zmian.
`--answers plik.toml` działa bez pytań (przykłady w `installer/debian/examples/`; hasło administratora
tylko z pliku `chmod 600` albo zmiennej `TRYHACKX_ADMIN_PASSWORD`). `--zmien foldery|dostep|admin|aktualizacja|migracje|vps`
zmienia istniejącą instalację. `--odnow` wymienia certyfikat domu bez przerwy: VPS przez chwilę ufa
staremu i nowemu. `--odinstaluj` usuwa tylko to, co instalator założył: każdy plik systemowy ma
znacznik `# TRYHACKX-MEDIA-SERVER-MANAGED v1`, mediów nie dotyka nigdy, a bazę usuwa dopiero po
wpisaniu jej nazwy. `--status` pokazuje, co jest zainstalowane. Przerwana instalacja daje się
dokończyć, a nieudana zmiana dostępu cofa konfigurację, zaporę i pliki Apache.

**Dom za VPS-em (P).** Certyfikat domu robi instalator: EC P-256, `CN=origin`, `CA:FALSE`,
`subjectKeyIdentifier` i `authorityKeyIdentifier`, bez `keyUsage`. Paczkę dla VPS-a składa ten sam
moduł co na Windows (`vpsbundle.py`). W wersji dla Debiana dochodzi samodzielny `vps-setup.sh`: można go
uruchamiać wielokrotnie, ma `--dry-run`, sprawdza odcisk i to, czy OpenSSL VPS-a przyjmie przypięty
certyfikat, a przy błędzie cofa zmiany. Instalator proponuje wysłać go przez SSH (klucz hosta pokazany
do potwierdzenia) albo podaje dwa polecenia do wpisania ręcznie. Rekord DNS i przekierowanie portu na
routerze podaje z dokładnymi wartościami.

**Paczka Debiana.** `scripts/package-release.py --platform debian|all` składa
`TryHackX-Media-Server-<wersja>-debian.tar.gz`: powtarzalny tar.gz, LF w plikach tekstowych, `.sh`
z trybem 0755, bez plików tylko dla Windows. Obowiązują te same wykluczenia i ta sama odmowa przy
sekrecie co dla ZIP-a.

**Sprawdzone tutaj, bez Linuksa.** `bash -n` wszystkich skryptów. Przebiegi na podstawionym systemie
(atrapy poleceń w `tests/debian_stubs/`) dla S, P, D, C i `vps-setup.sh`, oba języki, `whiptail`
i zwykłe pytania. Pełny cykl P: instalacja, foldery, nieudana zmiana dostępu z cofnięciem, `--odnow`,
`--status`, odinstalowanie. Do tego certyfikaty i rotacja na prawdziwym OpenSSL. Wydzielenie wspólnych
części z `vpsbundle.py` nie zmieniło paczki Windows: porównanie bajt po bajcie przed poprawkami
tekstów z wpisu 13.11 (1).

**Do sprawdzenia na prawdziwym Debianie 13:**
- `apt` i pakiety PHP;
- `apache2ctl configtest` wygenerowanych stron;
- systemd z `ProtectHome`;
- `ufw`, łącznie z `delete … comment`;
- konta MariaDB przez gniazdo;
- certbot i hak odnowienia;
- start jaila `fail2ban`;
- wygląd okien `whiptail`;
- prawdziwe `ssh`/`scp` do VPS-a;
- `--odnow` na żywym `mod_ssl`;
- koła Pythona na 3.13;
- odczyt folderów przez `www-data`.

## 13.11.2026 (1) — Kreator Windows po audycie: przerwana instalacja, certyfikat domu, aktualizacja, dostępność

Audyt całej ścieżki instalacji (3 × P1, 11 × P2, 24 × P3; żadnego P0) i poprawki części dla Windows.
Bez migracji i nowych zależności. Pliki: `installer/Setup.ps1`, `installer/lib/{Common,Detect,Steps,State,Ui,
PagesInstall,PagesMaintain,Preview}.ps1`, `installer/lib/{Controls,Native}.cs`, `installer/lang/{pl,en}.psd1`,
`installer/tests/SelfTest.ps1` (191 sprawdzeń), `src/media_server/cli.py`, `frontend/src/pages/admin.ts`,
`docs/INSTALL-WINDOWS.md`, `.gitignore`.

**Przerwana pierwsza instalacja da się dokończyć.** Kreator zostawia znacznik
`config\installer.pending.json` przed środowiskiem Pythona i zdejmuje go dopiero z zapisem stanu. Na
takim drzewie pyta „dokończyć czy zacząć od nowa”, przyjmuje jego folder jako cel i nie zakłada drugi raz
konta, które już jest. Dotąd jedynym wyjściem było odinstalowanie i kasowanie folderu ręcznie.

**Certyfikat domu nie podmienia się po cichu.** „Sposób dostępu” na instalacji zrobionej ręcznie przejmuje
samopodpisany certyfikat, który host `:443` już pokazuje (przypięty na VPS), zamiast robić nowy. Gdy
nowy jest jednak potrzebny, a przed domem stoi już VPS, podsumowanie mówi, że najpierw trzeba wgrać
`origin.crt` na VPS. Certyfikat robiony przez kreator nie ma `keyUsage` (OpenSSL starszy niż 1.1.1h nie
przyjmuje inaczej samopodpisanego certyfikatu jako własnej kotwicy), a próba nie zapisuje pliku `.cnf`.

**Tryby publiczne milczą o wersjach.** W trybie VPS i własnej domeny `ServerTokens Prod`,
`ServerSignature Off` i `expose_php = Off`, z kopią i cofaniem jak pozostałe pliki Apache. Każdy błąd
w środku kroku Apache przywraca pliki, zanim cokolwiek się przeładuje. Port Apache inny niż 80 wychodzi
już na stronie wymagań, a nie w kroku 10.

**Zamykanie okna w trakcie.** Migracja bazy i rejestracja zadań nie dają się przerwać w połowie (bez limitu
czasu dla migracji); przerwanie czeka na koniec kroku. „Zatrzymaj” zabija całe drzewo procesów (pip
zostawał). Tekst przy zamykaniu po zakończonym albo nieudanym przebiegu nie twierdzi już, że „nic nie
zmieniono”.

**Aktualizacja robi wszystko, co trzeba.** Najpierw pełna kopia bazy (`mysqldump` kontem administratora do
`backups\database`, folder tylko dla administratorów; pole na stronie aktualizacji), potem pliki i usunięcie
tych, których nowa wersja już nie ma — według spisu `runtime\installer-files.txt` z poprzedniej
instalacji, nigdy w kopii roboczej gita. Na koniec migracje, a dla instalacji zrobionej kreatorem nowy plik
Apache z szablonu nowej wersji, zadania od nowa i zapis stanu. Dotąd stara migracja usunięta z pakietu
zostawała i dalej się wykonywała.

**Naprawa przywraca zabezpieczenia.** Zamyka znowu prywatne pliki (konfigurację, jej kopie, klucze) dla
administratorów, SYSTEM i kont, na których działają zadania — `robocopy /MOVE` przenosi je z prawami
dziedziczonymi. Do tego uprawnienia folderu (gdy instalacja je miała), autostart usług i `.venv` od nowa,
gdy jego Python nie startuje. Ręcznie ustawione zadanie okresowe zostaje, jak było, przy naprawie
i aktualizacji. Strona stanu ostrzega przed czytelną konfiguracją, ogólną regułą zapory w trybie VPS
i sieci domowej oraz zepsutym `.venv`.

**Odinstalowanie z konfiguracją** usuwa też `config.backup-*.local.toml` (te same hasła) i starsze kopie
kreatora. Gdy bazy nie założył ten kreator, strona to mówi, zanim ktoś wpisze jej nazwę.

**Mniejsze poprawki.**
- Reguła „sieć domowa” działa tylko w profilu prywatnym; o sieci oznaczonej jako publiczna kreator mówi.
- Port 443 zajęty przez inny program blokuje tylko tryby z HTTPS. Komunikat o zajętym porcie mówi, jak
  go zwolnić.
- Python 3.11–3.14 ma pierwszeństwo przed nowszym: pod 3.15 nie byłoby gotowych pakietów z locka.
- Wyjście okna Windows PowerShell jest czytane w stronie kodowej OEM, więc polskie komunikaty
  systemowe nie przychodzą zniekształcone.
- Test połączenia z bazą czyta odpowiedzi po etykietach. Ostrzeżenie klienta MariaDB brało się wcześniej
  za liczbę.
- Kopia zapasowa nie jest nadpisywana przy „Spróbuj ponownie”.
- Krótkie hasła też są maskowane w dzienniku.
- Folder docelowy nie może leżeć w paczce ani mieć `[ ]` w ścieżce.
- Okno winget zamyka się po naciśnięciu klawisza.
- Pola certyfikatu mają „Wybierz plik…”.
- Instrukcja VPS ma bliźniaka `.txt` i przycisk na końcu.
- Błąd przed otwarciem okna pokazuje komunikat i zostawia plik w `%TEMP%`.
- Kreator wprost mówi, że przejmuje `http://localhost/`.
- Skanowanie aliasów czyta tylko `*.conf`.
- Minimalne wersje baz to MySQL 8.0.19 i MariaDB 10.5.2 (tego wymagają migracje).
- Notka pod źródłami w panelu wskazywała nieistniejący przycisk „Zmień ustawienia”. Teraz wskazuje
  „Foldery z mediami” w `Zainstaluj.cmd` i `--zmien foldery` na Debianie.
- Angielskie teksty kreatora odsyłają do `Install.cmd`.

**Części wspólne z instalatorem Debiana** (po wpisie 13.11 (2)).
- Host domu nazywa się `origin.invalid`, bez nazwy produktu.
- Przewodnik VPS uczciwie mówi, czego układ nie ukryje: nagłówek `Received:` poczty, nazwa z
  dynamicznego DNS, historia DNS. Dochodzi sprawdzenie z zewnątrz.
- Gdy ogólne reguły Apache zostały włączone albo zapora jest wyłączona, przewodnik tego nie przemilcza
  (`firewall_managed` z kreatora).
- Polecenia kopiowania paczki najpierw usuwają starą kopię na VPS-ie — `scp -r` zagnieżdżał nową
  w starej.
- Przewodniki i plik aliasu nazywają prawdziwy kafelek „Sposób dostępu”.
- Ścieżka spoza ASCII nie trafia do `httpd-vhosts.conf`.
- Pomocnik czyta z `alias\` tylko `*.conf`.
- Zmiana folderów, która niczego nie zmienia, nie przepisuje konfiguracji ani nie robi jej kopii.
- Identyfikator biblioteki usuniętej w poprzednim przebiegu nie wraca do nowego folderu (pomocnik
  dostaje identyfikatory z `media-server roots list`).
- `install.py` przy niedostępnym folderze z mediami ostrzega, zamiast kończyć się tracebackiem.
- Paczka VPS z Windows zawiera `vps-setup.sh`: ten sam skrypt co z Debiana, ze sprawdzeniem odcisku
  i cofaniem zmian. Przewodnik pokazuje go jako najprostszą drogę.
- Certyfikat domu z kreatora Windows ma `authorityKeyIdentifier`. Bez niego VPS, który przy wymianie
  ufa naraz staremu i nowemu `CN=origin`, odrzuca pierwszy z pliku (zmierzone na OpenSSL 3.5.1
  z WampServera).
- Na Debianie `--zmien foldery` też nie oddaje identyfikatora usuniętej biblioteki nowemu folderowi.
- README mówi, że dokumentacja w `docs/` jest po polsku.
- `RELEASE.md`:
  - tag robi się w klonie repozytorium, nie w rozpakowanej paczce;
  - opcje zrzutu bazy są pełne;
  - porównanie prywatnych wartości działa tylko w katalogu roboczym;
  - przy odtwarzaniu folder na odszyfrowane sekrety i klucz domu dostają `icacls`, a folder na plik
    aliasu jest zakładany;
  - instalacja ręczna dostała uwagę o certyfikacie domu poza `config\origin\`.

**Dostępność.** Kafelki stanu to przyciski (Tab, Enter, spacja, ramka fokusu). Karty wyboru trybu mają rolę
przycisku opcji, nazwę, opis i stan, a strzałki przechodzą między nimi. Znaczki stanu mają nazwy.

**Teksty kreatora** (533 klucze) czyta własny czytnik drzewa parsera, który przyjmuje wyłącznie stałe
tekstowe. `Import-PowerShellDataFile` w Windows PowerShell 5.1 odrzuca tabelę większą niż 500 kluczy.

## 12.11.2026 (3) — Instalator graficzny dla Windows, paczka wydania i szyfrowana kopia sekretów

Bez migracji i bez nowych zależności: kreator to Windows PowerShell 5.1 i .NET z systemu, a jego
pomocnik w Pythonie używa tylko biblioteki standardowej. Pliki: `Zainstaluj.cmd`, `Install.cmd`,
`installer/` (`Setup.ps1`, `lib/*.ps1`, `lib/*.cs`, `lang/{pl,en}.psd1`, `helper.py`, `setup_helper/`,
`templates/vps/`, `examples/`, `tests/SelfTest.ps1`), `src/media_server/{cli,roots}.py`,
`scripts/{package-release,secret-backup}.py`, `scripts/{register-maintenance-task,run-maintenance}-windows.ps1`,
`docs/RELEASE.md`, `docs/{INSTALL-WINDOWS,PUBLIC-EXPOSURE}.md`, `README.md`, `.gitattributes`, testy w
`tests/test_{roots,setup_helper,installer_wizard,package_release,secret_backup}.py`.

**Kreator instalacji.** `Zainstaluj.cmd` (po angielsku od pierwszej strony: `Install.cmd`) otwiera okno,
które prosi o uprawnienia administratora, ogląda komputer (WampServer, Apache, PHP, MySQL albo MariaDB,
Python, FFmpeg, porty, zapora) i prowadzi przez dziesięć stron: wymagania, miejsce instalacji, baza,
foldery z mediami, sposób dostępu, konto administratora, podsumowanie, przebieg i wynik. Podsumowanie
pokazuje dokładnie ten plan, który potem się wykonuje. Praca idzie poza wątkiem okna, z dziennikiem na
żywo; hasła nigdy nie trafiają do dziennika. Polski domyślnie, angielski jednym przyciskiem.

**Cztery sposoby dostępu.** Tylko ten komputer; sieć domowa po HTTP; własna domena z HTTPS; VPS przed
serwerem domowym. W tym ostatnim kreator robi certyfikat tylko dla połączenia VPS → dom, wpuszcza port
443 wyłącznie z adresu VPS, wyłącza ogólne reguły „Apache HTTP Server” (zapisuje, które — da się je
przywrócić) i składa paczkę dla VPS w `runtime\vps-bundle`: gotowe pliki Apache z przypiętym
certyfikatem domu (`SSLProxyVerify require`), osobny długi limit czasu dla `/media-transfer/`, strona
przerwy i instrukcja po polsku i angielsku. Każdy certyfikat, który kreator robi sam, jest certyfikatem
serwera (`CA:FALSE`, z własnej krótkiej konfiguracji): samo `openssl req -x509` z `openssl.cnf`
WampServera daje `CA:TRUE`, a takiego certyfikatu pokazanego przez serwer Firefox nie przepuszcza
w ogóle — bez „Akceptuję ryzyko”. Certyfikat domu nazywa się `CN=origin`: nie nazywa ani strony,
ani programu.

**Tryb zmian.** Uruchomiony na istniejącej instalacji kreator pokazuje jej stan i pozwala zmienić
foldery z mediami (jedyne miejsce, gdzie się je zmienia — panel w przeglądarce tylko je pokazuje),
sposób dostępu, dodać administratora, zaktualizować, naprawić albo odinstalować. Usunięcie bazy wymaga
wpisania jej nazwy; „usuń dane” kasuje tylko `.venv`, `logs` i wymienione podfoldery `runtime\`. Przed
każdą zmianą pliku Apache robi kopię w `backups\installer\`, a gdy `httpd -t` odmówi, przywraca
wszystkie pliki bajt w bajt.

**Tryb próbny i podgląd.** `-DryRun` niczego nie zmienia i nie potrzebuje administratora — każdą
zmianę tylko opisuje; z `-AnswerFile` działa bez okna. `-Preview` rysuje wszystkie strony
z przykładowymi danymi do plików PNG (27 stron, PL i EN, 100 % i 150 %).

**Nowe polecenia.** `media-server migrate --as-user root --password-stdin` zakłada tabele kontem
administratora bazy, więc konto aplikacji zostaje z samymi prawami do danych. `media-server roots
list|sync` czyta i zapisuje `media_roots` bez skanowania — rodzaj źródła jest znany od razu, a pierwsze
indeksowanie idzie w tle. Zadanie okresowe przyjmuje `-PhpPath` i `-MetadataLimit`.

**Paczka wydania.** `scripts/package-release.py` składa ZIP z plików widocznych dla gita i zbudowanego
frontendu, bez plików deweloperskich. Odmawia, gdy znajdzie sekret, niepusty `frontend/vendor/` albo
`assets/iconpacks/` w buildzie — wydanie buduje się z czystego klonu. Procedurę wydania i pełnej
prywatnej kopii (osobne prywatne repozytorium, sekrety wyłącznie zaszyfrowane) opisuje `docs/RELEASE.md`.

**Szyfrowana kopia sekretów.** `scripts/secret-backup.py encrypt|list|decrypt` pakuje prywatną
konfigurację i zrzut bazy do jednego pliku (scrypt + AES-256-GCM).

**`.gitattributes`.** `*.cmd` i `*.psd1` z końcami linii CRLF: kreator ich wymaga, a bez wpisu checkout
na innej maszynie mógłby je zamienić.

Sprawdzone: 217 nowych testów, samotest kreatora 162/162, wszystkie pliki PowerShell parsują się bez
błędu, przebiegi próbne we wszystkich czterech trybach i w trybie zmian, prawdziwy krok bazy na
jednorazowej bazie `thx_installer_test` (usuniętej). Prawdziwej instalacji z UAC nie było — ten
komputer to działająca instalacja właściciela (lista w `TESTING.md`).

## 12.11.2026 (2) — Okienka przewijają się w środku, ocena filmu w odtwarzaczu, usuwanie konta, porządek w ustawieniach konta i panelu

Bez migracji i bez nowych zależności. Pliki: `frontend/src/shared/{modal,media-viewer,confirm,api,types,i18n-en}.ts`,
`frontend/src/pages/{account,admin}.ts`, `frontend/src/pages/library/cards.ts`,
`frontend/src/styles/{base,library,motion,public,panels,utilities,video-viewer}.css`,
`integrations/php/CatalogActions.php`, `integrations/php/stage/bridge.php`, test w `tests/test_bridge_accounts.py`.

**Okienka — edytor metadanych i każde inne.** Panel okienka to nagłówek i treść, ale wiersz treści nie
miał górnej granicy: wiersz siatki rośnie do tego, co w nim jest, a panel, który ucina nadmiar, obcinał
resztę — i nic się nie przewijało. „Edytuj metadane i okładkę” wychodził formularzem pod dolną krawędź
panelu razem z przyciskiem „Zapisz zmiany”: na ekranach 1440×900 i 1280×720 oraz na każdym telefonie nie
dało się do niego dojść, a kółko myszy albo palec przewijały stronę pod spodem (zmierzone: formularz
1138 px w panelu 860 px, na telefonie 1326 px w 824 px). Teraz wiersz treści ma `minmax(0, 1fr)`, treść
każdego okienka przewija się sama (`overflow-y: auto`, `overscroll-behavior: contain`), a strona pod
otwartym okienkiem stoi w miejscu — `openModal()` zakłada na `<html>` klasę `has-open-dialog`
(`base.css`) i zachowuje miejsce paska przewijania, więc nic za przyciemnieniem nie skacze w bok. Panel
nie wychodzi też nad górną krawędź: stałe przesunięcie w górę (`translateY` do 2rem) wypychało panel tak
wysoki jak ekran 5–12 px ponad niego. Zamiast przesunięcia wolne miejsce dzieli się 1 : 1,15 nad i pod
panelem — krótkie pytanie stoi trochę powyżej środka, edytor wysokości ekranu dokładnie między
marginesami. Zmierzone po zmianie w pięciu rozmiarach: formularz przewija się (355–535 px kółkiem,
369–436 px palcem), strona pod spodem nie drgnie, „Zapisz zmiany” jest zawsze na dole panelu.

**Ocena filmu w odtwarzaczu.** Pod obrazem jest rząd z własnymi gwiazdkami (ten sam suwak co na kartach),
średnią z liczbą ocen i sercem. Film wznowiony ze strony startowej nie miał oceny nigdzie — trzeba było
szukać jego karty w bibliotece. Karta tego samego filmu na stronie przerysowuje gwiazdki i serce od razu
(zdarzenie `media:item-rated`, słuchane przez `library/cards.ts`). Na telefonie serce zostaje w pierwszej
linii, a średnia schodzi pod spód; w pełnym ekranie rząd się chowa, tak jak szczegóły techniczne.

**Usuwanie konta.** Panel → Konta ma przycisk „Usuń konto”, z dala od „Zapisz”. Najpierw pokazuje, co
zniknie (oceny, ulubione, playlisty, głosy na cudze playlisty, historia odtwarzania, linki gościnne,
sesje), potem trzeba wpisać nazwę konta — przycisk w okienku włącza się dopiero przy dokładnej zgodności,
a most sprawdza ją jeszcze raz. Znika konto i wszystko, co do niego należy: większość idzie za kontem
kluczami obcymi (`ON DELETE CASCADE`), a to, co nazywa konto bez klucza — link gościnny do jego
playlisty, liczniki kroku w górę i prób logowania — most kasuje sam w tej samej transakcji. Średnie ocen
przeliczają się od razu, bo liczone są z tego, co zostało. Zostają ogólne liczniki odtworzeń (nie nazywają
nikogo), poprawki katalogu zrobione przez to konto (bez autora) i dziennik aktywności z wpisem
`user.delete` i liczbami. Zasady jak przy każdej zmianie konta: nie własne, a konto administratora tylko
superadministrator. Do tej pory konto dało się wyłącznie wyłączyć, a oceny wyłączonego dalej liczyły się
do średnich.

**Foldery bibliotek w panelu — tylko do podglądu.** Indeksowanie pokazuje pod nazwą każdego źródła jego
folder na dysku serwera i mówi, jak go zmienić: instalatorem na komputerze z serwerem („Foldery z mediami”
w Zainstaluj.cmd, `--zmien foldery` na Debianie).
Z panelu nie da się tego zrobić — decyzja właściciela, żeby przejęta sesja administratora nie mogła wystawić
całego dysku.

**„Moje konto” → Ustawienia.** Pięć kart różnej wysokości w kolumnach `auto-fit` zostawiało dziury: każdy
rząd tak wysoki jak jego najwyższa karta, karta motywu najwyższa ze wszystkich (dwie próbki jedna pod
drugą), a na szerokim ekranie czwarta kolumna, której piąta karta nie zapełniała. Teraz najwyżej trzy
kolumny, karty jednego rzędu równej wysokości, a od dwóch kolumn wzwyż karta motywu zajmuje dwie, z
próbkami obok siebie i miniaturą obok nazwy — pięć kart wypełnia dokładnie dwa rzędy po trzy albo trzy
po dwie. Karta motywu: 401 → 291 px na komputerze, 695 → 389 px na telefonie.

**„Oceny i import”.** Pusta linia stanu i pusta lista wyników na końcu panelu importu dokładały dwa odstępy
siatki (32 px) pod ostatnim rzędem. Puste wychodzą z układu; linia stanu zostaje na stronie, gdzie czytnik
ekranu spodziewa się jej przed pierwszym komunikatem.

**Panel → Bezpieczeństwo i Biblioteka.** Klasa `.admin-settings__grid` nie miała żadnej reguły — od
pierwszej wersji. Każde pole było blokiem szerokim jak panel (lista trzech ról na 1500 px, pole liczby na
cały ekran), jedno pod drugim, z etykietą przyklejoną do pola wyżej. Teraz pola stoją obok siebie, po
14–18rem, wyrównane do pól, a nie do etykiet; przełącznik ma linię dla siebie. Zakładka Bezpieczeństwo
to karta na temat: na szerokim ekranie dwie kolumny (rejestracja i limity pobierania obok ochrony
antybotowej, krok w górę na całą szerokość, trzy pojedyncze przełączniki w jednym rzędzie), na telefonie
jedna, w tej samej kolejności; strona 2967 → 2115 px na 1920. Tabela progów kroku w górę na telefonie nie
mieściła się („Okno (s)” uciekało za ekran) — wąska zamienia się w bloki z nazwą kolumny nad każdym polem,
a pola tabeli mają wreszcie własne nazwy dla czytnika ekranu. W Bibliotece trzy ustawienia z opisem
mają listę do 38rem i pole liczby do 12rem zamiast całej szerokości. Przy okazji: pole „Minimalny wynik
reCAPTCHA v3” stało na stronie przy wyłączonym dostawcy, bo atrybut `hidden` przegrywał z `display: grid`
pola — `[hidden]` ukrywa teraz zawsze (`utilities.css`).

Sprawdzone na żywo (konto tymczasowe, usunięte): edytor w pięciu rozmiarach, ocena filmu (4 gwiazdki,
karta za nimi, serce, cofnięcie — komputer i telefon), usunięcie drugiego konta tymczasowego przez panel
(okienko z liczbami, zła wielkość liter blokuje przycisk, po usunięciu w bazie nie zostało nic), układy
ustawień w pięciu szerokościach. Test: `test_deleting_an_account_takes_everything_that_is_its_own`.

## 12.11.2026 (1) — Okienko „Chwila sprawdzenia” na stronie logowania, pasek obejrzenia na kartach filmów w bibliotece

Bez migracji i bez nowych zależności. Pliki: `frontend/src/styles/{public,pages,cards}.css`,
`frontend/src/pages/library/cards.ts`, `frontend/src/shared/types.ts`, `integrations/php/LibraryBrowser.php`,
`integrations/php/CatalogActions.php`, test w `tests/test_bridge_library.py`.

**Okienko kroku w górę na stronie logowania.** Po trzech nieudanych logowaniach z jednego adresu strona logowania
pokazuje okienko „Chwila sprawdzenia” (proof-of-work albo wybrany dostawca). Od 11.11 (10) strona logowania ładuje
tylko `core.css`, a style okienek były w arkuszu aplikacji — okienko wyszłoby bez ramki, tła i układu. Jego reguły
(`.dialog--step-up`, `.step-up__*`) przeszły z `pages.css` do `public.css`, a ramkę okienka powtarza tam
`:where(.dialog--step-up)` z ważnością reguł aplikacji i przed nimi: w aplikacji wygrywają one jak dotąd (arkusz od dołu
na telefonie, ruch), na stronie logowania jest tylko to. Przy okazji: okienko miało stać nad wszystkim (`z-index` 95),
ale późniejsza `.dialog { z-index: 70 }` tę regułę przykrywała — teraz `.dialog.dialog--step-up`.

**Pasek obejrzenia na kartach filmów w bibliotece i na playlistach.** Strona startowa pokazywała, ile filmu zostało;
biblioteka nie, bo lista folderu nie niosła zapisanej pozycji. `LibraryBrowser::withSavedPositions` dokłada do filmów na
stronie listy (folder i playlista) `position_ms` i `progress` z `playback_stats` tego konta — jednym zapytaniem po kluczu
głównym, tylko między 2 % a 95 % długości (reguła „Kontynuuj”), bez nich dla reszty i dla gościa — a karta rysuje
cienką linię u dołu obrazka w barwach paska strony startowej. Test: pozycja 35 % jest, 1 % i 98 % nie ma, cudza pozycja
nie liczy się.

## 11.11.2026 (12) — Frontend, druga fala: motyw „Estoril Blue”, ruch, nowa strona startowa, minigracz na telefonie, karty z okładkami

### Co się zmieniło dla użytkownika

**Motyw**
- Drugi motyw kolorów, **„Estoril Blue”**: Moje konto → Ustawienia → Motyw. Zmiana działa od razu (podglądy obu
  motywów są narysowane w swoich kolorach), zapisuje się na koncie i wraca na każdym urządzeniu. Strona startuje
  od razu we właściwych kolorach — także pasek przeglądarki na telefonie (`theme-color`).

**Ruch**
- Przejście między stronami jest płynne (przenikanie, treść dojeżdża; tam, gdzie przeglądarka zna View Transitions,
  nagłówek strony przechodzi w nowy). Dialogi mają wyjście, nie tylko wejście; na telefonie są arkuszami od dołu,
  które można ściągnąć palcem. Zakładki konta i panelu mają przesuwany znacznik, powiadomienia — linię czasu,
  gwiazdki i serce odpowiadają na naciśnięcie, menu boczne na telefonie wprowadza linki po kolei.
- Wszystko to znika przy systemowym „ogranicz ruch”.

**Strona startowa** (HOME-01…06)
- Zamiast dwóch kafli i schowanych kart: „Kontynuuj” na górze, biblioteki z liczbami, półki — dokończ filmy
  i muzykę, następne odcinki, ostatnio dodane, polecane (z powodem na karcie), popularne w domu — oraz „Zaskocz
  mnie”. Na telefonie półki przewijają się w bok, na szerokim ekranie mają „Zobacz wszystkie”.
- **Trzy półki losowe** — filmy, seriale, utwory — do szybkiego puszczenia: znak odtwarzania na każdej karcie
  i „Wylosuj inne” przy półce.
- Kartę można schować („nie pokazuj”); stopka mówi, ile jest schowanych, i przywraca wszystkie. Powrót na stronę
  rysuje ją od razu z pamięci i odświeża w tle. Ładowanie ma szkielet, błąd — „Spróbuj ponownie”.

**Odtwarzacz** (PLR-02, PLR-11)
- **Telefon: minigracz.** Pasek 71 px (było 167): okładka, tytuł, odtwarzanie, następny, kolejka, linia postępu na
  górnej krawędzi. Dotknięcie albo pchnięcie w górę otwiera pełny odtwarzacz na cały ekran — duża okładka, oś czasu,
  wszystkie przyciski, gwiazdki; zamyka go przycisk, ściągnięcie w dół albo Escape. Działa od 320 px po duże
  telefony i w poziomie (okładka obok sterowania); pod klawiaturą ekranową pasek zjeżdża.
- **Tablet i wąskie okno:** dwa rzędy, które zwijają się do naprawdę jednego (transport obok osi czasu, kolejka
  i przycisk zwijania zostają); przycisk jest zwykłym przyciskiem doku, a nie półprzezroczystym znaczkiem w rogu.
- **Komputer:** w oknie 1250–1750 px tytuł nie jest już kolumną kilku liter (246 px przy 1440): suwak głośności
  chowa się za przyciskiem, gwiazdki tracą podpis. Oś czasu i głośność są rysowane w kolorach motywu.
- Panel kolejki i panel wizualizacji otwierają się i zamykają z ruchem; na telefonie kolejka jest arkuszem.
  Grający utwór ma trzy słupki w kolejce i na swojej karcie w bibliotece.
- Na iPhonie znika suwak głośności, który niczego nie zmieniał (głośność ustawiają tam tylko klawisze telefonu).

**Biblioteka** (LIB-09, LIB-10, LIB-08)
- **Karty:** okładka utworu cała i kwadratowa (było: pasek 350×160 przy 74% krycia z glifem na środku), kadr filmu
  16:9 z „1080p/4K”, „HDR” i czasem trwania na obrazie, folder i playlista ze znakiem w rogu. Naciśnięcie karty
  gdziekolwiek odtwarza albo otwiera; folder i playlistę w muzyce odtwarza krążek na okładce.
- Na karcie zostały tytuł, wykonawca i jeden wiersz faktów; ścieżka pliku jest podpowiedzią. Pod kartą: gwiazdki,
  serce i „⋯” (edycja tagów, dodanie do playlisty, link, pobranie). Na telefonie gwiazdki są w tym menu, w rozmiarze
  dla kciuka. Siatka muzyki jest gęstsza: 5 kart w rzędzie przy 1440 px (było 3), 2 na telefonie.
- Pasek biblioteki na telefonie pokazuje „Odtwórz” zamiast samej ikony.
- Link z filtrem „Hi-res” otwiera się z tym filtrem (wcześniej gubił go, gdy biblioteka miała gatunki albo dekady).

**Następny odcinek**
- Odliczanie widać jako pierścień wokół znaku odtwarzania na kadrze następnego odcinka; karta odcinka wjeżdża,
  propozycje dochodzą po kolei, panel znika wygaszeniem. Zatrzymanie odliczania zatrzymuje i przygasza pierścień.

### Jak to jest zrobione

- **Motyw:** tokeny pod `[data-theme]` w `tokens.css`; `shared/theme.ts`; `public/theme-boot.js` (zwykły skrypt
  z tego samego źródła, wpisywany do HTML przez wtyczkę builda z `?v=<skrót>`) zakłada motyw przed pierwszą
  klatką; preferencja `theme` na koncie (most ją już przechowywał).
- **Ruch:** `shared/motion.ts` + `motion-math.ts` (arytmetyka z testami), `sheet-gestures.ts`, `viewport.ts`;
  animowane są tylko `opacity`, `transform` i `clip-path`.
- **Strona startowa:** `pages/home.ts` na `GET ?action=home` (kontrakt v1.2 z półkami losowymi),
  `shared/home-model.ts` z testami, `styles/home.css` (`continue.css` usunięty).
- **PLR-12:** `audio-player.ts` 2862 → 1469 wierszy — rdzeń bez rysowania; `shared/player/`: `contracts.ts`,
  `dock.ts`, `queue-panel.ts`, `visualizer-panel.ts`. Publiczne API odtwarzacza bez zmian. Dok mierzy się sam
  (`--dock-height`) i układa według własnej szerokości (`@container`).
- **LIB-13:** `library-page.ts` 2421 → 1386 wierszy; `pages/library/`: `cards.ts`, `previews.ts`,
  `grid-window.ts`, `filters.ts`, `collection-picker.ts`, `cover-dialog.ts`, `transfers.ts`. Nowy wspólny klocek
  `shared/action-menu.ts` (menu „⋯”).
- **CSS-06 (część):** reguły doku i wizualizacji wróciły z `panels.css` do `player.css`, zakładek sekcji do
  `admin.css`, kart z `pages.css`/`library.css`/`refinements.css` do nowego `cards.css` (`grid-window.css`
  wchłonięty), paska biblioteki z `refinements.css` do `pages.css`. 12 nieużywanych już wpisów słownika usunięto.

### Liczby

| Co | Przed | Po |
|---|---|---|
| Dok na telefonie (390×844) | 167 px zwinięty, 247 px rozwinięty | 71 px (minigracz; pełny odtwarzacz to arkusz) |
| Dok na komputerze (1440×900) | 116 px | 107 px |
| Kolumna tytułu w doku, okno 1440 px | kilka liter | 246 px |
| Kart muzyki w rzędzie, okno 1440 px | 3 | 5 |
| `audio-player.ts` | 2862 wiersze | 1469 (+ 4 moduły) |
| `library-page.ts` | 2421 wierszy | 1386 (+ 7 modułów) |
| Testy `npm run test:ui` | 535 | 583 |

Klatki (Chrome bez okna, ekran 144 Hz — klatka to ok. 7 ms; średnia we wszystkich pomiarach 6,8–8,4 ms):
- arkusz odtwarzacza na telefonach 320–430 px: otwarcie — najdłuższa klatka 14–28 ms, zamknięcie — 7–14 ms;
- przejście między stronami: animacja 290–330 ms, najdłuższa klatka 7–35 ms (jedna spóźniona na „Muzyce”, gdy
  dekodują się okładki); przed animacją stary obraz stoi 40–150 ms — tyle trwa zbudowanie nowej strony
  (najdłużej biblioteki z 48 kartami);
- znacznik zakładek i dialogi: 7–14 ms; panel następnego odcinka: 49–70 ms raz, przy wczytaniu kadrów;
- otwarcie kolejki ma jedną długą klatkę (28–90 ms) na narysowanie 160 wierszy, potem płynnie — przed pierwszą
  falą ten koszt był płacony przy każdej zmianie utworu.

### Czego nie zrobiono — i dlaczego

- **Linia postępu na kartach filmów w bibliotece.** Lista `browse` nie podaje pozycji oglądania (strona startowa
  ma ją z `home`). Prośba do mostu opisana; po stronie frontu to kilkanaście wierszy.
- **CSS-06, reszta.** W `refinements.css` (ok. 690 wierszy) i `panels.css` (ok. 210) zostały reguły części, których
  ta fala nie przebudowywała: nakładka podglądu filmu, panele konta i administracji, edytor okładki. Ich przeniesienie
  zmienia kolejność w warstwie bez żadnej zmiany wyglądu do pokazania — do zrobienia z porównaniem stylów obliczonych,
  gdy któryś z tych ekranów będzie przebudowywany.
- **Font ikon** — bez zmian, decyzja właściciela.
- **Krążek odtwarzania na okładkach utworów pod palcem** — pominięty świadomie: okładka sama odtwarza, a krążek na
  każdej z kilkudziesięciu kart ekranu byłby szumem. Krążek, który jest osobnym przyciskiem (folder, playlista),
  jest widoczny zawsze.

### Sprawdzone

- `npx tsc --noEmit` — czysto; `npm run test:ui` — 583 testów, wszystkie przechodzą; `npm run build`.
- Chrome bez okna na `http://localhost/`, konta tymczasowe: 390×844, 360×740, 430×932, 320×568 (dotyk), 844×390,
  768×1024, 1440×900, 1920×1080; oba motywy; z ograniczonym ruchem i bez. Plany CDP z raportami JSON: test trafienia
  każdej kontrolki doku, arkusza i kart; brak poziomego przewijania; otwarcie, zamknięcie i ściągnięcie arkusza;
  panele kolejki i wizualizacji (modalność, wejście, wyjście); menu „⋯” (klawiatura, Escape, fokus); znacznik grającego
  utworu; panel następnego odcinka (pierścień, zatrzymanie, wybór odcinka); kontrast par tekst/tło w obu motywach.
- Arkusze „przed / po” głównych stron w obu motywach: `scratch\\renders\\stage4\\`.
- Niesprawdzone na prawdziwych urządzeniach (lista w `TESTING.md`, „Czeka na właściciela”): gesty i wcięcia ekranu
  na iPhonie, przejścia stron w Safari, pierścień w pełnym ekranie; tryb zgodny i natywny pełny ekran przy panelu
  następnego odcinka nie były ćwiczone na żywo — ich logika nie była zmieniana.

## 11.11.2026 (11) — Serwer po audycie: listy 5–35× szybsze, strona startowa jednym żądaniem, „ostatnio dodane” naprawdę ostatnio dodane, sprzątanie po starym portalu

### Co się zmieniło dla użytkownika

**Szybkość**
- Wolna lista nie zatrzymuje już reszty aplikacji. Jedna przeglądarka czekała w kolejce na blokadę pliku sesji:
  `session` wysłane 150 ms po ciężkim `browse` trwało 4,1 s — teraz 30–47 ms (B-01).
- Lista biblioteki: 411 → 70 ms (muzyka) i 773 → 59 ms (filmy); sto folderów na stronę 1006 → 82 ms
  i 1436 → 91 ms; kolejność „najczęściej odtwarzane” 3190 → 95 ms i 3445 → 89 ms, „najlepiej oceniane”
  725 → 56 ms (B-02, B-03; pomiar tą samą sondą co w audycie, na `http://localhost/`).
- Wyszukiwanie czyta gotową kolumnę zamiast składać tekst z tagów w każdym wierszu, a opcje filtrów są
  pamiętane do następnego skanu (224 ms → 0,6 ms przy kolejnym wejściu) (B-08). Listy inteligentne na półce
  liczą się jednym przejściem zamiast dwoma na listę (B-06, B-07).
- Okładki z bazy przeglądarka może trzymać godzinę, a przekierowanie do miniatury — 13 minut (B-04, B-05).
  **Zadziała po zmianie jednej linii w konfiguracji Apache** (niżej): dziś Apache dokłada drugi nagłówek
  `no-store`.

**Strona startowa (nowe dane, strona — w części frontendowej)**
- `GET ?action=home`: kontynuacja filmów i muzyki z postępem, następne odcinki, ostatnio dodane (album i sezon
  jako jedna karta), polecane z powodem („bo lubisz …”), popularne w domu i „Zaskocz mnie” (album + film,
  losowane ziarnem). Jedno żądanie, 60 ms dla nowego konta. Propozycję można odrzucić („Nie proponuj”,
  `home_dismiss`) i cofnąć. Kontrakt: `scratchpad/agents/stage4/home-contract.md` (v1.1).
- „Ostatnio dodane”, „najnowsze” w listach inteligentnych i przegląd nowości liczą od chwili, w której plik
  **pierwszy raz** trafił do katalogu. Dotąd brały `indexed_at`, które każdy skan przepisywał: „nowe w 7 dni”
  oznaczało całą bibliotekę, 20 367 pozycji (C-01). Plik przemianowany albo przeniesiony zachowuje swoją datę.

**Biblioteka i odtwarzanie**
- Po filmie z serialu propozycje idą po kolei: dalsze odcinki rosnąco, potem wcześniejsze (było: E05, E03, E04…)
  (VID-13). Foldery filmów pokazują swoje oceny (C-07). Dwa foldery różniące się tylko akcentem albo wielkością
  liter (`Cafe` / `Café`) nie mieszają już plików — w liście, kolejce, archiwum, okładkach i linku gościnnym.
- Drugie źródło tego samego rodzaju i źródło mieszane da się otworzyć z góry biblioteki (C-08).
- Zajęta nazwa playlisty mówi „Masz już playlistę o tej nazwie. Wybierz inną nazwę.” (ACC-03). Szczegóły
  techniczne pliku w playliście są te same co w bibliotece (C-02). Import ocen nie kasuje ulubionych,
  a import ulubionych — ocen (C-03); decyzja o latach dla folderu nie rusza gatunków (C-04).
- Archiwum ZIP nie przepada, gdy jednego pliku nie ma już na dysku: plik jest pomijany, a w archiwum leży
  `_BRAKUJACE-PLIKI.txt` (T-02). Krótkie filmy i pliki `.vob` dostają miniaturę (T-08). Puste napisy obrazkowe
  nie kręcą się w nieskończoność (T-03). *(Te trzy — po restarcie usługi transferowej.)*

**Konto i bezpieczeństwo**
- Limit prób logowania liczy konto, nie pisownię: `ádmin`, `àdmin` i `admin` to dla bazy to samo konto i teraz
  jeden licznik (S-01). Zmiana hasła w „Moim koncie” ma limit błędnych prób — 12 złych haseł dawało 12 × 422,
  teraz od jedenastego 429 (S-04). Adresy IPv6 liczone są siecią `/64` (S-06).
- Administrator nie zdejmie sobie 2FA ani nie zmieni własnego hasła i roli „bokiem”, przez panel użytkowników;
  sesje superadministratora zamyka tylko superadministrator (S-03, S-11, S-12).
- Przepustka z wyzwania działa tylko dla dostawcy, który ją wystawił (S-02). Rejestracja bez aktywacji mówi
  wprost, że adres jest zajęty, zamiast udawać sukces; awaria poczty nie kończy rejestracji błędem 500;
  o zmianie adresu dowiaduje się też stary adres (S-08, S-14). Niedostępny dostawca wyzwań to czytelne 503 (S-13).
- Kolory interfejsu („Estoril Blue”) zapisują się z kontem: `preferences.theme` (`emerald` | `blue`).
- Czasy w odpowiedziach mają bliźniaka `…_iso` z przesunięciem, więc „wygasa za 2 godziny” nie zależy od strefy
  przeglądarki (ACC-09). Zakładka „Indeksowanie” ma własną małą odpowiedź (`admin_indexing_status`, ADM-06).

**Porządki**
- Import ze starego portalu usunięty zgodnie z decyzją właściciela: kolumna `legacy_checksum`, tabele
  `legacy_import_runs` i `legacy_import_orphans`, status `legacy`, przejściowe czytanie tokenów sprzed 08.11
  i miniatur po samej nazwie pliku (D-02). Zrzut bazy sprzed migracji:
  `C:\wamp64\backups\media-server-20261111-pre-stage4.sql`.
- `media-server cache-prune` pokazuje — a z `--apply` usuwa — wpisy cache, o które nie zapyta już żaden plik
  (T-09). Kolejka metadanych sama usuwa odczyty starsze niż 30 dni (D-01). Importy playlist mają limit otwartych
  i termin (C-05).

### Jak to jest zrobione

- **Most (PHP)**: sesja zamykana do zapisu zaraz po uwierzytelnieniu i kroku w górę, otwierana tylko dla
  przeglądarki z ciasteczkiem (S-09). Sumy folderów jednym rekurencyjnym CTE zamiast podzapytania na folder;
  poddrzewo to `LIKE 'folder/%'` po indeksie `(root_id, relative_path)` plus drugie porównanie
  `COLLATE utf8mb4_bin` (EXPLAIN: `range`). `search_text` — kolumna generowana (migracja 053); `bridge_cache` na
  odpowiedzi takie same dla wszystkich. Sześć sond `information_schema` (91 miejsc) usuniętych (B-09).
  Nowe: `HomeShelves.php`, `BridgeTime.php`; `PermissionGroups::opensSource`, `LegacyIdentity::isOperator()`,
  `LibraryBrowser::publicItem` zamiast kopii (Q-02); pamięć uprawnień per konto (jedno konto dostawało prawa
  poprzedniego w tym samym żądaniu — znalezione testami).
- **Migracje 049–053** (wszystkie zastosowane na `media_server_stage` jako root): `created_at` z odtworzeniem dat
  z historii skanów, `home_dismissals`, klucze `audit_log` (D-03), usunięcie legacy, `search_text` + `bridge_cache`.
- **Usługa i polecenia (Python)**: `mediatypes.py` — jedna tabela rozszerzeń i typów MIME (T-07, T-08);
  miniatura szuka klatki w 120., 12., 1. i 0. sekundzie, a jej nazwa zawiera rozmiar i czas pliku (stare
  miniatury zostają ważne); osobna kolejka wysyłki miniatur i sufit odtwarzań na konto (T-01); `Range` z tysiącami
  cyfr to 416/206 zamiast 500 (T-05); dziennik statystyk nie obchodzi miliona plików co pół godziny i nie czyta
  całego siebie co minutę (T-04); logi workerów pod właściwą nazwą (T-06); nazwy cache Filmwebu po skrócie —
  tytuły cyrylicą nie dzielą już jednego pliku (T-10); `check --database`/`migrate` bez bazy to jedna linia, nie
  traceback (T-11); blokady konwersji napisów znikają po użyciu, WebVTT ma sufit w trakcie czytania (T-12);
  prywatna konfiguracja instalatora powstaje już zamknięta (T-13); jedno `connect_rows`, jedno `resolve_item`
  (T-14). Martwy kod: `application_factory`, `cached/store_subtitle_webvtt`, `parse_frames`, `poster_path`.
- **Testy mostu na MySQL** (Q-01): `tests/bridge_harness.py` — baza `media_server_test`, prawdziwy skaner,
  klasy PHP w podprocesie, `bridge.php` za `php -S`. Reguła odcinka w PHP i w Pythonie dostaje te same nazwy
  (`test_episode_rules_agree.py`).

### Liczby

| co | przed | po |
|---|---|---|
| `session` 150 ms po ciężkim `browse` | 4098 ms | 30–47 ms |
| `browse` muzyka / filmy (48 folderów) | 411 / 773 ms | 70 / 59 ms |
| `browse` 100 folderów | 1006 / 1436 ms | 82 / 91 ms |
| kolejność wg odtworzeń | 3190 / 3445 ms | 95 / 89 ms |
| kolejność wg ocen (muzyka) | 725 ms | 56 ms |
| lista inteligentna „ulubione” (liczniki + okładki) | 58 + 154 ms | cała półka konta 7,5 ms |
| opcje filtrów filmów | 224 ms | 110 ms, potem 0,6 ms |
| stare `continue` (konto właściciela, w PHP) | 75 ms | 46 ms |
| nowa strona startowa, całość (to samo konto, w PHP) | — | 68 ms |
| testy `pytest` | 583 | 711 (15 pominiętych) |

### Czego nie zrobiono — i dlaczego

- **Limit pobrań grupy nadal liczy pobrania, nie pliki** (C-09): opisane w kodzie i w `ARCHITECTURE.md` jako
  decyzja — liczenie plików karałoby pobranie albumu jak sto kliknięć.
- **„Wyślij przegląd teraz” nie poszło do workera** (C-12): żądanie wysyła najwyżej 20 s i mówi, ilu kont nie
  zdążyło (`deferred`); pełny przebieg należy do harmonogramu.
- **Czas odpowiedzi ponownej wysyłki linku jest wyrównany (1,2 s), nie odłożony** (S-08): pod modułem PHP
  Apache nie ma jak odpowiedzieć i wysłać potem.
- **Puste napisy obrazkowe odpowiadają 422, nie 204** (T-03): dzisiejszy odtwarzacz kończy odpytywanie na każdej
  odpowiedzi innej niż OK, a 204 próbowałby czytać jako JSON.
- **Sprzątanie cache nie ma limitu rozmiaru** (T-09): usuwa tylko to, co na pewno jest niczyje; domyślnie sam
  raport i nie jest częścią zwykłego przebiegu okresowego.
- **Nazwy klas `LegacySessionBridge` / `LegacyIdentity` zostały**: to most sesji, nie dane starego portalu.
- **`FRONTEND.md`** zostawiony części frontendowej (opisała już `_iso` i `admin_indexing_status`).

### Do zrobienia przez właściciela

1. **Apache**: `C:\wamp64\alias\media-next-stage.conf`, linia 107 —
   `Header always set Cache-Control "no-store"` → `Header always set Cache-Control "no-store" "expr=-z %{resp:Cache-Control}"`,
   potem przeładowanie. (Wariant `setifempty` z pierwszej wersji przykładów odrzucony po pomiarze: myli się
   przy FastCGI i zostawia odmowy Apache bez nagłówka.)
2. **Restart usługi transferowej** — dopiero wtedy działają zmiany w Pythonie (lista w `TESTING.md`).
   Polecenia i zadanie okresowe biorą nowy kod od razu.
3. **`cache-prune --apply`** — decyzja. Raport z 11.11: 5380 z 11 832 miniatur (74 MB), 132 pliki WebVTT,
   4362 odpowiedzi Filmwebu, 0 napisów obrazkowych.
4. **`ServerTokens Prod`, `ServerSignature Off`, `expose_php = Off`** w `httpd.conf` / `php.ini` (S-15) —
   serwer nadal przedstawia się wersjami Apache, OpenSSL i PHP.

### Sprawdzone

`pytest` 711 przechodzi / 15 pominiętych, `ruff` czysty, `php -l` na każdym zmienionym pliku. Testy mostu na
MySQL: 98 (trasy, biblioteka, kolekcje, konta, udostępnianie, strona startowa; skaner i sprzątanie cache).
Na żywo (`http://localhost/`, konto tymczasowe `tmps4bprobe1`, skasowane z wierszami): sonda audytu przed i po,
`home` (wszystkie półki, pojedyncza półka, losowanie ziarnem, odmowy 422), `home_dismiss`, `_iso` w `sessions`,
`admin_indexing_status` → 403 dla zwykłego konta, limit `account_password` (10 × 422, potem 429), motyw.
Dyrektywa Apache — na osobnym `httpd.exe` (ten sam Apache 2.4.65 i moduł PHP 8.4.15, własny port): trzy warianty,
moduł PHP i CGI, odpowiedzi 200/302/422/403. `cache-prune` na prawdziwych cache tylko jako raport.
Nie sprawdzone: zmiany w usłudze transferowej na żywo (działa stary proces — tylko testy), Debian, PHP-FPM
z prawdziwym PHP (CGI jako odpowiednik tej samej tabeli nagłówków), przeglądarka na żywym Apache po zmianie linii.

**Dopisane tego samego wieczoru:**
- **Półki losowe do szybkiego puszczenia czegokolwiek** (kontrakt v1.2): „Losowe filmy” (filmy od 40 minut,
  nie odcinki), „Losowe seriale” (jedna karta na serial z odcinkiem, od którego to konto by zaczęło: pierwszy,
  przerwany — z pozycją, następny po obejrzanym albo, po całości, znów pierwszy) i „Losowe utwory” (od minuty do
  dziesięciu, w kolejności do odtworzenia). W `home.shelves` jako `random_films`, `random_series`,
  `random_tracks`, każda z `seed`; `GET ?action=home&shelf=random_films&seed=<nowe>` losuje jedną półkę od nowa,
  to samo ziarno daje te same karty, a bez ziarna obowiązuje ziarno konta na dany dzień (powrót na stronę nie
  tasuje). Prawa do bibliotek i odrzucone propozycje działają jak na pozostałych półkach; konto gościa dostaje
  wszystkie trzy.


## 11.11.2026 (10) — Frontend po audycie: poprawki z całej listy, kolory w tokenach, lżejsze pierwsze wejście

### Co się zmieniło dla użytkownika

**Nawigacja i sesja**
- Link do miejsca w aplikacji otwarty bez sesji prowadzi do logowania i z powrotem dokładnie tam — z parametrami
  i fragmentem `#…` (NAV-01). Gdy serwer nie odpowiada, zamiast pętli przekierowań jest ekran „Serwer nie odpowiada /
  Brak połączenia z serwerem” z ponowieniem i samoczynnym odświeżeniem po powrocie sieci (NAV-02).
- „Wstecz” i „Dalej” chodzą po folderach i playlistach biblioteki bez przeładowania strony (NAV-03); kotwice
  z polskimi znakami działają (NAV-04); odświeżenie po nowym buildzie nie zapętla się bez `sessionStorage` (NAV-05).
- Strona zaczyna się od „Przejdź do treści”, a po przejściu między stronami fokus dostaje nagłówek (NAV-07).

**Biblioteka**
- Otwarcie „Muzyki” niczego nie buduje i nie pokazuje doku, jeśli słuchacz nie miał kolejki — wraca tylko to, co
  było (LIB-01, decyzja właściciela). Kolekcje i lista folderu przychodzą razem (LIB-02), pasek filtrów nie spycha
  siatki — jego miejsce jest trzymane od pierwszej klatki (LIB-03), a nowe miejsce pokazuje szkielet kart; błąd ma
  „Spróbuj ponownie” (LIB-15).
- Ocena to jeden suwak obsługiwany palcem, myszą i klawiaturą (strzałki, cyfry, Enter, Escape) zamiast dziesięciu
  wąskich przycisków: jedna pozycja Tab na kartę (LIB-04, LIB-16). Karty nie odtwarzają animacji wejścia po każdej
  literze w wyszukiwarce (LIB-05). Bez rozmycia plakatów i bez `will-change` na każdej karcie (LIB-06, LIB-07).
- Telefon: pasek to jeden rząd — kolejność, filtry, odtwarzanie i „⋯” z resztą; pierwsza karta zaczyna się na
  324 px zamiast na 474 px (LIB-08). Okruszki zaczynają się od „Muzyka”/„Filmy”, a nie od nazwy katalogu na dysku
  (LIB-11); etykiety ocen („utworu” przy filmach), dekady („1990s”) i liczby wyników są przetłumaczone (LIB-12). Pokaz slajdów nie przełącza się pod
  otwartym dialogiem (LIB-14).

**Wideo**
- Panel „Za chwilę następny odcinek”: mieści się w ramce filmu, nagłówek z odliczaniem i „Zamknij” są zawsze
  widoczne (na telefonie zaczynały się 159 px nad krawędzią), następny odcinek jest osobną kartą nad propozycjami,
  miniatury nie są przycinane, brak miniatury ma ikonę (VID-01, VID-02, VID-05, VID-12). Panel pokazuje się też
  wtedy, gdy film grał w natywnym pełnym ekranie (VID-03), a kolejny odcinek zostaje w pełnym ekranie (VID-04).
  Odliczanie jest czytane przez czytnik ekranu, fokus trafia na następny odcinek (VID-07).
- Tytuł z nazwy pliku ma najwyżej dwie linie (VID-09); „MKV”/„MP4”/„TS” zamiast „matroska,webm” (VID-10);
  uszkodzona zapisana głośność nie psuje odtwarzacza (VID-11); komunikaty to powiadomienia, nie `alert` (ACC-08).

**Odtwarzacz**
- Ekran blokady, zegarek i klawisze multimedialne dostają okładkę, pozycję i przewijanie (PLR-05).
- Pasek wizualizacji na telefonie jest wyśrodkowany (PLR-01); dymek nie zostaje po dotknięciu (PLR-03) i jest
  widoczny w pełnym ekranie (PLR-04); panel wizualizacji i kolejka są prawdziwymi dialogami (PLR-14); teksty nie
  mniejsze niż 11,5 px (PLR-09); cele dotyku 44 px bez podnoszenia doku (PLR-08); „PPM” nie jest reklamowane na
  dotyku (PLR-10); tło doku działa w Safari przed 18 (PLR-07).
- Poza listą audytu: w oknie 1409–1890 px przycisk głośności leżał na „powtarzaniu” (naciśnięcie środka „powtarzania”
  wyciszało). Prawa kolumna doku jest teraz co najmniej tak szeroka jak jej zawartość.

**Konto, kolekcje, administracja**
- Karty kolekcji w „Moje konto” pokazują pełną nazwę (na telefonie było „Do bi…”), działania są w drugim rzędzie
  (ACC-01, ACC-02). Odmowa serwera jest pokazywana jego słowami — np. „Masz już playlistę o tej nazwie” zamiast
  „Migracja bazy może jeszcze oczekiwać” (ACC-03, z częścią serwerową). Cudzy profil nie mówi „Twoje” (ACC-04);
  ścieżka `logs/mail` jest pokazywana tylko administratorom (ACC-05); gatunki są pobierane dopiero przy potrzebie (ACC-06).
- Potwierdzenia i komunikaty to dialogi aplikacji, a ponowne wysłanie linku aktywacyjnego to pole na stronie
  logowania, nie `window.prompt` (ACC-08). Daty i godziny mają jeden format i są chwilami, nie napisami: strona
  czyta z mostu pola `*_iso` i pokazuje je w strefie przeglądarki — ta sama sesja to 21:56 w Warszawie i 15:56
  w Nowym Jorku (ACC-09, z częścią serwerową).
  Wyszukiwarka profili działa z klawiatury (ACC-10). Zakładki sekcji mają etykiety także na telefonie (ACC-11).
- Panel: grupy uprawnień nie rozpychają telefonu do 438 px (ADM-01), kafle po dwa w rzędzie (ADM-02), zaokrąglone
  rogi znaczków i przycisku wyboru pliku (ADM-03), nazwy źródeł i stany skanów po polsku/angielsku (ADM-07), wykres bez `innerHTML` (SEC-02).
  Sekcja „Indeksowanie” odświeża co 4 s małą odpowiedź `admin_indexing_status` zamiast całego panelu (ADM-06,
  z częścią serwerową; most, który jej nie zna, dostaje pytanie o cały panel jak dotąd).

**Telefon i PWA**
- Schowane menu boczne jest niedostępne dla klawiatury i czytnika, otwarte przejmuje fokus (MOB-01); wcięcia ekranu
  (`viewport-fit=cover`, `--safe-*`) w pasku, doku, panelach i dialogach (MOB-02); pola 16 px, więc iOS nie przybliża
  strony (MOB-03); przyciski, pola i pola wyboru mają pod palcem co najmniej 44 px (MOB-04); ikona maskowalna jest
  pełnym kaflem, bez ostrzeżenia o przestarzałym znaczniku (MOB-05); pamięć trybu offline czyści się po nowym buildzie
  (MOB-06). Service worker nie przechwytuje już pobierania plików, gdy aplikacja stoi w korzeniu hosta.

**Język**
- Strona gościa bierze język przeglądarki, tak jak logowanie (I18N-01); przetłumaczone zdanie w wyborze okładki (I18N-02);
  komunikat błędu logowania przerywa, a nie czeka w kolejce czytnika (I18N-04).

### Jak to jest zrobione

- **Kolory (CSS-01, CSS-03, CSS-04).** Każdy kolor jest tokenem w `styles/tokens.css`; pozostałe arkusze nie mają
  literałów (było 168), przezroczystości powstają z trójek `--color-*-rgb`. Porównanie liczbowe 177 literałów
  z tokenami: 131 identycznych, reszta w granicach 3,5/255, poza połączeniami wskazanymi w projekcie (trzy odcienie
  obramowania akcentu w jeden, Δ ≤ 20 na liniach 1 px). Podniesiony kontrast: obramowanie pól `#56697f`, tekst
  pomocniczy `#8493a5`. Bez „Inter” na początku listy fontów (CSS-07); niezdefiniowane zmienne i martwe reguły
  usunięte (CSS-05, PLR-06); dopisane brakujące reguły: `.eyebrow`, `.field__hint`, `.viewer__loading`, okno linku
  gościa, stopka strony gościa (CSS-02).
- **Arkusze (CSS-09, CSS-06 częściowo).** `index.css` zastąpiły `core.css` (każda strona) i `app.css` (aplikacja);
  reguły logowania, strony gościa, 2FA i widżetu anty-bot przeniesione bez zmian do `public.css`. Każdy plik ma
  jeden blok `@layer pages` — zbudowany CSS jest identyczny co do bajta z poprzednim.
- **Pierwsze wejście (NAV-06, PLR-13, I18N-03, CSS-08 częściowo).** Wejścia HTML nazywają skrypt strony, więc
  wszystkie chunki są w HTML; wizualizacje (`visualizations/kit.ts`) i angielski słownik (`i18n-en.ts`) to osobne
  chunki pobierane na żądanie; font ikon jest proszony od startu skryptu.
- **Wspólne moduły.** Nowe: `confirm.ts`, `toast.ts`, `datetime.ts`, `random-id.ts` (zamiast `crypto.randomUUID`,
  którego nie ma po HTTP — ACC-07), `rating-steps.ts`, `media-labels.ts`, `media-session.ts`, `library-labels.ts`,
  `visualizations/kit.ts`, `i18n-en.ts`. Przepisane: `tooltips.ts`, `rating.ts`, `section-tabs.ts` (jedna
  implementacja zakładek — ADM-04, ADM-05), `public/sw.js`. `api.ts`: `failureText`, `isAborted`, `signal`
  w listowaniu (CODE-07), `getIndexingStatus`. `modal.ts`: `data-modal-exempt`, dialog otwarty nad innym panelem
  modalnym (był `inert`), powrót fokusu (CODE-06). `datetime.ts`: `adoptIsoTimes()` — w jednym miejscu, gdzie
  przychodzą odpowiedzi mostu, wartość `x_iso` trafia pod nazwę `x`.
- **Porządki (CODE-01…13, deadcode).** Usunięte `media-page.ts`, `showQueue()`, `MetadataEditor.destroy()`,
  `CAPTCHA_PROVIDERS`, `PendingImport`, `IconPack`, zbędne eksporty i importy CSS; wyścigi w wyborze okładki,
  stronie gościa i logowaniu; częściowy zapis metadanych (tagi zapisane, okładka nie) zgłaszany osobno.

### Liczby

| Co | Przed | Po |
| --- | --- | --- |
| JS pierwszego wejścia, strony aplikacji | 353–437 kB (116–141 kB gzip), odkrywane w kolejnych falach | 201–319 kB (67–101 kB gzip; start 245 kB / 79 kB), wszystko nazwane w HTML |
| Logowanie: JS / CSS | 138 kB / 125 kB | 46 kB / 23 kB |
| Strona gościa: JS / CSS | 104 kB / 125 kB | 11 kB / 23 kB |
| Logowanie: pierwsze malowanie (łącze 60 ms, 10 Mbit/s, zimna pamięć; „przed” = stan po NAV-06 i PLR-13) | 516 ms | 388 ms |
| Strona startowa: pierwsze malowanie / font ikon gotowy (to samo łącze) | 816 ms / 964 ms | 744 ms / 761 ms |
| „Muzyka” na telefonie: góra pierwszej karty | 474 px | 324 px |
| Zwinięty dok na telefonie | 165 px | 167 px (większy tekst linii „odtwarzane z”) |
| Pozycje Tab w siatce 52 pozycji | 239 | 212 |
| Warstwy `will-change` w siatce | 48 | 0 |
| Panel następnego odcinka (telefon): początek nagłówka | −159 px | 0 px |
| Administracja → Grupy na telefonie: szerokość strony | 438 px | 390 px |

### Czego nie zrobiono — i dlaczego

- **CSS-08, przycięcie fontu ikon (116 kB dla 58 ikon; fonty Pro 380–600 kB).** Fonty Font Awesome 7 są w formacie
  CFF: przycięcie wymaga narzędzia, czyli nowej zależności buildu, a „Font Awesome” jest nazwą zastrzeżoną licencji
  OFL — przycięty font musiałby zmienić nazwę. Do decyzji właściciela (opisane w `FRONTEND.md`, „Ikony”).
- **PLR-12, LIB-13, podział `audio-player.ts` i `library-page.ts`.** Zrobione: stała spomiędzy importów, wydzielone
  `media-session.ts` i `library-labels.ts` (z testami). Sam podział zostaje na przebieg, który przebudowuje dok,
  karty i panele (fala B) — granice modułów wyznaczy nowy projekt.
- **CSS-06, wchłonięcie `refinements.css` i `panels.css` w pliki komponentów.** Zrobione: jeden blok warstwy na
  plik, usunięte duplikaty i nieaktualne odwołania. Przeniesienie kilkuset reguł zmienia ich kolejność w warstwie,
  a tego nie da się dowieść bez porównania stylów obliczonych wszystkich stanów — razem z falą B.
- Pominięte jako nietrafione: `PickerHeading` i `PickerOption` nie są martwe (używa ich `list-picker.ts`
  i `preset-search.ts`); 23 literały koloru w `voltviz/stage.css` zostają (lustro klas wizualizatora).

### Sprawdzone

- `npx tsc --noEmit` — bez błędów; `npm run test:ui` — 535 testów (było 494), wszystkie przechodzą.
- Chrome bez okna na `http://localhost/`, konta tymczasowe, 390×844 (dotyk), 768×1024, 1440×900: zrzuty przed
  i po każdej poprawce układu, pomiary w raportach JSON; zachowania (historia folderów, suwak oceny bez wysłania
  oceny, dialog potwierdzenia, menu boczne, link bez sesji, powiadomienie po nieudanym pobraniu, test trafienia
  każdego przycisku doku) sprawdzone krokami CDP. Sesja angielska: interfejs po angielsku od pierwszej klatki,
  słownik pobierany tylko wtedy; sesja polska go nie pobiera. Czas: przeglądarka przestawiona o sześć stref.
- Logowanie i strona gościa z samym `core.css`: styl obliczony wszystkich elementów taki sam jak z arkuszami
  aplikacji (różni się tylko niewidoczny pasek postępu nawigacji).
- Niesprawdzone na prawdziwych urządzeniach: wcięcia ekranu i ekran blokady na iOS, natywny pełny ekran `<video>`
  na iPhonie, rejestracja service workera (przeglądarka testowa go nie rejestruje — są testy w Node).

**Najpierw (P0, SEC-01): przekierowanie na obcą stronę po zalogowaniu.** `/login/?next=/\host` przechodziło sprawdzenie
(„zaczyna się od bazy aplikacji, nie od //”), a przeglądarka czyta `\` jak `/` — `//host`, czyli inny serwer; audytor zrobił to
na żywo. `shared/landing.ts` rozwiązuje `next` tak jak przeglądarka i przyjmuje tylko ten sam origin, ścieżkę pod bazą i nie
stronę logowania (test `landing.test.ts`: `/\host`, `//host`, `https://…`, `javascript:` i in.).

## 11.11.2026 (9) — „Internal”: dziesięć wizualizacji Fable w WebGL 2 (40 presetów), własny obraz lub wideo zamiast okładki

> Szkic wpisu do `docs/CHANGELOG.md`.

### Co się zmieniło dla słuchacza

- W „Internal” pod szesnastoma dotychczasowymi wizualizacjami jest dziesięć nowych, każda z nagłówkiem i czterema
  presetami: **Płynny jedwab**, **Zorza nad jeziorem**, **Mgławica miliona iskier**, **Kryształowa katedra**,
  **Ocean światła**, **Oddychające ściany**, **Spirala Droste**, **Żywe wzory**, **Fraktalne płomienie**,
  **Tunel hiperprzestrzeni**. Auto, ulubione, blokada, „›” i wyszukiwarka presetów działają na nich jak na pozostałych.
- Pięć ostatnich pracuje na obrazie: domyślnie na okładce utworu, a po kliknięciu „Wybierz obraz lub wideo”
  (prawy dolny róg, wygląd jak w VoltViz) — na pliku słuchacza. Plik zostaje w przeglądarce: nie jest wysyłany ani
  zapisywany. „Wróć do okładki” przywraca okładkę. Bez okładki i bez pliku rysują własny obraz zastępczy.
- Przejście między dwoma nowymi presetami to płynne mieszanie obu obrazów (1,2 s); przejście z i do wizualizacji 2D —
  przenikanie jak dotąd.
- Presety pracujące na obrazie działają domyślnie w trybie łagodnym (bez pulsowania jasności w rytm stopy); przy
  systemowym „ogranicz ruch” — wszystkie.
- Nazwy są po polsku i po angielsku (jeden blok w `i18n.ts`).

### Jak to jest zrobione

- Nowy katalog `frontend/src/shared/visualizations/fable/`: lista (`catalog.ts`), host z jednym płótnem i kontekstem
  WebGL 2 (`host.ts`), przycisk obrazu (`overlay.ts`, `stage.css`), rdzeń (`core/`: warstwa WebGL, analiza dźwięku,
  post-processing HDR z regulatorem luminancji, obraz źródłowy, adaptacyjna rozdzielczość) i dziesięć wizualizacji
  (`vis/`), każda w osobnym kawałku builda pobieranym przy pierwszym pokazaniu.
- `internal.ts`: warstwa stołu jest teraz albo płótnem 2D, albo wspólnym płótnem Fable; lista i katalog wyszukiwania
  powstają z jednej funkcji (`internalPresetGroups`), więc pokazują to samo; presety Fable są oferowane tylko tam,
  gdzie przeglądarka potrafi je narysować (`fable/support.ts`).
- Dźwięk: własny `AnalyserNode` hosta — `fftSize` 2048, wygładzanie 0,5, zakres −90…−10 dB (domyślny −100…−30 dB
  obcina bas głośnych nagrań i stopy nie widać), czytany jak w „Internal” na urządzeniach szybszych niż 48 kHz.
- Kompilacja shaderów w tle (`KHR_parallel_shader_compile`): preset wchodzi na ekran dopiero gotowy, a dotychczasowy
  obraz gra dalej.
- Programy o kilku wyjściach są rozkładane na jeden program na wyjście. Zmierzone: ANGLE na Direct3D kompilował taki
  program drugi raz w wątku GPU przy pierwszym rysowaniu i obraz strony stał 0,15–0,9 s przy każdym starcie Zorzy,
  Mgławicy, Oddychających ścian i Żywych wzorów. Po zmianie najdłuższa przerwa między klatkami przy przełączaniu
  Fable→Fable to 7 ms. Koszt: Mgławica 1,73 → 2,58 ms GPU na klatkę w 1080p, pozostałe o 0,0–0,3 ms więcej.
- Rozdzielczość robocza dopasowuje się do czasu klatki (czas GPU tam, gdzie przeglądarka go podaje).

### Poprawione przy okazji

- Przenikanie w „Internal”: warunek zakończenia przenikania był spełniony już w pierwszej klatce wchodzącej warstwy
  (`time - 0 >= FADE_MS`), więc — z lektury kodu — wizualizacja wchodziła cięciem, nie przenikaniem. Teraz warstwa
  jest rysowana raz niewidoczna, potem narasta 1,2 s i dopiero wtedy poprzednia znika (zmierzone w połowie przejścia
  2D→2D: `opacity` 0,33). Do potwierdzenia na żywej aplikacji.

### Sprawdzone

- `npx tsc --noEmit` — bez błędów; `npm run test:ui` — 491 testów, wszystkie przechodzą (w tym nowe:
  `fable/catalog.test.ts`, `fable/core/adaptive.test.ts`, `fable/core/audio.test.ts`).
- Prywatny build Vite do katalogu w `scratch/` (nie do builda produkcyjnego): przechodzi; kawałki `internal` 27,7 kB,
  `host` 24,0 kB (9,6 kB gzip), wizualizacje 11,7–31,0 kB każda (4,5–11,8 kB gzip).
- „Internal” utworzony przez swoją wtyczkę na pustej stronie, w prywatnym Chrome bez okna na GPU, z prawdziwym utworem
  (`scratch/fable-vis/tools/check.mjs`): 56 presetów w 11 grupach, katalog wyszukiwania identyczny z listą; przejścia
  2D→Fable, Fable→Fable, Fable→2D i 2D→2D; okładka z Media Session; własny obraz, własne wideo, odmowa nieczytelnego
  pliku, powrót do okładki; „›” z ostatniej wizualizacji 2D do pierwszego presetu Fable; siedem rozdań Auto; każda z
  dziesięciu wizualizacji startuje i rysuje; po `destroy()` nie zostaje żadne płótno. Zrzuty:
  `scratch/renders/fable-vis/integration/`.

### Nie sprawdzone

- Żywa aplikacja (panel, ulubione, blokada, wyszukiwarka) — to robi koordynator po buildzie.
- Prawdziwy telefon, Firefox, Safari, przeglądarki bez `KHR_parallel_shader_compile`, urządzenie audio szybsze niż
  48 kHz, utrata kontekstu WebGL, okładka z innego pochodzenia bez CORS.
- Kryształowa katedra kompiluje się na zimno ok. 6 s (w tle, bez zatrzymania obrazu) — do skrócenia osobno.

**Na żywo** (build na serwerze, konto tymczasowe, potem skasowane): 56 presetów w Internal, cztery presety Fable
z klatką co 6,9 ms (najgorsza 8 ms, także przy pierwszej kompilacji Kryształowej katedry), ulubione, własny obraz
w Oddychających ścianach, losowy „›” między Fable i 2D.

## 11.11.2026 (8) — Ochrona przed botami i konto: dostawcy wyzwań, proof-of-work, drabina kroku w górę, weryfikacja dwuetapowa

Migracje **046** (`captcha_spent`; klucze osobno dla każdego dostawcy, dotychczasowa para przeniesiona na wybranego
dostawcę, stare wiersze usunięte; „Chroń logowanie” → `captcha_login_mode`: włączone = „zawsze”, wyłączone = „po N
nieudanych”), **047** (`stepup_counters`, `stepup_subjects`) i **048** (`user_two_factor`) — na tej instalacji
zastosowane jako root. Bez nowych zależności (npm, pip). Bez zmian w Pythonie (usługa transferowa bez restartu)
i w aktywnej konfiguracji Apache. Pliki: nowe `integrations/php/ProofOfWork.php`, `StepUpGuard.php`, `Totp.php`,
`TwoFactor.php`; zmiany w `CaptchaGuard.php` (przepisany), `AccountGateway.php`, `BridgeException.php`,
`CatalogActions.php`, `stage/bridge.php`. Front: nowe `shared/pow.ts` (+test), `shared/pow-worker.ts`,
`shared/step-up.ts`, `shared/qr.ts` (+test), `shared/two-factor-ui.ts`; zmiany w `shared/captcha.ts`, `shared/api.ts`,
`shared/types.ts`, `shared/i18n.ts`, `pages/login.ts`, `pages/account.ts`, `pages/admin.ts`, `styles/pages.css`,
`styles/admin.css`, `package.json` (`test:ui`). Testy: `tests/test_php_captcha.py`, `test_php_stepup.py`,
`test_php_totp.py`. Przykłady (nic nie włączone): `deploy/fail2ban/filter.d/tryhackx-media-auth.conf.example`,
`deploy/fail2ban/jail.d/tryhackx-media.conf.example`, `deploy/apache/media-hardening.conf.example`. Dokumentacja:
`INSTALL-DEBIAN.md` („Cloudflare, fail2ban i limity połączeń”), `INSTALL-WINDOWS.md`, `ARCHITECTURE.md` (nowa sekcja
„Ochrona przed botami i konto”), `FRONTEND.md`, `TESTING.md`.

**Dostawcy wyzwań.** Do wyboru w panelu: reCAPTCHA v2, reCAPTCHA v3 (niewidoczna; minimalny wynik w panelu, nazwa
akcji sprawdzana), hCaptcha, Cloudflare Turnstile i własny proof-of-work (schemat ALTCHA: wyzwanie podpisane HMAC
z datą ważności w soli, przeglądarka szuka liczby w workerze, serwer sprawdza podpis, ważność i wynik, a zużyte
wyzwanie pamięta do wygaśnięcia — drugie użycie odrzuca). Każdy dostawca trzyma własne klucze, więc przełączanie
ich nie gubi; sekrety nie wychodzą z serwera. `token()` widżetu jest asynchroniczne (v3 przy wysyłce,
proof-of-work liczy w tle z cichym paskiem postępu). CSP bez zmian: v3 korzysta z tych samych źródeł Google co v2,
proof-of-work to skrypt z własnej domeny.

**Drabina kroku w górę** (egzekwuje most, nie strona). Per konto, skrót adresu i ciasteczko urządzenia, osobno dla:
każdego żądania do mostu, pobrań (pliki i archiwa), strumieni trybu zgodnego, nowych linków gościnnych, rejestracji
i ponownych linków aktywacyjnych; progi w panelu. Ponad progiem wyzwania most odpowiada `428 captcha_required`
(z dostawcą i kluczem publicznym), strona pokazuje okno z wyzwaniem (w aplikacji zawsze proof-of-work, na stronie
logowania wybrany dostawca albo proof-of-work, gdy żadnego nie ma), wymienia rozwiązanie na przepustkę (`captcha_pass`,
w sesji, związana z adresem) i powtarza żądanie sama — jedno miejsce w `api.ts`. Ponad progiem pauzy `429`
z `Retry-After`; kto próbuje dalej, dostaje blokadę czasową. Pauzy, blokady i zdjęcia w dzienniku aktywności, lista
„Ograniczeni i zablokowani” z „Odblokuj” w zakładce Bezpieczeństwo, administratorzy domyślnie zwolnieni.
Po zalogowaniu liczy się samo konto (dom dzieli adres). Logowanie zachowuje swoje limity; wyzwanie przy logowaniu:
zawsze / po N nieudanych (domyślnie 3) / nigdy.

**Weryfikacja dwuetapowa (TOTP, RFC 6238).** „Moje konto” → Bezpieczeństwo: hasło → kod QR (własny koder, bez
usług zewnętrznych), klucz tekstem i link `otpauth://` → pierwszy kod → 10 kodów odzyskiwania pokazanych raz
(przechowywane jako skróty, do wygenerowania na nowo). Wyłączenie hasłem i kodem. Logowanie dwuetapowe z biletem
w sesji między krokami, kod (albo kod odzyskiwania) z limitem jak logowanie, kod raz użyty nie przechodzi drugi raz.
Sekret zaszyfrowany (AES-256-GCM) kluczem pochodnym klucza transferowego z prywatnej konfiguracji. Panel: „Wymagaj od
administratorów” (konfiguracja przy następnym logowaniu, zanim powstanie sesja) i „Zresetuj 2FA” w karcie
użytkownika; wszystko w dzienniku aktywności.

**fail2ban i Apache.** Most pisze `tryhackx-auth event=… action=… client=<16 znaków skrótu>` przy złym haśle, złym
kodzie, nieudanym wyzwaniu, odmowie limitu logowania i blokadzie (adres dopisuje Apache). Przykładowy filtr i jail,
przykład `RequestReadTimeout`/limitów żądań/MPM i nftables (limit połączeń na adres) — do zastosowania ręcznie.
Cloudflare opisany z zastrzeżeniem: warunki planów samoobsługowych nie pozwalają puszczać filmów przez proxy, a dziś
transfery muszą być w tej samej domenie co strona — z proxy trzeba by osobnej nazwy dla transferów i CORS w usłudze
transferowej (niezrobione).

Przy okazji: zakładka Bezpieczeństwo panelu nie rozpycha się już na telefonie (długi przełącznik „Pozwól zwijać
odtwarzacz także na komputerze” miał `nowrap`).

**Sprawdzone:** bramka `check.py --audit` (wynik niżej), testy PHP 17 nowych (wektory RFC 6238 i 4226, proof-of-work:
powtórka/wygaśnięcie/podpis, v3: wynik/akcja przez wstrzyknięty transport, drabina: progi/przepustka/pauza/blokada/
odblokowanie), node: `pow.test.ts`, `qr.test.ts` (macierze zgodne z segno 1.6 dla wersji 1–2 i 4–15 i wszystkich
masek; kody dekodowane zxing). Na żywo (konta tymczasowe `user` i `admin`, potem skasowane razem z wierszami):
proof-of-work i Turnstile (klucze testowe Cloudflare) na stronie logowania; pobrania: 2 przechodzą → okno wyzwania →
przepustka → pauza z `Retry-After` → blokada w całym moście → „Odblokuj” w panelu; logowanie po 2 nieudanych →
proof-of-work → wejście; włączenie 2FA w przeglądarce (kod QR ze zrzutu ekranu odczytany przez zxing), logowanie
dwuetapowe, powtórzony kod odrzucony, kod odzyskiwania raz, wymuszona konfiguracja administratora, reset przez
administratora; widoki na komputerze i telefonie (bez poziomego przewijania). Nie sprawdzone: reCAPTCHA v2/v3
i hCaptcha na żywo (tylko testy z transportem), prawdziwy telefon z aplikacją uwierzytelniającą, fail2ban na
Debianie (filtr sprawdzony wyrażeniem na przykładowych liniach), Cloudflare.

## 11.11.2026 (7) — Szukanie presetów we wszystkich wizualizacjach naraz

Bez migracji i bez nowych zależności. Tylko front: nowe `visualizations/preset-search.ts` (z testem) i
`preset-catalogs.ts`, `geiss/catalog.ts`, `voltviz/listing.ts`, `shaders/listing.ts`; zmiany w `list-picker.ts`,
`list-picker-model.ts` (+test), `audio-player.ts`, `engine.ts`, `types.ts`, wtyczkach i katalogach MilkDropa, AVS,
Geissa, VoltViz, Internal, Klasyki retro, Form dźwięku i Shaderów (`milkdrop-packs.test.ts`, `avs/packs.test.ts`
dopilnowują, że katalog to dokładnie lista wizualizacji), `i18n.ts`, `styles/list-picker.css`, `package.json`.

Pole szukania listy presetów szuka teraz także w każdej innej włączonej wizualizacji: pod własnymi wynikami są
grupy z nazwą wizualizacji (pierwsza „<ta, która gra>: inne paczki” — np. MilkDrop na wbudowanych znajduje
Cream of the Crop), przy każdym wyniku jego paczka. Grupa pokazuje 50 wyników i „Pokaż jeszcze N”; licznik mówi
„12 z 16 900 + 340 w innych”. Wybór przełącza na tamtą wizualizację i uruchamia ją od razu na tym presecie, MilkDrop
i AVS same przechodzą do paczki, która go ma. Katalogi (razem ok. 32 500 presetów) pobierają się dopiero przy
pierwszym znaku, najwyżej 4 naraz; znak kosztuje 3–4 ms (z MilkDropem „Wszystkie paczki” na liście do 8 ms).

**Sprawdzone:** `tsc --noEmit`, `test:ui` (466/466), build. W Chrome bez okna każda z dziewięciu wizualizacji
startowała na wybranym z wyszukiwania presecie; na żywo (konto tymczasowe, potem skasowane): „geiss” w Internal →
MilkDrop z wybranym presetem, „dancer” w MilkDropie na wbudowanych → „MilkDrop: inne paczki” → preset Cream of the
Crop z jego paczką. Nie sprawdzone: prawdziwy czytnik ekranu i klawiatura telefonu.

## 11.11.2026 (6) — Inne urządzenia według sesji; film na telefonie: pełny ekran, dokładne przewijanie, ±10 s; zapas filmu 60 s zamiast 2,4 s

Migracja **045** (`playback_queues.session_hash`) — przed wdrożeniem `media-server migrate` jako konto z prawem
`ALTER`. Bez nowych zależności. Pliki: `integrations/php/CatalogActions.php`, `integrations/php/stage/bridge.php`,
`frontend/src/shared/{audio-player,queue-sync,api,types,media-viewer,icons,i18n}.ts`, nowe
`frontend/src/shared/{stream-buffer,mp4-codecs,seek-gesture}.ts` (z testami `mp4-codecs.test.ts`,
`seek-gesture.test.ts` w `test:ui`), `frontend/src/pages/admin.ts`, `frontend/src/styles/{player,library,video-viewer,icons}.css`,
test `tests/test_php_queue_devices.py`.

**„Przejmij” przy urządzeniach, na których nikt nie jest zalogowany.** Lista „Na innych urządzeniach” w panelu
kolejki brała każdą kolejkę zapisaną w ostatnich 30 dniach, więc telefon wylogowany wczoraj (dwa razy, „Android ·
Chrome” pod dwoma identyfikatorami) był do przejęcia, a „Aktywne sesje” pokazywały tylko komputer. Kolejka pamięta
teraz sesję, która ją zapisała, a lista idzie za sesjami: otwarta — „Na innych urządzeniach” z „Przejmij”;
zamknięta (wylogowanie, „Wyloguj wszystkie oprócz tej”, nowe hasło) — wcale; wygasła sama — przez tydzień w „Ostatnio
na innych urządzeniach” z „Wznów tutaj” i „Zapomnij to urządzenie”, z kilku wierszy o tej samej nazwie najnowszy.

**Film na telefonie (tryb zgodny, czyli prawie każdy MKV).**
- Pełny ekran nie dawał się włączyć: reguła dla wąskich ekranów chowała ostatni przycisk paska — a był nim właśnie
  pełny ekran. Jest; na iPhonie przez odtwarzacz samego wideo, a telefon obraca się do poziomu.
- Pasek postępu dzielił wiersz z przyciskami (ok. 200 px: pół minuty na piksel w dwugodzinnym filmie). Ma teraz własny
  wiersz na całą szerokość, a palec przewija tym dokładniej, im wyżej go unieść nad pasek (×½, ×¼, ×⅒; dymek mówi
  „dokładnie ×¼”).
- Przyciski −10 s / +10 s i dwa stuknięcia w bok obrazu (każde kolejne 10 s więcej, „+30 s” na obrazie).
- Na komputerze: czas pod kursorem nad paskiem, strzałki ±10 s, PageUp/PageDown ±60 s, Home/End (strzałka na pasku
  z krokiem 0,01 s nie ruszała filmu wcale); kilka naciśnięć to jeden restart strumienia.
- W nagłówku podglądu na telefonie „Pobierz” i „Odtwórz oryginał” były pustymi kwadratami (reguła chowała ikony razem
  z napisami) — są ikony z nazwą na przycisku.

**Zapas filmu.** Tryb zgodny wysyła film jako pofragmentowane MP4 na jednej długiej odpowiedzi; Chrome trzymał
z takiego strumienia stale 2,3–2,4 s do przodu (pomiar na komputerze i telefonie), więc każde zwolnienie łącza
zatrzymywało obraz. Strona sama czyta teraz strumień i podaje go przeglądarce przez Media Source, trzymając zapas
z nowego ustawienia w panelu admina („Zapas filmu w trybie zgodnym”, domyślnie 60 s, 0 = jak dawniej). Pliki zostają
bez zmian, nic nie jest konwertowane. Przewinięcie w obrębie zapasu (np. ±10 s) dzieje się od razu, bez nowego
strumienia; pełna pamięć przeglądarki obniża zapas zamiast przerywać; iPhone i strumień, którego kodeków Media Source
nie przyjmie, grają jak dawniej.

**Sprawdzone:** `tsc --noEmit`, `test:ui`, `pytest tests/test_php_queue_devices.py` (7), build. Na żywo (konta
tymczasowe, potem skasowane, liczniki odtworzeń bez zmian):
- trzy przeglądarki jednego konta: zalogowana w „Na innych urządzeniach”, z wygasłą sesją w „Ostatnio…”, „Zapomnij”
  usuwa wiersz, „Wyloguj wszystkie oprócz tej” zabiera z listy;
- film MKV (H.264) na komputerze i emulowanym telefonie 390×844 z dotykiem: układ dwóch wierszy, „+10 s / +20 s” po
  stuknięciach, palec uniesiony o 120 px przesuwa 4 razy wolniej (100 px = 5:40 zamiast 22:40), pełny ekran,
  klawisze (3× → +30 s jednym restartem), czas pod kursorem;
- zapas: 60 s kilka sekund po starcie (wcześniej 2,4 s), +10 s bez nowego strumienia (0,7 s), skok o 3 min z nowym
  i znów 60 s, koniec filmu z „Co dalej”, film HEVC przez Media Source.

## 11.11.2026 (5) — Geiss: własne napisy i kolory fal według muzyki, co do bitu; VoltViz: własny obraz w Halftone Pulse; Cthugha-4-Winamp: tytuł czcionką z komputera

Bez migracji i bez nowych zależności. Tylko front: Geiss (`geiss/sim.ts`, `index.ts`, `overlay.ts`,
`stage.css`, nowe `geiss/messages.ts` i `geiss/title-font.ts`, test `geiss-messages.test.ts`), VoltViz
(`voltviz/overlays.ts`, `index.ts`, `stage.css`, notka „Fork:” w `HalftonePulse.ts`), Klasyka retro
(nowe `retro/cthughalike/local-font.ts` z testem w `cthugha98.test.ts`; port w ignorowanym
`vendor/cthugha/c4w/`: `engine.ts` i nowe `gdi-fonts.ts`), `i18n.ts` (27 tekstów; dwa nieużywane
usunięte), `package.json` (test w `test:ui`).

**Geiss (Winamp) — własne napisy GEISS.INI (`[CUSTOM MESSAGES]`, klawisze `m##`).** Ramka nad obrazem
nazywa się teraz „Presety i napisy” i ma zakładki „Presety” i „Własne napisy”: slot 00–99, treść,
„Zapisz”/„Nadpisz”, lista z „Pokaż”, edycją i koszem (pyta drugi raz). Napisy są w przeglądarce
(`media-visualizer-geiss-messages`), czytane jak wartość GEISS.INI (bez spacji na brzegach,
cudzysłów je zachowuje, do 255 znaków). „Pokaż” robi to, co `m##`: napis zastępuje tytuł od razu, na
21 klatek przy 30 fps, potem wypala się w obraz i rozpływa z mapą — w kolorze ostatniego tytułu;
nawet średnik po `if (LoadCustomMsg(…));` (brakujący napis też „się pokazuje”) i ciche powroty tytułu
po napisie są jak w oryginale. Na liście presetów panelu napisów nie ma: to chwilowe zdarzenie, nie
coś, co jest na ekranie.

**Tytuł i napisy jak rysował je GDI.** Wtyczka dostawała od GDI Arial Bold (komórka 24 px, 20 px na
em, linia bazowa 19), a przy obrazie szerokim na 320 — czcionkę DC, SYSTEM_FONT; tekst, cień i ich
kolory (przy 8 bitach najbliższe w palecie, pierwszy z równych), pozycja z `GetTextExtentPoint()`,
wypalenie (przy 8 bitach każdy piksel prostokąta GDI powyżej indeksu 1, więc paleta bez czerni na
indeksach 0–1 wypala całe pole — „białe pole” z 4.x). Czcionek nie dołączamy: tekst rysuje Arial
przeglądarki litera po literze w miejscach pióra GDI (szerokości znaków GDI są w kodzie), bez
wygładzania. Szerokości, a więc miejsca napisów, są dokładne; litery wobec pikseli GDI: 0,92 wspólnych
(wcześniej Arial 21 px rozciągnięty o 5% i o innej szerokości).

**Geiss włączony w trakcie utworu od razu pokazuje jego tytuł**, jak oryginał (co klatkę czytał
tytuł okna Winampa). Odtwarzacz ogłasza tylko nowy utwór, więc Geiss bierze grany z
`navigator.mediaSession` (`geiss/index.ts`). Wcześniej pierwszy tytuł przychodził dopiero z następnym
utworem, a napis pokazany przed nim wypalał się na czarno (kolor tytułu był jeszcze zerem) —
znalezione w kontroli na żywo.

**Geiss — kolory fal według muzyki** (opcja panelu Geissa „Don't base the wave colors on the music”,
w oryginale domyślnie wyłączona): przełącznik w ramce, zapamiętany w przeglądarce. Przeniesiona
analiza Fouriera z `GetWaveData()` (23 pasma, co klatkę powyżej 8 bitów, jak w oryginale, także przy
wyłączonej opcji) i kolor fali z niej: bas czerwony, środek zielony, góra niebieska.

**Sprawdzone z oryginałem** (kod Geissa 4.30 skompilowany MSVC x86; atrapa DirectDraw dostała
`GetDC()` jako sekcję DIB w formacie powierzchni, więc tekst rysuje prawdziwy GDI; port dostaje maski
liter GDI): sumy CRC każdej klatki identyczne —
- napisy i tytuły: 8 bitów 640×480, 800×600, 1280×720, 384×240, 320×240 (SYSTEM_FONT); 32 bity
  1280×720, 384×240, 320×240; 16 bitów 800×600, 384×240; po 540 klatek (napis nad tytułem, nad
  napisem, pusty, 255 znaków, polskie litery, cudzysłów, nowy tytuł w trakcie napisu); pełne klatki
  640×480 przy 8 i 32 bitach bajt w bajt;
- kolory według muzyki: Sandstorm 800×600 przy 32 i 16 bitach, 3600 klatek (wyłączenie i włączenie
  w trakcie, 13 map); Auto z napisami i opcją, 1024×576, 8 i 32 bity, 3600 klatek;
- najbliższy kolor GDI na 22 000 paletach (Geissa i z remisami): 0 różnic.
`geiss-messages.test.ts` (6 testów) trzyma sumy wzorca przy 8, 16 i 32 bitach dla napisów i dla
kolorów według muzyki oraz sprawdza zachowanie napisu, kolor GDI, „białe pole” i magazyn.

**VoltViz — Halftone Pulse: „Upload Image”.** Etykieta voltviz z ukrytym polem pliku obok „Styl”
(„Wybierz obraz”, po wyborze „Zmień obraz”): obraz staje się źródłem półtonu zamiast okładki. Plik
zostaje w przeglądarce (object URL, płótno; nic nie idzie na serwer ani do pamięci przeglądarki)
i trzyma się do przeładowania strony — także przez Auto, inne presety Halftone Pulse i zamknięcie
panelu (w voltviz ginął ze zmianą wizualizacji). Dodane: okrągły przycisk „Wróć do okładki”, obsługa
z klawiatury, komunikat dla pliku, którego przeglądarka nie narysuje. Wobec voltviz 0.35.1 te same
znaczniki i klasy (różni się tylko wygładzanie tekstu).

**Cthugha-4-Winamp (port z `vendor/`) — tytuł czcionką z komputera.** Wtyczka pisała tytuł w płomienie
GDI-em w Arialu, Courier New, Script albo Times New Roman, bez wygładzania (8-bitowa powierzchnia).
Teraz, gdy przeglądarka ma Arial, Courier New albo Times New Roman (rozpoznane pomiarem: szerokość
próbki i wysokość H muszą być tej czcionki — Robota Androida czy bliźniaków metrycznych to nie
oszuka), rysuje nimi, jak GDI: litera w miejscu pióra GDI, linia bazowa GDI, bez wygładzania.
Metryki i szerokości GDI wszystkich czterech krojów (`c4w/gdi-fonts.ts`, same liczby) wybierają
rozmiar jak wtyczka także dla krojów kreskowych, które zostają tam, gdzie czcionki nie ma (Android)
i dla Script (czcionka wektorowa, przeglądarki jej nie rysują; jej szerokości były szacowane o 55–75%
za duże). Wspólne piksele z powierzchnią GDI: Arial 0,17 → 0,77, Courier New 0,14 → 0,69, Times New
Roman 0,19 → 0,73.

**Sprawdzone:** `tsc --noEmit` czysto (port z `vendor/` osobno też), `test:ui` 439/439, prywatny
build Vite bez błędów. W Chrome (komputer 1440×900 i telefon 390×844 z dotykiem): ramka Geissa
(zakładki, zapis, edycja, pusty tekst odrzucony, „Pokaż” z napisem nad obrazem i jego wtopieniem,
usuwanie, opcja po przeładowaniu), Halftone Pulse z wybranym obrazem, złym plikiem, innym presetem,
powrotem do okładki i klawiaturą; nakładka wobec voltviz. Arkusze w `scratch/renders/extras3/`.
Na żywo po końcowym buildzie (konto tymczasowe, potem skasowane): listy otwierają się w 9–17 ms
(15 202 presety AVS, 16 900 MilkDrop, 769 paczek; raz 55 ms, z ciężkim presetem w tle), wybór
z nich działa; rysują presety z Convolution w miejscu (proxy (gc's t.a.c.o.-remix) w WebAssembly,
pixeled seas z krawędziami na GPU) i z ruchomym Grain (Femme Fatale); w Geissie tytuł przy starcie,
„Pokaż” napisu z wypaleniem w kolorze tytułu i kolory fal według muzyki; „Wybierz obraz” → „Zmień
obraz” w Halftone Pulse; Cthugha-4-Winamp.
W konsoli tylko 401 sprawdzenia sesji sprzed zalogowania.

## 11.11.2026 (4) — AVS: Convolution Filter w miejscu taniej, te same piksele — krawędzie bez odczytu z GPU

Bez migracji i bez nowych zależności. Tylko silnik AVS (`trans/Convolution.ts`, `trans/convolutionCpu.ts`,
`trans/convolutionEdges.ts`, `trans/convolutionWasm.ts` i jego test). Dokładny Convolution Filter
w miejscu z poprzedniego wpisu kosztował przy 1280×720 +4–9 ms na klatkę (krawędzie: odczyt pasków
czeka, aż GPU skończy wszystko, co ma w kolejce — w ciężkim presecie, Tuggummi — Tanssiva Mies 2, nawet
+29 ms) i +7–14 ms (filtr rekurencyjny). Teraz:

- **78 jąder liczących w miejscu tylko krawędzie — w całości na GPU, bez odczytu.** Kolumna w − 1 i wiersz
  h − 1 zależą od pikseli, które GPU umie policzyć równolegle; wiersz h − 2 czyta siebie na lewo
  (rekurencja wzdłuż wiersza, nieliniowa, więc nie da się jej rozłożyć), ale jest jednowymiarowy: przebieg
  do tekstury w × 1 liczy w każdym fragmencie cały wiersz od początku i zostawia swój krok (w kroków na
  fragment). Drugi przebieg rysuje na klatkę wiersz h − 2, wiersz h − 1 z niego i kolumnę w − 1 (z obrazu,
  jaki był). Dla klatek szerszych niż 16 384 zostaje odczyt pasków jak dotąd.
- **mykaL — just another sound nie jest rekurencyjny**: jego jedyna waga czytająca wiersz powyżej mnoży
  przez wagę zapisaną dla obróconego miejsca, czyli 0 (`convolutionRecursive` liczy już tylko wyrazy
  z mnożnikiem różnym od zera) — liczy się teraz jak krawędzie, na GPU.
- **4 filtry rekurencyjne zostają na procesorze**: rekurencja dwuwymiarowa (każdy wiersz czyta policzony
  wiersz powyżej, exoniemetry także piksel dwa wcześniej), na GPU to przebieg na wiersz (720 rysowań
  i kopii na klatkę) albo w każdym fragmencie rosnący stożek zależności (O(j²)). Szybciej: kolumny brzegowe
  też w WebAssembly (było ~1,5 ms JavaScriptu na klatkę), a gdy klatki nie dzieli inny użytkownik serii,
  odczyt idzie wprost do pamięci modułu i wysyłka z niej, w kolejności wierszy GL (bez odwracania i dwóch
  kopii 3,7 MB). Odczytu całej klatki uniknąć się nie da: filtr czyta każdy piksel w kolejności wtyczki.

**Sprawdzone:**
- piksele: sondy wobec wzorca co do piksela (640×360) — po jednej na każde z 55 różnych jąder w miejscu,
  jakie mają presety (51 na nowej drodze GPU, 4 rekurencyjne), klatki 1, 2, 5, 10, 30, 60; dawne 25 sond
  filtra (klatki 1–120) i sondy Grain za filtrem na procesorze; sumy klatek przed → po (30 od wczytania,
  świeża strona na preset): wszystkie 104 presety z filtrem w miejscu albo różnicą arytmetyki przy 640×360
  i przy 1280×720, 150 losowych, 30 z ruchomym i 20 ze statycznym Grain — identyczne (jeden losowy
  i trzy niewczytane strony z równoległego przebiegu powtórzone pojedynczo, dwa razy każdym buildem:
  identyczne);
- `tsc --noEmit` czysto, `test:ui` 432/432 (test WebAssembly liczy też klatkę ułożoną od dołu, jak ją
  odczytuje GL);
- czas klatki (1280×720, przed → po, mediana z trzech przebiegów na przemian; w nawiasie stary,
  niedokładny filtr sprzed 11.11 (2), dwa przebiegi):
  - krawędzie: Kar-ma — Escape from the Jelly Bean Factory 12,3 → 4,2 (3,9), horusian — blood vs. milk
    9,0 → 3,3 (2,4), amphirion — pulse 6,8 → 2,3 (2,1), pixel army rise! 36,7 → 19,1 (20,0), Tuggummi —
    Tanssiva Mies 2 59,6 → 29,6 (30,4), mykaL — it's meant to hurt your eyes 4,4 → 1,8 (1,4), mykaL — just
    another sound 8,5 → 2,0 (1,4) — krawędzie kosztują teraz tyle co niedokładny filtr (do ~1 ms);
  - rekurencyjne: journey (alt) VB200 13,7 → 7,3 (1,6), VB219-2 16,2 → 12,0 (1,8), for . exoniemetry
    17,1 → 12,6 (6,7), Grandchild — proxy 41 → 29,5 (25,5; mocno rozrzucone).

## 11.11.2026 (3) — Lista presetów i paczek z wyszukiwaniem, otwiera się od razu przy 16 900 pozycjach

Bez migracji i bez nowych zależności. Tylko front: panel wizualizacji (`audio-player.ts`), nowy
komponent `shared/list-picker.ts` z czystą częścią `shared/list-picker-model.ts`, style
`styles/list-picker.css`, a w `panels.css` wygląd przycisku w pasku.

**Problem.** Lista presetów i lista paczek w pasku wizualizacji były zwykłymi `<select>`. Chrome
przy każdym otwarciu budował w okienku selecta wszystkie opcje, a strona przez ten czas stała:
- MilkDrop, „Wszystkie paczki” (16 900 presetów): 2,1 s na komputerze, 3,7 s w emulacji telefonu;
- AVS, „Wszystkie paczki” (15 202): 1,9 s i 3,3 s;
- Cream of the Crop (9 795): 0,9 s i 1,6 s.

**Teraz: lista, która rysuje tylko to, co widać.** Przycisk w miejscu selecta otwiera listę
w warstwie najwyższej (popover): panel jej nie przycina, a na pełnym ekranie stoi nad nim.
- Wiersze mają stałą wysokość, więc istnieją tylko te w widoku i kilka obok. Kilkadziesiąt
  elementów wypełnia się od nowa przy przewijaniu.
- Otwarcie listy 16 900 presetów to 5–7 ms pracy i lista na ekranie w następnej klatce, 12 ms od
  kliknięcia (wcześniej 2,1 s). Na telefonie ~20 ms po `click`.
- Nagłówek grupy, w której jest góra listy, zostaje przypięty nad wierszami (AVS ma 1 011 grup).

**Wyszukiwanie.** Pole nad listą (od 12 pozycji) nie rozróżnia wielkości liter ani znaków
diakrytycznych („lodz” znajdzie „Łódź”). Każde słowo musi być w nazwie albo w nagłówku grupy:
„cream dancer” znajdzie presety Dancer z Cream of the Crop, „visbot 2” paczki VISBOT.
- Nagłówki zostają nad tym, co znalezione. Licznik mówi „72 z 16 900”, a bez szukania
  „16 900 presetów”; Auto i ulubione na górze nie wchodzą do liczby.
- Pierwszy znak przy największej liście to ~11 ms, kolejne 3–6 ms.
- Escape najpierw czyści pole, drugi zamyka listę. Panelu już nie zamyka (zamyka go dopiero
  Escape na zamkniętej liście, jak przy selekcie).

**Wszystko inne jak w selekcie.** Te same wartości (Auto, „Auto — tylko ulubione” od dwóch
ulubionych, grupa „★ Ulubione”, grupy z nagłówkami). Wybór woła silnik tylko przy zmianie,
a przycisk pokazuje wybraną pozycję, w Auto „Auto: <preset na ekranie>”. Zmiany:
- wybrany preset spoza listy pokazuje swoją nazwę (select był wtedy pusty);
- w liście gwiazdka oznacza ulubione, a fala preset na ekranie.

Lista paczek używa tego samego: AVS ma ich 769, a z wyszukiwaniem po nazwie paczki i folderu.

**Klawiatura i czytnik ekranu.** Wzorzec combobox + listbox:
- przycisk jest comboboxem; ↓ ↑ albo litera otwierają listę, a litera od razu trafia do pola;
- po otwarciu fokus jest w polu, a `aria-activedescendant` wskazuje podświetloną opcję
  (`aria-setsize`/`aria-posinset`, bo opcji jest w dokumencie tylko kilkadziesiąt);
- ↓ ↑ Page Up/Down Home End przesuwają, Enter wybiera i oddaje fokus przyciskowi, Tab zamyka;
- spacja na liście wybiera zamiast włączać muzykę;
- bez pola (Geiss: głębia koloru) litery skaczą do pozycji, jak w selekcie.

**Telefon.** Lista jest arkuszem od dołu ekranu z uchwytem, na przyciemnionym tle. Wiersze mają
2,85 rem, przewijanie z bezwładnością zostaje w liście. Fokus idzie na listę, nie na pole, więc
klawiatura nie wyskakuje sama. Arkusz podnosi się nad klawiaturę, gdy ktoś stuknie w pole, a
„Gotowe” chowa klawiaturę i zostawia listę. Stuknięcie w wiersz wybiera.

**Pasek panelu.** Otwarta lista trzyma pasek widoczny. Przewijanie i szukanie liczą się jako
ruch, a po pół minucie bez nich lista się zamyka i pasek odpoczywa. Wciśnięcie poza listą tylko
ją zamyka, jak przy okienku selecta. Dwuklik na obrazie dalej przełącza preset.

Nowe teksty w `i18n.ts` (7): „Szukaj presetu”, „Szukaj paczki”, „Wyczyść wyszukiwanie”,
„{count} z {total}”, „Nic nie pasuje do „{query}”.”, „{count} preset/presetów”. Test:
`list-picker-model.test.ts` (13: składanie znaków, wyszukiwanie z nagłówkami i skrótami, okno
wierszy, przewijanie do wiersza, ruchy klawiszy) w `npm run test:ui` (432/432); `tsc --noEmit`
czysty.

Sprawdzone w Chrome bez okna na prawdziwym `AudioPlayer` z paczkami właściciela, na komputerze
(1440×900) i w emulacji telefonu (390×844):
- otwarcie i pomiary;
- szukanie i klawisze;
- Escape i Tab;
- wybór, który dociera do silnika (Enter, mysz, stuknięcie, „Auto — tylko ulubione”);
- kliknięcie poza listą;
- pasek trzymany przez listę i odpoczywający po wyborze dotykiem;
- dwuklik na obrazie;
- lista paczek AVS.

Pełnego ekranu Chrome bez okna nie daje („Permissions check failed”). Zamiast niego panel trafił
do warstwy najwyższej tak, jak robi to pełny ekran, i lista wyszła nad nim w całości. Renderingi
są w `scratch/renders/picker/`.

## 11.11.2026 (2) — AVS: Convolution Filter w miejscu jak wtyczka, ruchome Grain co do piksela wobec wzorca

Bez migracji i bez nowych zależności. Tylko silnik AVS (`frontend/src/shared/visualizations/avs/webvs/`)
i lista testów w `frontend/package.json`. Dwie luki, które zostały po 11.11 (1): jądra Convolution
Filter liczone w miejscu (poza samym środkiem) i ruchome Grain.

**Convolution Filter w miejscu** (`trans/Convolution.ts`; nowe `trans/convolutionCpu.ts`,
`trans/convolutionEdges.ts`, `trans/convolutionWasm.ts`). Jądro, które zaczyna się od co najmniej
24 zer, wtyczka liczy w buforze, który czyta, od górnego wiersza, od lewej. Piksel już policzony
czyta tylko tam, gdzie krawędź cofa odczyt, a przy dwóch przejściach także w głębi (obrócone jądro
czyta wiersze powyżej). Z 84 takich filtrów (poza 309 z samym środkiem, liczonymi od 11.11 (1)):
- 77 (70 jednoprzebiegowych, 7 dwuprzebiegowych) czyta piksele policzone tylko w ostatniej kolumnie
  i dwóch ostatnich wierszach: GPU liczy klatkę jak dotąd, procesor przelicza te piksele w kolejności
  wtyczki z odczytanych pasków (8 kolumn i jeden wiersz) i rysuje je na wynik;
- 5 dwuprzebiegowych (Grandchild — proxy (gc's t.a.c.o.-remix), mykaL — just another sound, journey
  (alt) w VB200 i VB219-2, for . exoniemetry (wotl remix)) to filtr rekurencyjny: cała klatka na
  procesorze w kolejności wtyczki, w serii klatki na procesorze (`cpuFrameRun.ts`); środek wierszy
  w WebAssembly SIMD (instrukcje i16x8 to te same działania co MMX wtyczki), 3–6 ms przy 1280×720
  zamiast 90–240 ms w JavaScripcie;
- 2 z samych zer nic nie czytają (bez zmian).

**Arytmetyka Convolution Filter z jednego planu.** Shader GPU jest generowany z tego samego planu
co liczenie na procesorze (`planConvolution` → `convolutionGlsl`), zrobionego jak `create_draw_func`.
Wyszło przy tym pięć różnic dotychczasowego shadera wobec kodu wtyczki (27 z 2 415 różnych ustawień
w presetach, 38 presetów):
- drugie przejście mnoży przez wagę zapisaną dla miejsca obróconego, nie przez wagę obracanego wpisu
  (`pmullw [ecx+8·(7·y+x)]` z x, y już obróconymi) — wagi inne niż 1 i potęga dwójki, 27 filtrów
  w 26 presetach (drew — pixeled seas., Degnic — Nuclear blobs, mykaL — just another sound …);
- iloczyn wagi powyżej 257 zostaje 16-bitowy (`pmullw`; 8 presetów z wagami 384, 1 111, −266, −323,
  −350: pan am — ministeck w czterech wydaniach, Pixelcraft — Chromabubbles …);
- bias to słowo 256·|bias| z 16 bitami (3 presety, np. jheriko — Yet Another Grid);
- „absolute” czyta sumy jako słowa ze znakiem (`psubsw`), a bez wag ujemnych nie odejmuje wcale
  (stary shader obcinał wtedy do 32 767; 3 presety z sumą wag 441, np. l0tus — carcinogenic haze);
- przy ujemnej skali `paddw`/`paddusw` listy wybiera suma wag dodatnich sprzed zamiany znaków (żaden
  preset).

**Ruchome Grain** (`trans/Native.ts`; nowe `trans/grainDice.ts`, `trans/grainMask.ts`) jak
`r_grain.cpp`: tablica 491 bajtów `rand() & 255` z konstruktora, miejsce `rand() % 491`, co klatkę
`+ rand() % 300`; każdy jasny piksel w kolejności bierze bajt szansy i — gdy wypadnie poniżej
ilość·255/100 — bajt skali; co 16. miejsce skok o `rand() % 73`. Przejście liczy procesor
w WebAssembly: zwykle po masce jasnych pikseli, którą pakuje GPU (32 piksele na teksel, odczyt 1/32
klatki), a bajty skali nakłada shader; na klatce, którą trzyma seria na procesorze, po niej samej.
W porównaniu ze wzorcem Grain losuje z własnego generatora jak on (`grainRand`); jego stan jest teraz
w tablicy (`avsRandom.ts`), a WebAssembly dostaje go i oddaje (`grainRandState`).
- Tę drogę ma strona porównań (`__avsTestRandom`) i przełącznik `__avsGrainExact = true`.
  W odtwarzaczu ruchome Grain zostaje przy shaderze, który losuje na piksel te same dwa bajty z tym
  samym rozkładem: AVS 2.81 ustawia ziarno `rand()` od czasu przy każdym starcie (`main.cpp`), więc
  przejście tablicy daje w Winampie inny wzór w każdej sesji — dokładność nie zmienia niczego, co
  widać, a odczyt z GPU kosztowałby 5–10 ms na klatkę na każde Grain (Predator Eye View z czterema:
  5 → 38 ms). Statyczne Grain nie woła już `Math.random` dla nieużywanego ziarna shadera.

**Sprawdzone:**
- `tsc --noEmit` czysto, `test:ui` 419/419 (nowe: `convolutionCpu.test.ts` — plan wobec emulacji
  wygenerowanego kodu instrukcja po instrukcji na 400 losowych jądrach i klatkach, krawędzie wobec
  całej klatki, które jądra są rekurencyjne; `convolutionWasm.test.ts` — WebAssembly wobec
  JavaScriptu; `grainDice.test.ts` — przejście tablicy po klatce i po masce, w JavaScripcie
  i WebAssembly, wobec dosłownego portu pętli C, z liczbą wywołań `rand()`);
- 38 presetów-sond (Super Scope z liniami w całej klatce, także na krawędziach, ze sprzężeniem i bez,
  potem filtr albo Grain): 17 z jądrami w miejscu z presetów, 8 z różnicami arytmetyki, 13 z Grain
  (trzy tryby mieszania, kilka Grain po sobie, statyczne i ruchome razem, Grain za filtrem na GPU
  i za filtrem na procesorze, czyli obie drogi) — wobec wzorca co do piksela w klatkach 1, 2, 3, 5, 10,
  20, 40, 60, 90, 120 (640×360); starym buildem (36 z nich) różniły się wszystkie poza „×5/2”,
  biasem 300 (biel w obu), statycznym Grain i sondą z czarną klatką (linie mnożone przez wyczyszczoną
  klatkę: ziarno nie ma czego zmienić);
- presety wobec wzorca (640×360 od 1:00 utworu, świeża strona na preset, klatki 2, 10, 30, 60, 100,
  150, 200, 300):
  - 104 z filtrem w miejscu albo różnicą arytmetyki: bliżej wzorca 71, bez zmian 28, dalej 5 (ułamki
    MAD; presety różnią się od wzorca przez inne komponenty — l0tus — anxiety już przed swoim filtrem);
    identycznych we wszystkich ośmiu klatkach 6 → 21 (np. mykaL — just another sound 40–71 % → 100 %,
    jheriko — Yet Another Grid 0 → 100 %, drew — pixeled seas. 92 → 100 %), w klatce 2 32 → 50,
    w klatce 300 6 → 24; Grandchild — proxy w klatce 2 9 → 97 %, journey (alt) VB200 w klatce 30
    72 → 97 %;
  - 289 z ruchomym Grain: bliżej 220, bez zmian 14, dalej 54 (ułamki MAD w presetach dalekich od wzorca
    przez inne komponenty — każdy piksel, który przed Grain świeci tylko w jednym silniku, przesuwa
    dalsze bajty tablicy; część to losowość starego builda), identycznych we wszystkich ośmiu klatkach
    3 → 57, w klatce 300 5 → 61; effekthasch — femme fatale (ALIAS remix) w klatce 300 2 → 100 %;
- sumy klatek (30 od wczytania, 640×360, świeża strona na preset, przed → po) na 910 presetach:
  wszystkie 104 z filtrem — 69 różnych, 35 identycznych (krawędź w miejscu nie wychodzi w tych
  klatkach: późniejszy Movement / Dynamic Movement nie sięga ostatniej kolumny i wierszy — Acid —
  a mess ucięty za filtrem różni się, a bez zmiany nie); 466 z ruchomym Grain — 439 różnych, 27
  identycznych (ziarno nie trafia w jasne piksele w tych klatkach); 300 losowych bez tych cech — 300
  identycznych; 40 ze statycznym Grain — 37 identycznych, 3 różne: Odyssey i pure-krypton — skin mają
  Scatter, a statyczne Grain przestało wołać `Math.random` dla nieużywanego ziarna shadera (strona
  przeglądu ustala ciąg `Math.random`, więc Scatter dostaje inne liczby od klatki 2), PAN_AM — dstrt
  ma Text i różni się nawet między dwoma przebiegami tego samego builda. Wpadki równoległych przebiegów
  (Computer Shift, ma2, Morbid Heads, Zycho, paranoya) powtórzone pojedynczo: identyczne;
- czas klatki (1280×720, przed → po, dwa przebiegi na przemian):
  ruchome Grain w dokładnej drodze (tylko strona porównań i przełącznik) +5–10 ms na każde (Userkaft — Deep Bass 0,6 → 5,8; Mahadeva, dwa: 1,5 → 13;
  Predator Eye View, cztery: 5 → 38; femme fatale 20 → 30) — najwięcej to czekanie odczytu maski
  na GPU; filtr rekurencyjny +7–14 ms (mykaL — just another sound 3,0 → 10,5; journey (alt) 3,3 → 12,1
  i 3,7 → 17,5); krawędzie filtra w miejscu +4–6 ms (Kar-ma — Escape from the Jelly Bean Factory
  5,2 → 11,4; amphirion — pulse 1,7 → 5,8).

Pełny przegląd wszystkich 15 202 presetów po 11.11 (1) i (2) (320×180, 90 klatek, ustalony zegar
i `Math.random`): 0 wyjątków i 0 komunikatów; w 14 027 wspólnych z przeglądem z 10.11 czarnych
160 → 158 (5 zaczęło rysować; 3 ściemniałe w klatce 90 to Userkaft — Another to the angel Marion
Raven, czarny także we wzorcu, i dwa presety z FyrewurX, których stan zależy od poprzedników na
stronie — w świeżej stronie rysują); skrót klatki 90 różny w 3 133 (zmiany z 11.11). 466 presetów
z ruchomym Grain drogą odtwarzacza: wszystkie liczą 90 klatek bez wyjątku.

Zostaje: krawędzie filtra w miejscu potrzebują odczytu z GPU, a ten czeka na wszystko, co GPU ma do
narysowania przed nimi (kilka ms na klatkę) — bez odczytu nie da się ich policzyć dokładnie (kolejność
wtyczki zależy od już policzonych pikseli). Dokładne ruchome Grain z tego samego powodu jest tylko
na stronie porównań.

## 11.11.2026 (1) — AVS: Triangle jak wtyczka, krawędzie Convolution Filter, liczby w kodzie, zegar `gettime`; siedem presetów VISBOT zgodnych ze wzorcem

Bez migracji i bez nowych zależności. Tylko silnik AVS (`frontend/src/shared/visualizations/avs/`).
Punktem wyjścia było siedem presetów z importu VISBOT, które we wzorcu (grandchild/vis_avs z naszymi
poprawkami) wyglądały zupełnie inaczej niż u nas. Każda przyczyna znaleziona bisekcją po komponentach
w obu silnikach i sprawdzona sondą (mały preset, który wypisuje wartość w położeniu piksela).

**Triangle** (APE „Render: Triangle”, 174 presety; `render/Triangle.ts`, nowy `render/triangleRaster.ts`
z testem) przepisany według `e_triangle.cpp`:
- kolor domyślny biały: co klatkę przed kodem klatki red1…blue3 = 1 i x1…y3 = 0 (było 0 przy
  starcie i nigdy potem) — 92 trójkąty w 54 presetach nie ustawiają koloru i były czarne;
- `n` przed init = 0, `w`/`h` także w kodzie init, `n` zaokrąglone, `i` liczy tylko narysowane,
  `skip` ≠ 0 pomija, `b` to zmienna presetu, nie beat;
- rysowanie jak wtyczka: narożniki obcięte do pikseli, wiersze i krawędzie w arytmetyce całkowitej,
  bez górnego wiersza, prawego końca wiersza i ostatniej kolumny; kolor `(int)(c·255)`; zapisy przez
  plotter w trybie Set Render Mode (dotąd trójkąty GL z wygładzaniem krawędzi przez GPU);
- bufor głębi (`zbuf`, `zbclear`, `z1`; 85 trójkątów), wspólny dla wszystkich Triangle.

**Convolution Filter** (`trans/Convolution.ts`, 7 346 filtrów w 4 054 presetach): krawędzie jak kod
generowany przez wtyczkę — ostatniego wiersza filtr nie czyta (najwyżej h − 2), trzy ostatnie
kolumny czytają najwyżej w − 2; jądro z samym środkiem liczy w miejscu, więc w ostatnim wierszu
i kolumnie działa dwa razy (309 filtrów). Dotąd krawędź powtarzała ostatni wiersz i kolumnę.
Zostaje: 84 inne jądra liczone w miejscu (opis w FRONTEND.md).

**Effect List**: „adjustable” 255 (suwak albo `alphain`/`alphaout` z kodu) to kopia, jak `r_list.cpp`,
nie `BLEND_ADJ` o poziom ciemniejszy.

**Liczby w kodzie**: `nsEelNormalize` pisał 0.0000001 jako `1e-7`, czego czytnik EEL za nim nie bierze,
i cała sekcja przepadała (16 presetów; Texer II w obu „Theory Of Pretty Much Everything” nie liczył
kodu klatki). Teraz cyfry z kropką (`plainNumber`, test w `ns-eel-syntax.test.ts`).

**`gettime`**: `(teraz − start) / 1000` w całych milisekundach, jak AVS; `teraz/1000 − start/1000`
myliło się do 2,4·10^−7 s (test w `eel-wasm-backend.test.ts`).

**Siedem presetów wobec wzorca** (640×360 od 1:00 utworu, świeża strona na preset; % pikseli
identycznych / MAD w klatkach 90 i 300, przed → po):

| preset | przyczyna | kl. 90 | kl. 300 |
|---|---|---|---|
| VA017 neon — 09 | Triangle czarne (kolor 0), lista „adjustable” 255 | 15 % / 104 → 96 % / 0,4 | 13 % / 108 → 96 % / 0,4 |
| OnionRing — Blood On The Motorway (grrrind mix), VB213 | Triangle czarne, krawędzie Convolution | 44 % / 109 → 100 % / 0 | 38 % / 136 → 99,998 % / 0,001 |
| effekthasch — Theory Of Pretty Much Everything, VB234 | sekcja z `0.0000001` przepadała | 84 % / 4,8 → 88 % / 0,5 | 77 % / 4,1 → 86 % / 0,5 |
| framey — Theory … retouch phase two, VB235 | jak wyżej | 69 % / 61 → 86 % / 5,4 | 68 % / 56 → 80 % / 7,3 |
| effekthasch — femme fatale (ALIAS remix), VB248 | zegar strony testowej (niżej) i `gettime`; zostaje Grain | 53 % / 20 → 70 % / 6,7 | 2 % / 99 → 74 % / 6,4 |
| hboy — fragile (yathosho's ill bill mix), VB123 | Triangle czarne (kolor 0) | 8 % / 157 → 100 % / 0 | 1 % / 99 → 100 % / 0 |
| OnionRing — Blood On The Motorway, VB178 | Triangle czarne, krawędzie Convolution | 1 % / 69 → 100 % / 0 | 0,3 % / 105 → 24 % / 11 |

Co zostaje i dlaczego:
- Blood On The Motorway (VB178) zgodny do klatki 145; w 146. Interferences wzorca kładzie jedną
  warstwę piksel obok — wzorzec liczy z `M_PI` i double, AVS 2.81 (i my) z 3.14159 i floatem, a obrót
  −170/255 wypada prawie dokładnie na 4π/3 (rachunek obu stron poza silnikiem: `interf_sim.py`); od
  tej klatki sprzężenie rozdmuchuje różnicę. Tu myli się wzorzec.
- femme fatale: ruchome Grain losuje u nas na karcie, nie przechodzi tablicy AVS-a; z Grain
  wyłączonym w obu silnikach preset zgadza się ze wzorcem przez 300 klatek (99,99 %).
- obie Theory: maska przekątnych liczy `%` na liczbach niecałkowitych — wzorzec (EEL2) obcina,
  AVS 2.81 (i my) zaokrągla; reszta to ostatnie bity `sin`/`pow` w kodzie Texera.
- neon — 09: wpisy tablicy Movement na ostrzu całego piksela (biblioteka matematyczna MSVC wobec V8),
  0,1–0,5 % pikseli.

Przy okazji poprawiona kopia strony testowej (scratch, nie repozytorium): klatka 1 to 0 ms zegara
(wzorzec zaczyna od −1), `Date` w całych milisekundach, dźwięk w całych porcjach (w klatkach 246,
247, 261, 262, 276, 277, 291, 292 brała okno o próbkę za wcześnie) — opis w TESTING.md.

**Sprawdzone:**
- `tsc --noEmit` czysto, `test:ui` 405/405 (nowe: `triangleRaster.test.ts`, test `plainNumber`, test zegara
  `gettime` domknięciami i w wasm);
- 174 presety z Triangle wobec wzorca (klatki 30, 90, 150): identycznych 5 → 40, z MAD < 1 we
  wszystkich 20 → 90; bliżej wzorca 118, bez zmian 50, minimalnie dalej 6 (daleko od wzorca w obu
  buildach przez inne komponenty: Picture II z JPG, Text, Global Variables);
- sondy Convolution Filter (linie w ostatnich kolumnach i wierszach, jądra z jednym wpisem, środek
  w miejscu, dwuprzebiegowo): co do piksela, poza 2–3 pikselami jąder w miejscu innych niż środek;
- sumy klatek (30 od wczytania, 640×360, świeża strona na preset, wasm od razu) na 955 presetach
  (wszystkie z Triangle, z listą „adjustable” 255 i z liczbą < 10^−6, oraz losowo: 220 z Convolution
  Filter, 80 z kodem listy, 100 z `gettime`, 320 dowolnych), trzy buildy: przed, po bez zmiany
  `gettime` i po. Przed → po bez `gettime`: 457 identycznych, 494 różnych — każdy ma Triangle,
  Convolution Filter, listę „adjustable” 255 / z kodem `alphain`/`alphaout` albo liczbę < 10^−6;
  jeden bez tych cech (S_KuPeRS — Random Access Terminal) to wpadka równoległego przebiegu: sam,
  dwa razy każdym buildem, identyczny; trzy strony, które się nie wczytały, powtórzone pojedynczo —
  różnice tylko tam, gdzie te cechy. Po bez `gettime` → po: 813 identycznych, 141 różnych, wszystkie
  z `gettime` w kodzie. Cztery losowe presety z samym Convolution Filter w klatkach 1–2: różnice
  tylko w czterech ostatnich wierszach i sześciu ostatnich kolumnach.
- czas klatki (orientacyjnie, maszyna pod obciążeniem, 1280×720): presety z wieloma trójkątami
  w trybach mieszanych na procesorze albo z buforem głębi wolniejsze o kilka ms (synth-c — stripe
  state, 50/50: 8–14 → 17–25 ms; GC — thick glass 3–5 → 10 ms), pozostałe w granicach szumu.

## 10.11.2026 (9) — AVS: nowy preset zaczyna od obrazu poprzedniego (części S_KuPeRS); 1 165 presetów z wydań VISBOT, flowers.avi, Negative Strobe

Bez migracji i bez nowych zależności. Presety, klipy i porty wtyczek są jak dotąd w ignorowanym
`frontend/vendor/`.

**Zmiana presetu jak w Winampie.** AVS 2.81 ma jeden framebuffer na wszystkie presety: nowy
preset rysuje w klatce, którą zostawił poprzedni (`r_transition.cpp`), a `r_list.cpp` czyści ją
tylko przy „Clear every frame”. U nas każdy preset zaczynał od czerni, więc presety-części, które
tylko poruszają obraz (S_KuPeRS — AVS Parts: „DynMov …”, „Mov …”, wg readme paczki do wstawiania
w swój preset), były czarne.
- Odtwarzacz wczytuje preset z `carryFrame` (`webvs/Main.ts`): lista główna oddaje ostatnią
  klatkę (`EffectList.takeFrame`, tekstura wyjęta z zestawu, bez kopiowania), a nowa rysuje ją
  w pierwszej klatce zamiast czyścić. Preset, który nie zdążył narysować klatki, oddaje dalej obraz
  poprzedniego; zmiana rozmiaru zaczyna od czerni. Strony porównań i przeglądu wczytują bez tej
  opcji, więc startują od czerni jak dotąd.
- Sprawdzone ze wzorcem, który dostał przełączenie presetu w trakcie (`ref_render.c`:
  `AVS_SWITCH_AT`, `AVS_SWITCH_PRESET`), przez adapter odtwarzacza na stronie porównawczej:
  SScope x=sin(r)2+cos(t)2 przez 120 klatek, potem DynMov x=(if(what,x,x-(0.1inv))), Mov
  d=atan(d)-y albo DynMov d=bx-sin(ax)-dx-0.1 — klatki 1–300 identyczne co do bitu.
- Dwa z pięciu „DynMov” i dwa z ośmiu „Mov” mają „Clear every frame”: te są czarne także
  w Winampie i tak zostaje.

**1 165 nowych presetów VISBOT** z wydań serii VA, VB, VC, VD i VE (kopie
`visbot.net/files/packs` z 2023 r. w Wayback Machine, pobrane za zgodą właściciela, czytane jako
dane, nic nie uruchamiane): 346 wydań, 6 245 presetów, z czego 5 080 to bajt w bajt presety, które
już były. Nowe leżą jako `visbot/<wydanie>/…` w 124 folderach, każdy z `SOURCE.txt`; panel ma
15 202 presety.
- 323 instalatory to NSIS z napisami UTF-16 (2.46 „Unicode” Jima Parka i 3.08), jeden to NSIS 3
  ANSI. Czytnik instalatorów (`scratch/avs-reference/nsis/extract_all.py`) brał je za ANSI NSIS 2
  i gubił nazwy plików; teraz rozpoznaje wariant po samych kodach w napisach. Paczki czytane
  wcześniej dają te same pliki co przedtem.
- Wszystkie 1 165 konwertują się bez błędu; jedyne wtyczki, których używają (VisFrac, Normalise,
  Buffer blend), już mają porty.
- Przegląd w przeglądarce (każdy preset: wczytanie, kompilacja, 90 klatek od 1:00 przy 320×180,
  pomiar obrazu): wszystkie się wczytują i liczą bez wyjątku, nieznanego komponentu i komunikatu;
  1 133 rysuje i się rusza, 15 stoi (wzory, dwa prawie białe także we wzorcu), 17 czarnych.
  22 czarne i prawie białe porównane ze wzorcem (640×360, klatki 90 i 300, świeży start): 7 takich
  samych we wzorcu (czarne albo białe co do piksela), 8 rysuje jak wzorzec — później niż okno
  przeglądu albo z drobną różnicą — a 7 różniło się wyraźnie: przyczyny i poprawki w 11.11.2026 (1).
- Pobrane archiwa (56 MB) zostały skasowane po imporcie; spis i narzędzia:
  `scratch/avs-reference/visbot/recover-1011/wayback/`.

**flowers.avi** (z wydania VD001; Indeo 5, 160×120, 8 klatek) jako atlas klatek
w `vendor/avs-videos`: Dynamic Duo — 16 danjoe -stargazer pokazuje kwiaty. Bez klipu zostaje
tylko VISBOT — 01 intro (VISBOT.AVI nie ma w żadnym wydaniu).

**Negative Strobe** (APE „Virtual Effect: Negative Strobe”, frames of reality — 017 . nowhere out
(slight return)): port ze statycznego odczytu wtyczki (`vendor/avs-apes/negative-strobe.ts`,
4 testy). Odwraca kolory klatki przez `speed` klatek z każdych 2·speed + 1, równo, niezależnie od
muzyki (preset: speed 16). Plik pobrał właściciel (strona autora i wątek „AVS APE Files Wanted”
na forum Winampa); czytany tylko jako bajty.

## 10.11.2026 (8) — AVS: plotter na prostokątach i serii Super Scope'ów, getspec/getosc w WebAssembly; każda klatka identyczna co do bitu

Bez migracji i bez nowych zależności. Tylko silnik AVS (`frontend/src/shared/visualizations/avs/`).

**Plotter** (`webvs/avsDraw.ts`: wszystko, co AVS rysował `line()` i kropkami — Super Scope, Simple,
Ring, Dot Grid, Bass Spin…):
- zapisy jako prostokąty jednego koloru zamiast pojedynczych pikseli: kolumny szerokiej linii,
  które mają te same wiersze, to jeden prostokąt, a prostokąt przylegający do poprzedniego w tym
  samym kolorze łączy się z nim — te same piksele i w każdym pikselu te same zapisy w tej samej
  kolejności;
- tryby, które GL miesza dokładnie (zastąp, dodaj, maksimum, minimum, oba odejmowania), rysują
  wszystkie prostokąty jednym rysowaniem instancjonowanym w kolejności AVS-a, zamiast składać każdy
  zapis na procesorze (Raz — Peace And Love: 59 mln zapisów na klatkę);
- Super Scope'y pod rząd z 50/50, mnożeniem albo „adjustable” dzielą jedną kopię klatki na
  procesorze, jak Texery II (`webvs/cpuFrameRun.ts`): jeden odczyt z karty na serię zamiast jednego
  na Super Scope (OnionRing — 15: 27 → 1), mieszanie całym pikselem naraz i z tablicy
  `g_blendtable` zamiast funkcji na kanał, z powrotem na kartę tylko prostokąt zapisów; duże
  mieszania tych trybów (ponad 2^17 zapisów) idą na procesor także przy kilku przebiegach;
- pamięć: listy pikseli nie rosną już do setek MB przy szerokich liniach — w długiej sesji sterta JS
  po GC 164–222 MB zamiast do 836, proces renderera 247–313 MB zamiast do 912;
- `__avsPlotterFast = false` na stronie testowej wraca do dawnej drogi (listy pikseli).
- po niezależnym przeglądzie kodu: bez `highp` w shaderach fragmentów (stare GPU telefonów)
  plotter zostaje przy listach pikseli (wysyłka prostokąta po serii adresuje teksele przez
  `gl_FragCoord`), a przy wyłączonej szybkiej drodze oddaje klatkę serii przed rysowaniem na GPU
  (Super Scope po Texerze II nie gubi rysunku).

**`getspec`/`getosc` w WebAssembly** (`eel-wasm-backend.ts`): bajty dźwięku analizatora leżą
w osobnej stronie pamięci WebAssembly, którą moduł kodu presetu czyta wprost (multi-memory) — bez
wywołania JS na każde `getspec`; arytmetyka `avsGetvis` krok po kroku w module. TwirlyColours
(102 400 wywołań na klatkę): ok. 4 ms na klatkę mniej. Bez multi-memory w przeglądarce działa import
jak dotąd; `__avsEelWasmVis = false` przełącza ręcznie.

**Wydajność** — zmierzona przy dużym obciążeniu maszyny z zewnątrz (karta graficzna ~99 %, procesor
blisko 100 %), więc liczby są orientacyjne; build przed i po na przemian, świeża strona, 1280×720,
28 presetów wolniejszych niż 30 kl./s po poprzedniej rundzie:

| | przed | po |
|---|---|---|
| mediana | 101,7 ms | 22,8 ms |
| średnia | 116,7 ms | 33,8 ms |
| wolniejszych niż 30 kl./s | 28 | 9 |
| ponad 100 ms / ponad 200 ms | 15 / 2 | 1 / 0 |

Największe zyski: Deamon — Play the guitar 113 → 5 ms, Raz — 01 Introduction 295 → 15, Raz — Peace
And Love 490 → 77, „just like el-vis taught me” ×4 do 27–28 ms (123–163), amphirion — cubic spectrum
101 → 15, OnionRing — 15 103 → 19. Zostały wolne cztery, w których czas idzie na kod EEL albo inne
efekty (micro-d — 3° number preset, Zevensoft — TwirlyColours, STRIPE 4, ZXe — My mind imprisoned 2).
Wcześniejszy pełny pomiar (165 presetów, pierwszy kandydat): mediana 6,9 → 4,8 ms, wolniejszych niż
30 kl./s 27 → 7. Ten kandydat był wolniejszy w łańcuchach Super Scope'ów 50/50 (the great escape,
Jello Cube, amphirion — abstrkt fundamentals; osobne liczenie przebiegów, 7–11 ms na klatkę) —
poprawione przed wydaniem: przebiegi liczy teraz pętla rozpisująca prostokąty.

**Każda klatka identyczna co do bitu:**
- testy w `test:ui`: nowy `avsDraw.test.ts` (20 000 losowych linii wobec dawnego rysowania piksel po
  pikselu, zapisy z prostokątów wobec list pikseli, liczenie przebiegów, mieszanie na procesorze we
  wszystkich trybach), rozszerzony `eel-wasm-backend.test.ts` (getosc/getspec z pamięci visdata oboma
  drogami na siatce 69 × 69 × 22 kanały, zmieniające się bajty, zmiana analizatora); każda z 28
  celowo wprowadzonych pomyłek złapana;
- sumy wszystkich 20 klatek od wczytania (świeża strona na preset), przed i po: 165 ze 165 presetów
  listy przy 1280×720, 300 z 300 losowych przy 640×360, 12 z 12 z FyrewurX — z wasm od razu i w tle;
  pojedyncze strony, które się nie wczytały, i jeden preset z FyrewurX pod obciążeniem sprawdzone
  ponownie: te same klatki;
- przegląd wszystkich 14 037 presetów (90 klatek): 0 wyjątków i 0 komunikatów w obu trybach, liczba
  czarnych bez zmiany co do jednego presetu w każdą stronę; różnice skrótu klatki 90 to presety
  przenoszące stan przez stronę (FyrewurX, `gmegabuf`, kawałki po zawieszeniu). Wszystkie 302 różne
  w świeżej stronie i pojedynczo, oboma buildami: te same klatki albo ta sama zmienność co w buildzie
  sprzed zmiany (te presety różnią się między przebiegami także tam);
- w długiej sesji (330 presetów w jednej stronie) po każdym GC żyje tylko pamięć bieżącego presetu.

## 10.11.2026 (7) — Nakładki VoltViz (Icons, styl Halftone Pulse), własne presety Geissa, losowy następny preset

Bez migracji i bez nowych zależności (`lucide` było już od (6)). Ustawienia nowe tylko
w przeglądarce: `media-visualizer-voltviz-halftone`, `media-visualizer-geiss-presets`,
`media-visualizer-random-next`.

**Losowy następny preset.** Nowy przycisk z kostką obok ‹ ›, dla każdej wizualizacji z presetami.
Włączony sprawia, że › i dwuklik przy przypiętym presecie losują preset z listy: z wybranej
paczki i kategorii, przy „Auto — tylko ulubione” spośród ulubionych, nigdy ten sam dwa razy
z rzędu. W Auto nic się nie zmienia. ‹ cofa po tym, co było pokazane. Wyłączony — wszystko jak
dotąd. Stan jest zapamiętywany w przeglądarce. Sprawdzone na VoltViz i MilkDropie (paczka 472
presetów, ulubione).
- Poprawka przy okazji: ‹ w VoltViz (przenikanie) zapisywało opuszczany preset jako nowo
  pokazany, więc kolejne ‹ skakało między dwoma presetami. Historia czeka teraz, aż preset, do
  którego przeszła, będzie na ekranie.

**VoltViz: nakładki z voltviz.** Icons i Halftone Pulse mają nakładki voltviz 0.35.1, dotąd
pominięte, bo w voltviz to komponenty Reacta. Teraz to zwykły DOM w warstwie wizualizacji
(`voltviz/overlays.ts`): te same znaczniki, klasy Tailwinda (reguły w `stage.css`, wartości
i kolejność z Tailwinda 4.3.3), ikony lucide i zachowanie. Na starcie są zwinięte do przycisku
z okiem i chowają się razem z paskiem panelu, na komputerze i na dotyku (`.visualizer-panel__overlay`
w `panels.css`; dwuklik na nakładce nie przełącza presetu).
- **Icons:** nazwa ikony i „Losuj” (Shuffle), inna ikona niż ta na ekranie. W porównaniu
  z prawdziwą nakładką voltviz (React + Tailwind 4.3.3, ta sama klatka i rozmiar) różnią się
  tylko brzegi liter (wygładzanie tekstu).
- **Halftone Pulse:** „Styl” z trybem, kształtem i kolorami naraz, dowolne połączenie, od razu
  na obrazie. Zmiana staje się „Twoim stylem”: wyglądem samego „Halftone Pulse”, zapamiętanym
  w przeglądarce i używanym przy każdym następnym pokazaniu, także w Auto (domyślnie Auto, Auto
  i kolory źródła, czyli jak dotąd). Na którymś z 51 presetów zmiana robi z tego, co na ekranie,
  „Halftone Pulse” w tym stylu, bez nowego startu; same presety, ulubione i Auto się nie
  zmieniają. Karta stylu jest w porównaniu identyczna co do piksela z voltviz. Brakuje tylko
  „Upload Image” (obrazem jest okładka).
- Teksty po polsku przez `t()` („Losuj”, „Styl”, „Tryb: Auto (co 8 taktów)”, nazwy 40 ikon…),
  po angielsku słowa voltviz.

**Geiss: własne presety jak w Geissie 4.30** (`]##` zapisuje, `[##` wczytuje GEISS.INI).
- Ramka „Presety” w prawym dolnym rogu obrazu: slot 00–99, „Zapisz”/„Nadpisz” mapy na ekranie,
  lista zapisanych z „Wczytaj” i koszem (pyta drugi raz). Zapisane są też w liście presetów
  panelu, w grupie „Twoje presety (GEISS.INI)”. Wybrany preset zostaje na ekranie jak `[##`
  z blokadą L: Auto go nie zmienia, wybór jest zapamiętany, działają ‹ › ★ i „Ulubione”. Nowy
  rozmiar albo głębia koloru wczytują go od nowa.
- Treść i wczytywanie jak w `Effects.h`: środek (ułamek), mapa, tłumienie, fala, wygaszanie,
  głośność fali, shifting, jasność palety, obrót i skala, parametry mapy, osiem efektów, paleta
  8-bitowa, kropki widma; wczytanie liczy mapę od razu i zużywa `rand()` jak oryginał. Zapis
  dobiera wartości tak, żeby wczytanie — także w oryginale — oddało dokładnie zapisaną mapę,
  czego plik Geissa nie zapewniał: pełna precyzja zamiast `%f`, środek, który wraca tym samym
  pikselem, suma wag mapy 12 sprzed jej obniżenia (Geiss przyciemniał ją o 2% przy każdym
  wczytaniu) i pasmo palety pod kluczem, który Geiss czyta (pisał `pal_hi_oband`, więc paleta
  z pasmem je traciła).
- Sprawdzone ze skompilowanym oryginałem (`SavePreset`/`LoadPreset` na prawdziwym pliku INI):
  port czytający GEISS.INI oryginału = oryginał (440 klatek co do bitu, z paletą); oryginał
  czytający plik portu = port (8 i 32 bity).
- Lista panelu przebudowuje się też, gdy zmieniają się nazwy pod tymi samymi identyfikatorami
  (nadpisany slot): `ExternalVisualizer.presetsRevision`.

Nowe ikony interfejsu (`icons.ts`, `icons.css`): `dice`, `save`, `trash` (Font Awesome Free).
68 nowych tekstów w `i18n.ts`. Testy: `geiss-presets.test.ts` (6: oba kierunki z oryginałem,
round trip 25 map przy 8 i 32 bitach, różnice pliku Geissa, magazyn), `random-next.test.ts`
(4) w `npm run test:ui`, a `voltviz-halftone.test.ts` +2 (styl, nazwy ikon); `tsc --noEmit`
czysty. Renderingi i porównania z voltviz (komputer i telefon 390×844) w
`scratch/renders/vis-extras/`, narzędzia wzorca Geissa w `scratch/geiss-reference/`
(`harness_presets.cpp`, poza repozytorium).

## 10.11.2026 (6) — VoltViz: Icons bez Reacta; wybory Halftone Pulse jako presety

Bez migracji. Nowa zależność `lucide` 1.59.0 (ISC): przed buildem `npm install` w `frontend/`.

**Icons** (49. wizualizacja VoltViz) wygląda i rusza się jak w voltviz 0.35.1: 40 ikon lucide
w neonowych konturach z obrotem 3D, kopie zamkniętych kształtów odsuwane w głąb na beat, cząstki
z wysokich tonów, nowa ikona na mocnym beacie, nie częściej niż co 4 s. Wcześniej jej nie było,
bo voltviz robi ikony w React, a próba z ikonami Font Awesome blokowała stronę na ~45 s.
- Dane ikon są z pakietu `lucide` w tej samej wersji co lucide-react w voltviz. Zapisane tak jak
  zapisuje je React dają bajt w bajt ten sam SVG dla wszystkich 40 ikon.
- voltviz próbkuje kontury przez `getPointAtLength`; w Chrome 157 to 2031 ms zablokowanej strony
  przy każdym montowaniu. Nowy `voltviz/outline.ts` liczy te same odpowiedzi bez DOM tak jak
  Chrome (ścieżki jak Blink, koła i linie jak Skia, w 32-bitowych floatach): 94,4% z 42 742
  punktów identyczne co do bitu, reszta różni się najwyżej o 0,0007 px przy 1080p. Klatki
  voltviz i portu przy tym samym dźwięku, zegarze i liczbach losowych są identyczne co do piksela.
- Ikona jest liczona przy pierwszym pokazaniu: montowanie 10,9 ms, zmiana ikony najwyżej 5,1 ms.
  Icons to osobny fragment 22,8 KB (9,1 KB gzip), pobierany dopiero przy pierwszym pokazaniu.

**Halftone Pulse ma wybory ze swojej nakładki w voltviz** (Mode, Shape, Colors) jako 51 presetów
tuż pod nim: „Halftone Pulse — neon”, grupa „Halftone Pulse — tryby” (23, kształty zmienia Auto)
i „Halftone Pulse — kształty” (27, tryby zmienia Auto).
- „Halftone Pulse” zostaje Auto jak dotąd. Auto talii nie rozdaje wyborów, chyba że są wśród
  ulubionych w „Auto — tylko ulubione”. › przechodzi przez wybory tylko, gdy już stoi na którymś.
- Preset otwiera się od razu w swoim wyglądzie (bez 0,6 s przejścia z domyślnego, jak przy
  wyborze z nakładki w voltviz); od 1,5 s klatki są identyczne z voltviz co do piksela.
- Nazwy trybów i kształtów po polsku, po angielsku jak w voltviz (53 nowe teksty w `i18n.ts`).

Licencje: Lucide (ISC) i Feather (MIT, osiem ikon) w `NOTICE-voltviz.txt` i `NOTICE.md`.
Testy: `voltviz-icons.test.ts` (5) i `voltviz-halftone.test.ts` (2) w `npm run test:ui`
(371/371); `tsc --noEmit` czysty. Arkusze porównań voltviz | port | różnica w
`scratch/renders/voltviz/` (`icons-*.png`, `halftone-*.png`, poza repozytorium).

Na żywo (10.11): lista VoltViz ma 106 pozycji (49 wizualizacji, Your Logo, Halftone Pulse z 51 wyborami pod dwoma nagłówkami); Icons i „Halftone Pulse — kształt: Gwiazda” rysują przy muzyce.

## 10.11.2026 (5) — AVS: kod presetów jako WebAssembly, każda klatka identyczna co do bitu; wyciek presetów w długiej sesji

Bez migracji. Bez nowych zależności; CSP bez zmian (`'wasm-unsafe-eval'` było już dla MilkDropa).

**Kod presetów (EEL) liczy się w WebAssembly** (`avs/eel-wasm-backend.ts`):
- każda instancja kodu dostaje moduł wasm budowany bajt po bajcie z tego samego drzewa składni,
  które `eel.ts` zamienia w domknięcia — żaden tekst źródłowy nie jest wykonywany;
- te same działania w tej samej kolejności, te same granice pętli, ta sama osłona przed NaN
  i nieskończonością; `fistp` to `f64.nearest`, `%` `&` `|` `~` `<<` `>>` na i32/i64 z regułami
  `eel-math.ts`; funkcje trygonometryczne, `pow`, `exp`, `log` to te same funkcje `Math`,
  importowane (V8 woła je z wasm bez przejścia przez JS), a `rand`, `gettime`, `getosc`,
  `getspec` i `gmegabuf` — te same funkcje JS co dotąd;
- rejestry `reg00…reg99`, zmienne i `megabuf` w jednej pamięci na wczytany preset; rejestry są
  akcesorami banku, więc instancje wasm, instancje na domknięciach i host APE widzą to samo;
- moduły powstają między klatkami i kompilują się w tle, a do tego czasu liczą domknięcia; potem
  stan przechodzi do pamięci między dwoma uruchomieniami — pierwsza klatka po wczytaniu presetu
  nie jest wolniejsza;
- wszystko, czego slot pamięci nie odda dokładnie (zmienna o nazwie składowej instancji jak `init`,
  wartość inna niż liczba zapisana przez efekt, inny bank rejestrów, klon), zostaje przy domknięciach
  albo do nich wraca, razem ze zmiennymi i `megabuf`; bez WebAssembly albo bez pamięci wasm liczą
  domknięcia;
- SuperScope i Texer II czytają zmienne punktu prosto ze slotów pamięci (`EelPort`), bez szukania
  właściwości na obiekcie słownikowym.

**Wydajność** (świeża strona na preset, 10 klatek pominiętych, 20 mierzonych, lista 165 presetów
z rundy 3):

| | przed | po |
|---|---|---|
| 1280×720, mediana (165 presetów) | 16,8 ms | 8,7 ms |
| 1280×720, średnia | 39,4 ms | 25,6 ms |
| 1280×720, presetów wolniejszych niż 30 kl./s | 47 | 28 |
| 1280×720, ponad 100 ms / ponad 200 ms | 13 / 4 | 11 / 2 |
| 320×180, mediana | 11,4 ms | 4,3 ms |
| 320×180, presetów wolniejszych niż 30 kl./s | 12 | 1 |
| długa sesja (165 presetów w jednej stronie, 1280×720), mediana | 16,8 ms | 8,8 ms |
| długa sesja, presetów wolniejszych niż 30 kl./s | 47 | 28 |

Największe zyski (1280×720, świeża strona): micro-d — 3° number preset 947 → 132 ms, Zevensoft —
TwirlyColours 272 → 60, UnConeD vs Jaak — Sound rings remake 81 → 36, Raz — 10 Wireframe 68 → 14,
da7id — superscope cross 61 → 25, 08 mutáns mogyoró 59 → 8,9, Synth-C — Inverse Eruption 48 → 3,6,
vflorelo — Quite simple 33 → 3,9. Żaden preset nie jest wolniejszy (o ponad 15 % i 2 ms) w świeżej
stronie przy żadnym rozmiarze; dwa „wolniejsze” z długiej sesji (zamuz — visions vi, Mr_Nudge — 05Mr
DJ) to odstające pomiary bazy — powtórzone po 3 i 10 razy wychodzą tak samo w obu buildach. W części
wolnych presetów czas idzie na plotter (`avsDraw.ts`), nie na kod: Raz — Peace And
Love, Raz — 01 Introduction, Nic01 — Swirling Mass i Particle Cube, „just like el-vis taught me”
(×4) — to następny kandydat.

**Wyciek w długiej sesji** (sprzed tej zmiany): bitmapa w pamięci podręcznej `ResourceManager`
trzymała przez `onload` komponent, który o nią poprosił, a z nim cały poprzedni preset. W jednej
stronie po 165 presetach sterta JS po pełnym GC rosła z 201 do 1 670 MB; z wasm zatrzymane presety
trzymały też rezerwacje pamięci wasm i po 1 200–2 300 presetach w przeglądzie `new
WebAssembly.Memory` odmawiał (1 207 wyjątków w klatkach). Teraz `getImage` zdejmuje obsługę zdarzeń,
gdy zadziała: po GC żyje pamięć tylko bieżącego presetu (sterta 180–280 MB; do ok. 800 MB po Raz —
01 Introduction, bo tablice plottera zostają w największym użytym rozmiarze), z wasm i bez; brak
pamięci wasm zostawia instancję przy domknięciach zamiast wyjątku.

**Każda klatka identyczna co do bitu:**
- test różnicowy `eel-wasm-backend.test.ts` (w `test:ui`): 600 wygenerowanych programów obu
  dialektów, każde działanie na 45 × 45 wartościach brzegowych, granice pętli, kolejność argumentów
  `memset`/`memcpy`, idiomy AVS, przejście w tle; łapie każdą z 18 celowo wprowadzonych pomyłek;
- kod wszystkich 12 755 presetów z kodem (80 516 instancji, 69 648 w wasm) oboma drogami w Node:
  0 różnic w zmiennych, rejestrach, `megabuf` i `gmegabuf`;
- sumy klatek (20 klatek od wczytania, świeża strona na preset) przed i po: 165 ze 165 presetów
  listy przy 1280×720, 12 z 12 z FyrewurX przy 1280×720 i 300 z 300 losowych przy 640×360 — w obu
  trybach: z kompilacją od razu (wasm od pierwszego uruchomienia każdej sekcji, także init) i w tle,
  jak na stronie (pierwsze klatki domknięcia, potem przejście). W pierwszym przebiegu (12
  przeglądarek naraz) 163–164 ze 165, 10–11 z 12 i 295–297 z 300; każdy różny powtórzony pojedynczo
  dał te same klatki co baza — także baza sama ze sobą różni się w takim przebiegu (2 z 12 presetów
  FyrewurX). Magic Chords III w trybie w tle: 34 z 35 przebiegów identycznych, a w różnym zmienne
  kodu Bump (jedyny kod EEL presetu) były te same w każdej klatce;
- przegląd wszystkich 13 982 presetów (320×180, 90 klatek, wasm od pierwszego uruchomienia):
  0 wyjątków i 0 komunikatów (baza tak samo), czarnych 160 i 160; skrót klatki 90 identyczny w 13
  787 z 13 971. 184 różne to w 173 presety z FyrewurX (statyczny generator wtyczki przenosi stan
  przez całą stronę), w 2 `gmegabuf`, w 9 kawałki, które po zawieszeniu ruszyły od innego presetu;
  wszystkie 195 (z 11 bez wiersza w jednym z przebiegów) puszczone w świeżej stronie dają klatki
  bazy — 25, które pod obciążeniem wyszły inaczej, powtórzone pojedynczo też (baza różniła się sama
  ze sobą w 3). Kod działał jako wasm w 13 341 presetach (82 765 instancji); przy domknięciach
  zostało 30 instancji ze zmienną `init`.

Na żywo (10.11, konto tymczasowe): preset z odzyskanej paczki Nic01 liczył w produkcji 34–58 instancjami WebAssembly — CSP strony to przepuszcza; w konsoli tylko znane wpisy.

## 10.11.2026 (4) — MilkDrop: kropki prostej fali, a z nimi Game of Life 3 i pięć innych presetów; przejścia po ośmiu klatkach jak w MilkDropie; AVS: 55 presetów z dwóch paczek VISBOT

Bez migracji.

**MilkDrop — kropki prostej fali.** Prosta fala rysowana kropkami (`bWaveDots`, 3 427 z 16 427
presetów) nie pojawiała się wcale: shader butterchurna nie ustawiał rozmiaru punktu
(`gl_PointSize`), który WebGL zostawia nieokreślony, a Chrome (ANGLE) nie rysuje wtedy nic.
Teraz to punkty jednopikselowe jak w `DrawWave` MilkDropa, a cztery kopie przesunięte o piksel
(kropki 2 × 2, gruba linia) dopiero przy teksturze szerokiej na co najmniej 512 pikseli, jak
w MilkDropie — butterchurn rysował je przy każdej. Kropki fal własnych były już dobre.
- Lista wyłączonych presetów (`BROKEN_PRESETS`, sześć z audytu 07.11) jest pusta, bo wszystkie
  psuła ta jedna rzecz. Geiss — Game of Life 3, zasiewany wyłącznie kropkami fali, rysuje swoje
  kolonie; Snapshot Of Space (LSB mix), Burning Form (fire paint easter egg internals), Spiral
  Artifact i In death there is life (Geiss Layered Mix) nie gasną. chaos layered tokamak
  z czarnej klatki gaśnie tak jak w MilkDropie — jego reakcja rośnie z obrazu poprzedniego
  presetu, który w odtwarzaczu zawsze jest (poza pierwszym presetem po otwarciu); po innym
  presecie żyje i po 20 s.

**MilkDrop — przejście jak w MilkDropie 2 i 3.** Preset wczytywany z przejściem MilkDrop wczytuje
przez osiem klatek (`LoadPresetTick`) i dopiero potem rusza przejście; dotąd ruszało od razu.
Teraz przez osiem klatek rysuje sam stary preset, a przenikanie zaczyna się w dziewiątej
(sprawdzone klatka po klatce w Chrome). Sprite presetu MilkDropa 3 leży od pierwszej z nich na
starym obrazie, jak w MilkDropie 3 — to była pozycja „świadomie pominięte”. Wczytanie bez
przejścia jak dotąd od razu.

**AVS — dwie paczki VISBOT, których import z 09.11 nie otworzył** (pobrane ponownie za zgodą
właściciela, czytane jako dane, nic nie uruchomiono):
- HuRriC4nE — Pack1: archiwum na serwerze jest ucięte (270 000 z 345 268 bajtów, bez nagłówka
  7z). Strumień instalatora (BCJ x86 + LZMA) zdekodowany od swojego miejsca w danych daje 78%
  instalatora NSIS, a w nim cały skrypt i 17 z 20 plików — wszystkie 10 presetów i 2 bitmapy,
  których używają (brakuje tylko dźwięku i wtyczki ekranu powitalnego).
- Nic01 — Nic03 - 2D vs 3D: stary instalator Clickteam. Łańcuch jego bloków i odmianę deflate
  (4-bitowe nagłówki bloków, kolejność kodów długości 18, 17, 16, 0…15, bloki bez kompresji bez
  NLEN) odczytano z kodu programu statycznie i napisano od nowa w Pythonie; wszystkie 46 plików
  zgadza się z rozmiarami ze spisu: 45 presetów i deinstalator (pominięty).
- Żaden z 55 nie dubluje presetu, który już był; panel ma teraz 14 037 presetów. Przegląd 55
  nowych (320×180, 90 klatek): wszystkie się wczytują i liczą bez wyjątku, żaden nie jest czarny
  ani stojący. Narzędzia: `scratch/avs-reference/visbot/recover-1011/`.

**Sprawdzone:** `test:ui` 378/378, `tsc` czysty, bramka z audytami 10/10. Na żywo w Chrome
(konto tymczasowe, skasowane razem ze śladami w `audit_log`, `auth_attempts` i licznikiem
odtworzeń utworu, który grał): przy muzyce Game of Life 3 rysuje kolonie komórek, VoltViz ma
106 pozycji z Icons i wyborami Halftone Pulse, „Nic01 - The Intro” z odzyskanej paczki pokazuje
swój napis „Nic01 Presents 2d vs 3d” i liczy w WebAssembly; w konsoli tylko znane wpisy.

## 10.11.2026 (3) — AVS: FyrewurX jako wierny port wtyczki; wydajność ×4 bez zmiany ani jednego piksela

Bez migracji. Zgoda właściciela na statyczną analizę wtyczek z archiwum VISBOT.

**FyrewurX** (APE „FunkyFX”, 522 presety, 1129 użyć) to teraz wierny port binarki `fyrewurx.ape`
z paczki Rocky AVS II w archiwum VISBOT (45 056 B, zbudowana 28.11.1999) — czytanej wyłącznie
statycznie (`dumpbin`, Python `-I`), nigdy nie uruchomionej; archiwum i plik usunięte.
- Wtyczka pamięta szczyty widma i na beat (najwyżej co 100 ms, powyżej progu) wyrzuca do 300 iskier
  z losowego punktu (najwyżej 1000 naraz); iskra to blok 3×3 **w kolorze z ustawień presetu** —
  dawne odtworzenie ignorowało kolor i rysowało pomarańczowe kropki.
- Losowanie to własna kopia `rand()` z MSVC w binarce: ziarno 1, bez ponownego siania, wspólna dla
  wszystkich wystąpień — port ma tę samą sekwencję i kolejność losowań; co do bitu do 480 linii,
  wyżej skalowane jak inne efekty pikselowe.
- Port leży w `vendor/avs-apes/` (11 testów) i działa przez gospodarza wtyczek; bez niego zostaje
  dawne odtworzenie. Pominięte tylko nieużywane tryby emitera (na sztywno 0) i okno ustawień;
  czas działania systemu, który czyta wtyczka, zastępuje stałe przesunięcie (dotyczy tylko 2 s
  pierwszego beatu).
- Przegląd: wszystkie 522 presety wczytują się i rysują bez błędów; po wycięciu FyrewurX 40 z 43
  presetów próbki zgadza się ze wzorcem (mediana 0,0) — dwa różnią się brakiem Text we wzorcu,
  a „Magic Chords III” błędem Bump we wzorcu (nasz wynik zgodny piksel w piksel z portem
  `r_bump.cpp` w numpy).

**Wydajność — każda klatka identyczna co do bitu** (sumy klatek przed i po: 165/165 wolnych
presetów, 298/298 losowych, 12/12 z FyrewurX):
- kolejne Texery II dzielą jedną kopię klatki, a ich ścieżka „resize” liczy się na karcie
  graficznej tą samą arytmetyką całkowitą (98% Texerów II w presetach) — Hboy — 01 Intro:
  642 → 28 ms na klatkę;
- bufory wypełniane co klatkę są `DYNAMIC_DRAW` — znika spowolnienie, które narastało z każdym
  kolejnym presetem w tej samej stronie (po 40 presetach jedno wywołanie zajmowało ok. 125 ms);
- linie i kropki trafiają do GPU taniej (odejmowanie 2 jednym rysowaniem).

| | przed | po |
|---|---|---|
| 1280×720, mediana (165 najwolniejszych) | 65,0 ms | 16,4 ms |
| 1280×720, presetów wolniejszych niż 30 kl./s | 120 | 46 |
| 320×180, mediana | 21,5 ms | 11,4 ms |
| długa sesja w jednej stronie, mediana | 114,5 ms | 16,8 ms |

W pozostałych wolnych presetach czas idzie na sam kod presetu (EEL), nie na rysowanie.

**Konwerter:** ustawienia starszego formatu Effect List są czytane jak w `r_list.cpp` (dotąd o 4 bajty
obok) — lone — Shirka's eye znów rysuje, a 28 presetów nie dostaje fałszywego „włącz na beat”.
Z 24 presetów czarnych w krótkim teście 22 rozjaśnia się w ciągu 600 klatek, a VISBOT VC001 01
intro jest czarny jak w AVS, bo brakuje `VISBOT.AVI`.

## 10.11.2026 (2) — MilkDrop 3: sprite'y próbkowane jak w programie 3.37; presety z GIF-em działają

Bez migracji. Zgoda właściciela na ponowne pobranie oficjalnego `MilkDrop3.exe` (rozmiar i SHA-256
zgodne z wydaniem na GitHubie) wyłącznie do analizy statycznej — nigdy nie uruchomiony, potem
skasowany razem ze wszystkim, co z niego wyjęto.

- **Obraz sprite'a jak z D3DX:** rozciągnięty do potęgi dwójki, z pełnymi mipmapami; klucz koloru
  usuwa tylko nieprzezroczyste teksele w tym kolorze (D3DX porównuje też alfę). Klatka GIF ma jeden
  poziom w swoim rozmiarze.
- **Próbkowanie:** rysowanie sprite'a nie ustawia własnych stanów, więc dziedziczy etap 0 —
  filtrowanie trójliniowe bez anizotropii, adres WRAP po shaderze comp/warp i CLAMP po przebiegach
  rozmycia (bez shadera warp decyduje `wrap` presetu). Sprite ma teraz własny sampler WebGL według
  tych reguł.
- **Przejścia:** wczytanie presetu usuwa stary sprite od razu, a nowy od razu jest w pełni — nic
  się nie przenika; postęp przejścia nie dochodzi do rysowania sprite'a, a `progress` po twardym
  cięciu wynosi 0. Świadomie pominięte: MilkDrop 3 zaczyna wizualne przenikanie ok. 7 klatek po
  wczytaniu, u nas w tej samej klatce.
- **Naprawiony błąd:** sprite brał sampler zostawiony przez butterchurna (z mipmapami), a klatka
  GIF ma jeden poziom — tekstura była niekompletna i rysowała się na czarno. Presety „GIF test”
  i „GIF test2” pokazują teraz animację.
- Sprawdzone: konwersja bez błędów, 462 z 462 presetów MilkDropa 3 wczytuje się i rysuje,
  `test:ui` 362/362.

## 10.11.2026 (1) — VoltViz: „Your Logo” z logami właściciela i wersje WebGL; Geiss sam wraca do pełnej rozdzielczości; Cthugha-4-Winamp: generatory tablic; menu wizualizacji na telefonie

Bez migracji.

- **VoltViz „Your Logo”** działa z logotypami właściciela z ignorowanego `vendor/voltviz-logos/`
  (prywatne, nigdy w repozytorium). Logo PNG jest obrysowywane w przeglądarce (kontury przez
  marching squares, próbkowanie jak `getPointAtLength` w voltviz; na przezroczystym tle liczy się
  krycie, przy poświacie — tylko pełne litery, na jednolitym tle — różnica koloru), a SVG idzie do
  czytnika voltviz bez zmian. Panel ma jeden preset na logo, a Auto losuje jedno z nich. Bez
  katalogu „Your Logo” nie ma na liście.
- **VoltViz w każdej przeglądarce:** Pulsar, Oscilloscope, Daybreak i Blob Tracker mają wersję
  WebGL 2 (zamiennik części API WebGPU w `lib/webgl2.ts`, shadery WGSL przetłumaczone na GLSL ES
  3.00 funkcja po funkcji). Bez WebGPU (Firefox, starsze iPhone'y) lista znów ma 48 pozycji; gdzie
  WebGPU jest, rysuje dalej WebGPU, bo piksele różnią się tam, gdzie shadery losują skrótem z `sin`.
- **Geiss (Winamp)** po spadku obciążenia sam wraca do pełnej rozdzielczości: mediana okien po 30
  klatek jak `time_array` Geissa 4.30, krok w dół po ok. 1,5 s, w górę po 8 s, histereza i rosnące
  czekanie po nieudanym kroku w górę; rysunek co do bitu bez zmian. Sprawdzone pod sztucznym
  obciążeniem: 1280×720 → 992×556 w ok. 2 s i z powrotem ok. 11 s po końcu obciążenia.
- **Cthugha-4-Winamp** (vendor): preset „Tab generators” dostał 13 tablic z trzech generatorów,
  które właściciel pobrał 09.11 — Wintabs.exe (Tom Willaert, skompilowany QuickBASIC zgodny
  z dołączonym `wintabs.bas`), TABMAKE.EXE (Kasuha, `smoke.tab`) i Wintab.exe (Simon Werner, Turbo
  C++ z symbolami) — przeniesionych analizą statyczną programów DOS (nic nie uruchamiano).
  Niezależna implementacja w Pythonie daje te same pliki bajt w bajt; tablice powstają po 2 ms na
  klatkę. Preset ma razem 21 tablic.
- **Menu wizualizacji na telefonie** (09.11 wieczorem): po dotknięciu obrazu pasek przestawał się
  chować, bo podniesienie palca to dla przeglądarki też `pointerleave`, a ten przypinał pasek
  (pomyślany dla myszki, która zjeżdża z obrazu). Teraz reaguje na to tylko myszka, a po wyborze
  z listy na ekranie dotykowym lista oddaje fokus i pasek nie czeka 30 s.
- **Sprawdzone, bez zmian:** Oscilloscope z VoltViz bywa prawie płaski (np. „Sandstorm”), bo tryb
  Y-T „bass” pokazuje sygnał po filtrze 170 Hz ze stałym wzmocnieniem — tak samo jak w oryginale
  voltviz; dźwięk jest podawany prawidłowo.

## 09.11.2026 (7) — AVS: 22 wtyczki z plików binarnych, AVI, AVS Trans, błędy silnika znalezione na nowych paczkach

Bez migracji. Zgoda właściciela z 09.11 na statyczną analizę wtyczek z paczek VISBOT.

**Wtyczki.** 22 wtyczki bez kodu źródłowego (13 APE i 9 wizualizacji Sonique SVP) przeniesione wyłącznie
ze statycznego odczytu ich plików (`dumpbin`, Python `-I`) — nic nie zostało uruchomione ani
wczytane, a wyjęte pliki skasowano; porty leżą w `vendor/` (ignorowane):
- SVP: voronoi, ball, miffo, xoo, smear, starwave, blaze, liquid, beatpipe (65 presetów);
- Buffer Blend (30), uberCLS (11), 3DAPE (11), Flock Off (10), VisFrac (10), Nullsoft TV (6),
  Geiss Fluid (6), Screen Reverse (4), Plasma BOX (3), Tentacles 3D (2), Amoeba (2), Metaballs 3D (1).

W silniku są wtyczki ze źródłem: Normalise (38; dodatkowo port z pliku binarnego w `vendor/`), Multi
Delay (z `r_multidelay.cpp`), Texer v1 (308 presetów), AVI (niżej). Stare wersje Starfield, Text,
Mosaic i Bump są aliasami efektów AVS. Żaden z 148 presetów z APE i 66 z SVP nie jest czarny;
nie dało się odzyskać tylko ostatnich bitów matematyki x87, ziarna z `GetTickCount`, zewnętrznych
tekstur Liquid, tekstu GDI w smear i ścieżki 3DNow! w VisFrac (opis każdej wtyczki:
`scratch/avs-reference/apes/*.md`).

**AVI** (47 presetów) działa jak w `r_avi.cpp`: mieszanie, beat i licznik „persist”, prędkość
w ms i krokowanie klatek. 22 klipy z archiwów (Indeo 3/5 i surowe) leżą jako atlasy klatek WebP
w `vendor/avs-videos` (9 MB); klip dostaje 45 presetów.

**AVS Trans** czyta presety jak oryginalna wtyczka w trybie domyślnym (EXEC) z ns-eel 2.81; jako
EEL2 zostały tylko 3 z 73. Na próbce 7 z 8 zgadza się ze wzorcem.

**Błędy naszego silnika** znalezione bisekcją na 15 presetach, które były czarne tylko u nas
(14 zgadza się teraz ze wzorcem, 10 co do piksela):
- pola komponentów kasowały to, co ustawił `init()`, więc Texer v1, AVI, porty wtyczek, Multi
  Delay i linia w Clear Screen w ogóle nie działały w przeglądarce (nowy test na ten wzorzec);
- Dynamic Movement w trybie biegunowym przelicza `d` i `r` po każdym punkcie, jak AVS (156 presetów);
- `sin`/`cos` poza zakresem ±2^63 zwracają argument jak x87;
- Add Borders: rozmiar w procentach klatki, nie w pikselach (478 presetów);
- `gettime(s)` dla `s` ≠ 0 liczył czas od 1970 roku (232 presety);
- listy efektów mieszane przez bufor używają arytmetyki MMX (1297 presetów).

**Plotter linii** nie kopiuje już całej klatki: tryby dokładne rysują wprost w klatce, a pozostałe
kopiują tylko zapisany prostokąt — z tymi samymi klatkami co bit. Przy 1280×720 najcięższe presety
z SuperScope są do pięciu razy szybsze („The great escape” 476 → 94 ms, metatron 68 → 17 ms);
przy 320×180 zysk jest mały, bo koszt leży gdzie indziej.

Sprawdzenie: wszystkie 720 presetów, których dotyczyła ta runda, wczytuje się i działa;
`test:ui` 345/345, testy wtyczek 189/189.

## 09.11.2026 (6) — AVS: 13 600 presetów z całego archiwum VISBOT

Bez migracji. Zgoda właściciela z 09.11 („dokładaj”).

**Import.** Archiwum visbot.net/archive (88 autorów, 569 paczek: 536 `.7z`, 33 `.zip`, 73,6 MB,
plus `default_presets` Nullsoftu) przeczytane wyłącznie jako dane — z instalatorów NSIS 1.x i 2,
PiMP i samorozpakowujących się zipów wyjęte same pliki `.avs` i obrazki, których presety używają;
**nic nie zostało uruchomione**, wszystko czytał Python `-I`. Pominięte: pliki APE/DLL/EXE wewnątrz
instalatorów (nigdy nie wyjęte), readme, `.ini`, `.wav`, `.avi`, skórki Winampa, czcionki (Text
używa czcionek systemowych) i nieużywane bitmapy; paczka HuRriC4nE Pack1 (archiwum ucięte na
serwerze) i Nic01 „2D vs 3D” (nierozpoznany format instalatora). Z 17 515 presetów doszło 13 600
— reszta to kopie między paczkami (2399), powtórki w paczce (1515), presety już obecne (363)
i jeden uszkodzony. Paczki leżą w `frontend/vendor/avs-presets/<autor>/<paczka>` (ignorowane)
z `SOURCE.txt` w 553 miejscach.

**Wynik:** 13 982 presety w 96 paczkach. Build pakuje je w indeks (565 kB) i 1012 kawałków
ładowanych na żądanie; preset wczytuje się w ok. 35 ms (mediana). Panel wybiera jak w MilkDropie:
wszystkie paczki albo jedną. Przegląd w przeglądarce: wszystkie nowe presety się wczytują
i działają, 13 443 rysuje obraz; na losowej próbce porównanej ze wzorcem 38 z 39 jest zgodnych
(mediana 0,2).

**Silnik i konwerter:**
- **Nowe efekty:** Framerate Limiter (69 presetów).
- **Zgodność z AVS 2.81:**
  - Video Delay działa jak w AVS 2.81 (282 presety);
  - przesunięcia Text są czytane ze znakiem (1236 efektów);
  - kod Effect List jest rozpoznawany po nazwie (4 presety odzyskały kod listy).
- **Obrazki:** dwie paczki z tą samą nazwą pliku dla różnych obrazków dostają osobne kopie.
- **Wydajność:** dokładne mieszanie gęstych linii zajmuje 3,75 ms zamiast 218 ms na klatkę.
- **Kod:**
  - notatki autorów w kodzie (za twardą spacją, `£`, `·`, `©`) są pomijane, jak robił to ich AVS —
    ożyło 1983 sekcji kodu w 261 presetach, a wiodąca twarda spacja nie zabija już 650 sekcji;
  - 73 presety z nawiasami w składni AVS Trans są czytane jak EEL2.

## 09.11.2026 (5) — Roadmapa wycofana; całość sprawdzona na żywo

Bez migracji. „Całą roadmapę też zrobisz; jak będzie kompletna, to usuń — a to, co warto wiedzieć
na przyszłość, zostaw sobie”.

**`docs/ROADMAP.md` usunięty**, bo wszystko, co w nim stało, jest zrobione (wpisy 08.11 (11)–(14)
i 09.11 (1)–(4)). Wiedza z niego ma jedno miejsce:
- **`ARCHITECTURE.md`**:
  - „Świadome decyzje projektowe”, w tym nowe: miękki limit logowania per konto, jawna odpowiedź
    rejestracji bez aktywacji, limit 500 pozycji w linku gościnnym;
  - „Poza zakresem”;
  - aktualny zakres migracji (`001`–`044`).
- **`FRONTEND.md`**: co jest niemożliwe do zrobienia wiernie, z powodem — dla AVS, MilkDropa,
  Geissa i „Klasyki retro” — oraz uzasadnienie, czemu progi responsywne nie są ujednolicone.
- **`TESTING.md`** (lokalnie, poza repozytorium):
  - lista „Czeka na właściciela” jako jedyna lista otwartych spraw — tylko rzeczy wymagające
    uprawnień, prawdziwego urządzenia albo decyzji;
  - topologia tej instalacji;
  - przebiegi w tle (cache napisów, worker metadanych);
  - nowe pułapki.
- Odwołania poprawione w `README.md`, `FRONTEND.md`, `TESTING.md` i nagłówku tego dziennika.

**Sprawdzenie na żywo** (`http://localhost/`, świeży build, konto tymczasowe skasowane po teście
razem z wpisami; testowy utwór 66 min słuchany krócej niż próg 15%, więc licznik odtworzeń nie
drgnął):
- **Panel:** jest wszystkie 10 trybów.
- **Wizualizacje:**
  - Geiss (Winamp) z selektem „Głębia koloru” (domyślnie 32 bity) i 25 mapami;
  - „Klasyka retro” z 81 presetami w sześciu grupach — Cthugha 5.3 i glcthugha z `vendor/` grają;
  - Shadery: ghostly (wideo) i starship (kokpit);
  - MilkDrop z paczką „MilkDrop 3” i presetem podwójnym.
- **VoltViz Vinyl:** płótno ma `z-10`, ale pasek panelu leży nad nim i każdy z 9 przycisków
  przyjmuje kliknięcie. „Znikanie” to samoczynne chowanie paska po chwili bezruchu; ruch myszy
  go przywraca.
- **AVS:** przy głośności 5% reaguje tak samo jak przy 80% (analizator stoi przed głośnością).
- **„Ulubione”:** presety z trzech silników (AVS, Geiss, Shadery) przenikają się przy zmianie.
- **„Moje konto”:** w ustawieniach jest pole nazwy urządzenia.
- **Skan źródła filmów** — ostatni był 16.08: najpierw próbny, potem zapisany. 56 nowych plików,
  46 znikniętych wycofanych (m.in. „Outer Banks”), 0 błędów, 3 s. 51 nowych filmów zbadanych
  workerem metadanych w 4,4 s; z 4 nowych dzieł 2 dostały gatunek i rok, 2 czekają w przeglądzie.
- **Panel administracji:**
  - lista 5 nieczytelnych plików ma przyciski „Spróbuj ponownie”;
  - 61 zadań metadanych ze skanu przeszło nowym workerem w niecałe 20 s.

## 09.11.2026 (4) — AVS: 280 z 303 presetów zgodnych ze wzorcem, bez różnic silnika

Bez migracji. Ciąg dalszy wpisów (5)–(6) z 08.11: wzorzec (grandchild/vis_avs) i nasz silnik
doprowadzone do zgodności z Winampem/AVS 2.81. Narzędzia, poprawki wzorca jako `diff` (2150
linii) i opis: `scratch/avs-reference/` (lokalnie).

**Wynik** (klatki 150 i 300, „zgodny” = wynik poniżej 15):

| | 08.11 rano | 09.11 rano | teraz |
|---|---|---|---|
| Anthology i 8_ronin (303) | 154 z 247 renderowanych, mediana 9,8 | 253, mediana 2,3 | **280, mediana 0,1** |
| starsze (62) | 19 z 39, mediana 17,8 | 45, mediana 3,7 | **53, mediana 0,5** |

Wzorzec renderuje wszystkie 365 presetów (wcześniej 286), a ślad losowań `rand()` zgadza się
w 362 z 365.

**Wzorzec:**
- **Dźwięk jak Winamp 5 i AVS 2.81:** najnowsze 576 próbek i bajty `vsa_addpcmdata` przez
  `g_logtab`, także w pierwszej klatce. Wcześniej fala była opóźniona o 447 próbek, a widmo
  liczone z przepełnionych tablic.
- **`rand()` z biblioteki C.**
- **Cztery błędy pamięci** znalezione AddressSanitizerem.
- **Poprawione w nim samym:**
  - Starfield, bufory globalne, Movement „none”, mysz, linie ukośne, Interferences, Dot Fountain;
  - Mirror (przepisany z `r_mirror.cpp`);
  - mieszanie i kolejność zmiennych Dynamic Movement, DDM, Color Modifier i Dynamic Shift;
  - kolor SuperScope i Simple, tryb linii „adjustable” i reset trybu linii co klatkę.

**Nasz silnik — piksel w piksel jak oryginał** (każda różnica znaleziona bisekcją komponent po
komponencie w obu silnikach i przeniesiona ze źródeł 2.81):
- **Dźwięk i składnia:**
  - bajty Winampa (`winamp-visdata.ts`, zgodne ze wzorcem w 300 z 300 klatek); z nich korzysta
    też mapa 10 Geissa;
  - składnia EEL2 z `memset`/`memcpy`/`freembuf` (`eel2-parser.ts`);
  - sekcja kodu, której AVS 2.81 nie skompilował, nie robi nic, jak `NSEEL_code_compile`
    (`ns-eel-syntax.ts`).
- **Efekty:**
  - Texer II na procesorze jak MMX oryginału; czarna ramka Bump; Picture skalowany jak
    `StretchBlt` (zmierzone na GDI);
  - FyrewurX z własną kostką (z kostki AVS-a rozjeżdżał losowania 40 presetów); Starfield jak
    `r_stars.cpp`;
  - Mirror (125 presetów), Grain;
  - SuperScope rysowany przez `line()` AVS-a, z `drawmode`/`linesize` dla punktu i `w`/`h`
    zerowanymi co klatkę;
  - Dynamic Movement odtwarza siatkę 16.16 z `r_dmove.cpp` bit w bit, a piksele kończy GPU:
    4 ms zamiast 85 ms na klatkę przy 720p dla presetu z czterema DMove;
  - Dynamic Shift, Roto Blitter (122 presety), Blitter Feedback (84);
  - mieszanie „adjustable” jak MMX Winampa; Buffer Save „restore” pustego bufora nic nie robi.
- **Konwerter:** kod Bump miał zamienione „na klatkę” i „na beat” — we wszystkich 106 Bumpach
  światło ruszało się tylko na beat.

**Rozstrzygnięte przypadki:**
- **Hboy — Orifice:** AVS 2.81 grupuje `dirx*w%w/w*2-1` jako `((((dirx*w)%w)/w)*2)-1` (dowód
  z tablic jego parsera); EEL2 wzorca liczy najpierw `w%w`, więc biały ekran był tylko we
  wzorcu — nasz obraz jest właściwy. Pułapka w `TESTING.md` poprawiona.
- **TroubleShooter — Nothing** był po naszej stronie (Roto Blitter) i już się zgadza.
- **Nixa — water** zgadza się (3,5).
- **(Triple RMX) Chess** i **disco ma cubism** różnią się tylko FyrewurX-em, którego wzorzec nie ma.

**32 pozostałe niezgodności — żadna nie jest różnicą silnika:**
- brak Text we wzorcu: 4, plus 6 z jeszcze inną przyczyną;
- FyrewurX, bez oryginału do porównania: 8;
- EEL2 wzorca wykonuje kod, który 2.81 odrzucał w całości: 8;
- EEL2 inaczej grupuje operatory: 3;
- EEL2 inaczej czyta `.` i obcina `&`/`%` tam, gdzie 2.81 zaokrągla: 4;
- chaotyczne rozejście z drobnych różnic float (x87 wobec JS): 5.

Tabela w `FRONTEND.md`, sekcja AVS „Stan”.

## 09.11.2026 (3) — Nowa wizualizacja „Klasyka retro”: Cthugha z glcthughą, Atari Video Music, 19 trackerów, VSG+

Bez migracji. Odpowiedź na „fomalhaut — a możesz odwzorować?” i „Cthugha98, Cthugha-4-Winamp
i VSG możesz odbudować samodzielnie”. Kodu fomalhauta (zastrzeżony) nie użyto — tylko jego
README i zrzuty do porównań.

Nowa wtyczka `retro` odtwarza pierwsze wizualizacje muzyki: 79 presetów w siedmiu grupach z `vendor/`
(65 bez niego — wtedy Cthugha98 i Cthugha-4-Winamp grają jako odtworzenia, a portów Cthughi nie ma).
Wspólny szkielet to analiza obu kanałów, prezenter „sharp bilinear” z wykończeniem TV, Auto,
ulubione i przenikanie jak w innych wtyczkach. Arkusze z odnośnikami (lokalnie):
`scratch/renders/retro/`.

- **Cthugha — wierne porty, wyłącznie w `vendor/`:**
  - **Cthugha 5.3 (DOS):** płomienie przetłumaczone z asemblera x86 instrukcja po instrukcji,
    320 × 200 w 70 kl./s; zmiany, obrazki, tablice przesunięć i napis w ciszy („Wheres the
    music?”) działają jak w oryginale, który zawsze zaczynał od tej samej kombinacji. Kawałek
    5.3 to 2,1 MB (870 KB gzip), wczytywany dopiero przy pierwszym presecie 5.3.
  - **Cthugha-L 1.4:** linia po linii, 25 kl./s — 18 płomieni, 29 fal, 13 sposobów wyświetlania
    z trzema widokami 3D, tablice przesunięć z programów `tab/`, 178 palet, obrazki PCX,
    AutoChanger i napisy w ciszy. Dwa ewidentne błędy oryginału poprawione (wysokie obrazki
    rysowane od złej linii, mieszanie tablic przy wczytywaniu).
  - **glcthugha** (OpenGL Cthughi-L): wszystkie 17 wyświetleń 3D (Plate, 2Plates, Plane, dPlane,
    2Planes, Wave1, Wave, Height, Cross, CWave, NearRing, Tube, SHeight, 2D-Big, 2D-Quad, Sphere,
    Cones) z trzema buforami, światłem, tłem z obrazków, „fly” i mgłą, rysowane przez WebGL 2 przez
    mały emulator OpenGL 1.x — porównane ze zrzutami autora z lat 1998–99 (nowsze miały zamienione
    kanały czerwony i niebieski). Sphere i Cones idą za GLU Mesy 3, którego źródła z 1998 nie dało
    się pobrać.
  - Licencja Cthughi pozwala tylko na użycie niekomercyjne z podaniem autorów (Torps
    Productions, Harald Deischinger), więc oba porty leżą wyłącznie w ignorowanym
    `frontend/vendor/cthugha` i dochodzą przez `virtual:retro-cthugha`; bez folderu grupa znika
    z builda bez śladu.
- **Cthugha98 0.6a (z wersją 3Dfx) i Cthugha-4-Winamp 1.50 — wierne porty z kodu maszynowego,**
  tylko w `vendor/`. Źródeł nie ma, więc właściciel pobrał oryginalne programy (zipy z Wayback
  Machine, sumy SHA-256 w `vendor/cthugha/SOURCE.md`), a agent przeczytał je wyłącznie statycznie
  (`dumpbin`, Python) — nic nie zostało uruchomione ani wczytane.
  - Cthugha98: 13 płomieni, 28 fal, 8 wyświetleń, przebiegi z cząstkami (rój, fontanna) i 65 map
    z paczek Cthughi 97, w 640 × 480; wersja 3Dfx pokazuje bufor jako obracany krajobraz 64 × 64
    albo chmurę punktów (60 kl./s, rasteryzacja i dither Voodoo jak w emulacji MAME).
  - Cthugha-4-Winamp: 16 płomieni, 20 fal, 4 wyświetlenia, zmiany na stopę, pięć tablic, które DLL
    liczy sam, 73 mapy, obrazki GIF i tytuł składany z liter 3D.
  - Zachowane dziwactwa oryginałów (m.in. „Kaleidescope” powtarza lewą połowę zamiast odbijać).
    Bez `vendor/` zostają dawne własne odtworzenia (MIT) na silniku `cthughalike/`; siedem
    identyfikatorów jest wspólnych, więc ulubione przechodzą. Nieprzeniesiona: Cthugha97 alpha 0.5
    (wcześniejsza wersja, zastąpiona przez 0.6a). Arkusz: `scratch/renders/retro/retro-v3-c98-c4w-port.png`.
- **Atari Video Music C240 (1977):** własna symulacja układu z patentu US 4,081,829, schematu
  i instrukcji obsługi (AtariAge). Detektor energii z filtrem pasmowym, pokrętło CONTOUR (10–238
  ms) daje miękkie albo geometryczne kształty, kolor z licznika przejść przez zero (tablica I
  patentu), a COLOR rysuje pierścienie koloru; obraz jak z telewizora. 10 ustawień, pierwsze to
  to, od którego każe zacząć instrukcja. Zależność opóźnienia od napięcia to nasz model,
  dopasowany do obrazków z instrukcji.
- **Trackery:** 19 programów z Amigi, DOS-u, Windowsa, C64 i Amstrada CPC (m.in. Ultimate
  Soundtracker, NoiseTracker, ProTracker 2.3, Future Composer, SidMon 1.0 i II, Oktalyzer, OctaMED,
  AHX, Scream Tracker 3.21, Fasttracker II, Impulse Tracker 2.14, Composer 669, ModPlug, JCH,
  Soundmonitor, Arkos), narysowanych od zera (20 presetów); nuty powstają z muzyki. „SidMon 2.1”
  z listy fomalhauta nie istnieje — są SidMon 1.0 (Reinier van Vliet, 1989) i SidMon II.
- **„Autorzy”:** napisy końcowe w stylu intr z Amigi i DOS-u z twórcami pierwowzorów (Cthugha, AVM,
  każdy tracker, VSG, Geiss), delikatnie reagujące na muzykę — odpowiednik ekranu „Credits”
  fomalhauta.
- **VSG+ (DOS):** własne odtworzenie 20 efektów w 640 × 480 i 16 kolorach; 14 z nich narysowane
  tylko według nazw, bo zrzutów nie ma.
- **Koszt:** klatka Cthughi 0,5–1,2 ms (glcthugha 0,5–4 ms), AVM ok. 2,2 ms, trackery 1,1–2,1 ms.
  Wszystkie presety sprawdzone w przeglądarce bez ostrzeżeń.
- **Nie da się, z powodem** (szczegóły w `FRONTEND.md`): 14 efektów VSG+ ze zrzutów (są tylko
  nazwy, programu nie ma nigdzie), edytora nut SoundMonitora (nikt go nie sfotografował) i krzywej
  opóźnienia AVM z pomiaru (potrzebny prawdziwy egzemplarz).
- **Rejestracja:** `registry.ts`, `CatalogActions.php`, tłumaczenia, testy (`test:ui` 300/300),
  `NOTICE.md`, `docs/FRONTEND.md`.

## 09.11.2026 (2) — Usługa: audyt domknięty, cache napisów jednym czytaniem filmu i 4K w rozmiarze autora, metadane jednym procesem, MicroDVD, odcinki numerowane liczbą

Migracja **043** (`attempts`/`retry_at` w kolejce tytułów), zastosowana jako root. Staging
zrestartowany skryptami `ps1`. Bramka 8/8 (Python 545 passed / 15 skipped, node 231/231).

**Audyt usługi (07.11) — zamknięte wszystkie średnie i niskie ustalenia:**
- wspólny limit krótkich sond FFmpeg (4 sloty, kolejka 15 s): 16 naraz żądań `stereo-keyframe`
  odpowiada `200` w 1,3 s zamiast uruchamiać 16 procesów;
- operacje na plikach w wątkach, `/health/ready` czeka najwyżej 5 s na źródło;
- osobne semafory napisów widza i przebiegu w tle — przebieg nigdy nie każe widzowi czekać;
- kolejka tytułów odporna na zły rekord z Filmwebu: pada tylko jego wiersz i wraca później
  z rosnącą przerwą, a przebieg staje dopiero po trzech „Filmweb nie odpowiada”;
- skan zapisuje porcjami, jedną transakcją na porcję;
- odcisk znika razem z podmienionym plikiem;
- `If-Range` z datą tylko przy równości, a nieznana jednostka `Range` jest ignorowana zamiast `416`;
- napisy będące dowiązaniami są pomijane;
- worker tytułów trzyma się wskazanego źródła;
- flaga restartu w statystykach wreszcie się zapala;
- `python -m media_server.cli …` działa (wcześniej po cichu nic nie robił).

**Cache napisów obrazkowych:**
- **Film jest czytany raz:** ścieżki są kopiowane bez dekodowania i rysowane z kopii, z tymi
  samymi cue i obrazami (klucz `pictures-v3` dla `.m2ts`/`.ts`/`.vob`, z zerem ustawianym przez
  obraz).
- **PGS ze strumienia transportowego** idzie do `.m2ts` w trybie Blu-ray, bo `.sup` odrzucał
  pakiet z uciętym segmentem i jeden taki kończył kopię całego filmu (wtedy każda ścieżka czytała
  40 GB od nowa). „Powrót króla” cz. 2 (40 GB, 23 ścieżki): 16 min zamiast ok. 75–90 min.
- **Napisy 4K w rozmiarze autora** (decyzja z 09.11): PGS płyt UHD jest w 1920×1080, więc zapisujemy
  go w tym rozmiarze, przycięty do proporcji filmu, z `scale` w manifeście i pod osobnym kluczem.
  Odtwarzacz skaluje go regułą `object-fit: contain`, jak odtwarzacz Blu-ray — sprawdzone, że
  obraz ląduje w identycznym prostokącie co wcześniej. To ok. 10× mniej procesora i 6× mniejsze
  pliki; wcześniej wyrenderowane ścieżki 4K zostają ważne pod starym kluczem.
- **Mniej procesora przy tych samych pikselach:** przebieg w tle daje skalerowi jeden wątek, a PNG
  idzie bez predykcji wierszy.
- **Skala:** katalog widział najwyżej 24 ścieżki napisów na film, a naprawdę czeka ok. 1343
  ścieżek. Pełny przebieg to ok. 5 TB czytania zamiast ok. 44 TB i ok. 8–12 h zamiast ok. 50–95 h.
  **Uruchomiony 09.11 o 07:49** (`root: all`, `mode: missing`), po poprawkach niżej wznowiony
  o 10:01 od zapisanego postępu.
- **Błędy pierwszego pełnego przebiegu** — policzył 48 i żadnego nie opisał:
  - 41 to pozycje katalogu, których nie ma już na dysku (folder „Outer Banks” i `greeninferno.mkv`).
    Skan źródła filmów (wpis (5)) je wycofał.
  - 7 to polskie napisy „The Pacific” zapisane w CP1250 w ścieżce Matroska, która z definicji jest
    UTF-8: FFmpeg je odrzucał, więc nie było ich ani w cache, ani u widza. Ścieżka, w której
    FFmpeg zgłasza niepoprawny UTF-8 w co najmniej co dziesiątym pakiecie, jest teraz czytana
    jeszcze raz jako CP1250; ścieżka UTF-8 z jedną uszkodzoną linią zostaje bez zmian.
    Sprawdzone 1932 polskie ścieżki już w cache — żadna nie zgubiła po cichu linii z polskimi
    literami.
  - 23 filmy przebieg ominął bez słowa, bo FFmpeg nie oddał opisu pliku w 12 s przeznaczonych dla
    widza (16 z nich w trzech minutach, gdy Windows zgłaszał brak wolnych portów sieciowych);
    wśród nich „Dwie wieże”, „Hobbit” i „Kac Vegas”. Przebieg w tle czeka teraz minutę, raz
    ponawia, a porażkę liczy jako błąd i film zostaje do następnego przebiegu.
  - Każdy błąd to jedna linia w logu usługi (`event: subtitle_cache_failure`: źródło, ścieżka,
    ścieżka napisów, kodek, stan, powód), a 10 ostatnich widać w statusie (`recent_failures`).
    Formatter logu gubił dotąd pola spoza stałej listy, więc logi skanu i workera metadanych
    nie miały `root` ani `error` — już mają.

- **Wynik pełnego przebiegu** (skończony 09.11 po południu): 6617 filmów, 2023 nowe ścieżki, w tym
  652 obrazkowe. Z 52 błędów 41 to wycofane już pozycje bez pliku, a 11 naprawiono i przeliczono
  osobnym zadaniem (11/11, bez błędów):
  - klipy menu Blu-ray (3 MB, sam strumień grafiki interaktywnej, „Happy Death Day”) są opisane,
    a nie błędne — „At least one output file must be specified” to stała linia `ffmpeg -i`, a nie
    powód;
  - cztery remuksy 4K nie dostały opisu w minutę, bo usługa z zadania Harmonogramu czyta dysk
    z niskim priorytetem I/O: za innym czytelnikiem dysku opis trwał do 26 s zamiast 0,2 s. Sondy
    FFmpeg (opis filmu, miejsce przewinięcia) podnoszą się teraz do normalnego priorytetu
    (`priority.py`), a `register-stage-task-windows.ps1` rejestruje zadanie z `-Priority 5`
    (normalny CPU i I/O). Właściciel zarejestrował zadanie ponownie 09.11 wieczorem; usługa działa
    z `io_priority: normal`. Tego samego wieczoru zarejestrował też zadanie przebiegu okresowego
    (`TryHackX Media Maintenance`: skan, metadane, gatunki — codziennie o 04:15).

**Worker metadanych** czyta porcję jednym procesem potomnym z limitem czasu na plik. Plik, który
zawiesi albo wywróci proces, kosztuje tylko ten proces, a reszta porcji idzie w nowym.
Zmierzone na 600 prawdziwych utworach z identycznymi wynikami: 377 ms → 28 ms na plik, czyli
12 841 utworów w ok. 6 min zamiast ok. 80.

**`.sub`:** MicroDVD obok filmu jest rozpoznawany po treści i oferowany jak inne napisy tekstowe.
Tempo bierze się z linii `{1}{1}fps` albo z sondy filmu (`24000/1001`, nie zaokrąglone 23,98).
VobSub świadomie nie: biblioteka filmów nie ma ani jednego `.sub` ani `.idx`, `.idx` nie podaje
proporcji obrazu, a jeden plik niesie kilka języków.

**Odcinki numerowane samą liczbą:** pliki numerowane samą liczbą w folderze, którego to zwyczaj
(reguła większości z `EpisodeOrder`), są odcinkami jego serialu, o ile nie mają własnego roku. Bez
tego warunku półki filmowe (Final Destination, John Wick, Zabójcza broń, Shrek, Toy Story) wzięłoby
za seriale. Decyzji człowieka reguła nie rusza, a wiersze kolejki bez plików znikają: „Akolita”
i „Ashoka” to 16 pytań zamienionych na 2.

## 09.11.2026 (1) — MilkDrop: wszystkie 15 970 presetów się kompilują i rysują; BeatDrop, MilkDrop 3 i `.milk2`

Bez migracji. Odpowiedź na pytanie „czemu się nie kompilują i czemu nie naprawić tak, żeby się
kompilowały”: dało się, przyczyna po przyczynie.

**Wynik:** build zawiera wszystkie 15 970 presetów sześciu paczek (wcześniej 15 749; 217
odpadało przy konwersji), a każdy z nich kompiluje się i rysuje w przeglądarce (wcześniej
15 373). Sprawdzone pełnym audytem w przeglądarce (bez głowy, WebGL 2, 60 klatek). Ciemnych po
60 klatkach jest 585 (wcześniej 779) — to nie błędy: część rozjaśnia się później albo czeka na
beat.

| paczka | skonwertowane | kompilacja | obraz |
|---|---|---|---|
| BeatDrop | 1 218 → 1 390 | 1 101 → 1 390 | 1 101 → 1 390 |
| Cream of the Crop | 9 754 → 9 795 | 9 539 → 9 795 | 9 520 → 9 795 |
| En D | 40 → 40 | 33 → 40 | 33 → 40 |
| MilkDrop (oryginał) | 552 → 552 | 545 → 552 | 543 → 552 |
| projectM classic | 4 185 → 4 189 | 4 178 → 4 189 | 4 176 → 4 189 |
| MilkDrop 3 (nowa) | – → 4 | – → 4 | – → 4 |

**Przyczyny i co z nimi zrobiono:**
- **Równania:** eel-wasm (kompilator równań butterchurna) to nie kompilator MilkDropa — inna
  gramatyka i priorytety, brak `?:`, `memcpy`/`memset` i liczb z wykładnikiem. Równania
  tłumaczymy teraz według semantyki ns-eel2 (preprocesor, priorytety, `invsqrt`, `freembuf`,
  zapis w pełni w nawiasach), eel-wasm dostaje dziewięć poprawek w czasie budowania, a build
  próbnie kompiluje każdy blok.
- **Shadery:** tłumacz HLSL (hlslparser-js) jest nieutrzymywany i ma luki, a WebGL jest
  surowszy niż Direct3D 9. Dodatkowe przepisania: pętle `for`, `#if` z wyrażeniami, operator
  przecinka (jak w kompilatorze D3DX — sześć presetów wygląda teraz jak w MilkDropie), indeksy
  float, inicjalizatory tablic, samplery z prefiksem i przez `#define`, macierze float4x3,
  funkcje bez `return`, przypisania do wierszy macierzy, mieszanie int/float i zapasowe shadery
  MilkDropa.
- **`pow`, `sqrt`, `rsqrt`, `log`** liczone tak jak kompilator MilkDropa z `d3dx9_31.dll`
  (sprawdzone wywołaniem tej biblioteki i odczytem asemblera we wszystkich profilach): z |x|,
  z mnożeniami zachowującymi znak tam, gdzie on je rozpisuje, i ze stałymi nazwanymi zwiniętymi
  jak w nim. Dzięki temu m.in. „XorDevs Corridor1” przestał być czarny.
- **Funkcje BeatDropa i MilkDropa 3** (157 presetów pomijanych dotąd przy budowaniu): 16 kształtów
  i fal, q1–q64, proste fale 8–17, tekstury FFT i fali w shaderach (`get_fft()`), macierze
  `rot_*`, mysz i zegar systemowy. Razem 43 poprawki silnika w
  `frontend/scripts/butterchurn-patches.mjs`; gdy łatka przestanie pasować do butterchurna, build
  staje i ją nazywa.
- **Wartości MilkDropa, które butterchurn podawał inaczej:** czas shaderów od startu presetu,
  `roam_cos`/`roam_sin` z częstotliwościami MilkDropa, `vol` jako 0,3333 · treb (literówka
  MilkDropa 2/3, do której presety strojono) i zmienna `progress`. Różnice BeatDropa (fale 0 i 6
  ze średniej kanałów, `vol` jako średnia, czas od startu programu) obowiązują tylko w jego
  paczkach.
- **Prawdziwie niekompilowalne** zostało tylko 13 bloków, których nie skompiluje też MilkDrop
  (11 równań ze składnią w rodzaju `below(rad,.-53)` i 2 shadery z nadmiarowym `}`); zachowują
  się jak w MilkDropie.

**MilkDrop 3 i `.milk2`** („możesz odbudować, odtworzyć”): `.milk2` to podwójny preset — dwa
pełne presety i nagłówek z jednym z 30 wzorów mieszania, postępem i kierunkiem. Build dzieli
i konwertuje obie połowy, a silnik zamraża przejście butterchurna w zapisanym punkcie wzorem
MilkDropa 3, z płynnym wejściem i wyjściem. Wzory napisane od nowa z opisu MDropDX12 (niczego nie
kopiując). Jedyne publiczne pliki `.milk2` (3 z Milkwave) tworzą nową paczkę „MilkDrop 3”
w `vendor/`.

**Tekstury** („czy będzie inaczej niż oryginał?” — tak, zwykle wyraźnie): uzupełnione
z publicznych źródeł (BeatDrop, mdpresetpack z SourceForge) w ignorowanym `vendor/`. Jest 147
tekstur, a wszystkie swoje dostaje 1 113 z 1 153 presetów, które ich potrzebują (wcześniej 910
z 1 076). Brakuje 20 nazw w 40 presetach BeatDropa: 19 to losowe zestawy postaci (703 MB, część
to postacie z filmów) — dołączone 09.11 na decyzję właściciela (prywatny odtwarzacz, użytek
niekomercyjny; obraz dociąga dopiero preset, który go używa). `Pattern_047` i cztery inne tekstury
przyszły z instalatora MilkDropa 3 (niżej), więc **wszystkie 1218 presetów, które sięgają po
tekstury, dostają je w komplecie** — lista brakujących jest pusta.

**Biblioteka MilkDropa 3 z oficjalnego instalatora** (zgoda właściciela 09.11 na jednorazowy wyjątek
od zasady „bez `.exe”): `MilkDrop3.exe` 3.37 z wydania na GitHubie, sprawdzony co do rozmiaru
i SHA-256 i **nigdy nie uruchomiony** — presety i tekstury wyjęte Pythonem z dwóch archiwów ZIP
w jego zasobach, sam plik skasowany. Paczka „MilkDrop 3” ma teraz 438 presetów: 147 podwójnych
`.milk2` i 291 `.milk` (101 powtórek z BeatDropa i projectM pominiętych przez porównanie treści);
wszystkie 438 kompilują się i rysują. Do tego dwie kategorie z GitHuba: 22 presety z paczki
MDropDX12 i 2 przeróbki shaderów XorDeva z XorPlayera (72 powtórki z innych paczek pominięte) —
paczka ma 462 presety, a build razem 16 428 i 553 tekstury.
Konwerter wycina bloki sprite'ów także z `.milk` i czyta tekstury `.jfif`.

**Sprite'y MilkDropa 3** (bloki `[SPRITE…]` w 115 presetach) są rysowane tak jak w MilkDropie 3.37,
według analizy statycznej jego programu (instalator pobrany ponownie za zgodą właściciela, nigdy
nie uruchomiony, potem skasowany): zasady czytania (`.milk` w wersji 300, `.milk2` z `sprite=1`
i drugim presetem), wartości domyślne, kod `code_N`, pięć warstw, wypalanie w obraz następnej
klatki, jedenaście trybów mieszania, klucz koloru i animowane GIF-y. 39 obrazków sprite'ów leży
w `vendor/`. Wzory przejść `corner`, `patches`, `stars2`, `arrow` i `plasma3` okazały się zgodne
z programem co do stałych; wzór liczy się teraz na siatce MilkDropa 3 (64 × 48). Ciemnych presetów
MilkDropa 3 jest 53 zamiast 58. Arkusze: `scratch/renders/milkdrop/`.

**Czego nie da się zrobić wiernie, z powodem:**
- (zrobione 09.11 po analizie statycznej programu MilkDrop 3.37 — niżej) bloki sprite'ów; zostało
  nieznane tylko filtrowanie obrazków sprite'ów w MilkDropie 3 i to, co pokazuje sprite w połowie
  przejścia; `jello2.png` (2 presety MDropDX12) nie ma nigdzie publicznie — ani w instalatorze, ani w repozytoriach MDropDX12 i Milkwave
- `.milk3` — to nie format MilkDropa 3, tylko kontener MDropDX12, i żaden plik nie jest publiczny;
- pięć wzorów przejść przepisanych w zamkniętym MilkDropie 3 PRO — nie ma z czym porównać;
- zmienne klawiatury `ctrl*` są zawsze 0, bo panel nie ma wejścia z klawiatury.

Koszt: mediana wczytania presetu wzrosła ze 164 do 217 ms.

## 08.11.2026 (14) — Wizualizacje: Geiss (Winamp) jako wierny port, Shadery z kompletem efektów

Bez migracji.

**Geiss (Winamp) — wierny port wtyczki Geissa** („wierny port Geissa… dawaj, rób”). Zamiast
„Geiss Classic” (podobieństwo w WebGL 2) panel ma „Geiss (Winamp)”: wtyczkę Ryana Geissa 4.30
przeniesioną z jej kodu (BSD) we wszystkich trzech głębiach koloru.
- **Domyślnie 32 bity, jak Geiss 4.30:** kolorowe fale, kropki, chasers i tytuł oraz belka
  z rozszczepieniem barw. Kolor 16-bitowy i klasyczną 8-bitową paletę wybiera się w selekcie
  „Głębia koloru” (miejsce, w którym MilkDrop ma paczki presetów; wtyczka nadaje mu nazwę przez
  `poolsLabel()`), a wybór jest zapamiętywany.
- **Zakres portu:** 25 map ruchu z ditherem pętli asemblerowej i MMX, fale 1–7, efekty
  (chasers, belka, kropkowy chaser, nuclide, siatka, cząstki słoneczne, shade bobs), losowe
  palety z przenikaniem, wykrywanie beatu, przesuwanie obrazu i tytuł utworu wypalany w obraz.
- **Dźwięk:** bajty, które Winamp dawał wtyczkom (`avs/winamp-visdata.ts`), więc mapa 10
  pokazuje prawdziwe widmo Winampa.
- **Presety to mapy** („1. Spirala”…„25. Głęboki zoom”). Auto to losowanie samego Geissa według
  jego gwiazdek; ulubione i przypinanie działają jak w innych wizualizacjach.
- **Zgodność:** klatki porównane z oryginałem skompilowanym ze źródeł (MSVC x86, atrapa
  DirectDraw) są identyczne co do bitu w 8, 16 i 32 bitach, na wszystkich mapach, falach
  i efektach, w czterech rozdzielczościach. Arkusze (lokalnie): `scratch/renders/geiss/`.
- **Koszt:** tryb 32-bitowy ok. 10 ms na klatkę przy 1312×708. Przy bardzo obciążonym procesorze
  obraz potrafi się zmniejszyć i wraca do pełnego rozmiaru dopiero po ponownym otwarciu panelu.
- **`GEISS.INI`** w 4.30 nie ma domyślnej zawartości (presety i napisy tworzy użytkownik
  klawiaturą), więc nie było czego przenosić. Świadomie pominięte: tryby 24-bit i 5-5-5 (tylko dla
  starych kart), wyłączona domyślnie synchronizacja koloru fali z dźwiękiem, klawiatura i ekrany
  pomocy.
- Wtyczka zachowała identyfikator `geiss-classic`, więc ustawienia przechodzą bez migracji.
  Nowe pliki: `frontend/src/shared/visualizations/geiss/` (`sim.ts`, `maps.ts`, `index.ts`,
  `LICENSE-geiss.txt`), `geiss.ts`, `geiss.test.ts`; usunięty `geiss-classic.ts`.

**Shadery: 41 z 41 efektów Monkey Hi Hat.** Doszły ghostly (czarno-biały film nałożony na obraz)
i starship (wizualizacja w oknach i na ekranach jednego z sześciu kokpitów) — brakowało ich, bo
build nie miał ani tych plików, ani obsługi wideo.
- Runner obsługuje tekstury wideo (film w pętli, bez dźwięku; `destroy()` go zatrzymuje
  i zwalnia teksturę), prawdziwe cubemapy krojone z układu krzyża jak w Monkey Hi Hat oraz
  `RandomTextureSync`, dzięki któremu obraz statku zawsze idzie w parze ze swoimi maskami.
- Z repozytorium Volt's Laboratory dołączono do `frontend/vendor/` (poza repozytorium) tylko
  57 obrazów i filmów, których używają presety: zdjęcia i szumy Shadertoy zastępują generowane
  zamienniki w 16 wizualizacjach i 6 efektach, a shard odbija prawdziwe panoramy Humusa
  (CC BY 3.0, uznanie autorstwa w `NOTICE.md`).
- Wszystkie 170 presetów się kompiluje; ghostly i starship reagują na muzykę.

## 08.11.2026 (13) — Front po audycie: „Moje konto”, losowanie, kolejka, napisy poza `t()`

Bez migracji. Ostatnie ustalenia frontu z audytu 07.11, każde sprawdzone w prawdziwej aplikacji.

- **„Moje konto”** buduje się raz i odmalowuje tylko zmieniony panel: zapis widoczności to jedno
  zapytanie zamiast dziewięciu, a przegląd importu, wpisane hasła i otwarta edycja listy
  przeżywają zmiany obok.
- **Losowanie i odtwarzanie:**
  - wyłączenie losowania na playliście odnajduje grający utwór poza wczytanym oknem (utwór 163
    z 300 gra dalej, następny to 164);
  - nieudane albo puste budowanie kolejki nie psuje kolejki, która gra;
  - „Odtwórz folder” zawsze wraca do życia.
- **Stan odtwarzacza:**
  - po F5 strona nie czeka na bilet strumienia;
  - `AudioContext` wizualizacji jest wznawiany po przerwaniu (iOS);
  - oś czasu nie zamarza po nieudanym przewinięciu w trybie zgodnym;
  - Escape po wyborze następnego odcinka zamyka podgląd na dobre;
  - panel kolejki zarządza fokusem (modal, powrót na przycisk „Kolejka”).
- **Wydajność kolejki:** zmiana utworu przesuwa znacznik zamiast przebudowywać 160 wierszy
  (z 5–10 ms do ok. 1 ms), a co 2,5 s zapisuje się ok. 150 B postępu zamiast 90–220 KB migawki;
  pełna migawka idzie tylko przy zmianie kolejki, utworu albo trybu.
- **Napisy poza `t()`** przetłumaczone (`format.ts`, `metadata-editor.ts`, `login.ts`, `admin.ts`,
  `account.ts` i inne; 17 nowych wpisów).
- **Progi responsywne świadomie bez zmian** — każdy stoi tam, gdzie treść jego komponentu
  przestaje się mieścić (np. 46 → 48 rem przełączyłoby dok na układ telefonu przy 768 px).
  Uzasadnienie i propozycja mapowania: `FRONTEND.md`; do zrobienia tylko razem z przeglądem na
  telefonie i tablecie właściciela.

## 08.11.2026 (12) — Most PHP po audycie; konta z poprawkami okładek da się usunąć; ponowienie nieudanych metadanych

Migracje **041** (`users.disabled_at`), **042** (`archive_manifests`) i **044** (`updated_by`
w nadpisaniach okładek i tagów z `ON DELETE SET NULL`), zastosowane jako root. Bez przeładowania
Apache. Sprawdzone przez HTTP: 73/73, 11/11 i 13/13, każdy test pada na starym kodzie.

- **Identyfikator pozycji nie przechodzi już między bibliotekami.** `assertItem()` sprawdza
  bibliotekę po źródle (`media_roots`), tą samą regułą co bramka transferu. Ocena, odtwarzanie,
  tagi, okładka, kolejka urządzeń, archiwa i „co dalej” odmawiają kontu bez tej biblioteki;
  listy (kolekcje, konto, „popularne”, przegląd nowości) biorą muzykę z muzyki, a filmy z filmów.
- **Link gościnny** sprawdza prawa autora i udostępnienie przy każdej wizycie.
- **Konto wyłączone przez operatora to osobny stan** (`disabled_at`): link aktywacyjny ani
  ponowna wysyłka go nie otworzą, a panel ma przycisk „Zablokuj konto” dla oczekujących.
- **Duże archiwa:** powyżej 32 KiB lista plików leży w `archive_manifests`, a token niesie tylko
  klucz, SHA-256 i liczbę pozycji; folder 952 plików działa, a pobranie liczy się dopiero po
  wydaniu tokenu.
- **Wydajność:** eksport listy inteligentnej 12 841 pozycji z 78–93 s i 520 zapytań do 0,35 s
  i 3; archiwum wyników wyszukiwania z 11–62 s do 0,14–0,23 s — wyniki identyczne.
- **Drobniejsze:**
  - ucieczka `_`/`%` w sortowaniu folderów;
  - odcisk w imporcie tylko w bibliotece importu;
  - „zastosuj” import bez duplikatów;
  - daty linków i przeglądu z zegara bazy;
  - przegląd nowości najwyżej 14 dni wstecz i z dokładną liczbą;
  - sygnał ucięcia list (500 pozycji, 50 linków);
  - jednolita odpowiedź rejestracji;
  - 429 dla limitów i 404 dla braków.
- **Miękki limit logowania per konto:** 20 nieudanych prób w 15 minut z urządzeń, na których konto
  się nie logowało, daje tym urządzeniom 429. Przeglądarki z podpisanym ciasteczkiem urządzenia
  (`TRYHACKXDEVICE`) nie są nim objęte, więc nikt nie zablokuje właścicielowi jego urządzeń;
  limit per adres zostaje, CAPTCHA dalej wyłączona.
- **Usuwanie kont:** konto, które kiedykolwiek zmieniło okładkę albo tagi utworu, da się teraz
  usunąć (migracja 044). Poprawka zostaje w katalogu, a podpis znika; przed migracją usunięcie
  kończyło się błędem 1451.
- **„Spróbuj ponownie”** przy każdym pliku, którego nie udało się odczytać, i „Spróbuj ponownie
  wszystkie”. Nieudane zadania wracają do kolejki z licznikiem prób od zera, a worker rusza na
  nich od razu, nie biorąc przy okazji tego, co skan dołożył później. Sprawdzone: 10 zadań
  przebiegło ponownie i pięć uszkodzonych plików znów zgłosiło ten sam powód.

## 08.11.2026 (11) — Poczta przedstawia się nazwą z konfiguracji; osierocone wiersze importu legacy; porządki

Bez migracji.

- **HELO poczty z konfiguracji.** Nowe `[mail] helo_name` (nazwa hosta albo adres IPv4, który
  idzie jako literał `[a.b.c.d]`), a bez niego host z `[app] base_url`. Dotąd nazwa szła
  z `SERVER_NAME` żądania, więc przegląd nowości uruchamiany z wiersza poleceń zawsze witał serwer
  SMTP jako `localhost`. Na tej instalacji wychodzi `home.tryhackx.org`. Testy w
  `test_php_bridge_config.py`; przykłady w obu konfiguracjach.
- **Osierocone wiersze importu legacy — założenie było błędne.** `legacy_checksum` to SHA-256
  **ścieżki** ze starego systemu, nie treści, więc odciski treści nigdy go nie odtworzą. Żadna
  z 1359 osieroconych sum nie występuje nawet w starym cache — to oceny i odtworzenia plików,
  które stary system sam zgubił. Przypisane zostało 5 wierszy:
  - 2 ścieżki zapisane w NFD (importer liczył NFC) i 1 plik przekonwertowany do innego formatu;
  - skutek: 1 ocena dopisana, 1 zostawiona, bo istniejąca była nowsza, i 3 liczniki odtworzeń
    dodane (`media_play_totals` tak samo);
  - zostało 1463 wierszy, których nie da się przypisać żadnym sposobem — decyzja właściciela.
- **Przeładowanie Apache potwierdzone:** CSP z `'wasm-unsafe-eval'`, a `v1/title-worker`
  odpowiada `403` jak reszta tras wewnętrznych.
- **`ARCHITECTURE.md`** dostał „Świadome decyzje projektowe” i „Poza zakresem” (przeniesione
  z roadmapy).
- **`test:ui`** znowu uruchamia wszystkie pliki — dwie ścieżki były sklejone bez spacji, więc
  `trackers.test.ts` i `i18n.test.ts` nie biegły.

## 08.11.2026 (10) — Dokumenty robocze: `NEXT-SESSION.md` usunięty; VoltViz nie zasłania już paska panelu

Bez migracji.

**`NEXT-SESSION.md` usunięty**, jak chciał właściciel („cały ten next session… potem usuń ten
plik"). Wszystko, co w nim stało, ma teraz jedno miejsce:
- **`TESTING.md`** (lokalny, poza repozytorium): zasady pracy (backup i obecna para kopii,
  migracje jako root, restart stagingu, kto przeładowuje Apache, język dokumentów, `t()`,
  treści spoza MIT tylko w `vendor/`, pobieranie, media tylko do odczytu, konta tymczasowe),
  numer wydania w czterech miejscach, przepis testu przez HTTP, mapa kodu (z wizualizacjami),
  lekcja o kolejności sekcji Apache z cutoveru oraz pułapki frontu, mostu, narzędzi
  i wizualizacji;
- **`ROADMAP.md`**: jedno przeładowanie Apache na dwie rzeczy (CSP `'wasm-unsafe-eval'` dla
  MilkDropa i Geissa, `v1/title-worker` w regule zamykającej), zgłoszenie do GitHuba w sprawie
  osieroconych commitów, wizualizacje do obejrzenia na żywo oraz nowa sekcja „Wizualizacje —
  otwarte” (AVS bez wzorca, rzeczy przybliżone, kolejne paczki, wierny port Geissa, MilkDrop);
- punkty „czym się zająć” (cel tokenu, FFmpeg, pierwsze konto, nazwa urządzenia, lista
  nieudanych metadanych, kolejki) są zrobione — wpis (9).

Narzędzia do porównań AVS ze wzorcem (poprawki wzorca jako `diff`, program renderujący, strona
testowa, skrypty) przeniesione ze scratchpada sesji do ignorowanego `scratch/avs-reference/`
z opisem w `README.md`.

**VoltViz: menu i zamykanie znikały** („na voltviz ten wizualizator powoduje, że znikają nam menu
wyboru i nie da się też zamknąć, jedynie Esc"). Vinyl rysuje płótno z `z-index: 10`, a warstwa
VoltViz nie tworzyła własnego kontekstu nakładania — płótno wychodziło nad pasek panelu
i przejmowało kliknięcia (Esc działał, bo klawiatura nie pyta, co leży na wierzchu). To samo
groziło przy Background Image, Dutch Grid i Dutch Grid WebGL.
- `voltviz/stage.css`: scena z `isolation: isolate`;
- `styles/player.css`: pasek panelu ma `z-index`, więc żadna wizualizacja go nie przykryje.
- Sprawdzone na rekonstrukcji panelu: `elementFromPoint` w miejscu paska trafiał w płótno,
  teraz w pasek.

## 08.11.2026 (9) — Usługa i most: cel tokenu, zatrzymywanie FFmpeg, pierwsze konto bez SQL-a, nazwa urządzenia, kolejki

Bez migracji. Punkty z dawnej listy „czym się zająć” w `NEXT-SESSION.md`: dwa wysokie z audytu
07.11.2026 i trzy długi. Apache nie wymaga przeładowania.

**Cel tokenu transferowego (wysokie z audytu)**
- Token niesie teraz cel: `download`, `play`, `thumb` albo `compat`. Usługa otwiera każdą trasę tylko dla jej celu.
- Token odtwarzania, miniatury czy linku gościnnego nie uruchomi już transkodowania ani renderu napisów.
- Token trybu zgodnego wydaje wyłącznie `stereo()`, po sprawdzeniu `can_stream_compat`, i tylko on niesie limit strumieni.
- Stare tokeny działają do końca swojej ważności, ale tylko jako to, czym były.
- Sprawdzone przez HTTP: 42/42.

**Zatrzymywanie FFmpeg i sprzątanie (wysokie z audytu)**
- Przewinięcie po pauzie mogło wisieć do godziny. Od Pythona 3.12 `wait()` czeka na zamknięcie rur, a FFmpeg zablokowany w zapisie nie słucha SIGTERM. Teraz zamykamy nasze końce rur i czekamy najwyżej 8 s.
- Po zamknięciu karty sprzątanie przerywało się na pierwszej linii, więc slot i licznik transferów zostawały zajęte. Teraz jest osłonięte i ma zapasowe zwolnienie po odpowiedzi.
- Przy okazji:
  - koniec odmów 409 przy szybkim przewijaniu;
  - sondy FFmpeg są zabijane po czasie;
  - napisy z pliku obok trafiają do cache pod właściwy klucz.

**Pierwsze konto bez SQL-a**
- Nowe polecenie `media-server account-create`. Hasło podaje się bez echa albo na wejściu, nigdy w wierszu polecenia. Skrót liczy PHP.
- Instrukcje w README i w obu przewodnikach instalacji.

**Nazwa urządzenia i nieudane metadane**
- Własna nazwa tej przeglądarki w Moje konto → Ustawienia → „To urządzenie”.
- Panel pokazuje listę plików, których nie udało się odczytać, z powodem: dziś 5 plików, 10 zadań.

**Kolejki**
- Odciski plików są kompletne, a skan ma `--fingerprint-limit`.
- Cache napisów:
  - stary zapis postępu ukrywał 305 filmów;
  - pusta ścieżka obrazkowa przerywała cały film;
  - zostało ok. 40 h czytania dysku; instrukcja w ROADMAP.

**Sprawdzone:**
- bramka 8/8; pytest 447 przechodzi, 15 pominiętych (było 399);
- przez HTTP przez Apache 42/42 sprawdzenia celu tokenu, na koncie tymczasowym (skasowanym razem
  z wierszami w `audit_log` i `auth_attempts`), z grupą bez `can_stream_compat` i linkiem gościnnym;
- na stagingu: przewinięcie po pauzie odpowiada w 0,13 s, a po zamknięciu karty
  `transfers_active: 0` i żadnego FFmpeg;
- nowe testy padały na starym kodzie (dwa wisiały po 30 s), teraz trwają ok. 1 s.

**Do potwierdzenia na Debianie** przy najbliższym wdrożeniu (opis w `ROADMAP.md`).

**Nowe pliki do commita:** `src/media_server/accounts.py`, `tests/test_token_purpose.py`,
`tests/test_compatible_cleanup.py`, `tests/test_accounts.py`,
`frontend/src/shared/device-label.ts` (+ `device-label.test.ts`).

## 08.11.2026 (8) — MilkDrop z teksturami i nowymi paczkami; nowe wizualizacje: „Formy dźwięku” i shadery

Bez migracji. Z listy repozytoriów właściciela: projectM („dodać”), BeatDrop, butterchurn
(„nowości → dodaj”), monkey-hi-hat i music_visualizer („można dodać”), oraz prośba o wizualizacje
w stylu vizz.fm.

**MilkDrop: tekstury presetów, nowe paczki i paczka image** (osobny agent):
- **Tekstury.** Build serwuje obrazy z `frontend/vendor/milkdrop-textures/` (paczka tekstur projectM: 67 plików, 3,5 MB) oraz te z katalogów paczek, o które preset prosi po nazwie (4 z En D). Każdy obraz jest pobierany dopiero wtedy, gdy grający preset go używa. Nazwy działają bez względu na wielkość liter, z prefiksami `fw_`/`fc_`/`pw_`/`pc_` jak w MilkDropie. Sloty `rand00`–`rand15` losują teksturę przy każdym wczytaniu presetu, a `texsize_<nazwa>` dostaje wymiary już przy budowaniu (dotąd były zerami). Dotąd każdy taki preset dostawał clouds2 butterchurna; teraz 910 z 1 076 presetów paczek ma wszystkie swoje tekstury.
- **Nowe paczki** (tylko w `vendor/`): projectM classic (4 185 z 4 189), En D (40 z 40) i BeatDrop — Incubo_'s Presets (535 z 627) oraz MilkDrop2077 Presets (683 z 763). 157 presetów wymagających BeatDropa lub MilkDropa 3 (`get_fft()`, proste fale od 9, więcej niż 4 fale lub kształty…) build pomija z powodem w `failed.txt`.
- **Konwersja:** obsługa `round`, `tanh`, `log10`, `distance`, `refract`, `all` i tekstur szumu z prefiksem; Cream of the Crop ma teraz 9 754 presety (było 9 682).
- **Paczka image z butterchurn-presets:** 122 nowe wbudowane presety (razem 472).
- **NOTICE.md:** dopisane paczki projectM classic i En D, BeatDrop (CC BY-NC-SA 3.0 dla presetów z Shadertoy) oraz paczka tekstur.
- Sprawdzone: `tsc`, `test:ui` 134/134; 65 presetów z teksturami porównanych w przeglądarce z wersją bez tekstur (wszystkie dostały swoje). Naprawiony przy okazji błąd: `img.decode()` nie kończy się w karcie w tle, więc obrazy wczytują się przez `onload`.
- Nowe pliki do commita: `frontend/scripts/milkdrop-textures.mjs`, `frontend/src/shared/visualizations/milkdrop-textures.ts`, `milkdrop-textures.test.ts`.

**Nowa wizualizacja „Formy dźwięku” (Sound Forms)** — na prośbę o wizualizacje w stylu vizz.fm.
- **Co to jest:** wtyczka `soundforms` z 36 własnymi wizualizacjami 3D w czystym WebGL 2, bez
  three.js. Są to presety jednej wtyczki w siedmiu grupach: kule z kolców, fale z linii, widmo
  w przestrzeni, siatki punktów, roje cząstek, kropkowa planeta i pierścienie.
- **Wzór:** wygląd wariantów vizz.fm wskazanych przez właściciela: Textured Sphere 1–11, Wavy
  Form 1–13, Classic Spectrum 6, 7, 10, 11 i 12, Mesh Grid 5, 6 i 9, Particle Dance 3 i 4, Dot
  Grid 3 („Dot Girl” z listy) i Equalizer Rings 4. Kod i shadery są nasze; z vizz.fm (kod
  zamknięty) niczego nie pobrano ani nie skopiowano.
- **Obsługa:** Auto (zmiana co 30 s, przenikanie 1,2 s), ulubione, „zostaw” i „następny” działają
  jak w Internal. Wybór pamięta `media-visualizer-preset:soundforms`.
- **Dźwięk:** własny analizator, także przy 96/192 kHz. Historia muzyki leży w teksturze, a ciche
  nagrania są łagodnie wzmacniane; w ciszy obraz się uspokaja.
- **Wydajność:** rozdzielczość to panel × devicePixelRatio (do 2, najwyżej ok. 2,4 Mpx). Utrata
  kontekstu jest obsłużona, a `destroy()` zwalnia wszystkie obiekty GPU.
- **Wczytywanie:** fragment ok. 71 KB (23 KB gzip) przychodzi przy pierwszym otwarciu i działa
  przy CSP `script-src 'self'`.
- **Instalacje:** identyfikator jest w `VISUALIZER_IDS`, więc na istniejących instalacjach
  wtyczka przychodzi włączona.
- **Nowe pliki do commita:** `soundforms-plugin.ts`, `soundforms.test.ts`, katalog `soundforms/`.

**Nowa wizualizacja „Shadery”** (Monkey Hi Hat i music_visualizer; osobny agent):
- **Silnik:** własny WebGL 2. Gra shadery Monkey Hi Hat (Volt's Laboratory: 115 wizualizacji,
  39 efektów, 20 przejść) i music_visualizera (14 shaderów).
- **Konwersja:** build przepisuje shadery na GLSL ES 3.00 i sam zamienia liczby całkowite na
  zmiennoprzecinkowe tam, gdzie desktopowy GLSL robi to sam. Shadery geometrii music_visualizera
  działają jako instancjonowane vertex shadery, więc żaden nie odpadł.
- **Dźwięk** trafia do shaderów w formatach, na których je pisano (tekstury eyecandy, fala
  i widmo osobno dla kanałów), także przy 96/192 kHz.
- **Lista:** grupy według źródła i rodzaju, autorzy z podpisów, wybór źródła, Auto z przejściami
  Volt's Laboratory, ulubione, a efekty nakładane na losową wizualizację z przenikaniem 2 s.
- **Co gra:**
  - 168 presetów kompiluje się i rysuje;
  - nie ma 2 efektów: ghostly potrzebuje wideo, a starship obrazków statku z Monkey Hi Hat;
  - fotografie Shadertoy zastępuje wygenerowany kolorowy szum, a mapy sześcienne wygenerowane
    niebo, chyba że właściciel doda folder `textures/` z volts-laboratory.
- **Reakcja na muzykę:** reaguje 70 z 73 wizualizacji Monkey Hi Hat, które czytają dźwięk,
  14 z 14 music_visualizera i 38 z 39 efektów. Trzy, które nie reagują, mają tak w samej treści
  (Paint Bomb rysuje falę losowo, Stained Glass i The Machine liczą dźwięk, którego nie używają).
- **Ekran:** obraz respektuje `devicePixelRatio` (najwyżej 2) i zmniejsza się na słabszych
  urządzeniach, a `destroy()` zwalnia wszystkie zasoby GPU.
- **Licencje:** treść (CC BY-NC-SA, GPL-3) leży wyłącznie w `frontend/vendor/shader-visualizers/`
  (poza repozytorium, `SOURCE.txt` zapisuje oba commity) i w buildzie. Kod uruchamiający jest
  nasz; obsługę fali music_visualizera napisano od nowa, a zostawiono tylko format danych, którego
  oczekują shadery. NOTICE.md ma nowy akapit.
- **Bez treści w `vendor/`** wtyczki nie ma w panelu. `'shaders'` jest w `VISUALIZER_IDS`
  i przychodzi włączona, jak VoltViz.
- **Nowe pliki do commita:** `frontend/scripts/shader-visualizers.mjs` (+ `.d.mts`,
  `.test.mjs`), `shader-glsl.mjs`, `shader-glsl-types.mjs`, `frontend/src/shared/visualizations/`
  `shaders-plugin.ts` i katalog `shaders/`.

## 08.11.2026 (7) — AVS: warstwa mscopes (28 efektów, 17 presetów)

Bez migracji. Z listy repozytoriów właściciela: „mscopes — można dodać”.

- **Port „nowoczesnej warstwy” z [mscopes](https://github.com/GarAlex/mscopes)** (BSD-3, `avs/webvs/mscopes/`, licencja w `mscopes/LICENSE-mscopes.txt`). To 28 komponentów z przedrostkiem `Mscopes` (bo webvsc nazywa już „Fluid” i „Particle System” wtyczki AVS):
  - efekty GPU: Bloom, Kaleidoscope, RgbSplit, ToneMap, Vignette, Shockwave, Glitch, Streaks, Lens, RadialBlur, NeonEdges, Duotone, Shimmer, CRT, Trails;
  - rysowanie: Particles, Vectorscope oraz Scope, Starfield i Ring mscopes;
  - symulacje: FlowParticles, Fluid, ReactionDiffusion (wymagają tekstur zmiennoprzecinkowych; bez nich nic nie rysują);
  - PixelShader (skrypt EEL tłumaczony na GLSL) i to, czego potrzebują presety: FeedbackWarp, Blur, ColorMap, Grain.
- Kernele Metal przepisane na GLSL ES 1.00, bo kontekst webvs to WebGL 1; parametry, zakresy i wartości domyślne są te same. Ziarna losowania cząstek i Grain idą przez hash zmiennoprzecinkowy (GLSL ES 1.00 nie ma liczb całkowitych), więc losowania różnią się od mscopes.
- Analiza dźwięku mscopes (widmo, beat i tempo, 32 pasma, kick/snare/hat) przeniesiona wiernie; przechodzi testy mscopes na syntetycznej perkusji (`analysis.test.ts`). W każdym kodzie AVS działają zmienne `kick`, `snare`, `hat`, `onset`, `level`, `bass_att`, `mid_att`, `treb_att`; preset, który sam je przypisuje, zachowuje własne.
- 17 wbudowanych presetów mscopes (Classic Tunnel … Aurora) to paczka „mscopes” z klatką half-float. Paczka jest w repozytorium, więc AVS jest teraz w każdym buildzie, także bez `vendor/`.
- Przy okazji: webvs potrafił po zmianie presetu wybrać skasowany już program shadera (błąd GL); teraz jest najpierw odpinany.
- Sprawdzone: `tsc`, `test:ui` 146/146; 17 presetów bez ostrzeżeń i błędów GL, reagują na dźwięk, 1–3 ms na klatkę w 1280×720; 62 presety AVSociety i 303 z pozostałych paczek wczytują się jak dotąd, z 8-bitową klatką.

**Nowe pliki do commita:** `frontend/src/shared/visualizations/avs/webvs/mscopes/` (z licencją
`LICENSE-mscopes.txt`, presetami `presets.json` i testem `analysis.test.ts`).

## 08.11.2026 (6) — AVS: „białe” presety to były błędy silnika; Simple, Picture, Picture II i dziewięć brakujących efektów

Bez migracji. Zgłoszenia:
- „te w pełni białe wizualizacje to chyba błąd i tło powinno być czarne”;
- „AVS dalej nie skończyłeś… skończ to w całości”.

**Przegląd.** 303 nowe presety (Anthology, 8_ronin) przeszły przez silnik i przez wzorzec.
- Z 73 podejrzanych (pusty, biały, czarny albo stojący obraz) 23 czekały na brakujące efekty,
  a 4 były wariantami testowymi.
- Resztę porównano ze wzorcem. Większość białych i jednolitych obrazów to były błędy silnika:
  podejrzenie właściciela było trafne.

**Błędy silnika:**
- **Unique Tone w trybie dodawania** mieszał przez GL do drugiej tekstury pary, czyli do klatki
  sprzed poprzedniego efektu.
  - Ton zastępował kolory obrazu szarością i przepalał go do bieli.
  - Teraz liczy jak `r_onetone.cpp` (tabela tonu w tej samej arytmetyce co C) i miesza
    w shaderze na bieżącej klatce.
  - `ShaderProgram.run` kopiuje bieżącą klatkę każdemu programowi, który rysuje do drugiej
    tekstury i miesza przez GL.
  - Naprawione: Riftweaver, Focus Quantum – Blood Remix, alien surf, Eye am i systemscan. Trzy
    ostatnie zgadzają się ze wzorcem prawie co do piksela.
- **Buffer Save „co drugi piksel”** nic nie zapisywał: przy rysowaniu do bufora shader nie
  dostawał `u_resolution` i ten zostawał zerem. Przez to Formula 223277 była biała.
- **Moving Particle „Default”** dodawał kolory. W AVS (`r_parts.cpp`) to tryb linii z Set Render
  Mode, a bez niego zastąpienie.
  - Nachodzące na siebie cząsteczki bielały; dotyczyło to 20 presetów.
  - Formula 223277 zgadza się teraz ze wzorcem (średnia jasność 104 przy 104).
- **Picture** (4 presety, m.in. intro AVSociety) rysował duszka zamiast obrazka, bo komponent
  webvs czytał inne pola, niż daje konwerter. Teraz liczy jak `r_picture.cpp`:
  - rozciąga obrazek albo zachowuje proporcje z czarnymi pasami;
  - miesza: zastąp, dodaj albo 50/50, a „adapt” zamienia 50/50 w dodawanie na beat.
- **Picture II** dotąd nic nie rysował. Używa go Labyrinth Zone, a obraz Raz_sonic_10.bmp jest
  w paczce Renaissance. Teraz skaluje po pikselach albo filtrem dwuliniowym AVS (BLEND4), ma
  dziesięć trybów mieszania i osobne ustawienia na beat.
- **Brak bitmapy:** Picture i Picture II nic wtedy nie rysują, jak AVS. Dotąd podstawiał się duszek.
- **Effect List zaczyna od domyślnego trybu linii** (zastąp, 1 px) i na końcu oddaje rodzicowi
  jego tryb, jak `r_list.cpp`.
- **Konwerter czytał ustawienia Movement spoza bloku.** Starsze AVS zapisywały krótszą
  konfigurację: bez pola „wrap”, a czasem też bez „bilinear”. AVS (`r_trans.cpp`) czyta wtedy
  wartości domyślne (bez zawijania, bez filtra), a webvsc czytał bajty następnego komponentu.
  - W 66 presetach (głównie AVSociety, tom 1–2) 110 efektów Movement zawijało obraz, a 52
    filtrowało go dwuliniowo, choć w AVS nie robiły ani jednego, ani drugiego.
  - Halloway był przez to różowo-białym szumem zamiast spirali linii, bo kafelki z zawijania
    zbierało „Maximum”.
  - Każde pole czyta się teraz tylko wtedy, gdy blok je ma (`scripts/webvsc/browser.js`);
    prefiks `!rect ` jest pomijany tak jak w AVS.
- **Interleave** rysował stałe paski i nie reagował na beat. Teraz liczy jak `r_interleave.cpp`:
  - wiersze na przemian pełne i wzorzyste;
  - wzór wyśrodkowany resztą z dzielenia rozmiaru;
  - na beat skok do x2/y2, a potem płynny powrót;
  - 50/50 jako `(a >> 1) + (b >> 1)`.

  Naprawione m.in. Heavy Duty [load II] (różnica do wzorca spadła z 175 do kilku) i GrayOil
  Conceptual RMX.
- **Obrazek, który się nie wczyta, zatrzymywał całą wizualizację.** Loader webvs czekał na
  niego bez końca, więc obraz stawał na czarnej klatce. Teraz obrazek jest pomijany, a klatka
  idzie dalej. Na stronie testowej trafiło to „Leo — The Insane” (jej serwer nie dekodował `%20`
  w nazwie pliku); w aplikacji groziło to przy każdym brakującym pliku.

**Brakujące efekty** (port z vis_avs 2.81d, osobny agent):
- **Przeniesione z vis_avs 2.81d klasyczne efekty AVS:** Simple (wszystkie sześć trybów, także
  wypełnione „Solid”; wcześniej przybliżenie przez SuperScope, więc np. Riftweaver nie miał
  czarnych wypełnionych kształtów), Dot Grid, Oscilloscope Star, Rotating Stars, Timescope, Bass
  Spin, Dot Fountain, Interferences i Water Bump. Pliki: `render/Classic.ts`,
  `trans/Interferences.ts`, `trans/WaterBump.ts`, a wspólne rysowanie w `avsDraw.ts` (`line()` z
  `linedraw.cpp`, `BLEND_LINE` w dziesięciu trybach z `g_blendtable`). Z 382 presetów żaden nie
  zgłasza już nieznanego komponentu poza SVP (wtyczka wideo, pominięta).
- **Poprawki konwertera (webvsc):** pola Oscilloscope Star i Interferences ze znakiem (obrót −16
  wychodził jako 4294967280); zapisany obrót Interferences, Dot Plane i Dot Fountain nie ginie
  już jako dopełnienie; Interferences z obiema flagami mieszania to 50/50 zamiast błędu
  wywracającego preset; tryb „Minimum” w Set Render Mode.
- **Poprawki silnika:** `ShaderProgram.run` po `copyOver()` wiąże `u_srcTexture` ponownie —
  kopiarka zostawiała jednostkę 0 pustą, więc Super Scope i inne z Set Render Mode Maximum,
  50/50, XOR, Multiply albo Minimum rysowały jak „replace”; Set Render Mode przekazuje wartość
  „Adjustable”; Dot Plane czyta zapisany obrót; w trybie porównawczym C `rand()` startuje po 30
  losowaniach (wzorzec zużywa 10 na nazwę korzenia), więc Water Bump i Moving Particle zgadzają
  się z nim co do piksela.
- **Porównanie ze wzorcem (640×360):** co do piksela zgadzają się Dot Grid, Water Bump,
  Interferences („replace”), Moving Particle i Rotating Stars w ciszy; Oscilloscope Star i
  oscyloskopy Simple różnią się tylko pierwszą próbką. Pozostałe różnice to błędy wzorca: fala
  opóźniona o 447 próbek, widmo z przepełnionych tablic, linie ukośne mieszane z pikselem (0,0),
  Interferences additive i 50/50 bez klatki, tablica kolorów Dot Fountain liczona bez znaku,
  zamienione kanały Bass Spin.
- **PsychoNet** (Todays Networking, PsychoNet Mix) ożył dopiero z wiernym Simple. Dwa Movementy
  („r=0”, potem „y=x”) próbkują dokładnie jedną kolumnę pikseli, w której stoi pionowa linia
  scope'a. Gdy jej tam nie ma, cały ekran gaśnie zamiast wypełnić się kolorem.

**Strona testowa:** detektor beatów jest restartowany przed każdym presetem. Bez tego pierwsza
klatka nie była beatem jak we wzorcu, więc presety budujące obraz na pierwszym beacie (Nixa —
water) wychodziły czarne.

**Presety, które wyglądają dziwnie, ale tak mają:**
- Instant Burn jest niebieski z iskrami także we wzorcu.
- Disco Cubism14brmx, Intro.5 v3 CD2 i Intro CD3 są w tych klatkach czarne także we wzorcu.
- Z.N.S jest biały. Dynamic Movement używa tam `i` i `v`, których Dynamic Movement nie ma, więc
  cały ekran próbkuje jeden piksel, a kolory się sumują. Wynika to z kodu presetu; wzorzec się
  na nim wywraca.
- Beta (B1) i (B2) są ciemne. Lista z wejściem 50/50 traci połowę jasności co klatkę, a FadeOut
  74 zostawia tylko świeże cząsteczki. Wzorzec i tu się wywraca.
- Nixa — water gaśnie u nas po kilku beatach, a we wzorcu świeci. Zależy to od losowań w kodzie
  presetu i od fali, którą wzorzec ma opóźnioną o 447 próbek. Sprawa otwarta w `ROADMAP.md`.

**Wynik końcowy** (klatki 150 i 300, ten sam fragment utworu i te same beaty w obu silnikach):
- Anthology i 8_ronin, 303 presety: wzorzec renderuje 247, a 154 z nich zgadza się z naszym
  (mediana różnicy 9,8).
- Jednolity obraz zostaje w 12 presetach:
  - 3 są takie same we wzorcu;
  - 3 stojące zgadzają się z nim co do piksela;
  - Chess (Invert) jest biały przez Invert, zgodnie z zamysłem;
  - reszta jest opisana wyżej (Z.N.S, Beta (B1) i (B2), water).
- Największe różnice to błędy wzorca:
  - Interferences w trybie additive (Maybe7);
  - widmo, od którego zależy promień Ringa: w „Nothing” od tego zależy, czy obraz w ogóle
    powstaje;
  - Text (intro AVSociety).

  Gdzie indziej to ta sama budowa obrazu z inną jasnością.
- 62 starsze presety: zgodnych jest 19 z 39 porównywalnych (rano 17), mediana różnicy 17,8
  (rano 20,4).

**AVS nie jest już wersją testową:**
- etykieta to „AVS (Winamp)”;
- `CatalogActions.php` nie wyłącza go już na instalacji, która go jeszcze nie znała;
- u właściciela AVS jest już w zapisanej kolejności wizualizacji, więc nic się nie zmienia.

**Wzorzec** wywraca się na części presetów niezależnie od ich treści. Czasem pomaga wycięcie
komentarza, czasem inny rozmiar okna (`scratch/avs-reference/tools/crash_probe.py`). Obraz
z wzorca to więc dowód, ale nie wyrocznia.

**Sprawdzone:** `tsc`, `test:ui`, `php -l`. Prywatny build przeszedł przez wszystkie 303 nowe
presety i 62 stare, każdy po świeżym starcie, porównany ze wzorcem. Wzorzec wyrenderował 303
presety od nowa, z wyciętymi komentarzami.

**Nowe pliki do commita** (w `frontend/src/shared/visualizations/avs/webvs/`): `avsDraw.ts`,
`render/AvsPicture.ts`, `render/Classic.ts`, `trans/Interferences.ts`, `trans/WaterBump.ts`.
Stary `render/Picture.ts` z webvs usunięty (nie był jeszcze w repozytorium).

## 08.11.2026 (5) — AVS: kod presetów jak w AVS 2.81, poprawki efektów, 303 nowe presety; strzałki presetów

Bez migracji. Zgłoszenia:
- „AVS dalej nie skończyłeś… skończ to w całości”;
- Hboy - Orifice „w lewym górnym rogu”, „te w pełni białe wizualizacje to chyba błąd”;
- „po losowaniu pozwól wybierać poprzednie… mniejsze strzałeczki wewnątrz”.

**Kod presetów liczy się jak w AVS 2.81, nie jak w EEL2.** Wyszło to przy Orifice.
- **Kolejność działań.** Parser (eel-wasm) czytał kod jak EEL2:
  - `%` wiązał mocniej niż `/`, a `/` mocniej niż `*`;
  - jednoargumentowy minus wiązał słabiej niż `*`;
  - `&` i `|` stały na jednym poziomie.

  Parser AVS 2.81 (ns-eel) ma inaczej, co sprawdziłem na tablicach jego parsera ze źródeł 2.81d:
  - `* / %` na jednym poziomie, liczone od lewej, tak samo `+ -`;
  - `&` wiąże mocniej niż `|`, a minus najmocniej.

  Nowy `avs/eel-grouping.ts` przegrupowuje łańcuchy działań, których autor nie ujął w nawias.
  W Orifice `x=dirx*w%w/w*2-1` dawało dotąd zawsze -1, więc cząsteczki stały w rogu.
- **`%`, `&`, `|` i prawda** jak w EEL (`avs/eel-math.ts`):
  - `%` na wartościach bezwzględnych zaokrąglonych do najbliższej, przez zero daje 0;
  - `&` i `|` na 64-bitowych zaokrągleniach;
  - fałsz to |x| < 0,00001, w `if`, `band`, `bor`, `bnot`, `&&`, `||` i `while`.
- **Błędna instrukcja nie wywraca presetu.** AVS kompilował instrukcje osobno i pomijał te,
  których nie umiał, na przykład nieznaną funkcję `log13` albo `pow` z jednym argumentem.
  U nas cały preset się nie wczytywał.
- **`gettime(-1)` i `gettime(-2)`** to pozycja i długość utworu z odtwarzacza, jak w Winampie.
  Presety, które tak wykrywają pauzę (Echolot), stają razem z muzyką.

**Efekty, które rysowały źle** (każdy sprawdzony z kodem oryginału):
- **SuperScope** bez `x` w kodzie rysował poza ekranem, bo zmienna nie była zainicjowana. W AVS
  `x` i `y` zaczynają od 0. Przez to Echolot był cały biały.
- **Fast Brightness** czytał wartość z konwertera jak numer trybu, więc ×2 nic nie robiło,
  a „bez zmian” przyciemniało. Ma 8 użyć w presetach; Ozone Layer i Helium wyglądają teraz
  jak w AVS.
- **Multiplier:**
  - „infinite root” i „infinite square” działają na całych pikselach (wcześniej było ×64 i ÷64
    osobno na kanałach);
  - ×½, ×¼ i ×⅛ obcinają jak przesunięcie bitów.
- **Color Map** z wyłączoną mapą: pieczone są wszystkie mapy, a „włączona” decyduje tylko
  o cyklu. Bez żadnej włączonej gra mapa 0 (bad taste).
- **Every other line / pixel:** przy nieparzystym wymiarze ostatni wiersz albo kolumna zostaje,
  jak w AVS.
- **Konwerter (webvsc):** pola `UInt32` wychodziły puste, czyli źródło dźwięku Ringu oraz kanał
  i pasma Timescope. Ring grał przez to falę zamiast widma.
- **AVS Trans** działa tylko przy wczytaniu presetu (`webvs/avsTrans.ts`); przybliżone rozwijanie
  makr przy buildzie usunięte.

**Wzorzec** (grandchild/vis_avs w scratchpadzie) miał jeszcze dwa własne błędy:
- „every other line” kopiował wszystkie linie, a „every other pixel” rozjeżdżał wiersze;
- Multiplier miał zamienione tryby nieskończone.

**Wynik** (klatka 300, 39 presetów, które wzorzec renderuje):
- zgodnych jest 17 (rano 8), a mediana różnicy spadła do 20,4 (rano 51);
- reszta różnic to głównie kolejność losowań (`rand` w kodzie i w efektach), skala widma
  i niestabilność samego wzorca. xerarch invert i Color on Water raz się u niego rysują, a raz
  wywracają.

**303 nowe presety.**
- Instalatory 8_ronin i AVSociety Anthology są spakowane wariantem bzip2 z NSIS. Teraz czyta je
  własny dekoder, a instalatorów nadal nic nie uruchamia.
- Doszło 8 presetów z 8_ronin i 295 z Anthology na 11 płytach, czyli razem 365.
- Obrazki z paczek (Raz_sonic_01–15, viskey_texer i 3 z Anthology) leżą w `vendor/avs-presets`
  i build serwuje je obok wbudowanych. Nazwy szuka się bez względu na wielkość liter, jak na
  Windows.
- Obrazka, którego nie ma w żadnej paczce (Shreyas-IV-01, P9_Tx_1, v5_circle…), dalej zastępuje
  domyślny sprite Texera II, tak jak w AVS.

**Orifice:**
- białe tło to zamysł autora (Invert na końcu łańcucha);
- „EPILEPSY WARNING” to jego plansza na pierwsze sekundy;
- cząsteczki startują w rogu i z czasem rozchodzą się z zawijaniem.

**Panel wizualizacji:** małe ‹ i › przy liście presetów.
- Chodzą po historii pokazanych presetów, także po losowaniu w Auto.
- › na końcu historii losuje dalej albo bierze następny z listy.
- Duże ⏮ ⏭ dalej zmieniają wizualizację, a dwuklik na obrazie działa jak ›.
- Napisy „Poprzednia wizualizacja” i „Zamknij” idą przez `t()`.

**Sprawdzone:**
- `tsc`, `test:ui` (nowe testy: `eel-math.test.ts`, `eel-grouping.test.ts`);
- build prywatny strony porównawczej;
- przeliczenie 62 dawnych presetów w obu silnikach i przegląd nowych pod kątem pustego,
  białego, czarnego albo stojącego obrazu.

**Nowe pliki do commita:** `frontend/src/shared/visualizations/avs/`: `eel-grouping.ts`,
`eel-grouping.test.ts`, `eel-math.ts`, `eel-math.test.ts`.

## 08.11.2026 (4) — AVS: cztery błędy wzorca, AVS Trans Automation; Space obejrzany i odrzucony

Bez migracji. Zgłoszenia: „kontynuuj to co… w następnej sesji”; „te coś co tam lokalnie miało
może być ale publicznie nie… pokaż jak one tam wyglądają”; pytanie o efekty vizz.fm (odpowiedź
i poprawka w (3)).

**Wzorzec AVS miał cztery własne błędy** (grandchild/vis_avs w scratchpadzie sesji, poza
repozytorium). Każdy sprawdzony z kodem oryginału, każdy w ref_render poprawiony:
- **Custom BPM w korzeniu zamieniał bufory.** Pętla korzenia brała wynik komponentu jako `bool`,
  więc `SET_BEAT`/`CLR_BEAT` działało jak „zamień bufory” i podmieniało klatkę na pustą. Do tego
  beat nie przechodził na dalsze komponenty. Oryginał (`r_list.cpp`) patrzy tylko na bit 0. Stąd
  była czarna amanita.
- **Wyłączone komponenty.**
  - Korzeń pomijał wyłączone listy, więc ich kod nie mógł ich włączyć. Tak było z The Convicts:
    „włącz przy zmianie rozmiaru”.
  - Listy rysowały wyłączone komponenty, bo grandchild przeniósł `enabled` do klasy bazowej
    i usunął sprawdzanie z komponentów.
  - W oryginale każdy komponent sam wraca, gdy jest wyłączony, a lista decyduje kodem.
- **Kod list nigdy się nie kompilował.** Loader listy v2.81 wczytywał init/frame, ale nie
  zlecał kompilacji, w przeciwieństwie do innych komponentów z kodem. Do tego wartości mieszania
  szły przez `...` jako 64-bitowe, a czytane były jako `int`. W buildzie x86 `alphaout` wychodził
  0, więc lista z kodem i mieszaniem „adjustable” była niewidoczna.
- **Buffer Save** przycinał numer bufora do 1–8, choć w pliku jest liczony od 0, więc „bufor 1”
  stawał się „buforem 2”. **Blitter Feedback** wczytywał pole „on beat” jako zoom na beacie.

Nasz silnik w tych miejscach był zgodny z oryginałem, więc różnice szły na konto wzorca.

**Wynik** (klatka 300):
- na tych samych 36 presetach zgodnych jest 13 zamiast 8, a mediana różnicy spadła z 51,0
  na 38,8;
- doszły 2 porównywalne: just like el-vis (zgodny) i Helium;
- The Convicts z 211 na 86, Lans of Kansis ze 187 na 76, amanita ze 142 na 41;
- wzorzec dalej wywraca się na 22 presetach.

Liczby z (2) (11 zgodnych, mediana 41) obejmowały 5 klatek wzorca ze starszych przebiegów,
w których te presety jeszcze się nie wywracały. Teraz `rank.py` liczy tylko świeże klatki.

„Color on Water” odpada z porównań: wzorzec na tym samym pliku daje raz czerń, raz obraz, raz
segfault.

**AVS Trans Automation** (nowy `webvs/avsTrans.ts`, port `e_eeltrans_translate.cpp`):
- preset z włączonym AVS Trans ma kod przepisany przy wczytaniu tak jak w AVS: makra `#define`
  (w stylu C, z `##`), zamiany tekstu, komentarze z ustawieniami `//$avstrans_...` i `//$notrans`;
- zastępuje przybliżone rozwijanie makr przy buildzie (`expandTransMacros` w
  `scripts/avs-presets.mjs`, usunięte w 08.11 (5)). Tamto przycinało argumenty, szukało nazw
  tylko na granicy słowa, rozwijało w kółko i nie znało zamian bez nawiasów ani ustawień
  z komentarzy;
- używa go tylko Echolot (makro `bezier6` w Dynamic Movement);
- Echolot dalej różni się od wzorca, i to już w alfie samego Dynamic Movement (bisekcja), więc
  zostaje do zbadania.

**Strona testowa** podaje teraz `gettime()` czas klatki (60 kl./s), jak tryb wideo wzorca.
Na stronie produkcyjnej `gettime()` to prawdziwy zegar, jak `GetTickCount` w AVS-ie, i tak
zostaje. Ranking prawie się przez to nie zmienił.

**Space 0.9b** (Pascal Dallongeville, 2000) zbudowany ze źródeł jako wzorzec w scratchpadzie:
- MSVC, bez okien i DirectDraw;
- 36 presetów na prawdziwej muzyce; arkusze i GIF-y pokazane właścicielowi do decyzji;
- licencja pozwala tylko na użytek prywatny i zabrania publicznego pokazywania obrazów;
- właściciel go odrzucił: to 16-bitowe piksele i proste cząsteczki z 2000 r., wyraźnie słabsze
  od MilkDropa. Nic z niego nie weszło do projektu, a wzorzec ze scratchpadu jest skasowany.

**Sprawdzone:** `tsc`, `test:ui` 89/89 (4 nowe), build.

**Nowe pliki do commita:** `frontend/src/shared/visualizations/avs/webvs/avsTrans.ts`
i `avsTrans.test.ts`.

**Zmienione:**
- `webvs/Main.ts`;
- `frontend/package.json` (test w `test:ui`);
- `docs/FRONTEND.md`.

## 08.11.2026 (3) — Party Mode: przymiarka i rezygnacja; ogólny komunikat „Ulubione”

Bez migracji.

**Party Mode** (8 stylów preziotte z 2014 r., CC BY-NC 3.0) był w tej sesji przeniesiony. Na
życzenie właściciela został usunięty przed commitem, bo właściciel spodziewał się efektów
z vizz.fm.
- Nie ma go w kodzie ani w `frontend/vendor/`.
- Most PHP pomija `party-mode` i `snowglobe` w listach wizualizacji z kart, które mają jeszcze
  stary bundle (`REMOVED_VISUALIZERS`). Zapis ustawień nie kończy się przez nie błędem.
- Przeglądarka z zapamiętanym `party-mode` startuje od domyślnej wizualizacji.

**vizz.fm** to następca party-mode tego samego autora, napisany od nowa w Three.js/WebGL.
- Jest darmowy, ale kod ma zamknięty, więc nie ma czego przenieść.
- Linki „Spotify, YouTube…” z README party-mode to poradniki, jak podać mu dźwięk z tych
  aplikacji, a nie grupy wizualizacji.

**„Ulubione”:** pusty komunikat mówi ogólnie „w dowolnej wizualizacji”.

## 08.11.2026 (2) — AVS: Convolution Filter i Custom BPM jak w AVS; MilkDrop na telefonie

Bez migracji. Zgłoszenia: „zrób sobie screeny jeszcze raz tego avs… bo jeszcze nie wszystko działa
idealnie”; „na mobilnym… wizualizacje… były do lewego górnego rogu”.

**Metoda.** Arkusze po 12 par (AVS | nasz) na klatce 300 dla wszystkich 62 presetów, ranking
różnic i bisekcja komponentów w obu silnikach (narzędzia sesji, poza repozytorium).

**Custom BPM czytany źle przez konwerter** (webvsc, `getRadioButton`). Wszystkie 22 Custom BPM-y
z presetów wychodziły jako „stałe tempo 21 ms po 21 pominiętych beatach”, a naprawdę to „co 2., 4.,
5., 9., 10. albo 11. beat”, bez pomijania na starcie. W tych presetach efekty na beacie stały
przez pierwsze ~10 s, a potem strzelały w prawie każdej klatce — stąd część „nie reagują albo
reagują dziwnie”.

**Convolution Filter liczy jak AVS** (102 filtry w 45 presetach, `e_convolution.cpp`, bajt po bajcie
generowanego MMX):
- bias to 256 × bias;
- „wrap” (u webvsc `edgeMode: WRAP`) zawija ujemną wartość do 65536 + wartość, a nie współrzędne
  obrazu; krawędzie są zawsze przedłużone;
- „absolute” to psubsw i skasowany bit znaku: ujemna wychodzi jako 32768 + wartość, więc biel —
  to nie jest wartość bezwzględna;
- ujemna skala odwraca znaki i dzieli przez moduł (YUMinimized: z −1 i „absolute” było czarne,
  a po Invert białe);
- dwa przejścia: jądro obrócone o ćwierć obrotu i **suma** obu (komentarz w źródle mówi psubusw,
  bajty `0F DD` to paddusw); wcześniej drugie przejście było pomijane;
- dzielenie przesunięciem albo 16-bitowym mnożeniem przez 65536 / skala; packuswb czyta słowo ze
  znakiem (32768 i więcej to czerń).

**Wynik** (klatka 300, 39 presetów, które wzorzec renderuje): 11 zgodnych, mediana 41.
- YUMinimized: z 246 na 91 — nie jest już biały.
- Zgodne wcześniej zostały zgodne.
- Otwarte, opisane w `NEXT-SESSION.md`: The Convicts, amanita, Lans of Kansis, insania, bad
  taste, golden rush, Echolot, disco, Ghost, Son of Ptaah, A1 nixa i 80s3.
- W The Convicts i amanicie różnica zaczyna się w miejscu, którego bez śledzenia samego wzorca
  nie da się rozstrzygnąć.

**MilkDrop i Geiss na telefonie.** butterchurn rysuje klatkę w rozmiarze z `setRendererSize`
i kopiuje ją 1:1; jego `pixelRatio` skaluje tylko tekstury. Dostawał rozmiar CSS i `pixelRatio: 2`,
więc przy `devicePixelRatio` 2 obraz zajmował ćwiartkę płótna w lewym górnym rogu. Na ekranie 4K
z przyciętą rozdzielczością pokazywał z kolei lewy górny wycinek za dużej klatki. Teraz dostaje
piksele płótna i `pixelRatio: 1` (tekstury bez zmian). Sprawdzone na emulowanym telefonie
375×812 przy dpr 2: wszystkie wizualizacje wypełniają panel (MilkDrop i Geiss wcześniej tylko
ćwiartkę).

## 08.11.2026 (1) — Internal, „Ulubione” na koncie, wizualizacje niezależne od głośności

**Migracja `040_visualizer_favorites`** (tabela `visualizer_favorites`). Konto aplikacji ma tylko DML,
więc migrację uruchamia konto z prawem do DDL (jak w `TESTING.md`). Bez niej ulubione zostają
w przeglądarce, jak dotąd.

Zgłoszenia: „Snow globe do usunięcia”; „nasze wizualizacje autorskie nazwałbym Internal, z menu
wyboru jak w innych, oraz dodać ulubione”; „ulubione do bazy danych”; w AVS „nie reagują niektóre
na dźwięk”; Moss Ball i Flame — „każdy powinien mieć możliwość”.

**Internal.** Szesnaście własnych wizualizacji (Snow Spectrum, Poweramp, Solar Flare, Audio Flow
Field…) to teraz presety jednej wtyczki, a nie szesnaście pozycji pierwszej listy.
- Panel daje im to samo, co MilkDropowi: Auto (talia co 30 s z przenikaniem 1,2 s), kłódkę,
  gwiazdkę, „następny” i „Auto — tylko ulubione”.
- Każda rysuje na własnym płótnie i z własnym `AnalyserNode` (swój `fftSize` i wygładzanie), jak
  wcześniej w silniku (`visualizations/internal.ts`).
- Zapisane ustawienia z ich identyfikatorami znaczą Internal na miejscu pierwszej z nich, a zapisany
  wybór to wybrana wizualizacja Internal. Migracji danych to nie wymaga (`CatalogActions.php`
  i `canonicalVisualizerId`).
- Panel administracji pokazuje teraz jedną pozycję, Internal.

**„Ulubione”** — nowa pozycja pierwszej listy (druga, po Internal): ulubione presety wszystkich
oferowanych wizualizacji na jednej liście, w grupach po wizualizacji.
- Auto gra je po kolei. Następny ulubiony tej samej wizualizacji to jej własne przejście (MilkDrop
  przenika, AVS przygasa); ulubiony innej wizualizacji wczytuje się niewidocznie nad tą na
  ekranie i wchodzi przenikaniem 1 s (`visualizations/favorites-visualizer.ts`).
- Wizualizacje otwierane są na danym presecie bez zapamiętywania wyboru
  (`ExternalOptions.preset` i `persist: false`), więc własne wybory MilkDropa czy AVS zostają.
  MilkDrop otwiera się wtedy na wszystkich paczkach naraz.
- Ulubiony, którego wizualizacja już nie ma (paczka zniknęła), albo wizualizacja, która nie
  wstaje, jest pomijany do końca wizyty.
- Gwiazdka zdejmuje preset z ulubionych jego wizualizacji. Bez ulubionych pokazuje się
  podpowiedź, gdzie je dodać.

**Ulubione na koncie.** Gwiazdka zapisuje się na koncie (`visualizer_favorites`; akcje
`visualizer_favorites` i `visualizer_favorites_save` w moście PHP, limit 500 na wizualizację,
nazwy porównywane dokładnie), więc idą za słuchaczem na każde urządzenie.
- Ulubione z przeglądarki przechodzą na konto przy pierwszym wejściu i znikają z przeglądarki.
  Te bez nazwy dostają ją z listy wizualizacji, gdy ta się pokaże.
- Gość i instalacja bez migracji trzymają je w przeglądarce, jak dotąd.
- „Auto — tylko ulubione” zostaje wyborem przeglądarki, jak wybrany preset.

**Głośność nie dotyka już wizualizacji.** Głośność i wyciszenie siedziały na elemencie `<audio>`,
więc analizator dostawał muzykę ściszoną suwakiem: przy 30 % preset AVS z `getspec()` dostawał
trzecią część tego, co dawał Winamp (ten brał dane przed głośnością), a po wyciszeniu nic.
- Odkąd wizualizacja raz przepuści dźwięk przez Web Audio, głośność i wyciszenie to wzmocnienie
  za analizatorem (`GainNode`), a element gra na pełnej głośności. Bez wizualizacji wszystko jest
  jak było.
- AVS „zoomy” (Back2Future): reaguje tylko na beaty — szarpnięcie wiru (`ts=getosc(.5,0,0)`
  i losowe przesunięcie w kodzie `onBeat`). Gwiazdy lecą ze stałą prędkością, a Blitter Feedback
  ma stały zoom, także w Winampie i także po pauzie.
- Sprawdzone offline na trzech utworach: nasze wykrywanie beatów daje 110–130 na minutę w tempie
  utworu. Także `getosc` liczy jak AVS (`avs_eelif.cpp getvis`).

**Moss Ball i Flame (VoltViz) z `vendor/`.** Ich shadery są na CC BY-NC (4.0 i SA 3.0), więc nie
wchodzą do repozytorium.
- Właściciel może położyć oryginalne pliki voltviz (`MossBall.ts`, `Flame.ts`) w
  `frontend/vendor/voltviz-extra/` (gitignore). Build dokłada je wtedy do VoltViz jako
  „Moss Ball (ledhieu)” i „Flame (kuvkar)” dla wszystkich na tej stronie
  (`scripts/voltviz-extra.mjs`, moduł `virtual:voltviz-extra`).
- Ich importy rozwiązują się do vendorowanego voltviz, jakby leżały w jego `visualizers/impl/`.
- Na tej instalacji leżą, a VoltViz ma 50 wizualizacji.

**Space 0.9b** (archiwum winamp-libre, rozpakowane `acefile` 0.6.14 z PyPI za zgodą właściciela):
- licencja: „Copyright 2000 by Pascal Dallongeville”, darmowy tylko do użytku prywatnego,
  a pokazywanie tego, co generuje, publicznie bez zgody autora jest zabronione;
- nie do przeniesienia bez zgody autora (port zająłby ok. 2–3 tygodni).

Snow Globe usunięty w całości (kod, wtyczka builda, identyfikator), zanim trafił do commita.

**Nowe pliki do commita:**
- `migrations/040_visualizer_favorites.sql`;
- `frontend/scripts/voltviz-extra.mjs` (+ `.d.mts`);
- `frontend/src/shared/visualizations/`: `internal.ts`, `internal-plugin.ts`,
  `favorites-plugin.ts` i `favorites-visualizer.ts`.

Testy: `npm run build`, `test:ui` 85/85, `check.py --audit`. W aplikacji, na koncie testowym
(skasowanym):
- pierwsza lista;
- Internal: Auto po 30 s i przenikanie;
- gwiazdka w bazie z nazwą;
- przeniesienie ulubionych z przeglądarki;
- „Ulubione”: grupy, zmiana silnika AVS → VoltViz z przenikaniem, nietknięte wybory AVS i VoltViz;
- Moss Ball i Flame startują.

## 07.11.2026 (9) — VoltViz, wizualizacje przy 96/192 kHz, ulubione w panelu

Bez migracji. Zgłoszenia: „voltviz to bym oddał te 50 własnych”; panel wizualizacji (otwarta
lista zostaje, gdy pasek znika; w Auto nie widać, co gra; zapisanie presetu i ulubione);
archiwum winamp-libre — „jeżeli się da to przenieść, aby nie przesadzić”.

**Panel wizualizacji** (każda wizualizacja z presetami: MilkDrop, Geiss, AVS, VoltViz):
- w Auto lista pokazuje, co gra („Auto: <preset>”), a kłódka zostawia ten preset na stałe;
- gwiazdka dodaje preset do ulubionych: grupa „★ Ulubione” na górze listy, zapis w
  `localStorage` tej przeglądarki;
- od dwóch ulubionych jest „Auto — tylko ulubione”. Filtr trafia do wizualizacji przed pierwszym
  presetem (`ExternalOptions.autoFilter`), więc od pierwszej klatki gra ulubiony. Wcześniej przez
  sekundę grał losowy z całej listy;
- otwarta lista trzyma pasek (najwyżej pół minuty), zamiast wisieć nad obrazem bez niego.

**VoltViz.** 48 z 54 wizualizacji voltviz 0.35.1 (MIT) to presety jednej wtyczki. Dźwięk
analizuje silnik voltviz (onsety, tempo, siatka beatów) w AudioWorklecie podpiętym pod analizator
odtwarzacza.
- Pominięte: MilkDrop i MilkDrop Warp (mamy własny MilkDrop), Moss Ball i Flame (shadery
  CC BY-NC, nie do repozytorium MIT), Your Logo (wymaga wgrania SVG) i Icons (React; wersja na
  ikonach Font Awesome blokowała stronę na ~45 s).
- Nowe zależności: three 0.186.1 i d3-geo 3.1.1 (z d3-array i internmap).
- Sprawdzone w aplikacji: wszystkie 48 startują i przenikają się pod CSP strony; Auto, kłódka
  i ulubione działają tak jak w MilkDropie. Szczegóły w `FRONTEND.md`.

**Dźwięk 96/192 kHz.** `AudioContext` odtwarzacza działa z częstotliwością karty, u właściciela
192 kHz, a wizualizacje czytały go jak 44,1/48 kHz:
- AVS: oscyloskop pokazywał 3 ms zamiast 13 ms z Winampa, widmo 0–22 kHz mieściło się
  w pierwszych 132 z 576 wartości, a beaty liczone z okna krótszego niż okres basu skakały;
- MilkDrop: 5 ms próbek zamiast 23 ms, czyli fale prawie proste, a bas z dwóch binów;
- Geiss Classic: „bas” brany z 190–1500 Hz.

Teraz szybszy kontekst jest czytany jak 48 kHz (`visualizations/audio-rate.ts`): analizator 2× lub
4× dłuższy, przebieg uśredniany w dół, a widmo tylko z binów słyszalnych. butterchurn dostaje
próbki od nas (`render({ audioLevels })`) i częstotliwość 48 kHz do swoich pasm. Odtwarzanie się
nie zmienia, a przy 44,1/48 kHz wszystko działa jak dotąd. VoltViz robi to samo u siebie
(`voltviz/audio/host/rate.ts`).

**AVS — dalsze poprawki z porównań ze wzorcem:**
- konwerter (webvsc) czytał kod Effect List o bajt za późno, więc kod list wychodził pusty albo
  bez ostatniego znaku (The Convicts rysuje teraz łuki);
- kod listy działa także wtedy, gdy lista jest wyłączona (może ją sama włączyć). „Enable on beat”
  znaczy „włączona albo w oknie klatek po beacie”, a rodzic zawsze woła listy-dzieci, jak AVS;
- `getkbmouse` zwraca 0 (AVS bez okna myszy);
- Moving Particle startuje z pozycji i prędkości oryginału;
- SuperScope przechodzi przez kolory w cyklu 64 klatek (jeden kolor rysowany ×63/64).

Na klatce 300 zgodnych jest 11 z 39 porównywalnych presetów.

**Archiwum winamp-libre** (pobrane tylko archiwa źródeł, bez .dll i .exe, przeglądane w izolacji):
- Snow Globe (Michael Wallace, licencja „do dowolnego użytku”) — przeniesiony próbnie, ale
  właściciel go odrzucił („paskudne”), więc do projektu nie wszedł;
- Soundscape — GPLv2, kodu nie można włączyć do projektu MIT;
- Walter i Singing Walter — kod Half-Life SDK (Valve) i modele z gry; Singing Walter to sam DLL;
- Synesthesia — sama nic nie rysuje, to most do wtyczek Sonique (DLL);
- Space 0.9b — źródło jest w archiwum ACE 2.0, którego bez dodatkowego narzędzia nie da się
  rozpakować (w środku są też .dll i .exe); licencja nieznana;
- LiquidTrixx (.exe i 24 MB zip) pominięty; G-Force i WhiteCap to programy komercyjne.

**Nowe pliki do commita** (frontend):
- `src/shared/visualizations/`: `audio-rate.ts` (+ test), `favorites.ts`, `voltviz-plugin.ts`
  i katalog `voltviz/`.

`CatalogActions.php` zna `voltviz`, więc na istniejących instalacjach przychodzi włączony. Testy: `npm run build`, `test:ui` 84/84, `check.py --audit`.

## 07.11.2026 (8) — AVS sprawdzany klatka po klatce z AVS-em; paczki presetów MilkDrop

Bez migracji. Zgłoszenie: „nie najlepiej to działa dalej avs… progresu nie ma” oraz lista linków
(projectM, voltviz, MilkDrop3, avs-preset-depends i inne).

**Metoda.** Wzorcem jest AVS zbudowany ze źródeł grandchild/vis_avs (BSD, kontynuacja kodu
Nullsoftu). Dostaje to samo audio (Darude – Sandstorm od 1:00) i te same beaty co nasz silnik.
Porównywane są te same klatki, a gdy preset się różni, komponenty sprawdza się po kolei aż do
pierwszego rozjazdu. Wzorzec sam miał błędy względem oryginału Nullsoftu; w jego lokalnej kopii
(narzędzie sesji, poza repozytorium) poprawione są:
- odwrócony gradient i przejście map w ColorMap;
- bilinear z SSE zamiast arytmetyki MMX oryginału;
- ułamek pozycji w Dynamic Movement i Roto Blitter brany z młodszego bajtu;
- numer bufora o jeden za mały w Buffer Save i w trybie „Buffer” Effect List — bufor 1 nigdy nie
  działał;
- Custom BPM na zegarze ściennym;
- losowe tryby Mirror i Channel Shift inne niż w oryginale;
- ziarno `rand()` z zegara.

Losowość obu silników można zrównać w trybie testowym (`avsRandom.ts`): `rand(x)` w kodzie to
Mersenne Twister z WDL EEL2, a efekty losują jak `rand()` z biblioteki Microsoftu, w tej samej
kolejności co AVS.

**Najważniejsze poprawki:**
- **Konwerter (webvsc) czytał pola Movement o bajt za wcześnie.** 39 ze 101 Movementów
  prostokątnych działało jako biegunowe, np. `y=y+.04` nie robiło nic.
- **Movement liczony per piksel jak `r_trans.cpp`:** tablica źródeł dla każdego piksela,
  pozycje z dokładnością 1/32 piksela, wbudowane efekty z wzorów C (nie z przybliżeń
  w skrypcie), „source mapped” i przełączanie na beacie. Tablicę dla 1280×720 (prawie milion
  wywołań kodu) liczy Web Worker; zanim wróci, działa przybliżenie na siatce. Liczona na stronie
  zatrzymywałaby obraz przy każdej zmianie presetu na ok. 0,9 s.
- **Arytmetyka bilinear z MMX oryginału** (`BLEND4`): każde przejście gubi 1–2 poziomy, jak
  w AVS, na czym opiera się wygaszanie presetów ze sprzężeniem zwrotnym.
- **Dynamic Movement przesunięty o pół piksela:** brał środek piksela zamiast jego rogu, więc
  nawet ruch „bez ruchu” rozmywał obraz. Do tego siatka przycinana jak w AVS, okres zawijania
  w − 2 / w − 1 i „nearest” z zaokrągleniem w dół.
- **Water, Video Delay i „source mapped” w Effect List nie pamiętały poprzedniej klatki.**
  Zapis klatki kończył się pętlą sprzężenia WebGL, więc draw był odrzucany; zostawała czarna.
  Stąd białe plamy z żółtym brzegiem.
- **SuperScope:**
  - zmieniał znak zmiennej `y` w miejscu, więc kod czytający `y` poprzedniego punktu
    (wypełnianie zygzakiem) rysował jedną kreskę;
  - kolory przycinane jak `makeint()`;
  - punkty trafiają w piksel AVS, a nie obok niego.
- **Mosaic** z krokiem bloków i przejściem po beacie jak w AVS.
- **ColorMap:** mapy wypiekane jak w AVS, przejście między mapami z prędkością cyklu, losowanie
  spośród 8 slotów.
- **Custom BPM** (15 presetów) przestawia beat dla efektów po nim. Effect List stosuje `beat`,
  `alphain` i `alphaout` z własnego kodu.
- **Nowe porty** z vis_avs: Dynamic Distance Modifier per piksel (z przybliżonym `isqrt` AVS,
  stąd jego pierścienie) i Dot Plane.
- **Effect List „Buffer”** w liczbach całkowitych AVS.

**Wynik** (klatka 300, 40 presetów, które wzorzec potrafi wyrenderować; 21 go wywraca):
- 10 zgodnych;
- reszta różni się głównie losowością pikseli (Scatter, Grain) wzmacnianą przez Water
  i sprzężenie zwrotne;
- osobno ColorMap i bufory w kilku presetach Back2Future.

**Licencje:** `LICENSE-vis_avs.txt` (BSD, Nullsoft) obok forka webvs. webvsc 2.3.0 jest teraz
kopią w `frontend/scripts/webvsc/` (MIT) z poprawkami, a pakiet npm `@visbot/webvsc` usunięty.

**Paczki presetów MilkDrop:** projectM Cream of the Crop (9 682 z 9 795) i MilkDrop original
(552) obok presetów butterchurna, pod własnymi nazwami w selekcie „Paczka presetów”. Szczegóły
konwersji w `FRONTEND.md`.

## 07.11.2026 (7) — AVS: porty efektów z vis_avs, bufory, koniec bielenia

Bez migracji. Zgłoszenie: presety, które zaczynały żółte i ładne, z sekundy na sekundę
jaśniały aż do białego ekranu; do tego ziarno, jednolita czerwień, czarne ekrany i biała połowa.

**Przyczyny bielenia i jednolitych ekranów:**
- **Fadeout liczony po webvs-owemu.** AVS przesuwa każdy kanał o „speed” kroków na 255
  w stronę koloru. webvs brał tę liczbę jako ułamek: przy 1 ściemniał o połowę, przy większych
  wartościach nie robił nic.
- **Brak Brightness**, który w presetach ze sprzężeniem zwrotnym gasi to, co przybywa co klatkę.
- **Mnożenie w webvs z `×256`.** Każdy tryb Multiply dawał biel.
- **Tablice webvsc bez trybu „Minimum”.** Effect List przychodziła bez trybu.
- **Tryb „Adjustable” bez wartości suwaka**, a tryb „Buffer” w ogóle niezaimplementowany.
- **Klucze ColorMap pod innymi nazwami.** Mapa czytała tylko czerwony.
- **Interleave przy `x = 1`** zamalowywał cały ekran.
- **Mosaic, Moving Particle i Color Clip** dostawały jednostki AVS, a webvs czytał je jako
  ułamki.
- **Grain i Scatter** miały stały wzór szumu, który w sprzężeniu narastał w „brud”.
- **Starfield** wołał tryb rysowania równy 0. Klatka rzucała wyjątek i zostawiała podpięty bufor,
  więc każdy następny preset rysował się „na biało”. Teraz po błędzie stan GL jest zerowany.

**Nowe komponenty**, porty z vis_avs (BSD) i APE:
- **kolor:** Brightness, Colorfade, Color Reduction, Color Modifier;
- **piksele:** Water, Bump;
- **ruch:** Dynamic Shift, Dynamic Distance Modifier;
- **pamięć klatek:** Video Delay;
- **pozostałe:** OnBeat Clear, Add Borders, MultiFilter (chrome), Triangle, Text (rozmiar czcionki
  build czyta z pliku `.avs`), Starfield, Global Variables.

Każdy z 50 typów komponentów używanych przez 62 presety ma teraz klasę.

**Bufory globalne jak w AVS:** osiem buforów, numery przycinane do zakresu. Dynamic Movement
i Bump czytają zapisany bufor, a gdy nikt go nie zapisał, nic nie robią.

**Beat:** algorytm z vis_avs. Próg głośności podąża za utworem, więc ciche nagrania też dają beat.

**Parser** pomija instrukcje, których nie umie odczytać, jak robiło to AVS. Ratuje to „notatki”
między średnikami.

**Audyt 62 presetów** (sztuczny dźwięk, 600 klatek):
- 26 rusza się w pełnym obrazie;
- 7 rusza się, ale jest prześwietlonych albo ciemnych;
- 27 stoi w miejscu (białe, czarne albo jednolite);
- 2 się nie ładują: Echolot (makra AVSTrans) i Orifice (składnia w `init`).

Dla porównania w (6), tą samą metodą: 25 z pełnym obrazem, 12 białych, 14 czarnych,
11 jednolitych.

## 07.11.2026 (6) — AVS: kolory, ruch i brakujące efekty

Bez migracji. Bramka 10/10 z `--audit`. Zgłoszenie: „raz białe tło, raz czarne, coś się ruszy
i zatnie". Przyczyny i poprawki (wszystkie w forku webvs, opisane słowem „Fork:"):

- **Tryby mieszania pod innymi nazwami.** webvsc pisze `FIFTY_FIFTY`, `SUB_DEST_SRC`,
  `EVERY_OTHER_LINE`, `XOR`, `MINIMUM`…, webvs znał `AVERAGE`, `SUBTRACTIVE1`… — nieznana nazwa
  dawała `undefined` i warstwy mieszały się dowolnie. Jedna tabela tłumaczeń (`avsBlend`),
  nowe tryby MINIMUM i XOR (te same numery w obu wyliczeniach).
- **Dynamic Movement w ogóle nie działał** (44 z 62 presetów): kod per-piksel przychodzi jako
  `perPoint`, współrzędne jako „CARTESIAN”, a webvs czytał `perPixel` i „RECT”. Po
  przetłumaczeniu wyszło, że generator GLSL webvs nie umie połowy tego, co presety piszą,
  więc kod per-piksel liczy teraz procesor w punktach siatki, jak oryginalny AVS
  (`CpuDynamicMovement`), z opcją „wrap”. Zero błędów kompilacji shaderów.
- **Inne nazwy opcji:** SuperScope (źródło dźwięku), ColorMap (tryb), ChannelShift (kanał),
  Clear Screen („tylko pierwsza klatka” czyściło co klatkę i kasowało całe sprzężenie
  zwrotne) — tłumaczone w jednym miejscu przy tworzeniu komponentu (`converterCompat.ts`).
- **Set Render Mode** naprawdę ustawia tryb mieszania linii dla kolejnych scope'ów w klatce.
- **Nowe komponenty:** Ring, Simple, Starfield, FyrewurX (odtworzenie), RotoBlitter,
  Blitter Feedback, Grain, Scatter, Interleave, Fast Brightness, Multiplier.
- Dzielnik ConvolutionFilter ≤ 1 → suma jądra (skala −1 odwracała obraz); w ukrytej karcie
  preset zmienia się bez przenikania (dławiony timer zatrzymywał zmianę).

Audyt 62 presetów (syntetyczna muzyka): **60 działa** (wcześniej 37–58), 25 daje pełny obraz,
reszta to głównie presety oparte na brakujących komponentach (Triangle 20×, Text 7×,
DynamicShift 6×, ColorReduction, Colorfade…).

## 07.11.2026 (5) — AVS (Winamp): własny silnik bez `eval`, wersja testowa

Bez migracji. Bramka 10/10 z `--audit`. Nowe zależności (MIT): `lodash-es` 4.18.1,
`eventemitter3` 3.1.2, `eel-wasm` 0.0.16; deweloperska `@visbot/webvsc` 2.3.0.

- **Silnik:** fork webvs 3.0.0 (`src/shared/visualizations/avs/webvs`) z kompilatorem skryptów
  wymienionym na `avs/eel.ts` (parser eel-wasm → AST webvs → domknięcia; bez `new Function`).
  Działa przy obecnym CSP; nawet `'wasm-unsafe-eval'` nie jest mu potrzebne.
- **Presety:** sześć paczek AVSociety z archiwum VISBOT (za zgodą właściciela) w
  `frontend/vendor/avs-presets/` (gitignore). Instalatory NSIS rozpakowane jako dane, bez
  uruchamiania: 62 presety z 4 paczek (Anthology i 8 Ronin to wariant bzip2 — odłożone).
  Build konwertuje je przez webvsc do JSON-a ładowanego na żądanie (561 KB, 60 KB gzip).
- **Dopisane komponenty i poprawki forka:** Movement (z 24 formułami z vis_avs), ConvolutionFilter,
  TexerII, Blur, wyciszone Comment/CustomBPM/SetRenderMode/Water/Bump/OnBeatClear; naprawione
  pola klas, bufory BufferSave, GLSL `%`/`&&`, SuperScope, ColorMap, brakujące bitmapy paczek.
- **Wynik audytu:** 58/62 wczytuje się, ok. 21 daje obraz ze strukturą; reszta jednolity kolor
  — stąd etykieta „test” i włączanie ręczne w panelu. Plan dalszej pracy w `NEXT-SESSION.md`.

## 07.11.2026 (4) — czarny ekran MilkDropa, Geiss Classic, chowany pasek wizualizacji

Bez migracji. Bramka 10/10 z `--audit`.

**Czarny ekran (zgłoszenie: „działają na początku i znikają")** — audyt wszystkich 350
presetów na stronie testowej (syntetyczna muzyka, 10 s symulacji każdy):
- dwa presety rzucają z WebAssembly w trakcie klatki („float unrepresentable in integer
  range"); wyjątek wychodził z pętli animacji silnika, która przestawała planować klatki —
  obraz gasł na stałe, a tryb auto, żyjący w tej pętli, już się nie przełączał. Pętla łapie
  teraz błąd klatki, a preset, który rzuca, jest od razu zastępowany i zapamiętywany w tej
  przeglądarce (`media-visualizer-failed-presets`);
- dwa są czarne od pierwszej klatki (m.in. „Geiss - Game of Life 3"), cztery gasną po kilku
  sekundach — osiem znanych wadliwych wypadło z listy (`BROKEN_PRESETS`, test);
- obraz czarny przez 5 s przy grającej muzyce → auto przechodzi dalej (cisza nie liczy się:
  wygaszanie się z nią to zamysł wielu presetów); rozdzielczość wewnętrzna do 1440p (pół
  tuzina pełnowymiarowych tekstur butterchurna przy 8 Mpx to ryzyko utraty kontekstu GPU).

**Obsługa** — dwuklik na obrazie i przycisk „następny preset": w auto od razu kolejny,
w trybie przypiętym następny z listy. Pasek wizualizacji i kursor chowają się po 2,5 s bez
ruchu nad obrazem i na pełnym ekranie; wracają z ruchem, dotykiem lub klawiszem (przy
obsłudze klawiaturą pasek zostaje).

**Geiss Classic** — wygląd wtyczki Geissa z 1998 r. odtworzony w WebGL 2 (nie port kodu):
bufor jasności przeciągany co klatkę przez pole przemieszczeń (zoom, obrót, wir, fale),
wygładzany i wygaszany, fala dźwięku rysowana punktami, cyklująca paleta; 8 scen,
w trybie auto płynne przejście wszystkich parametrów co 16 s, uderzenia basu pulsują
zoomem. Bez presetów, WebAssembly i `eval`; osobny fragment 9 KB.

**AVS — nie zrobione, świadomie.** Port przeglądarkowy (webvs 3.0.0, 2022) kompiluje
wyrażenia przez `new Function`, czyli wymaga `'unsafe-eval'` w CSP, i nie zawiera żadnych
presetów (natywne `.avs` trzeba konwertować, paczki społeczności mają niejasne licencje).

## 07.11.2026 (3) — MilkDrop i Geiss, gatunki bez zbędnego przeglądu, poprawki układu

Bez migracji. Kopia sprzed serii: `media-server-20261107-pre-icons-and-panels`. Bramka 10/10
z `--audit`; staging zrestartowany skryptem (zmiany w Pythonie).

**Wizualizacje MilkDrop i Geiss** — butterchurn 3 (WebGL 2) z ok. 350 presetami; „Geiss" to
presety Ryana Geissa. Drugi select: „Auto — płynne przejścia" (talia bez powtórek, przenikanie
2,7 s) albo konkretny preset; tytuł utworu w obrazie przy zmianie utworu; rozdzielczość panelu ×
DPR do 2. Presety kompilowane do WebAssembly, więc CSP strony dostał `'wasm-unsafe-eval'`
(przykłady Apache i działający vhost; **wymaga przeładowania Apache**). Silnik montuje wtyczkę
z własnym płótnem WebGL, zwalnia kontekst przy zmianie, a gdy WebAssembly jest zablokowane —
mówi to w selekcie zamiast pokazywać czarny ekran. Sprawdzone: kompilacja i renderowanie
1920×1080 na stronie testowej bez CSP; w aplikacji przy starym CSP — komunikat. Nowe wtyczki
przychodzą włączone na istniejących instalacjach (identyfikator spoza zapisanego porządku).

**Gatunki: lista „do sprawdzenia" 137 → 31**

- „Scary Movie" przegrywał ze „Scary Movie 2": numer części liczył się jak wariant pisowni
  (zawieranie = 88–92 %). Inna część serii to teraz inny film (`other_part`).
- Przy remisie alternatywy są przycinane do pewności zwycięzcy — panel pokazywał zgadywanie
  81 % nad rywalem 89 %.
- Najlepsza propozycja poniżej progu oferty (30) to „Bez wyniku", nie przegląd — 98 pozycji
  typu zwiastun „Lily & Kat" → „Asterix i Obelix".
- Dokładny tytuł i rok, film, brak rywala i czas trwania w granicach 30 min (wersje reżyserskie:
  Gladiator +16 min) → przyjęte bez pytania. Seriale bez roku nadal idą do człowieka.
- Zaległy przegląd jest przeliczany z zapisanych kandydatów (bez zapytań do Filmwebu) na
  początku każdego przebiegu; puszczony raz ręcznie: 8 dopasowanych, 98 do „Bez wyniku".
- Powody po polsku w panelu, „1 plik" zamiast „1 plików". Testy: `tests/test_filmweb.py`.

**Układ** — przycisk „Zapisz" przyklejony do selecta w formularzach konta (formularz nie miał
żadnego układu); pasek odtwarzacza między 1248 a 1408 px nachodził prawą grupą (głośność,
gwiazdki, ikony) na przyciski odtwarzania — w tym przedziale grupa ma własny rząd; etykieta
„gra z" dla kolejek zapisanych przed nazwami uzupełnia nazwę playlisty jednym zapytaniem.

## 07.11.2026 (2) — losowanie bez powtórek, „gra z…", panele konta i admina, ikony Pro

Bez migracji. Kopia plików i SQL: `media-server-20261107-pre-icons-and-panels` (stara para
usunięta). Bramka 10/10 z `--audit`; sprawdzone na żywo na 375 i 1100 px.

**Losowanie (zgłoszenie: „niektóre utwory się zapętlają", „po ponownym otwarciu losuje z części")**

- **Losowanie ze zwracaniem.** Tryb „A" i „mieszanie załadowanego okna" wybierały każdy
  następny utwór losowo z całej listy — ze zwracaniem. Przy kilkuset ulubionych to paradoks
  urodzin: powtórka zwykle w pierwszych ~20 utworach, a część listy nie pada wcale. Kolejność
  z ziarnem, którą serwer i tak podaje, jest już losową permutacją — „dalej" idzie po niej
  po kolei, więc jeden przebieg gra każdy utwór raz. Mieszanie okna (kolejka bez porządku
  z serwera) losuje tylko spośród jeszcze niegranych (`nextUnplayedIndex`, testy).
- **„Powtarzaj wszystko" zapętlało ostatni fragment.** Koniec listy wracał do indeksu 0
  *załadowanego okna*, czyli gdzieś w środek długiej listy — ostatnie kilkaset utworów
  w kółko. Nowy przebieg startuje od prawdziwego początku, a losowy dostaje nowe ziarno.
- **Wybrany utwór grał drugi raz** (doklejony na początek okna i jeszcze raz tam, gdzie
  wylosował go serwer), a doklejenie przesuwało stronicowanie o jeden i jeden utwór
  przepadał. Strony „dalej" zaczynają się o wiersz wcześniej (scalanie usuwa duplikat),
  a zagrane w tym przebiegu są pomijane — także po przeładowaniu (stan zapisuje `played`).
- **Zmiana trybu lub koniec listy przebudowywały otwartą playlistę, nie graną.** Przeglądasz
  listę B, gra A — „losuj" albo koniec A startowały B. Teraz zawsze to, co gra; kolejkę
  przywróconą po przeładowaniu odbudowuje zapamiętane źródło.
- `setQueue` zeruje źródło kolejki: kolejka bez źródła dziedziczyła poprzednią playlistę
  i po przeładowaniu dostawała jej loadery.

**Co gra** — pasek odtwarzacza pokazuje nad tytułem źródło: playlista, playlista
inteligentna, folder, wyszukiwanie albo cała biblioteka (z nazwą; link prowadzi do źródła).
Wcześniej mówił to tylko panel kolejki. Etykiety kontekstu kolejki przeszły przez `t()`.

**Panele konta i administracji**

- Moje konto w sekcjach (Przegląd, Kolekcje, Ustawienia, Oceny i import, Bezpieczeństwo,
  Linki dla gości) jak panel admina — budowana jest tylko otwarta sekcja. Strona miała
  5207 px przy 1100 px szerokości, teraz Przegląd ma 1229 px. Stary adres
  `#collection-builder` otwiera sekcję Kolekcje z rozwiniętym kreatorem.
- Nagłówki sekcji: tytuł nad opisem — opis po prawej zabierał miejsce i tytuły łamały się
  („Aktywne / sesje", „Ustawienia biblioteki / i odtwarzacza").
- Kafelki po cztery: cztery w rzędzie albo 2×2, nigdy 3+1 (`clamp` progu kolumny w
  `panels.css`); w przeglądzie admina suma katalogu przeszła do nagłówka „Stan katalogu".
- Nagłówek profilu z awatarem, „Udostępnij profil" bez rozciągania na 1/3 strony; pola
  wyboru szerokości treści, nie panelu; listy aktywności 3 obok siebie albo jedna pod drugą,
  każda swojej wysokości (było `min-height: 28rem`).
- Panel admina: zakładki jako „pigułki", „Odśwież" na końcu ich rzędu (było: osobny trzeci
  rząd), konkretniejsze ikony sekcji; w kartach kont pola nowego hasła na pełną szerokość
  (placeholdery były ucięte). „2 administratorzy" zamiast „2 administratorów".

**Ikony: Font Awesome Free albo Pro**

- Domyślnie Font Awesome Free (jak dotąd). Właściciel z licencją Pro wkłada paczkę do
  `frontend/vendor/fontawesome-pro/` (w `.gitignore` — licencja nie pozwala publikować),
  a w **Administracja → Biblioteka → Ikony** wybiera jeden z 16 stylów (Classic, Duotone,
  Sharp, Sharp Duotone × Solid/Regular/Light/Thin) z podglądem na żywo.
- Build (`scripts/icon-packs.mjs`) bierze z paczki tylko fonty oferowanych stylów i generuje
  mały arkusz (dwie zmienne CSS: rodzina, grubość); styl jest oferowany tylko, gdy według
  metadanych paczki ma każdą ikonę interfejsu. Bez paczki „Pro" rysuje Free.
- Glif czyta rodzinę i grubość ze zmiennych, więc przełączenie niczego nie przerysowuje;
  atrybut ustawiany jest dopiero po wczytaniu fontu (bez mignięcia pustych ikon). Znaki „tak"
  (aktywne serce, gwiazdka oceny) zostają wypełnione w stylach konturowych.
- Serwer przyjmuje tylko znane wartości (`icon_pack`, `icon_style`; test porównuje listę
  PHP z frontem). Nowe ikony: ustawienia, kłódka, użytkownicy, wykres, baza, tagi, link,
  wysyłanie, wylogowanie, odświeżanie, „inteligentna" różdżka.

## 07.11.2026 — audyt całości: telefon, płynność i poprawki z trzech audytów kodu

Bez migracji. Kopia plików i SQL: `media-server-20261107-pre-ux-audit` (stara para usunięta;
paczka `…-pre-history-rewrite.bundle` zostaje). Front przejrzany na żywo na 375, 768, 1440
i 1920 px; logika frontu, most PHP i usługa Pythona przejrzane przez trzy niezależne audyty,
a **każde ustalenie zweryfikowane w kodzie przed poprawką** — część z nich okazała się
trafna co do objawu, ale z błędną propozycją naprawy (niżej). Bramka 10/10 z `--audit`.

**Telefon i tablet**

- **Panel administracyjny przewijał się w bok na telefonie** — 510 px strony na ekranie
  375 px, 46 elementów poza ekranem. `.admin-page` była siatką bez kolumn, więc niejawna
  kolumna `auto` rosła do szerokości paska zakładek (celowo bez zawijania), a jego
  przewijanie w poziomie nigdy się nie włączało. `minmax(0, 1fr)` w `.admin-page`,
  `.account-page`, `.admin-stage` i globalnie w `.stack`.
- **Filtry zajmowały cały pierwszy ekran** biblioteki muzyki (5), filmów (6) i kolekcji (4).
  Na wąskim ekranie (≤48rem albo ≤32rem wysokości — telefon w poziomie) panel jest zwinięty
  za przyciskiem „Filtry" z licznikiem ustawionych filtrów; na desktopie bez zmian.
  Wspólny moduł `shared/filter-panel.ts`; zwijanie animuje wysokość (`grid-template-rows`
  0fr↔1fr), a zwinięty panel dostaje `visibility: hidden`, więc znika też z kolejności Tab.
- **Karty po dwie w rzędzie na telefonie** zamiast jednej — przy jednej kolumnie każdy
  folder miał kartę wyższą niż pół ekranu. Prototypowane na żywo przed zmianą pliku (162 px
  karty, nic nie wystaje, zmierzone na obu bibliotekach); ≤22rem (320 px) zostaje jedna.
- **Strona główna**: dwie karty bibliotek zajmowały prawie dwa ekrany telefonu — teraz to
  dwa zwarte kafelki, a „Kontynuuj" widać od razu. Liczniki konta i panelu w siatce 2×2
  z pełnym słowem pod liczbą (wcześniej „administrat…" ucięte wielokropkiem).
- **Nagłówek prześwitywał**: przy tle 94% biały tekst przewijany pod spodem był czytelny
  („Pobierz folder" za tytułem strony). Teraz matowe szkło (`backdrop-filter`), a bez
  wsparcia — tło pełne.
- **Przyciski nie łamią już etykiet** w dwie linie; **cele dotyku** odtwarzacza 44 px przy
  `pointer: coarse` (było 38), chevron zwijania ma powiększony obszar trafienia;
  **uniesienie przy najechaniu** tylko tam, gdzie najechanie istnieje — na dotyku przycisk
  po stuknięciu zostawał „uniesiony"; za to wciśnięcie daje natychmiastową odpowiedź.

**Płynność**

- **Zmiana strony bez przeładowania wchodzi animacją** (Web Animations API na samym obszarze
  treści: krycie i przesunięcie, 280 ms) — powłoka i odtwarzacz stoją w miejscu.
- **Listy wchodzą schodkowo** (pierwsze 12 elementów; reszta i doładowane „więcej" od razu),
  **dialogi się otwierają** (`@starting-style`, bez JS), a wolna nawigacja ma cienki pasek
  postępu u góry (pojawia się dopiero po 180 ms). Wszystko tylko na `opacity`/`transform`
  i wyłączone przy `prefers-reduced-motion` — łącznie z opóźnieniem schodkowym, którego
  globalny reset nie zerował. `backwards` zamiast `both`, bo `both` przypinało
  `transform: none` i zabijało każdy hover z `transform`.

**Wydajność**

- **CSS z 174 kB do 107 kB (gzip 36 → 19 kB)** — CSS blokujący pierwsze malowanie na każdej
  stronie. Pełny `fontawesome.min.css` (71,6 kB, ok. 2000 ikon) zastąpiony przez
  `styles/icons.css` z 38 ikonami, których interfejs używa, generowanymi z danych biblioteki;
  poza warstwami kaskady jak oryginał (wymiar glifu 1,25em bez zmian — zmierzone na 237
  glifach). `shared/icons.test.ts` porównuje listę z `icons.ts` i każdy kod znaku z
  zainstalowanym Font Awesome.

**Treść i język**

- Strona główna mówiła domownikom o „Range", „workerze PHP" i podawała **nazwę bazy
  `media_server_stage`** (wpisaną na sztywno — także u każdej obcej instalacji). Usunięte;
  opisy mówią, co jest w bibliotece. Karta biblioteki niedostępnej dla grupy już się nie
  pokazuje (prowadziła do pustej strony).
- „Music"/„Movies" po angielsku w polskim interfejsie → „Muzyka"/„Filmy" (po angielsku
  dalej „Music"/„Movies").
- **Liczba mnoga**: nowe `tn()` z `Intl.PluralRules` — było „1 kolekcji", „2 kanałów",
  „1 plików", a nawet „12 982 plików" (poprawnie: „pliki", bo kończy się na 2). Testy
  obejmują 12–14, 21–24, zero i duże liczby.
- 37 wystąpień `toLocaleString("pl-PL")` na sztywno → `formatCount()` według języka.
  Kilkanaście napisów poza `t()` (filtry jakości, „Tylko HDR", „Pobierz wyniki",
  „publiczna/prywatna", `confirm()` przy usuwaniu kolekcji…).
- **Tytuł karty przeglądarki nie zmieniał się przy nawigacji** — historia i czytnik ekranu
  dostawały tytuł strony, od której zaczęła się wizyta.
- Komunikaty dla użytkowników bez żargonu („usługa stagingowa", „log mostu PHP").

**Błędy logiki frontu** (z audytu, każdy sprawdzony w kodzie)

- **Dialog „Udostępnij profil" był w całości nieklikalny** — siedział w `#app`, a
  `openModal()` usypia (`inert`) wszystkie dzieci `<body>` poza dialogiem, więc uśpił
  aplikację razem z nim. Teraz trafia do `<body>` przy otwarciu i schodzi przy zamknięciu.
- **Spacja zamykała film**: pierwszym fokusowalnym elementem każdego dialogu było jego
  pełnoekranowe tło. `modal.ts` pomija tła i `tabindex=-1`, przeglądarka fokusuje sam film
  (albo jego przycisk w trybie zgodnym), a globalny skrót spacji ustępuje dialogom,
  linkom, `video` i elementom `role=button` — wcześniej spacja na filmie przełączała
  jednocześnie film i muzykę w tle.
- **Zapis jednej zakładki ustawień cofał drugą** (np. włączoną rejestrację). Agent proponował
  wysyłać tylko własne pola, „bo serwer traktuje brak jako bez zmian" — to była prawda
  tylko dla kluczy bezpieczeństwa; pola biblioteki serwer **wymagał**. Naprawione po obu
  stronach: każde pole opcjonalne w `saveAdminSettings`, każdy formularz wysyła swoje.
  Sprawdzone na żywym moście (zapisy tych samych wartości, nic się nie zmieniło).
- **Odświeżanie „Indeksowania" co 4 s** budowało od nowa panel napisów (kolejny łańcuch
  odpytywania przy każdym odświeżeniu — ok. 50 zapytań/s po 5 minutach) i kasowało
  wpisywane pola. Panele ze stanem budowane raz na wizytę; odpytywanie kończy się po
  odłączeniu panelu; takt pomijany, gdy poprzedni jeszcze trwa.
- **Odtwarzacz stawał w ciszy** na pliku, którego przeglądarka nie zagra (druga porażka po
  odnowieniu biletu nie robiła nic). Teraz komunikat i następny utwór, po 5 z rzędu stop.
  Decyzja oparta na czasie od odnowienia, nie na znaczniku czyszczonym przez każde `play` —
  ten pozwalał na pętlę bez końca dla pliku psującego się w połowie.
- **Losowanie zaczynało bieżący utwór od 0:00** — `setQueue` zawsze go przeładowywał.
  Ten sam utwór na czele nowej kolejki gra dalej (o ile nie podano jawnej pozycji, jak
  przy przejęciu kolejki z innego urządzenia).
- **CAPTCHA po przełączeniu na rejestrację była pustym divem** — dostawcy renderują
  domyślnie raz, przy załadowaniu skryptu. Renderowanie jawne (`render=explicit`).
- Mniejsze: wyścigi w kolekcjach i przy powrocie do folderu z pamięci, strona pomijana
  po nieudanym „Załaduj więcej", pauza gubiona w synchronizacji kolejki, następny utwór
  czekający na zapis statystyk, ciche porażki ulubionych i kolekcji, siatka kolekcji jako
  region `aria-live` (czytnik czytał całą listę po każdej literze).

**Most PHP**

- **Zmiana hasła nie zamykała innych sesji** (skradzione ciasteczko działało dalej).
  Teraz zamyka wszystkie poza bieżącą, a reset przez administratora — wszystkie.
  Sprawdzone na żywo: drugie urządzenie po zmianie hasła → 401, ta przeglądarka → 200.
- **Link gościnny do `Wakacje_2024` obejmował też `Wakacje 2024`** — `_` w `LIKE` pasuje do
  dowolnego znaku. Sprawdzone na MySQL tym samym literałem PHP: przed 1/1, po 0/1.
- **Budżet pobrań linku gościnnego** do przekroczenia równoległymi żądaniami — teraz jedno
  warunkowe `UPDATE`, ze zwrotem miejsca, gdy token się nie wyda.
- **Zwykły administrator mógł odblokować wyłączonego super-administratora**; usunięcie grupy
  z gośćmi jako zastępczą robiło z administratorów gości (i mogło zamknąć panel jedynemu
  super-administratorowi). Import ocen omijał `can_rate`/`can_favorite`.
- **Import playlisty z polskiego Windows kończył się 500**: mbstring w PHP 8.4 w ogóle nie
  zna Windows-1250, a `ValueError` nie daje się stłumić `@` (zmierzone). Teraz `iconv`,
  potem `UConverter`, na końcu ISO-8859-2; nazwy z `%E9` przechodzą przez `mb_scrub`.
- Jeden błędny adres zatrzymywał cotygodniowy przegląd dla wszystkich — teraz każdy adresat
  osobno, a panel podaje, do kogo nie dotarło.

**Usługa Pythona** (staging zrestartowany skryptem, nowy kod potwierdzony na żywo)

- **Na Linuksie `Mission: Impossible (1996)` był w katalogu, a każde odtworzenie dawało 404**
  — reguły ścieżek Windows (dwukropek, `\`) obowiązywały na każdym systemie. Na Windows
  dwukropek jest teraz odrzucany w każdej części ścieżki (strumienie NTFS).
- **Jedna nazwa spoza UTF-8 albo plik przeniesiony w trakcie przerywał cały skan**;
  `lost+found` na punkcie montowania blokował każdy skan. Teraz pomijane i raportowane
  (`skipped`, `skipped_examples`). **Katalog nieczytelny z braku uprawnień dalej przerywa
  skan** — pominięcie oznaczyłoby jego zawartość jako brakującą.
- Tokeny z tras napisów obrazkowych trafiały do logów; `compare_digest` na znaku spoza ASCII
  dawał 500 zamiast 403; data sprzed 1970 przerywała ZIP na Windows.
- **`/v1/title-worker` nie był zamknięty w Apache** — test wyciąga teraz trasy wewnętrzne
  wprost z `app.py`, więc nowa trasa bez reguły zatrzyma bramkę.

**Zależności**: `certifi` 2026.7.22 → 2026.10.23 i `setuptools` 84.0.0 → 84.2.1 (pip-audit),
Vite 8.2 → 8.3.6 i `source-map-js` (npm audit, podatności serwera deweloperskiego).
`lock-deps.py --upgrade-package` podnosi tylko wskazane pakiety, zamiast wszystkich.

## 17.08.2026 (późnym wieczorem) — historia przepisana, jeden tag

Bez migracji i bez zmian w kodzie. **Wszystkie SHA się zmieniły** — kto ma stary klon, musi
sklonować od nowa; `git pull` nie połączy tych dwóch historii.

- **Adres VPS-a usunięty z historii.** Siedział w `docs/ROADMAP.md` w dwóch commitach
  (dodany, potem usunięty). `git filter-repo --replace-text` zamienił go na
  `[adres w prywatnej konfiguracji]`; 17 commitów zachowanych, `f9cbeba` → `9c88e8f`.
  Sprawdzone przez skan **wszystkich 460 obiektów** repozytorium i osobno na świeżym
  klonie: zero trafień.
- **Tagi skasowane i odtworzony jeden.** Przy okazji wyszło, że **`v0.1.0` nigdy nie był
  na zdalnym** — istniał tylko lokalnie, więc pierwsze wydanie nie było publicznie
  oznaczone. Zdalnie były `v0.1.1` i `v0.2.0`; oba skasowane, został jeden nowy `v0.2.0`
  wskazujący na bieżący stan.
- **Czego przepisanie NIE załatwia, i to jest zmierzone, nie przypuszczane**: GitHub nadal
  serwuje osierocone commity po SHA. `https://api.github.com/…/commits/85592bc` i
  `https://raw.githubusercontent.com/…/85592bc/docs/ROADMAP.md` oddają adres dalej.
  Zniknie dopiero po odśmiecaniu po stronie GitHuba — do tego trzeba zgłoszenia do
  ich wsparcia. Sam adres jest rekordem A dla `home.tryhackx.org`, więc DNS podaje go
  i tak; przepisanie było decyzją właściciela mimo tej uwagi.
- **Kopia przed operacją**: `C:\wamp64\backups\media-server-20260817-pre-history-rewrite.bundle`
  (896 kB, `git bundle verify`: „complete history", ze wszystkimi trzema starymi tagami).
  Do skasowania, gdy nowy stan się przyjmie.

## 17.08.2026 (wieczorem) — **cutover wykonany**, i reguła, która nie działała

Bez migracji. Apache przeładowany przez właściciela; smoke test wykonany po raz pierwszy
na żywo, przez publiczny adres.

**Stan po drugim przeładowaniu (domknięcie M7):** wszystkie sześć tras wewnętrznych usługi
transferowej oddaje z zewnątrz `403` — `health/ready`, `health/live`, `v1/catalog-scan`,
`v1/metadata-worker`, `v1/subtitle-cache`, `v1/stats`. Smoke test E2E powtórzony po
przeładowaniu przeszedł w komplecie, więc zamknięcie nie zabrało niczego po drodze.

- **Zdrowie usługi transferowej było osiągalne z internetu.** `https://…/media-transfer/health/ready`
  oddawało `200` i `{"status":"ready","unavailable_roots":[]}` zamiast 403. Reguła zamykająca
  **istniała** i wyglądała poprawnie — stała tylko w złym miejscu. `<Location>` i `<LocationMatch>`
  scalają się w kolejności z pliku, a przy domyślnym `AuthMerging Off` `Require` z sekcji
  późniejszej **zastępuje** wcześniejsze, zamiast się z nimi sumować; szeroki `Require all granted`
  stojący niżej kasował całe zamknięcie. Zmierzone na osobnym `httpd` na wolnym porcie, dwie
  konfiguracje różniące się **wyłącznie** kolejnością: „deny po grant" → 403, „deny przed grant"
  → 404, czyli żądanie szło do usługi. Zwykłe trasy transferu odpowiadają w obu układach tak
  samo, więc awaria była całkowicie cicha, a `configtest` mówił „Syntax OK".
- **Dotyczyło też tras zlecających zadania**, nie tylko zdrowia: `GET /media-transfer/v1/catalog-scan`
  oddawał `405`, a nie `403` — czyli żądanie **docierało do aplikacji**. Chronił je wyłącznie
  wewnętrzny klucz usługi (stąd `403` na POST), czyli została jedna warstwa z dwóch zamierzonych.
- **Poprawka sprawdzona na prawdziwej konfiguracji, nie tylko na wzorcu.** Żywa konfiguracja
  stagingu — sprzed poprawki i po niej — została wciągnięta do osobnego `httpd` na wolnym
  porcie i odpytana: przed `health=200`, `v1/catalog-scan=405` (żądanie dochodziło do usługi);
  po `health=403`, `v1/catalog-scan=403`. Trasa transferu w obu wypadkach `403` (token nadal
  wymagany), a aplikacja `200` — czyli zamknięcie niczego nie psuje. Nic z tego nie chodzi
  przez Apache w normalnej pracy: most sięga do tras wewnętrznych przez `internal_url`,
  walidowany jako wyłącznie pętla zwrotna, a front zdrowia nie woła wcale.
- **Poprawione w obu plikach, które to wystawiają** (`media-transfer.conf.example`
  i `media-next-stage-wamp.conf.example`) oraz w żywej konfiguracji stagingu. Nie było na to
  żadnego testu — `tests/test_apache_examples.py` sprawdza teraz kolejność obu bloków i to,
  czy reguła zamykająca nadal wymienia wszystkie trasy wewnętrzne. Sprawdzone na treści
  sprzed poprawki: zawodzi tam, gdzie powinien.
- **Smoke test przez publiczny adres**, na koncie tymczasowym skasowanym po `username`
  (razem z `auth_attempts`, `user_sessions`, `audit_log`; stan kont przed i po: 3):
  logowanie po HTTPS, wydanie tokenu transferowego i **odtworzenie zakresu bajtów**
  (`206`, 2048 B) — czyli punkt „utwór gra, plik się pobiera" przeszedł na żywo.
  Przekierowanie z `http://` na HTTPS: `301`.
- **`[proxy] trusted` zweryfikowane różnicowo, a nie na słowo**: dwa nieudane logowania
  z **różnymi podrobionymi** `X-Forwarded-For` dały **ten sam** `client_hash`, czyli nagłówek
  od gościa jest ignorowany i limit prób liczy się per prawdziwy adres. Gdyby było odwrotnie,
  każdy mógłby rozcieńczyć własny limit dowolnym nagłówkiem.
- **`.gitignore`**: prawdziwe konfiguracje Apache (`deploy/apache/*.conf`, przy zachowaniu
  śledzenia `*.conf.example`) — działający host niesie nazwę serwera, ścieżki certyfikatu
  i adresy proxy. Do tego `*.log`, `*.pid`, `*.tsbuildinfo` i ślady po narzędziach.
- **`docs/PROMPT-NEXT.md` usunięty** — dublował zasady pracy z `NEXT-SESSION.md`,
  a rozjeżdżał się z nim przy każdym wydaniu. Plik i tak nigdy nie był w repozytorium.

## 17.08.2026 (popołudnie) — przegląd przed wydaniem, **0.2.0**: cztery kształty instalacji

Bez migracji. Kopia plików i SQL: `media-server-20260817-pre-release-audit`.
Przegląd pod jedno pytanie: czy ktoś obcy postawi to na VPS-ie, na domowym serwerze
w LAN-ie, na domowym komputerze z przekierowanym portem i za proxy — **idąc wyłącznie
za instrukcjami z repozytorium**. Cztery rzeczy odpowiadały „nie".

- **Service worker był martwy od przeprowadzki pod `/`.** `sw.js` leży w `public/`,
  więc nie przechodzi przez żaden krok budowania i miał wpisaną na sztywno bazę
  `/media-next/`. Każda reguła w nim jest zakotwiczona w tej wartości, więc po
  przeniesieniu aplikacji pod główny adres worker instalował się, aktywował
  i **ignorował każde żądanie**: `if (!url.pathname.startsWith(BASE)) return;`.
  Nic tego nie zgłaszało — powłoka offline po prostu nie istniała, a przeglądarka
  pokazywała swój własny błąd. Baza bierze się teraz z adresu, spod którego worker
  został podany (`new URL("./", self.location.href)`), więc działa i pod `/`,
  i pod podkatalogiem, i nie ma czego trzymać w zgodzie ręcznie. Wersja cache
  podbita do `shell-v2`, żeby stary, źle zapełniony cache został skasowany przy
  aktywacji. Test node ładuje worker w atrapie scope'u i sprawdza obie bazy oraz
  to, czy żądanie spoza aplikacji faktycznie zostaje nietknięte.
- **`[app] base_url` domyślnie wskazywał `/media-next/`, czyli już nie tam, gdzie stoi
  aplikacja.** Front buduje się domyślnie pod `/`, a most budował z tej wartości linki
  aktywacyjne, gościnne i przegląd nowości. Świeża instalacja bez własnego `base_url`
  wysyłała więc gościa pod adres, którego serwer nie obsługuje — a widać to dopiero
  wtedy, gdy ktoś nowy nie może dokończyć rejestracji. Domyślna wartość to teraz `/`.
- **`media-server check` porównuje teraz obie połówki tego ustawienia**: bazę
  wpisaną w zbudowany `index.html` i `[app] base_url` z konfiguracji. Rozjazd to
  ostrzeżenie na `stderr`, nie błąd — tak samo jak brakujący FFmpeg. Bez buildu
  (wydanie z gotowymi zasobami) nie ma czego porównywać i nic się nie wypisuje.
- **Nie było czego skopiować, żeby serwer w ogóle odpowiedział pod adresem.** Oba
  pliki w `deploy/apache/` są **fragmentami**: dają aliasy, nagłówki i trasę transferu,
  ale nie mówią, pod jaką nazwą serwer odpowiada ani gdzie ma `DocumentRoot`.
  `INSTALL-DEBIAN.md` kazał je włączyć przez `a2enconf` i przeładować Apache — i na
  tym kończył, więc pod `https://twoj.host/` stała domyślna strona Debiana, a
  `configtest` mówił „Syntax OK", bo nie miał czego sprawdzić. Doszedł
  `deploy/apache/media-vhost.conf.example`: kompletny host z `ServerName`,
  `DocumentRoot`, certyfikatem, HSTS, przekierowaniem z portu 80 i włączeniem obu
  fragmentów. Sprawdzony `httpd -t` z certyfikatem tymczasowym — „Syntax OK",
  kod wyjścia 0, razem z oboma fragmentami wciągniętymi **wewnątrz** hosta.
- **Certyfikat przed włączeniem hosta, nie po** — Apache ze wskazanym, a nieistniejącym
  `SSLCertificateFile` **nie wstaje**; `configtest` kończy się „does not exist or is empty"
  i kodem 1 (zmierzone). W instrukcji stoi więc `certbot certonly --webroot` przed
  `a2ensite`, dopóki port 80 obsługuje jeszcze domyślny host Debiana.
- **Fragmenty wciąga host, nie `a2enconf`, i to nie jest kwestia gustu**:
  `conf-enabled` czyta się **przed** `sites-enabled`, więc `Define` postawiony
  w hoście byłby dla nich za późno i asercja `IfDefine` wywaliłaby test.
- **Instalator umie wreszcie zapisać to, co i tak trzeba było dopisać ręcznie** —
  `--base-url` i `--proxy-trusted`. Obie sekcje powstają tylko wtedy, gdy o nie
  poproszono, więc instalacja lokalna dostaje plik bez ani jednej linii do
  wyjaśniania. Adresy proxy są sprawdzane na miejscu (`ipaddress`), bo literówka
  w nich nie odzywa się nigdy: nagłówek jest po prostu ignorowany i wszyscy goście
  stają się jednym adresem. Nazwy hostów są odrzucane — most porównuje adresy
  spakowane przez `inet_pton` i nazwy nie dopasowałby nigdy.
- **`INSTALL-DEBIAN.md` krok 7 napisany od nowa** — host wirtualny, wybór wariantu
  dostępu w `media-transfer.conf` (zostawiony `Require local` daje bibliotekę, która
  się wyświetla i niczego nie odtwarza), `a2enmod ssl`, certbot i zdanie o tym, że
  HTTPS nie jest tu ozdobą, bo most odrzuca logowanie po zwykłym HTTP.
- **`INSTALL-WINDOWS.md` dostał rozdział o wystawieniu poza tę maszynę** — reguła
  zapory (Windows domyślnie wpuszcza tylko sieć prywatną), przekierowanie portów,
  DNS dynamiczny, `win-acme` i `DocumentRoot` w `httpd-vhosts.conf`. Przy okazji
  poprawiony smoke test, który po przeprowadzce pod `/` nadal odsyłał do
  `http://127.0.0.1/media-next/`.
- **`PUBLIC-EXPOSURE.md`: czwarty kształt — tylko sieć prywatna, bez TLS.** Dotąd
  dokument znał proxy, wystawienie wprost i localhost, a najczęstsza instalacja
  domowa (telefon w tym samym Wi-Fi, adres `192.168.x.x`) nie miała opisanej drogi
  i kończyła się aplikacją, która ładuje się i odbija każde kliknięcie. Wyjście —
  `[session] require_https = false` — jest opisane razem z ceną: hasło i ciasteczko
  sesji lecą wtedy tekstem po całej sieci lokalnej. Opcja istniała w kodzie od
  południa, ale nie było jej w przykładzie konfiguracji TOML, więc praktycznie
  nie istniała.
- **Instalacja pod podkatalogiem: trzy wartości, nie jedna.** Poza `MEDIA_APP_BASE`
  trzeba przedrostka w regule `AliasMatch` publicznego profilu i w `[app] base_url`;
  trasy mostu i transferu zostają na miejscu, bo front zna je z osobnego `meta`.
  Do tego pułapka zmierzona po drodze: w Git Bashu `MEDIA_APP_BASE=/media-next/`
  zostaje zamienione na ścieżkę Windows i front buduje się dla
  `C:/Program Files/Git/media-next/`, bez jednego słowa ostrzeżenia.
- **Nie było opisane, jak w ogóle wejść do świeżej instalacji.** Nie ma żadnego konta,
  rejestracja jest domyślnie wyłączona (`registration_enabled = '0'`), a konta nie zakłada
  żadne polecenie — więc po całej instalacji pod adresem stoi strona logowania bez drogi
  dalej. Obie instrukcje mają teraz krok „pierwsze konto": otwarcie rejestracji na chwilę,
  rejestracja, `role = 'super_admin'`, zamknięcie z powrotem. Wszystko DML-em, więc kontem
  aplikacji. W długach zapisane, że właściwym rozwiązaniem jest polecenie, a nie instrukcja.
- **Przykład dla WAMP-a przestał opisywać czyjąś jedną instalację** — zniknęła
  z niego nazwa hosta właściciela; został wariant „za reverse proxy" z odesłaniem
  do kompletnego hosta dla instalacji wprost.
- **Numer wydania stał w czterech miejscach i już raz się rozjechał.** `v0.1.1`
  zostało otagowane i wydane z `pyproject.toml` mówiącym `0.1.1`, podczas gdy
  `media_server.__version__`, `FastAPI(version=...)` i `frontend/package.json`
  nadal mówiły `0.1.0` — czyli działająca usługa przez całe to wydanie podawała
  numer sprzed poprawki. Nic tego nie porównywało, bo żaden kod nie czyta dwóch
  z tych miejsc naraz. Teraz `app.py` bierze numer z `__version__` zamiast trzymać
  własny (czwarta kopia była najbardziej niewidoczna ze wszystkich — schemat
  OpenAPI nie jest serwowany), a `tests/test_version.py` porównuje trzy pozostałe.
  Sprawdzone na treści z tagu `v0.1.1`: test zawodzi tam, gdzie powinien.
  Wydanie 0.2.0 jest pierwszym, w którym wszystkie cztery mówią to samo.

## 17.08.2026 (południe) — kod gotowy na świat, a nie tylko na localhost

Bez migracji. Backup ten sam co przy poprzedniej serii.

- **Konto właściciela odblokowane** — nazwa z `tryhackx` na `TryHackX`, nowe hasło (bcrypt,
  liczone `password_hash()` tej samej aplikacji) i skasowane 7 nieudanych prób logowania, które
  trzymały blokadę (limit to 5 na 15 minut). Sprawdzone pełną ścieżką po HTTP: `auth_state` →
  `login` → `auth_state`, a sesja testowa zamknięta po sobie.
- **Za proxy aplikacja w ogóle by nie ruszyła — i to po cichu.** Proxy kończące TLS rozmawia
  z serwerem zwykłym HTTP, więc `$_SERVER['HTTPS']` jest puste mimo że gość jest na HTTPS.
  Wzięte dosłownie daje to dwie złe odpowiedzi naraz: most odrzuca **każde** żądanie jako
  niezabezpieczone, a ciasteczko sesji traci atrybut `Secure` — czyli przeglądarka wysyłałaby
  je potem zwykłym HTTP na ten sam host, gdzie po drodze może je przeczytać ktokolwiek.
- **`X-Forwarded-Proto` liczy się teraz według tej samej reguły co adres klienta**: wyłącznie
  wtedy, gdy przyniósł go host z `[proxy] trusted`. Przy pustej liście — domyślnie, i tak działa
  instalacja wprost — nagłówek nie jest w ogóle czytany, więc nikt nie zadeklaruje, że jego
  zwykłe HTTP jest szyfrowane. `session.require_https` czytane jest też z TOML-a; dotąd było tam
  przybite na `true`, choć format PHP miał to od dawna konfigurowalne.
- **`Require local` na `/media-transfer/` odrzuciłoby każde odtworzenie i pobranie.** Biblioteka
  by się wyświetliła, a nic by nie zagrało — najgorszy rodzaj awarii, bo wygląda jak działająca
  aplikacja. Trasy transferu mają teraz wariant publiczny i jest to wybór świadomy: chroni je
  **podpisany token o krótkim czasie życia**, wydawany po sprawdzeniu sesji. Zdrowie usługi
  i zlecenia zadań są zamykane **osobną regułą**, więc otwarcie transferów nie może ich otworzyć.
- **Dwa `Define` w przykładzie Apache były zakomentowane, a Apache nie uważa tego za błąd.**
  Nierozwinięte `${…}` wchodziło do ścieżek jako zwykły tekst, `configtest` mówił „Syntax OK",
  a każde żądanie kończyło się 404. Teraz `IfDefine` wywala test zdaniem, które mówi, którego
  `Define` brakuje. Zmierzone: bez nich kod wyjścia 1, z nimi 0.
- **`[app] base_url` jako ścieżka względna psuje rejestrację.** Dla przeglądarki jest w porządku,
  ale link aktywacyjny idzie **e-mailem** — w ścieżce względnej nikt nie kliknie, więc nikt nowy
  nie dokończy zakładania konta. Opisane w przykładzie konfiguracji i w nowym dokumencie.
- **`docs/PUBLIC-EXPOSURE.md`** — trzy kształty wystawienia (za proxy, wprost, localhost), co
  każdy wymaga, i co może zdradzić adres serwera. **Domyślnym kształtem repozytorium jest
  instalacja wprost**: ktoś, kto sklonuje projekt i postawi go na swoim VPS-ie z normalnym
  certyfikatem, nie musi robić nic z proxy.
- **Czy adres domowy wycieknie: nie z aplikacji.** Sprawdzone — front używa adresów względnych,
  linki w poczcie biorą się z `base_url`, nic nie buduje URL-a z `HTTP_HOST` ani `SERVER_ADDR`.
  `home.tryhackx.org` wskazuje na VPS, a łącze domowe ma inny adres, więc DNS też nie zdradza.
  Ryzyko leży poza kodem i jest wypisane wprost: proxy musi pośredniczyć (a nie przekierowywać)
  i przekazywać `Host`, inaczej Apache zbuduje przekierowanie z własnej nazwy.
- Testy: **13 nowych** dla `TrustedProxy` (osiem na adres klienta, pięć na rozpoznanie protokołu:
  własne TLS zawsze, nagłówek bez zaufanego proxy ignorowany, zaufane proxy wierzone w obie
  strony, łańcuch czytany od lewej). Bramka: 8/8, **332 testy**.

## 17.08.2026 (rano) — rok utworu znowu jest rokiem, sesja przestała być cudza

Migracja **039** (rok w zapisanych tagach). Backup ten sam co przy poprzedniej serii.

- **Karta pokazywała `2017-11-03` zamiast `2017`.** Zgłoszenie właściciela. Tagi Vorbis — czyli
  większość tej biblioteki we FLAC-u — niosą pełną datę wydania pod `date`, a czytnik zapisywał
  to, co znalazł, dosłownie. Pole nazywa się `year`, stoi na karcie obok gatunku i formatu, i tak
  jest odpytywane; data w nim to była obietnica, której nie dotrzymywało.
- **To nie był margines.** Zmierzone przed poprawką: **6390** utworów z pełnym `RRRR-MM-DD`,
  71 z `RRRR-MM`, 2 ze znacznikiem czasu — przeciw 2260, które miały już sam rok. Zepsuta była
  większość biblioteki, tylko rzucało się w oczy dopiero przy jednym albumie.
- **Czytnik zostawia teraz sam rok** (`release_year` w `metadata.py`), a wartość, która nie
  zaczyna się od sensownego rocznika, zostaje **dokładnie taka, jak ją zapisał tagger** — nie
  wiadomo, co znaczy, a zgadywanie skasowałoby jedyny jej ślad. Przy okazji zniknął duplikat:
  worker metadanych miał własną, identyczną regułę wycinania roku i teraz woła tę jedną.
- **Migracja zamiast ponownego czytania plików.** Poprawka czytnika naprawia pliki czytane od
  teraz; wiersze już zapisane naprawia **039** jednym `UPDATE` po `JSON_SET`. Ponowne otwarcie
  12 800 plików, których tagi się nie zmieniły, kosztowałoby półtorej godziny po to, żeby
  odtworzyć ciąg znaków, który da się poprawić dokładnie. Po migracji: **wszystkie 8723** utwory
  mają czteroznakowy rok, biblioteka mieści się w 1904–2024, a utwór ze zgłoszenia pokazuje `2017`.
- **Rozcięcie mostu sesji legacy** (punkt M7). Ciasteczko nazywało się `PHPSESSID` i było
  współdzielone z portalem, który mieszkał w tym samym `DocumentRoot`: jedno ciasteczko, dwie
  aplikacje, a to, która pierwsza wystartuje sesję, decydowało o tym, co widzi druga. Portalu już
  nie ma, więc współdzielenie nie miało czego bronić — a własna nazwa oznacza, że sesji stąd nie
  da się podać ani przejąć niczemu innemu, co akurat działa na tym hoście.
- **Nazwa jest konfigurowalna i sprawdzana.** `[session] name`, domyślnie `TRYHACKXSESSID`, same
  litery i cyfry — PHP wstawia to wprost do nagłówka `Set-Cookie`, a nazwa, której nie przyjmie,
  kończy się ostrzeżeniem przy `session_name()`, którego nikt nie zauważy. Walidacja i wartość
  domyślna są w jednym miejscu, wspólnym dla obu formatów konfiguracji (TOML i tablica PHP).
- **Koszt policzony, nie oszacowany**: `user_sessions` miała **jeden** wiersz, więc zmiana
  wylogowała jedną przeglądarkę. Sprawdzone na żywo — most oddaje teraz
  `Set-Cookie: TRYHACKXSESSID=…; HttpOnly; SameSite=Strict`.
- **Za proxy wszyscy goście byliby jednym adresem.** Throttling logowania i CAPTCHA liczą po
  adresie, a `REMOTE_ADDR` za reverse proxy jest adresem proxy — obie ochrony przestałyby kogokolwiek
  odróżniać. Lekarstwem nie jest zaufanie nagłówkowi `X-Forwarded-For`, bo pisze go klient i może
  w nim napisać cokolwiek. `TrustedProxy` czyta go **wyłącznie** wtedy, gdy przyniósł go host
  wypisany w `[proxy] trusted`, a potem idzie łańcuchem **od prawej**, pomijając kolejne własne
  przeskoki, aż do pierwszego adresu, za którym nikt nie ręczy — i to jest gość. Przeskok, którego
  nie da się odczytać, kończy wędrówkę: wszystko na lewo od niego mogło zostać zmyślone.
- **Domyślnie bezczynne.** Bez wpisu w `[proxy] trusted` nagłówek nie jest w ogóle czytany, więc
  ta zmiana nie otwiera niczego przed cutoverem — jest przygotowaniem, nie przełączeniem. Zaufanie
  to dokładne adresy, nie zakresy: przed domowym serwerem stoi jedno proxy, a arytmetyka masek
  w obu rodzinach IP to dużo okazji do subtelnej pomyłki dla listy, która nigdy nie urośnie.
- **Roadmapa przycięta do stanu faktycznego**, bo kilka długów było już spłaconych: Apache
  **podniósł** nową konfigurację aliasu (sprawdzone — `sw.js` oddaje `Cache-Control: no-cache`),
  kolejka metadanych jest **pusta**, a gatunki filmów **zrobione** (1645 dopasowanych, 138 w
  przeglądzie — to praca człowieka). Zaktualizowane liczby tam, gdzie się rozjechały: nieudanych
  zadań metadanych jest 10, nie 5; odcisków brakuje 7706 z 20 323. Nowa świadoma decyzja: rok
  to rok, pełna data z tagu nie jest przechowywana i nie jest to przeoczenie.
- **Błąd złapany przez własny test**: loader konfiguracji zaczął wołać klasę, której sam nie
  ładował — most działał, bo dołącza wszystko, ale `digest.php` z Harmonogramu wywaliłby się na
  starcie. `require_once` siedzi teraz przy klasie, która go potrzebuje, a nie w punktach wejścia.
- Testy: **17 nowych** — sześć na zapisywanie roku z każdego kształtu tagu, jaki ta biblioteka
  naprawdę zawiera (plus dwa, w których tag nie jest datą i zostaje nietknięty), jeden na brak
  tagu, osiem na wyznaczanie adresu klienta (brak proxy, obcy peer, własne przeskoki pomijane od
  prawej, nieczytelny przeskok ucinający zaufanie, IPv6 porównywane wartością a nie zapisem,
  nawiasy od proxy) oraz zaktualizowane oczekiwania mostu co do nazwy ciasteczka w obu formatach
  konfiguracji. Bramka: 8/8, **327 testów**.

## 17.08.2026 (nad ranem, później) — czysta instalacja na Windows, **koniec M6**, wydanie 0.1.0 i 0.1.1

Bez migracji. Backup przed serią: `C:\wamp64\backups\media-server-20260817-pre-clean-install`
oraz `…-pre-clean-install.sql`.

Repozytorium zaczęte od nowa: jeden osierocony commit z tagiem **`v0.1.0`**, bez wcześniejszej
historii i bez plików, których dziś nie ma. Zaraz po wypchnięciu CI wskazało błąd kodowania
opisany niżej — poprawka wyszła jako **`v0.1.1`**.

- **Ostatni punkt M6 zamknięty.** Instalacja od zera na Windows, z drzewa zawierającego wyłącznie
  to, co widzi git — czyli **bez** `.venv`, prywatnej konfiguracji, `runtime/`, `node_modules`
  i **bez zbudowanego frontu**. 243 pliki, osobny port (8766), osobna baza, obok działającego
  stagingu, którego test ani razu nie dotknął.
- **Instalator zrobił całą robotę w 45 sekundach**: środowisko z `requirements-dev.lock`
  z weryfikacją hashy na **Pythonie 3.14.6**, `npm ci` i produkcyjny build Vite (16 paczek
  z sumami w nazwach, `sw.js`, `manifest.json`), prywatna konfiguracja z **odciętym dziedziczeniem
  ACL** — dostęp mają tylko administratorzy, SYSTEM i bieżące konto — oraz `media-server check`.
- **38 migracji na świeżej bazie MySQL 8.4** (33 tabele), konto aplikacji łączy się poprawnie,
  usługa wstaje i oddaje `ready` na nowym porcie, a staging na 8765 przez cały czas odpowiadał.
- **Bramka przechodzi w czystym drzewie: 8/8.** Przy okazji przeszła ścieżka, której lokalnie
  nikt nie uruchamia: bez katalogu `.git` skan sekretów idzie **obchodem katalogu** zamiast pytać
  gita — 238 plików, zero znalezisk.
- **`--titles-limit 0` wywracał przebieg dopiero na ostatnim kroku.** Workery mają własne zakresy
  i odrzucają złą wartość, kiedy do nich dojdzie — czyli po skanie i po kolejce metadanych, które
  zdążyły już zrobić swoje. Teraz `maintenance` sprawdza wszystkie pięć limitów **przed** startem
  i mówi, który jest zły; do pomijania kroków jest `--only`, a nie limit zero.
- **Czysty Windows nie ma FFmpeg — a instrukcja w ogóle o nim nie wspominała.** Wymagania
  wymieniały Pythona, Node, PHP, MySQL i Apache. Tymczasem bez FFmpeg instalacja wygląda na
  udaną (`check` przechodzi, usługa odpowiada, front się buduje), a nie ma czym zrobić miniatury,
  odczytać ścieżek wideo, wyrenderować napisów obrazkowych ani puścić trybu zgodnego. Zmierzone:
  `"claimed": 5, "failed": 5`. Dopisane do wymagań razem z tym, co dokładnie przestaje działać —
  **i przestało być tylko notatką w dokumencie**: `media-server check` wypisuje teraz, gdzie
  znalazł oba pliki wykonywalne, a gdy któregoś nie ma, mówi wprost, co przez to nie zadziała.
  Ostrzeżenie, nie błąd: instalacja wyłącznie katalogowa to uprawniony stan.
- **I dopiero to odsłoniło prawdziwy błąd: `ffprobe` nigdy nie był znajdowany w `PATH`.**
  `ffprobe_for()` szukał go **obok** pliku ffmpeg — a `stereo.ffmpeg_path` bywa gołą nazwą
  polecenia, bo tak brzmi domyślna wartość instalatora **i** tak każe konfigurować Debiana
  (`ffmpeg_path = "ffmpeg"`, pakiet systemowy w `PATH`). Sprawdzanie systemu plików rozwiązywało
  wtedy `ffprobe` względem katalogu bieżącego, nie znajdowało nic i **po cichu wyłączało odczyt
  każdej ścieżki wideo** — na najczęstszej konfiguracji, jaka istnieje. Bundlowany build (ten na
  tej maszynie) działał, więc błąd nie miał prawa się tu ujawnić. Teraz goła nazwa idzie do
  `PATH`, a brakujące rodzeństwo obok ścieżki bezwzględnej też ma odwrót do `PATH`.
- **Instalator czyta istniejącą konfigurację, zanim cokolwiek zbuduje.** Dotąd brał ją na słowo,
  a plik skopiowany z `config.example.toml` (`GENERATE_WITH_INSTALLER`, `CHANGE_ME`, ścieżki
  z cudzej maszyny) wywracał się dopiero na `media-server check` — czyli po venv, po `pip`
  i po buildzie frontu. Sprawdzenie jest teraz pierwsze i używa **tego samego** loadera, więc
  reguły nie mogą się rozjechać; gdyby loader kiedyś przestał wystarczać sobie ze standardowej
  biblioteki, walidacja usuwa się z drogi zamiast blokować instalację.
- **Druga instalacja na jednej maszynie potrafi wystartować cudze drzewo.**
  `start-stage-windows.ps1` szuka zadania w Harmonogramie po **stałej nazwie** i jeśli je znajdzie,
  uruchamia **jego** drzewo, nie to, z którego go wywołano. Złapane w trakcie testu; obejście
  (`-TaskName` z własną nazwą) jest teraz w instrukcji.
- **`httpd -t` przechodzi dla czystego drzewa** po zmianie jedynej linii `Define` — dokładnie tak,
  jak obiecuje szablon. Plik testowy powstał **poza** katalogiem `alias\`, żeby nie wszedł w życie
  przy najbliższym przeładowaniu Apache.
- **Procedura zapisana**, żeby dała się powtórzyć: `INSTALL-WINDOWS.md`, sekcja „Test czystej
  instalacji" — sześć kroków, z naciskiem na to, że czyste drzewo to wyłącznie pliki widziane
  przez gita, a nie kopia katalogu roboczego.
- Sprzątnięte: usługa zatrzymana skryptem, baza i konto usunięte, drzewo skasowane. Sprawdzone
  po fakcie: port 8766 wolny, została wyłącznie baza `media_server_stage`, staging oddaje `ready`.
- **CI od pierwszego commita mówiło prawdę, tylko nikt jej nie przeczytał.** Po wypchnięciu
  wydania jeden job był czerwony — „Installer dry run (windows-latest)" — i okazało się, że
  czerwony był **od samego początku repozytorium**. Powód: **instalator wywala się na Windowsie,
  którego strona kodowa nie zna polskich znaków.** Windows daje świeżemu procesowi systemową
  stronę kodową, a `stdout` jest bezlitosny — pierwsze zdanie ze znakiem `ż` kończy się
  `UnicodeEncodeError`, kilka kroków przed zrobieniem czegokolwiek. Na polskim Windowsie (cp1250)
  problem nie istnieje, więc tutaj nie miał prawa się pokazać. Odtworzone jednym poleceniem:
  `PYTHONIOENCODING=cp1252 python scripts/install.py --dry-run …` → kod wyjścia 1.
- **To samo groziło poleceniom `media-server`.** Raporty wychodzą jako JSON z `ensure_ascii=False`,
  więc **jedna polska nazwa pliku w raporcie skanu** wystarczyłaby, żeby zabić polecenie. Różnica
  jest taka, że `stderr` Python sam ratuje (`backslashreplace`), a `stdout` nie — czyli ginie
  dokładnie to, co niesie wynik pracy. Oba wejścia dostały to samo zabezpieczenie, które
  `check.py` miał od dawna: strumienie przestawiane na UTF-8 z `errors="replace"`, **zanim
  cokolwiek zdąży coś wypisać**.
- **Runbook testów zapisany osobno.** `docs/TESTING.md` (dokument roboczy, poza repozytorium,
  jak `NEXT-SESSION.md`): kolejność sprawdzania, komendy dla obu platform, poziomy odniesienia
  i lista pułapek, które już raz zjadły czas — po to, żeby kolejne wydanie nie odkrywało ich
  drugi raz.
- Testy: **12 nowych** — pięć na odrzucanie limitów poza zakresem przed rozpoczęciem pracy,
  trzy na odnajdywanie `ffprobe` (goła nazwa przez `PATH`, brakujące rodzeństwo z odwrotem do
  `PATH`, przenoszenie przyrostka `.exe`), dwa na wczesną walidację konfiguracji w instalatorze
  i dwa na stronę kodową: instalator uruchamiany dokładnie komendą z CI przy wymuszonym cp1252
  oraz sprawdzenie, że polecenia `media-server` przestawiają strumienie, **zanim** cokolwiek
  wypiszą. Bramka: 8/8, **309 testów**.

## 17.08.2026 (nad ranem) — ścieżka debianowa przeszła próbę na prawdziwym Debianie

Bez migracji. Backup ten sam co przy poprzedniej serii. Właściciel udostępnił swój serwer
(Debian 13 trixie, systemd **257**, Python **3.13.5**, PHP **8.5.8**, MariaDB **11.8.6**) —
maszynę z kilkunastoma własnymi usługami, więc wszystko szło w osobnych katalogach, na wolnym
porcie i **zostało po testach usunięte**.

- **To, co miało być formalnością, wyprodukowało dziesięć poprawek.** Cała ścieżka z
  `INSTALL-DEBIAN.md` przeszła od pustego katalogu do działającej usługi: konfiguracja,
  baza, wydanie, jednostka, timery, Apache. Po drodze wyszło, że instrukcja miała trzy błędy,
  a skrypt wydania — osiem usterek i dwie brakujące bramki.
- **Migracje działają na MariaDB, nie tylko na MySQL.** Wszystkie **38** migracji zastosowało się
  czysto na MariaDB 11.8.6, dając 33 tabele. Projekt widział dotąd wyłącznie MySQL 8.4, więc to
  była realna niewiadoma — i jedyny wynik tej serii, który nie wymagał żadnej poprawki.
- **Cały pakiet testów na Pythonie 3.13.5: 301 przechodzi.** W tym **wszystkie testy funkcjonalne
  wydania**, które na Windows są pomijane, bo bez uprawnień administratora nie ma dowiązań.
  Pomijanych na Debianie jest 11 — dwa testy złączeń NTFS i dziewięć parsujących `.ps1`
  (brak `pwsh`). Każdy test przechodzi więc już na co najmniej jednej platformie, a razem
  pokrywają komplet.
- **Pułapka, która wygląda jak awaria aplikacji, a jest linijką w jednostce.** Usługa wstała,
  `systemctl status` mówił „active (running)", a `/health/ready` uparcie oddawał **503**
  z `{"unavailable_roots":["movies","music"]}` — 20 żądań, 20 błędów. Powód: `ProtectHome=true`.
  Biblioteki leżały w `/home`, a tego katalogu zahartowana jednostka **nie widzi**. Sprawdzone
  wprost: `sudo -u www-data ls` widzi katalog, ten sam `ls` w namespace jednostki dostaje
  „Permission denied". Skrypt wydania zachował się przy tym wzorowo — wykrył, cofnął i powiedział,
  że poprzednie wydanie też nie odpowiada. Teraz mówi o tym i instrukcja, i komentarz w jednostce.
- **`--no-venv` produkowało wydanie bez interpretera.** Kopia drzewa celowo pomija `.venv`, więc
  ta flaga zostawiała katalog, w którym `ExecStart` nie ma czego uruchomić — a operator dowiadywał
  się o tym jako „wydanie nie odpowiada", po pełnym wdrożeniu i cofnięciu. Teraz skrypt sprawdza
  interpreter **przed** dotknięciem `current` i odmawia jednym zdaniem.
- **`--no-service` dawało fałszywą zieloną lampkę.** Nic nie restartowaliśmy, ale smoke test
  i tak leciał — a port trzymał **stary proces**, który odpowiadał natychmiast. Skrypt meldował
  sukces, przesuwał `previous` i przycinał, podczas gdy ruch obsługiwało poprzednie wydanie.
  Przy kolejnych takich przebiegach katalog, z którego naprawdę działa usługa, traciłby ochronę
  i wpadał pod `rm -rf`. Teraz `--no-service` **wyłącza smoke test** (chyba że operator sam
  zrestartował i mówi to wprost przez `--health-url`), a podsumowanie wypisuje polecenie restartu.
- **Sprzątanie mogło skasować cel `--rollback`.** Dwa niezależne błędy. Pierwszy: chronione
  wydania liczyły się **w kolejności obchodzenia**, więc gdy odrzucone wydanie było nowsze niż
  `previous`, zajmowało miejsce zapasowe, zanim licznik doszedł do chronionego — i `--keep 2`
  zostawiało trzy katalogi (zmierzone na serwerze). Drugi: porównanie szło po **całej ścieżce**,
  a `--switch ./releases/X` albo ukośnik na końcu `--prefix` zapisują w dowiązaniu inny zapis tej
  samej ścieżki — wtedy porównanie nie trafiało i chroniony katalog szedł pod `rm -rf`. Teraz
  chronione liczą się z góry, porównanie idzie po nazwie, a `--switch` zapisuje ścieżkę kanoniczną.
- **Nazwa wydania mogła się cofnąć w czasie.** Po usunięciu katalogu bez przyrostka kolejne
  wydanie w tej samej sekundzie **dziedziczyło tę nazwę** — a taka sortuje się jako najstarsza,
  co psuje porządek „od najnowszego", na którym stoi całe sprzątanie. Przyrostek idzie teraz od
  najwyższego istniejącego i jest wyrównany zerami, żeby `-10` nie wypadło przed `-2`.
- **Cztery drobiazgi z tej samej rodziny.** `--keep 08` wywalało się na „value too great for
  base", a `--timeout 060` po cichu znaczyło 48 sekund (`[[ ]]` czyta wiodące zero ósemkowo).
  Brak `curl` przerywał skrypt **po** przełączeniu `current`, omijając powrót — teraz sprawdzany
  jest na wejściu. `--timeout` liczył obroty pętli, nie sekundy, więc przy zawieszonym adresie
  rozciągał się nawet sześciokrotnie; teraz to termin z zegara, a ostatnia próba dostaje tylko
  tyle czasu, ile do niego zostało. `tar` niósł wpis `./` z prawami katalogu źródłowego
  i nadpisywał nim tryb katalogu wydania (zmierzone: źródło 777 → wydanie 777 zamiast 750);
  `--no-overwrite-dir` to zamyka.
- **Katalog w miejscu dowiązania jest teraz nazwany po imieniu.** `mv -Tf` nie podmieni katalogu
  na dowiązanie — zostawiał tylko plik tymczasowy i mylący komunikat. Teraz skrypt mówi wprost,
  co jest nie tak, i nie zostawia po sobie połówek.
- **Instrukcja miała trzy błędy, z czego jeden cichy.** `apache2ctl configtest` stał **przed**
  `a2enconf` — a `apache2.conf` Debiana wciąga wyłącznie `conf-enabled/*.conf` (zweryfikowane
  w pliku, linia 222), więc test mówił „Syntax OK" o konfiguracji, której nie przeczytał.
  Do `apt install` doszły `php-cli`, `php-mbstring`, `php-curl` i `php-xml`: most używa `mb_*`,
  `curl_*` i `simplexml_*` w każdej ścieżce katalogu i logowania, a `php -l` przechodzi bez nich
  — instalacja wyglądałaby na udaną i wywaliłaby się na pierwszym żądaniu. Trzeci: **pierwszy
  skan trzeba zrobić z ręki**, bo bez wpisu w `media_roots` przebieg okresowy pomija wszystkie
  źródła i nigdy sam nie zacznie (zmierzone na świeżej instalacji: 0,06 s, wszystko pominięte).
  Komunikat pominięcia podaje teraz dokładne polecenie.
- **Sprawdzone jeszcze przy okazji.** Konfiguracje Apache przechodzą `apache2 -t` na Debianie 13;
  brak `mod_headers`, `mod_env` i `mod_alias` daje czytelny błąd, ale **brak `mod_proxy_http`
  przechodzi jako „Syntax OK"** i odzywa się dopiero przy pierwszym pobraniu — jest o tym nota.
  Cały most (20 plików) lintuje się na **PHP 8.5.8**, a jego parser TOML czyta prawdziwą
  konfigurację. Spool poczty liczony z wydania trafia przez dowiązanie `logs/` do
  `/var/log/tryhackx-media-server`. Zapis przez dowiązanie `runtime/` działa przy
  `ProtectSystem=strict`, a zapis do katalogu wydania jest odmawiany — jedno i drugie zmierzone
  w namespace jednostki. `history.jsonl` pojawił się w katalogu **stanu** po 38 s i przeżył
  wszystkie przełączenia wydań. Brak FFmpeg nie blokuje instalacji, tylko po cichu wyłącza
  kolejkę metadanych (`"claimed": 5, "failed": 5`) — instrukcja mówi o tym wprost.
  `systemd-analyze security` wskazał brak `UMask`; jednostki mają teraz `UMask=0027`.
- **Po testach maszyna wróciła do stanu sprzed nich.** Usunięte: jednostki i ich dowiązania
  aktywacyjne, znaczniki timerów, baza i konto testowe, `/opt`, `/etc`, `/var/lib`, `/var/log`,
  `/srv` i katalog roboczy. Zweryfikowane: `/opt` z dwoma katalogami właściciela jak przed sesją,
  zero nasłuchów na 8765, wszystkie trzynaście usług właściciela `active`, `http://127.0.0.1/`
  oddaje 200, dysk 42 GB jak na wejściu. Jedyny ślad to wpisy w dzienniku systemd po nieistniejącej
  już usłudze — czyszczenie dziennika dotknęłoby całego systemu, więc zostały.
- Testy: **7 nowych** (odmowa wydania bez interpretera, brak zielonej lampki bez restartu,
  kanoniczny zapis dowiązania przy `--switch` i przeżycie celu rollbacku, katalog w miejscu
  dowiązania, nazwa nieoddawana po przycięciu, odrzucone wydanie nieokradające zapasu,
  `--keep` czytane dziesiętnie w sześciu wariantach). Bramka: 8/8, **297 testów** lokalnie
  i **301 na Debianie**.

## 17.08.2026 (po przeprowadzce, później) — serwer sam pilnuje katalogu

Bez migracji. Backup ten sam co przy poprzedniej serii.

- **Jedno polecenie zamiast trzech przycisków i pamięci operatora.** `media-server maintenance`
  robi cały przebieg: skan każdego skonfigurowanego źródła, porcja kolejki metadanych, porcja
  gatunków filmów. Dotąd nic nie uruchamiało tego cyklicznie — biblioteka zauważała nowy film
  wtedy, gdy ktoś sobie przypomniał i kliknął.
- **Każdy krok jest ograniczony, a błąd jednego nie kasuje pozostałych.** Przebieg bierze porcję,
  nie całą kolejkę, więc nocna robota kończy się w minutach, a następna kontynuuje od tego miejsca.
  Awaria Filmwebu nie ma prawa wstrzymać kolejki odczytu plików, więc każdy krok jest łapany,
  zapisywany w raporcie i przebieg idzie dalej. Kod wyjścia jest niezerowy, gdy cokolwiek zawiodło
  — bo zadanie, które co noc kończy się sukcesem niezależnie od tego, co się stało, nie jest
  monitoringiem.
- **Rodzaj biblioteki nie jest zgadywany.** Skan potrzebuje wiedzieć, czy to muzyka, czy filmy,
  a ta wiedza już jest — w `media_roots`, zapisana przez pierwszy skan. Źródło, którego nikt nigdy
  nie skanował, jest **pomijane z powodem**, a nie odgadywane z nazwy: `archiwum` nie mówi nic
  o tym, co jest w środku, a pierwszy skan to decyzja człowieka.
- **Skan nigdy nie potwierdza masowego zniknięcia** (`allow_mass_missing=False`). Niezamontowany
  dysk wygląda dokładnie tak samo jak biblioteka, którą ktoś opróżnił — a zadanie nocne nie ma jak
  spytać, które z tych dwóch się stało.
- **Debian: dwa timery, nie jeden.** Przebieg okresowy o 4:15, przegląd nowości o 5:10, każdy
  własną jednostką. Druga linia `ExecStart` w tej samej jednostce sprzęgłaby dwie niezależne
  rzeczy: zerwane połączenie z Filmwebem wstrzymywałoby pocztę, a poczta przesłaniałaby błąd skanu.
  Codzienne uruchomienie przeglądu jest bezpieczne, bo tygodniowy odstęp pilnuje on sam, w SQL.
- **`TimeoutStartSec=6h` to nie ostrożność, to warunek działania.** `Type=oneshot` poddaje się
  domyślnie po **90 sekundach**, a sam skan zajmuje tu **112 sekund** przy zupełnie niezmienionej
  bibliotece. Bez tej linii nocny przebieg ginąłby w połowie — co noc, cicho. Do tego `Nice=10`
  i `IOSchedulingClass=idle`: gdyby ktoś oglądał film o czwartej rano, ma to być jego film.
- **Windows: jedno zadanie obok nadzorcy usługi**, dokładnie jak zakładała roadmapa.
  `run-maintenance-windows.ps1` uruchamia obie połowy niezależnie i zapisuje wyjście do
  `logs\maintenance.log` — zadanie w Harmonogramie nie ma dziennika systemd, więc bez tego pliku
  przebieg byłby niewidoczny. Brak `php` w PATH jest **wypisanym pominięciem**, nie awarią: nikt
  nie jest zapisany na przegląd domyślnie. Rejestrację (`-MultipleInstances IgnoreNew`, S4U,
  codziennie 4:15 z rozrzutem) robi właściciel — wymaga UAC.
- **Nakładania się przebiegów pilnuje harmonogram, nie kod.** systemd nie uruchomi drugiej
  instancji jednostki, a zadanie Windows ma `IgnoreNew`. Własna blokada w kodzie byłaby trzecim
  mechanizmem robiącym to, co te dwa już robią — i jedynym, który mógłby zostać po awarii.
- **Pułapka złapana przez własny nowy test: PowerShell 5.1 czyta `.ps1` bez BOM jako ANSI.**
  Polskie komentarze w skrypcie rozpadły się na `â€"` i parser zgłosił „missing terminator" —
  zadanie zarejestrowane z takim plikiem po prostu nigdy by nie zadziałało. Wszystkie skrypty
  w repozytorium są odtąd czysto ASCII, a nowy test parsuje **każdy** `.ps1` (dziewięć plików).
  Przy okazji dwie rzeczy w logu: `Add-Content -Encoding utf8` wbija BOM, a wyjście PHP i Pythona
  trzeba czytać jawnie jako UTF-8 — inaczej „Wysłano" ląduje w logu jako „WysĹ‚ano".
- Sprawdzone na żywo, nie na atrapie: pełny przebieg na tej instalacji to **181 s** — skan
  **7341 filmów** (2 zaktualizowane) i **12 982 utworów** (3 zaktualizowane), **zero braków**,
  po 2000 odcisków dopełnionych w każdym źródle, porcja metadanych, jedno zapytanie do Filmwebu
  (jedno dzieło dopasowane) i przegląd („Wysłano: 0" — nikt nie jest zapisany, tryb spool).
  Kod wyjścia 0, spool poczty pusty przed i po.
- Testy: **10 nowych** dla przebiegu (rodzaj z katalogu, źródło bez rodzaju pomijane a nie
  zgadywane, `mixed` liczy się jako filmowe, awaria jednego kroku nie kasuje reszty, awaria
  jednego źródła nie kasuje drugiego, nieosiągalna baza a mimo to kolejka metadanych, `--only`,
  kod wyjścia przy przebiegu częściowym) i **16 nowych** dla wdrożenia (parsowanie każdego `.ps1`,
  jednostki uruchamiane z `current`, `Persistent=true` w każdym timerze, limit czasu `oneshot`,
  osobna jednostka przeglądu). Bramka: 8/8, 291 testów.

## 17.08.2026 (po przeprowadzce) — Debian jako cel produkcyjny

Bez migracji. Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-debian`
oraz `…-pre-debian.sql`.

- **Wydanie to katalog, a `current` to dowiązanie.** `scripts/release-debian.sh` buduje nową
  wersję **obok** działającej: własny katalog w `releases/`, własne `.venv` z `requirements.lock`
  z weryfikacją hashy, `media-server check`, migracje — i dopiero wtedy `current` przełącza się
  jednym `rename()`, usługa restartuje, a skrypt czeka na `health/ready`. To był ostatni punkt
  listy przed M7.
- **Wydanie, które nie odpowiada, wraca samo.** Gdy po restarcie `health/ready` milczy przez
  `--timeout` (domyślnie 60 s), skrypt przestawia `current` z powrotem na poprzednią wersję,
  restartuje ją i kończy się błędem. Odrzucony katalog zostaje do wglądu. `--rollback` i
  `--switch` robią to samo na życzenie, `--list` pokazuje, co jest zainstalowane i co aktywne.
- **Cache przeżywa aktualizację, bo `runtime/` w wydaniu jest dowiązaniem.** To nie ozdoba:
  `config.PROJECT_ROOT` **rozwiązuje dowiązania**, więc proces uruchomiony przez `current` widzi
  katalog wersji, a nie `current`. Bez tego zabiegu ścieżka `runtime/thumbnails` z konfiguracji
  wskazywałaby wnętrze wersji, którą za tydzień usuwa sprzątanie — każde wydanie zaczynałoby od
  pustego cache miniatur i gubiło historię statystyk. Teraz `runtime/` prowadzi do
  `/var/lib/tryhackx-media-server`, a `logs/` do `/var/log/tryhackx-media-server`.
- **Jednostka systemd mówi to samo.** `StateDirectory` i `LogsDirectory` tworzą oba katalogi
  z właścicielem usługi i **same dokładają je do `ReadWritePaths`** — to jedyny powód, dla którego
  zapis przez dowiązania działa przy `ProtectSystem=strict`. Katalog wydania jest dla usługi
  wyłącznie do odczytu (`chmod -R u=rwX,g=rX,o=`, właściciel `root:www-data`).
- **Sprzątanie nie może odciąć drogi powrotnej.** `--keep` mówi, ile wydań ma zostać na dysku,
  i ma **minimum 2** — bo `current` i `previous` liczą się do tej liczby i nigdy nie idą pod nóż.
  Usuwane są przy tym wyłącznie katalogi o nazwie, którą sam skrypt generuje: cokolwiek obcego
  ktoś odłoży w `releases/`, zostaje z komunikatem.
- **Migracje jak na Windows: osobnym kontem.** Konto aplikacji ma tylko DML, więc `--migrate`
  przyjmuje `--migrate-config` — drugą konfigurację z kontem uprawnionym do DDL. Domyślnie używa
  tej samej, więc nic się nie dzieje po cichu.
- **Trzy dziury w produkcyjnej konfiguracji Apache**, znalezione przy porównaniu z wersją
  stagingową: brak `AliasMatch` dla `/media-next/account/ktoś/` (wejście prosto pod adres profilu
  kończyło się **404**, choć nawigacja wewnątrz aplikacji działała), brak typu MIME dla
  `.webmanifest` i `no-cache` dla `sw.js` (PWA), oraz **brak `timeout=3600` na `ProxyPass`** dla
  `/media-transfer/` — film albo ZIP to jedno długie żądanie, więc bez tego przerywałby się po
  domyślnym `Timeout` Apache, czyli po minucie. Żaden z tych plików nadal nie zmienia globalnych
  limitów PHP ani globalnego `Timeout`.
- **`docs/INSTALL-DEBIAN.md` przepisany** na pełną ścieżkę: pakiety, układ katalogów z
  uzasadnieniem, pierwsza instalacja krok po kroku (konfiguracja `root:www-data 0640`, baza z
  osobnym kontem do migracji, pierwsze wydanie, jednostka, Apache), aktualizacja, rollback i to,
  czego skrypt **nie** robi. Dopisane dwie rzeczy specyficzne dla tej platformy: FFmpeg jest
  pakietem systemowym (`ffmpeg_path = "ffmpeg"`), a `h264_nvenc` przy `PrivateDevices=true` nie
  zadziała i ma zostać `libx264`.
- Testy: **13 nowych** w `tests/test_release_debian.py`. Sześć statycznych pilnuje szwu, którego
  nikt inny nie czyta — jednostka systemd, skrypt i instrukcja muszą wypisywać te same ścieżki,
  a `bash -n` sprawdza oba skrypty powłoki. Siedem funkcjonalnych naprawdę wydaje, przełącza
  i cofa w katalogu tymczasowym (wykluczenia w kopii, zapis przez dowiązanie lądujący w katalogu
  stanu, `previous`, przycinanie, `--rollback` w obie strony, automatyczny powrót po niemym
  `health/ready`, `--list`). **Te siedem nie zostało tu uruchomionych**: wymagają dowiązań
  i narzędzi POSIX, a na tej maszynie nie ma ani WSL, ani kontenerów, a Windows bez uprawnień
  administratora dowiązania nie utworzy — są **pomijane, nie zaliczane**. Uruchamia je CI
  na Ubuntu. Bramka: 8/8, 265 testów.

## 17.08.2026 (po sprzątaniu) — przeprowadzka poza DocumentRoot, przełącznik linków, logo właściciela

Bez migracji.

- **Drzewo aplikacji stoi teraz w `C:\wamp64\media-server`**, czyli poza `DocumentRoot`. To krok,
  który M6 miało w planie od początku: kod, `config/` z hasłem do bazy i `.git` nie leżą już
  w katalogu, który Apache serwuje. Aplikacja działa wyłącznie przez aliasy `/media-next/`
  i `/media-next-api`, więc dla użytkownika nic się nie zmienia.
- **Przeprowadzka kosztowała katalog `.git`.** `Move-Item` na drzewie z otwartym uchwytem
  przerwał w połowie: część plików była już skasowana ze źródła, część skopiowana do celu —
  i w tej „części" znalazł się `.git`. Historia wróciła z GitHuba (`main` = `eb18762`, ten sam
  commit), pliki najwyższego poziomu z kopii zapasowej, a instrukcja instalacji ma teraz wyraźne
  ostrzeżenie: drzewo przenosi się `robocopy /MOVE`, nigdy `Move-Item`.
- **Linki gościnne mają wyłącznik i są domyślnie wyłączone.** Funkcja, która otwiera bibliotekę
  komuś bez konta, nie powinna być włączona dlatego, że ktoś wgrał aktualizację. Przełącznik jest
  w panelu (Biblioteka → „Udostępnianie na zewnątrz"), a wyłączony **unieważnia też linki już
  wydane** — inaczej byłby sugestią, a nie wyłącznikiem. Przy wyłączonej funkcji znika przycisk
  z kart i sekcja „Linki gościnne" z konta.
- **Ikona przycisku psuła układ kart.** Czwarty przycisk w stopce nie mieścił się w karcie
  szerokiej na 295 px, więc `flex-wrap` przenosił ostatni do własnego wiersza i jedna karta
  rosła wyżej od sąsiadek. Stopka karty folderu i playlisty nie zawija się już nigdy: to
  „Odtwórz" ustępuje miejsca (160 → 110 px przy czterech akcjach), a ikony zostają kwadratowe.
  Zmierzone: wszystkie karty 354 px wysokości w obu wariantach.
- **Tooltip zostawał po otwarciu okna.** Kliknięcie przycisku otwiera dialog, dialog robi resztę
  strony `inert`, a element `inert` nigdy nie dostanie `pointerout` — więc dymek wisiał nad
  oknem i po jego zamknięciu. Teraz gaśnie przy naciśnięciu (bo czytelnik już zdecydował),
  a dodatkowo znika sam, gdy jego kotwica stanie się nieosiągalna.
- **Ikona aplikacji to logo właściciela** na ciemnej płytce z interfejsu. Dekodowanie PNG,
  przeskalowanie i złożenie robi ten sam skrypt bez biblioteki graficznej co poprzednio —
  filtry PNG i `zlib` wystarczą, a znak siedzi w środkowych 60%, więc przeżywa maskowanie do koła.
- **`.gitignore` szczelniejszy**: sekrety (`*.pem`, `*.key`, `*credentials*`), zrzuty bazy
  (`*.sql` z wyjątkiem `migrations/`), materiały multimedialne, archiwa, śmieci systemu i edytorów
  oraz **dokumenty robocze** — `docs/GIT.md` (instrukcja wysyłania na gita) i `docs/NEXT-SESSION.md`
  zostały wypisane z repozytorium (`git rm --cached`), ale zostają na dysku.
- Sprawdzone po przeprowadzce: `media-server check` czyta konfigurację z nowej ścieżki, bramka
  8/8, pięć zestawów E2E (140 sprawdzeń), a `httpd -t` przechodzi z nową ścieżką w aliasie.

## 17.08.2026 (po pierwszym commicie) — sprzątanie

Bez migracji. Kod jest w gicie, więc po raz pierwszy można było usuwać bez asekuracji kopiami.

- **Importer legacy usunięty.** Zrobił swoje: jeden przebieg 08.08, 976 dopasowanych ocen i 6500
  odtworzeń przeniesionych ze starego systemu. Zniknął moduł `legacy_import.py`, polecenie
  `import-legacy`, jego testy i `docs/LEGACY-IMPORT.md`. **Dane zostały**: w
  `legacy_import_orphans` czeka 106 ocen i 1362 odtworzenia, których nie dało się przypisać do
  plików — do dopasowania po odciskach, kiedy `content_fingerprint` będzie kompletne. Kasowanie
  ich razem z kodem byłoby wyrzuceniem cudzych ocen przy okazji porządków.
- **`docs/MIGRATION.md` usunięty** — plan etapów M1–M9 z czasów, gdy stary system był jeszcze
  odniesieniem. Dziś to samo mówi `ROADMAP.md` (co otwarte) i `CHANGELOG.md` (co zrobione),
  a dokument opisywał stan sprzed tygodnia jako „w toku".
- **Martwy kod z frontu**: `getImport` i `getPendingImports` (nikt ich nigdy nie wywołał —
  panel importu odpytuje inaczej) oraz `refreshRating`, oznaczone „@deprecated, kept so older
  call sites keep working" w czasach, gdy takie miejsca jeszcze istniały.
- **Roadmapa przepisana.** Miała 134 linie, w których „do zrobienia" leżało pomieszane
  z „zrobione i tak zostanie". Teraz długi techniczne są rozdzielone na trzy kupki, które
  odpowiadają na różne pytania: **czeka na właściciela** (restart Apache, telefon, trzy kolejki
  do domielenia), **do zrobienia, gdy zacznie przeszkadzać**, i **świadome decyzje** — rzeczy,
  które wyglądają jak błędy, a są wyborem, więc następna sesja nie zacznie ich „naprawiać".
- **`NEXT-SESSION.md` przepisany** na to, czym jest naprawdę: zadanie, zasady pracy, mapa kodu
  i lista pułapek. Wyleciały akapity o stanie sprzed dwóch dni i powtórzenia z roadmapy.
- **Kopie zapasowe: jedna zamiast trzydziestu pięciu.** W `C:\wamp64\backups` leżało 1,9 GB
  zrzutów sprzed każdej serii zmian — sens miały, dopóki nie było historii kodu. Została jedna
  świeża para (pliki + `mysqldump` po sprzątaniu, 31 MB), reszta usunięta. Zniknął też
  wewnętrzny `backups/` w repozytorium (111 MB kopii roboczych z sierpnia) i cache'e narzędzi.
- Sprawdzone po sprzątaniu: bramka 8/8 (259 testów), `media-server check` odpowiada, wszystkie
  pięć zestawów E2E przechodzi, a w przeglądarce przeszedłem ścieżkę muzyka → odtwarzanie →
  kolekcje → moje konto bez jednego błędu w konsoli.

## 17.08.2026 (późna noc, później) — aplikacja instalowalna na telefonie

Bez migracji. Backup ten sam co przy poprzedniej serii.

- **PWA** (punkt roadmapy): manifest, ikony i powłoka offline. Telefon może teraz dodać
  bibliotekę do ekranu głównego i otwierać ją jak aplikację — bez paska adresu, z własną ikoną
  i skrótami do Muzyki i Filmów. Obsługa Media Session była już wcześniej, więc na ekranie
  blokady nic się nie zmienia.
- **Ikony narysowane bez biblioteki graficznej.** Projekt nie ma logo ani zależności do
  obrazów, a dokładanie jej dla dwóch plików byłoby dziwnym handlem. Ikona (ciemny zaokrąglony
  kwadrat z zielonym trójkątem) jest wyliczana piksel po pikselu, z czterokrotnym
  nadpróbkowaniem dla gładkich krawędzi, i zapisywana przez `zlib` i `struct`. Znak mieści się
  w środkowych 60%, więc przeżywa maskowanie do koła na Androidzie.
- **Service worker cache'uje wyłącznie powłokę** — strony, skrypty, styl i ikony. Trzy zasady,
  każda niosąca ciężar: **dokumenty najpierw z sieci** (nazwa paczki niesie skrót zawartości,
  więc strona z cache wołałaby pliki, które wdrożenie już skasowało — dokładnie ta awaria, którą
  naprawialiśmy wieczorem, a worker to jedyna rzecz zdolna przywrócić ją na stałe); **zasoby ze
  skrótem w nazwie na zawsze** (bo nazwa jest wersją); **media i API nigdy** — film to gigabajty
  i zakresy bajtowe, a odpowiedź API opisuje moment.
- **`updateViaCache: "none"` zamiast zmiany w Apache.** Serwer podaje każdy `.js` jako
  niezmienny na rok, a nazwa workera się nie zmienia — więc to przeglądarce mówimy wprost, żeby
  jego samego pobierała z pominięciem cache HTTP. Manifest wystawiony jest jako `manifest.json`
  z tego samego powodu: `.webmanifest` nie ma typu MIME w tej konfiguracji, a `nosniff` nie
  pozwala go zgadnąć. Poprawki do konfiguracji Apache (`AddType`, `no-cache` dla `sw.js`) są
  w `deploy/apache/…-wamp.conf.example` i **skopiowane do `C:\wamp64\alias\`** — wejdą w życie
  przy najbliższym restarcie Apache przez właściciela (`httpd -t` przechodzi).
- **Rejestracja jest cicha i późna**: po pierwszym wyrenderowaniu strony, a odmowa przeglądarki
  (brak bezpiecznego kontekstu, tryb prywatny, polityka) nie zmienia niczego — aplikacja działa
  dokładnie tak jak przedtem.
- Sprawdzone: manifest serwowany jako `application/json` i wczytany przez stronę (nazwa,
  `standalone`, trzy ikony wraz z maskowalną, `apple-touch-icon`), plik workera parsuje się
  (`node --check`) i rejestruje swoje trzy zdarzenia pod atrapą zakresu. **Sama aktywacja
  workera nie została potwierdzona**: przeglądarka narzędzi agenta odrzuca *każdą* rejestrację
  („unknown error when fetching the script"), choć skrypt serwuje się jako 200
  `text/javascript`, a Cache API w niej działa — to ograniczenie tej przeglądarki, nie kodu.
  Do sprawdzenia u właściciela: Chrome → DevTools → Application → Service Workers, albo ikona
  „Zainstaluj" na pasku adresu. Bramka: 8/8.

## 17.08.2026 (późna noc) — serwer prowadzi dziennik tego, co robił

Bez migracji. Backup ten sam co przy poprzedniej serii.

- **Statystyki serwera** (punkt roadmapy). `/health/status` zawsze odpowiadał „teraz": ile
  transferów jest otwartych, ile bajtów poszło od startu procesu. To zły czas gramatyczny dla
  większości pytań operatora — „czy w nocy coś leciało", „czy cache przestał rosnąć", „czy dziś
  jest ruchliwiej niż w zeszłą środę" wymagają wczorajszych liczb, a te znikały przy każdym
  restarcie usługi.
- **Jedna linia na minutę do `runtime/stats/history.jsonl`.** Celowo plik, nie tabela: to
  dziennik samej usługi, pisze się nawet wtedy, gdy baza jest nieosiągalna, a tydzień historii
  waży około megabajta. Trzymane 7 dni, przycinane dopiero po przekroczeniu półtorakrotności
  tego zapasu, żeby nie przepisywać pliku przy każdym dopisaniu.
- **Próbki niosą różnice, nie sumy od startu.** Liczniki zerują się razem z procesem, więc
  wykres z nich narysowany miałby urwisko przy każdym restarcie. Sampler odejmuje poprzedni
  odczyt, a gdy widzi, że licznik **cofnął się**, uznaje to za restart i raportuje minutę jako
  zero zamiast jako ujemną wartość albo skok.
- **Cache mierzony rzadko i celowo.** Obejście 17 849 miniatur i 29 228 plików napisów trwa
  sekundy (zmierzone: 833 MB napisów, 359 MB miniatur, 16 MB cache Filmwebu) — robienie tego co
  minutę byłoby najdroższą rzeczą, jaką serwer robi. Pomiar leci co trzydziestą próbkę,
  w wątku poza pętlą zdarzeń, a pomiędzy nimi wartość jest przenoszona dalej.
- **Nowa sekcja „Statystyki" w panelu**: aktywne transfery, transfery w oknie, szczyt
  równoległych, czas działania i błędy 5xx, trzy wykresy (wysłane dane, aktywne transfery,
  żądania) oraz rozmiary cache. Zakres do wyboru: godzina, doba, tydzień. Wykresy są rysowane
  **ręcznie w SVG** — cztery setki punktów i jeden kształt nie są warte biblioteki, a rysowane
  tutaj biorą kolory z motywu zamiast wozić własną paletę. Skala pionowa jest osobna dla
  każdego wykresu i wypisana na nim: wspólna zrobiłaby z cichej serii płaską linię pod ruchliwą.
- **Trasa `/v1/stats` w usłudze**, za tym samym kluczem wewnętrznym co pozostałe zadania,
  i akcja `admin_stats` w moście. Odczyt megabajtowego pliku idzie do wątku, żeby nie blokować
  strumieni.
- Testy: **9 testów jednostkowych** samplera (pierwsza próbka nie raportuje całego tygodnia
  jako minuty, różnice między odczytami, restart jako luka, rzadki pomiar cache, okno historii,
  przetrwanie urwanej linii, przycinanie, nieczytelny katalog, sumowanie okna) w
  `tests/test_stats.py`. Sprawdzone na żywo: po restarcie usługi plik dostał pierwszą próbkę
  z rozmiarami cache, a 6 wymuszonych transferów (35,9 MB) pojawiło się w kolejnych.
  Bramka: 8/8, 264 testy.

## 17.08.2026 (noc) — cztery zgłoszenia, cotygodniowy przegląd i linki gościnne

Migracje **037** (subskrypcje przeglądu) i **038** (linki gościnne). Backup przed serią:
`C:\wamp64\backups\media-server-20260816-pre-fixes` oraz `…-pre-fixes.sql`.

- **Karta otwarta przez wdrożenie przestawała nawigować.** Nazwa każdej paczki niesie skrót jej
  zawartości, więc nowe wydanie zapisuje nowe nazwy i kasuje stare — a karta, która wisiała
  otwarta, dalej prosi o `account-DC_o8-DN.js` i dostaje **404**. Nic w tej karcie tego nie
  naprawi: plik, którego chce, już nie istnieje. Router rozpoznaje teraz nieudany import strony
  i **przechodzi twardo** pod ten sam adres (a `vite:preloadError` łapie wszystkie pozostałe
  leniwe importy — wizualizacje, edytor tagów). Zabezpieczone znacznikiem czasu w
  `sessionStorage`, żeby zepsute wdrożenie nie zamieniło się w pętlę przeładowań. Zmierzone:
  przed poprawką „Nawigacja nie powiodła się", po poprawce karta ląduje na `/collections/`
  z narysowaną stroną.
- **Losowanie kurczyło się do jednego okna.** Tryb losowania żył w dwóch miejscach — w
  odtwarzaczu i w zapamiętanym źródle kolejki — a **tylko strona biblioteki muzycznej trzymała
  je razem**. Przycisk losowania jest w doku, czyli na każdej stronie: naciśnięty gdziekolwiek
  indziej zmieniał tryb, zostawiając źródło z poprzednim, a odbudowa loaderów przy następnym
  przejściu czytała to nieaktualne źródło i podpinała stronicowanie zamiast globalnego loadera.
  Efekt dokładnie taki, jak w zgłoszeniu: „losuje w zakresie 1–151" i nowe zakresy nie
  dochodzą. Teraz odtwarzacz **sam wpisuje tryb i ziarno do źródła**, a powłoka ustawia
  zapasową obsługę zmiany trybu (biblioteka nadal instaluje własną, bogatszą). Zmierzone na
  stronie „Moje konto": tryb w źródle idzie za przyciskiem, a trzy kolejne utwory wylądowały
  w zakresach 9781–9940, 1273–1432 i 11 789–11 948 z 12 807.
- **Pauza filmu wymagała czasem kilku kliknięć.** W trakcie restartu strumienia (przewinięcie,
  otwarcie od zapamiętanej minuty) kliknięcie **tylko zapisywało życzenie** i czekało, aż nowy
  strumień je zastosuje — a stary grał dalej przez te kilka sekund. To, czy film w końcu stanął,
  zależało więc od parzystości kliknięć. Pauza dociera teraz do elementu **zawsze**; wznowienie
  nadal zostawione restartowi, bo `play()` w trakcie `load()` i tak by się przerwało.
- **Lista kolekcji była wąska, bez opisu i bez edycji.** Kolumny miały 22 rem, więc na
  komputerze mieściły się trzy wąskie paski, w których opis nie miał gdzie się zmieścić —
  i nie był pokazywany. Teraz kolumna ma 32 rem (zmierzone: karta 931 px), opis jest na karcie
  (dwie linie), a **edycja nazwy, opisu i widoczności** dzieje się na miejscu, bez wychodzenia
  na „Moje konto".
- **Cotygodniowy przegląd nowości mailem** (punkt roadmapy). „Co nowego w bibliotece": tytuły,
  które pojawiły się od ostatniej wiadomości. Trzy zasady: **nikt nie jest zapisany domyślnie**
  (poczta, która zaczyna przychodzić po aktualizacji, to poczta, którą się filtruje);
  wiadomość **wymienia tylko biblioteki, do których konto ma dostęp** — inaczej uprzejmość
  zamienia się w wyciek; i **nie wynosi ścieżek ani nazw plików**, bo opuszcza serwer.
- **Okno liczy się do `covered_until`, nie do godziny wysyłki.** Gdyby liczyło od wysyłki,
  wszystko zaindeksowane *w trakcie* przebiegu wypadłoby z obu wiadomości i nikt by się o tym
  nie dowiedział. Uruchamianie: przycisk „Wyślij teraz" w panelu albo
  `php integrations/php/stage/digest.php` z Harmonogramu zadań.
- **Linki gościnne** (punkt roadmapy). Jeden folder albo jedna playlista, dla kogoś, kto nie ma
  i nie będzie miał konta. Link **działa jako jego autor**: listing i transfery idą przez ten
  sam gateway, te same prawa do bibliotek i tę samą białą listę rozszerzeń, więc gość nigdy nie
  sięgnie dalej niż autor, a ruch liczy się tam, gdzie powinien. Od siebie link dokłada trzy
  granice: jedno miejsce, data wygaśnięcia i budżet pobrań (**zero = tylko odsłuch**;
  odtwarzanie nigdy nie zużywa budżetu).
- **Token linku nie trafia do bazy — tylko jego skrót.** Dlatego adres pokazywany jest raz,
  przy tworzeniu, i dialog mówi to wprost. Strona gościa to osobne wejście bez powłoki,
  nawigacji, doku i sesji: jedna lista i jeden odtwarzacz. Wycofanie jest kolumną, nie
  usunięciem, żeby „skończył się" i „wyłączyłem go" dały się później odróżnić.
- **Dwie pułapki złapane po drodze.** `{}` w treści POST-a most odrzucał jako „nieprawidłowe
  dane JSON" (PHP dekoduje `{}` i `[]` do tej samej pustej tablicy, a `array_is_list([])` jest
  prawdą) — akcja bez argumentów była nie do wywołania. I **daty porównywane w PHP kontra
  w MySQL**: zegary tych dwóch chodzą tu w różnych strefach, więc link „wygasły minutę temu"
  wyglądał na ważny jeszcze dwie godziny. Porównania wygaśnięcia i tygodniowego odstępu robi
  teraz baza, czyli ten sam zegar, który te znaczniki zapisał.
- **Spool poczty gubił wiadomość.** Nazwa pliku niosła sekundę i adres, więc dwie wiadomości do
  tej samej osoby w tej samej sekundzie nadpisywały się nawzajem. Rzadkie, dopóki jedyną pocztą
  był link aktywacyjny; zwyczajne, gdy przebieg przeglądu można powtórzyć.
- Testy: **27 sprawdzeń E2E przeglądu** (domyślna cisza, zapis, wysyłka do spoolu, treść bez
  filmów dla konta bez dostępu do filmów, powtórny przebieg, wypisanie, odmowy, przebieg z CLI)
  i **26 dla linków gościnnych** (tworzenie, otwarcie **bez ciasteczek**, odsłuch bez zużycia
  budżetu, wyczerpanie limitu, plik spoza udostępnienia, nieznany i niepoprawny token, link
  tylko do odsłuchu, wygaśnięcie, wycofanie, cudza playlista). Sprawdzone w przeglądarce:
  strona gościa z 14 pozycjami gra pierwszy utwór z podpisanego adresu, bez nawigacji i doku.
  Wszystkie starsze zestawy nadal przechodzą (24 + 29 + 30). Bramka: 8/8.

## 17.08.2026 (wieczór) — widać, kto jest zalogowany, i można go wylogować

Migracja **036** (tabela sesji). Backup ten sam co przy ocenach playlist.

- **Nuta na karcie playlisty ginęła pod okładką.** Miniatury są pozycjonowane
  (`position: absolute`), a glif nie był, więc przegrywał kolejność malowania i prześwitywał
  przez obrazek o przezroczystości 74% jako szara plama. Karta playlisty dostała to samo, co
  karta folderu ma od dawna: gradient pod spodem, `z-index` i cień. Zmierzone — glif playlisty
  i glif „Wszystkich utworów" mają teraz identyczne `color`, `z-index`, `filter` i rozmiar.
- **Aktywne sesje w panelu** (punkt 1 roadmapy). Dziennik mówił, kto *był*; nie było jak
  zobaczyć, kto **jest** — a przeglądarka zostawiona zalogowana u kogoś w mieszkaniu zostawała
  zalogowana, bo jedynym lekarstwem była zmiana hasła. Nowa tabela `user_sessions` trzyma jeden
  wiersz na sesję: konto, urządzenie, kiedy się zaczęła i kiedy była ostatnio widziana.
- **Identyfikator sesji nie trafia do bazy — tylko jego skrót** (SHA-256), dokładnie tak jak
  `auth_attempts` robi z adresem klienta. Wiersz mówi „ta sesja istnieje i wolno ją zamknąć",
  a nie daje się zamienić z powrotem na ciasteczko, którym ktoś by się zalogował. Cena jest
  jedna i uczciwa: **nie da się sięgnąć do cudzej przeglądarki i zabić jej natychmiast**.
  Zamknięcie jest flagą, którą most sprawdza przy każdym uwierzytelnionym żądaniu — sesja
  odbija się o nie i ginie przy najbliższym kliknięciu. Panel mówi to wprost, zamiast udawać.
- **Zapis nie kosztuje żądania.** Wiersz odświeża się najwyżej raz na minutę (znacznik czasu
  siedzi w samej sesji), więc panel wie, że sesja żyje, a baza nie dostaje `UPDATE` za każde
  kliknięcie w interfejsie.
- **„Aktywne" znaczy naprawdę aktywne**: listing odcina wiersze starsze niż `gc_maxlifetime`
  PHP-a, czyli dokładnie tyle, ile sam PHP jeszcze przyjąłby. Bez tego panel oferowałby
  wylogowanie przeglądarki zamkniętej w zeszłym tygodniu.
- **Nazwa urządzenia to ta sama, co przy kolejkach** („Windows · Chrome"). Surowy `user agent`
  nie jest zapisywany: identyfikuje przeglądarkę znacznie dokładniej, niż potrzeba, żeby
  powiedzieć „ta, zamknij ją".
- **Dwa miejsca, dwa pytania.** W panelu (Aktywność) administrator widzi sesje **wszystkich
  kont** i zamyka pojedynczą — bez przycisku zbiorczego, bo przy liście z kilku kont
  „wyloguj wszystkie oprócz tej" byłoby pytaniem, czyje. Na „Moim koncie" każdy widzi
  **własne** sesje i ma tam „Wyloguj wszystkie oprócz tej", gdzie ma to jedno znaczenie.
  Bieżąca przeglądarka jest oznaczona i nie ma przy sobie przycisku — od kończenia własnej
  sesji jest „Wyloguj" w menu.
- **Wylogowanie zamyka własny wiersz**, więc panel nie pokazuje przeglądarki, która sama
  wyszła. Wiersze bez aktywności od 30 dni znikają przy okazji, jak wpisy dziennika.
- Testy: **24 sprawdzenia E2E po HTTP** — trzy „przeglądarki" jednego konta i osobny
  administrator: zapis sesji już przy logowaniu, etykiety urządzeń, skrót zamiast
  identyfikatora (32 bajty w bazie), zwykłe konto nie widzi cudzych sesji ani ich nie zamyka,
  administrator zamyka wskazaną, zamknięta odbija się **401**, „wszystkie oprócz tej" oszczędza
  pytającego, wylogowanie zamyka wiersz, walidacja odmawia. Sprawdzone w przeglądarce: karta
  w panelu z trzema sesjami i zamknięcie jednej (wiersz w bazie z `revoked_by`), sekcja na
  „Moim koncie" pokazująca **wyłącznie** sesje tego konta. Bramka: 8/8.

## 17.08.2026 (dzień) — playlistę można ocenić, a kolejkę przejąć z innego urządzenia

Migracje **034** (oceny playlist) i **035** (kolejki odtwarzania). Backup przed serią:
`C:\wamp64\backups\media-server-20260816-pre-playlist-rating` oraz `…-pre-playlist-rating.sql`.

- **Karta playlisty jest teraz zwykłą kartą: odtwórz, udostępnij, pobierz.** Dotąd miała jeden
  przycisk i strzałkę „wejdź do środka" — czyli mniej niż karta folderu obok, choć playlista jest
  tym samym rodzajem rzeczy: zbiorem plików, który można puścić, komuś podać i wziąć ze sobą.
  Zmierzone: **295 × 354 px** i stopka **160 + 42 + 42 px**, co do piksela tyle samo co karta
  folderu. Wejście do środka zostaje na miniaturze — dokładnie tam, gdzie ma je karta folderu.
  W przycisku „Odtwórz" nadal siedzi glif listy, bo to jedyna rzecz odróżniająca tę kartę od
  karty utworu.
- **Playlistę można ocenić — i to ocenia się co innego niż jej utwory.** Kolekcja miała już
  średnią, ale była to średnia *jej utworów*: wrzuć dziesięć pięciogwiazdkowych piosenek, a lista
  ma pięć gwiazdek, choć nikt nie powiedział o niej ani słowa. To pytanie miało już odpowiedź —
  w ocenach samych utworów. Nie dało się natomiast powiedzieć „to jest dobrze złożona lista",
  a złożenie jest jedyną rzeczą, którą playlista naprawdę jest, bo własnych plików nie ma.
  Nowa tabela `user_collection_ratings` trzyma głos pary (osoba, lista); wyczyszczenie oceny
  **kasuje wiersz**, a nie zeruje go. Ocenić może każdy, kto listę widzi — łącznie z autorem,
  bo na domowym serwerze autor zwykle jest jedynym słuchaczem.
- **Gwiazdka przy playliście znaczy wszędzie to samo.** Skoro doszła ocena listy, dawne
  `average_rating` / `rating_count` (średnia utworów) nazywają się teraz `items_avg_rating` /
  `items_rating_count`, a wolne nazwy przejęła ocena samej listy — tak jak u utworu. Przeglądarka
  kolekcji pokazuje obie liczby, każdą podpisaną, a sortowanie „najwyższa średnia ocena" idzie za
  tą, którą widać na karcie.
- **Kolejka odtwarzania jest po stronie serwera** (punkt 1 roadmapy). Dotąd żyła w `localStorage`,
  czyli w jednym profilu jednej przeglądarki: telefon w kuchni nie miał jak zobaczyć, co gra na
  komputerze, a „przekaż odtwarzanie" nie miało czego przekazywać. Zabawne, że pozycja **w utworze**
  była w bazie od dawna (`playback_stats`) — serwer wiedział, w której sekundzie piosenki ktoś jest,
  i nie wiedział, co leci dalej.
- **Zapisywana jest tożsamość kolejki, nie jej zawartość**: folder albo playlista, w jakiej
  kolejności, z jakim ziarnem losowania, jak daleko, który utwór i ile milisekund w nim. Z tego
  każde urządzenie odtwarza tę samą listę — to dokładnie te wartości, których od dawna używa
  przywracanie kolejki po przeładowaniu strony. Kopiowanie kilkuset wierszy przy każdym zapisie
  opisywałoby listę, którą katalog i tak potrafi odtworzyć z pięciu liczb.
- **Przekazanie działa bez gniazda sieciowego.** Urządzenie, które przejmuje kolejkę, zostawia
  w wierszu poprzednika swoją nazwę; poprzednik znajduje ją **przy własnym zapisie**, który
  w trakcie odtwarzania robi co osiem sekund — i pauzuje, pisząc w kolejce „Odtwarzanie przejęte
  przez: …". Odczyt kasuje znacznik, więc jedno przekazanie pauzuje raz. Urządzenie już
  zatrzymane nigdy nie pyta i nie musi.
- **Panel kolejki dostał sekcję „Na innych urządzeniach"** — nazwa urządzenia, co na nim gra
  i jak dawno, oraz „Przejmij". Lista jest pobierana przy otwarciu panelu, nie odpytywana w kółko:
  moment, w którym ktoś chce wiedzieć, co gra w drugim pokoju, to moment otwarcia tego panelu.
- **Przy okazji: playlista w swojej kolejności przestała się kończyć na setnym utworze.** Kolejność
  listy (`collectionSort`) weszła do zapamiętanego źródła, więc odbudowana kolejka ma wreszcie
  o co zapytać o dalszą stronę. Przedtem po przeładowaniu strony kończyła się w ciszy w środku
  listy, którą ktoś ułożył celowo.
- **Czego to nie robi**: nie przenosi kolejki na *świeżą* przeglądarkę samo z siebie (nowa
  przeglądarka to nowe urządzenie — ale kolejkę widzi na liście i przejmuje jednym kliknięciem)
  i nie zmienia nazwy urządzenia (bierze się z `user agent`: „Windows · Chrome").
- Testy: **30 sprawdzeń E2E po HTTP dla ocen playlist** (świeża lista, głos, druga osoba, zmiana
  głosu, czyszczenie, ćwierć gwiazdki, cudza prywatna lista, lista nieistniejąca) i **29 dla
  kolejek** (zapis, widok z drugiego urządzenia, przejęcie, jednorazowość znacznika, odmowy,
  utwór usunięty z katalogu). Oba na koncie tymczasowym, skasowanym po `username` razem z jego
  wierszami w `audit_log` i `auth_attempts`. Sprawdzone w przeglądarce: karta 295 × 354, głos
  4,5 → średnia 4,8 (2) → wyczyszczony → 5,0 (1), przejęcie kolejki z „Salon · Firefox"
  (12 807 utworów, wznowione na 1:03) i pauza po przejęciu przez inne urządzenie.
  Bramka: 8/8.

## 17.08.2026 (rano) — „już pracuję" zgłaszane jako awaria, karta playlisty

Bez migracji. Zgłoszenia właściciela po przetestowaniu poprzedniej serii.

- **Worker gatunków zwracał 500, a nie robił nic złego.** Usługa odpowiada **409** z treścią
  `already_running`, kiedy przebieg już trwa — i to jest najbardziej użyteczna rzecz, jaką może
  powiedzieć. Most PHP traktował jednak wszystko poza 2xx jako awarię, więc „worker już pracuje"
  docierało do panelu jako **`internal_error`**: operatorowi mówiono, że serwer jest zepsuty,
  w chwili gdy robił dokładnie to, o co go poproszono. Sprawdzone w bazie — worker faktycznie
  mielił kolejkę (853 dopasowane, ostatnie sprzed minuty). `bridgeInternalPost` przepuszcza teraz
  409, a wszystkie trzy zlecenia (gatunki, metadane, napisy) odpowiadają **200 z treścią**, gdy
  praca już trwa, i **202**, gdy naprawdę ruszyła. Front miał gotową gałąź „Wyszukiwanie już
  trwa." — dotąd nieosiągalną.
- **Trzy warstwy nie zgadzały się co do wielkości porcji.** Interfejs oferował 5000 („cała
  kolejka"), usługa przyjmuje 1..5000, a most ucinał na 1000 — więc największa porcja odbijała
  się o walidację. Most podniesiony do 5000. Zmierzone po poprawce: 50, 500, 1000 i 5000 dają
  **200** z uczciwą odpowiedzią.
- **Karta playlisty to teraz naprawdę karta muzyczna.** Znaczek z miniatury zniknął, a **glif
  listy trafił tam, gdzie miał być od początku — do przycisku „Odtwórz"**, zamiast trójkąta.
  Przycisk nadal odtwarza; to, że odtwarza *listę*, jest jedyną rzeczą odróżniającą tę kartę od
  sąsiedniej karty utworu. W treści doszedł **krótki opis** playlisty nad liczbą pozycji: opis
  jest tym, co autor chciał o niej powiedzieć, a liczbę każdy sobie policzy. Strzałka w stopce
  prowadzi do środka, więc dwa różne działania mają dwa różne znaki. Zmierzone: 296 × 354 px,
  tyle samo co karta utworu.

## 17.08.2026 (nad ranem) — OCR usunięty, wszystko z tła w jednej sekcji, edycja opisu filmu

Bez migracji. Seria zgłoszeń właściciela po przetestowaniu napisów obrazkowych.

- **OCR i Tesseract usunięte w całości.** Kod, konfiguracja (`tesseract_path`, `ocr_timeout_seconds`),
  trasa, testy i pobrany instalator — nie ma tego nigdzie. Powód nie jest taki, że nie działało:
  **odpowiadało na gorsze pytanie**. Autor płyty przenosi napis na górę kadru, kiedy dół jest
  zajęty — Die Hard robi to pod czołówką — a sam tekst tę decyzję gubi i ląduje z powrotem na
  napisach, od których go odsunięto. Obraz niesie decyzję razem ze słowami.
  Zostało jedno ustawienie: `subtitle_render_timeout_seconds`.
- **Wszystko, co mieli w tle, jest teraz w „Indeksowanie".** Skan katalogu, kolejka odczytu
  plików, gatunki filmów i cache napisów — w kolejności, w jakiej naprawdę biegną. Zakładka
  „Napisy" zniknęła, worker gatunków wyprowadził się z ekranu decyzji (tam zostaje sam przegląd
  niepewnych dopasowań, bo to praca człowieka, nie maszyny).
- **Panele odświeżają się same** co 4 s, dopóki ta sekcja jest otwarta — bez przycisku „Odśwież".
  Panel, który mówi prawdę wyłącznie po naciśnięciu guzika, przez większość czasu kłamie.
  Odpytywanie **staje**, gdy karta jest w tle albo gdy przejdzie się gdzie indziej: zmierzone —
  4 odczyty w 9,5 s przy otwartej sekcji, **zero** po jej opuszczeniu.
- **Gatunki: porcja albo cała kolejka.** Do wyboru 50, 200, 500 albo wszystko. „Wszystko" nie jest
  zalewem: każde dzieło to zapytanie do cudzego serwera, a worker odczekuje ok. 1,2 s między nimi,
  więc tysiąc dzieł to około dwudziestu minut uprzejmego pukania, nie tysiąc żądań naraz.
  Przy dużej porcji panel mówi to wprost, zamiast udawać, że to chwila.
- **Dolna część odtwarzacza była ucinana, a nie przewijana.** `.viewer__body` jest elementem
  siatki, a taki **nie kurczy się poniżej swojej treści** — więc jego `overflow: auto` nigdy się
  nie włączał, treść wyrastała poza panel, a panel ją chował. Notka „Obraz jest przesyłany bez
  ponownego kodowania" była nie tyle schowana, co **nieosiągalna**. Wiersz siatki dostał
  `minmax(0, 1fr)`, body przewija się własnym cienkim suwakiem w kolorach motywu, a rozwinięte
  „Pozostałe szczegóły" mają dodatkowo własny limit wysokości, żeby dwadzieścia ścieżek napisów
  nie zjadło całego przewijania. Zmierzone: treść 1169 px w oknie 781 px, a po przewinięciu notka
  `is-ready` leży **w całości wewnątrz panelu**.
- **Edycja opisu filmu.** Ten sam edytor co dla utworów, z etykietami dobranymi do filmu:
  **Reżyseria** zamiast „Artysta", **Seria lub kolekcja** zamiast „Album". Most przyjmuje teraz
  `audio` i `video` (`assertItem` bierze listę rodzajów), a pola są te same, bo tabela
  `media_metadata_overrides` i tak ich nie rozróżnia. Rip jest nazwany przez tego, kto go zrobił,
  a katalog jest jedynym miejscem, gdzie może stanąć lepsza nazwa — **do pliku nic nie pisze**.
- Sprawdzone w przeglądarce: zakładki bez „Napisów", cztery panele w Indeksowaniu, selektor
  porcji, samoodświeżanie i jego zatrzymanie, edytor filmu z właściwymi etykietami i zapisem
  („Metadane i okładka zostały zapisane"). Wpis testowy w `media_metadata_overrides` usunięty —
  zostały cztery, wszystkie właściciela. Bramka: 8/8, 255 testów.

## 16.08.2026 (noc, nad ranem) — polskie napisy obrazkowe były ucinane

Bez migracji. Zgłoszenie właściciela po teście na *Die Hard (1988)*: angielskie napisy w porządku,
polskie **poucinane**, z załączonym plikiem z cache.

- **Napis był rysowany na płótnie w rozmiarze obrazu, a nie klatki, dla której go narysowano.**
  Napisy z płyty są autorskie wobec pełnej klatki 16:9 (1920×1080). Rip filmu 2.35:1 zachowuje
  z niej tylko środek — 1920×808 — ale napis niesie **oryginalne współrzędne**. FFmpeg, zostawiony
  sam sobie, buduje płótno z tego, co akurat wie w chwili budowania filtra, a dla PGS jest to
  zwykle rozmiar **obrazu**. Linia postawiona na wysokości 900 spadała więc poza dół płótna
  wysokiego na 808 i docierała przecięta w połowie liter.
- **I nie był to nawet stały błąd.** Ta sama ścieżka renderowana od innego miejsca w pliku
  wychodziła wysoka na 1080, bo dekoder zdążył już poznać prawdziwy rozmiar. Zmierzone na
  Die Hardzie: **808 od początku filmu, 1080 od pięćdziesiątej minuty**. Stąd wrażenie, że
  „część napisów jest dobra, a część ucięta" — zależało od tego, gdzie render się zaczął.
- **Płótno jest teraz podawane wprost** (`-canvas_size`), a nie zgadywane: VobSub deklaruje swój
  rozmiar i ten jest brany, PGS nie deklaruje żadnego, więc odtwarzana jest klatka 16:9 dla tej
  szerokości — **nigdy mniejsza niż sam obraz**, żeby zwykły plik 16:9 albo 4:3 został dokładnie
  taki, jaki był. Potem, jak dotąd, płótno jest skalowane „na pokrycie" i przycinane środkiem do
  wymiarów obrazu, więc przeglądarka nadal nie liczy niczego.
- **Skala szkody była większa, niż widać z jednego pliku**: polska ścieżka Die Harda miała po
  poprawce **1400 kwestii zamiast 239**. Większość nie tyle była ucięta, co gubiona w całości —
  napis wypadał poza płótno tak daleko, że zostawała pusta klatka, a pusta klatka to koniec
  kwestii, nie kwestia.
- **Wersja renderu weszła do klucza cache** (`pictures-v2`). Bez tego poprawka nie dotarłaby do
  nikogo, kto ma już zepsuty render na dysku — czyli dokładnie do zgłaszającego. Stare katalogi
  przestają być odnajdywane; ten jeden został skasowany ręcznie.
- **OCR dostał tę samą poprawkę.** Czyta te same obrazki, więc przed zmianą odczytywałby połówki
  liter. To też odpowiedź na pytanie „a może lepiej OCR": **nie naprawiłby tego**, bo błąd był
  wcześniej niż wybór między obrazem a odczytem. (Przy okazji: Tesseract jest normalnym pakietem
  Debiana — `apt install tesseract-ocr tesseract-ocr-pol` — więc obawa o Debiana była
  bezpodstawna. Ale i tak jest niepotrzebny.)
- Testy: **nowy test jednostkowy** na wybór płótna (rip 2.35:1, plik 16:9, plik 4:3, rozmiar
  zadeklarowany przez kontener, kolejność `-canvas_size` przed `-i`) i **nowe sprawdzenie E2E**:
  trzy najbogatsze kwestie każdej ścieżki są pobierane **po HTTP**, a ich dolne 4 wiersze muszą
  być puste. Zweryfikowane, że test naprawdę łapie ten błąd: przy starym zachowaniu odchylenie
  w tych wierszach wynosi **44,4**, przy nowym **0,0**. Razem 41 sprawdzeń E2E i 11 jednostkowych.
  Sprawdzone w prawdziwym odtwarzaczu na polskiej ścieżce: kwestia 001799 („SOS do wszystkich na
  kanale dziewiątym.") kompletna, z ogonkami i zejściami liter. Bramka: 8/8.

## 16.08.2026 (noc, później) — napisy obrazkowe pokazywane jako obraz

Backup ten sam co przy OCR. Bez migracji. **Punkt „napisy zewnętrzne i OCR" zamknięty
w całości** — i to bez Tesseracta, którego instalacja przestała być do czegokolwiek potrzebna.

- **Pomysł właściciela, i był lepszy od mojego.** PGS i VobSub nie zawierają tekstu, tylko
  bitmapę, którą narysował autor. Zamiast ją odczytywać (OCR: wolno, z błędami, z zewnętrzną
  zależnością), można ją **po prostu pokazać** — nałożyć na obraz filmu. Wynik jest dokładny,
  działa od razu i nie da się w nim przekręcić litery.
- **Ta sama droga renderu co przy OCR**, tylko bez ostatniego kroku: FFmpeg wypuszcza jedną
  klatkę na zdarzenie, puste klatki wyznaczają końce kwestii, a wynik zamiast do Tesseracta
  idzie do przeglądarki jako PNG z przezroczystością.
- **Pozycjonowanie robi serwer i wychodzi za darmo.** PGS zwykle niesie płótno w rozmiarze
  obrazu, ale VobSub niesie pełne 1920×1080, choć film bywa skadrowany do 1920×808 —
  rozciągnięcie spłaszczyłoby każdą literę o jedną czwartą. Płótno jest więc skalowane „na
  pokrycie" i przycinane środkiem (`scale=…:force_original_aspect_ratio=increase,crop=…`), raz,
  po stronie serwera. Dzięki temu **obrazek zawsze ma dokładnie wymiary klatki filmu**, a nakładka
  w przeglądarce to dwie reguły CSS (`width/height: 100%`, `object-fit: contain`) — te same, które
  ma element wideo. Zero arytmetyki po stronie klienta. Zmierzone w przeglądarce: prostokąt
  nakładki i prostokąt wideo **identyczne co do piksela** (145, 98, 1310 × 737).
- **Błąd, który złapał własny test: PGS przerysowuje sam siebie.** Format wysyła wyczyszczenie
  i nowy napis **w tej samej chwili**, a tuż przed zdjęciem napisu wysyła go jeszcze raz. Licząc
  klatka po klatce wychodziły kwestie **milisekundowe** i pary **nachodzące na siebie**. Klatki są
  teraz grupowane po sumie kontrolnej obrazu (`showinfo` i tak ją podaje): ciąg klatek z tym samym
  obrazem to jedna kwestia, trwająca aż pojawi się coś innego. Sprawdzone u źródła: w oknie
  240 s film ma **3 różne obrazy** i pipeline daje dokładnie 3 kwestie, każda 2–3 s.
- **Nic nie jest transkodowane.** Mapowany jest wyłącznie strumień napisów: `Stream mapping:
  Stream #0:3 (pgssub) -> format:default`, bez wideo i bez dźwięku. Zmierzone: 22,9 s na plik
  3,15 GB (141 MB/s — prędkość czytania kontenera), rozmiar i czas modyfikacji pliku nietknięte.
  Dok dalej mówi „Obraz jest przesyłany bez ponownego kodowania" przy włączonych napisach.
- **Render idzie w tle, jak przy OCR**: pierwsze wybranie ścieżki dostaje **202** i zdanie
  „przygotowywanie…", a przebieg zbiorczy w panelu robi to z góry dla całej biblioteki (liczone
  osobno: „w tym N ścieżek obrazkowych"). Manifest jest zapisywany **atomowo na końcu**, więc
  czytelnik widzi albo komplet, albo nic. Puste klatki są kasowane po odczytaniu ich czasów.
- **Klient nigdy nie nazywa pliku.** Manifest podaje `start`, `end` i numer klatki; trasa obrazka
  sprawdza numer **wobec manifestu**, a nie wobec wzorca, więc jedyne pliki, jakie da się pobrać,
  to te, które serwer sam przed chwilą wyrenderował.
- **Koszt**: 1245 kwestii i 20 MB obrazków na całą ścieżkę Die Hard (2 h 12 min), render ~25 s.
  Przeglądarka pobiera po jednym PNG na kwestię i przygotowuje trzy do przodu.
- **OCR zostaje w drzewie, ale zeszedł z drogi odtwarzania.** Moduł i testy są na miejscu, trasa
  `/v1/subtitles` nadal potrafi wydać tekst z cache — natomiast przebieg zbiorczy **już go nie
  mieli**, bo produkowałby godzinami tekst, którego gracz nie używa. Wartość OCR-u to napisy,
  które da się przeszukać i powiększyć; jeśli to niepotrzebne, moduł można usunąć jednym cięciem.
- **Zrezygnowałem z przenikania nakładki.** 90 ms opóźnienia na słowie, którego nikt nie prosił,
  a przy okazji podgląd w narzędziach agenta zatrzymuje zegar przejść CSS (`currentTime: 0`),
  więc nie dało się tego zweryfikować. Napis pojawia się wprost.
- Testy: **10 testów jednostkowych** (w tym nowy na przerysowywany napis i na migawki) oraz
  **39 sprawdzeń E2E** na prawdziwych ścieżkach PGS i VobSub z biblioteki — render obu, manifest
  z rozmiarem płótna, brak nachodzenia, brak kwestii krótszych niż 0,2 s, PNG dokładnie w wymiarach
  obrazu, 404 dla klatki spoza manifestu, 422 dla nazwy spoza wzorca i dla ścieżki tekstowej,
  cache i brak niedokończonych katalogów. **Sprawdzone w prawdziwym odtwarzaczu**: 22 próbki
  w trakcie odtwarzania, **zero rozjazdów** między klatką na ekranie a manifestem, wliczając
  przerwy między kwestiami. Bramka: 8/8.

## 16.08.2026 (noc) — OCR napisów obrazkowych

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-ocr` (pliki) oraz
`…-pre-ocr.sql` (baza). Bez migracji. **Druga połowa punktu „napisy zewnętrzne i OCR"** —
kod gotowy i przetestowany; **do uruchomienia brakuje instalacji Tesseracta**, która wymaga
zgody UAC, czyli kliknięcia właściciela (instrukcja w `NEXT-SESSION.md`).

- **Ile to dotyczy**: **402 filmy, 1062 ścieżki obrazkowe** (763 PGS, 299 VobSub), z tego
  **322 polskie**. Policzone z tego, co zapisał już przebieg `ffprobe` — jedno zapytanie,
  zero dotknięć dysku.
- **Jedna droga dla PGS i VobSub, bez pisania parsera formatu.** Pierwszy pomysł — wyciągnąć
  `.sup` i rozebrać go samemu — oznaczał własny dekoder RLE, i drugi dla VobSuba. Okazało się,
  że **FFmpeg wpuszcza napisy obrazkowe do filtrów jako wideo**: przy `-fps_mode passthrough`
  wypuszcza **dokładnie jedną klatkę na zdarzenie**, a nie jedną na klatkę filmu (zmierzone:
  2104 zamiast 145 525 dla tego samego 97-minutowego filmu, 8 s zamiast minut). Pojawienie się
  napisu daje obrazek, zniknięcie — klatkę pustą, i stąd biorą się **końce kwestii**.
- **`format=gray,negate` zamiast sztuczek z kompozycją.** Dekoder rysuje czarne tło tam, gdzie
  nic nie ma, więc odrzucenie kanału alfa daje biały tekst na czarnym, a negacja — czarny tekst
  na białym, czyli dokładnie to, co Tesseract czyta najlepiej. Sprawdzone okiem na wyrenderowanej
  klatce: czysty, ostry napis, bez obwódki i bez tła.
- **Puste klatki rozpoznaje `showinfo`, nie otwieranie plików.** Odchylenie standardowe równe
  zero znaczy „jednolity prostokąt", czyli koniec poprzedniej kwestii — więc końce wszystkich
  kwestii są znane bez ani jednego odczytu obrazka i bez zależności od Pillow.
- **To nie jest transkrypcja i nigdzie nie udaje, że jest.** OCR myli `I` z `l` i `0` z `O`.
  Ścieżka jest opisana jako **„rozpoznane maszynowo (OCR)"** aż do selektora — widz, który wie,
  czemu słowo wygląda dziwnie, dostaje prawdę, a widz, który nie wie, myśli że serwer kłamie.
- **Odczyt biegnie w tle, nigdy w żądaniu.** Jedna ścieżka to minuty. Pierwsze wybranie takich
  napisów dostaje **202** i zdanie „trwa odczyt, wybierz je ponownie później"; robota rusza
  w tle, pilnowana rejestrem `ocr_jobs`, więc dwa kliknięcia nie uruchamiają dwóch przebiegów.
  Wynik ląduje w **tym samym cache WebVTT** co reszta, więc kolejne wejście jest natychmiastowe
  i przewijanie działa tak samo. Przebieg zbiorczy w panelu (Napisy) też je mieli i liczy osobno
  — „w tym N odczytanych z obrazu", bo obrazek kosztuje minuty, a tekst sekundę.
- **Bez Tesseracta nic się nie zmienia.** `tesseract_path` jest opcjonalne dokładnie jak
  `ffmpeg_path`: bez niego ścieżki obrazkowe są nadal wypisane, nadal wyszarzone, a notka pod
  selektorem mówi wprost, że OCR nie jest skonfigurowany. Sprawdzone w przeglądarce na
  „The Nun (2018) 2160p": „Polski · HDMV_PGS_SUBTITLE — format obrazowy, wymagane OCR".
- **Błąd znaleziony przez własny test**: flaga „da się to odczytać" była wpisywana do wyniku
  odczytu kontenera, a ten jest **cache'owany na pliku**. To fakt o instalacji, nie o filmie —
  po zmianie konfiguracji cache oddawałby nieprawdę i nic by tego nie zauważyło. Rozdzielone:
  `image` (fakt o pliku) zostaje w cache, `ocr` (fakt o instalacji) dokłada `describe_ocr()`
  przy odpowiedzi, na kopii, żeby nie zatruć współdzielonego słownika.
- **Instalator Tesseracta wymaga UAC i na tym się zatrzymałem.** Leży w
  `runtime\tesseract-setup.exe`: `tesseract-ocr-w64-setup-5.4.0.20240606.exe` (50 175 248 B, SHA-256
  `c885fff6998e0608ba4bb8ab51436e1c6775c2bafc2559a19b423e18678b60c9`) z
  `digi.bib.uni-mannheim.de` — źródła, na które wskazuje oficjalne wiki Tesseracta. Podpisany
  przez **Universität Mannheim** (GEANT Code Signing CA 4, znacznik czasu Sectigo), ale
  **certyfikat podpisujący wygasł 10.12.2023**, a build jest z 06.2024 — Windows nie uzna go
  więc za ważny. Tożsamość wydawcy się zgadza, ważność nie; decyzja o instalacji należy do
  właściciela i jest opisana w `NEXT-SESSION.md`. Wariant bez podniesienia uprawnień
  (`__COMPAT_LAYER=RunAsInvoker`) kończy się kodem 0 i **zerem plików** — instalator po prostu
  nic nie robi.
- Testy: **9 testów jednostkowych** (budowa obu poleceń, mapowanie języka na model z odwrotem
  do angielskiego, rozpoznanie kodeków obrazkowych, wymóg obu połówek konfiguracji, puste klatki
  jako końce kwestii, ostatnia kwestia bez pustej klatki po sobie, kwestia dłuższa niż limit,
  czyszczenie tekstu bez przepisywania go, składanie WebVTT), **28 sprawdzeń E2E** na
  **prawdziwych ścieżkach PGS i VobSub z biblioteki** (rozpoznanie i oznaczenie, jedna klatka na
  zdarzenie, zgodność liczby plików z liczbą klatek, rosnące czasy, kwestie nienachodzące na
  siebie, pełny przebieg z atrapą rozpoznawania, sprzątanie katalogu roboczego, zachowanie bez
  Tesseracta) i **20 sprawdzeń po HTTP** (202 i jego treść, brak podwójnego przebiegu, odpowiedź
  po odczycie, nagłówek `X-Subtitle-Source: ocr`, zapis do cache, natychmiastowe kolejne
  żądanie, przewinięcie zostawiające dokładnie te kwestie, które jeszcze trwają, oraz odmowa
  `422` przy braku OCR). Rozpoznawanie zastąpione atrapą — reszta drogi jest prawdziwa.
  **Biblioteka tylko czytana**; test HTTP kopiuje prawdziwą ścieżkę VobSub (bitmapa→bitmapa)
  do pliku tymczasowego, bo FFmpeg odmawia zakodowania tekstu na obraz. Bramka: 8/8.

## 16.08.2026 (późny wieczór) — napisy z pliku obok filmu, ścieżki w MP4

Bez migracji. **Pierwsza połowa punktu 1 roadmapy**; OCR napisów obrazkowych zostaje otwarte,
bo wymaga Tesseracta, którego na tej maszynie nie ma — instalacja zależności należy do właściciela.

- **Plik `.srt` leżący obok filmu jest teraz ścieżką napisów jak każda inna.** Dotąd odtwarzacz
  widział wyłącznie to, co siedzi w kontenerze; napisy dograne osobno były niewidoczne, mimo że
  leżały pół metra dalej. Teraz `.srt`, `.ass`, `.ssa` i `.vtt` dopisują się do listy, konwertują
  do WebVTT tą samą drogą co ścieżki wewnętrzne i trafiają do tego samego cache.
- **Szukamy wyłącznie w folderze filmu i wyłącznie po jego nazwie.** `Film (2019).pl.srt`
  i `Film (2019).srt` należą do `Film (2019).mkv` i nic innego nie należy. Folder `Subs/` jest
  świadomie **pominięty**: taki folder często stoi obok całego sezonu, jego pliki bywają
  ponumerowane zamiast nazwane, a dopasowanie ich byłoby zgadywanką. Źle dobrane napisy nie
  wyglądają na błąd — to po prostu nie te słowa, w dobrym czasie, wyglądające jak te właściwe.
- **Przy kilku filmach w jednym folderze plik trafia do tego z najdłuższą pasującą nazwą.**
  `Film 2.pl.srt` zaczyna się od `Film` i bez tej reguły byłby oferowany także dla `Film.mkv` —
  czyli dokładnie ten cichy zły wynik, którego cała reszta tej roboty unika. Dwa kontenery tego
  samego filmu (`Film.mkv` i `Film.avi`) dzielą napisy, bo należą do obu tak samo.
- **`.sub` celowo nie jest obsługiwane.** Bywa tekstowym MicroDVD mniej więcej w połowie
  przypadków, a w drugiej połowie binarną częścią pary VobSub, i rozróżnia się je zaglądając do
  środka. To ta sama zgadywanka co wyżej, więc rozstrzyga ją OCR, nie heurystyka.
- **Kodowanie zgadywane jest raz i jawnie.** Plik napisów nie deklaruje swojego kodowania,
  a polskie wydania są rutynowo w CP1250 — czytane jako UTF-8 wychodzą jako ciąg znaków
  zastępczych w każdym słowie z ogonkiem. UTF-8 sprawdza się sam na tyle dobrze, że plik, który
  się nim dekoduje, praktycznie zawsze nim jest; reszta idzie jako CP1250. Koszt złego strzału
  to kilka przekręconych liter przy nietkniętych czasach i sensie, a koszt odmowy to całe napisy.
- **Ścieżka do pliku nigdy nie opuszcza serwera.** `/v1/stereo-info` wysyła język, format
  i ewentualny dopisek z nazwy (`pl`, `en.forced`) — nigdy nazwy pliku i nigdy ścieżki, tą samą
  regułą co eksport playlist. Klient nazywa ścieżkę **wyłącznie numerem**, a numer serwer sam
  odwzorowuje na plik, więc żadne żądanie nie może wskazać pliku swojego wyboru.
- **Numeracja jest ciągła**: napisy z pliku dostają numery po tych z kontenera, więc jeden
  integer nadal nazywa ścieżkę wszędzie — w selektorze, w żądaniu i w kluczu cache. Klucz cache
  dla pliku obok filmu bierze **jego** rozmiar i czas modyfikacji: edycja `.srt` unieważnia
  konwersję, a remux filmu nie wyrzuca konwersji, która z filmem nie miała nic wspólnego.
- **Nowy plik pojawia się bez restartu** — do klucza cache odczytu kontenera doszedł czas
  modyfikacji **folderu**, bo odpowiedź opisuje teraz także to, co leży obok.
- **Znaleziony przy okazji błąd: MP4 nie miały żadnych ścieżek do wyboru.** FFmpeg wypisuje
  identyfikator strumienia w nawiasach kwadratowych, ale w innym miejscu zależnie od kontenera:
  Matroska pisze `#0:1(pol):`, a MP4 i strumienie transportowe `#0:1[0x2](und):` — czyli
  identyfikator **przed** językiem. Wzorzec akceptował tylko układ Matroski, więc dla MP4 nie
  rozpoznawał ani jednego strumienia: selektory dźwięku i napisów stały puste, a odtwarzanie
  brało to, co FFmpeg wybrał sam. W tej bibliotece to **407 plików** (344 MP4, 28 M2TS, 27 MTS,
  9 TS). Sprawdzone na prawdziwym pliku: przed poprawką zero ścieżek, po poprawce `h264` i ścieżka
  AAC; MKV czyta się dokładnie tak samo jak wcześniej.
- **Przebieg zbiorczy cache napisów obejmuje pliki obok filmu** tak samo jak ścieżki wewnętrzne.
- Zmierzone na bibliotece (odczyt, bez zapisu): 6591 plików wideo, **10 filmów ma napisy obok**
  (cały sezon *The Pacific*, `.srt` bez znacznika języka) — niewiele, ale dotąd żadne z nich nie
  dało się włączyć. Sprawdzone w przeglądarce na E01: selektor pokazuje „Angielski · SUBRIP",
  „Polski · SUBRIP" i „Nieznany język · SRT — z pliku obok filmu", a wybranie trzeciej wczytuje
  **437 kwestii** z poprawnymi polskimi znakami.
- Testy: **5 nowych testów jednostkowych** (dopasowanie po nazwie i kolejność, najdłuższa pasująca
  nazwa przy kilku filmach w folderze, ciągłość numeracji wraz z odwzorowaniem numeru na plik,
  zgadywanie kodowania, oba układy linii `Stream #`) oraz
  **23 sprawdzenia E2E** na tymczasowym katalogu z filmem wygenerowanym na miejscu — lista
  ścieżek, konwersja UTF-8 i CP1250, cache i przesunięcie czasu bez ponownej konwersji,
  unieważnienie po edycji pliku, pojawienie się nowego pliku bez restartu, trzy odmowy dla złych
  numerów. **Katalogi mediów nietknięte**: E2E biegnie na katalogu tymczasowym, a sprawdzenie na
  prawdziwym filmie tylko czyta — czasy modyfikacji plików *The Pacific* nadal z 2022 roku.
  Bramka: 8/8.

## 16.08.2026 (wieczór) — oceny per playlista, karta kolekcji jak zwykła

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-playlist-queue` (pliki) oraz
`…-pre-playlist-queue.sql` (baza). Migracja `033` zastosowana. **Punkty 1 i 2 roadmapy
zamknięte w całości.**

- **Playlista mówi, czyje oceny i ulubione widać w kolejce.** Dotąd odpowiadało na to
  konto — raz, globalnie — i to zostaje domyślną odpowiedzią, bo to *twoja* kolejka. Ale
  playlista jest zdaniem o muzyce, a „te trzy wracają do mnie najczęściej” jest częścią tego
  zdania; pokazywanie słuchaczowi jego własnych gwiazdek nad cudzym wyborem odpowiada na
  pytanie, którego nikt nie zadał. Autor listy wybiera więc osobno **ocenę**
  (`inherit`/`owner`/`viewer`/`average`/`none`) i **ulubione**
  (`inherit`/`owner`/`viewer`/`none`), a każdy, kto listę odtwarza, widzi to, co wybrał autor.
- **`owner` i `viewer` zamiast jednego „własne”.** „Własne” nazywa inną osobę zależnie od
  tego, kto czyta, a obie potrzeby są prawdziwe: autor chce pokazać swoje gwiazdki, a słuchacz
  przeglądający cudzą listę wciąż może chcieć swoich. Dwie wartości rozstrzygają to bez
  domysłu, a **obie połówki ustawia się niezależnie** — ulubione autora obok oceny słuchacza
  są poprawną konfiguracją.
- **Domyślnie `inherit` i to nie jest szczegół.** Cokolwiek innego po cichu przemalowałoby
  każdą istniejącą playlistę, a przy okazji **opublikowało oceny jej autora** wszystkim, którzy
  ją odtwarzają. Oddanie własnych ocen musi być decyzją, którą ktoś podjął, nie skutkiem
  uruchomienia migracji. Edytor listy mówi to wprost: przy wyborze `owner` pod selektorami
  pojawia się zdanie „Każdy, kto odtworzy tę listę, zobaczy Twoje oceny i ulubione”.
- **Ocena autora jest dokładana, nie podmieniana.** Drugie złączenie `user_ratings` (`uro`)
  celuje w właściciela listy, obok istniejącego `ur` dla czytającego — bo jedno i drugie bywa
  potrzebne naraz: kolejka pokazuje opinię autora, a ocenianie z docka dalej zapisuje **twój**
  wiersz. Złączenie dokłada się **tylko wtedy, gdy lista o nie prosi**, a `owner_rating` jest
  wtedy **nieobecne**, a nie `null` — inaczej „autor tego nie ocenił” i „nikt nie pytał o autora”
  wyglądałyby tak samo.
- **To nie jest reguła listy inteligentnej.** Reguła mówi, *które pozycje* są na liście; te dwa
  pola mówią, *jak lista jest rysowana* — więc siedzą we własnych kolumnach `user_collections`,
  poza `rules_json`, i działają tak samo na liście ręcznej.
- **Ustawienie jedzie razem z kolejką, nie ze stroną.** Kolejka przeżywa nawigację, a strona
  playlisty nie, więc reguły wyświetlania są zapisane w `QueueSource` (czyli i w `localStorage`)
  obok źródła i ziarna losowania. Sprawdzone: po przejściu na stronę startową dok dalej pokazuje
  ocenę autora; po zagraniu zwykłego folderu wraca do „Twoja ocena”.
- **Karta kolekcji jest zwykłą kartą muzyczną.** Była budowana jak folder — ciemny gradient,
  wielki glif, szeroki przycisk „Otwórz playlistę” tam, gdzie karta utworu ma „Odtwórz”. To
  mówiło „tu się wchodzi”, a playlista nie jest miejscem: jest czyimś wyborem, i zwykle chce się
  go **usłyszeć**. Karta ma więc kształt karty utworu (zmierzone: 295 × 354 px, przycisk
  269 × 42 px, stopka 269 × 58 px — co do piksela jak sąsiadująca karta utworu) i **znaczek
  kolekcji** na miniaturze (32 × 32 px, 12 px od górnego prawego rogu), żeby dało się ją poznać
  jednym spojrzeniem.
- **„Odtwórz” odtwarza, a nie wchodzi.** Dotąd przycisk ustawiał `pendingCollectionPlay` i wołał
  `enterCollection()` — czyli wchodził do listy po drodze, co jest w porządku pierwszy raz
  i przeszkadza za każdym kolejnym. Teraz „zbuduj kolejkę i graj” jest osobną funkcją
  (`playCollectionQueue`), która bierze wszystko argumentem zamiast czytać stan strony, bo
  kolejkę trzeba umieć zbudować dla listy, której nikt nie otworzył. **Wejście to miniatura**,
  tak jak na każdej innej karcie, plus znaczek w stopce jako druga droga. Sprawdzone
  w przeglądarce: po „Odtwórz” adres, okruszki i siatka są nietknięte, a kolejka gra playlistę.
- **Źródło kolejki zapisuje się także wtedy, gdy playlista nie została otwarta** — bez tego
  `restoreQueueLoaders()` nie odbudowałby loaderów po przeładowaniu i losowanie znów zawęziłoby
  się do jednego okna. Doszło też zapamiętanie, **która** playlista gra: zmiana trybu losowania
  przebudowuje ją, a nie folder, który akurat widać na ekranie.
- Przy okazji: **`RESOLUTION_LABELS` było stałą modułową**, czyli `t()` rozwiązywało trzy
  etykiety filtra obrazu przy ładowaniu paczki — zanim powłoka przyjęła język konta. Dokładnie
  ten sam kształt błędu co tabele zdarzeń dziennika naprawione wcześniej; zamienione na funkcję
  i dopisane do słownika razem z „Tworzenie playlisty…” i „Wybrano: ”. Skrypt porównujący każde
  wywołanie `t()` ze słownikiem zostawia teraz dwa wyniki: „HDR” (czyta się tak samo w obu
  językach) i celowo nieprzetłumaczone zdanie z testu `i18n`.
- E2E na kontach tymczasowych: **40 sprawdzeń** przez klasy mostu (domyślne `inherit`, ocena
  autora obok oceny słuchacza, brak oceny autora jako `null`, ulubione osobno od oceny, zanik
  kolumn autora przy `average`/`none`, sortowanie po ocenie **czytającego** mimo pokazywania
  oceny autora, cztery odmowy dla złych wartości, odmowa dla cudzej playlisty, ustawienie podane
  przy tworzeniu) i **13 sprawdzeń po HTTP** (CSRF wymagany na zapisie, `422` dla wartości spoza
  listy, pola wracające w `collection` i w liście playlist). Konta kasowane po `username`,
  a stan bazy porównany z zrzutem sprzed zmian: `user_ratings` 1000, `user_collections` 1,
  `users` 3, `playback_stats` 6992 — bez różnicy. Doszły **2 testy jednostkowe**
  `resolveQueueDisplay`. Bramka: 8/8.

## 16.08.2026 (popołudnie) — losowanie w playliście, rok per odcinek, wygląd

Bez migracji. Zgłoszenia właściciela z drugiego przejrzenia panelu.

- **Losowanie zawężało się do jednego okna — ta sama przyczyna co zacinające się menu.**
  Kolejka przeżywa nawigację, bo powłoka jest trwała; jej **loadery nie**, bo to funkcje,
  a funkcja nie przeżywa `localStorage`. Kod, który je odbudowywał, siedział wewnątrz strony
  biblioteki muzycznej, za `if (options.kind === "music")` — czyli na jednej stronie z sześciu.
  Przeładowanie na Kolekcjach, na Filmach albo zwykłe przejście gdzie indziej i loaderów nie
  przywracał już nikt: `globalQueueLoader` zostawał pusty, więc losowanie po cichu spadało do
  `nextTrackIndex` **w obrębie załadowanego okna** — stąd zakres 328–487, dokładnie 160 pozycji.
  Odbudowa loaderów przeniesiona do powłoki (`shared/queue-loaders.ts`) i biegnie **przy każdym
  montowaniu, na każdej stronie**. To ten sam kształt błędu co poprzednio z nawigacją: coś
  długo żyjącego zależało od czegoś krótko żyjącego. Dotyczyło **i playlist, i zwykłych list**.
- **Rok osobno dla każdego odcinka przy grupowaniu folderami.** Gatunek półki jest wspólny —
  każdy odcinek Smerfów to animacja — ale rok nie, bo taki cykl rozciąga się na dekady.
  Karta folderu rozwija listę pozycji, każda z własnym polem roku; rok wpisany przy odcinku
  **wygrywa** z rokiem folderu, bo został wpisany później i o czymś węższym.
- **Karty przeglądu miały tekst przyklejony do własnego obramowania.** `.panel` daje ramkę
  i tło, ale **nie daje wypełnienia** — sąsiednie panele biorą je z `.account-panel` /
  `.admin-section`, a te dwie nowe klasy z niczego. Dodane.
- **Wybór pliku w imporcie to teraz strefa upuszczania**, ta sama co przy okładkach: ukryte
  natywne pole pod ostylowanym kafelkiem, z obsługą przeciągnięcia i nazwą wybranego pliku.
  Natywne `<input type="file">` jest jedyną kontrolką, którą rysuje przeglądarka, i przychodzi
  z szarym systemowym przyciskiem, który nie należy do żadnego motywu.
- E2E: **24 sprawdzenia** dla grupowania (w tym rok per odcinek: pierwszy 1977, drugi 1985,
  reszta 1960 z folderu, wspólny gatunek wszędzie). Test biegnie po prawdziwym katalogu, więc
  wszystko, czego dotyka, jest zrzucane i przywracane co do wiersza. Bramka: 8/8.

## 16.08.2026 (południe) — grupowanie folderami w kolejce gatunków

Bez migracji. Zgłoszenie właściciela po pierwszym przejrzeniu kolejki.

- **Grupowanie po folderze — 926 decyzji zamiast trzech.** Antologia kreskówek to w tej
  bibliotece **515 osobnych dzieł**, serial o Smerfach **303**, Tom i Jerry **108** — i za
  każdym razem jest to ta sama odpowiedź. Przeklikanie tego pojedynczo nie jest przeglądem,
  tylko wpisywaniem danych. Ta sama kolejka czyta się teraz **folderami**: gatunek i rok
  ustawione na folderze lądują na wszystkim, co w nim czeka. Grupujemy po **najwyższym**
  folderze, bo to poziom, w którym myśli człowiek („cała ta półka to Smerfy”), a karta pokazuje
  kilka prawdziwych tytułów ze środka, żeby wybór był robiony wobec czegoś konkretnego,
  a nie wobec liczby.
- **Zamiatanie nie nadpisuje decyzji ręcznych** (`source = 'manual'`) i rusza wyłącznie to,
  co ma wybrany status. Odmawia, gdy nie podano ani gatunku, ani roku — i gdy w folderze nie
  ma nic do ustawienia.
- **Widać, skąd pochodzi pozycja.** Dotąd karta pokazywała samą nazwę pliku
  („289 - Podniebna niespodzianka.avi”), czego nie da się znaleźć na dysku. Teraz jest cała
  ścieżka, zapisana ze spacjami wokół strzałek — `Smerfy › 289 - Podniebna niespodzianka.avi`
  — bo ścieżka bez odstępów to jedno długie słowo, po którym oko się ślizga. Zawija się,
  zamiast być ucinana wielokropkiem: ucięta połowa to zawsze ta potrzebna.
- **Karty przeglądu przestały być stosem akapitów o tej samej wadze.** Tytuł prowadzi, ścieżka
  pod nim jest cicha, „dlaczego niepewne” czyta się jako uwaga na marginesie (lewa kreska,
  mniejszy stopień), a kandydaci siedzą we własnym, ciemniejszym panelu. Wiersz w widoku
  folderów jest wyrównany **do dołu**, bo lista gatunków jest wysoka, a rok i przycisk nie.
  Zmierzone: 1400 px → trzy kolumny (975 / 160 / 197 px) wyrównane do jednej linii bazowej;
  375 px → jedna kolumna, zero przewijania w bok. Pole roku zwężone do 160 px — szerokie
  pudełko na cztery cyfry sugeruje, że oczekuje się czegoś więcej.
- E2E: **18 sprawdzeń** (odczyt kolejki jako folderów, próbki tytułów, pełna ścieżka w widoku
  pojedynczym, zamiecenie folderu Smerfy — 111 dzieł / 114 plików jednym kliknięciem, gatunek
  i rok na każdym pliku, zamknięcie kolejki, cztery odmowy i granica administratora).
  **Test wykonano na prawdziwym katalogu**, więc wszystko, czego mógł dotknąć, zostało wcześniej
  zrzucone i przywrócone co do wiersza — sprawdzone: 4101 wpisów gatunków przed i po,
  1796 wierszy kolejki przed i po, decyzje ręczne właściciela nietknięte. Bramka: 8/8.

## 16.08.2026 (przedpołudnie) — import playlist i ocen, punkt zamknięty

Migracja `032` zastosowana. **Punkt 1 roadmapy (import/eksport) zamknięty w całości.**

- **Nic z wgranego pliku nie trafia do katalogu samo z siebie.** Upload ląduje w poczekalni
  (`playlist_imports`), zostaje dopasowany na tyle, na ile się da, a to, czego nie da się
  rozstrzygnąć, czeka z kandydatami. Zła zgadywanka byłaby **cicha**: playlista po prostu
  trzymałaby nie to nagranie, i nic na ekranie by tego nie powiedziało.
- **Trzy drogi dopasowania, w kolejności tego, ile dowodzą**: **odcisk pliku** (działa między
  instalacjami i tylko on działa), **nasz identyfikator** (sprawdzany w katalogu, nie brany na
  słowo — liczba w cudzym pliku to liczba, którą ktoś wpisał), i **nazwa pliku** (jedno
  trafienie to dopasowanie, kilka to pytanie, zero to brak).
- **Ekran potwierdzania w „Moje konto"** — dla każdej niepewnej pozycji: co mówił plik, jacy
  są kandydaci (tytuł, wykonawca, **folder, nie cała ścieżka**) i przycisk „Pomiń tę pozycję".
  Serwer przyjmuje **wyłącznie jednego z kandydatów, których sam zaproponował** — inaczej
  wgrany plik mógłby wskazać pozycję, której nigdy nie nazwał.
- **Import ocen zapisuje wyłącznie na konto importujące.** Zapis na cudze konto byłby sposobem
  na mówienie w czyimś imieniu i nie jest ustawieniem, które można włączyć.
- **Cztery formaty rozpoznawane po zawartości**, nie po rozszerzeniu, bo nazwę pliku ustawia
  ten, kto go wgrywa. Z cudzej ścieżki zostaje **wyłącznie nazwa pliku**.
- **XSPF czytany jako XML z wyłączonym podstawianiem encji** — test wgrywa encję zewnętrzną
  celującą w plik systemowy i sprawdza, że nic nie wycieka. Limity: 2 MB i 5000 pozycji,
  a przekroczenie jest **zgłaszane**, nie ucinane po cichu.
- **Znaleziony problem zgodności**: `php` w PATH to **8.4.15** (bramka lintuje właśnie nim),
  a PHP 8.4 deprecjonuje domyślny `$escape` w `fgetcsv()`; notka trafiała na wyjście i psuła
  odpowiedź JSON. Argumenty podane wprost, `$escape = ''` zgodnie ze standardem CSV.
- **Katalogi mediów są tylko do odczytu** — dopisane do `ARCHITECTURE.md` jako wprost
  wypowiedziany warunek. Zweryfikowane na 400 plikach, które odcisk czytał: rozmiar i `mtime`
  identyczne z tym, co katalog zapisał wcześniej. To warunek, na którym biblioteka może
  jednocześnie zasiewać torrenty.
- **Wygląd panelu importu poprawiony po uwadze właściciela.** Trzy kontrolki, z których każda
  chciała pełnej szerokości, dawały trzy paski jeden pod drugim; teraz to siatka: wybór pliku
  bierze resztę miejsca, selektor biblioteki tyle, ile potrzebuje jego najdłuższe słowo,
  a przycisk stoi w tej samej linii. Natywne pole pliku było jedyną kontrolką, którą rysuje
  przeglądarka — dostało szary systemowy przycisk i czcionkę systemu; `::file-selector-button`
  jest teraz z tych samych tokenów co reszta. Poniżej 46 rem wiersz staje się stosem.
  Zmierzone w przeglądarce: 1280 px → jeden wiersz, wszystkie trzy po 48 px wysokości;
  375 px → jedna kolumna, zero przewijania w bok.
- Przy okazji: trzy miejsca sięgały po nieistniejący token `--color-surface-muted` i żyły
  na wartości zapasowej — podmienione na prawdziwe `--color-surface` / `--color-surface-strong`.
- Testy: **23 sprawdzenia** E2E (round trip M3U i XSPF co do kolejności, oceny CSV i JSON tam
  i z powrotem, **nazwa trzymana trzykrotnie staje się pytaniem z trzema kandydatami**,
  odrzucenie identyfikatora spoza propozycji, cztery granice między kontami, podwójne
  zastosowanie importu), **8 sprawdzeń po HTTP** (CSRF, upload, odczyt, lista, zapis, odmowa
  przy zerowym dopasowaniu) oraz **11 testów parsera** w bramce. Bramka: 8/8.

## 16.08.2026 (rano) — czytanie wgranych playlist i ocen

Migracja `032` zastosowana. Druga połowa punktu 1 roadmapy w budowie — gotowy jest
**schemat poczekalni i parser**; dopasowanie do katalogu i ekran potwierdzania zostają.

- **Katalogi mediów są tylko do odczytu** — dopisane do `ARCHITECTURE.md` jako wprost
  wypowiedziany warunek, nie domysł. Nic w tym systemie nie zapisuje do plików filmowych ani
  muzycznych: edytor tagów pisze do `media_metadata_overrides`, okładki i napisy powstają
  w `runtime/`, a odcisk otwiera plik w trybie `rb`. Zweryfikowane na 400 plikach, które
  odcisk faktycznie czytał: rozmiar i `mtime` identyczne z tym, co katalog zapisał wcześniej.
  To jest warunek, na którym biblioteka może jednocześnie zasiewać torrenty.
- **`PlaylistParser`** — cztery formaty (M3U nasz i cudzy, XSPF, CSV, JSON), rozpoznawane po
  **zawartości**, nie po rozszerzeniu, bo nazwę pliku ustawia ten, kto go wgrywa. Z cudzej
  ścieżki zostaje **wyłącznie nazwa pliku**: reszta wskazuje w cudzą bibliotekę i nie ma po co
  jej przechowywać.
- **XSPF czytany jako XML z wyłączonym podstawianiem encji.** Wgrany plik XML, który serwer
  parsuje, to podręcznikowe miejsce na encję zewnętrzną czytającą plik z dysku — test wgrywa
  taką encję i sprawdza, że nic nie wycieka.
- **Limity podwójne**: 2 MB i 5000 pozycji, a przekroczenie jest **zgłaszane**, nie ucinane po
  cichu — import obcięty bez słowa wygląda jak kompletny.
- **CSV czytany po nazwach kolumn**, nie po pozycji, i z pominięciem BOM-u. Cudzy eksport nie
  ułoży kolumn w naszej kolejności, a czytanie czwartego pola, bo u nas jest tam wykonawca,
  to sposób na zapisanie oceny „Depeche Mode".
- **Znaleziony przy okazji problem zgodności**: `php` w PATH to **8.4.15**, a nie 8.3, którym
  linkowałem ręcznie. PHP 8.4 deprecjonuje domyślny `$escape` w `fgetcsv()`, a notka trafiała
  na wyjście i psuła odpowiedź. Wszystkie argumenty są teraz podane wprost, z `$escape = ''`
  — czyli wartością zgodną ze standardem CSV (backslash w tytule to backslash).
- Testy: **11 przypadków** w `tests/test_php_playlist_parser.py`, uruchamiane przez bramkę
  (wcześniejsza wersja żyła w scratchpadzie i nie liczyła się). Bramka: 8/8.

## 16.08.2026 (nad ranem) — błędny gatunek w panelu, JSON, odcisk pliku

Backup: ten sam co przy eksporcie. Migracja `031` zastosowana.

- **Panel pokazywał zły gatunek — i tylko panel.** Filmweb numeruje gatunki po swojemu
  i ten katalog też, numeracje częściowo się pokrywają, a ekran przeglądu porównywał
  **identyfikatory Filmwebu z identyfikatorami słownika**. Stąd „Pluję na twój grób" (Horror,
  Filmweb 12) czytany jako **Dokumentalny** (nasze 12), a „Dramat" (Filmweb 6) jako
  **Biblijny** (nasze 6). **Zapisane dane były i są poprawne** — worker mapuje przez
  `filmweb_id`, co sprawdzono na dwunastu dopasowanych filmach (Zakonnica → Horror, Hobbit →
  Fantasy/Przygodowy, Adwokat diabła → Thriller). **Ponowne skanowanie nie było potrzebne.**
  Nazwy gatunków rozwiązuje teraz **serwer**, a frontend nie porównuje już żadnego
  identyfikatora — cała klasa błędu zniknęła, także dla 235 wierszy czekających w kolejce.
- **Oceny także jako JSON** obok CSV. JSON trzyma typy, które te dane naprawdę mają (ocena
  jest liczbą, ulubione wartością logiczną), CSV otwiera się w arkuszu — dlatego są oba,
  a nie jeden zamiast drugiego. Plik jest nazwany i wersjonowany (`tryhackx-media-ratings`, `1`),
  więc importer odróżni go od dowolnego innego JSON-a.
- **Odcisk pliku (`content_fingerprint`)** — pomysł właściciela i realne ulepszenie tego, co
  już było. Rozmiar plus pierwsze i ostatnie 64 KiB, BLAKE2b, **dwa odczyty niezależnie od
  wielkości pliku**: zmierzone 2000 plików w ~24 s (ok. 12 ms na plik), a skan robi porcję
  po 2000, żeby żaden przebieg nie był ciężki. Z 2000 odcisków 1974 są unikalne, a wszystkie
  26 powtórzeń to **naprawdę te same pliki** leżące w dwóch miejscach — czyli dokładnie to,
  po co ten odcisk jest.
  **Czym to nie jest**: to nie jest suma kontrolna pliku i nie wolno jej tak nazywać. Przypadkowa
  kolizja nie zdarza się (dwa pliki musiałyby mieć tę samą długość i oba końce), ale kolizję
  **celową** ustawia się bez trudu — więc odcisk może dopasować ocenę i nie może niczego
  autoryzować. Test pinuje tę granicę: dwa pliki różniące się wyłącznie w środku mają ten sam
  odcisk, świadomie.
- **Eksport niesie odcisk** — w M3U jako komentarz (`#TRYHACKX-FINGERPRINT:`), który każdy inny
  odtwarzacz zignoruje, w XSPF w `<meta>`, w CSV i JSON jako kolumna. To sprawia, że plik
  **znaczy coś także w innej instalacji**, nadal nie zdradzając ani jednej ścieżki — czyli
  zdejmuje jedyny minus wyboru „identyfikatory zamiast ścieżek".
- E2E: **59 sprawdzeń** (17 nowych na odcisk, JSON i szczelność). Bramka: 8/8.

## 16.08.2026 (noc, później) — eksport playlist i ocen

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-playlist-io` + `…-pre-playlist-io.sql`.
Bez migracji — eksport tylko czyta. **Połowa punktu 2 roadmapy**; import opisany w `NEXT-SESSION.md`.

- **Decyzja właściciela (16.08.2026)**: eksport niesie **identyfikatory pozycji**, nie ścieżki.
  `relative_path` jest wprawdzie względne wobec roota, ale i tak przeliterowuje układ biblioteki
  każdemu, komu plik trafi. Świadomy koszt: **te pliki są dla tego serwera** — VLC ich nie
  otworzy, bo `tryhackx:item:9` nie jest miejscem na żadnym dysku. Tytuły i czasy jadą obok,
  żeby plik dało się przeczytać oczami.
- **Playlista jako M3U albo XSPF** (`collection_export`). W XSPF użyte jest `<identifier>` —
  pole, które format ma dokładnie na „identyfikator nadawcy” — a `<location>` **nie występuje**,
  bo to ono niosłoby ścieżkę. Lista inteligentna eksportuje to, co pokazuje, bo czyta przez
  ten sam stronicowany czytnik co interfejs. Limit 50 000 pozycji.
- **Oceny jako CSV** (`ratings_export`) — wyłącznie własne konto; eksport mogący nazwać cudze
  oceny byłby sposobem na ich odczytanie. Kolumny `media_item_id, media_kind, title, artist,
  rating, favorite`, z BOM-em, bo ten plik częściej otwiera Excel niż cokolwiek innego.
- **Eksport to czytanie listy, którą i tak widzisz**, więc nie wymaga prawa do pobierania —
  plik niesie identyfikatory i tytuły, nigdy mediów. Przycisk „Eksportuj playlistę” na pasku
  playlisty, „Pobierz oceny (CSV)” w „Moje konto”.
- E2E: **50 sprawdzeń** łącznie, w tym 15 nowych na eksport — kompletność, nagłówki, obecność
  identyfikatorów, poprawność XML, odrzucenie nieznanego formatu i **trzy testy szczelności**
  (brak liter dysków, ścieżek UNC i nazw plików multimedialnych w każdym z trzech formatów).
  Bramka `scripts/check.py`: 8/8.

## 16.08.2026 (noc) — poprawki po testach właściciela, gatunki w muzyce

Bez migracji. Zgłoszenia z testów plus rozszerzenie gatunków na bibliotekę muzyczną.

- **„To jest to" w panelu nie działało (403).** Potwierdzenie dopasowania szło przez `request()`
  zamiast przez `post()`, a token CSRF dokłada właśnie `post()`. Zapis bez nagłówka most
  odrzuca — słusznie. Sprawdzone po HTTP: bez nagłówka nadal **403**, z nagłówkiem **200**.
- **Menu przestawało działać po dłuższej przerwie.** Sesja PHP wygasała, powłoka była nadal
  zamontowana, więc nawigacja brała ją z cache i **nie sprawdzała sesji ponownie**; zapytania
  strony kończyły się `401`, router łapał wyjątek do logu i nic się nie działo. Teraz **pierwsze
  `401` przenosi na logowanie** z parametrem `?next=`, więc po zalogowaniu wraca się na tę samą
  stronę. Tylko `401` — `403` znaczy „nie wolno Ci tego", co jest odpowiedzią, nie końcem sesji.
- **Muzyka „grała" bez dźwięku po długiej pauzie.** Bilet strumienia żyje **5 minut**; po dłuższej
  pauzie element audio prosił o zakres, którego już nie wolno mu dać, dostawał odmowę i cicho
  się poddawał — a dok dalej pokazywał odtwarzanie. Teraz błąd elementu **wymienia bilet
  i wraca na tę samą sekundę**. Intencja słuchacza jest trzymana osobno od stanu elementu,
  bo pauza wymuszona awarią nie jest decyzją o przerwaniu słuchania.
- **Worker gatunków ma przycisk w panelu** (sekcja Gatunki, „Sprawdź kolejną porcję") —
  nowa trasa `/v1/title-worker`, porcja po 50 dzieł, drugie kliknięcie w trakcie dostaje `409`.
- **Gatunek i rocznik w bibliotece muzycznej.** Okazało się, że **tagi tam były przez cały
  czas** — poprzedni wniosek („jeden utwór na 12 807 ma gatunek") opisywał stan katalogu, nie
  plików: biblioteki nigdy nie przeskanowano z `--metadata` po podbiciu `TAG_SCHEMA` do 2.
  W próbce 60 plików **34 miały gatunek**, a większość rok. Skan zakolejkował 12 806 ponownych
  odczytów. Gatunek muzyczny to **wolny tekst z taga**, nie słownik filmowy, więc ma własny
  filtr (`tag_genre`) liczony z katalogu jak formaty; rok z taga trafia do tej samej kolumny
  `release_year` co rok filmu (źródło `tag`), żeby jedna reguła działała w obu bibliotekach.
- **„Bez gatunku" jako pozycja filtra** w obu bibliotekach — inaczej pliki, których nie udało
  się rozpoznać, po prostu znikają z każdego gatunku i nic nie mówi, ile ich jest.
- **Okresowe odświeżanie dopasowań**: odpowiedzi starsze niż 90 dni wracają do kolejki przy
  następnym uruchomieniu workera. **Nigdy** decyzje ręczne (`source = 'manual'`) i nigdy wiersze
  czekające na przegląd — te trzymają kandydatów, których właściciel właśnie czyta.
- **Cache napisów pamięta, gdzie stanął.** Dotąd każdy przebieg wołał `ffprobe` dla **każdego**
  filmu, żeby dowiedzieć się, że napisy są już w cache — 6617 razy. Teraz obok cache leży
  rejestr (rozmiar + `mtime` na plik), zapisywany co 25 pozycji i atomowo; przebieg po restarcie
  wznawia się zamiast zaczynać od zera, a panel pokazuje, ile pozycji pominięto.
- Poprawka przy okazji: `classify_item` porównywał wersję tagów z literałem `2` zamiast
  z `TAG_SCHEMA` — dokładnie ten dług, który poprzednio nazwano, ale w jednym miejscu zostawiono.
- E2E na koncie tymczasowym: **36 sprawdzeń** (filtry filmowe i muzyczne porównane z surowym
  SQL, „bez gatunku" po obu stronach, kolejka przeglądu, potwierdzenie kandydata) plus test po
  HTTP potwierdzający CSRF i przycisk workera. Bramka `scripts/check.py`: 8/8.

## 16.08.2026 (wieczór) — gatunek i rok filmu

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-genre-year` (pliki) oraz
`…-pre-genre-year.sql` (baza). Migracje `029` i `030` zastosowane. **Punkt 1 roadmapy
zamknięty w całości** (schemat, rok z nazwy, źródło zewnętrzne, reguły list, filtry).

- **Źródło danych: Filmweb, bez konta i bez scrapowania HTML.** Konto TMDb okazało się
  niepotrzebne. Generator z pulpitu (`movie-generator`) celował w `api.imdbapi.dev` — **ta
  domena już nie istnieje** (NXDOMAIN), a `imdb.com` odbija każde żądanie bez przeglądarki
  (HTTP 202, puste ciało, AWS WAF). Działają natomiast dwa własne endpointy JSON Filmwebu:
  `/api/v1/live/search` i `/api/v1/film/{id}/preview`, a ten drugi podaje **rok, gatunki ze
  stabilnymi numerami, czas trwania oraz tytuł polski i oryginalny**. Słownik
  `/api/v1/genres` odpowiada po polsku i po angielsku, więc 60 gatunków w migracji `029`
  ma obie pisownie **wprost od źródła** — nic nie jest tłumaczone ręcznie.
- **Czas trwania jako świadek.** Dopasowanie nie opiera się na samym tytule: `ffprobe` już
  zmierzył długość pliku, a Filmweb podaje swoją, więc „Batman” pasujący do dwunastu filmów
  rozstrzyga się na tym jednym, który trwa 126 minut i jest z 1989. Automatycznie zapisujemy
  wyłącznie zgodność tytułu, roku **i** czasu; do tego **margines** — dwóch kandydatów
  z podobnym wynikiem trafia do przeglądu, bo wybór między nimi byłby rzutem monetą zapisanym
  jako fakt. Zmierzone na próbkach: 18/20 i 17/22 dopasowań pewnych, reszta słusznie odłożona.
- **Sekcja „Gatunki" w panelu** — to, czego system nie jest pewien, czeka tam z kandydatami
  (tytuł, rok, czas, gatunki, link do Filmwebu) i z **powodem wahania** („runtime 14 min out",
  „too close to call"). Można potwierdzić jednego kliknięciem, ustawić gatunki ręcznie albo
  pominąć. Potwierdzenie **nie wraca do sieci** — kandydaci zostali zapisani razem z gatunkami,
  więc decyzja to zapis lokalny. Decyzja człowieka ma źródło `manual` i **nie jest cofana**
  ani przez skan, ani przez kolejne pobranie.
- **Rok z nazwy pliku, bez sieci** (`naming.py`): 1425 z 6617 filmów dostało rok od ręki.
  Zakres **nie jest rokiem** — `Pokémon (1997 – 2023)` to rozpiętość serialu, a odcinek
  w środku nie jest z 1997, więc zostaje bez roku zamiast z błędnym. Nawias bije gołe cyfry
  (`1917 (2019)`), a nazwa zaczynająca się od czterech cyfr zaczyna się od tytułu (`1670`).
- **Jedno pytanie na dzieło, nie na plik.** Odcinek jest wyszukiwany jako **serial**: 6617
  plików to 1783 zapytania zamiast 6617, bo 1210 odcinków Pokémona ma jedną odpowiedź.
  Serial rozpoznajemy po `S01E02`, `1x02`, `E30` i po folderze sezonu; nazwą serialu jest
  **najgłębszy folder bez znacznika sezonu**, bo `Gwiezdne Wojny Kolekcja` to półka z dwoma
  serialami i filmami, a `Pokemon S01 - Indigo League` to sezon, nie serial.
- **Reguły list inteligentnych**: gatunki (dowolny z wybranych) i zakres lat, obok ocen
  i odtworzeń. **Filtry w bibliotece filmów**: gatunek i dekada obok rozdzielczości i HDR,
  liczone z katalogu — selektor pojawia się dopiero, gdy jest co pokazać.
- Nowe polecenie `title-worker --root movies [--limit N] [--enqueue-only]`; robi jedno
  żądanie naraz z przerwą, cachuje każdą odpowiedź w `runtime/filmweb-cache` i pracuje
  porcjami. E2E na koncie tymczasowym: **29 sprawdzeń** (filtry i ich zgodność z surowym SQL,
  reguły list, kolejka przeglądu, potwierdzenie kandydata dochodzące do wszystkich plików
  dzieła, blokada `manual`, odmowy dla nie-administratora); konto skasowane po `username`.
  Bramka `scripts/check.py`: 8/8.

## 16.08.2026 (popołudnie) — napisy z serwera, przełącznik PL/EN zamknięty

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-i18n-server`. Bez migracji.
**Punkt 1 roadmapy zamknięty w całości.**

- **Etykiety ścieżek składa przeglądarka, nie serwer.** `stereo.py` wysyłał gotowe zdanie
  („Polski · AC3 5.1 · 384 kb/s · domyślna”) — jedyny fragment interfejsu, którego przeglądarka
  nie mogła przetłumaczyć. Teraz wysyła **składniki** (`codec`, `channel_layout`,
  `bitrate_kbps`, `default`, `forced`), a zdanie pisze `compatibleTrackLabel()` w odtwarzaczu,
  w języku konta. Tabela nazw języków po stronie Pythona zniknęła — frontend ma własną.
  Sprawdzone: to samo `Dr.House.S01E02` czyta się jako „Polish · AC3 5.1 · 384 kb/s · default”
  albo „Polski · AC3 5.1 · 384 kb/s · domyślna”, zależnie od ustawienia konta.
- **Komunikaty mostu PHP idą przez ten sam słownik.** `ApiError` podaje otrzymany polski
  `message` do `t()`, więc polski tekst jest kluczem jak wszędzie indziej. Przetłumaczone
  **54 ze 116** — odmowy uprawnień, limity pobierania, archiwa, kolekcje, cały tor zakładania
  konta i aktywacji. Reszta to komunikaty walidacji parametrów („Nieprawidłowy identyfikator”),
  które pojawiają się wyłącznie przy zniekształconym żądaniu; nieprzetłumaczony komunikat
  nadal się pokazuje — po polsku — więc nic nie znika.
- Test `_stream_label` zastąpiony testem `_stream_facts`: sprawdza, że wychodzą dane, a nie
  zdanie, i że czego `ffmpeg` nie podał, tego nie ma.

## 16.08.2026 (południe) — przełącznik PL/EN skończony

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-i18n3`. Bez migracji.
Punkt 1 roadmapy zamknięty.

- **Panel administracyjny (274 wywołania `t()`), reszta konta (186) i logowanie (34)**.
  Słownik ma **763 wpisy**. Cały interfejs przełącza się na angielski i wraca bez
  pozostałości — sprawdzone we wszystkich ośmiu sekcjach panelu, na koncie i w logowaniu.
- **Logowanie czyta język przeglądarki**, bo działa przed sesją i nie ma kogo zapytać
  o preferencję. Nie zmienia niczyjego zapisanego wyboru — ten należy do konta i obowiązuje
  od chwili zalogowania.
- **Naprawiony błąd, który sam z siebie by nie wyszedł**: tabele nazw zdarzeń dziennika
  i etykiet praw grup były **stałymi modułowymi**, więc `t()` rozwiązywało je przy ładowaniu
  paczki — zanim powłoka zdążyła przyjąć język konta. Zostały po polsku niezależnie od
  ustawienia. Teraz są funkcjami, czyli liczą się przy rysowaniu.
- **Trzy kształty napisów, których żadne wcześniejsze przejście nie widziało** i które
  trzeba było doszukać osobno: teksty bez polskich znaków („Stan katalogu”, „Nazwa”, „Konta”),
  teksty w pozycji argumentu (`field("Opis", …)`, tablice konfiguracji praw) oraz przypisania
  wprost do właściwości (`status.textContent = "Zapisywanie…"`). Skrypt wyszukujący te trzy
  wzorce leży w scratchpadzie i wychodzi pusty.
- Po polsku zostają wyłącznie **dane z bazy**: nazwy grup („Użytkownicy”, „Goście”) i nazwy
  playlist w szczegółach dziennika. To treść wpisana przez właściciela, nie interfejs.

**Zostaje**: komunikaty mostu PHP i etykiety ścieżek składane przez `stereo.py` — jedyne
napisy, których frontend nie tworzy. Sposób opisany w `ROADMAP.md`.

## 16.08.2026 (przedpołudnie) — angielski w doku, kolekcjach i edytorach

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-i18n2`. Bez migracji.
Etap trzeci przełącznika PL/EN.

- **Dok odtwarzacza i kolejka** (`audio-player.ts`, 76 wywołań `t()`): sterowanie, tryby
  losowania i powtarzania z opisami, licznik pozycji, sentinelki „wcześniejsze/następne
  utwory”, gwiazdki, przyciski docka.
- **Kolekcje** (`collections.ts`, 36): wszystkie cztery selektory z opcjami, wyszukiwarka,
  karty i komunikaty.
- **Edytor tagów i wybór okładki** (`metadata-editor.ts` 21, `cover-picker.ts` 19,
  `rating.ts` 1): pola formularza, kadrowanie, wszystkie przyciski.
- **Liczby i oceny w języku interfejsu**: licznik kolejki pokazuje „Items 1–160 of 12,807”
  zamiast polskiego grupowania, a ocena „Rate 4.5 out of 5” zamiast „4,5”.
- Słownik ma **375 wpisów**. Sprawdzone w przeglądarce: dok, kolejka, kolekcje i oba edytory
  bez polskich napisów po przełączeniu na `en`; jedyne polskie słowa, jakie zostają, to
  **tytuły plików** („Play Ścieżka 12”), czyli nazwy z dysku, nie interfejs.
- `500 × 500 WebP` celowo bez tłumaczenia — czyta się tak samo w obu językach.

**Zostało po polsku**: `pages/admin.ts` (~36 napisów w pozycjach etykiet, ~160 literałów
łącznie), reszta `pages/account.ts` (~46), `pages/login.ts` (~2 — działa przed sesją),
komunikaty mostu PHP oraz etykiety ścieżek składane przez `stereo.py`.

## 16.08.2026 (nad ranem) — angielski w bibliotece i odtwarzaczu

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-i18n`. Bez migracji.
Etap drugi przełącznika PL/EN.

- **Biblioteka (`library-page.ts`, 135 wywołań `t()`) i odtwarzacz wideo (`media-viewer.ts`, 64)**
  mówią po angielsku: pasek narzędzi, sortowania, wszystkie filtry, karty, playlisty, dialogi
  okładki i kolekcji, komunikaty błędów, sterowanie odtwarzaczem, wybór ścieżek, panel
  szczegółów i panel po napisach końcowych. Słownik ma 261 wpisów.
- **Liczebniki i języki przechodzą przez ten sam słownik.** Polska gramatyka wybiera formę
  („1 kanał”, „3 kanały”, „6 kanałów”), a słownik odwzorowuje wybraną formę na angielską —
  dwie z trzech trafiają na to samo „channels”, i żadne miejsce wywołania się nie zmienia.
  Tak samo nazwy języków ścieżek: tabela ISO odpowiada po polsku, a `t()` robi z tego
  „Polish”/„English”. Efekt: „Polski · AC3 · 5.1(side) · 6 kanałów · domyślna” czyta się po
  angielsku jako „Polish · AC3 · 5.1(side) · 6 channels · default”.
- **Liczby zapisują się w języku interfejsu**: `formatBytes` czyta wybrany język zamiast
  wpisanego na sztywno `pl-PL`, więc „3,4 GB” po polsku i „3.4 GB” po angielsku. Strona
  przełączona na angielski z polskimi przecinkami dziesiętnymi wyglądałaby na przetłumaczoną
  do połowy — bo byłaby.
- Sprawdzone w obie strony na koncie tymczasowym: po przełączeniu na `en` i z powrotem na `pl`
  te same ekrany czytają się w wybranym języku, bez pozostałości.

**Zostało po polsku** (opisane w `NEXT-SESSION.md`): panel administracyjny, kolekcje,
logowanie, dok odtwarzacza z kolejką, edytor tagów i wybór okładki, komunikaty mostu PHP
oraz etykiety ścieżek budowane przez usługę Pythona (`stereo.py`).

## 16.08.2026 (późna noc) — panel po napisach końcowych, zwięzłe szczegóły

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-upnext`. Bez migracji.
Punkt spoza roadmapy — zgłoszony przez właściciela w trakcie testów.

- **Co dalej, gdy film się skończy.** Po ostatniej klatce na obrazie pojawia się panel
  z propozycjami. **Sam odpala się wyłącznie następny odcinek serialu**, po odliczeniu
  12 sekund — jeden film wchodzący w drugi bez pytania to jest to, jak się gubi wieczór.
  Dotknięcie panelu albo dowolny klawisz zatrzymuje odliczanie („Odtwarzanie wstrzymane —
  wybierz sam”). Reszta to karty do kliknięcia. Panel leży wewnątrz sceny odtwarzacza,
  więc działa też na pełnym ekranie, i znika razem z filmem, do którego należał.
- **Skąd propozycje**: najpierw pozostałe pliki z tego samego folderu, potem „popularne
  w domu”, a na końcu dobrze oceniane filmy dłuższe niż 40 minut, których konto nie
  otwierało — bez tego film stojący samotnie w folderze kończył się pustym ekranem.
  Nowa akcja mostu `up_next`; kolejność odcinków liczy ten sam `EpisodeOrder`, co półka
  na stronie startowej.
- **Szczegóły techniczne zwięźlejsze.** Od razu widać cztery rzeczy, po które się tam
  zagląda: **plik, obraz, ścieżki dźwiękowe po polsku i angielsku, podsumowanie napisów**
  („2 ścieżki · Polski · Angielski” zamiast wiersza na każdą — rip potrafi ich nieść
  dwadzieścia). Cała reszta chowa się pod „Pozostałe szczegóły (N)”.
- **Porównanie z MediaInfo** (właściciel podesłał zrzut dla 1917 (2019) 4K): `ffprobe`
  daje to samo w każdej pozycji, która trafia do panelu — 21,6 GB, 1:58:59, **25,9 Mb/s**
  plik i **21,4 Mb/s** obraz, 3840×1604, 2.39:1, HEVC Main 10, 10 bit, bt2020nc,
  HDR (smpte2084), oraz trzy ścieżki: polski AC3 stereo 192 kb/s (domyślna), angielski
  **Dolby TrueHD + Dolby Atmos** 7.1 3810 kb/s i angielski AC3 5.1 448 kb/s. Osobna
  zależność (MediaInfo) nie jest do tego potrzebna.

## 16.08.2026 (noc) — dane każdej ścieżki, filtry w muzyce, „Popularne w domu”

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-ui-fixes`. Bez migracji,
ale **`PROBE_SCHEMA` podniesione do 2**, więc filmy są czytane ponownie (skan roota
filmowego + `metadata-worker`; ok. 110 ms na plik).

- **Szczegóły techniczne opisują każdą ścieżkę, nie pierwszą.** `ffprobe` zapisuje teraz
  listę ścieżek dźwiękowych i napisów z kodekiem, układem kanałów, próbkowaniem,
  przepływnością, językiem, tytułem i znacznikami „domyślna”/„wymuszone”. Film z lektorem,
  oryginałem i komentarzem opisywał dotąd wyłącznie lektora.
- **Przepływność obrazu osobno od przepływności pliku.** Matroska prawie nigdy nie wypełnia
  `bit_rate` na strumieniu — trzyma liczbę w tagu `BPS` (czasem `BPS-eng`), więc bez czytania
  obu każdy rip pokazywał tylko sumę całego pliku. Doszły też przestrzeń barw i krzywa
  przenoszenia przy HDR. Panel stracił margines, ramkę i zaokrąglenie.
- **Naprawiony błąd, przez który podbicie schematu nic nie robiło.** Klucz zadania w kolejce
  brzmiał `metadata:{id}:{mtime}`, więc dla niezmienionego pliku `INSERT IGNORE` trafiał
  w zadanie już wykonane: skan poprawnie klasyfikował 6617 filmów jako „updated”
  i kolejkował **zero**. Klucz niesie teraz wersję ekstrakcji (`…:v2`, `…:a2`), więc podbicie
  schematu to nowe zadanie dla tych samych bajtów. Wersja tagów audio dostała nazwę
  (`metadata.TAG_SCHEMA`) zamiast dwóch literałów w różnych plikach.
- **Filtry w bibliotece muzycznej**, na wzór filmowych i liczone z katalogu: **format pliku**
  (M4A 6863, FLAC 3378, MP3 2373, OPUS 104, WAV 87…), **jakość** (bezstratne 3466,
  od 320 kb/s 1990, poniżej 7351) i **hi-res** (od 88,2 kHz — 89 plików). Gatunku celowo nie
  ma: tag niesie **jeden** utwór na 12 807, więc selektor byłby ślepą uliczką. Trzy koszyki
  jakości sumują się dokładnie do biblioteki — filtry pytają tylko o pliki dźwiękowe, bo
  inaczej okładki i pliki `.nfo` wpadały do „poniżej 320 kb/s”. Karta „Wszystkie utwory”
  znika przy włączonym filtrze: odtwarzała cały folder, gdy widok pokazywał wybór.
- **Nowa kolejność półek na stronie startowej**: Obejrzyj dalej → Kontynuuj oglądanie →
  Niedokończone utwory → Kontynuuj słuchanie → **Popularne w domu**.
- **„Popularne w domu”** — grane w ostatnich 30 dniach przez innych domowników, a przez
  Ciebie jeszcze nie. Liczone są **osoby, nie odtworzenia**: „dwoje domowników” mówi więcej
  niż „czterdzieści odtworzeń”, które jeden słuchacz wygeneruje sam. Ranking wszechczasów
  pokazywałby w kółko te same pięć plików.

## 16.08.2026 (późny wieczór) — poprawki po testach właściciela

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-ui-fixes`. Bez migracji.

- **Półki „Kontynuuj” pod kartami bibliotek**, bez poziomego paska przewijania: wiersz jest
  teraz siatką, która mieści tyle kolumn, ile pozwoli okno, a strona chowa wszystko poza
  **dwoma rzędami**. Ile to kart, wie tylko przeglądarka, więc liczba kolumn jest odczytywana
  z rozwiązanego `grid-template-columns` i przeliczana przy każdej zmianie rozmiaru — nadmiar
  znika w całości (`display: none`), więc nic nie jest ucięte w pół ani nie zostaje w kolejce
  tabulacji. Zmierzone: 1280 px → 4 kolumny × 2 rzędy, 900 px → 3, telefon → 2.
- **Słuchanie rozbite na dwie półki**: „Kontynuuj słuchanie” to nadal długie nagrania
  (od dziesięciu minut), a nowe „Niedokończone utwory” to krótsze rzeczy przerwane w połowie.
  Jedna lista mieszała set didżejski z trzyminutową piosenką.
- **Pauza działa za pierwszym kliknięciem.** Przycisk pytał `video.paused`, a element zgłasza
  „zatrzymany”, dopóki obietnica z `play()` nie dobiegnie końca — więc pierwsze kliknięcie
  zaraz po starcie prosiło film, żeby **zagrał** jeszcze raz. Teraz źródłem prawdy jest
  intencja widza (`desiredVideoPlaying`), którą zdarzenia `play`/`pause` i tak aktualizują;
  przeglądarka odmawiająca autoodtwarzania też ją prostuje.
- **Szczegóły techniczne bez chowania**: nie ma już `<details>` do rozwijania — panel stoi
  otwarty na całej szerokości odtwarzacza, **nad** notatką o trybie dostarczania (bo to notatka
  tłumaczy obraz, więc czyta się ostatnia), a w pełnym ekranie znika. Doszły: klasa
  rozdzielczości, format pikseli, proporcje obrazu (16:9, 2,35:1), układ kanałów (5.1/7.1),
  języki napisów pełnymi nazwami, rozmiar pliku, czas trwania, typ MIME i pełna ścieżka.
  Gdy plik nie podaje przepływności, liczymy uczciwą średnią z rozmiaru i długości.
- **Licznik odtworzeń przestał kleić się z ikoną.** Font Awesome 7 rysuje glify szerokie na
  ~1,25 em, więc oko wystawało z pudełka 0,85 rem po ~1,7 px z każdej strony — pudełko dobiera
  się teraz do glifu, a odstęp robi `gap`. Wysokość zmierzona na stronie: bez korekty oko szło
  1,52 px nad cyframi i 0,48 px pod nie; 0,05 em w dół daje 0,92 px i 1,08 px, czyli tyle,
  o ile glif jest po prostu wyższy od cyfry. (Kolejkowe 0,157 em nie przenosi się tutaj —
  mierzono je przy tekście 0,85 rem, a licznik ma 0,75 rem.)
- **Zwinięty odtwarzacz nie blokuje się już na komputerze.** Wybór jest pamiętany, ale
  **obowiązuje tylko tam, gdzie da się go cofnąć**: telefon zwija i rozwija, a szeroki ekran
  bez ustawienia „Pozwól zwijać odtwarzacz także na komputerze” zawsze pokazuje pełny dok.
  Dotąd zwinięcie na telefonie zostawiało komputer z jednoliniowym paskiem i bez przycisku.

## 16.08.2026 (wieczór) — fundament przełącznika języka PL/EN

Bez migracji: język mieści się w istniejącej kolumnie `users.preferences_json`.
**Etap pierwszy z trzech** — dalsze ekrany opisane w `ROADMAP.md`.

- **Kluczem jest polski tekst**, nie symbol (`t("Odtwórz")`, nie `t("player.play")`). Trzy powody:
  wyciąganie napisów jest mechaniczne i nie da się przy nim pomylić nazwy, nieprzetłumaczony
  napis pokazuje się **po polsku** zamiast jako surowy klucz, a polski interfejs działa bez
  zmian na każdym kroku. Podstawienia są nazwane (`t("{hours} g {minutes} min", { hours, minutes })`),
  a brakująca wartość zostaje widoczna jako `{minutes}` — bo widoczny nawias to zgłoszenie
  błędu, a „undefined” w interfejsie nie jest.
- **Język należy do konta**, nie do przeglądarki: `preferences_json.language`, przełącznik
  w „Moje konto → Język interfejsu”. Konta, które nigdy nie wybierały, dostają **polski** —
  czytanie języka przeglądarki po cichu przestawiłoby interfejs wszystkim dotychczasowym
  użytkownikom. Nieznana wartość wraca do polskiego. Zapis przeładowuje stronę: każdy napis
  jest rozwiązywany przy budowaniu elementu, więc podmiana w locie znaczyłaby przerysowanie
  powłoki, docka, kolejki i otwartych okien.
- **Przetłumaczone w tym etapie**: powłoka (nawigacja, karta konta, wylogowanie, menu),
  strona startowa razem z całą półką „Kontynuuj”, oraz panele ustawień konta (język i kolejka).
  Reszta (biblioteki, kolekcje, panel administracyjny, logowanie, odtwarzacze, edytor tagów)
  **nadal jest po polsku** — i taka zostaje także po przełączeniu na angielski, zgodnie
  z regułą powyżej.
- Testy jednostkowe `t()`: domyślny język, odrzucanie nieznanego, brak tłumaczenia,
  podstawienia w obu językach, brakująca wartość podstawienia.

## 16.08.2026 (popołudnie) — „Kontynuuj oglądanie” na stronie startowej

Backup przed serią: `C:\wamp64\backups\media-server-20260816-pre-continue` (pliki) +
`…-pre-continue.sql`. Migracja `028` zastosowana.

- **Półka „Kontynuuj” na stronie startowej**: filmy i długie nagrania zatrzymane między 2%
  a 95% czasu trwania, najświeższe pierwsze, osobno obraz i osobno dźwięk. Kliknięcie wraca
  do zapisanej sekundy — film przez `startSeconds` odtwarzacza (tryb zgodny dostaje ją jako
  punkt cięcia strumienia), utwór przez `resumeSeconds` kolejki. Muzyka wchodzi na półkę
  dopiero od **dziesięciu minut**: piosenka przerwana w połowie to nie zaległość, a bez tego
  progu lista miała 152 pozycje, z czego 8 coś znaczyło.
- **„Obejrzyj dalej”** — po filmie doprowadzonym do końca proponujemy kolejną pozycję z tego
  samego folderu. Gdy folder wygląda na serial, jest to **następny nieoglądany odcinek**;
  poza tym losowa nietknięta pozycja. Serial rozpoznajemy z nazw plików (`S01E02`, `[S03E03]`,
  `1x02`, `E07`, sam numer) — nowy `EpisodeOrder.php`, z regułą, że **sam numer liczy się
  dopiero, gdy większość folderu tak się nazywa**, bo rok, rozdzielczość i przepływność
  wyglądają tak samo. Trylogia filmowa świadomie **nie** jest serialem. Propozycja „z tego
  samego folderu” musi trwać co najmniej połowę tego, co się właśnie skończyło — inaczej
  po dwugodzinnym filmie dostawało się 28-minutowy dodatek z płyty.
- **„To już obejrzałem”** chowa pozycję z półki, **nie kasując historii**: `play_count`,
  pozycja i data zostają, znika tylko z listy (migracja `028`, `playback_stats.continue_hidden_at`).
  Ponowne obejrzenie przywraca — ale dopiero zdarzenie `start`, nie sam raport postępu, żeby
  przypadkowe kliknięcie nie cofało decyzji.
- **Jedno zapytanie na całą półkę** (`?action=continue`), z filtrem dostępu do bibliotek:
  grupa bez filmów nie dostaje ani sekcji filmowej, ani sugestii. Gość dostaje pustą półkę,
  bo `playback()` nie zapisuje mu historii. Pomiar na tej instalacji: 63 ms dla konta
  z 175 pozycjami w historii.
- E2E na koncie tymczasowym z własną grupą: wznowienie filmu (14:14 z 33:23 po zapisanych 42%),
  wznowienie 122-minutowego miksu (36:54) wraz z doładowaniem kolejki folderu (205 utworów),
  ukrycie i powrót po ponownym odtworzeniu, przełączanie dostępu do bibliotek w obie strony,
  CSRF na akcji ukrywania, limit poza zakresem (422), układ na telefonie. Konto, grupa
  i wpisy historii usunięte po sobie.

## 16.08.2026 (południe) — szczegóły techniczne filmu, czytelny wybór ścieżek, licznik odtworzeń

- **Szczegóły techniczne pod odtwarzaczem**: zwijany panel z tym, co `ffprobe` już zapisał —
  obraz (rozdzielczość, kodek, profil, **głębia bitowa**, HDR, klatkaż), dźwięk (kodek, kanały,
  próbkowanie, liczba ścieżek) i plik (kontener, **przepływność**, języki napisów). Głębię
  wyliczamy z formatu pikseli (`yuv420p10le` to 10 bitów), bo `ffprobe` nie podaje jej wprost.
  Nic nie jest zgadywane: czego nie ma w pliku, tego nie ma w panelu. Dane jadą z tego samego
  `metadata_json`, więc nie doszło ani jedno zapytanie.
- **Wybór ścieżki audio i napisów opisany po ludzku**: było „POL · AC3 · 5.1”, jest
  „Polski · AC3 5.1 · 640 kb/s · domyślna”. Język pełną nazwą (30 języków), potem układ kanałów,
  przepływność i znaczniki „domyślna”/„wymuszone” — czyli to, po czym naprawdę się wybiera.
- **Licznik odtworzeń jako znacznik z ikoną oka**, zawsze w osobnej linii pod danymi pliku.
  Dotąd „Odtworzono 22×” raz mieściło się obok znaczników, a raz zawijało — dwie sąsiednie
  karty łamały się różnie.

## 16.08.2026 (przedpołudnie) — pobieranie rozbite na cztery prawa

Migracja `027` zastosowana. Grupy zachowały to, co miały: stara wartość `can_download` została
skopiowana do wszystkich czterech kolumn, zanim znikła.

- **Cztery prawa zamiast jednego**: pojedyncze pliki, zaznaczone pliki (i wyniki wyszukiwania),
  cały folder (playlista liczy się jako folder) oraz cała biblioteka, czyli korzeń jako jedno
  archiwum. Wydanie komuś jednego utworu to inna decyzja niż pozwolenie na wyciągnięcie całej
  biblioteki, a dotąd kryły się za tym samym przełącznikiem.
- **Biała lista rozszerzeń per grupa**: puste pole znaczy „bez ograniczeń”. Wpisane po ludzku
  („MP3, .flac; mkv”) zapisuje się jako `flac,mkv,mp3`. Pojedynczy plik spoza listy dostaje
  odmowę z nazwą rozszerzenia; **archiwum jest filtrowane, nie odrzucane** — użytkownik dostaje
  to, co mu wolno, i widzi komunikat, ile plików pominięto. Archiwum, z którego nie zostaje nic,
  jest odrzucane z wyjaśnieniem.
- **Prawo sprawdzane przed pracą**: żądanie archiwum najpierw pyta o uprawnienie, a dopiero potem
  zbiera identyfikatory plików. Wcześniej korzeń dużej biblioteki odbijał się od limitu 1000
  plików, zanim ktokolwiek sprawdził, czy grupa w ogóle ma prawo do takiego pobrania.
- **Panel**: karta grupy ma osobną sekcję „Pobieranie” z czterema przełącznikami i pole
  „Dozwolone rozszerzenia plików”. Interfejs biblioteki chowa dokładnie te przyciski, których
  grupa nie ma — checkboxy zaznaczania znikają bez prawa do zaznaczonych, przycisk folderu
  odpowiada prawu folderu, a w korzeniu prawu do całej biblioteki.
- **Odtwarzanie to nie pobieranie**: strumień (inline) nadal działa bez żadnego z tych praw.
- E2E na tymczasowym koncie z własną grupą przełączaną między sprawdzeniami: 20 kontroli,
  każde prawo osobno, plus normalizacja listy rozszerzeń i filtrowanie archiwum.

## 16.08.2026 (rano) — dziennik aktywności, dostrojenie kolejki, cache po wydaniu

- **Aktywność w panelu**: nowa sekcja z dziennikiem audytu (kiedy, kto, zdarzenie, cel,
  szczegóły), filtrami po rodzaju zdarzenia i koncie oraz stronicowaniem po 25 wpisów. Dziennik
  był zapisywany od pierwszego etapu, ale dało się go przeczytać wyłącznie klientem SQL. Obok
  lista ostatnich logowań (`users.last_login_at`). **Retencja**: wpisy starsze niż 12 miesięcy
  znikają przy okazji zapisu nowych (co dwusetny wpis sprząta), więc dziennik nie rośnie bez końca.
  Konto usunięte zostawia wpis z pustym autorem — zdarzenie zostaje, nazwisko nie.
- **Kolejka odtwarzania — dostrojenie po pomiarach**: odstęp czasu trwania zmniejszony do 0,2 rem,
  serce jeszcze bliżej gwiazdki (0,22 rem), a przesunięcie ikon policzone na podstawie **linii
  bazowej odczytanej z układu strony** zamiast z metryk fontu (poprzednia wersja była o ~0,6 px
  za mała): serce 0,157 em, gwiazdka 0,194 em. Zmierzone po zmianie: serce 1,51 px nad tekstem
  i 1,49 px pod, gwiazdka równo 3 px z obu stron — czyli tyle, o ile glif jest po prostu większy
  od cyfr.
- **Przewijanie tytułu odpala się także przy małym ścięciu**: próg zszedł z 4 px na 1 px. Tytuł
  ucięty o dwa piksele pokazywał wielokropek i odmawiał ruchu, co wyglądało na zepsute
  („(Everything I Do) I Do It for You” mija się z szerokością wiersza o 1,6 px). Dodatkowo pomiar
  powtarza się, gdy kursor wchodzi na wiersz — pierwszy pomiar po narysowaniu może trafić
  na zamknięty panel (wszystko ma zerową szerokość) albo na jeszcze niezaładowany font.
- **Cache po wydaniu**: szablony Apache ustawiają `Cache-Control: no-cache` dla stron HTML
  i roczny, niezmienny cache dla plików z hashem w nazwie. Bez tego po `npm run build`
  przeglądarka trzymała poprzednie wydanie i poprawki „nie działały” do twardego odświeżenia.
  **Wymaga skopiowania szablonu do `C:/wamp64/alias/` i przeładowania Apache** — robi właściciel.

## 16.08.2026 (nad ranem) — filtry obrazu, kolejka metadanych w panelu, poprawki kolejki

- **Filtry w bibliotece filmów**: rozdzielczość (4K / 1080p / 720p i wyżej), HDR, kodek wideo
  i kodek audio. Listy w selektorach są liczone z katalogu, więc nie ma tam kodeka, którego nikt
  nie ma, a pasek pokazuje się dopiero, gdy przebieg `ffprobe` ma co filtrować. Filtr pyta o obraz,
  a folder obrazu nie ma — dlatego filtrowanie spłaszcza widok do plików z całego poddrzewa (tak
  jak wyszukiwanie) i **podaje pełną liczbę trafień z serwera**, nie długość załadowanego okna.
  Ustawione filtry siedzą w adresie, więc widok da się wysłać albo dodać do zakładek.
- **Sortowanie po czasie trwania** (najdłuższe / najkrótsze) w Music, Movies i w domyślnych
  ustawieniach panelu; pliki bez znanego czasu lądują na końcu w obie strony.
- **Kolejka metadanych w panelu** (Indeksowanie): ile zadań czeka, pracuje, poległo i jest gotowych,
  plus przycisk przetwarzający porcję 200 plików. Dotąd worker istniał wyłącznie jako polecenie
  wiersza poleceń, więc świeżo zeskanowany film nie miał czasu trwania ani rozdzielczości, dopóki
  ktoś o tym nie pomyślał. Drugie kliknięcie w trakcie pracy dostaje `409`, a nie drugi proces.
- **Kolejka odtwarzania — trzy poprawki ze zgłoszenia**:
  serce, gwiazdka i ocena stoją teraz razem jako jeden klaster (odstęp 0,3 rem zamiast 0,75),
  a czas trwania trzyma szerszy odstęp — tytuł zyskał miejsce;
  ikony są wyrównane **optycznie**, nie pudełkami: Font Awesome rysuje serce i gwiazdkę wyżej
  w kwadracie em niż siedzą cyfry, więc pudełka o wspólnym środku i tak wyglądały na przesunięte
  (zmierzone: serce 1,5 px, gwiazdka 2 px przy 0,85 rem — o tyle są teraz opuszczone);
  przewijanie długiego tytułu wreszcie **pokazuje ukryty tekst** — dotąd animacja przesuwała cały
  element razem z jego oknem przycinania, więc nic nowego nie mogło się pojawić. Teraz jedzie
  wewnętrzna linia w nieruchomej ramce, a tempo zależy od dystansu (~55 px/s), więc ruch zaczyna
  się po ~0,3 s zamiast po ~1,5 s.
- **Przycisk zwijania odtwarzacza na telefonie**: nie leży już na tytule (wiersz utworu ma dla
  niego zarezerwowany pas), nie zostaje zielony po dotknięciu (reguły `:hover` tylko tam, gdzie
  hover naprawdę istnieje) i nie zostaje podświetlony przez fokus po kliknięciu.

## 16.08.2026 (noc) — metadane wideo przez ffprobe

Migracja `026` zastosowana. Backup ten sam co przy playlistach (ta sama sesja).

- **Worker czyta filmy**: kolejka `background_jobs` obsługuje teraz oba rodzaje — audio idzie do
  Mutagena jak dotąd, wideo do `ffprobe` (brany z katalogu skonfigurowanego FFmpeg). Jeden lock,
  jedna dzierżawa, jedno polecenie `metadata-worker`; uszkodzony plik kończy tylko swoje zadanie.
- **Katalog ma pola, po których da się filtrować**: `video_width`, `video_height`, `video_codec`,
  `audio_codec`, `frame_rate`, `is_hdr` plus indeks `(media_kind, video_height)`. Pełny wynik
  `ffprobe` (kontener, profil, format pikseli, języki napisów, liczba ścieżek) zostaje w
  `metadata_json.video`, tak jak tagi audio siedzą w `metadata_json.audio`.
- **Ponowny odczyt po zmianie zakresu**: skan nadal nie otwiera plików (porównuje `size + mtime`),
  ale wersja schematu (`metadata_json.video.schema`) mówi, kiedy trzeba przeczytać plik jeszcze raz,
  mimo że sam plik się nie zmienił. Skan roota filmowego domyślnie kolejkuje metadane — dotąd był
  z tego wyłączony, bo nie było czym czytać wideo.
- **Widać to na kartach**: film pokazuje klasę rozdzielczości (8K/4K/2K/1080p/720p, liczoną po
  szerokości, żeby kino 2,35:1 nie spadało do 720p) i znacznik HDR. HDR rozpoznajemy po krzywej
  przenoszenia, a `bt2020` liczy się dopiero z głębią 10/12 bitów; okładka osadzona w pliku nie
  jest mylona z obrazem filmu.
- Pomiar na tej instalacji: 600 filmów w 67 s (ok. 110 ms na plik), 6617 filmów zakolejkowanych
  i przetworzonych. Testy: parser `ffprobe` (rozdzielczość, klatkaż `24000/1001`, HDR, napisy,
  plik bez obrazu, pusty dokument) i ponowne kolejkowanie po podbiciu wersji schematu.

## 16.08.2026 (noc) — playlista jako pełnoprawny widok Music

Backup przed serią: `C:\wamp64\backups\media-server-20260815-pre-playlists` +
`…-pre-playlists.sql`. Migracje `024`, `025` zastosowane.

- **Jedno miejsce zamiast trzech**: playlista otwiera się wewnątrz Music/Movies z okruszkami
  `Music > użytkownik > playlista` (dotąd `Moje konto → nazwa`, co wyglądało jak wejście w konto).
  Powrót do biblioteki przez okruszek `Music`; adres nadal nosi `?collection=<id>`.
- **Sortowanie playlisty działa i pasuje do treści**: kolejność playlisty (tylko listy ręczne),
  A–Z, Z–A, moja ocena, średnia ocena, liczba odtworzeń, ostatnio dodane i losowo z ziarnem.
  Zniknęło „Losowo (foldery)” i „Największy rozmiar”, których `getCollection()` nie obsługiwał.
  Sortowanie liczy serwer dla **całej** playlisty, więc kolejka odtwarzania idzie za widokiem.
  Strzałki zmiany kolejności pokazują się tylko przy kolejności ręcznej.
- **Licznik pokazuje rozmiar playlisty**, nie długość załadowanego okna — 1953 pozycji przy stu
  wczytanych kartach zamiast rosnącego „100+”.
- **Własna miniatura playlisty**: upload z kadrowaniem 1:1 do 500×500 WebP, ten sam komponent
  co w edytorze tagów (wydzielony `cover-picker.ts`), prawo — właściciel listy. Bez własnej
  okładki karta losuje miniatury z utworów playlisty, dokładnie jak karta folderu. Adres
  miniatury niesie znacznik wersji, więc podmieniona okładka nie zostaje w cache przeglądarki.
- **Przyciski**: „Przeglądaj z otwartą playlistą” usunięte; „Pobierz playlistę” pakuje całą listę
  do jednego ZIP-a (dotąd przycisk był w trybie playlisty ukryty); „Odtwórz playlistę” ma jedną
  etykietę — nachodzące napisy brały się z `querySelector("span")`, które trafiało w pudełko
  ikony, nie w podpis. Przycisk odtwarzania na karcie playlisty odtwarza, a nie tylko otwiera.
  Wyszukiwarka biblioteki chowa się w widoku playlisty, bo nie miała czego przeszukiwać.
- **Poprawka przy okazji**: lista inteligentna z regułą oceny zawężoną do jednego źródła
  („tylko moja ocena” albo „tylko średnia społeczności”) kończyła się błędem 500 — zapytanie
  dostawało parametry, których nie zawierało. Teraz wiążemy tylko te, które są w SQL.
- **Schemat**: `user_collection_artwork` (024) trzyma okładkę osobno od `user_collections`, żeby
  BLOB nie wędrował przez każde listowanie kolekcji; `025` zamienia `RESTRICT` na `SET NULL`
  przy `updated_by`, bo inaczej okładka blokowałaby usunięcie konta, które ją wgrało.
- E2E na koncie tymczasowym (40 sprawdzeń: sortowania, stronicowanie, licznik, kolejność ręczna,
  ZIP, okładka, listy inteligentne, dostęp do cudzej listy prywatnej) — konto, grupa i listy
  testowe usunięte po sobie. Bramka `scripts/check.py`: 8/8.

## 16.08.2026 (wieczór) — dock i kolejka po uwagach z testów

- **Odtwarzacz**: domyślnie rozwinięty na komputerze, zwinięty na telefonie (zapamiętany wybór
  ma pierwszeństwo). Pasek postępu **zostaje widoczny również po zwinięciu** — chowa się tylko
  klaster dodatkowych przycisków i linia techniczna. Przycisk zwijania jest ledwie widocznym
  duchem w spoczynku, pełną widoczność zyskuje po najechaniu, dotknięciu lub fokusie i wraca do
  spoczynku po ~3 s (bez tooltipa).
- **Kolejka — wyrównanie**: serce, gwiazdka, ocena i czas leżą w jednej linii (mierzone: te same
  środki w pionie), a gwiazdka nie zlewa się już z liczbą (odstęp ~5 px). Przyczyną był glif
  Font Awesome szerszy od pudełka ikony.
- **Kolejka — długie tytuły**: tytuł lub wykonawca, który się nie mieści, przewija się płynnie
  przy najechaniu/fokusie i wraca; przewijana jest dokładnie ta linia, która wystaje, o tyle,
  ile brakuje (`prefers-reduced-motion` wyłącza animację).
- **Kolejka — aktualizacja na bieżąco**: ocena, ulubione i zapisane tagi widać natychmiast w
  otwartej kolejce i w docku — jedna ścieżka `applyItemUpdate()` aktualizuje wszystkie kopie
  utworu i przerysowuje wiersz (dotąd trzeba było przebudować kolejkę z serwera).

## 16.08.2026 — kolejka, preferencje konta, dokumentacja po angielsku

- **Numeracja w kolejce** nie skleja się już z tytułem: kolumna dopasowuje szerokość do pozycji
  (pięciocyfrowe numery w bibliotece na 12 tys. utworów mieściły się w sztywnych 2 rem).
- **Serce i ocena w kolejce** — wiersz pokazuje znacznik ulubionych i ocenę (własną albo średnią);
  wybór należy do konta, więc obowiązuje na każdym urządzeniu. Ustawienie w „Moje konto →
  Kolejka odtwarzania”; preferencje trzyma nowa kolumna `users.preferences_json` (migracja 023).
- **Losowanie po odświeżeniu strony** działa znów na całej bibliotece: przywrócona sesja miała
  okno utworów, ale nie miała loaderów, więc losowała tylko w tym oknie. Kolejka zapamiętuje
  źródło (folder/kolekcja, tryb i ziarno losowania), a strona odtwarza z niego loadery przy
  wejściu — zweryfikowane skokami na pozycje 6757, 5464 i 11255 z 12 807 po przeładowaniu.
- **Przycisk zwijania odtwarzacza** pojawia się dopiero po najechaniu, dotknięciu lub fokusie i
  jest domyślnie tylko na telefonie; nowe ustawienie „Pozwól zwijać odtwarzacz także na
  komputerze” w panelu (Bezpieczeństwo → Odtwarzacz) włącza go na dużym ekranie. Bez tooltipa.
- **Statystyki kolekcji bez N+1** — listy ręczne liczone jednym zapytaniem zbiorczym zamiast
  jednego na listę (listy regułowe nadal mają własne, bo każda ma inny filtr); wyniki porównane
  z surowym SQL co do jednego.
- **Pliki publiczne po angielsku**: `README.md`, `SECURITY.md`, `NOTICE.md`, `docs/GIT.md`.
  Dokumenty robocze (roadmapa, changelog, instalacje) zostają po polsku, interfejs również.

## 15.08.2026 (noc) — poprawki zgłoszone po testach

Backup: `C:\wamp64\backups\media-server-20260815-pre-fixes`. Migracje `021`, `022` zastosowane.

- **Historia kolejki przy losowaniu**: „wstecz” wracało do przypadkowego sąsiada, bo losowy skok
  podmienia całe okno kolejki, a historia trzymała same identyfikatory. Wpisy mają teraz pozycję
  absolutną, pokolenie kolejki i sam utwór, więc wracają dokładnie tam, gdzie było — także po
  zmianie trybu losowania. Dodatkowo „dalej” po cofnięciu retransmituje tę samą ścieżkę, zanim
  znów zacznie losować; wpis znika z historii dopiero po udanym przejściu.
- **Dock na telefonie**: suwak głośności wrócił (zwężony), doszedł przycisk zwiń/rozwiń w prawym
  górnym rogu z płynną animacją (stan zapamiętany), a pasek narzędzi wizualizacji jest wyśrodkowany.
- **Esc w panelach odtwarzacza**: obsługa klawisza była po strażniku „ignoruj gdy fokus na
  przycisku”, więc po otwarciu panelu nic nie zamykało; teraz Esc działa zawsze (w pełnym ekranie
  najpierw z niego wychodzi).
- **Wizualizatory**: wycofane z projektu (kod i lista) — zostały Vortex i Particle Spectrum,
  włączone migracją; usunięte identyfikatory czyszczone są z zapisanych ustawień.
- **Panel admina**: odświeżanie działa per sekcja (zapis konta aktualizuje kartę w miejscu,
  potwierdzenie nie znika), karta grupy ma czytelny układ — prawa w trzech tematycznych zestawach
  i limity w osobnym wierszu.

## 15.08.2026 (wieczór) — grupy uprawnień, limity pobierania, poprawki UI, zaległości

Backup przed serią: `C:\wamp64\backups\media-server-20260815-pre-m6b` + `…-pre-migration-020.sql`.
Migracja `020_group_scopes_and_download_windows.sql` zastosowana na stagingu (jako konto
administracyjne bazy — użytkownik aplikacji ma tylko DML).

**Grupy uprawnień i limity**

- Nowe prawa grupy: dostęp do muzyki, dostęp do filmów, tryb zgodny wideo (transkodowanie),
  edycja tagów i okładek. Egzekwowane w moście (przeglądanie, kolejka, kolekcje, wpisy konta,
  bilety transferowe wg rodzaju źródła) i w interfejsie (nawigacja, przyciski, edytor).
- Limit pobrań ma **konfigurowalne okno w minutach** (grupa i limit globalny osobno; oba muszą
  przejść), a rezerwacja jest **atomowa** (`SELECT … FOR UPDATE` na wierszu konta) — zamyka
  odłożone TOCTOU. Nowy limit **równoczesnych pobrań** per konto: claim `max_downloads` w tokenie
  egzekwowany przez serwis Python (rejestr aktywnych transferów; inline nie liczy się) → `429`.
- **Gość = grupa**: checkbox „konto gościa” zniknął; `users.is_guest` lustruje członkostwo w
  systemowej grupie „Goście”, formularz tworzenia konta ma wybór grupy, administrator nie może
  należeć do grupy gości, samodzielna rejestracja od razu trafia do grupy „Użytkownicy”.
- Panel: matryca uprawnień w „Bibliotece” usunięta (duplikowała „Grupy”); karta grupy z
  sekcjami Biblioteki/Działania/Społeczność i czterema limitami; „Bezpieczeństwo” ma limit +
  okno; komunikaty błędów z mostu (403/404/422/429) są pokazywane użytkownikowi.
- Schemat: `download_limit_per_hour` → `download_limit` + `download_window_minutes`,
  `max_concurrent_downloads`; ustawienia `download_rate_limit` + `download_rate_window_minutes`;
  usunięte martwe `role_permissions` i `user_sessions` oraz zdublowany indeks `users_email_unique`.

**Interfejs**

- Edytor tagów działa po miękkiej nawigacji (jeden edytor współdzielony w powłoce, przycisk
  w docku widoczny tylko z uprawnieniem); Esc zamyka podgląd (także po wyjściu z pełnego
  ekranu); wszystkie dialogi mają pułapkę fokusu (`inert` na tle, powrót fokusu, Esc).
- Panel admina na telefonie ma menu sekcji (ikony), „Stan katalogu” ma odstęp od kart, akcje
  „Skanuj teraz” przeniesione z Przeglądu do Indeksowania (napisy były już w swojej sekcji).
- Dock na wąskich ekranach pokazuje wizualizację, kolejkę, ulubione, pobieranie i edycję (znika
  tylko suwak głośności, na telefonie także gwiazdki); kliknięcie w szczegóły utworu restartuje
  automatyczną rotację; losowy skok w kolejce przewija płynnie do wybranego utworu z podświetleniem.
- Sortowanie „Losowo (foldery)” w Music/Movies i w ustawieniach domyślnych: stabilne przy
  stronicowaniu (ziarno), przycisk ponownego losowania, „Wszystkie utwory” zawsze pierwsze,
  pliki w folderze wg tytułu.
- 9 wizualizatorów dostępnych dotąd tylko w bundlu jest w domyślnej kolejności (w istniejących
  instalacjach wyłączone — do włączenia w panelu).

**Zaległości techniczne**

- Wspólny `permissions.ts` (jedna definicja administratora i `can()`), wspólny `clipboard.ts`,
  martwe `reorderCollection`/`FileTransfer.token` usunięte, `api.ts` czyta treść błędu,
  CLI `token … --max-streams/--max-downloads`, `/v1/catalog-scan` przyjmuje `batch_size`
  i `metadata`, jedna polityka haseł (12 znaków) i nazw użytkownika dla rejestracji, konta
  i panelu, `windowObserver` sprzątany przy zmianie strony.
- Licencja MIT (`LICENSE`, `NOTICE.md`, metadane w `pyproject.toml`/`package.json`).

## 15.08.2026 — M6 (część 1): CI, locki, bramka jakości, poprawki z przeglądu

Backup przed serią: `C:\wamp64\backups\media-server-20260815-pre-m6` + `…-pre-m6.sql`.

**Utwardzenie wydania**

- `.github/workflows/ci.yml`: backend (ubuntu/windows × Python 3.11/3.13, PHP 8.3), frontend
  (Node 22/24), dry-run instalatora, audyt zależności (`pip-audit`, `npm audit`, także
  tygodniowo), skan sekretów gitleaks.
- `scripts/check.py`: lokalna bramka o tej samej treści (ruff, pytest, `php -l`, `tsc`, build do
  katalogu tymczasowego, testy node, `pip check`, skan sekretów porównujący pliki z wartościami
  z `config.local.toml`; `--audit`, `--only`, `--strict`).
- Uniwersalne locki z hashami `requirements.lock` / `requirements-dev.lock` (`uv pip compile
  --universal --generate-hashes`, wraz z backendem budowania), generator `scripts/lock-deps.py`;
  instalator instaluje `--require-hashes` + `--no-deps --no-build-isolation -e .`, `--no-lock`
  tylko jawnie, brak locka jest błędem.
- `cryptography` podniesione z 46.0.7 do 50.0.0 (pin `>=48.0.1,<51`) — 4 ogłoszone podatności,
  audyt zależności czysty; `starlette` 1.6.0, `uvicorn` 0.52.3, `ruff` 0.16.3.
- `pytest` działa także bez `python -m` (`pythonpath = ["."]`); nowe testy configu Pythona.

**Przygotowanie relokacji poza `DocumentRoot`**

- Ścieżki wewnątrz drzewa projektu (`thumbnails.cache_path`, `stereo.subtitle_cache_path`,
  `stereo.ffmpeg_path`, `mail.spool_path`) mogą być względne — Python i PHP rozwiązują je względem
  katalogu projektu; instalator zapisuje je względnie; żywy config przełączony na `runtime/...`.
- Szablon `media-next-stage-wamp.conf.example` ma jedną linię `Define TRYHACKX_MEDIA_ROOT`.
- Instalator uruchomiony ponownie przy istniejącym configu nie wymaga hasła ani katalogów mediów.
- Jednostka systemd: `ReadWritePaths=/opt/tryhackx-media-server/runtime` (przy
  `ProtectSystem=strict` cache miniatur/napisów nie dało się zapisać).
- Procedura krok po kroku w `docs/INSTALL-WINDOWS.md`.

**Poprawki z przeglądu kodu (trzy warstwy)**

- Most PHP: `BridgeConfigLoader` parsuje TOML własnym parserem podzbioru zamiast
  `parse_ini_file` (komentarz z nawiasem w `config.example.toml` dawał HTTP 500, komentarz w linii
  psuł wartość klucza/hasła); wynik jest identyczny z `tomllib` (test parytetu). Domyślne
  `mail.*`/`app.*` obowiązują dla obu formatów configu (config `.php` bez `mail` kończył się 500
  przy rejestracji). Konto utworzone ręcznie z panelu dostaje `email_verified_at`, więc może się
  zalogować bez drugiego kroku aktywacji.
- Frontend: nieudane `mount()` strony nie unieruchamia już routera (łańcuch nawigacji z `catch`),
  odrzucona sesja nie jest buforowana na stałe, handler zmiany trybu kolejki jest czyszczony przy
  przejściu Music→Movies.
- Apache: osobna CSP dla `/media-next/login/` dopuszczająca skrypty i ramki reCAPTCHA/hCaptcha/
  Turnstile (globalne `script-src 'self'` blokowało każdego dostawcę — włączenie CAPTCHA
  zablokowałoby logowanie); `media-src blob:` także w szablonie produkcyjnym (napisy).
- `config.example.toml` dokumentuje sekcje `[mail]` i `[app]` mostu PHP; usunięte martwe
  odwołanie do `docs/M4-REPORT.md`; poprawione opisy migracji i katalogowania obrazów.

## 14.08.2026 — M5.6 Audyt i utwardzenie

Wieloagentowy audyt (34 agenty, weryfikacja adwersarialna): 29 potwierdzonych znalezisk,
naprawiono i zweryfikowano E2E 24, 5 świadomie odłożono (lista w `ROADMAP.md`).

- Eskalacja admin→super_admin przez `registration_default_role` — zablokowana.
- Przejęcie konta innego administratora przez `updateUser` — zablokowane (sprawdzana rola celu).
- Dryf egzekwowania uprawnień — `assertPermission` czyta prawa z `permission_groups`.
- Bypass limitu strumieni przez pominięcie `stream_id` — zamknięty (`422`), rejestr per subject.
- Wyciek tokenów do logów (miniatury, `stereo-keyframe`) — trasy sanityzowane.
- Klucz internal-API wyprowadzony z klucza transferowego, spójnie PHP↔Python.
- Sekret CAPTCHA nie trafia do `audit_log`; zmiana e-maila ma limit prób.
- Nieograniczone bufory: cache napisów z budżetem bajtowym, rejestr strumieni sprzątany,
  chunked body `POST /v1/archives` czytane przyrostowo, snapshoty DOM jako LRU.
- Wydajność: indeks `(root_id, relative_path(191))`, uproszczone ratingi folderów, memoizacja
  ustawień i istnienia tabel.
- UX: RWD panelu, pobranie folderu odpięte od prawa udostępniania, kolejka po zmianie shuffle
  zachowuje kontekst, obsługa `429` w podglądach i pobieraniu.

## 13.08.2026 — M5 Konta i uprawnienia

- Samodzielne uwierzytelnianie: logowanie, rejestracja z aktywacją mailową, ponowna wysyłka,
  ochrona antybotowa (reCAPTCHA/hCaptcha/Turnstile), throttling — bez legacy `index.php`.
- Grupy uprawnień: siedem flag i dwa limity egzekwowane end-to-end (godzinowy limit pobrań per
  grupa/globalny → `429`; limit równoczesnych strumieni trybu zgodnego z claima tokenu).
- Kolejka kont oczekujących w panelu z ręczną aktywacją i ponowną wysyłką linku.
- Konto: samoobsługowa zmiana hasła i e-maila z potwierdzeniem; edycja kolekcji i kolejności
  pozycji (zamiana sąsiadów O(1)).

## Wcześniej — M1–M4

Fundament (Python/FastAPI, Range, ZIP64 stream, tokeny AES-GCM, instalator), jedna baza
`media_server_stage`, wspólny portal TypeScript/Vite z mostem sesji PHP, stabilność i UX
(duże transfery, tryb zgodny wideo, napisy, wizualizacje, metadane). Szczegóły w `README.md`.
