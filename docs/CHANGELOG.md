# Dziennik zmian

Zamknięte etapy i serie zmian; otwarte prace są wyłącznie w `ROADMAP.md`.

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
