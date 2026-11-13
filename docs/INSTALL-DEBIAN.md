# Instalacja i aktualizacja na Debianie 13

Natywnie: Python, Apache i systemd. Docker nie jest potrzebny i nie jest wspierany.
Układ jest zawsze ten sam — jeden katalog na wersję i dowiązanie `current`, które przełącza
się dopiero po udanym smoke teście — a dojść do niego można dwiema drogami:

- **instalatorem** (`zainstaluj-debian.sh`): pyta o kilka rzeczy, pokazuje listę wszystkich zmian
  i dopiero po zatwierdzeniu je wprowadza — sekcja niżej;
- **ręcznie**: te same kroki wykonywane poleceniami, dla kogoś, kto chce wiedzieć, co instalator
  robi, albo woli zrobić to sam — od „Instalacja ręczna”.

Instalacja robocza na własnym koncie (bez systemd, bez `/opt`) to `scripts/install-debian.sh`.

## Instalacja instalatorem (zalecana)

Od wersji z 12.11.2026 instalację od zera robi **instalator**: odpowiednik kreatora z Windows
(`Zainstaluj.cmd`), tyle że w terminalu. Sprawdza komputer, pyta o sposób dostępu, foldery
z mediami i konto administratora, pokazuje każdą zmianę, którą wprowadzi, i dopiero po
zatwierdzeniu instaluje pakiety, zakłada bazę, usługę systemd, stronę w Apache i reguły zapory.

**Czego instalator nie robi:** nie ustawia rekordu DNS ani przekierowania portu na routerze (podaje
do tego dokładne wartości), nie dotyka plików z mediami i — przy odinstalowaniu — nie usuwa
pakietów Debiana.

### Zanim zaczniesz

1. **Debian 13** z dostępem do roota (`sudo`), internetem (pakiety z `apt`, zależności Pythona
   z PyPI) i systemd. Na innym wydaniu instalator ostrzega i pyta, czy iść dalej. Debian
   zainstalowany z hasłem roota nie ma `sudo`: wtedy `su -` (z myślnikiem — pełne środowisko
   roota) i `bash zainstaluj-debian.sh`.
2. **Paczka wydania** `TryHackX-Media-Server-<wersja>-debian.tar.gz`, rozpakowana w całości.
   Zawiera gotowy interfejs — Node.js nie jest potrzebny. Klon repozytorium też wystarczy
   (`sudo apt install git`, `git clone https://github.com/TryHackX/media-server.git`): instalator
   zapyta wtedy o zgodę na doinstalowanie Node.js i npm z pakietów Debiana i zbuduje interfejs
   w katalogu wydania — przy każdej instalacji i aktualizacji, więc po `git pull` wchodzi interfejs
   pobranego kodu. Paczki, których repozytorium nie ma (presety AVS i MilkDropa, tekstury, shadery,
   Font Awesome Pro — `FRONTEND.md`), są w prywatnym repozytorium
   [media-server-vendor](https://github.com/TryHackX/media-server-vendor) (dostęp tylko dla kont,
   którym je udostępniono). Klonujesz je przed instalacją:
   `git clone https://github.com/TryHackX/media-server-vendor.git frontend/vendor` — GitHub zapyta
   o nazwę użytkownika i zamiast hasła o token (*fine-grained personal access token* tylko do tego
   repozytorium, *Contents: Read-only*). Pytanie o budowanie wymienia paczki z nazwy, a zbudowany
   interfejs je ma. Aktualizacja z klonów: `git pull`, `git -C frontend/vendor pull`, potem
   `sudo bash zainstaluj-debian.sh --zmien aktualizacja`.
3. **Foldery z mediami poza `/home` i `/root`** (np. `/srv/media/...`), czytelne dla konta
   `www-data`. Usługa działa z `ProtectHome=true` i tych katalogów po prostu nie widzi —
   instalator odmawia takiej ścieżki od razu, zamiast pozwolić na serwer, który „działa”
   i zgłasza 503.
4. Dla wersji **S**: domena, której rekord DNS wskazuje na ten serwer, oraz porty 80 i 443
   osiągalne z internetu. Dla wersji **P**: domena, wynajęty VPS z Debianem albo Ubuntu
   i możliwość przekierowania portu 443 na domowym routerze.

### Uruchomienie

```bash
tar xzf TryHackX-Media-Server-X.Y.Z-debian.tar.gz
cd TryHackX-Media-Server-X.Y.Z
sudo bash zainstaluj-debian.sh
```

| Polecenie | Co robi |
|---|---|
| `sudo bash zainstaluj-debian.sh` | instalacja z pytaniami; gdy serwer już jest — menu zmian |
| `… --lang en` | to samo po angielsku |
| `bash zainstaluj-debian.sh --dry-run` | **tryb próbny**: cała ścieżka, ale każde polecenie i każdy plik są tylko wypisane (z treścią); nie wymaga roota — tyle że bez niego nie widzi stanu zapory, właścicieli portów ani portów SSH, więc jego plan może się różnić od prawdziwego (w bezpieczną stronę); z `sudo` widzi wszystko i nadal niczego nie zmienia |
| `sudo bash zainstaluj-debian.sh --answers plik.toml` | bez pytań: odpowiedzi z pliku (niżej: „Bez pytań”) |
| `sudo bash zainstaluj-debian.sh --zmien [co]` | zmiana istniejącej instalacji: `foldery`, `dostep`, `admin`, `aktualizacja`, `migracje`, `vps` |
| `sudo bash zainstaluj-debian.sh --odnow` | wymiana certyfikatu serwera domowego bez przerwy (wersja P) |
| `sudo bash zainstaluj-debian.sh --odinstaluj` | usunięcie tego, co instalator założył |
| `sudo bash zainstaluj-debian.sh --status` | co jest zainstalowane |

Pytania zadaje w oknach `whiptail`; na terminalu bez niego (albo z `--plain`) — zwykłymi
pytaniami w konsoli. Zapis przebiegu trafia do `/var/log/tryhackx-media-setup-<data>.log`
(hasła zastąpione gwiazdkami).

### Dwie wersje i dwa małe kształty

To kształty B, A, D i C z `PUBLIC-EXPOSURE.md`.

| | Apache | Prywatna konfiguracja | Zapora (`ufw`) | Certyfikat |
|---|---|---|---|---|
| **S — samodzielny, publiczny**: ten komputer ma publiczny adres i własną domenę | `tryhackx-media.conf` (port 80: wyzwanie Let's Encrypt i przekierowanie) + `tryhackx-media-ssl.conf` (443: aplikacja, HSTS); `Require all granted` | `[app] base_url = "https://domena/"` | SSH, 80 i 443 otwarte | Let's Encrypt przez `certbot` (http-01, odnawia się sam); albo własne pliki; albo tymczasowy, podpisany przez serwer |
| **P — prywatny dom + publiczny VPS**: adres domowy zostaje ukryty | tylko `tryhackx-media-ssl.conf`, neutralne `ServerName`, `Require local` + adres VPS | `base_url` jak wyżej, `[proxy] trusted = "<adres VPS>"` | z internetu 443 **tylko z adresu VPS**; sieć domowa dochodzi do komputera jak przedtem | własny certyfikat serwera domowego (EC P-256, `CN=origin`, 10 lat), przypięty na VPS-ie; Let's Encrypt zdobywa VPS |
| **D — tylko sieć domowa** | `tryhackx-media.conf` (port 80), `Require local` + adresy prywatne; domyślna strona Debiana `000-default` wyłączona | `[session] require_https = false` | tylko sieć domowa: port 80, a gdy zaporę włącza dopiero instalator — cała sieć domowa, jak przedtem (niżej: „Zapora”) | brak — hasła lecą po sieci tekstem |
| **C — tylko ten komputer** | `tryhackx-media.conf` (port 80), `Require local` | bez `[app]`, `[proxy]`, `[session]` | instalator jej nie dotyka | brak |

Strony Apache powstają z przykładów projektu (`deploy/apache/media-next.conf.example`
i `media-transfer.conf.example`): te same aliasy, nagłówki i zamknięte trasy wewnętrzne, inne są
tylko reguły dostępu i port usługi. Gdy przykład zmieni się w sposób, którego generator nie
rozumie, plik nie powstaje wcale — zamiast powstać w połowie.

W wersji S port 80 **nie** serwuje aplikacji: odpowiada na wyzwanie Let's Encrypt
(`/.well-known/acme-challenge/`) i przekierowuje resztę na HTTPS. Dzięki temu certyfikat
odnawia się także wtedy, gdy host 443 już działa.

### O co pyta

- **Sposób dostępu** — jedna z czterech pozycji wyżej, potem tylko to, czego ona potrzebuje:
  domena; dla S skąd certyfikat (i zgoda na regulamin Let's Encrypt — bez niej instalator nie
  uruchomi certbota w Twoim imieniu) oraz czy doinstalować fail2ban; dla P adres VPS, publiczny
  adres łącza domowego (albo nazwa z dynamicznego DNS), czy sieć domowa ma mieć dostęp wprost,
  i jak skonfigurować VPS (przez SSH teraz albo ręcznie).
- **Foldery z mediami** — ścieżka i rodzaj (Muzyka / Filmy / Mieszane); co najmniej jeden.
  Identyfikator powstaje z nazwy folderu (`/srv/media/Filmy Video` → `filmy_video`).
- **Konto administratora** — nazwa, e-mail (opcjonalny), hasło dwa razy (co najmniej 12 znaków).
- **Zapora** — czy instalator ma ją ustawić (niżej).

O bazę nie pyta: zakłada `media_server` z kontami `media_server` i `media_server_ddl` (inne nazwy
można podać w pliku odpowiedzi). Każda odpowiedź jest sprawdzana od razu — tym samym kodem,
który sprawdza plik odpowiedzi — a przed pierwszą zmianą instalator pokazuje pełną listę tego,
co zrobi, i czeka na „tak”.

### Co zmienia na komputerze

W tej kolejności; każdy krok można powtórzyć.

1. **Pakiety** — tylko brakujące: `python3 python3-venv apache2 libapache2-mod-php php-cli
   php-mysql php-mbstring php-curl php-xml mariadb-server mariadb-client ffmpeg curl openssl
   ca-certificates`, do tego `ufw` (gdy ustawia zaporę), `certbot` (S z Let's Encrypt), `fail2ban`
   (S, na życzenie), `openssh-client` (P). Lista wynika z kodu: `mb_*`, `curl_*`, SimpleXML i PDO
   w moście, `/usr/bin/php` w jednostce przeglądu nowości. Po instalacji sprawdza, czy PHP ma
   wszystkie pięć rozszerzeń, bez których most wywala się na pierwszym żądaniu.
   **Apache, który oddaje PHP do PHP-FPM** (`conf-enabled/php8.x-fpm.conf`, bez modułu PHP), zostaje
   przy tym: zamiast `libapache2-mod-php` i `php-*` instalator bierze `php8.x-cli`, `php8.x-mysql`,
   `php8.x-mbstring`, `php8.x-curl`, `php8.x-xml` tej samej wersji i przeładowuje `php8.x-fpm`, gdy
   coś doinstalował. `libapache2-mod-php` przełącza Apache'a Debiana na prefork, co zmieniłoby
   działanie wszystkich innych stron tego serwera.
2. **Moduły Apache** — `a2enmod` dla tych z listy przykładu, które nie są włączone
   (`proxy`, `proxy_http`, `headers`, a dla S i P także `ssl`; przy PHP-FPM także `proxy_fcgi`
   i `setenvif`: bez nich Apache wysłałby źródło mostu zamiast je wykonać).
3. **Prywatna konfiguracja** — `scripts/install.py --config-only` zapisuje
   `/etc/tryhackx-media-server/config.local.toml` (`root:www-data`, `0640`) z wylosowanym kluczem
   i hasłem bazy; hasło trafia do `install.py` w jego środowisku, nigdy w wierszu poleceń. Obok
   powstaje `config.migrate.toml` (`0600`, tylko root) — ten sam plik z kontem do migracji.
4. **Baza** — przez lokalne gniazdo, jako root systemu (tak loguje się root MariaDB na Debianie;
   żadne hasło nie jest potrzebne): `CREATE DATABASE`, konto aplikacji z samym DML
   (`SELECT, INSERT, UPDATE, DELETE`) i osobne konto `…_ddl` z pełnymi prawami **do tej jednej
   bazy** — oba dla `localhost` i `127.0.0.1`. Hasła czyta z obu plików konfiguracji pomocnik
   w Pythonie i zapisuje polecenia do pliku `0600`, który idzie na standardowe wejście klienta:
   przez powłokę nie przechodzi żadne hasło.
5. **Wydanie** — `scripts/release-debian.sh --migrate --migrate-config …`: kopia drzewa do
   `/opt/tryhackx-media-server/releases/…`, `.venv` z locka z sumami kontrolnymi, `media-server
   check`, migracje kontem `…_ddl`, przełączenie `current`. Z klona: także `npm ci` i build
   interfejsu w wydaniu, a po nim usunięcie z wydania `frontend/node_modules` i `frontend/vendor`
   (potrzebne tylko do budowania; w każdym z trzech trzymanych wydań ważyłyby kilka GB). Bez
   budowania (paczka wydania) folder `frontend/` w ogóle nie trafia do wydania.
6. **Usługa** — pięć jednostek z `deploy/systemd/` w `/etc/systemd/system/`, start
   `tryhackx-media-transfer` i czekanie na `health/ready` (to tu wychodzi folder, którego usługa
   nie może czytać).
7. **Rodzaje folderów** — `media-server roots sync --kind …`: bez skanowania.
8. **Konto administratora** — `account-create --password-stdin` jako `www-data`.
9. **Certyfikat** — własny (P, albo tymczasowy w S) z krótkiego pliku żądania, jako certyfikat
   **serwera**: `basicConstraints = critical, CA:FALSE`, `extendedKeyUsage = serverAuth`.
   Certyfikatu urzędu (`CA:TRUE`, który dałoby samo `openssl req -x509`) Firefox nie przepuszcza
   w ogóle. `keyUsage` celowo nie ma — tak samo jak w kreatorze Windows: OpenSSL starszy niż
   1.1.1h (starsze Ubuntu na VPS-ie) nie przyjmuje certyfikatu podpisanego samodzielnie, którego
   `keyUsage` nie zawiera `keyCertSign`, jako zaufanego — a VPS ufa właśnie temu jednemu plikowi.
10. **Zapora** — przed Apache, żeby Let's Encrypt miał jak dojść do portu 80.
11. **Apache** — strony w `sites-available`, `a2ensite`, **`apache2ctl configtest`**, przeładowanie.
    W wersji S z Let's Encrypt najpierw sam port 80, potem `certbot certonly --webroot`,
    dopiero potem host 443 (Apache ze wskazanym, a nieistniejącym certyfikatem nie wstaje).
    Gdy test składni nie przejdzie, pliki wracają do poprzedniej postaci, **zanim** cokolwiek
    zostanie przeładowane.
12. **fail2ban** (S, na życzenie) — filtr i jail z `deploy/fail2ban/`.
13. **Zadania okresowe** — oba timery, a pierwsze indeksowanie rusza w tle
    (`systemctl start --no-block tryhackx-media-maintenance`): instalator na nie nie czeka.
14. **Paczka dla VPS** (P) — `/etc/tryhackx-media-server/vps-bundle/` (niżej).
15. **Zapis stanu** — `/etc/tryhackx-media-server/installer.json`: co instalator ustawił,
    bez haseł. Po nim poznaje instalację i wie, co cofnąć.
16. **Sprawdzenie** — `health/ready`, strona, most (`?action=auth_state`) i to, że
    `/media-transfer/health/ready` odpowiada **403**.

**Każdy plik systemowy, który instalator zapisuje, ma w pierwszej linii
`# TRYHACKX-MEDIA-SERVER-MANAGED v1`** (jednostki, strony Apache, filtr i jail, hak odnowienia
certyfikatu, `config.migrate.toml`). Pliku bez tej linii — założonego ręcznie — instalator nie
usuwa. Kopia każdego zastąpionego pliku zostaje w `/var/backups/tryhackx-media-server/<data>/`.

### Zapora

`ufw enable` zamienia „wszystko otwarte” na „wszystko zamknięte”, więc instalator rozdziela dwie
sprawy:

- **reguły serwera** — porty danej wersji, tak wąsko, jak ona pozwala (tabela wyżej);
- **reguły, dzięki którym komputer zostaje osiągalny**, gdy to instalator włącza zaporę: serwer
  publiczny zachowuje SSH (na porcie, na którym naprawdę działa), serwer domowy — całą sieć
  domową (`ufw allow from 192.168.1.0/24`: udziały plików, SSH i reszta działają jak przedtem),
  a do tego adres, z którego przyszła bieżąca sesja SSH, jeśli leży poza tą siecią.

Zapora, która **była już włączona**, jest czyjąś decyzją: instalator dopisuje do niej wyłącznie
reguły serwera. **Inna zapora** — `firewalld` albo własny zestaw reguł nftables (tabele z regułami
albo z polityką `drop`) — zostaje zupełnie nietknięta: instalator nie instaluje wtedy `ufw`, nie
dodaje reguł i nie pyta o zaporę, a plan wypisuje porty, które trzeba w niej otworzyć. `ufw` na
takiej zaporze byłby drugim „odrzuć resztę”, przez który musi przejść każdy pakiet, i przestałyby
odpowiadać usługi, które tamta zapora wpuszcza. Za zaporę nie uchodzą: domyślny
`/etc/nftables.conf` Debiana (puste łańcuchy, polityka `accept`) i tabela `f2b-table` fail2bana. Reguły serwera mają komentarz `tryhackx-media`, reguły dostępu
`tryhackx-media-reach`; ich lista trafia do zapisu stanu **w chwili dodania** (przerwany przebieg
też o nich wie). Odinstalowanie usuwa reguły serwera, a reguły dostępu tylko razem z zaporą:
gdy instalator ją włączył, domyślnie proponuje ją wyłączyć; zostawiona zostaje z regułami
dostępu — bez nich po wylogowaniu nikt by się nie połączył. Kto zarządza zaporą inaczej,
odpowiada „nie” (albo `[firewall] manage = false`) i ustawia reguły z tabeli sam.

Czego reguły dostępu nie obejmą — plan to mówi, zanim cokolwiek się zmieni:

- **SSH spoza sieci domowej** (wersje P i D) zostaje otwarte tylko dla adresu bieżącej sesji;
  kolejna zmiana dostępu przepisuje regułę na adres, z którego zostanie uruchomiona. Gdy terminal
  nie podaje adresu (konsola, `tmux`, `mosh`), dostęp zostaje tylko z sieci domowej. Uruchomiony
  bez terminala (`ssh serwer 'sudo bash zainstaluj-debian.sh --answers …'`) instalator nie zna
  adresu sesji — `sudo` gubi `SSH_CONNECTION`, a `who am i` nie ma terminala — więc regułę SSH
  dostają wszystkie adresy połączone w tej chwili przez SSH (plan je wymienia).
- **Globalne adresy IPv6 sieci domowej** nie są uznawane za sieć domową (tylko prywatne zakresy,
  z IPv6 `fc00::/7`); urządzenia łączące się po IPv6 publicznym potrzebują własnej reguły.
- **Inne usługi** tego komputera (TCP i UDP, np. WireGuard) plan wymienia we wszystkich wersjach:
  w S przestają być osiągalne, w P i D z zaufaną siecią domową zostają osiągalne tylko z niej.
  Żeby zostały otwarte, dopisuje się je w `[firewall] extra_ports` (np. `"51820/udp"`). Klienta
  DHCP (porty 68 i 546 UDP) plan pomija — odpowiedzi serwera DHCP `ufw` wpuszcza sam.

### Wersja P: VPS

Po stronie domowej instalator robi wszystko sam, a dla VPS-a zostawia folder
`/etc/tryhackx-media-server/vps-bundle/`:

| Plik | Do czego |
|---|---|
| `vps-setup.sh` | **jeden skrypt, który ustawia VPS** — niżej |
| `INSTRUKCJA-VPS.md`, `VPS-GUIDE.md` | to samo krok po kroku, z prawdziwymi wartościami, plus DNS i router |
| `tryhackx-media.conf`, `tryhackx-media-ssl.conf`, `origin.crt`, `maintenance.html` | pliki, które skrypt niesie w sobie — osobno do wglądu i dla kroków ręcznych |

Hosty, limity czasu, przypięty certyfikat i strona zastępcza są **te same, co w paczce
z kreatora Windows** — powstają z tych samych szablonów (`installer/templates/vps/`).

`vps-setup.sh` sprawdza system, doinstalowuje `apache2` i `certbot`, jeśli ich nie ma (tylko
brakujące: na VPS-ie z innymi stronami `apt-get install` zainstalowanego pakietu podniósłby jego
wersję i zrestartował Apache'a w trakcie skryptu), włącza moduły, zapisuje oba hosty
i certyfikat serwera domowego (porównując jego odcisk), uruchamia port 80, zdobywa certyfikat
Let's Encrypt, włącza host 443 i **wykonuje zapytanie przez proxy**. Można go uruchamiać
wielokrotnie. Gdy coś się nie uda — albo gdy strona działała przed zmianą, a po niej nie —
przywraca poprzednie pliki i dopiero wtedy kończy się błędem. Kod wyjścia `3` znaczy: VPS jest
gotowy, tylko dom jeszcze nie odpowiada (router, adres). `--dry-run` wypisuje kroki,
`--usun` zdejmuje konfigurację (tylko pliki ze znacznikiem).

Instalator proponuje uruchomić go za Ciebie:

- **przez SSH** — pokazuje odcisk klucza VPS-a do potwierdzenia (i ufa potem wyłącznie temu
  kluczowi: `StrictHostKeyChecking=yes` z własnym plikiem `vps_known_hosts`), wysyła skrypt
  i uruchamia go; o hasło pyta sam program `ssh` — instalator go nie widzi i nie zapisuje;
- **ręcznie** — wypisuje dwa polecenia z prawdziwymi wartościami:

  ```bash
  sudo scp /etc/tryhackx-media-server/vps-bundle/vps-setup.sh root@203.0.113.10:
  ssh -t root@203.0.113.10 'bash vps-setup.sh'
  ```

  (`sudo`, bo folder paczki należy do roota). Instalator ufa wyłącznie potwierdzonemu kluczowi
  ED25519 VPS-a. Gdy VPS zostanie postawiony od nowa, ma nowy klucz: stary usuwa
  `sudo ssh-keygen -R <adres> -f /etc/tryhackx-media-server/vps_known_hosts` (przy SSH na porcie
  innym niż 22 wpis nazywa się `'[adres]:port'`).

Na koniec podaje dwie rzeczy do zrobienia poza oboma komputerami, z dokładnymi wartościami:
**rekord DNS** (`A domena → adres VPS`, nie domu) i **przekierowanie portu** na routerze
(TCP 443 → adres tego komputera w sieci domowej, port 443; portu 80 dom nie potrzebuje wcale).

### Wymiana certyfikatu serwera domowego: `--odnow`

Certyfikat domu jest ważny dziesięć lat, ale bywa, że trzeba go wymienić wcześniej. Zwykła
wymiana oznacza przerwę: od chwili, gdy dom pokazuje nowy certyfikat, do chwili, gdy VPS zacznie
mu ufać. `--odnow` robi to bez przerwy:

1. powstaje nowy certyfikat (stary działa dalej) i nowa paczka dla VPS;
2. VPS zaczyna ufać **staremu i nowemu** (`vps-setup.sh --odnow-start`);
3. dom przełącza się na nowy (`configtest`, przeładowanie) i instalator sprawdza stronę
   **przez VPS** — nie przez domowy DNS;
4. VPS przestaje ufać staremu (`--odnow-koniec`).

Gdy krok 3 się nie uda, dom wraca do starego certyfikatu, któremu VPS ufał przez cały czas.

Oba certyfikaty nazywają się `CN=origin`, a OpenSSL szuka zaufanego certyfikatu najpierw po
nazwie. Dlatego certyfikaty z tego instalatora niosą identyfikator własnego klucza
(`authorityKeyIdentifier`): bez niego z dwóch certyfikatów o tej samej nazwie OpenSSL przyjmuje
tylko jeden — zmierzone na OpenSSL 3.5, który z dwóch, zależy od kolejności w pliku. Skrypt na
VPS-ie sprawdza tę parę swoim OpenSSL-em, **zanim** cokolwiek podmieni; para, która nie może
współistnieć, nie zmienia niczego.

### Zmiana ustawień i aktualizacja: `--zmien`

Uruchomiony ponownie (albo z `--zmien`) instalator pokazuje stan instalacji i menu:

- **`foldery`** — dodanie, usunięcie, zmiana rodzaju. Zmienia wyłącznie tabele `[roots.*]`
  w `config.local.toml` — reszta pliku zostaje co do znaku, a przed zapisem powstaje prywatna
  kopia `config.backup-<data>.local.toml` — potem restartuje usługę, zapisuje rodzaje i uruchamia
  indeksowanie w tle. Folder zdjęty z listy zostaje w katalogu **wyłączony**, nie skasowany.
  **To jedyne miejsce, w którym zmienia się foldery**: w panelu w przeglądarce są tylko do
  odczytu, celowo — skradziona sesja administratora nie może wystawić całego dysku.
- **`dostep`** — inna wersja, domena, adres VPS, certyfikat. Zmienia konfigurację, zaporę
  i strony Apache jako całość: gdy Apache odrzuci nową konfigurację, **wracają wszystkie trzy** —
  pół nowego kształtu jest gorsze od starego.
- **`admin`** — kolejne konto administratora; także wyjście awaryjne po zapomnianym haśle.
- **`aktualizacja`** — z katalogu nowej paczki albo z klona po `git pull` (wtedy także Node.js
  i npm z Debiana, jeśli ich brak, i interfejs zbudowany od nowa w nowym wydaniu): najpierw
  **pełna kopia bazy**
  (`mariadb-dump` jako root przez gniazdo, do `/var/backups/tryhackx-media-server/database/`,
  `0600`, pięć najnowszych), potem nowe wydanie (`release-debian.sh --migrate`, z automatycznym
  powrotem, gdy usługa nie odpowie), odświeżenie jednostek, a także stron Apache, plików fail2ban
  i haka odnawiania — każdego tylko wtedy, gdy nowa wersja zapisałaby go inaczej, z `configtest`
  i powrotem przy odmowie; pliki zmienione ręcznie (bez znacznika instalatora) zostają. W wersji P
  paczka dla VPS-a powstaje od nowa i instalator mówi, czy to, co działa na VPS-ie, się zmieniło.
- **`migracje`** — kopia bazy jak wyżej, potem same migracje na bieżącym wydaniu.
- **`vps`** — paczka dla VPS od nowa i wysłanie jej.

Instalację zrobioną ręcznie (bez `installer.json`) instalator rozpoznaje po
`/etc/tryhackx-media-server/config.local.toml`, a sposób dostępu odczytuje z niej. Niczego nie
zmienia, dopóki nie wybierzesz działania; konto do migracji zakłada przy pierwszej okazji.

### Odinstalowanie: `--odinstaluj`

Usuwa to, co instalator założył: jednostki systemd, własne strony Apache (strony systemu, które
wyłączył, wracają), swoje reguły zapory, filtr i jail fail2ban oraz katalog programu
`/opt/tryhackx-media-server`. Osobno pyta o:

- **dane serwera** (`/var/lib/…`, `/var/log/…`, kopie w `/var/backups/…`),
- **konfigurację z kluczami** (`/etc/tryhackx-media-server` — także certyfikat domu),
- **bazę** — tylko po wpisaniu jej nazwy.

**Plików z mediami nie dotyka nigdy.** Pakiety Debiana i włączone moduły Apache zostają (mogą
służyć czemuś jeszcze); instalator wypisuje, które doinstalował. Zapory, którą sam włączył, nie
wyłącza bez pytania.

### Bez pytań: plik odpowiedzi

`--answers plik.toml` (albo `.json`) zastępuje pytania. Przykłady dla wszystkich czterech
wersji są w `installer/debian/examples/`. Trzy zasady:

- **hasła w pliku się nie podaje** — administratora bierze z `admin.password_file` (plik z
  `chmod 600`, hasło w pierwszej linii) albo ze zmiennej `TRYHACKX_ADMIN_PASSWORD`; klucz
  `password` jest błędem. Zalecany jest plik, a po instalacji jego usunięcie
  (`shred -u /root/haslo-admina`): zmienna wpisana w powłoce zostaje w historii poleceń.
  Gdy jednak zmienna, `sudo` domyślnie czyści środowisko, więc przekazuje się ją jawnie:
  `sudo --preserve-env=TRYHACKX_ADMIN_PASSWORD bash zainstaluj-debian.sh --answers …`, a
  instalator usuwa ją ze swojego środowiska, zanim uruchomi cokolwiek innego. Tryb próbny
  hasła nie potrzebuje;
- **nieznany klucz jest błędem** — literówka w `vps_addresses` nie może po cichu zrobić
  z instalacji prywatnej czegoś innego;
- **wszystkie błędy naraz**, nie tylko pierwszy.

Język przebiegu: `--lang en` albo `language = "en"` w pliku (opcja z wiersza poleceń wygrywa).

Uruchomienie `vps-setup.sh` przez SSH bez pytań wymaga klucza (`vps.ssh_identity_file`) i —
przy pierwszym połączeniu — odcisku klucza VPS-a (`vps.ssh_host_fingerprint`). Razem z
`--dry-run` plik odpowiedzi daje pełny zapis tego, co instalacja by zrobiła, bez zmieniania
czegokolwiek.

### Gdy coś pójdzie nie tak

- **Przerwana instalacja** (brak sieci przy `apt` albo `pip`, odmowa Let's Encrypt): uruchom
  instalator ponownie. Rozpoznaje niedokończoną instalację po zapisie stanu i ją kończy —
  konfiguracja z hasłem bazy zostaje ta sama, konto administratora nie jest zakładane drugi raz.
- **„Usługa nie odpowiada na porcie 8765”** — prawie zawsze folder, którego `www-data` nie może
  czytać. `curl http://127.0.0.1:8765/health/ready` wypisze, który.
- **Let's Encrypt odmówił** — rekord DNS nie wskazuje jeszcze na ten serwer albo port 80 nie
  dochodzi. Instalator proponuje certyfikat tymczasowy; po poprawce: `--zmien dostep`.
- **„Apache odrzucił nową konfigurację”** — pliki wróciły do poprzedniej postaci; komunikat
  cytuje `apache2ctl configtest`.
- **Port 80 albo 443 zajęty przez inny program** (nginx, inny serwer WWW) — instalator mówi
  przez który, zanim cokolwiek zmieni.

## Instalacja ręczna

Poniżej te same kroki wykonywane poleceniami — ścieżka zaawansowana i dokumentacja tego, co
instalator robi pod spodem.

Opisana tu ścieżka prowadzi do serwera **widocznego z sieci** — VPS-a albo
domowej maszyny z własną nazwą. Kto ma przed sobą reverse proxy, kto chce
zostać w sieci prywatnej bez TLS i kto stawia to wyłącznie na localhost,
znajdą różnice w `PUBLIC-EXPOSURE.md`; poza konfiguracją Apache (krok 7)
i dwoma wpisami w prywatnej konfiguracji reszta jest wspólna.

## Pakiety

```bash
sudo apt update
sudo apt install python3 python3-venv apache2 libapache2-mod-php \
    php-cli php-mysql php-mbstring php-curl php-xml \
    default-mysql-server default-mysql-client ffmpeg curl rsync
sudo a2enmod proxy proxy_http headers ssl
```

`ssl` jest potrzebny każdej instalacji widocznej z sieci — most odrzuca
logowanie po zwykłym HTTP. Wyłącznie lokalna instalacja może go pominąć.

Trzy rozszerzenia PHP z tej listy są **obowiązkowe, a łatwo je przeoczyć**,
bo `php -l` przechodzi bez nich: most używa `mb_*` w każdej ścieżce katalogu
i logowania, `curl_*` w wywołaniach do usługi transferowej i w CAPTCHA-y, a
`simplexml_load_string` w imporcie playlist XSPF. Bez nich instalacja wygląda
na udaną, a most wywala się na pierwszym żądaniu. `php-cli` jest osobno, bo
`libapache2-mod-php` daje tylko moduł Apache, a jednostka przeglądu nowości
uruchamia `/usr/bin/php`. Sprawdzenie: `php -r 'foreach (["mbstring","curl",
"simplexml","pdo_mysql","openssl"] as $e) printf("%s=%s\n", $e, extension_loaded($e) ? "OK" : "BRAK");'`
(`openssl` szyfruje sekrety weryfikacji dwuetapowej; w PHP z Debiana jest wkompilowany).

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
# Hasło wpisane bez echa, nie w wierszu poleceń: tam zostaje w historii powłoki i w `ps`.
read -rs -p 'Hasło konta bazy: ' MEDIA_SERVER_DB_PASSWORD; echo; export MEDIA_SERVER_DB_PASSWORD
sudo --preserve-env=MEDIA_SERVER_DB_PASSWORD python3 scripts/install.py --config-only \
    --config /etc/tryhackx-media-server/config.local.toml \
    --music-root /srv/media/music --movies-root /srv/media/movies \
    --base-url https://twoj.host/
unset MEDIA_SERVER_DB_PASSWORD
sudo chown root:www-data /etc/tryhackx-media-server/config.local.toml
sudo chmod 0640 /etc/tryhackx-media-server/config.local.toml
```

`--base-url` to adres, spod którego aplikacja będzie widoczna, i **jedyna
wartość, której nie da się zgadnąć z maszyny**: linki aktywacyjne idą e-mailem,
a w ścieżce względnej nikt nie kliknie, więc bez niego nikt nowy nie dokończy
rejestracji. Instalacja wyłącznie lokalna może go pominąć. Gdy przed serwerem
stoi reverse proxy, dochodzi `--proxy-trusted '203.0.113.10, 2001:db8::10'` —
adresy proxy; bez nich limit prób logowania i CAPTCHA widzą wszystkich gości
jako jeden adres. Obie wartości można dopisać do konfiguracji później ręcznie.

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
CREATE USER 'media_server'@'127.0.0.1' IDENTIFIED BY 'silne-osobne-haslo';
GRANT SELECT, INSERT, UPDATE, DELETE ON media_server.* TO 'media_server'@'localhost', 'media_server'@'127.0.0.1';
```

Oba konta, bo konfiguracja łączy się z `127.0.0.1` (TCP), a MariaDB rozróżnia to od
`localhost` (gniazdo). Polecenia wpisuje się w `sudo mariadb` — hasło jest wtedy w kliencie
bazy, nie w wierszu poleceń powłoki.

Konto aplikacji dostaje wyłącznie DML. **Migracje wymagają DDL** i uruchamia się
je osobnym kontem — tak samo jak na Windows, gdzie robi to `root@localhost`.
Najprościej: druga konfiguracja tylko dla migracji, wskazywana przez
`--migrate-config` (ten sam plik z innym `[database].user` i hasłem, prawa
`0600` dla roota).

**3. Pierwsze wydanie.** Jednostki systemd jeszcze nie ma, więc nie ma czego
restartować ani odpytywać:

```bash
sudo bash scripts/release-debian.sh --build-frontend --migrate \
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

**7. Apache.** Trzy pliki i jedna zasada: fragmenty dają aliasy i trasę
transferu, a **host wirtualny mówi, pod jaką nazwą serwer odpowiada i gdzie ma
`DocumentRoot`**. Bez tego drugiego pod `https://twoj.host/` stoi domyślna
strona Debiana, aplikacja jest nieosiągalna, a `configtest` i tak mówi
„Syntax OK" — nie ma czego sprawdzić, skoro nikt nie wskazał katalogu.

```bash
sudo cp deploy/apache/media-next.conf.example /etc/apache2/conf-available/media-next.conf
sudo cp deploy/apache/media-transfer.conf.example /etc/apache2/conf-available/media-transfer.conf
sudo cp deploy/apache/media-vhost.conf.example /etc/apache2/sites-available/tryhackx-media.conf
```

W `tryhackx-media.conf` ustaw trzy rzeczy — wszystkie są opisane w jego
nagłówku: `Define`y (nazwa hosta, `/opt/tryhackx-media-server/current`,
`/etc/tryhackx-media-server/config.local.toml`) oraz ścieżki certyfikatu.
Czwarta, `[app] base_url`, jest już w prywatnej konfiguracji z kroku 1 — i ma
być tą samą nazwą, którą wpisujesz tutaj. W `media-transfer.conf` wybierz
wariant dostępu:

- **`Require local`** (domyślny) — instalacja widoczna wyłącznie z tej maszyny;
- **`Require all granted`** — instalacja sieciowa. Bez tej zmiany biblioteka
  się wyświetla, ale **każde odtworzenie i pobranie dostaje 403**. Trasy
  transferu chroni podpisany token o krótkim czasie życia, wydawany przez most
  po sprawdzeniu sesji, więc ich otwarcie jest zamierzone; zdrowie usługi
  i zlecenia zadań zostają zamknięte osobną regułą w tym samym pliku.

W obu fragmentach `Define` zostają zakomentowane — wartości przychodzą z hosta.
Nierozwinięte `${…}` weszłoby do ścieżek jako zwykły tekst, a `configtest`
przepuściłby to jako „Syntax OK", więc `media-next.conf` zaczyna się od
`IfDefine`, który zamiast tego wywala test zdaniem mówiącym, którego `Define`
brakuje.

Certyfikat musi już być na dysku — dlaczego, zaraz niżej. Potem:

```bash
sudo a2ensite tryhackx-media
sudo apache2ctl configtest
sudo systemctl reload apache2
```

**Kolejność nie jest kosmetyczna.** `apache2.conf` Debiana wciąga wyłącznie
`sites-enabled/*.conf` i `conf-enabled/*.conf`, więc `configtest` uruchomiony
**przed** `a2ensite` sprawdza wszystko oprócz tego pliku i mówi „Syntax OK"
o konfiguracji, której nie przeczytał. Gdy test po włączeniu nie przejdzie,
wyłącz host (`sudo a2dissite tryhackx-media`) i dopiero wtedy przeładuj —
reload z błędną konfiguracją zatrzymuje **cały** serwer, a nie tylko te trasy.

Fragmenty są tu wciągane **przez host** (`Include`), a nie przez `a2enconf`,
i ma to jeden konkretny powód: `conf-enabled` jest czytane **przed**
`sites-enabled`, więc `Define` postawiony w hoście byłby dla nich za późno.
Włączenie globalne też jest poprawne — wtedy `Define`y muszą siedzieć wewnątrz
`media-next.conf`, a z hosta trzeba usunąć obie linie `Include`, inaczej te same
aliasy wejdą dwa razy. Aliasy globalne dotyczą jednak **wszystkich** hostów na
tej maszynie; na serwerze, który obsługuje też coś innego, host jest właściwszy.

**HTTPS nie jest tu ozdobą.** Most odrzuca logowanie po zwykłym HTTP (`422`),
więc bez certyfikatu aplikacja załaduje się i odbije każde kliknięcie. Przykład
hosta ma gotowe przekierowanie z portu 80 i nagłówek HSTS.

**Certyfikat bierze się przed `a2ensite`, nie po.** Apache ze wskazanym,
a nieistniejącym `SSLCertificateFile` **nie wstaje**: `configtest` kończy się
błędem „does not exist or is empty" i kodem 1 (sprawdzone). Kolejność, która
działa — port 80 obsługuje jeszcze domyślny host Debiana:

```bash
sudo apt install certbot
sudo certbot certonly --webroot -w /var/www/html -d twoj.host
```

Instalacja w sieci prywatnej bez TLS jest możliwa i wymaga świadomego
`[session] require_https = false` — kształt **D** w `PUBLIC-EXPOSURE.md`.

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

**8. Pierwsze konto — i to jedyny krok, którego nie da się zrobić w aplikacji.**
Świeża instalacja nie ma żadnego konta, a rejestracja jest **domyślnie
wyłączona** (`registration_enabled = '0'`). Jest to celowe — serwer przychodzi
zamknięty — ale znaczy też, że pod adresem stoi strona logowania, do której nikt
nie ma jak wejść. Pierwsze konto zakłada polecenie:

```bash
sudo -u www-data /opt/tryhackx-media-server/current/.venv/bin/python -m media_server \
    --config /etc/tryhackx-media-server/config.local.toml \
    account-create --username twoja-nazwa --email ty@example.org
```

Pyta dwa razy o hasło (bez echa, co najmniej 12 znaków) i zakłada konto **aktywne,
potwierdzone, z rolą `super_admin`**, w systemowej grupie `user` — rejestracji nie
trzeba otwierać ani na chwilę. `--role admin|user` daje inną rolę, `--email` jest
opcjonalny. Hasła **nie da się** podać w wierszu polecenia (widziałby je każdy
w `ps`); skrypt podaje je na pierwszej linii wejścia z `--password-stdin`, np.
`printf '%s\n' "$HASLO" | sudo -u www-data … account-create --username … --password-stdin`.

Skrót hasła liczy `/usr/bin/php` (`password_hash()`, tym samym, którym most je
sprawdza) — `php-cli` jest już na liście pakietów; inny plik wskazuje `--php`.
To wszystko jest DML, więc wystarczy konto aplikacji — `root` nie jest potrzebny.
Wpis trafia do dziennika aktywności panelu (`user.create`, bez autora). `role`
decyduje o panelu administracyjnym; prawa do bibliotek, pobrań i limitów biorą się
z **grupy uprawnień** i od tej chwili ustawia się je już w panelu. Kolejne konta
zakłada się już normalnie: w panelu, przez rejestrację albo tym samym poleceniem.

## Cloudflare, fail2ban i limity połączeń (opcjonalnie)

Aplikacja broni się sama: most liczy logowania, rejestracje, pobrania, strumienie
trybu zgodnego i każde żądanie (drabina w panelu: Administracja → Bezpieczeństwo →
„Krok w górę i blokady”), prosi o wyzwanie, potem robi pauzę, a na końcu blokuje.
Trzy warstwy niżej przenoszą część tej pracy przed PHP. Żadna nie jest wymagana
i żadnej nie włącza skrypt wydania — pliki w `deploy/` to wyłącznie przykłady.

### Cloudflare przed stroną

1. **DNS**: rekord A/AAAA nazwy strony jako „Proxied” (pomarańczowa chmurka),
   SSL/TLS w trybie **Full (strict)** — serwer ma własny, ważny certyfikat.
2. **Firewall serwera**: porty 80/443 tylko z zakresów Cloudflare
   (`https://www.cloudflare.com/ips/`), inaczej każdy, kto zna adres serwera,
   omija proxy razem z jego regułami.
3. **Prawdziwy adres gościa**: za Cloudflare Apache widzi adresy Cloudflare.
   `[proxy] trusted` przyjmuje pojedyncze adresy, nie zakresy, więc adres ustawia
   `mod_remoteip` (`sudo a2enmod remoteip`): `RemoteIPHeader CF-Connecting-IP` i
   `RemoteIPTrustedProxyList /etc/apache2/cloudflare-ips.txt` (zakresy z listy
   wyżej). Wtedy `REMOTE_ADDR` jest adresem gościa, most liczy limity per gość,
   a log ma go w `[client …]`. `[proxy] trusted` zostaje wtedy puste (albo
   tylko z adresem własnego proxy, jeśli stoi między Cloudflare a serwerem).
4. **WAF → Rate limiting rules**: reguła na logowanie, np. wyrażenie
   `(http.request.uri.path eq "/media-next-api" and http.request.uri.query contains "action=login")`,
   ok. 10 żądań na minutę z jednego adresu → *Managed Challenge* albo *Block* na
   10 minut. Plan darmowy ma jedną regułę i krótkie okresy — liczby dobrać do planu.
5. **Security → Bots → Bot Fight Mode**: włączony. Przeglądarki przechodzą, skrypty
   dostają wyzwanie Cloudflare, zanim dotrą do mostu.
6. **Turnstile** w panelu (Administracja → Bezpieczeństwo → Dostawca) działa
   z Cloudflare i bez niego — to osobny produkt.

**Zastrzeżenie: filmy i duże pliki.** Warunki planów samoobsługowych Cloudflare
(CDN, „Service-Specific Terms”) nie pozwalają serwować przez proxy wideo i dużych
plików inaczej niż ich płatnymi usługami (Stream, R2…). Transfery
(`/media-transfer/…`: strumienie, pobrania, archiwa) **nie mogą więc iść przez
pomarańczową chmurkę**, a w ramach jednej nazwy nie da się wyłączyć proxy dla
ścieżki. Dziś aplikacja zakłada transfery z tej samej domeny co strona (CSP
`media-src`/`connect-src 'self'`, a strumień trybu zgodnego czyta `fetch`), więc:

- **wariant obecny**: nazwa strony jako „DNS only” (szara chmurka) — Cloudflare
  tylko jako DNS, ochrona z aplikacji (krok w górę, Turnstile), fail2ban i limity
  Apache niżej;
- **wariant z proxy**: strona przez Cloudflare, transfery pod osobną nazwą „DNS
  only” (`[transfer] base_url = "https://transfer.<domena>/media-transfer"`). To
  wymaga zmian, których jeszcze nie ma: nagłówków CORS w usłudze transferowej
  (tryb zgodny czyta strumień przez `fetch`) i dopisania tej nazwy do `media-src`,
  `connect-src` i `img-src` w CSP. Do zrobienia osobno, nie samą konfiguracją.

### fail2ban

Most zapisuje jedną linię na odrzucone logowanie, kod 2FA, wyzwanie, odmowę limitu
logowania i blokadę drabiny (`tryhackx-auth event=… action=… client=<16 znaków
skrótu>`, bez nazwy, hasła i adresu). Adres dopisuje Apache (`[client …]`), więc
linia musi trafić do jego dziennika: w `/etc/php/8.*/apache2/php.ini` zostaw
`error_log` **nieustawione** (domyślnie na Debianie) — ustawione kieruje te linie
do pliku bez adresu i jail nic nie zobaczy.

```bash
sudo apt install fail2ban
sudo cp deploy/fail2ban/filter.d/tryhackx-media-auth.conf.example /etc/fail2ban/filter.d/tryhackx-media-auth.conf
sudo cp deploy/fail2ban/jail.d/tryhackx-media.conf.example /etc/fail2ban/jail.d/tryhackx-media.conf
# najpierw sprawdzenie filtra na prawdziwym logu (po jednym celowo złym logowaniu):
sudo fail2ban-regex /var/log/apache2/tryhackx-media-error.log /etc/fail2ban/filter.d/tryhackx-media-auth.conf
sudo systemctl reload fail2ban
sudo fail2ban-client status tryhackx-media-auth
sudo fail2ban-client set tryhackx-media-auth unbanip <adres>   # zdjęcie bana
```

Jail banuje po 10 zdarzeniach w 15 minut na godzinę (kolejne razy dłużej).
**Za proxy** (VPS, Cloudflare) firewall tego serwera nie zatrzyma gościa, bo jego
pakiety przychodzą od proxy: adres w logu musi być gościa (`mod_remoteip`, wyżej),
a ban trzeba nałożyć na proxy — dla Cloudflare akcją fail2ban z tokenem API
(token tylko w `/etc/fail2ban/jail.local`, nigdy w repozytorium), dla własnego
VPS-a fail2ban na nim. Adresu proxy nie wolno zbanować (`ignoreip`).

### Apache: limity żądań i połączeń

`deploy/apache/media-hardening.conf.example` — `RequestReadTimeout` (powolne
żądania, slowloris), limity linii i nagłówków, krótki keep-alive, `LimitRequestBody`
dla mostu (3,5 MB — import playlisty) i transferów, sufity MPM. Wkleić do vhosta
albo dołączyć `Include`, potem `sudo apache2ctl configtest` i przeładowanie. Nie
ucina długich strumieni: limity dotyczą czytania żądania, nie wysyłania odpowiedzi.

**Co serwer mówi o sobie.** Domyślnie każda odpowiedź niesie wersje Apache, OpenSSL
i PHP w nagłówku `Server`. `ServerTokens Prod` działa tylko globalnie (w vhoście Apache
go nie przyjmie); `ServerSignature Off` można dać globalnie albo w vhoście. Instalator robi
to w wersjach S i P własnym plikiem `/etc/apache2/conf-available/tryhackx-media-quiet.conf`
(`a2enconf`, czytany po `security.conf`; razem z `Header unset X-Powered-By`) i zdejmuje
go przy odinstalowaniu. Ręcznie: te same linie w `security.conf`, a w `php.ini` modułu
Apache `expose_php = Off`.

Apache nie ma limitu połączeń na adres. Serwer wystawiony **bezpośrednio** (bez
proxy) może go mieć w nftables — przykład, do dopisania do własnej konfiguracji:

```
table inet tryhackx_media_limit {
    set web4 { type ipv4_addr; flags dynamic; size 65535; }
    set web6 { type ipv6_addr; flags dynamic; size 65535; }
    chain input {
        type filter hook input priority filter; policy accept;
        tcp dport { 80, 443 } ct state new add @web4 { ip saddr ct count over 60 } reject with tcp reset
        tcp dport { 80, 443 } ct state new add @web6 { ip6 saddr ct count over 60 } reject with tcp reset
    }
}
```

60 równoczesnych połączeń z adresu to dużo dla przeglądarki (film to 1–2), mało
dla skryptu. **Za proxy** wszystkie połączenia mają adres proxy — wtedy taki limit
zablokowałby wszystkich naraz; jego miejsce jest na proxy.

## Aktualizacja

```bash
cd ~/src/media-server && git pull
sudo bash scripts/release-debian.sh --build-frontend --migrate \
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
bash scripts/release-debian.sh --list
sudo bash scripts/release-debian.sh --rollback
sudo bash scripts/release-debian.sh --switch 20260815-201500
```

`--rollback` wraca do wydania spod `previous`; po powrocie `previous` wskazuje
to, z którego wróciliśmy, więc drugie `--rollback` idzie z powrotem do przodu.
Wybór dowolnego wydania z listy to `--switch`.

**Rollback kodu nie cofa migracji.** Przed wydaniem robi się kopię SQL, a
migracje pisze się tak, by starsze wydanie nadal na nich działało. To jedyny
element, którego dowiązanie nie załatwia. Instalator (`--zmien aktualizacja`, `--zmien migracje`)
robi tę kopię sam; ręcznie:

```bash
sudo install -d -m 0700 /var/backups/tryhackx-media-server/database
sudo sh -c 'umask 077; mariadb-dump --single-transaction --quick --hex-blob media_server | gzip > /var/backups/tryhackx-media-server/database/media_server-$(date +%Y%m%d-%H%M%S).sql.gz'
```

## Czego skrypt wydania nie robi

Nie instaluje pakietów, nie tworzy bazy ani konta, nie konfiguruje Apache i nie
zakłada jednostki systemd. Wszystkie te kroki są jednorazowe, wymagają decyzji
i są wypisane wyżej. `--dry-run` wypisuje cały plan bez zmieniania czegokolwiek.

## Świadome ograniczenia

- **Usługa i most PHP dzielą konto `www-data`** (jak każda aplikacja PHP pod Apache Debiana):
  inna aplikacja PHP na tym samym Apache'u może przeczytać `config.local.toml` z hasłem bazy
  i kluczem transferów. Serwer mediów najlepiej trzymać na Apache'u bez obcych aplikacji PHP;
  osobne konto wymagałoby PHP-FPM z własną pulą zamiast `mod_php`.
- **Skrypt wydania działa jako root** — `media-server check`, migracje (kontem bazy od struktury,
  nie rootem bazy) i, przy klonie bez zbudowanego frontu, `npm ci`. Z paczki wydania `npm`
  nie jest potrzebny w ogóle; z klonu buduje się front z zablokowanego `package-lock.json`.
- **Jednostki systemd** mają zestaw ograniczeń (`ProtectSystem=strict`, `ProtectHome`,
  `PrivateDevices`, bez uprawnień i przestrzeni nazw; usługa i przebieg okresowy także
  `MemoryDenyWriteExecute`, przegląd poczty nie, bo PHP z JIT-em PCRE go nie zniesie), ale nie filtr
  wywołań systemowych ani `IPAddressAllow`: usługa pobiera metadane z sieci i uruchamia FFmpeg,
  a filtra nie da się sprawdzić bez prawdziwego Debiana.

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
