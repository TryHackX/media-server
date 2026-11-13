# Wystawienie na zewnątrz

Do tej pory każda instrukcja opisywała instalację widoczną wyłącznie z tej samej
maszyny. Ten dokument opisuje cztery kształty wystawienia i mówi, co dokładnie
trzeba zmienić w każdym — łącznie z tym, czego **nie** wolno zostawić po drodze.

| Kształt | Kto kończy TLS | Co widzi gość |
|---|---|---|
| **A. Za reverse proxy** (VPS przed serwerem domowym) | proxy (osobna maszyna) | adres proxy; adres serwera aplikacji się nie pojawia |
| **B. Wprost, publiczny adres** (VPS albo domowy komputer z przekierowanym portem) | ten Apache | adres tego serwera |
| **C. Tylko localhost** | nic albo ten Apache | nic — dostęp z tej maszyny |
| **D. Tylko sieć prywatna** (serwer domowy oglądany z telefonu) | zwykle nic | adres z LAN-u, np. `192.168.1.10` |

**Każdy z czterech kształtów ustawia instalator**: na Windowsie kreator (`Zainstaluj.cmd`, strona
„Dostęp”; opis w `INSTALL-WINDOWS.md`), na Debianie `zainstaluj-debian.sh` (tam nazywają się
S, P, D i C — to kształty B, A, D i C; opis w `INSTALL-DEBIAN.md`). Ten dokument mówi, co
i dlaczego instalatory ustawiają — i jak zrobić to samo ręcznie.

**Kompletny host wirtualny dla kształtów A i B** jest w
`deploy/apache/media-vhost.conf.example`: nazwa serwera, `DocumentRoot`,
certyfikat, HSTS, przekierowanie z portu 80 i włączenie obu fragmentów
konfiguracji. Same fragmenty (`media-next.conf.example`,
`media-transfer.conf.example`) **nie wystarczą** — nie mówią, pod jaką nazwą
serwer odpowiada ani gdzie ma `DocumentRoot`, więc bez hosta pod adresem stoi
domyślna strona Apache'a, a `configtest` i tak mówi „Syntax OK".

**Aplikacja stoi pod głównym adresem.** `https://twoj.host/` prowadzi wprost do
biblioteki — nie ma podkatalogu do dopisywania. Odpowiada za to `DocumentRoot`
hosta wirtualnego wskazujący na `public/assets/build`, a nie alias: `Alias "/"`
przykryłby wszystkie pozostałe aliasy na serwerze.

Instalacja pod podkatalogiem jest nadal możliwa i wymaga **trzech zgodnych
wartości**, bo każda z nich mówi to samo w innym miejscu:

1. `MEDIA_APP_BASE=/media-next/ npm run build` — front i service worker.
   W PowerShellu: `$env:MEDIA_APP_BASE='/media-next/'; npm run build`.
   **Nie w Git Bashu**: zamienia on wartość zaczynającą się od ukośnika na ścieżkę
   Windows i front buduje się dla `C:/Program Files/Git/media-next/`. Sprawdzone;
   błąd nie zgłasza się w żaden sposób poza tym, co wyląduje w `index.html`;
2. `Alias "/media-next/" "${TRYHACKX_MEDIA_ROOT}/public/assets/build/"` zamiast
   `DocumentRoot`, a w `media-next.conf` przedrostek w regule `AliasMatch`
   publicznego profilu (`^/media-next/account/[^/]+/?$`) — bez tego wejście
   wprost pod adres profilu kończy się 404;
3. `[app] base_url` z tym samym przedrostkiem, inaczej link aktywacyjny prowadzi
   obok aplikacji.

Trasa mostu (`/media-next-api`) i trasa transferu (`/media-transfer/`) zostają
tam, gdzie są: front zna je z osobnego wpisu `meta`, niezależnego od tego, gdzie
stoi sama aplikacja.

**Kształt B jest domyślny w tym repozytorium.** Ktoś, kto sklonuje projekt
i postawi go na własnym VPS-ie z normalnym certyfikatem, nie musi robić nic
z proxy: `[proxy] trusted` zostaje puste, nagłówki `X-Forwarded-*` nie są wtedy
w ogóle czytane, a HTTPS rozpoznaje się z własnego połączenia.

## Trzy rzeczy, bez których publiczna instalacja jest gorsza od lokalnej

**1. HTTPS, i to wymuszone.** Most odrzuca logowanie po zwykłym HTTP —
odpowiedzią jest `422`, celowo, bo inaczej hasło i ciasteczko sesji lecą tekstem.
Konsekwencja jest jednak mylącą awarią: aplikacja **ładuje się poprawnie**, a
każde kliknięcie odbija się o błąd, i gość sam nie zgadnie, że brakuje litery
„s". Dlatego na porcie 80 ma stać przekierowanie na HTTPS, a nie sama aplikacja.

**2. HSTS na hoście serwującym TLS.** Bez niego pierwsze wejście po `http://`
zdąży wysłać ciasteczko, zanim przekierowanie zadziała:

```apache
Header always set Strict-Transport-Security "max-age=31536000"
```

**3. `[app] base_url` jako pełny adres.** Domyślnie jest to sama ścieżka, a link
aktywacyjny idzie **e-mailem** — w ścieżce względnej nikt nie kliknie, więc
rejestracji nie da się dokończyć. To najczęstszy sposób, w jaki publiczna
instalacja „działa", a mimo to nikt nowy się nie zarejestruje.

```toml
[app]
base_url = "https://twoj.host/"
```

Instalator umie to zapisać od razu — `--base-url https://twoj.host/`, a dla
kształtu A również `--proxy-trusted '203.0.113.10, 2001:db8::10'`. Adresy proxy
są przy okazji sprawdzane: literówka w adresie nie odzywa się w żaden sposób,
tylko po cichu wyłącza rozpoznanie gościa.

## Kształt A: za reverse proxy

Wpisz adresy proxy do prywatnej konfiguracji:

```toml
[proxy]
trusted = "203.0.113.10, 2001:db8::10"
```

Ten jeden wpis włącza dwie rzeczy naraz i **obie są konieczne**:

- **kto jest gościem** — bez tego `REMOTE_ADDR` jest adresem proxy, więc limit
  prób logowania i CAPTCHA widzą wszystkich jako jedną osobę i przestają
  cokolwiek chronić;
- **czym gość przyszedł** — proxy kończące TLS rozmawia z nami zwykłym HTTP,
  więc bez tego most odrzuca każde żądanie jako niezabezpieczone, a ciasteczko
  sesji traci atrybut `Secure`.

Nagłówki `X-Forwarded-For` i `X-Forwarded-Proto` są czytane **wyłącznie** wtedy,
gdy przyniósł je host z tej listy. To nie jest ostrożność na wyrost: te nagłówki
pisze klient i może w nich napisać cokolwiek.

**Po stronie proxy** muszą być spełnione trzy warunki, inaczej lista wyżej nic
nie daje:

1. proxy **samo** ustawia `X-Forwarded-For` i `X-Forwarded-Proto`
   i **kasuje** to, co przysłał klient;
2. proxy naprawdę pośredniczy (`proxy_pass`), a nie przekierowuje — przy
   przekierowaniu przeglądarka łączy się z serwerem aplikacji bezpośrednio
   i jego adres przestaje być czymkolwiek ukrytym;
3. proxy przekazuje oryginalny nagłówek `Host`, inaczej Apache zbuduje
   przekierowanie ze **swojej** nazwy — i wypisze ją gościowi.

### Czy adres serwera może wyciec

Aplikacja nie buduje żadnego bezwzględnego adresu z tego, czym sama jest:
front używa adresów względnych, linki w poczcie biorą się z `[app] base_url`,
a strona gościa i trasy transferu też są względne. Zostają trzy rzeczy **poza**
aplikacją, i to one decydują:

- **DNS** — nazwa musi wskazywać na proxy. To jest publiczne i nie da się tego
  ukryć aplikacją.
- **Konfiguracja proxy** — punkty 2 i 3 wyżej.
- **Wszystko inne na tym samym adresie** — inna usługa na tym łączu, wysyłka
  poczty wprost z tej maszyny, cokolwiek, co odezwie się z tego adresu.
- **Sam serwer aplikacji, gdy odpowiada każdemu** — otwarty port 443 z certyfikatem
  noszącym nazwę strony wystarczy, żeby skaner internetu połączył adres z nazwą.
  Jak to zamknąć: „Port 443 w domu tylko dla VPS” niżej.

### Przepis: VPS przed serwerem domowym

Najczęstszy powód kształtu A: serwer stoi w domu, a świat ma widzieć wyłącznie adres wynajętego
VPS — także wtedy, gdy dostawca łącza blokuje port 80. Na Windowsie cały ten przepis wykonuje
kreator (`Zainstaluj.cmd` → „Przez VPS”, patrz `INSTALL-WINDOWS.md`): po stronie domowej ustawia
wszystko sam, a dla VPS zostawia folder `runtime\vps-bundle` z gotowymi plikami i instrukcją.
Na Debianie robi to `zainstaluj-debian.sh`, wersja P — różnice opisuje „Dom na Debianie” niżej.
Poniżej to samo z wartościami przykładowymi — `media.example.org`, VPS `203.0.113.10`, łącze
domowe `198.51.100.7`, komputer w domu `192.168.1.20`.

```text
gość ──HTTPS──▶ VPS 203.0.113.10 (Apache, Let's Encrypt) ──HTTPS, przypięty certyfikat──▶ dom 198.51.100.7:443
                                                                                    router ──▶ 192.168.1.20:443 (WAMP)
```

**DNS:** rekord `A media.example.org → 203.0.113.10` (VPS, nie dom). **Router:** przekierowanie
TCP 443 → `192.168.1.20:443`; portu 80 dom nie potrzebuje wcale.

**W domu** (Apache z WAMP-a; kreator dopisuje to do własnego pliku w `alias\`):

```apache
Listen 443
<VirtualHost *:443>
    # Nie nazwa publiczna: zapytanie bez nagłówka Host każe Apache'owi budować
    # przekierowania z ServerName, a to nie może zdradzić, czyj to serwer.
    ServerName origin.invalid
    DocumentRoot "${TRYHACKX_MEDIA_ROOT}/public/assets/build"

    SSLEngine on
    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
    SSLCertificateFile "C:/TryHackX/MediaServer/config/origin/origin-cert.pem"
    SSLCertificateKeyFile "C:/TryHackX/MediaServer/config/origin/origin-key.pem"
</VirtualHost>
```

oraz we wszystkich czterech regułach dostępu z `media-next-stage-wamp.conf.example`
`Require local` + `Require ip 203.0.113.10` zamiast `Require all granted`. W prywatnej
konfiguracji: `[app] base_url = "https://media.example.org/"` i `[proxy] trusted = "203.0.113.10"`.

VPS łączy się z domem po HTTPS, więc most widzi szyfrowane połączenie wprost; `[proxy] trusted`
służy tu temu, żeby z `X-Forwarded-For` odczytać adres gościa, a nie adres VPS.

**Na VPS** (Debian, `a2enmod proxy proxy_http ssl headers`). Port 80 — tylko wyzwanie Let's
Encrypt i przekierowanie:

```apache
<VirtualHost *:80>
    ServerName media.example.org
    Alias /.well-known/acme-challenge/ /var/www/tryhackx-media/.well-known/acme-challenge/
    <Directory /var/www/tryhackx-media/.well-known/acme-challenge/>
        Options None
        AllowOverride None
        Require all granted
    </Directory>
    RedirectMatch permanent "^/(?!\.well-known/acme-challenge/)(.*)$" "https://media.example.org/$1"
</VirtualHost>
```

Port 443 — pośrednik:

```apache
<VirtualHost *:443>
    ServerName media.example.org

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/media.example.org/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/media.example.org/privkey.pem
    Header always set Strict-Transport-Security "max-age=31536000"

    # Strona pokazywana, gdy dom nie odpowiada — serwowana stąd, nigdy z domu.
    Alias /maintenance.html /var/www/tryhackx-media/maintenance.html
    <Directory /var/www/tryhackx-media>
        Options None
        AllowOverride None
        Require all granted
    </Directory>
    ErrorDocument 502 /maintenance.html
    ErrorDocument 503 /maintenance.html
    ErrorDocument 504 /maintenance.html

    # Połączenie z domem: szyfrowane i sprawdzane względem JEDNEGO certyfikatu.
    SSLProxyEngine On
    SSLProxyVerify require
    SSLProxyVerifyDepth 1
    SSLProxyCACertificateFile /etc/apache2/tryhackx-media/origin.crt
    SSLProxyCheckPeerName off
    SSLProxyCheckPeerCN off
    SSLProxyCheckPeerExpire on
    SSLProxyProtocol all -SSLv3 -TLSv1 -TLSv1.1

    ProxyRequests Off
    ProxyPreserveHost On
    ProxyAddHeaders Off
    RequestHeader set X-Forwarded-For "expr=%{REMOTE_ADDR}"
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader unset Forwarded
    RequestHeader unset X-Forwarded-Host
    RequestHeader unset X-Real-IP

    ProxyTimeout 60
    ProxyPass /maintenance.html !
    ProxyPass /media-transfer/ https://198.51.100.7/media-transfer/ connectiontimeout=5 timeout=3600 retry=0 nocanon
    ProxyPass / https://198.51.100.7/ connectiontimeout=5 timeout=60 retry=0
    ProxyPassReverse / https://198.51.100.7/
</VirtualHost>
```

Kolejność na VPS: najpierw host portu 80 i `certbot certonly --webroot -w /var/www/tryhackx-media
-d media.example.org --deploy-hook "systemctl reload apache2"`, dopiero potem `a2ensite` hosta
443 — Apache ze wskazanym, a nieistniejącym certyfikatem nie startuje.

#### Przypięty certyfikat zamiast `SSLProxyVerify none`

Odcinek VPS → dom idzie przez internet. Z `SSLProxyVerify none` jest szyfrowany, ale **niczym
nieuwierzytelniony**: kto wepnie się po drodze (albo przejmie adres domowy po zmianie IP),
przedstawi dowolny certyfikat i czyta hasła oraz ciasteczka wszystkich gości. Kopiowanie do domu
certyfikatu Let's Encrypt z VPS tego nie naprawia — dokłada tylko skrypt, który musi działać co
dwa miesiące, i klucz publicznej domeny leżący na drugiej maszynie.

Zamiast tego dom ma **własny, długowieczny certyfikat podpisany samodzielnie**, a VPS ufa
dokładnie jemu i niczemu innemu (`SSLProxyCACertificateFile` z tym jednym plikiem). Sprawdzanie
nazwy jest wyłączone, bo VPS łączy się po adresie IP, a certyfikat celowo nie nazywa nikogo:

```powershell
# w domu, openssl z Apache'a WAMP-a; kreator robi to sam i chroni folder z kluczem
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 3650 `
    -subj "/CN=origin" -addext "basicConstraints=critical,CA:FALSE" `
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=serverAuth" `
    -keyout origin-key.pem -out origin-cert.pem
```

**Certyfikat serwera, nie urzędu (`CA:FALSE`).** Samo `req -x509` dokłada rozszerzenia `v3_ca`
z `openssl.cnf`, czyli `CA:TRUE`. VPS-owi to nie przeszkadza — przypina ten jeden plik — ale
Firefox certyfikatu urzędu pokazanego przez serwer nie przepuszcza w ogóle, bez „Akceptuję
ryzyko” (`MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY`), a to zamyka drogę każdemu, kto
otworzy domowy adres wprost. `-addext` w tej postaci wymaga OpenSSL 3 (WampServer z PHP 8.1+
go ma); OpenSSL 1.1.1 odrzuca rozszerzenie podane drugi raz — tam krótki własny plik
konfiguracji, jak robi to kreator.

Na VPS trafia **tylko certyfikat** (`origin.crt`), nigdy klucz. Po skopiowaniu warto porównać
odcisk: `openssl x509 -in origin.crt -noout -fingerprint -sha256` po obu stronach.

#### Port 443 w domu tylko dla VPS

Skanery internetu (Shodan, Censys i setki mniejszych) pukają pod każdy adres IPv4 co kilka dni
i zapisują certyfikat, który dostaną. Jeżeli domowy port 443 odpowiada wszystkim, a certyfikat
nosi nazwę `media.example.org`, to „ukryty” adres domowy jest w publicznej wyszukiwarce razem
z nazwą strony. Dlatego:

- **zapora Windows** wpuszcza na port 443 wyłącznie adres VPS — kreator tworzy regułę w grupie
  „TryHackX Media Server” (`-RemoteAddress 203.0.113.10`, na życzenie druga dla `LocalSubnet`);
- **ogólne reguły „Apache HTTP Server”**, które Windows utworzył dla `httpd.exe` przy pierwszym
  uruchomieniu (okno „Zezwól na dostęp”), wpuszczają każdy adres na każdy port Apache'a —
  a w zaporze Windows reguły zezwalające się sumują, więc własna, wąska reguła nic by nie dała.
  Kreator je **wyłącza** (nie usuwa; ich nazwy zapisuje i przywraca przy odinstalowaniu albo
  przejściu na tryb, który i tak otwiera porty wszystkim);
- **certyfikat domowy nie zawiera nazwy domeny**, a host `*:443` ma neutralne `ServerName` —
  gdyby zapora kiedyś zawiodła, skaner zobaczy anonimowy certyfikat i `403`;
- `Require ip` w Apache powtarza to samo warstwę wyżej.

Sprawdzenie z zewnątrz (z innej sieci niż dom i VPS): `curl -vk https://198.51.100.7/` ma
skończyć się przekroczeniem czasu, nie odpowiedzią.

#### Limity czasu

`ProxyTimeout` liczy ciszę między pakietami, nie długość żądania. Dla stron i mostu wystarcza
minuta — z zapasem na tryb zgodny, który uruchamia FFmpeg, zanim wyśle pierwszy bajt (7 sekund,
jak bywa w gotowych przepisach, to za mało: strumień zgodny dużego pliku kończyłby się `504`).
Trasa `/media-transfer/` ma **osobną linię `ProxyPass` z `timeout=3600`** — tyle samo, ile po
stronie domowej — i musi stać **nad** `ProxyPass /`, bo wygrywa pierwsze dopasowanie. `nocanon`
przekazuje ścieżkę z tokenem bez przepisywania znaków, `retry=0` sprawia, że po powrocie domu
strona wraca od razu, a nie po minucie.

#### Dlaczego nie `ProxyErrorOverride On`

Bo podmienia **każdą** odpowiedź z kodem błędu, także te, które wysłała sama aplikacja: most
odpowiada JSON-em z `401`, `403`, `422`, a usługa transferowa `503` z treścią („Serwer transferowy
jest zajęty”) — interfejs je czyta. `ErrorDocument 502/503/504` bez `ProxyErrorOverride` dotyczy
wyłącznie błędów, które wytworzył sam VPS, czyli dokładnie przypadku „dom nie odpowiada”.

#### Gdy adres domowy się zmienia

Przy zmiennym adresie łącza są dwie drogi: po zmianie poprawić trzy linie (`ProxyPass` ×2
i `ProxyPassReverse`) i przeładować Apache na VPS, albo założyć dynamiczny DNS i podać w tych
liniach nazwę zamiast adresu. Apache rozwiązuje nazwę przy starcie, więc po zmianie adresu
potrzebne jest `systemctl reload apache2` (np. z crona). Zapora i `[proxy] trusted` w domu
zależą od adresu **VPS**, nie domowego — ich to nie dotyczy.

#### Dom na Debianie

Ten sam kształt, gdy komputerem w domu jest Debian 13, ustawia `zainstaluj-debian.sh` (wersja
**P**; pełny opis w `INSTALL-DEBIAN.md`). **Strona VPS jest ta sama**: dwa hosty, przypięty
certyfikat, limity czasu i strona zastępcza powstają z tych samych szablonów
(`installer/templates/vps/`), więc wszystko, co ten rozdział mówi o VPS-ie, dotyczy obu systemów.
Różni się dom:

| | Windows (WAMP) | Debian |
|---|---|---|
| Host `*:443` | plik kreatora w `alias\` | `/etc/apache2/sites-available/tryhackx-media-ssl.conf` (`a2ensite`); portu 80 ten kształt nie używa |
| Certyfikat i klucz domu | `config\origin\` | `/etc/tryhackx-media-server/origin/` (katalog `0700`, klucz `0600`, tylko root) |
| Port 443 tylko dla VPS | reguła zapory Windows z `-RemoteAddress` | `ufw allow proto tcp from 203.0.113.10 to any port 443` |
| Paczka dla VPS | `runtime\vps-bundle` | `/etc/tryhackx-media-server/vps-bundle/` |
| Ustawienie VPS | `vps-setup.sh` z paczki (od 13.11.2026) albo kroki z instrukcji, ręcznie | ten sam skrypt: instalator wysyła go i uruchamia przez SSH albo podaje dwa polecenia |
| Wymiana certyfikatu domu | nowy certyfikat w kreatorze, potem `origin.crt` na VPS | `--odnow`: VPS przez chwilę ufa staremu i nowemu, bez przerwy |

Host domowy na Debianie ma te same dwie cechy, co na Windowsie — neutralne `ServerName`
(`origin.invalid`) i certyfikat `CN=origin`, bez publicznej nazwy gdziekolwiek —
i te same reguły dostępu: `Require local`, `Require ip 203.0.113.10`, a na życzenie sieć domowa.
W prywatnej konfiguracji są te same dwa wpisy: `[app] base_url = "https://media.example.org/"`
i `[proxy] trusted = "203.0.113.10"`.

**Zapora.** `ufw` po włączeniu zamyka wszystko, czego nie wpuszczono, więc instalator — jeśli to
on ją włącza — dodaje też `ufw allow from 192.168.1.0/24`: sieć domowa dochodzi do komputera tak
jak przedtem (SSH, udziały plików), a z internetu otwarty jest wyłącznie port 443 i wyłącznie dla
VPS-a. Zapory, która była już włączona, nie poszerza. Aplikacji sieć domowa nie zobaczy wprost,
dopóki nie wybierzesz tego osobno — zapora wpuszcza do komputera, a o dostępie do strony decyduje
`Require` w Apache.

**`vps-setup.sh`** robi na VPS-ie to, co kroki instrukcji: pakiety, moduły, oba hosty, certyfikat
domu z porównaniem odcisku, Let's Encrypt (http-01), a na końcu zapytanie przez proxy. Można go
uruchamiać wielokrotnie; gdy `configtest` odrzuci konfigurację albo strona działała przed zmianą,
a po niej nie, przywraca poprzednie pliki. Kod wyjścia `3` znaczy „VPS gotowy, dom jeszcze nie
odpowiada” — czyli router albo adres, nie VPS.

**Dwa certyfikaty o tej samej nazwie.** Przy wymianie VPS musi przez chwilę ufać staremu i nowemu
certyfikatowi domu, a oba nazywają się `CN=origin`. OpenSSL szuka zaufanego certyfikatu najpierw
po nazwie, więc bez rozszerzenia `authorityKeyIdentifier` przyjmuje z takiej pary tylko jeden
(zmierzone na OpenSSL 3.5: odrzucony jest pierwszy w pliku). Certyfikaty z obu instalatorów mają
to rozszerzenie (z kreatora Windows — od 13.11.2026), a `vps-setup.sh --odnow-start` sprawdza parę
swoim OpenSSL-em w obu kolejnościach, zanim podmieni plik, któremu ufa działająca strona. Gdy stary
certyfikat rozszerzenia nie ma, przechodzi tylko kolejność „nowy, potem stary”.

## Kształt B: wprost, bez proxy

Nie ustawiaj `[proxy] trusted`. Zostaw je puste — wtedy nagłówki `X-Forwarded-*`
są ignorowane i nikt nie podszyje się pod inny adres ani nie zadeklaruje, że
jego zwykłe HTTP jest szyfrowane.

Poza tym: certyfikat, przekierowanie z portu 80, HSTS i pełny `base_url` jak
wyżej — wszystko to jest w `deploy/apache/media-vhost.conf.example`.

To samo dotyczy domowego komputera z przekierowanym portem: z punktu widzenia
aplikacji nie ma różnicy między VPS-em a łączem domowym. Różnica jest poza nią
i warto ją znać: adres domowy zwykle się zmienia (potrzebny DNS dynamiczny),
a certyfikat trzeba odnawiać z tej samej maszyny — Let's Encrypt musi mieć jak
dojść pod nazwę, więc port 80 też ma być przekierowany.

## Kształt D: tylko sieć prywatna, bez TLS

Instalacja domowa oglądana z telefonu i laptopa po adresie z LAN-u, bez nazwy
i bez certyfikatu. Wszystko działa poza jedną rzeczą: most **odrzuca logowanie
po zwykłym HTTP** (`422`), a wyjątek dla HTTP dotyczy wyłącznie pętli zwrotnej,
czyli tej jednej maszyny. Objaw jest mylący — aplikacja ładuje się poprawnie
i odbija każde kliknięcie.

```toml
[session]
require_https = false
```

**To jest zdjęcie zabezpieczenia, nie opcja wygody.** Hasło i ciasteczko sesji
lecą wtedy tekstem po całej sieci lokalnej — łącznie z Wi-Fi, do którego ma
dostęp każdy gość w domu. Wolno to zrobić w sieci, którą się kontroluje;
w internecie **nie**, i sama ta linia nie wystarczy, żeby zaszkodzić tylko
w jedną stronę: jeśli ten sam serwer jest jednocześnie wystawiony publicznie,
wyłączenie dotyczy również gości z zewnątrz.

Lepsza droga, jeśli jest na nią cierpliwość: własna nazwa w prywatnym DNS
i certyfikat z własnego CA albo z Let's Encrypt przez wyzwanie DNS-01. Wtedy
`require_https` zostaje na `true`, a service worker (aplikacja instalowalna
na telefonie) w ogóle zaczyna działać — przeglądarki wymagają do niego
bezpiecznego kontekstu, którego zwykłe HTTP spoza localhosta nie daje.

`[proxy] trusted` zostaje puste, `[app] base_url` może zostać ścieżką — chyba
że w tej sieci ma działać rejestracja pocztą; wtedy pełny adres z LAN-u.

## Reguły dostępu w Apache

`deploy/apache/media-next.conf.example` i `media-transfer.conf.example` mają
w komentarzu wariant lokalny i publiczny. **Drugi plik jest obowiązkowy** —
bez niego biblioteka się wyświetla, ale nic nie zagra ani się nie pobierze.

Trasy transferu (`/media-transfer/`) przy wystawieniu publicznym muszą być
otwarte, i to jest zamierzone: chroni je **podpisany token o krótkim czasie
życia**, wydawany przez most po sprawdzeniu sesji. Bez tokenu żądanie i tak
kończy się odmową. Zdrowie usługi i zlecenia zadań zostają zamknięte na zawsze,
osobną regułą, niezależnie od tego, jak szeroko otwarte są trasy transferu.

Sama usługa transferowa nasłuchuje **wyłącznie na pętli zwrotnej**
(`server.host = "127.0.0.1"`); `allow_remote_bind` istnieje, ale wystawianie jej
wprost oznaczałoby oddanie plików bez Apache i bez tokenów — nie rób tego.

## Zanim uznasz, że działa

1. `https://twoj.host/` ładuje się i **pozwala się zalogować**.
2. `http://twoj.host/` **przekierowuje** na HTTPS, a nie pokazuje
   aplikacji, która odbija każde kliknięcie.
3. Utwór **gra**, a plik **się pobiera** (to sprawdza `/media-transfer/`).
4. `https://twoj.host/media-transfer/health/ready` oddaje **403 albo 404**,
   nie `ready`. **Jeśli oddaje `200`, sprawdź kolejność sekcji, a nie ich treść.**
   `<Location>` i `<LocationMatch>` scalają się w kolejności z pliku, a przy
   domyślnym `AuthMerging Off` `Require` z sekcji późniejszej **zastępuje**
   wcześniejsze — więc blok zamykający zdrowie musi stać **po** bloku
   otwierającym trasy transferu. Postawiony przed nim znika bez śladu: reguła
   jest w pliku, `configtest` mówi „Syntax OK", zwykłe trasy działają normalnie,
   a zdrowie odpowiada całemu internetowi. Tak było tutaj do 17.08.2026.
   Sprawdź też `…/v1/catalog-scan` — `405` znaczy, że żądanie **dotarło** do
   usługi i chroni ją już tylko wewnętrzny klucz; ma być `403`.
5. Rejestracja nowego konta kończy się mailem z **klikalnym** linkiem.
6. Po nieudanych logowaniach z jednego adresu przychodzi ograniczenie, a nie
   blokada dla wszystkich naraz (to sprawdza `[proxy] trusted`).
7. Z telefonu: aplikacja **daje się zainstalować** (ikona na ekranie startowym
   otwiera się bez paska adresu), a po wyłączeniu sieci pokazuje stronę „Brak
   połączenia" zamiast błędu przeglądarki. To jedyny sposób sprawdzenia service
   workera — wymaga HTTPS i prawdziwej przeglądarki.
